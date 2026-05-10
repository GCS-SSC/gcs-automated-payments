/* eslint-disable jsdoc/require-jsdoc */
import { z } from 'zod'

export const EXTENSION_KEY = 'gcs-automated-payments'

export const automatedPaymentTypes = ['reimbursement', 'advance'] as const
export type AutomatedPaymentType = (typeof automatedPaymentTypes)[number]

export const holdbackBasisValues = ['agreement-total', 'final-fiscal-year'] as const
export type HoldbackBasis = (typeof holdbackBasisValues)[number]

export interface AutomatedPaymentsStreamConfig {
  enabledPaymentTypes: AutomatedPaymentType[]
}

export interface AutomatedPaymentsHoldbackSettings {
  holdbackPercent: number
  holdbackBasis: HoldbackBasis
}

export interface AutomatedPaymentsAgreementSettings {
  previousClaimsTotal: number
  previousPaymentsTotal: number
  holdbackPercent: number
  holdbackBasis: HoldbackBasis
  holdbackReleaseOverride: number | null
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
  holdbackReleaseOverride?: number | null
}

export interface AutomatedPaymentCalculationResult {
  baseAmount: number
  ceilingAmount: number
  suggestedAmount: number
  currency: 'CAD'
  details: Array<{ label: string, value: number }>
}

export const defaultAutomatedPaymentsStreamConfig: AutomatedPaymentsStreamConfig = {
  enabledPaymentTypes: ['reimbursement', 'advance']
}

export const defaultAutomatedPaymentsHoldbackSettings: AutomatedPaymentsHoldbackSettings = {
  holdbackPercent: 10,
  holdbackBasis: 'agreement-total'
}

export const defaultAutomatedPaymentsAgreementSettings: AutomatedPaymentsAgreementSettings = {
  previousClaimsTotal: 0,
  previousPaymentsTotal: 0,
  holdbackPercent: defaultAutomatedPaymentsHoldbackSettings.holdbackPercent,
  holdbackBasis: defaultAutomatedPaymentsHoldbackSettings.holdbackBasis,
  holdbackReleaseOverride: null
}

export const AutomatedPaymentsAgreementSettingsSchema = z.object({
  previousClaimsTotal: z.coerce.number().finite().nonnegative().default(0),
  previousPaymentsTotal: z.coerce.number().finite().nonnegative().default(0),
  holdbackPercent: z.coerce.number().finite().min(0).max(100).default(defaultAutomatedPaymentsHoldbackSettings.holdbackPercent),
  holdbackBasis: z.enum(holdbackBasisValues).default(defaultAutomatedPaymentsHoldbackSettings.holdbackBasis),
  holdbackReleaseOverride: z.preprocess(
    value => value === '' || value === undefined ? null : value,
    z.coerce.number().finite().nonnegative().nullable().default(null)
  )
})

export const AutomatedPaymentCalculateSchema = z.object({
  egcs_fc_commitmenttype: z.string().min(1),
  egcs_fc_fiscalyear: z.string().min(1),
  egcs_fc_paymenttype: z.enum(automatedPaymentTypes),
  egcs_fc_periodstart: z.coerce.number().int().min(0).max(11),
  egcs_fc_periodend: z.coerce.number().int().min(0).max(11),
  egcs_fc_paymentamount: z.coerce.number().finite().optional(),
  extensions: z.record(z.string(), z.json()).optional()
}).refine(data => data.egcs_fc_periodstart <= data.egcs_fc_periodend, {
  message: 'validation.date_range',
  path: ['egcs_fc_periodend']
})

export const roundCurrency = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.round((value + Number.EPSILON) * 100) / 100
}

const lowerCurrency = (values: number[]): number => Math.min(...values.map(value => roundCurrency(value)))

export const parseAutomatedPaymentsStreamConfig = (value: unknown): AutomatedPaymentsStreamConfig => {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const enabledPaymentTypes = Array.isArray(raw.enabledPaymentTypes)
    ? raw.enabledPaymentTypes.filter((item): item is AutomatedPaymentType => item === 'reimbursement' || item === 'advance')
    : defaultAutomatedPaymentsStreamConfig.enabledPaymentTypes

  return {
    enabledPaymentTypes
  }
}

export const parseAutomatedPaymentsAgreementSettings = (value: unknown): AutomatedPaymentsAgreementSettings => {
  const parsed = AutomatedPaymentsAgreementSettingsSchema.safeParse(value)
  return parsed.success ? parsed.data : defaultAutomatedPaymentsAgreementSettings
}

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
  const releaseOverride = input.holdbackReleaseOverride === null || input.holdbackReleaseOverride === undefined
    ? 0
    : roundCurrency(input.holdbackReleaseOverride)
  const holdbackThreshold = roundCurrency(Math.max(holdbackBasisAmount - holdbackAmount + releaseOverride, 0))
  const availableBeforeHoldback = roundCurrency(Math.max(holdbackThreshold - input.totalPaymentsToDate, 0))
  const positiveBaseAmount = roundCurrency(Math.max(baseAmount, 0))
  const ceilingAmount = roundCurrency(Math.max(lowerCurrency([
    positiveBaseAmount,
    input.commitmentRemaining,
    availableBeforeHoldback
  ]), 0))

  return {
    baseAmount: positiveBaseAmount,
    ceilingAmount,
    suggestedAmount: ceilingAmount,
    currency: 'CAD',
    details: [
      { label: 'baseAmount', value: positiveBaseAmount },
      { label: 'commitmentRemaining', value: roundCurrency(input.commitmentRemaining) },
      { label: 'availableBeforeHoldback', value: availableBeforeHoldback },
      { label: 'totalClaimsToLastClaimMonth', value: roundCurrency(input.totalClaimsToLastClaimMonth) },
      { label: 'totalPaymentsToDate', value: roundCurrency(input.totalPaymentsToDate) }
    ]
  }
}
