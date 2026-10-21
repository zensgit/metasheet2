/**
 * Pure domain-separated source identities: bootstrap v1 and checkpoint v2.
 *
 * No runtime route reaches the checkpoint preparation function yet. It does not include
 * row_count or source_hash (those exist only after later RR capture/root), and
 * it does not invent provider or object identity.
 */

import { createHash } from 'node:crypto'

import { isPositiveDecimalString } from './recovery-archive-contract'
import {
  canonicalizeRecoveryArchiveJson,
  RecoveryArchiveManifestError,
} from './recovery-archive-manifest'
import {
  isSectionCausalityDataSectionKind,
  SECTION_CAUSALITY_DATA_SECTION_KINDS,
  type SectionCausalityDataSectionKind,
  type SectionCausalityD2cSnapshotSourceHeadKind,
} from './recovery-archive-seals'

export const RECOVERY_ARCHIVE_SOURCE_VECTOR_DOMAIN =
  'metasheet2:multitable:recovery-archive:source-vector:v1' as const

export const RECOVERY_ARCHIVE_SOURCE_VECTOR_FORMAT_VERSION = 1 as const

export const RECOVERY_ARCHIVE_CHECKPOINT_VECTOR_DOMAIN =
  'metasheet2:multitable:recovery-archive:source-vector:v2' as const
export const RECOVERY_ARCHIVE_CHECKPOINT_VECTOR_FORMAT_VERSION = 2 as const

export const RECOVERY_ARCHIVE_SOURCE_VECTOR_HEAD_KEYS = Object.freeze([
  'sourceHeadKind',
  'sectionKind',
  'operationId',
  'headSeq',
] as const)

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEAD_COUNT = SECTION_CAUSALITY_DATA_SECTION_KINDS.length

export type RecoveryArchiveSourceVectorErrorCode =
  | 'RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_HEADS'
  | 'RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_HEAD'
  | 'RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_KEYS'
  | 'RECOVERY_ARCHIVE_SOURCE_VECTOR_UNKNOWN_KIND'
  | 'RECOVERY_ARCHIVE_SOURCE_VECTOR_DUPLICATE_IDENTITY'
  | 'RECOVERY_ARCHIVE_SOURCE_VECTOR_SECTION_MISMATCH'

/** Values-free failure surface for D2 source-vector canonicalization. */
export class RecoveryArchiveSourceVectorError extends Error {
  readonly code: RecoveryArchiveSourceVectorErrorCode

  constructor(code: RecoveryArchiveSourceVectorErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveSourceVectorError'
    this.code = code
  }
}

type SourceKind = SectionCausalityD2cSnapshotSourceHeadKind | 'section_checkpoint'
interface SourceHead<K extends SourceKind> {
  readonly sourceHeadKind: K
  readonly sectionKind: SectionCausalityDataSectionKind
  readonly operationId: string
  readonly headSeq: string
}

export type RecoveryArchiveSourceVectorHead = SourceHead<SectionCausalityD2cSnapshotSourceHeadKind>
export type RecoveryArchiveCheckpointVectorHead = SourceHead<'section_checkpoint'>

interface SourceVector<V extends 1 | 2, K extends SourceKind> {
  readonly formatVersion: V
  readonly heads: readonly SourceHead<K>[]
  readonly preimage: string
  readonly hash: string
}
export type RecoveryArchiveSourceVector = SourceVector<1, SectionCausalityD2cSnapshotSourceHeadKind>
export type RecoveryArchiveCheckpointVector = SourceVector<2, 'section_checkpoint'>

/** D2 only: no runtime route currently makes source-vector behavior reachable. */
export function computeRecoveryArchiveSourceVectorHash(heads: unknown): RecoveryArchiveSourceVector {
  return computeVector(heads, 'section_bootstrap', RECOVERY_ARCHIVE_SOURCE_VECTOR_FORMAT_VERSION, RECOVERY_ARCHIVE_SOURCE_VECTOR_DOMAIN)
}

/** Identity preparation only; does not authorize or prove a checkpoint seal.
 * Database checkpoint admission must be implemented before any runtime caller.
 */
export function computeRecoveryArchiveCheckpointVectorHash(heads: unknown): RecoveryArchiveCheckpointVector {
  return computeVector(heads, 'section_checkpoint', RECOVERY_ARCHIVE_CHECKPOINT_VECTOR_FORMAT_VERSION, RECOVERY_ARCHIVE_CHECKPOINT_VECTOR_DOMAIN)
}

function computeVector<V extends 1 | 2, K extends SourceKind>(
  heads: unknown, sourceKind: K, formatVersion: V, domain: string,
): SourceVector<V, K> {
  const canonicalHeads = admitHeads(snapshotHeads(heads), sourceKind)
  const bodyJson = canonicalizeOrThrow({
    format_version: formatVersion,
    heads: canonicalHeads.map((head) => ({
      source_head_kind: head.sourceHeadKind,
      section_kind: head.sectionKind,
      operation_id: head.operationId,
      head_seq: head.headSeq,
    })),
  })
  const preimage = `${domain}\u0000${bodyJson}`
  return Object.freeze({
    formatVersion,
    heads: Object.freeze(canonicalHeads.map(freezeHead)),
    preimage,
    hash: createHash('sha256').update(preimage, 'utf8').digest('hex'),
  })
}

function admitHeads<K extends SourceKind>(values: readonly unknown[], sourceKind: K): SourceHead<K>[] {
  const seenOperations = new Set<string>()
  const seenSeqs = new Set<string>()
  return values.map((value, index) => {
    const snapshot = snapshotExactRecord(
      value,
      RECOVERY_ARCHIVE_SOURCE_VECTOR_HEAD_KEYS,
      'RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_HEAD',
      'RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_KEYS',
    )
    if (snapshot.sourceHeadKind !== sourceKind) {
      throwSourceVectorError('RECOVERY_ARCHIVE_SOURCE_VECTOR_UNKNOWN_KIND')
    }
    if (!isSectionCausalityDataSectionKind(snapshot.sectionKind)) {
      throwSourceVectorError('RECOVERY_ARCHIVE_SOURCE_VECTOR_UNKNOWN_KIND')
    }
    const expectedKind = SECTION_CAUSALITY_DATA_SECTION_KINDS[index]
    if (expectedKind === undefined || snapshot.sectionKind !== expectedKind) {
      throwSourceVectorError('RECOVERY_ARCHIVE_SOURCE_VECTOR_SECTION_MISMATCH')
    }
    if (typeof snapshot.operationId !== 'string' || !UUID_PATTERN.test(snapshot.operationId)) {
      throwSourceVectorError('RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_HEAD')
    }
    if (!isPositiveDecimalString(snapshot.headSeq)) {
      throwSourceVectorError('RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_HEAD')
    }
    if (seenOperations.has(snapshot.operationId) || seenSeqs.has(snapshot.headSeq)) {
      throwSourceVectorError('RECOVERY_ARCHIVE_SOURCE_VECTOR_DUPLICATE_IDENTITY')
    }
    seenOperations.add(snapshot.operationId)
    seenSeqs.add(snapshot.headSeq)
    return {
      sourceHeadKind: sourceKind,
      sectionKind: snapshot.sectionKind,
      operationId: snapshot.operationId,
      headSeq: snapshot.headSeq,
    }
  })
}

function freezeHead<K extends SourceKind>(head: SourceHead<K>): SourceHead<K> {
  return Object.freeze({
    sourceHeadKind: head.sourceHeadKind,
    sectionKind: head.sectionKind,
    operationId: head.operationId,
    headSeq: head.headSeq,
  })
}

function snapshotHeads(value: unknown): unknown[] {
  try {
    if (!Array.isArray(value)) throwSourceVectorError('RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_HEADS')
    const keys = Reflect.ownKeys(value)
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (
      lengthDescriptor === undefined ||
      !('value' in lengthDescriptor) ||
      typeof lengthDescriptor.value !== 'number' ||
      !Number.isInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      throwSourceVectorError('RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_HEADS')
    }
    const length = lengthDescriptor.value
    if (length !== HEAD_COUNT) {
      throwSourceVectorError('RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_HEADS')
    }
    const elements = new Array<unknown>(length)
    const seenIndices = new Set<number>()
    for (const key of keys) {
      if (key === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined) throwSourceVectorError('RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_HEADS')
      if (!descriptor.enumerable) continue
      if (typeof key === 'symbol' || !('value' in descriptor)) {
        throwSourceVectorError('RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_HEADS')
      }
      const index = Number(key)
      if (
        !Number.isInteger(index) ||
        String(index) !== key ||
        index < 0 ||
        index >= length ||
        seenIndices.has(index)
      ) {
        throwSourceVectorError('RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_HEADS')
      }
      seenIndices.add(index)
      elements[index] = descriptor.value
    }
    if (seenIndices.size !== length) throwSourceVectorError('RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_HEADS')
    return elements
  } catch (error) {
    if (error instanceof RecoveryArchiveSourceVectorError) throw error
    throwSourceVectorError('RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_HEADS')
  }
}

function snapshotExactRecord(
  value: unknown,
  expected: readonly string[],
  invalidCode: RecoveryArchiveSourceVectorErrorCode,
  keysCode: RecoveryArchiveSourceVectorErrorCode,
): Record<string, unknown> {
  const snapshot = snapshotPlainRecord(value, invalidCode)
  const keys = Object.keys(snapshot)
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throwSourceVectorError(keysCode)
  }
  return snapshot
}

function snapshotPlainRecord(
  value: unknown,
  errorCode: RecoveryArchiveSourceVectorErrorCode,
): Record<string, unknown> {
  try {
    if (!isRecord(value)) throwSourceVectorError(errorCode)
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throwSourceVectorError(errorCode)
    }
    const snapshot: Record<string, unknown> = Object.create(null)
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined) throwSourceVectorError(errorCode)
      if (!descriptor.enumerable) continue
      if (typeof key === 'symbol' || !('value' in descriptor)) {
        throwSourceVectorError(errorCode)
      }
      snapshot[key] = descriptor.value
    }
    return snapshot
  } catch (error) {
    if (error instanceof RecoveryArchiveSourceVectorError) throw error
    throwSourceVectorError(errorCode)
  }
}

function canonicalizeOrThrow(value: unknown): string {
  try {
    return canonicalizeRecoveryArchiveJson(value)
  } catch (error) {
    if (error instanceof RecoveryArchiveManifestError) {
      throwSourceVectorError('RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_HEAD')
    }
    throw error
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

function throwSourceVectorError(code: RecoveryArchiveSourceVectorErrorCode): never {
  throw new RecoveryArchiveSourceVectorError(code)
}
