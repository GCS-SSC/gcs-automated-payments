/* eslint-disable jsdoc/require-jsdoc */
import { saveAgreementSettings } from '../calculation-data'

export default async (event: Parameters<EventHandler>[0]) => {
  const agreementId = event.context.params?.agreementId
  if (!agreementId) {
    throw new Error('Agreement id is required.')
  }

  await saveAgreementSettings(
    event.context.$db as Parameters<typeof saveAgreementSettings>[0],
    agreementId,
    {}
  )
  return {}
}
