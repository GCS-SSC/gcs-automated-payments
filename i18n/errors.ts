import { defineGcsExtensionMessages } from '@gcs-ssc/extensions'

export const errorMessages = defineGcsExtensionMessages({
  en: {
    'error.GCS_AUTOMATED_PAYMENTS_CREDIT_MEMO_BASIS_REQUIRED': 'Choose which credit memos to use in the agency’s Automated payments extension settings before calculating payments.',
    'error.GCS_AUTOMATED_PAYMENTS_EVIDENCE_INVALID': 'The retained payment calculation is invalid or uses an unsupported version.',
    'error.GCS_AUTOMATED_PAYMENTS_AGREEMENT_REQUIRED': 'An agreement is required before calculating an automated payment.',
    'error.GCS_AUTOMATED_PAYMENTS_INVALID_CALCULATION_INPUT': 'Review the payment fields before calculating the automated payment.',
    'error.GCS_AUTOMATED_PAYMENTS_COMMITMENT_TYPE_REQUIRED': 'Select a commitment type before calculating the automated payment.',
    'error.GCS_AUTOMATED_PAYMENTS_FISCAL_YEAR_REQUIRED': 'Select a fiscal year before calculating the automated payment.',
    'error.GCS_AUTOMATED_PAYMENTS_FISCAL_YEAR_UNAVAILABLE': 'The selected fiscal year is not available for this agreement.',
    'error.GCS_AUTOMATED_PAYMENTS_PAYMENT_TYPE_REQUIRED': 'Select a payment type before calculating the automated payment.',
    'error.GCS_AUTOMATED_PAYMENTS_PERIOD_START_INVALID': 'Select a valid period start month.',
    'error.GCS_AUTOMATED_PAYMENTS_PERIOD_END_INVALID': 'Select a valid period end month.',
    'error.GCS_AUTOMATED_PAYMENTS_PERIOD_RANGE_INVALID': 'Period end must be the same as or after period start.',
    'error.GCS_AUTOMATED_PAYMENTS_AMOUNT_INVALID': 'Enter a valid payment amount.',
    'error.GCS_AUTOMATED_PAYMENTS_CURRENCY_INVALID': 'Select a valid payment currency.',
    'error.GCS_AUTOMATED_PAYMENTS_CURRENCY_MISMATCH': 'The calculation currency must match the payment currency. Recalculate before saving.',
    'error.GCS_AUTOMATED_PAYMENTS_OPTIONS_INVALID': 'Review the automated payment options.',
    'error.GCS_AUTOMATED_PAYMENTS_AMOUNT_EXCEEDS_CEILING': 'The payment amount exceeds the automated payment ceiling. Reduce the amount before saving.',
    'error.GCS_AUTOMATED_PAYMENTS_MISSING_HOLDBACK_BASES': 'Automated payments cannot be enabled because the stream is missing required holdback bases.',
    'error.GCS_AUTOMATED_PAYMENTS_UNSUPPORTED_HOLDBACK_BASIS': 'The agreement must use an automated-payments holdback basis configured for the stream.',
    'error.missing_holdback_types': 'Automated payments cannot be enabled. Add active stream holdback bases for these agency holdback-basis types: {types}.'
  },
  fr: {
    'error.GCS_AUTOMATED_PAYMENTS_CREDIT_MEMO_BASIS_REQUIRED': 'Choisissez les notes de crédit à utiliser dans les paramètres de l’extension Paiements automatisés de l’organisme avant de calculer les paiements.',
    'error.GCS_AUTOMATED_PAYMENTS_EVIDENCE_INVALID': 'Le calcul conservé du paiement est invalide ou utilise une version non prise en charge.',
    'error.GCS_AUTOMATED_PAYMENTS_AGREEMENT_REQUIRED': 'Une entente est requise avant de calculer un paiement automatise.',
    'error.GCS_AUTOMATED_PAYMENTS_INVALID_CALCULATION_INPUT': 'Verifiez les champs du paiement avant de calculer le paiement automatise.',
    'error.GCS_AUTOMATED_PAYMENTS_COMMITMENT_TYPE_REQUIRED': 'Selectionnez un type d engagement avant de calculer le paiement automatise.',
    'error.GCS_AUTOMATED_PAYMENTS_FISCAL_YEAR_REQUIRED': 'Selectionnez un exercice financier avant de calculer le paiement automatise.',
    'error.GCS_AUTOMATED_PAYMENTS_FISCAL_YEAR_UNAVAILABLE': 'L exercice financier selectionne n est pas disponible pour cette entente.',
    'error.GCS_AUTOMATED_PAYMENTS_PAYMENT_TYPE_REQUIRED': 'Selectionnez un type de paiement avant de calculer le paiement automatise.',
    'error.GCS_AUTOMATED_PAYMENTS_PERIOD_START_INVALID': 'Selectionnez un mois de debut de periode valide.',
    'error.GCS_AUTOMATED_PAYMENTS_PERIOD_END_INVALID': 'Selectionnez un mois de fin de periode valide.',
    'error.GCS_AUTOMATED_PAYMENTS_PERIOD_RANGE_INVALID': 'La periode de fin doit etre identique ou posterieure a la periode de debut.',
    'error.GCS_AUTOMATED_PAYMENTS_AMOUNT_INVALID': 'Saisissez un montant de paiement valide.',
    'error.GCS_AUTOMATED_PAYMENTS_CURRENCY_INVALID': 'Selectionnez une devise de paiement valide.',
    'error.GCS_AUTOMATED_PAYMENTS_CURRENCY_MISMATCH': 'La devise du calcul doit correspondre a celle du paiement. Recalculez avant l enregistrement.',
    'error.GCS_AUTOMATED_PAYMENTS_OPTIONS_INVALID': 'Verifiez les options du paiement automatise.',
    'error.GCS_AUTOMATED_PAYMENTS_AMOUNT_EXCEEDS_CEILING': 'Le montant du paiement depasse le plafond du paiement automatise. Reduisez le montant avant d enregistrer.',
    'error.GCS_AUTOMATED_PAYMENTS_MISSING_HOLDBACK_BASES': 'Les paiements automatises ne peuvent pas etre actives, car il manque des bases de retenue obligatoires au volet.',
    'error.GCS_AUTOMATED_PAYMENTS_UNSUPPORTED_HOLDBACK_BASIS': 'L entente doit utiliser une base de retenue des paiements automatises configuree pour le volet.',
    'error.missing_holdback_types': 'Les paiements automatisés ne peuvent pas être activés. Ajoutez des bases de retenue actives au volet pour les types de base de retenue de l’organisme suivants : {types}.'
  }
})
