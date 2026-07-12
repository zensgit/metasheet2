import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaViewManager from '../src/multitable/components/MetaViewManager.vue'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c batch-1: MetaViewManager's two `meta-view-mgr__btn-add` controls (add-section "Add view" +
// config-panel "Save settings") were migrated from bespoke <button>s to MtButton variant="primary". Because
// the class is shared across both, BOTH were migrated at once and the bespoke #409eff CSS removed (normalized
// to --ms-color-primary; no double-styling). Separate-class cancel/delete/inline buttons stayed bespoke.
// Behavior-preservation proof: both stay native <button>s; :disabled survives; clicking Add view still emits
// `create-view` with the same payload. (Save settings' click behavior is the existing multitable-view-manager
// spec's regression anchor.)
//
// UI-P2-1c batch-3: the FOOTER slice — both `meta-view-mgr__btn-cancel` sharers (config-panel Cancel +
// delete-confirm Cancel) and the delete-confirm's `meta-view-mgr__btn-delete` (its only sharer) — are now
// <MtButton> (default ghost / variant="danger"). Both classes' full sharer sets were migrated at once, so
// their bespoke CSS was removed (no double-styling). The __action glyph row stays untouched. Behavior-
// preservation proof: all three stay native <button>s; clicking config-Cancel still closes the config panel
// (closeConfig); clicking confirm-Cancel still clears deleteTargetId; clicking confirm-Delete still emits
// `delete-view` with the same viewId.
//
// UI-P2-1c T3 (multitable-ui-p2-1c-tail-resolution-designlock-20260707.md §2-T3, RATIFIED): of
// `.meta-view-mgr__btn-inline`'s FOUR sharers, only the two named in the T3-ratified range —
// addFilterRule ("+ Add filter") and addSortRule ("+ Add sort") — are now <MtLink>. reloadLatestConfig
// ("Reload latest") and dismissLiveRefreshNotice ("Dismiss") are OUT of scope and stay on the bespoke
// class (its CSS therefore stays too — partial-sharer migration, CSS removal gated on ALL sharers
// migrating). Behavior-preservation proof: both migrated controls stay native <button>s (now class
// `mt-link`); clicking "+ Add filter" still appends a filter rule row, clicking "+ Add sort" still
// appends a sort rule row — same as pre-migration.

const fields = [{ id: 'fld_name', name: 'Name', type: 'string' as const }]
const views = [{ id: 'view_1', sheetId: 'sheet_1', name: 'Grid', type: 'grid' }]
const twoViews = [
  { id: 'view_1', sheetId: 'sheet_1', name: 'Grid', type: 'grid' },
  { id: 'view_2', sheetId: 'sheet_1', name: 'Kanban', type: 'kanban' },
]

let app: App | null = null; let container: HTMLDivElement | null = null
afterEach(() => { app?.unmount(); container?.remove(); app = null; container = null; useLocale().setLocale('en') })

function mount(handlers: Record<string, unknown> = {}, viewList: typeof views = views) {
  container = document.createElement('div'); document.body.appendChild(container)
  app = createApp({ render: () => h(MetaViewManager, { visible: true, sheetId: 'sheet_1', activeViewId: 'view_1', fields, views: viewList, ...handlers } as never) })
  app.mount(container)
}
const addView = () => container!.querySelector('.meta-view-mgr__btn-add') as HTMLButtonElement // only one on mount (config closed)
const configBtn = () => container!.querySelector('.meta-view-mgr__action[title="Configure"]') as HTMLButtonElement | null
const configCancelBtn = () => container!.querySelector('.meta-view-mgr__config .meta-view-mgr__btn-cancel') as HTMLButtonElement | null
const deleteGlyphBtn = () => container!.querySelector('.meta-view-mgr__action--danger') as HTMLButtonElement | null
const confirmCancelBtn = () => container!.querySelector('.meta-view-mgr__confirm .meta-view-mgr__btn-cancel') as HTMLButtonElement | null
const confirmDeleteBtn = () => container!.querySelector('.meta-view-mgr__btn-delete') as HTMLButtonElement | null

describe('MetaViewManager — MtButton migration (UI-P2-1c)', () => {
  it('renders the add-section Add view as a native <button>; disabled until a name is typed', () => {
    mount()
    expect(addView().tagName).toBe('BUTTON') // keyboard-operable, not a bare div
    expect(addView().disabled).toBe(true) // :disabled="!newViewName.trim()"
  })

  it('typing a name then clicking Add view emits `create-view` with the same payload (unchanged)', async () => {
    const onCreateView = vi.fn()
    mount({ onCreateView })
    const input = container!.querySelector('.meta-view-mgr__input') as HTMLInputElement
    input.value = 'My View'; input.dispatchEvent(new Event('input'))
    await nextTick()
    expect(addView().disabled).toBe(false)
    addView().click()
    expect(onCreateView).toHaveBeenCalledTimes(1)
    expect(onCreateView).toHaveBeenCalledWith(expect.objectContaining({ sheetId: 'sheet_1', name: 'My View', type: 'grid' }))
  })

  it('opening the config panel renders the Save-settings control as a native <button> too', async () => {
    mount()
    configBtn()!.click() // openConfig(view) → configTarget set → config panel renders
    await nextTick()
    const btns = Array.from(container!.querySelectorAll('.meta-view-mgr__config .meta-view-mgr__btn-add')) as HTMLElement[]
    expect(btns.length).toBe(1)
    expect(btns[0].tagName).toBe('BUTTON')
  })
})

describe('MetaViewManager — MtButton migration (UI-P2-1c batch-3, footer slice)', () => {
  it('config-panel Cancel renders as a native <button> and clicking it closes the config panel', async () => {
    mount()
    configBtn()!.click() // openConfig(view) → configTarget set
    await nextTick()
    expect(configCancelBtn()).not.toBeNull()
    expect(configCancelBtn()!.tagName).toBe('BUTTON')
    configCancelBtn()!.click() // closeConfig() → configTargetId = null
    await nextTick()
    expect(container!.querySelector('.meta-view-mgr__config')).toBeNull()
  })

  it('delete-confirm Cancel renders as a native <button> and clicking it dismisses the confirm row', async () => {
    mount({}, twoViews) // >1 view so the delete glyph is enabled
    deleteGlyphBtn()!.click() // onDeleteView(view) → deleteTargetId set → confirm row renders
    await nextTick()
    expect(confirmCancelBtn()).not.toBeNull()
    expect(confirmCancelBtn()!.tagName).toBe('BUTTON')
    confirmCancelBtn()!.click() // deleteTargetId = null
    await nextTick()
    expect(container!.querySelector('.meta-view-mgr__confirm')).toBeNull()
  })

  it('delete-confirm Delete renders as a native <button> and clicking it emits `delete-view` with the same viewId', async () => {
    const onDeleteView = vi.fn()
    mount({ onDeleteView }, twoViews)
    deleteGlyphBtn()!.click() // targets view_1 (first row)
    await nextTick()
    expect(confirmDeleteBtn()).not.toBeNull()
    expect(confirmDeleteBtn()!.tagName).toBe('BUTTON')
    confirmDeleteBtn()!.click() // confirmDelete() → emit('delete-view', deleteTarget.value.id)
    expect(onDeleteView).toHaveBeenCalledTimes(1)
    expect(onDeleteView).toHaveBeenCalledWith('view_1')
  })
})

const addFilterBtn = () => container!.querySelector('[data-filter-add="true"]') as HTMLButtonElement | null
const addSortBtn = () => container!.querySelector('[data-sort-add="true"]') as HTMLButtonElement | null

describe('MetaViewManager — MtLink migration (UI-P2-1c T3)', () => {
  it('renders + Add filter and + Add sort as native <button class="mt-link">s (only 2 of the 4 __btn-inline sharers migrate)', async () => {
    mount()
    configBtn()!.click() // openConfig(view) → configTarget set → config panel renders
    await nextTick()
    expect(addFilterBtn()!.tagName).toBe('BUTTON')
    expect(addFilterBtn()!.classList.contains('mt-link')).toBe(true)
    expect(addSortBtn()!.tagName).toBe('BUTTON')
    expect(addSortBtn()!.classList.contains('mt-link')).toBe(true)
    // the bespoke class stays declared for the OTHER two (out-of-scope) sharers, but is gone from
    // these two migrated elements specifically:
    expect(addFilterBtn()!.classList.contains('meta-view-mgr__btn-inline')).toBe(false)
    expect(addSortBtn()!.classList.contains('meta-view-mgr__btn-inline')).toBe(false)
  })

  it('clicking + Add filter still appends a filter rule row (same as pre-migration)', async () => {
    mount()
    configBtn()!.click()
    await nextTick()
    expect(container!.querySelectorAll('.meta-view-mgr__rule-row--filter').length).toBe(0)
    addFilterBtn()!.click()
    await nextTick()
    expect(container!.querySelectorAll('.meta-view-mgr__rule-row--filter').length).toBe(1)
  })

  it('clicking + Add sort still appends a sort rule row (same as pre-migration)', async () => {
    mount()
    configBtn()!.click()
    await nextTick()
    const sortRowsBefore = Array.from(container!.querySelectorAll('.meta-view-mgr__rule-row'))
      .filter((row) => !row.classList.contains('meta-view-mgr__rule-row--filter'))
    expect(sortRowsBefore.length).toBe(0)
    addSortBtn()!.click()
    await nextTick()
    const sortRowsAfter = Array.from(container!.querySelectorAll('.meta-view-mgr__rule-row'))
      .filter((row) => !row.classList.contains('meta-view-mgr__rule-row--filter'))
    expect(sortRowsAfter.length).toBe(1)
  })
})
