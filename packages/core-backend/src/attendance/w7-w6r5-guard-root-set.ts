/**
 * W7 (#4556) W6-R5 preservation guard — ROOT SET record only (W7-R10).
 *
 * Status: PROPOSED / runtime HOLD. `OD-W7-0..10` are OPEN owner decisions —
 * see
 * `docs/development/attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md`
 * §3 row W7-R10, §9.
 *
 * This module pins the DIRECTORY ROOTS the future W6-R5-preservation guard
 * will walk, and the reason each root is pinned. It is NOT the guard itself:
 * there is no directory walk here, no file classification, no
 * `unclaimed = 0` assertion, no reference-ban / transport-ban check. That
 * guard — Leg 0 completeness, the non-empty-domain leg, Leg (i) reference
 * ban, Leg (ii) transport ban — lands at **W7-1**, the first head at which
 * the W7 resolver's own directory (root 3 below) actually exists.
 *
 * Why the walking guard cannot land here: W7-R10's non-empty-domain leg
 * ("a pinned root resolving to zero files reds the guard, because a
 * mistyped, moved, or not-yet-created root would otherwise satisfy
 * `unclaimed = 0` vacuously") would red on THIS root set at the W7-0
 * baseline (`f364c7f9b3`), because the design-lock's own §1.4 states plainly
 * "There is no group-policy -> frozen-context resolver anywhere in the
 * tree; no candidate implementation exists to 'migrate'" — root 3 resolves
 * to zero files today, by construction, until W7-1 creates it. Landing the
 * walking guard in W7-0 would therefore either (a) red on a root that is
 * supposed to be empty right now, which is not a real defect, or (b) omit
 * root 3 to keep W7-0 green, which reproduces exactly the same shape as
 * W7-R10's stated defect (a root nobody's guard actually covers). Recording
 * the root set now, with `presentAtW7Zero` on each entry, lets W7-1's
 * non-empty-domain leg key off this record instead of re-deriving which
 * roots are "new" versus "already real".
 *
 * Pinning ROOTS, not a file list, is the shape W7-R10 requires — deliberately
 * mirroring the P16 DML inventory's DERIVED scan domain
 * (`discoverRuntimeRoots` -> `listAllFiles` -> `isScannablePath`,
 * `scripts/attendance/w4c0-dml-inventory/collector.cjs:53,104,574,807-823`),
 * not P16's exact-allowlist CLAIM side
 * (`scripts/attendance/w4c0-dml-inventory/curated-debt-entries.cjs:74`). A
 * hand-maintained file list is the exact defect an earlier draft of the
 * W7-R10 row had: "a helper module outside the list walked straight
 * through it."
 */

export interface AttendanceW7GuardRootV1 {
  /** Directory glob root — NOT an individual file path. Walked recursively
   *  by the (future, W7-1) guard under a scannable-extension filter. */
  readonly root: string
  /** Why this root is in the walked domain (W7-R10 Leg 0 completeness). */
  readonly reason: string
  /**
   * Whether this root already contains any files at the W7-0 baseline
   * (`origin/main@f364c7f9b3`). W7-1's non-empty-domain leg must assert
   * `true` for every root before `unclaimed = 0` can mean anything; this
   * field lets that assertion key off a recorded fact rather than
   * re-deriving it, and flags which root is EXPECTED to flip from `false`
   * to `true` exactly when W7-1 lands (the resolver directory itself).
   * Recorded as a point-in-time fact about the W7-0 baseline, not a claim
   * about any later commit.
   */
  readonly presentAtW7Zero: boolean
}

export const ATTENDANCE_W7_W6R5_GUARD_ROOTS_V1: readonly AttendanceW7GuardRootV1[] = Object.freeze([
  Object.freeze({
    root: 'plugins/plugin-attendance/**',
    reason:
      'The legacy production frozen-context builder and per-user resolvers live here ' +
      '(buildW4ShadowFrozenContextV1 def index.cjs:22625, literal :22740-22750; ' +
      'resolveW4LiveCandidateInTransactionV1 / resolveW4ScheduledCandidateInTransactionV1 ' +
      'index.cjs:22593-22620), plus the W3 shift-service capability flag ' +
      '(attendance-shift-service.cjs:60,495,1208) and the single fixed-schedule-effectiveness ' +
      'derivation service (the FSER lib the design-lock §1.2 names). Under OD-W7-9 ' +
      "REPLACE (the design-lock's exposed slice-boundary reading, §7), the posture branch " +
      'sits immediately upstream of this builder; under LAYER-ONTO it sits inside this ' +
      "builder's own seam. Either way this root is where a group-policy reference or an " +
      'HTTP call to the W6 aggregate route could land on the plugin side, so it stays in the ' +
      'walked domain regardless of which OD-W7-9 branch W7-1 implements.',
    presentAtW7Zero: true,
  } as const),
  Object.freeze({
    root: 'packages/core-backend/src/attendance/**',
    reason:
      'Every landed W4C machinery module the design-lock §1.3/§2.2 lists as reused-not-redefined ' +
      '(rollout control, w4c0 posture minting, zero-bypass inventory, request-snapshot 8-cell ' +
      'precondition, w4c4 shadow ledger/detail, w4c2 outbox and scheduled-run identity, manual ' +
      'override/recompute) lives here, alongside this W7-0 contract module set itself and the W6-1 ' +
      "types-only contract module (see the W6 design lock's own §1.2 file inventory) that a " +
      'resolver could, incorrectly, import as a live dependency instead of reading persisted facts ' +
      'directly (the exact W6-R5/W7-R10 violation this guard exists to catch).',
    presentAtW7Zero: true,
  } as const),
  Object.freeze({
    root: 'packages/core-backend/src/attendance/w7-resolver/**',
    reason:
      "The OD-W7-1(a) in-transaction group-policy resolver's own future directory — the single " +
      'most direct place a W6-aggregate module reference or an HTTP call to its route could land, ' +
      'so it must be in the walked domain from the moment it exists, not added as an afterthought. ' +
      'Does not exist at the W7-0 baseline (design-lock §1.4: "no group-policy -> frozen-context ' +
      'resolver anywhere in the tree"); this is a NAMED PLACEHOLDER path, not a ratified directory ' +
      "layout decision — if W7-1 instead lands the resolver as a flat file directly under root 2 " +
      "above (matching every existing w4cN module's own flat-file convention), this entry becomes " +
      'redundant with root 2 and can be dropped without narrowing the walked domain. Recorded now ' +
      "only because the design-lock's W7-R10 row names a third, distinct root; the exact string is " +
      "provisional, the ROOT-not-FILE-LIST discipline and the reason for pinning a third root are " +
      'not.',
    presentAtW7Zero: false,
  } as const),
] as const)
