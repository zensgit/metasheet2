/**
 * Attendance settlement coordination — the dedicated two-int4 advisory key and the org lexical
 * it is derived from.
 *
 * Key shape: `(SETTLEMENT_COORDINATION_KEY1, key2)`, where `key2` is the first four bytes of
 * SHA-256("metasheet2:attendance:settlement-coordination:v1" NUL orgLexical), read as a
 * big-endian signed int4. Two-int4 advisory keys live in a different lock space from the
 * single-bigint keys used by the W4 classes (`pg_locks.objsubid` 2 versus 1), so they cannot
 * collide with them.
 *
 * Org lexical — ONE canonicalization for every caller. Two callers that normalize the same org
 * differently would silently derive different keys and lose mutual exclusion, so inputs that are
 * not already in canonical form are rejected rather than repaired:
 *   - canonical orgs (RFC 4122 UUID syntax, or the exact sentinel `default`) go through the
 *     class-00 lexical parser, so an uppercase UUID yields the same key as its lowercase form and
 *     the dedicated key and the class-00 key always agree on which org they mean;
 *   - any other org is a legacy org and is used as-is, but only if it is non-empty, carries no
 *     NUL, has no leading or trailing whitespace, and is at most 256 characters. The request-row
 *     classifier already returns trimmed org values, so its output passes; a caller that hands in
 *     an untrimmed raw value fails loudly instead of deriving a second key for the same org.
 *
 * Nothing here talks to the database.
 */
import { createHash } from 'node:crypto'

import { parseCanonicalAttendanceRolloutOrgKeyV1 } from '../w4c0-identity'

/** `0x4D533243` ("MS2C"). Reserved: no other caller may use this value as a two-int4 key1. */
export const SETTLEMENT_COORDINATION_KEY1 = 0x4d533243
export const SETTLEMENT_COORDINATION_KEY2_PREFIX = 'metasheet2:attendance:settlement-coordination:v1'
export const SETTLEMENT_COORDINATION_LEGACY_ORG_MAX_LENGTH = 256

export class AttendanceCoordinationKeyError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'AttendanceCoordinationKeyError'
    this.code = code
  }
}

export type SettlementCoordinationOrgKindV1 = 'canonical' | 'legacy'

export interface SettlementCoordinationOrgLexicalV1 {
  readonly lexical: string
  /** `canonical` orgs also take the class-00 family; legacy orgs never do. */
  readonly kind: SettlementCoordinationOrgKindV1
}

export interface SettlementCoordinationKeyV1 {
  readonly org: SettlementCoordinationOrgLexicalV1
  readonly key1: number
  readonly key2: number
}

function isCanonicalOrgLexical(input: string): string | null {
  try {
    return parseCanonicalAttendanceRolloutOrgKeyV1(input) as unknown as string
  } catch {
    return null
  }
}

export function canonicalizeSettlementCoordinationOrgV1(input: unknown): SettlementCoordinationOrgLexicalV1 {
  if (typeof input !== 'string') throw new AttendanceCoordinationKeyError('ATTENDANCE_COORDINATION_ORG_INVALID')
  const canonical = isCanonicalOrgLexical(input)
  if (canonical !== null) return Object.freeze({ lexical: canonical, kind: 'canonical' as const })
  if (
    input.length < 1 ||
    input.length > SETTLEMENT_COORDINATION_LEGACY_ORG_MAX_LENGTH ||
    input.includes('\u0000') ||
    input.trim() !== input
  ) {
    throw new AttendanceCoordinationKeyError('ATTENDANCE_COORDINATION_ORG_INVALID')
  }
  return Object.freeze({ lexical: input, kind: 'legacy' as const })
}

export function deriveSettlementCoordinationKey2V1(orgLexical: string): number {
  const digest = createHash('sha256')
    .update(Buffer.concat([
      Buffer.from(SETTLEMENT_COORDINATION_KEY2_PREFIX, 'utf8'),
      Buffer.from([0]),
      Buffer.from(orgLexical, 'utf8'),
    ]))
    .digest()
  return digest.readInt32BE(0)
}

export function buildSettlementCoordinationKeyV1(org: unknown): SettlementCoordinationKeyV1 {
  const lexical = canonicalizeSettlementCoordinationOrgV1(org)
  return Object.freeze({
    org: lexical,
    key1: SETTLEMENT_COORDINATION_KEY1,
    key2: deriveSettlementCoordinationKey2V1(lexical.lexical),
  })
}

/**
 * Registry of every two-int4 advisory key1 that is a constant (a literal, or `hashtext()` of a
 * literal). Entries must be pairwise distinct; the coordination key1 must differ from every
 * other entry. The guard test derives the population from source and fails when a constant-key1
 * user is missing here, so this list cannot silently go stale.
 */
export const ADVISORY_FIXED_KEY1_REGISTRY: ReadonlyArray<Readonly<{
  name: string
  key1: Readonly<{ literal: number } | { hashtext: string }>
  source: string
}>> = Object.freeze([
  Object.freeze({
    name: 'attendance-settlement-coordination',
    key1: Object.freeze({ literal: SETTLEMENT_COORDINATION_KEY1 }),
    source: 'packages/core-backend/src/attendance/coordination/settlement-coordination-key.ts',
  }),
  Object.freeze({
    name: 'audit-logs-partition',
    key1: Object.freeze({ hashtext: 'audit_logs_partition' }),
    source: 'packages/core-backend/src/audit/AuditRepository.ts',
  }),
])
