import { expect, test, type APIResponse, type Page } from '@playwright/test'
import { addAutomatedPaymentMoney, subtractAutomatedPaymentMoney, parseAutomatedPaymentMoney, type AutomatedPaymentCalculationResult } from '../../shared/automated-payments'
import { deleteUnsubmittedCommitmentDrafts, postNegativeCorrection } from './correction-fixture'
import { createPaymentAuditRecipient, createPaymentLifecycleAuditRecorder, resolvePaymentAuditPayee, runPaymentAccuracyJourney, selectPaymentAuditPayee, shiftPaymentAuditMoney } from './payment-accuracy-journey'
import { runPaymentCurrencyJourney } from './payment-currency-journey'
import { runPaymentEmptyFinalFiscalYearJourney } from './payment-empty-final-fy-journey'

const baseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000'

test.use({ actionTimeout: 20_000 })

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
    egcs_fc_amount: string
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

type PaymentCalculationPayload = AutomatedPaymentCalculationResult

const AUTOMATED_PAYMENTS_EXTENSION_KEY = 'gcs-automated-payments'
const OUTCOME_ALLOCATION_EXTENSION_KEY = 'gcs-outcome-cost-allocation'

type ManagedAgreementTarget = {
  agencyId: string
  agreementId: string
  programId: string
  streamId: string
}

let target: ManagedAgreementTarget

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

// Exercise the configured review and recommendation gates before the final Payment approval.
const finalizeSourcePayment = async (page: Page, approver: Page, paymentId: string) => {
  type Recommendation = { id: string; runtimeState: string; egcs_cn_revision: number;
    egcs_cn_definition: { sections: Array<{ subSections: Array<{ questions: Array<{ key: string;
      type: string; required: boolean; isResult: boolean; options?: Array<{ key: string; outcome?: string }> }> }> }> } }
  type Runtime = { current: { runtimeState: string } | null;
    reviews: Array<{ id: string; egcs_cn_reviewtype: string }>; recommendations: Recommendation[] }
  const runtimeUrl = `/api/workflows/runtime?entityType=fundingcasepayment&entityId=${paymentId}&purpose=approval_submission`
  const readRuntime = async () => {
    const response = await page.request.get(runtimeUrl)
    await expectOk(response, 'Read source Payment workflow')
    return await responseJson<Runtime>(response)
  }
  const checklist = (await readRuntime()).reviews.find(review => review.egcs_cn_reviewtype === 'checklist')
  if (checklist) {
    await page.goto(`/en/checklists/${checklist.id}`)
    const answers = page.getByRole('radio', { name: 'Pass', exact: true })
    await expect(answers.first()).toBeVisible()
    for (let index = 0; index < await answers.count(); index += 1) await answers.nth(index).check()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByRole('button', { name: /^Additional Review/ }).click()
    await page.getByLabel('Completion Comment', { exact: true }).fill('Verified financial evidence for the shared capacity journey.')
    await page.getByRole('button', { name: 'Complete Review', exact: true }).click()
  }
  for (let index = 0; index < 5; index += 1) {
    const recommendation = (await readRuntime()).recommendations.find(item => item.runtimeState === 'active')
    if (!recommendation) break
    const responses = recommendation.egcs_cn_definition.sections.flatMap(section => section.subSections)
      .flatMap(section => section.questions).filter(question => question.required).map(question => ({
        questionKey: question.key,
        value: question.type === 'radio'
          ? (question.isResult ? question.options!.find(option => option.outcome === 'recommended')!.key : question.options![0]!.key)
          : 'Financial evidence verified for the shared capacity journey.'
      }))
    const recommendationUrl = `/api/workflows/recommendation?entityType=fundingcasepayment&entityId=${paymentId}&purpose=approval_submission`
    await expectOk(await page.request.put(recommendationUrl, { data: { revision: recommendation.egcs_cn_revision, responses } }), 'Save Payment recommendation')
    const refreshed = (await readRuntime()).recommendations.find(item => item.id === recommendation.id)!
    await expectOk(await page.request.post(recommendationUrl.replace('/recommendation?', '/recommendation/submit?'), {
      data: { revision: refreshed.egcs_cn_revision, responses }
    }), 'Submit Payment recommendation')
    await approveAllSteps(page, 'commonrecommendation', recommendation.id)
    await approveAllSteps(approver, 'commonrecommendation', recommendation.id)
  }
  await approveAllSteps(page, 'fundingcasepayment', paymentId)
  await approveAllSteps(approver, 'fundingcasepayment', paymentId)
  expect((await readRuntime()).current?.runtimeState).toBe('approved')
}

const calculateAdvance = async (
  page: Page,
  commitmentType: string,
  fiscalYearId: string,
  periodEnd: number,
  paymentAmount = 0
) => {
  const response = await page.request.post(
    `/api/extensions/${AUTOMATED_PAYMENTS_EXTENSION_KEY}/agreements/${target.agreementId}/calculate-payment`,
    {
      data: {
        egcs_fc_commitmenttype: commitmentType,
        egcs_fc_currency: 'cad',
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

const openAgreementPaymentsTab = async (page: Page, agreementId: string) => {
  await page.goto(`/en/agreements/${agreementId}`)
  await page.waitForURL(url => url.searchParams.get('section') === 'general')
  const tab = page.getByRole('tab', { name: 'Payments', exact: true })
  await expect(tab).toBeEnabled()
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}

const ensureStreamHoldbackBasis = async (
  page: Page,
  programId: string,
  basis: string
): Promise<IdRow> => {
  const streamBasesResponse = await page.request.get(
    `/api/transfer-payments/${programId}/streams/${target.streamId}/holdback-bases?page=1&limit=100`
  )
  await expectOk(streamBasesResponse, 'List stream holdback bases')
  const streamBases = await responseJson<{
    items: Array<IdRow & { egcs_ay_holdbackbasis: string }>
  }>(streamBasesResponse)
  const existing = streamBases.items.find(item => item.egcs_ay_holdbackbasis === basis)
  if (existing) return existing

  const agencyBasesResponse = await page.request.get(`/api/agency/${target.agencyId}/holdback-bases?page=1&limit=100`)
  await expectOk(agencyBasesResponse, 'List agency holdback bases')
  const agencyBases = await responseJson<{
    items: Array<IdRow & {
      egcs_ay_holdbackbasis: string
      egcs_ay_name_en: string
      egcs_ay_name_fr: string
    }>
  }>(agencyBasesResponse)
  const agencyBasis = agencyBases.items.find(item => item.egcs_ay_holdbackbasis === basis)
  if (!agencyBasis) throw new Error(`Agency holdback basis ${basis} is unavailable.`)

  const createResponse = await page.request.post(
    `/api/transfer-payments/${programId}/streams/${target.streamId}/holdback-bases`,
    {
      data: {
        egcs_tp_agencyholdback: String(agencyBasis.id)
      }
    }
  )
  await expectOk(createResponse, `Create stream holdback basis ${basis}`)
  return await responseJson<IdRow>(createResponse)
}

const ensureAllocationApprovalWorkflow = async (page: Page, programId: string): Promise<void> => {
  const statusesResponse = await page.request.get('/api/statuses')
  await expectOk(statusesResponse, 'List lifecycle statuses')
  const statuses = (await responseJson<StatusRow[]>(statusesResponse))
    .filter(status => status.agencyId === target.agencyId)
  const draft = statuses.find(status => status.isDraft)
  const pending = statuses.find(status => status.nameEn === 'Pending Approval')
  const approved = statuses.find(status => status.nameEn === 'Approved')
  const denied = statuses.find(status => status.nameEn === 'Denied')
  if (!draft || !pending || !approved || !denied) {
    throw new Error('Required seeded lifecycle statuses are unavailable.')
  }

  const existingResponse = await page.request.get(
    `/api/transfer-payments/${programId}/streams/${target.streamId}/workflows?page=1&limit=100`
  )
  await expectOk(existingResponse, 'List allocation Workflows')
  const existing = await responseJson<{ items: Array<{ id: string | number, egcs_cn_entitytype: string, publicationState: string }> }>(existingResponse)
  if (existing.items.some(item =>
    item.egcs_cn_entitytype === `${OUTCOME_ALLOCATION_EXTENSION_KEY}:allocation-version`
    && item.publicationState === 'published'
  )) return

  const templatesResponse = await page.request.get(
    `/api/agency/${target.agencyId}/approval-templates?page=1&limit=100`
  )
  await expectOk(templatesResponse, 'List Approval Templates')
  const templates = await responseJson<{ items: Array<{ id: string | number, publicationState: string }> }>(templatesResponse)
  const template = templates.items.find(item => item.publicationState === 'published')
  if (!template) throw new Error('A published Agency Approval Template is required.')

  const createResponse = await page.request.post(`/api/agency/${target.agencyId}/workflows`, {
    data: {
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
    `/api/agency/${target.agencyId}/workflows/${workflowId}/members`,
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
    `/api/agency/${target.agencyId}/workflows/${workflowId}/publish`
  )
  await expectOk(publishResponse, 'Publish allocation Workflow')
  const linkResponse = await page.request.post(`/api/transfer-payments/${programId}/streams/${target.streamId}/workflows`, {
    data: { egcs_tp_workflow: workflowId }
  })
  await expectOk(linkResponse, 'Link allocation Workflow to Stream')
}

test.describe.serial('Automated payment lifecycle', () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage()
    try {
      await login(page, 'root@example.com', 'password123')
      const agreementsResponse = await page.request.get(
        '/api/agreements?page=1&limit=10&search=NCIA-26-001'
      )
      await expectOk(agreementsResponse, 'Discover the managed automated-payment agreement')
      const agreements = await responseJson<{
        items: Array<{
          id: string | number
          egcs_fc_agreementnumber: string
        }>
      }>(agreementsResponse)
      const matches = agreements.items.filter(item =>
        item.egcs_fc_agreementnumber === 'NCIA-26-001')
      if (matches.length !== 1) {
        throw new Error(`Expected one managed automated-payment agreement, found ${matches.length}.`)
      }
      const agreementId = String(matches[0]!.id)
      const detailResponse = await page.request.get(`/api/agreements/${agreementId}`)
      await expectOk(detailResponse, 'Resolve the managed automated-payment agreement ownership')
      const detail = await responseJson<{
        agency_id: string | number
        egcs_fc_transferpaymentstream: string | number
        program_id: string | number
      }>(detailResponse)
      target = {
        agencyId: String(detail.agency_id),
        agreementId,
        programId: String(detail.program_id),
        streamId: String(detail.egcs_fc_transferpaymentstream)
      }
    } finally {
      await page.close()
    }
  })
  test('keeps calculator UI and server handler unavailable while disabled', async ({ page }) => {
    test.setTimeout(90_000)
    await login(page, 'root@example.com', 'password123')

    const disableAgencyResponse = await page.request.patch(`/api/extensions/agency/${target.agencyId}`, {
      data: { extensionKey: AUTOMATED_PAYMENTS_EXTENSION_KEY, enabled: false }
    })
    await expectOk(disableAgencyResponse, 'Disable automated payments for agency')

    const disabledHandlerResponse = await page.request.post(
      `/api/extensions/${AUTOMATED_PAYMENTS_EXTENSION_KEY}/agreements/${target.agreementId}/calculate-payment`,
      { data: {} }
    )
    expect([403, 404]).toContain(disabledHandlerResponse.status())

    await openAgreementPaymentsTab(page, target.agreementId)
    await page.getByRole('button', { name: 'Add Payment', exact: true }).click()
    const paymentDialog = page.getByRole('dialog', { name: 'Add Payment' })
    await expect(paymentDialog).toBeVisible()
    await expect(paymentDialog.getByText('Automated payment ceiling', { exact: true })).toHaveCount(0)
  })

  test('runs allocation, commitment, forecast, and automatically calculated advance payment', async ({ page, browser }, testInfo) => {
    test.setTimeout(180_000)
    await login(page, 'root@example.com', 'password123')

    const agreementResponse = await page.request.get(`/api/agreements/${target.agreementId}`)
    await expectOk(agreementResponse, 'Resolve automated-payment stream program')
    const agreement = await responseJson<{ program_id: string }>(agreementResponse)
    const recipient = await createPaymentAuditRecipient(page, target.agencyId)
    const proponentTypesResponse = await page.request.get(
      `/api/agreements/lookups/proponent-types?stream_id=${target.streamId}&proponent_id=${recipient.id}`
    )
    await expectOk(proponentTypesResponse, 'Resolve isolated payee types')
    const proponentTypes = await responseJson<{ items: IdRow[] }>(proponentTypesResponse)
    expect(proponentTypes.items.length).toBeGreaterThan(0)
    await expectOk(await page.request.post(`/api/agreements/${target.agreementId}/applicant-recipients`, { data: {
      egcs_fc_applicantrecipient: recipient.id,
      egcs_fc_applicantrecipientsubtype: String(proponentTypes.items[0]!.id),
      egcs_fc_agencyfinancialid: recipient.egcs_fc_agencyfinancialid
    } }), 'Link isolated payment payee')
    const payee = await resolvePaymentAuditPayee(page, target.agreementId, String(recipient.id))

    const statusesResponse = await page.request.get('/api/statuses')
    await expectOk(statusesResponse, 'Resolve draft payment status')
    const statusCatalog = await responseJson<StatusRow[]>(statusesResponse)
    const draftStatusIds = new Set(statusCatalog
      .filter(status => status.agencyId === target.agencyId && status.isDraft)
      .map(status => String(status.id)))
    const draftStatusId = [...draftStatusIds][0]
    const approvedStatusId = statusCatalog
      .find(status => status.agencyId === target.agencyId && status.nameEn === 'Approved')?.id
    const inProgressStatusId = statusCatalog
      .find(status => status.agencyId === target.agencyId && status.nameEn === 'In Progress')?.id
    if (!draftStatusId || !approvedStatusId || !inProgressStatusId) {
      throw new Error('Required seeded status identities are unavailable.')
    }

    const seededPaymentsResponse = await page.request.get(`/api/agreements/${target.agreementId}/payments-overview`)
    await expectOk(seededPaymentsResponse, 'Fetch seeded payments')
    const seededPayments = await responseJson<{ payments: Array<IdRow & { egcs_fc_status: string }> }>(seededPaymentsResponse)
    for (const payment of seededPayments.payments.filter(item => draftStatusIds.has(String(item.egcs_fc_status)))) {
      const deleteResponse = await page.request.delete(`/api/agreements/${target.agreementId}/payments/${payment.id}`)
      if (deleteResponse.status() !== 409) {
        await expectOk(deleteResponse, `Delete seeded draft payment ${payment.id}`)
      }
    }

    const retainedPaymentsResponse = await page.request.get(`/api/agreements/${target.agreementId}/payments-overview`)
    await expectOk(retainedPaymentsResponse, 'Fetch retained seeded payments')
    const retainedPayments = await responseJson<{ payments: IdRow[] }>(retainedPaymentsResponse)
    await deleteUnsubmittedCommitmentDrafts(page, target)
    const paidByYearAndChart = new Map<string, number>()
    for (const payment of retainedPayments.payments) {
      const paymentResponse = await page.request.get(`/api/agreements/${target.agreementId}/payments/${payment.id}`)
      await expectOk(paymentResponse, `Read seeded payment ${payment.id}`)
      const paymentDetail = await responseJson<PaymentCoverageDetail>(paymentResponse)
      const commitmentResponse = await page.request.get(
        `/api/agreements/${target.agreementId}/commitments/${paymentDetail.egcs_fc_fundingagreementcommitment}`
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

    const enableResponse = await page.request.patch(`/api/extensions/agency/${target.agencyId}`, {
      data: {
        extensionKey: AUTOMATED_PAYMENTS_EXTENSION_KEY,
        enabled: true
      }
    })
    await expectOk(enableResponse, 'Enable automated payments for agency')

    const allocationAgencyResponse = await page.request.patch(`/api/extensions/agency/${target.agencyId}`, {
      data: { extensionKey: OUTCOME_ALLOCATION_EXTENSION_KEY, enabled: true }
    })
    await expectOk(allocationAgencyResponse, 'Enable outcome allocation for agency')
    const allocationMigrationResponse = await page.request.post(`/api/extensions/agency/${target.agencyId}/migrations`, {
      data: { extensionKey: OUTCOME_ALLOCATION_EXTENSION_KEY }
    })
    await expectOk(allocationMigrationResponse, 'Apply outcome allocation migrations')

    await ensureStreamHoldbackBasis(page, agreement.program_id, 'finalfiscal')

    const streamConfigResponse = await page.request.patch(`/api/extensions/streams/${target.streamId}`, {
      data: {
        extensionKey: AUTOMATED_PAYMENTS_EXTENSION_KEY,
        enabled: true,
        config: {
          enabledPaymentTypes: ['advance', 'reimbursement']
        }
      }
    })
    await expectOk(streamConfigResponse, 'Enable automated payments for stream')

    const allocationEnableResponse = await page.request.patch(`/api/extensions/streams/${target.streamId}`, {
      data: {
        extensionKey: OUTCOME_ALLOCATION_EXTENSION_KEY,
        enabled: true
      }
    })
    await expectOk(allocationEnableResponse, 'Enable outcome allocation for stream')

    const allocationResponse = await page.request.get(
      `/api/extensions/${OUTCOME_ALLOCATION_EXTENSION_KEY}/agreements/${target.agreementId}/allocations`
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

    const allocationConfigResponse = await page.request.patch(`/api/extensions/streams/${target.streamId}`, {
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
      `/api/extensions/${OUTCOME_ALLOCATION_EXTENSION_KEY}/agreements/${target.agreementId}/allocation-versions`
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
      `/api/extensions/${OUTCOME_ALLOCATION_EXTENSION_KEY}/agreements/${target.agreementId}/allocations`,
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

    const commitmentsBeforeUiCreateResponse = await page.request.get(`/api/agreements/${target.agreementId}/commitments-overview`)
    await expectOk(commitmentsBeforeUiCreateResponse, 'List commitments before UI creation')
    const commitmentsBeforeUiCreate = await responseJson<{ commitments: IdRow[] }>(commitmentsBeforeUiCreateResponse)
    const existingCommitmentIds = new Set(commitmentsBeforeUiCreate.commitments.map(commitment => String(commitment.id)))

    await page.goto(`/en/agreements/${target.agreementId}`)
    await page.waitForURL(url => url.searchParams.get('section') === 'general')
    await page.getByRole('tab', { name: 'Commitments' }).click()
    await expect(page.getByRole('tab', { name: 'Commitments', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('button', { name: 'Add commitment', exact: true }).click()
    const commitmentDialog = page.getByRole('dialog', { name: 'Add commitment' })
    await expect(commitmentDialog.getByText('Commitment', { exact: true })).toBeVisible()
    await commitmentDialog.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(commitmentDialog).toBeHidden()

    const commitmentsAfterUiCreateResponse = await page.request.get(`/api/agreements/${target.agreementId}/commitments-overview`)
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

    const approvedCommitmentResponse = await page.request.get(`/api/agreements/${target.agreementId}/commitments/${commitmentId}`)
    await expectOk(approvedCommitmentResponse, 'Fetch approved generated commitment')
    const approvedCommitment = await responseJson<IdRow & {
      egcs_fc_status: string
      egcs_fc_active: boolean
      lines: Array<IdRow & { egcs_fc_amount: number | string, fiscal_year_display: string }>
    }>(approvedCommitmentResponse)
    expect(String(approvedCommitment.egcs_fc_status)).toBe(String(approvedStatusId))
    expect(approvedCommitment.egcs_fc_active).toBe(true)
    expect(approvedCommitment.lines.length).toBeGreaterThan(0)

    const budgetResponse = await page.request.get(`/api/agreements/${target.agreementId}/budget-overview`)
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
    const recordCheckpoint = createPaymentLifecycleAuditRecorder(page, testInfo, target)
    const forecastMonthlyAmount = roundCurrency(targetBudgetYear!.remaining / 3)
    expect(forecastMonthlyAmount).toBeGreaterThan(0)

    const forecastResponse = await page.request.post(`/api/agreements/${target.agreementId}/forecasts`, {
      data: {
        egcs_fc_fiscalyear: fiscalYearId
      }
    })
    await expectOk(forecastResponse, 'Create forecast')
    const forecast = await responseJson<IdRow>(forecastResponse)
    const forecastId = String(forecast.id)

    for (const month of [0, 1, 2]) {
      const lineResponse = await page.request.post(`/api/agreements/${target.agreementId}/forecast-line-items`, {
        data: {
          egcs_fc_agreementforecast: forecastId,
          egcs_fc_fundingagreementbudgetlineitem: budgetLineItemId,
          egcs_fc_month: month,
          egcs_fc_amount: forecastMonthlyAmount,
          egcs_fc_totalamount: forecastMonthlyAmount,
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
    await recordCheckpoint({ scenario: 'lifecycle-01-initial-advance', fiscalYearId, commitmentType, periodEnd: 2,
      calculation: initialAdvanceCalculation, note: 'Observed seeded baseline; controlled ledgers independently verify the complete payment formula.' })
    if (Number(initialAdvanceCalculation.suggestedAmount) <= 0) {
      throw new Error(`Expected a positive calculated advance: ${JSON.stringify(initialAdvanceCalculation)}`)
    }
    const commitmentBalance = roundCurrency(approvedCommitment.lines.filter(
      line => line.fiscal_year_display === fundedCommitmentLine?.fiscal_year_display
    ).reduce(
      (total, line) => total + Number(line.egcs_fc_amount),
      0
    ))
    const initialAdvanceAmount = Math.min(Number(initialAdvanceCalculation.suggestedAmount), commitmentBalance)
    expect(initialAdvanceAmount).toBeGreaterThan(0)

    const paymentsBeforeUiCreateResponse = await page.request.get(`/api/agreements/${target.agreementId}/payments-overview`)
    await expectOk(paymentsBeforeUiCreateResponse, 'List payments before UI creation')
    const paymentsBeforeUiCreate = await responseJson<{ payments: IdRow[] }>(paymentsBeforeUiCreateResponse)
    const existingPaymentIds = new Set(paymentsBeforeUiCreate.payments.map(payment => String(payment.id)))

    const aboveCeiling = await page.request.post(`/api/agreements/${target.agreementId}/payments`, { data: {
      egcs_fc_applicantrecipient: payee.id,
      egcs_fc_commitmenttype: commitmentType,
      egcs_fc_fiscalyear: fiscalYearId,
      egcs_fc_paymenttype: 'advance',
      egcs_fc_periodstart: 0,
      egcs_fc_periodend: 2,
      egcs_fc_paymentamount: roundCurrency(Number(initialAdvanceCalculation.ceilingAmount) + 0.01),
      egcs_fc_currency: 'cad',
      extensions: {
        [AUTOMATED_PAYMENTS_EXTENSION_KEY]: { releaseHoldback: false, holdbackReleaseAmount: 0 }
      }
    } })
    const aboveCeilingBody = await aboveCeiling.text()
    expect(aboveCeiling.status(), aboveCeilingBody).toBe(400)
    expect(aboveCeilingBody).toContain('GCS_AUTOMATED_PAYMENTS_AMOUNT_EXCEEDS_CEILING')
    const paymentsAfterRejectedCreate = await responseJson<{ payments: IdRow[] }>(
      await page.request.get(`/api/agreements/${target.agreementId}/payments-overview`)
    )
    expect(paymentsAfterRejectedCreate.payments.map(payment => String(payment.id))).toEqual([...existingPaymentIds])

    await openAgreementPaymentsTab(page, target.agreementId)
    await page.getByRole('button', { name: 'Add Payment', exact: true }).click()
    const paymentDialog = page.getByRole('dialog', { name: 'Add Payment' })
    await selectPaymentAuditPayee(page, paymentDialog, payee)
    await paymentDialog.getByRole('combobox', { name: /^Commitment type/ }).click()
    await page.getByRole('option', { name: /Commitment/ }).first().click()
    await paymentDialog.getByRole('combobox', { name: /^Fiscal year/ }).click()
    await page.getByRole('option', { name: targetBudgetYear!.fiscal_year_display, exact: true }).click()
    await paymentDialog.getByRole('combobox', { name: /^Payment type/ }).click()
    await page.getByRole('option', { name: 'Advance', exact: true }).click()
    await paymentDialog.getByRole('combobox', { name: /^Period start/ }).click()
    await page.getByRole('option', { name: 'Apr', exact: true }).click()
    await paymentDialog.getByRole('combobox', { name: /^Period end/ }).click()
    await page.getByRole('option', { name: 'Jun', exact: true }).click()
    await expect(paymentDialog.getByText('Automated payment ceiling', { exact: true })).toBeVisible()
    const amountInput = paymentDialog.getByRole('textbox', { name: /^Amount/ })
    const readRenderedAmount = async () => Number((await amountInput.inputValue()).replace(/[^0-9.-]/g, ''))
    await expect.poll(readRenderedAmount).toBeGreaterThan(0)
    expect(await readRenderedAmount()).toBe(initialAdvanceAmount)
    await paymentDialog.getByRole('textbox', { name: 'Comment' }).fill(
      'Lifecycle test advance payment created through the rendered UI.'
    )
    await paymentDialog.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(paymentDialog).toBeHidden()

    const paymentsAfterUiCreateResponse = await page.request.get(`/api/agreements/${target.agreementId}/payments-overview`)
    await expectOk(paymentsAfterUiCreateResponse, 'List payments after UI creation')
    const paymentsAfterUiCreate = await responseJson<{ payments: Array<IdRow & { egcs_fc_status: string }> }>(paymentsAfterUiCreateResponse)
    const advancePayment = paymentsAfterUiCreate.payments.find(payment => !existingPaymentIds.has(String(payment.id)))
    expect(advancePayment).toBeTruthy()
    const advancePaymentId = String(advancePayment!.id)
    const advancePaymentDetailResponse = await page.request.get(`/api/agreements/${target.agreementId}/payments/${advancePaymentId}`)
    await expectOk(advancePaymentDetailResponse, 'Fetch generated advance payment')
    const advancePaymentDetail = await responseJson<IdRow & {
      egcs_fc_status: string
      egcs_fc_fundingagreementcommitment: string | number
      lines: IdRow[]
    }>(advancePaymentDetailResponse)
    expect(String(advancePaymentDetail.egcs_fc_fundingagreementcommitment)).toBe(commitmentId)
    expect(String(advancePaymentDetail.egcs_fc_status)).toBe(draftStatusId)
    expect(advancePaymentDetail.lines.length).toBeGreaterThan(0)

    // Finality comes from the configured Workflow's terminal business output.
    const paidStatus = statusCatalog.find(status => status.agencyId === target.agencyId && status.nameEn === 'Paid' && status.terminal)!
    expect(paidStatus).toBeTruthy()
    const workflowListResponse = await page.request.get(`/api/transfer-payments/${target.programId}/streams/${target.streamId}/workflows?page=1&limit=100`)
    await expectOk(workflowListResponse, 'Read Payment Workflow configuration')
    const workflowList = await responseJson<{ items: Array<IdRow & { egcs_tp_workflow: string; egcs_cn_entitytype: string; egcs_cn_purpose: string; publicationState: string }> }>(workflowListResponse)
    const paymentWorkflows = workflowList.items.filter(item => item.egcs_cn_entitytype === 'fundingcasepayment'
      && item.egcs_cn_purpose === 'approval_submission' && item.publicationState === 'published')
    expect(paymentWorkflows.length).toBeGreaterThan(0)
    for (const workflow of paymentWorkflows) {
      const workflowPath = `/api/agency/${target.agencyId}/workflows/${workflow.egcs_tp_workflow}`
      const detailResponse = await page.request.get(workflowPath)
      await expectOk(detailResponse, 'Read final Payment Workflow member')
      const detail = await responseJson<{ members: IdRow[] }>(detailResponse)
      const finalMember = detail.members.at(-1)!
      await expectOk(await page.request.patch(`${workflowPath}/members/${finalMember.id}`, {
        data: { egcs_cn_successstatus: String(paidStatus.id) }
      }), 'Configure terminal Paid output')
      await expectOk(await page.request.post(`${workflowPath}/publish`), 'Publish terminal Payment output')
    }

    await completeEntity(page, 'fundingcasepayment', advancePaymentId, 'Lifecycle test advance payment completion.')
    await finalizeSourcePayment(page, approvalPage, advancePaymentId)

    // The owning extension consumes the host capacity contract as JVs finalize and reverse.
    const beforeJvCalculation = await calculateAdvance(page, commitmentType, fiscalYearId, 2)
    const capacityBefore = beforeJvCalculation.details.find(detail => detail.label === 'commitmentRemaining')!.value
    const junePaidBeforeJv = beforeJvCalculation.details.find(detail => detail.label === 'totalPaymentsToDate')!.value
    await recordCheckpoint({ scenario: 'lifecycle-02-finalized-payment-before-jv', fiscalYearId, commitmentType, periodEnd: 2,
      calculation: beforeJvCalculation, note: 'Finalized source Payment establishes the accounting baseline before signed recoding.' })
    const usersResponse = await page.request.get('/api/users/lookups?status=active&search=root%40example.com')
    await expectOk(usersResponse, 'Find fixture creator')
    const users = await responseJson<{ items: Array<{ id: string; egcs_cn_email: string }> }>(usersResponse)
    const root = users.items.find(user => user.egcs_cn_email === 'root@example.com')!
    const jvRoleResponse = await page.request.post('/api/roles', { data: {
      name_en: `Capacity fixture JV ${advancePaymentId}`, name_fr: `PJ capacité ${advancePaymentId}`,
      agency_id: target.agencyId, transfer_payment_ids: [],
      permissions: [{ subject: 'journal_voucher', access_level: 'contributor' }]
    } })
    await expectOk(jvRoleResponse, 'Grant explicit fixture JV authority')
    const jvRole = await responseJson<IdRow>(jvRoleResponse)
    await expectOk(await page.request.post(`/api/users/${root.id}/assignments`, { data: { user_id: root.id, role_id: String(jvRole.id), agency_id: target.agencyId } }), 'Assign fixture JV role')
    await page.context().clearCookies()
    await login(page, 'root@example.com', 'password123')
    const createJvResponse = await page.request.post('/api/journal-vouchers', { data: {
      egcs_fc_payment: advancePaymentId, egcs_fc_requesteddate: '2026-10-01',
      egcs_fc_narrative_en: 'Verify the shared host capacity service.', egcs_fc_narrative_fr: 'Vérifier le service de capacité commun.'
    } })
    await expectOk(createJvResponse, 'Prepare calculator capacity fixture')
    const jv = await responseJson<IdRow>(createJvResponse)
    const jvDetailResponse = await page.request.get(`/api/journal-vouchers/${jv.id}`)
    await expectOk(jvDetailResponse, 'Read calculator capacity fixture')
    const jvDetail = await responseJson<{ egcs_fc_agencyfiscalyear: string; egcs_fc_lines: Array<{
      egcs_fc_kind: string; egcs_fc_commitmentline: string; egcs_fc_chartofaccount: string; egcs_fc_amount: string
    }> }>(jvDetailResponse)
    const jvAllocations = jvDetail.egcs_fc_lines.filter(line => line.egcs_fc_kind === 'corrected')
    const sourceAllocation = jvAllocations.find(line => BigInt(line.egcs_fc_amount.replace('.', '')) >= BigInt(1000))!
    expect(sourceAllocation).toBeTruthy()
    const chartResponse = await page.request.post(`/api/agency/${target.agencyId}/chart-of-accounts`, { data: {
      egcs_ay_fiscalyear: jvDetail.egcs_fc_agencyfiscalyear,
      egcs_ay_currency: 'cad',
      egcs_ay_accountingdimensions: [{ label_en: 'Account', label_fr: 'Compte', value: `CAP-${jv.id}` }]
    } })
    await expectOk(chartResponse, 'Create an unmatched capacity-fixture coding')
    const chart = await responseJson<IdRow>(chartResponse)
    const linkedResponse = await page.request.post(`/api/transfer-payments/${target.programId}/streams/${target.streamId}/chart-of-accounts`, {
      data: { egcs_tp_agencychartofaccount: String(chart.id) }
    })
    await expectOk(linkedResponse, 'Link capacity-fixture coding')
    const linked = await responseJson<IdRow>(linkedResponse)
    const correctedAllocations = {
      egcs_fc_requesteddate: '2026-10-01',
      egcs_fc_narrative_en: 'Verify the shared host capacity contract.',
      egcs_fc_narrative_fr: 'Vérifier le contrat partagé de capacité du système hôte.',
      egcs_fc_allocations: [
        ...jvAllocations.map(line => ({ egcs_fc_commitmentline: line.egcs_fc_commitmentline,
          egcs_fc_chartofaccount: line.egcs_fc_chartofaccount,
          egcs_fc_amount: line === sourceAllocation ? subtractAutomatedPaymentMoney(parseAutomatedPaymentMoney(line.egcs_fc_amount), parseAutomatedPaymentMoney('10.00')) : line.egcs_fc_amount })),
        { egcs_fc_commitmentline: sourceAllocation.egcs_fc_commitmentline, egcs_fc_chartofaccount: String(linked.id), egcs_fc_amount: '10.00' }
      ]
    }
    const editJvResponse = await page.request.patch(`/api/journal-vouchers/${jv.id}`, { data: correctedAllocations })
    await expectOk(editJvResponse, 'Split the capacity-fixture allocation')
    const readCapacity = async (scenario?: string, expectedCapacity?: string, expectedPaid?: string) => {
      const calculation = await calculateAdvance(page, commitmentType, fiscalYearId, 2)
      if (scenario !== undefined) await recordCheckpoint({ scenario, fiscalYearId, commitmentType, periodEnd: 2, calculation,
        expectedCommitmentCapacity: expectedCapacity, expectedRecordedPaid: expectedPaid,
        note: 'Expected capacity is the observed pre-JV baseline plus independently authored signed adjustments; balanced same-year JVs preserve cumulative recorded paid.' })
      return calculation.details.find(detail => detail.label === 'commitmentRemaining')!.value
    }
    expect(await readCapacity('lifecycle-03-draft-jv-has-no-effect', capacityBefore, junePaidBeforeJv)).toBe(capacityBefore)
    await completeEntity(page, 'fundingcasejournalvoucher', String(jv.id), 'Shared capacity service fixture.')
    expect(await readCapacity('lifecycle-04-successful-jv-frees-ten', shiftPaymentAuditMoney(capacityBefore, '10.00'), junePaidBeforeJv)).toBe(addAutomatedPaymentMoney(parseAutomatedPaymentMoney(capacityBefore), parseAutomatedPaymentMoney('10.00')))
    const reversalResponse = await page.request.post(`/api/journal-vouchers/${jv.id}/reversal`, { data: {
      egcs_fc_requesteddate: '2026-10-01', egcs_fc_narrative_en: 'Restore the calculator baseline.',
      egcs_fc_narrative_fr: 'Rétablir la base du calculateur.'
    } })
    await expectOk(reversalResponse, 'Prepare the capacity-fixture reversal')
    const reversal = await responseJson<IdRow>(reversalResponse)
    expect(await readCapacity('lifecycle-05-draft-reversal-retains-jv', shiftPaymentAuditMoney(capacityBefore, '10.00'), junePaidBeforeJv)).toBe(addAutomatedPaymentMoney(parseAutomatedPaymentMoney(capacityBefore), parseAutomatedPaymentMoney('10.00')))
    await completeEntity(page, 'fundingcasejournalvoucher', String(reversal.id), 'Restore shared capacity baseline.')
    expect(await readCapacity('lifecycle-06-successful-reversal-restores-baseline', capacityBefore, junePaidBeforeJv)).toBe(capacityBefore)

    // The accounting date is October (fiscal period six); earlier June totals retain their historical cutoff.
    const calculationBeforeCorrection = await calculateAdvance(page, commitmentType, fiscalYearId, 6)
    const paidBeforeCorrection = calculationBeforeCorrection.details.find(detail => detail.label === 'totalPaymentsToDate')!.value
    await recordCheckpoint({ scenario: 'lifecycle-07-before-october-correction', fiscalYearId, commitmentType, periodEnd: 6,
      calculation: calculationBeforeCorrection, expectedCommitmentCapacity: capacityBefore, note: 'October cutoff includes the later posted Correction; June cutoff retains its earlier paid totals.' })
    const allocationBeforeCorrection = await responseJson<unknown>(await page.request.get(`/api/extensions/${OUTCOME_ALLOCATION_EXTENSION_KEY}/agreements/${target.agreementId}/allocations`))
    const postedCorrection = await postNegativeCorrection(page, approvalPage, target, commitmentId, advancePaymentId)
    const calculationAfterCorrection = await calculateAdvance(page, commitmentType, fiscalYearId, 6)
    await recordCheckpoint({ scenario: 'lifecycle-08-posted-negative-correction', fiscalYearId, commitmentType, periodEnd: 6,
      calculation: calculationAfterCorrection, expectedRecordedPaid: shiftPaymentAuditMoney(paidBeforeCorrection, '-1.00'),
      expectedCommitmentCapacity: shiftPaymentAuditMoney(capacityBefore, '1.00'), note: 'A separate posted -$1 Correction reduces corrected recorded paid and restores $1 capacity; source cash is immutable.' })
    expect(calculationAfterCorrection.details.find(detail => detail.label === 'totalPaymentsToDate')!.value)
      .toBe(subtractAutomatedPaymentMoney(parseAutomatedPaymentMoney(paidBeforeCorrection), parseAutomatedPaymentMoney('1.00')))
    const capacityAfterCorrection = addAutomatedPaymentMoney(parseAutomatedPaymentMoney(capacityBefore), parseAutomatedPaymentMoney('1.00'))
    expect(await readCapacity('lifecycle-09-june-cutoff-after-correction', shiftPaymentAuditMoney(capacityBefore, '1.00'), junePaidBeforeJv)).toBe(capacityAfterCorrection)
    expect(await responseJson(await page.request.get(`/api/extensions/${OUTCOME_ALLOCATION_EXTENSION_KEY}/agreements/${target.agreementId}/allocations`))).toEqual(allocationBeforeCorrection)
    await page.goto(`/en/agreements/${target.agreementId}/corrections/${postedCorrection.id}`)
    await expect(page.getByRole('tab', { name: 'Correction Completion', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('posted-correction-automated-paid-to-date.png'), fullPage: true })

    // Spend the newly restored coding capacity through the other extension's real Payment generator.
    const replacementResponse = await page.request.post('/api/journal-vouchers', { data: {
      egcs_fc_payment: advancePaymentId, egcs_fc_replacementof: String(reversal.id),
      egcs_fc_requesteddate: '2026-10-01', egcs_fc_narrative_en: 'Prepare the replacement coding correction.'
    } })
    await expectOk(replacementResponse, 'Prepare replacement after successful reversal')
    const replacement = await responseJson<IdRow>(replacementResponse)
    await expectOk(await page.request.patch(`/api/journal-vouchers/${replacement.id}`, { data: correctedAllocations }), 'Save replacement splits')
    await completeEntity(page, 'fundingcasejournalvoucher', String(replacement.id), 'Replacement capacity fixture.')
    const payableCapacity = addAutomatedPaymentMoney(parseAutomatedPaymentMoney(capacityAfterCorrection), parseAutomatedPaymentMoney('10.00'))
    expect(await readCapacity('lifecycle-10-successful-replacement', shiftPaymentAuditMoney(capacityBefore, '11.00'), junePaidBeforeJv)).toBe(payableCapacity)
    await expectOk(await page.request.patch(`/api/extensions/streams/${target.streamId}`, { data: {
      extensionKey: AUTOMATED_PAYMENTS_EXTENSION_KEY, enabled: true, config: { enabledPaymentTypes: ['advance'] }
    } }), 'Select manual reimbursement with generated allocation lines')
    const createReimbursement = (amount: string) => page.request.post(`/api/agreements/${target.agreementId}/payments`, { data: {
      egcs_fc_applicantrecipient: payee.id,
      egcs_fc_commitmenttype: commitmentType, egcs_fc_fiscalyear: fiscalYearId,
      egcs_fc_paymenttype: 'reimbursement', egcs_fc_periodstart: 0, egcs_fc_periodend: 2,
      egcs_fc_paymentamount: amount, egcs_fc_currency: 'cad'
    } })
    const overdraw = await createReimbursement(addAutomatedPaymentMoney(payableCapacity, parseAutomatedPaymentMoney('0.01')))
    expect(overdraw.status(), await overdraw.text()).toBe(400)
    expect(await overdraw.text()).toContain('GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_REMAINING')
    const generatedResponse = await createReimbursement(payableCapacity)
    await expectOk(generatedResponse, 'Create a Payment using the post-JV capacity')
    const generatedPayment = await responseJson<IdRow>(generatedResponse)
    const generatedDetail = await responseJson<PaymentCoverageDetail>(await page.request.get(`/api/agreements/${target.agreementId}/payments/${generatedPayment.id}`))
    expect(generatedDetail.lines.reduce((total, line) => addAutomatedPaymentMoney(total, parseAutomatedPaymentMoney(line.egcs_fc_amount)), parseAutomatedPaymentMoney('0.00'))).toBe(payableCapacity)
    expect(await readCapacity('lifecycle-11-generated-payment-exhausts-capacity', '0.00')).toBe('0.00')
    await page.goto(`/en/agreements/${target.agreementId}/payments/${generatedPayment.id}`)
    await expect(page.getByRole('tab', { name: 'Payment completion', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('post-jv-generated-payment.png'), fullPage: true })
    await page.goto(`/en/journal-vouchers/${jv.id}`)
    await expect(page.getByRole('tab', { name: 'Accounting Entry', exact: true })).toBeVisible()
    await page.getByTestId('journal-voucher-balance-total').scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('shared-capacity-jv.png'), fullPage: true })

    await approvalPage.close()

    await openAgreementPaymentsTab(page, target.agreementId)
    await expect(page.getByRole('link', { name: 'Advance' }).first()).toBeVisible()
  })

  test('enforces route identity, assignment, French mobile UI, and reload boundaries', async ({ page, browser }) => {
    test.setTimeout(90_000)
    await login(page, 'root@example.com', 'password123')

    const malformedResponse = await page.request.post(
      `/api/extensions/${AUTOMATED_PAYMENTS_EXTENSION_KEY}/agreements/not-a-number/calculate-payment`,
      { data: {} }
    )
    expect([400, 404]).toContain(malformedResponse.status())

    const unassignedPage = await browser.newPage()
    await login(unassignedPage, 'user11@example.com', 'password123')
    const forbiddenResponse = await unassignedPage.request.post(
      `/api/extensions/${AUTOMATED_PAYMENTS_EXTENSION_KEY}/agreements/${target.agreementId}/calculate-payment`,
      { data: {} }
    )
    expect(forbiddenResponse.status()).toBe(403)
    await unassignedPage.close()

    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/fr/ententes/${target.agreementId}`)
    await page.getByRole('button', { name: 'Basculer la navigation' }).click()
    await page.getByRole('tab', { name: 'Paiements' }).last().click()
    await page.getByRole('button', { name: 'Ajouter un paiement', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Ajouter un paiement' })
      .getByText('Plafond du paiement automatise', { exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('button', { name: 'Basculer la navigation' })).toBeVisible()
  })

  test('requires holdback basis types and accepts a custom Agency code for finalfiscal', async ({ page }) => {
    await login(page, 'root@example.com', 'password123')

    const enableAgencyResponse = await page.request.patch(`/api/extensions/agency/${target.agencyId}`, {
      data: { extensionKey: AUTOMATED_PAYMENTS_EXTENSION_KEY, enabled: true }
    })
    await expectOk(enableAgencyResponse, 'Enable automated payments for activation validation')

    const disableStreamResponse = await page.request.patch(`/api/extensions/streams/${target.streamId}`, {
      data: { extensionKey: AUTOMATED_PAYMENTS_EXTENSION_KEY, enabled: false, config: {} }
    })
    await expectOk(disableStreamResponse, 'Disable automated payments before activation validation')

    const agreementResponse = await page.request.get(`/api/agreements/${target.agreementId}`)
    await expectOk(agreementResponse, 'Resolve automated-payment stream program')
    const agreement = await responseJson<{ program_id: string }>(agreementResponse)

    const basesResponse = await page.request.get(
      `/api/transfer-payments/${agreement.program_id}/streams/${target.streamId}/holdback-bases?page=1&limit=20`
    )
    await expectOk(basesResponse, 'List stream holdback bases')
    const bases = await responseJson<{
      items: Array<{ id: string; egcs_ay_holdbackbasis: string }>
    }>(basesResponse)
    const finalFiscalYearBasis = bases.items.find(
      item => item.egcs_ay_holdbackbasis === 'finalfiscal'
    )
    const ensuredBasis = finalFiscalYearBasis
      ?? await ensureStreamHoldbackBasis(page, agreement.program_id, 'finalfiscal')

    const deleteBasisResponse = await page.request.delete(
      `/api/transfer-payments/${agreement.program_id}/streams/${target.streamId}/holdback-bases/${ensuredBasis.id}`
    )
    await expectOk(deleteBasisResponse, 'Delete required finalfiscal holdback basis')

    const activationResponse = await page.request.patch(`/api/extensions/streams/${target.streamId}`, {
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
    expect(activationError.data.message).toContain('finalfiscal')
    expect(activationError.data.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'holdbackBases' })
    ]))

    const customBasisResponse = await page.request.post(`/api/agency/${target.agencyId}/holdback-bases`, {
      data: {
        egcs_ay_languageindependentcode: 'automated-payments-custom-finalfiscal',
        egcs_ay_holdbackbasis: 'finalfiscal',
        egcs_ay_name_en: 'Automated payments final fiscal year',
        egcs_ay_name_fr: 'Dernier exercice des paiements automatises'
      }
    })
    await expectOk(customBasisResponse, 'Create custom finalfiscal Agency basis')
    const customBasis = await responseJson<IdRow & {
      egcs_ay_languageindependentcode: string
      egcs_ay_holdbackbasis: string
    }>(customBasisResponse)
    expect(customBasis.egcs_ay_languageindependentcode).toBe('automated-payments-custom-finalfiscal')
    expect(customBasis.egcs_ay_holdbackbasis).toBe('finalfiscal')

    const customStreamBasisResponse = await page.request.post(
      `/api/transfer-payments/${agreement.program_id}/streams/${target.streamId}/holdback-bases`,
      { data: { egcs_tp_agencyholdback: String(customBasis.id) } }
    )
    await expectOk(customStreamBasisResponse, 'Assign custom finalfiscal basis to stream')

    const activateWithCustomCodeResponse = await page.request.patch(`/api/extensions/streams/${target.streamId}`, {
      data: {
        extensionKey: AUTOMATED_PAYMENTS_EXTENSION_KEY,
        enabled: true,
        config: { enabledPaymentTypes: ['advance', 'reimbursement'] }
      }
    })
    await expectOk(activateWithCustomCodeResponse, 'Activate automated payments with a custom finalfiscal code')
  })

  test('verifies fixed advances, reconciled claims, repeated whole-dollar holdback and final releases', async ({ page, browser }, testInfo) => {
    test.setTimeout(300_000)
    await login(page, 'root@example.com', 'password123')
    await runPaymentAccuracyJourney(page, browser, testInfo, target, {
      login,
      approveAll: approveAllSteps,
      complete: completeEntity
    })
  })

  test('separates CAD and USD Agreements and rejects mixed financial currencies', async ({ page, browser }, testInfo) => {
    test.setTimeout(360_000)
    await login(page, 'root@example.com', 'password123')
    await runPaymentCurrencyJourney(page, browser, testInfo, target, { login, approveAll: approveAllSteps, complete: completeEntity })
  })
  test('uses an explicit empty final Agreement fiscal year for zero holdback and full native advance', async ({ page, browser }, testInfo) => {
    test.setTimeout(180_000)
    await login(page, 'root@example.com', 'password123')
    await runPaymentEmptyFinalFiscalYearJourney(page, browser, testInfo, target, { login, approveAll: approveAllSteps, complete: completeEntity })
  })

})
