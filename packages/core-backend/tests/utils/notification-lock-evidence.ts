// Test-only observer. SQL and parameters are forwarded unchanged; values are never recorded.
import { createHash } from 'node:crypto'

// The identity fence's thirteen tables; distinct from the authorization operation's 22 tables.
export const IDENTITY_FENCE_TABLES = [
  'users', 'user_roles', 'user_permissions', 'user_namespace_admissions', 'user_orgs',
  'user_external_auth_grants', 'directory_account_links', 'user_external_identities',
  'directory_accounts', 'directory_integrations', 'roles', 'role_permissions', 'permissions',
] as const

export class NotificationLockOrderStop extends Error {
  readonly code = 'N78_USER_LOCK_BEFORE_FENCE_WRITE'
  constructor(readonly location: string, readonly table: string) { super('N78_USER_LOCK_BEFORE_FENCE_WRITE') }
}

/** Scoped to the new background/read transactions, not the existing role writer protocol. */
export function observeNotificationQueries<T extends { rows: unknown[] }>(
  query: (sql: string, params?: unknown[]) => Promise<T>,
  usersForeignKeyChildren: ReadonlySet<string>,
  location: string,
) {
  let usersHeld = false
  const statements: Array<{ index: number; digest: string; code: string; elapsedMs: number }> = []
  const violations: Array<{ location: string; table: string; source: string }> = []
  return {
    statements,
    violations,
    query: async (sql: string, params?: unknown[]): Promise<T> => {
      const normalized = sql.replace(/"/g, '').replace(/\s+/g, ' ').trim()
      const writes = [...normalized.matchAll(/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:public\.)?([a-z_]+)\b/gi)]
        .map(match => match[1].toLowerCase())
      const table = writes.find(name => (IDENTITY_FENCE_TABLES as readonly string[]).includes(name))
      const position = `${location}:statement-${statements.length + 1}`
      if (usersHeld && table) {
        const source = new Error().stack?.replace(/\\/g, '/').split('\n')
          .map(line => line.match(/(src\/[^\s)]+:\d+:\d+)/)?.[1]).find(Boolean) ?? location
        violations.push({ location: position, table, source })
        throw new NotificationLockOrderStop(position, table)
      }
      const entry = { index: statements.length + 1, digest: createHash('sha256').update(sql).digest('hex'), code: 'pending', elapsedMs: 0 }
      statements.push(entry)
      const start = performance.now()
      try {
        const result = await query(sql, params)
        entry.code = 'OK'
        // Conservatively treat a successful FK-child write as holding users KEY SHARE.
        usersHeld ||= writes.some(name => name === 'users' || usersForeignKeyChildren.has(name))
          || (/\bFROM (?:public\.)?users\b/i.test(normalized)
            && /\bFOR (?:NO KEY UPDATE|KEY SHARE|UPDATE|SHARE)\b/i.test(normalized) && result.rows.length > 0)
        return result
      } catch (error) {
        entry.code = String((error as { code?: string }).code ?? 'QUERY_FAILED')
        throw error
      } finally { entry.elapsedMs = performance.now() - start }
    },
  }
}
