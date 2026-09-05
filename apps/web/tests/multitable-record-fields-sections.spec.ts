/**
 * Record inspector v3 (2026-09-05, docs/development/multitable-record-inspector-v3-design-20260905.md
 * §1.3 body + §3 "PR-B" B1): the details tab's field list, post-B1. Covers, in order of the design's own
 * B1 test list:
 *   - SECTIONS via the optional `inspectorFieldLayout` prop: order follows `ordered` (not `fields`);
 *     "hidden in this view" collapsed by default, heading count through `recordHiddenFieldsHeading`,
 *     `aria-expanded` toggles + `aria-controls` resolves; §1 headerless while §2 is empty; the N3
 *     negative golden (a property-hidden field present in `fields` does NOT render on this path, with a
 *     positive control proving the assertion is not vacuous); the layer-3 mask and the ordered/hidden
 *     de-duplication on the same path; absent prop → rendered ids identical to `fields` (legacy path).
 *   - HIDE EMPTY: hides exactly the `isEmptyValue`-empty fields; five exemption positive controls
 *     (`<exemption> + empty value + hide-empty ON ⇒ still rendered`), each paired with the control that
 *     proves the clause is load-bearing; the snapshot semantic (a value cleared mid-edit stays; a
 *     record-id change re-snapshots; toggle off shows everything); inspector-owned state resets on
 *     remount and the toggle exists on the details tab only.
 *   - GLYPH ⇔ PREDICATE agreement over the full value × field-type fixture set (one definition).
 *   - LINK CHIPS (HI-1): clickable iff `fetchRecord` is passed and the click opens the popover with the
 *     SAME record id; dropping the prop → non-clickable chips and zero fetches; INS threads the prop
 *     through; the fields panel's own source still makes no fetch/client call.
 *   - COPY LINK (inspector side): the icon is disabled when the Clipboard API is absent, enabled and
 *     emitting `copy-link` once when present; MetaToast (the workbench's status channel) is a polite
 *     live region. The workbench-side write/href/failed assertions live in
 *     multitable-workbench-view.spec.ts ("copy link (§1.3 PR-B1)"), which owns the workbench harness.
 *   - KEYBOARD (FP-local): plain textarea mod+Enter blurs (the native `change` that follows is the ONE
 *     patch — the handler itself emits nothing); bare Enter in the textarea is untouched; Enter on a
 *     single-line control advances focus to the next editable control, Shift+Enter to the previous;
 *     `<select>` is untouched; the last control just blurs.
 *   - GALLERY: the 3-up `@container (min-width: 480px)` rule exists on the attachments wrapper
 *     (source-text provision — jsdom has no container-query layout; the design's real-browser line
 *     owns the layout check).
 *   - TAB ORDER: hide-empty sits after the tablist and before the tabpanel; the splitter stays LAST.
 *
 * i18n discipline: every string assertion reads through `recordLabel` / `recordHiddenFieldsHeading` —
 * the SAME helpers the components call — never a hardcoded copy literal.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App, type VNodeChild } from 'vue'
import MetaRecordFieldsPanel from '../src/multitable/components/MetaRecordFieldsPanel.vue'
import MetaRecordInspector from '../src/multitable/components/MetaRecordInspector.vue'
import type { AiShortcutState } from '../src/multitable/composables/useAiShortcut'
import type {
  MetaField,
  MetaRecord,
  MetaRecordContext,
  MultitableCommentPresenceSummary,
} from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'
import { isEmptyValue } from '../src/multitable/utils/conditional-formatting'
import { formatFieldDisplay } from '../src/multitable/utils/field-display'
import { recordHiddenFieldsHeading, recordLabel } from '../src/multitable/utils/meta-record-labels'
import type { MetaRecordInspectorFieldLayout } from '../src/multitable/utils/recordDisplay'

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function readSrc(rel: string): string {
  return readFileSync(join(__dirname, '..', rel), 'utf8')
}

// --- fixtures -------------------------------------------------------------------------------------

const F_TITLE = { id: 'fld_title', name: 'Title', type: 'string' } as MetaField
const F_NOTES = { id: 'fld_notes', name: 'Notes', type: 'longText' } as MetaField
const F_QTY = { id: 'fld_qty', name: 'Qty', type: 'number' } as MetaField
const F_STATUS = { id: 'fld_status', name: 'Status', type: 'select', options: [{ value: 'todo' }, { value: 'done' }] } as unknown as MetaField
// Layer-2 property-hidden field (isPropertyHiddenField → true). Same id/name shape as a normal field so
// a test can flip ONLY the property to build its positive control.
const F_SECRET_HIDDEN = { id: 'fld_secret', name: 'Secret', type: 'string', property: { hidden: true } } as unknown as MetaField
const F_SECRET_SHOWN = { id: 'fld_secret', name: 'Secret', type: 'string', property: {} } as unknown as MetaField
const F_VENDOR = { id: 'fld_vendor', name: 'Vendor', type: 'link' } as MetaField
const F_FILES = { id: 'fld_files', name: 'Files', type: 'attachment' } as MetaField

function record(id: string, data: Record<string, unknown>): MetaRecord {
  return { id, version: 1, data } as MetaRecord
}

function foreignContext(recordId: string): MetaRecordContext {
  return {
    sheet: { id: 'sheet_vendors', name: 'Vendors' },
    fields: [{ id: 'fld_name', name: 'Vendor Name', type: 'string' }],
    record: { id: recordId, data: { fld_name: 'Acme Supply' } } as MetaRecordContext['record'],
    capabilities: {} as MetaRecordContext['capabilities'],
    commentsScope: {} as MetaRecordContext['commentsScope'],
  } as MetaRecordContext
}

// --- harness ---------------------------------------------------------------------------------------

// The ONE `createApp({ render })` in this file (vue/one-component-per-file counts each such literal);
// every mount routes through it with a render closure over reactive harness state.
const mountedApps: App[] = []
function mountApp(render: () => VNodeChild): { container: HTMLElement; app: App } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render })
  app.mount(container)
  mountedApps.push(app)
  return { container, app }
}

type PanelProps = Record<string, unknown>
function mountPanel(initial: PanelProps): { container: HTMLElement; app: App; set: (patch: PanelProps) => void } {
  const state = ref<PanelProps>({ canEdit: true, canComment: false, ...initial })
  const { container, app } = mountApp(() => h(MetaRecordFieldsPanel, { ...state.value }))
  return { container, app, set: (patch) => { state.value = { ...state.value, ...patch } } }
}

function mountInspector(initial: PanelProps = {}): { container: HTMLElement; app: App; set: (patch: PanelProps) => void } {
  const state = ref<PanelProps>({
    visible: true,
    record: record('rec_1', { fld_title: 'Alpha', fld_notes: '' }),
    fields: [F_TITLE, F_NOTES],
    canEdit: true,
    canComment: false,
    canDelete: false,
    recordIds: ['rec_1'],
    ...initial,
  })
  const { container, app } = mountApp(() => h(MetaRecordInspector, { ...state.value }))
  return { container, app, set: (patch) => { state.value = { ...state.value, ...patch } } }
}

function renderedFieldIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.meta-record-drawer__field'))
    .map((el) => el.dataset.fieldId ?? '')
}

function sectionToggle(container: HTMLElement, key: 'ordered' | 'hidden-in-view'): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[data-testid="record-field-section-toggle-${key}"]`)
}

function stubClipboard(clipboard: { writeText: (text: string) => Promise<void> } | undefined): () => void {
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })
  return () => {
    if (original) Object.defineProperty(navigator, 'clipboard', original)
    else delete (navigator as unknown as Record<string, unknown>).clipboard
  }
}

function keydown(el: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  el.dispatchEvent(event)
  return event
}

afterEach(() => {
  while (mountedApps.length) mountedApps.pop()!.unmount()
  document.body.innerHTML = ''
  useLocale().setLocale('en')
  vi.restoreAllMocks()
})

// =====================================================================================================
describe('sections — inspectorFieldLayout (§1.3 "Sections")', () => {
  it('order follows `ordered`, not `fields` (reversed fixture); §1 is headerless while §2 is empty', async () => {
    const layout: MetaRecordInspectorFieldLayout = { ordered: [F_QTY, F_NOTES, F_TITLE], hiddenInView: [] }
    const { container } = mountPanel({
      record: record('rec_1', { fld_title: 'a', fld_notes: 'b', fld_qty: 3 }),
      fields: [F_TITLE, F_NOTES, F_QTY],
      inspectorFieldLayout: layout,
    })
    await flushUi()
    expect(renderedFieldIds(container)).toEqual(['fld_qty', 'fld_notes', 'fld_title'])
    // §2 empty → §1 renders with NO heading button at all (not a collapsed/expanded state — no disclosure)
    expect(sectionToggle(container, 'ordered')).toBeNull()
    expect(sectionToggle(container, 'hidden-in-view')).toBeNull()
    expect(container.querySelector('[data-section="ordered"]')).not.toBeNull()
    expect(container.querySelector('[data-section="hidden-in-view"]')).toBeNull()
  })

  it('"hidden in this view" is collapsed by default, headed by recordHiddenFieldsHeading(count), and aria-expanded/aria-controls drive its body', async () => {
    const { container } = mountPanel({
      record: record('rec_1', { fld_title: 'a', fld_notes: 'b', fld_qty: 3 }),
      fields: [F_TITLE, F_NOTES, F_QTY],
      inspectorFieldLayout: { ordered: [F_TITLE], hiddenInView: [F_NOTES, F_QTY] },
    })
    await flushUi()
    const toggle = sectionToggle(container, 'hidden-in-view')!
    expect(toggle).not.toBeNull()
    expect(toggle.textContent).toContain(recordHiddenFieldsHeading(2, false))
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // aria-controls names a REAL element even while collapsed (the body stays mounted, `hidden`)
    const bodyId = toggle.getAttribute('aria-controls')!
    expect(bodyId).toBeTruthy()
    const body = document.getElementById(bodyId) as HTMLElement
    expect(body).not.toBeNull()
    expect(body.hidden).toBe(true)
    // collapsed content is NOT in the DOM (not merely display:none) — only §1's field renders
    expect(renderedFieldIds(container)).toEqual(['fld_title'])
    // §2 non-empty → §1 gets its own heading (expanded by default)
    const orderedToggle = sectionToggle(container, 'ordered')!
    expect(orderedToggle).not.toBeNull()
    expect(orderedToggle.textContent).toContain(recordLabel('record.fieldsInView', false))
    expect(orderedToggle.getAttribute('aria-expanded')).toBe('true')

    toggle.click()
    await flushUi()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(body.hidden).toBe(false)
    expect(renderedFieldIds(container)).toEqual(['fld_title', 'fld_notes', 'fld_qty'])

    toggle.click()
    await flushUi()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(renderedFieldIds(container)).toEqual(['fld_title'])
  })

  it('zh heading reads through the same helper', async () => {
    useLocale().setLocale('zh-CN')
    const { container } = mountPanel({
      record: record('rec_1', { fld_title: 'a', fld_notes: 'b' }),
      fields: [F_TITLE, F_NOTES],
      inspectorFieldLayout: { ordered: [F_TITLE], hiddenInView: [F_NOTES] },
    })
    await flushUi()
    expect(sectionToggle(container, 'hidden-in-view')!.textContent).toContain(recordHiddenFieldsHeading(1, true))
    expect(sectionToggle(container, 'ordered')!.textContent).toContain(recordLabel('record.fieldsInView', true))
  })

  it('N3 negative golden: a property-hidden field present in `fields` (and in `ordered`) does NOT render on the sections path', async () => {
    const { container } = mountPanel({
      record: record('rec_1', { fld_title: 'a', fld_secret: 'classified' }),
      fields: [F_TITLE, F_SECRET_HIDDEN],
      inspectorFieldLayout: { ordered: [F_TITLE, F_SECRET_HIDDEN], hiddenInView: [] },
    })
    await flushUi()
    expect(renderedFieldIds(container)).toEqual(['fld_title'])
    expect(container.textContent).not.toContain('Secret')
    expect(container.textContent).not.toContain('classified')
  })

  it('N3 also holds for a property-hidden field handed in via `hiddenInView`', async () => {
    const { container } = mountPanel({
      record: record('rec_1', { fld_title: 'a', fld_secret: 'classified' }),
      fields: [F_TITLE, F_SECRET_HIDDEN],
      inspectorFieldLayout: { ordered: [F_TITLE], hiddenInView: [F_SECRET_HIDDEN] },
    })
    await flushUi()
    // the section itself does not even appear (its only field is masked out)
    expect(sectionToggle(container, 'hidden-in-view')).toBeNull()
    expect(container.textContent).not.toContain('Secret')
  })

  it('N3 positive control: the SAME field without property.hidden renders on the sections path (the golden is not vacuous)', async () => {
    const { container } = mountPanel({
      record: record('rec_1', { fld_title: 'a', fld_secret: 'classified' }),
      fields: [F_TITLE, F_SECRET_SHOWN],
      inspectorFieldLayout: { ordered: [F_TITLE, F_SECRET_SHOWN], hiddenInView: [] },
    })
    await flushUi()
    expect(renderedFieldIds(container)).toEqual(['fld_title', 'fld_secret'])
    expect(container.textContent).toContain('Secret')
  })

  it('layer-3 (fieldPermissions.visible === false) still masks on the sections path, in both lists', async () => {
    const { container } = mountPanel({
      record: record('rec_1', { fld_title: 'a', fld_notes: 'b', fld_qty: 3 }),
      fields: [F_TITLE, F_NOTES, F_QTY],
      fieldPermissions: { fld_notes: { visible: false, readOnly: false }, fld_qty: { visible: false, readOnly: false } },
      inspectorFieldLayout: { ordered: [F_TITLE, F_NOTES], hiddenInView: [F_QTY] },
    })
    await flushUi()
    expect(renderedFieldIds(container)).toEqual(['fld_title'])
    expect(sectionToggle(container, 'hidden-in-view')).toBeNull()
  })

  it('a field named in BOTH lists renders once, in §1 (fail-soft de-duplication)', async () => {
    const { container } = mountPanel({
      record: record('rec_1', { fld_title: 'a', fld_notes: 'b' }),
      fields: [F_TITLE, F_NOTES],
      inspectorFieldLayout: { ordered: [F_TITLE, F_NOTES], hiddenInView: [F_NOTES] },
    })
    await flushUi()
    expect(renderedFieldIds(container)).toEqual(['fld_title', 'fld_notes'])
    expect(sectionToggle(container, 'hidden-in-view')).toBeNull()
  })

  it('absent prop → legacy flat path: rendered ids identical to `fields` (layer-3 only — a property-hidden field still renders there, unchanged)', async () => {
    const { container } = mountPanel({
      record: record('rec_1', { fld_qty: 3, fld_title: 'a', fld_secret: 's', fld_notes: 'b' }),
      fields: [F_QTY, F_TITLE, F_SECRET_HIDDEN, F_NOTES],
    })
    await flushUi()
    expect(renderedFieldIds(container)).toEqual(['fld_qty', 'fld_title', 'fld_secret', 'fld_notes'])
    expect(sectionToggle(container, 'ordered')).toBeNull()
    expect(sectionToggle(container, 'hidden-in-view')).toBeNull()
    expect(container.querySelector('[data-section="flat"]')).not.toBeNull()
  })

  it('absent prop → legacy flat path keeps the layer-3 mask (byte-for-byte with the pre-B1 visibleFields)', async () => {
    const { container } = mountPanel({
      record: record('rec_1', { fld_title: 'a', fld_notes: 'b' }),
      fields: [F_TITLE, F_NOTES],
      fieldPermissions: { fld_notes: { visible: false, readOnly: false } },
    })
    await flushUi()
    expect(renderedFieldIds(container)).toEqual(['fld_title'])
  })
})

// =====================================================================================================
describe('hide-empty (§1.3 "Hide empty")', () => {
  const FIELDS = [F_TITLE, F_NOTES, F_QTY, F_STATUS]
  const DATA = { fld_title: 'Alpha', fld_notes: '', fld_qty: null, fld_status: 'todo' }

  it('hides exactly the isEmptyValue-empty fields (primary exempt), and the toggle OFF shows every field', async () => {
    const { container, set } = mountPanel({ record: record('rec_1', DATA), fields: FIELDS, hideEmpty: true })
    await flushUi()
    const rendered = renderedFieldIds(container)
    expect(rendered).toEqual(['fld_title', 'fld_status'])
    // mechanical tie to the shared predicate: rendered ⇔ (!isEmptyValue(value) || primary)
    for (const field of FIELDS) {
      const expected = !isEmptyValue((DATA as Record<string, unknown>)[field.id]) || field.id === FIELDS[0].id
      expect(rendered.includes(field.id)).toBe(expected)
    }
    set({ hideEmpty: false })
    await flushUi()
    expect(renderedFieldIds(container)).toEqual(['fld_title', 'fld_notes', 'fld_qty', 'fld_status'])
  })

  it('applies on the sections path too, and the hidden-section heading count follows the filtered set', async () => {
    const { container } = mountPanel({
      record: record('rec_1', DATA),
      fields: FIELDS,
      hideEmpty: true,
      inspectorFieldLayout: { ordered: [F_TITLE, F_NOTES], hiddenInView: [F_QTY, F_STATUS] },
    })
    await flushUi()
    // §2 keeps only the non-empty status field → count 1
    expect(sectionToggle(container, 'hidden-in-view')!.textContent).toContain(recordHiddenFieldsHeading(1, false))
    sectionToggle(container, 'hidden-in-view')!.click()
    await flushUi()
    expect(renderedFieldIds(container)).toEqual(['fld_title', 'fld_status'])
  })

  // ---- exemption positive controls: <condition> + empty value + hide-empty ON ⇒ still rendered ----

  it('exemption (1) primary field: an EMPTY primary field stays rendered; the same field NOT at position 0 is hidden', async () => {
    const a = mountPanel({ record: record('rec_1', { fld_title: '', fld_notes: 'x' }), fields: [F_TITLE, F_NOTES], hideEmpty: true })
    await flushUi()
    expect(renderedFieldIds(a.container)).toEqual(['fld_title', 'fld_notes'])
    a.app.unmount()
    // control: reorder so `fld_notes` is primary → empty `fld_title` is no longer exempt
    const b = mountPanel({ record: record('rec_1', { fld_title: '', fld_notes: 'x' }), fields: [F_NOTES, F_TITLE], hideEmpty: true })
    await flushUi()
    expect(renderedFieldIds(b.container)).toEqual(['fld_notes'])
  })

  it('exemption (2) focused field: an EMPTY focused field stays rendered when hide-empty turns on; it hides once focus leaves', async () => {
    const { container, set } = mountPanel({ record: record('rec_1', { fld_title: 'a', fld_notes: '' }), fields: [F_TITLE, F_NOTES], hideEmpty: false })
    await flushUi()
    const textarea = container.querySelector<HTMLTextAreaElement>('#drawer_field_fld_notes')!
    textarea.focus()
    expect(document.activeElement).toBe(textarea)
    set({ hideEmpty: true })
    await flushUi()
    // empty AND in the snapshot, but focused → exempt → still rendered, focus intact
    expect(renderedFieldIds(container)).toEqual(['fld_title', 'fld_notes'])
    expect(document.activeElement).toBe(textarea)
    // control: leave the field (focus goes to the body, outside the panel) → the exemption lifts
    textarea.blur()
    await flushUi()
    expect(renderedFieldIds(container)).toEqual(['fld_title'])
  })

  it('exemption (3) AI status: an EMPTY field with a pending AI run stays rendered; without it the same field is hidden', async () => {
    const aiPending = {
      pending: { kind: 'run', recordId: 'rec_1', fieldId: 'fld_notes' },
      result: null,
      error: null,
      retryRemainingMs: null,
    } as unknown as AiShortcutState
    const a = mountPanel({ record: record('rec_1', { fld_title: 'a', fld_notes: '' }), fields: [F_TITLE, F_NOTES], hideEmpty: true, aiShortcut: aiPending })
    await flushUi()
    expect(renderedFieldIds(a.container)).toEqual(['fld_title', 'fld_notes'])
    expect(a.container.querySelector('[data-ai-status="fld_notes"]')).not.toBeNull()
    a.app.unmount()
    const b = mountPanel({ record: record('rec_1', { fld_title: 'a', fld_notes: '' }), fields: [F_TITLE, F_NOTES], hideEmpty: true, aiShortcut: null })
    await flushUi()
    expect(renderedFieldIds(b.container)).toEqual(['fld_title'])
  })

  it('exemption (4) comment presence: an EMPTY field with unresolved comments stays rendered; without presence it is hidden', async () => {
    const presence = { fieldCounts: { fld_notes: 1 }, mentionedFieldCounts: {} } as unknown as MultitableCommentPresenceSummary
    const a = mountPanel({ record: record('rec_1', { fld_title: 'a', fld_notes: '' }), fields: [F_TITLE, F_NOTES], hideEmpty: true, canComment: true, commentPresence: presence })
    await flushUi()
    expect(renderedFieldIds(a.container)).toEqual(['fld_title', 'fld_notes'])
    // the same predicate paints the anchor active — the exemption reuses it, not a second count read
    expect(a.container.querySelector('[data-comment-field="fld_notes"]')?.className).toContain('meta-record-drawer__comment-anchor--active')
    a.app.unmount()
    const b = mountPanel({ record: record('rec_1', { fld_title: 'a', fld_notes: '' }), fields: [F_TITLE, F_NOTES], hideEmpty: true, canComment: true, commentPresence: null })
    await flushUi()
    expect(renderedFieldIds(b.container)).toEqual(['fld_title'])
  })

  it('exemption (5) pending server error: an EMPTY attachment field whose upload was rejected stays rendered; without the error it is hidden', async () => {
    const uploadFn = vi.fn().mockRejectedValue(new Error('storage quota exceeded'))
    const { container, set } = mountPanel({ record: record('rec_1', { fld_title: 'a', fld_files: [] }), fields: [F_TITLE, F_FILES], hideEmpty: false, uploadFn })
    await flushUi()
    const input = container.querySelector<HTMLInputElement>('.meta-record-drawer__file-input')!
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'a.txt', { type: 'text/plain' })], configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    expect(uploadFn).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.meta-record-drawer__error')?.textContent).toContain('storage quota exceeded')
    set({ hideEmpty: true })
    await flushUi()
    // value is still [] (empty, in the snapshot) but the server error is pending → exempt
    expect(renderedFieldIds(container)).toEqual(['fld_title', 'fld_files'])
    // control: a clean re-snapshot with no error hides it
    set({ hideEmpty: false })
    await flushUi()
    set({ record: record('rec_2', { fld_title: 'a', fld_files: [] }), hideEmpty: true })
    await flushUi()
    expect(renderedFieldIds(container)).toEqual(['fld_title'])
  })

  // ---- snapshot semantic ----

  it('snapshot: a value cleared while the toggle is on does NOT vanish; a record-id change re-snapshots', async () => {
    const { container, set } = mountPanel({ record: record('rec_1', { fld_title: 'a', fld_notes: 'draft' }), fields: [F_TITLE, F_NOTES], hideEmpty: true })
    await flushUi()
    expect(renderedFieldIds(container)).toEqual(['fld_title', 'fld_notes'])
    // same record id, value cleared (what an optimistic patch to '' looks like from the panel)
    set({ record: record('rec_1', { fld_title: 'a', fld_notes: '' }) })
    await flushUi()
    expect(renderedFieldIds(container)).toEqual(['fld_title', 'fld_notes'])
    // navigate to another record with the same empty shape → the snapshot is retaken → hidden
    set({ record: record('rec_2', { fld_title: 'b', fld_notes: '' }) })
    await flushUi()
    expect(renderedFieldIds(container)).toEqual(['fld_title'])
  })

  it('snapshot: a toggle off→on re-snapshots (a field emptied while off is hidden once on again)', async () => {
    const { container, set } = mountPanel({ record: record('rec_1', { fld_title: 'a', fld_notes: 'draft' }), fields: [F_TITLE, F_NOTES], hideEmpty: true })
    await flushUi()
    set({ hideEmpty: false })
    await flushUi()
    set({ record: record('rec_1', { fld_title: 'a', fld_notes: '' }) })
    await flushUi()
    expect(renderedFieldIds(container)).toEqual(['fld_title', 'fld_notes'])
    set({ hideEmpty: true })
    await flushUi()
    expect(renderedFieldIds(container)).toEqual(['fld_title'])
  })

  // ---- inspector-owned toggle ----

  it('inspector: the toggle is aria-pressed, flips its label, forwards to the fields panel, and resets on remount (session-only, no storage)', async () => {
    const a = mountInspector()
    await flushUi()
    const toggle = a.container.querySelector<HTMLButtonElement>('[data-testid="record-inspector-hide-empty"]')!
    expect(toggle).not.toBeNull()
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(toggle.textContent).toContain(recordLabel('record.hideEmpty', false))
    expect(renderedFieldIds(a.container)).toEqual(['fld_title', 'fld_notes'])
    toggle.click()
    await flushUi()
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(toggle.textContent).toContain(recordLabel('record.showEmpty', false))
    expect(renderedFieldIds(a.container)).toEqual(['fld_title'])
    expect(localStorage.length).toBe(0)
    a.app.unmount()
    const b = mountInspector()
    await flushUi()
    expect(b.container.querySelector('[data-testid="record-inspector-hide-empty"]')!.getAttribute('aria-pressed')).toBe('false')
    expect(renderedFieldIds(b.container)).toEqual(['fld_title', 'fld_notes'])
  })

  it('inspector: the toggle exists on the details tab only', async () => {
    const { container } = mountInspector()
    await flushUi()
    expect(container.querySelector('[data-testid="record-inspector-hide-empty"]')).not.toBeNull()
    const historyTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((tab) => tab.textContent?.trim() === recordLabel('record.history', false))!
    historyTab.click()
    await flushUi()
    expect(container.querySelector('[data-testid="record-inspector-hide-empty"]')).toBeNull()
  })

  it('inspector: hide-empty sits after the tablist and before the tabpanel; the splitter is still the LAST focusable', async () => {
    const { container } = mountInspector()
    await flushUi()
    const root = container.querySelector('.meta-record-drawer')!
    const focusable = Array.from(root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [role="tab"], [role="separator"]',
    ))
    const tabs = focusable.filter((el) => el.getAttribute('role') === 'tab')
    const toggleIndex = focusable.findIndex((el) => el.getAttribute('data-testid') === 'record-inspector-hide-empty')
    const firstFieldControl = focusable.findIndex((el) => el.closest('.meta-record-drawer__fields') !== null)
    expect(toggleIndex).toBeGreaterThan(focusable.indexOf(tabs[tabs.length - 1]))
    expect(toggleIndex).toBeLessThan(firstFieldControl)
    expect(focusable[focusable.length - 1].getAttribute('role')).toBe('separator')
    // structural: the tabpanel follows the tabs bar (which hosts the toggle) in DOM order
    const bar = container.querySelector('.meta-record-drawer__tabs-bar')!
    const panel = container.querySelector('[role="tabpanel"]')!
    expect(bar.contains(container.querySelector('[data-testid="record-inspector-hide-empty"]'))).toBe(true)
    expect(bar.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

// =====================================================================================================
describe('glyph ⇔ predicate agreement (one emptiness definition)', () => {
  const EMPTY_VALUES: unknown[] = [null, undefined, '', '   ', '\n\t ', [], {}]
  const FIELD_TYPES = [
    'string', 'longText', 'number', 'currency', 'percent', 'rating', 'duration', 'date', 'dateTime',
    'boolean', 'select', 'multiSelect', 'link', 'person', 'attachment', 'location', 'barcode', 'qrcode',
    'autoNumber', 'createdTime', 'modifiedTime', 'formula',
  ]

  it('every isEmptyValue-empty value renders the empty glyph on every field type (the glyph branch calls the predicate)', () => {
    for (const type of FIELD_TYPES) {
      const field = { id: 'f', name: 'F', type } as unknown as MetaField
      for (const value of EMPTY_VALUES) {
        expect(isEmptyValue(value)).toBe(true)
        expect(formatFieldDisplay({ field, value }), `type=${type} value=${JSON.stringify(value)}`).toBe('—')
      }
    }
  })

  it('positive control: non-empty values are neither predicate-empty nor glyphed', () => {
    const cases: Array<{ type: string; value: unknown }> = [
      { type: 'string', value: 'x' },
      { type: 'string', value: '  x  ' },
      { type: 'number', value: 0 },
      { type: 'boolean', value: false },
      { type: 'multiSelect', value: ['a'] },
      { type: 'location', value: { address: 'Main St' } },
    ]
    for (const { type, value } of cases) {
      const field = { id: 'f', name: 'F', type } as unknown as MetaField
      expect(isEmptyValue(value)).toBe(false)
      expect(formatFieldDisplay({ field, value }), `type=${type} value=${JSON.stringify(value)}`).not.toBe('—')
    }
  })

  it('source: the fields panel imports the SAME exported isEmptyValue field-display.ts uses (no second predicate)', () => {
    const fp = readSrc('src/multitable/components/MetaRecordFieldsPanel.vue')
    const fd = readSrc('src/multitable/utils/field-display.ts')
    expect(fp).toMatch(/import \{ isEmptyValue \} from '\.\.\/utils\/conditional-formatting'/)
    expect(fd).toMatch(/import \{ isEmptyValue \} from '\.\/conditional-formatting'/)
    expect(readSrc('src/multitable/utils/conditional-formatting.ts')).toMatch(/export function isEmptyValue\(/)
  })
})

// =====================================================================================================
describe('link chips (§1.3 "Link chips", HI-1)', () => {
  const LINK_RECORD = record('rec_1', { fld_title: 'a', fld_vendor: ['vendor_1', 'vendor_2'] })
  const LINK_SUMMARIES = { fld_vendor: [{ id: 'vendor_1', display: 'Acme Supply' }, { id: 'vendor_2', display: 'Beacon Labs' }] }

  it('with fetchRecord: chips are clickable buttons, a click opens the popover and fetches the SAME record id once; the edit-links button stays beside them', async () => {
    const fetchRecord = vi.fn(async (id: string) => foreignContext(id))
    const { container } = mountPanel({ record: LINK_RECORD, fields: [F_TITLE, F_VENDOR], linkSummariesByField: LINK_SUMMARIES, fetchRecord })
    await flushUi()
    const chips = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-test="link-chip"]'))
    expect(chips.map((c) => c.textContent?.trim())).toEqual(['Acme Supply', 'Beacon Labs'])
    expect(container.querySelector('.meta-linked-record-popover')).toBeNull()
    chips[0].click()
    await flushUi()
    expect(fetchRecord).toHaveBeenCalledTimes(1)
    expect(fetchRecord).toHaveBeenCalledWith('vendor_1')
    expect(container.querySelector('.meta-linked-record-popover [role="dialog"]')).not.toBeNull()
    expect(container.querySelector('.meta-linked-record-popover')?.textContent).toContain('Acme Supply')
    // the picker button is still there, now reading record.editLinks (chips carry the names/count)
    const btn = container.querySelector<HTMLButtonElement>('.meta-record-drawer__link-btn')!
    expect(btn.textContent?.trim()).toBe(recordLabel('record.editLinks', false))
  })

  it('without fetchRecord: chips render as plain text (no button), no popover can open, and NOTHING is fetched', async () => {
    const fetchCalls: unknown[] = []
    const originalFetch = (globalThis as { fetch?: unknown }).fetch
    ;(globalThis as { fetch?: unknown }).fetch = (...args: unknown[]) => { fetchCalls.push(args); return Promise.reject(new Error('unexpected fetch')) }
    try {
      const { container } = mountPanel({ record: LINK_RECORD, fields: [F_TITLE, F_VENDOR], linkSummariesByField: LINK_SUMMARIES })
      await flushUi()
      expect(container.querySelector('[data-test="link-chip"]')).toBeNull()
      const chips = Array.from(container.querySelectorAll('.meta-cell-renderer__link')).map((c) => c.textContent?.trim())
      expect(chips).toEqual(['Acme Supply', 'Beacon Labs'])
      // nothing to click — clicking the plain span opens nothing
      ;(container.querySelector('.meta-cell-renderer__link') as HTMLElement).click()
      await flushUi()
      expect(container.querySelector('.meta-linked-record-popover')).toBeNull()
      expect(fetchCalls).toHaveLength(0)
    } finally {
      ;(globalThis as { fetch?: unknown }).fetch = originalFetch
    }
  })

  it('the inspector threads fetchRecord through to the chips (WB → INS → FP → MetaCellRenderer)', async () => {
    const fetchRecord = vi.fn(async (id: string) => foreignContext(id))
    const { container } = mountInspector({ record: LINK_RECORD, fields: [F_TITLE, F_VENDOR], linkSummariesByField: LINK_SUMMARIES, fetchRecord })
    await flushUi()
    const chip = container.querySelector<HTMLButtonElement>('[data-test="link-chip"]')!
    expect(chip).not.toBeNull()
    chip.click()
    await flushUi()
    expect(fetchRecord).toHaveBeenCalledWith('vendor_1')
  })

  it('a read-only link field renders chips once (no duplicate joined text); an empty link field falls back to the shared glyph', async () => {
    const { container } = mountPanel({
      record: record('rec_1', { fld_title: 'a', fld_vendor: ['vendor_1'] }),
      fields: [F_TITLE, F_VENDOR],
      canEdit: false,
      linkSummariesByField: { fld_vendor: [{ id: 'vendor_1', display: 'Acme Supply' }] },
    })
    await flushUi()
    const row = container.querySelector('[data-field-id="fld_vendor"]')!
    expect(row.querySelector('.meta-cell-renderer__link')?.textContent?.trim()).toBe('Acme Supply')
    expect(row.querySelector('.meta-record-drawer__text')).toBeNull()
    expect(row.querySelector('.meta-record-drawer__link-btn')).toBeNull()

    const empty = mountPanel({ record: record('rec_2', { fld_title: 'a', fld_vendor: [] }), fields: [F_TITLE, F_VENDOR], canEdit: false })
    await flushUi()
    const emptyRow = empty.container.querySelector('[data-field-id="fld_vendor"]')!
    expect(emptyRow.querySelector('.meta-cell-renderer__link')).toBeNull()
    expect(emptyRow.querySelector('.meta-record-drawer__text')?.textContent).toBe('—')
  })

  it('an editable EMPTY link field keeps the count-aware picker copy (no chips to show yet)', async () => {
    const { container } = mountPanel({ record: record('rec_1', { fld_title: 'a', fld_vendor: [] }), fields: [F_TITLE, F_VENDOR] })
    await flushUi()
    const btn = container.querySelector<HTMLButtonElement>('.meta-record-drawer__link-btn')!
    expect(btn.textContent?.trim()).not.toBe(recordLabel('record.editLinks', false))
    expect(container.querySelector('[data-link-chips]')).toBeNull()
  })

  it('HI-1 source scan: the fields panel itself makes no fetch(/client. call — fetchRecord is only ever handed to MetaCellRenderer', () => {
    const src = readSrc('src/multitable/components/MetaRecordFieldsPanel.vue')
    expect(src).not.toMatch(/[^.]\bfetch\(/)
    expect(src).not.toMatch(/(?<!api)client\.\w+\(/)
    // positive control for the regexes: a literal call WOULD match
    expect('void fetch(url)').toMatch(/[^.]\bfetch\(/)
    expect('client.getRecord(id)').toMatch(/(?<!api)client\.\w+\(/)
  })
})

// =====================================================================================================
describe('copy link (§1.3 "Copy link", inspector side)', () => {
  it('the copy-link icon is DISABLED when the Clipboard API is absent', async () => {
    const restore = stubClipboard(undefined)
    try {
      const { container } = mountInspector()
      await flushUi()
      const btn = container.querySelector<HTMLButtonElement>('[data-testid="record-inspector-copy-link"]')!
      expect(btn).not.toBeNull()
      expect(btn.disabled).toBe(true)
    } finally {
      restore()
    }
  })

  it('with the Clipboard API present the icon is enabled and a click emits copy-link exactly once (no clipboard access in the inspector)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const restore = stubClipboard({ writeText })
    try {
      const onCopyLink = vi.fn()
      const { container } = mountInspector({ onCopyLink })
      await flushUi()
      const btn = container.querySelector<HTMLButtonElement>('[data-testid="record-inspector-copy-link"]')!
      expect(btn.disabled).toBe(false)
      btn.click()
      await flushUi()
      expect(onCopyLink).toHaveBeenCalledTimes(1)
      expect(writeText).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('status channel: MetaToast (the workbench sink for record.copyLinkDone/Failed) is a polite live region', () => {
    const src = readSrc('src/multitable/components/MetaToast.vue')
    expect(src).toMatch(/aria-live="polite"/)
    expect(src).toMatch(/role="status"/)
    const wb = readSrc('src/multitable/views/MultitableWorkbench.vue')
    expect(wb).toMatch(/@copy-link="onCopyRecordLink"/)
    expect(wb).toMatch(/recordLabel\('record\.copyLinkDone'/)
    expect(wb).toMatch(/recordLabel\('record\.copyLinkFailed'/)
    expect(wb).toMatch(/clipboard\.writeText\(window\.location\.href\)/)
  })
})

// =====================================================================================================
describe('keyboard (§1.5 FP-local)', () => {
  const KB_FIELDS = [F_TITLE, F_QTY, F_STATUS, F_NOTES]
  const KB_RECORD = record('rec_1', { fld_title: 'a', fld_qty: 1, fld_status: 'todo', fld_notes: 'n' })

  it('textarea mod+Enter blurs (the commit path) without emitting itself; the native change that follows is exactly ONE patch', async () => {
    const onPatch = vi.fn()
    const { container } = mountPanel({ record: KB_RECORD, fields: KB_FIELDS, onPatch })
    await flushUi()
    const textarea = container.querySelector<HTMLTextAreaElement>('#drawer_field_fld_notes')!
    textarea.focus()
    textarea.value = 'hello'
    const event = keydown(textarea, { key: 'Enter', metaKey: true })
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).not.toBe(textarea)
    // the handler itself emitted nothing — a second emit here would double the patch in a browser
    expect(onPatch).not.toHaveBeenCalled()
    // what a browser does on blur-with-changed-value (jsdom does not synthesize it)
    textarea.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch).toHaveBeenCalledWith('fld_notes', 'hello')
  })

  it('textarea ctrl+Enter behaves like meta+Enter; bare Enter and Shift+Enter are untouched (newline stays a newline)', async () => {
    const onPatch = vi.fn()
    const { container } = mountPanel({ record: KB_RECORD, fields: KB_FIELDS, onPatch })
    await flushUi()
    const textarea = container.querySelector<HTMLTextAreaElement>('#drawer_field_fld_notes')!
    textarea.focus()
    expect(keydown(textarea, { key: 'Enter' }).defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(textarea)
    expect(keydown(textarea, { key: 'Enter', shiftKey: true }).defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(textarea)
    expect(keydown(textarea, { key: 'Enter', ctrlKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).not.toBe(textarea)
    expect(onPatch).not.toHaveBeenCalled()
  })

  it('Enter on a single-line control commits (blur → one change) and moves focus to the NEXT editable control; Shift+Enter to the PREVIOUS', async () => {
    const onPatch = vi.fn()
    const { container } = mountPanel({ record: KB_RECORD, fields: KB_FIELDS, onPatch })
    await flushUi()
    const title = container.querySelector<HTMLInputElement>('#drawer_field_fld_title')!
    const qty = container.querySelector<HTMLInputElement>('#drawer_field_fld_qty')!
    const status = container.querySelector<HTMLSelectElement>('#drawer_field_fld_status')!
    title.focus()
    title.value = 'b'
    expect(keydown(title, { key: 'Enter' }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(qty)
    // the handler emits nothing itself; the browser's change-on-blur is the single patch
    expect(onPatch).not.toHaveBeenCalled()
    title.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch).toHaveBeenCalledWith('fld_title', 'b')
    // next from the number input is the select (an editable control, even though Enter on IT is untouched)
    expect(keydown(qty, { key: 'Enter' }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(status)
    // Shift+Enter walks back
    qty.focus()
    expect(keydown(qty, { key: 'Enter', shiftKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(title)
  })

  it('Enter on a <select> is untouched; Enter on the LAST single-line control with nothing after it just blurs; mod+Enter on an input is untouched', async () => {
    const onPatch = vi.fn()
    const { container } = mountPanel({ record: record('rec_1', { fld_title: 'a', fld_status: 'todo', fld_qty: 1 }), fields: [F_STATUS, F_TITLE, F_QTY], onPatch })
    await flushUi()
    const status = container.querySelector<HTMLSelectElement>('#drawer_field_fld_status')!
    const title = container.querySelector<HTMLInputElement>('#drawer_field_fld_title')!
    const qty = container.querySelector<HTMLInputElement>('#drawer_field_fld_qty')!
    status.focus()
    expect(keydown(status, { key: 'Enter' }).defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(status)
    title.focus()
    expect(keydown(title, { key: 'Enter', metaKey: true }).defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(title)
    qty.focus()
    expect(keydown(qty, { key: 'Enter' }).defaultPrevented).toBe(true)
    expect(document.activeElement).not.toBe(qty)
    expect(onPatch).not.toHaveBeenCalled()
  })

  it('source: the Enter/mod+Enter handling is FP-local (root-delegated) — MetaGridTable.onKeydown and MetaCellEditor are untouched by this slice, and the inspector root dispatcher inspects no Enter', () => {
    const fp = readSrc('src/multitable/components/MetaRecordFieldsPanel.vue')
    expect(fp).toMatch(/@keydown="onFieldsKeydown"/)
    const ins = readSrc('src/multitable/components/MetaRecordInspector.vue')
    const dispatcher = ins.match(/function onInspectorKeydown\(event: KeyboardEvent\)[\s\S]*?\n\}/)?.[0] ?? ''
    expect(dispatcher.length).toBeGreaterThan(0)
    expect(dispatcher).not.toMatch(/'Enter'/)
  })
})

// =====================================================================================================
describe('attachments 3-up gallery (§1.3 "Attachments") — CSS provision only', () => {
  it('[source] the attachments wrapper is a container and an @container (min-width: 480px) rule lays MetaAttachmentList out 3-up via :deep() (jsdom cannot verify the layout itself)', () => {
    const src = readSrc('src/multitable/components/MetaRecordFieldsPanel.vue')
    const wrapperRule = src.match(/\.meta-record-drawer__attachments\s*\{[^}]*\}/)?.[0] ?? ''
    expect(wrapperRule).toMatch(/container-type:\s*inline-size/)
    const query = src.match(/@container \(min-width: 480px\)\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(query.length).toBeGreaterThan(0)
    expect(query).toMatch(/:deep\(\.meta-attachment-list__items\)\s*\{[^}]*display:\s*grid/)
    expect(query).toMatch(/grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/)
    // MetaAttachmentList itself is used AS IS — no gallery/grid rule was added to that component
    expect(readSrc('src/multitable/components/MetaAttachmentList.vue')).not.toMatch(/@container|grid-template-columns/)
  })

  it('attachment thumbnails still render through MetaAttachmentList inside the fields panel (the gallery is layout-only)', async () => {
    const { container } = mountPanel({
      record: record('rec_1', { fld_title: 'a', fld_files: ['att_1'] }),
      fields: [F_TITLE, F_FILES],
      attachmentSummariesByField: {
        fld_files: [{ id: 'att_1', filename: 'diagram.png', mimeType: 'image/png', size: 1, url: '/a/att_1', thumbnailUrl: '/a/att_1?thumbnail=true', uploadedAt: '' }],
      },
    })
    await flushUi()
    expect(container.querySelector('.meta-record-drawer__attachments .meta-attachment-list__items img')?.getAttribute('src')).toContain('thumbnail=true')
  })
})
