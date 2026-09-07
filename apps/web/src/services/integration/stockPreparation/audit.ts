// BOM备料 审计反查 —— the browser side of a route the front end has never called.
//
// `GET /api/integration/stock-preparation/audit` has existed since W5b (#3890) and is admin-gated,
// values-free BY CONSTRUCTION (stock-preparation-audit-store.cjs's structural shape gate refuses
// anything else at APPEND time — this module cannot introduce a leak the store did not already
// refuse). Until this file, `apps/web/src/services/integration/stockPreparation/` held no client for
// it at all: "who touched this project" could only be answered by someone with a shell on the
// server. This is that answer, as a page.
//
// WHAT THIS FILE DOES NOT DO. It does not widen the gate (still admin-tier, unchanged — D-2 in the
// UX redesign leaves that owner-pending), does not add a filter the server does not already support,
// and does not attempt to explain the store's `project_id` column-meaning split (P8 in
// design-ops-overview.md: only FOUR of the fourteen actions stamp a real project number there —
// generation_run/exception_resolve/prep_line_export/handoff_advance; the rest are NULL or an internal
// handle). That split is why `STOCK_PREP_AUDIT_PROJECT_SCOPED_ACTIONS` below is a strict subset of
// the full vocabulary: offering the other ten in a project-number search's action filter would offer
// a filter that can only ever return zero rows.
//
// SEARCH IS PROJECT-NUMBER-SCOPED, ON PURPOSE. The wireframe (线框 E) leads with a project-number
// input before the action filter, matching what this whole panel exists to answer — "谁在什么时候动
// 过《这个》项目" — never "show me everything". `listStockPreparationAudit` therefore REQUIRES
// `projectId`; the caller is expected to disable its own search action until one is typed, so an
// admin is never handed the raw, unscoped last-500-rows-of-the-tenant firehose from a page whose job
// is to answer one project's question.
//
// THE RETURN SHAPE IS THE VALUES-FREE PROJECTION F11 ASKS FOR, not the raw row. `actor` never
// reaches a caller as itself — `isSelf` is the ONLY thing derived from it (an equality check against
// the CALLER's own id, computed here so no view can accidentally render the raw string first and
// redact it second). `actor`/`subjectId`/`mode`/`workspaceId`/`detail` all move into `technical`,
// which a view may render in a 技术详情 disclosure but must never treat as primary content (G8).
//
// 403 IS A RESULT, NOT AN EXCEPTION. `listStockPreparationAudit` never throws for a failed read: a
// non-admin caller (or a transient failure) gets back a typed `{ ok: false, reason }`, so a view can
// render "这一格看不了: 需要平台管理员" without a try/catch of its own.
import { apiFetch } from '../../../utils/api'
import { buildQuerySuffix, type IntegrationApiEnvelope, type IntegrationScope } from '../workbench'

export const STOCK_PREPARATION_AUDIT_ROUTE = '/api/integration/stock-preparation/audit'

/**
 * The full 14-action vocabulary, mirrored from `stock-preparation-audit-store.cjs`'s
 * `STOCK_PREP_AUDIT_ACTIONS` (the DB CHECK constraint's own source of truth). Kept as a committed
 * constant rather than fetched: the vocabulary is closed and migration-frozen, exactly like every
 * other closed-vocabulary mirror in this workbench (`STOCK_PREP_STEP_OUTCOME`,
 * `STOCK_PREP_HANDOFF_STEP_PLAIN`). `StockPreparationOpsPanel.spec.ts` reads the .cjs module directly
 * and asserts this list has not drifted from it (anti-vacuity, same discipline as
 * `StockPreparationPosturePlainLanguage.spec.ts`'s manifest read).
 */
export const STOCK_PREP_AUDIT_ACTIONS = Object.freeze([
  'mapping_candidates_sync',
  'mapping_confirm',
  'mapping_retire',
  'unit_confirm',
  'unit_retire',
  'generation_run',
  'exception_resolve',
  'exception_bulk_resolve',
  'persist_repair_once',
  'source_binding_set',
  'prep_line_export',
  'project_directory_read',
  'handoff_advance',
  'project_board_read',
] as const)

export type StockPrepAuditAction = typeof STOCK_PREP_AUDIT_ACTIONS[number]

/**
 * The four actions whose `project_id` column is a real project number (P8, verified against every
 * `audit.append` call site). The ONLY actions a project-number search can ever surface — see the
 * file header for why the action filter is limited to these rather than the full 14.
 */
export const STOCK_PREP_AUDIT_PROJECT_SCOPED_ACTIONS: readonly StockPrepAuditAction[] = Object.freeze([
  'generation_run',
  'exception_resolve',
  'prep_line_export',
  'handoff_advance',
])

/** The values-free projection of one audit row. Never `actor` itself outside `technical`. */
export interface StockPrepAuditEntryView {
  id: string
  createdAt: string | null
  action: string
  /** `technical.actor === currentUserId`, computed once here. The ONLY thing derived from `actor`
   *  that a primary row may render (F11 / G8: no view may render the raw handle). */
  isSelf: boolean
  technical: {
    actor: string | null
    subjectId: string | null
    mode: string | null
    workspaceId: string | null
    detail: Record<string, unknown>
  }
}

export interface StockPrepAuditListParams {
  /** Required — see file header: this reverse-lookup is always scoped to one project. */
  projectId: string
  action?: string
  limit?: number
}

export type StockPrepAuditListOutcome =
  | { ok: true; rowCount: number; entries: StockPrepAuditEntryView[] }
  | { ok: false; reason: 'forbidden'; status: number }
  | { ok: false; reason: 'read_failed'; status: number }

interface RawAuditEntry {
  id?: unknown
  createdAt?: unknown
  action?: unknown
  actor?: unknown
  subjectId?: unknown
  mode?: unknown
  workspaceId?: unknown
  detail?: unknown
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asDetail(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function toEntryView(raw: RawAuditEntry, currentUserId: string | null): StockPrepAuditEntryView {
  const actor = asString(raw.actor)
  return {
    id: asString(raw.id) ?? '',
    createdAt: asString(raw.createdAt),
    action: asString(raw.action) ?? '',
    // Equality only, never a lookup or a name resolution — see plainLanguage.ts's X1 note on why a
    // real name is never derived from this handle.
    isSelf: actor !== null && currentUserId !== null && actor === currentUserId,
    technical: {
      actor,
      subjectId: asString(raw.subjectId),
      mode: asString(raw.mode),
      workspaceId: asString(raw.workspaceId),
      detail: asDetail(raw.detail),
    },
  }
}

async function readJson(response: Response | undefined): Promise<unknown> {
  try {
    return await response?.json()
  } catch {
    return null
  }
}

function statusOf(response: Response | undefined): number {
  return typeof response?.status === 'number' ? response.status : 0
}

/**
 * The reverse lookup. Never throws — a refusal or a transient failure both come back as a typed
 * `{ ok: false, reason }`, so a view renders its own honest per-cause sentence with no try/catch.
 */
export async function listStockPreparationAudit(
  scope: IntegrationScope,
  params: StockPrepAuditListParams,
  currentUserId: string | null,
): Promise<StockPrepAuditListOutcome> {
  const query = buildQuerySuffix({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    projectId: params.projectId,
    action: params.action,
    limit: params.limit,
  })
  const response = await apiFetch(`${STOCK_PREPARATION_AUDIT_ROUTE}${query}`)
  const status = statusOf(response)
  const payload = await readJson(response) as IntegrationApiEnvelope<{ rowCount?: unknown; entries?: unknown }> | null
  if (!response?.ok || payload?.ok === false || !payload?.data) {
    if (status === 403) return { ok: false, reason: 'forbidden', status }
    return { ok: false, reason: 'read_failed', status }
  }
  const rawEntries = Array.isArray(payload.data.entries) ? payload.data.entries as RawAuditEntry[] : []
  const entries = rawEntries.map((raw) => toEntryView(raw, currentUserId))
  const rowCount = typeof payload.data.rowCount === 'number' ? payload.data.rowCount : entries.length
  return { ok: true, rowCount, entries }
}
