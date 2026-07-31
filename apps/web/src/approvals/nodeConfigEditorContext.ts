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
} from './templateAuthoring'
import type { FormulaInsertOption } from './conditionEdit'

/**
 * Shared context for G-2..G-5 node config editors. Canvas inspector and structured-list mode both
 * inject this so they mutate the SAME draft.conditionEdits / parallelEdits / ccEdits /
 * approvalNodeEdits handlers — one source of truth (Canvas V2 Slice A).
 *
 * C1: the approval-node accessors below are carrier-agnostic. A node from a preserved complex graph
 * resolves to `draft.approvalNodeEdits[nodeKey]`; a node projected from a LINEAR draft resolves to
 * the matching `draft.steps[i]` (see `linearCanvasCarrier`). Both write straight through to the
 * draft the payload builders read — the inspector never holds a shadow copy of either.
 */
export interface ApprovalNodeConfigEditorApi {
  readOnly: ComputedRef<boolean> | Ref<boolean> | boolean
  conditionEditFor: (nodeKey: string) => ConditionNodeEdit | undefined
  parallelEditFor: (nodeKey: string) => ParallelNodeEdit | undefined
  ccEditFor: (nodeKey: string) => CcNodeEdit | undefined
  /**
   * True when an `approval` node has an edit carrier and so renders the editable form rather than
   * the read-only summary (a legacy complex node with no `assigneeSources` has none). This is the
   * render gate ON PURPOSE — gating on a carrier OBJECT would silently exclude linear steps, whose
   * carrier is not an `ApprovalNodeSourceEdit`. Says nothing about `readOnly`, which disables the
   * controls but still renders them.
   */
  hasApprovalNodeEditor: (nodeKey: string) => boolean
  conditionFieldOptions: ComputedRef<Array<{ id: string; label: string }>> | Array<{ id: string; label: string }>
  userFields: ComputedRef<Array<{ id: string; label: string }>> | Array<{ id: string; label: string }>
  conditionFormulaInsertOptions: ComputedRef<FormulaInsertOption[]> | FormulaInsertOption[]
  fieldPermissionFields: ComputedRef<Array<{ id: string; label: string }>> | Array<{ id: string; label: string }>
  conditionOperatorLabel: (operator: ConditionRuleOperator) => string
  liveBranchSummary: (branch: ConditionBranchEdit) => string
  conditionRuleValueText: (rule: ConditionRuleEdit) => string
  setConditionConjunction: (nodeKey: string, edgeKey: string, conjunction: 'and' | 'or') => void
  setConditionRuleField: (nodeKey: string, edgeKey: string, ruleIndex: number, fieldId: string) => void
  setConditionRuleOperator: (nodeKey: string, edgeKey: string, ruleIndex: number, operator: ConditionRuleOperator) => void
  setConditionRuleValue: (nodeKey: string, edgeKey: string, ruleIndex: number, text: string) => void
  addConditionRule: (nodeKey: string, edgeKey: string) => void
  removeConditionRule: (nodeKey: string, edgeKey: string, ruleIndex: number) => void
  setConditionBranchPredicateMode: (nodeKey: string, edgeKey: string, mode: string) => void
  setConditionFormulaExpression: (nodeKey: string, edgeKey: string, expression: string) => void
  insertConditionFormulaToken: (nodeKey: string, edgeKey: string, token: string) => void
  insertConditionFormulaFunction: (nodeKey: string, edgeKey: string, fn: 'SUM' | 'COUNT' | 'MIN' | 'MAX') => void
  insertConditionFormulaRoleMembership: (nodeKey: string, edgeKey: string, roleId: string) => void
  setConditionDefaultEdge: (nodeKey: string, edgeKey: string) => void
  conditionFormulaDryRunResult: (nodeKey: string, edgeKey: string) => string
  conditionFormulaDryRunLoading: (nodeKey: string, edgeKey: string) => boolean
  dryRunConditionFormula: (nodeKey: string, branch: ConditionBranchEdit) => void | Promise<void>
  conditionOutgoingEdgeKeys: (nodeKey: string) => string[]
  conditionEdgeLabel: (nodeKey: string, edgeKey: string) => string
  graphEdgeTargetLabel: (nodeKey: string, edgeKey: string) => string
  graphNodeLabel: (nodeKey: string) => string
  parallelJoinModeLabel: (mode: ParallelJoinMode) => string
  setParallelJoinMode: (nodeKey: string, mode: ParallelJoinMode) => void
  ccTargetTypeLabel: (targetType: ApprovalAssigneeType) => string
  setCcTargetType: (nodeKey: string, targetType: ApprovalAssigneeType) => void
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
