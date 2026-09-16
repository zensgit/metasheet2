import { JS_TRIM_WHITESPACE } from '../utils/js-trim-whitespace'
import { loadSheetMemberUserIdSet, type QueryFn } from './permission-service'

/**
 * #16 org-member directory — the member-group ids a person field restricts NEW assignment to.
 * Empty ⇒ unrestricted. Sanitizes to trimmed, de-duped, non-empty strings.
 */
export function personRestrictGroupIds(field: { property?: unknown } | undefined | null): string[] {
  const raw = (field?.property as Record<string, unknown> | undefined)?.restrictToMemberGroupIds
  if (!Array.isArray(raw)) return []
  return Array.from(
    new Set(
      raw
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .map((v) => v.trim()),
    ),
  )
}

/**
 * #16 — SINGLE source of truth for the ALLOWED assignee set of a person field, shared by
 * RecordService (REST create/patch + form submit) AND RecordWriteService (bulk / Yjs / automation),
 * so every write path enforces identically (the route-parity fix).
 *
 * allowed = (sheet members) ∩ (active users in the field's restrictToMemberGroupIds); when the field
 * is unrestricted ⇒ just the sheet members. FAIL-CLOSED: a restricted field whose groups contain no
 * eligible member ⇒ empty set ⇒ every new assignment rejected. Read-back is unaffected (validation is
 * write-only) so pre-existing out-of-scope values are grandfathered. Caches the sheet set + each
 * restrict-key so a bulk op hits the DB once.
 */
export function createPersonMemberResolver(
  query: QueryFn,
  sheetId: string,
  /** Injectable sheet-member loader (defaults to the canonical query); lets callers that already
   *  inject a loader for testability keep their seam. */
  loadSheetMembers: (q: QueryFn, sid: string) => Promise<Set<string>> = loadSheetMemberUserIdSet,
): (restrictGroupIds: string[]) => Promise<Set<string>> {
  let sheetMembers: Set<string> | null = null
  const cache = new Map<string, Set<string>>()

  const loadGroupUserIds = async (groupIds: string[]): Promise<Set<string>> => {
    if (groupIds.length === 0) return new Set<string>()
    const res = await query(
      `SELECT DISTINCT gm.user_id::text AS uid
         FROM platform_member_group_members gm
         JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id::text = ANY($1::text[])
          AND u.is_active = TRUE`,
      [groupIds],
    )
    return new Set(
      (res.rows as Array<Record<string, unknown>>)
        .map((row) => (typeof row.uid === 'string' ? row.uid.trim() : ''))
        .filter((v): v is string => v.length > 0),
    )
  }

  return async (restrictGroupIds: string[]): Promise<Set<string>> => {
    if (sheetMembers === null) sheetMembers = await loadSheetMembers(query, sheetId)
    if (restrictGroupIds.length === 0) return sheetMembers
    const key = Array.from(new Set(restrictGroupIds)).sort().join(',')
    let restricted = cache.get(key)
    if (!restricted) {
      const groupSet = await loadGroupUserIds(restrictGroupIds)
      // Intersect with the sheet member set: strictly narrows, never widens.
      restricted = new Set<string>()
      for (const id of sheetMembers) if (groupSet.has(id)) restricted.add(id)
      cache.set(key, restricted)
    }
    return restricted
  }
}

export interface PersonDirectoryEntry {
  userId: string
  name: string | null
  email: string | null
}

/**
 * #5781 — HYDRATION bounds for the directory read model. These narrow what the DB is asked to hand
 * back about the allowed set; they do NOT touch WHO is in that set (the allowed-set resolver above is
 * untouched, so the picker and the write validator keep answering from the same eligibility).
 */
export interface PersonDirectoryHydrationOptions {
  /** Case-insensitive SUBSTRING match against name/email — the same two columns the caller used to
   *  filter in memory before #5781. LIKE metacharacters in the term are escaped, so it stays a literal
   *  substring match (a bare `%` matches a literal percent sign, not everything). */
  search?: string
  /** #5809 — EXACT lookup, used by the import resolver instead of `search`. When `exact` is present
   *  (even blank), `search` is ignored. Case-insensitive EQUALITY against the user id, the trimmed
   *  name or the trimmed email — never a substring — so a lookup hands back only the rows that ARE the
   *  token, not the up-to-`limit` neighbours a substring term would. It is one more predicate on the
   *  same row set: `$1` (the allowed set) and `is_active` are untouched, so every row it can return
   *  is drawn from the same eligible set a `search` call reads (the id arm included). No LIKE, so no
   *  escaping is needed; the term is bound as a parameter.
   *  - The stored name/email are trimmed with the character set JS `trim()` strips (JS_TRIM_WHITESPACE,
   *    bound as a parameter), not with `btrim`'s default of U+0020 only, so a value stored with a
   *    trailing U+3000 / NBSP / tab still equals the term the client trimmed.
   *  - A term that is blank after trimming matches NOBODY: the call returns [] without issuing any
   *    query (fail closed). It never degrades into a predicate-less read of the allowed set. */
  exact?: string
  /** Hard ceiling on hydrated rows, applied as SQL `LIMIT` so the bound holds for THIS query's DB
   *  round trip.
   *
   *  SCOPE — do not over-read this (the earlier wording overclaimed): it bounds the DISPLAY HYDRATION
   *  only. The allowed-set resolution that runs FIRST (loadSheetMemberUserIdSet →
   *  listSheetPermissionCandidates with `{ limit: 10000 }`, multitable/permission-service.ts:618)
   *  already pulls up to 10,000 candidate rows INCLUDING u.name / u.email out of the DB and
   *  materializes them, so names/emails past this ceiling DO still enter the process on every bounded
   *  request — they just never leave it. Bounding that first read is part of the tracked set-narrowing
   *  follow-up, not this option. */
  limit?: number
}

/** Escapes the LIKE metacharacters so `search` behaves as a literal substring (PG's default LIKE
 *  escape character is the backslash). Exported so the form-share candidate read (univer-meta.ts)
 *  can hand listSheetPermissionCandidates a literal term without that shared function changing. */
export function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/**
 * 2c-S2 (source of truth = B: member-group directory) — the READ counterpart of
 * createPersonMemberResolver. Returns the assignable directory of a person field: the SAME allowed
 * set the write-validator accepts (sheet members ∩ active group members; unrestricted ⇒ sheet
 * members), hydrated with display info and filtered to ACTIVE users. Inactive/deleted users are
 * excluded here (not assignable) — they remain READ-only via the stored value / buildPersonSummaries,
 * never surfaced as assignable. The picker (2c-S3) consumes this so what it offers === what the
 * validator will accept (display parity). Ordered by name for stable display. Read-only; sits behind
 * the existing restriction seam (reuses createPersonMemberResolver — single source of truth).
 *
 * #5781: `options` bounds the HYDRATION (search term + LIMIT) so a caller that can only show N rows
 * does not ship the whole roster's names/emails to the client. SCOPE: that is a DISCLOSURE bound, not
 * an end-to-end DB-read bound — `resolveAllowed` runs first and, on the default (route) path, reads up
 * to 10,000 candidate rows with name/email into the process (see the `limit` doc above). The allowed
 * set itself is resolved exactly as before and is still the write validator's set — the bounds filter
 * the display rows, they do not decide eligibility.
 */
export async function resolvePersonAssignableDirectory(
  query: QueryFn,
  sheetId: string,
  restrictGroupIds: string[],
  /** Injectable allowed-set resolver (defaults to the canonical write-validator resolver) — lets unit
   *  tests exercise hydration without the full candidate-resolution query chain. */
  resolveAllowed: (groupIds: string[]) => Promise<Set<string>> = createPersonMemberResolver(query, sheetId),
  /** #5781 hydration bounds (search / LIMIT). Absent ⇒ hydrate the whole allowed set, the pre-#5781
   *  behavior every non-route caller still gets. Never affects the allowed set itself. */
  options?: PersonDirectoryHydrationOptions,
): Promise<PersonDirectoryEntry[]> {
  const exact = options?.exact?.trim() ?? ''
  // #5809: an exact lookup of nothing is an answer of nothing — decided before ANY query (the allowed
  // set included), so a caller that forgot to check its term can never turn exact mode into a browse.
  if (typeof options?.exact === 'string' && !exact) return []
  const allowed = await resolveAllowed(restrictGroupIds)
  if (allowed.size === 0) return []
  // $1 is ALWAYS the full allowed set — the eligibility answer is unchanged by the bounds below.
  const params: unknown[] = [Array.from(allowed)]
  const conditions = ['id::text = ANY($1::text[])', 'is_active = TRUE']
  const search = exact ? '' : (options?.search?.trim() ?? '')
  if (exact) {
    params.push(exact)
    const term = `$${params.length}::text`
    params.push(JS_TRIM_WHITESPACE)
    const trimSet = `$${params.length}::text`
    conditions.push(
      `(lower(id::text) = lower(${term}) OR lower(btrim(COALESCE(name, ''), ${trimSet})) = lower(${term}) OR lower(btrim(COALESCE(email, ''), ${trimSet})) = lower(${term}))`,
    )
  } else if (search) {
    params.push(`%${escapeLikeTerm(search)}%`)
    conditions.push(`(COALESCE(name, '') ILIKE $${params.length} OR COALESCE(email, '') ILIKE $${params.length})`)
  }
  let sql = `SELECT id::text AS uid, name, email
       FROM users
      WHERE ${conditions.join('\n        AND ')}
      ORDER BY name NULLS LAST, id`
  const limit = options?.limit
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
    params.push(Math.floor(limit))
    sql += `\n      LIMIT $${params.length}`
  }
  const res = await query(sql, params)
  return (res.rows as Array<Record<string, unknown>>).map((row) => ({
    userId: String(row.uid),
    name: typeof row.name === 'string' ? row.name : null,
    email: typeof row.email === 'string' ? row.email : null,
  }))
}
