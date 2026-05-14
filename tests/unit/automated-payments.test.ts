import { describe, expect, it } from 'vitest'
import {
  AutomatedPaymentCalculateSchema,
  calculateAutomatedPaymentAmount,
  parseAutomatedPaymentExtensionPayload,
  roundCurrency,
  type AutomatedPaymentCalculationInput
} from '../../shared/automated-payments'
import { createAutomatedPaymentValidationError } from '../../server/errors'

const hostHoldbackSettings = {
  holdbackPercent: 10,
  holdbackBasis: 'agreement-total' as const
}

const baseInput: AutomatedPaymentCalculationInput = {
  paymentType: 'reimbursement',
  periodEnd: 3,
  totalClaimsToLastClaimMonth: 1000,
  totalPaymentsToDate: 250,
  totalForecastToLastClaimMonth: 0,
  totalForecastToPeriodEnd: 0,
  commitmentRemaining: 1000,
  agreementTotal: 2000,
  finalFiscalYearTotal: 500,
  availableForDisbursementBeforeHoldback: 1000,
  holdbackAlreadyReleased: 0
}

describe('gcs automated payments calculation', () => {
  it('calculates reimbursement ceiling from claims minus payments', () => {
    const result = calculateAutomatedPaymentAmount(baseInput, hostHoldbackSettings)

    expect(result.baseAmount).toBe(750)
    expect(result.ceilingAmount).toBe(750)
  })

  it('calculates advance shortfall using claim and forecast movement', () => {
    const result = calculateAutomatedPaymentAmount({
      ...baseInput,
      paymentType: 'advance',
      totalClaimsToLastClaimMonth: 500,
      totalPaymentsToDate: 100,
      totalForecastToLastClaimMonth: 300,
      totalForecastToPeriodEnd: 900
    }, hostHoldbackSettings)

    expect(result.baseAmount).toBe(1000)
    expect(result.ceilingAmount).toBe(1000)
  })

  it('subtracts advance slippage when claims are below forecast to the last claim month', () => {
    const result = calculateAutomatedPaymentAmount({
      ...baseInput,
      paymentType: 'advance',
      totalClaimsToLastClaimMonth: 200,
      totalPaymentsToDate: 100,
      totalForecastToLastClaimMonth: 500,
      totalForecastToPeriodEnd: 900
    }, hostHoldbackSettings)

    expect(result.baseAmount).toBe(500)
    expect(result.ceilingAmount).toBe(500)
  })

  it('uses forecast to period end for advances when there are no processed claims', () => {
    const result = calculateAutomatedPaymentAmount({
      ...baseInput,
      paymentType: 'advance',
      totalClaimsToLastClaimMonth: 0,
      totalPaymentsToDate: 0,
      totalForecastToLastClaimMonth: 0,
      totalForecastToPeriodEnd: 300
    }, hostHoldbackSettings)

    expect(result.baseAmount).toBe(300)
    expect(result.ceilingAmount).toBe(300)
  })

  it('clamps negative base amounts to zero', () => {
    const result = calculateAutomatedPaymentAmount({
      ...baseInput,
      totalClaimsToLastClaimMonth: 100,
      totalPaymentsToDate: 250
    }, hostHoldbackSettings)

    expect(result.baseAmount).toBe(0)
    expect(result.ceilingAmount).toBe(0)
  })

  it('caps by commitment remaining', () => {
    const result = calculateAutomatedPaymentAmount({
      ...baseInput,
      totalPaymentsToDate: 0,
      commitmentRemaining: 225
    }, hostHoldbackSettings)

    expect(result.ceilingAmount).toBe(225)
  })

  it('caps by holdback availability', () => {
    const result = calculateAutomatedPaymentAmount({
      ...baseInput,
      totalClaimsToLastClaimMonth: 2000,
      totalPaymentsToDate: 850,
      commitmentRemaining: 2000,
      agreementTotal: 1000,
      finalFiscalYearTotal: 1000,
      availableForDisbursementBeforeHoldback: 50
    }, hostHoldbackSettings)

    expect(result.availableBeforeHoldback).toBe(50)
    expect(result.ceilingAmount).toBe(50)
  })

  it('adds partial holdback release to the holdback availability cap', () => {
    const result = calculateAutomatedPaymentAmount({
      ...baseInput,
      totalClaimsToLastClaimMonth: 2000,
      totalPaymentsToDate: 850,
      commitmentRemaining: 2000,
      agreementTotal: 1000,
      finalFiscalYearTotal: 1000,
      availableForDisbursementBeforeHoldback: 50,
      releaseHoldback: true,
      holdbackReleaseAmount: 25
    }, hostHoldbackSettings)

    expect(result.holdbackReleaseAmount).toBe(25)
    expect(result.ceilingAmount).toBe(75)
  })

  it('limits full holdback release to unreleased holdback remaining', () => {
    const result = calculateAutomatedPaymentAmount({
      ...baseInput,
      totalClaimsToLastClaimMonth: 2000,
      totalPaymentsToDate: 850,
      commitmentRemaining: 2000,
      agreementTotal: 1000,
      finalFiscalYearTotal: 1000,
      availableForDisbursementBeforeHoldback: 50,
      holdbackAlreadyReleased: 40,
      releaseHoldback: true,
      holdbackReleaseAmount: 500
    }, hostHoldbackSettings)

    expect(result.holdbackAmount).toBe(100)
    expect(result.holdbackReleaseAmount).toBe(60)
    expect(result.ceilingAmount).toBe(110)
  })

  it('rounds repeating decimal inputs to currency precision', () => {
    expect(roundCurrency(10 / 3)).toBe(3.33)
    const result = calculateAutomatedPaymentAmount({
      ...baseInput,
      totalClaimsToLastClaimMonth: 100 / 3,
      totalPaymentsToDate: 0
    }, hostHoldbackSettings)

    expect(result.ceilingAmount).toBe(33.33)
  })

  it('normalizes extension holdback release payloads', () => {
    expect(parseAutomatedPaymentExtensionPayload({
      releaseHoldback: true,
      holdbackReleaseAmount: '12.50'
    })).toEqual({
      releaseHoldback: true,
      holdbackReleaseAmount: 12.5
    })

    expect(parseAutomatedPaymentExtensionPayload({
      releaseHoldback: false,
      holdbackReleaseAmount: 12.5
    })).toEqual({
      releaseHoldback: false,
      holdbackReleaseAmount: 0
    })
  })

  it('uses an extension-owned validation code for invalid period ranges', () => {
    const result = AutomatedPaymentCalculateSchema.safeParse({
      egcs_fc_commitmenttype: 'commitment',
      egcs_fc_fiscalyear: '1',
      egcs_fc_paymenttype: 'advance',
      egcs_fc_periodstart: 3,
      egcs_fc_periodend: 2,
      egcs_fc_paymentamount: 50
    })

    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('GCS_AUTOMATED_PAYMENTS_PERIOD_RANGE_INVALID')
    expect(result.error?.issues[0]?.path).toEqual(['egcs_fc_periodend'])
  })

  it('converts calculator validation issues into bilingual extension-owned user errors', () => {
    const result = AutomatedPaymentCalculateSchema.safeParse({
      egcs_fc_commitmenttype: 'commitment',
      egcs_fc_fiscalyear: '1',
      egcs_fc_paymenttype: 'advance',
      egcs_fc_periodstart: 3,
      egcs_fc_periodend: 2,
      egcs_fc_paymentamount: 50
    })

    expect(result.success).toBe(false)

    const error = createAutomatedPaymentValidationError(result.error?.issues ?? [])

    expect(error.code).toBe('GCS_AUTOMATED_PAYMENTS_INVALID_CALCULATION_INPUT')
    expect(error.localizedMessage).toEqual({
      en: 'Review the payment fields before calculating the automated payment.',
      fr: 'Verifiez les champs du paiement avant de calculer le paiement automatise.'
    })
    expect(error.details).toEqual([{
      path: 'egcs_fc_periodend',
      code: 'GCS_AUTOMATED_PAYMENTS_PERIOD_RANGE_INVALID',
      message: {
        en: 'Period end must be the same as or after period start.',
        fr: 'La periode de fin doit etre identique ou posterieure a la periode de debut.'
      }
    }])
  })
})
