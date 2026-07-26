import {
  createGcsExtensionUserError,
  type GcsExtensionLocalizedMessage,
  type GcsExtensionUserErrorDetail,
  type GcsExtensionUserErrorOptions
} from '@gcs-ssc/extensions/server'
import type { z } from 'zod'

type AutomatedPaymentErrorCode =
  | 'GCS_AUTOMATED_PAYMENTS_AGREEMENT_REQUIRED'
  | 'GCS_AUTOMATED_PAYMENTS_INVALID_CALCULATION_INPUT'
  | 'GCS_AUTOMATED_PAYMENTS_COMMITMENT_TYPE_REQUIRED'
  | 'GCS_AUTOMATED_PAYMENTS_FISCAL_YEAR_REQUIRED'
  | 'GCS_AUTOMATED_PAYMENTS_PAYMENT_TYPE_REQUIRED'
  | 'GCS_AUTOMATED_PAYMENTS_PERIOD_START_INVALID'
  | 'GCS_AUTOMATED_PAYMENTS_PERIOD_END_INVALID'
  | 'GCS_AUTOMATED_PAYMENTS_PERIOD_RANGE_INVALID'
  | 'GCS_AUTOMATED_PAYMENTS_AMOUNT_INVALID'
  | 'GCS_AUTOMATED_PAYMENTS_OPTIONS_INVALID'
  | 'GCS_AUTOMATED_PAYMENTS_AMOUNT_EXCEEDS_CEILING'

const automatedPaymentErrorMessages: Record<AutomatedPaymentErrorCode, GcsExtensionLocalizedMessage> = {
  GCS_AUTOMATED_PAYMENTS_AGREEMENT_REQUIRED: {
    en: 'An agreement is required before calculating an automated payment.',
    fr: 'Une entente est requise avant de calculer un paiement automatise.'
  },
  GCS_AUTOMATED_PAYMENTS_INVALID_CALCULATION_INPUT: {
    en: 'Review the payment fields before calculating the automated payment.',
    fr: 'Verifiez les champs du paiement avant de calculer le paiement automatise.'
  },
  GCS_AUTOMATED_PAYMENTS_COMMITMENT_TYPE_REQUIRED: {
    en: 'Select a commitment type before calculating the automated payment.',
    fr: 'Selectionnez un type d engagement avant de calculer le paiement automatise.'
  },
  GCS_AUTOMATED_PAYMENTS_FISCAL_YEAR_REQUIRED: {
    en: 'Select a fiscal year before calculating the automated payment.',
    fr: 'Selectionnez un exercice financier avant de calculer le paiement automatise.'
  },
  GCS_AUTOMATED_PAYMENTS_PAYMENT_TYPE_REQUIRED: {
    en: 'Select a payment type before calculating the automated payment.',
    fr: 'Selectionnez un type de paiement avant de calculer le paiement automatise.'
  },
  GCS_AUTOMATED_PAYMENTS_PERIOD_START_INVALID: {
    en: 'Select a valid period start month.',
    fr: 'Selectionnez un mois de debut de periode valide.'
  },
  GCS_AUTOMATED_PAYMENTS_PERIOD_END_INVALID: {
    en: 'Select a valid period end month.',
    fr: 'Selectionnez un mois de fin de periode valide.'
  },
  GCS_AUTOMATED_PAYMENTS_PERIOD_RANGE_INVALID: {
    en: 'Period end must be the same as or after period start.',
    fr: 'La periode de fin doit etre identique ou posterieure a la periode de debut.'
  },
  GCS_AUTOMATED_PAYMENTS_AMOUNT_INVALID: {
    en: 'Enter a valid payment amount.',
    fr: 'Saisissez un montant de paiement valide.'
  },
  GCS_AUTOMATED_PAYMENTS_OPTIONS_INVALID: {
    en: 'Review the automated payment options.',
    fr: 'Verifiez les options du paiement automatise.'
  },
  GCS_AUTOMATED_PAYMENTS_AMOUNT_EXCEEDS_CEILING: {
    en: 'The payment amount exceeds the automated payment ceiling. Reduce the amount before saving.',
    fr: 'Le montant du paiement depasse le plafond du paiement automatise. Reduisez le montant avant d enregistrer.'
  }
}

const validationErrorCodes: Record<string, AutomatedPaymentErrorCode> = {
  egcs_fc_commitmenttype: 'GCS_AUTOMATED_PAYMENTS_COMMITMENT_TYPE_REQUIRED',
  egcs_fc_fiscalyear: 'GCS_AUTOMATED_PAYMENTS_FISCAL_YEAR_REQUIRED',
  egcs_fc_paymenttype: 'GCS_AUTOMATED_PAYMENTS_PAYMENT_TYPE_REQUIRED',
  egcs_fc_periodstart: 'GCS_AUTOMATED_PAYMENTS_PERIOD_START_INVALID',
  egcs_fc_periodend: 'GCS_AUTOMATED_PAYMENTS_PERIOD_END_INVALID',
  egcs_fc_paymentamount: 'GCS_AUTOMATED_PAYMENTS_AMOUNT_INVALID',
  extensions: 'GCS_AUTOMATED_PAYMENTS_OPTIONS_INVALID'
}

const issuePath = (issue: z.ZodIssue): string => issue.path.join('.')

const validationErrorCodeForIssue = (issue: z.ZodIssue): AutomatedPaymentErrorCode => {
  if (issue.message === 'GCS_AUTOMATED_PAYMENTS_PERIOD_RANGE_INVALID') {
    return 'GCS_AUTOMATED_PAYMENTS_PERIOD_RANGE_INVALID'
  }

  return validationErrorCodes[issuePath(issue)] ?? 'GCS_AUTOMATED_PAYMENTS_INVALID_CALCULATION_INPUT'
}

const defaultLocalizedMessage = (message: GcsExtensionLocalizedMessage): string =>
  typeof message === 'string' ? message : message.en

const createLocalizedUserError = (options: GcsExtensionUserErrorOptions) => {
  const error = createGcsExtensionUserError({
    ...options,
    message: defaultLocalizedMessage(options.message),
    details: options.details as GcsExtensionUserErrorDetail[] | undefined
  })

  return Object.assign(error, {
    localizedMessage: options.message,
    details: options.details
  })
}

/** Returns the localized message registered for an automated-payment error code. */
const getAutomatedPaymentErrorMessage = (
  code: AutomatedPaymentErrorCode
): GcsExtensionLocalizedMessage => automatedPaymentErrorMessages[code]

/** Creates a localized automated-payment user error with an optional field path. */
export const createAutomatedPaymentUserError = (
  code: AutomatedPaymentErrorCode,
  path?: string
) => createLocalizedUserError({
  code,
  message: getAutomatedPaymentErrorMessage(code),
  details: path
    ? [{
        path,
        message: getAutomatedPaymentErrorMessage(code)
      }]
    : undefined
})

/** Converts Zod issues into localized field-level automated-payment error details. */
export const createAutomatedPaymentValidationError = (
  issues: z.ZodIssue[]
) => createLocalizedUserError({
  code: 'GCS_AUTOMATED_PAYMENTS_INVALID_CALCULATION_INPUT',
  message: getAutomatedPaymentErrorMessage('GCS_AUTOMATED_PAYMENTS_INVALID_CALCULATION_INPUT'),
  details: issues.map(issue => {
    const code = validationErrorCodeForIssue(issue)

    return {
      path: issuePath(issue),
      code,
      message: getAutomatedPaymentErrorMessage(code)
    }
  })
})
