import type { DingTalkDirectoryUser } from '../integrations/dingtalk/client'
import type {
  DirectoryIdentityMatchMaps, DirectoryIdentityMatchAccount, DirectoryIdentityExistingLink,
  DirectoryIdentityMatchOutcome, DirectoryAutoAdmissionEligibility, DirectoryProjectedMemberGroupPlan,
  DirectoryProjectedGovernanceGrantSet,
} from './directory-sync'
import { normalizeLoginIdentifier } from '../auth/login-identifier'
import { orderDirectoryMatchingAccounts, rememberDirectoryAdmission } from './directory-sync-match-state'
import { projectDirectoryPreviewGroupEffects, type DirectoryPreviewGroupEffects } from './directory-preview-group-effects'

export type DirectoryPreviewAccount = {
  id: string; corp_id: string | null; external_user_id: string; union_id: string | null; open_id: string | null
  external_key: string; name: string; email: string | null; mobile: string | null; is_active: boolean
  local_user_id: string | null; link_status: string | null; match_strategy: string | null
  existed?: boolean; was_active?: boolean
}
type AdmissionIdentifiers = { email: string | null; mobile: string | null; username: string | null; valid: boolean }
type Reader = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
export type DirectorySyncPreview = DirectoryPreviewGroupEffects & {
  integrationId: string; integrationName: string; departmentsSeen: number; accountsSeen: number
  wouldCreateAccounts: number; wouldDeactivateAccounts: number; wouldDeactivateLinkedAccounts: number
  wouldBindAccounts: number; wouldUnbindAccounts: number; wouldAdmitUsers: number
  autoAdmissionMode: 'manual_only' | 'auto_for_scoped_departments'
  autoAdmissionCandidateCount: number; autoAdmissionSkippedMissingEmailCount: number; autoAdmissionExcludedCount: number
  sampledNewAccounts: Array<{ externalUserId: string; name: string }>
  sampledDeactivations: Array<{ externalUserId: string; name: string; linked: boolean }>
}
const text = (value: unknown) => typeof value === 'string' ? value.trim() : String(value ?? '').trim()
const optional = (value: unknown) => text(value) || null

/** Mirror the actual upsert's retained-openId CASE and the subsequent absence sweep. */
export function buildDirectoryProspectiveAccounts(
  prior: DirectoryPreviewAccount[], users: Map<string, DingTalkDirectoryUser>, corpId: string | null,
): DirectoryPreviewAccount[] {
  const accounts = new Map(prior.map(a => [a.external_user_id, { ...a, existed: true, was_active: a.is_active, is_active: false }]))
  for (const user of users.values()) {
    const old = accounts.get(user.userId)
    const unionId = optional(user.unionId)
    const openId = optional(user.openId)
    accounts.set(user.userId, {
      id: old?.id ?? user.userId, corp_id: corpId, external_user_id: user.userId,
      union_id: unionId,
      open_id: openId || (unionId !== null && unionId === old?.union_id && corpId === old.corp_id ? old.open_id : null),
      external_key: text(user.unionId || user.openId || user.userId),
      name: user.name, email: optional(user.email), mobile: optional(user.mobile), is_active: true,
      local_user_id: old?.local_user_id ?? null, link_status: old?.link_status ?? null,
      match_strategy: old?.match_strategy ?? null, existed: old?.existed ?? false, was_active: old?.was_active ?? false,
    })
  }
  return orderDirectoryMatchingAccounts(Array.from(accounts.values()))
}

/** A read-only projection; dependencies keep the existing match/admission/group rules single-sourced. */
export async function projectDirectorySyncPreview(options: {
  integrationId: string; integrationName: string; departmentsSeen: number
  autoAdmissionMode: 'manual_only' | 'auto_for_scoped_departments'
  accounts: DirectoryPreviewAccount[]; users: Map<string, DingTalkDirectoryUser>; maps: DirectoryIdentityMatchMaps
  pendingActivation: boolean
}, rules: {
  query: Reader
  match: (account: DirectoryIdentityMatchAccount, link: DirectoryIdentityExistingLink | null, maps: DirectoryIdentityMatchMaps) => DirectoryIdentityMatchOutcome
  eligibility: (account: DirectoryPreviewAccount, user: DingTalkDirectoryUser | undefined) => DirectoryAutoAdmissionEligibility
  identifiers: (account: DirectoryPreviewAccount) => AdmissionIdentifiers
  bindKey: (account: DirectoryPreviewAccount) => string
  groups: (linked: Map<string, string>) => DirectoryProjectedMemberGroupPlan[]
  grants: (plans: DirectoryProjectedMemberGroupPlan[]) => DirectoryProjectedGovernanceGrantSet
}): Promise<DirectorySyncPreview> {
  const { accounts, users, maps } = options
  const prepared = new Map(accounts.map(a => [a.external_user_id, rules.identifiers(a)]))
  const values = Array.from(prepared.values())
  const emails = values.flatMap(a => a.email ? [a.email] : [])
  const mobiles = values.flatMap(a => a.mobile ? [a.mobile] : [])
  const usernames = values.flatMap(a => a.username ? [a.username] : [])
  const aliases = options.pendingActivation ? [] : values.flatMap(a => [a.email, a.username, a.mobile])
    .filter((a): a is string => Boolean(a)).map(normalizeLoginIdentifier).filter(Boolean)
  const [existingUsers, existingAliases, bindIdentities] = await Promise.all([
    rules.query(`SELECT email, username, mobile FROM users
      WHERE lower(email) = ANY($1::text[]) OR lower(username) = ANY($2::text[]) OR mobile = ANY($3::text[])`,
    [emails, usernames, mobiles]),
    aliases.length ? rules.query('SELECT normalized_value FROM user_login_aliases WHERE normalized_value = ANY($1::text[])', [aliases]) : Promise.resolve({ rows: [] }),
    rules.query(`SELECT external_key FROM user_external_identities WHERE provider = 'dingtalk' AND external_key = ANY($1::text[])`,
      [accounts.map(rules.bindKey).filter(Boolean)]),
  ])
  const claimedEmails = new Set(existingUsers.rows.map(a => text(a.email).toLowerCase()).filter(Boolean))
  const claimedUsernames = new Set(existingUsers.rows.map(a => text(a.username).toLowerCase()).filter(Boolean))
  const claimedMobiles = new Set(existingUsers.rows.map(a => String(a.mobile ?? '')).filter(Boolean))
  const claimedAliases = new Set(existingAliases.rows.map(a => String(a.normalized_value)))
  const claimedBindKeys = new Set(bindIdentities.rows.map(a => String(a.external_key)))
  const hypothetical = new Set<string>()
  const linked = new Map<string, string>()
  const result: Omit<DirectorySyncPreview, keyof DirectoryPreviewGroupEffects> = {
    integrationId: options.integrationId, integrationName: options.integrationName,
    departmentsSeen: options.departmentsSeen, accountsSeen: users.size,
    wouldCreateAccounts: 0, wouldDeactivateAccounts: 0, wouldDeactivateLinkedAccounts: 0,
    wouldBindAccounts: 0, wouldUnbindAccounts: 0, wouldAdmitUsers: 0,
    autoAdmissionMode: options.autoAdmissionMode, autoAdmissionCandidateCount: 0,
    autoAdmissionSkippedMissingEmailCount: 0, autoAdmissionExcludedCount: 0,
    sampledNewAccounts: [], sampledDeactivations: [],
  }
  for (const account of accounts) {
    const user = users.get(account.external_user_id)
    if (user && !account.existed) {
      result.wouldCreateAccounts++
      if (result.sampledNewAccounts.length < 10) result.sampledNewAccounts.push({ externalUserId: user.userId, name: user.name })
    }
    const oldUser = account.link_status === 'linked' ? account.local_user_id : null
    if (account.was_active && !user) {
      result.wouldDeactivateAccounts++
      if (oldUser) result.wouldDeactivateLinkedAccounts++
      if (result.sampledDeactivations.length < 10) result.sampledDeactivations.push({
        externalUserId: account.external_user_id, name: account.name, linked: Boolean(oldUser),
      })
    }
    const match = rules.match({
      corpId: account.corp_id, externalKey: account.external_key, unionId: account.union_id,
      openId: account.open_id, email: account.email, mobile: account.mobile,
    }, account.link_status ? { local_user_id: account.local_user_id, link_status: account.link_status } : null, maps)
    let nextUser = match.matched === 'already_linked' ? oldUser : match.matched === 'external_identity' ? match.localUserId : null
    if (match.matched === 'none') {
      const eligible = rules.eligibility(account, user)
      if (eligible.excluded) result.autoAdmissionExcludedCount++
      if (eligible.inScope) {
        result.autoAdmissionCandidateCount++
        const ids = prepared.get(account.external_user_id)!
        const normalizedAliases = options.pendingActivation ? [] : [ids.email, ids.username, ids.mobile]
          .filter((v): v is string => Boolean(v)).map(normalizeLoginIdentifier).filter(Boolean)
        const key = rules.bindKey(account)
        const canAdmit = user && ids.valid && key && !claimedBindKeys.has(key)
          && (!ids.email || !claimedEmails.has(ids.email.toLowerCase()))
          && (!ids.username || !claimedUsernames.has(ids.username.toLowerCase()))
          && (!ids.mobile || !claimedMobiles.has(ids.mobile))
          && normalizedAliases.every(a => !claimedAliases.has(a))
        if (canAdmit) {
          // PostgreSQL text cannot contain NUL: this distinct internal subject cannot collide with a persisted user.
          nextUser = '\0preview:' + result.wouldAdmitUsers++
          hypothetical.add(nextUser)
          if (ids.email) claimedEmails.add(ids.email.toLowerCase())
          if (ids.username) claimedUsernames.add(ids.username.toLowerCase())
          if (ids.mobile) claimedMobiles.add(ids.mobile)
          for (const alias of normalizedAliases) claimedAliases.add(alias)
          claimedBindKeys.add(key)
          rememberDirectoryAdmission(maps, account, nextUser, ids.email, ids.mobile)
        }
      } else if (eligible.missingEmail) result.autoAdmissionSkippedMissingEmailCount++
    }
    if (oldUser !== nextUser) {
      if (oldUser) result.wouldUnbindAccounts++
      if (nextUser) result.wouldBindAccounts++
    }
    if (nextUser && user) linked.set(account.external_user_id, nextUser)
  }
  const plans = rules.groups(linked)
  const grants = rules.grants(plans)
  const existingIds = grants.userIds.filter(id => !hypothetical.has(id))
  const existingGroups = plans.length ? await rules.query(
    'SELECT id, description FROM platform_member_groups WHERE description = ANY($1::text[]) ORDER BY id ASC',
    [plans.map(p => p.marker)],
  ) : { rows: [] }
  const groupIds = existingGroups.rows.map(a => String(a.id))
  const [members, roles, namespaces] = await Promise.all([
    groupIds.length ? rules.query('SELECT group_id, user_id FROM platform_member_group_members WHERE group_id::text = ANY($1::text[])', [groupIds]) : Promise.resolve({ rows: [] }),
    existingIds.length && grants.roleIds.length ? rules.query('SELECT user_id, role_id FROM user_roles WHERE user_id = ANY($1::text[]) AND role_id = ANY($2::text[])', [existingIds, grants.roleIds]) : Promise.resolve({ rows: [] }),
    existingIds.length && grants.namespaces.length ? rules.query('SELECT user_id, namespace, enabled FROM user_namespace_admissions WHERE user_id = ANY($1::text[]) AND namespace = ANY($2::text[])', [existingIds, grants.namespaces]) : Promise.resolve({ rows: [] }),
  ])
  return { ...result, ...projectDirectoryPreviewGroupEffects({
    plans, grantSet: grants,
    existingGroups: existingGroups.rows.map(a => ({ id: String(a.id), description: text(a.description) })),
    members: members.rows.map(a => ({ groupId: String(a.group_id), userId: text(a.user_id) })),
    rolePairs: roles.rows.map(a => ({ userId: text(a.user_id), roleId: text(a.role_id) })),
    namespacePairs: namespaces.rows.map(a => ({ userId: text(a.user_id), namespace: text(a.namespace), enabled: a.enabled === true })),
  }) }
}
