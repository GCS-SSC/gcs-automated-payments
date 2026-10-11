// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import type { GcsExtensionJsonConfig } from '@gcs-ssc/extensions'
import { ExtensionFormField, ExtensionSelectMenu } from '@gcs-ssc/extensions/ui'
import AgencyConfig from '../../components/AgencyAutomatedPaymentsConfig.vue'
import extension from '../../extension.config'
import { AutomatedPaymentsAgencyConfigSchema } from '../../shared/automated-payments'

afterEach(() => vi.unstubAllGlobals())

it('exposes an agency choice without selecting or saving a default', () => {
  const wrapper = mount(AgencyConfig, { props: { agencyId: '1', modelValue: {} } })
  expect(extension.requiredHostCapabilities).toContain('agency-config')
  expect(extension.admin?.agency?.path).toBe('./components/AgencyAutomatedPaymentsConfig.vue')
  expect(wrapper.findComponent(ExtensionSelectMenu).vm.$attrs['model-value']).toBeUndefined()
  expect(wrapper.findComponent(ExtensionFormField).vm.$attrs).toMatchObject({
    name: 'creditMemoBasis', required: true, error: expect.any(String) })
  expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  expect(AutomatedPaymentsAgencyConfigSchema.safeParse({}).success).toBe(false)
})

it('publishes both choices, preserves unrelated config, hydrates changes and rejects clearing without a fallback', async () => {
  const wrapper = mount(AgencyConfig, { props: { agencyId: '1', modelValue: { otherSetting: 'retained' } } })
  for (const creditMemoBasis of ['all', 'reconciled-periods']) {
    wrapper.findComponent(ExtensionSelectMenu).vm.$emit('update:modelValue', creditMemoBasis)
    await wrapper.vm.$nextTick()
    const updated = wrapper.emitted('update:modelValue')!.at(-1)![0] as GcsExtensionJsonConfig
    expect(updated).toEqual({ otherSetting: 'retained', creditMemoBasis })
    expect(AutomatedPaymentsAgencyConfigSchema.safeParse(updated).success).toBe(true)
    await wrapper.setProps({ modelValue: updated })
    expect(wrapper.findComponent(ExtensionSelectMenu).vm.$attrs['model-value']).toBe(creditMemoBasis)
    expect(wrapper.findComponent(ExtensionFormField).vm.$attrs.error).toBeUndefined()
  }
  wrapper.findComponent(ExtensionSelectMenu).vm.$emit('update:modelValue', null)
  await wrapper.vm.$nextTick()
  const cleared = wrapper.emitted('update:modelValue')!.at(-1)![0]
  expect(cleared).toEqual({ otherSetting: 'retained', creditMemoBasis: null })
  expect(AutomatedPaymentsAgencyConfigSchema.safeParse(cleared).success).toBe(false)
})

it('uses live bilingual labels and instructions and honors disabled and read-only configuration', async () => {
  const locale = ref('en')
  vi.stubGlobal('useI18n', () => ({ locale, t: () => { throw new Error('Host translation lookup is unavailable') } }))
  const wrapper = mount(AgencyConfig, { props: { modelValue: {}, disabled: true } })
  const control = wrapper.findComponent(ExtensionSelectMenu)
  expect(control.vm.$attrs.disabled).toBe(true)
  expect(control.vm.$attrs.items).toEqual([
    { value: 'all', label: 'All credit memos' },
    { value: 'reconciled-periods', label: 'Credit memos for reconciled periods' }])
  expect(wrapper.findComponent(ExtensionFormField).vm.$attrs.label).toBe('Credit memos used for payments')
  locale.value = 'fr'
  await wrapper.vm.$nextTick()
  expect(control.vm.$attrs.items).toEqual([
    { value: 'all', label: 'Toutes les notes de crédit' },
    { value: 'reconciled-periods', label: 'Notes de crédit des périodes rapprochées' }])
  expect(wrapper.findComponent(ExtensionFormField).vm.$attrs.error).toContain('Choisissez')
  await wrapper.setProps({ disabled: false, readOnly: true })
  expect(control.vm.$attrs.disabled).toBe(true)
})
