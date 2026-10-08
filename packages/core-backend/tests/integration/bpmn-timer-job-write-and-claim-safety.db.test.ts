/**
 * #4783 owner review (2026-08-05) P1-1 + P1-2 — proved against REAL PostgreSQL, not a
 * mocked `db`. The mocked-`db` unit-level counterparts
 * (`src/workflow/__tests__/BPMNWorkflowEngine.timerWriteGate.test.ts` for P1-1,
 * `src/workflow/__tests__/BPMNWorkflowEngine.timerPoller.test.ts` for the poller gate
 * itself) prove the CALL shape; this file proves the actual DATABASE outcome, which is
 * what the invariant is actually about ("the system contains no timer job that will
 * never be processed").
 *
 * P1-1 (write gate): `createTimerJob` must reject a 'date'/'duration' timer write with
 * `BpmnTimerPollerDisabledError` while the poller is disabled, and — the thing a mock
 * cannot prove — the real `bpmn_timer_jobs` table must end up with ZERO rows for that
 * call, not merely "the mock wasn't invoked". A positive control (poller enabled) proves
 * the row DOES land when it's supposed to, per this repo's "assert-not-happening needs a
 * positive control" doctrine.
 *
 * P1-2 (atomic claim): `processTimerJob`'s WAITING -> LOCKED transition must be race-safe
 * across TWO INDEPENDENT `BPMNWorkflowEngine` instances sharing the same `db` pool — the
 * exact production topology (`routes/workflow.ts`'s eager instance +
 * `routes/workflow-designer.ts`'s lazy instance). This is proved with a CONSTRUCTED race,
 * not sequential reasoning: both instances' `processTimerJob` are invoked for the SAME
 * batch of already-WAITING rows via a single `Promise.all`, so their claim UPDATEs are
 * genuinely in flight concurrently against real Postgres (default pool max 20 — see
 * `src/integration/db/connection-pool.ts` — comfortably above this file's batch size).
 * Each instance's own `fireTimer` is replaced with a call-recording spy (never the real
 * `continueProcess` — no `bpmn_process_instances` fixture exists here; that machinery is
 * covered elsewhere) so the discriminating assertion is "which engine's spy recorded the
 * call", not merely "the row ended up COMPLETED" (both a correct claim and a double-fire
 * bug converge on the same final `state`).
 *
 * Isolation: every row this file touches is looked up by its own randomly-generated
 * UUID `id`/`process_instance_id` — `bpmn_timer_jobs` has no other reader/writer
 * anywhere in this codebase (grep-verified) and no other test file in this repo
 * references the table, so there is no shared-fixture collision risk even running in
 * the same CI step as unrelated suites.
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { BPMNWorkflowEngine } from '../../src/workflow/BPMNWorkflowEngine'
import { BPMN_TIMER_POLLER_ENABLED_ENV, BpmnTimerPollerDisabledError } from '../../src/workflow/bpmnTimerPollerConfig'

const databaseUrl = process.env.DATABASE_URL
const describeIfDatabase = databaseUrl ? describe : describe.skip

const require = createRequire(import.meta.url)
// Same require-cache singleton `BPMNWorkflowEngine.ts` itself binds to — spied here only
// to keep this file's own timer-instance construction from EVER scheduling a real
// repeating interval if any code path this file does not intend to exercise touches
// `scheduleRecurringTimer`. Neither P1-1 nor P1-2 legs below use 'cycle' timers, so this
// spy is not expected to be called; it exists purely as a safety net.
const cronModule = require('node-cron') as { schedule: (...args: unknown[]) => unknown }

interface EngineTimerInternals {
  createTimerJob: (
    instanceId: string,
    activityId: string,
    timerDef: { type: 'date' | 'duration' | 'cycle'; value: string; activityId: string }
  ) => Promise<void>
  processTimerJob: (job: { id: string; process_instance_id: string; activity_id: string; retries: number }) => Promise<void>
  fireTimer: (instanceId: string, activityId: string) => Promise<void>
}

function internals(engine: InstanceType<typeof BPMNWorkflowEngine>): EngineTimerInternals {
  return engine as unknown as EngineTimerInternals
}

function spiedEngine(label: string, calls: Array<{ engine: string; jobId: string }>): InstanceType<typeof BPMNWorkflowEngine> {
  const engine = new BPMNWorkflowEngine()
  internals(engine).fireTimer = async (instanceId: string) => {
    calls.push({ engine: label, jobId: instanceId })
  }
  return engine
}

describeIfDatabase('BPMNWorkflowEngine bpmn_timer_jobs write-and-claim safety (#4783 P1-1/P1-2, real PostgreSQL)', () => {
  let pool: Pool
  let scheduleSpy: ReturnType<typeof vi.spyOn>
  let originalEnv: string | undefined
  const createdInstanceIds: string[] = []
  const createdJobIds: string[] = []

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl })
  })

  afterAll(async () => {
    if (createdInstanceIds.length > 0) {
      await pool.query(`DELETE FROM bpmn_timer_jobs WHERE process_instance_id = ANY($1::uuid[])`, [createdInstanceIds])
    }
    if (createdJobIds.length > 0) {
      await pool.query(`DELETE FROM bpmn_timer_jobs WHERE id = ANY($1::uuid[])`, [createdJobIds])
    }
    await pool.end()
  })

  beforeEach(() => {
    originalEnv = process.env[BPMN_TIMER_POLLER_ENABLED_ENV]
    delete process.env[BPMN_TIMER_POLLER_ENABLED_ENV]
    scheduleSpy = vi.spyOn(cronModule, 'schedule').mockReturnValue({ start: vi.fn(), stop: vi.fn() })
  })

  afterEach(() => {
    scheduleSpy.mockRestore()
    if (originalEnv === undefined) delete process.env[BPMN_TIMER_POLLER_ENABLED_ENV]
    else process.env[BPMN_TIMER_POLLER_ENABLED_ENV] = originalEnv
  })

  // =====================================================================================
  // P1-1 — write gate, real database outcome.
  // =====================================================================================
  describe('P1-1 write gate', () => {
    it('poller disabled: "date" timer create rejects, and ZERO rows land in real bpmn_timer_jobs', async () => {
      const engine = new BPMNWorkflowEngine()
      const instanceId = randomUUID()
      createdInstanceIds.push(instanceId)

      await expect(
        internals(engine).createTimerJob(instanceId, randomUUID(), {
          type: 'date',
          value: '2026-01-01T00:00:00Z',
          activityId: 'act-gate',
        })
      ).rejects.toBeInstanceOf(BpmnTimerPollerDisabledError)

      const row = await pool.query('SELECT count(*)::int AS n FROM bpmn_timer_jobs WHERE process_instance_id = $1::uuid', [instanceId])
      expect(row.rows[0].n).toBe(0)
    })

    it('poller disabled: "duration" timer create rejects, and ZERO rows land', async () => {
      const engine = new BPMNWorkflowEngine()
      const instanceId = randomUUID()
      createdInstanceIds.push(instanceId)

      await expect(
        internals(engine).createTimerJob(instanceId, randomUUID(), {
          type: 'duration',
          value: 'PT5M',
          activityId: 'act-gate',
        })
      ).rejects.toBeInstanceOf(BpmnTimerPollerDisabledError)

      const row = await pool.query('SELECT count(*)::int AS n FROM bpmn_timer_jobs WHERE process_instance_id = $1::uuid', [instanceId])
      expect(row.rows[0].n).toBe(0)
    })

    it('poller ENABLED: "date" timer create succeeds, exactly ONE real WAITING row lands (positive control)', async () => {
      process.env[BPMN_TIMER_POLLER_ENABLED_ENV] = 'true'
      const engine = new BPMNWorkflowEngine()
      const instanceId = randomUUID()
      createdInstanceIds.push(instanceId)

      await expect(
        internals(engine).createTimerJob(instanceId, randomUUID(), {
          type: 'date',
          value: '2026-01-01T00:00:00Z',
          activityId: 'act-gate',
        })
      ).resolves.toBeUndefined()

      const row = await pool.query('SELECT state FROM bpmn_timer_jobs WHERE process_instance_id = $1::uuid', [instanceId])
      expect(row.rows).toHaveLength(1)
      expect(row.rows[0].state).toBe('WAITING')
    })
  })

  // =====================================================================================
  // P1-2 — atomic claim, constructed real concurrency across TWO engine instances.
  // =====================================================================================
  describe('P1-2 atomic claim', () => {
    it('two independent engine instances racing on the SAME batch of WAITING jobs: disjoint claims, zero double-fire, every job COMPLETED exactly once', async () => {
      const BATCH_SIZE = 12
      const jobs: Array<{ id: string; process_instance_id: string; activity_id: string; retries: number }> = []

      for (let i = 0; i < BATCH_SIZE; i++) {
        const jobId = randomUUID()
        const processInstanceId = randomUUID()
        const activityInstanceId = randomUUID()
        createdJobIds.push(jobId)
        await pool.query(
          `INSERT INTO bpmn_timer_jobs (id, process_instance_id, activity_instance_id, timer_type, due_date, state)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'date', now() - interval '1 minute', 'WAITING')`,
          [jobId, processInstanceId, activityInstanceId],
        )
        jobs.push({ id: jobId, process_instance_id: processInstanceId, activity_id: activityInstanceId, retries: 0 })
      }

      const calls: Array<{ engine: string; jobId: string }> = []
      const engineA = spiedEngine('A', calls)
      const engineB = spiedEngine('B', calls)

      // Genuine construction of the race: BOTH engines attempt EVERY job, all launched
      // together in one Promise.all — not sequential awaits per job or per engine. Each
      // call's first `await` is the claim UPDATE itself, so all 2*BATCH_SIZE claim
      // attempts are in flight against real Postgres at (as close as Node gets to)
      // the same moment.
      const attempts = jobs.flatMap((job) => [
        internals(engineA).processTimerJob(job),
        internals(engineB).processTimerJob(job),
      ])
      await Promise.all(attempts)

      // Disjoint claims: for every seeded job, EXACTLY one engine's fireTimer spy fired —
      // not zero (the claim must eventually succeed for someone) and not two (the bug
      // this fix closes).
      for (const job of jobs) {
        const firedFor = calls.filter((c) => c.jobId === job.process_instance_id)
        expect(firedFor, `job ${job.id} must be fired exactly once, got ${firedFor.length} (engines: ${firedFor.map((c) => c.engine).join(',')})`).toHaveLength(1)
      }
      expect(calls).toHaveLength(BATCH_SIZE)

      // Real database outcome: every job ends COMPLETED (the claimant that won ran
      // fireTimer -> success path -> state = 'COMPLETED'), never left LOCKED (which would
      // mean a claim succeeded but nothing ever completed it) or still WAITING.
      const finalStates = await pool.query(
        `SELECT id, state FROM bpmn_timer_jobs WHERE id = ANY($1::uuid[])`,
        [jobs.map((j) => j.id)],
      )
      expect(finalStates.rows).toHaveLength(BATCH_SIZE)
      for (const row of finalStates.rows) {
        expect(row.state, `job ${row.id} must end COMPLETED`).toBe('COMPLETED')
      }
    })

    it('a job already LOCKED by someone else: processTimerJob backs off (0 rows claimed), never fires, never marks FAILED', async () => {
      const jobId = randomUUID()
      const processInstanceId = randomUUID()
      const activityInstanceId = randomUUID()
      createdJobIds.push(jobId)
      await pool.query(
        `INSERT INTO bpmn_timer_jobs (id, process_instance_id, activity_instance_id, timer_type, due_date, state)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'date', now() - interval '1 minute', 'LOCKED')`,
        [jobId, processInstanceId, activityInstanceId],
      )

      const calls: Array<{ engine: string; jobId: string }> = []
      const engine = spiedEngine('solo', calls)
      await internals(engine).processTimerJob({ id: jobId, process_instance_id: processInstanceId, activity_id: activityInstanceId, retries: 0 })

      expect(calls).toHaveLength(0)
      const row = await pool.query('SELECT state FROM bpmn_timer_jobs WHERE id = $1::uuid', [jobId])
      expect(row.rows[0].state).toBe('LOCKED')
    })
  })
})
