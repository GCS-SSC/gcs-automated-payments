import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { getAgreementHoldbackSettings, getSelectedPaymentPeriod } from '../../server/calculation-data'

const calculationDataPath = new URL('../../server/calculation-data.ts', import.meta.url)

const getQuerySource = (source: string, functionName: string, nextFunctionName: string): string => {
  const start = source.indexOf(`const ${functionName} =`)
  const end = source.indexOf(`const ${nextFunctionName} =`, start)

  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)

  return source.slice(start, end)
}

const createQuery = (row: Record<string, unknown> | undefined) => {
  const query: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const method of ['selectFrom', 'innerJoin', 'select', 'where']) {
    query[method] = vi.fn(() => query)
  }
  query.executeTakeFirst = vi.fn().mockResolvedValue(row)
  return query
}

describe('automated payment calculation data', () => {
  it('rejects a fiscal year outside the agreement current budget instead of calculating against year zero', async () => {
    const db = createQuery(undefined)

    await expect(getSelectedPaymentPeriod(db as never, 'agreement-1', 'other-fy', 3)).rejects.toMatchObject({
      code: 'GCS_AUTOMATED_PAYMENTS_FISCAL_YEAR_UNAVAILABLE',
      details: [expect.objectContaining({ path: 'egcs_fc_fiscalyear' })]
    })
  })

  it('scopes stable fiscal-year joins to the current agreement budget version', async () => {
    const source = await readFile(calculationDataPath, 'utf8')
    const queries = [
      getQuerySource(source, 'getSelectedPaymentPeriod', 'getClaimRows'),
      getQuerySource(source, 'getClaimRows', 'getLastClaimPosition'),
      getQuerySource(source, 'getForecastRows', 'getPaymentRows'),
      getQuerySource(source, 'getPaymentRows', 'getHoldbackReleasedToDate'),
      getQuerySource(source, 'getCommitmentRemaining', 'getBudgetTotals')
    ]

    for (const query of queries) {
      expect(query).toContain('stableBudgetFiscalYearId')
      expect(query).toContain(".innerJoin('Funding_Case_Agreement_Budget_Version'")
      expect(query).toContain(".where('Funding_Case_Agreement_Budget_Version.egcs_fc_iscurrent', '=', true)")
      expect(query).toContain(".where('Funding_Case_Agreement_Budget_Version._deleted', '=', false)")
    }
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
