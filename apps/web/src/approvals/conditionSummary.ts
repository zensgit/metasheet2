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

/** O-8 / F8-1: en operator vocabulary — same union coverage as `OPERATOR_ZH`. */
const OPERATOR_EN: Record<ConditionRule['operator'], string> = {
  eq: '=',
  neq: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  in: 'in',
  isEmpty: 'is empty',
}

function fieldLabel(fieldId: string, schema?: FormSchema | null): string {
  const label = schema?.fields?.find((field) => field.id === fieldId)?.label
  // Honest fallback: no schema / unknown field → the raw id (never blank, never throws).
  return label && label.trim() ? label : fieldId
}

function formatValue(value: unknown, isZh: boolean): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? (isZh ? '是' : 'yes') : (isZh ? '否' : 'no')
  if (Array.isArray(value)) return value.map((entry) => formatValue(entry, isZh)).join(isZh ? '、' : ', ')
  if (typeof value === 'string') return isZh ? `「${value}」` : `"${value}"`
  // Objects and anything exotic: JSON — still honest, still never throws.
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

/**
 * One rule → 「金额 > 5000」 /「状态 属于 「a」、「b」」 /「备注 为空」.
 * O-8 / F8-1: every exported summarizer takes `isZh` (default zh-CN for the not-yet-converted
 * authoring callers in TemplateAuthoringView.vue, slice F8-3; the member-facing upcoming-nodes
 * path passes the shell locale).
 */
export function summarizeConditionRule(rule: ConditionRule, schema?: FormSchema | null, isZh = true): string {
  const label = fieldLabel(rule.fieldId, schema)
  // Unknown operator (forward-compat / malformed data): raw operator fallback, never throw.
  const op = (isZh ? OPERATOR_ZH : OPERATOR_EN)[rule.operator] ?? String(rule.operator)
  if (rule.operator === 'isEmpty') return isZh ? `${label} 为空` : `${label} is empty`
  const value = formatValue(rule.value, isZh)
  return value ? `${label} ${op} ${value}` : `${label} ${op}`
}

/**
 * One branch → its readable predicate. Rules joined 且/或 per the branch conjunction; a
 * formula-mode branch shows its expression verbatim (公式 prefix); an empty branch is honest.
 */
export function summarizeConditionBranch(branch: ConditionBranch, schema?: FormSchema | null, isZh = true): string {
  if (branch.formula?.expression) return isZh ? `公式：${branch.formula.expression}` : `Formula: ${branch.formula.expression}`
  const rules = branch.rules ?? []
  if (rules.length === 0) return isZh ? '（无规则）' : '(no rules)'
  const isOr = (branch.conjunction ?? 'and') === 'or'
  const joiner = isOr ? (isZh ? ' 或 ' : ' or ') : (isZh ? ' 且 ' : ' and ')
  return rules.map((rule) => summarizeConditionRule(rule, schema, isZh)).join(joiner)
}

/**
 * Whole condition node → one readable line per branch (+ the default fall-through). The edge key
 * stays visible as secondary provenance — authors still need to correlate with topology — but the
 * predicate leads.
 */
export function summarizeConditionNode(config: ConditionNodeConfig, schema?: FormSchema | null, isZh = true): string[] {
  const lines = (config.branches ?? []).map((branch) => {
    const predicate = summarizeConditionBranch(branch, schema, isZh)
    return isZh ? `分支「${predicate}」→ ${branch.edgeKey}` : `Branch "${predicate}" → ${branch.edgeKey}`
  })
  if (config.defaultEdgeKey) {
    lines.push(isZh ? `默认分支 → ${config.defaultEdgeKey}` : `Default branch → ${config.defaultEdgeKey}`)
  }
  return lines
}
