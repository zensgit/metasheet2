import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaViewManager from '../src/multitable/components/MetaViewManager.vue'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c: MetaViewManager's two `meta-view-mgr__btn-add` controls (add-section "Add view" + config-panel
// "Save settings") were migrated from bespoke <button>s to MtButton variant="primary". Because the class is
// shared across both, BOTH were migrated at once and the bespoke #409eff CSS removed (normalized to
// --ms-color-primary; no double-styling). Separate-class cancel/delete/inline buttons stay bespoke.
// Behavior-preservation proof: both stay native <button>s; :disabled survives; clicking Add view still emits
// `create-view` with the same payload. (Save settings' click behavior is the existing multitable-view-manager
// spec's regression anchor.)

const fields = [{ id: 'fld_name', name: 'Name', type: 'string' as const }]
const views = [{ id: 'view_1', sheetId: 'sheet_1', name: 'Grid', type: 'grid' }]

let app: App | null = null; let container: HTMLDivElement | null = null
afterEach(() => { app?.unmount(); container?.remove(); app = null; container = null; useLocale().setLocale('en') })

function mount(handlers: Record<string, unknown> = {}) {
  container = document.createElement('div'); document.body.appendChild(container)
  app = createApp({ render: () => h(MetaViewManager, { visible: true, sheetId: 'sheet_1', activeViewId: 'view_1', fields, views, ...handlers } as never) })
  app.mount(container)
}
const addView = () => container!.querySelector('.meta-view-mgr__btn-add') as HTMLButtonElement // only one on mount (config closed)
const configBtn = () => container!.querySelector('.meta-view-mgr__action[title="Configure"]') as HTMLButtonElement | null

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
