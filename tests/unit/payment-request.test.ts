import { describe, expect, it } from 'vitest'
import { effectScope } from 'vue'
import { usePaymentRequest } from '../../composables/usePaymentRequest'

describe('financial request ownership', () => {
  it('allows only the newest request to publish financial evidence or errors', () => {
    const scope = effectScope()
    const request = scope.run(() => usePaymentRequest<string, string>())!
    const older = request.start()!
    const current = request.start()!
    expect(request.succeed(older, 'previous currency')).toBe(false)
    expect(request.fail(older, 'old error')).toBe(false)
    expect(request.loading.value).toBe(true)
    expect(request.succeed(current, 'current currency')).toBe(true)
    expect(request.data.value).toBe('current currency')
    scope.stop()
  })

  it('clears evidence on a new request and recovers from failure', () => {
    const scope = effectScope()
    const request = scope.run(() => usePaymentRequest<string, string>())!
    request.succeed(request.start()!, 'evidence')
    const failed = request.start()!
    expect(request.data.value).toBeNull()
    expect(request.fail(failed, 'offline')).toBe(true)
    expect(request.error.value).toBe('offline')
    expect(request.loading.value).toBe(false)
    request.succeed(request.start()!, 'retry')
    expect(request.error.value).toBeNull()
    expect(request.data.value).toBe('retry')
    scope.stop()
  })

  it('invalidates a request when required inputs disappear', () => {
    const scope = effectScope()
    const request = scope.run(() => usePaymentRequest<string, string>())!
    const pending = request.start()!
    request.reset()
    expect(request.loading.value).toBe(false)
    expect(request.succeed(pending, 'unavailable input')).toBe(false)
    expect(request.data.value).toBeNull()
    scope.stop()
  })

  it('cannot settle or restart a disposed calculation scope', () => {
    const scope = effectScope()
    const request = scope.run(() => usePaymentRequest<string, string>())!
    const pending = request.start()!
    scope.stop()
    expect(request.succeed(pending, 'late evidence')).toBe(false)
    expect(request.fail(pending, 'late error')).toBe(false)
    request.reset()
    expect(request.start()).toBeNull()
    expect(request.loading.value).toBe(false)
  })
})
