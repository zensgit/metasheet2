// O2 / R-11 — the front-end half of the `/stock-prep` confirmation-queue workbench access contract.
//
// The AUTHORITATIVE vocabulary and capability manifest live server-side, in
// `plugins/plugin-integration-core/lib/stock-preparation-workbench-access.cjs`. This module is the
// browser-side mirror of that file, and it is a MIRROR in the enforced sense: the alignment suite
// (`apps/web/tests/stockPrepPermissionMatrix.spec.ts`) imports the plugin module live and asserts
// this file's codes, capability ids, routes and control ids are byte-equal to it — the same
// cross-side tripwire pattern `bomSnapshotDiff.spec.ts` uses for the diff vocabularies. A backend
// vocabulary change therefore reddens a test instead of silently desynchronising the two gates.
//
// R-11's principle, which this file exists to make mechanical:
//   what is visible must be actionable, and what is not permitted must not be visible.
//
// `canStockPrepCapability` is the ONLY thing the workbench may ask. Views must not hand-roll
// `hasPermission('stock-prep:…')` calls: the operate tier is a CONJUNCTION (see below), and a
// hand-rolled probe would drift from the server the first time someone forgets that.

/** Values-free confirmation queue: pending decisions, counts, hold reasons, status enums. */
export const STOCK_PREP_READ = 'stock-prep:read'
/** Confirm a decision (frozen action vocabulary) + the O1'-A value-entry surface. */
export const STOCK_PREP_OPERATE = 'stock-prep:operate'
/** Workbench-scoped ceiling; deliberately BELOW platform admin (opens no provisioning, no pack install). */
export const STOCK_PREP_ADMIN = 'stock-prep:admin'
/** The gate the two owner-level capabilities keep: source-reading reconcile and provisioning ensure. */
export const PLATFORM_ADMIN_GATE = 'admin'
/** The code probed for the platform-admin capabilities on this surface. */
export const INTEGRATION_ADMIN = 'integration:admin'

export const STOCK_PREP_PERMISSION_CODES: readonly string[] = Object.freeze([
  STOCK_PREP_READ,
  STOCK_PREP_OPERATE,
  STOCK_PREP_ADMIN,
])

/** The route-meta gate for `/stock-prep`: reachability is exactly the queue READ code. */
export const STOCK_PREP_ROUTE_PERMISSION = STOCK_PREP_READ

/**
 * 一线自己拉数据 — the ONE table action a stock-prep operator may self-serve. Mirrored from
 * `STOCK_PREP_OPERATOR_PULL_ACTION_ID` in the plugin module and asserted byte-equal against it, so a
 * server-side scoping change reddens a test instead of silently widening the button.
 */
export const STOCK_PREP_OPERATOR_PULL_ACTION_ID = 'plm.stock-preparation.pull-bom.v1'

/**
 * The pull steps that MOVED to the operator tier, each naming the legacy gate it also still keeps.
 *
 * The eight `large-bom-*` members are the BOUNDED BACKGROUND CHANNEL — the same pull, taken in
 * pieces because the BOM is too big to expand in one request. The panel switches to them BY ITSELF,
 * so leaving them out of the split (as the first cut did) meant the operator was admitted to the
 * easy pull and refused the hard one, underneath copy promising 「不用重新点同步,也不用联系我们」.
 */
export const STOCK_PREP_OPERATOR_PULL_STEPS: readonly { step: string; method: string; path: string; legacyGate: string }[] = Object.freeze([
  Object.freeze({
    step: 'dry-run',
    method: 'POST',
    path: '/api/integration/table-actions/:actionId/dry-run',
    legacyGate: 'read',
  }),
  Object.freeze({
    step: 'apply',
    method: 'POST',
    path: '/api/integration/table-actions/:actionId/apply',
    legacyGate: 'write',
  }),
  Object.freeze({
    step: 'large-bom-expansion-start',
    method: 'POST',
    path: '/api/integration/table-actions/:actionId/large-bom/expansion-jobs',
    legacyGate: 'read',
  }),
  Object.freeze({
    step: 'large-bom-expansion-get',
    method: 'GET',
    path: '/api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId',
    legacyGate: 'read',
  }),
  Object.freeze({
    step: 'large-bom-expansion-run',
    method: 'POST',
    path: '/api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId/run',
    legacyGate: 'read',
  }),
  Object.freeze({
    step: 'large-bom-expansion-plan',
    method: 'POST',
    path: '/api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId/plan',
    legacyGate: 'read',
  }),
  Object.freeze({
    step: 'large-bom-apply-start',
    method: 'POST',
    path: '/api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId/apply-jobs',
    legacyGate: 'write',
  }),
  Object.freeze({
    step: 'large-bom-apply-get',
    method: 'GET',
    path: '/api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId/apply-jobs/:applyJobId',
    legacyGate: 'read',
  }),
  Object.freeze({
    step: 'large-bom-apply-run',
    method: 'POST',
    path: '/api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId/apply-jobs/:applyJobId/run',
    legacyGate: 'write',
  }),
  Object.freeze({
    step: 'large-bom-expansion-cancel',
    method: 'POST',
    path: '/api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId/cancel',
    legacyGate: 'write',
  }),
])

/** The pull steps that STAYED platform-admin. The web orchestration skips over both with a reason. */
export const STOCK_PREP_PLATFORM_ADMIN_PULL_STEPS: readonly { step: string; method: string; path: string; legacyGate: string }[] = Object.freeze([
  Object.freeze({
    step: 'reconcile',
    method: 'POST',
    path: '/api/integration/table-actions/:actionId/confirmation-decisions/reconcile',
    legacyGate: PLATFORM_ADMIN_GATE,
  }),
  Object.freeze({
    step: 'mvp-persist',
    method: 'POST',
    path: '/api/integration/table-actions/:actionId/mvp-persist',
    legacyGate: PLATFORM_ADMIN_GATE,
  }),
])

export interface StockPrepCapability {
  /** Stable id, shared verbatim with the backend manifest. */
  capability: string
  /** The permission code that gates it, or PLATFORM_ADMIN_GATE. */
  code: string
  method: string
  path: string
  /** The control's data-testid. It may render only when the capability is granted. */
  control: string | null
}

export const STOCK_PREP_WORKBENCH_CAPABILITIES: readonly StockPrepCapability[] = Object.freeze([
  Object.freeze({
    capability: 'confirmationQueue.readiness',
    code: STOCK_PREP_READ,
    method: 'GET',
    path: '/api/integration/stock-preparation/confirmation-decisions/readiness',
    control: 'stock-prep-confirmation-readiness',
  }),
  Object.freeze({
    capability: 'confirmationQueue.list',
    code: STOCK_PREP_READ,
    method: 'GET',
    path: '/api/integration/stock-preparation/confirmation-decisions',
    control: 'stock-prep-confirmation-queue-refresh',
  }),
  Object.freeze({
    capability: 'confirmationQueue.valueEntry',
    code: STOCK_PREP_OPERATE,
    method: 'GET',
    path: '/api/integration/stock-preparation/confirmation-decisions/value-entry',
    control: 'stock-prep-confirmation-value-entry',
  }),
  Object.freeze({
    capability: 'confirmationQueue.confirm',
    code: STOCK_PREP_OPERATE,
    method: 'POST',
    path: '/api/integration/stock-preparation/confirmation-decisions/confirm',
    control: 'stock-prep-confirmation-confirm',
  }),
  Object.freeze({
    // 按项目导出物料 Excel — 仓库/采购's project materials export. VALUE-BEARING (material names,
    // quantities), so it rides the SAME notch-tighter OPERATE tier as confirmationQueue.valueEntry
    // above, not the broad READ queue-watcher tier.
    capability: 'confirmationQueue.export',
    code: STOCK_PREP_OPERATE,
    method: 'GET',
    path: '/api/integration/stock-preparation/prep-lines/export',
    control: 'stock-prep-confirmation-export',
  }),
  Object.freeze({
    // 一线看得见自己工厂的项目 — the operator's OWN-TENANT project directory / worklist. VALUE-BEARING
    // (project numbers and names), so it rides the OPERATE tier for the same reason
    // confirmationQueue.valueEntry and confirmationQueue.export do. The values-free
    // GET /stock-preparation/projects route is a separate, untouched platform/admin surface and is
    // deliberately not a member of this manifest.
    capability: 'confirmationQueue.projectDirectory',
    code: STOCK_PREP_OPERATE,
    method: 'GET',
    path: '/api/integration/stock-preparation/operator/projects',
    control: 'stock-prep-operator-project-directory',
  }),
  Object.freeze({
    // 通知下一步 — whose turn it is on this project. VALUES-FREE (step keys, indices, booleans,
    // handler counts — never a material name or quantity), so it rides the broad READ queue-watcher
    // tier like the rest of the values-free stock-prep read surface.
    //
    // `control: null` is deliberate and is NOT an oversight. Every other control here is presence-
    // equivalent to its permission, which is what lets the F-04 matrix assert rendered === granted
    // in both directions. These two are additionally gated on RUNTIME TURN STATE (the caller must be
    // the current handler), so a permitted principal who is not whose-turn-it-is legitimately sees no
    // control — presence would not equal grant and F-04 would red for a correct UI. Their visibility
    // is covered by StockPreparationHandoff.spec.ts instead.
    capability: 'handoff.read',
    code: STOCK_PREP_READ,
    method: 'GET',
    path: '/api/integration/stock-preparation/handoff',
    control: null,
  }),
  Object.freeze({
    // 通知下一步 — the advance itself. Rides the OPERATE write tier, the same notch as
    // confirmationQueue.confirm: it mutates durable turn state and dispatches a notification.
    capability: 'handoff.advance',
    code: STOCK_PREP_OPERATE,
    method: 'POST',
    path: '/api/integration/stock-preparation/handoff/advance',
    control: null,
    // 项目备料页 — ONE PROJECT'S BOARD, the operator's landing view. VALUE-BEARING (this project's
    // number and name), so it rides OPERATE for the same reason valueEntry, export and the project
    // directory do. It belongs in this manifest because it is gated on a stock-prep code and has a
    // control of its own — the reverse assertion in the matrix suite (every OPERATE-gated
    // stock-prep route is a member) is what now makes that non-optional.
    capability: 'confirmationQueue.projectBoard',
    code: STOCK_PREP_OPERATE,
    method: 'GET',
    path: '/api/integration/stock-preparation/projects/:projectNo/board',
    control: 'stock-prep-operator-project-board',
  }),
  Object.freeze({
    capability: 'confirmationQueue.ensure',
    code: PLATFORM_ADMIN_GATE,
    method: 'POST',
    path: '/api/integration/stock-preparation/confirmation-decisions/ensure',
    control: 'stock-prep-confirmation-ensure',
  }),
  Object.freeze({
    capability: 'confirmationQueue.reconcile',
    code: PLATFORM_ADMIN_GATE,
    method: 'POST',
    path: '/api/integration/table-actions/:actionId/confirmation-decisions/reconcile',
    control: 'stock-prep-confirmation-reconcile',
  }),
])

export type StockPrepPermissionProbe = (permission: string) => boolean

/**
 * Whether one capability may render, given the app's `hasPermission` probe.
 *
 * The OPERATE tier is a CONJUNCTION of operate AND read, exactly as the server computes it. This is
 * not belt-and-braces: `/stock-prep` is reachable on READ alone, so an operate-WITHOUT-read grant
 * would be a principal permitted to confirm who can never reach the page — permitted-but-hidden, the
 * failure R-11 forbids. Requiring both makes that grant confer nothing on either side, so no
 * permission subset can produce a misaligned actor. The conjunction is strictly narrower than an
 * implication, so it can only withhold a control, never reveal one.
 *
 * `useAuth().hasPermission` already supplies the rest of the ladder identically to the server: the
 * platform-admin short-circuit, exact-code match, and its `resource:admin` rule — which is what makes
 * a `stock-prep:admin` holder satisfy both read and operate on this side too.
 */
export function canStockPrepCapability(
  capability: StockPrepCapability,
  hasPermission: StockPrepPermissionProbe,
): boolean {
  if (capability.code === PLATFORM_ADMIN_GATE) return hasPermission(INTEGRATION_ADMIN)
  if (capability.code === STOCK_PREP_OPERATE) {
    return hasPermission(STOCK_PREP_OPERATE) && hasPermission(STOCK_PREP_READ)
  }
  return hasPermission(capability.code)
}

/** The capability ids this principal may exercise — the set the alignment assertion compares. */
export function grantedStockPrepCapabilities(hasPermission: StockPrepPermissionProbe): string[] {
  return STOCK_PREP_WORKBENCH_CAPABILITIES
    .filter((capability) => canStockPrepCapability(capability, hasPermission))
    .map((capability) => capability.capability)
}

/** The control testids that may render for this principal. Controls with no testid are excluded. */
export function visibleStockPrepControls(hasPermission: StockPrepPermissionProbe): string[] {
  return STOCK_PREP_WORKBENCH_CAPABILITIES
    .filter((capability) => capability.control !== null && canStockPrepCapability(capability, hasPermission))
    .map((capability) => capability.control as string)
}

/**
 * The LEGACY MVP tabs (snapshot diff, mapping/unit confirm, prep lines, exception queue, …) call
 * routes that are still platform-admin gated server-side, and the O1' ruling explicitly did NOT
 * revive them when it narrowed this page to the confirmation queue. They must therefore render only
 * for a platform admin — otherwise an operator who can now reach the page would see six tabs whose
 * every control 403s, which is precisely the "visible but not actionable" half of R-11.
 */
export function canUseLegacyMvpTabs(hasPermission: StockPrepPermissionProbe): boolean {
  return hasPermission(INTEGRATION_ADMIN)
}

/**
 * THE INSTALL / 体检 TAB — who may OPEN it.
 *
 * `stock-prep:admin` is the workbench-scoped ceiling, and opening this tab is exactly a
 * workbench-admin act: it READS the app manifest (the platform app-catalog route, which every
 * authenticated principal may read) and READS the deployment preflight (stock-prep:read, which
 * `stock-prep:admin` satisfies). Nothing behind this gate can 403, so R-11's "visible must be
 * actionable" holds for the panel as a whole.
 *
 * Deliberately NOT a member of STOCK_PREP_WORKBENCH_CAPABILITIES: that manifest is the
 * confirmation-queue control set, asserted control-for-control against the queue view by the
 * permission-matrix suites on both sides. Adding a control that lives in a different component would
 * make that alignment assertion measure the wrong DOM. This is the same shape as
 * `canUseLegacyMvpTabs` above — a tab-level predicate, mirrored by its own test.
 */
export function canOpenStockPrepInstallView(hasPermission: StockPrepPermissionProbe): boolean {
  return hasPermission(STOCK_PREP_ADMIN)
}

/**
 * ...and who may RUN it.
 *
 * The install run drives the two ensure routes and the two customer-pack routes, and all four are
 * `requireAccess(req, 'admin')` server-side — PROVISIONING, which R-11 names as precisely what the
 * operator tier must not open. This PR does not move them, so the run control renders only for a
 * platform admin. A `stock-prep:admin` holder still sees the defaults, the preflight and its fixes;
 * showing them a button that 403s is the "visible but not actionable" failure R-11 forbids.
 */
export function canRunStockPrepInstall(hasPermission: StockPrepPermissionProbe): boolean {
  return hasPermission(INTEGRATION_ADMIN)
}

/**
 * 项目接入 — who may press 「同步这个项目」.
 *
 * The entry drives FOUR existing routes. It used to render for a platform admin ALONE, because the
 * narrowest of the four decided it and a stock-prep operator was refused at the very first call:
 *
 *   dry-run     'read'   integration:read | :write | platform admin
 *   apply       'write'  integration:write | platform admin
 *   reconcile   'admin'  platform admin ONLY
 *   mvp-persist 'admin'  platform admin ONLY
 *
 * 一线自己拉数据 CHANGED THAT, by the owner's ruling: the two routes that DO the pull now additionally
 * admit the stock-prep operator tier (operate ∧ read), for the pull-bom action id only, and the two
 * that stayed platform-admin are precisely the two the run can finish without —
 *
 *   dry-run     'read'  OR stock-prep operate ∧ read     <- the operator's step 1
 *   apply       'write' OR stock-prep operate ∧ read     <- the operator's step 3
 *   reconcile   'admin'                                  <- SKIPPED with a reason for them
 *   mvp-persist 'admin'                                  <- SKIPPED with a reason for them
 *
 * — so an operator's run reaches 「导进去了吗?」 honestly rather than 403-ing partway. R-11's
 * "visible must be actionable" therefore still holds for this control: what the operator can press,
 * the server answers; the two steps they cannot run are not controls at all, they are lines in the
 * step list that say who runs them (`RECONCILE_NOT_PERMITTED` / `BATCH_ARCHIVE_NOT_PERMITTED` in
 * plainLanguage.ts).
 *
 * The disjunction is written out here rather than delegated because it is a disjunction of two
 * different vocabularies — the legacy `integration:*` tier and the stock-prep tier — and neither
 * implies the other.
 *
 * Deliberately NOT a member of STOCK_PREP_WORKBENCH_CAPABILITIES, for the same reason
 * `canRunStockPrepInstall` is not: that manifest is the confirmation-queue control set, asserted
 * control-for-control against the queue view by the permission-matrix suites on both sides.
 */
export function canRunStockPrepProjectSync(hasPermission: StockPrepPermissionProbe): boolean {
  if (hasPermission(INTEGRATION_ADMIN)) return true
  return hasPermission(STOCK_PREP_OPERATE) && hasPermission(STOCK_PREP_READ)
}

/**
 * 项目备料页 — who may OPEN the project board tab.
 *
 * Exactly the tier the board READ is gated on server-side (`stock-prep:operate` ∧ `stock-prep:read`,
 * satisfied through the ladder by `stock-prep:admin` and by a platform admin). For a TENANT-BOUND
 * holder of that tier every control the tab carries is answerable — the board read itself, the pull
 * (see above), the export (already on the operator tier), and the handoff button, which hides itself
 * when its route is absent or unconfigured — so R-11's "visible must be actionable" holds.
 *
 * ONE PRINCIPAL IS THE EXCEPTION, and it is an inherited one rather than a new one: a TENANTLESS
 * platform admin passes the RBAC ladder here and is then refused by the server for having no tenant
 * of its own (403 OPERATOR_SCOPE_TENANT_REQUIRED — see stock-preparation-operator-scope.cjs). That is
 * the deliberate posture #5445 shipped for the whole operator VALUE plane, not a gap this tab opens:
 * the existing `confirmationQueue.projectDirectory` control has exactly the same property, on exactly
 * the same tier, for exactly the same reason. Their values-free surfaces are untouched and still
 * answer for every tenant. Narrowing this predicate to exclude them is a change to that posture and
 * belongs with it, not here.
 *
 * A `stock-prep:read` holder does NOT see it. That is the correct answer rather than a limitation:
 * the board carries project numbers and names, and the read tier is the values-free queue-watcher
 * tier. They keep the confirmation queue, which is what that tier was for.
 *
 * Deliberately NOT a manifest member — a tab-level predicate, the same shape as
 * `canOpenStockPrepInstallView`, mirrored by its own test.
 */
export function canOpenStockPrepProjectBoard(hasPermission: StockPrepPermissionProbe): boolean {
  return hasPermission(STOCK_PREP_OPERATE) && hasPermission(STOCK_PREP_READ)
}

/**
 * 项目备料页 — whose LANDING tab it is.
 *
 * The shell's rule is "the landing tab is the first VISIBLE tab", and that rule alone would put every
 * principal on the board. A platform admin keeps today's landing (确认队列): their job on this page
 * is the queue and the install/health surfaces, and moving their landing would be a change nobody
 * asked for. An operator lands on the board, because it is the page they came for.
 */
export function landsOnStockPrepProjectBoard(hasPermission: StockPrepPermissionProbe): boolean {
  if (hasPermission(INTEGRATION_ADMIN)) return false
  return canOpenStockPrepProjectBoard(hasPermission)
}
