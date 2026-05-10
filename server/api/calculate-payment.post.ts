/* eslint-disable jsdoc/require-jsdoc */
import { readValidatedBodyI18n } from '~~/server/utils/api-validate'
import { AutomatedPaymentCalculateSchema } from '../../shared/automated-payments'
import { calculateAutomatedPaymentFromDb } from '../calculation-data'

export default async (event: Parameters<EventHandler>[0]) => {
  const agreementId = event.context.params?.agreementId
  if (!agreementId) {
    throw new Error('Agreement id is required.')
  }

  const body = await readValidatedBodyI18n(event, AutomatedPaymentCalculateSchema)
  const extensionConfig = event.context.gcsExtension && typeof event.context.gcsExtension === 'object'
    ? (event.context.gcsExtension as { config?: unknown }).config
    : {}
  const extensionPayload = body.extensions?.['gcs-automated-payments'] && typeof body.extensions['gcs-automated-payments'] === 'object'
    ? body.extensions['gcs-automated-payments'] as Record<string, unknown>
    : {}
  const holdbackReleaseOverride = typeof extensionPayload.holdbackReleaseOverride === 'number'
    ? extensionPayload.holdbackReleaseOverride
    : null

  return await calculateAutomatedPaymentFromDb(
    event.context.$db as Parameters<typeof calculateAutomatedPaymentFromDb>[0],
    {
      agreementId,
      commitmentType: body.egcs_fc_commitmenttype,
      fiscalYearId: body.egcs_fc_fiscalyear,
      paymentType: body.egcs_fc_paymenttype,
      periodEnd: body.egcs_fc_periodend,
      submittedAmount: body.egcs_fc_paymentamount,
      holdbackReleaseOverride
    },
    extensionConfig
  )
}
