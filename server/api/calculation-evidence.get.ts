import { defineGcsExtensionRouteHandler } from '@gcs-ssc/extensions/server'
import { getPaymentCalculationEvidence } from '../calculation-data.ts'

export default defineGcsExtensionRouteHandler(async context => ({
  evidence: await getPaymentCalculationEvidence(
    context.db as Parameters<typeof getPaymentCalculationEvidence>[0],
    context.params.paymentId!
  )
}))
