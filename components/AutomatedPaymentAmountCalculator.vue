<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { type GcsExtensionJsonConfig } from '@gcs-ssc/extensions'
import type { GcsPaymentAmountCalculatorResult } from '@gcs-ssc/extensions/ui'
import {
  ExtensionAccordion,
  ExtensionBadge,
  ExtensionCheckbox,
  ExtensionFormField,
  ExtensionIcon,
  ExtensionInput,
  useExtensionApi,
  useExtensionI18n
} from '@gcs-ssc/extensions/ui'
import {
  EXTENSION_KEY,
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

const { locale, t } = useExtensionI18n()
const calculation: Ref<(AutomatedPaymentCalculationResult & { enabled?: boolean }) | null> = ref(null)
const errorMessage: Ref<string | null> = ref(null)
const isLoading: Ref<boolean> = ref(false)
const releaseHoldback: Ref<boolean> = ref(false)
const holdbackReleaseAmount: Ref<string> = ref('')

const api = useExtensionApi(extensionKey)
const endpoint = computed(() => `/agreements/${context.agreementId}/calculate-payment`)

const calculationDetailLabelKeys: Record<string, string> = {
  baseAmount: 'extensions.gcs_automated_payments.details.base_amount',
  commitmentRemaining: 'extensions.gcs_automated_payments.details.commitment_remaining',
  availableBeforeHoldback: 'extensions.gcs_automated_payments.details.available_before_holdback',
  holdbackReleaseAmount: 'extensions.gcs_automated_payments.details.holdback_release_amount',
  totalClaimsToLastClaimMonth: 'extensions.gcs_automated_payments.details.total_claims_to_last_claim_month',
  totalForecastToLastClaimMonth: 'extensions.gcs_automated_payments.details.total_forecast_to_last_claim_month',
  totalForecastToPeriodEnd: 'extensions.gcs_automated_payments.details.total_forecast_to_period_end',
  totalPaymentsToDate: 'extensions.gcs_automated_payments.details.total_payments_to_date'
}

const calculationDetailItems = computed(() => [{
  label: t('extensions.gcs_automated_payments.calculation_details'),
  value: 'details',
  icon: 'i-lucide-list'
}])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const firstString = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value
    }
  }

  return null
}

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

const readErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = await response.json()
    const apiMessage = resolveApiErrorMessage(payload)
    if (apiMessage) {
      return apiMessage
    }
  } catch {
    // Fall through to localized fallback when the response is not JSON.
  }

  return response.statusText || t('extensions.gcs_automated_payments.calculation_error')
}

const formatMoney = (value: AutomatedPaymentMoney) => {
  const [integer = '0', fraction = '00'] = value.split('.')
  const negative = integer.startsWith('-')
  const digits = negative ? integer.slice(1) : integer
  const isFrench = locale.value === 'fr'
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, isFrench ? '\u00a0' : ',')
  const amount = `${grouped}${isFrench ? ',' : '.'}${fraction}`
  return isFrench ? `${negative ? '-' : ''}${amount}\u00a0$` : `${negative ? '-' : ''}$${amount}`
}

const calculationDetails = computed(() =>
  calculation.value?.details.map(detail => ({
    label: t(calculationDetailLabelKeys[detail.label] ?? detail.label),
    value: detail.value
  })) ?? []
)

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
  egcs_fc_periodstart: model.periodStart,
  egcs_fc_periodend: model.periodEnd,
  egcs_fc_paymentamount: model.amount,
  extensions: {
    [EXTENSION_KEY]: {
      releaseHoldback: releaseHoldback.value,
      holdbackReleaseAmount: serializedHoldbackReleaseAmount.value
    }
  }
}))

const hasRequiredInputs = computed(() =>
  typeof requestBody.value.egcs_fc_commitmenttype === 'string'
  && requestBody.value.egcs_fc_commitmenttype.length > 0
  && typeof requestBody.value.egcs_fc_fiscalyear === 'string'
  && requestBody.value.egcs_fc_fiscalyear.length > 0
  && (requestBody.value.egcs_fc_paymenttype === 'reimbursement' || requestBody.value.egcs_fc_paymenttype === 'advance')
  && typeof requestBody.value.egcs_fc_periodstart === 'number'
  && typeof requestBody.value.egcs_fc_periodend === 'number'
)

const publishResult = () => {
  const result: GcsPaymentAmountCalculatorResult = {
    ceilingAmount: calculation.value?.ceilingAmount,
    suggestedAmount: calculation.value?.suggestedAmount,
    currency: calculation.value?.currency ?? 'CAD',
    details: calculation.value?.details ?? [],
    loading: isLoading.value,
    error: errorMessage.value
  }
  emit('result', result)
}

/** Recalculates the payment ceiling from the current form values and publishes the result. */
const calculate = async () => {
  emit('extensionPayload', {
    releaseHoldback: releaseHoldback.value,
    holdbackReleaseAmount: serializedHoldbackReleaseAmount.value
  })

  if (!hasRequiredInputs.value) {
    calculation.value = null
    errorMessage.value = null
    publishResult()
    return
  }

  isLoading.value = true
  publishResult()
  try {
    calculation.value = await api.post<AutomatedPaymentCalculationResult>(endpoint.value, requestBody.value)
    errorMessage.value = null
  } catch (error: unknown) {
    calculation.value = null
    if (error instanceof Response) {
      errorMessage.value = await readErrorMessage(error)
    } else {
      errorMessage.value = error instanceof Error ? error.message : t('extensions.gcs_automated_payments.calculation_error')
    }
  } finally {
    isLoading.value = false
    publishResult()
  }
}

watch(requestBody, calculate, { deep: true, immediate: true })
</script>

<template>
  <section class="border-default space-y-3 border-y py-4">
    <div class="flex items-center justify-between gap-3">
      <div>
        <h3 class="text-sm font-semibold text-highlighted">
          {{ t('extensions.gcs_automated_payments.calculator_title') }}
        </h3>
        <p class="text-sm text-muted">
          {{ t('extensions.gcs_automated_payments.calculator_description') }}
        </p>
      </div>
      <ExtensionBadge v-if="calculation" color="primary" variant="subtle">
        {{ formatMoney(calculation.ceilingAmount) }}
      </ExtensionBadge>
    </div>

    <div class="grid gap-3 sm:grid-cols-2">
      <ExtensionFormField
        :label="t('extensions.gcs_automated_payments.release_holdback')"
        class="sm:col-span-2">
        <ExtensionCheckbox
          v-model="releaseHoldback"
          :label="t('extensions.gcs_automated_payments.release_holdback_label')"
          class="w-full"
          :ui="{
            label: 'leading-5'
          }" />
      </ExtensionFormField>

      <ExtensionFormField
        v-if="releaseHoldback"
        :label="t('extensions.gcs_automated_payments.holdback_release_amount')">
        <ExtensionInput
          v-model="holdbackReleaseAmount"
          inputmode="decimal" />
      </ExtensionFormField>
    </div>

    <div v-if="isLoading" class="flex items-center gap-2 text-sm text-muted">
      <ExtensionIcon name="i-lucide-loader-circle" class="animate-spin" />
      {{ t('extensions.gcs_automated_payments.calculating') }}
    </div>
    <p v-else-if="errorMessage" class="text-sm text-error">
      {{ errorMessage }}
    </p>
    <ExtensionAccordion
      v-else-if="calculation && calculationDetails.length > 0"
      type="multiple"
      :items="calculationDetailItems"
      :default-value="[]"
      :unmount-on-hide="false"
      :ui="{
        root: 'border-default border-t',
        item: 'border-b-0',
        header: 'm-0',
        trigger: 'w-full px-0 py-2 text-left text-sm font-semibold text-highlighted transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-primary/30',
        body: 'px-0 pb-1 pt-2',
        content: 'data-[state=open]:animate-none'
      }">
      <template #body>
        <dl class="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div
            v-for="detail in calculationDetails"
            :key="detail.label"
            class="border-default grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 border-b py-1.5">
            <dt class="min-w-0 text-muted">
              {{ detail.label }}
            </dt>
            <dd class="font-medium text-highlighted tabular-nums whitespace-nowrap">
              {{ formatMoney(detail.value) }}
            </dd>
          </div>
        </dl>
      </template>
    </ExtensionAccordion>
  </section>
</template>
