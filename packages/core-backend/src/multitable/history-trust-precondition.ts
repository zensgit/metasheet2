import type { QueryFn } from './permission-service'
import { hasActiveTrustCheckpoint } from './history-trust-checkpoint'

/**
 * W0-1 v3.7 (owner-ratified #4331 §3/§9) — the P3-2 flag-on PRECONDITION guard for
 * `MULTITABLE_HISTORY_CONTIGUITY_STRICT` (and Revert/Reset enablement). Strict destructive-recovery
 * mode must REFUSE to enable for a sheet unless BOTH hold:
 *   (a) an ACTIVE trust checkpoint exists for the sheet, AND
 *   (b) reconstruction causality is satisfied.
 *
 * Condition (b) is now TRUE: the L8 route integration wires the legacy Revert/Reset surfaces onto the
 * L6-b causal reconstructor + L8 exact-anchor apply (`reconstructRecordsAtSeq` / `applyExactAnchorRecovery`),
 * so the seam constant below is flipped in the SAME reviewable change that completed that wiring (owner
 * ruling 2026-07-17). Runtime feature flags (`MULTITABLE_ENABLE_SHEET_REVERT` / `MULTITABLE_ENABLE_PIT_RESET`
 * / `MULTITABLE_HISTORY_CONTIGUITY_STRICT`) remain default OFF — flipping this constant does not enable
 * recovery; it only removes the last fail-closed backstop that blocked strict enablement even with a
 * checkpoint present.
 *
 * WIRED (L5 P2): {@link checkStrictEnablementPrecondition} is called by the authoritative strict-mode entry
 * point `precheckSheetHistoryIntegrity` (history-integrity-precheck.ts) — the function the Revert/Reset
 * recovery routes go through. When the strict flag is ON, `!canEnable` REFUSES UNCONDITIONALLY
 * (`strict_enablement_unmet`) — BOTH conditions must hold. Tests that need the comparator without a
 * checkpoint call `precheckSheetHistoryIntegrityStrict` directly.
 * The pure {@link evaluateStrictEnablementPrecondition} proves the two-condition logic (including the positive
 * control where both hold); the real-DB behavioral golden in
 * `multitable-history-trust-checkpoint-realdb.test.ts` proves strict-on is refused for a checkpoint-less sheet
 * and that a checkpoint-bearing sheet can enable once this seam is true.
 */

/**
 * The L6 seam — FLIPPED true by the L8 exact-anchor route wiring integration (owner ruling 2026-07-17:
 * backstop removal and the consumers that rely on it = one reviewable change). The causal recovery-authority
 * reconstructor (`reconstructRecordsAtSeq`) and the four route surfaces (revert/reset × preview/execute)
 * are wired onto `applyExactAnchorRecovery`. Runtime flags stay default-OFF. This remains a runtime const
 * (NOT an env flag) so the posture is a code fact pinned by goldens.
 */
export const RECONSTRUCTION_CAUSALITY_LANDED = true

export type StrictEnablementUnmet = 'no_active_checkpoint' | 'reconstruction_non_causal'

export interface StrictEnablementPreconditionResult {
  /** true iff EVERY precondition is satisfied */
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
 * seam constant. With the seam true (L8 route wiring), a checkpoint-bearing sheet can enable; a checkpoint-less
 * one still lists `no_active_checkpoint`. The `unmet` array reflects each half precisely.
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
