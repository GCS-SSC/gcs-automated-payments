import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { calculateAutomatedPaymentFromDb } from '../../server/calculation-data'
import { writeScenarioCsvReport, type ScenarioReportRow } from '../fixtures/scenario-report'

const postgresUrl = process.env.AUTOMATED_PAYMENTS_POSTGRES_TEST_URL
const schemaName = `automated_payment_ledger_${process.pid}`
const requireUrl = () => {
  if (!postgresUrl || !new URL(postgresUrl).pathname.endsWith('_test')) {
    throw new Error('AUTOMATED_PAYMENTS_POSTGRES_TEST_URL must target a disposable *_test database.')
  }
  return postgresUrl
}
const createDb = (scoped = true) => new Kysely<Record<string, Record<string, unknown>>>({
  dialect: new PostgresDialect({ pool: new Pool({
    connectionString: requireUrl(), max: 2,
    ...(scoped ? { options: `-c search_path=${schemaName},public` } : {})
  }) })
})

// Reduced extension-owned source fixture: real SQL exercises the extension's queries;
// the SDK financial service remains injected, with independently authored signed totals.
const tableDefinitions = `
  CREATE TABLE "Agency_Fiscal_Year" (id bigint PRIMARY KEY, egcs_ay_fiscalyear integer NOT NULL, _deleted boolean NOT NULL DEFAULT false);
  CREATE TABLE "Funding_Case_Agreement_Budget_Version" (id bigint PRIMARY KEY, egcs_fc_iscurrent boolean NOT NULL, _deleted boolean NOT NULL DEFAULT false);
  CREATE TABLE "Funding_Case_Agreement_Budget_Fiscal_Year" (id bigint PRIMARY KEY, egcs_fc_originalbudgetfiscalyear bigint, egcs_fc_budgetversion bigint NOT NULL, egcs_fc_fiscalyear bigint NOT NULL, egcs_fc_fundingagreement bigint NOT NULL, _deleted boolean NOT NULL DEFAULT false);
  CREATE TABLE "Funding_Case_Agreement_Budget_Line_Item" (id bigint PRIMARY KEY, egcs_fc_fundingagreementbudgetfiscalyear bigint NOT NULL, egcs_fc_programfunding numeric(19,2) NOT NULL, _deleted boolean NOT NULL DEFAULT false, egcs_fc_currency text NOT NULL DEFAULT 'cad');
  CREATE TABLE "Agency_Holdback_Basis" (id bigint PRIMARY KEY, egcs_ay_holdbackbasis text NOT NULL, _deleted boolean NOT NULL DEFAULT false);
  CREATE TABLE "Transfer_Payment_Stream_Holdback_Basis" (id bigint PRIMARY KEY, egcs_tp_agencyholdback bigint NOT NULL, _deleted boolean NOT NULL DEFAULT false);
  CREATE TABLE "Funding_Case_Agreement_Profile" (id bigint PRIMARY KEY, egcs_fc_holdback numeric(5,2) NOT NULL, egcs_fc_holdbackbasis bigint NOT NULL, _deleted boolean NOT NULL DEFAULT false, egcs_fc_currency text NOT NULL DEFAULT 'cad');
  CREATE TABLE "Funding_Case_Agreement_Claim" (id bigint PRIMARY KEY, egcs_fc_fundingagreement bigint NOT NULL, egcs_fc_fiscalyear bigint NOT NULL, egcs_fc_periodend integer NOT NULL, _deleted boolean NOT NULL DEFAULT false);
  CREATE TABLE "Funding_Case_Agreement_Claim_Line_Item" (id bigint PRIMARY KEY, egcs_fc_fundingagreementclaim bigint NOT NULL, egcs_fc_currency text NOT NULL DEFAULT 'cad', _deleted boolean NOT NULL DEFAULT false);
  CREATE TABLE "Funding_Case_Agreement_Claim_Reconcile" (id bigint PRIMARY KEY, egcs_fc_fundingagreementclaim bigint NOT NULL, _deleted boolean NOT NULL DEFAULT false);
  CREATE TABLE "Funding_Case_Agreement_Claim_Reconcile_Line_Item" (id bigint PRIMARY KEY, egcs_fc_fundingagreementclaimreconcile bigint NOT NULL, egcs_fc_reconciled numeric(19,2) NOT NULL, _deleted boolean NOT NULL DEFAULT false, egcs_fc_lineitem bigint);
  CREATE TABLE "Common_Completion" (id bigint PRIMARY KEY, egcs_cn_entitytype text NOT NULL, egcs_cn_entityid bigint NOT NULL, egcs_cn_disposition text NOT NULL, _deleted boolean NOT NULL DEFAULT false);
  CREATE TABLE "Common_Workflow_Run" (id bigint PRIMARY KEY, egcs_cn_completion bigint NOT NULL);
  CREATE TABLE "Common_Runtime" (id bigint PRIMARY KEY, egcs_cn_state text NOT NULL, egcs_cn_attempt integer NOT NULL, _deleted boolean NOT NULL DEFAULT false);
  CREATE TABLE "Funding_Case_Agreement_Forecast" (id bigint PRIMARY KEY, egcs_fc_fundingagreement bigint NOT NULL, egcs_fc_fiscalyear bigint NOT NULL, egcs_fc_active boolean NOT NULL, _deleted boolean NOT NULL DEFAULT false);
  CREATE TABLE "Funding_Case_Agreement_Forecast_Line_Item" (id bigint PRIMARY KEY, egcs_fc_agreementforecast bigint NOT NULL, egcs_fc_amount numeric(19,2) NOT NULL, egcs_fc_month integer NOT NULL, _deleted boolean NOT NULL DEFAULT false, egcs_fc_currency text NOT NULL DEFAULT 'cad');
`

const sourceLedger = `
  INSERT INTO "Agency_Fiscal_Year" VALUES (1,2025,false),(2,2026,false),(3,2027,false);
  INSERT INTO "Funding_Case_Agreement_Budget_Version" VALUES (1,true,false),(2,false,false);
  INSERT INTO "Funding_Case_Agreement_Budget_Fiscal_Year" VALUES
    (10,NULL,1,1,1,false),(20,NULL,2,2,1,false),(21,20,1,2,1,false),(30,NULL,1,3,1,false);
  INSERT INTO "Funding_Case_Agreement_Budget_Line_Item" VALUES
    (100,10,500.00,false),(200,21,1000.00,false),(300,30,400.00,false),(900,20,99999.99,false),(901,21,99999.99,true);
  INSERT INTO "Agency_Holdback_Basis" VALUES (1,'fullagreement',false),(2,'finalfiscal',false);
  INSERT INTO "Transfer_Payment_Stream_Holdback_Basis" VALUES (41,1,false),(42,2,false);
  INSERT INTO "Funding_Case_Agreement_Profile" VALUES (1,10.00,41,false,'cad');
  INSERT INTO "Funding_Case_Agreement_Claim" VALUES
    (1,1,10,11,false),(2,1,20,1,false),(3,1,20,2,false),(4,1,20,2,false),
    (5,1,20,1,false),(6,1,20,8,false),(7,1,30,1,false),(8,1,20,1,true),(9,2,20,1,false);
  INSERT INTO "Funding_Case_Agreement_Claim_Reconcile" VALUES
    (11,1,false),(12,2,false),(13,3,false),(14,4,false),(15,5,false),(16,6,false),(17,7,false),(18,8,false),(19,9,false);
  INSERT INTO "Funding_Case_Agreement_Claim_Reconcile_Line_Item" VALUES
    (111,11,300.00,false),(112,12,300.00,false),(113,13,999.00,false),(114,14,888.00,false),
    (115,15,50.00,false),(116,16,900.00,false),(117,17,777.00,false),(118,18,999.00,false),(119,19,999.00,false),
    (120,12,999.00,true);
  INSERT INTO "Common_Completion" VALUES
    (11,'fundingclaimreconcile',11,'no_workflow',false),(12,'fundingclaimreconcile',12,'workflow',false),
    (13,'fundingclaimreconcile',13,'workflow',false),(14,'fundingclaimreconcile',14,'workflow',false),
    (15,'fundingclaimreconcile',15,'workflow',false),(16,'fundingclaimreconcile',16,'no_workflow',false),
    (17,'fundingclaimreconcile',17,'no_workflow',false),(18,'fundingclaimreconcile',18,'no_workflow',false),
    (19,'fundingclaimreconcile',19,'no_workflow',false);
  INSERT INTO "Common_Workflow_Run" VALUES (121,12),(131,13),(141,14),(142,14),(151,15),(152,15);
  INSERT INTO "Common_Runtime" VALUES
    (121,'approved',1,false),(131,'running',1,false),(141,'succeeded',1,false),(142,'failed',2,false),
    (151,'failed',1,false),(152,'succeeded',2,false);
  INSERT INTO "Funding_Case_Agreement_Forecast" VALUES
    (1,1,20,true,false),(2,1,10,true,false),(3,1,30,true,false),(4,1,20,false,false),(5,1,20,true,true),(6,2,20,true,false);
  INSERT INTO "Funding_Case_Agreement_Forecast_Line_Item" VALUES
    (1,1,100.00,0,false),(2,1,200.00,1,false),(3,1,200.00,3,false),(4,1,500.00,8,false),
    (5,2,350.00,11,false),(6,3,400.00,1,false),(7,4,99999.99,0,false),(8,5,99999.99,0,false),
    (9,1,99999.99,0,true),(10,6,99999.99,0,false);
  INSERT INTO "Funding_Case_Agreement_Claim_Line_Item" (id,egcs_fc_fundingagreementclaim)
    SELECT line.id+1000,reconcile.egcs_fc_fundingagreementclaim FROM "Funding_Case_Agreement_Claim_Reconcile_Line_Item" line
    JOIN "Funding_Case_Agreement_Claim_Reconcile" reconcile ON reconcile.id=line.egcs_fc_fundingagreementclaimreconcile;
  UPDATE "Funding_Case_Agreement_Claim_Reconcile_Line_Item" SET egcs_fc_lineitem=id+1000;
`

describe('Automated Payments SQL financial-source ledger', () => {
  let admin: ReturnType<typeof createDb>
  let db: ReturnType<typeof createDb>
  const report: ScenarioReportRow[] = []
  beforeAll(async () => {
    admin = createDb(false)
    await admin.schema.dropSchema(schemaName).ifExists().cascade().execute()
    await admin.schema.createSchema(schemaName).execute()
    db = createDb()
    await sql.raw(tableDefinitions).execute(db)
  })
  afterAll(async () => {
    await writeScenarioCsvReport('extension-postgres-scenarios.csv', report)
    await db?.destroy()
    await admin?.schema.dropSchema(schemaName).ifExists().cascade().execute()
    await admin?.destroy()
  })
  beforeEach(async () => {
    const tables = await sql<{ tablename: string }>`SELECT tablename FROM pg_tables WHERE schemaname = ${schemaName}`.execute(db)
    await sql.raw(`TRUNCATE ${tables.rows.map(row => `"${row.tablename}"`).join(', ')}`).execute(db)
    await sql.raw(sourceLedger).execute(db)
  })

  const service = (recordedPaidAmount = '500.00', capacityAmount = '500.00', options: { cashPaidAmount?: string, jvEffectAmount?: string, correctionAmount?: string, accountReceivableRecoveryAmount?:string, claimRecoveries?:Array<{claimLineId:string|null,fiscalYearOrder:string,month:number,currency:string,amount:string}>, currency?: string } = {}) => {
    const cashPaidAmount = options.cashPaidAmount ?? (options.jvEffectAmount === undefined && options.correctionAmount === undefined ? recordedPaidAmount : '500.00')
    return {
    ledger: { cashPaidAmount, recordedPaidAmount, capacityAmount, jvEffectAmount: options.jvEffectAmount ?? '0.00', correctionAmount: options.correctionAmount ?? '0.00',
      accountReceivableRecoveryAmount:options.accountReceivableRecoveryAmount??'0.00',claimRecoveries:options.claimRecoveries??[] },
    getClaimRecoveryProjection:vi.fn(async()=>({agreementId:'1',entries:options.claimRecoveries??[]})),
    getCommitmentPaymentCapacity: vi.fn(async () => ({ agreementId: '1', capacityAmount })),
    getRecordedPaidToDate: vi.fn(async () => ({
      agreementId: '1', currency: options.currency ?? 'cad', cashPaidAmount, jvEffectAmount: options.jvEffectAmount ?? '0.00',
      correctionAmount: options.correctionAmount ?? '0.00', accountReceivableRecoveryAmount:options.accountReceivableRecoveryAmount??'0.00', recordedPaidAmount
    }))
    }
  }
  const calculate = async (financials = service(), options: { agreementId?: string, fiscalYearId?: string, currency?: string, paymentType?: 'advance' | 'reimbursement', periodEnd?: number, releaseHoldback?: boolean, holdbackReleaseAmount?: string, excludePaymentId?: string } = {}, expected = {
    baseAmount: '350.00', ceilingAmount: '350.00', holdbackAmount: '190.00', availableBeforeHoldback: '1060.00'
  }) => {
    const result = await calculateAutomatedPaymentFromDb(db, {
      agreementId: options.agreementId ?? '1', commitmentType: '2', fiscalYearId: options.fiscalYearId ?? '20', paymentType: options.paymentType ?? 'advance',
      periodEnd: options.periodEnd ?? 3, ...options
    }, { enabledPaymentTypes: ['advance', 'reimbursement'] }, financials)
    expect(result).toMatchObject(expected)
    if (process.env.AUTOMATED_PAYMENTS_SCENARIO_CSV_DIR || process.env.GCS_PAYMENT_AUDIT_DIR) {
      const [budgets, reconciliations, forecasts, holdback, fiscalYears] = await Promise.all([
        sql`SELECT line.id::text, line.egcs_fc_programfunding::text AS amount, line.egcs_fc_currency AS currency, year.egcs_fc_fundingagreement::text AS agreement_id, year.egcs_fc_originalbudgetfiscalyear::text AS stable_root, fiscal.egcs_ay_fiscalyear AS fiscal_year, version.egcs_fc_iscurrent AS current_version, line._deleted AS deleted, year._deleted AS year_deleted, version._deleted AS version_deleted, fiscal._deleted AS fiscal_year_deleted
          FROM "Funding_Case_Agreement_Budget_Line_Item" line
          JOIN "Funding_Case_Agreement_Budget_Fiscal_Year" year ON year.id = line.egcs_fc_fundingagreementbudgetfiscalyear
          JOIN "Agency_Fiscal_Year" fiscal ON fiscal.id = year.egcs_fc_fiscalyear
          JOIN "Funding_Case_Agreement_Budget_Version" version ON version.id = year.egcs_fc_budgetversion ORDER BY line.id`.execute(db),
        sql`SELECT line.id::text, claim.egcs_fc_fundingagreement::text AS agreement_id, claim.egcs_fc_fiscalyear::text AS fiscal_year_id,
          claim.egcs_fc_periodend AS month, line.egcs_fc_reconciled::text AS amount, source.egcs_fc_currency AS currency, claim._deleted AS claim_deleted, line._deleted AS line_deleted,
          source._deleted AS source_line_deleted, reconcile._deleted AS reconciliation_deleted, completion._deleted AS completion_deleted,
          completion.egcs_cn_disposition AS completion_disposition,
          ARRAY(SELECT runtime.egcs_cn_attempt::text || ':' || runtime.egcs_cn_state || CASE WHEN runtime._deleted THEN ':deleted' ELSE '' END
            FROM "Common_Workflow_Run" run JOIN "Common_Runtime" runtime ON runtime.id = run.id
            WHERE run.egcs_cn_completion = completion.id ORDER BY runtime.egcs_cn_attempt) AS workflow_attempts
          FROM "Funding_Case_Agreement_Claim_Reconcile_Line_Item" line
          JOIN "Funding_Case_Agreement_Claim_Line_Item" source ON source.id=line.egcs_fc_lineitem
          JOIN "Funding_Case_Agreement_Claim_Reconcile" reconcile ON reconcile.id = line.egcs_fc_fundingagreementclaimreconcile
          JOIN "Funding_Case_Agreement_Claim" claim ON claim.id = reconcile.egcs_fc_fundingagreementclaim
          LEFT JOIN "Common_Completion" completion ON completion.egcs_cn_entityid = reconcile.id ORDER BY line.id`.execute(db),
        sql`SELECT line.id::text, forecast.egcs_fc_fundingagreement::text AS agreement_id, forecast.egcs_fc_fiscalyear::text AS fiscal_year_id,
          line.egcs_fc_month AS month, line.egcs_fc_amount::text AS amount, line.egcs_fc_currency AS currency, forecast.egcs_fc_active AS active,
          forecast._deleted AS forecast_deleted, line._deleted AS line_deleted
          FROM "Funding_Case_Agreement_Forecast_Line_Item" line JOIN "Funding_Case_Agreement_Forecast" forecast ON forecast.id = line.egcs_fc_agreementforecast ORDER BY line.id`.execute(db),
        sql<{ percentage: string, basis: string }>`SELECT profile.egcs_fc_holdback::text AS percentage, basis.egcs_ay_holdbackbasis AS basis
          FROM "Funding_Case_Agreement_Profile" profile JOIN "Transfer_Payment_Stream_Holdback_Basis" stream_basis ON stream_basis.id = profile.egcs_fc_holdbackbasis
          JOIN "Agency_Holdback_Basis" basis ON basis.id = stream_basis.egcs_tp_agencyholdback WHERE profile.id = ${options.agreementId ?? '1'}`.execute(db),
        sql`SELECT year.id::text, year.egcs_fc_originalbudgetfiscalyear::text AS stable_root, year.egcs_fc_fundingagreement::text AS agreement_id, fiscal.egcs_ay_fiscalyear AS fiscal_year,
          version.egcs_fc_iscurrent AS current_version, year._deleted AS deleted, version._deleted AS version_deleted,
          fiscal._deleted AS fiscal_year_deleted FROM "Funding_Case_Agreement_Budget_Fiscal_Year" year
          JOIN "Agency_Fiscal_Year" fiscal ON fiscal.id=year.egcs_fc_fiscalyear
          JOIN "Funding_Case_Agreement_Budget_Version" version ON version.id=year.egcs_fc_budgetversion ORDER BY year.id`.execute(db)
      ])
      const actual = details(result)
      report.push({
        scenario_id: `extension-postgres-${String(report.length + 1).padStart(2, '0')}`,
        scenario: `SQL ledger paid ${financials.ledger.recordedPaidAmount}, ${options.paymentType ?? 'advance'}, reserve ${result.holdbackAmount}, release ${options.holdbackReleaseAmount ?? '0.00'}`,
        test_layer: 'extension PostgreSQL ledger', status: 'calculation assertions passed',
        agreement_id: options.agreementId ?? '1', selected_fiscal_year: 2026, selected_fiscal_year_id: options.fiscalYearId ?? '20', period_end: options.periodEnd ?? 3,
        currency: result.currency,
        payment_type: options.paymentType ?? 'advance', excluded_payment_id: options.excludePaymentId,
        commitments_by_fy: 'SDK capacity fixture; host concrete ownership and signed projection checked separately', commitment_capacity: financials.ledger.capacityAmount,
        budgets_by_fy: JSON.stringify(budgets.rows), current_agreement_fiscal_years: JSON.stringify(fiscalYears.rows), reconciliations_by_fy_month: JSON.stringify(reconciliations.rows), forecast_by_fy_month: JSON.stringify(forecasts.rows),
        cash_paid_to_date: financials.ledger.cashPaidAmount, jv_effect_to_date: financials.ledger.jvEffectAmount,
        correction_to_date: financials.ledger.correctionAmount, corrected_recorded_paid_to_date: financials.ledger.recordedPaidAmount,
        account_receivable_recovery_to_date: financials.ledger.accountReceivableRecoveryAmount,
        claim_recoveries_by_original_fy_month: JSON.stringify(financials.ledger.claimRecoveries),
        holdback_basis: String(holdback.rows[0]?.basis), holdback_percentage: String(holdback.rows[0]?.percentage),
        holdback_release_requested: options.holdbackReleaseAmount ?? '0.00',
        actual_claims_to_cutoff: actual.totalClaimsToLastClaimMonth, actual_forecast_to_claim: actual.totalForecastToLastClaimMonth,
        actual_forecast_to_period: actual.totalForecastToPeriodEnd,
        expected_base: expected.baseAmount, actual_base: result.baseAmount,
        expected_holdback: expected.holdbackAmount, actual_holdback: result.holdbackAmount,
        expected_ordinary_available: expected.availableBeforeHoldback, actual_ordinary_available: result.availableBeforeHoldback,
        expected_ceiling: expected.ceilingAmount, actual_ceiling: result.ceilingAmount, actual_suggested: result.suggestedAmount,
        actual_holdback_release: result.holdbackReleaseAmount
      })
    }
    return result
  }
  const details = (result: Awaited<ReturnType<typeof calculate>>) => Object.fromEntries(result.details.map(detail => [detail.label, detail.value]))
  const addUsdLedger = async () => {
    await sql.raw(`
      INSERT INTO "Funding_Case_Agreement_Profile" VALUES (2,10.00,41,false,'usd');
      INSERT INTO "Funding_Case_Agreement_Budget_Fiscal_Year" VALUES (220,NULL,1,2,2,true),(221,220,1,2,2,false),(230,NULL,1,3,2,false);
      INSERT INTO "Funding_Case_Agreement_Forecast" VALUES (50,2,220,true,false);
      INSERT INTO "Funding_Case_Agreement_Budget_Line_Item" VALUES (501,221,125.55,false,'usd'),(502,230,84.46,false,'usd');
      INSERT INTO "Funding_Case_Agreement_Forecast_Line_Item" VALUES
        (501,50,90.01,0,false,'usd'),(502,50,80.03,1,false,'usd'),(503,50,50.02,2,false,'usd'),
        (504,50,40.01,3,false,'usd'),(505,50,70.02,8,false,'usd');
      INSERT INTO "Funding_Case_Agreement_Claim" VALUES (50,2,220,1,false);
      INSERT INTO "Funding_Case_Agreement_Claim_Line_Item" VALUES (5001,50,'usd',false);
      INSERT INTO "Funding_Case_Agreement_Claim_Reconcile" VALUES (50,50,false);
      INSERT INTO "Funding_Case_Agreement_Claim_Reconcile_Line_Item" VALUES (501,50,100.01,false,5001);
      INSERT INTO "Common_Completion" VALUES (50,'fundingclaimreconcile',50,'no_workflow',false);
    `).execute(db)
  }

  it('keeps separate CAD and USD Agreements, claim cutoffs and signed accounting independent', async () => {
    await addUsdLedger()
    const cad = await calculate()
    expect(cad.currency).toBe('CAD')
    const usdFinancials = service('20.02', '75.01', { currency: 'usd', cashPaidAmount: '20.00', jvEffectAmount: '-0.01', correctionAmount: '0.03' })
    const usd = await calculate(usdFinancials, { agreementId: '2', fiscalYearId: '220', currency: 'usd' }, {
      baseAmount: '170.02', ceilingAmount: '75.01', holdbackAmount: '21.00', availableBeforeHoldback: '303.50'
    })
    expect(usd.currency).toBe('USD')
    expect(details(usd)).toMatchObject({ totalClaimsToLastClaimMonth: '100.01', totalForecastToLastClaimMonth: '170.04',
      totalForecastToPeriodEnd: '260.07', totalPaymentsToDate: '20.02' })
    expect(usdFinancials.getRecordedPaidToDate).toHaveBeenCalledExactlyOnceWith({ fiscalYearId: '220', periodEnd: 3, currency: 'usd' })
    expect(usdFinancials.getCommitmentPaymentCapacity).toHaveBeenCalledExactlyOnceWith({ fiscalYearId: '220', commitmentTypeId: '2', currency: 'usd' })
  })

  it('uses only selected-currency successful reconciliations for reimbursement underpayment and overpayment', async () => {
    await addUsdLedger()
    const underpaid = await calculate(service('20.02', '1000.00', { currency: 'usd' }), { agreementId: '2', fiscalYearId: '220', currency: 'usd', paymentType: 'reimbursement' }, {
      baseAmount: '79.99', ceilingAmount: '79.99', holdbackAmount: '21.00', availableBeforeHoldback: '303.50'
    })
    expect(underpaid.currency).toBe('USD')
    await calculate(service('125.02', '1000.00', { currency: 'usd' }), { agreementId: '2', fiscalYearId: '220', currency: 'usd', paymentType: 'reimbursement' }, {
      baseAmount: '0.00', ceilingAmount: '0.00', holdbackAmount: '21.00', availableBeforeHoldback: '198.50'
    })
  })

  it('computes finalfiscal holdback from the single-currency Agreement final fiscal year', async () => {
    await addUsdLedger()
    await sql`UPDATE "Funding_Case_Agreement_Profile" SET egcs_fc_holdbackbasis=42 WHERE id=2`.execute(db)
    await calculate(service('20.02', '1000.00', { currency: 'usd' }), { agreementId: '2', fiscalYearId: '220', currency: 'usd' }, {
      baseAmount: '170.02', ceilingAmount: '170.02', holdbackAmount: '8.00', availableBeforeHoldback: '316.50'
    })
    await sql`DELETE FROM "Funding_Case_Agreement_Budget_Line_Item" WHERE id=502`.execute(db)
    await sql`DELETE FROM "Funding_Case_Agreement_Budget_Fiscal_Year" WHERE id=230`.execute(db)
    await calculate(service('20.02', '1000.00', { currency: 'usd' }), { agreementId: '2', fiscalYearId: '220', currency: 'usd' }, {
      baseAmount: '170.02', ceilingAmount: '170.02', holdbackAmount: '12.00', availableBeforeHoldback: '228.04'
    })
  })

  it('keeps an empty final Agreement fiscal year in the finalfiscal holdback horizon', async () => {
    await addUsdLedger()
    await sql`UPDATE "Funding_Case_Agreement_Profile" SET egcs_fc_holdbackbasis=42 WHERE id=2`.execute(db)
    await sql`DELETE FROM "Funding_Case_Agreement_Budget_Line_Item" WHERE id=502`.execute(db)
    await calculate(service('20.02', '1000.00', { currency: 'usd' }), { agreementId: '2', fiscalYearId: '220', currency: 'usd' }, {
      baseAmount: '170.02', ceilingAmount: '170.02', holdbackAmount: '0.00', availableBeforeHoldback: '240.04'
    })
    // Removing the actual final FY, rather than merely its funding line, moves the horizon to FY2026.
    await sql`DELETE FROM "Funding_Case_Agreement_Budget_Fiscal_Year" WHERE id=230`.execute(db)
    await calculate(service('20.02', '1000.00', { currency: 'usd' }), { agreementId: '2', fiscalYearId: '220', currency: 'usd' }, {
      baseAmount: '170.02', ceilingAmount: '170.02', holdbackAmount: '12.00', availableBeforeHoldback: '228.04'
    })
  })

  it('bounds each currency holdback release by its own final unpaid eligible balance', async () => {
    await addUsdLedger()
    await sql`DELETE FROM "Funding_Case_Agreement_Forecast_Line_Item" WHERE egcs_fc_currency='usd'`.execute(db)
    await sql`DELETE FROM "Funding_Case_Agreement_Budget_Line_Item" WHERE id=502`.execute(db)
    await sql`DELETE FROM "Funding_Case_Agreement_Budget_Fiscal_Year" WHERE id=230`.execute(db)
    await calculate(service('95.01', '1000.00', { currency: 'usd' }), { agreementId: '2', fiscalYearId: '220', currency: 'usd', paymentType: 'reimbursement', releaseHoldback: true, holdbackReleaseAmount: '100.00' }, {
      baseAmount: '5.00', ceilingAmount: '5.00', holdbackAmount: '12.00', availableBeforeHoldback: '0.00'
    })
    await calculate(service('95.01', '1000.00', { currency: 'usd' }), { agreementId: '2', fiscalYearId: '220', currency: 'usd', paymentType: 'reimbursement' }, {
      baseAmount: '5.00', ceilingAmount: '0.00', holdbackAmount: '12.00', availableBeforeHoldback: '0.00'
    })
  })

  it('rejects a requested currency that differs from the Agreement before calling financial services', async () => {
    const financials = service('0.00', '1000.00', { currency: 'eur' })
    await expect(calculate(financials, { currency: 'eur' })).rejects.toMatchObject({ code: 'GCS_AUTOMATED_PAYMENTS_CURRENCY_MISMATCH' })
    expect(financials.getRecordedPaidToDate).not.toHaveBeenCalled()
    expect(financials.getCommitmentPaymentCapacity).not.toHaveBeenCalled()
  })

  it('excludes a reconciliation when its source claim line is deleted', async () => {
    await addUsdLedger()
    await sql`UPDATE "Funding_Case_Agreement_Claim_Line_Item" SET _deleted=true WHERE id=5001`.execute(db)
    await calculate(service('0.00', '1000.00', { currency: 'usd' }), { agreementId: '2', fiscalYearId: '220', currency: 'usd', paymentType: 'reimbursement' }, {
      baseAmount: '0.00', ceilingAmount: '0.00', holdbackAmount: '21.00', availableBeforeHoldback: '393.55'
    })
  })

  it('floors the whole-dollar holdback independently per native currency across separate native Agreements', async () => {
    await sql`DELETE FROM "Funding_Case_Agreement_Budget_Line_Item"`.execute(db)
    await sql`DELETE FROM "Funding_Case_Agreement_Forecast_Line_Item"`.execute(db)
    await sql`DELETE FROM "Funding_Case_Agreement_Claim_Reconcile_Line_Item"`.execute(db)
    await addUsdLedger()
    await sql`DELETE FROM "Funding_Case_Agreement_Budget_Line_Item" WHERE egcs_fc_currency='usd'`.execute(db)
    await sql`DELETE FROM "Funding_Case_Agreement_Forecast_Line_Item" WHERE egcs_fc_currency='usd'`.execute(db)
    await sql`DELETE FROM "Funding_Case_Agreement_Claim_Reconcile_Line_Item"`.execute(db)
    await sql.raw(`INSERT INTO "Funding_Case_Agreement_Budget_Line_Item" VALUES (501,21,125.55,false,'cad'),(502,221,84.46,false,'usd');
      INSERT INTO "Funding_Case_Agreement_Forecast_Line_Item" VALUES (501,1,125.55,0,false,'cad'),(502,50,84.46,0,false,'usd');`).execute(db)
    await calculate(service('0.00', '1000.00'), { currency: 'cad', periodEnd: 0 }, {
      baseAmount: '125.55', ceilingAmount: '113.55', holdbackAmount: '12.00', availableBeforeHoldback: '113.55'
    })
    await calculate(service('0.00', '1000.00', { currency: 'usd' }), { agreementId: '2', fiscalYearId: '220', currency: 'usd', periodEnd: 0 }, {
      baseAmount: '84.46', ceilingAmount: '76.46', holdbackAmount: '8.00', availableBeforeHoldback: '76.46'
    })
  })

  it('uses current stable fiscal years, reconciled successful amounts, active forecasts and correct period cutoffs', async () => {
    const result = await calculate()
    expect(result).toMatchObject({ baseAmount: '350.00', ceilingAmount: '350.00', holdbackAmount: '190.00', availableBeforeHoldback: '1060.00' })
    expect(details(result)).toMatchObject({
      totalClaimsToLastClaimMonth: '650.00', totalForecastToLastClaimMonth: '650.00',
      totalForecastToPeriodEnd: '850.00', totalPaymentsToDate: '500.00', commitmentRemaining: '500.00'
    })
  })

  it.each(['pending', 'running', 'denied', 'unsuccessful', 'failed', 'cancelled'])(
    'excludes a reconciliation whose latest workflow outcome is %s', async state => {
      await sql`UPDATE "Common_Runtime" SET egcs_cn_state = ${state} WHERE id = 121`.execute(db)
      const result = await calculate(service(), {}, { baseAmount: '50.00', ceilingAmount: '50.00', holdbackAmount: '190.00', availableBeforeHoldback: '760.00' })
      expect(details(result).totalClaimsToLastClaimMonth).toBe('350.00')
      expect(result.baseAmount).toBe('50.00')
      expect(result.ceilingAmount).toBe('50.00')
    }
  )

  it('ignores older successful attempts when the latest attempt failed, and counts a successful retry once', async () => {
    const result = await calculate()
    expect(details(result).totalClaimsToLastClaimMonth).toBe('650.00')
    await sql`UPDATE "Common_Runtime" SET _deleted = true WHERE id = 142`.execute(db)
    const retained = await calculate(service(), {}, { baseAmount: '1238.00', ceilingAmount: '500.00', holdbackAmount: '190.00', availableBeforeHoldback: '1948.00' })
    expect(details(retained).totalClaimsToLastClaimMonth).toBe('1538.00')
  })

  it('uses the final fiscal-year budget as the finalfiscal reserve basis', async () => {
    await sql`UPDATE "Funding_Case_Agreement_Profile" SET egcs_fc_holdbackbasis = 42 WHERE id = 1`.execute(db)
    const result = await calculate(service(), {}, { baseAmount: '350.00', ceilingAmount: '350.00', holdbackAmount: '40.00', availableBeforeHoldback: '1210.00' })
    expect(result.holdbackAmount).toBe('40.00')
    expect(result.availableBeforeHoldback).toBe('1210.00')
    expect(result.ceilingAmount).toBe('350.00')
  })

  it.each([
    { recorded: '525.01', jv: '0.00', correction: '25.01', base: '324.99', available: '1034.99' },
    { recorded: '474.99', jv: '0.00', correction: '-25.01', base: '375.01', available: '1085.01' },
    { recorded: '450.00', jv: '-50.00', correction: '0.00', base: '400.00', available: '1110.00' },
    { recorded: '550.00', jv: '50.00', correction: '0.00', base: '300.00', available: '1010.00' }
  ])('consumes SDK signed accounting $recorded without re-querying host Payment/JV/Correction tables', async scenario => {
    const financials = service(scenario.recorded, '1000.00', { jvEffectAmount: scenario.jv, correctionAmount: scenario.correction })
    const result = await calculate(financials, { excludePaymentId: '99' }, { baseAmount: scenario.base, ceilingAmount: scenario.base, holdbackAmount: '190.00', availableBeforeHoldback: scenario.available })
    expect(result.baseAmount).toBe(scenario.base)
    expect(result.ceilingAmount).toBe(scenario.base)
    expect(result.availableBeforeHoldback).toBe(scenario.available)
    expect(financials.getRecordedPaidToDate).toHaveBeenCalledExactlyOnceWith({ fiscalYearId: '20', periodEnd: 3, currency: 'cad', excludePaymentId: '99' })
    expect(financials.getCommitmentPaymentCapacity).toHaveBeenCalledExactlyOnceWith({ fiscalYearId: '20', commitmentTypeId: '2', currency: 'cad', excludePaymentId: '99' })
  })


  it('uses a successful ineligible-expense Credit Memo in its original Claim period and separate paid total',async()=>{
    const financials=service('480.00','520.00',{cashPaidAmount:'500.00',accountReceivableRecoveryAmount:'-20.00',claimRecoveries:[{claimLineId:'1112',fiscalYearOrder:'2026',month:1,currency:'cad',amount:'-20.00'},{claimLineId:'999',fiscalYearOrder:'2026',month:1,currency:'usd',amount:'-999.00'}]})
    const result=await calculate(financials,{}, {baseAmount:'350.00',ceilingAmount:'350.00',holdbackAmount:'190.00',availableBeforeHoldback:'1060.00'})
    expect(details(result)).toMatchObject({totalClaimsToLastClaimMonth:'630.00',totalPaymentsToDate:'480.00',commitmentRemaining:'520.00'})
    expect(financials.getClaimRecoveryProjection).toHaveBeenCalledExactlyOnceWith()
  })
  it('keeps approved Claims intact for an outstanding-advance Credit Memo paid recovery',async()=>{
    const financials=service('480.00','520.00',{cashPaidAmount:'500.00',accountReceivableRecoveryAmount:'-20.00'})
    const result=await calculate(financials,{}, {baseAmount:'370.00',ceilingAmount:'370.00',holdbackAmount:'190.00',availableBeforeHoldback:'1080.00'})
    expect(details(result)).toMatchObject({totalClaimsToLastClaimMonth:'650.00',totalPaymentsToDate:'480.00',commitmentRemaining:'520.00'})
  })

  it('uses the SDK shared coding-pool threshold exactly, including a one-cent boundary', async () => {
    const result = await calculate(service('500.00', '349.99'), {}, { baseAmount: '350.00', ceilingAmount: '349.99', holdbackAmount: '190.00', availableBeforeHoldback: '1060.00' })
    expect(result.baseAmount).toBe('350.00')
    expect(result.ceilingAmount).toBe('349.99')
  })

  it('rounds a fractional exact PostgreSQL percentage down to whole-dollar reserve', async () => {
    await sql`UPDATE "Funding_Case_Agreement_Profile" SET egcs_fc_holdback = 12.34 WHERE id = 1`.execute(db)
    const result = await calculate(service(), {}, { baseAmount: '350.00', ceilingAmount: '350.00', holdbackAmount: '234.00', availableBeforeHoldback: '1016.00' })
    // $1,900 × 12.34% = $234.46, so the reserve is $234, not $234.46.
    expect(result.holdbackAmount).toBe('234.00')
    expect(result.availableBeforeHoldback).toBe('1016.00')
  })

  it('reapplies full reserve after prior releases and clips it to the final unpaid balance', async () => {
    await sql`DELETE FROM "Funding_Case_Agreement_Budget_Line_Item" WHERE id IN (100,300)`.execute(db)
    await sql`DELETE FROM "Funding_Case_Agreement_Forecast_Line_Item"`.execute(db)
    await sql`DELETE FROM "Funding_Case_Agreement_Claim_Reconcile_Line_Item"`.execute(db)
    await sql`INSERT INTO "Funding_Case_Agreement_Claim_Reconcile_Line_Item" VALUES (200,12,1000.00,false,1112)`.execute(db)
    const result = await calculate(service('950.00', '50.00'), {
      paymentType: 'reimbursement', releaseHoldback: true, holdbackReleaseAmount: '100.00'
    }, { baseAmount: '50.00', ceilingAmount: '50.00', holdbackAmount: '100.00', availableBeforeHoldback: '0.00' })
    expect(result).toMatchObject({ baseAmount: '50.00', holdbackAmount: '100.00', availableBeforeHoldback: '0.00', holdbackReleaseAmount: '50.00', ceilingAmount: '50.00' })
    const withoutRelease = await calculate(service('950.00', '50.00'), { paymentType: 'reimbursement' }, { baseAmount: '50.00', ceilingAmount: '0.00', holdbackAmount: '100.00', availableBeforeHoldback: '0.00' })
    expect(withoutRelease.ceilingAmount).toBe('0.00')
  })

  it('retains cents across PostgreSQL row text, aggregates above numeric(19,2), and corrected paid', async () => {
    await sql`DELETE FROM "Funding_Case_Agreement_Budget_Line_Item"`.execute(db)
    await sql`INSERT INTO "Funding_Case_Agreement_Budget_Line_Item" VALUES (201,21,99999999999999999.99,false),(202,21,99999999999999999.99,false)`.execute(db)
    await sql`UPDATE "Funding_Case_Agreement_Profile" SET egcs_fc_holdback = 0 WHERE id = 1`.execute(db)
    await sql`DELETE FROM "Funding_Case_Agreement_Forecast_Line_Item"`.execute(db)
    await sql`DELETE FROM "Funding_Case_Agreement_Claim_Reconcile_Line_Item"`.execute(db)
    await sql`INSERT INTO "Funding_Case_Agreement_Claim_Reconcile_Line_Item" VALUES (201,12,99999999999999999.99,false,1112),(202,12,99999999999999999.99,false,1112)`.execute(db)
    const result = await calculate(service('199999999999999999.97', '0.01'), { paymentType: 'reimbursement' }, { baseAmount: '0.01', ceilingAmount: '0.01', holdbackAmount: '0.00', availableBeforeHoldback: '0.01' })
    expect(details(result).totalClaimsToLastClaimMonth).toBe('199999999999999999.98')
    expect(result.baseAmount).toBe('0.01')
    expect(result.ceilingAmount).toBe('0.01')
    const largePayment = await calculate(service('0.00', '199999999999999999.98'), { paymentType: 'reimbursement' }, {
      baseAmount: '199999999999999999.98', ceilingAmount: '99999999999999999.99', holdbackAmount: '0.00', availableBeforeHoldback: '199999999999999999.98'
    })
    expect(largePayment.baseAmount).toBe('199999999999999999.98')
    expect(largePayment.ceilingAmount).toBe('99999999999999999.99')
    expect(largePayment.suggestedAmount).toBe('99999999999999999.99')
  })
})
