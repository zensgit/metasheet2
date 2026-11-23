import { Client, type ClientConfig, type QueryResultRow } from 'pg'
import { EventWriteUnavailable, writeFailure, internalId, uuid, type EventScope } from './validation'

export interface EventSql {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }>
}
export class EventQueryBusy extends Error {
  readonly code = 'E1_QUERY_BUSY'
  readonly status = 503
  readonly retryable = true
  constructor() { super('E1_QUERY_BUSY') }
}
export class EventQueryUnavailable extends Error {
  readonly code = 'E1_QUERY_UNAVAILABLE'
  readonly status = 503
  constructor() { super('E1_QUERY_UNAVAILABLE') }
}
export type EventClient = EventSql & { connect(): Promise<void>; end(): Promise<void>; on(event: 'error', handler: () => void): unknown }
export type ClientFactory = (config: ClientConfig) => EventClient
const clock = () => performance.now()
/** Upper bound for awaiting the close of a successful run; it never extends past the deadline of that run. */
const CLOSE_WAIT_MS = 100
const settleWithin = async (settling: Promise<void>, ms: number) => {
  if (!(ms >= 1)) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([settling, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.floor(ms)) })]) }
  finally { if (timer) clearTimeout(timer) }
}

/** Non-waiting pool with no idle clients: connecting/closing/uncertain clients retain their slot. */
class IsolatedPool {
  private occupied = 0
  constructor(private readonly config: ClientConfig, private readonly readOnly: boolean, private readonly factory: ClientFactory) {}
  get active() { return this.occupied }

  async run<T>(budgetMs: number, work: (sql: EventSql) => Promise<T>): Promise<T> {
    const failure = () => this.readOnly ? new EventQueryUnavailable() : new EventWriteUnavailable()
    if (this.occupied >= (this.readOnly ? 1 : 3)) throw this.readOnly ? new EventQueryBusy() : failure()
    if (!(budgetMs > 0)) throw failure()
    this.occupied++
    const deadline = clock() + budgetMs
    let client: EventClient
    try {
      client = this.factory({ ...this.config, connectionTimeoutMillis: Math.max(1, Math.floor(Math.min(100, budgetMs))),
        application_name: this.readOnly ? 'e1_query' : 'e1_write',
        options: `-c search_path=pg_catalog,public -c lock_timeout=100ms -c statement_timeout=100ms${this.readOnly ? ' -c default_transaction_read_only=on' : ''}` })
    } catch { this.occupied--; throw failure() }
    client.on('error', () => { /* pg errors never enter diagnostics as raw values */ })
    let closed: Promise<void> | undefined
    const close = () => {
      // A rejected close does not prove termination: quarantine its capacity permanently.
      closed ??= client.end().then(() => { this.occupied-- }).catch(() => {})
      return closed
    }
    let expired = false
    const left = () => {
      const remaining = Math.floor(deadline - clock())
      if (expired || remaining < 1) throw failure()
      return remaining
    }
    const settings = async () => {
      const remaining = left()
      await client.query("SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $1, true)", [`${remaining}ms`])
      left()
    }
    const sql: EventSql = {
      async query<R extends QueryResultRow>(text: string, values?: unknown[]) {
        await settings()
        const result = await client.query<R>(text, values)
        left()
        return result
      },
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; void close(); reject(failure()) }, Math.max(1, Math.floor(budgetMs)))
    })
    const execution = (async () => {
      await client.connect()
      left()
      await client.query(this.readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN')
      const result = await work(sql)
      await settings()
      await client.query('COMMIT')
      left()
      return result
    })()
    let succeeded = false
    try { const result = await Promise.race([execution, timeout]); succeeded = true; return result }
    catch (error) { throw this.readOnly ? failure() : writeFailure(error) }
    finally {
      if (timer) clearTimeout(timer)
      // end() aborts an uncommitted transaction. A timed-out COMMIT remains unknown; no retry here.
      const closing = close()
      // Success returns after its own slot is released, so the next run in the same flow is admitted.
      // The wait is bounded and never releases the slot itself: a hung or rejected close stays occupied.
      // Timed-out and failed runs do not wait.
      if (succeeded) await settleWithin(closing, Math.min(CLOSE_WAIT_MS, deadline - clock()))
    }
  }
}

/** Construction is passive: no connection, timers, boot event, worker or cleanup starts here. */
export class EventConnections {
  private readonly write: IsolatedPool
  private readonly read: IsolatedPool
  constructor(config: Pick<ClientConfig, 'connectionString' | 'ssl'>, factory: ClientFactory = config => new Client(config)) {
    if (!config.connectionString) throw new EventWriteUnavailable()
    try {
      const address = new URL(config.connectionString)
      if (!['postgres:', 'postgresql:'].includes(address.protocol)) throw new Error()
      // pg lets URL parameters override ClientConfig, including startup options and pool identity.
      for (const key of address.searchParams.keys()) {
        if (!['sslmode', 'sslcert', 'sslkey', 'sslrootcert'].includes(key)) throw new Error()
      }
    } catch { throw new EventWriteUnavailable() }
    this.write = new IsolatedPool(config, false, factory)
    this.read = new IsolatedPool(config, true, factory)
  }
  get active() { return { write: this.write.active, query: this.read.active } }
  writeTransaction<T>(mode: 'foreground' | 'background', work: (sql: EventSql) => Promise<T>): Promise<T> {
    return this.write.run(mode === 'foreground' ? 100 : 2000, work)
  }
  /** requestStarted uses performance.now(), including time spent before admission. */
  async readTransaction<T>(requestStarted: number, work: (snapshot: EventReadSnapshot) => Promise<T>): Promise<T> {
    const now = clock()
    if (!Number.isFinite(requestStarted) || requestStarted > now) throw new EventQueryUnavailable()
    let snapshot: EventReadSnapshot | undefined
    try {
      return await this.read.run(Math.min(2000, 5000 - (now - requestStarted)), async sql => {
        snapshot = Object.freeze({}) as EventReadSnapshot
        readSnapshots.set(snapshot, sql)
        return work(snapshot)
      })
    } finally { if (snapshot) readSnapshots.delete(snapshot) }
  }
}

declare const snapshotBrand: unique symbol
declare const scopeBrand: unique symbol
export type EventReadSnapshot = Readonly<{ [snapshotBrand]: true }>
export type VerifiedEventReadScope = EventScope & Readonly<{ [scopeBrand]: true }>
const readSnapshots = new WeakMap<EventReadSnapshot, EventSql>()
const readScopes = new WeakMap<VerifiedEventReadScope, EventReadSnapshot>()
function snapshotSql(snapshot: EventReadSnapshot): EventSql {
  const sql = readSnapshots.get(snapshot)
  if (!sql) throw new EventQueryUnavailable()
  return sql
}

/** Internal scope issuer; E1-E must add session/live-admin verification here before any route uses it. */
export async function verifyEventReadScope(snapshot: EventReadSnapshot, selection: EventScope): Promise<VerifiedEventReadScope> {
  const sql = snapshotSql(snapshot)
  const { scope_kind, org_id } = selection
  if (scope_kind === 'organization' ? !internalId(org_id) || ['all', '*'].includes(org_id)
    : scope_kind !== 'system' || org_id !== null) throw new EventQueryUnavailable()
  if (scope_kind === 'organization') {
    const result = await sql.query<{ present: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM public.user_orgs WHERE org_id=$1
      UNION ALL SELECT 1 FROM public.directory_integrations WHERE org_id=$1
      UNION ALL SELECT 1 FROM public.security_events WHERE scope_kind='organization' AND org_id=$1
    ) AS present`, [org_id])
    if (result.rows[0]?.present !== true) throw new EventQueryUnavailable()
  }
  snapshotSql(snapshot)
  const scope = Object.freeze({ scope_kind, org_id }) as VerifiedEventReadScope
  readScopes.set(scope, snapshot)
  return scope
}

export const EVENT_COLUMNS = 'id, schema_version, scope_kind, org_id, producer, event_type, severity, outcome, reason_code, actor_kind, actor_user_id, subject_user_id, target_kind, target_id, source_kind, source_id, source_step, record_origin, occurred_at, recorded_at, facts, expires_at, delivery_planned_at'
/** Fixed scoped queries only; the snapshot never exposes its SQL connection. */
export async function readEventRows(snapshot: EventReadSnapshot, scope: VerifiedEventReadScope, id: string, deliveries: boolean): Promise<Record<string, unknown>[]> {
  const sql = snapshotSql(snapshot)
  if (readScopes.get(scope) !== snapshot) throw new EventQueryUnavailable()
  if (!uuid(id)) return []
  const result = await sql.query(deliveries
    ? `SELECT d.id,d.event_id,d.channel,d.route_ref,d.attempt_no,d.status,d.result_code,
      d.created_at,d.due_at,d.started_at,d.finished_at,d.retry_safety,d.next_attempt_at,d.expires_at
      FROM public.security_events e JOIN public.security_event_deliveries d ON d.event_id=e.id
      WHERE e.scope_kind=$1 AND e.org_id IS NOT DISTINCT FROM $2 AND e.id=$3 ORDER BY d.created_at,d.id LIMIT 100`
    : `SELECT ${EVENT_COLUMNS} FROM public.security_events
      WHERE scope_kind=$1 AND org_id IS NOT DISTINCT FROM $2 AND id=$3`, [scope.scope_kind, scope.org_id, id])
  return result.rows
}

export interface W1Transaction {
  readonly sql: EventSql
  /** Resolves ONLY after outer COMMIT/ROLLBACK is known and the client is returned or destroyed. */
  readonly settledAndReleased: Promise<void>
  readonly deadline: number
  /** Must terminate this client, not merely signal cancellation. */
  destroy(): Promise<void>
}
function timeoutMs(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(us|ms|s|min|h|d)?$/.exec(value)
  if (!match) throw new EventWriteUnavailable()
  const scales = { us: 0.001, ms: 1, s: 1000, min: 60000, h: 3600000, d: 86400000 }
  return Number(match[1]) * (scales[match[2] as keyof typeof scales] ?? 1)
}

/** Shared per process by both proof families. No admission until the first E1 SQL. */
export class W1Capacity {
  private readonly leases = new Map<W1Transaction, string | undefined>()
  private readonly users = new Set<string>()
  private readonly running = new Set<W1Transaction>()
  private readonly ended = new WeakSet<W1Transaction>()
  private readonly poisoned = new WeakSet<W1Transaction>()
  readonly max: number
  constructor(mainPoolMax: number) {
    if (!Number.isSafeInteger(mainPoolMax) || mainPoolMax < 1) throw new EventWriteUnavailable()
    this.max = Math.min(4, Math.floor(mainPoolMax / 5))
  }
  get active() { return this.leases.size }
  async run<T>(tx: W1Transaction, work: (sql: EventSql) => Promise<T>, proofUser?: string): Promise<T> {
    // The caller has already resolved actual direction under its original locks.
    if (this.ended.has(tx) || this.poisoned.has(tx)) throw new EventWriteUnavailable()
    if (!this.leases.has(tx)) {
      if (this.active >= this.max || (proofUser !== undefined && this.users.has(proofUser))) throw new EventWriteUnavailable()
      this.leases.set(tx, proofUser)
      if (proofUser !== undefined) this.users.add(proofUser)
      void tx.settledAndReleased.then(() => {
        this.ended.add(tx)
        this.leases.delete(tx)
        if (proofUser !== undefined) this.users.delete(proofUser)
      }, () => { /* An unknown outer outcome retains capacity. */ })
    } else if (this.leases.get(tx) !== proofUser) throw new EventWriteUnavailable()
    if (this.running.has(tx)) throw new EventWriteUnavailable()
    this.running.add(tx)
    let timer: ReturnType<typeof setTimeout> | undefined
    let expired = false
    const remaining = () => {
      const left = Math.floor(tx.deadline - clock())
      if (expired || left < 1) throw new EventWriteUnavailable()
      return left
    }
    try {
      const execution = (async () => {
        remaining()
        const previous = (await tx.sql.query<{ lock_timeout: string; statement_timeout: string }>("SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout")).rows[0]
        if (!previous) throw new EventWriteUnavailable()
        const lock = timeoutMs(previous.lock_timeout), statement = timeoutMs(previous.statement_timeout)
        const bounded: EventSql = { query: async <R extends QueryResultRow>(text: string, values?: unknown[]) => {
          const limit = Math.min(100, remaining())
          await tx.sql.query("SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)", [`${Math.min(lock || Infinity, limit)}ms`, `${Math.min(statement || Infinity, limit)}ms`])
          remaining()
          const result = await tx.sql.query<R>(text, values)
          remaining()
          return result
        } }
        const result = await work(bounded)
        remaining()
        await tx.sql.query("SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)", [previous.lock_timeout, previous.statement_timeout])
        remaining()
        return result
      })()
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { expired = true; this.poisoned.add(tx); void tx.destroy().catch(() => {}); reject(new EventWriteUnavailable()) }, remaining())
      })
      return await Promise.race([execution, timeout])
    } catch (error) { throw writeFailure(error) }
    finally { if (timer) clearTimeout(timer); this.running.delete(tx) }
    // SQL errors deliberately do not restore in an aborted transaction. The existing owner
    // rolls back its atomic unit (including its existing item savepoint, where applicable).
  }
}
