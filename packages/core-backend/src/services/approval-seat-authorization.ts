/**
 * The ONE seat-authorization predicate the approval decision door uses, plus the viewer-scoped
 * answer the detail read ships so the client renders rather than re-derives.
 *
 * ### Why this module exists
 *
 * `ApprovalDetailView` renders its decision controls on the coarse `approvals:act` RBAC grant
 * (`canAct`) alone, while the server's door refuses anyone who does not hold a seat at the node the
 * instance is actually stopped on. The two therefore disagree for a requester (or any other reader
 * who may act somewhere, just not here), and the FE's own narrower `isMyTurn` mirror cannot be used
 * instead because it recognises only USER seats — switching the buttons to it would hide them from
 * every ROLE-seated approver the server does accept.
 *
 * The fix is a server-computed boolean on the detail DTO. For that boolean to be worth anything it
 * must be produced by the SAME predicate the door enforces, not a second approximation of it — so
 * this module holds the predicate itself (moved here, not copied) and both the door and the DTO
 * builders call it. `approval-effective-node-operations.ts`'s `seatNodeKeysForViewer` — which
 * previously carried its own hand-written copy of the user/role match rule, documented as mirroring
 * this one "exactly" — now calls it too, so the drift its docblock warned about is impossible by
 * construction rather than merely detected. (Same move, same reason, as the
 * `resolveApprovalActorRoles` extraction in `approval-actor-roles.ts`.)
 *
 * ### Leaf on purpose
 *
 * `ApprovalProductService` (the door) already imports `ApprovalBridgeService` (the other DTO
 * builder), so the predicate cannot live in the former without the latter importing back into a
 * cycle. Everything here is pure and depends only on `approval-bridge-types` /
 * `ApprovalGraphExecutor` types.
 */
import type { ParallelInstanceState } from './ApprovalGraphExecutor'

/** The assignment fields the actor match rule reads — a structural subset of `ApprovalAssignmentRow`. */
export interface ActorMatchableAssignment {
  is_active: boolean
  assignment_type: string
  assignee_id: string
}

/** `ActorMatchableAssignment` plus the node the seat sits at. */
export interface SeatedAssignment extends ActorMatchableAssignment {
  node_key: string | null
}

/** The instance columns the decision-door mirror reads. */
export interface DecidableInstanceRow {
  id: string
  status: string
  source_system?: string | null
  published_definition_id?: string | null
  current_node_key: string | null
  metadata?: Record<string, unknown> | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * D-5 (Lock-9 implementation brief): exported (was module-private in `ApprovalProductService`) so
 * the process-attachment upload route (§5.2) can re-derive the acting seat WITHOUT reimplementing
 * the user/role match rule. `dispatchAction`'s own inline uses (currentNodeAssignments.filter(...))
 * are unaffected.
 *
 * MOVED here from `ApprovalProductService.ts` (body unchanged) so the DTO builders can reach it
 * without an import cycle; `ApprovalProductService` re-exports it, so every existing importer and
 * every `path:line` reference to it keeps resolving. The parameter type was WIDENED from
 * `ApprovalAssignmentRow` to the three fields the body actually reads — a pure type widening, no
 * behaviour change — so a caller holding a structurally narrower row (the DTO builders,
 * `seatNodeKeysForViewer`) can pass it without a cast.
 */
export function assignmentMatchesActor(
  assignment: ActorMatchableAssignment,
  actorId: string,
  actorRoles: string[],
): boolean {
  if (!assignment.is_active) return false
  if (assignment.assignment_type === 'user') {
    return assignment.assignee_id === actorId
  }
  if (assignment.assignment_type === 'role') {
    return actorRoles.includes(assignment.assignee_id)
  }
  return false
}

/**
 * MOVED here from `ApprovalProductService.ts` (body unchanged) so the decision-door node-key
 * derivation below can share the door's OWN parser rather than a tolerant second read of the same
 * metadata blob. Strict by design: any malformed branch entry returns `null`, and the door then
 * treats the instance as linear — which is exactly what the mirror must reproduce.
 */
export function readParallelBranchStates(metadata: unknown): ParallelInstanceState | null {
  if (!isRecord(metadata)) return null
  const states = (metadata as { parallelBranchStates?: unknown }).parallelBranchStates
  if (!isRecord(states)) return null
  if (typeof states.parallelNodeKey !== 'string'
    || typeof states.joinNodeKey !== 'string'
    || (states.joinMode !== 'all' && states.joinMode !== 'any')
    || !isRecord(states.branches)) {
    return null
  }
  const branches: Record<string, ParallelInstanceState['branches'][string]> = {}
  for (const [edgeKey, entryRaw] of Object.entries(states.branches)) {
    if (!isRecord(entryRaw)) return null
    const entry = entryRaw as { edgeKey?: unknown; currentNodeKey?: unknown; complete?: unknown }
    if (typeof entry.edgeKey !== 'string') return null
    if (entry.currentNodeKey !== null && typeof entry.currentNodeKey !== 'string') return null
    if (typeof entry.complete !== 'boolean') return null
    branches[edgeKey] = {
      edgeKey: entry.edgeKey,
      currentNodeKey: entry.currentNodeKey as string | null,
      complete: entry.complete,
    }
  }
  return {
    parallelNodeKey: states.parallelNodeKey as string,
    joinNodeKey: states.joinNodeKey as string,
    joinMode: states.joinMode as 'all' | 'any',
    branches,
  }
}

/**
 * Every node key a seat can authorize a decision at right now — the SAME set `dispatchAction`'s
 * authorization gate resolves, restated as a set instead of the single `currentNodeKey` variable
 * the door threads onward.
 *
 * The door computes, in order: `currentNodeKey = storedCurrentNodeKey`; then, when the instance is
 * inside a parallel region (`storedCurrentNodeKey === parallelState.parallelNodeKey`), it looks for
 * one of the actor's own active assignments whose `node_key` is a still-pending branch frontier and,
 * finding one, moves `currentNodeKey` to that branch node. It then admits the actor iff some
 * assignment at `currentNodeKey` matches them. Since finding such a branch candidate already means
 * the actor is admitted, and failing to find one leaves `currentNodeKey` at the stored key, the
 * door's verdict is exactly "the actor matches an assignment at some key in
 * {storedCurrentNodeKey} ∪ (in a parallel region: the pending branch frontier)" — which is what
 * this returns.
 *
 * NOT `collectActiveNodeKeys` (`approval-form-redaction.ts`), which unions the pending branch
 * frontier whenever the metadata carries one, without the `=== parallelNodeKey` test, and parses
 * that metadata tolerantly instead of strictly. That helper's callers (the redaction gate, the
 * upload fail-fast) are allowed to be wider than the door because they disclaim authority; this
 * mirror is not — a false positive here is precisely the client/server disagreement the field
 * exists to remove.
 */
export function decidableNodeKeysForInstance(
  currentNodeKey: string | null,
  metadata: Record<string, unknown> | null | undefined,
): string[] {
  const keys = new Set<string>()
  if (typeof currentNodeKey === 'string' && currentNodeKey.length > 0) {
    keys.add(currentNodeKey)
  }
  const parallelState = readParallelBranchStates(metadata ?? null)
  if (parallelState && currentNodeKey === parallelState.parallelNodeKey) {
    for (const branch of Object.values(parallelState.branches)) {
      if (branch.complete) continue
      if (typeof branch.currentNodeKey === 'string' && branch.currentNodeKey.length > 0) {
        keys.add(branch.currentNodeKey)
      }
    }
  }
  return [...keys]
}

/**
 * True when this instance's decisions go through the SEAT-GATED door.
 *
 * `POST /api/approvals/:id/actions` picks its dispatch by instance shape. A template-runtime
 * instance goes to `ApprovalProductService.dispatchAction`, whose gate is the seat check above
 * (403 `APPROVAL_ASSIGNMENT_REQUIRED`). Everything else — legacy platform rows with no published
 * definition, `plm:` mirrors — goes to `ApprovalBridgeService.dispatchAction`, which has NO
 * assignment gate at all: `approvals:act` plus a pending status is the whole authorization. (An
 * after-sales row is intercepted earlier still, by `submitRefundApprovalDecision`; it lands on the
 * same `false` side of this predicate.) Reporting `false` for any of them would HIDE controls the
 * server accepts, so the mirror asks which door applies first.
 *
 * Mirrors `ApprovalProductService.isTemplateRuntimeInstance`'s SQL
 * (`COALESCE(source_system,'platform') = 'platform' AND published_definition_id IS NOT NULL`) plus
 * the route's own `isPlmApprovalId` short-circuit, in memory over columns both DTO builders already
 * hold. `approval-can-decide-current-node.db.test.ts` pins the agreement behaviourally on BOTH
 * sides for the two doors it can reach: an instance with a published definition and one without,
 * each asserting the reported value together with the door's actual verdict for the same viewer.
 *
 * WHAT IS NOT PROVEN HERE, stated exactly: the after-sales decision path and an attendance-sourced
 * row (which the P17/P22 fail-closed guard refuses at the bridge door) are not exercised, so on
 * those the `true` this returns is the STATUS QUO — the bar renders on `canAct` alone there today,
 * so no regression is possible — rather than a verified mirror of their refusals.
 */
export function decisionDoorIsSeatGated(instance: DecidableInstanceRow): boolean {
  if (instance.id.startsWith('plm:')) return false
  const sourceSystem = typeof instance.source_system === 'string' && instance.source_system.length > 0
    ? instance.source_system
    : 'platform'
  if (sourceSystem !== 'platform') return false
  return typeof instance.published_definition_id === 'string' && instance.published_definition_id.length > 0
}

/**
 * The viewer-scoped answer the detail DTO ships as `canDecideCurrentNode`: would the decision
 * endpoint's own authorization predicate let THIS viewer decide the node this instance is stopped
 * on, right now?
 *
 * `false` when the instance is not pending, when no viewer identity was supplied, and when the
 * viewer holds no matching active seat at any decidable node key. `true` for a pending instance
 * whose decisions do not go through the seat-gated door (see `decisionDoorIsSeatGated`) — there is
 * no seat predicate to mirror there, and `true` is what those surfaces already do today, so the
 * value cannot narrow anything that works now.
 *
 * Seat coverage comes entirely from `assignmentMatchesActor`, so it is the door's coverage exactly:
 * USER seats, ROLE seats (matched against the roles the door itself is handed — see the note on
 * `viewerRoles` below), delegated seats (delegation is applied at CREATE time inside
 * `ApprovalAssigneeResolver.pushResolved`, so the delegatee IS the `assignee_id` on a real
 * assignment row and needs no special case), and parallel branches via
 * `decidableNodeKeysForInstance`. A `'source_queue'` seat matches nothing, at the door and here.
 *
 * `viewerRoles` MUST be the roles the DECISION route resolves (`resolveApprovalActorRoles`, which
 * both doors' actors are built from) — NOT the wider DB-rebuilt set
 * `approval-instance-readability.ts`'s `viewerRoles` produces for the read-admission predicate.
 * The two differ: the readability set unions every `user_roles.role_id` and `roles.name`, while the
 * door sees the single resolved `req.user.role` (DB-derived: `AuthService.resolveRbacProfile` reads
 * `user_roles` for it) unioned with any `roles` claim. Using the wider set would report `true` for a
 * role seat the door then refuses — the divergence pointed the other way. The narrowness is the
 * door's, and is inherited on purpose.
 */
export function resolveCanDecideCurrentNode(options: {
  instance: DecidableInstanceRow
  assignments: readonly SeatedAssignment[]
  viewerUserId: string | null | undefined
  viewerRoles: readonly string[] | null | undefined
}): boolean {
  const { instance, assignments, viewerUserId } = options
  if (!viewerUserId) return false
  if (instance.status !== 'pending') return false
  if (!decisionDoorIsSeatGated(instance)) return true

  const decidableNodeKeys = new Set(
    decidableNodeKeysForInstance(instance.current_node_key, instance.metadata ?? null),
  )
  if (decidableNodeKeys.size === 0) return false

  const actorRoles = (options.viewerRoles ?? []).filter(
    (role): role is string => typeof role === 'string' && role.length > 0,
  )
  return assignments.some((assignment) => (
    typeof assignment.node_key === 'string'
    && decidableNodeKeys.has(assignment.node_key)
    && assignmentMatchesActor(assignment, viewerUserId, actorRoles)
  ))
}
