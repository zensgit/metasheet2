#!/usr/bin/env node
// Rehearse the shipped soak SQL against an explicitly disposable local database.
// Requires migrations first; never invokes the staging runner or rollout CLIs.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(join(root, 'packages/core-backend/package.json'))
const { Pool } = require('pg')
const target = new URL(process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL || 'http://invalid')
if (process.env.NODE_ENV !== 'test' || target.protocol !== 'postgresql:'
  || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
  || !/^\/attendance_qa_[a-z0-9_]+$/.test(target.pathname)) {
  throw new Error('ATTENDANCE_FIXTURE_DISPOSABLE_LOCAL_DATABASE_REQUIRED')
}

process.env.DATABASE_URL = target.href
process.env.RBAC_BYPASS = 'false'
process.env.RBAC_TOKEN_TRUST = 'false'
process.env.SKIP_PLUGINS = 'false'
const pool = new Pool({ connectionString: target.href })
const orgId = randomUUID()
const prefix = `synth-w4w7-${randomUUID().slice(0, 8)}-u`
const vars: Record<string, string | number> = {
  org: orgId, user_prefix: prefix, user_count: 2, pw_hash: 'synthetic-disabled-password',
  shift_name: `fixture-${orgId}`, group_name: `fixture-${orgId}`,
  tz: 'Asia/Shanghai', start_date: '2049-06-01', end_date: '2049-06-14',
}
let server: { start(): Promise<void>; stop(): Promise<void>; getAddress(): { port: number } | null } | undefined
const counts = { seedPasses: 0, activeLeaveTypes: 0, activeOvertimeRules: 0, publishedManualSwapAssignments: 0, submittedLeave: 0, submittedOvertime: 0, submittedSwap: 0, cancelledRequests: 0 }
let stage = 'SEED'
try {
  const source = readFileSync(join(root, 'scripts/ops/attendance-staging-window-runner-remote.sh'), 'utf8')
  const start = source.indexOf('soak_seed_write_org_sql() {')
  const sqlStart = source.indexOf("<<'SQL'\n", start) + 8
  const sqlEnd = source.indexOf('\nSQL\n', sqlStart)
  if (start < 0 || sqlStart < 8 || sqlEnd < sqlStart) throw new Error('FIXTURE_SQL_NOT_FOUND')
  const sql = source.slice(sqlStart, sqlEnd).replace('\\set ON_ERROR_STOP on\n', '')
    .replace(/:'([a-z_]+)'|:user_count\b/g, (_match, quoted) => {
      const value = vars[quoted || 'user_count']
      if (value === undefined) throw new Error('FIXTURE_SQL_UNKNOWN_PARAMETER')
      return typeof value === 'number' ? String(value) : `'${value.replaceAll("'", "''")}'`
    })
  for (let i = 0; i < 2; i += 1) {
    await pool.query(sql)
    counts.seedPasses += 1
  }
  const users = (await pool.query('SELECT id FROM users WHERE username LIKE $1 ORDER BY username', [`${prefix}%`])).rows
  if (users.length !== 2) throw new Error('FIXTURE_USERS_NOT_IDEMPOTENT')
  const assignments = (await pool.query(`SELECT id, user_id FROM attendance_shift_assignments
    WHERE org_id = $1 AND producer_type IS NULL AND publish_status = 'published'
    AND assignment_kind = 'regular' AND start_date = end_date ORDER BY user_id`, [orgId])).rows
  counts.publishedManualSwapAssignments = assignments.length
  if (assignments.length !== 2) throw new Error('FIXTURE_ASSIGNMENTS_NOT_IDEMPOTENT')
  stage = 'SERVER'
  const { MetaSheetServer } = await import('../../packages/core-backend/src/index')
  server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [join(root, 'plugins/plugin-attendance')] })
  await server.start()
  const address = server.getAddress()
  if (!address) throw new Error('FIXTURE_SERVER_UNAVAILABLE')
  const base = `http://127.0.0.1:${address.port}/api`
  async function request(route: string, token = '', body?: unknown) {
    const response = await fetch(`${base}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-org-id': orgId },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const payload = await response.json() as { ok?: boolean; token?: string; error?: { code?: string }; data?: any }
    if (!response.ok || payload.ok === false) {
      const code = /^[A-Z_]+$/.test(payload.error?.code || '') ? payload.error!.code : 'HTTP_FAILURE'
      throw new Error(`FIXTURE_${stage}_${response.status}_${code}`)
    }
    return payload
  }
  stage = 'TOKEN'
  const token = (await request(`/auth/dev-token?userId=${encodeURIComponent(users[0].id)}&tenantId=${orgId}&roles=user&perms=attendance:read,attendance:write`)).token
  if (!token) throw new Error('FIXTURE_TOKEN_MISSING')
  stage = 'PERMISSIONS'
  const denied = await fetch(`${base}/attendance/settings?orgId=${orgId}`, {
    headers: { Authorization: `Bearer ${token}`, 'x-org-id': orgId },
  })
  const deniedBody = await denied.json() as { ok?: boolean; error?: { code?: string } }
  if (denied.status !== 403 || deniedBody.ok !== false || deniedBody.error?.code !== 'FORBIDDEN') {
    throw new Error('FIXTURE_ADMIN_PERMISSION_NOT_DENIED')
  }
  stage = 'POLICIES'
  const leave = (await request(`/attendance/leave-types?orgId=${orgId}&isActive=true`, token)).data.items
  const overtime = (await request(`/attendance/overtime-rules?orgId=${orgId}&isActive=true`, token)).data.items
  counts.activeLeaveTypes = leave.length
  counts.activeOvertimeRules = overtime.length
  if (leave.length !== 1 || overtime.length !== 1) throw new Error('FIXTURE_POLICIES_NOT_IDEMPOTENT')
  const ids: string[] = []
  for (const [type, date, extra] of [
    ['leave', '2049-06-11', { leaveTypeId: leave[0].id }],
    ['overtime', '2049-06-12', { overtimeRuleId: overtime[0].id }],
  ] as const) {
    stage = type.toUpperCase()
    const response = await request('/attendance/requests', token, {
      orgId, requestType: type, workDate: date, requestedInAt: `${date}T09:00:00+08:00`,
      requestedOutAt: `${date}T10:00:00+08:00`, minutes: 60, reason: 'Synthetic fixture verification', ...extra,
    })
    if (response.data?.request?.status !== 'pending') throw new Error('FIXTURE_REQUEST_NOT_PENDING')
    const persisted = (await pool.query(`SELECT work_date::text, request_type, status, metadata
      FROM attendance_requests WHERE org_id = $1 AND user_id = $2 AND id = $3`,
    [orgId, users[0].id, response.data.request.id])).rows[0]
    const policy = type === 'leave' ? persisted?.metadata?.leaveType?.id : persisted?.metadata?.overtimeRule?.id
    const expectedPolicy = type === 'leave' ? leave[0].id : overtime[0].id
    if (!persisted || persisted.work_date !== date || persisted.request_type !== type
      || persisted.status !== 'pending' || policy !== expectedPolicy || persisted.metadata.minutes !== 60) {
      throw new Error('FIXTURE_REQUEST_PERSISTENCE_MISMATCH')
    }
    ids.push(response.data.request.id)
    if (type === 'leave') counts.submittedLeave += 1
    else counts.submittedOvertime += 1
  }
  stage = 'SWAP'
  const requester = assignments.find((row: { user_id: string }) => row.user_id === users[0].id)
  const counterparty = assignments.find((row: { user_id: string }) => row.user_id !== users[0].id)
  const swap = await request('/attendance/shift-swap-requests', token, {
    orgId, requesterAssignmentId: requester.id, counterpartyAssignmentId: counterparty.id,
    reason: 'Synthetic fixture verification',
  })
  const swapId = swap.data?.request?.id
  if (!swapId) throw new Error('FIXTURE_SWAP_NOT_CREATED')
  const swapRows = (await pool.query(`SELECT 1 FROM attendance_shift_swap_requests
    WHERE org_id = $1 AND request_id = $2 AND requester_assignment_id = $3 AND counterparty_assignment_id = $4`,
  [orgId, swapId, requester.id, counterparty.id])).rows
  if (swapRows.length !== 1) throw new Error('FIXTURE_SWAP_PERSISTENCE_MISMATCH')
  counts.submittedSwap += 1
  stage = 'CANCEL'
  for (const id of ids) {
    await request(`/attendance/requests/${id}/cancel`, token, { orgId })
    counts.cancelledRequests += 1
  }
  await request(`/attendance/shift-swap-requests/${swapId}/cancel`, token, { orgId })
  counts.cancelledRequests += 1
  const cancelled = (await pool.query(`SELECT status FROM attendance_requests
    WHERE org_id = $1 AND user_id = $2 AND id = ANY($3::uuid[])`,
  [orgId, users[0].id, [...ids, swapId]])).rows
  if (cancelled.length !== 3 || cancelled.some((row: { status: string }) => row.status !== 'cancelled')) {
    throw new Error('FIXTURE_CANCEL_PERSISTENCE_MISMATCH')
  }
  console.log(JSON.stringify({ code: 'ATTENDANCE_SELFSERVICE_FIXTURE_PASS', rbacBypass: false, tokenClaimsTrusted: false, adminReadDenied: true, counts }))
} catch (error) {
  const reason = error instanceof Error && /^[A-Z_0-9]+$/.test(error.message) ? error.message : 'FIXTURE_VERIFICATION_FAILED'
  console.error(JSON.stringify({ code: reason, stage, counts }))
  process.exitCode = 1
} finally {
  if (server) await server.stop()
  await pool.end()
}
// The standalone rehearsal owns the server process. Some plugin imports retain
// idle handles after stop(); do not leave a verifier process running afterwards.
process.exit(process.exitCode ?? 0)
