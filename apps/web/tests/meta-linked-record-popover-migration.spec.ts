// UI-P2-1c T1 batch-1: MetaLinkedRecordPopover's header close-× (`.meta-linked-record-popover__close`)
// was migrated from a bespoke <button>&times;</button> to the shared MtIconButton primitive — the
// &times; glyph passes through MtIconButton's default-slot icon fallback (glyph char preserved, size token-normalized) (T1 design-lock
// recommendation: keep the glyph, only collapse padding/hover/focus-ring onto tokens), so there is
// token-normalized (× glyph char preserved; glyph size + control shape normalized to the icon
// token, consistent with the existing glyph-MtIconButton controls already on main). Behavior-preservation proof: it stays a native, keyboard-operable <button>,
// keeps the SAME aria-label (`l('linkedRecord.close')`), and clicking it still emits the SAME
// `close` event with no payload. This is the only sharer of `.meta-linked-record-popover__close`
// (single button, single file) — its bespoke CSS was removed outright, no double-styling risk.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import MetaLinkedRecordPopover from '../src/multitable/components/MetaLinkedRecordPopover.vue'
import { useLocale } from '../src/composables/useLocale'
import type { MetaRecordContext } from '../src/multitable/types'

const mounts: Array<{ app: VueApp; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  useLocale().setLocale('en')
})

function mount(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(MetaLinkedRecordPopover, {
    visible: true,
    recordId: null,
    fetchRecord: vi.fn(async () => ({}) as MetaRecordContext),
    ...props,
  })
  app.mount(container)
  mounts.push({ app, container })
  return container
}

const closeBtn = (container: HTMLDivElement) =>
  container.querySelector('.meta-linked-record-popover__close') as HTMLButtonElement

describe('MetaLinkedRecordPopover — close-× MtIconButton migration (UI-P2-1c T1 batch-1)', () => {
  it('renders the close control as a native <button> (MtIconButton) keeping the class + aria-label', () => {
    useLocale().setLocale('en')
    const container = mount({})
    const btn = closeBtn(container)
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('meta-linked-record-popover__close')).toBe(true)
    expect(btn.getAttribute('aria-label')).toBe('Close')
  })

  it('renders the localized (zh) aria-label unchanged', () => {
    useLocale().setLocale('zh')
    const container = mount({})
    expect(closeBtn(container).getAttribute('aria-label')).toBe('关闭')
  })

  it('renders the &times; glyph char (token-normalized size)', () => {
    useLocale().setLocale('en')
    const container = mount({})
    expect(closeBtn(container).textContent?.trim()).toBe('×')
  })

  it('clicking close emits `close` with no payload (unchanged from the pre-migration @click)', async () => {
    const onClose = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp(MetaLinkedRecordPopover, {
      visible: true,
      recordId: null,
      fetchRecord: vi.fn(async () => ({}) as MetaRecordContext),
      onClose,
    })
    app.mount(container)
    mounts.push({ app, container })
    await nextTick()
    closeBtn(container).click()
    await nextTick()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith()
  })
})
