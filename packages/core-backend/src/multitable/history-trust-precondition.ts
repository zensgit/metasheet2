import type { QueryFn } from './permission-service'
import { hasActiveTrustCheckpoint } from './history-trust-checkpoint'

/**
 * W0-1 v3.7 (owner-ratified #4331 §3/§9) — the P3-2 flag-on PRECONDITION guard for
 * `MULTITABLE_HISTORY_CONTIGUITY_STRICT` (and, later, Revert/Reset enablement). Strict destructive-recovery
 * mode must REFUSE to enable for a sheet unless BOTH hold:
 *   (a) an ACTIVE trust checkpoint exists for the sheet, AND
 *   (b) reconstruction causality is satisfied.
 *
 * Condition (b) is NOT yet satisfiable: the reconstructor still selects by `created_at <= T` (non-causal)
 * until Lane L6 lands the exact event-anchor resolver. So this precondition CURRENTLY FAILS CLOSED for every
 * sheet — which is the CORRECT behavior (design lock §3: "migration/backfill presence alone never enables
 * recovery"; §9.7: ratification authorizes default-off slices only, not strict-mode enablement). This guard
 * MUST stay fail-closed until L6; it must not be weakened to pass.
 *
 * WIRED (L5 P2): {@link checkStrictEnablementPrecondition} is called by the authoritative strict-mode entry
 * point `precheckSheetHistoryIntegrity` (history-integrity-precheck.ts) — the function the Revert/Reset
 * recovery routes go through. When the strict flag is ON, a sheet that has ENTERED the trust-checkpoint regime
 * (condition (a) `no_active_checkpoint` is NOT in `unmet`) but whose full precondition is unmet is REFUSED
 * fail-closed (`strict_enablement_unmet`). The refusal is SCOPED to checkpoint-bearing sheets precisely so the
 * L3 strict-comparator goldens — which force the flag on WITHOUT ever provisioning a checkpoint — keep
 * exercising the comparator (the concern that previously kept this "deliberately NOT wired"): a no-checkpoint
 * sheet is not yet under the gate. SEAM: L5-wire activates a checkpoint on every recovery path, after which no
 * no-checkpoint sheet remains and the gate covers every strict recovery uniformly (see the entry-point note).
 * The pure {@link evaluateStrictEnablementPrecondition} proves the two-condition logic (including the positive
 * control where both hold); the real-DB behavioral golden in
 * `multitable-history-trust-checkpoint-realdb.test.ts` proves strict-on is refused by this WIRED path.
 */

/**
 * The single L6 seam. Reconstruction is still non-causal (selects by `created_at <= T`) until L6 lands the
 * exact event-anchor resolver; L6 flips this constant to `true`. Until then the strict-enablement precondition
 * fails closed no matter what (see the module doc comment). Kept as a runtime const (not an env flag) so it
 * cannot be turned on by operator misconfiguration — only a code change in L6 may flip it.
 */
export const RECONSTRUCTION_CAUSALITY_LANDED = false

export type StrictEnablementUnmet = 'no_active_checkpoint' | 'reconstruction_non_causal'

export interface StrictEnablementPreconditionResult {
  /** true iff EVERY precondition is satisfied (currently impossible pre-L6) */
  canEnable: boolean
  /** the specific unmet conditions — the guard distinguishes exactly what it claims to distinguish */
  unmet: StrictEnablementUnmet[]
}

/**
 * PURE evaluation of the two-condition precondition. Returns the exact set of UNMET conditions so the guard
 * distinguishes "no active checkpoint" from "reconstruction non-causal" independently (a count-only guard
 * could be fooled by one condition passing twice — see [[feedback_count_guard_and_fake_switch_test]]).
 */
export function evaluateStrictEnablementPrecondition(input: {
  hasActiveCheckpoint: boolean
  reconstructionIsCausal: boolean
}): StrictEnablementPreconditionResult {
  const unmet: StrictEnablementUnmet[] = []
  if (!input.hasActiveCheckpoint) unmet.push('no_active_checkpoint')
  if (!input.reconstructionIsCausal) unmet.push('reconstruction_non_causal')
  return { canEnable: unmet.length === 0, unmet }
}

/**
 * Real-DB precondition check for a sheet: reads (a) from `meta_history_trust_checkpoints` and (b) from the L6
 * seam constant. Currently ALWAYS returns `canEnable: false` (b is never satisfied pre-L6); the `unmet` array
 * still reflects (a) precisely, so callers/tests can see the checkpoint half evaluated independently.
 */
export async function checkStrictEnablementPrecondition(
  query: QueryFn,
  sheetId: string,
): Promise<StrictEnablementPreconditionResult> {
  const hasActiveCheckpoint = await hasActiveTrustCheckpoint(query, sheetId)
  return evaluateStrictEnablementPrecondition({
    hasActiveCheckpoint,
    reconstructionIsCausal: RECONSTRUCTION_CAUSALITY_LANDED,
  })
}
