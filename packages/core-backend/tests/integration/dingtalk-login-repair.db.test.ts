/** Real PG transactions, synthetic provider only. No online binding or provider requests. */
import { randomUUID } from 'node:crypto'
import * as bcrypt from 'bcryptjs'
import express from 'express'
import request from 'supertest'
import { describe, it, expect, vi } from 'vitest'
const provider = vi.hoisted(() => ({
  config: vi.fn(),
  exchange: vi.fn(),
  profile: vi.fn(),
  token: vi.fn(),
  departments: vi.fn(),
  department: vi.fn(),
  members: vi.fn(),
  member: vi.fn(),
}))
vi.mock('../../src/integrations/dingtalk/client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readDingTalkOauthConfig: provider.config,
  exchangeCodeForUserAccessToken: provider.exchange,
  fetchDingTalkCurrentUser: provider.profile,
  fetchDingTalkAppAccessToken: provider.token,
  listDingTalkDepartments: provider.departments,
  getDingTalkDepartmentDetail: provider.department,
  listDingTalkDepartmentUsers: provider.members,
  getDingTalkUserDetail: provider.member,
}))
import { exchangeCodeForUser } from '../../src/auth/dingtalk-oauth'
import * as revocations from '../../src/auth/session-revocation'
import * as sessionRegistry from '../../src/auth/session-registry'
import { AuthService, authService } from '../../src/auth/AuthService'
import { authRouter } from '../../src/routes/auth'
import { ApiTokenService } from '../../src/multitable/api-token-service'
import { probeEncryptedStores } from '../../src/security/encrypted-store-probe'
import { poolManager } from '../../src/integration/db/connection-pool'
import { db } from '../../src/db/db'
import { applyDirectoryHandover } from '../../src/directory/controlled-handover'
import { isUserSessionRevoked } from '../../src/auth/session-revocation'
import * as pg from '../../src/db/pg'
import { query, pool } from '../../src/db/pg'
import {
  verifyDingTalkRepair,
  previewDingTalkRepair,
  applyDingTalkRepair,
  rollbackDingTalkRepair,
  previewDingTalkRepairRecovery,
  releaseDingTalkRepair,
} from '../../src/auth/dingtalk-identity-repair'
import { listUserPermissions } from '../../src/rbac/service'
import { approvalPendingSource } from '../../src/services/approval-pending-source'
import {
  bindDirectoryAccount,
  unbindDirectoryAccount,
  syncDirectoryIntegration,
} from '../../src/directory/directory-sync'
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
    corp = 'corp-' + randomUUID(),
    // Own org per fixture: rows linked in 'default' would leak into other suites' org-scoped samples.
    org = 'login-repair-org-' + randomUUID()
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
    "INSERT INTO user_orgs(user_id,org_id,is_active) VALUES($1,$2,true)",
    [user, org],
  )
  await query(
    `INSERT INTO directory_integrations(id,name,provider,corp_id,org_id,config,status,sync_enabled) VALUES($1,$2,'dingtalk',$3,$4,'{"appKey":"synthetic-current-app"}','active',false)`,
    [source, 'synthetic-' + user, corp, org],
  )
  await query(
    `INSERT INTO directory_accounts(id,integration_id,corp_id,external_user_id,union_id,open_id,external_key,name) VALUES($1,$2,$3,$4,$5,$6,$4,'Synthetic old member')`,
    [account, source, corp, user, 'new-union-' + user, 'new-open-' + user],
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
    "INSERT INTO approval_instances(id,status,current_node_key,title,org_id) VALUES($1,'pending','approve','Synthetic retained todo',$2)",
    [approval, org],
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
    org,
    account,
    source,
    password,
    graph,
    verify: () =>
      verifyDingTalkRepair(user, password, 'synthetic-code', admin, password),
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
    const identity = async (user: string) =>
      (
        await query(
          'SELECT external_key,corp_id,provider_open_id,provider_union_id,profile,bound_by FROM user_external_identities WHERE local_user_id=$1',
          [user],
        )
      ).rows

    const f = await fixture(),
      before = await f.graph(),
      proof = await f.verify(),
      p = await previewDingTalkRepair(proof)
    const originalIdentity = await identity(f.user)
    const r = await applyDingTalkRepair(proof, p.digest, 'apply')
    expect(await f.graph()).toEqual(before)
    await query(
      'UPDATE directory_accounts SET union_id=$2,open_id=$3 WHERE id=$1',
      [f.account, 'old-union-' + f.user, 'old-open-' + f.user],
    )
    await expect(
      bindDirectoryAccount(f.account, {
        localUserRef: f.user,
        adminUserId: f.admin,
        enableDingTalkGrant: true,
      }),
    ).rejects.toThrow()
    await query(
      'UPDATE directory_accounts SET union_id=$2,open_id=$3 WHERE id=$1',
      [f.account, 'new-union-' + f.user, 'new-open-' + f.user],
    )
    expect(
      (await exchangeCodeForUser('synthetic-fresh-code')).localUserId,
    ).toBe(f.user)

    expect(await f.graph()).toEqual(before)
    const recovery = await previewDingTalkRepairRecovery(
      r.id,
      f.admin,
      f.password,
      'rollback',
    )
    // A real credential minted before rollback: its iat cannot postdate the rollback watermark.
    const issuer = new AuthService()
    const preRollbackIat = issuer.readTokenPayload(
      issuer.createToken({
        id: f.user,
        email: '',
        role: 'user',
      } as unknown as Parameters<AuthService['createToken']>[0]),
    )?.iat
    expect(typeof preRollbackIat).toBe('number')
    const undo = await rollbackDingTalkRepair(
      r.id,
      f.admin,
      recovery.digest,
      'rollback',
      f.password,
    )
    expect(undo.targetSessionsRevoked).toBe(true)
    expect(await identity(f.user)).toEqual(originalIdentity)
    expect(
      await isUserSessionRevoked(f.user, preRollbackIat),
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
      verifyDingTalkRepair(f.user, 'wrong', 'code', f.admin, f.password),
    ).rejects.toThrow()
    expect(provider.exchange).not.toHaveBeenCalled()
    await expect(
      verifyDingTalkRepair(f.user, f.password, 'code', f.user, f.password),
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
    await expect(f.verify()).rejects.toThrow('REPAIR_DIRECTORY_OWNER_CONFLICT')
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
  it('rejects stale recovery approval and retains permission drift after fresh approval', async () => {
    const f = await fixture(),
      proof = await f.verify(),
      p = await previewDingTalkRepair(proof),
      r = await applyDingTalkRepair(proof, p.digest, 'apply')
    const recovery = await previewDingTalkRepairRecovery(
      r.id,
      f.admin,
      f.password,
      'rollback',
    )
    await query("UPDATE users SET role='admin' WHERE id=$1", [f.user])
    await expect(
      rollbackDingTalkRepair(
        r.id,
        f.admin,
        recovery.digest,
        'rollback',
        f.password,
      ),
    ).rejects.toThrow('REPAIR_RECOVERY_SNAPSHOT_CHANGED')
    expect(
      (
        await query('SELECT state FROM dingtalk_login_repairs WHERE id=$1', [
          r.id,
        ])
      ).rows[0].state,
    ).toBe('applied')
    const fresh = await previewDingTalkRepairRecovery(
      r.id,
      f.admin,
      f.password,
      'rollback',
    )
    expect(fresh.changedSections).toContain('users')
    await rollbackDingTalkRepair(
      r.id,
      f.admin,
      fresh.digest,
      'rollback',
      f.password,
    )
    expect(
      (await query('SELECT role FROM users WHERE id=$1', [f.user])).rows[0]
        .role,
    ).toBe('admin')
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
      previewDingTalkRepairRecovery(r.id, f.admin, f.password, 'rollback'),
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
  it('revokes actual JWT verification, refresh, registry sessions and API tokens on apply and rollback', async () => {
    const f = await fixture()
    const trust = process.env.RBAC_TOKEN_TRUST,
      bypass = process.env.RBAC_BYPASS
    process.env.RBAC_TOKEN_TRUST = 'false'
    process.env.RBAC_BYPASS = 'false'
    try {
      const auth = new AuthService(),
        api = new ApiTokenService(db)
      const login = await auth.login(f.user, f.password)
      expect(login?.user.id).toBe(f.user)
      expect((await auth.verifyToken(login!.token))?.id).toBe(f.user)
      expect(await auth.refreshToken(login!.token)).toBeTruthy()
      const token = await api.createToken(f.user, {
        name: 'synthetic repair token',
        scopes: ['records:read'],
      })
      expect((await api.validateToken(token.plainTextToken)).valid).toBe(true)
      const proof = await f.verify(),
        preview = await previewDingTalkRepair(proof)
      const repair = await applyDingTalkRepair(proof, preview.digest, 'apply')
      expect(await auth.verifyToken(login!.token)).toBeNull()
      expect(await auth.refreshToken(login!.token)).toBeNull()
      expect((await api.validateToken(token.plainTextToken)).valid).toBe(false)
      // JWT iat has second precision; create a genuinely later session.
      await new Promise((resolve) => setTimeout(resolve, 1100))
      const next = await auth.login(f.user, f.password)
      expect((await auth.verifyToken(next!.token))?.id).toBe(f.user)
      const nextToken = await api.createToken(f.user, {
        name: 'synthetic later token',
        scopes: ['records:read'],
      })
      const recovery = await previewDingTalkRepairRecovery(
        repair.id,
        f.admin,
        f.password,
        'rollback',
      )
      await rollbackDingTalkRepair(
        repair.id,
        f.admin,
        recovery.digest,
        'rollback',
        f.password,
      )
      expect(await auth.verifyToken(next!.token)).toBeNull()
      expect(await auth.refreshToken(next!.token)).toBeNull()
      expect((await api.validateToken(nextToken.plainTextToken)).valid).toBe(
        false,
      )
      expect(
        (
          await query(
            'SELECT * FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL',
            [f.user],
          )
        ).rows,
      ).toHaveLength(0)
    } finally {
      if (trust === undefined) delete process.env.RBAC_TOKEN_TRUST
      else process.env.RBAC_TOKEN_TRUST = trust
      if (bypass === undefined) delete process.env.RBAC_BYPASS
      else process.env.RBAC_BYPASS = bypass
    }
  })
  it('preserves actual first-login role backfill and pending approval on recovery', async () => {
    const f = await fixture()
    await query(
      "DELETE FROM user_roles WHERE user_id=$1 AND role_id='attendance_employee'",
      [f.user],
    )
    const proof = await f.verify(),
      p = await previewDingTalkRepair(proof),
      r = await applyDingTalkRepair(proof, p.digest, 'apply')
    const auth = new AuthService()
    const login = await auth.login(f.user, f.password)
    expect(login?.user.permissions).toContain('attendance:read')
    expect(
      (
        await query(
          "SELECT role_id FROM user_roles WHERE user_id=$1 AND role_id='attendance_employee'",
          [f.user],
        )
      ).rows,
    ).toHaveLength(1)
    const graph = await f.graph()
    const preview = await previewDingTalkRepairRecovery(
      r.id,
      f.admin,
      f.password,
      'rollback',
    )
    expect(preview.changedSections).toContain('user_roles')
    await rollbackDingTalkRepair(
      r.id,
      f.admin,
      preview.digest,
      'rollback',
      f.password,
    )
    expect(await f.graph()).toEqual(graph)
  })
  it('rejects temporary credentials and an unauthenticated operator before fetching a profile', async () => {
    const f = await fixture()
    await expect(
      verifyDingTalkRepair(f.user, f.password, 'code', f.admin, 'wrong'),
    ).rejects.toThrow('REPAIR_OPERATOR_CREDENTIAL_REQUIRED')
    await query('UPDATE users SET must_change_password=true WHERE id=$1', [
      f.user,
    ])
    await expect(f.verify()).rejects.toThrow(
      'REPAIR_TARGET_CREDENTIAL_REQUIRED',
    )
    expect(provider.exchange).not.toHaveBeenCalled()
  })
  it('refuses a directory witness from the wrong application and a person owned by another local user', async () => {
    const f = await fixture()
    await query(
      `UPDATE directory_integrations SET config='{"appKey":"other-app"}' WHERE id=$1`,
      [f.source],
    )
    await expect(f.verify()).rejects.toThrow('REPAIR_PERSON_NOT_PROVEN')
    await query(
      `UPDATE directory_integrations SET config='{"appKey":"synthetic-current-app"}' WHERE id=$1`,
      [f.source],
    )
    await query(
      'UPDATE directory_account_links SET local_user_id=$2 WHERE directory_account_id=$1',
      [f.account, f.admin],
    )
    await expect(f.verify()).rejects.toThrow('REPAIR_DIRECTORY_OWNER_CONFLICT')
  })
  it('invalidates proof when the operator credential or namespace admission changes', async () => {
    const f = await fixture(),
      proof = await f.verify(),
      p = await previewDingTalkRepair(proof)
    await query(
      "INSERT INTO user_namespace_admissions(user_id,namespace,enabled) VALUES($1,'attendance',false)",
      [f.user],
    )
    await expect(applyDingTalkRepair(proof, p.digest, 'apply')).rejects.toThrow(
      'REPAIR_SNAPSHOT_CHANGED',
    )
    const fresh = await f.verify(),
      freshPreview = await previewDingTalkRepair(fresh)
    await query('UPDATE users SET password_hash=$2 WHERE id=$1', [
      f.admin,
      await bcrypt.hash('Synthetic replacement password', 4),
    ])
    await expect(
      applyDingTalkRepair(fresh, freshPreview.digest, 'apply'),
    ).rejects.toThrow('REPAIR_OPERATOR_CHANGED')
  })
  it('allows same-person OpenID rotation and controlled recovery without restoring stale authority', async () => {
    const f = await fixture(),
      proof = await f.verify(),
      p = await previewDingTalkRepair(proof),
      r = await applyDingTalkRepair(proof, p.digest, 'apply')
    provider.profile.mockResolvedValue({
      openId: 'rotated-' + f.user,
      unionId: 'new-union-' + f.user,
    })
    expect((await exchangeCodeForUser('fresh-code')).localUserId).toBe(f.user)
    expect(
      (
        await query(
          'SELECT provider_open_id FROM user_external_identities WHERE local_user_id=$1',
          [f.user],
        )
      ).rows[0].provider_open_id,
    ).toBe('rotated-' + f.user)
    await query(
      "INSERT INTO user_namespace_admissions(user_id,namespace,enabled) VALUES($1,'attendance',false)",
      [f.user],
    )
    const recovery = await previewDingTalkRepairRecovery(
      r.id,
      f.admin,
      f.password,
      'rollback',
    )
    await rollbackDingTalkRepair(
      r.id,
      f.admin,
      recovery.digest,
      'rollback',
      f.password,
    )
    expect(
      (
        await query(
          'SELECT enabled FROM user_namespace_admissions WHERE user_id=$1',
          [f.user],
        )
      ).rows[0].enabled,
    ).toBe(false)
  })
  it('prevents automatic second-account links while permitting explicit security revocation', async () => {
    const f = await fixture(),
      proof = await f.verify(),
      p = await previewDingTalkRepair(proof)
    await applyDingTalkRepair(proof, p.digest, 'apply')
    const account = randomUUID()
    await query(
      `INSERT INTO directory_accounts(id,integration_id,corp_id,external_user_id,external_key,name) VALUES($1::uuid,$2,$3,$1::text,$1::text,'Synthetic duplicate')`,
      [account, f.source, f.corp],
    )
    await expect(
      query(
        `INSERT INTO directory_account_links(directory_account_id,local_user_id,link_status,match_strategy) VALUES($1,$2,'linked','auto_external_key')`,
        [account, f.user],
      ),
    ).rejects.toThrow('repair blocks a second directory source')
    await query(
      "UPDATE directory_account_links SET link_status='unlinked' WHERE directory_account_id=$1",
      [f.account],
    )
    expect(
      (
        await query(
          'SELECT link_status FROM directory_account_links WHERE directory_account_id=$1',
          [f.account],
        )
      ).rows[0].link_status,
    ).toBe('unlinked')
  })
  it('releases a revoked repair without re-enabling a grant, restoring an identity or clearing revocation evidence', async () => {
    const f = await fixture(),
      proof = await f.verify(),
      p = await previewDingTalkRepair(proof),
      r = await applyDingTalkRepair(proof, p.digest, 'apply')
    await query(
      'UPDATE user_external_auth_grants SET enabled=false WHERE local_user_id=$1',
      [f.user],
    )
    await query('DELETE FROM user_external_identities WHERE local_user_id=$1', [
      f.user,
    ])
    const recovery = await previewDingTalkRepairRecovery(
      r.id,
      f.admin,
      f.password,
      'release',
    )
    await releaseDingTalkRepair(
      r.id,
      f.admin,
      recovery.digest,
      'release',
      f.password,
    )
    expect(
      (
        await query(
          'SELECT enabled FROM user_external_auth_grants WHERE local_user_id=$1',
          [f.user],
        )
      ).rows[0].enabled,
    ).toBe(false)
    expect(
      (
        await query(
          'SELECT * FROM user_external_identities WHERE local_user_id=$1',
          [f.user],
        )
      ).rows,
    ).toHaveLength(0)
    expect(
      (
        await query('SELECT state FROM dingtalk_login_repairs WHERE id=$1', [
          r.id,
        ])
      ).rows[0].state,
    ).toBe('released')
    await expect(
      previewDingTalkRepairRecovery(r.id, f.admin, f.password, 'rollback'),
    ).rejects.toThrow('REPAIR_NOT_ACTIVE')
  })
  it('requires a single canonical current source before releasing an active repair', async () => {
    const f = await fixture(),
      proof = await f.verify(),
      p = await previewDingTalkRepair(proof),
      r = await applyDingTalkRepair(proof, p.digest, 'apply')
    await query(
      `UPDATE directory_integrations SET config='{"appKey":"wrong-app"}' WHERE id=$1`,
      [f.source],
    )
    await expect(
      previewDingTalkRepairRecovery(r.id, f.admin, f.password, 'release'),
    ).rejects.toThrow('REPAIR_CANONICAL_SOURCE_REQUIRED')
    await query(
      `UPDATE directory_integrations SET config='{"appKey":"synthetic-current-app"}' WHERE id=$1`,
      [f.source],
    )
    const recovery = await previewDingTalkRepairRecovery(
      r.id,
      f.admin,
      f.password,
      'release',
    )
    await releaseDingTalkRepair(
      r.id,
      f.admin,
      recovery.digest,
      'release',
      f.password,
    )
    expect(
      (
        await query(
          'SELECT provider_union_id FROM user_external_identities WHERE local_user_id=$1',
          [f.user],
        )
      ).rows[0].provider_union_id,
    ).toBe('new-union-' + f.user)
  })
  it('blocks a handover during an active repair before changing any directory rows', async () => {
    const f = await fixture(),
      proof = await f.verify(),
      p = await previewDingTalkRepair(proof)
    await applyDingTalkRepair(proof, p.digest, 'apply')
    const target = randomUUID()
    await query(
      `INSERT INTO directory_integrations(id,name,provider,corp_id,org_id,config,status,sync_enabled) VALUES($1::uuid,$1::text,'dingtalk',$2,$3,'{}','active',false)`,
      [target, f.corp, f.org],
    )
    await expect(
      applyDirectoryHandover(
        { sourceIntegrationId: f.source, targetIntegrationId: target },
        'unused-before-preflight',
        f.admin,
      ),
    ).rejects.toThrow('Active login repair blocks handover')
  })
  it('blocks verification when a source participates in an applied handover', async () => {
    const f = await fixture(),
      target = randomUUID()
    await query(
      `INSERT INTO directory_integrations(id,name,provider,corp_id,org_id,config,status,sync_enabled) VALUES($1::uuid,$1::text,'dingtalk',$2,$3,'{}','active',false)`,
      [target, f.corp, f.org],
    )
    await query(
      `INSERT INTO directory_handovers(source_integration_id,target_integration_id,state,before_state,after_digest,created_by,updated_by) VALUES($1,$2,'applied','{}','synthetic',$3,$3)`,
      [f.source, target, f.admin],
    )
    await expect(f.verify()).rejects.toThrow('REPAIR_HANDOVER_ACTIVE')
    expect(provider.exchange).not.toHaveBeenCalled()
  })
  it('catalogues encrypted rollback history and fails closed across a key change, then recovers from the encrypted backup', async () => {
    const f = await fixture(),
      proof = await f.verify(),
      p = await previewDingTalkRepair(proof),
      r = await applyDingTalkRepair(proof, p.digest, 'apply')
    const saved = (
      await query(
        'SELECT before_identity FROM dingtalk_login_repairs WHERE id=$1',
        [r.id],
      )
    ).rows[0].before_identity
    expect(saved.startsWith('enc:')).toBe(true)
    expect(saved).not.toContain('old-open-')
    const probe = await probeEncryptedStores({ query, env: process.env })
    const store = probe.stores.find(
      (x) => x.store === 'dingtalk_login_repairs',
    )!
    expect(store.status).toBe('ok')
    expect(store.encrypted).toBeGreaterThan(0)
    expect(store.undecryptable).toBe(0)
    const key = process.env.ENCRYPTION_KEY
    try {
      process.env.ENCRYPTION_KEY =
        'synthetic replacement encryption key '.repeat(3)
      const changed = await probeEncryptedStores({ query, env: process.env })
      expect(
        changed.stores.find((x) => x.store === 'dingtalk_login_repairs')!
          .undecryptable,
      ).toBeGreaterThan(0)
      const preview = await previewDingTalkRepairRecovery(
        r.id,
        f.admin,
        f.password,
        'rollback',
      )
      await expect(
        rollbackDingTalkRepair(
          r.id,
          f.admin,
          preview.digest,
          'rollback',
          f.password,
        ),
      ).rejects.toThrow()
      expect(
        (
          await query(
            'SELECT state,before_identity FROM dingtalk_login_repairs WHERE id=$1',
            [r.id],
          )
        ).rows[0],
      ).toEqual({ state: 'applied', before_identity: saved })
    } finally {
      process.env.ENCRYPTION_KEY = key
    }
    // Restore only our synthetic encrypted backup; no plaintext identity snapshot is used.
    await query(
      'UPDATE dingtalk_login_repairs SET before_identity=$2 WHERE id=$1',
      [r.id, saved],
    )
    const recovery = await previewDingTalkRepairRecovery(
      r.id,
      f.admin,
      f.password,
      'rollback',
    )
    await rollbackDingTalkRepair(
      r.id,
      f.admin,
      recovery.digest,
      'rollback',
      f.password,
    )
    expect(
      (
        await query(
          'SELECT provider_open_id FROM user_external_identities WHERE local_user_id=$1',
          [f.user],
        )
      ).rows[0].provider_open_id,
    ).toBe('old-open-' + f.user)
  })
  it('supports a canonical directory member with no stored OpenID and revokes it through the existing unbind path', async () => {
    const f = await fixture()
    await query('UPDATE directory_accounts SET open_id=NULL WHERE id=$1', [
      f.account,
    ])
    const proof = await f.verify(),
      p = await previewDingTalkRepair(proof),
      r = await applyDingTalkRepair(proof, p.digest, 'apply')
    const rebound = await bindDirectoryAccount(f.account, {
      localUserRef: f.user,
      adminUserId: f.admin,
      enableDingTalkGrant: true,
    })
    expect(rebound).toBeTruthy()
    expect((await exchangeCodeForUser('same-person')).localUserId).toBe(f.user)
    await unbindDirectoryAccount(f.account, {
      adminUserId: f.admin,
      disableDingTalkGrant: true,
    })
    expect(
      (
        await query(
          'SELECT * FROM user_external_identities WHERE local_user_id=$1',
          [f.user],
        )
      ).rows,
    ).toHaveLength(0)
    expect(
      (
        await query(
          'SELECT enabled FROM user_external_auth_grants WHERE local_user_id=$1',
          [f.user],
        )
      ).rows[0].enabled,
    ).toBe(false)
    const recovery = await previewDingTalkRepairRecovery(
      r.id,
      f.admin,
      f.password,
      'release',
    )
    await releaseDingTalkRepair(
      r.id,
      f.admin,
      recovery.digest,
      'release',
      f.password,
    )
  })
  it('pure previews do not advance a generation or modify identity, journal, session or audit rows', async () => {
    const f = await fixture()
    const state = async () => {
      const out = []
      for (const [table, key, id] of [
        ['users', 'id', f.user],
        ['user_external_identities', 'local_user_id', f.user],
        ['user_sessions', 'user_id', f.user],
        ['user_session_revocations', 'user_id', f.user],
        ['dingtalk_login_repairs', 'user_id', f.user],
        ['audit_logs', 'user_name', f.admin],
      ])
        out.push(
          (
            await query(
              `SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${key}=$1 ORDER BY to_jsonb(t)::text`,
              [id],
            )
          ).rows,
        )
      return out
    }
    const before = await state(),
      proof = await f.verify()
    await previewDingTalkRepair(proof)
    expect(await state()).toEqual(before)
    const p = await previewDingTalkRepair(proof),
      r = await applyDingTalkRepair(proof, p.digest, 'apply')
    const applied = await state()
    await previewDingTalkRepairRecovery(r.id, f.admin, f.password, 'rollback')
    await previewDingTalkRepairRecovery(r.id, f.admin, f.password, 'release')
    expect(await state()).toEqual(applied)
    expect(
      (
        await query(
          "SELECT action,action_details FROM audit_logs WHERE resource_type='dingtalk_login_repairs' AND resource_id=$1",
          [r.id],
        )
      ).rows,
    ).toEqual([{ action: 'apply', action_details: { actorId: f.admin } }])
  })
  it('the insert guard itself fences an old RR snapshot using the updated users tuple', async () => {
    const f = await fixture(),
      proof = await f.verify(),
      p = await previewDingTalkRepair(proof),
      c = await pool!.connect()
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await c.query('SELECT id FROM users WHERE id=$1', [f.user])
      await applyDingTalkRepair(proof, p.digest, 'apply')
      await expect(
        c.query(
          `INSERT INTO user_external_identities(provider,external_key,local_user_id,corp_id,provider_open_id,provider_union_id) VALUES('dingtalk','stale',$1,$2,'stale','stale')`,
          [f.user, f.corp],
        ),
      ).rejects.toMatchObject({ code: '40001' })
    } finally {
      await c.query('ROLLBACK')
      c.release()
    }
  })
  it('a real no-change directory sync leaves the repaired user recoverable and does not add a second recipient', async () => {
    const f = await fixture()
    await query(`UPDATE directory_integrations SET config=$2 WHERE id=$1`, [
      f.source,
      {
        appKey: 'synthetic-current-app',
        appSecret: 'synthetic-no-network',
        rootDeptId: 1,
      },
    ])
    const member = {
      userId: f.user,
      unionId: 'new-union-' + f.user,
      openId: 'new-open-' + f.user,
      name: 'Synthetic old member',
      source: {},
      departmentIds: ['1'],
    }
    provider.token.mockResolvedValue('synthetic-no-network-token')
    provider.departments.mockResolvedValue([])
    provider.department.mockResolvedValue({ deptManagerUserIdList: [] })
    provider.members.mockResolvedValue({
      users: [member],
      nextCursor: null,
      hasMore: false,
    })
    provider.member.mockResolvedValue(member)
    const proof = await f.verify(),
      p = await previewDingTalkRepair(proof),
      r = await applyDingTalkRepair(proof, p.digest, 'apply')
    await syncDirectoryIntegration(f.source)
    expect(provider.members).toHaveBeenCalled()
    expect(
      (
        await query(
          "SELECT directory_account_id FROM directory_account_links WHERE local_user_id=$1 AND link_status='linked'",
          [f.user],
        )
      ).rows,
    ).toEqual([{ directory_account_id: f.account }])
    const recovery = await previewDingTalkRepairRecovery(
      r.id,
      f.admin,
      f.password,
      'rollback',
    )
    await rollbackDingTalkRepair(
      r.id,
      f.admin,
      recovery.digest,
      'rollback',
      f.password,
    )
    expect((await f.graph()).at(-1).todos).toHaveLength(1)
  })
  it('an in-flight refresh cannot resurrect a session revoked by repair', async () => {
    const f = await fixture(),
      auth = new AuthService(),
      login = await auth.login(f.user, f.password)
    expect(login?.user.id).toBe(f.user)
    const proof = await f.verify(),
      p = await previewDingTalkRepair(proof)
    let entered!: () => void, resume!: () => void
    const reached = new Promise<void>((resolve) => {
        entered = resolve
      }),
      released = new Promise<void>((resolve) => {
        resume = resolve
      })
    const real = sessionRegistry.isUserSessionActive
    const spy = vi
      .spyOn(sessionRegistry, 'isUserSessionActive')
      .mockImplementation(async (...args) => {
        const active = await real(...args)
        entered()
        await released
        return active
      })
    const refresh = auth.refreshToken(login!.token)
    try {
      await reached
      await applyDingTalkRepair(proof, p.digest, 'apply')
      await new Promise((resolve) => setTimeout(resolve, 1100))
      resume()
      expect((await refresh) === null).toBe(true)
      expect(
        (
          await query('SELECT revoked_at FROM user_sessions WHERE user_id=$1', [
            f.user,
          ])
        ).rows.every((row) => row.revoked_at),
      ).toBe(true)
    } finally {
      resume()
      await refresh
      spy.mockRestore()
    }
  })
  it('rejects a previously authenticated OAuth result after repair and admits a fresh current-person result', async () => {
    const f = await fixture()
    provider.profile.mockResolvedValue({
      openId: 'old-open-' + f.user,
      unionId: 'old-union-' + f.user,
    })
    const stale = await exchangeCodeForUser('old-scan')
    expect(stale.localUserId).toBe(f.user)
    provider.profile.mockResolvedValue({
      openId: 'new-open-' + f.user,
      unionId: 'new-union-' + f.user,
    })
    const proof = await f.verify(),
      p = await previewDingTalkRepair(proof)
    await applyDingTalkRepair(proof, p.digest, 'apply')
    expect(
      await sessionRegistry.createUserSession(f.user, {
        sessionId: randomUUID(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        expectedAccessGeneration: stale.sessionGeneration,
      }),
    ).toBeNull()
    const fresh = await exchangeCodeForUser('fresh-scan')
    expect(fresh.sessionGeneration).toBeGreaterThan(stale.sessionGeneration)
    expect(
      await sessionRegistry.createUserSession(f.user, {
        sessionId: randomUUID(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        expectedAccessGeneration: fresh.sessionGeneration,
      }),
    ).not.toBeNull()
  })
  it('rejects delayed API token creation and rotation certified before repair', async () => {
    const f = await fixture(),
      api = new ApiTokenService(db)
    const generation = Number(
      (await query('SELECT access_generation FROM users WHERE id=$1', [f.user]))
        .rows[0].access_generation,
    )
    const original = await api.createToken(
      f.user,
      { name: 'synthetic original', scopes: ['records:read'] },
      generation,
    )
    const proof = await f.verify(),
      p = await previewDingTalkRepair(proof)
    await applyDingTalkRepair(proof, p.digest, 'apply')
    const count = (
      await query('SELECT id FROM multitable_api_tokens WHERE created_by=$1', [
        f.user,
      ])
    ).rows.length
    await expect(
      api.createToken(
        f.user,
        { name: 'synthetic delayed', scopes: ['records:read'] },
        generation,
      ),
    ).rejects.toThrow('Authentication changed')
    await expect(
      api.rotateToken(original.token.id, f.user, generation),
    ).rejects.toThrow('Authentication changed')
    expect(
      (
        await query(
          'SELECT id FROM multitable_api_tokens WHERE created_by=$1',
          [f.user],
        )
      ).rows,
    ).toHaveLength(count)
    const fresh = Number(
      (await query('SELECT access_generation FROM users WHERE id=$1', [f.user]))
        .rows[0].access_generation,
    )
    const next = await api.createToken(
      f.user,
      { name: 'synthetic new authentication', scopes: ['records:read'] },
      fresh,
    )
    expect((await api.validateToken(next.plainTextToken)).valid).toBe(true)
  })
  it('rejects a stale same-person directory OpenID after a verified OAuth rotation', async () => {
    const f = await fixture(),
      proof = await f.verify(),
      p = await previewDingTalkRepair(proof)
    await applyDingTalkRepair(proof, p.digest, 'apply')
    provider.profile.mockResolvedValue({
      openId: 'rotated-' + f.user,
      unionId: 'new-union-' + f.user,
    })
    expect((await exchangeCodeForUser('fresh-rotation')).localUserId).toBe(
      f.user,
    )
    await expect(
      bindDirectoryAccount(f.account, {
        localUserRef: f.user,
        adminUserId: f.admin,
        enableDingTalkGrant: true,
      }),
    ).rejects.toThrow('repaired login identity is pinned')
    expect(
      (
        await query(
          'SELECT provider_open_id FROM user_external_identities WHERE local_user_id=$1',
          [f.user],
        )
      ).rows[0].provider_open_id,
    ).toBe('rotated-' + f.user)
  })

  it.each([false, true])(
    'release retains the source fence after grant disabled=%s, with a real synchronizable old source',
    async (disabled) => {
      const f = await fixture(),
        old = randomUUID(),
        account = randomUUID()
      await query(
        `INSERT INTO directory_integrations(id,name,provider,corp_id,org_id,config,status) VALUES($1::uuid,$1::text,'dingtalk',$2,$3,'{"appKey":"old-app","appSecret":"synthetic-no-network","rootDeptId":1}','active')`,
        [old, f.corp, f.org],
      )
      await query(
        `INSERT INTO directory_accounts(id,integration_id,corp_id,external_user_id,external_key,union_id,name) VALUES($1,$2,$3,$4,$4,$5,'Synthetic old unlinked source')`,
        [account, old, f.corp, 'old-' + f.user, 'new-union-' + f.user],
      )
      const member = {
        userId: 'old-' + f.user,
        unionId: 'new-union-' + f.user,
        name: 'Synthetic old unlinked source',
        departmentIds: ['1'],
        source: {},
      }
      provider.token.mockResolvedValue('synthetic-no-network-token')
      provider.departments.mockResolvedValue([])
      provider.department.mockResolvedValue({ deptManagerUserIdList: [] })
      provider.members.mockResolvedValue({
        users: [member],
        nextCursor: null,
        hasMore: false,
      })
      provider.member.mockResolvedValue(member)
      // Positive control: this configuration and provider response really can complete a sync.
      await syncDirectoryIntegration(old, 'synthetic-test')
      expect(
        (
          await query(
            'SELECT status FROM directory_sync_runs WHERE integration_id=$1 ORDER BY started_at DESC LIMIT 1',
            [old],
          )
        ).rows[0].status,
      ).toBe('completed')
      const proof = await f.verify(),
        p = await previewDingTalkRepair(proof),
        r = await applyDingTalkRepair(proof, p.digest, 'apply')
      if (disabled)
        await query(
          'UPDATE user_external_auth_grants SET enabled=false WHERE local_user_id=$1',
          [f.user],
        )
      const preview = await previewDingTalkRepairRecovery(
        r.id,
        f.admin,
        f.password,
        'release',
      )
      await releaseDingTalkRepair(
        r.id,
        f.admin,
        preview.digest,
        'release',
        f.password,
      )
      await expect(
        syncDirectoryIntegration(old, 'synthetic-test'),
      ).rejects.toThrow('repair blocks a second directory source')
      expect(
        (
          await query(
            "SELECT directory_account_id FROM directory_account_links WHERE local_user_id=$1 AND link_status='linked'",
            [f.user],
          )
        ).rows,
      ).toEqual([{ directory_account_id: f.account }])
    },
  )
  it('an in-flight legacy refresh without a sid cannot mint a new post-repair session', async () => {
    const f = await fixture(),
      auth = new AuthService(),
      login = await auth.login(f.user, f.password)
    const legacy = auth.createToken(login!.user)
    const proof = await f.verify(),
      p = await previewDingTalkRepair(proof)
    let entered!: () => void, resume!: () => void
    const reached = new Promise<void>((resolve) => {
        entered = resolve
      }),
      released = new Promise<void>((resolve) => {
        resume = resolve
      })
    const real = revocations.isUserSessionRevoked
    const spy = vi
      .spyOn(revocations, 'isUserSessionRevoked')
      .mockImplementation(async (...args) => {
        const result = await real(...args)
        entered()
        await released
        return result
      })
    const refresh = auth.refreshToken(legacy)
    try {
      await reached
      await applyDingTalkRepair(proof, p.digest, 'apply')
      await new Promise((resolve) => setTimeout(resolve, 1100))
      resume()
      expect((await refresh) === null).toBe(true)
      expect(
        (
          await query(
            'SELECT id FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL',
            [f.user],
          )
        ).rows,
      ).toHaveLength(0)
    } finally {
      resume()
      await refresh
      spy.mockRestore()
    }
  })

  describe('POST /api/auth/session-org across a repair apply', () => {
    const app = express()
    app.use(express.json())
    app.use('/api/auth', authRouter)
    const switchOrg = (token: string, orgId: string) =>
      request(app)
        .post('/api/auth/session-org')
        .set('authorization', `Bearer ${token}`)
        .send({ orgId })
    const activeSessions = async (user: string) =>
      (
        await query(
          'SELECT id FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL',
          [user],
        )
      ).rows
    const withDbTokenVerification = async (run: () => Promise<void>) => {
      const trust = process.env.RBAC_TOKEN_TRUST
      process.env.RBAC_TOKEN_TRUST = 'false'
      try {
        await run()
      } finally {
        if (trust === undefined) delete process.env.RBAC_TOKEN_TRUST
        else process.env.RBAC_TOKEN_TRUST = trust
      }
    }
    const secondOrg = async (user: string) => {
      const org = 'login-repair-org-b-' + randomUUID()
      await query(
        'INSERT INTO user_orgs(user_id,org_id,is_active) VALUES($1,$2,true)',
        [user, org],
      )
      return org
    }

    it('a normal organization switch still mints a usable session', async () => {
      await withDbTokenVerification(async () => {
        const f = await fixture(),
          orgB = await secondOrg(f.user)
        const login = await authService.login(f.user, f.password)
        expect(login?.user.id).toBe(f.user)
        const res = await switchOrg(login!.token, orgB)
        expect(res.status).toBe(200)
        expect(res.body.data.currentOrgId).toBe(orgB)
        const switched = await authService.verifyToken(res.body.data.token)
        expect(switched?.id).toBe(f.user)
        expect(authService.readTokenPayload(res.body.data.token)?.tenantId).toBe(orgB)
        expect(await activeSessions(f.user)).toHaveLength(1)
      })
    })

    it.each(['with a sid', 'without a sid'] as const)(
      'a credential %s authenticated before apply cannot obtain a new session after apply',
      async (shape) => {
        await withDbTokenVerification(async () => {
          const f = await fixture(),
            orgB = await secondOrg(f.user)
          const login = await authService.login(f.user, f.password)
          const credential =
            shape === 'with a sid'
              ? login!.token
              : authService.createToken(login!.user)
          if (shape === 'without a sid')
            expect(authService.readTokenPayload(credential)?.sid).toBeUndefined()
          const proof = await f.verify(),
            p = await previewDingTalkRepair(proof)
          let entered!: () => void, resume!: () => void
          const reached = new Promise<void>((resolve) => {
              entered = resolve
            }),
            released = new Promise<void>((resolve) => {
              resume = resolve
            })
          const real = authService.resolveSessionTenantId.bind(authService)
          // Parks the request after authentication (generation already read) and before the session write.
          const spy = vi
            .spyOn(authService, 'resolveSessionTenantId')
            .mockImplementation(async (...args) => {
              const result = await real(...args)
              entered()
              await released
              return result
            })
          const pending = switchOrg(credential, orgB).then((res) => res)
          try {
            await reached
            await applyDingTalkRepair(proof, p.digest, 'apply')
            // JWT iat has second precision: a token minted now would postdate the revocation watermark.
            await new Promise((resolve) => setTimeout(resolve, 1100))
            resume()
            const res = await pending
            expect(res.status).toBe(409)
            expect(res.body).toEqual({
              success: false,
              error: 'Authentication changed; please sign in again',
              code: 'authentication_changed',
            })
            expect(await activeSessions(f.user)).toHaveLength(0)
            expect(await authService.verifyToken(credential)).toBeNull()
          } finally {
            resume()
            await pending.catch(() => undefined)
            spy.mockRestore()
          }
          // A fresh post-apply sign-in can still switch organizations.
          const next = await authService.login(f.user, f.password)
          const after = await switchOrg(next!.token, orgB)
          expect(after.status).toBe(200)
          expect((await authService.verifyToken(after.body.data.token))?.id).toBe(f.user)
        })
      },
    )
  })

  describe('core-table lock acquisition waits a bounded time instead of failing immediately', () => {
    // SHARE UPDATE EXCLUSIVE is the lock (auto)VACUUM and ANALYZE hold; a plain session holding it
    // stands in for them but never cancels itself, so it exercises both the wait and the timeout.
    const holdConflictingLock = async () => {
      const holder = await pool!.connect()
      await holder.query('BEGIN')
      await holder.query('LOCK TABLE roles IN SHARE UPDATE EXCLUSIVE MODE')
      const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0]
        .pid
      return { holder, pid }
    }
    const waitUntilBlockedBy = async (pid: number) => {
      for (let i = 0; i < 300; i++) {
        const n = Number(
          (
            await query(
              'SELECT count(*) AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
              [pid],
            )
          ).rows[0].n,
        )
        if (n > 0) return true
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      return false
    }
    const journal = async (user: string) =>
      (
        await query(
          'SELECT state FROM dingtalk_login_repairs WHERE user_id=$1',
          [user],
        )
      ).rows

    it('apply queues behind a conflicting maintenance-shaped lock and proceeds once it is released', async () => {
      const f = await fixture(),
        proof = await f.verify(),
        p = await previewDingTalkRepair(proof)
      const { holder, pid } = await holdConflictingLock()
      let pending: Promise<unknown> | undefined
      try {
        pending = applyDingTalkRepair(proof, p.digest, 'apply')
        pending.catch(() => undefined)
        expect(await waitUntilBlockedBy(pid)).toBe(true)
        await new Promise((resolve) => setTimeout(resolve, 300))
        await holder.query('COMMIT')
        await expect(pending).resolves.toMatchObject({ id: expect.any(String) })
        expect(await journal(f.user)).toEqual([{ state: 'applied' }])
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined)
        holder.release()
        await pending?.catch(() => undefined)
      }
    })

    it.each(['apply', 'rollback'] as const)(
      '%s refuses with REPAIR_LOCK_BUSY within lock_timeout while the conflicting lock is held',
      async (action) => {
        const f = await fixture(),
          proof = await f.verify(),
          p = await previewDingTalkRepair(proof)
        let operation: () => Promise<unknown>
        if (action === 'apply')
          operation = () => applyDingTalkRepair(proof, p.digest, 'apply')
        else {
          const r = await applyDingTalkRepair(proof, p.digest, 'apply'),
            recovery = await previewDingTalkRepairRecovery(
              r.id,
              f.admin,
              f.password,
              'rollback',
            )
          operation = () =>
            rollbackDingTalkRepair(
              r.id,
              f.admin,
              recovery.digest,
              'rollback',
              f.password,
            )
        }
        const identityBefore = (
          await query(
            'SELECT to_jsonb(t) AS row FROM user_external_identities t WHERE local_user_id=$1',
            [f.user],
          )
        ).rows
        const journalBefore = await journal(f.user)
        const { holder } = await holdConflictingLock()
        try {
          const started = Date.now()
          await expect(operation()).rejects.toThrow('REPAIR_LOCK_BUSY')
          const elapsed = Date.now() - started
          // lock_timeout is 5s: it waited (not NOWAIT) and it did not hang.
          expect(elapsed).toBeGreaterThanOrEqual(4500)
          expect(elapsed).toBeLessThan(15000)
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined)
          holder.release()
        }
        expect(await journal(f.user)).toEqual(journalBefore)
        expect(
          (
            await query(
              'SELECT to_jsonb(t) AS row FROM user_external_identities t WHERE local_user_id=$1',
              [f.user],
            )
          ).rows,
        ).toEqual(identityBefore)
      },
    )

    const identityRows = async (user: string) =>
      (
        await query(
          'SELECT to_jsonb(t) AS row FROM user_external_identities t WHERE local_user_id=$1',
          [user],
        )
      ).rows

    it('a lock cycle during the bounded wait refuses with REPAIR_LOCK_BUSY, writes nothing, and lets the other transaction proceed', async () => {
      const f = await fixture(),
        proof = await f.verify(),
        p = await previewDingTalkRepair(proof)
      const identityBefore = await identityRows(f.user)
      const journalBefore = await journal(f.user)
      // A writer that already holds roles and then wants users: the reverse of apply's table order.
      const holder = await pool!.connect()
      let pending: Promise<unknown> | undefined
      let holderNext: Promise<unknown> | undefined
      try {
        await holder.query('BEGIN')
        await holder.query('LOCK TABLE roles IN ROW EXCLUSIVE MODE')
        const pid = (await holder.query('SELECT pg_backend_pid() AS pid'))
          .rows[0].pid
        const started = Date.now()
        pending = applyDingTalkRepair(proof, p.digest, 'apply')
        pending.catch(() => undefined)
        // Apply now holds the tables listed before roles (users first) and is queued on roles.
        expect(await waitUntilBlockedBy(pid)).toBe(true)
        // Close the cycle well before apply's deadlock_timeout (1s) check, so apply is the victim.
        await new Promise((resolve) => setTimeout(resolve, 200))
        holderNext = holder.query('LOCK TABLE users IN ROW EXCLUSIVE MODE')
        holderNext.catch(() => undefined)
        await expect(pending).rejects.toThrow('REPAIR_LOCK_BUSY')
        // Deadlock detection, not lock_timeout, ended the wait.
        expect(Date.now() - started).toBeLessThan(4500)
        await expect(holderNext).resolves.toBeDefined()
        await holder.query('COMMIT')
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined)
        holder.release()
        await pending?.catch(() => undefined)
        await holderNext?.catch(() => undefined)
      }
      expect(await journal(f.user)).toEqual(journalBefore)
      expect(await identityRows(f.user)).toEqual(identityBefore)
    })

    it('an identity-maintenance advisory-lock wait past lock_timeout refuses with REPAIR_LOCK_BUSY and writes nothing', async () => {
      const f = await fixture(),
        proof = await f.verify(),
        p = await previewDingTalkRepair(proof)
      const identityBefore = await identityRows(f.user)
      const journalBefore = await journal(f.user)
      // Stands in for a handover (or another repair) holding the shared maintenance mutex.
      const holder = await pool!.connect()
      try {
        await holder.query('BEGIN')
        await holder.query(
          "SELECT pg_advisory_xact_lock(hashtext('directory:identity-maintenance'))",
        )
        const started = Date.now()
        await expect(
          applyDingTalkRepair(proof, p.digest, 'apply'),
        ).rejects.toThrow('REPAIR_LOCK_BUSY')
        const elapsed = Date.now() - started
        expect(elapsed).toBeGreaterThanOrEqual(4500)
        expect(elapsed).toBeLessThan(15000)
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined)
        holder.release()
      }
      expect(await journal(f.user)).toEqual(journalBefore)
      expect(await identityRows(f.user)).toEqual(identityBefore)
    })
  })

  it('rejects a scan whose OpenID matches but whose stored directory UnionID names another person', async () => {
    const f = await fixture()
    await query('UPDATE directory_accounts SET union_id=$2 WHERE id=$1', [
      f.account,
      'different-person',
    ])
    await expect(f.verify()).rejects.toThrow(
      'REPAIR_DIRECTORY_PERSON_AMBIGUOUS',
    )
  })
  it('rejects a second active linked directory person hidden from the scanned identity lookup', async () => {
    const f = await fixture(),
      other = randomUUID()
    await query(
      `INSERT INTO directory_accounts(id,integration_id,corp_id,external_user_id,external_key,union_id,name) VALUES($1,$2,$3,$4,$4,'different-person','Synthetic other person')`,
      [other, f.source, f.corp, 'other-' + f.user],
    )
    await query(
      `INSERT INTO directory_account_links(directory_account_id,local_user_id,link_status,match_strategy) VALUES($1,$2,'linked','manual_admin')`,
      [other, f.user],
    )
    await expect(f.verify()).rejects.toThrow(
      'REPAIR_DIRECTORY_PERSON_AMBIGUOUS',
    )
  })
  it('a security-unlinked account still excludes handover through the repair source journal', async () => {
    const f = await fixture(),
      target = randomUUID(),
      proof = await f.verify(),
      p = await previewDingTalkRepair(proof)
    await applyDingTalkRepair(proof, p.digest, 'apply')
    await unbindDirectoryAccount(f.account, {
      adminUserId: f.admin,
      disableDingTalkGrant: true,
    })
    await query(
      `INSERT INTO directory_integrations(id,name,provider,corp_id,org_id,config,status) VALUES($1::uuid,$1::text,'dingtalk',$2,$3,'{}','active')`,
      [target, f.corp, f.org],
    )
    await expect(
      applyDirectoryHandover(
        { sourceIntegrationId: f.source, targetIntegrationId: target },
        'not-reached',
        f.admin,
      ),
    ).rejects.toThrow('Active login repair blocks handover')
  })
  it.each(['apply', 'rollback', 'release'] as const)(
    'pins READ COMMITTED for %s even with an RR-default transaction and revokes a credential committed while waiting',
    async (action) => {
      const f = await fixture(),
        proof = await f.verify(),
        p = await previewDingTalkRepair(proof)
      let operation: () => Promise<unknown>
      if (action === 'apply')
        operation = () => applyDingTalkRepair(proof, p.digest, 'apply')
      else {
        const r = await applyDingTalkRepair(proof, p.digest, 'apply'),
          preview = await previewDingTalkRepairRecovery(
            r.id,
            f.admin,
            f.password,
            action,
          )
        operation = () =>
          action === 'rollback'
            ? rollbackDingTalkRepair(
                r.id,
                f.admin,
                preview.digest,
                action,
                f.password,
              )
            : releaseDingTalkRepair(
                r.id,
                f.admin,
                preview.digest,
                action,
                f.password,
              )
      }
      const holder = await pool!.connect(),
        manager = poolManager.get(),
        original = manager.transaction.bind(manager),
        tokenId = randomUUID()
      const spy = vi
        .spyOn(manager, 'transaction')
        .mockImplementation((callback) =>
          original(async (client) => {
            await client.query(
              'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
            )
            return callback(client)
          }),
        )
      let pending: Promise<unknown> | undefined
      try {
        await holder.query('BEGIN')
        await holder.query('SELECT id FROM users WHERE id=$1 FOR SHARE', [
          f.user,
        ])
        const pid = (await holder.query('SELECT pg_backend_pid() AS pid'))
          .rows[0].pid
        pending = operation()
        let blocked = false
        for (let i = 0; i < 150; i++) {
          if (
            Number(
              (
                await query(
                  'SELECT count(*) AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
                  [pid],
                )
              ).rows[0].n,
            ) > 0
          ) {
            blocked = true
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        expect(blocked).toBe(true)
        await holder.query(
          `INSERT INTO multitable_api_tokens(id,name,token_hash,token_prefix,scopes,created_by,revoked) VALUES($1,'synthetic barrier token',$1,$1,'["records:read"]',$2,false)`,
          [tokenId, f.user],
        )
        await holder.query('COMMIT')
        await pending
        expect(
          (
            await query(
              'SELECT revoked FROM multitable_api_tokens WHERE id=$1',
              [tokenId],
            )
          ).rows[0].revoked,
        ).toBe(true)
      } finally {
        await holder.query('ROLLBACK')
        holder.release()
        await pending?.catch(() => {})
        spy.mockRestore()
      }
    },
  )
  it.each([
    [
      'user_roles',
      "DELETE FROM user_roles WHERE user_id=$1 AND role_id='attendance_employee'",
    ],
    [
      'user_permissions',
      "INSERT INTO user_permissions(user_id,permission_code) VALUES($1,'approvals:read')",
    ],
    ['user_orgs', 'UPDATE user_orgs SET is_active=false WHERE user_id=$1'],
    [
      'grant actor',
      'UPDATE user_external_auth_grants SET granted_by=$2 WHERE local_user_id=$1',
    ],
    [
      'directory link',
      "UPDATE directory_account_links SET review_note='Synthetic changed review' WHERE local_user_id=$1",
    ],
    [
      'identity key',
      "UPDATE user_external_identities SET provider_open_id='Synthetic changed key' WHERE local_user_id=$1",
    ],
    [
      'role definition',
      "UPDATE roles SET name=name||' changed' WHERE id='login-repair-role-'||$1",
    ],
    [
      'role permissions',
      "DELETE FROM role_permissions WHERE role_id='login-repair-role-'||$1 AND permission_code='approvals:act'",
    ],
  ])('rejects apply after %s authority changes', async (_name, sql) => {
    const f = await fixture(),
      proof = await f.verify(),
      p = await previewDingTalkRepair(proof)
    await query(sql, sql.includes('$2') ? [f.user, f.admin] : [f.user])
    await expect(applyDingTalkRepair(proof, p.digest, 'apply')).rejects.toThrow(
      'REPAIR_SNAPSHOT_CHANGED',
    )
    expect(
      (
        await query('SELECT id FROM dingtalk_login_repairs WHERE user_id=$1', [
          f.user,
        ])
      ).rows,
    ).toHaveLength(0)
  })
  it('rechecks administrator credentials at recovery preview and execution', async () => {
    const f = await fixture(),
      proof = await f.verify(),
      p = await previewDingTalkRepair(proof),
      r = await applyDingTalkRepair(proof, p.digest, 'apply')
    await expect(
      previewDingTalkRepairRecovery(r.id, f.admin, 'wrong', 'rollback'),
    ).rejects.toThrow('REPAIR_OPERATOR_CREDENTIAL_REQUIRED')
    const preview = await previewDingTalkRepairRecovery(
      r.id,
      f.admin,
      f.password,
      'rollback',
    )
    await expect(
      rollbackDingTalkRepair(
        r.id,
        f.admin,
        preview.digest,
        'rollback',
        'wrong',
      ),
    ).rejects.toThrow('REPAIR_OPERATOR_CREDENTIAL_REQUIRED')
    await rollbackDingTalkRepair(
      r.id,
      f.admin,
      preview.digest,
      'rollback',
      f.password,
    )
    expect(
      (
        await query(
          "SELECT action,action_details FROM audit_logs WHERE resource_type='dingtalk_login_repairs' AND resource_id=$1",
          [r.id],
        )
      ).rows,
    ).toEqual(
      expect.arrayContaining([
        { action: 'apply', action_details: { actorId: f.admin } },
        { action: 'rollback', action_details: { actorId: f.admin } },
      ]),
    )
  })
  it('database nonce and one-active-repair constraints reject replay independently of service prechecks', async () => {
    const f = await fixture(),
      proof = await f.verify(),
      p = await previewDingTalkRepair(proof),
      r = await applyDingTalkRepair(proof, p.digest, 'apply')
    const copy = (nonce: string | null, state: string) =>
      query(
        `INSERT INTO dingtalk_login_repairs(id,user_id,proof_nonce,state,before_identity,expected_identity,after_digest,actor_id,source_account_ids,source_integration_ids,login_client_id) SELECT $2::uuid,user_id,COALESCE($3::uuid,proof_nonce),$4,before_identity,expected_identity,after_digest,actor_id,source_account_ids,source_integration_ids,login_client_id FROM dingtalk_login_repairs WHERE id=$1`,
        [r.id, randomUUID(), nonce, state],
      )
    await expect(copy(null, 'rolled_back')).rejects.toMatchObject({
      code: '23505',
      constraint: 'dingtalk_login_repairs_proof_nonce_key',
    })
    await expect(copy(randomUUID(), 'applied')).rejects.toMatchObject({
      code: '23505',
      constraint: 'dingtalk_login_repairs_active',
    })
  })
  it('retains non-production unseeded dev sessions but never bypasses a generation fence or production user lookup', async () => {
    const missing = 'synthetic-missing-' + randomUUID(),
      prior = process.env.NODE_ENV
    const options = { expiresAt: new Date(Date.now() + 60000).toISOString() }
    try {
      process.env.NODE_ENV = 'test'
      expect(
        await sessionRegistry.createUserSession(missing, options),
      ).not.toBeNull()
      expect(
        await sessionRegistry.createUserSession(missing, {
          ...options,
          expectedAccessGeneration: 0,
        }),
      ).toBeNull()
      process.env.NODE_ENV = 'production'
      expect(
        await sessionRegistry.createUserSession(missing, options),
      ).toBeNull()
    } finally {
      process.env.NODE_ENV = prior
    }
  })

  it('a schema error cannot turn a generation-fenced session into a synthetic success', async () => {
    const f = await fixture(),
      spy = vi.spyOn(pg, 'query')
    try {
      spy.mockRejectedValueOnce(
        Object.assign(new Error('synthetic missing schema'), { code: '42P01' }),
      )
      expect(
        await sessionRegistry.createUserSession(f.user, {
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          expectedAccessGeneration: 0,
        }),
      ).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })
})
