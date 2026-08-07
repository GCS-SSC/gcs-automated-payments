import { beforeEach, describe, expect, it, vi } from 'vitest'

const registerGcsExtensionCreateOperationHandlerMock = vi.fn()
const lifecycleHookMock = vi.fn()
const calculateAutomatedPaymentFromDbMock = vi.fn()
const savePaymentMetadataMock = vi.fn()
const guardAutomatedPaymentsActivationMock = vi.fn()

vi.mock('@gcs-ssc/extensions/server', () => ({
  createGcsExtensionUserError: (options: Record<string, unknown>) => Object.assign(new Error(String(options.message)), options),
  defineGcsExtensionNitroPlugin: (plugin: unknown) => plugin,
  registerGcsExtensionCreateOperationHandler: (...args: unknown[]) =>
    registerGcsExtensionCreateOperationHandlerMock(...args)
}))

vi.mock('../../server/calculation-data', () => ({
  calculateAutomatedPaymentFromDb: (...args: unknown[]) => calculateAutomatedPaymentFromDbMock(...args),
  savePaymentMetadata: (...args: unknown[]) => savePaymentMetadataMock(...args)
}))

vi.mock('../../server/activation', () => ({
  guardAutomatedPaymentsActivation: (...args: unknown[]) => guardAutomatedPaymentsActivationMock(...args)
}))

const validBody = {
  egcs_fc_commitmenttype: 'commitment-1',
  egcs_fc_fiscalyear: 'fy-1',
  egcs_fc_paymenttype: 'advance',
  egcs_fc_periodstart: 1,
  egcs_fc_periodend: 3,
  egcs_fc_paymentamount: 100,
  extensions: {
    'gcs-automated-payments': {
      releaseHoldback: true,
      holdbackReleaseAmount: 10
    }
  }
}

const loadHandler = async () => {
  const plugin = (await import('../../server/plugins/create-hooks')).default as (nitroApp: unknown) => void
  plugin({ hooks: { hook: lifecycleHookMock } })
  return registerGcsExtensionCreateOperationHandlerMock.mock.calls[0]?.[2] as (context: Record<string, unknown>) => Promise<unknown>
}

describe('gcs automated payments create hooks', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('defineNitroPlugin', (plugin: unknown) => plugin)
    calculateAutomatedPaymentFromDbMock.mockResolvedValue({
      enabled: true,
      ceilingAmount: 100,
      holdbackReleaseAmount: 8
    })
  })

  it('registers the extension activation guard hook', async () => {
    await loadHandler()

    expect(lifecycleHookMock).toHaveBeenCalledWith(
      'gcs:extension:enable-guard',
      expect.any(Function)
    )
  })

  it('validates only automated-payments stream activation requests', async () => {
    await loadHandler()
    const guard = lifecycleHookMock.mock.calls[0]?.[1] as (context: Record<string, unknown>) => Promise<void>
    const db = {}

    await guard({
      extensionKey: 'gcs-automated-payments',
      scope: 'stream',
      streamId: 'stream-1',
      db
    })
    await guard({
      extensionKey: 'another-extension',
      scope: 'stream',
      streamId: 'stream-2',
      db
    })
    await guard({
      extensionKey: 'gcs-automated-payments',
      scope: 'agency',
      agencyId: 'agency-1',
      db
    })

    expect(guardAutomatedPaymentsActivationMock).toHaveBeenCalledOnce()
    expect(guardAutomatedPaymentsActivationMock).toHaveBeenCalledWith(db, 'stream-1')
  })

  it('continues when the host body is not a payment calculation payload', async () => {
    const handler = await loadHandler()

    await expect(handler({
      validatedBody: {},
      trx: {},
      agreementId: 'agreement-1',
      config: {}
    })).resolves.toEqual({ status: 'continue' })
    expect(calculateAutomatedPaymentFromDbMock).not.toHaveBeenCalled()
  })

  it('validates before-create payment amounts against the calculated ceiling', async () => {
    calculateAutomatedPaymentFromDbMock.mockResolvedValueOnce({
      enabled: true,
      ceilingAmount: 50,
      holdbackReleaseAmount: 0
    })
    const handler = await loadHandler()

    await expect(handler({
      phase: 'before-create',
      validatedBody: validBody,
      trx: {},
      agreementId: 'agreement-1',
      config: { enabledPaymentTypes: ['advance'] }
    })).rejects.toMatchObject({
      code: 'GCS_AUTOMATED_PAYMENTS_AMOUNT_EXCEEDS_CEILING',
      details: [expect.objectContaining({ path: 'egcs_fc_paymentamount' })]
    })
    expect(calculateAutomatedPaymentFromDbMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      agreementId: 'agreement-1',
      submittedAmount: 100,
      releaseHoldback: true,
      holdbackReleaseAmount: 10
    }), { enabledPaymentTypes: ['advance'] })
  })

  it('continues without validating ceilings outside the before-create phase', async () => {
    const handler = await loadHandler()

    await expect(handler({
      phase: 'after-create',
      validatedBody: validBody,
      trx: {},
      agreementId: 'agreement-1',
      config: {}
    })).resolves.toEqual({ status: 'continue' })
    expect(calculateAutomatedPaymentFromDbMock).not.toHaveBeenCalled()
  })

  it('saves holdback metadata after a payment record is created', async () => {
    const trx = {}
    const handler = await loadHandler()

    await expect(handler({
      phase: 'after-create',
      validatedBody: validBody,
      trx,
      agreementId: 'agreement-1',
      createdRecord: { id: 'payment-1' },
      config: {}
    })).resolves.toEqual({ status: 'continue' })
    expect(calculateAutomatedPaymentFromDbMock).toHaveBeenCalledWith(trx, expect.objectContaining({
      excludePaymentId: 'payment-1'
    }), {})
    expect(savePaymentMetadataMock).toHaveBeenCalledWith(trx, 'payment-1', {
      releaseHoldback: true,
      holdbackReleaseAmount: 8
    })
  })
})
