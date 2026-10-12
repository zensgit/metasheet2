import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { Pool } from 'pg'
import type { MetaSheetServer } from '../../src/index'
import { snapshotAttendanceSettingsRow, restoreAttendanceSettingsRow } from './attendance-settings-row'

const requireCjs = createRequire(import.meta.url)
export const punchClock = requireCjs('../../../../plugins/plugin-attendance/lib/attendance-online-punch-clock.cjs') as {
  setOnlinePunchInstantForTests(value: string | null): void
}
export const punchPlugin = requireCjs('../../../../plugins/plugin-attendance/index.cjs') as {
  resetAttendanceSettingsCacheForTests(): void
  __setAttendanceW4LivePunchPreBoundarySeamForTests(value: ((args: unknown) => Promise<void>) | null): void
}
export function createOnlinePunchDbFixture() {
  const url = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
  if (!url) throw new Error('ONLINE_PUNCH_REAL_DATABASE_REQUIRED')
  const pool = new Pool({ connectionString: url })
  const orgId = randomUUID()
  let server: MetaSheetServer | undefined
  let base = ''
  let settings: Awaited<ReturnType<typeof snapshotAttendanceSettingsRow>> | undefined
  const users: string[] = []
  const roles: string[] = []
  const priorEnv = { RBAC_BYPASS: process.env.RBAC_BYPASS, RBAC_TOKEN_TRUST: process.env.RBAC_TOKEN_TRUST, SKIP_PLUGINS: process.env.SKIP_PLUGINS }
  async function request(route: string, token?: string, body?: Record<string, unknown>, method = 'POST') {
    const response = await fetch(base + route, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const raw = await response.text()
    return { status: response.status, body: JSON.parse(raw), raw }
  }
  async function user(admin = true) {
    const userId = randomUUID()
    users.push(userId)
    await pool.query(`INSERT INTO users (id,email,username,name,password_hash,role,permissions,is_active,is_admin)
      VALUES ($1,$2,$1,'online clock fixture','disabled','user','[]'::jsonb,true,$3)`, [userId, `${userId}@online-clock.test`, admin])
    await pool.query("INSERT INTO user_permissions (user_id,permission_code) SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING", [userId,admin ? ['attendance:read','attendance:write','attendance:admin','attendance:approve'] : ['attendance:read']])
    if (!admin) {
      const roleId = `online_clock_reader_${randomUUID()}`
      roles.push(roleId)
      await pool.query('INSERT INTO roles (id,name) VALUES ($1,$2)',[roleId,'online clock reader'])
      await pool.query("INSERT INTO role_permissions (role_id,permission_code) VALUES ($1,'attendance:read')",[roleId])
      await pool.query('INSERT INTO user_roles (user_id,role_id) VALUES ($1,$2)',[userId,roleId])
      await pool.query("INSERT INTO user_namespace_admissions (user_id,namespace,enabled,source) VALUES ($1,'attendance',true,'test_fixture')",[userId])
    }
    await pool.query('INSERT INTO user_orgs (user_id,org_id,is_active) VALUES ($1,$2,true)', [userId, orgId])
    const minted = await request(`/api/auth/dev-token?userId=${userId}&tenantId=${orgId}&roles=viewer&perms=attendance:read,attendance:write,attendance:admin`, undefined, undefined, 'GET')
    if (minted.status !== 200 || typeof minted.body.token !== 'string') throw new Error('ONLINE_PUNCH_TOKEN_FIXTURE_FAILED')
    return { userId, token: minted.body.token as string }
  }
  async function start() {
    process.env.RBAC_BYPASS = 'false'; process.env.RBAC_TOKEN_TRUST = 'false'; process.env.SKIP_PLUGINS = 'false'
    settings = await snapshotAttendanceSettingsRow(pool)
    const { MetaSheetServer: Server } = await import('../../src/index')
    server = new Server({ port: 0, host: '127.0.0.1', pluginDirs: [path.resolve(__dirname, '../../../../plugins/plugin-attendance')] })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('ONLINE_PUNCH_LOOPBACK_REQUIRED')
    base = `http://127.0.0.1:${address.port}`
    const admin = await user()
    const response = await request('/api/attendance/rules/default', admin.token, { orgId, timezone: 'UTC', workStartTime: '09:00', workEndTime: '18:00', workingDays: [0,1,2,3,4,5,6] }, 'PUT')
    if (response.status !== 200) throw new Error('ONLINE_PUNCH_RULE_FIXTURE_FAILED_'+response.status+'_'+response.body?.error?.code)
    return admin
  }
  async function configure(token: string, value: Record<string, unknown>) {
    const response = await request('/api/attendance/settings', token, value, 'PUT')
    if (response.status !== 200) throw new Error('ONLINE_PUNCH_SETTINGS_FIXTURE_FAILED')
    return response
  }
  async function counts(userId: string) {
    const result = await pool.query(`SELECT
      (SELECT count(*)::int FROM attendance_events WHERE user_id=$1) AS events,
      (SELECT count(*)::int FROM attendance_records WHERE user_id=$1) AS records,
      (SELECT count(*)::int FROM attendance_requests WHERE user_id=$1) AS requests,
      (SELECT count(*)::int FROM attendance_result_operations WHERE actor_id=$1) AS operations`, [userId])
    return result.rows[0]
  }
  async function stop() {
    punchClock.setOnlinePunchInstantForTests(null)
    punchPlugin.__setAttendanceW4LivePunchPreBoundarySeamForTests(null)
    await restoreAttendanceSettingsRow(pool, settings)
    punchPlugin.resetAttendanceSettingsCacheForTests()
    await server?.stop()
    // These suites share CI's database with the annual accrual scheduler. Remove
    // only this fixture's mutable configuration and identities. Canonical audit
    // rows remain append-only; the isolated database owner removes them by drop.
    for (const table of [
      'attendance_approval_flows', 'attendance_leave_types', 'attendance_rules',
    ]) await pool.query(`DELETE FROM ${table} WHERE org_id=$1`, [orgId])
    for (const table of ['user_permissions', 'user_roles', 'user_namespace_admissions', 'user_orgs']) {
      await pool.query(`DELETE FROM ${table} WHERE user_id::text=ANY($1::text[])`, [users])
    }
    await pool.query('DELETE FROM role_permissions WHERE role_id=ANY($1::text[])', [roles])
    await pool.query('DELETE FROM roles WHERE id=ANY($1::text[])', [roles])
    await pool.query('DELETE FROM users WHERE id::text=ANY($1::text[])', [users])
    const residue = await pool.query(`SELECT
      (SELECT count(*)::int FROM attendance_rules WHERE org_id=$1) AS rules,
      (SELECT count(*)::int FROM users WHERE id::text=ANY($2::text[])) AS users`, [orgId, users])
    if (residue.rows[0].rules !== 0 || residue.rows[0].users !== 0) throw new Error('ONLINE_PUNCH_FIXTURE_RESIDUE')
    await pool.end()
    for (const [key,value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
  return { pool, orgId, start, stop, user, request, configure, counts }
}
