import { describe, expect, it } from 'vitest'
import type { GcsExtensionPaymentCalculationResult } from '@gcs-ssc/extensions/server'
import type { AutomatedPaymentCreditMemoBasis } from '../../shared/automated-payments'
import { calculateAutomatedPaymentValues } from '../../server/payment-calculation'
const money = (value: string) => value
type AgreementPaymentCalculationValues = Omit<GcsExtensionPaymentCalculationResult, 'holdbackPercent' | 'holdbackBasis'> & { paymentType: 'advance' | 'reimbursement', releaseHoldback?: boolean, holdbackReleaseAmount?: string }
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
    expect(calculateAgreementPaymentValues({ ...defaults, agreementTotal: money(basis!) }, { holdbackPercent: percent!, holdbackBasis: 'fullagreement' }).holdbackAmount).toBe(expected)
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
    const result = calculateAgreementPaymentValues({ ...defaults, totalPaymentsToDate: money(paid!), availableForDisbursementBeforeHoldback: money(unpaid!), releaseHoldback: true, holdbackReleaseAmount: requested }, { holdbackPercent: '10', holdbackBasis: 'fullagreement' })
    expect(result).toMatchObject({ currency: 'USD', holdbackAmount: '100.00', availableBeforeHoldback: ordinary, holdbackReleaseAmount: release, ceilingAmount: ceiling })
  })
  it('caps one Payment while retaining exact aggregate inputs larger than one row', () => {
    const aggregate = money('199999999999999999.98')
    const result = calculateAgreementPaymentValues({ ...defaults, totalClaimsToLastClaimMonth: aggregate, commitmentRemaining: aggregate, agreementTotal: aggregate, availableForDisbursementBeforeHoldback: aggregate }, { holdbackPercent: '0', holdbackBasis: 'fullagreement' })
    expect(result.baseAmount).toBe(aggregate)
    expect(result.ceilingAmount).toBe('99999999999999999.99')
  })
  it('rejects negative funding basis and ignores unelected releases', () => {
    expect(() => calculateAgreementPaymentValues({ ...defaults, agreementTotal: money('-1') }, { holdbackPercent: '10', holdbackBasis: 'fullagreement' })).toThrow()
    expect(calculateAgreementPaymentValues({ ...defaults, holdbackReleaseAmount: '100.00' }, { holdbackPercent: '10', holdbackBasis: 'fullagreement' }).holdbackReleaseAmount).toBe('0.00')
  })
  it.each(['advance', 'reimbursement'] as const)('subtracts reconciled-period credits from paid once for %s', paymentType => {
    const result = calculateAgreementPaymentValues({ ...defaults, paymentType,
      totalClaimsToLastClaimMonth: money(paymentType === 'advance' ? '0.00' : '3000.00'),
      totalForecastToPeriodEnd: money('3000.00'), totalPaymentsToDate: money('3000.00'),
      totalCreditMemos: money('500.00'), totalCreditMemosForReconciledPeriods: money('500.00'), commitmentRemaining: money('6500.00'),
      availableForDisbursementBeforeHoldback: money('9500.00') },
    { holdbackPercent: '0', holdbackBasis: 'fullagreement' })
    expect(result).toMatchObject({ baseAmount: '500.00', ceilingAmount: '500.00' })
    expect(Object.fromEntries(result.details.map(row => [row.label, row.value]))).toMatchObject({ totalPaymentsToDate: '3000.00', totalCreditMemos: '500.00' })
  })
  it('replaces forecast through the last claim month and preserves the later forecast', () => {
    const result = calculateAgreementPaymentValues({ ...defaults, paymentType: 'advance',
      totalClaimsToLastClaimMonth: money('200.00'), totalForecastToLastClaimMonth: money('300.00'),
      totalForecastToPeriodEnd: money('500.00'), totalPaymentsToDate: money('100.00') },
    { holdbackPercent: '0', holdbackBasis: 'fullagreement' })
    expect(result.ceilingAmount).toBe('300.00')
  })
  it('keeps unreconciled earlier-period credits out of the next advance while displaying all posted credits', () => {
    const result = calculateAgreementPaymentValues({ ...defaults, paymentType: 'advance',
      totalClaimsToLastClaimMonth: money('2000.00'), totalForecastToLastClaimMonth: money('3000.00'),
      totalForecastToPeriodEnd: money('9000.00'), totalPaymentsToDate: money('5500.00'),
      totalCreditMemos: money('1000.00'), totalCreditMemosForReconciledPeriods: money('500.00'),
      commitmentRemaining: money('7500.00'), availableForDisbursementBeforeHoldback: money('6500.00') },
    { holdbackPercent: '0', holdbackBasis: 'fullagreement' })
    expect(result).toMatchObject({ baseAmount: '3000.00', ceilingAmount: '3000.00', availableBeforeHoldback: '6000.00' })
    expect(Object.fromEntries(result.details.map(row => [row.label, row.value]))).toMatchObject({
      totalCreditMemos: '1000.00', totalCreditMemosForReconciledPeriods: '500.00' })
  })
  it('includes all posted credits in entitlement and available funds when that agency choice is selected', () => {
    const result = calculateAgreementPaymentValues({ ...defaults, paymentType: 'advance',
      totalClaimsToLastClaimMonth: money('2000.00'), totalForecastToLastClaimMonth: money('3000.00'),
      totalForecastToPeriodEnd: money('9000.00'), totalPaymentsToDate: money('5500.00'),
      totalCreditMemos: money('1000.00'), totalCreditMemosForReconciledPeriods: money('500.00'),
      commitmentRemaining: money('7500.00'), availableForDisbursementBeforeHoldback: money('6500.00') },
    { holdbackPercent: '0', holdbackBasis: 'fullagreement' }, 'all')
    expect(result).toMatchObject({ baseAmount: '3500.00', ceilingAmount: '3500.00', availableBeforeHoldback: '6500.00' })
  })
  it('does not re-advance an unreconciled source period just because its credit was received', () => {
    const result = calculateAgreementPaymentValues({ ...defaults, paymentType: 'advance',
      totalClaimsToLastClaimMonth: money('0.00'), totalForecastToPeriodEnd: money('3000.00'),
      totalPaymentsToDate: money('3000.00'), totalCreditMemos: money('500.00'),
      totalCreditMemosForReconciledPeriods: money('0.00'), commitmentRemaining: money('9500.00'),
      availableForDisbursementBeforeHoldback: money('9500.00') },
    { holdbackPercent: '0', holdbackBasis: 'fullagreement' })
    expect(result).toMatchObject({ baseAmount: '0.00', ceilingAmount: '0.00', availableBeforeHoldback: '9000.00' })
  })
  it('excludes unreconciled credits before capping holdback releases and available payment funds', () => {
    const result = calculateAgreementPaymentValues({ ...defaults, totalClaimsToLastClaimMonth: money('1100.00'),
      totalPaymentsToDate: money('1000.00'), totalCreditMemos: money('500.00'),
      totalCreditMemosForReconciledPeriods: money('0.00'), availableForDisbursementBeforeHoldback: money('550.00'),
      releaseHoldback: true, holdbackReleaseAmount: '500.00' },
    { holdbackPercent: '10', holdbackBasis: 'fullagreement' })
    expect(result).toMatchObject({ baseAmount: '100.00', holdbackAmount: '100.00',
      availableBeforeHoldback: '0.00', holdbackReleaseAmount: '50.00', ceilingAmount: '50.00' })
  })
  it('uses the final fiscal funding basis including an empty final year', () => {
    expect(calculateAgreementPaymentValues({ ...defaults, finalFiscalYearTotal: money('0.00') },
      { holdbackPercent: '10', holdbackBasis: 'finalfiscal' }).holdbackAmount).toBe('0.00')
  })
  it('does not add reconciled-period credits twice to host-provided net availability', () => {
    const result = calculateAgreementPaymentValues({ ...defaults, totalCreditMemos: money('500.00'), totalCreditMemosForReconciledPeriods: money('500.00'),
      availableForDisbursementBeforeHoldback: money('100.00') },
    { holdbackPercent: '0', holdbackBasis: 'fullagreement' })
    expect(result).toMatchObject({ baseAmount: '1500.00', ceilingAmount: '100.00' })
  })

})
