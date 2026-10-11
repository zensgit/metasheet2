// Shared with the closed integration snapshot. Keep the established mapper's
// coercion and overwrite semantics unchanged for ordinary records queries.
export function toIsoString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' && value.trim()) return value
  return null
}

export function injectSystemFieldValues(
  data: Record<string, unknown>,
  row: Record<string, unknown>,
  fields: ReadonlyArray<{ id: string; type: string }>,
): Record<string, unknown> {
  const hasSystemFields = fields.some((field) =>
    field.type === 'createdTime' ||
    field.type === 'modifiedTime' ||
    field.type === 'createdBy' ||
    field.type === 'modifiedBy',
  )
  if (!hasSystemFields) {
    return data
  }

  const next = { ...data }
  const values: Record<string, unknown> = {
    createdTime: toIsoString(row.created_at),
    modifiedTime: toIsoString(row.updated_at),
    createdBy: typeof row.created_by === 'string' ? row.created_by : null,
    modifiedBy: typeof row.modified_by === 'string' ? row.modified_by : null,
  }

  for (const field of fields) {
    if (field.type in values) {
      next[field.id] = values[field.type]
    }
  }

  return next
}
