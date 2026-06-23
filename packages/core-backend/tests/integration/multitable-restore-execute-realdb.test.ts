/**
 * Global History — T6-2: scoped restore EXECUTE (real DB; the first write slice).
 *
 * Load-bearing golden = END-TO-END: a real T5-2 preview mints an identity, a real T6-2 execute consumes it and
 * writes the forward revision. This is the drift guard for the three copies of the diff (/restore, T5-2 preview,
 * T6-2 execute) — if any diverges, the changesHash won't match and execute 4xx's. Plus the NEW surfaces: row-deny
 * (SR-2, mutation-checked), identity-required, and replay idempotency.
 * Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_rx_${TS}`
const SHEET = `sheet_rx_${TS}`
const NAME = `fld_rx_name_${TS}`
const SALARY = `fld_rx_salary_${TS}`
const REC = `rec_rx_${TS}`
const REC_DENIED = `rec_rx_denied_${TS}`
const VIEWER = `user_rx_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let curUser = VIEWER
let curRoles = ['member']
const preview = (recordId: string, body: Record<string, unknown>) => request(app).post(`/api/multitable/sheets/${SHEET}/records/${recordId}/restore-preview`).send(body)
const execute = (recordId: string, body: Record<string, unknown>) => request(app).post(`/api/multitable/sheets/${SHEET}/records/${recordId}/restore-execute`).send(body)
const recordData = async (recordId: string) => ((await q('SELECT data FROM meta_records WHERE id = $1', [recordId])).rows[0] as { data: Record<string, unknown> } | undefined)?.data

describeIfDatabase('multitable scoped restore execute — T6-2 (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: curUser, roles: curRoles, perms: ['multitable:read', 'multitable:write'] }; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'RX Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'RX Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [NAME, SHEET, 'Name', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [SALARY, SHEET, 'Salary', 'number', '{}', 2])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [VIEWER])
  })

  afterAll(async () => {
    for (const t of ['field_permissions', 'meta_record_revisions', 'meta_records', 'meta_fields']) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [VIEWER]).catch(() => {})
  })

  // Fresh: REC at v2 {NAME:'b', SALARY:200}; v1 snapshot {NAME:'a', SALARY:100}. No field/row deny by default.
  beforeEach(async () => {
    curUser = VIEWER; curRoles = ['member']
    await q("UPDATE meta_sheets SET row_level_read_permissions_enabled = false, conditional_read_rules = '[]'::jsonb WHERE id = $1", [SHEET])
    for (const t of ['field_permissions', 'meta_record_revisions', 'meta_records']) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [REC, SHEET, JSON.stringify({ [NAME]: 'b', [SALARY]: 200 })])
    await q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at) VALUES (gen_random_uuid(), $1, $2, 1, 'create', 'rest', ARRAY[$3,$4]::text[], '{}'::jsonb, $5::jsonb, now())`, [SHEET, REC, NAME, SALARY, JSON.stringify({ [NAME]: 'a', [SALARY]: 100 })])
    await q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at) VALUES (gen_random_uuid(), $1, $2, 2, 'update', 'rest', ARRAY[$3,$4]::text[], '{}'::jsonb, $5::jsonb, now())`, [SHEET, REC, NAME, SALARY, JSON.stringify({ [NAME]: 'b', [SALARY]: 200 })])
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('END-TO-END: a real preview identity is accepted and the record is restored to the target version', async () => {
    const pv = await preview(REC, { targetVersion: 1 })
    expect(pv.status).toBe(200)
    const identity = pv.body?.data?.previewIdentity as string
    expect(typeof identity).toBe('string')
    const ex = await execute(REC, { targetVersion: 1, expectedVersion: 2, previewIdentity: identity })
    expect(ex.status).toBe(200)
    expect(ex.body?.data?.noop).toBe(false)
    expect(await recordData(REC)).toMatchObject({ [NAME]: 'a', [SALARY]: 100 }) // restored to v1
  })

  test('layer-3 write gate: a VISIBLE+readOnly field in the restore → 403 RESTORE_FORBIDDEN, nothing written', async () => {
    // SALARY: visible=true, read_only=true for the actor (per-subject layer-3 write-deny). patchRecords does NOT
    // enforce this; only the route can. SALARY is VISIBLE so it is in the previewed diff + the identity — the gate
    // must reject the WRITE (parity with the legacy /restore + the BS-3 batch fan-out). Closes the shipped T6-2 gap.
    await q(`INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,'user',$3,true,true) ON CONFLICT DO NOTHING`, [SHEET, SALARY, VIEWER])
    const identity = (await preview(REC, { targetVersion: 1 })).body?.data?.previewIdentity as string
    const ex = await execute(REC, { targetVersion: 1, expectedVersion: 2, previewIdentity: identity })
    expect(ex.status).toBe(403)
    expect(ex.body?.error?.code).toBe('RESTORE_FORBIDDEN')
    expect(await recordData(REC)).toMatchObject({ [NAME]: 'b', [SALARY]: 200 }) // NOT restored — gated before any write
  })

  test('identity required: a missing identity is 400; a tampered identity is rejected (the route enforces verify)', async () => {
    expect((await execute(REC, { targetVersion: 1, expectedVersion: 2 })).status).toBe(400) // missing
    const identity = (await preview(REC, { targetVersion: 1 })).body?.data?.previewIdentity as string
    const tampered = identity.slice(0, -4) + (identity.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA')
    const ex = await execute(REC, { targetVersion: 1, expectedVersion: 2, previewIdentity: tampered })
    expect(ex.status).toBe(409)
    expect(ex.body?.error?.code).toBe('PREVIEW_IDENTITY_INVALID')
    expect(await recordData(REC)).toMatchObject({ [NAME]: 'b' }) // NOT restored — write-gated on a valid identity
  })

  test('SR-2 row-deny: a row-read-denied record cannot be executed (404 no-oracle)', async () => {
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [REC_DENIED, SHEET, JSON.stringify({ [NAME]: 'secret' })])
    await q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at) VALUES (gen_random_uuid(), $1, $2, 1, 'create', 'rest', ARRAY[$3]::text[], '{}'::jsonb, $4::jsonb, now())`, [SHEET, REC_DENIED, NAME, JSON.stringify({ [NAME]: 'old' })])
    // Mint a well-formed identity for the denied record BEFORE turning on the deny (so the only thing stopping
    // execute is the row-deny gate, not a bad identity).
    const identity = (await preview(REC_DENIED, { targetVersion: 1 })).body?.data?.previewIdentity as string
    await q("UPDATE meta_sheets SET row_level_read_permissions_enabled = true, conditional_read_rules = $2::jsonb WHERE id = $1", [SHEET, JSON.stringify([{ id: 'r1', fieldId: NAME, operator: 'eq', value: 'secret', effect: 'deny_read' }])])
    const ex = await execute(REC_DENIED, { targetVersion: 1, expectedVersion: 2, previewIdentity: identity })
    expect(ex.status).toBe(404) // denied → not-found shape, no oracle, before any write
    await q('DELETE FROM meta_records WHERE id = $1', [REC_DENIED])
  })

  test('replay idempotency: re-executing the same identity is rejected (the version moved → 409)', async () => {
    const identity = (await preview(REC, { targetVersion: 1 })).body?.data?.previewIdentity as string
    expect((await execute(REC, { targetVersion: 1, expectedVersion: 2, previewIdentity: identity })).status).toBe(200) // first wins
    const replay = await execute(REC, { targetVersion: 1, expectedVersion: 2, previewIdentity: identity })
    expect(replay.status).toBe(409) // second: expectedVersion 2 != current 3 (CAS) — at-most-once
  })

  test('cross-record: an identity minted for one record cannot execute another', async () => {
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [REC_DENIED, SHEET, JSON.stringify({ [NAME]: 'x' })])
    await q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at) VALUES (gen_random_uuid(), $1, $2, 1, 'create', 'rest', ARRAY[$3]::text[], '{}'::jsonb, $4::jsonb, now())`, [SHEET, REC_DENIED, NAME, JSON.stringify({ [NAME]: 'y' })])
    const identityForRec = (await preview(REC, { targetVersion: 1 })).body?.data?.previewIdentity as string
    const ex = await execute(REC_DENIED, { targetVersion: 1, expectedVersion: 2, previewIdentity: identityForRec }) // wrong record
    expect(ex.status).toBe(409)
    expect(ex.body?.error?.code).toBe('PREVIEW_IDENTITY_INVALID')
    await q('DELETE FROM meta_records WHERE id = $1', [REC_DENIED])
  })

  test('schema-drift: preview withholds the identity and execute rejects (no silent partial restore)', async () => {
    const GHOST = `fld_rx_ghost_${TS}` // present in the v1 snapshot but NOT in the current schema
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2', [SHEET, REC])
    await q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at) VALUES (gen_random_uuid(), $1, $2, 1, 'create', 'rest', ARRAY[$3]::text[], '{}'::jsonb, $4::jsonb, now())`, [SHEET, REC, NAME, JSON.stringify({ [NAME]: 'a', [GHOST]: 'x' })])
    const pv = await preview(REC, { targetVersion: 1 })
    expect(pv.body?.data?.schemaDrift).toBe(true)
    expect(pv.body?.data?.previewIdentity).toBeNull() // no executable identity under drift
    // a forced execute (any identity) must reject on drift, BEFORE any write — never a silent partial restore.
    const ex = await execute(REC, { targetVersion: 1, expectedVersion: 2, previewIdentity: 'forged.token.value' })
    expect(ex.status).toBe(422)
    expect(ex.body?.error?.code).toBe('SCHEMA_DRIFT')
    expect(await recordData(REC)).toMatchObject({ [NAME]: 'b' }) // unchanged — nothing written
  })
})
