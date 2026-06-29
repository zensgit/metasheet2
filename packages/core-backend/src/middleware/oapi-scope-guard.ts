/**
 * OAPI-4a — per-base/sheet scoped-token guard (design-lock
 * `docs/development/multitable-oapi4-scoped-tokens-designlock-20260629.md`, RATIFIED).
 *
 * One shared guard, mounted on every token-accepting records route (read AND write), AFTER `apiTokenAuth`
 * (and, on writes, AFTER `apiTokenWriteRateLimit` so out-of-scope attempts are themselves rate-limited) and
 * BEFORE the handler. It resolves the request's target sheet(s) → base server-side and rejects a scoped token
 * whose whitelist does not cover them.
 *
 * Invariants:
 *  - STRICT NO-OP for session/JWT requests (no `req.apiTokenId`) — ordinary edits/reads are byte-for-byte unchanged.
 *  - NO-OP (allow) for an UNSCOPED token (both whitelists empty) — legacy creator-wide back-compat.
 *  - §3 AND-composition; **every** touched target must be in-scope (fail-closed on cross-/multi-target).
 *  - The target base is resolved from the sheet→base map server-side — never a client-supplied baseId.
 *  - For a record-addressed route (`:recordId`), the authoritative sheet is the RECORD'S sheet (a body
 *    `sheetId` is NOT trusted), so a token cannot mis-declare a record into an in-scope sheet.
 *  - NO-ORACLE: an unresolvable target (missing record / no sheet id / unknown sheet) and an out-of-scope
 *    target both return the SAME uniform 403 `OUT_OF_SCOPE` — a scoped token cannot probe existence.
 */
import type { Request, Response, NextFunction } from 'express'
import { poolManager } from '../integration/db/connection-pool'

/** Uniform out-of-scope rejection — identical body for not-found and out-of-scope (no existence oracle). */
function denyOutOfScope(req: Request, res: Response): void {
  // Scrubbed reason for the write-audit boundary (reads carry no audit). MUST be set before the response
  // is sent, so the `res.on('finish')` listener observes it.
  req.oapiAuditReason = 'out_of_base_sheet_scope'
  res.status(403).json({
    ok: false,
    error: { code: 'OUT_OF_SCOPE', message: 'API token is not scoped to the requested base/sheet' },
  })
}

/**
 * Resolve the FULL set of target sheet ids this request touches, server-side.
 * Returns `[]` when the target cannot be resolved (→ the caller fails closed with a uniform 403).
 */
async function resolveTargetSheetIds(req: Request): Promise<string[]> {
  const pool = poolManager.get()
  const params = (req.params ?? {}) as Record<string, unknown>
  const body = (req.body ?? {}) as Record<string, unknown>
  const query = (req.query ?? {}) as Record<string, unknown>

  // Record-addressed routes (PATCH / DELETE / GET /records/:recordId): the authoritative sheet is the
  // record's own sheet — do NOT trust a body/query sheetId here. (Soft-delete moves rows OUT of meta_records
  // into a trash table — there is no `deleted_at` column — so a deleted/absent record simply resolves to no
  // sheet → [] → uniform 403, preserving the no-oracle property.)
  const recordId = typeof params.recordId === 'string' ? params.recordId : null
  if (recordId) {
    const r = await pool.query('SELECT sheet_id FROM meta_records WHERE id = $1', [recordId])
    const row = (r.rows as Array<{ sheet_id?: unknown }>)[0]
    const sid = row && typeof row.sheet_id === 'string' ? row.sheet_id : null
    return sid ? [sid] : []
  }

  // Direct sheet id: path param (`/sheets/:sheetId/...`), else body, else query.
  const directSheetId =
    (typeof params.sheetId === 'string' && params.sheetId) ||
    (typeof body.sheetId === 'string' && body.sheetId) ||
    (typeof query.sheetId === 'string' && query.sheetId) ||
    null
  if (directSheetId) return [directSheetId]

  // View id → its sheet.
  const viewId =
    (typeof body.viewId === 'string' && body.viewId) ||
    (typeof query.viewId === 'string' && query.viewId) ||
    null
  if (viewId) {
    const r = await pool.query('SELECT sheet_id FROM meta_views WHERE id = $1', [viewId])
    const row = (r.rows as Array<{ sheet_id?: unknown }>)[0]
    const sid = row && typeof row.sheet_id === 'string' ? row.sheet_id : null
    return sid ? [sid] : []
  }

  return []
}

export async function oapiScopeGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  // No-op for session/JWT requests.
  if (!req.apiTokenId) {
    next()
    return
  }

  const baseIds = req.apiTokenBaseIds
  const sheetIds = req.apiTokenSheetIds
  const baseScoped = Array.isArray(baseIds) && baseIds.length > 0
  const sheetScoped = Array.isArray(sheetIds) && sheetIds.length > 0

  // Unscoped token → legacy creator-wide → allow (the capability scope + creator RBAC still apply downstream).
  if (!baseScoped && !sheetScoped) {
    next()
    return
  }

  try {
    const targetSheetIds = await resolveTargetSheetIds(req)
    if (targetSheetIds.length === 0) {
      // Unresolvable target — fail closed, uniform with out-of-scope (no oracle).
      denyOutOfScope(req, res)
      return
    }

    const pool = poolManager.get()
    const baseRes = await pool.query(
      'SELECT id, base_id FROM meta_sheets WHERE id = ANY($1::text[])',
      [targetSheetIds],
    )
    const baseBySheet = new Map<string, string | null>()
    for (const row of baseRes.rows as Array<{ id: unknown; base_id: unknown }>) {
      baseBySheet.set(String(row.id), typeof row.base_id === 'string' ? row.base_id : null)
    }

    // EVERY touched sheet must resolve AND satisfy the §3 AND-composition (fail-closed).
    for (const sid of targetSheetIds) {
      if (!baseBySheet.has(sid)) {
        // Target sheet does not exist (or is unreadable at the catalog) — uniform deny.
        denyOutOfScope(req, res)
        return
      }
      const baseId = baseBySheet.get(sid) ?? null
      const baseOk = !baseScoped || (baseId !== null && (baseIds as string[]).includes(baseId))
      const sheetOk = !sheetScoped || (sheetIds as string[]).includes(sid)
      if (!baseOk || !sheetOk) {
        denyOutOfScope(req, res)
        return
      }
    }

    next()
  } catch {
    // Any resolution error → fail closed with the SAME uniform 403 (never a 500 that leaks, never an allow).
    denyOutOfScope(req, res)
  }
}
