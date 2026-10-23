import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import {
  bumpManagedEpoch, clearManagedDescriptor, clearManagedProbeMarker,
  installManagedDescriptor, notifyAuthPrincipalChange, readManagedDescriptor,
  setManagedProbeMarker, type ManagedSessionDescriptor,
} from '../src/composables/authPrincipal'
import { installPermissionSnapshotRefresh, useAuth } from '../src/composables/useAuth'
import PlmEmbedBomReviewView from '../src/views/PlmEmbedBomReviewView.vue'

const PARENT = 'https://plm.example'
const RENEW = '/api/plm/managed-login/renew-recovery'
const CURRENT = '/api/plm/managed-login/current'
const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
let app: VueApp | null = null
let container: HTMLDivElement | null = null
let settle: (() => void) | null = null
let clock = Date.UTC(2026, 9, 23, 10)

const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
})
async function flush() {
  for (let i = 0; i < 40; i += 1) { await Promise.resolve(); await nextTick() }
}
function currentBody(session: ManagedSessionDescriptor) {
  return { success: true, data: {
    user: { id: session.userId, tenantId: session.tenantId, role: 'user', permissions: [], must_change_password: false },
    features: { plm: true, attendance: false, workflow: false }, managedSession: session,
  } }
}
const bom = { ok: true, data: {
  available: true, entitled: true, part_id: 'PART-1', context: {
    part: { part_id: 'PART-1', item_number: 'PART-1', name: 'Deadline Protected Part', state: 'released', generation: 1 },
    lines: [], source_version: 1, source_updated_at: null, sync_status: 'current', template_key: 'bom',
  },
} }

beforeEach(() => {
  clock += 2 * 60 * 60_000
  vi.useFakeTimers()
  vi.setSystemTime(clock)
  window.history.replaceState(null, '', '/')
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  let tail = Promise.resolve()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: (_name: string, _options: unknown, callback: () => unknown) => {
      const run = tail.then(callback); tail = run.then(() => undefined, () => undefined); return run
    },
  } })
  installPermissionSnapshotRefresh()
})
afterEach(async () => {
  app?.unmount(); app = null; container?.remove(); container = null
  clearManagedDescriptor(); clearManagedProbeMarker(); bumpManagedEpoch()
  localStorage.clear(); sessionStorage.clear(); notifyAuthPrincipalChange()
  settle?.(); settle = null; await flush()
  vi.useRealTimers(); vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'locks')
  if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility)
  else Reflect.deleteProperty(document, 'visibilityState')
})

describe('root independent mounted absolute expiry', () => {
  it.each(['renew', 'current', 'body', 'generation-cap', 'hidden', 'throttled', 'current-resume', 'body-resume', 'malformed-current', 'invalid-json'] as const)(
    'clears the original mounted rows at deadline when %s prevents renewal completion', async (stage) => {
      const initial: ManagedSessionDescriptor = {
        mode: 'managed-cookie', userId: 'person-a', tenantId: 'tenant-a', sessionId: `session-${stage}-${clock}`,
        revision: 4, expiresAt: new Date(clock + (stage === 'throttled' ? 10_000 : 180_000)).toISOString(),
        continuityMode: 'continuous', credentialGeneration: stage === 'generation-cap' ? 7 : 1,
      }
      const successor = { ...initial, sessionId: 'session-late', credentialGeneration: 2,
        expiresAt: new Date(clock + 600_000).toISOString() }
      let release: (value: Response) => void = () => {}
      const heldResponse = new Promise<Response>((resolve) => { release = resolve })
      let releaseBody: (value: unknown) => void = () => {}
      const heldBody = new Promise((resolve) => { releaseBody = resolve })
      settle = () => {
        // This current request starts only after cap expiry; the real provider refuses
        // the expired cap. It is not a stale request started under the old descriptor.
        release(stage === 'generation-cap'
          ? new Response(JSON.stringify({ error: 'expired' }), { status: 401 })
          : json(stage === 'renew' ? { ok: true } : currentBody(successor)))
        releaseBody(currentBody(successor))
      }
      let currentCalls = 0
      let heldBodyReads = 0
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/api/plm-embed/config')) return json({ ok: true, data: {
          allowed_origins: [PARENT], frame_ancestors: "frame-ancestors 'none'", visual_preview_enabled: false,
        } })
        if (url.includes('/api/plm-embed/bom-review/context')) return json(bom)
        if (url.includes('/api/plm-embed/discussion')) return json({ ok: true, data: { threads: [], next_cursor: null } })
        if (url.includes(RENEW)) {
          if (stage === 'throttled') throw new Error('lost renew response')
          return stage === 'renew' ? heldResponse : json({ ok: true })
        }
        if (url.includes(CURRENT)) {
          currentCalls += 1
          if (stage !== 'throttled' && currentCalls === 1) return json(currentBody(initial))
          if (stage === 'malformed-current') return json({ success: true, data: { user: { id: initial.userId } } })
          if (stage === 'invalid-json') return new Response('{invalid-json', { status: 200 })
          if (stage === 'current' || stage === 'generation-cap' || stage === 'current-resume') return heldResponse
          if (stage === 'body' || stage === 'body-resume') {
            const response = json({}); response.json = () => { heldBodyReads += 1; return heldBody }; return response
          }
          return json(currentBody(successor))
        }
        if (url.includes('/api/plm/managed-login/logout')) return json({ ok: true })
        throw new Error(`Unexpected transport ${url}`)
      })
      vi.stubGlobal('fetch', fetchMock)
      setManagedProbeMarker(); expect(installManagedDescriptor(initial)).not.toBeNull()
      // A short remaining TTL models an already bootstrapped mounted session. All other
      // cases perform their own initial current request with a unique session identity.
      if (stage === 'throttled') useAuth().primeSession(currentBody(initial))
      notifyAuthPrincipalChange()
      container = document.createElement('div'); document.body.appendChild(container)
      app = createApp(PlmEmbedBomReviewView); app.mount(container); await flush()
      expect(currentCalls).toBe(stage === 'throttled' ? 0 : 1)
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'plm-embed:token', token: 'initial-read-token' }, origin: PARENT, source: window.parent,
      }))
      await flush()
      const root = container.querySelector('[data-testid="plm-embed-bom-review"]')!
      expect(root.textContent).toContain('Deadline Protected Part')
      if (stage === 'hidden') Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      if (stage === 'throttled') { window.dispatchEvent(new Event('focus')); await flush() }
      await vi.advanceTimersByTimeAsync(stage === 'throttled' ? 0 : 60_000); await flush()
      const renewCount = () => fetchMock.mock.calls.filter(([url]) => String(url).includes(RENEW)).length
      expect(renewCount()).toBe(stage === 'generation-cap' || stage === 'hidden' ? 0 : 1)
      if (stage === 'current' || stage === 'body' || stage === 'current-resume' || stage === 'body-resume' || stage === 'malformed-current' || stage === 'invalid-json') {
        expect(currentCalls).toBe(2)
      }
      expect(heldBodyReads).toBe(stage === 'body' || stage === 'body-resume' ? 1 : 0)
      if (stage === 'malformed-current' || stage === 'invalid-json') {
        // The current response resolved without a usable principal before expiry.
        // Its cleared descriptor must not leave old mounted rows beyond the deadline.
        await vi.advanceTimersByTimeAsync(120_000); await flush()
      } else if (stage === 'current-resume' || stage === 'body-resume') {
        // Resume completes transport before the overdue timeout task gets a turn.
        vi.setSystemTime(Date.parse(initial.expiresAt) + 1)
        settle?.(); await flush()
      } else {
        await vi.advanceTimersByTimeAsync(stage === 'throttled' ? 9_999 : 119_999); await flush()
        expect(root.textContent).toContain('Deadline Protected Part')
        await vi.advanceTimersByTimeAsync(1); await flush()
      }
      // No descriptor getter, bootstrap, focus, or manual principal notification drives this oracle.
      expect(root.textContent).not.toContain('Deadline Protected Part')
      expect(root.querySelector('[data-testid="plm-embed-bom-state"]')?.getAttribute('data-state')).toBe('unavailable')
      expect(container.querySelector('[data-testid="plm-embed-bom-review"]')).toBe(root)
      expect(readManagedDescriptor()).toBeNull()
      settle?.(); await flush()
      expect(root.textContent).not.toContain('Deadline Protected Part')
      expect(readManagedDescriptor()).toBeNull()
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/auth/me'))).toBe(false)
    },
  )
})
