import { describe, expect, it } from 'vitest'
import {
  AutomatedPaymentCalculateSchema,
  AutomatedPaymentMoneySchema,
  AutomatedPaymentPositiveBigintIdSchema,
  parseAutomatedPaymentExtensionPayload,
  sumAutomatedPaymentMoney
} from '../../shared/automated-payments'
import { createAutomatedPaymentValidationError } from '../../server/errors'

const validCommitmentTypeId = '9223372036854775807'
const validFiscalYearId = '1'

describe('gcs automated payments inputs', () => {
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
