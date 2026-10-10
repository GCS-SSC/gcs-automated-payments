// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import PaymentCalculationEvidence from '../../components/PaymentCalculationEvidence.vue'
import extension from '../../extension.config'

const evidence = { version: 1, capturedAt: '2026-10-09T12:00:00.000Z',
  input: { fiscalYearId: '3', commitmentTypeId: '2', paymentType: 'advance', periodEnd: 4, currency: 'usd' },
  calculation: { enabled: true, currency: 'USD', baseAmount: '100.01', ceilingAmount: '90.00', suggestedAmount: '90.00', holdbackAmount: '10.00', holdbackReleaseAmount: '0.00', availableBeforeHoldback: '90.00', details: [{ label: 'baseAmount', value: '100.01' }, { label: 'commitmentRemaining', value: '199999999999999999.98' }, { label: 'totalPaymentsToDate', value: '-0.01' }] } }
const context = (ownerId = '90') => ({ target: 'payment' as const, ownerId, ownerType: 'fundingcasepayment' as const, agreementId: '1', agencyId: '2', scope: { type: 'agency' as const, agencyId: '2' } })
const render = () => mount(PaymentCalculationEvidence, { props: { extensionKey: 'gcs-automated-payments', context: context(), config: {}, rbac: { subject: 'agreement', action: 'read' } }, global: { stubs: {
  CommonSection: defineComponent({ props: ['title'], setup(props, { slots }) { return () => h('section', [h('h3', props.title as string), slots.default?.()]) } }),
  UButton: defineComponent({ props: ['label'], emits: ['click'], setup(props, { emit }) { return () => h('button', { onClick: () => emit('click') }, props.label as string) } })
} } })
const response = (value: unknown) => ({ ok: true, json: async () => ({ evidence: value }) })
afterEach(() => vi.unstubAllGlobals())

describe('retained Payment calculation view', () => {
  it('renders immutable numbers, huge exact USD and negative cents in both interface languages', async () => {
    const locale = ref('en')
    vi.stubGlobal('useI18n', () => ({ locale, t: () => { throw new Error('Host translation lookup is unavailable') } }))
    const fetch = vi.fn(async (_url: string) => response(evidence))
    vi.stubGlobal('fetch', fetch)
    const wrapper = render()
    expect(wrapper.find('[role="status"]').exists()).toBe(true)
    await flushPromises()
    expect(wrapper.text()).toContain('Base amount')
    expect(wrapper.get('h3').text()).toBe('Calculation details')
    expect(wrapper.find('h2').exists()).toBe(false)
    expect(wrapper.get('[data-testid="payment-calculation-evidence"]').classes()).not.toContain('max-w-4xl')
    expect(wrapper.text()).toContain('$100.01')
    expect(wrapper.text()).toContain('$199,999,999,999,999,999.98')
    const largeAmount = wrapper.findAll('dd')[1]!
    expect(largeAmount.classes()).toEqual(expect.arrayContaining(['min-w-0', 'wrap-anywhere']))
    expect(largeAmount.element.parentElement!.classList).toContain('flex-col')
    expect(largeAmount.element.parentElement!.classList).toContain('sm:flex-row')
    expect(wrapper.text()).toContain('-$0.01')
    expect(wrapper.text()).toContain('Calculation retained when this payment was created')
    expect(fetch.mock.calls[0]?.[0]).toContain('/payments/90/calculation-evidence')
    locale.value = 'fr'
    await flushPromises()
    expect(wrapper.text()).toContain('Montant de base')
    expect(wrapper.findAll('dd')[1]!.text().replace(/[^\d,]/g, '')).toBe('199999999999999999,98')
    expect(wrapper.findAll('dd')[1]!.classes()).toContain('wrap-anywhere')
    expect(wrapper.get('h3').text()).toBe('Details du calcul')
    expect(wrapper.text()).toContain('création de ce paiement')
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
    expect(wrapper.text()).toContain('Base amount')
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
