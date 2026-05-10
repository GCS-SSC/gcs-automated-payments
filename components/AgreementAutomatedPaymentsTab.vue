<script setup lang="ts">
import { getClientRequestUrl } from '~/utils/client-request-url'
/* eslint-disable jsdoc/require-jsdoc */
import { computed, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { GcsExtensionJsonConfig } from '@gcs-ssc/extensions'
import type { ExtensionEntityTabContext } from '@gcs-ssc/extensions/server'
import {
  defaultAutomatedPaymentsAgreementSettings,
  parseAutomatedPaymentsAgreementSettings,
  type AutomatedPaymentsAgreementSettings
} from '../shared/automated-payments'

const {
  extensionKey,
  context
} = defineProps<{
  extensionKey: string
  config: GcsExtensionJsonConfig
  context: ExtensionEntityTabContext
}>()

const toast = useToast()
const { t } = useI18n()
const state: Ref<AutomatedPaymentsAgreementSettings | null> = ref(null)
const isSaving: Ref<boolean> = ref(false)

const endpoint = computed(() => `/api/extensions/${extensionKey}/agreements/${context.agreementId}/settings`)
const data: Ref<AutomatedPaymentsAgreementSettings | null> = ref(null)
const status: Ref<'idle' | 'pending' | 'success' | 'error'> = ref('idle')
const refresh = async () => {
  try {
    status.value = 'pending'
    const response = await fetch(getClientRequestUrl(endpoint.value))
    data.value = response.ok ? await response.json() as AutomatedPaymentsAgreementSettings : null
    status.value = response.ok ? 'success' : 'error'
  } catch {
    status.value = 'error'
  }
}
await refresh()

watch(data, value => {
  state.value = parseAutomatedPaymentsAgreementSettings(value)
}, { immediate: true })

type AutomatedPaymentsAgreementNumberField = 'previousClaimsTotal' | 'previousPaymentsTotal'

const updateNumber = (field: AutomatedPaymentsAgreementNumberField, value: string | number) => {
  if (!state.value) {
    return
  }
  const numericValue = Number(value)
  state.value = {
    ...state.value,
    [field]: Number.isFinite(numericValue) ? numericValue : defaultAutomatedPaymentsAgreementSettings[field]
  }
}

const updateHoldbackReleaseOverride = (value: string | number) => {
  if (!state.value) {
    return
  }
  if (value === '') {
    state.value = {
      ...state.value,
      holdbackReleaseOverride: null
    }
    return
  }
  const numericValue = Number(value)
  state.value = {
    ...state.value,
    holdbackReleaseOverride: Number.isFinite(numericValue) ? numericValue : null
  }
}

const saveSettings = async () => {
  if (!state.value || isSaving.value) {
    return
  }

  isSaving.value = true
  try {
    const response = await fetch(getClientRequestUrl(endpoint.value), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(state.value)
    })
    if (!response.ok) throw new Error(response.statusText)
    await refresh()
    toast.add({
      title: t('common.success'),
      description: t('common.updated_success'),
      color: 'success'
    })
  } finally {
    isSaving.value = false
  }
}
</script>

<template>
  <div class="space-y-6">
    <div>
      <h3 class="text-base font-semibold text-highlighted">
        {{ t('extensions.gcs_automated_payments.agreement_inputs_title') }}
      </h3>
      <p class="mt-1 text-sm text-muted">
        {{ t('extensions.gcs_automated_payments.agreement_inputs_description') }}
      </p>
    </div>

    <div v-if="state" class="grid gap-4 md:grid-cols-3">
      <UFormField :label="t('extensions.gcs_automated_payments.previous_claims_total')">
        <UInput
          :model-value="String(state.previousClaimsTotal)"
          type="number"
          min="0"
          step="0.01"
          @update:model-value="value => updateNumber('previousClaimsTotal', value)" />
      </UFormField>

      <UFormField :label="t('extensions.gcs_automated_payments.previous_payments_total')">
        <UInput
          :model-value="String(state.previousPaymentsTotal)"
          type="number"
          min="0"
          step="0.01"
          @update:model-value="value => updateNumber('previousPaymentsTotal', value)" />
      </UFormField>

      <UFormField :label="t('extensions.gcs_automated_payments.holdback_release_override')">
        <UInput
          :model-value="state.holdbackReleaseOverride === null ? '' : String(state.holdbackReleaseOverride)"
          type="number"
          min="0"
          step="0.01"
          @update:model-value="updateHoldbackReleaseOverride" />
      </UFormField>
    </div>

    <div class="flex justify-end">
      <CommonSaveButton
        :label="t('extensions.gcs_automated_payments.save_settings')"
        :loading="isSaving || status === 'pending'"
        :disabled="isSaving || status === 'pending' || !state"
        @click="saveSettings" />
    </div>
  </div>
</template>
