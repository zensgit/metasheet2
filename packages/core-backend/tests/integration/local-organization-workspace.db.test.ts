import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { MetaSheetServer } from '../../src/index'
import { query, transaction } from '../../src/db/pg'
import { invalidateUserPerms } from '../../src/rbac/service'
import { applyDirectoryDeprovisionCandidate } from '../../src/directory/deprovision-ledger'
import { restoreDeprovisionEvent, previewDeprovisionForUser } from '../../src/directory/deprovision-evidence-api'
import { lockUsersForAccessGraphWrite } from '../../src/directory/access-graph-mutex'
import { createDirectoryDeprovisionRun } from '../utils/directory-deprovision-fixtures'

// Whole-file native lane; migrations are the runner's responsibility. No head-column/#6589 dependency.
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

// Manual finite manifest: 21 native cases + sentinel = 22. Loops below are predicate variants,
// not extra test cases. Source-fault/read-only-failure phases belong to main (see worker proof).
const ROOT = '/api/admin/directory/local'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type Page<T> = { integrationId: string; page: number; pageSize: number; total: number; items: T[] }
type Member = {
  id: string; name: string; title: string | null; isActive: boolean
  localUser: { id: string; name: string | null; username: string | null } | null
  isEligible: boolean
  memberships: Array<{ id: string; departmentId: string; departmentName: string; departmentActive: boolean; isPrimary: boolean; isManager: boolean }>
}
type Candidate = { id: string; name: string | null; username: string | null }
type Projection = { accountId: string; created: boolean }
type Source = { user: string; org: string; integration: string; account: string; run: string }

describeIfDatabase('native local organization workspace', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  let prefix = ''
  let admin = ''
  const priorEnv = new Map<string, string | undefined>()
  const users: string[] = []
  const integrations: string[] = []
  const tokens = new Map<string, string>()

  beforeAll(async () => {
    // These cases exercise the actual fixed-default HTTP seam. A dedicated migrated database
    // must have no pre-existing default LOCAL anchor. Fail, never skip/remove/reactivate it.
    expect((await query("SELECT id FROM directory_integrations WHERE org_id = 'default' AND provider = 'local'")).rows).toEqual([])
    for (const key of ['RBAC_TOKEN_TRUST', 'RBAC_BYPASS']) {
      priorEnv.set(key, process.env[key])
      process.env[key] = 'false'
    }
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    expect(address && typeof address === 'object' && address.port).toBeTruthy()
    base = `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}`
  }, 15000)

  beforeEach(async () => {
    prefix = `local-workspace-${randomUUID()}`
    expect((await query("SELECT id FROM directory_integrations WHERE org_id = 'default' AND provider = 'local'")).rows).toEqual([])
    admin = await user('admin', true)
    await token(admin) // Authentication/session preparation always precedes snapshots/barriers.
  }, 15000)

  afterEach(async () => {
    // Delete only exact owned IDs, including request-created accounts under owned integrations.
    vi.restoreAllMocks()
    const resources = (await query<{ id: string }>(
      'SELECT id::text FROM directory_accounts WHERE integration_id = ANY($1::uuid[]) UNION ALL SELECT id::text FROM directory_departments WHERE integration_id = ANY($1::uuid[])',
      [integrations],
    )).rows.map(row => row.id)
    const evidenceIds = (await query<{ id: string }>('SELECT id::text FROM directory_deprovision_events WHERE local_user_id = ANY($1::text[])', [users])).rows.map(row => row.id)
    await query('DELETE FROM audit_logs WHERE resource_id = ANY($1::text[])', [[...users, ...integrations, ...resources, ...evidenceIds]])
    await query('DELETE FROM directory_deprovision_events WHERE local_user_id = ANY($1::text[])', [users])
    await query('DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])', [integrations.splice(0)])
    await query('DELETE FROM user_external_identities WHERE local_user_id = ANY($1::text[])', [users])
    await query('DELETE FROM user_external_auth_grants WHERE local_user_id = ANY($1::text[])', [users])
    for (const table of ['user_sessions', 'user_permissions', 'user_roles', 'user_orgs']) {
      await query(`DELETE FROM ${table} WHERE user_id = ANY($1::text[])`, [users])
    }
    await query('DELETE FROM users WHERE id = ANY($1::text[])', [users])
    for (const id of users.splice(0)) invalidateUserPerms(id)
    tokens.clear()
  }, 15000)

  afterAll(async () => {
    try { await server?.stop() } finally {
      for (const [key, value] of priorEnv) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }, 15000)

  async function user(label: string, isAdmin = false): Promise<string> {
    const id = `${prefix}-${label.replace(/[^a-z0-9-]/gi, '-')}`
    users.push(id)
    await query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions,
         is_active, is_admin, activation_status, local_password_set, must_change_password)
       VALUES ($1, $1 || '@example.test', $1, $2, 'x', $3, '[]'::jsonb,
         TRUE, $4, 'activated', TRUE, FALSE)`,
      [id, `${prefix} ${label}`, isAdmin ? 'admin' : 'user', isAdmin],
    )
    await query("INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, 'default', TRUE)", [id])
    return id
  }

  async function token(id: string): Promise<string> {
    if (tokens.has(id)) return tokens.get(id)!
    const response = await fetch(`${base}/api/auth/dev-token?userId=${encodeURIComponent(id)}&roles=user&perms=`)
    expect(response.status).toBe(200)
    const body = await response.json() as { token: string; payload: { roles: string[]; perms: string[]; sid: string } }
    expect(body.payload.roles).toEqual(['user'])
    expect(body.payload.perms).toEqual([])
    expect((await query('SELECT id FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL', [id])).rows)
      .toEqual([{ id: body.payload.sid }])
    tokens.set(id, body.token)
    // Warm the ordinary session-touch path before taking exact business fingerprints.
    const warm = await fetch(`${base}${ROOT}/workspace`, { headers: { Authorization: `Bearer ${body.token}` } })
    await warm.text()
    return body.token
  }

  async function request(path: string, method = 'GET', body?: unknown, actor = admin): Promise<Response> {
    return fetch(`${base}${ROOT}${path}`, {
      method, headers: { Authorization: `Bearer ${await token(actor)}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  async function ok<T>(response: Response): Promise<T> {
    expect(response.status).toBe(200)
    const body = await response.json() as { ok: boolean; data: T }
    expect(Object.keys(body).sort()).toEqual(['data', 'ok'])
    expect(body.ok).toBe(true)
    return body.data
  }

  async function error(response: Response, status: number, code: string): Promise<string> {
    expect(response.status).toBe(status)
    const body = await response.json() as { ok: boolean; error: { code: string; message: string } }
    expect(Object.keys(body).sort()).toEqual(['error', 'ok'])
    expect(Object.keys(body.error).sort()).toEqual(['code', 'message'])
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe(code)
    expect(typeof body.error.message).toBe('string')
    expect(body.error.message.length).toBeGreaterThan(0)
    for (const id of [...users, ...integrations]) expect(JSON.stringify(body)).not.toContain(id)
    return body.error.message
  }

  async function anchor(org = 'default', provider = 'local', status = 'active'): Promise<string> {
    const id = randomUUID()
    integrations.push(id)
    await query(
      `INSERT INTO directory_integrations (id, org_id, provider, name, corp_id, status, sync_enabled, config)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, FALSE, '{"source":"fixture","private":"excluded"}'::jsonb)`,
      [id, org, provider, `${prefix}-anchor-${id}`, provider === 'local' ? `local:${org}` : `fixture:${id}`, status],
    )
    return id
  }

  async function department(integration: string, name: string, parent: string | null = null, provider = 'local', active = true) {
    const id = randomUUID()
    const external = `local:${id}`
    await query(
      `INSERT INTO directory_departments (id, integration_id, provider, external_department_id,
         external_parent_department_id, name, order_index, is_active, raw)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, 0, $7, '{"leader_in_dept":["poison"],"secret":"excluded"}'::jsonb)`,
      [id, integration, provider, external, parent, name, active],
    )
    return { id, external, name }
  }

  async function account(integration: string, uid: string, opts: {
    provider?: string; active?: boolean; key?: string; external?: string; linked?: boolean; linkUser?: string; status?: string; name?: string
  } = {}): Promise<string> {
    const id = randomUUID()
    await query(
      `INSERT INTO directory_accounts (id, integration_id, provider, corp_id, external_user_id, external_key, name, title, is_active, raw)
       VALUES ($1::uuid, $2::uuid, $3, NULL, $4, $5, $6, NULL, $7, $8::jsonb)`,
      [id, integration, opts.provider ?? 'local', opts.external ?? uid, opts.key ?? `default:${uid}`, opts.name ?? uid, opts.active ?? true,
        JSON.stringify(opts.provider && opts.provider !== 'local' ? { source: 'fixture' } : { source: 'local', localUserId: uid })],
    )
    if (opts.linked !== false) await query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
       VALUES ($1::uuid, $2, $3, 'local_explicit')`,
      [id, opts.linkUser ?? uid, opts.status ?? 'linked'],
    )
    return id
  }

  function page(path: string, integration: string, values: Record<string, string | number> = {}) {
    return `${path}?${new URLSearchParams({ integrationId: integration, ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)])) })}`
  }
  async function project(integrationId: string, localUserId: string) {
    return (await ok<{ projection: Projection }>(await request('/member-projections', 'POST', { integrationId, localUserId }))).projection
  }
  async function generation(id: string) {
    return (await query<{ g: string; updated: string }>(
      'SELECT access_generation::text AS g, updated_at::text AS updated FROM users WHERE id = $1', [id],
    )).rows[0]!
  }

  async function fingerprint() {
    const result = await query<Record<string, unknown>>(
      `SELECT
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]') FROM users x WHERE id = ANY($1::text[])) AS users,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.user_id, x.org_id), '[]') FROM user_orgs x WHERE user_id = ANY($1::text[])) AS orgs,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text), '[]') FROM user_roles x WHERE user_id = ANY($1::text[])) AS roles,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text), '[]') FROM user_permissions x WHERE user_id = ANY($1::text[])) AS permissions,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]') FROM user_sessions x WHERE user_id = ANY($1::text[])) AS sessions,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text), '[]') FROM user_external_identities x WHERE local_user_id = ANY($1::text[])) AS identities,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text), '[]') FROM user_external_auth_grants x WHERE local_user_id = ANY($1::text[])) AS grants,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]') FROM directory_deprovision_events x WHERE local_user_id = ANY($1::text[])) AS events,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]') FROM directory_deprovision_effects x WHERE local_user_id = ANY($1::text[])) AS effects,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]') FROM directory_integrations x WHERE id = ANY($2::uuid[]) OR (org_id = 'default' AND provider = 'local')) AS integrations,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]') FROM directory_accounts x WHERE integration_id = ANY($2::uuid[])) AS accounts,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]') FROM directory_departments x WHERE integration_id = ANY($2::uuid[])) AS departments,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]') FROM directory_account_links x
           WHERE directory_account_id IN (SELECT id FROM directory_accounts WHERE integration_id = ANY($2::uuid[]))) AS links,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.directory_account_id, x.directory_department_id), '[]') FROM directory_account_departments x
           WHERE directory_account_id IN (SELECT id FROM directory_accounts WHERE integration_id = ANY($2::uuid[]))) AS memberships`,
      [users, integrations],
    )
    return result.rows[0]!
  }

  async function noChange(action: () => Promise<unknown>) {
    const before = await fingerprint()
    await action()
    expect(await fingerprint()).toEqual(before)
  }

  async function source(uid: string, org = 'default'): Promise<Source> {
    const integration = await anchor(org, 'dingtalk')
    await query("UPDATE directory_integrations SET default_deprovision_policy='disable_grant_only' WHERE id=$1", [integration])
    await query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE) ON CONFLICT (user_id,org_id) DO NOTHING', [uid, org])
    const id = await account(integration, uid, { provider: 'dingtalk', external: `dt:${uid}`, key: `dt:${randomUUID()}`, active: false })
    const run = await createDirectoryDeprovisionRun(integration, 'test:local-workspace')
    return { user: uid, org, integration, account: id, run }
  }
  function apply(s: Source, client: Parameters<Parameters<typeof transaction>[0]>[0]) {
    return applyDirectoryDeprovisionCandidate(client, {
      localUserId: s.user, orgId: s.org, integrationId: s.integration,
      directoryAccountId: s.account, runId: s.run, triggeredBy: 'test:local-workspace',
      policy: 'disable_grant_only', write: true,
    })
  }
  async function applied(uid: string) {
    // Production writer, foreign org: default membership and platform user stay active.
    const s = await source(uid, `${prefix}-evidence-org-${randomUUID()}`)
    const result = await transaction(client => apply(s, client))
    expect(result.applied).toBe(true)
    expect(result.eventId).toMatch(UUID)
    return { ...s, eventId: result.eventId! }
  }

  async function waitForBlock(holder: Client, holderPid: number) {
    const deadline = Date.now() + 3000
    let blocked = false
    while (Date.now() < deadline) {
      const waitingSql = "SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock' AND query ILIKE '%users%'"
      const cached = await holder.query(waitingSql, [holderPid])
      // A transaction may cache its first statistics snapshot; refresh observation only.
      await holder.query('SELECT pg_stat_clear_snapshot()')
      const result = await holder.query(waitingSql, [holderPid])
      if (cached.rows.length === 0 && result.rows.length === 1) {
        console.info('LOCAL_ORG_LOCK_OBSERVER cachedEmpty=true refreshedWaiter=true')
      }
      if (result.rows.length === 1) { blocked = true; break }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(blocked).toBe(true)
  }

  // 1
  it('empty workspace is bootstrap-free and every GET preserves the business fingerprint', async () => {
    await noChange(async () => {
      expect(await ok(await request('/workspace'))).toEqual({ integration: null, departments: [] })
      for (const path of ['/members', '/member-candidates']) {
        await error(await request(page(path, randomUUID())), 409, 'LOCAL_ORG_CONTEXT_CHANGED')
      }
    })
  })

  // 2
  it('sole disabled anchor is read-only; two disabled anchors are ambiguous without guessing', async () => {
    const one = await anchor('default', 'local', 'inactive')
    await noChange(async () => {
      expect(await ok(await request('/workspace'))).toEqual({
        integration: { id: one, name: `${prefix}-anchor-${one}`, isActive: false }, departments: [],
      })
      for (const path of ['/members', '/member-candidates']) {
        expect(await ok(await request(page(path, one, { q: 'no-match' })))).toEqual({
          integrationId: one, page: 1, pageSize: 25, total: 0, items: [],
        })
      }
    })
    await anchor('default', 'local', 'inactive')
    await noChange(async () => {
      await error(await request('/workspace'), 409, 'LOCAL_ORG_ANCHOR_AMBIGUOUS')
    })
  })

  // 3
  it('department tree retains explicit parent/orphan/archive state and excludes provider/foreign/raw data', async () => {
    const a = await anchor()
    const root = await department(a, 'A root')
    const child = await department(a, 'B child', root.external)
    const orphan = await department(a, 'C orphan', 'absent')
    const archived = await department(a, 'D archived', null, 'local', false)
    await department(a, 'excluded-provider', null, 'dingtalk')
    await department(await anchor(`${prefix}-foreign`), 'excluded-foreign')
    await noChange(async () => {
      expect(await ok(await request('/workspace'))).toEqual({
        integration: { id: a, name: `${prefix}-anchor-${a}`, isActive: true },
        departments: [
          { id: root.id, name: root.name, parentDepartmentId: null, parentMissing: false, orderIndex: 0, isActive: true },
          { id: child.id, name: child.name, parentDepartmentId: root.id, parentMissing: false, orderIndex: 0, isActive: true },
          { id: orphan.id, name: orphan.name, parentDepartmentId: null, parentMissing: true, orderIndex: 0, isActive: true },
          { id: archived.id, name: archived.name, parentDepartmentId: null, parentMissing: false, orderIndex: 0, isActive: false },
        ],
      })
    })
  })

  // 4
  it('members expose exact explicit primary/manager relations and literal percent/underscore search with total beyond last page', async () => {
    const a = await anchor()
    const uid = await user('member')
    const id = await account(a, uid, { name: 'Literal%_member' })
    const d = await department(a, 'Native')
    await query('INSERT INTO directory_account_departments (directory_account_id,directory_department_id,is_primary,is_manager) VALUES ($1,$2,TRUE,TRUE)', [id, d.id])
    await account(a, await user('unlinked'), { linked: false, name: 'Literal-other' })
    await account(a, await user('excluded-provider'), { provider: 'dingtalk', name: 'Literal%_excluded' })
    await account(await anchor(`${prefix}-foreign`), await user('foreign'), { name: 'Literal%_foreign' })
    await noChange(async () => {
      const expected: Member = {
        id, name: 'Literal%_member', title: null, isActive: true,
        localUser: { id: uid, name: `${prefix} member`, username: uid }, isEligible: true,
        memberships: [{ id: `${id}:${d.id}`, departmentId: d.id, departmentName: d.name, departmentActive: true, isPrimary: true, isManager: true }],
      }
      for (const q of ['%', '_', '%_', '  %_  ']) {
        expect(await ok<Page<Member>>(await request(page('/members', a, { q, pageSize: 1 })))).toEqual({
          integrationId: a, page: 1, pageSize: 1, total: 1, items: [expected],
        })
        expect(await ok(await request(page('/members', a, { q, page: 2, pageSize: 1 })))).toEqual({
          integrationId: a, page: 2, pageSize: 1, total: 1, items: [],
        })
      }
      const all = await ok<Page<Member>>(await request(page('/members', a)))
      expect(all.items.map(row => row.name)).toEqual(['Literal%_member', 'Literal-other'])
      expect(all.items[1]).toEqual({ id: all.items[1]!.id, name: 'Literal-other', title: null, isActive: true, localUser: null, isEligible: false, memberships: [] })
    })
  })

  // 5
  it('candidate list filters current-org active users, evidence and every existing projection, with literal search and exact totals', async () => {
    const a = await anchor()
    const yes = await user('candidate%_yes')
    const projected = await user('candidate%_projected')
    await account(a, projected, { active: false })
    const keyOnly = await user('candidate%_key-only')
    await account(a, keyOnly, { external: 'legacy:' + keyOnly, linked: false })
    const oldAnchor = await anchor('default', 'local', 'disabled')
    const oldProjection = await user('candidate%_old-anchor')
    await account(oldAnchor, oldProjection, { active: false })
    const inactive = await user('candidate%_inactive')
    await query('UPDATE users SET is_active=FALSE WHERE id=$1', [inactive])
    const foreign = await user('candidate%_foreign')
    await query("UPDATE user_orgs SET org_id=$2 WHERE user_id=$1 AND org_id='default'", [foreign, `${prefix}-foreign`])
    const history = await user('candidate%_history')
    await applied(history)
    await user('candidate-wildcard-decoy')
    await user('candidate%Xdecoy')
    await noChange(async () => {
      for (const q of ['candidate%_', '%_']) {
        expect(await ok(await request(page('/member-candidates', a, { q, pageSize: 1 })))).toEqual({
          integrationId: a, page: 1, pageSize: 1, total: 1,
          items: [{ id: yes, name: `${prefix} candidate%_yes`, username: yes }],
        })
        expect(await ok(await request(page('/member-candidates', a, { q, pageSize: 1, page: 2 })))).toEqual({
          integrationId: a, page: 2, pageSize: 1, total: 1, items: [],
        })
      }
    })
  })

  // 6
  it('all page reads pin the independently resolved anchor and reject foreign/stale UUIDs without mutation', async () => {
    const a = await anchor()
    const foreign = await anchor(`${prefix}-foreign`)
    await noChange(async () => {
      for (const path of ['/members', '/member-candidates']) {
        for (const id of [foreign, randomUUID()]) await error(await request(page(path, id)), 409, 'LOCAL_ORG_CONTEXT_CHANGED')
        expect((await ok<Page<Candidate>>(await request(page(path, a)))).integrationId).toBe(a)
      }
    })
  })

  // 7
  it('real claim-free ordinary DB user gets 403 before query/body validation on all four doors', async () => {
    const ordinary = await user('ordinary')
    await token(ordinary)
    await noChange(async () => {
      for (const path of ['/workspace?org_id=spoof', '/members?page=0', '/member-candidates?page=0']) {
        await error(await request(path, 'GET', undefined, ordinary), 403, 'FORBIDDEN')
      }
      await error(await request('/member-projections', 'POST', { org_id: 'spoof' }, ordinary), 403, 'FORBIDDEN')
    })
  })

  // 8
  it('strict page/query validation refuses malformed arrays, unknown org/corp and unsafe numeric ranges with exact no-op', async () => {
    const a = await anchor()
    const bad = [
      '', 'integrationId=wrong', `integrationId=${a}&integrationId=${a}`,
      `integrationId=${a}&page=0`, `integrationId=${a}&page=-1`, `integrationId=${a}&page=1.5`,
      `integrationId=${a}&page=01`, `integrationId=${a}&page=9007199254740992`,
      `integrationId=${a}&page=9007199254740991&pageSize=100`,
      `integrationId=${a}&pageSize=0`, `integrationId=${a}&pageSize=101`,
      `integrationId=${a}&q=x&q=y`, `integrationId=${a}&q=${'x'.repeat(201)}`,
    ]
    await noChange(async () => {
      for (const path of ['/members', '/member-candidates']) {
        for (const q of bad) await error(await request(`${path}?${q}`), 400, 'DIRECTORY_LOCAL_INVALID_INPUT')
        for (const key of ['org_id', 'corp_id', 'orgId', 'unknown']) {
          await error(await request(`${path}?integrationId=${a}&${key}=spoof`), 400, 'DIRECTORY_LOCAL_UNKNOWN_FIELDS')
        }
      }
      await error(await request('/workspace?integrationId=spoof'), 400, 'DIRECTORY_LOCAL_UNKNOWN_FIELDS')
    })
  })

  // 9
  it('projection POST accepts exactly two strict fields and rejects invalid shape/length before mutation', async () => {
    const a = await anchor()
    const uid = await user('subject')
    await noChange(async () => {
      for (const body of [[], {}, { localUserId: uid }, { integrationId: a }, { integrationId: 'bad', localUserId: uid },
        { integrationId: [a], localUserId: uid }, { integrationId: a, localUserId: null },
        { integrationId: a, localUserId: 1 }, { integrationId: a, localUserId: ' ' },
        { integrationId: a, localUserId: 'x'.repeat(201) }]) {
        await error(await request('/member-projections', 'POST', body), 400, 'DIRECTORY_LOCAL_INVALID_INPUT')
      }
      for (const key of ['org_id', 'corp_id', 'name', 'permissions', 'actorId', 'reason', 'accessGeneration']) {
        await error(await request('/member-projections', 'POST', { integrationId: a, localUserId: uid, [key]: 'spoof' }), 400, 'DIRECTORY_LOCAL_UNKNOWN_FIELDS')
      }
    })
  })

  // 10
  it('missing user/active anchor is 404; expected-anchor mismatch is 409, never bootstrap/reactivate', async () => {
    const uid = await user('subject')
    await noChange(async () => {
      await error(await request('/member-projections', 'POST', { integrationId: randomUUID(), localUserId: uid }), 404, 'DIRECTORY_LOCAL_NOT_FOUND')
    })
    const a = await anchor()
    await noChange(async () => {
      await error(await request('/member-projections', 'POST', { integrationId: a, localUserId: `${prefix}-missing` }), 404, 'DIRECTORY_LOCAL_NOT_FOUND')
      await error(await request('/member-projections', 'POST', { integrationId: randomUUID(), localUserId: uid }), 409, 'LOCAL_ORG_CONTEXT_CHANGED')
    })
    await query("UPDATE directory_integrations SET status='inactive' WHERE id=$1", [a])
    await noChange(async () => {
      await error(await request('/member-projections', 'POST', { integrationId: a, localUserId: uid }), 404, 'DIRECTORY_LOCAL_NOT_FOUND')
    })
  })

  // 11
  it('new projection has native keys/link and canonical both-leg zero-row evidence trace with exactly one generation write', async () => {
    const a = await anchor()
    const uid = await user('subject')
    await token(uid)
    // Retain legitimate historical rows: producer -> real admin-force restore -> projection.
    const evidence = await applied(uid)
    await restoreDeprovisionEvent({ eventId: evidence.eventId, mode: 'admin_force', adminUserId: admin, confirm: true, note: 'native workspace historical evidence control' })
    const before = await fingerprint()
    const beforeG = await generation(uid)
    const trace: Array<{ statement: string; affected: number | null }> = []
    const actualQuery = Client.prototype.query
    // Observation of the REAL pg driver only: forwards original overload/callback/result/error.
    // No fake client, canned rows, source fault or production seam.
    const spy = vi.spyOn(Client.prototype, 'query').mockImplementation((function (this: Client, ...args: unknown[]) {
      const first = args[0]
      const config = first && typeof first === 'object' ? first as { text?: string; values?: unknown[] } : undefined
      const sql = (typeof first === 'string' ? first : config?.text ?? '').replace(/\s+/g, ' ').trim()
      const values = Array.isArray(args[1]) ? args[1] : config?.values ?? []
      const target = values.includes(uid) && /^UPDATE (?:directory_deprovision_effects|directory_deprovision_events|users)\b/.test(sql)
      const record = (result: unknown) => {
        if (target) {
          const native = result as { rowCount: number | null }
          if (sql.startsWith('UPDATE directory_deprovision_events')) {
            expect(values[1]).toBe(admin)
            expect(typeof values[2]).toBe('string')
            expect(String(values[2]).length).toBeGreaterThan(0)
            expect(String(values[2])).not.toContain(uid)
          }
          trace.push({ statement: sql.split(' ')[1]!, affected: native.rowCount })
        }
      }
      const last = args[args.length - 1]
      if (typeof last === 'function') {
        args[args.length - 1] = function (this: unknown, failure: unknown, result: unknown) {
          if (!failure) record(result)
          return Reflect.apply(last, this, [failure, result])
        }
        return Reflect.apply(actualQuery, this, args)
      }
      const result = Reflect.apply(actualQuery, this, args) as Promise<unknown>
      return result.then(value => { record(value); return value })
    }) as typeof Client.prototype.query)
    let projection: Projection | undefined
    try {
      projection = await project(a, uid)
      const createdFingerprint = await fingerprint()
      expect(await project(a, uid)).toEqual({ accountId: projection.accountId, created: false })
      expect(await fingerprint()).toEqual(createdFingerprint)
      // Trace must still contain only the initial creation's three UPDATEs.
    } finally { spy.mockRestore() }
    expect(projection!.created).toBe(true)
    expect(projection!.accountId).toMatch(UUID)
    expect(trace).toEqual([
      { statement: 'directory_deprovision_effects', affected: 0 },
      { statement: 'directory_deprovision_events', affected: 0 },
      { statement: 'users', affected: 1 },
    ])
    const row = (await query(
      'SELECT integration_id::text,provider,corp_id,external_user_id,external_key,is_active,raw FROM directory_accounts WHERE id=$1', [projection!.accountId],
    )).rows
    expect(row).toEqual([{ integration_id: a, provider: 'local', corp_id: null, external_user_id: uid, external_key: `default:${uid}`, is_active: true, raw: { source: 'local', localUserId: uid } }])
    expect((await query('SELECT local_user_id,link_status,match_strategy FROM directory_account_links WHERE directory_account_id=$1', [projection!.accountId])).rows)
      .toEqual([{ local_user_id: uid, link_status: 'linked', match_strategy: 'local_explicit' }])
    const after = await fingerprint()
    for (const key of ['orgs', 'roles', 'permissions', 'sessions', 'identities', 'grants', 'events', 'effects', 'integrations', 'departments', 'memberships']) expect(after[key]).toEqual(before[key])
    const cleanUsers = (rows: unknown) => (rows as Array<Record<string, unknown>>).map(({ access_generation: _g, updated_at: _t, ...rest }) => rest)
    expect(cleanUsers(after.users)).toEqual(cleanUsers(before.users))
    const afterG = await generation(uid)
    expect(BigInt(afterG.g)).toBe(BigInt(beforeG.g) + 1n)
    expect(afterG.updated).not.toBe(beforeG.updated)
  })

  // 12
  it('sequential and concurrent retries create one account/link and increment generation once, with exact idempotent no-op', async () => {
    const a = await anchor()
    const uid = await user('subject')
    const before = await generation(uid)
    const pair = await Promise.all([project(a, uid), project(a, uid)])
    expect(pair.map(row => row.created).sort()).toEqual([false, true])
    expect(pair[0]!.accountId).toBe(pair[1]!.accountId)
    expect(BigInt((await generation(uid)).g)).toBe(BigInt(before.g) + 1n)
    expect((await query('SELECT id FROM directory_accounts WHERE integration_id=$1 AND external_user_id=$2', [a, uid])).rows).toEqual([{ id: pair[0]!.accountId }])
    await noChange(async () => {
      expect(await project(a, uid)).toEqual({ accountId: pair[0]!.accountId, created: false })
      expect(await project(a, uid)).toEqual({ accountId: pair[0]!.accountId, created: false })
    })
  })

  // 13
  it('old account-create door still returns strict Slice C 409 for an active member while the new projection door succeeds', async () => {
    const a = await anchor()
    const uid = await user('subject')
    await noChange(async () => {
      await error(await request('/accounts', 'POST', { localUserId: uid }), 409, 'DIRECTORY_LOCAL_ORG_MEMBERSHIP_HISTORY')
    })
    expect((await project(a, uid)).created).toBe(true)
  })

  // 14
  it('inactive user and inactive/missing/foreign current-org membership refuse with restored positive controls', async () => {
    const a = await anchor()
    for (const variant of ['user', 'inactive-org', 'missing-org', 'foreign-org']) {
      const uid = await user(variant)
      if (variant === 'user') await query('UPDATE users SET is_active=FALSE WHERE id=$1', [uid])
      else if (variant === 'inactive-org') await query("UPDATE user_orgs SET is_active=FALSE WHERE user_id=$1 AND org_id='default'", [uid])
      else {
        await query("DELETE FROM user_orgs WHERE user_id=$1 AND org_id='default'", [uid])
        if (variant === 'foreign-org') await query('INSERT INTO user_orgs(user_id,org_id,is_active) VALUES ($1,$2,TRUE)', [uid, `${prefix}-foreign`])
      }
      await noChange(async () => {
        await error(await request('/member-projections', 'POST', { integrationId: a, localUserId: uid }), 409, 'DIRECTORY_LOCAL_CONFLICT')
      })
      await query('UPDATE users SET is_active=TRUE WHERE id=$1', [uid])
      await query("INSERT INTO user_orgs(user_id,org_id,is_active) VALUES ($1,'default',TRUE) ON CONFLICT(user_id,org_id) DO UPDATE SET is_active=TRUE", [uid])
      expect((await project(a, uid)).created).toBe(true)
    }
  })

  // 15
  it('production global applied history and event-only/effect-only component states refuse without superseding evidence', async () => {
    const a = await anchor()
    for (const variant of ['production', 'event-only', 'effect-only']) {
      const uid = await user(variant)
      const evidence = await applied(uid)
      // Component isolation uses legal raw status updates under the users mutex. It is NOT a
      // claim these split event/effect statuses are produced by ordinary runtime writers.
      if (variant !== 'production') await transaction(async client => {
        await lockUsersForAccessGraphWrite(client, [uid])
        if (variant === 'event-only') await client.query("UPDATE directory_deprovision_effects SET status='superseded' WHERE local_user_id=$1", [uid])
        else await client.query("UPDATE directory_deprovision_events SET status='superseded' WHERE local_user_id=$1", [uid])
      })
      await noChange(async () => {
        await error(await request('/member-projections', 'POST', { integrationId: a, localUserId: uid }), 409, 'DIRECTORY_LOCAL_CONFLICT')
        expect((await ok<Page<Candidate>>(await request(page('/member-candidates', a, { q: uid })))).items).toEqual([])
      })
      if (variant === 'production') {
        await restoreDeprovisionEvent({ eventId: evidence.eventId, mode: 'admin_force', adminUserId: admin, confirm: true, note: 'native workspace production restore control' })
      } else await transaction(async client => {
        await lockUsersForAccessGraphWrite(client, [uid])
        await client.query("UPDATE directory_deprovision_effects SET status='superseded' WHERE local_user_id=$1 AND status='applied'", [uid])
        await client.query("UPDATE directory_deprovision_events SET status='superseded' WHERE local_user_id=$1 AND status='applied'", [uid])
      })
      expect((await project(a, uid)).created).toBe(true)
    }
  })

  // 16
  it('inactive/partial/wrong-user/provider/key projections cannot be healed; a valid complete projection remains idempotent', async () => {
    const a = await anchor()
    const other = await user('other')
    for (const variant of ['inactive', 'unlinked', 'pending', 'wrong-user', 'provider', 'key', 'external', 'corp', 'foreign-anchor']) {
      const uid = await user(variant)
      const sourceAnchor = variant === 'foreign-anchor' ? await anchor('default', 'local', 'inactive') : a
      const id = await account(sourceAnchor, uid, {
        external: variant === 'external' ? `wrong:${uid}` : uid,
        active: variant !== 'inactive', linked: variant !== 'unlinked',
        status: variant === 'pending' ? 'pending' : 'linked',
        linkUser: variant === 'wrong-user' ? other : uid,
        provider: variant === 'provider' ? 'dingtalk' : 'local',
        key: variant === 'key' ? `bad:${uid}` : `default:${uid}`,
      })
      if (variant === 'corp') await query("UPDATE directory_accounts SET corp_id='local:default' WHERE id=$1", [id])
      await noChange(async () => {
        await error(await request('/member-projections', 'POST', { integrationId: a, localUserId: uid }), 409, 'DIRECTORY_LOCAL_CONFLICT')
      })
      // Repair only our own synthetic fixture to restore the matching positive control.
      // The preceding HTTP refusal must not have performed any of these changes.
      await query("UPDATE directory_accounts SET integration_id=$2,provider='local',corp_id=NULL,external_user_id=$3,external_key=$4,is_active=TRUE,raw=$5::jsonb WHERE id=$1",
        [id, a, uid, `default:${uid}`, JSON.stringify({ source: 'local', localUserId: uid })])
      await query(
        `INSERT INTO directory_account_links(directory_account_id,local_user_id,link_status,match_strategy)
         VALUES ($1,$2,'linked','local_explicit') ON CONFLICT(directory_account_id)
         DO UPDATE SET local_user_id=$2,link_status='linked',match_strategy='local_explicit'`, [id, uid],
      )
      await noChange(async () => { expect(await project(a, uid)).toEqual({ accountId: id, created: false }) })
    }
    const valid = await user('valid')
    const id = await account(a, valid)
    await noChange(async () => {
      expect(await project(a, valid)).toEqual({ accountId: id, created: false })
    })
    // Even an existing valid projection must recheck safety before idempotent return.
    await query("UPDATE user_orgs SET is_active=FALSE WHERE user_id=$1 AND org_id='default'", [valid])
    await noChange(async () => {
      await error(await request('/member-projections', 'POST', { integrationId: a, localUserId: valid }), 409, 'DIRECTORY_LOCAL_CONFLICT')
    })
    await query("UPDATE user_orgs SET is_active=TRUE WHERE user_id=$1 AND org_id='default'", [valid])
    await noChange(async () => { expect(await project(a, valid)).toEqual({ accountId: id, created: false }) })
    await applied(valid)
    await noChange(async () => {
      await error(await request('/member-projections', 'POST', { integrationId: a, localUserId: valid }), 409, 'DIRECTORY_LOCAL_CONFLICT')
    })
  })

  // 17
  it('a membership deactivation committed while POST waits on users mutex is seen by a fresh statement', async () => {
    const a = await anchor()
    const uid = await user('subject')
    const originalG = await generation(uid)
    const holder = new Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    let pending: Promise<Response> | undefined
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [uid])
      await holder.query("UPDATE user_orgs SET is_active=FALSE WHERE user_id=$1 AND org_id='default'", [uid])
      const pid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      pending = request('/member-projections', 'POST', { integrationId: a, localUserId: uid })
      void pending.catch(() => undefined)
      await waitForBlock(holder, pid)
      await holder.query('COMMIT')
      await error(await pending!, 409, 'DIRECTORY_LOCAL_CONFLICT')
      expect(await generation(uid)).toEqual(originalG)
      expect((await query("SELECT id FROM directory_accounts WHERE integration_id=$1 AND external_user_id=$2", [a, uid])).rows).toEqual([])
    } finally {
      await holder.query('ROLLBACK')
      if (pending) await pending.catch(() => undefined)
      await holder.end()
    }
    await query("UPDATE user_orgs SET is_active=TRUE WHERE user_id=$1 AND org_id='default'", [uid])
    expect((await project(a, uid)).created).toBe(true)
  })

  // 18
  it('production deprovision-before-projection commits while POST waits; fresh global evidence refuses', async () => {
    const a = await anchor()
    const uid = await user('subject')
    const s = await source(uid, `${prefix}-foreign-evidence`)
    const holder = new Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    let pending: Promise<Response> | undefined
    try {
      await holder.query('BEGIN')
      const result = await apply(s, holder)
      expect(result.applied).toBe(true)
      const committed = (await holder.query(
        `SELECT (SELECT to_jsonb(u) FROM users u WHERE id=$1) AS person,
          (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM directory_deprovision_events e WHERE local_user_id=$1) AS events,
          (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM directory_deprovision_effects e WHERE local_user_id=$1) AS effects`, [uid],
      )).rows[0]
      const pid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      pending = request('/member-projections', 'POST', { integrationId: a, localUserId: uid })
      void pending.catch(() => undefined)
      await waitForBlock(holder, pid)
      await holder.query('COMMIT')
      await error(await pending!, 409, 'DIRECTORY_LOCAL_CONFLICT')
      expect((await query(
        `SELECT (SELECT to_jsonb(u) FROM users u WHERE id=$1) AS person,
          (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM directory_deprovision_events e WHERE local_user_id=$1) AS events,
          (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM directory_deprovision_effects e WHERE local_user_id=$1) AS effects`, [uid],
      )).rows[0]).toEqual(committed)
      expect((await query('SELECT id FROM directory_accounts WHERE integration_id=$1 AND external_user_id=$2', [a, uid])).rows).toEqual([])
    } finally {
      await holder.query('ROLLBACK')
      if (pending) await pending.catch(() => undefined)
      await holder.end()
    }
  })

  // 19
  it('anchor FOR SHARE NOWAIT refuses a conflicting source lock promptly and releases users mutex', async () => {
    const a = await anchor()
    const uid = await user('subject')
    const before = await fingerprint()
    const holder = new Client({ connectionString: process.env.DATABASE_URL })
    const probe = new Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    await probe.connect()
    let pending: Promise<Response> | undefined
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM directory_integrations WHERE id=$1 FOR UPDATE', [a])
      let settled = false
      pending = request('/member-projections', 'POST', { integrationId: a, localUserId: uid })
      pending.then(() => { settled = true }, () => { settled = true })
      const deadline = Date.now() + 3000
      while (!settled && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
      expect(settled).toBe(true) // Must finish BEFORE holder releases the conflicting integration lock.
      await error(await pending!, 409, 'DIRECTORY_LOCAL_CONFLICT')
      expect(await fingerprint()).toEqual(before)
      await probe.query('BEGIN')
      expect((await probe.query('SELECT id FROM users WHERE id=$1 FOR UPDATE NOWAIT', [uid])).rows).toEqual([{ id: uid }])
      await probe.query('ROLLBACK')
    } finally {
      await probe.query('ROLLBACK')
      await holder.query('ROLLBACK')
      if (pending) await pending.catch(() => undefined)
      await probe.end()
      await holder.end()
    }
    expect((await project(a, uid)).created).toBe(true)
  })

  // 20
  it('committed anchor disable refuses without reviving or creating a projection', async () => {
    const a = await anchor()
    const uid = await user('subject')
    await query("UPDATE directory_integrations SET status='inactive' WHERE id=$1", [a])
    await noChange(async () => {
      await error(await request('/member-projections', 'POST', { integrationId: a, localUserId: uid }), 404, 'DIRECTORY_LOCAL_NOT_FOUND')
    })
    await query("UPDATE directory_integrations SET status='active' WHERE id=$1", [a]) // Owned fixture only.
    expect((await project(a, uid)).created).toBe(true)
  })

  // 21
  it('same-org projection changes a prospective plan; production apply sees the fresh local sibling and writes no effects', async () => {
    const a = await anchor()
    const uid = await user('subject')
    const s = await source(uid)
    // Prospective preview requires an active source account; actual apply requires it inactive.
    await query('UPDATE directory_accounts SET is_active=TRUE WHERE id=$1', [s.account])
    const preview = await previewDeprovisionForUser(uid, s.integration)
    expect(preview.plan.effects.length).toBeGreaterThan(0)
    const before = await generation(uid)
    await project(a, uid)
    expect(BigInt((await generation(uid)).g)).toBe(BigInt(before.g) + 1n)
    await transaction(async client => {
      await lockUsersForAccessGraphWrite(client, [uid])
      await client.query('UPDATE directory_accounts SET is_active=FALSE WHERE id=$1', [s.account])
    })
    const snapshot = await fingerprint()
    const result = await transaction(client => apply(s, client))
    expect(result.applied).toBe(false)
    expect(result.eventId).toBeNull()
    expect(result.globallyClear).toBe(false)
    expect(result.skipReason).toBeNull()
    expect(result.plan.effects).toEqual([])
    expect(await fingerprint()).toEqual(snapshot)
    // Preview has no commit-token API: no invented old-preview 409 assertion.
  })
})
