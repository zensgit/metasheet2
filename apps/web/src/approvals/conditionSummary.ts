import type { ConditionBranch, ConditionNodeConfig, ConditionRule, FormSchema } from '../types/approval'

// G-B2-19 (benchmark §7.2) — readable condition-branch summaries. PURE logic module (no .vue /
// Element Plus import) so it runs under the approval-web-guard vitest gate, mirroring the sibling
// approvals/*.ts helpers. One function family, consumed by every surface that previously rendered
// raw `fieldId operator value` / bare edge keys:
//   1. TemplateAuthoringView `nodeConfigSummary` (read-only per-node descriptor)
//   2. TemplateAuthoringView condition-editor branch headers (live summary while editing)
//   3. TemplateDetailView / detail-side node preview (via the same nodeConfigSummary idiom)
//   4. `assigneeSource.nodeAssigneeSourceSummary`'s condition line (ApprovalNewView flow preview +
//      ApprovalDetailView upcoming-nodes synthesis) — enriched only when a schema is available.
// DISPLAY ONLY: never consumed by any graph write/normalize path (read-only-never-flatten floor).

/** zh operator vocabulary — MUST cover the full ConditionRule['operator'] union. */
const OPERATOR_ZH: Record<ConditionRule['operator'], string> = {
  eq: '=',
  neq: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  in: '属于',
  isEmpty: '为空',
}

function fieldLabel(fieldId: string, schema?: FormSchema | null): string {
  const label = schema?.fields?.find((field) => field.id === fieldId)?.label
  // Honest fallback: no schema / unknown field → the raw id (never blank, never throws).
  return label && label.trim() ? label : fieldId
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (Array.isArray(value)) return value.map((entry) => formatValue(entry)).join('、')
  if (typeof value === 'string') return `「${value}」`
  // Objects and anything exotic: JSON — still honest, still never throws.
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

/** One rule → 「金额 > 5000」 /「状态 属于 「a」、「b」」 /「备注 为空」. */
export function summarizeConditionRule(rule: ConditionRule, schema?: FormSchema | null): string {
  const label = fieldLabel(rule.fieldId, schema)
  // Unknown operator (forward-compat / malformed data): raw operator fallback, never throw.
  const op = OPERATOR_ZH[rule.operator] ?? String(rule.operator)
  if (rule.operator === 'isEmpty') return `${label} 为空`
  const value = formatValue(rule.value)
  return value ? `${label} ${op} ${value}` : `${label} ${op}`
}

/**
 * One branch → its readable predicate. Rules joined 且/或 per the branch conjunction; a
 * formula-mode branch shows its expression verbatim (公式 prefix); an empty branch is honest.
 */
export function summarizeConditionBranch(branch: ConditionBranch, schema?: FormSchema | null): string {
  if (branch.formula?.expression) return `公式：${branch.formula.expression}`
  const rules = branch.rules ?? []
  if (rules.length === 0) return '（无规则）'
  const joiner = (branch.conjunction ?? 'and') === 'or' ? ' 或 ' : ' 且 '
  return rules.map((rule) => summarizeConditionRule(rule, schema)).join(joiner)
}

/**
 * Whole condition node → one readable line per branch (+ the default fall-through). The edge key
 * stays visible as secondary provenance — authors still need to correlate with topology — but the
 * predicate leads.
 */
export function summarizeConditionNode(config: ConditionNodeConfig, schema?: FormSchema | null): string[] {
  const lines = (config.branches ?? []).map(
    (branch) => `分支「${summarizeConditionBranch(branch, schema)}」→ ${branch.edgeKey}`,
  )
  if (config.defaultEdgeKey) lines.push(`默认分支 → ${config.defaultEdgeKey}`)
  return lines
}
