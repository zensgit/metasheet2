import { describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaCellRenderer from '../src/multitable/components/cells/MetaCellRenderer.vue'
import MetaCellEditor from '../src/multitable/components/cells/MetaCellEditor.vue'
import MetaRichLongTextEditor from '../src/multitable/components/cells/MetaRichLongTextEditor.vue'

// Wiring tests (§6.3/§6.4/§7): verify each surface picks the rich path for a
// `rich` longText field and the unchanged plain path otherwise (backward-compat).

const RICH = { id: 'fld_rt', name: 'Notes', type: 'longText', property: { rich: true } }
const PLAIN = { id: 'fld_pt', name: 'Notes', type: 'longText' }

function mount(component: unknown, props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(component as never, props) })
  app.mount(container)
  return { container, app }
}

describe('grid cell (MetaCellRenderer) — §7 plain-text projection for rich', () => {
  it('shows tag-stripped text (not HTML) for a rich longText cell', async () => {
    const { container, app } = mount(MetaCellRenderer, {
      field: RICH,
      value: '<p>Hello <strong>World</strong></p>',
    })
    await nextTick()
    const cell = container.querySelector('.meta-cell-renderer__long-text') as HTMLElement
    // No element children -> rendered as plain text, not parsed HTML.
    expect(cell.querySelector('strong')).toBeNull()
    expect(cell.querySelector('p')).toBeNull()
    expect(cell.textContent).toContain('Hello')
    expect(cell.textContent).toContain('World')
    // The literal markup must NOT appear as escaped text in the grid either.
    expect(cell.textContent).not.toContain('<p>')
    app.unmount()
    container.remove()
  })

  it('never renders a script tag from a rich cell value', async () => {
    const { container, app } = mount(MetaCellRenderer, {
      field: RICH,
      value: '<script>window.__gridpwn = 1</script>visible',
    })
    await nextTick()
    const cell = container.querySelector('.meta-cell-renderer__long-text') as HTMLElement
    expect(cell.querySelector('script')).toBeNull()
    expect(cell.textContent).toContain('visible')
    expect((window as unknown as { __gridpwn?: number }).__gridpwn).toBeUndefined()
    app.unmount()
    container.remove()
  })

  it('plain longText cell display is unchanged (escaped multiline text)', async () => {
    const { container, app } = mount(MetaCellRenderer, {
      field: PLAIN,
      value: 'line 1\nline 2',
    })
    await nextTick()
    const cell = container.querySelector('.meta-cell-renderer__long-text') as HTMLElement
    expect(cell.textContent).toBe('line 1\nline 2')
    app.unmount()
    container.remove()
  })
})

describe('cell editor (MetaCellEditor) — rich vs plain editor selection', () => {
  it('renders the rich editor (contenteditable) for a rich longText field', async () => {
    const { container, app } = mount(MetaCellEditor, {
      field: RICH,
      modelValue: '<strong>hi</strong>',
      recordId: 'rec_1',
      'onUpdate:modelValue': vi.fn(),
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
      onOpenLinkPicker: vi.fn(),
    })
    await nextTick()
    expect(container.querySelector('[data-test="rich-longtext-editor"]')).not.toBeNull()
    // The plain textarea path must NOT be used for a rich field.
    expect(container.querySelector('textarea.meta-cell-editor__textarea')).toBeNull()
    app.unmount()
    container.remove()
  })

  it('renders the plain textarea for a non-rich longText field (unchanged)', async () => {
    const { container, app } = mount(MetaCellEditor, {
      field: PLAIN,
      modelValue: 'plain',
      recordId: 'rec_1',
      'onUpdate:modelValue': vi.fn(),
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
      onOpenLinkPicker: vi.fn(),
    })
    await nextTick()
    expect(container.querySelector('textarea.meta-cell-editor__textarea')).not.toBeNull()
    expect(container.querySelector('[data-test="rich-longtext-editor"]')).toBeNull()
    app.unmount()
    container.remove()
  })

  it('the rich editor emits sanitized HTML on input', async () => {
    const updateSpy = vi.fn()
    const { container, app } = mount(MetaCellEditor, {
      field: RICH,
      modelValue: '',
      recordId: 'rec_1',
      'onUpdate:modelValue': updateSpy,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
      onOpenLinkPicker: vi.fn(),
    })
    await nextTick()
    const editable = container.querySelector('[data-test="rich-longtext-editor"]') as HTMLElement
    // Simulate a malicious DOM mutation then an input event.
    editable.innerHTML = '<img src=x onerror="window.__editpwn = 1"><b>kept</b>'
    editable.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(updateSpy).toHaveBeenCalled()
    const emitted = updateSpy.mock.calls.at(-1)?.[0] as string
    expect(emitted.toLowerCase()).not.toContain('onerror')
    expect(emitted.toLowerCase()).not.toContain('<img')
    expect(emitted).toContain('<b>kept</b>')
    app.unmount()
    container.remove()
  })
})

describe('MetaRichLongTextEditor — commit semantics (drawer PATCH-on-blur, no flood)', () => {
  function mountEditor(handlers: Record<string, unknown>) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      render: () => h(MetaRichLongTextEditor, { modelValue: '', ...handlers }),
    })
    app.mount(container)
    return { container, app }
  }

  it('emits `change` only on blur (commit), not on every input', async () => {
    const changeSpy = vi.fn()
    const updateSpy = vi.fn()
    const { container, app } = mountEditor({
      'onUpdate:modelValue': updateSpy,
      onChange: changeSpy,
    })
    await nextTick()
    const editable = container.querySelector('[data-test="rich-longtext-editor"]') as HTMLElement
    editable.innerHTML = '<b>typing</b>'
    editable.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    // Live updates fired, but no commit yet.
    expect(updateSpy).toHaveBeenCalled()
    expect(changeSpy).not.toHaveBeenCalled()
    // Blur = commit → exactly one `change`.
    editable.dispatchEvent(new Event('blur', { bubbles: true }))
    await nextTick()
    expect(changeSpy).toHaveBeenCalledTimes(1)
    expect(changeSpy.mock.calls[0]?.[0]).toContain('<b>typing</b>')
    app.unmount()
    container.remove()
  })

  it('the `change` value is sanitized (commit cannot carry unsafe markup)', async () => {
    const changeSpy = vi.fn()
    const { container, app } = mountEditor({ onChange: changeSpy })
    await nextTick()
    const editable = container.querySelector('[data-test="rich-longtext-editor"]') as HTMLElement
    editable.innerHTML = '<img src=x onerror="window.__blurpwn = 1"><i>ok</i>'
    editable.dispatchEvent(new Event('blur', { bubbles: true }))
    await nextTick()
    const committed = changeSpy.mock.calls.at(-1)?.[0] as string
    expect(committed.toLowerCase()).not.toContain('onerror')
    expect(committed.toLowerCase()).not.toContain('<img')
    expect(committed).toContain('<i>ok</i>')
    app.unmount()
    container.remove()
  })

  it('does NOT rewrite innerHTML while focused (caret-jump guard)', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      data: () => ({ html: '<b>start</b>' }),
      render(this: { html: unknown }) {
        return h(MetaRichLongTextEditor, { modelValue: this.html })
      },
      mounted(this: Record<string, unknown>) {
        this.setHtml = (v: unknown) => { (this as { html: unknown }).html = v }
      },
    })
    const vm = app.mount(container) as unknown as { setHtml: (v: unknown) => void }
    await nextTick()
    const editable = container.querySelector('[data-test="rich-longtext-editor"]') as HTMLElement
    // Simulate the user actively editing: focus + local DOM change.
    editable.dispatchEvent(new Event('focus', { bubbles: true }))
    editable.innerHTML = '<b>user is typing here</b>'
    // An external model change arrives while focused — must NOT stomp the live DOM.
    vm.setHtml('<b>start</b>')
    await nextTick()
    expect(editable.innerHTML).toBe('<b>user is typing here</b>')
    app.unmount()
    container.remove()
  })
})
