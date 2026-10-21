/**
 * Time Machine Phase D2c only: dedicated internal section-causality seal helpers.
 *
 * This module has no production caller. It does not mint archive bytes, flip
 * MULTITABLE_RECOVERY_ARCHIVE_ENABLED, or expose a request-callable route.
 * Generic ordinary sealing remains `sealOperation` in operation-ledger.ts and
 * cannot mint zero-direct-event synthetic kinds or section_bootstrap.
 */

import {
  assertCanonicalNonnegativeDecimalString,
  assertLowercaseSha256Hex,
  assertPositiveDecimalString,
  RECOVERY_ARCHIVE_V1_SECTION_NAMES,
  type RecoveryArchiveSectionName,
} from './recovery-archive-contract'

export const SECTION_CAUSALITY_EVENT_CONTRACT_V1 = 1 as const
export const SECTION_CAUSALITY_EVENT_CONTRACT_V2 = 2 as const
export const SECTION_CAUSALITY_INT4_MAX = 2147483647 as const

export const SECTION_CAUSALITY_OPERATION_KINDS = [
  'ordinary',
  'section_bootstrap',
  'archive_snapshot',
  'restore_chunk',
  'restore_aggregate',
] as const

export const SECTION_CAUSALITY_DIRECT_EVENT_KINDS = ['ordinary', 'section_bootstrap', 'restore_chunk'] as const

export const SECTION_CAUSALITY_GENERIC_SEAL_KINDS = ['ordinary', 'restore_chunk'] as const

export const SECTION_CAUSALITY_ZERO_DIRECT_EVENT_KINDS = ['archive_snapshot', 'restore_aggregate'] as const

export const SECTION_CAUSALITY_SECTION_ACTIONS = ['bootstrap_snapshot', 'upsert', 'delete'] as const

export const SECTION_CAUSALITY_DATA_SECTION_KINDS = RECOVERY_ARCHIVE_V1_SECTION_NAMES.filter(
  (name): name is Exclude<RecoveryArchiveSectionName, 'coverage_index'> => name !== 'coverage_index',
)

export const SECTION_CAUSALITY_SOURCE_HEAD_KINDS = [
  'section_bootstrap',
  'ordinary',
  'restore_chunk',
  'restore_aggregate',
] as const

/** D2c callable snapshot seal accepts only payload-bound bootstrap heads. */
export const SECTION_CAUSALITY_D2C_SNAPSHOT_SOURCE_HEAD_KINDS = ['section_bootstrap'] as const

export type SectionCausalityOperationKind = (typeof SECTION_CAUSALITY_OPERATION_KINDS)[number]
export type SectionCausalityDirectEventKind = (typeof SECTION_CAUSALITY_DIRECT_EVENT_KINDS)[number]
export type SectionCausalityGenericSealKind = (typeof SECTION_CAUSALITY_GENERIC_SEAL_KINDS)[number]
export type SectionCausalityZeroDirectEventKind = (typeof SECTION_CAUSALITY_ZERO_DIRECT_EVENT_KINDS)[number]
export type SectionCausalitySectionAction = (typeof SECTION_CAUSALITY_SECTION_ACTIONS)[number]
export type SectionCausalityDataSectionKind = (typeof SECTION_CAUSALITY_DATA_SECTION_KINDS)[number]
export type SectionCausalitySourceHeadKind = (typeof SECTION_CAUSALITY_SOURCE_HEAD_KINDS)[number]
export type SectionCausalityD2cSnapshotSourceHeadKind =
  (typeof SECTION_CAUSALITY_D2C_SNAPSHOT_SOURCE_HEAD_KINDS)[number]

export type SealQuery = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export type RecoveryArchiveSealErrorCode =
  | 'SECTION_CAUSALITY_SYNTHETIC_KIND_FORBIDDEN'
  | 'SECTION_CAUSALITY_BOOTSTRAP_HELPER_REQUIRED'
  | 'SECTION_CAUSALITY_BOOTSTRAP_EVENT_MISMATCH'
  | 'SECTION_CAUSALITY_INVALID_OPERATION_KIND'
  | 'SECTION_CAUSALITY_INVALID_SECTION_KIND'
  | 'SECTION_CAUSALITY_INVALID_SECTION_ACTION'
  | 'SECTION_CAUSALITY_INVALID_SOURCE_HEAD_KIND'
  | 'SECTION_CAUSALITY_INVALID_MEMBERSHIP'
  | 'SECTION_CAUSALITY_INVALID_EVENT_COUNT'
  | 'SECTION_CAUSALITY_PARENT_SEQ_NOT_GREATER'
  | 'SECTION_CAUSALITY_RECORDS_REQUIRES_BOOTSTRAP'
  | 'SECTION_CAUSALITY_SNAPSHOT_SOURCE_UNFINALIZED'
  | 'SECTION_CAUSALITY_SOURCE_HEAD_MISMATCH'

export class RecoveryArchiveSealError extends Error {
  readonly code: RecoveryArchiveSealErrorCode

  constructor(code: RecoveryArchiveSealErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveSealError'
    this.code = code
  }
}

export interface DirectEventSealInput {
  sheetId: string
  operationId: string
  endpointSeq: string
  eventCount: number
  operationKind: string
}

export interface SectionBootstrapSealInput {
  sheetId: string
  operationId: string
  endpointSeq: string
  sectionKind: string
  rowCount: string
  sourceHash: string
}

export interface ArchiveSnapshotMemberInput {
  ordinal: number
  sectionKind: string
  sourceHeadKind: string
  sourceOperationId: string
  sourceHeadSeq: string
  rowCount: string
  sourceHash: string
}

export interface ArchiveSnapshotSealInput {
  sheetId: string
  operationId: string
  endpointSeq: string
  members: readonly ArchiveSnapshotMemberInput[]
}

export interface RestoreAggregateMemberInput {
  ordinal: number
  childOperationId: string
  childEndpointSeq: string
  childEventCount: number
}

export interface RestoreAggregateSealInput {
  sheetId: string
  operationId: string
  endpointSeq: string
  members: readonly RestoreAggregateMemberInput[]
}

type BootstrapEventRow = {
  section_kind: unknown
  action: unknown
  seq: unknown
  row_count: unknown
  source_hash: unknown
}

export function isSectionCausalityOperationKind(value: unknown): value is SectionCausalityOperationKind {
  return isClosedValue(SECTION_CAUSALITY_OPERATION_KINDS, value)
}

export function isSectionCausalityDirectEventKind(value: unknown): value is SectionCausalityDirectEventKind {
  return isClosedValue(SECTION_CAUSALITY_DIRECT_EVENT_KINDS, value)
}

export function isSectionCausalityGenericSealKind(value: unknown): value is SectionCausalityGenericSealKind {
  return isClosedValue(SECTION_CAUSALITY_GENERIC_SEAL_KINDS, value)
}

export function isSectionCausalityZeroDirectEventKind(value: unknown): value is SectionCausalityZeroDirectEventKind {
  return isClosedValue(SECTION_CAUSALITY_ZERO_DIRECT_EVENT_KINDS, value)
}

export function isSectionCausalitySectionAction(value: unknown): value is SectionCausalitySectionAction {
  return isClosedValue(SECTION_CAUSALITY_SECTION_ACTIONS, value)
}

export function isSectionCausalityDataSectionKind(value: unknown): value is SectionCausalityDataSectionKind {
  return isClosedValue(SECTION_CAUSALITY_DATA_SECTION_KINDS, value)
}

export function isSectionCausalitySourceHeadKind(value: unknown): value is SectionCausalitySourceHeadKind {
  return isClosedValue(SECTION_CAUSALITY_SOURCE_HEAD_KINDS, value)
}

export function isD2cSnapshotSourceHeadKind(value: unknown): value is SectionCausalityD2cSnapshotSourceHeadKind {
  return isClosedValue(SECTION_CAUSALITY_D2C_SNAPSHOT_SOURCE_HEAD_KINDS, value)
}

export function assertSectionCausalityOperationKind(value: unknown): asserts value is SectionCausalityOperationKind {
  if (!isSectionCausalityOperationKind(value)) {
    throw new RecoveryArchiveSealError('SECTION_CAUSALITY_INVALID_OPERATION_KIND')
  }
}

export function assertDirectEventOperationKind(value: unknown): asserts value is SectionCausalityGenericSealKind {
  if (value === 'section_bootstrap') {
    throw new RecoveryArchiveSealError('SECTION_CAUSALITY_BOOTSTRAP_HELPER_REQUIRED')
  }
  if (isSectionCausalityZeroDirectEventKind(value)) {
    throw new RecoveryArchiveSealError('SECTION_CAUSALITY_SYNTHETIC_KIND_FORBIDDEN')
  }
  if (!isSectionCausalityGenericSealKind(value)) {
    throw new RecoveryArchiveSealError('SECTION_CAUSALITY_INVALID_OPERATION_KIND')
  }
}

export function assertSectionCausalityDataSectionKind(
  value: unknown,
): asserts value is SectionCausalityDataSectionKind {
  if (!isSectionCausalityDataSectionKind(value)) {
    throw new RecoveryArchiveSealError('SECTION_CAUSALITY_INVALID_SECTION_KIND')
  }
}

export function assertSectionCausalitySectionAction(value: unknown): asserts value is SectionCausalitySectionAction {
  if (!isSectionCausalitySectionAction(value)) {
    throw new RecoveryArchiveSealError('SECTION_CAUSALITY_INVALID_SECTION_ACTION')
  }
}

export function assertRecordsSectionUsesBootstrap(sectionKind: unknown, action: unknown): void {
  if (sectionKind === 'records' && action !== 'bootstrap_snapshot') {
    throw new RecoveryArchiveSealError('SECTION_CAUSALITY_RECORDS_REQUIRES_BOOTSTRAP')
  }
}

export function bootstrapSectionEntityKey(sectionKind: SectionCausalityDataSectionKind): string {
  return `section/${sectionKind}`
}

export function sumCheckedInt4EventCounts(counts: readonly number[]): number {
  let sum = 0
  for (const count of counts) {
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > SECTION_CAUSALITY_INT4_MAX) {
      throw new RecoveryArchiveSealError('SECTION_CAUSALITY_INVALID_EVENT_COUNT')
    }
    if (sum > SECTION_CAUSALITY_INT4_MAX - count) {
      throw new RecoveryArchiveSealError('SECTION_CAUSALITY_INVALID_EVENT_COUNT')
    }
    sum += count
    if (!Number.isSafeInteger(sum)) {
      throw new RecoveryArchiveSealError('SECTION_CAUSALITY_INVALID_EVENT_COUNT')
    }
  }
  return sum
}

/**
 * Generic v2 direct-event seal for ordinary and restore_chunk only.
 * Refuses archive_snapshot, restore_aggregate, and section_bootstrap.
 */
export async function sealDirectEventOperation(query: SealQuery, input: DirectEventSealInput): Promise<void> {
  assertDirectEventOperationKind(input.operationKind)
  assertNonEmptyId(input.sheetId)
  assertNonEmptyId(input.operationId)
  assertPositiveDecimalString(input.endpointSeq)
  assertEventCount(input.eventCount)
  await query(
    `INSERT INTO meta_record_history_operations (
       sheet_id, operation_id, endpoint_seq, event_count,
       operation_kind, event_contract_version, component_count
     ) VALUES ($1, $2::uuid, $3::bigint, $4::int, $5, $6::int, NULL)`,
    [
      input.sheetId,
      input.operationId,
      input.endpointSeq,
      input.eventCount,
      input.operationKind,
      SECTION_CAUSALITY_EVENT_CONTRACT_V2,
    ],
  )
}

export async function sealSectionBootstrapOperation(query: SealQuery, input: SectionBootstrapSealInput): Promise<void> {
  const { sheetId, operationId, endpointSeq, sectionKind, rowCount, sourceHash } = input
  assertNonEmptyId(sheetId)
  assertNonEmptyId(operationId)
  assertPositiveDecimalString(endpointSeq)
  assertSectionCausalityDataSectionKind(sectionKind)
  assertCanonicalNonnegativeDecimalString(rowCount)
  assertLowercaseSha256Hex(sourceHash)
  const captured = await query(
    `SELECT section_kind, action, seq::text AS seq,
            payload->>'row_count' AS row_count,
            payload->>'source_hash' AS source_hash
       FROM meta_sheet_section_revisions
      WHERE sheet_id = $1 AND operation_id = $2::uuid`,
    [sheetId, operationId],
  )
  const rows = captured.rows as BootstrapEventRow[]
  if (
    rows.length !== 1 ||
    rows[0]?.section_kind !== sectionKind ||
    rows[0]?.action !== 'bootstrap_snapshot' ||
    rows[0]?.seq !== endpointSeq ||
    rows[0]?.row_count !== rowCount ||
    rows[0]?.source_hash !== sourceHash
  ) {
    throw new RecoveryArchiveSealError('SECTION_CAUSALITY_BOOTSTRAP_EVENT_MISMATCH')
  }
  await query(
    `INSERT INTO meta_record_history_operations (
       sheet_id, operation_id, endpoint_seq, event_count,
       operation_kind, event_contract_version, component_count
     ) VALUES ($1, $2::uuid, $3::bigint, 1, 'section_bootstrap', $4::int, NULL)`,
    [sheetId, operationId, endpointSeq, SECTION_CAUSALITY_EVENT_CONTRACT_V2],
  )
}

export async function sealArchiveSnapshotOperation(query: SealQuery, input: ArchiveSnapshotSealInput): Promise<void> {
  const { sheetId, operationId, endpointSeq } = input
  assertNonEmptyId(sheetId)
  assertNonEmptyId(operationId)
  assertPositiveDecimalString(endpointSeq)
  const members = normalizeSnapshotMembers(input.members, endpointSeq)
  await assertSnapshotMembersMatchBootstrapEndpoints(query, sheetId, members)
  for (const member of members) {
    await query(
      `INSERT INTO meta_record_history_snapshot_members (
         sheet_id, parent_operation_id, ordinal, section_kind, source_head_kind,
         source_operation_id, source_head_seq, row_count, source_hash
       ) VALUES (
         $1, $2::uuid, $3::int, $4, $5,
         $6::uuid, $7::bigint, $8::bigint, $9
       )`,
      [
        sheetId,
        operationId,
        member.ordinal,
        member.sectionKind,
        member.sourceHeadKind,
        member.sourceOperationId,
        member.sourceHeadSeq,
        member.rowCount,
        member.sourceHash,
      ],
    )
  }
  await query(
    `INSERT INTO meta_record_history_operations (
       sheet_id, operation_id, endpoint_seq, event_count,
       operation_kind, event_contract_version, component_count
     ) VALUES ($1, $2::uuid, $3::bigint, 0, 'archive_snapshot', $4::int, $5::int)`,
    [sheetId, operationId, endpointSeq, SECTION_CAUSALITY_EVENT_CONTRACT_V2, members.length],
  )
}

export async function sealRestoreAggregateOperation(query: SealQuery, input: RestoreAggregateSealInput): Promise<void> {
  const { sheetId, operationId, endpointSeq } = input
  assertNonEmptyId(sheetId)
  assertNonEmptyId(operationId)
  assertPositiveDecimalString(endpointSeq)
  const members = normalizeAggregateMembers(input.members, endpointSeq)
  const eventCount = sumCheckedInt4EventCounts(members.map((member) => member.childEventCount))
  for (const member of members) {
    await query(
      `INSERT INTO meta_record_history_operation_members (
         sheet_id, parent_operation_id, ordinal, child_operation_id,
         child_endpoint_seq, child_event_count
       ) VALUES ($1, $2::uuid, $3::int, $4::uuid, $5::bigint, $6::int)`,
      [
        sheetId,
        operationId,
        member.ordinal,
        member.childOperationId,
        member.childEndpointSeq,
        member.childEventCount,
      ],
    )
  }
  await query(
    `INSERT INTO meta_record_history_operations (
       sheet_id, operation_id, endpoint_seq, event_count,
       operation_kind, event_contract_version, component_count
     ) VALUES ($1, $2::uuid, $3::bigint, $4::int, 'restore_aggregate', $5::int, $6::int)`,
    [
      sheetId,
      operationId,
      endpointSeq,
      eventCount,
      SECTION_CAUSALITY_EVENT_CONTRACT_V2,
      members.length,
    ],
  )
}

function normalizeSnapshotMembers(
  members: readonly ArchiveSnapshotMemberInput[],
  parentSeq: string,
): ArchiveSnapshotMemberInput[] {
  if (members.length !== SECTION_CAUSALITY_DATA_SECTION_KINDS.length) {
    throw new RecoveryArchiveSealError('SECTION_CAUSALITY_INVALID_MEMBERSHIP')
  }
  const parent = BigInt(parentSeq)
  return members.map((member, index) => {
    const ordinal = index + 1
    if (member.ordinal !== ordinal) {
      throw new RecoveryArchiveSealError('SECTION_CAUSALITY_INVALID_MEMBERSHIP')
    }
    if (member.sectionKind !== SECTION_CAUSALITY_DATA_SECTION_KINDS[index]) {
      throw new RecoveryArchiveSealError('SECTION_CAUSALITY_INVALID_SECTION_KIND')
    }
    if (!isSectionCausalitySourceHeadKind(member.sourceHeadKind)) {
      throw new RecoveryArchiveSealError('SECTION_CAUSALITY_INVALID_SOURCE_HEAD_KIND')
    }
    if (!isD2cSnapshotSourceHeadKind(member.sourceHeadKind)) {
      throw new RecoveryArchiveSealError('SECTION_CAUSALITY_SNAPSHOT_SOURCE_UNFINALIZED')
    }
    assertNonEmptyId(member.sourceOperationId)
    assertPositiveDecimalString(member.sourceHeadSeq)
    if (BigInt(member.sourceHeadSeq) >= parent) {
      throw new RecoveryArchiveSealError('SECTION_CAUSALITY_PARENT_SEQ_NOT_GREATER')
    }
    assertCanonicalNonnegativeDecimalString(member.rowCount)
    assertLowercaseSha256Hex(member.sourceHash)
    return { ...member }
  })
}

type SourceEndpointRow = {
  operation_id: unknown
  operation_kind: unknown
  endpoint_seq: unknown
  section_kind: unknown
}

async function assertSnapshotMembersMatchBootstrapEndpoints(
  query: SealQuery,
  sheetId: string,
  members: readonly ArchiveSnapshotMemberInput[],
): Promise<void> {
  const sourceIds = members.map((member) => member.sourceOperationId)
  const result = await query(
    `SELECT operation_row.operation_id::text AS operation_id,
            operation_row.operation_kind,
            operation_row.endpoint_seq::text AS endpoint_seq,
            revision_row.section_kind
       FROM meta_record_history_operations operation_row
       LEFT JOIN meta_sheet_section_revisions revision_row
         ON revision_row.sheet_id = operation_row.sheet_id
        AND revision_row.operation_id = operation_row.operation_id
      WHERE operation_row.sheet_id = $1 AND operation_row.operation_id = ANY($2::uuid[])`,
    [sheetId, sourceIds],
  )
  const byId = new Map((result.rows as SourceEndpointRow[]).map((row) => [String(row.operation_id), row]))
  for (const member of members) {
    const head = byId.get(member.sourceOperationId)
    if (
      !head ||
      head.operation_kind !== 'section_bootstrap' ||
      head.endpoint_seq !== member.sourceHeadSeq ||
      head.section_kind !== member.sectionKind
    ) {
      throw new RecoveryArchiveSealError('SECTION_CAUSALITY_SOURCE_HEAD_MISMATCH')
    }
  }
}

function normalizeAggregateMembers(
  members: readonly RestoreAggregateMemberInput[],
  parentSeq: string,
): RestoreAggregateMemberInput[] {
  if (members.length < 1) {
    throw new RecoveryArchiveSealError('SECTION_CAUSALITY_INVALID_MEMBERSHIP')
  }
  const parent = BigInt(parentSeq)
  let maxChild = 0n
  const seen = new Set<string>()
  const normalized = members.map((member, index) => {
    const ordinal = index + 1
    if (member.ordinal !== ordinal) {
      throw new RecoveryArchiveSealError('SECTION_CAUSALITY_INVALID_MEMBERSHIP')
    }
    assertNonEmptyId(member.childOperationId)
    if (seen.has(member.childOperationId)) {
      throw new RecoveryArchiveSealError('SECTION_CAUSALITY_INVALID_MEMBERSHIP')
    }
    seen.add(member.childOperationId)
    assertPositiveDecimalString(member.childEndpointSeq)
    assertEventCount(member.childEventCount)
    const childSeq = BigInt(member.childEndpointSeq)
    if (childSeq > maxChild) maxChild = childSeq
    return { ...member }
  })
  sumCheckedInt4EventCounts(normalized.map((member) => member.childEventCount))
  if (maxChild !== parent) {
    throw new RecoveryArchiveSealError('SECTION_CAUSALITY_PARENT_SEQ_NOT_GREATER')
  }
  return normalized
}

function assertNonEmptyId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim() !== value) {
    throw new RecoveryArchiveSealError('SECTION_CAUSALITY_INVALID_MEMBERSHIP')
  }
}

function assertEventCount(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > SECTION_CAUSALITY_INT4_MAX) {
    throw new RecoveryArchiveSealError('SECTION_CAUSALITY_INVALID_EVENT_COUNT')
  }
}

function isClosedValue<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T)
}
