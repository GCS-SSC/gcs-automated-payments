import { describe, expect, it } from 'vitest'
import {
  AutomatedPaymentCalculateSchema,
  AutomatedPaymentMoneySchema,
  AutomatedPaymentPositiveBigintIdSchema,
  calculateAutomatedPaymentAmount,
  parseAutomatedPaymentExtensionPayload,
  sumAutomatedPaymentMoney,
  type AutomatedPaymentCalculationInput
} from '../../shared/automated-payments'
import { createAutomatedPaymentValidationError } from '../../server/errors'

const hostHoldbackSettings = {
  holdbackPercent: 10,
  holdbackBasis: 'fullagreement' as const
}

const validCommitmentTypeId = '9223372036854775807'
const validFiscalYearId = '1'

const baseInput = {
  paymentType: 'reimbursement',
  periodEnd: 3,
  totalClaimsToLastClaimMonth: '1000.00',
  totalPaymentsToDate: '250.00',
  totalForecastToLastClaimMonth: '0.00',
  totalForecastToPeriodEnd: '0.00',
  commitmentRemaining: '1000.00',
  agreementTotal: '2000.00',
  finalFiscalYearTotal: '500.00',
  availableForDisbursementBeforeHoldback: '1200.00'
} as AutomatedPaymentCalculationInput

describe('gcs automated payments calculation', () => {
  it.each([
    { currency: 'cad', funding: '125.55', reserve: '12.00', ceiling: '113.55' },
    { currency: 'usd', funding: '84.46', reserve: '8.00', ceiling: '76.46' }
  ])('keeps $currency native money and rounds its reserve independently', ({ currency, funding, reserve, ceiling }) => {
    const result = calculateAutomatedPaymentAmount({ ...baseInput, currency,
      totalClaimsToLastClaimMonth: funding, totalPaymentsToDate: '0.00', agreementTotal: funding,
      availableForDisbursementBeforeHoldback: funding }, hostHoldbackSettings)
    expect(result).toMatchObject({ currency: currency.toUpperCase(), holdbackAmount: reserve, ceilingAmount: ceiling, suggestedAmount: ceiling })
  })

  it('retains the historical CAD default only when calculation currency is omitted', () => {
    const result = calculateAutomatedPaymentAmount(baseInput, hostHoldbackSettings)
    expect(result.currency).toBe('CAD')
  })

  it('calculates reimbursement ceiling from claims minus payments', () => {
    const result = calculateAutomatedPaymentAmount(baseInput, hostHoldbackSettings)

    expect(result.baseAmount).toBe('750.00')
    expect(result.ceilingAmount).toBe('750.00')
  })

  it('calculates advance shortfall using claim and forecast movement', () => {
    const result = calculateAutomatedPaymentAmount({
      ...baseInput,
      paymentType: 'advance',
      totalClaimsToLastClaimMonth: '500.00', totalPaymentsToDate: '100.00',
      totalForecastToLastClaimMonth: '300.00', totalForecastToPeriodEnd: '900.00'
    } as AutomatedPaymentCalculationInput, hostHoldbackSettings)

    expect(result.baseAmount).toBe('1000.00')
    expect(result.ceilingAmount).toBe('1000.00')
  })

  it('subtracts advance slippage when claims are below forecast to the last claim month', () => {
    const result = calculateAutomatedPaymentAmount({
      ...baseInput,
      paymentType: 'advance',
      totalClaimsToLastClaimMonth: '200.00', totalPaymentsToDate: '100.00',
      totalForecastToLastClaimMonth: '500.00', totalForecastToPeriodEnd: '900.00'
    } as AutomatedPaymentCalculationInput, hostHoldbackSettings)

    expect(result.baseAmount).toBe('500.00')
    expect(result.ceilingAmount).toBe('500.00')
  })

  it('uses forecast to period end for advances when there are no processed claims', () => {
    const result = calculateAutomatedPaymentAmount({
      ...baseInput,
      paymentType: 'advance',
      totalClaimsToLastClaimMonth: '0.00', totalPaymentsToDate: '0.00',
      totalForecastToLastClaimMonth: '0.00', totalForecastToPeriodEnd: '300.00'
    } as AutomatedPaymentCalculationInput, hostHoldbackSettings)

    expect(result.baseAmount).toBe('300.00')
    expect(result.ceilingAmount).toBe('300.00')
  })

  it('clamps negative base amounts to zero', () => {
    const result = calculateAutomatedPaymentAmount({
      ...baseInput,
      totalClaimsToLastClaimMonth: '100.00', totalPaymentsToDate: '250.00'
    } as AutomatedPaymentCalculationInput, hostHoldbackSettings)

    expect(result.baseAmount).toBe('0.00')
    expect(result.ceilingAmount).toBe('0.00')
  })

  it('caps by commitment remaining', () => {
    const result = calculateAutomatedPaymentAmount({
      ...baseInput,
      totalPaymentsToDate: '0.00', commitmentRemaining: '225.00'
    } as AutomatedPaymentCalculationInput, hostHoldbackSettings)

    expect(result.ceilingAmount).toBe('225.00')
  })

  it('caps by holdback availability', () => {
    const result = calculateAutomatedPaymentAmount({
      ...baseInput,
      totalClaimsToLastClaimMonth: '2000.00', totalPaymentsToDate: '850.00',
      commitmentRemaining: '2000.00', agreementTotal: '1000.00',
      finalFiscalYearTotal: '1000.00', availableForDisbursementBeforeHoldback: '150.00'
    } as AutomatedPaymentCalculationInput, hostHoldbackSettings)

    expect(result.availableBeforeHoldback).toBe('50.00')
    expect(result.ceilingAmount).toBe('50.00')
  })

  it('adds partial holdback release to the holdback availability cap', () => {
    const result = calculateAutomatedPaymentAmount({
      ...baseInput,
      totalClaimsToLastClaimMonth: '2000.00', totalPaymentsToDate: '850.00',
      commitmentRemaining: '2000.00', agreementTotal: '1000.00',
      finalFiscalYearTotal: '1000.00', availableForDisbursementBeforeHoldback: '150.00',
      releaseHoldback: true,
      holdbackReleaseAmount: '25.00'
    } as AutomatedPaymentCalculationInput, hostHoldbackSettings)

    expect(result.holdbackReleaseAmount).toBe('25.00')
    expect(result.ceilingAmount).toBe('75.00')
  })

  it('limits elected release to the full recurring reserve without tracking prior releases', () => {
    const result = calculateAutomatedPaymentAmount({
      ...baseInput,
      totalClaimsToLastClaimMonth: '2000.00', totalPaymentsToDate: '850.00',
      commitmentRemaining: '2000.00', agreementTotal: '1000.00',
      finalFiscalYearTotal: '1000.00', availableForDisbursementBeforeHoldback: '150.00',
      releaseHoldback: true,
      holdbackReleaseAmount: '500.00'
    } as AutomatedPaymentCalculationInput, hostHoldbackSettings)

    expect(result.holdbackAmount).toBe('100.00')
    expect(result.holdbackReleaseAmount).toBe('100.00')
    expect(result.ceilingAmount).toBe('150.00')
  })

  it.each([
    { paid: '0.00', unpaid: '1000.00', request: '0.00', ordinary: '900.00', release: '0.00', expected: '900.00' },
    { paid: '700.00', unpaid: '300.00', request: '50.00', ordinary: '200.00', release: '50.00', expected: '250.00' },
    { paid: '950.00', unpaid: '50.00', request: '0.00', ordinary: '0.00', release: '0.00', expected: '0.00' },
    { paid: '950.00', unpaid: '50.00', request: '25.00', ordinary: '0.00', release: '25.00', expected: '25.00' },
    { paid: '950.00', unpaid: '50.00', request: '100.00', ordinary: '0.00', release: '50.00', expected: '50.00' },
    { paid: '1000.00', unpaid: '0.00', request: '100.00', ordinary: '0.00', release: '0.00', expected: '0.00' },
    { paid: '1000.01', unpaid: '-0.01', request: '100.00', ordinary: '0.00', release: '0.00', expected: '0.00' }
  ])('reapplies the full holdback at paid $paid with requested release $request', ({ paid, unpaid, request, ordinary, release, expected }) => {
    const result = calculateAutomatedPaymentAmount({
      ...baseInput, totalClaimsToLastClaimMonth: '1000.00', totalPaymentsToDate: paid,
      agreementTotal: '1000.00', commitmentRemaining: '1000.00',
      availableForDisbursementBeforeHoldback: unpaid,
      releaseHoldback: true, holdbackReleaseAmount: request
    }, hostHoldbackSettings)
    expect(result.holdbackAmount).toBe('100.00')
    expect(result.availableBeforeHoldback).toBe(ordinary)
    expect(result.holdbackReleaseAmount).toBe(release)
    expect(result.ceilingAmount).toBe(expected)
  })

  it('clips the reserve to unpaid cents while keeping full calculated holdback in whole dollars', () => {
    const result = calculateAutomatedPaymentAmount({
      ...baseInput, totalClaimsToLastClaimMonth: '1000.00', totalPaymentsToDate: '950.01',
      agreementTotal: '1000.00', availableForDisbursementBeforeHoldback: '49.99',
      releaseHoldback: true, holdbackReleaseAmount: '100.00'
    }, hostHoldbackSettings)
    expect(result.holdbackAmount).toBe('100.00')
    expect(result.availableBeforeHoldback).toBe('0.00')
    expect(result.holdbackReleaseAmount).toBe('49.99')
    expect(result.ceilingAmount).toBe('49.99')
  })

  it('adds cents exactly without binary floating-point drift', () => {
    const result = calculateAutomatedPaymentAmount({
      ...baseInput,
      totalClaimsToLastClaimMonth: '0.30',
      totalPaymentsToDate: '0.00'
    } as AutomatedPaymentCalculationInput, hostHoldbackSettings)

    expect(result.ceilingAmount).toBe('0.30')
  })

  it('keeps a derived total exact beyond one numeric(19,2) row', () => {
    expect(sumAutomatedPaymentMoney([
      AutomatedPaymentMoneySchema.parse('99999999999999999.99'),
      AutomatedPaymentMoneySchema.parse('99999999999999999.99')
    ])).toBe('199999999999999999.98')
  })

  it.each(['0.001', '1e2', ' 0.10', '00.10', '999999999999999999.99', Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid or unsafe row money %s', value => {
      expect(AutomatedPaymentMoneySchema.safeParse(value).success).toBe(false)
    }
  )

  it('normalizes extension holdback release payloads', () => {
    expect(parseAutomatedPaymentExtensionPayload({
      releaseHoldback: true,
      holdbackReleaseAmount: '12.50'
    })).toEqual({
      releaseHoldback: true,
      holdbackReleaseAmount: '12.50'
    })

    expect(parseAutomatedPaymentExtensionPayload({
      releaseHoldback: false,
      holdbackReleaseAmount: 12.5
    })).toEqual({
      releaseHoldback: false,
      holdbackReleaseAmount: '0.00'
    })
  })

  it('uses an extension-owned validation code for invalid period ranges', () => {
    const result = AutomatedPaymentCalculateSchema.safeParse({
      egcs_fc_commitmenttype: validCommitmentTypeId,
      egcs_fc_fiscalyear: validFiscalYearId,
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
      egcs_fc_commitmenttype: validCommitmentTypeId,
      egcs_fc_fiscalyear: validFiscalYearId,
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

  it.each([
    { name: 'the smallest string id', value: '1', expected: '1' },
    { name: 'the signed-bigint maximum', value: validCommitmentTypeId, expected: validCommitmentTypeId },
    { name: 'a safe numeric id', value: 42, expected: '42' },
    { name: 'a bigint id', value: 42n, expected: '42' },
    { name: 'a whitespace-padded id', value: ' 42 ', expected: '42' }
  ])('accepts $name as a canonical positive bigint identifier', ({ value, expected }) => {
    expect(AutomatedPaymentPositiveBigintIdSchema.parse(value)).toBe(expected)
  })

  it.each([
    { name: 'missing', value: undefined },
    { name: 'null', value: null },
    { name: 'empty', value: '' },
    { name: 'whitespace-only', value: '   ' },
    { name: 'malformed', value: 'commitment-1' },
    { name: 'zero text', value: '0' },
    { name: 'numeric zero', value: 0 },
    { name: 'negative', value: '-1' },
    { name: 'leading-zero', value: '01' },
    { name: 'decimal', value: '1.0' },
    { name: 'signed-bigint overflow', value: '9223372036854775808' },
    { name: 'unsafe numeric input', value: 9_223_372_036_854_776_000 },
    { name: 'repeated values', value: ['1', '2'] }
  ])('rejects $name positive-bigint input', ({ value }) => {
    expect(AutomatedPaymentPositiveBigintIdSchema.safeParse(value).success).toBe(false)
  })

})
