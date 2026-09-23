import type { Kysely } from 'kysely'
import { createAutomatedPaymentsMissingHoldbackBasesError } from './errors'

type Db = Kysely<Record<string, Record<string, unknown>>>

export const REQUIRED_HOLDBACK_BASIS_TYPES = [
  'fullagreement',
  'finalfiscal'
] as const

/** Returns required holdback-basis types not actively configured for the stream. */
export const getMissingStreamHoldbackBasisTypes = async (
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
    .select('Agency_Holdback_Basis.egcs_ay_holdbackbasis as basis')
    .where('Transfer_Payment_Stream_Holdback_Basis.egcs_tp_transferpaymentstream', '=', streamId)
    .where('Transfer_Payment_Stream_Holdback_Basis._deleted', '=', false)
    .where('Agency_Holdback_Basis._deleted', '=', false)
    .where('Agency_Holdback_Basis.egcs_ay_holdbackbasis', 'in', [...REQUIRED_HOLDBACK_BASIS_TYPES])
    .execute() as Array<{ basis?: unknown }>

  const configuredTypes = new Set(rows.map(row => String(row.basis)))
  return REQUIRED_HOLDBACK_BASIS_TYPES.filter(basis => !configuredTypes.has(basis))
}

/** Refuses stream activation until all holdback bases required by automated payments exist. */
export const guardAutomatedPaymentsActivation = async (
  db: Db,
  streamId: string
): Promise<void> => {
  const missingTypes = await getMissingStreamHoldbackBasisTypes(db, streamId)
  if (missingTypes.length > 0) {
    throw createAutomatedPaymentsMissingHoldbackBasesError(missingTypes)
  }
}
