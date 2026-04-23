import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import GridView from '../src/views/GridView.vue'

const apiFetchMock = vi.hoisted(() => vi.fn())

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

function createJsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }
}

function createGridCellsPayload(version: number, value = 'before') {
  return {
    ok: true,
    data: {
      sheet: {
        id: 'sheet-1',
        spreadsheet_id: 'ss-1',
        row_count: 2,
        column_count: 2,
      },
      cells: [
        {
          row_index: 0,
          column_index: 0,
          value: { value },
          formula: null,
          version,
        },
      ],
    },
  }
}

async function flushUi(cycles = 8): Promise<void> {
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

function setFormulaBar(container: HTMLElement, value: string): void {
  const input = container.querySelector('.formula-input')
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('Formula input not found')
  }
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('blur', { bubbles: true }))
}

function getPutCellsBody() {
  const call = apiFetchMock.mock.calls.find(([url, init]) => (
    String(url) === '/api/spreadsheets/ss-1/sheets/sheet-1/cells' &&
    (init as RequestInit | undefined)?.method === 'PUT'
  ))
  if (!call) throw new Error('PUT /cells call not found')
  return JSON.parse(String((call[1] as RequestInit).body))
}

describe('GridView legacy cell version wiring', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  const originalAlert = globalThis.alert

  beforeEach(() => {
    apiFetchMock.mockReset()
    vi.spyOn(globalThis, 'alert').mockImplementation(() => undefined)
    localStorage.clear()
    localStorage.setItem('gridSpreadsheetId', 'ss-1')
    localStorage.setItem('gridSheetId', 'sheet-1')
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    container?.remove()
    app = null
    container = null
    localStorage.clear()
    vi.restoreAllMocks()
    globalThis.alert = originalAlert
  })

  it('sends expectedVersion when saving a changed server-backed cell', async () => {
    apiFetchMock
      .mockResolvedValueOnce(createJsonResponse(createGridCellsPayload(3)))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          cells: [
            { row_index: 0, column_index: 0, value: { value: 'after' }, formula: null, version: 4 },
          ],
        },
      }))

    app = createApp(GridView)
    app.mount(container!)
    await flushUi()

    setFormulaBar(container!, 'after')
    findButton(container!, '保存').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    expect(getPutCellsBody()).toEqual({
      cells: [
        { row: 0, col: 0, value: 'after', expectedVersion: 3 },
      ],
    })
    expect(container!.textContent).toContain('已保存')
    expect(globalThis.alert).toHaveBeenCalledWith('保存成功！')
  })

  it('surfaces VERSION_CONFLICT and does not mark the grid as saved', async () => {
    apiFetchMock
      .mockResolvedValueOnce(createJsonResponse(createGridCellsPayload(1)))
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

    app = createApp(GridView)
    app.mount(container!)
    await flushUi()

    setFormulaBar(container!, 'stale')
    findButton(container!, '保存').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    expect(getPutCellsBody()).toEqual({
      cells: [
        { row: 0, col: 0, value: 'stale', expectedVersion: 1 },
      ],
    })
    expect(container!.textContent).toContain('单元格 A1 已被其他会话更新')
    expect(container!.textContent).not.toContain('已保存')
    expect(globalThis.alert).toHaveBeenCalledWith('单元格 A1 已被其他会话更新，请刷新后重试。（服务器版本：2，本地版本：1）')
  })
})
