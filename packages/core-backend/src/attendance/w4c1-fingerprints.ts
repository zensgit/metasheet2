/**
 * W4C-1 (#4556) — source-definition fingerprint (lock 7.3 column
 * `source_definition_fingerprint`; section 8.1 step 7: after re-running
 * attribution/context selection from the transaction snapshot, prepare
 * requires candidate identity plus source-definition fingerprint equality).
 *
 * The fingerprint covers the frozen SOURCE DEFINITION of a calculation — the
 * resolved attribution (minus the operational audit time `resolvedAt`, which a
 * legitimate re-resolution regenerates) plus the full frozen context. Any
 * current-policy drift (grace, rounding, thresholds, segments, timezone,
 * shift) between freeze and re-read changes this hash, so a "reread current
 * context" mutation can never silently satisfy the equality gate.
 *
 * Nullable only for the unsupported-attribution review posture (lock 7.3).
 * Semantic/provenance fingerprints stay in `w4c0-fingerprints.ts`; this module
 * adds only the third, source-definition domain.
 */
import crypto from 'node:crypto'
import { canonicalAttendanceJsonV1 } from './w4c0-fingerprints'

export class AttendanceW4SourceDefinitionFingerprintError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'AttendanceW4SourceDefinitionFingerprintError'
    this.code = code
  }
}

function fail(code: string): never {
  throw new AttendanceW4SourceDefinitionFingerprintError(code)
}

const SOURCE_DEFINITION_DOMAIN = 'metasheet2:attendance:w4:source-definition-fingerprint:v1'
// W4C-2 gate3 P2-1 closure (#4612 self-report ⑥, second round): a SEPARATE
// domain separator for the outer-vs-inner COMPARISON fingerprint (below) —
// it projects out an additional field the storage fingerprint does not, so
// it must never collide with `SOURCE_DEFINITION_DOMAIN`'s hash space.
const OUTER_COMPARABLE_SOURCE_DEFINITION_DOMAIN =
  'metasheet2:attendance:w4:outer-comparable-source-definition-fingerprint:v1'

function projectAttributionValue(value: Record<string, unknown>, excludeKeys: ReadonlySet<string>): Record<string, unknown> {
  const projected: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    if (excludeKeys.has(key)) continue
    projected[key] = value[key]
  }
  return projected
}

function sourceDefinitionInputOrNull(
  input: unknown,
): { attribution: Record<string, unknown>; context: unknown; value: Record<string, unknown> } | null | 'invalid' {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return 'invalid'
  const fields = input as Record<string, unknown>
  const own = Object.getOwnPropertyNames(fields)
  if (own.length !== 2 || !('attribution' in fields) || !('context' in fields)) return 'invalid'
  const attribution = fields.attribution
  const context = fields.context
  if (typeof attribution !== 'object' || attribution === null) return 'invalid'
  const posture = (attribution as { posture?: unknown }).posture
  if (posture === 'unsupported') return null
  if (posture !== 'resolved_v2') return 'invalid'
  if (context === null) return null
  const value = (attribution as { value?: unknown }).value
  if (typeof value !== 'object' || value === null) return 'invalid'
  return { attribution: attribution as Record<string, unknown>, context, value: value as Record<string, unknown> }
}

/**
 * `null` only for the unsupported-attribution posture or an absent frozen
 * context (the unsupported review row); otherwise a 64-hex SHA-256 over the
 * domain-separated canonical JSON of `{attribution (sans resolvedAt), context}`.
 *
 * This is the STORAGE domain (`attendance_record_calculations.source_definition_
 * fingerprint`) — a single read, never compared against another read. Do not
 * reuse it for an outer-vs-inner EQUALITY gate; see
 * `computeAttendanceOuterComparableSourceDefinitionFingerprintV1` below for why
 * that needs a narrower domain.
 */
export function computeAttendanceSourceDefinitionFingerprintV1(input: unknown): string | null {
  const parsed = sourceDefinitionInputOrNull(input)
  if (parsed === 'invalid') fail('W4C1_SOURCE_DEFINITION_INPUT_INVALID')
  if (parsed === null) return null
  const projected = projectAttributionValue(parsed.value, new Set(['resolvedAt']))
  const canonical = canonicalAttendanceJsonV1({
    attribution: { posture: 'resolved_v2', value: projected },
    context: parsed.context,
  })
  return crypto
    .createHash('sha256')
    .update(
      Buffer.concat([
        Buffer.from(SOURCE_DEFINITION_DOMAIN, 'utf8'),
        Buffer.from([0]),
        Buffer.from(canonical, 'utf8'),
      ]),
    )
    .digest('hex')
}

/**
 * W4C-2 gate3 P2-1 closure (#4612 self-report ⑥, second round) — lock §8.2
 * step 7's OUTER-vs-INNER "source-definition fingerprint equality" clause.
 *
 * Same `{attribution, context}` input and the same nullability contract as
 * `computeAttendanceSourceDefinitionFingerprintV1`, but ALSO projects out
 * `reasonCode` (in addition to `resolvedAt`) — discovered empirically
 * (`attendance-w4c2-p2-1-canonical-freeze-anchor.db.test.ts` "Group E /
 * eDay2", zero-concurrency false-positive before this exclusion existed):
 * the lock's own §8.2 step ordering runs the legacy write (step 3) BEFORE
 * candidate re-resolution (step 4) in the SAME transaction, and the W2
 * resolver's `openPreviousMatches` branch (`selectAmongMatchingCandidates`)
 * can match against an open `attendance_records` row THIS SAME OPERATION'S
 * OWN step-3 write just created — producing a DIFFERENT `reasonCode`
 * (`OPEN_PREVIOUS_NIGHT_RECORD` vs `PREVIOUS_NIGHT_CONTAINING_SHIFT`) than
 * the route's pre-transaction (outer) read could ever see, with ZERO
 * concurrency and the SAME resulting `workDate`/`shiftId`. `reasonCode`
 * describes WHY a candidate won a tie-break, not WHICH candidate won (the
 * identity conjunct already covers "which") or what POLICY produced it
 * (grace/rounding/thresholds/segments/timezone/shift — what this fingerprint
 * domain is for) — excluding it from the OUTER-VS-INNER comparison is
 * therefore principled, not a weakening for convenience. The STORAGE
 * fingerprint (above) is UNCHANGED and still includes `reasonCode` — this is
 * a second, narrower comparison domain, not a redefinition of the first.
 */
export function computeAttendanceOuterComparableSourceDefinitionFingerprintV1(input: unknown): string | null {
  const parsed = sourceDefinitionInputOrNull(input)
  if (parsed === 'invalid') fail('W4C1_SOURCE_DEFINITION_INPUT_INVALID')
  if (parsed === null) return null
  const projected = projectAttributionValue(parsed.value, new Set(['resolvedAt', 'reasonCode']))
  const canonical = canonicalAttendanceJsonV1({
    attribution: { posture: 'resolved_v2', value: projected },
    context: parsed.context,
  })
  return crypto
    .createHash('sha256')
    .update(
      Buffer.concat([
        Buffer.from(OUTER_COMPARABLE_SOURCE_DEFINITION_DOMAIN, 'utf8'),
        Buffer.from([0]),
        Buffer.from(canonical, 'utf8'),
      ]),
    )
    .digest('hex')
}
