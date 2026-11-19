import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url = process.env.PERMISSION_COMMAND_TEST_DATABASE_URL
if (url) {
  const parsed = new URL(url)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.pathname !== '/permission_command_test') throw new Error('isolated loopback fixture required')
}
const suite = url ? describe : describe.skip
suite('unified administrator audit feed on PostgreSQL', () => {
  const schema = `audit_feed_${randomUUID().replaceAll('-', '')}`
  const control = new Client({ connectionString: url })
  let app: express.Express
  let token: (id: string) => string
  let closePool: () => Promise<void>
  const actor = 'actor-text-id', delegated = 'delegated-text-id', target = 'target-text-id'
  const op1 = randomUUID(), op2 = randomUUID()
  beforeAll(async () => {
    await control.connect()
    await control.query(`CREATE SCHEMA "${schema}"`)
    await control.query(`SET search_path TO "${schema}"`)
    await control.query(`
      CREATE TABLE users (id text PRIMARY KEY, name text, email text, username text, mobile text, role text, is_admin boolean, is_active boolean DEFAULT true, activation_status text DEFAULT 'activated', deleted_at timestamptz, purged_at timestamptz, permissions jsonb DEFAULT '[]', access_generation bigint DEFAULT 0, password_hash text, must_change_password boolean DEFAULT false, local_password_set boolean DEFAULT true, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
      CREATE TABLE user_roles (user_id text, role_id text, PRIMARY KEY(user_id,role_id));
      CREATE TABLE user_session_revocations (user_id text PRIMARY KEY, revoked_after timestamptz, updated_at timestamptz, updated_by text, reason text);
      CREATE TABLE user_sessions (id text, user_id text, revoked_at timestamptz);
      CREATE TABLE audit_logs (id bigint, created_at timestamptz, event_type text, event_category text, event_severity text, action text, resource_type text, resource_id text, user_id integer, user_name text, user_email text, action_details jsonb, error_code text);
      CREATE TABLE authorization_operation_receipts (actor_id text, client_operation_id uuid, request_digest text, target_user_id text, action jsonb, receipt jsonb, PRIMARY KEY(actor_id,client_operation_id));
      CREATE TABLE authorization_operation_audit (actor_id text, client_operation_id uuid, reason text, reason_origin text, impact jsonb, created_at timestamptz, PRIMARY KEY(actor_id,client_operation_id), FOREIGN KEY(actor_id,client_operation_id) REFERENCES authorization_operation_receipts(actor_id,client_operation_id));
      INSERT INTO users(id,name,email,role,is_admin) VALUES ('actor-text-id','operator','operator@example.test','user',false), ('delegated-text-id','delegate','delegate@example.test','user',false);
      INSERT INTO user_roles VALUES ('actor-text-id','admin'), ('delegated-text-id','attendance_admin');
      INSERT INTO audit_logs VALUES (1,'2026-01-01T00:00:00Z','UPDATE','SYSTEM','INFO','update','user','old-target',NULL,NULL,NULL,'{"adminUserId":"old-admin"}',NULL);
    `)
    await control.query(`INSERT INTO authorization_operation_receipts VALUES
      ($1,$2,'legacy',$3,$4::jsonb,'{}'), ($1,$5,'normal',$3,$6::jsonb,'{}')`, [actor, op1, target, JSON.stringify({ targetUserId: target, action: { kind: 'legacy.revoke', code: 'attendance:read' }, admissionChanges: [] }), op2, JSON.stringify({ targetUserId: target, action: { kind: 'direct.grant', code: 'attendance:write' }, admissionChanges: [] })])
    await control.query(`INSERT INTO authorization_operation_audit VALUES ($1,$2,NULL,'legacy_unprovided','{"changes":1}','2026-01-02T00:00:00Z'),($1,$3,'test','provided','{"changes":2}','2026-01-02T00:00:00Z')`, [actor, op1, op2])
    const dbUrl = new URL(url!)
    dbUrl.searchParams.set('options', `-c search_path=${schema}`)
    process.env.DATABASE_URL = dbUrl.toString()
    process.env.JWT_SECRET = 'synthetic-test-secret-for-audit-feed-only'
    process.env.RBAC_TOKEN_TRUST = 'false'; process.env.RBAC_BYPASS = 'false'; process.env.PRODUCT_MODE = 'plm-workbench'
    const [{ adminUsersRouter }, { authService }, { poolManager }] = await Promise.all([
      import('../../src/routes/admin-users'), import('../../src/auth/AuthService'), import('../../src/integration/db/connection-pool'),
    ])
    app = express(); app.use(express.json()); app.use(adminUsersRouter())
    token = (id: string) => authService.createToken({ id, email: `${id}@example.test`, name: 'synthetic', role: 'user', permissions: [], created_at: new Date(), updated_at: new Date() })
    closePool = () => poolManager.close()
  }, 60000)
  afterAll(async () => { if (closePool) await closePool(); await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await control.end() })
  const get = (path: string, id = actor) => request(app).get(path).auth(token(id), { type: 'bearer' })
  it('lists both sources once, with stable pagination, text actor and matching CSV filters', async () => {
    const list = await get('/api/admin/audit-activity?pageSize=1&page=1')
    expect(list.status).toBe(200); expect(list.body.data.total).toBe(3)
    const next = await get('/api/admin/audit-activity?pageSize=1&page=2')
    expect(next.body.data.items[0].source_id).not.toBe(list.body.data.items[0].source_id)
    const third = await get('/api/admin/audit-activity?pageSize=1&page=3')
    expect(third.body.data.items[0]).toMatchObject({ source: 'audit_logs', actor_id: 'old-admin' })
    const filter = '?q=actor-text-id&resourceType=legacy-permission&action=revoke&from=2026-01-02&to=2026-01-02'
    const selected = await get(`/api/admin/audit-activity${filter}`)
    expect(selected.status).toBe(200); expect(selected.body.data.total).toBe(1)
    expect(selected.body.data.items[0]).toMatchObject({ actor_id: actor, source: 'authorization_operation', resource_type: 'legacy-permission', action: 'revoke', action_details: { operationKind: 'legacy.revoke', reasonOrigin: 'legacy_unprovided' } })
    const csv = await get(`/api/admin/audit-activity/export.csv${filter}`)
    expect(csv.status).toBe(200); expect(csv.text).toContain('actor_id,source,source_id')
    expect(csv.text).toContain(actor); expect(csv.text).toContain(op1); expect(csv.text).not.toContain(op2)
    expect(csv.text.trim().split('\n')).toHaveLength(2)
  })
  it('denies delegated actor both global surfaces', async () => {
    expect((await get('/api/admin/audit-activity', delegated)).status).toBe(403)
    expect((await get('/api/admin/audit-activity/export.csv', delegated)).status).toBe(403)
  })
  it('does not mask a missing legacy relation as an optional new-table fallback', async () => {
    await control.query('ALTER TABLE audit_logs RENAME TO audit_logs_hidden')
    try {
      expect((await get('/api/admin/audit-activity')).status).toBe(500)
      expect((await get('/api/admin/audit-activity/export.csv')).status).toBe(500)
    } finally { await control.query('ALTER TABLE audit_logs_hidden RENAME TO audit_logs') }
  })
  it('preserves old audit rows when new relations are absent', async () => {
    await control.query('DROP TABLE authorization_operation_audit; DROP TABLE authorization_operation_receipts')
    const response = await get('/api/admin/audit-activity')
    expect(response.status).toBe(200); expect(response.body.data.total).toBe(1)
    expect(response.body.data.items[0].source).toBe('audit_logs')
    const csv = await get('/api/admin/audit-activity/export.csv')
    expect(csv.status).toBe(200); expect(csv.text).toContain('old-target')
  })
})
