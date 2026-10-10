/**
 * #6164 step 1 — READ-ONLY probe: can the CURRENT encryption material still open every encrypted store?
 *
 * Why it exists. When a deployment's ENCRYPTION_KEY / ENCRYPTION_SALT change, every value sealed under
 * the previous material becomes undecryptable, and except for the data-source manager every store only
 * decrypts when it is used — so the failures surface one at a time, on unrelated pages, long after the
 * change. This probe trial-decrypts every encrypted store once and reports COUNTS, so the damage is
 * visible at startup (one log summary) and on demand (GET /api/admin/security/encrypted-stores).
 *
 * What it guarantees:
 *   - SELECT only. Every statement is a static string in ENCRYPTED_STORE_CATALOG below, issued through
 *     the injected query function; nothing is inserted, updated, deleted, locked or repaired.
 *   - Values-free. The report and every log line carry store/field NAMES and COUNTS only — never a
 *     plaintext, a ciphertext, a key, a key fingerprint or a row id. A trial decrypt's result is
 *     dropped on the spot (decryptsUnder() returns a boolean).
 *   - The pbkdf2 key derivation (100,000 iterations) runs ONCE per probe, asynchronously, and is shared
 *     by every store: all three envelopes below are sealed under the same derived key.
 *   - It never throws. A store that cannot be read is reported (table_missing / column_missing by
 *     SQLSTATE 42P01 / 42703 — never by message text, the server may run a non-English locale — or
 *     read_failed), and the other stores are still probed. Production with unusable material
 *     (EncryptionMaterialError) reports `material.status = 'unavailable'` and attempts no decrypt.
 *   - Bounded: each read is LIMIT rowLimit + 1 (default 10,000) and reports `truncated` beyond that.
 *
 * Envelopes (verified against the writers, not assumed):
 *   - 'platform-enc': `enc:` + base64(iv 16 | authTag 16 | AES-256-GCM ciphertext), key =
 *     pbkdf2(ENCRYPTION_KEY, ENCRYPTION_SALT, 100000, 32, sha256) — security/encrypted-secrets.ts, and
 *     the byte-identical re-implementation in plugins/plugin-attendance/index.cjs
 *     (encryptIntegrationSecretValue). Anything without the prefix is read as plaintext by every reader.
 *   - 'system-config': services/ConfigService.ts SecretManager. SAME key derivation and payload layout,
 *     but a different envelope: the reader (DatabaseConfigSource) decrypts only `enc:`-prefixed values
 *     of `is_encrypted` rows, while SecretManager.encrypt() / rotateKey() write the payload WITHOUT the
 *     prefix. Both shapes are counted as encrypted here; any other value of an `is_encrypted` row
 *     (JSON, short text) is counted as plaintext.
 *   - 'integration-credential': plugins/plugin-integration-core/lib/credential-store.cjs.
 *     `enc:` = platform material through the host security service (decrypted here); `v1:` = the
 *     plugin's own INTEGRATION_ENCRYPTION_KEY (counted as legacyNotChecked, never decrypted in core).
 *
 * Completeness: tests/unit/encrypted-store-census.guard.test.ts scans the source tree for every
 * encrypting writer and pins each call site to an entry of ENCRYPTED_STORE_CATALOG (or a reasoned
 * exemption), so a new encrypted store without a catalog entry turns that suite red.
 */
import { Logger } from '../core/logger'

import {
  decryptSecretPayloadWithKey,
  deriveEncryptionKeyFromMaterial,
  EncryptionMaterialError,
  getEncryptionMaterialIssues,
  resolveEncryptionMaterial,
  STORED_SECRET_PREFIX,
} from './encrypted-secrets'

type EnvShape = Record<string, string | undefined>

export type EncryptedStoreScheme = 'platform-enc' | 'system-config' | 'integration-credential'

export interface EncryptedStoreCatalogEntry {
  /** The table. */
  readonly store: string
  /** Which secret of it (a values-free label). */
  readonly field: string
  readonly scheme: EncryptedStoreScheme
  /** ONE static SELECT returning a single column `value`, bounded by `LIMIT $1`. */
  readonly sql: string
}

const LEGACY_INTEGRATION_PREFIX = 'v1:'
/** iv (16) + authTag (16): the smallest payload SecretManager.encrypt() can produce (empty plaintext). */
const MIN_SEALED_PAYLOAD_BYTES = 32
const DEFAULT_ROW_LIMIT = 10_000

/**
 * Every encrypted store. One entry per secret field; the WHERE clauses mirror the runtime readers
 * (data_sources: the rows loadFromDatabase loads; `COALESCE` mirrors the readers' `??` fallbacks).
 */
export const ENCRYPTED_STORE_CATALOG: readonly EncryptedStoreCatalogEntry[] = Object.freeze([
  {
    store: 'data_sources',
    field: 'config.credentials.password',
    scheme: 'platform-enc',
    sql: `SELECT config->'credentials'->>'password' AS value FROM data_sources WHERE is_active = true AND deleted_at IS NULL AND config->'credentials'->>'password' <> '' LIMIT $1`,
  },
  {
    store: 'data_sources',
    field: 'config.credentials.apiKey',
    scheme: 'platform-enc',
    sql: `SELECT config->'credentials'->>'apiKey' AS value FROM data_sources WHERE is_active = true AND deleted_at IS NULL AND config->'credentials'->>'apiKey' <> '' LIMIT $1`,
  },
  {
    store: 'data_sources',
    field: 'config.credentials.token',
    scheme: 'platform-enc',
    sql: `SELECT config->'credentials'->>'token' AS value FROM data_sources WHERE is_active = true AND deleted_at IS NULL AND config->'credentials'->>'token' <> '' LIMIT $1`,
  },
  {
    store: 'directory_integrations',
    field: 'config.appSecret',
    scheme: 'platform-enc',
    sql: `SELECT config->>'appSecret' AS value FROM directory_integrations WHERE config->>'appSecret' <> '' LIMIT $1`,
  },
  {
    store: 'directory_integrations',
    field: 'config.workNotificationAgentId|agentId',
    scheme: 'platform-enc',
    sql: `SELECT COALESCE(config->>'workNotificationAgentId', config->>'agentId') AS value FROM directory_integrations WHERE COALESCE(config->>'workNotificationAgentId', config->>'agentId') <> '' LIMIT $1`,
  },
  {
    store: 'directory_integrations',
    field: 'config.approvalCardLinkSecret',
    scheme: 'platform-enc',
    sql: `SELECT config->>'approvalCardLinkSecret' AS value FROM directory_integrations WHERE config->>'approvalCardLinkSecret' <> '' LIMIT $1`,
  },
  {
    store: 'dingtalk_group_destinations',
    field: 'webhook_url',
    scheme: 'platform-enc',
    sql: `SELECT webhook_url AS value FROM dingtalk_group_destinations WHERE webhook_url <> '' LIMIT $1`,
  },
  {
    store: 'dingtalk_group_destinations',
    field: 'secret',
    scheme: 'platform-enc',
    sql: `SELECT secret AS value FROM dingtalk_group_destinations WHERE secret <> '' LIMIT $1`,
  },
  {
    store: 'integration_external_systems',
    field: 'credentials_encrypted',
    scheme: 'integration-credential',
    sql: `SELECT credentials_encrypted AS value FROM integration_external_systems WHERE credentials_encrypted <> '' LIMIT $1`,
  },
  {
    store: 'attendance_integrations',
    field: 'config.appSecret|appsecret|app_secret',
    scheme: 'platform-enc',
    sql: `SELECT COALESCE(config->>'appSecret', config->>'appsecret', config->>'app_secret') AS value FROM attendance_integrations WHERE COALESCE(config->>'appSecret', config->>'appsecret', config->>'app_secret') <> '' LIMIT $1`,
  },
  {
    store: 'system_configs',
    field: 'value (is_encrypted)',
    scheme: 'system-config',
    // `value` is text (z20251231 migration) or jsonb (038 migration); it is classified in JS, so no
    // text function is applied to it here.
    sql: `SELECT value FROM system_configs WHERE is_encrypted = true LIMIT $1`,
  },
] satisfies EncryptedStoreCatalogEntry[])

export type EncryptedStoreProbeStatus = 'ok' | 'table_missing' | 'column_missing' | 'read_failed'

export interface EncryptedStoreProbeResult {
  store: string
  field: string
  scheme: EncryptedStoreScheme
  status: EncryptedStoreProbeStatus
  /** Rows read that hold a non-empty value in this field (at most rowLimit). */
  rows: number
  /** Values sealed under platform material (decrypted when material is available). */
  encrypted: number
  /** Of `encrypted`: values the current material cannot decrypt. */
  undecryptable: number
  /** Non-empty values in this secret field that are NOT encrypted. */
  plaintext: number
  /** integration-credential only: `v1:` values under the plugin's own key — counted, not decrypted. */
  legacyNotChecked?: number
  /** More than rowLimit rows matched; the counts cover the first rowLimit. */
  truncated?: true
  /** The PostgreSQL SQLSTATE of a failed read, when the error carried one. */
  sqlState?: string
}

export interface EncryptedStoreProbeReport {
  checkedAt: string
  material: { status: 'ok' | 'unavailable'; issues: string[] }
  /** false when the material is unavailable: `encrypted` values were counted but not trial-decrypted. */
  decryptChecked: boolean
  stores: EncryptedStoreProbeResult[]
  totals: {
    encrypted: number
    undecryptable: number
    plaintext: number
    legacyNotChecked: number
    /** Store fields whose read failed for a reason other than a missing table / column. */
    unreadable: number
    /** Store fields whose table or column does not exist in this database. */
    missing: number
  }
}

/** The shape the codebase's pg pool / ConnectionPool exposes. */
export type EncryptedStoreProbeQuery = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>

export interface EncryptedStoreProbeDeps {
  query: EncryptedStoreProbeQuery
  env?: EnvShape
  /** Rows examined per store field (1..10,000; default 10,000). */
  rowLimit?: number
  now?: () => Date
}

type Classified =
  | { kind: 'empty' }
  | { kind: 'plaintext' }
  | { kind: 'legacy' }
  | { kind: 'encrypted'; payload: string }

/** Strict standard base64 whose decoded length can hold an iv + authTag — SecretManager's bare payload. */
function looksLikeBareSealedPayload(value: string): boolean {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false
  // A digits-only string is valid base64 AND valid JSON (a number); the reader treats it as plaintext.
  if (/^\d+$/.test(value)) return false
  return Buffer.from(value, 'base64').length >= MIN_SEALED_PAYLOAD_BYTES
}

function classify(scheme: EncryptedStoreScheme, raw: unknown): Classified {
  if (raw === null || raw === undefined) return { kind: 'empty' }
  // system_configs.value may be jsonb: a non-string JSON value is a plain configuration value.
  if (typeof raw !== 'string') return { kind: 'plaintext' }
  const value = raw.trim()
  if (value.length === 0) return { kind: 'empty' }
  if (value.startsWith(STORED_SECRET_PREFIX)) {
    return { kind: 'encrypted', payload: value.slice(STORED_SECRET_PREFIX.length) }
  }
  if (scheme === 'integration-credential' && value.startsWith(LEGACY_INTEGRATION_PREFIX)) {
    return { kind: 'legacy' }
  }
  if (scheme === 'system-config' && looksLikeBareSealedPayload(value)) {
    return { kind: 'encrypted', payload: value }
  }
  return { kind: 'plaintext' }
}

/** Trial decrypt. The plaintext is never bound to a name: only "did it open" leaves this function. */
function decryptsUnder(payload: string, key: Buffer): boolean {
  try {
    decryptSecretPayloadWithKey(payload, key)
    return true
  } catch {
    return false
  }
}

/** A PostgreSQL SQLSTATE: five [0-9A-Z] characters with at least one digit (so `EPIPE` is not one). */
function sqlStateOf(error: unknown): string | undefined {
  try {
    const code = (error as { code?: unknown } | null | undefined)?.code
    return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && /\d/.test(code) ? code : undefined
  } catch {
    return undefined
  }
}

function boundedRowLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_ROW_LIMIT
  return Math.min(DEFAULT_ROW_LIMIT, Math.max(1, Math.floor(value)))
}

function emptyResult(entry: EncryptedStoreCatalogEntry): EncryptedStoreProbeResult {
  const result: EncryptedStoreProbeResult = {
    store: entry.store,
    field: entry.field,
    scheme: entry.scheme,
    status: 'ok',
    rows: 0,
    encrypted: 0,
    undecryptable: 0,
    plaintext: 0,
  }
  if (entry.scheme === 'integration-credential') result.legacyNotChecked = 0
  return result
}

async function probeOne(
  entry: EncryptedStoreCatalogEntry,
  query: EncryptedStoreProbeQuery,
  key: Buffer | null,
  rowLimit: number,
): Promise<EncryptedStoreProbeResult> {
  const result = emptyResult(entry)
  try {
    const response = await query(entry.sql, [rowLimit + 1])
    if (!response || !Array.isArray(response.rows)) throw new TypeError('query returned no rows array')
    const rows = response.rows
    if (rows.length > rowLimit) result.truncated = true
    const examined = rows.length > rowLimit ? rows.slice(0, rowLimit) : rows
    result.rows = examined.length
    for (const row of examined) {
      const raw = row !== null && typeof row === 'object' ? (row as { value?: unknown }).value : undefined
      const classified = classify(entry.scheme, raw)
      if (classified.kind === 'plaintext') result.plaintext += 1
      else if (classified.kind === 'legacy') result.legacyNotChecked = (result.legacyNotChecked ?? 0) + 1
      else if (classified.kind === 'encrypted') {
        result.encrypted += 1
        if (key && !decryptsUnder(classified.payload, key)) result.undecryptable += 1
      }
    }
  } catch (error) {
    const sqlState = sqlStateOf(error)
    const reset = emptyResult(entry)
    reset.status = sqlState === '42P01' ? 'table_missing' : sqlState === '42703' ? 'column_missing' : 'read_failed'
    if (sqlState) reset.sqlState = sqlState
    return reset
  }
  return result
}

function totalsOf(stores: EncryptedStoreProbeResult[]): EncryptedStoreProbeReport['totals'] {
  const totals = { encrypted: 0, undecryptable: 0, plaintext: 0, legacyNotChecked: 0, unreadable: 0, missing: 0 }
  for (const store of stores) {
    totals.encrypted += store.encrypted
    totals.undecryptable += store.undecryptable
    totals.plaintext += store.plaintext
    totals.legacyNotChecked += store.legacyNotChecked ?? 0
    if (store.status === 'read_failed') totals.unreadable += 1
    if (store.status === 'table_missing' || store.status === 'column_missing') totals.missing += 1
  }
  return totals
}

/**
 * Trial-decrypt every store in ENCRYPTED_STORE_CATALOG with the current material. Read-only,
 * values-free, never throws (see the module header).
 */
export async function probeEncryptedStores(deps: EncryptedStoreProbeDeps): Promise<EncryptedStoreProbeReport> {
  let checkedAt: string
  try {
    checkedAt = (deps.now ? deps.now() : new Date()).toISOString()
  } catch {
    checkedAt = new Date().toISOString()
  }
  const env = deps.env ?? process.env
  const rowLimit = boundedRowLimit(deps.rowLimit)

  let material: EncryptedStoreProbeReport['material']
  let key: Buffer | null = null
  try {
    material = { status: 'ok', issues: getEncryptionMaterialIssues(env) }
    // Applies the production gate; non-production defaults stay usable (and are listed in `issues`).
    key = await deriveEncryptionKeyFromMaterial(resolveEncryptionMaterial(env))
  } catch (error) {
    key = null
    material = {
      status: 'unavailable',
      issues: error instanceof EncryptionMaterialError ? [...error.issues] : ['encryption key derivation failed'],
    }
  }

  const stores: EncryptedStoreProbeResult[] = []
  for (const entry of ENCRYPTED_STORE_CATALOG) {
    stores.push(await probeOne(entry, deps.query, key, rowLimit))
  }

  return {
    checkedAt,
    material,
    decryptChecked: key !== null,
    stores,
    totals: totalsOf(stores),
  }
}

// ── startup ──────────────────────────────────────────────────────────────────────────────────────

export const ENCRYPTED_STORE_REENTER_HINT =
  'Values sealed under previous encryption material (ENCRYPTION_KEY / ENCRYPTION_SALT) cannot be ' +
  'decrypted with the current material and must be re-entered (or the previous material restored). ' +
  'The probe is read-only and changed nothing.'

export interface EncryptedStoreProbeLogger {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
}

export interface EncryptedStoreProbeStartupDeps {
  /**
   * Resolves the database pool. Called inside the wrapper's own try, so a resolver that throws cannot
   * escape; null / undefined / no `query` method = no database → the probe is skipped quietly.
   */
  resolvePool: () => { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> } | null | undefined
  env?: EnvShape
  logger?: EncryptedStoreProbeLogger
  rowLimit?: number
}

function logReport(logger: EncryptedStoreProbeLogger, report: EncryptedStoreProbeReport): void {
  const { totals } = report
  const label = (store: EncryptedStoreProbeResult) => `${store.store}.${store.field}`
  logger.info(
    `Encrypted store probe: ${totals.encrypted} encrypted value(s) across ${report.stores.length} store field(s); ` +
      `${report.decryptChecked ? `${totals.undecryptable} undecryptable with the current material` : 'not trial-decrypted (encryption material unavailable)'}, ` +
      `${totals.plaintext} plaintext, ${totals.legacyNotChecked} legacy v1 not checked; ` +
      `${totals.unreadable} store field(s) unreadable, ${totals.missing} not present.`,
    {
      material: report.material.status,
      decryptChecked: report.decryptChecked,
      ...totals,
      unreadableStores: report.stores.filter((s) => s.status === 'read_failed').map(label),
      truncatedStores: report.stores.filter((s) => s.truncated).map(label),
    },
  )
  if (report.material.status === 'unavailable') {
    logger.warn('Encrypted store probe: encryption material is unavailable; no stored value was trial-decrypted.', {
      issues: report.material.issues,
    })
  }
  for (const store of report.stores) {
    if (store.undecryptable <= 0) continue
    logger.warn(
      `Encrypted store probe: ${label(store)} has ${store.undecryptable} of ${store.encrypted} encrypted value(s) ` +
        `the current material cannot decrypt. ${ENCRYPTED_STORE_REENTER_HINT}`,
      { store: store.store, field: store.field, encrypted: store.encrypted, undecryptable: store.undecryptable },
    )
  }
}

/**
 * Fire-and-forget startup hook for src/index.ts: run the probe once, log one info summary plus one
 * warn per store field with undecryptable values. Never blocks startup (the caller does not await it),
 * never rejects, and returns null without logging when there is no database pool.
 */
export async function runEncryptedStoreProbeAtStartup(
  deps: EncryptedStoreProbeStartupDeps,
): Promise<EncryptedStoreProbeReport | null> {
  let logger: EncryptedStoreProbeLogger | undefined
  try {
    logger = deps.logger ?? new Logger('EncryptedStoreProbe')
    const pool = deps.resolvePool()
    if (!pool || typeof pool.query !== 'function') return null
    const report = await probeEncryptedStores({
      query: (sql, params) => pool.query(sql, params),
      env: deps.env,
      rowLimit: deps.rowLimit,
    })
    logReport(logger, report)
    return report
  } catch {
    try {
      logger?.warn('Encrypted store probe could not run; startup continues without it.')
    } catch {
      // The startup hook must never throw, not even through a failing logger.
    }
    return null
  }
}
