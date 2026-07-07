import { summarizeConditionBranch } from './conditionSummary'
import type {
  ConditionNodeConfig,
  FormSchema,
  ApprovalAssigneeSource,
  ApprovalNode,
  ApprovalNodeConfig,
  CcNodeConfig,
} from '../types/approval'

/**
 * Human-readable summary of a single assignee source (审批人来源) — one short Chinese phrase per
 * source kind. Moved here (UX B2-08) from `TemplateAuthoringView.vue`'s G-1 read-only graph
 * preview (`nodeConfigSummary`) so the approval detail view's "upcoming nodes" synthesis (see
 * `upcomingNodes.ts`) can reuse the exact same wording instead of re-deriving it. Behavior is
 * byte-identical to the original — no wording change, since it is already shipped in the G-1
 * preview.
 */
export function assigneeSourceSummary(source: ApprovalAssigneeSource): string {
  switch (source.kind) {
    case 'static_user': return `指定用户：${source.userIds.join('、') || '（无）'}`
    case 'static_role': return `指定角色：${source.roleIds.join('、') || '（无）'}`
    case 'requester': return '发起人'
    case 'form_field_user': return `表单用户字段：${source.fieldId}`
    case 'direct_manager': return '直属上级'
    case 'dept_head': return '部门主管'
    case 'continuous_managers': return `连续多级上级（${source.levels} 级）`
    case 'manager_at_level': return `指定层级上级（第 ${source.level} 级）`
    default: return JSON.stringify(source)
  }
}

/**
 * Node-level assignee-source summary (UX B2-08) — a single display line describing WHO/WHAT
 * resolves the pending handler(s) at a node, for the approval detail view's requester-facing
 * "upcoming nodes" preview (not an authoring tool, so no ids-heavy dump — just enough to
 * recognize the step).
 *
 * For an `approval` node this prefers the current `assigneeSources` shape (joins every
 * configured source with '、'), and falls back to the older `assigneeType`/`assigneeIds` shape —
 * still a valid, round-tripped shape (see `ApprovalProductService`'s graph validation, which
 * accepts EITHER shape, and `TemplateDetailView.vue`'s own node-assignee rendering, which in fact
 * handles ONLY this legacy shape) — so a template authored before `assigneeSources` existed still
 * gets a real summary instead of "unconfigured". `cc`/`condition`/`parallel`/`end` each get a
 * fixed one-line description; `start` (never an "upcoming" node in a valid DAG) falls through to
 * `''`.
 */
export function nodeAssigneeSourceSummary(node: ApprovalNode, schema?: FormSchema | null): string {
  if (node.type === 'approval') {
    const cfg = node.config as ApprovalNodeConfig
    const sources = cfg.assigneeSources ?? []
    if (sources.length > 0) return sources.map(assigneeSourceSummary).join('、')
    if (cfg.assigneeType && cfg.assigneeIds && cfg.assigneeIds.length > 0) {
      return `${cfg.assigneeType === 'role' ? '指定角色' : '指定成员'}：${cfg.assigneeIds.join('、')}`
    }
    return '（未配置审批人）'
  }
  if (node.type === 'cc') {
    const cfg = node.config as CcNodeConfig
    return `抄送${cfg.targetType === 'role' ? '角色' : '成员'}`
  }
  if (node.type === 'condition') {
    // G-B2-19: with a schema in hand, the honest generic line gains the readable branch
    // predicates (capped at two — this is a one-line flow chip, not the authoring editor).
    const branches = (node.config as ConditionNodeConfig | undefined)?.branches ?? []
    if (schema && branches.length > 0) {
      const shown = branches.slice(0, 2).map((branch) => summarizeConditionBranch(branch, schema))
      const suffix = branches.length > 2 ? '；…' : ''
      return `按条件进入后续分支：${shown.join('；')}${suffix}`
    }
    return '按条件进入后续分支'
  }
  if (node.type === 'parallel') return '进入并行分支'
  if (node.type === 'end') return '流程结束'
  return ''
}
