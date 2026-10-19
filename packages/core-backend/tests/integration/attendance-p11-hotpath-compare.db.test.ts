/**
 * P1-1 settlement coordination, S5 G2 — a per-call record of two existing paths for a same-machine
 * base / head comparison (acceptance A12-P4: 「对既有生产路径做本地基线对照，不靠闭环吞吐宣称容量保证」).
 * BASE-RUNNABLE: it imports only what the base `d671019f2b` has (its harness included), so the main
 * session runs this same file on the base and on the head, on one machine, and files the two outputs
 * side by side as a record. It asserts nothing about speed and makes no capacity claim; the only
 * assertions are that every call returned what it returns in production.
 *
 * The two paths, both reached through the real composition root:
 *  1. The online-punch replay probe on the live boundary `index.ts` built. One call is one main-pool
 *     checkout through the composition root's connection provider, the pool's `connect` (where the head
 *     adds its nesting note), Gate E, the W4 runner's transaction and the boundary's releaser — every
 *     production layer P1-1 touched on a common path, with a fixture that writes nothing.
 *  2. `dispatchAction` in its default mode (an approve on a fresh one-node instance per call): the
 *     approval method whose signature and branches P1-1 changed.
 * The request-operation and record boundaries were the suggested alternatives; each call there writes
 * attendance rows and needs approval-flow and leave-type fixtures per org, so they are left to a run
 * that can be checked before it is filed.
 *
 * Per call: wall time of the call (ms, before post-commit quiet time), statements sent (= round trips),
 * main-pool checkouts, and the summed time those checkouts were held. Written to
 * `<P11_TRACE_DIR>/hotpath.json` when `P11_TRACE_DIR` is set (`P11_REF_LABEL` names the ref,
 * `P11_HOTPATH_N` the number of calls per path, default 30). Lock sampling is off: it would add a round
 * trip per statement to what is being timed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'

import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'
import {
  P11ApprovalFixtures,
  P11StatementRecorder,
  bootP11CompositionRoot,
  emptyP11EntryContext,
  p11Entries,
  seedP11PunchUser,
  writeP11TraceFile,
  type P11EntryContext,
  type P11EntryRun,
} from '../helpers/settlement-coordination-inertness-harness'

const dbUrl = process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(dbUrl).toBeTruthy()
})

const CALLS = Math.max(1, Number.parseInt(process.env.P11_HOTPATH_N ?? '30', 10) || 30)

interface CallRecord {
  readonly ms: number
  readonly statements: number
  readonly checkouts: number
  readonly heldMs: number
}

/** Wall time of the call, its statements, and how long each main-pool checkout was held (acquire → release). */
function measure(run: P11EntryRun<unknown>): CallRecord {
  const acquiredAt = new Map<string, number>()
  let heldMs = 0
  let checkouts = 0
  for (const step of run.trace.steps) {
    if (step.k === 'acquire' && typeof step.t === 'number') {
      acquiredAt.set(step.b, step.t)
      checkouts += 1
    }
    if (step.k === 'release' && typeof step.t === 'number' && acquiredAt.has(step.b)) {
      heldMs += step.t - (acquiredAt.get(step.b) as number)
      acquiredAt.delete(step.b)
    }
  }
  return {
    ms: Number(run.elapsedMs.toFixed(3)),
    statements: run.trace.steps.filter((step) => step.k === 'q').length,
    checkouts,
    heldMs: Number(heldMs.toFixed(3)),
  }
}

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

describeIfDatabase('P1-1 hot path — per-call record of two existing paths for a same-machine base / head comparison (A12-P4)', () => {
  const ctx: P11EntryContext = emptyP11EntryContext()
  let recorder: P11StatementRecorder | null = null
  const pending: string[] = []
  const output: { probe: CallRecord[]; dispatch: CallRecord[] } = { probe: [], dispatch: [] }

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    ctx.observer = new Pool({ connectionString: dbUrl, max: 2 })
    await ensureApprovalSchemaReady()
    ctx.boot = await bootP11CompositionRoot()
    if (!ctx.boot.server) throw ctx.boot.bootError ?? new Error('the composition root did not boot')
    recorder = new P11StatementRecorder({ observer: null, timing: true })
    recorder.install()
    recorder.observePool(ctx.boot.mainPool)
    ctx.fixtures = new P11ApprovalFixtures(ctx.boot.baseUrl, `hot${Date.now().toString(36)}`)
    ctx.people = await ctx.fixtures.people('hotpath')
    ctx.punchOrgId = randomUUID()
    ctx.punchUserId = await seedP11PunchUser(ctx.observer, ctx.punchOrgId)
    ctx.fixtures.userIds.add(ctx.punchUserId)
    // One pending instance per dispatch call, created outside every measured call.
    for (let i = 0; i < CALLS; i += 1) {
      const created = await p11Entries.createApproval(ctx.people)
      ctx.fixtures.instanceIds.add(created.id)
      pending.push(created.id)
    }
  }, 300_000)

  afterAll(async () => {
    recorder?.uninstall()
    try {
      if (ctx.observer && ctx.fixtures) await ctx.fixtures.cleanup(ctx.observer)
    } finally {
      await ctx.observer?.end()
      await ctx.boot?.server?.stop()
      ctx.boot?.restoreEnv()
    }
  }, 60_000)

  it(`online-punch replay probe: ${CALLS} calls on the composition root's live boundary, each finding no receipt`, async () => {
    const boundary = ctx.boot?.liveBoundary
    expect(boundary).toBeTruthy()
    for (let i = 0; i < CALLS; i += 1) {
      const run = await (recorder as P11StatementRecorder).run('hotpath.probe', () =>
        p11Entries.probe(boundary as NonNullable<typeof boundary>, ctx.punchOrgId as string, ctx.punchUserId as string),
      )
      expect(run.error).toBeUndefined()
      expect(run.result).toBeNull()
      output.probe.push(measure(run))
    }
  }, 300_000)

  it(`dispatchAction default mode: ${CALLS} approves, one per fresh one-node instance, each ending approved`, async () => {
    const approver = { userId: (ctx.people as { approverId: string }).approverId, userName: 'p11 approver', roles: [] as string[] }
    expect(pending).toHaveLength(CALLS)
    for (const instanceId of pending) {
      const run = await (recorder as P11StatementRecorder).run('hotpath.dispatch', () => p11Entries.dispatch(instanceId, 'approve', approver))
      expect(run.error).toBeUndefined()
      expect((run.result as { status?: unknown } | undefined)?.status).toBe('approved')
      output.dispatch.push(measure(run))
    }
  }, 300_000)

  it('writes the per-call record (no speed assertion, no capacity claim)', () => {
    expect({ probe: output.probe.length, dispatch: output.dispatch.length }).toEqual({ probe: CALLS, dispatch: CALLS })
    writeP11TraceFile('hotpath', {
      format: 'p11-hotpath/v1',
      ref: process.env.P11_REF_LABEL ?? null,
      node: process.version,
      poolMax: (ctx.boot?.mainPool as unknown as { options: { max: unknown } } | undefined)?.options.max ?? null,
      calls: CALLS,
      probe: output.probe,
      dispatch: output.dispatch,
    })
  })
})
