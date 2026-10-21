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
 * Database isolation: the file runs on its own scratch database, created and migrated with the full
 * migration set in `beforeAll` and dropped in `afterAll` (the harness's scratch-database section says
 * why: in CI every attendance file shares one database, and `running` scheduled runs other files leave
 * there made the sweep entry fail on a row it does not own). The `vi.hoisted` block below rebinds
 * `DATABASE_URL` to that database before any import builds the pool manager. Fixture ids stay random
 * and file-namespaced (`p11-…` user ids, random org UUIDs).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import net from 'node:net'
import { Pool } from 'pg'

import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'
import {
  P11ApprovalFixtures,
  P11StatementRecorder,
  P11_ENTRY_PLAN,
  P11_SCRATCH_MIGRATION_TIMEOUT_MS,
  P11_TRACE_FORMAT,
  activeResourceCounts,
  bootP11CompositionRoot,
  createP11ScratchDatabase,
  dropP11ScratchDatabase,
  emptyP11EntryContext,
  expectLocksSampled,
  migrateP11ScratchDatabase,
  p11MainPool,
  serializableTrace,
  settle,
  settlementCoordinationLocksOf,
  writeP11TraceFile,
  type P11EntryContext,
} from '../helpers/settlement-coordination-inertness-harness'
import { attachOwnedPoolTerminationHandler } from '../helpers/scratch-database'

// Vitest hoists this above every import, so the pool manager (built when connection-pool is first
// evaluated, from DB_POOL_MAX and DATABASE_URL) is built with 9 connections, on this file's scratch
// database. The first test checks the pool size. Imported bindings do not exist yet in here, so the
// name comes from the pid and Math.random (it matches the scratch helper's name whitelist). pg pools
// connect lazily: nothing connects to the database before `beforeAll` has created and migrated it.
const hoisted = vi.hoisted(() => {
  const priorPoolMax = process.env.DB_POOL_MAX
  const sharedUrl = process.env.DATABASE_URL
  process.env.DB_POOL_MAX = '9'
  let scratch: { name: string; url: string } | null = null
  if (sharedUrl) {
    const name = `ms2_p11base_${process.pid.toString(36)}${Math.random().toString(36).slice(2, 10).padEnd(8, '0')}`
    const url = new URL(sharedUrl)
    url.pathname = `/${name}`
    scratch = { name, url: url.toString() }
    process.env.DATABASE_URL = scratch.url
  }
  return { priorPoolMax, sharedUrl, scratch }
})

function restoreHoistedEnv(): void {
  if (hoisted.priorPoolMax === undefined) delete process.env.DB_POOL_MAX
  else process.env.DB_POOL_MAX = hoisted.priorPoolMax
  if (hoisted.sharedUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = hoisted.sharedUrl
}

/** The shared URL the run was given (the scratch database is reached through `hoisted.scratch`). */
const dbUrl = hoisted.sharedUrl
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
  let scratchCreated = false

  // Budget: the previous 180 s for the approval schema, the boot and the fixtures, plus the migration
  // child's own ceiling. A fresh database with the full migration set takes seconds in CI (about 7 s
  // for the whole step) and 30–55 s on the slower execution host, where the sweep call-through's 120 s
  // `beforeAll`, the same migration plus one boot, was seen to run out.
  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    const scratch = hoisted.scratch
    if (!scratch || !dbUrl) throw new Error('P11_SCRATCH_DATABASE_NOT_PREPARED')
    await createP11ScratchDatabase(dbUrl, scratch.name)
    scratchCreated = true
    await migrateP11ScratchDatabase(scratch.url)
    // The lock sampler filters `pg_locks` on the observer's own database, so it must be the scratch one.
    ctx.observer = new Pool({ connectionString: scratch.url, max: 2 })
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
  }, 180_000 + P11_SCRATCH_MIGRATION_TIMEOUT_MS)

  // No row-by-row cleanup: the scratch database is dropped. Teardown as in the sweep call-through
  // suite (#4791 / #4820): termination handlers on the pools this file owns, kept through stop and
  // drop; the drop runs even if closing or stopping failed, and the env is restored last.
  afterAll(async () => {
    recorder?.uninstall()
    const teardownHandlers = [p11MainPool(), ctx.observer]
      .filter((pool): pool is Pool => Boolean(pool))
      .map((pool) => attachOwnedPoolTerminationHandler(pool))
    try {
      try {
        await ctx.observer?.end()
      } finally {
        await ctx.boot?.server?.stop()
      }
    } finally {
      try {
        if (scratchCreated && hoisted.scratch && dbUrl) {
          await dropP11ScratchDatabase(dbUrl, hoisted.scratch.name, 'p11-inertness-baseline')
        }
      } finally {
        for (const handler of teardownHandlers) handler.detach()
        ctx.boot?.restoreEnv()
        restoreHoistedEnv()
      }
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
  // fixtures no base suite builds in a migrated database. The titles below predate this file's scratch
  // database and are kept as they are (the regression keys on them); "shared migrated database" there
  // means any database built by the migrations, which this file's scratch database also is.
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
