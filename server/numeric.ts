import { sql, type Expression, type RawBuilder } from 'kysely'
import { isPersistableMoney, moneyFromMinorUnits, parseMinorUnits, type Money } from '@gcs-ssc/extensions/money'

export const databaseNumericText = (expression: Expression<unknown>): RawBuilder<string> => sql<string>`CAST(${expression} AS text)`
export const parseDatabaseMoney = (value: unknown, currency: string): Money => {
  if (typeof value !== 'string') throw new TypeError('Database money must be selected as text.')
  return moneyFromMinorUnits(parseMinorUnits(value), currency)
}
export const databaseMoneyValue = (value: Money): RawBuilder<string> => {
  if (!isPersistableMoney(value)) throw new RangeError('Money exceeds the persisted minor-unit range.')
  return sql<string>`CAST(${value.amount} AS numeric)`
}
