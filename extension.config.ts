import { defineGcsExtension } from '@gcs-ssc/extensions'

export default defineGcsExtension({
  key: 'gcs-automated-payments',
  sdkVersion: '^0.1.0',
  requiredHostCapabilities: [
    'stream-config-modal',
    'payment-amount-calculators',
    'server-handlers',
    'server-handler-rbac',
    'extension-ui',
    'extension-api-client',
    'extension-create-operation-hooks',
    'extension-lifecycle-hooks'
  ],
  name: {
    en: 'Automated payments',
    fr: 'Paiements automatises'
  },
  description: {
    en: 'Calculates agreement payment amount ceilings from claims, forecasts, previous payments, commitments, and holdback rules.',
    fr: 'Calcule les plafonds de paiement des ententes a partir des reclamations, previsions, paiements precedents, engagements et retenues.'
  },
  admin: {
    streamConfig: {
      path: './components/StreamAutomatedPaymentsConfig.vue'
    }
  },
  client: {
    paymentAmountCalculators: [
      {
        operation: 'agreement.payments.create',
        id: 'automated-payment-amount',
        label: {
          en: 'Automated payment amount',
          fr: 'Montant de paiement automatise'
        },
        path: './components/AutomatedPaymentAmountCalculator.vue',
        rbac: {
          subject: 'agreement',
          action: 'update'
        }
      }
    ]
  },
  serverHandlers: [
    {
      route: '/agreements/[agreementId]/calculate-payment',
      method: 'post',
      path: './server/api/calculate-payment.post.ts',
      rbac: {
        subject: 'agreement',
        action: 'update',
        entity: {
          target: 'agreement',
          param: 'agreementId'
        }
      }
    }
  ],
  nitroPlugin: './server/plugins/create-hooks.ts'
})
