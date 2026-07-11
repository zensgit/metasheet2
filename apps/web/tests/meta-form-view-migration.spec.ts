import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaFormView from '../src/multitable/components/MetaFormView.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c batch7: MetaFormView's footer Reset control (`.meta-form-view__reset`, always
// `type="button"`) was migrated from a bespoke <button> to the shared MtButton primitive (ghost —
// the bespoke #ddd-bordered/#fff/#666 neutral action). Its class is unique (no other sharer), so the
// bespoke hex CSS was removed. Everything else in this component's actions row stays bespoke:
// - `.meta-form-view__submit` is `type="submit"` (relies on native <form> submission) — NOT
//   byte-equivalent to MtButton, which always renders `type="button"`.
// - `.meta-form-view__nav` / `__nav--next` (prev/next page) share a class, and `--next` is a
//   soft-tinted (#ecf5ff) variant with no clean MtButton mapping — deferred (see MetaFormView.vue's
//   inline comment + the batch7 PR body).
// Behavior-preservation proof: Reset stays a native, keyboard-operable <button>, rendered only when
// `record` is set (v-if="record" preserved); clicking it still runs the SAME resetForm() — gated by
// window.confirm() when there are unsaved changes, resyncing formData from props.record either way.

const fields: MetaField[] = [
  { id: 'fld_title', name: 'Title', type: 'string' },
]

function recordOf(over: Partial<MetaRecord> = {}): MetaRecord {
  return { id: 'rec_1', version: 1, data: { fld_title: 'Original' }, ...over }
}

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  expect(document.querySelectorAll('.meta-form-view').length).toBe(0) // residue guard
  useLocale().setLocale('en')
  vi.restoreAllMocks()
})

function mount(props: Record<string, unknown>) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const app = createApp({
    render: () => h(MetaFormView, {
      fields,
      loading: false,
      readOnly: false,
      onSubmit: vi.fn(),
      onOpenLinkPicker: vi.fn(),
      ...props,
    }),
  })
  app.mount(container)
  mounts.push({ app, container })
  return container
}

const resetBtn = (r: HTMLElement) => r.querySelector('.meta-form-view__reset') as HTMLButtonElement | null
const titleInput = (r: HTMLElement) => r.querySelector('#field_fld_title') as HTMLInputElement | null

describe('MetaFormView — MtButton migration (UI-P2-1c batch7)', () => {
  it('does not render Reset when there is no record (v-if="record" preserved)', async () => {
    const root = mount({})
    await flushUi()
    expect(resetBtn(root)).toBeNull()
  })

  it('renders Reset as a native <button> (MtButton, ghost) when a record is present', async () => {
    const root = mount({ record: recordOf() })
    await flushUi()
    const btn = resetBtn(root)
    expect(btn).not.toBeNull()
    expect(btn!.tagName).toBe('BUTTON') // keyboard-operable, not a bare div
    expect(btn!.classList.contains('meta-form-view__reset')).toBe(true) // class kept for selector stability
    expect(btn!.classList.contains('mt-button--ghost')).toBe(true) // default variant, byte-matches old neutral bespoke style
    expect(btn!.getAttribute('type')).toBe('button') // MtButton always type=button — matches the OLD explicit type="button"
  })

  it('clicking Reset with no unsaved changes runs resetForm() without prompting confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm')
    const root = mount({ record: recordOf() })
    await flushUi()

    resetBtn(root)!.click()
    await flushUi()

    expect(confirmSpy).not.toHaveBeenCalled() // hasUnsavedChanges is false → no prompt
    expect(titleInput(root)!.value).toBe('Original')
  })

  it('clicking Reset with unsaved changes prompts confirm(); declining leaves the edit in place', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const root = mount({ record: recordOf() })
    await flushUi()

    titleInput(root)!.value = 'Edited'
    titleInput(root)!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    resetBtn(root)!.click()
    await flushUi()

    expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved changes?')
    expect(titleInput(root)!.value).toBe('Edited') // declined discard → NOT reset (same handler as before)
  })

  it('clicking Reset with unsaved changes + confirmed discard resyncs formData from props.record', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const root = mount({ record: recordOf() })
    await flushUi()

    titleInput(root)!.value = 'Edited'
    titleInput(root)!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    resetBtn(root)!.click()
    await flushUi()

    expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved changes?')
    expect(titleInput(root)!.value).toBe('Original') // confirmed discard → syncFromRecord(props.record)
  })

  it('Reset stays disabled-free and independent of Submit (type="submit" — Reset never triggers onSubmit)', async () => {
    const onSubmit = vi.fn()
    const root = mount({ record: recordOf(), onSubmit })
    await flushUi()

    resetBtn(root)!.click()
    await flushUi()

    expect(onSubmit).not.toHaveBeenCalled() // MtButton's forced type="button" — no native form-submit side effect
  })
})
