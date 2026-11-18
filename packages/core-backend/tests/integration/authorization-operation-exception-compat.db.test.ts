import { randomUUID } from 'node:crypto'
import express from 'express'
import { Client } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const rawUrl = process.env.PERMISSION_COMMAND_COMPAT_DATABASE_URL
if (rawUrl) {
  const url = new URL(rawUrl)
  if (!['127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/permission_command_compat_test' || url.search || url.hash) {
    throw new Error('Dedicated migrated compatibility fixture required')
  }
}

describe.skipIf(!rawUrl)('legacy permission HTTP paths use the locked exception writer', () => {
  const actor = randomUUID(), target = randomUUID(), missing = randomUUID()
  const code = 'attendance:import'
  let client: Client
  let app: express.Express
  let token: string
  let closePool: () => Promise<void>

  beforeAll(async () => {
    client = new Client({ connectionString: rawUrl })
    await client.connect()
    await client.query(`INSERT INTO users (id, email, name, password_hash, role, is_admin)
      VALUES ($1, $2, 'Synthetic actor', 'synthetic', 'admin', true),
             ($3, $4, 'Synthetic target', 'synthetic', 'user', false)`,
    [actor, `${actor}@invalid.test`, target, `${target}@invalid.test`])
    process.env.DATABASE_URL = rawUrl
    process.env.JWT_SECRET = 'exception-compat-synthetic-only-secret'
    process.env.PRODUCT_MODE = 'plm-workbench'
    process.env.RBAC_BYPASS = 'false'
    process.env.RBAC_TOKEN_TRUST = 'false'
    process.env.DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED = 'false'
    const [{ permissionsRouter }, { authService }, { poolManager }] = await Promise.all([
      import('../../src/routes/permissions'), import('../../src/auth/AuthService'), import('../../src/integration/db/connection-pool'),
    ])
    app = express()
    app.use(express.json(), permissionsRouter())
    token = authService.createToken({ id: actor, email: `${actor}@invalid.test`, role: 'user', name: 'Synthetic actor', permissions: [], created_at: new Date(), updated_at: new Date() })
    closePool = () => poolManager.close()
  })

  beforeEach(async () => {
    await client.query('DELETE FROM authorization_operation_audit WHERE actor_id=$1', [actor])
    await client.query('DELETE FROM authorization_operation_receipts WHERE actor_id=$1', [actor])
    await client.query('DELETE FROM user_permissions WHERE user_id=$1', [target])
    await client.query("UPDATE users SET permissions='[\"attendance:import\"]'::jsonb WHERE id=$1", [target])
    await client.query("INSERT INTO user_roles(user_id,role_id) VALUES ($1,'admin') ON CONFLICT DO NOTHING", [actor])
  })

  afterAll(async () => {
    await closePool?.()
    if (!client) return
    await client.query('DELETE FROM authorization_operation_audit WHERE actor_id=$1', [actor])
    await client.query('DELETE FROM authorization_operation_receipts WHERE actor_id=$1', [actor])
    await client.query('DELETE FROM users WHERE id=ANY($1::text[])', [[actor, target]])
    await client.end()
  })

  const post = (path: string, body: object) => request(app).post(path).auth(token, { type: 'bearer' }).send(body)
  const audits = async () => (await client.query(`SELECT a.actor_id, a.reason, a.reason_origin, r.action, r.request_digest
    FROM authorization_operation_audit a JOIN authorization_operation_receipts r USING (actor_id, client_operation_id)
    WHERE a.actor_id=$1 ORDER BY a.created_at, a.client_operation_id`, [actor])).rows

  it('accepts old requests, stores the text actor and reason, and emits no duplicate grant event', async () => {
    const opts = { userId: target, permission: code }
    expect((await post('/api/permissions/grant', opts)).body).toMatchObject({ success: true, ...opts })
    expect((await post('/api/permissions/grant', opts)).status).toBe(200)
    expect(await audits()).toEqual([expect.objectContaining({ actor_id: actor, reason: null, reason_origin: 'legacy_unprovided', request_digest: 'legacy' })])
    expect((await post('/api/permissions/revoke', { ...opts, reason: '  Cleanup  ' })).status).toBe(200)
    expect((await post('/api/permissions/revoke', opts)).status).toBe(404)
    expect(await audits()).toHaveLength(2)
    expect(await audits()).toContainEqual(expect.objectContaining({ reason: 'Cleanup', reason_origin: 'provided' }))
    expect((await client.query('SELECT permissions FROM users WHERE id=$1', [target])).rows[0].permissions).toEqual([code])
    expect((await post('/api/permissions/legacy/revoke', opts)).status).toBe(200)
    expect((await client.query('SELECT permissions FROM users WHERE id=$1', [target])).rows[0].permissions).toEqual([])
    expect(await audits()).toHaveLength(3)
  })

  it('applies templates in the same transaction and leaves roles and admission alone', async () => {
    const response = await post('/api/admin/permission-templates/apply', { userId: target, templateId: 'attendance-admin' })
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(response.body.success).toBe(true)
    expect((await client.query('SELECT permission_code FROM user_permissions WHERE user_id=$1', [target])).rows.map(r => r.permission_code)).toContain(code)
    expect((await client.query('SELECT role_id FROM user_roles WHERE user_id=$1', [target])).rows).toEqual([])
    expect((await client.query('SELECT namespace FROM user_namespace_admissions WHERE user_id=$1', [target])).rows).toEqual([])
    expect(await audits()).toEqual([expect.objectContaining({ reason_origin: 'legacy_unprovided' })])
  })

  it('checks live RBAC authority for every compatibility entry and conceals target existence', async () => {
    await client.query('DELETE FROM user_roles WHERE user_id=$1', [actor])
    for (const [path, body] of [
      ['/api/permissions/grant', { permission: code }],
      ['/api/permissions/revoke', { permission: code }],
      ['/api/permissions/legacy/revoke', { permission: code }],
      ['/api/admin/permission-templates/apply', { templateId: 'attendance-admin' }],
    ] as const) {
      const existing = await post(path, { ...body, userId: target })
      const unknown = await post(path, { ...body, userId: missing })
      expect(existing.status).toBe(403)
      expect(unknown.status).toBe(403)
      expect(existing.body).toEqual(unknown.body)
    }
    expect(await audits()).toEqual([])
  })

  it('rejects an old template request if the actor loses the RBAC role while the write waits', async () => {
    const blocker = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    await client.query('BEGIN')
    let settled: Promise<request.Response> | undefined
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`namespace-admission:${actor}`])
      settled = Promise.resolve(post('/api/admin/permission-templates/apply', { userId: target, templateId: 'attendance-admin' }))
      let observed = false
      for (let attempt = 0; attempt < 80 && !observed; attempt++) {
        const result = await client.query(`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))
        ) AS blocked`, [blocker])
        observed = result.rows[0]?.blocked === true
        if (!observed) await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(observed).toBe(true)
      await client.query('DELETE FROM user_roles WHERE user_id=$1', [actor])
      await client.query('COMMIT')
      expect((await settled).status).toBe(403)
      expect(await audits()).toEqual([])
      expect((await client.query('SELECT permission_code FROM user_permissions WHERE user_id=$1', [target])).rows).toEqual([])
    } finally {
      await client.query('ROLLBACK')
      await settled?.catch(() => undefined)
    }
  })

  it('rolls back template codes and receipt on a mandatory audit error', async () => {
    const name = `compat_audit_${randomUUID().replaceAll('-', '')}`
    await client.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic audit refusal'; END $$`)
    await client.query(`CREATE TRIGGER ${name} BEFORE INSERT ON authorization_operation_audit
      FOR EACH ROW EXECUTE FUNCTION ${name}()`)
    try {
      const denied = await post('/api/admin/permission-templates/apply', { userId: target, templateId: 'attendance-admin' })
      expect(denied.status).toBe(500)
      expect((await client.query('SELECT permission_code FROM user_permissions WHERE user_id=$1', [target])).rows).toEqual([])
      expect((await client.query('SELECT action FROM authorization_operation_receipts WHERE actor_id=$1', [actor])).rows).toEqual([])
    } finally {
      await client.query(`DROP TRIGGER ${name} ON authorization_operation_audit`)
      await client.query(`DROP FUNCTION ${name}()`)
    }
  })
})
