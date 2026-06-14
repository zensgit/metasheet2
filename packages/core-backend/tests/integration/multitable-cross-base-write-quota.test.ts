/**
 * Cross-base write QUOTA guardrail — per-target-base sliding/tumbling-window rate limit (real DB).
 *
 * The cross-base automation write path (executeCreateRecord / executeUpdateRecord, gated by
 * evaluateCrossBaseWrite) is the last governance chokepoint before an automation writes into ANOTHER
 * base. This guardrail caps the RATE of authorized cross-base writes per TARGET base inside a rolling
 * window: an allowed cross-base write increments a per-target-base counter; once the counter exceeds the
 * configured limit, further cross-base writes to that base are rejected fail-closed (step `failed`, NO
 * row), mirroring evaluateCrossBaseWrite's other rejections.
 *
 * Contract under test:
 *  - under-limit cross-base writes succeed and increment the counter;
 *  - the over-limit cross-base write → step `failed` (quota), NO row written;
 *  - SAME-BASE writes are NEVER counted (the gate short-circuits same-base before the quota) → no regression;
 *  - per-target-base ISOLATION: filling BASE_B to its limit does NOT block a write to BASE_C;
 *  - the limit is CONFIGURABLE — this suite injects a low limit + a private store via AutomationDeps so it
 *    cannot perturb the process-global default (which the sibling cross-base-automation-write suite uses).
 *
 * Drives the REAL AutomationExecutor with a real-DB queryFn (the executor is the write chokepoint). A
 * SINGLE executor instance is reused for the accumulating writes so the injected per-instance store
 * accumulates across calls (matches production: one long-lived executor per AutomationService).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { MemoryRateLimitStore } from '../../src/middleware/rate-limiter'
import { poolManager } from '../../src/integration/db/connection-pool'
import { EventBus } from '../../src/integration/events/event-bus'
import {
  AutomationExecutor,
  type AutomationDeps,
  type AutomationRule,
  type CrossBaseWriteQuotaConfig,
} from '../../src/multitable/automation-executor'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()

// Actor: owns every test base → base-write everywhere via ownership (so the ONLY gate that can fail in
// these canaries is the quota, not the base-write authority).
const OWNER = `u_q_owner_${TS}`

// Bases. BASE_A = trigger (source). BASE_B / BASE_C = distinct cross-base targets (isolation proof).
// BASE_D = exercised through the process-global DEFAULT singleton store (no injected store) by TWO
// executor instances → proves the counter survives re-construction (singleton, not per-instance Map).
const BASE_A = `base_q_a_${TS}`
const BASE_B = `base_q_b_${TS}`
const BASE_C = `base_q_c_${TS}`
const BASE_D = `base_q_d_${TS}`

// Sheets.
const SHEET_A = `sheet_q_a_${TS}` // trigger sheet (BASE_A)
const SHEET_B = `sheet_q_b_${TS}` // cross-base target sheet (BASE_B)
const SHEET_C = `sheet_q_c_${TS}` // cross-base target sheet (BASE_C)
const SHEET_D = `sheet_q_d_${TS}` // cross-base target sheet (BASE_D — default-singleton path)

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

// Build an executor with an INJECTED low-limit quota using a PRIVATE store, so this suite never touches
// the process-global default singleton (which sibling suites rely on at the generous default).
function makeExecutor(quota: CrossBaseWriteQuotaConfig): { executor: AutomationExecutor; eventBus: EventBus } {
  const eventBus = new EventBus()
  const deps: AutomationDeps = {
    eventBus,
    queryFn: (sql: string, params?: unknown[]) => q(sql, params),
    crossBaseWriteQuota: quota,
  }
  return { executor: new AutomationExecutor(deps), eventBus }
}

function ruleWith(action: { type: string; config: Record<string, unknown> }, createdBy: string): AutomationRule {
  return {
    id: `axr_q_${TS}_${Math.random().toString(36).slice(2, 8)}`,
    name: 'Quota rule',
    sheetId: SHEET_A,
    trigger: { type: 'record.created', config: {} },
    actions: [action as never],
    enabled: true,
    createdBy,
    createdAt: new Date().toISOString(),
  } as unknown as AutomationRule
}

const countRecords = async (sheetId: string): Promise<number> => {
  const r = await q('SELECT COUNT(*)::int AS n FROM meta_records WHERE sheet_id = $1', [sheetId])
  return (r.rows as Array<{ n: number }>)[0]?.n ?? 0
}

// A cross-base create into the given target sheet/base, run by OWNER.
function crossBaseCreate(targetSheet: string, targetBase: string, v: string): AutomationRule {
  return ruleWith({ type: 'create_record', config: { sheetId: targetSheet, targetBaseId: targetBase, data: { v } } }, OWNER)
}
const trigger = { recordId: '', sheetId: SHEET_A, actorId: OWNER, data: {} }

describeIfDatabase('cross-base write QUOTA guardrail (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3)', [BASE_A, 'Quota Base A', OWNER])
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3)', [BASE_B, 'Quota Base B', OWNER])
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3)', [BASE_C, 'Quota Base C', OWNER])
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3)', [BASE_D, 'Quota Base D', OWNER])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_A, BASE_A, 'Quota Trigger A'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_B, BASE_B, 'Quota Target B'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_C, BASE_C, 'Quota Target C'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_D, BASE_D, 'Quota Target D'])
  })

  afterAll(async () => {
    const sheets = [SHEET_A, SHEET_B, SHEET_C, SHEET_D]
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [sheets]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_A, BASE_B, BASE_C, BASE_D]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  // ── Q-1: under-limit cross-base writes all succeed; the over-limit write → failed (quota), NO row ──
  test('Q-1: with limit=3, the first 3 cross-base creates succeed; the 4th is rejected (quota), NO row', async () => {
    // Private store + low limit → isolated from the global default and from BASE_C below.
    const { executor } = makeExecutor({ limit: 3, windowMs: 60_000, store: new MemoryRateLimitStore() })
    const before = await countRecords(SHEET_B)

    for (let i = 1; i <= 3; i++) {
      const exec = await executor.execute(crossBaseCreate(SHEET_B, BASE_B, `q1-${i}`), trigger)
      expect(exec.steps[0]?.status).toBe('success')
    }
    expect(await countRecords(SHEET_B)).toBe(before + 3)

    // 4th exceeds the limit → fail-closed, no row.
    const over = await executor.execute(crossBaseCreate(SHEET_B, BASE_B, 'q1-over'), trigger)
    expect(over.steps[0]?.status).toBe('failed')
    expect(over.steps[0]?.error ?? '').toMatch(/quota/i)
    expect(await countRecords(SHEET_B)).toBe(before + 3) // no extra row written
  })

  // ── Q-2: SAME-BASE writes are NEVER counted (no regression) ─────────────────────────────────────
  // With limit=1, a single cross-base write to BASE_B exhausts the BASE_B budget. Same-base writes to
  // BASE_A must remain unlimited — the gate short-circuits same-base before the quota even runs.
  test('Q-2: same-base writes are never quota-limited (limit=1; many same-base creates all succeed)', async () => {
    const { executor } = makeExecutor({ limit: 1, windowMs: 60_000, store: new MemoryRateLimitStore() })
    const beforeA = await countRecords(SHEET_A)

    // Exhaust the BASE_B budget (1 allowed).
    const xb = await executor.execute(crossBaseCreate(SHEET_B, BASE_B, 'q2-xb'), trigger)
    expect(xb.steps[0]?.status).toBe('success')
    const xb2 = await executor.execute(crossBaseCreate(SHEET_B, BASE_B, 'q2-xb2'), trigger)
    expect(xb2.steps[0]?.status).toBe('failed') // BASE_B now over-limit

    // Same-base creates into SHEET_A (no targetBaseId) must NOT be counted → all succeed.
    for (let i = 0; i < 5; i++) {
      const same = await executor.execute(ruleWith({ type: 'create_record', config: { sheetId: SHEET_A, data: { v: `q2-same-${i}` } }, }, OWNER), trigger)
      expect(same.steps[0]?.status).toBe('success')
    }
    expect(await countRecords(SHEET_A)).toBe(beforeA + 5)
  })

  // ── Q-3: per-target-base ISOLATION — BASE_B at its limit does NOT block BASE_C ───────────────────
  test('Q-3: filling BASE_B to its limit does not block a cross-base write to BASE_C (per-base counters)', async () => {
    const { executor } = makeExecutor({ limit: 1, windowMs: 60_000, store: new MemoryRateLimitStore() })
    const beforeC = await countRecords(SHEET_C)

    // Saturate BASE_B (limit=1): 1 success then 1 quota-failure.
    expect((await executor.execute(crossBaseCreate(SHEET_B, BASE_B, 'q3-b'), trigger)).steps[0]?.status).toBe('success')
    expect((await executor.execute(crossBaseCreate(SHEET_B, BASE_B, 'q3-b2'), trigger)).steps[0]?.status).toBe('failed')

    // BASE_C has its own counter → a write to BASE_C still succeeds despite BASE_B being saturated.
    const cWrite = await executor.execute(crossBaseCreate(SHEET_C, BASE_C, 'q3-c'), trigger)
    expect(cWrite.steps[0]?.status).toBe('success')
    expect(await countRecords(SHEET_C)).toBe(beforeC + 1)
  })

  // ── Q-4: the limit is CONFIGURABLE — a higher injected limit allows more writes before rejecting ──
  test('Q-4: limit is configurable (limit=5 → 5 succeed, 6th rejected)', async () => {
    const { executor } = makeExecutor({ limit: 5, windowMs: 60_000, store: new MemoryRateLimitStore() })
    const before = await countRecords(SHEET_B)
    for (let i = 1; i <= 5; i++) {
      expect((await executor.execute(crossBaseCreate(SHEET_B, BASE_B, `q4-${i}`), trigger)).steps[0]?.status).toBe('success')
    }
    const over = await executor.execute(crossBaseCreate(SHEET_B, BASE_B, 'q4-over'), trigger)
    expect(over.steps[0]?.status).toBe('failed')
    expect(await countRecords(SHEET_B)).toBe(before + 5)
  })

  // ── Q-5: DEFAULT (process-global singleton) store — construction-INDEPENDENT counting ───────────
  // The previous canaries inject a PRIVATE store. This one omits `store` so the executor routes through
  // the module-level DEFAULT singleton at a low limit (limit override only). Two SEPARATE executor
  // instances share that counter: 2 writes via executor A succeed, then a 3rd write via a FRESHLY
  // constructed executor B is rejected. If the counter were a per-instance Map it would reset on B's
  // construction and the 3rd write would wrongly succeed → this proves the guardrail is not silently
  // defeated by re-construction (the exact prod failure mode the singleton design prevents). BASE_D is
  // touched by NO other test, so the shared singleton's per-process persistence is harmless here.
  test('Q-5: the default singleton store counts across distinct executor instances (construction-independent)', async () => {
    const cfg = { limit: 2, windowMs: 60_000 } // NO `store` → process-global default singleton
    const before = await countRecords(SHEET_D)

    const a = makeExecutor(cfg).executor
    expect((await a.execute(crossBaseCreate(SHEET_D, BASE_D, 'q5-a1'), trigger)).steps[0]?.status).toBe('success')
    expect((await a.execute(crossBaseCreate(SHEET_D, BASE_D, 'q5-a2'), trigger)).steps[0]?.status).toBe('success')

    // A brand-new executor instance — a per-instance Map would reset here. The singleton must NOT.
    const b = makeExecutor(cfg).executor
    const over = await b.execute(crossBaseCreate(SHEET_D, BASE_D, 'q5-b1'), trigger)
    expect(over.steps[0]?.status).toBe('failed')
    expect(over.steps[0]?.error ?? '').toMatch(/quota/i)
    expect(await countRecords(SHEET_D)).toBe(before + 2) // only the 2 under-limit writes landed
  })
})
