<script setup lang="ts">
/* eslint-disable jsdoc/require-jsdoc */
import { computed, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { GcsExtensionJsonConfig, GcsResolvedExtension } from '@gcs-ssc/extensions'
import { ExtensionCheckbox, ExtensionFormField, useExtensionI18n } from '@gcs-ssc/extensions/ui'
import {
  parseAutomatedPaymentsStreamConfig,
  type AutomatedPaymentsStreamConfig,
  type AutomatedPaymentType
} from '../shared/automated-payments'

defineProps<{
  extension: GcsResolvedExtension
  streamId: string
  transferPaymentId?: string
  agencyId?: string
}>()

const config = defineModel<GcsExtensionJsonConfig>({ required: true })
const { t } = useExtensionI18n()

const localConfig: Ref<AutomatedPaymentsStreamConfig> = ref(parseAutomatedPaymentsStreamConfig(config.value))

const paymentTypeOptions = computed(() => [
  { label: t('enums.payment_type.reimbursement'), value: 'reimbursement' },
  { label: t('enums.payment_type.advance'), value: 'advance' }
])

watch(localConfig, value => {
  config.value = {
    enabledPaymentTypes: value.enabledPaymentTypes
  }
}, { deep: true })

watch(config, value => {
  localConfig.value = parseAutomatedPaymentsStreamConfig(value)
})

const updatePaymentType = (paymentType: AutomatedPaymentType, enabled: boolean) => {
  const current = new Set(localConfig.value.enabledPaymentTypes)
  if (enabled) {
    current.add(paymentType)
  } else {
    current.delete(paymentType)
  }
  localConfig.value.enabledPaymentTypes = Array.from(current)
}
</script>

<template>
  <div class="space-y-6">
    <section class="space-y-4">
      <div>
        <h3 class="text-base font-semibold text-highlighted">
          {{ t('extensions.gcs_automated_payments.stream_defaults_title') }}
        </h3>
        <p class="mt-1 text-sm text-muted">
          {{ t('extensions.gcs_automated_payments.stream_defaults_description') }}
        </p>
      </div>

      <div class="space-y-3">
        <ExtensionFormField :label="t('extensions.gcs_automated_payments.enabled_payment_types')">
          <div class="flex flex-wrap gap-3">
            <ExtensionCheckbox
              v-for="option in paymentTypeOptions"
              :key="option.value"
              :model-value="localConfig.enabledPaymentTypes.includes(option.value as AutomatedPaymentType)"
              :label="option.label"
              @update:model-value="(value: boolean | 'indeterminate') => updatePaymentType(option.value as AutomatedPaymentType, value === true)" />
          </div>
        </ExtensionFormField>
      </div>
    </section>
  </div>
</template>
