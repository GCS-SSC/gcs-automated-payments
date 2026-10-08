// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
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
  model: Record<string, unknown>,
  onResult?: (result: unknown) => void
) => mount(AutomatedPaymentAmountCalculator, {
  props: {
    extensionKey: 'gcs-automated-payments',
    calculatorId: 'automated-payment-ceiling',
    config: {},
    context: {
      agreementId: 'agreement-51'
    },
    model,
    ...(onResult ? { onResult } : {})
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
      CommonCurrencyInput: defineComponent({
        props: ['modelValue', 'currency'],
        emits: ['update:modelValue'],
        setup(props, { emit }) {
          return () => h('input', {
            'data-test': 'holdback-amount',
            'data-currency': props.currency,
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
      locale: ref('en')
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
      locale: ref('en')
    }))
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        baseAmount: '10.00',
        ceilingAmount: '10.00',
        suggestedAmount: '10.00',
        holdbackAmount: '0.00',
        holdbackReleaseAmount: '0.00',
        availableBeforeHoldback: '93.50',
        currency: 'CAD',
        details: [
          { label: 'baseAmount', value: '10.00' },
          { label: 'commitmentRemaining', value: '25.00' },
          { label: 'availableBeforeHoldback', value: '93.50' },
          { label: 'holdbackReleaseAmount', value: '0.00' },
          { label: 'totalPaymentsToDate', value: '50.00' }
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
      locale: ref('en')
    }))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const wrapper = mountCalculator({ paymentType: 'advance' })
    await flushPromises()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(wrapper.emitted('extensionPayload')?.at(-1)?.[0]).toEqual({
      releaseHoldback: false,
      holdbackReleaseAmount: '0.00'
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
      expected: 'Unable to calculate the automated payment. Check the payment fields and try again.'
    }
  ])('normalizes a $name from the extension API', async ({ rejection, expected }) => {
    vi.stubGlobal('useI18n', () => ({
      t: (key: string) => messages[key] ?? key,
      locale: ref('en')
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
      locale: ref('en')
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
      locale: ref('en')
    }))
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ceilingAmount: '10.00',
        suggestedAmount: '10.00',
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
    expect(wrapper.get('[data-test="holdback-amount"]').attributes('data-currency')).toBe('cad')
    await wrapper.get('[data-test="holdback-amount"]').setValue('4.25')
    await flushPromises()

    expect(wrapper.emitted('extensionPayload')?.at(-1)?.[0]).toEqual({
      releaseHoldback: true,
      holdbackReleaseAmount: '4.25'
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)

    await wrapper.get('[data-test="holdback-amount"]').setValue('4.2x')
    await flushPromises()

    expect(wrapper.emitted('extensionPayload')?.at(-1)?.[0]).toEqual({
      releaseHoldback: true,
      holdbackReleaseAmount: '4.2x'
    })
  })

  it('sends the native currency and displays its code without converting cents', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ceilingAmount: '10.01', suggestedAmount: '10.01', currency: 'USD', details: [] }) }))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountCalculator({ commitmentType: '1', fiscalYear: '1', paymentType: 'advance', periodStart: 0, periodEnd: 0, currency: 'usd' })
    await flushPromises()
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown[])[1] && ((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body))
    expect(body.egcs_fc_currency).toBe('usd')
    expect(wrapper.text()).toContain('USD $10.01')
    expect(wrapper.emitted('result')?.at(-1)?.[0]).toMatchObject({ currency: 'USD', suggestedAmount: '10.01' })
    await wrapper.get('[data-test="release-holdback"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-test="holdback-amount"]').attributes('data-currency')).toBe('usd')
  })

  it('keeps the calculated ceiling independent of each edit to the actual payment amount', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({
      ceilingAmount: '10.00', suggestedAmount: '10.00', currency: 'CAD', details: []
    }) }))
    vi.stubGlobal('fetch', fetchMock)
    const model = { commitmentType: '1', fiscalYear: '1', paymentType: 'advance', periodStart: 0, periodEnd: 0, currency: 'cad', amount: '10.00' }
    const wrapper = mountCalculator(model)
    await flushPromises()
    const publishedCount = wrapper.emitted('result')!.length
    for (const amount of ['', '5', '5.', '5.01', '0', '10.00', '10.01', '0.001']) {
      await wrapper.setProps({ model: { ...model, amount } })
      await flushPromises()
      expect(wrapper.emitted('result')).toHaveLength(publishedCount)
    }
    expect(fetchMock).toHaveBeenCalledOnce()
    const request = JSON.parse(String((fetchMock.mock.calls[0] as unknown[])[1] && ((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body))
    expect(request).not.toHaveProperty('egcs_fc_paymentamount')
    expect(wrapper.emitted('result')!.at(-1)![0]).toMatchObject({ ceilingAmount: '10.00', error: null, loading: false })
  })

  it('resets the holdback election and ignores stale financial evidence when the Agreement changes', async () => {
    let resolveOld!: (value: unknown) => void
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ceilingAmount: '10.00', suggestedAmount: '10.00', currency: 'CAD', details: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ceilingAmount: '10.00', suggestedAmount: '10.00', currency: 'CAD', details: [] }) })
      .mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve }))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ceilingAmount: '20.00', suggestedAmount: '20.00', currency: 'CAD', details: [] }) })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountCalculator({ commitmentType: '1', fiscalYear: '1', paymentType: 'advance', periodStart: 0, periodEnd: 0, currency: 'cad' })
    await flushPromises()
    await wrapper.get('[data-test="release-holdback"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-test="holdback-amount"]').setValue('4.25')
    await flushPromises()
    await wrapper.setProps({ context: { agreementId: 'agreement-52' } })
    await flushPromises()
    expect(wrapper.find('[data-test="holdback-amount"]').exists()).toBe(false)
    expect(wrapper.emitted('extensionPayload')!.at(-1)![0]).toEqual({ releaseHoldback: false, holdbackReleaseAmount: '0.00' })
    const request = JSON.parse(String((fetchMock.mock.calls[3] as unknown[])[1] && ((fetchMock.mock.calls[3] as unknown[])[1] as RequestInit).body))
    expect(fetchMock.mock.calls[3]![0]).toContain('/agreements/agreement-52/calculate-payment')
    expect(request.extensions['gcs-automated-payments']).toEqual({ releaseHoldback: false, holdbackReleaseAmount: '0.00' })
    resolveOld({ ok: true, json: async () => ({ ceilingAmount: '99.00', suggestedAmount: '99.00', currency: 'CAD', details: [] }) })
    await flushPromises()
    expect(wrapper.emitted('result')!.at(-1)![0]).toMatchObject({ ceilingAmount: '20.00', loading: false, error: null })
  })

  it.each(['success', 'failure'])('ignores a stale CAD %s after the USD response', async outcome => {
    let resolveCad!: (value: unknown) => void
    let rejectCad!: (error: Error) => void
    let resolveUsd!: (value: unknown) => void
    const cad = new Promise((resolve, reject) => { resolveCad = resolve; rejectCad = reject })
    const usd = new Promise(resolve => { resolveUsd = resolve })
    const fetchMock = vi.fn().mockReturnValueOnce(cad).mockReturnValueOnce(usd)
    vi.stubGlobal('fetch', fetchMock)
    const model = { commitmentType: '1', fiscalYear: '1', paymentType: 'advance', periodStart: 0, periodEnd: 0, currency: 'cad' }
    const wrapper = mountCalculator(model)
    await flushPromises()
    await wrapper.setProps({ model: { ...model, currency: 'usd' } })
    await flushPromises()
    resolveUsd({ ok: true, json: async () => ({ ceilingAmount: '40.00', suggestedAmount: '40.00', currency: 'USD', details: [] }) })
    await flushPromises()
    if (outcome === 'success') resolveCad({ ok: true, json: async () => ({ ceilingAmount: '90.00', suggestedAmount: '90.00', currency: 'CAD', details: [] }) })
    else rejectCad(new Error('stale CAD error'))
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('result')?.at(-1)?.[0]).toMatchObject({ currency: 'USD', ceilingAmount: '40.00', suggestedAmount: '40.00', error: null, loading: false })
    expect(wrapper.text()).not.toContain('stale CAD error')
  })

  it('clears a calculation when currency is cleared and ignores the in-flight response', async () => {
    let resolve!: (value: unknown) => void
    const fetchMock = vi.fn(() => new Promise(done => { resolve = done }))
    vi.stubGlobal('fetch', fetchMock)
    const model = { commitmentType: '1', fiscalYear: '1', paymentType: 'advance', periodStart: 0, periodEnd: 0, currency: 'usd' }
    const wrapper = mountCalculator(model)
    await flushPromises()
    await wrapper.setProps({ model: { ...model, currency: '' } })
    await flushPromises()
    resolve({ ok: true, json: async () => ({ ceilingAmount: '90.00', suggestedAmount: '90.00', currency: 'USD', details: [] }) })
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(wrapper.emitted('result')?.at(-1)?.[0]).toMatchObject({ ceilingAmount: undefined, suggestedAmount: undefined, loading: false, error: null })
  })

  it('rejects a current server result belonging to another currency', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ceilingAmount: '90.00', suggestedAmount: '90.00', currency: 'CAD', details: [] }) })))
    const wrapper = mountCalculator({ commitmentType: '1', fiscalYear: '1', paymentType: 'advance', periodStart: 0, periodEnd: 0, currency: 'usd' })
    await flushPromises()
    expect(wrapper.emitted('result')?.at(-1)?.[0]).toMatchObject({ currency: 'USD', ceilingAmount: undefined, suggestedAmount: undefined,
      error: 'The calculation currency must match the payment currency. Recalculate before saving.' })
  })

  it('keeps the latest currency loading when an older request completes first', async () => {
    let resolveCad!: (value: unknown) => void
    let resolveUsd!: (value: unknown) => void
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(new Promise(resolve => { resolveCad = resolve }))
      .mockReturnValueOnce(new Promise(resolve => { resolveUsd = resolve })))
    const model = { commitmentType: '1', fiscalYear: '1', paymentType: 'advance', periodStart: 0, periodEnd: 0, currency: 'cad' }
    const wrapper = mountCalculator(model)
    await flushPromises()
    await wrapper.setProps({ model: { ...model, currency: 'usd' } })
    await flushPromises()
    resolveCad({ ok: true, json: async () => ({ ceilingAmount: '90.00', currency: 'CAD', details: [] }) })
    await flushPromises()
    expect(wrapper.emitted('result')?.at(-1)?.[0]).toMatchObject({ currency: 'USD', loading: true, ceilingAmount: undefined })
    resolveUsd({ ok: true, json: async () => ({ ceilingAmount: '40.00', suggestedAmount: '40.00', currency: 'USD', details: [] }) })
    await flushPromises()
    expect(wrapper.emitted('result')?.at(-1)?.[0]).toMatchObject({ currency: 'USD', loading: false, ceilingAmount: '40.00' })
  })

  it('ignores an older localized error body that finishes parsing after a new calculation', async () => {
    let resolveError!: (value: unknown) => void
    const response = new Response('{}', { status: 400 })
    vi.spyOn(response, 'json').mockReturnValue(new Promise(resolve => { resolveError = resolve }))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(response).mockResolvedValueOnce({ ok: true,
      json: async () => ({ ceilingAmount: '40.00', suggestedAmount: '40.00', currency: 'USD', details: [] }) }))
    const model = { commitmentType: '1', fiscalYear: '1', paymentType: 'advance', periodStart: 0, periodEnd: 0, currency: 'cad' }
    const wrapper = mountCalculator(model)
    await flushPromises()
    await wrapper.setProps({ model: { ...model, currency: 'usd' } })
    await flushPromises()
    resolveError({ message: 'Old CAD error' })
    await flushPromises()
    expect(wrapper.emitted('result')?.at(-1)?.[0]).toMatchObject({ currency: 'USD', ceilingAmount: '40.00', error: null, loading: false })
  })

  it('does not publish an in-flight calculation after unmount', async () => {
    let resolve!: (value: unknown) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise(done => { resolve = done })))
    const received: unknown[] = []
    const wrapper = mountCalculator({ commitmentType: '1', fiscalYear: '1', paymentType: 'advance', periodStart: 0, periodEnd: 0, currency: 'usd' }, result => received.push(result))
    await flushPromises()
    const count = received.length
    wrapper.unmount()
    resolve({ ok: true, json: async () => ({ ceilingAmount: '90.00', currency: 'USD', details: [] }) })
    await flushPromises()
    expect(received).toHaveLength(count)
  })
})

it.each([
  [{ data: { details: [null, { message: 'Champ invalide' }], message: 'Erreur' } }, 'Champ invalide'],
  [{ data: { details: [{ message: '' }], message: 'Erreur du calcul' } }, 'Erreur du calcul'],
  [{ message: 'Erreur serveur' }, 'Erreur serveur'],
  [{ statusMessage: 'Statut traduit' }, 'Statut traduit'],
  [null, 'Unable to calculate the automated payment. Check the payment fields and try again.'],
  ['not JSON', 'Unable to calculate the automated payment. Check the payment fields and try again.']
])('preserves response text and uses only its own fallback catalog', async (body, expected) => {
  vi.stubGlobal('useI18n', () => ({ locale: ref('en'), t: () => { throw new Error('Host lookup forbidden') } }))
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 400 }) }))
  const wrapper = mountCalculator({ commitmentType: 'commitment', fiscalYear: '1', paymentType: 'advance', periodStart: 1, periodEnd: 2, amount: 50 })
  await flushPromises()
  expect(wrapper.emitted('result')?.at(-1)?.[0]).toMatchObject({ error: expected })
})
