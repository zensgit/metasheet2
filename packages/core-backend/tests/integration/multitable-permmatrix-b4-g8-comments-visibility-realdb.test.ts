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

describeIfDatabase('F1 — comments respect row-level read deny (real DB)', () => {
  const ts = Date.now()
  const baseId = `base_f1_comments_${ts}`
  const sheetId = `sheet_f1_comments_${ts}`
  const fieldId = `fld_f1_status_${ts}`
  const visibleRecordId = `rec_f1_visible_${ts}`
  const deniedRecordId = `rec_f1_denied_${ts}`
  const visibleCommentId = `cmt_f1_visible_${ts}`
  const deniedCommentId = `cmt_f1_denied_${ts}`
  const actor = `user_f1_actor_${ts}`
  const author = `user_f1_author_${ts}`
  const visibleContent = 'F1_VISIBLE_COMMENT_CONTENT'
  const deniedContent = 'F1_DENIED_COMMENT_CONTENT'

  beforeAll(async () => {
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x'), ($2,'x') ON CONFLICT (id) DO NOTHING", [actor, author])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [baseId, 'F1 Comments Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name, row_level_read_permissions_enabled) VALUES ($1,$2,$3,TRUE)', [sheetId, baseId, 'F1 Comments Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [fieldId, sheetId, 'Status', 'string', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1), ($4,$2,$5::jsonb,1)', [
      visibleRecordId,
      sheetId,
      JSON.stringify({ [fieldId]: 'visible' }),
      deniedRecordId,
      JSON.stringify({ [fieldId]: 'denied' }),
    ])
    await q(
      `INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level)
       VALUES ($1,$2,'user',$3,'none')`,
      [sheetId, deniedRecordId, actor],
    )
    await q(
      `INSERT INTO meta_comments (
         id, spreadsheet_id, row_id, field_id, container_id, target_id, target_field_id,
         author_id, content, mentions, created_at, updated_at
       )
       VALUES
         ($1,$3,$4,$6,$3,$4,$6,$7,$8,$10::jsonb, now(), now()),
         ($2,$3,$5,$6,$3,$5,$6,$7,$9,$10::jsonb, now(), now())`,
      [
        visibleCommentId,
        deniedCommentId,
        sheetId,
        visibleRecordId,
        deniedRecordId,
        fieldId,
        author,
        visibleContent,
        deniedContent,
        JSON.stringify([actor]),
      ],
    )
  })

  afterAll(async () => {
    await q('DELETE FROM meta_comment_reads WHERE comment_id = ANY($1::text[])', [[visibleCommentId, deniedCommentId]]).catch(() => {})
    await q('DELETE FROM meta_comments WHERE spreadsheet_id = $1', [sheetId]).catch(() => {})
    await q('DELETE FROM record_permissions WHERE sheet_id = $1', [sheetId]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheetId]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheetId]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [sheetId]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [baseId]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[actor, author]]).catch(() => {})
  })

  function actorApp(): Express {
    return buildApp(actor, ['multitable:read', 'comments:read', 'comments:write'])
  }

  test('list comments filters row-denied comment bodies and row identifiers', async () => {
    const res = await request(actorApp()).get('/api/comments').query({ spreadsheetId: sheetId })
    expect(res.status).toBe(200)
    const body = JSON.stringify(res.body)
    expect(body).toContain(visibleContent)
    expect(body).toContain(visibleRecordId)
    expect(body).not.toContain(deniedContent)
    expect(body).not.toContain(deniedRecordId)

    const deniedRow = await request(actorApp()).get('/api/comments').query({ spreadsheetId: sheetId, rowId: deniedRecordId })
    expect(deniedRow.status).toBe(200)
    expect(deniedRow.body.data.items).toEqual([])
    expect(deniedRow.body.data.total).toBe(0)
    expect(JSON.stringify(deniedRow.body)).not.toContain(deniedContent)
  })

  test('summary, presence, and mention-summary exclude row-denied vectors', async () => {
    const summary = await request(actorApp())
      .get('/api/comments/summary')
      .query({ spreadsheetId: sheetId, rowIds: [visibleRecordId, deniedRecordId] })
    expect(summary.status).toBe(200)
    expect(summary.body.data.items).toHaveLength(1)
    expect(summary.body.data.items[0].rowId).toBe(visibleRecordId)
    expect(JSON.stringify(summary.body)).not.toContain(deniedRecordId)

    const presence = await request(actorApp())
      .get(`/api/multitable/${sheetId}/comments/presence`)
      .query({ rowIds: [visibleRecordId, deniedRecordId] })
    expect(presence.status).toBe(200)
    expect(presence.body.data.items).toHaveLength(1)
    expect(presence.body.data.items[0].rowId).toBe(visibleRecordId)
    expect(JSON.stringify(presence.body)).not.toContain(deniedRecordId)

    const mentionSummary = await request(actorApp()).get('/api/comments/mention-summary').query({ spreadsheetId: sheetId })
    expect(mentionSummary.status).toBe(200)
    expect(mentionSummary.body.data.mentionedRecordCount).toBe(1)
    expect(mentionSummary.body.data.unresolvedMentionCount).toBe(1)
    expect(JSON.stringify(mentionSummary.body)).toContain(visibleRecordId)
    expect(JSON.stringify(mentionSummary.body)).not.toContain(deniedRecordId)
  })

  test('create on a row-denied record is rejected and does not insert a comment', async () => {
    const res = await request(actorApp())
      .post('/api/comments')
      .send({ spreadsheetId: sheetId, rowId: deniedRecordId, content: 'F1_DENIED_WRITE_SENTINEL' })
    expect(res.status).toBe(403)

    const inserted = await q(
      "SELECT count(*)::int AS c FROM meta_comments WHERE spreadsheet_id = $1 AND content = 'F1_DENIED_WRITE_SENTINEL'",
      [sheetId],
    )
    expect(Number((inserted.rows[0] as { c: number }).c)).toBe(0)
  })
})

/**
 * G-10 (docket #68, G-10 audit #4323) — comment inbox entity-name projection (real DB).
 *
 * `CommentService.getInbox` (`/api/comments/inbox`) now additively projects `baseName`/`sheetName`/
 * `viewName`/`fieldName` alongside the existing `baseId`/`sheetId`/`viewId`/`fieldId` (raw ids kept,
 * names are name-first display sugar). This suite verifies the ADDITIVE projection itself (names
 * correctly resolved alongside unchanged ids for a row this endpoint serves). The row selection of the
 * inbox (readable, live sheets only — #5831 part B) is pinned by the next suite; since that change the
 * viewer here needs read access to both sheets, so it gets a per-sheet read grant (a comments:read code
 * alone no longer shows comments on sheets the viewer cannot read).
 *
 * P3 follow-up (docket #71, off PR #4330's gate): the original golden above only pinned
 * baseName/sheetName/fieldName in real DB — `viewName` (the byte-twin of the already-tested `view_id`
 * correlated subquery) was mock-only (`comment-flow.test.ts` line ~732), and so was the
 * null/deleted-entity name path (a comment whose joined entity is absent must still return the row,
 * with the name null — `comment-flow.test.ts` line ~762). Both gaps are closed below:
 *   - P3-1: a real `meta_views` row on `sheetId` so `viewId`/`viewName` resolve non-null, asserted as a
 *     twin pair (same id the pre-existing `view_id` subquery already returns, plus its `name`).
 *   - P3-2a: a record-level comment (`field_id` NULL) on the SAME sheet — the `meta_fields` LEFT JOIN's
 *     null-key case — proves the row is not dropped and `fieldName` is explicit `null`.
 *   - P3-2b: a comment on a SECOND sheet that has NO `meta_views` row at all — the view correlated
 *     subquery's zero-row case — proves the row is not dropped and `viewId`/`viewName` are both `null`.
 */
describeIfDatabase('G-10 — comment inbox entity-name projection (real DB)', () => {
  const ts = Date.now()
  const baseId = `base_g10_inbox_${ts}`
  const sheetId = `sheet_g10_inbox_${ts}`
  const fieldId = `fld_g10_status_${ts}`
  const recordId = `rec_g10_inbox_${ts}`
  const viewerCommentId = `cmt_g10_viewer_${ts}` // unread, authored by someone else → appears in viewer's inbox
  const author = `user_g10_author_${ts}`
  const viewer = `user_g10_viewer_${ts}`
  const baseName = 'G10 Inbox Base'
  const sheetName = 'G10 Inbox Sheet'
  const fieldName = 'G10 Status Field'

  // P3-1 (docket #71): a real view on `sheetId` so viewId/viewName resolve non-null.
  const viewId = `view_g10_inbox_${ts}`
  const viewName = 'G10 Inbox View'

  // P3-2a (docket #71): a record-level comment (field_id NULL, not field-scoped) on the SAME sheet —
  // proves the meta_fields LEFT JOIN is null-safe (fieldName: null) and does not drop the row.
  const recordLevelCommentId = `cmt_g10_recordlevel_${ts}`

  // P3-2b (docket #71): a second sheet with NO meta_views row at all — proves the view correlated
  // scalar subquery is null-safe (viewId/viewName: null) and does not drop the row either.
  const noViewSheetId = `sheet_g10_inbox_noview_${ts}`
  const noViewFieldId = `fld_g10_noview_status_${ts}`
  const noViewRecordId = `rec_g10_inbox_noview_${ts}`
  const noViewCommentId = `cmt_g10_noview_${ts}`

  beforeAll(async () => {
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x'), ($2,'x') ON CONFLICT (id) DO NOTHING", [author, viewer])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [baseId, baseName])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [sheetId, baseId, sheetName])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [fieldId, sheetId, fieldName, 'string', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [recordId, sheetId, JSON.stringify({ [fieldId]: 'x' })])
    await q(
      `INSERT INTO meta_comments (id, spreadsheet_id, row_id, field_id, container_id, target_id, target_field_id, author_id, content, mentions, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$2,$3,$4,$5,$6,$7::jsonb, now(), now())`,
      [viewerCommentId, sheetId, recordId, fieldId, author, 'G10_INBOX_VIEWER_COMMENT', JSON.stringify([viewer])],
    )

    // P3-1: give the sheet exactly one view — the view_id/view_name subquery orders by
    // (created_at asc, id asc) limit 1, so a single view is unambiguously "the" resolved view.
    await q('INSERT INTO meta_views (id, sheet_id, name, type) VALUES ($1,$2,$3,$4)', [viewId, sheetId, viewName, 'grid'])

    // P3-2a: record-level comment — field_id/target_field_id both NULL (both columns are nullable;
    // only target_id/container_id are NOT NULL, and those are still populated).
    await q(
      `INSERT INTO meta_comments (id, spreadsheet_id, row_id, field_id, container_id, target_id, target_field_id, author_id, content, mentions, created_at, updated_at)
       VALUES ($1,$2,$3,NULL,$2,$3,NULL,$4,$5,$6::jsonb, now(), now())`,
      [recordLevelCommentId, sheetId, recordId, author, 'G10_INBOX_RECORD_LEVEL_COMMENT', JSON.stringify([viewer])],
    )

    // P3-2b: a wholly separate sheet, with a field-scoped comment, but zero meta_views rows.
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [noViewSheetId, baseId, 'G10 Inbox Sheet (no view)'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [noViewFieldId, noViewSheetId, 'NoView Status', 'string', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [noViewRecordId, noViewSheetId, JSON.stringify({ [noViewFieldId]: 'x' })])
    await q(
      `INSERT INTO meta_comments (id, spreadsheet_id, row_id, field_id, container_id, target_id, target_field_id, author_id, content, mentions, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$2,$3,$4,$5,$6,$7::jsonb, now(), now())`,
      [noViewCommentId, noViewSheetId, noViewRecordId, noViewFieldId, author, 'G10_INBOX_NOVIEW_COMMENT', JSON.stringify([viewer])],
    )

    // #5831 part B: the inbox lists only sheets the viewer may read — grant read on both sheets.
    for (const grantedSheetId of [sheetId, noViewSheetId]) {
      await q(
        `INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code) VALUES ($1,$2,'user',$2,'spreadsheet:read')`,
        [grantedSheetId, viewer],
      )
    }
  })

  afterAll(async () => {
    await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = ANY($1::text[])', [[sheetId, noViewSheetId]]).catch(() => {})
    await q('DELETE FROM meta_comment_reads WHERE comment_id = ANY($1::text[])', [[viewerCommentId, recordLevelCommentId, noViewCommentId]]).catch(() => {})
    await q('DELETE FROM meta_comments WHERE spreadsheet_id = $1', [sheetId]).catch(() => {})
    await q('DELETE FROM meta_comments WHERE spreadsheet_id = $1', [noViewSheetId]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [sheetId]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheetId]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [noViewSheetId]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheetId]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [noViewSheetId]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [sheetId]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [noViewSheetId]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [baseId]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[author, viewer]]).catch(() => {})
  })

  test('inbox item for a comment authored by someone else carries the projected base/sheet/view/field display names, ids unchanged (P3-1: viewName twin-consistent with viewId)', async () => {
    const app = buildApp(viewer, ['comments:read'])
    const res = await request(app).get('/api/comments/inbox')
    expect(res.status).toBe(200)
    const item = (res.body.data.items as Array<Record<string, unknown>>).find((i) => i.id === viewerCommentId)
    expect(item).toBeTruthy()
    // additive: existing id fields are untouched by the name projection (backward-compat contract)
    expect(item?.baseId).toBe(baseId)
    expect(item?.sheetId).toBe(sheetId)
    expect(item?.fieldId).toBe(fieldId)
    expect(item?.viewId).toBe(viewId)
    expect(item?.baseName).toBe(baseName)
    expect(item?.sheetName).toBe(sheetName)
    expect(item?.fieldName).toBe(fieldName)
    // P3-1 (docket #71): viewName is the byte-twin of the already-tested view_id correlated
    // subquery — same WHERE/ORDER BY, just the `name` column instead of `id`. Pin both together.
    expect(item?.viewName).toBe(viewName)
  })

  test('P3-2a (docket #71): a record-level comment (field_id NULL) still appears in the inbox, with fieldName null — meta_fields LEFT JOIN null-safety, not an INNER-join row drop', async () => {
    const app = buildApp(viewer, ['comments:read'])
    const res = await request(app).get('/api/comments/inbox')
    expect(res.status).toBe(200)
    const items = res.body.data.items as Array<Record<string, unknown>>
    const item = items.find((i) => i.id === recordLevelCommentId)
    expect(item).toBeTruthy() // row not dropped despite the null field_id join key
    expect(item?.fieldId).toBeUndefined() // falsy field_id serializes as absent (mapRowToComment's `|| undefined`)
    expect(item?.fieldName).toBeNull() // explicit null, not silently omitted
  })

  test('P3-2b (docket #71): a comment on a sheet with NO views still appears in the inbox, with viewId/viewName both null — the view correlated subquery is null-safe, not a row-dropping join', async () => {
    const app = buildApp(viewer, ['comments:read'])
    const res = await request(app).get('/api/comments/inbox')
    expect(res.status).toBe(200)
    const items = res.body.data.items as Array<Record<string, unknown>>
    const item = items.find((i) => i.id === noViewCommentId)
    expect(item).toBeTruthy() // row not dropped despite the sheet having zero meta_views rows
    expect(item?.viewId).toBeNull()
    expect(item?.viewName).toBeNull()
  })
})

/**
 * #5831 part B + #5840 — the cross-sheet comment aggregates and mark-all-read (real DB).
 *
 * The reader holds comments:read/write and NO global multitable code; it may read exactly the sheets it
 * is granted, so the inbox and the counts are exact even in a shared database:
 *   - A: granted, live — a1, a2 (mentions the reader), a3 unread; a4 mentions the reader and is read;
 *        `own` is the reader's own comment WITHOUT a read record (must never be listed);
 *   - B: live, NOT granted — b1 (mentions the reader), b2;
 *   - C: granted, soft-deleted — c1 (mentions the reader);
 *   - D: granted, live, row-level read deny on; d1 on a visible row, d2 (mentions the reader) on a row the
 *        reader is denied.
 * b1, d2 and `own` also pin the WHERE precedence: with the inbox predicate unwrapped, a mentioned comment
 * escaped every later filter and an unread one escaped the author filter.
 */
describeIfDatabase('#5831 part B — inbox and unread count list only readable, live, non-denied comments (real DB)', () => {
  const ts = Date.now()
  const baseId = `base_5831b_${ts}`
  const sheetA = `sheet_5831b_a_${ts}`
  const sheetB = `sheet_5831b_b_${ts}`
  const sheetC = `sheet_5831b_c_${ts}`
  const sheetD = `sheet_5831b_d_${ts}`
  const rowA = `rec_5831b_a_${ts}`
  const rowB = `rec_5831b_b_${ts}`
  const rowC = `rec_5831b_c_${ts}`
  const rowDVisible = `rec_5831b_dv_${ts}`
  const rowDDenied = `rec_5831b_dd_${ts}`
  const reader = `user_5831b_reader_${ts}`
  const author = `user_5831b_author_${ts}`
  const bystander = `user_5831b_bystander_${ts}`
  const id = (name: string) => `cmt_5831b_${name}_${ts}`
  const LISTED = ['a1', 'a2', 'a3', 'a4', 'd1'].map(id)
  const NOT_LISTED = ['own', 'b1', 'b2', 'c1', 'd2'].map(id)
  const ALL = [...LISTED, ...NOT_LISTED]
  const SHEETS = [sheetA, sheetB, sheetC, sheetD]
  const PERMS = ['comments:read', 'comments:write']

  async function comment(name: string, sheet: string, row: string, commentAuthor: string, mentions: string[], secondsAgo: number) {
    await q(
      `INSERT INTO meta_comments (id, spreadsheet_id, row_id, field_id, container_id, target_id, target_field_id, author_id, content, mentions, created_at, updated_at)
       VALUES ($1,$2,$3,NULL,$2,$3,NULL,$4,$5,$6::jsonb, now() - make_interval(secs => $7), now() - make_interval(secs => $7))`,
      [id(name), sheet, row, commentAuthor, `C5831B_${name.toUpperCase()}`, JSON.stringify(mentions), secondsAgo],
    )
  }

  beforeAll(async () => {
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x'), ($2,'x'), ($3,'x') ON CONFLICT (id) DO NOTHING", [reader, author, bystander])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [baseId, '5831B Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3), ($4,$2,$5)', [sheetA, baseId, '5831B A', sheetB, '5831B B'])
    await q('INSERT INTO meta_sheets (id, base_id, name, deleted_at) VALUES ($1,$2,$3, now())', [sheetC, baseId, '5831B C (deleted)'])
    await q('INSERT INTO meta_sheets (id, base_id, name, row_level_read_permissions_enabled) VALUES ($1,$2,$3,TRUE)', [sheetD, baseId, '5831B D (row deny)'])
    await q(
      `INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,'{}'::jsonb,1), ($3,$4,'{}'::jsonb,1), ($5,$6,'{}'::jsonb,1), ($7,$8,'{}'::jsonb,1), ($9,$8,'{}'::jsonb,1)`,
      [rowA, sheetA, rowB, sheetB, rowC, sheetC, rowDVisible, sheetD, rowDDenied],
    )
    for (const [grantSheet, grantUser] of [[sheetA, reader], [sheetC, reader], [sheetD, reader], [sheetA, bystander]] as const) {
      await q(
        `INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code) VALUES ($1,$2,'user',$2,'spreadsheet:read')`,
        [grantSheet, grantUser],
      )
    }
    await q(
      `INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1,$2,'user',$3,'none')`,
      [sheetD, rowDDenied, reader],
    )
    await comment('a1', sheetA, rowA, author, [], 100)
    await comment('a2', sheetA, rowA, author, [reader], 90)
    await comment('a3', sheetA, rowA, author, [], 80)
    await comment('a4', sheetA, rowA, author, [reader], 70)
    await comment('own', sheetA, rowA, reader, [], 60)
    await comment('b1', sheetB, rowB, author, [reader], 50)
    await comment('b2', sheetB, rowB, author, [], 40)
    await comment('c1', sheetC, rowC, author, [reader], 30)
    await comment('d1', sheetD, rowDVisible, author, [], 20)
    await comment('d2', sheetD, rowDDenied, author, [reader], 10)
    await q('INSERT INTO meta_comment_reads (comment_id, user_id) VALUES ($1,$2)', [id('a4'), reader])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_comment_reads WHERE comment_id = ANY($1::text[])', [ALL]).catch(() => {})
    await q('DELETE FROM meta_comments WHERE spreadsheet_id = ANY($1::text[])', [SHEETS]).catch(() => {})
    await q('DELETE FROM record_permissions WHERE sheet_id = ANY($1::text[])', [SHEETS]).catch(() => {})
    await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = ANY($1::text[])', [SHEETS]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [SHEETS]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [SHEETS]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [baseId]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[reader, author, bystander]]).catch(() => {})
  })

  const readerApp = () => buildApp(reader, PERMS)

  async function inbox(limit: number, offset: number) {
    const res = await request(readerApp()).get('/api/comments/inbox').query({ limit, offset })
    expect(res.status, res.text).toBe(200)
    return res.body.data as { items: Array<{ id: string; unread: boolean; mentioned: boolean }>; total: number }
  }

  test('lists exactly the readable, live, non-denied comments; total and pages agree (filtered before LIMIT/OFFSET)', async () => {
    const pages = [await inbox(2, 0), await inbox(2, 2), await inbox(2, 4), await inbox(2, 6)]
    expect(pages.map((p) => p.total)).toEqual([5, 5, 5, 5])
    expect(pages.map((p) => p.items.length)).toEqual([2, 2, 1, 0])
    // Newest first.
    expect(pages.flatMap((p) => p.items.map((i) => i.id))).toEqual([id('d1'), id('a4'), id('a3'), id('a2'), id('a1')])
    const body = JSON.stringify(await inbox(50, 0))
    for (const hidden of NOT_LISTED) expect(body, hidden).not.toContain(hidden)
    expect(body).not.toContain(rowDDenied)
  })

  test('unread-count counts the same scope: 4 unread, 1 mentioning the reader', async () => {
    const res = await request(readerApp()).get('/api/comments/unread-count')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ unreadCount: 4, mentionUnreadCount: 1, count: 4 })
  })

  test('comments the inbox leaves out are refused by the comment-id gate; nothing is written', async () => {
    const statuses: Record<string, number> = {}
    for (const name of ['b1', 'c1', 'd2']) {
      statuses[name] = (await request(readerApp()).post(`/api/comments/${id(name)}/read`)).status
    }
    expect(statuses).toEqual({ b1: 403, c1: 404, d2: 403 })
    const written = await q('SELECT comment_id FROM meta_comment_reads WHERE user_id = $1 AND comment_id = ANY($2::text[])', [reader, [id('b1'), id('c1'), id('d2')]])
    expect(written.rows).toEqual([])
  })

  test('mark-all-read refuses a body userId naming someone else and leaves that user’s read state untouched (#5840)', async () => {
    const res = await request(readerApp())
      .post(`/api/multitable/${sheetA}/comments/mark-all-read`)
      .send({ userId: bystander })
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).not.toContain(bystander)
    const bystanderReads = await q('SELECT count(*)::int AS c FROM meta_comment_reads WHERE user_id = $1', [bystander])
    expect(Number((bystanderReads.rows[0] as { c: number }).c)).toBe(0)
    // The bystander can still clear their own state.
    const own = await request(buildApp(bystander, PERMS)).post(`/api/multitable/${sheetA}/comments/mark-all-read`).send({})
    expect(own.status).toBe(200)
    expect(own.body.data.markedRead).toBe(5)
  })

  test('every listed item can be marked read; afterwards the unread count is 0 and only mentioned items stay listed', async () => {
    for (const listed of (await inbox(50, 0)).items) {
      const res = await request(readerApp()).post(`/api/comments/${listed.id}/read`)
      expect(res.status, `${listed.id}: ${res.text}`).toBe(204)
    }
    const count = await request(readerApp()).get('/api/comments/unread-count')
    expect(count.body.data).toEqual({ unreadCount: 0, mentionUnreadCount: 0, count: 0 })
    const after = await inbox(50, 0)
    expect(after.items.map((i) => i.id)).toEqual([id('a4'), id('a2')])
    expect(after.total).toBe(2)
  })
})
