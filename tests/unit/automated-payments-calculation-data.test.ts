import { describe, expect, it, vi } from 'vitest'
import { calculateAutomatedPaymentFromDb, getPaymentMetadata, getPaymentCalculationEvidence, savePaymentMetadata, lockAutomatedPaymentAgreement } from '../../server/calculation-data'

const input = { agreementId: '1', commitmentType: '2', fiscalYearId: '3', paymentType: 'advance' as const, periodEnd: 4, currency: 'usd' }
const hostCalculation = {
  agreementId: '1', currency: 'usd', baseAmount: '200.01', commitmentRemaining: '150.99',
  availableBeforeHoldback: '170.00', holdbackReleaseAmount: '2.01', totalClaimsToLastClaimMonth: '120.10',
  totalForecastToLastClaimMonth: '100.10', totalForecastToPeriodEnd: '230.01', totalPaymentsToDate: '50.00',
  ceilingAmount: '150.99', suggestedAmount: '150.99', holdbackAmount: '10.00'
}
const evidence = {
  version: 1, capturedAt: '2026-10-09T12:00:00.000Z',
  input: { fiscalYearId: '3', commitmentTypeId: '2', paymentType: 'advance', periodEnd: 4, currency: 'usd' },
  calculation: { enabled: true, currency: 'USD', baseAmount: '200.01', ceilingAmount: '150.99', suggestedAmount: '150.99',
    holdbackAmount: '10.00', holdbackReleaseAmount: '2.01', availableBeforeHoldback: '170.00',
    details: [{ label: 'commitmentRemaining', value: '150.99' }] }
}
const queryDb = (row?: unknown) => {
  const query: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const method of ['selectFrom', 'select', 'where', 'set', 'values']) query[method] = vi.fn(() => query)
  query.executeTakeFirst = vi.fn(async () => row)
  query.execute = vi.fn(async () => undefined)
  const db = { selectFrom: vi.fn(() => query), updateTable: vi.fn(() => query), insertInto: vi.fn(() => query) }
  return { db, query }
}

describe('host-owned calculation consumption and retained evidence', () => {
  it('passes selection and release choices through the SDK and presents all eight host values exactly', async () => {
    const db = { selectFrom: vi.fn(() => { throw new Error('Financial source queries belong to the host') }) }
    const financials = { getPaymentCalculation: vi.fn(async () => hostCalculation) }
    const result = await calculateAutomatedPaymentFromDb(db as never, { ...input, releaseHoldback: true, holdbackReleaseAmount: '2.01', excludePaymentId: '90' }, {}, financials)
    expect(financials.getPaymentCalculation).toHaveBeenCalledExactlyOnceWith({ fiscalYearId: '3', commitmentTypeId: '2', currency: 'usd', paymentType: 'advance', periodEnd: 4, releaseHoldback: true, holdbackReleaseAmount: '2.01', excludePaymentId: '90' })
    expect(result).toMatchObject({ enabled: true, currency: 'USD', baseAmount: '200.01', ceilingAmount: '150.99' })
    expect(Object.fromEntries(result.details.map(detail => [detail.label, detail.value]))).toEqual({ baseAmount: '200.01', commitmentRemaining: '150.99', availableBeforeHoldback: '170.00', holdbackReleaseAmount: '2.01', totalClaimsToLastClaimMonth: '120.10', totalForecastToLastClaimMonth: '100.10', totalForecastToPeriodEnd: '230.01', totalPaymentsToDate: '50.00' })
    expect(db.selectFrom).not.toHaveBeenCalled()
  })
  it('preserves an aggregate beyond one money row without replacing the host ceiling', async () => {
    const financials = { getPaymentCalculation: vi.fn(async () => ({ ...hostCalculation, commitmentRemaining: '199999999999999999.98', ceilingAmount: '0.01' })) }
    const result = await calculateAutomatedPaymentFromDb({} as never, input, {}, financials)
    expect(result.details.find(detail => detail.label === 'commitmentRemaining')?.value).toBe('199999999999999999.98')
    expect(result.ceilingAmount).toBe('0.01')
  })
  it('returns disabled types before the SDK or database is used', async () => {
    const financials = { getPaymentCalculation: vi.fn() }
    expect(await calculateAutomatedPaymentFromDb({} as never, input, { enabledPaymentTypes: ['reimbursement'] }, financials)).toMatchObject({ enabled: false, currency: 'USD', details: [] })
    expect(financials.getPaymentCalculation).not.toHaveBeenCalled()
  })
  it('propagates host authorization, currency and financial-source failures without local fallback', async () => {
    const financials = { getPaymentCalculation: vi.fn(async () => { throw new Error('revoked') }) }
    await expect(calculateAutomatedPaymentFromDb({} as never, input, {}, financials)).rejects.toThrow('revoked')
  })
  it('rejects invalid release input before invoking the host', async () => {
    const financials = { getPaymentCalculation: vi.fn() }
    await expect(calculateAutomatedPaymentFromDb({} as never, { ...input, holdbackReleaseAmount: '1e2' }, {}, financials)).rejects.toThrow('money')
    expect(financials.getPaymentCalculation).not.toHaveBeenCalled()
  })
  it('creates extension-owned metadata with the retained calculation', async () => {
    const { db, query } = queryDb()
    const value = { releaseHoldback: true, holdbackReleaseAmount: '2.01', calculationEvidence: evidence }
    await savePaymentMetadata(db as never, '90', value)
    expect(db.insertInto).toHaveBeenCalledWith('extensions.kv_entry')
    expect(query.values).toHaveBeenCalledWith(expect.objectContaining({ owner_type: 'fundingcasepayment', owner_id: '90', config_key: 'payment-metadata', value }))
  })
  it('updates an existing KV entry rather than duplicating its owner key', async () => {
    const { db, query } = queryDb({ id: '100' })
    await savePaymentMetadata(db as never, '90', { calculationEvidence: evidence })
    expect(db.updateTable).toHaveBeenCalledWith('extensions.kv_entry')
    expect(query.where).toHaveBeenCalledWith('id', '=', '100')
    expect(db.insertInto).not.toHaveBeenCalled()
  })
  it.each([undefined, { value: null }, { value: {} }])('reports unavailable evidence for missing unauthored shape %j', async row => {
    const { db } = queryDb(row)
    expect(await getPaymentCalculationEvidence(db as never, '90')).toBeNull()
  })
  it.each([{ ...evidence, version: 2 }, { ...evidence, calculation: { ...evidence.calculation, baseAmount: '1e9' } }])('rejects corrupt or unsupported authored evidence %j', async snapshot => {
    const { db } = queryDb({ value: { calculationEvidence: snapshot } })
    await expect(getPaymentCalculationEvidence(db as never, '90')).rejects.toMatchObject({ code: 'GCS_AUTOMATED_PAYMENTS_EVIDENCE_INVALID' })
  })
  it('reads the persisted snapshot without a live calculation', async () => {
    const { db, query } = queryDb({ value: { calculationEvidence: evidence } })
    expect(await getPaymentCalculationEvidence(db as never, '90')).toEqual(evidence)
    expect(query.where).toHaveBeenCalledWith('owner_id', '=', '90')
  })
  it.each([undefined, { value: { releaseHoldback: false, holdbackReleaseAmount: '12.00' } }])('defaults unelected release metadata %j', async row => {
    const { db } = queryDb(row)
    expect(await getPaymentMetadata(db as never, '90')).toEqual({ releaseHoldback: false, holdbackReleaseAmount: '0.00' })
  })
  it('preserves an elected exact release for update validation', async () => {
    const { db } = queryDb({ value: { releaseHoldback: true, holdbackReleaseAmount: '2.01' } })
    expect(await getPaymentMetadata(db as never, '90')).toEqual({ releaseHoldback: true, holdbackReleaseAmount: '2.01' })
  })
  it('takes the Agreement advisory lock through the caller transaction', async () => {
    const executeQuery = vi.fn(async () => ({ rows: [] }))
    await lockAutomatedPaymentAgreement({ getExecutor: () => ({ transformQuery: (node: unknown) => node, compileQuery: () => ({ sql: 'lock', parameters: [] }), executeQuery }) } as never, '1')
    expect(executeQuery).toHaveBeenCalledOnce()
  })
})
