/**
 * W7-1a (#4556) STEP 4 — the W6-R5 preservation guard's CURATED CLASSIFICATION
 * (design-lock red line W7-R10, Leg 0).
 *
 * This is the guard's CLAIM side. It is NOT the scan domain: the domain is
 * DERIVED by `./walk.ts` from the three pinned roots in
 * `ATTENDANCE_W7_W6R5_GUARD_ROOTS_V1`. Pinning the domain to a file list is
 * the defect W7-R10 replaces ("a helper module outside the list walked
 * straight through it"); pinning the CLAIM to a file list is the P16 shape
 * (`scripts/attendance/w4c0-dml-inventory/curated-debt-entries.cjs:74`) and is
 * what makes `unclaimed = 0` mean something. A file that appears under a
 * pinned root and in neither list below reds the guard by construction.
 *
 * `NOT_CALCULATION_PATH` IS EMPTY, and that is a measured result, not an
 * omission. Every one of the 72 files the walk currently yields was checked
 * against both ban legs with the whole domain classified `calculation_path`,
 * and zero violated either leg — so there was no file that HAD to be carved
 * out to keep the guard green. Leaving the carve-out list empty is therefore
 * the strictly stronger partition: both ban legs apply to every walked file.
 *
 * This also happens to close W7-R10's own first stated blind spot for this
 * head. That blind spot is "a file classified `not_calculation_path` —
 * deliberately or by mistake — leaves the ban legs inapplicable to it while
 * Leg 0 stays green, because the classification file is the CLAIM side and a
 * `not_calculation_path` entry is a reviewable assertion, not a proof". With
 * the carve-out list empty there is no such entry to review, so the blind spot
 * is vacuously absent at this head. It is NOT closed as a class: the moment
 * anyone adds a first entry below, the blind spot is live again and the
 * mitigation is the one W7-R10 prescribes — review the classification diff and
 * spot-check the entry for non-reachability from the frozen-context build
 * path. The guard cannot do that for you; it can only force the entry to be
 * written down. Every entry MUST therefore carry a reason (the type below
 * makes that structural, not a convention).
 *
 * W7-R10's other three stated blind spots are unaffected by the empty
 * carve-out list and are carried verbatim rather than papered over: (2) a call
 * originating in a module outside the pinned roots is only narrowed to
 * "someone added a directory nobody pinned as a root"; (3) a route string
 * assembled from fragments at run time is not caught; (4) any consumption path
 * that is neither a module reference nor an HTTP call to that route is not
 * caught.
 */

export interface AttendanceW7NotCalculationPathEntryV1 {
  readonly relPath: string
  /** Why this file cannot reach the frozen-context build path. Required — a
   *  carve-out without a reason is an unreviewable assertion. */
  readonly reason: string
}

/**
 * Files under the pinned roots that ARE on (or reachable from) the
 * frozen-context build path, and over which BOTH ban legs run.
 *
 * Derived once from the walk and pinned here deliberately: this list is what
 * makes a NEW file red Leg 0 instead of being silently absorbed. Regenerating
 * it is the same discipline as the s6a hash pin and the attendance CI corpus
 * pin — a new file under a pinned root is announced, then classified.
 *
 * REGENERATION RECIPE (do not hand-edit 72 strings):
 *
 *   EMIT_W7_CLASSIFICATION=1 pnpm --filter @metasheet/core-backend exec \
 *     vitest run tests/unit/attendance-w7-w6r5-preservation-guard.test.ts
 *
 * prints the derived body, which is the value that belongs below. Paste it in
 * the SAME commit that adds the file — and only after deciding the file really
 * is on the calculation path, because pasting is the easy half and classifying
 * is the half that carries meaning.
 */
export const ATTENDANCE_W7_CALCULATION_PATH_FILES_V1: readonly string[] = Object.freeze([
  'packages/core-backend/src/attendance/w4c0-authorization.ts',
  'packages/core-backend/src/attendance/w4c0-fingerprints.ts',
  'packages/core-backend/src/attendance/w4c0-identity.ts',
  'packages/core-backend/src/attendance/w4c0-operation-contract.ts',
  'packages/core-backend/src/attendance/w4c0-operation-registry.ts',
  'packages/core-backend/src/attendance/w4c0-source-commands.ts',
  'packages/core-backend/src/attendance/w4c0-write-boundary-types.ts',
  'packages/core-backend/src/attendance/w4c1-fingerprints.ts',
  'packages/core-backend/src/attendance/w4c1-merge-policy.ts',
  'packages/core-backend/src/attendance/w4c1-segment-calculator.ts',
  'packages/core-backend/src/attendance/w4c1-strict-time.ts',
  'packages/core-backend/src/attendance/w4c2-authoritative-calculation-core.ts',
  'packages/core-backend/src/attendance/w4c2-authoritative-delivery.ts',
  'packages/core-backend/src/attendance/w4c2-frozen-attribution.ts',
  'packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts',
  'packages/core-backend/src/attendance/w4c2-outbox-dispatcher.ts',
  'packages/core-backend/src/attendance/w4c2-scheduled-run-ops-worker.ts',
  'packages/core-backend/src/attendance/w4c2-scheduled-run.ts',
  'packages/core-backend/src/attendance/w4c2-shadow-expected-differences.ts',
  'packages/core-backend/src/attendance/w4c3a-canonical-import-kernel.ts',
  'packages/core-backend/src/attendance/w4c3a-import-proof.ts',
  'packages/core-backend/src/attendance/w4c3a-import-rollback-boundary.ts',
  'packages/core-backend/src/attendance/w4c3a-import-rollback.ts',
  'packages/core-backend/src/attendance/w4c3a-legacy-execution-plan.ts',
  'packages/core-backend/src/attendance/w4c3a-legacy-plan-batch-effects.ts',
  'packages/core-backend/src/attendance/w4c3a-legacy-plan-enqueue.ts',
  'packages/core-backend/src/attendance/w4c3a-legacy-plan-group-effects.ts',
  'packages/core-backend/src/attendance/w4c3a-legacy-plan-item-effects.ts',
  'packages/core-backend/src/attendance/w4c3a-legacy-plan-preconditions.ts',
  'packages/core-backend/src/attendance/w4c3a-legacy-plan-processor.ts',
  'packages/core-backend/src/attendance/w4c3a-legacy-plan-record-effects.ts',
  'packages/core-backend/src/attendance/w4c3a-legacy-plan-reservation-host.ts',
  'packages/core-backend/src/attendance/w4c3a-legacy-plan-worker-repository.ts',
  'packages/core-backend/src/attendance/w4c3a-legacy-plan-worker.ts',
  'packages/core-backend/src/attendance/w4c3a-rollout-control.ts',
  'packages/core-backend/src/attendance/w4c3a-sync-import-host.ts',
  'packages/core-backend/src/attendance/w4c3a-sync-import-kernel.ts',
  'packages/core-backend/src/attendance/w4c3b-approved-leave-cancellation.ts',
  'packages/core-backend/src/attendance/w4c3b-central-approval-hooks.ts',
  'packages/core-backend/src/attendance/w4c3b-request-operation-boundary.ts',
  'packages/core-backend/src/attendance/w4c3b-request-snapshots.ts',
  'packages/core-backend/src/attendance/w4c3c-active-current.ts',
  'packages/core-backend/src/attendance/w4c3c-manual-edit-apply.ts',
  'packages/core-backend/src/attendance/w4c3c-manual-override.ts',
  'packages/core-backend/src/attendance/w4c3c-ops-retirement.ts',
  'packages/core-backend/src/attendance/w4c3c-recompute.ts',
  'packages/core-backend/src/attendance/w4c3c-record-operation-boundary.ts',
  'packages/core-backend/src/attendance/w5-flex-policy.ts',
  'packages/core-backend/src/attendance/w6-group-effective-policy-aggregate.ts',
  'packages/core-backend/src/attendance/w6-group-effective-policy-contract.ts',
  'packages/core-backend/src/attendance/w6-group-effective-policy-panel-flag.ts',
  'packages/core-backend/src/attendance/w6-group-effective-policy-response-contract.ts',
  // W7-2: the compare-window exit-criteria counters. Classified
  // `calculation_path` — the HONEST bucket: it reads the shadow ledger the
  // calculation writers produce and gates the ladder those writers cut over
  // on, so both ban legs must apply to it.
  'packages/core-backend/src/attendance/w7-compare-window-status.ts',
  'packages/core-backend/src/attendance/w7-context-source-delivery.ts',
  'packages/core-backend/src/attendance/w7-context-source-posture-contract.ts',
  'packages/core-backend/src/attendance/w7-context-source-transition.ts',
  'packages/core-backend/src/attendance/w7-frozen-context-v2-contract.ts',
  // W7-1b: the V2 discriminant-routing rule. `calculation_path` — the HONEST
  // bucket, not a carve-out: it decides which frozen-context shapes the
  // calculator will accept, so both ban legs must apply to it.
  'packages/core-backend/src/attendance/w7-frozen-context-router.ts',
  'packages/core-backend/src/attendance/w7-provenance-domain.ts',
  'packages/core-backend/src/attendance/w7-read-side-provenance-amendment.ts',
  'packages/core-backend/src/attendance/w7-resolver/w7-composite-lock-order.ts',
  'packages/core-backend/src/attendance/w7-resolver/w7-context-source-posture-resolver.ts',
  // W7-1b: the issuance seam. Classified `calculation_path` — the HONEST bucket,
  // not a carve-out: this module IS the frozen-context build path, so both ban
  // legs must apply to it. W7-1b is the slice where those legs stop being
  // theoretical (1a was 零生产引用), which is exactly why the seam belongs here.
  'packages/core-backend/src/attendance/w7-resolver/w7-frozen-context-issuance-seam.ts',
  'packages/core-backend/src/attendance/w7-resolver/w7-group-effective-context-issuance.ts',
  'packages/core-backend/src/attendance/w7-resolver/w7-group-effective-facts-resolver.ts',
  // W7-2: the expected-differences roster + fail-closed probe. Classified
  // `calculation_path` — the HONEST bucket, not a carve-out: the roster is the
  // claim side of the compare gate that decides which legacy-vs-group
  // divergences may pass `group_eligible` entry, so both ban legs must apply.
  'packages/core-backend/src/attendance/w7-shadow-expected-differences.ts',
  'packages/core-backend/src/attendance/w7-w6r5-guard-root-set.ts',
  'plugins/plugin-attendance/engine/index.cjs',
  'plugins/plugin-attendance/engine/sample-config.cjs',
  'plugins/plugin-attendance/engine/schema.cjs',
  'plugins/plugin-attendance/engine/template-library.cjs',
  'plugins/plugin-attendance/index.cjs',
  'plugins/plugin-attendance/lib/attendance-fixed-schedule-self-route-identity.cjs',
  'plugins/plugin-attendance/lib/attendance-group-fixed-schedule-config-service.cjs',
  'plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs',
  'plugins/plugin-attendance/lib/attendance-group-fixed-schedule-producer-key.cjs',
  // Shadow audit of the punch route's org resolution (env
  // ATTENDANCE_SELF_SERVICE_ORG_RESOLUTION_V1=shadow). Classified `calculation_path` — the
  // HONEST bucket, not a carve-out: it is `require`d directly from
  // plugins/plugin-attendance/index.cjs's punch route and reads org membership state the
  // calculation path also depends on, so both ban legs apply to it even though it never
  // WRITES a calculation itself (only an out-of-band audit row).
  'plugins/plugin-attendance/lib/attendance-org-resolution-shadow.cjs',
  'plugins/plugin-attendance/lib/attendance-punch-org-resolution.cjs',
  'plugins/plugin-attendance/lib/attendance-shift-service.cjs',
  'plugins/plugin-attendance/lib/attendance-work-date-adapters.cjs',
  'plugins/plugin-attendance/lib/attendance-work-date-resolver.cjs',
] as const)

/**
 * Files under the pinned roots that CANNOT reach the frozen-context build
 * path, each with its reason. EMPTY at this head — see the file header for why
 * that is a measured result and what it does and does not close.
 */
export const ATTENDANCE_W7_NOT_CALCULATION_PATH_FILES_V1: readonly AttendanceW7NotCalculationPathEntryV1[] =
  Object.freeze([] as const)
