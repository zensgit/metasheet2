/**
 * CFG-1 (card-config settings lock, §3.1): runtime resolvers for the one-tap approval-card
 * configuration — the deep-link HMAC signing secret and the public app URL the links point at.
 *
 * Resolution order (mirrors readDingTalkMessageConfigFromRuntime): env FIRST, stored
 * directory_integrations.config fallback second. The stored secret is written through
 * security/encrypted-secrets (same path as appSecret / workNotificationAgentId) and is only
 * ever decrypted here, server-side.
 *
 * Invariants:
 * - SAME-SOURCE: the card sender (sign) and the card-delivery wrapper (verify) must both call
 *   these resolvers so a token signed on send always verifies on decision — guaranteed by
 *   "env first, else the one stored dingtalk integration".
 * - FAIL-CLOSED: any miss (no env, no row, decrypt failure, query failure) resolves to '' —
 *   the card action refuses to send and the wrapper refuses to verify. Never a fallback secret.
 */
import { randomBytes } from 'crypto'

import { query } from '../../db/pg'
import { decryptStoredSecretValue, normalizeStoredSecretValue } from '../../security/encrypted-secrets'

const DEFAULT_PROVIDER = 'dingtalk'
export const APPROVAL_CARD_LINK_SECRET_CONFIG_KEY = 'approvalCardLinkSecret'
export const APPROVAL_CARD_PUBLIC_APP_URL_CONFIG_KEY = 'approvalCardPublicAppUrl'

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>

type JsonRecord = Record<string, unknown>

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseJsonRecord(value: unknown): JsonRecord {
  if (!value) return {}
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? parsed as JsonRecord : {}
    } catch {
      return {}
    }
  }
  return typeof value === 'object' ? value as JsonRecord : {}
}

/** Same integration pick as loadStoredWorkNotificationConfig: active first, then most recent. */
async function loadStoredApprovalCardConfig(queryFn: QueryFn): Promise<JsonRecord> {
  const result = await queryFn(
    `SELECT config
       FROM directory_integrations
      WHERE provider = $1
      ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 1`,
    [DEFAULT_PROVIDER],
  )
  const row = (result.rows[0] ?? null) as { config?: unknown } | null
  return parseJsonRecord(row?.config)
}

/**
 * Deep-link HMAC signing secret: env `APPROVAL_CARD_LINK_SECRET` first, else the stored
 * (encrypted-at-rest) `approvalCardLinkSecret`, else '' (fail-closed).
 */
export async function resolveApprovalCardLinkSecret(queryFn: QueryFn = query): Promise<string> {
  const fromEnv = (process.env.APPROVAL_CARD_LINK_SECRET ?? '').trim()
  if (fromEnv) return fromEnv
  try {
    const config = await loadStoredApprovalCardConfig(queryFn)
    const stored = normalizeText(config[APPROVAL_CARD_LINK_SECRET_CONFIG_KEY])
    if (!stored) return ''
    return decryptStoredSecretValue(stored).trim()
  } catch {
    // Fail-closed: an unreadable/undecryptable stored secret must never sign or verify.
    return ''
  }
}

/**
 * DT-R2 per-corp variant: the deep-link HMAC secret of ONE SPECIFIC integration — env
 * `APPROVAL_CARD_LINK_SECRET` still wins (global override, unchanged), else THAT integration's
 * stored (encrypted-at-rest) `approvalCardLinkSecret`, else '' (fail-closed).
 *
 * Deliberately NO fallback to the legacy "one stored dingtalk integration" pick: a token pinned
 * to corp A must never sign or verify with corp B's secret. Callers with no integration id
 * (legacy NULL delivery rows) use `resolveApprovalCardLinkSecret` instead — same source the
 * legacy rows were signed with, preserving the sign/verify same-source invariant per population.
 */
export async function resolveApprovalCardLinkSecretForIntegration(
  integrationId: string,
  queryFn: QueryFn = query,
): Promise<string> {
  const fromEnv = (process.env.APPROVAL_CARD_LINK_SECRET ?? '').trim()
  if (fromEnv) return fromEnv
  try {
    const row = await loadIntegrationById(queryFn, integrationId)
    if (!row) return ''
    const config = parseJsonRecord(row.config)
    const stored = normalizeText(config[APPROVAL_CARD_LINK_SECRET_CONFIG_KEY])
    if (!stored) return ''
    return decryptStoredSecretValue(stored).trim()
  } catch {
    // Fail-closed: an unreadable/undecryptable stored secret must never sign or verify.
    return ''
  }
}

/**
 * Public base URL for the decision deep link: env (`PUBLIC_APP_URL` / `APP_BASE_URL`) first,
 * else the stored `approvalCardPublicAppUrl` (plaintext — not a secret), else null.
 * Normalized to a trailing slash exactly like resolveAutomationAppBaseUrl.
 */
export async function resolveApprovalCardPublicAppUrl(queryFn: QueryFn = query): Promise<string | null> {
  const fromEnv = process.env.PUBLIC_APP_URL?.trim() || process.env.APP_BASE_URL?.trim() || ''
  if (fromEnv) return fromEnv.endsWith('/') ? fromEnv : `${fromEnv}/`
  try {
    const config = await loadStoredApprovalCardConfig(queryFn)
    const stored = normalizeText(config[APPROVAL_CARD_PUBLIC_APP_URL_CONFIG_KEY])
    if (!stored) return null
    return stored.endsWith('/') ? stored : `${stored}/`
  } catch {
    return null
  }
}

/* ================================================================
 * CFG-2 (card-config lock §3.2): admin self-service write surface.
 * The secret is generated SERVER-SIDE, stored encrypted, and NEVER
 * returned by any function below — responses carry booleans only.
 * ================================================================ */

type ConfigSource = 'env' | 'stored' | 'missing'

export type ApprovalCardConfigStatus = {
  integration: { id: string; name: string; status: string }
  linkSecret: {
    configured: boolean
    source: ConfigSource
    /** env wins at runtime — the UI must warn that a stored value is inert while env is set. */
    envOverrideActive: boolean
    valuePrinted: false
  }
  publicAppUrl: {
    /** The stored URL (plain, not a secret) — null when unset. */
    storedValue: string | null
    source: ConfigSource
    envOverrideActive: boolean
  }
}

type IntegrationConfigRow = {
  id: string
  name: string
  status: string
  config: unknown
}

async function loadIntegrationById(queryFn: QueryFn, integrationId: string): Promise<IntegrationConfigRow | null> {
  const normalizedId = normalizeText(integrationId)
  if (!normalizedId) return null
  const result = await queryFn(
    `SELECT id, name, status, config
       FROM directory_integrations
      WHERE id = $1 AND provider = $2
      LIMIT 1`,
    [normalizedId, DEFAULT_PROVIDER],
  )
  return (result.rows[0] ?? null) as IntegrationConfigRow | null
}

function buildStatus(row: IntegrationConfigRow): ApprovalCardConfigStatus {
  const config = parseJsonRecord(row.config)
  const envSecret = (process.env.APPROVAL_CARD_LINK_SECRET ?? '').trim()
  const storedSecret = normalizeText(config[APPROVAL_CARD_LINK_SECRET_CONFIG_KEY])
  const envUrl = process.env.PUBLIC_APP_URL?.trim() || process.env.APP_BASE_URL?.trim() || ''
  const storedUrl = normalizeText(config[APPROVAL_CARD_PUBLIC_APP_URL_CONFIG_KEY])
  return {
    integration: { id: row.id, name: row.name, status: row.status },
    linkSecret: {
      configured: Boolean(envSecret || storedSecret),
      source: envSecret ? 'env' : storedSecret ? 'stored' : 'missing',
      envOverrideActive: Boolean(envSecret),
      valuePrinted: false,
    },
    publicAppUrl: {
      storedValue: storedUrl || null,
      source: envUrl ? 'env' : storedUrl ? 'stored' : 'missing',
      envOverrideActive: Boolean(envUrl),
    },
  }
}

export async function getApprovalCardConfigStatus(
  integrationId: string,
  queryFn: QueryFn = query,
): Promise<ApprovalCardConfigStatus | null> {
  const row = await loadIntegrationById(queryFn, integrationId)
  if (!row) return null
  return buildStatus(row)
}

/**
 * Generate a fresh 32-byte link secret server-side and store it ENCRYPTED
 * (normalizeStoredSecretValue — same path as appSecret). The plaintext never
 * leaves this function; callers get presence booleans only.
 * Rotation semantics: overwriting an existing secret invalidates in-flight
 * card links (they fail verify) — the UI confirms before regenerate.
 */
export async function generateApprovalCardLinkSecret(
  integrationId: string,
  queryFn: QueryFn = query,
): Promise<ApprovalCardConfigStatus | null> {
  const row = await loadIntegrationById(queryFn, integrationId)
  if (!row) return null
  const secret = randomBytes(32).toString('hex')
  const encrypted = normalizeStoredSecretValue(secret)
  const updated = await queryFn(
    `UPDATE directory_integrations
        SET config = jsonb_set(COALESCE(config, '{}'::jsonb), $2, to_jsonb($3::text), true),
            updated_at = NOW()
      WHERE id = $1 AND provider = $4
      RETURNING id, name, status, config`,
    [row.id, `{${APPROVAL_CARD_LINK_SECRET_CONFIG_KEY}}`, encrypted, DEFAULT_PROVIDER],
  )
  const updatedRow = (updated.rows[0] ?? null) as IntegrationConfigRow | null
  if (!updatedRow) return null
  return buildStatus(updatedRow)
}

/**
 * Save (or clear, with '') the stored public app URL for the decision deep link.
 * Only http(s) absolute URLs are accepted — the stored value redirects where
 * approval deep links point, so scheme laundering is rejected at the write.
 */
export async function saveApprovalCardPublicAppUrl(
  integrationId: string,
  publicAppUrl: string,
  queryFn: QueryFn = query,
): Promise<ApprovalCardConfigStatus | null> {
  const trimmed = typeof publicAppUrl === 'string' ? publicAppUrl.trim() : ''
  if (trimmed) {
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      throw new Error('publicAppUrl must be an absolute http(s) URL')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('publicAppUrl must use http or https')
    }
  }
  const row = await loadIntegrationById(queryFn, integrationId)
  if (!row) return null
  const updated = trimmed
    ? await queryFn(
      `UPDATE directory_integrations
          SET config = jsonb_set(COALESCE(config, '{}'::jsonb), $2, to_jsonb($3::text), true),
              updated_at = NOW()
        WHERE id = $1 AND provider = $4
        RETURNING id, name, status, config`,
      [row.id, `{${APPROVAL_CARD_PUBLIC_APP_URL_CONFIG_KEY}}`, trimmed, DEFAULT_PROVIDER],
    )
    : await queryFn(
      `UPDATE directory_integrations
          SET config = COALESCE(config, '{}'::jsonb) - $2::text,
              updated_at = NOW()
        WHERE id = $1 AND provider = $3
        RETURNING id, name, status, config`,
      [row.id, APPROVAL_CARD_PUBLIC_APP_URL_CONFIG_KEY, DEFAULT_PROVIDER],
    )
  const updatedRow = (updated.rows[0] ?? null) as IntegrationConfigRow | null
  if (!updatedRow) return null
  return buildStatus(updatedRow)
}
