// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import AutomatedPaymentAmountCalculator from '../../components/AutomatedPaymentAmountCalculator.vue'

afterEach(() => {
  vi.unstubAllGlobals()
})

const messages: Record<string, string> = {
  'extensions.gcs_automated_payments.calculation_details': 'Calculation details',
  'extensions.gcs_automated_payments.details.base_amount': 'Base amount',
  'extensions.gcs_automated_payments.details.commitment_remaining': 'Commitment remaining',
  'extensions.gcs_automated_payments.details.available_before_holdback': 'Available before holdback',
  'extensions.gcs_automated_payments.details.holdback_release_amount': 'Holdback release amount',
  'extensions.gcs_automated_payments.details.total_claims_to_last_claim_month': 'Claims to last claim month',
  'extensions.gcs_automated_payments.details.total_forecast_to_last_claim_month': 'Forecast to last claim month',
  'extensions.gcs_automated_payments.details.total_forecast_to_period_end': 'Forecast to period end',
  'extensions.gcs_automated_payments.details.total_payments_to_date': 'Payments to date'
}

const mountCalculator = (
  model: Record<string, unknown>
) => mount(AutomatedPaymentAmountCalculator, {
  props: {
    extensionKey: 'gcs-automated-payments',
    calculatorId: 'automated-payment-ceiling',
    config: {},
    context: {
      agreementId: 'agreement-51'
    },
    model
  },
  global: {
    stubs: {
      UAccordion: defineComponent({
        props: ['items'],
        setup(props, { slots }) {
          return () => h('section', [
            h('button', (props.items as Array<{ label: string }> | undefined)?.[0]?.label),
            slots.body?.()
          ])
        }
      }),
      UBadge: defineComponent({
        setup(_, { slots }) {
          return () => h('span', slots.default?.())
        }
      }),
      UCheckbox: defineComponent({
        props: ['modelValue', 'label'],
        emits: ['update:modelValue'],
        setup(props) {
          return () => h('label', props.label)
        }
      }),
      UFormField: defineComponent({
        props: ['label'],
        setup(props, { slots }) {
          return () => h('label', [
            h('span', props.label as string),
            slots.default?.()
          ])
        }
      }),
      UIcon: true,
      UInput: defineComponent({
        setup() {
          return () => h('input')
        }
      })
    }
  }
})

describe('automated payment amount calculator', () => {
  it('shows localized API detail messages instead of HTTP status text', async () => {
    vi.stubGlobal('useI18n', () => ({
      t: (key: string) => messages[key] ?? key,
      n: (value: number) => `CA$${value.toFixed(2)}`
    }))
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: 'Server Error',
      json: async () => ({
        data: {
          code: 'VALIDATION_FAILED',
          message: 'Validation failed.',
          details: [{
            path: 'egcs_fc_periodend',
            code: 'custom',
            message: 'Period end must be the same as or after period start.'
          }]
        }
      })
    })))

    const wrapper = mountCalculator({
      commitmentType: 'commitment',
      fiscalYear: '1',
      paymentType: 'advance',
      periodStart: 3,
      periodEnd: 2,
      amount: 50
    })

    await flushPromises()

    expect(wrapper.text()).toContain('Period end must be the same as or after period start.')
    expect(wrapper.text()).not.toContain('Server Error')
    expect(wrapper.emitted('result')?.at(-1)?.[0]).toMatchObject({
      error: 'Period end must be the same as or after period start.'
    })
  })

  it('renders calculation details with readable labels in an accordion', async () => {
    vi.stubGlobal('useI18n', () => ({
      t: (key: string) => messages[key] ?? key,
      n: (value: number) => `CA$${value.toFixed(2)}`
    }))
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        baseAmount: 10,
        ceilingAmount: 10,
        suggestedAmount: 10,
        holdbackAmount: 0,
        holdbackReleaseAmount: 0,
        availableBeforeHoldback: 93.5,
        currency: 'CAD',
        details: [
          { label: 'baseAmount', value: 10 },
          { label: 'commitmentRemaining', value: 25 },
          { label: 'availableBeforeHoldback', value: 93.5 },
          { label: 'holdbackReleaseAmount', value: 0 },
          { label: 'totalPaymentsToDate', value: 50 }
        ]
      })
    })))

    const wrapper = mountCalculator({
      commitmentType: 'commitment',
      fiscalYear: '1',
      paymentType: 'advance',
      periodStart: 2,
      periodEnd: 3,
      amount: 10
    })

    await flushPromises()

    expect(wrapper.text()).toContain('Calculation details')
    expect(wrapper.text()).toContain('Base amount')
    expect(wrapper.text()).toContain('Commitment remaining')
    expect(wrapper.text()).toContain('Available before holdback')
    expect(wrapper.text()).toContain('Payments to date')
    expect(wrapper.text()).not.toContain('baseAmount')
    expect(wrapper.text()).not.toContain('totalPaymentsToDate')
  })
})
