import {
  buildRecoveryArchiveSectionRows,
  type RecoveryArchiveDataSectionName,
} from './recovery-archive-section-rows'

type RelationalSection = Exclude<RecoveryArchiveDataSectionName, 'attachments_index' | 'permission_evidence'>
export type RecoveryArchiveRelationalSource = Readonly<Record<RelationalSection, readonly unknown[]>>
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
) AS sections FROM scope`

/** Internal source projection only: caller must supply freshly authorized scope.
 * This is not an archive, attachment proof, permission proof or publication token.
 */
export async function readRecoveryArchiveRelationalSource(
  query: RecoveryArchiveSourceQuery,
  scope: RecoveryArchiveSourceScope,
): Promise<RecoveryArchiveRelationalSource> {
  try {
    for (const value of [scope.sheetId, scope.baseId, scope.workspaceId]) {
      if (typeof value !== 'string' || !value || value.trim() !== value) throw new Error()
    }
    const result = await query(SOURCE_SQL, [scope.sheetId, scope.baseId, scope.workspaceId])
    if (result.rows.length !== 1) throw new Error()
    const raw = result.rows[0] as { sections?: unknown }
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
    return projected
  } catch {
    // SQL/provider errors may contain source identifiers and must not escape.
    throw new RecoveryArchiveRelationalSourceError()
  }
}
