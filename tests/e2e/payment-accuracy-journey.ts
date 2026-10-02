import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type Browser, type Page, type TestInfo } from '@playwright/test'

type Owner = { agencyId: string; agreementId: string; programId: string; streamId: string }
type Id = { id: string }
type Row = Id & Record<string, unknown>
type Calculation = {
  currency: string; suggestedAmount: string; ceilingAmount: string; baseAmount: string; holdbackAmount: string
  holdbackReleaseAmount: string; availableBeforeHoldback: string
  details: Array<{ label: string; value: string }>
}
type Helpers = {
  login: (page: Page, email: string, password: string) => Promise<void>
  approveAll: (page: Page, entityType: string, id: string) => Promise<void>
  complete: (page: Page, entityType: string, id: string, comments: string) => Promise<void>
}

// Deliberately independent of production Money/calculator helpers.
const cents = (value: string): bigint => {
  if (!/^-?\d+\.\d{2}$/.test(value)) throw new Error(`Noncanonical audit money: ${value}`)
  return BigInt(value.replace('.', ''))
}
const money = (value: bigint): string => {
  const absolute = value < BigInt(0) ? -value : value
  return `${value < BigInt(0) ? '-' : ''}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, '0')}`
}
const sum = (values: string[]) => money(values.reduce((total, value) => total + cents(value), BigInt(0)))
const max = (a: bigint, b: bigint) => a > b ? a : b
const min = (...values: bigint[]) => values.reduce((a, b) => a < b ? a : b)
const csvCell = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`

const read = async <T>(page: Page, url: string): Promise<T> => {
  const response = await page.request.get(url)
  expect(response.ok(), `${url}: ${response.status()} ${await response.text()}`).toBe(true)
  return await response.json() as T
}
const post = async <T extends Id = Row>(page: Page, url: string, data: Record<string, unknown>): Promise<T> => {
  const response = await page.request.post(url, { data })
  expect(response.ok(), `${url}: ${response.status()} ${await response.text()}`).toBe(true)
  return await response.json() as T
}
const items = async (page: Page, url: string) => (await read<{ items: Row[] }>(page, `${url}${url.includes('?') ? '&' : '?'}limit=100`)).items

export const shiftPaymentAuditMoney = (value: string, adjustment: string) => money(cents(value) + cents(adjustment))

/** Captures public source evidence for each independently asserted JV/Correction checkpoint. */
export const createPaymentLifecycleAuditRecorder = (page: Page, testInfo: TestInfo, owner: Owner) => {
  const rows: Array<Record<string, unknown>> = []
  const snapshots: Array<Record<string, unknown>> = []
  const base = `/api/agreements/${owner.agreementId}`
  const snapshot = async (url: string): Promise<Record<string, unknown>> => {
    const response = await page.request.get(url)
    if (response.status() === 403) return { access_status: 403, response: await response.json() }
    expect(response.ok(), `${url}: ${response.status()} ${await response.text()}`).toBe(true)
    return await response.json() as Record<string, unknown>
  }
  const detailsFor = async (collection: Record<string, unknown>, key: string, path: string) => {
    const records = collection[key]
    if (!Array.isArray(records)) return []
    return await Promise.all((records as Row[]).map(row => snapshot(`${path}/${row.id}`)))
  }
  return async (input: {
    scenario: string; fiscalYearId: string; commitmentType: string; periodEnd: number; calculation: Calculation
    expectedCommitmentCapacity?: string; expectedRecordedPaid?: string; note: string
  }) => {
    const { calculation } = input
    const detailValues = Object.fromEntries(calculation.details.map(detail => [detail.label, detail.value]))
    if (input.expectedCommitmentCapacity !== undefined) expect(detailValues.commitmentRemaining).toBe(input.expectedCommitmentCapacity)
    if (input.expectedRecordedPaid !== undefined) expect(detailValues.totalPaymentsToDate).toBe(input.expectedRecordedPaid)
    const [agreement, budget, forecasts, claims, payments, commitments, journalVouchers, corrections, financialSummary] = await Promise.all([
      snapshot(base), snapshot(`${base}/budget-overview`), snapshot(`${base}/forecasts-overview`),
      snapshot(`${base}/claims-overview`), snapshot(`${base}/payments-overview`), snapshot(`${base}/commitments-overview`),
      snapshot(`/api/journal-vouchers?egcs_fc_fundingagreement=${owner.agreementId}&limit=100`),
      snapshot(`${base}/corrections?limit=100`), snapshot(`${base}/financial-summary`)
    ])
    const [paymentDetails, commitmentDetails, jvDetails, correctionDetails] = await Promise.all([
      detailsFor(payments, 'payments', `${base}/payments`), detailsFor(commitments, 'commitments', `${base}/commitments`),
      detailsFor(journalVouchers, 'items', '/api/journal-vouchers'), detailsFor(corrections, 'items', '/api/corrections')
    ])
    const sources = { agreement, budget, forecasts, claims, payments: paymentDetails, commitments: commitmentDetails,
      journal_voucher_collection: journalVouchers, journal_vouchers: jvDetails,
      correction_collection: corrections, corrections: correctionDetails, financial_summary: financialSummary }
    snapshots.push({ scenario: input.scenario, fiscal_year_id: input.fiscalYearId, period_end: input.periodEnd, calculation, sources })
    rows.push({
      scenario_id: input.scenario, agreement_id: owner.agreementId, fiscal_year_id: input.fiscalYearId,
      period_end: input.periodEnd, payment_type: 'advance', commitment_type: input.commitmentType,
      expected_commitment_capacity: input.expectedCommitmentCapacity ?? '', actual_commitment_capacity: detailValues.commitmentRemaining,
      expected_recorded_paid: input.expectedRecordedPaid ?? '', actual_recorded_paid: detailValues.totalPaymentsToDate,
      currency: calculation.currency.toLowerCase(), reconciled_claims_to_cutoff: detailValues.totalClaimsToLastClaimMonth,
      forecast_to_last_claim: detailValues.totalForecastToLastClaimMonth, forecast_to_period: detailValues.totalForecastToPeriodEnd,
      actual_base: calculation.baseAmount, actual_ceiling: calculation.ceilingAmount, actual_suggested: calculation.suggestedAmount,
      holdback_percentage: agreement.egcs_fc_holdback, holdback_basis_id: agreement.egcs_fc_holdbackbasis,
      actual_holdback: calculation.holdbackAmount, actual_ordinary_available: calculation.availableBeforeHoldback,
      actual_release: calculation.holdbackReleaseAmount,
      budgets_by_fy: JSON.stringify(budget), commitments_by_fy: JSON.stringify(commitmentDetails),
      forecast_rows: JSON.stringify(forecasts), claim_and_reconciliation_rows: JSON.stringify(claims), payment_rows: JSON.stringify(paymentDetails),
      jv_rows: JSON.stringify(jvDetails), correction_rows: JSON.stringify(correctionDetails), financial_summary_by_fy: JSON.stringify(financialSummary),
      correction_source_access: corrections.access_status ?? 200,
      independently_verified_fields: [input.expectedCommitmentCapacity === undefined ? '' : 'commitment capacity', input.expectedRecordedPaid === undefined ? '' : 'recorded paid'].filter(Boolean).join('; '),
      result: input.expectedCommitmentCapacity === undefined && input.expectedRecordedPaid === undefined ? 'OBSERVED_BASELINE' : 'PASS', note: input.note
    })
    const header = Object.keys(rows[0]!)
    const csv = [header.map(csvCell).join(','), ...rows.map(row => header.map(key => csvCell(row[key])).join(','))].join('\n') + '\n'
    for (const directory of [testInfo.outputDir, process.env.GCS_PAYMENT_AUDIT_DIR].filter((value): value is string => Boolean(value))) {
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'automated-payment-jv-correction-checkpoints.csv'), csv)
      await writeFile(join(directory, 'automated-payment-jv-correction-raw.json'), JSON.stringify(snapshots, null, 2))
    }
  }
}

/** Package-owned fixture; all setup and assertions use public host/extension APIs. */
export const preparePaymentAuditFixture = async (
  page: Page, source: Owner
) => {
  const token = `${Date.now()}`
  const sourceBase = `/api/transfer-payments/${source.programId}/streams/${source.streamId}`
  const sourceRows = {
    charts: await items(page, `${sourceBase}/chart-of-accounts`),
    budgets: await items(page, `${sourceBase}/budgets`),
    types: await items(page, `${sourceBase}/commitment-types`),
    categories: await items(page, `${sourceBase}/cost-category-line-items`),
    subtypes: await items(page, `${sourceBase}/agreement-subtypes`),
    recipients: await items(page, `${sourceBase}/eligible-recipients`),
    holdbacks: await items(page, `/api/agency/${source.agencyId}/holdback-bases`),
    fiscalYears: await items(page, `/api/agency/${source.agencyId}/fiscal-years`)
  }
  const chart = sourceRows.charts.find(row => row.egcs_ay_currency === 'cad' && sourceRows.budgets.some(budget => budget.egcs_tp_currency === 'cad' && String(budget.egcs_tp_fiscalyear) === String(row.egcs_ay_fiscalyear)))!
  expect(chart, 'Seeded chart with a program budget').toBeTruthy()
  const sourceBudget = sourceRows.budgets.find(row => row.egcs_tp_currency === 'cad' && String(row.egcs_tp_fiscalyear) === String(chart.egcs_ay_fiscalyear))!
  const fiscal = sourceRows.fiscalYears.find(row => String(row.id) === String(chart.egcs_ay_fiscalyear))!
  expect(fiscal).toBeTruthy()
  const fullBasis = sourceRows.holdbacks.find(row => row.egcs_ay_holdbackbasis === 'fullagreement')!
  expect(fullBasis).toBeTruthy()
  const stream = await post(page, `/api/transfer-payments/${source.programId}/streams`, {
    egcs_tp_name_en: `Payment accuracy ${token}`, egcs_tp_name_fr: `Exactitude des paiements ${token}`,
    egcs_tp_description_en: 'Disposable financial arithmetic scenarios.', egcs_tp_description_fr: 'Scénarios jetables de calcul financier.',
    egcs_tp_abbreviation_en: `PA-${token}`, egcs_tp_abbreviation_fr: `EP-${token}`,
    egcs_tp_objective_en: 'Verify exact payments.', egcs_tp_objective_fr: 'Vérifier les paiements exacts.', egcs_tp_active: true
  })
  const owner = { ...source, streamId: String(stream.id) }
  const streamBase = `/api/transfer-payments/${owner.programId}/streams/${owner.streamId}`
  // Demo program funding is already allocated to existing streams. Author new
  // capacity in this disposable database instead of borrowing another stream's allocation.
  const programBudget = (await items(page, `/api/transfer-payments/${owner.programId}/budgets`))
    .find(row => String(row.id) === String(sourceBudget.egcs_tp_transferpaymentbudget))!
  expect(programBudget).toBeTruthy()
  const allocated: string[] = []
  for (const existingStream of await items(page, `/api/transfer-payments/${owner.programId}/streams`)) {
    for (const budget of await items(page, `/api/transfer-payments/${owner.programId}/streams/${existingStream.id}/budgets`)) {
      if (String(budget.egcs_tp_transferpaymentbudget) === String(programBudget.id)) {
        allocated.push(String(budget.egcs_tp_totalbudget))
      }
    }
  }
  const increaseBudget = await page.request.patch(`/api/transfer-payments/${owner.programId}/budgets/${programBudget.id}`, { data: {
    egcs_tp_totalbudget: money(max(cents(String(programBudget.egcs_tp_totalbudget)), cents(sum(allocated))) + cents('2000.05'))
  } })
  expect(increaseBudget.ok(), await increaseBudget.text()).toBe(true)
  const authoredStreamBudget = await post(page, `${streamBase}/budgets`, {
    egcs_tp_transferpaymentbudget: sourceBudget.egcs_tp_transferpaymentbudget,
    egcs_tp_totalbudget: '2000.05', egcs_tp_overcommitthreshold: 0
  })
  const linkedChart = await post(page, `${streamBase}/chart-of-accounts`, { egcs_tp_agencychartofaccount: chart.egcs_tp_agencychartofaccount })
  await post(page, `${streamBase}/commitment-types`, { egcs_tp_agencycommitmenttype: sourceRows.types[0]!.egcs_tp_agencycommitmenttype })
  const subtype = await post(page, `${streamBase}/agreement-subtypes`, {
    egcs_tp_agreementtype: sourceRows.subtypes[0]!.egcs_tp_agreementtype,
    egcs_tp_transferpaymentstream: owner.streamId
  })
  await post(page, `${streamBase}/eligible-recipients`, { egcs_tp_applicantrecipientsubtype: sourceRows.recipients[0]!.egcs_tp_applicantrecipientsubtype })
  await post(page, `${streamBase}/cost-category-line-items`, {
    egcs_tp_organizationcostcategory: sourceRows.categories[0]!.egcs_tp_organizationcostcategory, egcs_tp_costsharingratio: 1, egcs_tp_active: true
  })
  const basis = await post(page, `${streamBase}/holdback-bases`, { egcs_tp_agencyholdback: fullBasis.id })
  const finalBasis = sourceRows.holdbacks.find(row => row.egcs_ay_holdbackbasis === 'finalfiscal')!
  expect(finalBasis).toBeTruthy()
  const authoredFinalBasis = await post(page, `${streamBase}/holdback-bases`, { egcs_tp_agencyholdback: finalBasis.id })
  const statuses = await read<Array<{ id: string; agencyId: string; nameEn: string; isDraft: boolean; terminal: boolean; readOnly: boolean }>>(page, '/api/statuses')
  const agencyStatuses = statuses.filter(status => status.agencyId === owner.agencyId)
  const draft = agencyStatuses.find(status => status.isDraft)!
  const approved = agencyStatuses.find(status => status.nameEn === 'Approved')!
  const denied = agencyStatuses.find(status => status.nameEn === 'Denied')!
  const paid = agencyStatuses.find(status => status.nameEn === 'Paid' && status.terminal)!
  const verifier = (await items(page, '/api/users/lookups?status=active&search=user11%40example.com')).find(row => row.egcs_cn_email === 'user11@example.com')!
  expect(draft && approved && denied && paid && verifier).toBeTruthy()
  const template = await post(page, `/api/agency/${owner.agencyId}/approval-templates`, {
    egcs_cn_name_en: `Payment audit approval ${token}`, egcs_cn_name_fr: `Approbation des paiements ${token}`,
    egcs_cn_description_en: 'Independent financial verification.', egcs_cn_description_fr: 'Vérification financière indépendante.',
    steps: [{ egcs_cn_sequence: 1, egcs_cn_name_en: 'Verify amounts', egcs_cn_name_fr: 'Vérifier les montants',
      egcs_cn_description_en: 'Check independent arithmetic.', egcs_cn_description_fr: 'Vérifier les calculs indépendants.',
      egcs_cn_defaultuser: verifier.id, egcs_cn_approvertitle: 'Financial verifier', certifications: [] }]
  })
  await post(page, `/api/agency/${owner.agencyId}/approval-templates/${template.id}/publish`, {})
  for (const entityType of ['fundingcaseagreementcommitment', 'fundingcaseagreementclaim', 'fundingclaimreconcile', 'fundingcaseforecast', 'fundingcasepayment']) {
    const workflow = await post(page, `/api/agency/${owner.agencyId}/workflows`, {
      egcs_cn_entitytype: entityType, egcs_cn_name_en: `Audit ${entityType} ${token}`, egcs_cn_name_fr: `Vérification ${entityType} ${token}`,
      egcs_cn_description_en: 'Disposable verification.', egcs_cn_description_fr: 'Vérification jetable.',
      egcs_cn_purpose: 'approval_submission', egcs_cn_allowedstartstatuses: [draft.id],
      egcs_cn_cancellationstatus: denied.id, egcs_cn_executionfailurestatus: denied.id, egcs_cn_allowretry: false
    })
    await post(page, `/api/agency/${owner.agencyId}/workflows/${workflow.id}/members`, {
      egcs_cn_sequence: 1, egcs_cn_kind: 'approval_template', egcs_cn_approvaltemplate: template.id,
      egcs_cn_successstatus: entityType === 'fundingcasepayment' ? paid.id : approved.id, egcs_cn_failurestatus: denied.id, owners: []
    })
    await post(page, `/api/agency/${owner.agencyId}/workflows/${workflow.id}/publish`, {})
    await post(page, `${streamBase}/workflows`, { egcs_tp_workflow: workflow.id })
  }
  let selectedProponent: { recipient: Row; types: Row[] } | undefined
  for (const recipient of await items(page, '/api/agreements/lookups/applicant-recipients')) {
    const types = await items(page, `/api/agreements/lookups/proponent-types?stream_id=${owner.streamId}&proponent_id=${recipient.id}`)
    if (types.length > 0) {
      selectedProponent = { recipient, types }
      break
    }
  }
  expect(selectedProponent, 'A recipient compatible with the authored stream subtype').toBeTruthy()
  const { recipient, types: proponentTypes } = selectedProponent!
  const agreementInput = {
    egcs_fc_agreementnumber: `MATH-${token.slice(-10)}`, egcs_fc_transferpaymentstream: owner.streamId,
    egcs_fc_currency: 'cad',
    egcs_fc_financialsystemnumber: Number(token.slice(-9)), egcs_fc_customfields: {},
    egcs_fc_title_en: `Payment arithmetic ${token}`, egcs_fc_title_fr: `Calcul des paiements ${token}`,
    egcs_fc_description_en: 'Fixed inputs for manual financial verification.', egcs_fc_description_fr: 'Données fixes pour vérifier les calculs financiers.',
    egcs_fc_agreementsubtype: subtype.id, egcs_fc_furtherdistribution: false, egcs_fc_holdback: 10, egcs_fc_holdbackbasis: basis.id,
    egcs_fc_authorizedassistancestartdate: String(fiscal.egcs_ay_startdate).slice(0, 10),
    egcs_fc_authorizedassistanceenddate: String(fiscal.egcs_ay_enddate).slice(0, 10),
    egcs_fc_applicantrecipients: [{ egcs_fc_applicantrecipient: recipient.id, egcs_fc_applicantrecipientsubtype: proponentTypes[0]!.id }], confirmations: []
  }
  const agreement = await post(page, '/api/agreements', agreementInput)
  owner.agreementId = String(agreement.id)
  const agreementBase = `/api/agreements/${owner.agreementId}`
  const fiscalYear = await post(page, `${agreementBase}/budget-fiscal-years`, { egcs_fc_fiscalyear: fiscal.id })
  const category = (await items(page, `${agreementBase}/budget-line-items/lookups/organization-cost-categories`))[0]!
  const budgetLine = await post(page, `${agreementBase}/budget-line-items`, {
    egcs_fc_fundingagreementbudgetfiscalyear: fiscalYear.id, egcs_fc_organizationcostcategory: category.id,
    egcs_fc_costsubsection: 'Independent payment audit', egcs_fc_description: 'Exact manual inputs',
    egcs_fc_totalamount: '1000.05', egcs_fc_programfunding: '1000.05', egcs_fc_fundingsources: [], egcs_fc_currency: 'cad'
  })
  const updatedProgramBudget = await read<Row>(page, `/api/transfer-payments/${owner.programId}/budgets/${programBudget.id}`)
  return { owner, agreementBase, fiscalYear, fiscal, budgetLine, category, linkedChart, sourceBudget, sourceRows, streamBase, authoredStreamBudget, updatedProgramBudget, agreementInput, authoredFinalBasis }
}

export const runPaymentAccuracyJourney = async (
  page: Page, browser: Browser, testInfo: TestInfo, source: Owner, helpers: Helpers
) => {
  const { owner, agreementBase, fiscalYear, fiscal, budgetLine, linkedChart } = await preparePaymentAuditFixture(page, source)
  const commitmentType = (await items(page, `${agreementBase}/commitments/lookups/types`))[0]!
  const commitment = await post(page, `${agreementBase}/commitments`, { egcs_fc_type: commitmentType.id, egcs_fc_currency: 'cad' })
  const commitmentLine = await post(page, `${agreementBase}/commitment-lines`, {
    egcs_fc_commitment: commitment.id, egcs_fc_commitmentlinenumber: 1,
    egcs_fc_transferpaymentstreamchartofaccount: linkedChart.id, egcs_fc_amount: '1000.05'
  })
  const approver = await browser.newPage()
  await helpers.login(approver, 'user11@example.com', 'password123')
  const complete = async (entityType: string, id: string) => {
    await helpers.complete(page, entityType, String(id), 'Amounts verified against independent payment-audit ledger.')
    await helpers.approveAll(approver, entityType, String(id))
  }
  await complete('fundingcaseagreementcommitment', commitment.id)
  const forecast = await post(page, `${agreementBase}/forecasts`, { egcs_fc_fiscalyear: fiscalYear.id })
  const forecasts = ['300.01', '300.02', '400.02']
  for (const [month, amount] of forecasts.entries()) {
    await post(page, `${agreementBase}/forecast-line-items`, {
      egcs_fc_agreementforecast: forecast.id, egcs_fc_fundingagreementbudgetlineitem: budgetLine.id,
      egcs_fc_month: month, egcs_fc_amount: amount, egcs_fc_totalamount: amount, egcs_fc_currency: 'cad', egcs_fc_version: 0
    })
  }
  await complete('fundingcaseforecast', forecast.id)
  const enabled = await page.request.patch(`/api/extensions/streams/${owner.streamId}`, { data: {
    extensionKey: 'gcs-automated-payments', enabled: true, config: { enabledPaymentTypes: ['advance', 'reimbursement'] }
  } })
  expect(enabled.ok(), await enabled.text()).toBe(true)

  const ledger: Array<Record<string, unknown>> = []
  const scenarios: Array<Record<string, unknown>> = []
  const raw: Array<Record<string, unknown>> = []
  let paidAmount = '0.00'
  let claimsAmount = '0.00'
  let submittedClaims = '0.00'
  let lastClaimMonth = -1
  const persist = async () => {
    const header = Object.keys(scenarios[0] ?? {})
    const scenarioCsv = [header.map(csvCell).join(','), ...scenarios.map(row => header.map(key => csvCell(row[key])).join(','))].join('\n') + '\n'
    const ledgerHeader = ['agreement_id', 'fiscal_year_id', 'fiscal_year', 'currency', 'kind', 'entity_id', 'month', 'amount', 'coding_id', 'state', 'description']
    const ledgerCsv = [ledgerHeader.map(csvCell).join(','), ...ledger.map(row => ledgerHeader.map(key => csvCell(row[key])).join(','))].join('\n') + '\n'
    for (const directory of [testInfo.outputDir, process.env.GCS_PAYMENT_AUDIT_DIR].filter((value): value is string => Boolean(value))) {
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'automated-payment-scenarios.csv'), scenarioCsv)
      await writeFile(join(directory, 'automated-payment-ledger.csv'), ledgerCsv)
      await writeFile(join(directory, 'automated-payment-raw.json'), JSON.stringify(raw, null, 2))
    }
  }
  const addLedger = (kind: string, id: string, month: number | string, amount: string, description: string) => ledger.push({
    agreement_id: owner.agreementId, fiscal_year_id: fiscalYear.id, fiscal_year: fiscal.egcs_ay_fiscalyeardisplay,
    currency: 'cad', kind, entity_id: id, month, amount, coding_id: kind === 'commitment' || kind === 'payment' ? linkedChart.id : '',
    state: kind === 'payment' ? 'paid' : kind === 'forecast' ? 'active' : 'approved', description
  })
  addLedger('budget', budgetLine.id, '', '1000.05', 'Program funding; 10% holdback floors $100.005 to $100.00.')
  addLedger('commitment', commitmentLine.id, '', '1000.05', 'One approved commitment coding row.')
  forecasts.forEach((amount, month) => addLedger('forecast', forecast.id, month, amount, 'Active forecast by fiscal month.'))
  const check = async (scenario: string, paymentType: 'advance' | 'reimbursement', periodEnd: number, release = '0.00') => {
    const forecastToEnd = sum(forecasts.slice(0, periodEnd + 1))
    const forecastToClaim = sum(forecasts.slice(0, lastClaimMonth + 1))
    const unclaimedForecast = sum(forecasts.slice(lastClaimMonth + 1))
    const baseSigned = paymentType === 'advance'
      ? cents(claimsAmount) - cents(forecastToClaim) + cents(forecastToEnd) - cents(paidAmount)
      : cents(claimsAmount) - cents(paidAmount)
    const remaining = max(BigInt(0), cents(claimsAmount) + cents(unclaimedForecast) - cents(paidAmount))
    const held = min(cents('100.00'), remaining)
    const ordinary = remaining - held
    const released = min(cents(release), held)
    const capacity = cents('1000.05') - cents(paidAmount)
    const expected = money(max(BigInt(0), min(max(BigInt(0), baseSigned), capacity, ordinary + released)))
    const body = {
      egcs_fc_commitmenttype: commitmentType.id, egcs_fc_fiscalyear: fiscalYear.id, egcs_fc_currency: 'cad',
      egcs_fc_paymenttype: paymentType, egcs_fc_periodstart: 0, egcs_fc_periodend: periodEnd,
      extensions: { 'gcs-automated-payments': { releaseHoldback: cents(release) > BigInt(0), holdbackReleaseAmount: release } }
    }
    const response = await page.request.post(`/api/extensions/gcs-automated-payments/agreements/${owner.agreementId}/calculate-payment`, { data: body })
    expect(response.ok(), await response.text()).toBe(true)
    const actual = await response.json() as Calculation
    scenarios.push({ scenario_id: scenario, agreement_id: owner.agreementId, fiscal_year_id: fiscalYear.id,
      fiscal_year: fiscal.egcs_ay_fiscalyeardisplay, currency: 'cad', period_end: periodEnd, payment_type: paymentType,
      commitment: '1000.05', forecast_fy: '1000.05', forecast_to_period: forecastToEnd,
      forecast_to_last_claim: forecastToClaim, forecast_unclaimed: unclaimedForecast,
      submitted_claims: submittedClaims, reconciled_claims: claimsAmount, cash_paid: paidAmount,
      jv_net: '0.00', corrections: '0.00', recorded_paid: paidAmount, holdback_basis: 'fullagreement',
      holdback_percent: 10, holdback: '100.00', unpaid_eligible: money(remaining),
      reserved_now: money(held), ordinary_available: money(ordinary), requested_release: release,
      actual_ordinary_available: actual.availableBeforeHoldback,
      permitted_release: money(released), actual_permitted_release: actual.holdbackReleaseAmount,
      signed_base: money(baseSigned), base: money(max(BigInt(0), baseSigned)),
      commitment_remaining: money(capacity), expected_payment: expected, actual_payment: actual.suggestedAmount,
      selected_payment: '', created_payment_id: '',
      result: actual.suggestedAmount === expected ? 'PASS' : 'FAIL' })
    raw.push({ scenario, actual, budget: await read(page, `${agreementBase}/budget-overview`),
      commitments: await read(page, `${agreementBase}/commitments-overview`), forecasts: await read(page, `${agreementBase}/forecasts-overview`),
      claims: await read(page, `${agreementBase}/claims-overview`), payments: await read(page, `${agreementBase}/payments-overview`) })
    await persist()
    expect(actual.holdbackAmount).toBe('100.00')
    expect(actual.availableBeforeHoldback).toBe(money(ordinary))
    expect(actual.holdbackReleaseAmount).toBe(money(released))
    expect(actual.baseAmount).toBe(money(max(BigInt(0), baseSigned)))
    expect(actual.suggestedAmount).toBe(expected)
    expect(actual.ceilingAmount).toBe(expected)
    expect(actual.details.find(detail => detail.label === 'totalClaimsToLastClaimMonth')!.value).toBe(claimsAmount)
    expect(actual.details.find(detail => detail.label === 'totalPaymentsToDate')!.value).toBe(paidAmount)
    expect(actual.details.find(detail => detail.label === 'commitmentRemaining')!.value).toBe(money(capacity))
    const prior = (await read<{ payments: Id[] }>(page, `${agreementBase}/payments-overview`)).payments.map(row => row.id)
    const rejected = await page.request.post(`${agreementBase}/payments`, { data: {
      ...body, egcs_fc_paymentamount: money(cents(expected) + BigInt(1)), egcs_fc_currency: 'cad'
    } })
    expect(rejected.status(), await rejected.text()).toBe(400)
    expect(await rejected.text()).toContain('GCS_AUTOMATED_PAYMENTS_AMOUNT_EXCEEDS_CEILING')
    expect((await read<{ payments: Id[] }>(page, `${agreementBase}/payments-overview`)).payments.map(row => row.id)).toEqual(prior)
    return { expected, body }
  }
  const createPaymentUi = async (scenario: string, paymentType: 'advance' | 'reimbursement', periodEnd: number, release = '0.00', override?: string) => {
    const { expected } = await check(scenario, paymentType, periodEnd, release)
    const before = (await read<{ payments: Id[] }>(page, `${agreementBase}/payments-overview`)).payments.map(row => row.id)
    await page.goto(`/en/agreements/${owner.agreementId}`)
    await page.waitForURL(url => url.searchParams.get('section') === 'general')
    await page.getByRole('tab', { name: 'Payments', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Payments', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('button', { name: 'Add Payment', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Add Payment', exact: true })
    const choose = async (label: RegExp, option: string | RegExp) => {
      const control = dialog.getByRole('combobox', { name: label })
      await control.click()
      await page.getByRole('option', { name: option, exact: typeof option === 'string' }).first().click()
      if (await control.getAttribute('aria-expanded') === 'true') await page.keyboard.press('Escape')
      await expect(page.locator('[role="listbox"]')).toHaveCount(0)
    }
    await choose(/^Commitment type/, /Commitment/)
    await choose(/^Fiscal year/, String(fiscal.egcs_ay_fiscalyeardisplay))
    await choose(/^Payment type/, paymentType === 'advance' ? 'Advance' : 'Reimbursement')
    for (const [label, month] of [['Period start', 0], ['Period end', periodEnd]] as const) {
      await choose(new RegExp(`^${label}`), ['Apr', 'May', 'Jun'][month]!)
    }
    if (cents(release) > BigInt(0)) {
      await dialog.getByRole('checkbox').check()
      await dialog.getByRole('textbox', { name: /Holdback release amount/i }).fill(release)
    }
    const amount = dialog.getByRole('textbox', { name: /^Amount/ })
    const renderedAmount = async () => (await amount.inputValue()).replace(/[^\d.-]/g, '')
    await expect.poll(renderedAmount).toBe(expected)
    if (override !== undefined) await amount.fill(override)
    const requested = override ?? expected
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(dialog).toBeHidden()
    const created = (await read<{ payments: Id[] }>(page, `${agreementBase}/payments-overview`)).payments.find(row => !before.includes(row.id))!
    expect(created).toBeTruthy()
    const detail = await read<Row>(page, `${agreementBase}/payments/${created.id}`)
    expect(detail.egcs_fc_paymentamount).toBe(requested)
    await post(page, `${agreementBase}/payment-lines`, {
      egcs_fc_fundingagreementpayment: created.id, egcs_fc_fundingagreementcommitmentline: commitmentLine.id, egcs_fc_amount: requested
    })
    await complete('fundingcasepayment', created.id)
    const auditedScenario = scenarios.find(row => row.scenario_id === scenario)!
    auditedScenario.selected_payment = requested
    auditedScenario.created_payment_id = created.id
    paidAmount = sum([paidAmount, requested])
    addLedger('payment', created.id, periodEnd, requested, scenario)
    await persist()
    await page.goto(`/en/agreements/${owner.agreementId}/payments/${created.id}`)
    await expect(page.getByRole('tab', { name: 'Payment completion', exact: true })).toBeVisible()
    await expect(page.getByText(new RegExp(`\\$${requested.replace('.', '\\.')}\\b`)).first()).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`${scenario}.png`), fullPage: true })
  }
  const reconcile = async (month: number, submitted: string, reconciled: string) => {
    const claim = await post(page, `${agreementBase}/claims`, {
      egcs_fc_fiscalyear: fiscalYear.id, egcs_fc_isfinalforyear: month === 2,
      egcs_fc_periodstart: month, egcs_fc_periodend: month, egcs_fc_receiveddate: String(fiscal.egcs_ay_startdate).slice(0, 10)
    })
    const claimLine = await post(page, `${agreementBase}/claim-line-items`, {
      egcs_fc_fundingagreementclaim: claim.id, egcs_fc_fundingagreementbudgetlineitem: budgetLine.id,
      egcs_fc_description: `Claim period ${month}`, egcs_fc_amount: submitted, egcs_fc_totalamount: submitted, egcs_fc_currency: 'cad'
    })
    await complete('fundingcaseagreementclaim', claim.id)
    const reconciliation = await post(page, `${agreementBase}/claim-reconciles`, { egcs_fc_fundingagreementclaim: claim.id, egcs_fc_isfinal: true })
    await post(page, `${agreementBase}/claim-reconcile-line-items`, {
      egcs_fc_fundingagreementclaimreconcile: reconciliation.id, egcs_fc_lineitem: claimLine.id, egcs_fc_reconciled: reconciled
    })
    await complete('fundingclaimreconcile', reconciliation.id)
    claimsAmount = sum([claimsAmount, reconciled])
    submittedClaims = sum([submittedClaims, submitted])
    lastClaimMonth = month
    addLedger('submitted_claim', claim.id, month, submitted, 'Raw claim is deliberately higher than accepted costs.')
    addLedger('reconciliation', reconciliation.id, month, reconciled, 'Only approved reconciled amount enters payment calculation.')
    await persist()
  }
  try {
    await createPaymentUi('01_initial_advance', 'advance', 0)
    await reconcile(0, '110.00', '100.00')
    await check('02_advance_overpayment_blocks_reimbursement', 'reimbursement', 0)
    await createPaymentUi('03_advance_replaces_claimed_forecast', 'advance', 1)
    await reconcile(1, '510.03', '500.03')
    await createPaymentUi('04_claim_underpayment_reimbursement', 'reimbursement', 1)
    await reconcile(2, '400.02', '400.02')
    await check('05_full_holdback_limits_final_claim', 'reimbursement', 2)
    await createPaymentUi('06_unused_release_does_not_reduce_next_holdback', 'reimbursement', 2, '50.00', '300.02')
    await createPaymentUi('07_first_fifty_of_last_money', 'reimbursement', 2, '50.00')
    await check('08_full_holdback_capped_by_last_fifty', 'reimbursement', 2)
    await createPaymentUi('09_final_release_capped_by_balance', 'reimbursement', 2, '100.00')
    await check('10_fully_paid_no_further_payment', 'reimbursement', 2, '100.00')
    expect(paidAmount).toBe('1000.05')
    expect(claimsAmount).toBe('1000.05')
    await persist()
    await testInfo.attach('manual-calculation-scenarios', { path: join(testInfo.outputDir, 'automated-payment-scenarios.csv'), contentType: 'text/csv' })
    await testInfo.attach('source-financial-ledger', { path: join(testInfo.outputDir, 'automated-payment-ledger.csv'), contentType: 'text/csv' })
  } finally {
    await approver.close()
  }
}
