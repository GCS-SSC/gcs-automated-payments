import { afterAll, describe, expect, it, vi } from 'vitest'
import { calculateAutomatedPaymentFromDb } from '../../server/calculation-data'
import { writeScenarioCsvReport, type ScenarioReportRow } from '../fixtures/scenario-report'

type PeriodAmount = { amount: string, month: number, fiscal_year_order: number }
type Scenario = {
  name: string
  paymentType: 'advance' | 'reimbursement'
  claims: PeriodAmount[]
  forecasts: PeriodAmount[]
  budgets: Array<{ amount: string, fiscal_year_order: number }>
  cashPaid: string
  jvEffect?: string
  correction?: string
  recordedPaid: string
  capacity: string
  holdbackPercent?: number
  fiscalYears?: number[]
  holdbackBasis?: 'fullagreement' | 'finalfiscal'
  periodEnd?: number
  excludePaymentId?: string
  expected: {
    claims: string
    forecastToClaim: string
    forecastToPeriod: string
    holdback: string
    available: string
    base: string
    ceiling: string
  }
}

const at = (amount: string, month: number, fiscal_year_order = 2026): PeriodAmount => ({ amount, month, fiscal_year_order })
const currentBudget = [{ amount: '1000.00', fiscal_year_order: 2026 }]

// The expected values are authored from each ledger, independent of the calculator.
const scenarios: Scenario[] = [
  {
    name: 'first advance with no reconciled claims', paymentType: 'advance',
    claims: [], forecasts: [at('100.00', 0), at('200.00', 3), at('700.00', 8)],
    budgets: currentBudget, cashPaid: '100.00', recordedPaid: '100.00', capacity: '900.00', holdbackPercent: 10,
    expected: { claims: '0.00', forecastToClaim: '0.00', forecastToPeriod: '300.00', holdback: '100.00', available: '800.00', base: '200.00', ceiling: '200.00' }
  },
  {
    name: 'advance underpayment after lower claims replace forecast', paymentType: 'advance',
    claims: [at('200.00', 1)], forecasts: [at('300.00', 1), at('200.00', 3), at('500.00', 8)],
    budgets: currentBudget, cashPaid: '100.00', recordedPaid: '100.00', capacity: '900.00', holdbackPercent: 10,
    expected: { claims: '200.00', forecastToClaim: '300.00', forecastToPeriod: '500.00', holdback: '100.00', available: '700.00', base: '300.00', ceiling: '300.00' }
  },
  {
    name: 'advance overpayment exceeds reconciled claims and later forecast', paymentType: 'advance',
    claims: [at('200.00', 1)], forecasts: [at('300.00', 1), at('200.00', 3), at('500.00', 8)],
    budgets: currentBudget, cashPaid: '550.00', recordedPaid: '550.00', capacity: '450.00', holdbackPercent: 10,
    expected: { claims: '200.00', forecastToClaim: '300.00', forecastToPeriod: '500.00', holdback: '100.00', available: '250.00', base: '0.00', ceiling: '0.00' }
  },
  {
    name: 'reimbursement underpayment with remaining holdback', paymentType: 'reimbursement',
    claims: [at('600.00', 3)], forecasts: [at('600.00', 3)], budgets: currentBudget,
    cashPaid: '400.00', recordedPaid: '400.00', capacity: '600.00', holdbackPercent: 10,
    expected: { claims: '600.00', forecastToClaim: '600.00', forecastToPeriod: '600.00', holdback: '100.00', available: '100.00', base: '200.00', ceiling: '100.00' }
  },
  {
    name: 'reimbursement underpayment with no holdback', paymentType: 'reimbursement',
    claims: [at('600.00', 3)], forecasts: [at('600.00', 3)], budgets: currentBudget,
    cashPaid: '400.00', recordedPaid: '400.00', capacity: '600.00',
    expected: { claims: '600.00', forecastToClaim: '600.00', forecastToPeriod: '600.00', holdback: '0.00', available: '200.00', base: '200.00', ceiling: '200.00' }
  },
  {
    name: 'reimbursement overpayment from prior advances creates no new disbursement', paymentType: 'reimbursement',
    claims: [at('200.00', 3)], forecasts: [at('600.00', 3), at('400.00', 8)], budgets: currentBudget,
    cashPaid: '400.00', recordedPaid: '400.00', capacity: '600.00', holdbackPercent: 10,
    expected: { claims: '200.00', forecastToClaim: '600.00', forecastToPeriod: '600.00', holdback: '100.00', available: '100.00', base: '0.00', ceiling: '0.00' }
  },
  {
    name: 'positive recorded-paid Correction reduces reimbursement independently of cash', paymentType: 'reimbursement',
    claims: [at('600.00', 3)], forecasts: [], budgets: currentBudget,
    cashPaid: '400.00', correction: '50.00', recordedPaid: '450.00', capacity: '550.00', holdbackPercent: 10,
    expected: { claims: '600.00', forecastToClaim: '0.00', forecastToPeriod: '0.00', holdback: '100.00', available: '50.00', base: '150.00', ceiling: '50.00' }
  },
  {
    name: 'negative recorded-paid Correction increases reimbursement independently of cash', paymentType: 'reimbursement',
    claims: [at('600.00', 3)], forecasts: [], budgets: currentBudget,
    cashPaid: '400.00', correction: '-50.00', recordedPaid: '350.00', capacity: '650.00', holdbackPercent: 10,
    expected: { claims: '600.00', forecastToClaim: '0.00', forecastToPeriod: '0.00', holdback: '100.00', available: '150.00', base: '250.00', ceiling: '150.00' }
  },
  {
    name: 'balanced same-year JV leaves paid unchanged while its coding pool limits capacity', paymentType: 'reimbursement',
    claims: [at('600.00', 3)], forecasts: [], budgets: currentBudget,
    cashPaid: '400.00', jvEffect: '0.00', recordedPaid: '400.00', capacity: '49.99',
    expected: { claims: '600.00', forecastToClaim: '0.00', forecastToPeriod: '0.00', holdback: '0.00', available: '200.00', base: '200.00', ceiling: '49.99' }
  },
  {
    name: 'outgoing cross-year JV increases selected-period shortfall', paymentType: 'reimbursement',
    claims: [at('600.00', 3)], forecasts: [], budgets: currentBudget,
    cashPaid: '400.00', jvEffect: '-50.00', recordedPaid: '350.00', capacity: '650.00',
    expected: { claims: '600.00', forecastToClaim: '0.00', forecastToPeriod: '0.00', holdback: '0.00', available: '250.00', base: '250.00', ceiling: '250.00' }
  },
  {
    name: 'incoming cross-year JV and Correction retain each sign', paymentType: 'reimbursement',
    claims: [at('600.00', 3)], forecasts: [], budgets: currentBudget,
    cashPaid: '400.00', jvEffect: '100.00', correction: '-25.01', recordedPaid: '474.99', capacity: '525.01',
    expected: { claims: '600.00', forecastToClaim: '0.00', forecastToPeriod: '0.00', holdback: '0.00', available: '125.01', base: '125.01', ceiling: '125.01' }
  },
  {
    name: 'shared duplicate-coding capacity cannot be reconstructed by summing cash lines', paymentType: 'advance',
    claims: [at('200.00', 1)], forecasts: [at('300.00', 1), at('200.00', 3), at('500.00', 8)], budgets: currentBudget,
    cashPaid: '100.00', recordedPaid: '100.00', capacity: '99.99',
    expected: { claims: '200.00', forecastToClaim: '300.00', forecastToPeriod: '500.00', holdback: '0.00', available: '800.00', base: '300.00', ceiling: '99.99' }
  },
  {
    name: 'exhausted commitment prevents an otherwise eligible reimbursement', paymentType: 'reimbursement',
    claims: [at('600.00', 3)], forecasts: [], budgets: currentBudget,
    cashPaid: '400.00', recordedPaid: '400.00', capacity: '0.00',
    expected: { claims: '600.00', forecastToClaim: '0.00', forecastToPeriod: '0.00', holdback: '0.00', available: '200.00', base: '200.00', ceiling: '0.00' }
  },
  {
    name: 'future-year funding and finalfiscal holdback affect reserve, not current capacity', paymentType: 'advance',
    claims: [at('200.00', 1)], forecasts: [at('300.00', 1), at('200.00', 3), at('500.00', 8), at('400.00', 1, 2027)],
    budgets: [...currentBudget, { amount: '400.00', fiscal_year_order: 2027 }],
    cashPaid: '100.00', recordedPaid: '100.00', capacity: '900.00', holdbackPercent: 10, holdbackBasis: 'finalfiscal',
    expected: { claims: '200.00', forecastToClaim: '300.00', forecastToPeriod: '500.00', holdback: '40.00', available: '1160.00', base: '300.00', ceiling: '300.00' }
  },
  {
    name: 'earlier-year claims replace earlier forecasts before the new fiscal-year advance', paymentType: 'advance',
    claims: [at('300.00', 11, 2025)], forecasts: [at('350.00', 11, 2025), at('100.00', 0), at('200.00', 3)],
    budgets: [{ amount: '400.00', fiscal_year_order: 2025 }, { amount: '600.00', fiscal_year_order: 2026 }],
    cashPaid: '300.00', recordedPaid: '300.00', capacity: '600.00', holdbackPercent: 10, holdbackBasis: 'finalfiscal',
    expected: { claims: '300.00', forecastToClaim: '350.00', forecastToPeriod: '650.00', holdback: '60.00', available: '240.00', base: '300.00', ceiling: '240.00' }
  },
  {
    name: 'claims after the selected month and in later years do not change the claim cutoff', paymentType: 'advance',
    claims: [at('200.00', 1), at('800.00', 8), at('400.00', 1, 2027)],
    forecasts: [at('300.00', 1), at('200.00', 3), at('500.00', 8)], budgets: currentBudget,
    cashPaid: '100.00', recordedPaid: '100.00', capacity: '900.00', holdbackPercent: 10,
    expected: { claims: '200.00', forecastToClaim: '300.00', forecastToPeriod: '500.00', holdback: '100.00', available: '700.00', base: '300.00', ceiling: '300.00' }
  },
  {
    name: 'overlapping claim periods remain additive at their end month', paymentType: 'reimbursement',
    claims: [at('120.10', 1), at('79.90', 1), at('100.01', 3)], forecasts: [at('250.00', 1), at('100.00', 3)],
    budgets: currentBudget, cashPaid: '200.00', recordedPaid: '200.00', capacity: '800.00',
    expected: { claims: '300.01', forecastToClaim: '350.00', forecastToPeriod: '350.00', holdback: '0.00', available: '100.01', base: '100.01', ceiling: '100.01' }
  },
  {
    name: 'editing excludes current Payment while retaining independently posted Corrections', paymentType: 'reimbursement',
    claims: [at('600.00', 3)], forecasts: [], budgets: currentBudget,
    cashPaid: '300.00', jvEffect: '0.00', correction: '25.00', recordedPaid: '325.00', capacity: '675.00', excludePaymentId: '99',
    expected: { claims: '600.00', forecastToClaim: '0.00', forecastToPeriod: '0.00', holdback: '0.00', available: '275.00', base: '275.00', ceiling: '275.00' }
  },
  {
    name: 'fractional holdback is floored to dollars while reimbursement remains cents', paymentType: 'reimbursement',
    claims: [at('100.01', 3)], forecasts: [], budgets: [{ amount: '100.01', fiscal_year_order: 2026 }],
    cashPaid: '0.10', recordedPaid: '0.10', capacity: '99.91', holdbackPercent: 12.5,
    expected: { claims: '100.01', forecastToClaim: '0.00', forecastToPeriod: '0.00', holdback: '12.00', available: '87.91', base: '99.91', ceiling: '87.91' }
  },
  {
    name: 'aggregate claims and paid beyond one row retain a one-cent shortfall', paymentType: 'reimbursement',
    claims: [at('99999999999999999.99', 3), at('99999999999999999.99', 3)], forecasts: [],
    budgets: [{ amount: '99999999999999999.99', fiscal_year_order: 2026 }, { amount: '99999999999999999.99', fiscal_year_order: 2026 }],
    cashPaid: '199999999999999999.97', recordedPaid: '199999999999999999.97', capacity: '0.01',
    expected: { claims: '199999999999999999.98', forecastToClaim: '0.00', forecastToPeriod: '0.00', holdback: '0.00', available: '0.01', base: '0.01', ceiling: '0.01' }
  },
  {
    name: 'empty final Agreement FY yields zero finalfiscal holdback instead of using preceding funded FY', paymentType: 'advance',
    claims: [], forecasts: [at('100.01', 3)], budgets: [{ amount: '100.01', fiscal_year_order: 2026 }], fiscalYears: [2026, 2027],
    cashPaid: '0.00', recordedPaid: '0.00', capacity: '100.01', holdbackPercent: 10, holdbackBasis: 'finalfiscal',
    expected: { claims: '0.00', forecastToClaim: '0.00', forecastToPeriod: '100.01', holdback: '0.00', available: '100.01', base: '100.01', ceiling: '100.01' }
  }
]

const calculationFixture = (scenario: Scenario) => {
  const tableRows: Record<string, unknown> = {
    Funding_Case_Agreement_Budget_Fiscal_Year: [...new Set(scenario.fiscalYears ?? [2026, ...scenario.budgets.map(budget => budget.fiscal_year_order)])].map(fiscal_year_order => ({ fiscal_year_order })),
    Funding_Case_Agreement_Claim_Reconcile_Line_Item: scenario.claims,
    Funding_Case_Agreement_Forecast_Line_Item: scenario.forecasts,
    Funding_Case_Agreement_Payment: [],
    Funding_Case_Agreement_Budget_Line_Item: scenario.budgets,
    Funding_Case_Agreement_Profile: [{ egcs_fc_currency: 'cad', egcs_fc_holdback: scenario.holdbackPercent ?? 0, holdback_basis_type: scenario.holdbackBasis ?? 'fullagreement' }]
  }
  const selectFrom = vi.fn((table: string) => {
    const query: Record<string, unknown> = {}
    for (const method of ['innerJoin', 'select', 'where']) query[method] = vi.fn(() => query)
    query.execute = vi.fn(async () => tableRows[table] ?? [])
    query.executeTakeFirst = vi.fn(async () => (tableRows[table] as unknown[])?.[0])
    return query
  })
  const service = {
    getCommitmentPaymentCapacity: vi.fn(async () => ({ agreementId: '1', capacityAmount: scenario.capacity })),
    getRecordedPaidToDate: vi.fn(async () => ({
      agreementId: '1', currency: 'cad', cashPaidAmount: scenario.cashPaid,
      jvEffectAmount: scenario.jvEffect ?? '0.00', correctionAmount: scenario.correction ?? '0.00',
      recordedPaidAmount: scenario.recordedPaid
    }))
  }
  return { db: { selectFrom }, selectFrom, service }
}

describe('automated payment independently authored financial scenarios', () => {
  const report: ScenarioReportRow[] = []
  afterAll(() => writeScenarioCsvReport('extension-unit-scenarios.csv', report))

  it.each(scenarios)('$name', async scenario => {
    const { db, selectFrom, service } = calculationFixture(scenario)
    const periodEnd = scenario.periodEnd ?? 3
    const result = await calculateAutomatedPaymentFromDb(db as never, {
      agreementId: '1', commitmentType: '2', fiscalYearId: '3', paymentType: scenario.paymentType,
      periodEnd, ...(scenario.excludePaymentId ? { excludePaymentId: scenario.excludePaymentId } : {})
    }, { enabledPaymentTypes: ['advance', 'reimbursement'] }, service)

    expect(result).toMatchObject({ enabled: true, currency: 'CAD', baseAmount: scenario.expected.base,
      holdbackAmount: scenario.expected.holdback, availableBeforeHoldback: scenario.expected.available,
      ceilingAmount: scenario.expected.ceiling, suggestedAmount: scenario.expected.ceiling })
    expect(Object.fromEntries(result.details.map(detail => [detail.label, detail.value]))).toMatchObject({
      totalClaimsToLastClaimMonth: scenario.expected.claims,
      totalForecastToLastClaimMonth: scenario.expected.forecastToClaim,
      totalForecastToPeriodEnd: scenario.expected.forecastToPeriod,
      totalPaymentsToDate: scenario.recordedPaid,
      commitmentRemaining: scenario.capacity
    })
    expect(service.getCommitmentPaymentCapacity).toHaveBeenCalledExactlyOnceWith({
      fiscalYearId: '3', commitmentTypeId: '2', currency: 'cad', ...(scenario.excludePaymentId ? { excludePaymentId: scenario.excludePaymentId } : {})
    })
    expect(service.getRecordedPaidToDate).toHaveBeenCalledExactlyOnceWith({
      fiscalYearId: '3', periodEnd, currency: 'cad', ...(scenario.excludePaymentId ? { excludePaymentId: scenario.excludePaymentId } : {})
    })
    expect(selectFrom).not.toHaveBeenCalledWith('Funding_Case_Agreement_Commitment_Line')
    expect(selectFrom).not.toHaveBeenCalledWith('Funding_Case_Agreement_Journal_Voucher_Line')
    expect(selectFrom).not.toHaveBeenCalledWith('Funding_Case_Agreement_Correction_Entry')
    const actual = Object.fromEntries(result.details.map(detail => [detail.label, detail.value]))
    report.push({
      scenario_id: `extension-unit-${String(scenarios.indexOf(scenario) + 1).padStart(2, '0')}`,
      scenario: scenario.name, test_layer: 'extension unit ledger', status: 'passed',
      agreement_id: '1', selected_fiscal_year: 2026, selected_fiscal_year_id: '3', period_end: periodEnd,
      currency: 'CAD',
      payment_type: scenario.paymentType, excluded_payment_id: scenario.excludePaymentId,
      commitments_by_fy: 'SDK capacity fixture; no physical Commitment rows', commitment_capacity: scenario.capacity,
      budgets_by_fy: JSON.stringify(scenario.budgets),
      current_agreement_fiscal_years: JSON.stringify(scenario.fiscalYears ?? [...new Set(scenario.budgets.map(budget => budget.fiscal_year_order))]),
      original_claims_by_fy_month: 'Raw claims are not the calculator source; use successful reconciled amounts',
      reconciliations_by_fy_month: JSON.stringify(scenario.claims), forecast_by_fy_month: JSON.stringify(scenario.forecasts),
      cash_paid_to_date: scenario.cashPaid, jv_effect_to_date: scenario.jvEffect ?? '0.00',
      correction_to_date: scenario.correction ?? '0.00', corrected_recorded_paid_to_date: scenario.recordedPaid,
      holdback_basis: scenario.holdbackBasis ?? 'fullagreement', holdback_percentage: scenario.holdbackPercent ?? 0,
      holdback_release_requested: '0.00',
      expected_claims_to_cutoff: scenario.expected.claims, actual_claims_to_cutoff: actual.totalClaimsToLastClaimMonth,
      expected_forecast_to_claim: scenario.expected.forecastToClaim, actual_forecast_to_claim: actual.totalForecastToLastClaimMonth,
      expected_forecast_to_period: scenario.expected.forecastToPeriod, actual_forecast_to_period: actual.totalForecastToPeriodEnd,
      expected_base: scenario.expected.base, actual_base: result.baseAmount,
      expected_holdback: scenario.expected.holdback, actual_holdback: result.holdbackAmount,
      expected_ordinary_available: scenario.expected.available, actual_ordinary_available: result.availableBeforeHoldback,
      expected_ceiling: scenario.expected.ceiling, actual_ceiling: result.ceilingAmount, actual_suggested: result.suggestedAmount,
      actual_holdback_release: result.holdbackReleaseAmount
    })
  })
})
