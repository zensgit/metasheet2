/**
 * P3-B (grid-commit-reliability round 2): a local edit made before the Yjs binding activates —
 * concretely D1's type-to-edit seed character, which sets `modelValue` and mounts MetaCellEditor
 * before any Y.Doc has connected — must be forwarded into Y.Text the instant the binding activates,
 * or it silently vanishes: the input's `:value` binding switches from `modelValue` to `yjsText` right
 * then, and nothing else ever writes the seed into Y.Text.
 *
 * Uses the SAME mock shape as multitable-yjs-cell-editor.spec.ts: `useYjsCellBinding` returns real Vue
 * refs the test can mutate directly (`active.value = true`) after mount to simulate the connection
 * completing asynchronously, exactly as the real composable's timeline works.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'

const useYjsCellBindingMock = vi.fn(() => ({
  active: ref(false),
  text: ref(''),
  setText: vi.fn(),
  collaborators: ref([]),
  release: vi.fn(),
}))

vi.mock('../src/multitable/composables/useYjsCellBinding', () => ({
  useYjsCellBinding: (...args: unknown[]) => useYjsCellBindingMock(...args),
  isYjsCollabEnabled: () => false,
}))

async function loadEditor() {
  return (await import('../src/multitable/components/cells/MetaCellEditor.vue')).default
}

type YjsBindingHandle = {
  active: { value: boolean }
  text: { value: string }
  setText: ReturnType<typeof vi.fn>
}

describe('MetaCellEditor Yjs seed-forwarding (P3-B)', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    useYjsCellBindingMock.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  // Single mount helper (not one `defineComponent`/`createApp` literal per test) so the file stays
  // one-component-per-file clean while each test still gets its own fresh editor instance + binding.
  async function mountEditorWithModelValue(modelValue: unknown): Promise<YjsBindingHandle> {
    const MetaCellEditor = await loadEditor()
    app = createApp({
      render() {
        // modelValue mirrors exactly what D1's seed sets before this editor ever mounts.
        return h(MetaCellEditor, {
          field: { id: 'fld_title', name: 'Title', type: 'string' },
          modelValue,
          recordId: 'rec_1',
          'onUpdate:modelValue': vi.fn(),
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
          onOpenLinkPicker: vi.fn(),
        })
      },
    })
    app.mount(container!)
    await nextTick()
    return useYjsCellBindingMock.mock.results[0]!.value as YjsBindingHandle
  }

  it('forwards a pending local draft into Y.Text the instant the binding activates over an empty field', async () => {
    const binding = await mountEditorWithModelValue('a')
    expect(binding.setText).not.toHaveBeenCalled() // not yet active — nothing to forward yet

    binding.active.value = true // connection completes; server had nothing synced (text stays '')
    await nextTick()

    expect(binding.setText).toHaveBeenCalledTimes(1)
    expect(binding.setText).toHaveBeenCalledWith('a')
  })

  it('does NOT forward when Y.Text already holds synced content (never clobbers a collaborator)', async () => {
    const binding = await mountEditorWithModelValue('a')
    binding.text.value = 'already synced by someone else'
    binding.active.value = true
    await nextTick()

    expect(binding.setText).not.toHaveBeenCalled()
  })

  it('does NOT forward an empty local draft (no seed pending — a normal, untouched edit-session open)', async () => {
    const binding = await mountEditorWithModelValue('')
    binding.active.value = true
    await nextTick()

    expect(binding.setText).not.toHaveBeenCalled()
  })
})
