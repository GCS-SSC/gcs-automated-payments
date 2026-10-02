import { expect, type Page, type TestInfo } from '@playwright/test'

type Row = { id: string } & Record<string, unknown>
type AgreementInput = {
  egcs_fc_transferpaymentstream: string
  egcs_fc_agreementnumber: string
  egcs_fc_financialsystemnumber: number
  egcs_fc_currency: string
  egcs_fc_title_en: string
  egcs_fc_title_fr: string
  egcs_fc_description_en: string
  egcs_fc_description_fr: string
  egcs_fc_agreementsubtype: string
  egcs_fc_holdbackbasis: string
  egcs_fc_authorizedassistancestartdate: string
  egcs_fc_authorizedassistanceenddate: string
  egcs_fc_applicantrecipients: Array<{ egcs_fc_applicantrecipient: string; egcs_fc_applicantrecipientsubtype: string }>
}

const getItems = async (page: Page, path: string) => {
  const response = await page.request.get(path)
  expect(response.ok(), `${path}: ${response.status()} ${await response.text()}`).toBe(true)
  return (await response.json()).items as Row[]
}

const setDate = async (page: Page, index: number, value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)!
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  const month = date.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
  const year = date.getUTCFullYear()
  await page.getByRole('group').nth(index).click()
  const calendar = page.locator('[data-slot="content"]').last()
  for (let attempt = 0; attempt < 36; attempt++) {
    if (await calendar.getByText(new RegExp(`^${month}\\s+${year}$`, 'i')).count()) break
    const heading = calendar.locator('h2, [data-slot="heading"], [aria-live="polite"]').filter({ hasText: /\d{4}/ }).first()
    const parts = /^([A-Za-z]+)\s+(\d{4})$/.exec((await heading.innerText()).trim())
    expect(parts, 'Calendar month heading').toBeTruthy()
    const visible = new Date(`${parts![1]} 1, ${parts![2]}`)
    const difference = (year - visible.getFullYear()) * 12 + date.getUTCMonth() - visible.getMonth()
    await calendar.getByRole('button', { name: difference > 0 ? /next month/i : /previous month/i }).click()
  }
  await page.getByRole('button', { name: date.toLocaleDateString('en-US', {
    day: 'numeric', month: 'long', weekday: 'long', year: 'numeric', timeZone: 'UTC'
  }), exact: true }).click()
}

/** Saves the native Agreement through every real create control and verifies the persisted immutable field after reload. */
export const createNativeAgreementThroughUi = async (page: Page, testInfo: TestInfo, programId: string, input: AgreementInput) => {
  const programs = await getItems(page, '/api/agreements/lookups/streams?permission_action=create&group_by=program&limit=100')
  const streams = await getItems(page, `/api/agreements/lookups/streams?permission_action=create&program_id=${programId}&limit=100`)
  const subtypes = await getItems(page, `/api/agreements/lookups/agreement-subtypes?permission_action=create&stream_id=${input.egcs_fc_transferpaymentstream}&limit=100`)
  const bases = await getItems(page, `/api/agreements/lookups/holdback-bases?permission_action=create&stream_id=${input.egcs_fc_transferpaymentstream}&limit=100`)
  const proponentTypes = await getItems(page, `/api/agreements/lookups/proponent-types?permission_action=create&stream_id=${input.egcs_fc_transferpaymentstream}&proponent_id=${input.egcs_fc_applicantrecipients[0]!.egcs_fc_applicantrecipient}&limit=100`)
  await page.goto(`/en/agreements/new?applicant_recipient_id=${input.egcs_fc_applicantrecipients[0]!.egcs_fc_applicantrecipient}`)
  const choose = async (label: RegExp, value: string) => {
    const control = page.getByRole('combobox', { name: label })
    await expect(control).toBeEnabled()
    await control.click()
    const search = page.getByRole('listbox').getByRole('combobox', { name: 'Search...', exact: true })
    if (await search.count()) await search.fill(value)
    await page.getByRole('option').filter({ hasText: value }).first().click()
    if (await control.getAttribute('aria-expanded') === 'true') await page.keyboard.press('Escape')
    await expect(page.locator('[role="listbox"]')).toHaveCount(0)
  }
  const label = (rows: Row[], id: string) => {
    const row = rows.find(row => String(row.id) === String(id))!
    expect(row, `Required lookup row ${id}`).toBeTruthy()
    return String(row.label_en)
  }
  await choose(/^Program/, label(programs, programId))
  await choose(/^Stream/, label(streams, input.egcs_fc_transferpaymentstream))
  await choose(/^Agreement subtype/, label(subtypes, input.egcs_fc_agreementsubtype))
  await choose(/^Holdback basis/, label(bases, input.egcs_fc_holdbackbasis))
  const currency = page.getByRole('combobox', { name: /^Currency/ })
  await expect(currency).toHaveAttribute('aria-required', 'true')
  const currencyDisplay = new Intl.DisplayNames(['en'], { type: 'currency' }).of(input.egcs_fc_currency.toUpperCase())!
  await currency.focus()
  await currency.press('Enter')
  await page.getByRole('option', { name: currencyDisplay, exact: true }).press('Enter')
  await expect(page.locator('[role="listbox"]')).toHaveCount(0)
  await expect(currency).toHaveText(currencyDisplay)
  for (const key of ['egcs_fc_agreementnumber', 'egcs_fc_financialsystemnumber', 'egcs_fc_title_en', 'egcs_fc_title_fr', 'egcs_fc_description_en', 'egcs_fc_description_fr'] as const) {
    await page.locator(`[name="${key}"]`).fill(String(input[key]))
  }
  await setDate(page, 0, input.egcs_fc_authorizedassistancestartdate)
  await setDate(page, 1, input.egcs_fc_authorizedassistanceenddate)
  const type = page.getByRole('combobox', { name: /—.*Proponent type/ })
  await expect(type).toHaveCount(1)
  const proponentType = proponentTypes.find(row => String(row.id) === input.egcs_fc_applicantrecipients[0]!.egcs_fc_applicantrecipientsubtype)!
  if (await type.isEnabled()) await choose(/—.*Proponent type/, String(proponentType.egcs_ay_name_en))
  await page.screenshot({ path: testInfo.outputPath('native-USD-Agreement-create-filled.png'), fullPage: true })
  const response = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/agreements')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  const createdResponse = await response
  expect(createdResponse.ok(), await createdResponse.text()).toBe(true)
  const submitted = createdResponse.request().postDataJSON() as Record<string, unknown>
  expect(submitted.egcs_fc_currency).toBe(input.egcs_fc_currency)
  const created = await createdResponse.json() as Row
  await page.waitForURL(url => url.pathname === `/en/agreements/${created.id}`)
  await page.reload()
  await page.waitForURL(url => url.searchParams.get('section') === 'general')
  await expect(page.getByRole('combobox', { name: /^Currency/ })).toBeDisabled()
  await expect(page.getByRole('combobox', { name: /^Currency/ })).toHaveText(currencyDisplay)
  const persisted = await page.request.get(`/api/agreements/${created.id}`)
  expect(persisted.ok()).toBe(true)
  const profile = await persisted.json() as Row
  expect(profile.egcs_fc_currency).toBe(input.egcs_fc_currency)
  expect(profile.egcs_fc_agreementnumber).toBe(input.egcs_fc_agreementnumber)
  await page.screenshot({ path: testInfo.outputPath('native-USD-Agreement-created-reloaded-immutable.png'), fullPage: true })
  return { created, submitted, profile, saved_through_ui: true, reloaded: true, immutable_currency_control_disabled: true }
}
