/** Executor routing/lifetime evidence only. Ledger, authority, target and source are
 * explicit doubles; these tests do not certify DB locks, permissions or native IO. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { performance } from 'node:perf_hooks'
import { readFileSync } from 'node:fs'
import { ModuleKind, transpileModule } from 'typescript'
import { createAutomationReadExecutor, type AutomationReadExecutionDiagnostic, type AutomationReadExecutorOptions,
  type AutomationReadPreviewInput } from '../../../src/integration/automation-read-executor'
import { AutomationReadLedgerError, checkedReadPreview } from '../../../src/integration/automation-read-contracts'

const doubles = vi.hoisted(() => ({ loadRecords: vi.fn() }))
vi.mock('../../../src/integration/automation-read-target-records', () => ({ loadAutomationReadTargetRecords: doubles.loadRecords }))
const nonce = '11111111-1111-4111-8111-111111111111'
const budget = { maxRows: 10, maxPages: 2, maxReadCount: 4, timeoutMs: 10000 }
const actor = { actorId: 'synthetic-owner', tenantId: 'synthetic-tenant', workspaceId: null }
const selector = { ruleId: 'synthetic-rule', actionId: 'synthetic-action', systemId: 'synthetic-source', targetId: nonce }
const sourceReference = { connectionId: 'synthetic-connection', connectionIncarnation: nonce }
const result = { status: 'ready', canApply: false, counts: { add: 1, update: 0, skip: 0, inactive: 0, manual_confirm: 0 } }
function fixture(mode: 'execution' | 'record' = 'execution', observer?: AutomationReadExecutorOptions['onExecutionDiagnostic'],
  factory = createAutomationReadExecutor) {
  const proof = Object.freeze({ ...actor, key: 'a'.repeat(64), budget, sourceReference, allowedTriggers: ['record'] })
  const permit = { actor, selector, budget, sourceReference, authorityKey: proof.key, projectNo: 'synthetic-project',
    remainingMs: 10000, authorityMode: mode }
  const records = { close: vi.fn() }
  doubles.loadRecords.mockResolvedValue(records)
  const ledger = { claim: vi.fn(async () => ({ requestId: nonce, status: 'running', fence: nonce, budget })),
    checkpoint: vi.fn(async () => ({ ...permit })),
    complete: vi.fn(async () => ({ requestId: nonce, status: 'succeeded' })),
    abandon: vi.fn(async () => ({ requestId: nonce, status: 'outcome_unknown' })) }
  const authority = { lockExecution: vi.fn(async () => proof), lockRecordExecution: vi.fn(async () => proof),
    recordConditionFor: vi.fn(() => ({ mode: 'unconditional' })), evaluateRecordConditions: vi.fn(async () => ({ kind: 'match' })),
    materialFor: vi.fn((supplied: unknown) => {
      if (supplied !== proof) throw new Error('Executor cloned the private proof')
      return { action: {}, installedFieldProperties: {}, extFieldMapping: {}, sourceValidation: {},
        target: { scope: { baseId: 'base', sheetId: 'sheet' }, targetContract: { projection: {
          fieldIds: ['project', 'value'], projectFieldId: 'project', activeFieldId: 'active',
        } } } }
    }) }
  const trx = { query: vi.fn(async () => { throw new Error('No executor unit may perform SQL') }) }
  const transaction = vi.fn(async (work: (query: typeof trx) => Promise<unknown>) => work(trx))
  const sourceExecution = vi.fn(async (_input: unknown, preview: () => Promise<unknown>) => preview())
  const preview = vi.fn(async (_input: AutomationReadPreviewInput) => result)
  // Only exercised methods are represented. These are not synthetic authority receipts
  // offered to the ledger: the actual executor is the sole subject of this unit fixture.
  const executor = factory({ ledger, authority, transaction, sourceExecution, preview,
    onExecutionDiagnostic: observer } as unknown as AutomationReadExecutorOptions)
  return { executor, ledger, authority, transaction, sourceExecution, preview, records, permit, proof }
}
beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('Read executor exact trusted authority mode', () => {
  it.each(['execution', 'record'] as const)('uses only %s proof and passes the original object to materialFor', async mode => {
    const f = fixture(mode)
    await expect(f.executor.execute(nonce, new AbortController().signal)).resolves.toEqual({ requestId: nonce, status: 'succeeded' })
    expect(f.authority.lockExecution).toHaveBeenCalledTimes(mode === 'execution' ? 1 : 0)
    expect(f.authority.lockRecordExecution).toHaveBeenCalledTimes(mode === 'record' ? 1 : 0)
    expect(f.authority.materialFor).toHaveBeenCalledWith(f.proof)
    expect(doubles.loadRecords).toHaveBeenCalledTimes(1)
    expect(f.sourceExecution).toHaveBeenCalledTimes(1)
    expect(f.preview).toHaveBeenCalledTimes(1)
    expect(f.ledger.complete).toHaveBeenCalledTimes(1)
    expect(f.ledger.abandon).not.toHaveBeenCalled()
    // Worker revalidates metadata but never reevaluates the already-admitted event.
    expect(f.authority.evaluateRecordConditions).not.toHaveBeenCalled()
    expect(f.authority.recordConditionFor).not.toHaveBeenCalled()
  })
  it.each(['lockRecordExecution', 'evaluateRecordConditions', 'recordConditionFor'] as const)(
    'a record checkpoint with missing %s does not borrow ordinary authority', async capability => {
      const f = fixture('record')
      Reflect.set(f.authority, capability, undefined)
      await expect(f.executor.execute(nonce, new AbortController().signal)).resolves.toEqual({ requestId: nonce, status: 'outcome_unknown' })
      expect(f.authority.lockExecution).not.toHaveBeenCalled()
      expect(f.authority.materialFor).not.toHaveBeenCalled()
      expect(doubles.loadRecords).not.toHaveBeenCalled()
      expect(f.sourceExecution).not.toHaveBeenCalled()
      expect(f.ledger.complete).not.toHaveBeenCalled()
      expect(f.ledger.abandon).toHaveBeenCalledTimes(1)
    },
  )
  it('ordinary execution still works on an ordinary-only authority host', async () => {
    const f = fixture('execution')
    for (const key of ['lockRecordExecution', 'evaluateRecordConditions', 'recordConditionFor']) Reflect.deleteProperty(f.authority, key)
    expect(await f.executor.execute(nonce, new AbortController().signal)).toMatchObject({ status: 'succeeded' })
    expect(f.authority.lockExecution).toHaveBeenCalledTimes(1)
  })
  it.each([undefined, null, 'conditional', 'RECORD'])('rejects missing/unknown checkpoint authority mode %# before any material IO', async mode => {
    const f = fixture()
    Reflect.set(f.permit, 'authorityMode', mode)
    expect(await f.executor.execute(nonce, new AbortController().signal)).toMatchObject({ status: 'outcome_unknown' })
    expect(f.authority.lockExecution).not.toHaveBeenCalled()
    expect(f.authority.lockRecordExecution).not.toHaveBeenCalled()
    expect(doubles.loadRecords).not.toHaveBeenCalled()
    expect(f.preview).not.toHaveBeenCalled()
  })
  it.each(['execution', 'record'] as const)('a later %s-to-other mode substitution fails even when key and all other fields agree', async original => {
    const f = fixture(original)
    f.ledger.checkpoint.mockResolvedValueOnce({ ...f.permit })
      .mockResolvedValue({ ...f.permit, authorityMode: original === 'execution' ? 'record' : 'execution' })
    expect(await f.executor.execute(nonce, new AbortController().signal)).toMatchObject({ status: 'outcome_unknown' })
    expect(f.ledger.checkpoint).toHaveBeenCalledTimes(2)
    expect(f.authority.materialFor).toHaveBeenCalledTimes(1)
    expect(f.sourceExecution).not.toHaveBeenCalled()
    expect(f.preview).not.toHaveBeenCalled()
    expect(f.ledger.complete).not.toHaveBeenCalled()
    expect(f.records.close).toHaveBeenCalled()
  })
  it('record lock failure is not retried using ordinary lockExecution', async () => {
    const f = fixture('record')
    f.authority.lockRecordExecution.mockRejectedValue(new Error('synthetic-private-denial'))
    expect(await f.executor.execute(nonce, new AbortController().signal)).toMatchObject({ status: 'outcome_unknown' })
    expect(f.authority.lockRecordExecution).toHaveBeenCalledTimes(1)
    expect(f.authority.lockExecution).not.toHaveBeenCalled()
    expect(f.authority.materialFor).not.toHaveBeenCalled()
    expect(f.sourceExecution).not.toHaveBeenCalled()
  })
})

describe('host-private actual work drain beyond public deadline races', () => {
  async function proveTail(factory: typeof createAutomationReadExecutor, kind: 'work' | 'inner' | 'resnapshot') {
    const f = fixture('execution', undefined, factory), parent = new AbortController()
    let enter!: () => void, release!: () => void, secondRelease!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const second = new Promise<void>(resolve => { secondRelease = resolve })
    f.preview.mockImplementationOnce(async input => {
      if (kind === 'inner') input.trackPendingWork(held)
      if (kind === 'resnapshot') input.trackPendingWork(held.then(() => { input.trackPendingWork(second) }))
      enter()
      if (kind === 'work') await held
      return result
    })
    const running = f.executor.execute(nonce, parent.signal)
    await entered
    if (kind === 'work') parent.abort()
    await running
    let drained = false
    const stopping = f.executor.drainPendingWork().then(() => { drained = true })
    if (kind === 'resnapshot') release()
    try {
      await new Promise(resolve => setImmediate(resolve))
      expect(drained).toBe(false)
    } finally { release(); secondRelease(); await stopping }
  }

  it('in-memory lifecycle mutations fail the same deferred-tail behavior', async () => {
    const filename = new URL('../../../src/integration/automation-read-executor.ts', import.meta.url)
    const source = readFileSync(filename, 'utf8').replace(/\r\n/g, '\n')
    const mutations = [
      ['outer-work-registration', 'trackPendingWork(running)', 'void running', 'work'],
      ['inner-callback-thread', 'checkpoint: sourceCheckpoint, trackPendingWork',
        'checkpoint: sourceCheckpoint, trackPendingWork: () => {}', 'inner'],
      ['drain-wait', 'while (pendingWork.size > 0) await Promise.allSettled([...pendingWork])', 'void pendingWork', 'work'],
      ['drain-resnapshot', 'while (pendingWork.size > 0) await Promise.allSettled([...pendingWork])',
        'if (pendingWork.size > 0) await Promise.allSettled([...pendingWork])', 'resnapshot'],
    ] as const
    for (const [name, needle, replacement, kind] of mutations) {
      await proveTail(createAutomationReadExecutor, kind)
      expect(source.split(needle)).toHaveLength(2)
      const compiled = transpileModule(source.replace(needle, replacement), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText
      const compiledModule = { exports: {} as { createAutomationReadExecutor: typeof createAutomationReadExecutor } }
      const requireMutation = (id: string) => {
        if (id === 'node:perf_hooks') return { performance }
        if (id === './automation-read-contracts') return { AutomationReadLedgerError, checkedReadPreview }
        if (id === './automation-read-target-records') return { loadAutomationReadTargetRecords: doubles.loadRecords }
        throw new Error('Unexpected executor mutation dependency')
      }
      new Function('require', 'module', 'exports', compiled)(requireMutation, compiledModule, compiledModule.exports)
      await expect(proveTail(compiledModule.exports.createAutomationReadExecutor, kind), name).rejects.toThrow()
    }
  })

  it.each(['resolve', 'reject'] as const)('keeps delayed preview %s pending after unknown until actual work settles', async settlement => {
    const f = fixture(), parent = new AbortController()
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const held = new Promise<typeof result>((resolve, reject) => {
      release = () => settlement === 'resolve' ? resolve(result) : reject(new Error('synthetic-late-preview'))
    })
    f.preview.mockImplementationOnce(async () => { enter(); return held })
    const running = f.executor.execute(nonce, parent.signal)
    await entered; parent.abort()
    expect(await running).toMatchObject({ status: 'outcome_unknown' })
    let drained = false
    const stopping = f.executor.drainPendingWork().then(() => { drained = true })
    try {
      await new Promise(resolve => setImmediate(resolve))
      expect(drained).toBe(false)
      expect(f.ledger.complete).not.toHaveBeenCalled()
    } finally { release(); await stopping }
    expect(drained).toBe(true)
    expect(f.ledger.complete).not.toHaveBeenCalled()
    expect(f.preview).toHaveBeenCalledTimes(1)
  })

  it.each(['resolve', 'reject'] as const)('drains an initial metadata checkpoint %s even with zero preview/source IO', async settlement => {
    const f = fixture(), parent = new AbortController()
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    f.ledger.checkpoint.mockImplementationOnce(() => new Promise((resolve, reject) => {
      release = () => settlement === 'resolve' ? resolve({ ...f.permit }) : reject(new Error('synthetic-late-checkpoint'))
      enter()
    }))
    const running = f.executor.execute(nonce, parent.signal)
    await entered; parent.abort(); expect(await running).toMatchObject({ status: 'outcome_unknown' })
    let drained = false
    const stopping = f.executor.drainPendingWork().then(() => { drained = true })
    try {
      await new Promise(resolve => setImmediate(resolve))
      expect(drained).toBe(false)
      expect(f.sourceExecution).not.toHaveBeenCalled(); expect(f.preview).not.toHaveBeenCalled()
    } finally { release(); await stopping }
    expect(f.authority.lockExecution).not.toHaveBeenCalled()
  })

  it('tracks the real inner preview tail after its own race settles and isolates factory lifetimes', async () => {
    const f = fixture(), other = fixture()
    let release!: () => void, innerSettled = false
    const inner = new Promise<void>(resolve => { release = resolve }).then(() => { innerSettled = true })
    f.preview.mockImplementationOnce(async input => {
      input.trackPendingWork(inner)
      return result
    })
    expect(await f.executor.execute(nonce, new AbortController().signal)).toMatchObject({ status: 'succeeded' })
    let drained = false
    const stopping = f.executor.drainPendingWork().then(() => { drained = true })
    try {
      await other.executor.drainPendingWork()
      expect(drained).toBe(false); expect(innerSettled).toBe(false)
    } finally { release(); await stopping }
    expect(drained).toBe(true); expect(innerSettled).toBe(true)
  })

  it('rechecks work registered while an earlier drain snapshot is pending', async () => {
    const f = fixture(), parent = new AbortController()
    let enter!: () => void, firstRelease!: () => void, secondRelease!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const second = new Promise<void>(resolve => { secondRelease = resolve })
    f.preview.mockImplementationOnce(async input => {
      const first = new Promise<void>(resolve => { firstRelease = resolve })
      input.trackPendingWork(first.then(() => { input.trackPendingWork(second) }))
      enter(); return result
    })
    await f.executor.execute(nonce, parent.signal); await entered
    let drained = false
    const stopping = f.executor.drainPendingWork().then(() => { drained = true })
    firstRelease()
    try {
      await new Promise(resolve => setImmediate(resolve)); expect(drained).toBe(false)
    } finally { secondRelease(); await stopping }
    expect(drained).toBe(true)
  })
})

describe('host-private bounded execution diagnostics on the actual executor', () => {
  it('reports successful completion separately from ordinary cleanup, with only fixed fields', async () => {
    const observer = vi.fn(), f = fixture('execution', observer), parent = new AbortController()
    const actual = await f.executor.execute(nonce, parent.signal)
    expect(actual).toEqual({ requestId: nonce, status: 'succeeded' })
    expect(observer).toHaveBeenCalledTimes(1)
    const diagnostic = observer.mock.calls[0][0] as AutomationReadExecutionDiagnostic
    expect(diagnostic).toEqual({ phase: 'complete', firstStop: 'none', outcome: 'succeeded',
      elapsedMs: expect.any(Number), checkpointCount: 3, cleanupCount: 1 })
    expect(Number.isInteger(diagnostic.elapsedMs)).toBe(true)
    expect(diagnostic.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(diagnostic.elapsedMs).toBeLessThanOrEqual(86400000)
    expect(Object.isFrozen(diagnostic)).toBe(true)
    expect(parent.signal.aborted).toBe(false)
    expect(f.preview.mock.calls[0][0].signal.aborted).toBe(true)
    const serialized = JSON.stringify(diagnostic)
    for (const privateValue of [nonce, actor.actorId, actor.tenantId, selector.ruleId, sourceReference.connectionId,
      'synthetic-project', 'requestId', 'actor', 'error', 'stack', 'SELECT', 'config']) expect(serialized).not.toContain(privateValue)
  })

  it('classifies the actual timer branch, and late native/preview completion cannot publish or revise its observation', async () => {
    vi.useFakeTimers()
    const observer = vi.fn(), f = fixture('execution', observer)
    f.ledger.claim.mockResolvedValueOnce({ requestId: nonce, status: 'running', fence: nonce,
      budget: { ...budget, timeoutMs: 50 } })
    let entered!: () => void, finish!: (value: typeof result) => void
    const previewEntered = new Promise<void>(resolve => { entered = resolve })
    f.preview.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; entered() }))
    const running = f.executor.execute(nonce, new AbortController().signal)
    await previewEntered
    await vi.advanceTimersByTimeAsync(51)
    expect(await running).toEqual({ requestId: nonce, status: 'outcome_unknown' })
    expect(observer.mock.calls[0][0]).toMatchObject({ phase: 'preview', firstStop: 'timeout',
      outcome: 'outcome_unknown', checkpointCount: 2, cleanupCount: 1 })
    const terminal = JSON.stringify(observer.mock.calls[0][0])
    finish(result); await vi.runAllTimersAsync()
    expect(f.ledger.complete).not.toHaveBeenCalled()
    expect(f.sourceExecution).toHaveBeenCalledTimes(1)
    expect(f.preview).toHaveBeenCalledTimes(1)
    expect(observer).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(observer.mock.calls[0][0])).toBe(terminal)
  })

  it('attributes the supplied merged signal only to upstream-abort, never its private reason or an imagined caller', async () => {
    const observer = vi.fn(), f = fixture('execution', observer), parent = new AbortController()
    let entered!: () => void, finish!: (value: typeof result) => void
    const previewEntered = new Promise<void>(resolve => { entered = resolve })
    f.preview.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; entered() }))
    const running = f.executor.execute(nonce, parent.signal)
    await previewEntered
    const getter = vi.fn(() => { throw new Error('private reason must not be inspected') })
    parent.abort(Object.defineProperty({}, 'message', { get: getter }))
    expect(await running).toEqual({ requestId: nonce, status: 'outcome_unknown' })
    expect(observer.mock.calls[0][0]).toMatchObject({ phase: 'preview', firstStop: 'upstream-abort',
      outcome: 'outcome_unknown', checkpointCount: 2, cleanupCount: 1 })
    finish(result); await Promise.resolve(); await Promise.resolve()
    expect(getter).not.toHaveBeenCalled()
    expect(f.ledger.complete).not.toHaveBeenCalled()
    expect(observer).toHaveBeenCalledTimes(1)
  })

  it.each(['elapsed', 'lease-tightened'] as const)('distinguishes a real live/arm deadline from the timer: %s', async mode => {
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const observer = vi.fn(), f = fixture('execution', observer)
    f.ledger.checkpoint.mockImplementationOnce(async () => {
      if (mode === 'elapsed') clock = budget.timeoutMs + 1
      return { ...f.permit, remainingMs: mode === 'lease-tightened' ? 0 : 10000 }
    })
    expect(await f.executor.execute(nonce, new AbortController().signal)).toMatchObject({ status: 'outcome_unknown' })
    expect(observer.mock.calls[0][0]).toMatchObject({ phase: 'initial-checkpoint', firstStop: 'live-deadline',
      outcome: 'outcome_unknown', checkpointCount: 1, cleanupCount: 1 })
    expect(f.authority.lockExecution).not.toHaveBeenCalled()
    expect(f.sourceExecution).not.toHaveBeenCalled()
  })

  it.each(['initial-checkpoint', 'material-checkpoint', 'source-checkpoint', 'final-checkpoint', 'authority',
    'target-records', 'source', 'preview', 'complete'] as const)('latches the real %s phase, not abandon or raw exception details', async failedPhase => {
    const observer = vi.fn(), f = fixture('execution', observer)
    const getter = vi.fn(() => { throw new Error('private error accessor') })
    const privateError = Object.defineProperties({}, { message: { get: getter }, stack: { get: getter }, code: { get: getter } })
    if (failedPhase === 'initial-checkpoint') f.ledger.checkpoint.mockRejectedValueOnce(privateError)
    if (failedPhase === 'material-checkpoint') f.ledger.checkpoint.mockResolvedValueOnce({ ...f.permit }).mockRejectedValueOnce(privateError)
    if (failedPhase === 'source-checkpoint') {
      f.ledger.checkpoint.mockResolvedValueOnce({ ...f.permit }).mockResolvedValueOnce({ ...f.permit }).mockRejectedValueOnce(privateError)
      f.preview.mockImplementationOnce(async input => {
        // JS plugin callback arguments are never adopted as diagnostic fields.
        await Reflect.apply(input.checkpoint, undefined, ['private supplied phase'])
        return result
      })
    }
    if (failedPhase === 'final-checkpoint') f.ledger.checkpoint.mockResolvedValueOnce({ ...f.permit })
      .mockResolvedValueOnce({ ...f.permit }).mockRejectedValueOnce(privateError)
    if (failedPhase === 'authority') f.authority.lockExecution.mockRejectedValueOnce(privateError)
    if (failedPhase === 'target-records') doubles.loadRecords.mockRejectedValueOnce(privateError)
    if (failedPhase === 'source') f.sourceExecution.mockRejectedValueOnce(privateError)
    if (failedPhase === 'preview') f.preview.mockRejectedValueOnce(privateError)
    if (failedPhase === 'complete') f.ledger.complete.mockRejectedValueOnce(privateError)
    expect(await f.executor.execute(nonce, new AbortController().signal)).toEqual({ requestId: nonce, status: 'outcome_unknown' })
    expect(observer.mock.calls[0][0]).toMatchObject({ phase: failedPhase, firstStop: 'executor-failure',
      outcome: 'outcome_unknown', cleanupCount: 1 })
    expect(f.ledger.abandon).toHaveBeenCalledTimes(1)
    expect(getter).not.toHaveBeenCalled()
  })

  it('claim failure preserves the original rejection without creating an attempt, while pre-abort is an upstream refusal', async () => {
    const observer = vi.fn(), f = fixture('execution', observer), original = new Error('private claim details')
    f.ledger.claim.mockRejectedValueOnce(original)
    await expect(f.executor.execute(nonce, new AbortController().signal)).rejects.toBe(original)
    expect(observer.mock.calls[0][0]).toMatchObject({ phase: 'claim', firstStop: 'executor-failure',
      outcome: 'rejected', checkpointCount: 0, cleanupCount: 0 })
    const parent = new AbortController(); parent.abort('private upstream reason')
    await expect(f.executor.execute(nonce, parent.signal)).rejects.toThrow('AUTOMATION_READ_FENCE_LOST')
    expect(observer.mock.calls[1][0]).toMatchObject({ phase: 'claim', firstStop: 'upstream-abort',
      outcome: 'rejected', checkpointCount: 0, cleanupCount: 0 })
    expect(f.ledger.claim).toHaveBeenCalledTimes(1)
    expect(f.ledger.abandon).not.toHaveBeenCalled()
  })

  it('a proven succeeded COMMIT returned by abandon remains succeeded even if upstream stop won the local race', async () => {
    const observer = vi.fn(), f = fixture('execution', observer), parent = new AbortController()
    let entered!: () => void, finish!: (value: { requestId: string; status: string }) => void
    const completing = new Promise<void>(resolve => { entered = resolve })
    // Explicit ledger double, NOT proof of a database COMMIT. This checks only
    // that diagnostics preserve the actual returned success rather than infer it.
    f.ledger.complete.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; entered() }))
    f.ledger.abandon.mockResolvedValueOnce({ requestId: nonce, status: 'succeeded' })
    const running = f.executor.execute(nonce, parent.signal)
    await completing; parent.abort()
    expect(await running).toEqual({ requestId: nonce, status: 'succeeded' })
    expect(observer.mock.calls[0][0]).toMatchObject({ phase: 'complete', firstStop: 'upstream-abort',
      outcome: 'succeeded', cleanupCount: 1 })
    finish({ requestId: nonce, status: 'succeeded' }); await Promise.resolve()
    expect(observer).toHaveBeenCalledTimes(1)
  })

  it.each(['throw', 'reject', 'pending'] as const)('a host observer that will %s cannot affect success, permission or cause unhandled rejection', async mode => {
    const unhandled = vi.fn(), privateError = new Error('private observer details')
    process.on('unhandledRejection', unhandled)
    const observer = vi.fn(() => {
      if (mode === 'throw') throw privateError
      if (mode === 'reject') return Promise.reject(privateError)
      return new Promise<void>(() => {})
    })
    try {
      const f = fixture('execution', observer)
      await expect(f.executor.execute(nonce, new AbortController().signal)).resolves.toEqual({ requestId: nonce, status: 'succeeded' })
      await new Promise(resolve => setImmediate(resolve))
      expect(f.authority.lockExecution).toHaveBeenCalledTimes(1)
      expect(f.ledger.complete).toHaveBeenCalledTimes(1)
      expect(f.ledger.abandon).not.toHaveBeenCalled()
      expect(observer).toHaveBeenCalledTimes(1)
      expect(unhandled).not.toHaveBeenCalled()
    } finally { process.removeListener('unhandledRejection', unhandled) }
  })

  it('bounds elapsed time and checkpoint counters without changing the original execution limits', async () => {
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const observer = vi.fn(), f = fixture('execution', observer)
    f.preview.mockImplementationOnce(async input => {
      for (let index = 0; index < 10001; index++) await input.checkpoint()
      return result
    })
    // A slow abandon is receipt latency, not a longer authorization deadline.
    f.ledger.abandon.mockImplementationOnce(async () => { clock = 86400001; return { requestId: nonce, status: 'outcome_unknown' } })
    f.ledger.complete.mockRejectedValueOnce(new Error('private completion failure'))
    expect(await f.executor.execute(nonce, new AbortController().signal)).toMatchObject({ status: 'outcome_unknown' })
    expect(observer.mock.calls[0][0]).toMatchObject({ phase: 'complete', firstStop: 'executor-failure',
      outcome: 'outcome_unknown', elapsedMs: 86400000, checkpointCount: 10000, cleanupCount: 1 })
    expect(f.preview.mock.calls[0][0].budget.timeoutMs).toBe(10000)
    expect(f.ledger.checkpoint).toHaveBeenCalledTimes(10004)
  })
})
