// 项目接入 — 「点一下项目号,这个项目的 BOM 就落到多维表里」.
//
// THE OWNER'S SPEC, VERBATIM:
//   「PLM系统接通后,在页面哪里可点击项目号,然后该项目号里的bom就自动导入到我们的多维表中」
//
// WHAT THIS MODULE IS. The four calls that sentence turns into, in order, with the outcome of each
// one reported separately. It is a UI over EXISTING routes and adds NO NEW WRITE AUTHORITY: every
// call below is a route that already exists with the gate it already had —
//
//   POST …/table-actions/:actionId/dry-run                          requireAccess(req, 'read')
//   POST …/table-actions/:actionId/confirmation-decisions/reconcile requireAccess(req, 'admin')
//   POST …/table-actions/:actionId/apply                            requireAccess(req, 'write')
//   POST …/table-actions/:actionId/mvp-persist                      requireAccess(req, 'admin') + flag
//
// — and this file neither widens one nor invents a fifth. The server gates are the enforcement; the
// panel's own visibility rule (workbenchAccess.canRunStockPrepProjectSync) exists so nobody is shown
// a button that would 403, which is R-11's rule, not a second gate.
//
// THE FOUR STEPS, and why they are four rather than one button and a spinner:
//
//   1. 试算 (dry-run)      — what WOULD change. Nothing is written.
//   2. 确认 (reconcile)    — the rows the system is not sure about, put in front of a person.
//   3. 写入 (apply)        — the BOM lands in the multitable sheet.
//   4. 批次存档 (mvp-persist) — this sync's snapshot batch, so 差异 can compare it with the last one.
//
// A HELD PLAN IS WORK, NOT A FAULT. When the dry run comes back `manual_confirm_required` this module
// does NOT apply. It could — the server mints a token even in that state and `acceptManualConfirmHold`
// would push the plan through with the held rows unwritten — and it deliberately does not, because
// "the import half-succeeded and nobody said so" is precisely the failure the confirmation queue
// exists to prevent. Instead it reconciles (which is what puts those rows in the 确认队列 tab) and
// reports the write step as SKIP with the pending count, in the install page's SKIP-aware register:
// a skipped step is human work still outstanding, rendered as prominently as a successful one.
//
// STEP 4 IS NEVER ALLOWED TO SINK THE IMPORT. `mvp-persist` is flag-gated
// (MULTITABLE_STOCK_PREP_TABLE_ACTION_MVP_PERSIST_ENABLED) and is a SEPARATE consumer of the source.
// On a deployment with the flag off it answers 403 with its own code, which is a correct state and
// reports as SKIP. When it genuinely fails, the step reports FAIL — visibly, with its status — but
// `report.imported` and the verdict are computed from step 3 alone, because the BOM is already in the
// sheet by then and telling the operator otherwise would be a lie that costs them a re-run.
//
// VALUES-FREE. A step result carries a REASON CODE from the closed vocabulary below plus a detail map
// of counts, HTTP statuses and clamped server tokens. No server message and no cell content is ever
// lifted into a result. The one business string on this whole surface is the project number the
// OPERATOR TYPED, which the panel echoes back to them and which never comes from a response.
import { apiFetch } from '../../../utils/api'
import { buildQueryString, type IntegrationApiEnvelope, type IntegrationScope } from '../workbench'

/** The frozen table action this entry drives. Server-side default too; sent explicitly for clarity. */
export const STOCK_PREPARATION_PULL_BOM_ACTION_ID = 'plm.stock-preparation.pull-bom.v1'

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------

export type StockPreparationProjectSyncStepId = 'dry-run' | 'confirm-queue' | 'apply' | 'archive'

/** OK / SKIP / FAIL — the install page's three, plus `pending` for a step not reached yet. */
export type StockPreparationProjectSyncStepStatus = 'pending' | 'ok' | 'skip' | 'fail'

/** The closed reason vocabulary. The panel maps these to prose; nothing else reaches the DOM. */
export type StockPreparationProjectSyncReason =
  // 1. 试算
  | 'PLAN_READY'
  | 'PLAN_HELD_FOR_CONFIRMATION'
  | 'PLAN_PROJECT_NOT_FOUND'
  | 'PLAN_LARGE_BOM_BOUNDED'
  | 'PLAN_NOT_APPLYABLE'
  | 'PLAN_READ_FAILED'
  | 'PLAN_MALFORMED_RESPONSE'
  // 2. 确认
  | 'NOTHING_TO_CONFIRM'
  | 'CONFIRMATIONS_QUEUED'
  | 'RECONCILE_UNAVAILABLE'
  // 3. 写入
  | 'IMPORTED'
  | 'ALREADY_UP_TO_DATE'
  | 'WRITE_HELD_FOR_CONFIRMATION'
  | 'WRITE_NO_PLAN'
  | 'WRITE_PARTIAL'
  | 'WRITE_FAILED'
  // 4. 批次存档
  | 'BATCH_ARCHIVED'
  | 'BATCH_ALREADY_ARCHIVED'
  | 'BATCH_ARCHIVE_OUTCOME_UNKNOWN'
  | 'BATCH_ARCHIVE_DISABLED'
  | 'BATCH_ARCHIVE_NOT_ATTEMPTED'
  | 'BATCH_ARCHIVE_FAILED'

export interface StockPreparationProjectSyncStepDescriptor {
  id: StockPreparationProjectSyncStepId
  zh: string
  en: string
  /** The route template this step walks — printed in the disclosure, never composed from. */
  route: string
}

/**
 * THE PLAN. The order is the server's own: a token comes from a dry run, apply consumes it, and the
 * archive is a second read of the same source that has to happen after the write so the batch it
 * stores is the one the operator just looked at.
 *
 * `confirm-queue` sits between the plan and the write for the reason the install page's step order
 * gives: while anything is still parked, the write cannot honestly complete, and draining first is
 * the real operator sequence.
 */
export const STOCK_PREPARATION_PROJECT_SYNC_STEPS: readonly StockPreparationProjectSyncStepDescriptor[] = Object.freeze([
  Object.freeze({
    id: 'dry-run' as const,
    zh: '试算:看看会写入什么',
    en: 'Plan: see what would be written',
    route: 'POST /api/integration/table-actions/:actionId/dry-run',
  }),
  Object.freeze({
    id: 'confirm-queue' as const,
    zh: '确认:拿不准的交给人',
    en: 'Confirm: hand the uncertain rows to a person',
    route: 'POST /api/integration/table-actions/:actionId/confirmation-decisions/reconcile',
  }),
  Object.freeze({
    id: 'apply' as const,
    zh: '写入:BOM 落到多维表',
    en: 'Write: the BOM lands in the multitable',
    route: 'POST /api/integration/table-actions/:actionId/apply',
  }),
  Object.freeze({
    id: 'archive' as const,
    zh: '批次存档:留一份这次的样子',
    en: 'Archive: keep a copy of what this sync saw',
    route: 'POST /api/integration/table-actions/:actionId/mvp-persist',
  }),
])

/**
 * The dry-run status vocabulary, mirrored from `dryRunStatus()` in the plugin's
 * stock-preparation-table-actions.cjs. Clamped for the same reason installRun.ts clamps ensure modes:
 * `status` arrives as JSON and this file is the boundary, so the set that can reach a branch (and a
 * detail chip) is made finite here rather than trusted to stay closed server-side.
 */
export const STOCK_PREPARATION_DRY_RUN_STATUSES: readonly string[] = Object.freeze([
  'ready',
  'manual_confirm_required',
  'not_found',
  'large_bom_bounded',
  'failed',
])

/** The apply status vocabulary (`applyStatus()` in stock-preparation-apply-writer.cjs). */
export const STOCK_PREPARATION_APPLY_STATUSES: readonly string[] = Object.freeze([
  'succeeded',
  'partial',
  'failed',
  'held',
])

/** The token that stands in for anything outside a vocabulary. The raw value is never carried. */
export const STOCK_PREPARATION_UNKNOWN_TOKEN = 'other'

export function clampToken(value: unknown, vocabulary: readonly string[]): string {
  return typeof value === 'string' && vocabulary.includes(value) ? value : STOCK_PREPARATION_UNKNOWN_TOKEN
}

/**
 * A server error CODE, clamped to an identifier shape. A code is a token an operator quotes when they
 * ask for help, so it is worth carrying; the surrounding message is not, and a code that is not
 * identifier-shaped is not a code — it is prose that found its way into the field, and prose can
 * carry a value.
 */
export function clampErrorCode(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : null
}

export interface StockPreparationProjectSyncStepResult {
  index: number
  id: StockPreparationProjectSyncStepId
  status: Exclude<StockPreparationProjectSyncStepStatus, 'pending'>
  reason: StockPreparationProjectSyncReason
  /** Values-free tokens: counts, HTTP statuses, clamped server status/error tokens. */
  detail: Record<string, string | number>
}

/**
 * What actually happened, in the terms the panel's first sentence is written from.
 *
 * `partial` is its own verdict rather than a shade of `blocked`, and the distinction is not cosmetic:
 * a partial apply has ALREADY PUT ROWS IN THE SHEET. Folding it into `blocked` made the panel say
 * 「这次没有导入成功,数据没有变化」 over an import that had changed data — a false statement, and the
 * kind an operator acts on by re-running or by telling someone the sync did nothing.
 */
export type StockPreparationProjectSyncVerdict =
  | 'imported'
  | 'already_up_to_date'
  | 'partial'
  | 'held'
  | 'blocked'
  | 'not_run'

export interface StockPreparationProjectSyncReport {
  steps: StockPreparationProjectSyncStepResult[]
  okCount: number
  skipCount: number
  failCount: number
  totalSteps: number
  /**
   * DID THE BOM LAND? Computed from the write step ALONE — never from the run's overall tally, so a
   * failed batch archive (step 4, a different consumer entirely) cannot make a completed import read
   * as a failure.
   */
  imported: boolean
  verdict: StockPreparationProjectSyncVerdict
  /** Rows the plan stopped on: `counts.manual_confirm` from the dry run. */
  pendingConfirmCount: number
  /** Decisions now waiting in the 确认队列 tab (reconcile's `counts.pending`). */
  queuedDecisionCount: number
  /** The plan's own numbers, for the plain sentence. Null until the dry run lands. */
  planned: { add: number; update: number; skip: number; inactive: number; manualConfirm: number } | null
  /** What the write actually did. Null unless the write ran. */
  written: { created: number; updated: number; inactive: number; skipped: number; held: number; failed: number } | null
  /** True when no step FAILed. A run of OK + SKIP passes — held is not broken. */
  pass: boolean
  failedStepId: StockPreparationProjectSyncStepId | null
}

// ---------------------------------------------------------------------------
// pure helpers (the half the unit suite drives)
// ---------------------------------------------------------------------------

function result(
  index: number,
  id: StockPreparationProjectSyncStepId,
  status: Exclude<StockPreparationProjectSyncStepStatus, 'pending'>,
  reason: StockPreparationProjectSyncReason,
  detail: Record<string, string | number> = {},
): StockPreparationProjectSyncStepResult {
  return { index, id, status, reason, detail }
}

function intOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0
}

/** The five planned counts, in the server's own key names (`add`/`update`/`skip`, not insert/…). */
export function plannedCountsOf(counts: Record<string, number> | undefined | null): {
  add: number
  update: number
  skip: number
  inactive: number
  manualConfirm: number
} {
  const source = counts && typeof counts === 'object' ? counts : {}
  return {
    add: intOf(source.add),
    update: intOf(source.update),
    skip: intOf(source.skip),
    inactive: intOf(source.inactive),
    manualConfirm: intOf(source.manual_confirm),
  }
}

/** The apply counts — a DIFFERENT vocabulary from the plan's, so never share a reader. */
export function writtenCountsOf(counts: Record<string, number> | undefined | null): {
  created: number
  updated: number
  inactive: number
  skipped: number
  held: number
  failed: number
} {
  const source = counts && typeof counts === 'object' ? counts : {}
  return {
    created: intOf(source.created),
    updated: intOf(source.updated),
    inactive: intOf(source.inactive),
    skipped: intOf(source.skipped),
    held: intOf(source.held),
    failed: intOf(source.failed),
  }
}

/**
 * THE PLAN CLASSIFICATION — one function, so no caller can decide `held` means something else.
 *
 * The distinction that matters: `manual_confirm_required` is NOT a failure. The server issues a
 * dry-run token in that state (a fact worth knowing, because a comment elsewhere in this codebase
 * says the opposite), and the plan is perfectly valid apart from the rows a person has to look at. It
 * is reported OK here — the plan was produced — and the WRITE step is the one that skips.
 */
export function classifyPlanStep(
  index: number,
  plan: { status?: string; canApply?: boolean; dryRunToken?: string | null; counts?: Record<string, number> } | null,
  options: { status?: number; malformed?: boolean; errorCode?: string | null } = {},
): StockPreparationProjectSyncStepResult {
  if (options.malformed) {
    return result(index, 'dry-run', 'fail', 'PLAN_MALFORMED_RESPONSE', { status: options.status ?? 0 })
  }
  if (!plan) {
    const detail: Record<string, string | number> = { status: options.status ?? 0 }
    if (options.errorCode) detail.code = options.errorCode
    return result(index, 'dry-run', 'fail', 'PLAN_READ_FAILED', detail)
  }
  const status = clampToken(plan.status, STOCK_PREPARATION_DRY_RUN_STATUSES)
  const planned = plannedCountsOf(plan.counts)
  const base: Record<string, string | number> = {
    planStatus: status,
    add: planned.add,
    update: planned.update,
    skip: planned.skip,
    inactive: planned.inactive,
    manualConfirm: planned.manualConfirm,
  }

  // A project number the source does not know. Almost always a typo, occasionally a project that has
  // not reached PLM yet — either way it is something for a person to check, not a broken system.
  if (status === 'not_found') return result(index, 'dry-run', 'skip', 'PLAN_PROJECT_NOT_FOUND', base)
  // The BOM is too large for an interactive expansion; the background channel owns it.
  if (status === 'large_bom_bounded') return result(index, 'dry-run', 'skip', 'PLAN_LARGE_BOM_BOUNDED', base)
  if (plan.canApply !== true) return result(index, 'dry-run', 'fail', 'PLAN_NOT_APPLYABLE', base)
  if (planned.manualConfirm > 0 || status === 'manual_confirm_required') {
    return result(index, 'dry-run', 'ok', 'PLAN_HELD_FOR_CONFIRMATION', base)
  }
  return result(index, 'dry-run', 'ok', 'PLAN_READY', base)
}

/** The tally + the verdict. See `imported` on the report for why step 4 is excluded from it. */
export function summarizeProjectSync(
  steps: StockPreparationProjectSyncStepResult[],
  context: {
    pendingConfirmCount: number
    queuedDecisionCount: number
    planned: StockPreparationProjectSyncReport['planned']
    written: StockPreparationProjectSyncReport['written']
  },
): StockPreparationProjectSyncReport {
  const failed = steps.find((step) => step.status === 'fail') ?? null
  const write = steps.find((step) => step.id === 'apply') ?? null
  const imported = write?.status === 'ok' && write.reason === 'IMPORTED'
  const upToDate = write?.status === 'ok' && write.reason === 'ALREADY_UP_TO_DATE'

  let verdict: StockPreparationProjectSyncVerdict = 'not_run'
  if (imported) verdict = 'imported'
  else if (upToDate) verdict = 'already_up_to_date'
  // ROWS ARE IN THE SHEET. Checked before `held`/`blocked` because a partial write is the one outcome
  // where the panel must not say "nothing changed" — see the verdict type's note.
  else if (write?.reason === 'WRITE_PARTIAL') verdict = 'partial'
  else if (write?.reason === 'WRITE_HELD_FOR_CONFIRMATION') verdict = 'held'
  else if (steps.length > 0) verdict = 'blocked'

  return {
    steps,
    okCount: steps.filter((step) => step.status === 'ok').length,
    skipCount: steps.filter((step) => step.status === 'skip').length,
    failCount: steps.filter((step) => step.status === 'fail').length,
    totalSteps: STOCK_PREPARATION_PROJECT_SYNC_STEPS.length,
    imported,
    verdict,
    pendingConfirmCount: context.pendingConfirmCount,
    queuedDecisionCount: context.queuedDecisionCount,
    planned: context.planned,
    written: context.written,
    pass: failed === null,
    failedStepId: failed ? failed.id : null,
  }
}

// ---------------------------------------------------------------------------
// the API surface the run drives (injectable, so the suite never touches fetch)
// ---------------------------------------------------------------------------

export interface StockPreparationProjectSyncPlan {
  status?: string
  canApply?: boolean
  dryRunToken?: string | null
  counts?: Record<string, number>
}

export interface StockPreparationProjectSyncApplyResult {
  status?: string
  apply?: { counts?: Record<string, number>; written?: number }
}

export interface StockPreparationProjectSyncArchiveResult {
  status?: string
  persisted?: boolean
  created?: Record<string, number>
}

export interface StockPreparationProjectSyncApi {
  dryRun(projectNo: string): Promise<StockPreparationProjectSyncPlan>
  reconcile(projectNo: string): Promise<{ counts?: Record<string, number> }>
  apply(projectNo: string, dryRunToken: string): Promise<StockPreparationProjectSyncApplyResult>
  archive(projectNo: string): Promise<StockPreparationProjectSyncArchiveResult>
}

/** HTTP status + clamped error code of a failed call. Never carries a server message. */
export class StockPreparationProjectSyncCallError extends Error {
  status: number

  /** The server's own error code, when it is identifier-shaped. Null otherwise. */
  code: string | null

  /** True when the transport succeeded and the payload was not this API's envelope. */
  malformed: boolean

  constructor(status: number, route: string, options: { code?: string | null; malformed?: boolean } = {}) {
    super(`stock-preparation project sync call failed (${route} -> ${status})`)
    this.name = 'StockPreparationProjectSyncCallError'
    this.status = status
    this.code = options.code ?? null
    this.malformed = options.malformed === true
  }
}

function statusOf(error: unknown): number {
  return error instanceof StockPreparationProjectSyncCallError ? error.status : 0
}

function codeOf(error: unknown): string | null {
  return error instanceof StockPreparationProjectSyncCallError ? error.code : null
}

function isMalformed(error: unknown): boolean {
  return error instanceof StockPreparationProjectSyncCallError && error.malformed
}

/** The flag-off answer from mvp-persist. A correct deployment state, not a fault. */
export const BATCH_ARCHIVE_DISABLED_CODE = 'STOCK_PREPARATION_TABLE_ACTION_MVP_PERSIST_DISABLED'

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

/**
 * Walk the four steps for ONE project number. `onStep` fires after each so the panel can render
 * progress rather than a spinner — a run that stops at the plan must still show the plan's counts.
 *
 * The project number is the operator's own input, passed straight through as the single allowlisted
 * action parameter (`parameters.projectNo`, the only key the server accepts).
 */
export async function runStockPreparationProjectSync(
  api: StockPreparationProjectSyncApi,
  projectNo: string,
  onStep?: (step: StockPreparationProjectSyncStepResult) => void,
): Promise<StockPreparationProjectSyncReport> {
  const steps: StockPreparationProjectSyncStepResult[] = []
  let pendingConfirmCount = 0
  let queuedDecisionCount = 0
  let planned: StockPreparationProjectSyncReport['planned'] = null
  let written: StockPreparationProjectSyncReport['written'] = null

  function record(step: StockPreparationProjectSyncStepResult): StockPreparationProjectSyncStepResult {
    steps.push(step)
    if (onStep) onStep(step)
    return step
  }

  function done(): StockPreparationProjectSyncReport {
    return summarizeProjectSync(steps, { pendingConfirmCount, queuedDecisionCount, planned, written })
  }

  // ---- 1. 试算 -------------------------------------------------------------
  let plan: StockPreparationProjectSyncPlan | null = null
  let planStep: StockPreparationProjectSyncStepResult
  try {
    plan = await api.dryRun(projectNo)
    planned = plannedCountsOf(plan?.counts)
    pendingConfirmCount = planned.manualConfirm
    planStep = record(classifyPlanStep(1, plan))
  } catch (error) {
    planStep = record(classifyPlanStep(1, null, {
      status: statusOf(error),
      malformed: isMalformed(error),
      errorCode: codeOf(error),
    }))
  }
  if (planStep.status !== 'ok') return done()

  // ---- 2. 确认 -------------------------------------------------------------
  const held = planStep.reason === 'PLAN_HELD_FOR_CONFIRMATION'
  if (!held) {
    record(result(2, 'confirm-queue', 'skip', 'NOTHING_TO_CONFIRM', { manualConfirm: 0 }))
  } else {
    try {
      const reconciled = await api.reconcile(projectNo)
      const counts = reconciled?.counts && typeof reconciled.counts === 'object' ? reconciled.counts : {}
      queuedDecisionCount = intOf(counts.pending)
      record(result(2, 'confirm-queue', 'ok', 'CONFIRMATIONS_QUEUED', {
        pending: queuedDecisionCount,
        created: intOf(counts.created),
        existing: intOf(counts.existing),
      }))
    } catch (error) {
      // Reconcile is the queue's REFRESH, not its only writer: rows an earlier run already ledgered
      // are still in the queue. A refusal here (a lease held by another run, a caller without the
      // platform-admin tier the route keeps) therefore costs the operator freshness, not the queue —
      // so it is a SKIP that still points at the tab, never a failure of the import.
      const detail: Record<string, string | number> = { status: statusOf(error) }
      const code = codeOf(error)
      if (code) detail.code = code
      record(result(2, 'confirm-queue', 'skip', 'RECONCILE_UNAVAILABLE', detail))
    }
  }

  // ---- 3. 写入 -------------------------------------------------------------
  const token = typeof plan?.dryRunToken === 'string' && plan.dryRunToken.length > 0 ? plan.dryRunToken : null
  if (held) {
    // Deliberately NOT applying with acceptManualConfirmHold. See the module header.
    record(result(3, 'apply', 'skip', 'WRITE_HELD_FOR_CONFIRMATION', {
      manualConfirm: pendingConfirmCount,
      pending: queuedDecisionCount,
    }))
    record(result(4, 'archive', 'skip', 'BATCH_ARCHIVE_NOT_ATTEMPTED', {}))
    return done()
  }
  if (!token) {
    record(result(3, 'apply', 'skip', 'WRITE_NO_PLAN', { planStatus: clampToken(plan?.status, STOCK_PREPARATION_DRY_RUN_STATUSES) }))
    record(result(4, 'archive', 'skip', 'BATCH_ARCHIVE_NOT_ATTEMPTED', {}))
    return done()
  }

  let writeOk = false
  try {
    const applied = await api.apply(projectNo, token)
    written = writtenCountsOf(applied?.apply?.counts)
    const applyStatus = clampToken(applied?.status, STOCK_PREPARATION_APPLY_STATUSES)
    const detail: Record<string, string | number> = {
      applyStatus,
      created: written.created,
      updated: written.updated,
      inactive: written.inactive,
      skipped: written.skipped,
      held: written.held,
      failed: written.failed,
    }
    const touched = written.created + written.updated + written.inactive
    if (applyStatus === 'succeeded' && touched === 0) {
      // The manifest's second acceptance criterion, seen from the operator's side: syncing the same
      // data again writes nothing twice. That is a success, and saying "0 rows written" without
      // saying why reads as a failure.
      record(result(3, 'apply', 'ok', 'ALREADY_UP_TO_DATE', detail))
      writeOk = true
    } else if (applyStatus === 'succeeded') {
      record(result(3, 'apply', 'ok', 'IMPORTED', detail))
      writeOk = true
    } else if (applyStatus === 'partial') {
      // Some rows landed and some did not. It IS an import, and it is also unfinished work.
      record(result(3, 'apply', 'skip', 'WRITE_PARTIAL', detail))
      writeOk = true
    } else {
      record(result(3, 'apply', 'fail', 'WRITE_FAILED', detail))
    }
  } catch (error) {
    const detail: Record<string, string | number> = { status: statusOf(error) }
    const code = codeOf(error)
    if (code) detail.code = code
    record(result(3, 'apply', 'fail', 'WRITE_FAILED', detail))
  }

  // ---- 4. 批次存档 ---------------------------------------------------------
  if (!writeOk) {
    record(result(4, 'archive', 'skip', 'BATCH_ARCHIVE_NOT_ATTEMPTED', {}))
    return done()
  }
  try {
    const archived = await api.archive(projectNo)
    const created = archived?.created && typeof archived.created === 'object' ? archived.created : {}
    const detail: Record<string, string | number> = {
      batch: intOf(created.batch),
      lines: intOf(created.lines),
      run: intOf(created.run),
    }
    // A 2xx IS NOT AN ANSWER — and neither is a missing discriminator. `persisted` is the ONLY thing
    // that distinguishes "a new batch was stored" from "this batch was already there", and both are
    // POSITIVE CLAIMS about the customer's data. Treating an absent or non-boolean `persisted` as
    // `false` would have made the panel assert 「这一批之前已经存过了」 on a response that said no such
    // thing — a claim the client cannot possibly know. An unusable discriminator gets its own
    // outcome instead, which names what IS known (the call succeeded) and where to look.
    if (archived?.persisted === true) record(result(4, 'archive', 'ok', 'BATCH_ARCHIVED', detail))
    else if (archived?.persisted === false) record(result(4, 'archive', 'ok', 'BATCH_ALREADY_ARCHIVED', detail))
    else record(result(4, 'archive', 'ok', 'BATCH_ARCHIVE_OUTCOME_UNKNOWN', detail))
  } catch (error) {
    const code = codeOf(error)
    const detail: Record<string, string | number> = { status: statusOf(error) }
    if (code) detail.code = code
    // The flag being off is the deployment saying "this deployment does not keep snapshot batches",
    // which is a setting, not a fault.
    if (code === BATCH_ARCHIVE_DISABLED_CODE) {
      record(result(4, 'archive', 'skip', 'BATCH_ARCHIVE_DISABLED', detail))
    } else {
      // VISIBLE, and NON-FATAL. `report.imported` is already true and stays true: the rows are in the
      // sheet. What is missing is this run's entry in 批次与差异, and that is what the step says.
      record(result(4, 'archive', 'fail', 'BATCH_ARCHIVE_FAILED', detail))
    }
  }
  return done()
}

// ---------------------------------------------------------------------------
// the default API implementation — existing routes only, existing gates only
// ---------------------------------------------------------------------------

/**
 * A 2xx IS NOT AN ANSWER — the envelope has to be there. Same reasoning as installRun.ts: an auth
 * proxy answering 200 with an HTML sign-in page would otherwise let this module report an import
 * that never happened, and reporting rows that are not there is worse than reporting a failure.
 */
async function readEnvelope<T>(response: Response | undefined, route: string): Promise<T> {
  let payload: unknown = null
  try {
    payload = await response?.json()
  } catch {
    payload = null
  }
  const status = typeof response?.status === 'number' ? response.status : 0
  const envelope = (payload && typeof payload === 'object' && !Array.isArray(payload))
    ? payload as IntegrationApiEnvelope<T>
    : null
  if (!response?.ok || envelope?.ok === false) {
    throw new StockPreparationProjectSyncCallError(status, route, {
      code: clampErrorCode(envelope?.error?.code),
    })
  }
  if (!envelope || envelope.ok !== true) {
    throw new StockPreparationProjectSyncCallError(status, route, { malformed: true })
  }
  return (envelope.data ?? {}) as T
}

export function createStockPreparationProjectSyncApi(
  scope: IntegrationScope,
  actionId: string = STOCK_PREPARATION_PULL_BOM_ACTION_ID,
): StockPreparationProjectSyncApi {
  const query = buildQueryString({ tenantId: scope.tenantId, workspaceId: scope.workspaceId })
  const suffix = query ? `?${query}` : ''
  const base = `/api/integration/table-actions/${encodeURIComponent(actionId)}`
  const json = { 'Content-Type': 'application/json' }

  return {
    async dryRun(projectNo: string) {
      const route = `${base}/dry-run`
      const response = await apiFetch(`${route}${suffix}`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ parameters: { projectNo } }),
      })
      return readEnvelope<StockPreparationProjectSyncPlan>(response, route)
    },

    async reconcile(projectNo: string) {
      const route = `${base}/confirmation-decisions/reconcile`
      const response = await apiFetch(`${route}${suffix}`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ parameters: { projectNo } }),
      })
      return readEnvelope<{ counts?: Record<string, number> }>(response, route)
    },

    async apply(projectNo: string, dryRunToken: string) {
      const route = `${base}/apply`
      const response = await apiFetch(`${route}${suffix}`, {
        method: 'POST',
        headers: json,
        // `confirm.dryRunToken` only. `acceptManualConfirmHold` is deliberately never sent — a held
        // plan does not reach this call at all (see the module header).
        body: JSON.stringify({ parameters: { projectNo }, confirm: { dryRunToken } }),
      })
      return readEnvelope<StockPreparationProjectSyncApplyResult>(response, route)
    },

    async archive(projectNo: string) {
      const route = `${base}/mvp-persist`
      // NO QUERY STRING. mvp-persist refuses a request carrying any query at all
      // (assertStockPreparationTableActionMvpPersistNoSteering): with auto-persist on, the route
      // gains a write side-effect, so an explicit tenant/workspace on any carrier is a steering
      // vector and is rejected fail-closed. The tenant comes from the authenticated principal.
      const response = await apiFetch(route, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ parameters: { projectNo } }),
      })
      return readEnvelope<StockPreparationProjectSyncArchiveResult>(response, route)
    },
  }
}
