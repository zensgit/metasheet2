import { randomUUID } from 'crypto'
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import { getOrCreateLocalIntegration } from '../../src/directory/directory-sync'
import { createLocalDepartment } from '../../src/directory/local-directory-org'
import { adminDirectoryDepartmentBindingsRouter } from '../../src/routes/admin-directory-department-bindings'

/**
 * B7 owner round (#4436) — the department-binding MANAGEMENT surface (real DB, HTTP).
 *
 *   A. GET / lists the org's bindings with status + both sides' names.
 *   B. GET /suggestions returns the §9 read-only proposals (and writes nothing).
 *   C. POST /sweep is the Q6 ADMIN RETRY: stales a disappeared-remote binding on demand, audited
 *      values-free with outcome counts; narrowed sweep (remoteIntegrationId) leaves the other
 *      integration's binding untouched — the same scope the post-sync hook uses.
 *   D. POST /sweep validations: unlisted field 400; non-UUID 400; cross-org integration 404 —
 *      none of them sweeping or auditing anything.
 *   E. non-admin 403 on all three routes.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const STAMP = Date.now()
const orgId = 'default'

const adminApp = express()
adminApp.use(express.json())
adminApp.use((req, _res, next) => {
  ;(req as express.Request & { user?: unknown }).user = { id: `b7r-admin-${STAMP}`, role: 'admin' }
  next()
})
adminApp.use('/api/admin/directory/department-bindings', adminDirectoryDepartmentBindingsRouter())

const nonAdminApp = express()
nonAdminApp.use(express.json())
nonAdminApp.use((req, _res, next) => {
  ;(req as express.Request & { user?: unknown }).user = { id: `b7r-nonadmin-${STAMP}` }
  next()
})
nonAdminApp.use('/api/admin/directory/department-bindings', adminDirectoryDepartmentBindingsRouter())

const BASE = '/api/admin/directory/department-bindings'

async function dingtalkIntegration(org: string, tag: string): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
     VALUES ($1, 'dingtalk', $2, 'active', $3, '{}'::jsonb) RETURNING id`,
    [org, `DT b7r ${tag} ${STAMP}`, `corp-b7r-${STAMP}-${tag}`],
  )
  return r.rows[0].id
}
async function dtDept(integrationId: string, extId: string, name: string): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO directory_departments (integration_id, provider, external_department_id, name, is_active, raw)
     VALUES ($1, 'dingtalk', $2, $3, true, '{}'::jsonb) RETURNING id`,
    [integrationId, extId, name],
  )
  return r.rows[0].id
}
async function bind(org: string, localInt: string, localDept: string, remoteInt: string, remoteDept: string): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO directory_department_bindings
       (org_id, local_integration_id, local_department_id, local_provider,
        remote_integration_id, remote_department_id, remote_provider, status)
     VALUES ($1, $2, $3, 'local', $4, $5, 'dingtalk', 'active') RETURNING id`,
    [org, localInt, localDept, remoteInt, remoteDept],
  )
  return r.rows[0].id
}
async function sweepAuditCount(): Promise<number> {
  const r = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'directory.department_binding.sweep'`,
  )
  return r.rows[0]?.n ?? 0
}

describeIfDatabase('B7 — department-binding admin routes (real DB, HTTP)', () => {
  const cleanupIntegrationIds: string[] = []
  const cleanupDeptIds: string[] = []
  const cleanupBindingIds: string[] = []
  const cleanupOrgIds: string[] = []

  afterEach(async () => {
    await query(`DELETE FROM audit_logs WHERE resource_type = 'directory-department-binding'`)
    for (const id of cleanupBindingIds.splice(0)) await query(`DELETE FROM directory_department_bindings WHERE id = $1`, [id])
    for (const id of cleanupDeptIds.splice(0)) await query(`DELETE FROM directory_departments WHERE id = $1`, [id])
    for (const id of cleanupIntegrationIds.splice(0)) await query(`DELETE FROM directory_integrations WHERE id = $1`, [id])
    for (const org of cleanupOrgIds.splice(0)) await query(`DELETE FROM directory_integrations WHERE org_id = $1`, [org])
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  async function seedBoundPair(tag: string): Promise<{ dt: string; rDept: string; binding: string; lDeptName: string }> {
    const local = await getOrCreateLocalIntegration(orgId)
    const lDept = await createLocalDepartment({ orgId, name: `B7R ${tag} ${STAMP}` })
    cleanupDeptIds.push(lDept.id)
    const dt = await dingtalkIntegration(orgId, tag)
    cleanupIntegrationIds.push(dt)
    const rDept = await dtDept(dt, `b7r-${tag}-${STAMP}`, `B7R ${tag} ${STAMP}`)
    const binding = await bind(orgId, local.id, lDept.id, dt, rDept)
    cleanupBindingIds.push(binding)
    return { dt, rDept, binding, lDeptName: `B7R ${tag} ${STAMP}` }
  }

  it('A. GET / lists bindings with status and both names', async () => {
    const { binding, lDeptName } = await seedBoundPair('list')
    const res = await request(adminApp).get(`${BASE}/`)
    expect(res.status).toBe(200)
    const rows = (res.body.data?.bindings ?? res.body.bindings) as Array<Record<string, unknown>>
    const mine = rows.find((r) => r.id === binding)
    expect(mine).toBeTruthy()
    expect(mine?.status).toBe('active')
    expect(mine?.local_department_name).toBe(lDeptName)
    expect(mine?.remote_department_name).toBe(lDeptName)
  })

  it('B. GET /suggestions is the §9 read-only surface (returns proposals, writes nothing)', async () => {
    const dt = await dingtalkIntegration(orgId, 'sugg')
    cleanupIntegrationIds.push(dt)
    const lDept = await createLocalDepartment({ orgId, name: `B7R Sugg ${STAMP}` })
    cleanupDeptIds.push(lDept.id)
    const rDept = await dtDept(dt, `b7r-sugg-${STAMP}`, `B7R Sugg ${STAMP}`)
    cleanupDeptIds.push(rDept)

    const before = await query<{ n: number }>(`SELECT count(*)::int AS n FROM directory_department_bindings WHERE org_id = $1`, [orgId])
    const res = await request(adminApp).get(`${BASE}/suggestions`)
    expect(res.status).toBe(200)
    const body = res.body.data ?? res.body
    const mine = (body.suggestions as Array<Record<string, unknown>>).find((s) => s.remoteDepartmentId === rDept)
    expect(mine?.localDepartmentId).toBe(lDept.id)
    const after = await query<{ n: number }>(`SELECT count(*)::int AS n FROM directory_department_bindings WHERE org_id = $1`, [orgId])
    expect(after.rows[0].n).toBe(before.rows[0].n) // read-only
  })

  it('C. POST /sweep stales on demand (audited, values-free counts); narrowed sweep leaves the other integration untouched', async () => {
    const x = await seedBoundPair('swx')
    const y = await seedBoundPair('swy')
    await query(`UPDATE directory_departments SET is_active = false WHERE id IN ($1, $2)`, [x.rDept, y.rDept])

    // narrowed to X — the exact post-sync-hook scope
    const res = await request(adminApp).post(`${BASE}/sweep`).send({ remoteIntegrationId: x.dt })
    expect(res.status).toBe(200)
    const out = res.body.data ?? res.body
    expect(out.staled).toBe(1)
    const sx = await query<{ status: string }>(`SELECT status FROM directory_department_bindings WHERE id = $1`, [x.binding])
    const sy = await query<{ status: string }>(`SELECT status FROM directory_department_bindings WHERE id = $1`, [y.binding])
    expect(sx.rows[0].status).toBe('stale')
    expect(sy.rows[0].status).toBe('active') // narrowed out
    expect(await sweepAuditCount()).toBe(1)

    // full-org retry catches Y too
    const res2 = await request(adminApp).post(`${BASE}/sweep`).send({})
    expect((res2.body.data ?? res2.body).staled).toBe(1)
    expect(await sweepAuditCount()).toBe(2)

    // Gate P3 (restack round): pin the VALUES-FREE property, not just the count — the serialized
    // sweep audit rows must carry ids/counters only, never department names (a regression adding
    // names/urls to meta would otherwise stay green).
    const serialized = await query<{ body: string | null }>(
      `SELECT string_agg(to_jsonb(a)::text, '|') AS body
         FROM audit_logs a WHERE a.action = 'directory.department_binding.sweep'`
    )
    const auditBody = serialized.rows[0].body ?? ''
    expect(auditBody.length).toBeGreaterThan(0)
    for (const leaked of [x.lDeptName, y.lDeptName, 'B7R swx', 'B7R swy']) {
      expect(auditBody).not.toContain(leaked)
    }
  })

  it('D. POST /sweep validations reject without sweeping or auditing: unlisted field / non-UUID / cross-org', async () => {
    const { rDept, binding } = await seedBoundPair('val')
    await query(`UPDATE directory_departments SET is_active = false WHERE id = $1`, [rDept])

    const bad1 = await request(adminApp).post(`${BASE}/sweep`).send({ orgId: 'evil' })
    expect(bad1.status).toBe(400)
    const bad2 = await request(adminApp).post(`${BASE}/sweep`).send({ remoteIntegrationId: 'nope' })
    expect(bad2.status).toBe(400)
    const otherOrg = `b7r-other-${STAMP}`
    cleanupOrgIds.push(otherOrg)
    const foreign = await dingtalkIntegration(otherOrg, 'xorg')
    const bad3 = await request(adminApp).post(`${BASE}/sweep`).send({ remoteIntegrationId: foreign })
    expect(bad3.status).toBe(404)

    const s = await query<{ status: string }>(`SELECT status FROM directory_department_bindings WHERE id = $1`, [binding])
    expect(s.rows[0].status).toBe('active') // nothing swept
    expect(await sweepAuditCount()).toBe(0) // nothing audited
  })

  it('E. non-admin: 403 on list, suggestions, and sweep (real RBAC path)', async () => {
    const r1 = await request(nonAdminApp).get(`${BASE}/`)
    const r2 = await request(nonAdminApp).get(`${BASE}/suggestions`)
    const r3 = await request(nonAdminApp).post(`${BASE}/sweep`).send({ remoteIntegrationId: randomUUID() })
    expect(r1.status).toBe(403)
    expect(r2.status).toBe(403)
    expect(r3.status).toBe(403)
  })
})
