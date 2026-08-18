/**
 * F2 mounted palette spec (delta §3.1, Gate F2) — the NEW Designer 2.0
 * `ApprovalFormPalette.vue` (FB-D8: separate from the extracted flag-OFF
 * `ApprovalFormInlineEditor` fallback; F4 performs the production mount behind
 * `approvalCanvasV2` in `TemplateAuthoringView.vue` — see
 * apps/web/tests/approvalTemplateAuthoring.spec.ts for the mounted contract).
 * Mount pattern: repo-standard `createApp` + real DOM events (no test-utils).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, reactive, type App as VueApp } from 'vue'

import ApprovalFormPalette, {
  APPROVAL_FORM_FIELD_TYPE_LABELS,
  APPROVAL_FORM_PALETTE_GROUPS,
} from '../src/approvals/components/ApprovalFormPalette.vue'
import {
  APPROVAL_FORM_DRAG_MIME,
  createApprovalFormDragSession,
  decodeApprovalFormDragPayload,
  type ApprovalFormDragSession,
} from '../src/approvals/approvalFormDragPayload'
import {
  AUTHORABLE_FIELD_TYPES,
  type AuthorableFieldType,
} from '../src/approvals/templateAuthoring'

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

function dispatchDrag(
  el: Element,
  type: string,
  dataTransfer: DataTransfer | null = null,
): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  el.dispatchEvent(event)
}

let app: VueApp<Element> | null = null
let container: HTMLDivElement | null = null

interface PaletteHarness {
  state: { readOnly: boolean }
  appended: AuthorableFieldType[]
  chip(type: string): HTMLButtonElement
}

async function mountPalette(
  options: { readOnly?: boolean; dragSession?: ApprovalFormDragSession } = {},
): Promise<PaletteHarness> {
  container = document.createElement('div')
  document.body.appendChild(container)
  const state = reactive({ readOnly: options.readOnly ?? false })
  const appended: AuthorableFieldType[] = []
  app = createApp({
    setup() {
      return () =>
        h(ApprovalFormPalette, {
          readOnly: state.readOnly,
          dragSession: options.dragSession,
          onAppendField: (type: AuthorableFieldType) => {
            appended.push(type)
          },
        })
    },
  })
  app.mount(container)
  await nextTick()
  return {
    state,
    appended,
    chip(type: string) {
      const el = container!.querySelector(
        `[data-testid="approval-form-palette-chip-${type}"]`,
      )
      if (!el) throw new Error(`chip ${type} not rendered`)
      return el as HTMLButtonElement
    },
  }
}

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
})

describe('ApprovalFormPalette (F2)', () => {
  it('pins the shipped-shell grouping: every authorable type once, same groups/labels', () => {
    const groupedTypes = APPROVAL_FORM_PALETTE_GROUPS.flatMap((group) =>
      group.entries.map((entry) => entry.type),
    )
    expect([...groupedTypes].sort()).toEqual([...AUTHORABLE_FIELD_TYPES].sort())
    expect(groupedTypes).toHaveLength(new Set(groupedTypes).size)
    // Same group ids/labels as the shipped #4917 shell in TemplateAuthoringView.
    expect(
      APPROVAL_FORM_PALETTE_GROUPS.map((group) => [group.id, group.label]),
    ).toEqual([
      ['text', '文本'],
      ['number', '数值'],
      ['choice', '选项'],
      ['date', '日期'],
      ['other', '其他'],
    ])
    expect(APPROVAL_FORM_FIELD_TYPE_LABELS.text).toBe('文本')
    expect(APPROVAL_FORM_FIELD_TYPE_LABELS['record-link']).toBe('关联记录')
  })

  it('renders one keyboard-operable button chip per authorable type', async () => {
    const palette = await mountPalette()
    for (const type of AUTHORABLE_FIELD_TYPES) {
      const chip = palette.chip(type)
      // Native buttons: Enter/Space activation is complete without drag (FB-D2).
      expect(chip.tagName).toBe('BUTTON')
      expect(chip.getAttribute('draggable')).toBe('true')
      expect(chip.textContent).toContain(APPROVAL_FORM_FIELD_TYPE_LABELS[type])
    }
  })

  it('click emits ONE append-field intent per type — the palette never mutates a draft', async () => {
    const palette = await mountPalette()
    for (const type of AUTHORABLE_FIELD_TYPES) {
      palette.chip(type).click()
    }
    expect(palette.appended).toEqual([...AUTHORABLE_FIELD_TYPES])
  })

  it('dragstart writes the typed codec payload for EVERY type and begins the shared session; dragend clears', async () => {
    const dragSession = createApprovalFormDragSession()
    const palette = await mountPalette({ dragSession })
    for (const type of AUTHORABLE_FIELD_TYPES) {
      const dataTransfer = makeDataTransfer()
      const chip = palette.chip(type)
      dispatchDrag(chip, 'dragstart', dataTransfer)
      // Application MIME only — never a text/plain command mirror (§3.1).
      expect(Array.from(dataTransfer.types)).toEqual([APPROVAL_FORM_DRAG_MIME])
      expect(
        decodeApprovalFormDragPayload(
          dataTransfer.getData(APPROVAL_FORM_DRAG_MIME),
        ),
      ).toEqual({ version: 1, kind: 'palette', fieldType: type })
      expect(dragSession.active()).toEqual({
        version: 1,
        kind: 'palette',
        fieldType: type,
      })
      dispatchDrag(chip, 'dragend')
      expect(dragSession.active()).toBeNull()
    }
  })

  it('read-only mode renders NO chips (no draggable palette, §3.1) and the readOnly transition clears an in-flight drag', async () => {
    const dragSession = createApprovalFormDragSession()
    const palette = await mountPalette({ dragSession })
    dispatchDrag(palette.chip('text'), 'dragstart', makeDataTransfer())
    expect(dragSession.active()).not.toBeNull()

    palette.state.readOnly = true
    await nextTick()
    expect(dragSession.active()).toBeNull()
    expect(container!.querySelector('[draggable="true"]')).toBeNull()
    expect(
      container!.querySelector('[data-testid="approval-form-palette-chip-text"]'),
    ).toBeNull()
    expect(
      container!.querySelector(
        '[data-testid="approval-form-palette-readonly"]',
      )?.textContent,
    ).toContain('只读')
  })

  it('unmount (route change) clears the shared transient drag session', async () => {
    const dragSession = createApprovalFormDragSession()
    const palette = await mountPalette({ dragSession })
    dispatchDrag(palette.chip('user'), 'dragstart', makeDataTransfer())
    expect(dragSession.active()).not.toBeNull()
    app!.unmount()
    app = null
    expect(dragSession.active()).toBeNull()
  })
})
