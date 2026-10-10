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
 *   - No server-side ERROR for an absent store: ONE catalog precheck per table (to_regclass +
 *     pg_attribute, ENCRYPTED_STORE_COLUMNS_SQL) decides table_missing / column_missing before the
 *     entry's SELECT is issued; the SQLSTATE classification remains only as the fallback for a race.
 *   - Bounded: each read is LIMIT rowLimit + 1 (default 10,000) and reports `truncated` beyond that.
 *   - `plaintext` is narrow on purpose: non-encrypted values in the catalogued field each reader uses,
 *     not every plaintext secret in the database (see EncryptedStoreProbeResult.plaintext).
 *   - Classified the way each store's runtime READER sees the value: the `enc:` / `v1:` prefix is tested
 *     on the raw string, or on the trimmed one where that reader trims first (entry.prefixOn); NULL and
 *     whitespace-only values are not stored secrets and count nowhere (rows = encrypted + plaintext +
 *     legacyNotChecked). The catalog and each entry are frozen.
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
  /**
   * Which string the `enc:` / `v1:` prefix test sees — the same one this store's runtime reader
   * tests: 'raw' (the stored string as is, so ` enc:…` is plaintext to the reader and here) or
   * 'trimmed' (the reader trims first, so ` enc:…` is decrypted by the reader and here).
   */
  readonly prefixOn: 'raw' | 'trimmed'
  /**
   * Every top-level column `sql` references. The existence precheck (ENCRYPTED_STORE_COLUMNS_SQL) must
   * find all of them before `sql` is issued; otherwise the entry is table_missing / column_missing
   * without a statement that would ERROR on the server.
   */
  readonly columns: readonly string[]
  /** ONE static SELECT returning a single column `value`, bounded by `LIMIT $1`. */
  readonly sql: string
}

/**
 * Existence precheck, ONE per distinct catalog table: the table's live top-level columns.
 * to_regclass() returns NULL for a missing relation instead of raising, and resolves the unqualified
 * name through search_path exactly like the catalog SELECTs do — so a table or column that does not
 * exist in this deployment costs no server-side ERROR, no db_query_errors_total increment and no
 * slow-query line on every startup / admin read (integration/db/connection-pool.ts query()).
 */
export const ENCRYPTED_STORE_COLUMNS_SQL =
  'SELECT attname FROM pg_attribute WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped'

const LEGACY_INTEGRATION_PREFIX = 'v1:'
/** iv (16) + authTag (16): the smallest payload SecretManager.encrypt() can produce (empty plaintext). */
const MIN_SEALED_PAYLOAD_BYTES = 32
const DEFAULT_ROW_LIMIT = 10_000

/**
 * Freeze ONE entry: the array is frozen too, so nothing at runtime can retarget the probe's SQL or
 * its classification (an assignment throws in strict mode).
 */
function catalogEntry(entry: EncryptedStoreCatalogEntry): EncryptedStoreCatalogEntry {
  return Object.freeze({ ...entry, columns: Object.freeze([...entry.columns]) })
}

/**
 * Every encrypted store. One entry per secret field; the WHERE clauses mirror the runtime readers
 * (data_sources: the rows loadFromDatabase loads; `COALESCE` mirrors the readers' `??` fallbacks),
 * and so does `prefixOn` (see EncryptedStoreCatalogEntry).
 */
export const ENCRYPTED_STORE_CATALOG: readonly EncryptedStoreCatalogEntry[] = Object.freeze([
  // Reader: DataSourceManager.decryptCredentials — isEncryptedSecretValue(v) on the raw value.
  catalogEntry({
    store: 'data_sources',
    field: 'config.credentials.password',
    scheme: 'platform-enc',
    prefixOn: 'raw',
    columns: ['config', 'is_active', 'deleted_at'],
    sql: `SELECT config->'credentials'->>'password' AS value FROM data_sources WHERE is_active = true AND deleted_at IS NULL AND config->'credentials'->>'password' <> '' LIMIT $1`,
  }),
  catalogEntry({
    store: 'data_sources',
    field: 'config.credentials.apiKey',
    scheme: 'platform-enc',
    prefixOn: 'raw',
    columns: ['config', 'is_active', 'deleted_at'],
    sql: `SELECT config->'credentials'->>'apiKey' AS value FROM data_sources WHERE is_active = true AND deleted_at IS NULL AND config->'credentials'->>'apiKey' <> '' LIMIT $1`,
  }),
  catalogEntry({
    store: 'data_sources',
    field: 'config.credentials.token',
    scheme: 'platform-enc',
    prefixOn: 'raw',
    columns: ['config', 'is_active', 'deleted_at'],
    sql: `SELECT config->'credentials'->>'token' AS value FROM data_sources WHERE is_active = true AND deleted_at IS NULL AND config->'credentials'->>'token' <> '' LIMIT $1`,
  }),
  // Readers: directory-sync parseIntegrationConfig, work-notification-settings decryptStoredText,
  // approval-card-config resolvers, elearning-notification-dingtalk readSecret — every one trims
  // (normalizeText) BEFORE decryptStoredSecretValue, so the prefix is tested on the trimmed value.
  catalogEntry({
    store: 'directory_integrations',
    field: 'config.appSecret',
    scheme: 'platform-enc',
    prefixOn: 'trimmed',
    columns: ['config'],
    sql: `SELECT config->>'appSecret' AS value FROM directory_integrations WHERE config->>'appSecret' <> '' LIMIT $1`,
  }),
  catalogEntry({
    store: 'directory_integrations',
    field: 'config.workNotificationAgentId|agentId',
    scheme: 'platform-enc',
    prefixOn: 'trimmed',
    columns: ['config'],
    sql: `SELECT COALESCE(config->>'workNotificationAgentId', config->>'agentId') AS value FROM directory_integrations WHERE COALESCE(config->>'workNotificationAgentId', config->>'agentId') <> '' LIMIT $1`,
  }),
  catalogEntry({
    store: 'directory_integrations',
    field: 'config.approvalCardLinkSecret',
    scheme: 'platform-enc',
    prefixOn: 'trimmed',
    columns: ['config'],
    sql: `SELECT config->>'approvalCardLinkSecret' AS value FROM directory_integrations WHERE config->>'approvalCardLinkSecret' <> '' LIMIT $1`,
  }),
  // Reader: dingtalk-group-destinations decryptDingTalkDestinationWebhookUrl / …Secret — raw value.
  catalogEntry({
    store: 'dingtalk_group_destinations',
    field: 'webhook_url',
    scheme: 'platform-enc',
    prefixOn: 'raw',
    columns: ['webhook_url'],
    sql: `SELECT webhook_url AS value FROM dingtalk_group_destinations WHERE webhook_url <> '' LIMIT $1`,
  }),
  catalogEntry({
    store: 'dingtalk_group_destinations',
    field: 'secret',
    scheme: 'platform-enc',
    prefixOn: 'raw',
    columns: ['secret'],
    sql: `SELECT secret AS value FROM dingtalk_group_destinations WHERE secret <> '' LIMIT $1`,
  }),
  // Reader: credential-store.cjs decrypt — isLegacyCiphertext / security.decrypt on the raw value.
  catalogEntry({
    store: 'integration_external_systems',
    field: 'credentials_encrypted',
    scheme: 'integration-credential',
    prefixOn: 'raw',
    columns: ['credentials_encrypted'],
    sql: `SELECT credentials_encrypted AS value FROM integration_external_systems WHERE credentials_encrypted <> '' LIMIT $1`,
  }),
  // Reader: plugin-attendance normalizeIntegrationConfig — trims only to test emptiness, then
  // decryptIntegrationSecretValue(String(appSecret)) tests the prefix on the raw value.
  catalogEntry({
    store: 'attendance_integrations',
    field: 'config.appSecret|appsecret|app_secret',
    scheme: 'platform-enc',
    prefixOn: 'raw',
    columns: ['config'],
    sql: `SELECT COALESCE(config->>'appSecret', config->>'appsecret', config->>'app_secret') AS value FROM attendance_integrations WHERE COALESCE(config->>'appSecret', config->>'appsecret', config->>'app_secret') <> '' LIMIT $1`,
  }),
  // Reader: ConfigService DatabaseConfigSource -> SecretManager.decryptValue — raw `enc:` test.
  catalogEntry({
    store: 'system_configs',
    field: 'value (is_encrypted)',
    scheme: 'system-config',
    prefixOn: 'raw',
    columns: ['value', 'is_encrypted'],
    // `value` is text (z20251231 migration) or jsonb (038 migration); it is classified in JS, so no
    // text function is applied to it here.
    sql: `SELECT value FROM system_configs WHERE is_encrypted = true LIMIT $1`,
  }),
])

export type EncryptedStoreProbeStatus = 'ok' | 'table_missing' | 'column_missing' | 'read_failed'

export interface EncryptedStoreProbeResult {
  store: string
  field: string
  scheme: EncryptedStoreScheme
  status: EncryptedStoreProbeStatus
  /**
   * Values examined: rows = encrypted + plaintext + legacyNotChecked. A NULL or whitespace-only value
   * is not a stored secret and is not counted anywhere (at most rowLimit rows are read).
   */
  rows: number
  /** Values sealed under platform material (decrypted when material is available). */
  encrypted: number
  /** Of `encrypted`: values the current material cannot decrypt. */
  undecryptable: number
  /**
   * Non-empty values that are NOT encrypted — ONLY in this catalogued field, i.e. the value this
   * store's reader actually uses. It does not see plaintext copies the reader ignores (e.g. the
   * attendance plugin keeps extra `appsecret` / `app_secret` keys next to `appSecret`; the COALESCE
   * picks `appSecret` first), nor secrets in rows the probe does not read (system_configs rows with
   * is_encrypted = false, e.g. federation's plm.apiToken / athena.apiToken written through
   * ConfigService.set). Not a census of all plaintext secrets.
   */
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

/**
 * One stored value -> one bucket, the way this store's runtime reader sees it:
 *   - NULL / undefined / whitespace-only: 'empty' — not a stored secret, counted nowhere;
 *   - a non-string (system_configs.value as jsonb): plaintext configuration;
 *   - the `enc:` / `v1:` prefix is tested on entry.prefixOn's string (raw or trimmed, per reader);
 *   - system_configs only: a bare SecretManager payload (strict base64, ≥ iv + authTag, tested on the
 *     trimmed value) is encrypted too — the envelope rotateKey() writes.
 */
function classify(entry: EncryptedStoreCatalogEntry, raw: unknown): Classified {
  if (raw === null || raw === undefined) return { kind: 'empty' }
  // system_configs.value may be jsonb: a non-string JSON value is a plain configuration value.
  if (typeof raw !== 'string') return { kind: 'plaintext' }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { kind: 'empty' }
  const tested = entry.prefixOn === 'trimmed' ? trimmed : raw
  if (tested.startsWith(STORED_SECRET_PREFIX)) {
    return { kind: 'encrypted', payload: tested.slice(STORED_SECRET_PREFIX.length) }
  }
  if (entry.scheme === 'integration-credential' && tested.startsWith(LEGACY_INTEGRATION_PREFIX)) {
    return { kind: 'legacy' }
  }
  if (entry.scheme === 'system-config' && looksLikeBareSealedPayload(trimmed)) {
    return { kind: 'encrypted', payload: trimmed }
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

/**
 * A PostgreSQL SQLSTATE: exactly five characters from [0-9A-Z]. (A five-letter Node errno such as
 * EPIPE has that shape too and is then reported as `sqlState`; it still classifies as read_failed —
 * only 42P01 / 42703 change the status.)
 */
function sqlStateOf(error: unknown): string | undefined {
  try {
    const code = (error as { code?: unknown } | null | undefined)?.code
    return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined
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

type TablePresence =
  | { kind: 'present'; columns: ReadonlySet<string> }
  | { kind: 'absent' }
  /** The precheck itself failed (e.g. the database is unreachable): the table's entries are read_failed. */
  | { kind: 'unreadable'; sqlState?: string }

/** ENCRYPTED_STORE_COLUMNS_SQL for one table. Zero rows = no such relation on the search_path. */
async function readTablePresence(query: EncryptedStoreProbeQuery, table: string): Promise<TablePresence> {
  try {
    const response = await query(ENCRYPTED_STORE_COLUMNS_SQL, [table])
    if (!response || !Array.isArray(response.rows)) throw new TypeError('query returned no rows array')
    if (response.rows.length === 0) return { kind: 'absent' }
    const columns = new Set<string>()
    for (const row of response.rows) {
      const name = row !== null && typeof row === 'object' ? (row as { attname?: unknown }).attname : undefined
      if (typeof name === 'string') columns.add(name)
    }
    return { kind: 'present', columns }
  } catch (error) {
    const sqlState = sqlStateOf(error)
    return sqlState ? { kind: 'unreadable', sqlState } : { kind: 'unreadable' }
  }
}

async function probeOne(
  entry: EncryptedStoreCatalogEntry,
  query: EncryptedStoreProbeQuery,
  key: Buffer | null,
  rowLimit: number,
  presence: TablePresence,
): Promise<EncryptedStoreProbeResult> {
  const result = emptyResult(entry)
  // Decided by the precheck — the entry's SELECT is NOT issued, so nothing errors on the server.
  if (presence.kind === 'absent') {
    result.status = 'table_missing'
    return result
  }
  if (presence.kind === 'unreadable') {
    result.status = 'read_failed'
    if (presence.sqlState) result.sqlState = presence.sqlState
    return result
  }
  if (entry.columns.some((column) => !presence.columns.has(column))) {
    result.status = 'column_missing'
    return result
  }
  try {
    const response = await query(entry.sql, [rowLimit + 1])
    if (!response || !Array.isArray(response.rows)) throw new TypeError('query returned no rows array')
    const rows = response.rows
    if (rows.length > rowLimit) result.truncated = true
    const examined = rows.length > rowLimit ? rows.slice(0, rowLimit) : rows
    for (const row of examined) {
      const raw = row !== null && typeof row === 'object' ? (row as { value?: unknown }).value : undefined
      const classified = classify(entry, raw)
      if (classified.kind === 'empty') continue
      result.rows += 1
      if (classified.kind === 'plaintext') result.plaintext += 1
      else if (classified.kind === 'legacy') result.legacyNotChecked = (result.legacyNotChecked ?? 0) + 1
      else {
        result.encrypted += 1
        if (key && !decryptsUnder(classified.payload, key)) result.undecryptable += 1
      }
    }
  } catch (error) {
    // Fallback for a race (the table / column went away between the precheck and this SELECT): the
    // SQLSTATE, never the message text, still classifies it.
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

  const presence = new Map<string, TablePresence>()
  for (const entry of ENCRYPTED_STORE_CATALOG) {
    if (!presence.has(entry.store)) presence.set(entry.store, await readTablePresence(deps.query, entry.store))
  }

  const stores: EncryptedStoreProbeResult[] = []
  for (const entry of ENCRYPTED_STORE_CATALOG) {
    stores.push(await probeOne(entry, deps.query, key, rowLimit, presence.get(entry.store) as TablePresence))
  }

  return {
    checkedAt,
    material,
    decryptChecked: key !== null,
    stores,
    totals: totalsOf(stores),
  }
}

// ── on demand (admin read) ───────────────────────────────────────────────────────────────────────

let sharedRun: Promise<EncryptedStoreProbeReport> | null = null

/**
 * Single-flight for on-demand callers (GET /api/admin/security/encrypted-stores): while one probe run
 * is in flight every caller gets THAT run's promise, so concurrent admin reads cost one run, not one
 * each. Nothing is cached: once the run settles the next call starts a fresh one. `makeDeps` is only
 * called when a new run starts; if it throws, nothing is shared and the throw reaches the caller.
 */
export function probeEncryptedStoresShared(makeDeps: () => EncryptedStoreProbeDeps): Promise<EncryptedStoreProbeReport> {
  if (sharedRun) return sharedRun
  const run: Promise<EncryptedStoreProbeReport> = probeEncryptedStores(makeDeps()).finally(() => {
    if (sharedRun === run) sharedRun = null
  })
  sharedRun = run
  return run
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
  // ONE warn for every store field that could not be read (not a missing table / column): its values
  // were not checked at all. Names and SQLSTATE codes only — never the error text.
  const unreadable = report.stores.filter((s) => s.status === 'read_failed')
  if (unreadable.length > 0) {
    logger.warn(
      `Encrypted store probe: ${unreadable.length} store field(s) could not be read, so their values were not checked: ` +
        `${unreadable.map(label).join(', ')}.`,
      {
        unreadable: unreadable.length,
        stores: unreadable.map((s) => ({ store: s.store, field: s.field, sqlState: s.sqlState ?? null })),
      },
    )
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
 * Fire-and-forget startup hook for src/index.ts: run the probe once, log one info summary, one warn
 * per store field with undecryptable values, and one warn listing the store fields that could not be
 * read. Never blocks startup (the caller does not await it), never rejects, and returns null without
 * logging when there is no database pool.
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
