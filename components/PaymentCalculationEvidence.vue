<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { GcsEntityTabComponentProps } from '@gcs-ssc/extensions/ui'
import { ExtensionButton, ExtensionSection, useExtensionApi, useExtensionI18n } from '@gcs-ssc/extensions/ui'
import { AutomatedPaymentCalculationEvidenceSchema, type AutomatedPaymentCalculationEvidence } from '../shared/automated-payments'
import { messages } from '../i18n/messages'

const { extensionKey, context } = defineProps<GcsEntityTabComponentProps>()
const { t, locale } = useExtensionI18n(messages)
const api = useExtensionApi(extensionKey)
const evidence: Ref<AutomatedPaymentCalculationEvidence | null> = ref(null)
const loading: Ref<boolean> = ref(false)
const failed: Ref<boolean> = ref(false)
let sequence = 0
onBeforeUnmount(() => { sequence += 1 })

const detailLabelKeys: Record<string, keyof typeof messages.en> = {
  baseAmount: 'details.base_amount', commitmentRemaining: 'details.commitment_remaining',
  availableBeforeHoldback: 'details.available_before_holdback', holdbackReleaseAmount: 'details.holdback_release_amount',
  totalClaimsToLastClaimMonth: 'details.total_claims_to_last_claim_month',
  totalForecastToLastClaimMonth: 'details.total_forecast_to_last_claim_month',
  totalForecastToPeriodEnd: 'details.total_forecast_to_period_end', totalPaymentsToDate: 'details.total_payments_to_date'
}
const formatMoney = (value: string): string => {
  const [whole = '0', fraction = '00'] = value.split('.')
  const formatter = new Intl.NumberFormat(locale.value, {
    style: 'currency', currency: evidence.value!.calculation.currency,
    minimumFractionDigits: 2, maximumFractionDigits: 2
  })
  const units = value.startsWith('-') && BigInt(whole) === BigInt(0) ? -0 : BigInt(whole)
  return formatter.formatToParts(units).map(part => part.type === 'fraction' ? fraction : part.value).join('')
}
const capturedAt = computed(() => evidence.value
  ? new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(evidence.value.capturedAt))
  : '')

/** Reads retained evidence and rejects responses from a previously selected Payment. */
const loadEvidence = async () => {
  const current = ++sequence
  evidence.value = null
  failed.value = false
  loading.value = true
  try {
    const response = await api.get<{ evidence: unknown }>(`/payments/${context.ownerId}/calculation-evidence`)
    if (current !== sequence) return
    evidence.value = response.evidence === null ? null : AutomatedPaymentCalculationEvidenceSchema.parse(response.evidence)
  } catch {
    if (current === sequence) failed.value = true
  } finally {
    if (current === sequence) loading.value = false
  }
}
watch(() => context.ownerId, loadEvidence, { immediate: true })
</script>

<template>
  <ExtensionSection :title="t('calculation_details')" :grid-cols="1" data-testid="payment-calculation-evidence">
    <div class="space-y-5">
      <p v-if="loading" role="status" class="text-sm text-muted">{{ t('calculating') }}</p>
      <div v-else-if="failed" role="alert" class="space-y-3">
        <p>{{ t('evidence_error') }}</p>
        <ExtensionButton :label="t('retry')" @click="loadEvidence" />
      </div>
      <p v-else-if="!evidence" class="text-sm text-muted">{{ t('evidence_unavailable') }}</p>
      <template v-else>
        <p class="text-sm text-muted">{{ t('evidence_retained', { date: capturedAt }) }}</p>
        <dl class="divide-y divide-default">
          <div v-for="detail in evidence.calculation.details" :key="detail.label" class="flex min-w-0 flex-col gap-2 py-3 sm:flex-row sm:justify-between sm:gap-6">
            <dt class="min-w-0 text-sm">{{ t(detailLabelKeys[detail.label]!) }}</dt>
            <dd class="min-w-0 wrap-anywhere text-sm font-semibold tabular-nums sm:text-right">{{ formatMoney(detail.value) }}</dd>
          </div>
        </dl>
      </template>
    </div>
  </ExtensionSection>
</template>
