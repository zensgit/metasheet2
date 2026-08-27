/**
 * Time Machine D2: pure D1 canonical plaintext row builders for data sections.
 *
 * This module maps already-fetched source rows only. It does not query, hash,
 * serialize, claim, write, or change runtime enablement.
 */

import {
  isCanonicalNonnegativeDecimalString,
  RECOVERY_ARCHIVE_V1_SECTION_NAMES,
  type RecoveryArchiveSectionName,
} from './recovery-archive-contract'
import {
  RECOVERY_ARCHIVE_V1_SECTION_ENTITY_KEY_PREFIXES,
  type RecoveryArchiveRowEnvelope,
} from './recovery-archive-manifest'

export const RECOVERY_ARCHIVE_DATA_SECTION_NAMES = Object.freeze(
  RECOVERY_ARCHIVE_V1_SECTION_NAMES.filter(
    (name): name is Exclude<RecoveryArchiveSectionName, 'coverage_index'> => name !== 'coverage_index',
  ),
)

export type RecoveryArchiveDataSectionName = (typeof RECOVERY_ARCHIVE_DATA_SECTION_NAMES)[number]

export type RecoveryArchiveSectionRowsErrorCode =
  | 'RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_SECTION'
  | 'RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_ROWS'
  | 'RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_ROW'
  | 'RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_KEYS'
  | 'RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_IDENTITY'
  | 'RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_SEQ'
  | 'RECOVERY_ARCHIVE_SECTION_ROWS_DUPLICATE_ENTITY_KEY'
  | 'RECOVERY_ARCHIVE_SECTION_ROWS_UNSUPPORTED_JSON'

/** Values-free refusal surface for pure D1 plaintext row building. */
export class RecoveryArchiveSectionRowsError extends Error {
  readonly code: RecoveryArchiveSectionRowsErrorCode

  constructor(code: RecoveryArchiveSectionRowsErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveSectionRowsError'
    this.code = code
  }
}

type SectionSpec = {
  readonly keys: readonly string[]
  readonly identityKey: string
  readonly decimalKeys: readonly string[]
  readonly enforceRecordExistsShape?: boolean
  readonly maximumRows?: number
}

const SECTION_SPECS: Readonly<Record<RecoveryArchiveDataSectionName, SectionSpec>> = {
  schema: {
    keys: ['field_id', 'name', 'type', 'property', 'order'],
    identityKey: 'field_id',
    decimalKeys: [],
  },
  records: {
    keys: ['record_id', 'exists', 'version', 'data'],
    identityKey: 'record_id',
    decimalKeys: [],
    enforceRecordExistsShape: true,
  },
  links: {
    keys: ['link_id', 'field_id', 'record_id', 'foreign_record_id'],
    identityKey: 'link_id',
    decimalKeys: [],
  },
  field_value_tombstones: {
    keys: ['id', 'field_id', 'record_id', 'config_revision_id', 'value', 'reason', 'created_at'],
    identityKey: 'id',
    decimalKeys: [],
  },
  link_tombstones: {
    keys: ['id', 'source_revision_id', 'field_id', 'record_id', 'foreign_record_id', 'reason', 'created_at'],
    identityKey: 'id',
    decimalKeys: [],
  },
  auto_number: {
    keys: ['field_id', 'next_value'],
    identityKey: 'field_id',
    decimalKeys: ['next_value'],
  },
  attachments_index: {
    keys: [
      'attachment_id',
      'record_id',
      'field_id',
      'immutable_object_version',
      'plaintext_sha256',
      'size_bytes',
      'media_type',
      'deleted',
    ],
    identityKey: 'attachment_id',
    decimalKeys: ['size_bytes'],
  },
  permission_evidence: {
    keys: ['authorized_scope_hash', 'policy_epoch_hash', 'captured_at_seq'],
    identityKey: 'authorized_scope_hash',
    decimalKeys: ['captured_at_seq'],
    maximumRows: 1,
  },
  views_config: {
    keys: ['view_id', 'name', 'type', 'filter_info', 'sort_info', 'group_info', 'hidden_field_ids', 'config'],
    identityKey: 'view_id',
    decimalKeys: [],
  },
}

const utf8Encoder = new TextEncoder()

/**
 * Build one data section's exact D1 envelope rows. Values are snapshot without
 * coercion so later caller mutation cannot alter the admitted archive truth.
 */
export function buildRecoveryArchiveSectionRows(
  sectionName: unknown,
  sourceRows: unknown,
): RecoveryArchiveRowEnvelope[] {
  if (!isRecoveryArchiveDataSectionName(sectionName)) {
    throwSectionRowsError('RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_SECTION')
  }

  const spec = SECTION_SPECS[sectionName]
  const rows = snapshotDenseArray(sourceRows)
  if (spec.maximumRows !== undefined && rows.length > spec.maximumRows) {
    throwSectionRowsError('RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_ROWS')
  }

  const seenEntityKeys = new Set<string>()
  const envelopes: RecoveryArchiveRowEnvelope[] = []
  for (const row of rows) {
    const payload = snapshotExactRow(row, spec.keys)
    const identity = payload[spec.identityKey]
    if (typeof identity !== 'string' || identity.length === 0 || !isWellFormedUtf16(identity)) {
      throwSectionRowsError('RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_IDENTITY')
    }
    for (const key of spec.decimalKeys) {
      if (!isCanonicalNonnegativeDecimalString(payload[key])) {
        throwSectionRowsError('RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_SEQ')
      }
    }
    if (
      spec.enforceRecordExistsShape
      && (typeof payload.exists !== 'boolean' || (payload.exists ? payload.data === null : payload.data !== null))
    ) {
      throwSectionRowsError('RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_ROW')
    }

    const entityKey = `${RECOVERY_ARCHIVE_V1_SECTION_ENTITY_KEY_PREFIXES[sectionName]}${identity}`
    if (seenEntityKeys.has(entityKey)) {
      throwSectionRowsError('RECOVERY_ARCHIVE_SECTION_ROWS_DUPLICATE_ENTITY_KEY')
    }
    seenEntityKeys.add(entityKey)
    envelopes.push({ entity_key: entityKey, payload })
  }

  envelopes.sort((left, right) => compareUtf8Bytes(left.entity_key, right.entity_key))
  return envelopes
}

function isRecoveryArchiveDataSectionName(value: unknown): value is RecoveryArchiveDataSectionName {
  return typeof value === 'string' && RECOVERY_ARCHIVE_DATA_SECTION_NAMES.includes(value as RecoveryArchiveDataSectionName)
}

function snapshotDenseArray(value: unknown): unknown[] {
  return snapshotExactDenseArray(value, 'RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_ROWS')
}

function snapshotExactRow(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  const source = snapshotPlainRecord(value, 'RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_ROW')
  const keys = Object.keys(source)
  if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key))) {
    throwSectionRowsError('RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_KEYS')
  }

  const payload: Record<string, unknown> = Object.create(null)
  for (const key of expectedKeys) {
    payload[key] = snapshotJsonValue(source[key], new Set<object>())
  }
  return payload
}

function snapshotJsonValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (!isWellFormedUtf16(value)) throwSectionRowsError('RECOVERY_ARCHIVE_SECTION_ROWS_UNSUPPORTED_JSON')
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throwSectionRowsError('RECOVERY_ARCHIVE_SECTION_ROWS_UNSUPPORTED_JSON')
    return value
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throwSectionRowsError('RECOVERY_ARCHIVE_SECTION_ROWS_UNSUPPORTED_JSON')
    const items = snapshotJsonArray(value)
    ancestors.add(value)
    try {
      return items.map((item) => snapshotJsonValue(item, ancestors))
    } finally {
      ancestors.delete(value)
    }
  }
  if (typeof value === 'object') {
    if (ancestors.has(value)) throwSectionRowsError('RECOVERY_ARCHIVE_SECTION_ROWS_UNSUPPORTED_JSON')
    const source = snapshotPlainRecord(value, 'RECOVERY_ARCHIVE_SECTION_ROWS_UNSUPPORTED_JSON')
    const snapshot: Record<string, unknown> = Object.create(null)
    ancestors.add(value)
    try {
      for (const key of Object.keys(source)) {
        if (!isWellFormedUtf16(key)) throwSectionRowsError('RECOVERY_ARCHIVE_SECTION_ROWS_UNSUPPORTED_JSON')
        snapshot[key] = snapshotJsonValue(source[key], ancestors)
      }
      return snapshot
    } finally {
      ancestors.delete(value)
    }
  }
  throwSectionRowsError('RECOVERY_ARCHIVE_SECTION_ROWS_UNSUPPORTED_JSON')
}

function snapshotJsonArray(value: unknown[]): unknown[] {
  return snapshotExactDenseArray(value, 'RECOVERY_ARCHIVE_SECTION_ROWS_UNSUPPORTED_JSON')
}

function snapshotExactDenseArray(
  value: unknown,
  errorCode: RecoveryArchiveSectionRowsErrorCode,
): unknown[] {
  try {
    if (!Array.isArray(value)) throwSectionRowsError(errorCode)
    const keys = Reflect.ownKeys(value)
    const descriptors = new Map<PropertyKey, PropertyDescriptor>()
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined) throwSectionRowsError(errorCode)
      descriptors.set(key, descriptor)
    }

    const lengthDescriptor = descriptors.get('length')
    if (
      lengthDescriptor === undefined
      || !('value' in lengthDescriptor)
      || typeof lengthDescriptor.value !== 'number'
      || !Number.isInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
    ) {
      throwSectionRowsError(errorCode)
    }
    const length = lengthDescriptor.value
    if (keys.length !== length + 1) throwSectionRowsError(errorCode)

    const items = new Array<unknown>(length)
    const seenIndices = new Set<number>()
    for (const key of keys) {
      if (key === 'length') continue
      const descriptor = descriptors.get(key)
      if (descriptor === undefined || typeof key === 'symbol' || !('value' in descriptor)) {
        throwSectionRowsError(errorCode)
      }
      const index = Number(key)
      if (
        !Number.isInteger(index)
        || String(index) !== key
        || index < 0
        || index >= length
        || seenIndices.has(index)
      ) {
        throwSectionRowsError(errorCode)
      }
      seenIndices.add(index)
      items[index] = descriptor.value
    }
    if (seenIndices.size !== length) throwSectionRowsError(errorCode)
    return items
  } catch (error) {
    if (error instanceof RecoveryArchiveSectionRowsError) throw error
    throwSectionRowsError(errorCode)
  }
}

function snapshotPlainRecord(
  value: unknown,
  errorCode: RecoveryArchiveSectionRowsErrorCode,
): Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throwSectionRowsError(errorCode)
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throwSectionRowsError(errorCode)
    const snapshot: Record<string, unknown> = Object.create(null)
    const keys = Reflect.ownKeys(value)
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined) throwSectionRowsError(errorCode)
      if (typeof key === 'symbol' || !descriptor.enumerable || !('value' in descriptor)) {
        throwSectionRowsError(errorCode)
      }
      snapshot[key] = descriptor.value
    }
    return snapshot
  } catch (error) {
    if (error instanceof RecoveryArchiveSectionRowsError) throw error
    throwSectionRowsError(errorCode)
  }
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

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

function throwSectionRowsError(code: RecoveryArchiveSectionRowsErrorCode): never {
  throw new RecoveryArchiveSectionRowsError(code)
}
