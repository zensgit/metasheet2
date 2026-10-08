import { ApprovalApiError } from './api'

const AUTHORING_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT: '多个并行分支的审批人可能重复，请调整审批人配置后重试',
  APPROVAL_CONDITION_BRANCH_RULES_EMPTY: '条件分支必须配置条件，默认分支请使用“其他情况”',
  APPROVAL_CONDITION_FORMULA_STATIC: '条件公式必须引用表单或发起人数据',
  APPROVAL_CONDITION_FORMULA_ALWAYS_TRUE: '条件公式会匹配所有有效申请，请改用“其他情况”分支',
  // T5b (test report 2026-10-08): publish of a draft that still carries the approver placeholder.
  APPROVAL_ROLE_PLACEHOLDER_NOT_CONFIGURED: '仍有审批节点使用占位审批角色，请先替换为真实审批人后再发布',
}

/**
 * T5b: optional resolver from a node key to its BUSINESS label (the author-given name or the node
 * type word). It must never return the key itself; `undefined` (unknown key) falls back to the
 * unattributed copy. Supplied by the authoring view from the graph the failed request carried.
 */
export interface TemplateAuthoringErrorContext {
  nodeLabel?: (nodeKey: string) => string | undefined
}

function labelOf(value: unknown, context: TemplateAuthoringErrorContext): string | undefined {
  if (typeof value !== 'string' || !value || !context.nodeLabel) return undefined
  const label = context.nodeLabel(value)?.trim()
  return label && label !== value ? label : undefined
}

function labelsOf(values: unknown, context: TemplateAuthoringErrorContext): string[] {
  if (!Array.isArray(values)) return []
  const labels = values.map((value) => labelOf(value, context))
  return labels.every((label): label is string => Boolean(label)) ? labels : []
}

/**
 * Gate r1 NIT-5: two nodes that share one business label (e.g. two lanes both named after their
 * node type) would read 「审批」与「审批」, which names nothing. Such a pair falls back to the
 * unattributed copy instead; the values-free details carry no lane position to number them by.
 */
function distinctLabels(labels: string[]): boolean {
  return new Set(labels).size === labels.length
}

/**
 * Authoring writes never echo arbitrary backend messages. Known machine codes
 * get actionable copy; everything else stays values-free and identifier-free.
 *
 * T5b (test report 2026-10-08): when the server attaches values-free `details` (node keys only),
 * the copy names the offending branches/nodes by their business labels — e.g. two parallel
 * branches sharing one approver — instead of the opaque fallback.
 */
export function describeTemplateAuthoringError(
  error: unknown,
  fallback: string,
  context: TemplateAuthoringErrorContext = {},
): string {
  if (!(error instanceof ApprovalApiError)) return fallback
  const details = error.details ?? {}
  if (details.reason === 'parallel_duplicate_approver') {
    const lanes = labelsOf(details.conflictingNodeKeys, context)
    const gateway = labelOf(details.nodeKey, context)
    if (lanes.length === 2 && distinctLabels(lanes)) {
      return `并行分支${gateway ? `「${gateway}」` : ''}中「${lanes[0]}」与「${lanes[1]}」的审批人相同，请为每个分支选择不同的审批人`
    }
    return '并行分支中有两个分支的审批人相同，请为每个分支选择不同的审批人'
  }
  if (error.code === 'APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT') {
    const nodes = labelsOf(details.conflictingNodeKeys, context)
    if (nodes.length >= 2 && distinctLabels(nodes.slice(0, 2))) {
      return `并行分支中「${nodes[0]}」与「${nodes[1]}」的审批人可能重复，请调整审批人配置后重试`
    }
  }
  if (error.code === 'APPROVAL_ROLE_PLACEHOLDER_NOT_CONFIGURED') {
    const node = labelOf(details.nodeKey, context)
    if (node) return `审批节点「${node}」仍为占位审批角色，请先替换为真实审批人后再发布`
  }
  return (error.code && AUTHORING_ERROR_MESSAGES[error.code]) || fallback
}
