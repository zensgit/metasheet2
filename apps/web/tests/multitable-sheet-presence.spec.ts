import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { useMultitableSheetPresence } from '../src/multitable/composables/useMultitableSheetPresence'

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

describe('useMultitableSheetPresence', () => {
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

  it('tracks active collaborators for the current sheet and excludes the current user', async () => {
    const sheetId = ref('sheet_ops')
    let activeCollaboratorCount: { value: number } = ref(0)

    app = createApp(defineComponent({
      setup() {
        const state = useMultitableSheetPresence({ sheetId })
        activeCollaboratorCount = state.activeCollaboratorCount
        return () => h('div')
      },
    }))
    app.mount(container!)
    await flushUi(6)

    expect(ioMock).toHaveBeenCalledTimes(1)
    expect(emitMock).toHaveBeenCalledWith('join-sheet', 'sheet_ops')
    expect(activeCollaboratorCount.value).toBe(0)

    handlers.get('sheet:presence')?.({
      sheetId: 'sheet_ops',
      activeCount: 2,
      users: [{ id: 'user_self' }, { id: 'user_other' }],
    })
    await flushUi(2)
    expect(activeCollaboratorCount.value).toBe(1)

    handlers.get('sheet:presence')?.({
      sheetId: 'sheet_other',
      activeCount: 4,
      users: [{ id: 'user_a' }, { id: 'user_b' }, { id: 'user_c' }, { id: 'user_d' }],
    })
    await flushUi(2)
    expect(activeCollaboratorCount.value).toBe(1)

    sheetId.value = 'sheet_finance'
    await flushUi(4)
    expect(emitMock).toHaveBeenCalledWith('leave-sheet', 'sheet_ops')
    expect(emitMock).toHaveBeenCalledWith('join-sheet', 'sheet_finance')
  })
})
