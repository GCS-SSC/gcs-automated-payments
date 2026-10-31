import { formatMoneyText, parseDecimalText, type Money } from '@gcs-ssc/extensions/money'
import type { AutomatedPaymentCalculationResult, AutomatedPaymentMoney } from './automated-payments'
import type { messages } from '../i18n/messages'

/**
 * Localizes saved or preview ledger semantics through the extension catalog.
 * @param explanation Exact raw calculation steps.
 * @param locale Current interface locale.
 * @param t Extension catalog translator.
 * @param formatMoney Exact currency formatter.
 * @returns Localized rows and totals for the shared renderer.
 */
export const formatCalculationExplanation = (
  explanation: AutomatedPaymentCalculationResult['explanation'],
  locale: string,
  t: (key: keyof typeof messages.en, values?: Record<string, string>) => string,
  formatMoney: (value: AutomatedPaymentMoney) => string
) => {
  return explanation?.map(step => ({
    label: t(step.label as keyof typeof messages.en),
    rows: step.rows.map(row => {
      const value = row.format === 'percent'
        ? `${locale === 'fr' ? parseDecimalText(row.value).replace('.', ',') : parseDecimalText(row.value)}%`
        : formatMoney(row.value)
      return {
        label: t(row.label as keyof typeof messages.en),
        value: row.operator && (row.format === 'percent' ? row.value : row.value.amount).startsWith('-') ? `(${value})` : value,
        ...(row.operator ? { operator: row.operator } : {})
      }
    }),
    total: { label: t(step.total.label as keyof typeof messages.en), value: formatMoney(step.total.value) },
    ...(step.notes?.length
      ? { note: step.notes.map(key => t(key as keyof typeof messages.en,
          Object.fromEntries(Object.entries(step.noteValues ?? {}).map(([name, value]) => [name, formatMoney(value)])))).join(' ') }
      : {}),
    ...(step.emphasis ? { emphasis: true } : {})
  })) ?? []
}

/**
 * Formats exact decimal text consistently in the wizard and retained ledger.
 * @param value Canonical amount.
 * @param currency Uppercase currency denomination.
 * @param locale Current interface locale.
 * @returns Localized currency text without numeric conversion.
 */
export const formatCalculationMoney = (value: Money, locale: string): string => formatMoneyText(value, locale)
