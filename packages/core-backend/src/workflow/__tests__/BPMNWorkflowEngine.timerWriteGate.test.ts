/**
 * #4783 owner review, P1-1 (2026-08-05): env-gating the POLLER off was not enough. The
 * poller only ever READS `bpmn_timer_jobs`; `BPMNWorkflowEngine.createTimerJob()` (the
 * only `INSERT INTO bpmn_timer_jobs` site in this codebase, see
 * `bpmnTimerPollerConfig.ts`) still unconditionally persisted a `state: 'WAITING'` row
 * for every `'date'`/`'duration'` timer regardless of the flag — and that write is
 * reachable from any authenticated user via `/api/workflow/start/:key`, task-complete,
 * message, and signal delivery (see `routes/workflow.ts`). "Current WAITING count is 0,
 * therefore safe to merge" does not survive a single new call after merge: the poller
 * being off means that new row can never be read back — a freshly-created orphan, not a
 * paused pre-existing one.
 *
 * These are the discriminating legs for the fix: `createTimerJob` must throw
 * `BpmnTimerPollerDisabledError` (a dedicated, values-free `code`) BEFORE the insert when
 * the poller is disabled, for `'date'`/`'duration'` timers only — `'cycle'` timers never
 * reach `bpmn_timer_jobs` at all (`scheduleRecurringTimer` is a separate, in-memory
 * `cron.schedule` path) and must stay completely unaffected by this gate.
 *
 * `db` is module-mocked (not a real Postgres connection — this is a unit-level gate
 * test) so the negative legs can assert `insertInto` is NEVER CALLED, not merely that its
 * result is unawaited, and the positive-control leg proves the insert still happens
 * (values-free assertion per repo doctrine "assert not happening always needs a positive
 * control"). The real-DB counterpart of this same invariant (zero rows land in a REAL
 * `bpmn_timer_jobs` table when disabled) lives in
 * `tests/integration/bpmn-timer-job-write-and-claim-safety.db.test.ts` alongside the
 * P1-2 atomic-claim proof.
 */
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BPMNWorkflowEngine } from '../BPMNWorkflowEngine'
import { BPMN_TIMER_POLLER_ENABLED_ENV, BpmnTimerPollerDisabledError } from '../bpmnTimerPollerConfig'

const insertValuesMock = vi.fn().mockReturnThis()
const insertExecuteMock = vi.fn().mockResolvedValue(undefined)
const insertIntoMock = vi.fn().mockReturnValue({
  values: insertValuesMock,
  execute: insertExecuteMock,
})

vi.mock('../../db/db', () => ({
  db: {
    insertInto: (...args: unknown[]) => insertIntoMock(...args),
  },
}))

const require = createRequire(import.meta.url)
// Same require-cache singleton `BPMNWorkflowEngine.ts` itself binds to at module load —
// spying here observes (and, for 'cycle', neutralizes) the class's own `cron.schedule`
// call without creating a real repeating interval.
const cronModule = require('node-cron') as { schedule: (...args: unknown[]) => unknown }

type EngineInternals = {
  createTimerJob: (
    instanceId: string,
    activityId: string,
    timerDef: { type: 'date' | 'duration' | 'cycle'; value: string; activityId: string }
  ) => Promise<void>
}

function internals(engine: InstanceType<typeof BPMNWorkflowEngine>): EngineInternals {
  return engine as unknown as EngineInternals
}

describe('BPMNWorkflowEngine.createTimerJob write-gate (#4783 P1-1)', () => {
  let originalEnv: string | undefined
  let scheduleSpy: ReturnType<typeof vi.spyOn>
  let fakeCronTask: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    originalEnv = process.env[BPMN_TIMER_POLLER_ENABLED_ENV]
    delete process.env[BPMN_TIMER_POLLER_ENABLED_ENV]
    insertIntoMock.mockClear()
    insertValuesMock.mockClear()
    insertExecuteMock.mockClear()
    fakeCronTask = { start: vi.fn(), stop: vi.fn() }
    scheduleSpy = vi.spyOn(cronModule, 'schedule').mockReturnValue(fakeCronTask)
  })

  afterEach(() => {
    scheduleSpy.mockRestore()
    if (originalEnv === undefined) delete process.env[BPMN_TIMER_POLLER_ENABLED_ENV]
    else process.env[BPMN_TIMER_POLLER_ENABLED_ENV] = originalEnv
  })

  it('poller disabled (env unset) + "date" timer: throws BpmnTimerPollerDisabledError, insertInto never called', async () => {
    const engine = new BPMNWorkflowEngine()
    await expect(
      internals(engine).createTimerJob('inst-1', 'act-1', {
        type: 'date',
        value: '2026-01-01T00:00:00Z',
        activityId: 'act-1',
      })
    ).rejects.toBeInstanceOf(BpmnTimerPollerDisabledError)
    expect(insertIntoMock).not.toHaveBeenCalled()
  })

  it('poller disabled + "date" timer: rejection carries the exact dedicated code, no other message shape', async () => {
    const engine = new BPMNWorkflowEngine()
    await expect(
      internals(engine).createTimerJob('inst-1', 'act-1', {
        type: 'date',
        value: '2026-01-01T00:00:00Z',
        activityId: 'act-1',
      })
    ).rejects.toMatchObject({
      name: 'BpmnTimerPollerDisabledError',
      code: 'BPMN_TIMER_POLLER_DISABLED',
      message: 'BPMN_TIMER_POLLER_DISABLED',
    })
  })

  it('poller disabled + "duration" timer: throws BpmnTimerPollerDisabledError, insertInto never called', async () => {
    const engine = new BPMNWorkflowEngine()
    await expect(
      internals(engine).createTimerJob('inst-1', 'act-1', {
        type: 'duration',
        value: 'PT5M',
        activityId: 'act-1',
      })
    ).rejects.toBeInstanceOf(BpmnTimerPollerDisabledError)
    expect(insertIntoMock).not.toHaveBeenCalled()
  })

  it('poller disabled + env set to a near-miss value ("TRUE"): still throws — enum-strict, not truthy coercion', async () => {
    process.env[BPMN_TIMER_POLLER_ENABLED_ENV] = 'TRUE'
    const engine = new BPMNWorkflowEngine()
    await expect(
      internals(engine).createTimerJob('inst-1', 'act-1', {
        type: 'date',
        value: '2026-01-01T00:00:00Z',
        activityId: 'act-1',
      })
    ).rejects.toBeInstanceOf(BpmnTimerPollerDisabledError)
    expect(insertIntoMock).not.toHaveBeenCalled()
  })

  it('poller disabled + "cycle" timer: NOT affected — never throws, never touches bpmn_timer_jobs, schedules via cron instead', async () => {
    const engine = new BPMNWorkflowEngine()
    await expect(
      internals(engine).createTimerJob('inst-1', 'act-1', {
        type: 'cycle',
        value: '*/5 * * * *',
        activityId: 'act-1',
      })
    ).resolves.toBeUndefined()
    expect(insertIntoMock).not.toHaveBeenCalled()
    expect(scheduleSpy).toHaveBeenCalledTimes(1)
    expect(scheduleSpy).toHaveBeenCalledWith('*/5 * * * *', expect.any(Function))
  })

  it('poller ENABLED ("true") + "date" timer: does not throw, insertInto called once with state WAITING (positive control)', async () => {
    process.env[BPMN_TIMER_POLLER_ENABLED_ENV] = 'true'
    const engine = new BPMNWorkflowEngine()
    await expect(
      internals(engine).createTimerJob('inst-1', 'act-1', {
        type: 'date',
        value: '2026-01-01T00:00:00Z',
        activityId: 'act-1',
      })
    ).resolves.toBeUndefined()

    expect(insertIntoMock).toHaveBeenCalledTimes(1)
    expect(insertIntoMock).toHaveBeenCalledWith('bpmn_timer_jobs')
    expect(insertValuesMock).toHaveBeenCalledTimes(1)
    const insertedValues = insertValuesMock.mock.calls[0][0] as Record<string, unknown>
    expect(insertedValues.state).toBe('WAITING')
    expect(insertedValues.process_instance_id).toBe('inst-1')
    expect(insertExecuteMock).toHaveBeenCalledTimes(1)
  })

  it('poller ENABLED ("true") + "duration" timer: does not throw, insertInto called once with state WAITING', async () => {
    process.env[BPMN_TIMER_POLLER_ENABLED_ENV] = 'true'
    const engine = new BPMNWorkflowEngine()
    await expect(
      internals(engine).createTimerJob('inst-1', 'act-1', {
        type: 'duration',
        value: 'PT5M',
        activityId: 'act-1',
      })
    ).resolves.toBeUndefined()

    expect(insertIntoMock).toHaveBeenCalledTimes(1)
    const insertedValues = insertValuesMock.mock.calls[0][0] as Record<string, unknown>
    expect(insertedValues.state).toBe('WAITING')
  })
})
