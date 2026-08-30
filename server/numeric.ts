import { sql, type Expression, type RawBuilder } from 'kysely'
import {
  parseAutomatedPaymentAggregateMoney,
  parseAutomatedPaymentMoney,
  type AutomatedPaymentMoney
} from '../shared/automated-payments.ts'

export const databaseNumericText = (expression: Expression<unknown>): RawBuilder<string> => sql<string>`CAST(${expression} AS text)`
export const parseDatabaseMoney = (value: unknown): AutomatedPaymentMoney => {
  if (typeof value !== 'string') throw new TypeError('Database money must be selected as text.')
  return parseAutomatedPaymentMoney(value)
}
export const parseDatabaseAggregateMoney = (value: unknown): AutomatedPaymentMoney => {
  if (typeof value !== 'string') throw new TypeError('Database aggregate money must be selected as text.')
  return parseAutomatedPaymentAggregateMoney(value)
}
export const databaseMoneyValue = (value: AutomatedPaymentMoney): RawBuilder<string> =>
  sql<string>`CAST(${value} AS numeric(19, 2))`
