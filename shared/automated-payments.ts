import { z } from 'zod'

export const EXTENSION_KEY = 'gcs-automated-payments'
const automatedPaymentTypes = ['reimbursement', 'advance'] as const
export type AutomatedPaymentType = (typeof automatedPaymentTypes)[number]

declare const moneyBrand: unique symbol
export type AutomatedPaymentMoney = string & { readonly [moneyBrand]: true }
export type AutomatedPaymentMoneyInput = string | number
const MONEY_INPUT = /^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/
const MAX_ROW_CENTS = BigInt('9999999999999999999')
export const ZERO_AUTOMATED_PAYMENT_MONEY = '0.00' as AutomatedPaymentMoney
// Host payment creation validates its owning currency enum. The calculator and
// SDK transport native lower-case three-letter codes without importing host internals.
export const AutomatedPaymentCurrencySchema = z.string().regex(/^[a-z]{3}$/).default('cad')

const toCents = (value: string, bounded = false): bigint => {
  if (!MONEY_INPUT.test(value)) throw new TypeError('Money must be an exact decimal with at most two fractional digits.')
  const negative = value.startsWith('-')
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.')
  const cents = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, '0'))
  const signed = negative ? -cents : cents
  if (bounded && (signed > MAX_ROW_CENTS || signed < -MAX_ROW_CENTS)) throw new RangeError('Money exceeds numeric(19,2).')
  return signed
}
const fromCents = (cents: bigint): AutomatedPaymentMoney => {
  const negative = cents < BigInt(0)
  const absolute = negative ? -cents : cents
  return `${negative ? '-' : ''}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, '0')}` as AutomatedPaymentMoney
}
export const tryParseAutomatedPaymentMoney = (value: unknown): AutomatedPaymentMoney | null => {
  try {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return null
      const cents = toCents(String(value), true)
      if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < BigInt(Number.MIN_SAFE_INTEGER)) return null
      return fromCents(cents)
    }
    return typeof value === 'string' ? fromCents(toCents(value, true)) : null
  } catch { return null }
}
export const parseAutomatedPaymentMoney = (value: string | number): AutomatedPaymentMoney => {
  const parsed = tryParseAutomatedPaymentMoney(value)
  if (parsed === null) throw new TypeError('Invalid exact money value.')
  return parsed
}
export const parseAutomatedPaymentAggregateMoney = (value: string): AutomatedPaymentMoney => fromCents(toCents(value))
export const AutomatedPaymentMoneySchema = z.union([z.string(), z.number()]).transform((value, ctx) => {
  const parsed = tryParseAutomatedPaymentMoney(value)
  if (parsed !== null) return parsed
  ctx.addIssue({ code: 'custom', message: 'GCS_AUTOMATED_PAYMENTS_MONEY_INVALID' })
  return z.NEVER
})
export const addAutomatedPaymentMoney = (a: AutomatedPaymentMoney, b: AutomatedPaymentMoney) => fromCents(toCents(a) + toCents(b))
export const subtractAutomatedPaymentMoney = (a: AutomatedPaymentMoney, b: AutomatedPaymentMoney) => fromCents(toCents(a) - toCents(b))
export const compareAutomatedPaymentMoney = (a: AutomatedPaymentMoney, b: AutomatedPaymentMoney) => toCents(a) < toCents(b) ? -1 : toCents(a) > toCents(b) ? 1 : 0
export const sumAutomatedPaymentMoney = (values: AutomatedPaymentMoney[]) => values.reduce(addAutomatedPaymentMoney, ZERO_AUTOMATED_PAYMENT_MONEY)

export interface AutomatedPaymentsStreamConfig { enabledPaymentTypes: AutomatedPaymentType[] }
export interface AutomatedPaymentExtensionPayload { releaseHoldback: boolean, holdbackReleaseAmount: AutomatedPaymentMoney }
export interface AutomatedPaymentCalculationResult {
  baseAmount: AutomatedPaymentMoney
  ceilingAmount: AutomatedPaymentMoney
  suggestedAmount: AutomatedPaymentMoney
  holdbackAmount: AutomatedPaymentMoney
  holdbackReleaseAmount: AutomatedPaymentMoney
  availableBeforeHoldback: AutomatedPaymentMoney
  currency: string
  details: Array<{ label: string, value: AutomatedPaymentMoney }>
}

const CalculationEvidenceMoneySchema = z.string().regex(/^-?(?:0|[1-9]\d*)\.\d{2}$/)
  .transform(parseAutomatedPaymentAggregateMoney)
export const AutomatedPaymentCalculationEvidenceSchema = z.object({
  version: z.literal(1),
  capturedAt: z.iso.datetime(),
  input: z.object({
    fiscalYearId: z.string(), commitmentTypeId: z.string(),
    paymentType: z.enum(automatedPaymentTypes), periodEnd: z.number().int().min(0).max(11),
    currency: z.string().regex(/^[a-z]{3}$/)
  }),
  calculation: z.object({
    enabled: z.boolean(), currency: z.string().regex(/^[A-Z]{3}$/),
    baseAmount: CalculationEvidenceMoneySchema, ceilingAmount: CalculationEvidenceMoneySchema,
    suggestedAmount: CalculationEvidenceMoneySchema, holdbackAmount: CalculationEvidenceMoneySchema,
    holdbackReleaseAmount: CalculationEvidenceMoneySchema, availableBeforeHoldback: CalculationEvidenceMoneySchema,
    details: z.array(z.object({
      label: z.enum(['baseAmount', 'commitmentRemaining', 'availableBeforeHoldback', 'holdbackReleaseAmount',
        'totalClaimsToLastClaimMonth', 'totalForecastToLastClaimMonth', 'totalForecastToPeriodEnd', 'totalPaymentsToDate']),
      value: CalculationEvidenceMoneySchema
    }))
  })
})
export type AutomatedPaymentCalculationEvidence = z.infer<typeof AutomatedPaymentCalculationEvidenceSchema>

const defaultConfig: AutomatedPaymentsStreamConfig = { enabledPaymentTypes: ['reimbursement', 'advance'] }
const defaultPayload: AutomatedPaymentExtensionPayload = { releaseHoldback: false, holdbackReleaseAmount: ZERO_AUTOMATED_PAYMENT_MONEY }
const MAX_BIGINT = '9223372036854775807'
const positiveBigint = (value: string) => /^[1-9]\d*$/.test(value) && (value.length < MAX_BIGINT.length || (value.length === MAX_BIGINT.length && value <= MAX_BIGINT))
export const AutomatedPaymentPositiveBigintIdSchema = z.preprocess(value => {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return value
}, z.string().refine(positiveBigint))
export const AutomatedPaymentExtensionPayloadSchema = z.object({
  releaseHoldback: z.boolean().default(false),
  holdbackReleaseAmount: z.preprocess(value => value === '' || value === undefined || value === null ? ZERO_AUTOMATED_PAYMENT_MONEY : value, AutomatedPaymentMoneySchema.default(ZERO_AUTOMATED_PAYMENT_MONEY))
}).transform(value => ({ releaseHoldback: value.releaseHoldback, holdbackReleaseAmount: value.releaseHoldback ? value.holdbackReleaseAmount : ZERO_AUTOMATED_PAYMENT_MONEY }))
export const AutomatedPaymentCalculateSchema = z.object({
  egcs_fc_commitmenttype: AutomatedPaymentPositiveBigintIdSchema,
  egcs_fc_fiscalyear: AutomatedPaymentPositiveBigintIdSchema,
  egcs_fc_paymenttype: z.enum(automatedPaymentTypes),
  egcs_fc_currency: AutomatedPaymentCurrencySchema,
  egcs_fc_periodstart: z.coerce.number().int().min(0).max(11),
  egcs_fc_periodend: z.coerce.number().int().min(0).max(11),
  egcs_fc_paymentamount: AutomatedPaymentMoneySchema.optional(),
  extensions: z.record(z.string(), z.json()).optional()
}).refine(value => value.egcs_fc_periodstart <= value.egcs_fc_periodend, { message: 'GCS_AUTOMATED_PAYMENTS_PERIOD_RANGE_INVALID', path: ['egcs_fc_periodend'] }).superRefine((value, ctx) => {
  const payload = value.extensions?.[EXTENSION_KEY]
  if (payload === undefined) return
  const parsed = AutomatedPaymentExtensionPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: ['extensions', EXTENSION_KEY, ...issue.path] })
  }
})
export const parseAutomatedPaymentsStreamConfig = (value: unknown): AutomatedPaymentsStreamConfig => {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return { enabledPaymentTypes: Array.isArray(raw.enabledPaymentTypes) ? raw.enabledPaymentTypes.filter((item): item is AutomatedPaymentType => item === 'reimbursement' || item === 'advance') : defaultConfig.enabledPaymentTypes }
}
export const parseAutomatedPaymentExtensionPayload = (value: unknown): AutomatedPaymentExtensionPayload => {
  const parsed = AutomatedPaymentExtensionPayloadSchema.safeParse(value)
  return parsed.success ? parsed.data : defaultPayload
}
