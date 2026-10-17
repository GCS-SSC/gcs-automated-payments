<script setup lang="ts">
import { formatCalculationExplanation, formatCalculationMoney } from '../shared/calculation-explanation'
import { messages } from '../i18n/messages'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Ref } from 'vue'
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
  ZERO_AUTOMATED_PAYMENT_MONEY,
  type AutomatedPaymentCalculationResult,
  type AutomatedPaymentMoney,
  tryParseAutomatedPaymentMoney
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
const calculation: Ref<(AutomatedPaymentCalculationResult & { enabled?: boolean }) | null> = ref(null)
const errorMessage: Ref<string | null> = ref(null)
const localErrorKey: Ref<'calculation_error' | 'currency_mismatch' | null> = ref(null)
const displayedError = computed(() => localErrorKey.value ? t(localErrorKey.value) : errorMessage.value)
const isLoading: Ref<boolean> = ref(false)
const releaseHoldback: Ref<boolean> = ref(false)
const holdbackReleaseAmount: Ref<string> = ref('')

const api = useExtensionApi(extensionKey)
const endpoint = computed(() => `/agreements/${context.agreementId}/calculate-payment`)
const selectedCurrency = computed(() => {
  const parsed = AutomatedPaymentCurrencySchema.safeParse(model.currency)
  return parsed.success ? parsed.data : null
})
let calculationSequence = 0
onBeforeUnmount(() => {
  calculationSequence += 1
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
const formatMoney = (value: AutomatedPaymentMoney) => formatCalculationMoney(value,
  calculation.value?.currency ?? selectedCurrency.value?.toUpperCase() ?? '', locale.value)

const calculationExplanation = computed(() => formatCalculationExplanation(calculation.value?.explanation, locale.value, t, formatMoney))

const serializedHoldbackReleaseAmount = computed(() => {
  if (!releaseHoldback.value || holdbackReleaseAmount.value === '') {
    return ZERO_AUTOMATED_PAYMENT_MONEY
  }
  return tryParseAutomatedPaymentMoney(holdbackReleaseAmount.value) ?? holdbackReleaseAmount.value
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
  holdbackReleaseAmount.value = ''
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
  const sequence = ++calculationSequence
  const body = requestBody.value
  calculation.value = null
  errorMessage.value = null
  localErrorKey.value = null
  emit('extensionPayload', {
    releaseHoldback: releaseHoldback.value,
    holdbackReleaseAmount: serializedHoldbackReleaseAmount.value
  })

  if (!hasRequiredInputs.value) {
    calculation.value = null
    errorMessage.value = null
    isLoading.value = false
    publishResult()
    return
  }

  isLoading.value = true
  publishResult()
  try {
    const result = await api.post<AutomatedPaymentCalculationResult>(endpoint.value, body)
    if (sequence !== calculationSequence) return
    if (result.currency.toLowerCase() !== body.egcs_fc_currency) {
      localErrorKey.value = 'currency_mismatch'
      return
    }
    calculation.value = result
    errorMessage.value = null
  } catch (error: unknown) {
    if (sequence !== calculationSequence) return
    calculation.value = null
    if (error instanceof Response) {
      const message = await readErrorMessage(error)
      if (sequence !== calculationSequence) return
      errorMessage.value = message
    } else {
      errorMessage.value = error instanceof FetchResponseError
        && !(isRecord(error.data) && typeof error.data.text === 'string')
        ? resolveApiErrorMessage(error.data)
        : null
    }
    if (!errorMessage.value) localErrorKey.value = 'calculation_error'
  } finally {
    if (sequence === calculationSequence) {
      isLoading.value = false
      publishResult()
    }
  }
}

// The host replaces its model object while typing. Compare only ceiling inputs,
// so transient amount text never interrupts editing or resets the suggestion.
watch([() => JSON.stringify(requestBody.value), endpoint], calculate, { immediate: true })
</script>

<template>
  <section class="space-y-3 py-4">
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
        class="sm:col-span-2">
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
        :label="t('holdback_release_amount')">
        <ExtensionCurrencyInput
          v-model="holdbackReleaseAmount"
          :currency="selectedCurrency" />
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
