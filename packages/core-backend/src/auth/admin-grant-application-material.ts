import { createHash } from 'node:crypto'

const MATERIAL_DOMAIN = 'metasheet:admin-grant-application-material:v1|'
const MATERIAL_FIELDS = ['appKey', 'appSecret', 'baseUrl', 'workNotificationAgentId'] as const

export class AdminGrantApplicationMaterialError extends Error {
  constructor() {
    super('Invalid admin grant application material')
  }
}

export function adminGrantApplicationMaterialFingerprint(config: unknown): string {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) throw new AdminGrantApplicationMaterialError()
  const record = config as Record<string, unknown>
  const canonical: Record<(typeof MATERIAL_FIELDS)[number], string | null> = {
    appKey: '',
    appSecret: '',
    baseUrl: '',
    workNotificationAgentId: '',
  }
  for (const field of MATERIAL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) continue
    const value = record[field]
    if ((field === 'baseUrl' || field === 'workNotificationAgentId') && value === null) {
      canonical[field] = null
      continue
    }
    if (typeof value !== 'string') throw new AdminGrantApplicationMaterialError()
    canonical[field] = value
  }
  const encoded = JSON.stringify({
    appKey: canonical.appKey,
    appSecret: canonical.appSecret,
    baseUrl: canonical.baseUrl,
    workNotificationAgentId: canonical.workNotificationAgentId,
  })
  return createHash('sha256').update(MATERIAL_DOMAIN).update(encoded).digest('hex')
}
