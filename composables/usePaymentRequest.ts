import { computed, onScopeDispose, shallowRef } from 'vue'

type RequestState<T, E> =
  | { kind: 'idle' }
  | { kind: 'pending'; request: symbol }
  | { kind: 'success'; data: T }
  | { kind: 'error'; error: E }
  | { kind: 'disposed' }

/** Owns one replaceable financial request without retaining another input's evidence. */
export const usePaymentRequest = <T, E>() => {
  const state = shallowRef<RequestState<T, E>>({ kind: 'idle' })
  const owns = (request: symbol): boolean => state.value.kind === 'pending' && state.value.request === request
  const start = (): symbol | null => {
    if (state.value.kind === 'disposed') return null
    const request = Symbol('payment-request')
    state.value = { kind: 'pending', request }
    return request
  }
  const succeed = (request: symbol, data: T): boolean => {
    if (!owns(request)) return false
    state.value = { kind: 'success', data }
    return true
  }
  const fail = (request: symbol, error: E): boolean => {
    if (!owns(request)) return false
    state.value = { kind: 'error', error }
    return true
  }
  const reset = () => {
    if (state.value.kind !== 'disposed') state.value = { kind: 'idle' }
  }
  onScopeDispose(() => { state.value = { kind: 'disposed' } })
  return {
    data: computed(() => state.value.kind === 'success' ? state.value.data : null),
    error: computed(() => state.value.kind === 'error' ? state.value.error : null),
    loading: computed(() => state.value.kind === 'pending'),
    start, owns, succeed, fail, reset
  }
}
