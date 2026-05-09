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

  // Single UPDATE assigns sequential values to all eligible records via
  // ROW_NUMBER() over the same (created_at ASC, id ASC) ordering the
  // previous SELECT-then-loop-UPDATE implementation used. Replaces N+1
  // round-trips with one server-side scan + atomic batched UPDATE,
  // which matters when CREATE FIELD autoNumber runs against an
  // existing sheet of 10k+ records.
  //
  // Concurrency safety is preserved by the advisory locks acquired
  // above: the sheet-level lock serializes CREATE FIELD backfill
  // against record-create paths, and the field-level lock excludes
  // concurrent backfills on the same field. The UPDATE itself takes
  // row-level locks atomically as it executes, so no separate
  // SELECT ... FOR UPDATE is required.
  const overwrite = opts?.overwrite === true
  const updated = await query(
    `UPDATE meta_records mr
     SET data = jsonb_set(
       COALESCE(mr.data, '{}'::jsonb),
       ARRAY[$1]::text[],
       to_jsonb(numbered.value::integer),
       true
     )
     FROM (
       SELECT
         id,
         ($2::integer + (ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC))::integer - 1) AS value
       FROM meta_records
       WHERE sheet_id = $3
         AND ($4::boolean OR NOT (data ? $1))
     ) numbered
     WHERE mr.id = numbered.id
       AND mr.sheet_id = $3
     RETURNING numbered.value`,
    [fieldId, config.start, sheetId, overwrite],
  )

  const assigned = typeof updated.rowCount === 'number' && updated.rowCount >= 0
    ? updated.rowCount
    : updated.rows.length
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
