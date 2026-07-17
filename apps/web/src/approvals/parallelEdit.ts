import type {
  ApprovalAssigneeSource,
  ApprovalGraph,
  ApprovalNode,
  ParallelJoinMode,
  ParallelNodeConfig,
} from '../types/approval'

// G-3 — parallel node editing (JOIN-MODE ONLY; no .vue / Element Plus import so this runs under the
// approval-web-guard vitest gate). The scope is a single field: each parallel node's `joinMode`.
// `branches` (the fork edgeKeys) and `joinNodeKey` are TOPOLOGY — preserved byte-for-byte (G-1
// anti-flatten floor), NOT editable here. Every OTHER node/edge — including condition (G-2) and cc
// — is preserved verbatim. condition stays editable via `conditionEdit.ts`; cc stays read-only (G-4).
//
// PRE-CHECK FINDING (backend accepts BOTH modes): `normalizeApprovalGraph`'s parallel validation
// (`ApprovalProductService.ts:940`) checks `PARALLEL_JOIN_MODES.has(joinMode)` where
// `PARALLEL_JOIN_MODES = new Set(['all', 'any'])` (`:289`) and writes `joinMode` VERBATIM (`:948`,
// no coercion to 'all'). The runtime `ApprovalGraphExecutor` handles 'any' = first-wins
// (`:3691`, plus `loadParallelState` accepts 'any' at `:1523`). So 'all' AND 'any' are both
// accepted — the editor offers both. (This empirically SUPERSEDES design-lock §7/§8c's "'all' only,
// validator/type say 'all'" deferral, whose premise is factually false: the set is {'all','any'}
// and the FE/BE type union is 'all'|'any'. See the PR body / TODO for the ratification flag.)

/** The join modes the backend `normalizeApprovalGraph` accepts (the editor's select offers these). */
export const PARALLEL_JOIN_MODES: readonly ParallelJoinMode[] = ['all', 'any'] as const
const PARALLEL_JOIN_MODE_SET = new Set<string>(PARALLEL_JOIN_MODES)

/**
 * Editable model for one parallel node — `joinMode` ONLY. `branches`/`joinNodeKey` are topology and
 * are NOT carried here (they are preserved verbatim by `applyParallelEditsToGraph`). Keyed by node
 * `key`, seeded 1:1 from the preserved parallel nodes' existing `joinMode`.
 */
export interface ParallelNodeEdit {
  nodeKey: string
  joinMode: ParallelJoinMode
}

/** Map of parallel edits keyed by node key, seeded from a preserved graph and edited in place. */
export type ParallelEdits = Record<string, ParallelNodeEdit>

// Deep clone for the preserved-graph pass-through. Same rationale as `conditionEdit.cloneJson`: the
// graph is pure JSON-serialisable data, and a JSON round-trip (unlike `structuredClone`) works on
// the Vue reactive Proxy the authoring view wraps the draft in. A backend-normalised graph carries
// no `undefined`-valued keys, so JSON dropping them is identity for the nodes/edges we pass through.
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isParallelConfig(config: ApprovalNode['config']): config is ParallelNodeConfig {
  return Boolean(config) && Array.isArray((config as ParallelNodeConfig).branches)
}

/** True when a join mode is one the editor's select offers (and the backend accepts). */
export function isParallelJoinMode(value: unknown): value is ParallelJoinMode {
  return typeof value === 'string' && PARALLEL_JOIN_MODE_SET.has(value)
}

/**
 * Seed the editable parallel model from a (preserved) graph. One entry per `parallel` node, carrying
 * its existing `joinMode` (defaulted to 'all' only if a malformed graph lacks one — a normalised
 * graph always has 'all' or 'any'). Non-parallel nodes are ignored here — they are preserved verbatim
 * by `applyParallelEditsToGraph`. Seeding is identity: an untouched edit reproduces the original
 * `joinMode`, so a round-trip is byte-identical (no spurious diff).
 */
export function parallelEditsFromGraph(graph: ApprovalGraph | undefined): ParallelEdits {
  const edits: ParallelEdits = {}
  if (!graph) return edits
  for (const node of graph.nodes) {
    if (node.type !== 'parallel' || !isParallelConfig(node.config)) continue
    edits[node.key] = {
      nodeKey: node.key,
      joinMode: isParallelJoinMode(node.config.joinMode) ? node.config.joinMode : 'all',
    }
  }
  return edits
}

/**
 * Replace the `joinMode` of each parallel node in `graph` with the edited value, leaving EVERY other
 * node and ALL edges byte-identical (deep-cloned so the input is never mutated). This is the G-3 save
 * path: topology (each parallel node's `branches`/`joinNodeKey`, every non-parallel node, the full
 * edge list) is preserved exactly; only `joinMode` changes.
 *
 * Byte-identity for an UNTOUCHED graph: spread-and-overwrite — `{ ...originalConfig, joinMode }` —
 * keeps `joinMode`'s existing position (so key order stays `branches, joinMode, joinNodeKey`,
 * matching the backend `normalizeApprovalGraph` shape the graph loaded with) and, when the edit's
 * `joinMode` equals the original's, reproduces the config exactly. Nodes with no edit entry (none,
 * by construction, for a seeded parallel node) are passed through verbatim.
 *
 * Composition with G-2: `applyParallelEditsToGraph` and `applyConditionEditsToGraph` touch DISJOINT
 * node types (parallel vs condition) and each deep-clones everything else, so composing them
 * (`applyParallelEditsToGraph(applyConditionEditsToGraph(g, ...), ...)`) lands both edits while every
 * non-targeted node/edge — cc included — stays byte-identical.
 */
export function applyParallelEditsToGraph(
  graph: ApprovalGraph,
  edits: ParallelEdits,
): ApprovalGraph {
  const nodes: ApprovalNode[] = graph.nodes.map((node) => {
    if (node.type !== 'parallel') {
      // Non-parallel node (incl. condition / cc) — preserve byte-for-byte (deep clone, never alias).
      return cloneJson(node)
    }
    const edit = edits[node.key]
    if (!edit || !isParallelConfig(node.config)) {
      // No edit entry (shouldn't happen for a seeded parallel node) — preserve verbatim.
      return cloneJson(node)
    }
    const originalConfig = cloneJson(node.config)
    const config: ParallelNodeConfig = {
      // Spread the preserved topology first (branches + joinNodeKey, in their original positions),
      // then overwrite ONLY joinMode (overwriting an existing key keeps its slot → byte-stable order).
      ...originalConfig,
      joinMode: edit.joinMode,
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
 * FE validation PREVIEW for the parallel edits (UX only — the backend `normalizeApprovalGraph` stays
 * the sole arbiter; this never relaxes it). The only editable field is `joinMode`, so the only check
 * is that it is in the backend-accepted set ('all' | 'any'). An out-of-set value (only reachable via
 * a corrupt/hand-built edit, never the UI select) is flagged so the FE never offers to save a
 * backend-rejected graph.
 */
export function validateParallelEdits(edits: ParallelEdits): string[] {
  const errors: string[] = []
  for (const edit of Object.values(edits)) {
    if (!isParallelJoinMode(edit.joinMode)) {
      errors.push(`并行节点 ${edit.nodeKey} 的汇聚模式无效`)
    }
  }
  return errors
}

/**
 * Fingerprint of a DYNAMIC assignee source: same fingerprint ⇒ the source PROVABLY resolves to the
 * same user(s) for every request (same kind + same parameters). Static sources return null — the
 * backend already rejects duplicate static assignees across parallel branches at save time.
 * MUST stay in lockstep with the backend `dynamicAssigneeSourceFingerprint`
 * (ApprovalProductService.ts) so authoring flags exactly what publish rejects.
 */
function dynamicAssigneeSourceFingerprint(source: ApprovalAssigneeSource): string | null {
  switch (source.kind) {
    case 'requester':
    case 'direct_manager':
    case 'dept_head':
      return source.kind
    case 'continuous_managers':
      return `continuous_managers:${source.levels}`
    case 'manager_at_level':
      return `manager_at_level:${source.level}`
    case 'form_field_user':
      return `form_field_user:${source.fieldId.trim()}`
    default:
      return null
  }
}

/**
 * Publish-preflight PREVIEW (surfaced in the publish checklist, NOT the save gate): flag a parallel
 * gateway whose branches carry PROVABLY-IDENTICAL dynamic assignee sources. At runtime the fan-out
 * raises a typed 409 (`APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT`) whenever two branches resolve
 * to the same user — for identical dynamic sources (requester×requester, direct_manager×direct_manager,
 * same-parameter manager levels / form fields) that is EVERY request, so the template is unpublishable
 * in practice. The backend publish gate (`assertNoParallelDynamicAssigneeConflicts`) rejects the same
 * shape with the same code; this mirror surfaces it BEFORE the rejected request. Only
 * provably-identical sources are flagged — DIFFERENT kinds or DIFFERENT parameters may still collide
 * for some org shapes and stay the runtime guard's job. Walk mirrors the backend's conservative
 * first-outgoing-edge walk per branch, deduped within a branch (sequential same-source nodes in ONE
 * branch are not a parallel conflict).
 */
export function parallelDynamicAssigneeConflicts(graph: ApprovalGraph): string[] {
  const errors: string[] = []
  const edgeByKey = new Map(graph.edges.map((edge) => [edge.key, edge]))
  const firstOutgoing = new Map<string, string>()
  for (const edge of graph.edges) {
    if (!firstOutgoing.has(edge.source)) firstOutgoing.set(edge.source, edge.target)
  }
  const nodeByKey = new Map(graph.nodes.map((node) => [node.key, node]))
  for (const node of graph.nodes) {
    if (node.type !== 'parallel' || !isParallelConfig(node.config)) continue
    const config = node.config
    const seenAcrossBranches = new Set<string>()
    for (const branchEdgeKey of config.branches) {
      const branchFingerprints = new Set<string>()
      let currentKey: string | undefined = edgeByKey.get(branchEdgeKey)?.target
      const visited = new Set<string>()
      while (currentKey && currentKey !== config.joinNodeKey && !visited.has(currentKey)) {
        visited.add(currentKey)
        const current = nodeByKey.get(currentKey)
        if (!current) break
        if (current.type === 'approval') {
          const sources = (current.config as { assigneeSources?: ApprovalAssigneeSource[] }).assigneeSources ?? []
          for (const source of sources) {
            const fingerprint = dynamicAssigneeSourceFingerprint(source)
            if (fingerprint) branchFingerprints.add(fingerprint)
          }
        }
        currentKey = firstOutgoing.get(currentKey)
      }
      for (const fingerprint of branchFingerprints) {
        if (seenAcrossBranches.has(fingerprint)) {
          errors.push(`并行节点 ${node.key} 的多个分支使用了相同的动态审批人来源（${fingerprint}），发起审批时会因重复审批人失败，请为各分支配置不同的审批人`)
        } else {
          seenAcrossBranches.add(fingerprint)
        }
      }
    }
  }
  return errors
}
