/**
 * W4C-2 authoritative-entrypoint delivery declaration (Gate D closure, PR #4839 owner completion
 * gate, 20260810).
 *
 * BACKGROUND: `w4c2-live-scheduled-boundary.ts` ORIGINALLY failed closed with
 * `W4C2_AUTHORITATIVE_MODE_NOT_
 * DELIVERED` (HTTP 503) at three call sites — one inside `executeLivePunch` (the `live_
 * punch` command kind), two inside `executeScheduledRunInternal` (the `scheduled` command kind's
 * org-wide probe and its per-target loop; both are the SAME command kind per that module's own
 * header). Nothing stopped an org from being promoted to `authoritative` even though the
 * write it would need was undelivered — the owner's Gate D. This module is the single, static,
 * closed-enumeration declaration the canonical transition boundary
 * (`w4c3a-rollout-control.ts`) reads to refuse that promotion.
 *
 * Gate D2 (#4556 / #4844) shipped the `live_punch` writer and removed its ONE refusal site, moving
 * the declaration to `{live_punch:true, scheduled:false}` in that same reviewed change. Gate D3
 * (#4556 / #4844) then shipped the `scheduled` writer and removed BOTH of its sites — the org-wide
 * probe (now a routing fall-through into the durable run registry) and the per-target loop (now the
 * real writer) — so ZERO refusal sites remain in that file and the declaration is
 * `{live_punch:true, scheduled:true}`. Each flip landed in lockstep with its own site removals,
 * which is exactly what the correspondence test requires.
 *
 * READ THIS BEFORE TRUSTING THE CORRESPONDENCE TEST AS A BEHAVIOURAL GUARD: with both entrypoints
 * delivered, the Gate D describe-block in that test is a ZERO-VERSUS-ZERO identity on real content.
 * Its remaining discriminating power lives entirely in the SYNTHETIC decoys it now carries (a
 * reintroduced refusal site inside a mapped function; a refusal site inside an unmapped function).
 * The behavioural pins for "the writers really are wired" are the real-DB zero-invocation
 * legacy-adapter spies and the probe-routing legs, not this declaration.
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
 * The shipped declaration. Flip a key to `true` ONLY in the same reviewed change that:
 *   (a) ships a real writer for that command kind, and
 *   (b) removes every `boundaryFail('W4C2_AUTHORITATIVE_MODE_NOT_DELIVERED', ...)` call site
 *       for that command kind in `w4c2-live-scheduled-boundary.ts` (`live_punch`: 1 site;
 *       `scheduled`: 2 sites — see the correspondence test for the exact count).
 * Never flip a key to `true` as a standalone change "to unblock rollout" — the correspondence
 * test exists precisely to fail that change.
 *
 * `live_punch` is `true` as of Gate D2 (#4556 / #4844): the boundary's `executeLivePunch` now
 * carries the real authoritative writer and its single refusal call site is gone, so the
 * correspondence guard's expected weight and the source's actual count moved 1 -> 0 in lockstep.
 *
 * `scheduled` is `true` as of Gate D3 (#4556 / #4844): `executeScheduledRunInternal` carries the
 * real authoritative per-target writer, and BOTH of its refusal call sites are gone — the org-wide
 * probe's arm became a routing fall-through into the durable run registry, and the per-target arm
 * became the writer. Its weight and actual count moved 2 -> 0 in the same lockstep.
 *
 * The UNDELIVERED count is therefore 0, which is Gate D's intended exit condition: the
 * `w4c3a-rollout-control.ts` promotion refusal keyed on this count no longer fires. Promotion to
 * `authoritative` remains gated by every OTHER rollout control plus the owner-actioned exact-org
 * `ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED` allowlist, which is unset in production — so
 * delivering both writers is byte-neutral for every production org.
 */
const DECLARED_DELIVERED: Readonly<Record<AttendanceW4C2AuthoritativeEntrypointV1, boolean>> =
  Object.freeze({
    live_punch: true,
    scheduled: true,
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
