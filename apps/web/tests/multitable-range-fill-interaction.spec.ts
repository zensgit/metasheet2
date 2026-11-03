import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import { useLocale } from '../src/composables/useLocale'
import type { MetaField, MetaRecord, MetaRowActions } from '../src/multitable/types'
import { serializeClipboardMatrix, type RangeChange } from '../src/multitable/utils/grid-range-fill'

const GROUP: MetaField = { id: 'group', name: 'Group', type: 'string' }
function fields(): MetaField[] {
  return [
    { id: 'title', name: 'Title', type: 'string' },
    { id: 'other', name: 'Other', type: 'string' },
    { id: 'amount', name: 'Amount', type: 'number' },
  ]
}
function rows(): MetaRecord[] {
  return ['alpha', 'beta', 'gamma', 'delta'].map((title, i) => ({
    id: `r${i + 1}`, version: 5 + i * 3,
    data: { title, other: `other${i + 1}`, amount: 10 + i * 2, group: i < 2 ? 'A' : 'B' },
  }))
}
type GridState = {
  rows: MetaRecord[]
  visibleFields: MetaField[]
  rangeContextKey: string
  canEdit: boolean
  fieldReadOnlyIds: string[]
  rowActionOverrides: Record<string, MetaRowActions>
  collapsedGroupKeys: string[]
  groupField: MetaField | null
  commitRange: ((changes: RangeChange[]) => Promise<unknown>) | undefined
}
let app: App<Element> | null = null
let container: HTMLDivElement | null = null
let readText = vi.fn(async () => 'paste')
let writeText = vi.fn(async (_text: string) => {})
let originalClipboard: PropertyDescriptor | undefined

beforeEach(() => {
  useLocale().setLocale('en')
  vi.stubEnv('VITE_MULTITABLE_RANGE_FILL_ENABLED', 'true')
  readText = vi.fn(async () => 'paste')
  writeText = vi.fn(async (_text: string) => {})
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText, writeText } })
})
afterEach(() => {
  app?.unmount(); app = null
  container?.remove(); container = null
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
  vi.unstubAllEnvs()
})

async function mountGrid(overrides: Partial<GridState> = {}) {
  const commitRange = vi.fn(async (_changes: RangeChange[]) => {})
  const patchCell = vi.fn()
  const runButton = vi.fn()
  const selectionChange = vi.fn()
  const state = reactive<GridState>({
    rows: rows(), visibleFields: fields(), rangeContextKey: 'sheet1:view1', canEdit: true,
    fieldReadOnlyIds: [], rowActionOverrides: {}, collapsedGroupKeys: [], groupField: null,
    commitRange, ...overrides,
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    setup: () => () => h(MetaGridTable, {
      ...state, sortRules: [], loading: false, currentPage: 1, totalPages: 1, startIndex: 0,
      canDelete: true, canBulkEdit: true, enableMultiSelect: true, canComment: true,
      searchText: '', rowDensity: 'normal',
      'onPatch-cell': patchCell, 'onRun-button': runButton, 'onSelection-change': selectionChange,
    }),
  })
  app.mount(container)
  await nextTick()
  const root = container
  function get(selector: string): HTMLElement {
    const element = root.querySelector<HTMLElement>(selector)
    expect(element, selector).not.toBeNull()
    return element!
  }
  const cell = (row: number, col: number) => get(`[data-range-row="${row}"][data-range-col="${col}"]`)
  const selected = () => Array.from(root.querySelectorAll<HTMLElement>('.meta-grid__cell--range'))
    .map(element => `${element.dataset.rangeRow}:${element.dataset.rangeCol}`)
  return { root, state, commitRange, patchCell, runButton, selectionChange, get, cell, selected }
}
type Grid = Awaited<ReturnType<typeof mountGrid>>

async function mouse(target: HTMLElement, type: string, options: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...options }))
  await nextTick()
}
async function clickCell(grid: Grid, row: number, col: number, shiftKey = false) {
  const target = grid.cell(row, col)
  await mouse(target, 'mousedown', { shiftKey })
  await mouse(target, 'mouseup', { shiftKey })
  await mouse(target, 'click', { shiftKey })
}
async function rectangle(grid: Grid, top: number, left: number, bottom: number, right: number) {
  await mouse(grid.cell(top, left), 'mousedown')
  await mouse(grid.cell(bottom, right), 'mouseenter')
  await mouse(grid.cell(bottom, right), 'mouseup')
}
async function fill(grid: Grid, row: number, col: number) {
  await mouse(grid.get('[data-test="range-fill-handle"]'), 'mousedown')
  await mouse(grid.cell(row, col), 'mouseenter')
  await mouse(grid.cell(row, col), 'mouseup')
}
async function key(target: HTMLElement, name: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...options })
  target.dispatchEvent(event)
  await nextTick()
  return event
}
async function paste(grid: Grid, text: string) {
  readText.mockResolvedValueOnce(text)
  grid.get('[data-test="range-paste"]').click()
  await settled(grid)
}
// Keyboard paste: the browser's native paste event (jsdom has no ClipboardEvent constructor, so a plain
// cancelable `paste` Event carries a clipboardData stub). `null` = an event without clipboardData.
function pasteEvent(text: string | null): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: text === null ? null : { getData: (type: string) => (type === 'text/plain' ? text : '') },
  })
  return event
}
async function nativePaste(target: HTMLElement, text: string | null) {
  const event = pasteEvent(text)
  target.dispatchEvent(event)
  await nextTick()
  return event
}
// What a browser delivers for a copied screenshot: an image flavour only; getData('text/plain') is ''.
async function nativeImagePaste(target: HTMLElement) {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  const getData = vi.fn((type: string) => (type === 'image/png' ? 'binary-image-data' : ''))
  Object.defineProperty(event, 'clipboardData', { value: { types: ['image/png', 'Files'], getData } })
  target.dispatchEvent(event)
  await nextTick()
  expect(getData).toHaveBeenCalledWith('text/plain')
  return event
}
function removeClipboardApi() {
  Reflect.deleteProperty(navigator, 'clipboard')
  expect('clipboard' in navigator).toBe(false)
}
async function settled(grid: Grid) {
  await nextTick()
  await vi.waitFor(() => expect((grid.get('[data-test="range-mode"]') as HTMLSelectElement).disabled).toBe(false))
}
function deferredText() {
  let resolve!: (text: string) => void
  const promise = new Promise<string>(done => { resolve = done })
  return { promise, resolve }
}
function deferredOperation() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('MetaGridTable range interaction with real planner', () => {
  it('selects a mouse rectangle and extends the anchor through Shift+click and Shift+arrows', async () => {
    const grid = await mountGrid()
    await rectangle(grid, 0, 0, 1, 1)
    expect(grid.selected()).toEqual(['0:0', '0:1', '1:0', '1:1'])
    expect(grid.root.querySelectorAll('[data-test="range-fill-handle"]')).toHaveLength(1)
    await clickCell(grid, 2, 1, true)
    expect(grid.selected()).toEqual(['0:0', '0:1', '1:0', '1:1', '2:0', '2:1'])
    await key(grid.get('.meta-grid'), 'ArrowRight', { shiftKey: true })
    expect(grid.selected()).toHaveLength(9)
    await key(grid.get('.meta-grid'), 'ArrowUp', { shiftKey: true })
    expect(grid.selected()).toEqual(['0:0', '0:1', '0:2', '1:0', '1:1', '1:2'])
    await key(grid.get('.meta-grid'), 'Escape')
    expect(grid.selected()).toEqual([])
    expect(grid.commitRange).not.toHaveBeenCalled()
  })

  it.each([false, true])('tiles a frozen two-by-two source via the corner in grouped=%s', async grouped => {
    const grid = await mountGrid({ groupField: grouped ? GROUP : null })
    expect(!!grid.root.querySelector('[data-test="group-header"]')).toBe(grouped)
    await rectangle(grid, 0, 0, 1, 1)
    await mouse(grid.get('[data-test="range-fill-handle"]'), 'mousedown')
    await mouse(grid.cell(3, 2), 'mouseenter')
    expect(grid.root.querySelectorAll('.meta-grid__cell--range-preview')).toHaveLength(8)
    await mouse(grid.cell(3, 2), 'mouseup')
    expect(grid.commitRange).toHaveBeenCalledTimes(1)
    expect(grid.commitRange).toHaveBeenCalledWith([
      { recordId: 'r3', fieldId: 'title', value: 'alpha', expectedVersion: 11 },
      { recordId: 'r3', fieldId: 'other', value: 'other1', expectedVersion: 11 },
      { recordId: 'r4', fieldId: 'title', value: 'beta', expectedVersion: 14 },
      { recordId: 'r4', fieldId: 'other', value: 'other2', expectedVersion: 14 },
    ])
    expect(grid.state.rows[2].data.title).toBe('gamma')
    expect(grid.patchCell).not.toHaveBeenCalled()
  })

  it.each([false, true])('repeats horizontally to an equal-type visible field in grouped=%s', async grouped => {
    const grid = await mountGrid({ groupField: grouped ? GROUP : null })
    await rectangle(grid, 0, 0, 1, 0)
    await fill(grid, 1, 1)
    expect(grid.commitRange).toHaveBeenCalledTimes(1)
    expect(grid.commitRange).toHaveBeenCalledWith([
      { recordId: 'r1', fieldId: 'other', value: 'alpha', expectedVersion: 5 },
      { recordId: 'r2', fieldId: 'other', value: 'beta', expectedVersion: 8 },
    ])
  })

  it.each([false, true])('uses the toolbar Series mode with two numeric seeds in grouped=%s', async grouped => {
    const grid = await mountGrid({ groupField: grouped ? GROUP : null })
    const mode = grid.get('[data-test="range-mode"]') as HTMLSelectElement
    mode.value = 'series'
    mode.dispatchEvent(new Event('change', { bubbles: true }))
    await rectangle(grid, 0, 2, 1, 2)
    await fill(grid, 3, 2)
    expect(grid.commitRange).toHaveBeenCalledWith([
      { recordId: 'r3', fieldId: 'amount', value: 14, expectedVersion: 11 },
      { recordId: 'r4', fieldId: 'amount', value: 16, expectedVersion: 14 },
    ])
  })

  it('parses quoted multiline TSV and expands a single-cell target with captured versions', async () => {
    const grid = await mountGrid()
    await clickCell(grid, 1, 0)
    await paste(grid, '"a\tb"\t"line1\nline2"\r\n"say ""yes"""\tlast\r\n')
    expect(grid.commitRange).toHaveBeenCalledTimes(1)
    expect(grid.commitRange).toHaveBeenCalledWith([
      { recordId: 'r2', fieldId: 'title', value: 'a\tb', expectedVersion: 8 },
      { recordId: 'r2', fieldId: 'other', value: 'line1\nline2', expectedVersion: 8 },
      { recordId: 'r3', fieldId: 'title', value: 'say "yes"', expectedVersion: 11 },
      { recordId: 'r3', fieldId: 'other', value: 'last', expectedVersion: 11 },
    ])
  })

  it('extends a civil-date Series through leap day using the actual mode selector', async () => {
    const initial = rows()
    initial[0].data.day = '2024-02-28'
    initial[1].data.day = '2024-02-29'
    const grid = await mountGrid({ rows: initial, visibleFields: [{ id: 'day', name: 'Day', type: 'date' }] })
    const mode = grid.get('[data-test="range-mode"]') as HTMLSelectElement
    mode.value = 'series'
    mode.dispatchEvent(new Event('change', { bubbles: true }))
    await rectangle(grid, 0, 0, 1, 0)
    await fill(grid, 3, 0)
    expect(grid.commitRange).toHaveBeenCalledWith([
      { recordId: 'r3', fieldId: 'day', value: '2024-03-01', expectedVersion: 11 },
      { recordId: 'r4', fieldId: 'day', value: '2024-03-02', expectedVersion: 14 },
    ])
  })

  it('repeats upward from the frozen source rather than from preceding destination rows', async () => {
    const grid = await mountGrid()
    await rectangle(grid, 2, 0, 3, 0)
    await fill(grid, 0, 0)
    expect(grid.commitRange).toHaveBeenCalledWith([
      { recordId: 'r1', fieldId: 'title', value: 'gamma', expectedVersion: 5 },
      { recordId: 'r2', fieldId: 'title', value: 'delta', expectedVersion: 8 },
    ])
  })

  it('roundtrips a quoted rectangular selection using toolbar copy and keyboard paste', async () => {
    const initial = rows()
    initial[0].data.title = 'a\t"b"\nline'
    const grid = await mountGrid({ rows: initial })
    await rectangle(grid, 0, 0, 0, 1)
    grid.get('[data-test="range-copy"]').click()
    await settled(grid)
    expect(writeText).toHaveBeenCalledTimes(1)
    await clickCell(grid, 2, 0)
    // Ctrl+V's keydown is claimed but not preventDefault-ed, so the browser fires its paste event;
    // that event's clipboardData is the read (never the async API).
    const keyEvent = await key(grid.get('.meta-grid'), 'v', { ctrlKey: true })
    expect(keyEvent.defaultPrevented).toBe(false)
    const event = await nativePaste(grid.get('.meta-grid'), writeText.mock.calls[0][0])
    expect(event.defaultPrevented).toBe(true)
    await settled(grid)
    expect(readText).not.toHaveBeenCalled()
    expect(grid.commitRange).toHaveBeenCalledWith([
      { recordId: 'r3', fieldId: 'title', value: 'a\t"b"\nline', expectedVersion: 11 },
      { recordId: 'r3', fieldId: 'other', value: 'other1', expectedVersion: 11 },
    ])
  })

  it.each([
    ['row reorder', (state: GridState) => { state.rows.reverse() }],
    ['row version', (state: GridState) => { state.rows[0].version++ }],
    ['field definition', (state: GridState) => { state.visibleFields[0].property = { required: true } }],
    ['view context', (state: GridState) => { state.rangeContextKey = 'sheet1:view2' }],
    ['column reorder', (state: GridState) => { state.visibleFields.reverse() }],
    ['hidden column', (state: GridState) => { state.visibleFields = state.visibleFields.slice(1) }],
    ['group collapse', (state: GridState) => { state.collapsedGroupKeys = ['A'] }],
    ['row lock', (state: GridState) => { state.rows[0].locked = true }],
    ['write permission', (state: GridState) => { state.canEdit = false }],
  ])('cancels clipboard wait after %s changes', async (_name, change) => {
    const grid = await mountGrid({ groupField: GROUP })
    await clickCell(grid, 0, 0)
    const pending = deferredText()
    readText.mockReturnValueOnce(pending.promise)
    grid.get('[data-test="range-paste"]').click()
    await nextTick()
    expect(readText).toHaveBeenCalledTimes(1)
    change(grid.state)
    await nextTick()
    pending.resolve('changed\tvalue')
    await settled(grid)
    expect(grid.commitRange).not.toHaveBeenCalled()
    expect(grid.patchCell).not.toHaveBeenCalled()
    expect(grid.selected()).toEqual([])
    expect(grid.get('[data-test="range-status"]').textContent).toBe('Data or view changed. Select the range again.')
  })

  it.each([
    ['readonly field', (state: GridState) => { state.fieldReadOnlyIds = ['title'] }],
    ['locked destination', (state: GridState) => { state.rows[2].locked = true }],
    ['denied destination', (state: GridState) => {
      state.rowActionOverrides.r3 = { canEdit: false, canDelete: false, canComment: false }
    }],
  ])('rejects the whole fill for %s without writing the writable neighbor', async (_name, deny) => {
    const grid = await mountGrid()
    deny(grid.state)
    // Install changed permission props before creating a selection snapshot.
    await nextTick()
    await clickCell(grid, 0, 0)
    await fill(grid, 2, 0)
    expect(grid.commitRange).not.toHaveBeenCalled()
    expect(grid.patchCell).not.toHaveBeenCalled()
    expect(grid.state.rows[1].data.title).toBe('beta')
    expect(grid.get('[data-test="range-status"]').textContent).toBe('Range contains read-only cells; nothing submitted.')
  })

  it('maps grouped visible geometry to real row identities and excludes collapsed rows and hidden fields', async () => {
    const initial = rows()
    initial[1].data.group = 'B'; initial[2].data.group = 'A'
    const grid = await mountGrid({ rows: initial, groupField: GROUP, collapsedGroupKeys: ['B'], visibleFields: [fields()[0], fields()[2]] })
    expect(grid.root.querySelectorAll('.meta-grid__cell')).toHaveLength(4)
    expect(grid.cell(1, 0).textContent).toContain('gamma')
    await clickCell(grid, 0, 0)
    await paste(grid, 'first\t21\nsecond\t22')
    expect(grid.commitRange).toHaveBeenCalledWith([
      { recordId: 'r1', fieldId: 'title', value: 'first', expectedVersion: 5 },
      { recordId: 'r1', fieldId: 'amount', value: 21, expectedVersion: 5 },
      { recordId: 'r3', fieldId: 'title', value: 'second', expectedVersion: 11 },
      { recordId: 'r3', fieldId: 'amount', value: 22, expectedVersion: 11 },
    ])
  })

  it.each(['outside', 'blur', 'version change'])('cancels a corner drag on %s', async cancellation => {
    const grid = await mountGrid()
    await clickCell(grid, 0, 0)
    await mouse(grid.get('[data-test="range-fill-handle"]'), 'mousedown')
    await mouse(grid.cell(2, 0), 'mouseenter')
    if (cancellation === 'blur') window.dispatchEvent(new Event('blur'))
    if (cancellation === 'version change') grid.state.rows[0].version++
    await nextTick()
    await mouse(cancellation === 'outside' ? document.body : grid.cell(2, 0), 'mouseup')
    expect(grid.commitRange).not.toHaveBeenCalled()
    expect(grid.selected()).toEqual([])
    expect(grid.root.querySelector('.meta-grid__cell--range-preview')).toBeNull()
  })

  it('freezes source values at handle press even if a local draft changes before release', async () => {
    const grid = await mountGrid()
    await clickCell(grid, 0, 0)
    await mouse(grid.get('[data-test="range-fill-handle"]'), 'mousedown')
    grid.state.rows[0].data.title = 'transient local draft'
    await nextTick()
    await mouse(grid.cell(1, 0), 'mouseup')
    await settled(grid)
    expect(grid.commitRange).toHaveBeenCalledWith([
      { recordId: 'r2', fieldId: 'title', value: 'alpha', expectedVersion: 8 },
    ])
  })

  it('ignores secondary release during a primary corner drag and commits exactly once on primary release', async () => {
    const grid = await mountGrid()
    await clickCell(grid, 0, 0)
    await mouse(grid.get('[data-test="range-fill-handle"]'), 'mousedown')
    await mouse(grid.cell(2, 0), 'mouseenter')
    await mouse(grid.cell(2, 0), 'mouseup', { button: 2 })
    expect(grid.commitRange).not.toHaveBeenCalled()
    expect(grid.root.querySelectorAll('.meta-grid__cell--range-preview')).toHaveLength(3)
    await mouse(grid.cell(2, 0), 'mouseup')
    await settled(grid)
    expect(grid.commitRange).toHaveBeenCalledWith([
      { recordId: 'r2', fieldId: 'title', value: 'alpha', expectedVersion: 8 },
      { recordId: 'r3', fieldId: 'title', value: 'alpha', expectedVersion: 11 },
    ])
    await mouse(grid.cell(2, 0), 'mouseup')
    expect(grid.commitRange).toHaveBeenCalledTimes(1)
  })

  it('does not hijack action descendants or checkbox keyboard clipboard shortcuts', async () => {
    const grid = await mountGrid({ visibleFields: [fields()[0], { id: 'action', name: 'Run', type: 'button', property: { label: 'Run' } }] })
    await clickCell(grid, 0, 0)
    const button = grid.get('[data-test="cell-button"]')
    await mouse(button, 'mousedown')
    await mouse(button, 'mouseup')
    button.click()
    await nextTick()
    expect(grid.runButton).toHaveBeenCalledTimes(1)
    expect(grid.selected()).toEqual(['0:0'])
    const checkbox = grid.get('.meta-grid__check-col input')
    const event = await key(checkbox, 'v', { ctrlKey: true })
    expect(event.defaultPrevented).toBe(false)
    // A real click focuses these controls; the paste then targets them and they keep it.
    checkbox.focus()
    expect((await nativePaste(checkbox, 'hijacked')).defaultPrevented).toBe(false)
    button.focus()
    expect((await nativePaste(button, 'hijacked')).defaultPrevented).toBe(false)
    // Gate is by focus: a focused control keeps the paste even if the event is aimed at the grid root.
    expect((await nativePaste(grid.get('.meta-grid'), 'hijacked')).defaultPrevented).toBe(false)
    await key(button, 'ArrowRight', { shiftKey: true })
    expect(grid.selected()).toEqual(['0:0'])
    expect(readText).not.toHaveBeenCalled()
    expect(grid.commitRange).not.toHaveBeenCalled()
  })

  it('keeps range shortcuts and handle inactive while a real cell editor owns input', async () => {
    const grid = await mountGrid()
    await clickCell(grid, 0, 0)
    await mouse(grid.cell(0, 0), 'dblclick')
    await nextTick()
    const input = grid.get('.meta-cell-editor input')
    expect(grid.root.querySelector('[data-test="range-fill-handle"]')).toBeNull()
    await mouse(input, 'mousedown')
    await key(input, 'v', { ctrlKey: true })
    // The editor's own native paste is left alone (not intercepted, not written by the grid).
    expect((await nativePaste(input, 'into the editor')).defaultPrevented).toBe(false)
    await key(input, 'ArrowRight', { shiftKey: true })
    expect(grid.selected()).toEqual([])
    expect(grid.patchCell).not.toHaveBeenCalled()
    expect(readText).not.toHaveBeenCalled()
    expect(grid.commitRange).not.toHaveBeenCalled()
  })

  it.each([
    ['ragged clipboard', 'a\tb\nc', 0, 0, 'Clipboard is not a valid rectangular table.'],
    ['invalid number', 'secret-invalid-value', 0, 2, 'A value is invalid for its destination; nothing submitted.'],
    ['unloaded destination', 'a\nb', 3, 0, 'Destination exceeds loaded visible cells.'],
  ])('shows fixed text for %s and commits nothing', async (_name, text, row, col, message) => {
    const grid = await mountGrid()
    await clickCell(grid, row as number, col as number)
    await paste(grid, text as string)
    expect(grid.commitRange).not.toHaveBeenCalled()
    expect(grid.get('[data-test="range-status"]').textContent).toBe(message)
    expect(grid.root.textContent).not.toContain('secret-invalid-value')
  })

  it('shows fixed commit failure text without raw server values or automatic retry', async () => {
    const grid = await mountGrid()
    grid.commitRange.mockRejectedValueOnce(Object.assign(new Error('secret server detail'), { code: 'VERSION_CONFLICT' }))
    await clickCell(grid, 0, 0)
    await paste(grid, 'new')
    expect(grid.commitRange).toHaveBeenCalledTimes(1)
    expect(grid.get('[data-test="range-status"]').textContent).toBe('Operation not confirmed. Refresh and check before retrying.')
    expect(grid.root.textContent).not.toContain('secret server detail')
    expect(grid.state.rows[0].data.title).toBe('alpha')
  })

  it('reports the serializer cap for a 1050-cell copy without accessing clipboard write', async () => {
    const visibleFields = Array.from({ length: 50 }, (_, col): MetaField => ({
      id: `f${col}`, name: `Field ${col}`, type: 'string',
    }))
    const initial = Array.from({ length: 21 }, (_, row): MetaRecord => ({
      id: `r${row}`, version: row + 1,
      data: Object.fromEntries(visibleFields.map(field => [field.id, 'value'])),
    }))
    const grid = await mountGrid({ rows: initial, visibleFields })
    await rectangle(grid, 0, 0, 20, 49)
    expect(grid.selected()).toHaveLength(1050)
    grid.get('[data-test="range-copy"]').click()
    await settled(grid)

    expect(grid.get('[data-test="range-status"]').textContent).toBe('Limit: 1,000 destination cells.')
    expect(writeText).not.toHaveBeenCalled()
    expect(grid.commitRange).not.toHaveBeenCalled()
    expect(grid.patchCell).not.toHaveBeenCalled()
  })

  it('preserves STALE when an old commit rejects after navigation without an automatic retry', async () => {
    const grid = await mountGrid()
    const pending = deferredOperation()
    grid.commitRange.mockReturnValueOnce(pending.promise)
    await clickCell(grid, 0, 0)
    readText.mockResolvedValueOnce('new')
    grid.get('[data-test="range-paste"]').click()
    await vi.waitFor(() => expect(grid.commitRange).toHaveBeenCalledTimes(1))
    grid.state.rangeContextKey = 'sheet2:view2'
    await nextTick()
    pending.reject(new Error('secret late failure'))
    await settled(grid)

    expect(grid.get('[data-test="range-status"]').textContent).toBe('Data or view changed. Select the range again.')
    expect(grid.selected()).toEqual([])
    expect(grid.commitRange).toHaveBeenCalledTimes(1)
    expect(grid.commitRange).toHaveBeenCalledWith([
      { recordId: 'r1', fieldId: 'title', value: 'new', expectedVersion: 5 },
    ])
    expect(grid.patchCell).not.toHaveBeenCalled()
    expect(grid.state.rows[0].data.title).toBe('alpha')
    expect(grid.root.textContent).not.toContain('secret late failure')
  })

  it('preserves STALE when a pending clipboard copy completes after navigation', async () => {
    const grid = await mountGrid()
    const pending = deferredOperation()
    writeText.mockReturnValueOnce(pending.promise)
    await rectangle(grid, 0, 0, 0, 1)
    grid.get('[data-test="range-copy"]').click()
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    grid.state.rangeContextKey = 'sheet1:view2'
    await nextTick()
    pending.resolve()
    await settled(grid)

    expect(grid.get('[data-test="range-status"]').textContent).toBe('Data or view changed. Select the range again.')
    expect(grid.selected()).toEqual([])
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('alpha\tother1')
    expect(grid.commitRange).not.toHaveBeenCalled()
    expect(grid.patchCell).not.toHaveBeenCalled()
  })

  it.each(['false', 'TRUE', ' true ', ''])('preserves legacy single-cell paste and row checkboxes for flag=%j', async flag => {
    vi.stubEnv('VITE_MULTITABLE_RANGE_FILL_ENABLED', flag)
    const grid = await mountGrid()
    const cell = grid.get('.meta-grid__cell')
    await mouse(cell, 'click')
    await mouse(cell, 'mousedown')
    grid.get('.meta-grid').focus() // a real click on a cell focuses the grid root (nearest focusable ancestor)
    expect(grid.root.querySelector('[data-test="grid-range-toolbar"]')).toBeNull()
    expect(grid.root.querySelector('[data-test="range-fill-handle"]')).toBeNull()
    expect(grid.root.querySelector('[data-range-row]')).toBeNull()
    const keyEvent = await key(grid.get('.meta-grid'), 'v', { ctrlKey: true })
    expect(keyEvent.defaultPrevented).toBe(false)
    expect((await nativePaste(grid.get('.meta-grid'), 'legacy')).defaultPrevented).toBe(true)
    expect(grid.patchCell).toHaveBeenCalledWith('r1', 'title', 'legacy', 5)
    expect(readText).not.toHaveBeenCalled()
    const checkbox = grid.get('tbody .meta-grid__check-col input') as HTMLInputElement
    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    expect(grid.selectionChange).toHaveBeenCalledWith(['r1'])
    expect(grid.commitRange).not.toHaveBeenCalled()
  })
})


// Customer intranet deployment reached over plain HTTP by IP: not a secure context, so there is NO async
// Clipboard API. Keyboard paste must still work (it reads the native paste event), and the toolbar
// "Paste range" button, which cannot read without that API, must say so instead of failing obscurely.
describe('grid paste without the async Clipboard API (plain-HTTP deployment)', () => {
  it.each(['false', ''])('single cell (range flag=%j): Ctrl+V writes the pasted text into the focused cell', async flag => {
    vi.stubEnv('VITE_MULTITABLE_RANGE_FILL_ENABLED', flag)
    removeClipboardApi()
    const grid = await mountGrid()
    await mouse(grid.root.querySelector('tbody tr.meta-grid__row')!.querySelectorAll<HTMLElement>('.meta-grid__cell')[2], 'click') // row r1, Amount
    grid.get('.meta-grid').focus() // a real click on a cell focuses the grid root (nearest focusable ancestor)
    const gridRoot = grid.get('.meta-grid')
    expect((await key(gridRoot, 'v', { ctrlKey: true })).defaultPrevented).toBe(false)
    const event = await nativePaste(gridRoot, '42')
    expect(event.defaultPrevented).toBe(true)
    expect(grid.patchCell).toHaveBeenCalledTimes(1)
    expect(grid.patchCell).toHaveBeenCalledWith('r1', 'amount', 42, 5)
    expect(grid.commitRange).not.toHaveBeenCalled()
  })

  it('single cell: an event without clipboardData is left to the browser and writes nothing', async () => {
    vi.stubEnv('VITE_MULTITABLE_RANGE_FILL_ENABLED', 'false')
    removeClipboardApi()
    const grid = await mountGrid()
    await mouse(grid.get('.meta-grid__cell'), 'click')
    grid.get('.meta-grid').focus() // a real click on a cell focuses the grid root (nearest focusable ancestor)
    expect((await nativePaste(grid.get('.meta-grid'), null)).defaultPrevented).toBe(false)
    expect(grid.patchCell).not.toHaveBeenCalled()
  })

  it('single cell: the cell editor keeps its own native paste', async () => {
    vi.stubEnv('VITE_MULTITABLE_RANGE_FILL_ENABLED', 'false')
    removeClipboardApi()
    const grid = await mountGrid()
    const cell = grid.get('.meta-grid__cell')
    await mouse(cell, 'click')
    await mouse(cell, 'dblclick')
    await nextTick()
    const input = grid.get('.meta-cell-editor input')
    expect((await nativePaste(input, 'typed by paste')).defaultPrevented).toBe(false)
    // Even a paste that reaches the grid root itself while the editor is open (editor lost DOM focus)
    // must not write behind the editor's back: the old Ctrl+V shortcut had the same `!editCell` rule.
    expect((await nativePaste(grid.get('.meta-grid'), 'behind the editor')).defaultPrevented).toBe(false)
    expect(grid.patchCell).not.toHaveBeenCalled()
  })

  // Real Chrome (verification/cell-text-keyboard-paste.spec.ts): after a click on a cell's TEXT the
  // paste event targets the span holding the caret, while DOM focus is on the grid root.
  it('single cell: a paste aimed at the text inside the cell (where Chrome puts it) is written', async () => {
    vi.stubEnv('VITE_MULTITABLE_RANGE_FILL_ENABLED', 'false')
    removeClipboardApi()
    const grid = await mountGrid()
    const cell = grid.get('.meta-grid__cell')
    await mouse(cell, 'click')
    grid.get('.meta-grid').focus()
    const inner = Array.from(cell.querySelectorAll<HTMLElement>('*')).find(el => el.textContent === 'alpha' && el.children.length === 0)
    expect(inner, 'the cell renders its text in an inner element').toBeTruthy()
    expect(document.activeElement).toBe(grid.get('.meta-grid'))
    const event = await nativePaste(inner!, 'from the caret')
    expect(event.defaultPrevented).toBe(true)
    expect(grid.patchCell).toHaveBeenCalledWith('r1', 'title', 'from the caret', 5)
  })

  it('range: a paste aimed at the text inside a selected cell is written', async () => {
    removeClipboardApi()
    const grid = await mountGrid()
    await rectangle(grid, 0, 0, 0, 1)
    const inner = Array.from(grid.cell(0, 1).querySelectorAll<HTMLElement>('*')).find(el => el.textContent === 'other1' && el.children.length === 0)
    expect(inner).toBeTruthy()
    expect(document.activeElement).toBe(grid.get('.meta-grid'))
    expect((await nativePaste(inner!, 'x\ty')).defaultPrevented).toBe(true)
    await settled(grid)
    expect(grid.commitRange).toHaveBeenCalledWith([
      { recordId: 'r1', fieldId: 'title', value: 'x', expectedVersion: 5 },
      { recordId: 'r1', fieldId: 'other', value: 'y', expectedVersion: 5 },
    ])
  })

  it('a caret inside an editable element keeps its native paste even while the grid root has focus', async () => {
    vi.stubEnv('VITE_MULTITABLE_RANGE_FILL_ENABLED', 'false')
    removeClipboardApi()
    const grid = await mountGrid()
    const cell = grid.get('.meta-grid__cell')
    await mouse(cell, 'click')
    grid.get('.meta-grid').focus()
    const editable = document.createElement('span')
    editable.setAttribute('contenteditable', 'true')
    cell.appendChild(editable)
    expect((await nativePaste(editable, 'typed')).defaultPrevented).toBe(false)
    expect(grid.patchCell).not.toHaveBeenCalled()
    editable.remove()
  })

  it('a paste while no cell has focus writes nothing outside range mode', async () => {
    vi.stubEnv('VITE_MULTITABLE_RANGE_FILL_ENABLED', 'false')
    removeClipboardApi()
    const grid = await mountGrid()
    await mouse(grid.get('.meta-grid__cell'), 'click')
    // Focus left the grid (e.g. the user clicked elsewhere on the page): the grid does not paste.
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect((await nativePaste(grid.get('.meta-grid'), 'nowhere')).defaultPrevented).toBe(false)
    expect(grid.patchCell).not.toHaveBeenCalled()
  })

  it.each<[string, string, number, unknown]>([
    ['spreadsheet trailing CRLF', 'abc\r\n', 0, 'abc'],
    ['spreadsheet trailing LF', 'abc\n', 0, 'abc'],
    ['quoted multi-line cell', '"line1\nline2"\r\n', 0, 'line1\nline2'],
    ['multi-cell copy keeps the top-left cell', 'a\tb\nc\td', 0, 'a'],
    ['a stray quote the matrix grammar rejects stays as typed', 'He said "hi"\r\n', 0, 'He said "hi"'],
    ['number with a trailing line break', '42\r\n', 2, 42],
    ['empty spreadsheet cell into a number field clears it (never 0)', '\r\n', 2, null],
    ['empty spreadsheet cell into a text field clears it', '\n', 0, ''],
  ])('single cell reads the clipboard like the range paste: %s', async (_name, text, col, value) => {
    vi.stubEnv('VITE_MULTITABLE_RANGE_FILL_ENABLED', 'false')
    removeClipboardApi()
    const grid = await mountGrid()
    await mouse(grid.root.querySelector('tbody tr.meta-grid__row')!.querySelectorAll<HTMLElement>('.meta-grid__cell')[col], 'click')
    grid.get('.meta-grid').focus()
    await nativePaste(grid.get('.meta-grid'), text)
    expect(grid.patchCell).toHaveBeenCalledTimes(1)
    expect(grid.patchCell).toHaveBeenCalledWith('r1', fields()[col].id, value, 5)
  })

  it('range: a second paste while the first is still saving says to wait and writes once', async () => {
    removeClipboardApi()
    const grid = await mountGrid()
    const pending = deferredOperation()
    grid.commitRange.mockReturnValueOnce(pending.promise)
    await clickCell(grid, 0, 0)
    await nativePaste(grid.get('.meta-grid'), 'first')
    await vi.waitFor(() => expect(grid.commitRange).toHaveBeenCalledTimes(1))
    const second = await nativePaste(grid.get('.meta-grid'), 'second')
    expect(second.defaultPrevented).toBe(true)
    await nextTick()
    expect(grid.get('[data-test="range-status"]').textContent).toBe('Still working on the previous operation. Please wait.')
    pending.resolve()
    await settled(grid)
    expect(grid.commitRange).toHaveBeenCalledTimes(1)
    expect(grid.get('[data-test="range-status"]').textContent).toBe('Range saved (range undo is unavailable).')
  })

  it('range: the busy hint does not outlive an operation that ends without a status of its own', async () => {
    const grid = await mountGrid()
    const pending = deferredOperation()
    writeText.mockReturnValueOnce(pending.promise)
    await rectangle(grid, 0, 0, 0, 1)
    grid.get('[data-test="range-copy"]').click()
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    await nativePaste(grid.get('.meta-grid'), 'second')
    await nextTick()
    expect(grid.get('[data-test="range-status"]').textContent).toBe('Still working on the previous operation. Please wait.')
    // Escape drops the selection mid-copy, so the copy finishes without reporting anything.
    await key(grid.get('.meta-grid'), 'Escape')
    pending.resolve()
    await settled(grid)
    expect(grid.root.querySelector('[data-test="range-status"]')).toBeNull()
    expect(grid.commitRange).not.toHaveBeenCalled()
  })

  it('range: a paste with no focused cell and no selection asks for a target (zh)', async () => {
    removeClipboardApi()
    useLocale().setLocale('zh-CN')
    const grid = await mountGrid()
    grid.get('.meta-grid').focus()
    const event = await nativePaste(grid.get('.meta-grid'), 'orphan')
    expect(event.defaultPrevented).toBe(true)
    await nextTick()
    expect(grid.get('[data-test="range-status"]').textContent).toBe('请先选中要粘贴的单元格')
    expect(grid.commitRange).not.toHaveBeenCalled()
    expect(grid.patchCell).not.toHaveBeenCalled()
  })

  it('range: a pasted matrix is written into the selected rectangle', async () => {
    removeClipboardApi()
    const grid = await mountGrid()
    await rectangle(grid, 1, 0, 2, 1)
    const event = await nativePaste(grid.get('.meta-grid'), 'a\tb\r\nc\td\r\n')
    expect(event.defaultPrevented).toBe(true)
    await settled(grid)
    expect(grid.commitRange).toHaveBeenCalledTimes(1)
    expect(grid.commitRange).toHaveBeenCalledWith([
      { recordId: 'r2', fieldId: 'title', value: 'a', expectedVersion: 8 },
      { recordId: 'r2', fieldId: 'other', value: 'b', expectedVersion: 8 },
      { recordId: 'r3', fieldId: 'title', value: 'c', expectedVersion: 11 },
      { recordId: 'r3', fieldId: 'other', value: 'd', expectedVersion: 11 },
    ])
    expect(grid.patchCell).not.toHaveBeenCalled()
    expect(grid.get('[data-test="range-status"]').textContent).toBe('Range saved (range undo is unavailable).')
  })

  it('range: Ctrl+V on a focused cell with no selection expands from that cell, like the old shortcut', async () => {
    removeClipboardApi()
    const grid = await mountGrid()
    await clickCell(grid, 0, 1)
    expect((await key(grid.get('.meta-grid'), 'v', { ctrlKey: true })).defaultPrevented).toBe(false)
    await nativePaste(grid.get('.meta-grid'), 'x\ny')
    await settled(grid)
    expect(grid.commitRange).toHaveBeenCalledWith([
      { recordId: 'r1', fieldId: 'other', value: 'x', expectedVersion: 5 },
      { recordId: 'r2', fieldId: 'other', value: 'y', expectedVersion: 8 },
    ])
  })

  it('range: the cell editor keeps its own native paste', async () => {
    removeClipboardApi()
    const grid = await mountGrid()
    await clickCell(grid, 0, 0)
    await mouse(grid.cell(0, 0), 'dblclick')
    await nextTick()
    const input = grid.get('.meta-cell-editor input')
    expect((await nativePaste(input, 'typed by paste')).defaultPrevented).toBe(false)
    await nextTick()
    expect(grid.commitRange).not.toHaveBeenCalled()
    expect(grid.patchCell).not.toHaveBeenCalled()
  })

  it.each([
    ['en', 'Press Ctrl+V (⌘V on Mac) to paste into the range here.'],
    ['zh-CN', '当前环境请直接按 Ctrl+V（Mac 为 ⌘V）粘贴到选区'],
  ] as const)('the Paste range button explains the shortcut (%s), reads and writes nothing, and hands focus back to the grid', async (locale, message) => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } }) // no readText
    useLocale().setLocale(locale)
    const grid = await mountGrid()
    await rectangle(grid, 0, 0, 1, 0)
    const button = grid.get('[data-test="range-paste"]')
    button.focus()
    button.click()
    await settled(grid)
    expect(grid.get('[data-test="range-status"]').textContent).toBe(message)
    expect(readText).not.toHaveBeenCalled()
    expect(grid.commitRange).not.toHaveBeenCalled()
    expect(grid.patchCell).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(grid.get('.meta-grid'))
    expect(grid.selected()).toEqual(['0:0', '1:0'])
    // The shortcut the message asks for then works on the same selection.
    await nativePaste(grid.get('.meta-grid'), 'p')
    await settled(grid)
    expect(grid.commitRange).toHaveBeenCalledWith([
      { recordId: 'r1', fieldId: 'title', value: 'p', expectedVersion: 5 },
      { recordId: 'r2', fieldId: 'title', value: 'p', expectedVersion: 8 },
    ])
  })

  it('with the async Clipboard API present the Paste range button still reads it (unchanged path)', async () => {
    const grid = await mountGrid()
    await rectangle(grid, 0, 0, 0, 1)
    await paste(grid, 'one\ttwo')
    expect(readText).toHaveBeenCalledTimes(1)
    expect(grid.commitRange).toHaveBeenCalledWith([
      { recordId: 'r1', fieldId: 'title', value: 'one', expectedVersion: 5 },
      { recordId: 'r1', fieldId: 'other', value: 'two', expectedVersion: 5 },
    ])
  })

  // Empty paste: an empty clipboard, or one holding only an image / only HTML, reads as ''. Tiled over a
  // range it would clear every selected cell (up to 1,000) and range writes cannot be undone, so it
  // writes nothing and says so, on the keyboard path and on the button path alike.
  const EMPTY = 'The clipboard has no text to paste; nothing was changed.'
  it('range: an empty keyboard paste writes nothing and says so', async () => {
    removeClipboardApi()
    const grid = await mountGrid()
    await rectangle(grid, 0, 0, 1, 1)
    const event = await nativePaste(grid.get('.meta-grid'), '')
    expect(event.defaultPrevented).toBe(true)
    await settled(grid)
    expect(grid.commitRange).not.toHaveBeenCalled()
    expect(grid.patchCell).not.toHaveBeenCalled()
    expect(grid.get('[data-test="range-status"]').textContent).toBe(EMPTY)
    expect(grid.state.rows[0].data.title).toBe('alpha')
  })

  it('range: an image-only paste writes nothing, is kept from the browser, and says so (zh)', async () => {
    removeClipboardApi()
    useLocale().setLocale('zh-CN')
    const grid = await mountGrid()
    await rectangle(grid, 0, 0, 1, 1)
    const event = await nativeImagePaste(grid.get('.meta-grid'))
    expect(event.defaultPrevented).toBe(true)
    await settled(grid)
    expect(grid.commitRange).not.toHaveBeenCalled()
    expect(grid.patchCell).not.toHaveBeenCalled()
    expect(grid.get('[data-test="range-status"]').textContent).toBe('剪贴板里没有可粘贴的文字，未做任何修改')
  })

  it('button: an empty clipboard writes nothing and says so', async () => {
    const grid = await mountGrid()
    await rectangle(grid, 0, 0, 1, 1)
    await paste(grid, '')
    expect(readText).toHaveBeenCalledTimes(1)
    expect(grid.commitRange).not.toHaveBeenCalled()
    expect(grid.patchCell).not.toHaveBeenCalled()
    expect(grid.get('[data-test="range-status"]').textContent).toBe(EMPTY)
  })

  it('single cell: an empty or image-only paste never clears the focused cell', async () => {
    vi.stubEnv('VITE_MULTITABLE_RANGE_FILL_ENABLED', 'false')
    removeClipboardApi()
    const grid = await mountGrid()
    await mouse(grid.get('.meta-grid__cell'), 'click')
    grid.get('.meta-grid').focus() // a real click on a cell focuses the grid root (nearest focusable ancestor)
    expect((await nativePaste(grid.get('.meta-grid'), '')).defaultPrevented).toBe(true)
    expect((await nativeImagePaste(grid.get('.meta-grid'))).defaultPrevented).toBe(true)
    expect(grid.patchCell).not.toHaveBeenCalled()
    // Positive control on the same focused cell: real text is still written.
    await nativePaste(grid.get('.meta-grid'), 'kept working')
    expect(grid.patchCell).toHaveBeenCalledWith('r1', 'title', 'kept working', 5)
  })

  const tooLarge = Array.from({ length: 1001 }, () => 'v').join('\n')
  const SAVED = 'Range saved (range undo is unavailable).'
  it.each([
    ['plain value', 'new', {}, 0, SAVED, 1],
    ['empty clipboard / no text flavour', '', {}, 0, EMPTY, 0],
    ['ragged matrix', 'a\tb\nc', {}, 0, 'Clipboard is not a valid rectangular table.', 0],
    ['over the 1,000-cell limit', tooLarge, {}, 0, 'Limit: 1,000 destination cells.', 0],
    ['read-only destination field', 'new', { fieldReadOnlyIds: ['title'] }, 0, 'Range contains read-only cells; nothing submitted.', 0],
    ['value incompatible with a number field', 'not-a-number', {}, 2, 'A value is invalid for its destination; nothing submitted.', 0],
  ] as Array<[string, string, Partial<GridState>, number, string, number]>)('button and Ctrl+V give the same result: %s', async (_name, text, overrides, col, message, commits) => {
    const outcome = async (via: 'button' | 'keyboard') => {
      const grid = await mountGrid(overrides)
      await clickCell(grid, 0, col)
      if (via === 'button') await paste(grid, text)
      else {
        await nativePaste(grid.get('.meta-grid'), text)
        await settled(grid)
      }
      const result = {
        commits: grid.commitRange.mock.calls,
        patches: grid.patchCell.mock.calls,
        status: grid.root.querySelector('[data-test="range-status"]')?.textContent ?? null,
      }
      app?.unmount(); app = null
      container?.remove(); container = null
      return result
    }
    const viaButton = await outcome('button')
    const viaKeyboard = await outcome('keyboard')
    expect(viaButton.status).toBe(message)
    expect(viaButton.commits).toHaveLength(commits)
    expect(viaButton.patches).toEqual([])
    expect(viaKeyboard).toEqual(viaButton)
  })
})

describe('editable field range copy', () => {
  it.each<[MetaField['type'], unknown]>([
    ['multiSelect', ['alpha, beta', 'gamma\ndelta']], ['person', ['member1', 'member2']],
    ['location', { address: 'Synthetic', latitude: 25, longitude: 121 }], ['currency', 12.5],
    ['attachment', ['file1']], ['link', ['record1']], ['longText', 'multiple\nlines'],
  ])('drags a %s value as a whole into two rows', async (type, value) => {
    const grid = await mountGrid({
      visibleFields: [{ id: 'f', name: 'Value', type, options: [{ value: 'alpha, beta' }, { value: 'gamma\ndelta' }],
        property: { limitSingleRecord: false, foreignSheetId: 'foreign' } }],
      rows: [{ id: 'r1', version: 1, data: { f: value } }, { id: 'r2', version: 2, data: { f: null } },
        { id: 'r3', version: 3, data: { f: null } }],
    })
    await clickCell(grid, 0, 0)
    await fill(grid, 2, 0)
    await settled(grid)
    expect(grid.commitRange).toHaveBeenCalledWith([
      { recordId: 'r2', fieldId: 'f', value, expectedVersion: 2 },
      { recordId: 'r3', fieldId: 'f', value, expectedVersion: 3 },
    ])
    expect(grid.patchCell).not.toHaveBeenCalled()
  })

  it.each(['multiSelect', 'person'] as const)('roundtrips %s through the actual grid clipboard handlers', async type => {
    const value = type === 'person' ? ['member1', 'member2'] : ['alpha, beta', 'gamma\ndelta']
    const grid = await mountGrid({
      visibleFields: [{ id: 'f', name: 'Array', type, options: value.map(value => ({ value })), property: { limitSingleRecord: false } }],
      rows: [{ id: 'r1', version: 1, data: { f: value } }, { id: 'r2', version: 2, data: { f: ['old'] } }],
    })
    await clickCell(grid, 0, 0)
    await key(grid.get('.meta-grid'), 'c', { ctrlKey: true })
    await settled(grid)
    const text = serializeClipboardMatrix([[value]])
    expect(writeText).toHaveBeenCalledWith(text)
    await clickCell(grid, 1, 0)
    await paste(grid, text)
    expect(grid.commitRange).toHaveBeenCalledWith([{ recordId: 'r2', fieldId: 'f', value, expectedVersion: 2 }])
  })

  it('freezes array content at drag start even if the source mutates in place before mouseup', async () => {
    const grid = await mountGrid({
      visibleFields: [{ id: 'f', name: 'People', type: 'person', property: { limitSingleRecord: false } }],
      rows: [{ id: 'r1', version: 1, data: { f: ['member1'] } }, { id: 'r2', version: 2, data: { f: [] } }],
    })
    await clickCell(grid, 0, 0)
    await mouse(grid.get('[data-test="range-fill-handle"]'), 'mousedown')
    ;(grid.state.rows[0].data.f as string[]).push('member2')
    await mouse(grid.cell(1, 0), 'mouseenter')
    await mouse(grid.cell(1, 0), 'mouseup')
    await settled(grid)
    expect(grid.commitRange).toHaveBeenCalledWith([{ recordId: 'r2', fieldId: 'f', value: ['member1'], expectedVersion: 2 }])
  })

  it('shows a saved-but-refresh-needed message even after successful projection clears the selection', async () => {
    const grid = await mountGrid()
    grid.commitRange.mockImplementationOnce(async () => {
      grid.state.rows[1].version++
      throw new Error('RANGE_REFRESH_REQUIRED')
    })
    await clickCell(grid, 0, 0)
    await fill(grid, 1, 0)
    await settled(grid)
    expect(grid.get('[data-test="range-status"]').textContent).toBe('Range saved, but display refresh failed. Refresh to check; do not resubmit.')
    expect(grid.commitRange).toHaveBeenCalledTimes(1)
  })

  it('copies a computed result as a value into an editable number cell without writing the formula', async () => {
    const grid = await mountGrid({
      visibleFields: [{ id: 'computed', name: 'Formula', type: 'formula' }, { id: 'manual', name: 'Number', type: 'number' }],
      rows: [{ id: 'r1', version: 1, data: { computed: 42, manual: null } }],
    })
    await clickCell(grid, 0, 0)
    await key(grid.get('.meta-grid'), 'c', { ctrlKey: true })
    await settled(grid)
    expect(writeText).toHaveBeenCalledWith('42')
    await clickCell(grid, 0, 1)
    await paste(grid, '42')
    expect(grid.commitRange).toHaveBeenCalledWith([{ recordId: 'r1', fieldId: 'manual', value: 42, expectedVersion: 1 }])
  })
})
