import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type {
  ApprovalAssigneeSourceKind,
  ApprovalAssigneeType,
  ApprovalMode,
  ApprovalNode,
  EmptyAssigneePolicy,
  NodeFieldAccess,
  ParallelJoinMode,
} from '../types/approval'
import type {
  ConditionBranchEdit,
  ConditionNodeEdit,
  ConditionRuleEdit,
  ConditionRuleOperator,
  CcNodeEdit,
  ParallelNodeEdit,
  ApprovalNodeSourceEdit,
} from './templateAuthoring'
import type { FormulaInsertOption } from './conditionEdit'

/**
 * Shared context for G-2..G-5 node config editors. Canvas inspector and structured-list mode both
 * inject this so they mutate the SAME draft.conditionEdits / parallelEdits / ccEdits /
 * approvalNodeEdits handlers — one source of truth (Canvas V2 Slice A).
 */
export interface ApprovalNodeConfigEditorApi {
  readOnly: ComputedRef<boolean> | Ref<boolean> | boolean
  conditionEditFor: (nodeKey: string) => ConditionNodeEdit | undefined
  parallelEditFor: (nodeKey: string) => ParallelNodeEdit | undefined
  ccEditFor: (nodeKey: string) => CcNodeEdit | undefined
  approvalNodeEditFor: (nodeKey: string) => ApprovalNodeSourceEdit | undefined
  conditionFieldOptions: ComputedRef<Array<{ id: string; label: string }>> | Array<{ id: string; label: string }>
  userFields: ComputedRef<Array<{ id: string; label: string }>> | Array<{ id: string; label: string }>
  conditionFormulaInsertOptions: ComputedRef<FormulaInsertOption[]> | FormulaInsertOption[]
  fieldPermissionFields: ComputedRef<Array<{ id: string; label: string }>> | Array<{ id: string; label: string }>
  conditionOperatorLabel: (operator: ConditionRuleOperator) => string
  liveBranchSummary: (branch: ConditionBranchEdit) => string
  conditionRuleValueText: (rule: ConditionRuleEdit) => string
  setConditionRuleValue: (rule: ConditionRuleEdit, text: string) => void
  addConditionRule: (branch: ConditionBranchEdit) => void
  removeConditionRule: (branch: ConditionBranchEdit, ruleIndex: number) => void
  setConditionBranchPredicateMode: (branch: ConditionBranchEdit, mode: string) => void
  insertConditionFormulaToken: (branch: ConditionBranchEdit, token: string) => void
  insertConditionFormulaFunction: (branch: ConditionBranchEdit, fn: 'SUM' | 'COUNT' | 'MIN' | 'MAX') => void
  insertConditionFormulaRoleMembership: (branch: ConditionBranchEdit, roleId: string) => void
  conditionFormulaDryRunResult: (nodeKey: string, edgeKey: string) => string
  conditionFormulaDryRunLoading: (nodeKey: string, edgeKey: string) => boolean
  dryRunConditionFormula: (nodeKey: string, branch: ConditionBranchEdit) => void | Promise<void>
  conditionOutgoingEdgeKeys: (nodeKey: string) => string[]
  conditionEdgeLabel: (nodeKey: string, edgeKey: string) => string
  graphEdgeTargetLabel: (nodeKey: string, edgeKey: string) => string
  graphNodeLabel: (nodeKey: string) => string
  parallelJoinModeLabel: (mode: ParallelJoinMode) => string
  ccTargetTypeLabel: (targetType: ApprovalAssigneeType) => string
  setCcTargetIds: (nodeKey: string, ids: string[]) => void
  syncCcOptions: (nodeKey: string) => void
  approvalSourceKind: (nodeKey: string) => ApprovalAssigneeSourceKind
  setApprovalSourceKind: (nodeKey: string, kind: ApprovalAssigneeSourceKind) => void
  syncApprovalNodeOptions: (nodeKey: string) => void
  approvalSourceIds: (nodeKey: string) => string[]
  setApprovalSourceIdsFromPicker: (nodeKey: string, ids: string[]) => void
  approvalSourceFieldId: (nodeKey: string) => string
  setApprovalSourceFieldId: (nodeKey: string, fieldId: string) => void
  approvalSourceLevel: (nodeKey: string) => number
  setApprovalSourceLevel: (nodeKey: string, value: number) => void
  approvalSourceIsPlaceholder: (nodeKey: string) => boolean
  approvalNodeMode: (nodeKey: string) => ApprovalMode
  setApprovalNodeMode: (nodeKey: string, mode: ApprovalMode) => void
  approvalNodeEmptyPolicy: (nodeKey: string) => EmptyAssigneePolicy
  setApprovalNodeEmptyPolicy: (nodeKey: string, policy: EmptyAssigneePolicy) => void
  approvalNodeMergeWithRequester: (nodeKey: string) => boolean
  setApprovalNodeMergeWithRequester: (nodeKey: string, enabled: boolean) => void
  approvalNodeFieldAccess: (nodeKey: string, fieldId: string) => NodeFieldAccess
  setApprovalNodeFieldAccess: (nodeKey: string, fieldId: string, access: NodeFieldAccess) => void
  nodeConfigSummary: (node: ApprovalNode) => string[]
  /**
   * Lock-0 L0-6/D5 — graph-wide field ids referenced by ANY node's `form_field_user` assignee
   * source (not just the node currently being edited). WIRED: `TemplateAuthoringView.vue` provides
   * its `routingDriverFieldIds` computed here. That computed unions TWO models —
   * `draft.steps` (linear authoring) and `draft.approvalNodeEdits[key].assigneeSources` (graph
   * authoring) — because a naive pass-through of the pre-existing linear-only computed does NOT
   * work: once a draft is promoted to graph authoring, `draft.steps` is always `[]` (see
   * `draftFromEditedGraph` / `draftFromTemplate`'s `complex` branch), and the canvas inspector this
   * field feeds mounts ONLY on complex graphs — so a linear-only read is structurally empty on
   * exactly the surface D5 targets (measured: `draft.steps.length === 0` there, while
   * `approvalNodeEdits` carries the live `form_field_user` sources). OPTIONAL only so
   * component-level tests that don't need D5 (most of the suite) can omit it — the property is
   * always present on the shipped app's api object.
   */
  routingDriverFieldIds?: ComputedRef<Set<string>> | Ref<Set<string>> | Set<string>
  onUserSearch: (query: string) => void | Promise<void>
  directoryUsers: ComputedRef<Array<{ id: string }>> | Ref<Array<{ id: string }>> | Array<{ id: string }>
  directoryUsersLoading: ComputedRef<boolean> | Ref<boolean> | boolean
  directoryRoles: ComputedRef<Array<{ id: string }>> | Ref<Array<{ id: string }>> | Array<{ id: string }>
  formulaRoles: ComputedRef<Array<{ id: string }>> | Ref<Array<{ id: string }>> | Array<{ id: string }>
  formatUserLabel: (user: { id: string; name?: string; email?: string }) => string
  formatRoleLabel: (role: { id: string; name?: string }) => string
}

export const APPROVAL_NODE_CONFIG_EDITOR_KEY: InjectionKey<ApprovalNodeConfigEditorApi> =
  Symbol('approvalNodeConfigEditor')
