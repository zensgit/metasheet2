/** Test-only observation of unchanged SQL receipts. Never queries, retries or authorizes. */
type Stage = 'candidate' | 'activation' | 'grant' | 'clock' | 'cutover' | 'duplicate' | 'reservation' | 'request-insert'
type Entry = { stage: Stage; rows?: number; active?: boolean; automatic?: boolean; scheduleOnly?: boolean;
  singleProject?: boolean; used?: number; maximum?: number; elapsedMs?: number; applicable?: boolean; count?: number }
type Trace = { stages: Entry[]; overflow: boolean; outcome: 'pending' | 'commit' | 'rejected'; errorCode?: string }
const errorCodes = new Set([
  'AUTOMATION_READ_DENIED', 'AUTOMATION_READ_SCOPE_CHANGED', 'AUTOMATION_READ_BUDGET_EXHAUSTED',
  'AUTOMATION_READ_IDEMPOTENCY_CONFLICT', 'AUTOMATION_READ_FENCE_LOST', 'AUTOMATION_READ_UNAVAILABLE',
  'AUTOMATION_READ_ROUTING_UNAVAILABLE', 'AUTOMATION_READ_TRANSACTION_REQUIRED',
  'AUTOMATION_READ_INPUT_INVALID', 'AUTOMATION_READ_RUNTIME_INACTIVE',
  'AUTOMATION_ACTOR_AUTHORITY_DENIED', 'AUTOMATION_ACTOR_AUTHORITY_UNAVAILABLE',
  'AUTOMATION_ACTOR_INPUT_INVALID', 'AUTOMATION_ACTOR_TRANSACTION_REQUIRED',
  '55P03', '40001', '40P01', '23503', '23505', '23514',
])
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}
function numeric(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value))) return undefined
  const result = Number(value)
  return Number.isFinite(result) && Math.abs(result) <= Number.MAX_SAFE_INTEGER ? result : undefined
}
function count(value: unknown): number | undefined {
  const result = numeric(value)
  return result !== undefined && Number.isSafeInteger(result) && result >= 0 ? result : undefined
}
function stageFor(sql: string): Stage | undefined {
  // Recognition is deliberately narrow: drift is not silently reclassified.
  const text = sql.replace(/\s+/g, ' ').trim()
  if (/^SELECT a\.id,a\.cron_config,a\.trigger_type,a\.interval_anchor_ms(?:,a\.date_field_confirmation)? FROM integration_automation_read_schedule_activations a /u.test(text)) return 'candidate'
  if (/^SELECT \* FROM integration_automation_read_schedule_activations WHERE id=\$1(?: FOR SHARE NOWAIT)?$/.test(text)) return 'activation'
  if (/^SELECT \* FROM integration_automation_read_grants WHERE id = \$1(?: FOR UPDATE(?: NOWAIT)?)?$/.test(text)) return 'grant'
  if (text === 'SELECT extract(epoch FROM clock_timestamp()) * 1000 AS now_ms') return 'clock'
  if (text === 'SELECT pg_catalog.to_timestamp($2::double precision/1000)>activated_at AS applicable FROM integration_automation_read_schedule_activations WHERE id=$1') return 'cutover'
  if (/^SELECT \* FROM integration_automation_read_requests WHERE grant_id = \$1 AND invocation_id = \$2 FOR UPDATE(?: NOWAIT)?$/.test(text)) return 'duplicate'
  if (text === "SELECT count(*)::int AS count FROM integration_automation_read_requests WHERE grant_id = $1 AND status = 'queued'") return 'reservation'
  if (text === 'INSERT INTO integration_automation_read_requests (id,grant_id,tenant_id,workspace_id,owner_id,invocation_id,project_no,trigger_type) VALUES ($1,$2,$3,NULL,$4,$5,$6,$7)') return 'request-insert'
  return undefined
}
function limit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1 || value > 128) throw new Error('SCHEDULE_OBSERVATION_LIMIT_INVALID')
  return value
}

export function createAutomationReadScheduleObservation(options: {
  maxTransactions?: number; maxStagesPerTransaction?: number
} = {}) {
  const maxTransactions = limit(options.maxTransactions, 64)
  const maxStages = limit(options.maxStagesPerTransaction, 32)
  const transactions: Trace[] = []
  let overflow = false
  return {
    startTransaction() {
      let trace: Trace | undefined, relevant = false, finished = false
      // Transient clock reference, not part of the retained trace; erased on finish.
      let firstClock: number | undefined
      return {
        observe(sql: string, result: unknown): void {
          if (finished) return
          try {
            const stage = stageFor(sql)
            if (!stage) return
            if (!relevant) {
              if (stage !== 'candidate' && stage !== 'activation') return
              relevant = true
              if (transactions.length >= maxTransactions) { overflow = true; return }
              trace = { stages: [], overflow: false, outcome: 'pending' }
              transactions.push(trace)
            }
            if (!trace) return
            if (trace.stages.length >= maxStages) { trace.overflow = true; overflow = true; return }
            const rawRows = own(result, 'rows'), rows = Array.isArray(rawRows) ? rawRows : undefined
            const row = rows ? own(rows, '0') : undefined
            const entry: Entry = { stage }
            if (rows) entry.rows = rows.length
            if (stage === 'grant' && row) {
              entry.active = own(row, 'status') === 'active'
              entry.automatic = own(row, 'purpose') === 'automatic'
              const triggers = own(row, 'triggers'), projects = own(row, 'projects')
              entry.scheduleOnly = Array.isArray(triggers) && triggers.length === 1 && own(triggers, '0') === 'schedule'
              entry.singleProject = Array.isArray(projects) && projects.length === 1
              const used = count(own(row, 'used_executions')), maximum = count(own(row, 'max_executions'))
              if (used !== undefined) entry.used = used
              if (maximum !== undefined) entry.maximum = maximum
            }
            if (stage === 'clock') {
              const at = numeric(own(row, 'now_ms'))
              if (at !== undefined) {
                firstClock ??= at
                const elapsed = at - firstClock
                if (Number.isFinite(elapsed) && Math.abs(elapsed) <= Number.MAX_SAFE_INTEGER) entry.elapsedMs = elapsed
              }
            }
            if (stage === 'cutover' && typeof own(row, 'applicable') === 'boolean') entry.applicable = own(row, 'applicable') as boolean
            const amount = stage === 'reservation' ? count(own(row, 'count'))
              : stage === 'request-insert' ? count(own(result, 'rowCount')) : undefined
            if (amount !== undefined) entry.count = amount
            trace.stages.push(entry)
          } catch {
            // Diagnostic observation must not replace a production return/throw.
            overflow = true
            if (trace) trace.overflow = true
          }
        },
        // true requires the actual COMMIT receipt. false means only that the
        // transaction Promise rejected: a lost COMMIT reply may still be durable.
        finish(committed: boolean, error?: unknown): void {
          if (finished) return
          finished = true
          firstClock = undefined
          if (!trace) return
          trace.outcome = committed ? 'commit' : 'rejected'
          if (!committed) {
            let code: unknown
            try { code = own(error, 'code') } catch { /* unknown remains values-free */ }
            trace.errorCode = typeof code === 'string' && errorCodes.has(code) ? code : 'unknown'
          }
        },
      }
    },
    snapshot() {
      return { overflow, transactions: transactions.map(trace => ({ ...trace,
        stages: trace.stages.map(entry => ({ ...entry })) })) }
    },
  }
}
