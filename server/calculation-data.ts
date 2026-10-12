import { sql, type Kysely } from 'kysely'
import type { GcsExtensionAgreementFinancials } from '@gcs-ssc/extensions/server'
import { isGcsExtensionUserError } from '@gcs-ssc/extensions/server'
import {
  EXTENSION_KEY, AutomatedPaymentCurrencySchema, ZERO_AUTOMATED_PAYMENT_MONEY,
  AutomatedPaymentsAgencyConfigSchema,
  parseAutomatedPaymentExtensionPayload, parseAutomatedPaymentsStreamConfig,
  parseAutomatedPaymentMoney,
  type AutomatedPaymentMoney, type AutomatedPaymentMoneyInput, type AutomatedPaymentCalculationResult, type AutomatedPaymentCreditMemoBasis
} from '../shared/automated-payments.ts'
import { AutomatedPaymentCalculationEvidenceSchema, type AutomatedPaymentCalculationEvidence } from '../shared/automated-payments.ts'
import { calculateAutomatedPaymentValues } from './payment-calculation.ts'
import { createAutomatedPaymentUserError } from './errors.ts'

type Db = Kysely<Record<string, Record<string, unknown>>>
const PAYMENT_METADATA_KEY = 'payment-metadata'

export interface AutomatedPaymentServerInput {
  currency?: string
  agreementId: string
  commitmentType: string
  fiscalYearId: string
  paymentType: 'reimbursement' | 'advance'
  periodStart: number
  periodEnd: number
  submittedAmount?: AutomatedPaymentMoneyInput
  releaseHoldback?: boolean
  holdbackReleaseAmount?: AutomatedPaymentMoneyInput
  excludePaymentId?: string
}
export interface AutomatedPaymentServerCalculation extends AutomatedPaymentCalculationResult { enabled: boolean }

/** Retains the extension's exact arithmetic basis for an authorized Payment save. */
export const buildPaymentCalculationEvidence = (
  input: AutomatedPaymentServerInput,
  calculation: AutomatedPaymentServerCalculation,
  creditMemoBasis: AutomatedPaymentCreditMemoBasis
) => ({
  version: 2,
  capturedAt: new Date().toISOString(),
  input: { fiscalYearId: input.fiscalYearId, commitmentTypeId: input.commitmentType,
    paymentType: input.paymentType, periodStart: input.periodStart, periodEnd: input.periodEnd,
    currency: AutomatedPaymentCurrencySchema.parse(input.currency), creditMemoBasis },
  calculation
})

/** Serializes ceiling-affecting payment mutations for one Agreement. */
export const lockAutomatedPaymentAgreement = async (db: Db, agreementId: string): Promise<void> => {
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${'gcs-automated-payments:agreement:' + agreementId}, 0)
    )
  `.execute(db)
}

/** Creates or updates the automated-payment metadata stored for a payment. */
export const savePaymentMetadata = async (
  db: Db,
  paymentId: string,
  value: Record<string, unknown>
) => {
  const existing = await db
    .selectFrom('extensions.kv_entry')
    .select(['id'])
    .where('extension_key', '=', EXTENSION_KEY)
    .where('owner_type', '=', 'fundingcasepayment')
    .where('owner_id', '=', paymentId)
    .where('config_key', '=', PAYMENT_METADATA_KEY)
    .where('_deleted', '=', false)
    .executeTakeFirst() as { id?: unknown } | undefined

  if (existing?.id) {
    await db
      .updateTable('extensions.kv_entry')
      .set({ value })
      .where('id', '=', String(existing.id))
      .execute()
    return
  }

  await db
    .insertInto('extensions.kv_entry')
    .values({
      extension_key: EXTENSION_KEY,
      owner_type: 'fundingcasepayment',
      owner_id: paymentId,
      config_key: PAYMENT_METADATA_KEY,
      value
    })
    .execute()
}

/** Loads the persisted holdback-release choices used by update validation. */
export const getPaymentMetadata = async (
  db: Db,
  paymentId: string
): Promise<{ releaseHoldback: boolean, holdbackReleaseAmount: AutomatedPaymentMoney }> => {
  const row = await db
    .selectFrom('extensions.kv_entry')
    .select('value')
    .where('extension_key', '=', EXTENSION_KEY)
    .where('owner_type', '=', 'fundingcasepayment')
    .where('owner_id', '=', paymentId)
    .where('config_key', '=', PAYMENT_METADATA_KEY)
    .where('_deleted', '=', false)
    .executeTakeFirst() as { value?: unknown } | undefined
  const value = parseAutomatedPaymentExtensionPayload(row?.value)
  return {
    releaseHoldback: value.releaseHoldback,
    holdbackReleaseAmount: value.holdbackReleaseAmount
  }
}

/** Returns retained creation-time calculation evidence without recomputing from live financial records. */
export const getPaymentCalculationEvidence = async (db: Db, paymentId: string): Promise<AutomatedPaymentCalculationEvidence | null> => {
  const row = await db.selectFrom('extensions.kv_entry').select('value')
    .where('extension_key', '=', EXTENSION_KEY).where('owner_type', '=', 'fundingcasepayment')
    .where('owner_id', '=', paymentId).where('config_key', '=', PAYMENT_METADATA_KEY)
    .where('_deleted', '=', false).executeTakeFirst() as { value?: unknown } | undefined
  if (!row?.value || typeof row.value !== 'object') return null
  const stored = (row.value as Record<string, unknown>).calculationEvidence
  if (stored === undefined) return null
  const parsed = AutomatedPaymentCalculationEvidenceSchema.safeParse(stored)
  if (!parsed.success) throw createAutomatedPaymentUserError('GCS_AUTOMATED_PAYMENTS_EVIDENCE_INVALID')
  return parsed.data
}

/** Consumes host-owned financial inputs; the extension owns entitlement, holdback and ceiling arithmetic. */
export const calculateAutomatedPaymentFromDb = async (
  _db: Db,
  input: AutomatedPaymentServerInput,
  streamConfig: unknown,
  agreementFinancials: Pick<GcsExtensionAgreementFinancials, 'getPaymentCalculation'>,
  agencyConfig: unknown
): Promise<AutomatedPaymentServerCalculation> => {
  const currency = AutomatedPaymentCurrencySchema.parse(input.currency)
  if (!parseAutomatedPaymentsStreamConfig(streamConfig).enabledPaymentTypes.includes(input.paymentType)) {
    return { enabled: false, baseAmount: ZERO_AUTOMATED_PAYMENT_MONEY, ceilingAmount: ZERO_AUTOMATED_PAYMENT_MONEY,
      suggestedAmount: ZERO_AUTOMATED_PAYMENT_MONEY, holdbackAmount: ZERO_AUTOMATED_PAYMENT_MONEY,
      holdbackReleaseAmount: ZERO_AUTOMATED_PAYMENT_MONEY, availableBeforeHoldback: ZERO_AUTOMATED_PAYMENT_MONEY,
      currency: currency.toUpperCase(), details: [] }
  }
  const settings = AutomatedPaymentsAgencyConfigSchema.safeParse(agencyConfig)
  if (!settings.success) {
    throw createAutomatedPaymentUserError('GCS_AUTOMATED_PAYMENTS_CREDIT_MEMO_BASIS_REQUIRED', 'creditMemoBasis')
  }
  const result = await agreementFinancials.getPaymentCalculation({
    currency, fiscalYearId: input.fiscalYearId, commitmentTypeId: input.commitmentType,
    paymentType: input.paymentType, periodStart: input.periodStart, periodEnd: input.periodEnd,
    releaseHoldback: input.releaseHoldback,
    holdbackReleaseAmount: input.holdbackReleaseAmount === undefined ? undefined : parseAutomatedPaymentMoney(input.holdbackReleaseAmount),
    ...(input.excludePaymentId ? { excludePaymentId: input.excludePaymentId } : {})
  }).catch((error: unknown) => {
    if (isGcsExtensionUserError(error) && error.code === 'AGREEMENT_CURRENCY_MISMATCH') {
      throw createAutomatedPaymentUserError('GCS_AUTOMATED_PAYMENTS_CURRENCY_MISMATCH', 'egcs_fc_currency')
    }
    throw error
  })
  return { enabled: true, ...calculateAutomatedPaymentValues(result, input, settings.data.creditMemoBasis) }
}
