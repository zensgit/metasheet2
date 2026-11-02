/**
 * 人工补充行 B3 (ADR adr-stock-prep-manual-rows-20261030 §3.4: 「Yjs 协作对这些单元格仍按只读处理」) — the editor that opens on a
 * fillable cell of a manual row gets NO record id, so it can never bind a Yjs document (both Yjs bindings in
 * MetaCellEditor require one); its commit is the REST patch the workbench routes to PATCH …/manual-fields. A plain cell's
 * editor keeps its row id. MetaCellEditor is stubbed here (in its own file, so multitable-grid-manual-rows.spec.ts keeps
 * the real editor for its typing / commit cases).
 *
 * Collected by the required web gate through the existing `multitable-grid` token. Synthetic values only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import type { MetaField, MetaRecord, MetaRowActions } from '../src/multitable/types'

const editorAttrs: Array<Record<string, unknown>> = []
vi.mock('../src/multitable/components/cells/MetaCellEditor.vue', () => ({
  default: defineComponent({
    name: 'MetaCellEditor',
    inheritAttrs: false,
    setup(_props, { attrs }) {
      editorAttrs.push({ ...attrs })
      return () => h('div', { class: 'manual-rows-editor-stub' })
    },
  }),
}))

import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'

const LOCK = { humanWriteLock: 'plm_system' }
const F = { name: 'fld_mre_name', spec: 'fld_mre_spec', notes: 'fld_mre_notes' }
const FIELDS: MetaField[] = [
  { id: F.name, name: '名称', type: 'string', property: { ...LOCK } },
  { id: F.spec, name: '组件规格', type: 'string', property: { ...LOCK } },
  { id: F.notes, name: '备注', type: 'string' },
]
const MANUAL_ACTIONS: MetaRowActions = { canEdit: true, canDelete: true, canComment: false, manualSupplement: true }
const rows = (): MetaRecord[] => [
  { id: 'rec_mre_manual', version: 3, data: { [F.name]: 'Synthetic', [F.spec]: 'SPEC-A', [F.notes]: 'n' } },
  { id: 'rec_mre_plm', version: 5, data: { [F.name]: 'PLM', [F.spec]: 'SPEC-P', [F.notes]: 'n' } },
]

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount(); app = null
  container?.remove(); container = null
  editorAttrs.length = 0
})

async function flushUi() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

async function mountGrid() {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    setup: () => () => h(MetaGridTable, {
      rows: rows(), canEdit: true, fieldReadOnlyIds: [F.name, F.spec],
      rowActionOverrides: { rec_mre_manual: MANUAL_ACTIONS },
      manualRowRecordIds: ['rec_mre_manual'], manualRowFieldIds: [F.name, F.spec],
      visibleFields: FIELDS, sortRules: [], loading: false, currentPage: 1, totalPages: 1, startIndex: 0,
      canDelete: true, canBulkEdit: true, enableMultiSelect: true, canComment: false, searchText: '', rowDensity: 'normal',
    }),
  })
  app.mount(container)
  await nextTick()
  const root = container
  return (row: number, col: number) => root.querySelectorAll('tbody tr.meta-grid__row')[row]!.querySelectorAll('.meta-grid__cell')[col] as HTMLElement
}

function openEditor(cell: HTMLElement) {
  cell.click()
  cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
}

describe('MetaGridTable — the editor of a manual row\'s fillable cell never binds Yjs', () => {
  it('a fillable cell of a manual row: the editor opens with NO record id', async () => {
    const cell = await mountGrid()
    openEditor(cell(0, 1))
    await flushUi()
    expect(editorAttrs.length, 'an editor opened on the manual fillable cell').toBeGreaterThan(0)
    const manualEditor = editorAttrs.at(-1)!
    expect(manualEditor['record-id'] ?? manualEditor.recordId ?? null).toBeNull()
  })

  it('control: a plain cell (备注) of the same row gets its row id', async () => {
    const cell = await mountGrid()
    openEditor(cell(0, 2))
    await flushUi()
    expect(editorAttrs.length).toBeGreaterThan(0)
    const plainEditor = editorAttrs.at(-1)!
    expect(plainEditor['record-id'] ?? plainEditor.recordId).toBe('rec_mre_manual')
  })
})
