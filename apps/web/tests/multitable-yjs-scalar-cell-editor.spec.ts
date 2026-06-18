import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App, type Ref } from 'vue'

// Controllable scalar-binding mock: tests flip `scalarActive`/`scalarVal` to
// exercise the active (Yjs) vs inactive (REST) paths of MetaCellEditor's
// scalar wiring, and assert setValue gets the correctly-TYPED value.
let scalarActive: Ref<boolean>
let scalarVal: Ref<unknown>
const setValueMock = vi.fn()
const useYjsScalarCellMock = vi.fn(() => ({
  active: scalarActive,
  value: scalarVal,
  setValue: setValueMock,
  release: vi.fn(),
}))

vi.mock('../src/multitable/composables/useYjsScalarCell', () => ({
  useYjsScalarCell: (...args: unknown[]) => useYjsScalarCellMock(...args),
}))
// Keep the text binding inert so it never interferes with scalar tests.
vi.mock('../src/multitable/composables/useYjsCellBinding', () => ({
  useYjsCellBinding: () => ({ active: ref(false), text: ref(''), setText: vi.fn(), collaborators: ref([]), release: vi.fn() }),
}))

async function loadEditor() {
  return (await import('../src/multitable/components/cells/MetaCellEditor.vue')).default
}

describe('MetaCellEditor scalar Yjs wiring', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    setValueMock.mockClear()
    useYjsScalarCellMock.mockClear()
    scalarActive = ref(false)
    scalarVal = ref(undefined)
    container = document.createElement('div')
    document.body.appendChild(container)
  })
  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  function mountField(field: { id: string; name: string; type: string; options?: Array<{ value: string }> }, modelValue: unknown, handlers: Record<string, unknown> = {}) {
    app = createApp(defineComponent({
      render() {
        return h(loadedEditor, {
          field, modelValue, recordId: 'rec_1',
          'onUpdate:modelValue': vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn(), onOpenLinkPicker: vi.fn(),
          ...handlers,
        })
      },
    }))
    app.mount(container!)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let loadedEditor: any
  beforeEach(async () => { loadedEditor = await loadEditor() })

  it('constructs a scalar binding for a number field with a record id', () => {
    mountField({ id: 'fld_qty', name: 'Qty', type: 'number' }, 1)
    expect(useYjsScalarCellMock).toHaveBeenCalledTimes(1)
  })

  it('does NOT construct a scalar binding for a string field (text uses the Y.Text binding)', () => {
    mountField({ id: 'fld_title', name: 'Title', type: 'string' }, 'hi')
    expect(useYjsScalarCellMock).not.toHaveBeenCalled()
  })

  it('active number: input writes the typed Number via setValue + emits update:modelValue; Enter emits yjs-commit then confirm', async () => {
    scalarActive.value = true
    scalarVal.value = 5
    const onUpdate = vi.fn(); const onConfirm = vi.fn(); const onYjsCommit = vi.fn()
    mountField({ id: 'fld_qty', name: 'Qty', type: 'number' }, 5, { 'onUpdate:modelValue': onUpdate, onConfirm, onYjsCommit })
    const input = container!.querySelector('input[type="number"]') as HTMLInputElement
    expect(input).toBeTruthy()
    input.value = '42'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    expect(setValueMock).toHaveBeenCalledWith(42) // native number, not '42'
    expect(onUpdate).toHaveBeenCalledWith(42)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await nextTick()
    expect(onYjsCommit).toHaveBeenCalled()
    expect(onConfirm).toHaveBeenCalled()
  })

  it('inactive number: REST path byte-identical — setValue not called, no yjs-commit on Enter', async () => {
    scalarActive.value = false
    const onUpdate = vi.fn(); const onConfirm = vi.fn(); const onYjsCommit = vi.fn()
    mountField({ id: 'fld_qty', name: 'Qty', type: 'number' }, 5, { 'onUpdate:modelValue': onUpdate, onConfirm, onYjsCommit })
    const input = container!.querySelector('input[type="number"]') as HTMLInputElement
    input.value = '7'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    expect(setValueMock).not.toHaveBeenCalled()
    expect(onUpdate).toHaveBeenCalledWith(7)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await nextTick()
    expect(onYjsCommit).not.toHaveBeenCalled()
    expect(onConfirm).toHaveBeenCalled()
  })

  it('active boolean: change writes the boolean via setValue + emits yjs-commit then confirm', async () => {
    scalarActive.value = true
    scalarVal.value = false
    const onUpdate = vi.fn(); const onConfirm = vi.fn(); const onYjsCommit = vi.fn()
    mountField({ id: 'fld_done', name: 'Done', type: 'boolean' }, false, { 'onUpdate:modelValue': onUpdate, onConfirm, onYjsCommit })
    const box = container!.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(box).toBeTruthy()
    box.checked = true
    box.dispatchEvent(new Event('change'))
    await nextTick()
    expect(setValueMock).toHaveBeenCalledWith(true) // native boolean
    expect(onUpdate).toHaveBeenCalledWith(true)
    expect(onYjsCommit).toHaveBeenCalled()
    expect(onConfirm).toHaveBeenCalled()
  })

  it('inactive boolean: setValue not called, no yjs-commit (REST unchanged)', async () => {
    scalarActive.value = false
    const onUpdate = vi.fn(); const onConfirm = vi.fn(); const onYjsCommit = vi.fn()
    mountField({ id: 'fld_done', name: 'Done', type: 'boolean' }, false, { 'onUpdate:modelValue': onUpdate, onConfirm, onYjsCommit })
    const box = container!.querySelector('input[type="checkbox"]') as HTMLInputElement
    box.checked = true
    box.dispatchEvent(new Event('change'))
    await nextTick()
    expect(setValueMock).not.toHaveBeenCalled()
    expect(onUpdate).toHaveBeenCalledWith(true)
    expect(onYjsCommit).not.toHaveBeenCalled()
    expect(onConfirm).toHaveBeenCalled()
  })

  it('active rating: star pick writes the native Number via setValue + yjs-commit then confirm; clear writes null', async () => {
    scalarActive.value = true
    scalarVal.value = 2
    const onUpdate = vi.fn(); const onConfirm = vi.fn(); const onYjsCommit = vi.fn()
    mountField({ id: 'fld_score', name: 'Score', type: 'rating' }, 2, { 'onUpdate:modelValue': onUpdate, onConfirm, onYjsCommit })
    const stars = container!.querySelectorAll('.meta-cell-editor__rating-star')
    expect(stars.length).toBe(5)
    ;(stars[2] as HTMLButtonElement).click() // pick 3
    await nextTick()
    expect(setValueMock).toHaveBeenCalledWith(3) // native number, not '3'
    expect(onUpdate).toHaveBeenCalledWith(3)
    expect(onYjsCommit).toHaveBeenCalled()
    expect(onConfirm).toHaveBeenCalled()
    // clear → null (the field-clear shape REST would write)
    const clear = container!.querySelector('.meta-cell-editor__rating-clear') as HTMLButtonElement
    expect(clear).toBeTruthy()
    clear.click()
    await nextTick()
    expect(setValueMock).toHaveBeenLastCalledWith(null)
    expect(onUpdate).toHaveBeenLastCalledWith(null)
  })

  it('inactive rating: REST path byte-identical — setValue not called, no yjs-commit', async () => {
    scalarActive.value = false
    const onUpdate = vi.fn(); const onConfirm = vi.fn(); const onYjsCommit = vi.fn()
    mountField({ id: 'fld_score', name: 'Score', type: 'rating' }, 2, { 'onUpdate:modelValue': onUpdate, onConfirm, onYjsCommit })
    const stars = container!.querySelectorAll('.meta-cell-editor__rating-star')
    ;(stars[2] as HTMLButtonElement).click()
    await nextTick()
    expect(setValueMock).not.toHaveBeenCalled()
    expect(onUpdate).toHaveBeenCalledWith(3)
    expect(onYjsCommit).not.toHaveBeenCalled()
    expect(onConfirm).toHaveBeenCalled()
  })

  it('active multiSelect: change writes the plain string[] via setValue + emits update; meta+Enter emits yjs-commit then confirm', async () => {
    scalarActive.value = true
    scalarVal.value = ['a']
    const onUpdate = vi.fn(); const onConfirm = vi.fn(); const onYjsCommit = vi.fn()
    mountField(
      { id: 'fld_tags', name: 'Tags', type: 'multiSelect', options: [{ value: 'a' }, { value: 'b' }, { value: 'c' }] },
      ['a'],
      { 'onUpdate:modelValue': onUpdate, onConfirm, onYjsCommit },
    )
    const select = container!.querySelector('select.meta-cell-editor__select--multi') as HTMLSelectElement
    expect(select).toBeTruthy()
    Array.from(select.options).forEach((o) => { o.selected = o.value === 'a' || o.value === 'c' })
    select.dispatchEvent(new Event('change'))
    await nextTick()
    expect(setValueMock).toHaveBeenCalledWith(['a', 'c']) // plain string[], not a Y.Array
    expect(onUpdate).toHaveBeenCalledWith(['a', 'c'])
    select.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))
    await nextTick()
    expect(onYjsCommit).toHaveBeenCalled()
    expect(onConfirm).toHaveBeenCalled()
  })

  it('inactive multiSelect: REST path byte-identical — setValue not called, no yjs-commit', async () => {
    scalarActive.value = false
    const onUpdate = vi.fn(); const onConfirm = vi.fn(); const onYjsCommit = vi.fn()
    mountField(
      { id: 'fld_tags', name: 'Tags', type: 'multiSelect', options: [{ value: 'a' }, { value: 'b' }, { value: 'c' }] },
      ['a'],
      { 'onUpdate:modelValue': onUpdate, onConfirm, onYjsCommit },
    )
    const select = container!.querySelector('select.meta-cell-editor__select--multi') as HTMLSelectElement
    Array.from(select.options).forEach((o) => { o.selected = o.value === 'b' })
    select.dispatchEvent(new Event('change'))
    await nextTick()
    expect(setValueMock).not.toHaveBeenCalled()
    expect(onUpdate).toHaveBeenCalledWith(['b'])
    select.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))
    await nextTick()
    expect(onYjsCommit).not.toHaveBeenCalled()
    expect(onConfirm).toHaveBeenCalled()
  })

  // --- 2a-1: string-stored atomics select / date (dual-reader; value = exact stored shape) ---
  it('active select: change writes the option-value string via setValue + emits yjs-commit then confirm', async () => {
    scalarActive.value = true
    scalarVal.value = 'optA'
    const onUpdate = vi.fn(); const onConfirm = vi.fn(); const onYjsCommit = vi.fn()
    mountField({ id: 'fld_status', name: 'Status', type: 'select', options: [{ value: 'optA' }, { value: 'optB' }] }, 'optA', { 'onUpdate:modelValue': onUpdate, onConfirm, onYjsCommit })
    const select = container!.querySelector('select') as HTMLSelectElement
    expect(select).toBeTruthy()
    select.value = 'optB'
    select.dispatchEvent(new Event('change'))
    await nextTick()
    expect(setValueMock).toHaveBeenCalledWith('optB')
    expect(onUpdate).toHaveBeenCalledWith('optB')
    expect(onYjsCommit).toHaveBeenCalled()
    expect(onConfirm).toHaveBeenCalled()
  })

  it('inactive select: REST byte-identical — setValue not called, no yjs-commit', async () => {
    scalarActive.value = false
    const onUpdate = vi.fn(); const onConfirm = vi.fn(); const onYjsCommit = vi.fn()
    mountField({ id: 'fld_status', name: 'Status', type: 'select', options: [{ value: 'optA' }, { value: 'optB' }] }, 'optA', { 'onUpdate:modelValue': onUpdate, onConfirm, onYjsCommit })
    const select = container!.querySelector('select') as HTMLSelectElement
    select.value = 'optB'
    select.dispatchEvent(new Event('change'))
    await nextTick()
    expect(setValueMock).not.toHaveBeenCalled()
    expect(onUpdate).toHaveBeenCalledWith('optB')
    expect(onYjsCommit).not.toHaveBeenCalled()
    expect(onConfirm).toHaveBeenCalled()
  })

  it('active date: input writes the date string via setValue; Enter emits yjs-commit then confirm', async () => {
    scalarActive.value = true
    scalarVal.value = '2026-01-01'
    const onUpdate = vi.fn(); const onConfirm = vi.fn(); const onYjsCommit = vi.fn()
    mountField({ id: 'fld_day', name: 'Day', type: 'date' }, '2026-01-01', { 'onUpdate:modelValue': onUpdate, onConfirm, onYjsCommit })
    const input = container!.querySelector('input[type="date"]') as HTMLInputElement
    expect(input).toBeTruthy()
    input.value = '2026-02-02'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    expect(setValueMock).toHaveBeenCalledWith('2026-02-02')
    expect(onUpdate).toHaveBeenCalledWith('2026-02-02')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await nextTick()
    expect(onYjsCommit).toHaveBeenCalled()
    expect(onConfirm).toHaveBeenCalled()
  })

  it('inactive date: REST byte-identical — setValue not called, no yjs-commit', async () => {
    scalarActive.value = false
    const onUpdate = vi.fn(); const onConfirm = vi.fn(); const onYjsCommit = vi.fn()
    mountField({ id: 'fld_day', name: 'Day', type: 'date' }, '2026-01-01', { 'onUpdate:modelValue': onUpdate, onConfirm, onYjsCommit })
    const input = container!.querySelector('input[type="date"]') as HTMLInputElement
    input.value = '2026-02-02'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    expect(setValueMock).not.toHaveBeenCalled()
    expect(onUpdate).toHaveBeenCalledWith('2026-02-02')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await nextTick()
    expect(onYjsCommit).not.toHaveBeenCalled()
    expect(onConfirm).toHaveBeenCalled()
  })
})
