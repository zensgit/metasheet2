import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import SpreadsheetDetailView from '../src/views/SpreadsheetDetailView.vue'

const apiFetchMock = vi.hoisted(() => vi.fn())
const routerPushMock = vi.hoisted(() => vi.fn())
const routeParams = vi.hoisted(() => ({ id: 'ss-1' }))

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: routeParams }),
  useRouter: () => ({ push: routerPushMock }),
}))

function createJsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }
}

function createSpreadsheetPayload(sheetIds = ['sheet-1']) {
  return {
    ok: true,
    data: {
      id: 'ss-1',
      name: 'Legacy Sheet',
      sheets: sheetIds.map((id, index) => ({
        id,
        name: `Sheet ${index + 1}`,
      })),
    },
  }
}

function createCellsPayload(cells: unknown[]) {
  return {
    ok: true,
    data: {
      sheet: {
        id: 'sheet-1',
        spreadsheet_id: 'ss-1',
        row_count: 100,
        column_count: 26,
      },
      cells,
    },
  }
}

function deferredResponse() {
  let resolve!: (value: unknown) => void
  const promise = new Promise((next) => {
    resolve = next
  })
  return {
    promise,
    resolve,
  }
}

async function flushUi(cycles = 6): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button'))
    .find((candidate) => candidate.textContent?.includes(label))
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`)
  }
  return button
}

function setInput(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function getPutCellsBody(sheetId = 'sheet-1') {
  const call = apiFetchMock.mock.calls.find(([url, init]) => (
    String(url) === `/api/spreadsheets/ss-1/sheets/${sheetId}/cells` &&
    (init as RequestInit | undefined)?.method === 'PUT'
  ))
  if (!call) throw new Error('PUT /cells call not found')
  const body = (call[1] as RequestInit).body
  return JSON.parse(String(body))
}

describe('SpreadsheetDetailView legacy cell version wiring', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    apiFetchMock.mockReset()
    routerPushMock.mockReset()
    routeParams.id = 'ss-1'
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    container?.remove()
    app = null
    container = null
  })

  it('loads cell versions and sends expectedVersion on update', async () => {
    apiFetchMock
      .mockResolvedValueOnce(createJsonResponse(createSpreadsheetPayload()))
      .mockResolvedValueOnce(createJsonResponse(createCellsPayload([
        { row_index: 0, column_index: 0, value: { value: 'before' }, formula: null, version: 3 },
      ])))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          cells: [
            { row_index: 0, column_index: 0, value: { value: 'after' }, formula: null, version: 4 },
          ],
        },
      }))

    app = createApp(SpreadsheetDetailView)
    app.mount(container!)
    await flushUi()

    const inputs = container!.querySelectorAll('input')
    setInput(inputs[2] as HTMLInputElement, 'after')
    findButton(container!, 'Update').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    expect(getPutCellsBody()).toEqual({
      cells: [
        { row: 0, col: 0, value: 'after', expectedVersion: 3 },
      ],
    })
    expect(container!.textContent).toContain('Cell updated.')
  })

  it('surfaces VERSION_CONFLICT without marking the update as successful', async () => {
    apiFetchMock
      .mockResolvedValueOnce(createJsonResponse(createSpreadsheetPayload()))
      .mockResolvedValueOnce(createJsonResponse(createCellsPayload([
        { row_index: 0, column_index: 0, value: { value: 'before' }, formula: null, version: 1 },
      ])))
      .mockResolvedValueOnce(createJsonResponse({
        ok: false,
        error: {
          code: 'VERSION_CONFLICT',
          row: 0,
          col: 0,
          serverVersion: 2,
          expectedVersion: 1,
        },
      }, 409))

    app = createApp(SpreadsheetDetailView)
    app.mount(container!)
    await flushUi()

    const inputs = container!.querySelectorAll('input')
    setInput(inputs[2] as HTMLInputElement, 'stale')
    findButton(container!, 'Update').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    expect(getPutCellsBody()).toEqual({
      cells: [
        { row: 0, col: 0, value: 'stale', expectedVersion: 1 },
      ],
    })
    expect(container!.textContent).toContain('Cell A1 was changed by another session')
    expect(container!.textContent).not.toContain('Cell updated.')
  })

  it('does not reuse stale expectedVersion after switching sheets while cell versions are loading', async () => {
    const sheet2Cells = deferredResponse()
    apiFetchMock
      .mockResolvedValueOnce(createJsonResponse(createSpreadsheetPayload(['sheet-1', 'sheet-2'])))
      .mockResolvedValueOnce(createJsonResponse(createCellsPayload([
        { row_index: 0, column_index: 0, value: { value: 'sheet-1' }, formula: null, version: 9 },
      ])))
      .mockImplementationOnce(() => sheet2Cells.promise)
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          cells: [
            { row_index: 0, column_index: 0, value: { value: 'sheet-2-new' }, formula: null, version: 1 },
          ],
        },
      }))

    app = createApp(SpreadsheetDetailView)
    app.mount(container!)
    await flushUi()

    const sheet2 = Array.from(container!.querySelectorAll('.spreadsheet-detail__sheet'))
      .find((candidate) => candidate.textContent?.includes('sheet-2'))
    expect(sheet2).toBeTruthy()
    sheet2!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(1)

    const inputs = container!.querySelectorAll('input')
    setInput(inputs[2] as HTMLInputElement, 'sheet-2-new')
    findButton(container!, 'Update').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    expect(getPutCellsBody('sheet-2')).toEqual({
      cells: [
        { row: 0, col: 0, value: 'sheet-2-new' },
      ],
    })

    sheet2Cells.resolve(createJsonResponse(createCellsPayload([
      { row_index: 0, column_index: 0, value: { value: 'sheet-2' }, formula: null, version: 5 },
    ])))
    await flushUi()
  })
})
