import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

/**
 * RA-1a requester.department dispatch seam — real DB + real HTTP action.
 *
 * Unit tests cover the evaluator and ApprovalDirectoryOrg. This proves the
 * seam that can regress during service refactors:
 * directory_departments.name -> createApproval requester_snapshot.directoryDepartment
 * -> persisted JSONB reload -> dispatchAction requesterContext -> formula branch.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const REQUESTER = `ra1a-req-${TS}`
const FINANCE_APPROVER = `ra1a-finance-${TS}`
const DEFAULT_APPROVER = `ra1a-default-${TS}`
const INTEGRATION_NAME = `ra1a-dir-${TS}`
const CORP_ID = `ra1a-corp-${TS}`
const DEPT_EXTERNAL_ID = `ra1a-dept-${TS}`
const DEPT_NAME = '财务'

async function canListen(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function token(baseUrl: string, userId: string): Promise<string> {
  const response = await fetch(
    `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`,
  )
  return ((await response.json()) as { token: string }).token
}

async function api(
  baseUrl: string,
  path: string,
  authToken: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${authToken}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
}

function requesterDepartmentGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      {
        key: 'requester_review',
        type: 'approval',
        name: '发起人确认',
        config: {
          assigneeSources: [{ kind: 'static_user', userIds: [REQUESTER] }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'error',
        },
      },
      {
        key: 'dept_gate',
        type: 'condition',
        name: '部门路由',
        config: {
          branches: [{
            edgeKey: 'edge-finance',
            rules: [],
            formula: { expression: 'requester.department == "财务"' },
          }],
          defaultEdgeKey: 'edge-default',
        },
      },
      {
        key: 'finance_review',
        type: 'approval',
        name: '财务审批',
        config: {
          assigneeSources: [{ kind: 'static_user', userIds: [FINANCE_APPROVER] }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'error',
        },
      },
      {
        key: 'default_review',
        type: 'approval',
        name: '默认审批',
        config: {
          assigneeSources: [{ kind: 'static_user', userIds: [DEFAULT_APPROVER] }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'error',
        },
      },
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'edge-start-requester', source: 'start', target: 'requester_review' },
      { key: 'edge-requester-gate', source: 'requester_review', target: 'dept_gate' },
      { key: 'edge-finance', source: 'dept_gate', target: 'finance_review' },
      { key: 'edge-default', source: 'dept_gate', target: 'default_review' },
      { key: 'edge-finance-end', source: 'finance_review', target: 'end' },
      { key: 'edge-default-end', source: 'default_review', target: 'end' },
    ],
  }
}

describeIfDatabase('RA-1a requester.department formula dispatch seam (real DB)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let requesterToken = ''
  let templateId = ''
  let integrationId = ''

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    await ensureApprovalSchemaReady()

    const pool = poolManager.get()
    await pool.query(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1, $2, $3, 'x', 'user', '[]'::jsonb, TRUE, FALSE),
              ($4, $5, $6, 'x', 'user', '[]'::jsonb, TRUE, FALSE),
              ($7, $8, $9, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO NOTHING`,
      [
        REQUESTER, `${REQUESTER}@example.test`, REQUESTER,
        FINANCE_APPROVER, `${FINANCE_APPROVER}@example.test`, FINANCE_APPROVER,
        DEFAULT_APPROVER, `${DEFAULT_APPROVER}@example.test`, DEFAULT_APPROVER,
      ],
    )
    integrationId = (await pool.query<{ id: string }>(
      `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id`,
      [INTEGRATION_NAME, CORP_ID],
    )).rows[0].id
    const departmentId = (await pool.query<{ id: string }>(
      `INSERT INTO directory_departments (integration_id, external_department_id, name, is_active, raw)
       VALUES ($1, $2, $3, TRUE, '{}'::jsonb) RETURNING id`,
      [integrationId, DEPT_EXTERNAL_ID, DEPT_NAME],
    )).rows[0].id
    const accountId = (await pool.query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, raw)
       VALUES ($1, $2, $3, $4, '{}'::jsonb) RETURNING id`,
      [integrationId, `ext-${REQUESTER}`, `key-${REQUESTER}`, REQUESTER],
    )).rows[0].id
    await pool.query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
       VALUES ($1, $2, 'linked', 'manual')`,
      [accountId, REQUESTER],
    )
    await pool.query(
      `INSERT INTO directory_account_departments (directory_account_id, directory_department_id, is_primary)
       VALUES ($1, $2, TRUE)`,
      [accountId, departmentId],
    )

    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    baseUrl = `http://127.0.0.1:${server.getAddress()!.port}`
    requesterToken = await token(baseUrl, REQUESTER)

    const created = await api(baseUrl, '/api/approval-templates', requesterToken, {
      method: 'POST',
      body: {
        key: `ra1a-dispatch-${TS}`,
        name: `RA1a dispatch ${TS}`,
        formSchema: { fields: [{ id: 'reason', type: 'text', label: '原因', required: true }] },
        approvalGraph: requesterDepartmentGraph(),
      },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    templateId = ((await created.json()) as { id: string }).id
    const published = await api(baseUrl, `/api/approval-templates/${templateId}/publish`, requesterToken, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
    expect(published.status, await published.clone().text()).toBe(200)
  })

  afterAll(async () => {
    try {
      const pool = poolManager.get()
      if (templateId) {
        const instanceIds = (await pool.query<{ id: string }>(
          `SELECT id FROM approval_instances WHERE template_id = $1`,
          [templateId],
        )).rows.map((row) => row.id)
        if (instanceIds.length > 0) {
          await pool.query(`DELETE FROM approval_records WHERE instance_id = ANY($1)`, [instanceIds])
          await pool.query(`DELETE FROM approval_assignments WHERE instance_id = ANY($1)`, [instanceIds])
          await pool.query(`DELETE FROM approval_instances WHERE id = ANY($1)`, [instanceIds])
        }
        await pool.query(`DELETE FROM approval_published_definitions WHERE template_id = $1`, [templateId])
        await pool.query(`DELETE FROM approval_template_versions WHERE template_id = $1`, [templateId])
        await pool.query(`DELETE FROM approval_templates WHERE id = $1`, [templateId])
      }
      if (integrationId) {
        await pool.query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
      }
      await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [[REQUESTER, FINANCE_APPROVER, DEFAULT_APPROVER]])
    } catch {
      /* best effort */
    }
    if (server) await server.stop()
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('freezes directoryDepartment at create, then reloads it at dispatch to route requester.department', async () => {
    const started = await api(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'dispatch seam' } },
    })
    expect(started.status, await started.clone().text()).toBe(201)
    const startedBody = (await started.json()) as { id?: string; data?: { id?: string } }
    const approvalId = startedBody.id ?? startedBody.data?.id
    expect(approvalId).toBeTruthy()

    const pool = poolManager.get()
    const snapshot = (await pool.query<{ requester_snapshot: { directoryDepartment?: string } }>(
      `SELECT requester_snapshot FROM approval_instances WHERE id = $1`,
      [approvalId],
    )).rows[0]?.requester_snapshot
    expect(snapshot?.directoryDepartment).toBe(DEPT_NAME)

    const advanced = await api(baseUrl, `/api/approvals/${approvalId}/actions`, requesterToken, {
      method: 'POST',
      body: { action: 'approve', comment: 'route by department' },
    })
    expect(advanced.status, await advanced.clone().text()).toBe(200)

    const instance = (await pool.query<{ current_node_key: string | null }>(
      `SELECT current_node_key FROM approval_instances WHERE id = $1`,
      [approvalId],
    )).rows[0]
    expect(instance.current_node_key).toBe('finance_review')

    const activeAssignments = (await pool.query<{ assignee_id: string; node_key: string | null }>(
      `SELECT assignee_id, node_key
         FROM approval_assignments
        WHERE instance_id = $1 AND is_active = TRUE
        ORDER BY assignee_id`,
      [approvalId],
    )).rows
    expect(activeAssignments).toEqual([{ assignee_id: FINANCE_APPROVER, node_key: 'finance_review' }])
  })
})
