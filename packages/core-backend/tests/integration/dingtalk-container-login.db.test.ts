/**
 * E1 钉钉容器内免登 — real-DB reverse tests (e1-container-login design-lock §4.4).
 *
 * Runs exchangeEnterpriseAuthCodeForUser against a real Postgres with the
 * DingTalk HTTP client mocked: policy gates one-by-one (unlinked / grant /
 * auto-provision / disabled user) plus the §2 identity-key golden — container
 * → web-OAuth → container logins must upgrade external_key/provider_open_id
 * exactly once (one-way enrichment, no flip-flop).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const clientMocks = vi.hoisted(() => ({
  exchangeCodeForUserAccessToken: vi.fn(),
  fetchDingTalkCurrentUser: vi.fn(),
  fetchDingTalkAppAccessToken: vi.fn(),
  getDingTalkUserDetail: vi.fn(),
  getDingTalkUserInfoByAuthCode: vi.fn(),
  isDingTalkConfigured: vi.fn(() => true),
  readDingTalkOauthConfig: vi.fn(),
}))

vi.mock('../../src/integrations/dingtalk/client', () => ({
  exchangeCodeForUserAccessToken: clientMocks.exchangeCodeForUserAccessToken,
  fetchDingTalkCurrentUser: clientMocks.fetchDingTalkCurrentUser,
  fetchDingTalkAppAccessToken: clientMocks.fetchDingTalkAppAccessToken,
  getDingTalkUserDetail: clientMocks.getDingTalkUserDetail,
  getDingTalkUserInfoByAuthCode: clientMocks.getDingTalkUserInfoByAuthCode,
  isDingTalkConfigured: clientMocks.isDingTalkConfigured,
  readDingTalkOauthConfig: clientMocks.readDingTalkOauthConfig,
}))

import { pool } from '../../src/db/pg'
import { exchangeCodeForUser, exchangeEnterpriseAuthCodeForUser } from '../../src/auth/dingtalk-oauth'

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => pool.query(sql, params)

const RUN = `e1c_${Date.now()}`
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
    mobile: '13800000000',
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
      mobile: '13800000000',
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
