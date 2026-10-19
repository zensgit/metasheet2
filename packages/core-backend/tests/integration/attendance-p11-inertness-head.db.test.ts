/**
 * P1-1 settlement coordination, S5 G1 — the head-only half of the production-inertness baseline
 * (acceptance A01-P1 / A01-P2; kills A01-M3). The base-runnable half is
 * `attendance-p11-inertness-baseline.db.test.ts`; both drive the same entries through the same harness.
 *
 *  - The pool size both files boot with is one the §3.6 capacity validation rejects (the precondition
 *    that makes the baseline file's startup leg kill A01-M2).
 *  - During every existing entry, run through the real composition root with the nesting guard in its
 *    production mode (`'count'`, set here for the file and restored afterwards), no statement is ever
 *    sent inside an active coordination context and the production nested-access counter does not
 *    move. In `'count'` mode a nested access would not fail the entry, so the counter is the
 *    observation; checking the context on every statement (not only before and after) is what makes
 *    "never active" more than a spot check.
 *  - The production default nesting mode is `'count'`, observed in a fresh process that loads the
 *    context module without any test setup (`tests/helpers/settlement-coordination-mode-child.ts`): the
 *    setup files force `'throw'` in this process, so in-process state cannot show the module's own
 *    initializer. `vi.resetModules()` plus a dynamic import could give a second module instance, but
 *    whether the runner re-evaluates a module a setup file already loaded, or hands back that cached
 *    instance, is runner behaviour this file cannot pin without running it; a separate process (tsx,
 *    as `settlement-coordination-child-process.test.ts` spawns its child) loads the module the way
 *    production does, with no setup file and no test runner in it, so what it prints is the
 *    initializer's own mode.
 *
 * Database isolation, as in the baseline file: the DB half runs on its own scratch database, created
 * and migrated with the full migration set in `beforeAll` and dropped in `afterAll` (the harness's
 * scratch-database section says why). The `vi.hoisted` block below rebinds `DATABASE_URL` to it before
 * any import builds the pool manager. The fresh-process mode probe touches no database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { Pool } from 'pg'

import {
  deriveSettlementCoordinationCapacityV1,
  validateSettlementCoordinationCapacityV1,
} from '../../src/attendance/coordination/settlement-coordination-capacity'
import {
  currentSettlementCoordinationContextV1,
  setSettlementCoordinationNestingModeV1,
  settlementCoordinationNestedMainPoolAccessesV1,
  type SettlementCoordinationNestingModeV1,
} from '../../src/attendance/coordination/settlement-coordination-context'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'
import {
  P11ApprovalFixtures,
  P11StatementRecorder,
  P11_ENTRY_PLAN,
  P11_SCRATCH_MIGRATION_TIMEOUT_MS,
  bootP11CompositionRoot,
  createP11ScratchDatabase,
  dropP11ScratchDatabase,
  emptyP11EntryContext,
  migrateP11ScratchDatabase,
  p11MainPool,
  settlementCoordinationLocksOf,
  type P11EntryContext,
} from '../helpers/settlement-coordination-inertness-harness'
import { attachOwnedPoolTerminationHandler } from '../helpers/scratch-database'

// Hoisted above every import by Vitest: the same 9-connection main pool as the baseline file, built on
// this file's own scratch database (see the baseline file's hoisted block; pg pools connect lazily, so
// nothing connects before `beforeAll` has created and migrated it).
const hoisted = vi.hoisted(() => {
  const priorPoolMax = process.env.DB_POOL_MAX
  const sharedUrl = process.env.DATABASE_URL
  process.env.DB_POOL_MAX = '9'
  let scratch: { name: string; url: string } | null = null
  if (sharedUrl) {
    const name = `ms2_p11head_${process.pid.toString(36)}${Math.random().toString(36).slice(2, 10).padEnd(8, '0')}`
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

const POOL_MAX = 9
const REPO_ROOT = path.resolve(__dirname, '../../../..')
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const MODE_CHILD = path.resolve(__dirname, '../helpers/settlement-coordination-mode-child.ts')

describe('P1-1 production inertness — the nesting guard\'s production default, from a fresh process', () => {
  it('a fresh process that loads the context module without any test setup counts a nested main-pool access and starts in \'count\' mode (kills A01-M3)', () => {
    expect(fs.existsSync(TSX_CLI)).toBe(true)
    const result = spawnSync(process.execPath, [TSX_CLI, MODE_CHILD], { encoding: 'utf8', timeout: 30_000 })
    const lines = (result.stdout ?? '').split('\n').filter((line) => line.startsWith('MODE_PROBE'))
    expect({ status: result.status, lines }).toEqual({ status: 0, lines: ['MODE_PROBE counted 1 count'] })
  })
})

describeIfDatabase('P1-1 production inertness — existing entries never run inside a coordination context (head only)', () => {
  const ctx: P11EntryContext = emptyP11EntryContext()
  let recorder: P11StatementRecorder | null = null
  let previousMode: SettlementCoordinationNestingModeV1 | null = null
  /** Entries that sent a statement while a coordination context was active (must stay empty). */
  const insideContext: Array<{ label: string; sql: string }> = []
  let scratchCreated = false

  // Budget: the previous 180 s plus the migration child's ceiling (see the baseline file's budget note).
  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    const scratch = hoisted.scratch
    if (!scratch || !dbUrl) throw new Error('P11_SCRATCH_DATABASE_NOT_PREPARED')
    await createP11ScratchDatabase(dbUrl, scratch.name)
    scratchCreated = true
    await migrateP11ScratchDatabase(scratch.url)
    // Production mode for the whole file: a nested access is counted, not refused.
    previousMode = setSettlementCoordinationNestingModeV1('count')
    // The lock sampler filters `pg_locks` on the observer's own database, so it must be the scratch one.
    ctx.observer = new Pool({ connectionString: scratch.url, max: 2 })
    await ensureApprovalSchemaReady()
    ctx.boot = await bootP11CompositionRoot()
    if (!ctx.boot.server) return
    recorder = new P11StatementRecorder({
      observer: ctx.observer,
      onStatement: (label, sql) => {
        if (currentSettlementCoordinationContextV1() !== null) insideContext.push({ label, sql })
      },
    })
    recorder.install()
    recorder.observePool(ctx.boot.mainPool)
    ctx.fixtures = new P11ApprovalFixtures(ctx.boot.baseUrl, `head${Date.now().toString(36)}`)
    ctx.people = await ctx.fixtures.people('chain')
  }, 180_000 + P11_SCRATCH_MIGRATION_TIMEOUT_MS)

  // No row-by-row cleanup: the scratch database is dropped. Same teardown as the baseline file.
  afterAll(async () => {
    recorder?.uninstall()
    if (previousMode) setSettlementCoordinationNestingModeV1(previousMode)
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
          await dropP11ScratchDatabase(dbUrl, hoisted.scratch.name, 'p11-inertness-head')
        }
      } finally {
        for (const handler of teardownHandlers) handler.detach()
        ctx.boot?.restoreEnv()
        restoreHoistedEnv()
      }
    }
  }, 60_000)

  it('the 9-connection pool both inertness files boot with is one the §3.6 capacity validation rejects, and startup accepted it', () => {
    expect(validateSettlementCoordinationCapacityV1(deriveSettlementCoordinationCapacityV1({ poolMax: POOL_MAX }))).toEqual([
      'txnSlots must be at least 2',
    ])
    expect(ctx.boot?.bootError?.message ?? null).toBeNull()
    expect((ctx.boot?.mainPool as unknown as { options: { max: unknown } } | undefined)?.options.max).toBe(POOL_MAX)
  })

  for (const item of P11_ENTRY_PLAN) {
    it(`${item.title} — no coordination context on any statement, nested main-pool count unchanged`, async () => {
      expect(ctx.boot?.server, 'the composition root did not boot').toBeTruthy()
      await item.prepare?.(ctx)
      const nestedBefore = settlementCoordinationNestedMainPoolAccessesV1()
      const run = await (recorder as P11StatementRecorder).run(item.id, () => item.run(ctx))
      expect(run.trace.steps.filter((step) => step.k === 'q').length).toBeGreaterThan(0)
      expect(insideContext.filter((entry) => entry.label === item.id)).toEqual([])
      expect(settlementCoordinationNestedMainPoolAccessesV1()).toBe(nestedBefore)
      expect(currentSettlementCoordinationContextV1()).toBeNull()
      expect(settlementCoordinationLocksOf(run.trace)).toEqual([])
      // The entry ran as it does in production (same outcome checks as the baseline file).
      await item.check(run, ctx)
    }, 60_000)
  }
})

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}
