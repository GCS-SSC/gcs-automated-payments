import { z } from 'zod'
import { getCurrency, isPersistableMoney, parseMoney, parseDecimalText, type DecimalText, type Money } from '@gcs-ssc/extensions/money'

export const EXTENSION_KEY = 'gcs-automated-payments'
const automatedPaymentTypes = ['reimbursement', 'advance'] as const
export type AutomatedPaymentType = (typeof automatedPaymentTypes)[number]
export type { Money as AutomatedPaymentMoney } from '@gcs-ssc/extensions/money'
export type AutomatedPaymentMoneyInput = Money

export const AutomatedPaymentCurrencySchema = z.string().regex(/^[a-z]{3}$/).refine(value => {
  try { getCurrency(value); return true } catch { return false }
})
const MoneyObjectSchema = z.object({ amount: z.string(), currency: z.string() }).strict().transform((value, ctx) => {
  try { return parseMoney(value) } catch {
    ctx.addIssue({ code: 'custom', message: 'GCS_AUTOMATED_PAYMENTS_MONEY_INVALID' })
    return z.NEVER
  }
})
export const AutomatedPaymentMoneySchema = MoneyObjectSchema.refine(isPersistableMoney, { message: 'GCS_AUTOMATED_PAYMENTS_MONEY_INVALID' })
const PercentageSchema = z.string().transform((value, ctx) => {
  try {
    const decimal = parseDecimalText(value)
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(decimal) || Number(decimal) > 100) throw new TypeError('Invalid percentage.')
    return decimal
  } catch {
    ctx.addIssue({ code: 'custom', message: 'GCS_AUTOMATED_PAYMENTS_MONEY_INVALID' })
    return z.NEVER
  }
})

export interface AutomatedPaymentsStreamConfig { enabledPaymentTypes: AutomatedPaymentType[] }
export const AutomatedPaymentCreditMemoBasisSchema = z.enum(['all', 'reconciled-periods'])
export const AutomatedPaymentsAgencyConfigSchema = z.object({ creditMemoBasis: AutomatedPaymentCreditMemoBasisSchema })
export type AutomatedPaymentCreditMemoBasis = z.infer<typeof AutomatedPaymentCreditMemoBasisSchema>
export interface AutomatedPaymentExtensionPayload { releaseHoldback: boolean, holdbackReleaseAmount?: Money }
export type AutomatedPaymentExplanationRow =
  | { label: string; value: Money; operator?: '+' | '−' | '×'; format?: never }
  | { label: string; value: DecimalText; operator?: '+' | '−' | '×'; format: 'percent' }
export interface AutomatedPaymentCalculationResult {
  baseAmount: Money
  ceilingAmount: Money
  suggestedAmount: Money
  holdbackAmount: Money
  holdbackReleaseAmount: Money
  availableBeforeHoldback: Money
  currency: string
  details: Array<{ label: string, value: Money }>
  explanation?: Array<{
    label: string
    rows: AutomatedPaymentExplanationRow[]
    total: { label: string, value: Money }
    notes?: string[]
    noteValues?: Record<string, Money>
    emphasis?: boolean
  }>
}

const defaultConfig: AutomatedPaymentsStreamConfig = { enabledPaymentTypes: ['reimbursement', 'advance'] }
const MAX_BIGINT = '9223372036854775807'
const positiveBigint = (value: string) => /^[1-9]\d*$/.test(value) && (value.length < MAX_BIGINT.length || (value.length === MAX_BIGINT.length && value <= MAX_BIGINT))
export const AutomatedPaymentPositiveBigintIdSchema = z.preprocess(value => {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return value
}, z.string().refine(positiveBigint))
const ExplanationLabelSchema = z.enum([
  'explanation.claims', 'explanation.forecast', 'explanation.claimed_forecast', 'explanation.paid',
  'credit_memo_basis.all', 'credit_memo_basis.reconciled_periods', 'explanation.funding',
  'explanation.unreconciled_credits', 'explanation.reserved', 'explanation.released',
  'explanation.payment_calculation', 'explanation.holdback', 'explanation.final_year',
  'explanation.agreement_total', 'explanation.holdback_rate', 'explanation.full_holdback',
  'explanation.available_funds', 'explanation.payment_limits', 'explanation.commitment',
  'explanation.single_payment', 'explanation.maximum'
])
const ExplanationNoteSchema = z.enum([
  'explanation.nothing_payable', 'explanation.reserve_limited', 'explanation.rounded',
  'explanation.credit_policy', 'explanation.availability_zero', 'explanation.release_limited',
  'explanation.limited_payment', 'explanation.limited_calculation',
  'explanation.limited_commitment', 'explanation.limited_funding'
])
const ExplanationRowBaseSchema = z.object({ label: ExplanationLabelSchema, operator: z.enum(['+', '−', '×']).optional() })
const CalculationEvidenceSchema = z.object({
  version: z.literal(3),
  capturedAt: z.iso.datetime(),
  input: z.object({
    paymentType: z.enum(automatedPaymentTypes), periodEnd: z.number().int().min(0).max(11),
    currency: AutomatedPaymentCurrencySchema,
    fiscalYearId: z.string().refine(positiveBigint), commitmentTypeId: z.string().refine(positiveBigint),
    periodStart: z.number().int().min(0).max(11), creditMemoBasis: AutomatedPaymentCreditMemoBasisSchema
  }).refine(value => value.periodStart <= value.periodEnd),
  calculation: z.object({
    enabled: z.literal(true), currency: z.string().regex(/^[A-Z]{3}$/),
    baseAmount: MoneyObjectSchema, ceilingAmount: AutomatedPaymentMoneySchema,
    suggestedAmount: AutomatedPaymentMoneySchema, holdbackAmount: MoneyObjectSchema,
    holdbackReleaseAmount: AutomatedPaymentMoneySchema, availableBeforeHoldback: MoneyObjectSchema,
    details: z.array(z.object({
      label: z.enum(['baseAmount', 'commitmentRemaining', 'availableBeforeHoldback', 'holdbackReleaseAmount',
        'totalClaimsToLastClaimMonth', 'totalForecastToLastClaimMonth', 'totalForecastToPeriodEnd', 'totalPaymentsToDate', 'totalCreditMemos', 'totalCreditMemosForReconciledPeriods']),
      value: MoneyObjectSchema
    })),
    explanation: z.array(z.object({
      label: ExplanationLabelSchema,
      rows: z.array(z.union([
        ExplanationRowBaseSchema.extend({ value: MoneyObjectSchema, format: z.never().optional() }),
        ExplanationRowBaseSchema.extend({ value: PercentageSchema, format: z.literal('percent') })
      ])).min(1),
      total: z.object({ label: ExplanationLabelSchema, value: MoneyObjectSchema }),
      notes: z.array(ExplanationNoteSchema).optional(),
      noteValues: z.object({ reserve: MoneyObjectSchema.optional(), requested: MoneyObjectSchema.optional(), released: MoneyObjectSchema.optional() }).optional(),
      emphasis: z.boolean().optional()
    })).min(1)
  })
}).refine(value => value.input.currency.toUpperCase() === value.calculation.currency)
export const AutomatedPaymentCalculationEvidenceSchema = CalculationEvidenceSchema.superRefine((value, ctx) => {
  const currency = value.input.currency.toUpperCase()
  const validate = (amount: Money, path: Array<string | number>) => {
    if (amount.currency !== currency) ctx.addIssue({ code: 'custom', message: 'GCS_AUTOMATED_PAYMENTS_CURRENCY_MISMATCH', path })
  }
  for (const key of ['baseAmount', 'ceilingAmount', 'suggestedAmount', 'holdbackAmount', 'holdbackReleaseAmount', 'availableBeforeHoldback'] as const) validate(value.calculation[key], ['calculation', key])
  value.calculation.details.forEach((row, index) => validate(row.value, ['calculation', 'details', index, 'value']))
  value.calculation.explanation.forEach((step, index) => {
    validate(step.total.value, ['calculation', 'explanation', index, 'total', 'value'])
    step.rows.forEach((row, rowIndex) => { if (row.format !== 'percent') validate(row.value, ['calculation', 'explanation', index, 'rows', rowIndex, 'value']) })
    for (const [key, amount] of Object.entries(step.noteValues ?? {})) if (amount !== undefined) validate(amount, ['calculation', 'explanation', index, 'noteValues', key])
  })
})
export type AutomatedPaymentCalculationEvidence = z.infer<typeof AutomatedPaymentCalculationEvidenceSchema>

export const AutomatedPaymentExtensionPayloadSchema = z.object({
  releaseHoldback: z.boolean().default(false),
  holdbackReleaseAmount: AutomatedPaymentMoneySchema.optional()
}).refine(value => !value.releaseHoldback || value.holdbackReleaseAmount !== undefined, { message: 'GCS_AUTOMATED_PAYMENTS_MONEY_INVALID', path: ['holdbackReleaseAmount'] })
  .transform(value => value.releaseHoldback ? value : { releaseHoldback: false })
export const AutomatedPaymentIdentitySchema = z.object({
  egcs_fc_commitmenttype: AutomatedPaymentPositiveBigintIdSchema,
  egcs_fc_fiscalyear: AutomatedPaymentPositiveBigintIdSchema,
  egcs_fc_paymenttype: z.enum(automatedPaymentTypes),
  egcs_fc_currency: AutomatedPaymentCurrencySchema,
  egcs_fc_periodstart: z.coerce.number().int().min(0).max(11),
  egcs_fc_periodend: z.coerce.number().int().min(0).max(11)
}).refine(value => value.egcs_fc_periodstart <= value.egcs_fc_periodend, { message: 'GCS_AUTOMATED_PAYMENTS_PERIOD_RANGE_INVALID', path: ['egcs_fc_periodend'] })
export const AutomatedPaymentCalculateSchema = AutomatedPaymentIdentitySchema.safeExtend({
  egcs_fc_paymentamount: AutomatedPaymentMoneySchema.optional(),
  extensions: z.record(z.string(), z.json()).optional()
}).superRefine((value, ctx) => {
  if (value.egcs_fc_paymentamount !== undefined && value.egcs_fc_paymentamount.currency !== value.egcs_fc_currency.toUpperCase()) {
    ctx.addIssue({ code: 'custom', message: 'GCS_AUTOMATED_PAYMENTS_CURRENCY_MISMATCH', path: ['egcs_fc_paymentamount'] })
  }
  const payload = value.extensions?.[EXTENSION_KEY]
  if (payload === undefined) return
  const parsed = AutomatedPaymentExtensionPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: ['extensions', EXTENSION_KEY, ...issue.path] })
  } else if (parsed.data.holdbackReleaseAmount !== undefined && parsed.data.holdbackReleaseAmount.currency !== value.egcs_fc_currency.toUpperCase()) {
    ctx.addIssue({ code: 'custom', message: 'GCS_AUTOMATED_PAYMENTS_CURRENCY_MISMATCH', path: ['extensions', EXTENSION_KEY, 'holdbackReleaseAmount'] })
  }
})
export const parseAutomatedPaymentsStreamConfig = (value: unknown): AutomatedPaymentsStreamConfig => {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return { enabledPaymentTypes: Array.isArray(raw.enabledPaymentTypes) ? raw.enabledPaymentTypes.filter((item): item is AutomatedPaymentType => item === 'reimbursement' || item === 'advance') : defaultConfig.enabledPaymentTypes }
}
export const parseAutomatedPaymentExtensionPayload = (value: unknown): AutomatedPaymentExtensionPayload => {
  if (value === undefined) return { releaseHoldback: false }
  return AutomatedPaymentExtensionPayloadSchema.parse(value)
}
