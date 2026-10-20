/**
 * DT-HARDEN-02 — the ONE rule for "may this DingTalk directory member be granted DingTalk login".
 *
 * A grant needs a stable identity key. Corp-scoped accounts key on corpId+openId, so a corp
 * account WITHOUT an openId cannot be granted; non-corp accounts key on unionId and are grantable.
 * 通讯录 user/get never returns openId and a DingTalk login only writes user_external_identities,
 * so the openId may come from two places: the directory row itself, or the identity a DingTalk
 * login recorded for the SAME person (same provider, same corp_id, same unionId — never "whatever
 * identity the local user happens to hold").
 *
 * Every reader uses this module, so they cannot drift apart:
 *  - the directory bind/admit assertion and the auto-admission predicate (directory-sync.ts);
 *  - the directory page's `grantOpenIdAvailable` (account summary / review items);
 *  - pending-user activation that writes the grant (auth/user-activate.ts).
 */

export type DirectoryAccountGrantOpenIdSource = {
  corp_id: string | null
  open_id: string | null
  linked_identity_open_id?: string | null
}

function trimmed(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** The openId backing a corp-scoped grant: own openId, else the same-person login openId. */
export function resolveDirectoryAccountGrantOpenId(account: DirectoryAccountGrantOpenIdSource): string | null {
  return trimmed(account.open_id) || trimmed(account.linked_identity_open_id) || null
}

/** The DT-HARDEN-02 predicate. */
export function canDirectoryAccountEnableDingTalkGrant(account: DirectoryAccountGrantOpenIdSource): boolean {
  return !trimmed(account.corp_id) || Boolean(resolveDirectoryAccountGrantOpenId(account))
}

/**
 * Scalar subquery yielding the openId a DingTalk login recorded for the same person as the
 * directory account aliased `alias`: same provider, same corp_id, same unionId. A corp-less or
 * union-less account never matches (NULL = NULL is not true). If more than one distinct openId is
 * on file (only possible before the corp-scoped identity unique indexes are deployed) the result
 * is NULL — ambiguity fails closed instead of picking one.
 */
export function buildDirectoryAccountLinkedIdentityOpenIdSql(alias: 'account' | 'a'): string {
  return `(
       SELECT CASE WHEN COUNT(DISTINCT identity.provider_open_id) = 1
                   THEN MIN(identity.provider_open_id)
              END
       FROM user_external_identities identity
       WHERE identity.provider = ${alias}.provider
         AND identity.corp_id = ${alias}.corp_id
         AND identity.provider_union_id = ${alias}.union_id
         AND COALESCE(identity.provider_open_id, '') <> ''
     )`
}
