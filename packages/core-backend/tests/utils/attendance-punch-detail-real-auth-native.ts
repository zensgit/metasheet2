import { registerPunchCommitQueueStartupNativeCases } from './attendance-punch-commit-queue-startup-native'
import { registerPunchQueueStartupNativeCases } from './attendance-punch-queue-startup-native'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { expect, it } from 'vitest'
import type { Pool } from 'pg'
import { EP01_DST_READY_CASES } from './attendance-ep01-dst-ready-callers'

type Reply = { status: number; body: unknown }
type Request = (url: string, options?: {
  method?: string; headers?: Record<string, string>; body?: Record<string, unknown>
}) => Promise<Reply>
type Body = {
  token?: string
  error?: { code?: string }
  data?: { token?: string; commitToken?: string; job?: { id?: string }; [key: string]: unknown }
}
type Dependencies = {
  server(): unknown
  pool(): Pool
  baseUrl(): string
  seedDay(): Promise<{ orgId: string; userId: string }>
}
const bodyOf = (reply: Reply) => reply.body as Body
const scenario = EP01_DST_READY_CASES[0]

/** Real password login/session and production route policy; bypass is only used by seedDay. */
export function registerPunchDetailRealAuthNativeCases(deps: Dependencies, request: Request) {
  async function fixture(run: (f: {
    pool: Pool; orgId: string; userId: string
    login(orgId: string, fullImport: boolean): Promise<{ userId: string; roleId: string; token: string }>
    call(path: string, token?: string, body?: Record<string, unknown>): Promise<Reply>
    command: Record<string, unknown>
    effects(): Promise<unknown[]>
  }) => Promise<void>) {
    const prior = Object.fromEntries(['RBAC_BYPASS', 'RBAC_TOKEN_TRUST', 'ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED',
      'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED'].map(key => [key, process.env[key]]))
    const pool = deps.pool()
    const actors: Array<{ userId: string; roleId: string }> = []
    try {
      process.env.ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED = 'false'
      const day = await deps.seedDay()
      process.env.RBAC_BYPASS = 'false'
      process.env.RBAC_TOKEN_TRUST = 'false'
      const call = (path: string, token?: string, body?: Record<string, unknown>) =>
        request(deps.baseUrl() + path, { method: body === undefined ? 'GET' : 'POST',
          ...(token ? { headers: { Authorization: 'Bearer ' + token } } : {}), ...(body === undefined ? {} : { body }) })
      const login = async (orgId: string, fullImport: boolean) => {
        const userId = randomUUID()
        const roleId = 'punch-real-auth-' + userId
        actors.push({ userId, roleId })
        const password = randomUUID()
        await pool.query(`INSERT INTO users
          (id,email,username,name,password_hash,role,permissions,is_active,is_admin,
           activation_status,local_password_set,must_change_password)
          VALUES ($1,$2,$1,'synthetic punch auth',$3,'user','[]'::jsonb,true,false,'activated',true,false)`,
        [userId, userId + '@example.test', await bcrypt.hash(password, 4)])
        await pool.query('INSERT INTO user_orgs (user_id,org_id,is_active) VALUES ($1,$2,true)', [userId, orgId])
        await pool.query('INSERT INTO roles (id,name) VALUES ($1,$1)', [roleId])
        await pool.query('INSERT INTO role_permissions (role_id,permission_code) SELECT $1,unnest($2::text[])',
          [roleId, fullImport ? ['attendance:read', 'attendance:import'] : ['attendance:read']])
        await pool.query('INSERT INTO user_roles (user_id,role_id) VALUES ($1,$2)', [userId, roleId])
        await pool.query("INSERT INTO user_namespace_admissions (user_id,namespace,enabled) VALUES ($1,'attendance',true)", [userId])
        const response = await call('/api/auth/login', undefined, { identifier: userId + '@example.test', password })
        expect(response.status, 'PUNCH_REAL_PASSWORD_LOGIN').toBe(200)
        const token = bodyOf(response).token ?? bodyOf(response).data?.token
        if (typeof token !== 'string') throw new Error('PUNCH_REAL_LOGIN_TOKEN_REQUIRED')
        // Do not log the token, password or session identity.
        const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { sid?: string; tenantId?: string }
        expect(typeof claims.sid, 'PUNCH_REAL_SESSION_CLAIM').toBe('string')
        expect(claims.tenantId === orgId, 'PUNCH_REAL_SESSION_ORG').toBe(true)
        expect((await pool.query(`SELECT count(*)::int AS n FROM user_sessions
          WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now()`, [claims.sid, userId])).rows)
          .toEqual([{ n: 1 }])
        return { userId, roleId, token }
      }
      const command = { inputKind: 'punch_events_v1', orgId: day.orgId, userId: day.userId,
        workDate: scenario.workDate, timezone: scenario.timezone, mode: 'override',
        idempotencyKey: 'real-auth-' + randomUUID(), previewLimit: 2,
        punches: scenario.punches.map(([direction, occurredAt]) => ({ direction, occurredAt })) }
      const effects = async () => {
        const rows: unknown[] = []
        for (const table of ['attendance_records', 'attendance_record_calculations', 'attendance_record_segments',
          'attendance_import_batches', 'attendance_import_items', 'attendance_result_operations', 'attendance_result_event_outbox']) {
          rows.push((await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE org_id=$1 ORDER BY to_jsonb(t)::text`, [day.orgId])).rows)
        }
        return rows
      }
      await run({ pool, ...day, login, call, command, effects })
    } finally {
      for (const actor of actors) {
        await pool.query('DELETE FROM attendance_scheduler_scopes WHERE subject_type=$1 AND subject_ref=$2', ['user', actor.userId])
        await pool.query('UPDATE user_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [actor.userId])
        await pool.query('DELETE FROM attendance_import_tokens WHERE user_id=$1', [actor.userId])
        await pool.query('DELETE FROM user_namespace_admissions WHERE user_id=$1', [actor.userId])
        await pool.query('DELETE FROM user_roles WHERE user_id=$1 AND role_id=$2', [actor.userId, actor.roleId])
        await pool.query('DELETE FROM role_permissions WHERE role_id=$1', [actor.roleId])
        await pool.query('DELETE FROM roles WHERE id=$1', [actor.roleId])
      }
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }

  it('PUNCH_DETAIL_REAL_AUTH_SCOPED: real session preserves scoped sync preview and original async denial', async () => {
    await fixture(async f => {
      const actor = await f.login(f.orgId, false)
      const before = await f.effects()
      const preview = (command = f.command) => f.call('/api/attendance/import/preview', actor.token, command)
      const grants = async () => (await f.pool.query(`SELECT permission_code FROM user_permissions WHERE user_id=$1
        AND permission_code IN ('attendance:admin','attendance:import')
        UNION ALL SELECT rp.permission_code FROM role_permissions rp JOIN user_roles ur ON ur.role_id=rp.role_id
        WHERE ur.user_id=$1 AND rp.permission_code IN ('attendance:admin','attendance:import')`, [actor.userId])).rows
      expect(await grants()).toEqual([])
      const noScope = await preview()
      expect(noScope.status, 'PUNCH_REAL_NO_SCOPE').toBe(403)
      expect(bodyOf(noScope).error?.code).toBe('SCHEDULER_SCOPE_FORBIDDEN')
      const scopeId = randomUUID()
      await f.pool.query(`INSERT INTO attendance_scheduler_scopes
        (id,org_id,subject_type,subject_ref,actions,scope,is_active,created_by,updated_by)
        VALUES ($1,$2,'user',$3,ARRAY['import']::text[],$4::jsonb,true,'integration-test','integration-test')`,
      [scopeId, f.orgId, actor.userId, JSON.stringify({ userIds: [f.userId] })])
      const prepared = await f.call('/api/attendance/import/prepare', actor.token, {})
      expect(prepared.status).toBe(200)
      const success = await preview({ ...f.command, commitToken: bodyOf(prepared).data?.commitToken })
      expect(success.status, 'PUNCH_REAL_SCOPED_SYNC;code=' + bodyOf(success).error?.code).toBe(200)
      expect(bodyOf(success).data).toMatchObject({ inputKind: 'punch_events_v1', eventCount: 4, targetCount: 1,
        total: 4, processedRows: 4, failedRows: 0, previewLimit: 2, truncated: true,
        targets: [{ userId: f.userId, workDate: scenario.workDate, outcome: 'completed',
          dailyProjection: { workedMinutes: 165 } }] })
      expect(bodyOf(success).data?.items).toEqual(scenario.punches.slice(0, 2)
        .map(([direction, occurredAt], sourceOrdinal) => ({ direction, occurredAt, sourceOrdinal })))
      const outside = await preview({ ...f.command, userId: actor.userId })
      expect(outside.status, 'PUNCH_REAL_TARGET_SCOPE').toBe(403)
      expect(bodyOf(outside).error?.code).toBe('SCHEDULER_SCOPE_FORBIDDEN')
      const asyncDenied = await f.call('/api/attendance/import/preview-async', actor.token, f.command)
      expect(asyncDenied.status, 'PUNCH_REAL_ORIGINAL_ASYNC_GATE').toBe(403)
      expect(asyncDenied.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } })
      await f.pool.query('UPDATE attendance_scheduler_scopes SET is_active=false WHERE id=$1', [scopeId])
      const revoked = await preview()
      expect(revoked.status, 'PUNCH_REAL_SCOPE_REVOKED_WITH_SAME_JWT').toBe(403)
      expect(bodyOf(revoked).error?.code).toBe('SCHEDULER_SCOPE_FORBIDDEN')
      expect(await grants()).toEqual([])
      expect(await f.effects()).toEqual(before)
      console.log('PUNCH_DETAIL_REAL_AUTH_SCOPED_RECEIPT ' + JSON.stringify({ passwordLogin: true, persistedSession: true,
        authBypass: false, tokenTrust: false, scopedSync: 200, originalAsync: 403, scopeRevokedSameJwt: 403,
        unchangedBusinessTables: 7, globalImportGrants: 0 }))
    })
  }, 120000)

  it('PUNCH_DETAIL_REAL_AUTH_FULL: current permission namespace subject and session gates protect durable preview', async () => {
    await fixture(async f => {
      const actor = await f.login(f.orgId, true)
      const foreign = await f.login(randomUUID(), true)
      const before = await f.effects()
      const prepared = await f.call('/api/attendance/import/prepare', actor.token, {})
      expect(prepared.status).toBe(200)
      const submitted = await f.call('/api/attendance/import/preview-async', actor.token,
        { ...f.command, commitToken: bodyOf(prepared).data?.commitToken })
      expect(submitted.status, 'PUNCH_REAL_FULL_SUBMIT;code=' + bodyOf(submitted).error?.code).toBe(200)
      const jobId = bodyOf(submitted).data?.job?.id
      if (typeof jobId !== 'string') throw new Error('PUNCH_REAL_JOB_REQUIRED')
      let status: string | undefined
      for (let attempt = 0; attempt < 100; attempt += 1) {
        status = (await f.pool.query('SELECT status FROM attendance_import_jobs WHERE id=$1', [jobId])).rows[0]?.status
        if (status === 'completed' || status === 'failed') break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      expect(status, 'PUNCH_REAL_NATIVE_WORKER_COMPLETED').toBe('completed')
      const read = (token = actor.token) => f.call('/api/attendance/import/jobs/' + jobId, token)
      const success = await read()
      expect(success.status).toBe(200)
      expect(bodyOf(success).data).toMatchObject({ id: jobId, kind: 'preview', status: 'completed',
        preview: { eventCount: 4, targets: [{ dailyProjection: { workedMinutes: 165 } }] } })
      const durable = async () => (await f.pool.query(`SELECT to_jsonb(j) AS job,to_jsonb(r) AS record
        FROM attendance_import_jobs j JOIN attendance_import_punch_preview_records r ON r.job_id=j.id WHERE j.id=$1`, [jobId])).rows
      const frozen = await durable()
      const alien = await read(foreign.token)
      expect(alien.status, 'PUNCH_REAL_FOREIGN_ORG').toBe(404)
      expect(alien.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'Import job not found' } })
      await f.pool.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='attendance:import'", [actor.roleId])
      const permissionDenied = await read()
      expect(permissionDenied.status, 'PUNCH_REAL_PERMISSION_REVOKED_SAME_JWT').toBe(403)
      expect(permissionDenied.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } })
      await f.pool.query("INSERT INTO role_permissions (role_id,permission_code) VALUES ($1,'attendance:import')", [actor.roleId])
      await f.pool.query("UPDATE user_namespace_admissions SET enabled=false WHERE user_id=$1 AND namespace='attendance'", [actor.userId])
      const namespaceDenied = await read()
      expect(namespaceDenied.status, 'PUNCH_REAL_NAMESPACE_REVOKED').toBe(403)
      expect(namespaceDenied.body).toEqual({ ok: false, error: {
        code: 'ATTENDANCE_WRITE_NOT_AUTHORIZED', message: 'ATTENDANCE_WRITE_NOT_AUTHORIZED' } })
      await f.pool.query("UPDATE user_namespace_admissions SET enabled=true WHERE user_id=$1 AND namespace='attendance'", [actor.userId])
      await f.pool.query('UPDATE user_orgs SET is_active=false WHERE user_id=$1 AND org_id=$2', [f.userId, f.orgId])
      const subjectDenied = await read()
      expect(subjectDenied.status, 'PUNCH_REAL_SUBJECT_MEMBERSHIP_REVOKED').toBe(403)
      expect(subjectDenied.body).toEqual({ ok: false, error: {
        code: 'ATTENDANCE_WRITE_NOT_AUTHORIZED', message: 'ATTENDANCE_WRITE_NOT_AUTHORIZED' } })
      await f.pool.query('UPDATE user_orgs SET is_active=true WHERE user_id=$1 AND org_id=$2', [f.userId, f.orgId])
      expect((await read()).body).toEqual(success.body)
      await f.pool.query('UPDATE user_sessions SET revoked_at=now() WHERE user_id=$1', [actor.userId])
      expect((await read()).status, 'PUNCH_REAL_SESSION_REVOKED').toBe(401)
      expect(await durable()).toEqual(frozen)
      expect(await f.effects()).toEqual(before)
      console.log('PUNCH_DETAIL_REAL_AUTH_FULL_RECEIPT ' + JSON.stringify({ passwordLogin: true, persistedSession: true,
        authBypass: false, tokenTrust: false, nativeWorker: 'completed', foreignOrg: 404,
        permissionRevoked: 403, namespaceRevoked: 403, subjectInactive: 403, sessionRevoked: 401,
        unchangedBusinessTables: 7, frozenJobUnchanged: true }))
    })
  }, 120000)
  registerPunchQueueStartupNativeCases(fixture, deps.server)
  registerPunchCommitQueueStartupNativeCases(fixture, deps.server)
}
