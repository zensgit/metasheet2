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

  function mountField(field: { id: string; name: string; type: string }, modelValue: unknown, handlers: Record<string, unknown> = {}) {
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
})
