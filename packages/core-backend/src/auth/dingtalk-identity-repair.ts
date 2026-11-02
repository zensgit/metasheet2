/** Privileged operator workflow. Never exposed as a public login or self-bind API. */
import { createHash, randomUUID } from 'node:crypto'
import * as bcrypt from 'bcryptjs'
import { query, transaction } from '../db/pg'
import { evaluateUserAuthenticationGate } from './user-activation'
import {
  lockUsersForAccessGraphWrite,
  supersedeDeprovisionEvidenceForAccessGraphWrite,
} from '../directory/access-graph-mutex'
import { readDingTalkOauthConfig } from '../integrations/dingtalk/client'
import { exchangeCodeForDingTalkProfile } from './dingtalk-oauth'
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
  getEncryptionMaterialIssues,
  isEncryptedSecretValue,
} from '../security/encrypted-secrets'

type Row = Record<string, unknown>
type Client = {
  query: (sql: string, args?: unknown[]) => Promise<{ rows: Row[] }>
}
type Proof = {
  purpose: string
  nonce: string
  expires: number
  actorId: string
  userId: string
  scope: string
  before: string
  identity: Row
}
const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
          .join(',')}}`
      : JSON.stringify(v)
const digest = (v: unknown) =>
  createHash('sha256').update(canonical(v)).digest('hex')
function requireRepair(value: unknown): asserts value {
  if (!value) throw new Error('DINGTALK_IDENTITY_REPAIR_REFUSED')
}
function scope() {
  const cfg = readDingTalkOauthConfig()
  requireRepair(cfg.corpId && getEncryptionMaterialIssues().length === 0)
  return { cfg, hash: digest([cfg.corpId, cfg.clientId]) }
}
async function operator(c: Client, id: string) {
  const r = await c.query(
    `SELECT id, role, is_active, activation_status FROM users WHERE id=$1 AND is_active=true AND activation_status='activated'
    AND (is_admin=true OR EXISTS(SELECT 1 FROM user_roles r WHERE r.user_id=users.id AND r.role_id='admin'))`,
    [id],
  )
  requireRepair(
    r.rows.length === 1 &&
      !evaluateUserAuthenticationGate({
        is_active: r.rows[0].is_active as boolean,
        role: String(r.rows[0].role),
        activation_status: String(r.rows[0].activation_status),
      }),
  )
}
async function snapshot(c: Client, userId: string) {
  const user = (
    await c.query('SELECT to_jsonb(u) AS row FROM users u WHERE id=$1', [
      userId,
    ])
  ).rows[0]?.row as Row | undefined
  requireRepair(
    user && user.is_active === true && user.activation_status === 'activated',
  )
  requireRepair(
    !evaluateUserAuthenticationGate({
      is_active: user.is_active as boolean,
      role: String(user.role),
      activation_status: String(user.activation_status),
    }),
  )
  requireRepair(!user.deleted_at && !user.purged_at)
  const { last_login_at: _login, updated_at: _updated, ...stableUser } = user
  const authority: unknown[] = [stableUser]
  for (const [table, key] of [
    ['user_roles', 'user_id'],
    ['user_permissions', 'user_id'],
    ['user_orgs', 'user_id'],
    ['user_external_auth_grants', 'local_user_id'],
    ['directory_account_links', 'local_user_id'],
  ]) {
    authority.push(
      (
        await c.query(
          `SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${key}=$1 ORDER BY to_jsonb(t)::text`,
          [userId],
        )
      ).rows.map((r) => r.row),
    )
  }
  for (const table of ['roles', 'role_permissions']) {
    const key = table === 'roles' ? 'id' : 'role_id'
    authority.push(
      (
        await c.query(
          `SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${key} IN (SELECT role_id FROM user_roles WHERE user_id=$1) ORDER BY to_jsonb(t)::text`,
          [userId],
        )
      ).rows.map((r) => r.row),
    )
  }
  const identities = (
    await c.query(
      "SELECT * FROM user_external_identities WHERE provider='dingtalk' AND local_user_id=$1",
      [userId],
    )
  ).rows
  requireRepair(identities.length === 1)
  const grants = await c.query(
    "SELECT enabled FROM user_external_auth_grants WHERE provider='dingtalk' AND local_user_id=$1",
    [userId],
  )
  requireRepair(grants.rows.length === 1 && grants.rows[0].enabled === true)
  const identity = identities[0]
  return {
    authority,
    identity,
    hash: digest([
      authority,
      [
        identity.id,
        identity.external_key,
        identity.corp_id,
        identity.provider_open_id,
        identity.provider_union_id,
      ],
    ]),
  }
}
function open(proof: string): Proof {
  requireRepair(isEncryptedSecretValue(proof))
  const p = JSON.parse(decryptStoredSecretValue(proof)) as Proof
  requireRepair(
    p.purpose === 'dingtalk-login-repair-v1' &&
      p.expires > Date.now() &&
      p.expires <= Date.now() + 300000 &&
      p.scope === scope().hash,
  )
  return p
}
/** Dual control: target local password + fresh provider code, then explicit administrator approval.
 * Returns encrypted, five-minute evidence only; does not issue sessions or write business rows.
 */
export async function verifyDingTalkRepair(
  userId: string,
  password: string,
  code: string,
  actorId: string,
) {
  const { cfg, hash } = scope()
  await operator({ query }, actorId)
  const before = await snapshot({ query }, userId)
  requireRepair(before.identity.corp_id === cfg.corpId)
  const user = before.authority[0] as Row
  requireRepair(
    user.local_password_set === true &&
      typeof user.password_hash === 'string' &&
      (await bcrypt.compare(password, user.password_hash)),
  )
  // The credential request is made only after local ownership and operator checks pass.
  const dt = await exchangeCodeForDingTalkProfile(code)
  requireRepair(dt.openId && dt.unionId)
  const p: Proof = {
    purpose: 'dingtalk-login-repair-v1',
    nonce: randomUUID(),
    expires: Date.now() + 300000,
    actorId,
    userId,
    scope: hash,
    before: before.hash,
    identity: {
      corp_id: cfg.corpId,
      provider_open_id: dt.openId,
      provider_union_id: dt.unionId,
      external_key: `${cfg.corpId}:${dt.openId}`,
    },
  }
  return encryptStoredSecretValue(JSON.stringify(p))
}
async function locked(c: Client, p: Proof) {
  await c.query("SET LOCAL lock_timeout='5s'")
  await c.query("SET LOCAL statement_timeout='30s'")
  // Legacy authority writers do not all participate in the user mutex. Fail rather than certify a stale approval.
  await c.query(
    'LOCK TABLE users,user_roles,user_permissions,user_orgs,user_external_auth_grants,directory_account_links,user_external_identities,roles,role_permissions,permissions IN SHARE ROW EXCLUSIVE MODE NOWAIT',
  )
  await lockUsersForAccessGraphWrite(c, [p.userId, p.actorId].sort())
  await operator(c, p.actorId)
  const current = await snapshot(c, p.userId)
  requireRepair(current.hash === p.before)
  const conflict = await c.query(
    `SELECT id FROM user_external_identities WHERE provider='dingtalk' AND local_user_id<>$1
    AND (external_key=$2 OR (corp_id=$3 AND (provider_open_id=$4 OR provider_union_id=$5)))`,
    [
      p.userId,
      p.identity.external_key,
      p.identity.corp_id,
      p.identity.provider_open_id,
      p.identity.provider_union_id,
    ],
  )
  requireRepair(conflict.rows.length === 0)
  const unresolved = await c.query(
    "SELECT id FROM directory_deprovision_effects WHERE local_user_id=$1 AND status='applied' UNION ALL SELECT id FROM directory_deprovision_events WHERE local_user_id=$1 AND status='applied' LIMIT 1",
    [p.userId],
  )
  requireRepair(unresolved.rows.length === 0)
  const journal = await c.query(
    "SELECT id FROM dingtalk_login_repairs WHERE user_id=$1 AND state='applied'",
    [p.userId],
  )
  requireRepair(journal.rows.length === 0)
  return current
}
export async function previewDingTalkRepair(proof: string) {
  const p = open(proof)
  return transaction(async (c) => {
    await locked(c, p)
    return {
      digest: digest(p),
      expires: p.expires,
      accountCount: 1,
      permissionsChanged: false,
    }
  })
}
export async function applyDingTalkRepair(
  proof: string,
  approvedDigest: string,
  confirm: string,
) {
  const p = open(proof)
  requireRepair(confirm === 'apply' && approvedDigest === digest(p))
  return transaction(async (c) => {
    const before = await locked(c, p)
    const id = randomUUID()
    // Journal also pins the new identity for every writer, including stale directory sync/rebinds.
    await c.query(
      `INSERT INTO dingtalk_login_repairs(id,user_id,proof_nonce,state,before_identity,expected_identity,after_digest,actor_id)
      VALUES($1,$2,$3,'applied',$4,$5,'pending',$6)`,
      [
        id,
        p.userId,
        p.nonce,
        encryptStoredSecretValue(JSON.stringify(before.identity)),
        p.identity,
        p.actorId,
      ],
    )
    await c.query(
      `UPDATE user_external_identities SET external_key=$2,corp_id=$3,provider_open_id=$4,provider_union_id=$5,updated_at=now()
      WHERE provider='dingtalk' AND local_user_id=$1`,
      [
        p.userId,
        p.identity.external_key,
        p.identity.corp_id,
        p.identity.provider_open_id,
        p.identity.provider_union_id,
      ],
    )
    // Monotonic generation fence also invalidates sessions issued under the old identity.
    await supersedeDeprovisionEvidenceForAccessGraphWrite(c, {
      userIds: [p.userId],
      actorId: p.actorId,
      reason: 'Controlled DingTalk login identity repair',
    })
    const after = await snapshot(c, p.userId)
    await c.query(
      'UPDATE dingtalk_login_repairs SET after_digest=$2 WHERE id=$1',
      [id, after.hash],
    )
    return {
      id,
      digest: after.hash,
      accountCount: 1,
      permissionsChanged: false,
    }
  })
}
export async function rollbackDingTalkRepair(
  id: string,
  actorId: string,
  approvedDigest: string,
  confirm: string,
) {
  requireRepair(confirm === 'rollback')
  scope()
  return transaction(async (c) => {
    await c.query("SET LOCAL lock_timeout='5s'")
    await c.query("SET LOCAL statement_timeout='30s'")
    await c.query(
      'LOCK TABLE users,user_roles,user_permissions,user_orgs,user_external_auth_grants,directory_account_links,user_external_identities,roles,role_permissions,permissions IN SHARE ROW EXCLUSIVE MODE NOWAIT',
    )
    const found = (
      await c.query(
        'SELECT * FROM dingtalk_login_repairs WHERE id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0]
    requireRepair(
      found &&
        found.state === 'applied' &&
        found.after_digest === approvedDigest,
    )
    await lockUsersForAccessGraphWrite(
      c,
      [String(found.user_id), actorId].sort(),
    )
    await operator(c, actorId)
    requireRepair(
      (await snapshot(c, String(found.user_id))).hash === approvedDigest,
    )
    const old = JSON.parse(
      decryptStoredSecretValue(String(found.before_identity)),
    ) as Row
    await c.query(
      "UPDATE dingtalk_login_repairs SET state='rolled_back',rollback_actor_id=$2,rolled_back_at=now() WHERE id=$1",
      [id, actorId],
    )
    await c.query(
      `UPDATE user_external_identities SET external_key=$2,corp_id=$3,provider_open_id=$4,provider_union_id=$5,profile=$6,bound_by=$7,updated_at=$8
      WHERE provider='dingtalk' AND local_user_id=$1`,
      [
        found.user_id,
        old.external_key,
        old.corp_id,
        old.provider_open_id,
        old.provider_union_id,
        old.profile,
        old.bound_by,
        old.updated_at,
      ],
    )
    await supersedeDeprovisionEvidenceForAccessGraphWrite(c, {
      userIds: [String(found.user_id)],
      actorId,
      reason: 'Controlled DingTalk login identity repair rollback',
    })
    // Reuse the session revocation registry in the SAME transaction; schema errors fail closed.
    // All target-account sessions are invalidated, including passwords sessions. Fresh password login remains available.
    await c.query(
      `INSERT INTO user_session_revocations(user_id,revoked_after,updated_at,updated_by,reason) VALUES($1,clock_timestamp(),clock_timestamp(),$2,'dingtalk_identity_repair_rollback')
      ON CONFLICT(user_id) DO UPDATE SET revoked_after=EXCLUDED.revoked_after,updated_at=EXCLUDED.updated_at,updated_by=EXCLUDED.updated_by,reason=EXCLUDED.reason`,
      [found.user_id, actorId],
    )
    return { id, rolledBack: true, targetSessionsRevoked: true }
  })
}
