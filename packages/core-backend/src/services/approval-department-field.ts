import type { FormSchema } from '../types/approval-product'

type QueryFn = <Row>(text: string, params?: unknown[]) => Promise<{ rows: Row[] }>

export class ApprovalDepartmentUnavailableError extends Error {
  constructor() {
    super('approval department selection is unavailable')
    this.name = 'ApprovalDepartmentUnavailableError'
  }
}

/**
 * Lock-2 L2-A submit-time canonicalization. Structural validation has already reduced every
 * value to exact `{ id }` objects before this async directory read runs.
 */
export async function canonicalizeApprovalDepartmentFormData(
  formSchema: FormSchema,
  formData: Record<string, unknown>,
  integrationId: string,
  query: QueryFn,
): Promise<void> {
  const departmentFields = formSchema.fields.filter((field) => field.type === 'department')
  if (departmentFields.length === 0) return

  const ids = [...new Set(departmentFields.flatMap((field) => {
    const value = formData[field.id]
    if (!Array.isArray(value)) return []
    return value.map((entry) => (entry as { id: string }).id.trim())
  }))]
  if (ids.length === 0) return

  const result = await query<{
    id: string
    name: string
    full_path: string | null
  }>(
    `SELECT id::text AS id, name, full_path
       FROM directory_departments
      WHERE integration_id = $1::uuid
        AND id = ANY($2::uuid[])
        AND is_active = true`,
    [integrationId, ids],
  )
  const canonical = new Map<string, { id: string; name: string; fullPath: string }>()
  for (const row of result.rows) {
    const name = row.name.trim()
    if (!name) continue
    canonical.set(row.id, {
      id: row.id,
      name,
      fullPath: row.full_path?.trim() || name,
    })
  }
  if (canonical.size !== ids.length) {
    throw new ApprovalDepartmentUnavailableError()
  }

  const replacements = new Map<string, Array<{ id: string; name: string; fullPath: string }>>()
  for (const field of departmentFields) {
    const value = formData[field.id]
    if (!Array.isArray(value)) continue
    const resolved = value.map((entry) => canonical.get((entry as { id: string }).id.trim()))
    if (resolved.some((entry) => entry === undefined)) {
      throw new ApprovalDepartmentUnavailableError()
    }
    replacements.set(
      field.id,
      resolved as Array<{ id: string; name: string; fullPath: string }>,
    )
  }
  for (const [fieldId, value] of replacements) formData[fieldId] = value
}
