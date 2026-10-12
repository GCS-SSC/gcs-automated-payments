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
  const entitlement = subtract(input.paymentType === 'advance'
    ? add(subtract(claims, forecastClaim), forecastPeriod)
    : claims, netPayments)
  const baseAmount = nonnegative(entitlement)
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
  const availableFunds = add(availableBeforeHoldback, holdbackReleaseAmount)
  const singlePaymentLimit = money('99999999999999999.99')
  const ceilingAmount = nonnegative(minimum(baseAmount, commitmentRemaining,
    availableFunds, singlePaymentLimit))
  const details = { baseAmount, commitmentRemaining, availableBeforeHoldback, holdbackReleaseAmount,
    totalClaimsToLastClaimMonth: claims, totalForecastToLastClaimMonth: forecastClaim,
    totalForecastToPeriodEnd: forecastPeriod, totalPaymentsToDate: payments, totalCreditMemos: credits,
    totalCreditMemosForReconciledPeriods: reconciledCredits }
  const paymentRows: NonNullable<AutomatedPaymentCalculationResult['explanation']>[number]['rows'] = [
    { label: 'explanation.claims', value: claims },
    ...(input.paymentType === 'advance'
      ? [
          { label: 'explanation.forecast', value: forecastPeriod, operator: '+' as const },
          { label: 'explanation.claimed_forecast', value: forecastClaim, operator: '−' as const }
        ]
      : []),
    { label: 'explanation.paid', value: payments, operator: '−' as const },
    { label: creditMemoBasis === 'all' ? 'credit_memo_basis.all' : 'credit_memo_basis.reconciled_periods', value: selectedCredits, operator: '+' as const }
  ].filter(row => compare(row.value, zero) !== 0)
  if (!paymentRows.length) paymentRows.push({ label: input.paymentType === 'advance' ? 'explanation.forecast' : 'explanation.claims', value: zero })
  if (paymentRows[0]?.operator === '+') delete paymentRows[0].operator
  const excludedCredits = subtract(credits, selectedCredits)
  const fundingRows: NonNullable<AutomatedPaymentCalculationResult['explanation']>[number]['rows'] = [
    { label: 'explanation.funding', value: money(values.availableForDisbursementBeforeHoldback) },
    ...(compare(excludedCredits, zero) !== 0 ? [{ label: 'explanation.unreconciled_credits', value: excludedCredits, operator: '−' as const }] : []),
    ...(compare(reserve, zero) !== 0 ? [{ label: 'explanation.reserved', value: reserve, operator: '−' as const }] : []),
    ...(input.releaseHoldback ? [{ label: 'explanation.released', value: holdbackReleaseAmount, operator: '+' as const }] : [])
  ]
  const limitingAmount = minimum(baseAmount, commitmentRemaining, availableFunds, singlePaymentLimit)
  const limitingReason = compare(limitingAmount, singlePaymentLimit) === 0
    ? 'explanation.limited_payment'
    : compare(limitingAmount, baseAmount) === 0
      ? 'explanation.limited_calculation'
      : compare(limitingAmount, commitmentRemaining) === 0 ? 'explanation.limited_commitment' : 'explanation.limited_funding'
  return { baseAmount, ceilingAmount, suggestedAmount: ceilingAmount, holdbackAmount,
    holdbackReleaseAmount, availableBeforeHoldback, currency: values.currency.toUpperCase(),
    details: Object.entries(details).map(([label, value]) => ({ label, value })),
    explanation: [
      { label: 'explanation.payment_calculation',
        rows: paymentRows, total: { label: 'explanation.payment_calculation', value: entitlement },
        ...(compare(entitlement, zero) < 0 ? { notes: ['explanation.nothing_payable'] } : {}) },
      ...(percentageHundredths > BigInt(0)
        ? [{ label: 'explanation.holdback', rows: [
            { label: values.holdbackBasis === 'finalfiscal' ? 'explanation.final_year' : 'explanation.agreement_total', value: basis },
            { label: 'explanation.holdback_rate', value: money(values.holdbackPercent), operator: '×' as const, format: 'percent' as const }
          ], total: { label: 'explanation.full_holdback', value: holdbackAmount },
          notes: [compare(reserve, holdbackAmount) < 0 ? 'explanation.reserve_limited' : 'explanation.rounded'],
          noteValues: { reserve } }]
        : []),
      { label: 'explanation.available_funds', rows: fundingRows,
        total: { label: 'explanation.available_funds', value: availableFunds },
        notes: [
          ...(compare(excludedCredits, zero) !== 0 ? ['explanation.credit_policy'] : []),
          ...(compare(money(values.availableForDisbursementBeforeHoldback), excludedCredits) < 0 ? ['explanation.availability_zero'] : []),
          ...(input.releaseHoldback && compare(requestedRelease, holdbackReleaseAmount) > 0 ? ['explanation.release_limited'] : [])
        ], noteValues: { requested: requestedRelease, released: holdbackReleaseAmount } },
      { label: 'explanation.payment_limits', emphasis: true,
        rows: [
          { label: 'explanation.payment_calculation', value: baseAmount },
          { label: 'explanation.commitment', value: commitmentRemaining },
          { label: 'explanation.available_funds', value: availableFunds },
          ...(compare(limitingAmount, singlePaymentLimit) === 0 ? [{ label: 'explanation.single_payment', value: singlePaymentLimit }] : [])
        ], total: { label: 'explanation.maximum', value: ceilingAmount }, notes: [limitingReason] }
    ] }
}
