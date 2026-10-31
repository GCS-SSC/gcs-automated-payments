import { parseCurrencyMoney, type Money } from '@gcs-ssc/extensions/money'

/** Test data is authored in major units; production JSON always carries minor units. */
export const money = (value: string, currency = 'CAD'): Money => parseCurrencyMoney(value, currency)
