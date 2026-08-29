import { isMultitableRecoveryArchiveEnabled } from './recovery-archive-contract'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const NONNEGATIVE_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100
const MAX_CURSOR_LENGTH = 512

export type RecoveryArchiveCatalogErrorCode =
  | 'RECOVERY_ARCHIVE_CATALOG_INVALID_INPUT'
  | 'RECOVERY_ARCHIVE_CATALOG_DISABLED'
  | 'RECOVERY_ARCHIVE_CATALOG_AUTHORITY_DENIED'
  | 'RECOVERY_ARCHIVE_CATALOG_NOT_FOUND'
  | 'RECOVERY_ARCHIVE_CATALOG_PERSISTENCE_INVALID'

export class RecoveryArchiveCatalogError extends Error {
  readonly code: RecoveryArchiveCatalogErrorCode

  constructor(code: RecoveryArchiveCatalogErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveCatalogError'
    this.code = code
  }
}

export type RecoveryArchiveCatalogQuery = (
  text: string,
  values?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export type RecoveryArchiveCatalogTransaction = <T>(
  work: (query: RecoveryArchiveCatalogQuery) => Promise<T>,
) => Promise<T>

export interface RecoveryArchiveCatalogContext {
  readonly workspaceId: string
  readonly baseId: string
  readonly sheetId: string
  readonly recheckAuthority: (query: RecoveryArchiveCatalogQuery) => Promise<boolean>
}

export interface RecoveryArchiveCatalogEntry {
  readonly generationId: string
  readonly recoveryPointAt: string
  readonly archivedAt: string
  readonly expiresAt: string
  readonly anchorSeq: string
  readonly coverageRowCount: string
  readonly superseded: boolean
}

export interface ListRecoveryArchiveCatalogInput extends RecoveryArchiveCatalogContext {
  readonly cursor?: string
  readonly limit?: number
  readonly env?: NodeJS.ProcessEnv
}

export interface ReadRecoveryArchiveCatalogInput extends RecoveryArchiveCatalogContext {
  readonly generationId: string
  readonly env?: NodeJS.ProcessEnv
}

export interface RecoveryArchiveCatalogPage {
  readonly entries: readonly RecoveryArchiveCatalogEntry[]
  readonly nextCursor: string | null
}

type CatalogRow = {
  generation_id?: unknown
  recovery_point_at?: unknown
  archived_at?: unknown
  expires_at?: unknown
  anchor_seq?: unknown
  coverage_row_count?: unknown
  superseded?: unknown
}

type CatalogCursor = {
  recoveryPointAt: string
  generationId: string
}

export async function listRecoveryArchiveCatalog(
  transaction: RecoveryArchiveCatalogTransaction,
  input: ListRecoveryArchiveCatalogInput,
): Promise<RecoveryArchiveCatalogPage> {
  const normalized = normalizeContext(input)
  assertEnabled(input.env)
  const limit = normalizeLimit(input.limit)
  const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor)

  return transaction(async (query) => {
    await assertAuthority(query, input.recheckAuthority)
    const values: unknown[] = [
      normalized.workspaceId,
      normalized.baseId,
      normalized.sheetId,
    ]
    const cursorSql = cursor
      ? `AND (anchor_operation.created_at, archive.generation_id)
             < ($4::timestamptz, $5::uuid)`
      : ''
    if (cursor) values.push(cursor.recoveryPointAt, cursor.generationId)
    values.push(limit + 1)
    const result = await query(
      `SELECT archive.generation_id::text AS generation_id,
              anchor_operation.created_at AS recovery_point_at,
              archive.created_at AS archived_at,
              archive.expires_at,
              archive.anchor_seq::text AS anchor_seq,
              archive.coverage_row_count::text AS coverage_row_count,
              archive.superseded_by_generation_id IS NOT NULL AS superseded
         FROM public.meta_recovery_archives archive
         JOIN public.meta_record_history_operations anchor_operation
           ON anchor_operation.sheet_id = archive.sheet_id
          AND anchor_operation.operation_id = archive.anchor_operation_id
        WHERE archive.workspace_id = $1
          AND archive.base_id = $2
          AND archive.sheet_id = $3
          AND archive.state = 'verified'
          AND archive.build_status = 'finalized'
          AND archive.coverage_status = 'complete'
          AND archive.expires_at > clock_timestamp()
          ${cursorSql}
        ORDER BY anchor_operation.created_at DESC, archive.generation_id DESC
        LIMIT $${values.length}::integer`,
      values,
    )
    if (!Array.isArray(result.rows)) fail('RECOVERY_ARCHIVE_CATALOG_PERSISTENCE_INVALID')
    const rows = result.rows.map((row) => normalizeRow(row))
    const hasMore = rows.length > limit
    const entries = Object.freeze(rows.slice(0, limit))
    return Object.freeze({
      entries,
      nextCursor: hasMore && entries.length > 0
        ? encodeCursor(entries[entries.length - 1])
        : null,
    })
  })
}

export async function readRecoveryArchiveCatalogEntry(
  transaction: RecoveryArchiveCatalogTransaction,
  input: ReadRecoveryArchiveCatalogInput,
): Promise<RecoveryArchiveCatalogEntry> {
  const normalized = normalizeContext(input)
  assertEnabled(input.env)
  const generationId = requireUuid(input.generationId)

  return transaction(async (query) => {
    await assertAuthority(query, input.recheckAuthority)
    const result = await query(
      `SELECT archive.generation_id::text AS generation_id,
              anchor_operation.created_at AS recovery_point_at,
              archive.created_at AS archived_at,
              archive.expires_at,
              archive.anchor_seq::text AS anchor_seq,
              archive.coverage_row_count::text AS coverage_row_count,
              archive.superseded_by_generation_id IS NOT NULL AS superseded
         FROM public.meta_recovery_archives archive
         JOIN public.meta_record_history_operations anchor_operation
           ON anchor_operation.sheet_id = archive.sheet_id
          AND anchor_operation.operation_id = archive.anchor_operation_id
        WHERE archive.workspace_id = $1
          AND archive.base_id = $2
          AND archive.sheet_id = $3
          AND archive.generation_id = $4::uuid
          AND archive.state = 'verified'
          AND archive.build_status = 'finalized'
          AND archive.coverage_status = 'complete'
          AND archive.expires_at > clock_timestamp()`,
      [normalized.workspaceId, normalized.baseId, normalized.sheetId, generationId],
    )
    if (!Array.isArray(result.rows)) fail('RECOVERY_ARCHIVE_CATALOG_PERSISTENCE_INVALID')
    if (result.rows.length !== 1) fail('RECOVERY_ARCHIVE_CATALOG_NOT_FOUND')
    return normalizeRow(result.rows[0])
  })
}

function normalizeContext(input: RecoveryArchiveCatalogContext) {
  if (!input || typeof input !== 'object') fail('RECOVERY_ARCHIVE_CATALOG_INVALID_INPUT')
  return Object.freeze({
    workspaceId: requireOpaque(input.workspaceId),
    baseId: requireOpaque(input.baseId),
    sheetId: requireOpaque(input.sheetId),
  })
}

function assertEnabled(env: NodeJS.ProcessEnv | undefined): void {
  if (!isMultitableRecoveryArchiveEnabled(env ?? process.env)) {
    fail('RECOVERY_ARCHIVE_CATALOG_DISABLED')
  }
}

async function assertAuthority(
  query: RecoveryArchiveCatalogQuery,
  recheckAuthority: RecoveryArchiveCatalogContext['recheckAuthority'],
): Promise<void> {
  if (typeof recheckAuthority !== 'function') fail('RECOVERY_ARCHIVE_CATALOG_INVALID_INPUT')
  if (await recheckAuthority(query) !== true) {
    fail('RECOVERY_ARCHIVE_CATALOG_AUTHORITY_DENIED')
  }
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    fail('RECOVERY_ARCHIVE_CATALOG_INVALID_INPUT')
  }
  return value
}

function normalizeRow(value: unknown): RecoveryArchiveCatalogEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('RECOVERY_ARCHIVE_CATALOG_PERSISTENCE_INVALID')
  }
  const row = value as CatalogRow
  const generationId = requireUuid(row.generation_id, 'RECOVERY_ARCHIVE_CATALOG_PERSISTENCE_INVALID')
  const anchorSeq = requireDecimal(row.anchor_seq)
  const coverageRowCount = requireDecimal(row.coverage_row_count)
  if (typeof row.superseded !== 'boolean') {
    fail('RECOVERY_ARCHIVE_CATALOG_PERSISTENCE_INVALID')
  }
  return Object.freeze({
    generationId,
    recoveryPointAt: requireTimestamp(row.recovery_point_at),
    archivedAt: requireTimestamp(row.archived_at),
    expiresAt: requireTimestamp(row.expires_at),
    anchorSeq,
    coverageRowCount,
    superseded: row.superseded,
  })
}

function encodeCursor(entry: RecoveryArchiveCatalogEntry): string {
  return Buffer.from(JSON.stringify([
    entry.recoveryPointAt,
    entry.generationId,
  ])).toString('base64url')
}

function decodeCursor(value: string): CatalogCursor {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_CURSOR_LENGTH) {
    fail('RECOVERY_ARCHIVE_CATALOG_INVALID_INPUT')
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (!Array.isArray(decoded) || decoded.length !== 2) {
      fail('RECOVERY_ARCHIVE_CATALOG_INVALID_INPUT')
    }
    return {
      recoveryPointAt: requireTimestamp(decoded[0], 'RECOVERY_ARCHIVE_CATALOG_INVALID_INPUT'),
      generationId: requireUuid(decoded[1], 'RECOVERY_ARCHIVE_CATALOG_INVALID_INPUT'),
    }
  } catch (error) {
    if (error instanceof RecoveryArchiveCatalogError) throw error
    fail('RECOVERY_ARCHIVE_CATALOG_INVALID_INPUT')
  }
}

function requireOpaque(
  value: unknown,
  code: RecoveryArchiveCatalogErrorCode = 'RECOVERY_ARCHIVE_CATALOG_INVALID_INPUT',
): string {
  if (typeof value !== 'string' || value.length < 1 || value.trim() !== value) fail(code)
  return value
}

function requireUuid(
  value: unknown,
  code: RecoveryArchiveCatalogErrorCode = 'RECOVERY_ARCHIVE_CATALOG_INVALID_INPUT',
): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail(code)
  return value.toLowerCase()
}

function requireDecimal(value: unknown): string {
  if (typeof value !== 'string' || !NONNEGATIVE_DECIMAL_PATTERN.test(value)) {
    fail('RECOVERY_ARCHIVE_CATALOG_PERSISTENCE_INVALID')
  }
  return value
}

function requireTimestamp(
  value: unknown,
  code: RecoveryArchiveCatalogErrorCode = 'RECOVERY_ARCHIVE_CATALOG_PERSISTENCE_INVALID',
): string {
  const timestamp = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null
  if (!timestamp || !Number.isFinite(timestamp.getTime())) fail(code)
  return timestamp.toISOString()
}

function fail(code: RecoveryArchiveCatalogErrorCode): never {
  throw new RecoveryArchiveCatalogError(code)
}
