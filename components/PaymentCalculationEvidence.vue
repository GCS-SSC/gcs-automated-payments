<script setup lang="ts">
import { computed, watch } from 'vue'
import { usePaymentRequest } from '../composables/usePaymentRequest'
import type { Money } from '@gcs-ssc/extensions/money'
import type { GcsPaymentEvidenceComponentProps } from '@gcs-ssc/extensions/ui'
import { ExtensionButton, ExtensionSection, ExtensionPaymentCalculationBreakdown, useExtensionApi, useExtensionI18n } from '@gcs-ssc/extensions/ui'
import { AutomatedPaymentCalculationEvidenceSchema, type AutomatedPaymentCalculationEvidence } from '../shared/automated-payments'
import { formatCalculationExplanation, formatCalculationMoney } from '../shared/calculation-explanation'
import { messages } from '../i18n/messages'

const { extensionKey, context } = defineProps<GcsPaymentEvidenceComponentProps>()
const { t, locale } = useExtensionI18n(messages)
const api = useExtensionApi(extensionKey)
const request = usePaymentRequest<AutomatedPaymentCalculationEvidence | null, true>()
const evidence = request.data
const loading = request.loading
const failed = request.error

const formatMoney = (value: Money): string => formatCalculationMoney(value, locale.value)
const explanation = computed(() => formatCalculationExplanation(
  evidence.value?.calculation.explanation,
  locale.value, t, formatMoney
))
const capturedAt = computed(() => evidence.value
  ? new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(evidence.value.capturedAt))
  : '')

/** Reads retained evidence and rejects responses from a previously selected Payment. */
const loadEvidence = async () => {
  const current = request.start()
  if (!current) return
  const ownerId = context.ownerId
  try {
    const response = await api.get<{ evidence: unknown }>(`/payments/${ownerId}/calculation-evidence`)
    if (!request.owns(current)) return
    request.succeed(current, response.evidence === null ? null : AutomatedPaymentCalculationEvidenceSchema.parse(response.evidence))
  } catch {
    request.fail(current, true)
  }
}
watch(() => context.ownerId, loadEvidence, { immediate: true, flush: 'sync' })
</script>

<template>
  <ExtensionSection :title="t('calculation_details')" :grid-cols="1" data-testid="payment-calculation-evidence">
    <div class="space-y-5">
      <p v-if="loading" role="status" class="text-sm text-muted">
        {{ t('calculating') }}
      </p>
      <div v-else-if="failed" role="alert" class="space-y-3">
        <p>{{ t('evidence_error') }}</p>
        <ExtensionButton :label="t('retry')" @click="loadEvidence" />
      </div>
      <p v-else-if="!evidence" class="text-sm text-muted">
        {{ t('evidence_unavailable') }}
      </p>
      <template v-else>
        <p class="text-sm text-muted">
          {{ t('evidence_retained', { date: capturedAt }) }}
        </p>
        <ExtensionPaymentCalculationBreakdown :explanation="explanation" />
      </template>
    </div>
  </ExtensionSection>
</template>
