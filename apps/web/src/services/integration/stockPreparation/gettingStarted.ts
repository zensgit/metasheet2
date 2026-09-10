// BOM备料 接入向导「开始使用」— 七步地图的纯派生逻辑 (P0-4; ① 拆成 ①a/①b 于 2026-09-10).
//
// ARCHITECTURE: this module is PURE and issues no read of its own. Five of the six badges are derived
// from data the install page already fetches through EXISTING calls (the manifest, the deployment
// preflight, the source preflight, the source binding) — a NARRATIVE layer over state
// `StockPreparationInstallView.vue` already owns, passed down as props. The sixth, ⑤「谁能用」, is the
// one step no existing call answers, so P1-3 added exactly one read for it
// (`onboardingReadiness.ts`, owned by the wizard component); this module receives that read's already
// -decided verdict as `roleReadiness` and projects it, the same way it projects everything else.
// R7 (design §8.1):
// "每一步判定只用服务端答的字段,不在前端二次推导" — this file only RE-READS fields the server already
// decided (`preflight.ready`, `sourcePreflight.verdict`, `blocker.fix.kind`, and the binding
// envelope's `effectiveExternalSystemId` / `eligibleSources`), never a second opinion assembled out
// of an adjacent field that merely correlates.
//
// D6 (源预检永不随页面自动跑): this module is pure — it has no side effects and issues no fetch of its
// own, so it cannot violate D6 regardless of when or how often it is called. The manual-trigger
// discipline lives entirely in the VIEW that owns the button.
//
// G5 「地图不是闸机」: nothing here computes a boolean that DISABLES an action. Every badge is prose,
// never a gate — the wizard's own buttons (in the .vue) are enabled purely by permission + busy state,
// completely independent of what this module returns.
import type { StockPrepDataSourceRegistryState } from './dataSourceRegistry'
import type { StockPreparationPreflight, StockPreparationPreflightBlocker } from './installPlan'
import type { StockPrepOnboardingReadinessState } from './onboardingReadiness'
import type { StockPrepSourcePreflight } from './sourcePreflight'

// ---------------------------------------------------------------------------
// The seven steps
// ---------------------------------------------------------------------------

export type StockPrepGettingStartedStepKey =
  /**
   * (1a) 登记外接数据源. SPLIT OUT OF THE OLD (1) (2026-09-10). 整合切片 put 外接数据源 and the
   * connection-draft editor in the SAME 数据工厂 section, which left one step describing two acts
   * with two different controls, two different destinations, and two different reads behind them.
   */
  | 'source-register'
  /** (1b) 在数据工厂新增 SQL 绑定. The old (1)'s key and the old (1)'s evidence, kept where they belong. */
  | 'source-connect'
  | 'source-verify'
  | 'source-bind'
  | 'install-tables'
  | 'grant-access'
  | 'first-project-run'

export const STOCK_PREP_GETTING_STARTED_STEP_ORDER: readonly StockPrepGettingStartedStepKey[] = Object.freeze([
  'source-register',
  'source-connect',
  'source-verify',
  'source-bind',
  'install-tables',
  'grant-access',
  'first-project-run',
])

export const STOCK_PREP_GETTING_STARTED_STEP_LABEL: Record<StockPrepGettingStartedStepKey, { zh: string; en: string }> = Object.freeze({
  'source-register': Object.freeze({ zh: '①a 登记外接数据源', en: '(1a) Register the external data source' }),
  'source-connect': Object.freeze({ zh: '①b 在数据工厂新增 SQL 绑定', en: '(1b) Add the SQL binding in Data Factory' }),
  'source-verify': Object.freeze({ zh: '证明它只能读', en: 'Prove it can only read' }),
  'source-bind': Object.freeze({ zh: '告诉备料用这条源', en: 'Tell stock-prep to use this source' }),
  'install-tables': Object.freeze({ zh: '建表 + 装列', en: 'Create tables and install columns' }),
  'grant-access': Object.freeze({ zh: '谁能用', en: 'Who can use it' }),
  'first-project-run': Object.freeze({ zh: '拿一个项目跑一遍', en: 'Run one project through it' }),
})

// ---------------------------------------------------------------------------
// The badge vocabulary — six states, one pure function, no per-step reinvention.
// ---------------------------------------------------------------------------

export type StockPrepGettingStartedBadgeKey =
  | 'done'
  | 'pending_items'
  | 'not_checked'
  | 'held'
  | 'unknown'
  | 'blocked'

export interface StockPrepGettingStartedBadgeText {
  zh: string
  en: string
  /** A `--ms-color-*` token family name, never a raw hex — the view maps this to the class it applies. */
  tone: 'success' | 'info' | 'muted' | 'warning' | 'danger'
  glyph: string
}

/**
 * The six badges. `unknown` is THE THIRD STATE (G4): a 403 on the read that would answer a step means
 * the page genuinely cannot tell whether the step is done, and rendering that as 「还没开始」 would be
 * a claim nobody can back — the same discipline `StockPrepSourceCheckRow.unknown` already established
 * for the source-preflight rows below this wizard on the same page.
 */
export const STOCK_PREP_GETTING_STARTED_BADGE: Record<StockPrepGettingStartedBadgeKey, StockPrepGettingStartedBadgeText> = Object.freeze({
  done: Object.freeze({ zh: '已完成', en: 'Done', tone: 'success', glyph: '✔' }),
  // §4.4 wireframe B renders this cell as 「◐ 还差 2 件事」, never 「进行中」: at the moment a
  // preflight comes back with only page-fixable blockers, NOTHING is running — there is simply work
  // left that this page's own button can do. The count itself rides in the evidence column below.
  pending_items: Object.freeze({ zh: '还差几件事', en: 'A few things left', tone: 'warning', glyph: '◐' }),
  // G4's THIRD-STATE PAIR, and they are NOT the same state. `not_checked` = a manual probe nobody has
  // run yet (§4.4 「ⓘ 未检查」); `unknown` = a read that was attempted and could not be answered
  // for this caller (§4.4 「? 看不到」). Neither is green, neither is red, and neither is
  // 「还没开始」 — the word this vocabulary deliberately no longer contains, because a deployment
  // that has been running for months would have been described by it every single time.
  not_checked: Object.freeze({ zh: '未检查', en: 'Not checked', tone: 'info', glyph: 'ⓘ' }),
  held: Object.freeze({ zh: '需要别人做', en: 'Needs someone else', tone: 'warning', glyph: '⚑' }),
  unknown: Object.freeze({ zh: '? 看不到', en: '? Cannot tell', tone: 'muted', glyph: '?' }),
  blocked: Object.freeze({ zh: '卡住了', en: 'Blocked', tone: 'danger', glyph: '✖' }),
})

// ---------------------------------------------------------------------------
// The fix.kind split (I-8/I-9) — restated as a query over F8's existing field, never reinvented.
// ---------------------------------------------------------------------------

/**
 * True when a blocker needs a human on the DEPLOYMENT MACHINE, never a button on this page.
 * `installRun.ts`'s `classifyPreflightStep` makes the identical judgement call server-response-side
 * (`blocker.fix?.kind !== 'http'`); this restates it as a named predicate rather than importing that
 * function's internal branch, because the wizard needs the per-blocker verdict, not the step tally.
 */
export function stockPrepBlockerNeedsDeploymentData(blocker: StockPreparationPreflightBlocker): boolean {
  return blocker.fix?.kind !== 'http'
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * WHAT THE SOURCE-BINDING ROUTE ALREADY ANSWERED, projected to the two fields steps ① and ③ are
 * about. This is the SAME envelope `StockPreparationSourceBindingPanel.vue` reads a few hundred
 * pixels further down the same page — the wizard is handed the panel's answer rather than deriving a
 * second opinion out of the source preflight's topology check, which is about a different question
 * (does the DETECTED bridge match the CONFIGURED one) and answers 「备料用哪条源」 only by accident.
 * R7 restated: project what the server said; never re-derive it from an adjacent field.
 *
 * `null` means NO ANSWER EXISTS on this page right now — the read has not returned, failed, or was
 * never attempted because this caller may not run it. That is `unknown`, never 「没做」.
 */
export interface StockPrepGettingStartedBinding {
  /** The source 备料 will actually read from, as the server resolved it. */
  effectiveExternalSystemId: string | null
  /** How many read-only connections the server considers eligible. Server-filtered, never counted here. */
  eligibleSourceCount: number
  /**
   * How many of those eligible connections are the DATA-SOURCE-BACKED kind
   * (`data-source:sql-readonly`) — the kind 数据工厂's 「新增连接草稿」 produces, which carries a
   * `connectionId` into `data_sources` rather than its own host and credentials.
   *
   * A SUBSET of `eligibleSourceCount`, never a separate population, and NOT what (1b)'s badge is
   * computed from. The server narrows `eligibleSources` to the ACTION's own frozen `source.kind`
   * (`listEligibleSources(..., { requiredKind })`), and the other BOM read kind
   * (`bridge:legacy-sql-readonly`) is a legitimate, working configuration. Badging (1b) off this
   * number alone would report 「没完成」 to a deployment whose legacy bridge has been feeding the
   * floor for months — 「叫人去做一件已经做完的事」, the one answer this map must never produce.
   * So the badge reads `eligibleSourceCount`, and this number rides in the EVIDENCE line, which is
   * where 「走的是哪条路」 belongs.
   */
  dataSourceBackedSourceCount: number
}

/**
 * WHAT THE DATA-SOURCE REGISTRY READ ANSWERED, projected to the two fields step (1a) is about.
 *
 * DELIBERATELY NOT DERIVED FROM `binding`. `eligibleSources` enumerates external SYSTEMS — the
 * bindings — not the data sources behind them, so an empty list is SILENT about whether a data
 * source is registered: a deployment can hold a perfectly good SQL Server and simply not have wired
 * a binding to it yet. Reading that silence as 「还没登记」 is exactly the false-negative R7 forbids.
 *
 * `null` means NO ANSWER EXISTS on this page right now — the read has not returned, failed, or was
 * never attempted. That is `unknown`, never 「没做」.
 */
export interface StockPrepGettingStartedRegistry {
  /** The service's already-decided verdict. Nothing here re-decides it. */
  state: StockPrepDataSourceRegistryState
  /** How many visible sources are of a SQL type. An integer — never a name, never an id. */
  sqlCount: number
}

export interface StockPrepGettingStartedInput {
  preflight: StockPreparationPreflight | null
  /**
   * Non-null on a DEPLOYMENT-PREFLIGHT read failure and nothing else — not the manifest read, not the
   * install run. ANY non-null value means this page asked and did not get an answer, which is
   * `unknown` (G4「看不到」≠「没完成」); only 403 used to qualify, which painted a 500 red.
   */
  preflightErrorStatus: number | null
  sourcePreflight: StockPrepSourcePreflight | null
  /** Non-null on a source-preflight read failure — same rule as above: any status means `unknown`. */
  sourcePreflightErrorStatus: number | null
  /** The source-binding panel's own answer, or `null` when this page has none. */
  binding: StockPrepGettingStartedBinding | null
  /**
   * 第(1a)步的真实检测结果 (`dataSourceRegistry.ts`), or `null` while the read is still in
   * flight / was never started. `null` and a `'unknown'` state are the same thing to this module —
   * 「本页判断不了」 — and both render 「? 看不到」.
   */
  dataSourceRegistry: StockPrepGettingStartedRegistry | null
  /**
   * 第⑤步的真实检测结果 (P1-3), or `null` while the read is still in flight / was never started.
   *
   * `null` is NOT a fourth verdict — it is the first-paint state, and it maps to the same `held` this
   * step reported for its whole static life, so the map never flickers through a claim on its way to
   * an answer. The four real values map straight through: 就绪 → `done`; 有角色没人 / 没有这样的角色 →
   * `held` (work that exists and is somebody's — never `blocked`, because G5 says this map is not a
   * gate and nothing downstream is stopped by it); 读不到 → `unknown` (G4「看不到」≠「没完成」).
   */
  roleReadiness: StockPrepOnboardingReadinessState | null
}

export type StockPrepGettingStartedSteps = Record<StockPrepGettingStartedStepKey, StockPrepGettingStartedBadgeKey>

/**
 * THE DERIVATION. Every branch reads a field the server already answered; nothing here re-probes or
 * guesses. ① and ③ come from the source-binding envelope (see `StockPrepGettingStartedBinding`); ②
 * and ④ come from the two manual preflights and read `not_checked` until somebody runs them — a
 * deployment that has been serving the floor for months is 「未检查」 on those two, not 「还没开始」.
 * ⑤ now reads the platform role catalog for real (P1-3, `onboardingReadiness.ts`) and ⑥ still has no
 * derivable signal in P0/P1 (the project-sync panel is not embedded here yet), so ⑥ reads `held`:
 * work that exists and is somebody's, which this page does not claim to have observed.
 */
export function stockPrepGettingStartedSteps(input: StockPrepGettingStartedInput): StockPrepGettingStartedSteps {
  const {
    preflight,
    preflightErrorStatus,
    sourcePreflight,
    sourcePreflightErrorStatus,
    binding,
    dataSourceRegistry,
    roleReadiness,
  } = input

  // (1a) — the data-source registry read, and nothing else. `null` (in flight / never started) and
  // `'unknown'` (403 for a caller holding no `data_sources:read`, a 500, a shape this page does not
  // recognise) are the same answer: 「本页判断不了」. `'absent'` IS an answer — the list was read
  // and holds no relational source — and it is `held`, because registering one is somebody's work
  // behind a control on another page, never 「卡住了」.
  const sourceRegister: StockPrepGettingStartedBadgeKey = dataSourceRegistry === null || dataSourceRegistry.state === 'unknown'
    ? 'unknown'
    : dataSourceRegistry.state === 'present'
      ? 'done'
      : 'held'

  // (1b)(3) — the binding envelope, or no answer at all.
  const sourceConnect: StockPrepGettingStartedBadgeKey = binding === null
    ? 'unknown'
    : binding.eligibleSourceCount > 0
      ? 'done'
      : 'held'

  const sourceBind: StockPrepGettingStartedBadgeKey = binding === null
    ? 'unknown'
    : typeof binding.effectiveExternalSystemId === 'string' && binding.effectiveExternalSystemId.length > 0
      ? 'done'
      : 'held'

  // ② — a MANUAL probe (D6: it reads the customer's database and never runs on page load).
  const sourceUnknown = sourcePreflightErrorStatus !== null
  const sourceNotRun = sourcePreflight === null && sourcePreflightErrorStatus === null
  const sourceVerify: StockPrepGettingStartedBadgeKey = sourceUnknown
    ? 'unknown'
    : sourceNotRun
      ? 'not_checked'
      : sourcePreflight && sourcePreflight.verdict === 'go'
        ? 'done'
        : 'blocked'

  // ④ — the other manual probe, plus the one step this page can actually drive.
  const installUnknown = preflightErrorStatus !== null
  const installNotRun = preflight === null && preflightErrorStatus === null
  const blockers = Array.isArray(preflight?.blockers) ? (preflight!.blockers as StockPreparationPreflightBlocker[]) : []
  const installTables: StockPrepGettingStartedBadgeKey = installUnknown
    ? 'unknown'
    : installNotRun
      ? 'not_checked'
      : preflight && preflight.ready === true
        ? 'done'
        : (blockers.length > 0 && blockers.every((blocker) => !stockPrepBlockerNeedsDeploymentData(blocker))
          ? 'pending_items'
          : 'blocked')

  // ⑤ — the platform role catalog's answer, projected. Nothing here re-decides anything: the service
  // already applied the gate's ladder and already collapsed every unanswerable read into `unknown`.
  //
  // WHY `ready` IS NOT `done`, AND WILL NOT BE. 「谁能用」 is a CONJUNCTION OF THREE conditions: a
  // role that satisfies the gate, a person inside it, and — per user — an enabled `stock-prep` row
  // in `user_namespace_admissions` (用户管理 →「插件使用」). The catalog read answers the first two
  // and CANNOT SEE the third: `assignUserRoles` writes `user_roles` alone, and the only caller of
  // `grantNamespaceAdmissions` is the user-creation path, so adding an existing person to a
  // correctly-configured role leaves them at a flat 403 with this page showing a ✔.
  // 「已完成」 on two legs out of three is exactly the 假绿 G4 forbids, so this step's badge tops out
  // at 「⚑ 需要别人做」 — there is a third thing, off this page, that someone still has to have done.
  // The card underneath says which thing, and still shows ✔ for the part that WAS verified (验收 4).
  const grantAccess: StockPrepGettingStartedBadgeKey = roleReadiness === 'unknown' ? 'unknown' : 'held'

  return {
    'source-register': sourceRegister,
    'source-connect': sourceConnect,
    'source-verify': sourceVerify,
    'source-bind': sourceBind,
    'install-tables': installTables,
    'grant-access': grantAccess,
    // P0: no embedded project-sync panel yet, so no signal exists to flip this off `held`.
    'first-project-run': 'held',
  }
}

/**
 * 进度 N/7 (wireframe B's header, one row longer since (1) became (1a) + (1b)). Only `done` counts — `not_checked`, `unknown` and `held` are all
 * 「we do not know / not ours」 and none of them is progress. Narrative only: nothing gates on it.
 */
export function stockPrepGettingStartedProgress(steps: StockPrepGettingStartedSteps): { done: number; total: number } {
  return {
    done: STOCK_PREP_GETTING_STARTED_STEP_ORDER.filter((key) => steps[key] === 'done').length,
    total: STOCK_PREP_GETTING_STARTED_STEP_ORDER.length,
  }
}

/**
 * The right-hand evidence column of wireframe B — WHY a badge reads what it reads, in the smallest
 * number of words, sourced from the same envelopes the badge came from. `null` = no evidence exists
 * yet, and the row renders the badge alone rather than an invented sentence.
 */
export function stockPrepGettingStartedEvidence(
  key: StockPrepGettingStartedStepKey,
  input: StockPrepGettingStartedInput,
): { zh: string; en: string } | null {
  // (1a) — counts only, straight off the registry projection. `unknown` and `null` deliberately
  // return no evidence: the badge already says 「? 看不到」, and a sentence under it would be this
  // page claiming to know why. The wording says 「本账号看得到」 rather than 「这台机器上有」
  // because the list is owner-scoped (#5401): 0 means this account sees none, not that none exists.
  if (key === 'source-register' && input.dataSourceRegistry && input.dataSourceRegistry.state !== 'unknown') {
    const n = input.dataSourceRegistry.sqlCount
    return n > 0
      ? { zh: `本账号看得到 ${n} 个数据库连接`, en: `${n} database connection(s) visible to this account` }
      : { zh: '本账号还看不到数据库类型的数据源', en: 'No database-type data source visible to this account yet' }
  }
  if (key === 'source-connect' && input.binding) {
    const n = input.binding.eligibleSourceCount
    if (n === 0) return { zh: '还没有可选的绑定', en: 'No binding to choose from yet' }
    // WHICH ROAD, said out loud. `m === 0` is a deployment running its BOM reads through the legacy
    // bridge rather than through a registered data source — a working configuration, and one an
    // administrator following this wizard's (1a)/(1b) wording would otherwise think they had failed
    // to set up.
    const m = input.binding.dataSourceBackedSourceCount
    return m > 0
      ? { zh: `已登记 ${n} 条,其中 ${m} 条走外接数据源`, en: `${n} registered, ${m} of them backed by a data source` }
      : { zh: `已登记 ${n} 条(都是旧式桥接,不经外接数据源)`, en: `${n} registered (all legacy bridges — none backed by a data source)` }
  }
  if (key === 'source-bind' && input.binding) {
    return input.binding.effectiveExternalSystemId
      ? { zh: '已绑定', en: 'Bound' }
      : { zh: '还没选用哪一条', en: 'None chosen yet' }
  }
  // ⑤ — counts only, straight off the projection. `unknown` and `null` deliberately return no
  // evidence: the badge already says 「? 看不到」/「需要别人做」, and inventing a sentence under it
  // would be this page claiming to know why.
  if (key === 'grant-access' && input.roleReadiness !== null) {
    if (input.roleReadiness === 'ready') return { zh: '有角色,有人', en: 'Role exists, has members' }
    if (input.roleReadiness === 'no_members') return { zh: '有角色,还没放人', en: 'Role exists, nobody in it' }
    if (input.roleReadiness === 'no_role') return { zh: '还没有这样的角色', en: 'No such role yet' }
    return null
  }
  if (key === 'install-tables' && input.preflightErrorStatus === null && input.preflight) {
    const count = Array.isArray(input.preflight.blockers) ? input.preflight.blockers.length : 0
    return count > 0
      ? { zh: `还差 ${count} 件事`, en: `${count} thing(s) left` }
      : { zh: '都齐了', en: 'All in place' }
  }
  return null
}
