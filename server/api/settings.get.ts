/* eslint-disable jsdoc/require-jsdoc */
import { getAgreementSettings } from '../calculation-data'
import { createAutomatedPaymentUserError } from '../errors'

export default async (event: Parameters<EventHandler>[0]) => {
  const agreementId = event.context.params?.agreementId
  if (!agreementId) {
    throw createAutomatedPaymentUserError('GCS_AUTOMATED_PAYMENTS_AGREEMENT_REQUIRED')
  }

  return await getAgreementSettings(event.context.$db as Parameters<typeof getAgreementSettings>[0], agreementId)
}
