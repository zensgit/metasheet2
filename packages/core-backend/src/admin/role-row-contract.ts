import type { AccessGraphTransactionClient } from '../directory/access-graph-mutex'

export class RoleRowMissingError extends Error {
  readonly code = 'ROLE_NOT_FOUND'
  constructor() {
    super('Role not found')
    this.name = 'RoleRowMissingError'
  }
}

export class RoleModifiedError extends Error {
  readonly code = 'ROLE_MODIFIED'
  constructor() {
    super('This role changed since it was loaded; reload it and re-apply the change')
    this.name = 'RoleModifiedError'
  }
}

function toEpochMillis(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

export async function lockRoleRowForShare(
  client: AccessGraphTransactionClient,
  roleId: string,
  expectedUpdatedAt: number | null = null,
): Promise<boolean> {
  if (expectedUpdatedAt === null) {
    const locked = await client.query('SELECT id FROM roles WHERE id = $1 FOR SHARE', [roleId])
    return locked.rows.length > 0
  }
  const locked = await client.query(
    'SELECT id, updated_at FROM roles WHERE id = $1 FOR SHARE',
    [roleId],
  )
  if (!locked.rows.length) return false
  const stored = toEpochMillis(locked.rows[0]?.updated_at)
  if (stored === null || stored !== expectedUpdatedAt) throw new RoleModifiedError()
  return true
}
