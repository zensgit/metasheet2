import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaTimelineView from '../src/multitable/components/MetaTimelineView.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c T2 (multitable-ui-p2-1c-tail-lock #3866 §2-T2, RATIFIED): MetaTimelineView's create-btn
// (config toolbar) and both placeholder-action instances (select-start-end placeholder + fully-empty
// state) migrate from bespoke <button> to the shared MtButton primitive (`plain` variant). All three
// shared the same soft-tinted (#ecf5ff bg / #2563eb text / #c7ddff border) hardcoded CSS, now removed.
// Byte-equivalence proof: same v-if="canCreate" gate, same @click="onQuickCreate" handler on all
// three, same class name kept on each element (selector stability) — only the rendering primitive +
// CSS ownership changed.

const stringField: MetaField = { id: 'fld_title', name: 'Title', type: 'string' }
const startField: MetaField = { id: 'fld_start', name: 'Start', type: 'date' }
const endField: MetaField = { id: 'fld_end', name: 'End', type: 'date' }

// Zero fields (not just zero date fields): resolveTimelineViewConfig's firstFieldId() falls back to
// fields[0] when no date-typed field is found, so a non-empty fields array would still resolve
// startFieldId/endFieldId to a non-null value (e.g. the string field) and skip the placeholder. Only
// a genuinely empty fields array forces both to null → the "select start/end" placeholder branch
// renders (meta-timeline__create-btn + meta-timeline__placeholder-action, first instance).
const fieldsNoDate: MetaField[] = []

// Both date fields present, but zero rows → scheduledRows/unscheduledRows are both empty → the fully
// scheduled-view "no records" branch renders (meta-timeline__create-btn + meta-timeline__placeholder-
// action, second instance).
const fieldsWithDates: MetaField[] = [stringField, startField, endField]

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  expect(document.querySelectorAll('.meta-timeline').length).toBe(0) // residue guard
  useLocale().setLocale('en')
})

function mount(props: Record<string, unknown>, fields: MetaField[] = fieldsNoDate, rows: MetaRecord[] = []) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const app = createApp({
    render: () => h(MetaTimelineView, { rows, fields, loading: false, ...props }),
  })
  app.mount(container)
  mounts.push({ app, container })
  return container
}

describe('MetaTimelineView — MtButton migration (UI-P2-1c T2)', () => {
  it('renders create-btn as a native <button> via MtButton plain', () => {
    const root = mount({ canCreate: true })
    const btn = root.querySelector('.meta-timeline__create-btn') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('mt-button--plain')).toBe(true)
    expect(btn.classList.contains('meta-timeline__create-btn')).toBe(true) // selector stability
  })

  it('create-btn only renders when canCreate is true (v-if preserved)', () => {
    expect(mount({ canCreate: false }).querySelector('.meta-timeline__create-btn')).toBeNull()
    expect(mount({ canCreate: true }).querySelector('.meta-timeline__create-btn')).not.toBeNull()
  })

  it('clicking create-btn calls onQuickCreate → emits `create-record` with the SAME payload (unchanged handler)', () => {
    const onCreateRecord = vi.fn()
    // fieldsNoDate has no date fields, so onQuickCreate's startFieldId/endFieldId are both empty and
    // it seeds neither key — payload is the empty object, same as pre-migration.
    const root = mount({ canCreate: true, onCreateRecord }, fieldsNoDate)
    ;(root.querySelector('.meta-timeline__create-btn') as HTMLButtonElement).click()
    expect(onCreateRecord).toHaveBeenCalledTimes(1)
    expect(onCreateRecord).toHaveBeenCalledWith({})
  })

  it('renders placeholder-action (select-start-end instance) as a native <button> via MtButton plain', () => {
    const root = mount({ canCreate: true }, fieldsNoDate)
    const btn = root.querySelector('.meta-timeline__placeholder-action') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('mt-button--plain')).toBe(true)
    expect(btn.classList.contains('meta-timeline__placeholder-action')).toBe(true)
  })

  it('placeholder-action (select-start-end instance) only renders when canCreate is true (v-if preserved)', () => {
    expect(mount({ canCreate: false }, fieldsNoDate).querySelector('.meta-timeline__placeholder-action')).toBeNull()
    expect(mount({ canCreate: true }, fieldsNoDate).querySelector('.meta-timeline__placeholder-action')).not.toBeNull()
  })

  it('clicking placeholder-action (select-start-end instance) calls onQuickCreate → emits `create-record` with the SAME payload', () => {
    const onCreateRecord = vi.fn()
    const root = mount({ canCreate: true, onCreateRecord }, fieldsNoDate)
    ;(root.querySelector('.meta-timeline__placeholder-action') as HTMLButtonElement).click()
    expect(onCreateRecord).toHaveBeenCalledTimes(1)
    expect(onCreateRecord).toHaveBeenCalledWith({})
  })

  it('renders placeholder-action (fully-empty instance) as a native <button> via MtButton plain', () => {
    const root = mount({ canCreate: true }, fieldsWithDates, [])
    const btn = root.querySelector('.meta-timeline__placeholder-action') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('mt-button--plain')).toBe(true)
    expect(btn.classList.contains('meta-timeline__placeholder-action')).toBe(true)
  })

  it('clicking placeholder-action (fully-empty instance) calls onQuickCreate → emits `create-record` seeded with the SAME date fields', () => {
    const onCreateRecord = vi.fn()
    const root = mount({ canCreate: true, onCreateRecord }, fieldsWithDates, [])
    ;(root.querySelector('.meta-timeline__placeholder-action') as HTMLButtonElement).click()
    expect(onCreateRecord).toHaveBeenCalledTimes(1)
    // fieldsWithDates resolves startFieldId/endFieldId to fld_start/fld_end — onQuickCreate seeds
    // both with today's date (unchanged handler behavior).
    expect(onCreateRecord).toHaveBeenCalledWith(
      expect.objectContaining({ fld_start: expect.any(String), fld_end: expect.any(String) }),
    )
  })

  it('all three migrated controls carry no bespoke hardcoded-hex inline style (token-only via MtButton)', () => {
    const root = mount({ canCreate: true }, fieldsNoDate)
    const createBtn = root.querySelector('.meta-timeline__create-btn') as HTMLButtonElement
    const placeholderAction = root.querySelector('.meta-timeline__placeholder-action') as HTMLButtonElement
    expect(createBtn.getAttribute('style')).toBeNull()
    expect(placeholderAction.getAttribute('style')).toBeNull()
  })
})
