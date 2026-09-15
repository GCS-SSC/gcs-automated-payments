import type { GcsResolvedExtension } from '@gcs-ssc/extensions'
import { ExtensionCheckbox } from '@gcs-ssc/extensions/ui'
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import Config from '../../components/StreamAutomatedPaymentsConfig.vue'
import extension from '../../extension.config'

const resolvedExtension: GcsResolvedExtension = {
  key: extension.key, name: extension.name, sdkVersion: extension.sdkVersion, requiredHostCapabilities: extension.requiredHostCapabilities,
  packageName: '@gcs-ssc/gcs-automated-payments', rootDir: process.cwd(), admin: {},
  client: { slots: [], tabs: [], createActions: [], paymentAmountCalculators: [] },
  css: [], assets: [], serverHandlers: [], migrations: []
}

afterEach(() => vi.unstubAllGlobals())
it('owns config and payment labels in both locales without host translation lookup', async () => {
  const locale = ref('en')
  const hostTranslate = vi.fn(() => { throw new Error('Host message lookup is forbidden') })
  vi.stubGlobal('useI18n', () => ({ locale, t: hostTranslate }))
  const wrapper = mount(Config, { props: { extension: resolvedExtension, streamId: '1', modelValue: { enabledPaymentTypes: ['advance'] } } })
  expect(wrapper.text()).toContain('Automated payment defaults')
  expect(wrapper.findAllComponents(ExtensionCheckbox).map(control => control.vm.$attrs.label)).toContain('Advance')
  locale.value = 'fr'
  await wrapper.vm.$nextTick()
  expect(wrapper.text()).toContain('Parametres par defaut des paiements automatises')
  expect(wrapper.findAllComponents(ExtensionCheckbox).map(control => control.vm.$attrs.label)).toContain('Avance')
  expect(hostTranslate).not.toHaveBeenCalled()
})
