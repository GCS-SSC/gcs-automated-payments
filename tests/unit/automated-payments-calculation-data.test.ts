import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  calculateAutomatedPaymentFromDb,
  getAgreementHoldbackSettings,
  getPaymentMetadata,
  getSelectedPaymentPeriod,
  savePaymentMetadata
} from '../../server/calculation-data'

const recordedPaid = (amount = '0.00') => ({ agreementId: '1', cashPaidAmount: amount, jvEffectAmount: '0.00', correctionAmount: '0.00', accountReceivableRecoveryAmount: '0.00', recordedPaidAmount: amount, currency: 'cad' })
const financials = { getCommitmentPaymentCapacity: vi.fn(async () => ({ agreementId: '1', capacityAmount: '60.00' })),
  getRecordedPaidToDate: vi.fn(async () => recordedPaid()), getClaimRecoveryProjection: vi.fn(async () => ({agreementId:'1',entries:[]})) }

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
    if (table === 'Funding_Case_Agreement_Budget_Fiscal_Year' && !Array.isArray(value)) {
      const budgets = rows.Funding_Case_Agreement_Budget_Line_Item as Array<{ fiscal_year_order: number }> | undefined
      query.execute = vi.fn(async () => [value, ...(budgets ?? [])].filter(Boolean))
    }
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
      getQuerySource(source, 'getForecastRows', 'getBudgetTotals')
    ]

    for (const query of queries) {
      expect(query).toContain('stableBudgetFiscalYearId')
      expect(query).toContain(".innerJoin('Funding_Case_Agreement_Budget_Version'")
      expect(query).toContain(".where('Funding_Case_Agreement_Budget_Version.egcs_fc_iscurrent', '=', true)")
      expect(query).toContain(".where('Funding_Case_Agreement_Budget_Version._deleted', '=', false)")
    }
  })
  it('derives finalfiscal from the Agency enum independently of the custom basis code', async () => {
    const db = createQuery({
      egcs_fc_holdback: 12.5,
      egcs_fc_currency: 'cad', holdback_basis_type: 'finalfiscal'
    })

    await expect(getAgreementHoldbackSettings(db as never, 'agreement-1')).resolves.toEqual({
      holdbackPercent: 12.5,
      holdbackBasis: 'finalfiscal'
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

  it('uses fullagreement for that semantic type without comparing the foreign-key id', async () => {
    const db = createQuery({
      egcs_fc_holdback: '10',
      egcs_fc_currency: 'cad', holdback_basis_type: 'fullagreement'
    })

    await expect(getAgreementHoldbackSettings(db as never, 'agreement-1')).resolves.toEqual({
      holdbackPercent: 10,
      holdbackBasis: 'fullagreement'
    })
  })

  it('fails closed when the agreement basis does not resolve to a supported semantic type', async () => {
    const db = createQuery({
      egcs_fc_holdback: 10,
      egcs_fc_currency: 'cad', holdback_basis_type: 'custom-basis'
    })

    await expect(getAgreementHoldbackSettings(db as never, 'agreement-1')).rejects.toMatchObject({
      code: 'GCS_AUTOMATED_PAYMENTS_UNSUPPORTED_HOLDBACK_BASIS'
    })
  })

  it('collects claims and forecasts with host-provided paid and capacity for an enabled advance', async () => {
    const { db } = createCalculationDb({
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
        egcs_fc_holdback: '10', egcs_fc_currency: 'cad', holdback_basis_type: 'finalfiscal'
      },
      'extensions.kv_entry': [
        { value: { releaseHoldback: true, holdbackReleaseAmount: '2.00' } }
      ]
    })

    const result = await calculateAutomatedPaymentFromDb(db as never, {
      agreementId: '1', commitmentType: '2', fiscalYearId: '3',
      paymentType: 'advance', periodEnd: 4, excludePaymentId: '21',
      releaseHoldback: true, holdbackReleaseAmount: '3.00' as never
    }, { enabledPaymentTypes: ['advance'] }, financials)

    expect(result.enabled).toBe(true)
    expect(result.currency).toBe('CAD')
    expect(result.details.map(detail => detail.label)).toEqual(expect.arrayContaining([
      'baseAmount', 'commitmentRemaining', 'availableBeforeHoldback'
    ]))
    expect(db.selectFrom).not.toHaveBeenCalledWith('Funding_Case_Agreement_Payment')
    expect(financials.getCommitmentPaymentCapacity).toHaveBeenCalledWith({
      fiscalYearId: '3', commitmentTypeId: '2', currency: 'cad', excludePaymentId: '21'
    })
    expect(result.details.find(detail => detail.label === 'commitmentRemaining')?.value).toBe('60.00')
    expect(db.selectFrom).not.toHaveBeenCalledWith('Funding_Case_Agreement_Commitment_Line')
    expect(db.selectFrom).not.toHaveBeenCalledWith('Funding_Case_Agreement_Journal_Voucher_Line')
  })

  it('preserves an aggregate capacity beyond the persisted row range without duplicating host math', async () => {
    const { db } = createCalculationDb({
      Funding_Case_Agreement_Budget_Fiscal_Year: { fiscal_year_order: 2026 },
      Funding_Case_Agreement_Profile: { egcs_fc_holdback: 0, egcs_fc_currency: 'cad', holdback_basis_type: 'fullagreement' }
    })
    const financials = { getCommitmentPaymentCapacity: vi.fn(async () => ({ agreementId: '1', capacityAmount: '199999999999999999.98' })),
      getRecordedPaidToDate: vi.fn(async () => recordedPaid()), getClaimRecoveryProjection: vi.fn(async () => ({agreementId:'1',entries:[]})) }
    const result = await calculateAutomatedPaymentFromDb(db as never, {
      agreementId: '1', commitmentType: '2', fiscalYearId: '3', paymentType: 'advance', periodEnd: 4
    }, { enabledPaymentTypes: ['advance'] }, financials)
    expect(result.details.find(detail => detail.label === 'commitmentRemaining')?.value).toBe('199999999999999999.98')
    financials.getCommitmentPaymentCapacity.mockRejectedValueOnce(new Error('host capacity unavailable'))
    await expect(calculateAutomatedPaymentFromDb(db as never, {
      agreementId: '1', commitmentType: '2', fiscalYearId: '3', paymentType: 'advance', periodEnd: 4
    }, { enabledPaymentTypes: ['advance'] }, financials)).rejects.toThrow('host capacity unavailable')
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
        egcs_fc_holdback: 0, egcs_fc_currency: 'cad', holdback_basis_type: 'fullagreement'
      }
    })

    await expect(calculateAutomatedPaymentFromDb(db as never, {
      agreementId: '1', commitmentType: '2', fiscalYearId: '3',
      paymentType: 'reimbursement', periodEnd: 4
    }, { enabledPaymentTypes: ['reimbursement'] }, financials)).resolves.toMatchObject({ enabled: true })
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
        egcs_fc_holdback: undefined, egcs_fc_currency: 'cad', holdback_basis_type: 'fullagreement'
      }
    })

    await expect(calculateAutomatedPaymentFromDb(db as never, {
      agreementId: '1', commitmentType: '2', fiscalYearId: '3',
      paymentType: 'reimbursement', periodEnd: 4
    }, { enabledPaymentTypes: ['reimbursement'] }, financials)).rejects.toThrow('Database money must be selected as text.')
    expect(selectFrom).not.toHaveBeenCalledWith('Funding_Case_Agreement_Payment_Line')
    expect(selectFrom).not.toHaveBeenCalledWith('extensions.kv_entry')
  })

  it('uses corrected recorded paid-to-date independently of cash and shared capacity', async () => {
    const { db } = createCalculationDb({
      Funding_Case_Agreement_Budget_Fiscal_Year: { fiscal_year_order: 2026 },
      Funding_Case_Agreement_Claim_Reconcile_Line_Item: [{ amount: '50.00', month: 4, fiscal_year_order: 2026 }],
      Funding_Case_Agreement_Payment: [{ id: '20', amount: '20.00', month: 1, fiscal_year_order: 2026 }],
      Funding_Case_Agreement_Budget_Line_Item: [{ amount: '200.00', fiscal_year_order: 2026 }],
      Funding_Case_Agreement_Profile: { egcs_fc_holdback: 0, egcs_fc_currency: 'cad', holdback_basis_type: 'fullagreement' }
    })
    const totals = vi.fn(async () => ({ ...recordedPaid('20.00'), correctionAmount: '10.00', recordedPaidAmount: '30.00' }))
    const service = { ...financials, getRecordedPaidToDate: totals }
    const result = await calculateAutomatedPaymentFromDb(db as never, {
      agreementId: '1', commitmentType: '2', fiscalYearId: '3', paymentType: 'reimbursement', periodEnd: 4, excludePaymentId: '99'
    }, { enabledPaymentTypes: ['reimbursement'] }, service)
    expect(result.baseAmount).toBe('20.00')
    expect(totals).toHaveBeenCalledWith({ fiscalYearId: '3', periodEnd: 4, currency: 'cad', excludePaymentId: '99' })
    totals.mockRejectedValueOnce(new Error('corrected accounting unavailable'))
    await expect(calculateAutomatedPaymentFromDb(db as never, {
      agreementId: '1', commitmentType: '2', fiscalYearId: '3', paymentType: 'reimbursement', periodEnd: 4
    }, { enabledPaymentTypes: ['reimbursement'] }, service)).rejects.toThrow('corrected accounting unavailable')
  })


  it('applies successful Credit Memo reductions to the original Claim period and recorded paid independently', async () => {
    const {db,selectFrom} = createCalculationDb({
      Funding_Case_Agreement_Budget_Fiscal_Year:{fiscal_year_order:2026},
      Funding_Case_Agreement_Claim_Reconcile_Line_Item:[{amount:'100.00',month:1,fiscal_year_order:2026}],
      Funding_Case_Agreement_Budget_Line_Item:[{amount:'200.00',fiscal_year_order:2026}],
      Funding_Case_Agreement_Profile:{egcs_fc_holdback:0,egcs_fc_currency:'cad',holdback_basis_type:'fullagreement'}
    })
    const service = {
      getCommitmentPaymentCapacity:vi.fn(async()=>({agreementId:'1',capacityAmount:'40.00'})),
      getRecordedPaidToDate:vi.fn(async()=>({...recordedPaid('80.00'),accountReceivableRecoveryAmount:'-20.00',recordedPaidAmount:'60.00'})),
      getClaimRecoveryProjection:vi.fn(async()=>({agreementId:'1',entries:[
        {claimLineId:'10',fiscalYearOrder:'2026',month:1,currency:'cad',amount:'-20.00'},
        {claimLineId:'11',fiscalYearOrder:'2026',month:1,currency:'usd',amount:'-999.00'},
        {claimLineId:'12',fiscalYearOrder:'2027',month:1,currency:'cad',amount:'-10.00'}
      ]}))
    }
    const result=await calculateAutomatedPaymentFromDb(db as never,{agreementId:'1',commitmentType:'2',fiscalYearId:'3',paymentType:'reimbursement',periodEnd:3,excludePaymentId:'99'}, {enabledPaymentTypes:['reimbursement']},service)
    const details=Object.fromEntries(result.details.map(detail=>[detail.label,detail.value]))
    expect(result.baseAmount).toBe('20.00')
    expect(details.totalClaimsToLastClaimMonth).toBe('80.00')
    expect(details.totalPaymentsToDate).toBe('60.00')
    expect(details.commitmentRemaining).toBe('40.00')
    expect(service.getClaimRecoveryProjection).toHaveBeenCalledExactlyOnceWith()
    expect(service.getRecordedPaidToDate).toHaveBeenCalledExactlyOnceWith({fiscalYearId:'3',periodEnd:3,currency:'cad',excludePaymentId:'99'})
    expect(selectFrom).not.toHaveBeenCalledWith('Funding_Case_Account_Receivable_Posting')
    expect(selectFrom).not.toHaveBeenCalledWith('Funding_Case_Account_Receivable_Allocation')
  })
  it('leaves Claims unchanged for an outstanding-advance Credit Memo while consuming reduced paid', async () => {
    const {db}=createCalculationDb({Funding_Case_Agreement_Budget_Fiscal_Year:{fiscal_year_order:2026},Funding_Case_Agreement_Claim_Reconcile_Line_Item:[{amount:'100.00',month:1,fiscal_year_order:2026}],Funding_Case_Agreement_Profile:{egcs_fc_holdback:0,egcs_fc_currency:'cad',holdback_basis_type:'fullagreement'}})
    const service={...financials,getRecordedPaidToDate:vi.fn(async()=>({...recordedPaid('80.00'),accountReceivableRecoveryAmount:'-20.00',recordedPaidAmount:'60.00'}))}
    const result=await calculateAutomatedPaymentFromDb(db as never,{agreementId:'1',commitmentType:'2',fiscalYearId:'3',paymentType:'reimbursement',periodEnd:3},{enabledPaymentTypes:['reimbursement']},service)
    const details=Object.fromEntries(result.details.map(detail=>[detail.label,detail.value]))
    expect(details.totalClaimsToLastClaimMonth).toBe('100.00')
    expect(details.totalPaymentsToDate).toBe('60.00')
    expect(result.baseAmount).toBe('40.00')
  })
  it('fails closed when the SDK Claim recovery projection cannot be read', async () => {
    const {db}=createCalculationDb({Funding_Case_Agreement_Budget_Fiscal_Year:{fiscal_year_order:2026},Funding_Case_Agreement_Profile:{egcs_fc_holdback:0,egcs_fc_currency:'cad',holdback_basis_type:'fullagreement'}})
    const service={...financials,getClaimRecoveryProjection:vi.fn(async()=>{throw new Error('AR Claim projection unavailable')})}
    await expect(calculateAutomatedPaymentFromDb(db as never,{agreementId:'1',commitmentType:'2',fiscalYearId:'3',paymentType:'reimbursement',periodEnd:3},{enabledPaymentTypes:['reimbursement']},service)).rejects.toThrow('AR Claim projection unavailable')
  })

  it('returns a disabled result before any database access', async () => {
    const db = { selectFrom: vi.fn() }
    await expect(calculateAutomatedPaymentFromDb(db as never, {
      agreementId: '1', commitmentType: '2', fiscalYearId: '3',
      paymentType: 'advance', periodEnd: 4
    }, { enabledPaymentTypes: ['reimbursement'] }, financials)).resolves.toEqual(expect.objectContaining({
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

  it.each([undefined, '', 'USD'])('rejects an Agreement with missing or invalid native currency %s', async currency => {
    const { db } = createCalculationDb({ Funding_Case_Agreement_Profile: {
      egcs_fc_holdback: 10, holdback_basis_type: 'fullagreement', egcs_fc_currency: currency
    } })
    const services = { getCommitmentPaymentCapacity: vi.fn(), getRecordedPaidToDate: vi.fn(), getClaimRecoveryProjection: vi.fn() }
    await expect(calculateAutomatedPaymentFromDb(db as never, {
      agreementId: '1', commitmentType: '2', fiscalYearId: '3', currency: 'cad', paymentType: 'advance', periodEnd: 0
    }, {}, services)).rejects.toMatchObject({ code: 'GCS_AUTOMATED_PAYMENTS_CURRENCY_INVALID' })
    expect(services.getRecordedPaidToDate).not.toHaveBeenCalled()
    expect(services.getCommitmentPaymentCapacity).not.toHaveBeenCalled()
  })

  it('rejects a requested currency different from the immutable Agreement before reading amounts', async () => {
    const { db, queries } = createCalculationDb({ Funding_Case_Agreement_Profile: {
      egcs_fc_holdback: 10, holdback_basis_type: 'fullagreement', egcs_fc_currency: 'cad'
    } })
    const services = { getCommitmentPaymentCapacity: vi.fn(), getRecordedPaidToDate: vi.fn(), getClaimRecoveryProjection: vi.fn() }
    await expect(calculateAutomatedPaymentFromDb(db as never, {
      agreementId: '1', commitmentType: '2', fiscalYearId: '3', currency: 'usd', paymentType: 'advance', periodEnd: 0
    }, {}, services)).rejects.toMatchObject({ code: 'GCS_AUTOMATED_PAYMENTS_CURRENCY_MISMATCH' })
    expect(services.getRecordedPaidToDate).not.toHaveBeenCalled()
    expect(services.getCommitmentPaymentCapacity).not.toHaveBeenCalled()
    expect([...queries.keys()]).toEqual(['Funding_Case_Agreement_Profile'])
  })

  it('passes the selected native currency to source filters and both SDK financial services', async () => {
    const { db, queries } = createCalculationDb({
      Funding_Case_Agreement_Budget_Fiscal_Year: { fiscal_year_order: 2026 },
      Funding_Case_Agreement_Claim_Reconcile_Line_Item: [{ amount: '100.01', month: 1, fiscal_year_order: 2026 }],
      Funding_Case_Agreement_Forecast_Line_Item: [{ amount: '170.04', month: 1, fiscal_year_order: 2026 },
        { amount: '90.03', month: 3, fiscal_year_order: 2026 }, { amount: '70.02', month: 8, fiscal_year_order: 2026 }],
      Funding_Case_Agreement_Budget_Line_Item: [{ amount: '125.55', fiscal_year_order: 2026 }, { amount: '84.46', fiscal_year_order: 2027 }],
      Funding_Case_Agreement_Profile: { egcs_fc_holdback: 10, egcs_fc_currency: 'usd', holdback_basis_type: 'fullagreement' }
    })
    const service = { getClaimRecoveryProjection: vi.fn(async () => ({agreementId:'1',entries:[]})), getCommitmentPaymentCapacity: vi.fn(async () => ({ agreementId: '1', capacityAmount: '75.01' })),
      getRecordedPaidToDate: vi.fn(async () => ({ ...recordedPaid('20.02'), currency: 'usd' })) }
    const result = await calculateAutomatedPaymentFromDb(db as never, {
      agreementId: '1', commitmentType: '2', fiscalYearId: '3', currency: 'usd', paymentType: 'advance', periodEnd: 3
    }, { enabledPaymentTypes: ['advance'] }, service)
    expect(result).toMatchObject({ currency: 'USD', baseAmount: '170.02', ceilingAmount: '75.01', holdbackAmount: '21.00', availableBeforeHoldback: '303.50' })
    expect(service.getRecordedPaidToDate).toHaveBeenCalledExactlyOnceWith({ fiscalYearId: '3', periodEnd: 3, currency: 'usd' })
    expect(service.getCommitmentPaymentCapacity).toHaveBeenCalledExactlyOnceWith({ fiscalYearId: '3', commitmentTypeId: '2', currency: 'usd' })
    expect(queries.get('Funding_Case_Agreement_Claim_Reconcile_Line_Item')?.where).toHaveBeenCalledWith('Funding_Case_Agreement_Claim_Line_Item.egcs_fc_currency', '=', 'usd')
    expect(queries.get('Funding_Case_Agreement_Claim_Reconcile_Line_Item')?.where).toHaveBeenCalledWith('Funding_Case_Agreement_Claim_Line_Item._deleted', '=', false)
    expect(queries.get('Funding_Case_Agreement_Forecast_Line_Item')?.where).toHaveBeenCalledWith('Funding_Case_Agreement_Forecast_Line_Item.egcs_fc_currency', '=', 'usd')
    expect(queries.get('Funding_Case_Agreement_Budget_Line_Item')?.where).toHaveBeenCalledWith('Funding_Case_Agreement_Budget_Line_Item.egcs_fc_currency', '=', 'usd')
  })

  it('retains USD for empty selected-currency paid rows and rejects a mismatched SDK paid currency', async () => {
    const { db } = createCalculationDb({
      Funding_Case_Agreement_Budget_Fiscal_Year: { fiscal_year_order: 2026 },
      Funding_Case_Agreement_Forecast_Line_Item: [{ amount: '100.00', month: 0, fiscal_year_order: 2026 }],
      Funding_Case_Agreement_Budget_Line_Item: [{ amount: '100.00', fiscal_year_order: 2026 }],
      Funding_Case_Agreement_Profile: { egcs_fc_holdback: 10, egcs_fc_currency: 'usd', holdback_basis_type: 'fullagreement' }
    })
    const service = { getClaimRecoveryProjection: vi.fn(async () => ({agreementId:'1',entries:[]})), getCommitmentPaymentCapacity: vi.fn(async () => ({ agreementId: '1', capacityAmount: '100.00' })),
      getRecordedPaidToDate: vi.fn(async () => ({ ...recordedPaid(), currency: null as string | null })) }
    const input = { agreementId: '1', commitmentType: '2', fiscalYearId: '3', currency: 'usd', paymentType: 'advance' as const, periodEnd: 0 }
    await expect(calculateAutomatedPaymentFromDb(db as never, input, {}, service)).resolves.toMatchObject({ currency: 'USD', ceilingAmount: '90.00' })
    service.getRecordedPaidToDate.mockResolvedValueOnce({ ...recordedPaid('20.00'), currency: 'cad' })
    await expect(calculateAutomatedPaymentFromDb(db as never, input, {}, service)).rejects.toMatchObject({ code: 'GCS_AUTOMATED_PAYMENTS_CURRENCY_MISMATCH' })
    service.getRecordedPaidToDate.mockResolvedValueOnce({ ...recordedPaid('20.00'), currency: null })
    await expect(calculateAutomatedPaymentFromDb(db as never, input, {}, service)).rejects.toMatchObject({ code: 'GCS_AUTOMATED_PAYMENTS_CURRENCY_MISMATCH' })
  })

  it('returns a disabled selected-currency result without a paid fallback or source query', async () => {
    const db = { selectFrom: vi.fn() }
    await expect(calculateAutomatedPaymentFromDb(db as never, {
      agreementId: '1', commitmentType: '2', fiscalYearId: '3', currency: 'usd', paymentType: 'advance', periodEnd: 0
    }, { enabledPaymentTypes: [] }, financials)).resolves.toMatchObject({ enabled: false, currency: 'USD', ceilingAmount: '0.00' })
    expect(db.selectFrom).not.toHaveBeenCalled()
  })
})
