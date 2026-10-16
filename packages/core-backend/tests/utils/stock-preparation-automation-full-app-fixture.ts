import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { ConfiguredFixture } from './stock-preparation-plm-full-app-fixture'
import type { AutomationCheckpoint, ConfiguredAutomationBrowserResult } from './stock-preparation-automation-full-app-browser'

type Query = (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
type Adapter = { isConnected(): boolean; pool: Pool | null }
export interface AutomationReadinessDiagnostic {
  reason: 'start' | 'sample' | 'returned' | 'ready' | 'timeout' | 'failed'
  requestState: 'unobserved' | 'queued' | 'running' | 'succeeded' | 'blocked' | 'failed' | 'cancelled' | 'outcome_unknown' | 'invalid'
  consumerState: 'unobserved' | 'pending' | 'in_progress' | 'done' | 'dead_letter' | 'invalid'
  metadataError: 'none' | 'lock-unavailable' | 'deadlock' | 'query-cancelled' | 'other'
  afterPoll: number; elapsedMs: number; rowCount: number; attempts: number
  metadataStarted: number; metadataCompleted: number; metadataRejected: number; metadataPending: number
  nativeCalls: number; nativeCompleted: number; nativeRejected: number; nativePending: number
  hostPoolTotal: number; hostPoolIdle: number; hostPoolWaiting: number
  sourcePoolTotal: number; sourcePoolIdle: number; sourcePoolWaiting: number
  clockReceipts?: number; clockRejected?: number; clockInvalid?: number; clockMaxReceiptWaitMs?: number
  clockForwardBeyondWait?: number; clockBackwardBeyondWait?: number; clockMaxForwardExcessMs?: number
  clockMaxBackwardExcessMs?: number
}

/** Test-only receipt observer. No query, argument, promise or result is replaced.
 * A DB/monotonic delta is classified only beyond BOTH query wait bounds, so
 * differing reply latency alone cannot be reported as a database clock jump.
 * Counters cover the owned host pool, not uniquely an executor/checkpoint. */
export function createAutomationClockReceiptObservation(now: () => number) {
  let active = false
  let prior: { database: number; monotonic: number; wait: number } | undefined
  const stats = { clockReceipts: 0, clockRejected: 0, clockInvalid: 0, clockMaxReceiptWaitMs: 0,
    clockForwardBeyondWait: 0, clockBackwardBeyondWait: 0, clockMaxForwardExcessMs: 0, clockMaxBackwardExcessMs: 0 }
  const bounded = (value: number) => Math.min(2147483647, Math.max(0, Math.ceil(value)))
  return {
    start() { active = true },
    observe(sql: unknown, _values: unknown, result: unknown, started: number) {
      try {
        if (!active || typeof sql !== 'string' || ![
          'SELECT extract(epoch FROM clock_timestamp()) * 1000 AS now_ms',
          'SELECT extract(epoch FROM pg_catalog.clock_timestamp()) * 1000 AS now_ms',
        ].includes(sql.replace(/\s+/g, ' ').trim())) return
        if (!result || typeof result !== 'object' || !('then' in result) || typeof result.then !== 'function') return
        void Promise.resolve(result).then(value => {
          try {
            const monotonic = now(), wait = monotonic - started
            // This cast observes only the native PG receipt; it grants no authority.
            const receipt = value as { rows?: ReadonlyArray<{ now_ms?: unknown }> } | null | undefined
            const raw: unknown = receipt?.rows?.[0]?.now_ms
            const database = typeof raw === 'number' || typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
            if (!Number.isFinite(database) || !Number.isFinite(wait) || wait < 0) { stats.clockInvalid++; return }
            stats.clockReceipts++
            stats.clockMaxReceiptWaitMs = Math.max(stats.clockMaxReceiptWaitMs, bounded(wait))
            if (prior) {
              const drift = database - prior.database - (monotonic - prior.monotonic)
              const uncertainty = prior.wait + wait + 250
              if (drift > uncertainty) {
                stats.clockForwardBeyondWait++
                stats.clockMaxForwardExcessMs = Math.max(stats.clockMaxForwardExcessMs, bounded(drift - uncertainty))
              }
              if (drift < -uncertainty) {
                stats.clockBackwardBeyondWait++
                stats.clockMaxBackwardExcessMs = Math.max(stats.clockMaxBackwardExcessMs, bounded(-drift - uncertainty))
              }
            }
            prior = { database, monotonic, wait }
          } catch { stats.clockInvalid++ }
        }, () => { stats.clockRejected++ }).catch(() => {})
      } catch { stats.clockInvalid++ }
    },
    snapshot() { return { ...stats } },
  }
}
export interface AutomationExecutorAbortObservation {
  origin: 'timeout' | 'live-check' | 'executor-other'
  elapsedMs: number
  firstControllerAborts: number
  timeoutAborts: number
  liveCheckAborts: number
  executorOtherAborts: number
}

/** Test-only observation of the native method. Neither the signal nor abort
 * arguments are inspected or replaced; reporting cannot affect execution. */
export function observeAutomationExecutorAborts(executorModulePaths: readonly string[],
  report: (data: AutomationExecutorAbortObservation) => void) {
  const prototype = AbortController.prototype
  const originalDescriptor = Object.getOwnPropertyDescriptor(prototype, 'abort')!
  let active = true
  let installed = false
  const restore = () => {
    active = false
    if (!installed) return
    try { Object.defineProperty(prototype, 'abort', originalDescriptor); installed = false } catch { /* observation only */ }
  }
  try {
    const normalize = (filename: string) => {
      const normalized = path.resolve(filename.startsWith('file:') ? fileURLToPath(filename) : filename).replaceAll('\\', '/')
      return process.platform === 'win32' ? normalized.toLowerCase() : normalized
    }
    const executorFiles = new Set(executorModulePaths.map(normalize))
    const started = performance.now()
    const seen = new WeakSet<object>()
    const limit = 64
    let firstControllerAborts = 0, timeoutAborts = 0, liveCheckAborts = 0, executorOtherAborts = 0
    const frame = (line: string | undefined) => {
      const parsed = line && /^\s*at (?:(.+) \((.+)\)|(.+))$/u.exec(line)
      if (!parsed) return undefined
      const location = /^(.*):\d+:\d+$/u.exec(parsed[2] ?? parsed[3])
      return location ? { name: parsed[1] ?? '', file: normalize(location[1]) } : undefined
    }
    const wrapped = new Proxy(originalDescriptor.value as AbortController['abort'], {
      apply: function observeAbort(target, receiver, args) {
        let observation: AutomationExecutorAbortObservation | undefined
        try {
          if (active && firstControllerAborts < limit && receiver && typeof receiver === 'object' && !seen.has(receiver)) {
            seen.add(receiver)
            const captured: { stack?: string } = {}
            Error.captureStackTrace(captured, observeAbort)
            const lines = typeof captured.stack === 'string' ? captured.stack.split('\n') : []
            const caller = frame(lines[1])
            // Only the immediate caller may identify the executor. A matching
            // deeper frame must never attribute a driver's/controller's abort.
            if (caller && /\/automation-read-executor\.(?:js|ts)$/u.test(caller.file) && executorFiles.has(caller.file)) {
              const next = frame(lines[2])
              const origin = caller.name === 'Timeout.stop' || caller.name === 'Timeout.stop [as _onTimeout]' ? 'timeout'
                : caller.name === 'stop' && next?.name === 'live' && next.file === caller.file ? 'live-check' : 'executor-other'
              firstControllerAborts += 1
              if (origin === 'timeout') timeoutAborts += 1
              else if (origin === 'live-check') liveCheckAborts += 1
              else executorOtherAborts += 1
              observation = { origin, elapsedMs: Math.min(2147483647, Math.max(0, Math.floor(performance.now() - started))),
                firstControllerAborts, timeoutAborts, liveCheckAborts, executorOtherAborts }
            }
          }
        } catch { /* observation only; never publish the stack or failure */ }
        const result = Reflect.apply(target, receiver, args)
        if (observation) { try { report(observation) } catch { /* observation only */ } }
        return result
      },
    })
    Object.defineProperty(prototype, 'abort', { ...originalDescriptor, value: wrapped })
    installed = true
  } catch { restore() }
  return { dispose: restore }
}
const expectedPreview = { status: 'ready', canApply: false,
  counts: { add: 3, update: 0, skip: 0, inactive: 0, manual_confirm: 0 } }
const mirrorObservationSql = 'SELECT data_source_id AS connection_id, connection_incarnation, validation_revision, '
  + 'tenant_id, owner_id, workspace_id, scope_kind, type, is_active, deleted_at '
  + 'FROM integration_data_source_validation_revisions WHERE data_source_id = $1 FOR SHARE NOWAIT'
type DetailObservation = { poll: number; path: string; incoming: number; finished: number; status: number;
  mirrorQueries: number; mirror55P03: number; otherQueryErrors: number }

/** Observe the unchanged real HTTP callback and owned host PG query promises.
 * Worker metadata queries have no request-scoped context and cannot justify a GET refusal. */
export function observeOwnedDetailRequests(server: HttpServer, pool: Pool, connectionId: string,
  observeQuery?: (sql: unknown, values: unknown, result: unknown, started: number) => void) {
  const contexts = new AsyncLocalStorage<DetailObservation>()
  const listeners = server.rawListeners('request')
  assert.equal(listeners.length, 1, 'APP_AUTOMATION_HTTP_SINGLE_LISTENER_REQUIRED')
  const originalListener = listeners[0] as (request: IncomingMessage, response: ServerResponse) => void
  assert(!Object.hasOwn(originalListener, 'listener'), 'APP_AUTOMATION_HTTP_ONCE_LISTENER_FORBIDDEN')
  let armed: DetailObservation | undefined
  const clientQueries = new Map<PoolClient, { original: PoolClient['query']; wrapped: PoolClient['query'] }>()
  const acquire = (client: PoolClient) => {
    const previous = clientQueries.get(client)
    if (previous) { assert.equal(client.query, previous.wrapped, 'APP_AUTOMATION_HOST_QUERY_CHANGED'); return }
    const original = client.query
    const wrapped = new Proxy(original, { apply(target, receiver, args) {
      const context = contexts.getStore()
      const config = args[0]
      const sql = typeof config === 'string' ? config : config?.text
      const values = typeof config === 'string' ? args[1] : config?.values
      const mirror = context && receiver === client && typeof sql === 'string'
        && sql.replace(/\s+/g, ' ').trim() === mirrorObservationSql
        && Array.isArray(values) && values.length === 1 && values[0] === connectionId
      if (mirror) context.mirrorQueries += 1
      const started = observeQuery ? performance.now() : 0
      const result: unknown = Reflect.apply(target, receiver, args)
      try { observeQuery?.(sql, values, result, started) } catch { /* Diagnostics must not replace a native query result. */ }
      if (context && result && typeof result === 'object' && 'then' in result && typeof result.then === 'function') {
        void Promise.resolve(result).then(() => {}, error => {
          if (mirror && error && typeof error === 'object'
            && Object.getOwnPropertyDescriptor(error, 'code')?.value === '55P03') context.mirror55P03 += 1
          else context.otherQueryErrors += 1
        })
      }
      return result
    } })
    client.query = wrapped
    clientQueries.set(client, { original, wrapped })
  }
  const wrappedListener = new Proxy(originalListener, { apply(target, receiver, args) {
    const [request, response] = args as [IncomingMessage, ServerResponse]
    const context = armed
    if (!context || request.method !== 'GET' || request.url !== context.path) return Reflect.apply(target, receiver, args)
    context.incoming += 1
    response.once('finish', () => { context.finished += 1; context.status = response.statusCode })
    return contexts.run(context, () => Reflect.apply(target, receiver, args))
  } })
  pool.on('acquire', acquire)
  server.removeListener('request', originalListener)
  server.on('request', wrappedListener)
  function intact() {
    assert.deepEqual(server.rawListeners('request'), [wrappedListener], 'APP_AUTOMATION_HTTP_OBSERVER_CHANGED')
    assert.equal(pool.listeners('acquire').filter(listener => listener === acquire).length, 1,
      'APP_AUTOMATION_POOL_OBSERVER_CHANGED')
  }
  return {
    begin(poll: number, requestId: string) {
      intact()
      assert(!armed, 'APP_AUTOMATION_OBSERVATION_OVERLAP')
      armed = { poll, path: `/api/integration/automation-read/requests/${requestId}`, incoming: 0, finished: 0,
        status: 0, mirrorQueries: 0, mirror55P03: 0, otherQueryErrors: 0 }
    },
    end(poll: number, httpStatus: number) {
      intact()
      assert(armed && armed.poll === poll, 'APP_AUTOMATION_OBSERVATION_NOT_ARMED')
      const observation = armed
      armed = undefined
      const verified = observation.incoming === 1 && observation.finished === 1 && observation.status === httpStatus
        && observation.mirrorQueries === 1 && observation.otherQueryErrors === 0
        && (httpStatus === 503 ? observation.mirror55P03 === 1 : httpStatus === 200 && observation.mirror55P03 === 0)
      return { poll, httpStatus, incomingRequests: observation.incoming, finishedResponses: observation.finished,
        sourceMirrorQueries: observation.mirrorQueries, sourceMirror55P03: observation.mirror55P03,
        otherQueryErrors: observation.otherQueryErrors, verified }
    },
    dispose() {
      intact()
      pool.removeListener('acquire', acquire)
      server.removeListener('request', wrappedListener)
      server.on('request', originalListener)
      for (const [client, functions] of clientQueries) {
        assert.equal(client.query, functions.wrapped, 'APP_AUTOMATION_HOST_QUERY_CHANGED')
        client.query = functions.original
        assert.equal(client.query, functions.original, 'APP_AUTOMATION_HOST_QUERY_RESTORE_FAILED')
      }
      assert.deepEqual(server.rawListeners('request'), listeners, 'APP_AUTOMATION_HTTP_RESTORE_FAILED')
      assert(!pool.listeners('acquire').includes(acquire), 'APP_AUTOMATION_POOL_RESTORE_FAILED')
      contexts.disable()
    },
  }
}

/** Explicit owned deployment intent; the actual host/plugin creates its private profile. */
export async function configureAutomationFullAppDeployment(scratch: string, fixture: ConfiguredFixture) {
  const profiles = path.join(scratch, 'synthetic-automation-profiles.json')
  await writeFile(profiles, JSON.stringify({ profiles: [{ tenantId: fixture.tenantId, workspaceId: null,
    projectId: `${fixture.tenantId}:integration-core`, actionId: fixture.actionId }] }) + '\n', { flag: 'wx' })
  process.env.INTEGRATION_CORE_STOCK_PREPARATION_AUTOMATION_PROFILES_PATH = profiles
}

/** Real rule API setup plus observation of the actual source pool. No authority is mocked. */
export async function createAutomationFullAppFixture(input: {
  origin: string; ownerToken: string; fixture: ConfiguredFixture; query: Query; getAdapter(): Adapter | undefined
  hostServer: HttpServer; hostPool: Pool; reportObservation(data: Record<string, boolean | number>): void
  reportRecovery(data: Record<string, boolean | number>): void
  reportReadiness(data: AutomationReadinessDiagnostic): void
  executorModulePaths?: readonly string[]
  reportExecutorAbort?(data: AutomationExecutorAbortObservation): void
}) {
  const { origin, ownerToken, fixture: f, query } = input
  assert.equal(process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED, 'true', 'APP_AUTOMATION_DURABLE_REQUIRED')
  const response = await fetch(origin + `/api/multitable/sheets/${encodeURIComponent(f.target.sheetId)}/automations`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ name: 'Synthetic full-app manual read', triggerType: 'record.created', triggerConfig: {},
      actionType: 'integration_read_preview', actionConfig: { operation: 'plm.stock-preparation.diff-preview.v1', allowManual: true },
      enabled: true }), signal: AbortSignal.timeout(20000),
  })
  assert.equal(response.status, 200, 'APP_AUTOMATION_RULE_HTTP_REQUIRED')
  const created = await response.json() as { ok: boolean; data: { rule: { id: string } } }
  assert.equal(created.ok, true, 'APP_AUTOMATION_RULE_ENVELOPE_REQUIRED')
  const ruleId = created.data?.rule?.id
  assert(typeof ruleId === 'string' && ruleId.length > 0, 'APP_AUTOMATION_RULE_ID_REQUIRED')
  const rules = (await query('SELECT id,created_by,enabled,action_type FROM automation_rules WHERE sheet_id=$1', [f.target.sheetId])).rows
  assert.deepEqual(rules, [{ id: ruleId, created_by: f.owner, enabled: true, action_type: 'integration_read_preview' }],
    'APP_AUTOMATION_REAL_RULE_REQUIRED')
  const profiles = (await query('SELECT tenant_id,project_id,enabled FROM automation_read_target_profiles WHERE sheet_id=$1', [f.target.sheetId])).rows
  assert.deepEqual(profiles, [{ tenant_id: f.tenantId, project_id: `${f.tenantId}:integration-core`, enabled: true }],
    'APP_AUTOMATION_HOST_PROFILE_REQUIRED')
  let observedPool: Pool | undefined
  let originalQuery: Pool['query'] | undefined
  let wrappedQuery: Pool['query'] | undefined
  let nativeCalls = 0, completedCalls = 0, rejectedCalls = 0
  let completedCount: number | undefined
  let grantId: string | undefined, requestId: string | undefined
  let disposed = false
  let detailPolls = 0, verifiedBusyPolls = 0
  let fixtureCompletionWaits = 0, finalRefreshes = 0
  let recoveryNativeCalls: number | undefined
  let openPoll = false
  let detailDeadline = 0
  const phases: string[] = []
  const phaseOrder = ['before-grant', 'after-grant', 'completed', 'refreshed', 'revoked']
  const count = async (table: string) => (await query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count
  async function emptyProjectContext() {
    assert.equal((await query('SELECT count(*)::int AS count FROM meta_records WHERE sheet_id=$1 AND data->>$2=$3',
      [f.target.sheetId, f.target.fieldIdMap.projectNo, f.projectNo])).rows[0].count, 0,
    'APP_AUTOMATION_PROJECT_MUST_HAVE_ZERO_TARGET_ROWS')
    // The owned full-app DB has no records in any other sheet, including the
    // MVP archive/project/batch sheets from which the board directory is built.
    assert.equal((await query('SELECT count(*)::int AS count FROM meta_records WHERE sheet_id<>$1',
      [f.target.sheetId])).rows[0].count, 0, 'APP_AUTOMATION_ARCHIVE_MUST_BE_EMPTY')
  }
  await emptyProjectContext()
  const clockObservation = createAutomationClockReceiptObservation(() => performance.now())
  const detailObserver = observeOwnedDetailRequests(input.hostServer, input.hostPool, f.connectionId,
    (sql, values, result, started) => clockObservation.observe(sql, values, result, started))
  const evidence: Record<string, boolean | number> = {
    realRuleHttpCreated: true, ruleEditorDomVerified: false, manualOnly: true,
    independentOneShotPermit: true, sourceQueryObserverPassThrough: true, emptyProjectNoTargetOrArchive: true,
  }
  function samePool() {
    assert(input.getAdapter()?.isConnected() && input.getAdapter()?.pool === observedPool
      && observedPool?.query === wrappedQuery, 'APP_AUTOMATION_SOURCE_POOL_CHANGED')
  }
  async function checkpoint(command: AutomationCheckpoint) {
    assert(command && typeof command === 'object' && !Array.isArray(command), 'APP_AUTOMATION_CHECKPOINT_INVALID')
    assert(!('ruleId' in command) && command.phase !== 'interval-before-authoring', 'APP_AUTOMATION_MANUAL_CHECKPOINT_REQUIRED')
    if (command.phase === 'await-completed') {
      assert.deepEqual(Object.keys(command).sort(), ['phase', 'grantId', 'requestId'].sort())
      assert.equal(phases.length, 2, 'APP_AUTOMATION_RECOVERY_PHASE_INVALID')
      assert(!openPoll && verifiedBusyPolls === 1 && fixtureCompletionWaits === 0, 'APP_AUTOMATION_RECOVERY_BOUND')
      assert.equal(command.grantId, grantId)
      assert.equal(command.requestId, requestId)
      samePool()
      const started = performance.now()
      // Observe the existing 25s execution budget plus 5s status handoff;
      // this fixture limit does not change the worker/source budget.
      const deadline = Math.min(started + 30000, detailDeadline)
      let metadataStarted = 0, metadataCompleted = 0, metadataRejected = 0
      let rowCount = -1, attempts = -1
      let requestState: AutomationReadinessDiagnostic['requestState'] = 'unobserved'
      let consumerState: AutomationReadinessDiagnostic['consumerState'] = 'unobserved'
      let metadataError: AutomationReadinessDiagnostic['metadataError'] = 'none'
      const diagnostic = (reason: AutomationReadinessDiagnostic['reason']) => input.reportReadiness({
        reason, requestState, consumerState, metadataError, afterPoll: detailPolls,
        elapsedMs: Math.floor(performance.now() - started), rowCount, attempts,
        metadataStarted, metadataCompleted, metadataRejected,
        metadataPending: metadataStarted - metadataCompleted - metadataRejected,
        nativeCalls, nativeCompleted: completedCalls, nativeRejected: rejectedCalls,
        nativePending: nativeCalls - completedCalls - rejectedCalls,
        hostPoolTotal: input.hostPool.totalCount, hostPoolIdle: input.hostPool.idleCount,
        hostPoolWaiting: input.hostPool.waitingCount, sourcePoolTotal: observedPool!.totalCount,
        sourcePoolIdle: observedPool!.idleCount, sourcePoolWaiting: observedPool!.waitingCount,
        clockReceipts: clockObservation.snapshot().clockReceipts,
        clockRejected: clockObservation.snapshot().clockRejected,
        clockInvalid: clockObservation.snapshot().clockInvalid,
        clockMaxReceiptWaitMs: clockObservation.snapshot().clockMaxReceiptWaitMs,
        clockForwardBeyondWait: clockObservation.snapshot().clockForwardBeyondWait,
        clockBackwardBeyondWait: clockObservation.snapshot().clockBackwardBeyondWait,
        clockMaxForwardExcessMs: clockObservation.snapshot().clockMaxForwardExcessMs,
        clockMaxBackwardExcessMs: clockObservation.snapshot().clockMaxBackwardExcessMs,
      })
      diagnostic('start')
      // Sampling adds no SQL, locks or waits to the worker. The bounded 30s
      // deadline is unchanged, and no diagnostic timer survives this checkpoint.
      const diagnosticTimer = setInterval(() => diagnostic('sample'), 1000)
      diagnosticTimer.unref()
      try {
        while (true) {
          const remaining = deadline - performance.now()
          assert(remaining > 0, 'APP_AUTOMATION_RECOVERY_COMPLETION_TIMEOUT')
          let timer: ReturnType<typeof setTimeout> | undefined
          metadataStarted += 1
          const pending = query(`SELECT r.status AS request_status,r.result,c.status AS consumer_status,c.attempts
            FROM integration_automation_read_requests r JOIN meta_automation_outbox o ON o.id=r.outbox_id
            JOIN meta_automation_outbox_consumer c ON c.outbox_id=o.id
            WHERE r.id=$1 AND r.grant_id=$2 AND r.owner_id=$3 AND r.tenant_id=$4
              AND o.event_type='integration.read-preview.requested' AND c.consumer_key='integration-read-preview'`,
          [requestId, grantId, f.owner, f.tenantId])
          void pending.then(() => { metadataCompleted += 1 }, error => {
            metadataRejected += 1
            const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
            metadataError = code === '55P03' ? 'lock-unavailable' : code === '40P01' ? 'deadlock'
              : code === '57014' ? 'query-cancelled' : 'other'
          })
          let rows: Array<Record<string, unknown>>
          try {
            // The deadline bounds this fixture wait, not physical SQL cancellation.
            rows = (await Promise.race([pending, new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('APP_AUTOMATION_RECOVERY_COMPLETION_TIMEOUT')), remaining)
            })])).rows
          } finally { clearTimeout(timer) }
          assert(performance.now() < deadline, 'APP_AUTOMATION_RECOVERY_COMPLETION_TIMEOUT')
          const prior = `${requestState}/${consumerState}/${attempts}/${rowCount}`
          rowCount = rows.length
          const observed = rows[0]
          requestState = typeof observed?.request_status === 'string'
            && ['queued', 'running', 'succeeded', 'blocked', 'failed', 'cancelled', 'outcome_unknown'].includes(observed.request_status)
            ? observed.request_status as AutomationReadinessDiagnostic['requestState'] : 'invalid'
          consumerState = typeof observed?.consumer_status === 'string'
            && ['pending', 'in_progress', 'done', 'dead_letter'].includes(observed.consumer_status)
            ? observed.consumer_status as AutomationReadinessDiagnostic['consumerState'] : 'invalid'
          attempts = Number.isSafeInteger(observed?.attempts) && Number(observed.attempts) >= 0 ? Number(observed.attempts) : -1
          if (`${requestState}/${consumerState}/${attempts}/${rowCount}` !== prior) diagnostic('returned')
          assert.equal(rows.length, 1, 'APP_AUTOMATION_RECOVERY_REQUEST_REQUIRED')
          const row = rows[0]
          assert(['queued', 'running', 'succeeded'].includes(String(row.request_status)), 'APP_AUTOMATION_RECOVERY_TERMINAL_REFUSAL')
          assert(['pending', 'in_progress', 'done'].includes(String(row.consumer_status)), 'APP_AUTOMATION_RECOVERY_CONSUMER_REFUSAL')
          if (row.consumer_status === 'done') {
            assert.equal(row.request_status, 'succeeded', 'APP_AUTOMATION_RECOVERY_SUCCESS_REQUIRED')
            assert.deepEqual(row.result, expectedPreview)
            assert.equal(row.attempts, 1)
            assert(nativeCalls > 0 && completedCalls === nativeCalls, 'APP_AUTOMATION_RECOVERY_SOURCE_INCOMPLETE')
            recoveryNativeCalls = nativeCalls
            fixtureCompletionWaits = 1
            input.reportRecovery({ afterPoll: detailPolls, sameRequest: true, consumerDone: true, requestSucceeded: true,
              readOnlyFixtureWait: true, maxWaitMs: 30000, elapsedMs: Math.floor(performance.now() - started) })
            diagnostic('ready')
            return
          }
          await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - performance.now()))))
        }
      } catch (error) {
        diagnostic(performance.now() >= deadline ? 'timeout' : 'failed')
        throw error
      } finally { clearInterval(diagnosticTimer) }
    }
    if (command.phase === 'observe-begin' || command.phase === 'observe-end') {
      assert.deepEqual(Object.keys(command).sort(), ['phase', 'grantId', 'requestId', 'poll',
        ...(command.phase === 'observe-end' ? ['httpStatus'] : [])].sort(), 'APP_AUTOMATION_OBSERVATION_INVALID')
      assert([2, 3].includes(phases.length), 'APP_AUTOMATION_OBSERVATION_PHASE_INVALID')
      if (phases.length === 3) assert.equal(finalRefreshes, 0, 'APP_AUTOMATION_FINAL_REFRESH_BOUND')
      assert.equal(command.grantId, grantId)
      assert(typeof command.requestId === 'string' && /^[a-f0-9-]{36}$/.test(command.requestId))
      if (requestId) assert.equal(command.requestId, requestId)
      else requestId = command.requestId
      if (command.phase === 'observe-begin') {
        assert(!openPoll && command.poll === detailPolls + 1 && command.poll <= 60, 'APP_AUTOMATION_OBSERVATION_BOUND')
        if (!detailDeadline) detailDeadline = performance.now() + 90000
        assert(performance.now() < detailDeadline, 'APP_AUTOMATION_OBSERVATION_DEADLINE')
        detailPolls += 1
        openPoll = true
        detailObserver.begin(command.poll, command.requestId)
      } else {
        assert(openPoll && command.poll === detailPolls, 'APP_AUTOMATION_OBSERVATION_PAIR_REQUIRED')
        assert(performance.now() < detailDeadline, 'APP_AUTOMATION_OBSERVATION_DEADLINE')
        const observation = detailObserver.end(command.poll, command.httpStatus)
        input.reportObservation({ ...observation, afterCompletion: phases.length === 3 })
        assert(observation.verified, 'APP_AUTOMATION_UNCORRELATED_DETAIL_RESPONSE')
        if (command.httpStatus === 503) {
          assert(phases.length === 2 && fixtureCompletionWaits === 0, 'APP_AUTOMATION_RECOVERY_BOUND')
          verifiedBusyPolls += 1
        }
        if (phases.length === 3) finalRefreshes += 1
        openPoll = false
      }
      return
    }
    assert(!openPoll, 'APP_AUTOMATION_OBSERVATION_PAIR_REQUIRED')
    if (command.phase === 'refreshed') assert.equal(finalRefreshes, 1, 'APP_AUTOMATION_FINAL_REFRESH_REQUIRED')
    assert.deepEqual(Object.keys(command).sort(), ['phase', ...(command.grantId ? ['grantId'] : []),
      ...(command.requestId ? ['requestId'] : [])].sort(), 'APP_AUTOMATION_CHECKPOINT_INVALID')
    assert.equal(command.phase, phaseOrder[phases.length], 'APP_AUTOMATION_CHECKPOINT_ORDER')
    if (command.phase === 'before-grant') {
      await emptyProjectContext()
      assert.equal(command.grantId, undefined)
      assert.equal(command.requestId, undefined)
      assert.equal(await count('integration_automation_read_grants'), 0)
      assert.equal(await count('integration_automation_read_requests'), 0)
      observedPool = input.getAdapter()?.pool ?? undefined
      assert(observedPool && input.getAdapter()?.isConnected(), 'APP_AUTOMATION_NATIVE_POOL_REQUIRED')
      originalQuery = observedPool.query
      // Proxy invokes the original native method with the exact receiver/arguments.
      // Count only this already-established owned source pool, never host metadata SQL.
      wrappedQuery = new Proxy(originalQuery, { apply(target, receiver, args) {
        assert.equal(receiver, observedPool, 'APP_AUTOMATION_NATIVE_RECEIVER_CHANGED')
        nativeCalls += 1
        const result: unknown = Reflect.apply(target, receiver, args)
        if (result && typeof result === 'object' && 'then' in result && typeof result.then === 'function') {
          void Promise.resolve(result).then(() => { completedCalls += 1 }, () => { rejectedCalls += 1 })
        }
        return result
      } })
      observedPool.query = wrappedQuery
    } else {
      samePool()
      assert(typeof command.grantId === 'string' && /^[a-f0-9-]{36}$/.test(command.grantId), 'APP_AUTOMATION_GRANT_REQUIRED')
      if (grantId) assert.equal(command.grantId, grantId)
      else grantId = command.grantId
      const grants = (await query(`SELECT id,tenant_id,owner_id,purpose,triggers,projects,max_executions,used_executions,status
        FROM integration_automation_read_grants`)).rows
      assert.equal(grants.length, 1, 'APP_AUTOMATION_EXACT_GRANT_REQUIRED')
      const grant = grants[0]
      assert.equal(grant.id, grantId)
      assert.equal(grant.tenant_id, f.tenantId)
      assert.equal(grant.owner_id, f.owner)
      assert.equal(grant.purpose, 'standalone')
      assert.deepEqual(grant.triggers, ['manual'])
      assert.deepEqual(grant.projects, [f.projectNo])
      assert.equal(grant.max_executions, 1)
      if (command.phase === 'after-grant') {
        assert.equal(command.requestId, undefined)
        assert.equal(nativeCalls, 0, 'APP_AUTOMATION_GRANT_READ_SOURCE')
        assert.equal(grant.used_executions, 0)
        assert.equal(await count('integration_automation_read_requests'), 0)
        assert.equal((await query("SELECT count(*)::int AS count FROM meta_automation_outbox WHERE event_type='integration.read-preview.requested'")).rows[0].count, 0)
        assert.equal((await query('SELECT count(*)::int AS count FROM integration_b2a_operation_claim WHERE registration_id=$1',
          [f.b2aRegistrationIds[2]])).rows[0].count, 0)
        evidence.grantZeroSourceIo = true
        clockObservation.start()
      } else {
        assert(typeof command.requestId === 'string' && /^[a-f0-9-]{36}$/.test(command.requestId), 'APP_AUTOMATION_REQUEST_REQUIRED')
        if (requestId) assert.equal(command.requestId, requestId)
        else requestId = command.requestId
        const requests = (await query(`SELECT id,grant_id,owner_id,tenant_id,trigger_type,status,result,outbox_id
          FROM integration_automation_read_requests`)).rows
        assert.equal(requests.length, 1, 'APP_AUTOMATION_EXACT_REQUEST_REQUIRED')
        const request = requests[0]
        assert.equal(request.id, requestId)
        assert.equal(request.grant_id, grantId)
        assert.equal(request.owner_id, f.owner)
        assert.equal(request.tenant_id, f.tenantId)
        assert.equal(request.trigger_type, 'manual')
        assert.equal(request.status, 'succeeded')
        assert.deepEqual(request.result, expectedPreview)
        assert.equal(grant.used_executions, 1)
        assert.equal(grant.status, command.phase === 'revoked' ? 'revoked' : 'active')
        const delivered = (await query(`SELECT o.payload,c.status,c.attempts FROM meta_automation_outbox o
          JOIN meta_automation_outbox_consumer c ON c.outbox_id=o.id
          WHERE o.id=$1 AND o.event_type='integration.read-preview.requested' AND c.consumer_key='integration-read-preview'`,
        [request.outbox_id])).rows
        assert.equal(delivered.length, 1)
        assert.deepEqual(delivered[0].payload, { requestId })
        assert.equal(delivered[0].status, 'done', 'APP_AUTOMATION_REAL_CONSUMER_NOT_DONE')
        assert.equal(delivered[0].attempts, 1, 'APP_AUTOMATION_UNEXPECTED_REDELIVERY')
        assert.equal((await query('SELECT count(*)::int AS count FROM integration_automation_read_executions WHERE request_id=$1', [requestId])).rows[0].count, 1)
        assert.equal(nativeCalls, completedCalls, 'APP_AUTOMATION_NATIVE_QUERY_FAILED_OR_PENDING')
        assert(nativeCalls > 0, 'APP_AUTOMATION_NATIVE_SOURCE_NOT_READ')
        if (command.phase === 'completed') {
          if (recoveryNativeCalls !== undefined) assert.equal(nativeCalls, recoveryNativeCalls, 'APP_AUTOMATION_HISTORY_RECOVERY_REREAD_SOURCE')
          completedCount = nativeCalls
          evidence.realOutboxConsumerNativeSql = true
          evidence.readonlyCountsPersisted = true
        } else assert.equal(nativeCalls, completedCount, 'APP_AUTOMATION_OBSERVATION_REREAD_SOURCE')
        if (command.phase === 'refreshed') evidence.refreshZeroSourceIo = true
        if (command.phase === 'revoked') evidence.revokeZeroSourceIo = true
      }
    }
    phases.push(command.phase)
  }
  async function verify(result: ConfiguredAutomationBrowserResult) {
    assert(!openPoll && detailPolls >= 1 && detailPolls <= 60, 'APP_AUTOMATION_OBSERVATIONS_REQUIRED')
    assert.equal(result.evidence.detailPolls, detailPolls)
    assert.equal(result.evidence.verifiedBusyPolls, verifiedBusyPolls)
    assert.equal(result.evidence.fixtureCompletionWaits, fixtureCompletionWaits)
    assert.equal(result.evidence.historyRecoveries, fixtureCompletionWaits)
    assert.equal(verifiedBusyPolls, fixtureCompletionWaits)
    assert.equal(finalRefreshes, 1, 'APP_AUTOMATION_FINAL_REFRESH_REQUIRED')
    assert.equal(await count('multitable_webhooks'), 0, 'APP_AUTOMATION_NO_OUTBOUND_WEBHOOKS_REQUIRED')
    assert.equal(await count('multitable_webhook_deliveries'), 0, 'APP_AUTOMATION_NO_OUTBOUND_DELIVERIES_REQUIRED')
    assert.deepEqual(phases, phaseOrder, 'APP_AUTOMATION_CHECKPOINTS_REQUIRED')
    assert.equal(result.grantId, grantId)
    assert.equal(result.requestId, requestId)
    assert.equal(result.ruleId, ruleId)
    samePool()
    await emptyProjectContext()
    const beforeDenied = nativeCalls
    const unauthenticated = await fetch(origin + `/api/integration/automation-read/requests/${requestId}`,
      { signal: AbortSignal.timeout(10000) })
    assert.equal(unauthenticated.status, 401, 'APP_AUTOMATION_REAL_SESSION_GATE_REQUIRED')
    assert.equal(unauthenticated.headers.get('cache-control'), 'no-store')
    await unauthenticated.arrayBuffer()
    const revoked = await fetch(origin + '/api/integration/automation-read/requests', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ grantId, invocationId: randomUUID(), projectNo: f.projectNo }), signal: AbortSignal.timeout(10000),
    })
    assert.equal(revoked.status, 403, 'APP_AUTOMATION_REVOKED_SUBMIT_REFUSAL_REQUIRED')
    assert.equal(revoked.headers.get('cache-control'), 'no-store')
    const refusal = await revoked.json() as { ok: boolean; error: { code: string } }
    assert.equal(refusal.ok, false)
    assert.equal(refusal.error.code, 'AUTOMATION_READ_DENIED')
    assert.equal(nativeCalls, beforeDenied, 'APP_AUTOMATION_REFUSAL_READ_SOURCE')
    assert.equal(await count('integration_automation_read_requests'), 1)
    const automaticActivations = Number(await count('integration_automation_read_record_activations'))
      + Number(await count('integration_automation_read_schedule_activations'))
    assert.equal(automaticActivations, 0, 'APP_AUTOMATION_AUTOMATIC_ACTIVATION_FORBIDDEN')
    assert.deepEqual((await query('SELECT registration_id FROM integration_b2a_operation_claim ORDER BY registration_id')).rows,
      [...f.b2aRegistrationIds].sort().map(registration_id => ({ registration_id })), 'APP_AUTOMATION_THREE_DISTINCT_PERMITS_REQUIRED')
    assert.equal((await query("SELECT count(*)::int AS count FROM plugin_kv WHERE plugin=$1 AND key LIKE 'integration:table-action:dry-run-token:%'", [f.pluginName])).rows[0].count, 1,
      'APP_AUTOMATION_NEW_APPLY_TOKEN_FORBIDDEN')
    evidence.sessionAndRevokedRequestsDenied = true
    evidence.deniedRequestsZeroSourceIo = true
    evidence.noNewApplyToken = true
    return { ...evidence, sourceQueries: nativeCalls, sourceQueryCompletions: completedCalls,
      requests: 1, grants: 1, nativeReadOperations: 1, automaticActivations, detailPolls, verifiedBusyPolls,
      fixtureCompletionWaits, historyRecoveries: fixtureCompletionWaits, recoveryAfterFixtureCompletionOnly: true,
      requestScopedQueryObserverPassThrough: true }
  }
  let abortObserver: ReturnType<typeof observeAutomationExecutorAborts> | undefined
  try {
    // Install only after all asynchronous fixture construction has succeeded.
    // The paths come from the verifier's actual compiled-module loader plus its source map.
    abortObserver = input.reportExecutorAbort
      ? observeAutomationExecutorAborts(input.executorModulePaths ?? [], input.reportExecutorAbort) : undefined
    return { browserInput: { ruleId, sheetId: f.target.sheetId }, checkpoint, verify,
      dispose() {
        if (disposed) return
        disposed = true
        try {
          detailObserver.dispose()
          if (observedPool && originalQuery) {
            assert.equal(observedPool.query, wrappedQuery, 'APP_AUTOMATION_OBSERVER_CHANGED')
            observedPool.query = originalQuery
          }
        } finally { abortObserver?.dispose() }
      } }
  } catch (error) {
    abortObserver?.dispose()
    detailObserver.dispose()
    throw error
  }
}
