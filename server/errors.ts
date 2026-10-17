import { translateGcsExtensionMessage } from '@gcs-ssc/extensions'
import { errorMessages } from '../i18n/errors'
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
  | 'GCS_AUTOMATED_PAYMENTS_FISCAL_YEAR_UNAVAILABLE'
  | 'GCS_AUTOMATED_PAYMENTS_PAYMENT_TYPE_REQUIRED'
  | 'GCS_AUTOMATED_PAYMENTS_PERIOD_START_INVALID'
  | 'GCS_AUTOMATED_PAYMENTS_PERIOD_END_INVALID'
  | 'GCS_AUTOMATED_PAYMENTS_PERIOD_RANGE_INVALID'
  | 'GCS_AUTOMATED_PAYMENTS_AMOUNT_INVALID'
  | 'GCS_AUTOMATED_PAYMENTS_CURRENCY_INVALID'
  | 'GCS_AUTOMATED_PAYMENTS_CURRENCY_MISMATCH'
  | 'GCS_AUTOMATED_PAYMENTS_OPTIONS_INVALID'
  | 'GCS_AUTOMATED_PAYMENTS_AMOUNT_EXCEEDS_CEILING'
  | 'GCS_AUTOMATED_PAYMENTS_MISSING_HOLDBACK_BASES'
  | 'GCS_AUTOMATED_PAYMENTS_UNSUPPORTED_HOLDBACK_BASIS'
  | 'GCS_AUTOMATED_PAYMENTS_EVIDENCE_INVALID'
  | 'GCS_AUTOMATED_PAYMENTS_CREDIT_MEMO_BASIS_REQUIRED'

const validationErrorCodes: Record<string, AutomatedPaymentErrorCode> = {
  egcs_fc_commitmenttype: 'GCS_AUTOMATED_PAYMENTS_COMMITMENT_TYPE_REQUIRED',
  egcs_fc_fiscalyear: 'GCS_AUTOMATED_PAYMENTS_FISCAL_YEAR_REQUIRED',
  egcs_fc_paymenttype: 'GCS_AUTOMATED_PAYMENTS_PAYMENT_TYPE_REQUIRED',
  egcs_fc_periodstart: 'GCS_AUTOMATED_PAYMENTS_PERIOD_START_INVALID',
  egcs_fc_periodend: 'GCS_AUTOMATED_PAYMENTS_PERIOD_END_INVALID',
  egcs_fc_paymentamount: 'GCS_AUTOMATED_PAYMENTS_AMOUNT_INVALID',
  egcs_fc_currency: 'GCS_AUTOMATED_PAYMENTS_CURRENCY_INVALID',
  extensions: 'GCS_AUTOMATED_PAYMENTS_OPTIONS_INVALID'
}

const issuePath = (issue: z.ZodIssue): string => issue.path.join('.')

/**
 * Maps a validation issue to its public diagnostic code.
 * @returns The matching code or the general input diagnostic.
 * @param issue - Schema validation issue.
 */
const validationErrorCodeForIssue = (issue: z.ZodIssue): AutomatedPaymentErrorCode => {
  if (issue.message === 'GCS_AUTOMATED_PAYMENTS_PERIOD_RANGE_INVALID') {
    return 'GCS_AUTOMATED_PAYMENTS_PERIOD_RANGE_INVALID'
  }

  return validationErrorCodes[issuePath(issue)] ?? 'GCS_AUTOMATED_PAYMENTS_INVALID_CALCULATION_INPUT'
}

const defaultLocalizedMessage = (message: GcsExtensionLocalizedMessage): string =>
  typeof message === 'string' ? message : message.en

/**
 * Preserves the bilingual SDK payload alongside its default display text.
 * @returns The extension user error with localized transport metadata.
 * @param options - Public error details and messages.
 */
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

/**
 * Returns the localized message registered for an automated-payment error code.
 * @returns The English and French diagnostic text.
 * @param code - Stable automated-payment diagnostic code.
 */
const getAutomatedPaymentErrorMessage = (
  code: AutomatedPaymentErrorCode
): GcsExtensionLocalizedMessage => ({
  en: translateGcsExtensionMessage(errorMessages, 'en', `error.${code}`),
  fr: translateGcsExtensionMessage(errorMessages, 'fr', `error.${code}`)
})

/**
 * Creates a localized automated-payment user error with an optional field path.
 * @returns A bilingual extension user error.
 * @param code - Stable automated-payment diagnostic code.
 * @param path - Optional field path for validation details.
 */
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

/**
 * Creates an actionable bilingual activation error listing missing holdback-basis types.
 * @returns A bilingual activation error with field details.
 * @param missingTypes - Missing configured holdback-basis types.
 */
export const createAutomatedPaymentsMissingHoldbackBasesError = (
  missingTypes: string[]
) => {
  const types = missingTypes.join(', ')
  const message: GcsExtensionLocalizedMessage = {
    en: translateGcsExtensionMessage(errorMessages, 'en', 'error.missing_holdback_types', { types }),
    fr: translateGcsExtensionMessage(errorMessages, 'fr', 'error.missing_holdback_types', { types })
  }

  return createLocalizedUserError({
    code: 'GCS_AUTOMATED_PAYMENTS_MISSING_HOLDBACK_BASES',
    message,
    details: [{
      path: 'holdbackBases',
      code: 'GCS_AUTOMATED_PAYMENTS_MISSING_HOLDBACK_BASES',
      message
    }]
  })
}

/**
 * Converts Zod issues into localized field-level automated-payment error details.
 * @returns A bilingual error preserving validation field paths.
 * @param issues - Schema validation issues.
 */
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
