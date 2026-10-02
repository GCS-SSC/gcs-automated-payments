import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type Browser, type Page, type TestInfo } from '@playwright/test'
import { preparePaymentAuditFixture } from './payment-accuracy-journey'

type Row = { id: string } & Record<string, unknown>
type Owner = { agencyId: string; programId: string; streamId: string; agreementId: string }
type Helpers = {
  login: (page: Page, email: string, password: string) => Promise<void>
  approveAll: (page: Page, entityType: string, id: string) => Promise<void>
  complete: (page: Page, entityType: string, id: string, comments: string) => Promise<void>
}
const read = async <T = Row>(page: Page, path: string): Promise<T> => {
  const response = await page.request.get(path)
  expect(response.ok(), `${path}: ${response.status()} ${await response.text()}`).toBe(true)
  return await response.json() as T
}
const post = async <T = Row>(page: Page, path: string, data: Record<string, unknown>): Promise<T> => {
  const response = await page.request.post(path, { data })
  expect(response.ok(), `${path}: ${response.status()} ${await response.text()}`).toBe(true)
  return await response.json() as T
}
const csvCell = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`

/** A later live Agreement FY with no funding lines is the final-FY basis, even when earlier funding remains. */
export const runPaymentEmptyFinalFiscalYearJourney = async (page: Page, browser: Browser, testInfo: TestInfo, source: Owner, helpers: Helpers) => {
  const fixture = await preparePaymentAuditFixture(page, source)
  const { owner, agreementBase, fiscalYear, fiscal, budgetLine, linkedChart, authoredFinalBasis, streamBase } = fixture
  const fiscalNumber = Math.max(...fixture.sourceRows.fiscalYears.map(row => Number(row.egcs_ay_fiscalyear))) + 1
  const finalAgencyFiscalYear = await post(page, `/api/agency/${owner.agencyId}/fiscal-years`, {
    egcs_ay_fiscalyear: fiscalNumber, egcs_ay_fiscalyeardisplay: `${fiscalNumber}-${fiscalNumber + 1}`,
    egcs_ay_startdate: `${fiscalNumber}-04-01`, egcs_ay_enddate: `${fiscalNumber + 1}-03-31`, egcs_ay_jvopen: false
  })
  const finalProgramBudget = await post(page, `/api/transfer-payments/${owner.programId}/budgets`, {
    egcs_tp_fiscalyear: finalAgencyFiscalYear.id, egcs_tp_currency: 'cad', egcs_tp_totalbudget: '0.00', egcs_tp_overcommitthreshold: 0
  })
  const finalStreamBudget = await post(page, `${streamBase}/budgets`, {
    egcs_tp_transferpaymentbudget: finalProgramBudget.id, egcs_tp_totalbudget: '0.00', egcs_tp_overcommitthreshold: 0
  })
  const update = await page.request.patch(agreementBase, { data: {
    egcs_fc_holdbackbasis: authoredFinalBasis.id,
    egcs_fc_authorizedassistanceenddate: String(finalAgencyFiscalYear.egcs_ay_enddate).slice(0, 10)
  } })
  expect(update.ok(), await update.text()).toBe(true)
  const finalAgreementFiscalYear = await post(page, `${agreementBase}/budget-fiscal-years`, { egcs_fc_fiscalyear: finalAgencyFiscalYear.id })
  const beforeBudget = await read<Row & { fiscalYears: Row[]; lineItems: Row[] }>(page, `${agreementBase}/budget-overview`)
  expect(beforeBudget.fiscalYears).toHaveLength(2)
  expect(beforeBudget.lineItems).toHaveLength(1)
  expect(beforeBudget.lineItems[0]!.egcs_fc_fundingagreementbudgetfiscalyear).toBe(fiscalYear.id)
  const types = await read<{ items: Row[] }>(page, `${agreementBase}/commitments/lookups/types?limit=100`)
  const commitment = await post(page, `${agreementBase}/commitments`, { egcs_fc_type: types.items[0]!.id, egcs_fc_currency: 'cad' })
  const line = await post(page, `${agreementBase}/commitment-lines`, {
    egcs_fc_commitment: commitment.id, egcs_fc_commitmentlinenumber: 1,
    egcs_fc_transferpaymentstreamchartofaccount: linkedChart.id, egcs_fc_amount: '1000.05'
  })
  const approver = await browser.newPage()
  await helpers.login(approver, 'user11@example.com', 'password123')
  const complete = async (entityType: string, id: string) => {
    await helpers.complete(page, entityType, id, 'Empty final fiscal year has zero native funding; independent H=0 verified.')
    await helpers.approveAll(approver, entityType, id)
  }
  try {
    await complete('fundingcaseagreementcommitment', commitment.id)
    const forecast = await post(page, `${agreementBase}/forecasts`, { egcs_fc_fiscalyear: fiscalYear.id })
    const forecastLine = await post(page, `${agreementBase}/forecast-line-items`, {
      egcs_fc_agreementforecast: forecast.id, egcs_fc_fundingagreementbudgetlineitem: budgetLine.id,
      egcs_fc_month: 0, egcs_fc_amount: '1000.05', egcs_fc_totalamount: '1000.05', egcs_fc_currency: 'cad', egcs_fc_version: 0
    })
    await complete('fundingcaseforecast', forecast.id)
    const enabled = await page.request.patch(`/api/extensions/streams/${owner.streamId}`, { data: {
      extensionKey: 'gcs-automated-payments', enabled: true, config: { enabledPaymentTypes: ['advance', 'reimbursement'] }
    } })
    expect(enabled.ok(), await enabled.text()).toBe(true)
    const calculation = await post<Row & { details: Array<{ label: string; value: string }> }>(page,
      `/api/extensions/gcs-automated-payments/agreements/${owner.agreementId}/calculate-payment`, {
        egcs_fc_commitmenttype: commitment.egcs_fc_type, egcs_fc_fiscalyear: fiscalYear.id, egcs_fc_currency: 'cad',
        egcs_fc_paymenttype: 'advance', egcs_fc_periodstart: 0, egcs_fc_periodend: 0
      })
    const details = Object.fromEntries(calculation.details.map(item => [item.label, item.value]))
    // Literal independent oracle: floor(10% * 0 final-year funding)=0; all1000.05 remains payable.
    expect(calculation.holdbackAmount).toBe('0.00')
    expect(calculation.holdbackReleaseAmount).toBe('0.00')
    expect(calculation.baseAmount).toBe('1000.05')
    expect(calculation.availableBeforeHoldback).toBe('1000.05')
    expect(calculation.suggestedAmount).toBe('1000.05')
    expect(calculation.ceilingAmount).toBe('1000.05')
    expect(details.totalPaymentsToDate).toBe('0.00')
    expect(details.commitmentRemaining).toBe('1000.05')
    await page.goto(`/en/agreements/${owner.agreementId}`)
    await page.waitForURL(url => url.searchParams.get('section') === 'general')
    await page.getByRole('tab', { name: 'Payments', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Payments', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('button', { name: 'Add Payment', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Add Payment', exact: true })
    const choose = async (label: RegExp, value: string | RegExp) => {
      const control = dialog.getByRole('combobox', { name: label })
      await control.click()
      await page.getByRole('option', { name: value, exact: typeof value === 'string' }).first().click()
      if (await control.getAttribute('aria-expanded') === 'true') await page.keyboard.press('Escape')
      await expect(page.locator('[role="listbox"]')).toHaveCount(0)
    }
    await expect(dialog.getByRole('combobox', { name: /^Currency/ })).toBeDisabled()
    await choose(/^Commitment type/, /Commitment/)
    await choose(/^Fiscal year/, String(fiscal.egcs_ay_fiscalyeardisplay))
    await choose(/^Payment type/, 'Advance')
    await choose(/^Period start/, 'Apr')
    await choose(/^Period end/, 'Apr')
    await expect.poll(async () => (await dialog.getByRole('textbox', { name: /^Amount/ }).inputValue()).replace(/[^\d.-]/g, '')).toBe('1000.05')
    await page.screenshot({ path: testInfo.outputPath('empty-final-fy-calculator-H0.png'), fullPage: true })
    const paymentResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`${agreementBase}/payments`))
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
    const payment = await (await paymentResponse).json() as Row
    expect(payment.egcs_fc_currency).toBe('cad')
    expect(payment.egcs_fc_paymentamount).toBe('1000.05')
    await post(page, `${agreementBase}/payment-lines`, { egcs_fc_fundingagreementpayment: payment.id,
      egcs_fc_fundingagreementcommitmentline: line.id, egcs_fc_amount: '1000.05' })
    await complete('fundingcasepayment', payment.id)
    const persistedPayment = await read<Row & { lines: Row[] }>(page, `${agreementBase}/payments/${payment.id}`)
    expect(persistedPayment.isCompleted).toBe(true)
    expect(persistedPayment.egcs_fc_paymentamount).toBe('1000.05')
    expect(persistedPayment.lines.map(item => item.egcs_fc_amount)).toEqual(['1000.05'])
    const row = {
      scenario_id: 'empty-final-FY-zero-funded-H0-full-advance', agreement_id: owner.agreementId, currency: 'cad',
      current_agency_fiscal_year_id: fiscal.id, current_agreement_fiscal_year_id: fiscalYear.id, current_fiscal_year: fiscal.egcs_ay_fiscalyeardisplay,
      final_agency_fiscal_year_id: finalAgencyFiscalYear.id, final_agreement_fiscal_year_id: finalAgreementFiscalYear.id,
      final_fiscal_year: finalAgencyFiscalYear.egcs_ay_fiscalyeardisplay,
      current_program_fy_budget_id: fixture.updatedProgramBudget.id, current_program_fy_budget: fixture.updatedProgramBudget.egcs_tp_totalbudget,
      current_stream_fy_budget_id: fixture.authoredStreamBudget.id, current_stream_fy_budget: fixture.authoredStreamBudget.egcs_tp_totalbudget,
      final_program_fy_budget_id: finalProgramBudget.id, final_program_fy_budget: '0.00',
      final_stream_fy_budget_id: finalStreamBudget.id, final_stream_fy_budget: '0.00',
      current_agreement_funding: '1000.05', final_agreement_funding: '0.00', final_budget_lines_count: 0,
      commitment_id: commitment.id, commitment_line_id: line.id, current_commitment: '1000.05', final_commitment: '0.00',
      forecast_id: forecast.id, forecast_line_id: forecastLine.id, forecast_current_fy: '1000.05', forecast_final_fy: '0.00',
      claims: '0.00', reconciliations: '0.00', jvs: '0.00', corrections: '0.00', recorded_paid_before: '0.00',
      payment_type: 'advance', period_start: 0, period_end: 0, holdback_basis: 'finalfiscal', holdback_percent: '10', requested_release: '0.00',
      expected_holdback: '0.00', actual_holdback: calculation.holdbackAmount,
      expected_base: '1000.05', actual_base: calculation.baseAmount,
      expected_capacity: '1000.05', actual_capacity: details.commitmentRemaining,
      expected_ordinary_available: '1000.05', actual_ordinary_available: calculation.availableBeforeHoldback,
      expected_payment: '1000.05', actual_payment: calculation.suggestedAmount,
      selected_payment: persistedPayment.egcs_fc_paymentamount, created_payment_id: payment.id,
      expected_cash_paid_after: '1000.05', actual_cash_paid_after: persistedPayment.egcs_fc_paymentamount, result: 'PASS'
    }
    const raw = { row, profile: await read(page, agreementBase), calculation, beforeBudget,
      finalAgencyFiscalYear, finalProgramBudget, finalStreamBudget, finalAgreementFiscalYear,
      commitment: await read(page, `${agreementBase}/commitments/${commitment.id}`),
      forecast: await read(page, `${agreementBase}/forecasts-overview`), persistedPayment }
    const header = Object.keys(row)
    for (const directory of [testInfo.outputDir, process.env.GCS_PAYMENT_AUDIT_DIR].filter((value): value is string => Boolean(value))) {
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'automated-payment-empty-final-fy-scenarios.csv'), [header.map(csvCell).join(','), header.map(key => csvCell(row[key as keyof typeof row])).join(',')].join('\n') + '\n')
      await writeFile(join(directory, 'automated-payment-empty-final-fy-raw.json'), JSON.stringify(raw, null, 2))
    }
    await page.goto(`/en/agreements/${owner.agreementId}/payments/${payment.id}`)
    await expect(page.getByRole('tab', { name: 'Payment completion', exact: true })).toBeVisible()
    await expect(page.getByText('Loading records', { exact: true })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('empty-final-fy-paid-full-1000.05.png'), fullPage: true })
  } finally {
    await approver.close()
  }
}
