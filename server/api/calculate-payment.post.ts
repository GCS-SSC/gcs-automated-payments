/* eslint-disable jsdoc/require-jsdoc */
import { readBody } from 'h3'
import {
  AutomatedPaymentCalculateSchema,
  EXTENSION_KEY,
  parseAutomatedPaymentExtensionPayload
} from '../../shared/automated-payments'
import { calculateAutomatedPaymentFromDb } from '../calculation-data'
import {
  createAutomatedPaymentUserError,
  createAutomatedPaymentValidationError
} from '../errors'

export default async (event: Parameters<EventHandler>[0]) => {
  const agreementId = event.context.params?.agreementId
  if (!agreementId) {
    throw createAutomatedPaymentUserError('GCS_AUTOMATED_PAYMENTS_AGREEMENT_REQUIRED')
  }

  const parsed = AutomatedPaymentCalculateSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createAutomatedPaymentValidationError(parsed.error.issues)
  }

  const body = parsed.data
  const extensionConfig = event.context.gcsExtension && typeof event.context.gcsExtension === 'object'
    ? (event.context.gcsExtension as { config?: unknown }).config
    : {}
  const extensionPayload = parseAutomatedPaymentExtensionPayload(body.extensions?.[EXTENSION_KEY])

  return await calculateAutomatedPaymentFromDb(
    event.context.$db as Parameters<typeof calculateAutomatedPaymentFromDb>[0],
    {
      agreementId,
      commitmentType: body.egcs_fc_commitmenttype,
      fiscalYearId: body.egcs_fc_fiscalyear,
      paymentType: body.egcs_fc_paymenttype,
      periodEnd: body.egcs_fc_periodend,
      submittedAmount: body.egcs_fc_paymentamount,
      releaseHoldback: extensionPayload.releaseHoldback,
      holdbackReleaseAmount: extensionPayload.holdbackReleaseAmount
    },
    extensionConfig
  )
}
