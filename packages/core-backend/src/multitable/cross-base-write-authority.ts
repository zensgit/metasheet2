/**
 * Cross-base write authority — the shared, CONTEXT-AGNOSTIC authority primitive.
 *
 * Extracted from `AutomationExecutor.evaluateCrossBaseWrite` (C1 of the ratified cross-base Slice 1 design-lock,
 * `docs/development/multitable-crossbase-twoway-editable-mirror-slice1-designlock-20260629.md` §3/§10). It is the
 * single source of truth for the two-part authority decision on a cross-base write into a canonical-owner base:
 *
 *   1. claim == truth  — the caller's declared target base must equal the resolved target base (an explicit opt-in).
 *   2. base-write authority — the actor must hold base-write on that target base (`resolveBaseWritable`, fail-closed).
 *
 * Both the automation executor (today) and the cross-base mirror write-through (C2, later) consume THIS — neither
 * lifts the automation-flavoured `evaluateCrossBaseWrite` wholesale (§3). To stay context-agnostic this module
 * imports ONLY `resolveBaseWritable` + the `QueryFn` type — NOT the automation executor, `ExecutionContext`, the
 * quota store, or any automation type.
 *
 * Scope boundaries this primitive deliberately does NOT own (the CALLER composes them, per §10/I-3):
 *   - Base resolution + the same-base short-circuit + soft-deleted-target handling (caller resolves bases first and
 *     only calls this for a genuine cross-base write).
 *   - The per-target-base write QUOTA (adapter-composed: the automation adapter and the C2 base-A leg each apply
 *     their quota keyed to the target/base-A; the C2 base-B leg uses a plain `resolveBaseWritable` with no claim
 *     and no quota — it is the actor's own base, not a cross-base target).
 *   - Caller-specific error wording (this returns a structured `reason`; the caller maps it to its own message).
 */
import { resolveBaseWritable, type QueryFn } from './permission-service'

export type CrossBaseWriteAuthorityReason = 'claim_mismatch' | 'not_writable'

export type CrossBaseWriteAuthorityResult =
  | { ok: true }
  | { ok: false; reason: CrossBaseWriteAuthorityReason }

/**
 * Resolve the cross-base write authority decision for a write INTO `targetBaseId`.
 * Order is load-bearing (claim before authority) and matches the extracted source exactly.
 *
 * @param actorId           the acting user id (null/empty → fail-closed via `resolveBaseWritable`)
 * @param targetBaseId      the resolved canonical-owner base being written into (caller resolves + same-base-short-circuits first)
 * @param declaredBaseClaim the caller's explicit target-base opt-in (null when absent)
 * @param queryFn           DB access for `resolveBaseWritable`
 */
export async function resolveCrossBaseWriteAuthority(input: {
  actorId: string | null
  targetBaseId: string
  declaredBaseClaim: string | null
  queryFn: QueryFn
}): Promise<CrossBaseWriteAuthorityResult> {
  // (1) claim == truth — an explicit, consistent opt-in. Absent or mismatched → reject.
  if (input.declaredBaseClaim === null || input.declaredBaseClaim !== input.targetBaseId) {
    return { ok: false, reason: 'claim_mismatch' }
  }
  // (2) base-write authority (fail-closed: null/empty actor → false).
  const writable = await resolveBaseWritable(input.actorId, input.queryFn, input.targetBaseId)
  if (!writable) {
    return { ok: false, reason: 'not_writable' }
  }
  return { ok: true }
}
