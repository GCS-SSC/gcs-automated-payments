import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql, type Generated } from 'kysely'
import { Pool } from 'pg'
import { lockAutomatedPaymentAgreement, savePaymentMetadata } from '../../server/calculation-data'

type Db = {
  Funding_Case_Agreement_Payment: { id: string, egcs_fc_paymentamount: string, _deleted: boolean }
  Common_Entity_Assignment: { id: Generated<string>, egcs_cn_entityid: string, _deleted: boolean }
  'extensions.kv_entry': { id: string, extension_key: string, owner_type: string, owner_id: string, config_key: string, value: unknown, _deleted: boolean }
}

const postgresUrl = process.env.AUTOMATED_PAYMENTS_POSTGRES_TEST_URL
const schemaName = 'automated_payment_atomicity_test'
const requireUrl = () => {
  if (!postgresUrl || !new URL(postgresUrl).pathname.endsWith('_test')) throw new Error('AUTOMATED_PAYMENTS_POSTGRES_TEST_URL must target a disposable *_test database.')
  return postgresUrl
}
const createDb = (scoped = true) => new Kysely<Db>({ dialect: new PostgresDialect({ pool: new Pool({
  connectionString: requireUrl(), max: 2, ...(scoped ? { options: `-c search_path=${schemaName},public` } : {})
}) }) })

describe('Automated Payments host-transaction participation', () => {
  let admin: Kysely<Db>
  let db: Kysely<Db>
  let concurrentDb: Kysely<Db>
  beforeAll(async () => {
    admin = createDb(false); db = createDb(); concurrentDb = createDb()
    await admin.schema.dropSchema(schemaName).ifExists().cascade().execute()
    await admin.schema.createSchema(schemaName).execute()
    const schema = admin.schema.withSchema(schemaName)
    await schema.createTable('Funding_Case_Agreement_Payment').addColumn('id', 'bigint', col => col.primaryKey()).addColumn('egcs_fc_paymentamount', 'numeric(19, 2)', col => col.notNull()).addColumn('_deleted', 'boolean', col => col.notNull().defaultTo(false)).execute()
    await schema.createTable('Common_Entity_Assignment').addColumn('id', 'bigserial', col => col.primaryKey()).addColumn('egcs_cn_entityid', 'bigint', col => col.notNull()).addColumn('_deleted', 'boolean', col => col.notNull().defaultTo(false)).execute()
    await sql`CREATE SCHEMA IF NOT EXISTS extensions`.execute(db)
    await sql`CREATE TABLE IF NOT EXISTS extensions.kv_entry (id bigserial PRIMARY KEY, extension_key text NOT NULL, owner_type text NOT NULL, owner_id bigint NOT NULL, config_key text NOT NULL, value jsonb NOT NULL, _deleted boolean NOT NULL DEFAULT false)`.execute(db)
  })
  afterAll(async () => { await concurrentDb.destroy(); await db.destroy(); await admin.schema.dropSchema(schemaName).ifExists().cascade().execute(); await admin.destroy() })
  beforeEach(async () => {
    await db.deleteFrom('extensions.kv_entry').execute()
    await db.deleteFrom('Common_Entity_Assignment').execute()
    await db.deleteFrom('Funding_Case_Agreement_Payment').execute()
  })

  const create = async (failure?: 'before' | 'after') => await db.transaction().execute(async trx => {
    if (failure === 'before') throw new Error('ceiling rejected')
    await trx.insertInto('Funding_Case_Agreement_Payment').values({ id: '91', egcs_fc_paymentamount: '0.30', _deleted: false }).execute()
    await trx.insertInto('Common_Entity_Assignment').values({ egcs_cn_entityid: '91', _deleted: false }).execute()
    await savePaymentMetadata(trx as never, '91', { releaseHoldback: false, holdbackReleaseAmount: '0.00' })
    if (failure === 'after') throw new Error('later hook failed')
  })
  const counts = async () => ({
    payments: Number((await db.selectFrom('Funding_Case_Agreement_Payment').select(eb => eb.fn.count('id').as('count')).executeTakeFirstOrThrow()).count),
    assignments: Number((await db.selectFrom('Common_Entity_Assignment').select(eb => eb.fn.count('id').as('count')).executeTakeFirstOrThrow()).count),
    metadata: Number((await db.selectFrom('extensions.kv_entry').select(eb => eb.fn.count('id').as('count')).executeTakeFirstOrThrow()).count)
  })

  it('commits exactly one Payment, primary assignment, and metadata row', async () => {
    await create()
    expect(await counts()).toEqual({ payments: 1, assignments: 1, metadata: 1 })
  })
  it.each(['before', 'after'] as const)('leaves zero residue when the %s-create phase fails', async failure => {
    await expect(create(failure)).rejects.toThrow()
    expect(await counts()).toEqual({ payments: 0, assignments: 0, metadata: 0 })
  })

  it.each(['0.10', '0.20', '99999999999999999.99'])(
    'preserves canonical metadata money %s through commit and reload',
    async amount => {
      await db.transaction().execute(async trx => {
        await trx.insertInto('Funding_Case_Agreement_Payment').values({
          id: '92', egcs_fc_paymentamount: amount, _deleted: false
        }).execute()
        await savePaymentMetadata(trx as never, '92', {
          releaseHoldback: true,
          holdbackReleaseAmount: amount
        })
      })

      const payment = await sql<{ amount: string }>`
        SELECT egcs_fc_paymentamount::text AS amount
        FROM "Funding_Case_Agreement_Payment"
        WHERE id = 92
      `.execute(db)
      const metadata = await db.selectFrom('extensions.kv_entry')
        .select('value').where('owner_id', '=', '92').executeTakeFirstOrThrow()
      expect(payment.rows[0]?.amount).toBe(amount)
      expect(metadata.value).toEqual({ releaseHoldback: true, holdbackReleaseAmount: amount })
    }
  )

  it('rolls back exact Payment and metadata together after the final write fails', async () => {
    await expect(db.transaction().execute(async trx => {
      await trx.insertInto('Funding_Case_Agreement_Payment').values({
        id: '93', egcs_fc_paymentamount: '0.10', _deleted: false
      }).execute()
      await savePaymentMetadata(trx as never, '93', {
        releaseHoldback: false,
        holdbackReleaseAmount: '0.00'
      })
      throw new Error('forced final-row failure')
    })).rejects.toThrow('forced final-row failure')

    expect(await db.selectFrom('Funding_Case_Agreement_Payment').select('id').where('id', '=', '93').executeTakeFirst()).toBeUndefined()
    expect(await db.selectFrom('extensions.kv_entry').select('id').where('owner_id', '=', '93').executeTakeFirst()).toBeUndefined()
  })

  it('serializes competing mutations for the same Agreement advisory key', async () => {
    let releaseFirstLock!: () => void
    const firstCanFinish = new Promise<void>(resolve => { releaseFirstLock = resolve })
    let firstHasLock!: () => void
    const firstLocked = new Promise<void>(resolve => { firstHasLock = resolve })

    const first = db.transaction().execute(async trx => {
      await lockAutomatedPaymentAgreement(trx as never, '100')
      firstHasLock()
      await firstCanFinish
    })
    await firstLocked

    let secondAcquired = false
    const second = concurrentDb.transaction().execute(async trx => {
      await lockAutomatedPaymentAgreement(trx as never, '100')
      secondAcquired = true
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(secondAcquired).toBe(false)
    releaseFirstLock()
    await Promise.all([first, second])
    expect(secondAcquired).toBe(true)
  })

  it('allows independent Agreement advisory keys to proceed concurrently', async () => {
    await db.transaction().execute(async firstTrx => {
      await lockAutomatedPaymentAgreement(firstTrx as never, '100')
      await expect(concurrentDb.transaction().execute(async secondTrx => {
        await lockAutomatedPaymentAgreement(secondTrx as never, '101')
      })).resolves.toBeUndefined()
    })
  })
})
