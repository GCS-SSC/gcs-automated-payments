import { sql, type Kysely } from 'kysely'
import type { GcsExtensionAgreementFinancials } from '@gcs-ssc/extensions/server'
import {
  EXTENSION_KEY, AutomatedPaymentCurrencySchema, ZERO_AUTOMATED_PAYMENT_MONEY,
  parseAutomatedPaymentExtensionPayload, parseAutomatedPaymentsStreamConfig,
  parseAutomatedPaymentAggregateMoney, parseAutomatedPaymentMoney,
  type AutomatedPaymentMoney, type AutomatedPaymentMoneyInput, type AutomatedPaymentCalculationResult
} from '../shared/automated-payments.ts'
import { AutomatedPaymentCalculationEvidenceSchema, type AutomatedPaymentCalculationEvidence } from '../shared/automated-payments.ts'
import { createAutomatedPaymentUserError } from './errors'

type Db = Kysely<Record<string, Record<string, unknown>>>
const PAYMENT_METADATA_KEY = 'payment-metadata'

export interface AutomatedPaymentServerInput {
  currency?: string
  agreementId: string
  commitmentType: string
  fiscalYearId: string
  paymentType: 'reimbursement' | 'advance'
  periodEnd: number
  submittedAmount?: AutomatedPaymentMoneyInput
  releaseHoldback?: boolean
  holdbackReleaseAmount?: AutomatedPaymentMoneyInput
  excludePaymentId?: string
}
export interface AutomatedPaymentServerCalculation extends AutomatedPaymentCalculationResult { enabled: boolean }

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

/** Consumes host-owned financial inputs; the extension owns only its activation and presentation. */
export const calculateAutomatedPaymentFromDb = async (
  _db: Db,
  input: AutomatedPaymentServerInput,
  streamConfig: unknown,
  agreementFinancials: Pick<GcsExtensionAgreementFinancials, 'getPaymentCalculation'>
): Promise<AutomatedPaymentServerCalculation> => {
  const currency = AutomatedPaymentCurrencySchema.parse(input.currency)
  if (!parseAutomatedPaymentsStreamConfig(streamConfig).enabledPaymentTypes.includes(input.paymentType)) {
    return { enabled: false, baseAmount: ZERO_AUTOMATED_PAYMENT_MONEY, ceilingAmount: ZERO_AUTOMATED_PAYMENT_MONEY,
      suggestedAmount: ZERO_AUTOMATED_PAYMENT_MONEY, holdbackAmount: ZERO_AUTOMATED_PAYMENT_MONEY,
      holdbackReleaseAmount: ZERO_AUTOMATED_PAYMENT_MONEY, availableBeforeHoldback: ZERO_AUTOMATED_PAYMENT_MONEY,
      currency: currency.toUpperCase(), details: [] }
  }
  const result = await agreementFinancials.getPaymentCalculation({
    currency, fiscalYearId: input.fiscalYearId, commitmentTypeId: input.commitmentType,
    paymentType: input.paymentType, periodEnd: input.periodEnd,
    releaseHoldback: input.releaseHoldback,
    holdbackReleaseAmount: input.holdbackReleaseAmount === undefined ? undefined : parseAutomatedPaymentMoney(input.holdbackReleaseAmount),
    ...(input.excludePaymentId ? { excludePaymentId: input.excludePaymentId } : {})
  })
  const amount = (value: string) => parseAutomatedPaymentAggregateMoney(value)
  const labels = ['baseAmount', 'commitmentRemaining', 'availableBeforeHoldback', 'holdbackReleaseAmount',
    'totalClaimsToLastClaimMonth', 'totalForecastToLastClaimMonth', 'totalForecastToPeriodEnd', 'totalPaymentsToDate'] as const
  return { enabled: true, baseAmount: amount(result.baseAmount), ceilingAmount: amount(result.ceilingAmount),
    suggestedAmount: amount(result.suggestedAmount), holdbackAmount: amount(result.holdbackAmount),
    holdbackReleaseAmount: amount(result.holdbackReleaseAmount), availableBeforeHoldback: amount(result.availableBeforeHoldback),
    currency: result.currency.toUpperCase(), details: labels.map(label => ({ label, value: amount(result[label]) })) }
}
