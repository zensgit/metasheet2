import { assigneeSourceSummary } from './assigneeSource'
import { parseIdsText, sourceFromStep, type ApprovalStepDraft } from './templateAuthoring'

/**
 * G-B2-06 — read-only "flow spine" for a LINEAR template's steps: 发起人 → 步骤1 → 步骤2 → … one
 * chip per hop. Pure derivation straight from `draft.value.steps` (`TemplateAuthoringView.vue`'s
 * linear editor model) — no canvas, no `ApprovalGraph`, no Element Plus, no I/O. This is
 * deliberately NOT the same code path as the preserved-complex-graph read-only preview
 * (`graphPreviewNodes` / `nodeConfigSummary` in the view, backed by `graphSummary.ts` /
 * `assigneeSource.ts`'s `nodeAssigneeSourceSummary` for an `ApprovalGraph`) — a linear draft has
 * no graph to walk until save builds one, and 90% of authors only ever see the linear form-card
 * stack, never the graph tooling. The two previews are allowed to diverge; this module only
 * covers the linear shape.
 *
 * The per-source human text is NOT re-derived here: `sourceFromStep` (templateAuthoring.ts)
 * builds the exact `ApprovalAssigneeSource` the saved graph would carry, and `assigneeSourceSummary`
 * (assigneeSource.ts) is the SAME humanizer the preserved-complex-graph preview already uses — so a
 * `static_role`/`continuous_managers`/etc. chip reads identically whether the template is linear or
 * complex, and a wording change only has one place to land.
 */
export interface LinearStepSpineChip {
  /** Stable key: the fixed sentinel for the leading chip, else the step's `localId`. */
  key: string
  role: 'requester' | 'step'
  /** Chip headline — `发起人` for the leading chip, else the step's name (or its positional
   * default `审批人 N`, mirroring `buildApprovalGraph`'s own empty-name fallback). */
  label: string
  /** One-line human summary of the approver source (`''` for the requester chip, which has none). */
  sourceSummary: string
  /** False when the step's source is missing required author input (see `isStepSourceResolvable`).
   * Always `true` for the requester chip — there is nothing to configure. */
  resolvable: boolean
  /** 1-based position in the `steps` array; `null` for the requester chip. */
  stepIndex: number | null
}

export const REQUESTER_SPINE_KEY = '__requester__'

/**
 * True when a step's `sourceKind` carries the author input it needs to resolve to anyone at
 * save/run time: `static_user`/`static_role` need at least one id, `form_field_user` needs a
 * chosen field. Every other kind (`requester`/`direct_manager`/`dept_head`/`continuous_managers`/
 * `manager_at_level`) needs no additional author input beyond its own defaults, so it is always
 * "resolvable" from the DRAFT's point of view — this is authoring-completeness, not a live
 * directory/org lookup (this module does no I/O, matching every other pure `approvals/*` helper).
 */
export function isStepSourceResolvable(step: ApprovalStepDraft): boolean {
  switch (step.sourceKind) {
    case 'static_user':
    case 'static_role':
      return parseIdsText(step.idsText).length > 0
    case 'form_field_user':
      return step.fieldId.trim().length > 0
    default:
      return true
  }
}

// `assigneeSourceSummary` already gives static_user/static_role an honest `（无）` placeholder
// when their id array is empty. `form_field_user` is the one shape it does not already cover
// (an unset fieldId renders as the bare `表单用户字段：`) — so that one case gets the same
// honest-placeholder treatment here, in the SAME bracket convention, instead of a half-empty label.
function stepSourceSummary(step: ApprovalStepDraft, resolvable: boolean): string {
  if (step.sourceKind === 'form_field_user' && !resolvable) return '表单用户字段：（未选择）'
  return assigneeSourceSummary(sourceFromStep(step))
}

/**
 * Build the read-only spine chip list for a linear template's steps. The requester chip is
 * ALWAYS first, even for an empty `steps` array — the flow always starts with whoever submits
 * the form, regardless of how many approval steps follow.
 */
export function buildLinearStepSpine(steps: ApprovalStepDraft[]): LinearStepSpineChip[] {
  const requesterChip: LinearStepSpineChip = {
    key: REQUESTER_SPINE_KEY,
    role: 'requester',
    label: '发起人',
    sourceSummary: '',
    resolvable: true,
    stepIndex: null,
  }
  const stepChips = steps.map((step, index) => {
    const position = index + 1
    const resolvable = isStepSourceResolvable(step)
    return {
      key: step.localId,
      role: 'step' as const,
      label: step.name.trim() || `审批人 ${position}`,
      sourceSummary: stepSourceSummary(step, resolvable),
      resolvable,
      stepIndex: position,
    }
  })
  return [requesterChip, ...stepChips]
}
