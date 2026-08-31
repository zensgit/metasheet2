// BOM备料 INSTALL PAGE — the RUN side ("装应用(一键)", §3).
//
// THE STEP ORDER IS NOT THIS FILE'S INVENTION. It is `STEP_PLAN` in
// scripts/ops/stock-prep-acceptance-bootstrap.mjs, the harness that drove the first live deployment
// by hand and then encoded every one of that day's archaeological findings as an ordered,
// individually-reportable, IDEMPOTENT step. Two things in that order are load-bearing and are
// reproduced here verbatim:
//
//   1. `confirmation-queue` sits BEFORE the three acceptance steps. The script's own comment says
//      why: a deployment that has been used carries holds an earlier operator left behind, the plan
//      then comes back manual_confirm_required, no dry-run token is minted, and apply answers 409 —
//      so acceptance can only run AFTER the queue is worked. Draining first is also the real
//      operator sequence.
//   2. `managed-tables` reads the sandbox `objectId` off the CONFIGURED PACK's declared
//      `targetObjectId`. Never invented, never from env, never from the operator. Two operators
//      inventing different names on one machine is the incident the whole manifest line exists for.
//
// WHAT THIS PAGE DRIVES, AND WHAT IT DELIBERATELY DOES NOT. Three steps are driven from the browser
// (preflight, managed-tables, customer-pack) because their routes need nothing but the authenticated
// principal. The remaining five are HELD and always report SKIP with the reason they are held:
// source-wiring and the acceptance trio need deployment-side ids (a data source, an external system,
// a table action, a project number) and, for apply, authority this page does not have; the
// confirmation queue needs a project number and a human working the holds. A held plan is human work
// outstanding, not a broken install — which is why SKIP is a first-class outcome here and is rendered
// as prominently as OK.
//
// NO NEW WRITE AUTHORITY. Every call below is an EXISTING route with its existing gate: the two
// ensures and the two pack routes are platform-admin server-side, and this module adds nothing to
// them. The four fences are never touched, never advised, and have no control anywhere on the page.
//
// VALUES-FREE. A step result carries a REASON CODE from the closed vocabulary below plus a detail
// map of ids, counts and HTTP statuses. No server message and no cell content is ever lifted into a
// result — the view renders the code through its own label map, so a value-carrying string has no
// path to the DOM.
import { apiFetch } from '../../../utils/api'
import { buildQueryString, type IntegrationApiEnvelope, type IntegrationScope } from '../workbench'
import type { StockPreparationPreflight } from './installPlan'
import { STOCK_PREPARATION_PREFLIGHT_ROUTE } from './installPlan'

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------

export type StockPreparationInstallStepId =
  | 'preflight'
  | 'managed-tables'
  | 'customer-pack'
  | 'source-wiring'
  | 'confirmation-queue'
  | 'acceptance-dry-run'
  | 'acceptance-apply'
  | 'acceptance-idempotent'
  | 'preflight-recheck'

/** OK / SKIP / FAIL — the bootstrap's own three, and `pending` for a step not reached yet. */
export type StockPreparationInstallStepStatus = 'pending' | 'ok' | 'skip' | 'fail'

/** The closed reason vocabulary. The view maps these to prose; nothing else reaches the DOM. */
export type StockPreparationInstallReason =
  | 'PREFLIGHT_READY'
  | 'PREFLIGHT_ROUTE_ABSENT'
  | 'PREFLIGHT_BLOCKERS_PROVISIONED_BELOW'
  | 'PREFLIGHT_BLOCKERS_DEPLOYMENT_DATA'
  | 'PREFLIGHT_READ_FAILED'
  | 'LEDGER_ENSURE_FAILED'
  | 'PACK_CATALOG_READ_FAILED'
  | 'PACK_CATALOG_EMPTY'
  | 'PACK_CATALOG_AMBIGUOUS'
  | 'SANDBOX_ENSURE_FAILED'
  | 'MANAGED_TABLES_READY'
  | 'PACK_DRY_RUN_FAILED'
  | 'PACK_DRY_RUN_CONFLICTS'
  | 'PACK_INSTALL_FAILED'
  | 'PACK_INSTALL_NOT_IDEMPOTENT'
  | 'PACK_INSTALLED'
  | 'HELD_FOR_OPERATOR'
  | 'MALFORMED_RESPONSE'
  | 'RECHECK_READY'
  | 'RECHECK_STILL_BLOCKED'

export interface StockPreparationInstallStepDescriptor {
  id: StockPreparationInstallStepId
  zh: string
  en: string
  /** The route templates this step walks — printed, never composed from. */
  routes: readonly string[]
  /** False for a HELD step: the page reports it and never calls it. */
  driven: boolean
  /** Why a held step is held. Present only when `driven` is false. */
  heldZh?: string
  heldEn?: string
}

/**
 * THE PLAN. Ids 1-8 and their order are `STEP_PLAN` in the bootstrap script, unchanged.
 *
 * `preflight-recheck` is this page's own addition and is marked as such: it re-reads the SAME
 * read-only preflight after the provisioning steps, which is the smallest honest form of §2's 「验」
 * that a browser can do. The acceptance criteria proper (the two in the manifest) stay with the
 * script named in `acceptance.verifiedBy`, and steps 6-8 say so rather than pretending otherwise.
 */
export const STOCK_PREPARATION_INSTALL_STEPS: readonly StockPreparationInstallStepDescriptor[] = Object.freeze([
  Object.freeze({
    id: 'preflight' as const,
    zh: '预检',
    en: 'Preflight',
    routes: Object.freeze(['GET /api/integration/stock-preparation/preflight']),
    driven: true,
  }),
  Object.freeze({
    id: 'managed-tables' as const,
    zh: '受管表建表',
    en: 'Managed tables',
    routes: Object.freeze([
      'POST /api/integration/stock-preparation/confirmation-decisions/ensure',
      'GET  /api/integration/stock-preparation/customer-packs',
      'POST /api/integration/stock-preparation/sandbox-target/ensure',
    ]),
    driven: true,
  }),
  Object.freeze({
    id: 'customer-pack' as const,
    zh: '客户包装列',
    en: 'Customer pack',
    routes: Object.freeze([
      'POST /api/integration/stock-preparation/customer-packs/:packId/dry-run',
      'POST /api/integration/stock-preparation/customer-packs/:packId/install (x2)',
    ]),
    driven: true,
  }),
  Object.freeze({
    id: 'source-wiring' as const,
    zh: '源接入',
    en: 'Source wiring',
    routes: Object.freeze([
      'GET  /api/data-sources/:id',
      'GET  /api/integration/external-systems/:id',
      'POST /api/integration/external-systems/:id/test',
    ]),
    driven: false,
    heldZh: '本页不接源:数据源与外部系统的 id 是部署期数据,连接信息永远走「草案→审核→服务端文件」,不因应用化而短路。到「数据源」页接完再回来。',
    heldEn: 'Not driven here: the data-source and external-system ids are deployment data, and source credentials always go through draft -> review -> server-side file. Wire the source on the data-source page first.',
  }),
  Object.freeze({
    id: 'confirmation-queue' as const,
    zh: '确认队列排空',
    en: 'Confirmation queue',
    routes: Object.freeze([
      'POST /api/integration/table-actions/:actionId/confirmation-decisions/reconcile',
      'GET  /api/integration/stock-preparation/confirmation-decisions',
      'POST /api/integration/stock-preparation/confirmation-decisions/confirm',
    ]),
    driven: false,
    heldZh: '排空是人工工作:reconcile 要项目号与一个 active 的外部系统,确认要人来做。顺序有意——先排空、再验收:留着的暂挂会让计划回到 manual_confirm_required,不出令牌、apply 恒 409。到「确认队列」页处理。',
    heldEn: 'Human work: reconcile needs a project number and an ACTIVE external system, and confirming is a person\'s decision. The order is load-bearing — drain first, accept second: leftover holds make the plan manual_confirm_required, no token is minted and apply answers 409. Work it on the confirmation-queue tab.',
  }),
  Object.freeze({
    id: 'acceptance-dry-run' as const,
    zh: '验收:dry-run',
    en: 'Acceptance dry-run',
    routes: Object.freeze(['POST /api/integration/table-actions/:actionId/dry-run']),
    driven: false,
    heldZh: '验收由清单声明的脚本跑:scripts/ops/stock-prep-acceptance-bootstrap.mjs。它要项目号与 action id,而这两个绑定 API 从不暴露,页面猜一个就是接错系统。',
    heldEn: 'Acceptance is run by the script the manifest names: scripts/ops/stock-prep-acceptance-bootstrap.mjs. It needs a project number and an action id, and that binding is never exposed by the API — a guess here would wire the wrong system.',
  }),
  Object.freeze({
    id: 'acceptance-apply' as const,
    zh: '验收:apply(判据一)',
    en: 'Acceptance apply (criterion 1)',
    routes: Object.freeze(['POST /api/integration/table-actions/:actionId/apply']),
    driven: false,
    heldZh: '本页不写行。判据一要看目标表单元格证明「ext_ 列有值、人工档为空」,那是脚本的活;生产 Apply 关闭是围栏,不是故障。',
    heldEn: 'This page applies no rows. Criterion 1 has to look at target cells to prove mapped ext_ columns are non-empty while the human band stays empty — that is the script\'s job; production Apply being closed is a fence, not a fault.',
  }),
  Object.freeze({
    id: 'acceptance-idempotent' as const,
    zh: '验收:二次 dry-run 全 skip(判据二)',
    en: 'Acceptance idempotence (criterion 2)',
    routes: Object.freeze(['POST /api/integration/table-actions/:actionId/dry-run']),
    driven: false,
    heldZh: '同上:第二次 dry-run 必须全 skip,由脚本断言。',
    heldEn: 'Same: the second dry-run must be all-skip, and the script is what asserts it.',
  }),
  Object.freeze({
    id: 'preflight-recheck' as const,
    zh: '复检(本页自加)',
    en: 'Recheck (added by this page)',
    routes: Object.freeze(['GET /api/integration/stock-preparation/preflight']),
    driven: true,
  }),
])

/**
 * THE ENSURE-MODE VOCABULARY, mirrored from the two server modules that produce it:
 * `stock-preparation-confirmation-decisions.cjs` (the ledger) and
 * `stock-preparation-target-provisioning.cjs` (the sandbox target, whose modes are the
 * `modePrefix`-prefixed set with `modePrefix = 'sandbox'` on this route).
 *
 * Why an allowlist rather than a type: `mode` arrives as JSON and this file is the boundary. Today's
 * server vocabularies are closed, but nothing on THIS side enforced that, so `mode` was a
 * server-controlled unbounded string being rendered into a chip. Clamping makes the rendered set
 * finite by construction — an unrecognised token becomes `other` and the raw value is dropped rather
 * than displayed. The cost is that a mode added server-side reads as `other` until it is added here;
 * that is a display degradation on a line whose real content is the step's OK/SKIP/FAIL, and it is
 * the right way round.
 */
export const STOCK_PREPARATION_ENSURE_MODES: readonly string[] = Object.freeze([
  'confirmation_decision_created',
  'confirmation_decision_existing',
  'confirmation_decision_incomplete',
  'confirmation_decision_missing',
  'sandbox_already_ready',
  'sandbox_create',
  'sandbox_existing',
  'sandbox_incomplete',
  'sandbox_missing',
  'sandbox_repaired',
  // This module's own stand-in for a route that answered without naming a mode.
  'ok',
])

/** The token that stands in for anything outside the vocabulary. The raw value is never carried. */
export const STOCK_PREPARATION_UNKNOWN_MODE = 'other'

export function clampEnsureMode(value: unknown): string {
  return typeof value === 'string' && STOCK_PREPARATION_ENSURE_MODES.includes(value)
    ? value
    : STOCK_PREPARATION_UNKNOWN_MODE
}

export interface StockPreparationInstallStepResult {
  index: number
  id: StockPreparationInstallStepId
  status: Exclude<StockPreparationInstallStepStatus, 'pending'>
  reason: StockPreparationInstallReason
  /** Values-free tokens: ids, counts, HTTP statuses, blocker codes. Never a message or a value. */
  detail: Record<string, string | number>
  /** Paste-able `fix.run` lines, verbatim from the preflight route. */
  fixes: string[]
}

export interface StockPreparationInstallRunReport {
  steps: StockPreparationInstallStepResult[]
  okCount: number
  skipCount: number
  failCount: number
  completedSteps: number
  totalSteps: number
  /** True when no step FAILed. A run that is all SKIP still passes — held is not broken. */
  pass: boolean
  failedStepId: StockPreparationInstallStepId | null
}

// ---------------------------------------------------------------------------
// pure helpers (the half the unit suite drives)
// ---------------------------------------------------------------------------

function result(
  index: number,
  id: StockPreparationInstallStepId,
  status: Exclude<StockPreparationInstallStepStatus, 'pending'>,
  reason: StockPreparationInstallReason,
  detail: Record<string, string | number> = {},
  fixes: string[] = [],
): StockPreparationInstallStepResult {
  return { index, id, status, reason, detail, fixes }
}

/**
 * A HELD step's outcome. Always SKIP, never FAIL, and never conditional: a step this page does not
 * drive cannot succeed or fail here, and reporting it as anything but SKIP would either hide the
 * outstanding work or invent a failure that did not happen.
 */
export function heldStepResult(
  index: number,
  descriptor: StockPreparationInstallStepDescriptor,
): StockPreparationInstallStepResult {
  return result(index, descriptor.id, 'skip', 'HELD_FOR_OPERATOR')
}

/**
 * THE PREFLIGHT CLASSIFICATION, and the one judgement call in this file — made from the route's OWN
 * data model rather than from a list of blocker codes typed here.
 *
 * A blocker carries a `fix` that is either `kind: 'http'` (a call) or `kind: 'env'` (a line for the
 * deployment machine's environment). That distinction already answers the only question the run has
 * to ask:
 *
 *   every blocker is an HTTP fix  -> SKIP. These are the ensures the very next steps make. Failing
 *                                    the run here would mean the button could never bootstrap a
 *                                    fresh deployment — the ledger-not-ready blocker's own fix IS
 *                                    step 2's first call.
 *   any blocker is an ENV fix     -> FAIL. Deployment data only a human on that machine can supply.
 *                                    The install page has no env field and must never grow one, so
 *                                    there is nothing further for the run to do.
 *   a blocker with no fix at all  -> FAIL, on the same reading: nothing here can clear it.
 *
 * The fix lines are carried through VERBATIM so the operator copies exactly what the route composed.
 */
export function classifyPreflightStep(
  index: number,
  preflight: StockPreparationPreflight | null,
  options: { routeAbsent?: boolean; status?: number; recheck?: boolean; malformed?: boolean } = {},
): StockPreparationInstallStepResult {
  const id: StockPreparationInstallStepId = options.recheck ? 'preflight-recheck' : 'preflight'

  // Checked BEFORE the route-absent degrade: an absent route answers 404/501, so the two can never
  // both be true, and a malformed 2xx must never be softened into "this deployment is just old".
  if (options.malformed) {
    return result(index, id, 'fail', 'MALFORMED_RESPONSE', { status: options.status ?? 0 })
  }
  if (options.routeAbsent) {
    // The bootstrap degrades here too, and for the same reason: a deployment that predates the
    // route is old, not broken.
    return result(index, id, 'skip', 'PREFLIGHT_ROUTE_ABSENT', { status: options.status ?? 404 })
  }
  if (!preflight) {
    return result(index, id, 'fail', 'PREFLIGHT_READ_FAILED', { status: options.status ?? 0 })
  }

  const blockers = Array.isArray(preflight.blockers) ? preflight.blockers : []
  const fixes = blockers
    .map((blocker) => blocker.fix?.run)
    .filter((run): run is string => typeof run === 'string' && run.length > 0)
  const codes = blockers.map((blocker) => blocker.code).join(',')

  if (preflight.ready === true && blockers.length === 0) {
    return result(index, id, 'ok', options.recheck ? 'RECHECK_READY' : 'PREFLIGHT_READY', { blockerCount: 0 })
  }

  if (options.recheck) {
    return result(index, id, 'skip', 'RECHECK_STILL_BLOCKED', { blockerCount: blockers.length, codes }, fixes)
  }

  const needsDeploymentData = blockers.some((blocker) => blocker.fix?.kind !== 'http')
  return needsDeploymentData
    ? result(index, id, 'fail', 'PREFLIGHT_BLOCKERS_DEPLOYMENT_DATA', { blockerCount: blockers.length, codes }, fixes)
    : result(index, id, 'skip', 'PREFLIGHT_BLOCKERS_PROVISIONED_BELOW', { blockerCount: blockers.length, codes }, fixes)
}

/** The tally. A run of nothing but SKIPs passes — that is the whole point of SKIP. */
export function summarizeInstallRun(
  steps: StockPreparationInstallStepResult[],
): StockPreparationInstallRunReport {
  const failed = steps.find((step) => step.status === 'fail') ?? null
  return {
    steps,
    okCount: steps.filter((step) => step.status === 'ok').length,
    skipCount: steps.filter((step) => step.status === 'skip').length,
    failCount: steps.filter((step) => step.status === 'fail').length,
    completedSteps: steps.length,
    totalSteps: STOCK_PREPARATION_INSTALL_STEPS.length,
    pass: failed === null,
    failedStepId: failed ? failed.id : null,
  }
}

// ---------------------------------------------------------------------------
// the API surface the run drives (injectable, so the suite never touches fetch)
// ---------------------------------------------------------------------------

export interface StockPreparationPackSummary {
  packId: string
  packVersion?: string
  targetObjectId?: string
  extensionFields?: Array<{ id: string }>
  optionSets?: Array<{ fieldId: string; optionCount?: number }>
}

export interface StockPreparationInstallApi {
  /** null + routeAbsent when the deployment predates the preflight route. */
  readPreflight(): Promise<{ preflight: StockPreparationPreflight | null; routeAbsent: boolean; status: number }>
  ensureConfirmationLedger(): Promise<{ mode?: string }>
  listCustomerPacks(): Promise<{ packCount: number; packs: StockPreparationPackSummary[] }>
  ensureSandboxTarget(objectId: string): Promise<{ mode?: string; ready?: boolean }>
  dryRunCustomerPack(packId: string): Promise<{ canInstall?: boolean; conflictingFieldIds?: string[] }>
  installCustomerPack(packId: string): Promise<{ createdFields?: string[]; stampedFields?: string[] }>
}

/** HTTP status of a failed install call. Never carries a server message. */
export class StockPreparationInstallCallError extends Error {
  status: number

  /**
   * True when the transport SUCCEEDED and the payload was not this API's envelope — a 2xx carrying
   * an HTML sign-in page, an empty body, an array. Kept apart from an ordinary failure because the
   * two need different words: one says the server refused, the other says something that is not the
   * server answered in its place.
   */
  malformed: boolean

  constructor(status: number, route: string, options: { malformed?: boolean } = {}) {
    super(`stock-preparation install call failed (${route} -> ${status}${options.malformed ? ', malformed' : ''})`)
    this.name = 'StockPreparationInstallCallError'
    this.status = status
    this.malformed = options.malformed === true
  }
}

function statusOf(error: unknown): number {
  return error instanceof StockPreparationInstallCallError ? error.status : 0
}

/** A malformed 2xx gets its own reason wherever it happens — never the step's ordinary failure. */
function reasonFor(error: unknown, ordinary: StockPreparationInstallReason): StockPreparationInstallReason {
  return error instanceof StockPreparationInstallCallError && error.malformed
    ? 'MALFORMED_RESPONSE'
    : ordinary
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

/**
 * Walk the plan in order, one step at a time, stopping at the first FAIL and returning everything
 * that completed. No parallelism: step 3 installs onto the table step 2 created, and a preflight run
 * concurrently with an ensure would report a state that never existed.
 *
 * `onStep` is called after each step so the view can render progress instead of a spinner.
 */
export async function runStockPreparationInstall(
  api: StockPreparationInstallApi,
  onStep?: (step: StockPreparationInstallStepResult) => void,
): Promise<StockPreparationInstallRunReport> {
  const steps: StockPreparationInstallStepResult[] = []
  /** The single pack this run acts on, resolved in step 2 and reused in step 3. */
  let pack: StockPreparationPackSummary | null = null

  function record(step: StockPreparationInstallStepResult): StockPreparationInstallStepResult {
    steps.push(step)
    if (onStep) onStep(step)
    return step
  }

  for (let i = 0; i < STOCK_PREPARATION_INSTALL_STEPS.length; i += 1) {
    const descriptor = STOCK_PREPARATION_INSTALL_STEPS[i]
    const index = i + 1

    if (!descriptor.driven) {
      record(heldStepResult(index, descriptor))
      continue
    }

    if (descriptor.id === 'preflight' || descriptor.id === 'preflight-recheck') {
      let read: { preflight: StockPreparationPreflight | null; routeAbsent: boolean; status: number }
      let malformed = false
      try {
        read = await api.readPreflight()
      } catch (error) {
        read = { preflight: null, routeAbsent: false, status: statusOf(error) }
        malformed = reasonFor(error, 'PREFLIGHT_READ_FAILED') === 'MALFORMED_RESPONSE'
      }
      const step = record(classifyPreflightStep(index, read.preflight, {
        routeAbsent: read.routeAbsent,
        status: read.status,
        recheck: descriptor.id === 'preflight-recheck',
        malformed,
      }))
      if (step.status === 'fail') break
      continue
    }

    if (descriptor.id === 'managed-tables') {
      let ledgerMode = STOCK_PREPARATION_UNKNOWN_MODE
      try {
        const ledger = await api.ensureConfirmationLedger()
        ledgerMode = clampEnsureMode(ledger?.mode ?? 'ok')
      } catch (error) {
        record(result(index, descriptor.id, 'fail', reasonFor(error, 'LEDGER_ENSURE_FAILED'), { status: statusOf(error) }))
        break
      }

      let catalog: { packCount: number; packs: StockPreparationPackSummary[] }
      try {
        catalog = await api.listCustomerPacks()
      } catch (error) {
        record(result(index, descriptor.id, 'fail', reasonFor(error, 'PACK_CATALOG_READ_FAILED'), { status: statusOf(error), ledgerMode }))
        break
      }

      const packs = Array.isArray(catalog?.packs) ? catalog.packs : []
      if (packs.length === 0) {
        // Deployment data not supplied yet. The ledger IS provisioned and the reason says so — a
        // half-done step reported as a blank failure is how an operator re-runs work already done.
        record(result(index, descriptor.id, 'skip', 'PACK_CATALOG_EMPTY', { ledgerMode, packCount: 0 }))
        continue
      }
      if (packs.length > 1) {
        // The page does not choose which customer pack a deployment installs. That is the
        // bootstrap's MS_PACK_ID, and guessing would install one customer's columns on another's.
        record(result(index, descriptor.id, 'skip', 'PACK_CATALOG_AMBIGUOUS', { ledgerMode, packCount: packs.length }))
        continue
      }

      pack = packs[0]
      const objectId = typeof pack.targetObjectId === 'string' ? pack.targetObjectId : ''
      try {
        const sandbox = await api.ensureSandboxTarget(objectId)
        record(result(index, descriptor.id, 'ok', 'MANAGED_TABLES_READY', {
          ledgerMode,
          sandboxMode: clampEnsureMode(sandbox?.mode ?? 'ok'),
          objectId,
          packId: pack.packId,
        }))
      } catch (error) {
        pack = null
        record(result(index, descriptor.id, 'fail', reasonFor(error, 'SANDBOX_ENSURE_FAILED'), { status: statusOf(error), objectId }))
        break
      }
      continue
    }

    if (descriptor.id === 'customer-pack') {
      if (!pack) {
        // Step 2 skipped, so this one is held on the same outstanding human work.
        record(result(index, descriptor.id, 'skip', 'PACK_CATALOG_EMPTY', { packCount: 0 }))
        continue
      }
      const packId = pack.packId

      try {
        const plan = await api.dryRunCustomerPack(packId)
        if (plan?.canInstall !== true) {
          const conflicts = Array.isArray(plan?.conflictingFieldIds) ? plan.conflictingFieldIds : []
          record(result(index, descriptor.id, 'fail', 'PACK_DRY_RUN_CONFLICTS', {
            packId,
            conflictCount: conflicts.length,
            conflictingFieldIds: conflicts.join(','),
          }))
          break
        }
      } catch (error) {
        record(result(index, descriptor.id, 'fail', reasonFor(error, 'PACK_DRY_RUN_FAILED'), { packId, status: statusOf(error) }))
        break
      }

      let createdCount = 0
      try {
        const first = await api.installCustomerPack(packId)
        createdCount = Array.isArray(first?.createdFields) ? first.createdFields.length : 0
      } catch (error) {
        record(result(index, descriptor.id, 'fail', reasonFor(error, 'PACK_INSTALL_FAILED'), { packId, status: statusOf(error) }))
        break
      }

      // The re-run is the assertion, not a retry: install is declared idempotent, so the second
      // pass must create nothing. The first live deployment is why it is checked rather than trusted.
      try {
        const second = await api.installCustomerPack(packId)
        const secondCreated = Array.isArray(second?.createdFields) ? second.createdFields.length : 0
        if (secondCreated > 0) {
          record(result(index, descriptor.id, 'fail', 'PACK_INSTALL_NOT_IDEMPOTENT', {
            packId,
            createdCount,
            secondCreatedCount: secondCreated,
          }))
          break
        }
      } catch (error) {
        record(result(index, descriptor.id, 'fail', reasonFor(error, 'PACK_INSTALL_FAILED'), { packId, status: statusOf(error) }))
        break
      }

      record(result(index, descriptor.id, 'ok', 'PACK_INSTALLED', { packId, createdCount, secondCreatedCount: 0 }))
      continue
    }
  }

  return summarizeInstallRun(steps)
}

// ---------------------------------------------------------------------------
// the default API implementation — existing routes only, existing gates only
// ---------------------------------------------------------------------------

/**
 * A 2xx IS NOT AN ANSWER — the envelope has to be there.
 *
 * The first cut let any 2xx through as `{}` when the body would not parse or was not an envelope,
 * which meant an install step recorded OK on a response the plugin never wrote. The realistic case
 * is not exotic: an auth proxy or an ingress answering `200` with an HTML sign-in page, at which
 * point `sandbox-target/ensure` and `customer-packs/:id/install` both report success and the page
 * tells an admin the tables are in place. Reporting a table that does not exist is worse than
 * reporting a failure, so a malformed 2xx FAILs with its own reason instead.
 *
 * `data` may legitimately be absent (a route that answers `{ ok: true }` and nothing else); `ok:
 * true` is what must be present.
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
    throw new StockPreparationInstallCallError(status, route)
  }
  if (!envelope || envelope.ok !== true) {
    throw new StockPreparationInstallCallError(status, route, { malformed: true })
  }
  return (envelope.data ?? {}) as T
}

export function createStockPreparationInstallApi(scope: IntegrationScope): StockPreparationInstallApi {
  const query = buildQueryString({ tenantId: scope.tenantId, workspaceId: scope.workspaceId })
  const suffix = query ? `?${query}` : ''
  const json = { 'Content-Type': 'application/json' }

  return {
    async readPreflight() {
      const response = await apiFetch(`${STOCK_PREPARATION_PREFLIGHT_ROUTE}${suffix}`)
      const status = typeof response?.status === 'number' ? response.status : 0
      if (status === 404 || status === 501) {
        return { preflight: null, routeAbsent: true, status }
      }
      const preflight = await readEnvelope<StockPreparationPreflight>(response, STOCK_PREPARATION_PREFLIGHT_ROUTE)
      return { preflight, routeAbsent: false, status }
    },

    async ensureConfirmationLedger() {
      // Body STRICTLY empty: the staging project is auth-derived, and a request projectId would be a
      // steering vector on a write route.
      const route = '/api/integration/stock-preparation/confirmation-decisions/ensure'
      const response = await apiFetch(`${route}${suffix}`, { method: 'POST', headers: json, body: '{}' })
      return readEnvelope<{ mode?: string }>(response, route)
    },

    async listCustomerPacks() {
      const route = '/api/integration/stock-preparation/customer-packs'
      const response = await apiFetch(`${route}${suffix}`)
      return readEnvelope<{ packCount: number; packs: StockPreparationPackSummary[] }>(response, route)
    },

    async ensureSandboxTarget(objectId: string) {
      const route = '/api/integration/stock-preparation/sandbox-target/ensure'
      const response = await apiFetch(`${route}${suffix}`, {
        method: 'POST',
        headers: json,
        // The objectId comes from the pack's declared targetObjectId and from nowhere else. The
        // server's assertSandboxObjectId is what enforces the namespace; this only refuses to invent.
        body: JSON.stringify({ objectId }),
      })
      return readEnvelope<{ mode?: string; ready?: boolean }>(response, route)
    },

    async dryRunCustomerPack(packId: string) {
      const route = `/api/integration/stock-preparation/customer-packs/${encodeURIComponent(packId)}/dry-run`
      const response = await apiFetch(`${route}${suffix}`, { method: 'POST', headers: json, body: '{}' })
      return readEnvelope<{ canInstall?: boolean; conflictingFieldIds?: string[] }>(response, route)
    },

    async installCustomerPack(packId: string) {
      const route = `/api/integration/stock-preparation/customer-packs/${encodeURIComponent(packId)}/install`
      const response = await apiFetch(`${route}${suffix}`, { method: 'POST', headers: json, body: '{}' })
      return readEnvelope<{ createdFields?: string[]; stampedFields?: string[] }>(response, route)
    },
  }
}
