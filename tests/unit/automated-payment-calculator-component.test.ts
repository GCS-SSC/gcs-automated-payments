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
        setup(props, { emit }) {
          return () => h('button', {
            'data-test': 'release-holdback',
            onClick: () => emit('update:modelValue', !props.modelValue)
          }, props.label)
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
        props: ['modelValue'],
        emits: ['update:modelValue'],
        setup(props, { emit }) {
          return () => h('input', {
            'data-test': 'holdback-amount',
            value: props.modelValue,
            onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value)
          })
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

  it('publishes a neutral result without calling the API until every required input is present', async () => {
    vi.stubGlobal('useI18n', () => ({
      t: (key: string) => messages[key] ?? key,
      n: (value: number) => `CA$${value.toFixed(2)}`
    }))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const wrapper = mountCalculator({ paymentType: 'advance' })
    await flushPromises()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(wrapper.emitted('extensionPayload')?.at(-1)?.[0]).toEqual({
      releaseHoldback: false,
      holdbackReleaseAmount: 0
    })
    expect(wrapper.emitted('result')?.at(-1)?.[0]).toMatchObject({
      currency: 'CAD',
      details: [],
      loading: false,
      error: null
    })
  })

  it.each([
    {
      name: 'plain Error',
      rejection: new Error('calculation exploded'),
      expected: 'calculation exploded'
    },
    {
      name: 'non-Error rejection',
      rejection: 'calculation exploded',
      expected: 'extensions.gcs_automated_payments.calculation_error'
    }
  ])('normalizes a $name from the extension API', async ({ rejection, expected }) => {
    vi.stubGlobal('useI18n', () => ({
      t: (key: string) => messages[key] ?? key,
      n: (value: number) => `CA$${value.toFixed(2)}`
    }))
    vi.stubGlobal('fetch', vi.fn(async () => { throw rejection }))

    const wrapper = mountCalculator({
      commitmentType: 'commitment',
      fiscalYear: '1',
      paymentType: 'reimbursement',
      periodStart: 1,
      periodEnd: 1
    })
    await flushPromises()

    expect(wrapper.emitted('result')?.at(-1)?.[0]).toMatchObject({ error: expected, loading: false })
  })

  it.each([
    { statusText: 'Bad Gateway', json: async () => { throw new Error('not json') }, expected: 'Bad Gateway' },
    { statusText: '', json: async () => ({}), expected: 'HTTP 400' },
    { statusText: 'ignored', json: async () => ({ message: 'top-level message' }), expected: 'top-level message' },
    { statusText: 'ignored', json: async () => ({ statusMessage: 'top-level status' }), expected: 'ignored' },
    { statusText: 'ignored', json: async () => ({ data: { message: 'nested message' } }), expected: 'nested message' },
    { statusText: 'ignored', json: async () => ({ data: { details: [null, { message: '' }, { message: 'detail message' }] } }), expected: 'detail message' }
  ])('extracts API errors before falling back to "$statusText"', async ({ statusText, json, expected }) => {
    vi.stubGlobal('useI18n', () => ({
      t: (key: string) => messages[key] ?? key,
      n: (value: number) => `CA$${value.toFixed(2)}`
    }))
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText,
      json,
      text: async () => ''
    })))

    const wrapper = mountCalculator({
      commitmentType: 'commitment',
      fiscalYear: '1',
      paymentType: 'advance',
      periodStart: 1,
      periodEnd: 2
    })
    await flushPromises()

    expect(wrapper.emitted('result')?.at(-1)?.[0]).toMatchObject({ error: expected })
  })

  it('recalculates and publishes holdback inputs', async () => {
    vi.stubGlobal('useI18n', () => ({
      t: (key: string) => messages[key] ?? key,
      n: (value: number) => `CA$${value.toFixed(2)}`
    }))
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ceilingAmount: 10,
        suggestedAmount: 10,
        currency: 'CAD',
        details: []
      })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountCalculator({
      commitmentType: 'commitment',
      fiscalYear: '1',
      paymentType: 'advance',
      periodStart: 1,
      periodEnd: 2
    })
    await flushPromises()

    await wrapper.get('[data-test="release-holdback"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-test="holdback-amount"]').setValue('4.25')
    await flushPromises()

    expect(wrapper.emitted('extensionPayload')?.at(-1)?.[0]).toEqual({
      releaseHoldback: true,
      holdbackReleaseAmount: 4.25
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
