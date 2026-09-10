import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { useAuth } from '../src/composables/useAuth'
import { useSessionOrg } from '../src/composables/useSessionOrg'

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('../src/utils/api', () => ({ apiFetch: mocks.apiFetch, getApiBase: () => '' }))
const jwt = (org: string) => `header.${btoa(JSON.stringify({ userId: 'actor', tenantId: org, exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`
const response = (data: unknown, ok = true) => ({ ok, json: async () => ({ success: ok, data }) })
let scopes: ReturnType<typeof effectScope>[] = []
function session() {
  const scope = effectScope()
  scopes.push(scope)
  return scope.run(() => useSessionOrg())!
}

describe('explicit session organization', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.apiFetch.mockReset()
    useAuth().setToken(jwt('org-a'))
  })
  afterEach(() => { scopes.forEach(scope => scope.stop()); scopes = [] })

  it('commits a consistent explicit response without changing the stored login hint', async () => {
    mocks.apiFetch.mockResolvedValue(response({ token: jwt('org-b'), currentOrgId: 'org-b', user: { id: 'actor' } }))
    const state = session()
    expect(await state.switchSessionOrg('org-b')).toBe(true)
    expect(state.currentOrgId.value).toBe('org-b')
    expect(useAuth().getToken()).toBe(jwt('org-b'))
    expect(localStorage.getItem('tenantId')).toBe('org-a')
  })

  it.each(['', 'invalid'])('refuses a success payload with an invalid token (%s)', async token => {
    mocks.apiFetch.mockResolvedValue(response({ token, currentOrgId: 'org-b', user: { id: 'actor' } }))
    const state = session()
    expect(await state.switchSessionOrg('org-b')).toBe(false)
    expect(useAuth().getToken()).toBe(jwt('org-a'))
    expect(state.currentOrgId.value).toBeNull()
  })

  it('does not overwrite a new login when an old switch returns late', async () => {
    let resolve!: (value: unknown) => void
    mocks.apiFetch.mockImplementation(() => new Promise(done => { resolve = done }))
    const state = session()
    const pending = state.switchSessionOrg('org-b')
    useAuth().setToken(jwt('org-c'))
    resolve(response({ token: jwt('org-b'), currentOrgId: 'org-b', user: { id: 'actor' } }))
    expect(await pending).toBe(false)
    expect(useAuth().getToken()).toBe(jwt('org-c'))
    expect(state.currentOrgId.value).toBeNull()
  })

  it('invalidates even a same-token auth-generation transition', async () => {
    let resolve!: (value: unknown) => void
    mocks.apiFetch.mockImplementation(() => new Promise(done => { resolve = done }))
    const state = session()
    const pending = state.switchSessionOrg('org-b')
    useAuth().setToken(jwt('org-a'))
    resolve(response({ token: jwt('org-b'), currentOrgId: 'org-b', user: { id: 'actor' } }))
    expect(await pending).toBe(false)
    expect(useAuth().getToken()).toBe(jwt('org-a'))
  })

  it('refuses server denial and suppresses duplicate in-flight switches', async () => {
    let resolve!: (value: unknown) => void
    mocks.apiFetch.mockImplementation(() => new Promise(done => { resolve = done }))
    const state = session()
    const pending = state.switchSessionOrg('org-b')
    expect(await state.switchSessionOrg('org-c')).toBe(false)
    resolve(response(null, false))
    expect(await pending).toBe(false)
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1)
    expect(useAuth().getToken()).toBe(jwt('org-a'))
  })

  it('does not publish an old organization list after the session changes', async () => {
    let resolve!: (value: unknown) => void
    mocks.apiFetch.mockImplementation(() => new Promise(done => { resolve = done }))
    const state = session()
    const pending = state.loadSessionOrgs()
    useAuth().setToken(jwt('org-b'))
    resolve(response({ orgs: ['org-a'], currentOrgId: 'org-a' }))
    await pending
    expect(state.orgs.value).toEqual([])
    expect(state.currentOrgId.value).toBeNull()
  })
})
