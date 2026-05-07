import { normalizeAutoNumberProperty } from './auto-number-property'
import type { MultitableField } from './field-codecs'

export type AutoNumberQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

function sheetLockKey(sheetId: string): string {
  return `meta:auto-number:sheet:${sheetId}`
}

function lockKey(sheetId: string, fieldId: string): string {
  return `meta:auto-number:${sheetId}:${fieldId}`
}

export async function acquireAutoNumberSheetWriteLock(
  query: AutoNumberQuery,
  sheetId: string,
): Promise<void> {
  await query('SELECT pg_advisory_xact_lock(hashtext($1))', [sheetLockKey(sheetId)])
}

async function acquireFieldLock(query: AutoNumberQuery, sheetId: string, fieldId: string): Promise<void> {
  await query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey(sheetId, fieldId)])
}

export async function allocateAutoNumberRange(
  query: AutoNumberQuery,
  sheetId: string,
  field: Pick<MultitableField, 'id' | 'type' | 'property'>,
  count: number,
): Promise<number[]> {
  if (field.type !== 'autoNumber' || count <= 0) return []
  const batchSize = Math.floor(count)
  if (!Number.isFinite(batchSize) || batchSize <= 0) return []

  await acquireFieldLock(query, sheetId, field.id)
  const config = normalizeAutoNumberProperty(field.property)
  const result = await query(
    `INSERT INTO meta_field_auto_number_sequences (field_id, sheet_id, next_value)
     VALUES ($1, $2, $3)
     ON CONFLICT (field_id)
     DO UPDATE SET next_value = meta_field_auto_number_sequences.next_value + $4,
                   updated_at = now()
     RETURNING next_value - $4 AS start_value`,
    [field.id, sheetId, config.start + batchSize, batchSize],
  )
  const startValue = Number((result.rows[0] as { start_value?: unknown } | undefined)?.start_value ?? config.start)
  return Array.from({ length: batchSize }, (_, index) => startValue + index)
}

export async function allocateAutoNumberValues(
  query: AutoNumberQuery,
  sheetId: string,
  fields: Array<Pick<MultitableField, 'id' | 'type' | 'property'>>,
): Promise<Record<string, number>> {
  const autoNumberFields = fields.filter((field) => field.type === 'autoNumber')
  if (autoNumberFields.length === 0) return {}

  const values: Record<string, number> = {}
  for (const field of autoNumberFields) {
    const [value] = await allocateAutoNumberRange(query, sheetId, field, 1)
    if (typeof value === 'number') values[field.id] = value
  }
  return values
}

export type BackfillAutoNumberFieldResult = {
  assigned: number
  nextValue: number
}

export async function backfillAutoNumberField(
  query: AutoNumberQuery,
  sheetId: string,
  fieldId: string,
  property: unknown,
  opts?: { overwrite?: boolean },
): Promise<BackfillAutoNumberFieldResult> {
  const config = normalizeAutoNumberProperty(property)
  await acquireAutoNumberSheetWriteLock(query, sheetId)
  await acquireFieldLock(query, sheetId, fieldId)

  const rows = await query(
    `SELECT id
     FROM meta_records
     WHERE sheet_id = $1
       AND ($2::boolean OR NOT (data ? $3))
     ORDER BY created_at ASC, id ASC
     FOR UPDATE`,
    [sheetId, opts?.overwrite === true, fieldId],
  )

  let assigned = 0
  for (const row of rows.rows as Array<{ id?: unknown }>) {
    const recordId = typeof row.id === 'string' ? row.id : ''
    if (!recordId) continue
    const value = config.start + assigned
    await query(
      `UPDATE meta_records
       SET data = jsonb_set(COALESCE(data, '{}'::jsonb), ARRAY[$1]::text[], to_jsonb($2::integer), true)
       WHERE sheet_id = $3 AND id = $4`,
      [fieldId, value, sheetId, recordId],
    )
    assigned += 1
  }

  const nextValue = config.start + assigned
  await query(
    `INSERT INTO meta_field_auto_number_sequences (field_id, sheet_id, next_value)
     VALUES ($1, $2, $3)
     ON CONFLICT (field_id)
     DO UPDATE SET next_value = GREATEST(meta_field_auto_number_sequences.next_value, EXCLUDED.next_value),
                   updated_at = now()`,
    [fieldId, sheetId, nextValue],
  )

  return { assigned, nextValue }
}
