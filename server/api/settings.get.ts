/* eslint-disable jsdoc/require-jsdoc */
import { getAgreementSettings } from '../calculation-data'

export default async (event: Parameters<EventHandler>[0]) => {
  const agreementId = event.context.params?.agreementId
  if (!agreementId) {
    throw new Error('Agreement id is required.')
  }

  return await getAgreementSettings(event.context.$db as Parameters<typeof getAgreementSettings>[0], agreementId)
}
