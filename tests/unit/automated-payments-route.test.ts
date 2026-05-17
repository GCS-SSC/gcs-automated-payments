import { beforeEach, describe, expect, it, vi } from 'vitest'

const readBodyMock = vi.fn()
const calculateAutomatedPaymentFromDbMock = vi.fn()

vi.mock('h3', () => ({
  readBody: (...args: unknown[]) => readBodyMock(...args)
}))

vi.mock('../../server/calculation-data', () => ({
  calculateAutomatedPaymentFromDb: (...args: unknown[]) => calculateAutomatedPaymentFromDbMock(...args)
}))

describe('gcs automated payments calculation route', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('requires an agreement id before calculating', async () => {
    const handler = (await import('../../server/api/calculate-payment.post')).default

    await expect(handler({ context: { params: {} } } as never)).rejects.toMatchObject({
      code: 'GCS_AUTOMATED_PAYMENTS_AGREEMENT_REQUIRED'
    })
    expect(readBodyMock).not.toHaveBeenCalled()
    expect(calculateAutomatedPaymentFromDbMock).not.toHaveBeenCalled()
  })

  it('converts invalid route input into extension-owned validation details', async () => {
    readBodyMock.mockResolvedValueOnce({
      egcs_fc_commitmenttype: '',
      egcs_fc_fiscalyear: 'fy-1',
      egcs_fc_paymenttype: 'advance',
      egcs_fc_periodstart: 5,
      egcs_fc_periodend: 4
    })
    const handler = (await import('../../server/api/calculate-payment.post')).default

    await expect(handler({
      context: {
        params: { agreementId: 'agreement-1' },
        $db: {}
      }
    } as never)).rejects.toMatchObject({
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
      egcs_fc_commitmenttype: 'commitment-1',
      egcs_fc_fiscalyear: 'fy-1',
      egcs_fc_paymenttype: 'advance',
      egcs_fc_periodstart: 1,
      egcs_fc_periodend: 3,
      egcs_fc_paymentamount: '90.50',
      extensions: {
        'gcs-automated-payments': {
          releaseHoldback: true,
          holdbackReleaseAmount: '5.25'
        }
      }
    })
    calculateAutomatedPaymentFromDbMock.mockResolvedValueOnce(result)
    const handler = (await import('../../server/api/calculate-payment.post')).default

    await expect(handler({
      context: {
        params: { agreementId: 'agreement-1' },
        $db: db,
        gcsExtension: { config: streamConfig }
      }
    } as never)).resolves.toBe(result)
    expect(calculateAutomatedPaymentFromDbMock).toHaveBeenCalledWith(db, {
      agreementId: 'agreement-1',
      commitmentType: 'commitment-1',
      fiscalYearId: 'fy-1',
      paymentType: 'advance',
      periodEnd: 3,
      submittedAmount: 90.5,
      releaseHoldback: true,
      holdbackReleaseAmount: 5.25
    }, streamConfig)
  })
})
