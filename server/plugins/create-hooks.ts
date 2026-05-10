import {
  createGcsExtensionUserError,
  registerGcsExtensionCreateOperationHandler
} from '@gcs-ssc/extensions/server'
import {
  AutomatedPaymentCalculateSchema,
  EXTENSION_KEY,
  parseAutomatedPaymentsAgreementSettings,
  roundCurrency
} from '../../shared/automated-payments'
import {
  calculateAutomatedPaymentFromDb,
  saveAgreementSettings
} from '../calculation-data'

type AgreementProfileUpdatedPayload = {
  event: {
    context: {
      $db: unknown
    }
  }
  agreementId: string
  validatedBody?: unknown
}

export default defineNitroPlugin(nitroApp => {
  nitroApp.hooks.hook('agreement:profile:updated', async (payload: AgreementProfileUpdatedPayload) => {
    const validatedBody = payload.validatedBody && typeof payload.validatedBody === 'object'
      ? payload.validatedBody as Record<string, unknown>
      : {}
    const extensions = validatedBody.extensions && typeof validatedBody.extensions === 'object'
      ? validatedBody.extensions as Record<string, unknown>
      : {}
    const extensionPayload = extensions[EXTENSION_KEY] && typeof extensions[EXTENSION_KEY] === 'object'
      ? extensions[EXTENSION_KEY] as Record<string, unknown>
      : {}
    const agreementSettings = extensionPayload.agreementSettings && typeof extensionPayload.agreementSettings === 'object'
      ? extensionPayload.agreementSettings as Record<string, unknown>
      : null

    if (!agreementSettings) {
      return
    }

    await saveAgreementSettings(
      payload.event.context.$db as Parameters<typeof saveAgreementSettings>[0],
      String(payload.agreementId),
      parseAutomatedPaymentsAgreementSettings(agreementSettings) as unknown as Record<string, unknown>
    )
  })

  registerGcsExtensionCreateOperationHandler(EXTENSION_KEY, 'agreement.payments.create', async context => {
    if (context.phase !== 'before-create') {
      return { status: 'continue' }
    }

    const parsed = AutomatedPaymentCalculateSchema.safeParse(context.validatedBody)
    if (!parsed.success) {
      return { status: 'continue' }
    }

    const extensionPayload = parsed.data.extensions?.[EXTENSION_KEY] && typeof parsed.data.extensions[EXTENSION_KEY] === 'object'
      ? parsed.data.extensions[EXTENSION_KEY] as Record<string, unknown>
      : {}
    const holdbackReleaseOverride = typeof extensionPayload.holdbackReleaseOverride === 'number'
      ? extensionPayload.holdbackReleaseOverride
      : null
    const calculation = await calculateAutomatedPaymentFromDb(
      context.trx as Parameters<typeof calculateAutomatedPaymentFromDb>[0],
      {
        agreementId: context.agreementId,
        commitmentType: parsed.data.egcs_fc_commitmenttype,
        fiscalYearId: parsed.data.egcs_fc_fiscalyear,
        paymentType: parsed.data.egcs_fc_paymenttype,
        periodEnd: parsed.data.egcs_fc_periodend,
        submittedAmount: parsed.data.egcs_fc_paymentamount,
        holdbackReleaseOverride
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
