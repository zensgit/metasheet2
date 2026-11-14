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

export type DirectoryIdentityStatus = 'unverified' | 'verified' | 'mismatch'

function parseConfigRecord(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }
  return typeof value === 'object' ? value as Record<string, unknown> : {}
}

function configText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim()
}

/** The application key stored in an integration's `config`, trimmed; empty when there is none. */
export function readDirectoryIntegrationAppKey(config: unknown): string {
  return configText(parseConfigRecord(config).appKey)
}

/**
 * Identity status of one integration row, from its `corp_id` and its stored `config`:
 *   - `unverified`: no stored confirmation that still matches the row's binding (enterprise id,
 *     application key, enterprise name, application name), source and shape;
 *   - `verified`: such a confirmation exists and names the row's own enterprise id;
 *   - `mismatch`: such a confirmation exists and names another enterprise id.
 * The confirmation is read through `readDirectoryIdentityVerification` with the binding the
 * integration summary uses, so both answer the same for the same row. Display evidence only.
 */
export function readDirectoryIdentityStatus(row: { corpId: string; config: unknown }): DirectoryIdentityStatus {
  const config = parseConfigRecord(row.config)
  const verification = readDirectoryIdentityVerification(config.identityVerification, {
    corpId: row.corpId,
    appKey: configText(config.appKey),
    corpName: configText(config.corpName) || null,
    appName: configText(config.appName) || null,
  })
  if (!verification) return 'unverified'
  return verification.appCorpId === row.corpId ? 'verified' : 'mismatch'
}
