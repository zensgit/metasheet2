// G34 运行监控到达率 (docs/development/integration-monitoring-reach-design-20260910.md).
//
// PURE module — no IO, no Vue. It owns everything the 运行监控 section needs to turn its
// filter/pagination state into the query parameters `GET /api/integration/runs` and
// `GET /api/integration/dead-letters` ACTUALLY accept, and nothing else. Every constant below
// mirrors a value the backend enforces today; the UI must never offer a parameter the backend
// would ignore or reject:
//
//   - runs      → plugins/plugin-integration-core/lib/http-routes.cjs:9639 `runsList`
//                 (pipelineId | status | limit | offset), implemented by
//                 plugins/plugin-integration-core/lib/pipelines.cjs:699 `listPipelineRuns`
//                 (pipelineId OPTIONAL, status validated against VALID_RUN_STATUSES).
//   - dead      → http-routes.cjs:9674 `deadLettersList` (pipelineId | runId | status | limit |
//     letters     offset), implemented by dead-letter.cjs:121 `listDeadLetters`.
//   - limit     → http-routes.cjs:1436 MAX_LIST_LIMIT = 500 (asListLimit clamps).
//   - offset    → http-routes.cjs:1437 MAX_LIST_OFFSET = 10000 (asListOffset clamps).
//
// NOT supported by either route today: a time window (from/to exist only on the provenance route,
// http-routes.cjs:9666) and a total/row-count in the response (both handlers `sendOk` a bare
// array). So this module deliberately has NO time-window field, and its paging predicate is the
// conservative "a FULL page came back, so there MAY be one more" — never a computed page count.
import type { IntegrationDeadLetter, IntegrationPipelineRun, IntegrationScope } from './workbench'

/** http-routes.cjs:1436 MAX_LIST_LIMIT. A larger `limit` is silently clamped server-side. */
export const MONITORING_MAX_LIMIT = 500
/** http-routes.cjs:1437 MAX_LIST_OFFSET. Paging past this cannot reach new rows. */
export const MONITORING_MAX_OFFSET = 10000
/** Page sizes offered in the UI. 5 stays first so the section's first screen is unchanged. */
export const MONITORING_PAGE_SIZE_OPTIONS: readonly number[] = [5, 20, 50, 100, MONITORING_MAX_LIMIT]
/** The pre-G34 hard-coded page size; kept as the default so the first screen is byte-identical. */
export const MONITORING_DEFAULT_PAGE_SIZE = 5
/** Poll cadence while at least one loaded run is still `running`. */
export const MONITORING_POLL_INTERVAL_MS = 5000
/** pipelines.cjs:27 VALID_RUN_STATUSES — anything else is a 400 from the registry. */
export const MONITORING_RUN_STATUS_OPTIONS: readonly string[] = [
  'pending',
  'running',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
]
/** dead-letter.cjs:7 VALID_STATUSES. */
export const MONITORING_DEAD_LETTER_STATUS_OPTIONS: readonly string[] = ['open', 'replayed', 'discarded']

/**
 * Which pipeline the section is looking at.
 *  - 'current': follow the workbench's saved pipeline (pre-G34 behavior). When there is no saved
 *    pipeline this degrades to a CROSS-PIPELINE read instead of the old hard error.
 *  - 'all': never send pipelineId — every pipeline in the scope.
 *  - 'custom': send the operator-typed id (blank behaves like 'all').
 */
export type MonitoringPipelineScope = 'current' | 'all' | 'custom'

export interface MonitoringQueryState {
  pipelineScope: MonitoringPipelineScope
  /** Only meaningful when pipelineScope === 'custom'. */
  pipelineId: string
  /** '' = no status filter (all run statuses). */
  runStatus: string
  /** '' = no status filter. Defaults to 'open' (the pre-G34 dead-letter read). */
  deadLetterStatus: string
  pageSize: number
  offset: number
}

/** Request params for the two list routes — pipelineId/status/offset omitted when unset. */
export interface MonitoringRequestParams extends IntegrationScope {
  pipelineId?: string
  status?: string
  limit: number
  offset?: number
}

function toInteger(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(numeric) ? numeric : fallback
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}

function normalizeStatus(value: unknown, allowed: readonly string[]): string {
  const status = typeof value === 'string' ? value.trim() : ''
  return allowed.includes(status) ? status : ''
}

function normalizePipelineScope(value: unknown): MonitoringPipelineScope {
  return value === 'all' || value === 'custom' ? value : 'current'
}

/**
 * Clamps/drops every field to what the backend accepts. An unknown status becomes '' (no filter)
 * rather than being forwarded — pipelines.cjs:706-707 would 400 on it, and a 400 here would blank the
 * whole section.
 */
export function normalizeMonitoringQueryState(input: Partial<MonitoringQueryState> = {}): MonitoringQueryState {
  const pageSize = clamp(toInteger(input.pageSize, MONITORING_DEFAULT_PAGE_SIZE), 1, MONITORING_MAX_LIMIT)
  const offset = clamp(toInteger(input.offset, 0), 0, MONITORING_MAX_OFFSET)
  return {
    pipelineScope: normalizePipelineScope(input.pipelineScope),
    pipelineId: typeof input.pipelineId === 'string' ? input.pipelineId.trim() : '',
    runStatus: normalizeStatus(input.runStatus, MONITORING_RUN_STATUS_OPTIONS),
    deadLetterStatus: normalizeStatus(input.deadLetterStatus, MONITORING_DEAD_LETTER_STATUS_OPTIONS),
    pageSize,
    offset,
  }
}

/** The pre-G34 first screen: current pipeline, no run-status filter, open dead letters, 5 rows. */
export function createMonitoringQueryState(overrides: Partial<MonitoringQueryState> = {}): MonitoringQueryState {
  return normalizeMonitoringQueryState({
    pipelineScope: 'current',
    pipelineId: '',
    runStatus: '',
    deadLetterStatus: 'open',
    pageSize: MONITORING_DEFAULT_PAGE_SIZE,
    offset: 0,
    ...overrides,
  })
}

/**
 * The pipelineId that will actually be sent, or '' for a cross-pipeline read. '' is a legitimate
 * answer on EVERY branch: the backend treats a missing pipelineId as "this scope's pipelines"
 * (pipelines.cjs:703 only adds the predicate when the value is truthy) and applies its OWN scope
 * predicate either way. That scope is NOT uniformly proven: `tenantId` is verified against the
 * caller's claim (http-routes.cjs:1028 resolveTenantId — 403 on mismatch), while `workspaceId` is
 * taken from the request as-is with no membership check (http-routes.cjs:1248-1250
 * resolveWorkspaceId). Dropping pipelineId therefore does not widen anything BEYOND what the same
 * caller could already read by pasting another pipeline id — it only removes a step.
 */
export function resolveMonitoringPipelineId(state: MonitoringQueryState, fallbackPipelineId = ''): string {
  const normalized = normalizeMonitoringQueryState(state)
  if (normalized.pipelineScope === 'all') return ''
  if (normalized.pipelineScope === 'custom') return normalized.pipelineId
  return typeof fallbackPipelineId === 'string' ? fallbackPipelineId.trim() : ''
}

function buildParams(
  state: MonitoringQueryState,
  scope: IntegrationScope,
  fallbackPipelineId: string,
  status: string,
): MonitoringRequestParams {
  const pipelineId = resolveMonitoringPipelineId(state, fallbackPipelineId)
  return {
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId ?? null,
    // Omitted (not empty-stringed) so the query builder cannot emit `pipelineId=`.
    ...(pipelineId ? { pipelineId } : {}),
    ...(status ? { status } : {}),
    limit: state.pageSize,
    // 0 must be OMITTED, not sent: buildQueryString only drops undefined/null/'', so an explicit
    // `offset=0` would change every first-page URL for no behavioral gain.
    ...(state.offset > 0 ? { offset: state.offset } : {}),
  }
}

export function buildRunsRequestParams(
  state: MonitoringQueryState,
  scope: IntegrationScope,
  fallbackPipelineId = '',
): MonitoringRequestParams {
  const normalized = normalizeMonitoringQueryState(state)
  return buildParams(normalized, scope, fallbackPipelineId, normalized.runStatus)
}

export function buildDeadLetterRequestParams(
  state: MonitoringQueryState,
  scope: IntegrationScope,
  fallbackPipelineId = '',
): MonitoringRequestParams {
  const normalized = normalizeMonitoringQueryState(state)
  return buildParams(normalized, scope, fallbackPipelineId, normalized.deadLetterStatus)
}

export function hasPreviousMonitoringPage(state: MonitoringQueryState): boolean {
  return normalizeMonitoringQueryState(state).offset > 0
}

/**
 * Conservative next-page predicate. Neither handler returns a total, so the ONLY honest signal is
 * "the page came back full". A full LAST page therefore offers a next page that turns out empty —
 * that is the intended trade (never hide a reachable row), and the empty page can still go back.
 */
export function hasNextMonitoringPage(state: MonitoringQueryState, receivedCount: number): boolean {
  const normalized = normalizeMonitoringQueryState(state)
  const count = toInteger(receivedCount, 0)
  if (count < normalized.pageSize) return false
  return normalized.offset + normalized.pageSize <= MONITORING_MAX_OFFSET
}

export function nextMonitoringPage(state: MonitoringQueryState, receivedCount: number): MonitoringQueryState {
  const normalized = normalizeMonitoringQueryState(state)
  if (!hasNextMonitoringPage(normalized, receivedCount)) return normalized
  return { ...normalized, offset: normalized.offset + normalized.pageSize }
}

export function previousMonitoringPage(state: MonitoringQueryState): MonitoringQueryState {
  const normalized = normalizeMonitoringQueryState(state)
  if (normalized.offset <= 0) return normalized
  return { ...normalized, offset: Math.max(0, normalized.offset - normalized.pageSize) }
}

/** 1-based page number for display. There is no page COUNT — the backend returns no total. */
export function monitoringPageNumber(state: MonitoringQueryState): number {
  const normalized = normalizeMonitoringQueryState(state)
  return Math.floor(normalized.offset / normalized.pageSize) + 1
}

// Every filter change resets the cursor: keeping an offset across a filter change silently hides
// the new filter's first rows.
export function withMonitoringPipelineScope(
  state: MonitoringQueryState,
  pipelineScope: MonitoringPipelineScope,
): MonitoringQueryState {
  return normalizeMonitoringQueryState({ ...state, pipelineScope, offset: 0 })
}

export function withMonitoringPipelineId(state: MonitoringQueryState, pipelineId: string): MonitoringQueryState {
  return normalizeMonitoringQueryState({ ...state, pipelineId, offset: 0 })
}

export function withMonitoringRunStatus(state: MonitoringQueryState, runStatus: string): MonitoringQueryState {
  return normalizeMonitoringQueryState({ ...state, runStatus, offset: 0 })
}

export function withMonitoringDeadLetterStatus(
  state: MonitoringQueryState,
  deadLetterStatus: string,
): MonitoringQueryState {
  return normalizeMonitoringQueryState({ ...state, deadLetterStatus, offset: 0 })
}

export function withMonitoringPageSize(state: MonitoringQueryState, pageSize: number): MonitoringQueryState {
  return normalizeMonitoringQueryState({ ...state, pageSize, offset: 0 })
}

export interface MonitoringDeadLetterGroup {
  errorCode: string
  count: number
}

/**
 * errorCode histogram over the LOADED page only (the backend has no group-by). Sorted by count
 * desc, then errorCode asc so the order is stable for a tie.
 */
export function groupDeadLettersByErrorCode(
  deadLetters: readonly Pick<IntegrationDeadLetter, 'errorCode'>[] = [],
): MonitoringDeadLetterGroup[] {
  const counts = new Map<string, number>()
  for (const deadLetter of deadLetters) {
    const errorCode = typeof deadLetter?.errorCode === 'string' && deadLetter.errorCode.trim()
      ? deadLetter.errorCode.trim()
      : 'UNKNOWN'
    counts.set(errorCode, (counts.get(errorCode) || 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([errorCode, count]) => ({ errorCode, count }))
    .sort((a, b) => (b.count - a.count) || a.errorCode.localeCompare(b.errorCode))
}

/** Dead letters of the loaded page that belong to one run (the backend returns no per-run count). */
export function countDeadLettersForRun(
  deadLetters: readonly Pick<IntegrationDeadLetter, 'runId'>[] = [],
  runId: string,
): number {
  if (!runId) return 0
  return deadLetters.filter((deadLetter) => deadLetter?.runId === runId).length
}

/** Polling trigger: only a `running` run can still change. */
export function hasRunningRun(runs: readonly Pick<IntegrationPipelineRun, 'status'>[] = []): boolean {
  return runs.some((run) => run?.status === 'running')
}

export interface MonitoringResponseGate {
  /** Starts a new request and invalidates every earlier one. */
  issue: () => number
  /** True only for the most recently issued ticket. */
  isCurrent: (ticket: number) => boolean
}

/**
 * Last-write-wins guard for overlapping monitoring reads. Polling (5s) plus operator-driven filter
 * changes make out-of-order responses ordinary, and without this an in-flight page-1 read that
 * lands AFTER a page-2 read would repaint page 1 under a "page 2" cursor. Pure: it owns a counter,
 * performs no IO, and never touches the responses themselves.
 */
export function createMonitoringResponseGate(): MonitoringResponseGate {
  let latest = 0
  return {
    issue: () => {
      latest += 1
      return latest
    },
    isCurrent: (ticket: number) => ticket === latest,
  }
}
