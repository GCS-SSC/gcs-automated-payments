import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql, type Generated } from 'kysely'
import { Pool } from 'pg'
import { savePaymentMetadata } from '../../server/calculation-data'

type Db = {
  Funding_Case_Agreement_Payment: { id: string, _deleted: boolean }
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
  beforeAll(async () => {
    admin = createDb(false); db = createDb()
    await admin.schema.dropSchema(schemaName).ifExists().cascade().execute()
    await admin.schema.createSchema(schemaName).execute()
    const schema = admin.schema.withSchema(schemaName)
    await schema.createTable('Funding_Case_Agreement_Payment').addColumn('id', 'bigint', col => col.primaryKey()).addColumn('_deleted', 'boolean', col => col.notNull().defaultTo(false)).execute()
    await schema.createTable('Common_Entity_Assignment').addColumn('id', 'bigserial', col => col.primaryKey()).addColumn('egcs_cn_entityid', 'bigint', col => col.notNull()).addColumn('_deleted', 'boolean', col => col.notNull().defaultTo(false)).execute()
    await sql`CREATE SCHEMA IF NOT EXISTS extensions`.execute(db)
    await sql`CREATE TABLE IF NOT EXISTS extensions.kv_entry (id bigserial PRIMARY KEY, extension_key text NOT NULL, owner_type text NOT NULL, owner_id bigint NOT NULL, config_key text NOT NULL, value jsonb NOT NULL, _deleted boolean NOT NULL DEFAULT false)`.execute(db)
  })
  afterAll(async () => { await db.destroy(); await admin.schema.dropSchema(schemaName).ifExists().cascade().execute(); await admin.destroy() })
  beforeEach(async () => {
    await db.deleteFrom('extensions.kv_entry').execute()
    await db.deleteFrom('Common_Entity_Assignment').execute()
    await db.deleteFrom('Funding_Case_Agreement_Payment').execute()
  })

  const create = async (failure?: 'before' | 'after') => await db.transaction().execute(async trx => {
    if (failure === 'before') throw new Error('ceiling rejected')
    await trx.insertInto('Funding_Case_Agreement_Payment').values({ id: '91', _deleted: false }).execute()
    await trx.insertInto('Common_Entity_Assignment').values({ egcs_cn_entityid: '91', _deleted: false }).execute()
    await savePaymentMetadata(trx as never, '91', { releaseHoldback: false, holdbackReleaseAmount: 0 })
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
})
