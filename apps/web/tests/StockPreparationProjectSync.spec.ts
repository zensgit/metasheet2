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
//
// R67 ④ (the last describe block) is the one exception to "never touches fetch": it drives the real
// wire client against a module-boundary `apiFetch` mock, because the enqueue + poll lives there.

const { wireFetch } = vi.hoisted(() => ({ wireFetch: vi.fn() }))
vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => wireFetch(...args),
}))

import {
  BATCH_ARCHIVE_DISABLED_CODE,
  STOCK_PREPARATION_DRY_RUN_JOB_INTERRUPTED_CODE,
  STOCK_PREPARATION_DRY_RUN_JOB_IN_PROGRESS_CODE,
  STOCK_PREPARATION_DRY_RUN_JOB_STORE_UNAVAILABLE_CODE,
  STOCK_PREPARATION_DRY_RUN_POLL_STOPPED_CODE,
  STOCK_PREPARATION_PROJECT_SYNC_STEPS,
  StockPreparationProjectSyncCallError,
  classifyArchiveFailure,
  clampErrorDetailToken,
  classifyPlanReadFailureReason,
  classifyPlanStep,
  classifyWriteLockFailure,
  clampErrorCode,
  createStockPreparationProjectSyncApi,
  plannedCountsOf,
  runStockPreparationProjectSync,
  sourceContentDigestOf,
  sourceScopeDigestOf,
  summarizeProjectSync,
  writtenCountsOf,
  type StockPreparationProjectSyncApi,
  type StockPreparationProjectSyncReport,
} from '../src/services/integration/stockPreparation/projectSync'
import { STOCK_PREP_SYNC_REASON_PLAIN, stockPrepErrorPlain } from '../src/services/integration/stockPreparation/plainLanguage'

const PROJECT_NO = 'P2026-001'

// Business values planted in EVERY response. None may reach a step detail.
const PLANTED_DRAWING = 'DWG-88472-A'
const PLANTED_MATERIAL = 'MAT-ZX9911'
const PLANTED_NAME = '涡轮增压器总成'
const PLANTED_SECRET = 'pwd=secret-42007'
const FORBIDDEN = [PLANTED_DRAWING, PLANTED_MATERIAL, PLANTED_NAME, PLANTED_SECRET]

// The shape the apply answers for `sourceScopeDigest` (#6475): 32 lowercase hex. Synthetic.
const SOURCE_DIGEST = '0123456789abcdef0123456789abcdef'
// …and for `sourceContentDigest` (#6475 round 2). Synthetic, distinct from the scope digest.
const CONTENT_DIGEST = 'fedcba9876543210fedcba9876543210'

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

  // ---- G-2 (#6475): the archive's own refusals, each with its own outcome --------------------
  // Every one of these used to render BATCH_ARCHIVE_FAILED's 「再同步一次通常就补上了」, which is false
  // for most of them. Unmapping any code from STOCK_PREP_ARCHIVE_REFUSAL_OUTCOMES turns its row red.
  // Review round 1: ONLY the unprovisioned tables are a SKIP. The two ledger refusals were SKIPs and
  // reported failCount 0 / pass true for an archive that stored nothing; they are FAILs again.
  it.each([
    ['PERSIST_TARGET_NOT_PROVISIONED', 409, 'skip', 'BATCH_ARCHIVE_TABLES_NOT_PROVISIONED'],
    ['PERSIST_IDEMPOTENCY_CONFLICT', 409, 'fail', 'BATCH_ARCHIVE_LEDGER_CONFLICT'],
    ['PERSIST_EXISTING_BATCH_INCOMPLETE', 409, 'fail', 'BATCH_ARCHIVE_PREVIOUS_INCOMPLETE'],
    ['TARGET_SCHEMA_INCOMPLETE', 422, 'fail', 'BATCH_ARCHIVE_SCHEMA_INCOMPLETE'],
    ['TARGET_SCHEMA_UNAVAILABLE', 503, 'fail', 'BATCH_ARCHIVE_SCHEMA_UNAVAILABLE'],
    ['TABLE_ACTION_SOURCE_NOT_ACTIVE', 409, 'fail', 'BATCH_ARCHIVE_SOURCE_NOT_ACTIVE'],
    ['TENANT_REQUIRED', 400, 'fail', 'BATCH_ARCHIVE_TENANT_REQUIRED'],
    ['STOCK_PREPARATION_MVP_SOURCE_BINDING_SPLIT', 409, 'fail', 'BATCH_ARCHIVE_SOURCE_BINDING_SPLIT'],
    ['STOCK_PREPARATION_MVP_SOURCE_PROJECT_NOT_FOUND', 404, 'fail', 'BATCH_ARCHIVE_SOURCE_PROJECT_NOT_FOUND'],
    ['STOCK_PREPARATION_MVP_SOURCE_EXPANSION_NOT_READY', 409, 'fail', 'BATCH_ARCHIVE_PLAN_NOT_READY'],
    ['STOCK_PREPARATION_MVP_SYNC_PARITY_MISMATCH', 409, 'fail', 'BATCH_ARCHIVE_SYNC_PARITY_MISMATCH'],
    // 客户反馈 2026-10-21 9b: three more refusals that fell through to the generic re-sync promise.
    ['STOCK_PREPARATION_MVP_SOURCE_EXPANSION_BOUNDED', 409, 'fail', 'BATCH_ARCHIVE_LARGE_BOM_BOUNDED'],
    ['PERSIST_PROJECT_POINTER_STALE', 409, 'fail', 'BATCH_ARCHIVE_POINTER_STALE'],
    ['PERSIST_VERSION_NOT_MONOTONIC', 422, 'fail', 'BATCH_ARCHIVE_VERSION_HISTORY'],
  ] as const)('G-2 #6475: archive refusal %s (%i) reports %s with its own reason, and the import still reads as done', async (code, status, expectedStatus, reason) => {
    const api = makeApi({
      archive: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(status, '/mvp-persist', { code })),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'archive')).toMatchObject({ status: expectedStatus, reason })
    expect(stepOf(report, 'archive').detail).toMatchObject({ status, code })
    expect(classifyArchiveFailure(status, code)).toEqual({ status: expectedStatus, reason })
    // NON-FATAL either way: the rows are in the sheet and the first sentence says so.
    expect(report.imported).toBe(true)
    expect(report.verdict).toBe('imported')
    expect(report.failCount).toBe(expectedStatus === 'fail' ? 1 : 0)
    expect(report.pass).toBe(expectedStatus !== 'fail')
    // Its own prose, in both languages, and not the generic 「再同步一次通常就补上了」.
    const plain = STOCK_PREP_SYNC_REASON_PLAIN[reason]
    expect(plain).toBeDefined()
    expect(plain.zh.length * plain.en.length * (plain.zhNext ?? '').length * (plain.enNext ?? '').length).toBeGreaterThan(0)
    expect(plain.zhNext).not.toBe(STOCK_PREP_SYNC_REASON_PLAIN.BATCH_ARCHIVE_FAILED.zhNext)
    expect(plain.zh.startsWith('数据已经写进去了')).toBe(true)
    // No refusal may promise that the clock fixes it: under the creation-hour rule the batch id is the
    // newest material's CREATION hour, not the wall clock (stock-preparation-batch-identity.cjs).
    expect(`${plain.zh}${plain.zhNext}`).not.toMatch(/下一个小时|下个小时/)
    expect(`${plain.en} ${plain.enNext}`.toLowerCase()).not.toContain('next hour')
    assertValuesFree(report)
  })

  it('G-2 #6475: each refusal names the administrator action that unblocks it', () => {
    const plainOf = (reason: string) => STOCK_PREP_SYNC_REASON_PLAIN[reason]!
    expect(plainOf('BATCH_ARCHIVE_TABLES_NOT_PROVISIONED').zhNext).toContain('mvp/ensure')
    expect(plainOf('BATCH_ARCHIVE_TABLES_NOT_PROVISIONED').enNext).toContain('mvp/ensure')
    expect(plainOf('BATCH_ARCHIVE_SCHEMA_INCOMPLETE').zhNext).toContain('mvp/repair')
    expect(plainOf('BATCH_ARCHIVE_SCHEMA_INCOMPLETE').enNext).toContain('mvp/repair')
    expect(plainOf('BATCH_ARCHIVE_SOURCE_NOT_ACTIVE').zhNext).toContain('重新启用')
    expect(plainOf('BATCH_ARCHIVE_SOURCE_NOT_ACTIVE').enNext).toContain('re-enable')
    expect(plainOf('BATCH_ARCHIVE_TENANT_REQUIRED').zhNext).toContain('所属租户')
    expect(plainOf('BATCH_ARCHIVE_LEDGER_CONFLICT').zhNext).toContain('target/reason')
    expect(plainOf('BATCH_ARCHIVE_LEDGER_CONFLICT').enNext).toContain('target/reason')
    expect(plainOf('BATCH_ARCHIVE_PREVIOUS_INCOMPLETE').zhNext).toContain('修复流程')
    expect(plainOf('BATCH_ARCHIVE_PREVIOUS_INCOMPLETE').enNext).toContain('repair procedure')
    expect(plainOf('BATCH_ARCHIVE_SOURCE_BINDING_SPLIT').zhNext).toContain('数据从哪里来')
    expect(plainOf('BATCH_ARCHIVE_SOURCE_BINDING_SPLIT').enNext).toContain('Where the data comes from')
    expect(plainOf('BATCH_ARCHIVE_PLAN_NOT_READY').zhNext).toContain('确认队列')
  })

  // ---- review round 1, blockers 6-8: the ledger refusals are not "a copy was kept" --------------
  it.each([
    // blocker 6: a project ledger with two rows for one project — checked on EVERY persist, permanent.
    ['PERSIST_IDEMPOTENCY_CONFLICT', 'project', 'duplicate_key'],
    // blocker 7: the creation-hour rule's batch id already holds different content; no copy of THIS sync exists.
    ['PERSIST_IDEMPOTENCY_CONFLICT', 'snapshot_batch', 'content_mismatch'],
    // blocker 8: a half-written earlier copy; an unchanged BOM keeps hitting it until an administrator repairs it.
    ['PERSIST_EXISTING_BATCH_INCOMPLETE', 'run', 'missing'],
  ] as const)('round 1: %s {%s, %s} is a visible FAIL that claims no kept copy and promises no self-healing', async (code, target, detailReason) => {
    const api = makeApi({
      archive: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(409, '/mvp-persist', { code, detailTarget: target, detailReason })),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    const step = stepOf(report, 'archive')
    expect(step.status).toBe('fail')
    expect(report.failCount).toBe(1)
    expect(report.pass).toBe(false)
    expect(report.imported).toBe(true)
    // The closed pair rides to the technical detail, so an administrator can tell the states apart.
    expect(step.detail).toEqual({ status: 409, code, target, reason: detailReason })
    const plain = STOCK_PREP_SYNC_REASON_PLAIN[step.reason]!
    // Nothing was stored, so no sentence may say a copy of this batch exists…
    expect(plain.en).not.toMatch(/already kept|was kept \(/)
    expect(plain.zh).not.toContain('已存过一份')
    // …and none may promise that waiting or re-syncing alone clears it.
    expect(plain.zhNext).not.toMatch(/下一个小时|稍后再同步/)
    expect(plain.enNext!.toLowerCase()).not.toMatch(/next hour|sync again later/)
  })

  it('round 1: a detail token that is not lower_snake is dropped, never carried', () => {
    const error = new StockPreparationProjectSyncCallError(409, '/mvp-persist', {
      code: 'PERSIST_IDEMPOTENCY_CONFLICT',
      detailTarget: `project ${PLANTED_MATERIAL}`,
      detailReason: PLANTED_SECRET,
    })
    expect(error.detailTarget).toBeNull()
    expect(error.detailReason).toBeNull()
    expect(clampErrorDetailToken('snapshot_batch')).toBe('snapshot_batch')
    expect(clampErrorDetailToken('Snapshot_Batch')).toBeNull()
    expect(clampErrorDetailToken('x'.repeat(49))).toBeNull()
    expect(clampErrorDetailToken(42)).toBeNull()
  })

  // ---- review round 1, blockers 1-3: step ④ carries step ③'s source digest ------------------------
  it('round 1: the apply\'s source digest is handed to the archive verbatim', async () => {
    const api = makeApi({ apply: vi.fn().mockResolvedValue(applied({ sourceScopeDigest: SOURCE_DIGEST })) })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'archive')).toMatchObject({ status: 'ok', reason: 'BATCH_ARCHIVED' })
    expect(api.archive).toHaveBeenCalledWith(PROJECT_NO, { sourceScopeDigest: SOURCE_DIGEST })
    // The digest is a server handle, not a business value — but it is still not a step detail.
    expect(JSON.stringify(report.steps)).not.toContain(SOURCE_DIGEST)
  })

  // ---- review round 2: step ④ carries step ③'s content digest; a partial ③ is not archived ------
  it('round 2: the apply\'s content digest is handed to the archive verbatim, beside the scope digest', async () => {
    const api = makeApi({ apply: vi.fn().mockResolvedValue(applied({ sourceScopeDigest: SOURCE_DIGEST, sourceContentDigest: CONTENT_DIGEST })) })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'archive')).toMatchObject({ status: 'ok', reason: 'BATCH_ARCHIVED' })
    expect(api.archive).toHaveBeenCalledWith(PROJECT_NO, { sourceScopeDigest: SOURCE_DIGEST, sourceContentDigest: CONTENT_DIGEST })
    expect(JSON.stringify(report.steps)).not.toContain(CONTENT_DIGEST)
    // Each digest stands on its own: a malformed content digest is dropped, the scope digest still rides.
    const malformed = makeApi({ apply: vi.fn().mockResolvedValue(applied({ sourceScopeDigest: SOURCE_DIGEST, sourceContentDigest: CONTENT_DIGEST.toUpperCase() })) })
    await runStockPreparationProjectSync(malformed, PROJECT_NO)
    expect(malformed.archive).toHaveBeenCalledWith(PROJECT_NO, { sourceScopeDigest: SOURCE_DIGEST })
    expect(sourceContentDigestOf(CONTENT_DIGEST)).toBe(CONTENT_DIGEST)
    expect(sourceContentDigestOf(`${CONTENT_DIGEST}0`)).toBeNull()
    expect(sourceContentDigestOf(PLANTED_SECRET)).toBeNull()
  })

  it('round 2: the parity refusal names both causes and the one next step, with its reason in the detail', async () => {
    const api = makeApi({
      archive: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(409, '/mvp-persist', {
        code: 'STOCK_PREPARATION_MVP_SYNC_PARITY_MISMATCH', detailReason: 'sheet_not_settled',
      })),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'archive')).toMatchObject({ status: 'fail', reason: 'BATCH_ARCHIVE_SYNC_PARITY_MISMATCH' })
    expect(stepOf(report, 'archive').detail).toEqual({ status: 409, code: 'STOCK_PREPARATION_MVP_SYNC_PARITY_MISMATCH', reason: 'sheet_not_settled' })
    const plain = STOCK_PREP_SYNC_REASON_PLAIN.BATCH_ARCHIVE_SYNC_PARITY_MISMATCH
    for (const token of ['source_changed_since_write', 'sheet_not_settled']) {
      expect(plain.zhNext).toContain(token)
      expect(plain.enNext).toContain(token)
    }
    expect(plain.en).not.toMatch(/already kept|was kept \(/)
  })

  it('round 2 (review blocker 3): the ledger-conflict copy no longer blames only a corrected BOM, and clears a notes edit', () => {
    const plain = STOCK_PREP_SYNC_REASON_PLAIN.BATCH_ARCHIVE_LEDGER_CONFLICT
    // The other creation-hour cause the copy owes the operator: a BOM back to an older batch's hour.
    expect(plain.zhNext).toContain('更早一个批次')
    expect(plain.enNext).toContain('changed back to an earlier batch')
    // And a 备注 edit — the review's P2 — no longer ends here, so the copy must not leave that open.
    expect(plain.zhNext).toContain('备注')
    expect(plain.enNext).toContain('such as notes, does not end here')
  })

  it('round 1: no digest, or one of the wrong shape, keeps the one-argument archive call', async () => {
    for (const sourceScopeDigest of [undefined, '', SOURCE_DIGEST.toUpperCase(), `${SOURCE_DIGEST}0`, PLANTED_SECRET, 42]) {
      const api = makeApi({ apply: vi.fn().mockResolvedValue(applied({ sourceScopeDigest })) })
      await runStockPreparationProjectSync(api, PROJECT_NO)
      expect(api.archive).toHaveBeenCalledWith(PROJECT_NO)
      expect((api.archive as ReturnType<typeof vi.fn>).mock.calls[0]).toHaveLength(1)
    }
    expect(sourceScopeDigestOf(SOURCE_DIGEST)).toBe(SOURCE_DIGEST)
    expect(sourceScopeDigestOf(SOURCE_DIGEST.slice(1))).toBeNull()
  })

  it('round 1 (blocker 3): the disabled-source copy no longer tells anyone to revive a source blindly', () => {
    const plain = STOCK_PREP_SYNC_REASON_PLAIN.BATCH_ARCHIVE_SOURCE_NOT_ACTIVE
    // It names BOTH administrator outcomes, and forbids re-enabling a retired source for the archive's sake.
    expect(plain.zhNext).toContain('数据从哪里来')
    expect(plain.zhNext).toContain('不要为了存档把旧来源重新启用')
    expect(plain.enNext).toContain('do not re-enable a retired source')
    expect(plain.zhNext).not.toBe('存档要再读一次数据来源,而它只读启用中的来源。请管理员在「数据来源」里把它重新启用,再同步一次。')
    // The split and the project-not-found answers have their own lines, not the generic 「再同步一次」.
    expect(classifyArchiveFailure(404, 'STOCK_PREPARATION_MVP_SOURCE_PROJECT_NOT_FOUND').reason).toBe('BATCH_ARCHIVE_SOURCE_PROJECT_NOT_FOUND')
    expect(classifyArchiveFailure(409, 'STOCK_PREPARATION_MVP_SOURCE_BINDING_SPLIT').reason).toBe('BATCH_ARCHIVE_SOURCE_BINDING_SPLIT')
  })

  it('round 1 (blocker 5): the tenant copy no longer claims the page cannot choose the tenant', () => {
    const plain = STOCK_PREP_SYNC_REASON_PLAIN.BATCH_ARCHIVE_TENANT_REQUIRED
    // False in the default configuration: a claimless token's tenant IS the x-tenant-id the page sends.
    expect(plain.zhNext).not.toContain('不接受页面上选的租户')
    expect(plain.enNext).not.toContain('never one chosen on the page')
    expect(plain.zhNext).toContain('浏览器随请求带上的租户')
    expect(plain.enNext).toContain('the tenant the browser sends along with the request')
  })

  it('G-2 #6475: the old precedence is kept — flag-off and 401/403 first; an unmapped code stays the generic failure', () => {
    // A refusal by the flag or by the tier is classified BEFORE the per-code table, whatever the code.
    expect(classifyArchiveFailure(403, BATCH_ARCHIVE_DISABLED_CODE)).toEqual({ status: 'skip', reason: 'BATCH_ARCHIVE_DISABLED' })
    expect(classifyArchiveFailure(403, 'PERSIST_TARGET_NOT_PROVISIONED')).toEqual({ status: 'skip', reason: 'BATCH_ARCHIVE_NOT_PERMITTED' })
    expect(classifyArchiveFailure(401, null)).toEqual({ status: 'skip', reason: 'BATCH_ARCHIVE_NOT_PERMITTED' })
    // Not in the table: still the visible, non-fatal FAIL it always was. (PERSIST_PROJECT_POINTER_STALE
    // stood here until 9b mapped it; PERSIST_EXISTING_BATCH_READ_UNPROVABLE is a real, still-unmapped one.)
    expect(classifyArchiveFailure(409, 'PERSIST_EXISTING_BATCH_READ_UNPROVABLE')).toEqual({ status: 'fail', reason: 'BATCH_ARCHIVE_FAILED' })
    expect(classifyArchiveFailure(500, 'PERSIST_PLAN_TOO_LARGE')).toEqual({ status: 'fail', reason: 'BATCH_ARCHIVE_FAILED' })
    expect(classifyArchiveFailure(0, null)).toEqual({ status: 'fail', reason: 'BATCH_ARCHIVE_FAILED' })
    // Own-property lookup: an inherited key is not in the table (the wire clamp would never pass this
    // lowercase token, but the classifier must not depend on that).
    expect(classifyArchiveFailure(409, 'constructor')).toEqual({ status: 'fail', reason: 'BATCH_ARCHIVE_FAILED' })
  })

  // ---- 客户反馈 2026-10-21 9b: refusals classified by HTTP status, after the code table ----------
  it('9b: a 404 with NO usable code is the archive not finding the PLM source, not the generic failure', async () => {
    const api = makeApi({
      archive: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(404, '/mvp-persist', {})),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    const step = stepOf(report, 'archive')
    expect(step).toMatchObject({ status: 'fail', reason: 'BATCH_ARCHIVE_SOURCE_SYSTEM_NOT_FOUND' })
    // No code reached the client, so the HTTP status is the one token the technical detail carries.
    expect(step.detail).toEqual({ status: 404 })
    expect(report.imported).toBe(true)
    expect(report.failCount).toBe(1)
    const plain = STOCK_PREP_SYNC_REASON_PLAIN.BATCH_ARCHIVE_SOURCE_SYSTEM_NOT_FOUND
    expect(plain.zh.startsWith('数据已经写进去了')).toBe(true)
    expect(plain.zhNext).toContain('status=404')
    expect(plain.enNext).toContain('status=404')
    expect(plain.zhNext).toContain('平台管理员')
    // Review round 1 (F7): a likely cause, never an assertion that the archive ignores every workspace.
    expect(plain.zhNext).toContain('再同步一般不会改变')
    expect(plain.zhNext).toContain('最常见的原因')
    expect(plain.zhNext).not.toContain('只找得到租户级')
    expect(plain.enNext).toContain('The most common cause')
    expect(plain.enNext).not.toContain('only finds a tenant-wide one')
    // A 404 that DID carry a code keeps that code's own reason; an unmapped coded 404 stays generic.
    expect(classifyArchiveFailure(404, 'STOCK_PREPARATION_MVP_SOURCE_PROJECT_NOT_FOUND').reason).toBe('BATCH_ARCHIVE_SOURCE_PROJECT_NOT_FOUND')
    expect(classifyArchiveFailure(404, 'SOME_OTHER_NOT_FOUND')).toEqual({ status: 'fail', reason: 'BATCH_ARCHIVE_FAILED' })
    assertValuesFree(report)
  })

  it('9b: on the wire, ExternalSystemNotFoundError (a class-name code the clamp drops) lands on the source-not-found reason', async () => {
    wireFetch.mockReset()
    wireFetch.mockImplementation(async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'ExternalSystemNotFoundError', message: 'external system not found', details: { id: PLANTED_SECRET } },
    }), { status: 404 }))
    const error = await createStockPreparationProjectSyncApi({ tenantId: 'syn-tenant' }).archive(PROJECT_NO).then(() => null, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(StockPreparationProjectSyncCallError)
    expect(error).toMatchObject({ status: 404, code: null })
    expect(JSON.stringify(error)).not.toContain(PLANTED_SECRET)
    const failure = error as StockPreparationProjectSyncCallError
    expect(classifyArchiveFailure(failure.status, failure.code)).toEqual({ status: 'fail', reason: 'BATCH_ARCHIVE_SOURCE_SYSTEM_NOT_FOUND' })
  })

  it.each([
    [503, null],
    [503, 'STOCK_PREPARATION_MVP_PROVISIONING_API_UNAVAILABLE'],
    [503, 'TABLE_ACTION_FIELD_IDS_UNRESOLVED'],
    // Review round 1 (F4): a code-less gateway answer is the same "not answered normally".
    [502, null],
    [504, null],
  ] as const)('9b: a %i (code %s) the table does not name is "server unavailable", not the generic failure', async (status, code) => {
    const api = makeApi({
      archive: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(status, '/mvp-persist', { code })),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    const step = stepOf(report, 'archive')
    expect(step).toMatchObject({ status: 'fail', reason: 'BATCH_ARCHIVE_SERVICE_UNAVAILABLE' })
    expect(step.detail).toEqual(code ? { status, code } : { status })
    expect(report.imported).toBe(true)
    const plain = STOCK_PREP_SYNC_REASON_PLAIN.BATCH_ARCHIVE_SERVICE_UNAVAILABLE
    expect(plain.zh.startsWith('数据已经写进去了')).toBe(true)
    expect(plain.zhNext).toContain('平台管理员')
    expect(plain.enNext).toContain('platform administrator')
  })

  it('round 1 (F4): a 502/504 that carries an unrecognised code stays the generic failure; the copy does not claim nothing was kept', () => {
    expect(classifyArchiveFailure(502, 'SOME_UPSTREAM_CODE')).toEqual({ status: 'fail', reason: 'BATCH_ARCHIVE_FAILED' })
    expect(classifyArchiveFailure(504, 'SOME_UPSTREAM_CODE')).toEqual({ status: 'fail', reason: 'BATCH_ARCHIVE_FAILED' })
    expect(classifyArchiveFailure(500, null)).toEqual({ status: 'fail', reason: 'BATCH_ARCHIVE_FAILED' })
    // A 504 may have kept the batch server-side: the sentence says "not confirmed", not "nothing was kept".
    const plain = STOCK_PREP_SYNC_REASON_PLAIN.BATCH_ARCHIVE_SERVICE_UNAVAILABLE
    expect(plain.zh).toContain('没有确认完成')
    expect(plain.zh).not.toContain('这次没有存档')
    expect(plain.en).toContain('not confirmed')
    expect(plain.en).not.toContain('nothing was kept')
    expect(plain.zhNext).toContain(STOCK_PREP_SYNC_REASON_PLAIN.BATCH_ALREADY_ARCHIVED.zh.split(',')[0])
  })

  it('9b: a coded answer still wins over the status rules', () => {
    // The schema read's own 503 keeps its own sentence.
    expect(classifyArchiveFailure(503, 'TARGET_SCHEMA_UNAVAILABLE').reason).toBe('BATCH_ARCHIVE_SCHEMA_UNAVAILABLE')
    // Flag-off and the tier refusals are still classified first.
    expect(classifyArchiveFailure(403, null).reason).toBe('BATCH_ARCHIVE_NOT_PERMITTED')
    expect(classifyArchiveFailure(503, BATCH_ARCHIVE_DISABLED_CODE).reason).toBe('BATCH_ARCHIVE_DISABLED')
  })

  it('9b: the generic archive failure no longer promises that a re-sync fixes it, and points at the status', () => {
    const plain = STOCK_PREP_SYNC_REASON_PLAIN.BATCH_ARCHIVE_FAILED
    expect(plain.zhNext).not.toContain('通常就补上了')
    expect(plain.enNext!.toLowerCase()).not.toContain('usually adds it')
    expect(plain.zhNext).toContain('不一定能补上')
    expect(plain.enNext).toContain('may not add it')
    expect(plain.zhNext).toContain('HTTP 状态码')
    expect(plain.enNext).toContain('HTTP status')
    // The two halves P-03 renders on the panel stay.
    expect(plain.zh).toContain('存档没成功')
    expect(plain.zhNext).toContain('导入本身不受影响')
  })

  it('9b: the unprovisioned-tables copy names the admin action without implying a page button, and the off switch', () => {
    const plain = STOCK_PREP_SYNC_REASON_PLAIN.BATCH_ARCHIVE_TABLES_NOT_PROVISIONED
    expect(plain.zhNext).not.toContain('「建快照表」')
    expect(plain.zhNext).toContain('页面上没有建表按钮')
    expect(plain.enNext).toContain('There is no button for this on the page')
    // Review round 1 (F8): an authenticated API call, named for the administrator — not a server-shell step.
    expect(plain.zhNext).toContain('给管理员看的接口名:mvp/ensure')
    expect(plain.zhNext).not.toContain('在服务器上')
    expect(plain.enNext).not.toContain('on the server')
    expect(plain.zhNext).toContain('开关关掉')
    expect(plain.enNext).toContain('flag off')
    // ...and the sentence it says the step will then show is the real one.
    expect(plain.zhNext).toContain(STOCK_PREP_SYNC_REASON_PLAIN.BATCH_ARCHIVE_DISABLED.zh)
    expect(plain.enNext).toContain(STOCK_PREP_SYNC_REASON_PLAIN.BATCH_ARCHIVE_DISABLED.en)
  })

  it('round 1 (F5): the schema-repair copy no longer quotes a page button that does not exist', () => {
    const plain = STOCK_PREP_SYNC_REASON_PLAIN.BATCH_ARCHIVE_SCHEMA_INCOMPLETE
    expect(plain.zhNext).not.toContain('「修复快照表」')
    expect(plain.zhNext).toContain('页面上没有修复按钮')
    expect(plain.zhNext).toContain('给管理员看的接口名:mvp/repair')
    expect(plain.enNext).toContain('There is no repair button on the page')
  })

  it('9b: the pointer and version refusals name their detail reason and the administrator, never a self-heal', () => {
    const pointer = STOCK_PREP_SYNC_REASON_PLAIN.BATCH_ARCHIVE_POINTER_STALE
    expect(pointer.zhNext).toContain('修复流程')
    expect(pointer.enNext).toContain('repair procedure')
    const version = STOCK_PREP_SYNC_REASON_PLAIN.BATCH_ARCHIVE_VERSION_HISTORY
    for (const token of ['history_unprovable', 'not_monotonic']) {
      expect(version.zhNext).toContain(token)
      expect(version.enNext).toContain(token)
    }
    const bounded = STOCK_PREP_SYNC_REASON_PLAIN.BATCH_ARCHIVE_LARGE_BOM_BOUNDED
    expect(bounded.zhNext).toContain('再同步还会停在这里')
    for (const plain of [pointer, version, bounded]) {
      expect(plain.zhNext).not.toMatch(/通常就补上了|稍后再同步/)
      expect(plain.enNext!.toLowerCase()).not.toMatch(/usually adds it|sync again later/)
    }
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

  // 客户反馈 2026-09-24 #2 (裁定见 PR #6074;后端诊断见 #6067) — A DRY-RUN FAILURE NAMES ITS ACTUAL CAUSE.
  // These five specs are the "code → reason" half of the fix; StockPreparationProjectSyncPanel.spec.ts
  // pins the "reason → rendered message" half.
  it('G-3f: a CONNECTION_* refusal on the plan is its own reason, not the generic transient one', async () => {
    const api = makeApi({
      dryRun: vi.fn().mockRejectedValue(
        // The real load path answers this at 500 (inferHttpStatus's default for the connection
        // resolver's own error, which no instanceof/name check there claims) — status alone cannot
        // tell this apart from a genuine server fault, which is exactly why the code is checked first.
        new StockPreparationProjectSyncCallError(500, '/dry-run', { code: 'CONNECTION_CANONICAL_UNAVAILABLE' }),
      ),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'dry-run')).toMatchObject({ status: 'fail', reason: 'PLAN_READ_FAILED_CONNECTION' })
    expect(api.apply).not.toHaveBeenCalled()
  })

  it('G-3g: a 409 TARGET_SHEET_FOREIGN_PROJECT refusal on the plan is its own reason', async () => {
    const api = makeApi({
      dryRun: vi.fn().mockRejectedValue(
        new StockPreparationProjectSyncCallError(409, '/dry-run', { code: 'TARGET_SHEET_FOREIGN_PROJECT' }),
      ),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'dry-run')).toMatchObject({ status: 'fail', reason: 'PLAN_READ_FAILED_FOREIGN_PROJECT' })
    expect(api.apply).not.toHaveBeenCalled()
  })

  it('G-3h: a bare 403 on the plan is a permission refusal, not the generic transient reason', async () => {
    const api = makeApi({
      dryRun: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(403, '/dry-run', {})),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'dry-run')).toMatchObject({ status: 'fail', reason: 'PLAN_READ_NOT_PERMITTED' })
    // R-33 (2026-10-08): the sentence under that reason names the code that is actually missing —
    // the 拉取人员's pull — and never sends a floor operator to obtain 「备料操作」, which they hold.
    const plain = STOCK_PREP_SYNC_REASON_PLAIN.PLAN_READ_NOT_PERMITTED
    expect(plain.zhNext).toContain('拉取人员')
    expect(plain.zhNext).not.toContain('备料操作')
    expect(plain.enNext).toContain('pull')
    expect(plain.enNext).not.toContain('operate permission')
  })

  it('G-3h2: a bare 401 on the plan is its own reason — an expired session, not a permission refusal', async () => {
    const api = makeApi({
      dryRun: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(401, '/dry-run', {})),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'dry-run')).toMatchObject({ status: 'fail', reason: 'PLAN_READ_UNAUTHENTICATED' })
  })

  it('G-3i: SOURCE_UNAVAILABLE (503) keeps the original transient reason unchanged', async () => {
    const api = makeApi({
      dryRun: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(503, '/dry-run', { code: 'SOURCE_UNAVAILABLE' })),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'dry-run')).toMatchObject({ status: 'fail', reason: 'PLAN_READ_FAILED' })
  })

  it('G-3j: a raw network failure (no status, no code) also keeps the original transient reason', async () => {
    const api = makeApi({ dryRun: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'dry-run')).toMatchObject({ status: 'fail', reason: 'PLAN_READ_FAILED' })
  })

  it('G-3k: an unrecognized code/status is its own UNKNOWN reason, never guessed as transient', async () => {
    const api = makeApi({
      dryRun: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(400, '/dry-run', { code: 'SOME_OTHER_CODE' })),
    })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'dry-run')).toMatchObject({ status: 'fail', reason: 'PLAN_READ_FAILED_UNKNOWN' })
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
    // #6475 round 2 (review blocker 2): the archive is NOT attempted. It would keep the whole source as
    // this sync's batch while the sheet holds only part of it — the review executed exactly that (③
    // created 1 / failed 1, ④ answered 201 and kept the row ③ failed to write).
    expect(api.archive).not.toHaveBeenCalled()
    expect(stepOf(report, 'archive')).toMatchObject({ status: 'skip', reason: 'BATCH_ARCHIVE_WRITE_INCOMPLETE', detail: { failed: 1 } })
    // Its own sentence — not BATCH_ARCHIVE_NOT_ATTEMPTED's, which says nothing was written.
    const plain = STOCK_PREP_SYNC_REASON_PLAIN.BATCH_ARCHIVE_WRITE_INCOMPLETE
    expect(plain).toBeDefined()
    expect(plain.zh).not.toBe(STOCK_PREP_SYNC_REASON_PLAIN.BATCH_ARCHIVE_NOT_ATTEMPTED.zh)
    expect(plain.zhNext).toContain('再同步一次')
    expect(plain.enNext).toContain('sync again')
    assertValuesFree(report)
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

  it('classifyPlanReadFailureReason sorts a failed dry run by CODE first, then STATUS', () => {
    // CODE wins even at a status (500) that would otherwise fall into the transient bucket — the
    // connection resolver's own error surfaces there today (inferHttpStatus has no instanceof/name
    // check for it), and that must not blur it into "server had a generic fault".
    expect(classifyPlanReadFailureReason(500, 'CONNECTION_CANONICAL_UNAVAILABLE')).toBe('PLAN_READ_FAILED_CONNECTION')
    expect(classifyPlanReadFailureReason(500, 'CONNECTION_LEGACY_UNAVAILABLE')).toBe('PLAN_READ_FAILED_CONNECTION')
    expect(classifyPlanReadFailureReason(409, 'TARGET_SHEET_FOREIGN_PROJECT')).toBe('PLAN_READ_FAILED_FOREIGN_PROJECT')
    expect(classifyPlanReadFailureReason(401, null)).toBe('PLAN_READ_UNAUTHENTICATED') // 401 is its own class, not folded into 403
    expect(classifyPlanReadFailureReason(403, null)).toBe('PLAN_READ_NOT_PERMITTED')
    expect(classifyPlanReadFailureReason(503, 'SOURCE_UNAVAILABLE')).toBe('PLAN_READ_FAILED')
    expect(classifyPlanReadFailureReason(0, null)).toBe('PLAN_READ_FAILED') // raw network failure: no status, no code
    expect(classifyPlanReadFailureReason(500, 'INTERNAL_ERROR')).toBe('PLAN_READ_FAILED') // generic 5xx
    expect(classifyPlanReadFailureReason(400, 'SOME_OTHER_CODE')).toBe('PLAN_READ_FAILED_UNKNOWN')
    expect(classifyPlanReadFailureReason(404, null)).toBe('PLAN_READ_FAILED_UNKNOWN')
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

// =============================================================================================
// R67 ④ — `createStockPreparationProjectSyncApi().dryRun` through the background job lane. Drives
// the REAL wire client (apiFetch mocked at the module boundary): enqueue (`POST …/dry-run-jobs`) +
// poll (`GET …/dry-run-jobs?projectNo=`), never the synchronous `POST …/dry-run` unless the
// deployment has no durable job store.
// =============================================================================================

describe('R67 ④ — the dry run is enqueued and polled', () => {
  const JOB_ID = 'dry-run-00000000-0000-4000-8000-000000000001'
  const instant = async (): Promise<void> => {}

  function envelope(data: unknown, status = 200): Response {
    return new Response(JSON.stringify({ ok: true, data }), { status })
  }
  function refusal(status: number, code: string, details: Record<string, unknown> = {}): Response {
    return new Response(JSON.stringify({ ok: false, error: { code, message: 'refused', details } }), { status })
  }
  const running = (elapsedMs: number) => envelope({ jobId: JOB_ID, status: 'running', startedAt: '2026-10-19T00:00:00.000Z', finishedAt: null, elapsedMs })
  const succeeded = (result: unknown) => envelope({ jobId: JOB_ID, status: 'succeeded', startedAt: '2026-10-19T00:00:00.000Z', finishedAt: '2026-10-19T00:01:30.000Z', elapsedMs: 90_000, result })
  const failed = (httpStatus: number, code: string) => envelope({ jobId: JOB_ID, status: 'failed', startedAt: '2026-10-19T00:00:00.000Z', finishedAt: '2026-10-19T00:00:05.000Z', elapsedMs: 5_000, error: { httpStatus, code, message: 'refused' } })

  /** `enqueues` answer the successive POSTs, `polls` the successive GETs; every call is logged. */
  function wire({ enqueues = [], polls = [], sync = [] }: { enqueues?: Response[]; polls?: Response[]; sync?: Response[] }) {
    const calls: { method: string; url: string; body: Record<string, unknown> | null }[] = []
    wireFetch.mockReset()
    wireFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null })
      if (String(url).includes('/dry-run-jobs')) {
        const next = method === 'POST' ? enqueues.shift() : polls.shift()
        if (!next) throw new Error(`unexpected ${method} ${url}`)
        return next
      }
      if (String(url).includes('/dry-run')) {
        const next = sync.shift()
        if (!next) throw new Error(`unexpected ${method} ${url}`)
        return next
      }
      throw new Error(`unrouted ${method} ${url}`)
    })
    return calls
  }

  it('D-01: enqueue (flagged body) → running polls report progress → the job\'s payload IS the plan, token included; the synchronous route is never called', async () => {
    const calls = wire({ enqueues: [running(0)], polls: [running(30_000), running(62_000), succeeded(plan())] })
    const progress: unknown[] = []
    const result = await createStockPreparationProjectSyncApi({ tenantId: 'syn-tenant' }).dryRun(PROJECT_NO, {
      wait: instant,
      onProgress: (p) => progress.push(p),
    })
    expect(result).toEqual(plan())
    expect(result.dryRunToken).toBe('tok_abc')
    expect(progress).toEqual([{ elapsedMs: 30_000, attached: false }, { elapsedMs: 62_000, attached: false }])
    const posts = calls.filter((call) => call.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0].url).toBe('/api/integration/table-actions/plm.stock-preparation.pull-bom.v1/dry-run-jobs?tenantId=syn-tenant')
    expect(posts[0].body).toEqual({ parameters: { projectNo: PROJECT_NO }, includeMissingComponents: true })
    const gets = calls.filter((call) => call.method === 'GET')
    expect(gets).toHaveLength(3)
    for (const get of gets) {
      const query = new URL(get.url, 'http://x').searchParams
      expect(query.get('projectNo')).toBe(PROJECT_NO)
      expect(query.get('includeMissingComponents')).toBe('true')
      expect(query.get('tenantId')).toBe('syn-tenant')
    }
    expect(calls.some((call) => /\/dry-run(\?|$)/.test(call.url))).toBe(false)
  })

  it('D-02: a failed job surfaces the synchronous route\'s own status + code, so the plan step classifies exactly as before', async () => {
    wire({ enqueues: [running(0)], polls: [running(1_000), failed(409, 'TARGET_SHEET_FOREIGN_PROJECT')] })
    const api = createStockPreparationProjectSyncApi({})
    const report = await runStockPreparationProjectSync(api, PROJECT_NO, undefined, { dryRun: { wait: instant } })
    expect(stepOf(report, 'dry-run')).toMatchObject({ status: 'fail', reason: 'PLAN_READ_FAILED_FOREIGN_PROJECT', detail: { status: 409, code: 'TARGET_SHEET_FOREIGN_PROJECT' } })
    expect(report.steps.map((step) => step.id)).toEqual(['dry-run'])
  })

  it('D-03: aborting stops the poll — no further GET after the signal fires', async () => {
    const controller = new AbortController()
    const calls = wire({ enqueues: [running(0)], polls: [running(1_000), running(2_000), running(3_000)] })
    let waits = 0
    const wait = async (): Promise<void> => {
      waits += 1
      if (waits === 1) controller.abort()
    }
    await expect(createStockPreparationProjectSyncApi({}).dryRun(PROJECT_NO, { wait, signal: controller.signal }))
      .rejects.toMatchObject({ code: STOCK_PREPARATION_DRY_RUN_POLL_STOPPED_CODE })
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(1)
  })

  it('D-04: this caller\'s own trial is already running (409 ownJob) — no second enqueue; it attaches and returns that job\'s plan', async () => {
    const calls = wire({
      enqueues: [refusal(409, STOCK_PREPARATION_DRY_RUN_JOB_IN_PROGRESS_CODE, { status: 'running', ownJob: true })],
      polls: [running(40_000), succeeded(plan())],
    })
    const progress: unknown[] = []
    const result = await createStockPreparationProjectSyncApi({}).dryRun(PROJECT_NO, { wait: instant, onProgress: (p) => progress.push(p) })
    expect(result).toEqual(plan())
    expect(progress).toEqual([{ elapsedMs: 40_000, attached: true }])
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1)
  })

  it('D-04b: attaching finds the values-free record when the running job was enqueued without the opt-in', async () => {
    const calls = wire({
      enqueues: [refusal(409, STOCK_PREPARATION_DRY_RUN_JOB_IN_PROGRESS_CODE, { status: 'running', ownJob: true })],
      polls: [refusal(404, 'STOCK_PREPARATION_DRY_RUN_JOB_NOT_FOUND'), succeeded(plan())],
    })
    expect(await createStockPreparationProjectSyncApi({}).dryRun(PROJECT_NO, { wait: instant })).toEqual(plan())
    const flags = calls.filter((call) => call.method === 'GET').map((call) => new URL(call.url, 'http://x').searchParams.get('includeMissingComponents'))
    expect(flags).toEqual(['true', 'false'])
  })

  it('D-05: someone else\'s trial of the project is running (409, not ours) — no attach, the step says PLAN_DRY_RUN_BUSY', async () => {
    const calls = wire({ enqueues: [refusal(409, STOCK_PREPARATION_DRY_RUN_JOB_IN_PROGRESS_CODE, { status: 'running', ownJob: false })] })
    const report = await runStockPreparationProjectSync(createStockPreparationProjectSyncApi({}), PROJECT_NO, undefined, { dryRun: { wait: instant } })
    expect(stepOf(report, 'dry-run')).toMatchObject({ status: 'fail', reason: 'PLAN_DRY_RUN_BUSY' })
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(0)
    expect(STOCK_PREP_SYNC_REASON_PLAIN.PLAN_DRY_RUN_BUSY.zh).toContain('另一位同事')
  })

  it('D-05b: a trial the server restarted under reports PLAN_DRY_RUN_INTERRUPTED (press again), not a broken source', async () => {
    wire({ enqueues: [running(0)], polls: [failed(503, STOCK_PREPARATION_DRY_RUN_JOB_INTERRUPTED_CODE)] })
    const report = await runStockPreparationProjectSync(createStockPreparationProjectSyncApi({}), PROJECT_NO, undefined, { dryRun: { wait: instant } })
    expect(stepOf(report, 'dry-run')).toMatchObject({ status: 'fail', reason: 'PLAN_DRY_RUN_INTERRUPTED' })
  })

  it('D-06: no durable job store on this deployment (501) — the ONE case that falls back to the synchronous route', async () => {
    const calls = wire({
      enqueues: [refusal(501, STOCK_PREPARATION_DRY_RUN_JOB_STORE_UNAVAILABLE_CODE)],
      sync: [envelope(plan())],
    })
    expect(await createStockPreparationProjectSyncApi({}).dryRun(PROJECT_NO, { wait: instant })).toEqual(plan())
    expect(calls.map((call) => `${call.method} ${call.url.split('?')[0]}`)).toEqual([
      'POST /api/integration/table-actions/plm.stock-preparation.pull-bom.v1/dry-run-jobs',
      'POST /api/integration/table-actions/plm.stock-preparation.pull-bom.v1/dry-run',
    ])
    // …and nothing else falls back: an ordinary refusal of the enqueue is the dry run's refusal.
    const other = wire({ enqueues: [refusal(503, 'SOURCE_UNAVAILABLE')] })
    await expect(createStockPreparationProjectSyncApi({}).dryRun(PROJECT_NO, { wait: instant })).rejects.toMatchObject({ status: 503, code: 'SOURCE_UNAVAILABLE' })
    expect(other.some((call) => /\/dry-run(\?|$)/.test(call.url))).toBe(false)
  })

  it('D-07: one dropped poll (a gateway blip with no envelope) is not a failed dry run; three in a row are', async () => {
    const blip = () => new Response('<html>bad gateway</html>', { status: 502 })
    wire({ enqueues: [running(0)], polls: [blip(), succeeded(plan())] })
    expect(await createStockPreparationProjectSyncApi({}).dryRun(PROJECT_NO, { wait: instant })).toEqual(plan())
    wire({ enqueues: [running(0)], polls: [blip(), blip(), blip(), succeeded(plan())] })
    await expect(createStockPreparationProjectSyncApi({}).dryRun(PROJECT_NO, { wait: instant })).rejects.toMatchObject({ status: 502 })
  })

  it('D-08: the poll is bounded — a job that never ends stops at the budget, never an endless loop', async () => {
    wire({ enqueues: [running(0)], polls: [running(1), running(2), running(3)] })
    await expect(createStockPreparationProjectSyncApi({}).dryRun(PROJECT_NO, { wait: instant, maxPolls: 3 }))
      .rejects.toMatchObject({ code: 'STOCK_PREPARATION_DRY_RUN_POLL_BUDGET_EXCEEDED' })
  })

  it('D-09: dryRunJobStatus — running is reported for re-attach; nothing under either flag is null; it never enqueues', async () => {
    let calls = wire({ polls: [running(75_000)] })
    expect(await createStockPreparationProjectSyncApi({}).dryRunJobStatus!(PROJECT_NO)).toEqual({ status: 'running', elapsedMs: 75_000 })
    calls = wire({ polls: [refusal(404, 'STOCK_PREPARATION_DRY_RUN_JOB_NOT_FOUND'), refusal(404, 'STOCK_PREPARATION_DRY_RUN_JOB_NOT_FOUND')] })
    expect(await createStockPreparationProjectSyncApi({}).dryRunJobStatus!(PROJECT_NO)).toBeNull()
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0)
    calls = wire({ polls: [refusal(403, 'OPERATOR_SCOPE_TENANT_REQUIRED'), running(2_000)] })
    expect(await createStockPreparationProjectSyncApi({}).dryRunJobStatus!(PROJECT_NO)).toEqual({ status: 'running', elapsedMs: 2_000 })
  })

  it('D-10: B1 is kept on the job lane — a flagged ENQUEUE refused for the flag is retried once without it', async () => {
    const calls = wire({
      enqueues: [refusal(403, 'OPERATOR_SCOPE_TENANT_REQUIRED'), running(0)],
      polls: [succeeded(plan())],
    })
    const result = await createStockPreparationProjectSyncApi({}).dryRun(PROJECT_NO, { wait: instant })
    expect(result.missingComponentsUnavailableReason).toBe('scope_denied')
    const posts = calls.filter((call) => call.method === 'POST')
    expect(posts.map((call) => call.body?.includeMissingComponents)).toEqual([true, undefined])
    expect(new URL(calls.find((call) => call.method === 'GET')!.url, 'http://x').searchParams.get('includeMissingComponents')).toBe('false')
  })
})

describe('#6475 round 1 — the archive call on the wire', () => {
  function capture(response: () => Response) {
    const calls: { url: string; body: Record<string, unknown> | null }[] = []
    wireFetch.mockReset()
    wireFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null })
      return response()
    })
    return calls
  }
  const ARCHIVE_ROUTE = '/api/integration/table-actions/plm.stock-preparation.pull-bom.v1/mvp-persist'

  it('W-1: the digest rides in the body, still with no query string; the refusal keeps its closed details pair', async () => {
    const calls = capture(() => new Response(JSON.stringify({
      ok: false,
      error: { code: 'PERSIST_IDEMPOTENCY_CONFLICT', message: 'refused', details: { target: 'project', reason: 'duplicate_key', extra: PLANTED_SECRET } },
    }), { status: 409 }))
    const api = createStockPreparationProjectSyncApi({ tenantId: 'syn-tenant', workspaceId: 'syn-workspace' })
    const error = await api.archive(PROJECT_NO, { sourceScopeDigest: SOURCE_DIGEST }).then(() => null, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(StockPreparationProjectSyncCallError)
    expect(error).toMatchObject({ status: 409, code: 'PERSIST_IDEMPOTENCY_CONFLICT', detailTarget: 'project', detailReason: 'duplicate_key' })
    expect(JSON.stringify(error)).not.toContain(PLANTED_SECRET)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(ARCHIVE_ROUTE)
    expect(calls[0].body).toEqual({ parameters: { projectNo: PROJECT_NO }, sourceScopeDigest: SOURCE_DIGEST })
  })

  it('W-3 (round 2): the content digest rides in the body beside the scope digest; a malformed one is dropped alone', async () => {
    const calls = capture(() => new Response(JSON.stringify({ ok: true, data: archived() }), { status: 201 }))
    await createStockPreparationProjectSyncApi({ tenantId: 'syn-tenant' }).archive(PROJECT_NO, { sourceScopeDigest: SOURCE_DIGEST, sourceContentDigest: CONTENT_DIGEST })
    expect(calls[0].url).toBe(ARCHIVE_ROUTE)
    expect(calls[0].body).toEqual({ parameters: { projectNo: PROJECT_NO }, sourceScopeDigest: SOURCE_DIGEST, sourceContentDigest: CONTENT_DIGEST })
    for (const sourceContentDigest of [CONTENT_DIGEST.toUpperCase(), PLANTED_SECRET, '']) {
      const again = capture(() => new Response(JSON.stringify({ ok: true, data: archived() }), { status: 201 }))
      await createStockPreparationProjectSyncApi({ tenantId: 'syn-tenant' }).archive(PROJECT_NO, { sourceScopeDigest: SOURCE_DIGEST, sourceContentDigest })
      expect(again[0].body).toEqual({ parameters: { projectNo: PROJECT_NO }, sourceScopeDigest: SOURCE_DIGEST })
    }
    const contentOnly = capture(() => new Response(JSON.stringify({ ok: true, data: archived() }), { status: 201 }))
    await createStockPreparationProjectSyncApi({ tenantId: 'syn-tenant' }).archive(PROJECT_NO, { sourceContentDigest: CONTENT_DIGEST })
    expect(contentOnly[0].body).toEqual({ parameters: { projectNo: PROJECT_NO }, sourceContentDigest: CONTENT_DIGEST })
  })

  it('W-2: without a digest — or with one of the wrong shape — the body is exactly what it always was', async () => {
    for (const options of [undefined, {}, { sourceScopeDigest: SOURCE_DIGEST.toUpperCase() }, { sourceScopeDigest: PLANTED_SECRET }]) {
      const calls = capture(() => new Response(JSON.stringify({ ok: true, data: archived() }), { status: 201 }))
      await createStockPreparationProjectSyncApi({ tenantId: 'syn-tenant' }).archive(PROJECT_NO, options)
      expect(calls[0].url).toBe(ARCHIVE_ROUTE)
      expect(calls[0].body).toEqual({ parameters: { projectNo: PROJECT_NO } })
    }
  })
})

// Batch-refresh phase 0 step 1 — the project write lock, as the panel reads it. Each refusal gets its own
// plain sentence (never the raw code as the headline, never 「数据没有变化」 when rows may have landed).
describe('batch-refresh phase 0 step 1 — project write lock codes', () => {
  const LOCK_CODES = [
    ['STOCK_PREP_PROJECT_WRITE_LOCKED', 409, 'WRITE_PROJECT_LOCKED'],
    ['STOCK_PREP_PROJECT_PLAN_SUPERSEDED', 409, 'WRITE_PLAN_SUPERSEDED'],
    ['STOCK_PREP_PROJECT_WRITE_LEASE_LOST', 409, 'WRITE_TAKEN_OVER'],
    ['STOCK_PREP_PROJECT_WRITE_LOCK_STORE_FAILED', 503, 'WRITE_LOCK_UNAVAILABLE'],
    ['STOCK_PREP_PROJECT_WRITE_LOCK_UNAVAILABLE', 501, 'WRITE_LOCK_UNAVAILABLE'],
  ] as const

  it.each(LOCK_CODES)('WL-1: apply refused %s (%i) reports %s with its own sentence', async (code, status, reason) => {
    // The server reports `partial: false` positively on every refusal that precedes a host write (review round 2).
    const api = makeApi({ apply: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(status, '/apply', { code, detailPartial: false })) })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'apply')).toMatchObject({ status: 'fail', reason, detail: { status, code } })
    expect(stepOf(report, 'archive')).toMatchObject({ status: 'skip', reason: 'BATCH_ARCHIVE_NOT_ATTEMPTED' })
    expect(classifyWriteLockFailure(code, { partial: false })).toBe(reason)
    const plain = STOCK_PREP_SYNC_REASON_PLAIN[reason]
    expect(plain).toBeDefined()
    expect(plain.zh.length * plain.en.length * (plain.zhNext ?? '').length * (plain.enNext ?? '').length).toBeGreaterThan(0)
    expect(`${plain.zh}${plain.en}`).not.toContain(code)
    expect(plain.zh).not.toBe(STOCK_PREP_SYNC_REASON_PLAIN.WRITE_FAILED.zh)
    assertValuesFree(report)
  })

  it('WL-2: an interrupted write never claims nothing changed; any other apply failure is still WRITE_FAILED', async () => {
    expect(STOCK_PREP_SYNC_REASON_PLAIN.WRITE_INTERRUPTED.zh).not.toContain('没有变化')
    expect(STOCK_PREP_SYNC_REASON_PLAIN.WRITE_INTERRUPTED.en.toLowerCase()).not.toContain('nothing was changed')
    expect(classifyWriteLockFailure('TABLE_ACTION_DRY_RUN_TOKEN_INVALID')).toBeNull()
    expect(classifyWriteLockFailure(null)).toBeNull()
  })

  it('WL-3: a trial refused while another run writes the project, and a lock store failure, each say so (not the transient read failure)', async () => {
    const locked = await runStockPreparationProjectSync(makeApi({ dryRun: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(409, '/dry-run', { code: 'STOCK_PREP_PROJECT_WRITE_LOCKED' })) }), PROJECT_NO)
    expect(stepOf(locked, 'dry-run')).toMatchObject({ status: 'fail', reason: 'PLAN_PROJECT_WRITE_LOCKED' })
    const down = await runStockPreparationProjectSync(makeApi({ dryRun: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(503, '/dry-run', { code: 'STOCK_PREP_PROJECT_WRITE_LOCK_STORE_FAILED' })) }), PROJECT_NO)
    expect(stepOf(down, 'dry-run')).toMatchObject({ status: 'fail', reason: 'PLAN_WRITE_LOCK_UNAVAILABLE' })
    expect(classifyPlanReadFailureReason(503, 'STOCK_PREP_PROJECT_WRITE_LOCK_STORE_FAILED')).toBe('PLAN_WRITE_LOCK_UNAVAILABLE')
    expect(classifyPlanReadFailureReason(503, null)).toBe('PLAN_READ_FAILED')
    for (const reason of ['PLAN_PROJECT_WRITE_LOCKED', 'PLAN_WRITE_LOCK_UNAVAILABLE']) {
      const plain = STOCK_PREP_SYNC_REASON_PLAIN[reason]
      expect(plain.zh.length * (plain.zhNext ?? '').length).toBeGreaterThan(0)
    }
    expect(STOCK_PREP_SYNC_REASON_PLAIN.PLAN_WRITE_LOCK_UNAVAILABLE.zhNext).toContain('管理员')
  })

  it('WL-4: the large-BOM pull panel (stockPrepErrorPlain) has a specific sentence for every lock code', () => {
    const generic = stockPrepErrorPlain('SOME_CODE_NOBODY_MAPPED')
    for (const [code] of LOCK_CODES) {
      const plain = stockPrepErrorPlain(code)
      expect(plain.zh).not.toBe(generic.zh)
      expect(`${plain.zh}${plain.en}`).not.toContain(code)
    }
  })

  // Review round 1 (item 9): what the server says actually happened decides the sentence.
  it('WL-5: a lock-store failure AFTER rows landed (503, details.partial) says rows may already be written', async () => {
    const api = makeApi({ apply: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(503, '/apply', { code: 'STOCK_PREP_PROJECT_WRITE_LOCK_STORE_FAILED', detailPartial: true })) })
    const report = await runStockPreparationProjectSync(api, PROJECT_NO)
    expect(stepOf(report, 'apply')).toMatchObject({ status: 'fail', reason: 'WRITE_LOCK_FAILED_MIDWAY' })
    const plain = STOCK_PREP_SYNC_REASON_PLAIN.WRITE_LOCK_FAILED_MIDWAY
    expect(plain.zh).toContain('可能已写进一部分')
    expect(plain.en).toContain('may already have landed')
    expect(`${plain.zh}${plain.zhNext}`).not.toContain('没有写入')
    expect(classifyWriteLockFailure('STOCK_PREP_PROJECT_WRITE_LOCK_STORE_FAILED', { partial: false })).toBe('WRITE_LOCK_UNAVAILABLE')
  })

  it('WL-6: LEASE_LOST with nothing written (decision index 0) never says rows may have landed; with rows written it does', async () => {
    const none = await runStockPreparationProjectSync(makeApi({ apply: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(409, '/apply', { code: 'STOCK_PREP_PROJECT_WRITE_LEASE_LOST', detailPartial: false })) }), PROJECT_NO)
    expect(stepOf(none, 'apply')).toMatchObject({ reason: 'WRITE_TAKEN_OVER' })
    const taken = STOCK_PREP_SYNC_REASON_PLAIN.WRITE_TAKEN_OVER
    expect(`${taken.zh}${taken.zhNext}`).not.toContain('可能已写')
    expect(`${taken.en} ${taken.enNext}`.toLowerCase()).not.toContain('may already')
    const some = await runStockPreparationProjectSync(makeApi({ apply: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(409, '/apply', { code: 'STOCK_PREP_PROJECT_WRITE_LEASE_LOST', detailPartial: true })) }), PROJECT_NO)
    expect(stepOf(some, 'apply')).toMatchObject({ reason: 'WRITE_INTERRUPTED' })
    expect(STOCK_PREP_SYNC_REASON_PLAIN.WRITE_INTERRUPTED.zh).toContain('可能已写进一部分')
  })

  it('WL-7: a lost lock race with no writer (details.reason contention) says "busy", never that another run is writing', async () => {
    const write = await runStockPreparationProjectSync(makeApi({ apply: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(409, '/apply', { code: 'STOCK_PREP_PROJECT_WRITE_LOCKED', detailReason: 'contention' })) }), PROJECT_NO)
    expect(stepOf(write, 'apply')).toMatchObject({ reason: 'WRITE_LOCK_BUSY' })
    const plan = await runStockPreparationProjectSync(makeApi({ dryRun: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(409, '/dry-run', { code: 'STOCK_PREP_PROJECT_WRITE_LOCKED', detailReason: 'contention' })) }), PROJECT_NO)
    expect(stepOf(plan, 'dry-run')).toMatchObject({ reason: 'PLAN_WRITE_LOCK_BUSY' })
    for (const reason of ['WRITE_LOCK_BUSY', 'PLAN_WRITE_LOCK_BUSY']) {
      const plain = STOCK_PREP_SYNC_REASON_PLAIN[reason]
      expect(plain.zh).toContain('系统正忙')
      expect(`${plain.zh}${plain.zhNext}`).not.toContain('另一次同步')
      expect(plain.en.toLowerCase()).not.toContain('another run')
    }
    // a real holder still reads as "someone is writing"
    expect(classifyWriteLockFailure('STOCK_PREP_PROJECT_WRITE_LOCKED', { detailReason: null })).toBe('WRITE_PROJECT_LOCKED')
    expect(classifyPlanReadFailureReason(409, 'STOCK_PREP_PROJECT_WRITE_LOCKED')).toBe('PLAN_PROJECT_WRITE_LOCKED')
  })

  it('WL-8: details.partial is TRI-STATE: only the literal booleans count, anything else is unknown (null)', () => {
    expect(new StockPreparationProjectSyncCallError(503, '/apply', { detailPartial: true }).detailPartial).toBe(true)
    expect(new StockPreparationProjectSyncCallError(503, '/apply', { detailPartial: false }).detailPartial).toBe(false)
    expect(new StockPreparationProjectSyncCallError(503, '/apply', { detailPartial: 'true' }).detailPartial).toBeNull()
    expect(new StockPreparationProjectSyncCallError(503, '/apply', {}).detailPartial).toBeNull()
  })

  // Review round 2 (F1): an absent / unknown `partial` never reads "nothing was written".
  it.each([
    ['STOCK_PREP_PROJECT_WRITE_LEASE_LOST', 409],
    ['STOCK_PREP_PROJECT_WRITE_LOCK_STORE_FAILED', 503],
    ['STOCK_PREP_PROJECT_PLAN_SUPERSEDED', 409],
  ] as const)('WL-10: %s (%i) with partial NOT reported reads neutral — neither "nothing written" nor "rows landed"', async (code, status) => {
    const report = await runStockPreparationProjectSync(makeApi({ apply: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(status, '/apply', { code })) }), PROJECT_NO)
    expect(stepOf(report, 'apply')).toMatchObject({ status: 'fail', reason: 'WRITE_STOPPED_UNCONFIRMED' })
    const plain = STOCK_PREP_SYNC_REASON_PLAIN.WRITE_STOPPED_UNCONFIRMED
    expect(`${plain.zh}${plain.zhNext}`).not.toMatch(/没有写入|没有变化|可能已写进一部分/)
    expect(plain.zh).toContain('无法确认')
  })

  it('WL-10b: the three states of a lock-store stop map to three different sentences', () => {
    const code = 'STOCK_PREP_PROJECT_WRITE_LOCK_STORE_FAILED'
    expect(classifyWriteLockFailure(code, { partial: true })).toBe('WRITE_LOCK_FAILED_MIDWAY')
    expect(classifyWriteLockFailure(code, { partial: false })).toBe('WRITE_LOCK_UNAVAILABLE')
    expect(classifyWriteLockFailure(code, { partial: null })).toBe('WRITE_STOPPED_UNCONFIRMED')
    expect(classifyWriteLockFailure(code)).toBe('WRITE_STOPPED_UNCONFIRMED')
    // A lock that is not wired refuses before any lock IO: "nothing written" holds by construction.
    expect(classifyWriteLockFailure('STOCK_PREP_PROJECT_WRITE_LOCK_UNAVAILABLE')).toBe('WRITE_LOCK_UNAVAILABLE')
  })

  // Review round 2 (F6): an unbound token is not "a newer preview exists".
  it('WL-11: PLAN_SUPERSEDED / token_unbound says the trial account cannot write, not that a newer preview exists', async () => {
    const report = await runStockPreparationProjectSync(makeApi({ apply: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(409, '/apply', { code: 'STOCK_PREP_PROJECT_PLAN_SUPERSEDED', detailReason: 'token_unbound', detailPartial: false })) }), PROJECT_NO)
    expect(stepOf(report, 'apply')).toMatchObject({ status: 'fail', reason: 'WRITE_TOKEN_UNBOUND' })
    const plain = STOCK_PREP_SYNC_REASON_PLAIN.WRITE_TOKEN_UNBOUND
    expect(plain.zh).toContain('没有写入权限')
    expect(plain.zhNext).toContain('有拉取权限的人重新试算')
    expect(plain.zh).not.toContain('更新的试算')
    expect(classifyWriteLockFailure('STOCK_PREP_PROJECT_PLAN_SUPERSEDED', { partial: false, detailReason: 'newer_plan' })).toBe('WRITE_PLAN_SUPERSEDED')
  })

  it('WL-9: the code-only sentences (large-BOM panel) claim neither a writer nor landed rows', () => {
    const locked = stockPrepErrorPlain('STOCK_PREP_PROJECT_WRITE_LOCKED')
    expect(locked.zh).toContain('或系统一时繁忙')
    for (const code of ['STOCK_PREP_PROJECT_WRITE_LEASE_LOST', 'STOCK_PREP_PROJECT_WRITE_LOCK_STORE_FAILED']) {
      const plain = stockPrepErrorPlain(code)
      expect(`${plain.zh}${plain.zhNext}`).not.toContain('可能已写')
      expect(plain.zhNext).toContain('如果已写进一部分行')
    }
  })
})

// ---------------------------------------------------------------------------------------------------
// 备料分批拉取第一期 step 3 PR B (plan §5.1 / §9.4 L03): a PILOT project over the small-lane cap is a
// FAILURE with its own sentence — never the `large_bom_bounded` SKIP that auto-starts the large lane.
// ---------------------------------------------------------------------------------------------------
describe('PR B — the pilot refusals of the dry run', () => {
  it('409 STOCK_PREP_PILOT_SMALL_LANE_LIMIT_EXCEEDED is a FAIL with PLAN_PILOT_OVER_SMALL_LANE_LIMIT, never a skip; 503 STATE_UNREADABLE likewise', async () => {
    for (const [status, code, reason] of [
      [409, 'STOCK_PREP_PILOT_SMALL_LANE_LIMIT_EXCEEDED', 'PLAN_PILOT_OVER_SMALL_LANE_LIMIT'],
      [503, 'STOCK_PREP_PILOT_STATE_UNREADABLE', 'PLAN_PILOT_STATE_UNREADABLE'],
    ] as const) {
      const api = makeApi({ dryRun: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(status, '/dry-run', { code })) })
      const report = await runStockPreparationProjectSync(api, PROJECT_NO)
      const step = stepOf(report, 'dry-run')
      expect(step).toMatchObject({ status: 'fail', reason })
      expect(step.reason).not.toBe('PLAN_LARGE_BOM_BOUNDED')
      expect(report.pass).toBe(false)
      expect(api.apply).not.toHaveBeenCalled()
      expect(classifyPlanReadFailureReason(status, code)).toBe(reason)
      const plain = STOCK_PREP_SYNC_REASON_PLAIN[reason]
      expect(plain).toBeDefined()
      expect(plain.zh.length * plain.en.length * (plain.zhNext ?? '').length * (plain.enNext ?? '').length).toBeGreaterThan(0)
      // Never a promise of the background channel, never a bare retry.
      expect(`${plain.zh}${plain.zhNext}`).not.toContain('后台通道处理')
      expect(`${plain.zh}${plain.zhNext}`).not.toContain('稍后再试一次')
      expect(`${plain.en} ${plain.enNext}`.toLowerCase()).not.toContain('switched to the background channel')
      assertValuesFree(report)
    }
    // The over-cap refusal names the owner's decision; the unreadable one names the platform admin.
    expect(STOCK_PREP_SYNC_REASON_PLAIN.PLAN_PILOT_OVER_SMALL_LANE_LIMIT.zhNext).toContain('负责人')
    expect(STOCK_PREP_SYNC_REASON_PLAIN.PLAN_PILOT_STATE_UNREADABLE.zhNext).toContain('管理员')
    // The code-keyed error copy exists for every pilot code the server can answer.
    for (const code of ['STOCK_PREP_PILOT_LARGE_LANE_REFUSED', 'STOCK_PREP_PILOT_SMALL_LANE_LIMIT_EXCEEDED', 'STOCK_PREP_PILOT_STATE_UNREADABLE', 'STOCK_PREP_PILOT_NOT_READY']) {
      expect(stockPrepErrorPlain(code).zh).not.toBe(stockPrepErrorPlain('NO_SUCH_CODE').zh)
    }
  })
})
