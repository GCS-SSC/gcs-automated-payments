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
  }>
  streamCommitments: Array<{
    id: string | number
    stream_budget_id: string | number
  }>
}

type RuntimeApprovalStep = {
  id: string
  can_action: boolean
  certifications: Array<{
    id: string
    egcs_cn_optional: boolean
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
  fiscalYearId: string,
  periodEnd: number,
  paymentAmount = 0
) => {
  const response = await page.request.post(
    `/api/extensions/${AUTOMATED_PAYMENTS_EXTENSION_KEY}/agreements/${AGREEMENT_ID}/calculate-payment`,
    {
      data: {
        egcs_fc_commitmenttype: 'commitment',
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

const detailValue = (calculation: PaymentCalculationPayload, label: string): number => {
  const detail = calculation.details.find(item => item.label === label)
  if (!detail) {
    throw new Error(`Calculation detail "${label}" was not returned.`)
  }

  return detail.value
}

test.describe('Automated payment lifecycle', () => {
  test('runs allocation, commitment, forecast, advance, partial claim, and next payment math', async ({ page, browser }) => {
    await login(page, 'root@example.com', 'password123')

    const seededPaymentsResponse = await page.request.get(`/api/agreements/${AGREEMENT_ID}/payments-overview`)
    await expectOk(seededPaymentsResponse, 'Fetch seeded payments')
    const seededPayments = await responseJson<{ payments: Array<IdRow & { egcs_fc_status: string }> }>(seededPaymentsResponse)
    for (const payment of seededPayments.payments.filter(item => item.egcs_fc_status === 'draft')) {
      const deleteResponse = await page.request.delete(`/api/agreements/${AGREEMENT_ID}/payments/${payment.id}`)
      await expectOk(deleteResponse, `Delete seeded draft payment ${payment.id}`)
    }

    const enableResponse = await page.request.patch(`/api/extensions/agency/${AGENCY_ID}`, {
      data: {
        extensionKey: AUTOMATED_PAYMENTS_EXTENSION_KEY,
        enabled: true
      }
    })
    await expectOk(enableResponse, 'Enable automated payments for agency')

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
    expect(firstOutcomeId).not.toBe('')
    expect(allocationPayload.budgetYears.length).toBeGreaterThan(0)
    expect(allocationPayload.streamCommitments.length).toBeGreaterThan(0)
    const allocationMappings = allocationPayload.budgetYears.map(year => {
      const streamBudgetId = String(year.stream_budget_id ?? '')
      const streamCommitment = allocationPayload.streamCommitments.find(item =>
        String(item.stream_budget_id) === streamBudgetId
      )

      if (!streamCommitment) {
        throw new Error(`No stream commitment was returned for stream budget ${streamBudgetId}.`)
      }

      return {
        commitmentType: 'commitment',
        outcomeId: firstOutcomeId,
        streamBudgetId,
        streamCommitmentId: String(streamCommitment.id)
      }
    })

    const allocationConfigResponse = await page.request.patch(`/api/extensions/streams/${STREAM_ID}`, {
      data: {
        extensionKey: OUTCOME_ALLOCATION_EXTENSION_KEY,
        enabled: true,
        config: {
          enabledCommitmentTypes: ['commitment'],
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

    const allocations = allocationPayload.budgetYears.map((year, index) => {
      const mapping = allocationMappings[index]
      if (!mapping) {
        throw new Error(`No allocation mapping was built for budget year ${String(year.id)}.`)
      }

      return {
        commitmentType: 'commitment' as const,
        streamCommitmentId: mapping.streamCommitmentId,
        agreementBudgetFiscalYearId: String(year.id),
        outcomeId: firstOutcomeId,
        allocationMethod: 'amount' as const,
        allocationValue: Number(year.program_funding)
      }
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

    const completeAllocationResponse = await page.request.post(
      `/api/extensions/${OUTCOME_ALLOCATION_EXTENSION_KEY}/agreements/${AGREEMENT_ID}/allocation-versions/${allocationVersionId}/complete`,
      {
        data: { allocations }
      }
    )
    await expectOk(completeAllocationResponse, 'Complete allocation version')

    const commitmentResponse = await page.request.post(`/api/agreements/${AGREEMENT_ID}/commitments`, {
      data: {
        egcs_fc_type: 'commitment'
      }
    })
    await expectOk(commitmentResponse, 'Create generated commitment')
    const commitment = await responseJson<IdRow & { egcs_fc_status: string }>(commitmentResponse)
    const commitmentId = String(commitment.id)
    expect(commitment.egcs_fc_status).toBe('inprogress')

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
    expect(approvedCommitment.egcs_fc_status).toBe('approved')
    expect(approvedCommitment.egcs_fc_active).toBe(true)
    expect(approvedCommitment.lines.length).toBeGreaterThan(0)

    const budgetResponse = await page.request.get(`/api/agreements/${AGREEMENT_ID}/budget-overview`)
    await expectOk(budgetResponse, 'Fetch agreement budget')
    const budgetPayload = await responseJson<{
      fiscalYears: Array<IdRow & { fiscal_year_display: string }>
      lineItems: Array<IdRow & { fiscal_year_id: string | number }>
    }>(budgetResponse)
    const fundedCommitmentLine = approvedCommitment.lines.find(line => Number(line.egcs_fc_amount) > 0)
    const fiscalYearId = String(budgetPayload.fiscalYears.find(year =>
      year.fiscal_year_display === fundedCommitmentLine?.fiscal_year_display
    )?.id ?? '')
    const budgetLineItemId = String(
      budgetPayload.lineItems.find(item => String(item.fiscal_year_id) === fiscalYearId)?.id ?? ''
    )
    expect(fiscalYearId).not.toBe('')
    expect(budgetLineItemId).not.toBe('')

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
          egcs_fc_amount: 50,
          egcs_fc_currency: 'cad',
          egcs_fc_version: 0,
          egcs_fc_status: 'inprogress'
        }
      })
      await expectOk(lineResponse, `Create forecast line ${month}`)
    }

    await completeEntity(page, 'fundingcaseforecast', forecastId, 'Lifecycle test forecast completion.')
    await approveAllSteps(approvalPage, 'fundingcaseforecast', forecastId)

    const initialAdvanceCalculation = await calculateAdvance(page, fiscalYearId, 2)
    expect(initialAdvanceCalculation.suggestedAmount).toBeGreaterThan(0)
    const commitmentBalance = roundCurrency(approvedCommitment.lines.filter(
      line => line.fiscal_year_display === fundedCommitmentLine?.fiscal_year_display
    ).reduce(
      (total, line) => total + Number(line.egcs_fc_amount),
      0
    ))
    const initialAdvanceAmount = Math.min(initialAdvanceCalculation.suggestedAmount, commitmentBalance)
    expect(initialAdvanceAmount).toBeGreaterThan(0)

    const advanceResponse = await page.request.post(`/api/agreements/${AGREEMENT_ID}/payments`, {
      data: {
        egcs_fc_commitmenttype: 'commitment',
        egcs_fc_fiscalyear: fiscalYearId,
        egcs_fc_paymenttype: 'advance',
        egcs_fc_periodstart: 0,
        egcs_fc_periodend: 2,
        egcs_fc_paymentamount: initialAdvanceAmount,
        egcs_fc_comment: 'Lifecycle test advance payment.',
        extensions: {
          [AUTOMATED_PAYMENTS_EXTENSION_KEY]: {
            releaseHoldback: false,
            holdbackReleaseAmount: 0
          }
        }
      }
    })
    await expectOk(advanceResponse, 'Create advance payment')
    const advancePayment = await responseJson<IdRow & { egcs_fc_status: string }>(advanceResponse)
    const advancePaymentId = String(advancePayment.id)
    const advancePaymentDetailResponse = await page.request.get(`/api/agreements/${AGREEMENT_ID}/payments/${advancePaymentId}`)
    await expectOk(advancePaymentDetailResponse, 'Fetch generated advance payment')
    const advancePaymentDetail = await responseJson<IdRow & {
      egcs_fc_status: string
      egcs_fc_fundingagreementcommitment: string | number
      lines: IdRow[]
    }>(advancePaymentDetailResponse)
    expect(String(advancePaymentDetail.egcs_fc_fundingagreementcommitment)).toBe(commitmentId)
    expect(advancePaymentDetail.egcs_fc_status).toBe('inprogress')
    expect(advancePaymentDetail.lines.length).toBeGreaterThan(0)

    await completeEntity(page, 'fundingcasepayment', advancePaymentId, 'Lifecycle test advance payment completion.')
    await approveAllSteps(approvalPage, 'fundingcasepayment', advancePaymentId)

    const beforeClaimCalculation = await calculateAdvance(page, fiscalYearId, 2)

    const claimResponse = await page.request.post(`/api/agreements/${AGREEMENT_ID}/claims`, {
      data: {
        egcs_fc_fiscalyear: fiscalYearId,
        egcs_fc_isfinalforyear: false,
        egcs_fc_periodstart: 0,
        egcs_fc_periodend: 2,
        egcs_fc_receiveddate: '2026-05-11'
      }
    })
    await expectOk(claimResponse, 'Create claim')
    const claim = await responseJson<IdRow>(claimResponse)
    const claimId = String(claim.id)

    const claimLineResponse = await page.request.post(`/api/agreements/${AGREEMENT_ID}/claim-line-items`, {
      data: {
        egcs_fc_fundingagreementclaim: claimId,
        egcs_fc_fundingagreementbudgetlineitem: budgetLineItemId,
        egcs_fc_description: 'Lifecycle test partial claim.',
        egcs_fc_amount: 200,
        egcs_fc_currency: 'cad'
      }
    })
    await expectOk(claimLineResponse, 'Create claim line')
    const claimLine = await responseJson<IdRow>(claimLineResponse)

    const readyResponse = await page.request.post(`/api/agreements/${AGREEMENT_ID}/claims/${claimId}/ready-for-review`)
    await expectOk(readyResponse, 'Mark claim ready for review')

    const reconcileResponse = await page.request.post(`/api/agreements/${AGREEMENT_ID}/claim-reconciles`, {
      data: {
        egcs_fc_fundingagreementclaim: claimId,
        egcs_fc_isfinal: true
      }
    })
    await expectOk(reconcileResponse, 'Create claim reconcile')
    const reconcile = await responseJson<IdRow>(reconcileResponse)
    const reconcileId = String(reconcile.id)

    const reconcileLineResponse = await page.request.post(`/api/agreements/${AGREEMENT_ID}/claim-reconcile-line-items`, {
      data: {
        egcs_fc_fundingagreementclaimreconcile: reconcileId,
        egcs_fc_lineitem: String(claimLine.id),
        egcs_fc_reconciled: 180,
        egcs_fc_sampled: 50,
        egcs_fc_rationale: 'Lifecycle test reconciles the claim below the submitted amount.'
      }
    })
    await expectOk(reconcileLineResponse, 'Create partial claim reconcile line')

    await completeEntity(page, 'fundingclaimreconcile', reconcileId, 'Lifecycle test claim reconciliation completion.')
    await approveAllSteps(approvalPage, 'fundingclaimreconcile', reconcileId)
    await approvalPage.close()

    const nextAdvanceCalculation = await calculateAdvance(page, fiscalYearId, 2)
    const manualBaseAmount = roundCurrency(Math.max(
      detailValue(nextAdvanceCalculation, 'totalClaimsToLastClaimMonth')
      - detailValue(nextAdvanceCalculation, 'totalForecastToLastClaimMonth')
      + detailValue(nextAdvanceCalculation, 'totalForecastToPeriodEnd')
      - detailValue(nextAdvanceCalculation, 'totalPaymentsToDate'),
      0
    ))
    const expectedNextBaseAmount = roundCurrency(beforeClaimCalculation.baseAmount + 30)

    expect(nextAdvanceCalculation.baseAmount).toBe(manualBaseAmount)
    expect(nextAdvanceCalculation.baseAmount).toBe(expectedNextBaseAmount)
    expect(nextAdvanceCalculation.suggestedAmount).toBe(nextAdvanceCalculation.ceilingAmount)
    expect(nextAdvanceCalculation.suggestedAmount).toBeLessThanOrEqual(nextAdvanceCalculation.baseAmount)
    expect(roundCurrency(
      nextAdvanceCalculation.baseAmount - beforeClaimCalculation.baseAmount
    )).toBe(30)

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
    expect(finalFiscalYearBasis).toBeTruthy()

    const deleteBasisResponse = await page.request.delete(
      `/api/transfer-payments/${agreement.program_id}/streams/${STREAM_ID}/holdback-bases/${finalFiscalYearBasis!.id}`
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
  })
})
