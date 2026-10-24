import type { DirectoryIdentityMatchMaps } from './directory-sync'

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim()
}

export function buildScopedIdentityKey(corpId: string | null | undefined, providerId: string | null | undefined): string | null {
  const normalizedProviderId = normalizeText(providerId)
  if (!normalizedProviderId) return null
  const normalizedCorpId = normalizeText(corpId)
  // Delimiter concatenation is not injective: ('a:b', 'c') and ('a', 'b:c') collide.
  return JSON.stringify([normalizedCorpId || null, normalizedProviderId])
}


export function addScopedIdentityCandidate(
  uniqueMap: Map<string, string>,
  ambiguousKeys: Set<string>,
  key: string | null,
  localUserId: string,
): void {
  if (!key || ambiguousKeys.has(key)) return
  const existingUserId = uniqueMap.get(key)
  if (existingUserId && existingUserId !== localUserId) {
    uniqueMap.delete(key)
    ambiguousKeys.add(key)
    return
  }
  uniqueMap.set(key, localUserId)
}


/** Shared explicit order: same-batch admission mutates the next account's match inputs. */
export function orderDirectoryMatchingAccounts<T extends { external_user_id: string }>(accounts: T[]): T[] {
  return [...accounts].sort((a, b) => a.external_user_id < b.external_user_id ? -1 : a.external_user_id > b.external_user_id ? 1 : 0)
}

export function rememberDirectoryAdmission(
  maps: DirectoryIdentityMatchMaps,
  account: { corp_id: string | null; external_key: string; open_id: string | null; union_id: string | null },
  userId: string,
  cleanEmail: string | null,
  cleanMobile: string | null,
): void {
  if (cleanEmail) { maps.emailMap.set(cleanEmail.toLowerCase(), userId); maps.ambiguousEmailKeys.delete(cleanEmail.toLowerCase()) }
  if (cleanMobile) { maps.mobileMap.set(cleanMobile, userId); maps.ambiguousMobileKeys.delete(cleanMobile) }
  addScopedIdentityCandidate(maps.scopedExternalIdentityMap, maps.ambiguousScopedExternalIdentityKeys,
    buildScopedIdentityKey(account.corp_id, account.external_key), userId)
  addScopedIdentityCandidate(maps.scopedOpenIdentityMap, maps.ambiguousScopedOpenIdentityKeys,
    buildScopedIdentityKey(account.corp_id, account.open_id), userId)
  addScopedIdentityCandidate(maps.scopedUnionIdentityMap, maps.ambiguousScopedUnionIdentityKeys,
    buildScopedIdentityKey(account.corp_id, account.union_id), userId)
}
