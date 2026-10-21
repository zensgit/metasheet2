/**
 * D22 / #6396. A `legacy_repair` companion is evidence-bound and append-only.
 * Recalculation recognizes that frame and does not write another backfill or
 * rewrite the attendance record. An active row with no such frame is still
 * `migration_required`.
 */

export interface LegacyRepairFrameProbeV1 {
  readonly source?: unknown
  readonly fingerprint?: unknown
}

export type ApprovedLeaveDayRecalcPlanV1 =
  | { readonly action: 'use_legacy_repair_frame'; readonly fingerprint: string }
  | { readonly action: 'use_existing_frame'; readonly fingerprint: string }
  | { readonly action: 'migration_required' }
  | { readonly action: 'no_record' }

export function planApprovedLeaveDayRecalcV1(input: {
  readonly activeRecord: boolean
  readonly companion: LegacyRepairFrameProbeV1 | null
}): ApprovedLeaveDayRecalcPlanV1 {
  const fingerprint = input.companion?.fingerprint
  const hasFingerprint = typeof fingerprint === 'string' && fingerprint.length > 0
  if (input.companion?.source === 'legacy_repair') {
    if (!hasFingerprint) throw new Error('ATTENDANCE_LEGACY_REPAIR_FRAME_INVALID')
    return { action: 'use_legacy_repair_frame', fingerprint: fingerprint as string }
  }
  if (input.companion && hasFingerprint) {
    return { action: 'use_existing_frame', fingerprint: fingerprint as string }
  }
  if (input.activeRecord) return { action: 'migration_required' }
  return { action: 'no_record' }
}

/** This planner never inserts a companion. Repair frames are reused; unrepaired rows stay refused. */
export function recalcWritesCompanionV1(_plan: ApprovedLeaveDayRecalcPlanV1): boolean {
  return false
}
