import { describe, expect, it } from 'vitest'
import {
  calculateAutomatedPaymentAmount,
  calculateAutomatedPaymentHoldbackAmount,
  parseAutomatedPaymentAggregateMoney,
  type AutomatedPaymentCalculationInput
} from '../../shared/automated-payments'

describe('automated payment exact holdback and aggregate precision', () => {
  it.each([
    { basis: '0.15', percent: 10, expected: '0.00' },
    { basis: '19.99', percent: 5, expected: '0.00' },
    { basis: '20.00', percent: 5, expected: '1.00' },
    { basis: '20.01', percent: 5, expected: '1.00' },
    { basis: '100.01', percent: 12.5, expected: '12.00' },
    { basis: '999.99', percent: 12.34, expected: '123.00' },
    { basis: '9999.99', percent: 0.01, expected: '0.00' },
    { basis: '10000.00', percent: 0.01, expected: '1.00' },
    { basis: '99999999999999999.99', percent: 100, expected: '99999999999999999.00' },
    { basis: '199999999999999999.98', percent: 12.5, expected: '24999999999999999.00' },
    { basis: '199999999999999999.98', percent: 0, expected: '0.00' }
  ])('rounds $basis × $percent% down to $expected using exact cents', ({ basis, percent, expected }) => {
    expect(calculateAutomatedPaymentHoldbackAmount(parseAutomatedPaymentAggregateMoney(basis), percent)).toBe(expected)
  })

  it.each([-1, 100.01, Number.NaN, Number.POSITIVE_INFINITY, 0.001])(
    'rejects an invalid persisted percentage %s instead of substituting zero holdback', percent => {
      expect(() => calculateAutomatedPaymentHoldbackAmount(parseAutomatedPaymentAggregateMoney('100.00'), percent)).toThrow()
    }
  )

  it('rejects a negative holdback funding basis', () => {
    expect(() => calculateAutomatedPaymentHoldbackAmount(parseAutomatedPaymentAggregateMoney('-1.00'), 10)).toThrow()
  })

  const aggregateInput: AutomatedPaymentCalculationInput = {
    paymentType: 'reimbursement', periodEnd: 11,
    totalClaimsToLastClaimMonth: '199999999999999999.98',
    totalPaymentsToDate: '199999999999999999.97',
    totalForecastToLastClaimMonth: '199999999999999999.98',
    totalForecastToPeriodEnd: '199999999999999999.98',
    commitmentRemaining: '199999999999999999.98',
    agreementTotal: '199999999999999999.98',
    finalFiscalYearTotal: '199999999999999999.98',
    availableForDisbursementBeforeHoldback: '199999999999999999.98'
  }

  it.each(['reimbursement', 'advance'] as const)('preserves a one-cent %s shortfall after subtracting large derived totals', paymentType => {
    const result = calculateAutomatedPaymentAmount({ ...aggregateInput, paymentType }, {
      holdbackPercent: 0, holdbackBasis: 'fullagreement'
    })
    expect(result.baseAmount).toBe('0.01')
    expect(result.ceilingAmount).toBe('0.01')
    expect(result.suggestedAmount).toBe('0.01')
    expect(result.details.find(detail => detail.label === 'totalPaymentsToDate')?.value).toBe('199999999999999999.97')
  })

  it('caps a single Payment at numeric(19,2) while retaining larger aggregate entitlement and capacity', () => {
    const result = calculateAutomatedPaymentAmount({ ...aggregateInput, totalPaymentsToDate: '0.00' }, {
      holdbackPercent: 0, holdbackBasis: 'fullagreement'
    })
    expect(result.baseAmount).toBe('199999999999999999.98')
    expect(result.ceilingAmount).toBe('99999999999999999.99')
    expect(result.suggestedAmount).toBe('99999999999999999.99')
    expect(result.details.find(detail => detail.label === 'commitmentRemaining')?.value).toBe('199999999999999999.98')
  })

  it('uses final-year funding for finalfiscal while preserving exact claims and paid cents', () => {
    const result = calculateAutomatedPaymentAmount({
      ...aggregateInput,
      totalClaimsToLastClaimMonth: '1000.31', totalPaymentsToDate: '900.10',
      finalFiscalYearTotal: '200.15', agreementTotal: '1000.99',
      availableForDisbursementBeforeHoldback: '105.21'
    }, { holdbackPercent: 12.5, holdbackBasis: 'finalfiscal' })
    expect(result.holdbackAmount).toBe('25.00')
    expect(result.baseAmount).toBe('100.21')
    expect(result.ceilingAmount).toBe('80.21')
  })
})
