import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAutomatedPaymentUserError } from '../../server/errors'

const agencyConfig = { creditMemoBasis: 'reconciled-periods' }
const registerGcsExtensionConfigurationGuardMock = vi.fn()
const registerGcsExtensionCreateOperationHandlerMock = vi.fn()
const registerGcsExtensionAgreementPaymentMutationGuardMock = vi.fn()
const lifecycleHookMock = vi.fn()
const calculateAutomatedPaymentFromDbMock = vi.fn()
const savePaymentMetadataMock = vi.fn()
const getPaymentMetadataMock = vi.fn()
const lockAutomatedPaymentAgreementMock = vi.fn()
const guardAutomatedPaymentsActivationMock = vi.fn()
const financials = { getCommitmentPaymentCapacity: vi.fn() }
const validCommitmentTypeId = '9223372036854775807'
const validFiscalYearId = '1'

vi.mock('@gcs-ssc/extensions/server', () => ({
  createGcsExtensionUserError: (options: Record<string, unknown>) => Object.assign(new Error(String(options.message)), options),
  defineGcsExtensionNitroPlugin: (plugin: unknown) => plugin,
  requireGcsExtensionAgreementFinancials: () => financials,
  registerGcsExtensionConfigurationGuard: (...args: unknown[]) => registerGcsExtensionConfigurationGuardMock(...args),
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
    expect(registerGcsExtensionConfigurationGuardMock).toHaveBeenCalledWith('gcs-automated-payments', expect.any(Function), expect.anything())
  })
  it.each([undefined, {}, { creditMemoBasis: 'other' }])('refuses enabled agency configuration without an explicit credit choice: %j', async config => {
    await loadHandler()
    const guard = registerGcsExtensionConfigurationGuardMock.mock.calls[0]?.[1] as (context: Record<string, unknown>) => void
    expect(() => guard({ targetExtensionKey: 'gcs-automated-payments', scope: 'agency', enabled: true, config })).toThrow()
  })
  it.each(['all', 'reconciled-periods'])('accepts the explicit agency credit choice %s', async creditMemoBasis => {
    await loadHandler()
    const guard = registerGcsExtensionConfigurationGuardMock.mock.calls[0]?.[1] as (context: Record<string, unknown>) => void
    expect(() => guard({ targetExtensionKey: 'gcs-automated-payments', scope: 'agency', enabled: true, config: { creditMemoBasis } })).not.toThrow()
  })
  it.each([
    { targetExtensionKey: 'another-extension', scope: 'agency', enabled: true },
    { targetExtensionKey: 'gcs-automated-payments', scope: 'stream', enabled: true },
    { targetExtensionKey: 'gcs-automated-payments', scope: 'agency', enabled: false }
  ])('leaves unrelated, stream and disabled settings outside the agency choice guard: %j', async context => {
    await loadHandler()
    const guard = registerGcsExtensionConfigurationGuardMock.mock.calls[0]?.[1] as (context: Record<string, unknown>) => void
    expect(() => guard(context)).not.toThrow()
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
      agencyConfig, validatedBody: {},
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
      agencyConfig, validatedBody: { ...validBody, [field]: value },
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
      agencyConfig, validatedBody: validBody,
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
      periodStart: 1,
      periodEnd: 3,
      submittedAmount: '100.00',
      releaseHoldback: true,
      holdbackReleaseAmount: '10.00'
    }), { enabledPaymentTypes: ['advance'] }, financials, agencyConfig)
  })

  it.each(['0.01', '75.01', '100.00'])('allows the exact selected gross amount %s up to the ceiling without substituting the suggestion', async amount => {
    const handler = await loadHandler()
    const body = { ...validBody, egcs_fc_paymentamount: amount }
    await expect(handler({
      phase: 'before-create', agencyConfig, validatedBody: body, trx: {}, agreementId: 'agreement-1',
      config: { enabledPaymentTypes: ['advance'] }
    })).resolves.toEqual({ status: 'continue' })
    expect(calculateAutomatedPaymentFromDbMock).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ submittedAmount: amount }), { enabledPaymentTypes: ['advance'] }, financials, agencyConfig)
    expect(body.egcs_fc_paymentamount).toBe(amount)
    expect(savePaymentMetadataMock).not.toHaveBeenCalled()
  })

  it('rejects a one-cent overrun at the server create boundary', async () => {
    const handler = await loadHandler()
    await expect(handler({
      phase: 'before-create', agencyConfig, validatedBody: { ...validBody, egcs_fc_paymentamount: '100.01' },
      trx: {}, agreementId: 'agreement-1', config: {}
    })).rejects.toMatchObject({ code: 'GCS_AUTOMATED_PAYMENTS_AMOUNT_EXCEEDS_CEILING',
      details: [expect.objectContaining({ path: 'egcs_fc_paymentamount' })] })
    expect(savePaymentMetadataMock).not.toHaveBeenCalled()
  })

  it('continues without validating ceilings outside the before-create phase', async () => {
    const handler = await loadHandler()

    await expect(handler({
      phase: 'after-create',
      agencyConfig, validatedBody: validBody,
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
      agencyConfig, validatedBody: validBody,
      trx,
      agreementId: 'agreement-1',
      createdRecord: { id: 'payment-1' },
      config: {}
    })).resolves.toEqual({ status: 'continue' })
    expect(calculateAutomatedPaymentFromDbMock).toHaveBeenCalledWith(trx, expect.objectContaining({
      periodStart: 1,
      periodEnd: 3,
      excludePaymentId: 'payment-1'
    }), {}, financials, agencyConfig)
    expect(savePaymentMetadataMock).toHaveBeenCalledWith(trx, 'payment-1', {
      releaseHoldback: true,
      holdbackReleaseAmount: '8.00',
      calculationEvidence: expect.objectContaining({ version: 1, capturedAt: expect.any(String), input: expect.objectContaining({ periodStart: 1, periodEnd: 3, creditMemoBasis: 'reconciled-periods' }), calculation: expect.objectContaining({ holdbackReleaseAmount: '8.00' }) })
    })
  })

  it('propagates after-create calculation failures so the host transaction rolls back', async () => {
    const failure = new Error('calculation provider failed')
    calculateAutomatedPaymentFromDbMock.mockRejectedValueOnce(failure)
    const handler = await loadHandler()

    await expect(handler({
      phase: 'after-create',
      agencyConfig, validatedBody: validBody,
      trx: {},
      agreementId: 'agreement-1',
      createdRecord: { id: 'payment-1' },
      config: {}
    })).rejects.toBe(failure)
    expect(savePaymentMetadataMock).not.toHaveBeenCalled()
  })

  it('does not retain an unauthored zero calculation when this payment type is disabled', async () => {
    calculateAutomatedPaymentFromDbMock.mockResolvedValueOnce({ enabled: false, holdbackReleaseAmount: '0.00' })
    const handler = await loadHandler()
    await handler({ phase: 'after-create', agencyConfig, validatedBody: validBody, trx: {}, agreementId: '1',
      createdRecord: { id: '1' }, config: {} })
    expect(savePaymentMetadataMock).toHaveBeenCalledWith(expect.anything(), '1', {
      releaseHoldback: true, holdbackReleaseAmount: '0.00'
    })
  })

  it('validates updates against the selected commitment and persisted holdback metadata', async () => {
    await loadHandler()
    const guard = registerGcsExtensionAgreementPaymentMutationGuardMock.mock.calls[0]?.[1] as
      (context: Record<string, unknown>) => Promise<void>
    const responses = [
      {
        egcs_fc_fiscalyear: 'fy-1',
        egcs_fc_paymenttype: 'advance',
        egcs_fc_periodstart: 1,
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
      operation: 'payment.update', agencyEnabled: true, agencyConfig,
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
      periodStart: 1,
      periodEnd: 3,
      releaseHoldback: true,
      holdbackReleaseAmount: '12.00',
      submittedAmount: '50.01',
      excludePaymentId: 'payment-1'
    }), { enabledPaymentTypes: ['advance'] }, financials, agencyConfig)
  })

  it('keeps manual Payment updates available when Agency automation is disabled and has no credit choice', async () => {
    await loadHandler()
    const guard = registerGcsExtensionAgreementPaymentMutationGuardMock.mock.calls[0]?.[1] as (context: Record<string, unknown>) => Promise<void>
    const db = { selectFrom: vi.fn(() => { throw new Error('Disabled automation must not read calculation sources') }) }
    await expect(guard({ operation: 'payment.update', agencyEnabled: false, agencyConfig: {},
      db, agreementId: '1', paymentId: '1', changes: { egcs_fc_paymentamount: '50.00' } })).resolves.toBeUndefined()
    expect(lockAutomatedPaymentAgreementMock).toHaveBeenCalledWith(db, '1')
    expect(db.selectFrom).not.toHaveBeenCalled()
    expect(getPaymentMetadataMock).not.toHaveBeenCalled()
    expect(calculateAutomatedPaymentFromDbMock).not.toHaveBeenCalled()
  })

  it('still rejects Payment updates when Agency automation is enabled without a credit choice', async () => {
    await loadHandler()
    const guard = registerGcsExtensionAgreementPaymentMutationGuardMock.mock.calls[0]?.[1] as (context: Record<string, unknown>) => Promise<void>
    const responses = [{ egcs_fc_fiscalyear: '1', egcs_fc_paymenttype: 'advance', egcs_fc_periodstart: 0, egcs_fc_periodend: 2,
      egcs_fc_paymentamount: '50.00', egcs_fc_currency: 'cad', egcs_fc_fundingagreementcommitment: '1' },
      { commitment_type: '2', stream_id: '1' }, { config: {} }]
    const query = new Proxy({}, { get: (_target, property) => property === 'executeTakeFirst' ? async () => responses.shift() : () => query })
    const db = { selectFrom: () => query }
    const missingChoice = createAutomatedPaymentUserError('GCS_AUTOMATED_PAYMENTS_CREDIT_MEMO_BASIS_REQUIRED', 'creditMemoBasis')
    calculateAutomatedPaymentFromDbMock.mockRejectedValueOnce(missingChoice)
    await expect(guard({ operation: 'payment.update', agencyEnabled: true, agencyConfig: {},
      db, agreementId: '1', paymentId: '1' })).rejects.toBe(missingChoice)
    expect(calculateAutomatedPaymentFromDbMock).toHaveBeenCalledWith(db, expect.anything(), {}, financials, {})
  })

  it.each([
    { name: 'a different operation', operation: 'payment.delete', responses: [] },
    { name: 'a missing payment', operation: 'payment.update', agencyEnabled: true, agencyConfig, responses: [undefined] },
    {
      name: 'a missing replacement commitment',
      operation: 'payment.update', agencyEnabled: true, agencyConfig,
      responses: [{ egcs_fc_fundingagreementcommitment: 'commitment-1' }, undefined]
    },
    {
      name: 'a disabled stream configuration',
      operation: 'payment.update', agencyEnabled: true, agencyConfig,
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
      operation, agencyEnabled: true, agencyConfig,
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

    await guard({ operation, agencyEnabled: true, agencyConfig, db, agreementId: 'agreement-1', paymentId: 'payment-1' })

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
        egcs_fc_periodstart: 1,
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
      operation: 'payment.update', agencyEnabled: true, agencyConfig,
      db,
      agreementId: 'agreement-1',
      paymentId: 'payment-1'
    })).resolves.toBeUndefined()
  })

  it('calculates USD creation and saves existing release metadata without replacing the native currency', async () => {
    const handler = await loadHandler()
    const body = { ...validBody, egcs_fc_currency: 'usd' }
    await handler({ phase: 'before-create', agencyConfig, validatedBody: body, trx: {}, agreementId: '1', config: {} })
    await handler({ phase: 'after-create', agencyConfig, validatedBody: body, createdRecord: { id: '1', egcs_fc_currency: 'usd' }, trx: {}, agreementId: '1', config: {} })
    expect(calculateAutomatedPaymentFromDbMock).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({ currency: 'usd' }), {}, financials, agencyConfig)
    expect(calculateAutomatedPaymentFromDbMock).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({ currency: 'usd', excludePaymentId: '1' }), {}, financials, agencyConfig)
    expect(body.egcs_fc_currency).toBe('usd')
    expect(savePaymentMetadataMock).toHaveBeenCalledWith(expect.anything(), '1', expect.objectContaining({ releaseHoldback: true, holdbackReleaseAmount: '8.00', calculationEvidence: expect.objectContaining({ input: expect.objectContaining({ currency: 'usd' }) }) }))
  })

  it('rejects a created payment currency different from its validated request before saving metadata', async () => {
    const handler = await loadHandler()
    await expect(handler({ phase: 'after-create', agencyConfig, validatedBody: { ...validBody, egcs_fc_currency: 'usd' },
      createdRecord: { id: '1', egcs_fc_currency: 'cad' }, trx: {}, agreementId: '1', config: {} }))
      .rejects.toMatchObject({ code: 'GCS_AUTOMATED_PAYMENTS_CURRENCY_MISMATCH', details: [expect.objectContaining({ path: 'egcs_fc_currency' })] })
    expect(calculateAutomatedPaymentFromDbMock).not.toHaveBeenCalled()
    expect(savePaymentMetadataMock).not.toHaveBeenCalled()
  })

  it.each([undefined, 'eur'])('recalculates updates in their saved or changed currency %j', async nextCurrency => {
    await loadHandler()
    const guard = registerGcsExtensionAgreementPaymentMutationGuardMock.mock.calls[0]?.[1] as (context: Record<string, unknown>) => Promise<void>
    const responses = [{ egcs_fc_fiscalyear: '1', egcs_fc_paymenttype: 'advance', egcs_fc_periodstart: 0, egcs_fc_periodend: 0,
      egcs_fc_paymentamount: '50.00', egcs_fc_currency: 'usd', egcs_fc_fundingagreementcommitment: '1' },
      { commitment_type: '2', stream_id: '1' }, { config: {} }]
    const query = new Proxy({}, { get: (_target, property) => property === 'executeTakeFirst' ? async () => responses.shift() : () => query })
    await guard({ operation: 'payment.update', agencyEnabled: true, agencyConfig, db: { selectFrom: () => query }, agreementId: '1', paymentId: '1',
      changes: nextCurrency ? { egcs_fc_currency: nextCurrency } : {} })
    expect(calculateAutomatedPaymentFromDbMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ currency: nextCurrency ?? 'usd', excludePaymentId: '1' }), {}, financials, agencyConfig)
  })
  it('recalculates updates with their changed start month', async () => {
    await loadHandler()
    const guard = registerGcsExtensionAgreementPaymentMutationGuardMock.mock.calls[0]?.[1] as (context: Record<string, unknown>) => Promise<void>
    const responses = [{ egcs_fc_fiscalyear: '1', egcs_fc_paymenttype: 'advance', egcs_fc_periodstart: 0, egcs_fc_periodend: 5,
      egcs_fc_paymentamount: '50.00', egcs_fc_currency: 'cad', egcs_fc_fundingagreementcommitment: '1' },
      { commitment_type: '2', stream_id: '1' }, { config: {} }]
    const query = new Proxy({}, { get: (_target, property) => property === 'executeTakeFirst' ? async () => responses.shift() : () => query })
    await guard({ operation: 'payment.update', agencyEnabled: true, agencyConfig, db: { selectFrom: () => query }, agreementId: '1', paymentId: '1',
      changes: { egcs_fc_periodstart: 3 } })
    expect(calculateAutomatedPaymentFromDbMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ periodStart: 3, periodEnd: 5 }), {}, financials, agencyConfig)
  })
})
