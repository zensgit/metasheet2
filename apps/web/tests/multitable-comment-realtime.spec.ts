import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { useMultitableCommentRealtime } from '../src/multitable/composables/useMultitableCommentRealtime'

const handlers = new Map<string, (...args: any[]) => void>()
const emitMock = vi.fn()
const disconnectMock = vi.fn()
const ioMock = vi.fn(() => ({
  on: (event: string, handler: (...args: any[]) => void) => {
    handlers.set(event, handler)
  },
  emit: emitMock,
  disconnect: disconnectMock,
}))

vi.mock('socket.io-client', () => ({
  io: (...args: unknown[]) => ioMock(...args),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getCurrentUserId: vi.fn().mockResolvedValue('user_self'),
  }),
}))

vi.mock('../src/utils/api', () => ({
  getApiBase: () => '',
}))

async function flushUi(cycles = 4): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('useMultitableCommentRealtime', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    handlers.clear()
    emitMock.mockReset()
    disconnectMock.mockReset()
    ioMock.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  it('joins sheet rooms and refreshes record comments/unread state on realtime events', async () => {
    const reloadSelectedRecordComments = vi.fn().mockResolvedValue(undefined)
    const refreshUnreadCount = vi.fn().mockResolvedValue(undefined)
    const sheetId = ref('sheet_ops')
    const selectedRecordId = ref('rec_1')
    const commentsVisible = ref(true)

    app = createApp(defineComponent({
      setup() {
        useMultitableCommentRealtime({
          sheetId,
          selectedRecordId,
          commentsVisible,
          reloadSelectedRecordComments,
          refreshUnreadCount,
        })
        return () => h('div')
      },
    }))
    app.mount(container!)
    await flushUi(6)

    expect(ioMock).toHaveBeenCalledTimes(1)
    expect(emitMock).toHaveBeenCalledWith('join-sheet', 'sheet_ops')

    handlers.get('comment:created')?.({
      comment: {
        id: 'c1',
        spreadsheetId: 'sheet_ops',
        rowId: 'rec_1',
        authorId: 'user_other',
        content: 'hello',
        resolved: false,
        createdAt: '2026-04-04T00:00:00.000Z',
      },
    })
    await flushUi(2)
    expect(reloadSelectedRecordComments).toHaveBeenCalledTimes(1)

    handlers.get('comment:mention')?.({
      comment: {
        id: 'c2',
        spreadsheetId: 'sheet_ops',
        rowId: 'rec_1',
        authorId: 'user_other',
        content: 'ping',
        resolved: false,
        createdAt: '2026-04-04T00:01:00.000Z',
      },
    })
    await flushUi(2)
    expect(reloadSelectedRecordComments).toHaveBeenCalledTimes(2)
    expect(refreshUnreadCount).toHaveBeenCalledTimes(2)

    handlers.get('comment:resolved')?.({ commentId: 'c2', rowId: 'rec_1', authorId: 'user_other' })
    await flushUi(2)
    expect(reloadSelectedRecordComments).toHaveBeenCalledTimes(3)

    handlers.get('comment:updated')?.({
      comment: {
        id: 'c3',
        spreadsheetId: 'sheet_ops',
        rowId: 'rec_1',
        authorId: 'user_other',
        content: 'edited',
        resolved: false,
        createdAt: '2026-04-04T00:02:00.000Z',
      },
    })
    await flushUi(2)
    expect(reloadSelectedRecordComments).toHaveBeenCalledTimes(4)
    expect(refreshUnreadCount).toHaveBeenCalledTimes(4)

    handlers.get('comment:deleted')?.({
      commentId: 'c3',
      rowId: 'rec_1',
      authorId: 'user_other',
    })
    await flushUi(2)
    expect(reloadSelectedRecordComments).toHaveBeenCalledTimes(5)
    expect(refreshUnreadCount).toHaveBeenCalledTimes(5)

    sheetId.value = 'sheet_finance'
    await flushUi(4)
    expect(emitMock).toHaveBeenCalledWith('leave-sheet', 'sheet_ops')
    expect(emitMock).toHaveBeenCalledWith('join-sheet', 'sheet_finance')
  })
})
