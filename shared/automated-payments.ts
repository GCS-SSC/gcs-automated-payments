import { z } from 'zod'

export const EXTENSION_KEY = 'gcs-automated-payments'

export const automatedPaymentTypes = ['reimbursement', 'advance'] as const
export type AutomatedPaymentType = (typeof automatedPaymentTypes)[number]

export const holdbackBasisValues = ['agreement-total', 'final-fiscal-year'] as const
export type HoldbackBasis = (typeof holdbackBasisValues)[number]

export interface AutomatedPaymentsHoldbackSettings {
  holdbackPercent: number
  holdbackBasis: HoldbackBasis
}

export interface AutomatedPaymentsStreamConfig {
  enabledPaymentTypes: AutomatedPaymentType[]
}

export interface AutomatedPaymentExtensionPayload {
  releaseHoldback: boolean
  holdbackReleaseAmount: number
}

export interface AutomatedPaymentCalculationInput {
  paymentType: AutomatedPaymentType
  periodEnd: number
  totalClaimsToLastClaimMonth: number
  totalPaymentsToDate: number
  totalForecastToLastClaimMonth: number
  totalForecastToPeriodEnd: number
  commitmentRemaining: number
  agreementTotal: number
  finalFiscalYearTotal: number
  availableForDisbursementBeforeHoldback: number
  holdbackAlreadyReleased: number
  releaseHoldback?: boolean
  holdbackReleaseAmount?: number
}

export interface AutomatedPaymentCalculationResult {
  baseAmount: number
  ceilingAmount: number
  suggestedAmount: number
  holdbackAmount: number
  holdbackReleaseAmount: number
  availableBeforeHoldback: number
  currency: 'CAD'
  details: Array<{ label: string, value: number }>
}

export const defaultAutomatedPaymentsStreamConfig: AutomatedPaymentsStreamConfig = {
  enabledPaymentTypes: ['reimbursement', 'advance']
}

export const defaultAutomatedPaymentExtensionPayload: AutomatedPaymentExtensionPayload = {
  releaseHoldback: false,
  holdbackReleaseAmount: 0
}

export const AutomatedPaymentExtensionPayloadSchema = z.object({
  releaseHoldback: z.boolean().default(false),
  holdbackReleaseAmount: z.preprocess(
    value => value === '' || value === undefined || value === null ? 0 : value,
    z.coerce.number().finite().nonnegative().default(0)
  )
}).transform(data => ({
  releaseHoldback: data.releaseHoldback,
  holdbackReleaseAmount: data.releaseHoldback ? data.holdbackReleaseAmount : 0
}))

export const AutomatedPaymentCalculateSchema = z.object({
  egcs_fc_commitmenttype: z.string().min(1),
  egcs_fc_fiscalyear: z.string().min(1),
  egcs_fc_paymenttype: z.enum(automatedPaymentTypes),
  egcs_fc_periodstart: z.coerce.number().int().min(0).max(11),
  egcs_fc_periodend: z.coerce.number().int().min(0).max(11),
  egcs_fc_paymentamount: z.coerce.number().finite().optional(),
  extensions: z.record(z.string(), z.json()).optional()
}).refine(data => data.egcs_fc_periodstart <= data.egcs_fc_periodend, {
  message: 'GCS_AUTOMATED_PAYMENTS_PERIOD_RANGE_INVALID',
  path: ['egcs_fc_periodend']
})

/** Rounds a finite numeric value to Canadian currency precision, returning zero for non-finite input. */
export const roundCurrency = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.round((value + Number.EPSILON) * 100) / 100
}

const lowerCurrency = (values: number[]): number => Math.min(...values.map(value => roundCurrency(value)))

/** Normalizes an unknown stream configuration to the supported automated payment types. */
export const parseAutomatedPaymentsStreamConfig = (value: unknown): AutomatedPaymentsStreamConfig => {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const enabledPaymentTypes = Array.isArray(raw.enabledPaymentTypes)
    ? raw.enabledPaymentTypes.filter((item): item is AutomatedPaymentType => item === 'reimbursement' || item === 'advance')
    : defaultAutomatedPaymentsStreamConfig.enabledPaymentTypes

  return {
    enabledPaymentTypes
  }
}

/** Parses payment extension metadata, falling back to the default holdback settings when invalid. */
export const parseAutomatedPaymentExtensionPayload = (value: unknown): AutomatedPaymentExtensionPayload => {
  const parsed = AutomatedPaymentExtensionPayloadSchema.safeParse(value)
  return parsed.success ? parsed.data : defaultAutomatedPaymentExtensionPayload
}

/** Calculates the eligible payment ceiling and holdback breakdown from agreement financial totals. */
export const calculateAutomatedPaymentAmount = (
  input: AutomatedPaymentCalculationInput,
  holdbackSettings: AutomatedPaymentsHoldbackSettings
): AutomatedPaymentCalculationResult => {
  const baseAmount = input.paymentType === 'advance'
    ? input.totalClaimsToLastClaimMonth - input.totalForecastToLastClaimMonth + input.totalForecastToPeriodEnd - input.totalPaymentsToDate
    : input.totalClaimsToLastClaimMonth - input.totalPaymentsToDate

  const holdbackBasisAmount = holdbackSettings.holdbackBasis === 'final-fiscal-year'
    ? input.finalFiscalYearTotal
    : input.agreementTotal
  const holdbackAmount = roundCurrency(holdbackBasisAmount * (holdbackSettings.holdbackPercent / 100))
  const remainingHoldback = roundCurrency(Math.max(holdbackAmount - input.holdbackAlreadyReleased, 0))
  const requestedHoldbackRelease = input.releaseHoldback === true
    ? roundCurrency(input.holdbackReleaseAmount ?? 0)
    : 0
  const holdbackReleaseAmount = roundCurrency(Math.min(requestedHoldbackRelease, remainingHoldback))
  const availableBeforeHoldback = roundCurrency(Math.max(input.availableForDisbursementBeforeHoldback, 0))
  const availableWithHoldbackRelease = roundCurrency(availableBeforeHoldback + holdbackReleaseAmount)
  const positiveBaseAmount = roundCurrency(Math.max(baseAmount, 0))
  const ceilingAmount = roundCurrency(Math.max(lowerCurrency([
    positiveBaseAmount,
    input.commitmentRemaining,
    availableWithHoldbackRelease
  ]), 0))

  return {
    baseAmount: positiveBaseAmount,
    ceilingAmount,
    suggestedAmount: ceilingAmount,
    holdbackAmount,
    holdbackReleaseAmount,
    availableBeforeHoldback,
    currency: 'CAD',
    details: [
      { label: 'baseAmount', value: positiveBaseAmount },
      { label: 'commitmentRemaining', value: roundCurrency(input.commitmentRemaining) },
      { label: 'availableBeforeHoldback', value: availableBeforeHoldback },
      { label: 'holdbackReleaseAmount', value: holdbackReleaseAmount },
      { label: 'totalClaimsToLastClaimMonth', value: roundCurrency(input.totalClaimsToLastClaimMonth) },
      { label: 'totalForecastToLastClaimMonth', value: roundCurrency(input.totalForecastToLastClaimMonth) },
      { label: 'totalForecastToPeriodEnd', value: roundCurrency(input.totalForecastToPeriodEnd) },
      { label: 'totalPaymentsToDate', value: roundCurrency(input.totalPaymentsToDate) }
    ]
  }
}
