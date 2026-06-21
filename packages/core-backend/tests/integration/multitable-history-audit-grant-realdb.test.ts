/**
 * A1 — History Field-Audit Permission: LOCK-2 grant-governance goldens (real DB).
 *
 * Design-lock: docs/development/multitable-history-field-audit-permission-design-lock-20260620.md (#2973).
 * These pin the load-bearing LOCK-2 separation-of-duties contract for issuing/revoking the grant that A2 will
 * use to lift the history field mask:
 *   - the SOLE authority is the standalone platform capability `multitable:history-field-audit:grant`;
 *     base-admin (`multitable:admin`) and a coarse `admin` role are REJECTED (no isAdminRole bypass);
 *   - issuer != grantee (no self-grant); a grantee holds no capability so cannot re-issue / self-widen;
 *   - default-finite expiry (D5): issue without expiry → a finite window; standing must be explicit + marked;
 *   - issue AND revoke each write an `operation_audit_logs` record (LOCK-2c) carrying grant SCOPE, no values;
 *   - the A1/A2 seam: `resolveHistoryFieldAuditReveal()` returns no reveal (A1 does not touch the mask).
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
const BASE_ID = `base_hag_${TS}`
const ISSUER = `user_hag_issuer_${TS}` // holds the grant capability
const GRANTEE = `user_hag_grantee_${TS}` // receives a grant; holds NO capability
const ISSUER_ROLE = `role_hag_${TS}` // a role the ISSUER belongs to (indirect self-grant guardrail)
let issuerGroupId = '' // a member-group the ISSUER belongs to (uuid, captured in beforeAll)
const CAP = 'multitable:history-field-audit:grant'

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express

// Per-request identity, swapped per test via asUser().
let curUser: string | undefined = ISSUER
let curRoles: string[] = ['member']
let curPerms: string[] = [CAP]
const asUser = (id: string | undefined, perms: string[], roles: string[] = ['member']) => { curUser = id; curPerms = perms; curRoles = roles }

const issue = (body: Record<string, unknown>) =>
  request(app).post(`/api/multitable/bases/${BASE_ID}/history-audit-grants`).send(body)
const listGrants = () => request(app).get(`/api/multitable/bases/${BASE_ID}/history-audit-grants`)
const revoke = (grantId: string) => request(app).delete(`/api/multitable/bases/${BASE_ID}/history-audit-grants/${grantId}`)

type AuditRow = { actor_id: string; action: string; metadata: Record<string, unknown> }
const auditRows = async (action: string): Promise<AuditRow[]> =>
  (await q(
    `SELECT actor_id, action, metadata FROM operation_audit_logs
     WHERE resource_type = 'meta_history_audit_grant' AND action = $1 AND metadata->>'baseId' = $2
     ORDER BY created_at ASC`,
    [action, BASE_ID],
  )).rows as AuditRow[]

describeIfDatabase('history field-audit grant — A1 LOCK-2 governance goldens (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = curUser ? { id: curUser, roles: curRoles, perms: curPerms } : undefined
      next()
    })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [BASE_ID, 'HAG Base'])
    for (const uid of [ISSUER, GRANTEE]) {
      await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [uid])
    }
    // The ISSUER belongs to a role + a member-group, to exercise the indirect self-grant guardrail.
    await q('INSERT INTO roles (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [ISSUER_ROLE, 'HAG Auditors'])
    await q('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ISSUER, ISSUER_ROLE])
    const grp = await q('INSERT INTO platform_member_groups (name) VALUES ($1) RETURNING id', ['HAG Group'])
    issuerGroupId = String((grp.rows[0] as { id: unknown }).id)
    await q('INSERT INTO platform_member_group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [issuerGroupId, ISSUER])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_history_audit_grants WHERE base_id = $1', [BASE_ID]).catch(() => {})
    await q("DELETE FROM operation_audit_logs WHERE resource_type = 'meta_history_audit_grant' AND metadata->>'baseId' = $1", [BASE_ID]).catch(() => {})
    await q('DELETE FROM user_roles WHERE role_id = $1', [ISSUER_ROLE]).catch(() => {})
    await q('DELETE FROM roles WHERE id = $1', [ISSUER_ROLE]).catch(() => {})
    if (issuerGroupId) {
      await q('DELETE FROM platform_member_group_members WHERE group_id::text = $1', [issuerGroupId]).catch(() => {})
      await q('DELETE FROM platform_member_groups WHERE id::text = $1', [issuerGroupId]).catch(() => {})
    }
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[ISSUER, GRANTEE]]).catch(() => {})
  })

  beforeEach(() => { asUser(ISSUER, [CAP], ['member']) })
  afterEach(async () => {
    await q('DELETE FROM meta_history_audit_grants WHERE base_id = $1', [BASE_ID]).catch(() => {})
    await q("DELETE FROM operation_audit_logs WHERE resource_type = 'meta_history_audit_grant' AND metadata->>'baseId' = $1", [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('LOCK-2 authority: base-admin (multitable:admin, no grant cap) is REJECTED from issuing', async () => {
    asUser('user_baseadmin', ['multitable:admin', 'multitable:read', 'multitable:write'], ['member'])
    const res = await issue({ subjectType: 'user', subjectId: GRANTEE })
    expect(res.status).toBe(403)
  })

  test('LOCK-2 authority: a coarse admin ROLE (no grant cap) is REJECTED (no isAdminRole bypass)', async () => {
    asUser('user_admin_role', ['multitable:read'], ['admin'])
    const res = await issue({ subjectType: 'user', subjectId: GRANTEE })
    expect(res.status).toBe(403)
  })

  test('LOCK-2 authority: a holder of the grant capability CAN issue', async () => {
    const res = await issue({ subjectType: 'user', subjectId: GRANTEE, reason: 'SOC2 review' })
    expect(res.status).toBe(201)
    expect(res.body?.data?.subjectId).toBe(GRANTEE)
    expect(res.body?.data?.grantedBy).toBe(ISSUER)
  })

  test('LOCK-2a: issuer cannot grant to themselves (SELF_GRANT 403)', async () => {
    const res = await issue({ subjectType: 'user', subjectId: ISSUER })
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('SELF_GRANT')
  })

  test('LOCK-2 (no self-widen): a grantee holds no capability, so cannot re-issue', async () => {
    // issue a grant to GRANTEE first (as the authorised issuer)
    expect((await issue({ subjectType: 'user', subjectId: GRANTEE })).status).toBe(201)
    // now act AS the grantee (their token has no grant cap) → cannot widen by re-issuing
    asUser(GRANTEE, ['multitable:read', 'multitable:write'], ['member'])
    const res = await issue({ subjectType: 'user', subjectId: 'someone_else' })
    expect(res.status).toBe(403)
  })

  test('D5 default-finite: issuing without expiry applies a finite window (not standing)', async () => {
    const res = await issue({ subjectType: 'user', subjectId: GRANTEE })
    expect(res.status).toBe(201)
    expect(res.body?.data?.isStanding).toBe(false)
    const exp = Date.parse(res.body?.data?.expiresAt)
    expect(Number.isFinite(exp)).toBe(true)
    expect(exp).toBeGreaterThan(Date.now() + 80 * 24 * 3600 * 1000) // ~90d window, generously bounded
    expect(exp).toBeLessThan(Date.now() + 100 * 24 * 3600 * 1000)
  })

  test('D5 standing must be explicit + is marked (no implicit unbounded grant)', async () => {
    const res = await issue({ subjectType: 'user', subjectId: GRANTEE, standing: true })
    expect(res.status).toBe(201)
    expect(res.body?.data?.isStanding).toBe(true)
    expect(res.body?.data?.expiresAt).toBeNull()
  })

  test('LOCK-2c: issuing writes an audit record with actor + scope, and NO field values', async () => {
    const res = await issue({ subjectType: 'user', subjectId: GRANTEE, reason: 'incident-123' })
    expect(res.status).toBe(201)
    const rows = await auditRows('history_field_audit_grant.issue')
    expect(rows.length).toBe(1)
    expect(rows[0].actor_id).toBe(ISSUER)
    expect(rows[0].metadata.subjectId).toBe(GRANTEE)
    expect(rows[0].metadata.reason).toBe('incident-123')
    // LOCK-5 shape: grant audit carries scope only — never any record field value snapshot.
    const keys = Object.keys(rows[0].metadata)
    expect(keys).not.toContain('value')
    expect(keys).not.toContain('values')
    expect(keys).not.toContain('snapshot')
    expect(keys).not.toContain('after')
  })

  test('LOCK-2c: revoke soft-deletes, writes an audit record, and drops the grant from the active list', async () => {
    const created = await issue({ subjectType: 'user', subjectId: GRANTEE })
    const grantId = created.body?.data?.id as string
    expect((await listGrants()).body?.data?.grants?.length).toBe(1)
    const rev = await revoke(grantId)
    expect(rev.status).toBe(200)
    expect((await listGrants()).body?.data?.grants?.length).toBe(0) // active list excludes revoked
    expect((await auditRows('history_field_audit_grant.revoke')).length).toBe(1)
    // revoking an already-revoked / unknown grant → 404 (same shape)
    expect((await revoke(grantId)).status).toBe(404)
  })

  // ----- A1 hardening (owner review): atomicity + indirect self-grant guardrail -----

  test('LOCK-2a indirect (guardrail): issuer cannot grant to a ROLE they belong to', async () => {
    const res = await issue({ subjectType: 'role', subjectId: ISSUER_ROLE })
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('SELF_GRANT')
  })

  test('LOCK-2a indirect (guardrail): issuer cannot grant to a MEMBER-GROUP they belong to', async () => {
    const res = await issue({ subjectType: 'member-group', subjectId: issuerGroupId })
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('SELF_GRANT')
  })

  test('LOCK-2c atomicity: a failing issue-audit insert ROLLS BACK the grant (no grant without audit)', async () => {
    await q('DROP TRIGGER IF EXISTS _hag_fail_audit_trg ON operation_audit_logs', [])
    await q(`CREATE OR REPLACE FUNCTION _hag_fail_audit() RETURNS trigger AS $f$ BEGIN RAISE EXCEPTION 'forced audit failure'; END; $f$ LANGUAGE plpgsql`, [])
    await q('CREATE TRIGGER _hag_fail_audit_trg BEFORE INSERT ON operation_audit_logs FOR EACH ROW EXECUTE FUNCTION _hag_fail_audit()', [])
    try {
      const res = await issue({ subjectType: 'user', subjectId: GRANTEE, reason: 'will-roll-back' })
      expect(res.status).not.toBe(201) // audit insert raised → tx rolled back → error
      const rows = (await q('SELECT id FROM meta_history_audit_grants WHERE base_id = $1 AND subject_id = $2', [BASE_ID, GRANTEE])).rows
      expect(rows.length).toBe(0) // the grant must NOT exist — atomic rollback
    } finally {
      await q('DROP TRIGGER IF EXISTS _hag_fail_audit_trg ON operation_audit_logs', []).catch(() => {})
      await q('DROP FUNCTION IF EXISTS _hag_fail_audit()', []).catch(() => {})
    }
  })

  test('LOCK-2c atomicity: a failing revoke-audit insert ROLLS BACK the revoke (grant stays active)', async () => {
    const created = await issue({ subjectType: 'user', subjectId: GRANTEE }) // audit OK (no trigger yet)
    const grantId = created.body?.data?.id as string
    await q('DROP TRIGGER IF EXISTS _hag_fail_audit_trg ON operation_audit_logs', [])
    await q(`CREATE OR REPLACE FUNCTION _hag_fail_audit() RETURNS trigger AS $f$ BEGIN RAISE EXCEPTION 'forced audit failure'; END; $f$ LANGUAGE plpgsql`, [])
    await q('CREATE TRIGGER _hag_fail_audit_trg BEFORE INSERT ON operation_audit_logs FOR EACH ROW EXECUTE FUNCTION _hag_fail_audit()', [])
    try {
      const rev = await revoke(grantId)
      expect(rev.status).not.toBe(200)
      const rows = (await q('SELECT revoked_at FROM meta_history_audit_grants WHERE id = $1', [grantId])).rows as Array<{ revoked_at: unknown }>
      expect(rows.length).toBe(1)
      expect(rows[0].revoked_at).toBeNull() // still active — revoke rolled back
    } finally {
      await q('DROP TRIGGER IF EXISTS _hag_fail_audit_trg ON operation_audit_logs', []).catch(() => {})
      await q('DROP FUNCTION IF EXISTS _hag_fail_audit()', []).catch(() => {})
    }
  })

  test('unique-active survives the transaction: a duplicate active grant → 409, first grant intact', async () => {
    expect((await issue({ subjectType: 'user', subjectId: GRANTEE })).status).toBe(201)
    const dup = await issue({ subjectType: 'user', subjectId: GRANTEE })
    expect(dup.status).toBe(409)
    expect(dup.body?.error?.code).toBe('GRANT_EXISTS')
    expect((await listGrants()).body?.data?.grants?.length).toBe(1) // the rolled-back 2nd tx didn't disturb the 1st
  })
})
