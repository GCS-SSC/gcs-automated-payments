// @vitest-environment jsdom

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'

import StreamAutomatedPaymentsConfig from '../../components/StreamAutomatedPaymentsConfig.vue'
import extension from '../../extension.config'

describe('Automated Payments stream configuration', () => {
  it('publishes both extension contribution boundaries', () => {
    expect(extension.key).toBe('gcs-automated-payments')
    expect(extension.client?.paymentAmountCalculators).toHaveLength(1)
    expect(extension.serverHandlers).toHaveLength(1)
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
