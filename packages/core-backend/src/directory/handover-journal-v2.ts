import { createHash } from 'node:crypto'

type Row = Record<string, unknown>

export type HandoverJournalV2 = {
  version: 2
  beforeDigest: string
  accounts: { id: string; updated_at: string }[]
  targetDepartmentIds: string[]
}

// This canonicalization also verifies pre-v2 snapshots. Keep its bytes stable.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

// The full snapshot is hashed in memory. Only the original timestamps of the
// moved accounts and the set of pre-existing target departments are needed to undo apply.
export function compactHandoverJournal(
  snapshot: { accounts: Row[]; departments: Row[] },
  sourceId: string,
  targetId: string,
): HandoverJournalV2 {
  const accounts: HandoverJournalV2['accounts'] = []
  const targetDepartmentIds: string[] = []
  for (const row of snapshot.accounts) {
    if (
      typeof row.id !== 'string' ||
      typeof row.updated_at !== 'string' ||
      (row.integration_id !== sourceId && row.integration_id !== targetId)
    ) {
      throw new Error('Invalid handover account snapshot')
    }
    if (row.integration_id === sourceId)
      accounts.push({ id: row.id, updated_at: row.updated_at })
  }
  for (const row of snapshot.departments) {
    if (
      typeof row.id !== 'string' ||
      (row.integration_id !== sourceId && row.integration_id !== targetId)
    ) {
      throw new Error('Invalid handover department snapshot')
    }
    if (row.integration_id === targetId) targetDepartmentIds.push(row.id)
  }
  if (!accounts.length) throw new Error('Missing handover source accounts')
  return {
    version: 2,
    beforeDigest: digest(snapshot),
    accounts,
    targetDepartmentIds,
  }
}
