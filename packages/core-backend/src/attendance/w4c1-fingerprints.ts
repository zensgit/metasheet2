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

/**
 * `null` only for the unsupported-attribution posture or an absent frozen
 * context (the unsupported review row); otherwise a 64-hex SHA-256 over the
 * domain-separated canonical JSON of `{attribution (sans resolvedAt), context}`.
 */
export function computeAttendanceSourceDefinitionFingerprintV1(input: unknown): string | null {
  const code = 'W4C1_SOURCE_DEFINITION_INPUT_INVALID'
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail(code)
  const fields = input as Record<string, unknown>
  const own = Object.getOwnPropertyNames(fields)
  if (own.length !== 2 || !('attribution' in fields) || !('context' in fields)) fail(code)
  const attribution = fields.attribution
  const context = fields.context
  if (typeof attribution !== 'object' || attribution === null) fail(code)
  const posture = (attribution as { posture?: unknown }).posture
  if (posture === 'unsupported') return null
  if (posture !== 'resolved_v2') fail(code)
  if (context === null) return null
  const value = (attribution as { value?: unknown }).value
  if (typeof value !== 'object' || value === null) fail(code)
  const projected: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (key === 'resolvedAt') continue
    projected[key] = (value as Record<string, unknown>)[key]
  }
  const canonical = canonicalAttendanceJsonV1({
    attribution: { posture: 'resolved_v2', value: projected },
    context,
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
