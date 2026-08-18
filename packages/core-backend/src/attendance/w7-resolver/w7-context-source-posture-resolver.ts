/**
 * W7-1a (#4556) STEP 1 — runtime context-source posture resolver.
 *
 * Authority: `docs/development/attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md`
 * §4.2 (the two-part posture-read contract), §7 OD-W7-3(a), red line W7-R4.
 * Ratified per #4556 comments 5293034619 (owner-directed disclosed relay) + 5293478713 (owner first-person confirmation) —
 * ruling 2 (OD-W7-1..8 = option (a)) and
 * ruling 7 (a NEW W7-specific allowlist env var, exact org,
 * `scope='synthetic_staging'`, no wildcard).
 *
 * STRUCTURALLY INERT (W7-1a): nothing in the production runtime graph imports
 * this module. Its inertness rests on three independent legs, none of which is
 * the `IMPLEMENTATION_CAPABILITY` constant below:
 *   (1) zero production import sites and zero call sites (mechanical sweep,
 *       `tests/unit/attendance-w7-1a-inertness-sweep.test.ts`);
 *   (2) `attendance_calculation_context_source_state` ships EMPTY
 *       (`zzzz20260814120000_w7_attendance_context_source_posture_state.ts`),
 *       and no row ⇒ `off`;
 *   (3) `ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED` is unset by default, and an
 *       allowlist entry alone never advertises a posture either.
 * Capability is `true` here for the same reason W4C-0 set its own to `true`
 * at the equivalent inert slice (`w4c0-identity.ts:361`): the resolver seam
 * IS implemented, and resting inertness on a capability constant would make
 * the ruling-7 positive control unbuildable without mutating a constant.
 *
 * SHAPE IS CLONED, NOT REUSED, from `resolveSegmentCalculationPosture`
 * (`../w4c0-identity.ts:454`). This is a SECOND, independent org posture
 * (OD-W7-3(a)); an org has two postures, each independently gated by its own
 * row-plus-allowlist read. Nothing here reads or writes the W4 machine.
 */
import {
  parseCanonicalAttendanceRolloutOrgKeyV1,
  type AttendanceW4TransactionClientV1,
  type CanonicalAttendanceRolloutOrgKeyV1,
} from '../w4c0-identity'
import {
  ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1,
  resolveAttendanceW7ContextSourcePostureFromPartsV1,
  type AttendanceW7ContextSourcePostureStateV1,
} from '../w7-context-source-posture-contract'

// ---------------------------------------------------------------------------
// Values-free error type + the three W7 product codes.
// ---------------------------------------------------------------------------

/**
 * Every throw carries a closed `code` string only — never the offending input
 * bytes (the W4C-0 error discipline, `w4c0-identity.ts` header).
 */
export class AttendanceW7ContextSourceError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'AttendanceW7ContextSourceError'
    this.code = code
  }
}

/**
 * The three W7-0 P3-2 carry-forwards. The W7-0 PURE contract
 * (`resolveAttendanceW7ContextSourcePostureFromPartsV1`) structurally CANNOT
 * hold these: its input type declares a single row whose `state` is already
 * the valid union and whose `scope` is already the literal
 * `'synthetic_staging'`, so all three failure cases are unreachable there.
 * This async DB-reading resolver is where they are ADDED.
 *
 * Each MUST throw. Collapsing any of them to `'off'` would make a corrupt or
 * ambiguous posture row indistinguishable from an unconfigured org, which is
 * precisely the corruption-blindness W7-R4 exists to prevent.
 */
export const ATTENDANCE_W7_CONTEXT_SOURCE_STATE_AMBIGUOUS = 'W7_CONTEXT_SOURCE_STATE_AMBIGUOUS'
export const ATTENDANCE_W7_CONTEXT_SOURCE_STATE_INVALID = 'W7_CONTEXT_SOURCE_STATE_INVALID'
export const ATTENDANCE_W7_CONTEXT_SOURCE_SCOPE_INVALID = 'W7_CONTEXT_SOURCE_SCOPE_INVALID'

function fail(code: string): never {
  throw new AttendanceW7ContextSourceError(code)
}

// ---------------------------------------------------------------------------
// The W7-specific allowlist — ruling 7.
// ---------------------------------------------------------------------------

/**
 * Ruling 7: a NEW W7-specific environment variable. Deliberately NOT
 * `ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED` (the W4 segment-calculation
 * allowlist) — coupling the two would make flipping W4 silently flip W7's
 * context source, which is a second state machine with different semantics.
 */
export const ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV = 'ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED'

/**
 * Exact org-only outer allowlist; the wildcard `*` NEVER counts. Entries are
 * comma-separated, trimmed and ASCII case-folded; empty entries are dropped.
 *
 * This is the ONE definition. The future W7 transition writer must gate on
 * `isAttendanceW7ContextSourceOrgAllowlistedV1` below — a thin named export of
 * this same private predicate, NOT a second copied allowlist mechanism. That
 * is the W4C-5 discipline (`w4c0-identity.ts:376-383`): a carrier with two
 * allowlist implementations can have them drift, and the read side and the
 * write side would then disagree about which orgs are in scope.
 */
/*
 * OPS FOOTGUN — RESOLVED (#4899 residual R4, owner-approved), superseding this
 * file's original "deferred jointly with the W4 predicate" note.
 *
 * Entries are now trimmed AND lower-cased, matching `orgKey`, which arrives
 * already lower-cased from `parseUuidSyntax` (`../w4c0-identity.ts:132`). An
 * operator who writes the org UUID in upper case —
 * `ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED=3F9A1C2E-…` — is now admitted rather
 * than getting a silent `off`.
 *
 * This is an ADMISSION WIDENING, not a tidy-up: the admitted set grows from
 * the lower-case spellings to all ASCII-case spellings of the same org keys.
 * It is bounded by construction — `toLowerCase` is a per-character map, so it
 * can only make two strings that differ in ASCII case compare equal; it never
 * shortens an entry and never turns a non-match into a prefix/substring/
 * wildcard match. `'*'`, `' * '`, `'.*'`, `'%'`, prefixes and suffixes still
 * allowlist nothing.
 *
 * The old note deferred this precisely so W7 would not diverge from the W4
 * predicate's matching semantics. That constraint is honoured: the W4 fold
 * (`../w4c0-identity.ts`, `isOrgExactlyAllowlisted`) lands in the SAME change,
 * with the same one-line transformation, so the two allowlists still agree.
 */
function isOrgExactlyAllowlisted(orgKey: string): boolean {
  const raw =
    typeof process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV] === 'string'
      ? (process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV] as string)
      : ''
  const entries = raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  // Exact membership only. `'*'` is just another entry string here, and an org
  // key can never equal `'*'` (the canonical parser rejects it), so a wildcard
  // entry allowlists nothing.
  return entries.includes(orgKey)
}

/**
 * The single allowlist predicate, named for the W7 transition writer (W7-R4).
 * A thin re-export of the one private predicate above; it reads no additional
 * env var and holds no second copy of the parsing rules.
 */
export function isAttendanceW7ContextSourceOrgAllowlistedV1(orgKey: string): boolean {
  return isOrgExactlyAllowlisted(orgKey)
}

// ---------------------------------------------------------------------------
// Opaque witness registry (module-private; membership IS the proof).
// ---------------------------------------------------------------------------

declare const W7PostureOpaque: unique symbol

export type ResolvedAttendanceW7ContextSourcePostureV1 = Readonly<{
  orgKey: CanonicalAttendanceRolloutOrgKeyV1
  effectiveState: AttendanceW7ContextSourcePostureStateV1
  persistedState: AttendanceW7ContextSourcePostureStateV1 | null
}> & { readonly [W7PostureOpaque]: 'ResolvedAttendanceW7ContextSourcePostureV1' }

const w7PostureWitnesses = new WeakSet<object>()

function frozenNullProto<T extends Record<string, unknown>>(fields: T): T {
  return Object.freeze(Object.assign(Object.create(null) as T, fields))
}

/**
 * Membership in the module-private registry is the proof that this object came
 * out of `resolveAttendanceW7ContextSourcePostureV1`. A caller cannot fabricate
 * a `group_authoritative` posture by writing an object literal inline: the
 * literal is not in the WeakSet, and serialization (JSON round-trip, spread,
 * `structuredClone`) deliberately destroys the witness.
 */
export function isResolvedAttendanceW7ContextSourcePostureV1(
  candidate: unknown,
): candidate is ResolvedAttendanceW7ContextSourcePostureV1 {
  return typeof candidate === 'object' && candidate !== null && w7PostureWitnesses.has(candidate)
}

// ---------------------------------------------------------------------------
// Implementation capability (§4.2 effective-state requirement 1).
// ---------------------------------------------------------------------------

/** See the file header: `true` mirrors the W4C-0 precedent; W7-1a's inertness
 *  does NOT rest on this constant. */
const ATTENDANCE_W7_CONTEXT_SOURCE_IMPLEMENTATION_CAPABILITY = true

// ---------------------------------------------------------------------------
// The resolver.
// ---------------------------------------------------------------------------

/**
 * Order is load-bearing.
 *
 * 1. CANONICALIZE FIRST. Both the DB query and the allowlist compare off
 *    `orgKey`, never the raw `orgId`. Validate-then-normalize is the bug: an
 *    input that is allowlisted only in its raw spelling, or that queries under
 *    one spelling while being allowlisted under another, must not be able to
 *    disagree with itself.
 * 2. Read the persisted row.
 * 3. The three hard throws (see the code constants above) — never `'off'`.
 * 4. Delegate the two-part effective-state rule to the W7-0 PURE contract
 *    rather than re-implementing it, so the async resolver and the ratified
 *    pure shape cannot diverge. By step 4 the row has been validated into
 *    exactly the shape that function's input type declares.
 */
export async function resolveAttendanceW7ContextSourcePostureV1(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
): Promise<ResolvedAttendanceW7ContextSourcePostureV1> {
  const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(orgId)

  const result = await trx.query(
    'SELECT state, scope FROM attendance_calculation_context_source_state WHERE org_id = $1',
    [orgKey],
  )

  let persistedRow: { state: AttendanceW7ContextSourcePostureStateV1; scope: 'synthetic_staging' } | null = null

  if (result.rows.length > 1) fail(ATTENDANCE_W7_CONTEXT_SOURCE_STATE_AMBIGUOUS)
  if (result.rows.length === 1) {
    const state = result.rows[0].state
    const scope = result.rows[0].scope
    if (
      typeof state !== 'string' ||
      !(ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1 as readonly string[]).includes(state)
    ) {
      fail(ATTENDANCE_W7_CONTEXT_SOURCE_STATE_INVALID)
    }
    if (scope !== 'synthetic_staging') fail(ATTENDANCE_W7_CONTEXT_SOURCE_SCOPE_INVALID)
    persistedRow = {
      state: state as AttendanceW7ContextSourcePostureStateV1,
      scope: 'synthetic_staging',
    }
  }

  const effectiveState = resolveAttendanceW7ContextSourcePostureFromPartsV1({
    persistedRow,
    implementationCapability: ATTENDANCE_W7_CONTEXT_SOURCE_IMPLEMENTATION_CAPABILITY,
    orgExactlyAllowlisted: isOrgExactlyAllowlisted(orgKey),
  })

  const witness = frozenNullProto({
    orgKey,
    effectiveState,
    persistedState: persistedRow === null ? null : persistedRow.state,
  }) as ResolvedAttendanceW7ContextSourcePostureV1
  w7PostureWitnesses.add(witness)
  return witness
}
