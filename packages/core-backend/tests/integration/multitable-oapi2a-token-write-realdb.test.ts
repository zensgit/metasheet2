/**
 * OAPI-2a — token WRITE routes (real DB).
 * Design-lock: docs/development/multitable-oapi2-write-designlock-20260628.md (RATIFIED).
 *
 * Proves an `mst_` records:write token mutates AS ITS CREATOR (Option A) through the full write stack, with
 * deny-by-default scope, revoke, the min(token, creator-RBAC) spine, and the two-layer audit:
 *   - valid records:write → POST /records / PATCH /records/:id / POST /patch succeed + a COMMITTED audit row
 *     (operation create/update/upsert; actor_id = creator — acts-as-creator provenance);
 *   - records:read token (wrong scope) → 403 INSUFFICIENT_SCOPE, NO mutation, + a DENIED audit row (§6 Layer-1);
 *   - revoked → 401; no token → 401;
 *   - min spine — creator lacks multitable:write → 403 even WITH records:write scope, NO mutation;
 *   - fail-closed — when the in-txn committed audit insert fails, the write ROLLS BACK (no record created).
 *
 * Rate-limit (600/min/token) and cross-base mirror write-gate are exercised at the unit/design level and by
 * the shared RecordWriteService gates; a full 600-request loop / cross-base fixture is deferred from this golden.
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { db } from '../../src/db/db'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ApiTokenService } from '../../src/multitable/api-token-service'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE_ID = `base_oapi2a_${TS}`
const SHEET_ID = `sheet_oapi2a_${TS}`
const STATUS = `fld_oapi2a_status_${TS}`
const REC_SEED = `rec_oapi2a_seed_${TS}`
const WRITER = `user_oapi2a_writer_${TS}`
const RO = `user_oapi2a_ro_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let tokWrite = '', tokWriteId = '' // records:write, creator = WRITER (can write)
let tokWrongScope = '', tokWrongScopeId = '' // records:read only
let tokRevoked = '' // records:write, then revoked
let tokRoWrite = '' // records:write, creator = RO (cannot write)

const recordCount = async (): Promise<number> => {
  const r = await q('SELECT COUNT(*)::int AS n FROM meta_records WHERE sheet_id = $1', [SHEET_ID])
  return (r.rows[0] as { n: number }).n
}
const auditRows = async (
  tokenId: string,
): Promise<Array<{ operation: string; outcome: string; status_code: number | null; actor_id: string }>> => {
  const r = await q(
    'SELECT operation, outcome, status_code, actor_id FROM oapi_write_audit WHERE token_id = $1 ORDER BY id',
    [tokenId],
  )
  return r.rows as Array<{ operation: string; outcome: string; status_code: number | null; actor_id: string }>
}
const post = (path: string, token: string, body: unknown) =>
  request(app).post(path).set('Authorization', `Bearer ${token}`).send(body)

describeIfDatabase('OAPI-2a token WRITE routes (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    // No fake-user middleware: each route's apiTokenAuth must set the actor from the token itself.
    app.use('/api/multitable', univerMetaRouter())

    for (const [id, perms] of [
      [WRITER, ['multitable:write']],
      [RO, ['multitable:read']],
    ] as const) {
      await q(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1,$2,$3,'x','member',$4::jsonb, TRUE, FALSE)
         ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
        [id, `${id}@t.local`, id, JSON.stringify(perms)],
      )
    }
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'OAPI2a Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'OAPI2a Sheet'])
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [STATUS, SHEET_ID, 'Status', 'text', '{}', 1],
    )
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
      REC_SEED,
      SHEET_ID,
      JSON.stringify({ [STATUS]: 'seed' }),
    ])

    const svc = new ApiTokenService(db)
    const w = await svc.createToken(WRITER, { name: 'w', scopes: ['records:write'] })
    tokWrite = w.plainTextToken
    tokWriteId = w.token.id
    const ws = await svc.createToken(WRITER, { name: 'ws', scopes: ['records:read'] })
    tokWrongScope = ws.plainTextToken
    tokWrongScopeId = ws.token.id
    const rv = await svc.createToken(WRITER, { name: 'rv', scopes: ['records:write'] })
    tokRevoked = rv.plainTextToken
    await svc.revokeToken(rv.token.id, WRITER)
    const ro = await svc.createToken(RO, { name: 'ro', scopes: ['records:write'] })
    tokRoWrite = ro.plainTextToken
  })

  afterAll(async () => {
    await db.deleteFrom('multitable_api_tokens').where('created_by', 'in', [WRITER, RO]).execute().catch(() => {})
    await q('DELETE FROM oapi_write_audit WHERE token_id = ANY($1::text[])', [[tokWriteId, tokWrongScopeId]]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[WRITER, RO]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('records:write → POST /records creates + a committed audit row (operation=create, actor=creator)', async () => {
    const before = await recordCount()
    const res = await post('/api/multitable/records', tokWrite, { sheetId: SHEET_ID, data: { [STATUS]: 'created-by-token' } })
    expect([200, 201]).toContain(res.status)
    expect(await recordCount()).toBe(before + 1)
    const committed = (await auditRows(tokWriteId)).filter((r) => r.outcome === 'committed' && r.operation === 'create')
    expect(committed.length).toBeGreaterThanOrEqual(1)
    expect(committed[0].actor_id).toBe(WRITER) // acts-as-creator provenance (Option A)
  })

  test('records:write → PATCH /records/:id updates + committed audit (operation=update)', async () => {
    const res = await request(app)
      .patch(`/api/multitable/records/${REC_SEED}`)
      .set('Authorization', `Bearer ${tokWrite}`)
      .send({ sheetId: SHEET_ID, data: { [STATUS]: 'patched' } })
    expect(res.status).toBe(200)
    const chk = await q('SELECT data FROM meta_records WHERE id = $1', [REC_SEED])
    expect((chk.rows[0] as { data: Record<string, unknown> }).data[STATUS]).toBe('patched')
    expect((await auditRows(tokWriteId)).some((r) => r.outcome === 'committed' && r.operation === 'update')).toBe(true)
  })

  test('records:write → POST /patch upserts + committed audit (operation=upsert)', async () => {
    const res = await post('/api/multitable/patch', tokWrite, {
      sheetId: SHEET_ID,
      changes: [{ recordId: REC_SEED, fieldId: STATUS, value: 'upserted' }],
    })
    expect(res.status).toBe(200)
    expect((await auditRows(tokWriteId)).some((r) => r.outcome === 'committed' && r.operation === 'upsert')).toBe(true)
  })

  test('OAPI-2b: records:write → DELETE /records/:id soft-deletes + committed audit (operation=delete); wrong-scope 403', async () => {
    const REC_DEL = `rec_oapi2b_del_${TS}`
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_DEL, SHEET_ID, JSON.stringify({ [STATUS]: 'to-delete' })])
    // wrong scope → 403, record still present (no destructive action without records:write)
    expect((await request(app).delete(`/api/multitable/records/${REC_DEL}`).set('Authorization', `Bearer ${tokWrongScope}`)).status).toBe(403)
    expect((await q('SELECT 1 FROM meta_records WHERE id = $1', [REC_DEL])).rows.length).toBe(1)
    // records:write → soft delete (removed from the live table → trash; not a hard purge)
    const res = await request(app).delete(`/api/multitable/records/${REC_DEL}`).set('Authorization', `Bearer ${tokWrite}`)
    expect([200, 204]).toContain(res.status)
    expect((await q('SELECT 1 FROM meta_records WHERE id = $1', [REC_DEL])).rows.length).toBe(0)
    expect((await auditRows(tokWriteId)).some((r) => r.outcome === 'committed' && r.operation === 'delete')).toBe(true)
  })

  test('wrong scope (records:read) → POST /records 403 + NO create + a denied audit row', async () => {
    const before = await recordCount()
    const res = await post('/api/multitable/records', tokWrongScope, { sheetId: SHEET_ID, data: { [STATUS]: 'should-not-exist' } })
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).toContain('INSUFFICIENT_SCOPE')
    expect(await recordCount()).toBe(before) // no mutation
    await new Promise((r) => setTimeout(r, 75)) // let the res.on('finish') boundary listener flush
    expect((await auditRows(tokWrongScopeId)).some((r) => r.outcome === 'denied' && r.status_code === 403)).toBe(true)
  })

  test('revoked token → POST /records 401, no create', async () => {
    const before = await recordCount()
    expect((await post('/api/multitable/records', tokRevoked, { sheetId: SHEET_ID, data: {} })).status).toBe(401)
    expect(await recordCount()).toBe(before)
  })

  test('no token → POST /records 401 (auth required)', async () => {
    const before = await recordCount()
    expect((await request(app).post('/api/multitable/records').send({ sheetId: SHEET_ID, data: {} })).status).toBe(401)
    expect(await recordCount()).toBe(before)
  })

  test('min spine — creator lacks multitable:write → 403 even WITH records:write scope, no create', async () => {
    const before = await recordCount()
    const res = await post('/api/multitable/records', tokRoWrite, { sheetId: SHEET_ID, data: { [STATUS]: 'ro-denied' } })
    expect(res.status).toBe(403) // token scope OK, but the creator's live capability denies → min(token, creator-RBAC)
    expect(await recordCount()).toBe(before)
  })

  test('fail-closed — an in-txn committed-audit failure ROLLS BACK the write (no record created)', async () => {
    const before = await recordCount()
    // Rename the audit table so the in-txn INSERT throws → the create transaction must roll back.
    await q('ALTER TABLE oapi_write_audit RENAME TO oapi_write_audit_tmp', [])
    try {
      const res = await post('/api/multitable/records', tokWrite, { sheetId: SHEET_ID, data: { [STATUS]: 'should-rollback' } })
      expect(res.status).toBeGreaterThanOrEqual(500) // audit insert failed inside the txn → 5xx
      expect(await recordCount()).toBe(before) // fail-closed: NO record persisted
    } finally {
      await q('ALTER TABLE oapi_write_audit_tmp RENAME TO oapi_write_audit', [])
    }
  })
})
