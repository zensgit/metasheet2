/** Real PG transactions, synthetic provider only. No online binding or provider requests. */
import { randomUUID } from 'node:crypto'
import * as bcrypt from 'bcryptjs'
import { describe, it, expect, vi } from 'vitest'
const provider = vi.hoisted(() => ({
  config: vi.fn(),
  exchange: vi.fn(),
  profile: vi.fn(),
}))
vi.mock('../../src/integrations/dingtalk/client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readDingTalkOauthConfig: provider.config,
  exchangeCodeForUserAccessToken: provider.exchange,
  fetchDingTalkCurrentUser: provider.profile,
}))
import { exchangeCodeForUser } from '../../src/auth/dingtalk-oauth'
import { isUserSessionRevoked } from '../../src/auth/session-revocation'
import { query, pool } from '../../src/db/pg'
import {
  verifyDingTalkRepair,
  previewDingTalkRepair,
  applyDingTalkRepair,
  rollbackDingTalkRepair,
} from '../../src/auth/dingtalk-identity-repair'
import { listUserPermissions } from '../../src/rbac/service'
import { approvalPendingSource } from '../../src/services/approval-pending-source'
import { bindDirectoryAccount } from '../../src/directory/directory-sync'
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from '../../src/security/encrypted-secrets'
const suite = process.env.DATABASE_URL ? describe : describe.skip
if (process.env.EXPECT_DB === '1')
  it('requires a real DB', () => expect(process.env.DATABASE_URL).toBeTruthy())
async function fixture() {
  process.env.ENCRYPTION_KEY = 'synthetic-repair-key-'.repeat(5)
  process.env.ENCRYPTION_SALT = 'synthetic-repair-salt-'.repeat(3)
  const user = randomUUID(),
    admin = randomUUID(),
    source = randomUUID(),
    account = randomUUID(),
    approval = randomUUID(),
    corp = 'corp-' + randomUUID()
  const password = 'SyntheticPassword-Only!42'
  await query(
    `INSERT INTO users(id,username,name,password_hash,is_active,is_admin,activation_status,local_password_set) VALUES($1,$1,$1,$2,true,false,'activated',true),($3,$3,$3,$2,true,true,'activated',true)`,
    [user, await bcrypt.hash(password, 4), admin],
  )
  await query(
    "INSERT INTO user_roles(user_id,role_id) VALUES($1,'attendance_employee')",
    [user],
  )
  const role = 'login-repair-role-' + user
  await query('INSERT INTO roles(id,name) VALUES($1,$1)', [role])
  await query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)', [
    user,
    role,
  ])
  for (const code of ['approvals:read', 'approvals:act']) {
    await query(
      'INSERT INTO permissions(code,name) VALUES($1,$1) ON CONFLICT DO NOTHING',
      [code],
    )
    await query(
      'INSERT INTO role_permissions(role_id,permission_code) VALUES($1,$2)',
      [role, code],
    )
  }
  await query(
    "INSERT INTO user_orgs(user_id,org_id,is_active) VALUES($1,'default',true)",
    [user],
  )
  await query(
    `INSERT INTO directory_integrations(id,name,provider,corp_id,org_id,config,status,sync_enabled) VALUES($1,$2,'dingtalk',$3,'default','{}','active',false)`,
    [source, 'synthetic-' + user, corp],
  )
  await query(
    `INSERT INTO directory_accounts(id,integration_id,corp_id,external_user_id,union_id,open_id,external_key,name) VALUES($1,$2,$3,$4,$5,$6,$4,'Synthetic old member')`,
    [account, source, corp, user, 'old-union-' + user, 'old-open-' + user],
  )
  await query(
    `INSERT INTO directory_account_links(directory_account_id,local_user_id,link_status,match_strategy) VALUES($1,$2,'linked','manual_admin')`,
    [account, user],
  )
  await query(
    `INSERT INTO user_external_identities(provider,external_key,local_user_id,corp_id,provider_open_id,provider_union_id) VALUES('dingtalk',$1,$2,$3,$4,$5)`,
    [
      corp + ':old-open-' + user,
      user,
      corp,
      'old-open-' + user,
      'old-union-' + user,
    ],
  )
  await query(
    "INSERT INTO user_external_auth_grants(provider,local_user_id,enabled) VALUES('dingtalk',$1,true)",
    [user],
  )
  await query(
    "INSERT INTO approval_instances(id,status,current_node_key,title,org_id) VALUES($1,'pending','approve','Synthetic retained todo','default')",
    [approval],
  )
  await query(
    "INSERT INTO approval_assignments(instance_id,assignment_type,assignee_id,node_key,entry_epoch,is_active) VALUES($1,'user',$2,'approve',1,true)",
    [approval, user],
  )
  provider.config.mockReturnValue({
    corpId: corp,
    clientId: 'synthetic-current-app',
    clientSecret: 'unused',
    redirectUri: 'https://example.test/callback',
  })
  provider.exchange
    .mockReset()
    .mockResolvedValue({ accessToken: 'synthetic-provider-token' })
  provider.profile.mockReset().mockResolvedValue({
    openId: 'new-open-' + user,
    unionId: 'new-union-' + user,
  })
  const graph = async () => {
    const out = []
    for (const [table, key] of [
      ['user_roles', 'user_id'],
      ['user_permissions', 'user_id'],
      ['directory_account_links', 'local_user_id'],
      ['user_external_auth_grants', 'local_user_id'],
      ['approval_assignments', 'assignee_id'],
    ])
      out.push(
        (
          await query(
            `SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${key}=$1 ORDER BY to_jsonb(t)::text`,
            [user],
          )
        ).rows,
      )
    out.push(
      (
        await query(
          'SELECT to_jsonb(t) AS row FROM approval_instances t WHERE id=$1',
          [approval],
        )
      ).rows,
    )
    const permissions = await listUserPermissions(user, query)
    const roles = (
      await query('SELECT role_id FROM user_roles WHERE user_id=$1', [user])
    ).rows.map((r) => r.role_id)
    const items = await approvalPendingSource.listPendingForUser({
      actorId: user,
      roles,
      permissions,
    })
    expect(items).toHaveLength(1)
    expect(items[0].actionable).toBe(true)
    out.push({
      permissions: permissions.sort(),
      todos: items.map((i) => ({ id: i.id, actionable: i.actionable })),
    })
    return out
  }
  return {
    user,
    admin,
    corp,
    account,
    password,
    graph,
    verify: () => verifyDingTalkRepair(user, password, 'synthetic-code', admin),
  }
}
suite('DingTalk controlled login repair', () => {
  it('verification and preview do not write rows, issue sessions, or return raw identifiers', async () => {
    const f = await fixture(),
      before = await f.graph()
    const proof = await f.verify()
    const p = await previewDingTalkRepair(proof)
    expect(p.permissionsChanged).toBe(false)
    expect(proof).not.toContain('new-open')
    expect(await f.graph()).toEqual(before)
    expect(
      (
        await query('SELECT * FROM dingtalk_login_repairs WHERE user_id=$1', [
          f.user,
        ])
      ).rows,
    ).toHaveLength(0)
    expect(
      (await query('SELECT * FROM user_sessions WHERE user_id=$1', [f.user]))
        .rows,
    ).toHaveLength(0)
  })
  it('apply, stale-directory rejection, successful same-person enrichment, and rollback retain roles and todos', async () => {
    const f = await fixture(),
      before = await f.graph(),
      proof = await f.verify(),
      p = await previewDingTalkRepair(proof)
    const r = await applyDingTalkRepair(proof, p.digest, 'apply')
    expect(await f.graph()).toEqual(before)
    await expect(
      bindDirectoryAccount(f.account, {
        localUserRef: f.user,
        adminUserId: f.admin,
        enableDingTalkGrant: true,
      }),
    ).rejects.toThrow()
    expect(
      (await exchangeCodeForUser('synthetic-fresh-code')).localUserId,
    ).toBe(f.user)

    expect(await f.graph()).toEqual(before)
    const undo = await rollbackDingTalkRepair(
      r.id,
      f.admin,
      r.digest,
      'rollback',
    )
    expect(undo.targetSessionsRevoked).toBe(true)
    expect(
      await isUserSessionRevoked(f.user, Math.floor(Date.now() / 1000)),
    ).toBe(true)
    expect(await f.graph()).toEqual(before)
    expect(
      (
        await query(
          'SELECT provider_open_id FROM user_external_identities WHERE local_user_id=$1',
          [f.user],
        )
      ).rows[0].provider_open_id,
    ).toBe('old-open-' + f.user)
    expect(
      (
        await query('SELECT * FROM user_session_revocations WHERE user_id=$1', [
          f.user,
        ])
      ).rows,
    ).toHaveLength(1)
    await expect(
      applyDingTalkRepair(proof, p.digest, 'apply'),
    ).rejects.toThrow()
  })
  it('rejects password failure before provider exchange and refuses non-admin operators', async () => {
    const f = await fixture()
    await expect(
      verifyDingTalkRepair(f.user, 'wrong', 'code', f.admin),
    ).rejects.toThrow()
    expect(provider.exchange).not.toHaveBeenCalled()
    await expect(
      verifyDingTalkRepair(f.user, f.password, 'code', f.user),
    ).rejects.toThrow()
    expect(provider.exchange).not.toHaveBeenCalled()
  })
  it('refuses incomplete profile and provider failure without mutating the graph', async () => {
    const f = await fixture(),
      before = await f.graph()
    provider.profile.mockResolvedValue({ openId: 'only-open' })
    await expect(f.verify()).rejects.toThrow()
    provider.exchange.mockRejectedValue(new Error('synthetic refusal'))
    await expect(f.verify()).rejects.toThrow()
    expect(await f.graph()).toEqual(before)
  })
  it('rejects forged, expired, cross-app and cross-corp evidence', async () => {
    const f = await fixture(),
      proof = await f.verify()
    await expect(previewDingTalkRepair('{}')).rejects.toThrow()
    const raw = JSON.parse(decryptStoredSecretValue(proof))
    await expect(
      previewDingTalkRepair(
        encryptStoredSecretValue(JSON.stringify({ ...raw, expires: 0 })),
      ),
    ).rejects.toThrow()
    provider.config.mockReturnValue({ corpId: f.corp, clientId: 'other-app' })
    await expect(previewDingTalkRepair(proof)).rejects.toThrow()
    provider.config.mockReturnValue({
      corpId: 'other-corp',
      clientId: 'synthetic-current-app',
    })
    await expect(previewDingTalkRepair(proof)).rejects.toThrow()
  })
  it('refuses disabled accounts and disabled grants', async () => {
    const f = await fixture()
    await query('UPDATE users SET is_active=false WHERE id=$1', [f.user])
    await expect(f.verify()).rejects.toThrow()
    await query('UPDATE users SET is_active=true WHERE id=$1', [f.user])
    await query(
      'UPDATE user_external_auth_grants SET enabled=false WHERE local_user_id=$1',
      [f.user],
    )
    await expect(f.verify()).rejects.toThrow()
  })
  it('refuses an identity already owned by a different local account', async () => {
    const f = await fixture(),
      other = await fixture()
    provider.profile.mockResolvedValue({
      openId: 'old-open-' + other.user,
      unionId: 'old-union-' + other.user,
    })
    await query(
      'UPDATE user_external_identities SET corp_id=$2 WHERE local_user_id=$1',
      [other.user, f.corp],
    )
    provider.config.mockReturnValue({
      corpId: f.corp,
      clientId: 'synthetic-current-app',
    })
    const proof = await f.verify()
    await expect(previewDingTalkRepair(proof)).rejects.toThrow()
  })
  it('rejects unapproved confirmation and changed privileges; never adopts a fresh digest automatically', async () => {
    const f = await fixture(),
      proof = await f.verify(),
      p = await previewDingTalkRepair(proof)
    await expect(applyDingTalkRepair(proof, p.digest, 'yes')).rejects.toThrow()
    await query("UPDATE users SET role='admin' WHERE id=$1", [f.user])
    await expect(
      applyDingTalkRepair(proof, p.digest, 'apply'),
    ).rejects.toThrow()
  })
  it('refuses rollback after permission drift', async () => {
    const f = await fixture(),
      proof = await f.verify(),
      p = await previewDingTalkRepair(proof),
      r = await applyDingTalkRepair(proof, p.digest, 'apply')
    await query("UPDATE users SET role='admin' WHERE id=$1", [f.user])
    await expect(
      rollbackDingTalkRepair(r.id, f.admin, r.digest, 'rollback'),
    ).rejects.toThrow()
    expect(
      (
        await query('SELECT state FROM dingtalk_login_repairs WHERE id=$1', [
          r.id,
        ])
      ).rows[0].state,
    ).toBe('applied')
  })
  it('rejects a stale repeatable-read writer instead of bypassing the pin', async () => {
    const f = await fixture(),
      proof = await f.verify(),
      p = await previewDingTalkRepair(proof)
    const c = await pool!.connect()
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await c.query('SELECT * FROM users WHERE id=$1', [f.user])
      await applyDingTalkRepair(proof, p.digest, 'apply')
      await expect(
        c.query(
          "UPDATE user_external_identities SET provider_open_id='stale' WHERE local_user_id=$1",
          [f.user],
        ),
      ).rejects.toThrow()
    } finally {
      await c.query('ROLLBACK')
      c.release()
    }
  })
  it('only one concurrent apply commits', async () => {
    const f = await fixture(),
      proof = await f.verify(),
      p = await previewDingTalkRepair(proof)
    const r = await Promise.allSettled([
      applyDingTalkRepair(proof, p.digest, 'apply'),
      applyDingTalkRepair(proof, p.digest, 'apply'),
    ])
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    expect(
      (
        await query('SELECT * FROM dingtalk_login_repairs WHERE user_id=$1', [
          f.user,
        ])
      ).rows,
    ).toHaveLength(1)
  })
  it('rolls back all writes if the journal completion fails', async () => {
    const f = await fixture(),
      before = await f.graph(),
      proof = await f.verify(),
      p = await previewDingTalkRepair(proof)
    await query(
      `CREATE FUNCTION synthetic_repair_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${f.user}' THEN RAISE EXCEPTION 'synthetic fault'; END IF; RETURN NEW; END $$`,
    )
    await query(
      'CREATE TRIGGER synthetic_repair_fault BEFORE UPDATE ON dingtalk_login_repairs FOR EACH ROW EXECUTE FUNCTION synthetic_repair_fault()',
    )
    try {
      await expect(
        applyDingTalkRepair(proof, p.digest, 'apply'),
      ).rejects.toThrow()
      expect(await f.graph()).toEqual(before)
      expect(
        (
          await query('SELECT * FROM dingtalk_login_repairs WHERE user_id=$1', [
            f.user,
          ])
        ).rows,
      ).toHaveLength(0)
      expect(
        (
          await query(
            'SELECT provider_open_id FROM user_external_identities WHERE local_user_id=$1',
            [f.user],
          )
        ).rows[0].provider_open_id,
      ).toBe('old-open-' + f.user)
    } finally {
      await query(
        'DROP TRIGGER synthetic_repair_fault ON dingtalk_login_repairs',
      )
      await query('DROP FUNCTION synthetic_repair_fault()')
    }
  })
  it('refuses deleting migration history even after rollback', async () => {
    const { down } = await import(
      '../../src/db/migrations/zzzz20261102150000_dingtalk_login_repairs'
    )
    const { db } = await import('../../src/db/db')
    await expect(down(db)).rejects.toThrow('history must be retained')
  })
  it('allows security revocation but prevents recreating a stale identity', async () => {
    const f = await fixture(),
      proof = await f.verify(),
      p = await previewDingTalkRepair(proof),
      r = await applyDingTalkRepair(proof, p.digest, 'apply')
    await query('DELETE FROM user_external_identities WHERE local_user_id=$1', [
      f.user,
    ])
    await query(
      `INSERT INTO user_external_identities(provider,external_key,local_user_id) VALUES('synthetic-other-provider',$1,$2)`,
      ['other-' + f.user, f.user],
    )
    await expect(
      query(
        `UPDATE user_external_identities SET provider='dingtalk',external_key='stale' WHERE local_user_id=$1 AND provider='synthetic-other-provider'`,
        [f.user],
      ),
    ).rejects.toThrow()

    await query(
      'UPDATE user_external_auth_grants SET enabled=false WHERE local_user_id=$1',
      [f.user],
    )
    await expect(
      query(
        `INSERT INTO user_external_identities(provider,external_key,local_user_id,corp_id,provider_open_id,provider_union_id) VALUES('dingtalk',$1,$2,$3,'stale','stale')`,
        [f.corp + ':stale', f.user, f.corp],
      ),
    ).rejects.toThrow()
    await expect(
      rollbackDingTalkRepair(r.id, f.admin, r.digest, 'rollback'),
    ).rejects.toThrow()
  })
  it('refuses switching the old identity to a different enterprise before fetching a profile', async () => {
    const f = await fixture()
    provider.config.mockReturnValue({
      corpId: 'different-enterprise',
      clientId: 'synthetic-current-app',
    })
    await expect(f.verify()).rejects.toThrow()
    expect(provider.exchange).not.toHaveBeenCalled()
  })
})
