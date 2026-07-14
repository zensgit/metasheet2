/**
 * Cut-3 next slice — the discussion panel integration test. Drives create + reply + resolve +
 * reopen through the REAL child token client, with the parent (postMessage mint) and the relay
 * (apiFetch, route-aware) mocked. Pins: each action mints its OWN fresh token (4 distinct tokens
 * across the 4 actions); one token = one relay call; rendered state comes from the SERVER response
 * (status/comments), never a local optimistic mutation; submit disabled on lost origin; client
 * disposed on unmount.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import PlmEmbedDiscussionPanel from '../src/components/plm/PlmEmbedDiscussionPanel.vue'

const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))

const PLM_ORIGIN = 'https://plm.example.com'
const TARGET = { target_type: 'item' as const, target_id: 'PART-1' }

// Route-aware relay: create/reply keep the thread open; resolve -> resolved; reopen -> open.
function relayFor(path: string) {
  let status = 'open'
  const comments = [{ id: 'c1', body: 'hi' }]
  if (path.endsWith('/resolve')) status = 'resolved'
  else if (path.endsWith('/reopen')) status = 'open'
  else if (path.endsWith('/comments')) comments.push({ id: 'c2', body: 'reply' })
  return { ok: true, status: 200, json: async () => ({ ok: true, data: { id: 't1', status, comments } }) }
}

let app: App | null = null
let host: HTMLElement
let postSpy: ReturnType<typeof vi.spyOn>
let mintedTokens: string[]

function tokenOf(callIndex: number): string {
  return (apiFetchMock.mock.calls[callIndex][1] as { headers: Record<string, string> }).headers['X-PLM-Embed-Token']
}
function q<T extends HTMLElement>(sel: string): T { return host.querySelector(sel) as T }

async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  await nextTick()
}

function mount(props: Record<string, unknown>) {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(PlmEmbedDiscussionPanel, props)
  app.mount(host)
}

describe('PlmEmbedDiscussionPanel — create + reply + resolve + reopen', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
    apiFetchMock.mockImplementation(async (path: string) => relayFor(path))
    mintedTokens = []
    postSpy = vi.spyOn(window.parent, 'postMessage').mockImplementation((msg: unknown) => {
      const m = msg as { type?: string; nonce?: string }
      if (m?.type === 'plm-embed:token-request' && typeof m.nonce === 'string') {
        const token = `tok-${mintedTokens.length + 1}`
        mintedTokens.push(token)
        queueMicrotask(() =>
          window.dispatchEvent(new MessageEvent('message', {
            origin: PLM_ORIGIN, source: window.parent,
            data: { type: 'plm-embed:token-response', nonce: m.nonce, token },
          })),
        )
      }
    })
  })

  afterEach(() => {
    app?.unmount(); app = null; host?.remove(); postSpy.mockRestore()
  })

  it('all four actions each mint their OWN fresh token; state comes from the server response', async () => {
    mount({ parentOrigin: PLM_ORIGIN, target: TARGET })

    // create
    const ci = q<HTMLTextAreaElement>('[data-testid="plm-discussion-create-input"]')
    ci.value = 'new thread'; ci.dispatchEvent(new Event('input')); await nextTick()
    q<HTMLFormElement>('[data-testid="plm-discussion-create"]').dispatchEvent(new Event('submit'))
    await settle()
    expect(q('[data-testid="plm-discussion-thread-status-t1"]').textContent).toBe('open')

    // reply
    const ri = q<HTMLInputElement>('[data-testid="plm-discussion-reply-input-t1"]')
    ri.value = 'a reply'; ri.dispatchEvent(new Event('input')); await nextTick()
    q('[data-thread-id="t1"] form').dispatchEvent(new Event('submit'))
    await settle()
    expect(host.querySelectorAll('[data-thread-id="t1"] .plm-disc-panel__comment').length).toBe(2)

    // resolve -> status from the server response
    q<HTMLButtonElement>('[data-testid="plm-discussion-resolve-t1"]').click()
    await settle()
    expect(q('[data-testid="plm-discussion-thread-status-t1"]').textContent).toBe('resolved')

    // reopen
    q<HTMLButtonElement>('[data-testid="plm-discussion-reopen-t1"]').click()
    await settle()
    expect(q('[data-testid="plm-discussion-thread-status-t1"]').textContent).toBe('open')

    // 4 relay calls, 4 DISTINCT tokens, correct routes
    expect(apiFetchMock).toHaveBeenCalledTimes(4)
    const tokens = [tokenOf(0), tokenOf(1), tokenOf(2), tokenOf(3)]
    expect(new Set(tokens).size).toBe(4)
    expect(tokens).toEqual(['tok-1', 'tok-2', 'tok-3', 'tok-4'])
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/plm-embed/discussion/threads')
    expect(apiFetchMock.mock.calls[1][0]).toBe('/api/plm-embed/discussion/threads/t1/comments')
    expect(apiFetchMock.mock.calls[2][0]).toBe('/api/plm-embed/discussion/threads/t1/resolve')
    expect(apiFetchMock.mock.calls[3][0]).toBe('/api/plm-embed/discussion/threads/t1/reopen')
  })

  it('a failed action keeps state and mints a NEW token on retry (no cache/replay)', async () => {
    apiFetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ ok: false, error: { code: 'X' } }) })
    apiFetchMock.mockImplementation(async (path: string) => relayFor(path))
    mount({ parentOrigin: PLM_ORIGIN, target: TARGET })
    const ci = q<HTMLTextAreaElement>('[data-testid="plm-discussion-create-input"]')
    ci.value = 'try'; ci.dispatchEvent(new Event('input')); await nextTick()
    q<HTMLFormElement>('[data-testid="plm-discussion-create"]').dispatchEvent(new Event('submit'))
    await settle()
    expect(q('[data-testid="plm-discussion-error"]')).toBeTruthy()
    expect(ci.value).toBe('try') // draft kept
    // retry
    q<HTMLFormElement>('[data-testid="plm-discussion-create"]').dispatchEvent(new Event('submit'))
    await settle()
    expect(mintedTokens).toEqual(['tok-1', 'tok-2']) // brand-new token
    expect(host.querySelector('[data-thread-id="t1"]')).toBeTruthy()
  })

  it('lost pinned origin: create/reply disabled and no token requested', async () => {
    mount({ parentOrigin: null, target: TARGET })
    expect(q<HTMLTextAreaElement>('[data-testid="plm-discussion-create-input"]').disabled).toBe(true)
    q<HTMLFormElement>('[data-testid="plm-discussion-create"]').dispatchEvent(new Event('submit'))
    await settle()
    expect(postSpy).not.toHaveBeenCalled()
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('unmount disposes the token client (removes the message listener)', async () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    mount({ parentOrigin: PLM_ORIGIN, target: TARGET })
    app?.unmount(); app = null
    expect(removeSpy).toHaveBeenCalledWith('message', expect.any(Function))
    removeSpy.mockRestore()
  })
})
