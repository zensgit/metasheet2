/**
 * Feishu endpoints: the one module in which a Feishu host name is written.
 *
 * The brand set is closed (`feishu`) and there is no base-URL configuration of any kind: a host is
 * chosen by brand and role from the frozen table below, and every request target is checked against
 * the same table once more before a request is made (isFeishuUrlAllowed). Paths are constants here.
 *
 * The table cannot be replaced by production code. Tests substitute loopback origins through
 * `__feishuEndpointsForTests` (the only seam, loopback origins only) and restore them afterwards; a
 * source guard keeps every other module from naming that seam.
 *
 * Pure module: no imports, no I/O, no environment reads.
 */
export const FEISHU_BRANDS = Object.freeze(['feishu'] as const)
export type FeishuBrand = (typeof FEISHU_BRANDS)[number]

/** `openApi`: the resource API host; `accounts`: the authorization and token host. */
export type FeishuHostRole = 'openApi' | 'accounts'
export type FeishuOrigins = Readonly<Record<FeishuHostRole, string>>

const PRODUCTION_ORIGINS: Readonly<Record<FeishuBrand, FeishuOrigins>> = Object.freeze({
  feishu: Object.freeze({
    openApi: 'https://open.feishu.cn',
    accounts: 'https://accounts.feishu.cn',
  }),
})

export interface FeishuEndpoint {
  readonly role: FeishuHostRole
  readonly path: string
}

export const FEISHU_ENDPOINTS = Object.freeze({
  /** Tenant access token for a self-built application (client credentials). */
  tenantAccessToken: Object.freeze({ role: 'accounts', path: '/oauth/v3/token' } as FeishuEndpoint),
  /** Enterprise information; carries the tenant key. */
  tenantQuery: Object.freeze({ role: 'openApi', path: '/open-apis/tenant/v2/tenant/query' } as FeishuEndpoint),
  /** Sends a message to one recipient; the recipient id type is a query value. */
  sendMessage: Object.freeze({ role: 'openApi', path: '/open-apis/im/v1/messages' } as FeishuEndpoint),
})

export function isFeishuBrand(value: unknown): value is FeishuBrand {
  return typeof value === 'string' && (FEISHU_BRANDS as readonly string[]).includes(value)
}

let testOrigins: Readonly<Record<FeishuBrand, FeishuOrigins>> | null = null

function activeOrigins(brand: FeishuBrand): FeishuOrigins {
  return (testOrigins ?? PRODUCTION_ORIGINS)[brand]
}

/** The absolute URL of an endpoint for a brand. `query` values are appended in key order. */
export function feishuEndpointUrl(
  brand: FeishuBrand,
  endpoint: FeishuEndpoint,
  query?: Readonly<Record<string, string>>,
): string {
  const origins = activeOrigins(brand)
  const url = new URL(endpoint.path, `${origins[endpoint.role]}/`)
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value)
  return url.toString()
}

/**
 * True when `target` is an absolute URL whose origin is exactly one of the active origins of a known
 * brand and which carries no user information. A host that merely ends with, or contains, an allowed
 * host name does not match; neither does another scheme or port.
 */
export function isFeishuUrlAllowed(target: string): boolean {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return false
  }
  if (url.username !== '' || url.password !== '') return false
  for (const brand of FEISHU_BRANDS) {
    const origins = activeOrigins(brand)
    if (url.origin === origins.openApi || url.origin === origins.accounts) return true
  }
  return false
}

const LOOPBACK_ORIGIN_RE = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}$/

export const __feishuEndpointsForTests = Object.freeze({
  /** Points every brand at the given loopback origins. Anything that is not a loopback origin is refused. */
  replace(origins: FeishuOrigins): void {
    for (const role of ['openApi', 'accounts'] as const) {
      if (!LOOPBACK_ORIGIN_RE.test(origins[role])) throw new Error('feishu endpoints: only loopback origins may replace the table')
    }
    testOrigins = Object.freeze({ feishu: Object.freeze({ openApi: origins.openApi, accounts: origins.accounts }) })
  },
  restore(): void {
    testOrigins = null
  },
  isReplaced(): boolean {
    return testOrigins !== null
  },
})
