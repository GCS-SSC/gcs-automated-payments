<script setup lang="ts">
import { getClientRequestUrl } from '~/utils/client-request-url'
/* eslint-disable jsdoc/require-jsdoc */
import { computed, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { GcsExtensionJsonConfig } from '@gcs-ssc/extensions'
import {
  EXTENSION_KEY,
  type AutomatedPaymentCalculationResult
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
  result: [value: Record<string, unknown>]
  extensionPayload: [value: Record<string, unknown>]
}>()

const { n, t } = useI18n()
const calculation: Ref<(AutomatedPaymentCalculationResult & { enabled?: boolean }) | null> = ref(null)
const errorMessage: Ref<string | null> = ref(null)
const isLoading: Ref<boolean> = ref(false)
const releaseHoldback: Ref<boolean> = ref(false)
const holdbackReleaseAmount: Ref<string> = ref('')

const endpoint = computed(() => `/api/extensions/${extensionKey}/agreements/${context.agreementId}/calculate-payment`)

const formatMoney = (value: number) => n(value, {
  style: 'currency',
  currency: 'CAD'
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
      holdbackReleaseAmount: holdbackReleaseAmount.value === '' ? 0 : Number(holdbackReleaseAmount.value)
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
  emit('result', {
    ceilingAmount: calculation.value?.ceilingAmount,
    suggestedAmount: calculation.value?.suggestedAmount,
    currency: calculation.value?.currency ?? 'CAD',
    details: calculation.value?.details ?? [],
    loading: isLoading.value,
    error: errorMessage.value
  })
}

const calculate = async () => {
  emit('extensionPayload', {
    releaseHoldback: releaseHoldback.value,
    holdbackReleaseAmount: holdbackReleaseAmount.value === '' ? 0 : Number(holdbackReleaseAmount.value)
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
    const response = await fetch(getClientRequestUrl(endpoint.value), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody.value)
    })
    if (!response.ok) throw new Error(response.statusText)
    calculation.value = await response.json()
    errorMessage.value = null
  } catch (error: unknown) {
    calculation.value = null
    errorMessage.value = error instanceof Error ? error.message : 'Unable to calculate payment amount.'
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
      <UBadge v-if="calculation" color="primary" variant="subtle">
        {{ formatMoney(calculation.ceilingAmount) }}
      </UBadge>
    </div>

    <div class="grid gap-3 sm:grid-cols-2">
      <UFormField :label="t('extensions.gcs_automated_payments.release_holdback')">
        <UCheckbox
          v-model="releaseHoldback"
          :label="t('extensions.gcs_automated_payments.release_holdback_label')" />
      </UFormField>

      <UFormField
        v-if="releaseHoldback"
        :label="t('extensions.gcs_automated_payments.holdback_release_amount')">
        <UInput
          v-model="holdbackReleaseAmount"
          type="number"
          min="0"
          step="0.01" />
      </UFormField>
    </div>

    <div v-if="isLoading" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-lucide-loader-circle" class="animate-spin" />
      {{ t('extensions.gcs_automated_payments.calculating') }}
    </div>
    <p v-else-if="errorMessage" class="text-sm text-error">
      {{ errorMessage }}
    </p>
    <dl v-else-if="calculation" class="grid gap-2 text-sm sm:grid-cols-2">
      <div
        v-for="detail in calculation.details"
        :key="detail.label"
        class="flex justify-between gap-3">
        <dt class="text-muted">
          {{ detail.label }}
        </dt>
        <dd class="font-medium text-highlighted">
          {{ formatMoney(detail.value) }}
        </dd>
      </div>
    </dl>
  </section>
</template>
