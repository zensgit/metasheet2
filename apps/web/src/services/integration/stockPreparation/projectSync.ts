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
// (dry-run, apply and reconcile are each ALSO reachable via the stock-prep operator tier, for the
// pull-bom action id only, through `requireTableActionAccess` — reconcile joined in round-2 C13,
// #5460. mvp-persist alone stayed admin-only. See workbenchAccess.canRunStockPrepProjectSync.)
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
// Being a separate consumer, it re-resolves the source on its own — WITHOUT the workspace hint steps 1
// and 3 carry — so step 3's `sourceScopeDigest` rides along and the server refuses (409
// STOCK_PREPARATION_MVP_SOURCE_BINDING_SPLIT) rather than keep another source's rows as this batch.
// It also re-READS that source, after the write: step 3's `sourceContentDigest` rides along too, and the
// server refuses (409 STOCK_PREPARATION_MVP_SYNC_PARITY_MISMATCH) when the source changed since step 3
// or the sheet does not hold everything step 3 read (#6475 round 2). And a PARTIAL write is never
// archived at all: step 4 is not attempted, because the batch would hold rows the sheet does not.
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
  // 客户反馈 2026-09-24 #2 — a dry-run failure used to collapse into ONE reason regardless of what the
  // server actually said, so 「数据来源的连接坏了」、「这张表被别的项目占了」 and 「服务暂时连不上」 all
  // rendered the SAME sentence, 「没能连上取数,稍后再试一次」 — which is actionable for exactly the last
  // of those three and a dead end (or a lie) for the other two. `classifyPlanReadFailureReason` below
  // sorts a failed dry run into the outcome a person can actually act on differently; `PLAN_READ_FAILED`
  // itself is KEPT, unchanged, as the transient bucket (`SOURCE_UNAVAILABLE`, a network failure, any
  // 5xx) the original sentence was written for.
  | 'PLAN_READ_FAILED_CONNECTION'
  | 'PLAN_READ_FAILED_FOREIGN_PROJECT'
  | 'PLAN_READ_UNAUTHENTICATED'
  | 'PLAN_READ_NOT_PERMITTED'
  | 'PLAN_READ_FAILED'
  | 'PLAN_READ_FAILED_UNKNOWN'
  | 'PLAN_MALFORMED_RESPONSE'
  // 一个项目一张备料表 (S2, R-36) — the project-sheet refusals a dry run can meet once the server's
  // MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED switch is on. Each has a different next step, so
  // none of them may fall through to 「稍后再试」: retrying fixes none of them.
  | 'PLAN_PROJECT_SHEET_ABSENT'
  | 'PLAN_PROJECT_SHEET_ARCHIVED'
  | 'PLAN_TARGET_NOT_OURS'
  | 'PLAN_TARGET_SCHEMA_INCOMPLETE'
  // R67 ④ — the background dry-run lane's own two outcomes. Each has a next step 「稍后再试」 alone
  // would get wrong: someone else's trial of this project is still reading PLM (wait, do not start a
  // second one), or the server restarted under a running trial (just press again).
  | 'PLAN_DRY_RUN_BUSY'
  | 'PLAN_DRY_RUN_INTERRUPTED'
  // 2. 确认
  | 'NOTHING_TO_CONFIRM'
  | 'CONFIRMATIONS_QUEUED'
  | 'RECONCILE_UNAVAILABLE'
  // 一线自己拉数据: round-2 (decision C13) additionally admitted the operator tier on reconcile, so
  // an ordinary stock-prep operator now reaches steps 1, 2 and 3 and is refused only step 4
  // (mvp-persist/archive). This reason is for whoever still lands on a 401/403 here — a caller
  // holding neither the legacy admin tier nor the stock-prep operator tier, or an operator refused
  // by the tenant-scope door — for whom that refusal is a CORRECT deployment state, not a fault, so
  // it gets its own reason rather than borrowing RECONCILE_UNAVAILABLE's "try again later" — there
  // is no later in which the SAME caller's 403 becomes a 200, and telling them to retry would be a
  // lie.
  | 'RECONCILE_NOT_PERMITTED'
  // 3. 写入
  | 'IMPORTED'
  | 'ALREADY_UP_TO_DATE'
  | 'WRITE_HELD_FOR_CONFIRMATION'
  | 'WRITE_NO_PLAN'
  | 'WRITE_PARTIAL'
  | 'WRITE_FAILED'
  // S2 (R-36, Q4): the puller looked at the preview of a freshly created sheet and chose not to write.
  // Nothing was written; the new sheet stays (empty, 「还没拉过」) — there is no 「撤销新建」.
  | 'WRITE_NOT_CONFIRMED'
  // 4. 批次存档
  | 'BATCH_ARCHIVED'
  | 'BATCH_ALREADY_ARCHIVED'
  | 'BATCH_ARCHIVE_OUTCOME_UNKNOWN'
  | 'BATCH_ARCHIVE_DISABLED'
  | 'BATCH_ARCHIVE_NOT_ATTEMPTED'
  | 'BATCH_ARCHIVE_NOT_PERMITTED'
  | 'BATCH_ARCHIVE_FAILED'
  // #6475 — the archive's own refusals, each with its own next step (classifyArchiveFailure). Only
  // the first is a SKIP (the snapshot tables were never built — a deployment state, like the flag
  // being off); every other one means this sync's batch is missing from 批次与差异, and says so.
  | 'BATCH_ARCHIVE_TABLES_NOT_PROVISIONED'
  | 'BATCH_ARCHIVE_LEDGER_CONFLICT'
  | 'BATCH_ARCHIVE_PREVIOUS_INCOMPLETE'
  | 'BATCH_ARCHIVE_SCHEMA_INCOMPLETE'
  | 'BATCH_ARCHIVE_SCHEMA_UNAVAILABLE'
  | 'BATCH_ARCHIVE_SOURCE_NOT_ACTIVE'
  | 'BATCH_ARCHIVE_TENANT_REQUIRED'
  | 'BATCH_ARCHIVE_SOURCE_BINDING_SPLIT'
  | 'BATCH_ARCHIVE_SOURCE_PROJECT_NOT_FOUND'
  | 'BATCH_ARCHIVE_PLAN_NOT_READY'
  // #6475 round 2 — the archive is not what this sync wrote: the source changed after step ③, or the
  // sheet does not hold all of it. A FAIL, like the refusals above.
  | 'BATCH_ARCHIVE_SYNC_PARITY_MISMATCH'
  // 客户反馈 2026-10-21 9b — the archive refusals that still fell through to BATCH_ARCHIVE_FAILED and
  // its re-sync promise. FAILs, like the refusals above (classifyArchiveFailure).
  | 'BATCH_ARCHIVE_LARGE_BOM_BOUNDED'
  | 'BATCH_ARCHIVE_POINTER_STALE'
  | 'BATCH_ARCHIVE_VERSION_HISTORY'
  | 'BATCH_ARCHIVE_SOURCE_SYSTEM_NOT_FOUND'
  | 'BATCH_ARCHIVE_SERVICE_UNAVAILABLE'
  // #6475 round 2 — step ③ was partial, so step ④ is NOT attempted (a SKIP: nothing was asked of the
  // archive). Its own reason because BATCH_ARCHIVE_NOT_ATTEMPTED says nothing was written, and here
  // some rows were.
  | 'BATCH_ARCHIVE_WRITE_INCOMPLETE'

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

/**
 * #6475 review round 1 — a server error's `details.target` / `details.reason`, clamped the same way:
 * the persist layer's are closed lower_snake vocabularies (`project` / `duplicate_key`,
 * `snapshot_batch` / `content_mismatch`, `run` / `missing`, …), and the same code covers states an
 * administrator handles differently, so the pair is worth carrying to the step's technical detail.
 * Anything that is not lower_snake-shaped is dropped, never carried.
 */
export function clampErrorDetailToken(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,47}$/.test(value) ? value : null
}

export interface StockPreparationProjectSyncStepResult {
  index: number
  id: StockPreparationProjectSyncStepId
  status: Exclude<StockPreparationProjectSyncStepStatus, 'pending'>
  reason: StockPreparationProjectSyncReason
  /** Values-free tokens: counts, HTTP statuses, clamped server status/error tokens. */
  detail: Record<string, string | number>
}

// ---------------------------------------------------------------------------
// 缺件清单 (missing components) — W3a
//
// THE ONE DELIBERATE EXCEPTION to values-free carried past `classifyPlanStep`. Everywhere else on
// this surface a step's `detail` is counts, HTTP statuses and closed tokens — never a value read back
// from a response — because `step.detail` is what the technical disclosure prints verbatim. The
// dry-run response can now carry a SEPARATE, OPT-IN key, `missingComponents`, whose entire purpose is
// to show the operator the customer's own part numbers that block the whole project from writing
// (server-side design: W3a §2–§4, `expansion.missingComponents` — a bypass array kept off the
// rowError/revision/identity/ledger/evidence paths so this feature cannot reopen the anonymous-hold
// contract). `classifyPlanStep` ITSELF IS NOT TOUCHED — this list is read out of the plan by a
// SEPARATE pure function and carried on the report as its own field, never folded into a step's
// `detail` map, so a part number can never reach the technical disclosure's `key=value` dump.
export interface StockPreparationMissingComponent {
  componentSourceId: string
  parentSourceId: string
  bomId: string
  /**
   * Human-readable, ALREADY DECODED. The server sends `path` as `JSON.stringify(pathTokens)`
   * (e.g. `["PART-A","PART-Z"]`); `formatMissingComponentPath` parses it and joins it with `' / '`
   * before this field is ever populated — nothing downstream (panel, export) parses JSON.
   */
  path: string
  depth: number
  occurrenceCount: number
  /** How many DISTINCT parents this component is missing under — >1 means "wanted in more than one place". */
  parentCount: number
}

export interface StockPreparationMissingComponentList {
  distinctCount: number
  probeCount: number
  /** True when the server's own 200-item cap cut the list short; `distinctCount` is still the real total. */
  truncated: boolean
  items: StockPreparationMissingComponent[]
}

/**
 * B1 — why the dry run's `missingComponents` came back empty even though the panel ASKED for it
 * (`includeMissingComponents: true`). Closed, values-free vocabulary; never a server message.
 *
 *   'server_unsupported' — the deployment does not know the `includeMissingComponents` request key
 *      yet (main without the server-side W3a PR merged answers 400 `TABLE_ACTION_REQUEST_INVALID`
 *      for an unrecognized body key). The panel says NOTHING for this — it is a deployment-version
 *      fact, not something an operator can act on.
 *   'scope_denied' — the request was understood, but this caller failed the opt-in's operator-scope
 *      check (403, an `OPERATOR_SCOPE_*` code): no tenant claim, or a platform-admin caller with no
 *      tenant at all. The panel DOES say something here — see `missingComponentsUnavailableReason`
 *      in the panel component — because it is actionable ("ask someone with the right account").
 *
 * Either way `createStockPreparationProjectSyncApi`'s `dryRun` retries the SAME request once without
 * the flag, so this add-on feature failing never sinks the sync itself (B1/M4).
 */
export const STOCK_PREPARATION_MISSING_COMPONENTS_UNAVAILABLE_REASONS = ['server_unsupported', 'scope_denied'] as const
export type StockPreparationMissingComponentsUnavailableReason =
  (typeof STOCK_PREPARATION_MISSING_COMPONENTS_UNAVAILABLE_REASONS)[number]

function missingComponentsUnavailableReasonOf(value: unknown): StockPreparationMissingComponentsUnavailableReason | null {
  return typeof value === 'string'
    && (STOCK_PREPARATION_MISSING_COMPONENTS_UNAVAILABLE_REASONS as readonly string[]).includes(value)
    ? (value as StockPreparationMissingComponentsUnavailableReason)
    : null
}

const MISSING_COMPONENT_FIELD_MAX_LEN = 128
const MISSING_COMPONENT_ITEMS_MAX = 200

function clampMissingComponentField(value: unknown): string {
  if (value === undefined || value === null) return ''
  const text = typeof value === 'string' ? value : String(value)
  return text.slice(0, MISSING_COMPONENT_FIELD_MAX_LEN)
}

/**
 * `path` is NOT a plain string field — the server (W3a #5500) sends it as `JSON.stringify(pathTokens)`
 * (e.g. `["PART-A","PART-Z"]`), not a pre-joined `A/B` string. Decode it into the human-readable form
 * this file hands the panel: parse, and if the result is an array, join it with `' / '`; anything that
 * fails to parse, or parses to something other than an array, falls back to the raw string unparsed
 * (never thrown — this is still the strict-clamp boundary, not a place to crash on bad JSON).
 *
 * TRUNCATION HAPPENS AFTER THE JOIN, not before. Truncating the RAW JSON string to 128 chars first (the
 * way every other field clamps) would cut valid JSON off mid-token for any BOM deep enough to produce
 * a >128-char encoded array, and `JSON.parse` on that fragment throws — silently DEMOTING a perfectly
 * good path into the "couldn't parse it" fallback branch, and displaying a chopped JSON fragment
 * (`["PART-A","PAR`) instead of a chopped human-readable path. Joining first and clamping the RESULT
 * keeps the 128-char cap meaningful regardless of how deep the BOM path is.
 */
function formatMissingComponentPath(value: unknown): string {
  if (value === undefined || value === null) return ''
  const raw = typeof value === 'string' ? value : String(value)
  let joined = raw
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      joined = parsed
        .map((token) => (token === undefined || token === null ? '' : String(token)))
        .join(' / ')
    }
  } catch {
    // Not JSON at all — keep the raw string. A bare, human-typed path (or a future server change)
    // must still show SOMETHING rather than going blank.
  }
  return joined.slice(0, MISSING_COMPONENT_FIELD_MAX_LEN)
}

/**
 * True for a value `clampMissingComponentField` can turn into a MEANINGFUL string: absent, or an
 * actual scalar. An object/array in a string field's slot is not a value to `String()`-coerce — that
 * produces `"[object Object]"`, which is not the customer's data, it is a rendering artifact this
 * boundary must not manufacture and show as though it were real.
 */
function isScalarOrAbsent(value: unknown): boolean {
  return value === undefined || value === null
    || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/** A raw item worth keeping: an object (not an array), whose four string-typed fields are scalar-or-absent. */
function isUsableRawItem(entry: unknown): entry is Record<string, unknown> {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  const source = entry as Record<string, unknown>
  return isScalarOrAbsent(source.componentSourceId)
    && isScalarOrAbsent(source.parentSourceId)
    && isScalarOrAbsent(source.bomId)
    && isScalarOrAbsent(source.path)
}

/**
 * STRICT CLAMP, not best-effort coercion. `plan.missingComponents` arrives as untyped JSON from an
 * opt-in server response this file does not control; a malformed shape is reported as ABSENT
 * (`null`) rather than rendered partially, the same posture `classifyPlanStep` takes toward a
 * malformed plan. `items` is capped at 200 defensively even though the server already caps it there
 * (§3 of the design) — this boundary does not trust the server to have applied its own limit.
 */
export function missingComponentsOf(
  plan: { missingComponents?: unknown } | null | undefined,
): StockPreparationMissingComponentList | null {
  const raw = plan && typeof plan === 'object' ? (plan as { missingComponents?: unknown }).missingComponents : null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rawItems = (raw as { items?: unknown }).items
  // 非数组丢弃: a `missingComponents` whose `items` is not an array is not a partially-usable payload
  // — it is malformed, and the whole key is treated as though the server never sent it.
  if (!Array.isArray(rawItems)) return null

  const items: StockPreparationMissingComponent[] = rawItems
    // DROP, don't paper over: an entry that is not an object, or whose id/parent/bom/path field is
    // itself an object/array, is discarded outright rather than mapped into a blank/garbage row.
    .filter(isUsableRawItem)
    .slice(0, MISSING_COMPONENT_ITEMS_MAX)
    .map((source) => ({
      componentSourceId: clampMissingComponentField(source.componentSourceId),
      parentSourceId: clampMissingComponentField(source.parentSourceId),
      bomId: clampMissingComponentField(source.bomId),
      path: formatMissingComponentPath(source.path),
      depth: intOf(source.depth),
      occurrenceCount: intOf(source.occurrenceCount),
      parentCount: intOf(source.parentCount),
    }))

  return {
    distinctCount: intOf((raw as { distinctCount?: unknown }).distinctCount),
    probeCount: intOf((raw as { probeCount?: unknown }).probeCount),
    truncated: (raw as { truncated?: unknown }).truncated === true,
    items,
  }
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
  // S2: the operator declined the write after the preview. Not `blocked` — nothing refused anything.
  | 'not_written'
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
  /**
   * 缺件清单. `null` whenever the dry run did not (or could not) hand one back — the server omits the
   * key entirely when the plan hit no `missing_component` rows, and `missingComponentsOf` also
   * returns `null` for a malformed payload. Never derived from `steps` — it comes straight off the
   * plan, alongside `planned`.
   */
  missingComponents: StockPreparationMissingComponentList | null
  /** B1: why `missingComponents` is null even though it was requested. `null` when it is not — either it was never asked for, or it landed fine (present or genuinely empty). */
  missingComponentsUnavailableReason: StockPreparationMissingComponentsUnavailableReason | null
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
 * 客户反馈 2026-09-24 #2 (裁定见 PR #6074;后端诊断见 #6067) — WHICH SENTENCE A FAILED DRY RUN GETS.
 *
 * Before this function existed, `classifyPlanStep`'s `!plan` branch always answered
 * `PLAN_READ_FAILED`, so the panel printed the SAME 「没能连上取数,稍后再试一次」 whether the real cause
 * was a dead connection, another project already sitting in the target sheet, a permission refusal,
 * or the source genuinely being down — the last of those is the ONLY one retrying can fix, and it is
 * what that sentence promises. This function reads nothing new: `classifyPlanStep`'s caller already
 * carries a clamped, identifier-shaped error CODE (`clampErrorCode`) and an HTTP STATUS in `options`,
 * and never a server message. Sorted by CODE first, because a `CONNECTION_*` or
 * `TARGET_SHEET_FOREIGN_PROJECT` refusal is meaningful regardless of which HTTP status the load path
 * happens to answer with today (`inferHttpStatus` in http-routes.cjs falls back to 500 for the
 * connection-resolver's own error, which — read by status alone — would otherwise be
 * indistinguishable from a genuine server fault).
 *
 *   `TARGET_SHEET_FOREIGN_PROJECT` (409, stock-preparation-table-actions.cjs) — the target sheet
 *     already holds another project's active rows. Retrying never helps; an administrator has to
 *     clear the old data or point the new project at a fresh sheet.
 *   `CONNECTION_*` (connection-resolver.cjs) — the binding's own connection cannot be resolved
 *     (deleted, not authorized, or no owner bound). Retrying never helps either.
 *   `SOURCE_UNAVAILABLE`, no HTTP status at all (a raw network failure never reaches
 *     `StockPreparationProjectSyncCallError`, so `status` is 0), or ANY 5xx — the transient case the
 *     original sentence was written for. Kept as `PLAN_READ_FAILED`, unchanged.
 *   401 — this caller is not signed in at all (a stale/expired session), which is a DIFFERENT fix
 *     from a 403 (sign in again, vs. ask an administrator for a permission), so it is its own class
 *     rather than sharing 403's sentence.
 *   403 — this caller IS signed in and specifically refused. Both status checks run AFTER the two
 *     code-specific cases above, since a `CONNECTION_*` refusal can itself surface at a non-401/403
 *     status and must not be re-classified just because some OTHER caller's 401/403 looks the same on
 *     the wire.
 *   anything else — genuinely unclassified. Says so plainly instead of guessing a cause that is not
 *     there.
 */
/**
 * 一个项目一张备料表 (S2, R-36) — the project-sheet codes `classifyPlanReadFailureReason` sorts BY CODE
 * ahead of every status rule (all of them answer 4xx, so a status-only reading would send each to the
 * wrong sentence: ABSENT/ARCHIVED are 409, the wall is 409, the schema refusal is 422).
 */
export const STOCK_PREP_PROJECT_SHEET_PLAN_REFUSAL_REASONS: Readonly<Record<string, StockPreparationProjectSyncReason>> = Object.freeze({
  STOCK_PREPARATION_PROJECT_ABSENT: 'PLAN_PROJECT_SHEET_ABSENT',
  STOCK_PREPARATION_PROJECT_ARCHIVED: 'PLAN_PROJECT_SHEET_ARCHIVED',
  TABLE_ACTION_TARGET_TENANT_MISMATCH: 'PLAN_TARGET_NOT_OURS',
  TABLE_ACTION_TARGET_OWNER_UNKNOWN: 'PLAN_TARGET_NOT_OURS',
  TABLE_ACTION_TARGET_UNBOUND: 'PLAN_TARGET_NOT_OURS',
})

/**
 * S2 fix round 1 (refuter #4): `TARGET_SCHEMA_INCOMPLETE` is NOT a project-sheet code — the env
 * sheet answers it too (a deployment whose template columns were deleted). Its project-sheet
 * sentence (repair the project sheet by re-installing the customer pack) is therefore chosen ONLY
 * when the run was on a project sheet (`context.projectSheet`, set by the project-sheet flow, i.e. the
 * server's switch is on and this project resolved to its own sheet). Everywhere else it keeps the
 * reading it had before S2 — the status rules below (a 422 reads as PLAN_READ_FAILED_UNKNOWN) — so
 * the switch-off text is unchanged.
 */
export const STOCK_PREP_PROJECT_SHEET_ONLY_REFUSAL_REASONS: Readonly<Record<string, StockPreparationProjectSyncReason>> = Object.freeze({
  TARGET_SCHEMA_INCOMPLETE: 'PLAN_TARGET_SCHEMA_INCOMPLETE',
})

export function classifyPlanReadFailureReason(
  status: number,
  errorCode: string | null,
  context: { projectSheet?: boolean } = {},
): StockPreparationProjectSyncReason {
  if (errorCode && Object.prototype.hasOwnProperty.call(STOCK_PREP_PROJECT_SHEET_PLAN_REFUSAL_REASONS, errorCode)) {
    return STOCK_PREP_PROJECT_SHEET_PLAN_REFUSAL_REASONS[errorCode]
  }
  if (context.projectSheet === true && errorCode
    && Object.prototype.hasOwnProperty.call(STOCK_PREP_PROJECT_SHEET_ONLY_REFUSAL_REASONS, errorCode)) {
    return STOCK_PREP_PROJECT_SHEET_ONLY_REFUSAL_REASONS[errorCode]
  }
  if (errorCode === 'TARGET_SHEET_FOREIGN_PROJECT') return 'PLAN_READ_FAILED_FOREIGN_PROJECT'
  if (errorCode === STOCK_PREPARATION_DRY_RUN_JOB_IN_PROGRESS_CODE) return 'PLAN_DRY_RUN_BUSY'
  if (errorCode === STOCK_PREPARATION_DRY_RUN_JOB_INTERRUPTED_CODE) return 'PLAN_DRY_RUN_INTERRUPTED'
  if (errorCode && errorCode.startsWith('CONNECTION_')) return 'PLAN_READ_FAILED_CONNECTION'
  if (errorCode === 'SOURCE_UNAVAILABLE' || status === 0 || status >= 500) return 'PLAN_READ_FAILED'
  if (status === 401) return 'PLAN_READ_UNAUTHENTICATED'
  if (status === 403) return 'PLAN_READ_NOT_PERMITTED'
  return 'PLAN_READ_FAILED_UNKNOWN'
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
  options: { status?: number; malformed?: boolean; errorCode?: string | null; projectSheet?: boolean } = {},
): StockPreparationProjectSyncStepResult {
  if (options.malformed) {
    return result(index, 'dry-run', 'fail', 'PLAN_MALFORMED_RESPONSE', { status: options.status ?? 0 })
  }
  if (!plan) {
    const status = options.status ?? 0
    const detail: Record<string, string | number> = { status }
    if (options.errorCode) detail.code = options.errorCode
    const reason = classifyPlanReadFailureReason(status, options.errorCode ?? null, { projectSheet: options.projectSheet === true })
    return result(index, 'dry-run', 'fail', reason, detail)
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
    missingComponents: StockPreparationProjectSyncReport['missingComponents']
    missingComponentsUnavailableReason: StockPreparationProjectSyncReport['missingComponentsUnavailableReason']
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
  else if (write?.reason === 'WRITE_NOT_CONFIRMED') verdict = 'not_written'
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
    missingComponents: context.missingComponents,
    missingComponentsUnavailableReason: context.missingComponentsUnavailableReason,
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
  /**
   * Present ONLY when the request asked for it (`includeMissingComponents: true`) AND the plan hit at
   * least one `missing_component` row — the server omits the key rather than sending an empty one.
   * Untyped on purpose: this is the boundary `missingComponentsOf` clamps, not a shape this file
   * trusts.
   */
  missingComponents?: unknown
  /**
   * B1 — set ONLY by `createStockPreparationProjectSyncApi`'s `dryRun` itself, after it retried the
   * request without `includeMissingComponents` because the flagged request was refused. Not a server
   * field; a caller-supplied `StockPreparationProjectSyncApi` double in a test may set it directly to
   * exercise the report's handling of it without going through the retry.
   */
  missingComponentsUnavailableReason?: StockPreparationMissingComponentsUnavailableReason
}

export interface StockPreparationProjectSyncApplyResult {
  status?: string
  apply?: { counts?: Record<string, number>; written?: number }
  /**
   * #6475 — the values-free digest of the (tenant, action, source) this apply read
   * (http-routes.cjs `stockPreparationSourceScopeDigest`). Handed back to step ④ verbatim, which
   * refuses rather than archive a source other than this one. Untyped at the boundary: read through
   * `sourceScopeDigestOf`.
   */
  sourceScopeDigest?: unknown
  /**
   * #6475 round 2 — the values-free digest of WHAT this apply read (stock-preparation-table-actions.cjs
   * `stockPreparationSourceContentDigest`). Handed back to step ④ verbatim, which refuses rather than
   * archive content the source no longer has or the sheet does not hold. Read through
   * `sourceContentDigestOf`.
   */
  sourceContentDigest?: unknown
}

/** The digest's one wire shape; anything else is treated as absent, never forwarded. */
export const STOCK_PREPARATION_SOURCE_SCOPE_DIGEST_PATTERN = /^[0-9a-f]{32}$/

export function sourceScopeDigestOf(value: unknown): string | null {
  return typeof value === 'string' && STOCK_PREPARATION_SOURCE_SCOPE_DIGEST_PATTERN.test(value) ? value : null
}

/** The content digest has the same one wire shape (32 lowercase hex); anything else is absent. */
export function sourceContentDigestOf(value: unknown): string | null {
  return typeof value === 'string' && STOCK_PREPARATION_SOURCE_SCOPE_DIGEST_PATTERN.test(value) ? value : null
}

/** What step ④ hands the archive call besides the project number. */
export interface StockPreparationProjectSyncArchiveOptions {
  /** Step ③'s `sourceScopeDigest`, when it answered one. */
  sourceScopeDigest?: string
  /** Step ③'s `sourceContentDigest`, when it answered one. */
  sourceContentDigest?: string
}

export interface StockPreparationProjectSyncArchiveResult {
  status?: string
  persisted?: boolean
  created?: Record<string, number>
}

// ---------------------------------------------------------------------------
// R67 ④ — 试算 through the background job lane
// ---------------------------------------------------------------------------
//
// WHY. A dry run for one project is ~1,400 serial PLM reads; on a slow customer PLM the synchronous
// request outlives nginx's 60 s proxy timeout, the browser gets a 504 while the server finishes the
// work anyway, the result is lost, and the operator's retry doubles the PLM load. So the default
// client ENQUEUES (`POST …/dry-run-jobs`, 202) and POLLS the caller's job for the project
// (`GET …/dry-run-jobs?projectNo=`) at the large-BOM lane's interval. What `dryRun` resolves to is
// unchanged: the server stores the synchronous route's exact payload (dry-run token included), and a
// failed job carries the synchronous route's exact status + code — so `classifyPlanStep`, the
// rendering and the apply handoff below do not know which lane answered.
//
// LEAVING DOES NOT CANCEL. `signal` only stops THIS page polling; the job runs to completion on the
// server. A press while this caller's own trial of the project is still running ATTACHES to it (the
// enqueue answers 409 `ownJob: true`) instead of starting a second PLM read.

/** The large-BOM lane's poll interval (largeBomPull.ts). */
export const STOCK_PREPARATION_DRY_RUN_JOB_POLL_INTERVAL_MS = 2000
/** 30 minutes of polls — the server keeps a finished job exactly as long as its dry-run token lives. */
export const STOCK_PREPARATION_DRY_RUN_JOB_MAX_POLLS = 900
/** Consecutive transport failures a poll tolerates before the run reports a read failure. */
export const STOCK_PREPARATION_DRY_RUN_JOB_MAX_POLL_ERRORS = 3
export const STOCK_PREPARATION_DRY_RUN_JOB_IN_PROGRESS_CODE = 'STOCK_PREPARATION_DRY_RUN_JOB_IN_PROGRESS'
export const STOCK_PREPARATION_DRY_RUN_JOB_INTERRUPTED_CODE = 'STOCK_PREPARATION_DRY_RUN_JOB_INTERRUPTED'
/** The one answer on which the client falls back to the synchronous route: no durable job store. */
export const STOCK_PREPARATION_DRY_RUN_JOB_STORE_UNAVAILABLE_CODE = 'STOCK_PREPARATION_DRY_RUN_JOB_STORE_UNAVAILABLE'
export const STOCK_PREPARATION_DRY_RUN_POLL_STOPPED_CODE = 'STOCK_PREPARATION_DRY_RUN_POLL_STOPPED'
export const STOCK_PREPARATION_DRY_RUN_POLL_BUDGET_EXCEEDED_CODE = 'STOCK_PREPARATION_DRY_RUN_POLL_BUDGET_EXCEEDED'

/** Values-free progress, fired once per poll while the job runs. */
export interface StockPreparationDryRunProgress {
  /** Server-measured time since the job started. */
  elapsedMs: number
  /** True when this call picked up a job that was already running for the project. */
  attached: boolean
}

export interface StockPreparationDryRunOptions {
  onProgress?: (progress: StockPreparationDryRunProgress) => void
  /** Stops polling (the job keeps running server-side). */
  signal?: AbortSignal
  /** Real `setTimeout` in production; an instant resolver in tests. */
  wait?: (ms: number) => Promise<void>
  pollIntervalMs?: number
  maxPolls?: number
}

/** The caller's background dry run for one project, as a re-attach probe sees it. */
export interface StockPreparationDryRunJobSnapshot {
  status: 'running' | 'succeeded' | 'failed'
  elapsedMs: number
}

export interface StockPreparationProjectSyncApi {
  /** Options are R67 ④'s progress / stop-polling seam; a double may ignore them. */
  dryRun(projectNo: string, options?: StockPreparationDryRunOptions): Promise<StockPreparationProjectSyncPlan>
  /**
   * R67 ④: the caller's background dry run for this project, or null when there is none — what a
   * remounted page uses to show that a trial it started earlier is still reading PLM. Optional, so an
   * injected double need not implement it (and a mount with one makes no extra request).
   */
  dryRunJobStatus?(projectNo: string): Promise<StockPreparationDryRunJobSnapshot | null>
  reconcile(projectNo: string): Promise<{ counts?: Record<string, number> }>
  apply(projectNo: string, dryRunToken: string): Promise<StockPreparationProjectSyncApplyResult>
  /**
   * `options` is passed ONLY when step ③ answered a digest, so a double written against the old
   * one-argument shape sees exactly the call it always did.
   */
  archive(projectNo: string, options?: StockPreparationProjectSyncArchiveOptions): Promise<StockPreparationProjectSyncArchiveResult>
}

/** HTTP status + clamped error code of a failed call. Never carries a server message. */
export class StockPreparationProjectSyncCallError extends Error {
  status: number

  /** The server's own error code, when it is identifier-shaped. Null otherwise. */
  code: string | null

  /** The server's `details.target` / `details.reason`, when lower_snake-shaped (`clampErrorDetailToken`). */
  detailTarget: string | null

  detailReason: string | null

  /** True when the transport succeeded and the payload was not this API's envelope. */
  malformed: boolean

  constructor(
    status: number,
    route: string,
    options: { code?: string | null; malformed?: boolean; detailTarget?: string | null; detailReason?: string | null } = {},
  ) {
    super(`stock-preparation project sync call failed (${route} -> ${status})`)
    this.name = 'StockPreparationProjectSyncCallError'
    this.status = status
    this.code = options.code ?? null
    this.detailTarget = clampErrorDetailToken(options.detailTarget)
    this.detailReason = clampErrorDetailToken(options.detailReason)
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

/**
 * #6475 — THE ARCHIVE'S OWN REFUSALS, BY SERVER CODE. Before this every one of them rendered as the
 * same 「存档没成功,再同步一次通常就补上了」, which is false for most of them: re-syncing builds no
 * snapshot table, adds no missing column, re-activates no source, gives an account no tenant, rewrites
 * no kept record and completes no half-written one. The server codes are unchanged except the one
 * #6475 added (SOURCE_BINDING_SPLIT); what changes is the step's status and the sentence it points at.
 *
 * ONE SKIP, AND ONLY ONE. A SKIP says "nothing is wrong, this sync just has no batch". That is true of
 * exactly one refusal here; every other one leaves this sync's batch missing from 批次与差异 for a
 * reason somebody has to act on, so it is a FAIL — non-fatal, the import still reads as done.
 *
 *   PERSIST_TARGET_NOT_PROVISIONED (409)      the four snapshot tables were never built for this
 *       tenant (only `POST …/stock-preparation/mvp/ensure` builds them; a customer-pack install and
 *       a project-sheet create do not). SKIP — a deployment state, like the flag being off.
 *   PERSIST_IDEMPOTENCY_CONFLICT (409)        the snapshot ledger already holds rows that do not match
 *       this persist. FAIL. The code alone covers states that are NOT "a copy was kept": a project
 *       ledger with two rows for one project (`project`/`duplicate_key` — checked on EVERY persist,
 *       permanent, no repair path), and, under the opt-in creation-hour batch rule, a batch id that is
 *       already kept with DIFFERENT lines (`snapshot_batch`/`content_mismatch`): a corrected BOM that
 *       adds no newer material, or a BOM that went back to an older batch's hour while a newer batch
 *       is kept. The batch id is the newest material's CREATION hour, not the wall clock, so "the next
 *       hour" never comes. #6475 round 2: a sheet edit (备注 and the other columns people own) or a
 *       sync that only rewrote sheet cells no longer lands here — the archive recognises the batch it
 *       already kept and answers BATCH_ALREADY_ARCHIVED. Nothing was stored in either case above; the
 *       details ride to the step detail.
 *   PERSIST_EXISTING_BATCH_INCOMPLETE (409)   a copy under this batch identity was left half-written
 *       (a pre-P4 crash or an external delete). FAIL. The server never patches it on its own, and an
 *       unchanged BOM keeps the same batch id, so it repeats until an administrator runs the one-shot,
 *       owner-controlled repair (stock-preparation-sync-run-repair-once.cjs — not an HTTP route).
 *   TARGET_SCHEMA_INCOMPLETE (422)            a snapshot table lacks template columns → mvp/repair.
 *   TARGET_SCHEMA_UNAVAILABLE (503)           the column read itself failed → retry / check the host.
 *   TABLE_ACTION_SOURCE_NOT_ACTIVE (409)      the archive requires the bound source to be active (the
 *       trial and the write do not). Since #6475 round 1 the split check below runs FIRST, so this
 *       now names the source step ③ itself read — and whether to re-enable it or rebind away from it
 *       is an administrator's call, which is what the copy says.
 *   TENANT_REQUIRED (400)                     the request reached the archive with no tenant at all.
 *       The archive's tenant is the principal's `user.tenantId` (http-routes.cjs
 *       `resolveAuthUserTenantId`): the verified claim when the token carries one, and — while the
 *       tenant-claim door (MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED) is off, which is the default —
 *       the `x-tenant-id` header `apiFetch` attaches when it does not (utils/api.ts `authHeaders`: the
 *       session org, the page's stored tenant hint, or the URL's `?tenantId=`). So it is NOT "the
 *       signed-in account only, never the page": this answer means neither was present.
 *   STOCK_PREPARATION_MVP_SOURCE_BINDING_SPLIT (409)  the archive would have read a different source
 *       than the one step ③ wrote from (the action is bound differently per workspace) — or would have
 *       been credited to a different tenant than ③'s write — so it read and stored nothing. FAIL →
 *       make the bindings agree; if they already do, the tenant is the administrator's to look at.
 *   STOCK_PREPARATION_MVP_SOURCE_PROJECT_NOT_FOUND (404)  the archive's re-read of the SAME source no
 *       longer finds the project. FAIL → sync again; if step ① agrees, the source no longer has it.
 *   STOCK_PREPARATION_MVP_SOURCE_EXPANSION_NOT_READY (409)  the archive's own recomputed plan still
 *       holds rows (it does not reuse the trial's confirmed decisions or stored rules — see
 *       stock-preparation-mvp-persist-duplicate-hold-gate.test.cjs). FAIL.
 *   STOCK_PREPARATION_MVP_SYNC_PARITY_MISMATCH (409)  #6475 round 2: what the archive would keep is
 *       not what step ③ wrote — `source_changed_since_write` (the source changed after the write) or
 *       `sheet_not_settled` (the sheet does not hold everything step ③ read: rows ③ could not write,
 *       or a PLM cell edited by hand since). Nothing was stored. FAIL → sync again; a row ③ keeps
 *       failing is fixed first.
 *
 * 客户反馈 2026-10-21 9b — the refusals that still fell through to BATCH_ARCHIVE_FAILED, whose copy
 * promised 「再同步一次通常就补上了」 (each verified against plugin-integration-core/lib on the base):
 *   STOCK_PREPARATION_MVP_SOURCE_EXPANSION_BOUNDED (409)  stock-preparation-table-actions.cjs: the
 *       archive's own re-expansion reached the large-BOM bounds. The archive keeps only a BOM it can
 *       expand on the spot; re-syncing the same BOM meets the same bound. FAIL.
 *   PERSIST_PROJECT_POINTER_STALE (409)       stock-preparation-sync-run-persist.cjs: the project's
 *       live pointer does not cover this batch (`stale_pointer` / `pointer_unresolvable`). The persist
 *       fails closed and never moves the pointer on its own; the owner-controlled one-shot repair
 *       (stock-preparation-sync-run-repair-once.cjs) is what advances a provably stale one. FAIL.
 *   PERSIST_VERSION_NOT_MONOTONIC (422)       same file: the project's batch-version history could not
 *       be proven (`history_unprovable`) or does not increase (`not_monotonic`). Fail closed; an
 *       administrator reads the snapshot ledger. FAIL.
 * and two classified by HTTP status, AFTER the code table (a coded answer always wins):
 *   503 with no mapped code                   the server (or a host capability the archive needs, e.g.
 *       STOCK_PREPARATION_MVP_PROVISIONING_API_UNAVAILABLE) answered "unavailable". FAIL →
 *       BATCH_ARCHIVE_SERVICE_UNAVAILABLE.
 *   404 with NO usable code                   in practice `ExternalSystemNotFoundError`, whose class
 *       name is the wire code and so fails `clampErrorCode`: the archive resolves the PLM source with
 *       no workspace (http-routes.cjs `tableActionMvpPersist` → `loadTableActionSourceAdapter`;
 *       external-systems.cjs `selectScopedRow` never widens a null workspace), so a source the trial
 *       found under the page's workspace can be invisible to it. FAIL →
 *       BATCH_ARCHIVE_SOURCE_SYSTEM_NOT_FOUND. A 404 WITH a code (SOURCE_PROJECT_NOT_FOUND) is not this.
 *
 * Every other refusal keeps BATCH_ARCHIVE_FAILED, whose copy no longer promises a re-sync fixes it.
 * The flag-off code and 401/403 are classified by the caller before this table is consulted, exactly
 * as before.
 */
export const STOCK_PREP_ARCHIVE_REFUSAL_OUTCOMES: Readonly<Record<string, {
  status: Exclude<StockPreparationProjectSyncStepStatus, 'pending' | 'ok'>
  reason: StockPreparationProjectSyncReason
}>> = Object.freeze({
  PERSIST_TARGET_NOT_PROVISIONED: Object.freeze({ status: 'skip' as const, reason: 'BATCH_ARCHIVE_TABLES_NOT_PROVISIONED' as const }),
  PERSIST_IDEMPOTENCY_CONFLICT: Object.freeze({ status: 'fail' as const, reason: 'BATCH_ARCHIVE_LEDGER_CONFLICT' as const }),
  PERSIST_EXISTING_BATCH_INCOMPLETE: Object.freeze({ status: 'fail' as const, reason: 'BATCH_ARCHIVE_PREVIOUS_INCOMPLETE' as const }),
  TARGET_SCHEMA_INCOMPLETE: Object.freeze({ status: 'fail' as const, reason: 'BATCH_ARCHIVE_SCHEMA_INCOMPLETE' as const }),
  TARGET_SCHEMA_UNAVAILABLE: Object.freeze({ status: 'fail' as const, reason: 'BATCH_ARCHIVE_SCHEMA_UNAVAILABLE' as const }),
  TABLE_ACTION_SOURCE_NOT_ACTIVE: Object.freeze({ status: 'fail' as const, reason: 'BATCH_ARCHIVE_SOURCE_NOT_ACTIVE' as const }),
  TENANT_REQUIRED: Object.freeze({ status: 'fail' as const, reason: 'BATCH_ARCHIVE_TENANT_REQUIRED' as const }),
  STOCK_PREPARATION_MVP_SOURCE_BINDING_SPLIT: Object.freeze({ status: 'fail' as const, reason: 'BATCH_ARCHIVE_SOURCE_BINDING_SPLIT' as const }),
  STOCK_PREPARATION_MVP_SOURCE_PROJECT_NOT_FOUND: Object.freeze({ status: 'fail' as const, reason: 'BATCH_ARCHIVE_SOURCE_PROJECT_NOT_FOUND' as const }),
  STOCK_PREPARATION_MVP_SOURCE_EXPANSION_NOT_READY: Object.freeze({ status: 'fail' as const, reason: 'BATCH_ARCHIVE_PLAN_NOT_READY' as const }),
  STOCK_PREPARATION_MVP_SYNC_PARITY_MISMATCH: Object.freeze({ status: 'fail' as const, reason: 'BATCH_ARCHIVE_SYNC_PARITY_MISMATCH' as const }),
  STOCK_PREPARATION_MVP_SOURCE_EXPANSION_BOUNDED: Object.freeze({ status: 'fail' as const, reason: 'BATCH_ARCHIVE_LARGE_BOM_BOUNDED' as const }),
  PERSIST_PROJECT_POINTER_STALE: Object.freeze({ status: 'fail' as const, reason: 'BATCH_ARCHIVE_POINTER_STALE' as const }),
  PERSIST_VERSION_NOT_MONOTONIC: Object.freeze({ status: 'fail' as const, reason: 'BATCH_ARCHIVE_VERSION_HISTORY' as const }),
})

/**
 * Step ④'s outcome for a refused archive call. Same precedence the run always had — the flag-off code
 * first, then 401/403 — and only then the per-code table above; then (9b) a 503 the table did not
 * name, then a 404 that carried no usable code; anything else is the generic FAIL.
 * Own-property lookup only, so a code that happens to name an Object.prototype key falls through.
 */
export function classifyArchiveFailure(
  status: number,
  code: string | null,
): { status: Exclude<StockPreparationProjectSyncStepStatus, 'pending' | 'ok'>; reason: StockPreparationProjectSyncReason } {
  if (code === BATCH_ARCHIVE_DISABLED_CODE) return { status: 'skip', reason: 'BATCH_ARCHIVE_DISABLED' }
  if (status === 401 || status === 403) return { status: 'skip', reason: 'BATCH_ARCHIVE_NOT_PERMITTED' }
  if (code && Object.prototype.hasOwnProperty.call(STOCK_PREP_ARCHIVE_REFUSAL_OUTCOMES, code)) {
    const outcome = STOCK_PREP_ARCHIVE_REFUSAL_OUTCOMES[code]
    return { status: outcome.status, reason: outcome.reason }
  }
  if (status === 503) return { status: 'fail', reason: 'BATCH_ARCHIVE_SERVICE_UNAVAILABLE' }
  if (status === 404 && !code) return { status: 'fail', reason: 'BATCH_ARCHIVE_SOURCE_SYSTEM_NOT_FOUND' }
  return { status: 'fail', reason: 'BATCH_ARCHIVE_FAILED' }
}

/** The exact 400 code `normalizeTableActionBody` answers for an unrecognized dry-run body key (http-routes.cjs:1743-1753). */
export const MISSING_COMPONENTS_UNSUPPORTED_CODE = 'TABLE_ACTION_REQUEST_INVALID'

/**
 * B1 — does this dry-run failure mean "the `includeMissingComponents` flag itself was refused",
 * as opposed to an ordinary dry-run failure (bad project number, transport error, …) that a retry
 * without the flag would not fix either? Two, and only two, cases:
 *
 *   400 `TABLE_ACTION_REQUEST_INVALID` — this deployment's `VALID_TABLE_ACTION_DRY_RUN_BODY_KEYS`
 *     does not list `includeMissingComponents` yet (the server-side W3a PR has not merged here).
 *   403 with an `OPERATOR_SCOPE_*` code — the opt-in's own operator-scope gate refused this caller
 *     (no tenant claim, or a platform-admin with none at all).
 *
 * Anything else (a 404 project-not-found, a 500, a malformed envelope, …) is a REAL dry-run failure
 * and must surface as one, not be swallowed into a silent flag-less retry.
 */
function missingComponentsFallbackReason(error: unknown): StockPreparationMissingComponentsUnavailableReason | null {
  if (!(error instanceof StockPreparationProjectSyncCallError)) return null
  if (error.status === 400 && error.code === MISSING_COMPONENTS_UNSUPPORTED_CODE) return 'server_unsupported'
  if (error.status === 403 && typeof error.code === 'string' && error.code.startsWith('OPERATOR_SCOPE_')) return 'scope_denied'
  return null
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

/**
 * S2 (ADR adr-stock-prep-project-sheets-20261008 §4, R-36) — the ONE optional seam the project-sheet
 * flow needs inside the run: 「预览『将写入 N 行』→ 确认 → apply」 for a sheet that was just created.
 * Asked once, after a plan that WOULD write (not held, token in hand) and before the write. Anything
 * but `true` writes nothing: the write step SKIPs with `WRITE_NOT_CONFIRMED` and the archive is not
 * attempted. Without the hook the run is exactly what it always was — every existing caller passes none.
 */
export interface StockPreparationProjectSyncHooks {
  confirmWrite?: (planned: NonNullable<StockPreparationProjectSyncReport['planned']>) => Promise<boolean> | boolean
  /**
   * S2 fix round 1: the run is on a PROJECT SHEET (the project-sheet flow sets it). Only then does a
   * refusal code that both sheet kinds can answer (`TARGET_SCHEMA_INCOMPLETE`) read in its
   * project-sheet wording; see `STOCK_PREP_PROJECT_SHEET_ONLY_REFUSAL_REASONS`.
   */
  projectSheet?: boolean
  /** R67 ④: forwarded to `api.dryRun` — progress and the stop-polling signal. Absent = the old call. */
  dryRun?: StockPreparationDryRunOptions
}

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
  hooks: StockPreparationProjectSyncHooks = {},
): Promise<StockPreparationProjectSyncReport> {
  const steps: StockPreparationProjectSyncStepResult[] = []
  let pendingConfirmCount = 0
  let queuedDecisionCount = 0
  let planned: StockPreparationProjectSyncReport['planned'] = null
  let written: StockPreparationProjectSyncReport['written'] = null
  let missingComponents: StockPreparationProjectSyncReport['missingComponents'] = null
  let missingComponentsUnavailableReason: StockPreparationProjectSyncReport['missingComponentsUnavailableReason'] = null

  function record(step: StockPreparationProjectSyncStepResult): StockPreparationProjectSyncStepResult {
    steps.push(step)
    if (onStep) onStep(step)
    return step
  }

  function done(): StockPreparationProjectSyncReport {
    return summarizeProjectSync(steps, {
      pendingConfirmCount,
      queuedDecisionCount,
      planned,
      written,
      missingComponents,
      missingComponentsUnavailableReason,
    })
  }

  // ---- 1. 试算 -------------------------------------------------------------
  let plan: StockPreparationProjectSyncPlan | null = null
  let planStep: StockPreparationProjectSyncStepResult
  try {
    plan = await (hooks.dryRun ? api.dryRun(projectNo, hooks.dryRun) : api.dryRun(projectNo))
    planned = plannedCountsOf(plan?.counts)
    pendingConfirmCount = planned.manualConfirm
    // Read straight off the plan, NOT off `classifyPlanStep`'s result — see the type's doc comment.
    missingComponents = missingComponentsOf(plan)
    // B1: `dryRun`'s own retry-without-the-flag fallback marks the plan it hands back, if it had to
    // use it. `missingComponents` is `null` in that branch by construction (the retried request never
    // asked for the key), so this reason is the ONLY signal the panel has for WHY.
    missingComponentsUnavailableReason = missingComponentsUnavailableReasonOf(plan?.missingComponentsUnavailableReason)
    planStep = record(classifyPlanStep(1, plan))
  } catch (error) {
    planStep = record(classifyPlanStep(1, null, {
      status: statusOf(error),
      malformed: isMalformed(error),
      errorCode: codeOf(error),
      projectSheet: hooks.projectSheet === true,
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
      // are still in the queue. A refusal here (a lease held by another run, a caller holding neither
      // the platform-admin tier nor the stock-prep operator tier the route now also admits) therefore
      // costs the operator freshness, not the queue — so it is a SKIP that still points at the tab,
      // never a failure of the import.
      //
      // 一线自己拉数据 SPLITS THAT SKIP IN TWO. Round-2 (decision C13) admitted the stock-prep operator
      // tier on this route, so an ordinary operator now reaches steps 1, 2 and 3 and is refused only
      // step 4. Whoever still lands here with a 401/403 — a caller in neither tier, or an operator
      // refused by the tenant-scope door — is in a permanent and CORRECT deployment state, not a
      // transient one — so it gets a reason that says who runs this step instead of「稍后再试」, which
      // for this caller would never come true.
      const status = statusOf(error)
      const detail: Record<string, string | number> = { status }
      const code = codeOf(error)
      if (code) detail.code = code
      const reason = status === 401 || status === 403 ? 'RECONCILE_NOT_PERMITTED' : 'RECONCILE_UNAVAILABLE'
      record(result(2, 'confirm-queue', 'skip', reason, detail))
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
  // S2: the preview's yes/no, asked only now — the plan exists and would write. See the hook's type.
  if (hooks.confirmWrite) {
    const shown = planned ?? plannedCountsOf(undefined)
    const go = await hooks.confirmWrite(shown)
    if (go !== true) {
      record(result(3, 'apply', 'skip', 'WRITE_NOT_CONFIRMED', { add: shown.add, update: shown.update, inactive: shown.inactive }))
      record(result(4, 'archive', 'skip', 'BATCH_ARCHIVE_NOT_ATTEMPTED', {}))
      return done()
    }
  }

  let writeOk = false
  // #6475 round 2: a partial write is an import, but not one the archive may keep (see step ④).
  let writePartial = false
  // #6475: which source ③ read, as the server's values-free digest — handed to ④ untouched so the
  // archive refuses rather than keep a different source's rows as this sync's batch.
  let sourceScopeDigest: string | null = null
  // #6475 round 2: and WHAT it read, likewise handed to ④ untouched.
  let sourceContentDigest: string | null = null
  try {
    const applied = await api.apply(projectNo, token)
    sourceScopeDigest = sourceScopeDigestOf(applied?.sourceScopeDigest)
    sourceContentDigest = sourceContentDigestOf(applied?.sourceContentDigest)
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
      writePartial = true
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
  // #6475 round 2: the archive keeps the WHOLE source as this sync's batch; after a partial write the
  // sheet holds only part of it, so keeping it would put rows in 批次与差异 that are not in the sheet.
  // Not attempted (the server refuses it too, with the content digest). The next sync that writes the
  // rest archives as usual.
  if (writePartial) {
    record(result(4, 'archive', 'skip', 'BATCH_ARCHIVE_WRITE_INCOMPLETE', { failed: written ? written.failed : 0 }))
    return done()
  }
  const archiveOptions: StockPreparationProjectSyncArchiveOptions = {}
  if (sourceScopeDigest) archiveOptions.sourceScopeDigest = sourceScopeDigest
  if (sourceContentDigest) archiveOptions.sourceContentDigest = sourceContentDigest
  try {
    const archived = await (Object.keys(archiveOptions).length > 0 ? api.archive(projectNo, archiveOptions) : api.archive(projectNo))
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
    // The server's closed `details.target` / `details.reason` pair, when it sent one: one code covers
    // states an administrator handles differently (a duplicated project ledger row vs. a batch id
    // already kept), and the technical detail is where they read which.
    if (error instanceof StockPreparationProjectSyncCallError) {
      if (error.detailTarget) detail.target = error.detailTarget
      if (error.detailReason) detail.reason = error.detailReason
    }
    // `classifyArchiveFailure` keeps the two rules this step always had, in the same order:
    //   * the flag being off is the deployment saying "this deployment does not keep snapshot
    //     batches", which is a setting, not a fault (SKIP, BATCH_ARCHIVE_DISABLED);
    //   * 一线自己拉数据: this step stayed platform-admin, so for a stock-prep operator a 401/403 here
    //     is the deployment working as ruled — the rows they came for are already in the sheet and
    //     what is missing is a housekeeping copy somebody else keeps (SKIP, BATCH_ARCHIVE_NOT_PERMITTED).
    // and then (#6475) names the archive's own refusals by code, each with its own next step.
    // Whatever it decides is NON-FATAL: `report.imported` is already true and stays true, because the
    // rows are in the sheet. A FAIL is still visible — it is this run's entry in 批次与差异 missing.
    const outcome = classifyArchiveFailure(statusOf(error), code)
    record(result(4, 'archive', outcome.status, outcome.reason, detail))
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
    const details = envelope?.error && typeof envelope.error === 'object'
      ? (envelope.error as { details?: unknown }).details
      : undefined
    const detailRecord = details && typeof details === 'object' && !Array.isArray(details)
      ? details as { target?: unknown; reason?: unknown }
      : {}
    throw new StockPreparationProjectSyncCallError(status, route, {
      code: clampErrorCode(envelope?.error?.code),
      // Clamped to lower_snake tokens inside the constructor; anything else is dropped.
      detailTarget: typeof detailRecord.target === 'string' ? detailRecord.target : null,
      detailReason: typeof detailRecord.reason === 'string' ? detailRecord.reason : null,
    })
  }
  if (!envelope || envelope.ok !== true) {
    throw new StockPreparationProjectSyncCallError(status, route, { malformed: true })
  }
  return (envelope.data ?? {}) as T
}

/** What `GET …/dry-run-jobs` answers — untyped at the boundary, read field by field. */
interface StockPreparationDryRunJobRecord {
  jobId?: string
  status?: string
  elapsedMs?: number
  result?: unknown
  error?: { httpStatus?: unknown; code?: unknown }
}

function defaultDryRunWait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

export function createStockPreparationProjectSyncApi(
  scope: IntegrationScope,
  actionId: string = STOCK_PREPARATION_PULL_BOM_ACTION_ID,
): StockPreparationProjectSyncApi {
  const query = buildQueryString({ tenantId: scope.tenantId, workspaceId: scope.workspaceId })
  const suffix = query ? `?${query}` : ''
  const base = `/api/integration/table-actions/${encodeURIComponent(actionId)}`
  const json = { 'Content-Type': 'application/json' }
  const jobsRoute = `${base}/dry-run-jobs`

  /** The synchronous dry run — kept for the one deployment shape that has no durable job store. */
  async function syncDryRun(projectNo: string): Promise<StockPreparationProjectSyncPlan> {
    const route = `${base}/dry-run`
    // `includeMissingComponents` is a REQUEST FLAG, not an action parameter — it sits alongside
    // `parameters` rather than inside it (W3a §4.1/§4.2: the server's own opt-in gate reads it
    // off the body root and, only when it is `true`, does the extra operator-scope check that
    // lets the response's `missingComponents` key carry real part numbers).
    try {
      const response = await apiFetch(`${route}${suffix}`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ parameters: { projectNo }, includeMissingComponents: true }),
      })
      return await readEnvelope<StockPreparationProjectSyncPlan>(response, route)
    } catch (error) {
      // B1 — SINGLE, AUTOMATIC FALLBACK. Merging this PR before the server-side W3a PR (#5500 as
      // of writing) must not 400 every dry run on main: if the flagged request was refused for
      // exactly one of the two reasons that mean "the flag itself is the problem" (not "the plan
      // failed"), retry ONCE, plainly, without it. A genuine dry-run failure (bad project number,
      // transport error, …) is NOT one of those two reasons and re-throws unchanged below.
      const reason = missingComponentsFallbackReason(error)
      if (!reason) throw error
      const response = await apiFetch(`${route}${suffix}`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ parameters: { projectNo } }),
      })
      const plan = await readEnvelope<StockPreparationProjectSyncPlan>(response, route)
      return { ...plan, missingComponentsUnavailableReason: reason }
    }
  }

  function jobQuery(projectNo: string, includeMissingComponents: boolean): string {
    const query = buildQueryString({
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      projectNo,
      includeMissingComponents: includeMissingComponents ? 'true' : 'false',
    })
    return `${jobsRoute}?${query}`
  }

  async function readJob(projectNo: string, includeMissingComponents: boolean): Promise<StockPreparationDryRunJobRecord> {
    const response = await apiFetch(jobQuery(projectNo, includeMissingComponents))
    return readEnvelope<StockPreparationDryRunJobRecord>(response, jobsRoute)
  }

  /** POST the job. Resolves `attach` on this caller's OWN 409 (its earlier trial is still running). */
  async function enqueue(projectNo: string, includeMissingComponents: boolean): Promise<'started' | 'attach'> {
    const response = await apiFetch(`${jobsRoute}${suffix}`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify(includeMissingComponents
        ? { parameters: { projectNo }, includeMissingComponents: true }
        : { parameters: { projectNo } }),
    })
    if (response?.status === 409) {
      let payload: unknown = null
      try { payload = await response.clone().json() } catch { payload = null }
      const error = (payload && typeof payload === 'object') ? (payload as { error?: { code?: unknown; details?: { ownJob?: unknown } } }).error : undefined
      if (error?.code === STOCK_PREPARATION_DRY_RUN_JOB_IN_PROGRESS_CODE && error.details?.ownJob === true) return 'attach'
    }
    await readEnvelope<StockPreparationDryRunJobRecord>(response, jobsRoute)
    return 'started'
  }

  /** Poll the caller's job for the project until it ends; the plan, or the synchronous route's error. */
  async function pollJob(
    projectNo: string,
    includeMissingComponents: boolean,
    attached: boolean,
    options: StockPreparationDryRunOptions,
  ): Promise<StockPreparationProjectSyncPlan> {
    const wait = options.wait ?? defaultDryRunWait
    const intervalMs = options.pollIntervalMs ?? STOCK_PREPARATION_DRY_RUN_JOB_POLL_INTERVAL_MS
    const maxPolls = options.maxPolls ?? STOCK_PREPARATION_DRY_RUN_JOB_MAX_POLLS
    let transportErrors = 0
    for (let poll = 0; poll < maxPolls; poll += 1) {
      if (options.signal?.aborted) {
        throw new StockPreparationProjectSyncCallError(0, jobsRoute, { code: STOCK_PREPARATION_DRY_RUN_POLL_STOPPED_CODE })
      }
      let job: StockPreparationDryRunJobRecord
      try {
        job = await readJob(projectNo, includeMissingComponents)
        transportErrors = 0
      } catch (error) {
        // A dropped poll is not a failed dry run — the job is still running server-side. Tolerate a
        // few in a row (a gateway blip); anything with an envelope code is a real answer.
        const transient = error instanceof StockPreparationProjectSyncCallError
          && error.code === null && !error.malformed && (error.status === 0 || error.status >= 502)
        transportErrors += 1
        if (!transient || transportErrors >= STOCK_PREPARATION_DRY_RUN_JOB_MAX_POLL_ERRORS) throw error
        await wait(intervalMs)
        continue
      }
      if (job.status === 'succeeded') return (job.result ?? {}) as StockPreparationProjectSyncPlan
      if (job.status === 'failed') {
        const status = typeof job.error?.httpStatus === 'number' ? job.error.httpStatus : 0
        throw new StockPreparationProjectSyncCallError(status, jobsRoute, { code: clampErrorCode(job.error?.code) })
      }
      if (job.status !== 'running') throw new StockPreparationProjectSyncCallError(200, jobsRoute, { malformed: true })
      if (options.onProgress) options.onProgress({ elapsedMs: intOf(job.elapsedMs), attached })
      await wait(intervalMs)
    }
    throw new StockPreparationProjectSyncCallError(0, jobsRoute, { code: STOCK_PREPARATION_DRY_RUN_POLL_BUDGET_EXCEEDED_CODE })
  }

  /** One flag value: enqueue (or attach) and poll. */
  async function jobDryRun(projectNo: string, includeMissingComponents: boolean, options: StockPreparationDryRunOptions): Promise<StockPreparationProjectSyncPlan> {
    const outcome = await enqueue(projectNo, includeMissingComponents)
    if (outcome === 'started') return pollJob(projectNo, includeMissingComponents, false, options)
    // ATTACH. The running job may have been enqueued with the other flag value (they share the
    // project's one slot but are separate records); the flagged record first, as this client sends.
    try {
      return await pollJob(projectNo, true, true, options)
    } catch (error) {
      if (error instanceof StockPreparationProjectSyncCallError && (error.status === 404 || missingComponentsFallbackReason(error))) {
        return pollJob(projectNo, false, true, options)
      }
      throw error
    }
  }

  return {
    async dryRun(projectNo: string, options: StockPreparationDryRunOptions = {}) {
      // `includeMissingComponents` is a REQUEST FLAG, not an action parameter — it sits alongside
      // `parameters` rather than inside it (W3a §4.1/§4.2). B1's single, automatic fallback is kept
      // exactly as on the synchronous route: a flagged ENQUEUE refused for one of the two "the flag
      // itself is the problem" reasons is retried ONCE without it; anything else surfaces.
      try {
        try {
          return await jobDryRun(projectNo, true, options)
        } catch (error) {
          const reason = missingComponentsFallbackReason(error)
          if (!reason) throw error
          const plan = await jobDryRun(projectNo, false, options)
          return { ...plan, missingComponentsUnavailableReason: reason }
        }
      } catch (error) {
        // No durable job store on this deployment: the synchronous route, which needs none.
        if (error instanceof StockPreparationProjectSyncCallError && error.code === STOCK_PREPARATION_DRY_RUN_JOB_STORE_UNAVAILABLE_CODE) {
          return syncDryRun(projectNo)
        }
        throw error
      }
    },

    async dryRunJobStatus(projectNo: string) {
      for (const includeMissingComponents of [true, false]) {
        try {
          const job = await readJob(projectNo, includeMissingComponents)
          if (job.status === 'running' || job.status === 'succeeded' || job.status === 'failed') {
            return { status: job.status, elapsedMs: intOf(job.elapsedMs) }
          }
          return null
        } catch (error) {
          // Nothing under this flag (404), or the flagged read is not this caller's to make: try the
          // values-free record. Anything else — and both misses — means "nothing to re-attach to".
          const next = error instanceof StockPreparationProjectSyncCallError
            && (error.status === 404 || missingComponentsFallbackReason(error) !== null)
          if (!next) return null
        }
      }
      return null
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

    async archive(projectNo: string, options: StockPreparationProjectSyncArchiveOptions = {}) {
      const route = `${base}/mvp-persist`
      // NO QUERY STRING. mvp-persist refuses a request carrying any query at all
      // (assertStockPreparationTableActionMvpPersistNoSteering): with auto-persist on, the route
      // gains a write side-effect, so an explicit tenant/workspace on any carrier is a steering
      // vector and is rejected fail-closed. Its tenant is the principal's (`user.tenantId` — the
      // verified claim, or on a claimless token the `x-tenant-id` header apiFetch attaches; see
      // STOCK_PREP_ARCHIVE_REFUSAL_OUTCOMES' TENANT_REQUIRED line), and it resolves the source with
      // NO workspace hint — which is why this run hands back step ③'s `sourceScopeDigest`: it names
      // the source ③ read without selecting anything, so mvp-persist can only refuse a mismatch. Same
      // for `sourceContentDigest` (#6475 round 2): it names what ③ read, and can only make ④ refuse.
      const body: Record<string, unknown> = { parameters: { projectNo } }
      const scopeDigest = sourceScopeDigestOf(options.sourceScopeDigest)
      if (scopeDigest) body.sourceScopeDigest = scopeDigest
      const contentDigest = sourceContentDigestOf(options.sourceContentDigest)
      if (contentDigest) body.sourceContentDigest = contentDigest
      const response = await apiFetch(route, {
        method: 'POST',
        headers: json,
        body: JSON.stringify(body),
      })
      return readEnvelope<StockPreparationProjectSyncArchiveResult>(response, route)
    },
  }
}
