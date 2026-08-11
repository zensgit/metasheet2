/**
 * W4C-2 authoritative-entrypoint delivery declaration (Gate D closure, PR #4839 owner completion
 * gate, 20260810).
 *
 * BACKGROUND: `w4c2-live-scheduled-boundary.ts` fails closed with `W4C2_AUTHORITATIVE_MODE_NOT_
 * DELIVERED` (HTTP 503) at three call sites today — one inside `executeLivePunch` (the `live_
 * punch` command kind), two inside `executeScheduledRunInternal` (the `scheduled` command kind's
 * org-wide probe and its per-target loop; both are the SAME command kind per that module's own
 * header). Nothing today stops an org from being promoted to `authoritative` even though the
 * write it would need is undelivered — the owner's Gate D. This module is the single, static,
 * closed-enumeration declaration the canonical transition boundary
 * (`w4c3a-rollout-control.ts`) reads to refuse that promotion.
 *
 * WHAT THIS MODULE DOES NOT DO: it does not probe, does not import, and has no runtime
 * dependency on `w4c2-live-scheduled-boundary.ts`. It is a LEAF — zero imports from any W4C-2/
 * W4C-3 module — specifically so the ops CLI (which never runs plugin `activate` and therefore
 * never sees anything the plugin injects at runtime) reads the exact same static value the
 * server process does. A runtime-injected or dynamically-computed registry here would silently
 * disagree between those two processes; a `const` cannot.
 *
 * DECLARATION-VS-CODE CORRESPONDENCE: this module's declared per-key delivery state is checked
 * against the ACTUAL refusal-call-site count in `w4c2-live-scheduled-boundary.ts` by a dedicated
 * mechanical test in `__tests__/w4c3a-rollout-control-inventory.test.ts` (not here — this module
 * has no filesystem/git access, deliberately, to stay a pure leaf). Flipping either key to
 * `true` without removing the matching `boundaryFail('W4C2_AUTHORITATIVE_MODE_NOT_DELIVERED', ...)`
 * call(s) in that other file is caught by that test, not by this one.
 *
 * Values-free discipline: this module exposes only booleans/counts keyed by a closed enum —
 * never an org id, never a caller value.
 */

export const ATTENDANCE_W4C2_AUTHORITATIVE_ENTRYPOINTS_V1 = Object.freeze([
  'live_punch',
  'scheduled',
] as const)

export type AttendanceW4C2AuthoritativeEntrypointV1 =
  (typeof ATTENDANCE_W4C2_AUTHORITATIVE_ENTRYPOINTS_V1)[number]

/**
 * The shipped declaration. Both keys are `false` today: no authoritative writer exists for
 * either command kind, and `w4c2-live-scheduled-boundary.ts` fails closed at all three call
 * sites unconditionally. Flip a key to `true` ONLY in the same reviewed change that:
 *   (a) ships a real writer for that command kind, and
 *   (b) removes every `boundaryFail('W4C2_AUTHORITATIVE_MODE_NOT_DELIVERED', ...)` call site
 *       for that command kind in `w4c2-live-scheduled-boundary.ts` (`live_punch`: 1 site;
 *       `scheduled`: 2 sites — see the correspondence test for the exact count).
 * Never flip a key to `true` as a standalone change "to unblock rollout" — the correspondence
 * test exists precisely to fail that change.
 */
const DECLARED_DELIVERED: Readonly<Record<AttendanceW4C2AuthoritativeEntrypointV1, boolean>> =
  Object.freeze({
    live_punch: false,
    scheduled: false,
  })

// ---------------------------------------------------------------------------
// Test seam. Not imported by production wiring — mirrors the existing seam idiom in
// w4c3a-rollout-control.ts (__setW4C3aRolloutControlAfterExclusiveLockForTests et al.): a
// module-level override, `null` by default, that production code paths never call the setter
// for. Partial: a test may override just one key and let the other fall through to the real
// shipped declaration.
// ---------------------------------------------------------------------------
let overrideForTests: Partial<Record<AttendanceW4C2AuthoritativeEntrypointV1, boolean>> | null = null

/** Test-only. Not imported by production wiring. Pass `null` to restore the shipped declaration. */
export function __setAttendanceW4C2AuthoritativeDeliveryOverrideForTests(
  override: Partial<Record<AttendanceW4C2AuthoritativeEntrypointV1, boolean>> | null,
): void {
  overrideForTests = override
}

function resolvedDelivered(key: AttendanceW4C2AuthoritativeEntrypointV1): boolean {
  if (overrideForTests !== null && Object.prototype.hasOwnProperty.call(overrideForTests, key)) {
    return overrideForTests[key] === true
  }
  return DECLARED_DELIVERED[key] === true
}

export function isAttendanceW4C2AuthoritativeEntrypointDeliveredV1(
  key: AttendanceW4C2AuthoritativeEntrypointV1,
): boolean {
  return resolvedDelivered(key)
}

/**
 * Mechanical over the exported enumeration, never a hand-maintained count — a future third
 * entrypoint added to `ATTENDANCE_W4C2_AUTHORITATIVE_ENTRYPOINTS_V1` with no matching production
 * wiring is undelivered by construction (it cannot appear in `DECLARED_DELIVERED` as `true`
 * without a reviewer explicitly adding it there).
 */
export function attendanceW4C2UndeliveredAuthoritativeEntrypointCountV1(): number {
  return ATTENDANCE_W4C2_AUTHORITATIVE_ENTRYPOINTS_V1.filter((key) => !resolvedDelivered(key)).length
}
