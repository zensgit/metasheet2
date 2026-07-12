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

/** A person-field directory entry: the same shape the grid's PersonSummary carries (minus `id`). */
export type PersonDirectoryEntry = { display: string; inactive?: boolean }

/**
 * Person before-side name resolution (OD-P1 = Option A, OD-P2 = carry `inactive`).
 *
 * Resolve `userId → { display, inactive }` for user ids that appear in person-field VALUES. Same
 * directory + same rules as `resolveUserDisplayNames` / `buildPersonSummaries`, so there is ONE source
 * of truth for both:
 *   - display preference `name → email`, falling back to the RAW userId when the user row exists but
 *     carries neither (parity with the grid's person summaries, univer-meta.ts:5449);
 *   - `inactive: true` iff `users.is_active === false` (2c-S4, univer-meta.ts:5433) — a deactivated
 *     assignee still renders, marked, and stays non-re-assignable.
 * Graceful empty map if the `users` table is absent (minimal harness) → caller falls back to the raw id.
 *
 * WHY THIS IS NOT A DISCLOSURE (LOCK-3): the caller resolves ONLY the userIds that are already present
 * in the POST-MASK payload. A person field the actor cannot read has had its values dropped by
 * `filterDataByAllowedFields` before this runs, so its userIds never reach here. Turning an ALREADY-VISIBLE
 * userId into its display name is directory-level information (the same name already renders wherever
 * that user appears, and `actorName` resolves it from this very table) — it is not a new disclosure of the
 * field's value. Never call this with ids harvested from an unmasked snapshot.
 */
export async function resolvePersonDirectoryEntries(
  query: QueryFn,
  userIds: Array<string | null | undefined>,
): Promise<Map<string, PersonDirectoryEntry>> {
  const ids = [...new Set(userIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
  const out = new Map<string, PersonDirectoryEntry>()
  if (ids.length === 0) return out
  try {
    const res = await query('SELECT id, email, name, is_active FROM users WHERE id = ANY($1::text[])', [ids])
    for (const u of res.rows as Array<{ id?: unknown; email?: unknown; name?: unknown; is_active?: unknown }>) {
      const id = typeof u.id === 'string' ? u.id : String(u.id ?? '')
      if (!id) continue
      const name = typeof u.name === 'string' ? u.name.trim() : ''
      const email = typeof u.email === 'string' ? u.email.trim() : ''
      const display = name || email || id // raw-id fallback, matching the grid's person summaries
      out.set(id, u.is_active === false ? { display, inactive: true } : { display })
    }
  } catch {
    // users table absent (minimal harness) — return empty; callers fall back to the raw id.
  }
  return out
}
