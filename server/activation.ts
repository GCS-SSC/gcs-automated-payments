import type { Kysely } from 'kysely'
import { createAutomatedPaymentsMissingHoldbackBasesError } from './errors'

type Db = Kysely<Record<string, Record<string, unknown>>>

export const REQUIRED_HOLDBACK_BASIS_CODES = [
  'agreement-total',
  'final-fiscal-year'
] as const

/** Returns required semantic holdback-basis codes not actively configured for the stream. */
export const getMissingStreamHoldbackBasisCodes = async (
  db: Db,
  streamId: string
): Promise<string[]> => {
  const rows = await db
    .selectFrom('Transfer_Payment_Stream_Holdback_Basis')
    .innerJoin(
      'Agency_Holdback_Basis',
      'Agency_Holdback_Basis.id',
      'Transfer_Payment_Stream_Holdback_Basis.egcs_tp_agencyholdback'
    )
    .select('Agency_Holdback_Basis.egcs_ay_languageindependentcode as code')
    .where('Transfer_Payment_Stream_Holdback_Basis.egcs_tp_transferpaymentstream', '=', streamId)
    .where('Transfer_Payment_Stream_Holdback_Basis._deleted', '=', false)
    .where('Agency_Holdback_Basis._deleted', '=', false)
    .where('Agency_Holdback_Basis.egcs_ay_languageindependentcode', 'in', [...REQUIRED_HOLDBACK_BASIS_CODES])
    .execute() as Array<{ code?: unknown }>

  const configuredCodes = new Set(rows.map(row => String(row.code)))
  return REQUIRED_HOLDBACK_BASIS_CODES.filter(code => !configuredCodes.has(code))
}

/** Refuses stream activation until all holdback bases required by automated payments exist. */
export const guardAutomatedPaymentsActivation = async (
  db: Db,
  streamId: string
): Promise<void> => {
  const missingCodes = await getMissingStreamHoldbackBasisCodes(db, streamId)
  if (missingCodes.length > 0) {
    throw createAutomatedPaymentsMissingHoldbackBasesError(missingCodes)
  }
}
