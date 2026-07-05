/**
 * Personal (per-user) view config overlay — Slice 1.
 *
 * Ratified design: docs/development/multitable-personal-views-design-lock-20260705.md
 * Verification: docs/development/multitable-personal-views-slice1-verification-20260705.md
 *
 * §1-B (LOAD-BEARING, actor-scoped isolation): every read/write of personal config in this
 * module is keyed to the AUTHENTICATED ACTOR's user id, resolved via
 * `resolveRequestAccess(req).userId` (JWT/session-derived, `../rbac` + `req.user`) at the
 * route layer — NEVER from `req.body`, `req.query`, or an `x-user-id`-style header. This
 * module itself never reads `req` at all: callers MUST pass the already-resolved actor id,
 * which keeps the anti-precedent (legacy `view_states` / `kanban.ts:25` client-supplied
 * `x-user-id`, `views.ts:273,298` `|| 0`) structurally impossible to reintroduce here.
 *
 * §1-C (resolution contract): effective config = personal override for the actor (if a row
 * exists) ELSE the shared view config. Absent/partial override degrades to shared, never to
 * empty/broken. `applyPersonalViewOverlay` returns the ORIGINAL view object unchanged
 * (same reference) when there is no overlay to apply, so the flag-off / no-override path is
 * byte-identical to today's shared path (G-B) by construction, not by careful merging.
 *
 * §P2 (flag default-off): `isPersonalViewsEnabled()` reads `MULTITABLE_ENABLE_PERSONAL_VIEWS`
 * (same env-flag convention as the other `MULTITABLE_ENABLE_*` gates in `routes/univer-meta.ts`)
 * and defaults to OFF. Route call sites MUST check this before ever fetching/applying overlays.
 */

export type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>

/** The facets a personal overlay may set. Field-order overlay is OUT of scope for slice 1 (slice 2). */
export type PersonalViewConfigOverlay = {
  filterInfo?: Record<string, unknown>
  sortInfo?: Record<string, unknown>
  groupInfo?: Record<string, unknown>
  hiddenFieldIds?: string[]
}

export type PersonalViewConfigRecord = {
  viewId: string
  userId: string
  config: PersonalViewConfigOverlay
  updatedAt: string
}

const OVERLAY_KEYS = ['filterInfo', 'sortInfo', 'groupInfo', 'hiddenFieldIds'] as const

export const PERSONAL_VIEWS_FLAG_ENV = 'MULTITABLE_ENABLE_PERSONAL_VIEWS'

/** P2: default-OFF feature gate. Flag-on is NOT authorized by this slice — see the design-lock §5. */
export function isPersonalViewsEnabled(): boolean {
  return String(process.env[PERSONAL_VIEWS_FLAG_ENV] ?? '').trim().toLowerCase() === 'true'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whitelist-sanitize a client-supplied overlay body down to only the known slice-1 facets,
 * with the expected shape per facet. Unknown keys (including any attempt to smuggle a
 * `userId` / `viewId` override inside the config body) are silently dropped — the actor and
 * view identity are NEVER taken from this payload, only from the route's own resolved values.
 */
export function sanitizePersonalOverlayConfig(input: unknown): PersonalViewConfigOverlay {
  if (!isPlainObject(input)) return {}
  const out: PersonalViewConfigOverlay = {}
  if (isPlainObject(input.filterInfo)) out.filterInfo = input.filterInfo
  if (isPlainObject(input.sortInfo)) out.sortInfo = input.sortInfo
  if (isPlainObject(input.groupInfo)) out.groupInfo = input.groupInfo
  if (Array.isArray(input.hiddenFieldIds)) {
    out.hiddenFieldIds = input.hiddenFieldIds.filter((id): id is string => typeof id === 'string')
  }
  return out
}

function normalizeStoredOverlay(value: unknown): PersonalViewConfigOverlay {
  // Defensive: a row's `config` jsonb should already be sanitized on write, but normalize again
  // on read so a legacy/hand-edited row can never inject an unexpected facet into resolution.
  return sanitizePersonalOverlayConfig(value)
}

/**
 * §1-C resolution: merge a personal overlay onto a shared view, facet-by-facet. Facets absent
 * from the overlay fall through to the shared value untouched (§1-D, additive). When there is
 * no overlay at all, the ORIGINAL view reference is returned unchanged — this is what makes
 * the flag-off / no-override path byte-identical to today (G-B), not merely "similar".
 */
export function applyPersonalViewOverlay<
  T extends {
    filterInfo?: Record<string, unknown>
    sortInfo?: Record<string, unknown>
    groupInfo?: Record<string, unknown>
    hiddenFieldIds?: string[]
  },
>(view: T, overlay: PersonalViewConfigOverlay | null | undefined): T {
  if (!overlay) return view
  const hasAnyFacet = OVERLAY_KEYS.some((key) => overlay[key] !== undefined)
  if (!hasAnyFacet) return view

  return {
    ...view,
    ...(overlay.filterInfo !== undefined ? { filterInfo: overlay.filterInfo } : {}),
    ...(overlay.sortInfo !== undefined ? { sortInfo: overlay.sortInfo } : {}),
    ...(overlay.groupInfo !== undefined ? { groupInfo: overlay.groupInfo } : {}),
    ...(overlay.hiddenFieldIds !== undefined ? { hiddenFieldIds: overlay.hiddenFieldIds } : {}),
  }
}

/**
 * Fetch this actor's personal overrides for a batch of views in one query. Callers MUST pass
 * an already-resolved authenticated actor id (never a client-supplied value) — see the
 * module-level note. Returns an empty map for an empty/blank userId (fail-closed: no actor,
 * no overlay).
 */
export async function fetchPersonalViewConfigsForViews(
  query: QueryFn,
  viewIds: string[],
  actorUserId: string,
): Promise<Map<string, PersonalViewConfigOverlay>> {
  const map = new Map<string, PersonalViewConfigOverlay>()
  const ids = Array.from(new Set(viewIds.filter((id) => typeof id === 'string' && id.length > 0)))
  if (ids.length === 0 || !actorUserId) return map

  const result = await query(
    'SELECT view_id, config FROM meta_view_personal_configs WHERE view_id = ANY($1::text[])',
    [ids],
  )
  for (const row of result.rows as Array<{ view_id: string; config: unknown }>) {
    map.set(String(row.view_id), normalizeStoredOverlay(row.config))
  }
  return map
}

/** Read the actor's own personal override for a single view (or null if none exists). */
export async function getPersonalViewConfig(
  query: QueryFn,
  viewId: string,
  actorUserId: string,
): Promise<PersonalViewConfigRecord | null> {
  if (!viewId || !actorUserId) return null
  const result = await query(
    'SELECT view_id, user_id, config, updated_at FROM meta_view_personal_configs WHERE view_id = $1',
    [viewId],
  )
  const row = (result.rows as Array<{ view_id: string; user_id: string; config: unknown; updated_at: unknown }>)[0]
  if (!row) return null
  return {
    viewId: String(row.view_id),
    userId: String(row.user_id),
    config: normalizeStoredOverlay(row.config),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  }
}

/**
 * Upsert the actor's own personal override. `viewId` and `actorUserId` MUST both come from the
 * route (viewId from the URL param / a validated existing view row, actorUserId from
 * `resolveRequestAccess(req).userId`) — this function has no way to write any other user's row
 * because the SQL keys the write on `(view_id, user_id)` = `(viewId, actorUserId)` exactly; there
 * is no code path here that accepts a target user id from the overlay payload.
 */
export async function upsertPersonalViewConfig(
  query: QueryFn,
  viewId: string,
  actorUserId: string,
  overlay: PersonalViewConfigOverlay,
): Promise<PersonalViewConfigRecord> {
  const sanitized = sanitizePersonalOverlayConfig(overlay)
  const result = await query(
    `INSERT INTO meta_view_personal_configs (view_id, user_id, config, updated_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (view_id, user_id)
     DO UPDATE SET config = $3::jsonb, updated_at = now()
     RETURNING view_id, user_id, config, updated_at`,
    [viewId, actorUserId, JSON.stringify(sanitized)],
  )
  const row = (result.rows as Array<{ view_id: string; user_id: string; config: unknown; updated_at: unknown }>)[0]
  return {
    viewId: String(row.view_id),
    userId: String(row.user_id),
    config: normalizeStoredOverlay(row.config),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  }
}

/** Delete the actor's own personal override (no-op if none exists). Returns whether a row was deleted. */
export async function deletePersonalViewConfig(
  query: QueryFn,
  viewId: string,
  actorUserId: string,
): Promise<boolean> {
  if (!viewId || !actorUserId) return false
  const result = await query(
    'DELETE FROM meta_view_personal_configs WHERE view_id = $1 AND user_id = $2',
    [viewId, actorUserId],
  )
  return (result.rowCount ?? 0) > 0
}
