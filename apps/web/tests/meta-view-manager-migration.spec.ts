import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
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
// addFilterRule ("+ Add filter") and addSortRule ("+ Add sort") — were in scope. reloadLatestConfig
// ("Reload latest") and dismissLiveRefreshNotice ("Dismiss") are OUT of scope and stay on the bespoke
// class (its CSS therefore stays too — partial-sharer migration, CSS removal gated on ALL sharers
// migrating).
//
// UI-P2-1c T1 batch-7 (multitable-ui-p2-1c-tail-resolution-designlock-20260707.md §2-T1, RATIFIED): the
// header close-× (`.meta-view-mgr__close`, @click="requestClose") is now <MtIconButton> (ghost, token-
// styled) — the &times; glyph passes through MtIconButton's default-slot icon fallback (glyph char
// preserved, size token-normalized to the icon control: 20px -> 14px glyph, 32x32 control box). This file
// ALSO has two other × glyph buttons that are remove-item actions, NOT close buttons, and neither was
// touched: removeFilterRule / removeSortRule (both `.meta-view-mgr__action--danger`). See the POSITIVE
// CONTROL test below proving removeFilterRule still fires unchanged (also proves this file's mount can
// observe these buttons at all).
//
// T3 errata fix-forward (2026-07-12): #4131 first migrated addFilterRule/addSortRule to <MtLink> on
// the premise that `.meta-view-mgr__btn-inline` was "link-styled" — that premise was factually wrong
// (the class is `padding:4px 10px; border:1px dashed #cbd5e1; background:#fff; color:#475569`, a gray
// dashed-box action button, not a text link — see the CSS comment above `.meta-view-mgr__btn-inline`
// in the component). owner corrected course: these two are now <MtButton variant="plain"> instead (T2's
// soft-tinted primitive). This is a DELIBERATE visual change (gray dashed box → plain soft-primary
// fill), not a zero-visual-change normalization. Behavior-preservation proof: both migrated controls
// stay native <button>s (now class `mt-button mt-button--plain`, still NOT carrying
// `.meta-view-mgr__btn-inline`); clicking "+ Add filter" still appends a filter rule row, clicking
// "+ Add sort" still appends a sort rule row — same as pre-migration. A second describe block below
// pins that the two OUT-of-scope sharers (reloadLatestConfig/dismissLiveRefreshNotice) were untouched
// by this fix-forward — still native bespoke `.meta-view-mgr__btn-inline` buttons, not MtLink/MtButton.

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
const closeBtn = () => container!.querySelector('.meta-view-mgr__close') as HTMLButtonElement | null

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

describe('MetaViewManager — MtButton plain reclaim (UI-P2-1c T3 errata fix-forward, 2026-07-12)', () => {
  it('renders + Add filter and + Add sort as native <button class="mt-button mt-button--plain">s, NOT mt-link (only 2 of the 4 __btn-inline sharers migrate)', async () => {
    mount()
    configBtn()!.click() // openConfig(view) → configTarget set → config panel renders
    await nextTick()
    expect(addFilterBtn()!.tagName).toBe('BUTTON')
    expect(addFilterBtn()!.classList.contains('mt-button')).toBe(true)
    expect(addFilterBtn()!.classList.contains('mt-button--plain')).toBe(true)
    expect(addFilterBtn()!.classList.contains('mt-link')).toBe(false)
    expect(addSortBtn()!.tagName).toBe('BUTTON')
    expect(addSortBtn()!.classList.contains('mt-button')).toBe(true)
    expect(addSortBtn()!.classList.contains('mt-button--plain')).toBe(true)
    expect(addSortBtn()!.classList.contains('mt-link')).toBe(false)
    // the bespoke class stays declared for the OTHER two (out-of-scope) sharers (see next describe
    // block), but is gone from these two migrated elements specifically — MtButton's plain variant
    // owns its full look, so the class is never re-added:
    expect(addFilterBtn()!.classList.contains('meta-view-mgr__btn-inline')).toBe(false)
    expect(addSortBtn()!.classList.contains('meta-view-mgr__btn-inline')).toBe(false)
  })

  it('clicking + Add filter still appends a filter rule row (same as pre-migration; mutation-red proof the @click wiring survived the MtLink→MtButton swap)', async () => {
    mount()
    configBtn()!.click()
    await nextTick()
    expect(container!.querySelectorAll('.meta-view-mgr__rule-row--filter').length).toBe(0)
    addFilterBtn()!.click()
    await nextTick()
    expect(container!.querySelectorAll('.meta-view-mgr__rule-row--filter').length).toBe(1)
  })

  it('clicking + Add sort still appends a sort rule row (same as pre-migration; mutation-red proof the @click wiring survived the MtLink→MtButton swap)', async () => {
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

  it('renders v-if="configTargetFields.length" unchanged: hides both when no fields are configurable', async () => {
    container = document.createElement('div'); document.body.appendChild(container)
    app = createApp({ render: () => h(MetaViewManager, { visible: true, sheetId: 'sheet_1', activeViewId: 'view_1', fields: [], views, } as never) })
    app.mount(container)
    configBtn()!.click()
    await nextTick()
    expect(addFilterBtn()).toBeNull()
    expect(addSortBtn()).toBeNull()
  })
})

// Reactive-props mount helper — needed to drive `reloadLatestConfig`/`dismissLiveRefreshNotice` into
// view, since both are gated behind internal refs (viewConfigOutdated / viewConfigLiveRefreshText) that
// only change via the component's own `watch(() => props.views, ...)` (MetaViewManager.vue ~L1353),
// comparing a live source-signature against the one captured when the config panel opened. Reassigning
// the ref's `.value` gives MetaViewManager a new `views` array so that watcher actually fires.
function mountReactive(initialViews: typeof views = views) {
  container = document.createElement('div'); document.body.appendChild(container)
  const viewsRef = ref(initialViews)
  app = createApp({ render: () => h(MetaViewManager, { visible: true, sheetId: 'sheet_1', activeViewId: 'view_1', fields, views: viewsRef.value } as never) })
  app.mount(container)
  return viewsRef
}

describe('MetaViewManager — reloadLatestConfig / dismissLiveRefreshNotice stay bespoke (T3 errata pin: not misrouted into the T3/plain reclaim)', () => {
  it('dismissLiveRefreshNotice ("Dismiss") stays a native <button class="meta-view-mgr__btn-inline">, never mt-link/mt-button, and still dismisses on click', async () => {
    const viewsRef = mountReactive()
    configBtn()!.click() // openConfig(view_1) → captures the source signature, draft stays clean
    await nextTick()
    // No local edit is made, so viewConfigDirty stays false. Changing the SOURCE view (name) while the
    // draft is clean routes into the live-refresh branch (hydrateExistingViewConfig sets
    // viewConfigLiveRefreshText), which renders the Dismiss control — not the Reload-latest one.
    viewsRef.value = [{ ...views[0], name: 'Grid Renamed' }]
    await nextTick()
    await nextTick()
    const dismissBtn = container!.querySelector('.meta-view-mgr__refresh .meta-view-mgr__btn-inline') as HTMLButtonElement | null
    expect(dismissBtn).not.toBeNull()
    expect(dismissBtn!.tagName).toBe('BUTTON')
    expect(dismissBtn!.classList.contains('meta-view-mgr__btn-inline')).toBe(true)
    expect(dismissBtn!.classList.contains('mt-link')).toBe(false)
    expect(dismissBtn!.classList.contains('mt-button')).toBe(false)
    dismissBtn!.click() // dismissLiveRefreshNotice() → viewConfigLiveRefreshText = ''
    await nextTick()
    expect(container!.querySelector('.meta-view-mgr__refresh')).toBeNull()
  })

  it('reloadLatestConfig ("Reload latest") stays a native <button class="meta-view-mgr__btn-inline">, never mt-link/mt-button, and still reloads on click', async () => {
    const viewsRef = mountReactive()
    configBtn()!.click() // openConfig(view_1)
    await nextTick()
    addSortBtn()!.click() // dirty the draft (sortDraft.rules gains a row) so the next source change
    await nextTick()      // routes into the outdated/Reload branch instead of the live-refresh one
    expect(container!.querySelectorAll('.meta-view-mgr__rule-row').length).toBeGreaterThan(0)
    viewsRef.value = [{ ...views[0], name: 'Grid Renamed' }]
    await nextTick()
    await nextTick()
    const reloadBtn = container!.querySelector('.meta-view-mgr__warning .meta-view-mgr__btn-inline') as HTMLButtonElement | null
    expect(reloadBtn).not.toBeNull()
    expect(reloadBtn!.tagName).toBe('BUTTON')
    expect(reloadBtn!.classList.contains('meta-view-mgr__btn-inline')).toBe(true)
    expect(reloadBtn!.classList.contains('mt-link')).toBe(false)
    expect(reloadBtn!.classList.contains('mt-button')).toBe(false)
    reloadBtn!.click() // reloadLatestConfig() → hydrateExistingViewConfig(view) resets the dirty sort edit
    await nextTick()
    expect(container!.querySelector('.meta-view-mgr__warning')).toBeNull()
    expect(container!.querySelectorAll('.meta-view-mgr__rule-row').length).toBe(0)
  })
})

describe('MetaViewManager — MtIconButton migration (UI-P2-1c T1 batch-7, header close-×)', () => {
  it('renders the header close-× as a native <button> (MtIconButton) keeping the class + glyph', () => {
    mount()
    const btn = closeBtn()!
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.getAttribute('type')).toBe('button')
    expect(btn.classList.contains('meta-view-mgr__close')).toBe(true)
    expect(btn.textContent?.trim()).toBe('×') // × glyph char preserved (size token-normalized)
  })

  it('clicking the header close-× still calls requestClose -> emits SAME `close` event (no unsaved drafts, no confirm gate)', async () => {
    const onClose = vi.fn()
    mount({ onClose })
    closeBtn()!.click()
    await nextTick()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('POSITIVE CONTROL: the unmigrated remove-filter-rule × (removeFilterRule, same glyph, different button) still fires — proves this migration left it alone AND that this file can observe these buttons', async () => {
    mount()
    configBtn()!.click() // openConfig(view) → configTarget set → config panel renders
    await nextTick()
    addFilterBtn()!.click() // addFilterRule() — out of scope, itself already-migrated MtButton plain (T3 errata)
    await nextTick()

    expect(container!.querySelectorAll('.meta-view-mgr__rule-row--filter').length).toBe(1)

    const removeBtn = container!.querySelector(
      '.meta-view-mgr__rule-row--filter .meta-view-mgr__action--danger',
    ) as HTMLButtonElement
    expect(removeBtn).toBeTruthy()
    removeBtn.click() // removeFilterRule(0)
    await nextTick()

    // unchanged behavior, untouched by this migration
    expect(container!.querySelectorAll('.meta-view-mgr__rule-row--filter').length).toBe(0)
  })
})
