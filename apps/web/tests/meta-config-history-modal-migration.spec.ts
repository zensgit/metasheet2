// UI-P2-1c T1 batch-2: MetaConfigHistoryModal's header close-× (`.cfg-history__close`) was migrated
// from a bespoke <button>&times;</button> to the shared MtIconButton primitive — the &times; glyph
// passes through MtIconButton's default-slot icon fallback (glyph char preserved, size
// token-normalized to the icon control, consistent with the existing glyph-MtIconButton controls
// already on main). Behavior-preservation proof: it stays a native, keyboard-operable <button>,
// keeps the SAME aria-label (`l('record.configHistoryClose')`), and clicking it still emits the SAME
// `close` event with no payload (the template's `@click="$emit('close')"` is byte-identical pre/post
// migration). This is the only sharer of `.cfg-history__close` (single button, single file) — its
// bespoke CSS was removed outright, no double-styling risk. The dialog teleports to <body>, so
// queries hit `document`, not the mount container (see also the existing regression coverage in
// multitable-config-history-modal.spec.ts's 'close emits close' test, which stays green unchanged).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import MetaConfigHistoryModal from '../src/multitable/components/MetaConfigHistoryModal.vue'

const mounts: Array<{ app: VueApp; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
})

function mount(props: Record<string, unknown> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(MetaConfigHistoryModal, {
    visible: true,
    items: [],
    loading: false,
    entityType: '',
    recordLabelOf: (id: string) => id,
    isZh: false,
    ...props,
  })
  app.mount(container)
  mounts.push({ app, container })
  return container
}

const closeBtn = () => document.querySelector('.cfg-history__close') as HTMLButtonElement

describe('MetaConfigHistoryModal — close-× MtIconButton migration (UI-P2-1c T1 batch-2)', () => {
  it('renders the close control as a native <button> (MtIconButton) keeping the class + aria-label', () => {
    mount()
    const btn = closeBtn()
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('cfg-history__close')).toBe(true)
    expect(btn.getAttribute('aria-label')).toBe('Close')
  })

  it('renders the localized (zh) aria-label unchanged', () => {
    mount({ isZh: true })
    expect(closeBtn().getAttribute('aria-label')).toBe('关闭')
  })

  it('renders the &times; glyph char (token-normalized size)', () => {
    mount()
    expect(closeBtn().textContent?.trim()).toBe('×')
  })

  it('clicking close emits `close` with no payload (unchanged from the pre-migration @click)', async () => {
    const onClose = vi.fn()
    mount({ onClose })
    await nextTick()
    closeBtn().click()
    await nextTick()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith()
  })
})
