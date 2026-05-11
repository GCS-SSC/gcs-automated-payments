import {
  createGcsExtensionUserError,
  registerGcsExtensionCreateOperationHandler
} from '@gcs-ssc/extensions/server'
import {
  AutomatedPaymentCalculateSchema,
  EXTENSION_KEY,
  parseAutomatedPaymentExtensionPayload,
  roundCurrency
} from '../../shared/automated-payments'
import {
  calculateAutomatedPaymentFromDb,
  savePaymentMetadata
} from '../calculation-data'

export default defineNitroPlugin(nitroApp => {
  registerGcsExtensionCreateOperationHandler(EXTENSION_KEY, 'agreement.payments.create', async context => {
    const parsed = AutomatedPaymentCalculateSchema.safeParse(context.validatedBody)
    if (!parsed.success) {
      return { status: 'continue' }
    }

    const extensionPayload = parseAutomatedPaymentExtensionPayload(parsed.data.extensions?.[EXTENSION_KEY])

    if (context.createdRecord) {
      const calculation = await calculateAutomatedPaymentFromDb(
        context.trx as Parameters<typeof calculateAutomatedPaymentFromDb>[0],
        {
          agreementId: context.agreementId,
          commitmentType: parsed.data.egcs_fc_commitmenttype,
          fiscalYearId: parsed.data.egcs_fc_fiscalyear,
          paymentType: parsed.data.egcs_fc_paymenttype,
          periodEnd: parsed.data.egcs_fc_periodend,
          submittedAmount: parsed.data.egcs_fc_paymentamount,
          releaseHoldback: extensionPayload.releaseHoldback,
          holdbackReleaseAmount: extensionPayload.holdbackReleaseAmount,
          excludePaymentId: String(context.createdRecord.id)
        },
        context.config
      )
      await savePaymentMetadata(
        context.trx as Parameters<typeof savePaymentMetadata>[0],
        String(context.createdRecord.id),
        {
          releaseHoldback: extensionPayload.releaseHoldback,
          holdbackReleaseAmount: calculation.holdbackReleaseAmount
        }
      )
      return { status: 'continue' }
    }

    if (context.phase !== 'before-create') {
      return { status: 'continue' }
    }

    const calculation = await calculateAutomatedPaymentFromDb(
      context.trx as Parameters<typeof calculateAutomatedPaymentFromDb>[0],
      {
        agreementId: context.agreementId,
        commitmentType: parsed.data.egcs_fc_commitmenttype,
        fiscalYearId: parsed.data.egcs_fc_fiscalyear,
        paymentType: parsed.data.egcs_fc_paymenttype,
        periodEnd: parsed.data.egcs_fc_periodend,
        submittedAmount: parsed.data.egcs_fc_paymentamount,
        releaseHoldback: extensionPayload.releaseHoldback,
        holdbackReleaseAmount: extensionPayload.holdbackReleaseAmount
      },
      context.config
    )

    if (!calculation.enabled) {
      return { status: 'continue' }
    }

    const submittedAmount = roundCurrency(parsed.data.egcs_fc_paymentamount ?? 0)
    if (submittedAmount > calculation.ceilingAmount) {
      throw createGcsExtensionUserError({
        code: 'GCS_AUTOMATED_PAYMENTS_AMOUNT_EXCEEDS_CEILING',
        message: 'apiErrors.extensions.gcs_automated_payments.amount_exceeds_ceiling',
        details: [{
          path: 'egcs_fc_paymentamount',
          message: 'apiErrors.extensions.gcs_automated_payments.amount_exceeds_ceiling'
        }]
      })
    }

    return { status: 'continue' }
  }, nitroApp as Parameters<typeof registerGcsExtensionCreateOperationHandler>[3])
})
