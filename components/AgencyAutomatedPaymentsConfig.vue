<script setup lang="ts">
import { computed } from 'vue'
import type { GcsExtensionJsonConfig } from '@gcs-ssc/extensions'
import { ExtensionFormField, ExtensionSelectMenu, useExtensionI18n } from '@gcs-ssc/extensions/ui'
import { AutomatedPaymentCreditMemoBasisSchema } from '../shared/automated-payments'
import { messages } from '../i18n/messages'

const { disabled = false, readOnly = false } = defineProps<{ agencyId?: string; disabled?: boolean; readOnly?: boolean }>()
const config = defineModel<GcsExtensionJsonConfig>({ required: true })
const { t } = useExtensionI18n(messages)
const selection = computed(() => AutomatedPaymentCreditMemoBasisSchema.safeParse(config.value.creditMemoBasis))
const options = computed(() => [
  { value: 'all', label: t('credit_memo_basis.all') },
  { value: 'reconciled-periods', label: t('credit_memo_basis.reconciled_periods') }
])
const updateSelection = (value: unknown) => {
  const parsed = AutomatedPaymentCreditMemoBasisSchema.safeParse(value)
  config.value = { ...config.value, creditMemoBasis: parsed.success ? parsed.data : null }
}
</script>

<template>
  <ExtensionFormField
    :label="t('credit_memo_basis')"
    name="creditMemoBasis"
    :description="t('credit_memo_basis_description')"
    :error="selection.success ? undefined : t('credit_memo_basis_required')"
    :required="true" data-field-scope="extension.gcs-automated-payments.agency-automated-payments-config">
    <ExtensionSelectMenu
      :model-value="selection.success ? selection.data : undefined"
      :items="options"
      value-key="value"
      :placeholder="t('credit_memo_basis_placeholder')"
      :disabled="disabled || readOnly"
      @update:model-value="updateSelection" />
  </ExtensionFormField>
</template>
