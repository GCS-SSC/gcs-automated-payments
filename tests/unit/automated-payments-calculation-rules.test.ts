import { describe, expect, it } from 'vitest'
import type { GcsExtensionPaymentCalculationResult } from '@gcs-ssc/extensions/server'
import type { AutomatedPaymentCreditMemoBasis } from '../../shared/automated-payments'
import { calculateAutomatedPaymentValues } from '../../server/payment-calculation'
import { parseCurrencyMoney, moneyFromMinorUnits, type Money } from '@gcs-ssc/extensions/money'
const money = (value: string, currency = 'USD') => parseCurrencyMoney(value, currency)
type AgreementPaymentCalculationValues = Omit<GcsExtensionPaymentCalculationResult, 'holdbackPercent' | 'holdbackBasis'> & { paymentType: 'advance' | 'reimbursement', releaseHoldback?: boolean, holdbackReleaseAmount?: Money }
const calculateAgreementPaymentValues = (values: AgreementPaymentCalculationValues, settings: Pick<GcsExtensionPaymentCalculationResult, 'holdbackPercent' | 'holdbackBasis'>, creditMemoBasis: AutomatedPaymentCreditMemoBasis = 'reconciled-periods') => calculateAutomatedPaymentValues({ ...values, ...settings }, values, creditMemoBasis)
const defaults: AgreementPaymentCalculationValues = {
  agreementId: '1', currency: 'usd', paymentType: 'reimbursement',
  totalClaimsToLastClaimMonth: money('1000.00'), totalPaymentsToDate: money('0.00'), totalCreditMemos: money('0.00'), totalCreditMemosForReconciledPeriods: money('0.00'),
  totalForecastToLastClaimMonth: money('0.00'), totalForecastToPeriodEnd: money('0.00'),
  commitmentRemaining: money('1000.00'), agreementTotal: money('1000.00'), finalFiscalYearTotal: money('1000.00'),
  availableForDisbursementBeforeHoldback: money('1000.00')
}
describe('extension Payment exact entitlement and holdback rules', () => {
  it.each([
    ['0.15', '10', '0.00'], ['19.99', '5', '0.00'], ['20.00', '5', '1.00'], ['20.01', '5', '1.00'],
    ['100.01', '12.5', '12.00'], ['999.99', '12.34', '123.00'], ['9999.99', '0.01', '0.00'],
    ['10000.00', '0.01', '1.00'], ['99999999999999999.99', '100', '99999999999999999.00'],
    ['199999999999999999.98', '12.5', '24999999999999999.00'], ['199999999999999999.98', '0', '0.00']
  ])('rounds %s at %s percent down to %s', (basis, percent, expected) => {
    expect(calculateAgreementPaymentValues({ ...defaults, agreementTotal: money(basis!) }, { holdbackPercent: percent!, holdbackBasis: 'fullagreement' }).holdbackAmount).toEqual(money(expected!))
  })
  it.each(['-1', '100.01', 'NaN', 'Infinity', '0.001'])('rejects invalid holdback percentage %s', percent => {
    expect(() => calculateAgreementPaymentValues(defaults, { holdbackPercent: percent, holdbackBasis: 'fullagreement' })).toThrow()
  })
  it.each([
    ['0.00','1000.00','0.00','900.00','0.00','900.00'], ['700.00','300.00','50.00','200.00','50.00','250.00'],
    ['950.00','50.00','0.00','0.00','0.00','0.00'], ['950.00','50.00','25.00','0.00','25.00','25.00'],
    ['950.00','50.00','100.00','0.00','50.00','50.00'], ['1000.00','0.00','100.00','0.00','0.00','0.00'],
    ['1000.01','-0.01','100.00','0.00','0.00','0.00']
  ])('reserves the last unpaid balance at paid %s, unpaid %s and requested release %s', (paid, unpaid, requested, ordinary, release, ceiling) => {
    const result = calculateAgreementPaymentValues({ ...defaults, totalPaymentsToDate: money(paid!), availableForDisbursementBeforeHoldback: money(unpaid!), releaseHoldback: true, holdbackReleaseAmount: money(requested!) }, { holdbackPercent: '10', holdbackBasis: 'fullagreement' })
    expect(result).toMatchObject({ currency: 'USD', holdbackAmount: money('100.00', 'USD'), availableBeforeHoldback: money(ordinary!), holdbackReleaseAmount: money(release!), ceilingAmount: money(ceiling!) })
  })
  it('retains exact payments and aggregate inputs above the old row envelope', () => {
    const aggregate = money('199999999999999999.98')
    const result = calculateAgreementPaymentValues({ ...defaults, totalClaimsToLastClaimMonth: aggregate, commitmentRemaining: aggregate, agreementTotal: aggregate, availableForDisbursementBeforeHoldback: aggregate }, { holdbackPercent: '0', holdbackBasis: 'fullagreement' })
    expect(result.baseAmount).toEqual(aggregate)
    expect(result.ceilingAmount).toEqual(aggregate)
  })
  it('rejects negative funding basis and ignores unelected releases', () => {
    expect(() => calculateAgreementPaymentValues({ ...defaults, agreementTotal: money('-1') }, { holdbackPercent: '10', holdbackBasis: 'fullagreement' })).toThrow()
    expect(calculateAgreementPaymentValues({ ...defaults, holdbackReleaseAmount: money('100.00') }, { holdbackPercent: '10', holdbackBasis: 'fullagreement' }).holdbackReleaseAmount).toEqual(money('0.00', 'USD'))
  })
  it.each(['advance', 'reimbursement'] as const)('subtracts reconciled-period credits from paid once for %s', paymentType => {
    const result = calculateAgreementPaymentValues({ ...defaults, paymentType,
      totalClaimsToLastClaimMonth: money(paymentType === 'advance' ? '0.00' : '3000.00'),
      totalForecastToPeriodEnd: money('3000.00'), totalPaymentsToDate: money('3000.00'),
      totalCreditMemos: money('500.00'), totalCreditMemosForReconciledPeriods: money('500.00'), commitmentRemaining: money('6500.00'),
      availableForDisbursementBeforeHoldback: money('9500.00') },
    { holdbackPercent: '0', holdbackBasis: 'fullagreement' })
    expect(result).toMatchObject({ baseAmount: money('500.00', 'USD'), ceilingAmount: money('500.00', 'USD') })
    expect(Object.fromEntries(result.details.map(row => [row.label, row.value]))).toMatchObject({ totalPaymentsToDate: money('3000.00', 'USD'), totalCreditMemos: money('500.00', 'USD') })
  })
  it('replaces forecast through the last claim month and preserves the later forecast', () => {
    const result = calculateAgreementPaymentValues({ ...defaults, paymentType: 'advance',
      totalClaimsToLastClaimMonth: money('200.00'), totalForecastToLastClaimMonth: money('300.00'),
      totalForecastToPeriodEnd: money('500.00'), totalPaymentsToDate: money('100.00') },
    { holdbackPercent: '0', holdbackBasis: 'fullagreement' })
    expect(result.ceilingAmount).toEqual(money('300.00', 'USD'))
  })
  it('keeps unreconciled earlier-period credits out of the next advance while displaying all posted credits', () => {
    const result = calculateAgreementPaymentValues({ ...defaults, paymentType: 'advance',
      totalClaimsToLastClaimMonth: money('2000.00'), totalForecastToLastClaimMonth: money('3000.00'),
      totalForecastToPeriodEnd: money('9000.00'), totalPaymentsToDate: money('5500.00'),
      totalCreditMemos: money('1000.00'), totalCreditMemosForReconciledPeriods: money('500.00'),
      commitmentRemaining: money('7500.00'), availableForDisbursementBeforeHoldback: money('6500.00') },
    { holdbackPercent: '0', holdbackBasis: 'fullagreement' })
    expect(result).toMatchObject({ baseAmount: money('3000.00', 'USD'), ceilingAmount: money('3000.00', 'USD'), availableBeforeHoldback: money('6000.00', 'USD') })
    expect(Object.fromEntries(result.details.map(row => [row.label, row.value]))).toMatchObject({
      totalCreditMemos: money('1000.00', 'USD'), totalCreditMemosForReconciledPeriods: money('500.00', 'USD') })
  })
  it('includes all posted credits in entitlement and available funds when that agency choice is selected', () => {
    const result = calculateAgreementPaymentValues({ ...defaults, paymentType: 'advance',
      totalClaimsToLastClaimMonth: money('2000.00'), totalForecastToLastClaimMonth: money('3000.00'),
      totalForecastToPeriodEnd: money('9000.00'), totalPaymentsToDate: money('5500.00'),
      totalCreditMemos: money('1000.00'), totalCreditMemosForReconciledPeriods: money('500.00'),
      commitmentRemaining: money('7500.00'), availableForDisbursementBeforeHoldback: money('6500.00') },
    { holdbackPercent: '0', holdbackBasis: 'fullagreement' }, 'all')
    expect(result).toMatchObject({ baseAmount: money('3500.00', 'USD'), ceilingAmount: money('3500.00', 'USD'), availableBeforeHoldback: money('6500.00', 'USD') })
  })
  it('does not re-advance an unreconciled source period just because its credit was received', () => {
    const result = calculateAgreementPaymentValues({ ...defaults, paymentType: 'advance',
      totalClaimsToLastClaimMonth: money('0.00'), totalForecastToPeriodEnd: money('3000.00'),
      totalPaymentsToDate: money('3000.00'), totalCreditMemos: money('500.00'),
      totalCreditMemosForReconciledPeriods: money('0.00'), commitmentRemaining: money('9500.00'),
      availableForDisbursementBeforeHoldback: money('9500.00') },
    { holdbackPercent: '0', holdbackBasis: 'fullagreement' })
    expect(result).toMatchObject({ baseAmount: money('0.00', 'USD'), ceilingAmount: money('0.00', 'USD'), availableBeforeHoldback: money('9000.00', 'USD') })
  })
  it('excludes unreconciled credits before capping holdback releases and available payment funds', () => {
    const result = calculateAgreementPaymentValues({ ...defaults, totalClaimsToLastClaimMonth: money('1100.00'),
      totalPaymentsToDate: money('1000.00'), totalCreditMemos: money('500.00'),
      totalCreditMemosForReconciledPeriods: money('0.00'), availableForDisbursementBeforeHoldback: money('550.00'),
      releaseHoldback: true, holdbackReleaseAmount: money('500.00', 'USD') },
    { holdbackPercent: '10', holdbackBasis: 'fullagreement' })
    expect(result).toMatchObject({ baseAmount: money('100.00', 'USD'), holdbackAmount: money('100.00', 'USD'),
      availableBeforeHoldback: money('0.00', 'USD'), holdbackReleaseAmount: money('50.00', 'USD'), ceilingAmount: money('50.00', 'USD') })
  })
  it('uses the final fiscal funding basis including an empty final year', () => {
    expect(calculateAgreementPaymentValues({ ...defaults, finalFiscalYearTotal: money('0.00') },
      { holdbackPercent: '10', holdbackBasis: 'finalfiscal' }).holdbackAmount).toEqual(money('0.00', 'USD'))
  })
  it('does not add reconciled-period credits twice to host-provided net availability', () => {
    const result = calculateAgreementPaymentValues({ ...defaults, totalCreditMemos: money('500.00'), totalCreditMemosForReconciledPeriods: money('500.00'),
      availableForDisbursementBeforeHoldback: money('100.00') },
    { holdbackPercent: '0', holdbackBasis: 'fullagreement' })
    expect(result).toMatchObject({ baseAmount: money('1500.00', 'USD'), ceilingAmount: money('100.00', 'USD') })
  })

  it('explains advance arithmetic, capped reserves and releases as labeled operands', () => {
    const result = calculateAgreementPaymentValues({ ...defaults, paymentType: 'advance',
      totalClaimsToLastClaimMonth: money('2000.00', 'USD'), totalForecastToLastClaimMonth: money('3000.00', 'USD'),
      totalForecastToPeriodEnd: money('9000.00', 'USD'), totalPaymentsToDate: money('5500.00', 'USD'),
      totalCreditMemos: money('1000.00', 'USD'), totalCreditMemosForReconciledPeriods: money('500.00', 'USD'),
      commitmentRemaining: money('7500.00', 'USD'), availableForDisbursementBeforeHoldback: money('6500.00', 'USD'),
      finalFiscalYearTotal: money('100000.05', 'USD'), releaseHoldback: true, holdbackReleaseAmount: money('9999.99', 'USD') },
    { holdbackPercent: '10', holdbackBasis: 'finalfiscal' })
    expect(result.explanation).toEqual([
      { label: 'explanation.payment_calculation', rows: [
        { label: 'explanation.claims', value: money('2000.00', 'USD') },
        { label: 'explanation.forecast', value: money('9000.00', 'USD'), operator: '+' },
        { label: 'explanation.claimed_forecast', value: money('3000.00', 'USD'), operator: '−' },
        { label: 'explanation.paid', value: money('5500.00', 'USD'), operator: '−' },
        { label: 'credit_memo_basis.reconciled_periods', value: money('500.00', 'USD'), operator: '+' }
      ], total: { label: 'explanation.payment_calculation', value: money('3000.00', 'USD') } },
      { label: 'explanation.holdback', rows: [
        { label: 'explanation.final_year', value: money('100000.05', 'USD') },
        { label: 'explanation.holdback_rate', value: '10', operator: '×', format: 'percent' }
      ], total: { label: 'explanation.full_holdback', value: money('10000.00', 'USD') },
      notes: ['explanation.reserve_limited'], noteValues: { reserve: money('6000.00', 'USD') } },
      { label: 'explanation.available_funds', rows: [
        { label: 'explanation.funding', value: money('6500.00', 'USD') },
        { label: 'explanation.unreconciled_credits', value: money('500.00', 'USD'), operator: '−' },
        { label: 'explanation.reserved', value: money('6000.00', 'USD'), operator: '−' },
        { label: 'explanation.released', value: money('6000.00', 'USD'), operator: '+' }
      ], total: { label: 'explanation.available_funds', value: money('6000.00', 'USD') },
      notes: ['explanation.credit_policy', 'explanation.release_limited'], noteValues: { requested: money('9999.99', 'USD'), released: money('6000.00', 'USD') } },
      { label: 'explanation.payment_limits', emphasis: true, rows: [
        { label: 'explanation.payment_calculation', value: money('3000.00', 'USD') },
        { label: 'explanation.commitment', value: money('7500.00', 'USD') },
        { label: 'explanation.available_funds', value: money('6000.00', 'USD') }
      ], total: { label: 'explanation.maximum', value: money('3000.00', 'USD') }, notes: ['explanation.limited_calculation'] }
    ])
  })

  it('explains reimbursement using all credits, omits forecasts and keeps aggregate cents', () => {
    const result = calculateAgreementPaymentValues({ ...defaults, totalClaimsToLastClaimMonth: money('199999999999999999.98', 'USD'),
      totalPaymentsToDate: money('10.01', 'USD'), totalCreditMemos: money('2.02', 'USD'), totalCreditMemosForReconciledPeriods: money('1.00', 'USD') },
    { holdbackPercent: '0', holdbackBasis: 'fullagreement' }, 'all')
    expect(result.explanation?.[0]).toEqual({ label: 'explanation.payment_calculation', rows: [
      { label: 'explanation.claims', value: money('199999999999999999.98', 'USD') },
      { label: 'explanation.paid', value: money('10.01', 'USD'), operator: '−' },
      { label: 'credit_memo_basis.all', value: money('2.02', 'USD'), operator: '+' }
    ], total: { label: 'explanation.payment_calculation', value: money('199999999999999991.99', 'USD') } })
    expect(result.explanation).toHaveLength(3)
    expect(JSON.stringify(result.explanation)).not.toContain('99999999999999999.99')
    expect(result.explanation?.[1]?.rows).toEqual([{ label: 'explanation.funding', value: money('1000.00', 'USD') }])
  })

  it('keeps one starting zero for an empty calculation and removes irrelevant zero operands', () => {
    const empty = calculateAgreementPaymentValues({ ...defaults, paymentType: 'advance', totalClaimsToLastClaimMonth: money('0.00', 'USD') },
      { holdbackPercent: '0', holdbackBasis: 'fullagreement' })
    expect(empty.explanation?.[0]?.rows).toEqual([{ label: 'explanation.forecast', value: money('0.00', 'USD') }])
    const advance = calculateAgreementPaymentValues({ ...defaults, paymentType: 'advance', totalClaimsToLastClaimMonth: money('0.00', 'USD'),
      totalForecastToPeriodEnd: money('51750.00', 'USD'), totalPaymentsToDate: money('5000.00', 'USD') }, { holdbackPercent: '0', holdbackBasis: 'fullagreement' })
    expect(advance.explanation?.[0]?.rows).toEqual([
      { label: 'explanation.forecast', value: money('51750.00', 'USD') },
      { label: 'explanation.paid', value: money('5000.00', 'USD'), operator: '−' }
    ])
  })

  it('keeps a leading subtraction and explains negative entitlement and exhausted funding', () => {
    const result = calculateAgreementPaymentValues({ ...defaults, totalClaimsToLastClaimMonth: money('0.00', 'USD'), totalPaymentsToDate: money('2000.00', 'USD'),
      availableForDisbursementBeforeHoldback: money('-1000.00', 'USD') }, { holdbackPercent: '10', holdbackBasis: 'fullagreement' })
    expect(result.explanation?.[0]).toMatchObject({ rows: [{ label: 'explanation.paid', value: money('2000.00', 'USD'), operator: '−' }],
      total: { value: money('-2000.00') }, notes: ['explanation.nothing_payable'] })
    expect(result.explanation?.[2]).toMatchObject({ total: { value: money('0.00') }, notes: ['explanation.availability_zero'] })
    expect(result.ceilingAmount).toEqual(money('0.00', 'USD'))
  })

  it.each([
    ['1000.00', '500.00', '1000.00', '500.00', 'explanation.limited_commitment'],
    ['1000.00', '1000.00', '499.99', '499.99', 'explanation.limited_funding'],
    ['99999999999999999999999999999999999999', '99999999999999999999999999999999999999', '99999999999999999999999999999999999999', '999999999999999999999999999999999999.99', 'explanation.limited_payment']
  ])('identifies the limit with claims %s, commitment %s and funds %s', (claims, commitment, funds, maximum, reason) => {
    const result = calculateAgreementPaymentValues({ ...defaults, totalClaimsToLastClaimMonth: money(claims!),
      commitmentRemaining: money(commitment!), availableForDisbursementBeforeHoldback: money(funds!) },
    { holdbackPercent: '0', holdbackBasis: 'fullagreement' })
    expect(result.explanation?.at(-1)).toMatchObject({ emphasis: true, total: { value: money(maximum!) }, notes: [reason] })
    expect(result.explanation?.at(-1)?.rows).toHaveLength(reason === 'explanation.limited_payment' ? 4 : 3)
  })
})

describe('currency-specific minor-unit Payment calculations', () => {
  it.each([['JPY', '1'], ['USD', '0.01'], ['KWD', '0.001'], ['CLF', '0.0001'], ['MGA', '0.2']])('preserves the smallest payable %s unit', (currency, smallest) => {
    const amount = money(smallest!, currency)
    const zero = money('0', currency)
    const result = calculateAutomatedPaymentValues({
      agreementId: '1', currency, commitmentRemaining: amount,
      totalClaimsToLastClaimMonth: amount, totalForecastToLastClaimMonth: zero,
      totalForecastToPeriodEnd: zero, totalPaymentsToDate: zero, totalCreditMemos: zero,
      totalCreditMemosForReconciledPeriods: zero, agreementTotal: amount,
      finalFiscalYearTotal: amount, availableForDisbursementBeforeHoldback: amount,
      holdbackPercent: '0', holdbackBasis: 'fullagreement'
    }, { paymentType: 'reimbursement' }, 'all')
    expect(result.ceilingAmount).toEqual(amount)
    expect(result.suggestedAmount).toEqual(amount)
    expect(result.currency).toBe(currency)
  })
  it('keeps whole-major-unit holdback independent of KWD settlement precision', () => {
    const kwd = (value: string) => money(value, 'KWD')
    const result = calculateAutomatedPaymentValues({
      agreementId: '1', currency: 'KWD', commitmentRemaining: kwd('100.001'),
      totalClaimsToLastClaimMonth: kwd('100.001'), totalForecastToLastClaimMonth: kwd('0'),
      totalForecastToPeriodEnd: kwd('0'), totalPaymentsToDate: kwd('0'), totalCreditMemos: kwd('0'),
      totalCreditMemosForReconciledPeriods: kwd('0'), agreementTotal: kwd('100.001'),
      finalFiscalYearTotal: kwd('100.001'), availableForDisbursementBeforeHoldback: kwd('100.001'),
      holdbackPercent: '10', holdbackBasis: 'fullagreement'
    }, { paymentType: 'reimbursement' }, 'all')
    expect(result.holdbackAmount).toEqual(kwd('10'))
    expect(result.ceilingAmount).toEqual(kwd('90.001'))
  })
  it('rejects a financial input denominated in another currency', () => {
    expect(() => calculateAgreementPaymentValues({ ...defaults, totalClaimsToLastClaimMonth: money('1000', 'KWD') },
      { holdbackPercent: '0', holdbackBasis: 'fullagreement' })).toThrow('currency')
  })
})
