/**
 * W4C-0 (#4556) Stage C — canonical fingerprint layer (lock sections 4.1/4.2/4.3).
 *
 * One strict canonical-JSON serializer feeds every fingerprint; every fingerprint
 * domain is separated by an explicit ASCII prefix + NUL so a command fingerprint
 * can never be replayed as a sequence/set/semantic/provenance fingerprint even
 * over identical bytes.
 *
 * - `semanticInputFingerprint` hashes the semantic projection of attribution,
 *   context, ordered evidence, ordered approved facts, manual override, merge
 *   policy, tier, and engine/schema versions. Evidence/facts are ordered by the
 *   closed section 4.2 comparators INSIDE this module, so caller array order can
 *   never change the hash. Operational audit times are excluded by construction
 *   (the attribution projection strips `resolvedAt`; the closed top-level key set
 *   has no createdAt/conversion/transport/correlation position).
 * - `provenanceFingerprint` hashes exact transport metadata separately, over the
 *   closed 13-transport union with per-variant required/forbidden keys.
 *
 * Values-free error discipline: closed `code` strings only.
 */
import crypto from 'node:crypto'

export class AttendanceW4FingerprintError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'AttendanceW4FingerprintError'
    this.code = code
  }
}

function fail(code: string): never {
  throw new AttendanceW4FingerprintError(code)
}

// ---------------------------------------------------------------------------
// Strict canonical JSON (sorted keys; closed scalar domain).
// ---------------------------------------------------------------------------

/**
 * Canonical JSON over plain data only: null, boolean, finite number, string,
 * array, and plain object (null-proto or Object.prototype). `undefined`,
 * NaN/Infinity, bigint, function, symbol, class instances, and symbol keys all
 * fail closed — a missing field can never silently hash as anything.
 */
export function canonicalAttendanceJsonV1(value: unknown): string {
  const code = 'W4C0_CANONICAL_JSON_INVALID'
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) fail(code)
      return JSON.stringify(value)
    case 'string':
      return JSON.stringify(value)
    case 'object':
      break
    default:
      fail(code)
  }
  if (Array.isArray(value)) {
    return '[' + value.map((entry) => canonicalAttendanceJsonV1(entry)).join(',') + ']'
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== null && proto !== Object.prototype) fail(code)
  if (Object.getOwnPropertySymbols(value as object).length > 0) fail(code)
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const parts: string[] = []
  for (const key of keys) {
    const entry = obj[key]
    if (entry === undefined) fail(code)
    parts.push(JSON.stringify(key) + ':' + canonicalAttendanceJsonV1(entry))
  }
  return '{' + parts.join(',') + '}'
}

function domainHash(domain: string, value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(Buffer.concat([Buffer.from(domain, 'utf8'), Buffer.from([0]), Buffer.from(canonicalAttendanceJsonV1(value), 'utf8')]))
    .digest('hex')
}

const COMMAND_DOMAIN = 'metasheet2:attendance:w4:command-fingerprint:v1'
const ITEM_SEQUENCE_DOMAIN = 'metasheet2:attendance:w4:item-sequence-fingerprint:v1'
const ITEM_SET_DOMAIN = 'metasheet2:attendance:w4:item-set-fingerprint:v1'
const SEMANTIC_DOMAIN = 'metasheet2:attendance:w4:semantic-input-fingerprint:v1'
const PROVENANCE_DOMAIN = 'metasheet2:attendance:w4:provenance-fingerprint:v1'
const BUSINESS_KEY_DOMAIN = 'metasheet2:attendance:w4:business-key-fingerprint:v1'

/** Exact pre-source command fingerprint over one normalized command (lock 4.1). */
export function computeAttendanceCommandFingerprintV1(normalizedCommand: unknown): string {
  return domainHash(COMMAND_DOMAIN, normalizedCommand)
}

/** Closed outbox business-key fingerprint (lock 7.1a). */
export function computeAttendanceBusinessKeyFingerprintV1(businessKey: unknown): string {
  return domainHash(BUSINESS_KEY_DOMAIN, businessKey)
}

// ---------------------------------------------------------------------------
// Batch item sequence/set fingerprints (lock 7.1; amendment 1.3: the locked
// sequence identity is exactly (ordinal, operationId, commandFingerprint)).
// ---------------------------------------------------------------------------

export interface AttendanceOperationItemFingerprintEntryV1 {
  readonly ordinal: string
  readonly operationId: string
  readonly commandFingerprint: string
}

const LOWER_HEX_64 = /^[0-9a-f]{64}$/
const CANONICAL_ORDINAL = /^(0|[1-9][0-9]*)$/
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function normalizeSequenceEntries(
  entries: readonly AttendanceOperationItemFingerprintEntryV1[],
): Array<{ ordinal: string; operationId: string; commandFingerprint: string }> {
  const code = 'W4C0_ITEM_FINGERPRINT_ENTRY_INVALID'
  if (!Array.isArray(entries) || entries.length === 0) fail(code)
  const seenOrdinals = new Set<string>()
  return entries.map((entry) => {
    if (typeof entry !== 'object' || entry === null) fail(code)
    const { ordinal, operationId, commandFingerprint } = entry
    if (typeof ordinal !== 'string' || !CANONICAL_ORDINAL.test(ordinal)) fail(code)
    if (typeof operationId !== 'string' || !CANONICAL_UUID.test(operationId)) fail(code)
    if (typeof commandFingerprint !== 'string' || !LOWER_HEX_64.test(commandFingerprint)) fail(code)
    if (seenOrdinals.has(ordinal)) fail('W4C0_ITEM_ORDINAL_DUPLICATE')
    seenOrdinals.add(ordinal)
    return { ordinal, operationId, commandFingerprint }
  })
}

/** Exact ORDERED item-sequence fingerprint: reordering changes it. */
export function computeAttendanceItemSequenceFingerprintV1(
  entries: readonly AttendanceOperationItemFingerprintEntryV1[],
): string {
  return domainHash(ITEM_SEQUENCE_DOMAIN, normalizeSequenceEntries(entries))
}

/** Order-INSENSITIVE item-set fingerprint: reordering preserves it; add/remove/change conflicts. */
export function computeAttendanceItemSetFingerprintV1(
  entries: readonly AttendanceOperationItemFingerprintEntryV1[],
): string {
  const normalized = normalizeSequenceEntries(entries)
    .map((entry) => canonicalAttendanceJsonV1(entry))
    .sort()
  return domainHash(ITEM_SET_DOMAIN, normalized)
}

// ---------------------------------------------------------------------------
// Closed evidence/fact comparators (lock section 4.2).
// ---------------------------------------------------------------------------

const EVIDENCE_KINDS = ['punch', 'approved_adjustment', 'scheduled_absence'] as const
const FACT_KIND_RANK: Readonly<Record<string, number>> = Object.freeze({
  leave: 0,
  overtime: 1,
  correction: 2,
  outdoor_punch: 3,
  reversal: 4,
})

interface EvidenceLike {
  readonly kind: string
  readonly ref: string
  readonly direction?: string
  readonly occurredAt?: string
}

function requireString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(code)
  return value
}

/**
 * Explicit variant comparator: timed evidence by (occurredAt, direction, kind, ref),
 * then untimed scheduled_absence by (kind, ref). Missing fields never become
 * JavaScript `undefined` sort keys — they fail closed first.
 */
export function compareAttendanceEvidenceV1(a: unknown, b: unknown): number {
  const code = 'W4C0_EVIDENCE_SHAPE_INVALID'
  const left = a as EvidenceLike
  const right = b as EvidenceLike
  for (const item of [left, right]) {
    if (typeof item !== 'object' || item === null) fail(code)
    if (!(EVIDENCE_KINDS as readonly string[]).includes(item.kind)) fail(code)
    requireString(item.ref, code)
    if (item.kind !== 'scheduled_absence') {
      requireString(item.occurredAt, code)
      const direction = requireString(item.direction, code)
      if (direction !== 'check_in' && direction !== 'check_out') fail(code)
    }
  }
  const leftTimed = left.kind !== 'scheduled_absence'
  const rightTimed = right.kind !== 'scheduled_absence'
  if (leftTimed !== rightTimed) return leftTimed ? -1 : 1
  if (leftTimed) {
    const byTime = (left.occurredAt as string).localeCompare(right.occurredAt as string)
    if (byTime !== 0) return byTime
    const byDirection = (left.direction as string).localeCompare(right.direction as string)
    if (byDirection !== 0) return byDirection
  }
  const byKind = left.kind.localeCompare(right.kind)
  if (byKind !== 0) return byKind
  return left.ref.localeCompare(right.ref)
}

interface FactLike {
  readonly kind: string
  readonly requestId: string
  readonly requestSnapshotVersion: number
  readonly requestSnapshotFingerprint: string
  readonly approvalVersion: number
  readonly approvalRecordId: string
  readonly occurredAt?: string
  readonly coverage?: { readonly kind: string; readonly startAt?: string }
}

function factBusinessTime(fact: FactLike): string {
  if (typeof fact.occurredAt === 'string') return fact.occurredAt
  if (fact.coverage && fact.coverage.kind === 'bounded_interval' && typeof fact.coverage.startAt === 'string') {
    return fact.coverage.startAt
  }
  return ''
}

/**
 * Closed kind rank, then request ID, immutable snapshot version/fingerprint,
 * terminal approval version, business interval/occurrence time when present,
 * and approval-record ID (lock 4.2).
 */
export function compareApprovedAttendanceFactV1(a: unknown, b: unknown): number {
  const code = 'W4C0_FACT_SHAPE_INVALID'
  const left = a as FactLike
  const right = b as FactLike
  for (const item of [left, right]) {
    if (typeof item !== 'object' || item === null) fail(code)
    if (!Object.prototype.hasOwnProperty.call(FACT_KIND_RANK, item.kind)) fail(code)
    requireString(item.requestId, code)
    if (!Number.isInteger(item.requestSnapshotVersion)) fail(code)
    requireString(item.requestSnapshotFingerprint, code)
    if (!Number.isInteger(item.approvalVersion)) fail(code)
    requireString(item.approvalRecordId, code)
  }
  const byRank = FACT_KIND_RANK[left.kind] - FACT_KIND_RANK[right.kind]
  if (byRank !== 0) return byRank
  const byRequest = left.requestId.localeCompare(right.requestId)
  if (byRequest !== 0) return byRequest
  if (left.requestSnapshotVersion !== right.requestSnapshotVersion) {
    return left.requestSnapshotVersion - right.requestSnapshotVersion
  }
  const byFingerprint = left.requestSnapshotFingerprint.localeCompare(right.requestSnapshotFingerprint)
  if (byFingerprint !== 0) return byFingerprint
  if (left.approvalVersion !== right.approvalVersion) return left.approvalVersion - right.approvalVersion
  const byTime = factBusinessTime(left).localeCompare(factBusinessTime(right))
  if (byTime !== 0) return byTime
  return left.approvalRecordId.localeCompare(right.approvalRecordId)
}

export function sortAttendanceEvidenceV1<T>(evidence: readonly T[]): T[] {
  if (!Array.isArray(evidence)) fail('W4C0_EVIDENCE_SHAPE_INVALID')
  // Validate every element even when Array#sort would not call the comparator
  // (0/1-element arrays): a malformed single item must still fail closed.
  for (const entry of evidence) compareAttendanceEvidenceV1(entry, entry)
  return [...evidence].sort((a, b) => compareAttendanceEvidenceV1(a, b))
}

export function sortApprovedAttendanceFactsV1<T>(facts: readonly T[]): T[] {
  if (!Array.isArray(facts)) fail('W4C0_FACT_SHAPE_INVALID')
  for (const entry of facts) compareApprovedAttendanceFactV1(entry, entry)
  return [...facts].sort((a, b) => compareApprovedAttendanceFactV1(a, b))
}

// ---------------------------------------------------------------------------
// Semantic input fingerprint (lock section 4.3).
// ---------------------------------------------------------------------------

const SEMANTIC_INPUT_KEYS = [
  'attribution',
  'context',
  'evidence',
  'approvedFacts',
  'manualOverride',
  'mergePolicy',
  'calculationTier',
  'engineVersion',
  'snapshotSchemaVersion',
] as const

function requireExactKeys(input: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail(code)
  const obj = input as Record<string, unknown>
  if (Object.getOwnPropertySymbols(obj).length > 0) fail(code)
  const own = Object.getOwnPropertyNames(obj)
  if (own.length !== keys.length) fail(code)
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) fail(code)
  }
  return obj
}

/**
 * Projects the attribution snapshot to its semantic content: for `resolved_v2`
 * the operational audit field `resolvedAt` is stripped (section 4.3 exclusion
 * list); every business time (workDate, windows, tail policy, evidence
 * fingerprint) remains. The `unsupported` posture is already purely semantic.
 */
function projectSemanticAttribution(attribution: unknown): unknown {
  const code = 'W4C0_SEMANTIC_ATTRIBUTION_INVALID'
  if (typeof attribution !== 'object' || attribution === null) fail(code)
  const posture = (attribution as { posture?: unknown }).posture
  if (posture === 'resolved_v2') {
    const outer = requireExactKeys(attribution, ['posture', 'value'], code)
    const value = outer.value
    if (typeof value !== 'object' || value === null) fail(code)
    const projected: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (key === 'resolvedAt') continue
      projected[key] = (value as Record<string, unknown>)[key]
    }
    return { posture: 'resolved_v2', value: projected }
  }
  if (posture === 'unsupported') return attribution
  fail(code)
}

/**
 * `semanticInputFingerprint` (lock 4.3). Requires EXACTLY the nine closed keys;
 * orders evidence/approved facts with the section 4.2 comparators internally.
 */
export function computeAttendanceSemanticInputFingerprintV1(input: unknown): string {
  const code = 'W4C0_SEMANTIC_INPUT_INVALID'
  const fields = requireExactKeys(input, SEMANTIC_INPUT_KEYS, code)
  if (!Array.isArray(fields.evidence) || !Array.isArray(fields.approvedFacts)) fail(code)
  const projection = {
    attribution: projectSemanticAttribution(fields.attribution),
    context: fields.context ?? null,
    evidence: sortAttendanceEvidenceV1(fields.evidence),
    approvedFacts: sortApprovedAttendanceFactsV1(fields.approvedFacts),
    manualOverride: fields.manualOverride ?? null,
    mergePolicy: fields.mergePolicy,
    calculationTier: fields.calculationTier,
    engineVersion: fields.engineVersion,
    snapshotSchemaVersion: fields.snapshotSchemaVersion,
  }
  return domainHash(SEMANTIC_DOMAIN, projection)
}

// ---------------------------------------------------------------------------
// Provenance fingerprint (lock section 4.3): closed 13-transport union with
// per-variant required/forbidden metadata keys.
// ---------------------------------------------------------------------------

export const ATTENDANCE_INPUT_PROVENANCE_TRANSPORTS_V1 = Object.freeze([
  'live_event',
  'rows',
  'csv_text',
  'csv_upload',
  'xlsx_client_converted_csv',
  'integration_sync',
  'approved_request',
  'scheduled_job',
  'recompute',
  'approval_reversal',
  'import_rollback',
  'operator_retirement',
  'legacy_baseline_capture',
] as const)
export type AttendanceInputProvenanceTransportV1 = (typeof ATTENDANCE_INPUT_PROVENANCE_TRANSPORTS_V1)[number]

// Per-variant required/forbidden matrix over the closed metadata keys.
// (Field naming per lock 4.3 prose: artifact SHA-256, normalized CSV SHA-256,
// converted sheet name, source reference.)
const ARTIFACT_SHA_REQUIRED: ReadonlySet<string> = new Set(['csv_upload', 'xlsx_client_converted_csv'])
const NORMALIZED_CSV_SHA_REQUIRED: ReadonlySet<string> = new Set([
  'csv_text',
  'csv_upload',
  'xlsx_client_converted_csv',
])
const CONVERTED_SHEET_REQUIRED: ReadonlySet<string> = new Set(['xlsx_client_converted_csv'])

export interface AttendanceInputProvenanceRefV1 {
  readonly transport: AttendanceInputProvenanceTransportV1
  readonly sourceRef: string
  readonly artifactSha256: string | null
  readonly normalizedCsvSha256: string | null
  readonly convertedSheetName: string | null
}

/**
 * Validates the closed transport union (unknown or inapplicable non-null keys
 * fail closed) and hashes the exact transport metadata separately from the
 * semantic fingerprint. Equivalent native CSV and client-converted XLSX share
 * the semantic fingerprint and differ here.
 */
export function computeAttendanceProvenanceFingerprintV1(provenance: unknown): string {
  const code = 'W4C0_PROVENANCE_INVALID'
  const fields = requireExactKeys(
    provenance,
    ['transport', 'sourceRef', 'artifactSha256', 'normalizedCsvSha256', 'convertedSheetName'],
    code,
  )
  const transport = fields.transport
  if (
    typeof transport !== 'string' ||
    !(ATTENDANCE_INPUT_PROVENANCE_TRANSPORTS_V1 as readonly string[]).includes(transport)
  ) {
    fail(code)
  }
  requireString(fields.sourceRef, code)
  const checkConditional = (value: unknown, required: boolean, hex64: boolean): void => {
    if (required) {
      if (typeof value !== 'string') fail(code)
      if (hex64 && !LOWER_HEX_64.test(value)) fail(code)
      if (!hex64 && value.length === 0) fail(code)
    } else if (value !== null) {
      fail(code) // inapplicable non-null key fails closed
    }
  }
  checkConditional(fields.artifactSha256, ARTIFACT_SHA_REQUIRED.has(transport), true)
  checkConditional(fields.normalizedCsvSha256, NORMALIZED_CSV_SHA_REQUIRED.has(transport), true)
  checkConditional(fields.convertedSheetName, CONVERTED_SHEET_REQUIRED.has(transport), false)
  return domainHash(PROVENANCE_DOMAIN, {
    transport,
    sourceRef: fields.sourceRef,
    artifactSha256: fields.artifactSha256,
    normalizedCsvSha256: fields.normalizedCsvSha256,
    convertedSheetName: fields.convertedSheetName,
  })
}
