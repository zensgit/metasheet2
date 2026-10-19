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
  bootP11CompositionRoot,
  emptyP11EntryContext,
  settlementCoordinationLocksOf,
  type P11EntryContext,
} from '../helpers/settlement-coordination-inertness-harness'

// Hoisted above every import by Vitest: the same 9-connection main pool as the baseline file.
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

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    // Production mode for the whole file: a nested access is counted, not refused.
    previousMode = setSettlementCoordinationNestingModeV1('count')
    ctx.observer = new Pool({ connectionString: dbUrl, max: 2 })
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
  }, 180_000)

  afterAll(async () => {
    recorder?.uninstall()
    if (previousMode) setSettlementCoordinationNestingModeV1(previousMode)
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
