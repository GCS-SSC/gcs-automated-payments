import type { GcsExtensionPaymentCalculationResult } from '@gcs-ssc/extensions/server'
import {
  addAutomatedPaymentMoney as add, subtractAutomatedPaymentMoney as subtract,
  compareAutomatedPaymentMoney as compare, parseAutomatedPaymentAggregateMoney as money,
  parseAutomatedPaymentMoney, toCents, fromCents, ZERO_AUTOMATED_PAYMENT_MONEY as zero,
  type AutomatedPaymentMoney, type AutomatedPaymentCalculationResult, type AutomatedPaymentCreditMemoBasis
} from '../shared/automated-payments.ts'
import type { AutomatedPaymentServerInput } from './calculation-data.ts'

const nonnegative = (value: AutomatedPaymentMoney) => compare(value, zero) < 0 ? zero : value
const minimum = (...values: AutomatedPaymentMoney[]) => values.reduce((left, right) => compare(left, right) <= 0 ? left : right)

/** Applies entitlement, whole-dollar holdback and Payment limits to exact host inputs. */
export const calculateAutomatedPaymentValues = (
  values: GcsExtensionPaymentCalculationResult,
  input: Pick<AutomatedPaymentServerInput, 'paymentType' | 'releaseHoldback' | 'holdbackReleaseAmount'>,
  creditMemoBasis: AutomatedPaymentCreditMemoBasis
): AutomatedPaymentCalculationResult => {
  const claims = money(values.totalClaimsToLastClaimMonth)
  const payments = money(values.totalPaymentsToDate)
  const credits = money(values.totalCreditMemos)
  const reconciledCredits = money(values.totalCreditMemosForReconciledPeriods)
  const selectedCredits = creditMemoBasis === 'all' ? credits : reconciledCredits
  const forecastClaim = money(values.totalForecastToLastClaimMonth)
  const forecastPeriod = money(values.totalForecastToPeriodEnd)
  const netPayments = subtract(payments, selectedCredits)
  const baseAmount = nonnegative(subtract(input.paymentType === 'advance'
    ? add(subtract(claims, forecastClaim), forecastPeriod) : claims, netPayments))
  const basis = money(values.holdbackBasis === 'finalfiscal' ? values.finalFiscalYearTotal : values.agreementTotal)
  const percentageHundredths = toCents(money(values.holdbackPercent))
  if (toCents(basis) < BigInt(0) || percentageHundredths < BigInt(0) || percentageHundredths > BigInt(10000)) {
    throw new Error('Holdback requires a nonnegative basis and a percentage between zero and 100.')
  }
  const holdbackAmount = fromCents(toCents(basis) * percentageHundredths / BigInt(1000000) * BigInt(100))
  const unpaidEligibleBalance = nonnegative(subtract(money(values.availableForDisbursementBeforeHoldback), subtract(credits, selectedCredits)))
  const reserve = minimum(holdbackAmount, unpaidEligibleBalance)
  const requestedRelease = input.releaseHoldback ? nonnegative(parseAutomatedPaymentMoney(input.holdbackReleaseAmount ?? '0')) : zero
  const holdbackReleaseAmount = minimum(requestedRelease, reserve)
  const availableBeforeHoldback = subtract(unpaidEligibleBalance, reserve)
  const commitmentRemaining = money(values.commitmentRemaining)
  const ceilingAmount = nonnegative(minimum(baseAmount, commitmentRemaining,
    add(availableBeforeHoldback, holdbackReleaseAmount), money('99999999999999999.99')))
  const details = { baseAmount, commitmentRemaining, availableBeforeHoldback, holdbackReleaseAmount,
    totalClaimsToLastClaimMonth: claims, totalForecastToLastClaimMonth: forecastClaim,
    totalForecastToPeriodEnd: forecastPeriod, totalPaymentsToDate: payments, totalCreditMemos: credits,
    totalCreditMemosForReconciledPeriods: reconciledCredits }
  return { baseAmount, ceilingAmount, suggestedAmount: ceilingAmount, holdbackAmount,
    holdbackReleaseAmount, availableBeforeHoldback, currency: values.currency.toUpperCase(),
    details: Object.entries(details).map(([label, value]) => ({ label, value })) }
}
