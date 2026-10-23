import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import PlmEmbedBomReviewView from '../src/views/PlmEmbedBomReviewView.vue'
import { MANAGED_RENEWAL_PENDING_KEY } from '../src/composables/authIdentityLock'
import {
  clearManagedDescriptor,
  clearManagedProbeMarker,
  installManagedDescriptor,
  notifyAuthPrincipalChange,
  onAuthPrincipalChange,
  readAuthSessionSignature,
  readManagedDescriptor,
  readManagedEpoch,
  setManagedProbeMarker,
  type ManagedSessionDescriptor,
} from '../src/composables/authPrincipal'
import { installPermissionSnapshotRefresh, useAuth } from '../src/composables/useAuth'

const RENEW_PATH = '/api/plm/managed-login/renew-recovery'
const CURRENT_PATH = '/api/plm/managed-login/current'
const LOGOUT_PATH = '/api/plm/managed-login/logout'
const ME_PATH = '/api/auth/me'
const SNAPSHOT_SHARE_KEY = 'metasheet_plm_snapshot_share'
const PARENT_ORIGIN = 'https://plm.example'

let embedApp: VueApp | null = null
let embedContainer: HTMLDivElement | null = null
let restorePostMessage: typeof window.postMessage | null = null
let embedBomReads = 0

function descriptor(overrides: Partial<ManagedSessionDescriptor> = {}): ManagedSessionDescriptor {
  return {
    mode: 'managed-cookie',
    userId: 'person-a',
    tenantId: 'tenant-a',
    sessionId: 'session-a',
    revision: 4,
    expiresAt: new Date(Date.now() + 180_000).toISOString(),
    continuityMode: 'continuous',
    credentialGeneration: 1,
    ...overrides,
  }
}

function currentBody(session: ManagedSessionDescriptor) {
  return {
    success: true,
    data: {
      user: {
        id: session.userId,
        tenantId: session.tenantId,
        role: 'user',
        permissions: [] as string[],
        must_change_password: false,
      },
      features: { plm: true, attendance: false, workflow: false },
      managedSession: session,
    },
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function successor(generation = 2): ManagedSessionDescriptor {
  return descriptor({
    sessionId: 'session-next',
    credentialGeneration: generation,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  })
}

function installQueueLock(): void {
  let tail = Promise.resolve()
  const request = (_name: string, _options: unknown, callback: () => unknown) => {
    const run = tail.then(() => callback())
    tail = run.then(() => undefined, () => undefined)
    return run
  }
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request },
  })
}

function callsTo(fetchMock: ReturnType<typeof vi.fn>, path: string): unknown[][] {
  return fetchMock.mock.calls.filter((call) => String(call[0]).includes(path))
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve()
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function bomBody(partId: string, name: string) {
  return {
    ok: true,
    data: {
      available: true,
      entitled: true,
      part_id: partId,
      context: {
        part: { part_id: partId, item_number: partId, name, state: 'released', generation: 1 },
        lines: [{
          bom_line_id: 'line-1', part_id: partId, item_number: 'child', name: 'Child',
          state: 'released', generation: 1, quantity: 1, uom: 'ea', find_num: '10', refdes: null,
          level: 1, path: [partId], path_labels: [name], source_version: 1, source_updated_at: null,
          sync_status: 'current',
        }],
        source_version: 1,
        source_updated_at: null,
        sync_status: 'current',
        template_key: 'bom',
      },
    },
  }
}

function installEmbedParent(): void {
  embedBomReads = 0
  restorePostMessage = window.postMessage.bind(window)
  window.postMessage = ((data: unknown, origin: string) => {
    const record = data && typeof data === 'object' ? data as Record<string, unknown> : {}
    if (record.type !== 'plm-embed:token-request') return
    const token = record.purpose === 'bom-read' ? 'fresh-bom-token' : 'discussion-token'
    if (record.purpose === 'bom-read') embedBomReads += 1
    queueMicrotask(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'plm-embed:token-response', nonce: record.nonce, token },
        origin: String(origin),
        source: window.parent,
      }))
    })
  }) as typeof window.postMessage
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function showInitialRows(): Promise<HTMLElement> {
  embedContainer = document.createElement('div')
  document.body.appendChild(embedContainer)
  embedApp = createApp(PlmEmbedBomReviewView)
  embedApp.mount(embedContainer)
  await settle()
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'plm-embed:token', token: 'initial-token' },
    origin: PARENT_ORIGIN,
    source: window.parent,
  }))
  await settle()
  const root = embedContainer.querySelector('[data-testid="plm-embed-bom-review"]')
  if (!(root instanceof HTMLElement)) throw new Error('embed view did not mount')
  return root
}

describe('continuous scheduling without focus', () => {
  let clock = Date.UTC(2026, 9, 23, 8, 0, 0)

  beforeEach(() => {
    clock += 10 * 60_000
    vi.useFakeTimers()
    vi.setSystemTime(clock)
    installQueueLock()
    window.history.replaceState(null, '', '/')
    installPermissionSnapshotRefresh()
  })

  afterEach(() => {
    embedApp?.unmount()
    embedApp = null
    embedContainer?.remove()
    embedContainer = null
    if (restorePostMessage) {
      window.postMessage = restorePostMessage
      restorePostMessage = null
    }
    Reflect.deleteProperty(document, 'visibilityState')
    clearManagedDescriptor()
    clearManagedProbeMarker()
    localStorage.clear()
    sessionStorage.clear()
    notifyAuthPrincipalChange()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    Reflect.deleteProperty(navigator, 'locks')
  })

  it('renews a continuously focused session when the lead opens without a focus event', async () => {
    installPermissionSnapshotRefresh()
    setManagedProbeMarker()
    const started = descriptor()
    const expiresAt = started.expiresAt
    const epoch = readManagedEpoch()
    const signature = readAuthSessionSignature()
    expect(installManagedDescriptor(started)).not.toBeNull()
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes(RENEW_PATH)) return jsonResponse({ ok: true })
      if (String(url).includes(CURRENT_PATH)) return jsonResponse(currentBody(successor()))
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    notifyAuthPrincipalChange()

    await vi.advanceTimersByTimeAsync(60_000)

    const renews = callsTo(fetchMock, RENEW_PATH)
    expect(Date.now()).toBeLessThan(Date.parse(expiresAt))
    expect(renews).toHaveLength(1)
    expect(callsTo(fetchMock, CURRENT_PATH)).toHaveLength(1)
    const init = renews[0][1] as RequestInit
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(init.body).toBe(JSON.stringify({}))
    const headers = init.headers as Record<string, string>
    expect(headers['x-metasheet-managed-bridge']).toBe('renew-recovery')
    expect(headers.authorization).toBeUndefined()
    expect(JSON.stringify(headers).toLowerCase()).not.toContain('bearer')
    const installed = readManagedDescriptor()
    expect(installed).toMatchObject({
      userId: 'person-a',
      tenantId: 'tenant-a',
      sessionId: 'session-next',
      revision: 4,
      continuityMode: 'continuous',
      credentialGeneration: 2,
    })
    expect(readManagedEpoch()).toBe(epoch)
    expect(readAuthSessionSignature()).not.toBe(signature)
    expect(Date.parse(installed!.expiresAt)).toBeGreaterThan(Date.now() + 120_000)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(callsTo(fetchMock, RENEW_PATH)).toHaveLength(1)
    expect(readManagedDescriptor()?.sessionId).toBe('session-next')
  })

  it('retries a lost renew response once after the existing throttle and still before expiry', async () => {
    setManagedProbeMarker()
    const started = descriptor()
    const expiresAtMs = Date.parse(started.expiresAt)
    expect(installManagedDescriptor(started)).not.toBeNull()
    let renews = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes(RENEW_PATH)) {
        renews += 1
        if (renews === 1) throw new Error('socket reset')
        return jsonResponse({ ok: true })
      }
      if (String(url).includes(CURRENT_PATH)) return jsonResponse(currentBody(successor()))
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    notifyAuthPrincipalChange()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(renews).toBe(1)
    expect(callsTo(fetchMock, CURRENT_PATH)).toHaveLength(0)
    expect(readManagedDescriptor()?.sessionId).toBe('session-a')
    expect(localStorage.getItem(MANAGED_RENEWAL_PENDING_KEY)).toContain('session-a')
    const firstAt = Date.now()

    await vi.advanceTimersByTimeAsync(59_000)
    expect(renews).toBe(1)
    expect(Date.now() - firstAt).toBe(59_000)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(renews).toBe(2)
    expect(Date.now() - firstAt).toBe(60_000)
    expect(Date.now()).toBeLessThan(expiresAtMs)
    expect(callsTo(fetchMock, CURRENT_PATH)).toHaveLength(1)
    expect(readManagedDescriptor()).toMatchObject({
      sessionId: 'session-next',
      credentialGeneration: 2,
      revision: 4,
    })
    expect(localStorage.getItem(MANAGED_RENEWAL_PENDING_KEY)).toBeNull()
  })

  it('keeps one flight when focus arrives while the scheduled renewal is unanswered', async () => {
    setManagedProbeMarker()
    expect(installManagedDescriptor(descriptor())).not.toBeNull()
    let releaseRenew: ((response: Response) => void) | null = null
    let releaseCurrent: ((response: Response) => void) | null = null
    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes(RENEW_PATH)) {
        return new Promise<Response>((resolve) => {
          releaseRenew = resolve
        })
      }
      if (String(url).includes(CURRENT_PATH)) {
        return new Promise<Response>((resolve) => {
          releaseCurrent = resolve
        })
      }
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    notifyAuthPrincipalChange()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(callsTo(fetchMock, RENEW_PATH)).toHaveLength(1)
    window.dispatchEvent(new Event('focus'))
    await flush()
    installPermissionSnapshotRefresh()
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(callsTo(fetchMock, RENEW_PATH)).toHaveLength(1)
    expect(callsTo(fetchMock, CURRENT_PATH)).toHaveLength(0)

    releaseRenew?.(jsonResponse({ ok: true }))
    await flush()
    expect(callsTo(fetchMock, CURRENT_PATH)).toHaveLength(1)
    releaseCurrent?.(jsonResponse(currentBody(successor())))
    await flush()
    expect(readManagedDescriptor()?.sessionId).toBe('session-next')
    expect(callsTo(fetchMock, RENEW_PATH)).toHaveLength(1)
  })

  it('cancels the pending timer when the managed session logs out', async () => {
    setManagedProbeMarker()
    expect(installManagedDescriptor(descriptor())).not.toBeNull()
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes(LOGOUT_PATH)) return jsonResponse({ ok: true, revoked: true })
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    notifyAuthPrincipalChange()
    await expect(useAuth().commitClearedOrdinaryAuth()).resolves.toBe(true)
    expect(readManagedDescriptor()).toBeNull()

    await vi.advanceTimersByTimeAsync(180_000)
    expect(callsTo(fetchMock, RENEW_PATH)).toHaveLength(0)
    expect(callsTo(fetchMock, CURRENT_PATH)).toHaveLength(0)
    expect(readManagedDescriptor()).toBeNull()
  })

  it('drops a late renew result after logout instead of installing it', async () => {
    setManagedProbeMarker()
    expect(installManagedDescriptor(descriptor())).not.toBeNull()
    let releaseRenew: ((response: Response) => void) | null = null
    let releaseCurrent: ((response: Response) => void) | null = null
    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes(RENEW_PATH)) {
        return new Promise<Response>((resolve) => {
          releaseRenew = resolve
        })
      }
      if (String(url).includes(CURRENT_PATH)) {
        return new Promise<Response>((resolve) => {
          releaseCurrent = resolve
        })
      }
      if (String(url).includes(LOGOUT_PATH)) return Promise.resolve(jsonResponse({ ok: true, revoked: true }))
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    notifyAuthPrincipalChange()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(callsTo(fetchMock, RENEW_PATH)).toHaveLength(1)

    const loggedOut = useAuth().commitClearedOrdinaryAuth()
    releaseRenew?.(jsonResponse({ ok: true }))
    await expect(loggedOut).resolves.toBe(true)
    expect(readManagedDescriptor()).toBeNull()
    expect(releaseCurrent).not.toBeNull()

    releaseCurrent?.(jsonResponse(currentBody(successor())))
    await flush()
    expect(readManagedDescriptor()).toBeNull()
    expect(callsTo(fetchMock, RENEW_PATH)).toHaveLength(1)
    expect(localStorage.getItem('auth_token')).toBeNull()
  })

  it('does not fire the previous identity timer after a new continuous session is installed', async () => {
    setManagedProbeMarker()
    expect(installManagedDescriptor(descriptor())).not.toBeNull()
    const fetchMock = vi.fn(async () => {
      throw new Error('renew must not run')
    })
    vi.stubGlobal('fetch', fetchMock)
    notifyAuthPrincipalChange()
    const replacement = descriptor({
      sessionId: 'session-b',
      credentialGeneration: 3,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    })
    expect(installManagedDescriptor(replacement)).not.toBeNull()
    notifyAuthPrincipalChange()

    await vi.advanceTimersByTimeAsync(90_000)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(readManagedDescriptor()).toMatchObject({
      sessionId: 'session-b',
      credentialGeneration: 3,
      revision: 4,
    })
  })

  it('does not schedule an ordinary managed descriptor', async () => {
    expect(installManagedDescriptor(descriptor({
      continuityMode: 'ordinary',
      credentialGeneration: null,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    }))).not.toBeNull()
    const fetchMock = vi.fn(async () => {
      throw new Error('ordinary must not renew')
    })
    vi.stubGlobal('fetch', fetchMock)
    notifyAuthPrincipalChange()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not schedule from a snapshot-share marker alone', async () => {
    sessionStorage.setItem(SNAPSHOT_SHARE_KEY, JSON.stringify({
      operationId: 'op-1',
      userId: 'person-a',
      tenantId: 'tenant-a',
      sessionId: 'session-share',
    }))
    const fetchMock = vi.fn(async () => {
      throw new Error('snapshot share must not renew')
    })
    vi.stubGlobal('fetch', fetchMock)
    notifyAuthPrincipalChange()
    await vi.advanceTimersByTimeAsync(180_000)
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(readManagedDescriptor()).toBeNull()
  })

  it('does not schedule managed renewal while an ordinary bearer is stored', async () => {
    localStorage.setItem('auth_token', 'stored-bearer')
    localStorage.setItem('jwt', 'stored-bearer')
    setManagedProbeMarker()
    const expiresAtMs = Date.now() + 180_000
    expect(installManagedDescriptor(descriptor({
      expiresAt: new Date(expiresAtMs).toISOString(),
    }))).not.toBeNull()
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes(ME_PATH)) {
        return jsonResponse({
          success: true,
          data: { user: { id: 'person-a', email: 'a@example.com', role: 'user', permissions: ['stock-prep:read'] } },
        })
      }
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    notifyAuthPrincipalChange()
    await vi.advanceTimersByTimeAsync(90_000)
    expect(Date.now()).toBeGreaterThan(expiresAtMs - 120_000)
    expect(Date.now()).toBeLessThan(expiresAtMs)
    expect(callsTo(fetchMock, RENEW_PATH)).toHaveLength(0)
    expect(callsTo(fetchMock, CURRENT_PATH)).toHaveLength(0)
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(callsTo(fetchMock, ME_PATH)).toHaveLength(1)
    expect(callsTo(fetchMock, RENEW_PATH)).toHaveLength(0)
    expect(readManagedDescriptor()?.sessionId).toBe('session-a')
  })

  it('does not schedule when no managed session is present', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('empty session must not renew')
    })
    vi.stubGlobal('fetch', fetchMock)
    notifyAuthPrincipalChange()
    await vi.advanceTimersByTimeAsync(180_000)
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(readManagedDescriptor()).toBeNull()
  })

  it('bootstraps a capped generation at absolute expiry without renew-recovery', async () => {
    setManagedProbeMarker()
    const started = descriptor({ credentialGeneration: 7 })
    const expiresAtMs = Date.parse(started.expiresAt)
    expect(installManagedDescriptor(started)).not.toBeNull()
    const changed = vi.fn()
    const unsubscribe = onAuthPrincipalChange(changed)
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes(CURRENT_PATH)) return jsonResponse({ success: false }, 401)
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      notifyAuthPrincipalChange()
      changed.mockClear()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(readManagedDescriptor()?.credentialGeneration).toBe(7)
      expect(changed).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(120_000)
      expect(Date.now()).toBe(expiresAtMs)
      expect(callsTo(fetchMock, RENEW_PATH)).toHaveLength(0)
      expect(callsTo(fetchMock, CURRENT_PATH)).toHaveLength(1)
      expect(readManagedDescriptor()).toBeNull()
      expect(changed).toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(90_000)
      expect(callsTo(fetchMock, RENEW_PATH)).toHaveLength(0)
      expect(callsTo(fetchMock, CURRENT_PATH)).toHaveLength(1)
    } finally {
      unsubscribe()
    }
  })

  it('clears the mounted embed rows at absolute expiry while renew-recovery is still pending', async () => {
    installEmbedParent()
    setManagedProbeMarker()
    const started = descriptor()
    const expiresAtMs = Date.parse(started.expiresAt)
    const epoch = readManagedEpoch()
    expect(installManagedDescriptor(started)).not.toBeNull()
    let releaseRenew: ((response: Response) => void) | null = null
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url.includes(RENEW_PATH)) {
        return new Promise<Response>((resolve) => {
          releaseRenew = resolve
        })
      }
      if (url.includes(CURRENT_PATH)) return Promise.resolve(jsonResponse(currentBody(started)))
      if (url.includes('/api/plm-embed/config')) {
        return Promise.resolve(jsonResponse({
          ok: true,
          data: { allowed_origins: [PARENT_ORIGIN], frame_ancestors: "frame-ancestors 'none'", visual_preview_enabled: false },
        }))
      }
      if (url.includes('/api/plm-embed/bom-review/context')) return Promise.resolve(jsonResponse(bomBody('PART-1', 'Initial Part')))
      if (url.includes('/api/plm-embed/discussion')) return Promise.resolve(jsonResponse({ ok: true, data: { threads: [], next_cursor: null } }))
      return Promise.resolve(jsonResponse({ ok: false }, 404))
    })
    vi.stubGlobal('fetch', fetchMock)
    notifyAuthPrincipalChange()
    const root = await showInitialRows()
    expect(root.querySelector('[data-testid="plm-bom-review-part"]')?.textContent).toContain('Initial Part')
    await vi.advanceTimersByTimeAsync(60_000)
    await settle()
    expect(releaseRenew).not.toBeNull()
    expect(callsTo(fetchMock, RENEW_PATH)).toHaveLength(1)
    expect(root.querySelector('[data-testid="plm-bom-review-part"]')?.textContent).toContain('Initial Part')
    expect(Date.now()).toBeLessThan(expiresAtMs)

    await vi.advanceTimersByTimeAsync(120_000)
    await settle()
    expect(Date.now()).toBe(expiresAtMs)
    expect(callsTo(fetchMock, RENEW_PATH)).toHaveLength(1)
    expect(releaseRenew).not.toBeNull()
    expect(callsTo(fetchMock, LOGOUT_PATH)).toHaveLength(0)
    expect(readManagedEpoch()).toBe(epoch)
    expect(root.querySelector('[data-testid="plm-bom-review-part"]')).toBeNull()
    expect(root.querySelector('[data-testid="plm-embed-bom-state"]')?.getAttribute('data-state')).toBe('unavailable')
    expect(root.textContent).not.toContain('Initial Part')
    expect(root.isConnected).toBe(true)
    expect(embedBomReads).toBe(0)
  })

  it('clears the mounted embed rows at absolute expiry while the document stays hidden', async () => {
    installEmbedParent()
    setManagedProbeMarker()
    const started = descriptor()
    const expiresAtMs = Date.parse(started.expiresAt)
    expect(installManagedDescriptor(started)).not.toBeNull()
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url.includes(RENEW_PATH)) return Promise.reject(new Error('hidden document must not renew'))
      if (url.includes(CURRENT_PATH)) return Promise.resolve(jsonResponse(currentBody(started)))
      if (url.includes('/api/plm-embed/config')) {
        return Promise.resolve(jsonResponse({
          ok: true,
          data: { allowed_origins: [PARENT_ORIGIN], frame_ancestors: "frame-ancestors 'none'", visual_preview_enabled: false },
        }))
      }
      if (url.includes('/api/plm-embed/bom-review/context')) return Promise.resolve(jsonResponse(bomBody('PART-1', 'Initial Part')))
      if (url.includes('/api/plm-embed/discussion')) return Promise.resolve(jsonResponse({ ok: true, data: { threads: [], next_cursor: null } }))
      return Promise.resolve(jsonResponse({ ok: false }, 404))
    })
    vi.stubGlobal('fetch', fetchMock)
    notifyAuthPrincipalChange()
    const root = await showInitialRows()
    expect(root.querySelector('[data-testid="plm-bom-review-part"]')?.textContent).toContain('Initial Part')
    let visibility = 'hidden'
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })

    await vi.advanceTimersByTimeAsync(60_000)
    await settle()
    expect(callsTo(fetchMock, RENEW_PATH)).toHaveLength(0)
    expect(root.querySelector('[data-testid="plm-bom-review-part"]')?.textContent).toContain('Initial Part')

    await vi.advanceTimersByTimeAsync(120_000)
    await settle()
    expect(Date.now()).toBe(expiresAtMs)
    expect(visibility).toBe('hidden')
    expect(callsTo(fetchMock, RENEW_PATH)).toHaveLength(0)
    expect(root.querySelector('[data-testid="plm-bom-review-part"]')).toBeNull()
    expect(root.querySelector('[data-testid="plm-embed-bom-state"]')?.getAttribute('data-state')).toBe('unavailable')
    expect(root.textContent).not.toContain('Initial Part')
    expect(embedBomReads).toBe(0)
  })
})
