// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import type { GcsExtensionJsonConfig, GcsResolvedExtension } from '@gcs-ssc/extensions'

import StreamAutomatedPaymentsConfig from '../../components/StreamAutomatedPaymentsConfig.vue'
import extension from '../../extension.config'

describe('Automated Payments stream configuration', () => {
  it('publishes both extension contribution boundaries', () => {
    expect(extension.key).toBe('gcs-automated-payments')
    expect(extension.client?.paymentAmountCalculators).toHaveLength(1)
    expect(extension.serverHandlers).toHaveLength(2)
    expect(extension.client?.tabs).toBeUndefined()
    expect(extension.client?.slots).toEqual([expect.objectContaining({ slot: 'payment.evidence' })])
    expect(extension.nitroPlugin).toBe('./server/plugins/create-hooks.ts')
  })

  it('renders the owner-provided enabled payment types', () => {
    const wrapper = mount(StreamAutomatedPaymentsConfig, {
      props: {
        extension: extension as never,
        streamId: 'stream-1',
        modelValue: { enabledPaymentTypes: ['reimbursement', 'advance'] }
      },
      global: {
        stubs: {
          GcsUCheckbox: defineComponent({
            inheritAttrs: false,
            props: ['modelValue', 'label'],
            emits: ['update:modelValue'],
            setup(props, { emit }) {
              return () => h('input', {
                type: 'checkbox',
                checked: props.modelValue === true,
                onChange: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).checked)
              })
            }
          }),
          GcsUFormField: defineComponent({
            setup(_, { slots }) {
              return () => h('div', slots.default?.())
            }
          })
        }
      }
    })
    const checkboxes = wrapper.findAll('input[type="checkbox"]')
    expect(checkboxes).toHaveLength(2)
    expect(checkboxes.every(checkbox => (checkbox.element as HTMLInputElement).checked)).toBe(true)
  })
})


const resolvedExtension: GcsResolvedExtension = {
  key: extension.key, name: extension.name, sdkVersion: extension.sdkVersion,
  requiredHostCapabilities: extension.requiredHostCapabilities,
  packageName: '@gcs-ssc/gcs-automated-payments', rootDir: process.cwd(), admin: {},
  client: { slots: [], tabs: [], createActions: [], paymentAmountCalculators: [] },
  css: [], assets: [], serverHandlers: [], migrations: []
}

const Checkbox = defineComponent({
  props: ['modelValue'],
  emits: ['update:modelValue'],
  setup: (props, { emit }) => () => h('input', {
    type: 'checkbox',
    checked: props.modelValue === true,
    onChange: (event: Event) => {
      if (event.target instanceof HTMLInputElement) emit('update:modelValue', event.target.checked)
    }
  })
})

const mountControlledConfig = (initial: GcsExtensionJsonConfig) => {
  const model = ref(initial)
  const changes: GcsExtensionJsonConfig[] = []
  const Host = defineComponent({
    setup: () => () => h(StreamAutomatedPaymentsConfig, {
      extension: resolvedExtension,
      streamId: 'stream-1',
      modelValue: model.value,
      'onUpdate:modelValue': (value: GcsExtensionJsonConfig) => {
        changes.push(value)
        // Bound a broken echo loop so the regression fails without hanging Vue.
        if (changes.length <= 3) model.value = value
      }
    })
  })
  const wrapper = mount(Host, {
    global: {
      stubs: {
        GcsUCheckbox: Checkbox,
        GcsUFormField: defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) })
      }
    }
  })
  return { wrapper, model, changes }
}

it('emits one config change per checkbox edit when the host echoes v-model', async () => {
  const { wrapper, model, changes } = mountControlledConfig({ enabledPaymentTypes: ['reimbursement'] })
  expect(changes).toEqual([])
  await wrapper.findAll('input')[1]!.setValue(true)
  await flushPromises()
  expect(changes).toEqual([{ enabledPaymentTypes: ['reimbursement', 'advance'] }])
  expect(model.value).toEqual({ enabledPaymentTypes: ['reimbursement', 'advance'] })
  wrapper.unmount()
})

it('derives default and externally replaced selections without emitting owner changes', async () => {
  const { wrapper, model, changes } = mountControlledConfig({})
  const selected = () => wrapper.findAll<HTMLInputElement>('input').map(control => control.element.checked)
  expect(selected()).toEqual([true, true])
  model.value = { enabledPaymentTypes: [] }
  await flushPromises()
  expect(selected()).toEqual([false, false])
  model.value = { enabledPaymentTypes: ['advance'] }
  await flushPromises()
  expect(selected()).toEqual([false, true])
  model.value.enabledPaymentTypes = ['reimbursement']
  await flushPromises()
  expect(selected()).toEqual([true, false])
  expect(changes).toEqual([])
  wrapper.unmount()
})

it('preserves explicit empty selections and treats indeterminate as disabled', async () => {
  const { wrapper, model, changes } = mountControlledConfig({ enabledPaymentTypes: ['reimbursement'] })
  wrapper.findAllComponents(Checkbox)[0]!.vm.$emit('update:modelValue', 'indeterminate')
  await flushPromises()
  expect(model.value).toEqual({ enabledPaymentTypes: [] })
  expect(changes).toEqual([{ enabledPaymentTypes: [] }])
  expect(wrapper.findAll<HTMLInputElement>('input').every(control => !control.element.checked)).toBe(true)
  wrapper.unmount()
})
