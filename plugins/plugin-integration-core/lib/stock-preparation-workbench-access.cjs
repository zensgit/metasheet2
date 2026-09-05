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
    // 一线看得见自己工厂的项目 — the operator's OWN-TENANT project directory / worklist. VALUE-BEARING
    // (project numbers and names), so it rides OPERATE for the same reason valueEntry and export do.
    // It is a SIBLING of the values-free GET /stock-preparation/projects, which keeps its
    // `integration:read` gate and its values-free projection untouched and is deliberately NOT a
    // member of this manifest — that route belongs to the platform/admin workspace, not this
    // workbench. See stock-preparation-operator-project-directory.cjs for the whole posture.
    capability: 'confirmationQueue.projectDirectory',
    code: STOCK_PREP_OPERATE,
    method: 'GET',
    path: '/api/integration/stock-preparation/operator/projects',
    control: 'stock-prep-operator-project-directory',
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

/** The route meta gate for `/stock-prep`: reachability is exactly the queue READ code. */
const STOCK_PREP_ROUTE_PERMISSION = STOCK_PREP_READ

// ---------------------------------------------------------------------------
// 一线自己拉数据 — THE OPERATOR PULL GATE SPLIT
// ---------------------------------------------------------------------------
//
// The owner ruled that a floor operator may self-serve the PLM pull. Two things about that ruling
// have to be encoded rather than remembered, and this block is where they live.
//
// FIRST: THE ROUTES IT TOUCHES ARE GENERIC. `/api/integration/table-actions/:actionId/dry-run` and
// `.../apply` serve EVERY table action on the deployment, present and future. So the split is not
// "the operator tier now satisfies the dry-run gate" — that would hand a stock-prep operator every
// other connector's plan and write. It is scoped to ONE frozen action id, compared for EQUALITY (no
// prefix, no namespace, no wildcard), and that comparison is the whole rule.
//
// SECOND: IT IS ADDITIVE, NEVER A REPLACEMENT. The legacy `integration:read` / `integration:write`
// gates on those two routes are untouched and still admit exactly whom they admitted. The operator
// tier is checked only AFTER the legacy gate has already refused, so no existing caller's outcome
// can change — the split can add an admission, never remove one, and never re-route an existing one.
//
// WHAT DID NOT MOVE, and why it is named here rather than left implicit:
//   * mvp-persist — writes the snapshot batch; still platform-admin and still flag-gated. Its
//     absence costs an operator nothing on their own run: the rows they came for are already in the
//     sheet, and what is missing is a housekeeping copy the diff view uses.
// RECONCILE DID MOVE, and the reasoning is with its manifest row below: it is the step that puts
// held rows into the confirmation queue, so leaving it behind left the operator pointed at a queue
// that could never contain their work.
// The web orchestration degrades over both of those (skip with a reason, never an error), which is
// what makes an operator's four-step run finish honestly rather than reddening on a 403.
//
// These rows are NOT members of STOCK_PREP_WORKBENCH_CAPABILITIES, deliberately and for the same
// reason `canRunStockPrepInstall` is not: that manifest is the confirmation-queue CONTROL set,
// asserted control-for-control against the queue view's DOM by the matrix suites on both sides.
// These are dual-gated routes whose controls live in a different component; adding them there would
// make the alignment assertion measure the wrong DOM and would break its "visible == actionable"
// equality for every legacy `integration:*` holder, who reaches them without holding any stock-prep
// code at all. They get their own suite instead (stock-preparation-operator-pull-gate.test.cjs).

/** The ONE table action an operator may self-serve. Compared for equality — never a prefix. */
const STOCK_PREP_OPERATOR_PULL_ACTION_ID = 'plm.stock-preparation.pull-bom.v1'

/**
 * The sub-routes that MOVED to the operator tier, each naming the legacy gate it also still keeps.
 * `legacyGate` is the token the route passes to `hasPermission` first; the operator tier is only
 * consulted when that has already said no.
 */
const STOCK_PREP_OPERATOR_PULL_STEPS = Object.freeze([
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
  // ── THE BOUNDED BACKGROUND CHANNEL — THE SAME PULL, JUST TOO BIG TO DO IN ONE REQUEST ──────────
  //
  // A first cut of this split moved dry-run and apply only. That left the operator tier admitted to
  // the pull right up to the point where the pull is HARD: the moment a BOM is too large to expand
  // inline, the panel switches to these eight routes automatically and every one of them 403'd — and
  // it did so directly underneath copy that promised 「不用重新点同步,也不用联系我们」. A large BOM
  // is not a different act from a small one, and it is the case where "ask a platform administrator"
  // costs the most: the projects that need the background channel are precisely the big ones.
  //
  // These are the SAME pull under the same frozen action id, so they take the SAME rule — equality
  // on `plm.stock-preparation.pull-bom.v1`, the legacy gate checked first, the tenant verified
  // through `resolveOperatorValueScope`. The apply-side members reach the SAME
  // `assertStockPrepApplyAllowed` sandbox/production gate and the same plan-bound check the small
  // apply route rides, so an operator gains no write the admin path did not already fence.
  //
  // `cancel` is in the list deliberately: it stops a job THIS caller started, and a channel you can
  // start but not stop is worse than one you cannot start at all.
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
  // ── RECONCILE — the step that closes the loop for a plan with human-confirm rows ───────────────
  //
  // IT STAYED PLATFORM-ADMIN, AND THAT PUT THE OPERATOR IN A CLOSED LOOP. A plan whose rows the
  // system is unsure about does not write them; it holds them for a person, and the queue they are
  // held in is filled BY THIS ROUTE. With reconcile refused, the operator's run went: 试算 says
  // "some rows need a person", reconcile is skipped, 写入 is skipped for want of a token — and the
  // page then pointed them at a confirmation queue that would never contain those rows, because the
  // only thing that puts them there is the step that was refused. Every door in the room was
  // painted on.
  //
  // WHY IT IS SAFE TO MOVE, stated precisely, because R-11(b) named this route as owner-level:
  //   * it is a SOURCE READ plus a write to the plugin's OWN confirmation-decision ledger. It
  //     writes no customer row and touches no external system's data.
  //   * the source read now runs under the SERVER-HELD BINDING OWNER for this one action id (see
  //     resolveTableActionReadPrincipal), so admitting an operator does not hand them a connection
  //     they do not own — it is the same delegated read the dry-run already performs.
  //   * the B2a operation claim it consumes when armed is consumed under that same delegated
  //     identity and the same purpose the dry-run uses, so the fence sees one actor, not a new one.
  // mvp-persist does NOT move: it writes the snapshot archive, its absence costs an operator
  // nothing on their own run, and the page says so in words.
  Object.freeze({
    step: 'reconcile',
    method: 'POST',
    path: '/api/integration/table-actions/:actionId/confirmation-decisions/reconcile',
    legacyGate: PLATFORM_ADMIN_GATE,
  }),
])

/** The sub-routes that STAYED platform-admin. Listed so a suite can prove the split did not drift. */
const STOCK_PREP_PLATFORM_ADMIN_PULL_STEPS = Object.freeze([
  Object.freeze({
    step: 'mvp-persist',
    method: 'POST',
    path: '/api/integration/table-actions/:actionId/mvp-persist',
    legacyGate: PLATFORM_ADMIN_GATE,
  }),
])

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
 * MAY THIS PRINCIPAL SELF-SERVE THIS TABLE ACTION'S PULL? The whole operator-pull rule, as one pure
 * function of `(permissions, actionId)` so the route, the suite and the web mirror all read the SAME
 * decision instead of three restatements of it.
 *
 * Both halves are load-bearing:
 *   * the action id must EQUAL the one frozen id — a different action, a prefix of it, an empty
 *     string or a null all answer false, so the split can never leak across the table-action
 *     namespace; and
 *   * the permission side delegates to `satisfiesStockPrepAccess`, so the operate-AND-read
 *     conjunction and the platform-admin short-circuit stay defined in exactly one place.
 *
 * It GRANTS nothing on its own: the routes call it only after their legacy gate has refused, and a
 * false answer there is the same refusal the caller already had.
 */
function operatorMayRunStockPrepPull(permissions, actionId) {
  if (typeof actionId !== 'string' || actionId !== STOCK_PREP_OPERATOR_PULL_ACTION_ID) return false
  return satisfiesStockPrepAccess(permissions, STOCK_PREP_OPERATE)
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
  STOCK_PREP_OPERATOR_PULL_ACTION_ID,
  STOCK_PREP_OPERATOR_PULL_STEPS,
  STOCK_PREP_PERMISSION_CODES,
  STOCK_PREP_PERMISSION_DESCRIPTORS,
  STOCK_PREP_PERMISSION_NAMESPACE,
  STOCK_PREP_PLATFORM_ADMIN_PULL_STEPS,
  STOCK_PREP_READ,
  STOCK_PREP_ROUTE_PERMISSION,
  STOCK_PREP_WORKBENCH_CAPABILITIES,
  grantedStockPrepCapabilities,
  holdsPlatformAdmin,
  isStockPrepPermissionCode,
  operatorMayRunStockPrepPull,
  requireAccessGateExpressionsInSource,
  satisfiesStockPrepAccess,
  stockPrepGateTokensInSource,
}
