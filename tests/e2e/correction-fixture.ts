import { expect, test, type APIResponse, type Page } from '@playwright/test'

type Owner = { agencyId: string; agreementId: string; programId: string; streamId: string }
type Id = { id: string }
type Correction = { id: string; egcs_fc_status: string; egcs_fc_outcome: string; egcs_fc_lines: Array<{
  egcs_fc_commitmentline: string; egcs_fc_originalpaid: string; egcs_fc_jveffect: string; egcs_fc_priorcorrections: string
}> }
const ok = async (response: APIResponse, label: string) => {
  if (!response.ok()) throw new Error(`${label}: ${response.status()} ${await response.text()}`)
}
const json = async <T>(response: APIResponse): Promise<T> => await response.json() as T

export const deleteUnsubmittedCommitmentDrafts = async (page: Page, owner: Owner): Promise<void> => {
  const statuses = await json<Array<{ id: string; agencyId: string; isDraft: boolean }>>(await page.request.get('/api/statuses'))
  const drafts = new Set(statuses.filter(status => status.agencyId === owner.agencyId && status.isDraft).map(status => status.id))
  const commitments = await json<{ commitments: Array<{ id: string; egcs_fc_active: boolean; egcs_fc_status: string }> }>(
    await page.request.get(`/api/agreements/${owner.agreementId}/commitments-overview`))
  for (const commitment of commitments.commitments.filter(item => !item.egcs_fc_active && drafts.has(item.egcs_fc_status))) {
    await ok(await page.request.delete(`/api/agreements/${owner.agreementId}/commitments/${commitment.id}`), 'Delete eligible unsubmitted Commitment draft')
  }
}

// Package-owned interoperability fixture: every financial and lifecycle change uses a public host API.
export const postNegativeCorrection = async (
  page: Page, approver: Page, owner: Owner, commitmentId: string, paymentId: string
): Promise<Correction> => {
  const users = await json<{ items: Array<{ id: string; egcs_cn_email: string }> }>(await page.request.get('/api/users/lookups?status=active&limit=100'))
  const creator = users.items.find(user => user.egcs_cn_email === 'root@example.com')!
  const verifier = users.items.find(user => user.egcs_cn_email === 'user03@example.com')!
  expect(creator).toBeTruthy()
  expect(verifier).toBeTruthy()
  const token = `${paymentId}-${Date.now()}`
  const roleResponse = await page.request.post('/api/roles', { data: {
    name_en: `Correction fixture ${token}`, name_fr: `Correction témoin ${token}`, agency_id: owner.agencyId,
    transfer_payment_ids: [], permissions: [{ subject: 'correction', access_level: 'contributor' }]
  } })
  await ok(roleResponse, 'Create explicit Correction grant')
  const role = await json<Id>(roleResponse)
  await ok(await page.request.post(`/api/users/${creator.id}/assignments`, { data: {
    user_id: creator.id, role_id: role.id, agency_id: owner.agencyId
  } }), 'Assign explicit Correction grant')
  const paymentUrl = `/api/agreements/${owner.agreementId}/payments/${paymentId}`
  const paymentBefore = await json(await page.request.get(paymentUrl))
  const paymentIdsBefore = (await json<{ payments: Id[] }>(await page.request.get(`/api/agreements/${owner.agreementId}/payments-overview`))).payments.map(payment => payment.id).sort()
  const create = await page.request.post(`/api/agreements/${owner.agreementId}/corrections`, { data: {
    egcs_fc_commitment: commitmentId, egcs_fc_payments: [paymentId], egcs_fc_requesteddate: '2026-10-01',
    egcs_fc_narrative_en: 'The external payment was correct. Remove one dollar of duplicated internal paid attribution.',
    egcs_fc_narrative_fr: 'Le paiement externe était exact. Retirer un dollar d’attribution interne dupliquée.'
  } })
  await ok(create, 'Create signed Correction through the shared Payment reader')
  const id = (await json<Id>(create)).id
  const correctionUrl = `/api/corrections/${id}`
  const original = await json<Correction>(await page.request.get(correctionUrl))
  const cents = (value: string) => BigInt(value.replace('.', ''))
  const line = original.egcs_fc_lines.find(item => cents(item.egcs_fc_originalpaid) + cents(item.egcs_fc_jveffect) + cents(item.egcs_fc_priorcorrections) >= BigInt(100))!
  expect(line).toBeTruthy()
  const signedEdit = { egcs_fc_requesteddate: '2026-10-01',
    egcs_fc_narrative_en: 'The external payment was correct. Remove one dollar of duplicated internal paid attribution.',
    egcs_fc_narrative_fr: 'Le paiement externe était exact. Retirer un dollar d’attribution interne dupliquée.',
    egcs_fc_lines: original.egcs_fc_lines.map(retained => ({ egcs_fc_commitmentline: retained.egcs_fc_commitmentline,
      egcs_fc_adjustment: retained === line ? '-1.00' : '0.00' })) }
  await ok(await page.request.patch(correctionUrl, { data: signedEdit }), 'Save exact signed adjustment')
  const agencyBase = `/api/agency/${owner.agencyId}`
  const terminal = async (name: string, color: string) => {
    const response = await page.request.post(`${agencyBase}/statuses`, { data: {
      nameEn: `${name} ${token}`, nameFr: `${name} FR ${token}`, color, icon: 'i-lucide-check', readOnly: false, terminal: true
    } })
    await ok(response, 'Create terminal Correction outcome')
    return (await json<Id>(response)).id
  }
  const success = await terminal('Correction posted', '#16a34a')
  const failure = await terminal('Correction denied', '#ef4444')
  const templateResponse = await page.request.post(`${agencyBase}/approval-templates`, { data: {
    egcs_cn_name_en: `Correction verifier ${token}`, egcs_cn_name_fr: `Vérification de correction ${token}`,
    egcs_cn_description_en: 'Verify external cash and the signed internal adjustment.', egcs_cn_description_fr: 'Vérifier le paiement externe et l’ajustement interne signé.',
    steps: [{ egcs_cn_sequence: 1, egcs_cn_name_en: 'Verify Correction', egcs_cn_name_fr: 'Vérifier la correction',
      egcs_cn_description_en: 'Verify the discrepancy.', egcs_cn_description_fr: 'Vérifier l’écart.', egcs_cn_defaultuser: verifier.id,
      egcs_cn_approvertitle: 'Financial verifier', certifications: [{ egcs_cn_order: 1, egcs_cn_name_en: 'External payment verified',
        egcs_cn_name_fr: 'Paiement externe vérifié', egcs_cn_description_en: 'External payment was correct.', egcs_cn_description_fr: 'Le paiement externe était exact.',
        egcs_cn_optional: false, egcs_cn_certification_en: 'I verified the external payment.', egcs_cn_certification_fr: 'J’ai vérifié le paiement externe.' }] }]
  } })
  await ok(templateResponse, 'Create assigned Correction approval')
  const template = await json<Id>(templateResponse)
  await ok(await page.request.post(`${agencyBase}/approval-templates/${template.id}/publish`), 'Publish Correction approval')
  const workflowResponse = await page.request.post(`${agencyBase}/workflows`, { data: {
    egcs_cn_entitytype: 'fundingcasecorrection', egcs_cn_name_en: `Correction approval ${token}`, egcs_cn_name_fr: `Approbation de correction ${token}`,
    egcs_cn_description_en: 'Required terminal approval.', egcs_cn_description_fr: 'Approbation terminale obligatoire.', egcs_cn_purpose: 'approval_submission',
    egcs_cn_allowedstartstatuses: [original.egcs_fc_status], egcs_cn_cancellationstatus: failure, egcs_cn_executionfailurestatus: failure, egcs_cn_allowretry: false
  } })
  await ok(workflowResponse, 'Create required Correction approval submission')
  const workflow = await json<Id>(workflowResponse)
  await ok(await page.request.post(`${agencyBase}/workflows/${workflow.id}/members`, { data: {
    egcs_cn_sequence: 1, egcs_cn_kind: 'approval_template', egcs_cn_approvaltemplate: template.id,
    egcs_cn_failurestatus: failure, egcs_cn_successstatus: success, owners: []
  } }), 'Configure terminal Correction approval route')
  await ok(await page.request.post(`${agencyBase}/workflows/${workflow.id}/publish`), 'Publish Correction workflow')
  const linksUrl = `/api/transfer-payments/${owner.programId}/streams/${owner.streamId}/workflows`
  const linksResponse = await page.request.get(linksUrl)
  await ok(linksResponse, 'Read current Correction workflow links')
  const previous = (await json<{ items: Array<{ id: string; egcs_tp_workflow: string; egcs_cn_entitytype: string; egcs_cn_purpose: string }> }>(linksResponse)).items
    .filter(link => link.egcs_cn_entitytype === 'fundingcasecorrection' && link.egcs_cn_purpose === 'approval_submission')
  const removed: typeof previous = []
  let ownedLinkId: string | undefined
  let failed = true
  try {
    // The current Stream permits one approval submission per entity type.
    // Temporarily replace its link with the independent verifier's publication;
    // submitted financial evidence keeps its immutable publication afterward.
    for (const link of previous) {
      await ok(await page.request.delete(`${linksUrl}/${link.id}`), 'Unlink original Correction workflow for owned verifier fixture')
      removed.push(link)
    }
    const ownedLink = await page.request.post(linksUrl, { data: { egcs_tp_workflow: workflow.id } })
    await ok(ownedLink, 'Link independent Correction verifier workflow')
    ownedLinkId = (await json<Id>(ownedLink)).id
    await ok(await page.request.post('/api/completions/complete', { data: { entityType: 'fundingcasecorrection', entityId: id } }), 'Complete required Correction submission')
    type Step = { id: string; can_action: boolean; certifications: Array<{ id: string }> }
    const runtime = await json<{ routingSlips?: Array<{ steps: Step[] }>; steps?: Step[] }>(
      await approver.request.get(`/api/approvals/runtime?entityType=fundingcasecorrection&entityId=${id}`))
    const step = (runtime.routingSlips?.flatMap(slip => slip.steps) ?? runtime.steps ?? []).find(item => item.can_action)!
    expect(step).toBeTruthy()
    await ok(await approver.request.post('/api/approvals/approve', { data: {
      approvalId: step.id, certifications: step.certifications.map(certification => ({ id: certification.id, egcs_cn_value: true }))
    } }), 'Post Correction through its assigned terminal approval')
    const posted = await json<Correction>(await page.request.get(correctionUrl))
    expect(posted.egcs_fc_outcome).toBe('posted')
    expect(await json(await page.request.get(paymentUrl))).toEqual(paymentBefore)
    expect((await json<{ payments: Id[] }>(await page.request.get(`/api/agreements/${owner.agreementId}/payments-overview`))).payments.map(payment => payment.id).sort()).toEqual(paymentIdsBefore)
    expect([403, 409]).toContain((await page.request.patch(correctionUrl, { data: { ...signedEdit, egcs_fc_narrative_en: 'Cannot alter terminal evidence.' } })).status())
    failed = false
    return posted
  } finally {
    const cleanupErrors: unknown[] = []
    const restore = async (label: string, operation: () => Promise<APIResponse>) => {
      try { await ok(await operation(), label) }
      catch (error) { cleanupErrors.push(error) }
    }
    if (ownedLinkId) await restore('Unlink owned Correction verifier workflow', async () => await page.request.delete(`${linksUrl}/${ownedLinkId}`))
    for (const link of removed) await restore('Restore original Correction workflow membership', async () =>
      await page.request.post(linksUrl, { data: { egcs_tp_workflow: link.egcs_tp_workflow } }))
    if (cleanupErrors.length) {
      if (!failed) throw new AggregateError(cleanupErrors, 'Correction fixture workflow restoration failed')
      for (const error of cleanupErrors) test.info().annotations.push({ type: 'cleanup failure', description: String(error) })
    }
  }
}
