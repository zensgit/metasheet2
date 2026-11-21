import type { StrictLoginGrantCaller } from './strict-login-grant-store'

type ResourceQuery = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>

function scopeCaller(query: ResourceQuery): StrictLoginGrantCaller {
  return {
    async query(sql, params) {
      const result = await query(sql, params)
      return { rows: result.rows as Record<string, unknown>[] }
    },
  }
}

export async function checkCardConnectionBeforeDispatch(
  query: ResourceQuery,
  connectionId: string,
  lock: boolean,
): Promise<'ordinary' | 'uninstalled' | 'refused'> {
  try {
    const store = await import('./strict-login-grant-store')
    const state = lock
      ? await store.readConnectionLoginScope(scopeCaller(query), connectionId)
      : await store.readCurrentConnectionLoginScope(scopeCaller(query), connectionId)
    if (state.installation === 'never-installed') return 'uninstalled'
    return state.scope ? 'refused' : 'ordinary'
  } catch {
    return 'refused'
  }
}

export async function legacyGrantAllowsPublicForm(
  query: ResourceQuery,
  userId: string,
  strictSession: boolean,
  lock: boolean,
): Promise<boolean> {
  if (strictSession) return false
  const caller = scopeCaller(query)
  try {
    const store = await import('./strict-login-grant-store')
    if ((await store.readStrictLoginInstallation(caller)).installation === 'never-installed') return true
    if (lock) {
      // Link and identity writers serialize on the same user as the cutover.
      const user = await query('SELECT id FROM users WHERE id = $1 FOR SHARE NOWAIT', [userId])
      if (user.rows.length !== 1) return false
    }
    const scopes = await query('SELECT 1 FROM directory_connection_login_scope LIMIT 1')
    if (!scopes.rows.length) return !lock || await store.lockEmptyConnectionLoginScope(caller)

    // A legacy grant is keyed only by user. Every binding that could authorize it must
    // independently identify the same ordinary connection; a null or multiple origins refuse.
    const sources = await query(
      `WITH origins(connection_id) AS (
         SELECT CASE WHEN COUNT(i.id) = 1 AND BOOL_AND(i.status = 'active')
                     THEN MIN(i.id::text) END
           FROM user_external_identities e
           LEFT JOIN directory_integrations i ON i.provider = e.provider AND i.corp_id = e.corp_id
          WHERE e.provider = 'dingtalk' AND e.local_user_id = $1
          GROUP BY e.id
         UNION ALL
         SELECT CASE WHEN account.is_active AND i.status = 'active' AND i.corp_id = account.corp_id
                     THEN i.id::text END
           FROM directory_account_links link
           JOIN directory_accounts account ON account.id = link.directory_account_id
           LEFT JOIN directory_integrations i ON i.id = account.integration_id AND i.provider = account.provider
          WHERE link.link_status = 'linked' AND account.provider = 'dingtalk' AND link.local_user_id = $1
       )
       SELECT DISTINCT connection_id FROM origins LIMIT 2`,
      [userId],
    )
    const origin = sources.rows[0] as { connection_id?: unknown } | undefined
    if (sources.rows.length !== 1 || typeof origin?.connection_id !== 'string') return false
    const state = lock
      ? await store.readConnectionLoginScope(caller, origin.connection_id)
      : await store.readCurrentConnectionLoginScope(caller, origin.connection_id)
    return state.installation === 'installed' && !state.scope
  } catch {
    return false
  }
}
