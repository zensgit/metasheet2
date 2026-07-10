import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { MetaSheetServer } from '../../src/index'
import * as path from 'path'
import net from 'net'
import http from 'http'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'

// F1 files-acl-tombstone design-lock (2026-07-10): resource-level ACL matrix for the four
// `files.ts` HTTP endpoints (list/info/download/delete) — route-level, real DB, real running
// server (same harness shape as attendance-outdoor-punch.test.ts). Also carries the S2 punch
// regression required by the design-lock's own test list (item 7): owner-upload + owner-punch
// must remain unaffected by the new ACL gate, proven end-to-end against the real attendance
// plugin + a real photo upload, not just by inspection.

type HttpResponse = { status: number; body?: unknown; raw: string }

function requestJson(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = http.request(
      {
        method: options.method || 'GET',
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: options.headers,
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          let body: unknown
          try { body = data ? JSON.parse(data) : undefined } catch { body = undefined }
          resolve({ status: res.statusCode || 0, body, raw: data })
        })
      },
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

const ORG = 'default'
const FENCE = { lat: 31.2304, lng: 121.4737, radiusMeters: 100 }
const OUTSIDE = { lat: 0, lng: 0 }
// File-level fixture namespace (shared-DB integration gate runs many describeIfDatabase suites
// against ONE Postgres in ONE vitest process — bare Date.now() collides across files/tests).
const NS = `filacl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const uid = (tag: string) => `${NS}-${tag}-${Math.random().toString(36).slice(2, 8)}`

describeDb('F1 files-acl-tombstone: resource-level ACL matrix (real DB, route-level)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let pool: Pool

  const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })

  // roles='' resolves to a NON-admin claim (any non-'admin' string works; dev-token only falls
  // back to ['admin'] when the roles param is entirely absent/empty after filtering, so a
  // deliberately non-admin role string is required to get a real non-admin token here).
  async function mintToken(userId: string, perms: string, roles: string): Promise<string> {
    const res = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent(perms)}`)
    return (res.body as { token?: string } | undefined)?.token ?? ''
  }
  const mintUserToken = (userId: string) => mintToken(userId, 'attendance:read,attendance:write', 'employee')
  const mintAdminToken = (userId: string) => mintToken(userId, 'attendance:read,attendance:write,attendance:admin,attendance:approve', 'admin')

  function uploadFile(token: string, part: { filename: string; contentType: string; content: Buffer }): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const boundary = `----ms2filacl${Math.random().toString(36).slice(2)}`
      const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${part.filename}"\r\nContent-Type: ${part.contentType}\r\n\r\n`,
      )
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
      const body = Buffer.concat([head, part.content, tail])
      const target = new URL(`${baseUrl}/api/files/upload`)
      const req = http.request(
        {
          method: 'POST',
          hostname: target.hostname,
          port: target.port,
          path: target.pathname,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
        },
        (res) => {
          let data = ''
          res.on('data', (chunk) => { data += chunk })
          res.on('end', () => {
            let parsed: unknown
            try { parsed = data ? JSON.parse(data) : undefined } catch { parsed = undefined }
            resolve({ status: res.statusCode || 0, body: parsed, raw: data })
          })
        },
      )
      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }
  const uploadedFileId = (res: HttpResponse) => (res.body as { file?: { id?: string } } | undefined)?.file?.id ?? ''
  const PHOTO_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  )

  const info = (token: string, id: string) => requestJson(`${baseUrl}/api/files/${id}`, { headers: authHeaders(token) })
  const download = (token: string, id: string) => requestJson(`${baseUrl}/api/files/${id}/download`, { headers: authHeaders(token) })
  const del = (token: string, id: string) => requestJson(`${baseUrl}/api/files/${id}`, { method: 'DELETE', headers: authHeaders(token) })
  const list = (token: string) => requestJson(`${baseUrl}/api/files?limit=500`, { headers: authHeaders(token) })

  async function cleanupFiles(...ownerIds: string[]) {
    for (const id of ownerIds) {
      await pool.query(`DELETE FROM files WHERE owner_id = $1`, [id]).catch(() => undefined)
    }
  }

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen || !dbUrl) throw new Error('files ACL integration needs a loopback port + DATABASE_URL')

    process.env.DATABASE_URL = dbUrl
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    const repoRoot = path.join(__dirname, '../../../../')
    const { MetaSheetServer } = await import('../../src/index')
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')] })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('server did not expose a TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
    pool = new Pool({ connectionString: dbUrl })
  })

  afterAll(async () => {
    if (server && (server as unknown as { stop?: () => Promise<void> }).stop) await (server as unknown as { stop: () => Promise<void> }).stop()
    await pool?.end().catch(() => undefined)
  })

  it('owner (non-admin) can info/download/delete their own file', async () => {
    const owner = uid('owner-self')
    const t = await mintUserToken(owner)
    try {
      const up = await uploadFile(t, { filename: 'a.png', contentType: 'image/png', content: PHOTO_PNG })
      expect(up.status).toBe(200)
      const id = uploadedFileId(up)
      expect(id).toBeTruthy()

      const infoRes = await info(t, id)
      expect(infoRes.status).toBe(200)
      expect((infoRes.body as { id?: string })?.id).toBe(id)

      const dlRes = await download(t, id)
      expect(dlRes.status).toBe(200)

      const delRes = await del(t, id)
      expect(delRes.status).toBe(200)
      expect(delRes.body).toEqual({ success: true, id })
    } finally {
      await cleanupFiles(owner)
    }
  })

  it('cross-user (non-owner, non-admin) gets 404 on info/download/delete — never 403 (anti-enumeration)', async () => {
    const owner = uid('owner-x')
    const stranger = uid('stranger-x')
    const tOwner = await mintUserToken(owner)
    const tStranger = await mintUserToken(stranger)
    try {
      const up = await uploadFile(tOwner, { filename: 'b.png', contentType: 'image/png', content: PHOTO_PNG })
      expect(up.status).toBe(200)
      const id = uploadedFileId(up)
      expect(id).toBeTruthy()

      const infoRes = await info(tStranger, id)
      expect(infoRes.status).toBe(404)
      expect(infoRes.body).toEqual({ error: 'File not found' })

      const dlRes = await download(tStranger, id)
      expect(dlRes.status).toBe(404)
      expect(dlRes.body).toEqual({ error: 'File not found' })

      const delRes = await del(tStranger, id)
      expect(delRes.status).toBe(404)
      expect(delRes.body).toEqual({ error: 'File not found' })

      // the file must still be intact for the real owner after the stranger's failed delete attempt
      const stillThere = await info(tOwner, id)
      expect(stillThere.status).toBe(200)
    } finally {
      await cleanupFiles(owner, stranger)
    }
  })

  it('admin (non-owner) can info/download/delete another user\'s file', async () => {
    const owner = uid('owner-adm')
    const admin = uid('admin-adm')
    const tOwner = await mintUserToken(owner)
    const tAdmin = await mintAdminToken(admin)
    try {
      const up = await uploadFile(tOwner, { filename: 'c.png', contentType: 'image/png', content: PHOTO_PNG })
      expect(up.status).toBe(200)
      const id = uploadedFileId(up)
      expect(id).toBeTruthy()

      const infoRes = await info(tAdmin, id)
      expect(infoRes.status).toBe(200)

      const dlRes = await download(tAdmin, id)
      expect(dlRes.status).toBe(200)

      const delRes = await del(tAdmin, id)
      expect(delRes.status).toBe(200)
      expect(delRes.body).toEqual({ success: true, id })
    } finally {
      await cleanupFiles(owner, admin)
    }
  })

  it('list: non-admin sees only their own active files; admin sees files across owners', async () => {
    const ownerA = uid('list-a')
    const ownerB = uid('list-b')
    const admin = uid('list-adm')
    const tA = await mintUserToken(ownerA)
    const tB = await mintUserToken(ownerB)
    const tAdmin = await mintAdminToken(admin)
    try {
      const upA1 = await uploadFile(tA, { filename: 'a1.png', contentType: 'image/png', content: PHOTO_PNG })
      const upA2 = await uploadFile(tA, { filename: 'a2.png', contentType: 'image/png', content: PHOTO_PNG })
      const upB1 = await uploadFile(tB, { filename: 'b1.png', contentType: 'image/png', content: PHOTO_PNG })
      const idA1 = uploadedFileId(upA1), idA2 = uploadedFileId(upA2), idB1 = uploadedFileId(upB1)
      expect([idA1, idA2, idB1].every(Boolean)).toBe(true)

      const listA = await list(tA)
      expect(listA.status).toBe(200)
      const idsA = (listA.body as { data?: { id: string }[] })?.data?.map((f) => f.id) ?? []
      expect(idsA).toEqual(expect.arrayContaining([idA1, idA2]))
      expect(idsA).not.toEqual(expect.arrayContaining([idB1]))

      const listB = await list(tB)
      const idsB = (listB.body as { data?: { id: string }[] })?.data?.map((f) => f.id) ?? []
      expect(idsB).toEqual(expect.arrayContaining([idB1]))
      expect(idsB).not.toEqual(expect.arrayContaining([idA1, idA2]))

      const listAdmin = await list(tAdmin)
      const idsAdmin = (listAdmin.body as { data?: { id: string }[] })?.data?.map((f) => f.id) ?? []
      expect(idsAdmin).toEqual(expect.arrayContaining([idA1, idA2, idB1]))
    } finally {
      await cleanupFiles(ownerA, ownerB)
    }
  })

  it('anonymous-owner legacy row (owner_id literally \'anonymous\'): admin-only, even for a caller whose own derived id is \'anonymous\'', async () => {
    const admin = uid('anon-adm')
    const tAdmin = await mintAdminToken(admin)
    // a genuinely non-admin caller whose own resolved userId happens to literally be 'anonymous'
    const tAnonUser = await mintToken('anonymous', 'attendance:read,attendance:write', 'employee')
    const randomUser = uid('anon-stranger')
    const tRandom = await mintUserToken(randomUser)
    // Upload for real (so a genuine storage object backs the row — otherwise even an ACL-allowed
    // caller would 404 on the route's own storage-existence check, which is a separate concern from
    // the ACL gate this test targets), then hand-doctor owner_id to the 'anonymous' sentinel to
    // simulate a pre-userId-resolution-fix legacy row.
    const seedOwner = uid('anon-seed-owner')
    const tSeed = await mintUserToken(seedOwner)
    const up = await uploadFile(tSeed, { filename: 'legacy.png', contentType: 'image/png', content: PHOTO_PNG })
    expect(up.status).toBe(200)
    const legacyId = uploadedFileId(up)
    expect(legacyId).toBeTruthy()
    try {
      await pool.query(`UPDATE files SET owner_id = 'anonymous' WHERE id = $1`, [legacyId])

      const randomInfo = await info(tRandom, legacyId)
      expect(randomInfo.status).toBe(404)

      const anonInfo = await info(tAnonUser, legacyId)
      expect(anonInfo.status).toBe(404)

      const adminInfo = await info(tAdmin, legacyId)
      expect(adminInfo.status).toBe(200)
    } finally {
      await pool.query(`DELETE FROM files WHERE id = $1`, [legacyId]).catch(() => undefined)
    }
  })

  // ────────────────────────────────────────────────────────────────────────────────────────────────
  // S2 punch E2E regression (design-lock item 7): owner-upload + owner-punch must be byte-identical
  // to pre-F1 behavior — the ACL gate must never interfere with the attendance plugin's own direct-SQL
  // G2 check (which never goes through these HTTP routes at all).
  it('S2 regression: owner uploads a real photo and punches with it — unaffected by the new ACL gate', async () => {
    const admin = uid('s2reg-admin')
    const tAdmin = await mintAdminToken(admin)
    const putSettings = (body: Record<string, unknown>) =>
      requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers: authHeaders(tAdmin), body: JSON.stringify(body) })
    const before = await requestJson(`${baseUrl}/api/attendance/settings`, { headers: authHeaders(tAdmin) })
    const beforeData = (before.body as { data?: { punchPolicy?: unknown; geoFence?: unknown } } | undefined)?.data
    const originalPunchPolicy = beforeData?.punchPolicy
    const originalGeoFence = beforeData?.geoFence
    await pool.query(`DELETE FROM attendance_approval_flows WHERE org_id = $1 AND request_type = 'outdoor_punch'`, [ORG])
    const flowRes = await requestJson(`${baseUrl}/api/attendance/approval-flows`, {
      method: 'POST', headers: authHeaders(tAdmin),
      body: JSON.stringify({ name: `outdoor-filacl-${randomUUID()}`, requestType: 'outdoor_punch', isActive: true, steps: [] }),
    })
    const flowId = (flowRes.body as { data?: { id?: string } } | undefined)?.data?.id ?? ''
    expect(flowId).toBeTruthy()

    const owner = uid('s2reg-owner')
    const tOwner = await mintUserToken(owner)
    try {
      await putSettings({
        geoFence: FENCE,
        punchPolicy: { outdoor: { requireApproval: true, requireNote: false, requirePhoto: true, approvalFlowId: flowId } },
      })

      const up = await uploadFile(tOwner, { filename: 'evidence.png', contentType: 'image/png', content: PHOTO_PNG })
      expect(up.status).toBe(200)
      const fileId = uploadedFileId(up)
      expect(fileId).toBeTruthy()

      const punchRes = await requestJson(`${baseUrl}/api/attendance/punch`, {
        method: 'POST', headers: authHeaders(tOwner),
        body: JSON.stringify({ eventType: 'check_in', location: OUTSIDE, photoFileId: fileId }),
      })
      expect(punchRes.status).toBe(202)
      expect((punchRes.body as { data?: { pendingApproval?: boolean } })?.data?.pendingApproval).toBe(true)
    } finally {
      await putSettings({ geoFence: originalGeoFence ?? null, punchPolicy: originalPunchPolicy ?? {} }).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_approval_flows WHERE org_id = $1 AND request_type = 'outdoor_punch'`, [ORG]).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_requests WHERE user_id = $1`, [owner]).catch(() => undefined)
      await cleanupFiles(owner)
    }
  })
})
