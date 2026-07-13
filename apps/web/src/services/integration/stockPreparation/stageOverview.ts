// Stock Preparation UI humanization H1/H2 (H0 plane-boundary design-lock PR #4202 —
// docs/development/stock-preparation-ui-humanization-h0-plane-boundary-design-lock-20260712.md,
// branch claude/stock-prep-ui-h0-designlock, PROPOSED/not yet merged — PLANE A ONLY. Per that lock's
// own §5.3, "H1-H2 在证据面实现无需等本锁" (H1/H2 in the evidence plane may proceed without waiting
// for ratification); H3's authorized data-plane read is gated separately and is NOT touched here).
//
// Pure, network-free derivation for:
//  - H2 the six-stage progress stepper (provision -> sync -> map -> unit -> generate -> exception):
//    per-stage status classification from counts alone.
//  - H1 the deterministic "recommended next step" rule: which stage needs the operator's attention,
//    derived from stage counts/status — NEVER from a business value.
//
// VALUES-FREE BY CONSTRUCTION: every input/output here is a count, a closed enum, or an internal
// handle-shaped key. There is no field here that could carry a drawing number, material code, ERP
// id, or any other customer business value — that surface is H3 (gated on OD-W3-1) and is not touched
// by this module.
//
// SCOPE HONESTY (frontend-audit lessons, carried forward from the existing 6 views — #3751 T6):
//  - The material-mapping table has NO projectId column (stock-preparation-confirm-reads.cjs
//    getMaterialMappingSummary takes no projectId at all, and its sibling listMaterialMappingCandidates
//    resolves targetProjectId via resolveIntegrationStagingProjectId(tenantId, requestedProjectId),
//    which — for an ordinary PLM business projectId — collapses to the SAME `${tenantId}:integration-core`
//    staging project regardless of which business project was requested). Its "map" stage counts are
//    therefore TENANT-WIDE, not filtered to the selected project, even though the request carries a
//    projectId. This module tags that stage with the 'tenant_wide' caveat rather than presenting the
//    number as project-specific.
//  - The exception queue's unresolvedBlockingCount is a POST-FILTER, READ-TIME subset (server comment,
//    stock-preparation-confirm-reads.cjs: "Count scope follows the ACTIVE filters ... display context,
//    never the enforcement point — enforcement lives in the generation run route"). This module tags
//    the 'exception' stage with the 'display_only' caveat so callers never present it as the
//    generation-gate's authoritative value.
//  - unit-conversion rules are ALSO tenant-wide, but pendingUnitLineCount is computed over the
//    selected project's latest complete snapshot batch — the one number this module uses for the
//    'unit' stage IS project-scoped, so no caveat is attached there.
//  - 'sync' (snapshot batches) and 'generate' (prep lines) / 'exception' rows are genuinely filtered
//    server-side by the business projectId (stock-preparation-snapshot-reads.cjs / -confirm-reads.cjs
//    both pass `{ projectId: businessProjectId }` into queryAllRecords) — no caveat needed there.
//
// PERMISSION HONESTY (owner correction 2026-07-12): stages sync/map/unit/generate/exception read
// admin-gated routes (requireAccess(req, 'admin') in http-routes.cjs). This module NEVER assumes
// those five are visible to every operator — callers pass `adminDetailAvailable` (derived from the
// REAL server response, never a client-side role heuristic) and this module degrades honestly when
// it is false, falling back to the coarser but universally-readable /projects counts (tier 1).

export type StockPreparationStageKey = 'provision' | 'sync' | 'map' | 'unit' | 'generate' | 'exception'

/** Canonical pipeline order — also the order the recommended-next-step rule walks. */
export const STOCK_PREPARATION_STAGE_KEYS: readonly StockPreparationStageKey[] = [
  'provision',
  'sync',
  'map',
  'unit',
  'generate',
  'exception',
]

// The stepper and the recommended-next-step banner both need to turn "go look at this stage" into
// "switch the shell to this tab" — a single shared map keeps that 1:1 correspondence in ONE place
// instead of duplicating it across the stepper and the dashboard. Values are the existing
// StockPreparationWorkspace.vue tab keys (plain strings here to avoid a circular type import; the
// shell casts back to its own StockPreparationViewKey union, which these six literals satisfy).
export const STOCK_PREPARATION_STAGE_VIEW_KEY: Readonly<Record<StockPreparationStageKey, string>> = {
  provision: 'project-workspace',
  sync: 'bom-snapshot-diff',
  map: 'material-mapping',
  unit: 'unit-conversion',
  generate: 'prep-line',
  exception: 'exception-queue',
}

/**
 * FE-DERIVED classification only (never a server enum): a closed, values-free vocabulary describing
 * a stage's state for the stepper.
 *  - not_started: the stage has zero rows/items yet (nothing to review).
 *  - pending: awaiting an operator action that isn't "blocked" (provision only: a project exists but
 *    none is selected yet).
 *  - blocked: the stage has a positive blocking/needs-attention count.
 *  - clear: the stage has data and nothing currently needs attention.
 *  - forbidden: the operator's session lacks the admin permission this stage's read requires.
 *  - unknown: the read failed for a reason other than a confirmed permission denial (network / 404 /
 *    row-bound / backend-not-ready) — mirrors the existing views' own neutral "not ready" state.
 */
export type StockPreparationStageStatus = 'not_started' | 'pending' | 'blocked' | 'clear' | 'forbidden' | 'unknown'

export type StockPreparationStageCaveat = 'tenant_wide' | 'display_only'

export interface StockPreparationStageMetric {
  key: StockPreparationStageKey
  status: StockPreparationStageStatus
  /** Primary count for the stage; null when genuinely unavailable (forbidden/errored/not fetched). */
  count: number | null
  /** "Needs attention" count for the stage; null when the stage has no such concept or is unavailable. */
  blockingCount: number | null
  /** Present only when this stage's number carries a scope/timing honesty caveat (see module header). */
  caveat?: StockPreparationStageCaveat
}

/** Classify a detail stage (sync/map/unit/generate/exception) from its raw counts + fetch outcome. */
export function classifyDetailStageStatus(input: {
  count: number | null
  blockingCount: number | null
  forbidden: boolean
  errored: boolean
}): StockPreparationStageStatus {
  if (input.forbidden) return 'forbidden'
  if (input.errored) return 'unknown'
  if (input.count === null) return 'unknown'
  if (input.count === 0) return 'not_started'
  if (input.blockingCount !== null && input.blockingCount > 0) return 'blocked'
  return 'clear'
}

/** Classify the provision stage — read-gated, always attemptable, never "forbidden". */
export function classifyProvisionStatus(input: { projectCount: number; hasSelection: boolean }): StockPreparationStageStatus {
  if (input.projectCount === 0) return 'not_started'
  if (!input.hasSelection) return 'pending'
  return 'clear'
}

export type StockPreparationRecommendedStepKind = 'select_project' | 'admin_required' | 'go_to_stage' | 'all_clear'

// Values-free reason enum. Each entry is a CLASSIFICATION key, never a rendered sentence — the
// component owns the bi(zh, en) copy and interpolates `count` where the reason calls for a number.
export type StockPreparationRecommendedStepReason =
  | 'no_project_selected'
  | 'admin_permission_required'
  | 'sync_incomplete_batches'
  | 'mapping_pending_tenant_wide'
  | 'unit_pending_lines'
  | 'generate_not_run'
  | 'exception_unresolved_blocking'
  // Tier-1 fallback reasons — derived ONLY from the read-gated /projects per-project counts, used
  // when the five admin-gated stage reads are unavailable (non-admin operator, or the reads errored).
  | 'project_open_exceptions'
  | 'project_held_lines'
  | 'project_no_snapshot_yet'
  | 'all_clear'

export interface StockPreparationRecommendedStep {
  kind: StockPreparationRecommendedStepKind
  /** Present only for kind === 'go_to_stage' — the stage (and thus the tab) to navigate to. */
  stage?: StockPreparationStageKey
  reason: StockPreparationRecommendedStepReason
  /** The count driving the recommendation, when the reason names one (values-free: a count only). */
  count?: number | null
}

/** The four per-project counts already exposed by the read-gated GET /projects overview (T1, #4190). */
export interface StockPreparationTierOneSignals {
  snapshotBatchCount: number
  openExceptionCount: number
  readyLineCount: number
  heldLineCount: number
}

// Pipeline-causal order for the tier-2 walk: fix upstream/root-cause stages before downstream
// symptoms (mapping/unit gate generation; exceptions are largely a downstream symptom of the same
// root causes and are surfaced last among the "existing blocker" checks).
const TIER_TWO_BLOCKING_ORDER: ReadonlyArray<{
  key: StockPreparationStageKey
  reason: StockPreparationRecommendedStepReason
}> = [
  { key: 'sync', reason: 'sync_incomplete_batches' },
  { key: 'map', reason: 'mapping_pending_tenant_wide' },
  { key: 'unit', reason: 'unit_pending_lines' },
  { key: 'exception', reason: 'exception_unresolved_blocking' },
]

/**
 * Deterministic, values-free "recommended next step" rule (H1). Inputs are counts/enums/booleans
 * only; the output names a STAGE + a REASON KEY, never a business value.
 *
 * Priority:
 *  1. No project selected -> select one.
 *  2. (tier 2, admin detail available) walk sync -> map -> unit -> exception in pipeline-causal
 *     order; the first with a positive blockingCount wins.
 *  3. (tier 2) nothing blocked upstream, but generate has never produced a line -> go generate.
 *  4. (tier 2) nothing pending anywhere -> all clear.
 *  5. (tier 1 fallback — non-admin operator, or the admin reads errored) derive a coarser
 *     recommendation from the read-gated per-project counts alone.
 */
export function deriveRecommendedNextStep(input: {
  hasProject: boolean
  adminDetailAvailable: boolean
  stages?: StockPreparationStageMetric[]
  projectSignals?: StockPreparationTierOneSignals
}): StockPreparationRecommendedStep {
  if (!input.hasProject) {
    return { kind: 'select_project', reason: 'no_project_selected' }
  }

  // The tier-2 walk is only trustworthy if the detail reads actually SUCCEEDED. A rejected read
  // classifies its stage 'unknown' (classifyDetailStageStatus, errored:true) — the array still exists
  // but its numbers are absent, so treating "array present" as "detail available" would let a total
  // read failure fall through to all_clear ("nothing to handle") when the truth is "we don't know".
  // If ANY detail stage is unknown, drop to the tier-1 fallback (read-gated per-project signals) or an
  // explicit admin_required, never all_clear.
  const detailUnknown = Boolean(
    input.stages && input.stages.some((stage) => stage.key !== 'provision' && stage.status === 'unknown'),
  )
  if (input.adminDetailAvailable && input.stages && !detailUnknown) {
    const byKey = new Map(input.stages.map((stage) => [stage.key, stage]))
    for (const { key, reason } of TIER_TWO_BLOCKING_ORDER) {
      const stage = byKey.get(key)
      if (stage && stage.blockingCount !== null && stage.blockingCount > 0) {
        return { kind: 'go_to_stage', stage: key, reason, count: stage.blockingCount }
      }
    }
    const generateStage = byKey.get('generate')
    if (generateStage && generateStage.count === 0) {
      return { kind: 'go_to_stage', stage: 'generate', reason: 'generate_not_run', count: 0 }
    }
    return { kind: 'all_clear', reason: 'all_clear' }
  }

  const signals = input.projectSignals
  if (!signals) {
    return { kind: 'admin_required', reason: 'admin_permission_required' }
  }
  if (signals.openExceptionCount > 0) {
    return { kind: 'go_to_stage', stage: 'exception', reason: 'project_open_exceptions', count: signals.openExceptionCount }
  }
  if (signals.heldLineCount > 0) {
    return { kind: 'go_to_stage', stage: 'generate', reason: 'project_held_lines', count: signals.heldLineCount }
  }
  if (signals.snapshotBatchCount === 0) {
    return { kind: 'go_to_stage', stage: 'sync', reason: 'project_no_snapshot_yet', count: 0 }
  }
  return { kind: 'all_clear', reason: 'all_clear' }
}
