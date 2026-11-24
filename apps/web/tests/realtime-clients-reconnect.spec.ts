/**
 * Every realtime client of the web app reconnects after a refusal the server marked as transient,
 * stays closed after a final one, asks for its rooms again after a reconnect, and stops trying when
 * its owner closes it.
 *
 * The transport library is replaced by a socket that records what is registered on it and lets a
 * test fire transport events; the clients themselves are the real ones.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'

type Handler = (...args: any[]) => void

interface FakeSocket {
  url: string
  connected: boolean
  active: boolean
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  emit: ReturnType<typeof vi.fn>
  on(event: string, handler: Handler): FakeSocket
  off(event: string, handler: Handler): FakeSocket
  fire(event: string, ...args: unknown[]): void
}

const sockets: FakeSocket[] = []

function createSocket(url: string): FakeSocket {
  const handlers = new Map<string, Handler[]>()
  const socket: FakeSocket = {
    url,
    connected: false,
    active: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
    emit: vi.fn(),
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      return socket
    },
    off(event, handler) {
      handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== handler))
      return socket
    },
    fire(event, ...args) {
      if (event === 'connect') socket.connected = true
      if (event === 'disconnect') socket.connected = false
      for (const handler of [...(handlers.get(event) ?? [])]) handler(...args)
    },
  }
  sockets.push(socket)
  return socket
}

vi.mock('socket.io-client', () => ({
  io: (url: string) => createSocket(url),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getCurrentUserId: vi.fn().mockResolvedValue('user_self'),
    getToken: vi.fn(() => 'jwt-self'),
  }),
}))

vi.mock('../src/utils/api', () => ({
  getApiBase: () => '',
  apiFetch: vi.fn(),
}))

const TRANSIENT = { code: 'REALTIME_UNAVAILABLE', retry: true }
const FINAL = { code: 'SESSION_NOT_CURRENT', retry: false }
const SERVER_CLOSE = 'io server disconnect'
/** Longer than the longest single backoff step. */
const LONG = 31_000

let app: App<Element> | null = null
let host: HTMLDivElement | null = null

async function flush(cycles = 6): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
  await vi.advanceTimersByTimeAsync(0)
}

async function mount<T>(setup: () => T): Promise<T> {
  let api: T | undefined
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(defineComponent({
    setup() {
      api = setup()
      return () => h('div')
    },
  }))
  app.mount(host)
  await flush()
  return api as T
}

function unmount(): void {
  app?.unmount()
  host?.remove()
  app = null
  host = null
}

beforeEach(() => {
  vi.useFakeTimers()
  sockets.length = 0
})

afterEach(() => {
  unmount()
  vi.useRealTimers()
})

/** The three things every default-channel client must do, whatever it is for. */
async function expectReconnectBehaviour(open: () => Promise<void>, close: () => void): Promise<void> {
  // Transient: reconnects, after a delay.
  await open()
  expect(sockets).toHaveLength(1)
  const socket = sockets[0]
  socket.fire('connect')
  socket.fire('realtime:session-ended', TRANSIENT)
  socket.fire('disconnect', SERVER_CLOSE)
  expect(socket.connect).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(LONG)
  expect(socket.connect).toHaveBeenCalledTimes(1)
  // Final: does not.
  socket.fire('connect')
  socket.fire('realtime:session-ended', FINAL)
  socket.fire('disconnect', SERVER_CLOSE)
  await vi.advanceTimersByTimeAsync(LONG * 4)
  expect(socket.connect).toHaveBeenCalledTimes(1)
  close()
  unmount()

  // Closed by its owner while a reconnect is waiting: nothing reconnects.
  sockets.length = 0
  await open()
  const second = sockets[0]
  second.fire('connect')
  second.fire('disconnect', SERVER_CLOSE)
  close()
  await vi.advanceTimersByTimeAsync(LONG * 4)
  expect(second.connect).not.toHaveBeenCalled()
}

describe('clients whose room the server enters for them at connect', () => {
  it('approval counts', async () => {
    const { useApprovalCountsRealtime } = await import('../src/approvals/useApprovalCountsRealtime')
    let api: ReturnType<typeof useApprovalCountsRealtime> | null = null
    await expectReconnectBehaviour(async () => {
      api = await mount(() => useApprovalCountsRealtime({ onCountsUpdated: vi.fn() }))
      await api.reconnect()
    }, () => api?.disconnect())
  })

  it('todo counts', async () => {
    const { useTodoCountsRealtime } = await import('../src/todo/useTodoCountsRealtime')
    let api: ReturnType<typeof useTodoCountsRealtime> | null = null
    await expectReconnectBehaviour(async () => {
      api = await mount(() => useTodoCountsRealtime({ onCountsUpdated: vi.fn() }))
      await api.reconnect()
    }, () => api?.disconnect())
  })
})

describe('clients that ask for their room on every connect', () => {
  it('comment inbox', async () => {
    const { useMultitableCommentInboxRealtime } = await import('../src/multitable/composables/useMultitableCommentInboxRealtime')
    let api: ReturnType<typeof useMultitableCommentInboxRealtime> | null = null
    await expectReconnectBehaviour(async () => {
      api = await mount(() => useMultitableCommentInboxRealtime({ refreshInbox: vi.fn().mockResolvedValue(undefined) }))
      await flush()
    }, () => api?.disconnect())
  })

  it('comments of a sheet and comments of a record', async () => {
    const { subscribeToMultitableCommentSheetRealtime, subscribeToMultitableCommentsRealtime } = await import('../src/multitable/realtime/comments-realtime')
    let dispose: (() => void) | null = null
    await expectReconnectBehaviour(async () => {
      dispose = subscribeToMultitableCommentSheetRealtime('sheet_1', {})
    }, () => dispose?.())
    sockets.length = 0
    await expectReconnectBehaviour(async () => {
      dispose = subscribeToMultitableCommentsRealtime({ containerId: 'sheet_1', targetIds: ['row_1'] }, {})
    }, () => dispose?.())
  })

  it('comments of a sheet: the room is asked for again after the reconnect', async () => {
    const { subscribeToMultitableCommentSheetRealtime } = await import('../src/multitable/realtime/comments-realtime')
    const dispose = subscribeToMultitableCommentSheetRealtime('sheet_1', {})
    const socket = sockets[0]
    socket.fire('connect')
    socket.fire('disconnect', SERVER_CLOSE)
    await vi.advanceTimersByTimeAsync(LONG)
    socket.fire('connect')
    expect(socket.emit.mock.calls.filter(([event]) => event === 'join-comment-sheet')).toEqual([
      ['join-comment-sheet', { spreadsheetId: 'sheet_1' }],
      ['join-comment-sheet', { spreadsheetId: 'sheet_1' }],
    ])
    dispose()
  })
})

describe('clients that ask for their room once: they ask again after a reconnect', () => {
  const joins = (socket: FakeSocket) => socket.emit.mock.calls.filter(([event]) => event === 'join-sheet')

  async function expectRejoin(open: (sheetId: ReturnType<typeof ref<string>>) => Promise<void>): Promise<void> {
    const sheetId = ref('sheet_a')
    await open(sheetId as never)
    const socket = sockets[0]
    socket.fire('connect')
    expect(joins(socket)).toEqual([['join-sheet', 'sheet_a']])
    // The sheet changes while connected; then the server closes the connection as transient.
    sheetId.value = 'sheet_b'
    await flush()
    expect(joins(socket)).toEqual([['join-sheet', 'sheet_a'], ['join-sheet', 'sheet_b']])
    socket.fire('realtime:session-ended', TRANSIENT)
    socket.fire('disconnect', SERVER_CLOSE)
    await vi.advanceTimersByTimeAsync(LONG)
    expect(socket.connect).toHaveBeenCalledTimes(1)
    socket.fire('connect')
    // The room of the sheet that is open now, once; not the earlier one.
    expect(joins(socket)).toEqual([['join-sheet', 'sheet_a'], ['join-sheet', 'sheet_b'], ['join-sheet', 'sheet_b']])
    // A reconnect the transport library made by itself asks again too.
    socket.fire('disconnect', 'transport close')
    socket.fire('connect')
    expect(joins(socket)).toHaveLength(4)
    unmount()
    await vi.advanceTimersByTimeAsync(LONG * 4)
    expect(socket.connect).toHaveBeenCalledTimes(1)
  }

  it('sheet changes', async () => {
    const { useMultitableSheetRealtime } = await import('../src/multitable/composables/useMultitableSheetRealtime')
    await expectRejoin(async (sheetId) => {
      await mount(() => useMultitableSheetRealtime({
        sheetId,
        selectedRecordId: ref(null),
        visibleRecordIds: ref([]),
        structuralFieldIds: ref([]),
        reloadCurrentSheetPage: vi.fn().mockResolvedValue(undefined),
        reloadSelectedRecordContext: vi.fn().mockResolvedValue(undefined),
        applyRemoteRecordPatch: vi.fn().mockResolvedValue(true),
        mergeRemoteRecord: vi.fn().mockResolvedValue(true),
        removeLocalRecord: vi.fn().mockReturnValue(true),
      } as never))
    })
  })

  it('sheet presence', async () => {
    const { useMultitableSheetPresence } = await import('../src/multitable/composables/useMultitableSheetPresence')
    await expectRejoin(async (sheetId) => {
      await mount(() => useMultitableSheetPresence({ sheetId } as never))
    })
  })

  it('sheet comments', async () => {
    const { useMultitableCommentRealtime } = await import('../src/multitable/composables/useMultitableCommentRealtime')
    await expectRejoin(async (sheetId) => {
      await mount(() => useMultitableCommentRealtime({
        sheetId,
        selectedRecordId: ref(null),
        commentsVisible: ref(false),
        reloadSelectedRecordComments: vi.fn().mockResolvedValue(undefined),
      } as never))
    })
  })

  it('no room is asked for after a reconnect when no sheet is open', async () => {
    const { useMultitableSheetPresence } = await import('../src/multitable/composables/useMultitableSheetPresence')
    const sheetId = ref<string | null>('sheet_a')
    const api = await mount(() => useMultitableSheetPresence({ sheetId } as never))
    const socket = sockets[0]
    socket.fire('connect')
    socket.fire('disconnect', SERVER_CLOSE)
    sheetId.value = null
    await flush()
    await vi.advanceTimersByTimeAsync(LONG * 2)
    // Closing the sheet closed the connection: nothing reconnects and nothing is asked for.
    expect(socket.connect).not.toHaveBeenCalled()
    expect(joins(socket)).toEqual([['join-sheet', 'sheet_a']])
    expect(api).toBeTruthy()
  })
})

describe('every realtime client of the web app has the behaviour', () => {
  const SRC = join(__dirname, '../src')

  function sourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...sourceFiles(full))
      else if (/\.(ts|vue|js|mjs)$/.test(entry.name)) out.push(full)
    }
    return out
  }

  const clients = sourceFiles(SRC)
    .map((file) => ({ file: file.slice(SRC.length + 1), text: readFileSync(file, 'utf8') }))
    .filter(({ text }) => /from ['"]socket\.io-client['"]/.test(text))

  it('the clients are exactly the known ones', () => {
    expect(clients.map(({ file }) => file).sort()).toEqual([
      'approvals/useApprovalCountsRealtime.ts',
      'multitable/composables/useMultitableCommentInboxRealtime.ts',
      'multitable/composables/useMultitableCommentRealtime.ts',
      'multitable/composables/useMultitableSheetPresence.ts',
      'multitable/composables/useMultitableSheetRealtime.ts',
      'multitable/composables/useYjsDocument.ts',
      'multitable/realtime/comments-realtime.ts',
      'tasks/useTasksCountsRealtime.ts',
      'todo/useTodoCountsRealtime.ts',
    ])
  })

  it('each one installs the behaviour once per connection it opens and stops it when it closes the connection', () => {
    for (const { file, text } of clients) {
      const opened = [...text.matchAll(/\b(?:io|socketIO)\(/g)].length
      expect(opened, file).toBeGreaterThan(0)
      if (file.endsWith('useYjsDocument.ts')) {
        // Record editing reopens the record from scratch instead of reopening the same connection.
        expect(text, file).toContain('classifyDisconnect(')
        expect(text, file).toContain('classifyConnectError(')
        expect(text, file).toContain('cancelReopen()')
        continue
      }
      expect([...text.matchAll(/installRealtimeReconnect\(/g)].length, file).toBe(opened)
      expect([...text.matchAll(/reconnectHandle\??\.stop\(\)/g)].length, file).toBe(opened)
    }
  })
})
