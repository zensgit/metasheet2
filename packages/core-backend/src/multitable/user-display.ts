export type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>

/**
 * Resolve a `userId → display name` map for a set of user ids, using the canonical preference
 * `name → email` (the same order `buildPersonSummaries` uses for person fields). Only ids with a real
 * name/email are returned; an id with neither is omitted so the caller falls back to the raw id.
 * Returns an empty map (graceful) if the `users` table is absent — e.g. a minimal test harness.
 *
 * Read-only and NOT permission-gated: a user's display name is not sensitive on its own (it already
 * shows wherever that user appears — person fields, assignees, comments). This resolves the actor of an
 * action (who deleted / who changed), not record content.
 */
export async function resolveUserDisplayNames(
  query: QueryFn,
  userIds: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
  const out = new Map<string, string>()
  if (ids.length === 0) return out
  try {
    const res = await query('SELECT id, email, name FROM users WHERE id = ANY($1::text[])', [ids])
    for (const u of res.rows as Array<{ id?: unknown; email?: unknown; name?: unknown }>) {
      const id = typeof u.id === 'string' ? u.id : String(u.id ?? '')
      if (!id) continue
      const name = typeof u.name === 'string' ? u.name.trim() : ''
      const email = typeof u.email === 'string' ? u.email.trim() : ''
      const display = name || email
      if (display) out.set(id, display)
    }
  } catch {
    // users table absent (minimal harness) — return empty; callers fall back to the raw id.
  }
  return out
}
