import { defineGcsExtensionRouteHandler } from '@gcs-ssc/extensions/server'
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

export default defineGcsExtensionRouteHandler(async ({ params, db, config, readBody }) => {
  const agreementId = params.agreementId
  if (!agreementId) {
    throw createAutomatedPaymentUserError('GCS_AUTOMATED_PAYMENTS_AGREEMENT_REQUIRED')
  }

  const parsed = AutomatedPaymentCalculateSchema.safeParse(await readBody())
  if (!parsed.success) {
    throw createAutomatedPaymentValidationError(parsed.error.issues)
  }

  const body = parsed.data
  const extensionPayload = parseAutomatedPaymentExtensionPayload(body.extensions?.[EXTENSION_KEY])

  return await calculateAutomatedPaymentFromDb(
    db as Parameters<typeof calculateAutomatedPaymentFromDb>[0],
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
    config
  )
})
