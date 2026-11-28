/**
 * E1 钉钉容器内免登 — real-DB reverse tests (e1-container-login design-lock §4.4).
 *
 * Runs exchangeEnterpriseAuthCodeForUser against a real Postgres with the
 * DingTalk HTTP client mocked: policy gates one-by-one (unlinked / grant /
 * auto-provision / disabled user) plus the §2 identity-key golden — container
 * → web-OAuth → container logins must upgrade external_key/provider_open_id
 * exactly once (one-way enrichment, no flip-flop).
 */
import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { runtimeJwtSecret } from '../helpers/runtime-jwt-secret'

const clientMocks = vi.hoisted(() => ({
  exchangeCodeForUserAccessToken: vi.fn(),
  fetchDingTalkCurrentUser: vi.fn(),
  fetchDingTalkAppAccessToken: vi.fn(),
  getDingTalkUserDetail: vi.fn(),
  getDingTalkUserInfoByAuthCode: vi.fn(),
  isDingTalkConfigured: vi.fn(() => true),
  readDingTalkOauthConfig: vi.fn(),
}))

vi.mock('../../src/integrations/dingtalk/client', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  exchangeCodeForUserAccessToken: clientMocks.exchangeCodeForUserAccessToken,
  fetchDingTalkCurrentUser: clientMocks.fetchDingTalkCurrentUser,
  fetchDingTalkAppAccessToken: clientMocks.fetchDingTalkAppAccessToken,
  fetchDingTalkAppAccessTokenFresh: clientMocks.fetchDingTalkAppAccessToken,
  getDingTalkUserDetail: clientMocks.getDingTalkUserDetail,
  getDingTalkUserInfoByAuthCode: clientMocks.getDingTalkUserInfoByAuthCode,
  isDingTalkConfigured: clientMocks.isDingTalkConfigured,
  readDingTalkOauthConfig: clientMocks.readDingTalkOauthConfig,
}))

import { pool } from '../../src/db/pg'
import { exchangeCodeForUser, exchangeEnterpriseAuthCodeForUser } from '../../src/auth/dingtalk-oauth'

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip
if (process.env.EXPECT_DB === '1')
  it('DB lane must not skip', () =>
    expect(process.env.DATABASE_URL).toBeTruthy())
const q = (sql: string, params?: unknown[]) => pool.query(sql, params)

const RUN = `e1c_${Date.now()}`

// #4658 makes login identifiers a GLOBAL unique namespace (user_login_aliases), so the suite's
// old shared literal mobile ('13800000000' on every profile) now correctly refuses the second
// provisioning — two different people cannot hold the same mobile alias. Same person must keep
// the same mobile across container/web hops, different people must differ: derive it from the
// unionId deterministically.
function mobileFor(unionId: string): string {
  let h = 0
  for (const ch of unionId) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return `13${String(h % 900000000 + 100000000)}`
}
const CORP = `corp_${RUN}`
const USER_LINKED = `user_${RUN}_linked`
const USER_DISABLED = `user_${RUN}_disabled`
const UNION_LINKED = `union_${RUN}_linked`
const UNION_DISABLED = `union_${RUN}_disabled`
const UNION_UNLINKED = `union_${RUN}_unlinked`
const UNION_PROVISION = `union_${RUN}_prov`
const UNION_GOLDEN = `union_${RUN}_golden`
const USER_GOLDEN = `user_${RUN}_golden`

function primeContainerChain(unionId: string, userId = `emp_${unionId}`, options: { email?: string | undefined; omitEmail?: boolean } = {}) {
  clientMocks.fetchDingTalkAppAccessToken.mockResolvedValue('app-token')
  clientMocks.getDingTalkUserInfoByAuthCode.mockResolvedValue({ userId, unionId: undefined, source: {} })
  clientMocks.getDingTalkUserDetail.mockResolvedValue({
    userId,
    name: `Name ${unionId}`,
    unionId,
    email: options.omitEmail ? undefined : (options.email ?? `${unionId}@example.com`),
    mobile: mobileFor(unionId),
    avatarUrl: '',
    departmentIds: [],
    source: {},
  })
}

describeIfDb('E1 — dingtalk container login (real DB)', () => {
  beforeAll(async () => {
    clientMocks.readDingTalkOauthConfig.mockReturnValue({
      clientId: 'e1-client',
      clientSecret: 'e1-secret',
      redirectUri: 'https://app.example.com/login/dingtalk/callback',
      corpId: CORP,
    })
    await q(
      `INSERT INTO users (id, email, name, password_hash, role)
       VALUES ($1, $2, $3, 'x', 'user'), ($4, $5, $6, 'x', 'user'), ($7, $8, $9, 'x', 'user')
       ON CONFLICT (id) DO NOTHING`,
      [
        USER_LINKED, `${USER_LINKED}@example.com`, 'Linked',
        USER_DISABLED, `${USER_DISABLED}@example.com`, 'Disabled',
        USER_GOLDEN, `${USER_GOLDEN}@example.com`, 'Golden',
      ],
    )
    await q(`UPDATE users SET is_active = FALSE WHERE id = $1`, [USER_DISABLED])
    await q(
      `INSERT INTO user_external_identities (provider, external_key, provider_union_id, corp_id, local_user_id, profile, last_login_at, created_at, updated_at)
       VALUES ('dingtalk', $1, $2, $3, $4, '{}'::jsonb, NOW(), NOW(), NOW()),
              ('dingtalk', $5, $6, $3, $7, '{}'::jsonb, NOW(), NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [`${CORP}:${UNION_LINKED}`, UNION_LINKED, CORP, USER_LINKED, `${CORP}:${UNION_DISABLED}`, UNION_DISABLED, USER_DISABLED],
    )
  })

  afterAll(async () => {
    await q(`DELETE FROM user_external_auth_grants WHERE local_user_id LIKE $1`, [`user_${RUN}%`]).catch(() => {})
    await q(`DELETE FROM user_external_identities WHERE provider_union_id LIKE $1 OR local_user_id LIKE $2`, [`union_${RUN}%`, `user_${RUN}%`]).catch(() => {})
    await q(`DELETE FROM users WHERE id LIKE $1 OR email LIKE $2`, [`user_${RUN}%`, `union_${RUN}%@example.com`]).catch(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('sentinel: DATABASE_URL is set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('gate: unlinked identity without auto-provision is refused', async () => {
    primeContainerChain(UNION_UNLINKED)
    await expect(exchangeEnterpriseAuthCodeForUser('code-unlinked')).rejects.toMatchObject({
      name: 'DingTalkLoginPolicyError',
      statusCode: 403,
    })
  })

  it('gate: require-grant refuses a linked identity without an enabled grant', async () => {
    vi.stubEnv('DINGTALK_AUTH_REQUIRE_GRANT', '1')
    primeContainerChain(UNION_LINKED)
    await expect(exchangeEnterpriseAuthCodeForUser('code-nogruniversal')).rejects.toMatchObject({
      name: 'DingTalkLoginPolicyError',
      statusCode: 403,
      code: 'grant_required',
    })
  })

  it('gate: require-grant admits the linked identity once the grant is enabled', async () => {
    vi.stubEnv('DINGTALK_AUTH_REQUIRE_GRANT', '1')
    await q(
      `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, created_at, updated_at)
       VALUES ('dingtalk', $1, TRUE, NOW(), NOW())
       ON CONFLICT (provider, local_user_id) DO UPDATE SET enabled = TRUE`,
      [USER_LINKED],
    )
    primeContainerChain(UNION_LINKED)
    const result = await exchangeEnterpriseAuthCodeForUser('code-granted')
    expect(result.localUserId).toBe(USER_LINKED)
    expect(result.isNewUser).toBe(false)
  })

  it('gate: a disabled local user is refused even when linked', async () => {
    primeContainerChain(UNION_DISABLED)
    await expect(exchangeEnterpriseAuthCodeForUser('code-disabled')).rejects.toMatchObject({
      name: 'DingTalkLoginPolicyError',
      statusCode: 403,
      code: 'local_user_disabled',
    })
  })

  it('gate: auto-provision creates a local user and a union-keyed identity (no fake openId)', async () => {
    vi.stubEnv('DINGTALK_AUTH_AUTO_PROVISION', '1')
    // Auto-provision requires a non-empty corp allowlist (DT-HARDEN-09).
    vi.stubEnv('DINGTALK_ALLOWED_CORP_IDS', CORP)
    primeContainerChain(UNION_PROVISION)
    const result = await exchangeEnterpriseAuthCodeForUser('code-provision')
    expect(result.isNewUser).toBe(true)

    const identity = await q(
      `SELECT external_key, provider_open_id, provider_union_id, corp_id
       FROM user_external_identities WHERE provider = 'dingtalk' AND provider_union_id = $1`,
      [UNION_PROVISION],
    )
    expect(identity.rows).toHaveLength(1)
    expect(identity.rows[0].external_key).toBe(`${CORP}:${UNION_PROVISION}`)
    expect(identity.rows[0].provider_open_id).toBeNull()
    expect(identity.rows[0].corp_id).toBe(CORP)
  })

  it('golden (§2): container → web → container logins upgrade the identity key exactly once', async () => {
    vi.stubEnv('DINGTALK_AUTH_AUTO_PROVISION', '1')
    // Auto-provision requires a non-empty corp allowlist (DT-HARDEN-09).
    vi.stubEnv('DINGTALK_ALLOWED_CORP_IDS', CORP)

    // 1) container first: identity lands union-keyed, no openId
    primeContainerChain(UNION_GOLDEN)
    const first = await exchangeEnterpriseAuthCodeForUser('code-golden-1')
    const after1 = await q(
      `SELECT external_key, provider_open_id FROM user_external_identities WHERE provider = 'dingtalk' AND provider_union_id = $1`,
      [UNION_GOLDEN],
    )
    expect(after1.rows).toHaveLength(1)
    expect(after1.rows[0].external_key).toBe(`${CORP}:${UNION_GOLDEN}`)
    expect(after1.rows[0].provider_open_id).toBeNull()

    // 2) web-OAuth for the same person: one-way upgrade to the sns openId key
    const OPEN_ID = `open_${RUN}_golden`
    clientMocks.exchangeCodeForUserAccessToken.mockResolvedValue({ accessToken: 'user-token' })
    clientMocks.fetchDingTalkCurrentUser.mockResolvedValue({
      openId: OPEN_ID,
      unionId: UNION_GOLDEN,
      nick: 'Golden',
      email: `${UNION_GOLDEN}@example.com`,
      mobile: mobileFor(UNION_GOLDEN),
      avatarUrl: '',
    })
    const second = await exchangeCodeForUser('web-code-golden')
    expect(second.localUserId).toBe(first.localUserId)
    const after2 = await q(
      `SELECT external_key, provider_open_id FROM user_external_identities WHERE provider = 'dingtalk' AND provider_union_id = $1`,
      [UNION_GOLDEN],
    )
    expect(after2.rows).toHaveLength(1)
    expect(after2.rows[0].external_key).toBe(`${CORP}:${OPEN_ID}`)
    expect(after2.rows[0].provider_open_id).toBe(OPEN_ID)

    // 3) container again: MUST NOT clobber the upgraded key (no flip-flop)
    primeContainerChain(UNION_GOLDEN)
    const third = await exchangeEnterpriseAuthCodeForUser('code-golden-2')
    expect(third.localUserId).toBe(first.localUserId)
    const after3 = await q(
      `SELECT external_key, provider_open_id FROM user_external_identities WHERE provider = 'dingtalk' AND provider_union_id = $1`,
      [UNION_GOLDEN],
    )
    expect(after3.rows).toHaveLength(1)
    expect(after3.rows[0].external_key).toBe(`${CORP}:${OPEN_ID}`)
    expect(after3.rows[0].provider_open_id).toBe(OPEN_ID)
  })

  it('P2-1 (#3771): two emailless container users provision with distinct placeholder emails', async () => {
    vi.stubEnv('DINGTALK_AUTH_AUTO_PROVISION', '1')
    // Auto-provision requires a non-empty corp allowlist (DT-HARDEN-09).
    vi.stubEnv('DINGTALK_ALLOWED_CORP_IDS', CORP)
    const UNION_A = `union_${RUN}_noeml_a`
    const UNION_B = `union_${RUN}_noeml_b`

    primeContainerChain(UNION_A, undefined, { omitEmail: true })
    const first = await exchangeEnterpriseAuthCodeForUser('code-noemail-a')
    expect(first.isNewUser).toBe(true)

    primeContainerChain(UNION_B, undefined, { omitEmail: true })
    const second = await exchangeEnterpriseAuthCodeForUser('code-noemail-b')
    expect(second.isNewUser).toBe(true)
    expect(second.localUserId).not.toBe(first.localUserId)

    const emails = await q(
      `SELECT email FROM users WHERE id = ANY($1::text[]) ORDER BY email`,
      [[first.localUserId, second.localUserId]],
    )
    expect(emails.rows).toHaveLength(2)
    expect(emails.rows[0].email).toContain(UNION_A.toLowerCase())
    expect(emails.rows[1].email).toContain(UNION_B.toLowerCase())
  })
})

describeIfDb('DingTalk sign-in admission', () => {
  let app: express.Express
  let userId: string, email: string, corpId: string, appKey: string, connectionId: string, unionId: string, openId: string
  let profileReady: () => Promise<void>
  const transportCalls = () => [clientMocks.exchangeCodeForUserAccessToken, clientMocks.fetchDingTalkCurrentUser,
    clientMocks.fetchDingTalkAppAccessToken, clientMocks.getDingTalkUserInfoByAuthCode, clientMocks.getDingTalkUserDetail]
    .reduce((count, mock) => count + mock.mock.calls.length, 0)

  async function connection(status = 'active', key = appKey, org = 'default', corp = corpId): Promise<string> {
    const id = randomUUID()
    await q(`INSERT INTO directory_integrations(id,name,provider,org_id,corp_id,status,config)
      VALUES($1,$2,'dingtalk',$3,$4,$5,$6)`, [id, `Sign-in fixture ${id}`, org, corp, status, { appKey: key }])
    return id
  }

  async function snapshot() {
    const result: Record<string, unknown> = {}
    for (const [table, column] of [
      ['users', 'id'], ['user_external_identities', 'local_user_id'], ['user_external_auth_grants', 'local_user_id'],
      ['user_sessions', 'user_id'], ['user_login_aliases', 'user_id'], ['user_orgs', 'user_id'],
      ['user_session_revocations', 'user_id'], ['subject_authorization_versions', 'subject_id'], ['multitable_api_tokens', 'created_by'],
    ]) {
      result[table] = (await q(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${column} IN
        (SELECT id FROM users WHERE id=$1 OR email=$2) ORDER BY to_jsonb(t)::text`, [userId, email])).rows
    }
    result.accounts = (await q('SELECT to_jsonb(t) AS row FROM directory_accounts t WHERE integration_id=$1 ORDER BY id', [connectionId])).rows
    result.links = (await q('SELECT to_jsonb(t) AS row FROM directory_account_links t WHERE local_user_id=$1 ORDER BY directory_account_id', [userId])).rows
    return result
  }

  async function signIn(entry: 'web' | 'container', selector: Record<string, string> = {}) {
    if (entry === 'container') return request(app).post('/api/auth/login/dingtalk/container').send({ authCode: 'synthetic', ...selector })
    const { generateState } = await import('../../src/auth/dingtalk-oauth')
    return request(app).post('/api/auth/dingtalk/callback').send({ code: 'synthetic', state: await generateState(), ...selector })
  }

  function denied(response: request.Response) {
    expect(response.status, JSON.stringify(response.body)).toBe(403)
    expect(response.body).toEqual({ success: false, error: 'DingTalk login is not eligible for this source', code: 'strict_connection' })
    expect(response.body.data?.token).toBeUndefined()
  }

  beforeAll(async () => {
    const { authRouter } = await import('../../src/routes/auth')
    app = express().use(express.json()).use('/api/auth', authRouter)
  })

  beforeEach(async () => {
    const id = randomUUID()
    userId = `admission-${id}`; email = `${userId}@example.invalid`
    corpId = `corp-${id}`; appKey = `app-${id}`; unionId = `union-${id}`; openId = `open-${id}`
    profileReady = async () => {}
    vi.clearAllMocks()
    vi.stubGlobal('fetch', async () => { throw new Error('Unexpected provider operation') })
    for (const [key, value] of Object.entries({
      DINGTALK_CLIENT_ID: appKey, DINGTALK_CLIENT_SECRET: 'synthetic', DINGTALK_CORP_ID: corpId,
      DINGTALK_REDIRECT_URI: 'https://example.invalid/callback', DINGTALK_CONTAINER_LOGIN_ENABLED: 'true',
      DINGTALK_OAUTH_REQUIRE_SHARED_STATE_STORE: 'false', DINGTALK_ALLOWED_CORP_IDS: corpId,
      DINGTALK_AUTH_REQUIRE_GRANT: '0', DINGTALK_AUTH_AUTO_PROVISION: '0', DINGTALK_AUTH_AUTO_LINK_EMAIL: '0',
      AUTH_LOGIN_MAX_ATTEMPTS: '10000',
    })) vi.stubEnv(key, value)
    clientMocks.readDingTalkOauthConfig.mockImplementation(() => ({ clientId: appKey, clientSecret: 'synthetic', corpId, redirectUri: 'https://example.invalid/callback' }))
    clientMocks.exchangeCodeForUserAccessToken.mockResolvedValue({ accessToken: 'synthetic' })
    clientMocks.fetchDingTalkCurrentUser.mockImplementation(async () => {
      await profileReady()
      return { openId, unionId, nick: 'Fixture', email }
    })
    primeContainerChain(unionId, `employee-${id}`, { email })
    clientMocks.getDingTalkUserDetail.mockImplementation(async () => {
      await profileReady()
      return { userId: `employee-${id}`, unionId, name: 'Fixture', email, departmentIds: [], source: {} }
    })
    await q(`INSERT INTO users(id,email,password_hash,role,is_active,activation_status)
      VALUES($1,$2,'x','user',true,'activated')`, [userId, email])
    await q(`INSERT INTO user_external_identities(provider,external_key,provider_union_id,provider_open_id,corp_id,local_user_id,profile)
      VALUES('dingtalk',$1,$2,$3,$4,$5,'{}')`, [`${corpId}:${openId}`, unionId, openId, corpId, userId])
    connectionId = await connection()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    try {
      const subjects = (await q('SELECT id FROM users WHERE id=$1 OR email=$2', [userId, email])).rows.map(row => row.id)
      await q('DELETE FROM multitable_api_tokens WHERE created_by=$1', [userId])
      await q('DELETE FROM directory_account_links WHERE local_user_id=$1', [userId])
      await q('DELETE FROM users WHERE id=$1 OR email=$2', [userId, email])
      await q('DELETE FROM subject_authorization_versions WHERE subject_id=ANY($1::text[])', [[userId, ...subjects]])
      await q('DELETE FROM directory_integrations WHERE corp_id=$1', [corpId])
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs() }
  })

  for (const entry of ['web', 'container'] as const) {
    it.each(['implicit', 'id', 'corp', 'both'] as const)(`${entry} checks source eligibility (%s)`, async selector => {
      await q("UPDATE directory_integrations SET status='paused' WHERE id=$1", [connectionId])
      const before = await snapshot()
      const selected = { ...(['id', 'both'].includes(selector) ? { connectionId } : {}), ...(['corp', 'both'].includes(selector) ? { corpId } : {}) }
      denied(await signIn(entry, selected))
      expect(await snapshot()).toEqual(before)
      expect(transportCalls()).toBe(0)
    })

    it(`${entry} checks eligibility without a configured corporation`, async () => {
      vi.stubEnv('DINGTALK_CORP_ID', '')
      clientMocks.readDingTalkOauthConfig.mockReturnValue({ clientId: appKey, clientSecret: 'synthetic', corpId: null, redirectUri: 'https://example.invalid/callback' })
      await q("UPDATE directory_integrations SET status='paused' WHERE id=$1", [connectionId])
      const before = await snapshot()
      denied(await signIn(entry))
      expect(await snapshot()).toEqual(before)
      expect(transportCalls()).toBe(0)
    })

    it(`${entry} preserves configured identity selection (application)`, async () => {
      const foreign = await connection('paused', `other-${appKey}`)
      try {
        const response = await signIn(entry)
        expect(response.status, JSON.stringify(response.body)).toBe(200)
        expect(response.body.data.token).toBeTypeOf('string')
      } finally { await q('DELETE FROM directory_integrations WHERE id=$1', [foreign]) }
    })

    it.each(['inactive', 'disabled', 'deactivated', 'Active', ''])(`${entry} requires an active source (%s)`, async status => {
      await q('UPDATE directory_integrations SET status=$1 WHERE id=$2', [status, connectionId])
      const before = await snapshot()
      denied(await signIn(entry))
      expect(await snapshot()).toEqual(before)
      expect(transportCalls()).toBe(0)
    })

    it(`${entry} requires source organization fields`, async () => {
      await q("UPDATE directory_integrations SET org_id='' WHERE id=$1", [connectionId])
      const before = await snapshot()
      denied(await signIn(entry))
      expect(await snapshot()).toEqual(before)
      expect(transportCalls()).toBe(0)
    })

    it.each(['active', 'unconfigured', 'separate-app'] as const)(`${entry} admits eligible identities (%s)`, async shape => {
      if (shape === 'unconfigured') await q('DELETE FROM directory_integrations WHERE id=$1', [connectionId])
      if (shape === 'separate-app') await connection('paused', `other-${appKey}`)
      const response = await signIn(entry)
      expect(response.status, JSON.stringify(response.body)).toBe(200)
      const claims = jwt.verify(response.body.data.token, runtimeJwtSecret()) as jwt.JwtPayload
      expect(claims.userId).toBe(userId)
      expect((await q('SELECT id FROM user_sessions WHERE id=$1 AND user_id=$2', [claims.sid, userId])).rowCount).toBe(1)
      expect(transportCalls()).toBeGreaterThan(0)
    })

    it.each(['enabled', 'disabled', 'absent', 'openid', 'email', 'provision', 'admin'] as const)(`${entry} preserves business state on admission refusal (%s)`, async shape => {
      if (['enabled', 'disabled', 'admin'].includes(shape)) await q(
        "INSERT INTO user_external_auth_grants(provider,local_user_id,enabled) VALUES('dingtalk',$1,$2)", [userId, shape !== 'disabled'])
      if (shape === 'admin') {
        await q("UPDATE users SET role='admin' WHERE id=$1", [userId])
        await q("INSERT INTO user_roles(user_id,role_id) VALUES($1,'admin')", [userId])
      }
      vi.stubEnv('DINGTALK_AUTH_REQUIRE_GRANT', ['enabled', 'absent', 'openid', 'admin'].includes(shape) ? '1' : '0')
      if (shape === 'openid') {
        await q('UPDATE user_external_identities SET provider_open_id=NULL,external_key=$1 WHERE local_user_id=$2', [`${corpId}:${unionId}`, userId])
        const account = (await q(`INSERT INTO directory_accounts(integration_id,provider,corp_id,external_user_id,external_key,name,is_active,union_id)
          VALUES($1,'dingtalk',$2,$3,$3,'Fixture',true,$4) RETURNING id`, [connectionId, corpId, `employee-${userId}`, unionId])).rows[0].id
        await q("INSERT INTO directory_account_links(directory_account_id,local_user_id,link_status) VALUES($1,$2,'linked')", [account, userId])
      }
      if (shape === 'email' || shape === 'provision') {
        await q('DELETE FROM user_external_identities WHERE local_user_id=$1', [userId])
        vi.stubEnv('DINGTALK_AUTH_AUTO_LINK_EMAIL', shape === 'email' ? '1' : '0')
        vi.stubEnv('DINGTALK_AUTH_AUTO_PROVISION', shape === 'provision' ? '1' : '0')
        if (shape === 'provision') await q('DELETE FROM users WHERE id=$1', [userId])
      }
      await q("UPDATE directory_integrations SET status='paused' WHERE id=$1", [connectionId])
      const before = await snapshot()
      denied(await signIn(entry))
      expect(await snapshot()).toEqual(before)
      expect(transportCalls()).toBe(0)
    })

    it.each(['identity', 'email', 'provision'] as const)(`${entry} checks current source state before identity writes (%s)`, async shape => {
      if (shape !== 'identity') {
        await q('DELETE FROM user_external_identities WHERE local_user_id=$1', [userId])
        vi.stubEnv('DINGTALK_AUTH_AUTO_LINK_EMAIL', shape === 'email' ? '1' : '0')
        vi.stubEnv('DINGTALK_AUTH_AUTO_PROVISION', shape === 'provision' ? '1' : '0')
        if (shape === 'provision') await q('DELETE FROM users WHERE id=$1', [userId])
      }
      const before = await snapshot()
      profileReady = async () => { await q("UPDATE directory_integrations SET status='paused' WHERE id=$1", [connectionId]) }
      denied(await signIn(entry))
      expect(transportCalls()).toBeGreaterThan(0)
      expect(await snapshot()).toEqual(before)
    })

    it(`${entry} requires current eligibility for session registration`, async () => {
      const manager = poolManager.get()
      const transact = manager.transaction.bind(manager)
      let changed = 0
      const hook = vi.spyOn(manager, 'transaction').mockImplementation(async work => {
        const result = await transact(work)
        if (result && typeof result === 'object' && 'sessionGeneration' in result) {
          await q("UPDATE directory_integrations SET status='paused' WHERE id=$1", [connectionId])
          changed++
        }
        return result
      })
      try {
        denied(await signIn(entry))
        expect(changed).toBe(1)
        expect(transportCalls()).toBeGreaterThan(0)
        expect((await q('SELECT id FROM user_sessions WHERE user_id=$1', [userId])).rows).toEqual([])
      } finally { hook.mockRestore() }
    })

    it(`${entry} checks session eligibility with captured configuration`, async () => {
      await q('DELETE FROM directory_integrations WHERE id=$1', [connectionId])
      profileReady = async () => {
        await connection('paused')
        vi.stubEnv('DINGTALK_CLIENT_ID', `changed-${appKey}`)
        vi.stubEnv('DINGTALK_CORP_ID', `changed-${corpId}`)
      }
      denied(await signIn(entry))
      expect(transportCalls()).toBeGreaterThan(0)
      expect((await q('SELECT id FROM user_sessions WHERE user_id=$1', [userId])).rows).toEqual([])
    })
  }

  it.each(['web', 'container'] as const)('checks source eligibility for the %s exchange', async entry => {
    await q("UPDATE directory_integrations SET status='paused' WHERE id=$1", [connectionId])
    const before = await snapshot()
    const exchange = entry === 'web' ? exchangeCodeForUser : exchangeEnterpriseAuthCodeForUser
    await expect(exchange('synthetic')).rejects.toMatchObject({ statusCode: 403, code: 'strict_connection' })
    expect(transportCalls()).toBe(0)
    expect(await snapshot()).toEqual(before)
  })

  it('preserves established session state on admission refusal', async () => {
    expect((await signIn('web')).status).toBe(200)
    await q(`INSERT INTO multitable_api_tokens(id,name,token_hash,token_prefix,created_by) VALUES($1,'Fixture',$2,'fixture',$3)`, [randomUUID(), randomUUID(), userId])
    await q("UPDATE directory_integrations SET status='paused' WHERE id=$1", [connectionId])
    const before = await snapshot()
    denied(await signIn('web'))
    expect(await snapshot()).toEqual(before)
  })

  it('keeps the container availability response', async () => {
    vi.stubEnv('DINGTALK_CONTAINER_LOGIN_ENABLED', 'false')
    await q("UPDATE directory_integrations SET status='paused' WHERE id=$1", [connectionId])
    const response = await signIn('container')
    expect(response.status).toBe(404)
    expect(response.body.code).toBe('container_login_disabled')
    expect(transportCalls()).toBe(0)
  })

  it.each(['commit', 'rollback', 'login-first'] as const)('serializes connection state with sign-in (%s)', async order => {
    const writer = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await writer.connect()
    await writer.query("SET statement_timeout='10s'")
    const writerPid = Number((await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    const manager = poolManager.get()
    const transact = manager.transaction.bind(manager)
    let release!: () => void, ready!: (pid: number) => void
    const held = new Promise<void>(resolve => { release = resolve })
    const acquired = new Promise<number>(resolve => { ready = resolve })
    const loginPids = new Set<number>()
    let armed = true
    const hook = vi.spyOn(manager, 'transaction').mockImplementation(work => transact(async client => {
      const pid = Number(Reflect.get(client.__rawClient, 'processID'))
      expect(Number.isInteger(pid) && pid > 0).toBe(true)
      loginPids.add(pid)
      const result = await work(client).finally(() => { loginPids.delete(pid) })
      if (armed && result && typeof result === 'object' && 'sid' in result) {
        armed = false
        ready(pid)
        await held
      }
      return result
    }))
    let pending: Promise<request.Response> | undefined
    let writing: Promise<pg.QueryResult> | undefined
    const waitForBlock = async (blocked: number | null, holder: number, completed = () => false) => {
      const deadline = Date.now() + 8000
      while (Date.now() < deadline) {
        const found = await q(`SELECT pid FROM pg_stat_activity WHERE (pid=$1 OR ($1::int IS NULL AND pid=ANY($3::int[])))
          AND $2::int=ANY(pg_blocking_pids(pid))`, [blocked, holder, [...loginPids]])
        if (found.rows.length) return Number(found.rows[0].pid)
        if (completed()) return null
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      throw new Error('Expected source lock was not observed')
    }
    try {
      if (order === 'login-first') {
        pending = signIn('web')
        const loginPid = await Promise.race([acquired, pending.then(() => { throw new Error('Expected transaction checkpoint') })])
        await writer.query('BEGIN')
        let writeFinished = false
        writing = writer.query("UPDATE directory_integrations SET status='paused' WHERE id=$1", [connectionId]).then(result => { writeFinished = true; return result })
        expect(await waitForBlock(writerPid, loginPid, () => writeFinished)).toBe(writerPid)
        release()
        expect((await pending).status).toBe(200)
        await writing
        await writer.query('COMMIT')
        denied(await signIn('web'))
      } else {
        const before = await snapshot()
        profileReady = async () => {
          await writer.query('BEGIN')
          await writer.query("UPDATE directory_integrations SET status='paused' WHERE id=$1", [connectionId])
        }
        pending = signIn('web')
        await waitForBlock(null, writerPid)
        await writer.query(order === 'commit' ? 'COMMIT' : 'ROLLBACK')
        release()
        const response = await pending
        if (order === 'commit') { denied(response); expect(await snapshot()).toEqual(before) }
        else expect(response.status, JSON.stringify(response.body)).toBe(200)
      }
    } finally {
      release()
      try {
        await writer.query('ROLLBACK')
        await writing
        await pending
      } finally { hook.mockRestore(); await writer.end() }
    }
  }, 30000)
})
