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
//
// 两侧同形,不吃通配 — WHY THESE PREDICATES TAKE A PRINCIPAL AND NOT `useAuth().hasPermission`.
//
// Every decision below is computed by `satisfiesStockPrepAccess` / `holdsPlatformAdmin`, which are
// this file's transcription of the SAME two functions in the plugin module — literal `includes` over
// the flattened permission list, and nothing else. They deliberately do NOT go through
// `useAuth().hasPermission`, whose ladder expands `*:*`, `<resource>:*`, `<resource>:admin` and
// `<resource>:write` → `<resource>:read`. The server expands none of those for this namespace, so a
// predicate that did would render controls the server then 403s — 「visible but not actionable」, the
// exact failure R-11 forbids — and it would do so for real principals (`stock-prep:*` on a role is
// a shape an administrator can and does create).
//
// The signature is what enforces it: the argument is a `{ roles, permissions }` SNAPSHOT
// (`useAuth().getAccessSnapshot()`), not a probe function, so no caller can hand these predicates the
// expanding ladder even by accident. `stockPrepPermissionMatrix.spec.ts` F-09/F-10 then assert the
// two sides agree as a UNIVERSAL equality — every actor, every gate, every landing key, every
// capability set — including the four principals that used to separate them: a bare
// `integration:admin`, `stock-prep:*`, `*:*` without an admin role, and `stock-prep:write`.

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

/**
 * WHO COUNTS AS A PLATFORM ADMIN ON THIS SURFACE — mirrored verbatim from the plugin module's
 * `PLATFORM_ADMIN_PERMISSIONS`, and asserted byte-equal to it.
 *
 * Both entries are matched against the FLATTENED principal (see `flattenStockPrepPrincipal`), so
 * `role:admin` means 「the account holds the admin ROLE」 and `integration:admin` means 「the account
 * holds that literal permission CODE」. Nothing else qualifies — in particular `*:*`, `admin:all`,
 * `users:write` and `integration:*` do not, even though `useAuth().getAccessSnapshot().isAdmin` and
 * `useAuth().hasPermission` treat several of them as admin. That is the whole point of the list:
 * the server admits exactly these two, so this surface must too.
 */
export const PLATFORM_ADMIN_PERMISSIONS: readonly string[] = Object.freeze(['role:admin', INTEGRATION_ADMIN])

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
  // RECONCILE — the step that puts HELD rows into the confirmation queue. Without it, a plan with
  // uncertain rows left the operator in a closed loop: nothing queued, nothing written, and a page
  // pointing them at a queue that could never contain their work.
  Object.freeze({
    step: 'reconcile',
    method: 'POST',
    path: '/api/integration/table-actions/:actionId/confirmation-decisions/reconcile',
    legacyGate: PLATFORM_ADMIN_GATE,
  }),
])

/** The pull step that STAYED platform-admin (reconcile joined the operator split in round-2 C13
 *  and moved to STOCK_PREP_OPERATOR_PULL_STEPS above). The web orchestration skips over it with a
 *  reason. */
export const STOCK_PREP_PLATFORM_ADMIN_PULL_STEPS: readonly { step: string; method: string; path: string; legacyGate: string }[] = Object.freeze([
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

// ---------------------------------------------------------------------------
// THE PRINCIPAL, AND THE TWO DECISIONS EVERY PREDICATE BELOW IS MADE OF
// ---------------------------------------------------------------------------

/**
 * A caller's access facts, exactly as `useAuth().getAccessSnapshot()` reports them.
 *
 * `isAdmin` is deliberately NOT part of this type even though the snapshot carries it: that flag is
 * true for `*:*`, `admin:all`, `users:write`, `roles:write` and `permissions:write`, none of which
 * the server accepts as a platform admin on this surface. Leaving it off the type means no predicate
 * here can read it by mistake.
 */
export interface StockPrepAccessSnapshot {
  roles: readonly string[]
  permissions: readonly string[]
}

/**
 * The principal in the SHAPE THE SERVER COMPUTES ON: one flat list of real permission codes plus the
 * `role:<x>` pseudo-codes the plugin's `listUserPermissions` synthesises from role ids. Flattening
 * here rather than at each call site is what lets `holdsPlatformAdmin` and `satisfiesStockPrepAccess`
 * below be transcriptions of the plugin functions rather than translations of them.
 */
export function flattenStockPrepPrincipal(snapshot: StockPrepAccessSnapshot): string[] {
  const permissions = Array.isArray(snapshot?.permissions) ? snapshot.permissions : []
  const roles = Array.isArray(snapshot?.roles) ? snapshot.roles : []
  return [...permissions, ...roles.map((role) => `role:${role}`)]
}

/** `holdsPlatformAdmin` from the plugin module, over the flattened principal. Literal, never expanded. */
export function holdsPlatformAdmin(snapshot: StockPrepAccessSnapshot): boolean {
  const held = flattenStockPrepPrincipal(snapshot)
  return PLATFORM_ADMIN_PERMISSIONS.some((permission) => held.includes(permission))
}

/**
 * `satisfiesStockPrepAccess` from the plugin module, over the flattened principal — THE decision this
 * whole file is built from, and the reason the browser and the server can be asserted equal for every
 * principal rather than for a chosen table of them.
 *
 * The ladder, in the server's own order:
 *   `role:admin` | `integration:admin`  -> every code
 *   `stock-prep:admin`                  -> read AND operate
 *   `stock-prep:read`                   -> read
 *   `stock-prep:operate` AND `:read`    -> operate
 *
 * The OPERATE tier is a CONJUNCTION of operate AND read, exactly as the server computes it. This is
 * not belt-and-braces: `/stock-prep` is reachable on READ alone, so an operate-WITHOUT-read grant
 * would be a principal permitted to confirm who can never reach the page — permitted-but-hidden, the
 * failure R-11 forbids. Requiring both makes that grant confer nothing on either side, so no
 * permission subset can produce a misaligned actor. The conjunction is strictly narrower than an
 * implication, so it can only withhold a control, never reveal one.
 *
 * FAIL-CLOSED on an unknown code, platform admin included — again the server's posture, so a mistyped
 * token hides a control rather than falling through to something looser.
 *
 * MATCHING IS LITERAL. `stock-prep:*` grants nothing, `*:*` on a non-admin role grants nothing, and
 * `stock-prep:write` does not become `stock-prep:read`. See this file's header for why that is the
 * requirement rather than an omission.
 */
export function satisfiesStockPrepAccess(snapshot: StockPrepAccessSnapshot, code: string): boolean {
  if (!STOCK_PREP_PERMISSION_CODES.includes(code)) return false
  const held = flattenStockPrepPrincipal(snapshot)
  if (PLATFORM_ADMIN_PERMISSIONS.some((permission) => held.includes(permission))) return true
  if (held.includes(STOCK_PREP_ADMIN)) return true
  if (code === STOCK_PREP_ADMIN) return false
  if (code === STOCK_PREP_READ) return held.includes(STOCK_PREP_READ)
  // See above: a CONJUNCTION, never an implication.
  return held.includes(STOCK_PREP_OPERATE) && held.includes(STOCK_PREP_READ)
}

/**
 * Whether one capability may render for this principal — the browser half of the plugin's
 * `grantedStockPrepCapabilities` filter, expression for expression.
 */
export function canStockPrepCapability(
  capability: StockPrepCapability,
  snapshot: StockPrepAccessSnapshot,
): boolean {
  if (capability.code === PLATFORM_ADMIN_GATE) return holdsPlatformAdmin(snapshot)
  return satisfiesStockPrepAccess(snapshot, capability.code)
}

/** The capability ids this principal may exercise — the set the alignment assertion compares. */
export function grantedStockPrepCapabilities(snapshot: StockPrepAccessSnapshot): string[] {
  return STOCK_PREP_WORKBENCH_CAPABILITIES
    .filter((capability) => canStockPrepCapability(capability, snapshot))
    .map((capability) => capability.capability)
}

/** The control testids that may render for this principal. Controls with no testid are excluded. */
export function visibleStockPrepControls(snapshot: StockPrepAccessSnapshot): string[] {
  return STOCK_PREP_WORKBENCH_CAPABILITIES
    .filter((capability) => capability.control !== null && canStockPrepCapability(capability, snapshot))
    .map((capability) => capability.control as string)
}

/**
 * The LEGACY MVP tabs (snapshot diff, mapping/unit confirm, prep lines, exception queue, …) call
 * routes that are still platform-admin gated server-side, and the O1' ruling explicitly did NOT
 * revive them when it narrowed this page to the confirmation queue. They must therefore render only
 * for a platform admin — otherwise an operator who can now reach the page would see six tabs whose
 * every control 403s, which is precisely the "visible but not actionable" half of R-11.
 */
export function canUseLegacyMvpTabs(snapshot: StockPrepAccessSnapshot): boolean {
  return holdsPlatformAdmin(snapshot)
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
export function canOpenStockPrepInstallView(snapshot: StockPrepAccessSnapshot): boolean {
  return satisfiesStockPrepAccess(snapshot, STOCK_PREP_ADMIN)
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
export function canRunStockPrepInstall(snapshot: StockPrepAccessSnapshot): boolean {
  return holdsPlatformAdmin(snapshot)
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
 * 一线自己拉数据 CHANGED THAT, by the owner's ruling. Round-1 additionally admitted the stock-prep
 * operator tier (operate ∧ read) on the two routes that DO the pull, for the pull-bom action id
 * only; round-2 (decision C13, #5460) additionally moved reconcile, because leaving it admin-only
 * put an operator whose plan had human-confirm rows into a closed loop. mvp-persist alone stayed
 * platform-admin — the one step the run can finish without —
 *
 *   dry-run     'read'  OR stock-prep operate ∧ read     <- the operator's step 1
 *   reconcile   'admin' OR stock-prep operate ∧ read     <- the operator's step 2 (round-2 C13)
 *   apply       'write' OR stock-prep operate ∧ read     <- the operator's step 3
 *   mvp-persist 'admin'                                  <- SKIPPED with a reason for them
 *
 * — so an operator's run reaches 「导进去了吗?」 honestly rather than 403-ing partway. R-11's
 * "visible must be actionable" therefore still holds for this control: what the operator can press,
 * the server answers; the one step they cannot run is not a control at all, it is a line in the
 * step list that says who runs it (`BATCH_ARCHIVE_NOT_PERMITTED` in plainLanguage.ts;
 * `RECONCILE_NOT_PERMITTED` still exists for a caller in neither tier, or an operator refused by the
 * tenant-scope door).
 *
 * The disjunction is written out here rather than delegated because it is a disjunction of two
 * different vocabularies — the legacy `integration:*` tier and the stock-prep tier — and neither
 * implies the other.
 *
 * Deliberately NOT a member of STOCK_PREP_WORKBENCH_CAPABILITIES, for the same reason
 * `canRunStockPrepInstall` is not: that manifest is the confirmation-queue control set, asserted
 * control-for-control against the queue view by the permission-matrix suites on both sides.
 *
 * The stock-prep half delegates to `satisfiesStockPrepAccess`, which is precisely what the server's
 * own `operatorMayRunStockPrepPull` delegates to — so the operator arm of this disjunction is the
 * server's arm, not a second reading of it.
 */
export function canRunStockPrepProjectSync(snapshot: StockPrepAccessSnapshot): boolean {
  if (holdsPlatformAdmin(snapshot)) return true
  return satisfiesStockPrepAccess(snapshot, STOCK_PREP_OPERATE)
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
export function canOpenStockPrepProjectBoard(snapshot: StockPrepAccessSnapshot): boolean {
  return satisfiesStockPrepAccess(snapshot, STOCK_PREP_OPERATE)
}

/**
 * 项目备料页 — whose LANDING tab it is.
 *
 * The shell's rule is "the landing tab is the first VISIBLE tab", and that rule alone would put every
 * principal on the board. A platform admin is folded out: their job on this page is the queue and the
 * install/health surfaces, and D2 (`stockPrepLandingKey` below) sends them there. An operator lands
 * on the board, because it is the page they came for.
 *
 * The platform-admin fold is unreachable from `stockPrepLandingKey` — the workbench-admin ceiling
 * admits them one branch earlier — and is kept because the SHELL calls this predicate directly in its
 * own fallback branch, where nothing else excludes them. It is also exactly the shape the plugin's
 * `stockPrepWorkbenchLandingKey` describes in its own comment, so the two stay readable together.
 */
export function landsOnStockPrepProjectBoard(snapshot: StockPrepAccessSnapshot): boolean {
  if (holdsPlatformAdmin(snapshot)) return false
  return canOpenStockPrepProjectBoard(snapshot)
}

// ---------------------------------------------------------------------------
// P1-1 — THE LEFT RAIL (设计稿 §2.2) AND THE LANDING RULING (D2)
// ---------------------------------------------------------------------------
//
// The tab strip became a grouped vertical rail. Structurally it is still ONE tablist of the same
// tabs under the same testids; what is new is that the grouping, the per-item gate and the landing
// item are now DATA rather than three restatements spread across a template, a computed and a
// predicate. The manifest below is that data, and it is mirrored byte-for-byte by
// `plugins/plugin-integration-core/lib/stock-preparation-workbench-access.cjs`
// (`STOCK_PREP_RAIL_GROUPS` / `stockPrepWorkbenchLandingKey`) with `stockPrepPermissionMatrix.spec.ts`
// F-01 asserting the equality — the same cross-side tripwire the capability manifest above keeps.
//
// WHY A GATE TOKEN RATHER THAN A FUNCTION REFERENCE. The mirror has to be comparable as plain data,
// and a function cannot cross that boundary. The token is resolved by `canOpenStockPrepRailItem`
// below, which does nothing but call the named predicates — so a rail item and the predicate it is
// gated on can never disagree, and the server-side mirror resolves the identical token set.

/** Reachability alone: everyone who can OPEN `/stock-prep` sees the item. */
export const STOCK_PREP_RAIL_GATE_ROUTE = 'route'
/** The operator VALUE tier (`stock-prep:operate` ∧ `stock-prep:read`) — 今天要处理 / 项目备料. */
export const STOCK_PREP_RAIL_GATE_OPERATOR_BOARD = 'operator-board'
/** The workbench-scoped ceiling (`stock-prep:admin` and above) — the whole 【部署与接入】 group. */
export const STOCK_PREP_RAIL_GATE_WORKBENCH_ADMIN = 'workbench-admin'
/** Platform admin — the legacy MVP tabs, folded into 深度工具 but NOT re-tiered. */
export const STOCK_PREP_RAIL_GATE_PLATFORM_ADMIN = 'platform-admin'

export type StockPrepRailGate =
  | typeof STOCK_PREP_RAIL_GATE_ROUTE
  | typeof STOCK_PREP_RAIL_GATE_OPERATOR_BOARD
  | typeof STOCK_PREP_RAIL_GATE_WORKBENCH_ADMIN
  | typeof STOCK_PREP_RAIL_GATE_PLATFORM_ADMIN

export interface StockPrepRailItem {
  /** The view key — unchanged from the horizontal strip, so `stock-prep-tab-${key}` keeps its name. */
  key: string
  gate: StockPrepRailGate
}

export interface StockPrepRailGroup {
  /** Group id. The group HEADING is not a tab: no `role="tab"`, no `stock-prep-tab-*` testid. */
  group: string
  items: readonly StockPrepRailItem[]
  /**
   * 深度工具 — the legacy MVP tabs, collapsed by default. They are FOLDED, not retired:
   * `canUseLegacyMvpTabs` is untouched and every one of them still renders for a platform admin.
   */
  advancedGate?: StockPrepRailGate
  advanced?: readonly string[]
}

export const STOCK_PREP_RAIL_GROUPS: readonly StockPrepRailGroup[] = Object.freeze([
  Object.freeze({
    group: 'work',
    items: Object.freeze([
      // 今天要处理 — the operator's landing. It renders the SAME component `project-board` does
      // (StockPreparationProjectBoardView with an empty projectNo), so the P0 「无 projectNo 即首页」
      // behaviour is not reimplemented here: this key just addresses it directly.
      Object.freeze({ key: 'home', gate: STOCK_PREP_RAIL_GATE_OPERATOR_BOARD }),
      Object.freeze({ key: 'project-board', gate: STOCK_PREP_RAIL_GATE_OPERATOR_BOARD }),
      // 项目查询 (P2-1, 设计稿 §6.3 第一行). Reads NOTHING the board does not already read — the U2
      // directory union plus, once a row is selected, that project's own board — so it sits on the
      // SAME operator tier: a principal who may open 项目备料 may query the same list, and one who
      // may not would be handed a panel of project numbers their tier is not entitled to.
      Object.freeze({ key: 'project-query', gate: STOCK_PREP_RAIL_GATE_OPERATOR_BOARD }),
      Object.freeze({ key: 'confirmation-queue', gate: STOCK_PREP_RAIL_GATE_ROUTE }),
    ]),
  }),
  Object.freeze({
    group: 'deploy',
    items: Object.freeze([
      Object.freeze({ key: 'getting-started', gate: STOCK_PREP_RAIL_GATE_WORKBENCH_ADMIN }),
      Object.freeze({ key: 'install', gate: STOCK_PREP_RAIL_GATE_WORKBENCH_ADMIN }),
      Object.freeze({ key: 'ops', gate: STOCK_PREP_RAIL_GATE_WORKBENCH_ADMIN }),
    ]),
    advancedGate: STOCK_PREP_RAIL_GATE_PLATFORM_ADMIN,
    advanced: Object.freeze([
      'dashboard',
      'project-workspace',
      'bom-snapshot-diff',
      'material-mapping',
      'unit-conversion',
      'prep-line',
      'exception-queue',
    ]),
  }),
  Object.freeze({
    group: 'help',
    items: Object.freeze([
      // 怎么用这个页面 + 错误码对照. One tab, two sections: the static card and the existing
      // (self-contained, prop-free) code drawer. A second tab would have been a second key for a
      // disclosure that is already one click away inside this one.
      Object.freeze({ key: 'help', gate: STOCK_PREP_RAIL_GATE_ROUTE }),
    ]),
  }),
])

/**
 * 今天要处理 — same tier as 项目备料, because it is the same component reading the same directory.
 * Delegated rather than restated so the two can never be gated differently.
 */
export function canOpenStockPrepHome(snapshot: StockPrepAccessSnapshot): boolean {
  return canOpenStockPrepProjectBoard(snapshot)
}

/**
 * 项目查询 (P2-1) — same tier as 项目备料, and delegated for the same reason 今天要处理 is.
 *
 * The panel's data is the U2 directory union (the same read 今天要处理 makes, through the same
 * throttle) plus ONE board read for whichever row the reader selects. Every value it can put on
 * screen — a project number, a project name, a count — is a value the board already shows to this
 * exact tier, and every read it makes is a read that tier is already granted. A separate predicate
 * would be a second place for that tier to be spelled, and the first divergence would be invisible.
 */
export function canOpenStockPrepProjectQuery(snapshot: StockPrepAccessSnapshot): boolean {
  return canOpenStockPrepProjectBoard(snapshot)
}

/** 开始使用 — the wizard. The whole 【部署与接入】 group rides `canOpenStockPrepInstallView`. */
export function canOpenStockPrepGettingStarted(snapshot: StockPrepAccessSnapshot): boolean {
  return canOpenStockPrepInstallView(snapshot)
}

/**
 * 记录与排查 — the ops panel. Same tier as the install view it sits beside: every cell it reads is
 * either the read-tier preflight / source binding / pack catalog, or an admin-tier read that renders
 * its own 「这一格看不了」 line rather than a page-level error.
 */
export function canOpenStockPrepOpsPanel(snapshot: StockPrepAccessSnapshot): boolean {
  return canOpenStockPrepInstallView(snapshot)
}

/**
 * 帮助 — static copy plus the error-code dictionary. Both are values-free and NEITHER issues a
 * request, so the gate is exactly reachability: whoever can open `/stock-prep` can read it.
 */
export function canOpenStockPrepHelp(snapshot: StockPrepAccessSnapshot): boolean {
  return satisfiesStockPrepAccess(snapshot, STOCK_PREP_ROUTE_PERMISSION)
}

/** Resolve one rail item's gate token. The ONLY place a token becomes a permission decision. */
export function canOpenStockPrepRailItem(
  gate: StockPrepRailGate,
  snapshot: StockPrepAccessSnapshot,
): boolean {
  if (gate === STOCK_PREP_RAIL_GATE_ROUTE) return canOpenStockPrepHelp(snapshot)
  if (gate === STOCK_PREP_RAIL_GATE_OPERATOR_BOARD) return canOpenStockPrepHome(snapshot)
  if (gate === STOCK_PREP_RAIL_GATE_WORKBENCH_ADMIN) return canOpenStockPrepGettingStarted(snapshot)
  if (gate === STOCK_PREP_RAIL_GATE_PLATFORM_ADMIN) return canUseLegacyMvpTabs(snapshot)
  // An unknown token is a refusal, never a looser default — the same posture the server's
  // `satisfiesStockPrepAccess` takes for a mistyped code.
  return false
}

export type StockPrepLandingKey = 'getting-started' | 'ops' | 'home' | 'confirmation-queue'

/** Every value `stockPrepLandingKey` can return, in decision order. Mirrored server-side. */
export const STOCK_PREP_LANDING_KEYS: readonly StockPrepLandingKey[] = Object.freeze([
  'getting-started',
  'ops',
  'home',
  'confirmation-queue',
])

/**
 * D2=A — WHERE EACH PRINCIPAL LANDS.
 *
 * `deploymentReady` is the shell's reading of the EXISTING read-tier preflight
 * (`readStockPreparationPreflight`, `preflight.ready && preflight.blockerCount === 0`). It is a
 * THREE-valued input on purpose:
 *
 *   true   the deployment answered and it is installed          -> 记录与排查 (「总览」)
 *   false  the deployment answered and it is not installed yet  -> 开始使用
 *   null   we could not read it (403, 500, offline, not asked)  -> 开始使用
 *
 * `null` deliberately lands on 开始使用 rather than 记录与排查: 「看不到」 is not 「装完了」, and an
 * admin sent to a health page about a deployment nobody could read would be told a deployment story
 * we do not actually have. Sending them to the wizard costs one click and states the truth.
 *
 * A non-admin never reaches the preflight branch at all — the argument is not consulted for them —
 * so no operator's landing depends on a read they cannot make.
 */
export function stockPrepLandingKey(
  snapshot: StockPrepAccessSnapshot,
  deploymentReady: boolean | null,
): StockPrepLandingKey {
  if (canOpenStockPrepInstallView(snapshot)) {
    return deploymentReady === true ? 'ops' : 'getting-started'
  }
  // 一线 (operate ∧ read, no workbench-admin ceiling) lands on 今天要处理 — the page they came for.
  // `landsOnStockPrepProjectBoard` is reused verbatim rather than re-derived: the tier is identical,
  // only the key it names moved from 项目备料 to 今天要处理 (which renders the same component with no
  // project open, exactly what 项目备料 did on a bare mount before this wave).
  if (landsOnStockPrepProjectBoard(snapshot)) return 'home'
  // Everyone else — the values-free `stock-prep:read` queue watcher — keeps today's landing.
  return 'confirmation-queue'
}

/**
 * 开始使用 is this principal's landing. Named separately because D2 is stated in those words and a
 * spec that asserts the ruling should be able to say so; it is one expression over the resolver
 * above, so the two can never disagree.
 */
export function landsOnStockPrepGettingStarted(
  snapshot: StockPrepAccessSnapshot,
  deploymentReady: boolean | null,
): boolean {
  return stockPrepLandingKey(snapshot, deploymentReady) === 'getting-started'
}
