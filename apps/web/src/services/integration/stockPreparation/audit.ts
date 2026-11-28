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
// UX redesign leaves that owner-pending) and uses the server's action and project-number filters.
// The action picker offers the common project-number lookups. The unfiltered query can also show
// other actions recorded with that same project number.
//
// THE QUERY DELIBERATELY CARRIES NO `workspaceId`, AND THAT IS THE WHOLE POINT OF THIS PARAGRAPH.
// `stock-preparation-audit-store.cjs`'s `list` treats a supplied workspaceId as an EQUALITY filter
// (`const workspace = optionalString(workspaceId); if (workspace) where.workspace_id = workspace`),
// and the route forwards the query string's value into it verbatim
// (`http-routes.cjs` `stockPreparationAuditList` → `audit.list({ workspaceId: firstString(rawQuery.workspaceId), ... })`).
// But NONE of the eighteen `audit.append` call sites in `http-routes.cjs` passes a workspaceId — the
// only append in the whole repo that does is `stock-preparation-sync-run-repair-once.cjs`'s
// `appendRepairAudit`, whose action (`persist_repair_once`) is not one this panel's project-number
// search can surface anyway. Every row a project-number search could match therefore has
// `workspace_id` NULL, and `NULL = 'anything'` is never true in SQL. Meanwhile the browser ALWAYS has
// a non-empty `scope.workspaceId`: `useAuth.ts`'s `persistTenantHint` writes
// `localStorage.setItem('workspaceId', tenantId)` on every auth bootstrap and
// `getDefaultIntegrationScope()` reads it straight back. So forwarding it would have made this
// lookup return zero rows for EVERY project number on EVERY real deployment — while the panel's
// three permanent caveat lines stood ready to explain that empty result away with three reasons,
// none of which would have been the real one. That is the exact failure mode (R6/G4) this panel
// exists to prevent, so the parameter is not sent. `StockPreparationOpsPanel.spec.ts` pins it with a
// query-parsing mock that filters like the store does, plus a direct assertion on the request URL.
//
// SEARCH IS PROJECT-NUMBER-SCOPED, ON PURPOSE. The wireframe (线框 E) leads with a project-number
// input before the action filter, matching what this whole panel exists to answer — "谁在什么时候动
// 过《这个》项目" — never "show me everything". `listStockPreparationAudit` therefore REQUIRES
// `projectId`; the caller is expected to disable its own search action until one is typed, so an
// admin is never handed the raw, unscoped last-500-rows-of-the-tenant firehose from a page whose job
// is to answer one project's question.
//
// THE RETURN SHAPE IS THE VALUES-FREE PROJECTION F11 ASKS FOR, not the raw row. `actor` never
// reaches a caller as itself — `who` is the ONLY thing derived from it (an equality check against
// the CALLER's own id, computed here so no view can accidentally render the raw string first and
// redact it second). `actor`/`subjectId`/`mode`/`workspaceId`/`detail` all move into `technical`,
// which a view may render in a 技术详情 disclosure but must never treat as primary content (G8).
//
// `who` IS FOUR-VALUED, NOT TWO, BECAUSE A FAILED READ IS NOT AN ANSWER. Both inputs to the equality
// check can legitimately be absent: `getCurrentUserId()` goes through `bootstrapSession` and can fail
// or come back empty, and the store's own append allows a null actor (`actor: optionalString(actor)`).
// A two-valued 「您 / 其他同事」 would render BOTH of those absences as the positive claim 「其他同
// 事」 — i.e. this page, whose entire job is to answer "who touched this project", would point at a
// colleague because it could not read the reader's own account. That is worse than saying nothing:
// it is a false positive identification on the one screen built for attribution. So the two
// unknown-shaped cases get their own values and their own sentences, and the caller renders three
// distinct outcomes rather than folding two of them into a claim.
//
// 403 IS A RESULT, NOT AN EXCEPTION. `listStockPreparationAudit` never throws for a failed read: a
// non-admin caller (or a transient failure) gets back a typed `{ ok: false, reason }`, so a view can
// render "这一格看不了: 需要平台管理员" without a try/catch of its own.
import { apiFetch } from '../../../utils/api'
import { buildQuerySuffix, type IntegrationApiEnvelope, type IntegrationScope } from '../workbench'

export const STOCK_PREPARATION_AUDIT_ROUTE = '/api/integration/stock-preparation/audit'

/**
 * The full action vocabulary, mirrored from `stock-preparation-audit-store.cjs`'s
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
  'project_target_create',
  'project_target_archive',
  'project_target_restore',
  'project_target_grant',
  'project_fields_update',
  'project_overview_refresh',
  'project_pilot_enable',
  'project_delete',
] as const)

export type StockPrepAuditAction = typeof STOCK_PREP_AUDIT_ACTIONS[number]

/** Dedicated action filters for project-number lookup, including the project deletion audit. */
export const STOCK_PREP_AUDIT_PROJECT_SCOPED_ACTIONS: readonly StockPrepAuditAction[] = Object.freeze([
  'generation_run',
  'exception_resolve',
  'prep_line_export',
  'handoff_advance',
  'project_delete',
])

/**
 * Who this row is about, as far as an equality check can honestly say.
 *   `self`           — the row's actor is the caller's own id.
 *   `other`          — both ids were readable and they differ.
 *   `unknown_actor`  — the ROW carries no actor (the store's append allows null).
 *   `unknown_viewer` — the CALLER's own id could not be read, so no comparison is possible.
 * The last two must never be collapsed into `other`; see the file header.
 */
export type StockPrepAuditWho = 'self' | 'other' | 'unknown_actor' | 'unknown_viewer'

/** The values-free projection of one audit row. Never `actor` itself outside `technical`. */
export interface StockPrepAuditEntryView {
  id: string
  createdAt: string | null
  action: string
  /** The ONLY thing derived from `actor` that a primary row may render (F11 / G8: no view may
   *  render the raw handle). Four-valued on purpose — see `StockPrepAuditWho`. */
  who: StockPrepAuditWho
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

/**
 * Equality only, never a lookup or a name resolution — see plainLanguage.ts's X1 note on why a real
 * name is never derived from this handle. Order matters: a missing actor is a fact about the ROW and
 * is reported as such even when the caller's own id is also missing, because that is the more
 * specific and more actionable of the two unknowns.
 */
function resolveWho(actor: string | null, currentUserId: string | null): StockPrepAuditWho {
  if (actor === null) return 'unknown_actor'
  if (currentUserId === null) return 'unknown_viewer'
  return actor === currentUserId ? 'self' : 'other'
}

function toEntryView(raw: RawAuditEntry, currentUserId: string | null): StockPrepAuditEntryView {
  const actor = asString(raw.actor)
  return {
    id: asString(raw.id) ?? '',
    createdAt: asString(raw.createdAt),
    action: asString(raw.action) ?? '',
    who: resolveWho(actor, currentUserId),
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
  // NO `workspaceId` — see the file header. Sending it would filter on a column that is NULL on
  // every row this lookup can match, turning the panel into a permanently-empty search with a
  // ready-made (and wrong) explanation attached.
  const query = buildQuerySuffix({
    tenantId: scope.tenantId,
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
