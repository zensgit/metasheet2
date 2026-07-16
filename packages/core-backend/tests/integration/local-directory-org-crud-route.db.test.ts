import { randomUUID } from 'crypto'
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import {
  ADD_LOCAL_MEMBERSHIP_FIELD_TYPES,
  ADD_LOCAL_MEMBERSHIP_FIELDS,
  CREATE_LOCAL_ACCOUNT_FIELD_TYPES,
  CREATE_LOCAL_ACCOUNT_FIELDS,
  CREATE_LOCAL_DEPARTMENT_FIELD_TYPES,
  CREATE_LOCAL_DEPARTMENT_FIELDS,
  UPDATE_LOCAL_ACCOUNT_FIELD_TYPES,
  UPDATE_LOCAL_ACCOUNT_FIELDS,
  UPDATE_LOCAL_DEPARTMENT_FIELD_TYPES,
  UPDATE_LOCAL_DEPARTMENT_FIELDS,
  UPDATE_LOCAL_MEMBERSHIP_FIELD_TYPES,
  UPDATE_LOCAL_MEMBERSHIP_FIELDS,
} from '../../src/directory/local-directory-org-request-schema'
import { adminDirectoryLocalRouter } from '../../src/routes/admin-directory-local'

/**
 * Canonical Org MVP — B2 (local departments/accounts/memberships CRUD), HTTP route layer, real
 * DB. Pairs with `local-directory-org-crud.db.test.ts` (service layer) the same way
 * `attendance-notification-redelivery-route.db.test.ts` pairs with
 * `attendance-notification-redelivery.db.test.ts` — the service file proves persistence
 * semantics; THIS file proves the actual HTTP write surface: platform-admin gating, per-mutation
 * audit rows, and — the owner hard requirement this line exists for — that `org_id`/`corp_id`
 * (and their camelCase spellings) smuggled into a request body are REJECTED (400), not silently
 * dropped, on every mutating B2 endpoint. Org identity is resolved server-side
 * (`resolveLocalDirectoryOrgId` in admin-directory-local.ts) to `'default'` — the same effective
 * single-tenant org every other directory admin route reaches too (by omitting `orgId` and
 * letting directory-sync.ts's services default it); there is no per-request org/tenant context in
 * this codebase for directory routes to read yet, so every request below shares that one org's
 * local integration. Fixtures are cleaned up by their own returned ids in `afterEach` (never by
 * deleting the shared integration row, which other B2 test runs may still be using).
 *
 * `req.user` is set by a trivial pass-through auth middleware (`role: 'admin'` satisfies
 * `hasLegacyAdminClaim` directly, the same shortcut `attendance-notification-redelivery-
 * route.db.test.ts` uses) — no RBAC fixture rows are needed for the admin-path tests. The
 * non-admin test below deliberately does NOT set that claim, so it exercises the real
 * `isRbacAdmin` query against Postgres.
 *
 * DATABASE_URL-gated (describeIfDatabase): excluded from the no-DB vitest job so it cannot
 * skip-green, and wired as a WHOLE FILE into the `Run approval real-DB integration` step in
 * plugin-tests.yml.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const STAMP = Date.now()

function fixtureName(tag: string): string {
  return `b2-route-${STAMP}-${tag}-${randomUUID().slice(0, 8)}`
}

const adminApp = express()
adminApp.use(express.json())
adminApp.use((req, _res, next) => {
  ;(req as express.Request & { user?: unknown }).user = { id: `b2-route-admin-${STAMP}`, role: 'admin' }
  next()
})
adminApp.use('/api/admin/directory/local', adminDirectoryLocalRouter())

const nonAdminApp = express()
nonAdminApp.use(express.json())
nonAdminApp.use((req, _res, next) => {
  ;(req as express.Request & { user?: unknown }).user = { id: `b2-route-nonadmin-${STAMP}` }
  next()
})
nonAdminApp.use('/api/admin/directory/local', adminDirectoryLocalRouter())

async function seedUser(): Promise<string> {
  const id = `b2-route-user-${STAMP}-${randomUUID().slice(0, 8)}`
  await query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, 'x')`, [id, `${id}@example.test`, 'Route Test User'])
  return id
}

describeIfDatabase('Canonical Org MVP — B2 local departments/accounts/memberships CRUD (real DB, HTTP route layer)', () => {
  const createdDepartmentIds: string[] = []
  const createdAccountIds: string[] = []
  const createdUserIds: string[] = []

  afterEach(async () => {
    const depts = createdDepartmentIds.splice(0)
    for (const id of depts) await query(`DELETE FROM directory_departments WHERE id = $1`, [id])
    const accounts = createdAccountIds.splice(0)
    for (const id of accounts) await query(`DELETE FROM directory_accounts WHERE id = $1`, [id]) // cascades links + memberships
    const users = createdUserIds.splice(0)
    for (const id of users) await query(`DELETE FROM users WHERE id = $1`, [id])
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('creates a department over real HTTP, persists it, and writes one audit row', async () => {
    const deptName = fixtureName('create-dept')
    const res = await request(adminApp).post('/api/admin/directory/local/departments').send({ name: deptName })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.department.name).toBe(deptName)
    expect(res.body.data.department.isActive).toBe(true)
    createdDepartmentIds.push(res.body.data.department.id)

    const row = await query<{ name: string; is_active: boolean }>(`SELECT name, is_active FROM directory_departments WHERE id = $1`, [
      res.body.data.department.id,
    ])
    expect(row.rows).toEqual([{ name: deptName, is_active: true }])

    const audit = await query(`SELECT 1 FROM audit_logs WHERE action = 'directory.local_department.create' AND resource_id = $1`, [
      res.body.data.department.id,
    ])
    expect(audit.rows.length).toBe(1)
  })

  it('rejects a create-department request smuggling org_id/corp_id (400, no row written, no audit row)', async () => {
    const deptName = fixtureName('smuggle-dept-snake')
    const res = await request(adminApp)
      .post('/api/admin/directory/local/departments')
      .send({ name: deptName, org_id: 'attacker-org', corp_id: 'evil-corp' })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      ok: false,
      error: {
        code: 'DIRECTORY_LOCAL_UNKNOWN_FIELDS',
        message: 'Request body contains fields not accepted by this endpoint',
        details: undefined,
      },
    })

    const rows = await query(`SELECT 1 FROM directory_departments WHERE name = $1`, [deptName])
    expect(rows.rows.length).toBe(0)
  })

  it('rejects a create-department request smuggling the camelCase orgId/corpId spelling too', async () => {
    const deptName = fixtureName('smuggle-dept-camel')
    const res = await request(adminApp)
      .post('/api/admin/directory/local/departments')
      .send({ name: deptName, orgId: 'attacker-org', corpId: 'evil-corp' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('DIRECTORY_LOCAL_UNKNOWN_FIELDS')

    const rows = await query(`SELECT 1 FROM directory_departments WHERE name = $1`, [deptName])
    expect(rows.rows.length).toBe(0)
  })

  it('rejects an update-department request smuggling org_id (the target row is left unchanged)', async () => {
    const created = await request(adminApp).post('/api/admin/directory/local/departments').send({ name: fixtureName('update-target') })
    expect(created.status).toBe(200)
    createdDepartmentIds.push(created.body.data.department.id)
    const originalName = created.body.data.department.name

    const res = await request(adminApp)
      .patch(`/api/admin/directory/local/departments/${created.body.data.department.id}`)
      .send({ name: 'should-not-apply', org_id: 'attacker-org' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('DIRECTORY_LOCAL_UNKNOWN_FIELDS')

    const row = await query<{ name: string }>(`SELECT name FROM directory_departments WHERE id = $1`, [created.body.data.department.id])
    expect(row.rows[0].name).toBe(originalName)
  })

  // ---- Department field TYPE validation (owner P2 on #4317: allowlist checked NAMES only, not
  // TYPES — a wrong-typed value fell through `typeof x === 'string' ? x : null`-shaped extraction
  // and silently coerced to the destructive `null` ("clear") signal). ---------------------------

  it('rejects a PATCH department parentDepartmentId given as a number — 400, parent left unchanged (owner-reported case, verbatim)', async () => {
    const parent = await request(adminApp).post('/api/admin/directory/local/departments').send({ name: fixtureName('parent-num-case') })
    expect(parent.status).toBe(200)
    createdDepartmentIds.push(parent.body.data.department.id)
    const child = await request(adminApp)
      .post('/api/admin/directory/local/departments')
      .send({ name: fixtureName('child-num-case'), parentDepartmentId: parent.body.data.department.id })
    expect(child.status).toBe(200)
    createdDepartmentIds.push(child.body.data.department.id)
    expect(child.body.data.department.parentDepartmentId).toBe(parent.body.data.department.id)

    const res = await request(adminApp)
      .patch(`/api/admin/directory/local/departments/${child.body.data.department.id}`)
      .send({ parentDepartmentId: 123 })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'DIRECTORY_LOCAL_INVALID_INPUT', message: 'parentDepartmentId must be a string or null', details: undefined },
    })

    const row = await query<{ external_parent_department_id: string | null }>(
      `SELECT external_parent_department_id FROM directory_departments WHERE id = $1`,
      [child.body.data.department.id],
    )
    expect(row.rows[0].external_parent_department_id).toBe(parent.body.data.department.externalDepartmentId)
  })

  it.each([
    { name: 'parentDepartmentId as an array', field: 'parentDepartmentId', badValue: [], expectedMessage: 'parentDepartmentId must be a string or null' },
    { name: 'parentDepartmentId as a boolean', field: 'parentDepartmentId', badValue: true, expectedMessage: 'parentDepartmentId must be a string or null' },
    { name: 'name as a number', field: 'name', badValue: 42, expectedMessage: 'name must be a string' },
    { name: 'name as explicit null (not nullable-by-design)', field: 'name', badValue: null, expectedMessage: 'name must be a string' },
    { name: 'orderIndex as a numeric string', field: 'orderIndex', badValue: '5', expectedMessage: 'orderIndex must be an integer within the int4 range' },
    { name: 'orderIndex as a float', field: 'orderIndex', badValue: 3.7, expectedMessage: 'orderIndex must be an integer within the int4 range' },
    // int4 bound (gate NIT-1): an integer beyond the column range used to pass Number.isInteger
    // and blow up as a 500 at INSERT time; the type gate now bounds it to int4 => 400, no write.
    { name: 'orderIndex beyond int4 range', field: 'orderIndex', badValue: 3_000_000_000, expectedMessage: 'orderIndex must be an integer within the int4 range' },
  ])('rejects a PATCH department with $name — 400, department left byte-identical', async ({ field, badValue, expectedMessage }) => {
    const created = await request(adminApp).post('/api/admin/directory/local/departments').send({ name: fixtureName(`dept-type-${field}`) })
    expect(created.status).toBe(200)
    const id = created.body.data.department.id as string
    createdDepartmentIds.push(id)

    const before = await query<{ name: string; order_index: number; external_parent_department_id: string | null }>(
      `SELECT name, order_index, external_parent_department_id FROM directory_departments WHERE id = $1`,
      [id],
    )

    const res = await request(adminApp).patch(`/api/admin/directory/local/departments/${id}`).send({ [field]: badValue })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('DIRECTORY_LOCAL_INVALID_INPUT')
    expect(res.body.error.message).toBe(expectedMessage)

    const after = await query<{ name: string; order_index: number; external_parent_department_id: string | null }>(
      `SELECT name, order_index, external_parent_department_id FROM directory_departments WHERE id = $1`,
      [id],
    )
    expect(after.rows[0]).toEqual(before.rows[0])
  })

  it.each([
    { name: 'name as a number', field: 'name', badValue: 42, expectedMessage: 'name must be a string' },
    { name: 'parentDepartmentId as a number', field: 'parentDepartmentId', badValue: 123, expectedMessage: 'parentDepartmentId must be a string or null' },
    { name: 'orderIndex as a numeric string', field: 'orderIndex', badValue: '5', expectedMessage: 'orderIndex must be an integer within the int4 range' },
    { name: 'orderIndex as a float', field: 'orderIndex', badValue: 1.5, expectedMessage: 'orderIndex must be an integer within the int4 range' },
  ])('rejects a create-department request with $name — 400, no row written', async ({ field, badValue, expectedMessage }) => {
    const deptName = fixtureName('create-type-bad')
    const body: Record<string, unknown> = field === 'name' ? { [field]: badValue } : { name: deptName, [field]: badValue }

    const before = await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM directory_departments`)

    const res = await request(adminApp).post('/api/admin/directory/local/departments').send(body)

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('DIRECTORY_LOCAL_INVALID_INPUT')
    expect(res.body.error.message).toBe(expectedMessage)

    const after = await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM directory_departments`)
    expect(after.rows[0].count).toBe(before.rows[0].count)

    if (field !== 'name') {
      const rows = await query(`SELECT 1 FROM directory_departments WHERE name = $1`, [deptName])
      expect(rows.rows.length).toBe(0)
    }
  })

  it('PATCH department parentDepartmentId: null clears the parent (nullable-by-design, positive control)', async () => {
    const parent = await request(adminApp).post('/api/admin/directory/local/departments').send({ name: fixtureName('parent-null-clear') })
    expect(parent.status).toBe(200)
    createdDepartmentIds.push(parent.body.data.department.id)
    const child = await request(adminApp)
      .post('/api/admin/directory/local/departments')
      .send({ name: fixtureName('child-null-clear'), parentDepartmentId: parent.body.data.department.id })
    expect(child.status).toBe(200)
    createdDepartmentIds.push(child.body.data.department.id)
    expect(child.body.data.department.parentDepartmentId).toBe(parent.body.data.department.id)

    const res = await request(adminApp)
      .patch(`/api/admin/directory/local/departments/${child.body.data.department.id}`)
      .send({ parentDepartmentId: null })

    expect(res.status).toBe(200)
    expect(res.body.data.department.parentDepartmentId).toBeNull()

    const row = await query<{ external_parent_department_id: string | null }>(
      `SELECT external_parent_department_id FROM directory_departments WHERE id = $1`,
      [child.body.data.department.id],
    )
    expect(row.rows[0].external_parent_department_id).toBeNull()
  })

  it('rejects a PATCH department with one valid field and one wrong-typed field — 400, NEITHER field is applied (no partial write)', async () => {
    const created = await request(adminApp).post('/api/admin/directory/local/departments').send({ name: fixtureName('no-partial-write-dept') })
    expect(created.status).toBe(200)
    const id = created.body.data.department.id as string
    createdDepartmentIds.push(id)
    const originalName = created.body.data.department.name as string

    const res = await request(adminApp)
      .patch(`/api/admin/directory/local/departments/${id}`)
      .send({ name: 'should-not-apply-either', parentDepartmentId: 123 })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('DIRECTORY_LOCAL_INVALID_INPUT')

    const row = await query<{ name: string; external_parent_department_id: string | null }>(
      `SELECT name, external_parent_department_id FROM directory_departments WHERE id = $1`,
      [id],
    )
    // The valid `name` change was NOT partially applied even though it appeared before the
    // wrong-typed `parentDepartmentId` in the same request body — the type gate rejects the
    // WHOLE request before either field is read into the update input.
    expect(row.rows[0]).toEqual({ name: originalName, external_parent_department_id: null })
  })

  it('rejects a create-account request smuggling corp_id (400, no row written)', async () => {
    const uid = await seedUser()
    createdUserIds.push(uid)

    const res = await request(adminApp).post('/api/admin/directory/local/accounts').send({ localUserId: uid, corp_id: 'evil-corp' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('DIRECTORY_LOCAL_UNKNOWN_FIELDS')

    const rows = await query(`SELECT 1 FROM directory_accounts WHERE external_user_id = $1`, [uid])
    expect(rows.rows.length).toBe(0)
  })

  it('creates an account over real HTTP, links it to the platform user, and writes one audit row', async () => {
    const uid = await seedUser()
    createdUserIds.push(uid)

    const res = await request(adminApp).post('/api/admin/directory/local/accounts').send({ localUserId: uid })

    expect(res.status).toBe(200)
    expect(res.body.data.account.localUserId).toBe(uid)
    expect(res.body.data.account.isActive).toBe(true)
    createdAccountIds.push(res.body.data.account.id)

    const audit = await query(`SELECT 1 FROM audit_logs WHERE action = 'directory.local_account.create' AND resource_id = $1`, [
      res.body.data.account.id,
    ])
    expect(audit.rows.length).toBe(1)
  })

  // ---- Account field TYPE validation (owner P2 on #4317, same class of bug as departments above:
  // email/mobile/title given a non-string, non-null value silently coerced to `null` and CLEARED
  // the stored value). ------------------------------------------------------------------------

  it('rejects a PATCH account email given as an object — 400, account left unchanged (owner-reported case, verbatim)', async () => {
    const uid = await seedUser()
    createdUserIds.push(uid)
    const created = await request(adminApp)
      .post('/api/admin/directory/local/accounts')
      .send({ localUserId: uid, email: 'keep@example.test', mobile: '10000000000', title: 'Keep Title' })
    expect(created.status).toBe(200)
    const id = created.body.data.account.id as string
    createdAccountIds.push(id)

    const res = await request(adminApp).patch(`/api/admin/directory/local/accounts/${id}`).send({ email: {} })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'DIRECTORY_LOCAL_INVALID_INPUT', message: 'email must be a string or null', details: undefined },
    })

    const row = await query<{ email: string | null; mobile: string | null; title: string | null }>(
      `SELECT email, mobile, title FROM directory_accounts WHERE id = $1`,
      [id],
    )
    expect(row.rows[0]).toEqual({ email: 'keep@example.test', mobile: '10000000000', title: 'Keep Title' })
  })

  it('rejects a PATCH account title given as an array — 400, account left unchanged (owner-reported case, verbatim)', async () => {
    const uid = await seedUser()
    createdUserIds.push(uid)
    const created = await request(adminApp)
      .post('/api/admin/directory/local/accounts')
      .send({ localUserId: uid, email: 'keep2@example.test', mobile: '20000000000', title: 'Keep Title 2' })
    expect(created.status).toBe(200)
    const id = created.body.data.account.id as string
    createdAccountIds.push(id)

    const res = await request(adminApp).patch(`/api/admin/directory/local/accounts/${id}`).send({ title: [] })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'DIRECTORY_LOCAL_INVALID_INPUT', message: 'title must be a string or null', details: undefined },
    })

    const row = await query<{ email: string | null; mobile: string | null; title: string | null }>(
      `SELECT email, mobile, title FROM directory_accounts WHERE id = $1`,
      [id],
    )
    expect(row.rows[0]).toEqual({ email: 'keep2@example.test', mobile: '20000000000', title: 'Keep Title 2' })
  })

  it.each([
    { name: 'mobile as a number', field: 'mobile', badValue: 42, expectedMessage: 'mobile must be a string or null' },
    { name: 'name as a number', field: 'name', badValue: 42, expectedMessage: 'name must be a string' },
    { name: 'name as explicit null (not nullable-by-design)', field: 'name', badValue: null, expectedMessage: 'name must be a string' },
  ])('rejects a PATCH account with $name — 400, account left unchanged', async ({ field, badValue, expectedMessage }) => {
    const uid = await seedUser()
    createdUserIds.push(uid)
    const created = await request(adminApp)
      .post('/api/admin/directory/local/accounts')
      .send({ localUserId: uid, email: 'stable@example.test', mobile: '30000000000', title: 'Stable Title' })
    const id = created.body.data.account.id as string
    createdAccountIds.push(id)

    const before = await query<{ name: string; email: string | null; mobile: string | null; title: string | null }>(
      `SELECT name, email, mobile, title FROM directory_accounts WHERE id = $1`,
      [id],
    )

    const res = await request(adminApp).patch(`/api/admin/directory/local/accounts/${id}`).send({ [field]: badValue })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('DIRECTORY_LOCAL_INVALID_INPUT')
    expect(res.body.error.message).toBe(expectedMessage)

    const after = await query<{ name: string; email: string | null; mobile: string | null; title: string | null }>(
      `SELECT name, email, mobile, title FROM directory_accounts WHERE id = $1`,
      [id],
    )
    expect(after.rows[0]).toEqual(before.rows[0])
  })

  it.each([
    { name: 'localUserId as a number', field: 'localUserId', badValue: 42, expectedMessage: 'localUserId must be a string' },
    { name: 'name as a number', field: 'name', badValue: 42, expectedMessage: 'name must be a string' },
    { name: 'email as an object', field: 'email', badValue: {}, expectedMessage: 'email must be a string or null' },
    { name: 'title as an array', field: 'title', badValue: [], expectedMessage: 'title must be a string or null' },
  ])('rejects a create-account request with $name — 400, no row written', async ({ field, badValue, expectedMessage }) => {
    const uid = await seedUser()
    createdUserIds.push(uid)
    const body: Record<string, unknown> = field === 'localUserId' ? { localUserId: badValue } : { localUserId: uid, [field]: badValue }

    const before = await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM directory_accounts`)

    const res = await request(adminApp).post('/api/admin/directory/local/accounts').send(body)

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('DIRECTORY_LOCAL_INVALID_INPUT')
    expect(res.body.error.message).toBe(expectedMessage)

    const after = await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM directory_accounts`)
    expect(after.rows[0].count).toBe(before.rows[0].count)

    if (field !== 'localUserId') {
      const rows = await query(`SELECT 1 FROM directory_accounts WHERE external_user_id = $1`, [uid])
      expect(rows.rows.length).toBe(0)
    }
  })

  it('PATCH account email/mobile/title: null clears all three (nullable-by-design, positive control)', async () => {
    const uid = await seedUser()
    createdUserIds.push(uid)
    const created = await request(adminApp)
      .post('/api/admin/directory/local/accounts')
      .send({ localUserId: uid, email: 'clear-me@example.test', mobile: '999', title: 'Clear Me' })
    expect(created.status).toBe(200)
    const id = created.body.data.account.id as string
    createdAccountIds.push(id)

    const res = await request(adminApp).patch(`/api/admin/directory/local/accounts/${id}`).send({ email: null, mobile: null, title: null })

    expect(res.status).toBe(200)
    expect(res.body.data.account.email).toBeNull()
    expect(res.body.data.account.mobile).toBeNull()
    expect(res.body.data.account.title).toBeNull()

    const row = await query<{ email: string | null; mobile: string | null; title: string | null }>(
      `SELECT email, mobile, title FROM directory_accounts WHERE id = $1`,
      [id],
    )
    expect(row.rows[0]).toEqual({ email: null, mobile: null, title: null })
  })

  it('rejects a PATCH account with one valid field and one wrong-typed field — 400, NEITHER field is applied (no partial write)', async () => {
    const uid = await seedUser()
    createdUserIds.push(uid)
    const created = await request(adminApp)
      .post('/api/admin/directory/local/accounts')
      .send({ localUserId: uid, email: 'no-partial@example.test', mobile: '40000000000', title: 'No Partial' })
    expect(created.status).toBe(200)
    const id = created.body.data.account.id as string
    createdAccountIds.push(id)

    const res = await request(adminApp)
      .patch(`/api/admin/directory/local/accounts/${id}`)
      .send({ mobile: '50000000000', title: [] })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('DIRECTORY_LOCAL_INVALID_INPUT')

    const row = await query<{ email: string | null; mobile: string | null; title: string | null }>(
      `SELECT email, mobile, title FROM directory_accounts WHERE id = $1`,
      [id],
    )
    // The valid `mobile` change was NOT partially applied even though it appeared before the
    // wrong-typed `title` in the same request body.
    expect(row.rows[0]).toEqual({ email: 'no-partial@example.test', mobile: '40000000000', title: 'No Partial' })
  })

  it('adds and switches a membership over real HTTP; rejects a primary-switch body smuggling org_id/corp_id', async () => {
    const uid = await seedUser()
    createdUserIds.push(uid)
    const acctRes = await request(adminApp).post('/api/admin/directory/local/accounts').send({ localUserId: uid })
    expect(acctRes.status).toBe(200)
    createdAccountIds.push(acctRes.body.data.account.id)
    const deptRes = await request(adminApp).post('/api/admin/directory/local/departments').send({ name: fixtureName('member-dept') })
    expect(deptRes.status).toBe(200)
    createdDepartmentIds.push(deptRes.body.data.department.id)

    const accountId = acctRes.body.data.account.id as string
    const departmentId = deptRes.body.data.department.id as string
    const membershipId = `${accountId}:${departmentId}`

    const addRes = await request(adminApp).post('/api/admin/directory/local/memberships').send({ accountId, departmentId })
    expect(addRes.status).toBe(200)
    expect(addRes.body.data.membership).toEqual({ id: membershipId, accountId, departmentId, isPrimary: false, createdAt: addRes.body.data.membership.createdAt })

    const smuggled = await request(adminApp)
      .patch(`/api/admin/directory/local/memberships/${membershipId}`)
      .send({ isPrimary: true, org_id: 'attacker-org', corp_id: 'evil-corp' })
    expect(smuggled.status).toBe(400)
    expect(smuggled.body.error.code).toBe('DIRECTORY_LOCAL_UNKNOWN_FIELDS')

    const stillNotPrimary = await query<{ is_primary: boolean }>(
      `SELECT is_primary FROM directory_account_departments WHERE directory_account_id = $1 AND directory_department_id = $2`,
      [accountId, departmentId],
    )
    expect(stillNotPrimary.rows[0].is_primary).toBe(false)

    const switchRes = await request(adminApp).patch(`/api/admin/directory/local/memberships/${membershipId}`).send({ isPrimary: true })
    expect(switchRes.status).toBe(200)
    expect(switchRes.body.data.membership.isPrimary).toBe(true)

    const row = await query<{ is_primary: boolean }>(
      `SELECT is_primary FROM directory_account_departments WHERE directory_account_id = $1 AND directory_department_id = $2`,
      [accountId, departmentId],
    )
    expect(row.rows[0].is_primary).toBe(true)

    const audit = await query(`SELECT 1 FROM audit_logs WHERE action = 'directory.local_membership.switch_primary' AND resource_id = $1`, [
      membershipId,
    ])
    expect(audit.rows.length).toBe(1)
  })

  it('rejects a primary-switch body that omits isPrimary:true, even with no smuggled fields (narrow-endpoint contract)', async () => {
    const uid = await seedUser()
    createdUserIds.push(uid)
    const acctRes = await request(adminApp).post('/api/admin/directory/local/accounts').send({ localUserId: uid })
    createdAccountIds.push(acctRes.body.data.account.id)
    const deptRes = await request(adminApp).post('/api/admin/directory/local/departments').send({ name: fixtureName('member-dept-narrow') })
    createdDepartmentIds.push(deptRes.body.data.department.id)

    const accountId = acctRes.body.data.account.id as string
    const departmentId = deptRes.body.data.department.id as string
    await request(adminApp).post('/api/admin/directory/local/memberships').send({ accountId, departmentId })

    const res = await request(adminApp)
      .patch(`/api/admin/directory/local/memberships/${accountId}:${departmentId}`)
      .send({ isPrimary: false })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('DIRECTORY_LOCAL_INVALID_INPUT')
  })

  // ---- Membership field TYPE validation (owner P2 on #4317, same allowlist-checks-names-only
  // gap; accountId/departmentId already 400'd via the required-field check before this fix, but
  // now get the same explicit type gate as every other endpoint for consistency). ---------------

  it.each([
    { name: 'accountId as a number', field: 'accountId', expectedMessage: 'accountId must be a string' },
    { name: 'departmentId as a number', field: 'departmentId', expectedMessage: 'departmentId must be a string' },
  ])('rejects an add-membership request with $name — 400, no row written', async ({ field, expectedMessage }) => {
    const uid = await seedUser()
    createdUserIds.push(uid)
    const acctRes = await request(adminApp).post('/api/admin/directory/local/accounts').send({ localUserId: uid })
    createdAccountIds.push(acctRes.body.data.account.id)
    const deptRes = await request(adminApp).post('/api/admin/directory/local/departments').send({ name: fixtureName('member-type-dept') })
    createdDepartmentIds.push(deptRes.body.data.department.id)

    const accountId = acctRes.body.data.account.id as string
    const departmentId = deptRes.body.data.department.id as string
    const body: Record<string, unknown> = { accountId, departmentId, [field]: 42 }

    const res = await request(adminApp).post('/api/admin/directory/local/memberships').send(body)

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('DIRECTORY_LOCAL_INVALID_INPUT')
    expect(res.body.error.message).toBe(expectedMessage)

    const rows = await query(
      `SELECT 1 FROM directory_account_departments WHERE directory_account_id = $1 AND directory_department_id = $2`,
      [accountId, departmentId],
    )
    expect(rows.rows.length).toBe(0)
  })

  it('rejects a primary-switch body where isPrimary is a string, not the boolean literal true — 400 (boolean-type coverage, no state change)', async () => {
    const uid = await seedUser()
    createdUserIds.push(uid)
    const acctRes = await request(adminApp).post('/api/admin/directory/local/accounts').send({ localUserId: uid })
    createdAccountIds.push(acctRes.body.data.account.id)
    const deptRes = await request(adminApp).post('/api/admin/directory/local/departments').send({ name: fixtureName('member-bool-dept') })
    createdDepartmentIds.push(deptRes.body.data.department.id)
    const accountId = acctRes.body.data.account.id as string
    const departmentId = deptRes.body.data.department.id as string
    await request(adminApp).post('/api/admin/directory/local/memberships').send({ accountId, departmentId })

    const res = await request(adminApp)
      .patch(`/api/admin/directory/local/memberships/${accountId}:${departmentId}`)
      .send({ isPrimary: 'true' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('DIRECTORY_LOCAL_INVALID_INPUT')

    const row = await query<{ is_primary: boolean }>(
      `SELECT is_primary FROM directory_account_departments WHERE directory_account_id = $1 AND directory_department_id = $2`,
      [accountId, departmentId],
    )
    expect(row.rows[0].is_primary).toBe(false)
  })

  it('rejects requests from an authenticated non-admin user (403, no row written)', async () => {
    const deptName = fixtureName('forbidden-dept')
    const res = await request(nonAdminApp).post('/api/admin/directory/local/departments').send({ name: deptName })

    expect(res.status).toBe(403)

    const rows = await query(`SELECT 1 FROM directory_departments WHERE name = $1`, [deptName])
    expect(rows.rows.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------
// Allowlist ↔ type-spec drift guard (gate NIT-2): the *_FIELDS name allowlists and the
// *_FIELD_TYPES specs are hand-maintained in parallel. A field added to an allowlist WITHOUT a
// matching type spec would pass the type gate unchecked — the exact coercion bug class this PR
// closes. Set-equality per endpoint makes that drift impossible to land silently.
// UPDATE_LOCAL_MEMBERSHIP (B3 #4215 §5.4) now DOES carry a *_FIELD_TYPES pair: `isManager` accepts
// both true/false and so needs a real boolean type gate, and `isPrimary` gets a boolean spec too so
// the pair stays set-equal here (its stricter literal `!== true` check still runs in the route on
// top of the type gate).
// ---------------------------------------------------------------------------------------------

describe('allowlist ↔ type-spec parity (drift guard)', () => {
  const PAIRS: Array<[string, readonly string[], readonly { field: string }[]]> = [
    ['CREATE_LOCAL_DEPARTMENT', CREATE_LOCAL_DEPARTMENT_FIELDS, CREATE_LOCAL_DEPARTMENT_FIELD_TYPES],
    ['UPDATE_LOCAL_DEPARTMENT', UPDATE_LOCAL_DEPARTMENT_FIELDS, UPDATE_LOCAL_DEPARTMENT_FIELD_TYPES],
    ['CREATE_LOCAL_ACCOUNT', CREATE_LOCAL_ACCOUNT_FIELDS, CREATE_LOCAL_ACCOUNT_FIELD_TYPES],
    ['UPDATE_LOCAL_ACCOUNT', UPDATE_LOCAL_ACCOUNT_FIELDS, UPDATE_LOCAL_ACCOUNT_FIELD_TYPES],
    ['ADD_LOCAL_MEMBERSHIP', ADD_LOCAL_MEMBERSHIP_FIELDS, ADD_LOCAL_MEMBERSHIP_FIELD_TYPES],
    ['UPDATE_LOCAL_MEMBERSHIP', UPDATE_LOCAL_MEMBERSHIP_FIELDS, UPDATE_LOCAL_MEMBERSHIP_FIELD_TYPES],
  ]

  for (const [label, fields, specs] of PAIRS) {
    it(`${label}: every allowed field has exactly one type spec`, () => {
      const allow = [...fields].sort()
      const typed = specs.map((s) => s.field).sort()
      expect(typed).toEqual(allow)
    })
  }
})

// -------------------------------------------------------------------------------------------
// PB4-1 (owner ticket: membership input validation + primary-switch atomicity). Each guard gets
// a rejection leg AND a positive control so none can pass vacuously. PB4-2/3/4 land separately.
// -------------------------------------------------------------------------------------------
describeIfDatabase('PB4-1 — input validation + atomic primary switch (real DB, HTTP)', () => {
  const deptIds: string[] = []
  const accountIds: string[] = []
  const userIds: string[] = []

  afterEach(async () => {
    for (const id of deptIds.splice(0)) await query(`DELETE FROM directory_departments WHERE id = $1`, [id])
    for (const id of accountIds.splice(0)) await query(`DELETE FROM directory_accounts WHERE id = $1`, [id])
    for (const id of userIds.splice(0)) await query(`DELETE FROM users WHERE id = $1`, [id])
  })

  async function mkDept(name: string, parentDepartmentId?: string): Promise<string> {
    const res = await request(adminApp)
      .post('/api/admin/directory/local/departments')
      .send(parentDepartmentId ? { name, parentDepartmentId } : { name })
    expect(res.status).toBe(200)
    deptIds.push(res.body.data.department.id)
    return res.body.data.department.id
  }

  async function mkAccount(tag: string): Promise<string> {
    const userId = await seedUser()
    userIds.push(userId)
    const res = await request(adminApp)
      .post('/api/admin/directory/local/accounts')
      .send({ localUserId: userId, name: fixtureName(tag) })
    expect(res.status).toBe(200)
    accountIds.push(res.body.data.account.id)
    return res.body.data.account.id
  }

  // ---- item 1: non-UUID :id params are a 400, never a 500 --------------------------------
  it('item 1: non-UUID membershipId ("foo:bar") is a 400, not a 500 at the ::uuid cast — and writes ZERO audit rows', async () => {
    const res = await request(adminApp).patch('/api/admin/directory/local/memberships/foo:bar').send({ isPrimary: true })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('DIRECTORY_LOCAL_INVALID_INPUT')
    // Scoped to THIS request's would-be resource (parallel-safe in the shared-DB run — a global
    // action-prefix count races other tests' writes): a rejected request emits nothing.
    const audit = await query(`SELECT 1 FROM audit_logs WHERE resource_id = 'foo:bar'`)
    expect(audit.rows.length).toBe(0)
  })

  it('item 1: non-UUID departmentId / accountId route params are a 400, not a 500 (zero audit rows)', async () => {
    const dept = await request(adminApp).patch('/api/admin/directory/local/departments/not-a-uuid').send({ name: 'x' })
    expect(dept.status).toBe(400)
    expect(dept.body.error.code).toBe('DIRECTORY_LOCAL_INVALID_INPUT')

    const arch = await request(adminApp).post('/api/admin/directory/local/departments/not-a-uuid/archive').send({})
    expect(arch.status).toBe(400)

    const acct = await request(adminApp).patch('/api/admin/directory/local/accounts/also-not-a-uuid').send({ name: 'x' })
    expect(acct.status).toBe(400)

    const acctArch = await request(adminApp).post('/api/admin/directory/local/accounts/also-not-a-uuid/archive').send({})
    expect(acctArch.status).toBe(400)

    // The invalid tokens can never be a real audit resource_id (which is always a uuid or uuid:uuid).
    const audit = await query(`SELECT 1 FROM audit_logs WHERE resource_id IN ('not-a-uuid', 'also-not-a-uuid')`)
    expect(audit.rows.length).toBe(0)
  })






  // ---- item 5: single-UPDATE primary switch cannot demote-then-miss ------------------------
  it('item 5: a primary switch to a NONEXISTENT membership is a 404 AND leaves the existing primary undemoted', async () => {
    const acct = await mkAccount('no-demote')
    const d1 = await mkDept(fixtureName('no-demote-d1'))
    const d2 = await mkDept(fixtureName('no-demote-d2'))
    await request(adminApp).post('/api/admin/directory/local/memberships').send({ accountId: acct, departmentId: d1 })
    const mkPrimary = await request(adminApp).patch(`/api/admin/directory/local/memberships/${acct}:${d1}`).send({ isPrimary: true })
    expect(mkPrimary.status).toBe(200)

    // d2 exists as a department but the (acct, d2) MEMBERSHIP does not — the old two-step shape
    // would have demoted d1 before discovering that; the single atomic UPDATE's EXISTS guard
    // makes the whole statement update zero rows instead.
    const missing = await request(adminApp).patch(`/api/admin/directory/local/memberships/${acct}:${d2}`).send({ isPrimary: true })
    expect(missing.status).toBe(404)

    const still = await query<{ is_primary: boolean }>(
      `SELECT is_primary FROM directory_account_departments WHERE directory_account_id = $1 AND directory_department_id = $2`,
      [acct, d1],
    )
    expect(still.rows).toEqual([{ is_primary: true }])
  })
})

// PB4-1, body-carried surface (gate P3-1 of the earlier bundled review): non-UUID ids arriving
// in REQUEST BODIES also used to reach uuid-column casts as 500s.
describeIfDatabase('PB4-1 — body-carried id fields are 400 on non-UUID', () => {
  const deptIds: string[] = []
  afterEach(async () => {
    for (const id of deptIds.splice(0)) await query(`DELETE FROM directory_departments WHERE id = $1`, [id])
  })

  it('POST /memberships with non-UUID body ids is a 400, not a 500 — and writes ZERO audit rows', async () => {
    const res = await request(adminApp)
      .post('/api/admin/directory/local/memberships')
      .send({ accountId: 'not-a-uuid', departmentId: 'also-not-a-uuid' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('DIRECTORY_LOCAL_INVALID_INPUT')
    const audit = await query(`SELECT 1 FROM audit_logs WHERE resource_id IN ('not-a-uuid', 'also-not-a-uuid', 'not-a-uuid:also-not-a-uuid')`)
    expect(audit.rows.length).toBe(0)
  })

  it('POST and PATCH /departments with a non-UUID parentDepartmentId string are 400s, not 500s', async () => {
    const create = await request(adminApp)
      .post('/api/admin/directory/local/departments')
      .send({ name: fixtureName('p31-create'), parentDepartmentId: 'not-a-uuid' })
    expect(create.status).toBe(400)

    const mk = await request(adminApp).post('/api/admin/directory/local/departments').send({ name: fixtureName('p31-victim') })
    expect(mk.status).toBe(200)
    deptIds.push(mk.body.data.department.id)
    const patch = await request(adminApp)
      .patch(`/api/admin/directory/local/departments/${mk.body.data.department.id}`)
      .send({ parentDepartmentId: 'not-a-uuid' })
    expect(patch.status).toBe(400)
  })
})

// PB4-2 owner round: a switch-primary whose TARGET membership is provider-MISLABELED (a
// dingtalk-provider department under the SAME local integration) must be a 404 (not a valid local
// membership to make primary), NOT a 409 — proven at the HTTP route layer, with zero audit and no
// primary bits changed. This pins the `targetRow.provider !== 'local'` predicate that the
// service-layer cross-scope test (which only varied integration) could not (deleting only the
// provider predicate leaves the service file green; this route test reddens instead).
describeIfDatabase('PB4-2 — provider-mislabeled switch TARGET is 404 at the route (real DB, HTTP)', () => {
  const deptIds: string[] = []
  const accountIds: string[] = []
  const userIds: string[] = []
  const rawDeptIds: string[] = []

  afterEach(async () => {
    for (const id of rawDeptIds.splice(0)) await query(`DELETE FROM directory_departments WHERE id = $1`, [id])
    for (const id of deptIds.splice(0)) await query(`DELETE FROM directory_departments WHERE id = $1`, [id])
    for (const id of accountIds.splice(0)) await query(`DELETE FROM directory_accounts WHERE id = $1`, [id])
    for (const id of userIds.splice(0)) await query(`DELETE FROM users WHERE id = $1`, [id])
  })

  it('PATCH primary to a dingtalk-provider target under the local integration → 404, zero switch_primary audit, primaries unchanged', async () => {
    const userId = await seedUser()
    userIds.push(userId)
    const acctRes = await request(adminApp).post('/api/admin/directory/local/accounts').send({ localUserId: userId, name: fixtureName('mt-acct') })
    expect(acctRes.status).toBe(200)
    const accountId = acctRes.body.data.account.id as string
    accountIds.push(accountId)

    const deptRes = await request(adminApp).post('/api/admin/directory/local/departments').send({ name: fixtureName('mt-local-dept') })
    expect(deptRes.status).toBe(200)
    const localDeptId = deptRes.body.data.department.id as string
    deptIds.push(localDeptId)

    // legit local membership, made primary through the real route.
    expect((await request(adminApp).post('/api/admin/directory/local/memberships').send({ accountId, departmentId: localDeptId })).status).toBe(200)
    expect((await request(adminApp).patch(`/api/admin/directory/local/memberships/${accountId}:${localDeptId}`).send({ isPrimary: true })).status).toBe(200)

    // the org's active local integration (the route resolves org 'default'), then a provider-MISLABELED
    // department under it + a raw membership — the malformed shape a provider sync could produce.
    const integ = await query<{ id: string }>(`SELECT id FROM directory_integrations WHERE org_id = 'default' AND provider = 'local' AND status = 'active'`)
    const integrationId = integ.rows[0].id
    const dtDept = await query<{ id: string }>(
      `INSERT INTO directory_departments (integration_id, provider, external_department_id, name, is_active, raw)
       VALUES ($1, 'dingtalk', $2, $3, true, '{}'::jsonb) RETURNING id`,
      [integrationId, `dingtalk:${STAMP}:mt-target`, 'Mislabeled Target'],
    )
    const dtDeptId = dtDept.rows[0].id
    rawDeptIds.push(dtDeptId)
    await query(`INSERT INTO directory_account_departments (directory_account_id, directory_department_id, is_primary) VALUES ($1, $2, false)`, [accountId, dtDeptId])

    const auditBefore = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs WHERE action = 'directory.local_membership.switch_primary' AND resource_id = $1`,
      [`${accountId}:${dtDeptId}`],
    )
    const res = await request(adminApp).patch(`/api/admin/directory/local/memberships/${accountId}:${dtDeptId}`).send({ isPrimary: true })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('DIRECTORY_LOCAL_NOT_FOUND')

    const auditAfter = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs WHERE action = 'directory.local_membership.switch_primary' AND resource_id = $1`,
      [`${accountId}:${dtDeptId}`],
    )
    expect(auditAfter.rows[0]?.n).toBe(auditBefore.rows[0]?.n) // zero switch_primary audit on the rejected path

    // primary bits unchanged: the legit local dept stays primary, the mislabeled target stays non-primary.
    const primaries = await query<{ directory_department_id: string; is_primary: boolean }>(
      `SELECT directory_department_id, is_primary FROM directory_account_departments WHERE directory_account_id = $1 ORDER BY directory_department_id`,
      [accountId],
    )
    const primaryMap = new Map(primaries.rows.map((r) => [r.directory_department_id, r.is_primary]))
    expect(primaryMap.get(localDeptId)).toBe(true)
    expect(primaryMap.get(dtDeptId)).toBe(false)
  })
})
