import { describe, expect, it, vi } from 'vitest'
import type { GcsExtensionRouteEvent } from '@gcs-ssc/extensions/server'
const { read } = vi.hoisted(() => ({ read: vi.fn(async () => ({ version: 1 })) }))
vi.mock('h3', () => ({ isEvent: () => true }))
vi.mock('../../server/calculation-data', () => ({ getPaymentCalculationEvidence: read }))
import handler from '../../server/api/calculation-evidence.get'
describe('extension retained Payment evidence route', () => {
  it('uses the Payment identity authorized by host dispatch and does not recalculate', async () => {
    const db = {}
    const event = { context: { $db: db, params: { paymentId: '90' } }, node: { req: { headers: {} } } } as unknown as GcsExtensionRouteEvent
    expect(await handler(event)).toEqual({ evidence: { version: 1 } })
    expect(read).toHaveBeenCalledWith(db, '90')
  })
})
