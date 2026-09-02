import net from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fetch as undiciFetch } from 'undici'
import { MetaSheetServer } from '../../src/index'
import { query } from '../../src/db/pg'
import { poolManager } from '../../src/integration/db/connection-pool'
import {
  ensureApprovalSchemaReady,
  grantApprovalWriteForIntegrationActor,
} from '../helpers/approval-schema-bootstrap'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const REQUESTER = `l2a-requester-${TS}`
const APPROVER = `l2a-approver-${TS}`
const KEY = `l2a-department-${TS}`

async function canListen(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function token(baseUrl: string, userId: string): Promise<string> {
  await grantApprovalWriteForIntegrationActor(userId)
  const response = await undiciFetch(
    `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`,
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { token: string }).token
}

async function request(
  baseUrl: string,
  path: string,
  authToken: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return undiciFetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${authToken}`,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
}

describeIfDatabase('Lock-2 L2-A department field (real DB)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let requesterToken = ''
  let templateId = ''
  let integrationA = ''
  let integrationB = ''
  let departmentA = ''
  let childDepartmentA = ''
  let inactiveDepartmentA = ''
  let departmentB = ''

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    await ensureApprovalSchemaReady()
    for (const userId of [REQUESTER, APPROVER]) {
      await query(
        `INSERT INTO users (id, email, name, password_hash, role, is_admin)
         VALUES ($1, $2, $3, 'x', $4, $5)
         ON CONFLICT (id) DO UPDATE
           SET is_active = true, name = EXCLUDED.name, role = EXCLUDED.role, is_admin = EXCLUDED.is_admin`,
        [userId, `${userId}@example.test`, userId, userId === REQUESTER ? 'admin' : 'user', userId === REQUESTER],
      )
    }

    integrationA = (await query<{ id: string }>(
      `INSERT INTO directory_integrations (name, corp_id)
       VALUES ($1, $2) RETURNING id`,
      [`L2-A A ${TS}`, `l2a-corp-a-${TS}`],
    )).rows[0].id
    integrationB = (await query<{ id: string }>(
      `INSERT INTO directory_integrations (name, corp_id)
       VALUES ($1, $2) RETURNING id`,
      [`L2-A B ${TS}`, `l2a-corp-b-${TS}`],
    )).rows[0].id

    departmentA = (await query<{ id: string }>(
      `INSERT INTO directory_departments
         (integration_id, external_department_id, name, full_path, is_active, raw)
       VALUES ($1, $2, '产品部', '总部 / 产品部', true, '{}'::jsonb)
       RETURNING id`,
      [integrationA, `l2a-dept-a-${TS}`],
    )).rows[0].id
    childDepartmentA = (await query<{ id: string }>(
      `INSERT INTO directory_departments
         (integration_id, external_department_id, external_parent_department_id, name, full_path, is_active, raw)
       VALUES ($1, $2, $3, '产品一组', '总部 / 产品部 / 产品一组', true, '{}'::jsonb)
       RETURNING id`,
      [integrationA, `l2a-dept-child-${TS}`, `l2a-dept-a-${TS}`],
    )).rows[0].id
    inactiveDepartmentA = (await query<{ id: string }>(
      `INSERT INTO directory_departments
         (integration_id, external_department_id, name, full_path, is_active, raw)
       VALUES ($1, $2, '停用产品部', '总部 / 停用产品部', false, '{}'::jsonb)
       RETURNING id`,
      [integrationA, `l2a-dept-inactive-${TS}`],
    )).rows[0].id
    departmentB = (await query<{ id: string }>(
      `INSERT INTO directory_departments
         (integration_id, external_department_id, name, full_path, is_active, raw)
       VALUES ($1, $2, '产品部', '外部 / 产品部', true, '{}'::jsonb)
       RETURNING id`,
      [integrationB, `l2a-dept-b-${TS}`],
    )).rows[0].id

    const accountId = (await query<{ id: string }>(
      `INSERT INTO directory_accounts
         (integration_id, external_user_id, external_key, name, is_active, raw)
       VALUES ($1, $2, $2, 'L2-A Requester', true, '{}'::jsonb)
       RETURNING id`,
      [integrationA, `l2a-account-${TS}`],
    )).rows[0].id
    await query(
      `INSERT INTO directory_account_links
         (directory_account_id, local_user_id, link_status, match_strategy)
       VALUES ($1, $2, 'linked', 'manual')`,
      [accountId, REQUESTER],
    )
    await query(
      `INSERT INTO directory_account_departments
         (directory_account_id, directory_department_id, is_primary)
       VALUES ($1, $2, true)`,
      [accountId, departmentA],
    )

    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    baseUrl = `http://127.0.0.1:${server.getAddress()!.port}`
    requesterToken = await token(baseUrl, REQUESTER)

    const created = await request(baseUrl, '/api/approval-templates', requesterToken, {
      method: 'POST',
      body: {
        key: KEY,
        name: 'Department field',
        formSchema: {
          fields: [{
            id: 'department',
            type: 'department',
            label: '部门',
            required: true,
            props: { selection: 'single', display: 'full_path' },
          }],
        },
        approvalGraph: {
          nodes: [
            { key: 'start', type: 'start', config: {} },
            { key: 'approve', type: 'approval', config: { assigneeSources: [{ kind: 'static_user', userIds: [APPROVER] }] } },
            { key: 'end', type: 'end', config: {} },
          ],
          edges: [
            { key: 's-a', source: 'start', target: 'approve' },
            { key: 'a-e', source: 'approve', target: 'end' },
          ],
        },
      },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    templateId = ((await created.json()) as { id: string }).id
    const published = await request(
      baseUrl,
      `/api/approval-templates/${templateId}/publish`,
      requesterToken,
      { method: 'POST', body: { policy: { allowRevoke: true } } },
    )
    expect(published.status, await published.clone().text()).toBe(200)
  })

  afterAll(async () => {
    try {
      const pool = poolManager.get()
      const instanceIds = (await pool.query<{ id: string }>(
        'SELECT id FROM approval_instances WHERE template_id = $1',
        [templateId],
      )).rows.map((row) => row.id)
      if (instanceIds.length > 0) {
        await pool.query('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [instanceIds])
        await pool.query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [instanceIds])
        await pool.query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [instanceIds])
      }
      await pool.query('DELETE FROM approval_published_definitions WHERE template_id = $1', [templateId])
      await pool.query('DELETE FROM approval_templates WHERE id = $1', [templateId])
      await pool.query('DELETE FROM directory_accounts WHERE integration_id = ANY($1::uuid[])', [[integrationA, integrationB]])
      await pool.query('DELETE FROM directory_departments WHERE integration_id = ANY($1::uuid[])', [[integrationA, integrationB]])
      await pool.query('DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])', [[integrationA, integrationB]])
      await pool.query('DELETE FROM users WHERE id = ANY($1::varchar[])', [[REQUESTER, APPROVER]])
      const residue = (await pool.query<{
        users: string
        integrations: string
        templates: string
      }>(
        `SELECT
           (SELECT COUNT(*)::text FROM users WHERE id LIKE 'l2a-%') AS users,
           (SELECT COUNT(*)::text FROM directory_integrations WHERE corp_id LIKE 'l2a-%') AS integrations,
           (SELECT COUNT(*)::text FROM approval_templates WHERE key LIKE 'l2a-%') AS templates`,
      )).rows[0]
      expect(residue).toEqual({ users: '0', integrations: '0', templates: '0' })
    } finally {
      if (server) await server.stop()
    }
  })

  it('lists only active departments from the requester canonical integration with minimal shape', async () => {
    const response = await request(
      baseUrl,
      `/api/approvals/directory/departments?q=${encodeURIComponent('产品部')}`,
      requesterToken,
    )
    expect(response.status, await response.clone().text()).toBe(200)
    const body = (await response.json()) as {
      departments: Array<Record<string, unknown>>
      requesterDepartmentId?: string
    }
    expect(body.requesterDepartmentId).toBe(departmentA)
    expect(body.departments).toEqual([
      {
        id: departmentA,
        name: '产品部',
        fullPath: '总部 / 产品部',
        hasChildren: true,
      },
      {
        id: childDepartmentA,
        name: '产品一组',
        fullPath: '总部 / 产品部 / 产品一组',
        parentId: departmentA,
        hasChildren: false,
      },
    ])
    expect(JSON.stringify(body)).not.toContain(integrationA)
    expect(JSON.stringify(body)).not.toContain(integrationB)
    expect(JSON.stringify(body)).not.toContain(departmentB)
  })

  it('browses the canonical department tree without exposing integration/provider ids', async () => {
    const roots = await request(
      baseUrl,
      '/api/approvals/directory/departments?mode=tree&limit=50',
      requesterToken,
    )
    expect(roots.status, await roots.clone().text()).toBe(200)
    const rootBody = (await roots.json()) as { departments: Array<Record<string, unknown>> }
    expect(rootBody.departments).toContainEqual({
      id: departmentA,
      name: '产品部',
      fullPath: '总部 / 产品部',
      hasChildren: true,
    })
    expect(JSON.stringify(rootBody)).not.toContain(integrationA)

    const children = await request(
      baseUrl,
      `/api/approvals/directory/departments?mode=tree&parentId=${departmentA}&limit=50`,
      requesterToken,
    )
    expect(children.status, await children.clone().text()).toBe(200)
    expect((await children.json() as { departments: unknown[] }).departments).toEqual([{
      id: childDepartmentA,
      name: '产品一组',
      fullPath: '总部 / 产品部 / 产品一组',
      parentId: departmentA,
      hasChildren: false,
    }])
  })

  it('does not prefill a requester primary department after that department is inactive', async () => {
    await query('UPDATE directory_departments SET is_active = false WHERE id = $1', [departmentA])
    try {
      const response = await request(
        baseUrl,
        '/api/approvals/directory/departments?limit=50',
        requesterToken,
      )
      expect(response.status, await response.clone().text()).toBe(200)
      const body = (await response.json()) as {
        departments: Array<{ id: string }>
        requesterDepartmentId?: string
      }
      expect(body.requesterDepartmentId).toBeUndefined()
      expect(body.departments.map((entry) => entry.id)).not.toContain(departmentA)
    } finally {
      await query('UPDATE directory_departments SET is_active = true WHERE id = $1', [departmentA])
    }
  })

  it('freezes canonical display values and a later rename cannot rewrite the instance snapshot', async () => {
    const created = await request(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { department: [{ id: departmentA }] } },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const instanceId = ((await created.json()) as { id: string }).id
    const before = (await query<{ form_snapshot: Record<string, unknown> }>(
      'SELECT form_snapshot FROM approval_instances WHERE id = $1',
      [instanceId],
    )).rows[0].form_snapshot
    expect(before.department).toEqual([{
      id: departmentA,
      name: '产品部',
      fullPath: '总部 / 产品部',
    }])

    await query("UPDATE directory_departments SET name = '新产品部', full_path = '总部 / 新产品部' WHERE id = $1", [departmentA])
    const after = (await query<{ form_snapshot: Record<string, unknown> }>(
      'SELECT form_snapshot FROM approval_instances WHERE id = $1',
      [instanceId],
    )).rows[0].form_snapshot
    expect(after).toEqual(before)
  })

  it('rejects inactive and foreign-integration ids with one values-free shape and no new instance', async () => {
    const before = Number((await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM approval_instances WHERE template_id = $1',
      [templateId],
    )).rows[0].count)
    for (const id of [inactiveDepartmentA, departmentB]) {
      const response = await request(baseUrl, '/api/approvals', requesterToken, {
        method: 'POST',
        body: { templateId, formData: { department: [{ id }] } },
      })
      expect(response.status).toBe(422)
      const text = await response.text()
      expect(text).toContain('APPROVAL_DEPARTMENT_UNRESOLVED')
      expect(text).not.toContain(id)
    }
    const after = Number((await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM approval_instances WHERE template_id = $1',
      [templateId],
    )).rows[0].count)
    expect(after).toBe(before)
  })

  it('rejects caller-selected org/integration query parameters', async () => {
    for (const key of ['orgId', 'integrationId']) {
      const response = await request(
        baseUrl,
        `/api/approvals/directory/departments?${key}=forbidden`,
        requesterToken,
      )
      expect(response.status).toBe(400)
      expect(await response.text()).toContain('VALIDATION_ERROR')
    }
    const invalidParent = await request(
      baseUrl,
      '/api/approvals/directory/departments?mode=tree&parentId=not-a-uuid',
      requesterToken,
    )
    expect(invalidParent.status).toBe(400)

    for (const limit of ['0', '51']) {
      const invalidLimit = await request(
        baseUrl,
        `/api/approvals/directory/departments?limit=${limit}`,
        requesterToken,
      )
      expect(invalidLimit.status).toBe(400)
      expect(await invalidLimit.text()).toContain('VALIDATION_ERROR')
    }
  })
})
