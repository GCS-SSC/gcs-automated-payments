<script setup lang="ts">
import { getClientRequestUrl } from '~/utils/client-request-url'
/* eslint-disable jsdoc/require-jsdoc */
import { computed, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { GcsExtensionJsonConfig } from '@gcs-ssc/extensions'
import {
  parseAutomatedPaymentsAgreementSettings,
  type AutomatedPaymentsAgreementSettings
} from '../shared/automated-payments'

type AgreementProfileSlotContext = {
  mode?: 'create' | 'update' | 'read'
  agreementId?: string
  setExtensionPayload?: (extensionKey: string, payloadKey: string, value: unknown) => void
}

const {
  extensionKey,
  context = {}
} = defineProps<{
  extensionKey: string
  config: GcsExtensionJsonConfig
  context?: AgreementProfileSlotContext
}>()

const { t, n } = useI18n()
const state: Ref<AutomatedPaymentsAgreementSettings | null> = ref(null)
const isHydrating: Ref<boolean> = ref(false)
const unavailableValue = '-'

const agreementId = computed(() => context.agreementId)
const isEditable = computed(() => context.mode === 'update')
const endpoint = computed(() => agreementId.value
  ? `/api/extensions/${extensionKey}/agreements/${agreementId.value}/settings`
  : ''
)

const holdbackBasisOptions = computed(() => [
  { label: t('extensions.gcs_automated_payments.holdback_basis_agreement_total'), value: 'agreement-total' },
  { label: t('extensions.gcs_automated_payments.holdback_basis_final_fiscal_year'), value: 'final-fiscal-year' }
])

const data: Ref<AutomatedPaymentsAgreementSettings | null> = ref(null)
const status: Ref<'idle' | 'pending' | 'success' | 'error'> = ref('idle')
const refresh = async () => {
  if (!agreementId.value) {
    return
  }

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
  isHydrating.value = true
  state.value = parseAutomatedPaymentsAgreementSettings(value)
  isHydrating.value = false
}, { immediate: true })

watch(state, value => {
  if (!value || isHydrating.value || !isEditable.value || !context.setExtensionPayload) {
    return
  }

  context.setExtensionPayload(extensionKey, 'agreementSettings', value)
}, { deep: true })

const updateHoldbackPercent = (value: string | number) => {
  if (!state.value) {
    return
  }

  const numericValue = Number(value)
  state.value = {
    ...state.value,
    holdbackPercent: Number.isFinite(numericValue) ? numericValue : 0
  }
}

const updateHoldbackBasis = (value: string | number | boolean | Record<string, unknown> | undefined) => {
  if (!state.value) {
    return
  }

  state.value = {
    ...state.value,
    holdbackBasis: value === 'final-fiscal-year' ? 'final-fiscal-year' : 'agreement-total'
  }
}

const formatPercent = (value: number) => n(value / 100, {
  style: 'percent',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2
})

const holdbackBasisLabel = computed(() => {
  const basis = state.value?.holdbackBasis
  return holdbackBasisOptions.value.find(option => option.value === basis)?.label ?? '-'
})
</script>

<template>
  <CommonSection :title="t('agreement.sections.payments')" badge="03" :grid-cols="1">
    <div v-if="state && isEditable" class="grid grid-cols-1 gap-4 md:grid-cols-2">
      <UFormField :label="t('extensions.gcs_automated_payments.holdback_percent')">
        <UInput
          :model-value="String(state.holdbackPercent)"
          type="number"
          min="0"
          max="100"
          step="0.01"
          @update:model-value="updateHoldbackPercent" />
      </UFormField>

      <UFormField :label="t('extensions.gcs_automated_payments.holdback_basis')">
        <USelect
          :model-value="state.holdbackBasis"
          :items="holdbackBasisOptions"
          value-key="value"
          label-key="label"
          @update:model-value="updateHoldbackBasis" />
      </UFormField>
    </div>

    <div v-else-if="state" class="grid grid-cols-1 gap-6 md:grid-cols-2">
      <CommonValueCard
        :label="t('extensions.gcs_automated_payments.holdback_percent')"
        :value="formatPercent(state.holdbackPercent)" />
      <CommonValueCard
        :label="t('extensions.gcs_automated_payments.holdback_basis')"
        :value="holdbackBasisLabel" />
    </div>

    <p v-else class="text-sm text-muted">
      {{ status === 'pending' ? t('common.loading') : unavailableValue }}
    </p>
  </CommonSection>
</template>
