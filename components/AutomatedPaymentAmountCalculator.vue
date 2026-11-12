<script setup lang="ts">
import { formatCalculationExplanation, formatCalculationMoney } from '../shared/calculation-explanation'
import { messages } from '../i18n/messages'
import { computed, ref, watch } from 'vue'
import { usePaymentRequest } from '../composables/usePaymentRequest'
import type { Ref } from 'vue'
import { zeroMoney, type MoneyInput } from '@gcs-ssc/extensions/money'
import { FetchResponseError, type GcsExtensionJsonConfig } from '@gcs-ssc/extensions'
import type { GcsPaymentAmountCalculatorResult } from '@gcs-ssc/extensions/ui'
import {
  ExtensionBadge,
  ExtensionCheckbox,
  ExtensionFormField,
  ExtensionIcon,
  ExtensionCurrencyInput,
  useExtensionApi,
  useExtensionI18n
} from '@gcs-ssc/extensions/ui'
import {
  EXTENSION_KEY,
  AutomatedPaymentCurrencySchema,
  type AutomatedPaymentCalculationResult,
  type AutomatedPaymentMoney
} from '../shared/automated-payments'

const {
  extensionKey,
  context,
  model
} = defineProps<{
  extensionKey: string
  calculatorId: string
  config: GcsExtensionJsonConfig
  context: {
    agreementId: string
  }
  model: Record<string, unknown>
}>()

const emit = defineEmits<{
  result: [value: GcsPaymentAmountCalculatorResult]
  extensionPayload: [value: Record<string, unknown>]
}>()

const { locale, t } = useExtensionI18n(messages)
type CalculationError = { kind: 'local'; key: 'calculation_error' | 'currency_mismatch' } | { kind: 'api'; message: string }
const request = usePaymentRequest<AutomatedPaymentCalculationResult & { enabled?: boolean }, CalculationError>()
const calculation = request.data
const isLoading = request.loading
const displayedError = computed(() => {
  const error = request.error.value
  return error ? error.kind === 'local' ? t(error.key) : error.message : null
})
const releaseHoldback: Ref<boolean> = ref(false)
const holdbackReleaseAmount: Ref<MoneyInput> = ref(undefined)

const api = useExtensionApi(extensionKey)
const endpoint = computed(() => `/agreements/${context.agreementId}/calculate-payment`)
const selectedCurrency = computed(() => {
  const parsed = AutomatedPaymentCurrencySchema.safeParse(model.currency)
  return parsed.success ? parsed.data : null
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * Returns the first nonempty display message from an API response.
 * @param values Candidate response messages.
 * @returns The first message or null.
 */
const firstString = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value
    }
  }

  return null
}

/**
 * Preserves the server-localized field message before broader error text.
 * @param payload Parsed response data.
 * @returns A display message or null.
 */
const resolveApiErrorMessage = (payload: unknown): string | null => {
  if (!isRecord(payload)) {
    return null
  }

  const data = isRecord(payload.data) ? payload.data : payload
  const details = Array.isArray(data.details) ? data.details : []
  for (const detail of details) {
    if (isRecord(detail)) {
      const detailMessage = firstString(detail.message)
      if (detailMessage) {
        return detailMessage
      }
    }
  }

  return firstString(data.message, payload.message, payload.statusMessage)
}

/**
 * Reads a response error without depending on the host message catalog.
 * @param response Failed calculation response.
 * @returns Localized error text.
 */
const readErrorMessage = async (response: Response): Promise<string | null> => {
  try {
    const payload = await response.json()
    const apiMessage = resolveApiErrorMessage(payload)
    if (apiMessage) {
      return apiMessage
    }
  } catch {
    // Fall through to localized fallback when the response is not JSON.
  }

  return null
}

/**
 * Formats exact money in the selected currency without numeric conversion.
 * @param value Canonical money.
 * @returns The localized amount and currency.
 */
const formatMoney = (value: AutomatedPaymentMoney) => formatCalculationMoney(value, locale.value)

const calculationExplanation = computed(() => formatCalculationExplanation(calculation.value?.explanation, locale.value, t, formatMoney))

const serializedHoldbackReleaseAmount = computed(() => {
  if (!selectedCurrency.value) return undefined
  return releaseHoldback.value ? holdbackReleaseAmount.value : zeroMoney(selectedCurrency.value)
})

const requestBody = computed(() => ({
  egcs_fc_commitmenttype: model.commitmentType,
  egcs_fc_fiscalyear: model.fiscalYear,
  egcs_fc_paymenttype: model.paymentType,
  egcs_fc_currency: selectedCurrency.value,
  egcs_fc_periodstart: model.periodStart,
  egcs_fc_periodend: model.periodEnd,
  extensions: {
    [EXTENSION_KEY]: {
      releaseHoldback: releaseHoldback.value,
      holdbackReleaseAmount: serializedHoldbackReleaseAmount.value
    }
  }
}))

// Holdback elections belong to this Agreement, never to the next route owner.
watch(() => context.agreementId, () => {
  releaseHoldback.value = false
  holdbackReleaseAmount.value = undefined
}, { flush: 'sync' })

const hasRequiredInputs = computed(() =>
  typeof requestBody.value.egcs_fc_commitmenttype === 'string'
  && requestBody.value.egcs_fc_commitmenttype.length > 0
  && typeof requestBody.value.egcs_fc_fiscalyear === 'string'
  && requestBody.value.egcs_fc_fiscalyear.length > 0
  && (requestBody.value.egcs_fc_paymenttype === 'reimbursement' || requestBody.value.egcs_fc_paymenttype === 'advance')
  && requestBody.value.egcs_fc_currency !== null
  && typeof requestBody.value.egcs_fc_periodstart === 'number'
  && typeof requestBody.value.egcs_fc_periodend === 'number'
)

/** Publishes calculation state through the public host calculator contract. */
const publishResult = () => {
  const result: GcsPaymentAmountCalculatorResult = {
    ceilingAmount: calculation.value?.ceilingAmount,
    suggestedAmount: calculation.value?.suggestedAmount,
    currency: calculation.value?.currency ?? selectedCurrency.value?.toUpperCase(),
    details: calculation.value?.details ?? [],
    explanation: calculationExplanation.value,
    loading: isLoading.value,
    error: displayedError.value
  }
  emit('result', result)
}

watch(locale, publishResult)

/** Recalculates the payment ceiling from the current form values and publishes the result. */
const calculate = async () => {
  const body = requestBody.value
  emit('extensionPayload', {
    releaseHoldback: releaseHoldback.value,
    holdbackReleaseAmount: serializedHoldbackReleaseAmount.value
  })

  if (!hasRequiredInputs.value) {
    request.reset()
    publishResult()
    return
  }

  const current = request.start()
  if (!current) return
  const url = endpoint.value
  publishResult()
  let settled = false
  try {
    const result = await api.post<AutomatedPaymentCalculationResult>(url, body)
    if (!request.owns(current)) return
    if (result.currency.toLowerCase() !== body.egcs_fc_currency) {
      settled = request.fail(current, { kind: 'local', key: 'currency_mismatch' })
    } else {
      settled = request.succeed(current, result)
    }
  } catch (error: unknown) {
    if (!request.owns(current)) return
    let message: string | null
    if (error instanceof Response) {
      message = await readErrorMessage(error)
      if (!request.owns(current)) return
    } else {
      message = error instanceof FetchResponseError
        && !(isRecord(error.data) && typeof error.data.text === 'string')
        ? resolveApiErrorMessage(error.data)
        : null
    }
    settled = request.fail(current, message ? { kind: 'api', message } : { kind: 'local', key: 'calculation_error' })
  } finally {
    // A superseded or disposed request cannot publish into the next form context.
    if (settled) {
      publishResult()
    }
  }
}

// The host replaces its model object while typing. Compare only ceiling inputs,
// so transient amount text never interrupts editing or resets the suggestion.
watch([() => JSON.stringify(requestBody.value), endpoint], request.reset, { flush: 'sync' })
watch([() => JSON.stringify(requestBody.value), endpoint], calculate, { immediate: true })
</script>

<template>
  <section class="space-y-3 py-4" data-field-scope="extension.gcs-automated-payments.automated-payment-amount-calculator" data-scope-label-en="Agreements > Payments > Amount calculator" data-scope-label-fr="Ententes > Paiements > Calculateur du montant" data-field-tooltip-context="agreement">
    <div class="flex items-center justify-between gap-3">
      <div>
        <h3 class="text-sm font-semibold text-highlighted">
          {{ t('calculator_title') }}
        </h3>
        <p class="text-sm text-muted">
          {{ t('calculator_description') }}
        </p>
      </div>
      <ExtensionBadge v-if="calculation" color="primary" variant="subtle">
        {{ formatMoney(calculation.ceilingAmount) }}
      </ExtensionBadge>
    </div>

    <div class="grid gap-3 sm:grid-cols-2">
      <ExtensionFormField
        :label="t('release_holdback')"
        class="sm:col-span-2" data-ui-target="extension.gcs-automated-payments.automated-payment-amount-calculator.release_holdback">
        <ExtensionCheckbox
          v-model="releaseHoldback"
          :label="t('release_holdback_label')"
          class="w-full"
          :ui="{
            label: 'leading-5'
          }" />
      </ExtensionFormField>

      <ExtensionFormField
        v-if="releaseHoldback"
        :label="t('holdback_release_amount')" required data-ui-target="extension.gcs-automated-payments.automated-payment-amount-calculator.holdback_release_amount">
        <ExtensionCurrencyInput
          v-model="holdbackReleaseAmount"
          :currency="selectedCurrency"
          required
          aria-required="true" />
      </ExtensionFormField>
    </div>

    <div v-if="isLoading" class="flex items-center gap-2 text-sm text-muted">
      <ExtensionIcon name="i-lucide-loader-circle" class="animate-spin" />
      {{ t('calculating') }}
    </div>
    <p v-else-if="displayedError" role="alert" class="text-sm text-error">
      {{ displayedError }}
    </p>
  </section>
</template>
