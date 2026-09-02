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
 * The entry drives FOUR existing routes, and the widest gate among them is what decides this:
 *
 *   dry-run     requireAccess(req, 'read')    integration:read | :write | platform admin
 *   apply       requireAccess(req, 'write')   integration:write | platform admin
 *   reconcile   requireAccess(req, 'admin')   platform admin ONLY
 *   mvp-persist requireAccess(req, 'admin')   platform admin ONLY
 *
 * so a caller below platform admin would get partway through and 403 — which is the "visible but not
 * actionable" half of R-11. The control therefore renders only for a platform admin, and everyone
 * else is told, in words, who runs it.
 *
 * NOTE THE TIER THIS EXCLUDES, deliberately: the stock-prep OPERATOR (`stock-prep:operate` +
 * `stock-prep:read`) holds no `integration:*` code at all — R-11's mapping is zero-automatic — so the
 * server refuses them at the very first call, the dry run. Hiding the button is this file agreeing
 * with that refusal, not substituting for it. An operator's job on this surface is the confirmation
 * queue; pulling a customer's BOM off their PLM is an owner-level act and stays where it is.
 *
 * Deliberately NOT a member of STOCK_PREP_WORKBENCH_CAPABILITIES, for the same reason
 * `canRunStockPrepInstall` is not: that manifest is the confirmation-queue control set, asserted
 * control-for-control against the queue view by the permission-matrix suites on both sides.
 */
export function canRunStockPrepProjectSync(hasPermission: StockPrepPermissionProbe): boolean {
  return hasPermission(INTEGRATION_ADMIN)
}
