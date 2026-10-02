import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import {
  EXTENSION_KEY,
  AutomatedPaymentCurrencySchema,
  ZERO_AUTOMATED_PAYMENT_MONEY,
  addAutomatedPaymentMoney,
  calculateAutomatedPaymentAmount,
  parseAutomatedPaymentExtensionPayload,
  parseAutomatedPaymentsStreamConfig,
  subtractAutomatedPaymentMoney,
  sumAutomatedPaymentMoney,
  type AutomatedPaymentMoney,
  type AutomatedPaymentMoneyInput,
  type AutomatedPaymentCalculationResult,
  type AutomatedPaymentsHoldbackSettings
} from '../shared/automated-payments.ts'
import { createAutomatedPaymentUserError } from './errors.ts'
import { databaseNumericText, parseDatabaseMoney, parseDatabaseAggregateMoney } from './numeric.ts'
import type { GcsExtensionAgreementFinancials } from '@gcs-ssc/extensions/server'

type Db = Kysely<Record<string, Record<string, unknown>>>

const stableBudgetFiscalYearId = sql<string>`COALESCE(
  "Funding_Case_Agreement_Budget_Fiscal_Year"."egcs_fc_originalbudgetfiscalyear",
  "Funding_Case_Agreement_Budget_Fiscal_Year"."id"
)`

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

export interface AutomatedPaymentServerCalculation extends AutomatedPaymentCalculationResult {
  enabled: boolean
}

type PeriodPosition = {
  fiscalYearOrder: number
  month: number
}

type AmountPeriodRow = PeriodPosition & {
  amount: AutomatedPaymentMoney
}

const PAYMENT_METADATA_KEY = 'payment-metadata'

/** Serializes ceiling-affecting payment mutations for one Agreement. */
export const lockAutomatedPaymentAgreement = async (db: Db, agreementId: string): Promise<void> => {
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${'gcs-automated-payments:agreement:' + agreementId}, 0)
    )
  `.execute(db)
}

const isOnOrBefore = (row: PeriodPosition, position: PeriodPosition): boolean =>
  row.fiscalYearOrder < position.fiscalYearOrder
  || (row.fiscalYearOrder === position.fiscalYearOrder && row.month <= position.month)

const sumPeriodRows = (rows: AmountPeriodRow[], position: PeriodPosition): AutomatedPaymentMoney =>
  sumAutomatedPaymentMoney(rows.filter(row => isOnOrBefore(row, position)).map(row => row.amount))

/** Loads the agreement's holdback percentage and agency holdback-basis type. */
export const getAgreementHoldbackSettings = async (
  db: Db,
  agreementId: string,
  currency?: string
): Promise<AutomatedPaymentsHoldbackSettings> => {
  const row = await db
    .selectFrom('Funding_Case_Agreement_Profile')
    .innerJoin(
      'Transfer_Payment_Stream_Holdback_Basis',
      'Transfer_Payment_Stream_Holdback_Basis.id',
      'Funding_Case_Agreement_Profile.egcs_fc_holdbackbasis'
    )
    .innerJoin(
      'Agency_Holdback_Basis',
      'Agency_Holdback_Basis.id',
      'Transfer_Payment_Stream_Holdback_Basis.egcs_tp_agencyholdback'
    )
    .select([
      'Funding_Case_Agreement_Profile.egcs_fc_holdback',
      'Funding_Case_Agreement_Profile.egcs_fc_currency',
      'Agency_Holdback_Basis.egcs_ay_holdbackbasis as holdback_basis_type'
    ])
    .where('Funding_Case_Agreement_Profile.id', '=', agreementId)
    .where('Funding_Case_Agreement_Profile._deleted', '=', false)
    .where('Transfer_Payment_Stream_Holdback_Basis._deleted', '=', false)
    .where('Agency_Holdback_Basis._deleted', '=', false)
    .executeTakeFirst() as {
      egcs_fc_holdback?: unknown
      egcs_fc_currency?: unknown
      holdback_basis_type?: unknown
    } | undefined

  if (row?.holdback_basis_type !== 'fullagreement' && row?.holdback_basis_type !== 'finalfiscal') {
    throw createAutomatedPaymentUserError('GCS_AUTOMATED_PAYMENTS_UNSUPPORTED_HOLDBACK_BASIS')
  }
  if (typeof row.egcs_fc_currency !== 'string' || !AutomatedPaymentCurrencySchema.safeParse(row.egcs_fc_currency).success) {
    throw createAutomatedPaymentUserError('GCS_AUTOMATED_PAYMENTS_CURRENCY_INVALID', 'egcs_fc_currency')
  }
  if (currency !== undefined && row.egcs_fc_currency !== currency) {
    throw createAutomatedPaymentUserError('GCS_AUTOMATED_PAYMENTS_CURRENCY_MISMATCH', 'egcs_fc_currency')
  }

  return {
    holdbackPercent: Number(row?.egcs_fc_holdback ?? 0),
    holdbackBasis: row.holdback_basis_type
  }
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

/** Resolves a selected budget fiscal year and month into a comparable period position. */
export const getSelectedPaymentPeriod = async (
  db: Db,
  agreementId: string,
  fiscalYearId: string,
  periodEnd: number
): Promise<PeriodPosition> => {
  const row = await db
    .selectFrom('Funding_Case_Agreement_Budget_Fiscal_Year')
    .innerJoin('Funding_Case_Agreement_Budget_Version', 'Funding_Case_Agreement_Budget_Version.id', 'Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_budgetversion')
    .innerJoin('Agency_Fiscal_Year', 'Agency_Fiscal_Year.id', 'Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_fiscalyear')
    .select('Agency_Fiscal_Year.egcs_ay_fiscalyear as fiscal_year_order')
    .where(stableBudgetFiscalYearId, '=', fiscalYearId)
    .where('Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_fundingagreement', '=', agreementId)
    .where('Funding_Case_Agreement_Budget_Fiscal_Year._deleted', '=', false)
    .where('Funding_Case_Agreement_Budget_Version.egcs_fc_iscurrent', '=', true)
    .where('Funding_Case_Agreement_Budget_Version._deleted', '=', false)
    .where('Agency_Fiscal_Year._deleted', '=', false)
    .executeTakeFirst() as { fiscal_year_order?: unknown } | undefined

  if (row?.fiscal_year_order === undefined || row.fiscal_year_order === null) {
    throw createAutomatedPaymentUserError(
      'GCS_AUTOMATED_PAYMENTS_FISCAL_YEAR_UNAVAILABLE',
      'egcs_fc_fiscalyear'
    )
  }

  return {
    fiscalYearOrder: Number(row.fiscal_year_order),
    month: periodEnd
  }
}

/** Loads reconciled claim amounts and their fiscal-period positions for an agreement. */
const getClaimRows = async (db: Db, agreementId: string, currency: string): Promise<AmountPeriodRow[]> => {
  const rows = await db
    .selectFrom('Funding_Case_Agreement_Claim_Reconcile_Line_Item')
    .innerJoin('Funding_Case_Agreement_Claim_Line_Item',
      'Funding_Case_Agreement_Claim_Line_Item.id',
      'Funding_Case_Agreement_Claim_Reconcile_Line_Item.egcs_fc_lineitem')
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
    .innerJoin('Funding_Case_Agreement_Budget_Fiscal_Year', join => join.on(
      stableBudgetFiscalYearId, '=', sql.ref('Funding_Case_Agreement_Claim.egcs_fc_fiscalyear')
    ))
    .innerJoin('Funding_Case_Agreement_Budget_Version', 'Funding_Case_Agreement_Budget_Version.id', 'Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_budgetversion')
    .innerJoin('Agency_Fiscal_Year', 'Agency_Fiscal_Year.id', 'Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_fiscalyear')
    .select([
      databaseNumericText(sql.ref('Funding_Case_Agreement_Claim_Reconcile_Line_Item.egcs_fc_reconciled')).as('amount'),
      'Funding_Case_Agreement_Claim.egcs_fc_periodend as month',
      'Agency_Fiscal_Year.egcs_ay_fiscalyear as fiscal_year_order'
    ])
    .where('Funding_Case_Agreement_Claim.egcs_fc_fundingagreement', '=', agreementId)
    .where('Funding_Case_Agreement_Claim_Line_Item.egcs_fc_currency', '=', currency)
    .where('Funding_Case_Agreement_Claim_Line_Item._deleted', '=', false)
    .where(sql<boolean>`EXISTS (
      SELECT 1
      FROM "Common_Completion" completion
      LEFT JOIN "Common_Workflow_Run" workflow
        ON workflow.egcs_cn_completion = completion.id
      LEFT JOIN "Common_Runtime" runtime
        ON runtime.id = workflow.id
       AND runtime._deleted = false
      WHERE completion.egcs_cn_entitytype = 'fundingclaimreconcile'
        AND completion.egcs_cn_entityid = "Funding_Case_Agreement_Claim_Reconcile".id
        AND completion._deleted = false
        AND (
          completion.egcs_cn_disposition = 'no_workflow'
          OR runtime.egcs_cn_state IN ('succeeded', 'approved')
        )
        AND (runtime.id IS NULL OR runtime.egcs_cn_attempt = (
          SELECT MAX(latest.egcs_cn_attempt)
          FROM "Common_Workflow_Run" latest_run
          JOIN "Common_Runtime" latest ON latest.id = latest_run.id
          WHERE latest_run.egcs_cn_completion = completion.id
            AND latest._deleted = false
        ))
    )`)
    .where('Funding_Case_Agreement_Claim._deleted', '=', false)
    .where('Funding_Case_Agreement_Claim_Reconcile._deleted', '=', false)
    .where('Funding_Case_Agreement_Claim_Reconcile_Line_Item._deleted', '=', false)
    .where('Funding_Case_Agreement_Budget_Fiscal_Year._deleted', '=', false)
    .where('Funding_Case_Agreement_Budget_Version.egcs_fc_iscurrent', '=', true)
    .where('Funding_Case_Agreement_Budget_Version._deleted', '=', false)
    .where('Agency_Fiscal_Year._deleted', '=', false)
    .execute() as Array<{ amount?: unknown, month?: unknown, fiscal_year_order?: unknown }>

  return rows.map(row => ({
    amount: parseDatabaseMoney(row.amount),
    month: Number(row.month ?? 0),
    fiscalYearOrder: Number(row.fiscal_year_order ?? 0)
  }))
}

const getLastClaimPosition = (claimRows: AmountPeriodRow[], selectedPosition: PeriodPosition): PeriodPosition | null => {
  const eligibleRows = claimRows.filter(row => isOnOrBefore(row, selectedPosition))
  if (eligibleRows.length === 0) {
    return null
  }

  return eligibleRows.reduce((latest, row) => {
    if (row.fiscalYearOrder > latest.fiscalYearOrder) {
      return row
    }
    if (row.fiscalYearOrder === latest.fiscalYearOrder && row.month > latest.month) {
      return row
    }
    return latest
  })
}

/** Loads active forecast line amounts and their fiscal-period positions for an agreement. */
const getForecastRows = async (db: Db, agreementId: string, currency: string): Promise<AmountPeriodRow[]> => {
  const rows = await db
    .selectFrom('Funding_Case_Agreement_Forecast_Line_Item')
    .innerJoin(
      'Funding_Case_Agreement_Forecast',
      'Funding_Case_Agreement_Forecast.id',
      'Funding_Case_Agreement_Forecast_Line_Item.egcs_fc_agreementforecast'
    )
    .innerJoin('Funding_Case_Agreement_Budget_Fiscal_Year', join => join.on(
      stableBudgetFiscalYearId, '=', sql.ref('Funding_Case_Agreement_Forecast.egcs_fc_fiscalyear')
    ))
    .innerJoin('Funding_Case_Agreement_Budget_Version', 'Funding_Case_Agreement_Budget_Version.id', 'Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_budgetversion')
    .innerJoin('Agency_Fiscal_Year', 'Agency_Fiscal_Year.id', 'Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_fiscalyear')
    .select([
      databaseNumericText(sql.ref('Funding_Case_Agreement_Forecast_Line_Item.egcs_fc_amount')).as('amount'),
      'Funding_Case_Agreement_Forecast_Line_Item.egcs_fc_month as month',
      'Agency_Fiscal_Year.egcs_ay_fiscalyear as fiscal_year_order'
    ])
    .where('Funding_Case_Agreement_Forecast.egcs_fc_fundingagreement', '=', agreementId)
    .where('Funding_Case_Agreement_Forecast_Line_Item.egcs_fc_currency', '=', currency)
    .where('Funding_Case_Agreement_Forecast.egcs_fc_active', '=', true)
    .where('Funding_Case_Agreement_Forecast._deleted', '=', false)
    .where('Funding_Case_Agreement_Forecast_Line_Item._deleted', '=', false)
    .where('Funding_Case_Agreement_Budget_Fiscal_Year._deleted', '=', false)
    .where('Funding_Case_Agreement_Budget_Version.egcs_fc_iscurrent', '=', true)
    .where('Funding_Case_Agreement_Budget_Version._deleted', '=', false)
    .where('Agency_Fiscal_Year._deleted', '=', false)
    .execute() as Array<{ amount?: unknown, month?: unknown, fiscal_year_order?: unknown }>

  return rows.map(row => ({
    amount: parseDatabaseMoney(row.amount),
    month: Number(row.month ?? 0),
    fiscalYearOrder: Number(row.fiscal_year_order ?? 0)
  }))
}

/** Aggregates agreement, final-year, and future-year budget totals for the selected period. */
const getBudgetTotals = async (
  db: Db,
  agreementId: string,
  selectedPosition: PeriodPosition,
  currency: string
) => {
  const rows = await db
    .selectFrom('Funding_Case_Agreement_Budget_Line_Item')
    .innerJoin(
      'Funding_Case_Agreement_Budget_Fiscal_Year',
      'Funding_Case_Agreement_Budget_Fiscal_Year.id',
      'Funding_Case_Agreement_Budget_Line_Item.egcs_fc_fundingagreementbudgetfiscalyear'
    )
    .innerJoin('Agency_Fiscal_Year', 'Agency_Fiscal_Year.id', 'Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_fiscalyear')
    .innerJoin(
      'Funding_Case_Agreement_Budget_Version',
      'Funding_Case_Agreement_Budget_Version.id',
      'Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_budgetversion'
    )
    .select([
      databaseNumericText(sql.ref('Funding_Case_Agreement_Budget_Line_Item.egcs_fc_programfunding')).as('amount'),
      'Agency_Fiscal_Year.egcs_ay_fiscalyear as fiscal_year_order'
    ])
    .where('Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_fundingagreement', '=', agreementId)
    .where('Funding_Case_Agreement_Budget_Line_Item.egcs_fc_currency', '=', currency)
    .where('Funding_Case_Agreement_Budget_Line_Item._deleted', '=', false)
    .where('Funding_Case_Agreement_Budget_Fiscal_Year._deleted', '=', false)
    .where('Funding_Case_Agreement_Budget_Version.egcs_fc_iscurrent', '=', true)
    .where('Funding_Case_Agreement_Budget_Version._deleted', '=', false)
    .where('Agency_Fiscal_Year._deleted', '=', false)
    .execute() as Array<{ amount?: unknown, fiscal_year_order?: unknown }>

  // The Agreement horizon includes an empty final fiscal year; funding-line presence does not shorten it.
  const fiscalYears = await db
    .selectFrom('Funding_Case_Agreement_Budget_Fiscal_Year')
    .innerJoin('Funding_Case_Agreement_Budget_Version', 'Funding_Case_Agreement_Budget_Version.id', 'Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_budgetversion')
    .innerJoin('Agency_Fiscal_Year', 'Agency_Fiscal_Year.id', 'Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_fiscalyear')
    .where('Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_fundingagreement', '=', agreementId)
    .where('Funding_Case_Agreement_Budget_Fiscal_Year._deleted', '=', false)
    .where('Funding_Case_Agreement_Budget_Version.egcs_fc_iscurrent', '=', true)
    .where('Funding_Case_Agreement_Budget_Version._deleted', '=', false)
    .where('Agency_Fiscal_Year._deleted', '=', false)
    .select('Agency_Fiscal_Year.egcs_ay_fiscalyear as fiscal_year_order')
    .execute() as Array<{ fiscal_year_order: unknown }>

  const normalizedRows = rows.map(row => ({
    amount: parseDatabaseMoney(row.amount),
    fiscalYearOrder: Number(row.fiscal_year_order ?? 0)
  }))
  const finalFiscalYearOrder = Math.max(...fiscalYears.map(row => Number(row.fiscal_year_order)), selectedPosition.fiscalYearOrder)

  return {
    agreementTotal: sumAutomatedPaymentMoney(normalizedRows.map(row => row.amount)),
    finalFiscalYearTotal: sumAutomatedPaymentMoney(normalizedRows.filter(row => row.fiscalYearOrder === finalFiscalYearOrder).map(row => row.amount)),
    futureFiscalYearTotal: sumAutomatedPaymentMoney(normalizedRows.filter(row => row.fiscalYearOrder > selectedPosition.fiscalYearOrder).map(row => row.amount))
  }
}

/** Collects agreement financials and calculates the automated payment result for a selected period. */
export const calculateAutomatedPaymentFromDb = async (
  db: Db,
  input: AutomatedPaymentServerInput,
  streamConfig: unknown,
  agreementFinancials: Pick<GcsExtensionAgreementFinancials, 'getCommitmentPaymentCapacity' | 'getRecordedPaidToDate'>
): Promise<AutomatedPaymentServerCalculation> => {
  const currency = AutomatedPaymentCurrencySchema.parse(input.currency)
  const config = parseAutomatedPaymentsStreamConfig(streamConfig)
  if (!config.enabledPaymentTypes.includes(input.paymentType)) {
    return {
      enabled: false,
      baseAmount: ZERO_AUTOMATED_PAYMENT_MONEY,
      ceilingAmount: ZERO_AUTOMATED_PAYMENT_MONEY,
      suggestedAmount: ZERO_AUTOMATED_PAYMENT_MONEY,
      holdbackAmount: ZERO_AUTOMATED_PAYMENT_MONEY,
      holdbackReleaseAmount: ZERO_AUTOMATED_PAYMENT_MONEY,
      availableBeforeHoldback: ZERO_AUTOMATED_PAYMENT_MONEY,
      currency: currency.toUpperCase(),
      details: []
    }
  }

  const holdbackSettings = await getAgreementHoldbackSettings(db, input.agreementId, currency)
  const selectedPosition = await getSelectedPaymentPeriod(db, input.agreementId, input.fiscalYearId, input.periodEnd)
  const [
    claimRows,
    forecastRows,
    commitmentRemaining,
    budgetTotals,
    recordedPaid
  ] = await Promise.all([
    getClaimRows(db, input.agreementId, currency),
    getForecastRows(db, input.agreementId, currency),
    agreementFinancials.getCommitmentPaymentCapacity({
      fiscalYearId: input.fiscalYearId,
      commitmentTypeId: input.commitmentType,
      currency,
      ...(input.excludePaymentId ? { excludePaymentId: input.excludePaymentId } : {})
    }).then(result => parseDatabaseAggregateMoney(result.capacityAmount)),
    getBudgetTotals(db, input.agreementId, selectedPosition, currency),
    agreementFinancials.getRecordedPaidToDate({ fiscalYearId: input.fiscalYearId, periodEnd: input.periodEnd, currency,
      ...(input.excludePaymentId ? { excludePaymentId: input.excludePaymentId } : {}) })
  ])
  const totalPaymentsToDate = parseDatabaseAggregateMoney(recordedPaid.recordedPaidAmount)
  if ((recordedPaid.currency === null && totalPaymentsToDate !== ZERO_AUTOMATED_PAYMENT_MONEY)
    || (recordedPaid.currency !== null && recordedPaid.currency.toLowerCase() !== currency)) {
    throw createAutomatedPaymentUserError('GCS_AUTOMATED_PAYMENTS_CURRENCY_MISMATCH', 'egcs_fc_currency')
  }
  const lastClaimPosition = getLastClaimPosition(claimRows, selectedPosition)
  const claimCutoff = lastClaimPosition ?? { fiscalYearOrder: selectedPosition.fiscalYearOrder, month: -1 }
  const totalClaimsToLastClaimMonth = sumPeriodRows(claimRows, claimCutoff)
  const totalForecastToLastClaimMonth = lastClaimPosition ? sumPeriodRows(forecastRows, lastClaimPosition) : ZERO_AUTOMATED_PAYMENT_MONEY
  const totalForecastToPeriodEnd = sumPeriodRows(forecastRows, selectedPosition)
  const forecastUnclaimedCurrentFiscalYear = sumAutomatedPaymentMoney(forecastRows.filter(row => {
    const latestClaimMonthInSelectedFiscalYear = lastClaimPosition?.fiscalYearOrder === selectedPosition.fiscalYearOrder
      ? lastClaimPosition.month
      : -1
    return row.fiscalYearOrder === selectedPosition.fiscalYearOrder && row.month > latestClaimMonthInSelectedFiscalYear
  }).map(row => row.amount))
  const availableForDisbursementBeforeHoldback = subtractAutomatedPaymentMoney(
    addAutomatedPaymentMoney(addAutomatedPaymentMoney(totalClaimsToLastClaimMonth, forecastUnclaimedCurrentFiscalYear), budgetTotals.futureFiscalYearTotal),
    totalPaymentsToDate
  )
  const result = calculateAutomatedPaymentAmount({
    currency,
    paymentType: input.paymentType,
    periodEnd: input.periodEnd,
    totalClaimsToLastClaimMonth,
    totalPaymentsToDate,
    totalForecastToLastClaimMonth,
    totalForecastToPeriodEnd,
    commitmentRemaining,
    agreementTotal: budgetTotals.agreementTotal,
    finalFiscalYearTotal: budgetTotals.finalFiscalYearTotal,
    availableForDisbursementBeforeHoldback,
    releaseHoldback: input.releaseHoldback,
    holdbackReleaseAmount: input.holdbackReleaseAmount
  }, holdbackSettings)

  return {
    enabled: true,
    ...result
  }
}
