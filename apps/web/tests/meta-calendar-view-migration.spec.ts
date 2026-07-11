import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaCalendarView from '../src/multitable/components/MetaCalendarView.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c batch6: MetaCalendarView's prev/next nav controls migrated from bespoke <button> to the
// shared MtIconButton primitive (ghost; the &lsaquo;/&rsaquo; glyphs pass through unchanged via its
// default-slot icon fallback). The "today" and field-"change" controls migrated to MtButton (ghost).
// The create/day-create controls (soft-tinted, same visual family) are explicitly NOT touched here —
// they stay bespoke pending an owner variant call on the T2 soft-tinted-create tail lock. Behavior-
// preservation proof: each control stays a native, keyboard-operable <button>; @click handlers +
// v-if guards are unchanged; clicking still invokes the SAME handler.

const fields: MetaField[] = [
  { id: 'fld_title', name: 'Title', type: 'string' },
  { id: 'fld_start', name: 'Start', type: 'date' },
]

const rows: MetaRecord[] = []

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  expect(document.querySelectorAll('.meta-calendar').length).toBe(0) // residue guard
  useLocale().setLocale('en')
})

function mount(props: Record<string, unknown>) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const app = createApp({
    render: () => h(MetaCalendarView, {
      rows,
      fields,
      loading: false,
      viewConfig: { dateFieldId: 'fld_start', titleFieldId: 'fld_title', defaultView: 'month', weekStartsOn: 0 },
      ...props,
    }),
  })
  app.mount(container)
  mounts.push({ app, container })
  return container
}

const navBtns = (r: HTMLElement) => Array.from(r.querySelectorAll('.meta-calendar__nav-btn')) as HTMLButtonElement[]
const todayBtn = (r: HTMLElement) => r.querySelector('.meta-calendar__today-btn') as HTMLButtonElement | null
const changeBtn = (r: HTMLElement) => r.querySelector('.meta-calendar__change-btn') as HTMLButtonElement | null

describe('MetaCalendarView — MtButton/MtIconButton migration (UI-P2-1c batch6)', () => {
  it('renders prev/next as native <button>s carrying the &lsaquo;/&rsaquo; glyphs unchanged', () => {
    const root = mount({})
    const btns = navBtns(root)
    expect(btns.length).toBe(2)
    for (const b of btns) expect(b.tagName).toBe('BUTTON') // keyboard-operable, not a bare div
    expect(btns[0]!.textContent).toBe('‹') // &lsaquo;
    expect(btns[1]!.textContent).toBe('›') // &rsaquo;
  })

  it('clicking prev/next still calls goPrevious/goNext (title label updates, unchanged handler)', async () => {
    const root = mount({})
    const before = root.querySelector('.meta-calendar__title')!.textContent
    navBtns(root)[1]!.click() // next
    await nextTick()
    const afterNext = root.querySelector('.meta-calendar__title')!.textContent
    expect(afterNext).not.toBe(before)
    navBtns(root)[0]!.click() // prev, back to start
    await nextTick()
    const afterPrev = root.querySelector('.meta-calendar__title')!.textContent
    expect(afterPrev).toBe(before)
  })

  it('renders "today" as a native <button>; clicking it resets the view date (unchanged handler)', async () => {
    const root = mount({})
    const btn = todayBtn(root)!
    expect(btn.tagName).toBe('BUTTON')
    navBtns(root)[1]!.click() // move away from the current period first
    await nextTick()
    const moved = root.querySelector('.meta-calendar__title')!.textContent
    todayBtn(root)!.click()
    await nextTick()
    expect(root.querySelector('.meta-calendar__title')!.textContent).not.toBe(moved)
  })

  it('renders field "change" only when a date field is set; clicking it emits update-view-config with dateFieldId: null', () => {
    // No fields at all -> no date-field candidate -> dateField resolves to null -> the whole
    // header (incl. change-btn) is unreached; the component falls into its "pick a field" branch.
    expect(changeBtn(mount({ fields: [], viewConfig: null }))).toBeNull() // v-if="dateField" preserved
    const onUpdateViewConfig = vi.fn()
    const root = mount({ onUpdateViewConfig })
    const btn = changeBtn(root)!
    expect(btn.tagName).toBe('BUTTON')
    btn.click()
    expect(onUpdateViewConfig).toHaveBeenCalledTimes(1)
    expect(onUpdateViewConfig).toHaveBeenCalledWith({
      config: expect.objectContaining({ dateFieldId: null }),
    })
  })

  it('leaves create/day-create bespoke (not migrated — T2-adjacent, excluded pending owner call)', () => {
    const root = mount({ canCreate: true })
    const createBtn = root.querySelector('.meta-calendar__create-btn')
    expect(createBtn).not.toBeNull()
    expect(createBtn!.tagName).toBe('BUTTON')
    // Bespoke create-btn keeps its own hardcoded-hex CSS class (no MtButton wrapper attributes).
    expect(createBtn!.className.trim()).toBe('meta-calendar__create-btn')
  })
})
