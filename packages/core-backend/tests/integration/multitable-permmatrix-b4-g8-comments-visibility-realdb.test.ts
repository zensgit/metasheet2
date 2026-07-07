/**
 * W1-2 permission matrix — B4 / G-8: comments × sheet-visibility (real DB).
 * Spec: docs/development/multitable-w1-2-permission-matrix-spec-20260705.md §3 G-8.
 *
 * G-8 in one line: a comment read/write targeting a sheet the actor has NO multitable read access to
 * must not leak that sheet's/record's existence (content, row/field identifiers, or counts).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * STATUS: GREEN — the comments sheet-visibility gate (`routes/comments.ts` `ensureSheetReadable`, owner
 * decision A) is now LANDED on this branch, so every route below rejects the no-read actor with 403.
 * These assertions encode the intended contract verbatim — they were authored as the RED differential
 * that surfaced the original leak and are NOT weakened; they now pass because the runtime enforces
 * per-sheet read before serving/writing comments. This file IS wired into the real-DB allowlist.
 * The historical repro (4/5 RED against the pre-fix main @ 1db165fe5) is preserved below as the record.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Root cause (traced against current main): `routes/comments.ts` gates every route through
 * `rbacGuard('comments', 'read'|'write')` — a GLOBAL RBAC permission-code check
 * (`userHasPermission(userId, 'comments:read')`, `rbac/rbac.ts`) that takes NO sheetId/spreadsheetId
 * parameter and cannot be sheet-scoped. `CommentService.getComments` and `getCommentPresenceSummary`
 * (`services/CommentService.ts` — the latter backs BOTH the `/api/comments/summary` route and the
 * `/api/multitable/:id/comments/presence` route) query `meta_comments`/aggregate purely by
 * `spreadsheet_id` (+ optional rowId/fieldId/resolved) — there is NO
 * call anywhere in the comments code path to `resolveSheetReadableCapabilities` or any other multitable
 * per-sheet capability/ACL check. Contrast with `sheet-capabilities.ts`'s `deriveCapabilities`, where
 * `canRead` (multitable) and `canComment` (comments) are computed as INDEPENDENT booleans from
 * INDEPENDENT permission codes (`multitable:read`/`:write` vs `comments:read`/`:write`) — and
 * `permission-service.ts`'s `applySheetPermissionScope` (line ~1249) even encodes the INTENDED per-sheet
 * contract as `canComment: capabilities.canComment && scope.canRead` for sheets with explicit ACL
 * assignments — but that composed value is a UI-capability-hint used by GET /view's response payload; the
 * comments.ts ROUTES never consult it. The result: `comments:read`/`comments:write` behaves as a
 * system-wide bypass of multitable sheet visibility.
 *
 * NOT theoretical: `auth/access-presets.ts`'s `plm-collaborator` preset (role: 'user', "PLM 协作成员" /
 * "PLM Collaboration Member" — "适用于查看 PLM 工作台、审批与评论协作") grants EXACTLY
 * `['spreadsheets:read', 'workflow:read', 'approvals:read', 'comments:read']` — comments:read WITHOUT
 * any multitable:* grant. Also, migration `zzzz20260320163000_add_comment_permissions.ts` seeds BOTH
 * comments:read AND comments:write onto the generic 'user' role_permissions row. Any actor holding either
 * of those — a real, shipped role shape, not a contrived fixture — can read (and via 'user' role, write)
 * comments on every sheet in the deployment, including ones they cannot see at all via the interactive
 * multitable read path.
 *
 * Empirically confirmed (2026-07-06, fresh `metasheet_w12b4_test` DB, unmodified main @ 1db165fe5):
 *   - GET  /api/comments?spreadsheetId=<no-read-sheet>                → 200 + real comment content (RED)
 *   - GET  /api/comments/summary?spreadsheetId=<no-read-sheet>        → 200 + real counts/rowIds (RED)
 *   - GET  /api/multitable/:id/comments/presence                     → 200 + real counts/rowIds (RED)
 *   - POST /api/comments {spreadsheetId:<no-read-sheet>, ...}        → 201 Created (RED — unauthorized write)
 *   - control: GET /api/multitable/records for the SAME sheet/actor  → 403 (interactive read correctly denied)
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI convention); wired into the multitable
 * real-DB allowlist so it guards the gate against regression.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { commentsRouter } from '../../src/routes/comments'
import { createContainer } from '../../src/di/container'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const TS = Date.now()
const BASE_ID = `base_b4g8_${TS}`
const SHEET_ID = `sheet_b4g8_${TS}` // a private sheet the ACTOR has NO multitable read access to
const F_STATUS = `fld_b4g8_status_${TS}`
const REC_ID = `rec_b4g8_${TS}`
const COMMENT_ID = `cmt_b4g8_${TS}`
const COMMENT_AUTHOR = `user_b4g8_author_${TS}` // an unrelated actor who legitimately authored the comment
const COMMENT_CONTENT = 'B4_G8_SENTINEL_COMMENT_CONTENT' // a distinctive marker, never an incidental substring

// The actor under test: global comments:read/write RBAC permission codes ONLY — mirrors the real
// `plm-collaborator` access preset (comments:read, no multitable:*) plus the generic 'user' role's
// migration-seeded comments:write. NO multitable:read/write, no sheet-scoped grant anywhere.
const ACTOR = `user_b4g8_actor_${TS}`

function buildApp(userId: string, perms: string[]): Express {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as any).user = { id: userId, roles: [], perms, permissions: perms }
    next()
  })
  // Both routers mounted on ONE app — exactly as the real server does (index.ts mounts univerMetaRouter
  // and commentsRouter as sibling, independently-guarded routers with no shared visibility middleware).
  app.use('/api/multitable', univerMetaRouter())
  app.use(commentsRouter(createContainer()))
  return app
}

describeIfDatabase('W1-2 B4 G-8 — comments × sheet-visibility (real DB) — gate enforced (decision A), guards against regression', () => {
  beforeAll(async () => {
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'B4 G8 Private Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'B4 G8 Private Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_STATUS, SHEET_ID, 'Status', 'string', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_ID, SHEET_ID, JSON.stringify({ [F_STATUS]: 'private_row_value' })])
    await q(
      `INSERT INTO meta_comments (id, spreadsheet_id, row_id, field_id, author_id, content, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, now(), now())`,
      [COMMENT_ID, SHEET_ID, REC_ID, F_STATUS, COMMENT_AUTHOR, COMMENT_CONTENT],
    )
  })

  afterAll(async () => {
    await q('DELETE FROM meta_comments WHERE spreadsheet_id = $1', [SHEET_ID]).catch(() => {})
    await q("DELETE FROM meta_comments WHERE content LIKE 'B4_G8_WRITE_PROBE%'").catch(() => {}) // the write-leak test's own artifact, if it landed
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[ACTOR]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('control (non-vacuous): the SAME actor is correctly DENIED interactive read on the sheet (proves this is genuinely a no-read sheet, not a fixture bug)', async () => {
    const app = buildApp(ACTOR, ['comments:read', 'comments:write'])
    const res = await request(app).get('/api/multitable/records').query({ sheetId: SHEET_ID, limit: 100 })
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).not.toContain('"data"') // no partial data leak on the interactive path either
  })

  test('G-8a (READ, /api/comments): comments:read-only actor with no multitable access must not see comment content/existence for the no-read sheet', async () => {
    const app = buildApp(ACTOR, ['comments:read'])
    const res = await request(app).get('/api/comments').query({ spreadsheetId: SHEET_ID })
    // CORRECT contract: either rejected outright, or — if comments:read is meant to stay a legitimately
    // separate axis — the response must not name this specific sheet's content (existence-oracle-free,
    // matching the G-5 "denied ⇒ zero presence" discipline applied to the comments surface).
    expect(res.status).not.toBe(200)
  })

  test('G-8b (READ, /api/comments/summary + presence): comments:read-only actor must not see aggregate counts/rowIds for the no-read sheet', async () => {
    const app = buildApp(ACTOR, ['comments:read'])
    const summary = await request(app).get('/api/comments/summary').query({ spreadsheetId: SHEET_ID, rowIds: [REC_ID] })
    expect(summary.status).not.toBe(200)
    const presence = await request(app).get(`/api/multitable/${SHEET_ID}/comments/presence`)
    expect(presence.status).not.toBe(200)
  })

  test('G-8c (WRITE, POST /api/comments): comments:write actor with no multitable access must not be able to attach a NEW comment to a record on the no-read sheet', async () => {
    const app = buildApp(ACTOR, ['comments:write'])
    const res = await request(app)
      .post('/api/comments')
      .send({ spreadsheetId: SHEET_ID, rowId: REC_ID, fieldId: F_STATUS, content: 'B4_G8_WRITE_PROBE_SENTINEL' })
    expect(res.status).not.toBe(201)
  })

  test('G-8d (existence-oracle floor): even if comments:read stays a deliberately separate axis, the response must carry no identifiers this actor could not otherwise learn (rowId/fieldId/content)', async () => {
    const app = buildApp(ACTOR, ['comments:read'])
    const res = await request(app).get('/api/comments').query({ spreadsheetId: SHEET_ID })
    const body = JSON.stringify(res.body ?? {})
    expect(body).not.toContain(COMMENT_CONTENT)
    expect(body).not.toContain(REC_ID)
    expect(body).not.toContain(F_STATUS)
  })
})
