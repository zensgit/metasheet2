/**
 * A2 — History Field-Audit reveal runtime: security goldens (real DB).
 *
 * Design-lock: docs/development/multitable-history-field-audit-permission-design-lock-20260620.md (#2973).
 * The reveal lifts the per-subject `field_permissions` scope on the history surfaces — and ONLY that. These
 * goldens pin every load-bearing property:
 *   - default masked (#2968) with NO grant, even with ?reveal=1 (D1/LOCK-1);
 *   - a valid grant but NO reveal flag → still masked (D1: closed by default even for holders);
 *   - a valid grant + ?reveal=1 + reason → the field_permissions-denied field is revealed (id+value+count);
 *   - reason is REQUIRED on reveal → 400 (L8);
 *   - a SELF-issued grant (granted_by === revealer) does NOT enable reveal — the immutable LOCK-2a closure;
 *   - an expired grant does NOT enable reveal (LOCK-3);
 *   - row-level deny STILL applies under reveal — a row-denied record stays invisible (LOCK-4: field axis only);
 *   - field-definition hidden fields are NOT lifted by reveal (reveal lifts ONLY the field_permissions axis);
 *   - every reveal writes an `operation_audit_logs` record (actor/base/scope/reason, NO values) BEFORE
 *     disclosure, and an audit-write failure DEGRADES to the masked response (LOCK-5 read-side).
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE_ID = `base_rev_${TS}`
const SHEET_ID = `sheet_rev_${TS}`
const STATUS = `fld_rev_status_${TS}`
const SALARY = `fld_rev_salary_${TS}` // field_permission-denied to the VIEWER
const HIDDEN = `fld_rev_hidden_${TS}` // field-definition hidden (property.hidden) — never lifted by reveal
const REC_PUBLIC = `rec_rev_public_${TS}`
const REC_SECRET = `rec_rev_secret_${TS}`
const FIELD_BATCH = `batch_rev_field_${TS}` // REC_PUBLIC touching STATUS+SALARY+HIDDEN
const SECRET_BATCH = `batch_rev_secret_${TS}` // REC_SECRET (row-deny target)
const VIEWER = `user_rev_viewer_${TS}` // the auditor/reader; field_permissions denies SALARY
const ISSUER = `user_rev_issuer_${TS}` // grants to VIEWER (granted_by != VIEWER)

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let curUser: string | undefined = VIEWER
let curPerms: string[] = ['multitable:read', 'multitable:write']
let curRoles: string[] = ['member']

const events = (query: Record<string, unknown> = {}) =>
  request(app).get(`/api/multitable/bases/${BASE_ID}/history/events`).query({ limit: 100, ...query })
const detail = (batchId: string, query: Record<string, unknown> = {}) =>
  request(app).get(`/api/multitable/bases/${BASE_ID}/history/events/${batchId}`).query(query)
const recordHistory = (query: Record<string, unknown> = {}) =>
  request(app).get(`/api/multitable/sheets/${SHEET_ID}/records/${REC_PUBLIC}/history`).query(query)

type Batch = { batchId: string; visibleAffectedFieldCount: number }
const batchOf = (res: { body?: { data?: { batches?: Batch[] } } }, id: string) =>
  (res.body?.data?.batches ?? []).find((b) => b.batchId === id)
const batchIds = (res: { body?: { data?: { batches?: Batch[] } } }) => (res.body?.data?.batches ?? []).map((b) => b.batchId)

const denySalaryRule = [{ id: 'r1', fieldId: STATUS, operator: 'eq', value: 'secret', effect: 'deny_read' }]
const setFlag = (on: boolean) => q('UPDATE meta_sheets SET row_level_read_permissions_enabled = $2 WHERE id = $1', [SHEET_ID, on])
const setRules = (rules: unknown[]) => q('UPDATE meta_sheets SET conditional_read_rules = $2::jsonb WHERE id = $1', [SHEET_ID, JSON.stringify(rules)])

// Insert a grant TO the VIEWER, issued by `grantedBy`, expiring `daysFromNow` out (null = standing).
const grantToViewer = (grantedBy: string, daysFromNow: number | null = 30) =>
  q(
    `INSERT INTO meta_history_audit_grants (base_id, subject_type, subject_id, granted_by, reason, expires_at, is_standing)
     VALUES ($1,'user',$2,$3,'seed', $4, $5)`,
    [BASE_ID, VIEWER, grantedBy, daysFromNow === null ? null : new Date(TS + daysFromNow * 86400000).toISOString(), daysFromNow === null],
  )
const clearGrants = () => q('DELETE FROM meta_history_audit_grants WHERE base_id = $1', [BASE_ID])
const revealAudits = async () =>
  (await q(`SELECT actor_id, metadata FROM operation_audit_logs WHERE action = 'history_field_audit.reveal' AND metadata->>'baseId' = $1`, [BASE_ID]))
    .rows as Array<{ actor_id: string; metadata: Record<string, unknown> }>

describeIfDatabase('history field-audit reveal — A2 security goldens (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = curUser ? { id: curUser, roles: curRoles, perms: curPerms } : undefined; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'Rev Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'Rev Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [STATUS, SHEET_ID, 'Status', 'select', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [SALARY, SHEET_ID, 'Salary', 'number', '{}', 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [HIDDEN, SHEET_ID, 'HiddenF', 'number', '{"hidden":true}', 3])
    for (const [rid, status] of [[REC_PUBLIC, 'public'], [REC_SECRET, 'secret']] as const) {
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [rid, SHEET_ID, JSON.stringify({ [STATUS]: status })])
    }
    for (const uid of [VIEWER, ISSUER]) {
      await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [uid])
    }
    // REC_PUBLIC revision touching STATUS + SALARY + HIDDEN.
    await q(
      `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, patch, snapshot, batch_id)
       VALUES (gen_random_uuid(), $1, $2, 2, 'update', 'rest', $3, ARRAY[$4,$5,$6]::text[], '{}'::jsonb, $7::jsonb, $8)`,
      [SHEET_ID, REC_PUBLIC, ISSUER, STATUS, SALARY, HIDDEN, JSON.stringify({ [STATUS]: 'public', [SALARY]: 99999, [HIDDEN]: 7 }), FIELD_BATCH],
    )
    // REC_SECRET revision (row-deny target).
    await q(
      `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, patch, snapshot, batch_id)
       VALUES (gen_random_uuid(), $1, $2, 1, 'update', 'rest', $3, ARRAY[$4]::text[], '{}'::jsonb, $5::jsonb, $6)`,
      [SHEET_ID, REC_SECRET, ISSUER, STATUS, JSON.stringify({ [STATUS]: 'secret' }), SECRET_BATCH],
    )
    // Baseline: field_permissions denies SALARY to the VIEWER (this is what reveal lifts).
    await q(
      `INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,'user',$3,false,false)`,
      [SHEET_ID, SALARY, VIEWER],
    )
  })

  afterAll(async () => {
    for (const t of ['meta_history_audit_grants', 'field_permissions', 'meta_record_revisions', 'meta_records', 'meta_fields']) {
      await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET_ID]).catch(() => {})
    }
    await q("DELETE FROM operation_audit_logs WHERE action = 'history_field_audit.reveal' AND metadata->>'baseId' = $1", [BASE_ID]).catch(() => {})
    await q('DELETE FROM meta_history_audit_grants WHERE base_id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[VIEWER, ISSUER]]).catch(() => {})
  })

  beforeEach(async () => {
    curUser = VIEWER; curPerms = ['multitable:read', 'multitable:write']; curRoles = ['member']
    await clearGrants(); await setFlag(false); await setRules([])
    await q("DELETE FROM operation_audit_logs WHERE action = 'history_field_audit.reveal' AND metadata->>'baseId' = $1", [BASE_ID])
  })
  afterEach(async () => { await clearGrants() })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('LOCK-1 default: NO grant + ?reveal=1 → SALARY stays masked (= #2968)', async () => {
    const res = await events({ reveal: '1', reason: 'x' })
    expect(res.status).toBe(200)
    expect(batchOf(res, FIELD_BATCH)?.visibleAffectedFieldCount).toBe(1) // STATUS only — SALARY masked
  })

  test('D1: a valid grant WITHOUT the reveal flag → still masked (closed by default even for holders)', async () => {
    await grantToViewer(ISSUER)
    const res = await events()
    expect(batchOf(res, FIELD_BATCH)?.visibleAffectedFieldCount).toBe(1)
  })

  test('reveal: a valid grant + ?reveal=1 + reason → SALARY revealed (id + value + count)', async () => {
    await grantToViewer(ISSUER)
    const res = await events({ reveal: '1', reason: 'SOC2 audit' })
    expect(res.status).toBe(200)
    expect(batchOf(res, FIELD_BATCH)?.visibleAffectedFieldCount).toBe(2) // STATUS + SALARY
    const d = await detail(FIELD_BATCH, { reveal: '1', reason: 'SOC2 audit' })
    const change = (d.body?.data?.changes ?? []).find((c: { recordId: string }) => c.recordId === REC_PUBLIC) as
      | { changedFieldIds: string[]; after: Record<string, unknown> } | undefined
    expect(change?.changedFieldIds).toContain(SALARY)
    expect(change?.after?.[SALARY]).toBe(99999)
  })

  test('L8: ?reveal=1 without a reason → 400', async () => {
    await grantToViewer(ISSUER)
    expect((await events({ reveal: '1' })).status).toBe(400)
    expect((await detail(FIELD_BATCH, { reveal: '1' })).status).toBe(400)
    expect((await recordHistory({ reveal: '1' })).status).toBe(400)
  })

  test('LOCK-2a closure: a SELF-issued grant (granted_by === revealer) does NOT enable reveal', async () => {
    await grantToViewer(VIEWER) // self-issued
    const res = await events({ reveal: '1', reason: 'x' })
    expect(batchOf(res, FIELD_BATCH)?.visibleAffectedFieldCount).toBe(1) // masked — self-grant ignored
  })

  test('LOCK-3: an expired grant does NOT enable reveal', async () => {
    await grantToViewer(ISSUER, -1) // expired yesterday
    const res = await events({ reveal: '1', reason: 'x' })
    expect(batchOf(res, FIELD_BATCH)?.visibleAffectedFieldCount).toBe(1)
  })

  test('no admin bypass: an admin role WITHOUT a grant + ?reveal=1 → still masked', async () => {
    curRoles = ['admin'] // isAdminRole, but holds NO field-audit grant
    const res = await events({ reveal: '1', reason: 'x' })
    expect(batchOf(res, FIELD_BATCH)?.visibleAffectedFieldCount).toBe(1) // reveal needs a grant, not a role
  })

  test('LOCK-4: row-level deny STILL applies under reveal — a row-denied record stays invisible', async () => {
    await grantToViewer(ISSUER)
    await setRules(denySalaryRule); await setFlag(true) // deny status='secret' records
    const res = await events({ reveal: '1', reason: 'x' })
    expect(res.status).toBe(200)
    expect(batchIds(res)).toContain(FIELD_BATCH)
    expect(batchIds(res)).not.toContain(SECRET_BATCH) // reveal lifts the FIELD axis, never the ROW axis
  })

  test('reveal lifts ONLY field_permissions: a field-definition hidden field is NOT revealed', async () => {
    await grantToViewer(ISSUER)
    const d = await detail(FIELD_BATCH, { reveal: '1', reason: 'x' })
    const change = (d.body?.data?.changes ?? []).find((c: { recordId: string }) => c.recordId === REC_PUBLIC) as
      | { changedFieldIds: string[]; after: Record<string, unknown> } | undefined
    expect(change?.changedFieldIds).toContain(SALARY) // field_permissions lifted
    expect(change?.changedFieldIds).not.toContain(HIDDEN) // field-definition hidden NOT lifted
    expect(change?.after?.[HIDDEN]).toBeUndefined()
  })

  test('LOCK-5: a reveal writes ONE audit record (actor/base/reason, no values)', async () => {
    await grantToViewer(ISSUER)
    await events({ reveal: '1', reason: 'incident-42' })
    const rows = await revealAudits()
    expect(rows.length).toBe(1)
    expect(rows[0].actor_id).toBe(VIEWER)
    expect(rows[0].metadata.reason).toBe('incident-42')
    const keys = Object.keys(rows[0].metadata)
    expect(keys).not.toContain('value'); expect(keys).not.toContain('after'); expect(keys).not.toContain('snapshot')
  })

  test('LOCK-5 read-side: if the reveal-audit write fails, the response DEGRADES to masked (never unaudited reveal)', async () => {
    await grantToViewer(ISSUER)
    await q('DROP TRIGGER IF EXISTS _rev_fail_audit_trg ON operation_audit_logs', [])
    await q(`CREATE OR REPLACE FUNCTION _rev_fail_audit() RETURNS trigger AS $f$ BEGIN RAISE EXCEPTION 'forced'; END; $f$ LANGUAGE plpgsql`, [])
    await q('CREATE TRIGGER _rev_fail_audit_trg BEFORE INSERT ON operation_audit_logs FOR EACH ROW EXECUTE FUNCTION _rev_fail_audit()', [])
    try {
      const res = await events({ reveal: '1', reason: 'x' })
      expect(res.status).toBe(200)
      expect(batchOf(res, FIELD_BATCH)?.visibleAffectedFieldCount).toBe(1) // audit failed → masked, not revealed
    } finally {
      await q('DROP TRIGGER IF EXISTS _rev_fail_audit_trg ON operation_audit_logs', []).catch(() => {})
      await q('DROP FUNCTION IF EXISTS _rev_fail_audit()', []).catch(() => {})
    }
  })

  test('per-record surface: reveal lifts the field mask there too (parity)', async () => {
    const masked = await recordHistory()
    const mItem = (masked.body?.data?.items ?? []).find((it: { changedFieldIds: string[] }) => it.changedFieldIds.includes(STATUS)) as
      | { changedFieldIds: string[] } | undefined
    expect(mItem?.changedFieldIds).not.toContain(SALARY) // masked by default
    await grantToViewer(ISSUER)
    const revealed = await recordHistory({ reveal: '1', reason: 'x' })
    const rItem = (revealed.body?.data?.items ?? []).find((it: { changedFieldIds: string[] }) => it.changedFieldIds.includes(STATUS)) as
      | { changedFieldIds: string[] } | undefined
    expect(rItem?.changedFieldIds).toContain(SALARY) // revealed
  })
})
