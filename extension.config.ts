import { defineGcsExtension } from '@gcs-ssc/extensions'

export default defineGcsExtension({
  key: 'gcs-automated-payments',
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
    tabs: [
      {
        target: 'agreement',
        id: 'automated-payments',
        label: {
          en: 'Automated Payments',
          fr: 'Paiements automatises'
        },
        icon: 'i-lucide-calculator',
        path: './components/AgreementAutomatedPaymentsTab.vue',
        rbac: {
          subject: 'agreement',
          action: 'update'
        }
      }
    ],
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
      route: '/agreements/[agreementId]/settings',
      method: 'get',
      path: './server/api/settings.get.ts',
      rbac: {
        subject: 'agreement',
        action: 'read',
        entity: {
          target: 'agreement',
          param: 'agreementId'
        }
      }
    },
    {
      route: '/agreements/[agreementId]/settings',
      method: 'put',
      path: './server/api/settings.put.ts',
      rbac: {
        subject: 'agreement',
        action: 'update',
        entity: {
          target: 'agreement',
          param: 'agreementId'
        }
      }
    },
    {
      route: '/agreements/[agreementId]/calculate-payment',
      method: 'post',
      path: './server/api/calculate-payment.post.ts',
      rbac: {
        subject: 'agreement',
        action: 'read',
        entity: {
          target: 'agreement',
          param: 'agreementId'
        }
      }
    }
  ],
  nitroPlugin: './server/plugins/create-hooks.ts'
})
