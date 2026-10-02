import { z } from 'zod'

export const EXTENSION_KEY = 'gcs-automated-payments'
const automatedPaymentTypes = ['reimbursement', 'advance'] as const
export type AutomatedPaymentType = (typeof automatedPaymentTypes)[number]
const holdbackBasisValues = ['fullagreement', 'finalfiscal'] as const
export type HoldbackBasis = (typeof holdbackBasisValues)[number]

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

export interface AutomatedPaymentsHoldbackSettings { holdbackPercent: number, holdbackBasis: HoldbackBasis }
export interface AutomatedPaymentsStreamConfig { enabledPaymentTypes: AutomatedPaymentType[] }
export interface AutomatedPaymentExtensionPayload { releaseHoldback: boolean, holdbackReleaseAmount: AutomatedPaymentMoney }
export interface AutomatedPaymentCalculationInput {
  currency?: string
  paymentType: AutomatedPaymentType
  periodEnd: number
  totalClaimsToLastClaimMonth: AutomatedPaymentMoneyInput
  totalPaymentsToDate: AutomatedPaymentMoneyInput
  totalForecastToLastClaimMonth: AutomatedPaymentMoneyInput
  totalForecastToPeriodEnd: AutomatedPaymentMoneyInput
  commitmentRemaining: AutomatedPaymentMoneyInput
  agreementTotal: AutomatedPaymentMoneyInput
  finalFiscalYearTotal: AutomatedPaymentMoneyInput
  /** Gross unpaid eligible funding, before applying this calculation's holdback reserve. */
  availableForDisbursementBeforeHoldback: AutomatedPaymentMoneyInput
  releaseHoldback?: boolean
  holdbackReleaseAmount?: AutomatedPaymentMoneyInput
}
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

/**
 * Applies the Agreement's numeric(5,2) percentage, rounding down to whole dollars.
 * @param basis Exact aggregate funding for the selected holdback basis.
 * @param percent Persisted holdback percentage between zero and 100, with at most two fractional digits.
 * @returns Exact holdback ending in .00, without a single-row bound on aggregate funding.
 */
export const calculateAutomatedPaymentHoldbackAmount = (basis: AutomatedPaymentMoney, percent: number): AutomatedPaymentMoney => {
  const basisCents = toCents(basis)
  const percentageHundredths = toCents(String(percent))
  if (basisCents < BigInt(0) || percentageHundredths < BigInt(0) || percentageHundredths > BigInt(10000)) {
    throw new RangeError('Holdback requires a nonnegative basis and a percentage between zero and 100.')
  }
  const wholeDollars = basisCents * percentageHundredths / BigInt(1000000)
  return fromCents(wholeDollars * BigInt(100))
}
/**
 * Preserves aggregate decimal text while retaining safe numeric-input validation.
 * @param value Exact derived amount or a safely representable numeric amount.
 * @returns Canonical exact aggregate money.
 */
const parseCalculationMoney = (value: AutomatedPaymentMoneyInput): AutomatedPaymentMoney => typeof value === 'string'
  ? parseAutomatedPaymentAggregateMoney(value)
  : parseAutomatedPaymentMoney(value)
const maxZero = (value: AutomatedPaymentMoney) => compareAutomatedPaymentMoney(value, ZERO_AUTOMATED_PAYMENT_MONEY) < 0 ? ZERO_AUTOMATED_PAYMENT_MONEY : value
const minMoney = (values: AutomatedPaymentMoney[]) => values.reduce((a, b) => compareAutomatedPaymentMoney(a, b) <= 0 ? a : b)
export const calculateAutomatedPaymentAmount = (input: AutomatedPaymentCalculationInput, settings: AutomatedPaymentsHoldbackSettings): AutomatedPaymentCalculationResult => {
  const currency = AutomatedPaymentCurrencySchema.parse(input.currency)
  const claims = parseCalculationMoney(input.totalClaimsToLastClaimMonth)
  const payments = parseCalculationMoney(input.totalPaymentsToDate)
  const forecastLastClaim = parseCalculationMoney(input.totalForecastToLastClaimMonth)
  const forecastPeriodEnd = parseCalculationMoney(input.totalForecastToPeriodEnd)
  const commitmentRemaining = parseCalculationMoney(input.commitmentRemaining)
  const agreementTotal = parseCalculationMoney(input.agreementTotal)
  const finalFiscalYearTotal = parseCalculationMoney(input.finalFiscalYearTotal)
  const available = parseCalculationMoney(input.availableForDisbursementBeforeHoldback)
  const base = input.paymentType === 'advance'
    ? subtractAutomatedPaymentMoney(addAutomatedPaymentMoney(subtractAutomatedPaymentMoney(claims, forecastLastClaim), forecastPeriodEnd), payments)
    : subtractAutomatedPaymentMoney(claims, payments)
  const holdbackAmount = calculateAutomatedPaymentHoldbackAmount(settings.holdbackBasis === 'finalfiscal' ? finalFiscalYearTotal : agreementTotal, settings.holdbackPercent)
  const requested = input.releaseHoldback ? parseAutomatedPaymentMoney(input.holdbackReleaseAmount ?? ZERO_AUTOMATED_PAYMENT_MONEY) : ZERO_AUTOMATED_PAYMENT_MONEY
  const unpaidEligibleBalance = maxZero(available)
  const currentReserve = minMoney([holdbackAmount, unpaidEligibleBalance])
  const holdbackReleaseAmount = minMoney([maxZero(requested), currentReserve])
  const availableBeforeHoldback = subtractAutomatedPaymentMoney(unpaidEligibleBalance, currentReserve)
  const baseAmount = maxZero(base)
  const ceilingAmount = maxZero(minMoney([
    baseAmount,
    commitmentRemaining,
    addAutomatedPaymentMoney(availableBeforeHoldback, holdbackReleaseAmount),
    fromCents(MAX_ROW_CENTS)
  ]))
  return { baseAmount, ceilingAmount, suggestedAmount: ceilingAmount, holdbackAmount, holdbackReleaseAmount, availableBeforeHoldback, currency: currency.toUpperCase(), details: [
    { label: 'baseAmount', value: baseAmount }, { label: 'commitmentRemaining', value: commitmentRemaining },
    { label: 'availableBeforeHoldback', value: availableBeforeHoldback }, { label: 'holdbackReleaseAmount', value: holdbackReleaseAmount },
    { label: 'totalClaimsToLastClaimMonth', value: claims }, { label: 'totalForecastToLastClaimMonth', value: forecastLastClaim },
    { label: 'totalForecastToPeriodEnd', value: forecastPeriodEnd }, { label: 'totalPaymentsToDate', value: payments }
  ] }
}
