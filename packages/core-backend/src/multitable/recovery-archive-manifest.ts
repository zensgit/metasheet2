/**
 * Time Machine Phase D2g only: pure canonicalizer for the ratified
 * RecoveryArchiveManifest v1 (design lock D-A / D-C / D-D / D-I0).
 *
 * This module constructs, validates, canonically serializes (RFC 8785 / JCS
 * equivalent for the supported JSON domain), and hashes the manifest. It has no
 * production caller. It does not implement KMS, AEAD, MAC/signature, storage,
 * database, network, filesystem, or any runtime route, and it does not change
 * any flag or enablement.
 */

import { createHash } from 'node:crypto'

import {
  isCanonicalNonnegativeDecimalString,
  isLowercaseSha256Hex,
  RECOVERY_ARCHIVE_COVERAGE_SOURCE_KINDS,
  RECOVERY_ARCHIVE_FORMAT_VERSION,
  RECOVERY_ARCHIVE_V1_SECTION_NAMES,
  type RecoveryArchiveSectionName,
} from './recovery-archive-contract'

export type RecoveryArchiveManifestErrorCode =
  | 'RECOVERY_ARCHIVE_MANIFEST_INVALID_SHAPE'
  | 'RECOVERY_ARCHIVE_MANIFEST_INVALID_FORMAT_VERSION'
  | 'RECOVERY_ARCHIVE_MANIFEST_INVALID_BINDING'
  | 'RECOVERY_ARCHIVE_MANIFEST_INVALID_TIMESTAMP'
  | 'RECOVERY_ARCHIVE_MANIFEST_INVALID_SECTIONS'
  | 'RECOVERY_ARCHIVE_MANIFEST_INVALID_SECTION_DESCRIPTOR'
  | 'RECOVERY_ARCHIVE_MANIFEST_INVALID_ROW_ENVELOPE'
  | 'RECOVERY_ARCHIVE_MANIFEST_INVALID_ENTITY_KEY'
  | 'RECOVERY_ARCHIVE_MANIFEST_DUPLICATE_ENTITY_KEY'
  | 'RECOVERY_ARCHIVE_MANIFEST_UNSUPPORTED_JSON'
  | 'RECOVERY_ARCHIVE_MANIFEST_CYCLIC_JSON'
  | 'RECOVERY_ARCHIVE_MANIFEST_INVALID_ROOT_HASH'
  | 'RECOVERY_ARCHIVE_MANIFEST_ROOT_HASH_MISMATCH'

/** Values-free failure surface for Phase D2g manifest canonicalization. */
export class RecoveryArchiveManifestError extends Error {
  readonly code: RecoveryArchiveManifestErrorCode

  constructor(code: RecoveryArchiveManifestErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveManifestError'
    this.code = code
  }
}

/**
 * Exact v1 entity_key prefix per section (design lock D-D table). The canonicalizer
 * enforces only the prefix (and the closed coverage source-kind segment); the exact
 * payload projection belongs to the section builders of a later slice.
 */
export const RECOVERY_ARCHIVE_V1_SECTION_ENTITY_KEY_PREFIXES: Readonly<
  Record<RecoveryArchiveSectionName, string>
> = {
  schema: 'field/',
  records: 'record/',
  links: 'link/',
  field_value_tombstones: 'field-tombstone/',
  link_tombstones: 'link-tombstone/',
  auto_number: 'field/',
  attachments_index: 'attachment/',
  permission_evidence: 'scope/',
  views_config: 'view/',
  coverage_index: 'coverage/',
}

const BINDING_KEYS = [
  'archive_generation_id',
  'workspace_id',
  'base_id',
  'sheet_id',
  'anchor_operation_id',
  'anchor_seq',
  'checkpoint_id',
  'created_at',
  'expires_at',
  'source_vector_hash',
] as const

const BODY_KEYS = ['format_version', ...BINDING_KEYS, 'sections'] as const
const MANIFEST_KEYS = [...BODY_KEYS, 'root_hash', 'manifest_mac'] as const

const SECTION_CRYPTO_DESCRIPTOR_KEYS = [
  'aead_algorithm',
  'key_id',
  'wrapped_dek_id',
  'dek_fingerprint',
  'nonce',
] as const

const SECTION_DESCRIPTOR_KEYS = [
  'name',
  'row_count',
  'plaintext_sha256',
  ...SECTION_CRYPTO_DESCRIPTOR_KEYS,
] as const

const SECTION_BUILD_INPUT_KEYS = ['name', 'rows', ...SECTION_CRYPTO_DESCRIPTOR_KEYS] as const

export type RecoveryArchiveSectionCryptoDescriptorKey =
  (typeof SECTION_CRYPTO_DESCRIPTOR_KEYS)[number]

/**
 * Format-v1 crypto admission, mirrored from the parallel D2h wire contract
 * (recovery-archive-crypto.ts: closed AEAD algorithm, 64-hex dek_fingerprint,
 * 24-hex canonical nonce, non-blank identity tokens). Duplicated deliberately:
 * D2g and D2h sit on separate parents and neither may import the other; D2i
 * must consolidate these into one shared module when the slices merge.
 */
export const RECOVERY_ARCHIVE_V1_AEAD_ALGORITHM = 'aes-256-gcm' as const
const V1_DEK_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/
const V1_NONCE_HEX_PATTERN = /^[0-9a-f]{24}$/

/** v1 binding fields exactly as locked in D-C and §2.1 (snake_case manifest literals). */
export interface RecoveryArchiveManifestBinding {
  archive_generation_id: string
  workspace_id: string
  base_id: string
  sheet_id: string
  anchor_operation_id: string
  /** Canonical non-negative decimal string; values above 2^53 stay exact strings. */
  anchor_seq: string
  checkpoint_id: string
  /** Canonical UTC RFC3339, locked precision: milliseconds, `Z` suffix. */
  created_at: string
  /** Canonical UTC RFC3339 milliseconds, or null when the generation has no expiry. */
  expires_at: string | null
  source_vector_hash: string
}

/**
 * Full v1 crypto descriptor required by design lock §2.1 on every section. All
 * five fields are mandatory non-empty strings on both build and validate; zero
 * or partial crypto metadata refuses.
 */
export type RecoveryArchiveSectionCryptoDescriptor = Record<
  RecoveryArchiveSectionCryptoDescriptorKey,
  string
>

/** One exact v1 row envelope: `{ "entity_key": string, "payload": object }`. */
export interface RecoveryArchiveRowEnvelope {
  entity_key: string
  payload: Record<string, unknown>
}

export type RecoveryArchiveSectionBuildInput = RecoveryArchiveSectionCryptoDescriptor & {
  name: RecoveryArchiveSectionName
  rows: readonly RecoveryArchiveRowEnvelope[]
}

export type RecoveryArchiveSectionDescriptor = RecoveryArchiveSectionCryptoDescriptor & {
  name: RecoveryArchiveSectionName
  row_count: string
  plaintext_sha256: string
}

export interface RecoveryArchiveManifestBody extends RecoveryArchiveManifestBinding {
  format_version: typeof RECOVERY_ARCHIVE_FORMAT_VERSION
  sections: RecoveryArchiveSectionDescriptor[]
}

export interface RecoveryArchiveManifest extends RecoveryArchiveManifestBody {
  root_hash: string
  manifest_mac: string | null
}

export interface RecoveryArchiveManifestBuildResult {
  manifest: RecoveryArchiveManifest
  /** JCS of the manifest body only: the exact root-hash preimage. */
  bodyJson: string
  /** JCS of the full stored manifest, including root_hash and manifest_mac. */
  manifestJson: string
}

export interface RecoveryArchiveSectionCanonicalization {
  canonicalJson: string
  rowCount: string
  plaintextSha256: string
}

/**
 * RFC 8785 / JCS-equivalent deterministic serialization for the supported JSON
 * domain: null, boolean, finite number, string, array, and plain object.
 * Non-finite numbers, bigint, undefined, functions, symbols, enumerable symbol
 * keys, and cyclic structures refuse (fail-closed); nothing is dropped or coerced.
 */
export function canonicalizeRecoveryArchiveJson(value: unknown): string {
  return serializeJsonValue(value, new Set<object>())
}

/**
 * Canonicalizes one section's logical rows: validates each exact
 * `{entity_key, payload}` envelope, enforces the v1 entity_key prefix for the
 * named section, refuses duplicate entity keys, sorts rows by the UTF-8 bytes of
 * `entity_key`, and hashes the JCS of that outer array. `row_count` is the
 * decimal-string length of the outer array only; nested payload arrays/objects
 * are canonicalized inside their one row and never counted as extra rows.
 */
export function canonicalizeRecoveryArchiveSectionRows(
  sectionName: RecoveryArchiveSectionName,
  rows: readonly RecoveryArchiveRowEnvelope[],
): RecoveryArchiveSectionCanonicalization {
  const rowSnapshot = snapshotDenseArrayValues(
    rows,
    'RECOVERY_ARCHIVE_MANIFEST_INVALID_ROW_ENVELOPE',
  )

  const seenEntityKeys = new Set<string>()
  const canonicalRows: RecoveryArchiveRowEnvelope[] = []
  for (const row of rowSnapshot) {
    const envelope = validateRowEnvelope(row)
    validateEntityKeyForSection(sectionName, envelope.entity_key)
    if (seenEntityKeys.has(envelope.entity_key)) {
      throwManifestError('RECOVERY_ARCHIVE_MANIFEST_DUPLICATE_ENTITY_KEY')
    }
    seenEntityKeys.add(envelope.entity_key)
    canonicalRows.push(envelope)
  }

  canonicalRows.sort((left, right) => compareUtf8Bytes(left.entity_key, right.entity_key))

  const canonicalJson = canonicalizeRecoveryArchiveJson(canonicalRows)
  return {
    canonicalJson,
    rowCount: String(canonicalRows.length),
    plaintextSha256: sha256Hex(canonicalJson),
  }
}

/** SHA-256 (lowercase hex) of the JCS canonical manifest body. */
export function computeRecoveryArchiveManifestRootHash(
  body: RecoveryArchiveManifestBody,
): string {
  return sha256Hex(serializeManifestBody(body))
}

/**
 * Builds a v1 manifest from binding fields plus the exact ordered section set.
 * Sections must be supplied in the exact v1 contract order with zero-row
 * sections explicit; missing, unknown, duplicate, or reordered sections refuse.
 * The root-hash preimage excludes `root_hash` and `manifest_mac`.
 */
export function buildRecoveryArchiveManifest(
  binding: RecoveryArchiveManifestBinding,
  sections: readonly RecoveryArchiveSectionBuildInput[],
  manifestMac: string | null = null,
): RecoveryArchiveManifestBuildResult {
  // D-A: the build input itself must be a plain record with the exact v1
  // BINDING_KEYS set; additive fields require a format version bump. Validate
  // the original object's ordinary data descriptors before any validation so
  // foreign keys, class prototypes, symbols, and Proxy reads cannot be spread
  // away or substituted after admission.
  const bindingSnapshot = snapshotPlainRecordWithExactKeys(
    binding,
    BINDING_KEYS,
    'RECOVERY_ARCHIVE_MANIFEST_INVALID_BINDING',
  )
  validateBinding(bindingSnapshot)
  validateManifestMac(manifestMac)

  const sectionSnapshot = snapshotDenseArrayValues(
    sections,
    'RECOVERY_ARCHIVE_MANIFEST_INVALID_SECTIONS',
  )
  if (sectionSnapshot.length !== RECOVERY_ARCHIVE_V1_SECTION_NAMES.length) {
    throwManifestError('RECOVERY_ARCHIVE_MANIFEST_INVALID_SECTIONS')
  }
  const descriptors = sectionSnapshot.map((section, index) =>
    buildSectionDescriptor(section, expectedSectionNameAt(index)),
  )

  const body: RecoveryArchiveManifestBody = {
    format_version: RECOVERY_ARCHIVE_FORMAT_VERSION,
    ...pickBinding(bindingSnapshot),
    sections: descriptors,
  }
  const bodyJson = serializeManifestBody(body)
  const rootHash = sha256Hex(bodyJson)
  const manifest: RecoveryArchiveManifest = {
    ...body,
    root_hash: rootHash,
    manifest_mac: manifestMac,
  }
  return {
    manifest,
    bodyJson,
    manifestJson: canonicalizeRecoveryArchiveJson(manifest),
  }
}

/**
 * Fail-closed validation of an unknown stored manifest value: exact key sets,
 * closed format version, binding shape, exact ordered section descriptors, and
 * a recomputed root hash that must equal the stored `root_hash`. MAC/signature
 * verification is owned by the later crypto slice and is not performed here.
 */
export function validateRecoveryArchiveManifest(value: unknown): RecoveryArchiveManifest {
  const manifestSnapshot = snapshotPlainRecordWithExactKeys(
    value,
    MANIFEST_KEYS,
    'RECOVERY_ARCHIVE_MANIFEST_INVALID_SHAPE',
  )
  if (manifestSnapshot.format_version !== RECOVERY_ARCHIVE_FORMAT_VERSION) {
    throwManifestError('RECOVERY_ARCHIVE_MANIFEST_INVALID_FORMAT_VERSION')
  }
  validateBinding(manifestSnapshot)
  validateManifestMac(manifestSnapshot.manifest_mac)
  if (!isLowercaseSha256Hex(manifestSnapshot.root_hash)) {
    throwManifestError('RECOVERY_ARCHIVE_MANIFEST_INVALID_ROOT_HASH')
  }

  const sections = snapshotDenseArrayValues(
    manifestSnapshot.sections,
    'RECOVERY_ARCHIVE_MANIFEST_INVALID_SECTIONS',
  )
  if (sections.length !== RECOVERY_ARCHIVE_V1_SECTION_NAMES.length) {
    throwManifestError('RECOVERY_ARCHIVE_MANIFEST_INVALID_SECTIONS')
  }
  const descriptors = sections.map((section, index) =>
    validateSectionDescriptor(section, expectedSectionNameAt(index)),
  )

  const body: RecoveryArchiveManifestBody = {
    format_version: RECOVERY_ARCHIVE_FORMAT_VERSION,
    ...pickBinding(manifestSnapshot),
    sections: descriptors,
  }
  if (computeRecoveryArchiveManifestRootHash(body) !== manifestSnapshot.root_hash) {
    throwManifestError('RECOVERY_ARCHIVE_MANIFEST_ROOT_HASH_MISMATCH')
  }
  return {
    ...body,
    root_hash: manifestSnapshot.root_hash,
    manifest_mac: manifestSnapshot.manifest_mac as string | null,
  }
}

function buildSectionDescriptor(
  section: unknown,
  expectedName: RecoveryArchiveSectionName,
): RecoveryArchiveSectionDescriptor {
  const sectionSnapshot = snapshotPlainRecordWithExactKeys(
    section,
    SECTION_BUILD_INPUT_KEYS,
    'RECOVERY_ARCHIVE_MANIFEST_INVALID_SECTIONS',
  )
  if (sectionSnapshot.name !== expectedName || !isArray(sectionSnapshot.rows)) {
    throwManifestError('RECOVERY_ARCHIVE_MANIFEST_INVALID_SECTIONS')
  }
  const crypto = requireCryptoDescriptor(sectionSnapshot)
  const { rowCount, plaintextSha256 } = canonicalizeRecoveryArchiveSectionRows(
    expectedName,
    sectionSnapshot.rows as readonly RecoveryArchiveRowEnvelope[],
  )
  return {
    name: expectedName,
    row_count: rowCount,
    plaintext_sha256: plaintextSha256,
    ...crypto,
  }
}

function validateSectionDescriptor(
  value: unknown,
  expectedName: RecoveryArchiveSectionName,
): RecoveryArchiveSectionDescriptor {
  const sectionSnapshot = snapshotPlainRecordWithExactKeys(
    value,
    SECTION_DESCRIPTOR_KEYS,
    'RECOVERY_ARCHIVE_MANIFEST_INVALID_SECTION_DESCRIPTOR',
  )
  if (
    sectionSnapshot.name !== expectedName ||
    !isCanonicalNonnegativeDecimalString(sectionSnapshot.row_count) ||
    !isLowercaseSha256Hex(sectionSnapshot.plaintext_sha256)
  ) {
    throwManifestError('RECOVERY_ARCHIVE_MANIFEST_INVALID_SECTION_DESCRIPTOR')
  }
  return {
    name: expectedName,
    row_count: sectionSnapshot.row_count,
    plaintext_sha256: sectionSnapshot.plaintext_sha256,
    ...requireCryptoDescriptor(sectionSnapshot),
  }
}

/**
 * §2.1 requires all five crypto fields on every v1 section descriptor. Zero or
 * partial crypto metadata is fail-closed refuse, on build and validate alike.
 * Each field is checked against the format-v1 admission shape above: this is
 * wire-format validation only, never provider/KMS behavior.
 */
function requireCryptoDescriptor(
  source: Record<string, unknown>,
): RecoveryArchiveSectionCryptoDescriptor {
  const crypto: Record<string, string> = {}
  for (const key of SECTION_CRYPTO_DESCRIPTOR_KEYS) {
    if (!isV1CryptoFieldValue(key, source[key])) {
      throwManifestError('RECOVERY_ARCHIVE_MANIFEST_INVALID_SECTION_DESCRIPTOR')
    }
    crypto[key] = source[key] as string
  }
  return crypto as RecoveryArchiveSectionCryptoDescriptor
}

function isV1CryptoFieldValue(
  key: RecoveryArchiveSectionCryptoDescriptorKey,
  value: unknown,
): value is string {
  if (typeof value !== 'string') return false
  switch (key) {
    case 'aead_algorithm':
      return value === RECOVERY_ARCHIVE_V1_AEAD_ALGORITHM
    case 'dek_fingerprint':
      return V1_DEK_FINGERPRINT_PATTERN.test(value)
    case 'nonce':
      return V1_NONCE_HEX_PATTERN.test(value)
    case 'key_id':
    case 'wrapped_dek_id':
      // Non-blank identity token: whitespace-only is refused, never trimmed.
      return value.trim().length > 0
  }
}

function validateBinding(value: Record<string, unknown>): void {
  for (const key of BINDING_KEYS) {
    if (!(key in value)) {
      throwManifestError('RECOVERY_ARCHIVE_MANIFEST_INVALID_BINDING')
    }
  }
  for (const key of [
    'archive_generation_id',
    'workspace_id',
    'base_id',
    'sheet_id',
    'anchor_operation_id',
    'checkpoint_id',
  ] as const) {
    if (typeof value[key] !== 'string' || (value[key] as string).length === 0) {
      throwManifestError('RECOVERY_ARCHIVE_MANIFEST_INVALID_BINDING')
    }
  }
  if (!isCanonicalNonnegativeDecimalString(value.anchor_seq)) {
    throwManifestError('RECOVERY_ARCHIVE_MANIFEST_INVALID_BINDING')
  }
  if (!isLowercaseSha256Hex(value.source_vector_hash)) {
    throwManifestError('RECOVERY_ARCHIVE_MANIFEST_INVALID_BINDING')
  }
  if (!isCanonicalUtcTimestamp(value.created_at)) {
    throwManifestError('RECOVERY_ARCHIVE_MANIFEST_INVALID_TIMESTAMP')
  }
  if (value.expires_at !== null && !isCanonicalUtcTimestamp(value.expires_at)) {
    throwManifestError('RECOVERY_ARCHIVE_MANIFEST_INVALID_TIMESTAMP')
  }
}

function validateManifestMac(value: unknown): void {
  if (value !== null && (typeof value !== 'string' || value.length === 0)) {
    throwManifestError('RECOVERY_ARCHIVE_MANIFEST_INVALID_SHAPE')
  }
}

function pickBinding(value: Record<string, unknown>): RecoveryArchiveManifestBinding {
  const binding: Record<string, unknown> = {}
  for (const key of BINDING_KEYS) binding[key] = value[key]
  return binding as unknown as RecoveryArchiveManifestBinding
}

function validateRowEnvelope(row: unknown): RecoveryArchiveRowEnvelope {
  const envelope = snapshotPlainRecordWithExactKeys(
    row,
    ['entity_key', 'payload'],
    'RECOVERY_ARCHIVE_MANIFEST_INVALID_ROW_ENVELOPE',
  )
  if (typeof envelope.entity_key !== 'string' || envelope.entity_key.length === 0) {
    throwManifestError('RECOVERY_ARCHIVE_MANIFEST_INVALID_ROW_ENVELOPE')
  }
  if (!isRecord(envelope.payload)) {
    throwManifestError('RECOVERY_ARCHIVE_MANIFEST_INVALID_ROW_ENVELOPE')
  }
  return envelope as unknown as RecoveryArchiveRowEnvelope
}

function validateEntityKeyForSection(
  sectionName: RecoveryArchiveSectionName,
  entityKey: string,
): void {
  const prefix = RECOVERY_ARCHIVE_V1_SECTION_ENTITY_KEY_PREFIXES[sectionName]
  if (!entityKey.startsWith(prefix) || entityKey.length === prefix.length) {
    throwManifestError('RECOVERY_ARCHIVE_MANIFEST_INVALID_ENTITY_KEY')
  }
  if (sectionName === 'coverage_index') {
    const segments = entityKey.split('/')
    const sourceKind = segments[1]
    if (
      segments.length !== 3 ||
      segments[2].length === 0 ||
      !(RECOVERY_ARCHIVE_COVERAGE_SOURCE_KINDS as readonly string[]).includes(sourceKind)
    ) {
      throwManifestError('RECOVERY_ARCHIVE_MANIFEST_INVALID_ENTITY_KEY')
    }
  }
}

function serializeManifestBody(body: RecoveryArchiveManifestBody): string {
  return canonicalizeRecoveryArchiveJson(
    snapshotPlainRecordWithExactKeys(
      body,
      BODY_KEYS,
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_SHAPE',
    ),
  )
}

function expectedSectionNameAt(index: number): RecoveryArchiveSectionName {
  const name = RECOVERY_ARCHIVE_V1_SECTION_NAMES[index]
  if (name === undefined) {
    throwManifestError('RECOVERY_ARCHIVE_MANIFEST_INVALID_SECTIONS')
  }
  return name
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

function serializeJsonValue(value: unknown, path: Set<object>): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return serializeJsonString(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throwManifestError('RECOVERY_ARCHIVE_MANIFEST_UNSUPPORTED_JSON')
    }
    return JSON.stringify(value)
  }
  if (isArray(value)) {
    if (path.has(value)) {
      throwManifestError('RECOVERY_ARCHIVE_MANIFEST_CYCLIC_JSON')
    }
    // Exact dense-index ownership: every 0..length-1 must be an own property and
    // the enumerable own string keys must be exactly those canonical indices, so a
    // hole plus an extra key (or an enumerable symbol key) cannot balance the count.
    const elements = snapshotDenseArrayValues(
      value,
      'RECOVERY_ARCHIVE_MANIFEST_UNSUPPORTED_JSON',
    )
    path.add(value)
    try {
      return `[${elements.map((element) => serializeJsonValue(element, path)).join(',')}]`
    } finally {
      path.delete(value)
    }
  }
  if (typeof value === 'object') {
    // Only plain objects are in the supported JSON domain; Date, Map, and class
    // instances refuse rather than serialize as empty/enumerable projections.
    if (path.has(value)) {
      throwManifestError('RECOVERY_ARCHIVE_MANIFEST_CYCLIC_JSON')
    }
    const record = snapshotEnumerableDataRecord(
      value,
      'RECOVERY_ARCHIVE_MANIFEST_UNSUPPORTED_JSON',
    )
    path.add(value)
    try {
      const keys = Object.keys(record).sort()
      const entries = keys.map(
        (key) => `${serializeJsonString(key)}:${serializeJsonValue(record[key], path)}`,
      )
      return `{${entries.join(',')}}`
    } finally {
      path.delete(value)
    }
  }
  throwManifestError('RECOVERY_ARCHIVE_MANIFEST_UNSUPPORTED_JSON')
}

function serializeJsonString(value: string): string {
  let out = '"'
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x22) out += '\\"'
    else if (code === 0x5c) out += '\\\\'
    else if (code === 0x08) out += '\\b'
    else if (code === 0x09) out += '\\t'
    else if (code === 0x0a) out += '\\n'
    else if (code === 0x0c) out += '\\f'
    else if (code === 0x0d) out += '\\r'
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`
    else if (code >= 0xd800 && code <= 0xdbff) {
      // Unpaired surrogates refuse: TextEncoder would replace them with U+FFFD,
      // collapsing distinct invalid strings onto one canonical byte sequence.
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throwManifestError('RECOVERY_ARCHIVE_MANIFEST_UNSUPPORTED_JSON')
      }
      out += value[index] + value[index + 1]
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throwManifestError('RECOVERY_ARCHIVE_MANIFEST_UNSUPPORTED_JSON')
    } else out += value[index]
  }
  return `${out}"`
}

function compareUtf8Bytes(left: string, right: string): number {
  const leftBytes = utf8Encoder.encode(left)
  const rightBytes = utf8Encoder.encode(right)
  const shared = Math.min(leftBytes.length, rightBytes.length)
  for (let index = 0; index < shared; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index]
  }
  return leftBytes.length - rightBytes.length
}

/**
 * Snapshot a dense array from own data descriptors exactly once. The returned
 * plain array is the only value source used after admission, so a Proxy `get`
 * trap cannot substitute a later value after validation.
 */
function snapshotDenseArrayValues(
  value: unknown,
  errorCode: RecoveryArchiveManifestErrorCode,
): unknown[] {
  try {
    if (!Array.isArray(value)) throwManifestError(errorCode)
    const keys = Reflect.ownKeys(value)
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (
      lengthDescriptor === undefined ||
      !('value' in lengthDescriptor) ||
      typeof lengthDescriptor.value !== 'number' ||
      !Number.isInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      throwManifestError(errorCode)
    }
    const length = lengthDescriptor.value
    const elements = new Array<unknown>(length)
    const seenIndices = new Set<number>()
    for (const key of keys) {
      if (key === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined) throwManifestError(errorCode)
      if (typeof key === 'symbol') {
        if (descriptor.enumerable) throwManifestError(errorCode)
        continue
      }
      if (!descriptor.enumerable) continue
      const index = Number(key)
      if (
        !Number.isInteger(index) ||
        String(index) !== key ||
        index < 0 ||
        index >= length ||
        !('value' in descriptor) ||
        seenIndices.has(index)
      ) {
        throwManifestError(errorCode)
      }
      seenIndices.add(index)
      elements[index] = descriptor.value
    }
    if (seenIndices.size !== length) throwManifestError(errorCode)
    return elements
  } catch (error) {
    if (error instanceof RecoveryArchiveManifestError) throw error
    throwManifestError(errorCode)
  }
}

/**
 * Snapshot all enumerable own string data properties of a plain object exactly
 * once. Non-enumerable metadata remains outside the supported JSON projection,
 * matching JSON object semantics; enumerable symbols and accessors refuse.
 */
function snapshotEnumerableDataRecord(
  value: object,
  errorCode: RecoveryArchiveManifestErrorCode,
): Record<string, unknown> {
  try {
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throwManifestError(errorCode)
    const snapshot: Record<string, unknown> = Object.create(null)
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined) throwManifestError(errorCode)
      if (!descriptor.enumerable) continue
      if (typeof key === 'symbol' || !('value' in descriptor)) throwManifestError(errorCode)
      snapshot[key] = descriptor.value
    }
    return snapshot
  } catch (error) {
    if (error instanceof RecoveryArchiveManifestError) throw error
    throwManifestError(errorCode)
  }
}

/**
 * Schema-boundary snapshot: exact enumerable own key set and ordinary data
 * descriptors only. All values are copied once from those descriptors before
 * validation, projection, or serialization.
 */
function snapshotPlainRecordWithExactKeys(
  value: unknown,
  expected: readonly string[],
  errorCode: RecoveryArchiveManifestErrorCode,
): Record<string, unknown> {
  if (!isRecord(value)) throwManifestError(errorCode)
  const snapshot = snapshotEnumerableDataRecord(value, errorCode)
  const keys = Object.keys(snapshot)
  if (keys.length !== expected.length) throwManifestError(errorCode)
  const expectedSet = new Set<string>(expected)
  if (!keys.every((key) => expectedSet.has(key))) throwManifestError(errorCode)
  return snapshot
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isArray(value)
}

function isArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value)
  } catch {
    return false
  }
}

function sha256Hex(canonicalJson: string): string {
  return createHash('sha256').update(canonicalJson, 'utf8').digest('hex')
}

function throwManifestError(code: RecoveryArchiveManifestErrorCode): never {
  throw new RecoveryArchiveManifestError(code)
}

const utf8Encoder = new TextEncoder()
