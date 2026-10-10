import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type Browser, type Page, type TestInfo } from '@playwright/test'
import { preparePaymentAuditFixture, resolvePaymentAuditPayee, selectPaymentAuditPayee } from './payment-accuracy-journey'
import { createNativeAgreementThroughUi } from './agreement-native-create'

type Currency = 'cad' | 'usd'
type Row = { id: string } & Record<string, unknown>
type Owner = { agencyId: string; programId: string; streamId: string; agreementId: string }
type Helpers = {
  login: (page: Page, email: string, password: string) => Promise<void>
  approveAll: (page: Page, entityType: string, id: string) => Promise<void>
  complete: (page: Page, entityType: string, id: string, comments: string) => Promise<void>
}
type Calculation = {
  currency: string; suggestedAmount: string; ceilingAmount: string; baseAmount: string
  holdbackAmount: string; holdbackReleaseAmount: string; availableBeforeHoldback: string
  details: Array<{ label: string; value: string }>
}

// Independent exact-cent oracle; no production financial arithmetic is imported.
const cents = (value: string) => {
  expect(value, 'Exact native money text').toMatch(/^-?\d+\.\d{2}$/)
  return BigInt(value.replace('.', ''))
}
const amount = (value: bigint): string => {
  const absolute = value < BigInt(0) ? -value : value
  return `${value < BigInt(0) ? '-' : ''}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, '0')}`
}
const sum = (values: string[]) => amount(values.reduce((total, value) => total + cents(value), BigInt(0)))
const min = (...values: bigint[]) => values.reduce((a, b) => a < b ? a : b)
const positive = (value: bigint) => value > BigInt(0) ? value : BigInt(0)
const csvCell = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`

const read = async <T = Row>(page: Page, path: string): Promise<T> => {
  const response = await page.request.get(path, { maxRetries: 2 })
  expect(response.ok(), `${path}: ${response.status()} ${await response.text()}`).toBe(true)
  return await response.json() as T
}
const post = async <T = Row>(page: Page, path: string, data: Record<string, unknown>): Promise<T> => {
  const response = await page.request.post(path, { data })
  expect(response.ok(), `${path}: ${response.status()} ${await response.text()}`).toBe(true)
  return await response.json() as T
}

const verifyFundingCurrencyControls = async (page: Page, testInfo: TestInfo, owner: Owner) => {
  const evidence: Array<Record<string, unknown>> = []
  for (const locale of ['en', 'fr'] as const) {
    const required = locale === 'en' ? 'required' : 'obligatoire'
    const label = locale === 'en' ? 'Currency' : 'Devise'
    const add = locale === 'en' ? 'Add' : 'Ajouter'
    const cancel = locale === 'en' ? 'Cancel' : 'Annuler'
    const usdName = new Intl.DisplayNames([locale], { type: 'currency' }).of('USD')!
    await page.goto(`/${locale}/${locale === 'en' ? 'agreements/new' : 'ententes/nouveau'}`)
    const agreementControl = page.getByRole('combobox', { name: new RegExp(`^${label}`) })
    await expect(agreementControl).toHaveAttribute('aria-required', 'true')
    await expect(page.getByText(new RegExp(`${label}\\s*\\(${required}\\)`))).toBeVisible()
    await expect(agreementControl).toBeEnabled()
    await expect(agreementControl).not.toHaveText(usdName)
    await expect(agreementControl).not.toHaveText(new Intl.DisplayNames([locale], { type: 'currency' }).of('CAD')!)
    await agreementControl.focus()
    await agreementControl.press('Enter')
    await page.getByRole('option', { name: usdName, exact: true }).press('Enter')
    await expect(page.locator('[role="listbox"]')).toHaveCount(0)
    await expect(agreementControl).toHaveText(usdName)
    evidence.push({ kind: 'agreement-create', locale, label, visible_required_indicator: required,
      aria_required: await agreementControl.getAttribute('aria-required'), initial_currency_blank: true,
      selected_currency: 'usd', selected_accessible_display: usdName, keyboard_selection: true, result: 'PASS' })
    await page.screenshot({ path: testInfo.outputPath(`currency-required-agreement-create-${locale}.png`), fullPage: true })
    for (const kind of ['chart', 'program-budget'] as const) {
      const path = kind === 'chart'
        ? `/${locale}/${locale === 'en' ? 'agencies' : 'agences'}/${owner.agencyId}`
        : `/${locale}/${locale === 'en' ? 'transfer-payments' : 'paiements-de-transfert'}/${owner.programId}`
      const tabName = kind === 'chart' ? (locale === 'en' ? 'Charts of Accounts' : 'Plans comptables') : 'Budgets'
      await page.goto(path)
      await page.waitForURL(url => url.searchParams.get('section') === 'general')
      await page.getByRole('tab', { name: tabName, exact: true }).click()
      await expect(page.getByRole('tab', { name: tabName, exact: true })).toHaveAttribute('aria-selected', 'true')
      await page.getByRole('button', { name: add, exact: true }).click()
      const dialog = page.getByRole('dialog')
      const control = dialog.getByRole('combobox', { name: new RegExp(`^${label}`) })
      await expect(control).toHaveAttribute('aria-required', 'true')
      await expect(dialog.getByText(new RegExp(`${label}\\s*\\(${required}\\)`))).toBeVisible()
      await control.focus()
      await control.press('Enter')
      await page.getByRole('option', { name: usdName, exact: true }).press('Enter')
      await expect(page.locator('[role="listbox"]')).toHaveCount(0)
      await expect(control).toHaveText(usdName)
      evidence.push({ kind, locale, label, visible_required_indicator: required, aria_required: await control.getAttribute('aria-required'),
        selected_currency: 'usd', selected_accessible_display: usdName, keyboard_selection: true, result: 'PASS' })
      await page.screenshot({ path: testInfo.outputPath(`currency-required-${kind}-${locale}.png`), fullPage: true })
      await dialog.getByRole('button', { name: cancel, exact: true }).click()
      await expect(dialog).toBeHidden()
    }
  }
  for (const directory of [testInfo.outputDir, process.env.GCS_PAYMENT_AUDIT_DIR].filter((value): value is string => Boolean(value))) {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'native-currency-required-controls.json'), JSON.stringify(evidence, null, 2))
  }
}

export const runPaymentCurrencyJourney = async (page: Page, browser: Browser, testInfo: TestInfo, source: Owner, helpers: Helpers) => {
  const fixture = await preparePaymentAuditFixture(page, source)
  const { owner, agreementBase, streamBase, fiscal, fiscalYear, budgetLine, category, linkedChart, authoredStreamBudget, updatedProgramBudget } = fixture
  const usdProgramBudget = await post(page, `/api/transfer-payments/${owner.programId}/budgets`, {
    egcs_tp_fiscalyear: fiscal.id, egcs_tp_currency: 'usd', egcs_tp_totalbudget: '1000.07', egcs_tp_overcommitthreshold: 0
  })
  const usdStreamBudget = await post(page, `${streamBase}/budgets`, {
    egcs_tp_transferpaymentbudget: usdProgramBudget.id, egcs_tp_totalbudget: '1000.07', egcs_tp_overcommitthreshold: 0
  })
  const usdChart = await post(page, `/api/agency/${owner.agencyId}/chart-of-accounts`, {
    egcs_ay_fiscalyear: fiscal.id, egcs_ay_currency: 'usd',
    egcs_ay_accountingdimensions: [{ label_en: 'Account', label_fr: 'Compte', value: `Native-USD-${owner.agreementId}` }]
  })
  const usdLinkedChart = await post(page, `${streamBase}/chart-of-accounts`, { egcs_tp_agencychartofaccount: usdChart.id })
  const usdCreation = await createNativeAgreementThroughUi(page, testInfo, owner.programId, {
    ...fixture.agreementInput, egcs_fc_currency: 'usd',
    egcs_fc_agreementnumber: `USD-${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`,
    egcs_fc_financialsystemnumber: fixture.agreementInput.egcs_fc_financialsystemnumber + 1,
    egcs_fc_title_en: `USD ${fixture.agreementInput.egcs_fc_title_en}`,
    egcs_fc_title_fr: `USD ${fixture.agreementInput.egcs_fc_title_fr}`
  })
  const usdAgreement = usdCreation.created
  const usdBase = `/api/agreements/${usdAgreement.id}`
  const usdFiscalYear = await post(page, `${usdBase}/budget-fiscal-years`, { egcs_fc_fiscalyear: fiscal.id })
  const owners: Record<Currency, Owner> = { cad: owner, usd: { ...owner, agreementId: usdAgreement.id } }
  const payees = { cad: fixture.payee, usd: await resolvePaymentAuditPayee(page, usdAgreement.id, fixture.payee.id) }
  const bases: Record<Currency, string> = { cad: agreementBase, usd: usdBase }
  const years: Record<Currency, Row> = { cad: fiscalYear, usd: usdFiscalYear }
  const usdBudgetLine = await post(page, `${usdBase}/budget-line-items`, {
    egcs_fc_fundingagreementbudgetfiscalyear: usdFiscalYear.id, egcs_fc_organizationcostcategory: category.id,
    egcs_fc_costsubsection: 'Native USD payment audit', egcs_fc_description: 'Separate native currency limits',
    egcs_fc_totalamount: '600.07', egcs_fc_programfunding: '600.07', egcs_fc_fundingsources: [], egcs_fc_currency: 'usd'
  })
  const approver = await browser.newPage()
  await helpers.login(approver, 'user03@example.com', 'password123')
  const complete = async (entityType: string, id: string) => {
    await helpers.complete(page, entityType, id, 'Native currency financial evidence independently checked.')
    await helpers.approveAll(approver, entityType, id)
  }
  const budgets: Record<Currency, string> = { cad: '1000.05', usd: '600.07' }
  const holdbacks: Record<Currency, string> = { cad: '100.00', usd: '60.00' }
  const currencyLabel = (currency: Currency) => new Intl.DisplayNames(['en'], { type: 'currency' }).of(currency.toUpperCase())!
  const forecasts: Record<Currency, string[]> = { cad: ['300.01', '300.02', '400.02'], usd: ['200.02', '300.03', '100.02'] }
  const paid: Record<Currency, string> = { cad: '0.00', usd: '0.00' }
  const claims: Record<Currency, string> = { cad: '0.00', usd: '0.00' }
  const submitted: Record<Currency, string> = { cad: '0.00', usd: '0.00' }
  const lastClaim: Record<Currency, number> = { cad: -1, usd: -1 }
  const commitmentLines: Partial<Record<Currency, string>> = {}
  const commitmentIds: Partial<Record<Currency, string>> = {}
  const ledger: Array<Record<string, unknown>> = []
  const scenarios: Array<Record<string, unknown>> = []
  const raw: Array<Record<string, unknown>> = [{ boundary: 'agreement-profile-created-through-ui', currency: 'usd', ...usdCreation }]
  const record = (currency: Currency, kind: string, id: string, month: number | string, value: string) => ledger.push({
    agreement_id: owners[currency].agreementId, fiscal_year_id: years[currency].id, fiscal_year: fiscal.egcs_ay_fiscalyeardisplay,
    currency, kind, entity_id: id, month, amount: value
  })
  const persist = async () => {
    const header = Object.keys(scenarios[0] ?? {})
    const ledgerHeader = ['agreement_id', 'fiscal_year_id', 'fiscal_year', 'currency', 'kind', 'entity_id', 'month', 'amount']
    const csv = [header.map(csvCell).join(','), ...scenarios.map(row => header.map(key => csvCell(row[key])).join(','))].join('\n') + '\n'
    const ledgerCsv = [ledgerHeader.map(csvCell).join(','), ...ledger.map(row => ledgerHeader.map(key => csvCell(row[key])).join(','))].join('\n') + '\n'
    for (const directory of [testInfo.outputDir, process.env.GCS_PAYMENT_AUDIT_DIR].filter((value): value is string => Boolean(value))) {
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'automated-payment-currency-scenarios.csv'), csv)
      await writeFile(join(directory, 'automated-payment-currency-ledger.csv'), ledgerCsv)
      await writeFile(join(directory, 'automated-payment-currency-raw.json'), JSON.stringify(raw, null, 2))
    }
  }
  const tab = async (name: 'Commitments' | 'Payments', currency: Currency) => {
    await page.goto(`/en/agreements/${owners[currency].agreementId}`)
    await page.waitForURL(url => url.searchParams.get('section') === 'general')
    await page.getByRole('tab', { name, exact: true }).click()
    await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true')
  }
  const choose = async (dialog: ReturnType<Page['getByRole']>, label: RegExp, value: string | RegExp) => {
    const control = dialog.getByRole('combobox', { name: label })
    await control.click()
    await page.getByRole('option', { name: value, exact: typeof value === 'string' }).first().click()
    if (await control.getAttribute('aria-expanded') === 'true') await page.keyboard.press('Escape')
    await expect(page.locator('[role="listbox"]')).toHaveCount(0)
  }
  const reject = async (currency: Currency, boundary: string, path: string, data: Record<string, unknown>, method: 'post' | 'patch' = 'post') => {
    const response = await page.request[method](path, { data })
    const error = await response.json()
    expect(response.status(), `${boundary}: ${JSON.stringify(error)}`).toBe(400)
    const code = boundary === 'agreement-currency-immutable' ? 'AGREEMENT_CURRENCY_IMMUTABLE'
      : boundary === 'calculator-agreement-currency-mismatch' ? 'GCS_AUTOMATED_PAYMENTS_CURRENCY_MISMATCH'
        : 'AGREEMENT_CURRENCY_MISMATCH'
    expect(error.data.code, `${boundary}: rejected for its owning currency`).toBe(code)
    raw.push({ boundary, agreement_id: owners[currency].agreementId, agreement_currency: currency,
      submitted: data, rejected_status: response.status(), error })
    await persist()
  }
  let commitmentType = ''
  try {
    for (const currency of ['cad', 'usd'] as const) {
      const opposite: Currency = currency === 'cad' ? 'usd' : 'cad'
      await reject(currency, 'agreement-currency-immutable', bases[currency], { egcs_fc_currency: opposite }, 'patch')
      expect((await read(page, bases[currency])).egcs_fc_currency).toBe(currency)
      await reject(currency, 'agreement-budget-currency-mismatch', `${bases[currency]}/budget-line-items`, {
        egcs_fc_fundingagreementbudgetfiscalyear: years[currency].id, egcs_fc_organizationcostcategory: category.id,
        egcs_fc_costsubsection: 'Must reject mixed currency', egcs_fc_description: 'Wrong native denomination',
        egcs_fc_totalamount: '0.01', egcs_fc_programfunding: '0.01', egcs_fc_fundingsources: [], egcs_fc_currency: opposite
      })
      record(currency, 'budget', currency === 'cad' ? budgetLine.id : usdBudgetLine.id, '', budgets[currency])
      const agreementBase = bases[currency]
      await tab('Commitments', currency)
      await page.getByRole('button', { name: 'Add Commitment', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Add Commitment', exact: true })
      await expect(dialog.getByRole('combobox', { name: /^Currency/ })).toBeDisabled()
      await expect(dialog.getByRole('combobox', { name: /^Currency/ })).toHaveText(currencyLabel(currency))
      await choose(dialog, /^Commitment type/, /Commitment/)
      const commitmentAmount = dialog.getByRole('textbox', { name: /^Total amount/ })
      await commitmentAmount.click()
      await expect(commitmentAmount).toBeFocused()
      await expect(commitmentAmount).toHaveValue('')
      await commitmentAmount.fill(budgets[currency])
      await expect(commitmentAmount).toHaveValue(budgets[currency])
      await commitmentAmount.press('Tab')
      const response = page.waitForResponse(candidate => candidate.request().method() === 'POST' && candidate.url().endsWith(`${agreementBase}/commitments`))
      await dialog.getByRole('button', { name: 'Add', exact: true }).click()
      const created = await (await response).json() as Row
      expect(created.egcs_fc_currency).toBe(currency)
      commitmentIds[currency] = created.id
      commitmentType = String(created.egcs_fc_type)
      await reject(currency, 'agreement-commitment-currency-mismatch', `${agreementBase}/commitments`, {
        egcs_fc_type: created.egcs_fc_type, egcs_fc_currency: opposite, egcs_fc_totalamount: budgets[currency]
      })
      const persistedCommitment = await read<Row>(page, `${agreementBase}/commitments/${created.id}`)
      expect(persistedCommitment.egcs_fc_currency, 'Persisted native Commitment detail currency').toBe(currency)
      await page.goto(`/en/agreements/${owners[currency].agreementId}/commitments/${created.id}`)
      await page.getByRole('button', { name: 'Add Commitment Line', exact: true }).click()
      const lineDialog = page.getByRole('dialog', { name: 'Add Commitment Line', exact: true })
      await lineDialog.getByRole('spinbutton', { name: /^Line number/ }).fill('1')
      const codingResponse = await read<{ items: Row[] }>(page, `${agreementBase}/commitment-lines/lookups/chart-of-accounts?permission_action=update&commitmentId=${created.id}&currency=${currency}&limit=100`)
      expect(codingResponse.items.map(row => row.id)).toEqual([currency === 'cad' ? linkedChart.id : usdLinkedChart.id])
      await choose(lineDialog, /^Stream commitment/, new RegExp(String(codingResponse.items[0]!.label_en).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      const lineAmount = lineDialog.getByRole('textbox', { name: /^Amount/ })
      await lineAmount.click()
      await expect(lineAmount).toBeFocused()
      await expect(lineAmount).toHaveValue('')
      await lineAmount.fill(budgets[currency])
      await expect(lineAmount).toHaveValue(budgets[currency])
      await lineAmount.press('Tab')
      await lineDialog.getByRole('button', { name: 'Add', exact: true }).click()
      await expect(lineDialog).toBeHidden()
      const detail = await read<Row & { lines: Row[] }>(page, `${agreementBase}/commitments/${created.id}`)
      commitmentLines[currency] = detail.lines[0]!.id
      const wrongCoding = await page.request.post(`${agreementBase}/commitment-lines`, { data: {
        egcs_fc_commitment: created.id, egcs_fc_commitmentlinenumber: 2,
        egcs_fc_transferpaymentstreamchartofaccount: currency === 'cad' ? usdLinkedChart.id : linkedChart.id,
        egcs_fc_amount: '0.01'
      } })
      expect(wrongCoding.status()).toBe(400)
      expect((await wrongCoding.json()).data.code).toBe('INVALID_AGREEMENT_CHART_OF_ACCOUNT')
      const overNativeLimit = await page.request.post(`${agreementBase}/commitment-lines`, { data: {
        egcs_fc_commitment: created.id, egcs_fc_commitmentlinenumber: 2,
        egcs_fc_transferpaymentstreamchartofaccount: currency === 'cad' ? linkedChart.id : usdLinkedChart.id,
        egcs_fc_amount: '0.01'
      } })
      expect(overNativeLimit.status()).toBe(400)
      expect((await overNativeLimit.json()).data.code).toBe('AGREEMENT_COMMITMENT_EXCEEDS_TOTAL')
      expect((await read<Row & { lines: Row[] }>(page, `${agreementBase}/commitments/${created.id}`)).lines).toHaveLength(1)
      // The header checks native Program funding without the earlier declared-total line guard.
      const beforeFundingProbe = await read(page, `${agreementBase}/commitments-overview`)
      const overNativeFunding = await page.request.post(`${agreementBase}/commitments`, { data: {
        egcs_fc_type: created.egcs_fc_type, egcs_fc_currency: currency,
        egcs_fc_totalamount: amount(cents(budgets[currency]) + BigInt(1))
      } })
      expect(overNativeFunding.status()).toBe(400)
      expect((await overNativeFunding.json()).data.code).toBe('AGREEMENT_COMMITMENT_EXCEEDS_PROGRAM_FUNDING')
      expect(await read(page, `${agreementBase}/commitments-overview`)).toEqual(beforeFundingProbe)
      raw.push({ boundary: 'commitment-native-currency-and-limit', currency, commitment: detail,
        wrong_chart_id: currency === 'cad' ? usdLinkedChart.id : linkedChart.id,
        rejected_wrong_chart_status: wrongCoding.status(), rejected_over_limit_status: overNativeLimit.status(),
        rejected_over_native_funding_status: overNativeFunding.status(),
        native_maximum: budgets[currency], rejected_extra_amount: '0.01' })
      record(currency, 'commitment', detail.lines[0]!.id, '', budgets[currency])
      await complete('fundingcaseagreementcommitment', created.id)
    }
    for (const currency of ['cad', 'usd'] as const) {
      const agreementBase = bases[currency]
      const forecast = await post(page, `${agreementBase}/forecasts`, { egcs_fc_fiscalyear: years[currency].id })
      await reject(currency, 'agreement-forecast-currency-mismatch', `${agreementBase}/forecast-line-items`, {
        egcs_fc_agreementforecast: forecast.id, egcs_fc_fundingagreementbudgetlineitem: currency === 'cad' ? budgetLine.id : usdBudgetLine.id,
        egcs_fc_month: 3, egcs_fc_amount: '0.01', egcs_fc_totalamount: '0.01',
        egcs_fc_currency: currency === 'cad' ? 'usd' : 'cad', egcs_fc_version: 0
      })
      for (const [month, value] of forecasts[currency].entries()) {
        const line = await post(page, `${agreementBase}/forecast-line-items`, {
          egcs_fc_agreementforecast: forecast.id, egcs_fc_fundingagreementbudgetlineitem: currency === 'cad' ? budgetLine.id : usdBudgetLine.id,
          egcs_fc_month: month, egcs_fc_amount: value, egcs_fc_totalamount: value, egcs_fc_currency: currency, egcs_fc_version: 0
        })
        record(currency, 'forecast', line.id, month, value)
      }
      await complete('fundingcaseforecast', forecast.id)
    }
    const enabled = await page.request.patch(`/api/extensions/streams/${owner.streamId}`, { data: {
      extensionKey: 'gcs-automated-payments', enabled: true, config: { enabledPaymentTypes: ['advance', 'reimbursement'] }
    } })
    expect(enabled.ok(), await enabled.text()).toBe(true)

    const check = async (scenario: string, currency: Currency, paymentType: 'advance' | 'reimbursement', periodEnd: number, release = '0.00') => {
      const forecastToClaim = sum(forecasts[currency].slice(0, lastClaim[currency] + 1))
      const forecastToPeriod = sum(forecasts[currency].slice(0, periodEnd + 1))
      const unclaimed = sum(forecasts[currency].slice(lastClaim[currency] + 1))
      const baseSigned = cents(claims[currency]) - cents(paid[currency]) + (paymentType === 'advance' ? cents(forecastToPeriod) - cents(forecastToClaim) : BigInt(0))
      const base = positive(baseSigned)
      const eligible = positive(cents(claims[currency]) + cents(unclaimed) - cents(paid[currency]))
      const reserve = min(cents(holdbacks[currency]), eligible)
      const ordinary = eligible - reserve
      const released = min(cents(release), reserve)
      const capacity = positive(cents(budgets[currency]) - cents(paid[currency]))
      const expected = amount(min(base, capacity, ordinary + released))
      const agreementBase = bases[currency]
      const body = { egcs_fc_commitmenttype: commitmentType, egcs_fc_fiscalyear: years[currency].id, egcs_fc_currency: currency,
        egcs_fc_paymenttype: paymentType, egcs_fc_periodstart: 0, egcs_fc_periodend: periodEnd,
        extensions: { 'gcs-automated-payments': { releaseHoldback: cents(release) > BigInt(0), holdbackReleaseAmount: release } } }
      const actual = await post<Calculation>(page, `/api/extensions/gcs-automated-payments/agreements/${owners[currency].agreementId}/calculate-payment`, body)
      const details = Object.fromEntries(actual.details.map(detail => [detail.label, detail.value]))
      expect(actual.currency.toLowerCase()).toBe(currency)
      expect(details.totalClaimsToLastClaimMonth).toBe(claims[currency])
      expect(details.totalForecastToLastClaimMonth).toBe(forecastToClaim)
      expect(details.totalForecastToPeriodEnd).toBe(forecastToPeriod)
      expect(details.totalPaymentsToDate).toBe(paid[currency])
      expect(details.commitmentRemaining).toBe(amount(capacity))
      expect(actual.holdbackAmount).toBe(holdbacks[currency])
      expect(actual.availableBeforeHoldback).toBe(amount(ordinary))
      expect(actual.holdbackReleaseAmount).toBe(amount(released))
      expect(actual.baseAmount).toBe(amount(base))
      expect(actual.ceilingAmount).toBe(expected)
      expect(actual.suggestedAmount).toBe(expected)
      scenarios.push({ scenario_id: scenario, agreement_id: owners[currency].agreementId, fiscal_year_id: years[currency].id, fiscal_year: fiscal.egcs_ay_fiscalyeardisplay,
        currency, agreement_currency: currency, paired_agreements_by_currency: JSON.stringify(Object.fromEntries(Object.entries(owners).map(([code, value]) => [code, value.agreementId]))), payment_type: paymentType, period_end: periodEnd, native_budget: budgets[currency], native_commitment: budgets[currency],
        program_fy_budget_id: currency === 'cad' ? updatedProgramBudget.id : usdProgramBudget.id,
        program_fy_budget: currency === 'cad' ? updatedProgramBudget.egcs_tp_totalbudget : usdProgramBudget.egcs_tp_totalbudget,
        stream_fy_budget_id: currency === 'cad' ? authoredStreamBudget.id : usdStreamBudget.id,
        stream_fy_budget: currency === 'cad' ? authoredStreamBudget.egcs_tp_totalbudget : usdStreamBudget.egcs_tp_totalbudget,
        stream_overcommit_ratio: currency === 'cad' ? authoredStreamBudget.egcs_tp_overcommitthreshold : usdStreamBudget.egcs_tp_overcommitthreshold,
        commitment_id: commitmentIds[currency], commitment_line_id: commitmentLines[currency], budgets_by_currency: JSON.stringify(budgets),
        forecasts_by_currency: JSON.stringify(forecasts), forecast_to_last_claim: forecastToClaim, forecast_to_period: forecastToPeriod, forecast_unclaimed: unclaimed,
        submitted_claims: submitted[currency], reconciled_claims: claims[currency], claims_by_currency: JSON.stringify(claims),
        cash_paid_by_currency: JSON.stringify(paid), cash_paid: paid[currency], jv_effect: '0.00', corrections: '0.00', expected_recorded_paid: paid[currency], actual_recorded_paid: details.totalPaymentsToDate,
        expected_capacity: amount(capacity), actual_capacity: details.commitmentRemaining, expected_base: amount(base), actual_base: actual.baseAmount,
        expected_holdback: holdbacks[currency], actual_holdback: actual.holdbackAmount, expected_ordinary_available: amount(ordinary), actual_ordinary_available: actual.availableBeforeHoldback,
        requested_release: release, expected_release: amount(released), actual_release: actual.holdbackReleaseAmount,
        expected_payment: expected, actual_payment: actual.suggestedAmount, selected_payment: '', created_payment_id: '', result: 'PASS' })
      raw.push({ scenario, currency, agreement: await read(page, agreementBase), actual, program_cad_budget: updatedProgramBudget, stream_cad_budget: authoredStreamBudget,
        program_usd_budget: usdProgramBudget, stream_usd_budget: usdStreamBudget, usd_chart: usdChart, usd_stream_chart: usdLinkedChart,
        budget: await read(page, `${agreementBase}/budget-overview`), commitments: await read(page, `${agreementBase}/commitments-overview`),
        forecast: await read(page, `${agreementBase}/forecasts-overview`), claims: await read(page, `${agreementBase}/claims-overview`), payments: await read(page, `${agreementBase}/payments-overview`) })
      await persist()
      return { expected, body }
    }
    const createPayment = async (scenario: string, currency: Currency, paymentType: 'advance' | 'reimbursement', periodEnd: number, release = '0.00') => {
      const { expected } = await check(scenario, currency, paymentType, periodEnd, release)
      const agreementBase = bases[currency]
      await tab('Payments', currency)
      await page.getByRole('button', { name: 'Add Payment', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Add Payment', exact: true })
      await selectPaymentAuditPayee(page, dialog, payees[currency])
      const currencyControl = dialog.getByRole('combobox', { name: /^Currency/ })
      await expect(currencyControl).toBeDisabled()
      await expect(currencyControl).toHaveText(currencyLabel(currency))
      await choose(dialog, /^Commitment type/, /Commitment/)
      await choose(dialog, /^Fiscal year/, String(fiscal.egcs_ay_fiscalyeardisplay))
      await choose(dialog, /^Payment type/, paymentType === 'advance' ? 'Advance' : 'Reimbursement')
      await choose(dialog, /^Period start/, 'Apr')
      await choose(dialog, /^Period end/, ['Apr', 'May', 'Jun'][periodEnd]!)
      if (cents(release) > BigInt(0)) {
        await dialog.getByRole('checkbox').check()
        const releaseAmount = dialog.getByRole('textbox', { name: /Holdback release amount/i })
        await releaseAmount.click()
        await expect(releaseAmount).toBeFocused()
        await expect(releaseAmount).toHaveValue('')
        await releaseAmount.fill(release)
        await expect(releaseAmount).toHaveValue(release)
        await releaseAmount.press('Tab')
      }
      await expect.poll(async () => (await dialog.getByRole('textbox', { name: /^Amount/ }).inputValue()).replace(/[^\d.-]/g, '')).toBe(expected)
      await expect(currencyControl).toHaveText(currencyLabel(currency))
      const response = page.waitForResponse(candidate => candidate.request().method() === 'POST' && candidate.url().endsWith(`${agreementBase}/payments`))
      await dialog.getByRole('button', { name: 'Add', exact: true }).click()
      const payment = await (await response).json() as Row
      expect(payment.egcs_fc_currency).toBe(currency)
      expect(payment.egcs_fc_paymentamount).toBe(expected)
      expect(payment.egcs_fc_applicantrecipient).toBe(payees[currency].id)
      if (!raw.some(row => row.boundary === 'agreement-payment-currency-mismatch' && row.agreement_currency === currency)) {
        await reject(currency, 'agreement-payment-currency-mismatch', `${agreementBase}/payments`, {
          egcs_fc_applicantrecipient: payees[currency].id,
          egcs_fc_commitmenttype: commitmentType, egcs_fc_fiscalyear: years[currency].id,
          egcs_fc_paymenttype: paymentType, egcs_fc_periodstart: 0, egcs_fc_periodend: periodEnd,
          egcs_fc_paymentamount: '0.01', egcs_fc_currency: currency === 'cad' ? 'usd' : 'cad'
        })
        await reject(currency, 'calculator-agreement-currency-mismatch',
          `/api/extensions/gcs-automated-payments/agreements/${owners[currency].agreementId}/calculate-payment`, {
            egcs_fc_commitmenttype: commitmentType, egcs_fc_fiscalyear: years[currency].id,
            egcs_fc_currency: currency === 'cad' ? 'usd' : 'cad', egcs_fc_paymenttype: paymentType,
            egcs_fc_periodstart: 0, egcs_fc_periodend: periodEnd
          })
      }
      const oppositeCurrency: Currency = currency === 'cad' ? 'usd' : 'cad'
      const wrongLine = await page.request.post(`${agreementBase}/payment-lines`, { data: {
        egcs_fc_fundingagreementpayment: payment.id,
        egcs_fc_fundingagreementcommitmentline: commitmentLines[oppositeCurrency], egcs_fc_amount: '0.01'
      } })
      expect(wrongLine.status()).toBe(400)
      expect((await wrongLine.json()).data.code).toBe('INVALID_AGREEMENT_PAYMENT_COMMITMENT_LINE')
      raw.push({ boundary: 'payment-native-allocation', scenario, currency, payment,
        rejected_commitment_line_id: commitmentLines[oppositeCurrency], rejected_amount: '0.01', rejected_status: wrongLine.status() })
      await post(page, `${agreementBase}/payment-lines`, {
        egcs_fc_fundingagreementpayment: payment.id, egcs_fc_fundingagreementcommitmentline: commitmentLines[currency], egcs_fc_amount: expected
      })
      await complete('fundingcasepayment', payment.id)
      scenarios.at(-1)!.selected_payment = expected
      scenarios.at(-1)!.created_payment_id = payment.id
      paid[currency] = sum([paid[currency], expected])
      record(currency, 'payment', payment.id, periodEnd, expected)
      await persist()
      await page.goto(`/en/agreements/${owners[currency].agreementId}/payments/${payment.id}`)
      await expect(page.getByRole('tab', { name: 'Payment completion', exact: true })).toBeVisible()
      await expect(page.getByText('Loading records', { exact: true })).toHaveCount(0)
      await expect(page.getByText(new RegExp(`${currency.toUpperCase()}`)).first()).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath(`${scenario}-${currency}.png`), fullPage: true })
    }
    const reconcile = async (month: number, values: Partial<Record<Currency, [string, string]>>) => {
      for (const currency of ['cad', 'usd'] as const) {
        const valuesForCurrency = values[currency]
        if (!valuesForCurrency) continue
        const agreementBase = bases[currency]
        const [original, accepted] = valuesForCurrency
        const claim = await post(page, `${agreementBase}/claims`, { egcs_fc_fiscalyear: years[currency].id,
          egcs_fc_applicantrecipient: payees[currency].id,
          egcs_fc_periodstart: month, egcs_fc_periodend: month, egcs_fc_isfinalforyear: month === 2,
          egcs_fc_receiveddate: String(fiscal.egcs_ay_startdate).slice(0, 10) })
        expect(claim.egcs_fc_applicantrecipient).toBe(payees[currency].id)
        const line = await post(page, `${agreementBase}/claim-line-items`, { egcs_fc_fundingagreementclaim: claim.id,
          egcs_fc_fundingagreementbudgetlineitem: currency === 'cad' ? budgetLine.id : usdBudgetLine.id,
          egcs_fc_description: `Native ${currency} Claim month ${month}`, egcs_fc_amount: original,
          egcs_fc_totalamount: original, egcs_fc_currency: currency })
        if (month === 0) await reject(currency, 'agreement-claim-currency-mismatch', `${agreementBase}/claim-line-items`, {
          egcs_fc_fundingagreementclaim: claim.id,
          egcs_fc_fundingagreementbudgetlineitem: currency === 'cad' ? budgetLine.id : usdBudgetLine.id,
          egcs_fc_description: 'Wrong native denomination', egcs_fc_amount: '0.01', egcs_fc_totalamount: '0.01',
          egcs_fc_currency: currency === 'cad' ? 'usd' : 'cad'
        })
        record(currency, 'submitted_claim', line.id, month, original)
        submitted[currency] = sum([submitted[currency], original])
        await complete('fundingcaseagreementclaim', claim.id)
        const reconciliation = await post(page, `${agreementBase}/claim-reconciles`, {
          egcs_fc_fundingagreementclaim: claim.id, egcs_fc_isfinal: true })
        const acceptedLine = await post(page, `${agreementBase}/claim-reconcile-line-items`, {
          egcs_fc_fundingagreementclaimreconcile: reconciliation.id, egcs_fc_lineitem: line.id, egcs_fc_reconciled: accepted })
        record(currency, 'reconciliation', acceptedLine.id, month, accepted)
        await complete('fundingclaimreconcile', reconciliation.id)
        claims[currency] = sum([claims[currency], accepted])
        lastClaim[currency] = month
      }
      await persist()
    }
    await createPayment('currency-01-CAD-first-advance', 'cad', 'advance', 0)
    await createPayment('currency-02-USD-first-advance-excludes-CAD-cash', 'usd', 'advance', 0)
    await reconcile(0, { cad: ['510.00', '500.00'], usd: ['110.00', '100.00'] })
    await check('currency-03-USD-advance-overpayment', 'usd', 'reimbursement', 0)
    await createPayment('currency-04-CAD-claim-underpayment', 'cad', 'reimbursement', 0)
    await createPayment('currency-05-USD-forecast-replacement', 'usd', 'advance', 1)
    await reconcile(1, { usd: ['410.07', '400.07'] })
    await createPayment('currency-06-USD-claim-underpayment', 'usd', 'reimbursement', 1)
    await createPayment('currency-07-CAD-cutoff-excludes-USD-only-claim', 'cad', 'advance', 1)
    await reconcile(2, { usd: ['100.00', '100.00'] })
    await createPayment('currency-08-USD-ordinary-final-payment', 'usd', 'reimbursement', 2)
    await createPayment('currency-09-USD-final-holdback-release', 'usd', 'reimbursement', 2, '100.00')
    await createPayment('currency-10-CAD-native-commitment-ceiling', 'cad', 'advance', 2)
    await check('currency-11-CAD-overpaid-claims-no-reimbursement', 'cad', 'reimbursement', 2)
    await check('currency-12-USD-exhausted-despite-CAD-values', 'usd', 'reimbursement', 2, '100.00')
    expect(paid).toEqual({ cad: '1000.05', usd: '600.07' })
    await persist()
    await verifyFundingCurrencyControls(page, testInfo, owner)
    for (const currency of ['cad', 'usd'] as const) {
      await page.goto(`/en/agreements/${owners[currency].agreementId}`)
      await page.waitForURL(url => url.searchParams.get('section') === 'general')
      const control = page.getByRole('combobox', { name: /^Currency/ })
      await expect(control).toBeDisabled()
      await expect(control).toHaveText(currencyLabel(currency))
      await expect(page.getByText(currency.toUpperCase(), { exact: true }).first()).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath(`agreement-immutable-${currency}.png`), fullPage: true })
      raw.push({ boundary: 'agreement-profile-currency-immutable-ui', agreement_id: owners[currency].agreementId,
        currency, disabled: await control.isDisabled(), accessible_display: await control.innerText(), result: 'PASS' })
    }
    await persist()
  } finally {
    await approver.close()
  }
}
