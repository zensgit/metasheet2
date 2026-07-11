import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
import MultitableCommentInboxView from '../src/views/MultitableCommentInboxView.vue'

// UI-P2-1c batch-1: MultitableCommentInboxView's three action controls (header Refresh + per-card
// Open / Mark-read) were migrated from bespoke <button>s to the shared MtButton primitive, all
// variant="primary" — every one was a solid-filled bespoke button (blue gradient / #111827), and
// the fills are normalized to the single --ms-color-primary token (UF-1 convergence). Both bespoke
// classes' full sharer sets were migrated at once, so the bespoke CSS was removed (no
// double-styling). Behavior-preservation proof: they stay native, keyboard-operable <button>s;
// the :disabled expressions survive; clicking still runs the SAME handlers (refreshInbox / onOpen /
// onMarkRead) hitting the SAME endpoints/route payloads.

const apiFetchMock = vi.fn()
const pushSpy = vi.fn().mockResolvedValue(undefined)
const ioMock = vi.fn(() => ({ on: vi.fn(), disconnect: vi.fn() }))

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: pushSpy }),
  }
})

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({ isZh: ref(false) }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getCurrentUserId: vi.fn().mockResolvedValue('user_1'),
    getToken: vi.fn(() => 'test-token'),
  }),
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  getApiBase: () => '',
}))

vi.mock('socket.io-client', () => ({
  io: (...args: unknown[]) => ioMock(...args),
}))

async function flushUi(cycles = 8): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function inboxItem(unread: boolean) {
  return {
    id: 'c1',
    containerId: 'sheet_ops',
    targetId: 'rec_1',
    targetFieldId: 'fld_notes',
    baseId: 'base_ops',
    sheetId: 'sheet_ops',
    viewId: 'view_grid',
    recordId: 'rec_1',
    authorId: 'user_2',
    authorName: 'Jamie',
    content: 'Need review',
    resolved: false,
    mentions: ['user_1'],
    createdAt: '2026-04-04T08:00:00.000Z',
    unread,
    mentioned: true,
  }
}

function inboxResponse(unread: boolean) {
  return new Response(JSON.stringify({
    ok: true,
    data: { items: [inboxItem(unread)], total: 1, limit: 50, offset: 0 },
  }), { status: 200 })
}

function countResponse(count: number) {
  return new Response(JSON.stringify({ ok: true, data: { count } }), { status: 200 })
}

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []

beforeEach(() => {
  apiFetchMock.mockReset()
  pushSpy.mockReset()
  ioMock.mockClear()
})

afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  expect(document.querySelectorAll('.mt-comment-inbox').length).toBe(0) // residue guard
})

function mountView(): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(MultitableCommentInboxView) })
  app.mount(container)
  mounts.push({ app, container })
  return container
}

const refreshBtn = (root: HTMLElement) => root.querySelector('.mt-comment-inbox__refresh') as HTMLButtonElement
const actionBtns = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('.mt-comment-inbox__button')) as HTMLButtonElement[]
const openBtn = (root: HTMLElement) =>
  actionBtns(root).find((b) => b.textContent?.includes('Open')) as HTMLButtonElement
// Positional: the second per-card action (labels cycle Mark read → Saving... → Read).
const markReadBtn = (root: HTMLElement) => actionBtns(root)[1]

describe('MultitableCommentInboxView — MtButton migration (UI-P2-1c batch-1)', () => {
  it('renders refresh / open / mark-read as native <button>s; unread item keeps mark-read enabled', async () => {
    apiFetchMock
      .mockResolvedValueOnce(inboxResponse(true))
      .mockResolvedValueOnce(countResponse(1))
    const root = mountView()
    await flushUi()

    expect(refreshBtn(root).tagName).toBe('BUTTON') // keyboard-operable, not a bare div
    expect(refreshBtn(root).disabled).toBe(false) // :disabled="loading" — load finished
    expect(actionBtns(root).length).toBe(2)
    expect(actionBtns(root).every((b) => b.tagName === 'BUTTON')).toBe(true)
    expect(markReadBtn(root).disabled).toBe(false) // unread → enabled
  })

  it('clicking refresh re-runs refreshInbox (same handler, same endpoint hit again)', async () => {
    apiFetchMock
      .mockResolvedValueOnce(inboxResponse(true))
      .mockResolvedValueOnce(countResponse(1))
      .mockResolvedValueOnce(inboxResponse(true))
      .mockResolvedValueOnce(countResponse(1))
    const root = mountView()
    await flushUi()
    const callsAfterMount = apiFetchMock.mock.calls.length

    refreshBtn(root).click()
    await flushUi()
    expect(apiFetchMock.mock.calls.length).toBeGreaterThan(callsAfterMount)
    expect(String(apiFetchMock.mock.calls[callsAfterMount]?.[0] ?? '')).toContain('/api/comments/inbox')
  })

  it('clicking Open still routes to the comment deep link with the same payload', async () => {
    apiFetchMock
      .mockResolvedValueOnce(inboxResponse(true))
      .mockResolvedValueOnce(countResponse(1))
    const root = mountView()
    await flushUi()

    openBtn(root).click()
    await flushUi()

    expect(pushSpy).toHaveBeenCalledWith({
      name: 'multitable',
      params: { sheetId: 'sheet_ops', viewId: 'view_grid' },
      query: {
        baseId: 'base_ops',
        recordId: 'rec_1',
        commentId: 'c1',
        fieldId: 'fld_notes',
        openComments: 'true',
      },
    })
  })

  it('clicking Mark read still POSTs the read receipt; the read item disables the button (:disabled survives)', async () => {
    apiFetchMock
      .mockResolvedValueOnce(inboxResponse(true))
      .mockResolvedValueOnce(countResponse(1))
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // POST read
      .mockResolvedValueOnce(inboxResponse(false)) // refresh after mark-read
      .mockResolvedValueOnce(countResponse(0))
    const root = mountView()
    await flushUi()

    markReadBtn(root).click()
    await flushUi()

    expect(apiFetchMock).toHaveBeenCalledWith('/api/comments/c1/read', { method: 'POST' })
    await flushUi(12) // let the busy state (Saving...) clear after the post-mark refresh
    expect(markReadBtn(root).textContent).toContain('Read')
    expect(markReadBtn(root).disabled).toBe(true) // !item.unread → disabled expression preserved
  })
})
