/* eslint-disable jsdoc/require-jsdoc */
import type { Kysely } from 'kysely'
import {
  EXTENSION_KEY,
  calculateAutomatedPaymentAmount,
  parseAutomatedPaymentsAgreementSettings,
  parseAutomatedPaymentsStreamConfig,
  roundCurrency,
  type AutomatedPaymentCalculationResult
} from '../shared/automated-payments'

type Db = Kysely<Record<string, unknown>>

export interface AutomatedPaymentServerInput {
  agreementId: string
  commitmentType: string
  fiscalYearId: string
  paymentType: 'reimbursement' | 'advance'
  periodEnd: number
  submittedAmount?: number
  holdbackReleaseOverride?: number | null
}

export interface AutomatedPaymentServerCalculation extends AutomatedPaymentCalculationResult {
  enabled: boolean
}

const SETTINGS_KEY = 'agreement-settings'
const TERMINAL_CLAIM_RECONCILE_STATUSES = ['complete', 'approved'] as const
const NON_DENIED_PAYMENT_STATUSES = ['draft', 'inprogress', 'complete', 'pendingapproval', 'approved', 'pay', 'wait', 'processed', 'paid'] as const

const getAgreementHoldbackSettings = async (
  db: Db,
  agreementId: string
) => {
  const row = await db
    .selectFrom('Funding_Case_Agreement_Profile')
    .select([
      'egcs_fc_holdback',
      'egcs_fc_holdbackbasis'
    ])
    .where('id', '=', agreementId)
    .where('_deleted', '=', false)
    .executeTakeFirst() as {
      egcs_fc_holdback?: unknown
      egcs_fc_holdbackbasis?: unknown
    } | undefined

  return {
    holdbackPercent: Number(row?.egcs_fc_holdback ?? 0),
    holdbackBasis: row?.egcs_fc_holdbackbasis === 'final-fiscal-year' ? 'final-fiscal-year' : 'agreement-total'
  }
}

export const getAgreementSettings = async (
  db: Db,
  agreementId: string
) => {
  const row = await db
    .selectFrom('extensions.kv_entry')
    .select(['value'])
    .where('extension_key', '=', EXTENSION_KEY)
    .where('owner_type', '=', 'fundingcaseagreement')
    .where('owner_id', '=', agreementId)
    .where('config_key', '=', SETTINGS_KEY)
    .where('_deleted', '=', false)
    .executeTakeFirst() as { value?: unknown } | undefined

  return parseAutomatedPaymentsAgreementSettings(row?.value)
}

export const saveAgreementSettings = async (
  db: Db,
  agreementId: string,
  value: Record<string, unknown>
) => {
  const existing = await db
    .selectFrom('extensions.kv_entry')
    .select(['id'])
    .where('extension_key', '=', EXTENSION_KEY)
    .where('owner_type', '=', 'fundingcaseagreement')
    .where('owner_id', '=', agreementId)
    .where('config_key', '=', SETTINGS_KEY)
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
      owner_type: 'fundingcaseagreement',
      owner_id: agreementId,
      config_key: SETTINGS_KEY,
      value
    })
    .execute()
}

const sumRows = (rows: Array<{ amount?: unknown }>): number =>
  roundCurrency(rows.reduce((total, row) => total + Number(row.amount ?? 0), 0))

const getClaimTotal = async (db: Db, agreementId: string, fiscalYearId: string, periodEnd: number): Promise<number> => {
  const rows = await db
    .selectFrom('Funding_Case_Agreement_Claim_Reconcile_Line_Item')
    .innerJoin(
      'Funding_Case_Agreement_Claim_Reconcile',
      'Funding_Case_Agreement_Claim_Reconcile.id',
      'Funding_Case_Agreement_Claim_Reconcile_Line_Item.egcs_fc_fundingagreementclaimreconcile'
    )
    .innerJoin(
      'Funding_Case_Agreement_Claim',
      'Funding_Case_Agreement_Claim.id',
      'Funding_Case_Agreement_Claim_Reconcile.egcs_fc_fundingagreementclaim'
    )
    .select('Funding_Case_Agreement_Claim_Reconcile_Line_Item.egcs_fc_reconciled as amount')
    .where('Funding_Case_Agreement_Claim.egcs_fc_fundingagreement', '=', agreementId)
    .where('Funding_Case_Agreement_Claim.egcs_fc_fiscalyear', '=', fiscalYearId)
    .where('Funding_Case_Agreement_Claim.egcs_fc_periodend', '<=', periodEnd)
    .where('Funding_Case_Agreement_Claim_Reconcile.egcs_fc_status', 'in', TERMINAL_CLAIM_RECONCILE_STATUSES)
    .where('Funding_Case_Agreement_Claim._deleted', '=', false)
    .where('Funding_Case_Agreement_Claim_Reconcile._deleted', '=', false)
    .where('Funding_Case_Agreement_Claim_Reconcile_Line_Item._deleted', '=', false)
    .execute() as Array<{ amount?: unknown }>

  return sumRows(rows)
}

const getForecastTotal = async (db: Db, agreementId: string, fiscalYearId: string, periodEnd: number): Promise<number> => {
  const rows = await db
    .selectFrom('Funding_Case_Agreement_Forecast_Line_Item')
    .innerJoin(
      'Funding_Case_Agreement_Forecast',
      'Funding_Case_Agreement_Forecast.id',
      'Funding_Case_Agreement_Forecast_Line_Item.egcs_fc_agreementforecast'
    )
    .select('Funding_Case_Agreement_Forecast_Line_Item.egcs_fc_amount as amount')
    .where('Funding_Case_Agreement_Forecast.egcs_fc_fundingagreement', '=', agreementId)
    .where('Funding_Case_Agreement_Forecast.egcs_fc_fiscalyear', '=', fiscalYearId)
    .where('Funding_Case_Agreement_Forecast.egcs_fc_active', '=', true)
    .where('Funding_Case_Agreement_Forecast_Line_Item.egcs_fc_month', '<=', periodEnd)
    .where('Funding_Case_Agreement_Forecast._deleted', '=', false)
    .where('Funding_Case_Agreement_Forecast_Line_Item._deleted', '=', false)
    .execute() as Array<{ amount?: unknown }>

  return sumRows(rows)
}

const getPaymentsToDate = async (db: Db, agreementId: string, fiscalYearId: string): Promise<number> => {
  const rows = await db
    .selectFrom('Funding_Case_Agreement_Payment')
    .innerJoin(
      'Funding_Case_Agreement_Commitment',
      'Funding_Case_Agreement_Commitment.id',
      'Funding_Case_Agreement_Payment.egcs_fc_fundingagreementcommitment'
    )
    .select('Funding_Case_Agreement_Payment.egcs_fc_paymentamount as amount')
    .where('Funding_Case_Agreement_Commitment.egcs_fc_fundingagreement', '=', agreementId)
    .where('Funding_Case_Agreement_Payment.egcs_fc_fiscalyear', '=', fiscalYearId)
    .where('Funding_Case_Agreement_Payment.egcs_fc_status', 'in', NON_DENIED_PAYMENT_STATUSES)
    .where('Funding_Case_Agreement_Payment._deleted', '=', false)
    .where('Funding_Case_Agreement_Commitment._deleted', '=', false)
    .execute() as Array<{ amount?: unknown }>

  return sumRows(rows)
}

const getCommitmentRemaining = async (
  db: Db,
  agreementId: string,
  fiscalYearId: string,
  commitmentType: string
): Promise<number> => {
  const commitmentLines = await db
    .selectFrom('Funding_Case_Agreement_Commitment_Line')
    .innerJoin(
      'Funding_Case_Agreement_Commitment',
      'Funding_Case_Agreement_Commitment.id',
      'Funding_Case_Agreement_Commitment_Line.egcs_fc_commitment'
    )
    .innerJoin(
      'Transfer_Payment_Stream_Commitment',
      'Transfer_Payment_Stream_Commitment.id',
      'Funding_Case_Agreement_Commitment_Line.egcs_fc_transferpaymentstreamcommitment'
    )
    .innerJoin(
      'Transfer_Payment_Stream_Budget',
      'Transfer_Payment_Stream_Budget.id',
      'Transfer_Payment_Stream_Commitment.egcs_tp_streambudget'
    )
    .select([
      'Funding_Case_Agreement_Commitment_Line.id as id',
      'Funding_Case_Agreement_Commitment_Line.egcs_fc_amount as amount'
    ])
    .where('Funding_Case_Agreement_Commitment.egcs_fc_fundingagreement', '=', agreementId)
    .where('Funding_Case_Agreement_Commitment.egcs_fc_type', '=', commitmentType)
    .where('Funding_Case_Agreement_Commitment.egcs_fc_active', '=', true)
    .where('Funding_Case_Agreement_Commitment.egcs_fc_status', '=', 'approved')
    .where('Transfer_Payment_Stream_Budget.egcs_tp_fiscalyear', '=', fiscalYearId)
    .where('Funding_Case_Agreement_Commitment._deleted', '=', false)
    .where('Funding_Case_Agreement_Commitment_Line._deleted', '=', false)
    .where('Transfer_Payment_Stream_Commitment._deleted', '=', false)
    .where('Transfer_Payment_Stream_Budget._deleted', '=', false)
    .execute() as Array<{ id?: unknown, amount?: unknown }>

  const lineTotal = sumRows(commitmentLines)
  if (lineTotal <= 0) {
    return 0
  }

  const lineIds = commitmentLines.map(line => String(line.id ?? '')).filter(id => id.length > 0)
  if (lineIds.length === 0) {
    return lineTotal
  }

  const paymentLines = await db
    .selectFrom('Funding_Case_Agreement_Payment_Line')
    .select('egcs_fc_amount as amount')
    .where('egcs_fc_fundingagreementcommitmentline', 'in', lineIds)
    .where('_deleted', '=', false)
    .execute() as Array<{ amount?: unknown }>

  return roundCurrency(Math.max(lineTotal - sumRows(paymentLines), 0))
}

const getAgreementTotal = async (db: Db, agreementId: string): Promise<number> => {
  const rows = await db
    .selectFrom('Funding_Case_Agreement_Budget_Line_Item')
    .select('egcs_fc_programfunding as amount')
    .where('egcs_fc_fundingagreement', '=', agreementId)
    .where('_deleted', '=', false)
    .execute() as Array<{ amount?: unknown }>

  return sumRows(rows)
}

const getFiscalYearTotal = async (db: Db, fiscalYearId: string): Promise<number> => {
  const rows = await db
    .selectFrom('Funding_Case_Agreement_Budget_Line_Item')
    .select('egcs_fc_programfunding as amount')
    .where('egcs_fc_budgetfiscalyear', '=', fiscalYearId)
    .where('_deleted', '=', false)
    .execute() as Array<{ amount?: unknown }>

  return sumRows(rows)
}

export const calculateAutomatedPaymentFromDb = async (
  db: Db,
  input: AutomatedPaymentServerInput,
  streamConfig: unknown
): Promise<AutomatedPaymentServerCalculation> => {
  const config = parseAutomatedPaymentsStreamConfig(streamConfig)
  if (!config.enabledPaymentTypes.includes(input.paymentType)) {
    return {
      enabled: false,
      baseAmount: 0,
      ceilingAmount: 0,
      suggestedAmount: 0,
      currency: 'CAD',
      details: []
    }
  }

  const settings = await getAgreementSettings(db, input.agreementId)
  const [
    claimTotal,
    forecastToPeriodEnd,
    paymentsToDate,
    commitmentRemaining,
    agreementTotal,
    fiscalYearTotal,
    holdbackSettings
  ] = await Promise.all([
    getClaimTotal(db, input.agreementId, input.fiscalYearId, input.periodEnd),
    getForecastTotal(db, input.agreementId, input.fiscalYearId, input.periodEnd),
    getPaymentsToDate(db, input.agreementId, input.fiscalYearId),
    getCommitmentRemaining(db, input.agreementId, input.fiscalYearId, input.commitmentType),
    getAgreementTotal(db, input.agreementId),
    getFiscalYearTotal(db, input.fiscalYearId),
    getAgreementHoldbackSettings(db, input.agreementId)
  ])

  const result = calculateAutomatedPaymentAmount({
    paymentType: input.paymentType,
    periodEnd: input.periodEnd,
    totalClaimsToLastClaimMonth: roundCurrency(claimTotal + settings.previousClaimsTotal),
    totalPaymentsToDate: roundCurrency(paymentsToDate + settings.previousPaymentsTotal),
    totalForecastToLastClaimMonth: forecastToPeriodEnd,
    totalForecastToPeriodEnd: forecastToPeriodEnd,
    commitmentRemaining,
    agreementTotal,
    finalFiscalYearTotal: fiscalYearTotal,
    holdbackReleaseOverride: input.holdbackReleaseOverride ?? settings.holdbackReleaseOverride
  }, holdbackSettings)

  return {
    enabled: true,
    ...result
  }
}
