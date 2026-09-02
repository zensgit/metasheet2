'use strict'

// O2 / R-11 — the `/stock-prep` CONFIRMATION-QUEUE WORKBENCH access vocabulary.
//
// WHY THIS MODULE EXISTS
//
// R-11 (docs/development/takeover-beiliao-20260821/decision-register.md) approves the vocabulary
// `stock-prep:read` / `stock-prep:operate` / `stock-prep:admin` and attaches two constraints:
//
//   (a) 映射零自动 — the mapping is ZERO-AUTOMATIC. No pre-existing scope silently becomes a
//       stock-prep scope: the new codes start with zero holders and are granted per role,
//       explicitly. In particular `integration:write` does NOT become a stock-prep operator.
//   (b) 「write→admin」被否 — the earlier proposal to route the operator tier through the platform
//       admin gate was REJECTED, because the admin tier also opens provisioning and customer-pack
//       installation, which is the opposite of a scoped column/queue permission.
//
// and the O1' ruling (o1-ruling-20260829.md §附) narrows `/stock-prep` to the confirmation-queue
// workbench, holding it admin-scoped until the page's capabilities and the route vocabulary agree.
// This module IS that agreement: one frozen capability manifest, one pure decision function, shared
// by the HTTP gate (`http-routes.cjs`) and by the web guard/control tests that import it live.
//
// THE R-11 ALIGNMENT PRINCIPLE, stated as code
//
//   what is visible must be actionable, and what is not permitted must not be visible.
//
// A manifest entry binds, in ONE place, the permission code, the HTTP route the code gates, and the
// front-end control id that may render only when the code is held. Both directions of the alignment
// assertion (nothing visible-but-403, nothing permitted-but-hidden) are therefore decidable from
// this file alone, for any permission subset — see the matrix suites.
//
// THE LADDER (and the one place it is deliberately a CONJUNCTION, not an implication)
//
//   platform admin (`role:admin` | `integration:admin`)  -> satisfies every code below
//   `stock-prep:admin`                                   -> satisfies read and operate
//   `stock-prep:read`                                    -> satisfies read
//   `stock-prep:operate` AND `stock-prep:read`           -> satisfies operate
//
// `operate` requires `read` alongside it rather than implying it. That is not pedantry, it is the
// alignment principle made unbreakable: the page is reachable exactly on `read`, so an
// operate-WITHOUT-read grant would be a principal who may call confirm but can never see the queue
// — permitted-but-hidden, the exact failure R-11 forbids. Requiring the conjunction makes that grant
// confer nothing at all on either side, so no permission subset can produce a misaligned actor.
// Note the direction: the conjunction is STRICTER than an implication would be, so it can only
// refuse callers an implication would have admitted. It is never a widening.
//
// FAIL-CLOSED: an unknown code in this namespace is refused for EVERYONE, platform admin included.
// A typo in a route's gate token therefore 403s loudly instead of silently falling through to the
// legacy `integration:write` default — and `stockPrepGateTokensInSource` lets a suite prove that no
// such typo exists in the route table.

const PLATFORM_ADMIN_PERMISSIONS = Object.freeze(['role:admin', 'integration:admin'])

const STOCK_PREP_PERMISSION_NAMESPACE = 'stock-prep'

/** READ — the values-free confirmation queue: pending decisions, counts, hold reasons, status enums. */
const STOCK_PREP_READ = 'stock-prep:read'
/** OPERATE — confirm a decision (the frozen action vocabulary) and the O1'-A value-entry surface. */
const STOCK_PREP_OPERATE = 'stock-prep:operate'
/** ADMIN — the workbench-scoped ceiling. Deliberately BELOW platform admin: it opens nothing outside this manifest. */
const STOCK_PREP_ADMIN = 'stock-prep:admin'

const STOCK_PREP_PERMISSION_CODES = Object.freeze([STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_ADMIN])

// Human-readable rows for the RBAC seed migration; kept next to the codes so the two cannot drift.
const STOCK_PREP_PERMISSION_DESCRIPTORS = Object.freeze([
  Object.freeze({ code: STOCK_PREP_READ, name: 'Stock Prep Read', description: 'Read the values-free stock-preparation confirmation queue' }),
  Object.freeze({ code: STOCK_PREP_OPERATE, name: 'Stock Prep Operate', description: 'Confirm stock-preparation queue decisions and read back own value entry' }),
  Object.freeze({ code: STOCK_PREP_ADMIN, name: 'Stock Prep Admin', description: 'Workbench-scoped stock-preparation administration (no provisioning, no pack install)' }),
])

/**
 * The gate token that stays on the PLATFORM admin tier. Reconcile and ensure keep it:
 *
 *  - reconcile re-runs the readonly table-action plan, which is a SOURCE READ off the customer's
 *    system and, on a B2a-armed deployment, consumes an operation claim. Letting a customer operator
 *    trigger source reads is an owner-level decision, not a technical-lead one, so it stays where it
 *    is and this PR does not move it.
 *  - ensure PROVISIONS the managed ledger table — schema authoring. R-11(b) names provisioning as
 *    precisely what the operator tier must not open.
 */
const PLATFORM_ADMIN_GATE = 'admin'

/**
 * The workbench capability manifest. One row = one operator-facing capability, binding:
 *   capability : stable id, used by both suites and by the front-end control registry
 *   code       : the permission code that gates it (a stock-prep code, or PLATFORM_ADMIN_GATE)
 *   method/path: the HTTP route, verbatim as registered in http-routes.cjs
 *   control    : the front-end control's data-testid; null when the capability has no control
 *
 * Frozen: a new operator-facing route MUST be added here, or the manifest-vs-route-table assertion
 * in the plugin matrix suite fails.
 */
const STOCK_PREP_WORKBENCH_CAPABILITIES = Object.freeze([
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
    // quantities), so it rides the SAME notch-tighter OPERATE tier as valueEntry above, not the broad
    // READ queue-watcher tier. See stock-preparation-prep-line-export.cjs and the export route's own
    // comment in http-routes.cjs for the full gate-choice justification.
    capability: 'confirmationQueue.export',
    code: STOCK_PREP_OPERATE,
    method: 'GET',
    path: '/api/integration/stock-preparation/prep-lines/export',
    control: 'stock-prep-confirmation-export',
  }),
  Object.freeze({
    // 通知下一步 — whose turn it is on this project. VALUES-FREE (step keys from the closed handoff
    // vocabulary, indices, booleans and handler COUNTS — never a material name, quantity or handler
    // identity), so it rides the broad READ queue-watcher tier along with the rest of the values-free
    // stock-prep read surface.
    //
    // `control: null` is deliberate and is NOT an oversight. Every other control in this manifest is
    // presence-equivalent to its permission, which is exactly what lets the F-04 matrix assert
    // rendered === granted in BOTH directions. These two are additionally gated on RUNTIME TURN STATE
    // (the caller must be the current handler), so a fully permitted principal who is simply not
    // whose-turn-it-is legitimately sees no control — presence would not equal grant, and F-04 would
    // red for a correct UI. Their visibility is covered by its own suite
    // (apps/web/tests/StockPreparationHandoff.spec.ts) instead of by the matrix.
    capability: 'handoff.read',
    code: STOCK_PREP_READ,
    method: 'GET',
    path: '/api/integration/stock-preparation/handoff',
    control: null,
  }),
  Object.freeze({
    // 通知下一步 — the advance itself. Rides the OPERATE write tier, the same notch as
    // confirmationQueue.confirm above and for the same reason: it mutates durable state and has an
    // outside-the-system effect (a DingTalk message). See the `control: null` note above.
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

/** The route meta gate for `/stock-prep`: reachability is exactly the queue READ code. */
const STOCK_PREP_ROUTE_PERMISSION = STOCK_PREP_READ

function isStockPrepPermissionCode(code) {
  return typeof code === 'string' && code.startsWith(`${STOCK_PREP_PERMISSION_NAMESPACE}:`)
}

function holdsPlatformAdmin(permissions) {
  const held = Array.isArray(permissions) ? permissions : []
  return PLATFORM_ADMIN_PERMISSIONS.some((permission) => held.includes(permission))
}

/**
 * The pure decision. `permissions` is the caller's flattened permission list (the plugin's
 * `listUserPermissions` shape: real codes plus synthesized `role:<x>` pseudo-codes).
 *
 * Returns false for any code outside the frozen set — including for a platform admin — so a
 * mistyped gate token cannot fall through to a looser default.
 */
function satisfiesStockPrepAccess(permissions, code) {
  if (!STOCK_PREP_PERMISSION_CODES.includes(code)) return false
  const held = Array.isArray(permissions) ? permissions : []
  if (holdsPlatformAdmin(held)) return true
  if (held.includes(STOCK_PREP_ADMIN)) return true
  if (code === STOCK_PREP_ADMIN) return false
  if (code === STOCK_PREP_READ) return held.includes(STOCK_PREP_READ)
  // See the header: a CONJUNCTION, never an implication.
  return held.includes(STOCK_PREP_OPERATE) && held.includes(STOCK_PREP_READ)
}

/**
 * The capabilities a permission list may exercise — the single set both the front end (what it
 * renders) and the back end (what it answers) are asserted against.
 */
function grantedStockPrepCapabilities(permissions) {
  const held = Array.isArray(permissions) ? permissions : []
  return STOCK_PREP_WORKBENCH_CAPABILITIES
    .filter((entry) => (entry.code === PLATFORM_ADMIN_GATE
      ? holdsPlatformAdmin(held)
      : satisfiesStockPrepAccess(held, entry.code)))
    .map((entry) => entry.capability)
}

/**
 * Every gate expression appearing in a `requireAccess(req, …)` call in the given source text, split
 * by form:
 *
 *   literals    — quoted strings ('admin', 'read', 'write', …)
 *   identifiers — bare identifiers, i.e. the imported constants
 *
 * A suite uses this to assert two things a 403 alone cannot show: that the stock-prep gates are
 * written as CONSTANTS rather than string literals (a literal is exactly where a typo would live,
 * and this module refuses unknown tokens for everyone — including admins — so a typo is an outage),
 * and that no stray `stock-prep:*` literal has crept in beside them.
 */
function requireAccessGateExpressionsInSource(source) {
  const literals = new Set()
  const identifiers = new Set()
  // The lookbehind skips `function requireAccess(req, action)` — the DECLARATION, whose parameter
  // name is not a gate expression and would otherwise show up as a phantom identifier gate.
  const pattern = /(?<!function )requireAccess\(\s*req\s*,\s*(?:'([^']*)'|([A-Za-z_$][\w$]*))\s*\)/g
  const text = String(source || '')
  let match = pattern.exec(text)
  while (match) {
    if (match[1] !== undefined) literals.add(match[1])
    else identifiers.add(match[2])
    match = pattern.exec(text)
  }
  return {
    literals: [...literals].sort(),
    identifiers: [...identifiers].sort(),
  }
}

/**
 * The `stock-prep:*` tokens written as STRING LITERALS in a requireAccess gate. Expected to be
 * EMPTY: the gates reference the exported constants, so this is the tripwire for a hand-typed token.
 */
function stockPrepGateTokensInSource(source) {
  return requireAccessGateExpressionsInSource(source).literals.filter(isStockPrepPermissionCode).sort()
}

module.exports = {
  PLATFORM_ADMIN_GATE,
  PLATFORM_ADMIN_PERMISSIONS,
  STOCK_PREP_ADMIN,
  STOCK_PREP_OPERATE,
  STOCK_PREP_PERMISSION_CODES,
  STOCK_PREP_PERMISSION_DESCRIPTORS,
  STOCK_PREP_PERMISSION_NAMESPACE,
  STOCK_PREP_READ,
  STOCK_PREP_ROUTE_PERMISSION,
  STOCK_PREP_WORKBENCH_CAPABILITIES,
  grantedStockPrepCapabilities,
  holdsPlatformAdmin,
  isStockPrepPermissionCode,
  requireAccessGateExpressionsInSource,
  satisfiesStockPrepAccess,
  stockPrepGateTokensInSource,
}
