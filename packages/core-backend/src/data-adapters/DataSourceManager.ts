import { EventEmitter } from 'eventemitter3'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { BaseDataAdapter, DataSourceConfig, QueryOptions, QueryResult, DbValue, WhereClause, ConnectionConfig, Credentials, AdapterOptions } from './BaseAdapter'
import { PostgresAdapter } from './PostgresAdapter'
import { HTTPAdapter } from './HTTPAdapter'
import { MSSQLAdapter } from './MSSQLAdapter'
import { MySQLAdapter } from './MySQLAdapter'
import { PLMAdapter } from './PLMAdapter'
import { encryptStoredSecretValue, decryptStoredSecretValue, isEncryptedSecretValue } from '../security/encrypted-secrets'
import { assertNotK3Destination, preserveK3Marker } from './k3-destination-write-fence'
import { assertSqlWriteAllowed, assertSqlSourceProvisionableAtRuntime, pinSqlSourceConnection } from './sql-write-arm-binding'
import type { IConfigService, ILogger } from '../di/identifiers'

// PostgreSQL SQLSTATE for undefined_table. The referential delete guard trusts
// ONLY this code for its "integration schema not installed → zero references"
// short-circuit — never the message-prose fallback of isDatabaseSchemaError,
// which would let any error worded like a missing table silently PERMIT a
// delete (P2-B).
const UNDEFINED_TABLE_SQLSTATE = '42P01'

// Credential fields that hold secrets and are encrypted at rest. Identifiers
// like `username` are left as-is (matching the codebase's encrypt-secrets-only
// convention).
const SENSITIVE_CREDENTIAL_KEYS = ['password', 'apiKey', 'token']
export const DATA_SOURCE_C6_WRITE_TARGET_QUERY_DISABLED_CODE = 'DATA_SOURCE_C6_WRITE_TARGET_QUERY_DISABLED'
export const DATA_SOURCE_C6_WRITE_TARGET_DELETE_UNSUPPORTED_CODE = 'DATA_SOURCE_C6_WRITE_TARGET_DELETE_UNSUPPORTED'
// Referential delete guard (see countExternalSystemReferences): a source referenced by an
// integration external system's canonical connection_id or attributable legacy
// config.dataSourceId refuses a plain delete with this code.
export const DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS_CODE = 'DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS'
// The foreign key that re-points integration_external_systems.connection_id at data_sources(live_id)
// (migration zzzz20260920120000). A soft delete of a source that still has a canonical binding is
// refused by PostgreSQL on THIS constraint (SQLSTATE 23503) — the database backstop behind the
// owner's ruling (2026-09-20, ①) that a referenced source cannot be deleted and force is retired.
export const DATA_SOURCE_LIVE_CONNECTION_FK = 'fk_integration_external_systems_live_connection_id'
// The constraint the same column carried BEFORE that migration (connection_id -> data_sources(id),
// ON DELETE RESTRICT). A hard delete against a not-yet-migrated schema fails on it with the same
// meaning, so both names are read as "still referenced".
const DATA_SOURCE_LEGACY_CONNECTION_FK = 'fk_integration_external_systems_connection_id'

/**
 * Is this driver error the binding foreign key refusing a data-source delete?
 * SQLSTATE first (23503 = foreign_key_violation; stable across server locales), constraint
 * name second (pg reports it as `constraint`; a driver that omits it is accepted, because no
 * other RESTRICT/NO ACTION foreign key targets data_sources — the two other referencing
 * tables, data_source_connections and data_source_query_logs, are ON DELETE CASCADE).
 * Never reads the message text: on a zh_CN PostgreSQL the English prose is not there.
 */
export function isLiveConnectionFkViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const { code, constraint } = error as { code?: unknown; constraint?: unknown }
  if (code !== '23503') return false
  if (typeof constraint !== 'string' || constraint.length === 0) return true
  return constraint === DATA_SOURCE_LIVE_CONNECTION_FK || constraint === DATA_SOURCE_LEGACY_CONNECTION_FK
}
// Durable-first delete (PERM-04): the soft/hard delete row write failed, so the delete did NOT
// happen — neither in memory nor on disk. Values-free by construction: the driver's text (host,
// port, database, login) stays in the log; the client gets this code and a fixed sentence.
export const DATA_SOURCE_DELETE_NOT_PERSISTED_CODE = 'DATA_SOURCE_DELETE_NOT_PERSISTED'

/**
 * Actor context for data-source access decisions (the authority model).
 *
 * Two call shapes, two tiers of meaning:
 * - a plain user-id string (or undefined) is the DATA-PLANE shape: strictly
 *   owner-scoped, no admin bypass. This is what adapter/facade/workbench call
 *   sites pass — reading customer data THROUGH a connection stays owner-only.
 * - a {@link DataSourceActorContext} object is the MANAGEMENT shape resolved
 *   from the request: `platformAdmin: true` (the rbac global-admin tier that
 *   already bypasses every `data_sources:*` rbacGuard) grants management
 *   access to every source. It never grants credential readback — credentials
 *   are write-only for every tier at the response-sanitization layer.
 *
 * Because the scoping semantics live HERE (not in individual routes), every
 * assertAccess call site inherits the model — including ones added on other
 * branches that pass a bare user id.
 */
export interface DataSourceActorContext {
  userId?: string
  platformAdmin?: boolean
}
export type DataSourceActor = string | DataSourceActorContext | undefined

function normalizeActor(actor: DataSourceActor): DataSourceActorContext {
  if (actor === undefined) return {}
  if (typeof actor === 'string') return { userId: actor }
  return actor
}

type AdapterConstructor = new (config: DataSourceConfig) => BaseDataAdapter

const emptyConfigService: IConfigService = {
  get: async () => undefined,
  set: async () => undefined,
  getAll: async () => ({}),
  reload: async () => undefined,
  validate: async () => ({ valid: true, errors: [] }),
}

const consoleLogger: ILogger = {
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
  debug: (...args: unknown[]) => console.debug(...args),
}

// ── On-demand connect refusal (#2, values-free) ───────────────────────────────────────────
// Every adapter's connect() catch rethrows the RAW driver text — MSSQLAdapter `Failed to connect to
// SQL Server: ${error}`, PostgresAdapter / MySQLAdapter / MongoDBAdapter likewise — and that text
// embeds host:port, database name and the login it tried. connectDataSource is the ONE chokepoint
// every on-demand connect passes through (/schema, /tables/:table, /query, /select,
// insert/update/delete, copyData, federated query, the plugin facade), so translating here covers
// all of them at once. The client gets a fixed sentence + a coded 503; the cause stays in the server
// log. The single place an operator still learns WHY is `POST /:id/test` (testConnection), which
// calls adapter.connect() directly — deliberately NOT routed through here — and returns the
// redactSecrets'd `adapter.connectionError`.
export const DATA_SOURCE_UNAVAILABLE_CODE = 'SOURCE_UNAVAILABLE'
export const DATA_SOURCE_UNAVAILABLE_MESSAGE =
  '数据源当前无法连接，请先「测试连接」查看原因 / Data source is currently unreachable; run "Test connection" for details'

// The cause as it may be LOGGED: never the raw message when a redacted one exists.
// `connectionError` is only populated by BaseAdapter.onError, and every adapter has a connect()
// branch that throws BEFORE reaching it — the driver-package-missing guard (MSSQLAdapter.ts:217,
// PostgresAdapter.ts:74, MySQLAdapter.ts:195, HTTPAdapter.ts:134). On that branch `connectionError`
// is null, so logging shape-only would leave the failure explainable NOWHERE: the client gets a
// fixed sentence and the 「测试连接」 the sentence points at reads the same null `connectionError`.
// Fall back to the cause's own message, put through the adapter's OWN redactSecrets (via the public
// `redactCause`), so an adapter that embeds a secret in a pre-onError throw still cannot log it.
function loggableCause(
  adapter: Pick<BaseDataAdapter, 'connectionError' | 'redactCause'>,
  cause: unknown
): string | null {
  const recorded = adapter.connectionError
  if (recorded) return recorded
  const raw = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : null
  if (!raw) return null
  try {
    return adapter.redactCause(raw)
  } catch {
    // A logging helper must never break the refusal itself: a broken redactor costs the log line,
    // not the 503. Returning null also guarantees an unredacted message can never be logged.
    return null
  }
}

function sourceUnavailableError(
  id: string,
  cause: unknown,
  adapter: Pick<BaseDataAdapter, 'connectionError' | 'redactCause'>
): Error {
  // A deliberate coded refusal (arm-binding / provisioning / K3 fence) already carries its own
  // status+code and is values-free by construction — never downgrade it to a generic 503.
  if (cause instanceof Error) {
    const status = (cause as { status?: unknown }).status
    const code = (cause as { code?: unknown }).code
    if (typeof status === 'number' && status >= 400 && status < 600 && typeof code === 'string') {
      return cause
    }
  }
  // Log the cause: name + driver code + a REDACTED message (onError's `connectionError` when it
  // exists, else the cause's message through the same redaction — see loggableCause above).
  // Never the raw message.
  consoleLogger.error(`[DataSourceManager] Connect failed for ${id}`, {
    name: cause instanceof Error ? cause.name : typeof cause,
    driverCode: (cause as { code?: unknown } | null | undefined)?.code,
    redactedCause: loggableCause(adapter, cause),
  })
  return Object.assign(new Error(DATA_SOURCE_UNAVAILABLE_MESSAGE), {
    status: 503,
    code: DATA_SOURCE_UNAVAILABLE_CODE,
  })
}

class ManagedPLMAdapter extends PLMAdapter {
  constructor(config: DataSourceConfig) {
    super(emptyConfigService, consoleLogger, config)
  }
}

// ── The ONE built-in adapter registry ────────────────────────────────────────────────────────
// Both the public supported-type list AND the runtime registration are DERIVED from this object,
// so a type cannot be registered without appearing in SUPPORTED_DATA_SOURCE_TYPES, nor listed as
// supported without being registered. These were previously two hand-maintained lists (a literal
// tuple + six `registerAdapterType` calls) that could silently drift: adding a runtime adapter and
// forgetting the constant would leave it publicly unsupported AND invisible to any test that pins
// coverage against the constant. Declared after ManagedPLMAdapter because it references that class.
// A4: public support is intentionally narrowed to the verified runtime set.
// FROZEN at runtime (not just `as const`, which is compile-time only). Another module could
// otherwise assign/delete/replace an entry at runtime and re-open the very drift this single source
// closes: registration iterates this object and SUPPORTED_DATA_SOURCE_TYPES is derived from its
// keys, so a runtime mutation would desync registered adapters from the public supported set.
export const DEFAULT_ADAPTER_REGISTRY = Object.freeze({
  postgresql: PostgresAdapter,
  postgres: PostgresAdapter, // accepted alias of postgresql — same adapter class
  http: HTTPAdapter,
  sqlserver: MSSQLAdapter,
  mysql: MySQLAdapter,
  plm: ManagedPLMAdapter,
} as const)

export type SupportedDataSourceType = keyof typeof DEFAULT_ADAPTER_REGISTRY

// DERIVED at runtime from the registry above — not a second hand-written list — and itself FROZEN,
// so a caller cannot push/splice a type into the "supported" set without a corresponding adapter.
// The assertion restores the non-empty-tuple shape `z.enum` requires (routes/data-sources.ts); it
// is sound by construction because the registry is a non-empty frozen literal with string keys.
export const SUPPORTED_DATA_SOURCE_TYPES = Object.freeze(Object.keys(DEFAULT_ADAPTER_REGISTRY)) as unknown as
  readonly [SupportedDataSourceType, ...SupportedDataSourceType[]]

function optionIsTrue(options: AdapterOptions | undefined, key: string): boolean {
  return options?.[key] === true
}

export function isC6WriteTargetConfig(config: Pick<DataSourceConfig, 'options'>): boolean {
  return optionIsTrue(config.options, 'c6WriteTarget') && optionIsTrue(config.options, 'genericQueryDisabled')
}

export function isGenericQueryDisabledConfig(config: Pick<DataSourceConfig, 'options'>): boolean {
  return optionIsTrue(config.options, 'c6WriteTarget') || optionIsTrue(config.options, 'genericQueryDisabled')
}

export function c6WriteTargetQueryDisabledMessage(dataSourceId: string): string {
  return `data source '${dataSourceId}' is reserved for C6 write-gated targets; generic raw query is disabled`
}

export function c6WriteTargetDeleteUnsupportedMessage(dataSourceId: string): string {
  return `data source '${dataSourceId}' is reserved for C6 write-gated targets; generic delete is unsupported`
}

export function c6WriteTargetCopyUnsupportedMessage(dataSourceId: string): string {
  return `data source '${dataSourceId}' is reserved for C6 write-gated targets; generic copy is unsupported`
}

// Database record types
export const DATA_SOURCE_SCOPE_KINDS = ['legacy_private', 'private', 'workspace'] as const
export type DataSourceScopeKind = typeof DATA_SOURCE_SCOPE_KINDS[number]

function isDataSourceScopeKind(value: unknown): value is DataSourceScopeKind {
  return typeof value === 'string' && (DATA_SOURCE_SCOPE_KINDS as readonly string[]).includes(value)
}

function normalizeTenantId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

// ── Why an id is NOT in the in-memory registry (server-log diagnostics only) ─────────────────
// `assertAccess` answers "not found" for a source that is missing from the registry and for one
// owned by somebody else, in the same words, so a non-owner cannot learn that a source exists. That
// invariant is kept: nothing below changes a thrown error, a status or a message. What it adds is
// a CLOSED vocabulary the host facade can put in the SERVER log, because the registry is loaded once
// at startup and "why is this id not loaded" was otherwise answerable only by re-deriving the load
// filters by hand against a database that may have changed since
// (docs/development/takeover-beiliao-20260821/stock-prep-connection-canonical-unavailable-diagnosis-20260925.md §5 R1/R7).
//
// Load-time outcomes, one per filter the load actually applies:
//   soft_deleted / inactive   — the load query's `deleted_at IS NULL` / `is_active = true` filters
//   unsupported_type          — the adapter-type check
//   decrypt_failed            — credential decryption (ENCRYPTION_KEY differs from the writer's)
//   load_failed               — any other failure while building the adapter: a row at load, or
//                               the re-add of a runtime update (updateDataSource) that threw
// and the ones that are not a filter:
//   removed                   — loaded, then removed at runtime through this manager
//   absent_at_load            — the load completed and the id was not in the table at all
//   unknown_at_load           — the load completed but the filtered-row snapshot was unavailable,
//                               so "filtered" and "absent" cannot be told apart
//   registry_not_loaded       — the registry load itself never completed (query or init failure)
export const DATA_SOURCE_LOAD_FILTER_OUTCOMES = [
  'soft_deleted',
  'inactive',
  'unsupported_type',
  'decrypt_failed',
  'load_failed',
] as const
export type DataSourceLoadFilterOutcome = typeof DATA_SOURCE_LOAD_FILTER_OUTCOMES[number]
export const DATA_SOURCE_UNLOADED_REASONS = [
  ...DATA_SOURCE_LOAD_FILTER_OUTCOMES,
  'removed',
  'absent_at_load',
  'unknown_at_load',
  'registry_not_loaded',
] as const
export type DataSourceUnloadedReason = typeof DATA_SOURCE_UNLOADED_REASONS[number]

/** Values-free explanation of an `assertAccess` refusal. Never contains an id, owner or tenant. */
export type DataSourceAccessRefusal =
  | { reason: 'not_loaded'; loadOutcome: DataSourceUnloadedReason }
  | { reason: 'owner_mismatch' }

// Credential-decrypt failures, tagged by identity rather than by class or message so the thrown
// error (its name, message and stack line) stays byte-identical to before.
const decryptFailures = new WeakSet<object>()

// The R7 probe runs after a refusal has already been answered (the facade hands it to the log
// writer as a function), so these bound only what it may cost the database and the process: one
// answer within the timeout, and at most this many reads in flight at once — a burst of refusals
// beyond that logs `null` ("could not tell") instead of queueing primary-key reads.
const PERSISTED_ROW_PROBE_TIMEOUT_MS = 2000
const PERSISTED_ROW_PROBE_MAX_IN_FLIGHT = 4

interface DataSourceRecord {
  id: string
  name: string
  type: string
  description: string | null
  config: unknown // JSONB
  status: string
  last_connected_at: Date | null
  last_error: string | null
  owner_id: string
  workspace_id: string | null
  tenant_id?: string | null
  scope_kind?: string | null
  is_active: boolean
  auto_connect: boolean
  metadata: unknown | null
  tags: unknown | null
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}

export interface DataSourceManagerOptions {
  db?: Kysely<unknown>
  autoLoadFromDb?: boolean
}

export class DataSourceManager extends EventEmitter {
  private adapters: Map<string, BaseDataAdapter> = new Map()
  private adapterTypes: Map<string, AdapterConstructor> = new Map()
  private connectionPool: Map<string, Promise<void>> = new Map()
  // Per-source ownership for scope enforcement (A0.1). Owner is the enforced
  // boundary this slice; workspace is stored for a future workspace-shared model.
  private scopes: Map<string, {
    ownerId: string
    workspaceId: string | null
    tenantId: string | null
    scopeKind: DataSourceScopeKind
  }> = new Map()
  private db?: Kysely<unknown>
  private initialized = false
  // Server-log diagnostics only (see DataSourceUnloadedReason). Never consulted by any access
  // decision, never returned to a client.
  private loadOutcomes: Map<string, DataSourceLoadFilterOutcome | 'removed'> = new Map()
  private registryLoadCompleted = false
  private loadFilterSnapshotAvailable = false
  private persistedRowProbesInFlight = 0

  constructor(options: DataSourceManagerOptions = {}) {
    super()
    this.db = options.db
    this.registerDefaultAdapters()

    // Auto-load from database if db is provided
    if (options.autoLoadFromDb && this.db) {
      this.loadFromDatabase().catch((err) => {
        console.error('[DataSourceManager] Failed to auto-load from database:', err)
      })
    }
  }

  /**
   * Initialize with database connection (for late binding)
   */
  async initialize(db: Kysely<unknown>): Promise<void> {
    this.db = db
    await this.loadFromDatabase()
    this.initialized = true
  }

  /**
   * Load all active data sources from database
   */
  async loadFromDatabase(): Promise<void> {
    if (!this.db) {
      console.warn('[DataSourceManager] No database connection, skipping load')
      return
    }

    // A (re)load is a new snapshot: forget the previous one's diagnostics before taking it.
    this.loadOutcomes.clear()
    this.registryLoadCompleted = false
    this.loadFilterSnapshotAvailable = false

    try {
      const records = await this.db
        .selectFrom('data_sources' as never)
        .selectAll()
        .where('is_active' as never, '=', true as never)
        .where('deleted_at' as never, 'is', null as never)
        .execute() as DataSourceRecord[]

      let loadedCount = 0
      for (const record of records) {
        // Diagnostics only: which load step refused this row. Assigned BEFORE the step throws.
        let outcome: DataSourceLoadFilterOutcome = 'load_failed'
        try {
          if (!this.adapterTypes.has(record.type.toLowerCase())) {
            outcome = 'unsupported_type'
            throw new Error(`Unsupported persisted data source type: ${record.type}`)
          }
          const config = this.recordToConfig(record)
          await this.addDataSourceInternal(config, false, 'load') // Don't persist again; LOAD phase pins
          // Ownership lives on the DB record, not in config (recordToConfig strips it)
          this.scopes.set(record.id, {
            ownerId: record.owner_id,
            workspaceId: record.workspace_id ?? null,
            // Older databases do not have these columns. Treat absent or
            // malformed scope metadata as the narrowest legacy posture.
            tenantId: normalizeTenantId(record.tenant_id),
            scopeKind: isDataSourceScopeKind(record.scope_kind) ? record.scope_kind : 'legacy_private'
          })

          if (record.auto_connect) {
            await this.connectDataSource(config.id).catch((err) => {
              console.error(`[DataSourceManager] Auto-connect failed for ${config.id}:`, err)
            })
          }
          loadedCount += 1
        } catch (err) {
          if (outcome === 'load_failed' && err !== null && typeof err === 'object' && decryptFailures.has(err)) {
            outcome = 'decrypt_failed'
          }
          this.recordLoadOutcome(record.id, outcome)
          console.error(`[DataSourceManager] Failed to load data source ${record.id}:`, err)
        }
      }

      const skippedCount = records.length - loadedCount
      console.log(`[DataSourceManager] Loaded ${loadedCount} data sources from database${skippedCount > 0 ? ` (${skippedCount} skipped)` : ''}`)
      this.registryLoadCompleted = true
      await this.snapshotLoadFilteredRows()
    } catch (err) {
      // Table might not exist yet
      console.warn('[DataSourceManager] Could not load from database:', err)
    }
  }

  private recordLoadOutcome(id: unknown, outcome: DataSourceLoadFilterOutcome | 'removed'): void {
    if (typeof id === 'string' && id.length > 0) this.loadOutcomes.set(id, outcome)
  }

  /**
   * Which rows the load query's own filters (`is_active = true`, `deleted_at IS NULL`) left out, so
   * a later refusal can say `inactive` / `soft_deleted` instead of guessing. Diagnostics only: one
   * read after the load, classified in JS from the returned columns, and NEVER able to affect the
   * load — any failure just leaves `unknown_at_load` as the answer for ids nobody recorded.
   */
  private async snapshotLoadFilteredRows(): Promise<void> {
    const db = this.db
    if (!db) return
    try {
      const rows = await db
        .selectFrom('data_sources' as never)
        .select(['id', 'is_active', 'deleted_at'] as never)
        .where(sql<boolean>`(is_active IS NOT TRUE OR deleted_at IS NOT NULL)`)
        .execute() as Array<{ id?: unknown; is_active?: unknown; deleted_at?: unknown }>
      if (!Array.isArray(rows)) return
      for (const row of rows) {
        if (!row || typeof row.id !== 'string' || this.adapters.has(row.id)) continue
        if (row.deleted_at !== null && row.deleted_at !== undefined) {
          this.recordLoadOutcome(row.id, 'soft_deleted')
        } else if (row.is_active !== true) {
          this.recordLoadOutcome(row.id, 'inactive')
        }
      }
      this.loadFilterSnapshotAvailable = true
    } catch {
      // Values-free on purpose: the driver's text can carry host/database/login.
      console.warn('[DataSourceManager] Load-filter snapshot unavailable; unloaded-source diagnostics degrade to unknown_at_load')
    }
  }

  /**
   * Values-free explanation of why `assertAccess(id, actor)` refuses, or `null` when it would not.
   * It mirrors `assertAccess` branch for branch and reads only in-memory state, so a caller that
   * invokes it synchronously right after catching that refusal gets the reason for THAT refusal.
   * It is for the SERVER LOG only: returning it to a client would undo the no-existence-leak
   * invariant `assertAccess` exists to keep.
   */
  describeAccessRefusal(id: string, actor: DataSourceActor): DataSourceAccessRefusal | null {
    const scope = this.scopes.get(id)
    if (!this.adapters.has(id) || !scope) {
      return { reason: 'not_loaded', loadOutcome: this.unloadedReason(id) }
    }
    const { userId, platformAdmin } = normalizeActor(actor)
    if (platformAdmin === true) return null
    if (userId === undefined || scope.ownerId !== userId) return { reason: 'owner_mismatch' }
    return null
  }

  private unloadedReason(id: string): DataSourceUnloadedReason {
    const recorded = this.loadOutcomes.get(id)
    if (recorded) return recorded
    if (!this.registryLoadCompleted) return 'registry_not_loaded'
    return this.loadFilterSnapshotAvailable ? 'absent_at_load' : 'unknown_at_load'
  }

  /**
   * R7: is this id a LIVE row in `data_sources` right now (exists, `is_active`, not soft-deleted)?
   * One read by primary key. Distinguishes "the table says live but the registry, loaded at startup,
   * does not have it" (the table was changed after startup without going through this manager).
   * `null` means "could not tell" — no database, a failed query, or no answer within the timeout.
   * It never throws, so a caller's refusal path and response cannot depend on it.
   */
  async probePersistedLiveRow(id: string): Promise<boolean | null> {
    const db = this.db
    if (!db || typeof id !== 'string' || id.length === 0) return null
    if (this.persistedRowProbesInFlight >= PERSISTED_ROW_PROBE_MAX_IN_FLIGHT) return null
    // The slot is held until the QUERY settles — not until the timeout answers — so a slow database
    // cannot accumulate reads past the cap by timing each one out.
    this.persistedRowProbesInFlight += 1
    let released = false
    const release = () => {
      if (released) return
      released = true
      this.persistedRowProbesInFlight -= 1
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const query = db
        .selectFrom('data_sources' as never)
        .select(['id', 'is_active', 'deleted_at'] as never)
        .where('id' as never, '=', id as never)
        .limit(1)
        .execute() as Promise<Array<{ id?: unknown; is_active?: unknown; deleted_at?: unknown }>>
      // Also keeps the query's own later rejection (after a timeout won) from surfacing as unhandled.
      query.then(release, release)
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), PERSISTED_ROW_PROBE_TIMEOUT_MS)
        // Never keep a process alive just to finish a diagnostic.
        if (timer && typeof timer.unref === 'function') timer.unref()
      })
      const rows = await Promise.race([query, timeout])
      if (rows === 'timeout' || !Array.isArray(rows)) return null
      const row = rows.find((candidate) => candidate && candidate.id === id)
      if (!row) return false
      return row.is_active === true && (row.deleted_at === null || row.deleted_at === undefined)
    } catch {
      // Building or running the query failed: no query is pending any more.
      release()
      return null
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Encrypt secret credential fields for storage (A1). Uses
   * encryptStoredSecretValue (NOT normalize) so secret values are not trimmed —
   * a trailing space in a password is significant. ALWAYS encrypts: it does NOT
   * use the enc: prefix to detect "already encrypted", because a real plaintext
   * secret can legitimately start with "enc:". Callers always pass plaintext
   * credentials — user input on create, and the preserved or freshly-decrypted
   * value on update/load — so there is nothing already-encrypted to skip.
   */
  private encryptCredentials(creds?: Credentials): Credentials | undefined {
    if (!creds) return creds
    const out: Credentials = { ...creds }
    for (const key of SENSITIVE_CREDENTIAL_KEYS) {
      const v = out[key]
      if (typeof v === 'string' && v.length > 0) {
        out[key] = encryptStoredSecretValue(v)
      }
    }
    return out
  }

  /**
   * Decrypt secret credential fields after load (A1). Encrypted values are
   * decrypted and FAIL LOUD on a key mismatch (a ciphertext is never passed
   * through to the adapter). Legacy plaintext passes through unchanged — lazy
   * migration: it is re-encrypted on the next persist.
   */
  private decryptCredentials(creds?: Credentials): Credentials | undefined {
    if (!creds) return creds
    const out: Credentials = { ...creds }
    for (const key of SENSITIVE_CREDENTIAL_KEYS) {
      const v = out[key]
      if (typeof v === 'string' && isEncryptedSecretValue(v)) {
        try {
          out[key] = decryptStoredSecretValue(v)
        } catch (err) {
          const failure = new Error(
            `Failed to decrypt credential '${key}' (ENCRYPTION_KEY may have changed): ${err instanceof Error ? err.message : String(err)}`
          )
          decryptFailures.add(failure)
          throw failure
        }
      }
    }
    return out
  }

  private recordToConfig(record: DataSourceRecord): DataSourceConfig {
    const configData = record.config as Record<string, unknown>
    return {
      id: record.id,
      name: record.name,
      type: record.type,
      connection: (configData.connection || {}) as ConnectionConfig,
      credentials: this.decryptCredentials(configData.credentials as Credentials | undefined),
      options: configData.options as AdapterOptions | undefined,
      poolConfig: configData.poolConfig as DataSourceConfig['poolConfig']
    }
  }

  private configToRecord(
    config: DataSourceConfig,
    ownerId: string,
    workspaceId: string | null | undefined,
    tenantId: string | null,
    scopeKind: DataSourceScopeKind
  ): Omit<DataSourceRecord, 'created_at' | 'updated_at' | 'deleted_at' | 'last_connected_at' | 'last_error'> {
    return {
      id: config.id,
      name: config.name,
      type: config.type,
      description: null,
      config: {
        connection: config.connection,
        credentials: this.encryptCredentials(config.credentials),
        options: config.options,
        poolConfig: config.poolConfig
      },
      status: 'disconnected',
      owner_id: ownerId,
      workspace_id: workspaceId || null,
      tenant_id: tenantId,
      scope_kind: scopeKind,
      is_active: true,
      auto_connect: config.options?.autoConnect === true,
      metadata: null,
      tags: null
    }
  }

  private registerDefaultAdapters(): void {
    // Derived from DEFAULT_ADAPTER_REGISTRY — the same object SUPPORTED_DATA_SOURCE_TYPES is
    // derived from, so registration and public support cannot drift apart.
    for (const [type, AdapterClass] of Object.entries(DEFAULT_ADAPTER_REGISTRY)) {
      this.registerAdapterType(type, AdapterClass as unknown as AdapterConstructor)
    }
  }

  registerAdapterType(type: string, adapterClass: AdapterConstructor): void {
    this.adapterTypes.set(type.toLowerCase(), adapterClass)
  }

  /**
   * Add a new data source (with optional persistence)
   */
  async addDataSource(
    config: DataSourceConfig,
    options?: {
      ownerId?: string
      workspaceId?: string
      tenantId?: string | null
      scopeKind?: DataSourceScopeKind
      persist?: boolean
    }
  ): Promise<BaseDataAdapter> {
    // Reject duplicates BEFORE persisting — otherwise a create that will be
    // rejected still runs the upsert and overwrites the existing row's config
    // and owner. Use updateDataSource() to change an existing source.
    if (this.adapters.has(config.id)) {
      throw new Error(`Data source with id '${config.id}' already exists`)
    }

    const persist = options?.persist !== false && this.db !== undefined
    const ownerId = options?.ownerId || 'system'
    const workspaceId = options?.workspaceId
    const tenantId = normalizeTenantId(options?.tenantId)
    const scopeKind = options?.scopeKind ?? 'private'
    if (!isDataSourceScopeKind(scopeKind)) {
      throw new Error(`Invalid data source scope kind: ${String(scopeKind)}`)
    }

    // FIX 2: refuse — BEFORE any persistence — to provision an id that a deploy file has armed for SQL
    // write but that was not pinned at allowlist-load time. This is the arm-ahead-of-provisioning
    // attack: an armed-but-never-provisioned id created at the API tier would otherwise be trusted into
    // a fresh pin (and, once persisted, pinned again at the next restart). Refusing before persist
    // means no such row is ever written. An unarmed id, or an armed id already pinned at load (a
    // revival), passes untouched.
    assertSqlSourceProvisionableAtRuntime(
      (status, code, message, details) => Object.assign(new Error(message), { status, code, details }),
      config.id,
    )

    // Persist to database first (if enabled)
    if (persist && this.db) {
      await this.persistDataSource(config, ownerId, workspaceId, tenantId, scopeKind)
    }

    const adapter = await this.addDataSourceInternal(config, false)
    this.scopes.set(config.id, {
      ownerId,
      workspaceId: workspaceId ?? null,
      tenantId,
      scopeKind
    })
    this.loadOutcomes.delete(config.id)
    return adapter
  }

  /**
   * Atomically update an existing data source. Persists the new config first
   * (the only failure-prone step); the live adapter is swapped only after that
   * succeeds. A failed update therefore leaves the original source intact —
   * unlike a removeDataSource()+addDataSource() sequence, which soft-deletes
   * the row and drops the adapter before the re-add can fail.
   */
  async updateDataSource(
    id: string,
    config: DataSourceConfig,
    options?: {
      ownerId?: string
      workspaceId?: string
      tenantId?: string | null
      scopeKind?: DataSourceScopeKind
    }
  ): Promise<BaseDataAdapter> {
    const existing = this.adapters.get(id)
    if (!existing) {
      throw new Error(`Data source with id '${id}' not found`)
    }
    const priorScope = this.scopes.get(id)
    const ownerId = options?.ownerId ?? priorScope?.ownerId ?? 'system'
    const workspaceId = options?.workspaceId ?? priorScope?.workspaceId ?? undefined
    const tenantId = options && Object.prototype.hasOwnProperty.call(options, 'tenantId')
      ? normalizeTenantId(options.tenantId)
      : (priorScope?.tenantId ?? null)
    const scopeKind = options?.scopeKind ?? priorScope?.scopeKind ?? 'private'
    if (!isDataSourceScopeKind(scopeKind)) {
      throw new Error(`Invalid data source scope kind: ${String(scopeKind)}`)
    }

    // G-4 MARKER DURABILITY (P1). The k3Destination marker is SET-ONCE: once a source is a declared
    // K3 destination, no later update — from any caller, through any merge — may clear or unset it.
    // This is the manager chokepoint that makes the marker immutable; the route additionally returns a
    // coded refusal for an explicit clear attempt. Forcing it here means even a silent/buggy path that
    // dropped the key cannot re-open writes on a K3 connection.
    if (existing.getConfig().options?.k3Destination === true) {
      config = { ...config, options: preserveK3Marker(existing.getConfig().options, config.options) }
    }

    // Validate the target type before touching anything live.
    if (!this.adapterTypes.get(config.type.toLowerCase())) {
      throw new Error(`Unsupported data source type: ${config.type}`)
    }

    // FIX 2 (defense-in-depth): a redirect must not be the FIRST observation that binds an armed id. A
    // source pinned at load passes here (it is already bound); an armed id with no load pin is refused
    // before persistence, exactly as a runtime create is.
    assertSqlSourceProvisionableAtRuntime(
      (status, code, message, details) => Object.assign(new Error(message), { status, code, details }),
      config.id,
    )

    // Persist first — if this throws, the live source is untouched.
    if (this.db !== undefined) {
      await this.persistDataSource(config, ownerId, workspaceId, tenantId, scopeKind)
    }

    // Persist succeeded: swap the in-memory adapter (no further failure-prone I/O).
    try {
      if (existing.isConnected()) {
        await existing.disconnect()
      }
    } catch {
      // best-effort teardown of the previous adapter
    }
    existing.removeAllListeners()
    this.adapters.delete(id)
    this.connectionPool.delete(id)

    let adapter: BaseDataAdapter
    try {
      adapter = await this.addDataSourceInternal(config, false)
    } catch (err) {
      // Diagnostics only (the same error is rethrown untouched): the id just left the registry, so
      // a later refusal must not describe it as never having been in the table.
      this.recordLoadOutcome(id, 'load_failed')
      throw err
    }
    this.scopes.set(id, {
      ownerId,
      workspaceId: workspaceId ?? null,
      tenantId,
      scopeKind
    })
    return adapter
  }

  /**
   * Assert the actor may access this data source (A0.1 scope enforcement).
   *
   * Semantics by actor shape (see {@link DataSourceActor}):
   * - bare user-id string / undefined: OWNER-ONLY — unchanged legacy behavior
   *   for data-plane call sites (facade, workbench).
   * - actor context with `platformAdmin: true`: passes for any EXISTING
   *   source — the management tier that already holds the rbac global-admin
   *   bypass over `data_sources:*` codes is no longer stopped here.
   * - actor context without platformAdmin: owner equality on `userId`.
   *
   * Throws the same "not found" wording as getDataSource in every refusal so
   * callers return a uniform 404 — a non-admin non-owner must not learn that
   * someone else's source exists. A platform admin probing a nonexistent id
   * gets the identical not-found.
   *
   * workspace_id is stored but NOT consulted (phase-2 lever: workspace-shared
   * access would extend this single choke point, and every call site would
   * inherit it).
   */
  assertAccess(id: string, actor: DataSourceActor): void {
    const scope = this.scopes.get(id)
    if (!this.adapters.has(id) || !scope) {
      throw new Error(`Data source with id '${id}' not found`)
    }
    const { userId, platformAdmin } = normalizeActor(actor)
    if (platformAdmin === true) return
    if (userId === undefined || scope.ownerId !== userId) {
      throw new Error(`Data source with id '${id}' not found`)
    }
  }

  /** Stored ownership scope for a data source, if present. */
  getScope(id: string): {
    ownerId: string
    workspaceId: string | null
    tenantId: string | null
    scopeKind: DataSourceScopeKind
  } | undefined {
    return this.scopes.get(id)
  }

  /**
   * COUNT of integration_external_systems rows that reference this source (the
   * referential delete guard's input), across BOTH migration-time shapes:
   * - canonical rows whose connection_id equals the id; and
   * - legacy-only rows whose connection_id is NULL, config->>'dataSourceId'
   *   equals the id, and server-stamped config->>'dataSourceOwnerId' equals the
   *   source's OWNER.
   *
   * The explicit connection_id IS NULL predicate prevents a migrated row that
   * retains its rollback pointer from being counted twice.
   *
   * WHY owner-attributed, not raw (P2-A): the raw dataSourceId match let any
   * integration:write holder in ANY tenant pin a foreign user's source id and
   * make it permanently un-deletable by its owner, and the count aggregated
   * across tenants. data_sources carries no tenant column — owner_id is its
   * only authority key, and the integration read path already authorizes
   * per-owner (the plugin facade refuses non-owner principals at every read,
   * and a pipeline's runtime principal is its creator) — so owner-attribution
   * is the join the model actually supports. The stamp is written server-side
   * at bind time by the external-system registry AFTER the facade's
   * assertReferenceable validated principal == owner; a client cannot forge
   * it. Unstamped rows (legacy, or written past the API) do not count: their
   * attribution is unknowable, and an unattributable reference must not deny
   * the owner their delete — its read path already fails closed per-owner at
   * runtime, exactly as before this guard existed.
   *
   * Failure posture:
   * - No bound db: the manager is memory-only, nothing persisted can hold a
   *   reference — 0 is exact, not fail-open.
   * - SQLSTATE 42P01 (undefined_table): the integration schema is not
   *   installed, the referencing layer does not exist — 0 is exact. STRICTLY
   *   the code, never message prose (P2-B): a non-schema failure worded like
   *   a missing table must fail the delete CLOSED, and if these tables ever
   *   move to a separate DB a message heuristic would become genuinely
   *   fail-open.
   * - Any OTHER query failure propagates — the delete does not happen.
   */
  async countExternalSystemReferences(
    id: string,
    // W7-B: the EXECUTOR this count runs on. Omitted (every pre-existing caller
    // and every existing test) === `this.db`, byte-identical to before.
    // `removeDataSource` passes its OPEN TRANSACTION so the count and the soft
    // delete observe the same snapshot under the same `FOR UPDATE` row lock: a
    // count taken on a SECOND connection cannot wait for a concurrent bind, so
    // the delete would commit on top of a reference it never saw.
    executor?: Kysely<unknown>
  ): Promise<number> {
    const db = executor ?? this.db
    if (!db) return 0
    const ownerId = this.scopes.get(id)?.ownerId
    // No known owner scope → nothing can be attributed to it. (Route callers
    // sit behind assertAccess, so the scope exists on every real delete path.)
    if (ownerId === undefined) return 0
    let canonicalCount: number
    try {
      const canonicalRows = await db
        .selectFrom('integration_external_systems' as never)
        .select(sql<number>`count(*)::int`.as('count') as never)
        .where('connection_id' as never, '=', id as never)
        .execute() as Array<{ count: number }>
      canonicalCount = canonicalRows[0]?.count ?? 0
    } catch (err) {
      // Only the FIRST observation may prove that the referencing layer does
      // not exist. Once the table has been observed, a later 42P01 is a DDL
      // race/failure and must propagate rather than discarding a canonical
      // count that may already be non-zero.
      if ((err as { code?: string } | null)?.code === UNDEFINED_TABLE_SQLSTATE) return 0
      throw err
    }

    const legacyRows = await db
      .selectFrom('integration_external_systems' as never)
      .select(sql<number>`count(*)::int`.as('count') as never)
      .where('connection_id' as never, 'is', null as never)
      .where(sql`config->>'dataSourceId'` as never, '=', id as never)
      .where(sql`config->>'dataSourceOwnerId'` as never, '=', ownerId as never)
      .execute() as Array<{ count: number }>
    return canonicalCount + (legacyRows[0]?.count ?? 0)
  }

  /**
   * BATCH form of countExternalSystemReferences: reference counts for MANY ids
   * in ONE pair of grouped queries (two `GROUP BY` statements total, never one
   * pair per id). This exists for the LISTING surface, which would otherwise be
   * N+1; the delete guard keeps calling the singular method, whose fail-closed
   * posture is what actually gates removal.
   *
   * SAME semantics as the singular method, deliberately:
   * - canonical: rows whose connection_id equals the id;
   * - legacy: rows with connection_id IS NULL whose config->>'dataSourceId'
   *   equals the id AND whose server-stamped config->>'dataSourceOwnerId'
   *   equals THAT id's owner (P2-A owner attribution — a foreign pin must not
   *   be counted, here just as it is not counted for the delete guard).
   *
   * WHY the owner match is applied in TS and not in the WHERE clause: one
   * grouped query serves many ids, and each id has its OWN owner, so the
   * predicate is not a single constant. The query therefore groups by the
   * (dataSourceId, dataSourceOwnerId) PAIR and this method keeps only the
   * groups whose owner equals the scope owner of that id — arithmetically the
   * same filter, evaluated once per group instead of once per row. Widening it
   * to a raw dataSourceId match would re-open P2-A (a stranger's pin inflating
   * — and, worse, appearing to justify — someone else's reference count).
   *
   * `ids` with no known scope get 0 without being queried, matching the
   * singular method's "no owner scope -> nothing attributable" short-circuit.
   *
   * Failure posture matches the singular method: no db -> all zero; SQLSTATE
   * 42P01 on the FIRST (canonical) query -> all zero (integration schema not
   * installed); any other failure, and any failure of the second query,
   * PROPAGATES. Callers that merely DISPLAY the counts must degrade to
   * "unknown" rather than to 0 — see the listing route.
   *
   * Returns a Map keyed by the requested ids only (every requested id is
   * present). Values are counts; no name, tenant, owner or config of any
   * referencing row is returned to the caller.
   */
  async countExternalSystemReferencesByIds(ids: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>()
    for (const id of ids) counts.set(id, 0)
    if (!this.db || counts.size === 0) return counts

    // Only owner-scoped ids can be attributed; unscoped ones stay 0 unqueried.
    const attributable = [...counts.keys()].filter((id) => this.scopes.get(id)?.ownerId !== undefined)
    if (attributable.length === 0) return counts

    try {
      const canonicalRows = await this.db
        .selectFrom('integration_external_systems' as never)
        .select([
          sql<string>`connection_id`.as('reference_id') as never,
          sql<number>`count(*)::int`.as('count') as never,
        ] as never)
        .where('connection_id' as never, 'in', attributable as never)
        .groupBy('connection_id' as never)
        .execute() as Array<{ reference_id: string | null; count: number }>
      for (const row of canonicalRows) {
        const id = row.reference_id
        // Never let a row widen the answer beyond what was asked for.
        if (id === null || id === undefined || !counts.has(id)) continue
        counts.set(id, (counts.get(id) ?? 0) + (row.count ?? 0))
      }
    } catch (err) {
      // Mirrors the singular method: only the FIRST observation may prove the
      // referencing layer does not exist, and only via the SQLSTATE.
      if ((err as { code?: string } | null)?.code === UNDEFINED_TABLE_SQLSTATE) return counts
      throw err
    }

    const legacyRows = await this.db
      .selectFrom('integration_external_systems' as never)
      .select([
        sql<string>`config->>'dataSourceId'`.as('reference_id') as never,
        sql<string>`config->>'dataSourceOwnerId'`.as('reference_owner_id') as never,
        sql<number>`count(*)::int`.as('count') as never,
      ] as never)
      .where('connection_id' as never, 'is', null as never)
      .where(sql`config->>'dataSourceId'` as never, 'in', attributable as never)
      .groupBy([
        sql`config->>'dataSourceId'` as never,
        sql`config->>'dataSourceOwnerId'` as never,
      ] as never)
      .execute() as Array<{ reference_id: string | null; reference_owner_id: string | null; count: number }>
    for (const row of legacyRows) {
      const id = row.reference_id
      if (id === null || id === undefined || !counts.has(id)) continue
      // P2-A: unstamped rows are unattributable and do NOT count; a stamp that
      // names anyone but this id's owner is a foreign pin and does NOT count.
      const stamped = row.reference_owner_id
      if (stamped === null || stamped === undefined) continue
      if (this.scopes.get(id)?.ownerId !== stamped) continue
      counts.set(id, (counts.get(id) ?? 0) + (row.count ?? 0))
    }

    return counts
  }

  /**
   * Internal method to add data source to memory.
   *
   * `phase` distinguishes the DEPLOY-controlled LOAD path (`loadFromDatabase`, which re-observes the
   * sources that existed at process start) from the RUNTIME (API) path (`addDataSource` /
   * `updateDataSource`). Only the load path may PIN an armed source's connection (FIX 2); the runtime
   * path never pins here — its arm-provisioning refusal happens earlier, before persistence.
   */
  private async addDataSourceInternal(
    config: DataSourceConfig,
    autoConnect = true,
    phase: 'load' | 'runtime' = 'runtime'
  ): Promise<BaseDataAdapter> {
    if (this.adapters.has(config.id)) {
      throw new Error(`Data source with id '${config.id}' already exists`)
    }

    const AdapterClass = this.adapterTypes.get(config.type.toLowerCase())
    if (!AdapterClass) {
      throw new Error(`Unsupported data source type: ${config.type}`)
    }

    const adapter = new AdapterClass(config)

    // Set up event forwarding
    adapter.on('connected', (data) => {
      this.emit('adapter:connected', { ...data, id: config.id })
      this.updateStatus(config.id, 'connected').catch(() => {})
    })
    adapter.on('disconnected', (data) => {
      this.emit('adapter:disconnected', { ...data, id: config.id })
      this.updateStatus(config.id, 'disconnected').catch(() => {})
    })
    adapter.on('error', () => {
      // A3 leak-fix: forward the REDACTED cause (adapter.connectionError, set by onError just before
      // this fires), never the raw Error — the adapter:error event AND the persisted last_error must
      // not carry a secret. The manager is the only consumer of an adapter's 'error' event.
      const redacted = adapter.connectionError ?? 'connection error'
      this.emit('adapter:error', { id: config.id, adapter: config.name, error: redacted })
      this.updateStatus(config.id, 'error', redacted).catch(() => {})
    })

    this.adapters.set(config.id, adapter)

    // SQL WRITE ARM-BINDING (P1 + FIX 2): pin this source's connection fingerprint — but ONLY on the
    // DEPLOY-controlled LOAD path. FIRST-SEEN-WINS, so a later redirect does NOT move the pin, and a
    // revival after removeDataSource re-enters here but the pin persists. The RUNTIME (API) create /
    // redirect path does NOT pin: an armed id that was never provisioned at load cannot be pinned by an
    // API-tier create (that is refused before persistence in addDataSource/updateDataSource), and an
    // unarmed source runtime-pinning itself and then being armed-without-restart is likewise closed.
    if (phase === 'load') {
      pinSqlSourceConnection(config.id, config.connection as Record<string, unknown> | undefined)
    }

    // Auto-connect if specified
    if (autoConnect && config.options?.autoConnect !== false) {
      await this.connectDataSource(config.id)
    }

    return adapter
  }

  /**
   * Persist data source to database
   */
  private async persistDataSource(
    config: DataSourceConfig,
    ownerId: string,
    workspaceId: string | null | undefined,
    tenantId: string | null,
    scopeKind: DataSourceScopeKind
  ): Promise<void> {
    if (!this.db) return

    const record = this.configToRecord(config, ownerId, workspaceId, tenantId, scopeKind)

    await this.db
      .insertInto('data_sources' as never)
      .values(record as never)
      .onConflict((oc) =>
        oc.column('id' as never).doUpdateSet({
          name: record.name,
          type: record.type,
          config: record.config,
          owner_id: record.owner_id,
          workspace_id: record.workspace_id,
          tenant_id: record.tenant_id,
          scope_kind: record.scope_kind,
          status: record.status,
          auto_connect: record.auto_connect,
          // Revive a previously soft-deleted row (remove() sets these) so an
          // updated or recreated-with-same-id source survives a restart.
          is_active: true,
          deleted_at: null,
          updated_at: new Date()
        } as never)
      )
      .execute()
  }

  /**
   * Update data source status in database
   */
  private async updateStatus(
    id: string,
    status: string,
    error?: string
  ): Promise<void> {
    if (!this.db) return

    try {
      const updateData: Record<string, unknown> = {
        status,
        updated_at: new Date()
      }

      if (status === 'connected') {
        updateData.last_connected_at = new Date()
        updateData.last_error = null
      } else if (status === 'error' && error) {
        updateData.last_error = error
      }

      await this.db
        .updateTable('data_sources' as never)
        .set(updateData as never)
        .where('id' as never, '=', id as never)
        .execute()
    } catch (err) {
      // Non-critical, log and continue
      console.warn(`[DataSourceManager] Failed to update status for ${id}:`, err)
    }
  }

  /**
   * Remove a data source — DURABLE-FIRST ordering (PERM-04; minimal-plan §5 PR-2
   * acceptance: "删除失败不会改变内存状态，重启后不会复活").
   *
   * The previous order was fail-OPEN: disconnect → drop adapter /
   * connectionPool / scope → only THEN write the soft delete, whose failure was
   * swallowed by console.warn. A delete that failed at the database therefore
   * returned a 200-looking success, stopped answering in-process, and CAME BACK
   * at the next restart (loadFromDatabase re-observes is_active = true AND
   * deleted_at IS NULL) — memory and row disagreed in the dangerous direction.
   *
   * The order is now:
   *   ① referential check — refuse (coded 409) while an integration external
   *      system still references this source. There is NO bypass: the former
   *      `force` option was retired by the owner's ruling (2026-09-20, ①) —
   *      a referenced source is not deletable, the caller unbinds first. Runs
   *      before ANY mutation, and while `scopes` still holds the owner that
   *      countExternalSystemReferences attributes against. Since W7-B it shares
   *      ONE TRANSACTION with the persist step, opened by a `FOR UPDATE` on
   *      the source row - see the block comment at the call site for the
   *      two-sided lock protocol and why the binding side participates
   *      through the foreign key rather than a SELECT of its own.
   *   ② persist the (soft|hard) delete. A failure THROWS a coded, values-free
   *      refusal — the driver's own text (host/port/database/login) goes to the
   *      log only — and no in-memory byte has been touched yet.
   *   ③ only after the durable write committed: drop adapter / connectionPool /
   *      scope, so memory can no longer outlive or predate the row.
   *   ④ release the connection LAST, listeners muted first so the adapter's
   *      'disconnected' event cannot write status back onto the row that was
   *      just deleted. A disconnect failure is warn-only: the source is already
   *      gone durably AND in memory, and rolling the delete back for a leaked
   *      socket would resurrect exactly the ghost this fix removes.
   *
   * No `force` option exists any more (it used to skip the count for a
   * route-authorized platform-admin break). Any extra option key is ignored;
   * the count ALWAYS runs, so a direct (non-route) caller — or an old route
   * build — cannot dangle a reference. Behind the application check, the
   * database refuses the same delete on `DATA_SOURCE_LIVE_CONNECTION_FK`
   * (23503), which this method also maps to the same 409.
   */
  async removeDataSource(id: string, options?: { hardDelete?: boolean }): Promise<void> {
    const adapter = this.adapters.get(id)
    if (!adapter) {
      throw new Error(`Data source with id '${id}' not found`)
    }

    // The 409 the referential check raises. Built once so the transactional, the
    // database-backstop and the memory-only path cannot drift apart.
    // `referenceCount` is null when the refusal came from the foreign key: the
    // transaction is already aborted at that point, so the count is not known.
    const referencedRefusal = (referenceCount: number | null) => Object.assign(
      new Error(
        referenceCount === null
          ? `Data source '${id}' is still referenced by at least one external system (the database refused the delete on its binding foreign key); unbind it first — 请先解绑引用它的外部系统。Deleting a referenced source is refused; force=true is no longer accepted.`
          : `Data source '${id}' is referenced by ${referenceCount} external system(s); unbind them first — 请先解绑 ${referenceCount} 个外部系统。Deleting a referenced source is refused; force=true is no longer accepted.`
      ),
      {
        status: 409,
        code: DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS_CODE,
        details: { referenceCount }
      }
    )

    // ①+② ONE TRANSACTION (W7-B). #5784 made the delete durable-FIRST but left
    // check and write in two autocommit statements, so a bind that committed in
    // between produced a reference to an already-deleted source. They are now a
    // single transaction whose FIRST act is to take the source row's lock:
    //
    //   SELECT ... FROM data_sources WHERE id = $1 FOR UPDATE
    //
    // LOCK ORDER (identical on both sides, so the protocol cannot deadlock):
    // data_sources row FIRST, integration_external_systems SECOND. The binding
    // side takes the data_sources lock too — not by writing its own SELECT (the
    // plugin's db helper is scoped to `integration_*` and must not be widened to
    // reach data_sources), but because the FK
    // `fk_integration_external_systems_connection_id` makes PostgreSQL take a
    // KEY SHARE lock on the referenced row inside the INSERT/UPDATE's own
    // transaction. FOR UPDATE conflicts with KEY SHARE, so:
    //   * bind in flight, then delete  -> the delete's FOR UPDATE WAITS for the
    //     bind to commit, then COUNTS it and refuses 409. THIS ordering is what
    //     this transaction closes (PR-A).
    //   * delete in flight, then bind  -> the bind WAITS for the delete to
    //     commit; since PR-B (migration zzzz20260920120000) the FK references
    //     `data_sources(live_id)`, a STORED generated column that is NULL once
    //     `deleted_at` is set, so the resumed bind fails its FK re-check
    //     (23503 on DATA_SOURCE_LIVE_CONNECTION_FK) and no dangling row lands.
    //     The same constraint refuses the soft delete itself while a canonical
    //     binding exists — the database backstop for a count this transaction
    //     somehow did not see; `catch` below maps that 23503 to the same 409.
    //   Closed for the CANONICAL shape (connection_id) only. The legacy shape
    //   (connection_id IS NULL + config.dataSourceId) has no FK and is covered
    //   by the FOR UPDATE half alone; do NOT read this block as "concurrent
    //   delete isolation is complete for every shape".
    //
    // ISOLATION: READ COMMITTED (PostgreSQL's default, which is what this
    // deployment runs). The half that IS closed does not rely on a stricter
    // level — it rests on the row lock, which is explicit locking, not snapshot
    // semantics. Under READ COMMITTED the count statement takes a fresh
    // snapshot AFTER the FOR UPDATE returns, so it sees exactly the binds that
    // committed while it waited.
    //
    // 42P01 INSIDE the transaction: countExternalSystemReferences still maps a
    // missing referencing table to 0, but PostgreSQL has already aborted the
    // transaction at that point, so the UPDATE that follows fails (25P02) and
    // the delete surfaces as the values-free 500 below — fail-CLOSED, not the
    // fail-open the autocommit path had. Migration 057 creates the table in
    // every deployment, so this is a posture note, not a live path.
    if (this.db) {
      try {
        await this.db.transaction().execute(async (trx) => {
          // Lock step 1. Soft-deleted rows are not re-locked: `removeDataSource`
          // is reached only for a source still present in memory, and a row that
          // is already deleted has nothing left to protect.
          await trx
            .selectFrom('data_sources' as never)
            .select('id' as never)
            .where('id' as never, '=', id as never)
            .forUpdate()
            .execute()

          // ALWAYS counted — there is no force bypass (owner ruling 2026-09-20 ①).
          const referenceCount = await this.countExternalSystemReferences(id, trx)
          if (referenceCount > 0) throw referencedRefusal(referenceCount)

          if (options?.hardDelete) {
            await trx
              .deleteFrom('data_sources' as never)
              .where('id' as never, '=', id as never)
              .execute()
          } else {
            await trx
              .updateTable('data_sources' as never)
              .set({
                deleted_at: new Date(),
                is_active: false,
                updated_at: new Date()
              } as never)
              .where('id' as never, '=', id as never)
              .execute()
          }
        })
      } catch (err) {
        // The referential 409 is a DECISION, not a persistence failure: it must
        // reach the client as itself. Only an uncoded failure is translated.
        if ((err as { code?: string } | null)?.code === DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS_CODE) {
          throw err
        }
        // DATABASE BACKSTOP (PR-B): the soft/hard delete itself violated the
        // binding foreign key — a canonical reference exists that the count did
        // not see. Judged by SQLSTATE 23503 first (the driver's prose is locale
        // dependent: a zh_CN server never emits the English sentence) and by the
        // constraint name second. This is the same DECISION
        // as the counted 409, so it surfaces as the same code, not as the 500.
        // Any OTHER 23503 (another table's constraint) stays a persistence
        // failure and is translated below.
        if (isLiveConnectionFkViolation(err)) {
          throw referencedRefusal(null)
        }
        // Cause to the log ONLY — a kysely/driver failure embeds host, port,
        // database and login. The client gets a fixed sentence and the id it
        // already supplied. The transaction rolled back, so nothing partial
        // survived and no in-memory byte has been touched yet.
        console.warn(`[DataSourceManager] Failed to delete from database: ${id}`, err)
        throw Object.assign(
          new Error(
            `Data source '${id}' was not deleted: the deletion could not be persisted. Nothing was changed; retry.`
          ),
          { status: 500, code: DATA_SOURCE_DELETE_NOT_PERSISTED_CODE }
        )
      }
    } else {
      // Memory-only manager: nothing is persisted, so nothing can hold a
      // reference and the count is 0 by construction. Kept so the call (and its
      // contract) survives for a manager that is later given a db. No force
      // bypass here either.
      const referenceCount = await this.countExternalSystemReferences(id)
      if (referenceCount > 0) throw referencedRefusal(referenceCount)
    }

    // ③ in-memory state only after the row is durably gone.
    this.adapters.delete(id)
    this.connectionPool.delete(id)
    this.scopes.delete(id)
    this.recordLoadOutcome(id, 'removed')

    // ④ resource release last, and never a reason to undo ② / ③.
    adapter.removeAllListeners()
    if (adapter.isConnected()) {
      try {
        await adapter.disconnect()
      } catch (err) {
        console.warn(`[DataSourceManager] Failed to disconnect removed data source: ${id}`, err)
      }
    }
  }

  getDataSource(id: string): BaseDataAdapter {
    const adapter = this.adapters.get(id)
    if (!adapter) {
      throw new Error(`Data source with id '${id}' not found`)
    }
    return adapter
  }

  async connectDataSource(id: string): Promise<void> {
    const adapter = this.getDataSource(id)

    // Reuse existing connection promise if connecting
    let connectionPromise = this.connectionPool.get(id)
    if (connectionPromise) {
      // A piggy-backing caller shares the in-flight connect, so it must receive the SAME values-free
      // refusal as the originator — otherwise a /schema landing while /select connects would still
      // surface the raw driver text this translation exists to suppress.
      return connectionPromise.catch((error: unknown) => {
        throw sourceUnavailableError(id, error, adapter)
      })
    }

    connectionPromise = adapter.connect()
    this.connectionPool.set(id, connectionPromise)

    try {
      await connectionPromise
    } catch (error) {
      // VALUES-FREE REFUSAL (#2). See sourceUnavailableError above: a fixed 503 SOURCE_UNAVAILABLE
      // for the client, the cause to the log only. The callers that used to forward `error.message`
      // verbatim (routes /schema, /tables/:table, /:id/connect) now forward this fixed sentence.
      throw sourceUnavailableError(id, error, adapter)
    } finally {
      this.connectionPool.delete(id)
    }
  }

  async disconnectDataSource(id: string): Promise<void> {
    const adapter = this.getDataSource(id)
    await adapter.disconnect()
  }

  // A3: returns success + the redacted failure cause. Ensures a connection is attempted (so the
  // operator learns WHY it fails), then probes. The adapter stays Promise<boolean>; it records the
  // redacted cause in `connectionError` (via onError) which we aggregate here.
  async testConnection(id: string): Promise<{ success: boolean; error?: string }> {
    const adapter = this.getDataSource(id)
    try {
      if (!adapter.isConnected()) {
        await adapter.connect() // throws on failure; onError has recorded the redacted cause
      }
    } catch {
      return { success: false, error: adapter.connectionError ?? undefined }
    }
    const ok = await adapter.testConnection()
    return ok ? { success: true } : { success: false, error: adapter.connectionError ?? undefined }
  }

  // test-before-save (design-lock 2026-06-17): validate connection PARAMS before a source exists,
  // so the create / credential-rotation form can surface a bad host/credential WITHOUT first
  // persisting a broken source. Fully EPHEMERAL — builds a transient adapter via the same
  // `adapterTypes` factory, then connects/probes/disposes. It deliberately does NOT go through
  // addDataSourceInternal: it never writes `adapters`/`scopes`/`connectionPool`, never persists,
  // and wires NO manager event forwarding (no `this.emit` / `updateStatus`). The only listener is a
  // local no-op `error` swallow so BaseDataAdapter.onError()'s `emit('error')` can't throw on an
  // unhandled emitter error; the redacted cause is still read from `adapter.connectionError`.
  async testEphemeralConnection(
    config: DataSourceConfig
  ): Promise<{ success: boolean; latency?: number; error?: string }> {
    const AdapterClass = this.adapterTypes.get(config.type.toLowerCase())
    if (!AdapterClass) {
      // Mirror addDataSourceInternal's wording; the route maps this to a 400 (client error).
      throw new Error(`Unsupported data source type: ${config.type}`)
    }
    // Bound the connect attempt (follow-up m3): a hanging / black-hole host otherwise ties up the
    // request to the driver default (pg = 30s). Inject a short connect-timeout via each driver's own
    // knob — pg `poolConfig.acquireTimeout`, mysql2 `options.connectTimeout`, mssql
    // `connection.connectionTimeoutMs` — defaulting ONLY when the caller didn't set one (each driver
    // ignores the others' keys). Scrub below still reads the original `config` (same host/username).
    const TEST_CONNECT_TIMEOUT_MS = 10000
    const conn = (config.connection ?? {}) as Record<string, unknown>
    const opts = (config.options ?? {}) as Record<string, unknown>
    const pool = (config.poolConfig ?? {}) as Record<string, unknown>
    const boundedConfig = {
      ...config,
      connection: { ...conn, connectionTimeoutMs: conn.connectionTimeoutMs ?? TEST_CONNECT_TIMEOUT_MS },
      options: { ...opts, connectTimeout: opts.connectTimeout ?? TEST_CONNECT_TIMEOUT_MS },
      poolConfig: { ...pool, acquireTimeout: pool.acquireTimeout ?? TEST_CONNECT_TIMEOUT_MS },
    } as unknown as DataSourceConfig
    const adapter = new AdapterClass(boundedConfig)
    adapter.on('error', () => { /* ephemeral: cause captured via connectionError; no emit/persist */ })
    // No-echo (design-lock 钉子②): the adapter redacts secret VALUES, but a driver diagnostic can still
    // reflect the caller's submitted host/username/endpoint (e.g. `password authentication failed for
    // user "x"`, `getaddrinfo ENOTFOUND <host>`, or an HTTP client echoing a submitted baseURL).
    // Strip those submitted identifiers too so the ephemeral test never echoes connection input back.
    // Scoped here — shared redactSecrets stays intact for /:id/test.
    const submittedEndpointFragments = (): string[] => {
      const conn = config.connection ?? {}
      const fragments = new Set<string>()
      const add = (value: unknown): void => {
        if (typeof value !== 'string') return
        const trimmed = value.trim()
        if (trimmed.length < 3) return
        fragments.add(trimmed)
        fragments.add(trimmed.replace(/\/+$/, ''))
        try {
          const parsed = new URL(trimmed)
          for (const part of [parsed.origin, parsed.host, parsed.hostname]) {
            if (part.length >= 3) fragments.add(part)
          }
        } catch {
          // Not every connection field is a URL; host/database/username are handled as plain strings.
        }
      }
      for (const value of [
        conn.host,
        conn.server,
        conn.database,
        conn.baseURL,
        conn.baseUrl,
        conn.url,
        config.credentials?.username,
      ]) {
        add(value)
      }
      return [...fragments].sort((a, b) => b.length - a.length)
    }
    const scrubInput = (msg: string | undefined): string | undefined => {
      if (!msg) return msg
      let out = msg
      for (const id of submittedEndpointFragments()) out = out.split(id).join('***')
      return out
    }
    const start = Date.now()
    try {
      if (!adapter.isConnected()) {
        await adapter.connect() // throws on failure; onError records the redacted cause
      }
      const ok = await adapter.testConnection()
      const latency = Date.now() - start
      return ok
        ? { success: true, latency }
        : { success: false, latency, error: scrubInput(adapter.connectionError ?? undefined) }
    } catch {
      return { success: false, latency: Date.now() - start, error: scrubInput(adapter.connectionError ?? undefined) }
    } finally {
      try {
        if (adapter.isConnected()) await adapter.disconnect()
      } catch {
        // best-effort teardown of the transient adapter
      }
      adapter.removeAllListeners()
    }
  }

  // Query routing methods
  async query<T = Record<string, DbValue>>(
    dataSourceId: string,
    sql: string,
    params?: DbValue[]
  ): Promise<QueryResult<T>> {
    const adapter = this.getDataSource(dataSourceId)
    // The C6 write-gated marker refuses the RAW query path outright and predates this gate; it keeps
    // precedence because it is the more specific diagnosis for that source (and it refuses reads too,
    // which the capability gate deliberately does not).
    if (isGenericQueryDisabledConfig(adapter.getConfig())) {
      throw new Error(c6WriteTargetQueryDisabledMessage(dataSourceId))
    }
    // W-1(c) DEFAULT-DENY SQL WRITE GATE, fail-early before connect. A pure read passes free; anything
    // else requires this data source to be an ARMED target. The adapter's own query() re-checks at the
    // true chokepoint, so a caller who skips this wrapper is still refused; this layer only saves a
    // connect. The gate never inspects what the statement writes TO. The arm-binding additionally
    // revokes an armed source whose connection has been redirected since it was pinned.
    assertSqlWriteAllowed(
      (status, code, message, details) => Object.assign(new Error(message), { status, code, details }),
      sql,
      { id: adapter.getConfig().id, name: adapter.getConfig().name, type: adapter.getType(), connection: adapter.getConfig().connection },
    )

    if (!adapter.isConnected()) {
      await this.connectDataSource(dataSourceId)
    }

    return adapter.query<T>(sql, params)
  }

  async select<T = Record<string, DbValue>>(
    dataSourceId: string,
    table: string,
    options?: QueryOptions
  ): Promise<QueryResult<T>> {
    const adapter = this.getDataSource(dataSourceId)

    if (!adapter.isConnected()) {
      await this.connectDataSource(dataSourceId)
    }

    return adapter.select<T>(table, options)
  }

  async insert<T = Record<string, DbValue>>(
    dataSourceId: string,
    table: string,
    data: Record<string, DbValue> | Record<string, DbValue>[]
  ): Promise<QueryResult<T>> {
    const adapter = this.getDataSource(dataSourceId)
    adapter.assertWritable() // defense-in-depth: reject mutations on a read-only source
    // G-4 DESTINATION FENCE (insert). Refuse a K3 destination — declared (marker) or betrayed by a
    // K3 business-table target — before connecting or touching the driver. This is the chokepoint the
    // by-kind fences leak past: a sql-write-gated source pointed at K3 arrives here as a generic write.
    assertNotK3Destination(adapter.getConfig())

    if (!adapter.isConnected()) {
      await this.connectDataSource(dataSourceId)
    }

    return adapter.insert<T>(table, data)
  }

  async update<T = Record<string, DbValue>>(
    dataSourceId: string,
    table: string,
    data: Record<string, DbValue>,
    where: WhereClause
  ): Promise<QueryResult<T>> {
    const adapter = this.getDataSource(dataSourceId)
    adapter.assertWritable() // defense-in-depth: reject mutations on a read-only source
    // G-4 DESTINATION FENCE (update). Same refusal as insert — a K3 destination is a K3 destination
    // whichever mutation verb reaches it.
    assertNotK3Destination(adapter.getConfig())

    if (!adapter.isConnected()) {
      await this.connectDataSource(dataSourceId)
    }

    return adapter.update<T>(table, data, where)
  }

  async delete<T = Record<string, DbValue>>(
    dataSourceId: string,
    table: string,
    where: WhereClause
  ): Promise<QueryResult<T>> {
    const adapter = this.getDataSource(dataSourceId)
    adapter.assertWritable() // defense-in-depth: reject mutations on a read-only source
    // G-4 DESTINATION FENCE (delete). A delete against a K3 destination is an external write-back too.
    assertNotK3Destination(adapter.getConfig())
    if (isC6WriteTargetConfig(adapter.getConfig())) {
      throw new Error(c6WriteTargetDeleteUnsupportedMessage(dataSourceId))
    }

    if (!adapter.isConnected()) {
      await this.connectDataSource(dataSourceId)
    }

    return adapter.delete<T>(table, where)
  }

  // Cross-database operations
  async copyData(
    sourceId: string,
    sourceTable: string,
    targetId: string,
    targetTable: string,
    options?: {
      where?: WhereClause
      batchSize?: number
      transform?: (row: Record<string, DbValue>) => Record<string, DbValue>
    }
  ): Promise<{ totalRows: number; duration: number }> {
    const startTime = Date.now()
    const sourceAdapter = this.getDataSource(sourceId)
    const targetAdapter = this.getDataSource(targetId)
    // G-4 DESTINATION FENCE (copy target). copyData ends in `targetAdapter.insert(targetTable, ...)`,
    // so the target side is a write into `targetTable`. Refuse a K3 destination here, before the
    // first source read — a copy TO K3 is a K3 external write-back regardless of where the rows come
    // from. The source side is a READ and is deliberately not fenced.
    assertNotK3Destination(targetAdapter.getConfig())
    if (isGenericQueryDisabledConfig(sourceAdapter.getConfig())) {
      throw new Error(c6WriteTargetQueryDisabledMessage(sourceId))
    }
    if (isGenericQueryDisabledConfig(targetAdapter.getConfig())) {
      throw new Error(c6WriteTargetCopyUnsupportedMessage(targetId))
    }

    if (!sourceAdapter.isConnected()) {
      await this.connectDataSource(sourceId)
    }
    if (!targetAdapter.isConnected()) {
      await this.connectDataSource(targetId)
    }

    const batchSize = options?.batchSize || 1000
    let offset = 0
    let totalRows = 0

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = await sourceAdapter.select(sourceTable, {
        where: options?.where,
        limit: batchSize,
        offset
      })

      if (result.data.length === 0) {
        break
      }

      let data = result.data
      if (options?.transform) {
        data = data.map(options.transform)
      }

      await targetAdapter.insert(targetTable, data)
      totalRows += data.length
      offset += batchSize

      this.emit('copy:progress', {
        sourceId,
        targetId,
        totalRows,
        currentBatch: data.length
      })
    }

    const duration = Date.now() - startTime
    return { totalRows, duration }
  }

  // Federation query (simple JOIN across databases)
  async federatedQuery<T = Record<string, DbValue>>(
    queries: Array<{
      dataSourceId: string
      sql: string
      params?: DbValue[]
      alias: string
    }>,
    joinLogic?: (results: Map<string, Record<string, DbValue>[]>) => T[]
  ): Promise<T[]> {
    const results = new Map<string, Record<string, DbValue>[]>()

    // Execute queries in parallel
    const promises = queries.map(async ({ dataSourceId, sql, params, alias }) => {
      const adapter = this.getDataSource(dataSourceId)
      // The C6 write-gated marker keeps precedence on the raw path, as in `query()` above.
      if (isGenericQueryDisabledConfig(adapter.getConfig())) {
        throw new Error(c6WriteTargetQueryDisabledMessage(dataSourceId))
      }
      // W-1(c) DEFAULT-DENY SQL WRITE GATE. A federated leg runs raw SQL: a pure read passes, a write
      // needs an armed target (and its connection must still match the pinned one).
      assertSqlWriteAllowed(
        (status, code, message, details) => Object.assign(new Error(message), { status, code, details }),
        sql,
        { id: adapter.getConfig().id, name: adapter.getConfig().name, type: adapter.getType(), connection: adapter.getConfig().connection },
      )

      if (!adapter.isConnected()) {
        await this.connectDataSource(dataSourceId)
      }

      const result = await adapter.query(sql, params)
      results.set(alias, result.data)
    })

    await Promise.all(promises)

    // Apply join logic if provided, otherwise return concatenated results
    if (joinLogic) {
      return joinLogic(results)
    }

    // Default: concatenate all results
    const allResults: T[] = []
    for (const data of results.values()) {
      allResults.push(...(data as T[]))
    }
    return allResults
  }

  /**
   * True when this id is visible to the scoping filter. Two filter shapes:
   * - `{ actor }`: the authority model — platformAdmin sees every source;
   *   a plain actor sees only its own (an actor with no userId sees NOTHING —
   *   fail closed, unlike the legacy unfiltered call).
   * - `{ ownerId }` (legacy): owner equality, unchanged.
   * - no filter: unscoped (internal/ops callers only).
   */
  private scopePermitsListing(id: string, filter?: { ownerId?: string; actor?: DataSourceActor }): boolean {
    if (filter && 'actor' in filter) {
      const { userId, platformAdmin } = normalizeActor(filter.actor)
      if (platformAdmin === true) return true
      if (userId === undefined) return false
      const scope = this.scopes.get(id)
      return scope !== undefined && scope.ownerId === userId
    }
    if (filter?.ownerId !== undefined) {
      const scope = this.scopes.get(id)
      return scope !== undefined && scope.ownerId === filter.ownerId
    }
    return true
  }

  // Management methods
  listDataSources(filter?: { ownerId?: string; actor?: DataSourceActor }): Array<{
    id: string
    name: string
    type: string
    connected: boolean
    ownerId?: string
  }> {
    const sources: Array<{
      id: string
      name: string
      type: string
      connected: boolean
      ownerId?: string
    }> = []

    for (const [id, adapter] of this.adapters) {
      // A0.1: scope the listing (owner filter, or the actor-tier model)
      if (!this.scopePermitsListing(id, filter)) {
        continue
      }
      sources.push({
        id,
        name: adapter.getName(),
        type: adapter.getType(),
        connected: adapter.isConnected(),
        // Owner is management metadata (name/type/status/owner) — NEVER part
        // of config/credentials. Lets an admin listing attribute each source.
        ownerId: this.scopes.get(id)?.ownerId
      })
    }

    return sources
  }

  async healthCheck(filter?: { ownerId?: string; actor?: DataSourceActor }): Promise<Map<string, {
    connected: boolean
    responsive: boolean
    latency?: number
  }>> {
    const health = new Map<string, {
      connected: boolean
      responsive: boolean
      latency?: number
    }>()

    for (const [id, adapter] of this.adapters) {
      // A0.1: health is a read surface too; keep it scoped with list/get so
      // fixing the /health route shadow does not leak cross-owner source ids.
      if (!this.scopePermitsListing(id, filter)) {
        continue
      }

      const startTime = Date.now()
      const connected = adapter.isConnected()
      let responsive = false

      if (connected) {
        try {
          responsive = await adapter.testConnection()
        } catch {
          responsive = false
        }
      }

      health.set(id, {
        connected,
        responsive,
        latency: connected ? Date.now() - startTime : undefined
      })
    }

    return health
  }

  async disconnectAll(): Promise<void> {
    const promises: Promise<void>[] = []

    for (const [_id, adapter] of this.adapters) {
      if (adapter.isConnected()) {
        promises.push(adapter.disconnect())
      }
    }

    await Promise.all(promises)
  }

  async dispose(): Promise<void> {
    await this.disconnectAll()
    this.adapters.clear()
    this.adapterTypes.clear()
    this.connectionPool.clear()
    this.scopes.clear()
    this.removeAllListeners()
  }
}
