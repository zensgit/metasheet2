/**
 * Attachment service — shared read/write/summary helpers for
 * `multitable_attachments` extracted out of the `univer-meta.ts` route.
 *
 * Scope: pure extraction. HTTP response shapes, storage semantics, and
 * permission policy are unchanged. The route keeps the auth/permission
 * layer; this service owns the storage-adapter calls, the
 * `multitable_attachments` row lifecycle, and the attachment summary
 * computation that feeds record GET responses.
 *
 * M2 slice 1 per `docs/development/multitable-service-extraction-roadmap-20260407.md`.
 */

import { randomUUID } from 'crypto'
import * as path from 'path'

import type { StorageServiceImpl } from '../services/StorageService'
import type { StorageFile } from '../types/plugin'

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type AttachmentQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

/**
 * Minimal request surface the service needs to build attachment URLs.
 * Kept as a structural type so callers can pass an Express `Request` or a
 * lightweight stand-in from tests.
 */
export type AttachmentUrlRequestLike = {
  protocol?: string
  get(header: string): string | undefined
}

/** Shape of an attachment row as serialized for HTTP responses. */
export type MultitableAttachment = {
  id: string
  filename: string
  mimeType: string
  size: number
  url: string
  thumbnailUrl: string | null
  uploadedAt: string | null
}

export type MultitableAttachmentFieldLike = {
  id: string
  type: string
}

export type MultitableAttachmentRecordLike = {
  id: string
  data: Record<string, unknown>
}

/**
 * Subset of the multer-style file shape the upload flow needs. Avoids
 * pulling the full multer types into this module.
 */
export type AttachmentUploadFile = {
  buffer: Buffer
  originalname: string
  mimetype: string
  size: number
}

export type StoreAttachmentInput = {
  query: AttachmentQueryFn
  storage: StorageServiceImpl
  sheetId: string
  recordId: string | null
  fieldId: string | null
  file: AttachmentUploadFile
  uploaderId: string
  /** Optional override for the attachment id generator (used by tests). */
  idGenerator?: () => string
}

export type StoreAttachmentResult = {
  /** Raw DB row returned from the INSERT ... RETURNING statement. */
  row: Record<string, unknown>
  /** Metadata of the uploaded storage object (id/path/url). */
  uploaded: StorageFile
}

export type ReadAttachmentMetadataInput = {
  query: AttachmentQueryFn
  attachmentId: string
}

export type ReadAttachmentMetadataResult = {
  id: string
  sheetId: string
  storageFileId: string
  filename: string | null
  originalName: string | null
  mimeType: string
  size: number
}

export type ReadAttachmentForDeleteInput = {
  query: AttachmentQueryFn
  attachmentId: string
}

export type ReadAttachmentForDeleteResult = {
  id: string
  sheetId: string
  recordId: string | null
  fieldId: string | null
  storageFileId: string
  createdBy: string | null
}

export type ReadAttachmentBinaryInput = {
  storage: StorageServiceImpl
  storageFileId: string
}

export type SoftDeleteAttachmentInput = {
  query: AttachmentQueryFn
  attachmentId: string
}

export type DeleteAttachmentBinaryInput = {
  storage: StorageServiceImpl
  storageFileId: string
}

export type BuildAttachmentSummariesInput = {
  query: AttachmentQueryFn
  req: AttachmentUrlRequestLike
  sheetId: string
  rows: MultitableAttachmentRecordLike[]
  attachmentFields: MultitableAttachmentFieldLike[]
}

export type EnsureAttachmentIdsExistInput = {
  query: AttachmentQueryFn
  sheetId: string
  fieldId: string
  attachmentIds: string[]
}

// ---------------------------------------------------------------------------
// Internal helpers (kept private to avoid cross-importing route helpers)
// ---------------------------------------------------------------------------

function normalizeJsonArray(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) {
    return value
      .map((v) => {
        if (typeof v === 'string') return v.trim()
        if (typeof v === 'number' && Number.isFinite(v)) return String(v)
        return ''
      })
      .filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return normalizeJsonArray(parsed)
    } catch {
      return []
    }
  }
  return []
}

/**
 * Parses an attachment id column value that may arrive as a JSON array, a
 * comma-separated string, or a bare id. Mirrors the behavior of
 * `normalizeLinkIds` (aliased as `normalizeAttachmentIds`) in
 * `routes/univer-meta.ts`. Duplicated here intentionally: the service
 * must not import from the route layer and the route helper still feeds
 * non-attachment call sites.
 */
export function normalizeAttachmentIds(value: unknown): string[] {
  if (value === null || value === undefined) return []

  const raw: string[] = []
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === 'string') raw.push(v)
      else if (typeof v === 'number' && Number.isFinite(v)) raw.push(String(v))
    }
  } else if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length === 0) return []
    const jsonParsed = normalizeJsonArray(trimmed)
    if (jsonParsed.length > 0) raw.push(...jsonParsed)
    else if (trimmed.includes(',')) raw.push(...trimmed.split(','))
    else raw.push(trimmed)
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    raw.push(String(value))
  }

  const seen = new Set<string>()
  return raw
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .filter((v) => {
      if (seen.has(v)) return false
      seen.add(v)
      return true
    })
}

function isImageMimeType(mimeType: string | null | undefined): boolean {
  return typeof mimeType === 'string' && mimeType.toLowerCase().startsWith('image/')
}

function buildAttachmentUrl(req: AttachmentUrlRequestLike, attachmentId: string, thumbnail: boolean = false): string {
  const protocol = req.protocol || 'http'
  const host = req.get('host') || 'localhost:8900'
  const query = thumbnail ? '?thumbnail=true' : ''
  return `${protocol}://${host}/api/multitable/attachments/${encodeURIComponent(attachmentId)}${query}`
}

function buildAttachmentId(): string {
  return `att_${randomUUID()}`.slice(0, 50)
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

/**
 * Converts a raw `multitable_attachments` row (as returned from PG) into
 * the HTTP response shape used across the route.
 */
export function serializeAttachmentRow(
  req: AttachmentUrlRequestLike,
  row: Record<string, unknown>,
): MultitableAttachment {
  const id = String(row.id)
  const mimeType = typeof row.mime_type === 'string' ? row.mime_type : 'application/octet-stream'
  const filename =
    typeof row.filename === 'string'
      ? row.filename
      : typeof row.original_name === 'string'
        ? row.original_name
        : id
  const size = Number(row.size ?? 0)
  return {
    id,
    filename,
    mimeType,
    size,
    url: buildAttachmentUrl(req, id),
    thumbnailUrl: isImageMimeType(mimeType) ? buildAttachmentUrl(req, id, true) : null,
    uploadedAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : typeof row.created_at === 'string'
          ? row.created_at
          : null,
  }
}

/**
 * Flattens a nested summary `Map` into plain-object form for JSON
 * serialization. Mirrors the inline helper the PATCH/GET routes used.
 */
export function serializeAttachmentSummaryMap(
  attachmentSummaries: Map<string, Map<string, MultitableAttachment[]>>,
): Record<string, Record<string, MultitableAttachment[]>> {
  return Object.fromEntries(
    Array.from(attachmentSummaries.entries()).map(([recordId, fieldMap]) => [
      recordId,
      Object.fromEntries(Array.from(fieldMap.entries()).map(([fieldId, summaries]) => [fieldId, summaries])),
    ]),
  )
}

// ---------------------------------------------------------------------------
// Existence checks & summary builders
// ---------------------------------------------------------------------------

/**
 * Confirms that every id in `attachmentIds` exists under the given sheet
 * and either has no `field_id` pinning or points at `fieldId`. Returns a
 * human-readable error string on mismatch, `null` on success. Preserves
 * the exact error phrasing the inline route helper emitted.
 */
export async function ensureAttachmentIdsExist(
  input: EnsureAttachmentIdsExistInput,
): Promise<string | null> {
  const { query, sheetId, fieldId, attachmentIds } = input
  if (attachmentIds.length === 0) return null

  const result = await query(
    `SELECT id, field_id
     FROM multitable_attachments
     WHERE sheet_id = $1
       AND deleted_at IS NULL
       AND id = ANY($2::text[])`,
    [sheetId, attachmentIds],
  )
  const rows = result.rows as Array<{ id: string; field_id: string | null }>
  const found = new Set(rows.map((row) => String(row.id)))
  const missing = attachmentIds.filter((id) => !found.has(id))
  if (missing.length > 0) {
    return `Attachment(s) not found: ${missing.join(', ')}`
  }
  const mismatchedField = rows.find((row) => row.field_id && String(row.field_id) !== fieldId)
  if (mismatchedField) {
    return `Attachment belongs to a different field: ${mismatchedField.id}`
  }
  return null
}

/**
 * Builds a `{recordId -> {fieldId -> MultitableAttachment[]}}` map used by
 * record list and record GET responses. Only returns rows that match the
 * record's attachment fields (and respects field-scoped `field_id`
 * pinning on the attachment row).
 */
export async function buildAttachmentSummaries(
  input: BuildAttachmentSummariesInput,
): Promise<Map<string, Map<string, MultitableAttachment[]>>> {
  const { query, req, sheetId, rows, attachmentFields } = input
  const result = new Map<string, Map<string, MultitableAttachment[]>>()
  if (rows.length === 0 || attachmentFields.length === 0) return result

  const attachmentFieldIds = new Set(attachmentFields.map((field) => field.id))
  const attachmentIds = new Set<string>()

  for (const row of rows) {
    for (const field of attachmentFields) {
      for (const attachmentId of normalizeAttachmentIds(row.data[field.id])) {
        attachmentIds.add(attachmentId)
      }
    }
  }

  const idList = Array.from(attachmentIds)
  if (idList.length === 0) return result

  const attachmentRes = await query(
    `SELECT id, sheet_id, record_id, field_id, filename, original_name, mime_type, size, created_at
     FROM multitable_attachments
     WHERE sheet_id = $1
       AND deleted_at IS NULL
       AND id = ANY($2::text[])`,
    [sheetId, idList],
  )

  const attachmentById = new Map<string, Record<string, unknown>>()
  for (const row of attachmentRes.rows as Array<Record<string, unknown>>) {
    attachmentById.set(String(row.id), row)
  }

  for (const row of rows) {
    const byField = new Map<string, MultitableAttachment[]>()
    for (const field of attachmentFields) {
      const summaries = normalizeAttachmentIds(row.data[field.id])
        .map((attachmentId) => attachmentById.get(attachmentId))
        .filter((attachmentRow): attachmentRow is Record<string, unknown> => {
          if (!attachmentRow) return false
          if (attachmentRow.field_id && !attachmentFieldIds.has(String(attachmentRow.field_id))) return false
          return !attachmentRow.field_id || String(attachmentRow.field_id) === field.id
        })
        .map((attachmentRow) => serializeAttachmentRow(req, attachmentRow))

      if (summaries.length > 0) {
        byField.set(field.id, summaries)
      }
    }

    if (byField.size > 0) {
      result.set(row.id, byField)
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Upload / store
// ---------------------------------------------------------------------------

/**
 * Writes a binary to the provided storage adapter, inserts a
 * `multitable_attachments` row, and returns both. On DB failure the
 * binary is best-effort cleaned from storage to avoid orphan blobs
 * (matching the route-layer behavior).
 *
 * The caller is responsible for auth/permission checks, for confirming
 * the sheet/record exist, and for proving the target field is of type
 * `attachment`. This function assumes those checks have already passed.
 */
export async function storeAttachment(
  input: StoreAttachmentInput,
): Promise<StoreAttachmentResult> {
  const { query, storage, sheetId, recordId, fieldId, file, uploaderId } = input
  const idGenerator = input.idGenerator ?? buildAttachmentId

  const extension = path.extname(file.originalname || '')
  const storageFilename = `${randomUUID()}${extension}`

  const uploaded = await storage.upload(file.buffer, {
    filename: storageFilename,
    contentType: file.mimetype,
    path: path.join(sheetId, fieldId ?? 'unassigned'),
    metadata: {
      originalName: file.originalname,
      sheetId,
      ...(recordId ? { recordId } : {}),
      ...(fieldId ? { fieldId } : {}),
    },
  })

  try {
    const attachmentId = idGenerator()
    const insert = await query(
      `INSERT INTO multitable_attachments
         (id, sheet_id, record_id, field_id, storage_file_id, filename, original_name, mime_type, size, storage_path, storage_provider, metadata, created_by)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
       RETURNING id, filename, original_name, mime_type, size, created_at`,
      [
        attachmentId,
        sheetId,
        recordId,
        fieldId,
        uploaded.id,
        file.originalname || storageFilename,
        file.originalname || null,
        file.mimetype || 'application/octet-stream',
        file.size,
        uploaded.path,
        'local',
        JSON.stringify({
          storageFileId: uploaded.id,
          storageUrl: uploaded.url,
        }),
        uploaderId,
      ],
    )
    const row = (insert.rows as Array<Record<string, unknown>>)[0]
    return { row, uploaded }
  } catch (dbErr) {
    try {
      await storage.delete(uploaded.id)
    } catch {
      // best-effort cleanup after DB failure
    }
    throw dbErr
  }
}

// ---------------------------------------------------------------------------
// Read / download
// ---------------------------------------------------------------------------

/**
 * Fetches the small column set needed to authorise and serve an
 * attachment download. Returns `null` when the id is not found or the
 * row is soft-deleted.
 */
export async function readAttachmentMetadata(
  input: ReadAttachmentMetadataInput,
): Promise<ReadAttachmentMetadataResult | null> {
  const { query, attachmentId } = input
  const result = await query(
    `SELECT id, sheet_id, storage_file_id, filename, original_name, mime_type, size
     FROM multitable_attachments
     WHERE id = $1 AND deleted_at IS NULL`,
    [attachmentId],
  )
  const row = (result.rows as Array<Record<string, unknown>>)[0]
  if (!row) return null
  return {
    id: String(row.id),
    // Matches the route's pre-extraction behavior: non-string sheet_id is
    // normalized to '' so the auth block is short-circuited (see
    // `GET /attachments/:attachmentId` usage).
    sheetId: typeof row.sheet_id === 'string' ? row.sheet_id : '',
    storageFileId: String(row.storage_file_id),
    filename: typeof row.filename === 'string' ? row.filename : null,
    originalName: typeof row.original_name === 'string' ? row.original_name : null,
    mimeType: typeof row.mime_type === 'string' ? row.mime_type : 'application/octet-stream',
    size: Number(row.size ?? 0),
  }
}

/** Reads the binary bytes for the given storage file id. */
export async function readAttachmentBinary(
  input: ReadAttachmentBinaryInput,
): Promise<Buffer> {
  const { storage, storageFileId } = input
  return storage.download(storageFileId)
}

/**
 * Selects the columns the delete flow needs to authorise the request,
 * maintain record data, and remove the storage blob. Returns `null` when
 * the attachment does not exist or has already been soft-deleted.
 */
export async function readAttachmentForDelete(
  input: ReadAttachmentForDeleteInput,
): Promise<ReadAttachmentForDeleteResult | null> {
  const { query, attachmentId } = input
  const result = await query(
    `SELECT id, sheet_id, record_id, field_id, storage_file_id, created_by
     FROM multitable_attachments
     WHERE id = $1 AND deleted_at IS NULL`,
    [attachmentId],
  )
  const row = (result.rows as Array<Record<string, unknown>>)[0]
  if (!row) return null
  return {
    id: String(row.id),
    sheetId: String(row.sheet_id),
    recordId: typeof row.record_id === 'string' ? row.record_id : null,
    fieldId: typeof row.field_id === 'string' ? row.field_id : null,
    storageFileId: String(row.storage_file_id),
    createdBy: typeof row.created_by === 'string' ? row.created_by : null,
  }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Soft-deletes the attachment row by setting `deleted_at`/`updated_at`.
 * The caller is expected to run this inside the same transaction that
 * patches the owning record's data column so that the two mutations
 * stay consistent with each other.
 */
export async function softDeleteAttachmentRow(
  input: SoftDeleteAttachmentInput,
): Promise<void> {
  const { query, attachmentId } = input
  await query(
    'UPDATE multitable_attachments SET deleted_at = now(), updated_at = now() WHERE id = $1',
    [attachmentId],
  )
}

/**
 * Best-effort removal of the underlying storage blob. Intentionally
 * swallows errors to mirror the route-layer behavior where a failed
 * storage delete must not roll back the DB soft-delete.
 */
export async function deleteAttachmentBinary(
  input: DeleteAttachmentBinaryInput,
): Promise<void> {
  const { storage, storageFileId } = input
  try {
    await storage.delete(storageFileId)
  } catch {
    // best-effort cleanup; mirrors route behavior
  }
}
