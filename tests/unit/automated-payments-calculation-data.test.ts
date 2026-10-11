import { describe, expect, it, vi } from 'vitest'
import { createGcsExtensionUserError } from '@gcs-ssc/extensions/server'
import { calculateAutomatedPaymentFromDb, getPaymentMetadata, getPaymentCalculationEvidence, savePaymentMetadata, lockAutomatedPaymentAgreement } from '../../server/calculation-data'

const agencyConfig = { creditMemoBasis: 'reconciled-periods' }
const input = { agreementId: '1', commitmentType: '2', fiscalYearId: '3', paymentType: 'advance' as const, periodStart: 1, periodEnd: 4, currency: 'usd' }
const hostCalculation = {
  agreementId: '1', currency: 'usd', commitmentRemaining: '150.99',
  availableForDisbursementBeforeHoldback: '180.00', totalClaimsToLastClaimMonth: '120.10',
  totalForecastToLastClaimMonth: '100.10', totalForecastToPeriodEnd: '230.01', totalPaymentsToDate: '50.00',
  totalCreditMemos: '0.00', totalCreditMemosForReconciledPeriods: '0.00', agreementTotal: '100.00', finalFiscalYearTotal: '100.00',
  holdbackPercent: '10', holdbackBasis: 'fullagreement' as const
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

describe('host financial inputs and extension calculation and retained evidence', () => {
  it('passes the full period and release choices through the SDK and presents all ten values exactly', async () => {
    const db = { selectFrom: vi.fn(() => { throw new Error('Financial source queries belong to the host') }) }
    const financials = { getPaymentCalculation: vi.fn(async () => hostCalculation) }
    const result = await calculateAutomatedPaymentFromDb(db as never, { ...input, releaseHoldback: true, holdbackReleaseAmount: '2.01', excludePaymentId: '90' }, {}, financials, agencyConfig)
    expect(financials.getPaymentCalculation).toHaveBeenCalledExactlyOnceWith({ fiscalYearId: '3', commitmentTypeId: '2', currency: 'usd', paymentType: 'advance', periodStart: 1, periodEnd: 4, releaseHoldback: true, holdbackReleaseAmount: '2.01', excludePaymentId: '90' })
    expect(result).toMatchObject({ enabled: true, currency: 'USD', baseAmount: '200.01', ceilingAmount: '150.99' })
    expect(Object.fromEntries(result.details.map(detail => [detail.label, detail.value]))).toEqual({ baseAmount: '200.01', commitmentRemaining: '150.99', availableBeforeHoldback: '170.00', holdbackReleaseAmount: '2.01', totalClaimsToLastClaimMonth: '120.10', totalForecastToLastClaimMonth: '100.10', totalForecastToPeriodEnd: '230.01', totalPaymentsToDate: '50.00', totalCreditMemos: '0.00', totalCreditMemosForReconciledPeriods: '0.00' })
    expect(db.selectFrom).not.toHaveBeenCalled()
  })
  it('preserves an aggregate beyond one money row with a one-cent entitlement', async () => {
    const financials = { getPaymentCalculation: vi.fn(async () => ({ ...hostCalculation, commitmentRemaining: '199999999999999999.98', totalPaymentsToDate: '250.00' })) }
    const result = await calculateAutomatedPaymentFromDb({} as never, input, {}, financials, agencyConfig)
    expect(result.details.find(detail => detail.label === 'commitmentRemaining')?.value).toBe('199999999999999999.98')
    expect(result.ceilingAmount).toBe('0.01')
  })
  it('returns disabled types before the SDK or database is used', async () => {
    const financials = { getPaymentCalculation: vi.fn() }
    expect(await calculateAutomatedPaymentFromDb({} as never, input, { enabledPaymentTypes: ['reimbursement'] }, financials, agencyConfig)).toMatchObject({ enabled: false, currency: 'USD', details: [] })
    expect(financials.getPaymentCalculation).not.toHaveBeenCalled()
  })
  it.each([undefined, {}, { creditMemoBasis: null }, { creditMemoBasis: 'other' }])('requires an explicit valid agency choice before calculating: %j', async settings => {
    const financials = { getPaymentCalculation: vi.fn() }
    await expect(calculateAutomatedPaymentFromDb({} as never, input, {}, financials, settings)).rejects.toMatchObject({
      code: 'GCS_AUTOMATED_PAYMENTS_CREDIT_MEMO_BASIS_REQUIRED', localizedMessage: { en: expect.any(String), fr: expect.any(String) },
      details: [expect.objectContaining({ path: 'creditMemoBasis' })] })
    expect(financials.getPaymentCalculation).not.toHaveBeenCalled()
  })
  it.each([['all', '3500.00', '6500.00'], ['reconciled-periods', '3000.00', '6000.00']])('uses the agency choice %s for entitlement and availability', async (creditMemoBasis, ceiling, available) => {
    const financials = { getPaymentCalculation: vi.fn(async () => ({ ...hostCalculation,
      totalClaimsToLastClaimMonth: '2000.00', totalForecastToLastClaimMonth: '3000.00', totalForecastToPeriodEnd: '9000.00',
      totalPaymentsToDate: '5500.00', totalCreditMemos: '1000.00', totalCreditMemosForReconciledPeriods: '500.00',
      commitmentRemaining: '7500.00', availableForDisbursementBeforeHoldback: '6500.00', holdbackPercent: '0' })) }
    const result = await calculateAutomatedPaymentFromDb({} as never, input, {}, financials, { creditMemoBasis })
    expect(result).toMatchObject({ ceilingAmount: ceiling, availableBeforeHoldback: available })
  })
  it('propagates host authorization and financial-source failures without local fallback', async () => {
    const financials = { getPaymentCalculation: vi.fn(async () => { throw new Error('revoked') }) }
    await expect(calculateAutomatedPaymentFromDb({} as never, input, {}, financials, agencyConfig)).rejects.toThrow('revoked')
  })
  it('translates only the structured host denomination conflict into its localized field error', async () => {
    const financials = { getPaymentCalculation: vi.fn().mockRejectedValue(createGcsExtensionUserError({
      code: 'AGREEMENT_CURRENCY_MISMATCH', message: 'Bound currency conflict'
    })) }
    await expect(calculateAutomatedPaymentFromDb({} as never, input, {}, financials, agencyConfig)).rejects.toMatchObject({
      code: 'GCS_AUTOMATED_PAYMENTS_CURRENCY_MISMATCH', statusCode: 400,
      localizedMessage: { en: expect.any(String), fr: expect.any(String) },
      details: [expect.objectContaining({ path: 'egcs_fc_currency' })]
    })
    const forbidden = createGcsExtensionUserError({ code: 'FORBIDDEN', statusCode: 403, message: 'revoked' })
    financials.getPaymentCalculation.mockRejectedValueOnce(forbidden)
    await expect(calculateAutomatedPaymentFromDb({} as never, input, {}, financials, agencyConfig)).rejects.toBe(forbidden)
    const unstructured = new Error('The selected currency must match the bound Agreement currency.')
    financials.getPaymentCalculation.mockRejectedValueOnce(unstructured)
    await expect(calculateAutomatedPaymentFromDb({} as never, input, {}, financials, agencyConfig)).rejects.toBe(unstructured)
  })
  it('rejects invalid release input before invoking the host', async () => {
    const financials = { getPaymentCalculation: vi.fn() }
    await expect(calculateAutomatedPaymentFromDb({} as never, { ...input, holdbackReleaseAmount: '1e2' }, {}, financials, agencyConfig)).rejects.toThrow('money')
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
    const snapshot = { ...evidence, calculation: { ...evidence.calculation, details: [
      { label: 'baseAmount', value: '200.01' }, { label: 'commitmentRemaining', value: '150.99' },
      { label: 'availableBeforeHoldback', value: '170.00' }, { label: 'holdbackReleaseAmount', value: '2.01' },
      { label: 'totalClaimsToLastClaimMonth', value: '120.10' }, { label: 'totalForecastToLastClaimMonth', value: '100.10' },
      { label: 'totalForecastToPeriodEnd', value: '230.01' }, { label: 'totalPaymentsToDate', value: '50.00' },
      { label: 'totalCreditMemos', value: '0.00' }] } }
    const { db, query } = queryDb({ value: { calculationEvidence: snapshot } })
    expect(await getPaymentCalculationEvidence(db as never, '90')).toEqual(snapshot)
    expect(query.where).toHaveBeenCalledWith('owner_id', '=', '90')
  })
  it('reads the full selected period and reconciled-period credits from new evidence', async () => {
    const snapshot = { ...evidence, input: { ...evidence.input, periodStart: 1 },
      calculation: { ...evidence.calculation, details: [...evidence.calculation.details,
        { label: 'totalCreditMemos', value: '1000.00' }, { label: 'totalCreditMemosForReconciledPeriods', value: '500.00' }] } }
    const { db } = queryDb({ value: { calculationEvidence: snapshot } })
    expect(await getPaymentCalculationEvidence(db as never, '90')).toEqual(snapshot)
  })
  it('retains the previous eligible-credit policy result in immutable evidence without relabeling or recalculating it', async () => {
    const snapshot = { ...evidence, input: { ...evidence.input, periodStart: 1 },
      calculation: { ...evidence.calculation, details: [...evidence.calculation.details,
        { label: 'totalCreditMemos', value: '1000.00' }, { label: 'totalCreditMemosForPayment', value: '500.00' }] } }
    const { db } = queryDb({ value: { calculationEvidence: snapshot } })
    expect(await getPaymentCalculationEvidence(db as never, '90')).toEqual(snapshot)
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
