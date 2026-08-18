// Browser-verification harness for the F2 Designer 2.0 form builder (delta §5
// F2 / §7.1 item 7 owned harness). Mounts the REAL ApprovalFormPalette +
// ApprovalFormBuilder with one shared transient drag session (exactly the F4
// composition shape) and publishes bounded, VALUES-FREE metrics for Playwright:
// field types in order, slot/history counts, drag-state, and the status copy.
// No persistent ids, labels, or draft values are exported.
// FAIL-5 fix (P7-R2, 20260818): production theme + design tokens, exactly as
// apps/web/src/main.ts loads them. Without these every `var(--el-*)`/`var(--ms-*)` reference in
// the mounted components' scoped CSS is undefined, so Chromium drops the whole declaration and
// any focus-ring / paint measurement over this harness is vacuously empty (measured: 27/28
// controls falsely reported "no focus ring" before this import; 28/28 after). CSS-only — no
// `element-plus` plugin registration: neither ApprovalFormPalette nor ApprovalFormBuilder render
// any `<el-*>` component, so `.use(ElementPlus)` would add a runtime dependency with no
// contrast benefit.
import 'element-plus/dist/index.css'
import '../src/styles/tokens.css'
import { createApp, h, ref } from 'vue'
import ApprovalFormBuilder, {
  STALE_SLOT_RETRY_MESSAGE,
} from '../src/approvals/components/ApprovalFormBuilder.vue'
import ApprovalFormPalette from '../src/approvals/components/ApprovalFormPalette.vue'
import {
  APPROVAL_FORM_DRAG_MIME,
  createApprovalFormDragSession,
} from '../src/approvals/approvalFormDragPayload'
import type { FormAuthoringSession } from '../src/approvals/approvalFormAuthoringAdapter'
import {
  createEmptyFieldDraft,
  createEmptyStepDraft,
  createEmptyTemplateDraft,
  type AuthorableFieldType,
  type FieldAuthoringDraft,
  type TemplateAuthoringDraft,
} from '../src/approvals/templateAuthoring'

interface AfbState {
  /** Field types in canvas order — from the SESSION (sync source of truth). */
  order: string[]
  /** Field types in canvas order — from the rendered DOM. */
  domOrder: (string | null)[]
  slotCount: number
  historyDepth: number
  statusText: string
  activeDragKind: 'palette' | 'field' | null
  readOnly: boolean
}

interface AfbHarnessApi {
  ready: true
  /** The application drag MIME — asserted against the spec's literal. */
  mime: string
  staleRetryMessage: string
  state(): AfbState
  /** Adapter-backed removal of the field at list index 1 (stale-anchor setup). */
  removeSecondField(): boolean
  setReadOnly(value: boolean): void
}

declare global {
  interface Window {
    __AFB__?: AfbHarnessApi
  }
}

interface BuilderExposed {
  appendField(type: AuthorableFieldType): boolean
  removeField(localId: string): boolean
  getSession(): FormAuthoringSession
}

function field(
  index: number,
  type: AuthorableFieldType,
): FieldAuthoringDraft {
  return {
    ...createEmptyFieldDraft(index),
    localId: `local_${index}`,
    id: `field_${index}`,
    type,
    label: `字段 ${index}`,
  }
}

const draft: TemplateAuthoringDraft = {
  ...createEmptyTemplateDraft(),
  key: 'afb_harness',
  name: '表单构建器验证',
  fields: [field(1, 'text'), field(2, 'number'), field(3, 'date')],
  steps: [createEmptyStepDraft(1)],
}

const dragSession = createApprovalFormDragSession()
const builderRef = ref<BuilderExposed | null>(null)
const readOnly = ref(false)

createApp({
  setup() {
    return () => [
      h(ApprovalFormPalette, {
        readOnly: readOnly.value,
        dragSession,
        onAppendField: (type: AuthorableFieldType) => {
          builderRef.value?.appendField(type)
        },
      }),
      h(ApprovalFormBuilder, {
        draft,
        readOnly: readOnly.value,
        dragSession,
        ref: builderRef,
      }),
    ]
  },
}).mount('#app')

window.__AFB__ = {
  ready: true,
  mime: APPROVAL_FORM_DRAG_MIME,
  staleRetryMessage: STALE_SLOT_RETRY_MESSAGE,
  state(): AfbState {
    const session = builderRef.value!.getSession()
    return {
      order: session.draft.fields.map((entry) => entry.type),
      domOrder: Array.from(
        document.querySelectorAll(
          '[data-testid="approval-form-builder-card"]',
        ),
      ).map((card) => card.getAttribute('data-field-type')),
      slotCount: document.querySelectorAll('.approval-form-builder__slot')
        .length,
      historyDepth: session.history.undoStack.length,
      statusText:
        document.querySelector(
          '[data-testid="approval-form-builder-status"]',
        )?.textContent ?? '',
      activeDragKind: dragSession.active()?.kind ?? null,
      readOnly: readOnly.value,
    }
  },
  removeSecondField(): boolean {
    const session = builderRef.value!.getSession()
    const second = session.draft.fields[1]
    if (!second) return false
    return builderRef.value!.removeField(second.localId)
  },
  setReadOnly(value: boolean): void {
    readOnly.value = value
  },
}
window.dispatchEvent(new Event('afb-ready'))
