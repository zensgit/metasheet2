/** Real PostgreSQL identity/authorization boundaries; DingTalk transport is synthetic. */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clientMocks = vi.hoisted(() => ({
  exchangeCodeForUserAccessToken: vi.fn(), fetchDingTalkCurrentUser: vi.fn(),
  fetchDingTalkAppAccessToken: vi.fn(), getDingTalkUserDetail: vi.fn(),
  getDingTalkUserInfoByAuthCode: vi.fn(), readDingTalkOauthConfig: vi.fn(),
}))
vi.mock('../../src/integrations/dingtalk/client', () => clientMocks)
import { query } from '../../src/db/pg'
import { bindDingTalkIdentityToUser, exchangeCodeForUser, exchangeEnterpriseAuthCodeForUser } from '../../src/auth/dingtalk-oauth'

if (!process.env.DATABASE_URL) throw new Error('DingTalk identity boundary gate requires DATABASE_URL')
const RUN = `dt-boundary-${randomUUID()}`
const CORP = `${RUN}-corp`
const users: string[] = []
const integrations: string[] = []
const q = (sql: string, params?: unknown[]) => query(sql, params)

async function seed(options: { identity?: boolean; grant?: boolean; corp?: string } = {}) {
  const id = `${RUN}-${users.length}`
  const email = `${id}@example.test`
  users.push(id)
  await q(`INSERT INTO users (id, email, name, password_hash, role, is_admin, is_active, activation_status)
           VALUES ($1, $2, 'Synthetic boundary user', 'unused', 'user', FALSE, TRUE, 'activated')`, [id, email])
  if (options.identity) await q(
    `INSERT INTO user_external_identities (provider, local_user_id, corp_id, external_key, provider_union_id, provider_open_id, profile)
     VALUES ('dingtalk', $1, $2, $3, $4, $5, '{}'::jsonb)`,
    [id, options.corp ?? CORP, `${options.corp ?? CORP}:${id}-open-A`, `${id}-union-A`, `${id}-open-A`],
  )
  if (options.grant !== undefined) await q(
    `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, granted_by)
     VALUES ('dingtalk', $1, $2, $1)`, [id, options.grant],
  )
  return { id, email }
}

function profile(id: string, email?: string) {
  return { openId: `${id}-open-B`, unionId: `${id}-union-B`, nick: 'Synthetic B', email }
}
function selfBind(id: string) {
  return bindDingTalkIdentityToUser({ localUserId: id, boundBy: id, enableGrant: true, dtUser: profile(id) })
}
function oauth(id: string, email: string) {
  clientMocks.fetchDingTalkCurrentUser.mockResolvedValue(profile(id, email))
  return exchangeCodeForUser('synthetic-code')
}
async function state(id: string) {
  return {
    user: (await q('SELECT role, is_admin, is_active, activation_status, access_generation::text AS access_generation FROM users WHERE id=$1', [id])).rows,
    identity: (await q(`SELECT corp_id, provider_union_id, provider_open_id FROM user_external_identities
                       WHERE provider='dingtalk' AND local_user_id=$1`, [id])).rows,
    grant: (await q(`SELECT enabled, granted_by FROM user_external_auth_grants
                    WHERE provider='dingtalk' AND local_user_id=$1`, [id])).rows,
    links: (await q(`SELECT directory_account_id, link_status FROM directory_account_links
                    WHERE local_user_id=$1 ORDER BY directory_account_id`, [id])).rows,
  }
}
async function directorySource(id: string, provider: 'dingtalk' | 'wecom' = 'dingtalk') {
  const integration = (await q(`INSERT INTO directory_integrations
    (name, provider, corp_id, org_id, status, default_deprovision_policy)
    VALUES ($1, $2, $3, $4, 'active', 'manual_review') RETURNING id`,
  [`${id}-integration`, provider, CORP, `${RUN}-org`])).rows[0].id as string
  integrations.push(integration)
  return (await q(`INSERT INTO directory_accounts
    (integration_id, provider, corp_id, external_user_id, external_key, union_id, open_id, name, is_active)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'Synthetic A', TRUE) RETURNING id`,
  [integration, provider, CORP, `${id}-employee-A`, `${id}-directory-key`, `${id}-union-A`, `${id}-open-A`])).rows[0].id as string
}

/** The writer owns the canonical users mutex. Prove the real operation waits on its PID,
 * commit the change, then inspect the operation's decision and the persisted rows. */
async function committedRace(id: string, write: (holder: pg.Client) => Promise<unknown>, operation: () => Promise<unknown>) {
  const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await holder.connect()
  let pending: Promise<{ error: unknown; value?: unknown }> | undefined
  try {
    await holder.query('BEGIN')
    await holder.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [id])
    const pid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    let settled = false
    pending = operation().then(value => ({ error: null, value }), error => ({ error }))
    void pending.then(() => { settled = true })
    let waiting: Array<{ query: string }> = []
    for (let attempt = 0; attempt < 100 && waiting.length === 0 && !settled; attempt++) {
      await holder.query('SELECT pg_stat_clear_snapshot()')
      waiting = (await holder.query(`SELECT query FROM pg_stat_activity
        WHERE pid <> $1 AND $1 = ANY(pg_blocking_pids(pid))`, [pid])).rows
      if (waiting.length === 0) await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(settled, 'operation must still be waiting for the canonical user lock').toBe(false)
    expect(waiting).toHaveLength(1)
    expect(waiting[0].query).toMatch(/FROM users[\s\S]*FOR UPDATE/i)
    await write(holder)
    await holder.query('COMMIT')
    return await pending
  } finally {
    await holder.query('ROLLBACK')
    if (pending) await pending
    await holder.end()
  }
}

describe('DingTalk identity authorization boundaries (real DB)', () => {
  beforeEach(() => {
    vi.stubEnv('DINGTALK_AUTH_REQUIRE_GRANT', '1')
    vi.stubEnv('DINGTALK_AUTH_AUTO_LINK_EMAIL', '1')
    vi.stubEnv('DINGTALK_AUTH_AUTO_PROVISION', '0')
    clientMocks.readDingTalkOauthConfig.mockReturnValue({
      clientId: 'synthetic-client', clientSecret: 'synthetic-secret',
      redirectUri: 'https://example.test/callback', corpId: CORP,
    })
    clientMocks.exchangeCodeForUserAccessToken.mockResolvedValue({ accessToken: 'synthetic-token' })
  })
  afterEach(() => vi.unstubAllEnvs())
  afterAll(async () => {
    await q('DELETE FROM directory_account_links WHERE local_user_id=ANY($1::text[])', [users])
    await q('DELETE FROM directory_accounts WHERE integration_id=ANY($1::uuid[])', [integrations])
    await q('DELETE FROM directory_integrations WHERE id=ANY($1::uuid[])', [integrations])
    await q('DELETE FROM users WHERE id=ANY($1::text[])', [users])
  })

  it('is wired to required real-DB CI and excluded from the no-DB suite', () => {
    const root = path.resolve(__dirname, '../../../..')
    const filename = 'tests/integration/dingtalk-identity-boundaries.db.test.ts'
    const workflow = readFileSync(path.join(root, '.github/workflows/plugin-tests.yml'), 'utf8')
    const start = workflow.indexOf(': "${DATABASE_URL:?DATABASE_URL is required for approval real-DB integration}"')
    expect(start).toBeGreaterThanOrEqual(0)
    const stepStart = workflow.lastIndexOf('\n      - name:', start)
    expect(stepStart).toBeGreaterThanOrEqual(0)
    const tail = workflow.slice(stepStart + 1)
    const nextStep = tail.search(/\n {6}- (?:name|uses):/)
    const step = nextStep < 0 ? tail : tail.slice(0, nextStep)
    expect(step).toMatch(/^\s+EXPECT_DB: ['\"]1['\"]\s*$/m)
    expect(step).toContain('exec vitest --config vitest.integration.config.ts run')
    expect(step.split('\n').some(line => line.trim() === `${filename} \\`)).toBe(true)
    expect(readFileSync(path.join(root, 'packages/core-backend/vitest.config.ts'), 'utf8')).toContain(filename)
  })

  function withoutCorp() {
    clientMocks.readDingTalkOauthConfig.mockReturnValue({
      clientId: 'synthetic-client', clientSecret: 'synthetic-secret',
      redirectUri: 'https://example.test/callback', corpId: null,
    })
  }

  async function duplicatePerson(firstId: string, secondId: string) {
    await q(`UPDATE user_external_identities SET provider_union_id=$2,
      provider_open_id=$3, external_key=corp_id || ':' || $3, updated_at=NOW() + interval '1 hour'
      WHERE local_user_id=$1 AND provider='dingtalk'`,
    [secondId, `${firstId}-union-A`, `${firstId}-open-A`])
  }

  it.each(['enabled', 'disabled', 'admin'])('rejects cross-corp ambiguity instead of selecting latest %s account', async mode => {
    withoutCorp()
    const first = await seed({ identity: true, grant: true })
    const second = await seed({ identity: true, grant: mode !== 'disabled', corp: `${CORP}-other` })
    if (mode === 'admin') await q("UPDATE users SET role='admin', is_admin=TRUE WHERE id=$1", [second.id])
    await duplicatePerson(first.id, second.id)
    const before = [await state(first.id), await state(second.id)]
    clientMocks.fetchDingTalkCurrentUser.mockResolvedValue({
      openId: `${first.id}-open-A`, unionId: `${first.id}-union-A`, nick: 'Synthetic', email: first.email,
    })
    await expect(exchangeCodeForUser('synthetic-code')).rejects.toMatchObject({ statusCode: 409, code: 'identity_ambiguous' })
    expect([await state(first.id), await state(second.id)]).toEqual(before)
  })

  it('configured corp selects only its own account despite a newer other-corp account', async () => {
    const first = await seed({ identity: true, grant: true })
    const second = await seed({ identity: true, grant: true, corp: `${CORP}-other` })
    await duplicatePerson(first.id, second.id)
    const before = await state(second.id)
    clientMocks.fetchDingTalkCurrentUser.mockResolvedValue({
      openId: `${first.id}-open-A`, unionId: `${first.id}-union-A`, nick: 'Synthetic', email: first.email,
    })
    expect((await exchangeCodeForUser('synthetic-code')).localUserId).toBe(first.id)
    expect(await state(second.id)).toEqual(before)
  })

  it('unscoped self-bind cannot duplicate an identity already owned in a known corp', async () => {
    withoutCorp()
    const first = await seed({ identity: true, grant: true })
    const second = await seed()
    const before = [await state(first.id), await state(second.id)]
    await expect(bindDingTalkIdentityToUser({ localUserId: second.id, enableGrant: true, dtUser: {
      openId: `${first.id}-open-A`, unionId: `${first.id}-union-A`, nick: 'Synthetic',
    } })).rejects.toMatchObject({ statusCode: 409, code: 'identity_already_bound' })
    expect([await state(first.id), await state(second.id)]).toEqual(before)
  })

  it.each([true, false])('rechecks cross-corp ambiguity after the canonical user lock (grant=%s)', async granted => {
    withoutCorp()
    const first = await seed({ identity: true, grant: granted })
    const second = await seed({ identity: true, grant: true, corp: `${CORP}-other` })
    await q("UPDATE user_external_identities SET provider_open_id=NULL WHERE local_user_id=$1", [first.id])
    const before = await state(first.id)
    clientMocks.fetchDingTalkCurrentUser.mockResolvedValue({
      openId: `${first.id}-open-A`, unionId: `${first.id}-union-A`, nick: 'Synthetic', email: first.email,
    })
    const result = await committedRace(first.id, holder => holder.query(
      `UPDATE user_external_identities SET provider_union_id=$2, provider_open_id=$3,
       external_key=corp_id || ':' || $3 WHERE local_user_id=$1 AND provider='dingtalk'`,
      [second.id, `${first.id}-union-A`, `${first.id}-open-A`]), () => exchangeCodeForUser('synthetic-code'))
    expect(result.error).toMatchObject({ statusCode: 409, code: 'identity_ambiguous' })
    expect(await state(first.id)).toEqual(before)
  })

  it.each(['union-only', 'open-only', 'legacy-null-corp', 'inactive', 'external-key-only'])('fails closed for cross-corp candidate variant %s', async variant => {
    withoutCorp()
    const first = await seed({ identity: true, grant: true })
    const second = await seed({ identity: true, grant: true, corp: `${CORP}-other` })
    await duplicatePerson(first.id, second.id)
    if (variant === 'union-only') await q(`UPDATE user_external_identities
      SET provider_open_id=NULL WHERE local_user_id=$1`, [second.id])
    if (variant === 'open-only') await q(`UPDATE user_external_identities
      SET provider_union_id=$2 WHERE local_user_id=$1`, [second.id, `${second.id}-different-union`])
    if (variant === 'legacy-null-corp') await q(`UPDATE user_external_identities
      SET corp_id=NULL WHERE local_user_id=$1`, [second.id])
    if (variant === 'inactive') await q('UPDATE users SET is_active=FALSE WHERE id=$1', [second.id])
    if (variant === 'external-key-only') await q(`UPDATE user_external_identities
      SET external_key=$2, provider_union_id=$3, provider_open_id=$4 WHERE local_user_id=$1`,
    [second.id, `${first.id}-union-A`, `${second.id}-unrelated-union`, `${second.id}-unrelated-open`])
    const before = (await q('SELECT * FROM user_external_identities WHERE local_user_id=ANY($1::text[]) ORDER BY local_user_id', [[first.id, second.id]])).rows
    clientMocks.fetchDingTalkCurrentUser.mockResolvedValue({
      openId: `${first.id}-open-A`, unionId: `${first.id}-union-A`, nick: 'Synthetic', email: first.email,
    })
    await expect(exchangeCodeForUser('synthetic-code')).rejects.toMatchObject({ statusCode: 409, code: 'identity_ambiguous' })
    expect((await q('SELECT * FROM user_external_identities WHERE local_user_id=ANY($1::text[]) ORDER BY local_user_id', [[first.id, second.id]])).rows).toEqual(before)
  })

  it('container login also rejects a cross-corp union identity collision', async () => {
    withoutCorp()
    const first = await seed({ identity: true, grant: true })
    const second = await seed({ identity: true, grant: true, corp: `${CORP}-other` })
    await duplicatePerson(first.id, second.id)
    const before = [await state(first.id), await state(second.id)]
    clientMocks.fetchDingTalkAppAccessToken.mockResolvedValue('synthetic-app-token')
    clientMocks.getDingTalkUserInfoByAuthCode.mockResolvedValue({ userId: 'synthetic-employee', unionId: `${first.id}-union-A` })
    clientMocks.getDingTalkUserDetail.mockResolvedValue({ name: 'Synthetic', unionId: `${first.id}-union-A` })
    await expect(exchangeEnterpriseAuthCodeForUser('synthetic-code')).rejects.toMatchObject({ statusCode: 409, code: 'identity_ambiguous' })
    expect([await state(first.id), await state(second.id)]).toEqual(before)
  })

  it('first email association rejects a newly committed owner in another corp', async () => {
    withoutCorp()
    const first = await seed({ grant: true })
    const second = await seed({ identity: true, grant: true, corp: `${CORP}-other` })
    const before = await state(first.id)
    const result = await committedRace(first.id, holder => holder.query(
      `UPDATE user_external_identities SET provider_union_id=$2, provider_open_id=$3,
       external_key=corp_id || ':' || $3 WHERE local_user_id=$1 AND provider='dingtalk'`,
      [second.id, `${first.id}-union-B`, `${first.id}-open-B`]), () => oauth(first.id, first.email))
    expect(result.error).toMatchObject({ statusCode: 409, code: 'identity_already_bound' })
    expect(await state(first.id)).toEqual(before)
  })

  it.each(['login', 'rejected', 'bind'])('serializes a scoped writer arriving AFTER the unscoped %s recheck', async mode => {
    withoutCorp()
    const first = await seed({ identity: true, grant: mode !== 'rejected' })
    const second = await seed()
    if (mode === 'rejected') await q('UPDATE user_external_identities SET provider_open_id=NULL WHERE local_user_id=$1', [first.id])
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
    const writer = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    await writer.connect()
    let login: Promise<{ error: unknown }> | undefined
    let write: Promise<unknown> | undefined
    try {
      await holder.query('BEGIN')
      // Row-only lock parks OAuth AFTER its candidate recheck, without blocking the table barrier.
      await holder.query('SELECT id FROM user_external_identities WHERE local_user_id=$1 FOR UPDATE', [first.id])
      const holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      const dtUser = { openId: `${first.id}-open-A`, unionId: `${first.id}-union-A`, nick: 'Synthetic' }
      clientMocks.fetchDingTalkCurrentUser.mockResolvedValue(dtUser)
      login = (mode === 'bind'
        ? bindDingTalkIdentityToUser({ localUserId: first.id, enableGrant: true, dtUser })
        : exchangeCodeForUser('synthetic-code')).then(() => ({ error: null }), error => ({ error }))
      let oauthPid = 0
      for (let i = 0; i < 100 && !oauthPid; i++) {
        await holder.query('SELECT pg_stat_clear_snapshot()')
        const rows = (await holder.query('SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [holderPid])).rows
        oauthPid = Number(rows[0]?.pid || 0)
        if (!oauthPid) await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(oauthPid, 'OAuth must reach the identity row after its candidate recheck').toBeGreaterThan(0)
      const writerPid = Number((await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      let writerDone = false
      write = writer.query(`INSERT INTO user_external_identities
        (provider, local_user_id, corp_id, external_key, provider_union_id, provider_open_id, profile)
        VALUES ('dingtalk', $1, $2, $3, $4, $5, '{}'::jsonb)`,
      [second.id, `${CORP}-other`, `${CORP}-other:${first.id}-open-A`, dtUser.unionId, dtUser.openId])
        .finally(() => { writerDone = true })
      let blocked = false
      for (let i = 0; i < 100 && !blocked && !writerDone; i++) {
        await holder.query('SELECT pg_stat_clear_snapshot()')
        blocked = (await holder.query('SELECT $1=ANY(pg_blocking_pids($2)) AS blocked', [oauthPid, writerPid])).rows[0].blocked
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(writerDone, 'scoped writer cannot commit in the check/write window').toBe(false)
      expect(blocked).toBe(true)
      expect((await holder.query(`SELECT mode FROM pg_locks WHERE pid=$1
        AND relation='user_external_identities'::regclass AND granted
        AND mode='ShareRowExclusiveLock'`, [oauthPid])).rows).toEqual([{ mode: 'ShareRowExclusiveLock' }])
      await holder.query('COMMIT')
      const result = await login
      if (mode === 'rejected') expect(result.error).toMatchObject({ code: 'grant_required' })
      else expect(result.error).toBeNull()
      await write
      // Scoped writes remain legitimate after the serialized operation commits. The next
      // unscoped login must now reject the ambiguity, never pick either account.
      await expect(exchangeCodeForUser('synthetic-code')).rejects.toMatchObject({ code: 'identity_ambiguous' })
    } finally {
      await holder.query('ROLLBACK')
      if (login) await login
      if (write) await write
      await writer.end()
      await holder.end()
    }
  })

  it('does not provision an unscoped account merely because an enterprise allowlist exists', async () => {
    withoutCorp()
    vi.stubEnv('DINGTALK_AUTH_REQUIRE_GRANT', '0')
    vi.stubEnv('DINGTALK_AUTH_AUTO_LINK_EMAIL', '0')
    vi.stubEnv('DINGTALK_AUTH_AUTO_PROVISION', '1')
    vi.stubEnv('DINGTALK_ALLOWED_CORP_IDS', CORP)
    const email = `${RUN}-unscoped-jit@example.test`
    const dtUser = { openId: `${RUN}-jit-open`, unionId: `${RUN}-jit-union`, nick: 'Synthetic JIT', email }
    clientMocks.fetchDingTalkCurrentUser.mockResolvedValue(dtUser)
    try {
      await expect(exchangeCodeForUser('synthetic-code')).rejects.toMatchObject({ statusCode: 409, code: 'auto_provision_corp_required' })
      expect((await q('SELECT id FROM users WHERE email=$1', [email])).rows).toEqual([])
      expect((await q("SELECT id FROM user_external_identities WHERE provider='dingtalk' AND provider_union_id=$1", [dtUser.unionId])).rows).toEqual([])
    } finally {
      // Also clean up the pre-fix red run, which creates a real local user.
      await q('DELETE FROM users WHERE email=$1', [email])
    }
  })

  it('preserves an explicit disabled grant and all identity state on self-bind', async () => {
    const { id } = await seed({ identity: true, grant: false })
    const before = await state(id)
    await expect(selfBind(id)).rejects.toMatchObject({ statusCode: 403 })
    expect(await state(id)).toEqual(before)
  })

  it('allows first self-bind without a grant and does not grant an administrator role', async () => {
    const { id } = await seed()
    await selfBind(id)
    expect(await state(id)).toEqual({
      user: [{ role: 'user', is_admin: false, is_active: true, activation_status: 'activated', access_generation: '1' }],
      identity: [{ corp_id: CORP, provider_union_id: `${id}-union-B`, provider_open_id: `${id}-open-B` }],
      grant: [{ enabled: true, granted_by: id }], links: [],
    })
  })

  it('rejects after a concurrent administrator grant revocation commits', async () => {
    const { id } = await seed({ identity: true, grant: true })
    const before = await state(id)
    const result = await committedRace(id, holder => holder.query(
      `UPDATE user_external_auth_grants SET enabled=FALSE WHERE provider='dingtalk' AND local_user_id=$1`, [id]),
    () => selfBind(id))
    expect(result.error).toMatchObject({ statusCode: 403 })
    expect(await state(id)).toEqual({ ...before, grant: [{ enabled: false, granted_by: id }] })
  })

  it('rejects a stale self-bind after concurrent directory takeover commits', async () => {
    const { id } = await seed({ identity: true, grant: true })
    const accountId = await directorySource(id)
    const before = await state(id)
    const result = await committedRace(id, holder => holder.query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status)
       VALUES ($1, $2, 'linked')`, [accountId, id]), () => selfBind(id))
    expect(result.error).toMatchObject({ statusCode: 409 })
    expect(await state(id)).toEqual({ ...before, links: [{ directory_account_id: accountId, link_status: 'linked' }] })
  })

  it('rechecks local-user inactivity after waiting for the mutex', async () => {
    const { id } = await seed({ identity: true, grant: true })
    const before = await state(id)
    const result = await committedRace(id,
      holder => holder.query('UPDATE users SET is_active=FALSE WHERE id=$1', [id]), () => selfBind(id))
    expect(result.error).toMatchObject({ statusCode: 403 })
    expect(await state(id)).toEqual({ ...before, user: [{ ...before.user[0], is_active: false }] })
  })

  it.each([false, true])('email fallback cannot replace an existing identity (different corp=%s)', async otherCorp => {
    const { id, email } = await seed({ identity: true, grant: true, corp: otherCorp ? `${CORP}-other` : CORP })
    const before = await state(id)
    await expect(oauth(id, email)).rejects.toMatchObject({ statusCode: 409 })
    expect(await state(id)).toEqual(before)
  })

  it('email fallback rechecks an identity installed while it waits for the user lock', async () => {
    const { id, email } = await seed({ grant: true })
    const result = await committedRace(id, holder => holder.query(
      `INSERT INTO user_external_identities (provider, local_user_id, corp_id, external_key, provider_union_id, provider_open_id, profile)
       VALUES ('dingtalk', $1, $2, $3, $4, $5, '{}'::jsonb)`,
      [id, CORP, `${CORP}:${id}-open-A`, `${id}-union-A`, `${id}-open-A`]), () => oauth(id, email))
    expect(result.error).toMatchObject({ statusCode: 409 })
    expect((await state(id)).identity).toEqual([{ corp_id: CORP, provider_union_id: `${id}-union-A`, provider_open_id: `${id}-open-A` }])
  })

  it('allows first email association when no prior identity exists', async () => {
    const { id, email } = await seed({ grant: true })
    expect((await oauth(id, email)).localUserId).toBe(id)
    expect((await state(id)).identity).toEqual([{ corp_id: CORP, provider_union_id: `${id}-union-B`, provider_open_id: `${id}-open-B` }])
  })

  it('preserves same-person union identity enrichment', async () => {
    const { id, email } = await seed({ identity: true, grant: true })
    await q(`UPDATE user_external_identities SET provider_open_id=NULL, external_key=$2
             WHERE local_user_id=$1 AND provider='dingtalk'`, [id, `${CORP}:${id}-union-A`])
    clientMocks.fetchDingTalkCurrentUser.mockResolvedValue({ openId: `${id}-open-A`, unionId: `${id}-union-A`, nick: 'Synthetic A', email })
    expect((await exchangeCodeForUser('synthetic-code')).localUserId).toBe(id)
    expect((await state(id)).identity).toEqual([{ corp_id: CORP, provider_union_id: `${id}-union-A`, provider_open_id: `${id}-open-A` }])
  })

  it('allows deliberate self-replacement when the existing grant is enabled', async () => {
    const { id } = await seed({ identity: true, grant: true })
    await selfBind(id)
    expect((await state(id)).identity).toEqual([{ corp_id: CORP, provider_union_id: `${id}-union-B`, provider_open_id: `${id}-open-B` }])
    expect((await state(id)).grant).toEqual([{ enabled: true, granted_by: id }])
  })

  it('email fallback cannot claim a directory-managed user even when its identity row is absent', async () => {
    const { id, email } = await seed({ grant: true })
    const account = await directorySource(id)
    await q(`INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status)
             VALUES ($1, $2, 'linked')`, [account, id])
    const before = await state(id)
    await expect(oauth(id, email)).rejects.toMatchObject({ statusCode: 409 })
    expect(await state(id)).toEqual(before)
  })

  it('a conflicting non-strict email fallback must not create a grant before rejecting', async () => {
    vi.stubEnv('DINGTALK_AUTH_REQUIRE_GRANT', '0')
    const { id, email } = await seed({ identity: true })
    const before = await state(id)
    await expect(oauth(id, email)).rejects.toMatchObject({ statusCode: 409 })
    expect(await state(id)).toEqual(before)
  })

  it('non-strict first email association creates the identity and its new grant', async () => {
    vi.stubEnv('DINGTALK_AUTH_REQUIRE_GRANT', '0')
    const { id, email } = await seed()
    expect((await oauth(id, email)).localUserId).toBe(id)
    expect((await state(id)).identity).toEqual([{ corp_id: CORP, provider_union_id: `${id}-union-B`, provider_open_id: `${id}-open-B` }])
    expect((await state(id)).grant).toEqual([{ enabled: true, granted_by: id }])
  })

  it('email first association rejects a grant revoked while it waits for the user mutex', async () => {
    const { id, email } = await seed({ grant: true })
    const before = await state(id)
    const result = await committedRace(id, holder => holder.query(
      `UPDATE user_external_auth_grants SET enabled=FALSE WHERE provider='dingtalk' AND local_user_id=$1`, [id]),
    () => oauth(id, email))
    expect(result.error).toMatchObject({ statusCode: 403 })
    expect(await state(id)).toEqual({ ...before, grant: [{ enabled: false, granted_by: id }] })
  })

  it('identity login cannot restore a binding replaced while it waits for the user mutex', async () => {
    const { id, email } = await seed({ identity: true, grant: true })
    clientMocks.fetchDingTalkCurrentUser.mockResolvedValue({ openId: `${id}-open-A`, unionId: `${id}-union-A`, nick: 'Synthetic A', email })
    const before = await state(id)
    const result = await committedRace(id, holder => holder.query(
      `UPDATE user_external_identities SET external_key=$2, provider_union_id=$3, provider_open_id=$4
       WHERE provider='dingtalk' AND local_user_id=$1`,
      [id, `${CORP}:${id}-open-B`, `${id}-union-B`, `${id}-open-B`]), () => exchangeCodeForUser('synthetic-code'))
    expect(result.error).toMatchObject({ statusCode: 409 })
    expect(await state(id)).toEqual({ ...before, identity: [{ corp_id: CORP, provider_union_id: `${id}-union-B`, provider_open_id: `${id}-open-B` }] })
  })

  it('identity login rejects a grant revoked while it waits for the user mutex', async () => {
    const { id, email } = await seed({ identity: true, grant: true })
    clientMocks.fetchDingTalkCurrentUser.mockResolvedValue({ openId: `${id}-open-A`, unionId: `${id}-union-A`, nick: 'Synthetic A', email })
    const before = await state(id)
    const result = await committedRace(id, holder => holder.query(
      `UPDATE user_external_auth_grants SET enabled=FALSE WHERE provider='dingtalk' AND local_user_id=$1`, [id]),
    () => exchangeCodeForUser('synthetic-code'))
    expect(result.error).toMatchObject({ statusCode: 403 })
    expect(await state(id)).toEqual({ ...before, grant: [{ enabled: false, granted_by: id }] })
  })

  it('email fallback cannot reuse matching provider IDs from another corporation', async () => {
    const { id, email } = await seed({ identity: true, grant: true, corp: `${CORP}-other` })
    const before = await state(id)
    clientMocks.fetchDingTalkCurrentUser.mockResolvedValue({ openId: `${id}-open-A`, unionId: `${id}-union-A`, nick: 'Synthetic A', email })
    await expect(exchangeCodeForUser('synthetic-code')).rejects.toMatchObject({ statusCode: 409 })
    expect(await state(id)).toEqual(before)
  })

  it.each(['self-bind', 'email-login'])('a different provider association does not block DingTalk %s', async entry => {
    const { id, email } = await seed({ grant: true })
    const account = await directorySource(id, 'wecom')
    await q(`INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status)
             VALUES ($1, $2, 'linked')`, [account, id])
    const before = await state(id)
    if (entry === 'self-bind') await selfBind(id)
    else expect((await oauth(id, email)).localUserId).toBe(id)
    expect(await state(id)).toEqual({
      ...before,
      user: [{ ...before.user[0], access_generation: '1' }],
      identity: [{ corp_id: CORP, provider_union_id: `${id}-union-B`, provider_open_id: `${id}-open-B` }],
    })
  })

  it('a matching OpenID cannot replace a contradictory known UnionID', async () => {
    const { id, email } = await seed({ identity: true, grant: true })
    const before = await state(id)
    clientMocks.fetchDingTalkCurrentUser.mockResolvedValue({ openId: `${id}-open-A`, unionId: `${id}-union-B`, nick: 'Synthetic B', email })
    await expect(exchangeCodeForUser('synthetic-code')).rejects.toMatchObject({ statusCode: 409 })
    expect(await state(id)).toEqual(before)
  })

  it('a missing stored corp cannot authorize moving an existing binding into the configured corp', async () => {
    const { id, email } = await seed({ identity: true, grant: true, corp: `${CORP}-other` })
    await q(`UPDATE user_external_identities SET corp_id=NULL WHERE provider='dingtalk' AND local_user_id=$1`, [id])
    const before = await state(id)
    clientMocks.fetchDingTalkCurrentUser.mockResolvedValue({ openId: `${id}-open-A`, unionId: `${id}-union-A`, nick: 'Synthetic A', email })
    await expect(exchangeCodeForUser('synthetic-code')).rejects.toMatchObject({ statusCode: 409 })
    expect(await state(id)).toEqual(before)
  })

  it('the same verified UnionID can enrich its OpenID within the same corporation', async () => {
    const { id, email } = await seed({ identity: true, grant: true })
    clientMocks.fetchDingTalkCurrentUser.mockResolvedValue({ openId: `${id}-open-B`, unionId: `${id}-union-A`, nick: 'Synthetic A', email })
    expect((await exchangeCodeForUser('synthetic-code')).localUserId).toBe(id)
    expect((await state(id)).identity).toEqual([{ corp_id: CORP, provider_union_id: `${id}-union-A`, provider_open_id: `${id}-open-B` }])
  })

  it('identity login cannot restore a binding removed while waiting for the user mutex', async () => {
    const { id, email } = await seed({ identity: true, grant: true })
    const before = await state(id)
    clientMocks.fetchDingTalkCurrentUser.mockResolvedValue({ openId: `${id}-open-A`, unionId: `${id}-union-A`, nick: 'Synthetic A', email })
    const result = await committedRace(id, holder => holder.query(
      `DELETE FROM user_external_identities WHERE provider='dingtalk' AND local_user_id=$1`, [id]),
    () => exchangeCodeForUser('synthetic-code'))
    expect(result.error).toMatchObject({ statusCode: 409, code: 'identity_mismatch' })
    expect(await state(id)).toEqual({ ...before, identity: [] })
  })

  it('strict identity login rejects a grant removed while waiting for the user mutex', async () => {
    const { id, email } = await seed({ identity: true, grant: true })
    const before = await state(id)
    clientMocks.fetchDingTalkCurrentUser.mockResolvedValue({ openId: `${id}-open-A`, unionId: `${id}-union-A`, nick: 'Synthetic A', email })
    const result = await committedRace(id, holder => holder.query(
      `DELETE FROM user_external_auth_grants WHERE provider='dingtalk' AND local_user_id=$1`, [id]),
    () => exchangeCodeForUser('synthetic-code'))
    expect(result.error).toMatchObject({ statusCode: 403, code: 'grant_required' })
    expect(await state(id)).toEqual({ ...before, grant: [] })
  })

  it('email association rejects directory takeover committed while waiting for the user mutex', async () => {
    const { id, email } = await seed({ grant: true })
    const account = await directorySource(id)
    const before = await state(id)
    const result = await committedRace(id, holder => holder.query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status)
       VALUES ($1, $2, 'linked')`, [account, id]), () => oauth(id, email))
    expect(result.error).toMatchObject({ statusCode: 409, code: 'directory_managed_identity' })
    expect(await state(id)).toEqual({ ...before, links: [{ directory_account_id: account, link_status: 'linked' }] })
  })

  it('can fill a missing corp column when the existing canonical key proves the current corp', async () => {
    const { id, email } = await seed({ identity: true, grant: true })
    await q(`UPDATE user_external_identities SET corp_id=NULL WHERE provider='dingtalk' AND local_user_id=$1`, [id])
    clientMocks.fetchDingTalkCurrentUser.mockResolvedValue({ openId: `${id}-open-A`, unionId: `${id}-union-A`, nick: 'Synthetic A', email })
    expect((await exchangeCodeForUser('synthetic-code')).localUserId).toBe(id)
    expect((await state(id)).identity).toEqual([{ corp_id: CORP, provider_union_id: `${id}-union-A`, provider_open_id: `${id}-open-A` }])
  })

  it.each([false, true])('an unset configured corp preserves an established identity scope (known OpenID=%s)', async knownOpenId => {
    const { id, email } = await seed({ identity: true, grant: true })
    if (!knownOpenId) await q(`UPDATE user_external_identities SET provider_open_id=NULL, external_key=$2
      WHERE provider='dingtalk' AND local_user_id=$1`, [id, `${CORP}:${id}-union-A`])
    clientMocks.readDingTalkOauthConfig.mockReturnValue({ corpId: null })
    clientMocks.fetchDingTalkCurrentUser.mockResolvedValue({ openId: `${id}-open-B`, unionId: `${id}-union-A`, nick: 'Synthetic A', email })
    expect((await exchangeCodeForUser('synthetic-code')).localUserId).toBe(id)
    expect((await q(`SELECT corp_id, external_key, provider_union_id, provider_open_id FROM user_external_identities
      WHERE provider='dingtalk' AND local_user_id=$1`, [id])).rows).toEqual([{
      corp_id: CORP, external_key: `${CORP}:${id}-open-B`, provider_union_id: `${id}-union-A`, provider_open_id: `${id}-open-B`,
    }])
  })

  it.each([undefined, false])('rejected login cannot overwrite a concurrently replaced union-only identity (grant=%s)', async grant => {
    const { id, email } = await seed({ identity: true, grant })
    await q(`UPDATE user_external_identities SET provider_open_id=NULL, external_key=$2
      WHERE provider='dingtalk' AND local_user_id=$1`, [id, `${CORP}:${id}-union-A`])
    const account = await directorySource(id)
    await q(`INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status)
      VALUES ($1, $2, 'linked')`, [account, id])
    const before = await state(id)
    clientMocks.fetchDingTalkCurrentUser.mockResolvedValue({ openId: `${id}-open-A`, unionId: `${id}-union-A`, nick: 'Synthetic A', email })
    const result = await committedRace(id, async holder => {
      await holder.query(`UPDATE user_external_identities SET external_key=$2, provider_union_id=$3, provider_open_id=NULL
        WHERE provider='dingtalk' AND local_user_id=$1`, [id, `${CORP}:${id}-union-B`, `${id}-union-B`])
      await holder.query('UPDATE directory_accounts SET union_id=$2, open_id=NULL WHERE id=$1', [account, `${id}-union-B`])
    }, () => exchangeCodeForUser('synthetic-code'))
    expect(result.error).toMatchObject({ statusCode: 403, code: 'grant_required' })
    expect(await state(id)).toEqual({ ...before, identity: [{ corp_id: CORP, provider_union_id: `${id}-union-B`, provider_open_id: null }] })
    expect((await q('SELECT union_id, open_id FROM directory_accounts WHERE id=$1', [account])).rows)
      .toEqual([{ union_id: `${id}-union-B`, open_id: null }])
  })

  it.each([undefined, false])('rejected same-person login can enrich OpenID without configured corp or admission (grant=%s)', async grant => {
    const { id, email } = await seed({ identity: true, grant })
    const account = await directorySource(id)
    await q('UPDATE directory_accounts SET open_id=NULL WHERE id=$1', [account])
    await q(`UPDATE user_external_identities SET provider_open_id=NULL, external_key=$2
      WHERE provider='dingtalk' AND local_user_id=$1`, [id, `${CORP}:${id}-union-A`])
    clientMocks.readDingTalkOauthConfig.mockReturnValue({ corpId: null })
    clientMocks.fetchDingTalkCurrentUser.mockResolvedValue({ openId: `${id}-open-A`, unionId: `${id}-union-A`, nick: 'Synthetic A', email })
    const before = await state(id)
    await expect(exchangeCodeForUser('synthetic-code')).rejects.toMatchObject({ statusCode: 403, code: 'grant_required' })
    expect(await state(id)).toEqual({ ...before, identity: [{ corp_id: CORP, provider_union_id: `${id}-union-A`, provider_open_id: `${id}-open-A` }] })
    expect((await q(`SELECT external_key FROM user_external_identities WHERE provider='dingtalk' AND local_user_id=$1`, [id])).rows)
      .toEqual([{ external_key: `${CORP}:${id}-open-A` }])
    expect((await q('SELECT open_id FROM directory_accounts WHERE id=$1', [account])).rows).toEqual([{ open_id: `${id}-open-A` }])
  })

  it.each([[true, 'union'], [false, 'union'], [true, 'open']] as const)('an unset configured corp preserves legacy key-only scope during enrichment (grant=%s, key=%s)', async (grant, keyKind) => {
    const { id, email } = await seed({ identity: true, grant })
    const legacyKey = `${CORP}:${id}-${keyKind}-A`
    await q(`UPDATE user_external_identities SET corp_id=NULL, provider_open_id=$3, external_key=$2
      WHERE provider='dingtalk' AND local_user_id=$1`, [id, legacyKey, keyKind === 'open' ? `${id}-open-A` : null])
    clientMocks.readDingTalkOauthConfig.mockReturnValue({ corpId: null })
    clientMocks.fetchDingTalkCurrentUser.mockResolvedValue({ openId: `${id}-open-B`, unionId: `${id}-union-A`, nick: 'Synthetic A', email })
    if (grant) expect((await exchangeCodeForUser('synthetic-code')).localUserId).toBe(id)
    else await expect(exchangeCodeForUser('synthetic-code')).rejects.toMatchObject({ statusCode: 403, code: 'grant_required' })
    expect((await q(`SELECT corp_id, external_key, provider_union_id, provider_open_id FROM user_external_identities
      WHERE provider='dingtalk' AND local_user_id=$1`, [id])).rows).toEqual([{
      corp_id: null, external_key: `${CORP}:${id}-open-B`, provider_union_id: `${id}-union-A`, provider_open_id: `${id}-open-B`,
    }])
    expect((await state(id)).grant).toEqual([{ enabled: grant, granted_by: id }])
    // Restoring the configured corp must still recognize the canonical legacy proof.
    clientMocks.readDingTalkOauthConfig.mockReturnValue({ corpId: CORP })
    if (!grant) await q(`UPDATE user_external_auth_grants SET enabled=TRUE WHERE provider='dingtalk' AND local_user_id=$1`, [id])
    expect((await exchangeCodeForUser('synthetic-code')).localUserId).toBe(id)
    expect((await q(`SELECT corp_id, external_key FROM user_external_identities WHERE provider='dingtalk' AND local_user_id=$1`, [id])).rows)
      .toEqual([{ corp_id: CORP, external_key: `${CORP}:${id}-open-B` }])
  })

})
