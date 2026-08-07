import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getMissingStreamHoldbackBasisCodes,
  guardAutomatedPaymentsActivation
} from '../../server/activation'

const createQuery = (rows: Array<{ code: string }>) => {
  const query: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const method of ['selectFrom', 'innerJoin', 'select', 'where']) {
    query[method] = vi.fn(() => query)
  }
  query.execute = vi.fn().mockResolvedValue(rows)
  return query
}

describe('automated payments activation guard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('accepts a stream with both active semantic holdback bases', async () => {
    const db = createQuery([
      { code: 'agreement-total' },
      { code: 'final-fiscal-year' }
    ])

    await expect(guardAutomatedPaymentsActivation(db as never, 'stream-1')).resolves.toBeUndefined()
    expect(db.where).toHaveBeenCalledWith(
      'Transfer_Payment_Stream_Holdback_Basis.egcs_tp_transferpaymentstream',
      '=',
      'stream-1'
    )
    expect(db.where).toHaveBeenCalledWith('Transfer_Payment_Stream_Holdback_Basis._deleted', '=', false)
    expect(db.where).toHaveBeenCalledWith('Agency_Holdback_Basis._deleted', '=', false)
  })

  it('returns required codes that do not resolve through active stream rows', async () => {
    const db = createQuery([{ code: 'agreement-total' }])

    await expect(getMissingStreamHoldbackBasisCodes(db as never, 'stream-1'))
      .resolves.toEqual(['final-fiscal-year'])
  })

  it('refuses activation with an actionable bilingual error listing every missing code', async () => {
    const db = createQuery([])

    await expect(guardAutomatedPaymentsActivation(db as never, 'stream-1')).rejects.toMatchObject({
      code: 'GCS_AUTOMATED_PAYMENTS_MISSING_HOLDBACK_BASES',
      localizedMessage: {
        en: expect.stringContaining('agreement-total, final-fiscal-year'),
        fr: expect.stringContaining('agreement-total, final-fiscal-year')
      },
      details: [expect.objectContaining({ path: 'holdbackBases' })]
    })
  })
})
