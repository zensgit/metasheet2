// B1-e: MetaRecordDrawer button-field cell render + click→run-button emit,
// mirroring the B1-b grid behavior (multitable-cell-button.spec.ts). The drawer
// has its OWN per-field-type render chain (NOT MetaCellRenderer), so this asserts
// the drawer renders the button and surfaces the run intent up to the workbench.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaRecordDrawer from '../src/multitable/components/MetaRecordDrawer.vue'
import type { MetaField } from '../src/multitable/types'

let app: App<Element> | null = null
let container: HTMLDivElement | null = null
afterEach(() => { app?.unmount(); app = null; container?.remove(); container = null })

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) { await Promise.resolve(); await nextTick() }
}

const buttonField = (property: Record<string, unknown> = {}): MetaField =>
  ({ id: 'f_btn', name: 'Do it', type: 'button', property } as unknown as MetaField)

async function mount(field: MetaField, extra: Record<string, unknown> = {}) {
  const runs: Array<{ recordId: string; field: MetaField }> = []
  container = document.createElement('div'); document.body.appendChild(container)
  app = createApp({
    setup: () => () => h(MetaRecordDrawer, {
      visible: true,
      record: { id: 'rec_1', version: 1, data: {} },
      fields: [field],
      canEdit: true,
      canComment: false,
      canDelete: false,
      onRunButton: (payload: { recordId: string; field: MetaField }) => runs.push(payload),
      ...extra,
    }),
  })
  app.mount(container)
  await flushUi()
  return { runs, btn: () => container!.querySelector<HTMLButtonElement>('[data-test="drawer-button"]')! }
}

describe('MetaRecordDrawer — button field (B1-e)', () => {
  it('renders a button with the property label + variant class', async () => {
    const { btn } = await mount(buttonField({ label: 'Approve', variant: 'primary' }))
    expect(btn()).not.toBeNull()
    expect(btn().textContent?.trim()).toBe('Approve')
    expect(btn().classList.contains('meta-record-drawer__button--primary')).toBe(true)
    expect(btn().getAttribute('aria-label')).toBe('Approve')
  })

  it('falls back to the field name when label is empty (non-empty accessible name)', async () => {
    const { btn } = await mount(buttonField({}))
    expect(btn().textContent?.trim()).toBe('Do it')
    expect(btn().getAttribute('aria-label')).toBe('Do it')
    // unknown/empty variant → secondary default (mirrors resolveButtonFieldProperty)
    expect(btn().classList.contains('meta-record-drawer__button--secondary')).toBe(true)
  })

  it('renders the button even though it is NOT an editable field (action, not value)', async () => {
    // canEdit is true but a button is never gated on canEditField; render on field-visible.
    const { btn } = await mount(buttonField({ label: 'Run' }))
    expect(btn()).not.toBeNull()
    // It is a <button>, not the read-only text span.
    expect(container!.querySelector('.meta-record-drawer__text')).toBeNull()
  })

  it('emits run-button { recordId, field } on click', async () => {
    const field = buttonField({ label: 'Go' })
    const { btn, runs } = await mount(field)
    btn().click()
    await flushUi()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.recordId).toBe('rec_1')
    expect(runs[0]!.field.id).toBe('f_btn')
  })

  it('disables the button and emits nothing while its run is pending', async () => {
    const { btn, runs } = await mount(buttonField({ label: 'Go' }), {
      buttonRunPending: ['rec_1:f_btn'],
    })
    expect(btn().disabled).toBe(true)
    btn().click()
    await flushUi()
    expect(runs).toHaveLength(0)
  })

  it('does NOT disable when a different record/field is pending (key match is exact)', async () => {
    const { btn } = await mount(buttonField({ label: 'Go' }), {
      buttonRunPending: ['rec_OTHER:f_btn', 'rec_1:f_other'],
    })
    expect(btn().disabled).toBe(false)
  })
})

// Native person (人员, design 2026-06-16): the drawer renders person display from
// personSummariesByField (userId → name) and edits via an open-person-picker emit (NOT the
// link picker). The drawer uses its OWN render chain (formatFieldDisplay), not MetaCellRenderer.
describe('MetaRecordDrawer — native person field', () => {
  const personField: MetaField = { id: 'fld_owner', name: 'Owner', type: 'person', property: { limitSingleRecord: false } } as unknown as MetaField

  it('resolves person display from personSummariesByField (userId → name)', async () => {
    container = document.createElement('div'); document.body.appendChild(container)
    app = createApp({
      setup: () => () => h(MetaRecordDrawer, {
        visible: true,
        record: { id: 'rec_1', version: 1, data: { fld_owner: ['u1', 'u2'] } },
        fields: [personField],
        canEdit: false, canComment: false, canDelete: false,
        personSummariesByField: { fld_owner: [{ id: 'u1', display: 'Alice' }, { id: 'u2', display: 'Bob' }] },
      }),
    })
    app.mount(container)
    await flushUi()
    expect(container.textContent).toContain('Alice')
    expect(container.textContent).toContain('Bob')
    // raw userId is NOT shown when a summary resolves
    expect(container.textContent).not.toContain('u1')
  })

  it('emits open-person-picker (NOT open-link-picker) when the editable person field is clicked', async () => {
    const personEmits: MetaField[] = []
    const linkEmits: MetaField[] = []
    container = document.createElement('div'); document.body.appendChild(container)
    app = createApp({
      setup: () => () => h(MetaRecordDrawer, {
        visible: true,
        record: { id: 'rec_1', version: 1, data: { fld_owner: [] } },
        fields: [personField],
        canEdit: true, canComment: false, canDelete: false,
        onOpenPersonPicker: (f: MetaField) => personEmits.push(f),
        onOpenLinkPicker: (f: MetaField) => linkEmits.push(f),
      }),
    })
    app.mount(container)
    await flushUi()
    const openBtn = container.querySelector<HTMLButtonElement>('[data-test="drawer-person-picker-open"]')
    expect(openBtn).not.toBeNull()
    openBtn!.click()
    await flushUi()
    expect(personEmits.map((f) => f.id)).toEqual(['fld_owner'])
    expect(linkEmits).toHaveLength(0)
  })
})
