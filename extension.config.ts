import { defineGcsExtension, defineGcsAuditOwnership } from '@gcs-ssc/extensions'

export default defineGcsExtension({
  // Host-managed configuration, KV and secrets keep their host ownership rules.
  auditOwnership: defineGcsAuditOwnership([]),
  key: 'gcs-automated-payments',
  sdkVersion: '^0.3.10',
  requiredHostCapabilities: [
    'audit-ownership',
    'stream-config-modal',
    'payment-amount-calculators',
    'entity-tabs',
    'agreement-payment-capacity',
    'server-handlers',
    'server-handler-rbac',
    'extension-ui',
    'extension-api-client',
    'extension-kv',
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
    tabs: [{
      target: 'payment', id: 'calculation-evidence',
      label: { en: 'Payment calculation', fr: 'Calcul du paiement' },
      icon: 'i-lucide-calculator', path: './components/PaymentCalculationEvidence.vue',
      rbac: { subject: 'agreement', action: 'read' }
    }],
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
      route: '/payments/[paymentId]/calculation-evidence', method: 'get',
      path: './server/api/calculation-evidence.get.ts',
      rbac: { subject: 'agreement', action: 'read', entity: { target: 'payment', param: 'paymentId' } }
    },
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
