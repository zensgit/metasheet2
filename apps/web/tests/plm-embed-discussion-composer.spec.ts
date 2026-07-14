/**
 * Cut 3 integration test — drives the visible composer through the REAL child token client
 * (plmEmbedWriteToken) end-to-end, with the parent (postMessage mint) and the relay (apiFetch)
 * mocked. Pins the owner's execution boundaries: a FRESH requestWriteToken() per submit; one token
 * = one relay call; a failure retry mints a brand-new token (never cached/replayed); submit is
 * disabled the moment the pinned origin is lost; and the client is disposed on unmount.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import PlmEmbedDiscussionComposer from '../src/components/plm/PlmEmbedDiscussionComposer.vue'

// The relay transport. composer -> createDiscussionThread -> writeCall -> apiFetch.
const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))

const PLM_ORIGIN = 'https://plm.example.com'
const TARGET = { target_type: 'item' as const, target_id: 'PART-1' }

function relayOk(data: unknown = { id: 't1' }) {
  return { ok: true, status: 200, json: async () => ({ ok: true, data }) }
}
function relayErr(status: number) {
  return { ok: false, status, json: async () => ({ ok: false, error: { code: 'X' } }) }
}

let app: App | null = null
let host: HTMLElement
let postSpy: ReturnType<typeof vi.spyOn>
let mintedTokens: string[]

function mount(props: Record<string, unknown>) {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(PlmEmbedDiscussionComposer, props)
  app.mount(host)
}

function q<T extends HTMLElement>(sel: string): T {
  return host.querySelector(sel) as T
}

async function typeAndSubmit(text: string) {
  const ta = q<HTMLTextAreaElement>('[data-testid="plm-discussion-composer-input"]')
  ta.value = text
  ta.dispatchEvent(new Event('input'))
  await nextTick()
  q<HTMLFormElement>('[data-testid="plm-discussion-composer"]').dispatchEvent(new Event('submit'))
  // let requestWriteToken resolve (parent auto-mints) + the relay call settle
  for (let i = 0; i < 6; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  await nextTick()
}

describe('PlmEmbedDiscussionComposer — write-UI Cut 3', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
    mintedTokens = []
    // The parent: on every token-request, mint a DISTINCT token and post it back correlated by nonce.
    postSpy = vi.spyOn(window.parent, 'postMessage').mockImplementation((msg: unknown, _origin?: unknown) => {
      const m = msg as { type?: string; nonce?: string }
      if (m?.type === 'plm-embed:token-request' && typeof m.nonce === 'string') {
        const token = `embed-token-${mintedTokens.length + 1}`
        mintedTokens.push(token)
        queueMicrotask(() =>
          window.dispatchEvent(
            new MessageEvent('message', {
              origin: PLM_ORIGIN,
              source: window.parent,
              data: { type: 'plm-embed:token-response', nonce: m.nonce, token },
            }),
          ),
        )
      }
    })
  })

  afterEach(() => {
    app?.unmount()
    app = null
    host?.remove()
    postSpy.mockRestore()
  })

  it('happy submit: requests ONE fresh token and makes exactly ONE relay call with it + the bound target', async () => {
    apiFetchMock.mockResolvedValue(relayOk())
    mount({ parentOrigin: PLM_ORIGIN, target: TARGET })
    await typeAndSubmit('first comment')

    expect(mintedTokens).toEqual(['embed-token-1'])
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    const [path, opts] = apiFetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }]
    expect(path).toBe('/api/plm-embed/discussion/threads')
    expect(opts.headers['X-PLM-Embed-Token']).toBe('embed-token-1')
    expect(JSON.parse(opts.body)).toMatchObject({ target_type: 'item', target_id: 'PART-1', body: 'first comment' })
    // draft cleared on success
    expect(q<HTMLTextAreaElement>('[data-testid="plm-discussion-composer-input"]').value).toBe('')
  })

  it('fresh token per submit: two submits mint two DISTINCT tokens (no cache/replay)', async () => {
    apiFetchMock.mockResolvedValue(relayOk())
    mount({ parentOrigin: PLM_ORIGIN, target: TARGET })
    await typeAndSubmit('one')
    await typeAndSubmit('two')
    expect(mintedTokens).toEqual(['embed-token-1', 'embed-token-2'])
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    expect((apiFetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers['X-PLM-Embed-Token']).toBe('embed-token-1')
    expect((apiFetchMock.mock.calls[1][1] as { headers: Record<string, string> }).headers['X-PLM-Embed-Token']).toBe('embed-token-2')
  })

  it('failure keeps the draft; the RETRY mints a brand-new token, never replays the failed one', async () => {
    apiFetchMock.mockResolvedValueOnce(relayErr(403)).mockResolvedValueOnce(relayOk())
    mount({ parentOrigin: PLM_ORIGIN, target: TARGET })
    await typeAndSubmit('please retry')
    // first attempt failed: draft kept, error status shown
    expect(q<HTMLTextAreaElement>('[data-testid="plm-discussion-composer-input"]').value).toBe('please retry')
    expect(q('[data-testid="plm-discussion-composer-status"]').getAttribute('data-kind')).toBe('error')
    // retry
    q<HTMLFormElement>('[data-testid="plm-discussion-composer"]').dispatchEvent(new Event('submit'))
    for (let i = 0; i < 6; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    await nextTick()
    expect(mintedTokens).toEqual(['embed-token-1', 'embed-token-2']) // a NEW token for the retry
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
  })

  it('lost pinned origin: submit is disabled and no token is requested', async () => {
    apiFetchMock.mockResolvedValue(relayOk())
    mount({ parentOrigin: null, target: TARGET })
    const ta = q<HTMLTextAreaElement>('[data-testid="plm-discussion-composer-input"]')
    expect(ta.disabled).toBe(true)
    q<HTMLFormElement>('[data-testid="plm-discussion-composer"]').dispatchEvent(new Event('submit'))
    for (let i = 0; i < 4; i++) await Promise.resolve()
    expect(postSpy).not.toHaveBeenCalled()
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('unmount disposes the token client (removes the message listener)', async () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    mount({ parentOrigin: PLM_ORIGIN, target: TARGET })
    app?.unmount()
    app = null
    expect(removeSpy).toHaveBeenCalledWith('message', expect.any(Function))
    removeSpy.mockRestore()
  })
})
