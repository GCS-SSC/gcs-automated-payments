import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GcsExtensionRouteEvent } from '@gcs-ssc/extensions/server'

const readBodyMock = vi.fn()
const calculateAutomatedPaymentFromDbMock = vi.fn()
const validCommitmentTypeId = '9223372036854775807'
const validFiscalYearId = '00000000-0000-4000-8000-000000000001'
const validBody = {
  egcs_fc_commitmenttype: validCommitmentTypeId,
  egcs_fc_fiscalyear: validFiscalYearId,
  egcs_fc_paymenttype: 'advance',
  egcs_fc_periodstart: 1,
  egcs_fc_periodend: 3,
  egcs_fc_paymentamount: '90.50'
}

vi.mock('h3', () => ({
  isEvent: () => true,
  readBody: (...args: unknown[]) => readBodyMock(...args)
}))

vi.mock('../../server/calculation-data', () => ({
  calculateAutomatedPaymentFromDb: (...args: unknown[]) => calculateAutomatedPaymentFromDbMock(...args)
}))

const createRouteEvent = (context: GcsExtensionRouteEvent['context']): GcsExtensionRouteEvent => ({ context })

describe('gcs automated payments calculation route', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('requires an agreement id before calculating', async () => {
    const handler = (await import('../../server/api/calculate-payment.post')).default

    await expect(handler(createRouteEvent({ $db: {}, params: {} }))).rejects.toMatchObject({
      code: 'GCS_AUTOMATED_PAYMENTS_AGREEMENT_REQUIRED'
    })
    expect(readBodyMock).not.toHaveBeenCalled()
    expect(calculateAutomatedPaymentFromDbMock).not.toHaveBeenCalled()
  })

  it('converts invalid route input into extension-owned validation details', async () => {
    readBodyMock.mockResolvedValueOnce({
      egcs_fc_commitmenttype: '',
      egcs_fc_fiscalyear: validFiscalYearId,
      egcs_fc_paymenttype: 'advance',
      egcs_fc_periodstart: 5,
      egcs_fc_periodend: 4
    })
    const handler = (await import('../../server/api/calculate-payment.post')).default

    await expect(handler(createRouteEvent({
      params: { agreementId: 'agreement-1' },
      $db: {}
    }))).rejects.toMatchObject({
      code: 'GCS_AUTOMATED_PAYMENTS_INVALID_CALCULATION_INPUT',
      details: expect.arrayContaining([
        expect.objectContaining({
          path: 'egcs_fc_commitmenttype',
          code: 'GCS_AUTOMATED_PAYMENTS_COMMITMENT_TYPE_REQUIRED'
        }),
        expect.objectContaining({
          path: 'egcs_fc_periodend',
          code: 'GCS_AUTOMATED_PAYMENTS_PERIOD_RANGE_INVALID'
        })
      ])
    })
    expect(calculateAutomatedPaymentFromDbMock).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'empty commitment type', field: 'egcs_fc_commitmenttype', value: '', code: 'GCS_AUTOMATED_PAYMENTS_COMMITMENT_TYPE_REQUIRED' },
    { name: 'malformed commitment type', field: 'egcs_fc_commitmenttype', value: 'commitment-1', code: 'GCS_AUTOMATED_PAYMENTS_COMMITMENT_TYPE_REQUIRED' },
    { name: 'zero commitment type', field: 'egcs_fc_commitmenttype', value: '0', code: 'GCS_AUTOMATED_PAYMENTS_COMMITMENT_TYPE_REQUIRED' },
    { name: 'negative commitment type', field: 'egcs_fc_commitmenttype', value: '-1', code: 'GCS_AUTOMATED_PAYMENTS_COMMITMENT_TYPE_REQUIRED' },
    { name: 'leading-zero commitment type', field: 'egcs_fc_commitmenttype', value: '01', code: 'GCS_AUTOMATED_PAYMENTS_COMMITMENT_TYPE_REQUIRED' },
    { name: 'overflow commitment type', field: 'egcs_fc_commitmenttype', value: '9223372036854775808', code: 'GCS_AUTOMATED_PAYMENTS_COMMITMENT_TYPE_REQUIRED' },
    { name: 'repeated commitment types', field: 'egcs_fc_commitmenttype', value: ['1', '2'], code: 'GCS_AUTOMATED_PAYMENTS_COMMITMENT_TYPE_REQUIRED' },
    { name: 'empty fiscal year', field: 'egcs_fc_fiscalyear', value: '', code: 'GCS_AUTOMATED_PAYMENTS_FISCAL_YEAR_REQUIRED' },
    { name: 'malformed fiscal year', field: 'egcs_fc_fiscalyear', value: 'fy-1', code: 'GCS_AUTOMATED_PAYMENTS_FISCAL_YEAR_REQUIRED' },
    { name: 'repeated fiscal years', field: 'egcs_fc_fiscalyear', value: [validFiscalYearId, validFiscalYearId], code: 'GCS_AUTOMATED_PAYMENTS_FISCAL_YEAR_REQUIRED' }
  ])('rejects $name without querying the calculator database', async ({ field, value, code }) => {
    readBodyMock.mockResolvedValueOnce({ ...validBody, [field]: value })
    const handler = (await import('../../server/api/calculate-payment.post')).default

    await expect(handler(createRouteEvent({
      params: { agreementId: 'agreement-1' },
      $db: {}
    }))).rejects.toMatchObject({
      code: 'GCS_AUTOMATED_PAYMENTS_INVALID_CALCULATION_INPUT',
      statusCode: 400,
      details: [expect.objectContaining({ path: field, code })]
    })
    expect(calculateAutomatedPaymentFromDbMock).not.toHaveBeenCalled()
  })

  it('passes validated payment fields, extension payload, and stream config to the calculator', async () => {
    const result = {
      enabled: true,
      baseAmount: 100,
      ceilingAmount: 90,
      suggestedAmount: 90,
      holdbackAmount: 10,
      holdbackReleaseAmount: 5,
      availableBeforeHoldback: 85,
      currency: 'CAD',
      details: []
    }
    const db = {}
    const streamConfig = { enabledPaymentTypes: ['advance'] }
    readBodyMock.mockResolvedValueOnce({
      ...validBody,
      extensions: {
        'gcs-automated-payments': {
          releaseHoldback: true,
          holdbackReleaseAmount: '5.25'
        }
      }
    })
    calculateAutomatedPaymentFromDbMock.mockResolvedValueOnce(result)
    const handler = (await import('../../server/api/calculate-payment.post')).default

    await expect(handler(createRouteEvent({
      params: { agreementId: 'agreement-1' },
      $db: db,
      gcsExtension: { config: streamConfig }
    }))).resolves.toBe(result)
    expect(calculateAutomatedPaymentFromDbMock).toHaveBeenCalledWith(db, {
      agreementId: 'agreement-1',
      commitmentType: validCommitmentTypeId,
      fiscalYearId: validFiscalYearId,
      paymentType: 'advance',
      periodEnd: 3,
      submittedAmount: 90.5,
      releaseHoldback: true,
      holdbackReleaseAmount: 5.25
    }, streamConfig)
  })
})
