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
 *
 * O-8 / F8-1: `isZh` defaults to zh-CN so the authoring callers (TemplateAuthoringView.vue,
 * linearStepSpine.ts — slice F8-3) keep today's output byte-for-byte; the member-facing path
 * (`nodeAssigneeSourceSummary` below, via ApprovalDetailView's upcoming nodes) passes the shell
 * locale. The English wording lives in `assigneeSourceSummaryEn`, so every shipped zh-CN line
 * below is unchanged.
 */
export function assigneeSourceSummary(source: ApprovalAssigneeSource, isZh = true): string {
  if (!isZh) return assigneeSourceSummaryEn(source)
  switch (source.kind) {
    case 'static_user': return `指定用户：${source.userIds.join('、') || '（无）'}`
    case 'static_role': return `指定角色：${source.roleIds.join('、') || '（无）'}`
    case 'requester': return '发起人'
    case 'form_field_user': return `表单用户字段：${source.fieldId}`
    case 'direct_manager': return '直属上级'
    case 'dept_head': return '部门主管'
    case 'continuous_managers': return `连续多级上级（${source.levels} 级）`
    case 'manager_at_level': return `指定层级上级（第 ${source.level} 级）`
    case 'continuous_dept_heads': return `连续多级部门负责人（${source.levels} 级）`
    case 'dept_head_at_level': return `指定层级部门负责人（第 ${source.level} 级）`
    // Lock-2 §L2-C: the concrete person derives from the contact chosen in the referenced form
    // field at submit time — the summary names the template-authored field id + level (values-free;
    // never a person id), mirroring the shipped form_field_user summary's field-id posture.
    case 'form_field_user_manager': return `表单内联系人上级：${source.fieldId}（第 ${source.level} 级）`
    case 'form_field_user_dept_head': return `表单内联系人部门负责人：${source.fieldId}（第 ${source.level} 级）`
    // Lock-1 §K2: pre-choice placeholder — the approver is unknowable until the requester
    // chooses at submit time, so the flow/route preview says exactly that.
    case 'requester_choice': return '提交人自选（提交时选择）'
    // Lock-1 §K3: the concrete person is unknowable until the referenced node decides at
    // runtime, so the summary names the referenced node key (a template-authored identifier,
    // §2.6-permitted — never a person id).
    case 'prior_node_approver': return `节点审批人（引用节点 ${source.nodeKey}）`
    // Lock-1 §K1: same raw-id-join posture as static_user/static_role above (group ids are
    // template-authored config, not group MEMBERSHIP — §2.6 permits the reference itself).
    case 'user_group': return `用户组：${source.groupIds.join('、') || '（无）'}`
    // Lock-1 §2.5 item 5: values-free fallback. The previous `JSON.stringify(source)` default
    // leaked raw config (including raw IDs) into an ordinary-user surface for any kind this
    // switch does not know — a defect, not a precedent, per the ratified lock. An unknown kind
    // gets a generic label and nothing else.
    default: return '（未知审批人来源）'
  }
}

/** English counterpart of `assigneeSourceSummary` — same kinds, same values-free posture. */
function assigneeSourceSummaryEn(source: ApprovalAssigneeSource): string {
  switch (source.kind) {
    case 'static_user': return `Users: ${source.userIds.join(', ') || '(none)'}`
    case 'static_role': return `Roles: ${source.roleIds.join(', ') || '(none)'}`
    case 'requester': return 'Requester'
    case 'form_field_user': return `Form user field: ${source.fieldId}`
    case 'direct_manager': return 'Direct manager'
    case 'dept_head': return 'Department head'
    case 'continuous_managers': return `Managers, ${source.levels} levels up`
    case 'manager_at_level': return `Manager at level ${source.level}`
    case 'continuous_dept_heads': return `Department heads, ${source.levels} levels up`
    case 'dept_head_at_level': return `Department head at level ${source.level}`
    case 'form_field_user_manager': return `Manager of the form contact: ${source.fieldId} (level ${source.level})`
    case 'form_field_user_dept_head': return `Department head of the form contact: ${source.fieldId} (level ${source.level})`
    case 'requester_choice': return 'Chosen by the requester at submission'
    case 'prior_node_approver': return `Approver of node ${source.nodeKey}`
    case 'user_group': return `User groups: ${source.groupIds.join(', ') || '(none)'}`
    default: return '(unknown approver source)'
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
 *
 * Both `assigneeSources`-shape id-bearing kinds (`static_user`/`static_role`) AND the legacy
 * `assigneeType`/`assigneeIds` shape are count-only here, never a raw id join — this function's
 * audience is the ordinary requester/approver reading "what's next" (see docstring above), not the
 * template author. `assigneeSourceSummary`'s own `static_user`/`static_role` cases DO join raw ids
 * (pinned byte-identical to the G-1 authoring preview it was moved from, `approval-assignee-source.
 * test.ts`), so those two kinds are intercepted HERE before delegating, the same pattern
 * `TemplateAuthoringView.vue`'s `nodeConfigSummary` and `ApprovalGraphNodeConfigEditor.vue`'s
 * `configuredSourceSummaryLine` already use around the same shared helper. Every other kind
 * (`user_group`/`form_field_user*`/`prior_node_approver`/…) keeps its template-authored
 * id/field-id/node-key — Lock-1 §2.6 permits those; only person identities are values-free here.
 */
function requesterFacingSourceSummary(source: ApprovalAssigneeSource, isZh: boolean): string {
  if (source.kind === 'static_user') {
    const count = source.userIds.length
    if (!isZh) return count ? `Specified users (${count})` : 'Specified users (none)'
    return `指定用户${count ? `（${count} 人）` : '（无）'}`
  }
  if (source.kind === 'static_role') {
    const count = source.roleIds.length
    if (!isZh) return count ? `Specified roles (${count})` : 'Specified roles (none)'
    return `指定角色${count ? `（${count} 个）` : '（无）'}`
  }
  return assigneeSourceSummary(source, isZh)
}

/**
 * O-8 / F8-1: the only caller is `buildUpcomingNodes`, which forwards the shell locale from
 * ApprovalDetailView (upcoming nodes) and ApprovalNewView (flow preview, via graphSummary.ts); the
 * zh-CN default only keeps the existing unit tests' calls unchanged.
 */
export function nodeAssigneeSourceSummary(node: ApprovalNode, schema?: FormSchema | null, isZh = true): string {
  const listSeparator = isZh ? '、' : ', '
  if (node.type === 'approval') {
    const cfg = node.config as ApprovalNodeConfig
    const sources = cfg.assigneeSources ?? []
    if (sources.length > 0) return sources.map((source) => requesterFacingSourceSummary(source, isZh)).join(listSeparator)
    if (cfg.assigneeType && cfg.assigneeIds && cfg.assigneeIds.length > 0) {
      const count = cfg.assigneeIds.length
      if (!isZh) return cfg.assigneeType === 'role' ? `Specified roles (${count})` : `Specified members (${count})`
      return cfg.assigneeType === 'role' ? `指定角色（${count} 个）` : `指定成员（${count} 人）`
    }
    return isZh ? '（未配置审批人）' : '(no approver configured)'
  }
  if (node.type === 'cc') {
    const cfg = node.config as CcNodeConfig
    // Lock-1 OD-L1-7(a): 'group' (用户组) joins user/role as a cc target kind; the roster label is
    // the lock's own "`user_group` (cc) | 用户组" row.
    if (!isZh) return cfg.targetType === 'role' ? 'CC roles' : cfg.targetType === 'group' ? 'CC groups' : 'CC members'
    return `抄送${cfg.targetType === 'role' ? '角色' : cfg.targetType === 'group' ? '用户组' : '成员'}`
  }
  if (node.type === 'condition') {
    // G-B2-19: with a schema in hand, the honest generic line gains the readable branch
    // predicates (capped at two — this is a one-line flow chip, not the authoring editor).
    const branches = (node.config as ConditionNodeConfig | undefined)?.branches ?? []
    if (schema && branches.length > 0) {
      const shown = branches.slice(0, 2).map((branch) => summarizeConditionBranch(branch, schema, isZh))
      if (!isZh) return `Continues by condition: ${shown.join('; ')}${branches.length > 2 ? '; …' : ''}`
      const suffix = branches.length > 2 ? '；…' : ''
      return `按条件进入后续分支：${shown.join('；')}${suffix}`
    }
    return isZh ? '按条件进入后续分支' : 'Continues by condition'
  }
  if (node.type === 'parallel') return isZh ? '进入并行分支' : 'Enters parallel branches'
  if (node.type === 'end') return isZh ? '流程结束' : 'Process ends'
  return ''
}
