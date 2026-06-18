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
 * 2c-S2 (source of truth = B: member-group directory) — the READ counterpart of
 * createPersonMemberResolver. Returns the assignable directory of a person field: the SAME allowed
 * set the write-validator accepts (sheet members ∩ active group members; unrestricted ⇒ sheet
 * members), hydrated with display info and filtered to ACTIVE users. Inactive/deleted users are
 * excluded here (not assignable) — they remain READ-only via the stored value / buildPersonSummaries,
 * never surfaced as assignable. The picker (2c-S3) consumes this so what it offers === what the
 * validator will accept (display parity). Ordered by name for stable display. Read-only; sits behind
 * the existing restriction seam (reuses createPersonMemberResolver — single source of truth).
 */
export async function resolvePersonAssignableDirectory(
  query: QueryFn,
  sheetId: string,
  restrictGroupIds: string[],
  /** Injectable allowed-set resolver (defaults to the canonical write-validator resolver) — lets unit
   *  tests exercise hydration without the full candidate-resolution query chain. */
  resolveAllowed: (groupIds: string[]) => Promise<Set<string>> = createPersonMemberResolver(query, sheetId),
): Promise<PersonDirectoryEntry[]> {
  const allowed = await resolveAllowed(restrictGroupIds)
  if (allowed.size === 0) return []
  const res = await query(
    `SELECT id::text AS uid, name, email
       FROM users
      WHERE id::text = ANY($1::text[])
        AND is_active = TRUE
      ORDER BY name NULLS LAST, id`,
    [Array.from(allowed)],
  )
  return (res.rows as Array<Record<string, unknown>>).map((row) => ({
    userId: String(row.uid),
    name: typeof row.name === 'string' ? row.name : null,
    email: typeof row.email === 'string' ? row.email : null,
  }))
}
