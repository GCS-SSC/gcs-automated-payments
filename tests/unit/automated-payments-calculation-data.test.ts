import { money } from '../fixtures/money'
import { AutomatedPaymentCalculationEvidenceSchema } from '../../shared/automated-payments'
import { describe, expect, it, vi } from 'vitest'
import { createGcsExtensionUserError } from '@gcs-ssc/extensions/server'
import { calculateAutomatedPaymentFromDb, getPaymentMetadata, getPaymentCalculationEvidence, savePaymentMetadata, lockAutomatedPaymentAgreement } from '../../server/calculation-data'

const agencyConfig = { creditMemoBasis: 'reconciled-periods' }
const input = { agreementId: '1', commitmentType: '2', fiscalYearId: '3', paymentType: 'advance' as const, periodStart: 1, periodEnd: 4, currency: 'usd' }
const hostCalculation = {
  agreementId: '1', currency: 'usd', commitmentRemaining: money('150.99', 'USD'),
  availableForDisbursementBeforeHoldback: money('180.00', 'USD'), totalClaimsToLastClaimMonth: money('120.10', 'USD'),
  totalForecastToLastClaimMonth: money('100.10', 'USD'), totalForecastToPeriodEnd: money('230.01', 'USD'), totalPaymentsToDate: money('50.00', 'USD'),
  totalCreditMemos: money('0.00', 'USD'), totalCreditMemosForReconciledPeriods: money('0.00', 'USD'), agreementTotal: money('100.00', 'USD'), finalFiscalYearTotal: money('100.00', 'USD'),
  holdbackPercent: '10', holdbackBasis: 'fullagreement' as const
}
const evidence = {
  version: 3, capturedAt: '2026-10-09T12:00:00.000Z',
  input: { fiscalYearId: '3', commitmentTypeId: '2', paymentType: 'advance', periodStart: 1, periodEnd: 4, currency: 'usd', creditMemoBasis: 'reconciled-periods' },
  calculation: { enabled: true, currency: 'USD', baseAmount: money('200.01', 'USD'), ceilingAmount: money('150.99', 'USD'), suggestedAmount: money('150.99', 'USD'),
    holdbackAmount: money('10.00', 'USD'), holdbackReleaseAmount: money('2.01', 'USD'), availableBeforeHoldback: money('170.00', 'USD'),
    details: [{ label: 'commitmentRemaining', value: money('150.99', 'USD') }], explanation: [{ label: 'explanation.payment_limits', rows: [{ label: 'explanation.commitment', value: money('150.99', 'USD') }], total: { label: 'explanation.maximum', value: money('150.99', 'USD') } }] }
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
    const result = await calculateAutomatedPaymentFromDb(db as never, { ...input, releaseHoldback: true, holdbackReleaseAmount: money('2.01', 'USD'), excludePaymentId: '90' }, {}, financials, agencyConfig)
    expect(financials.getPaymentCalculation).toHaveBeenCalledExactlyOnceWith({ fiscalYearId: '3', commitmentTypeId: '2', currency: 'usd', paymentType: 'advance', periodStart: 1, periodEnd: 4, releaseHoldback: true, holdbackReleaseAmount: money('2.01', 'USD'), excludePaymentId: '90' })
    expect(result).toMatchObject({ enabled: true, currency: 'USD', baseAmount: money('200.01', 'USD'), ceilingAmount: money('150.99', 'USD') })
    expect(Object.fromEntries(result.details.map(detail => [detail.label, detail.value]))).toEqual({ baseAmount: money('200.01', 'USD'), commitmentRemaining: money('150.99', 'USD'), availableBeforeHoldback: money('170.00', 'USD'), holdbackReleaseAmount: money('2.01', 'USD'), totalClaimsToLastClaimMonth: money('120.10', 'USD'), totalForecastToLastClaimMonth: money('100.10', 'USD'), totalForecastToPeriodEnd: money('230.01', 'USD'), totalPaymentsToDate: money('50.00', 'USD'), totalCreditMemos: money('0.00', 'USD'), totalCreditMemosForReconciledPeriods: money('0.00', 'USD') })
    expect(db.selectFrom).not.toHaveBeenCalled()
  })
  it('preserves an aggregate beyond one money row with a one-cent entitlement', async () => {
    const financials = { getPaymentCalculation: vi.fn(async () => ({ ...hostCalculation, commitmentRemaining: money('199999999999999999.98', 'USD'), totalPaymentsToDate: money('250.00', 'USD') })) }
    const result = await calculateAutomatedPaymentFromDb({} as never, input, {}, financials, agencyConfig)
    expect(result.details.find(detail => detail.label === 'commitmentRemaining')?.value).toEqual(money('199999999999999999.98', 'USD'))
    expect(result.ceilingAmount).toEqual(money('0.01', 'USD'))
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
      totalClaimsToLastClaimMonth: money('2000.00', 'USD'), totalForecastToLastClaimMonth: money('3000.00', 'USD'), totalForecastToPeriodEnd: money('9000.00', 'USD'),
      totalPaymentsToDate: money('5500.00', 'USD'), totalCreditMemos: money('1000.00', 'USD'), totalCreditMemosForReconciledPeriods: money('500.00', 'USD'),
      commitmentRemaining: money('7500.00', 'USD'), availableForDisbursementBeforeHoldback: money('6500.00', 'USD'), holdbackPercent: '0' })) }
    const result = await calculateAutomatedPaymentFromDb({} as never, input, {}, financials, { creditMemoBasis })
    expect(result).toMatchObject({ ceilingAmount: money(ceiling, 'USD'), availableBeforeHoldback: money(available, 'USD') })
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
    await expect(calculateAutomatedPaymentFromDb({} as never, { ...input, holdbackReleaseAmount: { amount: '1e2', currency: 'USD' } as never }, {}, financials, agencyConfig)).rejects.toThrow()
    expect(financials.getPaymentCalculation).not.toHaveBeenCalled()
  })
  it('creates extension-owned metadata with the retained calculation', async () => {
    const { db, query } = queryDb()
    const value = { releaseHoldback: true, holdbackReleaseAmount: money('2.01', 'USD'), calculationEvidence: evidence }
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
  it('retains current version-3 arithmetic and exact percentages after live financial inputs change', async () => {
    const financials = { getPaymentCalculation: vi.fn(async () => hostCalculation) }
    const calculation = await calculateAutomatedPaymentFromDb({} as never, { ...input, excludePaymentId: '90' }, {}, financials, agencyConfig)
    const snapshot = { version: 3, capturedAt: evidence.capturedAt,
      input: { ...evidence.input, periodStart: 1, creditMemoBasis: 'reconciled-periods' }, calculation }
    const { db } = queryDb({ value: { calculationEvidence: snapshot } })
    financials.getPaymentCalculation.mockResolvedValue({ ...hostCalculation, totalPaymentsToDate: money('9999.00', 'USD') })
    const saved = await getPaymentCalculationEvidence(db as never, '90')
    expect(saved).toEqual(snapshot)
    expect(financials.getPaymentCalculation).toHaveBeenCalledTimes(1)
    expect(calculation.explanation![1]!.rows[1]).toEqual({ label: 'explanation.holdback_rate', value: '10', operator: '×', format: 'percent' })
    expect(calculation.explanation!.at(-1)!.notes).toEqual(['explanation.limited_commitment'])
    const invalid = [
      { ...snapshot, input: { ...snapshot.input, fiscalYearId: '0' } },
      { ...snapshot, input: { ...snapshot.input, commitmentTypeId: '9223372036854775808' } },
      { ...snapshot, input: { ...snapshot.input, periodStart: 5 } },
      { ...snapshot, calculation: { ...calculation, currency: 'CAD' } },
      ...['101.00', '-0.01', '1e1', 10].map(value => ({ ...snapshot, calculation: { ...calculation,
        explanation: [{ ...calculation.explanation![1], rows: [{ label: 'explanation.holdback_rate', value, format: 'percent' }] }] } })),
      { ...snapshot, calculation: { ...calculation, explanation: [{ ...calculation.explanation![0], label: 'host.private_label' }] } },
      { ...snapshot, calculation: { ...calculation, explanation: [] } }
    ]
    for (const value of invalid) expect(AutomatedPaymentCalculationEvidenceSchema.safeParse(value).success).toBe(false)
  })
  it('reads the persisted snapshot without a live calculation', async () => {
    const snapshot = { ...evidence, calculation: { ...evidence.calculation, details: [
      { label: 'baseAmount', value: money('200.01', 'USD') }, { label: 'commitmentRemaining', value: money('150.99', 'USD') },
      { label: 'availableBeforeHoldback', value: money('170.00', 'USD') }, { label: 'holdbackReleaseAmount', value: money('2.01', 'USD') },
      { label: 'totalClaimsToLastClaimMonth', value: money('120.10', 'USD') }, { label: 'totalForecastToLastClaimMonth', value: money('100.10', 'USD') },
      { label: 'totalForecastToPeriodEnd', value: money('230.01', 'USD') }, { label: 'totalPaymentsToDate', value: money('50.00', 'USD') },
      { label: 'totalCreditMemos', value: money('0.00', 'USD') }] } }
    const { db, query } = queryDb({ value: { calculationEvidence: snapshot } })
    expect(await getPaymentCalculationEvidence(db as never, '90')).toEqual(snapshot)
    expect(query.where).toHaveBeenCalledWith('owner_id', '=', '90')
  })
  it('reads the full selected period and reconciled-period credits from new evidence', async () => {
    const snapshot = { ...evidence, input: { ...evidence.input, periodStart: 1 },
      calculation: { ...evidence.calculation, details: [...evidence.calculation.details,
        { label: 'totalCreditMemos', value: money('1000.00', 'USD') }, { label: 'totalCreditMemosForReconciledPeriods', value: money('500.00', 'USD') }] } }
    const { db } = queryDb({ value: { calculationEvidence: snapshot } })
    expect(await getPaymentCalculationEvidence(db as never, '90')).toEqual(snapshot)
  })
  it('rejects the retired eligible-credit evidence shape after the clean cutover', async () => {
    const snapshot = { ...evidence, input: { ...evidence.input, periodStart: 1 },
      calculation: { ...evidence.calculation, details: [...evidence.calculation.details,
        { label: 'totalCreditMemos', value: money('1000.00', 'USD') }, { label: 'totalCreditMemosForPayment', value: money('500.00', 'USD') }] } }
    const { db } = queryDb({ value: { calculationEvidence: snapshot } })
    await expect(getPaymentCalculationEvidence(db as never, '90')).rejects.toMatchObject({ code: 'GCS_AUTOMATED_PAYMENTS_EVIDENCE_INVALID' })
  })
  it.each([undefined, { value: { releaseHoldback: false, holdbackReleaseAmount: money('12.00', 'USD') } }])('defaults unelected release metadata %j', async row => {
    const { db } = queryDb(row)
    expect(await getPaymentMetadata(db as never, '90')).toEqual({ releaseHoldback: false })
  })
  it('preserves an elected exact release for update validation', async () => {
    const { db } = queryDb({ value: { releaseHoldback: true, holdbackReleaseAmount: money('2.01', 'USD') } })
    expect(await getPaymentMetadata(db as never, '90')).toEqual({ releaseHoldback: true, holdbackReleaseAmount: money('2.01', 'USD') })
  })
  it('takes the Agreement advisory lock through the caller transaction', async () => {
    const executeQuery = vi.fn(async () => ({ rows: [] }))
    await lockAutomatedPaymentAgreement({ getExecutor: () => ({ transformQuery: (node: unknown) => node, compileQuery: () => ({ sql: 'lock', parameters: [] }), executeQuery }) } as never, '1')
    expect(executeQuery).toHaveBeenCalledOnce()
  })
})
