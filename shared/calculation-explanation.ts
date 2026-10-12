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
      const percentage = row.value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
      const value = row.format === 'percent'
        ? `${locale === 'fr' ? percentage.replace('.', ',') : percentage}%`
        : formatMoney(row.value)
      return {
        label: t(row.label as keyof typeof messages.en),
        value: row.operator && row.value.startsWith('-') ? `(${value})` : value,
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
export const formatCalculationMoney = (value: string, currency: string, locale: string): string => {
  const [integer = '0', fraction = '00'] = value.split('.')
  const negative = integer.startsWith('-')
  const digits = negative ? integer.slice(1) : integer
  const isFrench = locale === 'fr'
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, isFrench ? '\u00a0' : ',')
  const amount = `${grouped}${isFrench ? ',' : '.'}${fraction}`
  return isFrench ? `${negative ? '-' : ''}${amount}\u00a0$ ${currency}` : `${currency} ${negative ? '-' : ''}$${amount}`
}
