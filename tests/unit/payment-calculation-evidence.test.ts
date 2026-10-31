// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import PaymentCalculationEvidence from '../../components/PaymentCalculationEvidence.vue'
import { money } from '../fixtures/money'
import { AutomatedPaymentCalculationEvidenceSchema } from '../../shared/automated-payments'

const usd = (value: string) => money(value, 'USD')
const evidence = { version: 3, capturedAt: '2026-10-09T12:00:00.000Z',
  input: { fiscalYearId: '3', commitmentTypeId: '2', paymentType: 'advance', periodStart: 1, periodEnd: 4, currency: 'usd', creditMemoBasis: 'all' },
  calculation: { enabled: true, currency: 'USD', baseAmount: usd('100.01'), ceilingAmount: usd('90'), suggestedAmount: usd('90'), holdbackAmount: usd('10'), holdbackReleaseAmount: usd('0'), availableBeforeHoldback: usd('90'), details: [],
    explanation: [{ label: 'explanation.payment_calculation', rows: [
      { label: 'explanation.claims', value: usd('100.01') },
      { label: 'explanation.commitment', value: usd('199999999999999999.98') },
      { label: 'explanation.paid', value: usd('-0.01'), operator: '−' }
    ], total: { label: 'explanation.maximum', value: usd('90') } }] } }
const context = (ownerId = '90') => ({ kind: 'payment.evidence' as const, paymentId: ownerId, ownerId, ownerType: 'fundingcasepayment' as const, agreementId: '1', agencyId: '2', scope: { type: 'agency' as const, agencyId: '2' } })
const render = () => mount(PaymentCalculationEvidence, { props: { extensionKey: 'gcs-automated-payments', context: context(), config: {}, rbac: { subject: 'agreement', action: 'read' } }, global: { stubs: {
  CommonSection: defineComponent({ props: ['title'], setup(props, { slots }) { return () => h('section', [h('h3', props.title as string), slots.default?.()]) } }),
  CommonPaymentCalculationBreakdown: defineComponent({ props: ['explanation'], setup(props) { return () => h('div', { 'data-testid': 'shared-calculation-breakdown' }, (props.explanation as Array<{ label: string, rows: Array<{ label: string, value: string, operator?: string }>, total: { label: string, value: string }, note?: string }>).map(step => h('section', [h('h4', step.label), ...step.rows.map(row => h('p', `${row.operator ?? ''} ${row.label}: ${row.value}`)), h('strong', `${step.total.label}: ${step.total.value}`), h('p', step.note)]))) } }),
  UButton: defineComponent({ props: ['label'], emits: ['click'], setup(props, { emit }) { return () => h('button', { onClick: () => emit('click') }, props.label as string) } })
} } })
const response = (value: unknown) => ({ ok: true, json: async () => ({ evidence: value }) })
afterEach(() => vi.unstubAllGlobals())

describe('retained Payment calculation view', () => {
  it('renders current retained Money exactly in both languages', async () => {
    const locale = ref('en')
    vi.stubGlobal('useI18n', () => ({ locale, t: () => { throw new Error('Host translations are unavailable') } }))
    const fetch = vi.fn(async (_url: string) => response(evidence))
    vi.stubGlobal('fetch', fetch)
    const wrapper = render()
    expect(wrapper.find('[role="status"]').exists()).toBe(true)
    await flushPromises()
    expect(wrapper.text()).toContain('$100.01')
    expect(wrapper.text()).toContain('199,999,999,999,999,999.98')
    expect(wrapper.text()).toContain('(-$0.01)')
    expect(wrapper.get('h3').text()).toBe('Calculation details')
    expect(wrapper.find('[data-testid="shared-calculation-breakdown"]').exists()).toBe(true)
    expect(fetch.mock.calls[0]?.[0]).toContain('/payments/90/calculation-evidence')
    locale.value = 'fr'
    await flushPromises()
    expect(wrapper.text()).toContain('Détails du calcul')
    expect(wrapper.text().replace(/[^\d,]/g, '')).toContain('199999999999999999,98')
    wrapper.unmount()
  })
  it('renders percentage operands separately from money and uses actual currency precision', async () => {
    vi.stubGlobal('useI18n', () => ({ locale: ref('en'), t: () => { throw new Error('Host translations unavailable') } }))
    const kwd = (value: string) => money(value, 'KWD')
    const snapshot = { ...evidence, input: { ...evidence.input, currency: 'kwd' }, calculation: {
      enabled: true, currency: 'KWD', baseAmount: kwd('0.001'), ceilingAmount: kwd('0.001'), suggestedAmount: kwd('0.001'), holdbackAmount: kwd('0'), holdbackReleaseAmount: kwd('0'), availableBeforeHoldback: kwd('0.001'), details: [],
      explanation: [{ label: 'explanation.holdback', rows: [
        { label: 'explanation.agreement_total', value: kwd('1.001') },
        { label: 'explanation.holdback_rate', value: '10', operator: '×', format: 'percent' }
      ], total: { label: 'explanation.maximum', value: kwd('0.001') } }]
    } }
    expect(AutomatedPaymentCalculationEvidenceSchema.safeParse(snapshot).success).toBe(true)
    vi.stubGlobal('fetch', vi.fn(async () => response(snapshot)))
    const wrapper = render()
    await flushPromises()
    expect(wrapper.text()).toContain('10%')
    expect(wrapper.text()).toContain('KWD')
    expect(wrapper.text()).toContain('0.001')
    expect(wrapper.find('details').exists()).toBe(false)
    wrapper.unmount()
  })
  it('shows a localized unavailable state for existing payments with no snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(null)))
    const wrapper = render()
    await flushPromises()
    expect(wrapper.text()).toContain('No calculation was retained')
    expect(wrapper.find('dl').exists()).toBe(false)
    wrapper.unmount()
  })
  it('offers retry after read failure and then displays the same retained calculation', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(response(evidence))
    vi.stubGlobal('fetch', fetch)
    const wrapper = render()
    await flushPromises()
    expect(wrapper.find('[role="alert"]').text()).toContain('Unable to load')
    await wrapper.find('button').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('$100.01')
    expect(fetch).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })
  it('rejects malformed or unsupported retained evidence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ ...evidence, version: 9 })))
    const wrapper = render()
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    wrapper.unmount()
  })
  it('rejects a previous Payment response after the context changes', async () => {
    let resolveOld!: (value: ReturnType<typeof response>) => void
    const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve })).mockResolvedValueOnce(response(null))
    vi.stubGlobal('fetch', fetch)
    const wrapper = render()
    await wrapper.setProps({ context: context('91') })
    await flushPromises()
    resolveOld(response(evidence))
    await flushPromises()
    expect(wrapper.text()).toContain('No calculation was retained')
    expect(wrapper.text()).not.toContain('$100.01')
    wrapper.unmount()
  })
})
