import {
  buildRecoveryArchiveSectionRows,
  type RecoveryArchiveDataSectionName,
} from './recovery-archive-section-rows'
import { normalizeAttachmentIds } from './attachment-service'

type RelationalSection = Exclude<RecoveryArchiveDataSectionName, 'attachments_index' | 'permission_evidence'>
export type RecoveryArchiveRelationalSource = Readonly<Record<RelationalSection, readonly unknown[]>>
export interface RecoveryArchiveAttachmentCandidate {
  attachmentId: string
  recordId: string | null
  fieldId: string | null
  storageFileId: string
  storagePath: string
  storageProvider: string
  sizeBytes: string
  mediaType: string
  deleted: boolean
  blobPurged: boolean
}
export interface RecoveryArchiveCaptureSource {
  sections: RecoveryArchiveRelationalSource
  attachmentCandidates: readonly RecoveryArchiveAttachmentCandidate[]
}
export type RecoveryArchiveSourceQuery = (
  sql: string, params: unknown[],
) => Promise<{ rows: unknown[] }>

export interface RecoveryArchiveSourceScope {
  workspaceId: string
  baseId: string
  sheetId: string
}

export class RecoveryArchiveRelationalSourceError extends Error {
  readonly code = 'RECOVERY_ARCHIVE_RELATIONAL_SOURCE_UNAVAILABLE'
  constructor() {
    super('RECOVERY_ARCHIVE_RELATIONAL_SOURCE_UNAVAILABLE')
    this.name = 'RecoveryArchiveRelationalSourceError'
  }
}

const SECTIONS: readonly RelationalSection[] = [
  'schema', 'records', 'links', 'field_value_tombstones',
  'link_tombstones', 'auto_number', 'views_config',
]

// One statement gives every relational section the same MVCC snapshot, even
// in READ COMMITTED. Object reads and final source-seal validation belong to
// the capture coordinator, not this internal projection.
const SOURCE_SQL = `
WITH scope AS (
  SELECT s.id FROM public.meta_sheets s
  JOIN public.meta_bases b ON b.id = s.base_id
  WHERE s.id = $1 AND s.base_id = $2 AND b.workspace_id = $3
    AND s.deleted_at IS NULL AND b.deleted_at IS NULL
), fields AS (
  SELECT f.* FROM public.meta_fields f JOIN scope s ON s.id = f.sheet_id
), records AS (
  SELECT r.* FROM public.meta_records r JOIN scope s ON s.id = r.sheet_id
)
SELECT jsonb_build_object(
  'schema', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'field_id', f.id, 'name', f.name, 'type', f.type,
    'property', f.property, 'order', f."order")) FROM fields f), '[]'::jsonb),
  'records', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'record_id', r.id, 'exists', true, 'version', r.version, 'data', r.data))
    FROM records r), '[]'::jsonb),
  'links', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'link_id', l.id, 'field_id', l.field_id, 'record_id', l.record_id,
    'foreign_record_id', l.foreign_record_id))
    FROM public.meta_links l JOIN records r ON r.id = l.record_id), '[]'::jsonb),
  'field_value_tombstones', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'id', t.id, 'field_id', t.field_id, 'record_id', t.record_id,
    'config_revision_id', t.config_revision_id, 'value', t.value,
    'reason', t.reason,
    'created_at', to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
    FROM public.meta_field_value_tombstones t JOIN scope s ON s.id = t.sheet_id), '[]'::jsonb),
  'link_tombstones', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'id', t.id, 'source_revision_id', t.source_revision_id, 'field_id', t.field_id,
    'record_id', t.record_id, 'foreign_record_id', t.foreign_record_id,
    'reason', t.reason,
    'created_at', to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
    FROM public.meta_link_tombstones t JOIN scope s ON s.id = t.sheet_id), '[]'::jsonb),
  'auto_number', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'field_id', a.field_id, 'next_value', a.next_value::text))
    FROM public.meta_field_auto_number_sequences a JOIN scope s ON s.id = a.sheet_id), '[]'::jsonb),
  'views_config', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'view_id', v.id, 'name', v.name, 'type', v.type,
    'filter_info', v.filter_info, 'sort_info', v.sort_info,
    'group_info', v.group_info, 'hidden_field_ids', v.hidden_field_ids, 'config', v.config))
    FROM public.meta_views v JOIN scope s ON s.id = v.sheet_id), '[]'::jsonb)
) AS sections,
COALESCE((SELECT jsonb_agg(jsonb_build_object(
  'attachmentId', a.id, 'recordId', a.record_id, 'fieldId', a.field_id,
  'storageFileId', a.storage_file_id, 'storagePath', a.storage_path,
  'storageProvider', a.storage_provider, 'sizeBytes', a.size::text,
  'mediaType', a.mime_type, 'deleted', a.deleted_at IS NOT NULL,
  'blobPurged', a.blob_purged_at IS NOT NULL))
  FROM public.multitable_attachments a JOIN scope s ON s.id = a.sheet_id), '[]'::jsonb)
  AS attachment_candidates
FROM scope`

/** Internal source projection only: caller must supply freshly authorized scope.
 * This is not an archive, attachment proof, permission proof or publication token.
 */
export async function readRecoveryArchiveRelationalSource(
  query: RecoveryArchiveSourceQuery,
  scope: RecoveryArchiveSourceScope,
): Promise<RecoveryArchiveRelationalSource> {
  return (await readRecoveryArchiveCaptureSource(query, scope)).sections
}

/** Internal metadata only. Candidates are not authenticated attachment receipts,
 * immutable object versions or public DTOs; storage paths must never be exposed.
 */
export async function readRecoveryArchiveCaptureSource(
  query: RecoveryArchiveSourceQuery,
  scope: RecoveryArchiveSourceScope,
): Promise<RecoveryArchiveCaptureSource> {
  try {
    for (const value of [scope.sheetId, scope.baseId, scope.workspaceId]) {
      if (typeof value !== 'string' || !value || value.trim() !== value) throw new Error()
    }
    const result = await query(SOURCE_SQL, [scope.sheetId, scope.baseId, scope.workspaceId])
    if (result.rows.length !== 1) throw new Error()
    const raw = result.rows[0] as { sections?: unknown; attachment_candidates?: unknown }
    if (!raw || typeof raw.sections !== 'object' || raw.sections === null || Array.isArray(raw.sections)) {
      throw new Error()
    }
    const sections = raw.sections as Record<string, unknown>
    if (Object.keys(sections).length !== SECTIONS.length || SECTIONS.some((key) => !Object.hasOwn(sections, key))) {
      throw new Error()
    }
    const projected = {} as Record<RelationalSection, readonly unknown[]>
    for (const section of SECTIONS) {
      // Existing admission also snapshots payloads and sorts by canonical entity key.
      projected[section] = buildRecoveryArchiveSectionRows(section, sections[section]).map((row) => row.payload)
    }
    const fields = new Set((projected.schema as { field_id: string }[]).map((field) => field.field_id))
    for (const link of projected.links as { field_id: string }[]) {
      if (!fields.has(link.field_id)) throw new Error()
    }
    for (const sequence of projected.auto_number as { field_id: string }[]) {
      if (!fields.has(sequence.field_id)) throw new Error()
    }
    const records = new Set((projected.records as { record_id: string }[]).map((record) => record.record_id))
    const candidates = admitAttachmentCandidates(raw.attachment_candidates)
    for (const candidate of candidates) {
      if (candidate.fieldId !== null && !fields.has(candidate.fieldId)) throw new Error()
      if (candidate.recordId !== null && !records.has(candidate.recordId)) throw new Error()
    }
    assertReferencedAttachments(projected, candidates)
    return { sections: projected, attachmentCandidates: candidates }
  } catch {
    // SQL/provider errors may contain source identifiers and must not escape.
    throw new RecoveryArchiveRelationalSourceError()
  }
}

function assertReferencedAttachments(
  sections: RecoveryArchiveRelationalSource,
  candidates: readonly RecoveryArchiveAttachmentCandidate[],
): void {
  const fields = (sections.schema as { field_id: string; type: string }[])
    .filter((field) => field.type === 'attachment')
  const byId = new Map(candidates.map((candidate) => [candidate.attachmentId, candidate]))
  for (const record of sections.records as { record_id: string; data: Record<string, unknown> }[]) {
    for (const field of fields) {
      let value = record.data[field.field_id]
      // Reuse the live reader's legacy ID formats, but do not inherit its
      // silent dropping of malformed array elements or object-shaped values.
      const scalar = (item: unknown) => typeof item === 'string'
        || (typeof item === 'number' && Number.isFinite(item))
      if (typeof value === 'string' && value.trim().startsWith('[')) {
        value = JSON.parse(value)
        if (!Array.isArray(value)) throw new Error()
      }
      if (value !== null && value !== undefined
        && !(Array.isArray(value) ? value.every(scalar) : scalar(value))) throw new Error()
      for (const id of normalizeAttachmentIds(value)) {
        const candidate = byId.get(id)
        if (!candidate || candidate.deleted || candidate.blobPurged
          || (candidate.recordId !== null && candidate.recordId !== record.record_id)
          || (candidate.fieldId !== null && candidate.fieldId !== field.field_id)) throw new Error()
      }
    }
  }
}

function admitAttachmentCandidates(value: unknown): RecoveryArchiveAttachmentCandidate[] {
  if (!Array.isArray(value)) throw new Error()
  const textKeys = ['attachmentId', 'storageFileId', 'storagePath', 'storageProvider', 'sizeBytes', 'mediaType'] as const
  const nullableKeys = ['recordId', 'fieldId'] as const
  const keys = [...textKeys, ...nullableKeys, 'deleted', 'blobPurged']
  const seen = new Set<string>()
  return value.map((row: unknown) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error()
    const input = row as Record<string, unknown>
    if (Object.keys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key))) throw new Error()
    for (const key of textKeys) {
      if (typeof input[key] !== 'string' || !input[key]) throw new Error()
    }
    for (const key of nullableKeys) {
      if (input[key] !== null && (typeof input[key] !== 'string' || !input[key])) throw new Error()
    }
    if (!/^(0|[1-9][0-9]*)$/.test(input.sizeBytes as string)
      || typeof input.deleted !== 'boolean' || typeof input.blobPurged !== 'boolean'
      || seen.has(input.attachmentId as string)) throw new Error()
    seen.add(input.attachmentId as string)
    return { ...input } as unknown as RecoveryArchiveAttachmentCandidate
  }).sort((left, right) => left.attachmentId < right.attachmentId ? -1 : left.attachmentId > right.attachmentId ? 1 : 0)
}
