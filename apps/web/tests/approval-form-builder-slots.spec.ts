/**
 * F2 mounted builder spec (delta §3.1-§3.3, FB-D3/FB-D4/FB-D8, Gate F2) — the
 * NEW Designer 2.0 `ApprovalFormBuilder.vue`: N+1 semantic insertion slots,
 * strict drag-codec drops, stale-anchor no-ops, transient drag-state clearing
 * on all five triggers, click/drag/keyboard convergence on the ONE adapter,
 * and (F4) the flag-gated production-mount source pin: TemplateAuthoringView.vue is the ONE view
 * that mounts the builder/palette, only inside the `showFormBuilderV2` (canvasV2Enabled &&
 * formSessionHydrated) wrapper — see apps/web/tests/approvalTemplateAuthoring.spec.ts for the
 * behavioral mounted-iff-flag proof this source pin does not substitute for.
 * Mount pattern: repo-standard `createApp` + real DOM events (no test-utils).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, reactive, ref, type App as VueApp } from 'vue'

import ApprovalFormBuilder, {
  GENERIC_RETRY_MESSAGE,
  STALE_SLOT_RETRY_MESSAGE,
} from '../src/approvals/components/ApprovalFormBuilder.vue'
import {
  DEPENDENCY_KIND_BUSINESS_LABELS,
  INSPECTOR_INVALID_BUFFER_MESSAGE,
  INSPECTOR_RETYPE_REFUSAL_PREFIX,
} from '../src/approvals/components/ApprovalFormFieldInspector.vue'
import {
  createFormAuthoringAdapter,
  type FormAuthoringAdapter,
  type FormAuthoringSession,
} from '../src/approvals/approvalFormAuthoringAdapter'
import {
  OPAQUE_IDENTITY_TOKEN_BYTES,
  createOpaqueFormIdentityAllocator,
  type IdentityRandomSource,
} from '../src/approvals/approvalFormIdentity'
import {
  APPROVAL_FORM_DRAG_MIME,
  createApprovalFormDragSession,
  encodeApprovalFormDragPayload,
  type ApprovalFormDragPayload,
  type ApprovalFormDragSession,
} from '../src/approvals/approvalFormDragPayload'
import {
  createEmptyFieldDraft,
  createEmptyStepDraft,
  createEmptyTemplateDraft,
  type AuthorableFieldType,
  type FieldAuthoringDraft,
  type TemplateAuthoringDraft,
} from '../src/approvals/templateAuthoring'

// --- fixtures ---------------------------------------------------------------

function field(
  index: number,
  overrides: Partial<FieldAuthoringDraft> = {},
): FieldAuthoringDraft {
  return {
    ...createEmptyFieldDraft(index),
    localId: `local_${index}`,
    id: `field_${index}`,
    label: `字段 ${index}`,
    ...overrides,
  }
}

function draftWith(fields: FieldAuthoringDraft[]): TemplateAuthoringDraft {
  return {
    ...createEmptyTemplateDraft(),
    key: 'form_builder',
    name: '表单构建器',
    fields,
    steps: [createEmptyStepDraft(1)],
  }
}

/** Deterministic seam replaying scripted 8-byte blocks (F1 pattern). */
function scriptedSource(blocks: number[][]): IdentityRandomSource {
  let cursor = 0
  return {
    nextBytes(length: number): Uint8Array {
      expect(length).toBe(OPAQUE_IDENTITY_TOKEN_BYTES)
      const block = blocks[cursor % blocks.length]!
      cursor += 1
      return Uint8Array.from(block)
    },
  }
}

const BLOCK_A = [0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a]
const BLOCK_B = [0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b]

/** Fresh adapter with the SAME deterministic identity script per call. */
function deterministicAdapter(): FormAuthoringAdapter {
  return createFormAuthoringAdapter({
    identityAllocator: createOpaqueFormIdentityAllocator(
      scriptedSource([BLOCK_A, BLOCK_B]),
    ),
  })
}

function makeDataTransfer(entries: Record<string, string> = {}) {
  const store = new Map(Object.entries(entries))
  return {
    get types(): string[] {
      return Array.from(store.keys())
    },
    setData(type: string, value: string): void {
      store.set(type, String(value))
    },
    getData(type: string): string {
      return store.get(type) ?? ''
    },
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
  } as unknown as DataTransfer
}

function payloadTransfer(payload: ApprovalFormDragPayload): DataTransfer {
  return makeDataTransfer({
    [APPROVAL_FORM_DRAG_MIME]: encodeApprovalFormDragPayload(payload),
  })
}

function dispatchDrag(
  el: Element,
  type: string,
  dataTransfer: DataTransfer | null = null,
): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  el.dispatchEvent(event)
}

// --- mount harness ----------------------------------------------------------

interface BuilderExposed {
  appendField(type: AuthorableFieldType): boolean
  insertFieldAt(anchor: unknown, type: AuthorableFieldType): boolean
  moveFieldToAnchor(movingLocalId: string, anchor: unknown): void
  removeField(localId: string): boolean
  getSession(): FormAuthoringSession
  getDragSession(): ApprovalFormDragSession
}

interface BuilderHarness {
  root: HTMLElement
  state: { readOnly: boolean }
  draftChanges: [TemplateAuthoringDraft, string | null][]
  vm: BuilderExposed
  q(selector: string): HTMLElement
  slot(key: string): HTMLElement
  localOrder(): (string | null)[]
  slotKeys(): (string | null)[]
  dropOnSlot(key: string, dataTransfer: DataTransfer): Promise<void>
  unmount(): void
}

const mounted: { app: VueApp<Element>; container: HTMLDivElement }[] = []

async function mountBuilder(
  fields: FieldAuthoringDraft[],
  options: {
    readOnly?: boolean
    dragSession?: ApprovalFormDragSession
    adapter?: FormAuthoringAdapter
  } = {},
): Promise<BuilderHarness> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = reactive({ readOnly: options.readOnly ?? false })
  const draft = draftWith(fields)
  const draftChanges: [TemplateAuthoringDraft, string | null][] = []
  const exposedRef = ref<BuilderExposed | null>(null)
  const app = createApp({
    setup() {
      return () =>
        h(ApprovalFormBuilder, {
          draft,
          readOnly: state.readOnly,
          dragSession: options.dragSession,
          adapter: options.adapter,
          ref: exposedRef,
          onDraftChange: (
            next: TemplateAuthoringDraft,
            focusLocalId: string | null,
          ) => {
            draftChanges.push([next, focusLocalId])
          },
        })
    },
  })
  app.mount(container)
  mounted.push({ app, container })
  await nextTick()

  function q(selector: string): HTMLElement {
    const el = container.querySelector(selector)
    if (!el) throw new Error(`selector not rendered: ${selector}`)
    return el as HTMLElement
  }

  return {
    root: container,
    state,
    draftChanges,
    get vm() {
      return exposedRef.value!
    },
    q,
    slot(key: string) {
      return q(`[data-testid="approval-form-builder-slot-${key}"]`)
    },
    localOrder() {
      return Array.from(
        container.querySelectorAll(
          '[data-testid="approval-form-builder-card"]',
        ),
      ).map((card) => card.getAttribute('data-field-local-id'))
    },
    slotKeys() {
      return Array.from(
        container.querySelectorAll('.approval-form-builder__slot'),
      ).map((slot) =>
        (slot.getAttribute('data-testid') ?? '').replace(
          'approval-form-builder-slot-',
          '',
        ),
      )
    },
    async dropOnSlot(key: string, dataTransfer: DataTransfer) {
      const slotEl = q(`[data-testid="approval-form-builder-slot-${key}"]`)
      dispatchDrag(slotEl, 'dragover', dataTransfer)
      dispatchDrag(slotEl, 'drop', dataTransfer)
      await nextTick()
    },
    unmount() {
      app.unmount()
      container.remove()
    },
  }
}

afterEach(() => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!
    try {
      entry.app.unmount()
    } catch {
      // already unmounted by the test
    }
    entry.container.remove()
  }
})

// --- N+1 slots --------------------------------------------------------------

describe('ApprovalFormBuilder — N+1 insertion slots (FB-D3, §3.2)', () => {
  it('renders exactly N+1 semantic slots in order: start, then after each field', async () => {
    const builder = await mountBuilder([field(1), field(2), field(3)])
    expect(builder.localOrder()).toEqual(['local_1', 'local_2', 'local_3'])
    expect(builder.slotKeys()).toEqual([
      'start',
      'after-local_1',
      'after-local_2',
      'after-local_3',
    ])
  })

  it('slot count tracks the field count: N+2 slots after one insert', async () => {
    const builder = await mountBuilder([field(1), field(2)])
    expect(builder.slotKeys()).toHaveLength(3)
    await builder.dropOnSlot(
      'start',
      payloadTransfer({ version: 1, kind: 'palette', fieldType: 'select' }),
    )
    expect(builder.slotKeys()).toHaveLength(4)
  })

  it('read-only mode renders NO slots, move buttons, or drag handles', async () => {
    const builder = await mountBuilder([field(1), field(2)], {
      readOnly: true,
    })
    expect(builder.slotKeys()).toHaveLength(0)
    expect(builder.root.querySelector('[draggable="true"]')).toBeNull()
    expect(
      builder.root.querySelector(
        '[data-testid^="approval-form-builder-move-up-"]',
      ),
    ).toBeNull()
    // Cards still render for reading.
    expect(builder.localOrder()).toEqual(['local_1', 'local_2'])
  })
})

// --- anchor exactness -------------------------------------------------------

describe('ApprovalFormBuilder — exact anchor placement (FB-D3)', () => {
  it('drop on the START slot prepends atomically: exact order, ONE history entry', async () => {
    const builder = await mountBuilder([field(1), field(2), field(3)])
    await builder.dropOnSlot(
      'start',
      payloadTransfer({ version: 1, kind: 'palette', fieldType: 'select' }),
    )
    const order = builder.localOrder()
    expect(order).toHaveLength(4)
    expect(order.slice(1)).toEqual(['local_1', 'local_2', 'local_3'])
    const cards = Array.from(
      builder.root.querySelectorAll(
        '[data-testid="approval-form-builder-card"]',
      ),
    )
    expect(cards[0]!.getAttribute('data-field-type')).toBe('select')
    // Atomic prepend: exactly ONE history entry (never add-then-move).
    expect(builder.vm.getSession().history.undoStack).toHaveLength(1)
    // New field selected (programmatic selected state, non-color-only marker).
    expect(cards[0]!.getAttribute('data-selected')).toBe('true')
    expect(
      cards[0]!.querySelector(
        '[data-testid="approval-form-builder-card-selected-mark"]',
      ),
    ).not.toBeNull()
  })

  it('drop on a MIDDLE slot inserts exactly after its anchor field', async () => {
    const builder = await mountBuilder([field(1), field(2), field(3)])
    await builder.dropOnSlot(
      'after-local_1',
      payloadTransfer({ version: 1, kind: 'palette', fieldType: 'user' }),
    )
    const order = builder.localOrder()
    expect(order[0]).toBe('local_1')
    expect(order.slice(2)).toEqual(['local_2', 'local_3'])
    const cards = Array.from(
      builder.root.querySelectorAll(
        '[data-testid="approval-form-builder-card"]',
      ),
    )
    expect(cards[1]!.getAttribute('data-field-type')).toBe('user')
    expect(builder.vm.getSession().history.undoStack).toHaveLength(1)
  })

  it('drop on the END slot appends exactly', async () => {
    const builder = await mountBuilder([field(1), field(2), field(3)])
    await builder.dropOnSlot(
      'after-local_3',
      payloadTransfer({ version: 1, kind: 'palette', fieldType: 'date' }),
    )
    const order = builder.localOrder()
    expect(order.slice(0, 3)).toEqual(['local_1', 'local_2', 'local_3'])
    const cards = Array.from(
      builder.root.querySelectorAll(
        '[data-testid="approval-form-builder-card"]',
      ),
    )
    expect(cards[3]!.getAttribute('data-field-type')).toBe('date')
    expect(builder.vm.getSession().history.undoStack).toHaveLength(1)
  })

  it('existing-field payload drop moves by localId to the exact slot (§3.3)', async () => {
    const builder = await mountBuilder([field(1), field(2), field(3)])
    await builder.dropOnSlot(
      'after-local_1',
      payloadTransfer({ version: 1, kind: 'field', localId: 'local_3' }),
    )
    expect(builder.localOrder()).toEqual(['local_1', 'local_3', 'local_2'])
    expect(builder.vm.getSession().history.undoStack).toHaveLength(1)
  })

  it('dropping a field on its own adjacent slot is a value-identical no-op: ZERO history entries', async () => {
    const builder = await mountBuilder([field(1), field(2), field(3)])
    // local_1 is already first: the start slot drop changes nothing.
    await builder.dropOnSlot(
      'start',
      payloadTransfer({ version: 1, kind: 'field', localId: 'local_1' }),
    )
    expect(builder.localOrder()).toEqual(['local_1', 'local_2', 'local_3'])
    expect(builder.vm.getSession().history.undoStack).toHaveLength(0)
    expect(builder.draftChanges).toHaveLength(0)
  })
})

// --- strict codec at the drop boundary --------------------------------------

describe('ApprovalFormBuilder — strict decode negatives (codec §3.1)', () => {
  it('a text/plain foreign payload is NEVER a command (with positive control)', async () => {
    const builder = await mountBuilder([field(1), field(2)])
    // Foreign payloads: a bare legacy type string, and a command-shaped JSON
    // body — both under text/plain only.
    for (const raw of [
      'select',
      JSON.stringify({ version: 1, kind: 'palette', fieldType: 'select' }),
    ]) {
      await builder.dropOnSlot('start', makeDataTransfer({ 'text/plain': raw }))
      expect(builder.localOrder()).toEqual(['local_1', 'local_2'])
      expect(builder.vm.getSession().history.undoStack).toHaveLength(0)
    }
    // Positive control: the SAME body under the application MIME mutates.
    await builder.dropOnSlot(
      'start',
      payloadTransfer({ version: 1, kind: 'palette', fieldType: 'select' }),
    )
    expect(builder.localOrder()).toHaveLength(3)
    expect(builder.vm.getSession().history.undoStack).toHaveLength(1)
  })

  it.each([
    ['malformed JSON under the app MIME', { [APPROVAL_FORM_DRAG_MIME]: '{oops' }],
    ['unknown version', { [APPROVAL_FORM_DRAG_MIME]: JSON.stringify({ version: 9, kind: 'palette', fieldType: 'text' }) }],
    ['unknown kind', { [APPROVAL_FORM_DRAG_MIME]: JSON.stringify({ version: 1, kind: 'palette-field', fieldType: 'text' }) }],
    ['extra property', { [APPROVAL_FORM_DRAG_MIME]: JSON.stringify({ version: 1, kind: 'palette', fieldType: 'text', index: 0 }) }],
    ['disabled attachment type stays fail-closed', { [APPROVAL_FORM_DRAG_MIME]: JSON.stringify({ version: 1, kind: 'palette', fieldType: 'attachment' }) }],
    ['blank localId', { [APPROVAL_FORM_DRAG_MIME]: JSON.stringify({ version: 1, kind: 'field', localId: ' ' }) }],
    ['wrong MIME (application/json)', { 'application/json': JSON.stringify({ version: 1, kind: 'palette', fieldType: 'text' }) }],
    ['empty dataTransfer', {}],
  ])('%s → zero draft/history mutation', async (_name, entries) => {
    const builder = await mountBuilder([field(1), field(2)])
    await builder.dropOnSlot(
      'start',
      makeDataTransfer(entries as Record<string, string>),
    )
    expect(builder.localOrder()).toEqual(['local_1', 'local_2'])
    expect(builder.vm.getSession().history.undoStack).toHaveLength(0)
    expect(builder.draftChanges).toHaveLength(0)
  })
})

// --- stale anchor -----------------------------------------------------------

describe('ApprovalFormBuilder — stale anchor is a values-free no-op (FB-D3)', () => {
  it('a drop whose render-time anchor field was removed re-resolves to a no-op with the retry message', async () => {
    const builder = await mountBuilder([field(1), field(2), field(3)])
    // Grab the slot DOM node bound to the anchor {after, local_2} BEFORE the
    // draft changes.
    const staleSlot = builder.slot('after-local_2')
    // Remove the anchor field through the same adapter, then drop BEFORE the
    // re-render lands (no nextTick) — the genuine staleness window.
    expect(builder.vm.removeField('local_2')).toBe(true)
    dispatchDrag(
      staleSlot,
      'drop',
      payloadTransfer({ version: 1, kind: 'palette', fieldType: 'select' }),
    )
    await nextTick()
    // No insert happened; only the remove is in history.
    expect(
      builder.vm.getSession().draft.fields.map((entry) => entry.localId),
    ).toEqual(['local_1', 'local_3'])
    expect(builder.vm.getSession().history.undoStack).toHaveLength(1)
    // Values-free retry copy — exact pin; carries no labels/ids/values.
    expect(
      builder.q('[data-testid="approval-form-builder-status"]').textContent,
    ).toBe(STALE_SLOT_RETRY_MESSAGE)
    expect(STALE_SLOT_RETRY_MESSAGE).not.toMatch(/local_|field_|字段 \d/)
    expect(GENERIC_RETRY_MESSAGE).not.toMatch(/local_|field_|字段 \d/)
  })

  it('a stale existing-field MOVE target is the same values-free no-op', async () => {
    const builder = await mountBuilder([field(1), field(2), field(3)])
    const staleSlot = builder.slot('after-local_2')
    expect(builder.vm.removeField('local_2')).toBe(true)
    dispatchDrag(
      staleSlot,
      'drop',
      payloadTransfer({ version: 1, kind: 'field', localId: 'local_3' }),
    )
    await nextTick()
    expect(
      builder.vm.getSession().draft.fields.map((entry) => entry.localId),
    ).toEqual(['local_1', 'local_3'])
    expect(builder.vm.getSession().history.undoStack).toHaveLength(1)
    expect(
      builder.q('[data-testid="approval-form-builder-status"]').textContent,
    ).toBe(STALE_SLOT_RETRY_MESSAGE)
  })
})

// --- transient drag-state clearing (all five triggers) ----------------------

describe('ApprovalFormBuilder — transient drag state clears on all five triggers (§3.1)', () => {
  function startHandleDrag(builder: BuilderHarness, localId: string): void {
    dispatchDrag(
      builder.q(`[data-testid="approval-form-builder-handle-${localId}"]`),
      'dragstart',
      makeDataTransfer(),
    )
  }

  it('trigger 1 — drop (successful AND failed) clears; drop outside a slot is a clearing no-op', async () => {
    const dragSession = createApprovalFormDragSession()
    const builder = await mountBuilder([field(1), field(2)], { dragSession })
    startHandleDrag(builder, 'local_2')
    expect(dragSession.active()).toEqual({
      version: 1,
      kind: 'field',
      localId: 'local_2',
    })
    await builder.dropOnSlot(
      'start',
      payloadTransfer({ version: 1, kind: 'field', localId: 'local_2' }),
    )
    expect(dragSession.active()).toBeNull()

    // Failed drop (foreign payload) clears too.
    startHandleDrag(builder, 'local_1')
    expect(dragSession.active()).not.toBeNull()
    await builder.dropOnSlot('start', makeDataTransfer({ 'text/plain': 'x' }))
    expect(dragSession.active()).toBeNull()

    // Drop OUTSIDE any slot (canvas background) is a no-op that still clears.
    startHandleDrag(builder, 'local_1')
    expect(dragSession.active()).not.toBeNull()
    const before = builder.vm.getSession()
    dispatchDrag(
      builder.q('[data-testid="approval-form-builder"]'),
      'drop',
      makeDataTransfer(),
    )
    await nextTick()
    expect(dragSession.active()).toBeNull()
    expect(builder.vm.getSession()).toBe(before)
  })

  it('trigger 2 — dragend on the move handle clears', async () => {
    const dragSession = createApprovalFormDragSession()
    const builder = await mountBuilder([field(1), field(2)], { dragSession })
    startHandleDrag(builder, 'local_1')
    expect(dragSession.active()).not.toBeNull()
    dispatchDrag(
      builder.q('[data-testid="approval-form-builder-handle-local_1"]'),
      'dragend',
    )
    expect(dragSession.active()).toBeNull()
  })

  it('trigger 3 — Escape clears (and collapses the drop-target affordance)', async () => {
    const dragSession = createApprovalFormDragSession()
    const builder = await mountBuilder([field(1), field(2)], { dragSession })
    startHandleDrag(builder, 'local_1')
    const slotEl = builder.slot('after-local_2')
    dispatchDrag(slotEl, 'dragover', makeDataTransfer())
    await nextTick()
    expect(slotEl.classList.contains('is-drop-target')).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(dragSession.active()).toBeNull()
    expect(slotEl.classList.contains('is-drop-target')).toBe(false)
    // The cancelled drag left zero draft/history mutation.
    expect(builder.vm.getSession().history.undoStack).toHaveLength(0)
  })

  it('trigger 4 — unmount (route change) clears the SHARED session', async () => {
    const dragSession = createApprovalFormDragSession()
    const builder = await mountBuilder([field(1), field(2)], { dragSession })
    startHandleDrag(builder, 'local_1')
    expect(dragSession.active()).not.toBeNull()
    builder.unmount()
    expect(dragSession.active()).toBeNull()
  })

  it('trigger 5 — the read-only transition clears and removes drop targets', async () => {
    const dragSession = createApprovalFormDragSession()
    const builder = await mountBuilder([field(1), field(2)], { dragSession })
    startHandleDrag(builder, 'local_1')
    expect(dragSession.active()).not.toBeNull()
    builder.state.readOnly = true
    await nextTick()
    expect(dragSession.active()).toBeNull()
    expect(builder.slotKeys()).toHaveLength(0)
  })
})

// --- click/drag/keyboard equivalence (FB-D4) --------------------------------

describe('ApprovalFormBuilder — click, drag, and keyboard paths are IDENTICAL (FB-D4)', () => {
  it('slot-menu click insert === palette drag to the same slot: same draft, same single history entry', async () => {
    // Same deterministic identity script → byte-identical results.
    const dragBuilder = await mountBuilder([field(1), field(2), field(3)], {
      adapter: deterministicAdapter(),
    })
    await dragBuilder.dropOnSlot(
      'after-local_1',
      payloadTransfer({ version: 1, kind: 'palette', fieldType: 'select' }),
    )

    const clickBuilder = await mountBuilder([field(1), field(2), field(3)], {
      adapter: deterministicAdapter(),
    })
    // Slot click opens the type menu; the menu item is a native BUTTON, so
    // Enter/Space keyboard activation is the same click event path (FB-D2).
    clickBuilder.slot('after-local_1').click()
    await nextTick()
    expect(
      clickBuilder.slot('after-local_1').getAttribute('aria-expanded'),
    ).toBe('true')
    const menuItem = clickBuilder.q(
      '[data-testid="approval-form-builder-insert-select"]',
    )
    expect(menuItem.tagName).toBe('BUTTON')
    menuItem.click()
    await nextTick()

    const dragSession = dragBuilder.vm.getSession()
    const clickSession = clickBuilder.vm.getSession()
    expect(clickSession.draft.fields).toEqual(dragSession.draft.fields)
    expect(dragSession.history.undoStack).toHaveLength(1)
    expect(clickSession.history.undoStack).toHaveLength(1)
    expect(clickSession.history.undoStack).toEqual(
      dragSession.history.undoStack,
    )
    expect(clickSession.history.focusLocalId).toBe(
      dragSession.history.focusLocalId,
    )
    expect(clickBuilder.localOrder()).toEqual(dragBuilder.localOrder())
  })

  it('palette click-to-append (appendField) === drag to the END slot', async () => {
    const dragBuilder = await mountBuilder([field(1), field(2)], {
      adapter: deterministicAdapter(),
    })
    await dragBuilder.dropOnSlot(
      'after-local_2',
      payloadTransfer({ version: 1, kind: 'palette', fieldType: 'date' }),
    )

    const clickBuilder = await mountBuilder([field(1), field(2)], {
      adapter: deterministicAdapter(),
    })
    expect(clickBuilder.vm.appendField('date')).toBe(true)
    await nextTick()

    expect(clickBuilder.vm.getSession().draft.fields).toEqual(
      dragBuilder.vm.getSession().draft.fields,
    )
    expect(clickBuilder.vm.getSession().history.undoStack).toEqual(
      dragBuilder.vm.getSession().history.undoStack,
    )
    expect(clickBuilder.vm.getSession().history.undoStack).toHaveLength(1)
  })

  it('existing-field drag === keyboard 上移: same order, focus, and history snapshot (§3.3)', async () => {
    const dragBuilder = await mountBuilder([field(1), field(2), field(3)])
    await dragBuilder.dropOnSlot(
      'start',
      payloadTransfer({ version: 1, kind: 'field', localId: 'local_2' }),
    )

    const keyboardBuilder = await mountBuilder([field(1), field(2), field(3)])
    keyboardBuilder
      .q('[data-testid="approval-form-builder-move-up-local_2"]')
      .click()
    await nextTick()

    expect(dragBuilder.localOrder()).toEqual([
      'local_2',
      'local_1',
      'local_3',
    ])
    expect(keyboardBuilder.localOrder()).toEqual(dragBuilder.localOrder())
    expect(keyboardBuilder.vm.getSession().history.undoStack).toEqual(
      dragBuilder.vm.getSession().history.undoStack,
    )
    expect(keyboardBuilder.vm.getSession().history.undoStack).toHaveLength(1)
    expect(keyboardBuilder.vm.getSession().history.focusLocalId).toBe(
      dragBuilder.vm.getSession().history.focusLocalId,
    )
    // Selection retained on the moved field in both paths.
    expect(
      dragBuilder.root
        .querySelector('[data-field-local-id="local_2"]')
        ?.getAttribute('data-selected'),
    ).toBe('true')
    expect(
      keyboardBuilder.root
        .querySelector('[data-field-local-id="local_2"]')
        ?.getAttribute('data-selected'),
    ).toBe('true')
  })

  it('keyboard boundary moves are disabled buttons (zero-entry no-op posture)', async () => {
    const builder = await mountBuilder([field(1), field(2)])
    expect(
      (
        builder.q(
          '[data-testid="approval-form-builder-move-up-local_1"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
    expect(
      (
        builder.q(
          '[data-testid="approval-form-builder-move-down-local_2"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
    expect(builder.vm.getSession().history.undoStack).toHaveLength(0)
  })
})

// --- draft-change emission --------------------------------------------------

describe('ApprovalFormBuilder — draft-change emission (FB-D4)', () => {
  it('emits exactly one draft-change per value-changing command, none for rejections', async () => {
    const builder = await mountBuilder([field(1), field(2)])
    await builder.dropOnSlot(
      'start',
      payloadTransfer({ version: 1, kind: 'palette', fieldType: 'text' }),
    )
    expect(builder.draftChanges).toHaveLength(1)
    expect(builder.draftChanges[0]![0].fields).toHaveLength(3)
    // Rejected drop (foreign payload): no additional emission.
    await builder.dropOnSlot('start', makeDataTransfer({ 'text/plain': 'x' }))
    expect(builder.draftChanges).toHaveLength(1)
  })
})

// --- F3B: builder <-> inspector wiring (FB-D7) ------------------------------

describe('ApprovalFormBuilder — F3B selected-field inspector wiring (FB-D7)', () => {
  function inspectorLabelInput(builder: BuilderHarness): HTMLInputElement {
    return builder.q(
      '[data-testid="approval-form-field-inspector-label"]',
    ) as HTMLInputElement
  }

  async function typeInspectorLabel(
    builder: BuilderHarness,
    value: string,
  ): Promise<void> {
    const input = inspectorLabelInput(builder)
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
  }

  it('the inspector tracks the selected field: card selection switches its content', async () => {
    const builder = await mountBuilder([field(1), field(2)])
    expect(inspectorLabelInput(builder).value).toBe('字段 1')
    ;(
      builder.root.querySelector(
        '[data-field-local-id="local_2"]',
      ) as HTMLElement
    ).click()
    await nextTick()
    expect(inspectorLabelInput(builder).value).toBe('字段 2')
    expect(
      builder.root
        .querySelector('[data-field-local-id="local_2"]')
        ?.getAttribute('data-selected'),
    ).toBe('true')
  })

  it('an inspector commit flows through the ONE adapter path: card copy updates, ONE history entry, ONE draft-change', async () => {
    const builder = await mountBuilder([field(1), field(2)])
    await typeInspectorLabel(builder, '采购主题')
    // Typing alone: zero commands, zero entries, zero emissions (FB-D7).
    expect(builder.vm.getSession().history.undoStack).toHaveLength(0)
    expect(builder.draftChanges).toHaveLength(0)
    inspectorLabelInput(builder).dispatchEvent(new Event('blur'))
    await nextTick()
    expect(builder.vm.getSession().draft.fields[0].label).toBe('采购主题')
    expect(builder.vm.getSession().history.undoStack).toHaveLength(1)
    expect(builder.draftChanges).toHaveLength(1)
    expect(
      builder.root.querySelector('.approval-form-builder__card-label')
        ?.textContent,
    ).toContain('采购主题')
  })

  it('COMMIT ARM: switching selection with a VALID dirty buffer commits it as ONE entry, then switches', async () => {
    const builder = await mountBuilder([field(1), field(2)])
    await typeInspectorLabel(builder, '改名甲')
    ;(
      builder.root.querySelector(
        '[data-field-local-id="local_2"]',
      ) as HTMLElement
    ).click()
    await nextTick()
    expect(builder.vm.getSession().draft.fields[0].label).toBe('改名甲')
    expect(builder.vm.getSession().history.undoStack).toHaveLength(1)
    // The switch went through after the commit.
    expect(inspectorLabelInput(builder).value).toBe('字段 2')
    expect(
      builder.root
        .querySelector('[data-field-local-id="local_2"]')
        ?.getAttribute('data-selected'),
    ).toBe('true')
  })

  it('BLOCK ARM: an INVALID dirty buffer blocks the selection switch with values-free copy — never a silent discard', async () => {
    const builder = await mountBuilder([field(1), field(2)])
    await typeInspectorLabel(builder, '   ')
    ;(
      builder.root.querySelector(
        '[data-field-local-id="local_2"]',
      ) as HTMLElement
    ).click()
    await nextTick()
    // Selection unchanged, zero mutation, buffer preserved.
    expect(
      builder.root
        .querySelector('[data-field-local-id="local_1"]')
        ?.getAttribute('data-selected'),
    ).toBe('true')
    expect(builder.vm.getSession().draft.fields[0].label).toBe('字段 1')
    expect(builder.vm.getSession().history.undoStack).toHaveLength(0)
    expect(builder.draftChanges).toHaveLength(0)
    expect(inspectorLabelInput(builder).value).toBe('   ')
    expect(
      builder.q('[data-testid="approval-form-field-inspector-status"]')
        .textContent,
    ).toBe(INSPECTOR_INVALID_BUFFER_MESSAGE)
    expect(INSPECTOR_INVALID_BUFFER_MESSAGE).not.toMatch(/local_|field_|字段 \d/)
  })

  it('P2-3 SETTLE PATH: a dirty option-label buffer settles on selection switch with the option VALUE preserved (never regenerated)', async () => {
    const builder = await mountBuilder([
      field(1, { type: 'select', optionsText: '甲:a\n乙:b' }),
      field(2),
    ])
    const optionInput = builder.q(
      '[data-testid="approval-form-field-inspector-option-label-0"]',
    ) as HTMLInputElement
    optionInput.value = '甲改'
    optionInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    // Switch selection WITHOUT blurring: the settle path commits the buffer.
    ;(
      builder.root.querySelector(
        '[data-field-local-id="local_2"]',
      ) as HTMLElement
    ).click()
    await nextTick()
    // ONE entry; label changed; the hand-authored VALUE 'a' survived byte-identical.
    expect(builder.vm.getSession().draft.fields[0].optionsText).toBe(
      '甲改:a\n乙:b',
    )
    expect(builder.vm.getSession().history.undoStack).toHaveLength(1)
    expect(
      builder.root
        .querySelector('[data-field-local-id="local_2"]')
        ?.getAttribute('data-selected'),
    ).toBe('true')
  })

  it('an invalid buffer also blocks slot drops and keyboard moves (no mutation past a pending invalid edit)', async () => {
    const builder = await mountBuilder([field(1), field(2)])
    await typeInspectorLabel(builder, ' ')
    await builder.dropOnSlot(
      'start',
      payloadTransfer({ version: 1, kind: 'palette', fieldType: 'select' }),
    )
    expect(builder.localOrder()).toEqual(['local_1', 'local_2'])
    builder.q('[data-testid="approval-form-builder-move-up-local_2"]').click()
    await nextTick()
    expect(builder.localOrder()).toEqual(['local_1', 'local_2'])
    expect(builder.vm.getSession().history.undoStack).toHaveLength(0)
  })

  it('retype through the inspector: a referenced field is the NAMED values-free refusal with zero mutation; the unreferenced control succeeds with preserved identity', async () => {
    // Negative arm: field_2's visibility depends on field_1.
    const refused = await mountBuilder([
      field(1),
      field(2, {
        visibility: {
          dependsOnFieldId: 'field_1',
          operator: 'eq',
          valueText: 'y',
        },
      }),
    ])
    const refusedSelect = refused.q(
      '[data-testid="approval-form-field-inspector-type"]',
    ) as HTMLSelectElement
    refusedSelect.value = 'date'
    refusedSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    expect(refused.vm.getSession().draft.fields[0].type).toBe('text')
    expect(refused.vm.getSession().history.undoStack).toHaveLength(0)
    expect(refused.draftChanges).toHaveLength(0)
    const copy = refused.q(
      '[data-testid="approval-form-field-inspector-status"]',
    ).textContent!
    expect(copy).toBe(
      `${INSPECTOR_RETYPE_REFUSAL_PREFIX}${DEPENDENCY_KIND_BUSINESS_LABELS.visibility_rule}`,
    )
    expect(copy).not.toMatch(/local_|field_\d|fields\./)

    // Positive control: no reference → retype succeeds, ONE entry, identity kept.
    const allowed = await mountBuilder([field(1), field(2)])
    const allowedSelect = allowed.q(
      '[data-testid="approval-form-field-inspector-type"]',
    ) as HTMLSelectElement
    allowedSelect.value = 'date'
    allowedSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    const retypedCard = allowed.root.querySelector(
      '[data-field-local-id="local_1"]',
    )!
    expect(retypedCard.getAttribute('data-field-type')).toBe('date')
    expect(allowed.vm.getSession().draft.fields[0].id).toBe('field_1')
    expect(allowed.vm.getSession().history.undoStack).toHaveLength(1)
    expect(allowed.draftChanges).toHaveLength(1)
  })

  it('read-only mode renders the inspector note without any editable controls', async () => {
    const builder = await mountBuilder([field(1), field(2)], { readOnly: true })
    expect(
      builder.root.querySelector(
        '[data-testid="approval-form-field-inspector-readonly"]',
      ),
    ).not.toBeNull()
    expect(
      builder.root.querySelector(
        '[data-testid="approval-form-field-inspector-label"]',
      ),
    ).toBeNull()
  })
})

// --- P3-2 regression: read-only guards at MUTATION time ---------------------
//
// Coverage shape (stated honestly, per the F3 gate's P2-1): the drop path has
// THREE redundant read-only gates (`onSlotDrop`'s early return, then the
// mutation-time re-checks in `insertFieldAt` / `moveFieldToAnchor`). On the
// jsdom DROP path the early return fires first, so the A5 drop test alone
// cannot discriminate the deeper gates. The per-gate tests below therefore
// arrive via the NON-drop callers — the exposed programmatic command surface,
// a retained move button, and a retained inspector input — so deleting any
// single deeper re-check (F2's M4/M5) or the `runInspectorCommand` gate turns
// exactly its own test red. `onSlotDrop`'s early return ALONE remains pure
// redundant shielding: deleting only it stays green BY CONSTRUCTION because
// the individually-pinned deeper gates catch the drop.

describe('ApprovalFormBuilder — P3-2: a drop racing a readOnly flip cannot insert (PROBE A5)', () => {
  it('a drop on a RETAINED slot node after the readOnly flip has propagated is a zero-mutation no-op (palette AND move payloads)', async () => {
    const dragSession = createApprovalFormDragSession()
    const builder = await mountBuilder([field(1), field(2)], { dragSession })
    // Retain the live slot DOM node BEFORE the flip (the A5 fixture).
    const retainedSlot = builder.slot('start')
    builder.state.readOnly = true
    await nextTick()
    // props.readOnly is now genuinely true and the slot is detached — the
    // retained node is the only remaining path to the drop handler.
    expect(builder.slotKeys()).toHaveLength(0)
    const before = builder.vm.getSession()
    dispatchDrag(
      retainedSlot,
      'drop',
      payloadTransfer({ version: 1, kind: 'palette', fieldType: 'select' }),
    )
    dispatchDrag(
      retainedSlot,
      'drop',
      payloadTransfer({ version: 1, kind: 'field', localId: 'local_2' }),
    )
    await nextTick()
    expect(builder.vm.getSession()).toBe(before)
    expect(builder.vm.getSession().draft.fields.map((entry) => entry.localId)).toEqual([
      'local_1',
      'local_2',
    ])
    expect(builder.vm.getSession().history.undoStack).toHaveLength(0)
    expect(builder.draftChanges).toHaveLength(0)
    // The read-only drop still cleared transient drag state (§3.1 trigger 5/1).
    expect(dragSession.active()).toBeNull()
  })

  it('PER-GATE A: each programmatic command re-check refuses AFTER the flip — appendField / insertFieldAt (M4) / moveFieldToAnchor (M5) / removeField individually load-bearing', async () => {
    const builder = await mountBuilder([field(1), field(2)])
    builder.state.readOnly = true
    await nextTick()
    const before = builder.vm.getSession()
    // Each call hits ONLY its own mutation-time re-check — no drop handler,
    // no onSlotDrop early return, in front of it. Deleting any single
    // re-check makes that call mutate and this test red. removeField is on the
    // exposed surface too, so its guard is pinned here alongside its siblings
    // (deleting `if (props.readOnly) return false` in removeField reds this).
    expect(builder.vm.appendField('text')).toBe(false)
    expect(builder.vm.insertFieldAt({ kind: 'start' }, 'select')).toBe(false)
    builder.vm.moveFieldToAnchor('local_2', { kind: 'start' })
    expect(builder.vm.removeField('local_2')).toBe(false)
    await nextTick()
    expect(builder.vm.getSession()).toBe(before)
    expect(builder.localOrder()).toEqual(['local_1', 'local_2'])
    expect(builder.vm.getSession().history.undoStack).toHaveLength(0)
    expect(builder.draftChanges).toHaveLength(0)
  })

  it('PER-GATE B: a RETAINED move button clicked after the flip cannot reorder (onMoveByOffset re-check)', async () => {
    const builder = await mountBuilder([field(1), field(2)])
    // Retain the live button node BEFORE the flip removes it from the DOM.
    const retainedButton = builder.q(
      '[data-testid="approval-form-builder-move-up-local_2"]',
    )
    builder.state.readOnly = true
    await nextTick()
    const before = builder.vm.getSession()
    retainedButton.click()
    await nextTick()
    expect(builder.vm.getSession()).toBe(before)
    expect(builder.localOrder()).toEqual(['local_1', 'local_2'])
    expect(builder.vm.getSession().history.undoStack).toHaveLength(0)
    expect(builder.draftChanges).toHaveLength(0)
  })

  it('PER-GATE C: a dirty inspector buffer blurred after the flip cannot commit (runInspectorCommand read-only gate)', async () => {
    const builder = await mountBuilder([field(1), field(2)])
    const retainedInput = builder.q(
      '[data-testid="approval-form-field-inspector-label"]',
    ) as HTMLInputElement
    retainedInput.value = '越权改名'
    retainedInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    builder.state.readOnly = true
    await nextTick()
    const before = builder.vm.getSession()
    // The retained (now-detached) input's blur handler still runs commit →
    // execute → runInspectorCommand, whose read-only gate must refuse.
    retainedInput.dispatchEvent(new Event('blur'))
    await nextTick()
    expect(builder.vm.getSession()).toBe(before)
    expect(builder.vm.getSession().draft.fields[0].label).toBe('字段 1')
    expect(builder.vm.getSession().history.undoStack).toHaveLength(0)
    expect(builder.draftChanges).toHaveLength(0)
  })
})

// --- NIT-2: slot type menu keyboard semantics -------------------------------

describe('ApprovalFormBuilder — slot menu keyboard semantics (aria-haspopup menu)', () => {
  function menuItems(builder: BuilderHarness): HTMLButtonElement[] {
    return Array.from(
      builder.root.querySelectorAll<HTMLButtonElement>(
        '.approval-form-builder__slot-menu-item',
      ),
    )
  }

  function pressOnActive(key: string): void {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    )
  }

  it('the trigger declares aria-haspopup="menu" and opening moves focus INTO the menu', async () => {
    const builder = await mountBuilder([field(1), field(2)])
    const trigger = builder.slot('start')
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    trigger.click()
    await nextTick()
    await nextTick()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const items = menuItems(builder)
    expect(items.length).toBeGreaterThan(1)
    expect(document.activeElement).toBe(items[0])
  })

  it('ArrowDown/ArrowUp cycle the items; Home/End jump to the edges', async () => {
    const builder = await mountBuilder([field(1)])
    builder.slot('start').click()
    await nextTick()
    await nextTick()
    const items = menuItems(builder)
    pressOnActive('ArrowDown')
    await nextTick()
    expect(document.activeElement).toBe(items[1])
    pressOnActive('ArrowUp')
    await nextTick()
    expect(document.activeElement).toBe(items[0])
    // ArrowUp from the first item wraps to the last; ArrowDown wraps forward.
    pressOnActive('ArrowUp')
    await nextTick()
    expect(document.activeElement).toBe(items[items.length - 1])
    pressOnActive('ArrowDown')
    await nextTick()
    expect(document.activeElement).toBe(items[0])
    pressOnActive('End')
    await nextTick()
    expect(document.activeElement).toBe(items[items.length - 1])
    pressOnActive('Home')
    await nextTick()
    expect(document.activeElement).toBe(items[0])
  })

  it('Escape inside the menu closes it and RETURNS focus to the trigger (no mutation)', async () => {
    const builder = await mountBuilder([field(1), field(2)])
    const trigger = builder.slot('after-local_1')
    trigger.click()
    await nextTick()
    await nextTick()
    expect(menuItems(builder).length).toBeGreaterThan(0)
    pressOnActive('Escape')
    await nextTick()
    expect(menuItems(builder)).toHaveLength(0)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
    expect(builder.vm.getSession().history.undoStack).toHaveLength(0)
  })
})

// --- no-production-mount pin (FB-D8) ----------------------------------------

describe('F2 no-mount pin — production views do not import the new builder (FB-D8)', () => {
  function collectViewSources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        collectViewSources(full, out)
      } else if (/\.(vue|ts)$/.test(entry)) {
        out.push(full)
      }
    }
    return out
  }

  it('F4 FLIPPED PIN: exactly TemplateAuthoringView.vue mounts the new builder/palette, and only inside the flag-gated v2 wrapper (FB-D8 production mount). The BEHAVIORAL mounted-iff-canvasV2 proof (OFF => absent + legacy intact; ON => present) lives in apps/web/tests/approvalTemplateAuthoring.spec.ts — this is a source-text scan, never a substitute for it.', () => {
    const viewsDir = join(__dirname, '..', 'src', 'views')
    const sources = collectViewSources(viewsDir)
    expect(sources.length).toBeGreaterThan(10)
    const mounters: string[] = []
    let inlineEditorSeen = false
    for (const file of sources) {
      const text = readFileSync(file, 'utf8')
      if (
        text.includes('<ApprovalFormBuilder') ||
        text.includes('<ApprovalFormPalette')
      ) {
        mounters.push(file)
      }
      if (text.includes('ApprovalFormInlineEditor')) inlineEditorSeen = true
    }
    // F4 production mount: exactly ONE production view mounts the new builder/palette — a SECOND
    // view sneaking an unauthorized mount (or the F0 fallback view losing its mount) fails here.
    expect(mounters).toEqual([join(viewsDir, 'approval', 'TemplateAuthoringView.vue')])
    // Positive control: the scan DOES see component imports — the extracted F0 fallback stays
    // mounted too (flag-OFF byte-identical fallback path, delta §5 F0/FB-D8).
    expect(inlineEditorSeen).toBe(true)

    // Source-level defense-in-depth: both mount markers sit inside the SAME flag-gated wrapper.
    // `showFormBuilderV2` (canvasV2Enabled && formSessionHydrated, delta §5 F4) is the only
    // condition guarding them — a source match here proves the guard identifier is PRESENT on the
    // wrapper, never that it evaluates correctly at runtime (that is the behavioral spec's job).
    const viewSource = readFileSync(mounters[0]!, 'utf8')
    const wrapperMarkerIndex = viewSource.indexOf('template-authoring__form-designer-v2')
    expect(wrapperMarkerIndex).toBeGreaterThan(-1)
    const wrapperTagStart = viewSource.lastIndexOf('<div', wrapperMarkerIndex)
    expect(wrapperTagStart).toBeGreaterThan(-1)
    const builderIndex = viewSource.indexOf('<ApprovalFormBuilder', wrapperMarkerIndex)
    const paletteIndex = viewSource.indexOf('<ApprovalFormPalette', wrapperMarkerIndex)
    expect(builderIndex).toBeGreaterThan(wrapperMarkerIndex)
    expect(paletteIndex).toBeGreaterThan(wrapperMarkerIndex)
    const wrapperOpenTag = viewSource.slice(wrapperTagStart, wrapperMarkerIndex)
    expect(wrapperOpenTag).toMatch(/v-else|v-if="[^"]*showFormBuilderV2[^"]*"/)
  })
})
