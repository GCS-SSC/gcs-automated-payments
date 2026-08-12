import { describe, expect, it, vi } from 'vitest'
import { getAgreementHoldbackSettings } from '../../server/calculation-data'

const createQuery = (row: Record<string, unknown> | undefined) => {
  const query: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const method of ['selectFrom', 'innerJoin', 'select', 'where']) {
    query[method] = vi.fn(() => query)
  }
  query.executeTakeFirst = vi.fn().mockResolvedValue(row)
  return query
}

describe('automated payment calculation data', () => {
  it('scopes stable fiscal-year joins to the current agreement budget version', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(
      new URL('../../server/calculation-data.ts', import.meta.url),
      'utf8'
    ))

    expect(source.match(/Funding_Case_Agreement_Budget_Version\.egcs_fc_iscurrent/g)).toHaveLength(5)
    expect(source.match(/Funding_Case_Agreement_Budget_Version\._deleted/g)).toHaveLength(5)
  })
  it('derives final-fiscal-year from the agency language-independent code', async () => {
    const db = createQuery({
      egcs_fc_holdback: 12.5,
      holdback_basis_code: 'final-fiscal-year'
    })

    await expect(getAgreementHoldbackSettings(db as never, 'agreement-1')).resolves.toEqual({
      holdbackPercent: 12.5,
      holdbackBasis: 'final-fiscal-year'
    })
    expect(db.innerJoin).toHaveBeenCalledWith(
      'Transfer_Payment_Stream_Holdback_Basis',
      'Transfer_Payment_Stream_Holdback_Basis.id',
      'Funding_Case_Agreement_Profile.egcs_fc_holdbackbasis'
    )
    expect(db.innerJoin).toHaveBeenCalledWith(
      'Agency_Holdback_Basis',
      'Agency_Holdback_Basis.id',
      'Transfer_Payment_Stream_Holdback_Basis.egcs_tp_agencyholdback'
    )
  })

  it('uses agreement-total for that semantic code without comparing the foreign-key id', async () => {
    const db = createQuery({
      egcs_fc_holdback: '10',
      holdback_basis_code: 'agreement-total'
    })

    await expect(getAgreementHoldbackSettings(db as never, 'agreement-1')).resolves.toEqual({
      holdbackPercent: 10,
      holdbackBasis: 'agreement-total'
    })
  })

  it('fails closed when the agreement basis does not resolve to a supported semantic code', async () => {
    const db = createQuery({
      egcs_fc_holdback: 10,
      holdback_basis_code: 'custom-basis'
    })

    await expect(getAgreementHoldbackSettings(db as never, 'agreement-1')).rejects.toMatchObject({
      code: 'GCS_AUTOMATED_PAYMENTS_UNSUPPORTED_HOLDBACK_BASIS'
    })
  })
})
