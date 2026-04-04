import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { useMultitableCommentInboxRealtime } from '../src/multitable/composables/useMultitableCommentInboxRealtime'

const handlers = new Map<string, (...args: any[]) => void>()
const emitMock = vi.fn()
const disconnectMock = vi.fn()
const ioMock = vi.fn(() => ({
  on: (event: string, handler: (...args: any[]) => void) => {
    handlers.set(event, handler)
  },
  emit: emitMock,
  connected: true,
  disconnect: disconnectMock,
}))

vi.mock('socket.io-client', () => ({
  io: (...args: unknown[]) => ioMock(...args),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getCurrentUserId: vi.fn().mockResolvedValue('user_inbox'),
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

describe('useMultitableCommentInboxRealtime', () => {
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

  it('refreshes inbox for mention and sheet activity events', async () => {
    const refreshInbox = vi.fn().mockResolvedValue(undefined)
    const sheetIds = ref(['sheet_ops'])

    app = createApp(defineComponent({
      setup() {
        useMultitableCommentInboxRealtime({
          refreshInbox,
          sheetIds: () => sheetIds.value,
        })
        return () => h('div')
      },
    }))
    app.mount(container!)
    await flushUi(6)

    expect(ioMock).toHaveBeenCalledTimes(1)
    expect(emitMock).toHaveBeenCalledWith('join-comment-sheet', { spreadsheetId: 'sheet_ops' })

    handlers.get('comment:mention')?.({
      comment: {
        id: 'c1',
      },
    })
    await flushUi(2)

    expect(refreshInbox).toHaveBeenCalledTimes(1)

    handlers.get('comment:created')?.({
      comment: {
        id: 'c2',
        spreadsheetId: 'sheet_ops',
        authorId: 'user_other',
      },
    })
    await flushUi(2)
    expect(refreshInbox).toHaveBeenCalledTimes(2)

    handlers.get('comment:resolved')?.({
      spreadsheetId: 'sheet_ops',
      commentId: 'c2',
    })
    await flushUi(2)
    expect(refreshInbox).toHaveBeenCalledTimes(3)
  })

  it('ignores sheet create events authored by the current user', async () => {
    const refreshInbox = vi.fn().mockResolvedValue(undefined)

    app = createApp(defineComponent({
      setup() {
        useMultitableCommentInboxRealtime({
          refreshInbox,
          sheetIds: () => ['sheet_ops'],
        })
        return () => h('div')
      },
    }))
    app.mount(container!)
    await flushUi(6)

    handlers.get('comment:created')?.({
      comment: {
        id: 'c_self',
        spreadsheetId: 'sheet_ops',
        authorId: 'user_inbox',
      },
    })
    await flushUi(2)

    expect(refreshInbox).not.toHaveBeenCalled()
  })

  it('coalesces sheet activity bursts while a refresh is in flight', async () => {
    let resolveRefresh: (() => void) | null = null
    const refreshInbox = vi.fn(() => new Promise<void>((resolve) => {
      resolveRefresh = resolve
    }))

    app = createApp(defineComponent({
      setup() {
        useMultitableCommentInboxRealtime({
          refreshInbox,
          sheetIds: () => ['sheet_ops'],
        })
        return () => h('div')
      },
    }))
    app.mount(container!)
    await flushUi(6)

    handlers.get('comment:created')?.({})
    await flushUi(2)
    handlers.get('comment:created')?.({})
    handlers.get('comment:resolved')?.({})
    await flushUi(2)

    expect(refreshInbox).toHaveBeenCalledTimes(1)

    resolveRefresh?.()
    await flushUi(4)

    expect(refreshInbox).toHaveBeenCalledTimes(2)
  })

  it('joins and leaves sheet rooms when the loaded inbox sheets change', async () => {
    const refreshInbox = vi.fn().mockResolvedValue(undefined)
    const sheetIds = ref(['sheet_ops', 'sheet_finance', 'sheet_ops'])

    app = createApp(defineComponent({
      setup() {
        useMultitableCommentInboxRealtime({
          refreshInbox,
          sheetIds: () => sheetIds.value,
        })
        return () => h('div')
      },
    }))
    app.mount(container!)
    await flushUi(6)

    expect(emitMock).toHaveBeenCalledWith('join-comment-sheet', { spreadsheetId: 'sheet_finance' })
    expect(emitMock).toHaveBeenCalledWith('join-comment-sheet', { spreadsheetId: 'sheet_ops' })

    sheetIds.value = ['sheet_finance', 'sheet_support']
    await flushUi(4)

    expect(emitMock).toHaveBeenCalledWith('leave-comment-sheet', { spreadsheetId: 'sheet_ops' })
    expect(emitMock).toHaveBeenCalledWith('join-comment-sheet', { spreadsheetId: 'sheet_support' })
  })
})
