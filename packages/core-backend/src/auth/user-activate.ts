/**
 * T3 — promote pending_activation → activated (design lock Rev 4.2 §2.3 / §6).
 *
 * Single durable transaction: status + is_active + optional password + optional
 * memberships. Rejects inactive directory sources for SSO-shaped activates.
 *
 * Load-bearing mutation notes (source-link hardening):
 * - Explicit `directoryAccountId` must JOIN a real link row with
 *   `link_status = 'linked'` AND `local_user_id` exactly the pending user.
 *   LEFT JOIN + "only reject truthy mismatched local_user_id" is forbidden:
 *   missing link / unlinked / null local_user_id must fail closed.
 * - Implicit source branch requires `link_status = 'linked'` exactly
 *   (never `COALESCE(NULL, 'linked')`).
 * - SOURCE_MISSING vs LINK_MISMATCH stay precise: missing/unlinked → MISSING;
 *   linked-to-another-user → MISMATCH.
 * - mode=sso additionally requires authoritative DingTalk provider on both
 *   account and integration plus corp_id consistency between those rows.
 *   Request body corp/provider hints are never consulted.
 */

import * as bcrypt from 'bcryptjs'
import { transaction } from '../db/pg'
import { getBcryptSaltRounds } from '../security/auth-runtime-config'
import {
  lockUsersForAccessGraphWrite,
  supersedeDeprovisionEvidenceForAccessGraphWrite,
} from '../directory/access-graph-mutex'
import { claimLoginAlias } from './login-alias-service'
import { buildUnusablePasswordHash } from './user-activation'

export type ActivateMode = 'temp_password' | 'sso' | 'admin_no_password'

export const ACTIVATE_MODES: readonly ActivateMode[] = [
  'temp_password',
  'sso',
  'admin_no_password',
] as const

export function isActivateMode(value: unknown): value is ActivateMode {
  return value === 'temp_password' || value === 'sso' || value === 'admin_no_password'
}

export type ActivateUserInput = {
  userId: string
  mode: ActivateMode
  adminUserId?: string
  /** When mode=temp_password; generated if omitted. */
  temporaryPassword?: string
  orgId?: string | null
  enableDingTalkGrant?: boolean
  /** SSO: directory account that must be active + linked to this user. */
  directoryAccountId?: string | null
  /** OAuth SSO: provider identity that the locked directory source must still match. */
  expectedDingTalkIdentity?: {
    corpId: string
    openId?: string | null
    unionId?: string | null
  } | null
}

export type ActivateUserResult = {
  userId: string
  activationStatus: 'activated'
  isActive: true
  temporaryPassword?: string
  localPasswordSet: boolean
}

/**
 * Closed set of activation failure reasons this module is allowed to throw.
 *
 * This is the authored-reason set. `ACTIVATE_FAILED` is deliberately NOT a member: it is the
 * response layer's fallback for everything unauthored, and admitting it here would make the
 * throw-site/policy-table set equality in
 * `tests/unit/admin-users-activate-error-closure.test.ts` trivially satisfiable.
 *
 * Adding a reason without adding its policy-table row is a compile error at the table's
 * `Record<ActivateErrorCode, …>` type (see `ACTIVATE_ERROR_POLICY` in `routes/admin-users.ts`);
 * throwing a reason that is not a member is a compile error here at `throwCoded`.
 */
export type ActivateErrorCode =
  | 'ACTIVATE_USER_REQUIRED'
  | 'ACTIVATE_USER_NOT_FOUND'
  | 'ACTIVATE_NOT_PENDING'
  | 'ACTIVATE_RACE'
  | 'ACTIVATE_ALIAS_CONFLICT'
  | 'ACTIVATE_ALIAS_REQUIRED'
  | 'ACTIVATE_ALIAS_FAILED'
  | 'ACTIVATE_SOURCE_MISSING'
  | 'ACTIVATE_SOURCE_INACTIVE'
  | 'ACTIVATE_INTEGRATION_INACTIVE'
  | 'ACTIVATE_LINK_MISMATCH'
  /** SSO-only: account/integration provider is not DingTalk, or corp_id is inconsistent. */
  | 'ACTIVATE_SOURCE_INELIGIBLE'
  /** Caller-supplied orgId disagrees with the org derived from the directory-source integration. */
  | 'ACTIVATE_ORG_MISMATCH'
  /** Multiple ACTIVE directory sources in different orgs; the caller must name one (#4833). */
  | 'ACTIVATE_ORG_AMBIGUOUS'

function throwCoded(message: string, code: ActivateErrorCode): never {
  const err = new Error(message)
  ;(err as Error & { code?: string }).code = code
  throw err
}

/**
 * Activate a pending user. All durable writes in one transaction.
 */
export async function activatePendingUser(input: ActivateUserInput): Promise<ActivateUserResult> {
  const userId = String(input.userId || '').trim()
  if (!userId) throwCoded('userId is required', 'ACTIVATE_USER_REQUIRED')

  let temporaryPassword: string | undefined
  let passwordHash: string | null = null
  let localPasswordSet = false
  let mustChangePassword = false
  let membershipOrgId = input.orgId ?? null

  if (input.mode === 'temp_password') {
    temporaryPassword = input.temporaryPassword?.trim() || generateTempPassword()
    passwordHash = await bcrypt.hash(temporaryPassword, getBcryptSaltRounds())
    localPasswordSet = true
    mustChangePassword = true
  } else if (input.mode === 'sso') {
    // SSO activate: unusable local password; login via DingTalk after grant.
    passwordHash = await buildUnusablePasswordHash()
    localPasswordSet = false
    mustChangePassword = false
  } else {
    passwordHash = await buildUnusablePasswordHash()
    localPasswordSet = false
  }

  await transaction(async (client) => {
    const lockedUsers = await lockUsersForAccessGraphWrite(client, [userId])
    const user = lockedUsers.get(userId)
    if (!user) {
      throwCoded('User not found', 'ACTIVATE_USER_NOT_FOUND')
    }
    if (user.activationStatus !== 'pending_activation') {
      throwCoded(
        'User is not pending_activation',
        'ACTIVATE_NOT_PENDING',
      )
    }

    // Closeout review P1: EVERY activation mode resolves and validates the authoritative
    // directory source — the gated form (`sso || directoryAccountId`) let temp_password /
    // admin_no_password activate an offboarded or source-dead pending user by simply not
    // mentioning the source, which the design lock forbids ("admin 激活同样不得对 inactive
    // 目录源静默开通"). Pending users exist only via directory admission, so a pending user
    // with no linked active source is a refusal (ACTIVATE_SOURCE_MISSING), not a pass.
    //
    // The membership org DERIVES from the source integration in every mode; a client-supplied
    // orgId may only CONFIRM it. The gated form discarded the DB's org for non-SSO modes and
    // trusted the client's — "org A 的目录账号 + org B 的 orgId" wrote a cross-org membership.
    // #4833: when the person has ACTIVE sources in more than one org, "derive" has no unique
    // answer — the helper validates a caller-supplied orgId against the SET of active eligible
    // sources (mismatch → ACTIVATE_ORG_MISMATCH) and refuses a caller who names none
    // (ACTIVATE_ORG_AMBIGUOUS) instead of silently picking the lowest account id.
    const sourceOrgId = await assertDirectorySourceActiveForActivate(client, {
      userId,
      directoryAccountId: input.directoryAccountId ?? null,
      requireDingTalkSso: input.mode === 'sso',
      expectedDingTalkIdentity: input.expectedDingTalkIdentity ?? null,
      requestedOrgId: input.orgId ?? null,
    })
    membershipOrgId = sourceOrgId

    const updated = await client.query(
      `UPDATE users
          SET activation_status = 'activated',
              is_active = TRUE,
              password_hash = COALESCE($2, password_hash),
              local_password_set = $3,
              must_change_password = $4,
              updated_at = NOW()
        WHERE id = $1
          AND activation_status = 'pending_activation'
        RETURNING id`,
      [userId, passwordHash, localPasswordSet, mustChangePassword],
    )
    if (!updated.rows[0]) {
      throwCoded('Activation race: user no longer pending', 'ACTIVATE_RACE')
    }

    // Active membership for current org when provided.
    if (membershipOrgId) {
      // `user_orgs` is (user_id, org_id, is_active, created_at) with PK (user_id, org_id) — there
      // is no `updated_at`. Writing one raised `42703` and aborted this transaction, which is why
      // the "schema variance" fallback underneath could never help: once a statement fails inside
      // a transaction, Postgres rejects every later statement with `25P02`, the fallback
      // included. The net effect was that activating a pending user WITH an org — the ordinary
      // case — could not succeed at all; it died at COMMIT. Writing the real shape is the fix,
      // and the fallback goes with it: a second guess at the schema is not a substitute for
      // matching it.
      await client.query(
        `INSERT INTO user_orgs (user_id, org_id, is_active, created_at)
         VALUES ($1, $2, TRUE, NOW())
         ON CONFLICT (user_id, org_id) DO UPDATE
           SET is_active = TRUE`,
        [userId, membershipOrgId],
      )
    }

    if (input.enableDingTalkGrant === true) {
      // The DingTalk grant lives in `user_external_auth_grants` — the table `dingtalk-oauth.ts`
      // reads to decide whether a login is allowed. This wrote `user_external_identities
      // .grant_enabled`, a column no migration creates, inside a `.catch`: activation reported
      // success while the person was never actually granted DingTalk login. Same upsert shape the
      // OAuth bind path uses.
      //
      // The swallow is gone with it. Inside a transaction a failed statement poisons the
      // connection, so catching the rejection does not make the failure harmless — it only moves
      // the error to whichever innocent statement runs next, as `25P02`.
      await client.query(
        `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, granted_by, created_at, updated_at)
         VALUES ('dingtalk', $1, TRUE, $2, NOW(), NOW())
         ON CONFLICT (provider, local_user_id)
         DO UPDATE SET enabled = TRUE, granted_by = EXCLUDED.granted_by, updated_at = NOW()`,
        [userId, `activate:${input.adminUserId ?? 'system'}`],
      )
    }

    // Alias claims are MANDATORY inside the same transaction as activation.
    // No client opt-out: post-commit / optional claim left "activated + password issued
    // but cannot log in" under AUTH_LOGIN_USE_ALIASES. Fail closed → full activate rollback.
    const fields: Array<{ raw: string | null; kind: 'email' | 'username' | 'mobile' }> = [
      { raw: user.email, kind: 'email' },
      { raw: user.username, kind: 'username' },
      { raw: user.mobile, kind: 'mobile' },
    ]
    let claimedAny = false
    for (const field of fields) {
      if (!field.raw || !String(field.raw).trim()) continue
      const claimed = await claimLoginAlias({
        userId,
        rawValue: field.raw,
        kind: field.kind,
        source: 't3_activate',
        client,
      })
      if (claimed.ok === false) {
        // Never echo claim.message (may contain raw PostgreSQL text). Map codes only:
        // CONFLICT / REQUIRED → client 409; WRITE_FAILED → 500 ACTIVATE_ALIAS_FAILED.
        if (claimed.code === 'ALIAS_CONFLICT') {
          throwCoded(
            `Login alias for ${field.kind} is already claimed by another account`,
            'ACTIVATE_ALIAS_CONFLICT',
          )
        }
        if (claimed.code === 'ALIAS_EMPTY') {
          throwCoded(
            `Login alias for ${field.kind} is empty after normalization`,
            'ACTIVATE_ALIAS_REQUIRED',
          )
        }
        throwCoded(
          'Failed to claim login alias during activation',
          'ACTIVATE_ALIAS_FAILED',
        )
      }
      claimedAny = true
    }
    if (!claimedAny) {
      throwCoded(
        'Activation requires at least one claimable login identifier (email, username, or mobile)',
        'ACTIVATE_ALIAS_REQUIRED',
      )
    }

    await supersedeDeprovisionEvidenceForAccessGraphWrite(client, {
      userIds: [userId],
      actorId: input.adminUserId ?? userId,
      reason: 'superseded by pending-user activation',
    })
  })

  return {
    userId,
    activationStatus: 'activated',
    isActive: true,
    temporaryPassword,
    localPasswordSet,
  }
}

type DirectorySourceRow = {
  account_active: boolean
  integration_status: string
  local_user_id: string | null
  link_status: string | null
  account_provider: string | null
  integration_provider: string | null
  account_corp_id: string | null
  integration_corp_id: string | null
  account_open_id: string | null
  account_union_id: string | null
  integration_org_id: string | null
}

async function assertDirectorySourceActiveForActivate(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  options: {
    userId: string
    directoryAccountId: string | null
    requireDingTalkSso: boolean
    expectedDingTalkIdentity: ActivateUserInput['expectedDingTalkIdentity']
    requestedOrgId: string | null
  },
): Promise<string> {
  // Closed set: linked directory account must be active; integration active.
  // Explicit id: account row + link fail-closed (INNER semantics enforced in TS after LEFT JOIN
  // so we can distinguish SOURCE_MISSING account-not-found from LINK_MISMATCH).
  // Implicit: start from links with exact link_status='linked' (no COALESCE default).
  const sql = options.directoryAccountId
    ? `SELECT da.id, da.is_active AS account_active, di.status AS integration_status,
              l.local_user_id, l.link_status,
              da.provider AS account_provider, di.provider AS integration_provider,
              da.corp_id AS account_corp_id, di.corp_id AS integration_corp_id,
              da.open_id AS account_open_id, da.union_id AS account_union_id,
              di.org_id AS integration_org_id
         FROM directory_accounts da
         JOIN directory_integrations di ON di.id = da.integration_id
         LEFT JOIN directory_account_links l ON l.directory_account_id = da.id
        WHERE da.id = $1`
    : `SELECT da.id, da.is_active AS account_active, di.status AS integration_status,
              l.local_user_id, l.link_status,
              da.provider AS account_provider, di.provider AS integration_provider,
              da.corp_id AS account_corp_id, di.corp_id AS integration_corp_id,
              da.open_id AS account_open_id, da.union_id AS account_union_id,
              di.org_id AS integration_org_id
         FROM directory_account_links l
         JOIN directory_accounts da ON da.id = l.directory_account_id
         JOIN directory_integrations di ON di.id = da.integration_id
        WHERE l.local_user_id = $1
          AND l.link_status = 'linked'
        ORDER BY da.id`

  const params = options.directoryAccountId
    ? [options.directoryAccountId]
    : [options.userId]
  const result = await client.query(sql, params)
  const rows = result.rows as DirectorySourceRow[]
  const row = rows[0]

  if (!row) {
    throwCoded('No linked active directory account for activation', 'ACTIVATE_SOURCE_MISSING')
  }

  // Fail closed on the link itself (explicit path especially — LEFT JOIN can return account
  // rows with no link / unlinked / null local_user_id).
  const linkStatus = row.link_status == null ? null : String(row.link_status)
  const linkedUserId = row.local_user_id == null ? null : String(row.local_user_id)
  if (linkStatus !== 'linked') {
    // Not a linked source for anyone (missing row, pending, unlinked, …).
    throwCoded('No linked active directory account for activation', 'ACTIVATE_SOURCE_MISSING')
  }
  if (linkedUserId !== options.userId) {
    // Linked status but not this pending user: precise mismatch vs missing.
    if (linkedUserId) {
      throwCoded('Directory link points to a different user', 'ACTIVATE_LINK_MISMATCH')
    }
    throwCoded('No linked active directory account for activation', 'ACTIVATE_SOURCE_MISSING')
  }

  const isDingTalkEligible = (candidate: DirectorySourceRow): boolean => {
    const accountProvider = String(candidate.account_provider || '').toLowerCase()
    const integrationProvider = String(candidate.integration_provider || '').toLowerCase()
    const accountCorp = String(candidate.account_corp_id || '').trim()
    const integrationCorp = String(candidate.integration_corp_id || '').trim()
    const providerAndCorpEligible = (
      accountProvider === 'dingtalk'
      && integrationProvider === 'dingtalk'
      && accountCorp.length > 0
      && accountCorp === integrationCorp
    )
    if (!providerAndCorpEligible) return false

    const expected = options.expectedDingTalkIdentity
    if (!expected) return true
    const expectedCorp = String(expected.corpId || '').trim()
    const expectedOpenId = String(expected.openId || '').trim()
    const expectedUnionId = String(expected.unionId || '').trim()
    if (
      expectedCorp.length === 0
      || (expectedOpenId.length === 0 && expectedUnionId.length === 0)
      || accountCorp !== expectedCorp
    ) {
      return false
    }
    if (
      expectedOpenId.length > 0
      && String(candidate.account_open_id || '').trim() !== expectedOpenId
    ) {
      return false
    }
    if (
      expectedUnionId.length > 0
      && String(candidate.account_union_id || '').trim() !== expectedUnionId
    ) {
      return false
    }
    return true
  }

  const eligibleRows = options.requireDingTalkSso
    ? rows.filter(isDingTalkEligible)
    : rows
  if (eligibleRows.length === 0) {
    throwCoded(
      'Directory source is not a DingTalk account eligible for SSO activation',
      'ACTIVATE_SOURCE_INELIGIBLE',
    )
  }
  const activeEligibleRows = eligibleRows.filter(
    (candidate) =>
      candidate.account_active === true
      && String(candidate.integration_status || '').toLowerCase() === 'active',
  )
  if (activeEligibleRows.length > 0) {
    // #4833: derive against the SET of active eligible sources, not the first row. An active
    // source whose integration carries no org is misconfigured — it cannot anchor a membership
    // write, so it never joins the candidate set.
    const candidateOrgIds = [...new Set(
      activeEligibleRows
        .map((candidate) => String(candidate.integration_org_id || '').trim())
        .filter((orgId) => orgId.length > 0),
    )]
    if (candidateOrgIds.length === 0) {
      throwCoded(
        'Directory source is not a DingTalk account eligible for SSO activation',
        'ACTIVATE_SOURCE_INELIGIBLE',
      )
    }
    if (options.requestedOrgId) {
      if (candidateOrgIds.includes(options.requestedOrgId)) {
        return options.requestedOrgId
      }
      // The caller named an org none of the person's ACTIVE sources belongs to — steering.
      throwCoded(
        'orgId does not match the directory source integration for this user',
        'ACTIVATE_ORG_MISMATCH',
      )
    }
    if (candidateOrgIds.length === 1) {
      return candidateOrgIds[0]
    }
    // No orgId and more than one legitimate answer: refusing beats silently picking one —
    // activation would otherwise write an arbitrary org's membership (#4833).
    throwCoded(
      'Multiple active directory sources in different orgs; orgId is required to disambiguate',
      'ACTIVATE_ORG_AMBIGUOUS',
    )
  }
  if (eligibleRows.some(
    (candidate) => String(candidate.integration_status || '').toLowerCase() !== 'active',
  )) {
    throwCoded('Directory integration is not active; cannot activate', 'ACTIVATE_INTEGRATION_INACTIVE')
  }
  throwCoded('Directory account is inactive; cannot activate', 'ACTIVATE_SOURCE_INACTIVE')
}

function generateTempPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#'
  let out = 'Tmp#'
  for (let i = 0; i < 12; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return out
}
