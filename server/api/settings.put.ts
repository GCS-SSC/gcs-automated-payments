/* eslint-disable jsdoc/require-jsdoc */
import { saveAgreementSettings } from '../calculation-data'
import { createAutomatedPaymentUserError } from '../errors'

export default async (event: Parameters<EventHandler>[0]) => {
  const agreementId = event.context.params?.agreementId
  if (!agreementId) {
    throw createAutomatedPaymentUserError('GCS_AUTOMATED_PAYMENTS_AGREEMENT_REQUIRED')
  }

  await saveAgreementSettings(
    event.context.$db as Parameters<typeof saveAgreementSettings>[0],
    agreementId,
    {}
  )
  return {}
}
