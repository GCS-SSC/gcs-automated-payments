/* eslint-disable jsdoc/require-jsdoc */
import { readValidatedBodyI18n } from '~~/server/utils/api-validate'
import {
  AutomatedPaymentsAgreementSettingsSchema,
  parseAutomatedPaymentsAgreementSettings
} from '../../shared/automated-payments'
import { saveAgreementSettings } from '../calculation-data'

export default async (event: Parameters<EventHandler>[0]) => {
  const agreementId = event.context.params?.agreementId
  if (!agreementId) {
    throw new Error('Agreement id is required.')
  }

  const body = await readValidatedBodyI18n(event, AutomatedPaymentsAgreementSettingsSchema)
  const settings = parseAutomatedPaymentsAgreementSettings(body)
  await saveAgreementSettings(
    event.context.$db as Parameters<typeof saveAgreementSettings>[0],
    agreementId,
    settings as unknown as Record<string, unknown>
  )
  return settings
}
