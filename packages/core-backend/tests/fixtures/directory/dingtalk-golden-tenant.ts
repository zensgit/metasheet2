/**
 * Synthetic DingTalk tenant used by the directory sync characterization suite.
 *
 * The file lists rows only: the provider-side directory, the prior shadow/link/local-user state
 * each apply scenario starts from, and the read-back queries that serialize the result.
 * All identifiers are fixed strings (`a0g-` prefix, one scenario letter per integration).
 */
import { DIRECTORY_ADMIN_UNBOUND_MATCH_STRATEGY } from '../../../src/directory/directory-link-intent'
import { DingTalkIncompleteResponseError } from '../../../src/integrations/dingtalk/transport'
import { createAliaser } from './golden-harness'

export type ScenarioKey = 'a' | 'b' | 'c' | 'd' | 'e' | 'f'
export type ClientVariant = 'normal' | 'cursor' | 'shape'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>

export const GOLDEN_TOKEN = 'a0g-token'
export const GOLDEN_SECRET = 'a0g-secret'
export const GOLDEN_PREFIX = 'a0g-'

const SCENARIO_INDEX: Record<ScenarioKey, number> = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }

export interface ScenarioNames {
  key: ScenarioKey
  integrationName: string
  corpId: string
  appKey: string
}

export function scenarioNames(key: ScenarioKey): ScenarioNames {
  return {
    key,
    integrationName: `a0g-int-${key}`,
    corpId: `a0g-corp-${key}`,
    appKey: `a0g-appkey-${key}`,
  }
}

// ---------------------------------------------------------------------------------------------
// Provider-side directory
// ---------------------------------------------------------------------------------------------

export const DEPARTMENTS = [
  { id: 'dA', parentId: '1', name: 'Dept A', order: 1 },
  { id: 'dB', parentId: '1', name: 'Dept B', order: 2 },
  { id: 'dC', parentId: '1', name: 'Dept C', order: 3 },
  { id: 'dA1', parentId: 'dA', name: 'Dept A1', order: 1 },
] as const

const CHILDREN_BY_PARENT: Record<string, ReadonlyArray<(typeof DEPARTMENTS)[number]>> = {
  '1': DEPARTMENTS.filter((department) => department.parentId === '1'),
  dA: DEPARTMENTS.filter((department) => department.parentId === 'dA'),
}

/** Department detail answers; `dA1` is not answered (the call fails). */
const MANAGERS_BY_DEPARTMENT: Record<string, string[]> = {
  '1': [],
  dA: [],
  dB: ['a0g-u10'],
  dC: [],
}

interface DirectoryUserSpec {
  n: number
  departmentIds: string[]
  hasOpenId: boolean
  email: 'own' | 'none'
  mobile: boolean
}

export const DIRECTORY_USERS: DirectoryUserSpec[] = [
  { n: 1, departmentIds: ['dA', 'dA1'], hasOpenId: true, email: 'own', mobile: false },
  { n: 2, departmentIds: ['dA'], hasOpenId: false, email: 'own', mobile: false },
  { n: 3, departmentIds: ['dA'], hasOpenId: true, email: 'own', mobile: false },
  { n: 4, departmentIds: ['dA'], hasOpenId: true, email: 'none', mobile: true },
  { n: 5, departmentIds: ['dB'], hasOpenId: true, email: 'none', mobile: true },
  { n: 6, departmentIds: ['dA'], hasOpenId: true, email: 'own', mobile: false },
  { n: 7, departmentIds: ['dB'], hasOpenId: true, email: 'own', mobile: false },
  { n: 8, departmentIds: ['dA'], hasOpenId: true, email: 'none', mobile: false },
  { n: 9, departmentIds: ['dA1'], hasOpenId: true, email: 'none', mobile: false },
  { n: 10, departmentIds: ['dB'], hasOpenId: true, email: 'none', mobile: false },
  { n: 11, departmentIds: ['dB'], hasOpenId: true, email: 'own', mobile: false },
  { n: 12, departmentIds: ['dB'], hasOpenId: true, email: 'none', mobile: false },
]

/** Member pages per department: [cursor, member numbers, hasMore, nextCursor]. */
const USER_PAGES: Record<string, Array<{ cursor: number; members: number[]; hasMore: boolean; nextCursor: number | null }>> = {
  '1': [{ cursor: 0, members: [], hasMore: false, nextCursor: null }],
  dA: [
    { cursor: 0, members: [1, 2], hasMore: true, nextCursor: 50 },
    { cursor: 50, members: [3, 4, 6, 8], hasMore: false, nextCursor: null },
  ],
  dB: [{ cursor: 0, members: [5, 7, 10, 11, 12], hasMore: false, nextCursor: null }],
  dC: [{ cursor: 0, members: [], hasMore: false, nextCursor: null }],
  dA1: [{ cursor: 0, members: [1, 9], hasMore: false, nextCursor: null }],
}

export function extUserId(n: number): string {
  return `a0g-u${n}`
}

export function userName(n: number): string {
  return `User ${n}`
}

export function unionIdOf(key: ScenarioKey, name: string): string {
  return `a0g-${key}-${name}-union`
}

export function openIdOf(key: ScenarioKey, name: string): string {
  return `a0g-${key}-${name}-open`
}

export function emailOf(key: ScenarioKey, n: number): string {
  return `a0g-${key}-u${n}@example.test`
}

export function mobileOf(key: ScenarioKey, n: number): string {
  return `139000${SCENARIO_INDEX[key]}00${String(n).padStart(2, '0')}`
}

function specFor(n: number): DirectoryUserSpec {
  const spec = DIRECTORY_USERS.find((candidate) => candidate.n === n)
  if (!spec) throw new Error(`unknown member ${n}`)
  return spec
}

function userSummary(n: number, departmentId: string) {
  return { userId: extUserId(n), name: userName(n), departmentIds: [departmentId], source: {} }
}

function userDetail(key: ScenarioKey, n: number) {
  const spec = specFor(n)
  return {
    userId: extUserId(n),
    name: userName(n),
    unionId: unionIdOf(key, `u${n}`),
    openId: spec.hasOpenId ? openIdOf(key, `u${n}`) : undefined,
    email: spec.email === 'own' ? emailOf(key, n) : undefined,
    mobile: spec.mobile ? mobileOf(key, n) : undefined,
    departmentIds: [...spec.departmentIds],
    source: {},
  }
}

/** Arms the five provider client functions for one scenario; the scenario's mocks are cleared first. */
export function armGoldenClient(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mocks: Record<string, any>,
  key: ScenarioKey,
  variant: ClientVariant = 'normal',
): void {
  for (const fn of Object.values(mocks)) fn.mockReset()
  mocks.fetchDingTalkAppAccessToken.mockImplementation(async () => GOLDEN_TOKEN)
  mocks.listDingTalkDepartments.mockImplementation(async (_token: string, parentId: string) => {
    if (variant === 'shape') {
      throw new DingTalkIncompleteResponseError('Failed to read complete DingTalk departments', {})
    }
    return (CHILDREN_BY_PARENT[parentId] ?? []).map((department) => ({ ...department, source: {} }))
  })
  mocks.getDingTalkDepartmentDetail.mockImplementation(async (_token: string, departmentId: string) => {
    const managers = MANAGERS_BY_DEPARTMENT[departmentId]
    if (!managers) throw new Error('department detail unavailable')
    return { deptManagerUserIdList: [...managers] }
  })
  mocks.listDingTalkDepartmentUsers.mockImplementation(async (_token: string, departmentId: string, cursor: number) => {
    const page = (USER_PAGES[departmentId] ?? []).find((candidate) => candidate.cursor === cursor)
    if (!page) return { users: [], nextCursor: null, hasMore: false }
    const useBrokenCursor = variant === 'cursor' && departmentId === 'dA' && cursor === 50
    return {
      users: page.members.map((n) => userSummary(n, departmentId)),
      nextCursor: useBrokenCursor ? 0 : page.nextCursor,
      hasMore: useBrokenCursor ? true : page.hasMore,
    }
  })
  mocks.getDingTalkUserDetail.mockImplementation(async (_token: string, userId: string) => {
    const n = Number(userId.replace('a0g-u', ''))
    return userDetail(key, n)
  })
}

// ---------------------------------------------------------------------------------------------
// Prior state: shadow rows, links and local users an apply scenario starts from
// ---------------------------------------------------------------------------------------------

const PRIOR_LAST_SEEN = '2000-01-01T00:00:00.000Z'

interface LocalUserSeed {
  name: string
  email: string
  mobile: string | null
  isActive: boolean
}

export function localUserId(key: ScenarioKey, name: string): string {
  return `a0g-lu-${key}-${name}`
}

export function localUserSeeds(key: ScenarioKey): Record<string, LocalUserSeed> {
  const own = (name: string) => `a0g-${key}-lu-${name}@example.test`
  return {
    u3: { name: 'Local u3', email: emailOf(key, 3), mobile: null, isActive: true },
    u4: { name: 'Local u4', email: own('u4'), mobile: mobileOf(key, 4), isActive: true },
    u5a: { name: 'Local u5a', email: own('u5a'), mobile: mobileOf(key, 5), isActive: true },
    u5b: { name: 'Local u5b', email: own('u5b'), mobile: mobileOf(key, 5), isActive: true },
    u9: { name: 'Local u9', email: own('u9'), mobile: null, isActive: true },
    u10: { name: 'Local u10', email: own('u10'), mobile: null, isActive: true },
    u11: { name: 'Local u11', email: emailOf(key, 11), mobile: null, isActive: true },
    u12: { name: 'Local u12', email: own('u12'), mobile: null, isActive: false },
    old1: { name: 'Local old1', email: own('old1'), mobile: null, isActive: true },
  }
}

export function seededLocalUserIds(key: ScenarioKey): string[] {
  return Object.keys(localUserSeeds(key)).map((name) => localUserId(key, name))
}

/** Removes anything a previous aborted run left behind under the fixed prefix. */
export async function cleanLeftovers(query: QueryFn): Promise<void> {
  const integrations = await query(`SELECT id::text AS id FROM directory_integrations WHERE name LIKE 'a0g-int-%'`)
  for (const row of integrations.rows) await cleanupIntegrationRows(query, row.id)
  const users = await query(
    `SELECT id FROM users
      WHERE id LIKE 'a0g-lu-%'
         OR email LIKE 'a0g-%@example.test'
         OR id IN (SELECT local_user_id FROM user_external_identities WHERE corp_id LIKE 'a0g-corp-%')`,
  )
  await cleanupUsers(query, users.rows.map((row) => String(row.id)))
}

export async function cleanupIntegrationRows(query: QueryFn, integrationId: string): Promise<void> {
  await query(`DELETE FROM directory_sync_alerts WHERE integration_id = $1`, [integrationId])
  await query(
    `DELETE FROM directory_deprovision_effects WHERE event_id IN
       (SELECT id FROM directory_deprovision_events WHERE integration_id = $1::uuid)`,
    [integrationId],
  )
  await query(`DELETE FROM directory_deprovision_events WHERE integration_id = $1::uuid`, [integrationId])
  await query(`DELETE FROM directory_sync_runs WHERE integration_id = $1`, [integrationId])
  await query(
    `DELETE FROM directory_account_links WHERE directory_account_id IN (SELECT id FROM directory_accounts WHERE integration_id = $1)`,
    [integrationId],
  )
  await query(
    `DELETE FROM directory_account_departments WHERE directory_account_id IN (SELECT id FROM directory_accounts WHERE integration_id = $1)`,
    [integrationId],
  )
  await query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [integrationId])
  await query(`DELETE FROM directory_departments WHERE integration_id = $1`, [integrationId])
  await query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
}

export async function cleanupUsers(query: QueryFn, userIds: string[]): Promise<void> {
  const ids = Array.from(new Set(userIds.filter(Boolean)))
  if (ids.length === 0) return
  await query(`DELETE FROM directory_deprovision_events WHERE local_user_id = ANY($1::text[])`, [ids])
  await query(`DELETE FROM user_login_aliases WHERE user_id = ANY($1::text[])`, [ids])
  await query(`DELETE FROM user_invites WHERE user_id = ANY($1::text[])`, [ids])
  await query(`DELETE FROM user_external_auth_grants WHERE local_user_id = ANY($1::text[])`, [ids])
  await query(`DELETE FROM user_external_identities WHERE local_user_id = ANY($1::text[])`, [ids])
  await query(`DELETE FROM user_orgs WHERE user_id = ANY($1::text[])`, [ids])
  await query(`DELETE FROM users WHERE id = ANY($1::text[])`, [ids])
}

async function insertAccount(
  query: QueryFn,
  integrationId: string,
  key: ScenarioKey,
  name: string,
  displayName: string,
  withOpenId: boolean,
): Promise<string> {
  const names = scenarioNames(key)
  const result = await query(
    `INSERT INTO directory_accounts (
       integration_id, provider, corp_id, external_user_id, union_id, open_id, external_key,
       name, is_active, raw, last_seen_at, created_at, updated_at
     ) VALUES ($1, 'dingtalk', $2, $3, $4, $5, $4, $6, true, '{}'::jsonb, $7, NOW(), NOW())
     RETURNING id::text AS id`,
    [
      integrationId,
      names.corpId,
      `a0g-${name}`,
      unionIdOf(key, name),
      withOpenId ? openIdOf(key, name) : null,
      displayName,
      PRIOR_LAST_SEEN,
    ],
  )
  return result.rows[0].id
}

async function insertLink(
  query: QueryFn,
  accountId: string,
  localUser: string | null,
  linkStatus: string,
  matchStrategy: string,
): Promise<void> {
  await query(
    `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4, NOW(), NOW())`,
    [accountId, localUser, linkStatus, matchStrategy],
  )
}

/** Local users, shadow rows and link rows an apply, preview or failure scenario starts from. */
export async function seedPriorState(query: QueryFn, key: ScenarioKey, integrationId: string): Promise<void> {
  const names = scenarioNames(key)
  for (const [name, seed] of Object.entries(localUserSeeds(key))) {
    await query(
      `INSERT INTO users (id, email, name, password_hash, role, mobile, is_active)
       VALUES ($1, $2, $3, 'x', 'user', $4, $5)`,
      [localUserId(key, name), seed.email, seed.name, seed.mobile, seed.isActive],
    )
  }
  await query(
    `INSERT INTO user_external_identities (
       provider, external_key, provider_union_id, provider_open_id, corp_id, local_user_id, profile, bound_by, created_at, updated_at
     ) VALUES ('dingtalk', $1, $2, $3, $4, $5, '{}'::jsonb, 'a0g-seed', NOW(), NOW())`,
    [
      `${names.corpId}:${openIdOf(key, 'u9')}`,
      unionIdOf(key, 'u9'),
      openIdOf(key, 'u9'),
      names.corpId,
      localUserId(key, 'u9'),
    ],
  )

  await query(
    `INSERT INTO directory_departments (
       integration_id, provider, external_department_id, external_parent_department_id, name,
       full_path, order_index, is_active, raw, last_seen_at, created_at, updated_at
     ) VALUES
       ($1, 'dingtalk', 'dA1', 'dA', 'Dept A1', 'Dept A1', 1, true, $2::jsonb, $4, NOW(), NOW()),
       ($1, 'dingtalk', 'dOld', '1', 'Dept Old', 'Dept Old', 9, true, $3::jsonb, $4, NOW(), NOW())`,
    [integrationId, JSON.stringify({ dept_manager_userid_list: ['a0g-u3'] }), JSON.stringify({}), PRIOR_LAST_SEEN],
  )

  const u9 = await insertAccount(query, integrationId, key, 'u9', userName(9), true)
  const u10 = await insertAccount(query, integrationId, key, 'u10', userName(10), true)
  const u11 = await insertAccount(query, integrationId, key, 'u11', userName(11), true)
  const u12 = await insertAccount(query, integrationId, key, 'u12', userName(12), true)
  const old1 = await insertAccount(query, integrationId, key, 'old1', 'Old One', false)
  await insertLink(query, u9, null, 'unmatched', 'none')
  await insertLink(query, u10, localUserId(key, 'u10'), 'linked', 'manual_admin')
  await insertLink(query, u11, null, 'unmatched', DIRECTORY_ADMIN_UNBOUND_MATCH_STRATEGY)
  await insertLink(query, u12, localUserId(key, 'u12'), 'linked', 'manual_admin')
  await insertLink(query, old1, localUserId(key, 'old1'), 'linked', 'manual_admin')
}

// ---------------------------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------------------------

function byKey<T>(rows: T[], read: (row: T) => string): T[] {
  return [...rows].sort((left, right) => {
    const a = read(left)
    const b = read(right)
    return a < b ? -1 : a > b ? 1 : 0
  })
}

export interface CallSource {
  name: string
  fn: { mock: { calls: unknown[][]; invocationCallOrder: number[] } }
}

/** Provider client calls in invocation order, with credentials and the token value aliased. */
export function serializeCalls(sources: CallSource[]): Array<{ fn: string; args: unknown[] }> {
  const entries: Array<{ order: number; fn: string; args: unknown[] }> = []
  for (const source of sources) {
    source.fn.mock.calls.forEach((args, index) => {
      entries.push({ order: source.fn.mock.invocationCallOrder[index], fn: source.name, args })
    })
  }
  entries.sort((left, right) => left.order - right.order)
  return entries.map((entry) => ({
    fn: entry.fn,
    args: JSON.parse(
      JSON.stringify(entry.args, (_key, value) => {
        if (value === GOLDEN_TOKEN) return '<token>'
        if (value === GOLDEN_SECRET) return '<secret>'
        if (typeof value === 'string' && /^a0g-appkey-[a-f]$/.test(value)) return '<appKey>'
        return value
      }),
    ) as unknown[],
  }))
}

export interface ShadowSnapshot {
  departments: unknown[]
  accounts: unknown[]
  accountDepartments: unknown[]
  links: unknown[]
  userOrgs: unknown[]
  users: unknown[]
  identities: unknown[]
  grants: unknown[]
  accountAlias: (accountId: string | null | undefined) => string | null
}

/** Rows of one integration and of the local users it touches, with random ids aliased. */
export async function captureShadow(query: QueryFn, key: ScenarioKey, integrationId: string): Promise<ShadowSnapshot> {
  const departments = await query(
    `SELECT provider, external_department_id, external_parent_department_id, name, full_path, order_index, is_active, raw
       FROM directory_departments WHERE integration_id = $1`,
    [integrationId],
  )
  const accounts = await query(
    `SELECT id::text AS id, provider, corp_id, external_user_id, union_id, open_id, external_key, name, nick, email, mobile,
            job_number, title, avatar_url, is_active, raw
       FROM directory_accounts WHERE integration_id = $1`,
    [integrationId],
  )
  const accountExt = new Map<string, string>(accounts.rows.map((row) => [row.id as string, row.external_user_id as string]))
  const accountDepartments = await query(
    `SELECT a.external_user_id, d.external_department_id, ad.is_primary
       FROM directory_account_departments ad
       JOIN directory_accounts a ON a.id = ad.directory_account_id
       JOIN directory_departments d ON d.id = ad.directory_department_id
      WHERE a.integration_id = $1`,
    [integrationId],
  )
  const links = await query(
    `SELECT a.external_user_id, l.link_status, l.match_strategy, l.local_user_id
       FROM directory_account_links l
       JOIN directory_accounts a ON a.id = l.directory_account_id
      WHERE a.integration_id = $1`,
    [integrationId],
  )

  const extByLocalUser = new Map<string, string>()
  for (const row of links.rows) {
    if (row.local_user_id) extByLocalUser.set(row.local_user_id as string, row.external_user_id as string)
  }
  const aliasUser = (id: string | null | undefined): string | null => {
    if (id === null || id === undefined) return null
    if (id.startsWith('a0g-lu-')) return id
    return `user-${extByLocalUser.get(id) ?? 'unlinked'}`
  }
  const userIds = Array.from(new Set([...seededLocalUserIds(key), ...extByLocalUser.keys()]))

  const userOrgs = await query(
    `SELECT user_id, org_id, is_active FROM user_orgs WHERE user_id = ANY($1::text[])`,
    [userIds],
  )
  const users = await query(
    `SELECT id, email, name, mobile, username, role, is_active, is_admin, activation_status, must_change_password, local_password_set
       FROM users WHERE id = ANY($1::text[])`,
    [userIds],
  )
  const identities = await query(
    `SELECT provider, external_key, provider_union_id, provider_open_id, corp_id, local_user_id
       FROM user_external_identities WHERE local_user_id = ANY($1::text[])`,
    [userIds],
  )
  const grants = await query(
    `SELECT provider, local_user_id, enabled FROM user_external_auth_grants WHERE local_user_id = ANY($1::text[])`,
    [userIds],
  )

  const accountAliasOf = createAliaser('acct')
  return {
    departments: byKey(departments.rows, (row) => row.external_department_id),
    accounts: byKey(
      accounts.rows.map((row) => {
        const { id: _id, ...rest } = row
        return rest
      }),
      (row) => row.external_user_id,
    ),
    accountDepartments: byKey(
      accountDepartments.rows,
      (row) => `${row.external_user_id}|${row.external_department_id}`,
    ),
    links: byKey(
      links.rows.map((row) => ({ ...row, local_user_id: aliasUser(row.local_user_id) })),
      (row) => row.external_user_id,
    ),
    userOrgs: byKey(
      userOrgs.rows.map((row) => ({ ...row, user_id: aliasUser(row.user_id) })),
      (row) => row.user_id,
    ),
    users: byKey(
      users.rows.map((row) => ({
        ...row,
        id: aliasUser(row.id),
        username: typeof row.username === 'string' ? row.username.replace(/_[0-9a-f]{8}$/, '_<suffix>') : row.username,
      })),
      (row) => row.id,
    ),
    identities: byKey(
      identities.rows.map((row) => ({ ...row, local_user_id: aliasUser(row.local_user_id) })),
      (row) => `${row.local_user_id}|${row.provider}`,
    ),
    grants: byKey(
      grants.rows.map((row) => ({ ...row, local_user_id: aliasUser(row.local_user_id) })),
      (row) => `${row.local_user_id}|${row.provider}`,
    ),
    accountAlias: (accountId) => {
      if (accountId === null || accountId === undefined) return null
      const ext = accountExt.get(accountId)
      return accountAliasOf(accountId, ext ?? 'unknown')
    },
  }
}

export async function captureRunAndAlerts(query: QueryFn, integrationId: string) {
  const runs = await query(
    `SELECT status, error_message, trigger_source FROM directory_sync_runs WHERE integration_id = $1`,
    [integrationId],
  )
  const integration = await query(
    `SELECT last_error, (last_success_at IS NOT NULL) AS has_last_success FROM directory_integrations WHERE id = $1`,
    [integrationId],
  )
  const alerts = await query(
    `SELECT level, code, message, details FROM directory_sync_alerts WHERE integration_id = $1 ORDER BY created_at, id`,
    [integrationId],
  )
  return {
    runs: runs.rows,
    integration: integration.rows[0],
    alerts: alerts.rows,
  }
}
