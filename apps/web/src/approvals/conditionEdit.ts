import type {
  ApprovalGraph,
  ApprovalNode,
  ConditionBranch,
  ConditionNodeConfig,
  ConditionRule,
  FormSchema,
} from '../types/approval'

// G-2 — condition node editing (LOGIC ONLY; no .vue / Element Plus import so this runs under the
// approval-web-guard vitest gate). The scope is the condition *logic* — each branch's `rules`,
// `conjunction`, and the node's `defaultEdgeKey`. Branch/edge TOPOLOGY (which branches exist, their
// edgeKeys, their targets) and every OTHER node/edge are PRESERVED byte-for-byte (G-1 anti-flatten
// floor). parallel / cc nodes stay read-only (G-3 / G-4).

/** The condition-rule operator union the runtime + backend `normalizeApprovalGraph` recognise. */
export const CONDITION_RULE_OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'isEmpty'] as const
export type ConditionRuleOperator = ConditionRule['operator']
const CONDITION_RULE_OPERATOR_SET = new Set<string>(CONDITION_RULE_OPERATORS)

/**
 * Editable model for one condition node. `branches` mirrors the node config's branches 1:1 — the
 * editor may change each branch's `rules` / `conjunction` but NOT add/remove a branch or change its
 * `edgeKey` (topology, a later slice). `defaultEdgeKey` is editable: it is the FALL-THROUGH edge
 * (taken when no branch matches), and must be an existing OUTGOING edge of the node — NOT one of the
 * branch `edgeKey`s (see `validateConditionEdits`). The edit model is keyed by node `key`.
 */
export interface ConditionNodeEdit {
  nodeKey: string
  branches: ConditionBranchEdit[]
  defaultEdgeKey: string
}

export interface ConditionBranchEdit {
  // Topology — preserved verbatim; the editor never mutates these.
  edgeKey: string
  conjunction: 'and' | 'or'
  rules: ConditionRuleEdit[]
}

export interface ConditionRuleEdit {
  fieldId: string
  operator: ConditionRuleOperator
  // The raw rule value. Carried as `unknown` so a seeded value round-trips identically; the editor
  // surface (text input) writes a string. `undefined` ⇒ the emitted rule omits `value` (matching
  // `isEmpty` and the backend's omit-when-undefined discipline).
  value: unknown
}

/** Map of condition edits keyed by node key, seeded from a preserved graph and edited in place. */
export type ConditionEdits = Record<string, ConditionNodeEdit>

// Deep clone for the preserved-graph pass-through. The graph is pure JSON-serialisable data (the
// backend persists it as JSON), and — unlike `structuredClone` — a JSON round-trip works on the
// Vue reactive Proxy the authoring view wraps the draft in (`structuredClone` throws DATA_CLONE_ERR
// on a Proxy). JSON dropping `undefined`-valued keys is fine: a backend-normalised graph carries
// none, so this is identity for the preserved nodes/edges we pass through unchanged.
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isConditionConfig(config: ApprovalNode['config']): config is ConditionNodeConfig {
  return Boolean(config) && Array.isArray((config as ConditionNodeConfig).branches)
}

/** True when a rule operator is one the editor's select offers (and the backend accepts). */
export function isConditionRuleOperator(value: unknown): value is ConditionRuleOperator {
  return typeof value === 'string' && CONDITION_RULE_OPERATOR_SET.has(value)
}

/**
 * Seed the editable condition model from a (preserved) graph. One entry per `condition` node,
 * branches captured 1:1 (edgeKey + conjunction default 'and' + rules). Non-condition nodes are
 * ignored here — they are preserved verbatim by `applyConditionEditsToGraph`.
 */
export function conditionEditsFromGraph(graph: ApprovalGraph | undefined): ConditionEdits {
  const edits: ConditionEdits = {}
  if (!graph) return edits
  for (const node of graph.nodes) {
    if (node.type !== 'condition' || !isConditionConfig(node.config)) continue
    const config = node.config
    edits[node.key] = {
      nodeKey: node.key,
      branches: (config.branches ?? []).map((branch) => ({
        edgeKey: branch.edgeKey,
        conjunction: branch.conjunction === 'or' ? 'or' : 'and',
        rules: (branch.rules ?? []).map((rule) => ({
          fieldId: rule.fieldId,
          operator: rule.operator,
          // Preserve `value` verbatim. A branch may legitimately omit it (isEmpty / no value);
          // capture that as `undefined` so the rebuilt rule omits the key too (byte-identical).
          value: 'value' in rule ? rule.value : undefined,
        })),
      })),
      defaultEdgeKey: config.defaultEdgeKey ?? '',
    }
  }
  return edits
}

/**
 * Build one persisted `ConditionRule` from a rule edit, mirroring the backend
 * `normalizeApprovalGraph` rule shape: `fieldId` trimmed, `operator` verbatim, and `value` emitted
 * only when defined (omitted for `isEmpty` / no-value rules) so an untouched rule is byte-identical.
 */
function buildConditionRule(rule: ConditionRuleEdit): ConditionRule {
  return {
    fieldId: rule.fieldId.trim(),
    operator: rule.operator,
    ...(rule.value !== undefined ? { value: rule.value } : {}),
  }
}

/**
 * Replace the `config` of each condition node in `graph` with the edited config, leaving EVERY
 * other node and ALL edges byte-identical (deep-cloned so the input is never mutated). This is the
 * G-2 save path: topology (branches/edgeKeys/targets, all non-condition nodes, the full edge list)
 * is preserved exactly; only the condition LOGIC (rules / conjunction / defaultEdgeKey) changes.
 *
 * Byte-identity for an UNTOUCHED graph: each rebuilt condition branch carries `conjunction` only
 * when the ORIGINAL branch did (threaded from `originalGraph`), `value` only when present, and
 * `defaultEdgeKey` only when non-empty — matching the backend-normalised shape the graph was loaded
 * with. Branches the edit model doesn't cover (none, by construction) or nodes with no edit entry
 * are passed through verbatim.
 */
export function applyConditionEditsToGraph(
  graph: ApprovalGraph,
  edits: ConditionEdits,
): ApprovalGraph {
  const nodes: ApprovalNode[] = graph.nodes.map((node) => {
    if (node.type !== 'condition') {
      // Non-condition node — preserve byte-for-byte (deep clone so we never alias the input).
      return cloneJson(node)
    }
    const edit = edits[node.key]
    if (!edit || !isConditionConfig(node.config)) {
      // No edit entry (shouldn't happen for a seeded condition node) — preserve verbatim.
      return cloneJson(node)
    }
    const originalConfig = node.config
    const originalBranchByEdge = new Map(
      (originalConfig.branches ?? []).map((branch) => [branch.edgeKey, branch]),
    )
    const branches: ConditionBranch[] = edit.branches.map((branchEdit) => {
      const original = originalBranchByEdge.get(branchEdit.edgeKey)
      // Emit `conjunction` only when the original branch carried one, OR the editor set a value
      // that differs from the original's absent/value — i.e. always emit when the current value is
      // 'or', and emit 'and' only if the original explicitly had a conjunction. This keeps an
      // untouched branch byte-identical (no spurious `conjunction: 'and'`).
      const originalHadConjunction = original?.conjunction !== undefined
      const emitConjunction = originalHadConjunction || branchEdit.conjunction === 'or'
      return {
        edgeKey: branchEdit.edgeKey,
        ...(emitConjunction ? { conjunction: branchEdit.conjunction } : {}),
        rules: branchEdit.rules.map(buildConditionRule),
      }
    })
    const config: ConditionNodeConfig = {
      branches,
      ...(edit.defaultEdgeKey.trim() ? { defaultEdgeKey: edit.defaultEdgeKey.trim() } : {}),
    }
    return {
      ...cloneJson(node),
      config,
    }
  })
  return {
    nodes,
    // Edges are pure topology — preserved byte-for-byte (deep clone, never aliased/reordered).
    edges: graph.edges.map((edge) => cloneJson(edge)),
  }
}

/**
 * FE validation PREVIEW for the condition edits (UX only — the backend `normalizeApprovalGraph`
 * stays the sole arbiter; this never relaxes it). Mirrors the high-value checks:
 *  - every rule `fieldId` must reference an existing form field,
 *  - every rule `operator` must be in the union,
 *  - `defaultEdgeKey` (when set) must be an OUTGOING edge of the condition node.
 *
 * On `defaultEdgeKey`: the runtime (`ApprovalGraphExecutor.resolveConditionTarget`) resolves it via
 * `targetForEdge`, which looks the key up in the GRAPH EDGE LIST — it is the FALL-THROUGH edge taken
 * when no branch matches, and is deliberately a SEPARATE edge from the branch `edgeKey`s (the
 * canonical fixture's default edge is `cond → low`, distinct from the branch's `cond → high`). So
 * the correct invariant is "an existing outgoing edge of this node", NOT "a branch edgeKey". The
 * node's outgoing edges come from the preserved graph (G-2 never changes topology). When `graph` is
 * omitted the edge check is skipped (the field check still runs).
 */
export function validateConditionEdits(
  edits: ConditionEdits,
  formSchema: FormSchema,
  graph?: ApprovalGraph,
): string[] {
  const errors: string[] = []
  const fieldIds = new Set(formSchema.fields.map((field) => field.id))
  // Outgoing edge keys per node key (edges whose `source` is that node) — the legal targets for a
  // branch/default edge of that condition node.
  const outgoingByNode = new Map<string, Set<string>>()
  for (const edge of graph?.edges ?? []) {
    const set = outgoingByNode.get(edge.source) ?? new Set<string>()
    set.add(edge.key)
    outgoingByNode.set(edge.source, set)
  }
  for (const edit of Object.values(edits)) {
    const nodeLabel = edit.nodeKey
    edit.branches.forEach((branch, branchIndex) => {
      branch.rules.forEach((rule, ruleIndex) => {
        const ruleLabel = `条件节点 ${nodeLabel} 分支 ${branchIndex + 1} 规则 ${ruleIndex + 1}`
        const fieldId = rule.fieldId.trim()
        if (!fieldId) {
          errors.push(`${ruleLabel} 需要选择字段`)
        } else if (!fieldIds.has(fieldId)) {
          errors.push(`${ruleLabel} 引用的字段 ${fieldId} 不存在`)
        }
        if (!isConditionRuleOperator(rule.operator)) {
          errors.push(`${ruleLabel} 的运算符无效`)
        }
      })
    })
    const defaultEdgeKey = edit.defaultEdgeKey.trim()
    if (defaultEdgeKey && graph) {
      const outgoing = outgoingByNode.get(edit.nodeKey) ?? new Set<string>()
      if (!outgoing.has(defaultEdgeKey)) {
        errors.push(`条件节点 ${nodeLabel} 的默认分支 ${defaultEdgeKey} 不是该节点的出边`)
      }
    }
  }
  return errors
}
