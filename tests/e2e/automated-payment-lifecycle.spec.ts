import { expect, test, type APIResponse, type Page } from '@playwright/test'

const baseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000'

const login = async (page: Page, email: string, password: string): Promise<void> => {
  await page.goto(`${baseUrl}/en/login`)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: /^(login|connexion)$/i }).click()
  await page.waitForURL(url => !url.pathname.endsWith('/login'))
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible()
}

const responseJson = async <T>(response: APIResponse): Promise<T> => {
  const contentType = response.headers()['content-type'] || ''
  if (!contentType.includes('application/json')) {
    throw new Error(`Expected JSON response but got content-type: ${contentType}`)
  }
  return await response.json() as T
}

type IdRow = {
  id: string | number
}

type AllocationPayload = {
  outcomes: Array<{ id: string | number }>
  budgetYears: Array<{
    id: string | number
    stream_budget_id?: string | number | null
    program_funding: string | number
    fiscal_year_display: string
  }>
  streamCommitments: Array<{
    id: string | number
    stream_budget_id: string | number
  }>
  commitmentTypes: Array<{ id: string | number }>
}

type StatusRow = {
  id: string | number
  agencyId: string
  nameEn: string
  isDraft: boolean
  terminal: boolean
}

type RuntimeApprovalStep = {
  id: string
  can_action: boolean
  certifications: Array<{
    id: string
    egcs_cn_optional: boolean
  }>
}

type PaymentCoverageDetail = {
  egcs_fc_fundingagreementcommitment: string | number
  egcs_fc_fiscalyear: string | number
  lines: Array<{
    egcs_fc_fundingagreementcommitmentline: string | number
    egcs_fc_amount: number
  }>
}

type CommitmentCoverageDetail = {
  lines: Array<{
    id: string | number
    egcs_fc_transferpaymentstreamchartofaccount: string | number
  }>
}

type ApprovalRuntimePayload = {
  steps?: RuntimeApprovalStep[]
  routingSlips?: Array<{
    steps: RuntimeApprovalStep[]
  }>
}

type PaymentCalculationPayload = {
  baseAmount: number
  ceilingAmount: number
  suggestedAmount: number
  details: Array<{ label: string, value: number }>
}

const AGREEMENT_ID = '51'
const AGENCY_ID = '1'
const STREAM_ID = '31'
const AUTOMATED_PAYMENTS_EXTENSION_KEY = 'gcs-automated-payments'
const OUTCOME_ALLOCATION_EXTENSION_KEY = 'gcs-outcome-cost-allocation'

const roundCurrency = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100

const expectOk = async (response: APIResponse, label: string) => {
  if (response.status() < 200 || response.status() >= 300) {
    throw new Error(`${label} failed: ${response.status()} ${await response.text()}`)
  }
}

const getRuntimeSteps = (payload: ApprovalRuntimePayload): RuntimeApprovalStep[] => {
  if (payload.routingSlips && payload.routingSlips.length > 0) {
    return payload.routingSlips.flatMap(routingSlip => routingSlip.steps)
  }

  return payload.steps ?? []
}

const completeEntity = async (
  page: Page,
  entityType: string,
  entityId: string,
  comments: string
) => {
  const response = await page.request.post('/api/completions/complete', {
    data: {
      entityType,
      entityId,
      comments
    }
  })
  await expectOk(response, `Complete ${entityType} ${entityId}`)
}

const approveAllSteps = async (
  page: Page,
  entityType: string,
  entityId: string
) => {
  for (let index = 0; index < 5; index += 1) {
    const runtimeResponse = await page.request.get(
      `/api/approvals/runtime?entityType=${encodeURIComponent(entityType)}&entityId=${encodeURIComponent(entityId)}`
    )
    await expectOk(runtimeResponse, `Approval runtime ${entityType} ${entityId}`)
    const runtimePayload = await responseJson<ApprovalRuntimePayload>(runtimeResponse)
    const nextStep = getRuntimeSteps(runtimePayload).find(step => step.can_action)

    if (!nextStep) {
      return
    }

    const approveResponse = await page.request.post('/api/approvals/approve', {
      data: {
        approvalId: nextStep.id,
        certifications: nextStep.certifications.map(certification => ({
          id: certification.id,
          egcs_cn_value: certification.egcs_cn_optional ? false : true
        }))
      }
    })
    await expectOk(approveResponse, `Approve ${entityType} step ${nextStep.id}`)
  }

  throw new Error(`Approval runtime for ${entityType} ${entityId} still had actionable steps after 5 approvals.`)
}

const calculateAdvance = async (
  page: Page,
  commitmentType: string,
  fiscalYearId: string,
  periodEnd: number,
  paymentAmount = 0
) => {
  const response = await page.request.post(
    `/api/extensions/${AUTOMATED_PAYMENTS_EXTENSION_KEY}/agreements/${AGREEMENT_ID}/calculate-payment`,
    {
      data: {
        egcs_fc_commitmenttype: commitmentType,
        egcs_fc_fiscalyear: fiscalYearId,
        egcs_fc_paymenttype: 'advance',
        egcs_fc_periodstart: 0,
        egcs_fc_periodend: periodEnd,
        egcs_fc_paymentamount: paymentAmount,
        extensions: {
          [AUTOMATED_PAYMENTS_EXTENSION_KEY]: {
            releaseHoldback: false,
            holdbackReleaseAmount: 0
          }
        }
      }
    }
  )
  await expectOk(response, 'Calculate advance payment')
  return await responseJson<PaymentCalculationPayload>(response)
}

const ensureStreamHoldbackBasis = async (
  page: Page,
  programId: string,
  code: string
): Promise<IdRow> => {
  const streamBasesResponse = await page.request.get(
    `/api/transfer-payments/${programId}/streams/${STREAM_ID}/holdback-bases?page=1&limit=100`
  )
  await expectOk(streamBasesResponse, 'List stream holdback bases')
  const streamBases = await responseJson<{
    items: Array<IdRow & { egcs_ay_languageindependentcode: string }>
  }>(streamBasesResponse)
  const existing = streamBases.items.find(item => item.egcs_ay_languageindependentcode === code)
  if (existing) return existing

  const agencyBasesResponse = await page.request.get(`/api/agency/${AGENCY_ID}/holdback-bases?page=1&limit=100`)
  await expectOk(agencyBasesResponse, 'List agency holdback bases')
  const agencyBases = await responseJson<{
    items: Array<IdRow & {
      egcs_ay_languageindependentcode: string
      egcs_ay_name_en: string
      egcs_ay_name_fr: string
    }>
  }>(agencyBasesResponse)
  const agencyBasis = agencyBases.items.find(item => item.egcs_ay_languageindependentcode === code)
  if (!agencyBasis) throw new Error(`Agency holdback basis ${code} is unavailable.`)

  const createResponse = await page.request.post(
    `/api/transfer-payments/${programId}/streams/${STREAM_ID}/holdback-bases`,
    {
      data: {
        egcs_tp_agencyholdback: String(agencyBasis.id),
        egcs_tp_name_en: agencyBasis.egcs_ay_name_en,
        egcs_tp_name_fr: agencyBasis.egcs_ay_name_fr
      }
    }
  )
  await expectOk(createResponse, `Create stream holdback basis ${code}`)
  return await responseJson<IdRow>(createResponse)
}

const ensureAllocationApprovalWorkflow = async (page: Page, programId: string): Promise<void> => {
  const statusesResponse = await page.request.get('/api/statuses')
  await expectOk(statusesResponse, 'List lifecycle statuses')
  const statuses = (await responseJson<StatusRow[]>(statusesResponse))
    .filter(status => status.agencyId === AGENCY_ID)
  const draft = statuses.find(status => status.isDraft)
  const pending = statuses.find(status => status.nameEn === 'Pending Approval')
  const approved = statuses.find(status => status.nameEn === 'Approved')
  const denied = statuses.find(status => status.nameEn === 'Denied')
  if (!draft || !pending || !approved || !denied) {
    throw new Error('Required seeded lifecycle statuses are unavailable.')
  }

  const existingResponse = await page.request.get(
    `/api/transfer-payments/${programId}/streams/${STREAM_ID}/workflow-setups?page=1&limit=100`
  )
  await expectOk(existingResponse, 'List allocation Workflows')
  const existing = await responseJson<{ items: Array<{ id: string | number, egcs_cn_entitytype: string, publicationState: string }> }>(existingResponse)
  if (existing.items.some(item =>
    item.egcs_cn_entitytype === `${OUTCOME_ALLOCATION_EXTENSION_KEY}:allocation-version`
    && item.publicationState === 'published'
  )) return

  const templatesResponse = await page.request.get(
    `/api/approval-templates?scopeType=transferpaymentstream&scopeId=${STREAM_ID}&page=1&limit=100`
  )
  await expectOk(templatesResponse, 'List Approval Templates')
  const templates = await responseJson<{ items: Array<{ id: string | number, publicationState: string }> }>(templatesResponse)
  const template = templates.items.find(item => item.publicationState === 'published')
  if (!template) throw new Error('A published stream Approval Template is required.')

  const createResponse = await page.request.post(`/api/transfer-payments/${programId}/streams/${STREAM_ID}/workflow-setups`, {
    data: {
      egcs_cn_scopetype: 'transferpaymentstream',
      egcs_cn_scopeid: STREAM_ID,
      egcs_cn_entitytype: `${OUTCOME_ALLOCATION_EXTENSION_KEY}:allocation-version`,
      egcs_cn_name_en: 'Outcome allocation approval',
      egcs_cn_name_fr: 'Approbation de la repartition des resultats',
      egcs_cn_description_en: 'Approves a completed outcome allocation before activation.',
      egcs_cn_description_fr: 'Approuve une repartition des resultats terminee avant son activation.',
      egcs_cn_purpose: 'standard',
      egcs_cn_allowedstartstatuses: [String(draft.id)],
      egcs_cn_cancellationstatus: String(denied.id),
      egcs_cn_executionfailurestatus: String(denied.id),
      egcs_cn_allowretry: true
    }
  })
  await expectOk(createResponse, 'Create allocation Workflow')
  const workflow = await responseJson<IdRow>(createResponse)
  const workflowId = String(workflow.id)

  const memberResponse = await page.request.post(
    `/api/transfer-payments/${programId}/streams/${STREAM_ID}/workflow-setups/${workflowId}/members`,
    {
      data: {
        egcs_cn_sequence: 1,
        egcs_cn_kind: 'approval_template',
        egcs_cn_approvaltemplate: String(template.id),
        egcs_cn_materializationstatus: String(pending.id),
        egcs_cn_successstatus: String(approved.id),
        egcs_cn_failurestatus: String(denied.id),
        egcs_cn_allowownerredirect: false,
        owners: []
      }
    }
  )
  await expectOk(memberResponse, 'Add allocation Approval member')
  const publishResponse = await page.request.post(
    `/api/transfer-payments/${programId}/streams/${STREAM_ID}/workflow-setups/${workflowId}/publish`
  )
  await expectOk(publishResponse, 'Publish allocation Workflow')
}

test.describe('Automated payment lifecycle', () => {
  test('runs allocation, commitment, forecast, and automatically calculated advance payment', async ({ page, browser }) => {
    await login(page, 'root@example.com', 'password123')

    const agreementResponse = await page.request.get(`/api/agreements/${AGREEMENT_ID}`)
    await expectOk(agreementResponse, 'Resolve automated-payment stream program')
    const agreement = await responseJson<{ program_id: string }>(agreementResponse)

    const statusesResponse = await page.request.get('/api/statuses')
    await expectOk(statusesResponse, 'Resolve draft payment status')
    const statusCatalog = await responseJson<StatusRow[]>(statusesResponse)
    const draftStatusIds = new Set(statusCatalog
      .filter(status => status.agencyId === AGENCY_ID && status.isDraft)
      .map(status => String(status.id)))
    const draftStatusId = [...draftStatusIds][0]
    const approvedStatusId = statusCatalog
      .find(status => status.agencyId === AGENCY_ID && status.nameEn === 'Approved')?.id
    const inProgressStatusId = statusCatalog
      .find(status => status.agencyId === AGENCY_ID && status.nameEn === 'In Progress')?.id
    if (!draftStatusId || !approvedStatusId || !inProgressStatusId) {
      throw new Error('Required seeded status identities are unavailable.')
    }

    const seededPaymentsResponse = await page.request.get(`/api/agreements/${AGREEMENT_ID}/payments-overview`)
    await expectOk(seededPaymentsResponse, 'Fetch seeded payments')
    const seededPayments = await responseJson<{ payments: Array<IdRow & { egcs_fc_status: string }> }>(seededPaymentsResponse)
    for (const payment of seededPayments.payments.filter(item => draftStatusIds.has(String(item.egcs_fc_status)))) {
      const deleteResponse = await page.request.delete(`/api/agreements/${AGREEMENT_ID}/payments/${payment.id}`)
      if (deleteResponse.status() !== 409) {
        await expectOk(deleteResponse, `Delete seeded draft payment ${payment.id}`)
      }
    }

    const retainedPaymentsResponse = await page.request.get(`/api/agreements/${AGREEMENT_ID}/payments-overview`)
    await expectOk(retainedPaymentsResponse, 'Fetch retained seeded payments')
    const retainedPayments = await responseJson<{ payments: IdRow[] }>(retainedPaymentsResponse)
    const paidByYearAndChart = new Map<string, number>()
    for (const payment of retainedPayments.payments) {
      const paymentResponse = await page.request.get(`/api/agreements/${AGREEMENT_ID}/payments/${payment.id}`)
      await expectOk(paymentResponse, `Read seeded payment ${payment.id}`)
      const paymentDetail = await responseJson<PaymentCoverageDetail>(paymentResponse)
      const commitmentResponse = await page.request.get(
        `/api/agreements/${AGREEMENT_ID}/commitments/${paymentDetail.egcs_fc_fundingagreementcommitment}`
      )
      await expectOk(commitmentResponse, `Read seeded payment commitment ${paymentDetail.egcs_fc_fundingagreementcommitment}`)
      const commitmentDetail = await responseJson<CommitmentCoverageDetail>(commitmentResponse)
      const chartByLineId = new Map(commitmentDetail.lines.map(line => [
        String(line.id),
        String(line.egcs_fc_transferpaymentstreamchartofaccount)
      ]))
      for (const line of paymentDetail.lines) {
        const chartId = chartByLineId.get(String(line.egcs_fc_fundingagreementcommitmentline))
        if (!chartId) throw new Error(`No chart was resolved for commitment line ${line.egcs_fc_fundingagreementcommitmentline}.`)
        const key = `${String(paymentDetail.egcs_fc_fiscalyear)}:${chartId}`
        paidByYearAndChart.set(key, (paidByYearAndChart.get(key) ?? 0) + Number(line.egcs_fc_amount))
      }
    }

    const enableResponse = await page.request.patch(`/api/extensions/agency/${AGENCY_ID}`, {
      data: {
        extensionKey: AUTOMATED_PAYMENTS_EXTENSION_KEY,
        enabled: true
      }
    })
    await expectOk(enableResponse, 'Enable automated payments for agency')

    const allocationAgencyResponse = await page.request.patch(`/api/extensions/agency/${AGENCY_ID}`, {
      data: { extensionKey: OUTCOME_ALLOCATION_EXTENSION_KEY, enabled: true }
    })
    await expectOk(allocationAgencyResponse, 'Enable outcome allocation for agency')
    const allocationMigrationResponse = await page.request.post(`/api/extensions/agency/${AGENCY_ID}/migrations`, {
      data: { extensionKey: OUTCOME_ALLOCATION_EXTENSION_KEY }
    })
    await expectOk(allocationMigrationResponse, 'Apply outcome allocation migrations')

    await ensureStreamHoldbackBasis(page, agreement.program_id, 'final-fiscal-year')

    const streamConfigResponse = await page.request.patch(`/api/extensions/streams/${STREAM_ID}`, {
      data: {
        extensionKey: AUTOMATED_PAYMENTS_EXTENSION_KEY,
        enabled: true,
        config: {
          enabledPaymentTypes: ['advance', 'reimbursement']
        }
      }
    })
    await expectOk(streamConfigResponse, 'Enable automated payments for stream')

    const allocationEnableResponse = await page.request.patch(`/api/extensions/streams/${STREAM_ID}`, {
      data: {
        extensionKey: OUTCOME_ALLOCATION_EXTENSION_KEY,
        enabled: true
      }
    })
    await expectOk(allocationEnableResponse, 'Enable outcome allocation for stream')

    const allocationResponse = await page.request.get(
      `/api/extensions/${OUTCOME_ALLOCATION_EXTENSION_KEY}/agreements/${AGREEMENT_ID}/allocations`
    )
    await expectOk(allocationResponse, 'Fetch cost allocation inputs')
    const allocationPayload = await responseJson<AllocationPayload>(allocationResponse)
    const firstOutcomeId = String(allocationPayload.outcomes[0]?.id ?? '')
    const commitmentType = String(allocationPayload.commitmentTypes[0]?.id ?? '')
    expect(firstOutcomeId).not.toBe('')
    expect(commitmentType).not.toBe('')
    expect(allocationPayload.budgetYears.length).toBeGreaterThan(0)
    expect(allocationPayload.streamCommitments.length).toBeGreaterThan(0)
    const allocationMappings = allocationPayload.budgetYears.flatMap(year => {
      const streamBudgetId = String(year.stream_budget_id ?? '')
      const streamCommitments = allocationPayload.streamCommitments.filter(item =>
        String(item.stream_budget_id) === streamBudgetId
      )

      if (streamCommitments.length === 0) {
        throw new Error(`No stream commitment was returned for stream budget ${streamBudgetId}.`)
      }

      return streamCommitments.map(streamCommitment => ({
        commitmentType,
        outcomeId: firstOutcomeId,
        streamBudgetId,
        streamCommitmentId: String(streamCommitment.id)
      }))
    })

    const allocationConfigResponse = await page.request.patch(`/api/extensions/streams/${STREAM_ID}`, {
      data: {
        extensionKey: OUTCOME_ALLOCATION_EXTENSION_KEY,
        enabled: true,
        config: {
          enabledCommitmentTypes: [commitmentType],
          mappings: allocationMappings
        }
      }
    })
    await expectOk(allocationConfigResponse, 'Configure outcome allocation mappings')

    const draftVersionResponse = await page.request.post(
      `/api/extensions/${OUTCOME_ALLOCATION_EXTENSION_KEY}/agreements/${AGREEMENT_ID}/allocation-versions`
    )
    await expectOk(draftVersionResponse, 'Create allocation version')
    const draftVersionPayload = await responseJson<{ version: IdRow }>(draftVersionResponse)
    const allocationVersionId = String(draftVersionPayload.version.id)

    const allocations = allocationPayload.budgetYears.flatMap(year => {
      const mappings = allocationMappings.filter(mapping => mapping.streamBudgetId === String(year.stream_budget_id))
      const total = Number(year.program_funding)
      const paidAmounts = mappings.map(mapping => paidByYearAndChart.get(`${String(year.id)}:${mapping.streamCommitmentId}`) ?? 0)
      const paidTotal = paidAmounts.reduce((sum, amount) => sum + amount, 0)
      if (paidTotal > total) throw new Error(`Seeded payments exceed funding for budget year ${year.id}.`)
      return mappings.map((mapping, index) => ({
        commitmentType,
        streamCommitmentId: mapping.streamCommitmentId,
        agreementBudgetFiscalYearId: String(year.id),
        outcomeId: firstOutcomeId,
        allocationMethod: 'amount' as const,
        allocationValue: paidAmounts[index]! + (index === 0 ? total - paidTotal : 0)
      }))
    })

    const saveAllocationResponse = await page.request.put(
      `/api/extensions/${OUTCOME_ALLOCATION_EXTENSION_KEY}/agreements/${AGREEMENT_ID}/allocations`,
      {
        data: {
          allocationVersionId,
          allocations
        }
      }
    )
    await expectOk(saveAllocationResponse, 'Save allocation version')

    await ensureAllocationApprovalWorkflow(page, agreement.program_id)
    const completeAllocationResponse = await page.request.post('/api/completions/complete', {
      data: {
        entityType: `${OUTCOME_ALLOCATION_EXTENSION_KEY}:allocation-version`,
        entityId: allocationVersionId,
        comments: 'Lifecycle test allocation completion.'
      }
    })
    await expectOk(completeAllocationResponse, 'Complete allocation version')
    await approveAllSteps(
      page,
      `${OUTCOME_ALLOCATION_EXTENSION_KEY}:allocation-version`,
      allocationVersionId
    )

    const commitmentsBeforeUiCreateResponse = await page.request.get(`/api/agreements/${AGREEMENT_ID}/commitments-overview`)
    await expectOk(commitmentsBeforeUiCreateResponse, 'List commitments before UI creation')
    const commitmentsBeforeUiCreate = await responseJson<{ commitments: IdRow[] }>(commitmentsBeforeUiCreateResponse)
    const existingCommitmentIds = new Set(commitmentsBeforeUiCreate.commitments.map(commitment => String(commitment.id)))

    await page.goto(`/en/agreements/${AGREEMENT_ID}`)
    await page.getByRole('tab', { name: 'Commitments' }).click()
    await page.getByRole('button', { name: 'Add commitment', exact: true }).click()
    const commitmentDialog = page.getByRole('dialog', { name: 'Add commitment' })
    await expect(commitmentDialog.getByText('Commitment', { exact: true })).toBeVisible()
    await commitmentDialog.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(commitmentDialog).toBeHidden()

    const commitmentsAfterUiCreateResponse = await page.request.get(`/api/agreements/${AGREEMENT_ID}/commitments-overview`)
    await expectOk(commitmentsAfterUiCreateResponse, 'List commitments after UI creation')
    const commitmentsAfterUiCreate = await responseJson<{
      commitments: Array<IdRow & { egcs_fc_status: string, egcs_fc_type: string | number }>
    }>(commitmentsAfterUiCreateResponse)
    const commitment = commitmentsAfterUiCreate.commitments.find(item => !existingCommitmentIds.has(String(item.id)))
    expect(commitment).toBeTruthy()
    const commitmentId = String(commitment!.id)
    expect(String(commitment!.egcs_fc_type)).toBe(commitmentType)
    expect(String(commitment!.egcs_fc_status)).toBe(draftStatusId)

    await completeEntity(page, 'fundingcaseagreementcommitment', commitmentId, 'Lifecycle test commitment completion.')

    const approvalPage = await browser.newPage()
    await login(approvalPage, 'user11@example.com', 'password123')
    await approveAllSteps(approvalPage, 'fundingcaseagreementcommitment', commitmentId)

    const approvedCommitmentResponse = await page.request.get(`/api/agreements/${AGREEMENT_ID}/commitments/${commitmentId}`)
    await expectOk(approvedCommitmentResponse, 'Fetch approved generated commitment')
    const approvedCommitment = await responseJson<IdRow & {
      egcs_fc_status: string
      egcs_fc_active: boolean
      lines: Array<IdRow & { egcs_fc_amount: number | string, fiscal_year_display: string }>
    }>(approvedCommitmentResponse)
    expect(String(approvedCommitment.egcs_fc_status)).toBe(String(approvedStatusId))
    expect(approvedCommitment.egcs_fc_active).toBe(true)
    expect(approvedCommitment.lines.length).toBeGreaterThan(0)

    const budgetResponse = await page.request.get(`/api/agreements/${AGREEMENT_ID}/budget-overview`)
    await expectOk(budgetResponse, 'Fetch agreement budget')
    const budgetPayload = await responseJson<{
      fiscalYears: Array<IdRow & { fiscal_year_display: string }>
      lineItems: Array<IdRow & { fiscal_year_id: string | number }>
    }>(budgetResponse)
    const targetBudgetYear = [...allocationPayload.budgetYears]
      .map(year => ({
        ...year,
        remaining: Number(year.program_funding) - allocationMappings
          .filter(mapping => mapping.streamBudgetId === String(year.stream_budget_id))
          .reduce((sum, mapping) => sum + (paidByYearAndChart.get(`${String(year.id)}:${mapping.streamCommitmentId}`) ?? 0), 0)
      }))
      .sort((left, right) => right.remaining - left.remaining)[0]
    expect(targetBudgetYear?.remaining).toBeGreaterThan(0)
    const fundedCommitmentLine = approvedCommitment.lines.find(line =>
      line.fiscal_year_display === targetBudgetYear?.fiscal_year_display
      && Number(line.egcs_fc_amount) > 0
    )
    const fiscalYearId = String(budgetPayload.fiscalYears.find(year =>
      year.fiscal_year_display === fundedCommitmentLine?.fiscal_year_display
    )?.id ?? '')
    const budgetLineItemId = String(
      budgetPayload.lineItems.find(item => String(item.fiscal_year_id) === fiscalYearId)?.id ?? ''
    )
    expect(fiscalYearId).not.toBe('')
    expect(budgetLineItemId).not.toBe('')
    const forecastMonthlyAmount = roundCurrency(targetBudgetYear!.remaining / 3)
    expect(forecastMonthlyAmount).toBeGreaterThan(0)

    const forecastResponse = await page.request.post(`/api/agreements/${AGREEMENT_ID}/forecasts`, {
      data: {
        egcs_fc_fiscalyear: fiscalYearId
      }
    })
    await expectOk(forecastResponse, 'Create forecast')
    const forecast = await responseJson<IdRow>(forecastResponse)
    const forecastId = String(forecast.id)

    for (const month of [0, 1, 2]) {
      const lineResponse = await page.request.post(`/api/agreements/${AGREEMENT_ID}/forecast-line-items`, {
        data: {
          egcs_fc_agreementforecast: forecastId,
          egcs_fc_fundingagreementbudgetlineitem: budgetLineItemId,
          egcs_fc_month: month,
          egcs_fc_amount: forecastMonthlyAmount,
          egcs_fc_currency: 'cad',
          egcs_fc_version: 0,
          egcs_fc_status: String(inProgressStatusId)
        }
      })
      await expectOk(lineResponse, `Create forecast line ${month}`)
    }

    await completeEntity(page, 'fundingcaseforecast', forecastId, 'Lifecycle test forecast completion.')
    await approveAllSteps(approvalPage, 'fundingcaseforecast', forecastId)

    const initialAdvanceCalculation = await calculateAdvance(page, commitmentType, fiscalYearId, 2)
    if (initialAdvanceCalculation.suggestedAmount <= 0) {
      throw new Error(`Expected a positive calculated advance: ${JSON.stringify(initialAdvanceCalculation)}`)
    }
    const commitmentBalance = roundCurrency(approvedCommitment.lines.filter(
      line => line.fiscal_year_display === fundedCommitmentLine?.fiscal_year_display
    ).reduce(
      (total, line) => total + Number(line.egcs_fc_amount),
      0
    ))
    const initialAdvanceAmount = Math.min(initialAdvanceCalculation.suggestedAmount, commitmentBalance)
    expect(initialAdvanceAmount).toBeGreaterThan(0)

    const paymentsBeforeUiCreateResponse = await page.request.get(`/api/agreements/${AGREEMENT_ID}/payments-overview`)
    await expectOk(paymentsBeforeUiCreateResponse, 'List payments before UI creation')
    const paymentsBeforeUiCreate = await responseJson<{ payments: IdRow[] }>(paymentsBeforeUiCreateResponse)
    const existingPaymentIds = new Set(paymentsBeforeUiCreate.payments.map(payment => String(payment.id)))

    await page.goto(`/en/agreements/${AGREEMENT_ID}`)
    await page.getByRole('tab', { name: 'Payments' }).click()
    await page.getByRole('button', { name: 'Add Payment', exact: true }).click()
    const paymentDialog = page.getByRole('dialog', { name: 'Add Payment' })
    const lookupButtons = paymentDialog.locator('button[aria-label="Show popup"]')
    await lookupButtons.nth(0).click()
    await page.getByRole('option', { name: /Commitment/ }).first().click()
    await lookupButtons.nth(1).click()
    await page.getByRole('option', { name: targetBudgetYear!.fiscal_year_display, exact: true }).click()
    const selectButtons = paymentDialog.getByRole('combobox')
    await selectButtons.nth(0).click()
    await page.getByRole('option', { name: 'Advance', exact: true }).click()
    await selectButtons.nth(2).click()
    await page.getByRole('option', { name: 'Apr', exact: true }).click()
    await selectButtons.nth(3).click()
    await page.getByRole('option', { name: 'Jun', exact: true }).click()
    await expect(paymentDialog.getByText('Automated payment ceiling', { exact: true })).toBeVisible()
    const amountInput = paymentDialog.getByRole('spinbutton')
    const readRenderedAmount = async () => Number((await amountInput.inputValue()).replace(/[^0-9.-]/g, ''))
    await expect.poll(readRenderedAmount).toBeGreaterThan(0)
    expect(await readRenderedAmount()).toBe(initialAdvanceAmount)
    await paymentDialog.getByRole('textbox', { name: 'Comment' }).fill(
      'Lifecycle test advance payment created through the rendered UI.'
    )
    await paymentDialog.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(paymentDialog).toBeHidden()

    const paymentsAfterUiCreateResponse = await page.request.get(`/api/agreements/${AGREEMENT_ID}/payments-overview`)
    await expectOk(paymentsAfterUiCreateResponse, 'List payments after UI creation')
    const paymentsAfterUiCreate = await responseJson<{ payments: Array<IdRow & { egcs_fc_status: string }> }>(paymentsAfterUiCreateResponse)
    const advancePayment = paymentsAfterUiCreate.payments.find(payment => !existingPaymentIds.has(String(payment.id)))
    expect(advancePayment).toBeTruthy()
    const advancePaymentId = String(advancePayment!.id)
    const advancePaymentDetailResponse = await page.request.get(`/api/agreements/${AGREEMENT_ID}/payments/${advancePaymentId}`)
    await expectOk(advancePaymentDetailResponse, 'Fetch generated advance payment')
    const advancePaymentDetail = await responseJson<IdRow & {
      egcs_fc_status: string
      egcs_fc_fundingagreementcommitment: string | number
      lines: IdRow[]
    }>(advancePaymentDetailResponse)
    expect(String(advancePaymentDetail.egcs_fc_fundingagreementcommitment)).toBe(commitmentId)
    expect(String(advancePaymentDetail.egcs_fc_status)).toBe(draftStatusId)
    expect(advancePaymentDetail.lines.length).toBeGreaterThan(0)

    await completeEntity(page, 'fundingcasepayment', advancePaymentId, 'Lifecycle test advance payment completion.')
    await approveAllSteps(approvalPage, 'fundingcasepayment', advancePaymentId)

    await approvalPage.close()

    await page.goto(`/en/agreements/${AGREEMENT_ID}`)
    await page.getByRole('tab', { name: 'Payments' }).click()
    await expect(page.getByRole('link', { name: 'Advance' }).first()).toBeVisible()
  })

  test('refuses stream activation with an actionable list of missing holdback basis codes', async ({ page }) => {
    await login(page, 'root@example.com', 'password123')

    const enableAgencyResponse = await page.request.patch(`/api/extensions/agency/${AGENCY_ID}`, {
      data: { extensionKey: AUTOMATED_PAYMENTS_EXTENSION_KEY, enabled: true }
    })
    await expectOk(enableAgencyResponse, 'Enable automated payments for activation validation')

    const disableStreamResponse = await page.request.patch(`/api/extensions/streams/${STREAM_ID}`, {
      data: { extensionKey: AUTOMATED_PAYMENTS_EXTENSION_KEY, enabled: false, config: {} }
    })
    await expectOk(disableStreamResponse, 'Disable automated payments before activation validation')

    const agreementResponse = await page.request.get(`/api/agreements/${AGREEMENT_ID}`)
    await expectOk(agreementResponse, 'Resolve automated-payment stream program')
    const agreement = await responseJson<{ program_id: string }>(agreementResponse)

    const basesResponse = await page.request.get(
      `/api/transfer-payments/${agreement.program_id}/streams/${STREAM_ID}/holdback-bases?page=1&limit=20`
    )
    await expectOk(basesResponse, 'List stream holdback bases')
    const bases = await responseJson<{
      items: Array<{ id: string; egcs_ay_languageindependentcode: string }>
    }>(basesResponse)
    const finalFiscalYearBasis = bases.items.find(
      item => item.egcs_ay_languageindependentcode === 'final-fiscal-year'
    )
    const ensuredBasis = finalFiscalYearBasis
      ?? await ensureStreamHoldbackBasis(page, agreement.program_id, 'final-fiscal-year')

    const deleteBasisResponse = await page.request.delete(
      `/api/transfer-payments/${agreement.program_id}/streams/${STREAM_ID}/holdback-bases/${ensuredBasis.id}`
    )
    await expectOk(deleteBasisResponse, 'Delete required final-fiscal-year holdback basis')

    const activationResponse = await page.request.patch(`/api/extensions/streams/${STREAM_ID}`, {
      data: {
        extensionKey: AUTOMATED_PAYMENTS_EXTENSION_KEY,
        enabled: true,
        config: { enabledPaymentTypes: ['advance', 'reimbursement'] }
      }
    })
    expect(activationResponse.status()).toBe(400)
    const activationError = await responseJson<{
      data: {
        code: string
        message: string
        details: Array<{ path: string; message: string }>
      }
    }>(activationResponse)
    expect(activationError.data.code).toBe('GCS_AUTOMATED_PAYMENTS_MISSING_HOLDBACK_BASES')
    expect(activationError.data.message).toContain('final-fiscal-year')
    expect(activationError.data.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'holdbackBases' })
    ]))

    await ensureStreamHoldbackBasis(page, agreement.program_id, 'final-fiscal-year')
  })
})
