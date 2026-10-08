import { performance } from 'node:perf_hooks'

import {
  admitRecoveryArchiveCaptureSource,
  type RecoveryArchiveCaptureSource,
  type RecoveryArchiveSourceQuery,
  type RecoveryArchiveSourceScope,
} from './recovery-archive-relational-source'

export interface RecoveryArchiveCaptureLimits {
  maxBytes: number
  timeoutMs: number
}

export type RecoveryArchiveBoundedSourceErrorCode =
  | 'RECOVERY_ARCHIVE_CAPTURE_POLICY_INVALID'
  | 'RECOVERY_ARCHIVE_CAPTURE_TRANSACTION_REQUIRED'
  | 'RECOVERY_ARCHIVE_CAPTURE_FENCE_HELD'
  | 'RECOVERY_ARCHIVE_CAPTURE_BYTES_EXCEEDED'
  | 'RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED'
  | 'RECOVERY_ARCHIVE_CAPTURE_UNAVAILABLE'

export class RecoveryArchiveBoundedSourceError extends Error {
  constructor(readonly code: RecoveryArchiveBoundedSourceErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveBoundedSourceError'
  }
}

const SCOPE_SQL = `SELECT s.id FROM public.meta_sheets s
  JOIN public.meta_bases b ON b.id=s.base_id
  WHERE s.id=$1 AND s.base_id=$2 AND b.workspace_id=$3
    AND s.deleted_at IS NULL AND b.deleted_at IS NULL`

// Static SQL only. A single row is returned at a time; no section-wide JSON aggregate is built.
const PROJECTIONS = [
  { section: 'schema', key: 'e.id::text', from: 'public.meta_fields e JOIN scope s ON s.id=e.sheet_id',
    payload: `jsonb_build_object('field_id',e.id,'name',e.name,'type',e.type,
      'property',e.property,'order',e."order")` },
  { section: 'records', key: 'e.id::text', from: 'public.meta_records e JOIN scope s ON s.id=e.sheet_id',
    payload: `jsonb_build_object('record_id',e.id,'exists',true,'version',e.version,'data',e.data)` },
  { section: 'links', key: 'e.id::text', from: `public.meta_links e
      JOIN public.meta_records r ON r.id=e.record_id JOIN scope s ON s.id=r.sheet_id`,
    payload: `jsonb_build_object('link_id',e.id,'field_id',e.field_id,
      'record_id',e.record_id,'foreign_record_id',e.foreign_record_id)` },
  { section: 'field_value_tombstones', key: 'e.id::text',
    from: 'public.meta_field_value_tombstones e JOIN scope s ON s.id=e.sheet_id',
    payload: `jsonb_build_object('id',e.id,'field_id',e.field_id,'record_id',e.record_id,
      'config_revision_id',e.config_revision_id,'value',e.value,'reason',e.reason,
      'created_at',to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))` },
  { section: 'link_tombstones', key: 'e.id::text',
    from: 'public.meta_link_tombstones e JOIN scope s ON s.id=e.sheet_id',
    payload: `jsonb_build_object('id',e.id,'source_revision_id',e.source_revision_id,
      'field_id',e.field_id,'record_id',e.record_id,'foreign_record_id',e.foreign_record_id,
      'reason',e.reason,'created_at',to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))` },
  { section: 'auto_number', key: 'e.field_id::text',
    from: 'public.meta_field_auto_number_sequences e JOIN scope s ON s.id=e.sheet_id',
    payload: `jsonb_build_object('field_id',e.field_id,'next_value',e.next_value::text)` },
  { section: 'views_config', key: 'e.id::text',
    from: 'public.meta_views e JOIN scope s ON s.id=e.sheet_id',
    payload: `jsonb_build_object('view_id',e.id,'name',e.name,'type',e.type,
      'filter_info',e.filter_info,'sort_info',e.sort_info,'group_info',e.group_info,
      'hidden_field_ids',e.hidden_field_ids,'config',e.config)` },
  { section: 'attachment_candidates', key: 'e.id::text',
    from: 'public.multitable_attachments e JOIN scope s ON s.id=e.sheet_id',
    payload: `jsonb_build_object('attachmentId',e.id,'recordId',e.record_id,'fieldId',e.field_id,
      'storageFileId',e.storage_file_id,'storagePath',e.storage_path,'storageProvider',e.storage_provider,
      'sizeBytes',e.size::text,'mediaType',e.mime_type,'deleted',e.deleted_at IS NOT NULL,
      'blobPurged',e.blob_purged_at IS NOT NULL)` },
] as const

const TRANSACTION_SQL = `SELECT pg_current_xact_id()::text AS xid,
  current_setting('transaction_isolation') AS isolation,
  current_setting('statement_timeout') AS statement_timeout,
  EXISTS (SELECT 1 FROM pg_catalog.pg_locks
    WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted) AS advisory_held`

function fail(code: RecoveryArchiveBoundedSourceErrorCode): never {
  throw new RecoveryArchiveBoundedSourceError(code)
}

export function snapshotRecoveryArchiveCaptureLimits(
  input: RecoveryArchiveCaptureLimits,
): Readonly<RecoveryArchiveCaptureLimits> {
  const limits = { ...input }
  if (Object.keys(limits).sort().join(',') !== 'maxBytes,timeoutMs'
    || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0 || limits.maxBytes > 2147483647
    || !Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs <= 0 || limits.timeoutMs > 2147483647) {
    fail('RECOVERY_ARCHIVE_CAPTURE_POLICY_INVALID')
  }
  return Object.freeze(limits)
}

/**
 * Internal DB metadata only, on one caller-owned RR connection. The caller must first commit its
 * owned claim and verify its exact block/generation/reservations/pins. This reader alone does not
 * issue claim authority or prove fresh-after-claim ordering. No attachment/provider/KMS IO occurs.
 * The connection owner must bound acquisition/transport/transaction completion; use the capture
 * executor for that lifecycle. Statement timeouts alone cannot cancel stalled transport.
 */
export async function readRecoveryArchiveBoundedCaptureSource(
  query: RecoveryArchiveSourceQuery,
  scopeInput: RecoveryArchiveSourceScope,
  limitsInput: RecoveryArchiveCaptureLimits,
): Promise<RecoveryArchiveCaptureSource> {
  const scope = { ...scopeInput }
  const limits = snapshotRecoveryArchiveCaptureLimits(limitsInput)
  if ([scope.sheetId, scope.baseId, scope.workspaceId].some((value) =>
    typeof value !== 'string' || !value || value.trim() !== value)) fail('RECOVERY_ARCHIVE_CAPTURE_UNAVAILABLE')
  const deadline = performance.now() + limits.timeoutMs
  const params = [scope.sheetId, scope.baseId, scope.workspaceId]
  let oldTimeout: string | undefined
  let succeeded = false
  try {
    const prelude = await query(TRANSACTION_SQL, [])
    const transaction = prelude.rows[0] as Record<string, unknown> | undefined
    if (prelude.rows.length !== 1 || transaction?.isolation !== 'repeatable read'
      || typeof transaction.xid !== 'string' || !transaction.xid
      || typeof transaction.statement_timeout !== 'string') fail('RECOVERY_ARCHIVE_CAPTURE_TRANSACTION_REQUIRED')
    if (transaction.advisory_held !== false) fail('RECOVERY_ARCHIVE_CAPTURE_FENCE_HELD')
    oldTimeout = transaction.statement_timeout
    const xid = transaction.xid
    const controlledQuery = async (text: string, values: unknown[]) => {
      const remainingMs = Math.ceil(deadline - performance.now())
      if (remainingMs <= 0) fail('RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED')
      await query("SELECT set_config('statement_timeout',$1,true)", [`${remainingMs}ms`])
      const result = await query(text, values)
      if (performance.now() >= deadline) fail('RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED')
      if (result.rows.length !== 1 || (result.rows[0] as { xid?: unknown }).xid !== xid) {
        fail('RECOVERY_ARCHIVE_CAPTURE_TRANSACTION_REQUIRED')
      }
      return result.rows[0] as Record<string, unknown>
    }
    const found = await controlledQuery(`SELECT pg_current_xact_id()::text AS xid,
      EXISTS (${SCOPE_SQL}) AS present`, params)
    if (found.present !== true) fail('RECOVERY_ARCHIVE_CAPTURE_UNAVAILABLE')
    const rows: Record<string, unknown[]> = {}
    let bytes = 0
    for (const projection of PROJECTIONS) {
      rows[projection.section] = []
      let after: string | null = null
      while (true) {
        const remainingBytes = limits.maxBytes - bytes
        const row = await controlledQuery(`WITH scope AS (${SCOPE_SQL}), candidate AS (
          SELECT ${projection.key} AS entity_key, (${projection.payload})::text AS payload
          FROM ${projection.from}
          WHERE ($4::text IS NULL OR (${projection.key} COLLATE "C") > ($4::text COLLATE "C"))
          ORDER BY ${projection.key} COLLATE "C" LIMIT 1
        ) SELECT pg_current_xact_id()::text AS xid,
          CASE WHEN octet_length(candidate.payload)<=$5::int THEN candidate.entity_key END AS entity_key,
          octet_length(candidate.payload) AS payload_bytes,
          CASE WHEN octet_length(candidate.payload)<=$5::int THEN candidate.payload END AS payload
          FROM (SELECT 1) AS control LEFT JOIN candidate ON true`, [...params, after, remainingBytes])
        if (row.payload_bytes === null && row.entity_key === null && row.payload === null) break
        if (typeof row.payload_bytes !== 'number' || !Number.isSafeInteger(row.payload_bytes)
          || row.payload_bytes <= 0) fail('RECOVERY_ARCHIVE_CAPTURE_UNAVAILABLE')
        if (row.payload_bytes > remainingBytes) fail('RECOVERY_ARCHIVE_CAPTURE_BYTES_EXCEEDED')
        if (typeof row.entity_key !== 'string' || !row.entity_key || typeof row.payload !== 'string'
          || Buffer.byteLength(row.payload, 'utf8') !== row.payload_bytes) fail('RECOVERY_ARCHIVE_CAPTURE_UNAVAILABLE')
        rows[projection.section]!.push(JSON.parse(row.payload))
        bytes += row.payload_bytes
        after = row.entity_key
      }
    }
    const final = await controlledQuery(TRANSACTION_SQL, [])
    if (final.isolation !== 'repeatable read') fail('RECOVERY_ARCHIVE_CAPTURE_TRANSACTION_REQUIRED')
    if (final.advisory_held !== false) fail('RECOVERY_ARCHIVE_CAPTURE_FENCE_HELD')
    const { attachment_candidates, ...sections } = rows
    const result = admitRecoveryArchiveCaptureSource({ sections, attachment_candidates })
    if (performance.now() >= deadline) fail('RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED')
    succeeded = true
    return result
  } catch (error) {
    if (error instanceof RecoveryArchiveBoundedSourceError) throw error
    if ((error as { code?: unknown } | null)?.code === '57014') fail('RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED')
    fail('RECOVERY_ARCHIVE_CAPTURE_UNAVAILABLE')
  } finally {
    if (oldTimeout !== undefined) {
      try { await query("SELECT set_config('statement_timeout',$1,true)", [oldTimeout]) } catch (error) {
        if (succeeded) {
          if (error instanceof RecoveryArchiveBoundedSourceError) throw error
          fail('RECOVERY_ARCHIVE_CAPTURE_UNAVAILABLE')
        }
      }
    }
    if (succeeded && performance.now() >= deadline) fail('RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED')
  }
}
