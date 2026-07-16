import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import MultitableCommentInboxView from '../src/views/MultitableCommentInboxView.vue'

const apiFetchMock = vi.fn()
const pushSpy = vi.fn().mockResolvedValue(undefined)
const socketOnMock = vi.fn()
const socketDisconnectMock = vi.fn()
const ioMock = vi.fn(() => ({
  on: socketOnMock,
  disconnect: socketDisconnectMock,
}))

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({
      push: pushSpy,
    }),
  }
})

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    isZh: ref(false),
  }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getCurrentUserId: vi.fn().mockResolvedValue('user_1'),
    // #3964 made the comment-inbox realtime join present a caller token server-side; the
    // composable now calls auth.getToken() unconditionally before opening the socket (same gap
    // #4191 fixed in multitable-comment-inbox-realtime.spec.ts's useAuth mock).
    getToken: vi.fn().mockReturnValue('token_inbox_view'),
  }),
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  getApiBase: () => '',
}))

vi.mock('socket.io-client', () => ({
  io: (...args: unknown[]) => ioMock(...args),
}))

// This view's onMounted chain is 2 sequential awaited apiFetch round-trips (listCommentInbox +
// getCommentUnreadCount, each going through a mocked Response.json() parse), and the mark-read
// flow is 2 MORE on top of that (markCommentRead + a second refreshInbox). How many microtask
// ticks that whole chain needs to fully settle is NOT a portable constant — it empirically differs
// by Node/undici version: a fixed `flushUi(6)`/`flushUi(10)` cycle count (this spec's original
// helper, tuned against whatever Node happened to be on hand locally) settles well inside 10 ticks
// on newer Node but was verified NOT to settle within 10 ticks on Node 20.x (CI's pinned
// `node-version: 20.x`, the version apps/web/scripts/run-required-web-tests.sh actually runs under)
// — a deterministic 5/5 failure in ISOLATION under Node 20.20.2, not just in a shared batch. (This
// is why the spec was pulled from the required gate in #4217/65e0a8c25 as a suspected "batch
// co-execution" flake — batching wasn't actually the variable; the verifier's local Node version
// was.) flushUntil polls the real DOM condition instead of guessing a tick count, so it converges
// correctly regardless of how many ticks the runtime underneath needs, and still fails loudly (via
// the unchanged `expect` right after it) if the state genuinely never settles.
async function flushUntil(predicate: () => boolean, maxCycles = 500): Promise<void> {
  for (let index = 0; index < maxCycles; index += 1) {
    if (predicate()) return
    await Promise.resolve()
    await nextTick()
  }
}

describe('MultitableCommentInboxView', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    apiFetchMock.mockReset()
    pushSpy.mockReset()
    socketOnMock.mockReset()
    socketDisconnectMock.mockReset()
    ioMock.mockClear()
    apiFetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        data: {
          items: [{
            id: 'c1',
            containerId: 'sheet_ops',
            targetId: 'rec_1',
            targetFieldId: 'fld_notes',
            baseId: 'base_ops',
            sheetId: 'sheet_ops',
            viewId: 'view_grid',
            recordId: 'rec_1',
            // G-10 (docket #68): server-projected display names alongside the ids above.
            baseName: 'Ops Base',
            sheetName: 'Ops Sheet',
            viewName: 'Grid View',
            fieldName: 'Notes',
            authorId: 'user_2',
            authorName: 'Jamie',
            content: 'Need review',
            resolved: false,
            mentions: ['user_1'],
            createdAt: '2026-04-04T08:00:00.000Z',
            unread: true,
            mentioned: true,
          }],
          total: 1,
          limit: 50,
          offset: 0,
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        data: { count: 1 },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        data: {
          items: [{
            id: 'c1',
            containerId: 'sheet_ops',
            targetId: 'rec_1',
            targetFieldId: 'fld_notes',
            baseId: 'base_ops',
            sheetId: 'sheet_ops',
            viewId: 'view_grid',
            recordId: 'rec_1',
            baseName: 'Ops Base',
            sheetName: 'Ops Sheet',
            viewName: 'Grid View',
            fieldName: 'Notes',
            authorId: 'user_2',
            authorName: 'Jamie',
            content: 'Need review',
            resolved: false,
            mentions: ['user_1'],
            createdAt: '2026-04-04T08:00:00.000Z',
            unread: false,
            mentioned: true,
          }],
          total: 1,
          limit: 50,
          offset: 0,
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        data: { count: 0 },
      }), { status: 200 }))

    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  it('renders inbox items, opens multitable, and clears unread state locally', async () => {
    app = createApp(MultitableCommentInboxView)
    app.mount(container!)
    await flushUntil(() => container?.textContent?.includes('Jamie') === true)

    expect(container?.textContent).toContain('Comment Inbox')
    expect(container?.textContent).toContain('Jamie')
    expect(container?.textContent).toContain('Need review')
    expect(container?.textContent).toContain('1')
    expect(container?.textContent).toContain('Mention')

    // G-10 (docket #68): cards render entity display names, name-first (id ?? name fallback pattern
    // mirrored from the existing authorName ?? authorId). The raw ids are demoted to a `title`
    // tooltip attribute rather than removed outright.
    expect(container?.textContent).toContain('Base Ops Base')
    expect(container?.textContent).toContain('Sheet Ops Sheet')
    expect(container?.textContent).toContain('View Grid View')
    expect(container?.textContent).toContain('Field Notes')
    // the raw ids no longer appear as VISIBLE text for the named entities...
    expect(container?.textContent).not.toContain('Sheet sheet_ops')
    expect(container?.textContent).not.toContain('View view_grid')
    expect(container?.textContent).not.toContain('Field fld_notes')
    // ...but are still present, demoted to a hover tooltip (secondary, not removed).
    expect(container?.querySelector('[title="base_ops"]')?.textContent).toContain('Ops Base')
    expect(container?.querySelector('[title="sheet_ops"]')?.textContent).toContain('Ops Sheet')
    expect(container?.querySelector('[title="view_grid"]')?.textContent).toContain('Grid View')
    expect(container?.querySelector('[title="fld_notes"]')?.textContent).toContain('Notes')
    // Row/record has NO name projection (documented server-side disposition) — raw id stays visible.
    expect(container?.textContent).toContain('Row rec_1')

    const openButton = Array.from(container!.querySelectorAll('button')).find((element) => element.textContent?.includes('Open')) as HTMLButtonElement | undefined
    openButton?.click()
    await flushUntil(() => (
      container?.querySelector('.mt-comment-inbox__badge--unread') == null
      && container?.querySelector('.mt-comment-inbox__stat strong')?.textContent === '0'
    ))

    expect(pushSpy).toHaveBeenCalledWith({
      name: 'multitable',
      params: {
        sheetId: 'sheet_ops',
        viewId: 'view_grid',
      },
      query: {
        baseId: 'base_ops',
        recordId: 'rec_1',
        commentId: 'c1',
        fieldId: 'fld_notes',
        openComments: 'true',
      },
    })

    expect(container!.querySelector('.mt-comment-inbox__badge--unread')).toBeNull()
    expect(container!.querySelector('.mt-comment-inbox__stat strong')?.textContent).toBe('0')
    expect(apiFetchMock).not.toHaveBeenCalledWith('/api/comments/c1/read', { method: 'POST' })
    expect(ioMock).toHaveBeenCalledTimes(1)
  })

  it('marks an inbox item as read from the explicit action button', async () => {
    app = createApp(MultitableCommentInboxView)
    app.mount(container!)
    await flushUntil(() => container?.textContent?.includes('Jamie') === true)

    const markReadButton = Array.from(container!.querySelectorAll('button'))
      .find((element) => element.textContent?.includes('Mark read')) as HTMLButtonElement | undefined
    markReadButton?.click()
    await flushUntil(() => (
      container?.querySelector('.mt-comment-inbox__badge--unread') == null
      && container?.querySelector('.mt-comment-inbox__stat strong')?.textContent === '0'
    ))

    expect(apiFetchMock).toHaveBeenCalledWith('/api/comments/c1/read', { method: 'POST' })
    expect(container!.querySelector('.mt-comment-inbox__badge--unread')).toBeNull()
    expect(container!.querySelector('.mt-comment-inbox__stat strong')?.textContent).toBe('0')
    expect(ioMock).toHaveBeenCalledTimes(1)
  })
})
