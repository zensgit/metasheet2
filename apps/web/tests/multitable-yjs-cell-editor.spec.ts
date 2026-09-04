import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, ref, type App } from 'vue'

const useYjsCellBindingMock = vi.fn(() => ({
  active: ref(false),
  text: ref(''),
  setText: vi.fn(),
  collaborators: ref([]),
  release: vi.fn(),
}))

vi.mock('../src/multitable/composables/useYjsCellBinding', () => ({
  useYjsCellBinding: (...args: unknown[]) => useYjsCellBindingMock(...args),
  // useYjsScalarCell (now constructed for number cells) imports this from here;
  // the mock must re-export it or the real scalar binding crashes on setup.
  isYjsCollabEnabled: () => false,
}))

async function loadEditor() {
  return (await import('../src/multitable/components/cells/MetaCellEditor.vue')).default
}

describe('MetaCellEditor Yjs binding eligibility', () => {
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

  it('does not construct a Yjs binding for non-string editors', async () => {
    const MetaCellEditor = await loadEditor()

    app = createApp(defineComponent({
      render() {
        return h(MetaCellEditor, {
          field: { id: 'fld_qty', name: 'Quantity', type: 'number' },
          modelValue: 12,
          recordId: 'rec_1',
          'onUpdate:modelValue': vi.fn(),
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
          onOpenLinkPicker: vi.fn(),
        })
      },
    }))

    app.mount(container!)

    expect(useYjsCellBindingMock).not.toHaveBeenCalled()
  })

  it('constructs a Yjs binding for normal string editors with a record id', async () => {
    const MetaCellEditor = await loadEditor()

    app = createApp(defineComponent({
      render() {
        return h(MetaCellEditor, {
          field: { id: 'fld_title', name: 'Title', type: 'string' },
          modelValue: 'hello',
          recordId: 'rec_1',
          'onUpdate:modelValue': vi.fn(),
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
          onOpenLinkPicker: vi.fn(),
        })
      },
    }))

    app.mount(container!)

    expect(useYjsCellBindingMock).toHaveBeenCalledTimes(1)
  })

  // round 3: a SINGLE shared mount helper (props-override style, matching the round-2 grid spec's
  // `mountGrid`) for the P3-2 / NIT tests below — one `h(MetaCellEditor, ...)` literal, reused, so
  // this file gains no MORE `vue/one-component-per-file` instances than the two above already carry.
  async function mountEditor(propsOverride: Record<string, unknown>): Promise<HTMLElement> {
    const MetaCellEditor = await loadEditor()
    app = createApp(defineComponent({
      render() {
        return h(MetaCellEditor, {
          field: { id: 'fld_title', name: 'Title', type: 'string' },
          modelValue: 'hello',
          recordId: 'rec_1',
          'onUpdate:modelValue': vi.fn(),
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
          onOpenLinkPicker: vi.fn(),
          ...propsOverride,
        })
      },
    }))
    app.mount(container!)
    return container!
  }

  // P3-2 (grid-commit-reliability, round 3): onAiRunTab (Tab pressed FROM the
  // in-editor AI-run button) omits the `yjs-commit` emit that onTextTab and
  // onTextBlur both emit when the Yjs text binding is live for this exact
  // cell — the host (MetaGridTable) reads that emit to skip the redundant
  // REST patch once Yjs already carried the edit. Without it, tabbing OUT
  // via the button specifically (as opposed to tabbing out of the `<input>`
  // itself) would leave the host thinking REST still owns the commit.
  it('P3-2: Tab FROM the AI-run button emits yjs-commit when the text binding is active', async () => {
    const onYjsCommit = vi.fn()
    const onTabCommit = vi.fn()
    const root = await mountEditor({
      field: {
        id: 'fld_title',
        name: 'Title',
        type: 'string',
        property: { aiShortcut: { kind: 'summarize', sourceFieldIds: ['fld_title'] } },
      },
      aiRunState: { pending: false, busy: false },
      hostCommitPolicy: 'grid',
      onAiRun: vi.fn(),
      onYjsCommit,
      onTabCommit,
    })

    const binding = useYjsCellBindingMock.mock.results[0]!.value as { active: { value: boolean } }
    binding.active.value = true // connection completes — the text path is now live

    const button = root.querySelector('[data-test="cell-ai-run"]') as HTMLButtonElement
    expect(button).toBeTruthy() // sanity: the button IS rendered in this session

    const evt = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    button.dispatchEvent(evt)

    expect(evt.defaultPrevented).toBe(true)
    expect(onYjsCommit).toHaveBeenCalledTimes(1)
    expect(onTabCommit).toHaveBeenCalledTimes(1)
  })

  // Negative control for the test above: the SAME Tab-from-button path when
  // the binding never activates must NOT emit yjs-commit — proves the emit
  // above is conditioned on `yjsActive`, not unconditional.
  it('P3-2 negative control: Tab FROM the AI-run button does not emit yjs-commit when the binding is inactive', async () => {
    const onYjsCommit = vi.fn()
    const onTabCommit = vi.fn()
    const root = await mountEditor({
      field: {
        id: 'fld_title',
        name: 'Title',
        type: 'string',
        property: { aiShortcut: { kind: 'summarize', sourceFieldIds: ['fld_title'] } },
      },
      aiRunState: { pending: false, busy: false },
      hostCommitPolicy: 'grid',
      onAiRun: vi.fn(),
      onYjsCommit,
      onTabCommit,
    })

    const button = root.querySelector('[data-test="cell-ai-run"]') as HTMLButtonElement
    const evt = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    button.dispatchEvent(evt)

    expect(onYjsCommit).not.toHaveBeenCalled()
    expect(onTabCommit).toHaveBeenCalledTimes(1)
  })

  // NIT (grid-commit-reliability round 3, number-prefix loss — regression guard, event-level):
  // when NO valid numeric draft was EVER reached this edit session (a lone '-' as the very FIRST
  // keystroke), blur must still discard (emit `cancel`), not commit (emit `blur-commit`) — the
  // byte-identical round-2 P3-C behaviour. Deliberately asserted HERE, at the MetaCellEditor level,
  // rather than through the full MetaGridTable integration: when nothing was ever resolved,
  // `editCell`'s staged value in the grid stays at the ORIGINAL row value the whole session, so
  // `confirmEdit`'s own "only if changed" no-patch guard would ALSO produce zero `patch-cell` calls
  // even under a wrongly-permissive mutation (e.g. one that mistakenly starts the round-3
  // `numberHasValidDraft` flag `true`) — a `patchSpy`-only assertion through the grid cannot
  // discriminate that mutation. Checking WHICH event fired (`cancel` vs `blur-commit`) can.
  it('NIT regression guard: a lone "-" as the FIRST keystroke still emits cancel on blur, not blur-commit', async () => {
    const onCancel = vi.fn()
    const onBlurCommit = vi.fn()
    const root = await mountEditor({
      field: { id: 'fld_score', name: 'Score', type: 'number' },
      modelValue: 10,
      recordId: null,
      hostCommitPolicy: 'grid',
      onCancel,
      onBlurCommit,
    })

    const input = root.querySelector('.meta-cell-editor__input') as HTMLInputElement
    input.value = '-'
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '-', inputType: 'insertText' }))
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    input.dispatchEvent(new FocusEvent('blur', { relatedTarget: outside, bubbles: true }))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onBlurCommit).not.toHaveBeenCalled()
    outside.remove()
  })
})
