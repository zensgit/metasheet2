import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { observeOwnedDetailRequests, type createAutomationFullAppFixture } from './stock-preparation-automation-full-app-fixture'
import type { AutomationCheckpoint, AutomationCheckpointReply, ConfiguredAutomationBrowserResult } from './stock-preparation-automation-full-app-browser'

const intervalMs = 30000
const preview = { status: 'ready', canApply: false, counts: { add: 3, update: 0, skip: 0, inactive: 0, manual_confirm: 0 } }
// Exact production candidate query, observed without executing or changing it.
const candidateSql = `SELECT a.id,a.cron_config,a.trigger_type,a.interval_anchor_ms,a.date_field_confirmation FROM integration_automation_read_schedule_activations a
 JOIN integration_automation_read_grants g ON g.id=a.grant_id AND g.tenant_id=a.tenant_id AND g.owner_id=a.owner_id
 JOIN automation_rules r ON r.id=a.rule_id
 WHERE a.rule_id=$1 AND g.purpose='automatic' AND g.status='active' AND g.workspace_id IS NULL
 AND g.triggers=ARRAY['schedule']::text[] AND g.projects=ARRAY[a.project_no]::text[]
 AND g.expires_at>pg_catalog.clock_timestamp() AND g.used_executions<g.max_executions
 AND pg_catalog.to_timestamp($2::double precision/1000)>a.activated_at
 AND pg_catalog.to_timestamp($2::double precision/1000)<=pg_catalog.clock_timestamp()
 AND r.created_by=a.owner_id AND r.enabled=true AND r.integration_authority_revision=a.rule_revision
 AND r.trigger_type=a.trigger_type AND a.trigger_type=$3 AND (r.conditions IS NULL OR r.conditions='null'::jsonb)
 AND r.trigger_config=a.cron_config
 AND (a.trigger_type IN ('schedule.cron','schedule.date_field') OR (a.trigger_type='schedule.interval'
 AND pg_catalog.isfinite(r.created_at)
 AND a.interval_anchor_ms=floor(extract(epoch FROM r.created_at)*1000)))
 ORDER BY a.id LIMIT 101`.replace(/\s+/g, ' ').trim()
type Tick = { at: number; completed: boolean; rejected: boolean; ids: unknown[]; began: number }
type Input = Parameters<typeof createAutomationFullAppFixture>[0] & { reportTick(data: Record<string, unknown>): void }
const phases = ['interval-before-authoring', 'interval-authored', 'interval-preactivation-tick', 'interval-activated',
  'interval-admitted', 'interval-completed', 'interval-budget-tick', 'interval-refreshed', 'interval-revoked']

/** Only observation: rules and consent are authored by the actual logged-in DOM.
 * No producer/dispatcher calls, clock changes, new authority, or business writes. */
export async function createAutomationIntervalFullAppFixture(input: Input) {
  const { fixture: f, query } = input
  const count = async (table: string) => Number((await query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count)
  assert.equal(process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED, 'true')
  assert.equal(await count('automation_rules'), 0, 'APP_AUTOMATION_INTERVAL_NO_PRECREATED_RULE')
  assert.deepEqual((await query('SELECT tenant_id,project_id,enabled FROM automation_read_target_profiles WHERE sheet_id=$1',
    [f.target.sheetId])).rows, [{ tenant_id: f.tenantId, project_id: `${f.tenantId}:integration-core`, enabled: true }])
  const profile = (await query('SELECT target_id::text FROM automation_read_target_profiles WHERE sheet_id=$1', [f.target.sheetId])).rows[0]
  assert(typeof profile.target_id === 'string' && /^[a-f0-9-]{36}$/.test(profile.target_id))
  let ruleId = '', grantId = '', activationId = '', requestId = ''
  let anchor = 0, rule: Record<string, unknown> | undefined, activation: Record<string, unknown> | undefined
  let grantBaseline: Record<string, unknown> | undefined
  let observedPool: Pool | undefined, originalQuery: Pool['query'] | undefined, wrappedQuery: Pool['query'] | undefined
  let nativeCalls = 0, completedCalls = 0, rejectedCalls = 0, completedCount = -1
  let ordinal = 0, detailPolls = 0, detailDeadline = 0, openPoll = false, disposed = false, observationInvalid = false
  let admittedAt = 0, terminalAt = 0
  const ticks: Tick[] = []
  const observer = observeOwnedDetailRequests(input.hostServer, input.hostPool, f.connectionId, (sql, values, result) => {
    if (typeof sql !== 'string' || sql.replace(/\s+/g, ' ').trim() !== candidateSql
      || !Array.isArray(values) || values[0] !== ruleId || !ruleId) return
    // Side-observation never changes the original method's arguments, promise,
    // exception, callback order or returned rows. Invalid evidence fails later.
    if (values.length !== 3 || values[2] !== 'schedule.interval' || !Number.isSafeInteger(values[1])
      || ticks.length >= 16 || !result || typeof result !== 'object' || !('then' in result)
      || typeof result.then !== 'function') { observationInvalid = true; return }
    const tick: Tick = { at: values[1], began: performance.now(), completed: false, rejected: false, ids: [] }
    ticks.push(tick)
    void Promise.resolve(result).then((value: unknown) => {
      tick.completed = true
      if (!value || typeof value !== 'object' || !('rows' in value) || !Array.isArray(value.rows)) { observationInvalid = true; return }
      tick.ids = value.rows.map((row: { id?: unknown }) => row?.id)
    }, () => { tick.rejected = true })
  })
  async function emptyContext() {
    assert.equal((await query('SELECT count(*)::int AS count FROM meta_records WHERE sheet_id=$1 AND data->>$2=$3',
      [f.target.sheetId, f.target.fieldIdMap.projectNo, f.projectNo])).rows[0].count, 0)
    assert.equal((await query('SELECT count(*)::int AS count FROM meta_records WHERE sheet_id<>$1', [f.target.sheetId])).rows[0].count, 0)
  }
  function samePool() {
    assert(observedPool && input.getAdapter()?.pool === observedPool && input.getAdapter()?.isConnected()
      && observedPool.query === wrappedQuery, 'APP_AUTOMATION_INTERVAL_SOURCE_POOL_CHANGED')
    assert(!observationInvalid && ticks.every(tick => !tick.rejected), 'APP_AUTOMATION_INTERVAL_OBSERVATION_INVALID')
  }
  async function readRule() {
    const rows = (await query(`SELECT id,created_by,enabled,trigger_type,trigger_config,conditions,action_type,action_config,actions,
      execution_mode,integration_authority_revision::text AS rule_revision,
      floor(extract(epoch FROM created_at)*1000)::text AS anchor FROM automation_rules WHERE sheet_id=$1`, [f.target.sheetId])).rows
    assert.equal(rows.length, 1, 'APP_AUTOMATION_INTERVAL_EXACT_RULE_REQUIRED')
    const row = rows[0]
    assert.equal(row.id, ruleId); assert.equal(row.created_by, f.owner); assert.equal(row.enabled, true)
    assert.equal(row.trigger_type, 'schedule.interval'); assert.deepEqual(row.trigger_config, { intervalMs })
    assert.equal(row.conditions, null); assert.equal(row.execution_mode, null)
    assert.equal(row.action_type, 'integration_read_preview')
    assert.deepEqual(row.action_config, { operation: 'plm.stock-preparation.diff-preview.v1', allowManual: false })
    assert.deepEqual(row.actions, [{ type: row.action_type, config: row.action_config }])
    assert(typeof row.rule_revision === 'string' && /^[a-f0-9-]{36}$/.test(row.rule_revision))
    assert(Number.isSafeInteger(Number(row.anchor)) && Number(row.anchor) > 0)
    if (rule) assert.deepEqual(row, rule, 'APP_AUTOMATION_INTERVAL_RULE_CHANGED')
    return row
  }
  async function grantState(expectedUsed: number, revoked = false) {
    assert.deepEqual(await readRule(), rule)
    const rows = (await query(`SELECT id,tenant_id,workspace_id,owner_id,purpose,status,selector,source_reference,authority_key,
      projects,triggers,budget,expires_at,max_executions,used_executions,
      expires_at>pg_catalog.clock_timestamp() AS unexpired FROM integration_automation_read_grants`)).rows
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.equal(row.id, grantId); assert.equal(row.tenant_id, f.tenantId); assert.equal(row.workspace_id, null)
    assert.equal(row.owner_id, f.owner); assert.equal(row.purpose, 'automatic')
    assert.equal(row.status, revoked ? 'revoked' : 'active'); assert.equal(row.unexpired, true)
    assert.deepEqual(row.projects, [f.projectNo]); assert.deepEqual(row.triggers, ['schedule'])
    assert.equal(row.max_executions, 1); assert.equal(row.used_executions, expectedUsed)
    assert.deepEqual(row.selector, { ruleId, actionId: f.actionId, systemId: f.systemId, targetId: profile.target_id })
    const stable = { ...row, status: 'active', used_executions: 0 }
    if (grantBaseline) assert.deepEqual(stable, grantBaseline, 'APP_AUTOMATION_INTERVAL_AUTHORITY_CHANGED')
    else grantBaseline = stable
    const activated = (await query(`SELECT id,activation_key,grant_id,tenant_id,owner_id,rule_id,rule_revision::text,
      project_no,trigger_type,cron_config,interval_anchor_ms::text,date_field_confirmation,activated_at
      FROM integration_automation_read_schedule_activations`)).rows
    assert.equal(activated.length, 1)
    const a = activated[0]
    assert.equal(a.id, activationId); assert.equal(a.grant_id, grantId); assert.equal(a.tenant_id, f.tenantId)
    assert.equal(a.owner_id, f.owner); assert.equal(a.rule_id, ruleId); assert.equal(a.rule_revision, rule!.rule_revision)
    assert.equal(a.project_no, f.projectNo); assert.equal(a.trigger_type, 'schedule.interval')
    assert.deepEqual(a.cron_config, { intervalMs }); assert.equal(Number(a.interval_anchor_ms), anchor)
    assert.equal(a.date_field_confirmation, null)
    if (activation) assert.deepEqual(a, activation, 'APP_AUTOMATION_INTERVAL_ACTIVATION_CHANGED')
    else activation = a
    assert.equal(await count('integration_automation_read_record_activations'), 0)
  }
  async function noAdmission() {
    assert.equal(nativeCalls, 0); assert.equal(await count('integration_automation_read_requests'), 0)
    assert.equal((await query("SELECT count(*)::int AS count FROM meta_automation_outbox WHERE event_type='integration.read-preview.requested'")).rows[0].count, 0)
    assert.equal((await query('SELECT count(*)::int AS count FROM integration_b2a_operation_claim WHERE registration_id=$1',
      [f.b2aRegistrationIds[2]])).rows[0].count, 0)
  }
  async function bounded<T>(limit: number, work: (deadline: number) => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([work(performance.now() + limit), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('APP_AUTOMATION_INTERVAL_WAIT_TIMEOUT')), limit)
    })]) } finally { clearTimeout(timer) }
  }
  const pause = () => new Promise(resolve => setTimeout(resolve, 100))
  function aligned(tick: Tick) { return tick.at > anchor && (tick.at - anchor) % intervalMs === 0 }
  async function terminal(revoked = false) {
    await grantState(1, revoked)
    const rows = (await query(`SELECT r.id,r.grant_id,r.tenant_id,r.owner_id,r.project_no,r.trigger_type,r.invocation_id,r.status,r.result,
      r.fence,r.started_at,r.finished_at,o.event_type,o.event_id,o.payload,c.status AS consumer_status,c.attempts,
      c.fence::text AS consumer_fence,c.lease_expires_at
      FROM integration_automation_read_requests r JOIN meta_automation_outbox o ON o.id=r.outbox_id
      JOIN meta_automation_outbox_consumer c ON c.outbox_id=o.id AND c.consumer_key='integration-read-preview'`)).rows
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.equal(row.id, requestId); assert.equal(row.grant_id, grantId); assert.equal(row.tenant_id, f.tenantId)
    assert.equal(row.owner_id, f.owner); assert.equal(row.project_no, f.projectNo); assert.equal(row.trigger_type, 'schedule')
    assert.equal(row.invocation_id, 'schedule-read:' + createHash('sha256').update(JSON.stringify([
      activationId, 'schedule.interval', new Date(admittedAt).toISOString(),
    ])).digest('hex'))
    assert.equal(row.status, 'succeeded'); assert.deepEqual(row.result, preview)
    assert(row.fence && row.started_at && row.finished_at)
    assert.equal(row.event_type, 'integration.read-preview.requested'); assert.equal(row.event_id, 'integration-read:' + requestId)
    assert.deepEqual(row.payload, { requestId }); assert.equal(row.consumer_status, 'done')
    assert.equal(row.attempts, 1); assert.equal(row.consumer_fence, '1'); assert.equal(row.lease_expires_at, null)
    assert.equal(await count('integration_automation_read_requests'), 1)
    assert.equal((await query("SELECT count(*)::int AS count FROM meta_automation_outbox WHERE event_type='integration.read-preview.requested'")).rows[0].count, 1)
    assert.equal((await query('SELECT count(*)::int AS count FROM integration_automation_read_executions WHERE request_id=$1', [requestId])).rows[0].count, 1)
    assert(nativeCalls > 0 && nativeCalls === completedCalls && rejectedCalls === 0)
    if (completedCount >= 0) assert.equal(nativeCalls, completedCount, 'APP_AUTOMATION_INTERVAL_REREAD_SOURCE')
  }
  async function checkpoint(command: AutomationCheckpoint): Promise<AutomationCheckpointReply> {
    if (command.phase === 'observe-begin' || command.phase === 'observe-end') {
      assert.equal(ordinal, 7); assert.equal(command.grantId, grantId); assert.equal(command.requestId, requestId)
      assert.deepEqual(Object.keys(command).sort(), ['phase', 'grantId', 'requestId', 'poll',
        ...(command.phase === 'observe-end' ? ['httpStatus'] : [])].sort())
      samePool()
      if (command.phase === 'observe-begin') {
        assert(!openPoll && command.poll === detailPolls + 1 && command.poll <= 2)
        if (!detailDeadline) detailDeadline = performance.now() + 90000
        assert(performance.now() < detailDeadline)
        detailPolls++; openPoll = true; observer.begin(command.poll, requestId)
      } else {
        assert(openPoll && command.poll === detailPolls && performance.now() < detailDeadline)
        const result = observer.end(command.poll, command.httpStatus)
        input.reportObservation({ ...result, afterCompletion: true })
        assert(result.verified && result.httpStatus === 200, 'APP_AUTOMATION_INTERVAL_DETAIL_REFUSED')
        openPoll = false
      }
      return
    }
    assert.equal(command.phase, phases[ordinal], 'APP_AUTOMATION_INTERVAL_CHECKPOINT_ORDER')
    assert(!openPoll)
    const keys = ordinal === 0 ? ['phase'] : ordinal < 3 ? ['phase', 'ruleId']
      : ordinal < 5 ? ['phase', 'ruleId', 'activationId', 'grantId'] : ['phase', 'ruleId', 'activationId', 'grantId', 'requestId']
    assert.deepEqual(Object.keys(command).sort(), keys.sort())
    if ('ruleId' in command) {
      assert(typeof command.ruleId === 'string' && command.ruleId.length > 0)
      if (ruleId) assert.equal(command.ruleId, ruleId); else ruleId = command.ruleId
    }
    if ('activationId' in command) {
      if (activationId) assert.equal(command.activationId, activationId); else activationId = command.activationId
      if (grantId) assert.equal(command.grantId, grantId); else grantId = command.grantId
    }
    if ('requestId' in command) assert.equal(command.requestId, requestId)
    if (ordinal === 0) {
      await emptyContext(); assert.equal(await count('automation_rules'), 0)
      assert.equal(await count('integration_automation_read_grants'), 0); await noAdmission()
      observedPool = input.getAdapter()?.pool ?? undefined
      assert(observedPool && input.getAdapter()?.isConnected())
      originalQuery = observedPool.query
      wrappedQuery = new Proxy(originalQuery, { apply(target, receiver, args) {
        nativeCalls++
        const result: unknown = Reflect.apply(target, receiver, args)
        if (result && typeof result === 'object' && 'then' in result && typeof result.then === 'function') {
          void Promise.resolve(result).then(() => { completedCalls++ }, () => { rejectedCalls++ })
        }
        return result
      } })
      observedPool.query = wrappedQuery
    } else {
      samePool()
      if (ordinal === 1) { rule = await readRule(); anchor = Number(rule.anchor); await noAdmission() }
      if (ordinal === 2 || ordinal === 6) {
        const started = performance.now(), after = ticks.length
        const tick = await bounded(35000, async deadline => {
          while (performance.now() < deadline) {
            samePool()
            const next = ticks.slice(after).find(value => value.completed && (ordinal !== 6 || value.began > terminalAt))
            if (next) return next
            await pause()
          }
          throw new Error('APP_AUTOMATION_INTERVAL_NATURAL_TICK_TIMEOUT')
        })
        assert(aligned(tick)); assert.deepEqual(tick.ids, []); assert.deepEqual(await readRule(), rule)
        assert.equal((await query('SELECT pg_catalog.to_timestamp($1::double precision/1000)<=pg_catalog.clock_timestamp() AS due',
          [tick.at])).rows[0]?.due, true, 'APP_AUTOMATION_INTERVAL_TICK_NOT_DUE')
        if (ordinal === 2) { await noAdmission(); assert.equal(await count('integration_automation_read_grants'), 0) }
        else { assert(tick.at > admittedAt); await terminal() }
        input.reportTick({ phase: ordinal === 2 ? 'preactivation' : 'budget-exhausted', intervalMs, maxWaitMs: 35000,
          elapsedMs: Math.floor(performance.now() - started), realCandidateQueries: 1, returnedCandidates: 0,
          phaseAligned: true, plannedDueByDatabase: true, ruleUnchanged: true, grantActiveAndUnexpired: ordinal === 6,
          maxExecutions: ordinal === 6 ? 1 : 0, usedExecutions: ordinal === 6 ? 1 : 0,
          requests: ordinal === 6 ? 1 : 0, sourceOperations: ordinal === 6 ? 1 : 0,
          afterTerminal: ordinal === 6, sourceQueries: nativeCalls })
      }
      if (ordinal === 3) { await grantState(0); await noAdmission() }
      if (ordinal === 4) {
        const started = performance.now()
        await bounded(35000, async deadline => {
          while (performance.now() < deadline) {
            samePool()
            const rows = (await query('SELECT id,invocation_id FROM integration_automation_read_requests WHERE grant_id=$1', [grantId])).rows
            assert(rows.length <= 1)
            if (rows.length === 1) {
              const tick = ticks.find(value => value.completed && value.ids.length === 1 && value.ids[0] === activationId
                && 'schedule-read:' + createHash('sha256').update(JSON.stringify([activationId, 'schedule.interval',
                  new Date(value.at).toISOString()])).digest('hex') === rows[0].invocation_id)
              assert(tick && aligned(tick),
                'APP_AUTOMATION_INTERVAL_ORIGINAL_OCCURRENCE_REQUIRED')
              assert.equal((await query(`SELECT pg_catalog.to_timestamp($2::double precision/1000)>activated_at
                AND pg_catalog.to_timestamp($2::double precision/1000)<=pg_catalog.clock_timestamp() AS applicable
                FROM integration_automation_read_schedule_activations WHERE id=$1`, [activationId, tick.at])).rows[0]?.applicable, true)
              admittedAt = tick.at; requestId = String(rows[0].id)
              return
            }
            await pause()
          }
          throw new Error('APP_AUTOMATION_INTERVAL_ADMISSION_TIMEOUT')
        })
        input.reportTick({ phase: 'admitted', intervalMs, maxWaitMs: 35000, elapsedMs: Math.floor(performance.now() - started),
          realCandidateQueries: 1, returnedCandidates: 1, phaseAligned: true, plannedDueByDatabase: true,
          strictlyAfterActivation: true, invocationHashMatched: true })
      }
      if (ordinal === 5) {
        const started = performance.now()
        await bounded(30000, async deadline => {
          while (performance.now() < deadline) {
            samePool()
            const rows = (await query(`SELECT r.status,c.status AS consumer_status,c.attempts FROM integration_automation_read_requests r
              JOIN meta_automation_outbox_consumer c ON c.outbox_id=r.outbox_id AND c.consumer_key='integration-read-preview'
              WHERE r.id=$1 AND r.grant_id=$2`, [requestId, grantId])).rows
            assert.equal(rows.length, 1)
            assert(['queued', 'running', 'succeeded'].includes(String(rows[0].status)))
            assert(['pending', 'in_progress', 'done'].includes(String(rows[0].consumer_status)))
            if (rows[0].consumer_status === 'done') { await terminal(); completedCount = nativeCalls; terminalAt = performance.now(); return }
            await pause()
          }
          throw new Error('APP_AUTOMATION_INTERVAL_COMPLETION_TIMEOUT')
        })
        input.reportTick({ phase: 'completed', maxWaitMs: 30000, elapsedMs: Math.floor(performance.now() - started),
          sameRequest: true, consumerDone: true, consumerAttempts: 1, requestSucceeded: true, readOnlyFixtureWait: true })
      }
      if (ordinal >= 7) { assert.equal(detailPolls, 2); await terminal(ordinal === 8) }
    }
    ordinal++
    if (command.phase === 'interval-admitted') return { requestId }
  }
  async function verify(result: ConfiguredAutomationBrowserResult) {
    assert.equal(ordinal, phases.length); assert(!openPoll && detailPolls === 2)
    assert.equal(result.ruleId, ruleId); assert.equal(result.grantId, grantId); assert.equal(result.requestId, requestId)
    samePool(); await emptyContext(); await terminal(true)
    assert.equal(await count('multitable_webhooks'), 0); assert.equal(await count('multitable_webhook_deliveries'), 0)
    assert.deepEqual((await query('SELECT registration_id FROM integration_b2a_operation_claim ORDER BY registration_id')).rows,
      [...f.b2aRegistrationIds].sort().map(registration_id => ({ registration_id })))
    assert.equal((await query("SELECT count(*)::int AS count FROM plugin_kv WHERE plugin=$1 AND key LIKE 'integration:table-action:dry-run-token:%'",
      [f.pluginName])).rows[0].count, 1)
    const denied = await fetch(input.origin + `/api/integration/automation-read/requests/${requestId}`, { signal: AbortSignal.timeout(10000) })
    assert.equal(denied.status, 401); assert.equal(denied.headers.get('cache-control'), 'no-store'); await denied.arrayBuffer()
    const revoked = await fetch(input.origin + '/api/integration/automation-read/requests', { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${input.ownerToken}` },
      body: JSON.stringify({ grantId, invocationId: randomUUID(), projectNo: f.projectNo }), signal: AbortSignal.timeout(10000) })
    assert.equal(revoked.status, 403); assert.deepEqual(await revoked.json(), { ok: false, error: { code: 'AUTOMATION_READ_DENIED' } })
    assert.equal(nativeCalls, completedCount); assert.equal(await count('integration_automation_read_requests'), 1)
    return { ruleEditorDomVerified: true, independentOneShotPermit: true, emptyProjectNoTargetOrArchive: true,
      ruleRevisionConfigAnchorOwnerVerified: true, activationBoundToRule: true, realNaturalSchedule: true,
      preactivationTickZeroSourceIo: true, exhaustedActiveGrantTickZeroSourceIo: true,
      realOutboxConsumerNativeSql: true, readonlyCountsPersisted: true, refreshZeroSourceIo: true, revokeZeroSourceIo: true,
      sessionAndRevokedRequestsDenied: true, deniedRequestsZeroSourceIo: true, noNewApplyToken: true,
      sourceQueryObserverPassThrough: true, requestScopedQueryObserverPassThrough: true, candidateQueryObserverPassThrough: true,
      requests: 1, grants: 1, automaticActivations: 1, nativeReadOperations: 1, detailPolls, sourceQueries: nativeCalls,
      sourceQueryCompletions: completedCalls, naturalTickNegatives: 2, maxExecutions: 1, usedExecutions: 1,
      historyAfterFixtureCompletionOnly: true }
  }
  return { browserInput: { scenario: 'interval' as const, ruleId: '', sheetId: f.target.sheetId }, checkpoint, verify,
    dispose() {
      if (disposed) return
      disposed = true; observer.dispose()
      if (observedPool && originalQuery) {
        assert.equal(observedPool.query, wrappedQuery); observedPool.query = originalQuery
        assert.equal(observedPool.query, originalQuery)
      }
    } }
}
