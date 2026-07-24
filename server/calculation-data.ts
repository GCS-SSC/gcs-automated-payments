import type { Kysely } from 'kysely'
import {
  EXTENSION_KEY,
  calculateAutomatedPaymentAmount,
  parseAutomatedPaymentExtensionPayload,
  parseAutomatedPaymentsStreamConfig,
  roundCurrency,
  type AutomatedPaymentCalculationResult,
  type AutomatedPaymentsHoldbackSettings
} from '../shared/automated-payments'

type Db = Kysely<Record<string, Record<string, unknown>>>

export interface AutomatedPaymentServerInput {
  agreementId: string
  commitmentType: string
  fiscalYearId: string
  paymentType: 'reimbursement' | 'advance'
  periodEnd: number
  submittedAmount?: number
  releaseHoldback?: boolean
  holdbackReleaseAmount?: number
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
  amount: number
  id?: string
}

const PAYMENT_METADATA_KEY = 'payment-metadata'
const TERMINAL_CLAIM_RECONCILE_STATUSES = ['complete', 'approved'] as const
const NON_DENIED_PAYMENT_STATUSES = ['draft', 'inprogress', 'complete', 'pendingapproval', 'approved', 'pay', 'wait', 'processed', 'paid'] as const

const isOnOrBefore = (row: PeriodPosition, position: PeriodPosition): boolean =>
  row.fiscalYearOrder < position.fiscalYearOrder
  || (row.fiscalYearOrder === position.fiscalYearOrder && row.month <= position.month)

const sumRows = (rows: Array<{ amount?: unknown }>): number =>
  roundCurrency(rows.reduce((total, row) => total + Number(row.amount ?? 0), 0))

const sumPeriodRows = (rows: AmountPeriodRow[], position: PeriodPosition): number =>
  roundCurrency(rows.reduce((total, row) => total + (isOnOrBefore(row, position) ? row.amount : 0), 0))

/** Loads the agreement's holdback percentage and basis, applying safe defaults for missing values. */
const getAgreementHoldbackSettings = async (
  db: Db,
  agreementId: string
): Promise<AutomatedPaymentsHoldbackSettings> => {
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

/** Returns the extension's agreement-level settings, which are currently empty. */
export const getAgreementSettings = async (
  db: Db,
  agreementId: string
) => {
  void db
  void agreementId
  return {}
}

/** Accepts agreement-level settings while the extension has no settings to persist. */
export const saveAgreementSettings = async (
  db: Db,
  agreementId: string,
  value: Record<string, unknown>
) => {
  void db
  void agreementId
  void value
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

/** Resolves a selected budget fiscal year and month into a comparable period position. */
const getSelectedPaymentPeriod = async (
  db: Db,
  agreementId: string,
  fiscalYearId: string,
  periodEnd: number
): Promise<PeriodPosition> => {
  const row = await db
    .selectFrom('Funding_Case_Agreement_Budget_Fiscal_Year')
    .innerJoin('Agency_Fiscal_Year', 'Agency_Fiscal_Year.id', 'Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_fiscalyear')
    .select('Agency_Fiscal_Year.egcs_ay_fiscalyear as fiscal_year_order')
    .where('Funding_Case_Agreement_Budget_Fiscal_Year.id', '=', fiscalYearId)
    .where('Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_fundingagreement', '=', agreementId)
    .where('Funding_Case_Agreement_Budget_Fiscal_Year._deleted', '=', false)
    .where('Agency_Fiscal_Year._deleted', '=', false)
    .executeTakeFirst() as { fiscal_year_order?: unknown } | undefined

  return {
    fiscalYearOrder: Number(row?.fiscal_year_order ?? 0),
    month: periodEnd
  }
}

/** Loads reconciled claim amounts and their fiscal-period positions for an agreement. */
const getClaimRows = async (db: Db, agreementId: string): Promise<AmountPeriodRow[]> => {
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
    .innerJoin(
      'Funding_Case_Agreement_Budget_Fiscal_Year',
      'Funding_Case_Agreement_Budget_Fiscal_Year.id',
      'Funding_Case_Agreement_Claim.egcs_fc_fiscalyear'
    )
    .innerJoin('Agency_Fiscal_Year', 'Agency_Fiscal_Year.id', 'Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_fiscalyear')
    .select([
      'Funding_Case_Agreement_Claim_Reconcile_Line_Item.egcs_fc_reconciled as amount',
      'Funding_Case_Agreement_Claim.egcs_fc_periodend as month',
      'Agency_Fiscal_Year.egcs_ay_fiscalyear as fiscal_year_order'
    ])
    .where('Funding_Case_Agreement_Claim.egcs_fc_fundingagreement', '=', agreementId)
    .where('Funding_Case_Agreement_Claim_Reconcile.egcs_fc_status', 'in', TERMINAL_CLAIM_RECONCILE_STATUSES)
    .where('Funding_Case_Agreement_Claim._deleted', '=', false)
    .where('Funding_Case_Agreement_Claim_Reconcile._deleted', '=', false)
    .where('Funding_Case_Agreement_Claim_Reconcile_Line_Item._deleted', '=', false)
    .where('Funding_Case_Agreement_Budget_Fiscal_Year._deleted', '=', false)
    .where('Agency_Fiscal_Year._deleted', '=', false)
    .execute() as Array<{ amount?: unknown, month?: unknown, fiscal_year_order?: unknown }>

  return rows.map(row => ({
    amount: Number(row.amount ?? 0),
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
const getForecastRows = async (db: Db, agreementId: string): Promise<AmountPeriodRow[]> => {
  const rows = await db
    .selectFrom('Funding_Case_Agreement_Forecast_Line_Item')
    .innerJoin(
      'Funding_Case_Agreement_Forecast',
      'Funding_Case_Agreement_Forecast.id',
      'Funding_Case_Agreement_Forecast_Line_Item.egcs_fc_agreementforecast'
    )
    .innerJoin(
      'Funding_Case_Agreement_Budget_Fiscal_Year',
      'Funding_Case_Agreement_Budget_Fiscal_Year.id',
      'Funding_Case_Agreement_Forecast.egcs_fc_fiscalyear'
    )
    .innerJoin('Agency_Fiscal_Year', 'Agency_Fiscal_Year.id', 'Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_fiscalyear')
    .select([
      'Funding_Case_Agreement_Forecast_Line_Item.egcs_fc_amount as amount',
      'Funding_Case_Agreement_Forecast_Line_Item.egcs_fc_month as month',
      'Agency_Fiscal_Year.egcs_ay_fiscalyear as fiscal_year_order'
    ])
    .where('Funding_Case_Agreement_Forecast.egcs_fc_fundingagreement', '=', agreementId)
    .where('Funding_Case_Agreement_Forecast.egcs_fc_active', '=', true)
    .where('Funding_Case_Agreement_Forecast._deleted', '=', false)
    .where('Funding_Case_Agreement_Forecast_Line_Item._deleted', '=', false)
    .where('Funding_Case_Agreement_Budget_Fiscal_Year._deleted', '=', false)
    .where('Agency_Fiscal_Year._deleted', '=', false)
    .execute() as Array<{ amount?: unknown, month?: unknown, fiscal_year_order?: unknown }>

  return rows.map(row => ({
    amount: Number(row.amount ?? 0),
    month: Number(row.month ?? 0),
    fiscalYearOrder: Number(row.fiscal_year_order ?? 0)
  }))
}

/** Loads non-denied payments for an agreement, optionally excluding the payment being calculated. */
const getPaymentRows = async (db: Db, agreementId: string, excludePaymentId?: string): Promise<AmountPeriodRow[]> => {
  let query = db
    .selectFrom('Funding_Case_Agreement_Payment')
    .innerJoin(
      'Funding_Case_Agreement_Commitment',
      'Funding_Case_Agreement_Commitment.id',
      'Funding_Case_Agreement_Payment.egcs_fc_fundingagreementcommitment'
    )
    .innerJoin(
      'Funding_Case_Agreement_Budget_Fiscal_Year',
      'Funding_Case_Agreement_Budget_Fiscal_Year.id',
      'Funding_Case_Agreement_Payment.egcs_fc_fiscalyear'
    )
    .innerJoin('Agency_Fiscal_Year', 'Agency_Fiscal_Year.id', 'Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_fiscalyear')
    .select([
      'Funding_Case_Agreement_Payment.id as id',
      'Funding_Case_Agreement_Payment.egcs_fc_paymentamount as amount',
      'Funding_Case_Agreement_Payment.egcs_fc_periodend as month',
      'Agency_Fiscal_Year.egcs_ay_fiscalyear as fiscal_year_order'
    ])
    .where('Funding_Case_Agreement_Commitment.egcs_fc_fundingagreement', '=', agreementId)
    .where('Funding_Case_Agreement_Payment.egcs_fc_status', 'in', NON_DENIED_PAYMENT_STATUSES)
    .where('Funding_Case_Agreement_Payment._deleted', '=', false)
    .where('Funding_Case_Agreement_Commitment._deleted', '=', false)
    .where('Funding_Case_Agreement_Budget_Fiscal_Year._deleted', '=', false)
    .where('Agency_Fiscal_Year._deleted', '=', false)

  if (excludePaymentId) {
    query = query.where('Funding_Case_Agreement_Payment.id', '!=', excludePaymentId)
  }

  const rows = await query
    .execute() as Array<{ id?: unknown, amount?: unknown, month?: unknown, fiscal_year_order?: unknown }>

  return rows.map(row => ({
    id: String(row.id ?? ''),
    amount: Number(row.amount ?? 0),
    month: Number(row.month ?? 0),
    fiscalYearOrder: Number(row.fiscal_year_order ?? 0)
  }))
}

/** Sums holdback releases recorded on eligible payments through the selected period. */
const getHoldbackReleasedToDate = async (
  db: Db,
  paymentRows: AmountPeriodRow[],
  selectedPosition: PeriodPosition
): Promise<number> => {
  const paymentIds = paymentRows
    .filter(row => row.id && isOnOrBefore(row, selectedPosition))
    .map(row => String(row.id))

  if (paymentIds.length === 0) {
    return 0
  }

  const rows = await db
    .selectFrom('extensions.kv_entry')
    .select('value')
    .where('extension_key', '=', EXTENSION_KEY)
    .where('owner_type', '=', 'fundingcasepayment')
    .where('owner_id', 'in', paymentIds)
    .where('config_key', '=', PAYMENT_METADATA_KEY)
    .where('_deleted', '=', false)
    .execute() as Array<{ value?: unknown }>

  return roundCurrency(rows.reduce((total, row) => {
    const metadata = parseAutomatedPaymentExtensionPayload(row.value)
    return total + metadata.holdbackReleaseAmount
  }, 0))
}

/** Calculates the unpaid balance of approved active commitment lines for a fiscal year and type. */
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
    .innerJoin(
      'Transfer_Payment_Fiscal_Year_Budget',
      'Transfer_Payment_Fiscal_Year_Budget.id',
      'Transfer_Payment_Stream_Budget.egcs_tp_transferpaymentbudget'
    )
    .innerJoin(
      'Funding_Case_Agreement_Budget_Fiscal_Year',
      'Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_fiscalyear',
      'Transfer_Payment_Fiscal_Year_Budget.egcs_tp_fiscalyear'
    )
    .select([
      'Funding_Case_Agreement_Commitment_Line.id as id',
      'Funding_Case_Agreement_Commitment_Line.egcs_fc_amount as amount'
    ])
    .where('Funding_Case_Agreement_Commitment.egcs_fc_fundingagreement', '=', agreementId)
    .where('Funding_Case_Agreement_Commitment.egcs_fc_type', '=', commitmentType)
    .where('Funding_Case_Agreement_Commitment.egcs_fc_active', '=', true)
    .where('Funding_Case_Agreement_Commitment.egcs_fc_status', '=', 'approved')
    .where('Funding_Case_Agreement_Budget_Fiscal_Year.id', '=', fiscalYearId)
    .where('Funding_Case_Agreement_Commitment._deleted', '=', false)
    .where('Funding_Case_Agreement_Commitment_Line._deleted', '=', false)
    .where('Transfer_Payment_Stream_Commitment._deleted', '=', false)
    .where('Transfer_Payment_Stream_Budget._deleted', '=', false)
    .where('Transfer_Payment_Fiscal_Year_Budget._deleted', '=', false)
    .where('Funding_Case_Agreement_Budget_Fiscal_Year._deleted', '=', false)
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
    .innerJoin(
      'Funding_Case_Agreement_Payment',
      'Funding_Case_Agreement_Payment.id',
      'Funding_Case_Agreement_Payment_Line.egcs_fc_fundingagreementpayment'
    )
    .select('Funding_Case_Agreement_Payment_Line.egcs_fc_amount as amount')
    .where('Funding_Case_Agreement_Payment_Line.egcs_fc_fundingagreementcommitmentline', 'in', lineIds)
    .where('Funding_Case_Agreement_Payment.egcs_fc_status', 'in', NON_DENIED_PAYMENT_STATUSES)
    .where('Funding_Case_Agreement_Payment_Line._deleted', '=', false)
    .where('Funding_Case_Agreement_Payment._deleted', '=', false)
    .execute() as Array<{ amount?: unknown }>

  return roundCurrency(Math.max(lineTotal - sumRows(paymentLines), 0))
}

/** Aggregates agreement, final-year, and future-year budget totals for the selected period. */
const getBudgetTotals = async (
  db: Db,
  agreementId: string,
  selectedPosition: PeriodPosition
) => {
  const rows = await db
    .selectFrom('Funding_Case_Agreement_Budget_Line_Item')
    .innerJoin(
      'Funding_Case_Agreement_Budget_Fiscal_Year',
      'Funding_Case_Agreement_Budget_Fiscal_Year.id',
      'Funding_Case_Agreement_Budget_Line_Item.egcs_fc_fundingagreementbudgetfiscalyear'
    )
    .innerJoin('Agency_Fiscal_Year', 'Agency_Fiscal_Year.id', 'Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_fiscalyear')
    .select([
      'Funding_Case_Agreement_Budget_Line_Item.egcs_fc_programfunding as amount',
      'Agency_Fiscal_Year.egcs_ay_fiscalyear as fiscal_year_order'
    ])
    .where('Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_fundingagreement', '=', agreementId)
    .where('Funding_Case_Agreement_Budget_Line_Item._deleted', '=', false)
    .where('Funding_Case_Agreement_Budget_Fiscal_Year._deleted', '=', false)
    .where('Agency_Fiscal_Year._deleted', '=', false)
    .execute() as Array<{ amount?: unknown, fiscal_year_order?: unknown }>

  const normalizedRows = rows.map(row => ({
    amount: Number(row.amount ?? 0),
    fiscalYearOrder: Number(row.fiscal_year_order ?? 0)
  }))
  const finalFiscalYearOrder = Math.max(...normalizedRows.map(row => row.fiscalYearOrder), selectedPosition.fiscalYearOrder)

  return {
    agreementTotal: roundCurrency(normalizedRows.reduce((total, row) => total + row.amount, 0)),
    finalFiscalYearTotal: roundCurrency(normalizedRows.reduce((total, row) =>
      total + (row.fiscalYearOrder === finalFiscalYearOrder ? row.amount : 0), 0)),
    futureFiscalYearTotal: roundCurrency(normalizedRows.reduce((total, row) =>
      total + (row.fiscalYearOrder > selectedPosition.fiscalYearOrder ? row.amount : 0), 0))
  }
}

/** Collects agreement financials and calculates the automated payment result for a selected period. */
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
      holdbackAmount: 0,
      holdbackReleaseAmount: 0,
      availableBeforeHoldback: 0,
      currency: 'CAD',
      details: []
    }
  }

  const selectedPosition = await getSelectedPaymentPeriod(db, input.agreementId, input.fiscalYearId, input.periodEnd)
  const [
    claimRows,
    forecastRows,
    paymentRows,
    commitmentRemaining,
    budgetTotals,
    holdbackSettings
  ] = await Promise.all([
    getClaimRows(db, input.agreementId),
    getForecastRows(db, input.agreementId),
    getPaymentRows(db, input.agreementId, input.excludePaymentId),
    getCommitmentRemaining(db, input.agreementId, input.fiscalYearId, input.commitmentType),
    getBudgetTotals(db, input.agreementId, selectedPosition),
    getAgreementHoldbackSettings(db, input.agreementId)
  ])
  const lastClaimPosition = getLastClaimPosition(claimRows, selectedPosition)
  const claimCutoff = lastClaimPosition ?? { fiscalYearOrder: selectedPosition.fiscalYearOrder, month: -1 }
  const totalClaimsToLastClaimMonth = sumPeriodRows(claimRows, claimCutoff)
  const totalForecastToLastClaimMonth = lastClaimPosition ? sumPeriodRows(forecastRows, lastClaimPosition) : 0
  const totalForecastToPeriodEnd = sumPeriodRows(forecastRows, selectedPosition)
  const totalPaymentsToDate = sumPeriodRows(paymentRows, selectedPosition)
  const forecastUnclaimedCurrentFiscalYear = roundCurrency(forecastRows.reduce((total, row) => {
    const latestClaimMonthInSelectedFiscalYear = lastClaimPosition?.fiscalYearOrder === selectedPosition.fiscalYearOrder
      ? lastClaimPosition.month
      : -1
    return total + (
      row.fiscalYearOrder === selectedPosition.fiscalYearOrder && row.month > latestClaimMonthInSelectedFiscalYear
        ? row.amount
        : 0
    )
  }, 0))
  const availableForDisbursementBeforeHoldback = roundCurrency(
    totalClaimsToLastClaimMonth
    + forecastUnclaimedCurrentFiscalYear
    + budgetTotals.futureFiscalYearTotal
    - totalPaymentsToDate
    - roundCurrency((holdbackSettings.holdbackBasis === 'final-fiscal-year'
      ? budgetTotals.finalFiscalYearTotal
      : budgetTotals.agreementTotal) * (holdbackSettings.holdbackPercent / 100))
  )
  const holdbackAlreadyReleased = await getHoldbackReleasedToDate(db, paymentRows, selectedPosition)

  const result = calculateAutomatedPaymentAmount({
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
    holdbackAlreadyReleased,
    releaseHoldback: input.releaseHoldback,
    holdbackReleaseAmount: input.holdbackReleaseAmount
  }, holdbackSettings)

  return {
    enabled: true,
    ...result
  }
}
