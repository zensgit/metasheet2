/**
 * The discussion panel integration test. Drives create + reply + resolve + reopen + the REAL
 * relay list/detail through the two REAL child token clients (write + read), with the parent
 * (postMessage mint) and the relay (apiFetch, method+route-aware) mocked. Pins: each action mints
 * its OWN fresh token; one token = one relay call; rendered state comes from the SERVER response
 * (status/comments), never a local optimistic mutation; submit disabled on lost origin; both
 * clients disposed on unmount.
 *
 * Sub-slice 5 additions: the panel now fetches the REAL list on mount (`GET .../threads`, one
 * extra token+call ahead of any user action -- accounted for in every test's index math below),
 * and gates reply on a per-thread `detailLoaded` flag driven by an explicit "加载详情" control
 * (`GET .../threads/:id`). The relay's `relayFor` mock below is method-aware (GET vs POST) since
 * LIST (GET) and CREATE (POST) share the exact same path.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import PlmEmbedDiscussionPanel from '../src/components/plm/PlmEmbedDiscussionPanel.vue'

const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))

const PLM_ORIGIN = 'https://plm.example.com'
const TARGET = { target_type: 'item' as const, target_id: 'PART-1' }

interface MockInit { method?: string; body?: string; headers?: Record<string, string> }
interface MockResponse { ok: boolean; status: number; json: () => Promise<unknown> }

// Default route-aware relay, method-aware since LIST (GET) and CREATE (POST) share one path:
//   GET  /threads             -> LIST, defaults to an EMPTY list (tests override for list content)
//   GET  /threads/:id         -> DETAIL, defaults to a thread with one root comment 'c1'
//   POST /threads             -> CREATE, always returns thread 't1'
//   POST /threads/:id/comments -> REPLY, echoes the ACTUAL :id, appends comment 'c2'
//   POST /threads/:id/resolve  -> echoes the ACTUAL :id, status 'resolved'
//   POST /threads/:id/reopen   -> echoes the ACTUAL :id, status 'open'
function relayFor(path: string, init?: MockInit): MockResponse {
  const method = (init?.method || 'GET').toUpperCase()
  const parts = path.split('/')
  if (method === 'GET') {
    if (path === '/api/plm-embed/discussion/threads') {
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { threads: [], next_cursor: null } }) }
    }
    const id = parts[parts.length - 1]
    return { ok: true, status: 200, json: async () => ({ ok: true, data: { id, status: 'open', comments: [{ id: 'c1', body: 'hi' }] } }) }
  }
  let threadId = 't1'
  let status = 'open'
  const comments = [{ id: 'c1', body: 'hi' }]
  if (path.endsWith('/resolve')) { threadId = parts[parts.length - 2]; status = 'resolved' }
  else if (path.endsWith('/reopen')) { threadId = parts[parts.length - 2]; status = 'open' }
  else if (path.endsWith('/comments')) { threadId = parts[parts.length - 2]; comments.push({ id: 'c2', body: 'reply' }) }
  return { ok: true, status: 200, json: async () => ({ ok: true, data: { id: threadId, status, comments } }) }
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

describe('PlmEmbedDiscussionPanel — list/detail + create + reply + resolve + reopen', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
    apiFetchMock.mockImplementation(async (path: string, init?: MockInit) => relayFor(path, init))
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

  it('all four write actions each mint their OWN fresh token; state comes from the server response', async () => {
    mount({ parentOrigin: PLM_ORIGIN, target: TARGET })
    await settle() // let the initial mount-time LIST load (empty) settle first

    // create
    const ci = q<HTMLTextAreaElement>('[data-testid="plm-discussion-create-input"]')
    ci.value = 'new thread'; ci.dispatchEvent(new Event('input')); await nextTick()
    q<HTMLFormElement>('[data-testid="plm-discussion-create"]').dispatchEvent(new Event('submit'))
    await settle()
    expect(q('[data-testid="plm-discussion-thread-status-t1"]').textContent).toBe('open')

    // reply -- a just-created thread's write response IS a full detail (comments populated), so
    // it is already detail-loaded and reply is enabled with no separate "加载详情" step.
    const ri = q<HTMLInputElement>('[data-testid="plm-discussion-reply-input-t1"]')
    expect(ri.disabled).toBe(false)
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

    // 1 initial LIST + 4 write calls, 5 total; the 4 WRITE actions mint 4 DISTINCT tokens
    expect(apiFetchMock).toHaveBeenCalledTimes(5)
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/plm-embed/discussion/threads')
    expect((apiFetchMock.mock.calls[0][1] as MockInit).method).toBe('GET')
    const tokens = [tokenOf(1), tokenOf(2), tokenOf(3), tokenOf(4)]
    expect(new Set(tokens).size).toBe(4)
    expect(tokens).toEqual(['tok-2', 'tok-3', 'tok-4', 'tok-5'])
    expect(apiFetchMock.mock.calls[1][0]).toBe('/api/plm-embed/discussion/threads')
    expect((apiFetchMock.mock.calls[1][1] as MockInit).method).toBe('POST')
    expect(apiFetchMock.mock.calls[2][0]).toBe('/api/plm-embed/discussion/threads/t1/comments')
    // a REPLY is a one-level reply: it carries parent_comment_id = the thread's root comment (c1),
    // not a bare top-level comment.
    expect(JSON.parse((apiFetchMock.mock.calls[2][1] as { body: string }).body)).toMatchObject({ body: 'a reply', parent_comment_id: 'c1' })
    expect(apiFetchMock.mock.calls[3][0]).toBe('/api/plm-embed/discussion/threads/t1/resolve')
    expect(apiFetchMock.mock.calls[4][0]).toBe('/api/plm-embed/discussion/threads/t1/reopen')
  })

  it('a failed action keeps state and mints a NEW token on retry (no cache/replay)', async () => {
    mount({ parentOrigin: PLM_ORIGIN, target: TARGET })
    await settle() // initial LIST load succeeds (empty) -> mintedTokens === ['tok-1']

    apiFetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ ok: false, error: { code: 'X' } }) })
    const ci = q<HTMLTextAreaElement>('[data-testid="plm-discussion-create-input"]')
    ci.value = 'try'; ci.dispatchEvent(new Event('input')); await nextTick()
    q<HTMLFormElement>('[data-testid="plm-discussion-create"]').dispatchEvent(new Event('submit'))
    await settle()
    expect(q('[data-testid="plm-discussion-error"]')).toBeTruthy()
    expect(ci.value).toBe('try') // draft kept
    // retry
    q<HTMLFormElement>('[data-testid="plm-discussion-create"]').dispatchEvent(new Event('submit'))
    await settle()
    expect(mintedTokens).toEqual(['tok-1', 'tok-2', 'tok-3']) // list, failed create, retried create -- all distinct
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

  it('unmount disposes BOTH token clients (removes BOTH message listeners)', async () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    mount({ parentOrigin: PLM_ORIGIN, target: TARGET })
    app?.unmount(); app = null
    expect(removeSpy).toHaveBeenCalledWith('message', expect.any(Function))
    // Each of the two clients (write + read) adds exactly ONE 'message' listener and the panel
    // adds no others -- assert the COUNT, not just "at least one", so a missing
    // disposeReadClient() call would fail this test rather than hide behind the write client's
    // listener removal.
    expect(removeSpy.mock.calls.filter((c) => c[0] === 'message').length).toBe(2)
    removeSpy.mockRestore()
  })

  it('on mount, the panel fetches the REAL thread list via a fresh read token; listed threads render', async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: MockInit) => {
      if ((init?.method || 'GET').toUpperCase() === 'GET' && path === '/api/plm-embed/discussion/threads') {
        return { ok: true, status: 200, json: async () => ({ ok: true, data: { threads: [{ id: 'ta', status: 'open' }, { id: 'tb', status: 'resolved' }], next_cursor: null } }) }
      }
      return relayFor(path, init)
    })
    mount({ parentOrigin: PLM_ORIGIN, target: TARGET })
    await settle()

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/plm-embed/discussion/threads')
    expect((apiFetchMock.mock.calls[0][1] as MockInit).method).toBe('GET')
    expect(tokenOf(0)).toBe('tok-1')
    expect(q('[data-testid="plm-discussion-thread-status-ta"]').textContent).toBe('open')
    expect(q('[data-testid="plm-discussion-thread-status-tb"]').textContent).toBe('resolved')
  })

  it('a historical resolved thread from the list renders a reopen control, and reopen calls the write relay for it', async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: MockInit) => {
      if ((init?.method || 'GET').toUpperCase() === 'GET' && path === '/api/plm-embed/discussion/threads') {
        return { ok: true, status: 200, json: async () => ({ ok: true, data: { threads: [{ id: 'tr', status: 'resolved' }], next_cursor: null } }) }
      }
      return relayFor(path, init)
    })
    mount({ parentOrigin: PLM_ORIGIN, target: TARGET })
    await settle()

    expect(q('[data-testid="plm-discussion-thread-status-tr"]').textContent).toBe('resolved')
    expect(host.querySelector('[data-testid="plm-discussion-resolve-tr"]')).toBeFalsy()
    const reopenBtn = q<HTMLButtonElement>('[data-testid="plm-discussion-reopen-tr"]')
    expect(reopenBtn).toBeTruthy()

    reopenBtn.click()
    await settle()

    expect(apiFetchMock.mock.calls[1][0]).toBe('/api/plm-embed/discussion/threads/tr/reopen')
    expect((apiFetchMock.mock.calls[1][1] as MockInit).method).toBe('POST')
    expect(q('[data-testid="plm-discussion-thread-status-tr"]').textContent).toBe('open')
  })

  it('reply stays DISABLED for a listed thread whose detail has not been loaded', async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: MockInit) => {
      if ((init?.method || 'GET').toUpperCase() === 'GET' && path === '/api/plm-embed/discussion/threads') {
        return { ok: true, status: 200, json: async () => ({ ok: true, data: { threads: [{ id: 'tx', status: 'open' }], next_cursor: null } }) }
      }
      return relayFor(path, init)
    })
    mount({ parentOrigin: PLM_ORIGIN, target: TARGET })
    await settle()

    const replyInput = q<HTMLInputElement>('[data-testid="plm-discussion-reply-input-tx"]')
    const replySubmit = q<HTMLButtonElement>('[data-testid="plm-discussion-reply-submit-tx"]')
    expect(replyInput.disabled).toBe(true)
    expect(replySubmit.disabled).toBe(true)

    // forcing the disabled control's value + submitting must still not reach the relay -- AND,
    // per the sharpened owner acceptance criterion, must not even MINT a write token: the guard
    // in reply() runs BEFORE any call to requestWriteToken(), so a rejected reply burns nothing.
    const postCallsBefore = postSpy.mock.calls.length
    replyInput.value = 'sneaky'; replyInput.dispatchEvent(new Event('input')); await nextTick()
    q('[data-thread-id="tx"] form').dispatchEvent(new Event('submit'))
    await settle()
    expect(apiFetchMock.mock.calls.some((c) => String(c[0]).endsWith('/comments'))).toBe(false)
    expect(postSpy.mock.calls.length).toBe(postCallsBefore) // no new postMessage at all (no token of any purpose requested)
    expect(postSpy.mock.calls.some((c) => (c[0] as { purpose?: string })?.purpose === 'discussion-write')).toBe(false)
  })

  it('after loadDetail, reply becomes ENABLED and sends parent_comment_id = the thread root id', async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: MockInit) => {
      const method = (init?.method || 'GET').toUpperCase()
      if (method === 'GET' && path === '/api/plm-embed/discussion/threads') {
        return { ok: true, status: 200, json: async () => ({ ok: true, data: { threads: [{ id: 'ty', status: 'open' }], next_cursor: null } }) }
      }
      if (method === 'GET' && path === '/api/plm-embed/discussion/threads/ty') {
        return { ok: true, status: 200, json: async () => ({ ok: true, data: { id: 'ty', status: 'open', comments: [{ id: 'root-1', body: 'root' }] } }) }
      }
      return relayFor(path, init)
    })
    mount({ parentOrigin: PLM_ORIGIN, target: TARGET })
    await settle()
    expect(q<HTMLInputElement>('[data-testid="plm-discussion-reply-input-ty"]').disabled).toBe(true)

    q<HTMLButtonElement>('[data-testid="plm-discussion-load-detail-ty"]').click()
    await settle()
    expect(q<HTMLInputElement>('[data-testid="plm-discussion-reply-input-ty"]').disabled).toBe(false)
    // the control disappears once detail is loaded
    expect(host.querySelector('[data-testid="plm-discussion-load-detail-ty"]')).toBeFalsy()

    const ri = q<HTMLInputElement>('[data-testid="plm-discussion-reply-input-ty"]')
    ri.value = 'a reply'; ri.dispatchEvent(new Event('input')); await nextTick()
    q('[data-thread-id="ty"] form').dispatchEvent(new Event('submit'))
    await settle()

    const commentsCall = apiFetchMock.mock.calls.find((c) => String(c[0]) === '/api/plm-embed/discussion/threads/ty/comments')
    expect(commentsCall).toBeTruthy()
    expect(JSON.parse((commentsCall![1] as { body: string }).body)).toMatchObject({ body: 'a reply', parent_comment_id: 'root-1' })
  })

  it('FAIL-CLOSED: a loaded detail with NO comments keeps reply disabled and addComment is NEVER called for it', async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: MockInit) => {
      const method = (init?.method || 'GET').toUpperCase()
      if (method === 'GET' && path === '/api/plm-embed/discussion/threads') {
        return { ok: true, status: 200, json: async () => ({ ok: true, data: { threads: [{ id: 'tz', status: 'open' }], next_cursor: null } }) }
      }
      if (method === 'GET' && path === '/api/plm-embed/discussion/threads/tz') {
        return { ok: true, status: 200, json: async () => ({ ok: true, data: { id: 'tz', status: 'open', comments: [] } }) }
      }
      return relayFor(path, init)
    })
    mount({ parentOrigin: PLM_ORIGIN, target: TARGET })
    await settle()

    q<HTMLButtonElement>('[data-testid="plm-discussion-load-detail-tz"]').click()
    await settle()

    // detail loaded but rootless -> reply stays disabled forever for this thread
    expect(q<HTMLInputElement>('[data-testid="plm-discussion-reply-input-tz"]').disabled).toBe(true)
    expect(q<HTMLButtonElement>('[data-testid="plm-discussion-reply-submit-tz"]').disabled).toBe(true)

    // defense in depth: force the control + submit anyway, the handler itself must refuse -- AND,
    // per the sharpened owner acceptance criterion, must not even MINT a write token: the guard
    // in reply() runs BEFORE any call to requestWriteToken(), so a rejected reply burns nothing.
    const postCallsBefore = postSpy.mock.calls.length
    const apiCallsBefore = apiFetchMock.mock.calls.length
    const ri = q<HTMLInputElement>('[data-testid="plm-discussion-reply-input-tz"]')
    ri.value = 'sneaky'; ri.dispatchEvent(new Event('input')); await nextTick()
    q('[data-thread-id="tz"] form').dispatchEvent(new Event('submit'))
    await settle()

    expect(apiFetchMock.mock.calls.some((c) => String(c[0]).endsWith('/comments'))).toBe(false)
    expect(apiFetchMock.mock.calls.length).toBe(apiCallsBefore) // zero write-relay calls from the reply attempt
    expect(postSpy.mock.calls.length).toBe(postCallsBefore) // zero token requests of ANY purpose from the reply attempt
    expect(postSpy.mock.calls.some((c) => (c[0] as { purpose?: string })?.purpose === 'discussion-write')).toBe(false)
  })

  it('FAIL-CLOSED: a loaded detail whose root comment has NO id keeps reply disabled and mints nothing (adversarial-verify P3: String(c.id) coercion hardened)', async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: MockInit) => {
      const method = (init?.method || 'GET').toUpperCase()
      if (method === 'GET' && path === '/api/plm-embed/discussion/threads') {
        return { ok: true, status: 200, json: async () => ({ ok: true, data: { threads: [{ id: 'tn', status: 'open' }], next_cursor: null } }) }
      }
      if (method === 'GET' && path === '/api/plm-embed/discussion/threads/tn') {
        // A root comment with NO id. String(c.id) would coerce this to the TRUTHY string "undefined"
        // and (before the fix) unlock reply, minting a write token for a nonexistent parent. The fix
        // maps a non-string id to null, so replyEnabled() stays false and nothing is minted/sent.
        return { ok: true, status: 200, json: async () => ({ ok: true, data: { id: 'tn', status: 'open', comments: [{ body: 'no id here' }] } }) }
      }
      return relayFor(path, init)
    })
    mount({ parentOrigin: PLM_ORIGIN, target: TARGET })
    await settle()

    q<HTMLButtonElement>('[data-testid="plm-discussion-load-detail-tn"]').click()
    await settle()

    expect(q<HTMLInputElement>('[data-testid="plm-discussion-reply-input-tn"]').disabled).toBe(true)
    const postCallsBefore = postSpy.mock.calls.length
    const apiCallsBefore = apiFetchMock.mock.calls.length
    const ri = q<HTMLInputElement>('[data-testid="plm-discussion-reply-input-tn"]')
    ri.value = 'sneaky'; ri.dispatchEvent(new Event('input')); await nextTick()
    q('[data-thread-id="tn"] form').dispatchEvent(new Event('submit'))
    await settle()

    expect(apiFetchMock.mock.calls.some((c) => String(c[0]).endsWith('/comments'))).toBe(false)
    expect(apiFetchMock.mock.calls.length).toBe(apiCallsBefore) // zero write-relay calls
    expect(postSpy.mock.calls.length).toBe(postCallsBefore) // zero token mints
  })
})
