/**
 * P1-1 settlement coordination, S5 G1 — production inertness at run time, from the real composition
 * root (acceptance A01-P1 / A01-P2). BASE-RUNNABLE: this file and its harness
 * (`tests/helpers/settlement-coordination-inertness-harness.ts`) import only modules that exist, with the same exports, at
 * the implementation base `d671019f2b`, so the same commit can be cherry-picked onto the base and run
 * there unchanged. The head-only half is `attendance-p11-inertness-head.db.test.ts`.
 *
 * What it does:
 *  - boots the real `MetaSheetServer` with the attendance plugin and a main pool of 9 connections. The
 *    §3.6 capacity rule (EXCL 2, SCAN 1, LONG 1 below 16, RESERVED 4, TXN = 9 − 8 = 1 < 2) rejects
 *    that size, so if anyone wires the new capacity validation into startup, the first test turns red
 *    (A01-M2). Startup itself must still succeed (A01-P2: no new startup refusal).
 *  - drives each existing entry the composition root reaches, the way its production caller drives it
 *    (see the harness's `P11_ENTRY_PLAN`): ordinary create and dispatch, the cancel round's default
 *    create and dispatch, W4 transition and closure, the sweep, W7 transition, and the online-punch
 *    replay probe on the boundary `index.ts` built;
 *  - records every statement each entry sends (any pool), every checkout and return on the main pool,
 *    and the advisory locks its backends hold after every statement;
 *  - asserts only what holds on both refs: the entry's outcome, that its writes run in a transaction
 *    its own connection opened (the default mode, A01-M1), that every borrow came back, and that no
 *    backend it used ever held a lock in the settlement-coordination key space;
 *  - writes each entry's normalised trace, and the active-resource counts after boot and after the
 *    entries (A01-P2: no new timer or handle), to `P11_TRACE_DIR` when that is set. The main session
 *    runs this file on the base and on the head and compares the two directories with
 *    `scripts/ops/p11-inertness-trace-compare.mjs`.
 *
 * Shared-database discipline: every fixture id is random and file-namespaced (`p11-…` user ids, random
 * org UUIDs); approval rows, users and memberships are deleted in `afterAll`. The W4 transition leaves
 * one rollout-state row for a random org (that table is append-only by design).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import net from 'node:net'
import { Pool } from 'pg'

import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'
import {
  P11ApprovalFixtures,
  P11StatementRecorder,
  P11_ENTRY_PLAN,
  P11_TRACE_FORMAT,
  activeResourceCounts,
  bootP11CompositionRoot,
  emptyP11EntryContext,
  expectLocksSampled,
  serializableTrace,
  settle,
  settlementCoordinationLocksOf,
  writeP11TraceFile,
  type P11EntryContext,
} from '../helpers/settlement-coordination-inertness-harness'

// Vitest hoists this above every import, so the pool manager (built when connection-pool is first
// evaluated, from DB_POOL_MAX) is built with 9 connections. The first test checks that it was.
const priorPoolMax = vi.hoisted(() => {
  const prior = process.env.DB_POOL_MAX
  process.env.DB_POOL_MAX = '9'
  return prior
})

const dbUrl = process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(dbUrl).toBeTruthy()
})

/** A main-pool size the §3.6 capacity validation rejects (TXN = 1); the head-only file proves it with the real validator. */
const POOL_MAX = 9

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

describeIfDatabase('P1-1 production inertness — existing entries through the real composition root (base-runnable baseline)', () => {
  const ctx: P11EntryContext = emptyP11EntryContext()
  let recorder: P11StatementRecorder | null = null
  let afterBoot: Record<string, number> | null = null

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    ctx.observer = new Pool({ connectionString: dbUrl, max: 2 })
    await ensureApprovalSchemaReady()
    ctx.boot = await bootP11CompositionRoot()
    if (!ctx.boot.server) return
    await settle(500)
    afterBoot = activeResourceCounts()
    recorder = new P11StatementRecorder({ observer: ctx.observer })
    recorder.install()
    recorder.observePool(ctx.boot.mainPool)
    ctx.fixtures = new P11ApprovalFixtures(ctx.boot.baseUrl, `base${Date.now().toString(36)}`)
    ctx.people = await ctx.fixtures.people('chain')
  }, 180_000)

  afterAll(async () => {
    recorder?.uninstall()
    try {
      if (ctx.observer && ctx.fixtures) await ctx.fixtures.cleanup(ctx.observer)
    } finally {
      await ctx.observer?.end()
      await ctx.boot?.server?.stop()
      ctx.boot?.restoreEnv()
      if (priorPoolMax === undefined) delete process.env.DB_POOL_MAX
      else process.env.DB_POOL_MAX = priorPoolMax
    }
  }, 60_000)

  it('startup: the composition root boots with a 9-connection main pool, which the §3.6 capacity check would reject (A01-P2; kills A01-M2)', () => {
    expect(ctx.boot?.bootError?.message ?? null).toBeNull()
    expect((ctx.boot?.mainPool as unknown as { options: { max: unknown } } | undefined)?.options.max).toBe(POOL_MAX)
  })

  for (const item of P11_ENTRY_PLAN) {
    it(item.title, async () => {
      expect(ctx.boot?.server, 'the composition root did not boot').toBeTruthy()
      await item.prepare?.(ctx)
      const run = await (recorder as P11StatementRecorder).run(item.id, () => item.run(ctx))
      writeP11TraceFile(item.id, item.written ? { format: P11_TRACE_FORMAT, entry: item.id, ...item.written(run) } : serializableTrace(run.trace))
      expectLocksSampled(run.trace)
      expect(settlementCoordinationLocksOf(run.trace)).toEqual([])
      await item.check(run, ctx)
    }, 60_000)
  }

  // Reached only as refusal legs above (same connection lifecycle and locks); the success paths need
  // fixtures no base suite builds in the shared database.
  it.todo('w4.closure success path — needs a committed legacy import batch with items and no W4 reference in the shared migrated database; both base rollout-control suites build that only in scratch databases with hand-made tables')
  it.todo('w7.transition success path — needs the W7 allowlist plus the producer-delivered and W4-posture predicates; the base W7-3 suite builds those only in a scratch database')

  it('resources: the active timer / handle counts after boot and after the entries are written for the base / head comparison (A01-P2)', async () => {
    expect(afterBoot).not.toBeNull()
    await settle(500)
    const afterEntries = activeResourceCounts()
    writeP11TraceFile('_resources', { format: P11_TRACE_FORMAT, afterBoot, afterEntries })
    writeP11TraceFile('_meta', {
      format: P11_TRACE_FORMAT,
      poolMax: POOL_MAX,
      node: process.version,
      entries: P11_ENTRY_PLAN.map((item) => item.id),
    })
    // Sanity only (the cross-ref comparison is the script's): the server has live handles after boot.
    expect(Object.keys(afterBoot as Record<string, number>).length).toBeGreaterThan(0)
    expect(Object.keys(afterEntries).length).toBeGreaterThan(0)
  })
})
