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
 *   - any other org is a legacy org and is used as-is (no case folding, as §2 specifies), but only
 *     if it is non-empty, carries no NUL and has no leading or trailing whitespace. The request-row
 *     classifier already returns trimmed org values, so its output passes; a caller that hands in
 *     an untrimmed raw value fails loudly instead of deriving a second key for the same org. There is
 *     no length cap: `attendance_requests.org_id` is unbounded `text`.
 *
 * Nothing here talks to the database.
 */
import { createHash } from 'node:crypto'

import { parseCanonicalAttendanceRolloutOrgKeyV1 } from '../w4c0-identity'

/** `0x4D533243` ("MS2C"). Reserved: no other caller may use this value as a two-int4 key1. */
export const SETTLEMENT_COORDINATION_KEY1 = 0x4d533243
export const SETTLEMENT_COORDINATION_KEY2_PREFIX = 'metasheet2:attendance:settlement-coordination:v1'

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
  if (input.length < 1 || input.includes('\u0000') || input.trim() !== input) {
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
 * Registry of every two-int4 advisory key1 that is a constant: a literal, `hashtext()` of a literal,
 * or a fixed value passed as a bind parameter (`$1::int` with a fixed number, `hashtext($1)` with a
 * fixed string). Entries must be pairwise distinct, and only the coordination entry may equal
 * 0x4D533243. The population is closed-world: the census in
 * `tests/helpers/settlement-coordination-advisory-census.ts` must classify every two-int4 call in
 * production source, and each constant site names the entries here that its key1 can take. The
 * real-database guard computes every `hashtext` value in PostgreSQL.
 */
type AdvisoryFixedKey1V1 = Readonly<{ literal: number } | { hashtext: string }>

function fixedKey1(name: string, key1: AdvisoryFixedKey1V1, source: string) {
  return Object.freeze({ name, key1: Object.freeze({ ...key1 }), source })
}

const ELEARNING = 'packages/core-backend/src/services'

export const ADVISORY_FIXED_KEY1_REGISTRY: ReadonlyArray<Readonly<{
  name: string
  key1: AdvisoryFixedKey1V1
  source: string
}>> = Object.freeze([
  fixedKey1('attendance-settlement-coordination', { literal: SETTLEMENT_COORDINATION_KEY1 }, 'packages/core-backend/src/attendance/coordination/settlement-coordination-key.ts'),
  fixedKey1('audit-logs-partition', { hashtext: 'audit_logs_partition' }, 'packages/core-backend/src/audit/AuditRepository.ts'),
  fixedKey1('stock-preparation-project', { literal: 0x73700101 }, 'packages/core-backend/src/multitable/stock-preparation-persist-unit-of-work.ts (bind parameter)'),
  fixedKey1('stock-preparation-batch', { literal: 0x73700102 }, 'packages/core-backend/src/multitable/stock-preparation-persist-unit-of-work.ts (bind parameter)'),
  fixedKey1('multitable-pit-recovery', { literal: 0x77303104 }, 'packages/core-backend/src/multitable/canonical-sheet-fence.ts (fixed namespace; documented, no production query site today)'),
  fixedKey1('yida-initialization-slot', { literal: 0x59494441 }, 'packages/core-backend/src/integration/yida-initialization-bootstrap.ts (bind parameter)'),
  fixedKey1('stock-prep-members', { hashtext: 'stock-prep' }, 'packages/core-backend/src/services/stock-preparation-members.ts (bind parameter)'),
  fixedKey1('elearning-title-request', { hashtext: 'elearning-title-request' }, `${ELEARNING}/elearning-title-surface.ts (bind parameter)`),
  fixedKey1('elearning-title-head', { hashtext: 'elearning-title-head' }, `${ELEARNING}/elearning-title-surface.ts (bind parameter)`),
  fixedKey1('elearning-title-balance-org', { hashtext: 'elearning-title-balance-org' }, `packages/core-backend/src/db/migrations/zzzz20260830123000_create_elearning_titles.ts; ${ELEARNING}/elearning-title-surface.ts (bind parameter)`),
  fixedKey1('elearning-credit-rule-request', { hashtext: 'elearning-credit-rule-request' }, `${ELEARNING}/elearning-credit-surface.ts (bind parameter)`),
  fixedKey1('elearning-credit-rule-behavior', { hashtext: 'elearning-credit-rule-behavior' }, `${ELEARNING}/elearning-credit-surface.ts (bind parameter)`),
  fixedKey1('elearning-analytics-export-request', { hashtext: 'elearning-analytics-export-request' }, `${ELEARNING}/elearning-analytics-export.ts (bind parameter)`),
  fixedKey1('elearning-portal-request', { hashtext: 'elearning-portal-request' }, `${ELEARNING}/elearning-portal-settings.ts (bind parameter)`),
  fixedKey1('elearning-portal-head', { hashtext: 'elearning-portal-head' }, `${ELEARNING}/elearning-portal-settings.ts (bind parameter)`),
  fixedKey1('elearning-credit-adjustment-request', { hashtext: 'elearning-credit-adjustment-request' }, `${ELEARNING}/elearning-credit-adjustment-postgres.ts (bind parameter)`),
  fixedKey1('elearning-practice-set-request', { hashtext: 'elearning-practice-set-request' }, `${ELEARNING}/elearning-question-practice-postgres.ts (bind parameter)`),
  fixedKey1('elearning-practice-session-request', { hashtext: 'elearning-practice-session-request' }, `${ELEARNING}/elearning-question-practice-postgres.ts (bind parameter)`),
  fixedKey1('elearning-practice-answer-request', { hashtext: 'elearning-practice-answer-request' }, `${ELEARNING}/elearning-question-practice-postgres.ts (bind parameter)`),
  fixedKey1('elearning-practice-question-answer', { hashtext: 'elearning-practice-question-answer' }, `${ELEARNING}/elearning-question-practice-postgres.ts (bind parameter)`),
  fixedKey1('elearning-practice-wrong-projection', { hashtext: 'elearning-practice-wrong-projection' }, `${ELEARNING}/elearning-question-practice-postgres.ts (bind parameter)`),
  fixedKey1('elearning-certificate-template-request', { hashtext: 'elearning-certificate-template-request' }, `${ELEARNING}/elearning-certificate-surface.ts (bind parameter)`),
  fixedKey1('elearning-certificate-template-head', { hashtext: 'elearning-certificate-template-head' }, `${ELEARNING}/elearning-certificate-surface.ts (bind parameter)`),
  fixedKey1('elearning-certificate-issue-request', { hashtext: 'elearning-certificate-issue-request' }, `${ELEARNING}/elearning-certificate-surface.ts (bind parameter)`),
  fixedKey1('elearning-notification-delivery', { hashtext: 'elearning-notification-delivery' }, `${ELEARNING}/elearning-notification-delivery.ts (bind parameter)`),
  fixedKey1('attendance-schedule-group-member', { hashtext: 'attendance-schedule-group-member' }, 'plugins/plugin-attendance/index.cjs (bind parameter)'),
  fixedKey1('attendance-schedule-group-tree', { hashtext: 'attendance-schedule-group-tree' }, 'plugins/plugin-attendance/index.cjs (bind parameter)'),
])
