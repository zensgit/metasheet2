/**
 * B1-G2 — permission golden matrix: OAPI `mst_` token WRITE re-gates the SAME modifiers as the
 * interactive PATCH route (real DB). Spec: W1-2 permission-matrix (docs/development/multitable-w1-2-
 * permission-matrix-spec-20260705.md) §3 gap G-2 / §2 axis A7×S2×M2/M3/M4.
 *
 * The token PATCH route (`router.patch('/records/:recordId', apiTokenAuth, ..., requireScope
 * ('records:write'), ...)`, univer-meta.ts) is the IDENTICAL handler the interactive session hits —
 * `apiTokenAuth` only substitutes `req.user` with the token's creator before the SAME
 * `resolveSheetCapabilities` → `RecordService.patchRecord` → `RecordWriteService.patchRecords` spine
 * runs. There is no second, token-specific authorization implementation to drift out of sync — but a
 * regression (e.g. a future direct-DB fast path for tokens) could silently reintroduce one, so this
 * batch pins parity explicitly rather than relying on "it's the same code" as an implicit guarantee.
 *
 * Grounded in multitable-oapi2a-token-write-realdb.test.ts (harness + token setup) and
 * multitable-record-lock.test.ts (LR-T1 lock semantics).
 *
 * Modifier-by-modifier disposition (verified against the write spine, not assumed):
 *  - M3 (record lock, `ensureRecordNotLocked` — record-write-service.ts:806): a TRUE, unconditional
 *    gate — reached by every `patchRecords` caller regardless of entry point. G2-1 pins TOKEN PATCH
 *    denies exactly like interactive LR-T1, with zero side effects.
 *  - M2 (row-level read-deny, `record_permissions` 'none') and M4 (conditional rule, `effect:
 *    'deny_read'`) are READ-ONLY constructs: `ensureRecordWriteAllowed` (both the sheet-capabilities.ts
 *    and permission-service.ts implementations) takes a `SheetPermissionScope`/optional per-record
 *    ADDITIVE-grant map — never a denial input — and `RecordWriteService.patchRecords` never loads
 *    `record_permissions` or evaluates conditional rules at all. So a capable writer's PATCH of a
 *    row-denied or rule-denied record is NOT a gate anywhere (REST, bridge, or token) — confirmed by
 *    exhaustive grep of the write spine. G2-2/G2-3 pin that the TOKEN path exhibits this SAME
 *    documented non-gate (parity with interactive), which is the literal "re-gate exactly like
 *    interactive" bar for a modifier interactive itself never gates on write. This mirrors the
 *    permission-matrix ledger's existing non-gate-documentation convention (docs/development/
 *    permission-matrix-golden-20260525.md §2) rather than asserting a stronger property that isn't true.
 *
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
const BASE_ID = `base_b1g2_${TS}`
const SHEET_ID = `sheet_b1g2_${TS}`
const STATUS = `fld_b1g2_status_${TS}`
const WRITER = `user_b1g2_writer_${TS}` // token creator, has multitable:write
const STRANGER = `user_b1g2_stranger_${TS}` // locks REC_LOCKED — not the token creator

const REC_LOCKED = `rec_b1g2_locked_${TS}`
const REC_RULEDENY = `rec_b1g2_ruledeny_${TS}`
const REC_ROWDENY = `rec_b1g2_rowdeny_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let tokWrite = '', tokWriteId = '' // records:write, creator = WRITER

const auditRows = async (
  tokenId: string,
): Promise<Array<{ operation: string; outcome: string; status_code: number | null }>> => {
  const r = await q(
    'SELECT operation, outcome, status_code FROM oapi_write_audit WHERE token_id = $1 ORDER BY id',
    [tokenId],
  )
  return r.rows as Array<{ operation: string; outcome: string; status_code: number | null }>
}
const patchViaToken = (recordId: string, data: Record<string, unknown>) =>
  request(app)
    .patch(`/api/multitable/records/${recordId}`)
    .set('Authorization', `Bearer ${tokWrite}`)
    .send({ sheetId: SHEET_ID, data })
const storedRecord = async (recordId: string): Promise<{ data: Record<string, unknown>; version: number }> => {
  const r = await q('SELECT data, version FROM meta_records WHERE id = $1', [recordId])
  return r.rows[0] as { data: Record<string, unknown>; version: number }
}

describeIfDatabase('B1-G2 permission golden — OAPI token write re-gates M2/M3/M4 exactly like interactive (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    // No fake-user middleware: apiTokenAuth resolves the actor from the token's creator, exactly
    // like the wrong-scope/revoked/min-spine goldens in multitable-oapi2a-token-write-realdb.test.ts.
    app.use('/api/multitable', univerMetaRouter())

    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1,$2,$3,'x','member',$4::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
      [WRITER, `${WRITER}@t.local`, WRITER, JSON.stringify(['multitable:write'])],
    )

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'B1-G2 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'B1-G2 Sheet'])
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [STATUS, SHEET_ID, 'Status', 'text', '{}', 1],
    )

    // M3 fixture — locked by STRANGER (not the token creator WRITER, not admin): a true gate.
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
      REC_LOCKED, SHEET_ID, JSON.stringify({ [STATUS]: 'before-lock' }),
    ])
    await q('UPDATE meta_records SET locked = true, locked_by = $2 WHERE id = $1', [REC_LOCKED, STRANGER])

    // M4 fixture — sheet-level conditional deny_read rule matches this record's Status='secret'.
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
      REC_RULEDENY, SHEET_ID, JSON.stringify({ [STATUS]: 'secret' }),
    ])
    await q(
      'UPDATE meta_sheets SET row_level_read_permissions_enabled = TRUE, conditional_read_rules = $2::jsonb WHERE id = $1',
      [SHEET_ID, JSON.stringify([{ id: 'r1', fieldId: STATUS, operator: 'eq', value: 'secret', effect: 'deny_read' }])],
    )

    // M2 fixture — an explicit 'none' record_permission scoped to WRITER (the token creator) on this
    // record. Same sheet-level flag as M4 (already flipped ON above) makes the deny "live" for reads.
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
      REC_ROWDENY, SHEET_ID, JSON.stringify({ [STATUS]: 'before-rowdeny' }),
    ])
    await q(
      'INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1,$2,$3,$4,$5)',
      [SHEET_ID, REC_ROWDENY, 'user', WRITER, 'none'],
    )

    const svc = new ApiTokenService(db)
    const w = await svc.createToken(WRITER, { name: 'b1g2-write', scopes: ['records:write'] })
    tokWrite = w.plainTextToken
    tokWriteId = w.token.id
  })

  afterAll(async () => {
    await db.deleteFrom('multitable_api_tokens').where('created_by', '=', WRITER).execute().catch(() => {})
    await q('DELETE FROM oapi_write_audit WHERE token_id = $1', [tokWriteId]).catch(() => {})
    await q('DELETE FROM record_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [WRITER]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('G2-1 (M3 gate): records:write token PATCH on a LOCKED record → 403, zero side effects, a denied audit row', async () => {
    const res = await patchViaToken(REC_LOCKED, { [STATUS]: 'sneaky-token-edit' })
    expect(res.status).toBe(403)

    const stored = await storedRecord(REC_LOCKED)
    expect(stored.data[STATUS]).toBe('before-lock') // unchanged
    expect(stored.version).toBe(1) // no version bump

    await new Promise((r) => setTimeout(r, 75)) // let the res.on('finish') audit listener flush
    const rows = await auditRows(tokWriteId)
    expect(rows.some((r) => r.outcome === 'denied' && r.status_code === 403)).toBe(true)
    expect(rows.some((r) => r.outcome === 'committed' && r.operation === 'update')).toBe(false)
  })

  test('G2-2 (M4 documented non-gate): records:write token PATCH on a conditional-rule-denied (deny_read) record still SUCCEEDS — parity with interactive (deny_read has no write-side effect)', async () => {
    const res = await patchViaToken(REC_RULEDENY, { [STATUS]: 'patched-by-token' })
    expect(res.status).toBe(200)

    const stored = await storedRecord(REC_RULEDENY)
    expect(stored.data[STATUS]).toBe('patched-by-token') // write went through
    expect(stored.version).toBe(2)

    await new Promise((r) => setTimeout(r, 75))
    expect((await auditRows(tokWriteId)).some((r) => r.outcome === 'committed' && r.operation === 'update')).toBe(true)
  })

  test('G2-3 (M2 documented non-gate): records:write token PATCH on a row-denied (record_permissions=none, scoped to the creator) record still SUCCEEDS — parity with interactive (row-level read-deny has no write-side effect)', async () => {
    const res = await patchViaToken(REC_ROWDENY, { [STATUS]: 'patched-despite-rowdeny' })
    expect(res.status).toBe(200)

    const stored = await storedRecord(REC_ROWDENY)
    expect(stored.data[STATUS]).toBe('patched-despite-rowdeny')
    expect(stored.version).toBe(2)

    await new Promise((r) => setTimeout(r, 75))
    expect((await auditRows(tokWriteId)).some((r) => r.outcome === 'committed' && r.operation === 'update')).toBe(true)
  })
})
