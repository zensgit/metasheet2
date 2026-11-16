/**
 * Explicit verification of ONE Feishu connection, level by level. Each level is independent and none
 * implies another:
 *
 *   config  reads the stored configuration of the connection; no network. Proves that the configuration
 *           is complete and well formed.
 *   token   mints a tenant access token NOW, bypassing the token cache (not read, not written, not
 *           evicted, no mint in progress joined), then reads the enterprise information with it and
 *           compares the tenant key with the connection's. Proves that Feishu issued a token for the
 *           configured application; proves the tenant only when `tenantAsserted` is true.
 *
 * `directory_read` and `send` are named in the level set but are not available in this build; a request
 * that names one is refused before anything is read.
 *
 * Every report is values-free: booleans, lengths, numeric codes and fixed sentences. No credential, token,
 * identifier, host or provider text appears in it, and a failure carries the fixed sentence plus
 * Feishu's numeric code. Only a `token` run makes a request to Feishu, and only when an administrator
 * asked for it.
 */
import { feishuScopeOf, parseFeishuConfig, resolveFeishuAppSecret, type FeishuConfigIssue } from './config'
import { FEISHU_ENDPOINTS, feishuEndpointUrl, type FeishuBrand } from './endpoints'
import {
  FeishuBusinessError,
  FeishuIncompleteResponseError,
  FeishuMalformedResponseError,
  FeishuRequestError,
  FeishuTimeoutError,
  describeFeishuFailure,
  feishuFailureCode,
} from './errors'
import type { FeishuFreshToken, FeishuTenantTokenCredentials } from './token'
import { requestFeishuJson } from './transport'

export const FEISHU_VERIFY_LEVELS = ['config', 'token', 'directory_read', 'send'] as const
export type FeishuVerifyLevel = (typeof FEISHU_VERIFY_LEVELS)[number]

/** The levels this build can run. */
export const FEISHU_VERIFY_AVAILABLE_LEVELS: readonly FeishuVerifyLevel[] = Object.freeze(['config', 'token'] as const)

export interface FeishuVerifyIntegrationRow {
  id: string
  provider: string
  corp_id: string
  config: unknown
}

export interface FeishuVerifyDeps {
  readIntegration(integrationId: string): Promise<FeishuVerifyIntegrationRow | null>
  decodeSecret(stored: string): string
  tokens: { mintFresh(credentials: FeishuTenantTokenCredentials): Promise<FeishuFreshToken> }
  fetchFn?: typeof fetch
}

export type FeishuVerifyConfigIssue = FeishuConfigIssue | 'tenant_key_invalid' | 'app_secret_unreadable'

export const FEISHU_VERIFY_SCOPE = Object.freeze({
  config: Object.freeze({
    proves: 'The configuration of the connection is complete and well formed.',
    doesNotProve:
      'That Feishu accepts the credentials; any interface permission of the application; the contact scope; message sending.',
  }),
  token: Object.freeze({
    proves:
      'Feishu issued a tenant access token, minted now with the token cache bypassed, for the configured application.',
    doesNotProve:
      'The tenant of the application (unless tenantAsserted is true); any interface permission of the application; the contact scope; message sending; delivery to any person.',
  }),
  tokenTenant: Object.freeze({
    proves:
      'Feishu issued a tenant access token, minted now with the token cache bypassed, for the configured application, and the enterprise information read with it names the configured tenant.',
    doesNotProve:
      'Any interface permission beyond reading the enterprise information; the contact scope; message sending; delivery to any person.',
  }),
})

export interface FeishuVerifyScopeText {
  proves: string
  doesNotProve: string
}

export interface FeishuVerifyConfigReport {
  passed: boolean
  issues: FeishuVerifyConfigIssue[]
  appId: { configured: boolean; length: number | null; valuePrinted: false }
  appSecret: { configured: boolean; readable: boolean | null; valuePrinted: false }
  brand: FeishuBrand | null
  scope: FeishuVerifyScopeText
}

export type FeishuVerifyTokenFailureCode =
  | 'config_unusable'
  | 'token_rejected'
  | 'token_error_status'
  | 'token_incomplete_response'
  | 'token_malformed_response'
  | 'token_timeout'
  | 'token_network_error'
  | 'tenant_mismatch'

export type FeishuVerifyTenantFailure = 'tenant_scope_unavailable' | 'tenant_mismatch' | 'tenant_response_invalid'

export interface FeishuVerifyTokenReport {
  /** False when the configuration could not be resolved and no request was made. */
  attempted: boolean
  passed: boolean
  /** True once a token was requested (it bypassed the cache); null when none was requested. */
  cacheBypassed: true | null
  accessToken: { verified: boolean; valuePrinted: false }
  /** True: the tenant key read with the token equals the connection's. False: it was read and differs, or could not be read. Null: not attempted. */
  tenantAsserted: boolean | null
  tenantFailure: FeishuVerifyTenantFailure | null
  tenantProviderCode?: number
  failure: null | {
    code: FeishuVerifyTokenFailureCode
    message: string
    providerCode?: number
    providerCodeKind?: 'code' | 'http_status'
  }
  scope: FeishuVerifyScopeText
}

export interface FeishuVerifyReport {
  integrationId: string
  levels: { config?: FeishuVerifyConfigReport; token?: FeishuVerifyTokenReport }
}

export type FeishuVerifyOutcome =
  | { kind: 'not_found' }
  | { kind: 'provider_mismatch' }
  | { kind: 'ok'; report: FeishuVerifyReport }

export interface FeishuVerifyInput {
  integrationId: string
  /** Distinct, from the available levels. */
  levels: readonly FeishuVerifyLevel[]
}

const TOKEN_FALLBACK = 'Access token was not obtained'
const TENANT_MISMATCH_SENTENCE = 'The Feishu tenant does not match the configured tenant'
const CONFIG_UNUSABLE_SENTENCE = 'The connection configuration is not usable; no request was made to Feishu'

interface ResolvedConnection {
  credentials: FeishuTenantTokenCredentials
  corpId: string
  brand: FeishuBrand
}

type Resolution =
  | { ok: true; connection: ResolvedConnection }
  | { ok: false; issues: FeishuVerifyConfigIssue[]; appIdLength: number | null; brand: FeishuBrand | null; secretReadable: boolean | null; appIdConfigured: boolean; secretConfigured: boolean }

function resolveConnection(row: FeishuVerifyIntegrationRow, decodeSecret: (stored: string) => string): Resolution {
  const parsed = parseFeishuConfig(row.config)
  const record = row.config !== null && typeof row.config === 'object' && !Array.isArray(row.config) ? (row.config as Record<string, unknown>) : {}
  const appIdText = typeof record.appId === 'string' ? record.appId.trim() : ''
  const secretText = typeof record.appSecret === 'string' ? record.appSecret.trim() : ''
  const base = {
    appIdLength: appIdText.length > 0 ? appIdText.length : null,
    appIdConfigured: appIdText.length > 0,
    secretConfigured: secretText.length > 0,
  }
  const issues: FeishuVerifyConfigIssue[] = parsed.ok === false ? [...parsed.issues] : []
  if (feishuScopeOf({ corp_id: row.corp_id, config: row.config }) === null && parsed.ok) issues.push('tenant_key_invalid')
  if (parsed.ok === false) {
    return { ok: false, issues, brand: null, secretReadable: null, ...base }
  }
  const secret = resolveFeishuAppSecret(parsed.settings, decodeSecret)
  if (secret === null) issues.push('app_secret_unreadable')
  if (issues.length > 0) {
    return { ok: false, issues, brand: parsed.settings.brand, secretReadable: secret !== null, ...base }
  }
  return {
    ok: true,
    connection: {
      credentials: { connectionId: row.id, appId: parsed.settings.appId, appSecret: secret as string, brand: parsed.settings.brand },
      corpId: row.corp_id,
      brand: parsed.settings.brand,
    },
  }
}

function configReport(resolution: Resolution): FeishuVerifyConfigReport {
  if (resolution.ok === true) {
    return {
      passed: true,
      issues: [],
      appId: { configured: true, length: resolution.connection.credentials.appId.length, valuePrinted: false },
      appSecret: { configured: true, readable: true, valuePrinted: false },
      brand: resolution.connection.brand,
      scope: FEISHU_VERIFY_SCOPE.config,
    }
  }
  return {
    passed: false,
    issues: resolution.issues,
    appId: { configured: resolution.appIdConfigured, length: resolution.appIdLength, valuePrinted: false },
    appSecret: { configured: resolution.secretConfigured, readable: resolution.secretReadable, valuePrinted: false },
    brand: resolution.brand,
    scope: FEISHU_VERIFY_SCOPE.config,
  }
}

function tokenFailureCode(error: unknown): FeishuVerifyTokenFailureCode {
  if (error instanceof FeishuBusinessError) return 'token_rejected'
  if (error instanceof FeishuRequestError) return 'token_error_status'
  if (error instanceof FeishuIncompleteResponseError) return 'token_incomplete_response'
  if (error instanceof FeishuMalformedResponseError) return 'token_malformed_response'
  if (error instanceof FeishuTimeoutError) return 'token_timeout'
  return 'token_network_error'
}

function readTenantKey(payload: Record<string, unknown>): string | null {
  const data = payload.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const tenant = (data as Record<string, unknown>).tenant
  if (tenant === null || typeof tenant !== 'object' || Array.isArray(tenant)) return null
  const key = (tenant as Record<string, unknown>).tenant_key
  return typeof key === 'string' && key.length > 0 ? key : null
}

async function tokenReport(resolution: Resolution, deps: FeishuVerifyDeps): Promise<FeishuVerifyTokenReport> {
  if (resolution.ok === false) {
    return {
      attempted: false,
      passed: false,
      cacheBypassed: null,
      accessToken: { verified: false, valuePrinted: false },
      tenantAsserted: null,
      tenantFailure: null,
      failure: { code: 'config_unusable', message: CONFIG_UNUSABLE_SENTENCE },
      scope: FEISHU_VERIFY_SCOPE.config,
    }
  }
  const { credentials, corpId, brand } = resolution.connection

  let minted: FeishuFreshToken
  try {
    minted = await deps.tokens.mintFresh(credentials)
  } catch (error) {
    const provider = feishuFailureCode(error)
    return {
      attempted: true,
      passed: false,
      cacheBypassed: true,
      accessToken: { verified: false, valuePrinted: false },
      tenantAsserted: null,
      tenantFailure: null,
      failure: {
        code: tokenFailureCode(error),
        message: describeFeishuFailure(error, TOKEN_FALLBACK),
        ...(provider ? { providerCode: provider.code, providerCodeKind: provider.kind } : {}),
      },
      scope: FEISHU_VERIFY_SCOPE.token,
    }
  }

  let tenantAsserted = false
  let tenantFailure: FeishuVerifyTenantFailure | null = null
  let tenantProviderCode: number | undefined
  try {
    const payload = await requestFeishuJson({
      url: feishuEndpointUrl(brand, FEISHU_ENDPOINTS.tenantQuery),
      init: { method: 'GET', headers: { Authorization: `Bearer ${minted.accessToken}` } },
      kind: 'read',
      envelope: 'open_api',
      fetchFn: deps.fetchFn,
    })
    const tenantKey = readTenantKey(payload)
    if (tenantKey === null) tenantFailure = 'tenant_response_invalid'
    else if (tenantKey !== corpId) tenantFailure = 'tenant_mismatch'
    else tenantAsserted = true
  } catch (error) {
    tenantFailure = 'tenant_scope_unavailable'
    tenantProviderCode = feishuFailureCode(error)?.code
  }

  const mismatch = tenantFailure === 'tenant_mismatch'
  return {
    attempted: true,
    passed: !mismatch,
    cacheBypassed: true,
    accessToken: { verified: true, valuePrinted: false },
    tenantAsserted,
    tenantFailure,
    ...(tenantProviderCode !== undefined ? { tenantProviderCode } : {}),
    failure: mismatch ? { code: 'tenant_mismatch', message: TENANT_MISMATCH_SENTENCE } : null,
    scope: tenantAsserted ? FEISHU_VERIFY_SCOPE.tokenTenant : FEISHU_VERIFY_SCOPE.token,
  }
}

/** Runs the requested levels against one integration. Nothing is read before the input is validated by the caller. */
export async function verifyFeishuConnection(deps: FeishuVerifyDeps, input: FeishuVerifyInput): Promise<FeishuVerifyOutcome> {
  const row = await deps.readIntegration(input.integrationId)
  if (row === null) return { kind: 'not_found' }
  if (row.provider !== 'feishu') return { kind: 'provider_mismatch' }

  const resolution = resolveConnection(row, deps.decodeSecret)
  const levels: FeishuVerifyReport['levels'] = {}
  if (input.levels.includes('config')) levels.config = configReport(resolution)
  if (input.levels.includes('token')) levels.token = await tokenReport(resolution, deps)
  return { kind: 'ok', report: { integrationId: row.id, levels } }
}

export type FeishuVerifyRequestIssue =
  | 'body_not_object'
  | 'unknown_key'
  | 'integration_id_invalid'
  | 'levels_invalid'
  | 'level_unavailable'
  | 'recipient_not_allowed'

/** One fixed sentence per refusal; none carries any part of the request. */
export const FEISHU_VERIFY_REQUEST_SENTENCES: Readonly<Record<FeishuVerifyRequestIssue, string>> = Object.freeze({
  body_not_object: 'The request body must be a JSON object',
  unknown_key: 'The request body names a field that is not accepted',
  integration_id_invalid: 'integrationId must be a UUID',
  levels_invalid: 'levels must be a non-empty list of distinct verification levels',
  level_unavailable: 'A requested verification level is not available',
  recipient_not_allowed: 'recipient is only accepted together with the send level',
})

export type FeishuVerifyParse =
  | { ok: true; input: FeishuVerifyInput }
  | { ok: false; issue: FeishuVerifyRequestIssue }

const UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ALLOWED_KEYS: readonly string[] = ['integrationId', 'levels', 'recipient']

/** Closed whitelist: the three keys above and nothing else; levels are matched exactly (no trimming, no case folding). */
export function parseFeishuVerifyBody(body: unknown): FeishuVerifyParse {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, issue: 'body_not_object' }
  const record = body as Record<string, unknown>
  if (Object.keys(record).some((key) => !ALLOWED_KEYS.includes(key))) return { ok: false, issue: 'unknown_key' }
  if (typeof record.integrationId !== 'string' || !UUID_SHAPE_RE.test(record.integrationId)) {
    return { ok: false, issue: 'integration_id_invalid' }
  }
  const raw = record.levels
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, issue: 'levels_invalid' }
  const known: readonly string[] = FEISHU_VERIFY_LEVELS
  if (raw.some((level) => typeof level !== 'string' || !known.includes(level))) return { ok: false, issue: 'levels_invalid' }
  if (new Set(raw).size !== raw.length) return { ok: false, issue: 'levels_invalid' }
  const requested = raw as FeishuVerifyLevel[]
  if (requested.some((level) => !FEISHU_VERIFY_AVAILABLE_LEVELS.includes(level))) return { ok: false, issue: 'level_unavailable' }
  if (record.recipient !== undefined) return { ok: false, issue: 'recipient_not_allowed' }
  return { ok: true, input: { integrationId: record.integrationId, levels: FEISHU_VERIFY_LEVELS.filter((level) => requested.includes(level)) } }
}
