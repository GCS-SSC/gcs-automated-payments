<script setup lang="ts">
defineProps<{
  extensionKey: string
}>()

const { t } = useI18n()
</script>

<template>
  <div class="space-y-2">
    <h3 class="text-base font-semibold text-highlighted">
      {{ t('extensions.gcs_automated_payments.agreement_inputs_title') }}
    </h3>
    <p class="text-sm text-muted">
      {{ t('extensions.gcs_automated_payments.agreement_inputs_description') }}
    </p>
  </div>
</template>
