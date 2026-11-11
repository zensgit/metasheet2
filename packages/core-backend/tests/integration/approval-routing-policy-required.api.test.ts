/**
 * Approval routing — the multi-source rule through the HTTP surface, real server and real PostgreSQL.
 *
 * State under test ("refused"): the require-policy switch is on, organisation `default` holds two
 * active pull sources of different enterprises, and it has no `approval_routing` policy.
 *
 * Invariants pinned here:
 *  - creating an approval whose template reads organisation data is refused with 422
 *    `APPROVAL_ROUTING_POLICY_REQUIRED` and a fixed sentence; no instance and no assignment exist
 *    afterwards. The same holds for the two approval preview endpoints, for a form with a department
 *    field and for a form-chosen contact;
 *  - a template that reads no organisation data is created as before;
 *  - setting a policy makes the same request succeed without a restart;
 *  - the department selector answers 422 for the missing policy only; a policy that points at a
 *    non-active integration, and policies in two organisations of one requester, keep the selector's
 *    response body;
 *  - an approval already in flight keeps its requester snapshot and its assignments;
 *  - a failure of the multi-source probe itself is a retryable 503 with no rows written;
 *  - the attendance dynamic-approver port fails closed through the plugin's own mapping, and the
 *    response names neither the organisation nor a count;
 *  - with a policy, a person who has no account in the canonical source resolves to nobody: the node
 *    follows its empty-assignee policy;
 *  - the admin GET keeps `orgId` and `purposes` byte for byte, labels the refused state
 *    `policy-required` only while the switch is on, and adds a read-only `approvalRouting` block
 *    whether the switch is on or off; when the block cannot be read it is omitted and the rest of the
 *    response is unchanged;
 *  - the admin preview stays available in the refused state and writes nothing.
 *
 * Organisation `default` is shared with the other files of the lane, which run serially. Before the
 * fixtures are built, every active pull-type integration already in it is given a marker status and
 * its `approval_routing` policy rows are set aside; both are put back afterwards. Counts that other
 * files' rows can still contribute to are compared with a baseline read after that step.
 */
import net from 'node:net'
import * as path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { Pool } from 'pg'

import { Logger } from '../../src/core/logger'
import { pool, query } from '../../src/db/pg'
import {
  APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED,
  COUNT_ACTIVE_PULL_SOURCES_SQL,
  POLICY_REQUIRED_MESSAGE,
} from '../../src/directory/pull-source-rule'
import type { MetaSheetServer } from '../../src/index'
import { APPROVAL_ROUTING_MULTI_SOURCE_PROBE_MARKER } from '../../src/services/ApprovalDirectoryOrg'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
// Anti-skip-green sentinel: a DB-expected lane must have a database, never a silent skip.
const EXPECT_DB = process.env.EXPECT_DB === '1'
const itIfExpectDb = EXPECT_DB ? it : it.skip

itIfExpectDb('requires a real DB', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const TS = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
// The admin preview samples linked users in ascending id order; this prefix sorts first.
const USER_PREFIX = `000000arpr${TS}-`
const CORP_PREFIX = `corp-arpr-${TS}-`
const EXT_PREFIX = `ext-arpr-${TS}-`
const REQ = `${USER_PREFIX}req` // linked in source A (with a manager) and in source B
const MGR = `${USER_PREFIX}mgr` // manager of REQ and of CONTACT in source A
const CONTACT = `${USER_PREFIX}contact` // form-chosen contact, linked in source A
const ONLY_B = `${USER_PREFIX}onlyb` // linked in source B only
const NO_LINK = `${USER_PREFIX}nolink` // no directory account
const REQ_TWO_ORGS = `${USER_PREFIX}twoorgs` // linked in source A and in another organisation
const ADMIN = `${USER_PREFIX}admin`
const APPROVER = `${USER_PREFIX}approver`
const ATT_REQ = `${USER_PREFIX}attreq`
const ATT_MGR = `${USER_PREFIX}attmgr`
const OTHER_ORG = `arpr-other-${TS}`
const ATT_ORG = `arpr-att-${TS}`
const PARKED = 'arpr-parked:'
const DYNAMIC_FLAG = 'ATTENDANCE_APPROVAL_DYNAMIC_ASSIGNEE_SOURCES_ENABLED'
const ADMIN_BASE = '/api/admin/directory/routing-policy'

const PURPOSES = [
  'approval_routing',
  'permission_scope',
  'attendance_expansion',
  'member_group_projection',
  'automation_recipient_resolution',
] as const
/** `orgId` and `purposes` of the admin GET when the organisation has no policy row. */
const LEGACY_FIELDS = JSON.stringify({
  orgId: 'default',
  purposes: PURPOSES.map((purpose) => ({ purpose, source: 'legacy-default' })),
})
const SELECTOR_FAILURE_BODY = '{"ok":false,"error":{"code":"APPROVAL_DEPARTMENT_DIRECTORY_FAILED","message":"Failed to list approval departments"}}'

interface Reply {
  status: number
  text: string
  body: any
}

async function canListen(): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen(0, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

async function call(base: string, route: string, token: string, options: { method?: string; body?: unknown } = {}): Promise<Reply> {
  const response = await fetch(`${base}${route}`, {
    method: options.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
  const text = await response.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = undefined
  }
  return { status: response.status, text, body }
}

async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await run()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const switchOn = <T>(run: () => Promise<T>): Promise<T> => withEnv({ [APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED]: 'true' }, run)
const switchOff = <T>(run: () => Promise<T>): Promise<T> => withEnv({ [APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED]: undefined }, run)

type OrgSourceKind = 'direct_manager' | 'dept_head' | 'continuous_managers' | 'manager_at_level' | 'continuous_dept_heads' | 'dept_head_at_level'
const ORG_SOURCE_KINDS: OrgSourceKind[] = ['direct_manager', 'dept_head', 'continuous_managers', 'manager_at_level', 'continuous_dept_heads', 'dept_head_at_level']
type EmptyPolicy = 'auto-approve' | 'error'

function orgSourceGraph(kind: OrgSourceKind, emptyAssigneePolicy: EmptyPolicy) {
  const source =
    kind === 'continuous_managers' || kind === 'continuous_dept_heads' ? { kind, levels: 2 }
      : kind === 'manager_at_level' || kind === 'dept_head_at_level' ? { kind, level: 1 }
        : { kind }
  return {
    nodes: [
      { key: 'start', type: 'start', name: 's', config: {} },
      { key: 'approval_1', type: 'approval', name: 'a', config: { assigneeSources: [source], approvalMode: 'single', emptyAssigneePolicy } },
      { key: 'end', type: 'end', name: 'e', config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'approval_1' },
      { key: 'e2', source: 'approval_1', target: 'end' },
    ],
  }
}

function staticGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', name: 's', config: {} },
      { key: 'approval_1', type: 'approval', name: 'a', config: { assigneeSources: [{ kind: 'static_user', userIds: [APPROVER] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'end', type: 'end', name: 'e', config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'approval_1' },
      { key: 'e2', source: 'approval_1', target: 'end' },
    ],
  }
}

function contactManagerGraph(emptyAssigneePolicy: EmptyPolicy) {
  return {
    nodes: [
      { key: 'start', type: 'start', name: 's', config: {} },
      { key: 'ext', type: 'approval', name: 'ext', config: { assigneeSources: [{ kind: 'form_field_user_manager', fieldId: 'contact', level: 1 }], approvalMode: 'single', emptyAssigneePolicy } },
      { key: 'end', type: 'end', name: 'e', config: {} },
    ],
    edges: [
      { key: 's2x', source: 'start', target: 'ext' },
      { key: 'x2e', source: 'ext', target: 'end' },
    ],
  }
}

const REASON_FORM = { fields: [{ id: 'reason', type: 'text', label: 'r', required: true }] }
const CONTACT_FORM = {
  fields: [
    { id: 'reason', type: 'text', label: 'r', required: true },
    { id: 'contact', type: 'user', label: 'contact', required: true },
  ],
}
const DEPARTMENT_FORM = {
  fields: [{ id: 'department', type: 'department', label: 'department', required: true, props: { selection: 'single', display: 'full_path' } }],
}

describeIfDatabase('approval routing multi-source rule through the HTTP surface (real server, real PostgreSQL)', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  let reqToken = ''
  let onlyBToken = ''
  let noLinkToken = ''
  let twoOrgsToken = ''
  let adminToken = ''
  let sourceA = ''
  let sourceB = ''
  let otherOrgSource = ''
  let departmentA = ''
  let accountOnlyB = ''
  let linkedAccountBaseline = 0
  const parkedIds: string[] = []
  const setAsidePolicies: Array<{ purpose: string; canonical: string; fallback: string | null }> = []
  const previousEnv: Record<string, string | undefined> = {}
  const extraIntegrationIds: string[] = []

  // One spy on the pool every statement of the server goes through. It forwards every call
  // unchanged unless a fault is armed for the statement text.
  let probeFault = false
  let countFault: 'none' | 'empty' | 'throw' = 'none'
  let faultFired = 0
  let querySpy: MockInstance | null = null
  const servicePool = pool as Pool | null

  const statementText = (first: unknown): string =>
    typeof first === 'string' ? first : typeof (first as { text?: unknown } | null)?.text === 'string' ? (first as { text: string }).text : ''

  async function integration(org: string, tag: string, options: { provider?: string; status?: string; corp?: string; config?: Record<string, unknown> } = {}): Promise<string> {
    const inserted = await query<{ id: string }>(
      `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
      [org, options.provider ?? 'dingtalk', `Routing source ${tag} ${TS}`, options.status ?? 'active', options.corp ?? `${CORP_PREFIX}${tag}`, JSON.stringify(options.config ?? {})],
    )
    extraIntegrationIds.push(inserted.rows[0].id)
    return inserted.rows[0].id
  }

  async function account(
    integrationId: string,
    user: string | null,
    tag: string,
    options: { title?: string; raw?: Record<string, unknown>; linkStatus?: string; isActive?: boolean; provider?: string } = {},
  ): Promise<string> {
    const inserted = await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, provider, external_user_id, external_key, name, title, is_active, raw)
       VALUES ($1, $2, $3, $3, $4, $5, $6, $7::jsonb) RETURNING id`,
      [integrationId, options.provider ?? 'dingtalk', `${EXT_PREFIX}${tag}`, `Person ${tag}`, options.title ?? null, options.isActive ?? true, JSON.stringify(options.raw ?? {})],
    )
    if (user) {
      await query(
        `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
         VALUES ($1, $2, $3, 'manual')`,
        [inserted.rows[0].id, user, options.linkStatus ?? 'linked'],
      )
    }
    return inserted.rows[0].id
  }

  async function department(integrationId: string, tag: string): Promise<{ id: string; external: string }> {
    const external = `dept-arpr-${TS}-${tag}`
    const inserted = await query<{ id: string }>(
      `INSERT INTO directory_departments (integration_id, provider, external_department_id, name, is_active, raw)
       VALUES ($1, 'dingtalk', $2, $3, true, '{}'::jsonb) RETURNING id`,
      [integrationId, external, `Department ${tag}`],
    )
    return { id: inserted.rows[0].id, external }
  }

  async function membership(accountId: string, departmentId: string, isPrimary: boolean): Promise<void> {
    await query(
      `INSERT INTO directory_account_departments (directory_account_id, directory_department_id, is_primary, is_manager)
       VALUES ($1, $2, $3, false)`,
      [accountId, departmentId, isPrimary],
    )
  }

  /** A requester with a one-level manager chain inside one integration. */
  async function chain(integrationId: string, tag: string, requester: string, manager: string): Promise<{ departmentId: string }> {
    const team = await department(integrationId, `${tag}-team`)
    const lead = await department(integrationId, `${tag}-lead`)
    const requesterAccount = await account(integrationId, requester, `${tag}-req`, { title: 'Source A' })
    const managerAccount = await account(integrationId, manager, `${tag}-mgr`, {
      title: 'Source A manager',
      raw: { leader_in_dept: [{ dept_id: team.external, leader: true }] },
    })
    await membership(requesterAccount, team.id, true)
    await membership(managerAccount, team.id, false)
    await membership(managerAccount, lead.id, true)
    return { departmentId: team.id }
  }

  async function setPolicy(org: string, canonical: string): Promise<void> {
    await query(
      `INSERT INTO org_directory_routing_policy (org_id, purpose, canonical_integration_id)
       VALUES ($1, 'approval_routing', $2)
       ON CONFLICT ON CONSTRAINT orp_org_purpose_uniq
       DO UPDATE SET canonical_integration_id = EXCLUDED.canonical_integration_id, updated_at = NOW()`,
      [org, canonical],
    )
  }
  const clearPolicy = (org = 'default'): Promise<unknown> => query(`DELETE FROM org_directory_routing_policy WHERE org_id = $1`, [org])
  const setStatus = (integrationId: string, status: string): Promise<unknown> =>
    query(`UPDATE directory_integrations SET status = $2 WHERE id = $1`, [integrationId, status])

  async function token(userId: string): Promise<string> {
    await grantApprovalWriteForIntegrationActor(userId)
    const response = await fetch(`${base}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`)
    return ((await response.json()) as { token: string }).token
  }

  async function publish(key: string, approvalGraph: unknown, formSchema: unknown = REASON_FORM): Promise<string> {
    const created = await call(base, '/api/approval-templates', reqToken, {
      method: 'POST',
      body: { key: `${key}-${TS}`, name: key, formSchema, approvalGraph },
    })
    expect(created.status, created.text).toBe(201)
    const templateId = created.body.id as string
    const published = await call(base, `/api/approval-templates/${templateId}/publish`, reqToken, { method: 'POST', body: { policy: { allowRevoke: true } } })
    expect(published.status, published.text).toBe(200)
    return templateId
  }

  const start = (templateId: string, userToken: string, formData: Record<string, unknown> = { reason: 'r' }): Promise<Reply> =>
    call(base, '/api/approvals', userToken, { method: 'POST', body: { templateId, formData } })

  async function instanceCount(templateId: string): Promise<number> {
    const rows = await query<{ n: number }>(`SELECT count(*)::int AS n FROM approval_instances WHERE template_id = $1`, [templateId])
    return rows.rows[0].n
  }
  async function assignmentCount(templateId: string): Promise<number> {
    const rows = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM approval_assignments a JOIN approval_instances i ON i.id = a.instance_id WHERE i.template_id = $1`,
      [templateId],
    )
    return rows.rows[0].n
  }
  async function expectNoRows(templateId: string): Promise<void> {
    expect(await instanceCount(templateId)).toBe(0)
    expect(await assignmentCount(templateId)).toBe(0)
  }
  function expectPolicyRequired(reply: Reply, label = ''): void {
    expect(reply.status, `${label} ${reply.text}`).toBe(422)
    expect(reply.body?.error?.code, label).toBe('APPROVAL_ROUTING_POLICY_REQUIRED')
    expect(reply.body?.error?.message, label).toBe(POLICY_REQUIRED_MESSAGE)
  }
  async function autoApprovedNodes(instanceId: string): Promise<string[]> {
    const rows = await query<{ node_key: string }>(
      `SELECT metadata->>'nodeKey' AS node_key FROM approval_records
        WHERE instance_id = $1 AND metadata->>'autoApproved' = 'true' AND metadata->>'reason' = 'empty-assignee'
        ORDER BY 1`,
      [instanceId],
    )
    return rows.rows.map((row) => row.node_key)
  }
  const adminGet = (): Promise<Reply> => call(base, `${ADMIN_BASE}/`, adminToken)
  const preview = (candidate: string): Promise<Reply> => call(base, `${ADMIN_BASE}/approval_routing/preview?candidate=${candidate}`, adminToken)
  const existingFields = (reply: Reply): string => JSON.stringify({ orgId: reply.body.data.orgId, purposes: reply.body.data.purposes })
  async function policyAuditCount(): Promise<number> {
    const rows = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_logs WHERE resource_type = 'directory-routing-policy' AND resource_id = 'default:approval_routing'`,
    )
    return rows.rows[0].n
  }
  async function defaultPolicyCount(): Promise<number> {
    const rows = await query<{ n: number }>(`SELECT count(*)::int AS n FROM org_directory_routing_policy WHERE org_id = 'default'`)
    return rows.rows[0].n
  }

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    expect(servicePool, 'the service pool must be available for fault injection').toBeTruthy()
    for (const key of ['SKIP_PLUGINS', 'RBAC_BYPASS', DYNAMIC_FLAG, APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED]) previousEnv[key] = process.env[key]
    process.env.SKIP_PLUGINS = 'false'
    delete process.env[APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED]

    const originalQuery = servicePool!.query
    querySpy = vi.spyOn(servicePool!, 'query').mockImplementation(function (this: Pool, ...args: unknown[]) {
      const text = statementText(args[0])
      if (probeFault && text.includes(APPROVAL_ROUTING_MULTI_SOURCE_PROBE_MARKER)) {
        faultFired += 1
        return Promise.reject(new Error('simulated transient failure of the multi-source probe'))
      }
      if (countFault !== 'none' && text === COUNT_ACTIVE_PULL_SOURCES_SQL) {
        faultFired += 1
        if (countFault === 'throw') return Promise.reject(new Error('simulated failure of the source count'))
        return Promise.resolve({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] })
      }
      return Reflect.apply(originalQuery, this, args)
    })

    await ensureApprovalSchemaReady()

    // Set aside what other files left in organisation `default` (see the file header).
    const parked = await query<{ id: string }>(
      `UPDATE directory_integrations SET status = $1 || status
        WHERE org_id = 'default' AND provider <> 'local' AND status = 'active'
        RETURNING id::text AS id`,
      [PARKED],
    )
    parkedIds.push(...parked.rows.map((row) => row.id))
    const policies = await query<{ purpose: string; canonical: string; fallback: string | null }>(
      `DELETE FROM org_directory_routing_policy WHERE org_id = 'default'
       RETURNING purpose, canonical_integration_id::text AS canonical, fallback_integration_id::text AS fallback`,
    )
    setAsidePolicies.push(...policies.rows)

    for (const user of [REQ, MGR, CONTACT, ONLY_B, NO_LINK, REQ_TWO_ORGS, ADMIN, APPROVER, ATT_REQ, ATT_MGR]) {
      await query(
        `INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, 'x') ON CONFLICT (id) DO NOTHING`,
        [user, `${user}@example.test`, user],
      )
    }

    sourceA = await integration('default', 'a')
    sourceB = await integration('default', 'b')
    departmentA = (await chain(sourceA, 'a', REQ, MGR)).departmentId
    const contactAccount = await account(sourceA, CONTACT, 'a-contact', { title: 'Source A contact' })
    await membership(contactAccount, departmentA, true)
    await account(sourceA, REQ_TWO_ORGS, 'a-twoorgs', { title: 'Source A' })
    await account(sourceB, REQ, 'b-req', { title: 'Source B' })
    accountOnlyB = await account(sourceB, ONLY_B, 'b-onlyb', { title: 'Source B' })
    otherOrgSource = await integration(OTHER_ORG, 'other')
    await account(otherOrgSource, REQ_TWO_ORGS, 'other-twoorgs', { title: 'Other organisation' })

    const baseline = await query<{ n: number }>(
      `SELECT count(DISTINCT a.id)::int AS n
         FROM directory_integrations i
         JOIN directory_accounts a ON a.integration_id = i.id AND a.is_active = true
         JOIN directory_account_links l ON l.directory_account_id = a.id AND l.link_status = 'linked'
        WHERE i.org_id = 'default' AND i.provider <> 'local' AND i.status <> 'active'`,
    )
    linkedAccountBaseline = baseline.rows[0].n

    const { MetaSheetServer: Server } = await import('../../src/index')
    server = new Server({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [path.join(__dirname, '../../../../', 'plugins', 'plugin-attendance')],
    })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('the server did not expose a TCP address')
    base = `http://127.0.0.1:${address.port}`
    reqToken = await token(REQ)
    onlyBToken = await token(ONLY_B)
    noLinkToken = await token(NO_LINK)
    twoOrgsToken = await token(REQ_TWO_ORGS)
    adminToken = await token(ADMIN)
  }, 120_000)

  afterEach(async () => {
    probeFault = false
    countFault = 'none'
    delete process.env[APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED]
    await clearPolicy('default')
    await clearPolicy(OTHER_ORG)
    await clearPolicy(ATT_ORG)
    if (sourceA) await setStatus(sourceA, 'active')
    if (sourceB) await setStatus(sourceB, 'active')
  })

  afterAll(async () => {
    querySpy?.mockRestore()
    querySpy = null
    const quiet = async (run: () => Promise<unknown>): Promise<void> => {
      try {
        await run()
      } catch {
        /* best effort: a failed cleanup step must not hide the remaining ones */
      }
    }
    await quiet(() => query(`DELETE FROM org_directory_routing_policy WHERE org_id = ANY($1::text[])`, [['default', OTHER_ORG, ATT_ORG]]))
    await quiet(async () => {
      const templates = (await query<{ id: string }>(`SELECT id FROM approval_templates WHERE key LIKE $1`, [`%-${TS}`])).rows.map((row) => row.id)
      const attendance = (await query<{ id: string; approval_instance_id: string | null }>(
        `SELECT id::text AS id, approval_instance_id FROM attendance_requests WHERE org_id = $1`, [ATT_ORG],
      )).rows
      const instances = [
        ...(await query<{ id: string }>(`SELECT id FROM approval_instances WHERE template_id = ANY($1)`, [templates])).rows.map((row) => row.id),
        ...attendance.map((row) => row.approval_instance_id).filter((id): id is string => typeof id === 'string'),
      ]
      await query(`DELETE FROM attendance_requests WHERE org_id = $1`, [ATT_ORG])
      await query(`DELETE FROM attendance_approval_flows WHERE org_id = $1`, [ATT_ORG])
      await query(`DELETE FROM attendance_rules WHERE org_id = $1`, [ATT_ORG])
      if (instances.length > 0) {
        await query(`DELETE FROM approval_records WHERE instance_id = ANY($1)`, [instances])
        await query(`DELETE FROM approval_assignments WHERE instance_id = ANY($1)`, [instances])
        await query(`DELETE FROM approval_instances WHERE id = ANY($1)`, [instances])
      }
      if (templates.length > 0) {
        await query(`DELETE FROM approval_published_definitions WHERE template_id = ANY($1)`, [templates])
        await query(`DELETE FROM approval_templates WHERE id = ANY($1)`, [templates])
      }
    })
    for (const id of extraIntegrationIds.splice(0)) {
      await quiet(() => query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [id]))
      await quiet(() => query(`DELETE FROM directory_departments WHERE integration_id = $1`, [id]))
      await quiet(() => query(`DELETE FROM directory_integrations WHERE id = $1`, [id]))
    }
    await quiet(() => query(`DELETE FROM user_orgs WHERE user_id LIKE $1`, [`${USER_PREFIX}%`]))
    await quiet(() => query(`DELETE FROM user_permissions WHERE user_id LIKE $1`, [`${USER_PREFIX}%`]))
    await quiet(() => query(`DELETE FROM users WHERE id LIKE $1`, [`${USER_PREFIX}%`]))
    // Put back what was set aside in organisation `default`.
    await quiet(() => query(
      `UPDATE directory_integrations SET status = substr(status, $2::int)
        WHERE id = ANY($1::uuid[]) AND status LIKE $3`,
      [parkedIds, PARKED.length + 1, `${PARKED}%`],
    ))
    for (const policy of setAsidePolicies.splice(0)) {
      await quiet(() => query(
        `INSERT INTO org_directory_routing_policy (org_id, purpose, canonical_integration_id, fallback_integration_id)
         VALUES ('default', $1, $2, $3) ON CONFLICT DO NOTHING`,
        [policy.purpose, policy.canonical, policy.fallback],
      ))
    }
    if (server) await server.stop()
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }, 120_000)

  it.each(ORG_SOURCE_KINDS)('A1 creating with a %s node is refused 422 APPROVAL_ROUTING_POLICY_REQUIRED and leaves no instance and no assignment', async (kind) => {
    const templateId = await publish(`a1-${kind}`, orgSourceGraph(kind, 'auto-approve'))

    const reply = await switchOn(() => start(templateId, reqToken))

    expectPolicyRequired(reply, kind)
    expect(reply.text).not.toContain('APPROVAL_ROUTING_POLICY_MISCONFIGURED')
    await expectNoRows(templateId)
  })

  it('A1 the same request with the switch off is created: the refusal belongs to the switch', async () => {
    const templateId = await publish('a1-off', orgSourceGraph('direct_manager', 'auto-approve'))

    const reply = await switchOff(() => start(templateId, reqToken))

    expect(reply.status, reply.text).toBeLessThan(300)
    expect(await instanceCount(templateId)).toBe(1)
  })

  it('A1 the approval preview endpoint is refused the same way and writes nothing', async () => {
    const templateId = await publish('a1-preview', orgSourceGraph('direct_manager', 'auto-approve'))

    const reply = await switchOn(() => call(base, '/api/approvals/preview', reqToken, { method: 'POST', body: { templateId, formData: { reason: 'r' } } }))

    expectPolicyRequired(reply)
    await expectNoRows(templateId)
  })

  it('A1 the template route-preview endpoint is refused the same way and writes nothing', async () => {
    const templateId = await publish('a1-route-preview', orgSourceGraph('direct_manager', 'auto-approve'))

    const reply = await switchOn(() => call(base, `/api/approval-templates/${templateId}/route-preview`, reqToken, {
      method: 'POST',
      body: { sampleFormData: { reason: 'r' }, sampleRequesterId: REQ },
    }))

    expectPolicyRequired(reply)
    await expectNoRows(templateId)
  })

  it('A2 a template that reads no organisation data is created in the refused state', async () => {
    const templateId = await publish('a2-static', staticGraph())

    const reply = await switchOn(() => start(templateId, reqToken))

    expect(reply.status, reply.text).toBe(201)
    expect(await instanceCount(templateId)).toBe(1)
  })

  it('A3 after a policy is set through the admin route the same request succeeds and is assigned to the manager', async () => {
    const templateId = await publish('a3-retry', orgSourceGraph('direct_manager', 'error'))

    const outcome = await switchOn(async () => {
      const refused = await start(templateId, reqToken)
      const patched = await call(base, `${ADMIN_BASE}/approval_routing`, adminToken, { method: 'PATCH', body: { canonicalIntegrationId: sourceA } })
      const retried = await start(templateId, reqToken)
      return { refused, patched, retried }
    })
    const assignees = await query<{ assignee_id: string }>(
      `SELECT a.assignee_id FROM approval_assignments a JOIN approval_instances i ON i.id = a.instance_id
        WHERE i.template_id = $1 AND a.is_active = TRUE`,
      [templateId],
    )

    expectPolicyRequired(outcome.refused)
    expect(outcome.patched.status, outcome.patched.text).toBe(200)
    expect(outcome.retried.status, outcome.retried.text).toBe(201)
    expect(await instanceCount(templateId)).toBe(1)
    expect(assignees.rows.map((row) => row.assignee_id)).toEqual([MGR])
  })

  it('A4 the department selector answers 422 APPROVAL_ROUTING_POLICY_REQUIRED in the refused state', async () => {
    const reply = await switchOn(() => call(base, '/api/approvals/directory/departments?limit=5', reqToken))

    expectPolicyRequired(reply)
  })

  it('A4 the department selector lists departments with the switch off', async () => {
    const reply = await switchOff(() => call(base, '/api/approvals/directory/departments?limit=5', reqToken))

    expect(reply.status, reply.text).toBe(200)
    expect(Array.isArray(reply.body.departments)).toBe(true)
  })

  it.each(['on', 'off'])('A4 the department selector keeps its response for a policy that points at a non-active integration (switch %s)', async (state) => {
    await setPolicy('default', sourceA)
    await setStatus(sourceA, 'disabled')

    const reply = await (state === 'on' ? switchOn : switchOff)(() => call(base, '/api/approvals/directory/departments?limit=5', reqToken))

    expect(reply.status, reply.text).toBe(500)
    expect(reply.text).toBe(SELECTOR_FAILURE_BODY)
  })

  it.each(['on', 'off'])('A4 the department selector keeps its response for policies in two organisations of one requester (switch %s)', async (state) => {
    await setPolicy('default', sourceA)
    await setPolicy(OTHER_ORG, otherOrgSource)

    const reply = await (state === 'on' ? switchOn : switchOff)(() => call(base, '/api/approvals/directory/departments?limit=5', twoOrgsToken))

    expect(reply.status, reply.text).toBe(500)
    expect(reply.text).toBe(SELECTOR_FAILURE_BODY)
  })

  it('A4 a form with a department field is refused 422 APPROVAL_ROUTING_POLICY_REQUIRED and leaves no rows', async () => {
    const templateId = await publish('a4-department', staticGraph(), DEPARTMENT_FORM)

    const reply = await switchOn(() => start(templateId, reqToken, { department: [{ id: departmentA }] }))

    expectPolicyRequired(reply)
    await expectNoRows(templateId)
  })

  it('A4 a form with a department field keeps its response for a policy that points at a non-active integration', async () => {
    const templateId = await publish('a4-department-broken', staticGraph(), DEPARTMENT_FORM)
    await setPolicy('default', sourceA)
    await setStatus(sourceA, 'disabled')

    const reply = await switchOn(() => start(templateId, reqToken, { department: [{ id: departmentA }] }))

    expect(reply.status, reply.text).toBe(422)
    expect(reply.text).toBe('{"error":{"code":"APPROVAL_ROUTING_POLICY_MISCONFIGURED","message":"Approval department directory is unavailable"}}')
    await expectNoRows(templateId)
  })

  it('A5 a form-chosen contact in the refused organisation is refused 422 and leaves no rows', async () => {
    const templateId = await publish('a5-contact', contactManagerGraph('auto-approve'), CONTACT_FORM)

    // The requester has no directory account, so the refusal comes from the contact's resolution.
    const reply = await switchOn(() => start(templateId, noLinkToken, { reason: 'r', contact: CONTACT }))

    expectPolicyRequired(reply)
    expect(reply.text).not.toContain(CONTACT)
    await expectNoRows(templateId)
  })

  it('A5 the same form-chosen contact resolves to the manager with the switch off', async () => {
    const templateId = await publish('a5-contact-off', contactManagerGraph('error'), CONTACT_FORM)

    const reply = await switchOff(() => start(templateId, noLinkToken, { reason: 'r', contact: CONTACT }))
    const assignees = await query<{ assignee_id: string }>(
      `SELECT a.assignee_id FROM approval_assignments a JOIN approval_instances i ON i.id = a.instance_id
        WHERE i.template_id = $1 AND a.is_active = TRUE`,
      [templateId],
    )

    expect(reply.status, reply.text).toBe(201)
    expect(assignees.rows.map((row) => row.assignee_id)).toEqual([MGR])
  })

  it('A6 the admin preview stays available in the refused state: blocked rows, no writes', async () => {
    const policiesBefore = await defaultPolicyCount()
    const auditBefore = await policyAuditCount()

    const reply = await switchOn(() => preview(sourceA))
    const rows = (reply.body?.data?.rows ?? []) as Array<{ userId: string; changed: boolean; blocked?: boolean; before: unknown; after: { title: string | null } }>
    const requesterRow = rows.find((row) => row.userId === REQ)
    const onlyBRow = rows.find((row) => row.userId === ONLY_B)

    expect(reply.status, reply.text).toBe(200)
    expect(reply.body.data.current).toEqual({ source: 'policy-required' })
    expect(requesterRow).toEqual({ userId: REQ, changed: true, blocked: true, before: null, after: expect.objectContaining({ title: 'Source A' }) })
    expect(onlyBRow).toEqual({ userId: ONLY_B, changed: true, blocked: true, before: null, after: { departmentName: null, title: null, managerId: null, deptHeadId: null } })
    expect(reply.body.data.blockedCount).toBe(rows.filter((row) => row.blocked === true).length)
    expect(reply.body.data.blockedCount).toBeGreaterThanOrEqual(2)
    expect(reply.body.data.changedCount).toBeGreaterThanOrEqual(reply.body.data.blockedCount)
    expect(await defaultPolicyCount()).toBe(policiesBefore)
    expect(await policyAuditCount()).toBe(auditBefore)
  })

  it('A6 with the switch off the admin preview reports the legacy source and carries no blocked marker', async () => {
    const reply = await switchOff(() => preview(sourceA))
    const rows = (reply.body?.data?.rows ?? []) as Array<Record<string, unknown>>

    expect(reply.status, reply.text).toBe(200)
    expect(reply.body.data.current).toEqual({ source: 'legacy-default' })
    expect(Object.keys(reply.body.data)).toEqual(['orgId', 'purpose', 'current', 'candidate', 'sampleSize', 'changedCount', 'rows'])
    expect(rows.some((row) => 'blocked' in row)).toBe(false)
    expect(rows.find((row) => row.userId === REQ)).toEqual({
      userId: REQ,
      changed: expect.any(Boolean),
      before: expect.objectContaining({ title: expect.any(String) }),
      after: expect.objectContaining({ title: 'Source A' }),
    })
  })

  it('A6 with the switch on and a policy the admin preview reports the policy and carries no blocked marker', async () => {
    await setPolicy('default', sourceB)

    const reply = await switchOn(() => preview(sourceA))
    const rows = (reply.body?.data?.rows ?? []) as Array<Record<string, unknown>>

    expect(reply.status, reply.text).toBe(200)
    expect(reply.body.data.current).toEqual({ source: 'policy', canonicalIntegrationId: sourceB })
    expect('blockedCount' in reply.body.data).toBe(false)
    expect(rows.some((row) => 'blocked' in row)).toBe(false)
  })

  it('A7 an approval in flight keeps its snapshot and assignments when the organisation becomes refused', async () => {
    const templateId = await publish('a7-inflight', orgSourceGraph('direct_manager', 'error'))
    const snapshot = async (): Promise<unknown> => {
      const instances = await query(
        `SELECT to_jsonb(i)::text AS content FROM approval_instances i WHERE i.template_id = $1 ORDER BY i.id`, [templateId],
      )
      const assignments = await query(
        `SELECT to_jsonb(a)::text AS content FROM approval_assignments a JOIN approval_instances i ON i.id = a.instance_id
          WHERE i.template_id = $1 ORDER BY a.id`,
        [templateId],
      )
      return { instances: instances.rows, assignments: assignments.rows }
    }

    await setPolicy('default', sourceA)
    const created = await switchOn(() => start(templateId, reqToken))
    const before = await snapshot()
    await clearPolicy('default')
    const refused = await switchOn(() => start(templateId, reqToken))
    const after = await snapshot()

    expect(created.status, created.text).toBe(201)
    expect((before as { instances: unknown[] }).instances).toHaveLength(1)
    expect((before as { assignments: unknown[] }).assignments).toHaveLength(1)
    expectPolicyRequired(refused)
    expect(after).toEqual(before)
  })

  it('A8 switch off: orgId and purposes are unchanged and the status block is present', async () => {
    const reply = await switchOff(adminGet)
    const block = reply.body?.data?.approvalRouting

    expect(reply.status, reply.text).toBe(200)
    expect(existingFields(reply)).toBe(LEGACY_FIELDS)
    expect(reply.text.startsWith(`{"ok":true,"data":${LEGACY_FIELDS.slice(0, -1)},"approvalRouting":{`)).toBe(true)
    expect(Object.keys(block)).toEqual([
      'enforced', 'hasPolicy', 'activePullSourceCount', 'policyRequired', 'candidates', 'sameCorpGroups', 'nonActivePullSourceLinkedAccountCount',
    ])
    expect(block.enforced).toBe(false)
    expect(block.hasPolicy).toBe(false)
    expect(block.activePullSourceCount).toBe(2)
    expect(block.policyRequired).toBe(true)
    expect(block.nonActivePullSourceLinkedAccountCount).toBe(linkedAccountBaseline)
  })

  it('A8 switch on, refused: approval_routing reads policy-required and nothing else changes', async () => {
    const off = await switchOff(adminGet)
    const on = await switchOn(adminGet)

    expect(on.status, on.text).toBe(200)
    expect(on.body.data.purposes).toEqual(PURPOSES.map((purpose) => ({ purpose, source: purpose === 'approval_routing' ? 'policy-required' : 'legacy-default' })))
    expect(on.body.data.approvalRouting).toEqual({ ...off.body.data.approvalRouting, enforced: true })
  })

  it('A8 the status block lists the active integrations as candidates with four keys each and names no enterprise', async () => {
    const reply = await switchOn(adminGet)
    const candidates = reply.body.data.approvalRouting.candidates as Array<Record<string, unknown>>
    const mine = candidates.filter((candidate) => candidate.integrationId === sourceA || candidate.integrationId === sourceB)

    expect(mine).toEqual([
      { integrationId: sourceA, provider: 'dingtalk', name: `Routing source a ${TS}`, status: 'active' },
      { integrationId: sourceB, provider: 'dingtalk', name: `Routing source b ${TS}`, status: 'active' },
    ])
    expect(candidates.every((candidate) => Object.keys(candidate).join(',') === 'integrationId,provider,name,status')).toBe(true)
    expect(candidates.every((candidate) => candidate.status === 'active')).toBe(true)
    expect(candidates.filter((candidate) => candidate.provider !== 'local')).toHaveLength(2)
    expect(reply.text).not.toContain(CORP_PREFIX)
  })

  it('A8 switch on with a policy: approval_routing reads policy and the block reports the policy', async () => {
    await setPolicy('default', sourceA)

    const reply = await switchOn(adminGet)
    const [approvalRouting, ...rest] = reply.body.data.purposes as Array<Record<string, unknown>>

    expect(Object.keys(approvalRouting)).toEqual(['purpose', 'source', 'canonicalIntegrationId', 'canonicalProvider', 'canonicalStatus', 'fallbackIntegrationId', 'updatedAt'])
    expect(approvalRouting).toMatchObject({ purpose: 'approval_routing', source: 'policy', canonicalIntegrationId: sourceA, canonicalProvider: 'dingtalk', canonicalStatus: 'active', fallbackIntegrationId: null })
    expect(rest).toEqual(PURPOSES.slice(1).map((purpose) => ({ purpose, source: 'legacy-default' })))
    expect(reply.body.data.approvalRouting).toMatchObject({ enforced: true, hasPolicy: true, activePullSourceCount: 2, policyRequired: false })
  })

  it('A8 switch on with one active pull source: approval_routing reads legacy-default', async () => {
    await setStatus(sourceB, 'paused')

    const reply = await switchOn(adminGet)

    expect(existingFields(reply)).toBe(LEGACY_FIELDS)
    expect(reply.body.data.approvalRouting).toMatchObject({ enforced: true, hasPolicy: false, activePullSourceCount: 1, policyRequired: false })
  })

  it('A9 a failure of the multi-source probe is a retryable 503 and leaves no rows', async () => {
    const templateId = await publish('a9-probe', orgSourceGraph('direct_manager', 'auto-approve'))
    faultFired = 0

    probeFault = true
    const reply = await switchOn(() => start(templateId, reqToken))
    probeFault = false

    expect(faultFired).toBeGreaterThan(0)
    expect(reply.status, reply.text).toBe(503)
    expect(reply.body?.error?.code).toBe('APPROVAL_REQUESTER_ORG_UNRESOLVED')
    expect(reply.text).not.toContain('APPROVAL_ROUTING_POLICY')
    await expectNoRows(templateId)
  })

  describe('A10 attendance dynamic approver', () => {
    let attendanceToken = ''
    const attendanceRequests = async (): Promise<number> =>
      (await query<{ n: number }>(`SELECT count(*)::int AS n FROM attendance_requests WHERE org_id = $1`, [ATT_ORG])).rows[0].n
    const setFlow = async (kind: 'direct_manager' | 'manager_at_level'): Promise<void> => {
      await query(`DELETE FROM attendance_approval_flows WHERE org_id = $1`, [ATT_ORG])
      await query(
        `INSERT INTO attendance_approval_flows (id, org_id, name, request_type, steps, is_active)
         VALUES (gen_random_uuid(), $1, $2, 'time_correction', $3::jsonb, true)`,
        [ATT_ORG, `Routing flow ${kind} ${TS}`, JSON.stringify([kind === 'manager_at_level' ? { kind, level: 1 } : { kind }])],
      )
    }
    const createRequest = (workDate: string): Promise<Reply> =>
      call(base, '/api/attendance/requests', attendanceToken, {
        method: 'POST',
        body: {
          orgId: ATT_ORG,
          workDate,
          requestType: 'time_correction',
          requestedInAt: `${workDate}T01:00:00Z`,
          requestedOutAt: `${workDate}T10:00:00Z`,
          reason: 'routing fixture',
        },
      })
    const attendanceEnv = (switchValue: string | undefined) => ({
      RBAC_BYPASS: 'true',
      [DYNAMIC_FLAG]: 'true',
      [APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED]: switchValue,
    })

    beforeAll(async () => {
      const first = await integration(ATT_ORG, 'att-a')
      await integration(ATT_ORG, 'att-b')
      await chain(first, 'att', ATT_REQ, ATT_MGR)
      await query(
        `INSERT INTO permissions (code, name, description)
         VALUES ('attendance:approve', 'Attendance Approve', 'Approve attendance requests'),
                ('attendance:admin', 'Attendance Admin', 'Administer attendance'),
                ('attendance:write', 'Attendance Write', 'Create attendance requests')
         ON CONFLICT (code) DO NOTHING`,
      )
      await query(
        `INSERT INTO user_permissions (user_id, permission_code)
         VALUES ($1, 'attendance:write'), ($1, 'attendance:approve'), ($1, 'attendance:admin')
         ON CONFLICT DO NOTHING`,
        [ATT_REQ],
      )
      await query(
        `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)
         ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = TRUE`,
        [ATT_REQ, ATT_ORG],
      )
      await query(
        `INSERT INTO attendance_rules (id, org_id, name, timezone, timezone_version, work_start_time, work_end_time, working_days, is_default)
         VALUES (gen_random_uuid(), $1, 'Routing fixture rule', 'UTC', 1, '09:00', '18:00', '[1,2,3,4,5]'::jsonb, true)`,
        [ATT_ORG],
      )
      const response = await fetch(`${base}/api/auth/dev-token?userId=${encodeURIComponent(ATT_REQ)}&roles=user&perms=${encodeURIComponent('attendance:admin,attendance:write,attendance:approve')}`)
      attendanceToken = ((await response.json()) as { token: string }).token
    }, 60_000)

    it.each([
      ['direct_manager', '2026-07-06'],
      ['manager_at_level', '2026-07-07'],
    ] as const)('a %s step is refused 422 APPROVAL_STEP_KIND_UNAVAILABLE; the response names neither the organisation nor a count', async (kind, workDate) => {
      await setFlow(kind)
      const before = await attendanceRequests()

      const reply = await withEnv(attendanceEnv('true'), () => createRequest(workDate))
      const message = String(reply.body?.error?.message ?? '')

      expect(reply.status, reply.text).toBe(422)
      expect(reply.body?.error?.code).toBe('APPROVAL_STEP_KIND_UNAVAILABLE')
      expect(reply.text).not.toContain(ATT_ORG)
      expect(message).not.toMatch(/\d/)
      expect(await attendanceRequests()).toBe(before)
    })

    it('a manager_at_level step carries the fixed sentence of the refusal and nothing else from it', async () => {
      await setFlow('manager_at_level')

      const reply = await withEnv(attendanceEnv('true'), () => createRequest('2026-07-08'))
      const message = String(reply.body?.error?.message ?? '')

      expect(reply.status, reply.text).toBe(422)
      expect(message).toContain(`resolver 调用失败: ${POLICY_REQUIRED_MESSAGE})`)
    })

    it('the same request with the switch off is created: the fixture reaches the resolver', async () => {
      await setFlow('manager_at_level')
      const before = await attendanceRequests()

      const reply = await withEnv(attendanceEnv(undefined), () => createRequest('2026-07-09'))

      expect(reply.status, reply.text).toBe(201)
      expect(await attendanceRequests()).toBe(before + 1)
    })
  })

  // With a policy, a person who has no account in the canonical source is data absence, not a
  // configuration fault: the resolver returns nobody and the node follows its empty-assignee
  // policy. Should that ever become a refusal, each of the three cases becomes "422, no rows".
  describe('A11 a person outside the canonical source, with a policy in place', () => {
    it('requester outside the canonical source, auto-approve node: created and the node is auto-approved', async () => {
      const templateId = await publish('a11-auto', orgSourceGraph('direct_manager', 'auto-approve'))
      await setPolicy('default', sourceA)

      const reply = await switchOn(() => start(templateId, onlyBToken))

      expect(reply.status, reply.text).toBe(201)
      expect(await autoApprovedNodes(reply.body.id as string)).toEqual(['approval_1'])
    })

    it('requester outside the canonical source, default empty-assignee policy: 400 APPROVAL_ASSIGNEE_EMPTY and no rows', async () => {
      const templateId = await publish('a11-error', orgSourceGraph('direct_manager', 'error'))
      await setPolicy('default', sourceA)

      const reply = await switchOn(() => start(templateId, onlyBToken))

      expect(reply.status, reply.text).toBe(400)
      expect(reply.body?.error?.code).toBe('APPROVAL_ASSIGNEE_EMPTY')
      await expectNoRows(templateId)
    })

    it('form-chosen contact outside the canonical source, auto-approve node: created and the node is auto-approved', async () => {
      const templateId = await publish('a11-contact-auto', contactManagerGraph('auto-approve'), CONTACT_FORM)
      await setPolicy('default', sourceA)

      const reply = await switchOn(() => start(templateId, reqToken, { reason: 'r', contact: ONLY_B }))

      expect(reply.status, reply.text).toBe(201)
      expect(await autoApprovedNodes(reply.body.id as string)).toEqual(['ext'])
    })

    it('form-chosen contact outside the canonical source, default empty-assignee policy: 400 APPROVAL_ASSIGNEE_EMPTY and no rows', async () => {
      const templateId = await publish('a11-contact-error', contactManagerGraph('error'), CONTACT_FORM)
      await setPolicy('default', sourceA)

      const reply = await switchOn(() => start(templateId, reqToken, { reason: 'r', contact: ONLY_B }))

      expect(reply.status, reply.text).toBe(400)
      expect(reply.body?.error?.code).toBe('APPROVAL_ASSIGNEE_EMPTY')
      await expectNoRows(templateId)
    })
  })

  it.each(['empty', 'throw'] as const)('A12 when the source count cannot be read (%s) the admin GET omits the status block and is otherwise unchanged', async (mode) => {
    const warn = vi.spyOn(Logger.prototype, 'warn')
    faultFired = 0
    try {
      countFault = mode
      const reply = await switchOff(adminGet)
      countFault = 'none'
      const lines = warn.mock.calls.map((args) => String(args[0])).filter((line) => line.startsWith('Approval routing status block omitted'))

      expect(faultFired).toBeGreaterThan(0)
      expect(reply.status, reply.text).toBe(200)
      expect(reply.text).toBe(`{"ok":true,"data":${LEGACY_FIELDS}}`)
      expect(lines).toEqual([`Approval routing status block omitted: ${mode === 'empty' ? 'PullSourceCountUnavailableError' : 'Error'}`])
    } finally {
      warn.mockRestore()
    }
  })

  it('A13 rows of one enterprise are grouped with counts and booleans only', async () => {
    const provider = `arprsrc${TS}`
    const enterprise = `${CORP_PREFIX}same`
    const verification = {
      corpId: enterprise, appKey: 'app-key-one', corpName: 'Enterprise', appName: 'Application',
      appCorpId: enterprise, appCorpName: 'Enterprise', source: 'admin_console', checkedAt: '2026-10-30T00:00:00.000Z', checkedBy: 'administrator',
    }
    await integration('default', 'same-1', {
      provider, status: 'paused', corp: enterprise,
      config: { appKey: 'app-key-one', corpName: 'Enterprise', appName: 'Application', identityVerification: verification },
    })
    await integration('default', 'same-2', { provider, status: 'paused', corp: enterprise, config: { appKey: 'app-key-two' } })
    const twin = `${CORP_PREFIX}twin`
    await integration('default', 'twin-1', { provider, status: 'paused', corp: twin, config: { appKey: 'app-key-shared' } })
    await integration('default', 'twin-2', { provider, status: 'paused', corp: twin, config: { appKey: ' app-key-shared ' } })
    await integration('default', 'single', { provider, status: 'paused', corp: `${CORP_PREFIX}single`, config: { appKey: 'app-key-single' } })

    const reply = await switchOff(adminGet)
    const groups = (reply.body.data.approvalRouting.sameCorpGroups as Array<Record<string, unknown>>).filter((group) => group.provider === provider)

    expect(groups).toEqual([
      { provider, rowCount: 2, appKeysDiffer: true, identityStatuses: ['unverified', 'verified'] },
      { provider, rowCount: 2, appKeysDiffer: false, identityStatuses: ['unverified', 'unverified'] },
    ])
    expect(reply.text).not.toContain(CORP_PREFIX)
    expect(reply.text).not.toContain('app-key-')
  })

  it.each(['on', 'off'])('A14 linked active accounts under a non-active pull source are counted for this organisation only (switch %s)', async (state) => {
    const run = state === 'on' ? switchOn : switchOff
    // Under source B: the two linked active accounts of the fixture, plus one of each kind below.
    const third = await account(sourceB, NO_LINK, `b-third-${state}`)
    const pending = await account(sourceB, ADMIN, `b-pending-${state}`, { linkStatus: 'pending' })
    const inactive = await account(sourceB, APPROVER, `b-inactive-${state}`, { isActive: false })
    const elsewhere = await integration(OTHER_ORG, `paused-${state}`, { status: 'paused' })
    await account(elsewhere, MGR, `other-paused-${state}`)
    try {
      const allActive = await run(adminGet)
      await setStatus(sourceB, 'paused')
      const paused = await run(adminGet)
      await setStatus(sourceB, 'active')
      const activeAgain = await run(adminGet)

      expect(allActive.body.data.approvalRouting.nonActivePullSourceLinkedAccountCount).toBe(linkedAccountBaseline)
      expect(paused.body.data.approvalRouting.nonActivePullSourceLinkedAccountCount).toBe(linkedAccountBaseline + 3)
      expect(activeAgain.body.data.approvalRouting.nonActivePullSourceLinkedAccountCount).toBe(linkedAccountBaseline)
      expect(paused.text).not.toContain(USER_PREFIX)
      expect(paused.text).not.toContain(EXT_PREFIX)
      expect(paused.text).not.toContain(CORP_PREFIX)
      expect(paused.text).not.toContain(accountOnlyB)
    } finally {
      await query(`DELETE FROM directory_accounts WHERE id = ANY($1::uuid[])`, [[third, pending, inactive]])
    }
  })
})
