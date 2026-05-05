import { normalizeJson, type MultitableField } from './field-codecs'

export type AutoNumberQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

function resolveStartAt(property: unknown): number {
  const obj = normalizeJson(property)
  const raw = typeof obj.startAt === 'number' ? obj.startAt : Number(obj.startAt)
  if (!Number.isFinite(raw) || raw < 1) return 1
  return Math.floor(raw)
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
    const startAt = resolveStartAt(field.property)
    const result = await query(
      `INSERT INTO meta_field_auto_number_sequences (field_id, sheet_id, next_value)
       VALUES ($1, $2, $3)
       ON CONFLICT (field_id)
       DO UPDATE SET next_value = meta_field_auto_number_sequences.next_value + 1,
                     updated_at = now()
       RETURNING next_value - 1 AS value`,
      [field.id, sheetId, startAt + 1],
    )
    const value = Number((result.rows[0] as { value?: unknown } | undefined)?.value ?? startAt)
    values[field.id] = value
  }
  return values
}
