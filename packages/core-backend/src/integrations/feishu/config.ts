/**
 * Feishu connection configuration and identifiers.
 *
 * A Feishu connection is one `directory_integrations` row (`provider = 'feishu'`): the tenant is the
 * row's `corp_id`, the application scope is `config.appId`, the credential is `config.appSecret`
 * (stored encrypted) and the brand is `config.brand`. There is no base-URL setting: a configuration
 * that names one is refused. Credentials come from the row only; nothing here reads the environment.
 *
 * Identifiers are typed references, `(connectionId, idType, value)`; an open id is only meaningful for
 * the application that issued it, so a function that takes one also takes the connection it belongs to.
 */
import { scopeFromValues, type IntegrationScope } from '../provider-capability-registry'
import { isFeishuBrand, type FeishuBrand } from './endpoints'
import {
  FEISHU_ID_TYPES,
  FeishuIdConnectionMismatchError,
  FeishuIdRefError,
  type FeishuIdType,
} from './errors'

export const FEISHU_APP_ID_PATTERN = /^[!-~]{1,128}$/
export const FEISHU_ID_VALUE_PATTERN = /^[!-~]{1,128}$/
export const FEISHU_DEFAULT_PAGE_SIZE = 50
export const FEISHU_MAX_PAGE_SIZE = 50
export const FEISHU_ROOT_DEPARTMENT_ID = '0'

export type FeishuConfigIssue =
  | 'config_not_object'
  | 'app_id_invalid'
  | 'app_secret_missing'
  | 'brand_invalid'
  | 'base_url_forbidden'
  | 'root_department_invalid'
  | 'page_size_invalid'

export interface FeishuConnectionSettings {
  readonly appId: string
  readonly brand: FeishuBrand
  readonly rootDepartmentId: typeof FEISHU_ROOT_DEPARTMENT_ID
  readonly pageSize: number
  /** The secret as stored (still encrypted when it carries the stored-secret prefix). */
  readonly storedAppSecret: string
}

export type FeishuConfigParse =
  | { ok: true; settings: FeishuConnectionSettings }
  | { ok: false; issues: FeishuConfigIssue[] }

const BASE_URL_KEY_RE =
  /^(?:base_?url|api_?base|api_?url|host|hostname|endpoint|open_?api_?(?:url|host|base)|accounts_?(?:url|host|base))$/i

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** Parses the configuration of a Feishu connection. Unknown keys are ignored, except base-URL keys, which are refused. */
export function parseFeishuConfig(config: unknown): FeishuConfigParse {
  const record = asRecord(config)
  if (record === null) return { ok: false, issues: ['config_not_object'] }
  const issues: FeishuConfigIssue[] = []

  const appId = typeof record.appId === 'string' ? record.appId.trim() : ''
  if (!FEISHU_APP_ID_PATTERN.test(appId)) issues.push('app_id_invalid')

  const storedAppSecret = typeof record.appSecret === 'string' ? record.appSecret.trim() : ''
  if (storedAppSecret.length === 0) issues.push('app_secret_missing')

  let brand: FeishuBrand = 'feishu'
  if (record.brand !== undefined) {
    if (isFeishuBrand(record.brand)) brand = record.brand
    else issues.push('brand_invalid')
  }

  if (Object.keys(record).some((key) => BASE_URL_KEY_RE.test(key))) issues.push('base_url_forbidden')

  if (record.rootDepartmentId !== undefined && record.rootDepartmentId !== FEISHU_ROOT_DEPARTMENT_ID) {
    issues.push('root_department_invalid')
  }

  let pageSize = FEISHU_DEFAULT_PAGE_SIZE
  if (record.pageSize !== undefined) {
    const value = record.pageSize
    if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= FEISHU_MAX_PAGE_SIZE) pageSize = value
    else issues.push('page_size_invalid')
  }

  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    settings: Object.freeze({
      appId,
      brand,
      rootDepartmentId: FEISHU_ROOT_DEPARTMENT_ID,
      pageSize,
      storedAppSecret,
    }),
  }
}

/**
 * The plain application secret of parsed settings, decoded with the caller's decoder; null when the
 * decoder throws or yields an empty value. The secret is not logged or kept here.
 */
export function resolveFeishuAppSecret(
  settings: Pick<FeishuConnectionSettings, 'storedAppSecret'>,
  decode: (stored: string) => string,
): string | null {
  try {
    const plain = decode(settings.storedAppSecret)
    return typeof plain === 'string' && plain.length > 0 ? plain : null
  } catch {
    return null
  }
}

/**
 * The scope anchor of a Feishu integration row: tenant = `corp_id`, application = `config.appId`
 * (trimmed). Null when either value does not satisfy its shape.
 */
export function feishuScopeOf(row: { corp_id: string; config: unknown }): IntegrationScope | null {
  const record = asRecord(row.config)
  if (record === null || typeof record.appId !== 'string') return null
  const appId = record.appId.trim()
  if (!FEISHU_APP_ID_PATTERN.test(appId)) return null
  return scopeFromValues(row.corp_id, appId)
}

/** The only legal representation of a Feishu identifier: never a bare string. */
export interface FeishuIdRef {
  readonly connectionId: string
  readonly idType: FeishuIdType
  readonly value: string
}

export function feishuIdRef(input: { connectionId?: unknown; idType?: unknown; value?: unknown }): FeishuIdRef {
  const { connectionId, idType, value } = input
  if (typeof connectionId !== 'string' || !FEISHU_ID_VALUE_PATTERN.test(connectionId)) throw new FeishuIdRefError()
  if (typeof idType !== 'string' || !(FEISHU_ID_TYPES as readonly string[]).includes(idType)) throw new FeishuIdRefError()
  if (typeof value !== 'string' || !FEISHU_ID_VALUE_PATTERN.test(value)) throw new FeishuIdRefError()
  return Object.freeze({ connectionId, idType: idType as FeishuIdType, value })
}

/** Refuses an identifier that was issued by another connection than the one whose credentials are in use. */
export function assertFeishuIdForConnection(ref: FeishuIdRef, connectionId: string): void {
  if (ref.connectionId !== connectionId) throw new FeishuIdConnectionMismatchError()
}
