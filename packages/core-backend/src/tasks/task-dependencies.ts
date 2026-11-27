/**
 * Task feature — task dependencies (predecessor → successor): add/remove decisions, the acyclicity
 * check, two-end authorization and the candidate list. PURE, no I/O; every timestamp comes from an
 * explicit `now`.
 *
 * Design: docs/development/task-e-m5-pure-functions-design-20261007.md §2.2
 * Lock:   task-feature-design-lock-20260917.md §3 (P2 scope), §4.2 (`task_dependencies`, event words
 *         `dependency_added` / `dependency_removed`), §6.4 (dependency changes are structure changes)
 *
 * The cycle check is a plain reachability walk that SKIPS nodes it has already visited. It is not
 * built on `task-tree.ts`'s `descendantsOf`: that function treats a revisit as corruption and throws,
 * but a dependency graph legitimately revisits nodes (a diamond A→B, A→C, B→D, C→D is valid).
 */
import { can, type TaskRole } from './task-access'
import { isValidTaskDomainId } from './task-ids'

// RULED(2026-10-09): [S28] at most 50 dependency edges per task, counting predecessors and
// successors together; checked for BOTH endpoints after the new edge is counted. Soft limit (a
// constant, no DB CHECK).
// ASSUMPTION(task-e): [D18] a refused edge is rejected with reason `limit`.
export const TASK_DEPENDENCY_MAX_EDGES_PER_TASK = 50

// RULED(2026-10-09): [S12] exactly one relation kind (predecessor → successor): no type, no lag.
// Dependencies never block completion — this module exports nothing that reads or writes
// completion state. Acyclicity is a hard rule.
export interface TaskDependencyEdge {
  predecessorId: string
  successorId: string
}

export type TaskDependencyRejectReason = 'cross_org' | 'self' | 'duplicate' | 'limit' | 'cycle'

export type ValidateAddDependencyResult = { ok: true } | { ok: false; reason: TaskDependencyRejectReason }

// ASSUMPTION(task-e): [D4][D17] `edges` is every LIVE edge of the org — both endpoints undeleted —
// read under the org structure lock. Edges of a soft-deleted task stay in the table but are filtered
// out before they reach this module; soft delete itself emits no `dependency_removed`.
export interface ValidateAddDependencyInput {
  predecessorId: string
  successorId: string
  /** Org of the predecessor task (from the task row, never from the request). */
  predecessorOrgId: string
  /** Org of the successor task. */
  successorOrgId: string
  edges: readonly TaskDependencyEdge[]
}

function requireTaskId(value: unknown, name: string, fn: string): string {
  if (!isValidTaskDomainId(value)) {
    throw new TypeError(`${fn}: ${name} must be a valid task id`)
  }
  return value as string
}

function requireEdges(edges: unknown, fn: string): readonly TaskDependencyEdge[] {
  if (!Array.isArray(edges)) {
    throw new TypeError(`${fn}: edges must be an array`)
  }
  for (const edge of edges) {
    if (typeof edge !== 'object' || edge === null) {
      throw new TypeError(`${fn}: every edge must be an object`)
    }
    requireTaskId((edge as TaskDependencyEdge).predecessorId, 'edge.predecessorId', fn)
    requireTaskId((edge as TaskDependencyEdge).successorId, 'edge.successorId', fn)
  }
  return edges as readonly TaskDependencyEdge[]
}

function requireRoles(roles: unknown, name: string, fn: string): TaskRole[] {
  if (!Array.isArray(roles)) {
    throw new TypeError(`${fn}: ${name} must be an array of task roles`)
  }
  return roles as TaskRole[]
}

function requireNow(now: unknown, fn: string): Date {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError(`${fn}: now must be a valid Date`)
  }
  return now
}

function requireActor(actorId: unknown, fn: string): string {
  if (typeof actorId !== 'string' || actorId.length === 0) {
    throw new TypeError(`${fn}: actorId must be a non-empty string`)
  }
  return actorId
}

/** Forward adjacency: predecessor → its successors. */
function forwardIndex(edges: readonly TaskDependencyEdge[]): Map<string, string[]> {
  const next = new Map<string, string[]>()
  for (const edge of edges) {
    const list = next.get(edge.predecessorId)
    if (list) list.push(edge.successorId)
    else next.set(edge.predecessorId, [edge.successorId])
  }
  return next
}

/** Reverse adjacency: successor → its predecessors. */
function reverseIndex(edges: readonly TaskDependencyEdge[]): Map<string, string[]> {
  const prev = new Map<string, string[]>()
  for (const edge of edges) {
    const list = prev.get(edge.successorId)
    if (list) list.push(edge.predecessorId)
    else prev.set(edge.successorId, [edge.predecessorId])
  }
  return prev
}

/** Every node reachable from `start` along `adjacency` (not including `start` unless on a cycle). */
function reachableFrom(start: string, adjacency: Map<string, string[]>): Set<string> {
  const reached = new Set<string>()
  const queue: string[] = [start]
  for (let i = 0; i < queue.length; i += 1) {
    for (const neighbour of adjacency.get(queue[i]) ?? []) {
      if (reached.has(neighbour)) continue
      reached.add(neighbour)
      queue.push(neighbour)
    }
  }
  return reached
}

/**
 * Adding `predecessorId → successorId` closes a cycle iff `predecessorId` is already reachable from
 * `successorId` along existing edges (or the two are the same task). Revisits are skipped, never
 * treated as corruption, so diamonds are accepted.
 */
export function wouldCreateDependencyCycle(
  edges: readonly TaskDependencyEdge[],
  predecessorId: string,
  successorId: string,
): boolean {
  const fn = 'wouldCreateDependencyCycle'
  const all = requireEdges(edges, fn)
  const pred = requireTaskId(predecessorId, 'predecessorId', fn)
  const succ = requireTaskId(successorId, 'successorId', fn)
  if (pred === succ) return true
  return reachableFrom(succ, forwardIndex(all)).has(pred)
}

function degreeOf(taskId: string, edges: readonly TaskDependencyEdge[]): number {
  let count = 0
  for (const edge of edges) {
    if (edge.predecessorId === taskId || edge.successorId === taskId) count += 1
  }
  return count
}

/**
 * Check order is fixed: `cross_org` → `self` → `duplicate` → `limit` → `cycle`. `cross_org` comes
 * first because the route answers it with the same uniform 404 as a missing or unauthorized end, so
 * no later check runs for a pair that spans two orgs.
 */
export function validateAddDependency(input: ValidateAddDependencyInput): ValidateAddDependencyResult {
  const fn = 'validateAddDependency'
  if (typeof input !== 'object' || input === null) {
    throw new TypeError(`${fn}: input must be an object`)
  }
  const pred = requireTaskId(input.predecessorId, 'predecessorId', fn)
  const succ = requireTaskId(input.successorId, 'successorId', fn)
  const edges = requireEdges(input.edges, fn)
  const predOrg = input.predecessorOrgId
  const succOrg = input.successorOrgId
  if (typeof predOrg !== 'string' || typeof succOrg !== 'string') {
    throw new TypeError(`${fn}: predecessorOrgId and successorOrgId must be strings`)
  }
  // RULED(2026-10-09): [S11] both ends must be in the same org; a blank org on either side counts
  // as a mismatch.
  if (predOrg.length === 0 || succOrg.length === 0 || predOrg !== succOrg) {
    return { ok: false, reason: 'cross_org' }
  }
  if (pred === succ) {
    return { ok: false, reason: 'self' }
  }
  if (edges.some((edge) => edge.predecessorId === pred && edge.successorId === succ)) {
    return { ok: false, reason: 'duplicate' }
  }
  if (
    degreeOf(pred, edges) + 1 > TASK_DEPENDENCY_MAX_EDGES_PER_TASK ||
    degreeOf(succ, edges) + 1 > TASK_DEPENDENCY_MAX_EDGES_PER_TASK
  ) {
    return { ok: false, reason: 'limit' }
  }
  if (reachableFrom(succ, forwardIndex(edges)).has(pred)) {
    return { ok: false, reason: 'cycle' }
  }
  return { ok: true }
}

export type TaskDependencyEventType = 'dependency_added' | 'dependency_removed'

/** One `task_events` row. `payload` names the OTHER end of the edge. */
export interface TaskDependencyEvent {
  taskId: string
  type: TaskDependencyEventType
  userId: string
  occurredAt: Date
  payload: { predecessorId: string } | { successorId: string }
}

// RULED(2026-10-09): [S11] a dependency change is recorded on BOTH tasks: the successor's event
// carries `{ predecessorId }`, the predecessor's carries `{ successorId }`. Successor first.
function edgeEvents(
  type: TaskDependencyEventType,
  pred: string,
  succ: string,
  actorId: string,
  now: Date,
): TaskDependencyEvent[] {
  return [
    { taskId: succ, type, userId: actorId, occurredAt: now, payload: { predecessorId: pred } },
    { taskId: pred, type, userId: actorId, occurredAt: now, payload: { successorId: succ } },
  ]
}

export type ApplyAddDependencyResult =
  | { ok: false; reason: TaskDependencyRejectReason }
  | { ok: true; edge: TaskDependencyEdge; events: TaskDependencyEvent[] }

/** `validateAddDependency`, then the new edge and its two `dependency_added` events. */
export function applyAddDependency(
  input: ValidateAddDependencyInput & { actorId: string; now: Date },
): ApplyAddDependencyResult {
  const fn = 'applyAddDependency'
  if (typeof input !== 'object' || input === null) {
    throw new TypeError(`${fn}: input must be an object`)
  }
  const actorId = requireActor(input.actorId, fn)
  const now = requireNow(input.now, fn)
  const verdict = validateAddDependency(input)
  if (verdict.ok === false) {
    return { ok: false, reason: (verdict as { ok: false; reason: TaskDependencyRejectReason }).reason }
  }
  const edge = { predecessorId: input.predecessorId, successorId: input.successorId }
  return { ok: true, edge, events: edgeEvents('dependency_added', edge.predecessorId, edge.successorId, actorId, now) }
}

export interface ApplyRemoveDependencyResult {
  noop: boolean
  events: TaskDependencyEvent[]
}

/** Removing an edge that is not there is a no-op with no events. */
export function applyRemoveDependency(input: {
  predecessorId: string
  successorId: string
  edges: readonly TaskDependencyEdge[]
  actorId: string
  now: Date
}): ApplyRemoveDependencyResult {
  const fn = 'applyRemoveDependency'
  if (typeof input !== 'object' || input === null) {
    throw new TypeError(`${fn}: input must be an object`)
  }
  const pred = requireTaskId(input.predecessorId, 'predecessorId', fn)
  const succ = requireTaskId(input.successorId, 'successorId', fn)
  const edges = requireEdges(input.edges, fn)
  const actorId = requireActor(input.actorId, fn)
  const now = requireNow(input.now, fn)
  const exists = edges.some((edge) => edge.predecessorId === pred && edge.successorId === succ)
  if (!exists) return { noop: true, events: [] }
  return { noop: false, events: edgeEvents('dependency_removed', pred, succ, actorId, now) }
}

// RULED(2026-10-09): [S11] adding or removing an edge needs `edit` on BOTH tasks and both tasks in
// the same org (the same shape as setting a parent, `task-tree.ts`'s `canReparent`). The route turns
// a `false` into a uniform 404. Edges may span lists: no list check here.
export function canManageDependency(input: {
  predecessorRoles: TaskRole[]
  successorRoles: TaskRole[]
  sameOrg: boolean
}): boolean {
  const fn = 'canManageDependency'
  if (typeof input !== 'object' || input === null) {
    throw new TypeError(`${fn}: input must be an object`)
  }
  const predRoles = requireRoles(input.predecessorRoles, 'predecessorRoles', fn)
  const succRoles = requireRoles(input.successorRoles, 'successorRoles', fn)
  if (typeof input.sameOrg !== 'boolean') {
    throw new TypeError(`${fn}: sameOrg must be a boolean`)
  }
  return input.sameOrg && can(predRoles, 'edit') && can(succRoles, 'edit')
}

export type TaskDependencyDirection = 'predecessor' | 'successor'

// ASSUMPTION(task-e, own choice): beyond the ruled (S11) "exclude itself and existing edges", the
// candidate list also drops every task that would close a cycle (for new predecessors: everything
// downstream of `taskId`; for new successors: everything upstream of it) — the same idea as
// `parentCandidates` dropping all descendants. Parent/child relations are NOT excluded, and the
// per-task edge limit is not applied here (an at-limit pick is refused later with `limit`).
/**
 * Candidates for a new predecessor (`direction: 'predecessor'`, edge `candidate → taskId`) or a new
 * successor (`'successor'`, edge `taskId → candidate`). `candidateIds` must already be filtered by
 * the caller to tasks it may edit (same org, undeleted, matching the search text). Sorted, unique.
 */
export function dependencyCandidates(input: {
  taskId: string
  direction: TaskDependencyDirection
  candidateIds: readonly string[]
  edges: readonly TaskDependencyEdge[]
}): string[] {
  const fn = 'dependencyCandidates'
  if (typeof input !== 'object' || input === null) {
    throw new TypeError(`${fn}: input must be an object`)
  }
  const taskId = requireTaskId(input.taskId, 'taskId', fn)
  const edges = requireEdges(input.edges, fn)
  if (input.direction !== 'predecessor' && input.direction !== 'successor') {
    throw new TypeError(`${fn}: direction must be 'predecessor' or 'successor'`)
  }
  if (!Array.isArray(input.candidateIds)) {
    throw new TypeError(`${fn}: candidateIds must be an array`)
  }
  const closesCycle =
    input.direction === 'predecessor'
      ? reachableFrom(taskId, forwardIndex(edges))
      : reachableFrom(taskId, reverseIndex(edges))
  const linked = new Set<string>()
  for (const edge of edges) {
    if (edge.predecessorId === taskId) linked.add(edge.successorId)
    if (edge.successorId === taskId) linked.add(edge.predecessorId)
  }
  const result = new Set<string>()
  for (const raw of input.candidateIds) {
    const id = requireTaskId(raw, 'candidateIds[]', fn)
    if (id === taskId || linked.has(id) || closesCycle.has(id)) continue
    result.add(id)
  }
  return [...result].sort()
}
