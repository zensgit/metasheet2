/**
 * Re-judge of PR #6083 (must-fix): the grid-side half of the "no edit lockout" defence, in isolation.
 *
 * `MetaGridTable` blocks a cell switch while its editor reports an invalid dateTime draft. If that editor is
 * torn down by something else (page change, filter, sort under virtualization, row delete, hide-field, view
 * switch) the flag could outlive it and lock the grid out of edit mode. The real editor also reports `false`
 * on unmount — which would hide a broken grid-side guard from the end-to-end spec. So THIS file replaces
 * MetaCellEditor with a stub that reports `true` on mount and NEVER reports back, and asserts the grid still
 * recovers on its own: it blocks only while the editor's input is actually on screen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, onMounted, reactive } from 'vue'

vi.mock('../src/multitable/components/cells/MetaCellEditor.vue', () => ({
  default: defineComponent({
    name: 'MetaCellEditorStub',
    props: { field: { type: Object, required: true }, modelValue: { type: null, default: null }, hostCommitPolicy: { type: String, default: 'none' } },
    emits: ['update:modelValue', 'update:invalidDraft', 'confirm', 'cancel', 'blur-commit', 'tab-commit', 'yjs-commit', 'open-link-picker', 'open-person-picker', 'ai-run'],
    setup(props, { emit }) {
      // A dateTime editor whose draft is already invalid — and which is never given the chance to say so
      // on the way out (no onBeforeUnmount emit here, on purpose).
      onMounted(() => {
        if ((props.field as { type: string }).type === 'dateTime') emit('update:invalidDraft', true)
      })
      return () => h('div', { class: 'meta-cell-editor' }, [
        h('input', {
          class: 'meta-cell-editor__input',
          type: 'text',
          'data-stub-editor': (props.field as { id: string }).id,
          ...((props.field as { type: string }).type === 'dateTime' ? { 'data-meta-datetime-input': '' } : {}),
        }),
      ])
    },
  }),
}))

import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'

const dtField = { id: 'fld_dt', name: 'When', type: 'dateTime' } as MetaField
const nameField = { id: 'fld_name', name: 'Name', type: 'string' } as MetaField

async function flushUi(cycles = 3) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function mountGrid(patchSpy: ReturnType<typeof vi.fn>) {
  const state = reactive({
    rows: [
      { id: 'r1', version: 1, data: { fld_name: 'a', fld_dt: '2026-09-24T01:00:00.000Z' } },
      { id: 'r2', version: 1, data: { fld_name: 'b', fld_dt: null } },
    ] as MetaRecord[],
    fields: [dtField, nameField] as MetaField[],
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    render: () => h(MetaGridTable, {
      rows: state.rows,
      visibleFields: state.fields,
      sortRules: [],
      loading: false,
      currentPage: 1,
      totalPages: 1,
      startIndex: 0,
      selectedRecordId: null,
      canEdit: true,
      canDelete: true,
      onPatchCell: patchSpy,
    }),
  })
  app.mount(container)
  return { state, container, unmount: () => { app.unmount(); container.remove() } }
}

const cellAt = (root: HTMLElement, r: number, c: number) =>
  root.querySelectorAll('tbody tr.meta-grid__row')[r]!.querySelectorAll('.meta-grid__cell')[c] as HTMLElement
const stubEditor = (root: HTMLElement, fieldId?: string) =>
  root.querySelector(fieldId ? `[data-stub-editor="${fieldId}"]` : '[data-stub-editor]')

async function armInvalidDraft(root: HTMLElement) {
  const dtCell = cellAt(root, 0, 0)
  dtCell.click()
  dtCell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  await flushUi()
  expect(stubEditor(root, 'fld_dt')).not.toBeNull()
  // The guard is armed and working: a click on another cell keeps the flagged editor mounted.
  cellAt(root, 1, 1).click()
  await flushUi()
  expect(stubEditor(root, 'fld_dt')).not.toBeNull()
}

describe('grid never locks out of edit mode when a flagged dateTime editor is torn down (grid-side guard alone)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('the editing ROW leaves the rendered set (page change / filter / delete): click + double-click opens an editor again', async () => {
    const patchSpy = vi.fn()
    const grid = mountGrid(patchSpy)
    await flushUi()
    await armInvalidDraft(grid.container)

    grid.state.rows = grid.state.rows.filter((row) => row.id === 'r2')
    await flushUi()
    expect(stubEditor(grid.container)).toBeNull() // torn down without ever reporting false

    const target = cellAt(grid.container, 0, 1) // r2 / Name
    target.click()
    await flushUi()
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flushUi()
    expect(stubEditor(grid.container, 'fld_name')).not.toBeNull()
    expect(patchSpy).not.toHaveBeenCalled()
    grid.unmount()
  })

  it('the editing FIELD is hidden: double-click on another cell opens an editor again', async () => {
    const patchSpy = vi.fn()
    const grid = mountGrid(patchSpy)
    await flushUi()
    await armInvalidDraft(grid.container)

    grid.state.fields = [nameField]
    await flushUi()
    expect(stubEditor(grid.container)).toBeNull()

    const target = cellAt(grid.container, 0, 0) // r1 / Name (now the only column)
    target.click()
    await flushUi()
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flushUi()
    expect(stubEditor(grid.container, 'fld_name')).not.toBeNull()
    expect(patchSpy).not.toHaveBeenCalled() // the staged value was the stored one — nothing to commit
    grid.unmount()
  })

  it('double-click straight onto another cell (no prior click) is recovered the same way', async () => {
    const patchSpy = vi.fn()
    const grid = mountGrid(patchSpy)
    await flushUi()
    await armInvalidDraft(grid.container)
    grid.state.rows = grid.state.rows.filter((row) => row.id === 'r2')
    await flushUi()
    const target = cellAt(grid.container, 0, 1)
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flushUi()
    expect(stubEditor(grid.container, 'fld_name')).not.toBeNull()
    grid.unmount()
  })
})
