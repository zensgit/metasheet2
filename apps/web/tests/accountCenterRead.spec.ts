import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'
import { EXPLICIT_SESSION_ORG_KEY } from '../src/utils/explicitSessionOrg'
import type { AccountCenterResponse } from '../src/account/accountCenterContract'
import { useAccountCenterRead, type AccountCenterRead } from '../src/account/useAccountCenterRead'

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), clearToken: vi.fn(), unsubscribe: vi.fn() }))
vi.mock('../src/utils/api', () => ({ apiFetch: mocks.apiFetch }))
vi.mock('../src/composables/useAuth', () => ({ useAuth: () => ({ clearToken: mocks.clearToken }) }))
vi.mock('../src/composables/authPrincipal', async () => {
  const actual = await vi.importActual<typeof import('../src/composables/authPrincipal')>('../src/composables/authPrincipal')
  return {
    ...actual,
    onAuthSessionSwitch: (listener: () => void) => {
      const stop = actual.onAuthSessionSwitch(listener)
      return () => { mocks.unsubscribe(); stop() }
    },
  }
})

const first: AccountCenterResponse = { ok: true, data: { version: 2, context: 'selected', cards: [] } }
const second: AccountCenterResponse = { ok: true, data: { version: 2, context: 'selection_required', cards: [] } }
// Parser injection fixture; the product parser is supplied by the page slice.
const parse = vi.fn((value: unknown): AccountCenterResponse | null => {
  if (JSON.stringify(value) === JSON.stringify(first)) return first
  if (JSON.stringify(value) === JSON.stringify(second)) return second
  return null
})
function reply(status = 200, value: unknown = first): Response {
  return { status, json: async () => value } as Response
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function token(subject: string, tenantId = 'org-a'): string {
  return `header.${btoa(JSON.stringify({ sub: subject, tenantId, exp: 4102444800 }))}.signature`
}
const originalWindow = window
const replace = vi.fn()
const removeListener = vi.fn(originalWindow.removeEventListener.bind(originalWindow))
const instances: AccountCenterRead[] = []
function create() {
  const instance = useAccountCenterRead(parse)
  instances.push(instance)
  return instance
}
let assertions = 0
beforeEach(() => {
  expect.hasAssertions()
  localStorage.clear()
  localStorage.setItem('auth_token', token('account-a'))
  vi.clearAllMocks()
  parse.mockClear()
  vi.stubGlobal('window', {
    location: { pathname: '/settings/account-center', search: '', hash: '', replace },
    addEventListener: originalWindow.addEventListener.bind(originalWindow),
    removeEventListener: removeListener,
    dispatchEvent: originalWindow.dispatchEvent.bind(originalWindow),
  })
  mocks.apiFetch.mockResolvedValue(reply())
})
afterEach(() => {
  assertions += expect.getState().assertionCalls
  for (const instance of instances.splice(0)) instance.dispose()
  vi.unstubAllGlobals()
  localStorage.clear()
})
afterAll(() => console.info('account-center-read assertions', assertions))

describe('account center read lifecycle', () => {
  it('starts idle, requests only on refresh, and keeps instances separate', async () => {
    const a = create()
    const b = create()
    expect(a.state.value).toBe('idle')
    expect(a.snapshot.value).toBeNull()
    expect(mocks.apiFetch).not.toHaveBeenCalled()
    await a.refresh()
    expect(a.state.value).toBe('ready')
    expect(a.snapshot.value).toEqual(first)
    expect(b.state.value).toBe('idle')
    expect(b.snapshot.value).toBeNull()
    expect(parse).toHaveBeenCalledWith(first)
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1)
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/me/external-identities', {
      method: 'GET', signal: expect.any(AbortSignal), cache: 'no-store', suppressUnauthorizedRedirect: true,
    })
  })
  it('clears the previous snapshot while refreshing and on failure', async () => {
    const read = create()
    await read.refresh()
    const pending = deferred<Response>()
    mocks.apiFetch.mockReturnValueOnce(pending.promise)
    const refreshing = read.refresh()
    expect(read.state.value).toBe('loading')
    expect(read.snapshot.value).toBeNull()
    pending.reject(new Error('example transport failure'))
    await refreshing
    expect(read.state.value).toBe('error')
    expect(read.snapshot.value).toBeNull()
    await read.refresh()
    expect(read.state.value).toBe('ready')
    expect(mocks.apiFetch).toHaveBeenCalledTimes(3)
  })
  it('keeps the newest response when requests complete in reverse order', async () => {
    const read = create()
    const old = deferred<Response>()
    mocks.apiFetch.mockReturnValueOnce(old.promise).mockResolvedValueOnce(reply(200, second))
    const older = read.refresh()
    const signal = mocks.apiFetch.mock.calls[0][1].signal as AbortSignal
    await read.refresh()
    expect(signal.aborted).toBe(true)
    old.resolve(reply(200, first))
    await older
    expect(read.snapshot.value).toEqual(second)
    expect(read.state.value).toBe('ready')
  })
  it('checks freshness again after reading JSON', async () => {
    const body = deferred<unknown>()
    const read = create()
    mocks.apiFetch.mockResolvedValueOnce({ status: 200, json: () => body.promise })
    const older = read.refresh()
    await Promise.resolve()
    mocks.apiFetch.mockResolvedValueOnce(reply(200, second))
    await read.refresh()
    body.resolve(first)
    await older
    expect(read.snapshot.value).toEqual(second)
  })
  it('ignores an older failure after a newer success', async () => {
    const old = deferred<Response>()
    const read = create()
    mocks.apiFetch.mockReturnValueOnce(old.promise)
    const older = read.refresh()
    await read.refresh()
    old.reject(new Error('example failure'))
    await older
    expect(read.state.value).toBe('ready')
    expect(read.snapshot.value).toEqual(first)
  })
  it.each(['token', 'organization', 'storage'])('clears ready data after a %s change', async kind => {
    const read = create()
    await read.refresh()
    localStorage.setItem('auth_token', token(kind === 'token' ? 'account-b' : 'account-a', kind === 'organization' ? 'org-b' : 'org-a'))
    if (kind === 'storage') localStorage.setItem('auth_token', token('account-c'))
    if (kind === 'storage') window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token' }))
    else notifyAuthPrincipalChange()
    await Promise.resolve()
    expect(read.snapshot.value).toBeNull()
    expect(read.state.value).toBe('idle')
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1)
  })
  it('detects an explicit organization epoch with unchanged token text', async () => {
    const current = token('account-a')
    localStorage.setItem('jwt', current)
    const marker = { state: 'ready', token: current, actor: 'account-a', tenantId: 'org-a', exp: 4102444800, epoch: 'first' }
    localStorage.setItem(EXPLICIT_SESSION_ORG_KEY, JSON.stringify(marker))
    const read = create()
    await read.refresh()
    localStorage.setItem(EXPLICIT_SESSION_ORG_KEY, JSON.stringify({ ...marker, epoch: 'second' }))
    notifyAuthPrincipalChange()
    await Promise.resolve()
    expect(read.snapshot.value).toBeNull()
    expect(read.state.value).toBe('idle')
  })
  it.each([200, 401, 403])('ignores pending status %s after a session change without notification', async status => {
    const old = deferred<Response>()
    mocks.apiFetch.mockReturnValueOnce(old.promise)
    const read = create()
    const pending = read.refresh()
    localStorage.setItem('auth_token', token('account-b'))
    old.resolve(reply(status, status === 200 ? first : { error: { code: 'PASSWORD_CHANGE_REQUIRED' } }))
    await pending
    expect(read.snapshot.value).toBeNull()
    expect(read.state.value).toBe('idle')
    expect(replace).not.toHaveBeenCalled()
    expect(mocks.clearToken).not.toHaveBeenCalled()
  })
  it('disposes once, cancels subscriptions and ignores pending data', async () => {
    const old = deferred<Response>()
    const read = create()
    mocks.apiFetch.mockReturnValueOnce(old.promise)
    const pending = read.refresh()
    const signal = mocks.apiFetch.mock.calls[0][1].signal as AbortSignal
    read.dispose()
    read.dispose()
    expect(signal.aborted).toBe(true)
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1)
    expect(removeListener).toHaveBeenCalledTimes(1)
    expect(removeListener.mock.calls[0][0]).toBe('storage')
    old.resolve(reply())
    await pending
    await read.refresh()
    expect(read.snapshot.value).toBeNull()
    expect(read.state.value).toBe('idle')
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1)
  })
  it.each([false, true])('accepts error envelope with ok key %s', async withOk => {
    const read = create()
    await read.refresh()
    mocks.apiFetch.mockResolvedValueOnce(reply(403, {
      ...(withOk ? { ok: false } : {}), error: { code: 'PASSWORD_CHANGE_REQUIRED', message: 'example message' },
    }))
    await read.refresh()
    expect(read.snapshot.value).toBeNull()
    expect(read.state.value).toBe('error')
    expect(replace).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledWith('/force-password-change')
    expect(mocks.clearToken).not.toHaveBeenCalled()
  })
  it('uses the login flow on unauthorized responses', async () => {
    const read = create()
    await read.refresh()
    mocks.apiFetch.mockResolvedValueOnce(reply(401, { error: { code: 'UNAUTHORIZED' } }))
    await read.refresh()
    expect(read.snapshot.value).toBeNull()
    expect(read.state.value).toBe('error')
    expect(mocks.clearToken).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledWith('/login?redirect=%2Fsettings%2Faccount-center')
  })
  it.each([
    [403, 'SESSION_ORG_NOT_MEMBER'], [403, 'UNKNOWN'], [422, 'INVALID_REQUEST'],
    [503, 'ACCOUNT_CENTER_STATE_UNREADABLE'], [503, 'AUTH_UNAVAILABLE'],
    [503, 'PASSWORD_CHANGE_REQUIRED'], [500, 'UNKNOWN'],
  ])('keeps status %s code %s as an error', async (status, code) => {
    for (const withOk of [false, true]) {
      const read = create()
      await read.refresh()
      mocks.apiFetch.mockResolvedValueOnce(reply(status as number, { ...(withOk ? { ok: false } : {}), error: { code, message: 'example message' } }))
      await read.refresh()
      expect(read.snapshot.value).toBeNull()
      expect(read.state.value).toBe('error')
      expect(replace).not.toHaveBeenCalled()
      expect(mocks.clearToken).not.toHaveBeenCalled()
    }
  })
  it('handles disabled responses without requiring an ok key or JSON body', async () => {
    const read = create()
    await read.refresh()
    mocks.apiFetch.mockResolvedValueOnce(reply(404, { error: { code: 'NOT_FOUND' } }))
    await read.refresh()
    expect(read.state.value).toBe('disabled')
    expect(read.snapshot.value).toBeNull()
    mocks.apiFetch.mockResolvedValueOnce({ status: 404, json: () => { throw new Error('example body failure') } })
    await read.refresh()
    expect(read.state.value).toBe('disabled')
  })
  it.each([
    { ...first, extra: true },
    { ok: true, data: { ...first.data, cards: [{ kind: 'record', source: 'strict', grant: 'legacy_default' }] } },
  ])('honors parser rejection for invalid successful body %j', async body => {
    const read = create()
    await read.refresh()
    mocks.apiFetch.mockResolvedValueOnce(reply(200, body))
    await read.refresh()
    expect(parse).toHaveBeenLastCalledWith(body)
    expect(read.state.value).toBe('error')
    expect(read.snapshot.value).toBeNull()
  })
  it('handles JSON and parser exceptions without exposing their text', async () => {
    const read = create()
    mocks.apiFetch.mockResolvedValueOnce({ status: 200, json: () => { throw new Error('example body failure') } })
    await read.refresh()
    expect(read.state.value).toBe('error')
    expect(read.snapshot.value).toBeNull()
    parse.mockImplementationOnce(() => { throw new Error('example parser failure') })
    await read.refresh()
    expect(read.state.value).toBe('error')
    expect(read.snapshot.value).toBeNull()
  })
})
