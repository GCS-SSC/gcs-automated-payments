<script setup lang="ts">
import { messages } from '../i18n/messages'
import { computed } from 'vue'
import type { GcsExtensionJsonConfig, GcsResolvedExtension } from '@gcs-ssc/extensions'
import { ExtensionCheckbox, ExtensionFormField, useExtensionI18n } from '@gcs-ssc/extensions/ui'
import {
  parseAutomatedPaymentsStreamConfig,
  type AutomatedPaymentType
} from '../shared/automated-payments'

defineProps<{
  extension: GcsResolvedExtension
  streamId: string
  transferPaymentId?: string
  agencyId?: string
}>()

const config = defineModel<GcsExtensionJsonConfig>({ required: true })
const { t } = useExtensionI18n(messages)

const localConfig = computed(() => parseAutomatedPaymentsStreamConfig(config.value))

const paymentTypeOptions = computed<Array<{ label: string; value: AutomatedPaymentType }>>(() => [
  { label: t('paymentType.reimbursement'), value: 'reimbursement' },
  { label: t('paymentType.advance'), value: 'advance' }
])

const updatePaymentType = (paymentType: AutomatedPaymentType, enabled: boolean) => {
  const current = new Set(localConfig.value.enabledPaymentTypes)
  if (enabled) {
    current.add(paymentType)
  } else {
    current.delete(paymentType)
  }
  config.value = { enabledPaymentTypes: Array.from(current) }
}
</script>

<template>
  <div class="space-y-6" data-field-scope="extension.gcs-automated-payments.stream-automated-payments-config">
    <section class="space-y-4">
      <div>
        <h3 class="text-base font-semibold text-highlighted">
          {{ t('stream_defaults_title') }}
        </h3>
        <p class="mt-1 text-sm text-muted">
          {{ t('stream_defaults_description') }}
        </p>
      </div>

      <div class="space-y-3">
        <ExtensionFormField :label="t('enabled_payment_types')" data-ui-target="extension.gcs-automated-payments.stream-automated-payments-config.enabled_payment_types">
          <div class="flex flex-wrap gap-3">
            <ExtensionCheckbox
              v-for="option in paymentTypeOptions"
              :key="option.value"
              :model-value="localConfig.enabledPaymentTypes.includes(option.value)"
              :label="option.label"
              @update:model-value="(value: boolean | 'indeterminate') => updatePaymentType(option.value, value === true)" />
          </div>
        </ExtensionFormField>
      </div>
    </section>
  </div>
</template>
