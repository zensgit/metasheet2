import type { QueryFn } from './permission-service'
import { hasActiveTrustCheckpoint } from './history-trust-checkpoint'

/**
 * W0-1 v3.7 (owner-ratified #4331 §3/§9) — the P3-2 flag-on PRECONDITION guard for
 * `MULTITABLE_HISTORY_CONTIGUITY_STRICT` (and, later, Revert/Reset enablement). Strict destructive-recovery
 * mode must REFUSE to enable for a sheet unless BOTH hold:
 *   (a) an ACTIVE trust checkpoint exists for the sheet, AND
 *   (b) reconstruction causality is satisfied.
 *
 * Condition (b)'s MECHANISM landed with Lane L6-b — the recovery-authority reconstructor is CAUSAL
 * (`reconstructRecordsAtSeq`, seq-anchored on the shared `meta_record_chain_seq` domain; `created_at <= T`
 * stays for read-only display only) — but the constant below is DELIBERATELY HELD `false` (owner ruling
 * 2026-07-17): it flips to `true` ONLY in the same PR that actually wires the legacy Revert/Reset routes
 * onto the L8 exact-anchor apply. Until that wiring PR, this precondition refuses EVERY sheet regardless of
 * checkpoints or the flag — the last fail-closed backstop stays in place. Removing a backstop and adding the
 * consumers that depend on its guarantees must be ONE reviewable change, not two.
 *
 * WIRED (L5 P2): {@link checkStrictEnablementPrecondition} is called by the authoritative strict-mode entry
 * point `precheckSheetHistoryIntegrity` (history-integrity-precheck.ts) — the function the Revert/Reset
 * recovery routes go through. When the strict flag is ON, `!canEnable` REFUSES UNCONDITIONALLY
 * (`strict_enablement_unmet`) — BOTH conditions must hold, exactly as this module declares. An earlier draft
 * exempted `no_active_checkpoint` from the refusal so the L3 strict-comparator goldens (which force the flag
 * on without provisioning a checkpoint) kept exercising the comparator via HTTP — that was a production
 * bypass protecting test convenience (owner P2, 2026-07-16) and let every checkpoint-less sheet into the
 * strict comparator the moment an operator flipped the flag. Removed: tests that need the comparator call
 * `precheckSheetHistoryIntegrityStrict` directly (or, now that L6-b satisfies (b), provision a real active
 * checkpoint); the production path stays fail-closed for any sheet WITHOUT an active checkpoint, and — even
 * with one — nothing runs unless the operator flips the default-OFF flag.
 * The pure {@link evaluateStrictEnablementPrecondition} proves the two-condition logic (including the positive
 * control where both hold); the real-DB behavioral golden in
 * `multitable-history-trust-checkpoint-realdb.test.ts` proves strict-on is refused for a checkpoint-less sheet
 * AND that a checkpoint-bearing sheet is STILL refused (`reconstruction_non_causal`) while the seam constant
 * is held `false` — the backstop pin, via this WIRED path.
 */

/**
 * The L6 seam — DELIBERATELY HELD `false` (owner ruling 2026-07-17). The causal recovery-authority
 * reconstructor (`reconstructRecordsAtSeq`, seq-anchored under the L4 all-writer fence + L5 trusted-since
 * checkpoint) DID land with Lane L6-b, so the mechanism for condition (b) exists — but this constant is the
 * LAST fail-closed backstop for strict enablement, and the owner ruled it flips to `true` only in the same
 * PR that wires the legacy Revert/Reset routes onto the L8 exact-anchor apply (backstop removal and the
 * consumers that rely on it = one reviewable change). It stays a runtime const (NOT an env flag) so the
 * posture is a code fact pinned by goldens: while `false`, strict-on refuses EVERY sheet
 * (`reconstruction_non_causal`) even with an active checkpoint — flipping this prematurely reds the seam
 * golden in `multitable-history-trust-checkpoint.test.ts`.
 */
export const RECONSTRUCTION_CAUSALITY_LANDED = false

export type StrictEnablementUnmet = 'no_active_checkpoint' | 'reconstruction_non_causal'

export interface StrictEnablementPreconditionResult {
  /** true iff EVERY precondition is satisfied (while the seam constant is held false: NEVER in production) */
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
 * seam constant. While the seam is HELD `false` (owner ruling — until the Revert/Reset wiring PR), this NEVER
 * returns `canEnable: true`: a checkpoint-bearing sheet still lists `reconstruction_non_causal`, a
 * checkpoint-less one lists both. The `unmet` array reflects each half precisely, so callers/tests can see
 * the checkpoint half evaluated independently of the held-back seam.
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
