/**
 * LEGACY spreadsheet-permissions routes — sheet AUTHORITY + sheet LIVENESS (#5829).
 *
 * `:id` here is a `meta_sheets` id, not a legacy spreadsheet id. The LIVE schema builder is the kysely
 * migration src/db/migrations/zzzz20260405190000_create_spreadsheet_permissions.ts:7
 * (`sheet_id text NOT NULL REFERENCES meta_sheets(id) ON DELETE CASCADE`). The raw-SQL twin
 * migrations/036_create_spreadsheet_permissions.sql:4 declares the same table `REFERENCES
 * spreadsheets(id)`, but `036_create_spreadsheet_permissions` is a NO-OP HISTORY MARKER — it is listed
 * in SUPERSEDED_LEGACY_SQL_MIGRATIONS (src/db/migration-provider.ts:78), as is the migration that would
 * have created its FK target (`034_create_spreadsheets`, line 76).
 *
 * Scoped, not absolute: that hold-down arrived in 36ee32502 (2026-05-12) and is still re-enterable with
 * `MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL='true'` (migration-provider.ts:266). Every database the
 * CURRENT provider builds therefore carries the `meta_sheets(id)` shape. The residual class is named
 * rather than declared empty: a database this repo migrated BEFORE that commit ran 036 first — the
 * provider merges the kysely and SQL streams into ONE name-keyed record, so '036…' precedes 'zzzz…' —
 * and carries `REFERENCES spreadsheets(id)`. On such a database multitable's OWN per-sheet grant
 * writes would already violate that FK; these routes answer such an `:id` as "no live sheet" instead
 * of claiming the case impossible.
 *
 * `spreadsheet_permissions` is exactly the table multitable reads as PER-SHEET grants
 * (multitable/permission-service.ts loadSheetPermissionScopeMap). That makes these three routes a
 * second, unguarded door onto the multitable sheet-grant table: they carried only
 * `rbacGuard('spreadsheet-permissions', …)`, a GLOBAL code, so any holder of it could list / grant /
 * revoke sheet-level grants on ANY sheet — including a soft-deleted one — without the per-sheet
 * `canManageSheetAccess` the forward routes require.
 *
 * Each handler now runs the same capability/liveness PAIR the forward routes run — routes/univer-meta
 * .ts:8886-8888 (`GET /sheets/:sheetId/permissions`) and :9155-9157 (`PUT /sheets/:sheetId/permissions/
 * :subjectType/:subjectId`): `resolveSheetCapabilities` → 403 on `!canManageSheetAccess` → 404 on
 * `sheetLiveness !== 'live'`.
 *
 * As of #5924 (0714f0a3f) the forward routes no longer run a PRE-GATE existence check before
 * authority: that commit deleted the `loadSheetRow`-before-`resolveSheetCapabilities` step from all
 * eleven univer-meta.ts table-config routes, these two included. Both doors now run the SAME
 * capability/liveness pair in the SAME order — this file is neither stricter than nor divergent from
 * the forward routes on that axis. The two differences that remain are narrower and unrelated to
 * authority ordering: (1) the forward GET route trims `sheetId` and answers `400 VALIDATION_ERROR` on
 * an empty result (univer-meta.ts:8879-8882), where this file passes `sheetId` through unnormalised
 * (see below); (2) the forward PUT route, AFTER the pair, additionally checks that the addressed
 * subject (a `users` / `roles` / `platform_member_groups` row) exists and answers `404 NOT_FOUND`
 * echoing the subject id (univer-meta.ts:9163-9187) — a subject-existence oracle visible only to an
 * already-authorised, live-sheet caller, and out of scope for this file (#5829).
 *
 * ── The gate is not the whole liveness story (#5938) ──────────────────────────
 * It reads liveness on the POOL, BEFORE the write transaction exists, and a soft delete is a plain
 * UPDATE in its own transaction. If that delete commits between the gate's read and the write
 * transaction's `meta_sheets … FOR UPDATE`, the lock is already FREE: the write neither waits for it nor
 * sees the pre-delete row version, and the grant/revoke lands on a dead sheet. So grant and revoke each
 * take that lock through `assertSheetLiveForUpdate` — ONE statement that locks the row AND re-reads
 * `deleted_at` — and refuse, rolling the transaction back before any write, with the SAME values-free
 * 404 the gate answers. Both doors are fixed together: the forward lock sites (univer-meta.ts PUT
 * sheet/view/field permissions and the permission-revert execute branch) carry the identical call.
 * Keeping BOTH the gate and the re-check is deliberate — the gate is what answers 403 before 404, so an
 * unauthorised caller still cannot read sheet state out of the ordering.
 */
import type { Request, Response} from 'express';
import { Router } from 'express'
import { rbacGuard } from '../rbac/rbac'
import { auditLog } from '../audit/audit'
import { pool, query as dbQuery, transaction } from '../db/pg'
import { sendIfRecoveryConflict } from '../db/recovery-conflict'
import { resolveSheetCapabilities } from '../multitable/permission-service'
import { SheetNotLiveError, assertSheetLiveForUpdate } from '../multitable/sheet-liveness'
import { sendForbidden, sendSheetNotLive } from '../multitable/sheet-refusals'

// Use the global Express.Request type which already includes user property
type AuthenticatedRequest = Request

// Database row type for permission query results
interface PermissionRow {
  perm_code: string;
  [key: string]: unknown;
}

// 简易内存：sheetId -> userId -> perms
const sheetPerms = new Map<string, Map<string, Set<string>>>()

/**
 * AUTHORITY then LIVENESS on the addressed sheet. Returns true when the handler may proceed; when it
 * returns false it has ALREADY answered, and the caller must return without touching the table.
 *
 * The refusal bodies come from the shared multitable module (multitable/sheet-refusals.ts) rather than
 * being hand-copied here: that module exists because copies drift (see its header), and this file
 * writes the same rows the forward routes write. What that buys is exactly ONE definition of the 403 /
 * SHEET_DELETED / NOT_FOUND bodies — not evidence of a wider divergence: since #5924 (0714f0a3f) the
 * forward GET/PUT permission routes run the identical capability/liveness pair in the identical order
 * (see the file header), so this file does not answer any 404 the forward routes wouldn't already
 * answer at the same point. Both helpers remain values-free — neither takes a sheet id, so neither CAN
 * echo one back as an existence oracle, unlike the forward PUT route's post-pair subject lookup
 * (univer-meta.ts:9163-9187).
 *
 * `sheetId` is passed through UNNORMALISED, exactly as the list/grant/revoke SQL below binds it: a gate
 * that trimmed while the write did not would authorise one row key and write another.
 */
async function answerUnlessSheetManageable(req: Request, res: Response, sheetId: string): Promise<boolean> {
  const { capabilities, sheetLiveness } = await resolveSheetCapabilities(req, dbQuery, sheetId)
  if (!capabilities.canManageSheetAccess) {
    sendForbidden(res)
    return false
  }
  if (sheetLiveness !== 'live') {
    sendSheetNotLive(res, sheetLiveness)
    return false
  }
  return true
}

/**
 * FAIL-CLOSED wrapper. A capability/liveness lookup that throws (pool absent, DB unreachable, a
 * degraded RBAC read) must never fall through to the grant table — and it answers the SAME 403 a
 * denial answers, so the failure mode cannot be used to tell "the gate broke" apart from "you may
 * not", which would hand back the existence signal the order of the checks exists to withhold.
 */
async function mayManageSheetAccess(req: Request, res: Response, sheetId: string): Promise<boolean> {
  try {
    return await answerUnlessSheetManageable(req, res, sheetId)
  } catch {
    sendForbidden(res)
    return false
  }
}

export function spreadsheetPermissionsRouter(): Router {
  const r = Router()

  r.get('/api/spreadsheets/:id/permissions', rbacGuard('spreadsheet-permissions', 'read'), async (req: Request, res: Response) => {
    // #5829: listing WHO holds a grant is an access-MANAGEMENT read, gated exactly as the forward
    // GET /sheets/:sheetId/permissions is — the global rbac code alone never bought it.
    if (!(await mayManageSheetAccess(req, res, req.params.id))) return
    if (pool) {
      const { rows } = await pool.query(
        `SELECT user_id, perm_code
         FROM spreadsheet_permissions
         WHERE sheet_id = $1
           AND subject_type = 'user'
           AND user_id IS NOT NULL`,
        [req.params.id],
      )
      const grouped: Record<string, Set<string>> = {}
      for (const r of rows) {
        grouped[r.user_id] = grouped[r.user_id] || new Set<string>()
        grouped[r.user_id].add(r.perm_code)
      }
      const items = Object.entries(grouped).map(([userId, set]) => ({ userId, permissions: Array.from(set) }))
      return res.json({ ok: true, data: { items } })
    }
    const map = sheetPerms.get(req.params.id) || new Map<string, Set<string>>()
    const items = Array.from(map.entries()).map(([userId, set]) => ({ userId, permissions: Array.from(set) }))
    return res.json({ ok: true, data: { items } })
  })

  r.post('/api/spreadsheets/:id/permissions/grant', rbacGuard('spreadsheet-permissions', 'write'), async (req: AuthenticatedRequest, res: Response) => {
    // #5829: BEFORE the body validation, so a caller without sheet authority gets the identical 403 on
    // a live, a soft-deleted and an absent sheet — and cannot read the sheet's state out of a 400/404.
    if (!(await mayManageSheetAccess(req, res, req.params.id))) return
    const userId = req.body?.userId
    const perm = req.body?.permission
    if (!userId || !perm) return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'userId and permission required' } })
    if (pool) {
      // Never-escalate-under-concurrency (#3389 / #3402 follow-up): take the SAME meta_sheets row lock the
      // permission-revert execute path (and the multitable forward grant/revoke routes, #3402) hold, so this legacy
      // grant write serializes against a concurrent revert under ONE lock model. A grant INSERT already blocks on the
      // revert via the FK's implicit FOR KEY SHARE on meta_sheets vs the revert's FOR UPDATE; the explicit lock makes
      // the legacy route UNIFORM with #3402 rather than relying on that implicit FK lock (it does not close a new hole).
      //
      // #5938: the lock statement ALSO re-reads `deleted_at`, in the same statement, and refuses unless the sheet is
      // still live. The pre-transaction gate above reads liveness on the POOL, before this transaction exists; a soft
      // delete that commits in between leaves the row lock FREE, so this transaction takes it without waiting and
      // without seeing the pre-delete row version — and wrote the grant onto a dead sheet. The throw rolls the
      // transaction back before the INSERT, and the catch answers the SAME values-free 404 the gate would have.
      try {
        await transaction(async ({ query }) => {
          await assertSheetLiveForUpdate(query, req.params.id)
          await query(
            `INSERT INTO spreadsheet_permissions(sheet_id, user_id, subject_type, subject_id, perm_code)
             VALUES ($1, $2, 'user', $2, $3)
             ON CONFLICT DO NOTHING`,
            [req.params.id, userId, perm],
          )
        })
      } catch (error) {
        // O2-S2: spreadsheet_permissions is a recovery-authority table — a marker 40001
        // under a held recovery lease is a retryable 409. Every other error rethrows
        // unchanged (the handler had no catch before, so that path is byte-identical).
        if (sendIfRecoveryConflict(res, error)) return
        // #5938: the sheet died between the gate's read and this transaction's lock. Same body the gate
        // answers (sendSheetNotLive), so the window cannot be told apart from a plain deleted sheet.
        if (error instanceof SheetNotLiveError) return void sendSheetNotLive(res, error.liveness)
        throw error
      }
    } else {
      const map = sheetPerms.get(req.params.id) || new Map<string, Set<string>>()
      const set = map.get(userId) || new Set<string>()
      set.add(perm)
      map.set(userId, set)
      sheetPerms.set(req.params.id, map)
    }
    await auditLog({ actorId: req.user?.id != null ? String(req.user.id) : undefined, actorType: 'user', action: 'grant', resourceType: 'spreadsheet-permission', resourceId: `${req.params.id}:${userId}:${perm}` })
    if (pool) {
      const { rows } = await pool.query<PermissionRow>(
        `SELECT perm_code
         FROM spreadsheet_permissions
         WHERE sheet_id = $1
           AND subject_type = 'user'
           AND user_id = $2`,
        [req.params.id, userId],
      )
      return res.json({ ok: true, data: { userId, permissions: rows.map((r: PermissionRow) => r.perm_code) } })
    } else {
      const set = (sheetPerms.get(req.params.id) as Map<string, Set<string>>).get(userId) as Set<string>
      return res.json({ ok: true, data: { userId, permissions: Array.from(set) } })
    }
  })

  r.post('/api/spreadsheets/:id/permissions/revoke', rbacGuard('spreadsheet-permissions', 'write'), async (req: AuthenticatedRequest, res: Response) => {
    // #5829: same gate as grant. A revoke on a soft-deleted sheet is destructive in the direction the
    // restore flow cares about — it silently narrows what a restore brings back.
    if (!(await mayManageSheetAccess(req, res, req.params.id))) return
    const userId = req.body?.userId
    const perm = req.body?.permission
    if (!userId || !perm) return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'userId and permission required' } })
    if (pool) {
      // Never-escalate-under-concurrency (#3389 / #3402 follow-up): the legacy revoke is the GENUINE residual
      // un-serialized writer #3402 deferred — a child-row DELETE takes NO lock on the parent meta_sheets row, so
      // (unlike a grant INSERT) it is NOT FK-serialized against a concurrent permission-revert and could interleave
      // the revert's live-grant re-check and its apply. Take the SAME meta_sheets FOR UPDATE the revert holds so it
      // cannot. (#3402-style: lock the sheet row first, then write.)
      //
      // #5938: that lock now re-reads `deleted_at` in the same statement and refuses unless the sheet is still live —
      // see the grant branch above. A revoke is the direction that matters most here: a DELETE landing on a sheet that
      // was soft-deleted after the gate read silently narrows what a restore would bring back.
      try {
        await transaction(async ({ query }) => {
          await assertSheetLiveForUpdate(query, req.params.id)
          await query(
            `DELETE FROM spreadsheet_permissions
             WHERE sheet_id = $1
               AND subject_type = 'user'
               AND user_id = $2
               AND perm_code = $3`,
            [req.params.id, userId, perm],
          )
        })
      } catch (error) {
        // O2-S2: marker 40001 → retryable 409 (see grant); all else rethrows unchanged.
        if (sendIfRecoveryConflict(res, error)) return
        // #5938: sheet died inside the TOCTOU window — same values-free 404 as the gate (see grant).
        if (error instanceof SheetNotLiveError) return void sendSheetNotLive(res, error.liveness)
        throw error
      }
    } else {
      const map = sheetPerms.get(req.params.id) || new Map<string, Set<string>>()
      const set = map.get(userId) || new Set<string>()
      set.delete(perm)
      map.set(userId, set)
      sheetPerms.set(req.params.id, map)
    }
    await auditLog({ actorId: req.user?.id != null ? String(req.user.id) : undefined, actorType: 'user', action: 'revoke', resourceType: 'spreadsheet-permission', resourceId: `${req.params.id}:${userId}:${perm}` })
    if (pool) {
      const { rows } = await pool.query<PermissionRow>(
        `SELECT perm_code
         FROM spreadsheet_permissions
         WHERE sheet_id = $1
           AND subject_type = 'user'
           AND user_id = $2`,
        [req.params.id, userId],
      )
      return res.json({ ok: true, data: { userId, permissions: rows.map((r: PermissionRow) => r.perm_code) } })
    } else {
      const set = (sheetPerms.get(req.params.id) as Map<string, Set<string>>).get(userId) as Set<string>
      return res.json({ ok: true, data: { userId, permissions: Array.from(set) } })
    }
  })

  return r
}
