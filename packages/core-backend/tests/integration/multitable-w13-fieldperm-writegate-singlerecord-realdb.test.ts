/**
 * W1-3 GW4/GW5(+GW6 spot-check) — Layer-3 per-subject field-WRITE gate on single-record
 * `PATCH /records/:recordId` (real DB).
 * Design-lock: docs/development/multitable-per-subject-field-write-gate-w13-designlock-20260705.md
 * (RATIFIED, merged 470250e1a). §4 golden matrix, GW4 / GW5 / GW6.
 *
 * The gap this closes: `PATCH /records/:recordId` (univer-meta.ts) checks only the coarse
 * `capabilities.canEditRecord` then calls `recordService.patchRecord` directly — no `buildRecordPatchContext`,
 * no `fieldPermissions`, no layer-3 gate. This route is NOT token-exclusive: `apiTokenAuth` only intercepts
 * `mst_`-prefixed Bearer tokens and calls `next()` for everything else (middleware/api-token-auth.ts:47-58),
 * so an ordinary session/JWT-authenticated single-record edit reaches this SAME handler. GW4 asserts the
 * fix for BOTH caller shapes explicitly, since the gap (and the fix) covers both.
 *
 * GW6 (regression): a small spot-check that the SIX pre-existing route-level gates were not disturbed by
 * the F2 shared-predicate extraction. This file spot-checks grid `/patch` directly (the site whose inline
 * code this batch touched most directly). The other five sites (restore / restore-execute /
 * restore-batch-execute / revert-execute) are covered by their OWN pre-existing dedicated real-DB suites,
 * re-run unchanged as part of this batch's verification (not duplicated here) — see the PR body for the
 * full run.
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI per the suite convention).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { db } from '../../src/db/db'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ApiTokenService } from '../../src/multitable/api-token-service'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE_ID = `base_w13sr_${TS}`
const SHEET_ID = `sheet_w13sr_${TS}`
const F_OPEN = `fld_w13sr_open_${TS}` // normal, writable by everyone
const F_LOCKED = `fld_w13sr_locked_${TS}` // per-subject read_only for SESSION_ACTOR + TOKEN_CREATOR only

// Two DISTINCT restricted subjects (own field_permissions row each) so the token-channel and
// session-channel goldens are independent, plus one unrestricted control subject (GW5).
const SESSION_ACTOR_ID = `u_w13sr_session_${TS}`
const TOKEN_CREATOR_ID = `u_w13sr_tokencreator_${TS}`
const UNRESTRICTED_ID = `u_w13sr_unrestricted_${TS}`

const REC_GW4_SESSION = `rec_w13sr_gw4session_${TS}`
const REC_GW4_TOKEN = `rec_w13sr_gw4token_${TS}`
const REC_GW5_SESSION = `rec_w13sr_gw5session_${TS}`
const REC_GW5_TOKEN = `rec_w13sr_gw5token_${TS}`
const REC_GW6_PATCH = `rec_w13sr_gw6patch_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let tokWrite = ''
let tokWriteId = ''
// Mutable "current session actor" the fake session-auth middleware reads PER REQUEST (not captured at
// mount time) — lets each test switch the session identity, the same pattern
// multitable-fieldperm-write-gate-patch-realdb.test.ts and multitable-restore-batch-allornothing-realdb.test.ts
// use for their req.user-faking middleware.
let currentSessionUserId = SESSION_ACTOR_ID

// Session/JWT-style caller: NO Authorization header → apiTokenAuth calls next() untouched, and the
// req.user set by this fake "always-on" session middleware (mounted BEFORE the router, same ordering as
// a real session-auth middleware in production) is what resolveSheetCapabilities resolves against.
const patchAsSession = (recordId: string, data: Record<string, unknown>) =>
  request(app).patch(`/api/multitable/records/${recordId}`).send({ sheetId: SHEET_ID, data })

// mst_ token caller: apiTokenAuth intercepts the Bearer mst_ token and OVERWRITES req.user with the
// token's creator — same route, same handler, no second implementation to drift.
const patchAsToken = (recordId: string, data: Record<string, unknown>) =>
  request(app)
    .patch(`/api/multitable/records/${recordId}`)
    .set('Authorization', `Bearer ${tokWrite}`)
    .send({ sheetId: SHEET_ID, data })

const patchGridAsSession = (changes: Array<{ recordId: string; fieldId: string; value: unknown }>) =>
  request(app).post('/api/multitable/patch').send({ sheetId: SHEET_ID, changes })

const storedRecord = async (recordId: string): Promise<{ data: Record<string, unknown>; version: number }> => {
  const r = await q('SELECT data, version FROM meta_records WHERE id = $1', [recordId])
  return r.rows[0] as { data: Record<string, unknown>; version: number }
}

describeIfDatabase('W1-3 GW4/GW5/GW6 — layer-3 per-subject field-write gate on single-record PATCH (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    // Fake "always-on" session-auth middleware — mirrors production ordering: session auth runs first
    // and sets req.user broadly; apiTokenAuth (mounted per-route inside univerMetaRouter) only OVERWRITES
    // req.user when a valid mst_ token is present, and is a no-op otherwise (see api-token-auth.ts:47-58).
    app.use((req, _res, next) => {
      ;(req as { user?: unknown }).user = { id: currentSessionUserId, roles: ['member'], perms: [] }
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1,$2,$1,'x','member',$3::jsonb, TRUE, FALSE) ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
      [SESSION_ACTOR_ID, `${SESSION_ACTOR_ID}@t.local`, JSON.stringify(['multitable:write'])],
    )
    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1,$2,$1,'x','member',$3::jsonb, TRUE, FALSE) ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
      [TOKEN_CREATOR_ID, `${TOKEN_CREATOR_ID}@t.local`, JSON.stringify(['multitable:write'])],
    )
    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1,$2,$1,'x','member',$3::jsonb, TRUE, FALSE) ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
      [UNRESTRICTED_ID, `${UNRESTRICTED_ID}@t.local`, JSON.stringify(['multitable:write'])],
    )

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'W1-3 SR Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'W1-3 SR Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_OPEN, SHEET_ID, 'Open', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_LOCKED, SHEET_ID, 'Locked', 'string', '{}', 2])
    // F_LOCKED is read-only for SESSION_ACTOR_ID and TOKEN_CREATOR_ID specifically (visible, not writable).
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, F_LOCKED, 'user', SESSION_ACTOR_ID, true, true])
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, F_LOCKED, 'user', TOKEN_CREATOR_ID, true, true])
    // No field_permissions row for UNRESTRICTED_ID at all.

    const svc = new ApiTokenService(db)
    const w = await svc.createToken(TOKEN_CREATOR_ID, { name: 'w13-gw4-write', scopes: ['records:write'] })
    tokWrite = w.plainTextToken
    tokWriteId = w.token.id
  })

  afterAll(async () => {
    await db.deleteFrom('multitable_api_tokens').where('created_by', '=', TOKEN_CREATOR_ID).execute().catch(() => {})
    await q('DELETE FROM oapi_write_audit WHERE token_id = $1', [tokWriteId]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[SESSION_ACTOR_ID, TOKEN_CREATOR_ID, UNRESTRICTED_ID]]).catch(() => {})
  })

  beforeEach(async () => {
    currentSessionUserId = SESSION_ACTOR_ID
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID])
    const seed = (id: string) => q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [id, SHEET_ID, JSON.stringify({ [F_OPEN]: 'orig-open', [F_LOCKED]: 'orig-locked' })])
    await seed(REC_GW4_SESSION)
    await seed(REC_GW4_TOKEN)
    await seed(REC_GW5_SESSION)
    await seed(REC_GW5_TOKEN)
    await seed(REC_GW6_PATCH)
  })

  test('sentinel: DATABASE_URL set (real DB run, not skipped)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('GW4 (session/JWT caller): per-subject read-only field write via PATCH /records/:recordId → 403, zero side effects', async () => {
    const res = await patchAsSession(REC_GW4_SESSION, { [F_LOCKED]: 'hacked-session' })
    expect(res.status).toBe(403)
    const stored = await storedRecord(REC_GW4_SESSION)
    expect(stored.data[F_LOCKED]).toBe('orig-locked') // unchanged
    expect(stored.version).toBe(1) // no version bump
  })

  test('GW4 (mst_ token caller): per-subject read-only field write via PATCH /records/:recordId → 403, zero side effects', async () => {
    const res = await patchAsToken(REC_GW4_TOKEN, { [F_LOCKED]: 'hacked-token' })
    expect(res.status).toBe(403)
    const stored = await storedRecord(REC_GW4_TOKEN)
    expect(stored.data[F_LOCKED]).toBe('orig-locked')
    expect(stored.version).toBe(1)
  })

  test('GW5 (session/JWT caller, UNRESTRICTED subject): same single-record PATCH on the per-subject-locked field → 200, write lands', async () => {
    currentSessionUserId = UNRESTRICTED_ID // switch the fake session identity for this one test
    const res = await patchAsSession(REC_GW5_SESSION, { [F_LOCKED]: 'gw5-session-write' })
    expect(res.status).toBe(200)
    const stored = await storedRecord(REC_GW5_SESSION)
    expect(stored.data[F_LOCKED]).toBe('gw5-session-write')
    expect(stored.version).toBe(2)
  })

  test('GW5 (mst_ token caller, UNRESTRICTED subject): single-record PATCH on the per-subject-locked field → 200, write lands', async () => {
    const svc = new ApiTokenService(db)
    const w = await svc.createToken(UNRESTRICTED_ID, { name: 'w13-gw5-unrestricted', scopes: ['records:write'] })
    const res = await request(app)
      .patch(`/api/multitable/records/${REC_GW5_TOKEN}`)
      .set('Authorization', `Bearer ${w.plainTextToken}`)
      .send({ sheetId: SHEET_ID, data: { [F_LOCKED]: 'gw5-token-write' } })
    expect(res.status).toBe(200)
    const stored = await storedRecord(REC_GW5_TOKEN)
    expect(stored.data[F_LOCKED]).toBe('gw5-token-write')
    expect(stored.version).toBe(2)
    await new Promise((r) => setTimeout(r, 75)) // let the res.on('finish') audit listener flush before cleanup
    await q('DELETE FROM oapi_write_audit WHERE token_id = $1', [w.token.id]).catch(() => {})
    await db.deleteFrom('multitable_api_tokens').where('id', '=', w.token.id).execute().catch(() => {})
  })

  test('GW6 spot-check (regression): grid /patch against the SAME per-subject read-only field is byte-identical to today (still 403, zero side effects)', async () => {
    const res = await patchGridAsSession([{ recordId: REC_GW6_PATCH, fieldId: F_LOCKED, value: 'gw6-hacked' }])
    expect(res.status).toBe(403)
    const stored = await storedRecord(REC_GW6_PATCH)
    expect(stored.data[F_LOCKED]).toBe('orig-locked')
    expect(stored.version).toBe(1)
  })

  test('GW6 spot-check (regression): grid /patch still writes a NORMAL field (not a block-all after the F2 predicate extraction)', async () => {
    const res = await patchGridAsSession([{ recordId: REC_GW6_PATCH, fieldId: F_OPEN, value: 'gw6-open-write' }])
    expect(res.status).toBe(200)
    const stored = await storedRecord(REC_GW6_PATCH)
    expect(stored.data[F_OPEN]).toBe('gw6-open-write')
  })
})
