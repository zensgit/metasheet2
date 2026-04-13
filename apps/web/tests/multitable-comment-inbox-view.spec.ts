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
  }),
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  getApiBase: () => '',
}))

vi.mock('socket.io-client', () => ({
  io: (...args: unknown[]) => ioMock(...args),
}))

async function flushUi(cycles = 4): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
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

  it('renders inbox items, opens multitable, and marks them as read', async () => {
    app = createApp(MultitableCommentInboxView)
    app.mount(container!)
    await flushUi(6)

    expect(container?.textContent).toContain('Comment Inbox')
    expect(container?.textContent).toContain('Jamie')
    expect(container?.textContent).toContain('Need review')
    expect(container?.textContent).toContain('1')
    expect(container?.textContent).toContain('View view_grid')
    expect(container?.textContent).toContain('Mention')

    const openButton = Array.from(container!.querySelectorAll('button')).find((element) => element.textContent?.includes('Open')) as HTMLButtonElement | undefined
    openButton?.click()
    await flushUi(6)

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

    expect(apiFetchMock).toHaveBeenCalledWith('/api/comments/c1/read', { method: 'POST' })
    expect(ioMock).toHaveBeenCalledTimes(1)
  })
})
