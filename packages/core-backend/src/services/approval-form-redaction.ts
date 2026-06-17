import type { NodeFieldPermission } from '../types/approval-product'

/**
 * Structurally-minimal view of a stored runtime graph for redaction purposes.
 * Only the node `key` and `config.fieldPermissions` are read, so this accepts a
 * raw JSONB blob (`Record<string, unknown>`) without forcing a `asRuntimeGraph`
 * re-validation on the read path (and without a circular import on the bridge).
 */
export interface RedactableRuntimeGraph {
  nodes?: Array<{ key?: unknown; config?: unknown } | null | undefined> | null
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
export function redactHiddenFormFields(
  formSnapshot: Record<string, unknown> | null,
  runtimeGraph: RedactableRuntimeGraph | null,
  activeNodeKeys: ReadonlyArray<string | null | undefined>,
): Record<string, unknown> | null {
  if (!formSnapshot || !runtimeGraph) return formSnapshot
  if (!Array.isArray(runtimeGraph.nodes) || runtimeGraph.nodes.length === 0) return formSnapshot

  const activeKeys = new Set(
    activeNodeKeys.filter((key): key is string => typeof key === 'string' && key.length > 0),
  )
  if (activeKeys.size === 0) return formSnapshot

  const hiddenFieldIds = new Set<string>()
  for (const node of runtimeGraph.nodes) {
    if (!node || typeof node.key !== 'string' || !activeKeys.has(node.key)) continue
    const permissions = (node.config as { fieldPermissions?: NodeFieldPermission[] } | undefined)?.fieldPermissions
    if (!Array.isArray(permissions)) continue
    for (const permission of permissions) {
      if (permission && permission.access === 'hidden' && typeof permission.fieldId === 'string') {
        hiddenFieldIds.add(permission.fieldId)
      }
    }
  }

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
