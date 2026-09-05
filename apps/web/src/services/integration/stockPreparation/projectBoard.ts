// 项目备料页 — the client for the operator's single page.
//
// TWO ROUTES, AND THEY ARE NOT THE SAME KIND OF THING.
//
//   1. GET …/stock-preparation/projects/:projectNo/board   — ALWAYS present. The page's own read.
//   2. GET/POST …/stock-preparation/handoff[/advance]      — MAY NOT EXIST on this deployment.
//
// The second is the 通知下一步 contract, which lands on its own branch and its own schedule. This
// module therefore treats it as an OPTIONAL capability and says so in the type system rather than in
// a comment: `readStockPreparationHandoff` never throws for "the route is not there" — a 404, a 501
// or a `configured: false` body all resolve to `null`, and the page renders no button. That is what
// makes this page work whether or not the handoff slice has merged, and it is deliberately NOT a
// try/catch that swallows every failure: a 403 or a 500 still throws, because those mean something
// went wrong rather than something is absent.
//
// VALUES. The board is the fourth value-bearing stock-prep read — it carries the caller's OWN
// tenant's project number and name, under the operator tier, with the server deriving the tenant
// from the authenticated principal. It carries NO row values: counts, closed enums, timestamps and
// handles are the whole of the rest. Nothing here may route the projectNo into a log or an
// aggregate; it goes into the request path and into the page's own status bar, and nowhere else.
import { apiFetch } from '../../../utils/api'
import { buildQuerySuffix, type IntegrationScope } from '../workbench'
import { parseStockPreparationConfirmResponse } from './confirmApi'

/**
 * THE MULTITABLE DEEP-LINK HANDLE, and the claim it does not make.
 *
 * The server returns this only when the fill table actually EXISTS. It is not a permission decision:
 * the plugin has no user-aware multitable ACL seam, so it cannot pre-check whether this operator may
 * open that sheet and does not pretend to. Multitable enforces access when the operator lands.
 */
export interface StockPreparationFillTarget {
  sheetId: string
  viewId: string
}

/** The frozen board projection. Mirrors STOCK_PREPARATION_PROJECT_BOARD_KEYS server-side. */
export interface StockPreparationProjectBoard {
  tenantId: string
  /**
   * Internal MetaSheet handle. Kept in state, never rendered. NULL when this project has rows but no
   * archived snapshot — an operator's own pull produces exactly that shape, because the MVP project
   * ledger is written by mvp-persist and mvp-persist is platform-admin.
   */
  projectId: string | null
  projectNo: string | null
  projectName: string | null
  projectStatus: string | null
  // ── THE ADMINISTRATOR'S ARCHIVE (mvp-persist, platform-admin). Absent is normal for an operator's
  //    own run, and `archivedSnapshotPresent` is what says so — these must never be read as
  //    "nothing was pulled".
  lastSyncRunId: string | null
  snapshotBatchCount: number
  openExceptionCount: number
  heldLineCount: number
  readyLineCount: number
  archivedSnapshotPresent: boolean
  // ── THE PULL, counted in the bound table-action target: the sheet apply writes and the export
  //    reads. This is the family that answers 「拉过了吗?」.
  /** False when nothing is bound, the bound sheet is not this tenant's own, or it is unprovisioned. */
  pullTargetReady: boolean
  pulledRowCount: number
  activePulledRowCount: number
  /** True when the count stopped at the scan bound — the real number is at least `pulledRowCount`. */
  pulledRowCountBounded: boolean
  /**
   * The latest `lastPlmRefreshAt` seen across this project's pulled rows — 「最近变更(来自 PLM)」,
   * NOT 「上次同步」. `lastPlmRefreshAt` is written only by an add/update/inactive DECISION
   * (plugins/plugin-integration-core/lib/stock-preparation-conflict-planner.cjs `runPatch`, called from
   * `makeAddDecision` / `makeUpdateDecision` / `makeInactiveDecision`); an UNCHANGED row's sync goes
   * through `makeSkipDecision`, which never touches this column. So a project that has been stable and
   * pulled daily for a week shows a week-old value here even though every one of those daily pulls
   * ran and reported "nothing changed". NULL when the bound target does not bind that (optional)
   * column, there are no rows yet, OR the scan was truncated (see `lastChangedFromPlmBounded`) — never
   * a computed value the server is not sure of.
   */
  lastChangedFromPlmAt: string | null
  /**
   * True when `lastChangedFromPlmAt` is null BECAUSE the row scan hit its page bound, not because no
   * row has ever changed. A truncated, unordered scan cannot safely report a max — a row past the
   * bound could carry a newer stamp — so the server reports "don't know" via this flag instead of a
   * possibly-stale number. The view must render this differently from "never changed".
   */
  lastChangedFromPlmBounded: boolean
  pendingDecisionCount: number
  /** ISO timestamp of the last materials export for this project, from the audit trail. */
  lastExportAt: string | null
  fillTarget: StockPreparationFillTarget | null
  directoryReady: boolean
  ledgerReady: boolean
}

/**
 * 轮到谁 — the handoff cursor, as this page needs it.
 *
 * A SUBSET of what the handoff route returns, on purpose: the page shows whose turn it is and
 * whether this operator is the one holding it, and nothing else. Widening this interface to mirror
 * the whole response would couple the page to a contract that is still being rebased.
 */
export interface StockPreparationHandoffCursor {
  configured: boolean
  projectNo: string | null
  currentStepKey: string | null
  stepIndex: number | null
  stepCount: number
  terminal: boolean
  completed: boolean
  /** Whether the CALLER is the current handler — decides whether 通知下一步 may be pressed. */
  isCurrentHandler: boolean
}

/** The result of pressing 通知下一步. */
export interface StockPreparationHandoffAdvance {
  projectNo: string | null
  fromStepKey: string | null
  currentStepKey: string | null
  stepIndex: number | null
  stepCount: number
  changed: boolean
  terminal: boolean
  notified: boolean
  /** 'sent' | 'skipped' | 'not_configured' — a closed server vocabulary, clamped by the view. */
  notifyOutcome: string | null
}

const BOARD_BASE = '/api/integration/stock-preparation'

/**
 * ONE PROJECT'S BOARD.
 *
 * `tenantId` is sent for shape-compatibility with every other call in this folder and is NOT a
 * selector: the server derives the scope from the authenticated principal and refuses any value that
 * is not the caller's own tenant.
 *
 * A 404 — an unknown number, or one belonging to another tenant, which are indistinguishable by
 * design — arrives as a thrown `StockPreparationConfirmApiError` with
 * `STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND`. The view turns that into the same three-way empty
 * state #5445 uses, never into a raw code.
 */
export async function readStockPreparationProjectBoard(
  scope: IntegrationScope & { projectNo: string },
): Promise<StockPreparationProjectBoard> {
  const query = buildQuerySuffix({ tenantId: scope.tenantId, workspaceId: scope.workspaceId })
  const path = `${BOARD_BASE}/projects/${encodeURIComponent(scope.projectNo)}/board${query}`
  const response = await apiFetch(path)
  return parseStockPreparationConfirmResponse<StockPreparationProjectBoard>(response)
}

/**
 * THE HANDOFF CURSOR, or null when this deployment does not have one.
 *
 * `null` means exactly one thing to the page — "do not render 通知下一步" — and it is returned for
 * the three ways that can be true, all of which are correct deployment states rather than faults:
 *   * 404 — the handoff slice is not on this build at all;
 *   * 501 — the route exists but its store/config capability is not wired;
 *   * 200 with `configured: false` — the route and store exist, nobody configured a chain.
 * Every other failure (403, 500, a malformed envelope) still throws, because hiding those would turn
 * a real problem into a silently missing button.
 */
export async function readStockPreparationHandoff(
  scope: IntegrationScope & { projectNo: string },
): Promise<StockPreparationHandoffCursor | null> {
  const query = buildQuerySuffix({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    projectNo: scope.projectNo,
  })
  const response = await apiFetch(`${BOARD_BASE}/handoff${query}`)
  if (response.status === 404 || response.status === 501) return null
  const cursor = await parseStockPreparationConfirmResponse<StockPreparationHandoffCursor>(response)
  if (!cursor || cursor.configured !== true) return null
  return cursor
}

/**
 * 通知下一步 — hand the project to whoever is next.
 *
 * Deliberately has NO absent-route fallback: it is only ever called from a control that
 * `readStockPreparationHandoff` already proved exists, so a 404 here is a genuine surprise and must
 * surface rather than resolve to a shrug.
 */
export async function advanceStockPreparationHandoff(
  scope: IntegrationScope & { projectNo: string },
): Promise<StockPreparationHandoffAdvance> {
  const response = await apiFetch(`${BOARD_BASE}/handoff/advance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      projectNo: scope.projectNo,
    }),
  })
  return parseStockPreparationConfirmResponse<StockPreparationHandoffAdvance>(response)
}
