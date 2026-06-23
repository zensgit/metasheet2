import type {
  ApprovalAssigneeType,
  ApprovalGraph,
  ApprovalNode,
  CcNodeConfig,
} from '../types/approval'

// G-4 — cc node editing (TARGETS ONLY; no .vue / Element Plus import so this runs under the
// approval-web-guard vitest gate). Scope: each cc node's `targetType` ('user'|'role') and
// `targetIds` (string[]). The cc node's edges/position are TOPOLOGY — preserved byte-for-byte
// (G-1 anti-flatten floor). Every OTHER node/edge — condition (G-2) and parallel (G-3) included —
// is preserved verbatim. condition stays editable via `conditionEdit.ts`, parallel via `parallelEdit.ts`.
//
// PRE-CHECK FINDING (the backend-accepted cc shape): `normalizeApprovalGraph`'s cc validation
// (`ApprovalProductService.ts:914-922`) requires `config.targetType` ∈ {'user','role'} and
// `config.targetIds` an array of NON-EMPTY strings, and writes them back trimmed. The editor +
// preview match exactly (backend stays the sole arbiter).

/** The cc target types the backend `normalizeApprovalGraph` accepts (the editor's select offers these). */
export const CC_TARGET_TYPES: readonly ApprovalAssigneeType[] = ['user', 'role'] as const
const CC_TARGET_TYPE_SET = new Set<string>(CC_TARGET_TYPES)

/**
 * Editable model for one cc node — `targetType` + `targetIds`. Keyed by node `key`, seeded 1:1
 * from the preserved cc nodes' existing config. The cc node's place in the graph (edges) is
 * topology and is NOT carried here (preserved verbatim by `applyCcEditsToGraph`).
 */
export interface CcNodeEdit {
  nodeKey: string
  targetType: ApprovalAssigneeType
  targetIds: string[]
}

/** Map of cc edits keyed by node key, seeded from a preserved graph and edited in place. */
export type CcEdits = Record<string, CcNodeEdit>

// Deep clone for the preserved-graph pass-through — same rationale as parallelEdit/conditionEdit:
// pure JSON data, and a JSON round-trip works on the Vue reactive Proxy the draft is wrapped in.
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isCcConfig(config: ApprovalNode['config']): config is CcNodeConfig {
  return Boolean(config) && Array.isArray((config as CcNodeConfig).targetIds)
}

/** True when a target type is one the editor offers (and the backend accepts). */
export function isCcTargetType(value: unknown): value is ApprovalAssigneeType {
  return typeof value === 'string' && CC_TARGET_TYPE_SET.has(value)
}

/**
 * Seed the editable cc model from a (preserved) graph — one entry per `cc` node, carrying its
 * existing `targetType` + `targetIds`. Non-cc nodes are ignored (preserved verbatim by
 * `applyCcEditsToGraph`). Seeding is identity: an untouched edit reproduces the original config,
 * so a round-trip is byte-identical (no spurious diff).
 */
export function ccEditsFromGraph(graph: ApprovalGraph | undefined): CcEdits {
  const edits: CcEdits = {}
  if (!graph) return edits
  for (const node of graph.nodes) {
    if (node.type !== 'cc' || !isCcConfig(node.config)) continue
    edits[node.key] = {
      nodeKey: node.key,
      targetType: isCcTargetType(node.config.targetType) ? node.config.targetType : 'user',
      targetIds: [...node.config.targetIds],
    }
  }
  return edits
}

/**
 * Replace the config (`targetType` + `targetIds`) of each cc node in `graph` with the edited value,
 * leaving EVERY other node and ALL edges byte-identical (deep-cloned so the input is never mutated).
 * `targetIds` are trimmed + empties dropped to match the backend's write shape. Spread-original-first
 * keeps key order byte-stable, so an UNTOUCHED cc node reproduces its config exactly.
 *
 * Composition with G-2/G-3: cc / condition / parallel are DISJOINT node types and each pass
 * deep-clones everything else, so composing the three lands all edits while every non-targeted
 * node/edge stays byte-identical.
 */
export function applyCcEditsToGraph(graph: ApprovalGraph, edits: CcEdits): ApprovalGraph {
  const nodes: ApprovalNode[] = graph.nodes.map((node) => {
    if (node.type !== 'cc') return cloneJson(node)
    const edit = edits[node.key]
    if (!edit || !isCcConfig(node.config)) return cloneJson(node)
    const originalConfig = cloneJson(node.config)
    const config: CcNodeConfig = {
      ...originalConfig,
      targetType: edit.targetType,
      targetIds: edit.targetIds.map((entry) => entry.trim()).filter((entry) => entry.length > 0),
    }
    return { ...cloneJson(node), config }
  })
  return {
    nodes,
    edges: graph.edges.map((edge) => cloneJson(edge)),
  }
}

/**
 * FE validation PREVIEW for the cc edits (UX only — the backend `normalizeApprovalGraph` stays the
 * sole arbiter). Mirrors the backend cc rule: `targetType` ∈ {'user','role'} and at least one
 * non-empty `targetId`.
 */
export function validateCcEdits(edits: CcEdits): string[] {
  const errors: string[] = []
  for (const edit of Object.values(edits)) {
    if (!isCcTargetType(edit.targetType)) {
      errors.push(`抄送节点 ${edit.nodeKey} 的抄送对象类型无效`)
    }
    if (edit.targetIds.map((entry) => entry.trim()).filter((entry) => entry.length > 0).length === 0) {
      errors.push(`抄送节点 ${edit.nodeKey} 至少需要一个抄送对象`)
    }
  }
  return errors
}
