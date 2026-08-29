/**
 * Time Machine Phase D2d2-PREP-B: pure versioned domain-separated canonical
 * source-hash/preimage for all ten recovery-archive coverage source kinds.
 *
 * This module has no production caller. It does not implement archive creation,
 * coverage writers, prune, storage, database, or any runtime route, and it
 * does not change any flag or enablement.
 */

import { createHash } from 'node:crypto'

import {
  isPositiveDecimalString,
  isRecoveryArchiveCoverageSourceKind,
  type RecoveryArchiveCoverageSourceKind,
} from './recovery-archive-contract'
import {
  canonicalizeRecoveryArchiveJson,
  RecoveryArchiveManifestError,
} from './recovery-archive-manifest'

export const RECOVERY_ARCHIVE_SOURCE_HASH_DOMAIN =
  'metasheet2:multitable:recovery-archive:source-hash:v1' as const

export const RECOVERY_ARCHIVE_SOURCE_HASH_FORMAT_VERSION = 1 as const

const ID = ['id'] as const
const ENDPOINT_ID = ['sheet_id', 'operation_id'] as const
const MEMBER_ID = ['sheet_id', 'parent_operation_id', 'ordinal'] as const

const KIND_SPEC = {
  record_revision: {
    keys: [
      'id',
      'sheet_id',
      'record_id',
      'version',
      'action',
      'source',
      'actor_id',
      'changed_field_ids',
      'patch',
      'snapshot',
      'created_at',
      'batch_id',
      'restored_from_version',
      'seq',
      'operation_id',
    ],
    identity: ID,
    seqField: 'seq',
  },
  marker: {
    keys: [
      'id',
      'sheet_id',
      'record_id',
      'version',
      'kind',
      'actor_id',
      'created_at',
      'seq',
      'operation_id',
    ],
    identity: ID,
    seqField: 'seq',
  },
  section_revision: {
    keys: [
      'id',
      'sheet_id',
      'section_kind',
      'entity_key',
      'action',
      'payload',
      'tombstone',
      'seq',
      'operation_id',
      'created_at',
    ],
    identity: ID,
    seqField: 'seq',
  },
  config_revision: {
    keys: [
      'id',
      'sheet_id',
      'entity_type',
      'entity_id',
      'action',
      'before',
      'after',
      'changed_keys',
      'batch_id',
      'actor_id',
      'created_at',
      'source',
      'restored_from_id',
      'operation_id',
    ],
    identity: ID,
    seqField: null,
  },
  field_tombstone: {
    keys: [
      'id',
      'sheet_id',
      'field_id',
      'record_id',
      'value',
      'reason',
      'config_revision_id',
      'created_at',
      'operation_id',
    ],
    identity: ID,
    seqField: null,
  },
  link_tombstone: {
    keys: [
      'id',
      'sheet_id',
      'field_id',
      'record_id',
      'foreign_record_id',
      'reason',
      'source_revision_id',
      'created_at',
      'operation_id',
    ],
    identity: ID,
    seqField: null,
  },
  checkpoint_baseline: {
    keys: [
      'id',
      'checkpoint_id',
      'sheet_id',
      'record_id',
      'data',
      'version',
      'is_trashed',
      'created_at',
    ],
    identity: ID,
    seqField: null,
  },
  sealed_operation_endpoint: {
    keys: [
      'sheet_id',
      'operation_id',
      'endpoint_seq',
      'event_count',
      'created_at',
      'operation_kind',
      'event_contract_version',
      'component_count',
    ],
    identity: ENDPOINT_ID,
    seqField: 'endpoint_seq',
  },
  snapshot_membership: {
    keys: [
      'sheet_id',
      'parent_operation_id',
      'ordinal',
      'section_kind',
      'source_head_kind',
      'source_operation_id',
      'source_head_seq',
      'row_count',
      'source_hash',
      'created_at',
    ],
    identity: MEMBER_ID,
    seqField: 'source_head_seq',
  },
  aggregate_membership: {
    keys: [
      'sheet_id',
      'parent_operation_id',
      'ordinal',
      'child_operation_id',
      'child_endpoint_seq',
      'child_event_count',
      'created_at',
    ],
    identity: MEMBER_ID,
    seqField: 'child_endpoint_seq',
  },
} as const satisfies Record<
  RecoveryArchiveCoverageSourceKind,
  { keys: readonly string[]; identity: readonly string[]; seqField: string | null }
>

function freezeRowKeys(keys: readonly string[]): readonly string[] {
  return Object.freeze([...keys])
}

export const RECOVERY_ARCHIVE_SOURCE_ROW_KEYS: Readonly<
  Record<RecoveryArchiveCoverageSourceKind, readonly string[]>
> = Object.freeze({
  record_revision: freezeRowKeys(KIND_SPEC.record_revision.keys),
  marker: freezeRowKeys(KIND_SPEC.marker.keys),
  section_revision: freezeRowKeys(KIND_SPEC.section_revision.keys),
  config_revision: freezeRowKeys(KIND_SPEC.config_revision.keys),
  field_tombstone: freezeRowKeys(KIND_SPEC.field_tombstone.keys),
  link_tombstone: freezeRowKeys(KIND_SPEC.link_tombstone.keys),
  checkpoint_baseline: freezeRowKeys(KIND_SPEC.checkpoint_baseline.keys),
  sealed_operation_endpoint: freezeRowKeys(KIND_SPEC.sealed_operation_endpoint.keys),
  snapshot_membership: freezeRowKeys(KIND_SPEC.snapshot_membership.keys),
  aggregate_membership: freezeRowKeys(KIND_SPEC.aggregate_membership.keys),
})

export type RecoveryArchiveSourceHashErrorCode =
  | 'RECOVERY_ARCHIVE_SOURCE_HASH_UNKNOWN_KIND'
  | 'RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_ROW'
  | 'RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_KEYS'
  | 'RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_IDENTITY'
  | 'RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_SEQ'
  | 'RECOVERY_ARCHIVE_SOURCE_HASH_SEQ_MISMATCH'

/** Values-free failure surface for Phase D2d2-PREP-B source-hash canonicalization. */
export class RecoveryArchiveSourceHashError extends Error {
  readonly code: RecoveryArchiveSourceHashErrorCode

  constructor(code: RecoveryArchiveSourceHashErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveSourceHashError'
    this.code = code
  }
}

export interface RecoveryArchiveSourceHash {
  sourceId: string
  sourceSeq: string | null
  preimage: string
  hash: string
}

/** D2d2-PREP-B only: no production caller currently makes source-hash behavior reachable. */
export function computeRecoveryArchiveSourceHash(
  sourceKind: unknown,
  row: unknown,
  sourceSeq: unknown,
): RecoveryArchiveSourceHash {
  if (!isRecoveryArchiveCoverageSourceKind(sourceKind)) {
    throwSourceHashError('RECOVERY_ARCHIVE_SOURCE_HASH_UNKNOWN_KIND')
  }

  const spec = KIND_SPEC[sourceKind]
  const snapshot = snapshotExactRow(row, spec.keys)
  const sourceId = encodeSourceId(readIdentity(spec.identity, snapshot))
  const canonicalSeq = readCanonicalSourceSeq(spec.seqField, snapshot, sourceSeq)
  const bodyJson = canonicalizeOrThrow(
    {
      format_version: RECOVERY_ARCHIVE_SOURCE_HASH_FORMAT_VERSION,
      source_kind: sourceKind,
      source_id: sourceId,
      source_seq: canonicalSeq,
      row: snapshot,
    },
    'RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_ROW',
  )
  const preimage = `${RECOVERY_ARCHIVE_SOURCE_HASH_DOMAIN}\u0000${bodyJson}`
  return {
    sourceId,
    sourceSeq: canonicalSeq,
    preimage,
    hash: createHash('sha256').update(preimage, 'utf8').digest('hex'),
  }
}

function readIdentity(
  identityKeys: readonly string[],
  row: Record<string, unknown>,
): Record<string, unknown> {
  const identity: Record<string, unknown> = Object.create(null)
  for (const key of identityKeys) {
    identity[key] = key === 'ordinal' ? requireIdentityOrdinal(row[key]) : requireIdentityString(row[key])
  }
  return identity
}

function requireIdentityString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throwSourceHashError('RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_IDENTITY')
  }
  return value
}

function requireIdentityOrdinal(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throwSourceHashError('RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_IDENTITY')
  }
  return value
}

function readCanonicalSourceSeq(
  seqField: string | null,
  row: Record<string, unknown>,
  sourceSeq: unknown,
): string | null {
  const canonicalSeq = parseOptionalPositiveDecimal(sourceSeq)
  if (seqField === null) return canonicalSeq
  const rowSeq = parseOptionalPositiveDecimal(row[seqField])
  if (rowSeq === null) throwSourceHashError('RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_SEQ')
  if (canonicalSeq !== rowSeq) throwSourceHashError('RECOVERY_ARCHIVE_SOURCE_HASH_SEQ_MISMATCH')
  return rowSeq
}

function parseOptionalPositiveDecimal(value: unknown): string | null {
  if (value === null) return null
  if (!isPositiveDecimalString(value)) throwSourceHashError('RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_SEQ')
  return value
}

function encodeSourceId(identity: Record<string, unknown>): string {
  const encoded = Buffer.from(
    canonicalizeOrThrow(identity, 'RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_IDENTITY'),
    'utf8',
  ).toString('base64url')
  return `v${RECOVERY_ARCHIVE_SOURCE_HASH_FORMAT_VERSION}.${encoded}`
}

function canonicalizeOrThrow(
  value: unknown,
  code: RecoveryArchiveSourceHashErrorCode,
): string {
  try {
    return canonicalizeRecoveryArchiveJson(value)
  } catch (error) {
    if (error instanceof RecoveryArchiveManifestError) throwSourceHashError(code)
    throw error
  }
}

function snapshotExactRow(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> {
  const snapshot = snapshotPlainRecord(value)
  const keys = Object.keys(snapshot)
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throwSourceHashError('RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_KEYS')
  }
  return snapshot
}

function snapshotPlainRecord(value: unknown): Record<string, unknown> {
  try {
    if (!isRecord(value)) throwSourceHashError('RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_ROW')
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throwSourceHashError('RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_ROW')
    }
    const snapshot: Record<string, unknown> = Object.create(null)
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined) throwSourceHashError('RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_ROW')
      if (!descriptor.enumerable) continue
      if (typeof key === 'symbol' || !('value' in descriptor)) {
        throwSourceHashError('RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_ROW')
      }
      snapshot[key] = descriptor.value
    }
    return snapshot
  } catch (error) {
    if (error instanceof RecoveryArchiveSourceHashError) throw error
    throwSourceHashError('RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_ROW')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  try {
    return !Array.isArray(value)
  } catch {
    return false
  }
}

function throwSourceHashError(code: RecoveryArchiveSourceHashErrorCode): never {
  throw new RecoveryArchiveSourceHashError(code)
}
