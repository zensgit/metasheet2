import { describe, expect, it, vi } from 'vitest'

// 项目接入 — the RUN. This suite drives the pure half of
// apps/web/src/services/integration/stockPreparation/projectSync.ts through an injected API double,
// so it never touches fetch and never needs a DOM.
//
// The three guarantees it exists to keep RED-witnessable:
//
//   G-1 A HELD PLAN IS 待办, NOT 故障. `manual_confirm_required` reports the PLAN as OK (a plan was
//       produced), reconciles the held rows into the confirmation queue, and SKIPS the write with the
//       pending count. It must never FAIL, and it must never apply — not even with the token the
//       server does mint in that state.
//   G-2 THE BATCH ARCHIVE IS NON-FATAL BUT VISIBLE. mvp-persist throwing leaves `report.imported`
//       true and the verdict `imported`, while the archive step itself is on screen as FAIL with its
//       status. Flag-off (its own error code) is a SKIP, not a failure.
//   G-3 NOTHING IS WRITTEN WHEN THE PLAN DOES NOT WARRANT IT. not_found / large-BOM / unappliable /
//       transport failure all stop before apply, and the archive is never attempted.
//
// VALUES-FREE: the doubles below plant business values (drawing numbers, material codes, project
// names, connection strings) in every response field a lazy implementation might carry through. No
// step detail may contain one.

import {
  BATCH_ARCHIVE_DISABLED_CODE,
  STOCK_PREPARATION_PROJECT_SYNC_STEPS,
  StockPreparationProjectSyncCallError,
  classifyPlanStep,
  clampErrorCode,
  plannedCountsOf,
  runStockPreparationProjectSync,
  summarizeProjectSync,
  writtenCountsOf,
  type StockPreparationProjectSyncApi,
  type StockPreparationProjectSyncReport,
} from '../src/services/integration/stockPreparation/projectSync'

const PROJECT_NO = 'P2026-001'

// Business values planted in EVERY response. None may reach a step detail.
const PLANTED_DRAWING = 'DWG-88472-A'
const PLANTED_MATERIAL = 'MAT-ZX9911'
const PLANTED_NAME = '涡轮增压器总成'
const PLANTED_SECRET = 'pwd=secret-42007'
const FORBIDDEN = [PLANTED_DRAWING, PLANTED_MATERIAL, PLANTED_NAME, PLANTED_SECRET]

function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'ready',
    canApply: true,
    dryRunToken: 'tok_abc',
    counts: { add: 3, update: 2, skip: 7, inactive: 1, manual_confirm: 0 },
    // Planted: the real route returns a large `evidence` object; nothing from it may be carried.
    evidence: { plan: { note: PLANTED_DRAWING }, source: PLANTED_SECRET },
    projectName: PLANTED_NAME,
    ...overrides,
  }
}

function applied(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'succeeded',
    apply: { counts: { created: 3, updated: 2, inactive: 1, skipped: 7, held: 0, failed: 0 }, written: 6 },
    evidence: { materialCode: PLANTED_MATERIAL },
    ...overrides,
  }
}

function archived(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'created',
    persisted: true,
    created: { batch: 1, lines: 12, run: 1 },
    source: { drawing: PLANTED_DRAWING },
    ...overrides,
  }
}

function makeApi(overrides: Partial<StockPreparationProjectSyncApi> = {}): StockPreparationProjectSyncApi {
  return {
    dryRun: vi.fn().mockResolvedValue(plan()),
    reconcile: vi.fn().mockResolvedValue({ counts: { created: 2, existing: 1, pending: 3 } }),
    apply: vi.fn().mockResolvedValue(applied()),
    archive: vi.fn().mockResolvedValue(archived()),
    ...overrides,
  } as StockPreparationProjectSyncApi
}

function stepOf(report: StockPreparationProjectSyncReport, id: string) {
  const found = report.steps.find((step) => step.id === id)
  expect(found, `step ${id} must be reported`).toBeDefined()
  return found!
}

function assertValuesFree(report: StockPreparationProjectSyncReport): void {
  const text = JSON.stringify(report.steps)
  for (const forbidden of FORBIDDEN) expect(text).not.toContain(forbidden)
}

describe('項目接入 — the four-step import run', () => {
  it('the happy path plans, skips the confirm step, writes, and archives', async () => {
    const api = makeApi()
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)

    expect(report.steps.map((step) => step.id)).toEqual(['dry-run', 'confirm-queue', 'apply', 'archive'])
    expect(stepOf(report, 'dry-run')).toMatchObject({ status: 'ok', reason: 'PLAN_READY' })
    expect(stepOf(report, 'confirm-queue')).toMatchObject({ status: 'skip', reason: 'NOTHING_TO_CONFIRM' })
    expect(stepOf(report, 'apply')).toMatchObject({ status: 'ok', reason: 'IMPORTED' })
    expect(stepOf(report, 'archive')).toMatchObject({ status: 'ok', reason: 'BATCH_ARCHIVED' })

    expect(report.imported).toBe(true)
    expect(report.verdict).toBe('imported')
    expect(report.pass).toBe(true)
    expect(report.planned).toEqual({ add: 3, update: 2, skip: 7, inactive: 1, manualConfirm: 0 })
    expect(report.written).toEqual({ created: 3, updated: 2, inactive: 1, skipped: 7, held: 0, failed: 0 })

    // The project number is passed through as the single allowlisted action parameter, and the apply
    // consumes THIS run's token.
    expect(api.dryRun).toHaveBeenCalledWith(PROJECT_NO)
    expect(api.apply).toHaveBeenCalledWith(PROJECT_NO, 'tok_abc')
    expect(api.reconcile).not.toHaveBeenCalled()
    assertValuesFree(report)
  })

  it('a second sync over unchanged data reports 已经是最新的 rather than a bare zero', async () => {
    const api = makeApi({
      dryRun: vi.fn().mockResolvedValue(plan({ counts: { add: 0, update: 0, skip: 12, inactive: 0, manual_confirm: 0 } })),
      apply: vi.fn().mockResolvedValue(applied({
        apply: { counts: { created: 0, updated: 0, inactive: 0, skipped: 12, held: 0, failed: 0 } },
      })),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'apply')).toMatchObject({ status: 'ok', reason: 'ALREADY_UP_TO_DATE' })
    expect(report.verdict).toBe('already_up_to_date')
    expect(report.imported).toBe(false) // nothing landed, because nothing needed to
    expect(report.pass).toBe(true)
  })

  // ---- G-1 ---------------------------------------------------------------------------------
  it('G-1: a held plan is 待办 — plan OK, rows queued, write SKIPPED, nothing FAILED', async () => {
    const api = makeApi({
      dryRun: vi.fn().mockResolvedValue(plan({
        status: 'manual_confirm_required',
        counts: { add: 4, update: 0, skip: 1, inactive: 0, manual_confirm: 5 },
      })),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)

    // The PLAN succeeded — a plan was produced. Only the WRITE is held.
    expect(stepOf(report, 'dry-run')).toMatchObject({ status: 'ok', reason: 'PLAN_HELD_FOR_CONFIRMATION' })
    expect(stepOf(report, 'confirm-queue')).toMatchObject({ status: 'ok', reason: 'CONFIRMATIONS_QUEUED' })
    expect(stepOf(report, 'apply')).toMatchObject({ status: 'skip', reason: 'WRITE_HELD_FOR_CONFIRMATION' })
    expect(stepOf(report, 'archive')).toMatchObject({ status: 'skip', reason: 'BATCH_ARCHIVE_NOT_ATTEMPTED' })

    // 待办, not 故障: no step failed, and the verdict is the one the panel renders as "one step to go".
    expect(report.failCount).toBe(0)
    expect(report.pass).toBe(true)
    expect(report.verdict).toBe('held')
    expect(report.imported).toBe(false)
    expect(report.pendingConfirmCount).toBe(5)
    expect(report.queuedDecisionCount).toBe(3)

    // The held rows were reconciled into the queue, and apply was NEVER called — not even with the
    // token the server mints in this state.
    expect(api.reconcile).toHaveBeenCalledWith(PROJECT_NO)
    expect(api.apply).not.toHaveBeenCalled()
    expect(api.archive).not.toHaveBeenCalled()
    assertValuesFree(report)
  })

  it('G-1: a held plan is detected from the manual_confirm COUNT even if the status token drifts', async () => {
    const api = makeApi({
      dryRun: vi.fn().mockResolvedValue(plan({
        status: 'ready',
        counts: { add: 1, update: 0, skip: 0, inactive: 0, manual_confirm: 2 },
      })),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'dry-run').reason).toBe('PLAN_HELD_FOR_CONFIRMATION')
    expect(api.apply).not.toHaveBeenCalled()
  })

  it('G-1: a reconcile refusal degrades to SKIP — it never turns a held plan into a failure', async () => {
    const api = makeApi({
      dryRun: vi.fn().mockResolvedValue(plan({
        status: 'manual_confirm_required',
        counts: { add: 0, update: 0, skip: 0, inactive: 0, manual_confirm: 2 },
      })),
      reconcile: vi.fn().mockRejectedValue(
        new StockPreparationProjectSyncCallError(409, '/reconcile', { code: 'CONFIRMATION_DECISION_RECONCILE_BUSY' }),
      ),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'confirm-queue')).toMatchObject({ status: 'skip', reason: 'RECONCILE_UNAVAILABLE' })
    expect(stepOf(report, 'confirm-queue').detail.code).toBe('CONFIRMATION_DECISION_RECONCILE_BUSY')
    expect(report.failCount).toBe(0)
    expect(report.verdict).toBe('held')
  })

  // 一线自己拉数据 — the operator runs steps 1 and 3 and is REFUSED steps 2 and 4 by design. Both
  // refusals must read as "not your step", not as a fault, and neither may redden the run: an
  // operator whose rows landed must see 「导进去了」, not a red line about somebody else's job.
  it('G-1b: a reconcile REFUSAL (403) is its own reason — not the transient one', async () => {
    const api = makeApi({
      dryRun: vi.fn().mockResolvedValue(plan({
        status: 'manual_confirm_required',
        counts: { add: 0, update: 0, skip: 0, inactive: 0, manual_confirm: 2 },
      })),
      reconcile: vi.fn().mockRejectedValue(
        new StockPreparationProjectSyncCallError(403, '/reconcile', { code: 'FORBIDDEN' }),
      ),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'confirm-queue')).toMatchObject({ status: 'skip', reason: 'RECONCILE_NOT_PERMITTED' })
    expect(stepOf(report, 'confirm-queue').detail.status).toBe(403)
    expect(report.failCount).toBe(0)
  })

  it('G-2b: an archive REFUSAL (403) is a SKIP, and the import still reads as done', async () => {
    const api = makeApi({
      archive: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(403, '/mvp-persist', { code: 'FORBIDDEN' })),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'archive')).toMatchObject({ status: 'skip', reason: 'BATCH_ARCHIVE_NOT_PERMITTED' })
    expect(report.imported).toBe(true)
    expect(report.failCount).toBe(0)
  })

  it('G-2c: a 401 is treated the same way — an unauthenticated archive is not a broken import', async () => {
    const api = makeApi({
      archive: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(401, '/mvp-persist', { code: 'UNAUTHENTICATED' })),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'archive')).toMatchObject({ status: 'skip', reason: 'BATCH_ARCHIVE_NOT_PERMITTED' })
    expect(report.imported).toBe(true)
  })

  // ---- G-2 ---------------------------------------------------------------------------------
  it('G-2: a failed batch archive is VISIBLE but never unmakes the import', async () => {
    const api = makeApi({
      archive: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(500, '/mvp-persist', { code: 'PERSIST_PLAN_TOO_LARGE' })),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)

    // VISIBLE: the step is on screen as a failure, with its status and code.
    expect(stepOf(report, 'archive')).toMatchObject({ status: 'fail', reason: 'BATCH_ARCHIVE_FAILED' })
    expect(stepOf(report, 'archive').detail).toMatchObject({ status: 500, code: 'PERSIST_PLAN_TOO_LARGE' })
    expect(report.failCount).toBe(1)
    expect(report.failedStepId).toBe('archive')

    // NON-FATAL: the BOM is in the sheet, and the panel's first sentence says so.
    expect(stepOf(report, 'apply')).toMatchObject({ status: 'ok', reason: 'IMPORTED' })
    expect(report.imported).toBe(true)
    expect(report.verdict).toBe('imported')
    assertValuesFree(report)
  })

  it('G-2: the archive being switched off for this deployment is a SKIP, not a failure', async () => {
    const api = makeApi({
      archive: vi.fn().mockRejectedValue(
        new StockPreparationProjectSyncCallError(403, '/mvp-persist', { code: BATCH_ARCHIVE_DISABLED_CODE }),
      ),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'archive')).toMatchObject({ status: 'skip', reason: 'BATCH_ARCHIVE_DISABLED' })
    expect(report.failCount).toBe(0)
    expect(report.pass).toBe(true)
    expect(report.imported).toBe(true)
    expect(report.verdict).toBe('imported')
  })

  it('G-2: an already-archived batch is reported as such rather than as a new one', async () => {
    const api = makeApi({
      archive: vi.fn().mockResolvedValue(archived({ status: 'skipped_existing', persisted: false, created: { batch: 0, lines: 0, run: 0 } })),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'archive')).toMatchObject({ status: 'ok', reason: 'BATCH_ALREADY_ARCHIVED' })
    expect(report.imported).toBe(true)
  })

  // ---- G-3 ---------------------------------------------------------------------------------
  it('G-3: an unknown project number stops before any write and says nothing was changed', async () => {
    const api = makeApi({
      dryRun: vi.fn().mockResolvedValue(plan({ status: 'not_found', canApply: false, dryRunToken: null, counts: {} })),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'dry-run')).toMatchObject({ status: 'skip', reason: 'PLAN_PROJECT_NOT_FOUND' })
    expect(report.steps.length).toBe(1)
    expect(report.failCount).toBe(0)
    expect(report.verdict).toBe('blocked')
    expect(api.reconcile).not.toHaveBeenCalled()
    expect(api.apply).not.toHaveBeenCalled()
    expect(api.archive).not.toHaveBeenCalled()
  })

  it('G-3: a bounded large-BOM preview is a SKIP that never applies', async () => {
    const api = makeApi({
      dryRun: vi.fn().mockResolvedValue(plan({ status: 'large_bom_bounded', canApply: false, dryRunToken: null })),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'dry-run')).toMatchObject({ status: 'skip', reason: 'PLAN_LARGE_BOM_BOUNDED' })
    expect(api.apply).not.toHaveBeenCalled()
  })

  it('G-3: an unappliable plan FAILS and writes nothing', async () => {
    const api = makeApi({
      dryRun: vi.fn().mockResolvedValue(plan({ status: 'failed', canApply: false, dryRunToken: null })),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'dry-run')).toMatchObject({ status: 'fail', reason: 'PLAN_NOT_APPLYABLE' })
    expect(report.pass).toBe(false)
    expect(api.apply).not.toHaveBeenCalled()
  })

  it('G-3: a transport failure on the plan never leaks the server body, only a status', async () => {
    const api = makeApi({
      dryRun: vi.fn().mockRejectedValue(
        new StockPreparationProjectSyncCallError(503, '/dry-run', { code: 'TABLE_ACTION_SOURCE_NOT_ACTIVE' }),
      ),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'dry-run')).toMatchObject({ status: 'fail', reason: 'PLAN_READ_FAILED' })
    expect(stepOf(report, 'dry-run').detail).toEqual({ status: 503, code: 'TABLE_ACTION_SOURCE_NOT_ACTIVE' })
    expect(api.apply).not.toHaveBeenCalled()
  })

  it('G-3: a malformed 2xx is its own failure, never a silent success', async () => {
    const api = makeApi({
      dryRun: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(200, '/dry-run', { malformed: true })),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'dry-run')).toMatchObject({ status: 'fail', reason: 'PLAN_MALFORMED_RESPONSE' })
    expect(api.apply).not.toHaveBeenCalled()
  })

  it('G-3: a plan that says canApply but mints no token skips the write instead of guessing', async () => {
    const api = makeApi({ dryRun: vi.fn().mockResolvedValue(plan({ dryRunToken: null })) })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'apply')).toMatchObject({ status: 'skip', reason: 'WRITE_NO_PLAN' })
    expect(stepOf(report, 'archive')).toMatchObject({ status: 'skip', reason: 'BATCH_ARCHIVE_NOT_ATTEMPTED' })
    expect(api.apply).not.toHaveBeenCalled()
  })

  // ---- G-4: a partial write is an IMPORT, and the verdict must say so ------------------------
  it('G-4: a partial write gets its OWN verdict — never the "nothing was changed" one', async () => {
    const api = makeApi({
      apply: vi.fn().mockResolvedValue(applied({
        status: 'partial',
        apply: { counts: { created: 2, updated: 0, inactive: 0, skipped: 0, held: 0, failed: 1 } },
      })),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'apply')).toMatchObject({ status: 'skip', reason: 'WRITE_PARTIAL' })
    // THE VERDICT, not just the step reason. Folding this into 'blocked' made the panel headline read
    // 「这次没有导入成功,数据没有变化」 over two rows that were sitting in the sheet.
    expect(report.verdict).toBe('partial')
    expect(report.verdict).not.toBe('blocked')
    // `imported` stays false — it means "the whole plan landed", which this did not — so the count of
    // what DID land has to be readable for the headline to be truthful.
    expect(report.imported).toBe(false)
    expect(report.written).toMatchObject({ created: 2, failed: 1 })
    // The archive still runs: rows landed, so this run has a batch worth keeping.
    expect(api.archive).toHaveBeenCalled()
  })

  it('G-4: "blocked" is reserved for runs where nothing was written', async () => {
    // Every path that reaches `blocked` must genuinely have changed nothing, or the headline lies.
    for (const api of [
      makeApi({ apply: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(500, '/apply')) }),
      makeApi({ dryRun: vi.fn().mockResolvedValue(plan({ status: 'failed', canApply: false, dryRunToken: null })) }),
      makeApi({ dryRun: vi.fn().mockResolvedValue(plan({ status: 'not_found', canApply: false, dryRunToken: null })) }),
      makeApi({ dryRun: vi.fn().mockResolvedValue(plan({ dryRunToken: null })) }),
    ]) {
      const report = await runStockPreparationProjectSync(api, PROJECT_NO)
      expect(report.verdict).toBe('blocked')
      const write = report.steps.find((step) => step.id === 'apply')
      expect(write === undefined || write.reason !== 'WRITE_PARTIAL').toBe(true)
    }
  })

  // ---- G-5: the archive outcome is a claim, so an unusable discriminator is not one -----------
  it('G-5: an archive response with no `persisted` gets an unknown outcome, not a positive claim', async () => {
    for (const archiveResponse of [
      { status: 'created', created: { batch: 1 } }, // no `persisted` at all
      { persisted: 'yes' }, // not a boolean
      {},
    ]) {
      const api = makeApi({ archive: vi.fn().mockResolvedValue(archiveResponse) })
      const report = await runStockPreparationProjectSync(api, PROJECT_NO)
      expect(stepOf(report, 'archive')).toMatchObject({ status: 'ok', reason: 'BATCH_ARCHIVE_OUTCOME_UNKNOWN' })
      // The import is untouched by the discriminator being unreadable.
      expect(report.imported).toBe(true)
    }
  })

  it('G-5: an explicit persisted:false still reads as already-archived', async () => {
    const api = makeApi({ archive: vi.fn().mockResolvedValue(archived({ persisted: false })) })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'archive')).toMatchObject({ status: 'ok', reason: 'BATCH_ALREADY_ARCHIVED' })
  })

  it('a failed write blocks the archive and reports 数据没有变化', async () => {
    const api = makeApi({
      apply: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(409, '/apply', { code: 'TABLE_ACTION_DRY_RUN_TOKEN_INVALID' })),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'apply')).toMatchObject({ status: 'fail', reason: 'WRITE_FAILED' })
    expect(stepOf(report, 'archive')).toMatchObject({ status: 'skip', reason: 'BATCH_ARCHIVE_NOT_ATTEMPTED' })
    expect(report.verdict).toBe('blocked')
    expect(api.archive).not.toHaveBeenCalled()
  })

  it('reports every step AS IT LANDS so a stopped run still shows what it got through', async () => {
    const seen: string[] = []
    const api = makeApi({
      apply: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(500, '/apply')),
    })
    await runStockPreparationProjectSync(api, PROJECT_NO, (step) => seen.push(`${step.id}:${step.status}`))
    expect(seen).toEqual(['dry-run:ok', 'confirm-queue:skip', 'apply:fail', 'archive:skip'])
  })
})

describe('項目接入 — the pure helpers', () => {
  it('the four steps are frozen, ordered, and each names one route', () => {
    expect(STOCK_PREPARATION_PROJECT_SYNC_STEPS.map((step) => step.id))
      .toEqual(['dry-run', 'confirm-queue', 'apply', 'archive'])
    for (const step of STOCK_PREPARATION_PROJECT_SYNC_STEPS) {
      expect(step.route).toMatch(/^POST \/api\/integration\/table-actions\/:actionId\//)
      expect(step.zh.length).toBeGreaterThan(0)
      expect(step.en.length).toBeGreaterThan(0)
    }
  })

  it('plannedCountsOf reads the server key names and defaults every gap to 0', () => {
    expect(plannedCountsOf({ add: 1, manual_confirm: 4 })).toEqual({
      add: 1, update: 0, skip: 0, inactive: 0, manualConfirm: 4,
    })
    expect(plannedCountsOf(undefined)).toEqual({ add: 0, update: 0, skip: 0, inactive: 0, manualConfirm: 0 })
    // A non-numeric count is not a count.
    expect(plannedCountsOf({ add: '7' as unknown as number })).toMatchObject({ add: 0 })
  })

  it('writtenCountsOf uses the apply vocabulary, which is NOT the plan vocabulary', () => {
    // The dry run says add/update/skip; the apply says created/updated/skipped. Reading one with the
    // other's keys silently reports zero everywhere, which is why they have separate readers.
    expect(writtenCountsOf({ add: 5 } as unknown as Record<string, number>)).toEqual({
      created: 0, updated: 0, inactive: 0, skipped: 0, held: 0, failed: 0,
    })
    expect(writtenCountsOf({ created: 5, failed: 1 })).toMatchObject({ created: 5, failed: 1 })
  })

  it('classifyPlanStep clamps an unknown status token instead of rendering it', () => {
    const step = classifyPlanStep(1, { status: '<script>alert(1)</script>', canApply: true, counts: {} })
    expect(step.detail.planStatus).toBe('other')
    expect(JSON.stringify(step)).not.toContain('script')
  })

  it('clampErrorCode keeps identifier-shaped codes and drops prose', () => {
    expect(clampErrorCode('TABLE_ACTION_SOURCE_NOT_ACTIVE')).toBe('TABLE_ACTION_SOURCE_NOT_ACTIVE')
    expect(clampErrorCode('connection failed for host=erp pwd=secret')).toBeNull()
    expect(clampErrorCode(42)).toBeNull()
    expect(clampErrorCode(undefined)).toBeNull()
  })

  it('summarizeProjectSync computes `imported` from the write step alone', () => {
    const write = { index: 3, id: 'apply' as const, status: 'ok' as const, reason: 'IMPORTED' as const, detail: {} }
    const archiveFailed = { index: 4, id: 'archive' as const, status: 'fail' as const, reason: 'BATCH_ARCHIVE_FAILED' as const, detail: {} }
    const report = summarizeProjectSync([write, archiveFailed], {
      pendingConfirmCount: 0, queuedDecisionCount: 0, planned: null, written: null,
      missingComponents: null, missingComponentsUnavailableReason: null,
    })
    // pass is false (something failed) yet imported is true (the rows are in the sheet). Collapsing
    // the two would tell an operator to re-run an import that already succeeded.
    expect(report.pass).toBe(false)
    expect(report.imported).toBe(true)
    expect(report.verdict).toBe('imported')
  })

  it('summarizeProjectSync reports not_run for an empty run', () => {
    const report = summarizeProjectSync([], {
      pendingConfirmCount: 0, queuedDecisionCount: 0, planned: null, written: null,
      missingComponents: null, missingComponentsUnavailableReason: null,
    })
    expect(report.verdict).toBe('not_run')
    expect(report.pass).toBe(true)
    expect(report.totalSteps).toBe(4)
  })
})
