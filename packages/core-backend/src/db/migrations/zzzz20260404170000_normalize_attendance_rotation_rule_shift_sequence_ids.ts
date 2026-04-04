import type { Kysely } from 'kysely'
import { sql } from 'kysely'

type RotationRuleRow = {
  id: string
  org_id: string
  shift_sequence: unknown
}

type ShiftRefRow = {
  id: string
  org_id: string
  name: string
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map((item) => String(item).trim()).filter(Boolean) : []
    } catch {
      return []
    }
  }
  return []
}

function normalizeUuidString(value: string): string | null {
  const normalized = value.trim()
  if (!normalized) return null
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
    ? normalized
    : null
}

function buildShiftLookup(rows: ShiftRefRow[]) {
  const byId = new Set<string>()
  const byName = new Map<string, string[]>()
  for (const row of rows) {
    byId.add(row.id)
    const name = row.name.trim()
    if (!name) continue
    if (!byName.has(name)) byName.set(name, [])
    byName.get(name)!.push(row.id)
  }
  return { byId, byName }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const ruleResult = await sql<RotationRuleRow>`
    SELECT id, org_id, shift_sequence
    FROM attendance_rotation_rules
  `.execute(db)
  if (!ruleResult.rows.length) return

  const shiftResult = await sql<ShiftRefRow>`
    SELECT id, org_id, name
    FROM attendance_shifts
  `.execute(db)

  const shiftsByOrg = new Map<string, ShiftRefRow[]>()
  for (const row of shiftResult.rows) {
    const orgId = row.org_id || 'default'
    if (!shiftsByOrg.has(orgId)) shiftsByOrg.set(orgId, [])
    shiftsByOrg.get(orgId)!.push(row)
  }

  for (const rule of ruleResult.rows) {
    const current = normalizeStringArray(rule.shift_sequence)
    if (!current.length) continue
    const lookup = buildShiftLookup(shiftsByOrg.get(rule.org_id || 'default') ?? [])
    let changed = false
    const next = current.map((shiftRef) => {
      const uuid = normalizeUuidString(shiftRef)
      if (uuid && lookup.byId.has(uuid)) return uuid
      const matches = lookup.byName.get(shiftRef) ?? []
      if (matches.length === 1) {
        changed = true
        return matches[0]
      }
      return shiftRef
    })
    if (!changed) continue
    await sql`
      UPDATE attendance_rotation_rules
      SET shift_sequence = ${JSON.stringify(next)}::jsonb,
          updated_at = now()
      WHERE id = ${rule.id}
        AND org_id = ${rule.org_id}
    `.execute(db)
  }
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // Name-based sequences are lossy after promotion to stable ids; no rollback.
}
