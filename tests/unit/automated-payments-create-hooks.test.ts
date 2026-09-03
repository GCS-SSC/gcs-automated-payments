import { beforeEach, describe, expect, it, vi } from 'vitest'

const registerGcsExtensionCreateOperationHandlerMock = vi.fn()
const registerGcsExtensionAgreementPaymentMutationGuardMock = vi.fn()
const lifecycleHookMock = vi.fn()
const calculateAutomatedPaymentFromDbMock = vi.fn()
const savePaymentMetadataMock = vi.fn()
const getPaymentMetadataMock = vi.fn()
const lockAutomatedPaymentAgreementMock = vi.fn()
const guardAutomatedPaymentsActivationMock = vi.fn()
const validCommitmentTypeId = '9223372036854775807'
const validFiscalYearId = '1'

vi.mock('@gcs-ssc/extensions/server', () => ({
  createGcsExtensionUserError: (options: Record<string, unknown>) => Object.assign(new Error(String(options.message)), options),
  defineGcsExtensionNitroPlugin: (plugin: unknown) => plugin,
  registerGcsExtensionAgreementPaymentMutationGuard: (...args: unknown[]) =>
    registerGcsExtensionAgreementPaymentMutationGuardMock(...args),
  registerGcsExtensionCreateOperationHandler: (...args: unknown[]) =>
    registerGcsExtensionCreateOperationHandlerMock(...args)
}))

vi.mock('../../server/calculation-data', () => ({
  calculateAutomatedPaymentFromDb: (...args: unknown[]) => calculateAutomatedPaymentFromDbMock(...args),
  getPaymentMetadata: (...args: unknown[]) => getPaymentMetadataMock(...args),
  lockAutomatedPaymentAgreement: (...args: unknown[]) => lockAutomatedPaymentAgreementMock(...args),
  savePaymentMetadata: (...args: unknown[]) => savePaymentMetadataMock(...args)
}))

vi.mock('../../server/activation', () => ({
  guardAutomatedPaymentsActivation: (...args: unknown[]) => guardAutomatedPaymentsActivationMock(...args)
}))

const validBody = {
  egcs_fc_commitmenttype: validCommitmentTypeId,
  egcs_fc_fiscalyear: validFiscalYearId,
  egcs_fc_paymenttype: 'advance',
  egcs_fc_periodstart: 1,
  egcs_fc_periodend: 3,
  egcs_fc_paymentamount: '100.00',
  extensions: {
    'gcs-automated-payments': {
      releaseHoldback: true,
      holdbackReleaseAmount: '10.00'
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
      ceilingAmount: '100.00',
      holdbackReleaseAmount: '8.00'
    })
    getPaymentMetadataMock.mockResolvedValue({ releaseHoldback: true, holdbackReleaseAmount: '12.00' })
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

  it.each([
    { name: 'empty commitment type', field: 'egcs_fc_commitmenttype', value: '' },
    { name: 'malformed commitment type', field: 'egcs_fc_commitmenttype', value: 'commitment-1' },
    { name: 'zero commitment type', field: 'egcs_fc_commitmenttype', value: '0' },
    { name: 'negative commitment type', field: 'egcs_fc_commitmenttype', value: '-1' },
    { name: 'leading-zero commitment type', field: 'egcs_fc_commitmenttype', value: '01' },
    { name: 'overflow commitment type', field: 'egcs_fc_commitmenttype', value: '9223372036854775808' },
    { name: 'repeated commitment types', field: 'egcs_fc_commitmenttype', value: ['1', '2'] },
    { name: 'empty fiscal year', field: 'egcs_fc_fiscalyear', value: '' },
    { name: 'malformed fiscal year', field: 'egcs_fc_fiscalyear', value: 'fy-1' },
    { name: 'repeated fiscal years', field: 'egcs_fc_fiscalyear', value: [validFiscalYearId, validFiscalYearId] }
  ])('does not lock or query for $name in the create hook', async ({ field, value }) => {
    const handler = await loadHandler()

    await expect(handler({
      phase: 'before-create',
      validatedBody: { ...validBody, [field]: value },
      trx: {},
      agreementId: 'agreement-1',
      config: {}
    })).resolves.toEqual({ status: 'continue' })
    expect(lockAutomatedPaymentAgreementMock).not.toHaveBeenCalled()
    expect(calculateAutomatedPaymentFromDbMock).not.toHaveBeenCalled()
    expect(savePaymentMetadataMock).not.toHaveBeenCalled()
  })

  it('validates before-create payment amounts against the calculated ceiling', async () => {
    calculateAutomatedPaymentFromDbMock.mockResolvedValueOnce({
      enabled: true,
      ceilingAmount: '50.00',
      holdbackReleaseAmount: '0.00'
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
      commitmentType: validCommitmentTypeId,
      fiscalYearId: validFiscalYearId,
      submittedAmount: '100.00',
      releaseHoldback: true,
      holdbackReleaseAmount: '10.00'
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
      holdbackReleaseAmount: '8.00'
    })
  })

  it('propagates after-create calculation failures so the host transaction rolls back', async () => {
    const failure = new Error('calculation provider failed')
    calculateAutomatedPaymentFromDbMock.mockRejectedValueOnce(failure)
    const handler = await loadHandler()

    await expect(handler({
      phase: 'after-create',
      validatedBody: validBody,
      trx: {},
      agreementId: 'agreement-1',
      createdRecord: { id: 'payment-1' },
      config: {}
    })).rejects.toBe(failure)
    expect(savePaymentMetadataMock).not.toHaveBeenCalled()
  })

  it('validates updates against the selected commitment and persisted holdback metadata', async () => {
    await loadHandler()
    const guard = registerGcsExtensionAgreementPaymentMutationGuardMock.mock.calls[0]?.[1] as
      (context: Record<string, unknown>) => Promise<void>
    const responses = [
      {
        egcs_fc_fiscalyear: 'fy-1',
        egcs_fc_paymenttype: 'advance',
        egcs_fc_periodend: 3,
        egcs_fc_paymentamount: '40.00',
        egcs_fc_fundingagreementcommitment: 'commitment-1'
      },
      { commitment_type: 'type-2', stream_id: 'stream-2' },
      { config: { enabledPaymentTypes: ['advance'] } }
    ]
    const query = new Proxy({}, {
      get: (_target, property) => property === 'executeTakeFirst'
        ? async () => responses.shift()
        : () => query
    })
    const db = { selectFrom: () => query }
    calculateAutomatedPaymentFromDbMock.mockResolvedValueOnce({
      enabled: true,
      ceilingAmount: '50.00',
      holdbackReleaseAmount: '12.00'
    })

    await expect(guard({
      operation: 'payment.update',
      db,
      agreementId: 'agreement-1',
      paymentId: 'payment-1',
      changes: {
        egcs_fc_fundingagreementcommitment: 'commitment-2',
        egcs_fc_paymentamount: '50.01'
      }
    })).rejects.toMatchObject({ code: 'GCS_AUTOMATED_PAYMENTS_AMOUNT_EXCEEDS_CEILING' })
    expect(getPaymentMetadataMock).toHaveBeenCalledWith(db, 'payment-1')
    expect(calculateAutomatedPaymentFromDbMock).toHaveBeenCalledWith(db, expect.objectContaining({
      commitmentType: 'type-2',
      releaseHoldback: true,
      holdbackReleaseAmount: '12.00',
      submittedAmount: '50.01',
      excludePaymentId: 'payment-1'
    }), { enabledPaymentTypes: ['advance'] })
  })

  it.each([
    { name: 'a different operation', operation: 'payment.delete', responses: [] },
    { name: 'a missing payment', operation: 'payment.update', responses: [undefined] },
    {
      name: 'a missing replacement commitment',
      operation: 'payment.update',
      responses: [{ egcs_fc_fundingagreementcommitment: 'commitment-1' }, undefined]
    },
    {
      name: 'a disabled stream configuration',
      operation: 'payment.update',
      responses: [
        { egcs_fc_fundingagreementcommitment: 'commitment-1' },
        { commitment_type: 'type-1', stream_id: 'stream-1' },
        undefined
      ]
    }
  ])('leaves $name outside the update ceiling calculation', async ({ operation, responses }) => {
    await loadHandler()
    const guard = registerGcsExtensionAgreementPaymentMutationGuardMock.mock.calls[0]?.[1] as
      (context: Record<string, unknown>) => Promise<void>
    const pending = [...responses]
    const query = new Proxy({}, {
      get: (_target, property) => property === 'executeTakeFirst'
        ? async () => pending.shift()
        : () => query
    })
    const db = { selectFrom: vi.fn(() => query) }

    await expect(guard({
      operation,
      db,
      agreementId: 'agreement-1',
      paymentId: 'payment-1'
    })).resolves.toBeUndefined()
    expect(lockAutomatedPaymentAgreementMock).toHaveBeenCalledWith(db, 'agreement-1')
    expect(calculateAutomatedPaymentFromDbMock).not.toHaveBeenCalled()
  })

  it.each([
    'payment.update',
    'payment.delete',
    'payment.status-change',
    'payment-line.create',
    'payment-line.update',
    'payment-line.delete'
  ])('takes the Agreement advisory lock before %s', async operation => {
    await loadHandler()
    const guard = registerGcsExtensionAgreementPaymentMutationGuardMock.mock.calls[0]?.[1] as
      (context: Record<string, unknown>) => Promise<void>
    const query = new Proxy({}, {
      get: (_target, property) => property === 'executeTakeFirst' ? async () => undefined : () => query
    })
    const db = { selectFrom: vi.fn(() => query) }

    await guard({ operation, db, agreementId: 'agreement-1', paymentId: 'payment-1' })

    expect(lockAutomatedPaymentAgreementMock).toHaveBeenCalledOnce()
    expect(lockAutomatedPaymentAgreementMock).toHaveBeenCalledWith(db, 'agreement-1')
  })

  it('allows an enabled update whose persisted amount remains within the ceiling', async () => {
    await loadHandler()
    const guard = registerGcsExtensionAgreementPaymentMutationGuardMock.mock.calls[0]?.[1] as
      (context: Record<string, unknown>) => Promise<void>
    const responses = [
      {
        egcs_fc_fiscalyear: 'fy-1',
        egcs_fc_paymenttype: 'advance',
        egcs_fc_periodend: 3,
        egcs_fc_paymentamount: '50.00',
        egcs_fc_fundingagreementcommitment: 'commitment-1'
      },
      { commitment_type: 'type-1', stream_id: 'stream-1' },
      { config: { enabledPaymentTypes: ['advance'] } }
    ]
    const query = new Proxy({}, {
      get: (_target, property) => property === 'executeTakeFirst'
        ? async () => responses.shift()
        : () => query
    })
    const db = { selectFrom: () => query }
    calculateAutomatedPaymentFromDbMock.mockResolvedValueOnce({
      enabled: true,
      ceilingAmount: '50.00',
      holdbackReleaseAmount: '0.00'
    })

    await expect(guard({
      operation: 'payment.update',
      db,
      agreementId: 'agreement-1',
      paymentId: 'payment-1'
    })).resolves.toBeUndefined()
  })
})
