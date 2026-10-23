import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import {
  bumpManagedEpoch,
  clearManagedDescriptor,
  clearManagedProbeMarker,
  installManagedDescriptor,
  notifyAuthPrincipalChange,
  readAuthSessionSignature,
  readManagedDescriptor,
  type ManagedSessionDescriptor,
} from '../src/composables/authPrincipal'
import { getPlmEmbedBomContext, getPlmEmbedManagedBomContext } from '../src/services/integration/plmEmbed'

const bootstrapSession = vi.fn(async () => ({ ok: true, status: 200, payload: null }))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({ bootstrapSession }),
  installPermissionSnapshotRefresh: () => {},
}))

import PlmEmbedBomReviewView from '../src/views/PlmEmbedBomReviewView.vue'

const PARENT = 'https://plm.example'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
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

function descriptor(overrides: Partial<ManagedSessionDescriptor> = {}): ManagedSessionDescriptor {
  return {
    mode: 'managed-cookie',
    userId: 'person-a',
    tenantId: 'tenant-a',
    sessionId: 'session-a',
    revision: 4,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    continuityMode: 'continuous',
    credentialGeneration: 0,
    ...overrides,
  }
}

let app: VueApp | null = null
let container: HTMLDivElement | null = null
let posts: { data: Record<string, unknown>; origin: string }[] = []
let contextTokens: string[] = []
let bomReads = 0
let refuseNextContext = false
let held: Promise<Response> | null = null
let holdInitial: Promise<Response> | null = null
const originalPostMessage = window.postMessage.bind(window)
const originalParent = window.parent

function headerBag(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers)
}

function installFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/plm-embed/config')) {
      return json({
        ok: true,
        data: {
          allowed_origins: [PARENT, '*'],
          frame_ancestors: "frame-ancestors 'none'",
          visual_preview_enabled: false,
        },
      })
    }
    if (url.includes('/api/plm-embed/bom-review/context')) {
      const token = headerBag(init).get('X-PLM-Embed-Token') ?? ''
      contextTokens.push(token)
      if (holdInitial && contextTokens.length === 1) return holdInitial
      if (held && contextTokens.length > 1) return held
      if (refuseNextContext) {
        refuseNextContext = false
        return json({ ok: false, error: { code: 'PLM_MANAGED_READ_REFUSED' } }, 403)
      }
      if (token === 'fresh-bom-token') return json(bomBody('PART-1', 'Refreshed Part'))
      if (token === 'other-part-token') return json(bomBody('PART-2', 'Other Part'))
      return json(bomBody('PART-1', 'Initial Part'))
    }
    if (url.includes('/api/plm-embed/discussion')) {
      return json({ ok: true, data: { threads: [], next_cursor: null } })
    }
    return json({ ok: false }, 404)
  }))
}

function installParent(): void {
  posts = []
  bomReads = 0
  window.postMessage = ((data: unknown, origin: string) => {
    const record = data && typeof data === 'object' ? data as Record<string, unknown> : {}
    posts.push({ data: record, origin: String(origin) })
    if (record.type !== 'plm-embed:token-request') return
    let token = 'discussion-token'
    if (record.purpose === 'bom-read') {
      bomReads += 1
      token = bomReads > 1 ? 'other-part-token' : 'fresh-bom-token'
    }
    queueMicrotask(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'plm-embed:token-response', nonce: record.nonce, token },
        origin: String(origin),
        source: window.parent,
      }))
    })
  }) as typeof window.postMessage
}

async function mountView(): Promise<HTMLElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(PlmEmbedBomReviewView)
  app.mount(container)
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
  const root = container.querySelector('[data-testid="plm-embed-bom-review"]')
  if (!(root instanceof HTMLElement)) throw new Error('embed view did not mount')
  return root
}

function deliver(data: unknown, origin = PARENT, source: unknown = window.parent): void {
  window.dispatchEvent(new MessageEvent('message', {
    data,
    origin,
    source: source as Window,
  }))
}

async function showInitial(token = 'initial-token'): Promise<HTMLElement> {
  const root = await mountView()
  deliver({ type: 'plm-embed:token', token })
  await vi.waitFor(() => expect(root.querySelector('[data-testid="plm-bom-review-part"]')?.textContent).toContain('Initial Part'))
  return root
}

function bomPurposeCount(): number {
  return posts.filter((entry) => entry.data.purpose === 'bom-read').length
}

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  clearManagedDescriptor()
  clearManagedProbeMarker()
  localStorage.clear()
  posts = []
  contextTokens = []
  bomReads = 0
  refuseNextContext = false
  held = null
  holdInitial = null
  bootstrapSession.mockClear()
  window.postMessage = originalPostMessage
  Object.defineProperty(window, 'parent', { configurable: true, value: originalParent })
  vi.unstubAllGlobals()
})

describe('managed embed BOM fetch', () => {
  it('uses the purpose cookie only and does not treat 401 or 409 as a BOM', async () => {
    const href = window.location.href
    localStorage.setItem('auth_token', 'ordinary-bearer')
    localStorage.setItem('tenantId', 'tenant-from-storage')
    const calls: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {})
      const status = calls.length === 1 ? 409 : 401
      return json({ ok: true, data: bomBody('PART-9', 'Should Not Render').data }, status)
    }))
    const conflict = await getPlmEmbedManagedBomContext('embed-token')
    const denied = await getPlmEmbedManagedBomContext('embed-token')
    expect(conflict).toEqual({ available: false, reason: 'unavailable' })
    expect(denied).toEqual({ available: false, reason: 'unavailable' })
    expect(window.location.href).toBe(href)
    for (const init of calls) {
      const headers = headerBag(init)
      expect(headers.get('Authorization')).toBeNull()
      expect(headers.get('x-tenant-id')).toBeNull()
      expect(headers.get('X-PLM-Embed-Token')).toBe('embed-token')
      expect(init.credentials).toBe('include')
      expect(JSON.stringify(init.headers)).not.toContain('ordinary-bearer')
      expect(JSON.stringify(init.headers)).not.toContain('yur_')
    }
  })

  it('keeps the legacy token call on its existing bearer path without a login redirect', async () => {
    const href = window.location.href
    localStorage.setItem('auth_token', 'ordinary-bearer')
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = headerBag(init)
      expect(headers.get('Authorization')).toBe('Bearer ordinary-bearer')
      expect(headers.get('X-PLM-Embed-Token')).toBe('legacy-token')
      return json({ ok: false }, 401)
    }))
    await expect(getPlmEmbedBomContext('legacy-token')).resolves.toEqual({ available: false, reason: 'unavailable' })
    expect(window.location.href).toBe(href)
  })
})

describe('original iframe BOM continuity', () => {
  it('keeps the mounted document and refreshes on a successor session, not the old session id', async () => {
    installFetch()
    installParent()
    expect(installManagedDescriptor(descriptor({ credentialGeneration: 1, sessionId: 'session-a' }))).not.toBeNull()
    const root = await showInitial()
    const href = window.location.href
    const predecessorSignature = readAuthSessionSignature()
    expect(bootstrapSession).toHaveBeenCalledTimes(1)
    expect(bomPurposeCount()).toBe(0)
    expect(contextTokens).toEqual(['initial-token'])
    const firstContext = (fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls
      .filter((call) => String(call[0]).includes('/bom-review/context'))[0]?.[1]
    expect(firstContext?.credentials).toBe('include')
    expect(headerBag(firstContext).get('Authorization')).toBeNull()
    deliver({ type: 'plm-embed:token', token: 'initial-token' })
    deliver({ type: 'nope', token: 'initial-token' })
    await nextTick()
    expect(contextTokens).toEqual(['initial-token'])
    expect(installManagedDescriptor(descriptor({
      credentialGeneration: 2,
      sessionId: 'session-successor',
      userId: 'person-a',
      tenantId: 'tenant-a',
      revision: 4,
    }))).not.toBeNull()
    const successorSignature = readAuthSessionSignature()
    expect(successorSignature).not.toBe(predecessorSignature)
    expect(readManagedDescriptor()).toMatchObject({
      userId: 'person-a',
      tenantId: 'tenant-a',
      revision: 4,
      sessionId: 'session-successor',
      credentialGeneration: 2,
    })
    notifyAuthPrincipalChange()
    await vi.waitFor(() => expect(root.textContent).toContain('Refreshed Part'))
    expect(container?.querySelector('[data-testid="plm-embed-bom-review"]')).toBe(root)
    expect(window.location.href).toBe(href)
    expect(contextTokens).toEqual(['initial-token', 'fresh-bom-token'])
    expect(posts.filter((entry) => entry.data.purpose === 'bom-read').every((entry) => entry.origin === PARENT)).toBe(true)
    expect(posts.some((entry) => entry.origin === '*')).toBe(false)
    expect(contextTokens).not.toContain('discussion-token')
    expect(posts.some((entry) => entry.data.purpose === 'discussion-write')).toBe(false)
    expect(JSON.stringify(posts)).not.toContain('yur_')
    expect(JSON.stringify(posts)).not.toContain('session-successor')
  })

  it('drops a late refresh after an epoch change and does not reload the document', async () => {
    installFetch()
    installParent()
    expect(installManagedDescriptor(descriptor({ credentialGeneration: 3, sessionId: 'session-a' }))).not.toBeNull()
    const root = await showInitial()
    let resolveHeld: (response: Response) => void = () => {}
    held = new Promise((resolve) => { resolveHeld = resolve })
    expect(installManagedDescriptor(descriptor({
      credentialGeneration: 4,
      sessionId: 'session-successor',
    }))).not.toBeNull()
    notifyAuthPrincipalChange()
    await vi.waitFor(() => expect(contextTokens).toEqual(['initial-token', 'fresh-bom-token']))
    bumpManagedEpoch()
    notifyAuthPrincipalChange()
    resolveHeld(json(bomBody('PART-1', 'Leaked Late Part')))
    await Promise.resolve()
    await nextTick()
    expect(root.textContent).not.toContain('Leaked Late Part')
    expect(root.querySelector('[data-testid="plm-embed-bom-state"]')?.getAttribute('data-state')).toBe('unavailable')
    expect(container?.querySelector('[data-testid="plm-embed-bom-review"]')).toBe(root)
  })

  it('rejects the wrong parent, origin, and malformed initial messages, and clears on identity, logout, and ordinary mode', async () => {
    installFetch()
    installParent()
    const root = await mountView()
    deliver({ type: 'plm-embed:token' }, PARENT)
    deliver({ type: 'plm-embed:token', token: 'initial-token' }, 'https://evil.example')
    deliver({ type: 'plm-embed:token', token: 'initial-token' }, PARENT, {})
    deliver('not-an-object')
    await nextTick()
    expect(root.querySelector('[data-testid="plm-embed-bom-state"]')?.getAttribute('data-state')).toBe('awaiting-token')
    expect(contextTokens).toEqual([])
    deliver({ type: 'plm-embed:token', token: 'initial-token' })
    await vi.waitFor(() => expect(root.textContent).toContain('Initial Part'))
    expect(bomPurposeCount()).toBe(0)
    localStorage.setItem('metasheet_plm_snapshot_share', 'snapshot-user')
    notifyAuthPrincipalChange()
    await nextTick()
    expect(root.textContent).toContain('Initial Part')
    expect(bomPurposeCount()).toBe(0)

    expect(installManagedDescriptor(descriptor({ continuityMode: 'ordinary', credentialGeneration: null }))).not.toBeNull()
    notifyAuthPrincipalChange()
    await nextTick()
    expect(root.querySelector('[data-testid="plm-embed-bom-state"]')?.getAttribute('data-state')).toBe('unavailable')
    expect(bomPurposeCount()).toBe(0)

    expect(installManagedDescriptor(descriptor({ credentialGeneration: 1 }))).not.toBeNull()
    notifyAuthPrincipalChange()
    expect(bomPurposeCount()).toBe(0)
    clearManagedDescriptor()
    bumpManagedEpoch()
    notifyAuthPrincipalChange()
    await nextTick()
    expect(bomPurposeCount()).toBe(0)
    expect(root.textContent).not.toContain('Initial Part')
  })

  it('fail-closes a managed denial and a part change without a discussion token or frame reload', async () => {
    installFetch()
    installParent()
    expect(installManagedDescriptor(descriptor({ credentialGeneration: 2, sessionId: 'session-a' }))).not.toBeNull()
    const root = await showInitial()
    refuseNextContext = true
    expect(installManagedDescriptor(descriptor({
      credentialGeneration: 3,
      sessionId: 'session-deny',
    }))).not.toBeNull()
    notifyAuthPrincipalChange()
    await vi.waitFor(() => expect(root.querySelector('[data-testid="plm-embed-bom-state"]')?.getAttribute('data-state')).toBe('unavailable'))
    expect(root.textContent).not.toContain('Initial Part')
    expect(contextTokens.at(-1)).toBe('fresh-bom-token')
    expect(window.location.pathname).not.toContain('login')

    expect(installManagedDescriptor(descriptor({
      credentialGeneration: 4,
      sessionId: 'session-other',
    }))).not.toBeNull()
    notifyAuthPrincipalChange()
    await vi.waitFor(() => expect(contextTokens.at(-1)).toBe('other-part-token'))
    await nextTick()
    expect(root.textContent).not.toContain('Other Part')
    expect(root.querySelector('[data-testid="plm-embed-bom-state"]')?.getAttribute('data-state')).not.toBe('table')
  })

  it('does not treat a same-session generation bump, a session swap, or a user switch as renewal', async () => {
    installFetch()
    installParent()
    expect(installManagedDescriptor(descriptor({ credentialGeneration: 1, sessionId: 'session-a' }))).not.toBeNull()
    const sameSession = await showInitial()
    const sameSessionSignature = readAuthSessionSignature()
    expect(installManagedDescriptor(descriptor({ credentialGeneration: 2, sessionId: 'session-a' }))).not.toBeNull()
    expect(readAuthSessionSignature()).toBe(sameSessionSignature)
    notifyAuthPrincipalChange()
    await nextTick()
    expect(bomPurposeCount()).toBe(0)
    expect(sameSession.querySelector('[data-testid="plm-embed-bom-state"]')?.getAttribute('data-state')).toBe('unavailable')
    expect(sameSession.textContent).not.toContain('Initial Part')

    app?.unmount()
    container?.remove()
    app = null
    container = null
    expect(installManagedDescriptor(descriptor({ credentialGeneration: 1, sessionId: 'session-a' }))).not.toBeNull()
    const swapped = await showInitial()
    const predecessorSignature = readAuthSessionSignature()
    expect(installManagedDescriptor(descriptor({ credentialGeneration: 1, sessionId: 'session-swapped' }))).not.toBeNull()
    expect(readAuthSessionSignature()).not.toBe(predecessorSignature)
    notifyAuthPrincipalChange()
    await nextTick()
    expect(bomPurposeCount()).toBe(0)
    expect(swapped.textContent).not.toContain('Initial Part')

    app?.unmount()
    container?.remove()
    app = null
    container = null
    expect(installManagedDescriptor(descriptor({
      credentialGeneration: 1,
      sessionId: 'session-a',
      userId: 'person-a',
    }))).not.toBeNull()
    const switched = await showInitial()
    expect(installManagedDescriptor(descriptor({
      credentialGeneration: 3,
      sessionId: 'session-other-user',
      userId: 'person-b',
    }))).not.toBeNull()
    notifyAuthPrincipalChange()
    await nextTick()
    expect(bomPurposeCount()).toBe(0)
    expect(switched.querySelector('[data-testid="plm-embed-bom-state"]')?.getAttribute('data-state')).not.toBe('table')
    expect(switched.textContent).not.toContain('Initial Part')
  })

  it('drops the predecessor body after the successor session is installed', async () => {
    installFetch()
    installParent()
    expect(installManagedDescriptor(descriptor({ credentialGeneration: 1, sessionId: 'session-a' }))).not.toBeNull()
    let releaseInitial: (response: Response) => void = () => {}
    holdInitial = new Promise((resolve) => { releaseInitial = resolve })
    const root = await mountView()
    const predecessorSignature = readAuthSessionSignature()
    deliver({ type: 'plm-embed:token', token: 'initial-token' })
    await vi.waitFor(() => expect(contextTokens).toEqual(['initial-token']))
    expect(installManagedDescriptor(descriptor({
      credentialGeneration: 2,
      sessionId: 'session-successor',
    }))).not.toBeNull()
    expect(readAuthSessionSignature()).not.toBe(predecessorSignature)
    notifyAuthPrincipalChange()
    await vi.waitFor(() => expect(contextTokens).toEqual(['initial-token', 'fresh-bom-token']))
    releaseInitial(json(bomBody('PART-1', 'Predecessor Late Part')))
    await vi.waitFor(() => expect(root.textContent).toContain('Refreshed Part'))
    expect(root.textContent).not.toContain('Predecessor Late Part')
    expect(container?.querySelector('[data-testid="plm-embed-bom-review"]')).toBe(root)
  })

  it('keeps a stored bearer off the managed read and does not renew under that bearer', async () => {
    installFetch()
    installParent()
    localStorage.setItem('auth_token', 'ordinary-bearer')
    expect(installManagedDescriptor(descriptor({ credentialGeneration: 1, sessionId: 'session-a' }))).not.toBeNull()
    const root = await showInitial()
    const firstContext = (fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls
      .filter((call) => String(call[0]).includes('/bom-review/context'))[0]?.[1]
    expect(headerBag(firstContext).get('Authorization')).toBeNull()
    expect(headerBag(firstContext).get('X-PLM-Embed-Token')).toBe('initial-token')
    const signature = readAuthSessionSignature()
    expect(installManagedDescriptor(descriptor({
      credentialGeneration: 2,
      sessionId: 'session-successor',
    }))).not.toBeNull()
    expect(readAuthSessionSignature()).toBe(signature)
    notifyAuthPrincipalChange()
    await nextTick()
    expect(bomPurposeCount()).toBe(0)
    expect(root.querySelector('[data-testid="plm-embed-bom-state"]')?.getAttribute('data-state')).toBe('unavailable')
    expect(JSON.stringify(posts)).not.toContain('ordinary-bearer')
  })
})
