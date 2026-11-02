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
  actorCredential: string
  userId: string
  scope: string
  before: string
  identity: Row
  scannerName: string
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
function requireRepair(
  v: unknown,
  code = 'DINGTALK_IDENTITY_REPAIR_REFUSED',
): asserts v {
  if (!v) throw new Error(code)
}
function scope() {
  const cfg = readDingTalkOauthConfig()
  requireRepair(cfg.corpId && getEncryptionMaterialIssues().length === 0)
  return { cfg, hash: digest([cfg.corpId, cfg.clientId]) }
}
const normalize = (r: Row) =>
  Object.fromEntries(
    Object.entries(r).filter(
      ([k]) => !['created_at', 'updated_at', 'last_login_at'].includes(k),
    ),
  )
const mask = (s: unknown) =>
  typeof s === 'string' && s.length ? s.slice(0, 1) + '***' : 'not-provided'
async function operator(c: Client, id: string, password?: string) {
  const r = (
    await c.query(
      `SELECT * FROM users WHERE id=$1 AND is_active=true AND activation_status='activated' AND (is_admin=true OR EXISTS(SELECT 1 FROM user_roles r WHERE r.user_id=users.id AND r.role_id='admin'))`,
      [id],
    )
  ).rows[0]
  requireRepair(
    r &&
      !r.must_change_password &&
      !r.deleted_at &&
      !r.purged_at &&
      !evaluateUserAuthenticationGate({
        is_active: r.is_active as boolean,
        role: String(r.role),
        activation_status: String(r.activation_status),
      }),
    'REPAIR_OPERATOR_REQUIRED',
  )
  if (password !== undefined)
    requireRepair(
      r.local_password_set === true &&
        typeof r.password_hash === 'string' &&
        (await bcrypt.compare(password, r.password_hash)),
      'REPAIR_OPERATOR_CREDENTIAL_REQUIRED',
    )
  return digest([
    r.password_hash,
    r.access_generation,
    r.activation_status,
    r.is_active,
  ])
}
async function snapshot(c: Client, userId: string) {
  const user = (
    await c.query('SELECT to_jsonb(u) AS row FROM users u WHERE id=$1', [
      userId,
    ])
  ).rows[0]?.row as Row | undefined
  requireRepair(user, 'REPAIR_TARGET_MISSING')
  const sections: Record<string, unknown> = { users: normalize(user) }
  for (const [table, key] of [
    ['user_roles', 'user_id'],
    ['user_permissions', 'user_id'],
    ['user_orgs', 'user_id'],
    ['user_namespace_admissions', 'user_id'],
    ['user_external_auth_grants', 'local_user_id'],
    ['directory_account_links', 'local_user_id'],
  ])
    sections[table] = (
      await c.query(
        `SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${key}=$1 ORDER BY to_jsonb(t)::text`,
        [userId],
      )
    ).rows.map((r) => normalize(r.row as Row))
  for (const table of ['roles', 'role_permissions'])
    sections[table] = (
      await c.query(
        `SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${table === 'roles' ? 'id' : 'role_id'} IN (SELECT role_id FROM user_roles WHERE user_id=$1) ORDER BY to_jsonb(t)::text`,
        [userId],
      )
    ).rows.map((r) => normalize(r.row as Row))
  const ids = (
    await c.query(
      "SELECT * FROM user_external_identities WHERE provider='dingtalk' AND local_user_id=$1",
      [userId],
    )
  ).rows
  requireRepair(ids.length <= 1, 'REPAIR_IDENTITY_AMBIGUOUS')
  const identity = ids[0] ?? null
  sections.identity = identity
    ? [
        identity.id,
        identity.external_key,
        identity.corp_id,
        identity.provider_open_id,
        identity.provider_union_id,
      ]
    : null
  const links = (
    await c.query(
      `SELECT a.id,a.integration_id,a.corp_id,a.union_id,a.open_id,a.is_active,i.status,i.config->>'appKey' AS app_key FROM directory_account_links l JOIN directory_accounts a ON a.id=l.directory_account_id JOIN directory_integrations i ON i.id=a.integration_id WHERE l.local_user_id=$1 AND l.link_status='linked' ORDER BY a.id`,
      [userId],
    )
  ).rows
  sections.sources = links.map(normalize)
  const grant =
    (
      await c.query(
        "SELECT enabled FROM user_external_auth_grants WHERE provider='dingtalk' AND local_user_id=$1",
        [userId],
      )
    ).rows[0]?.enabled === true
  return {
    user,
    sections,
    identity,
    links,
    grant,
    hash: digest(sections),
    segments: Object.fromEntries(
      Object.entries(sections).map(([k, v]) => [k, digest(v)]),
    ),
  }
}
function active(s: Awaited<ReturnType<typeof snapshot>>) {
  requireRepair(
    s.user.is_active === true &&
      !s.user.deleted_at &&
      !s.user.purged_at &&
      !evaluateUserAuthenticationGate({
        is_active: s.user.is_active as boolean,
        role: String(s.user.role),
        activation_status: String(s.user.activation_status),
      }) &&
      s.grant &&
      s.identity,
    'REPAIR_TARGET_NOT_ENABLED',
  )
}
async function noHandover(c: Client, userId: string, extra: unknown[] = []) {
  const r = await c.query(
    `SELECT h.id FROM directory_handovers h WHERE h.state='applied' AND (h.source_integration_id=ANY($2::uuid[]) OR h.target_integration_id=ANY($2::uuid[]) OR EXISTS(SELECT 1 FROM directory_accounts a LEFT JOIN directory_account_links l ON l.directory_account_id=a.id WHERE (l.local_user_id=$1 OR a.integration_id=ANY($2::uuid[])) AND a.integration_id IN (h.source_integration_id,h.target_integration_id))) LIMIT 1`,
    [userId, extra],
  )
  requireRepair(!r.rows.length, 'REPAIR_HANDOVER_ACTIVE')
}
async function ownership(c: Client, p: Proof, links: Row[]) {
  const rows = (
    await c.query(
      `SELECT a.id,a.union_id,a.open_id,l.local_user_id,l.link_status,a.name,a.is_active,i.status,i.config->>'appKey' AS app_key FROM directory_accounts a JOIN directory_integrations i ON i.id=a.integration_id LEFT JOIN directory_account_links l ON l.directory_account_id=a.id WHERE a.provider='dingtalk' AND a.corp_id=$1 AND (a.union_id=$2 OR (a.open_id IS NOT NULL AND a.open_id=$3))`,
      [
        p.identity.corp_id,
        p.identity.provider_union_id,
        p.identity.provider_open_id,
      ],
    )
  ).rows
  requireRepair(
    rows.length > 0 &&
      !rows.some((r) => r.local_user_id && r.local_user_id !== p.userId),
    'REPAIR_DIRECTORY_OWNER_CONFLICT',
  )
  requireRepair(
    links
      .filter((link) => link.is_active === true && link.status === 'active')
      .every(
        (link) =>
          link.corp_id === p.identity.corp_id &&
          (link.union_id
            ? link.union_id === p.identity.provider_union_id
            : link.app_key === scope().cfg.clientId &&
              link.open_id === p.identity.provider_open_id),
      ),
    'REPAIR_DIRECTORY_PERSON_AMBIGUOUS',
  )
  requireRepair(
    rows.some(
      (r) =>
        r.local_user_id === p.userId &&
        r.link_status === 'linked' &&
        r.is_active === true &&
        r.status === 'active' &&
        r.app_key === scope().cfg.clientId &&
        (!r.union_id || r.union_id === p.identity.provider_union_id),
    ),
    'REPAIR_PERSON_NOT_PROVEN',
  )
}
function open(proof: string): Proof {
  requireRepair(isEncryptedSecretValue(proof))
  const p = JSON.parse(decryptStoredSecretValue(proof)) as Proof
  requireRepair(
    p.purpose === 'dingtalk-login-repair-v2' &&
      p.expires > Date.now() &&
      p.expires <= Date.now() + 300000 &&
      p.scope === scope().hash,
    'REPAIR_PROOF_INVALID',
  )
  return p
}
/** Requires both local credentials and an unambiguous directory ownership witness. Unknown persons fail closed. */
export async function verifyDingTalkRepair(
  userId: string,
  password: string,
  code: string,
  actorId: string,
  actorPassword: string,
) {
  const { cfg, hash } = scope()
  const actorCredential = await operator({ query }, actorId, actorPassword)
  const before = await snapshot({ query }, userId)
  active(before)
  await noHandover({ query }, userId)
  requireRepair(
    before.identity?.corp_id === cfg.corpId &&
      !before.user.must_change_password &&
      before.user.local_password_set === true &&
      typeof before.user.password_hash === 'string' &&
      (await bcrypt.compare(password, before.user.password_hash)),
    'REPAIR_TARGET_CREDENTIAL_REQUIRED',
  )
  const dt = await exchangeCodeForDingTalkProfile(code)
  requireRepair(dt.openId && dt.unionId, 'REPAIR_PROFILE_INCOMPLETE')
  const p: Proof = {
    purpose: 'dingtalk-login-repair-v2',
    nonce: randomUUID(),
    expires: Date.now() + 300000,
    actorId,
    actorCredential,
    userId,
    scope: hash,
    before: before.hash,
    scannerName: dt.nick ?? '',
    identity: {
      corp_id: cfg.corpId,
      provider_open_id: dt.openId,
      provider_union_id: dt.unionId,
      external_key: `${cfg.corpId}:${dt.openId}`,
    },
  }
  await ownership({ query }, p, before.links)
  return encryptStoredSecretValue(JSON.stringify(p))
}
async function checks(c: Client, p: Proof) {
  requireRepair(
    (await operator(c, p.actorId)) === p.actorCredential,
    'REPAIR_OPERATOR_CHANGED',
  )
  await noHandover(c, p.userId)
  const s = await snapshot(c, p.userId)
  active(s)
  requireRepair(s.hash === p.before, 'REPAIR_SNAPSHOT_CHANGED')
  await ownership(c, p, s.links)
  requireRepair(
    !(
      await c.query(
        `SELECT id FROM user_external_identities WHERE provider='dingtalk' AND local_user_id<>$1 AND (external_key=$2 OR (corp_id=$3 AND (provider_open_id=$4 OR provider_union_id=$5)))`,
        [
          p.userId,
          p.identity.external_key,
          p.identity.corp_id,
          p.identity.provider_open_id,
          p.identity.provider_union_id,
        ],
      )
    ).rows.length,
    'REPAIR_IDENTITY_CONFLICT',
  )
  requireRepair(
    !(
      await c.query(
        "SELECT id FROM directory_deprovision_effects WHERE local_user_id=$1 AND status='applied' UNION ALL SELECT id FROM directory_deprovision_events WHERE local_user_id=$1 AND status='applied' LIMIT 1",
        [p.userId],
      )
    ).rows.length,
    'REPAIR_REVOCATION_UNRESOLVED',
  )
  requireRepair(
    !(
      await c.query(
        "SELECT id FROM dingtalk_login_repairs WHERE user_id=$1 AND state='applied'",
        [p.userId],
      )
    ).rows.length,
    'REPAIR_ALREADY_ACTIVE',
  )
  return s
}
async function lock(c: Client, userId: string, actorId: string) {
  await c.query("SET LOCAL lock_timeout='5s'")
  await c.query("SET LOCAL statement_timeout='30s'")
  await c.query(
    "SELECT pg_advisory_xact_lock(hashtext('directory:identity-maintenance'))",
  )
  // Mutation only. Pure previews never acquire write locks or advance generations.
  await c.query(
    'LOCK TABLE users,user_roles,user_permissions,user_namespace_admissions,user_orgs,user_external_auth_grants,directory_account_links,user_external_identities,directory_accounts,directory_integrations,roles,role_permissions,permissions IN SHARE ROW EXCLUSIVE MODE NOWAIT',
  )
  await lockUsersForAccessGraphWrite(c, [userId, actorId].sort())
}
async function revoke(
  c: Client,
  userId: string,
  actorId: string,
  reason: string,
) {
  await c.query(
    `INSERT INTO user_session_revocations(user_id,revoked_after,updated_at,updated_by,reason) VALUES($1,clock_timestamp(),clock_timestamp(),$2,$3) ON CONFLICT(user_id) DO UPDATE SET revoked_after=EXCLUDED.revoked_after,updated_at=EXCLUDED.updated_at,updated_by=EXCLUDED.updated_by,reason=EXCLUDED.reason`,
    [userId, actorId, reason],
  )
  await c.query(
    'UPDATE user_sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL',
    [userId],
  )
  await c.query(
    'UPDATE multitable_api_tokens SET revoked=true,revoked_at=clock_timestamp() WHERE created_by=$1 AND revoked=false',
    [userId],
  )
}
async function audit(c: Client, id: string, actorId: string, action: string) {
  await c.query(
    `INSERT INTO audit_logs(event_type,event_category,resource_type,resource_id,action,action_details,user_name) VALUES('DINGTALK_LOGIN_REPAIR','SECURITY','dingtalk_login_repairs',$1,$2,$3::jsonb,$4)`,
    [id, action, JSON.stringify({ actorId }), actorId],
  )
}
export async function previewDingTalkRepair(proof: string) {
  const p = open(proof)
  return transaction(async (c) => {
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const s = await checks(c, p)
    return {
      digest: digest(p),
      expires: p.expires,
      accountCount: 1,
      target: mask(s.user.name),
      scanner: mask(p.scannerName),
      identitySuffix: String(p.identity.provider_open_id).slice(-4),
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
  requireRepair(
    confirm === 'apply' && approvedDigest === digest(p),
    'REPAIR_APPROVAL_REQUIRED',
  )
  return transaction(async (c) => {
    await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    await lock(c, p.userId, p.actorId)
    const s = await checks(c, p)
    const id = randomUUID()
    await c.query(
      `INSERT INTO dingtalk_login_repairs(id,user_id,proof_nonce,state,before_identity,expected_identity,after_digest,actor_id,source_account_ids,source_integration_ids,login_client_id) VALUES($1,$2,$3,'applied',$4,$5,'pending',$6,$7,$8,$9)`,
      [
        id,
        p.userId,
        p.nonce,
        encryptStoredSecretValue(JSON.stringify(s.identity)),
        p.identity,
        p.actorId,
        s.links.map((r) => r.id),
        s.links.map((r) => r.integration_id),
        scope().cfg.clientId,
      ],
    )
    await c.query(
      `UPDATE user_external_identities SET external_key=$2,corp_id=$3,provider_open_id=$4,provider_union_id=$5,updated_at=now() WHERE provider='dingtalk' AND local_user_id=$1`,
      [
        p.userId,
        p.identity.external_key,
        p.identity.corp_id,
        p.identity.provider_open_id,
        p.identity.provider_union_id,
      ],
    )
    await supersedeDeprovisionEvidenceForAccessGraphWrite(c, {
      userIds: [p.userId],
      actorId: p.actorId,
      reason: 'Controlled DingTalk identity repair',
    })
    await revoke(c, p.userId, p.actorId, 'dingtalk_identity_repair_apply')
    const after = await snapshot(c, p.userId)
    await c.query(
      'UPDATE dingtalk_login_repairs SET after_digest=$2,after_segments=$3 WHERE id=$1',
      [id, after.hash, after.segments],
    )
    await audit(c, id, p.actorId, 'apply')
    return {
      id,
      digest: after.hash,
      accountCount: 1,
      targetSessionsRevoked: true,
      permissionsChanged: false,
    }
  })
}
async function recovery(
  c: Client,
  id: string,
  actorId: string,
  actorPassword: string,
  action: 'rollback' | 'release',
) {
  await operator(c, actorId, actorPassword)
  const row = (
    await c.query('SELECT * FROM dingtalk_login_repairs WHERE id=$1', [id])
  ).rows[0]
  requireRepair(row && row.state === 'applied', 'REPAIR_NOT_ACTIVE')
  await noHandover(
    c,
    String(row.user_id),
    row.source_integration_ids as unknown[],
  )
  const s = await snapshot(c, String(row.user_id))
  const expected = row.expected_identity as Row
  if (action === 'rollback') {
    active(s)
    requireRepair(
      s.identity?.corp_id === expected.corp_id &&
        s.identity?.provider_union_id === expected.provider_union_id,
      'REPAIR_CURRENT_PERSON_CHANGED',
    )
    requireRepair(
      !(
        await c.query(
          `SELECT id FROM directory_deprovision_effects WHERE local_user_id=$1 AND status='applied' UNION ALL SELECT id FROM directory_deprovision_events WHERE local_user_id=$1 AND status='applied' LIMIT 1`,
          [row.user_id],
        )
      ).rows.length,
      'REPAIR_REVOCATION_UNRESOLVED',
    )
  } else {
    const revoked = !s.grant || s.user.is_active !== true || !s.identity
    if (!revoked) {
      const cfg = scope().cfg
      requireRepair(
        row.login_client_id === cfg.clientId &&
          s.links.length === 1 &&
          s.links[0].app_key === cfg.clientId &&
          s.links[0].corp_id === expected.corp_id &&
          s.links[0].union_id === expected.provider_union_id &&
          s.links[0].is_active === true &&
          s.links[0].status === 'active',
        'REPAIR_CANONICAL_SOURCE_REQUIRED',
      )
    }
  }

  const changed = Object.keys(s.segments).filter(
    (k) => (row.after_segments as Row)?.[k] !== s.segments[k],
  )
  return {
    row,
    s,
    changed,
    digest: digest([id, action, s.hash, row.expected_identity, row.state]),
  }
}
export async function previewDingTalkRepairRecovery(
  id: string,
  actorId: string,
  actorPassword: string,
  action: 'rollback' | 'release',
) {
  requireRepair(['rollback', 'release'].includes(action))
  scope()
  return transaction(async (c) => {
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const r = await recovery(c, id, actorId, actorPassword, action)
    return {
      id,
      digest: r.digest,
      action,
      changedSections: r.changed,
      permissionsRestored: false,
      allTargetSessionsWillBeRevoked: true,
    }
  })
}
async function finish(
  id: string,
  actorId: string,
  actorPassword: string,
  approvedDigest: string,
  confirm: string,
  action: 'rollback' | 'release',
) {
  requireRepair(confirm === action, 'REPAIR_APPROVAL_REQUIRED')
  scope()
  return transaction(async (c) => {
    await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    const seed = (
      await c.query('SELECT user_id FROM dingtalk_login_repairs WHERE id=$1', [
        id,
      ])
    ).rows[0]
    requireRepair(seed, 'REPAIR_NOT_ACTIVE')
    await lock(c, String(seed.user_id), actorId)
    const r = await recovery(c, id, actorId, actorPassword, action)
    requireRepair(
      r.digest === approvedDigest,
      'REPAIR_RECOVERY_SNAPSHOT_CHANGED',
    )
    const old = JSON.parse(
      decryptStoredSecretValue(String(r.row.before_identity)),
    ) as Row
    if (action === 'rollback') {
      const conflict = await c.query(
        `SELECT id FROM user_external_identities WHERE provider='dingtalk' AND local_user_id<>$1 AND (external_key=$2 OR (corp_id=$3 AND (provider_union_id=$4 OR provider_open_id=$5)))`,
        [
          r.row.user_id,
          old.external_key,
          old.corp_id,
          old.provider_union_id,
          old.provider_open_id,
        ],
      )
      requireRepair(!conflict.rows.length, 'REPAIR_OLD_IDENTITY_CONFLICT')
    }
    const allowedReleasedAccounts = r.s.links
      .filter(
        (link) =>
          link.app_key === scope().cfg.clientId &&
          link.corp_id === (r.row.expected_identity as Row).corp_id &&
          link.union_id === (r.row.expected_identity as Row).provider_union_id,
      )
      .map((link) => link.id)
    await c.query(
      'UPDATE dingtalk_login_repairs SET state=$2,rollback_actor_id=$3,rolled_back_at=now(),released_account_ids=$4 WHERE id=$1',
      [
        id,
        action === 'rollback' ? 'rolled_back' : 'released',
        actorId,
        action === 'release'
          ? allowedReleasedAccounts.length === 1
            ? allowedReleasedAccounts
            : []
          : null,
      ],
    )
    if (action === 'rollback')
      await c.query(
        `UPDATE user_external_identities SET external_key=$2,corp_id=$3,provider_open_id=$4,provider_union_id=$5,profile=$6,bound_by=$7,updated_at=now() WHERE provider='dingtalk' AND local_user_id=$1`,
        [
          r.row.user_id,
          old.external_key,
          old.corp_id,
          old.provider_open_id,
          old.provider_union_id,
          old.profile,
          old.bound_by,
        ],
      )
    // Never restore old permissions, passwords, admissions or account flags; retain subsequent authorized changes.
    await c.query(
      'UPDATE users SET access_generation=COALESCE(access_generation,0)+1,updated_at=now() WHERE id=$1',
      [r.row.user_id],
    )
    await revoke(
      c,
      String(r.row.user_id),
      actorId,
      'dingtalk_identity_repair_' + action,
    )
    await audit(c, id, actorId, action)
    return {
      id,
      rolledBack: action === 'rollback',
      released: action === 'release',
      targetSessionsRevoked: true,
      permissionsRestored: false,
    }
  })
}
export async function rollbackDingTalkRepair(
  id: string,
  actorId: string,
  approvedDigest: string,
  confirm: string,
  actorPassword: string,
) {
  return finish(id, actorId, actorPassword, approvedDigest, confirm, 'rollback')
}
export async function releaseDingTalkRepair(
  id: string,
  actorId: string,
  approvedDigest: string,
  confirm: string,
  actorPassword: string,
) {
  return finish(id, actorId, actorPassword, approvedDigest, confirm, 'release')
}
