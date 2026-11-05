export type DirectoryIdentityBinding = {
  corpId: string
  appKey: string
  corpName: string | null
  appName: string | null
}

export type DirectoryIdentityVerification = DirectoryIdentityBinding & {
  source: 'admin_console'
  appCorpId: string
  appCorpName: string
  checkedAt: string
  checkedBy: string
}

/** Display evidence only: never used to authorize login, synchronization or membership. */
export function readDirectoryIdentityVerification(
  value: unknown,
  binding: DirectoryIdentityBinding,
): DirectoryIdentityVerification | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.source !== 'admin_console') return null
  const text = (key: string) => typeof record[key] === 'string' ? record[key].trim() : ''
  const proof: DirectoryIdentityVerification = {
    corpId: text('corpId'),
    appKey: text('appKey'),
    corpName: text('corpName'),
    appName: text('appName'),
    appCorpId: text('appCorpId'),
    appCorpName: text('appCorpName'),
    source: 'admin_console',
    checkedAt: text('checkedAt'),
    checkedBy: text('checkedBy'),
  }
  if (Object.entries(binding).some(([key, expected]) => record[key] !== expected)) return null
  if (![proof.corpName, proof.appName, proof.appCorpName, proof.checkedBy]
    .every((name) => name && name.length <= 200)) return null
  if (![proof.corpId, proof.appKey, proof.appCorpId]
    .every((id) => id.length <= 512 && /^[!-~]+$/.test(id))) return null
  if (proof.checkedAt.length > 64 || !Number.isFinite(Date.parse(proof.checkedAt))) return null
  return proof
}
