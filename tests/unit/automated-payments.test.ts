import { describe, expect, it } from 'vitest'
import {
  calculateAutomatedPaymentAmount,
  roundCurrency
} from '../../shared/automated-payments'

const hostHoldbackSettings = {
  holdbackPercent: 10,
  holdbackBasis: 'agreement-total' as const
}

describe('gcs automated payments calculation', () => {
  it('calculates reimbursement ceiling from claims minus payments', () => {
    const result = calculateAutomatedPaymentAmount({
      paymentType: 'reimbursement',
      periodEnd: 3,
      totalClaimsToLastClaimMonth: 1000,
      totalPaymentsToDate: 250,
      totalForecastToLastClaimMonth: 0,
      totalForecastToPeriodEnd: 0,
      commitmentRemaining: 1000,
      agreementTotal: 2000,
      finalFiscalYearTotal: 2000
    }, hostHoldbackSettings)

    expect(result.baseAmount).toBe(750)
    expect(result.ceilingAmount).toBe(750)
  })

  it('calculates advance ceiling using claim and forecast movement', () => {
    const result = calculateAutomatedPaymentAmount({
      paymentType: 'advance',
      periodEnd: 5,
      totalClaimsToLastClaimMonth: 500,
      totalPaymentsToDate: 100,
      totalForecastToLastClaimMonth: 300,
      totalForecastToPeriodEnd: 900,
      commitmentRemaining: 1000,
      agreementTotal: 2000,
      finalFiscalYearTotal: 2000
    }, hostHoldbackSettings)

    expect(result.baseAmount).toBe(1000)
    expect(result.ceilingAmount).toBe(1000)
  })

  it('caps by commitment remaining', () => {
    const result = calculateAutomatedPaymentAmount({
      paymentType: 'reimbursement',
      periodEnd: 1,
      totalClaimsToLastClaimMonth: 1000,
      totalPaymentsToDate: 0,
      totalForecastToLastClaimMonth: 0,
      totalForecastToPeriodEnd: 0,
      commitmentRemaining: 225,
      agreementTotal: 2000,
      finalFiscalYearTotal: 2000
    }, hostHoldbackSettings)

    expect(result.ceilingAmount).toBe(225)
  })

  it('caps by holdback availability', () => {
    const result = calculateAutomatedPaymentAmount({
      paymentType: 'reimbursement',
      periodEnd: 1,
      totalClaimsToLastClaimMonth: 2000,
      totalPaymentsToDate: 850,
      totalForecastToLastClaimMonth: 0,
      totalForecastToPeriodEnd: 0,
      commitmentRemaining: 2000,
      agreementTotal: 1000,
      finalFiscalYearTotal: 1000
    }, {
      holdbackPercent: 10,
      holdbackBasis: 'agreement-total'
    })

    expect(result.ceilingAmount).toBe(50)
  })

  it('rounds repeating decimal inputs to currency precision', () => {
    expect(roundCurrency(10 / 3)).toBe(3.33)
    const result = calculateAutomatedPaymentAmount({
      paymentType: 'reimbursement',
      periodEnd: 1,
      totalClaimsToLastClaimMonth: 100 / 3,
      totalPaymentsToDate: 0,
      totalForecastToLastClaimMonth: 0,
      totalForecastToPeriodEnd: 0,
      commitmentRemaining: 1000,
      agreementTotal: 1000,
      finalFiscalYearTotal: 1000
    }, hostHoldbackSettings)

    expect(result.ceilingAmount).toBe(33.33)
  })
})
