/** Real PG transactions, synthetic provider only. No online binding or provider requests. */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { connect, createServer, type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as bcrypt from 'bcryptjs'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, it, expect, vi } from 'vitest'
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
  requestDingTalkRepairReanchor,
  previewDingTalkRepairReanchor,
  reanchorDingTalkRepair,
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
type Fixture = Awaited<ReturnType<typeof fixture>>
/** Exact refusal code (toThrow(string) is a substring match: REPAIR_IDENTITY_CONFLICT ⊂ REPAIR_OLD_IDENTITY_CONFLICT). */
const exact = (code: string) => new RegExp(`^${code}$`)
const journalRow = async (id: string) =>
  (
    await query(
      'SELECT state,released_account_ids,canonical_account_id,source_account_ids,source_integration_ids FROM dingtalk_login_repairs WHERE id=$1',
      [id],
    )
  ).rows[0]
/** A local user with no DingTalk identity, grant, link or repair journal. */
async function bareUser() {
  const id = randomUUID()
  await query(
    `INSERT INTO users(id,username,name,password_hash,is_active,is_admin,activation_status,local_password_set) VALUES($1,$1,$1,'synthetic-unused',true,false,'activated',false)`,
    [id],
  )
  return id
}
async function addIntegration(f: Fixture, appKey: string) {
  const id = randomUUID()
  await query(
    `INSERT INTO directory_integrations(id,name,provider,corp_id,org_id,config,status,sync_enabled) VALUES($1::uuid,$1::text,'dingtalk',$2,$3,$4,'active',false)`,
    [id, f.corp, f.org, { appKey }],
  )
  return id
}
async function addAccount(
  integration: string,
  corp: string,
  externalUserId: string,
  o: { union?: string | null; open?: string | null; active?: boolean } = {},
) {
  const id = randomUUID()
  await query(
    `INSERT INTO directory_accounts(id,integration_id,corp_id,external_user_id,external_key,union_id,open_id,is_active,name) VALUES($1,$2,$3,$4,$4,$5,$6,$7,'Synthetic extra member')`,
    [id, integration, corp, externalUserId, o.union ?? null, o.open ?? null, o.active ?? true],
  )
  return id
}
const link = (
  account: string,
  user: string,
  status = 'linked',
  strategy = 'manual_admin',
) =>
  query(
    `INSERT INTO directory_account_links(directory_account_id,local_user_id,link_status,match_strategy) VALUES($1,$2,$3,$4) ON CONFLICT (directory_account_id) DO UPDATE SET local_user_id=EXCLUDED.local_user_id,link_status=EXCLUDED.link_status,match_strategy=EXCLUDED.match_strategy`,
    [account, user, status, strategy],
  )
/** The product shape of a local directory member (local-directory-org.ts createLocalAccount + local anchor). */
async function localSource(f: Fixture, org = f.org) {
  const integration = randomUUID(),
    account = randomUUID()
  await query(
    `INSERT INTO directory_integrations(id,name,provider,corp_id,org_id,config,status,sync_enabled) VALUES($1,'Local organization','local',$2,$3,'{"mode":"editable","source":"local"}','active',false)`,
    [integration, 'local:' + org, org],
  )
  await query(
    `INSERT INTO directory_accounts(id,integration_id,provider,corp_id,external_user_id,external_key,name,is_active) VALUES($1,$2,'local',NULL,$3,$4,'Synthetic local member',true)`,
    [account, integration, f.user, org + ':' + f.user],
  )
  await link(account, f.user, 'linked', 'local_explicit')
  return { integration, account }
}
async function applyRepair(f: Fixture) {
  const proof = await f.verify(),
    p = await previewDingTalkRepair(proof)
  return applyDingTalkRepair(proof, p.digest, 'apply')
}
const releasePreview = (f: Fixture, id: string) =>
  previewDingTalkRepairRecovery(id, f.admin, f.password, 'release')
const releaseWith = (f: Fixture, id: string, digest: string) =>
  releaseDingTalkRepair(id, f.admin, digest, 'release', f.password)
/** Every row a refused recovery must leave untouched. */
async function capture(f: Fixture, id: string) {
  const out: Record<string, unknown> = {}
  for (const [table, key] of [
    ['users', 'id'],
    ['dingtalk_login_repairs', 'user_id'],
    ['user_external_auth_grants', 'local_user_id'],
    ['user_external_identities', 'local_user_id'],
    ['directory_account_links', 'local_user_id'],
    ['user_orgs', 'user_id'],
    ['user_roles', 'user_id'],
    ['user_permissions', 'user_id'],
    ['user_session_revocations', 'user_id'],
    ['user_sessions', 'user_id'],
  ])
    out[table] = (
      await query(
        `SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${key}=$1 ORDER BY to_jsonb(t)::text`,
        [f.user],
      )
    ).rows
  out.sourceLinks = (
    await query(
      'SELECT to_jsonb(l) AS row FROM directory_account_links l WHERE directory_account_id IN (SELECT unnest(source_account_ids) FROM dingtalk_login_repairs WHERE id=$1) ORDER BY to_jsonb(l)::text',
      [id],
    )
  ).rows
  out.audit = (
    await query(
      "SELECT action,action_details FROM audit_logs WHERE resource_type='dingtalk_login_repairs' AND resource_id=$1 ORDER BY action",
      [id],
    )
  ).rows
  return out
}
/** A refused recovery writes nothing, and the journal only carries its apply audit row. */
async function expectRefusedWithoutWrite(
  f: Fixture,
  id: string,
  run: () => Promise<unknown>,
  code: string,
) {
  const before = await capture(f, id)
  await expect(run()).rejects.toThrow(exact(code))
  const after = await capture(f, id)
  expect(after).toEqual(before)
  expect(after.audit).toEqual([
    { action: 'apply', action_details: { actorId: f.admin } },
  ])
  expect(await journalRow(id)).toMatchObject({
    state: 'applied',
    released_account_ids: null,
  })
}
const accessGeneration = async (user: string) =>
  Number(
    (await query('SELECT access_generation FROM users WHERE id=$1', [user]))
      .rows[0].access_generation,
  )
/**
 * A live session and an unrevoked API token created just before a release, plus the generation and the
 * revocation watermark at that moment. Neither table is in the bound recovery snapshot, so the approved
 * digest still holds. expectRevoked() is what the release must have done to them.
 */
async function liveCredentials(f: Fixture) {
  const session = await sessionRegistry.createUserSession(f.user, {
    sessionId: randomUUID(),
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  })
  expect(session).not.toBeNull()
  const token = randomUUID()
  await query(
    `INSERT INTO multitable_api_tokens(id,name,token_hash,token_prefix,scopes,created_by,revoked) VALUES($1,'synthetic release token',$1,$1,'["records:read"]',$2,false)`,
    [token, f.user],
  )
  const live = async () => ({
    sessions: (
      await query(
        'SELECT id FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL',
        [f.user],
      )
    ).rows.map((r) => r.id),
    tokens: (
      await query(
        'SELECT id FROM multitable_api_tokens WHERE created_by=$1 AND revoked=false',
        [f.user],
      )
    ).rows.map((r) => r.id),
  })
  const liveBefore = await live()
  expect(liveBefore.sessions).toContain(session!.id)
  expect(liveBefore.tokens).toContain(token)
  const generation = await accessGeneration(f.user)
  const watermark: string | null =
    (
      await query(
        'SELECT revoked_after::text AS t FROM user_session_revocations WHERE user_id=$1',
        [f.user],
      )
    ).rows[0]?.t ?? null
  return {
    async expectRevoked() {
      expect(await live()).toEqual({ sessions: [], tokens: [] })
      expect(
        (
          await query(
            'SELECT revoked_at IS NOT NULL AS revoked FROM user_sessions WHERE id=$1',
            [session!.id],
          )
        ).rows,
      ).toEqual([{ revoked: true }])
      expect(
        (
          await query(
            'SELECT revoked,revoked_at IS NOT NULL AS stamped FROM multitable_api_tokens WHERE id=$1',
            [token],
          )
        ).rows,
      ).toEqual([{ revoked: true, stamped: true }])
      expect(await accessGeneration(f.user)).toBe(generation + 1)
      expect(
        (
          await query(
            'SELECT ($2::timestamptz IS NULL OR revoked_after > $2::timestamptz) AS advanced FROM user_session_revocations WHERE user_id=$1',
            [f.user, watermark],
          )
        ).rows,
      ).toEqual([{ advanced: true }])
    },
  }
}
/** Allowed release: one-id allowlist, nothing restored, every session and token revoked, none created, generation +1. */
async function expectAllowedRelease(
  f: Fixture,
  id: string,
  digest: string,
  mode: 'canonical' | 'termination',
  account = f.account,
) {
  const authority = async () => {
    const out: unknown[] = []
    for (const [table, key] of [
      ['user_external_auth_grants', 'local_user_id'],
      ['user_external_identities', 'local_user_id'],
      ['directory_account_links', 'local_user_id'],
      ['user_orgs', 'user_id'],
      ['user_roles', 'user_id'],
      ['user_permissions', 'user_id'],
    ])
      out.push(
        (
          await query(
            `SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${key}=$1 ORDER BY to_jsonb(t)::text`,
            [f.user],
          )
        ).rows,
      )
    out.push((await listUserPermissions(f.user, query)).sort())
    return out
  }
  const sessions = async () =>
    (
      await query('SELECT id,revoked_at FROM user_sessions WHERE user_id=$1', [
        f.user,
      ])
    ).rows
  const credentials = await liveCredentials(f)
  const before = await authority(),
    sessionsBefore = await sessions()
  // Never vacuous: at least the session created above must be there to be revoked.
  expect(sessionsBefore.length).toBeGreaterThan(0)
  await releaseWith(f, id, digest)
  expect(await journalRow(id)).toMatchObject({
    state: 'released',
    released_account_ids: [account],
    canonical_account_id: account,
  })
  expect(await authority()).toEqual(before)
  const sessionsAfter = await sessions()
  expect(sessionsAfter.map((s) => s.id).sort()).toEqual(
    sessionsBefore.map((s) => s.id).sort(),
  )
  expect(sessionsAfter.every((s) => s.revoked_at)).toBe(true)
  await credentials.expectRevoked()
  expect(
    (
      await query(
        "SELECT action,action_details FROM audit_logs WHERE resource_type='dingtalk_login_repairs' AND resource_id=$1 AND action='release'",
        [id],
      )
    ).rows,
  ).toEqual([
    { action: 'release', action_details: { actorId: f.admin, releaseMode: mode } },
  ])
}
/** A second active, activated administrator with a local password (the re-anchor approver). */
async function secondAdmin(f: Fixture) {
  const id = randomUUID()
  await query(
    `INSERT INTO users(id,username,name,password_hash,is_active,is_admin,activation_status,local_password_set) VALUES($1,$1,$1,$2,true,true,'activated',true)`,
    [id, await bcrypt.hash(f.password, 4)],
  )
  return id
}
/** Production procedure: the login app switched in place on the integration that holds the canonical row. */
async function switchLoginApp(
  f: Fixture,
  app = 'next-app',
  profile = { openId: 'next-open-' + f.user, unionId: 'new-union-' + f.user },
) {
  provider.config.mockReturnValue({
    corpId: f.corp,
    clientId: app,
    clientSecret: 'unused',
    redirectUri: 'https://example.test/callback',
  })
  await query(
    `UPDATE directory_integrations SET config = config || jsonb_build_object('appKey', $2::text) WHERE id=$1`,
    [f.source, app],
  )
  provider.profile.mockResolvedValue(profile)
  // f.verify() already called the provider once; "not called" assertions count from here.
  provider.exchange.mockClear()
}
/** Production key shape: sync writes external_key = unionId, unique per corp. */
const productionKey = (account: string) =>
  query('UPDATE directory_accounts SET external_key=union_id WHERE id=$1', [
    account,
  ])
const requestReanchor = (
  f: Fixture,
  id: string,
  approver: string,
  actor = f.admin,
  code?: string,
) => requestDingTalkRepairReanchor(id, actor, f.password, approver, code)
const previewReanchor = (f: Fixture, request: string, actor: string) =>
  previewDingTalkRepairReanchor(request, actor, f.password)
const reanchorWith = (
  f: Fixture,
  request: string,
  actor: string,
  digest: string,
) => reanchorDingTalkRepair(request, actor, f.password, digest, 'reanchor')
const repairRow = async (id: string) =>
  (await query('SELECT * FROM dingtalk_login_repairs WHERE id=$1', [id]))
    .rows[0]
const successorOf = async (id: string) =>
  (
    await query('SELECT * FROM dingtalk_login_repairs WHERE supersedes_id=$1', [
      id,
    ])
  ).rows
const auditOf = async (id: string) =>
  (
    await query(
      "SELECT action,action_details FROM audit_logs WHERE resource_type='dingtalk_login_repairs' AND resource_id=$1 ORDER BY action",
      [id],
    )
  ).rows
const identityOf = async (user: string) =>
  (
    await query(
      "SELECT to_jsonb(t) AS row FROM user_external_identities t WHERE provider='dingtalk' AND local_user_id=$1",
      [user],
    )
  ).rows
/**
 * Everything a re-anchor must not write: identity, grant, links, directory rows of the corp, membership, roles,
 * permissions, admissions, deprovision evidence, handovers and every user column except access_generation/updated_at.
 */
async function untouchedByReanchor(f: Fixture) {
  const out: Record<string, unknown> = {}
  const user = (
    await query('SELECT to_jsonb(u) AS row FROM users u WHERE id=$1', [f.user])
  ).rows[0].row as Record<string, unknown>
  delete user.access_generation
  delete user.updated_at
  out.user = user
  for (const [name, sql] of [
    ['identities', "SELECT to_jsonb(t) AS row FROM user_external_identities t WHERE local_user_id=$1 ORDER BY to_jsonb(t)::text"],
    ['grants', 'SELECT to_jsonb(t) AS row FROM user_external_auth_grants t WHERE local_user_id=$1 ORDER BY to_jsonb(t)::text'],
    ['userLinks', 'SELECT to_jsonb(t) AS row FROM directory_account_links t WHERE local_user_id=$1 ORDER BY to_jsonb(t)::text'],
    ['orgs', 'SELECT to_jsonb(t) AS row FROM user_orgs t WHERE user_id=$1 ORDER BY to_jsonb(t)::text'],
    ['roles', 'SELECT to_jsonb(t) AS row FROM user_roles t WHERE user_id=$1 ORDER BY to_jsonb(t)::text'],
    ['permissions', 'SELECT to_jsonb(t) AS row FROM user_permissions t WHERE user_id=$1 ORDER BY to_jsonb(t)::text'],
    ['admissions', 'SELECT to_jsonb(t) AS row FROM user_namespace_admissions t WHERE user_id=$1 ORDER BY to_jsonb(t)::text'],
    ['effects', 'SELECT to_jsonb(t) AS row FROM directory_deprovision_effects t WHERE local_user_id=$1 ORDER BY to_jsonb(t)::text'],
    ['events', 'SELECT to_jsonb(t) AS row FROM directory_deprovision_events t WHERE local_user_id=$1 ORDER BY to_jsonb(t)::text'],
  ])
    out[name] = (await query(sql, [f.user])).rows
  for (const [name, sql] of [
    ['accounts', 'SELECT to_jsonb(t) AS row FROM directory_accounts t WHERE corp_id=$1 ORDER BY to_jsonb(t)::text'],
    ['corpLinks', 'SELECT to_jsonb(l) AS row FROM directory_account_links l JOIN directory_accounts a ON a.id=l.directory_account_id WHERE a.corp_id=$1 ORDER BY to_jsonb(l)::text'],
    ['integrations', 'SELECT to_jsonb(t) AS row FROM directory_integrations t WHERE corp_id=$1 ORDER BY to_jsonb(t)::text'],
    ['handovers', 'SELECT to_jsonb(h) AS row FROM directory_handovers h JOIN directory_integrations i ON i.id=h.source_integration_id WHERE i.corp_id=$1 ORDER BY to_jsonb(h)::text'],
  ])
    out[name] = (await query(sql, [f.corp])).rows
  out.effective = (await listUserPermissions(f.user, query)).sort()
  return out
}
/**
 * The full dual-controlled procedure: A requests naming a fresh admin B, B previews and executes. Besides the
 * journal shape it checks what every journal transition must do: a live session and an unrevoked API token
 * created before execute are revoked, access_generation rises by exactly 1 and the watermark advances; and
 * nothing outside the journal, the generation, sessions, tokens and audit rows changes.
 */
async function reanchorFlow(f: Fixture, id: string, code?: string) {
  const approver = await secondAdmin(f),
    req = await requestReanchor(f, id, approver, f.admin, code)
  const preview = await previewReanchor(f, req.request, approver)
  expect(preview.digest).toBe(req.summary.digest)
  expect(preview).toEqual(req.summary)
  const predecessor = await repairRow(id)
  const auditBefore = await auditOf(id)
  const credentials = await liveCredentials(f)
  const untouched = await untouchedByReanchor(f)
  const done = await reanchorWith(f, req.request, approver, preview.digest)
  await credentials.expectRevoked()
  expect(await untouchedByReanchor(f)).toEqual(untouched)
  expect(done).toMatchObject({
    predecessorId: id,
    releaseMode: req.summary.reanchor.releaseMode,
    canonicalAccountId: req.summary.reanchor.canonicalAccountId,
    loginClientChanged: req.summary.reanchor.loginClientChanged,
    identityChanged: false,
    permissionsChanged: false,
    targetSessionsRevoked: true,
  })
  const ended = await repairRow(id)
  expect(ended).toMatchObject({
    state: 'superseded',
    rollback_actor_id: approver,
    supersedes_id: predecessor.supersedes_id,
    approver_id: predecessor.approver_id,
    actor_id: predecessor.actor_id,
    expected_identity: predecessor.expected_identity,
    before_identity: predecessor.before_identity,
    source_account_ids: predecessor.source_account_ids,
    canonical_account_id: predecessor.canonical_account_id,
    released_account_ids: null,
  })
  expect(ended.rolled_back_at).toBeInstanceOf(Date)
  const successors = await successorOf(id)
  expect(successors).toHaveLength(1)
  const successor = successors[0]
  const sealed = JSON.parse(decryptStoredSecretValue(req.request))
  expect(successor).toMatchObject({
    id: done.id,
    user_id: f.user,
    state: 'applied',
    supersedes_id: id,
    actor_id: f.admin,
    approver_id: approver,
    proof_nonce: sealed.nonce,
    login_client_id: provider.config().clientId,
    canonical_account_id: req.summary.reanchor.canonicalAccountId,
    source_account_ids: req.summary.reanchor.sourceAccountIds,
    expected_identity: predecessor.expected_identity,
    before_identity: predecessor.before_identity,
    released_account_ids: null,
    rollback_actor_id: null,
  })
  expect(successor.after_digest).not.toBe('pending')
  const details = {
    actorId: approver,
    preparerId: f.admin,
    approverId: approver,
    predecessorId: id,
    successorId: done.id,
    releaseMode: req.summary.reanchor.releaseMode,
    reasons: req.summary.reanchor.reasons,
    scanned: req.summary.reanchor.scanned,
  }
  expect(await auditOf(id)).toEqual(
    [...auditBefore, { action: 'superseded', action_details: details }].sort(
      (a, b) => String(a.action).localeCompare(String(b.action)),
    ),
  )
  expect(await auditOf(done.id)).toEqual([
    { action: 'reanchor', action_details: details },
  ])
  return { approver, req, preview, done, successor }
}
/** A refusal against an applied successor writes nothing; its audit is only the reanchor row. */
async function expectRefusedWithoutWriteOn(
  f: Fixture,
  id: string,
  run: () => Promise<unknown>,
  code: string,
) {
  const before = await capture(f, id)
  await expect(run()).rejects.toThrow(exact(code))
  const after = await capture(f, id)
  expect(after).toEqual(before)
  expect((after.audit as { action: string }[]).map((a) => a.action)).toEqual([
    'reanchor',
  ])
  expect(await journalRow(id)).toMatchObject({
    state: 'applied',
    released_account_ids: null,
  })
}
/** A refused re-anchor of the root writes nothing and leaves no successor. */
async function expectReanchorRefused(
  f: Fixture,
  id: string,
  run: () => Promise<unknown>,
  code: string,
) {
  await expectRefusedWithoutWrite(f, id, run, code)
  expect(await successorOf(id)).toEqual([])
}
/** The pre-apply identity of the fixture (old-open/old-union) as stored. */
const originalIdentityShape = (f: Fixture) => ({
  external_key: f.corp + ':old-open-' + f.user,
  corp_id: f.corp,
  provider_open_id: 'old-open-' + f.user,
  provider_union_id: 'old-union-' + f.user,
})
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
    expect(recovery.release).toEqual({
      mode: 'termination',
      releasedAccountIds: [f.account],
      linkedDingTalkAccountIds: [f.account],
      localLinkCount: 0,
      revocationRetained: true,
    })
    const credentials = await liveCredentials(f)
    await releaseDingTalkRepair(
      r.id,
      f.admin,
      recovery.digest,
      'release',
      f.password,
    )
    await credentials.expectRevoked()
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
    expect(await journalRow(r.id)).toMatchObject({
      released_account_ids: [f.account],
    })
    expect(
      (
        await query(
          'SELECT link_status,local_user_id FROM directory_account_links WHERE directory_account_id=$1',
          [f.account],
        )
      ).rows,
    ).toEqual([{ link_status: 'linked', local_user_id: f.user }])
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
    // Grant-off twin: termination re-verifies the recorded row too, and the integration app no longer matches.
    await query(
      'UPDATE user_external_auth_grants SET enabled=false WHERE local_user_id=$1',
      [f.user],
    )
    await expect(
      previewDingTalkRepairRecovery(r.id, f.admin, f.password, 'release'),
    ).rejects.toThrow(exact('REPAIR_HISTORICAL_SOURCE_UNVERIFIED'))
    await query(
      'UPDATE user_external_auth_grants SET enabled=true WHERE local_user_id=$1',
      [f.user],
    )
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
    expect(recovery.release).toMatchObject({
      mode: 'canonical',
      releasedAccountIds: [f.account],
    })
    await releaseDingTalkRepair(
      r.id,
      f.admin,
      recovery.digest,
      'release',
      f.password,
    )
    expect(await journalRow(r.id)).toMatchObject({
      state: 'released',
      released_account_ids: [f.account],
    })
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
    // Termination: the unbound original source is re-read and re-verified; it is the one allowed id.
    expect(recovery.release).toEqual({
      mode: 'termination',
      releasedAccountIds: [f.account],
      linkedDingTalkAccountIds: [],
      localLinkCount: 0,
      revocationRetained: true,
    })
    const membership = async () =>
      (
        await query(
          'SELECT org_id,is_active FROM user_orgs WHERE user_id=$1 ORDER BY org_id',
          [f.user],
        )
      ).rows
    const membershipBefore = await membership()
    expect(membershipBefore).toEqual([{ org_id: f.org, is_active: false }])
    const credentials = await liveCredentials(f)
    await releaseDingTalkRepair(
      r.id,
      f.admin,
      recovery.digest,
      'release',
      f.password,
    )
    await credentials.expectRevoked()
    expect(await journalRow(r.id)).toMatchObject({
      state: 'released',
      released_account_ids: [f.account],
    })
    // Nothing the revocation removed comes back.
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
        await query(
          'SELECT link_status,local_user_id FROM directory_account_links WHERE directory_account_id=$1',
          [f.account],
        )
      ).rows,
    ).toEqual([{ link_status: 'unmatched', local_user_id: null }])
    expect(await membership()).toEqual(membershipBefore)
    // The original stable id stays bindable (no OpenID anywhere, so the grant stays off); any other DingTalk source does not.
    expect(
      await bindDirectoryAccount(f.account, {
        localUserRef: f.user,
        adminUserId: f.admin,
        enableDingTalkGrant: false,
      }),
    ).toBeTruthy()
    const second = await addAccount(f.source, f.corp, 'second-' + f.user, {
      union: 'new-union-' + f.user,
    })
    await expect(link(second, f.user)).rejects.toMatchObject({
      code: '55000',
      message: 'repair blocks a second directory source',
    })
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
      expect(preview.release).toMatchObject({
        mode: disabled ? 'termination' : 'canonical',
        releasedAccountIds: [f.account],
        linkedDingTalkAccountIds: [f.account],
      })
      const credentials = await liveCredentials(f)
      await releaseDingTalkRepair(
        r.id,
        f.admin,
        preview.digest,
        'release',
        f.password,
      )
      await credentials.expectRevoked()
      expect(await journalRow(r.id)).toMatchObject({
        state: 'released',
        released_account_ids: [f.account],
      })
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

  describe('POST /api/auth/password/change across a repair rollback', () => {
    const app = express()
    app.use(express.json())
    app.use('/api/auth', authRouter)
    const newPassword = 'SyntheticRotated-Only!58'
    const changePassword = (token: string) =>
      request(app)
        .post('/api/auth/password/change')
        .set('authorization', `Bearer ${token}`)
        .send({ password: newPassword })
    const activeSessions = async (user: string) =>
      (
        await query(
          'SELECT id FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL',
          [user],
        )
      ).rows
    const generation = async (user: string) =>
      Number(
        (
          await query('SELECT access_generation FROM users WHERE id=$1', [
            user,
          ])
        ).rows[0].access_generation,
      )
    const requirePasswordChange = (user: string) =>
      query('UPDATE users SET must_change_password=true WHERE id=$1', [user])
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
    // Parks the request after authentication (generation already read) and after the password write,
    // before the session write. The first tenant lookup is token verification's; the second is the
    // session re-issuance's, reached only once the new password and the revocation watermark are committed.
    const parkBeforeSession = (user: string) => {
      let entered!: () => void, resume!: () => void
      const reached = new Promise<void>((resolve) => {
          entered = resolve
        }),
        released = new Promise<void>((resolve) => {
          resume = resolve
        })
      const real = authService.resolveSessionTenantId.bind(authService)
      let calls = 0
      const spy = vi
        .spyOn(authService, 'resolveSessionTenantId')
        .mockImplementation(async (...args) => {
          const result = await real(...args)
          if (++calls === 2) {
            entered()
            await released
          }
          return result
        })
      const parkedAfterPasswordWrite = async () =>
        (
          await query('SELECT must_change_password FROM users WHERE id=$1', [
            user,
          ])
        ).rows[0].must_change_password === false
      return { reached, resume, spy, parkedAfterPasswordWrite }
    }

    it('a credential authenticated before the generation moves cannot obtain a session; a later normal change still can', async () => {
      await withDbTokenVerification(async () => {
        const f = await fixture(),
          proof = await f.verify(),
          p = await previewDingTalkRepair(proof)
        const r = await applyDingTalkRepair(proof, p.digest, 'apply')
        await requirePasswordChange(f.user)
        // JWT iat has second precision: a login in the same second as apply's revocation would be dead.
        await new Promise((resolve) => setTimeout(resolve, 1100))
        const login = await authService.login(f.user, f.password)
        expect(login?.user.must_change_password).toBe(true)
        const before = await generation(f.user)
        const park = parkBeforeSession(f.user)
        const pending = changePassword(login!.token).then((res) => res)
        try {
          await park.reached
          expect(await park.parkedAfterPasswordWrite()).toBe(true)
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
          expect(await generation(f.user)).toBeGreaterThan(before)
          park.resume()
          const res = await pending
          expect(res.status).toBe(409)
          expect(res.body).toEqual({
            success: false,
            error:
              'Authentication changed; please sign in again with the new password',
            code: 'authentication_changed',
          })
          expect(await activeSessions(f.user)).toHaveLength(0)
          expect(await authService.verifyToken(login!.token)).toBeNull()
        } finally {
          park.resume()
          await pending.catch(() => undefined)
          park.spy.mockRestore()
        }
        // The password change itself stayed committed: the old password is refused, the new one works.
        expect(await authService.login(f.user, f.password)).toBeNull()
        const next = await authService.login(f.user, newPassword)
        expect(next?.user.id).toBe(f.user)
        expect(next?.user.must_change_password).toBe(false)

        // A normal forced change on the moved generation still returns a usable token.
        await requirePasswordChange(f.user)
        await new Promise((resolve) => setTimeout(resolve, 1100))
        const again = await authService.login(f.user, newPassword)
        expect(again?.user.must_change_password).toBe(true)
        expect(await generation(f.user)).toBeGreaterThan(before)
        const slow = parkBeforeSession(f.user)
        const normal = changePassword(again!.token).then((res) => res)
        try {
          await slow.reached
          expect(await slow.parkedAfterPasswordWrite()).toBe(true)
          // JWT iat has second precision: a token minted now would postdate the revocation watermark.
          await new Promise((resolve) => setTimeout(resolve, 1100))
          slow.resume()
          const ok = await normal
          expect(ok.status).toBe(200)
          expect(ok.body.data.passwordChangeRequired).toBe(false)
          const sid = authService.readTokenPayload(ok.body.data.token)?.sid
          expect((await activeSessions(f.user)).map((row) => row.id)).toContain(
            sid,
          )
          expect((await authService.verifyToken(ok.body.data.token))?.id).toBe(
            f.user,
          )
        } finally {
          slow.resume()
          await normal.catch(() => undefined)
          slow.spy.mockRestore()
        }
      })
    })
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
        // Each waiter runs its own deadlock check deadlock_timeout (1s) after it starts waiting, and the
        // first to run it is the victim. Apply is the victim only if the holder enqueues after apply's wait
        // starts (so apply's check fires first) and before that check runs. Closing the cycle at the
        // midpoint leaves about half a second on each side; closing it at once lets timer jitter pick the holder.
        await new Promise((resolve) => setTimeout(resolve, 500))
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
        `INSERT INTO dingtalk_login_repairs(id,user_id,proof_nonce,state,before_identity,expected_identity,after_digest,actor_id,source_account_ids,source_integration_ids,canonical_account_id,login_client_id) SELECT $2::uuid,user_id,COALESCE($3::uuid,proof_nonce),$4,before_identity,expected_identity,after_digest,actor_id,source_account_ids,source_integration_ids,canonical_account_id,login_client_id FROM dingtalk_login_repairs WHERE id=$1`,
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

  describe('release writes exactly one re-verified DingTalk source', () => {
    it('normal release: canonical mode, the recorded source is the one allowed id and nothing is restored', async () => {
      const f = await fixture(),
        r = await applyRepair(f)
      expect(await journalRow(r.id)).toMatchObject({
        source_account_ids: [f.account],
        source_integration_ids: [f.source],
        canonical_account_id: f.account,
      })
      expect(
        await sessionRegistry.createUserSession(f.user, {
          sessionId: randomUUID(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        }),
      ).not.toBeNull()
      const preview = await releasePreview(f, r.id)
      expect(preview.release).toEqual({
        mode: 'canonical',
        releasedAccountIds: [f.account],
        linkedDingTalkAccountIds: [f.account],
        localLinkCount: 0,
        revocationRetained: false,
      })
      await expectAllowedRelease(f, r.id, preview.digest, 'canonical')
      expect(
        (
          await query(
            'SELECT provider_union_id FROM user_external_identities WHERE local_user_id=$1',
            [f.user],
          )
        ).rows[0].provider_union_id,
      ).toBe('new-union-' + f.user)
    })

    it('termination then full login recovery when the directory row stores an OpenID', async () => {
      const f = await fixture(),
        r = await applyRepair(f)
      await unbindDirectoryAccount(f.account, {
        adminUserId: f.admin,
        disableDingTalkGrant: true,
      })
      const preview = await releasePreview(f, r.id)
      expect(preview.release).toMatchObject({
        mode: 'termination',
        releasedAccountIds: [f.account],
      })
      await expectAllowedRelease(f, r.id, preview.digest, 'termination')
      expect(
        await bindDirectoryAccount(f.account, {
          localUserRef: f.user,
          adminUserId: f.admin,
          enableDingTalkGrant: true,
        }),
      ).toBeTruthy()
      expect((await exchangeCodeForUser('same-person')).localUserId).toBe(
        f.user,
      )
      const second = await addAccount(f.source, f.corp, 'second-' + f.user, {
        union: 'new-union-' + f.user,
      })
      await expect(link(second, f.user)).rejects.toMatchObject({
        code: '55000',
      })
    })

    it('an inactive original source terminates without being reactivated', async () => {
      const f = await fixture(),
        r = await applyRepair(f)
      await query('UPDATE directory_accounts SET is_active=false WHERE id=$1', [
        f.account,
      ])
      await query(
        'UPDATE user_external_auth_grants SET enabled=false WHERE local_user_id=$1',
        [f.user],
      )
      const preview = await releasePreview(f, r.id)
      expect(preview.release).toMatchObject({
        mode: 'termination',
        releasedAccountIds: [f.account],
      })
      await expectAllowedRelease(f, r.id, preview.digest, 'termination')
      expect(
        (
          await query('SELECT is_active FROM directory_accounts WHERE id=$1', [
            f.account,
          ])
        ).rows[0].is_active,
      ).toBe(false)
      expect(
        (
          await query(
            'SELECT enabled FROM user_external_auth_grants WHERE local_user_id=$1',
            [f.user],
          )
        ).rows[0].enabled,
      ).toBe(false)
    })

    it.each([
      ['deactivated', 'UPDATE users SET is_active=false WHERE id=$1'],
      ['recycled', 'UPDATE users SET deleted_at=now() WHERE id=$1'],
    ])(
      'a %s user takes termination and keeps the user flags',
      async (_name, sql) => {
        const f = await fixture(),
          r = await applyRepair(f)
        await query(sql, [f.user])
        const flags = async () =>
          (
            await query(
              'SELECT is_active,deleted_at,purged_at,activation_status FROM users WHERE id=$1',
              [f.user],
            )
          ).rows[0]
        const flagsBefore = await flags()
        const preview = await releasePreview(f, r.id)
        expect(preview.release).toMatchObject({
          mode: 'termination',
          releasedAccountIds: [f.account],
        })
        await expectAllowedRelease(f, r.id, preview.digest, 'termination')
        expect(await flags()).toEqual(flagsBefore)
      },
    )

    // Release still refuses these v1 dead ends; the separate re-anchor verb exits them ('controlled re-anchoring', R1-R5).
    it('a deleted original source refuses REPAIR_HISTORICAL_SOURCE_UNVERIFIED at preview and execute (v1 dead end)', async () => {
      const f = await fixture(),
        r = await applyRepair(f)
      await unbindDirectoryAccount(f.account, {
        adminUserId: f.admin,
        disableDingTalkGrant: true,
      })
      const preview = await releasePreview(f, r.id)
      await query('DELETE FROM directory_accounts WHERE id=$1', [f.account])
      await expect(releasePreview(f, r.id)).rejects.toThrow(
        exact('REPAIR_HISTORICAL_SOURCE_UNVERIFIED'),
      )
      await expectRefusedWithoutWrite(
        f,
        r.id,
        () => releaseWith(f, r.id, preview.digest),
        'REPAIR_HISTORICAL_SOURCE_UNVERIFIED',
      )
      await expect(
        previewDingTalkRepairRecovery(r.id, f.admin, f.password, 'rollback'),
      ).rejects.toThrow(exact('REPAIR_TARGET_NOT_ENABLED'))
    })

    it.each([false, true])(
      'a changed login application refuses REPAIR_LOGIN_SCOPE_CHANGED at preview and execute (revoked=%s)',
      async (revoked) => {
        const f = await fixture(),
          r = await applyRepair(f)
        if (revoked)
          await query(
            'UPDATE user_external_auth_grants SET enabled=false WHERE local_user_id=$1',
            [f.user],
          )
        const preview = await releasePreview(f, r.id)
        expect(preview.release?.mode).toBe(revoked ? 'termination' : 'canonical')
        provider.config.mockReturnValue({
          corpId: f.corp,
          clientId: 'other-app',
        })
        await expect(releasePreview(f, r.id)).rejects.toThrow(
          exact('REPAIR_LOGIN_SCOPE_CHANGED'),
        )
        await expectRefusedWithoutWrite(
          f,
          r.id,
          () => releaseWith(f, r.id, preview.digest),
          'REPAIR_LOGIN_SCOPE_CHANGED',
        )
      },
    )

    it('a changed login enterprise refuses REPAIR_LOGIN_SCOPE_CHANGED', async () => {
      const f = await fixture(),
        r = await applyRepair(f)
      provider.config.mockReturnValue({
        corpId: 'other-corp',
        clientId: 'synthetic-current-app',
      })
      await expect(releasePreview(f, r.id)).rejects.toThrow(
        exact('REPAIR_LOGIN_SCOPE_CHANGED'),
      )
    })

    it.each([
      ['another person', 'UPDATE directory_accounts SET union_id=$2 WHERE id=$1', 'different-person'],
      ['another enterprise', 'UPDATE directory_accounts SET corp_id=$2 WHERE id=$1', 'other-corp'],
      ['no UnionID', 'UPDATE directory_accounts SET union_id=NULL WHERE id=$1', null],
    ])(
      'a historical source now naming %s refuses REPAIR_HISTORICAL_SOURCE_UNVERIFIED without writing',
      async (_name, sql, value) => {
        const f = await fixture(),
          r = await applyRepair(f)
        await query(
          'UPDATE user_external_auth_grants SET enabled=false WHERE local_user_id=$1',
          [f.user],
        )
        await query(sql, value === null ? [f.account] : [f.account, value])
        await expectRefusedWithoutWrite(
          f,
          r.id,
          () => releasePreview(f, r.id),
          'REPAIR_HISTORICAL_SOURCE_UNVERIFIED',
        )
      },
    )

    it('a journal source re-linked to another user refuses REPAIR_DIRECTORY_OWNER_CONFLICT at preview and execute', async () => {
      const f = await fixture(),
        other = await bareUser(),
        r = await applyRepair(f)
      await unbindDirectoryAccount(f.account, {
        adminUserId: f.admin,
        disableDingTalkGrant: true,
      })
      const preview = await releasePreview(f, r.id)
      await query(
        "UPDATE directory_account_links SET link_status='linked',local_user_id=$2 WHERE directory_account_id=$1",
        [f.account, other],
      )
      await expect(releasePreview(f, r.id)).rejects.toThrow(
        exact('REPAIR_DIRECTORY_OWNER_CONFLICT'),
      )
      await expectRefusedWithoutWrite(
        f,
        r.id,
        () => releaseWith(f, r.id, preview.digest),
        'REPAIR_DIRECTORY_OWNER_CONFLICT',
      )
    })

    it('a journal source of a different person later linked to another user refuses REPAIR_DIRECTORY_OWNER_CONFLICT', async () => {
      // Not visible to the corp-wide person query (different UnionID); only the journal re-read sees it.
      const f = await fixture(),
        other = await bareUser(),
        stale = await addAccount(f.source, f.corp, 'stale-' + f.user, {
          union: 'different-person',
          active: false,
        })
      await link(stale, f.user)
      const r = await applyRepair(f)
      expect((await journalRow(r.id)).source_account_ids.sort()).toEqual(
        [f.account, stale].sort(),
      )
      await query(
        'UPDATE directory_account_links SET local_user_id=$2 WHERE directory_account_id=$1',
        [stale, other],
      )
      await expectRefusedWithoutWrite(
        f,
        r.id,
        () => releasePreview(f, r.id),
        'REPAIR_DIRECTORY_OWNER_CONFLICT',
      )
    })

    it.each([
      ['linked', 'manual_admin'],
      ['pending', 'email'],
    ])(
      'a same-person row outside the journal %s to another user refuses REPAIR_DIRECTORY_OWNER_CONFLICT',
      async (status, strategy) => {
        const f = await fixture(),
          other = await bareUser(),
          r = await applyRepair(f)
        await query(
          'UPDATE user_external_auth_grants SET enabled=false WHERE local_user_id=$1',
          [f.user],
        )
        const twin = await addAccount(f.source, f.corp, 'twin-' + f.user, {
          union: 'new-union-' + f.user,
        })
        await link(twin, other, status, strategy)
        await expectRefusedWithoutWrite(
          f,
          r.id,
          () => releasePreview(f, r.id),
          'REPAIR_DIRECTORY_OWNER_CONFLICT',
        )
      },
    )

    it('another user holding this person\'s DingTalk identity refuses REPAIR_IDENTITY_CONFLICT at preview and execute', async () => {
      const f = await fixture(),
        other = await bareUser(),
        r = await applyRepair(f)
      await unbindDirectoryAccount(f.account, {
        adminUserId: f.admin,
        disableDingTalkGrant: true,
      })
      const preview = await releasePreview(f, r.id)
      await query(
        `INSERT INTO user_external_identities(provider,external_key,local_user_id,corp_id,provider_open_id,provider_union_id) VALUES('dingtalk',$1,$2,$3,'x',$4)`,
        [f.corp + ':x', other, f.corp, 'new-union-' + f.user],
      )
      await expect(releasePreview(f, r.id)).rejects.toThrow(
        exact('REPAIR_IDENTITY_CONFLICT'),
      )
      await expectRefusedWithoutWrite(
        f,
        r.id,
        () => releaseWith(f, r.id, preview.digest),
        'REPAIR_IDENTITY_CONFLICT',
      )
    })

    it.each([false, true])(
      'a duplicate same-person journal row must be unbound first and is never chosen (grant disabled=%s)',
      async (disabled) => {
        const f = await fixture(),
          dup = await addAccount(f.source, f.corp, 'dup-' + f.user, {
            union: 'new-union-' + f.user,
            active: false,
          })
        await link(dup, f.user)
        const r = await applyRepair(f)
        expect(await journalRow(r.id)).toMatchObject({
          canonical_account_id: f.account,
        })
        expect((await journalRow(r.id)).source_account_ids.sort()).toEqual(
          [f.account, dup].sort(),
        )
        if (disabled)
          await query(
            'UPDATE user_external_auth_grants SET enabled=false WHERE local_user_id=$1',
            [f.user],
          )
        await expectRefusedWithoutWrite(
          f,
          r.id,
          () => releasePreview(f, r.id),
          'REPAIR_SOURCE_OUTSIDE_ALLOWLIST',
        )
        await unbindDirectoryAccount(dup, { adminUserId: f.admin })
        // Unbinding a same-UnionID row deletes the identity: release now terminates.
        const preview = await releasePreview(f, r.id)
        expect(preview.release).toMatchObject({
          mode: 'termination',
          releasedAccountIds: [f.account],
          linkedDingTalkAccountIds: [f.account],
        })
        await expectAllowedRelease(f, r.id, preview.digest, 'termination')
        await expect(link(dup, f.user)).rejects.toMatchObject({ code: '55000' })
      },
    )

    it('with the recorded source unbound and the duplicate still linked, release never moves the allowlist to the duplicate', async () => {
      const f = await fixture(),
        dup = await addAccount(f.source, f.corp, 'dup-' + f.user, {
          union: 'new-union-' + f.user,
          active: false,
        })
      await link(dup, f.user)
      const r = await applyRepair(f)
      await unbindDirectoryAccount(f.account, {
        adminUserId: f.admin,
        disableDingTalkGrant: true,
      })
      await expectRefusedWithoutWrite(
        f,
        r.id,
        () => releasePreview(f, r.id),
        'REPAIR_SOURCE_OUTSIDE_ALLOWLIST',
      )
    })

    it.each([false, true])(
      'an inactive old-application linked row outside the allowlist refuses until it is unbound (grant disabled=%s)',
      async (disabled) => {
        const f = await fixture(),
          old = randomUUID(),
          oldAccount = randomUUID()
        await query(
          `INSERT INTO directory_integrations(id,name,provider,corp_id,org_id,config,status) VALUES($1::uuid,$1::text,'dingtalk',$2,$3,'{"appKey":"old-app","appSecret":"synthetic-no-network","rootDeptId":1}','active')`,
          [old, f.corp, f.org],
        )
        await query(
          `INSERT INTO directory_accounts(id,integration_id,corp_id,external_user_id,external_key,union_id,is_active,name) VALUES($1,$2,$3,$4,$4,$5,false,'Synthetic old linked source')`,
          [oldAccount, old, f.corp, 'old-' + f.user, 'new-union-' + f.user],
        )
        await link(oldAccount, f.user)
        const r = await applyRepair(f)
        if (disabled)
          await query(
            'UPDATE user_external_auth_grants SET enabled=false WHERE local_user_id=$1',
            [f.user],
          )
        await expectRefusedWithoutWrite(
          f,
          r.id,
          () => releasePreview(f, r.id),
          'REPAIR_SOURCE_OUTSIDE_ALLOWLIST',
        )
        await unbindDirectoryAccount(oldAccount, { adminUserId: f.admin })
        const preview = await releasePreview(f, r.id)
        expect(preview.release).toMatchObject({
          mode: 'termination',
          releasedAccountIds: [f.account],
          linkedDingTalkAccountIds: [f.account],
        })
        await expectAllowedRelease(f, r.id, preview.digest, 'termination')
        const member = {
          userId: 'old-' + f.user,
          unionId: 'new-union-' + f.user,
          name: 'Synthetic old linked source',
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
        // The unbind deleted the identity, so a real sync of the old source finds nobody to match and
        // leaves the admin-unbound row alone; an explicit link of it is what the fence must still refuse.
        await syncDirectoryIntegration(old, 'synthetic-test')
        expect(
          (
            await query(
              'SELECT link_status,local_user_id FROM directory_account_links WHERE directory_account_id=$1',
              [oldAccount],
            )
          ).rows,
        ).toEqual([{ link_status: 'unmatched', local_user_id: null }])
        await expect(link(oldAccount, f.user)).rejects.toMatchObject({
          code: '55000',
        })
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

    it('database CHECKs reject an empty, NULL, NULL-element or wrong-id allowlist and a canonical id outside the sources', async () => {
      const f = await fixture(),
        r = await applyRepair(f)
      const copy = (o: { canonical?: string; released?: unknown }) =>
        query(
          `INSERT INTO dingtalk_login_repairs(id,user_id,proof_nonce,state,before_identity,expected_identity,after_digest,actor_id,source_account_ids,source_integration_ids,canonical_account_id,login_client_id,released_account_ids) SELECT $2::uuid,user_id,$3::uuid,$4,before_identity,expected_identity,after_digest,actor_id,source_account_ids,source_integration_ids,COALESCE($5::uuid,canonical_account_id),login_client_id,$6::uuid[] FROM dingtalk_login_repairs WHERE id=$1`,
          [
            r.id,
            randomUUID(),
            randomUUID(),
            'canonical' in o ? 'rolled_back' : 'released',
            o.canonical ?? null,
            o.released ?? null,
          ],
        )
      for (const released of ['{}', '{NULL}', null, [randomUUID()]])
        await expect(copy({ released })).rejects.toMatchObject({
          code: '23514',
        })
      await expect(copy({ canonical: randomUUID() })).rejects.toMatchObject({
        code: '23514',
      })
      await expect(
        query(
          "UPDATE dingtalk_login_repairs SET state='released',released_account_ids='{}' WHERE id=$1",
          [r.id],
        ),
      ).rejects.toMatchObject({ code: '23514' })
      await expect(
        query(
          'UPDATE dingtalk_login_repairs SET released_account_ids=ARRAY[$2::uuid] WHERE id=$1',
          [r.id, f.account],
        ),
      ).rejects.toMatchObject({ code: '23514' })
      expect(await journalRow(r.id)).toMatchObject({
        state: 'applied',
        released_account_ids: null,
      })
      // Positive control: the same copy with the one canonical id is accepted.
      await expect(copy({ released: [f.account] })).resolves.toBeDefined()
    })
  })

  describe('directory evidence needs a stored UnionID and one current-application witness', () => {
    it('a NULL directory UnionID refuses before the provider exchange', async () => {
      const f = await fixture()
      await query('UPDATE directory_accounts SET union_id=NULL WHERE id=$1', [
        f.account,
      ])
      const graph = await f.graph()
      await expect(f.verify()).rejects.toThrow(
        exact('REPAIR_DIRECTORY_UNION_ID_REQUIRED'),
      )
      expect(provider.exchange).not.toHaveBeenCalled()
      expect(await f.graph()).toEqual(graph)
      expect(
        (
          await query('SELECT id FROM dingtalk_login_repairs WHERE user_id=$1', [
            f.user,
          ])
        ).rows,
      ).toHaveLength(0)
    })

    it('a same-application same-OpenID directory row without a UnionID is not person evidence', async () => {
      const f = await fixture()
      await query('UPDATE directory_accounts SET union_id=NULL WHERE id=$1', [
        f.account,
      ])
      // The fixture's directory OpenID equals the scanned profile's OpenID, in the login application.
      expect(
        (
          await query('SELECT open_id FROM directory_accounts WHERE id=$1', [
            f.account,
          ])
        ).rows[0].open_id,
      ).toBe('new-open-' + f.user)
      await expect(f.verify()).rejects.toThrow(
        exact('REPAIR_DIRECTORY_UNION_ID_REQUIRED'),
      )
    })

    it('a UnionID removed between verify and apply refuses REPAIR_SNAPSHOT_CHANGED', async () => {
      const f = await fixture(),
        proof = await f.verify(),
        p = await previewDingTalkRepair(proof)
      await query('UPDATE directory_accounts SET union_id=NULL WHERE id=$1', [
        f.account,
      ])
      await expect(applyDingTalkRepair(proof, p.digest, 'apply')).rejects.toThrow(
        exact('REPAIR_SNAPSHOT_CHANGED'),
      )
      expect(
        (
          await query('SELECT id FROM dingtalk_login_repairs WHERE user_id=$1', [
            f.user,
          ])
        ).rows,
      ).toHaveLength(0)
    })

    it('a stored UnionID with no directory OpenID verifies, applies and releases', async () => {
      const f = await fixture()
      await query('UPDATE directory_accounts SET open_id=NULL WHERE id=$1', [
        f.account,
      ])
      const proof = await f.verify(),
        p = await previewDingTalkRepair(proof)
      expect(p.canonicalAccountId).toBe(f.account)
      const r = await applyDingTalkRepair(proof, p.digest, 'apply')
      const preview = await releasePreview(f, r.id)
      expect(preview.release).toMatchObject({
        mode: 'canonical',
        releasedAccountIds: [f.account],
      })
      await expectAllowedRelease(f, r.id, preview.digest, 'canonical')
    })

    it.each([
      ['linked to the target with another UnionID', 'different-person', 'target', 'REPAIR_DIRECTORY_PERSON_AMBIGUOUS'],
      ['linked to another user', 'different-person', 'other', 'REPAIR_DIRECTORY_OWNER_CONFLICT'],
      ['unlinked', 'different-person', null, null],
      ['the same person linked to the target', 'same', 'target', null],
    ] as const)(
      'a cross-application directory row with the scanned OpenID, %s',
      async (_name, union, owner, code) => {
        const f = await fixture(),
          other = await bareUser(),
          xapp = await addIntegration(f, 'other-app'),
          account = await addAccount(xapp, f.corp, 'xapp-' + f.user, {
            union: union === 'same' ? 'new-union-' + f.user : union,
            open: 'new-open-' + f.user,
          })
        if (owner) await link(account, owner === 'target' ? f.user : other)
        if (code) {
          await expect(f.verify()).rejects.toThrow(exact(code))
          return
        }
        const p = await previewDingTalkRepair(await f.verify())
        expect(p.canonicalAccountId).toBe(f.account)
        const r = await applyRepair(f)
        expect(await journalRow(r.id)).toMatchObject({
          canonical_account_id: f.account,
        })
        if (owner === null) {
          expect(await journalRow(r.id)).toMatchObject({
            source_account_ids: [f.account],
          })
          return
        }
        // Same person in another application: not a second witness, but still a linked row outside the allowlist.
        await expectRefusedWithoutWrite(
          f,
          r.id,
          () => releasePreview(f, r.id),
          'REPAIR_SOURCE_OUTSIDE_ALLOWLIST',
        )
      },
    )

    it('two active current-application witnesses refuse REPAIR_CANONICAL_SOURCE_REQUIRED after the exchange', async () => {
      const f = await fixture(),
        twin = await addAccount(f.source, f.corp, 'twin-' + f.user, {
          union: 'new-union-' + f.user,
        })
      await link(twin, f.user)
      await expect(f.verify()).rejects.toThrow(
        exact('REPAIR_CANONICAL_SOURCE_REQUIRED'),
      )
      expect(provider.exchange).toHaveBeenCalled()
      expect(
        (
          await query('SELECT id FROM dingtalk_login_repairs WHERE user_id=$1', [
            f.user,
          ])
        ).rows,
      ).toHaveLength(0)
    })

    it('a verified OAuth OpenID rotation does not block a canonical release over the stale directory OpenID', async () => {
      const f = await fixture(),
        r = await applyRepair(f)
      provider.profile.mockResolvedValue({
        openId: 'rotated-' + f.user,
        unionId: 'new-union-' + f.user,
      })
      expect((await exchangeCodeForUser('fresh-rotation')).localUserId).toBe(
        f.user,
      )
      expect(
        (
          await query('SELECT open_id FROM directory_accounts WHERE id=$1', [
            f.account,
          ])
        ).rows[0].open_id,
      ).toBe('new-open-' + f.user)
      const preview = await releasePreview(f, r.id)
      expect(preview.release).toMatchObject({
        mode: 'canonical',
        releasedAccountIds: [f.account],
      })
      await expectAllowedRelease(f, r.id, preview.digest, 'canonical')
    })
  })

  describe('local directory links stay outside the DingTalk source chain', () => {
    it('a local link present before verify is not identity evidence but stays in the approval snapshot', async () => {
      const f = await fixture(),
        local = await localSource(f)
      const r = await applyRepair(f)
      expect(await journalRow(r.id)).toMatchObject({
        source_account_ids: [f.account],
        source_integration_ids: [f.source],
        canonical_account_id: f.account,
      })
      await query('UPDATE directory_accounts SET is_active=false WHERE id=$1', [
        local.account,
      ])
      const rollback = await previewDingTalkRepairRecovery(
        r.id,
        f.admin,
        f.password,
        'rollback',
      )
      expect(rollback.changedSections).toContain('sources')
    })

    it('a local link added after apply passes the fence; a second DingTalk link does not', async () => {
      const f = await fixture()
      await applyRepair(f)
      await expect(localSource(f)).resolves.toBeDefined()
      const second = await addAccount(f.source, f.corp, 'second-' + f.user, {
        union: 'new-union-' + f.user,
      })
      await expect(link(second, f.user)).rejects.toMatchObject({
        code: '55000',
        message: 'repair blocks a second directory source',
      })
    })

    it('release with a local link present, then later local changes, while DingTalk stays fenced', async () => {
      const f = await fixture(),
        r = await applyRepair(f),
        local = await localSource(f)
      const preview = await releasePreview(f, r.id)
      expect(preview.release).toEqual({
        mode: 'canonical',
        releasedAccountIds: [f.account],
        linkedDingTalkAccountIds: [f.account],
        localLinkCount: 1,
        revocationRetained: false,
      })
      await expectAllowedRelease(f, r.id, preview.digest, 'canonical')
      await expect(
        query(
          "UPDATE directory_account_links SET review_note='Synthetic local change' WHERE directory_account_id=$1",
          [local.account],
        ),
      ).resolves.toBeDefined()
      const otherOrg = 'login-repair-org-local-' + randomUUID()
      await expect(localSource(f, otherOrg)).resolves.toBeDefined()
      const second = await addAccount(f.source, f.corp, 'second-' + f.user, {
        union: 'new-union-' + f.user,
      })
      await expect(link(second, f.user)).rejects.toMatchObject({
        code: '55000',
      })
    })

    it('the directory guard decides by the real account row; a missing row fails closed', async () => {
      const f = await fixture()
      const r = await applyRepair(f)
      await expect(link(randomUUID(), f.user)).rejects.toMatchObject({
        code: '55000',
      })
      const outside = await addAccount(f.source, f.corp, 'outside-' + f.user, {
        union: 'new-union-' + f.user,
      })
      await expect(link(outside, f.user)).rejects.toMatchObject({
        code: '55000',
      })
      await expect(localSource(f)).resolves.toBeDefined()
      // The link row's own columns are request fields: a DingTalk account written with every link value a local
      // writer uses (local-directory-org.ts: 'local_explicit', no reviewer, no note) is still fenced, and a local
      // account written with DingTalk-looking values still passes. Only directory_accounts.provider decides.
      const localWriterShape = (account: string) =>
        query(
          `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy, created_at, updated_at)
           VALUES ($1, $2, 'linked', 'local_explicit', NOW(), NOW())
           ON CONFLICT (directory_account_id) DO UPDATE SET local_user_id = EXCLUDED.local_user_id, link_status = EXCLUDED.link_status, match_strategy = EXCLUDED.match_strategy, updated_at = NOW()`,
          [account, f.user],
        )
      const forged = async (tag: string) => {
        const fresh = async (shape: string) =>
          addAccount(f.source, f.corp, `${tag}-${shape}-${f.user}`, {
            union: 'new-union-' + f.user,
          })
        const refused = { code: '55000', message: 'repair blocks a second directory source' }
        // Plain INSERT with the local strategy and a reviewer/note.
        const w1 = await fresh('w1')
        await expect(
          query(
            `INSERT INTO directory_account_links(id,directory_account_id,local_user_id,link_status,match_strategy,reviewed_by,review_note,created_at,updated_at) VALUES(gen_random_uuid(),$1,$2,'linked','local_explicit',$3,'probe',now(),now())`,
            [w1, f.user, f.admin],
          ),
        ).rejects.toMatchObject(refused)
        // The local writer's exact statement, as an INSERT.
        await expect(localWriterShape(await fresh('w2'))).rejects.toMatchObject(refused)
        // pending -> linked UPDATE that also switches the strategy to the local one.
        const w4 = await fresh('w4')
        await link(w4, f.user, 'pending', 'email')
        await expect(
          query(
            "UPDATE directory_account_links SET link_status='linked',match_strategy='local_explicit',reviewed_by=NULL,review_note=NULL WHERE directory_account_id=$1",
            [w4],
          ),
        ).rejects.toMatchObject(refused)
        // An unmatched row taken over by the ON CONFLICT upserts (the suite's and the local writer's).
        const w7 = await fresh('w7')
        await query(
          "INSERT INTO directory_account_links(directory_account_id,local_user_id,link_status,match_strategy) VALUES($1,NULL,'unmatched',NULL)",
          [w7],
        )
        await expect(link(w7, f.user, 'linked', 'local_explicit')).rejects.toMatchObject(refused)
        await expect(localWriterShape(w7)).rejects.toMatchObject(refused)
        expect(
          (
            await query(
              "SELECT directory_account_id FROM directory_account_links WHERE local_user_id=$1 AND link_status='linked' AND directory_account_id=ANY($2::uuid[])",
              [f.user, [w1, w4, w7]],
            )
          ).rows,
        ).toEqual([])
      }
      const localWithDingTalkValues = async () => {
        const local = await localSource(f, 'login-repair-org-forge-' + randomUUID())
        // Re-link the existing local row with DingTalk strategies through the upsert and a plain UPDATE.
        for (const strategy of ['manual_admin', 'auto_external_key', 'email'])
          await expect(link(local.account, f.user, 'linked', strategy)).resolves.toBeDefined()
        await expect(
          query(
            "UPDATE directory_account_links SET match_strategy='manual_admin',reviewed_by=$2,review_note='probe' WHERE directory_account_id=$1",
            [local.account, f.admin],
          ),
        ).resolves.toBeDefined()
        // A fresh local account in the same integration linked by a plain INSERT with a DingTalk strategy.
        const second = randomUUID()
        await query(
          `INSERT INTO directory_accounts(id,integration_id,provider,corp_id,external_user_id,external_key,name,is_active) VALUES($1,$2,'local',NULL,$3,$3,'Synthetic local member',true)`,
          [second, local.integration, 'forge-' + second],
        )
        await expect(
          query(
            `INSERT INTO directory_account_links(directory_account_id,local_user_id,link_status,match_strategy,reviewed_by,review_note) VALUES($1,$2,'linked','manual_admin',$3,'probe')`,
            [second, f.user, f.admin],
          ),
        ).resolves.toBeDefined()
      }
      await forged('applied')
      await localWithDingTalkValues()
      const preview = await releasePreview(f, r.id)
      expect(preview.release?.mode).toBe('canonical')
      await releaseWith(f, r.id, preview.digest)
      expect(await journalRow(r.id)).toMatchObject({ state: 'released' })
      await forged('released')
      await localWithDingTalkValues()
    })

    it('termination with a local link present keeps the local link untouched', async () => {
      const f = await fixture(),
        local = await localSource(f),
        r = await applyRepair(f)
      await unbindDirectoryAccount(f.account, {
        adminUserId: f.admin,
        disableDingTalkGrant: true,
      })
      const localLink = async () =>
        (
          await query(
            'SELECT to_jsonb(l) AS row FROM directory_account_links l WHERE directory_account_id=$1',
            [local.account],
          )
        ).rows
      const localBefore = await localLink()
      const preview = await releasePreview(f, r.id)
      expect(preview.release).toEqual({
        mode: 'termination',
        releasedAccountIds: [f.account],
        linkedDingTalkAccountIds: [],
        localLinkCount: 1,
        revocationRetained: true,
      })
      await expectAllowedRelease(f, r.id, preview.digest, 'termination')
      expect(await localLink()).toEqual(localBefore)
    })

    it('handover exclusion still holds with a local link present', async () => {
      const f = await fixture()
      await localSource(f)
      const target = await addIntegration(f, 'handover-target')
      await query(
        `INSERT INTO directory_handovers(source_integration_id,target_integration_id,state,before_state,after_digest,created_by,updated_by) VALUES($1,$2,'applied','{}','synthetic',$3,$3)`,
        [f.source, target, f.admin],
      )
      await expect(f.verify()).rejects.toThrow(exact('REPAIR_HANDOVER_ACTIVE'))
      await query(
        'DELETE FROM directory_handovers WHERE source_integration_id=$1',
        [f.source],
      )
      await applyRepair(f)
      await expect(
        applyDirectoryHandover(
          { sourceIntegrationId: f.source, targetIntegrationId: target },
          'unused-before-preflight',
          f.admin,
        ),
      ).rejects.toThrow('Active login repair blocks handover')
      await unbindDirectoryAccount(f.account, {
        adminUserId: f.admin,
        disableDingTalkGrant: true,
      })
      await expect(
        applyDirectoryHandover(
          { sourceIntegrationId: f.source, targetIntegrationId: target },
          'not-reached',
          f.admin,
        ),
      ).rejects.toThrow('Active login repair blocks handover')
    })
  })

  describe('release approval binds the login scope and the source plan', () => {
    it('a login scope change between preview and execute refuses; rollback binds the scope too', async () => {
      const f = await fixture(),
        r = await applyRepair(f),
        preview = await releasePreview(f, r.id)
      provider.config.mockReturnValue({ corpId: f.corp, clientId: 'other-app' })
      await expectRefusedWithoutWrite(
        f,
        r.id,
        () => releaseWith(f, r.id, preview.digest),
        'REPAIR_LOGIN_SCOPE_CHANGED',
      )
      provider.config.mockReturnValue({
        corpId: f.corp,
        clientId: 'synthetic-current-app',
      })
      const rollback = await previewDingTalkRepairRecovery(
        r.id,
        f.admin,
        f.password,
        'rollback',
      )
      provider.config.mockReturnValue({
        corpId: 'other-corp',
        clientId: 'synthetic-current-app',
      })
      await expectRefusedWithoutWrite(
        f,
        r.id,
        () =>
          rollbackDingTalkRepair(
            r.id,
            f.admin,
            rollback.digest,
            'rollback',
            f.password,
          ),
        'REPAIR_RECOVERY_SNAPSHOT_CHANGED',
      )
    })

    it('a change to an unbound historical source invalidates the approval although the user snapshot is unchanged', async () => {
      const f = await fixture(),
        r = await applyRepair(f)
      await unbindDirectoryAccount(f.account, {
        adminUserId: f.admin,
        disableDingTalkGrant: true,
      })
      const preview = await releasePreview(f, r.id)
      await query('UPDATE directory_accounts SET is_active=false WHERE id=$1', [
        f.account,
      ])
      await expectRefusedWithoutWrite(
        f,
        r.id,
        () => releaseWith(f, r.id, preview.digest),
        'REPAIR_RECOVERY_SNAPSHOT_CHANGED',
      )
      const fresh = await releasePreview(f, r.id)
      expect(fresh.release).toMatchObject({
        mode: 'termination',
        releasedAccountIds: [f.account],
      })
      await expectAllowedRelease(f, r.id, fresh.digest, 'termination')
    })

    it('an ownership change between preview and execute refuses REPAIR_DIRECTORY_OWNER_CONFLICT', async () => {
      const f = await fixture(),
        other = await bareUser(),
        r = await applyRepair(f)
      await unbindDirectoryAccount(f.account, {
        adminUserId: f.admin,
        disableDingTalkGrant: true,
      })
      const preview = await releasePreview(f, r.id)
      await link(f.account, other)
      await expectRefusedWithoutWrite(
        f,
        r.id,
        () => releaseWith(f, r.id, preview.digest),
        'REPAIR_DIRECTORY_OWNER_CONFLICT',
      )
    })

    it('a mode flip between preview and execute refuses REPAIR_RECOVERY_SNAPSHOT_CHANGED', async () => {
      const f = await fixture(),
        r = await applyRepair(f)
      await unbindDirectoryAccount(f.account, {
        adminUserId: f.admin,
        disableDingTalkGrant: true,
      })
      const preview = await releasePreview(f, r.id)
      expect(preview.release?.mode).toBe('termination')
      await bindDirectoryAccount(f.account, {
        localUserRef: f.user,
        adminUserId: f.admin,
        enableDingTalkGrant: true,
      })
      expect((await releasePreview(f, r.id)).release?.mode).toBe('canonical')
      await expectRefusedWithoutWrite(
        f,
        r.id,
        () => releaseWith(f, r.id, preview.digest),
        'REPAIR_RECOVERY_SNAPSHOT_CHANGED',
      )
    })

    it('an allowlist change between preview and execute refuses REPAIR_SOURCE_OUTSIDE_ALLOWLIST', async () => {
      const f = await fixture(),
        old = await addIntegration(f, 'old-app'),
        oldAccount = await addAccount(old, f.corp, 'old-' + f.user, {
          union: 'new-union-' + f.user,
          active: false,
        })
      await link(oldAccount, f.user)
      const r = await applyRepair(f)
      await unbindDirectoryAccount(oldAccount, { adminUserId: f.admin })
      const preview = await releasePreview(f, r.id)
      // Allowed while applied: the old row is one of the journal's source ids.
      await link(oldAccount, f.user)
      await expectRefusedWithoutWrite(
        f,
        r.id,
        () => releaseWith(f, r.id, preview.digest),
        'REPAIR_SOURCE_OUTSIDE_ALLOWLIST',
      )
    })
  })

  describe('controlled re-anchoring', () => {
    // Shape labels: PROD = product actions only; DBA = needs a directory row deletion no product path performs;
    // LEGACY = two rows of one person in one corp, impossible for sync-written rows (unique corp + UnionID key).
    /** Applied repair, then the login app switched in place (canonical mode: a scan is required). */
    const loginAppSwitched = async () => {
      const f = await fixture(),
        r = await applyRepair(f)
      await switchLoginApp(f)
      return { f, r }
    }
    /** Applied repair, grant disabled, then the login app switched in place (termination: no scan). */
    const revokedAndSwitched = async () => {
      const f = await fixture(),
        r = await applyRepair(f)
      await query(
        'UPDATE user_external_auth_grants SET enabled=false WHERE local_user_id=$1',
        [f.user],
      )
      await switchLoginApp(f)
      return { f, r }
    }
    /** Applied repair, recorded row unbound with the grant off (identity deleted), then the login app switched. */
    const unboundAndSwitched = async () => {
      const f = await fixture(),
        r = await applyRepair(f)
      await unbindDirectoryAccount(f.account, {
        adminUserId: f.admin,
        disableDingTalkGrant: true,
      })
      await switchLoginApp(f)
      return { f, r }
    }
    /** A different-person inactive row linked before apply, later relinked to its rightful owner. */
    const journalSourceOccupied = async () => {
      const f = await fixture(),
        other = await bareUser(),
        stale = await addAccount(f.source, f.corp, 'stale-' + f.user, {
          union: 'different-person',
          active: false,
        })
      await link(stale, f.user)
      const r = await applyRepair(f)
      await query(
        'UPDATE directory_account_links SET local_user_id=$2 WHERE directory_account_id=$1',
        [stale, other],
      )
      provider.exchange.mockClear()
      return { f, r, other, stale }
    }
    /** DBA shape: the recorded row deleted (grant off, identity unbound) and an unowned current-app replacement. */
    const recordedRowReplaced = async (extra?: (f: Fixture, i2: string) => Promise<void>) => {
      const f = await fixture(),
        r = await applyRepair(f)
      await unbindDirectoryAccount(f.account, {
        adminUserId: f.admin,
        disableDingTalkGrant: true,
      })
      await productionKey(f.account)
      const i2 = await addIntegration(f, 'synthetic-current-app')
      await query('DELETE FROM directory_accounts WHERE id=$1', [f.account])
      const x = await addAccount(i2, f.corp, 'new-union-' + f.user, {
        union: 'new-union-' + f.user,
        open: 'new-open-' + f.user,
      })
      if (extra) await extra(f, i2)
      provider.exchange.mockClear()
      return { f, r, i2, x }
    }
    const linkOf = async (account: string) =>
      (
        await query(
          'SELECT link_status,local_user_id FROM directory_account_links WHERE directory_account_id=$1',
          [account],
        )
      ).rows

    describe('stuck states are re-anchored and then released', () => {
      it('R1 (PROD): login app switched in place, scan under the new app, first login advances the pin, release', async () => {
        const { f, r } = await loginAppSwitched()
        await expect(exchangeCodeForUser('synthetic-old-pin')).rejects.toMatchObject({
          statusCode: 409,
          code: 'repair_identity_mismatch',
        })
        await expect(releasePreview(f, r.id)).rejects.toThrow(
          exact('REPAIR_LOGIN_SCOPE_CHANGED'),
        )
        const identityBefore = await identityOf(f.user)
        provider.exchange.mockClear()
        const flow = await reanchorFlow(f, r.id, 'synthetic-scan')
        expect(provider.exchange).toHaveBeenCalledTimes(1)
        expect(flow.req.summary.reanchor).toEqual({
          releaseMode: 'canonical',
          reasons: ['login_scope'],
          loginClientChanged: true,
          previousCanonicalAccountId: f.account,
          canonicalAccountId: f.account,
          canonicalLinked: true,
          sourceAccountIds: [f.account],
          droppedSourceAccountIds: [],
          linkedDingTalkAccountIds: [f.account],
          scanRequired: true,
          scanned: true,
        })
        expect(flow.successor).toMatchObject({
          login_client_id: 'next-app',
          canonical_account_id: f.account,
          source_account_ids: [f.account],
          source_integration_ids: [f.source],
        })
        // C writes no identity: the scanned OpenID is checked, never stored.
        expect(await identityOf(f.user)).toEqual(identityBefore)
        expect((identityBefore[0].row as Record<string, unknown>).provider_open_id).toBe('new-open-' + f.user)
        // The first real login under the new app advances the successor's pin and merges the new OpenID.
        expect((await exchangeCodeForUser('synthetic-fresh')).localUserId).toBe(f.user)
        expect((await identityOf(f.user))[0].row).toMatchObject({
          provider_open_id: 'next-open-' + f.user,
          provider_union_id: 'new-union-' + f.user,
          external_key: f.corp + ':next-open-' + f.user,
        })
        expect((await repairRow(flow.done.id)).expected_identity).toMatchObject({
          provider_open_id: 'next-open-' + f.user,
          provider_union_id: 'new-union-' + f.user,
          external_key: f.corp + ':next-open-' + f.user,
        })
        // The superseded predecessor keeps the pin it had.
        expect((await repairRow(r.id)).expected_identity).toMatchObject({
          provider_open_id: 'new-open-' + f.user,
        })
        const preview = await releasePreview(f, flow.done.id)
        expect(preview.release).toMatchObject({
          mode: 'canonical',
          releasedAccountIds: [f.account],
        })
        await expectAllowedRelease(f, flow.done.id, preview.digest, 'canonical')
      })

      it('R2 (PROD): revoked user, login app switched: termination re-anchor without a scan, then release', async () => {
        const { f, r } = await revokedAndSwitched()
        const flow = await reanchorFlow(f, r.id)
        expect(provider.exchange).not.toHaveBeenCalled()
        expect(flow.req.summary.reanchor).toMatchObject({
          releaseMode: 'termination',
          reasons: ['login_scope'],
          scanRequired: false,
          scanned: false,
          canonicalAccountId: f.account,
          canonicalLinked: true,
        })
        const preview = await releasePreview(f, flow.done.id)
        expect(preview.release).toMatchObject({
          mode: 'termination',
          releasedAccountIds: [f.account],
        })
        await expectAllowedRelease(f, flow.done.id, preview.digest, 'termination')
        expect(
          (await query('SELECT enabled FROM user_external_auth_grants WHERE local_user_id=$1', [f.user]))
            .rows[0].enabled,
        ).toBe(false)
        await expect(exchangeCodeForUser('synthetic-after-release')).rejects.toMatchObject({
          statusCode: 403,
          code: 'grant_disabled',
        })
      })

      it('R3 (PROD): unbound and revoked, login app switched: unlinked anchor, release, product bind restores login', async () => {
        const { f, r } = await unboundAndSwitched()
        const orgsBefore = (
          await query('SELECT to_jsonb(t) AS row FROM user_orgs t WHERE user_id=$1 ORDER BY 1', [f.user])
        ).rows
        const flow = await reanchorFlow(f, r.id)
        expect(flow.req.summary.reanchor).toMatchObject({
          releaseMode: 'termination',
          canonicalAccountId: f.account,
          canonicalLinked: false,
          sourceAccountIds: [f.account],
          linkedDingTalkAccountIds: [],
        })
        expect(await identityOf(f.user)).toEqual([])
        expect(await linkOf(f.account)).toEqual([{ link_status: 'unmatched', local_user_id: null }])
        expect(
          (await query('SELECT to_jsonb(t) AS row FROM user_orgs t WHERE user_id=$1 ORDER BY 1', [f.user])).rows,
        ).toEqual(orgsBefore)
        const preview = await releasePreview(f, flow.done.id)
        await expectAllowedRelease(f, flow.done.id, preview.digest, 'termination')
        expect(
          await bindDirectoryAccount(f.account, {
            localUserRef: f.user,
            adminUserId: f.admin,
            enableDingTalkGrant: true,
          }),
        ).toBeTruthy()
        expect((await exchangeCodeForUser('synthetic-after-bind')).localUserId).toBe(f.user)
        expect((await identityOf(f.user))[0].row).toMatchObject({
          provider_open_id: 'next-open-' + f.user,
        })
      })

      it('R4 (PROD): a journal row of another person now held by its owner is dropped; release follows', async () => {
        const { f, r, other, stale } = await journalSourceOccupied()
        await expect(releasePreview(f, r.id)).rejects.toThrow(
          exact('REPAIR_DIRECTORY_OWNER_CONFLICT'),
        )
        const flow = await reanchorFlow(f, r.id)
        expect(provider.exchange).not.toHaveBeenCalled()
        expect(flow.req.summary.reanchor).toMatchObject({
          releaseMode: 'canonical',
          reasons: ['journal_source_occupied'],
          canonicalAccountId: f.account,
          sourceAccountIds: [f.account],
          droppedSourceAccountIds: [stale],
          scanRequired: false,
        })
        const preview = await releasePreview(f, flow.done.id)
        await expectAllowedRelease(f, flow.done.id, preview.digest, 'canonical')
        expect(await linkOf(stale)).toEqual([{ link_status: 'linked', local_user_id: other }])
      })

      it('R5 (DBA): recorded row deleted, unowned replacement in a second integration, termination, release, bind', async () => {
        const f = await fixture(),
          r = await applyRepair(f)
        await unbindDirectoryAccount(f.account, {
          adminUserId: f.admin,
          disableDingTalkGrant: true,
        })
        await productionKey(f.account)
        const i2 = await addIntegration(f, 'synthetic-current-app')
        // One DingTalk row per corp + person while the original exists (unique provider, corp, external_key).
        await expect(
          addAccount(i2, f.corp, 'new-union-' + f.user, { union: 'new-union-' + f.user }),
        ).rejects.toMatchObject({
          code: '23505',
          constraint: 'idx_directory_accounts_provider_corp_external_key',
        })
        await query('DELETE FROM directory_accounts WHERE id=$1', [f.account])
        const x = await addAccount(i2, f.corp, 'new-union-' + f.user, {
          union: 'new-union-' + f.user,
          open: 'new-open-' + f.user,
        })
        await expect(releasePreview(f, r.id)).rejects.toThrow(
          exact('REPAIR_HISTORICAL_SOURCE_UNVERIFIED'),
        )
        const flow = await reanchorFlow(f, r.id)
        expect(flow.req.summary.reanchor).toMatchObject({
          releaseMode: 'termination',
          reasons: ['canonical_source'],
          canonicalAccountId: x,
          canonicalLinked: false,
          sourceAccountIds: [x],
          droppedSourceAccountIds: [f.account],
        })
        expect(flow.successor.source_integration_ids).toEqual([i2])
        const preview = await releasePreview(f, flow.done.id)
        expect(preview.release).toMatchObject({ mode: 'termination', releasedAccountIds: [x] })
        await expectAllowedRelease(f, flow.done.id, preview.digest, 'termination', x)
        expect(
          await bindDirectoryAccount(x, {
            localUserRef: f.user,
            adminUserId: f.admin,
            enableDingTalkGrant: true,
          }),
        ).toBeTruthy()
        expect((await exchangeCodeForUser('synthetic-after-bind')).localUserId).toBe(f.user)
        const second = await addAccount(f.source, f.corp, 'second-' + f.user, {
          union: 'new-union-' + f.user + '-second',
        })
        await expect(link(second, f.user)).rejects.toMatchObject({ code: '55000' })
      })

      it('R6 (LEGACY): recorded row deleted, a same-person journal row linked and live: canonical re-anchor onto it', async () => {
        const f = await fixture(),
          dup = await addAccount(f.source, f.corp, 'dup-' + f.user, {
            union: 'new-union-' + f.user,
            active: false,
          })
        await link(dup, f.user)
        const r = await applyRepair(f)
        expect((await journalRow(r.id)).source_account_ids.sort()).toEqual([f.account, dup].sort())
        await query('UPDATE directory_accounts SET is_active=true WHERE id=$1', [dup])
        await query('DELETE FROM directory_accounts WHERE id=$1', [f.account])
        await expect(releasePreview(f, r.id)).rejects.toThrow(
          exact('REPAIR_CANONICAL_SOURCE_REQUIRED'),
        )
        provider.exchange.mockClear()
        const flow = await reanchorFlow(f, r.id)
        expect(provider.exchange).not.toHaveBeenCalled()
        expect(flow.req.summary.reanchor).toMatchObject({
          releaseMode: 'canonical',
          reasons: ['canonical_source'],
          scanRequired: false,
          canonicalAccountId: dup,
          canonicalLinked: true,
          sourceAccountIds: [dup],
          droppedSourceAccountIds: [f.account],
        })
        const preview = await releasePreview(f, flow.done.id)
        await expectAllowedRelease(f, flow.done.id, preview.digest, 'canonical', dup)
      })

      it('R7 (PROD): a second app switch re-anchors the successor; the chain keeps one undo target', async () => {
        const { f, r } = await loginAppSwitched()
        const first = await reanchorFlow(f, r.id, 'synthetic-scan')
        expect((await exchangeCodeForUser('synthetic-fresh')).localUserId).toBe(f.user)
        await switchLoginApp(f, 'third-app', {
          openId: 'third-open-' + f.user,
          unionId: 'new-union-' + f.user,
        })
        await expect(exchangeCodeForUser('synthetic-old-app')).rejects.toMatchObject({
          code: 'repair_identity_mismatch',
        })
        const second = await reanchorFlow(f, first.done.id, 'synthetic-scan-2')
        expect(second.successor.supersedes_id).toBe(first.done.id)
        const rows = [await repairRow(r.id), await repairRow(first.done.id), await repairRow(second.done.id)]
        expect(rows.map((x) => x.state)).toEqual(['superseded', 'superseded', 'applied'])
        expect(rows[1].supersedes_id).toBe(r.id)
        expect(new Set(rows.map((x) => x.before_identity)).size).toBe(1)
        expect((await exchangeCodeForUser('synthetic-third')).localUserId).toBe(f.user)
        expect((await identityOf(f.user))[0].row).toMatchObject({
          provider_open_id: 'third-open-' + f.user,
        })
      })

      it('R8 (PROD): recorded row moved to another app with the login app unchanged: refused before any scan; restore and release', async () => {
        const f = await fixture(),
          r = await applyRepair(f),
          approver = await secondAdmin(f)
        await query(
          `UPDATE directory_integrations SET config = config || '{"appKey":"wrong-app"}' WHERE id=$1`,
          [f.source],
        )
        await expect(releasePreview(f, r.id)).rejects.toThrow(
          exact('REPAIR_CANONICAL_SOURCE_REQUIRED'),
        )
        provider.exchange.mockClear()
        await expectReanchorRefused(
          f,
          r.id,
          () => requestReanchor(f, r.id, approver, f.admin, 'synthetic-scan'),
          'REPAIR_PERSON_NOT_PROVEN',
        )
        expect(provider.exchange).not.toHaveBeenCalled()
        await query(
          `UPDATE directory_integrations SET config = config || '{"appKey":"synthetic-current-app"}' WHERE id=$1`,
          [f.source],
        )
        await expectReanchorRefused(
          f,
          r.id,
          () => requestReanchor(f, r.id, approver),
          'REPAIR_REANCHOR_NOT_NEEDED',
        )
        const preview = await releasePreview(f, r.id)
        await expectAllowedRelease(f, r.id, preview.digest, 'canonical')
      })

      it('R9 (PROD): login app switched but the integration not yet: refused before any scan; after the switch it succeeds', async () => {
        const f = await fixture(),
          r = await applyRepair(f),
          approver = await secondAdmin(f)
        provider.config.mockReturnValue({
          corpId: f.corp,
          clientId: 'next-app',
          clientSecret: 'unused',
          redirectUri: 'https://example.test/callback',
        })
        provider.profile.mockResolvedValue({ openId: 'next-open-' + f.user, unionId: 'new-union-' + f.user })
        provider.exchange.mockClear()
        await expectReanchorRefused(
          f,
          r.id,
          () => requestReanchor(f, r.id, approver, f.admin, 'synthetic-scan'),
          'REPAIR_PERSON_NOT_PROVEN',
        )
        expect(provider.exchange).not.toHaveBeenCalled()
        await switchLoginApp(f)
        const flow = await reanchorFlow(f, r.id, 'synthetic-scan')
        expect(flow.req.summary.reanchor).toMatchObject({ reasons: ['login_scope'], scanned: true })
        const preview = await releasePreview(f, flow.done.id)
        await expectAllowedRelease(f, flow.done.id, preview.digest, 'canonical')
      })
    })

    describe('refusals write nothing and leave no successor', () => {
      it('N1: a healthy applied repair refuses REPAIR_REANCHOR_NOT_NEEDED (two admins cannot re-pin it)', async () => {
        const f = await fixture(),
          r = await applyRepair(f),
          approver = await secondAdmin(f)
        await expectReanchorRefused(
          f,
          r.id,
          () => requestReanchor(f, r.id, approver),
          'REPAIR_REANCHOR_NOT_NEEDED',
        )
        // Not even with a scan of the same person under the same app.
        await expectReanchorRefused(
          f,
          r.id,
          () => requestReanchor(f, r.id, approver, f.admin, 'synthetic-scan'),
          'REPAIR_REANCHOR_NOT_NEEDED',
        )
      })

      it('N2: an enterprise change refuses REPAIR_REANCHOR_CORP_CHANGED', async () => {
        const f = await fixture(),
          r = await applyRepair(f),
          approver = await secondAdmin(f)
        provider.config.mockReturnValue({
          corpId: 'other-corp',
          clientId: 'synthetic-current-app',
          clientSecret: 'unused',
          redirectUri: 'https://example.test/callback',
        })
        await expectReanchorRefused(
          f,
          r.id,
          () => requestReanchor(f, r.id, approver),
          'REPAIR_REANCHOR_CORP_CHANGED',
        )
      })

      it('N3: the same administrator twice refuses REPAIR_DUAL_CONTROL_REQUIRED at request, preview and execute', async () => {
        const { f, r } = await loginAppSwitched(),
          b = await secondAdmin(f)
        await expectReanchorRefused(
          f,
          r.id,
          () => requestReanchor(f, r.id, f.admin, f.admin, 'synthetic-scan'),
          'REPAIR_DUAL_CONTROL_REQUIRED',
        )
        const req = await requestReanchor(f, r.id, b, f.admin, 'synthetic-scan')
        await expectReanchorRefused(
          f,
          r.id,
          () => previewReanchor(f, req.request, f.admin),
          'REPAIR_DUAL_CONTROL_REQUIRED',
        )
        await expectReanchorRefused(
          f,
          r.id,
          () => reanchorWith(f, req.request, f.admin, req.summary.digest),
          'REPAIR_DUAL_CONTROL_REQUIRED',
        )
      })

      it('N4: the target as an administrator refuses REPAIR_DUAL_CONTROL_REQUIRED as preparer, approver and executor', async () => {
        const { f, r } = await loginAppSwitched(),
          b = await secondAdmin(f)
        await query('UPDATE users SET is_admin=true WHERE id=$1', [f.user])
        await expectReanchorRefused(
          f,
          r.id,
          () => requestReanchor(f, r.id, b, f.user, 'synthetic-scan'),
          'REPAIR_DUAL_CONTROL_REQUIRED',
        )
        await expectReanchorRefused(
          f,
          r.id,
          () => requestReanchor(f, r.id, f.user, f.admin, 'synthetic-scan'),
          'REPAIR_DUAL_CONTROL_REQUIRED',
        )
        expect(provider.exchange).not.toHaveBeenCalled()
        const req = await requestReanchor(f, r.id, b, f.admin, 'synthetic-scan')
        await expectReanchorRefused(
          f,
          r.id,
          () => previewReanchor(f, req.request, f.user),
          'REPAIR_DUAL_CONTROL_REQUIRED',
        )
        await expectReanchorRefused(
          f,
          r.id,
          () => reanchorWith(f, req.request, f.user, req.summary.digest),
          'REPAIR_DUAL_CONTROL_REQUIRED',
        )
      })

      it('N5: only the named approver may preview and execute', async () => {
        const { f, r } = await loginAppSwitched(),
          b = await secondAdmin(f),
          c = await secondAdmin(f)
        const req = await requestReanchor(f, r.id, b, f.admin, 'synthetic-scan')
        await expectReanchorRefused(
          f,
          r.id,
          () => previewReanchor(f, req.request, c),
          'REPAIR_DUAL_CONTROL_REQUIRED',
        )
        await expectReanchorRefused(
          f,
          r.id,
          () => reanchorWith(f, req.request, c, req.summary.digest),
          'REPAIR_DUAL_CONTROL_REQUIRED',
        )
      })

      it('N6: any change between request and execute refuses REPAIR_RECOVERY_SNAPSHOT_CHANGED', async () => {
        // (a) the target's users row (s.hash) changes before preview.
        {
          const { f, r } = await loginAppSwitched(),
            b = await secondAdmin(f)
          const req = await requestReanchor(f, r.id, b, f.admin, 'synthetic-scan')
          await query("UPDATE users SET role='admin' WHERE id=$1", [f.user])
          await expectReanchorRefused(
            f,
            r.id,
            () => previewReanchor(f, req.request, b),
            'REPAIR_RECOVERY_SNAPSHOT_CHANGED',
          )
        }
        // (b) a new person row (pinned OpenID, another app, unowned) between preview and execute.
        {
          const { f, r } = await loginAppSwitched(),
            b = await secondAdmin(f)
          const req = await requestReanchor(f, r.id, b, f.admin, 'synthetic-scan')
          await previewReanchor(f, req.request, b)
          const o = await addIntegration(f, 'other-app')
          await addAccount(o, f.corp, 'n6b-' + f.user, { open: 'new-open-' + f.user })
          await expectReanchorRefused(
            f,
            r.id,
            () => reanchorWith(f, req.request, b, req.summary.digest),
            'REPAIR_RECOVERY_SNAPSHOT_CHANGED',
          )
        }
        // (c) only the journal's pinned identity changes (identity row untouched, s.hash unchanged).
        {
          const { f, r } = await loginAppSwitched(),
            b = await secondAdmin(f)
          const req = await requestReanchor(f, r.id, b, f.admin, 'synthetic-scan')
          await previewReanchor(f, req.request, b)
          await query(
            `UPDATE dingtalk_login_repairs SET expected_identity = expected_identity || '{"external_key":"x"}' WHERE id=$1`,
            [r.id],
          )
          await expectReanchorRefused(
            f,
            r.id,
            () => reanchorWith(f, req.request, b, req.summary.digest),
            'REPAIR_RECOVERY_SNAPSHOT_CHANGED',
          )
        }
        // (d) a verified OAuth OpenID rotation advances the pin between preview and execute.
        {
          const { f, r } = await journalSourceOccupied(),
            b = await secondAdmin(f)
          const req = await requestReanchor(f, r.id, b)
          await previewReanchor(f, req.request, b)
          provider.profile.mockResolvedValue({ openId: 'rotated-' + f.user, unionId: 'new-union-' + f.user })
          expect((await exchangeCodeForUser('synthetic-rotation')).localUserId).toBe(f.user)
          expect((await repairRow(r.id)).expected_identity).toMatchObject({ provider_open_id: 'rotated-' + f.user })
          await expectReanchorRefused(
            f,
            r.id,
            () => reanchorWith(f, req.request, b, req.summary.digest),
            'REPAIR_RECOVERY_SNAPSHOT_CHANGED',
          )
        }
      })

      it('N7: a wrong confirm or a digest other than the request\'s refuses REPAIR_APPROVAL_REQUIRED', async () => {
        const { f, r } = await loginAppSwitched(),
          b = await secondAdmin(f)
        const req = await requestReanchor(f, r.id, b, f.admin, 'synthetic-scan')
        await expectReanchorRefused(
          f,
          r.id,
          () => reanchorDingTalkRepair(req.request, b, f.password, req.summary.digest, 'yes'),
          'REPAIR_APPROVAL_REQUIRED',
        )
        await expectReanchorRefused(
          f,
          r.id,
          () => reanchorWith(f, req.request, b, 'f'.repeat(64)),
          'REPAIR_APPROVAL_REQUIRED',
        )
      })

      it('N8: a login scope change after the request refuses REPAIR_PROOF_INVALID', async () => {
        const { f, r } = await loginAppSwitched(),
          b = await secondAdmin(f)
        const req = await requestReanchor(f, r.id, b, f.admin, 'synthetic-scan')
        await previewReanchor(f, req.request, b)
        provider.config.mockReturnValue({
          corpId: f.corp,
          clientId: 'third-app',
          clientSecret: 'unused',
          redirectUri: 'https://example.test/callback',
        })
        await expectReanchorRefused(
          f,
          r.id,
          () => reanchorWith(f, req.request, b, req.summary.digest),
          'REPAIR_PROOF_INVALID',
        )
      })

      it('N9: this person\'s row held or hinted by another user refuses REPAIR_DIRECTORY_OWNER_CONFLICT, before the not-needed gate', async () => {
        // (a) PROD: the person's only row now linked to another local account (moved person).
        {
          const { f, r } = await unboundAndSwitched(),
            other = await bareUser(),
            b = await secondAdmin(f)
          await link(f.account, other)
          await expectReanchorRefused(f, r.id, () => requestReanchor(f, r.id, b), 'REPAIR_DIRECTORY_OWNER_CONFLICT')
        }
        // (b) LEGACY: a same-UnionID twin pending/email to another user.
        {
          const { f, r } = await revokedAndSwitched(),
            other = await bareUser(),
            b = await secondAdmin(f)
          const twin = await addAccount(f.source, f.corp, 'twin-' + f.user, { union: 'new-union-' + f.user })
          await link(twin, other, 'pending', 'email')
          await expectReanchorRefused(f, r.id, () => requestReanchor(f, r.id, b), 'REPAIR_DIRECTORY_OWNER_CONFLICT')
        }
        // (c) LEGACY: nothing stuck, a same-UnionID twin linked to another user: the conflict, not NOT_NEEDED.
        {
          const f = await fixture(),
            r = await applyRepair(f),
            other = await bareUser(),
            b = await secondAdmin(f)
          const twin = await addAccount(f.source, f.corp, 'twin-' + f.user, { union: 'new-union-' + f.user })
          await link(twin, other)
          await expectReanchorRefused(f, r.id, () => requestReanchor(f, r.id, b), 'REPAIR_DIRECTORY_OWNER_CONFLICT')
        }
        // (d) PROD: the row is linked to another user between preview and execute.
        {
          const { f, r } = await unboundAndSwitched(),
            other = await bareUser(),
            b = await secondAdmin(f)
          const req = await requestReanchor(f, r.id, b)
          await previewReanchor(f, req.request, b)
          await link(f.account, other)
          await expectReanchorRefused(
            f,
            r.id,
            () => reanchorWith(f, req.request, b, req.summary.digest),
            'REPAIR_DIRECTORY_OWNER_CONFLICT',
          )
        }
      })

      it('N10: another user holding this person\'s identity refuses REPAIR_IDENTITY_CONFLICT at request and execute', async () => {
        const { f, r } = await unboundAndSwitched(),
          other = await bareUser(),
          b = await secondAdmin(f)
        const plant = () =>
          query(
            `INSERT INTO user_external_identities(provider,external_key,local_user_id,corp_id,provider_open_id,provider_union_id) VALUES('dingtalk',$1,$2,$3,'x',$4)`,
            [f.corp + ':x', other, f.corp, 'new-union-' + f.user],
          )
        await plant()
        await expectReanchorRefused(f, r.id, () => requestReanchor(f, r.id, b), 'REPAIR_IDENTITY_CONFLICT')
        await query('DELETE FROM user_external_identities WHERE local_user_id=$1', [other])
        const req = await requestReanchor(f, r.id, b)
        await previewReanchor(f, req.request, b)
        await plant()
        await expectReanchorRefused(
          f,
          r.id,
          () => reanchorWith(f, req.request, b, req.summary.digest),
          'REPAIR_IDENTITY_CONFLICT',
        )
      })

      it('N11: a live link without a UnionID refuses REPAIR_DIRECTORY_UNION_ID_REQUIRED before the scan', async () => {
        const { f, r } = await loginAppSwitched(),
          b = await secondAdmin(f)
        await query('UPDATE directory_accounts SET union_id=NULL WHERE id=$1', [f.account])
        await expectReanchorRefused(
          f,
          r.id,
          () => requestReanchor(f, r.id, b, f.admin, 'synthetic-scan'),
          'REPAIR_DIRECTORY_UNION_ID_REQUIRED',
        )
        expect(provider.exchange).not.toHaveBeenCalled()
      })

      it.each([
        ['a', 'a cross-app row with the pinned OpenID linked to another user', 'REPAIR_DIRECTORY_OWNER_CONFLICT', false],
        ['b', 'a scan of another person', 'REPAIR_REANCHOR_PERSON_MISMATCH', true],
        ['c', 'another user\'s identity with the scanned OpenID', 'REPAIR_IDENTITY_CONFLICT', true],
        ['d', 'another user\'s directory row with the scanned OpenID', 'REPAIR_DIRECTORY_OWNER_CONFLICT', true],
      ] as const)('N12(%s): %s refuses %s', async (variant, _name, code, exchanged) => {
        const { f, r } = await loginAppSwitched(),
          other = await bareUser(),
          b = await secondAdmin(f)
        if (variant === 'a') {
          const o = await addIntegration(f, 'other-app')
          const row = await addAccount(o, f.corp, 'n12a-' + f.user, {
            open: 'new-open-' + f.user,
            union: 'different-person',
          })
          await link(row, other)
        }
        if (variant === 'b')
          provider.profile.mockResolvedValue({ openId: 'next-open-' + f.user, unionId: 'different-person' })
        if (variant === 'c')
          await query(
            `INSERT INTO user_external_identities(provider,external_key,local_user_id,corp_id,provider_open_id,provider_union_id) VALUES('dingtalk',$1,$2,$3,$4,'other-union')`,
            [f.corp + ':next-open-' + f.user, other, f.corp, 'next-open-' + f.user],
          )
        if (variant === 'd') {
          const row = await addAccount(f.source, f.corp, 'n12d-' + f.user, {
            open: 'next-open-' + f.user,
            union: 'n12d-union',
          })
          await link(row, other)
        }
        await expectReanchorRefused(
          f,
          r.id,
          () => requestReanchor(f, r.id, b, f.admin, 'synthetic-scan'),
          code,
        )
        expect(provider.exchange).toHaveBeenCalledTimes(exchanged ? 1 : 0)
      })

      it('N13 (LEGACY): two fitting anchor rows refuse REPAIR_CANONICAL_SOURCE_REQUIRED; a live row beats an inactive one', async () => {
        // (a) canonical mode: two same-UnionID journal rows linked and live, the recorded row deleted.
        {
          const f = await fixture(),
            dup1 = await addAccount(f.source, f.corp, 'dup1-' + f.user, { union: 'new-union-' + f.user, active: false }),
            dup2 = await addAccount(f.source, f.corp, 'dup2-' + f.user, { union: 'new-union-' + f.user, active: false })
          await link(dup1, f.user)
          await link(dup2, f.user)
          const r = await applyRepair(f),
            b = await secondAdmin(f)
          await query('UPDATE directory_accounts SET is_active=true WHERE id=ANY($1::uuid[])', [[dup1, dup2]])
          await query('DELETE FROM directory_accounts WHERE id=$1', [f.account])
          await expectReanchorRefused(f, r.id, () => requestReanchor(f, r.id, b), 'REPAIR_CANONICAL_SOURCE_REQUIRED')
        }
        // (b) termination: two live unowned current-app replacements.
        {
          const { f, r } = await recordedRowReplaced(async (f2, i2) => {
            await addAccount(i2, f2.corp, 'x2-' + f2.user, { union: 'new-union-' + f2.user })
          })
          const b = await secondAdmin(f)
          await expectReanchorRefused(f, r.id, () => requestReanchor(f, r.id, b), 'REPAIR_CANONICAL_SOURCE_REQUIRED')
        }
        // (c) control: one live and one inactive replacement: the live row is the anchor.
        {
          const { f, r, x } = await recordedRowReplaced(async (f2, i2) => {
            await addAccount(i2, f2.corp, 'x2-' + f2.user, { union: 'new-union-' + f2.user, active: false })
          })
          const b = await secondAdmin(f)
          const req = await requestReanchor(f, r.id, b)
          expect(req.summary.reanchor).toMatchObject({ canonicalAccountId: x, sourceAccountIds: [x] })
        }
      })

      it('N14: an applied handover on the old or the new integration refuses REPAIR_HANDOVER_ACTIVE before the scan', async () => {
        const handover = async (f: Fixture, source: string) => {
          const target = await addIntegration(f, 'handover-target')
          await query(
            `INSERT INTO directory_handovers(source_integration_id,target_integration_id,state,before_state,after_digest,created_by,updated_by) VALUES($1,$2,'applied','{}','synthetic',$3,$3)`,
            [source, target, f.admin],
          )
        }
        {
          const { f, r } = await loginAppSwitched(),
            b = await secondAdmin(f)
          await handover(f, f.source)
          await expectReanchorRefused(
            f,
            r.id,
            () => requestReanchor(f, r.id, b, f.admin, 'synthetic-scan'),
            'REPAIR_HANDOVER_ACTIVE',
          )
          expect(provider.exchange).not.toHaveBeenCalled()
        }
        {
          const { f, r, i2 } = await recordedRowReplaced()
          const b = await secondAdmin(f)
          await handover(f, i2)
          await expectReanchorRefused(f, r.id, () => requestReanchor(f, r.id, b), 'REPAIR_HANDOVER_ACTIVE')
        }
      })

      it('N15: an expired, far-future, wrong-purpose or v1 token refuses REPAIR_PROOF_INVALID; v1 preview refuses a request', async () => {
        const f = await fixture(),
          proof = await f.verify(),
          p = await previewDingTalkRepair(proof),
          r = await applyDingTalkRepair(proof, p.digest, 'apply')
        await switchLoginApp(f)
        const b = await secondAdmin(f)
        const req = await requestReanchor(f, r.id, b, f.admin, 'synthetic-scan')
        const raw = JSON.parse(decryptStoredSecretValue(req.request))
        const reseal = (o: Record<string, unknown>) => encryptStoredSecretValue(JSON.stringify({ ...raw, ...o }))
        for (const token of [
          reseal({ expires: Date.now() - 1 }),
          reseal({ expires: Date.now() + 2 * 600000 }),
          reseal({ purpose: 'dingtalk-login-repair-v2' }),
          reseal({ nonce: 'not-a-uuid' }),
          proof,
          '{}',
        ]) {
          await expectReanchorRefused(f, r.id, () => previewReanchor(f, token, b), 'REPAIR_PROOF_INVALID')
          await expectReanchorRefused(
            f,
            r.id,
            () => reanchorWith(f, token, b, req.summary.digest),
            'REPAIR_PROOF_INVALID',
          )
        }
        await expectReanchorRefused(f, r.id, () => previewDingTalkRepair(req.request), 'REPAIR_PROOF_INVALID')
      })

      it('N16: a replayed or concurrent execution commits one successor; a nonce copy is refused by the database', async () => {
        const { f, r } = await loginAppSwitched()
        const flow = await reanchorFlow(f, r.id, 'synthetic-scan')
        const before = await capture(f, flow.done.id)
        await expect(
          reanchorWith(f, flow.req.request, flow.approver, flow.req.summary.digest),
        ).rejects.toThrow(exact('REPAIR_NOT_ACTIVE'))
        expect(await capture(f, flow.done.id)).toEqual(before)
        await expect(
          query(
            `INSERT INTO dingtalk_login_repairs(id,user_id,proof_nonce,state,before_identity,expected_identity,after_digest,actor_id,source_account_ids,source_integration_ids,canonical_account_id,login_client_id) SELECT $2::uuid,user_id,proof_nonce,'rolled_back',before_identity,expected_identity,after_digest,actor_id,source_account_ids,source_integration_ids,canonical_account_id,login_client_id FROM dingtalk_login_repairs WHERE id=$1`,
            [flow.done.id, randomUUID()],
          ),
        ).rejects.toMatchObject({ code: '23505', constraint: 'dingtalk_login_repairs_proof_nonce_key' })
        // Two executions of one approved request at once.
        const g = await loginAppSwitched(),
          b = await secondAdmin(g.f)
        const req = await requestReanchor(g.f, g.r.id, b, g.f.admin, 'synthetic-scan')
        const settled = await Promise.allSettled([
          reanchorWith(g.f, req.request, b, req.summary.digest),
          reanchorWith(g.f, req.request, b, req.summary.digest),
        ])
        expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1)
        const rejected = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult
        expect(String(rejected.reason.message)).toMatch(/^(REPAIR_NOT_ACTIVE|REPAIR_LOCK_BUSY)$/)
        expect(await successorOf(g.r.id)).toHaveLength(1)
      })

      it('N17: the preparer\'s credential changing after the request refuses at preview and execute', async () => {
        {
          const { f, r } = await loginAppSwitched(),
            b = await secondAdmin(f)
          const req = await requestReanchor(f, r.id, b, f.admin, 'synthetic-scan')
          await query('UPDATE users SET password_hash=$2 WHERE id=$1', [f.admin, await bcrypt.hash(f.password, 4)])
          await expectReanchorRefused(f, r.id, () => previewReanchor(f, req.request, b), 'REPAIR_OPERATOR_CHANGED')
          await expectReanchorRefused(
            f,
            r.id,
            () => reanchorWith(f, req.request, b, req.summary.digest),
            'REPAIR_OPERATOR_CHANGED',
          )
        }
        {
          const { f, r } = await loginAppSwitched(),
            b = await secondAdmin(f)
          const req = await requestReanchor(f, r.id, b, f.admin, 'synthetic-scan')
          await query('UPDATE users SET is_active=false WHERE id=$1', [f.admin])
          await expectReanchorRefused(f, r.id, () => previewReanchor(f, req.request, b), 'REPAIR_OPERATOR_REQUIRED')
          await expectReanchorRefused(
            f,
            r.id,
            () => reanchorWith(f, req.request, b, req.summary.digest),
            'REPAIR_OPERATOR_REQUIRED',
          )
        }
      })

      it('N18: the approver must be an eligible administrator and authenticate with their own password', async () => {
        const { f, r } = await loginAppSwitched(),
          b = await secondAdmin(f)
        const req = await requestReanchor(f, r.id, b, f.admin, 'synthetic-scan')
        await expectReanchorRefused(
          f,
          r.id,
          () => previewDingTalkRepairReanchor(req.request, b, 'wrong-password'),
          'REPAIR_OPERATOR_CREDENTIAL_REQUIRED',
        )
        await expectReanchorRefused(
          f,
          r.id,
          () => reanchorDingTalkRepair(req.request, b, 'wrong-password', req.summary.digest, 'reanchor'),
          'REPAIR_OPERATOR_CREDENTIAL_REQUIRED',
        )
        provider.exchange.mockClear()
        const notAdmin = await bareUser()
        await expectReanchorRefused(
          f,
          r.id,
          () => requestReanchor(f, r.id, notAdmin, f.admin, 'synthetic-scan'),
          'REPAIR_OPERATOR_REQUIRED',
        )
        expect(provider.exchange).not.toHaveBeenCalled()
        await query('UPDATE users SET is_admin=false WHERE id=$1', [b])
        await expectReanchorRefused(f, r.id, () => previewReanchor(f, req.request, b), 'REPAIR_OPERATOR_REQUIRED')
        await expectReanchorRefused(
          f,
          r.id,
          () => reanchorWith(f, req.request, b, req.summary.digest),
          'REPAIR_OPERATOR_REQUIRED',
        )
      })

      it('N19: canonical mode after an app change needs a scan at request, preview and execute', async () => {
        const { f, r } = await loginAppSwitched(),
          b = await secondAdmin(f)
        await expectReanchorRefused(f, r.id, () => requestReanchor(f, r.id, b), 'REPAIR_REANCHOR_SCAN_REQUIRED')
        expect(provider.exchange).not.toHaveBeenCalled()
        const req = await requestReanchor(f, r.id, b, f.admin, 'synthetic-scan')
        const unscanned = encryptStoredSecretValue(
          JSON.stringify({ ...JSON.parse(decryptStoredSecretValue(req.request)), scanOpenId: null }),
        )
        await expectReanchorRefused(f, r.id, () => previewReanchor(f, unscanned, b), 'REPAIR_REANCHOR_SCAN_REQUIRED')
        await expectReanchorRefused(
          f,
          r.id,
          () => reanchorWith(f, unscanned, b, req.summary.digest),
          'REPAIR_REANCHOR_SCAN_REQUIRED',
        )
      })

      it('N20: an incomplete scan profile refuses REPAIR_PROFILE_INCOMPLETE', async () => {
        const { f, r } = await loginAppSwitched(),
          b = await secondAdmin(f)
        provider.profile.mockResolvedValue({ openId: 'x' })
        await expectReanchorRefused(
          f,
          r.id,
          () => requestReanchor(f, r.id, b, f.admin, 'synthetic-scan'),
          'REPAIR_PROFILE_INCOMPLETE',
        )
      })

      it('N21: a mode flip (grant re-enabled) after a termination request refuses REPAIR_RECOVERY_SNAPSHOT_CHANGED', async () => {
        const { f, r } = await revokedAndSwitched(),
          b = await secondAdmin(f)
        const req = await requestReanchor(f, r.id, b)
        expect(req.summary.reanchor.releaseMode).toBe('termination')
        await query('UPDATE user_external_auth_grants SET enabled=true WHERE local_user_id=$1', [f.user])
        await expectReanchorRefused(
          f,
          r.id,
          () => reanchorWith(f, req.request, b, req.summary.digest),
          'REPAIR_RECOVERY_SNAPSHOT_CHANGED',
        )
      })

      it('N22: a conflicting core-table lock past lock_timeout refuses REPAIR_LOCK_BUSY and writes nothing', async () => {
        const { f, r } = await loginAppSwitched(),
          b = await secondAdmin(f)
        const req = await requestReanchor(f, r.id, b, f.admin, 'synthetic-scan')
        await previewReanchor(f, req.request, b)
        const holder = await pool!.connect()
        try {
          await holder.query('BEGIN')
          await holder.query('LOCK TABLE roles IN SHARE UPDATE EXCLUSIVE MODE')
          await expectReanchorRefused(
            f,
            r.id,
            () => reanchorWith(f, req.request, b, req.summary.digest),
            'REPAIR_LOCK_BUSY',
          )
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined)
          holder.release()
        }
      })

      it('N23: released and rolled-back repairs refuse REPAIR_NOT_ACTIVE', async () => {
        for (const action of ['release', 'rollback'] as const) {
          const f = await fixture(),
            r = await applyRepair(f),
            b = await secondAdmin(f)
          const preview = await previewDingTalkRepairRecovery(r.id, f.admin, f.password, action)
          await (action === 'release' ? releaseDingTalkRepair : rollbackDingTalkRepair)(
            r.id,
            f.admin,
            preview.digest,
            action,
            f.password,
          )
          await switchLoginApp(f)
          const before = await capture(f, r.id)
          await expect(requestReanchor(f, r.id, b, f.admin, 'synthetic-scan')).rejects.toThrow(
            exact('REPAIR_NOT_ACTIVE'),
          )
          expect(await capture(f, r.id)).toEqual(before)
          expect(await successorOf(r.id)).toEqual([])
          expect(provider.exchange).not.toHaveBeenCalled()
        }
      })

      it('N24 (PROD, rare): canonical mode with the recorded row unlinked refuses REPAIR_PERSON_NOT_PROVEN until rebound', async () => {
        const f = await fixture(),
          r = await applyRepair(f),
          b = await secondAdmin(f)
        await unbindDirectoryAccount(f.account, { adminUserId: f.admin })
        expect(await identityOf(f.user)).toEqual([])
        // An email first association re-creates the identity (the insert guard admits exactly the pin).
        await query(
          `INSERT INTO user_external_identities(provider,external_key,local_user_id,corp_id,provider_open_id,provider_union_id) VALUES('dingtalk',$1,$2,$3,$4,$5)`,
          [f.corp + ':new-open-' + f.user, f.user, f.corp, 'new-open-' + f.user, 'new-union-' + f.user],
        )
        await switchLoginApp(f)
        await expectReanchorRefused(
          f,
          r.id,
          () => requestReanchor(f, r.id, b, f.admin, 'synthetic-scan'),
          'REPAIR_PERSON_NOT_PROVEN',
        )
        expect(provider.exchange).not.toHaveBeenCalled()
        expect(
          await bindDirectoryAccount(f.account, {
            localUserRef: f.user,
            adminUserId: f.admin,
            enableDingTalkGrant: true,
          }),
        ).toBeTruthy()
        const flow = await reanchorFlow(f, r.id, 'synthetic-scan')
        expect(flow.req.summary.reanchor).toMatchObject({ releaseMode: 'canonical', canonicalLinked: true })
      })

      it('N25: request and preview write nothing (with and without a scan)', async () => {
        for (const setup of [loginAppSwitched, revokedAndSwitched]) {
          const { f, r } = await setup(),
            b = await secondAdmin(f)
          const sessionsAndTokens = async () => [
            (await query('SELECT to_jsonb(t) AS row FROM user_sessions t WHERE user_id=$1 ORDER BY 1', [f.user])).rows,
            (await query('SELECT to_jsonb(t) AS row FROM multitable_api_tokens t WHERE created_by=$1 ORDER BY 1', [f.user]))
              .rows,
            (
              await query(
                "SELECT count(*)::int AS n FROM audit_logs WHERE resource_type='dingtalk_login_repairs' AND user_name=ANY($1::text[])",
                [[f.admin, b]],
              )
            ).rows,
          ]
          const before = await capture(f, r.id),
            other = await sessionsAndTokens(),
            untouched = await untouchedByReanchor(f),
            generation = await accessGeneration(f.user)
          const code = setup === loginAppSwitched ? 'synthetic-scan' : undefined
          const req = await requestReanchor(f, r.id, b, f.admin, code)
          await previewReanchor(f, req.request, b)
          // A scan offered where none is required is still exchanged and checked, and still writes nothing.
          if (!code) await requestReanchor(f, r.id, b, f.admin, 'synthetic-optional-scan')
          expect(await capture(f, r.id)).toEqual(before)
          expect(await sessionsAndTokens()).toEqual(other)
          expect(await untouchedByReanchor(f)).toEqual(untouched)
          expect(await accessGeneration(f.user)).toBe(generation)
          expect(await successorOf(r.id)).toEqual([])
        }
      })
    })

    describe('database chain guard (direct SQL and the transaction() wrapper)', () => {
      const supersede = (id: string, by: string): [string, unknown[]] => [
        "UPDATE dingtalk_login_repairs SET state='superseded',rollback_actor_id=$2,rolled_back_at=now() WHERE id=$1",
        [id, by],
      ]
      type Over = {
        id?: string
        nonce?: string
        state?: string
        before?: string
        expected?: unknown
        sources?: string[]
        integrations?: string[]
        canonical?: string
        actor?: string
        approver?: string | null
        supersedes?: string | null
      }
      /** A copy of `from` as a successor; every override replaces one column. */
      const successor = (from: string, f: Fixture, admin2: string, o: Over = {}): [string, unknown[]] => [
        `INSERT INTO dingtalk_login_repairs(id,user_id,proof_nonce,state,before_identity,expected_identity,after_digest,actor_id,approver_id,supersedes_id,source_account_ids,source_integration_ids,canonical_account_id,login_client_id) SELECT $1::uuid,user_id,$2::uuid,$3::text,COALESCE($4::text,before_identity),COALESCE($5::jsonb,expected_identity),'pending',$6::text,$7::text,$8::uuid,COALESCE($9::uuid[],source_account_ids),COALESCE($10::uuid[],source_integration_ids),COALESCE($11::uuid,canonical_account_id),login_client_id FROM dingtalk_login_repairs WHERE id=$12::uuid`,
        [
          o.id ?? randomUUID(),
          o.nonce ?? randomUUID(),
          o.state ?? 'applied',
          o.before ?? null,
          o.expected === undefined ? null : JSON.stringify(o.expected),
          o.actor ?? f.admin,
          o.approver === undefined ? admin2 : o.approver,
          o.supersedes === undefined ? from : o.supersedes,
          o.sources ?? null,
          o.integrations ?? null,
          o.canonical ?? null,
          from,
        ],
      ]
      /** Runs the statements in one pool-client transaction; a failure carries the stage it happened at. */
      async function viaClient(statements: [string, unknown[]][]) {
        const c = await pool!.connect()
        let stage = 'BEGIN'
        try {
          await c.query('BEGIN')
          for (const [i, [sql, args]] of statements.entries()) {
            stage = `statement ${i}`
            await c.query(sql, args)
          }
          stage = 'COMMIT'
          await c.query('COMMIT')
        } catch (error) {
          await c.query('ROLLBACK').catch(() => undefined)
          throw Object.assign(error as object, { stage })
        } finally {
          c.release()
        }
      }
      /** The same statements through the repo's transaction() wrapper (COMMIT inside its try, ROLLBACK on error). */
      const viaWrapper = (statements: [string, unknown[]][]) =>
        pg.transaction(async (c) => {
          for (const [sql, args] of statements) await c.query(sql, args)
        })
      const setup = async () => {
        const f = await fixture(),
          r = await applyRepair(f),
          admin2 = await secondAdmin(f)
        return { f, r, admin2 }
      }
      /** Both paths fail with `code` (at COMMIT for the deferred guard) and persist nothing. */
      async function expectNothingPersisted(
        f: Fixture,
        id: string,
        statements: () => [string, unknown[]][],
        expected: { code: string; message?: string; constraint?: string; stage: string },
      ) {
        const { stage, ...shape } = expected
        const rowBefore = await repairRow(id)
        const journalBefore = (
          await query('SELECT to_jsonb(t) AS row FROM dingtalk_login_repairs t WHERE user_id=$1 ORDER BY 1', [f.user])
        ).rows
        await expect(viaClient(statements())).rejects.toMatchObject({ ...shape, stage })
        await expect(viaWrapper(statements())).rejects.toMatchObject(shape)
        expect(await repairRow(id)).toEqual(rowBefore)
        expect(
          (
            await query('SELECT to_jsonb(t) AS row FROM dingtalk_login_repairs t WHERE user_id=$1 ORDER BY 1', [f.user])
          ).rows,
        ).toEqual(journalBefore)
      }
      const chainRefused = { code: '55000', message: 'a superseded login repair needs its same-person successor', stage: 'COMMIT' }

      it('G1: a correct successor commits through both paths, and the fence then reads the successor', async () => {
        const { f, r, admin2 } = await setup()
        const x = await addAccount(f.source, f.corp, 'g1-' + f.user, { union: 'new-union-' + f.user })
        await expect(link(x, f.user)).rejects.toMatchObject({ code: '55000' })
        const id = randomUUID()
        await viaClient([
          supersede(r.id, admin2),
          successor(r.id, f, admin2, { id, sources: [f.account, x], integrations: [f.source, f.source], canonical: x }),
        ])
        expect(await repairRow(r.id)).toMatchObject({ state: 'superseded' })
        expect(await repairRow(id)).toMatchObject({ state: 'applied', supersedes_id: r.id, canonical_account_id: x })
        await expect(link(x, f.user)).resolves.toBeDefined()
        // The wrapper path commits a correct chain link too.
        const g = await setup()
        await viaWrapper([supersede(g.r.id, g.admin2), successor(g.r.id, g.f, g.admin2)])
        expect((await successorOf(g.r.id)).map((s) => s.state)).toEqual(['applied'])
      })

      it('G2: a supersede with no successor fails at the implicit commit of an autocommit statement', async () => {
        const { r, admin2 } = await setup()
        const [sql, args] = supersede(r.id, admin2)
        await expect(query(sql, args)).rejects.toMatchObject({
          code: '55000',
          message: 'a superseded login repair needs its same-person successor',
        })
        expect(await repairRow(r.id)).toMatchObject({ state: 'applied', rollback_actor_id: null })
      })

      it('G3: a successor pinning another person fails at COMMIT', async () => {
        const { f, r, admin2 } = await setup()
        const expected = { ...(await repairRow(r.id)).expected_identity, provider_union_id: 'different-person' }
        await expectNothingPersisted(
          f,
          r.id,
          () => [supersede(r.id, admin2), successor(r.id, f, admin2, { expected })],
          chainRefused,
        )
      })

      it('G4: a successor with a different undo ciphertext (same value, resealed) fails at COMMIT', async () => {
        const { f, r, admin2 } = await setup()
        const sealed = String((await repairRow(r.id)).before_identity)
        const resealed = encryptStoredSecretValue(decryptStoredSecretValue(sealed))
        expect(resealed).not.toBe(sealed)
        await expectNothingPersisted(
          f,
          r.id,
          () => [supersede(r.id, admin2), successor(r.id, f, admin2, { before: resealed })],
          chainRefused,
        )
      })

      it('G5: a successor adding a source besides its own canonical row fails at COMMIT', async () => {
        const { f, r, admin2 } = await setup()
        const extra = await addAccount(f.source, f.corp, 'g5-' + f.user, { union: 'new-union-' + f.user })
        await expectNothingPersisted(
          f,
          r.id,
          () => [
            supersede(r.id, admin2),
            successor(r.id, f, admin2, { sources: [f.account, extra], integrations: [f.source, f.source] }),
          ],
          chainRefused,
        )
      })

      it('G6: superseding a rolled-back or released row fails at COMMIT', async () => {
        for (const action of ['rollback', 'release'] as const) {
          const { f, r, admin2 } = await setup()
          const preview = await previewDingTalkRepairRecovery(r.id, f.admin, f.password, action)
          await (action === 'release' ? releaseDingTalkRepair : rollbackDingTalkRepair)(
            r.id,
            f.admin,
            preview.digest,
            action,
            f.password,
          )
          await expectNothingPersisted(
            f,
            r.id,
            () => [
              [
                "UPDATE dingtalk_login_repairs SET state='superseded',released_account_ids=NULL WHERE id=$1",
                [r.id],
              ],
              successor(r.id, f, admin2),
            ],
            chainRefused,
          )
        }
      })

      it('G7: a successor of a released row (no supersede) fails at COMMIT', async () => {
        const { f, r, admin2 } = await setup()
        const preview = await releasePreview(f, r.id)
        await releaseWith(f, r.id, preview.digest)
        await expectNothingPersisted(f, r.id, () => [successor(r.id, f, admin2)], {
          code: '55000',
          message: 'a login repair successor must continue a superseded repair',
          stage: 'COMMIT',
        })
        // A rolled-back predecessor is refused the same way.
        const g = await setup()
        const back = await previewDingTalkRepairRecovery(g.r.id, g.f.admin, g.f.password, 'rollback')
        await rollbackDingTalkRepair(g.r.id, g.f.admin, back.digest, 'rollback', g.f.password)
        await expectNothingPersisted(g.f, g.r.id, () => [successor(g.r.id, g.f, g.admin2)], {
          code: '55000',
          message: 'a login repair successor must continue a superseded repair',
          stage: 'COMMIT',
        })
      })

      it('G8: a successor inserted while its predecessor is still applied hits the one-applied index', async () => {
        const { f, r, admin2 } = await setup()
        await expectNothingPersisted(f, r.id, () => [successor(r.id, f, admin2)], {
          code: '23505',
          constraint: 'dingtalk_login_repairs_active',
          stage: 'statement 0',
        })
      })

      it('G9: a predecessor is continued by at most one successor', async () => {
        const { f, r, admin2 } = await setup()
        const first = randomUUID()
        await viaClient([supersede(r.id, admin2), successor(r.id, f, admin2, { id: first })])
        await query(
          "UPDATE dingtalk_login_repairs SET state='rolled_back',rollback_actor_id=$2,rolled_back_at=now() WHERE id=$1",
          [first, admin2],
        )
        await expectNothingPersisted(f, r.id, () => [successor(r.id, f, admin2)], {
          code: '23505',
          constraint: 'dingtalk_login_repairs_supersedes_id_key',
          stage: 'statement 0',
        })
      })

      it('G10: CHECKs refuse an approver equal to the actor or the target, an actor equal to the target, and unpaired columns', async () => {
        const { f, r, admin2 } = await setup()
        for (const o of [
          { approver: f.admin },
          { approver: f.user },
          { actor: f.user },
          { approver: null },
        ] as Over[])
          await expectNothingPersisted(f, r.id, () => [supersede(r.id, admin2), successor(r.id, f, admin2, o)], {
            code: '23514',
            stage: 'statement 1',
          })
        // An approver without supersedes_id (a non-applied copy, so the applied index stays out of the way).
        await expectNothingPersisted(
          f,
          r.id,
          () => [successor(r.id, f, admin2, { supersedes: null, state: 'rolled_back' })],
          { code: '23514', stage: 'statement 0' },
        )
        // A superseded row without who ended it.
        await expectNothingPersisted(
          f,
          r.id,
          () => [["UPDATE dingtalk_login_repairs SET state='superseded' WHERE id=$1", [r.id]]],
          { code: '23514', stage: 'statement 0' },
        )
      })

      it('G11: a predecessor that has a successor cannot be deleted', async () => {
        const { f, r, admin2 } = await setup()
        await viaClient([supersede(r.id, admin2), successor(r.id, f, admin2)])
        await expect(query('DELETE FROM dingtalk_login_repairs WHERE id=$1', [r.id])).rejects.toMatchObject({
          code: '23503',
          constraint: 'dingtalk_login_repairs_supersedes_id_fkey',
        })
      })

      it('G12: a later reseal-shaped update of the superseded row or the successor does not fire the guard', async () => {
        const { f, r, admin2 } = await setup()
        const id = randomUUID()
        await viaClient([supersede(r.id, admin2), successor(r.id, f, admin2, { id })])
        await expect(
          query('UPDATE dingtalk_login_repairs SET before_identity=before_identity WHERE id=$1', [r.id]),
        ).resolves.toBeDefined()
        await expect(
          query('UPDATE dingtalk_login_repairs SET before_identity=before_identity WHERE id=$1', [id]),
        ).resolves.toBeDefined()
        await expect(
          viaWrapper([['UPDATE dingtalk_login_repairs SET before_identity=before_identity WHERE id=ANY($1::uuid[])', [[r.id, id]]]]),
        ).resolves.toBeUndefined()
      })
    })

    describe('after a re-anchor', () => {
      it('A1: rollback of the successor restores the chain root\'s pre-repair identity and ends the fence', async () => {
        const { f, r } = await loginAppSwitched()
        const flow = await reanchorFlow(f, r.id, 'synthetic-scan')
        expect((await exchangeCodeForUser('synthetic-fresh')).localUserId).toBe(f.user)
        const preview = await previewDingTalkRepairRecovery(flow.done.id, f.admin, f.password, 'rollback')
        const credentials = await liveCredentials(f)
        await rollbackDingTalkRepair(flow.done.id, f.admin, preview.digest, 'rollback', f.password)
        await credentials.expectRevoked()
        expect((await identityOf(f.user))[0].row).toMatchObject(originalIdentityShape(f))
        expect(await repairRow(flow.done.id)).toMatchObject({ state: 'rolled_back' })
        expect(await repairRow(r.id)).toMatchObject({ state: 'superseded' })
        const second = await addAccount(f.source, f.corp, 'a1-' + f.user, { union: 'new-union-' + f.user })
        await expect(link(second, f.user)).resolves.toBeDefined()
      })

      it('A2: the superseded predecessor id refuses REPAIR_NOT_ACTIVE for release, rollback and re-anchor', async () => {
        const { f, r } = await loginAppSwitched()
        const flow = await reanchorFlow(f, r.id, 'synthetic-scan')
        const before = await capture(f, r.id)
        await expect(releasePreview(f, r.id)).rejects.toThrow(exact('REPAIR_NOT_ACTIVE'))
        await expect(
          previewDingTalkRepairRecovery(r.id, f.admin, f.password, 'rollback'),
        ).rejects.toThrow(exact('REPAIR_NOT_ACTIVE'))
        await expect(requestReanchor(f, r.id, flow.approver, f.admin, 'synthetic-scan')).rejects.toThrow(
          exact('REPAIR_NOT_ACTIVE'),
        )
        expect(await capture(f, r.id)).toEqual(before)
        // The successor itself is a healthy repair now: no second re-anchor of it.
        await expectRefusedWithoutWriteOn(
          f,
          flow.done.id,
          () => requestReanchor(f, flow.done.id, flow.approver, f.admin, 'synthetic-scan'),
          'REPAIR_REANCHOR_NOT_NEEDED',
        )
      })

      it('A3: the fence follows the successor\'s sources before its release', async () => {
        {
          const { f, r, stale } = await journalSourceOccupied()
          await reanchorFlow(f, r.id)
          await query(
            "UPDATE directory_account_links SET local_user_id=NULL,link_status='unmatched' WHERE directory_account_id=$1",
            [stale],
          )
          await expect(link(stale, f.user)).rejects.toMatchObject({
            code: '55000',
            message: 'repair blocks a second directory source',
          })
        }
        {
          const { f, r, x } = await recordedRowReplaced()
          await reanchorFlow(f, r.id)
          await expect(link(x, f.user)).resolves.toBeDefined()
        }
      })

      it('A4: the successor blocks a handover of the anchor\'s integration', async () => {
        const { f, r, i2 } = await recordedRowReplaced()
        await reanchorFlow(f, r.id)
        const target = await addIntegration(f, 'handover-target')
        await expect(
          applyDirectoryHandover(
            { sourceIntegrationId: i2, targetIntegrationId: target },
            'unused-before-preflight',
            f.admin,
          ),
        ).rejects.toThrow('Active login repair blocks handover')
      })

      it('A5: the generation bump fences a stale repeatable-read writer through the link fence', async () => {
        const { f, r, stale } = await journalSourceOccupied(),
          b = await secondAdmin(f)
        const req = await requestReanchor(f, r.id, b)
        const c = await pool!.connect()
        try {
          await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
          await c.query('SELECT id FROM users WHERE id=$1', [f.user])
          await reanchorWith(f, req.request, b, req.summary.digest)
          await expect(
            c.query(
              "UPDATE directory_account_links SET local_user_id=$2,link_status='linked' WHERE directory_account_id=$1",
              [stale, f.user],
            ),
          ).rejects.toMatchObject({ code: '40001' })
        } finally {
          await c.query('ROLLBACK').catch(() => undefined)
          c.release()
        }
      })

      it('A6: the old login app is refused again after a re-anchor to the new one', async () => {
        const { f, r } = await loginAppSwitched()
        await reanchorFlow(f, r.id, 'synthetic-scan')
        provider.config.mockReturnValue({
          corpId: f.corp,
          clientId: 'synthetic-current-app',
          clientSecret: 'unused',
          redirectUri: 'https://example.test/callback',
        })
        await expect(exchangeCodeForUser('synthetic-old-app')).rejects.toMatchObject({
          statusCode: 409,
          code: 'repair_identity_mismatch',
        })
      })

      it('A7: a re-anchor writes no identity, grant, link, directory, membership, permission or evidence row', async () => {
        const { f, r } = await loginAppSwitched()
        // Unresolved revocation evidence does not refuse a re-anchor, and the re-anchor never supersedes it.
        await query(
          `INSERT INTO directory_deprovision_events(org_id,integration_id,directory_account_id,local_user_id,triggered_by,event_origin,link_witness_account_id,link_witness_local_user_id,policy,globally_clear,access_generation_at_apply,status) VALUES($1,$2,$3,$4,$5,'admin_manual',$3,$4,'mark_inactive',true,0,'applied')`,
          [f.org, f.source, f.account, f.user, f.admin],
        )
        const before = await untouchedByReanchor(f)
        expect(before.events).toHaveLength(1)
        const flow = await reanchorFlow(f, r.id, 'synthetic-scan')
        expect(await untouchedByReanchor(f)).toEqual(before)
        expect(flow.done.identityChanged).toBe(false)
      })
    })
  })

  describe('maintenance CLI process against the real database', () => {
    const backendRoot = fileURLToPath(new URL('../..', import.meta.url))
    const entry = path.join(backendRoot, 'scripts/dingtalk-login-repair.ts')
    const tsxLoader = createRequire(import.meta.url).resolve('tsx')
    /**
     * Explicit env only (no DB_QUERY_TIMEOUT from the runner): the CLI must preset its own floor.
     * DB_SLOW_MS=0 by default: every pool query then crosses the slow-query log threshold, so any
     * logger output that reached the process streams would break the exact stdout/stderr assertions.
     */
    const spawnCli = (f: Fixture, args: string[], extra: Record<string, string> = {}, viaPnpm = false) =>
      new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>((resolve, reject) => {
        const started = Date.now()
        // viaPnpm: the operator invocation the doc gives, `pnpm --silent ops:dingtalk-login-repair ...`.
        const [command, commandArgs] = viaPnpm
          ? ['pnpm', ['--silent', 'ops:dingtalk-login-repair', ...args]]
          : [process.execPath, ['--import', tsxLoader, entry, ...args]]
        const child = spawn(command, commandArgs, {
          cwd: backendRoot,
          env: {
            PATH: process.env.PATH ?? '',
            ...(viaPnpm && process.env.HOME ? { HOME: process.env.HOME } : {}),
            NODE_ENV: 'test',
            TSX_DISABLE_CACHE: '1',
            DB_SLOW_MS: '0',
            DATABASE_URL: String(process.env.DATABASE_URL),
            ENCRYPTION_KEY: String(process.env.ENCRYPTION_KEY),
            ENCRYPTION_SALT: String(process.env.ENCRYPTION_SALT),
            DINGTALK_CORP_ID: f.corp,
            DINGTALK_CLIENT_ID: 'synthetic-current-app',
            DINGTALK_CLIENT_SECRET: 'unused',
            DINGTALK_REDIRECT_URI: 'https://example.test/callback',
            ...extra,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = '',
          stderr = ''
        child.stdout.on('data', (d) => (stdout += d))
        child.stderr.on('data', (d) => (stderr += d))
        child.on('error', reject)
        child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }))
      })
    /** The CLI's backend once it waits on the maintenance LOCK TABLE behind the holder. */
    const waitingCliBackend = async (holderPid: number) => {
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        const row = (
          await query(
            `SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND pid<>$1 AND wait_event_type='Lock' AND query LIKE 'LOCK TABLE %' LIMIT 1`,
            [holderPid],
          )
        ).rows[0]
        if (row) return Number(row.pid)
        await new Promise((r) => setTimeout(r, 25))
      }
      throw new Error('the CLI backend never waited on the lock')
    }
    /** A TCP relay to the test database that can stop forwarding in both directions without closing. */
    const stallableRelay = async () => {
      const target = new URL(String(process.env.DATABASE_URL))
      const sockets: Socket[] = []
      let stalled = false
      const server = createServer((client) => {
        const upstream = connect(Number(target.port || 5432), target.hostname)
        sockets.push(client, upstream)
        client.on('data', (d) => {
          if (!stalled) upstream.write(d)
        })
        upstream.on('data', (d) => {
          if (!stalled) client.write(d)
        })
        // Once stalled, neither side learns anything about the other, not even a close.
        for (const [a, b] of [
          [client, upstream],
          [upstream, client],
        ] as const) {
          a.on('error', () => {
            if (!stalled) b.destroy()
          })
          a.on('close', () => {
            if (!stalled) b.destroy()
          })
        }
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
      const relayed = new URL(target.toString())
      relayed.hostname = '127.0.0.1'
      relayed.port = String((server.address() as AddressInfo).port)
      return {
        url: relayed.toString(),
        stall: () => {
          stalled = true
        },
        close: async () => {
          for (const s of sockets) s.destroy()
          await new Promise<void>((r) => server.close(() => r()))
        },
      }
    }
    let dir = ''
    const privateInput = async (name: string, body: Record<string, string>) => {
      if (!dir) dir = await mkdtemp(path.join(tmpdir(), 'login-repair-cli-db-'))
      const file = path.join(dir, name + '-' + randomUUID() + '.json')
      await writeFile(file, JSON.stringify(body))
      await chmod(file, 0o600)
      return file
    }
    afterAll(async () => {
      if (dir) await rm(dir, { recursive: true, force: true })
    })

    it('apply behind a conflicting lock exits 75 with only REPAIR_LOCK_BUSY and writes nothing', async () => {
      const f = await fixture(),
        proof = await f.verify(),
        p = await previewDingTalkRepair(proof)
      const input = await privateInput('apply', { proof, digest: p.digest, confirm: 'apply' })
      const identityBefore = (
        await query('SELECT to_jsonb(t) AS row FROM user_external_identities t WHERE local_user_id=$1', [f.user])
      ).rows
      // Same maintenance-shaped holder as the in-process lock tests.
      const holder = await pool!.connect()
      let r: Awaited<ReturnType<typeof spawnCli>>
      try {
        await holder.query('BEGIN')
        await holder.query('LOCK TABLE roles IN SHARE UPDATE EXCLUSIVE MODE')
        r = await spawnCli(f, ['apply', input])
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined)
        holder.release()
      }
      expect(r).toMatchObject({ code: 75, stdout: '', stderr: 'REPAIR_LOCK_BUSY\n' })
      expect(r.ms).toBeLessThan(20000)
      expect(
        (await query('SELECT id FROM dingtalk_login_repairs WHERE user_id=$1', [f.user])).rows,
      ).toEqual([])
      expect(
        (await query('SELECT to_jsonb(t) AS row FROM user_external_identities t WHERE local_user_id=$1', [f.user])).rows,
      ).toEqual(identityBefore)
      // Operator check after a non-zero exit: the same proof still previews, so apply did not commit.
      await expect(previewDingTalkRepair(proof)).resolves.toMatchObject({ digest: p.digest })
      // One manual retry once the holder is gone; afterwards the same proof's preview reports the commit.
      const retry = await spawnCli(f, ['apply', input])
      expect(retry).toMatchObject({ code: 0, stderr: '' })
      expect(JSON.parse(retry.stdout)).toMatchObject({ id: expect.any(String), clientQueryTimeoutMs: 45000 })
      await expect(previewDingTalkRepair(proof)).rejects.toThrow(exact('REPAIR_SNAPSHOT_CHANGED'))
    }, 60000)

    it('release-preview prints the plan and the effective client timeout; a wrong digest exits 1 with the exact code; the approved digest releases', async () => {
      const f = await fixture(),
        r = await applyRepair(f)
      const before = await capture(f, r.id)
      const preview = await spawnCli(f, [
        'release-preview',
        await privateInput('recovery', { id: r.id, actorId: f.admin, actorPassword: f.password }),
      ])
      expect(preview).toMatchObject({ code: 0, stderr: '' })
      const out = JSON.parse(preview.stdout)
      expect(out).toMatchObject({
        clientQueryTimeoutMs: 45000,
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        release: { mode: 'canonical', releasedAccountIds: [f.account], linkedDingTalkAccountIds: [f.account], localLinkCount: 0 },
      })
      // The CLI preview is the same pure preview: no journal, audit or session write.
      expect(await capture(f, r.id)).toEqual(before)
      const wrong = await spawnCli(f, [
        'release',
        await privateInput('release-wrong', {
          id: r.id,
          actorId: f.admin,
          actorPassword: f.password,
          digest: '0'.repeat(64),
          confirm: 'release',
        }),
      ])
      expect(wrong).toMatchObject({ code: 1, stdout: '', stderr: 'REPAIR_RECOVERY_SNAPSHOT_CHANGED\n' })
      expect(await capture(f, r.id)).toEqual(before)
      expect(await journalRow(r.id)).toMatchObject({ state: 'applied', released_account_ids: null })
      const done = await spawnCli(f, [
        'release',
        await privateInput('release', {
          id: r.id,
          actorId: f.admin,
          actorPassword: f.password,
          digest: out.digest,
          confirm: 'release',
        }),
      ])
      expect(done).toMatchObject({ code: 0, stderr: '' })
      expect(JSON.parse(done.stdout)).toMatchObject({ clientQueryTimeoutMs: 45000 })
      expect(await journalRow(r.id)).toMatchObject({ state: 'released', released_account_ids: [f.account] })
      // Operator check after the fact: the same preview now reports that the action committed.
      const again = await spawnCli(f, [
        'release-preview',
        await privateInput('recovery-again', { id: r.id, actorId: f.admin, actorPassword: f.password }),
      ])
      expect(again).toMatchObject({ code: 1, stdout: '', stderr: 'REPAIR_NOT_ACTIVE\n' })
    }, 90000)

    /** The deployment switched to the new login app (the in-process mock already reads 'next-app'). */
    const nextApp = { DINGTALK_CLIENT_ID: 'next-app' }
    /** R2 shape: applied repair, grant disabled, login app switched in place (termination, no scan). */
    const revokedSwitched = async () => {
      const f = await fixture(),
        r = await applyRepair(f)
      await query('UPDATE user_external_auth_grants SET enabled=false WHERE local_user_id=$1', [f.user])
      await switchLoginApp(f)
      return { f, r, approver: await secondAdmin(f) }
    }

    it('L1: reanchor-request writes a 0600 request file it never overwrites; the named approver previews (via `pnpm --silent`) and re-anchors', async () => {
      const { f, r, approver } = await revokedSwitched()
      const before = await capture(f, r.id)
      const input = await privateInput('reanchor-request', {
        id: r.id,
        actorId: f.admin,
        actorPassword: f.password,
        approverId: approver,
      })
      const out = path.join(dir, 'reanchor-request-' + randomUUID() + '.json')
      const requested = await spawnCli(f, ['reanchor-request', input, out], nextApp)
      expect(requested).toMatchObject({ code: 0, stderr: '' })
      const summary = JSON.parse(requested.stdout)
      expect(summary).toMatchObject({
        id: r.id,
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        preparerId: f.admin,
        approverId: approver,
        clientQueryTimeoutMs: 45000,
        identityChanged: false,
        permissionsChanged: false,
        reanchor: {
          releaseMode: 'termination',
          reasons: ['login_scope'],
          loginClientChanged: true,
          canonicalAccountId: f.account,
          sourceAccountIds: [f.account],
          scanRequired: false,
          scanned: false,
        },
      })
      expect((await stat(out)).mode & 0o777).toBe(0o600)
      const file = await readFile(out, 'utf8')
      expect(Object.keys(JSON.parse(file))).toEqual(['request'])
      const { request } = JSON.parse(file) as { request: string }
      expect(request).not.toContain(f.password)
      // The request writes no row: no journal, audit, session or generation change.
      expect(await capture(f, r.id)).toEqual(before)
      // An existing output file is never overwritten.
      const again = await spawnCli(f, ['reanchor-request', input, out], nextApp)
      expect(again).toMatchObject({ code: 1, stdout: '', stderr: 'REPAIR_INPUT_INVALID\n' })
      expect(await readFile(out, 'utf8')).toBe(file)
      expect(await capture(f, r.id)).toEqual(before)
      const previewInput = await privateInput('reanchor-preview', {
        request,
        actorId: approver,
        actorPassword: f.password,
      })
      const preview = await spawnCli(f, ['reanchor-preview', previewInput], nextApp, true)
      expect(preview).toMatchObject({ code: 0, stderr: '' })
      expect(preview.stdout.split('\n')).toHaveLength(2)
      expect(JSON.parse(preview.stdout)).toEqual(summary)
      expect(await capture(f, r.id)).toEqual(before)
      const credentials = await liveCredentials(f)
      const done = await spawnCli(
        f,
        [
          'reanchor',
          await privateInput('reanchor', {
            request,
            actorId: approver,
            actorPassword: f.password,
            digest: summary.digest,
            confirm: 'reanchor',
          }),
        ],
        nextApp,
      )
      expect(done).toMatchObject({ code: 0, stderr: '' })
      const result = JSON.parse(done.stdout)
      expect(result).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        predecessorId: r.id,
        releaseMode: 'termination',
        canonicalAccountId: f.account,
        loginClientChanged: true,
        identityChanged: false,
        permissionsChanged: false,
        targetSessionsRevoked: true,
        clientQueryTimeoutMs: 45000,
      })
      await credentials.expectRevoked()
      expect(await repairRow(r.id)).toMatchObject({ state: 'superseded', rollback_actor_id: approver })
      expect(await successorOf(r.id)).toEqual([
        expect.objectContaining({
          id: result.id,
          state: 'applied',
          supersedes_id: r.id,
          actor_id: f.admin,
          approver_id: approver,
          login_client_id: 'next-app',
          canonical_account_id: f.account,
          source_account_ids: [f.account],
        }),
      ])
      const details = {
        actorId: approver,
        preparerId: f.admin,
        approverId: approver,
        predecessorId: r.id,
        successorId: result.id,
        releaseMode: 'termination',
        reasons: ['login_scope'],
        scanned: false,
      }
      expect(await auditOf(result.id)).toEqual([{ action: 'reanchor', action_details: details }])
      expect(await auditOf(r.id)).toEqual([
        { action: 'apply', action_details: { actorId: f.admin } },
        { action: 'superseded', action_details: details },
      ])
      // Operator check after the fact (doc): the same request now reports that the re-anchor committed.
      const after = await spawnCli(f, ['reanchor-preview', previewInput], nextApp)
      expect(after).toMatchObject({ code: 1, stdout: '', stderr: 'REPAIR_NOT_ACTIVE\n' })
      const releasePlan = await releasePreview(f, result.id)
      expect(releasePlan.release).toMatchObject({ mode: 'termination', releasedAccountIds: [f.account] })
      await expectAllowedRelease(f, result.id, releasePlan.digest, 'termination')
    }, 120000)

    it('L2: reanchor or reanchor-preview by anyone but the named approver, or with another digest, exits 1 with exactly one code and writes nothing', async () => {
      const { f, r, approver } = await revokedSwitched()
      const third = await secondAdmin(f)
      const { request, summary } = await requestReanchor(f, r.id, approver)
      const before = await capture(f, r.id)
      const execute = (actorId: string, digest: string) =>
        privateInput('reanchor-l2', { request, actorId, actorPassword: f.password, digest, confirm: 'reanchor' })
      const cases: [string, string[], string][] = [
        ['preparer executes', ['reanchor', await execute(f.admin, summary.digest)], 'REPAIR_DUAL_CONTROL_REQUIRED'],
        ['third admin executes', ['reanchor', await execute(third, summary.digest)], 'REPAIR_DUAL_CONTROL_REQUIRED'],
        [
          'preparer previews',
          ['reanchor-preview', await privateInput('reanchor-l2-preview', { request, actorId: f.admin, actorPassword: f.password })],
          'REPAIR_DUAL_CONTROL_REQUIRED',
        ],
        ['another digest', ['reanchor', await execute(approver, '0'.repeat(64))], 'REPAIR_APPROVAL_REQUIRED'],
      ]
      for (const [name, args, code] of cases) {
        const run = await spawnCli(f, args, nextApp)
        expect({ name, ...run, ms: 0 }).toEqual({ name, code: 1, stdout: '', stderr: code + '\n', ms: 0 })
      }
      expect(await capture(f, r.id)).toEqual(before)
      expect(await successorOf(r.id)).toEqual([])
      expect(await journalRow(r.id)).toMatchObject({ state: 'applied', released_account_ids: null })
    }, 120000)

    it('L3: a request sealed in process after a scan is previewed and executed by the child only under the same login scope; the first login then advances the pin', async () => {
      const f = await fixture(),
        r = await applyRepair(f)
      await switchLoginApp(f)
      const approver = await secondAdmin(f)
      const { request, summary } = await requestReanchor(f, r.id, approver, f.admin, 'synthetic-scan')
      expect(summary.reanchor).toMatchObject({ releaseMode: 'canonical', scanRequired: true, scanned: true })
      // The in-process scope hash is the one the child computes from its own env (corp + DINGTALK_CLIENT_ID).
      const sealed = JSON.parse(decryptStoredSecretValue(request))
      expect(sealed.scope).toBe(createHash('sha256').update(JSON.stringify([f.corp, 'next-app'])).digest('hex'))
      const previewInput = await privateInput('reanchor-l3-preview', { request, actorId: approver, actorPassword: f.password })
      const before = await capture(f, r.id)
      // Under the old app the child's scope differs and the request is refused.
      const oldApp = await spawnCli(f, ['reanchor-preview', previewInput])
      expect(oldApp).toMatchObject({ code: 1, stdout: '', stderr: 'REPAIR_PROOF_INVALID\n' })
      const preview = await spawnCli(f, ['reanchor-preview', previewInput], nextApp)
      expect(preview).toMatchObject({ code: 0, stderr: '' })
      expect(JSON.parse(preview.stdout)).toEqual({ ...summary, clientQueryTimeoutMs: 45000 })
      expect(await capture(f, r.id)).toEqual(before)
      const credentials = await liveCredentials(f)
      const done = await spawnCli(
        f,
        [
          'reanchor',
          await privateInput('reanchor-l3', {
            request,
            actorId: approver,
            actorPassword: f.password,
            digest: summary.digest,
            confirm: 'reanchor',
          }),
        ],
        nextApp,
      )
      expect(done).toMatchObject({ code: 0, stderr: '' })
      const result = JSON.parse(done.stdout)
      expect(result).toMatchObject({ predecessorId: r.id, releaseMode: 'canonical', loginClientChanged: true, clientQueryTimeoutMs: 45000 })
      await credentials.expectRevoked()
      expect((await repairRow(result.id)).login_client_id).toBe('next-app')
      expect((await exchangeCodeForUser('synthetic-fresh')).localUserId).toBe(f.user)
      expect((await repairRow(result.id)).expected_identity).toMatchObject({ provider_open_id: 'next-open-' + f.user })
    }, 120000)

    it('through the documented `pnpm --silent` invocation: stdout is exactly the JSON on success, and a lock refusal keeps exit 75 and one code', async () => {
      const f = await fixture(),
        r = await applyRepair(f)
      const preview = await spawnCli(
        f,
        ['release-preview', await privateInput('recovery-pnpm', { id: r.id, actorId: f.admin, actorPassword: f.password })],
        {},
        true,
      )
      expect(preview).toMatchObject({ code: 0, stderr: '' })
      expect(preview.stdout.split('\n')).toHaveLength(2)
      expect(JSON.parse(preview.stdout)).toMatchObject({ clientQueryTimeoutMs: 45000, release: { mode: 'canonical' } })
      const holder = await pool!.connect()
      let busy: Awaited<ReturnType<typeof spawnCli>>
      try {
        await holder.query('BEGIN')
        await holder.query('LOCK TABLE roles IN SHARE UPDATE EXCLUSIVE MODE')
        busy = await spawnCli(
          f,
          [
            'release',
            await privateInput('release-pnpm', {
              id: r.id,
              actorId: f.admin,
              actorPassword: f.password,
              digest: JSON.parse(preview.stdout).digest,
              confirm: 'release',
            }),
          ],
          {},
          true,
        )
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined)
        holder.release()
      }
      expect(busy).toMatchObject({ code: 75, stdout: '', stderr: 'REPAIR_LOCK_BUSY\n' })
      expect(await journalRow(r.id)).toMatchObject({ state: 'applied', released_account_ids: null })
    }, 90000)

    it('a client timeout above 2^31-1 ms refuses before connecting instead of ending every query at once (exit 69)', async () => {
      const f = await fixture(),
        r = await applyRepair(f)
      const before = await capture(f, r.id)
      const input = await privateInput('recovery-max', { id: r.id, actorId: f.admin, actorPassword: f.password })
      for (const extra of [{ DB_STATEMENT_TIMEOUT: '2147483647' }, { DB_QUERY_TIMEOUT: '2147483648' }, { DB_QUERY_TIMEOUT: '9999999999' }]) {
        const refused = await spawnCli(f, ['release-preview', input], extra)
        expect({ extra, ...refused, ms: 0 }).toEqual({ extra, code: 1, stdout: '', stderr: 'REPAIR_CLIENT_TIMEOUT_TOO_HIGH\n', ms: 0 })
      }
      // The largest delay Node arms as given is accepted, and pg's read timer then does not fire early.
      const max = await spawnCli(f, ['release-preview', input], { DB_QUERY_TIMEOUT: '2147483647' })
      expect(max).toMatchObject({ code: 0, stderr: '' })
      expect(JSON.parse(max.stdout)).toMatchObject({ clientQueryTimeoutMs: 2147483647, release: { mode: 'canonical' } })
      expect(await capture(f, r.id)).toEqual(before)
    }, 90000)

    it('a verify refusal prints only its code although every query of the run is logged as slow', async () => {
      const f = await fixture()
      const input = await privateInput('verify', {
        userId: f.user,
        password: f.password,
        code: 'synthetic-code',
        actorId: randomUUID(),
        actorPassword: f.password,
      })
      const out = path.join(dir, 'proof-' + randomUUID() + '.json')
      const r = await spawnCli(f, ['verify', input, out])
      expect(r).toMatchObject({ code: 1, stdout: '', stderr: 'REPAIR_OPERATOR_REQUIRED\n' })
      await expect(readFile(out)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 60000)

    it('a connection terminated while the CLI waits for the lock prints only the generic code and writes nothing', async () => {
      const f = await fixture(),
        proof = await f.verify(),
        p = await previewDingTalkRepair(proof)
      const input = await privateInput('apply-terminated', { proof, digest: p.digest, confirm: 'apply' })
      const before = await capture(f, randomUUID())
      const holder = await pool!.connect()
      let r: Awaited<ReturnType<typeof spawnCli>>
      try {
        await holder.query('BEGIN')
        await holder.query('LOCK TABLE roles IN SHARE UPDATE EXCLUSIVE MODE')
        const holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        const running = spawnCli(f, ['apply', input])
        const cliPid = await waitingCliBackend(holderPid)
        expect((await query('SELECT pg_terminate_backend($1) AS ok', [cliPid])).rows[0].ok).toBe(true)
        r = await running
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined)
        holder.release()
      }
      expect(r).toMatchObject({ code: 1, stdout: '', stderr: 'DINGTALK_LOGIN_REPAIR_REFUSED\n' })
      expect(await capture(f, randomUUID())).toEqual(before)
      expect((await query('SELECT id FROM dingtalk_login_repairs WHERE user_id=$1', [f.user])).rows).toEqual([])
      // Operator check after the non-zero exit: the same proof still previews, so apply did not commit.
      await expect(previewDingTalkRepair(proof)).resolves.toMatchObject({ digest: p.digest })
    }, 60000)

    it('a connection that stops answering ends at the client read timeout: only REPAIR_CLIENT_TIMEOUT (exit 69), the failed ROLLBACK is not printed', async () => {
      const f = await fixture(),
        proof = await f.verify(),
        p = await previewDingTalkRepair(proof)
      const input = await privateInput('apply-stalled', { proof, digest: p.digest, confirm: 'apply' })
      const before = await capture(f, randomUUID())
      const relay = await stallableRelay()
      const holder = await pool!.connect()
      let r: Awaited<ReturnType<typeof spawnCli>>
      try {
        let running: ReturnType<typeof spawnCli>
        try {
          await holder.query('BEGIN')
          await holder.query('LOCK TABLE roles IN SHARE UPDATE EXCLUSIVE MODE')
          const holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
          running = spawnCli(f, ['apply', input], { DATABASE_URL: relay.url })
          const cliPid = await waitingCliBackend(holderPid)
          // Partition: the CLI keeps an open socket that never answers; the server side ends now, so
          // nothing stays locked while the client waits out its read timeout twice (LOCK TABLE, ROLLBACK).
          relay.stall()
          expect((await query('SELECT pg_terminate_backend($1) AS ok', [cliPid])).rows[0].ok).toBe(true)
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined)
          holder.release()
        }
        r = await running
      } finally {
        await relay.close()
      }
      expect(r).toMatchObject({ code: 69, stdout: '', stderr: 'REPAIR_CLIENT_TIMEOUT\n' })
      // Two consecutive 45 s read timeouts: the wrapper's ROLLBACK ran (and failed) before the exit.
      expect(r.ms).toBeGreaterThan(89000)
      expect(await capture(f, randomUUID())).toEqual(before)
      expect((await query('SELECT id FROM dingtalk_login_repairs WHERE user_id=$1', [f.user])).rows).toEqual([])
      await expect(previewDingTalkRepair(proof)).resolves.toMatchObject({ digest: p.digest })
    }, 150000)
  })
})
