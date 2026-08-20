import { NODE_FIELD_ACCESS_VALUES, type NodeFieldAccess, type NodeFieldPermission } from '../types/approval-product'

// Lock-7 L7-A — most-restrictive-wins ordering across nodes: hidden ≻ readonly ≻ required ≻ editable.
// Higher rank is more restrictive. Absent from the matrix ≡ `editable` (OD-L7-9, rank 0). Lock-7B
// (OD-L7B-1/§2.3) inserts `required` immediately above `editable` and below `readonly`: `required` is
// `editable` plus an obligation, never more restrictive than `readonly`/`hidden` on the read axis.
// `Record<NodeFieldAccess, number>` is EXHAUSTIVE — a member added to the type without a rank here
// fails the build (the one compiler-guarded census site, C-3).
const NODE_FIELD_ACCESS_RANK: Record<NodeFieldAccess, number> = {
  editable: 0,
  required: 1,
  readonly: 2,
  hidden: 3,
}

/**
 * Structurally-minimal view of a stored runtime graph for redaction purposes.
 * Only the node `key` and `config.fieldPermissions` are read, so this accepts a
 * raw JSONB blob (`Record<string, unknown>`) without forcing a `asRuntimeGraph`
 * re-validation on the read path (and without a circular import on the bridge).
 */
export interface RedactableRuntimeGraph {
  // `type` is read by the bridge DTO to surface `currentNodeType` (Lock-3 §2.2 — tell a 办理 task
  // apart from an approval task on the member surface). Still a raw JSONB view; no re-validation.
  nodes?: Array<{ key?: unknown; type?: unknown; config?: unknown } | null | undefined> | null
}

/**
 * P1-C HIDDEN field redaction (shared, pure).
 *
 * Enforces node-level `fieldPermissions` with `access === 'hidden'` by stripping
 * the hidden fields from the `formSnapshot` echoed in read DTOs. Redaction is
 * keyed on the INSTANCE's currently-active node(s) — NOT the viewer's assignment
 * set — so a viewer with no active assignment (observer / admin / requester-only)
 * is ALSO redacted. There is no per-viewer logic: every reader sees the same
 * redacted snapshot while the instance is AT a hiding node.
 *
 * This module is imported by both the detail/list read path (ApprovalBridgeService)
 * and may be reused by any other read surface, so the two seams cannot drift
 * (wire-vs-fixture discipline).
 *
 * Safety / no-throw contract:
 * - null/empty `formSnapshot` → returned as-is (no clone, no throw).
 * - null `runtimeGraph` (bridged/external instance with no node config) → snapshot
 *   returned unchanged.
 * - empty/absent `activeNodeKeys` → snapshot returned unchanged.
 * - a node without `fieldPermissions`, or with only `editable`/`readonly`
 *   entries, hides nothing → snapshot returned unchanged.
 * - in a parallel region the instance is active at multiple nodes; the UNION of
 *   every active node's hidden fields is removed.
 *
 * The snapshot is shallow-cloned only when at least one field is actually
 * removed, so the default/no-hidden path stays allocation-free and byte-stable.
 */
/**
 * The set of field ids the active node(s) mark `access: 'hidden'` — the single, shared derivation
 * of "which fields are hidden at this instance's active node(s)". Both the snapshot redaction below
 * AND the attachment download byte-gate (§4.2 gate 2 / G7) consume THIS function, so the echoed
 * snapshot and the byte path can never drift on what "hidden" means (no separate hidden decision).
 * Pure, allocation-cheap (empty Set on any degenerate input), never throws.
 */
/**
 * Lock-7 L7-A / OD-L7-5 — the SINGLE derivation of "this actor's / this instance's access to a
 * field", over the given node set. Returns a `Map<fieldId, NodeFieldAccess>` holding, per field, the
 * MOST-RESTRICTIVE access across every supplied node (`hidden` ≻ `readonly` ≻ `required` ≻
 * `editable`, Lock-7B §2.3 — see the rank table above). A field
 * ABSENT from the returned map ≡ `editable` (OD-L7-9, legacy default). Pure, allocation-cheap on
 * degenerate input, never throws.
 *
 * Three consumers, each supplying its own node set (L7-A table): the snapshot echo and attachment
 * byte gate pass the INSTANCE-active node set (precedence preserved, read behaviour byte-identical);
 * the NEW write mask passes exactly `[nodeKey]` — the actor's single claimed seat — where precedence
 * is unobservable (one element) and only the absent-key default and the per-field access matter.
 * Re-expressing `collectHiddenFieldIds` over THIS function is what keeps the three consumers from
 * drifting on what "hidden" means (L7-A; G-1a asserts a single-node mutation reds all three).
 */
export function resolveFieldAccessAtNodes(
  runtimeGraph: RedactableRuntimeGraph | null,
  nodeKeys: ReadonlyArray<string | null | undefined>,
): Map<string, NodeFieldAccess> {
  const access = new Map<string, NodeFieldAccess>()
  if (!runtimeGraph || !Array.isArray(runtimeGraph.nodes) || runtimeGraph.nodes.length === 0) {
    return access
  }
  const targetKeys = new Set(
    nodeKeys.filter((key): key is string => typeof key === 'string' && key.length > 0),
  )
  if (targetKeys.size === 0) return access

  for (const node of runtimeGraph.nodes) {
    if (!node || typeof node.key !== 'string' || !targetKeys.has(node.key)) continue
    const permissions = (node.config as { fieldPermissions?: NodeFieldPermission[] } | undefined)?.fieldPermissions
    if (!Array.isArray(permissions)) continue
    for (const permission of permissions) {
      if (!permission || typeof permission.fieldId !== 'string') continue
      const candidate = permission.access
      // Lock-7B OD-L7B-10 / G-2 anti-gate — MECHANICAL enumeration over the canonical Set, never an
      // appended `|| candidate === 'required'` literal arm (which would pass every test written for
      // THIS member and reproduce the identical silent-drop defect for the NEXT one). This is C-4, the
      // one census site that fails OPEN and SILENTLY when it drifts (§2.3/§2.3a): an unrecognized
      // candidate is simply skipped, and the field falls back to absent ≡ `editable` (OD-L7-9) with no
      // error anywhere — and since Lock-7B keys the whole required-at-node enforcement path on this
      // resolver's output (OD-L7B-11), a drift here silently discharges every 必填 obligation (G-3).
      if (!NODE_FIELD_ACCESS_VALUES.has(candidate)) continue
      const existing = access.get(permission.fieldId)
      // Most-restrictive-wins: keep the higher rank. First-seen wins ties (identical rank).
      if (existing === undefined || NODE_FIELD_ACCESS_RANK[candidate] > NODE_FIELD_ACCESS_RANK[existing]) {
        access.set(permission.fieldId, candidate)
      }
    }
  }
  return access
}

/**
 * Lock-7 L7-A — resolve one field's effective access at the given node set, defaulting ABSENT ≡
 * `editable` (OD-L7-9). This is the write consumer's single read point (`[nodeKey]`) so the write
 * mask and the read-DTO access map (OD-L7-10) never disagree — both go through this function.
 */
export function fieldAccessAtNodes(
  runtimeGraph: RedactableRuntimeGraph | null,
  nodeKeys: ReadonlyArray<string | null | undefined>,
  fieldId: string,
): NodeFieldAccess {
  return resolveFieldAccessAtNodes(runtimeGraph, nodeKeys).get(fieldId) ?? 'editable'
}

/**
 * The set of field ids the active node(s) mark `access: 'hidden'` — now DERIVED over
 * `resolveFieldAccessAtNodes` (L7-A R-5) rather than a second traversal, so the hidden axis stays
 * byte-identical to the shipped union while the snapshot echo, the attachment byte gate and the
 * write mask all read one matrix. Byte-identical because most-restrictive-wins reduces to "hidden at
 * ANY active node ⇒ hidden", which is exactly the prior union.
 */
export function collectHiddenFieldIds(
  runtimeGraph: RedactableRuntimeGraph | null,
  activeNodeKeys: ReadonlyArray<string | null | undefined>,
): Set<string> {
  const hiddenFieldIds = new Set<string>()
  for (const [fieldId, access] of resolveFieldAccessAtNodes(runtimeGraph, activeNodeKeys)) {
    if (access === 'hidden') hiddenFieldIds.add(fieldId)
  }
  return hiddenFieldIds
}

export function redactHiddenFormFields(
  formSnapshot: Record<string, unknown> | null,
  runtimeGraph: RedactableRuntimeGraph | null,
  activeNodeKeys: ReadonlyArray<string | null | undefined>,
): Record<string, unknown> | null {
  if (!formSnapshot || !runtimeGraph) return formSnapshot

  const hiddenFieldIds = collectHiddenFieldIds(runtimeGraph, activeNodeKeys)
  if (hiddenFieldIds.size === 0) return formSnapshot

  // Only clone when at least one hidden field is actually present in the snapshot.
  let redacted: Record<string, unknown> | null = null
  for (const fieldId of hiddenFieldIds) {
    if (Object.prototype.hasOwnProperty.call(formSnapshot, fieldId)) {
      if (!redacted) redacted = { ...formSnapshot }
      delete redacted[fieldId]
    }
  }

  return redacted ?? formSnapshot
}

/**
 * Derives the instance's currently-active node key(s) from the stored
 * `current_node_key` plus, when the instance is inside a parallel region, the
 * per-branch active node keys recorded in instance metadata.
 *
 * The metadata shape is the same one `readParallelBranchStates` validates; this
 * helper is intentionally tolerant (best-effort) so a malformed metadata blob
 * degrades to "use current_node_key only" rather than throwing on a read path.
 */
export function collectActiveNodeKeys(
  currentNodeKey: string | null,
  metadata: Record<string, unknown> | null | undefined,
): string[] {
  const keys = new Set<string>()
  if (typeof currentNodeKey === 'string' && currentNodeKey.length > 0) {
    keys.add(currentNodeKey)
  }

  const states = metadata && typeof metadata === 'object'
    ? (metadata as { parallelBranchStates?: unknown }).parallelBranchStates
    : undefined
  if (states && typeof states === 'object') {
    const branches = (states as { branches?: unknown }).branches
    if (branches && typeof branches === 'object') {
      for (const entry of Object.values(branches as Record<string, unknown>)) {
        if (!entry || typeof entry !== 'object') continue
        const branch = entry as { currentNodeKey?: unknown; complete?: unknown }
        if (branch.complete === true) continue
        if (typeof branch.currentNodeKey === 'string' && branch.currentNodeKey.length > 0) {
          keys.add(branch.currentNodeKey)
        }
      }
    }
  }

  return [...keys]
}
