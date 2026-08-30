import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  calculateAutomatedPaymentFromDb,
  getAgreementHoldbackSettings,
  getPaymentMetadata,
  getSelectedPaymentPeriod,
  savePaymentMetadata
} from '../../server/calculation-data'

const calculationDataPath = new URL('../../server/calculation-data.ts', import.meta.url)

const getQuerySource = (source: string, functionName: string, nextFunctionName: string): string => {
  const start = source.indexOf(`const ${functionName} =`)
  const end = source.indexOf(`const ${nextFunctionName} =`, start)

  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)

  return source.slice(start, end)
}

const createQuery = (row: Record<string, unknown> | undefined) => {
  const query: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const method of ['selectFrom', 'innerJoin', 'select', 'where', 'set', 'values']) {
    query[method] = vi.fn(() => query)
  }
  query.executeTakeFirst = vi.fn().mockResolvedValue(row)
  query.execute = vi.fn().mockResolvedValue(row)
  return query
}

const createCalculationDb = (rows: Record<string, unknown>) => {
  const queries = new Map<string, ReturnType<typeof createQuery>>()
  const selectFrom = vi.fn((table: string) => {
    const value = rows[table]
    const query = createQuery(Array.isArray(value) ? value[0] as Record<string, unknown> | undefined : value as Record<string, unknown> | undefined)
    query.execute = vi.fn(async () => Array.isArray(value) ? value : value === undefined ? [] : [value])
    queries.set(table, query)
    return query
  })
  return { db: { selectFrom }, queries, selectFrom }
}

describe('automated payment calculation data', () => {
  it('rejects a fiscal year outside the agreement current budget instead of calculating against year zero', async () => {
    const db = createQuery(undefined)

    await expect(getSelectedPaymentPeriod(db as never, 'agreement-1', 'other-fy', 3)).rejects.toMatchObject({
      code: 'GCS_AUTOMATED_PAYMENTS_FISCAL_YEAR_UNAVAILABLE',
      details: [expect.objectContaining({ path: 'egcs_fc_fiscalyear' })]
    })
  })

  it('scopes stable fiscal-year joins to the current agreement budget version', async () => {
    const source = await readFile(calculationDataPath, 'utf8')
    const queries = [
      getQuerySource(source, 'getSelectedPaymentPeriod', 'getClaimRows'),
      getQuerySource(source, 'getClaimRows', 'getLastClaimPosition'),
      getQuerySource(source, 'getForecastRows', 'getPaymentRows'),
      getQuerySource(source, 'getPaymentRows', 'getHoldbackReleasedToDate'),
      getQuerySource(source, 'getCommitmentRemaining', 'getBudgetTotals')
    ]

    for (const query of queries) {
      expect(query).toContain('stableBudgetFiscalYearId')
      expect(query).toContain(".innerJoin('Funding_Case_Agreement_Budget_Version'")
      expect(query).toContain(".where('Funding_Case_Agreement_Budget_Version.egcs_fc_iscurrent', '=', true)")
      expect(query).toContain(".where('Funding_Case_Agreement_Budget_Version._deleted', '=', false)")
    }
  })
  it('derives final-fiscal-year from the agency language-independent code', async () => {
    const db = createQuery({
      egcs_fc_holdback: 12.5,
      holdback_basis_code: 'final-fiscal-year'
    })

    await expect(getAgreementHoldbackSettings(db as never, 'agreement-1')).resolves.toEqual({
      holdbackPercent: 12.5,
      holdbackBasis: 'final-fiscal-year'
    })
    expect(db.innerJoin).toHaveBeenCalledWith(
      'Transfer_Payment_Stream_Holdback_Basis',
      'Transfer_Payment_Stream_Holdback_Basis.id',
      'Funding_Case_Agreement_Profile.egcs_fc_holdbackbasis'
    )
    expect(db.innerJoin).toHaveBeenCalledWith(
      'Agency_Holdback_Basis',
      'Agency_Holdback_Basis.id',
      'Transfer_Payment_Stream_Holdback_Basis.egcs_tp_agencyholdback'
    )
  })

  it('uses agreement-total for that semantic code without comparing the foreign-key id', async () => {
    const db = createQuery({
      egcs_fc_holdback: '10',
      holdback_basis_code: 'agreement-total'
    })

    await expect(getAgreementHoldbackSettings(db as never, 'agreement-1')).resolves.toEqual({
      holdbackPercent: 10,
      holdbackBasis: 'agreement-total'
    })
  })

  it('fails closed when the agreement basis does not resolve to a supported semantic code', async () => {
    const db = createQuery({
      egcs_fc_holdback: 10,
      holdback_basis_code: 'custom-basis'
    })

    await expect(getAgreementHoldbackSettings(db as never, 'agreement-1')).rejects.toMatchObject({
      code: 'GCS_AUTOMATED_PAYMENTS_UNSUPPORTED_HOLDBACK_BASIS'
    })
  })

  it('collects every persisted financial source and calculates an enabled advance ceiling', async () => {
    const { db, queries } = createCalculationDb({
      Funding_Case_Agreement_Budget_Fiscal_Year: { fiscal_year_order: 2026 },
      Funding_Case_Agreement_Claim_Reconcile_Line_Item: [
        { amount: '10.00', month: 2, fiscal_year_order: 2026 },
        { amount: '5.00', month: 3, fiscal_year_order: 2026 },
        { amount: '99.00', month: 1, fiscal_year_order: 2027 }
      ],
      Funding_Case_Agreement_Forecast_Line_Item: [
        { amount: '4.00', month: 1, fiscal_year_order: 2026 },
        { amount: '8.00', month: 4, fiscal_year_order: 2026 }
      ],
      Funding_Case_Agreement_Payment: [
        { id: 20, amount: '2.00', month: 1, fiscal_year_order: 2026 },
        { id: 21, amount: '3.00', month: 5, fiscal_year_order: 2026 }
      ],
      Funding_Case_Agreement_Commitment_Line: [
        { id: 30, amount: '50.00' },
        { id: 31, amount: '20.00' }
      ],
      Funding_Case_Agreement_Payment_Line: [{ amount: '10.00' }],
      Funding_Case_Agreement_Budget_Line_Item: [
        { amount: '100.00', fiscal_year_order: 2026 },
        { amount: '50.00', fiscal_year_order: 2027 }
      ],
      Funding_Case_Agreement_Profile: {
        egcs_fc_holdback: '10', holdback_basis_code: 'final-fiscal-year'
      },
      'extensions.kv_entry': [
        { value: { releaseHoldback: true, holdbackReleaseAmount: '2.00' } }
      ]
    })

    const result = await calculateAutomatedPaymentFromDb(db as never, {
      agreementId: '1', commitmentType: '2', fiscalYearId: '3',
      paymentType: 'advance', periodEnd: 4, excludePaymentId: '21',
      releaseHoldback: true, holdbackReleaseAmount: '3.00' as never
    }, { enabledPaymentTypes: ['advance'] })

    expect(result.enabled).toBe(true)
    expect(result.currency).toBe('CAD')
    expect(result.details.map(detail => detail.label)).toEqual(expect.arrayContaining([
      'baseAmount', 'commitmentRemaining', 'availableBeforeHoldback'
    ]))
    expect(queries.get('Funding_Case_Agreement_Payment')?.where)
      .toHaveBeenCalledWith('Funding_Case_Agreement_Payment.id', '!=', '21')
  })

  it('handles no prior claims, payments, or commitment value without optional queries', async () => {
    const { db, selectFrom } = createCalculationDb({
      Funding_Case_Agreement_Budget_Fiscal_Year: { fiscal_year_order: 2026 },
      Funding_Case_Agreement_Claim_Reconcile_Line_Item: [],
      Funding_Case_Agreement_Forecast_Line_Item: [{ amount: '8.00', month: 4, fiscal_year_order: 2026 }],
      Funding_Case_Agreement_Payment: [],
      Funding_Case_Agreement_Commitment_Line: [],
      Funding_Case_Agreement_Budget_Line_Item: [],
      Funding_Case_Agreement_Profile: {
        egcs_fc_holdback: 0, holdback_basis_code: 'agreement-total'
      }
    })

    await expect(calculateAutomatedPaymentFromDb(db as never, {
      agreementId: '1', commitmentType: '2', fiscalYearId: '3',
      paymentType: 'reimbursement', periodEnd: 4
    }, { enabledPaymentTypes: ['reimbursement'] })).resolves.toMatchObject({ enabled: true })
    expect(selectFrom).not.toHaveBeenCalledWith('Funding_Case_Agreement_Payment_Line')
    expect(selectFrom).not.toHaveBeenCalledWith('extensions.kv_entry')
  })

  it('rejects a raw numeric driver value instead of silently losing exact money', async () => {
    const { db, selectFrom } = createCalculationDb({
      Funding_Case_Agreement_Budget_Fiscal_Year: { fiscal_year_order: 2026 },
      Funding_Case_Agreement_Claim_Reconcile_Line_Item: [
        { amount: undefined, month: undefined, fiscal_year_order: undefined },
        { amount: 2, month: 1, fiscal_year_order: 2025 },
        { amount: 3, month: 2, fiscal_year_order: 2026 },
        { amount: 4, month: 3, fiscal_year_order: 2026 }
      ],
      Funding_Case_Agreement_Forecast_Line_Item: [
        { amount: undefined, month: undefined, fiscal_year_order: undefined }
      ],
      Funding_Case_Agreement_Payment: [
        { id: undefined, amount: undefined, month: undefined, fiscal_year_order: undefined }
      ],
      Funding_Case_Agreement_Commitment_Line: [{ id: undefined, amount: 5 }],
      Funding_Case_Agreement_Budget_Line_Item: [{ amount: undefined, fiscal_year_order: undefined }],
      Funding_Case_Agreement_Profile: {
        egcs_fc_holdback: undefined, holdback_basis_code: 'agreement-total'
      }
    })

    await expect(calculateAutomatedPaymentFromDb(db as never, {
      agreementId: '1', commitmentType: '2', fiscalYearId: '3',
      paymentType: 'reimbursement', periodEnd: 4
    }, { enabledPaymentTypes: ['reimbursement'] })).rejects.toThrow('Database money must be selected as text.')
    expect(selectFrom).not.toHaveBeenCalledWith('Funding_Case_Agreement_Payment_Line')
    expect(selectFrom).not.toHaveBeenCalledWith('extensions.kv_entry')
  })

  it('returns a disabled result before any database access', async () => {
    const db = { selectFrom: vi.fn() }
    await expect(calculateAutomatedPaymentFromDb(db as never, {
      agreementId: '1', commitmentType: '2', fiscalYearId: '3',
      paymentType: 'advance', periodEnd: 4
    }, { enabledPaymentTypes: ['reimbursement'] })).resolves.toEqual(expect.objectContaining({
      enabled: false, ceilingAmount: '0.00', details: []
    }))
    expect(db.selectFrom).not.toHaveBeenCalled()
  })

  it('creates and updates metadata and parses a missing or persisted payload', async () => {
    const missing = createQuery(undefined)
    const inserted = createQuery(undefined)
    const insertDb = {
      selectFrom: vi.fn(() => missing),
      insertInto: vi.fn(() => inserted)
    }
    await savePaymentMetadata(insertDb as never, '1', { releaseHoldback: true })
    expect(inserted.values).toHaveBeenCalledWith(expect.objectContaining({ owner_id: '1' }))

    const existing = createQuery({ id: 2 })
    const updated = createQuery(undefined)
    const updateDb = {
      selectFrom: vi.fn(() => existing),
      updateTable: vi.fn(() => updated)
    }
    await savePaymentMetadata(updateDb as never, '1', { releaseHoldback: false })
    expect(updated.set).toHaveBeenCalledWith({ value: { releaseHoldback: false } })
    expect(updated.where).toHaveBeenCalledWith('id', '=', '2')

    await expect(getPaymentMetadata(createQuery(undefined) as never, '1')).resolves.toEqual({
      releaseHoldback: false, holdbackReleaseAmount: '0.00'
    })
    await expect(getPaymentMetadata(createQuery({
      value: { releaseHoldback: true, holdbackReleaseAmount: '4.5' }
    }) as never, '1')).resolves.toEqual({ releaseHoldback: true, holdbackReleaseAmount: '4.50' })
  })

  it('returns the selected period when the stable fiscal year is available', async () => {
    await expect(getSelectedPaymentPeriod(createQuery({ fiscal_year_order: '2027' }) as never, '1', '2', 6))
      .resolves.toEqual({ fiscalYearOrder: 2027, month: 6 })
  })
})
