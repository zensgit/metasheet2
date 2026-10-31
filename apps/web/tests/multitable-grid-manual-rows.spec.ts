/**
 * 人工补充行 B3 (ADR adr-stock-prep-manual-rows-20261030 §3.4, §3.7, §8 「B3」 4; #6664 notes N2 / N5 / N12) — the grid half:
 *
 *   H  the pure rules (utils/manual-rows.ts): the fail-closed block read, the states that allow adding / editing, the
 *      N5 intersection with the actor's field permissions, the 新增 dialog plan, the note per state;
 *   R  useMultitableGrid's route choice: a manual cell writes through PATCH /records/:recordId/manual-fields, undo / redo
 *      replay through the same route, an entry that can no longer take it is dropped (never replayed to /patch), an
 *      edit whose undo would clear a required column never enters the stack, the returned version is reported;
 *   G  MetaGridTable: the 「人工补充」 row label for every reader; single-cell editing of the fillable columns of a manual
 *      row only when the workbench names them (never on the row mark alone); range fill and paste (the focused cell
 *      included) keep treating them as read-only.
 *
 * Collected by the required web gate through the existing `multitable-grid` token (a vitest path-substring filter).
 * Every value is synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, ref, type App } from 'vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import { useLocale } from '../src/composables/useLocale'
import { MultitableApiClient } from '../src/multitable/api/client'
import { useMultitableGrid, type ManualCellWrite } from '../src/multitable/composables/useMultitableGrid'
import type { MetaField, MetaFieldPermission, MetaManualRowsBlock, MetaRecord, MetaRowActions } from '../src/multitable/types'
import {
  manualRowFieldAccess,
  manualRowsCreateEnabled,
  manualRowsCreateRefusalKey,
  manualRowsEditEnabled,
  manualRowsNoticeOf,
  readManualRowsBlock,
  resolveManualRowDialogPlan,
  resolveManualRowEditableFieldIds,
} from '../src/multitable/utils/manual-rows'
import type { RangeChange } from '../src/multitable/utils/grid-range-fill'

const LOCK = { humanWriteLock: 'plm_system' }
// Synthetic physical ids standing for the template's 名称 / 总用量 / 规格 / 用量 (locked) and 备注 (human).
const F = { name: 'fld_mr_name', total: 'fld_mr_total', spec: 'fld_mr_spec', raw: 'fld_mr_raw', notes: 'fld_mr_notes', key: 'fld_mr_key' }
const FIELDS: MetaField[] = [
  { id: F.name, name: '名称', type: 'string', property: { ...LOCK } },
  { id: F.total, name: '总用量', type: 'number', property: { ...LOCK } },
  { id: F.spec, name: '组件规格', type: 'string', property: { ...LOCK } },
  { id: F.raw, name: '单层用量', type: 'number', property: { ...LOCK } },
  { id: F.notes, name: '备注', type: 'string' },
  { id: F.key, name: '唯一键', type: 'string', property: { ...LOCK } },
]
const BLOCK: MetaManualRowsBlock = {
  state: 'allowed',
  editableFieldIds: [F.name, F.spec, F.raw, F.total],
  requiredFieldIds: [F.name, F.total],
  dialogFieldIds: [F.name, F.total, F.spec, F.raw, F.notes],
}
/** What the host sends for a locked column: read-only (the lock is folded in), visible. */
const PERMS: Record<string, MetaFieldPermission> = Object.fromEntries(FIELDS.map((f) => [f.id, { visible: true, readOnly: f.id !== F.notes }]))

describe('H — the pure rules (utils/manual-rows.ts)', () => {
  it('H-01 the block read: absent → null (old behaviour); a role string → null; a well-formed block → its lists', () => {
    expect(readManualRowsBlock({ canCreateRecord: true })).toBeNull()
    expect(readManualRowsBlock('editor')).toBeNull()
    expect(readManualRowsBlock(null)).toBeNull()
    expect(readManualRowsBlock({ stockPreparationManualRows: { ...BLOCK } })).toEqual(BLOCK)
    expect(readManualRowsBlock({ stockPreparationManualRows: { state: 'unavailable', reason: 'lock_missing', editableFieldIds: [], requiredFieldIds: [] } }))
      .toEqual({ state: 'unavailable', reason: 'lock_missing', editableFieldIds: [], requiredFieldIds: [], dialogFieldIds: [] })
  })

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'allowed'],
    ['an unknown state', { state: 'open', editableFieldIds: [F.name] }],
  ])('H-02 a block that is present but %s reads as unavailable with no ids (fail closed)', (_label, raw) => {
    const block = readManualRowsBlock({ stockPreparationManualRows: raw })
    expect(block).toEqual({ state: 'unavailable', editableFieldIds: [], requiredFieldIds: [], dialogFieldIds: [] })
    expect(manualRowsCreateEnabled(block)).toBe(false)
    expect(manualRowsEditEnabled(block)).toBe(false)
  })

  it.each([
    [{ state: 'allowed' }, true, true],
    [{ state: 'disabled' }, false, true],
    [{ state: 'unavailable', reason: 'project_archived' }, false, true],
    [{ state: 'unavailable', reason: 'project_sheets_off' }, false, true],
    [{ state: 'unavailable', reason: 'lock_missing' }, false, false],
    [{ state: 'unavailable', reason: 'contract_mismatch' }, false, false],
    [{ state: 'unavailable', reason: 'registry_unreadable' }, false, false],
    [{ state: 'unavailable', reason: 'a_future_reason' }, false, false],
  ])('H-03 %j: add=%s edit=%s (only `allowed` adds; an archived project / the deployment switch / the per-sheet switch do not stop an edit)', (partial, add, edit) => {
    const block = readManualRowsBlock({ stockPreparationManualRows: { editableFieldIds: [], requiredFieldIds: [], ...partial } })
    expect(manualRowsCreateEnabled(block)).toBe(add)
    expect(manualRowsEditEnabled(block)).toBe(edit)
  })

  it('H-04 N5: the editable list is the block\'s ∩ the actor\'s field permissions — a hidden column drops, a LOCKED column\'s readOnly says nothing', () => {
    expect(resolveManualRowEditableFieldIds(BLOCK, FIELDS, PERMS)).toEqual([F.name, F.spec, F.raw, F.total])
    const hiddenSpec = { ...PERMS, [F.spec]: { visible: false, readOnly: true } }
    expect(resolveManualRowEditableFieldIds(BLOCK, FIELDS, hiddenSpec)).toEqual([F.name, F.raw, F.total])
    // An UNLOCKED fillable column (a sheet whose lock does not cover it): its readOnly IS the actor's answer.
    const unlocked = FIELDS.map((f) => (f.id === F.raw ? { ...f, property: {} } : f))
    expect(resolveManualRowEditableFieldIds(BLOCK, unlocked, { ...PERMS, [F.raw]: { visible: true, readOnly: true } })).toEqual([F.name, F.spec, F.total])
    expect(resolveManualRowEditableFieldIds(BLOCK, unlocked, { ...PERMS, [F.raw]: { visible: true, readOnly: false } })).toEqual([F.name, F.spec, F.raw, F.total])
    // A column the sheet does not have, a property-hidden column, an always-read-only one: never editable.
    expect(resolveManualRowEditableFieldIds({ ...BLOCK, editableFieldIds: ['fld_absent'] }, FIELDS, PERMS)).toEqual([])
    expect(manualRowFieldAccess({ id: 'x', name: 'x', type: 'string', property: { hidden: true } }, { visible: true, readOnly: false })).toBe('hidden')
    expect(manualRowFieldAccess({ id: 'x', name: 'x', type: 'formula' }, { visible: true, readOnly: true })).toBe('read_only')
    // A block that does not allow editing yields nothing at all.
    expect(resolveManualRowEditableFieldIds({ ...BLOCK, state: 'unavailable', reason: 'lock_missing' }, FIELDS, PERMS)).toEqual([])
    expect(resolveManualRowEditableFieldIds(null, FIELDS, PERMS)).toEqual([])
  })

  it('H-05 the 新增 dialog: the block\'s order (名称*, 总用量*, then the optional ones); a view-hidden column is still offered, a permission-hidden one is not', () => {
    const plan = resolveManualRowDialogPlan(BLOCK, FIELDS, PERMS, new Set())
    expect(plan.fields.map((entry) => [entry.field.id, entry.required])).toEqual([
      [F.name, true], [F.total, true], [F.spec, false], [F.raw, false], [F.notes, false],
    ])
    expect(plan.blockedRequiredCount).toBe(0)
    // 单层用量 hidden by the CURRENT VIEW (the 填写视图 hides it): the host folds that into visible:false — still offered.
    const viewHidden = { ...PERMS, [F.raw]: { visible: false, readOnly: true } }
    expect(resolveManualRowDialogPlan(BLOCK, FIELDS, viewHidden, new Set([F.raw])).fields.map((e) => e.field.id)).toContain(F.raw)
    // The same visible:false WITHOUT the view hiding it is the actor's permission: not offered.
    expect(resolveManualRowDialogPlan(BLOCK, FIELDS, viewHidden, new Set()).fields.map((e) => e.field.id)).not.toContain(F.raw)
    // 备注 read-only for this actor (an unlocked column): not offered.
    expect(resolveManualRowDialogPlan(BLOCK, FIELDS, { ...PERMS, [F.notes]: { visible: true, readOnly: true } }, new Set()).fields.map((e) => e.field.id)).not.toContain(F.notes)
  })

  it('H-06 a required column the actor cannot fill blocks the dialog (counted, never named); an extra required column is appended', () => {
    const hiddenName = { ...PERMS, [F.name]: { visible: false, readOnly: true } }
    const blocked = resolveManualRowDialogPlan(BLOCK, FIELDS, hiddenName, new Set())
    expect(blocked.fields.map((e) => e.field.id)).not.toContain(F.name)
    expect(blocked.blockedRequiredCount).toBe(1)
    const extra: MetaField = { id: 'fld_mr_ext', name: '扩展必填', type: 'string' }
    const withExtra = resolveManualRowDialogPlan({ ...BLOCK, requiredFieldIds: [...BLOCK.requiredFieldIds, extra.id] }, [...FIELDS, extra], { ...PERMS, [extra.id]: { visible: true, readOnly: false } }, new Set())
    expect(withExtra.fields.at(-1)).toEqual({ field: extra, required: true })
    // A required column of a type the dialog cannot render (a link) blocks it as well.
    const link: MetaField = { id: 'fld_mr_link', name: '关联', type: 'link' }
    expect(resolveManualRowDialogPlan({ ...BLOCK, requiredFieldIds: [link.id] }, [...FIELDS, link], { [link.id]: { visible: true, readOnly: false } }, new Set()).blockedRequiredCount).toBe(1)
    // An older server without dialogFieldIds: the required columns, then the editable ones.
    expect(resolveManualRowDialogPlan({ ...BLOCK, dialogFieldIds: [] }, FIELDS, PERMS, new Set()).fields.map((e) => e.field.id)).toEqual([F.name, F.total, F.spec, F.raw])
  })

  it('H-07 the note per state: only `allowed` is the entry; lock_missing carries 「需管理员修复本表」; an unknown reason a generic text', () => {
    expect(manualRowsNoticeOf(BLOCK)).toEqual({ kind: 'entry' })
    expect(manualRowsNoticeOf({ ...BLOCK, state: 'disabled' })).toEqual({ kind: 'reason', key: 'reason.disabled' })
    expect(manualRowsNoticeOf({ ...BLOCK, state: 'unavailable', reason: 'lock_missing' })).toEqual({ kind: 'reason', key: 'reason.lockMissing', headlineKey: 'reason.lockMissingHeadline' })
    expect(manualRowsNoticeOf({ ...BLOCK, state: 'unavailable', reason: 'project_archived' })).toEqual({ kind: 'reason', key: 'reason.projectArchived' })
    expect(manualRowsNoticeOf({ ...BLOCK, state: 'unavailable', reason: 'project_sheets_off' })).toEqual({ kind: 'reason', key: 'reason.projectSheetsOff' })
    expect(manualRowsNoticeOf({ ...BLOCK, state: 'unavailable', reason: 'contract_mismatch' })).toEqual({ kind: 'reason', key: 'reason.contractMismatch' })
    expect(manualRowsNoticeOf({ ...BLOCK, state: 'unavailable', reason: 'registry_unreadable' })).toEqual({ kind: 'reason', key: 'reason.registryUnreadable' })
    expect(manualRowsNoticeOf({ ...BLOCK, state: 'unavailable', reason: 'a_future_reason' })).toEqual({ kind: 'reason', key: 'reason.unavailable' })
    expect(manualRowsCreateRefusalKey(BLOCK)).toBe('notice.useManualRow')
    expect(manualRowsCreateRefusalKey({ ...BLOCK, state: 'unavailable', reason: 'lock_missing' })).toBe('reason.lockMissing')
  })
})

// ── R. useMultitableGrid — the route choice ──────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const MANUAL_ACTIONS: MetaRowActions = { canEdit: true, canDelete: true, canComment: true, manualSupplement: true }

function viewPayload(rows: MetaRecord[]) {
  return {
    ok: true,
    data: {
      fields: FIELDS,
      rows,
      page: { offset: 0, limit: 50, total: rows.length, hasMore: false },
      meta: { permissions: { fieldPermissions: PERMS, rowActions: { canEdit: true, canDelete: true, canComment: true }, rowActionOverrides: { rec_mr_manual: MANUAL_ACTIONS } } },
    },
  }
}

function createRoutedGrid(options: { nameValue?: unknown } = {}) {
  const versions: Record<string, number> = { rec_mr_manual: 3, rec_mr_plm: 5 }
  const rows = (): MetaRecord[] => [
    { id: 'rec_mr_manual', version: versions.rec_mr_manual, data: { [F.name]: options.nameValue ?? 'Synthetic part', [F.spec]: 'SPEC-A', [F.notes]: '' } },
    { id: 'rec_mr_plm', version: versions.rec_mr_plm, data: { [F.name]: 'PLM part', [F.spec]: 'SPEC-P', [F.notes]: '' } },
  ]
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = String(init?.method ?? 'GET')
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method, body })
    const manual = /\/api\/multitable\/records\/([^/]+)\/manual-fields$/.exec(url)
    if (manual && method === 'PATCH') {
      const recordId = decodeURIComponent(manual[1])
      versions[recordId] += 1
      return jsonResponse({ ok: true, data: { updated: [{ recordId, version: versions[recordId] }], records: [{ recordId, data: body.data }] } })
    }
    if (url.endsWith('/api/multitable/patch') && method === 'POST') {
      const updated = (body.changes as Array<{ recordId: string }>).map((change) => {
        versions[change.recordId] += 1
        return { recordId: change.recordId, version: versions[change.recordId] }
      })
      return jsonResponse({ ok: true, data: { updated } })
    }
    return jsonResponse(viewPayload(rows()))
  })
  const manualCells = ref<Record<string, ManualCellWrite>>({ [`rec_mr_manual:${F.spec}`]: { required: false }, [`rec_mr_manual:${F.name}`]: { required: true } })
  const grid = useMultitableGrid({
    sheetId: ref('sheet_mr'),
    viewId: ref('view_mr'),
    client: new MultitableApiClient({ fetchFn }),
    resolveManualCellWrite: (recordId, fieldId) => manualCells.value[`${recordId}:${fieldId}`] ?? null,
  })
  const writes = () => calls.filter((call) => call.method !== 'GET')
  return { grid, calls, writes, manualCells }
}

async function loaded(grid: ReturnType<typeof useMultitableGrid>) {
  await vi.waitFor(() => expect(grid.rows.value).toHaveLength(2))
}

describe('R — useMultitableGrid writes a manual cell through PATCH …/manual-fields', () => {
  beforeEach(() => useLocale().setLocale('en'))

  it('R-01 patchCell on a fillable cell of a manual row: the manual route with the row\'s version; /patch is not called; the version the server returned is reported', async () => {
    const { grid, writes } = createRoutedGrid()
    await loaded(grid)
    const onCommitted = vi.fn()
    const failure = await grid.patchCell('rec_mr_manual', F.spec, 'SPEC-B', 3, { onCommitted })
    expect(failure).toBeNull()
    expect(writes()).toEqual([{
      url: '/api/multitable/records/rec_mr_manual/manual-fields',
      method: 'PATCH',
      body: { sheetId: 'sheet_mr', expectedVersion: 3, data: { [F.spec]: 'SPEC-B' } },
    }])
    expect(onCommitted).toHaveBeenCalledWith(4)
    expect(grid.rows.value.find((row) => row.id === 'rec_mr_manual')!.version).toBe(4)
    expect(grid.editHistory.value.at(-1)).toMatchObject({ recordId: 'rec_mr_manual', fieldId: F.spec, oldValue: 'SPEC-A', newValue: 'SPEC-B', route: 'manual' })
  })

  it('R-02 every other cell keeps going through /patch, and its history entry is the old shape (no route key)', async () => {
    const { grid, writes } = createRoutedGrid()
    await loaded(grid)
    await grid.patchCell('rec_mr_plm', F.notes, 'note', 5)
    expect(writes()).toEqual([{
      url: '/api/multitable/patch',
      method: 'POST',
      body: { sheetId: 'sheet_mr', viewId: 'view_mr', changes: [{ recordId: 'rec_mr_plm', fieldId: F.notes, value: 'note', expectedVersion: 5 }] },
    }])
    expect('route' in grid.editHistory.value.at(-1)!).toBe(false)
  })

  it('R-03 undo and redo replay a manual edit through the SAME route (N12), each with the row\'s current version', async () => {
    const { grid, writes } = createRoutedGrid()
    await loaded(grid)
    await grid.patchCell('rec_mr_manual', F.spec, 'SPEC-B', 3)
    await grid.undo()
    await grid.redo()
    const [, undo, redo] = writes()
    expect(undo).toEqual({ url: '/api/multitable/records/rec_mr_manual/manual-fields', method: 'PATCH', body: { sheetId: 'sheet_mr', expectedVersion: 4, data: { [F.spec]: 'SPEC-A' } } })
    expect(redo).toEqual({ url: '/api/multitable/records/rec_mr_manual/manual-fields', method: 'PATCH', body: { sheetId: 'sheet_mr', expectedVersion: 5, data: { [F.spec]: 'SPEC-B' } } })
    expect(writes().some((call) => call.url.endsWith('/api/multitable/patch'))).toBe(false)
  })

  it('R-04 a manual entry whose cell can no longer take the route is DROPPED on undo — never replayed to /patch', async () => {
    const { grid, writes, manualCells } = createRoutedGrid()
    await loaded(grid)
    await grid.patchCell('rec_mr_manual', F.spec, 'SPEC-B', 3)
    expect(grid.canUndo.value).toBe(true)
    manualCells.value = {} // the block went away (another sheet state / the row is no longer a manual row)
    const before = writes().length
    await grid.undo()
    expect(writes()).toHaveLength(before) // no request at all
    expect(grid.editHistory.value).toHaveLength(0)
    expect(grid.canUndo.value).toBe(false)
  })

  it('R-05 the same for redo: the entry is dropped, nothing is sent', async () => {
    const { grid, writes, manualCells } = createRoutedGrid()
    await loaded(grid)
    await grid.patchCell('rec_mr_manual', F.spec, 'SPEC-B', 3)
    await grid.undo()
    manualCells.value = {}
    const before = writes().length
    await grid.redo()
    expect(writes()).toHaveLength(before)
    expect(grid.canRedo.value).toBe(false)
  })

  it('R-06 an edit whose undo would CLEAR a required column (名称 / 总用量: the route refuses it) never enters the undo stack', async () => {
    const { grid } = createRoutedGrid({ nameValue: '' })
    await loaded(grid)
    await grid.patchCell('rec_mr_manual', F.name, 'Named now', 3)
    expect(grid.editHistory.value).toHaveLength(0)
    // A required column whose old value is not empty is undoable as usual.
    await grid.patchCell('rec_mr_manual', F.name, 'Renamed', 4)
    expect(grid.editHistory.value).toHaveLength(1)
  })
})

// ── G. MetaGridTable ─────────────────────────────────────────────────────────────────────────────────────────

type GridState = {
  rows: MetaRecord[]
  canEdit: boolean
  fieldReadOnlyIds: string[]
  rowActionOverrides: Record<string, MetaRowActions>
  manualRowRecordIds: string[]
  manualRowFieldIds: string[]
}

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount(); app = null
  container?.remove(); container = null
  vi.unstubAllEnvs()
  useLocale().setLocale('en')
})

function gridRows(): MetaRecord[] {
  return [
    { id: 'rec_mr_manual', version: 3, data: { [F.name]: 'Synthetic part', [F.spec]: 'SPEC-A', [F.notes]: 'n' } },
    { id: 'rec_mr_plm', version: 5, data: { [F.name]: 'PLM part', [F.spec]: 'SPEC-P', [F.notes]: 'n' } },
  ]
}
const GRID_FIELDS = [FIELDS[0], FIELDS[2], FIELDS[4]] // 名称 (locked), 组件规格 (locked), 备注

async function mountGrid(overrides: Partial<GridState> = {}) {
  const patchCell = vi.fn()
  const commitRange = vi.fn(async (_changes: RangeChange[]) => {})
  const state = reactive<GridState>({
    rows: gridRows(),
    canEdit: true,
    fieldReadOnlyIds: [F.name, F.spec],
    rowActionOverrides: { rec_mr_manual: MANUAL_ACTIONS },
    manualRowRecordIds: ['rec_mr_manual'],
    manualRowFieldIds: [F.name, F.spec],
    ...overrides,
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    setup: () => () => h(MetaGridTable, {
      ...state, visibleFields: GRID_FIELDS, sortRules: [], loading: false, currentPage: 1, totalPages: 1, startIndex: 0,
      canDelete: true, canBulkEdit: true, enableMultiSelect: true, canComment: false, searchText: '', rowDensity: 'normal',
      rangeContextKey: 'sheet_mr:view_mr', commitRange,
      'onPatch-cell': patchCell,
    }),
  })
  app.mount(container)
  await nextTick()
  const root = container
  const cell = (row: number, col: number) => {
    const rowsEls = root.querySelectorAll('tbody tr.meta-grid__row')
    return rowsEls[row]!.querySelectorAll('.meta-grid__cell')[col] as HTMLElement
  }
  return { root, state, patchCell, commitRange, cell }
}

async function flushUi() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}
const editorInput = (root: HTMLElement) => root.querySelector('.meta-cell-editor__input') as HTMLInputElement | null
function dblclick(cell: HTMLElement) {
  cell.click()
  cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
}

describe('G — MetaGridTable on a project sheet with manual rows', () => {
  it('G-01 the 「人工补充」 label sits at the head of the manual row only (zh), and reaches a reader too', async () => {
    useLocale().setLocale('zh-CN')
    const grid = await mountGrid({ canEdit: false, rowActionOverrides: { rec_mr_manual: { ...MANUAL_ACTIONS, canEdit: false, canDelete: false } }, manualRowRecordIds: [], manualRowFieldIds: [] })
    const tags = grid.root.querySelectorAll('[data-test="row-manual-supplement-tag"]')
    expect(tags).toHaveLength(1)
    expect(tags[0].textContent?.trim()).toBe('人工补充')
    expect(tags[0].closest('tr')?.querySelectorAll('.meta-grid__cell')[0].textContent).toContain('Synthetic part')
  })

  it('G-02 a fillable cell of a manual row opens as a single-cell editor and commits through patch-cell; the PLM row\'s same column stays closed', async () => {
    const grid = await mountGrid()
    expect(grid.cell(0, 1).classList.contains('meta-grid__cell--readonly')).toBe(false)
    expect(grid.cell(1, 1).classList.contains('meta-grid__cell--readonly')).toBe(true)
    dblclick(grid.cell(1, 1))
    await flushUi()
    expect(editorInput(grid.root)).toBeNull()

    dblclick(grid.cell(0, 1))
    await flushUi()
    const input = editorInput(grid.root)!
    expect(input).toBeTruthy()
    input.value = 'SPEC-B'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushUi()
    expect(grid.patchCell).toHaveBeenCalledWith('rec_mr_manual', F.spec, 'SPEC-B', 3)
  })

  it('G-03 N2: the row mark alone opens nothing — without the workbench\'s lists (no block) the manual row\'s fillable cells stay read-only', async () => {
    const grid = await mountGrid({ manualRowRecordIds: [], manualRowFieldIds: [] })
    expect(grid.root.querySelectorAll('[data-test="row-manual-supplement-tag"]')).toHaveLength(1) // still labelled
    expect(grid.cell(0, 1).classList.contains('meta-grid__cell--readonly')).toBe(true)
    dblclick(grid.cell(0, 1))
    await flushUi()
    expect(editorInput(grid.root)).toBeNull()
  })

  it('G-04 a column the workbench did not name (e.g. 唯一键, or one the actor may not write) stays closed on the manual row', async () => {
    const grid = await mountGrid({ manualRowFieldIds: [F.spec] })
    dblclick(grid.cell(0, 0))
    await flushUi()
    expect(editorInput(grid.root)).toBeNull()
  })

  it('G-05 the row\'s own lock and canEdit still win over the override', async () => {
    const locked = await mountGrid({ rows: gridRows().map((row) => (row.id === 'rec_mr_manual' ? { ...row, locked: true } : row)) })
    dblclick(locked.cell(0, 1))
    await flushUi()
    expect(editorInput(locked.root)).toBeNull()
    app?.unmount(); app = null; container?.remove(); container = null
    const noEdit = await mountGrid({ rowActionOverrides: { rec_mr_manual: { ...MANUAL_ACTIONS, canEdit: false } } })
    dblclick(noEdit.cell(0, 1))
    await flushUi()
    expect(editorInput(noEdit.root)).toBeNull()
  })

  it('G-06 range fill keeps treating a manual row\'s fillable cells as read-only (ADR §3.4): only the human column is written', async () => {
    vi.stubEnv('VITE_MULTITABLE_RANGE_FILL_ENABLED', 'true')
    const grid = await mountGrid({ rows: [...gridRows(), { id: 'rec_mr_manual_2', version: 2, data: { [F.name]: 'Second', [F.spec]: 'SPEC-C', [F.notes]: 'm' } }], rowActionOverrides: { rec_mr_manual: MANUAL_ACTIONS, rec_mr_manual_2: MANUAL_ACTIONS }, manualRowRecordIds: ['rec_mr_manual', 'rec_mr_manual_2'] })
    const rangeCell = (row: number, col: number) => grid.root.querySelector<HTMLElement>(`[data-range-row="${row}"][data-range-col="${col}"]`)!
    const mouse = async (target: HTMLElement, type: string) => {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }))
      await nextTick()
    }
    await mouse(rangeCell(0, 1), 'mousedown')
    await mouse(rangeCell(0, 2), 'mouseenter')
    await mouse(rangeCell(0, 2), 'mouseup')
    await mouse(grid.root.querySelector<HTMLElement>('[data-test="range-fill-handle"]')!, 'mousedown')
    await mouse(rangeCell(2, 2), 'mouseenter')
    await mouse(rangeCell(2, 2), 'mouseup')
    await vi.waitFor(() => expect(grid.commitRange).toHaveBeenCalledTimes(1))
    const sent = grid.commitRange.mock.calls[0][0] as RangeChange[]
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.every((change) => change.fieldId === F.notes)).toBe(true)
  })

  // ADR §3.4 / §8 B3.4: 「区域填充和粘贴仍按只读处理」 — a paste onto the FOCUSED cell included, although single-cell editing
  // of the same cell is open (G-02). Native paste event; the range fill flag is off, so this is the focused-cell path.
  function pasteEvent(text: string): Event {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => (type === 'text/plain' ? text : '') } })
    return event
  }

  it('G-07 a paste onto the focused fillable cell of a manual row writes nothing (paste stays read-only)', async () => {
    const grid = await mountGrid()
    grid.cell(0, 1).click()
    const gridEl = grid.root.querySelector<HTMLElement>('.meta-grid')!
    gridEl.focus()
    await flushUi()
    gridEl.dispatchEvent(pasteEvent('PASTED'))
    await flushUi()
    expect(grid.patchCell).not.toHaveBeenCalled()
  })

  it('G-08 control: the same paste onto 备注 of the same manual row IS written (the paste reaches the grid)', async () => {
    const grid = await mountGrid()
    grid.cell(0, 2).click()
    const gridEl = grid.root.querySelector<HTMLElement>('.meta-grid')!
    gridEl.focus()
    await flushUi()
    gridEl.dispatchEvent(pasteEvent('PASTED'))
    await flushUi()
    expect(grid.patchCell).toHaveBeenCalledWith('rec_mr_manual', F.notes, 'PASTED', 3)
  })
})
