/**
 * `approvals/delegations.ts` follows the same `__APPROVAL_MOCK__` override protocol as
 * `approvals/api.ts` (see the "Mock-mode flag" block there): an explicit `true` forces mock mode, an
 * explicit `false` forces the real network path even under DEV, and an unset override keeps DEV's
 * mock-by-default behaviour.
 *
 * `USE_MOCK` is a module-load-time const, so each case sets (or deletes) the override, resets the
 * module registry and imports a FRESH copy of the client before calling it.
 *
 * vitest runs with `import.meta.env.DEV === true`, which only exercises the DEV half of the protocol.
 * The production half (unset -> network; explicit `true` -> mock) is pinned by stubbing `DEV` to `false`
 * with `vi.stubEnv` before the fresh import, so dropping the DEV gate (`o !== false`) or the forced-mock
 * arm (`DEV && o !== false`) fails a case here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiGetMock = vi.fn()
const apiPostMock = vi.fn()
const apiFetchMock = vi.fn()

vi.mock('../src/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/api')>()
  return {
    ...actual,
    apiGet: (...args: unknown[]) => apiGetMock(...args),
    apiPost: (...args: unknown[]) => apiPostMock(...args),
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  }
})

type OverrideScope = { __APPROVAL_MOCK__?: boolean }

const globalScope = globalThis as OverrideScope
let previousOverride: boolean | undefined
let hadOverride = false

async function loadDelegationsWith(override: boolean | undefined) {
  if (override === undefined) delete globalScope.__APPROVAL_MOCK__
  else globalScope.__APPROVAL_MOCK__ = override
  vi.resetModules()
  return import('../src/approvals/delegations')
}

function networkCallCount(): number {
  return apiGetMock.mock.calls.length + apiPostMock.mock.calls.length + apiFetchMock.mock.calls.length
}

describe('delegations client honours the __APPROVAL_MOCK__ override like approvals/api.ts', () => {
  beforeEach(() => {
    hadOverride = Object.prototype.hasOwnProperty.call(globalScope, '__APPROVAL_MOCK__')
    previousOverride = globalScope.__APPROVAL_MOCK__
    apiGetMock.mockReset()
    apiPostMock.mockReset()
    apiFetchMock.mockReset()
    apiGetMock.mockResolvedValue({ data: [] })
    apiPostMock.mockResolvedValue({ data: null })
    apiFetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: null }) })
  })

  afterEach(() => {
    if (hadOverride) globalScope.__APPROVAL_MOCK__ = previousOverride
    else delete globalScope.__APPROVAL_MOCK__
    vi.resetModules()
  })

  it('override === false takes the real network path even under DEV', async () => {
    expect(import.meta.env.DEV).toBe(true)
    const delegations = await loadDelegationsWith(false)

    await delegations.listDelegations({ includeInactive: true })
    expect(apiGetMock).toHaveBeenCalledWith('/api/approval-delegations?includeInactive=true')

    await delegations.listOwnDelegations()
    expect(apiGetMock).toHaveBeenCalledWith('/api/approval-delegations/mine')

    await delegations.disableDelegation('dlg 1')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/approval-delegations/dlg%201', { method: 'DELETE' })
  })

  it('override === true stays in mock mode (zero network calls)', async () => {
    const delegations = await loadDelegationsWith(true)

    await delegations.listDelegations({ includeInactive: true })
    await delegations.listOwnDelegations()
    await delegations.disableDelegation('dlg-1')

    expect(networkCallCount()).toBe(0)
  })

  it('no override keeps DEV mock-by-default (zero network calls)', async () => {
    expect(import.meta.env.DEV).toBe(true)
    const delegations = await loadDelegationsWith(undefined)

    await delegations.listDelegations({ includeInactive: true })
    await delegations.listOwnDelegations()
    await delegations.disableDelegation('dlg-1')

    expect(networkCallCount()).toBe(0)
  })

  describe('production branch (DEV stubbed to false)', () => {
    beforeEach(() => {
      vi.stubEnv('DEV', false)
    })

    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('no override takes the real network path outside DEV', async () => {
      const delegations = await loadDelegationsWith(undefined)
      expect(import.meta.env.DEV).toBe(false)

      await delegations.listOwnDelegations()
      expect(apiGetMock).toHaveBeenCalledWith('/api/approval-delegations/mine')
    })

    it('override === true still forces mock mode outside DEV (zero network calls)', async () => {
      const delegations = await loadDelegationsWith(true)
      expect(import.meta.env.DEV).toBe(false)

      await delegations.listDelegations({ includeInactive: true })
      await delegations.listOwnDelegations()
      await delegations.disableDelegation('dlg-1')

      expect(networkCallCount()).toBe(0)
    })
  })
})
