import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, ref, type App } from 'vue'
import { mountMetaCellEditor } from './helpers/mount-meta-cell-editor'

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
  // `mountGrid`) for the P3-2 / NIT / round-4 tests below — one `h(MetaCellEditor, ...)` render
  // call, reused. NIT (round 4): this used to wrap that render inline in this file, in its own
  // local `defineComponent({ ... })` (or, briefly while investigating, a plain
  // `createApp({ render: ... })`) — EITHER shape is itself picked up by `vue/one-component-per-file`
  // as "a component" once a file already has more than one, and this file already carries the two
  // pre-existing `defineComponent` literals below (each already flagged; that 2-warning baseline is
  // the one this change must leave untouched). Moving the render call OUT to
  // `./helpers/mount-meta-cell-editor.ts` — a file that holds exactly one such call — is what
  // actually adds zero new warnings: the rule only fires on a file with MORE than one.
  async function mountEditor(propsOverride: Record<string, unknown>): Promise<HTMLElement> {
    const MetaCellEditor = await loadEditor()
    app = mountMetaCellEditor(container!, MetaCellEditor, {
      field: { id: 'fld_title', name: 'Title', type: 'string' },
      modelValue: 'hello',
      recordId: 'rec_1',
      'onUpdate:modelValue': vi.fn(),
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
      onOpenLinkPicker: vi.fn(),
      ...propsOverride,
    })
    return container!
  }

  // P3-2 (grid-commit-reliability, round 3): onAiRunTab (Tab pressed FROM the
  // in-editor AI-run button) omits the `yjs-commit` emit that onTextTab and
  // onTextBlur both emit when the Yjs text binding is live for this exact
  // cell — the host (MetaGridTable) reads that emit to skip the redundant
  // REST patch once Yjs already carried the edit. Without it, tabbing OUT
  // via the button specifically (as opposed to tabbing out of the `<input>`
  // itself) would leave the host thinking REST still owns the commit.
  it('P3-2: Tab FROM the AI-run button emits yjs-commit when the text binding is active, BEFORE tab-commit', async () => {
    // P3-2 (round 4): the ORDER matters, not just that both fire — the host (MetaGridTable) reads
    // `yjs-commit` to skip a redundant REST patch, and only does so if it arrives before it acts on
    // `tab-commit`'s own confirm/close. A same-tick swap (tab-commit emitted first) would pass every
    // assertion the round-3 test above already had (both call counts stay 1) while being the wrong
    // behaviour — recording emission order in a shared array is what actually pins it. MUTATION:
    // swapping the two emit statements in onAiRunTab reds the `order` assertion below (call counts
    // alone stay green).
    const order: string[] = []
    const onYjsCommit = vi.fn(() => order.push('yjs-commit'))
    const onTabCommit = vi.fn(() => order.push('tab-commit'))
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
    expect(order).toEqual(['yjs-commit', 'tab-commit'])
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

  // ── round 4, P3-4: four load-bearing hostCommitPolicy guards that already existed (each is
  //             already the FIRST statement in its handler) but had zero discriminating coverage.
  //             Each test below documents the mutation it catches. ────────────────────────────
  describe('round 4 (P3-4): hostCommitPolicy guards with a mutation-tested probe', () => {
    it('guard 1: hostCommitPolicy \'none\' on a number editor blurred mid-invalid-draft has ZERO side effects from the blur itself (no cancel, no blur-commit, no yjs-commit)', async () => {
      // The strongest assertion available for the 'none'-policy early return at the TOP of
      // onScalarBlur (before shouldIgnoreBlur, before the numberInvalidRawDraft branch), spying
      // the FULL emit surface directly on MetaCellEditor rather than relying on one particular
      // listener a given host happens to wire.
      //
      // Round-4 interaction worth recording: BEFORE this file's own P2 fix (onNumberInput gating
      // `numberInvalidRawDraft` on `hostCommitPolicy === 'grid'`), multitable-bulk-edit-dialog.
      // spec.ts's existing "does not dismiss the dialog..." test caught this exact guard's removal
      // too (via `cancel` → `onCancel`, since the flag used to get set regardless of policy). AFTER
      // the P2 fix, that flag can no longer become true at all under 'none' — so on THAT dialog,
      // deleting onScalarBlur's own guard now emits an unlistened `blur-commit` instead (dialog
      // doesn't wire `@blur-commit`), invisible to that test. This spy — mounting MetaCellEditor
      // directly and listening for `blur-commit` itself, not just `cancel` — is what actually stays
      // discriminating for "the guard is missing entirely" post-P2 (see multitable-bulk-edit-dialog.
      // spec.ts's own updated comment on that test for the same note from the other side).
      //
      // What THIS probe still cannot discriminate: hoisting just the
      // `numberInvalidRawDraft.value = false` reset line above the guard while leaving the guard's
      // own `return` in place. Under 'none' policy every OTHER handler in this component
      // (onScalarTab, onNumberInput's own 'none' branch) ALSO early-returns on
      // `hostCommitPolicy !== 'grid'` first, so no LATER event in this component can ever observe
      // that the flag was reset early — that specific reordering has no consequence reachable
      // through MetaCellEditor's public surface. Recorded honestly here rather than faked with a
      // probe engineered to look discriminating for it; the guard's PRESENCE (which this DOES
      // catch) is the load-bearing part.
      const onCancel = vi.fn()
      const onBlurCommit = vi.fn()
      const onYjsCommit = vi.fn()
      const onUpdateModelValue = vi.fn()
      const root = await mountEditor({
        field: { id: 'fld_score', name: 'Score', type: 'number' },
        modelValue: 10,
        recordId: null,
        hostCommitPolicy: undefined, // 'none' — MetaBulkEditDialog never sets this prop
        onCancel,
        onBlurCommit,
        onYjsCommit,
        'onUpdate:modelValue': onUpdateModelValue,
      })

      const input = root.querySelector('.meta-cell-editor__input') as HTMLInputElement
      input.value = '-' // sanitizes to '' on the getter — an in-progress, not-yet-resolved draft
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '-', inputType: 'insertText' }))
      // The keystroke's own onNumberInput legitimately emits update:modelValue(null) under 'none'
      // (P2, round 4 — see multitable-bulk-edit-dialog.spec.ts for that byte-identical-to-main
      // assertion); clear it so what follows is purely about the BLUR's own side effects.
      onUpdateModelValue.mockClear()

      const outside = document.createElement('button')
      document.body.appendChild(outside)
      input.dispatchEvent(new FocusEvent('blur', { relatedTarget: outside, bubbles: true }))

      expect(onCancel).not.toHaveBeenCalled()
      expect(onBlurCommit).not.toHaveBeenCalled()
      expect(onYjsCommit).not.toHaveBeenCalled()
      expect(onUpdateModelValue).not.toHaveBeenCalled()
      outside.remove()
    })

    it('guard 3: hostCommitPolicy \'none\' on a real date editor does not intercept Tab (onScalarTab)', async () => {
      // MUTATION: removing `if (props.hostCommitPolicy !== 'grid') return` from the top of
      // onScalarTab reds this (defaultPrevented flips true — Tab preventDefault'd with nothing
      // consuming the `tab-commit` emit, trapping keyboard focus).
      const root = await mountEditor({
        field: { id: 'fld_due', name: 'Due', type: 'date' },
        modelValue: '2024-01-01',
        recordId: null,
        hostCommitPolicy: undefined,
      })

      const input = root.querySelector('.meta-cell-editor__input') as HTMLInputElement
      expect(input.type).toBe('date') // sanity: the real-date branch (onScalarTab), not date-like string
      const evt = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      input.dispatchEvent(evt)

      expect(evt.defaultPrevented).toBe(false)
    })

    it('guard 4: hostCommitPolicy \'none\' on a date-like string editor does not intercept Tab (onPlainTab)', async () => {
      // MUTATION: removing `if (props.hostCommitPolicy !== 'grid') return` from the top of
      // onPlainTab reds this the same way as guard 3 above.
      const root = await mountEditor({
        field: { id: 'fld_due_date', name: 'Due Date', type: 'string' }, // name matches the
        // date-field-name convention (isDateLikeStringField) — renders the date-like <input
        // type="date"> branch (onPlainTab), not the plain text branch (onTextTab).
        modelValue: '2024-01-01',
        recordId: null,
        hostCommitPolicy: undefined,
      })

      const input = root.querySelector('.meta-cell-editor__input') as HTMLInputElement
      expect(input.type).toBe('date') // sanity: the date-like string branch (onPlainTab)
      const evt = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      input.dispatchEvent(evt)

      expect(evt.defaultPrevented).toBe(false)
    })
  })
})
