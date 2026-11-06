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
import type { REPAIR_REFUSAL_CODES } from './dingtalk-identity-repair-codes'

type Row = Record<string, unknown>
/** Compile-time only: every refusal literal passed to requireRepair must be a registered module code. */
type RepairRefusalCode = (typeof REPAIR_REFUSAL_CODES)[number]
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
  code: RepairRefusalCode = 'DINGTALK_IDENTITY_REPAIR_REFUSED',
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
const DINGTALK = 'dingtalk'
const hasText = (v: unknown): v is string => typeof v === 'string' && v.length > 0
/** Same person: same corp and a present, equal directory UnionID. OpenID is never person evidence. */
const samePerson = (r: Row, expected: Row) =>
  r.corp_id === expected.corp_id &&
  hasText(r.union_id) &&
  r.union_id === expected.provider_union_id
/** Canonical source: same person, from a DingTalk directory account, in the login application. */
const canonicalSource = (r: Row, expected: Row, clientId: string) =>
  r.provider === DINGTALK && samePerson(r, expected) && r.app_key === clientId
/** Explicit digest-stable column list (no raw/last_seen_at/timestamps: they change every sync). */
const SOURCE_COLUMNS =
  "a.id,a.provider,a.integration_id,a.corp_id,a.union_id,a.open_id,a.is_active,i.status,i.config->>'appKey' AS app_key"
const SOURCE_JOIN =
  'FROM directory_accounts a JOIN directory_integrations i ON i.id=a.integration_id LEFT JOIN directory_account_links l ON l.directory_account_id=a.id'
const dingtalkOnly = (links: Row[]) =>
  links.filter((l) => l.provider === DINGTALK)
function userEnabled(u: Row): boolean {
  // Extracted from active() unchanged; the complement is "revoked" for release.
  return (
    u.is_active === true &&
    !u.deleted_at &&
    !u.purged_at &&
    !evaluateUserAuthenticationGate({
      is_active: u.is_active as boolean,
      role: String(u.role),
      activation_status: String(u.activation_status),
    })
  )
}
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
      `SELECT ${SOURCE_COLUMNS} ${SOURCE_JOIN} WHERE l.local_user_id=$1 AND l.link_status='linked' ORDER BY a.id`,
      [userId],
    )
  ).rows
  // Every provider stays in the approval snapshot; only the DingTalk subset is identity evidence.
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
    dingtalkLinks: dingtalkOnly(links),
    grant,
    hash: digest(sections),
    segments: Object.fromEntries(
      Object.entries(sections).map(([k, v]) => [k, digest(v)]),
    ),
  }
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>
function active(s: Snapshot) {
  requireRepair(
    userEnabled(s.user) && s.grant && s.identity,
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
/** `links` is the target's DingTalk subset of linked directory rows; local directory rows are never identity evidence. */
async function ownership(c: Client, p: Proof, links: Row[]) {
  const clientId = scope().cfg.clientId
  const rows = (
    await c.query(
      `SELECT ${SOURCE_COLUMNS},l.local_user_id,l.link_status ${SOURCE_JOIN} WHERE a.provider='dingtalk' AND a.corp_id=$1 AND (a.union_id=$2 OR (a.open_id IS NOT NULL AND a.open_id=$3))`,
      [
        p.identity.corp_id,
        p.identity.provider_union_id,
        p.identity.provider_open_id,
      ],
    )
  ).rows
  // Any non-null other owner, whatever the link status (pending hints included), refuses.
  requireRepair(
    rows.length > 0 &&
      !rows.some((r) => r.local_user_id && r.local_user_id !== p.userId),
    'REPAIR_DIRECTORY_OWNER_CONFLICT',
  )
  const live = links.filter(
    (l) => l.is_active === true && l.status === 'active',
  )
  // A directory row without a UnionID is not evidence in v1 and blocks the repair before it starts.
  requireRepair(
    live.every((l) => hasText(l.union_id)),
    'REPAIR_DIRECTORY_UNION_ID_REQUIRED',
  )
  // No app/OpenID arm: OpenID can refuse (owner conflict above) but never prove.
  requireRepair(
    live.every((l) => samePerson(l, p.identity)),
    'REPAIR_DIRECTORY_PERSON_AMBIGUOUS',
  )
  // The witness is a current-app, active, linked, same-UnionID DingTalk row of this user, and there is exactly one.
  const witnesses = rows.filter(
    (r) =>
      r.local_user_id === p.userId &&
      r.link_status === 'linked' &&
      r.is_active === true &&
      r.status === 'active' &&
      canonicalSource(r, p.identity, clientId),
  )
  requireRepair(witnesses.length > 0, 'REPAIR_PERSON_NOT_PROVEN')
  requireRepair(witnesses.length === 1, 'REPAIR_CANONICAL_SOURCE_REQUIRED')
  return { canonicalAccountId: String(witnesses[0].id) }
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
  // The target never acts as its own operator (re-anchoring and the journal CHECKs hold the same rule).
  // Checked first, so a self-operated request spends neither a password check nor the authorization code.
  requireRepair(actorId !== userId, 'REPAIR_DUAL_CONTROL_REQUIRED')
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
  // Before any provider call: an active DingTalk source without a stored UnionID can never prove the person.
  requireRepair(
    before.dingtalkLinks
      .filter((l) => l.is_active === true && l.status === 'active')
      .every((l) => hasText(l.union_id)),
    'REPAIR_DIRECTORY_UNION_ID_REQUIRED',
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
  await ownership({ query }, p, before.dingtalkLinks)
  return encryptStoredSecretValue(JSON.stringify(p))
}
async function checks(c: Client, p: Proof) {
  requireRepair(p.actorId !== p.userId, 'REPAIR_DUAL_CONTROL_REQUIRED')
  requireRepair(
    (await operator(c, p.actorId)) === p.actorCredential,
    'REPAIR_OPERATOR_CHANGED',
  )
  await noHandover(c, p.userId)
  const s = await snapshot(c, p.userId)
  active(s)
  requireRepair(s.hash === p.before, 'REPAIR_SNAPSHOT_CHANGED')
  const { canonicalAccountId } = await ownership(c, p, s.dingtalkLinks)
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
  return { s, canonicalAccountId }
}
/** Locks the target and every acting administrator (apply, rollback and release pass one; a re-anchor passes two). */
async function lock(c: Client, userId: string, actorIds: string[]) {
  await c.query("SET LOCAL lock_timeout='5s'")
  await c.query("SET LOCAL statement_timeout='30s'")
  // Mutation only. Pure previews never acquire write locks or advance generations.
  // Bounded wait (lock_timeout above), not NOWAIT: a queued request lasting past deadlock_timeout
  // makes a conflicting autovacuum/autoanalyze cancel itself. Any other holder past the limit
  // (55P03), including the advisory mutex, or a lock cycle in which this transaction is the
  // deadlock victim (40P01) ends in a refusal; the transaction rolls back with no row written.
  // Every statement below is a lock wait, so statement_timeout (57014) here means the same thing:
  // still busy after the per-statement budget. A 57014 on any later statement is not mapped here.
  try {
    await c.query(
      "SELECT pg_advisory_xact_lock(hashtext('directory:identity-maintenance'))",
    )
    await c.query(
      'LOCK TABLE users,user_roles,user_permissions,user_namespace_admissions,user_orgs,user_external_auth_grants,directory_account_links,user_external_identities,directory_accounts,directory_integrations,roles,role_permissions,permissions IN SHARE ROW EXCLUSIVE MODE',
    )
    await lockUsersForAccessGraphWrite(c, [userId, ...actorIds].sort())
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    if (code === '55P03' || code === '40P01' || code === '57014')
      throw new Error('REPAIR_LOCK_BUSY')
    throw error
  }
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
async function audit(
  c: Client,
  id: string,
  actorId: string,
  action: string,
  details?: Row,
) {
  await c.query(
    `INSERT INTO audit_logs(event_type,event_category,resource_type,resource_id,action,action_details,user_name) VALUES('DINGTALK_LOGIN_REPAIR','SECURITY','dingtalk_login_repairs',$1,$2,$3::jsonb,$4)`,
    [id, action, JSON.stringify({ actorId, ...details }), actorId],
  )
}
export async function previewDingTalkRepair(proof: string) {
  const p = open(proof)
  return transaction(async (c) => {
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const { s, canonicalAccountId } = await checks(c, p)
    return {
      digest: digest(p),
      expires: p.expires,
      accountCount: 1,
      target: mask(s.user.name),
      scanner: mask(p.scannerName),
      identitySuffix: String(p.identity.provider_open_id).slice(-4),
      canonicalAccountId,
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
    await lock(c, p.userId, [p.actorId])
    const { s, canonicalAccountId } = await checks(c, p)
    const id = randomUUID()
    // The journal records only DingTalk sources; the single apply-time witness is recorded as the canonical row.
    await c.query(
      `INSERT INTO dingtalk_login_repairs(id,user_id,proof_nonce,state,before_identity,expected_identity,after_digest,actor_id,source_account_ids,source_integration_ids,canonical_account_id,login_client_id) VALUES($1,$2,$3,'applied',$4,$5,'pending',$6,$7,$8,$9,$10)`,
      [
        id,
        p.userId,
        p.nonce,
        encryptStoredSecretValue(JSON.stringify(s.identity)),
        p.identity,
        p.actorId,
        s.dingtalkLinks.map((r) => r.id),
        s.dingtalkLinks.map((r) => r.integration_id),
        canonicalAccountId,
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
type ReleasePlan = {
  mode: 'canonical' | 'termination'
  /** Exactly one element, always: the row apply recorded as canonical_account_id. */
  releasedAccountIds: string[]
  /** Sorted; every element equals releasedAccountIds[0]. */
  linkedDingTalkAccountIds: string[]
  /** Non-DingTalk linked rows, kept outside the fence. */
  localLinkCount: number
  /** Normalized re-read journal rows (bound into the digest). */
  candidates: Row[]
}
const normalizeCandidate = (h: Row): Row => ({
  id: h.id,
  provider: h.provider,
  integration_id: h.integration_id,
  corp_id: h.corp_id,
  union_id: h.union_id,
  open_id: h.open_id,
  is_active: h.is_active,
  status: h.status,
  app_key: h.app_key,
  local_user_id: h.local_user_id ?? null,
  link_status: h.link_status ?? null,
})
/**
 * Release allowlist plan. Canonical mode (login-capable user) and termination mode (revoked user) are exact
 * complements of active(). Both re-read the journal's source rows (historical ids are not evidence; the rows
 * are) and re-verify the row apply recorded as canonical. Every refusal happens before finish() writes.
 */
async function releasePlan(
  c: Client,
  row: Row,
  s: Snapshot,
): Promise<ReleasePlan> {
  const userId = String(row.user_id)
  const expected = row.expected_identity as Row
  const { cfg } = scope()
  // 1. Login scope drift (app or enterprise) since apply: same test the login pin uses.
  //    A per-row app_key match cannot replace it: an integration whose appKey was edited to the new app would match.
  requireRepair(
    row.login_client_id === cfg.clientId && expected.corp_id === cfg.corpId,
    'REPAIR_LOGIN_SCOPE_CHANGED',
  )
  // 2. The pinned identity, when present, still names the same person (held by the identity trigger while applied).
  if (s.identity)
    requireRepair(
      s.identity.corp_id === expected.corp_id &&
        s.identity.provider_union_id === expected.provider_union_id,
      'REPAIR_CURRENT_PERSON_CHANGED',
    )
  const mode: ReleasePlan['mode'] =
    s.grant && s.identity && userEnabled(s.user) ? 'canonical' : 'termination'
  // 3. Occupation by another local user, corp-wide, same shape as ownership(): any non-null other owner, any link_status.
  requireRepair(
    !(
      await c.query(
        `SELECT 1 ${SOURCE_JOIN} WHERE a.provider='dingtalk' AND a.corp_id=$1 AND (a.union_id=$2 OR (a.open_id IS NOT NULL AND a.open_id=$3)) AND l.local_user_id IS NOT NULL AND l.local_user_id<>$4 LIMIT 1`,
        [
          expected.corp_id,
          expected.provider_union_id,
          expected.provider_open_id,
          userId,
        ],
      )
    ).rows.length,
    'REPAIR_DIRECTORY_OWNER_CONFLICT',
  )
  // 4. Identity-table conflict: another local user holds this person's DingTalk identity.
  requireRepair(
    !(
      await c.query(
        `SELECT 1 FROM user_external_identities WHERE provider='dingtalk' AND local_user_id<>$1 AND corp_id=$2 AND provider_union_id=$3 LIMIT 1`,
        [userId, expected.corp_id, expected.provider_union_id],
      )
    ).rows.length,
    'REPAIR_IDENTITY_CONFLICT',
  )
  // 5. Candidate universe: the journal's own source ids, re-read now.
  const candidates = (
    await c.query(
      `SELECT ${SOURCE_COLUMNS},l.local_user_id,l.link_status ${SOURCE_JOIN} WHERE a.id=ANY($1::uuid[]) ORDER BY a.id`,
      [row.source_account_ids],
    )
  ).rows.map(normalizeCandidate)
  requireRepair(
    !candidates.some((h) => h.local_user_id && h.local_user_id !== userId),
    'REPAIR_DIRECTORY_OWNER_CONFLICT',
  )
  // The original stable source is the row apply recorded; it must re-verify now. Canonical mode also needs it live and linked.
  const chosen = String(row.canonical_account_id)
  const trusted = candidates.filter(
    (h) =>
      String(h.id) === chosen &&
      canonicalSource(h, expected, cfg.clientId) &&
      (mode === 'termination' ||
        (h.local_user_id === userId &&
          h.link_status === 'linked' &&
          h.is_active === true &&
          h.status === 'active')),
  )
  requireRepair(
    trusted.length === 1,
    mode === 'canonical'
      ? 'REPAIR_CANONICAL_SOURCE_REQUIRED'
      : 'REPAIR_HISTORICAL_SOURCE_UNVERIFIED',
  )
  // 6. Any other currently linked DingTalk row (active or not, any app) would hit the fence on the next sync.
  requireRepair(
    s.dingtalkLinks.every((l) => String(l.id) === chosen),
    'REPAIR_SOURCE_OUTSIDE_ALLOWLIST',
  )
  return {
    mode,
    releasedAccountIds: [chosen],
    linkedDingTalkAccountIds: s.dingtalkLinks.map((l) => String(l.id)).sort(),
    localLinkCount: s.links.length - s.dingtalkLinks.length,
    candidates,
  }
}
const REANCHOR_PURPOSE = 'dingtalk-login-reanchor-v1'
const REANCHOR_REQUEST_TTL_MS = 600000
/** Row active and integration active. (Named so it does not shadow ownership()'s local `live`.) */
const isLive = (h: Row) => h.is_active === true && h.status === 'active'
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
type ReanchorReason = 'canonical_source' | 'journal_source_occupied' | 'login_scope'
type ReanchorPlan = {
  releaseMode: ReleasePlan['mode']
  /** Fixed order; empty refuses REPAIR_REANCHOR_NOT_NEEDED. */
  reasons: ReanchorReason[]
  scanRequired: boolean
  /** Anchor fields of the applied row (never before_identity: a reseal must not invalidate an approval). */
  predecessor: Row
  previousCanonical: Row | null
  journalRows: Row[]
  personRows: Row[]
  loginClientId: string
  canonicalAccountId: string
  canonicalLinked: boolean
  /** Sorted; a subset of the predecessor sources plus canonicalAccountId (checked by the chain guard). */
  sourceAccountIds: string[]
  /** Parallel to sourceAccountIds. */
  sourceIntegrationIds: string[]
  droppedSourceAccountIds: string[]
  linkedDingTalkAccountIds: string[]
}
/** Sealed hand-over file from the preparer to the named approver. */
type ReanchorRequest = {
  purpose: typeof REANCHOR_PURPOSE
  nonce: string
  expires: number
  repairId: string
  userId: string
  preparerId: string
  preparerCredential: string
  approverId: string
  scope: string
  digest: string
  /** Current-app OpenID of the scan, or null. It can refuse (another owner) but never proves. */
  scanOpenId: string | null
}

function openReanchorRequest(request: string): ReanchorRequest {
  requireRepair(isEncryptedSecretValue(request), 'REPAIR_PROOF_INVALID')
  const q = JSON.parse(decryptStoredSecretValue(request)) as ReanchorRequest
  const now = Date.now()
  requireRepair(
    q.purpose === REANCHOR_PURPOSE &&
      UUID_PATTERN.test(String(q.nonce)) &&
      q.expires > now &&
      q.expires <= now + REANCHOR_REQUEST_TTL_MS &&
      q.scope === scope().hash,
    'REPAIR_PROOF_INVALID',
  )
  return q
}

/**
 * Re-anchor plan: the same person (the pin's corp + UnionID), a new login scope and/or a new canonical row.
 * Occupation refuses before the not-needed gate, so a moved person never reads as "not needed".
 */
async function reanchorPlan(
  c: Client,
  row: Row,
  s: Snapshot,
): Promise<ReanchorPlan> {
  const userId = String(row.user_id)
  const expected = row.expected_identity as Row
  const { cfg } = scope()
  // 1. Never across enterprises (doc: 不切换企业); the person key is corp + UnionID.
  requireRepair(
    expected.corp_id === cfg.corpId,
    'REPAIR_REANCHOR_CORP_CHANGED',
  )
  // 2. A present identity still names the pinned person (held by the identity guard while applied).
  if (s.identity)
    requireRepair(
      s.identity.corp_id === expected.corp_id &&
        s.identity.provider_union_id === expected.provider_union_id,
      'REPAIR_CURRENT_PERSON_CHANGED',
    )
  const releaseMode: ReleasePlan['mode'] =
    s.grant && s.identity && userEnabled(s.user) ? 'canonical' : 'termination'
  // 3. This person's DingTalk rows corp-wide (ownership() shape): any other owner or hint refuses; OpenID only refuses.
  const personRows = (
    await c.query(
      `SELECT ${SOURCE_COLUMNS},l.local_user_id,l.link_status ${SOURCE_JOIN} WHERE a.provider='dingtalk' AND a.corp_id=$1 AND (a.union_id=$2 OR (a.open_id IS NOT NULL AND a.open_id=$3)) ORDER BY a.id`,
      [
        expected.corp_id,
        expected.provider_union_id,
        expected.provider_open_id,
      ],
    )
  ).rows.map(normalizeCandidate)
  requireRepair(
    !personRows.some((h) => h.local_user_id && h.local_user_id !== userId),
    'REPAIR_DIRECTORY_OWNER_CONFLICT',
  )
  // 4. Another local user holds this person's identity (checks() shape, pinned values).
  requireRepair(
    !(
      await c.query(
        `SELECT 1 FROM user_external_identities WHERE provider='dingtalk' AND local_user_id<>$1 AND (external_key=$2 OR (corp_id=$3 AND (provider_open_id=$4 OR provider_union_id=$5))) LIMIT 1`,
        [
          userId,
          expected.external_key,
          expected.corp_id,
          expected.provider_open_id,
          expected.provider_union_id,
        ],
      )
    ).rows.length,
    'REPAIR_IDENTITY_CONFLICT',
  )
  // 5. The target's live DingTalk links (any app) carry a UnionID and name the pinned person (ownership() rules).
  const liveLinks = s.dingtalkLinks.filter(isLive)
  requireRepair(
    liveLinks.every((l) => hasText(l.union_id)),
    'REPAIR_DIRECTORY_UNION_ID_REQUIRED',
  )
  requireRepair(
    liveLinks.every((l) => samePerson(l, expected)),
    'REPAIR_DIRECTORY_PERSON_AMBIGUOUS',
  )
  // 6. Only what release cannot clear. Same-person rows held by others already refused at 3,
  //    so an occupied journal row here is another person's row in its rightful owner's hands.
  const journalRows = (
    await c.query(
      `SELECT ${SOURCE_COLUMNS},l.local_user_id,l.link_status ${SOURCE_JOIN} WHERE a.id=ANY($1::uuid[]) ORDER BY a.id`,
      [row.source_account_ids],
    )
  ).rows.map(normalizeCandidate)
  const previousCanonical =
    journalRows.find(
      (h) => String(h.id) === String(row.canonical_account_id),
    ) ?? null
  const reasons: ReanchorReason[] = []
  if (
    !previousCanonical ||
    !canonicalSource(previousCanonical, expected, cfg.clientId)
  )
    reasons.push('canonical_source')
  if (journalRows.some((h) => h.local_user_id && h.local_user_id !== userId))
    reasons.push('journal_source_occupied')
  if (row.login_client_id !== cfg.clientId) reasons.push('login_scope')
  requireRepair(reasons.length > 0, 'REPAIR_REANCHOR_NOT_NEEDED')
  // 7. The anchor satisfies the predicate of the release mode that follows; the recorded row is kept when it fits.
  const fits = (h: Row) =>
    canonicalSource(h, expected, cfg.clientId) &&
    (releaseMode === 'termination' ||
      (h.local_user_id === userId && h.link_status === 'linked' && isLive(h)))
  let anchor: Row
  if (previousCanonical && fits(previousCanonical)) anchor = previousCanonical
  else {
    const fitting = personRows.filter(fits)
    const pool =
      releaseMode === 'termination' && fitting.some(isLive)
        ? fitting.filter(isLive)
        : fitting
    requireRepair(pool.length > 0, 'REPAIR_PERSON_NOT_PROVEN')
    requireRepair(pool.length === 1, 'REPAIR_CANONICAL_SOURCE_REQUIRED')
    anchor = pool[0]
  }
  // 8. Successor sources: rows linked now (the fence admitted them; sync re-fires the fence on each), the anchor,
  //    and predecessor rows still this person and unowned or the target's (dropping one would fail its next sync).
  const sources = new Map<string, string>()
  for (const l of s.dingtalkLinks)
    sources.set(String(l.id), String(l.integration_id))
  for (const h of journalRows)
    if (
      samePerson(h, expected) &&
      (!h.local_user_id || h.local_user_id === userId)
    )
      sources.set(String(h.id), String(h.integration_id))
  sources.set(String(anchor.id), String(anchor.integration_id))
  const sourceAccountIds = [...sources.keys()].sort()
  return {
    releaseMode,
    reasons,
    scanRequired: releaseMode === 'canonical' && reasons.includes('login_scope'),
    predecessor: {
      id: row.id,
      user_id: row.user_id,
      state: row.state,
      supersedes_id: row.supersedes_id ?? null,
      login_client_id: row.login_client_id,
      canonical_account_id: row.canonical_account_id,
      source_account_ids: row.source_account_ids,
      source_integration_ids: row.source_integration_ids,
      expected_identity: row.expected_identity,
    },
    previousCanonical,
    journalRows,
    personRows,
    loginClientId: cfg.clientId,
    canonicalAccountId: String(anchor.id),
    canonicalLinked:
      anchor.local_user_id === userId && anchor.link_status === 'linked',
    sourceAccountIds,
    sourceIntegrationIds: sourceAccountIds.map((id) => String(sources.get(id))),
    droppedSourceAccountIds: (row.source_account_ids as unknown[])
      .map(String)
      .filter((id) => !sources.has(id))
      .sort(),
    linkedDingTalkAccountIds: s.dingtalkLinks.map((l) => String(l.id)).sort(),
  }
}

/** The scanned OpenID may refuse (another user's directory row or identity) but never proves anything. */
async function scannedOpenIdConflicts(
  c: Client,
  userId: string,
  openId: string,
) {
  const { cfg } = scope()
  requireRepair(
    !(
      await c.query(
        `SELECT 1 ${SOURCE_JOIN} WHERE a.provider='dingtalk' AND a.corp_id=$1 AND a.open_id=$2 AND l.local_user_id IS NOT NULL AND l.local_user_id<>$3 LIMIT 1`,
        [cfg.corpId, openId, userId],
      )
    ).rows.length,
    'REPAIR_DIRECTORY_OWNER_CONFLICT',
  )
  requireRepair(
    !(
      await c.query(
        `SELECT 1 FROM user_external_identities WHERE provider='dingtalk' AND local_user_id<>$1 AND (external_key=$2 OR (corp_id=$3 AND provider_open_id=$4)) LIMIT 1`,
        [userId, `${cfg.corpId}:${openId}`, cfg.corpId, openId],
      )
    ).rows.length,
    'REPAIR_IDENTITY_CONFLICT',
  )
}

async function reanchorState(
  c: Client,
  repairId: string,
  preparerId: string,
  approverId: string,
  scanOpenId: string | null,
) {
  const row = (
    await c.query('SELECT * FROM dingtalk_login_repairs WHERE id=$1', [
      repairId,
    ])
  ).rows[0]
  requireRepair(row && row.state === 'applied', 'REPAIR_NOT_ACTIVE')
  const userId = String(row.user_id)
  // Two different administrators, neither the target (the successor CHECK repeats this).
  requireRepair(
    preparerId !== approverId &&
      preparerId !== userId &&
      approverId !== userId,
    'REPAIR_DUAL_CONTROL_REQUIRED',
  )
  const s = await snapshot(c, userId)
  const plan = await reanchorPlan(c, row, s)
  if (scanOpenId) await scannedOpenIdConflicts(c, userId, scanOpenId)
  await noHandover(c, userId, [
    ...new Set([
      ...(row.source_integration_ids as unknown[]).map(String),
      ...plan.sourceIntegrationIds,
    ]),
  ])
  return {
    row,
    s,
    plan,
    digest: digest([
      'reanchor',
      repairId,
      s.hash,
      scope().hash,
      preparerId,
      approverId,
      plan,
    ]),
  }
}
type ReanchorState = Awaited<ReturnType<typeof reanchorState>>

const reanchorSummary = (
  r: ReanchorState,
  q: Pick<
    ReanchorRequest,
    'repairId' | 'expires' | 'preparerId' | 'approverId' | 'scanOpenId'
  >,
) => ({
  id: q.repairId,
  digest: r.digest,
  expires: q.expires,
  preparerId: q.preparerId,
  approverId: q.approverId,
  target: mask(r.s.user.name),
  reanchor: {
    releaseMode: r.plan.releaseMode,
    reasons: r.plan.reasons,
    loginClientChanged: r.plan.reasons.includes('login_scope'),
    previousCanonicalAccountId: String(r.row.canonical_account_id),
    canonicalAccountId: r.plan.canonicalAccountId,
    canonicalLinked: r.plan.canonicalLinked,
    sourceAccountIds: r.plan.sourceAccountIds,
    droppedSourceAccountIds: r.plan.droppedSourceAccountIds,
    linkedDingTalkAccountIds: r.plan.linkedDingTalkAccountIds,
    scanRequired: r.plan.scanRequired,
    scanned: q.scanOpenId !== null,
  },
  identityChanged: false,
  permissionsChanged: false,
  allTargetSessionsWillBeRevoked: true,
})

/** Preparer. Two read-only plans around the optional provider exchange; nothing is written to the database. */
export async function requestDingTalkRepairReanchor(
  repairId: string,
  actorId: string,
  actorPassword: string,
  approverId: string,
  code?: string,
) {
  const { hash } = scope()
  requireRepair(actorId !== approverId, 'REPAIR_DUAL_CONTROL_REQUIRED')
  const preparerCredential = await operator({ query }, actorId, actorPassword)
  // The named approver must be an eligible administrator now; their password is checked at their own steps.
  await operator({ query }, approverId)
  const readOnly = (scanOpenId: string | null) =>
    transaction(async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      return reanchorState(c, repairId, actorId, approverId, scanOpenId)
    })
  // Every refusal that needs no provider call happens first, so a doomed request never consumes the code.
  let r = await readOnly(null)
  let scanOpenId: string | null = null
  if (r.plan.scanRequired || code !== undefined) {
    requireRepair(code, 'REPAIR_REANCHOR_SCAN_REQUIRED')
    const dt = await exchangeCodeForDingTalkProfile(code)
    requireRepair(dt.openId && dt.unionId, 'REPAIR_PROFILE_INCOMPLETE')
    requireRepair(
      dt.unionId === (r.row.expected_identity as Row).provider_union_id,
      'REPAIR_REANCHOR_PERSON_MISMATCH',
    )
    scanOpenId = String(dt.openId)
    r = await readOnly(scanOpenId)
  }
  const q: ReanchorRequest = {
    purpose: REANCHOR_PURPOSE,
    nonce: randomUUID(),
    expires: Date.now() + REANCHOR_REQUEST_TTL_MS,
    repairId,
    userId: String(r.row.user_id),
    preparerId: actorId,
    preparerCredential,
    approverId,
    scope: hash,
    digest: r.digest,
    scanOpenId,
  }
  return {
    request: encryptStoredSecretValue(JSON.stringify(q)),
    summary: reanchorSummary(r, q),
  }
}

/** Named approver: the same plan, recomputed; read-only. */
export async function previewDingTalkRepairReanchor(
  request: string,
  actorId: string,
  actorPassword: string,
) {
  const q = openReanchorRequest(request)
  requireRepair(
    actorId === q.approverId &&
      actorId !== q.preparerId &&
      actorId !== q.userId,
    'REPAIR_DUAL_CONTROL_REQUIRED',
  )
  return transaction(async (c) => {
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await operator(c, actorId, actorPassword)
    requireRepair(
      (await operator(c, q.preparerId)) === q.preparerCredential,
      'REPAIR_OPERATOR_CHANGED',
    )
    const r = await reanchorState(
      c,
      q.repairId,
      q.preparerId,
      q.approverId,
      q.scanOpenId,
    )
    requireRepair(String(r.row.user_id) === q.userId, 'REPAIR_PROOF_INVALID')
    requireRepair(r.digest === q.digest, 'REPAIR_RECOVERY_SNAPSHOT_CHANGED')
    requireRepair(
      !r.plan.scanRequired || q.scanOpenId !== null,
      'REPAIR_REANCHOR_SCAN_REQUIRED',
    )
    return reanchorSummary(r, q)
  })
}

/** Named approver executes. Everything is recomputed under the maintenance lock; a refusal writes nothing. */
export async function reanchorDingTalkRepair(
  request: string,
  actorId: string,
  actorPassword: string,
  approvedDigest: string,
  confirm: string,
) {
  const q = openReanchorRequest(request)
  requireRepair(
    confirm === 'reanchor' && approvedDigest === q.digest,
    'REPAIR_APPROVAL_REQUIRED',
  )
  requireRepair(
    actorId === q.approverId &&
      actorId !== q.preparerId &&
      actorId !== q.userId,
    'REPAIR_DUAL_CONTROL_REQUIRED',
  )
  return transaction(async (c) => {
    await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    await lock(c, q.userId, [q.preparerId, actorId])
    await operator(c, actorId, actorPassword)
    requireRepair(
      (await operator(c, q.preparerId)) === q.preparerCredential,
      'REPAIR_OPERATOR_CHANGED',
    )
    const r = await reanchorState(
      c,
      q.repairId,
      q.preparerId,
      actorId,
      q.scanOpenId,
    )
    requireRepair(String(r.row.user_id) === q.userId, 'REPAIR_PROOF_INVALID')
    requireRepair(
      r.digest === approvedDigest,
      'REPAIR_RECOVERY_SNAPSHOT_CHANGED',
    )
    requireRepair(
      !r.plan.scanRequired || q.scanOpenId !== null,
      'REPAIR_REANCHOR_SCAN_REQUIRED',
    )
    // First write. The predecessor leaves 'applied' before the successor exists (the applied index is not deferrable).
    const ended = await c.query(
      "UPDATE dingtalk_login_repairs SET state='superseded',rollback_actor_id=$2,rolled_back_at=now() WHERE id=$1 AND state='applied' RETURNING id",
      [q.repairId, actorId],
    )
    requireRepair(ended.rows.length === 1, 'REPAIR_NOT_ACTIVE')
    const id = randomUUID()
    // Same person and same undo target, copied by the server from the row just superseded: lock() does not lock this
    // table, so a two-statement copy could race a before_identity reseal; no jsonb or ciphertext round trip.
    const inserted = await c.query(
      `INSERT INTO dingtalk_login_repairs(id,user_id,proof_nonce,state,before_identity,expected_identity,after_digest,actor_id,approver_id,supersedes_id,source_account_ids,source_integration_ids,canonical_account_id,login_client_id) SELECT $1::uuid,user_id,$2::uuid,'applied',before_identity,expected_identity,'pending',$3::text,$4::text,id,$5::uuid[],$6::uuid[],$7::uuid,$8::text FROM dingtalk_login_repairs WHERE id=$9::uuid AND state='superseded' RETURNING id`,
      [
        id,
        q.nonce,
        q.preparerId,
        actorId,
        r.plan.sourceAccountIds,
        r.plan.sourceIntegrationIds,
        r.plan.canonicalAccountId,
        r.plan.loginClientId,
        q.repairId,
      ],
    )
    requireRepair(inserted.rows.length === 1, 'REPAIR_NOT_ACTIVE')
    // Users-tuple fence: a stale REPEATABLE READ writer fails 40001 instead of reading the superseded row as applied.
    await c.query(
      'UPDATE users SET access_generation=COALESCE(access_generation,0)+1,updated_at=now() WHERE id=$1',
      [q.userId],
    )
    await revoke(c, q.userId, actorId, 'dingtalk_identity_repair_reanchor')
    const after = await snapshot(c, q.userId)
    await c.query(
      'UPDATE dingtalk_login_repairs SET after_digest=$2,after_segments=$3 WHERE id=$1',
      [id, after.hash, after.segments],
    )
    const details = {
      preparerId: q.preparerId,
      approverId: actorId,
      predecessorId: q.repairId,
      successorId: id,
      releaseMode: r.plan.releaseMode,
      reasons: r.plan.reasons,
      scanned: q.scanOpenId !== null,
    }
    await audit(c, q.repairId, actorId, 'superseded', details)
    await audit(c, id, actorId, 'reanchor', details)
    return {
      id,
      predecessorId: q.repairId,
      releaseMode: r.plan.releaseMode,
      canonicalAccountId: r.plan.canonicalAccountId,
      loginClientChanged: r.plan.reasons.includes('login_scope'),
      identityChanged: false,
      permissionsChanged: false,
      targetSessionsRevoked: true,
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
  // Before the password check: the target of a repair never ends it as its own operator.
  const target = (
    await c.query('SELECT user_id FROM dingtalk_login_repairs WHERE id=$1', [id])
  ).rows[0]
  if (target)
    requireRepair(String(target.user_id) !== actorId, 'REPAIR_DUAL_CONTROL_REQUIRED')
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
  let plan: ReleasePlan | null = null
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
    plan = await releasePlan(c, row, s)
  }

  const changed = Object.keys(s.segments).filter(
    (k) => (row.after_segments as Row)?.[k] !== s.segments[k],
  )
  return {
    row,
    s,
    changed,
    plan,
    // The login scope and the release plan (mode, allowlist, linked ids, re-read candidates) are bound too.
    digest: digest([
      id,
      action,
      s.hash,
      row.expected_identity,
      row.state,
      scope().hash,
      plan,
    ]),
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
      release: r.plan
        ? {
            mode: r.plan.mode,
            releasedAccountIds: r.plan.releasedAccountIds,
            linkedDingTalkAccountIds: r.plan.linkedDingTalkAccountIds,
            localLinkCount: r.plan.localLinkCount,
            revocationRetained: r.plan.mode === 'termination',
          }
        : null,
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
    await lock(c, String(seed.user_id), [actorId])
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
      // The same corp-wide occupancy rule ownership() applies to the new identity: a directory row of the old
      // person linked or hinted (pending included) to another local user refuses the restore.
      const owners = await c.query(
        `SELECT l.local_user_id ${SOURCE_JOIN} WHERE a.provider='dingtalk' AND a.corp_id=$1 AND (a.union_id=$2 OR (a.open_id IS NOT NULL AND a.open_id=$3)) AND l.local_user_id IS NOT NULL AND l.local_user_id<>$4 LIMIT 1`,
        [old.corp_id, old.provider_union_id, old.provider_open_id, r.row.user_id],
      )
      requireRepair(!owners.rows.length, 'REPAIR_DIRECTORY_OWNER_CONFLICT')
    }
    // Never recompute the allowlist here: write the plan the approved digest bound.
    await c.query(
      'UPDATE dingtalk_login_repairs SET state=$2,rollback_actor_id=$3,rolled_back_at=now(),released_account_ids=$4 WHERE id=$1',
      [
        id,
        action === 'rollback' ? 'rolled_back' : 'released',
        actorId,
        action === 'release' ? r.plan!.releasedAccountIds : null,
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
    await audit(
      c,
      id,
      actorId,
      action,
      action === 'release' ? { releaseMode: r.plan!.mode } : undefined,
    )
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
