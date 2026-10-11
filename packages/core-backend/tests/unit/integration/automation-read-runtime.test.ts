/** Lifecycle/cancellation unit evidence only. Authority and native source proof
 * live in the real-PG authority suite, not these explicit lifecycle doubles. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { performance } from 'node:perf_hooks'
import { readFileSync } from 'node:fs'
import { ModuleKind, transpileModule } from 'typescript'
import type { AutomationReadRuntimeBinding } from '../../../src/integration/automation-read-runtime'
import type { AutomationReadExecutorOptions } from '../../../src/integration/automation-read-executor'
import type { AutomationReadLedgerDependencies } from '../../../src/integration/automation-read-contracts'
import { AutomationReadLedgerError } from '../../../src/integration/automation-read-contracts'
import { AutomationActorAuthorityError } from '../../../src/integration/automation-live-authority'
import { createAutomationReadScheduleObservation } from '../../utils/automation-read-schedule-observation'

const doubles = vi.hoisted(() => ({ activate: vi.fn(), renew: vi.fn(), deactivate: vi.fn(), execute: vi.fn(), executorOptions: vi.fn(),
  executorDrains: [] as Array<ReturnType<typeof vi.fn>>, grant: vi.fn(), submit: vi.fn(), retry: vi.fn(), options: vi.fn(),
  activateRecord: vi.fn(), submitRecord: vi.fn(), candidates: vi.fn(),
  activateSchedule: vi.fn(), submitSchedule: vi.fn(), submitDateSchedulePage: vi.fn(), scheduleCandidates: vi.fn(), scheduleClock: vi.fn() }))
vi.mock('../../../src/integration/automation-read-profiles', () => ({
  activateAutomationReadProfiles: doubles.activate, renewAutomationReadProducer: doubles.renew,
  deactivateAutomationReadProducer: doubles.deactivate,
}))
vi.mock('../../../src/integration/automation-read-authority', () => ({ createAutomationReadAuthority: () => ({}) }))
vi.mock('../../../src/integration/automation-read-ledger', () => ({ createAutomationReadLedger: () => ({ grant: doubles.grant, submit: doubles.submit, retry: doubles.retry,
  activateRecord: doubles.activateRecord, submitRecord: doubles.submitRecord,
  activateSchedule: doubles.activateSchedule, submitSchedule: doubles.submitSchedule, submitDateSchedulePage: doubles.submitDateSchedulePage }) }))
vi.mock('../../../src/integration/automation-read-record-activation', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/integration/automation-read-record-activation')>(), findAutomationReadRecordCandidates: doubles.candidates,
}))
vi.mock('../../../src/integration/automation-read-schedule-activation', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/integration/automation-read-schedule-activation')>(),
  findAutomationReadScheduleCandidates: doubles.scheduleCandidates, waitForReadScheduleDbClock: doubles.scheduleClock,
}))
vi.mock('../../../src/integration/automation-read-discovery', () => ({ createAutomationReadDiscovery: () => ({ options: doubles.options }) }))
vi.mock('../../../src/integration/automation-read-executor', () => ({ createAutomationReadExecutor: (options: AutomationReadExecutorOptions) => {
  doubles.executorOptions(options)
  const drainPendingWork = vi.fn(async () => {})
  doubles.executorDrains.push(drainPendingWork)
  return { execute: doubles.execute, drainPendingWork }
} }))
import { createAutomationReadRuntime } from '../../../src/integration/automation-read-runtime'

const producer = { generation: '1', nonce: '11111111-1111-4111-8111-111111111111' }
const opaque = '11111111-1111-4111-8111-111111111112'
const uncalled = () => { throw new Error('Must not invoke lifecycle-only fixture capability') }
const scheduleSql = {
  candidate: `SELECT a.id,a.cron_config,a.trigger_type,a.interval_anchor_ms FROM integration_automation_read_schedule_activations a
    JOIN integration_automation_read_grants g ON g.id=a.grant_id WHERE a.rule_id=$1 ORDER BY a.id LIMIT 101`,
  activation: 'SELECT * FROM integration_automation_read_schedule_activations WHERE id=$1 FOR SHARE NOWAIT',
  grant: 'SELECT * FROM integration_automation_read_grants WHERE id = $1 FOR UPDATE NOWAIT',
  clock: 'SELECT extract(epoch FROM clock_timestamp()) * 1000 AS now_ms',
  cutover: `SELECT pg_catalog.to_timestamp($2::double precision/1000)>activated_at AS applicable
    FROM integration_automation_read_schedule_activations WHERE id=$1`,
  duplicate: `SELECT * FROM integration_automation_read_requests
    WHERE grant_id = $1 AND invocation_id = $2 FOR UPDATE NOWAIT`,
  reservation: `SELECT count(*)::int AS count FROM integration_automation_read_requests
    WHERE grant_id = $1 AND status = 'queued'`,
  insert: `INSERT INTO integration_automation_read_requests
    (id,grant_id,tenant_id,workspace_id,owner_id,invocation_id,project_no,trigger_type)
    VALUES ($1,$2,$3,NULL,$4,$5,$6,$7)`,
}

describe('test-only values-free schedule SQL observation', () => {
  it('recognizes the ledger/candidate SQL stages without mutating any original receipt', () => {
    const observer = createAutomationReadScheduleObservation(), transaction = observer.startTransaction()
    const receipts = [
      { sql: scheduleSql.candidate, result: { rows: [{ id: opaque, cron_config: { expression: '* * * * *' } }] } },
      { sql: scheduleSql.activation, result: { rows: [{ id: opaque, activated_at: new Date(), owner_id: 'private-owner' }] } },
      { sql: scheduleSql.grant, result: { rows: [{ status: 'active', purpose: 'automatic', triggers: ['schedule'],
        projects: ['private-project'], used_executions: 0, max_executions: 1, authority_key: 'private-key' }] } },
      { sql: scheduleSql.clock, result: { rows: [{ now_ms: '1700000000000.125' }] } },
      { sql: scheduleSql.cutover, result: { rows: [{ applicable: true }] } },
      { sql: scheduleSql.duplicate, result: { rows: [] } },
      { sql: scheduleSql.reservation, result: { rows: [{ count: 0 }] } },
      { sql: scheduleSql.insert, result: { rows: [], rowCount: 1 } },
      { sql: scheduleSql.clock, result: { rows: [{ now_ms: '1700000000001.375' }] } },
    ]
    const original = JSON.stringify(receipts)
    for (const { sql, result } of receipts) expect(transaction.observe(sql, result)).toBeUndefined()
    expect(observer.snapshot().transactions[0].outcome).toBe('pending')
    // Only the owner of the actual COMMIT receipt may mark this commit.
    transaction.finish(true)
    expect(JSON.stringify(receipts)).toBe(original)
    expect(observer.snapshot()).toEqual({ overflow: false, transactions: [{ overflow: false, outcome: 'commit', stages: [
      { stage: 'candidate', rows: 1 }, { stage: 'activation', rows: 1 },
      { stage: 'grant', rows: 1, active: true, automatic: true, scheduleOnly: true, singleProject: true, used: 0, maximum: 1 },
      { stage: 'clock', rows: 1, elapsedMs: 0 }, { stage: 'cutover', rows: 1, applicable: true },
      { stage: 'duplicate', rows: 0 }, { stage: 'reservation', rows: 1, count: 0 },
      { stage: 'request-insert', rows: 0, count: 1 }, { stage: 'clock', rows: 1, elapsedMs: 1.25 },
    ] }] })
    const json = JSON.stringify(observer.snapshot())
    for (const secret of [opaque, 'private-owner', 'private-project', 'private-key', '1700000000000', '* * * * *', 'SELECT', '$1']) {
      expect(json).not.toContain(secret)
    }
  })
  it('keeps ordinary/renewal transactions out of the schedule trace', () => {
    const observer = createAutomationReadScheduleObservation(), transaction = observer.startTransaction()
    for (const sql of [scheduleSql.grant, scheduleSql.clock, scheduleSql.duplicate, scheduleSql.reservation, scheduleSql.insert,
      'SELECT * FROM integration_automation_read_record_activations WHERE id=$1',
      'SELECT generation::text, nonce::text FROM automation_read_producer_slot WHERE slot_id=1 FOR UPDATE NOWAIT']) {
      transaction.observe(sql, { rows: [{ count: 1 }] })
    }
    transaction.finish(false, new AutomationReadLedgerError('AUTOMATION_READ_DENIED'))
    expect(observer.snapshot()).toEqual({ overflow: false, transactions: [] })
  })
  it.each(['AUTOMATION_READ_DENIED', 'AUTOMATION_READ_BUDGET_EXHAUSTED', 'AUTOMATION_ACTOR_AUTHORITY_DENIED', '55P03'])('records rejection with fixed code %s, not error details or a rollback claim', code => {
    const observer = createAutomationReadScheduleObservation(), transaction = observer.startTransaction()
    transaction.observe(scheduleSql.activation, { rows: [] })
    transaction.finish(false, Object.assign(new Error('private credential'), { code, cause: 'private endpoint' }))
    expect(observer.snapshot()).toEqual({ overflow: false, transactions: [{ overflow: false, outcome: 'rejected',
      errorCode: code, stages: [{ stage: 'activation', rows: 0 }] }] })
  })
  it('marks a lost COMMIT response rejected without claiming the already durable insert rolled back', async () => {
    const observer = createAutomationReadScheduleObservation(), transaction = observer.startTransaction()
    let durableInsert = false
    transaction.observe(scheduleSql.activation, { rows: [] })
    transaction.observe(scheduleSql.insert, { rows: [], rowCount: 1 })
    // Explicit receipt-loss double, not database evidence: COMMIT takes effect,
    // but the caller's transaction Promise cannot obtain its successful reply.
    const committedButReplyLost = async () => {
      durableInsert = true
      throw new Error('private COMMIT connection details')
    }
    try { await committedButReplyLost(); transaction.finish(true) }
    catch (error) { transaction.finish(false, error) }
    expect(durableInsert).toBe(true)
    expect(observer.snapshot()).toEqual({ overflow: false, transactions: [{ overflow: false, outcome: 'rejected',
      errorCode: 'unknown', stages: [{ stage: 'activation', rows: 0 }, { stage: 'request-insert', rows: 0, count: 1 }] }] })
    expect(JSON.stringify(observer.snapshot())).not.toContain('rollback')
    expect(JSON.stringify(observer.snapshot())).not.toContain('private')
  })
  it('collapses unknown/inherited/accessor errors without invoking or leaking their hooks', () => {
    const observer = createAutomationReadScheduleObservation(), getter = vi.fn(() => 'AUTOMATION_READ_DENIED')
    for (const error of [{ code: 'private-value', message: 'private SQL' }, Object.create({ code: 'AUTOMATION_READ_DENIED' }),
      Object.defineProperty({}, 'code', { get: getter }), new Error('private-value'), null]) {
      const transaction = observer.startTransaction()
      transaction.observe(scheduleSql.candidate, { rows: [] })
      transaction.finish(false, error)
    }
    expect(observer.snapshot().transactions.map(trace => trace.errorCode)).toEqual(Array(5).fill('unknown'))
    expect(JSON.stringify(observer.snapshot())).not.toContain('private')
    expect(getter).not.toHaveBeenCalled()
  })
  it('does not invoke receipt getters or adopt malformed/private numbers', () => {
    const observer = createAutomationReadScheduleObservation(), transaction = observer.startTransaction()
    const getter = vi.fn(() => [{ now_ms: 1700000000000 }])
    transaction.observe(scheduleSql.activation, { rows: [] })
    transaction.observe(scheduleSql.clock, Object.defineProperty({}, 'rows', { get: getter }))
    transaction.observe(scheduleSql.clock, { rows: [{ now_ms: 'private' }] })
    transaction.observe(scheduleSql.reservation, { rows: [{ count: -1 }] })
    transaction.observe(scheduleSql.cutover, { rows: [Object.defineProperty({}, 'applicable', { get: getter })] })
    transaction.finish(true)
    expect(getter).not.toHaveBeenCalled()
    expect(observer.snapshot().transactions[0].stages).toEqual([
      { stage: 'activation', rows: 0 }, { stage: 'clock' }, { stage: 'clock', rows: 1 },
      { stage: 'reservation', rows: 1 }, { stage: 'cutover', rows: 1 },
    ])
  })
  it('bounds stages and all relevant pending/completed transactions with explicit overflow', () => {
    const observer = createAutomationReadScheduleObservation({ maxTransactions: 2, maxStagesPerTransaction: 2 })
    const first = observer.startTransaction()
    first.observe(scheduleSql.activation, { rows: [] })
    first.observe(scheduleSql.clock, { rows: [{ now_ms: 1700000000000 }] })
    first.observe(scheduleSql.reservation, { rows: [{ count: 1 }] })
    const second = observer.startTransaction()
    second.observe(scheduleSql.candidate, { rows: [] })
    const dropped = observer.startTransaction()
    for (let index = 0; index < 100; index++) dropped.observe(scheduleSql.activation, { rows: [] })
    dropped.finish(false, new Error('private'))
    first.finish(true); second.finish(false)
    expect(observer.snapshot()).toEqual({ overflow: true, transactions: [
      { overflow: true, outcome: 'commit', stages: [{ stage: 'activation', rows: 0 }, { stage: 'clock', rows: 1, elapsedMs: 0 }] },
      { overflow: false, outcome: 'rejected', errorCode: 'unknown', stages: [{ stage: 'candidate', rows: 0 }] },
    ] })
  })
  it('returns detached snapshots and finish/observe after completion cannot change the receipt', () => {
    const observer = createAutomationReadScheduleObservation(), transaction = observer.startTransaction()
    const result = { rows: [{ applicable: true }] }
    transaction.observe(scheduleSql.activation, { rows: [] }); transaction.observe(scheduleSql.cutover, result)
    transaction.finish(true); result.rows[0].applicable = false
    const snapshot = observer.snapshot()
    snapshot.transactions[0].outcome = 'rejected'
    snapshot.transactions[0].stages[1].applicable = false
    snapshot.transactions.splice(0)
    transaction.finish(false, { code: 'AUTOMATION_READ_DENIED' })
    transaction.observe(scheduleSql.candidate, { rows: [] })
    expect(observer.snapshot()).toEqual({ overflow: false, transactions: [{ overflow: false, outcome: 'commit',
      stages: [{ stage: 'activation', rows: 0 }, { stage: 'cutover', rows: 1, applicable: true }] }] })
  })
  it.each([0, -1, 129, 1.5, Number.POSITIVE_INFINITY])('rejects unbounded observer limits (%s) with a fixed message', value => {
    expect(() => createAutomationReadScheduleObservation({ maxTransactions: value })).toThrow('SCHEDULE_OBSERVATION_LIMIT_INVALID')
    expect(() => createAutomationReadScheduleObservation({ maxStagesPerTransaction: value })).toThrow('SCHEDULE_OBSERVATION_LIMIT_INVALID')
  })
})

function binding(): AutomationReadRuntimeBinding {
  return { prepareProfiles: () => [{} as never], codec: { restoreStockPreparationAutomationProfileMaterial: uncalled,
    deriveAutomationReadTargetContract: uncalled, composeStockPreparationAutomationExecution: uncalled },
  sourceStore: { lockActiveForAutomation: async () => uncalled() }, preview: async () => uncalled() }
}
describe('host-private Automation runtime lifecycle', () => {
  const runtimes: ReturnType<typeof createAutomationReadRuntime>[] = []
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks()
    doubles.executorDrains.splice(0)
    doubles.activate.mockResolvedValue({ producer, targets: [] })
    doubles.renew.mockResolvedValue(undefined); doubles.deactivate.mockResolvedValue(undefined)
    doubles.execute.mockResolvedValue({ requestId: opaque, status: 'succeeded' })
    doubles.options.mockResolvedValue({ items: [], nextCursor: null })
    doubles.candidates.mockResolvedValue([])
    doubles.submitRecord.mockResolvedValue({ requestId: opaque, status: 'queued' })
    doubles.scheduleCandidates.mockResolvedValue([])
    doubles.scheduleClock.mockResolvedValue(undefined)
    doubles.activateSchedule.mockResolvedValue({ activationId: opaque, grantId: producer.nonce })
    doubles.submitSchedule.mockResolvedValue({ requestId: opaque, status: 'queued' })
    doubles.submitDateSchedulePage.mockReset().mockResolvedValue({ nextCursor: null, scanned: 0 })
    doubles.retry.mockResolvedValue({ parentRequestId: producer.nonce, grantId: producer.nonce, requestId: opaque, status: 'queued' })
  })
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(runtime => runtime.stop())); vi.restoreAllMocks(); vi.useRealTimers()
  })
  function fixture(onExecutionDiagnostic?: AutomationReadExecutorOptions['onExecutionDiagnostic'],
    runtimeFactory = createAutomationReadRuntime) {
    let enabled = true
    const transaction = vi.fn(async work => work({})) as unknown as AutomationReadLedgerDependencies['transaction']
    const diagnostic = vi.fn()
    const runtime = runtimeFactory({ transaction, manifest: { version: 4, routes: {} },
      getManager: uncalled, enabled: () => enabled, onUnavailable: diagnostic, onExecutionDiagnostic })
    runtimes.push(runtime)
    return { runtime, transaction, diagnostic, disable() { enabled = false } }
  }
  it('passes only the captured host observer to the executor, not plugin/config supplied hooks or authority', async () => {
    const hostObserver = vi.fn(), pluginObserver = vi.fn(), f = fixture(hostObserver), supplied = binding()
    Reflect.set(supplied, 'onExecutionDiagnostic', pluginObserver)
    await f.runtime.createPluginCapability({ onExecutionDiagnostic: 'not-a-host-hook' }).activate(supplied)
    expect(doubles.executorOptions).toHaveBeenCalledTimes(1)
    expect(doubles.executorOptions.mock.calls[0][0].onExecutionDiagnostic).toBe(hostObserver)
    expect(hostObserver).not.toHaveBeenCalled()
    expect(pluginObserver).not.toHaveBeenCalled()
    await expect(f.runtime.execute(opaque, new AbortController().signal)).resolves.toMatchObject({ status: 'succeeded' })
    f.disable()
    await expect(f.runtime.execute(opaque, new AbortController().signal)).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    expect(doubles.execute).toHaveBeenCalledTimes(1)
  })
  it('captures deploy config before plugin mutation, never accepts passed tenant profiles', async () => {
    const { runtime } = fixture(), deploy = { stockPreparationAutomationProfiles: [{ tenantId: 'synthetic-one' }] }
    const cap = runtime.createPluginCapability(deploy), supplied = binding()
    supplied.prepareProfiles = vi.fn(() => [{} as never])
    deploy.stockPreparationAutomationProfiles[0].tenantId = 'synthetic-other'
    await cap.activate(supplied)
    expect(supplied.prepareProfiles).toHaveBeenCalledWith({ config: { stockPreparationAutomationProfiles: [{ tenantId: 'synthetic-one' }] } })
  })
  it('absent profiles are inert and disabled durable delivery cannot register configured profiles', async () => {
    const f = fixture(); f.disable()
    await f.runtime.createPluginCapability({}).activate({ ...binding(), prepareProfiles: () => [] })
    expect(doubles.activate).not.toHaveBeenCalled()
    await expect(f.runtime.createPluginCapability({}).activate(binding())).rejects.toMatchObject({ code: 'AUTOMATION_READ_RUNTIME_INACTIVE' })
    expect(doubles.activate).not.toHaveBeenCalled()
  })
  it('one capability is single-use and a newer captured capability invalidates the older one', async () => {
    const { runtime } = fixture(), old = runtime.createPluginCapability({}), current = runtime.createPluginCapability({})
    await expect(old.activate(binding())).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    await current.activate(binding())
    await expect(current.activate(binding())).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    expect(doubles.activate).toHaveBeenCalledTimes(1)
  })
  it('stop synchronously cancels active execution, closes admission, and drains before DB retirement', async () => {
    const { runtime } = fixture(); await runtime.createPluginCapability({}).activate(binding())
    let actual: AbortSignal | undefined, finish!: () => void
    doubles.execute.mockImplementation((_id, signal) => {
      actual = signal
      return new Promise(resolve => { finish = () => resolve({ requestId: opaque, status: 'outcome_unknown' }) })
    })
    const run = runtime.execute(opaque, new AbortController().signal), stopped = runtime.stop()
    try {
      expect(actual?.aborted).toBe(true)
      await expect(runtime.execute(opaque, new AbortController().signal)).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
      expect(doubles.deactivate).not.toHaveBeenCalled()
    } finally { finish(); await run; await stopped }
    expect(doubles.deactivate).toHaveBeenCalledWith(expect.anything(), producer)
  })
  it('forwards parent cancellation without stopping unrelated active runtime', async () => {
    const { runtime } = fixture(); await runtime.createPluginCapability({}).activate(binding())
    const parent = new AbortController()
    doubles.execute.mockImplementation((_id, signal) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve({ requestId: opaque, status: 'outcome_unknown' }), { once: true })
    }))
    const run = runtime.execute(opaque, parent.signal); parent.abort(); await expect(run).resolves.toMatchObject({ status: 'outcome_unknown' })
    expect(doubles.deactivate).not.toHaveBeenCalled()
  })
  it('stop holds producer retirement after public unknown until the actual executor tail drains', async () => {
    const { runtime } = fixture(); await runtime.createPluginCapability({}).activate(binding())
    let release!: () => void, drainEntered!: () => void
    const entered = new Promise<void>(resolve => { drainEntered = resolve })
    doubles.executorDrains[0].mockImplementationOnce(() => new Promise<void>(resolve => {
      release = resolve; drainEntered()
    }))
    doubles.execute.mockImplementationOnce((_id, signal: AbortSignal) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve({ requestId: opaque, status: 'outcome_unknown' }), { once: true })
    }))
    const running = runtime.execute(opaque, new AbortController().signal)
    let stopped = false
    const stopping = runtime.stop().then(() => { stopped = true })
    try {
      expect(await running).toMatchObject({ status: 'outcome_unknown' })
      await entered
      expect(stopped).toBe(false); expect(doubles.deactivate).not.toHaveBeenCalled()
      await expect(runtime.execute(opaque, new AbortController().signal)).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    } finally { release(); await stopping }
    expect(doubles.deactivate).toHaveBeenCalledTimes(1)
    expect(doubles.executorDrains[0]).toHaveBeenCalledTimes(1)
    await runtime.createPluginCapability({}).activate(binding())
    await runtime.stop()
    expect(doubles.executorDrains).toHaveLength(2)
    expect(doubles.executorDrains[0]).toHaveBeenCalledTimes(1)
    expect(doubles.executorDrains[1]).toHaveBeenCalledTimes(1)
  })
  it('in-memory removal of the executor drain retires the producer too early and fails behavior', async () => {
    const source = readFileSync(new URL('../../../src/integration/automation-read-runtime.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    const needle = 'await state.executor?.drainPendingWork()'
    expect(source.split(needle)).toHaveLength(2)
    const compiled = transpileModule(source.replace(needle, 'void state.executor'), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText
    const compiledModule = { exports: {} as { createAutomationReadRuntime: typeof createAutomationReadRuntime } }
    const requireMutation = (id: string) => {
      if (id === 'node:perf_hooks') return { performance }
      if (id === './automation-read-authority') return { createAutomationReadAuthority: () => ({}) }
      if (id === './automation-read-ledger') return { createAutomationReadLedger: () => ({}) }
      if (id === './automation-read-discovery') return { createAutomationReadDiscovery: () => ({}) }
      if (id === './automation-read-source-execution') return { createAutomationReadSourceExecution: () => uncalled }
      if (id === './automation-read-record-activation' || id === './automation-read-schedule-activation') return {}
      if (id === './automation-live-authority') return { AutomationActorAuthorityError }
      if (id === './automation-read-contracts') return { AutomationReadLedgerError }
      if (id === './automation-read-profiles') return { activateAutomationReadProfiles: doubles.activate,
        renewAutomationReadProducer: doubles.renew, deactivateAutomationReadProducer: doubles.deactivate }
      if (id === './automation-read-executor') return { createAutomationReadExecutor: () => {
        const drainPendingWork = vi.fn(async () => {})
        doubles.executorDrains.push(drainPendingWork)
        return { execute: doubles.execute, drainPendingWork }
      } }
      throw new Error('Unexpected runtime mutation dependency')
    }
    new Function('require', 'module', 'exports', compiled)(requireMutation, compiledModule, compiledModule.exports)
    async function prove(factory: typeof createAutomationReadRuntime) {
      const { runtime } = fixture(undefined, factory)
      await runtime.createPluginCapability({}).activate(binding())
      let release!: () => void, stopped = false
      const held = new Promise<void>(resolve => { release = resolve })
      const drain = doubles.executorDrains.at(-1)!
      drain.mockImplementationOnce(() => held)
      doubles.execute.mockResolvedValueOnce({ requestId: opaque, status: 'outcome_unknown' })
      await runtime.execute(opaque, new AbortController().signal)
      const stopping = runtime.stop().then(() => { stopped = true })
      try {
        await vi.advanceTimersByTimeAsync(0)
        expect(stopped).toBe(false)
        expect(drain).toHaveBeenCalledTimes(1)
      } finally { release(); await stopping }
    }
    await prove(createAutomationReadRuntime)
    await expect(prove(compiledModule.exports.createAutomationReadRuntime)).rejects.toThrow()
  })
  it('a hung renewal cannot overlap or keep admission beyond the last proved lifetime', async () => {
    const f = fixture(); await f.runtime.createPluginCapability({}).activate(binding())
    let fail!: () => void
    doubles.renew.mockImplementation(() => new Promise((_resolve, reject) => { fail = () => reject(new Error('private-detail')) }))
    await vi.advanceTimersByTimeAsync(15000); await vi.advanceTimersByTimeAsync(60000)
    expect(doubles.renew).toHaveBeenCalledTimes(1)
    fail(); await vi.advanceTimersByTimeAsync(0)
    await expect(f.runtime.execute(opaque, new AbortController().signal)).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    expect(f.diagnostic).toHaveBeenCalledWith()
    await vi.advanceTimersByTimeAsync(60000); expect(doubles.activate).toHaveBeenCalledTimes(1)
  })
  it('transient renewal failure retries without force-stealing', async () => {
    const f = fixture(); await f.runtime.createPluginCapability({}).activate(binding())
    doubles.renew.mockRejectedValueOnce(new Error('synthetic-lock-conflict'))
    await vi.advanceTimersByTimeAsync(15000)
    await expect(f.runtime.execute(opaque, new AbortController().signal)).resolves.toMatchObject({ status: 'succeeded' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(doubles.renew).toHaveBeenCalledTimes(2); expect(doubles.activate).toHaveBeenCalledTimes(1)
  })
  it('an expired monotonic lifetime rejects admission even before a delayed timer fires', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    const f = fixture(); await f.runtime.createPluginCapability({}).activate(binding())
    clock.mockReturnValue(60001)
    await expect(f.runtime.execute(opaque, new AbortController().signal)).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    expect(doubles.execute).not.toHaveBeenCalled()
  })
  it('a late successful renewal cannot reopen the expired local lifetime', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    const f = fixture(); await f.runtime.createPluginCapability({}).activate(binding())
    let finish!: () => void
    doubles.renew.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    clock.mockReturnValue(15000); await vi.advanceTimersByTimeAsync(15000)
    clock.mockReturnValue(60001); finish(); await vi.advanceTimersByTimeAsync(0)
    await expect(f.runtime.execute(opaque, new AbortController().signal)).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    expect(doubles.execute).not.toHaveBeenCalled()
  })
  it('stop during activation waits for commit then retires the captured producer, never publishes executor', async () => {
    const { runtime } = fixture(); let finish!: () => void
    doubles.activate.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ producer, targets: [] }) }))
    const starting = runtime.createPluginCapability({}).activate(binding())
    const denied = expect(starting).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    const stopping = runtime.stop(); finish(); await denied; await stopping
    expect(doubles.deactivate).toHaveBeenCalledTimes(1)
    expect(doubles.execute).not.toHaveBeenCalled()
  })
  it('old stop handles cannot stop replacement producers', async () => {
    const { runtime } = fixture(); const old = await runtime.createPluginCapability({}).activate(binding())
    await old.stop(); await runtime.createPluginCapability({}).activate(binding()); await old.stop()
    await expect(runtime.execute(opaque, new AbortController().signal)).resolves.toMatchObject({ status: 'succeeded' })
    expect(doubles.deactivate).toHaveBeenCalledTimes(1)
  })
  it('invalid config hooks are refused without invoking them', () => {
    const { runtime } = fixture(); let calls = 0
    const config = Object.defineProperty({}, 'tenantId', { enumerable: true, get() { calls++; return 'synthetic' } })
    expect(() => runtime.createPluginCapability(config)).toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    expect(calls).toBe(0)
  })
  it.each(['grant', 'submit', 'options', 'activateRecord', 'activateSchedule', 'retry'] as const)('stop drains pending %s before producer retirement', async method => {
    const { runtime } = fixture(); await runtime.createPluginCapability({}).activate(binding())
    let finish!: () => void
    doubles[method].mockImplementation(() => new Promise(resolve => { finish = () => resolve({ grantId: opaque }) }))
    const actor = { actorId: 'synthetic', tenantId: 'synthetic', workspaceId: null }
    const run = method === 'retry' ? runtime.retry(actor, opaque, {} as never) : runtime[method](actor, {} as never)
    let drained = false
    const stopping = runtime.stop().then(() => { drained = true })
    await vi.advanceTimersByTimeAsync(0)
    try { expect(drained).toBe(false); expect(doubles.deactivate).not.toHaveBeenCalled() }
    finally { finish(); await run; await stopping }
    expect(doubles.deactivate).toHaveBeenCalledTimes(1)
  })
  it('options requires completed active admission and never executes or grants', async () => {
    const f = fixture(), actor = { actorId: 'synthetic', tenantId: 'synthetic', workspaceId: null } as const
    const input = { sheetId: 'synthetic-sheet', limit: 2, after: 'synthetic-rule' }
    await expect(f.runtime.options(actor, input)).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    let finish!: () => void
    doubles.activate.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ producer, targets: [] }) }))
    const starting = f.runtime.createPluginCapability({}).activate(binding())
    try { await expect(f.runtime.options(actor, input)).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE') }
    finally { finish(); await starting }
    await expect(f.runtime.options(actor, input)).resolves.toEqual({ items: [], nextCursor: null })
    expect(doubles.options).toHaveBeenCalledTimes(1)
    expect(doubles.options).toHaveBeenCalledWith(actor, input)
    f.disable()
    await expect(f.runtime.options(actor, input)).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    await f.runtime.stop()
    await expect(f.runtime.options(actor, input)).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    expect(doubles.options).toHaveBeenCalledTimes(1)
    for (const method of ['execute', 'grant', 'submit'] as const) expect(doubles[method]).not.toHaveBeenCalled()
  })
  const retryActor = { actorId: 'synthetic', tenantId: 'synthetic', workspaceId: null } as const
  const retryInput = { retryKey: opaque, budget: { maxRows: 20, maxPages: 2, maxReadCount: 30, timeoutMs: 5000 },
    expiresAt: '2026-10-02T01:00:00.000Z', acknowledgeNewRead: true } as const
  it('retry requires a completed active plugin and enabled durable delivery, including receipt recovery', async () => {
    const f = fixture()
    await expect(f.runtime.retry(retryActor, producer.nonce, retryInput)).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    let finish!: () => void
    doubles.activate.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ producer, targets: [] }) }))
    const starting = f.runtime.createPluginCapability({}).activate(binding())
    try { await expect(f.runtime.retry(retryActor, producer.nonce, retryInput)).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE') }
    finally { finish(); await starting }
    const receipt = { parentRequestId: producer.nonce, grantId: producer.nonce, requestId: opaque, status: 'queued' }
    doubles.retry.mockResolvedValueOnce(receipt)
    expect(await f.runtime.retry(retryActor, producer.nonce, retryInput)).toBe(receipt)
    f.disable()
    await expect(f.runtime.retry(retryActor, producer.nonce, retryInput)).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    await f.runtime.stop()
    await expect(f.runtime.retry(retryActor, producer.nonce, retryInput)).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    expect(doubles.retry).toHaveBeenCalledTimes(1)
    for (const method of ['execute', 'grant', 'submit'] as const) expect(doubles[method]).not.toHaveBeenCalled()
  })
  it('retry receives the runtime signal synchronously and stop drains its original rejected transaction before retiring the producer', async () => {
    const f = fixture(); await f.runtime.createPluginCapability({}).activate(binding())
    const refusal = new AutomationReadLedgerError('AUTOMATION_READ_FENCE_LOST')
    let reject!: (error: Error) => void
    doubles.retry.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    const pending = f.runtime.retry(retryActor, producer.nonce, retryInput)
    const rejected = expect(pending).rejects.toBe(refusal)
    const signal = doubles.retry.mock.calls[0]?.[3] as AbortSignal | undefined
    const liveAtAdmission = signal instanceof AbortSignal && !signal.aborted
    let drained = false
    const stopping = f.runtime.stop().then(() => { drained = true })
    try {
      expect(doubles.retry.mock.calls).toEqual([[retryActor, producer.nonce, retryInput, signal]])
      expect(liveAtAdmission).toBe(true)
      expect(signal?.aborted).toBe(true)
      await Promise.resolve(); expect(drained).toBe(false)
      expect(doubles.deactivate).not.toHaveBeenCalled()
      await expect(f.runtime.retry(retryActor, producer.nonce, retryInput)).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
      expect(doubles.retry).toHaveBeenCalledTimes(1)
    } finally { reject(refusal); await rejected; await stopping }
    expect(drained).toBe(true); expect(doubles.deactivate).toHaveBeenCalledTimes(1)
    await f.runtime.createPluginCapability({}).activate(binding())
    await f.runtime.retry(retryActor, producer.nonce, retryInput)
    const replacementSignal = doubles.retry.mock.calls[1][3] as AbortSignal
    expect(replacementSignal).not.toBe(signal); expect(replacementSignal.aborted).toBe(false)
    expect(signal?.aborted).toBe(true)
    for (const method of ['execute', 'grant', 'submit'] as const) expect(doubles[method]).not.toHaveBeenCalled()
  })
  it.each(['AUTOMATION_READ_IDEMPOTENCY_CONFLICT', 'AUTOMATION_READ_UNAVAILABLE'] as const)(
    'retry preserves %s and does not retry the ledger or initiate source execution', async code => {
      const f = fixture(); await f.runtime.createPluginCapability({}).activate(binding())
      const refusal = new AutomationReadLedgerError(code)
      doubles.retry.mockRejectedValueOnce(refusal)
      await expect(f.runtime.retry(retryActor, producer.nonce, retryInput)).rejects.toBe(refusal)
      expect(doubles.retry).toHaveBeenCalledTimes(1)
      for (const method of ['execute', 'grant', 'submit'] as const) expect(doubles[method]).not.toHaveBeenCalled()
    })
  it('no automatic candidates needs no running plugin, but candidates cannot use a stopped runtime', async () => {
    const { runtime } = fixture(), signal = new AbortController().signal
    const delivery = { outboxId: 'synthetic-obx', eventId: 'synthetic-event', fence: '1', attempts: 1 }
    await expect(runtime.produceRecord(delivery, signal)).resolves.toBeUndefined()
    expect(doubles.candidates).toHaveBeenCalledWith(expect.any(Function), delivery, signal)
    expect(doubles.submitRecord).not.toHaveBeenCalled()
    doubles.candidates.mockResolvedValueOnce([opaque])
    await expect(runtime.produceRecord(delivery, signal)).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    expect(doubles.submitRecord).not.toHaveBeenCalled()
  })
  it('automatic candidates submit through the active lifecycle; deterministic denial skips, unavailable retries', async () => {
    const { runtime } = fixture(); await runtime.createPluginCapability({}).activate(binding())
    const signal = new AbortController().signal
    const delivery = { outboxId: 'synthetic-obx', eventId: 'synthetic-event', fence: '1', attempts: 1 }
    doubles.candidates.mockResolvedValue([opaque, producer.nonce])
    doubles.submitRecord.mockRejectedValueOnce(new AutomationReadLedgerError('AUTOMATION_READ_SCOPE_CHANGED'))
    await expect(runtime.produceRecord(delivery, signal)).resolves.toBeUndefined()
    expect(doubles.submitRecord.mock.calls).toEqual([[opaque, delivery, signal], [producer.nonce, delivery, signal]])
    doubles.submitRecord.mockRejectedValueOnce(new AutomationReadLedgerError('AUTOMATION_READ_UNAVAILABLE'))
    await expect(runtime.produceRecord(delivery, signal)).rejects.toThrow('AUTOMATION_READ_UNAVAILABLE')
    expect(doubles.submitRecord).toHaveBeenCalledTimes(3)
  })
  it('server shutdown drains metadata admission even without a running plugin and refuses new arrivals', async () => {
    const { runtime } = fixture(), signal = new AbortController().signal
    const delivery = { outboxId: 'synthetic-obx', eventId: 'synthetic-event', fence: '1', attempts: 1 }
    let finish!: () => void
    doubles.candidates.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve([]) }))
    const pending = runtime.produceRecord(delivery, signal)
    let drained = false
    const stopping = runtime.stopRecordAdmissions().then(() => { drained = true })
    await Promise.resolve(); expect(drained).toBe(false)
    await expect(runtime.produceRecord(delivery, signal)).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    expect(doubles.candidates).toHaveBeenCalledTimes(1)
    finish(); await pending; await stopping
    expect(drained).toBe(true)
  })
  it('schedule activation forwards only actor/input plus the runtime-owned live cancellation signal', async () => {
    const f = fixture(), actor = { actorId: 'synthetic', tenantId: 'synthetic', workspaceId: null } as const
    const input = { activationKey: opaque } as never
    await expect(f.runtime.activateSchedule(actor, input)).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    expect(doubles.activateSchedule).not.toHaveBeenCalled()
    await f.runtime.createPluginCapability({}).activate(binding())
    let finish!: () => void
    doubles.activateSchedule.mockImplementationOnce(() => new Promise(resolve => {
      finish = () => resolve({ activationId: opaque, grantId: producer.nonce })
    }))
    const pending = f.runtime.activateSchedule(actor, input)
    const signal = doubles.activateSchedule.mock.calls[0][2] as AbortSignal
    expect(doubles.activateSchedule.mock.calls).toEqual([[actor, input, signal]])
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)
    let drained = false
    const stopping = f.runtime.stop().then(() => { drained = true })
    try {
      expect(signal.aborted).toBe(true)
      await Promise.resolve(); expect(drained).toBe(false)
      expect(doubles.deactivate).not.toHaveBeenCalled()
      await expect(f.runtime.activateSchedule(actor, input)).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    } finally { finish(); await pending; await stopping }
    expect(doubles.activateSchedule).toHaveBeenCalledTimes(1)
    expect(doubles.deactivate).toHaveBeenCalledTimes(1)
  })
  const occurrence = { ruleId: 'synthetic-cron', scheduledAtMs: Date.parse('2026-10-01T00:01:00.000Z') }
  it('date wakes page through the private ledger with one immutable wake and signal, never ordinary submit', async () => {
    const { runtime } = fixture(); await runtime.createPluginCapability({}).activate(binding())
    const wake = { ...occurrence, triggerType: 'schedule.date_field' as const, scheduledAtMs: occurrence.scheduledAtMs + 123 }
    doubles.scheduleCandidates.mockResolvedValueOnce([opaque])
    doubles.submitDateSchedulePage.mockResolvedValueOnce({ nextCursor: 'record-100', scanned: 100 })
    await runtime.produceSchedule(wake, new AbortController().signal)
    expect(doubles.submitDateSchedulePage.mock.calls).toEqual([
      [opaque, wake, { limit: 100 }, expect.any(AbortSignal)],
      [opaque, wake, { afterId: 'record-100', limit: 100 }, expect.any(AbortSignal)],
    ])
    expect(doubles.submitDateSchedulePage.mock.calls[0][1]).toBe(doubles.submitDateSchedulePage.mock.calls[1][1])
    expect(doubles.submitDateSchedulePage.mock.calls[0][3]).toBe(doubles.submitDateSchedulePage.mock.calls[1][3])
    expect(Object.isFrozen(doubles.submitDateSchedulePage.mock.calls[0][1])).toBe(true)
    expect(doubles.submitSchedule).not.toHaveBeenCalled(); expect(doubles.submit).not.toHaveBeenCalled()
    expect(doubles.execute).not.toHaveBeenCalled()
  })
  it('date scanning refuses an exhausted 100-page wake rather than claiming complete enumeration', async () => {
    const { runtime } = fixture(); await runtime.createPluginCapability({}).activate(binding())
    doubles.scheduleCandidates.mockResolvedValueOnce([opaque])
    let page = 0
    doubles.submitDateSchedulePage.mockImplementation(async () => ({ nextCursor: 'record-' + ++page, scanned: 100 }))
    await expect(runtime.produceSchedule({ ...occurrence, triggerType: 'schedule.date_field' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    expect(doubles.submitDateSchedulePage).toHaveBeenCalledTimes(100)
    expect(doubles.submitSchedule).not.toHaveBeenCalled()
  })
  it('date scanning stops on explicit grant-budget exhaustion without fetching a later page', async () => {
    const { runtime } = fixture(); await runtime.createPluginCapability({}).activate(binding())
    doubles.scheduleCandidates.mockResolvedValueOnce([opaque])
    doubles.submitDateSchedulePage.mockResolvedValueOnce({ nextCursor: 'record-100', scanned: 100, budgetExhausted: true })
    await runtime.produceSchedule({ ...occurrence, triggerType: 'schedule.date_field' }, new AbortController().signal)
    expect(doubles.submitDateSchedulePage).toHaveBeenCalledTimes(1)
    expect(doubles.submitSchedule).not.toHaveBeenCalled()
  })
  it('date cancellation drains the current page without starting another or falling back', async () => {
    const { runtime } = fixture(); await runtime.createPluginCapability({}).activate(binding())
    doubles.scheduleCandidates.mockResolvedValueOnce([opaque])
    const controller = new AbortController()
    let release!: () => void, enter!: () => void, settled = false
    const entered = new Promise<void>(resolve => { enter = resolve })
    doubles.submitDateSchedulePage.mockImplementationOnce(async () => {
      enter(); await new Promise<void>(resolve => { release = resolve }); return { nextCursor: 'record-100', scanned: 100 }
    })
    const pending = runtime.produceSchedule({ ...occurrence, triggerType: 'schedule.date_field' }, controller.signal)
      .finally(() => { settled = true })
    const refusal = expect(pending).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    await entered; controller.abort(); await Promise.resolve(); expect(settled).toBe(false)
    release(); await refusal
    expect(doubles.submitDateSchedulePage).toHaveBeenCalledTimes(1); expect(doubles.submitSchedule).not.toHaveBeenCalled()
  })
  it('schedule metadata with no candidates does not depend on a plugin or perform a source execution', async () => {
    const f = fixture(), signal = new AbortController().signal
    await expect(f.runtime.produceSchedule(occurrence, signal)).resolves.toBeUndefined()
    expect(doubles.scheduleCandidates).toHaveBeenCalledWith(f.transaction, occurrence, expect.any(AbortSignal))
    expect(doubles.scheduleCandidates.mock.calls[0][2]).not.toBe(signal)
    expect(doubles.scheduleClock.mock.calls[0][2]).toBe(doubles.scheduleCandidates.mock.calls[0][2])
    expect(doubles.activate).not.toHaveBeenCalled()
    expect(doubles.submitSchedule).not.toHaveBeenCalled()
    expect(doubles.execute).not.toHaveBeenCalled()
    doubles.scheduleCandidates.mockResolvedValueOnce([opaque])
    await expect(f.runtime.produceSchedule(occurrence, signal)).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    expect(doubles.submitSchedule).not.toHaveBeenCalled()
  })
  it.each([
    new AutomationReadLedgerError('AUTOMATION_READ_DENIED'),
    new AutomationReadLedgerError('AUTOMATION_READ_SCOPE_CHANGED'),
    new AutomationReadLedgerError('AUTOMATION_READ_BUDGET_EXHAUSTED'),
    new AutomationActorAuthorityError('AUTOMATION_ACTOR_AUTHORITY_DENIED'),
  ])('schedule skips only a typed deterministic denial: $code', async error => {
    const { runtime } = fixture(); await runtime.createPluginCapability({}).activate(binding())
    const signal = new AbortController().signal
    doubles.scheduleCandidates.mockResolvedValueOnce([opaque, producer.nonce])
    doubles.submitSchedule.mockRejectedValueOnce(error)
    await expect(runtime.produceSchedule(occurrence, signal)).resolves.toBeUndefined()
    expect(doubles.submitSchedule.mock.calls).toEqual([
      [opaque, occurrence, expect.any(AbortSignal)], [producer.nonce, occurrence, expect.any(AbortSignal)],
    ])
    for (const [, , merged] of doubles.submitSchedule.mock.calls) {
      expect(merged).not.toBe(signal); expect(merged.aborted).toBe(false)
    }
    expect(doubles.execute).not.toHaveBeenCalled()
  })
  it.each([
    new AutomationReadLedgerError('AUTOMATION_READ_UNAVAILABLE'),
    new AutomationReadLedgerError('AUTOMATION_READ_FENCE_LOST'),
    new AutomationActorAuthorityError('AUTOMATION_ACTOR_AUTHORITY_UNAVAILABLE'),
    Object.assign(new Error('synthetic-lock'), { code: '55P03' }),
    Object.assign(new Error('not-a-typed-denial'), { code: 'AUTOMATION_READ_DENIED' }),
  ])('schedule surfaces non-deterministic or untyped failures without processing later candidates: $code', async error => {
    const { runtime } = fixture(); await runtime.createPluginCapability({}).activate(binding())
    const signal = new AbortController().signal
    doubles.scheduleCandidates.mockResolvedValueOnce([opaque, producer.nonce])
    doubles.submitSchedule.mockRejectedValueOnce(error)
    await expect(runtime.produceSchedule(occurrence, signal)).rejects.toBe(error)
    expect(doubles.submitSchedule.mock.calls).toEqual([[opaque, occurrence, expect.any(AbortSignal)]])
  })
  it('schedule metadata failures propagate even without a running plugin', async () => {
    const { runtime } = fixture(), error = new Error('synthetic-metadata-outage')
    doubles.scheduleCandidates.mockRejectedValueOnce(error)
    await expect(runtime.produceSchedule(occurrence, new AbortController().signal)).rejects.toBe(error)
    expect(doubles.submitSchedule).not.toHaveBeenCalled()
  })
  it('cancellation during candidate lookup cannot enqueue after the metadata callback resolves', async () => {
    const { runtime } = fixture(); await runtime.createPluginCapability({}).activate(binding())
    const controller = new AbortController()
    let finish!: () => void, entered!: () => void
    const finding = new Promise<void>(resolve => { entered = resolve })
    doubles.scheduleCandidates.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve([opaque]); entered() }))
    const pending = runtime.produceSchedule(occurrence, controller.signal)
    const rejected = expect(pending).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    await finding; controller.abort(); finish(); await rejected
    expect(doubles.submitSchedule).not.toHaveBeenCalled()
  })
  it('schedule admission shutdown drains metadata independently of plugin/record admission', async () => {
    const { runtime } = fixture(), signal = new AbortController().signal
    let finish!: () => void, entered!: () => void
    const finding = new Promise<void>(resolve => { entered = resolve })
    doubles.scheduleCandidates.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve([]); entered() }))
    const pending = runtime.produceSchedule(occurrence, signal)
    const rejected = expect(pending).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    await finding
    let drained = false
    const stopping = runtime.stopScheduleAdmissions().then(() => { drained = true })
    try {
      await runtime.stop(); await runtime.stopRecordAdmissions()
      expect(drained).toBe(false)
      await expect(runtime.produceSchedule(occurrence, signal)).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
      expect(doubles.scheduleCandidates).toHaveBeenCalledTimes(1)
    } finally { finish(); await rejected; await stopping }
    expect(drained).toBe(true)
  })
  it('schedule admission and plugin stop both drain a submission already admitted to the ledger', async () => {
    const { runtime } = fixture(); await runtime.createPluginCapability({}).activate(binding())
    const signal = new AbortController().signal
    let entered!: () => void, finish!: () => void
    const submitted = new Promise<void>(resolve => { entered = resolve })
    doubles.scheduleCandidates.mockResolvedValueOnce([opaque])
    doubles.submitSchedule.mockImplementationOnce(() => new Promise(resolve => {
      finish = () => resolve({ requestId: opaque, status: 'queued' }); entered()
    }))
    const pending = runtime.produceSchedule(occurrence, signal)
    await submitted
    const merged = doubles.submitSchedule.mock.calls[0][2] as AbortSignal
    expect(merged).not.toBe(signal); expect(merged.aborted).toBe(false)
    let metadataDrained = false, pluginDrained = false
    const metadataStop = runtime.stopScheduleAdmissions().then(() => { metadataDrained = true })
    const pluginStop = runtime.stop().then(() => { pluginDrained = true })
    try {
      expect(merged.aborted).toBe(true)
      expect(signal.aborted).toBe(false)
      await Promise.resolve()
      expect(metadataDrained).toBe(false); expect(pluginDrained).toBe(false)
      expect(doubles.deactivate).not.toHaveBeenCalled()
      await expect(runtime.produceSchedule(occurrence, signal)).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    } finally { finish(); await pending; await Promise.all([metadataStop, pluginStop]) }
    expect(metadataDrained).toBe(true); expect(pluginDrained).toBe(true)
    expect(doubles.deactivate).toHaveBeenCalledTimes(1)
  })
  it('parent cancellation reaches an admitted schedule submission without stopping its plugin', async () => {
    const { runtime } = fixture(); await runtime.createPluginCapability({}).activate(binding())
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener'), remove = vi.spyOn(controller.signal, 'removeEventListener')
    let entered!: () => void
    const submitted = new Promise<void>(resolve => { entered = resolve })
    doubles.scheduleCandidates.mockResolvedValueOnce([opaque])
    doubles.submitSchedule.mockImplementationOnce((_id, _occurrence, signal: AbortSignal) => new Promise<void>(resolve => {
      signal.addEventListener('abort', () => resolve(), { once: true }); entered()
    }))
    const pending = runtime.produceSchedule(occurrence, controller.signal)
    await submitted
    const merged = doubles.submitSchedule.mock.calls[0][2] as AbortSignal
    expect(merged).not.toBe(controller.signal); expect(merged.aborted).toBe(false)
    controller.abort(); await pending
    expect(merged.aborted).toBe(true)
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1])
    expect(doubles.deactivate).not.toHaveBeenCalled()
    await expect(runtime.execute(opaque, new AbortController().signal)).resolves.toMatchObject({ status: 'succeeded' })
  })
  it('freezes the original occurrence at entry and uses one merged signal through clock/candidate/submit', async () => {
    const f = fixture(); await f.runtime.createPluginCapability({}).activate(binding())
    const supplied = { ...occurrence }, signal = new AbortController().signal
    let finish!: () => void
    doubles.scheduleClock.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    doubles.scheduleCandidates.mockResolvedValueOnce([opaque])
    const run = f.runtime.produceSchedule(supplied, signal)
    supplied.ruleId = 'changed-rule'; supplied.scheduledAtMs += 60000
    const frozen = doubles.scheduleClock.mock.calls[0][1]
    expect(frozen).toEqual(occurrence); expect(Object.isFrozen(frozen)).toBe(true); expect(frozen).not.toBe(supplied)
    expect(doubles.scheduleCandidates).not.toHaveBeenCalled()
    finish(); await run
    expect(doubles.scheduleCandidates.mock.calls[0][1]).toBe(frozen)
    expect(doubles.submitSchedule.mock.calls[0][1]).toBe(frozen)
    expect(doubles.scheduleClock.mock.calls[0][2]).toBe(doubles.scheduleCandidates.mock.calls[0][2])
    expect(doubles.scheduleClock.mock.calls[0][2]).toBe(doubles.submitSchedule.mock.calls[0][2])
    doubles.scheduleCandidates.mockResolvedValueOnce([opaque])
    await f.runtime.produceSchedule(occurrence, signal)
    expect(doubles.submitSchedule.mock.calls[1][1]).toEqual(frozen)
    // This is unchanged input identity only; the real ledger tests prove durable deduplication.
    expect(doubles.execute).not.toHaveBeenCalled()
  })
  it('a readiness refusal never falls through to candidates, grants or source execution', async () => {
    const f = fixture(), refused = new AutomationReadLedgerError('AUTOMATION_READ_UNAVAILABLE')
    doubles.scheduleClock.mockRejectedValueOnce(refused)
    await expect(f.runtime.produceSchedule(occurrence, new AbortController().signal)).rejects.toBe(refused)
    expect(doubles.scheduleCandidates).not.toHaveBeenCalled(); expect(doubles.submitSchedule).not.toHaveBeenCalled()
    expect(doubles.activate).not.toHaveBeenCalled(); expect(doubles.execute).not.toHaveBeenCalled()
  })
  it('parent abort while readiness is pending propagates without detaching that SQL promise', async () => {
    const f = fixture(), parent = new AbortController()
    const add = vi.spyOn(parent.signal, 'addEventListener'), remove = vi.spyOn(parent.signal, 'removeEventListener')
    let finish!: () => void
    doubles.scheduleClock.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    let settled = false
    const run = f.runtime.produceSchedule(occurrence, parent.signal).finally(() => { settled = true })
    const rejected = expect(run).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    const merged = doubles.scheduleClock.mock.calls[0][2] as AbortSignal
    parent.abort(); await Promise.resolve()
    expect(merged.aborted).toBe(true); expect(settled).toBe(false)
    finish(); await rejected
    expect(doubles.scheduleCandidates).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1])
  })
  it('server schedule stop cancels readiness and drains its outstanding metadata receipt with no plugin', async () => {
    const f = fixture(), parent = new AbortController()
    let finish!: () => void
    doubles.scheduleClock.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const run = f.runtime.produceSchedule(occurrence, parent.signal)
    const rejected = expect(run).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    let drained = false
    const stopped = f.runtime.stopScheduleAdmissions().then(() => { drained = true })
    expect((doubles.scheduleClock.mock.calls[0][2] as AbortSignal).aborted).toBe(true)
    await Promise.resolve(); expect(drained).toBe(false); expect(parent.signal.aborted).toBe(false)
    await expect(f.runtime.produceSchedule(occurrence, parent.signal)).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    finish(); await rejected; await stopped
    expect(drained).toBe(true); expect(doubles.scheduleCandidates).not.toHaveBeenCalled()
  })
  it('captured plugin stop drains pre-candidate SQL and cannot publish into its replacement lifetime', async () => {
    const f = fixture(); await f.runtime.createPluginCapability({}).activate(binding())
    let finish!: () => void
    doubles.scheduleClock.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const run = f.runtime.produceSchedule(occurrence, new AbortController().signal)
    const rejected = expect(run).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    let drained = false
    const stopped = f.runtime.stop().then(() => { drained = true })
    expect((doubles.scheduleClock.mock.calls[0][2] as AbortSignal).aborted).toBe(true)
    await Promise.resolve(); expect(drained).toBe(false); expect(doubles.deactivate).not.toHaveBeenCalled()
    finish(); await rejected; await stopped
    await f.runtime.createPluginCapability({}).activate(binding())
    expect(doubles.scheduleCandidates).not.toHaveBeenCalled(); expect(doubles.submitSchedule).not.toHaveBeenCalled()
    doubles.scheduleCandidates.mockResolvedValueOnce([opaque])
    await expect(f.runtime.produceSchedule(occurrence, new AbortController().signal)).resolves.toBeUndefined()
    expect(doubles.submitSchedule).toHaveBeenCalledTimes(1)
  })
  it('metadata begun without a plugin never borrows a plugin activated during readiness', async () => {
    const f = fixture()
    let finish!: () => void
    doubles.scheduleClock.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    doubles.scheduleCandidates.mockResolvedValueOnce([opaque])
    const run = f.runtime.produceSchedule(occurrence, new AbortController().signal)
    const rejected = expect(run).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
    await f.runtime.createPluginCapability({}).activate(binding())
    finish(); await rejected
    expect(doubles.scheduleCandidates).toHaveBeenCalledTimes(1); expect(doubles.submitSchedule).not.toHaveBeenCalled()
  })
  it('limits simultaneous readiness admissions to 100 without a queued waitlist, then releases capacity', async () => {
    const f = fixture(), releases: Array<() => void> = []
    doubles.scheduleClock.mockImplementation(() => new Promise<void>(resolve => { releases.push(resolve) }))
    const parents = Array.from({ length: 100 }, () => new AbortController())
    const listeners = parents.map(parent => ({ add: vi.spyOn(parent.signal, 'addEventListener'), remove: vi.spyOn(parent.signal, 'removeEventListener') }))
    const runs = parents.map(parent => f.runtime.produceSchedule(occurrence, parent.signal))
    await expect(f.runtime.produceSchedule(occurrence, new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    expect(doubles.scheduleClock).toHaveBeenCalledTimes(100); expect(doubles.scheduleCandidates).not.toHaveBeenCalled()
    for (const release of releases) release()
    await Promise.all(runs)
    for (const { add, remove } of listeners) {
      expect(add).toHaveBeenCalledTimes(1)
      expect(remove).toHaveBeenCalledTimes(1)
      expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1])
    }
    expect(doubles.scheduleCandidates).toHaveBeenCalledTimes(100)
    doubles.scheduleClock.mockResolvedValue(undefined)
    await expect(f.runtime.produceSchedule(occurrence, new AbortController().signal)).resolves.toBeUndefined()
    expect(doubles.scheduleClock).toHaveBeenCalledTimes(101)
  })
  it.each(['caller', 'plugin'] as const)('shares one listener per source across 100 active admissions, fans out %s abort, cleans up and reuses capacity', async source => {
    const f = fixture(), parent = new AbortController(), releases: Array<() => void> = []
    await f.runtime.createPluginCapability({}).activate(binding())
    const add = vi.spyOn(AbortSignal.prototype, 'addEventListener'), remove = vi.spyOn(AbortSignal.prototype, 'removeEventListener')
    doubles.scheduleClock.mockImplementation(() => new Promise<void>(resolve => { releases.push(resolve) }))
    const runs = Array.from({ length: 100 }, () => f.runtime.produceSchedule(occurrence, parent.signal))
    const settled = Promise.allSettled(runs)
    const initialListenerCount = add.mock.calls.length, initialSources = new Set(add.mock.instances).size
    let stopped: Promise<void> | undefined
    if (source === 'caller') parent.abort()
    else stopped = f.runtime.stop()
    const allAborted = doubles.scheduleClock.mock.calls.every(call => (call[2] as AbortSignal).aborted)
    const earlyRemovals = remove.mock.calls.length
    for (const release of releases) release()
    const results = await settled
    expect(initialListenerCount).toBe(3); expect(initialSources).toBe(3)
    expect(allAborted).toBe(true); expect(earlyRemovals).toBe(0)
    expect(results).toHaveLength(100)
    for (const result of results) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'AUTOMATION_READ_RUNTIME_INACTIVE' })
    }
    expect(remove).toHaveBeenCalledTimes(3)
    for (let index = 0; index < 3; index++) {
      const listener = add.mock.calls[index][1]
      const removedIndex = remove.mock.calls.findIndex(call => call[1] === listener)
      expect(removedIndex).toBeGreaterThanOrEqual(0)
      expect(remove.mock.instances[removedIndex]).toBe(add.mock.instances[index])
    }
    expect(doubles.scheduleCandidates).not.toHaveBeenCalled()
    await stopped
    if (source === 'plugin') await f.runtime.createPluginCapability({}).activate(binding())
    doubles.scheduleClock.mockResolvedValue(undefined)
    await expect(f.runtime.produceSchedule(occurrence, new AbortController().signal)).resolves.toBeUndefined()
    expect(doubles.scheduleClock).toHaveBeenCalledTimes(101)
  })
  it('successful schedule admission removes its parent listener without aborting that parent', async () => {
    const f = fixture(), parent = new AbortController()
    const add = vi.spyOn(parent.signal, 'addEventListener'), remove = vi.spyOn(parent.signal, 'removeEventListener')
    await f.runtime.produceSchedule(occurrence, parent.signal)
    expect(add).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1])
    expect(parent.signal.aborted).toBe(false)
  })
})
