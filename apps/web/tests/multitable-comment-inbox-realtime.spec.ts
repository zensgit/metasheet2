import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { useMultitableCommentInboxRealtime } from '../src/multitable/composables/useMultitableCommentInboxRealtime'

const handlers = new Map<string, (...args: any[]) => void>()
const disconnectMock = vi.fn()
const ioMock = vi.fn(() => ({
  on: (event: string, handler: (...args: any[]) => void) => {
    handlers.set(event, handler)
  },
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

  it('refreshes inbox when a mention event arrives', async () => {
    const refreshInbox = vi.fn().mockResolvedValue(undefined)

    app = createApp(defineComponent({
      setup() {
        useMultitableCommentInboxRealtime({ refreshInbox })
        return () => h('div')
      },
    }))
    app.mount(container!)
    await flushUi(6)

    expect(ioMock).toHaveBeenCalledTimes(1)

    handlers.get('comment:mention')?.({
      comment: {
        id: 'c1',
      },
    })
    await flushUi(2)

    expect(refreshInbox).toHaveBeenCalledTimes(1)
  })

  it('coalesces mention bursts while a refresh is in flight', async () => {
    let resolveRefresh: (() => void) | null = null
    const refreshInbox = vi.fn(() => new Promise<void>((resolve) => {
      resolveRefresh = resolve
    }))

    app = createApp(defineComponent({
      setup() {
        useMultitableCommentInboxRealtime({ refreshInbox })
        return () => h('div')
      },
    }))
    app.mount(container!)
    await flushUi(6)

    handlers.get('comment:mention')?.({})
    await flushUi(2)
    handlers.get('comment:mention')?.({})
    handlers.get('comment:mention')?.({})
    await flushUi(2)

    expect(refreshInbox).toHaveBeenCalledTimes(1)

    resolveRefresh?.()
    await flushUi(4)

    expect(refreshInbox).toHaveBeenCalledTimes(2)
  })
})
