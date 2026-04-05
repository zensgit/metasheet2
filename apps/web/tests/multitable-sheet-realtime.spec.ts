import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { useMultitableSheetRealtime } from '../src/multitable/composables/useMultitableSheetRealtime'

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

describe('useMultitableSheetRealtime', () => {
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

  it('joins sheet rooms and reloads the page for remote record updates only', async () => {
    const reloadCurrentSheetPage = vi.fn().mockResolvedValue(undefined)
    const reloadSelectedRecordContext = vi.fn().mockResolvedValue(undefined)
    const sheetId = ref('sheet_ops')
    const selectedRecordId = ref('rec_1')

    app = createApp(defineComponent({
      setup() {
        useMultitableSheetRealtime({
          sheetId,
          selectedRecordId,
          reloadCurrentSheetPage,
          reloadSelectedRecordContext,
        })
        return () => h('div')
      },
    }))
    app.mount(container!)
    await flushUi(6)

    expect(ioMock).toHaveBeenCalledTimes(1)
    expect(emitMock).toHaveBeenCalledWith('join-sheet', 'sheet_ops')

    handlers.get('sheet:op')?.({
      type: 'cell-update',
      data: {
        spreadsheetId: 'sheet_ops',
        actorId: 'user_other',
        kind: 'record-updated',
        recordIds: ['rec_1'],
      },
    })
    await flushUi(4)

    expect(reloadCurrentSheetPage).toHaveBeenCalledTimes(1)
    expect(reloadSelectedRecordContext).toHaveBeenCalledWith('rec_1')

    handlers.get('sheet:op')?.({
      type: 'cell-update',
      data: {
        spreadsheetId: 'sheet_ops',
        actorId: 'user_self',
        kind: 'record-updated',
        recordIds: ['rec_1'],
      },
    })
    await flushUi(3)
    expect(reloadCurrentSheetPage).toHaveBeenCalledTimes(1)

    handlers.get('sheet:op')?.({
      type: 'cell-update',
      data: {
        spreadsheetId: 'sheet_ops',
        actorId: 'user_other',
        kind: 'record-updated',
        recordIds: ['rec_2'],
      },
    })
    await flushUi(4)
    expect(reloadCurrentSheetPage).toHaveBeenCalledTimes(2)
    expect(reloadSelectedRecordContext).toHaveBeenCalledTimes(1)

    sheetId.value = 'sheet_finance'
    await flushUi(4)
    expect(emitMock).toHaveBeenCalledWith('leave-sheet', 'sheet_ops')
    expect(emitMock).toHaveBeenCalledWith('join-sheet', 'sheet_finance')
  })
})
