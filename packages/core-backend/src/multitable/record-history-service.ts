import { randomUUID } from 'crypto'

export type QueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export type RecordRevisionAction = 'create' | 'update' | 'delete'

export type RecordRevisionSource = 'rest' | 'yjs-bridge' | 'automation' | 'public-form' | 'plugin' | string

export interface RecordRevisionInput {
  sheetId: string
  recordId: string
  version: number
  action: RecordRevisionAction
  source?: RecordRevisionSource
  actorId?: string | null
  changedFieldIds?: string[]
  patch?: Record<string, unknown>
  snapshot?: Record<string, unknown> | null
}

export interface RecordRevisionEntry {
  id: string
  sheetId: string
  recordId: string
  version: number
  action: RecordRevisionAction
  source: string
  actorId: string | null
  changedFieldIds: string[]
  patch: Record<string, unknown>
  snapshot: Record<string, unknown> | null
  createdAt: string
}

export async function recordRecordRevision(query: QueryFn, input: RecordRevisionInput): Promise<string> {
  const id = randomUUID()
  const changedFieldIds = Array.from(new Set((input.changedFieldIds ?? []).filter(Boolean)))
  await query(
    `INSERT INTO meta_record_revisions (
       id,
       sheet_id,
       record_id,
       version,
       action,
       source,
       actor_id,
       changed_field_ids,
       patch,
       snapshot
    )
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::text[], $9::jsonb, $10::jsonb)`,
    [
      id,
      input.sheetId,
      input.recordId,
      input.version,
      input.action,
      input.source ?? 'rest',
      input.actorId ?? null,
      changedFieldIds,
      JSON.stringify(input.patch ?? {}),
      input.snapshot === undefined ? null : JSON.stringify(input.snapshot),
    ],
  )
  return id
}

export async function listRecordRevisions(
  query: QueryFn,
  input: { sheetId: string; recordId: string; limit?: number; offset?: number },
): Promise<RecordRevisionEntry[]> {
  const limit = Math.min(Math.max(Number(input.limit ?? 50), 1), 100)
  const offset = Math.max(Number(input.offset ?? 0), 0)
  const result = await query(
    `SELECT
       id,
       sheet_id,
       record_id,
       version,
       action,
       source,
       actor_id,
       changed_field_ids,
       patch,
       snapshot,
       created_at
     FROM meta_record_revisions
     WHERE sheet_id = $1 AND record_id = $2
     ORDER BY version DESC, created_at DESC
     LIMIT $3 OFFSET $4`,
    [input.sheetId, input.recordId, limit, offset],
  )
  return (result.rows as Array<Record<string, unknown>>).map(serializeRecordRevision)
}

function serializeRecordRevision(row: Record<string, unknown>): RecordRevisionEntry {
  return {
    id: String(row.id),
    sheetId: String(row.sheet_id),
    recordId: String(row.record_id),
    version: Number(row.version ?? 0),
    action: normalizeAction(row.action),
    source: typeof row.source === 'string' ? row.source : 'rest',
    actorId: typeof row.actor_id === 'string' ? row.actor_id : null,
    changedFieldIds: Array.isArray(row.changed_field_ids) ? row.changed_field_ids.map(String) : [],
    patch: normalizeJsonObject(row.patch),
    snapshot: row.snapshot === null || row.snapshot === undefined ? null : normalizeJsonObject(row.snapshot),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ''),
  }
}

function normalizeAction(value: unknown): RecordRevisionAction {
  return value === 'create' || value === 'delete' ? value : 'update'
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return {}
}
