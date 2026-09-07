// BOM备料 接入向导「开始使用」— 六步地图的纯派生逻辑 (P0-4).
//
// ARCHITECTURE: this module invents NO new read. Every badge below is derived from data the install
// page already fetches through EXISTING calls (the manifest, the deployment preflight, the source
// preflight, the source binding) — the six-step map is a NARRATIVE layer over state
// `StockPreparationInstallView.vue` already owns, passed down as props. R7 (design §8.1):
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
import type { StockPreparationPreflight, StockPreparationPreflightBlocker } from './installPlan'
import type { StockPrepSourcePreflight } from './sourcePreflight'

// ---------------------------------------------------------------------------
// The six steps
// ---------------------------------------------------------------------------

export type StockPrepGettingStartedStepKey =
  | 'source-connect'
  | 'source-verify'
  | 'source-bind'
  | 'install-tables'
  | 'grant-access'
  | 'first-project-run'

export const STOCK_PREP_GETTING_STARTED_STEP_ORDER: readonly StockPrepGettingStartedStepKey[] = Object.freeze([
  'source-connect',
  'source-verify',
  'source-bind',
  'install-tables',
  'grant-access',
  'first-project-run',
])

export const STOCK_PREP_GETTING_STARTED_STEP_LABEL: Record<StockPrepGettingStartedStepKey, { zh: string; en: string }> = Object.freeze({
  'source-connect': Object.freeze({ zh: '接一条只读连接', en: 'Connect a read-only source' }),
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
}

export type StockPrepGettingStartedSteps = Record<StockPrepGettingStartedStepKey, StockPrepGettingStartedBadgeKey>

/**
 * THE DERIVATION. Every branch reads a field the server already answered; nothing here re-probes or
 * guesses. ① and ③ come from the source-binding envelope (see `StockPrepGettingStartedBinding`); ②
 * and ④ come from the two manual preflights and read `not_checked` until somebody runs them — a
 * deployment that has been serving the floor for months is 「未检查」 on those two, not 「还没开始」.
 * ⑤ is fully static in P0 (no live role check — that is P1-3) and ⑥ has no derivable signal in P0
 * (the project-sync panel is not embedded here yet), so both read `held`: work that exists and is
 * somebody's, which this page does not claim to have observed.
 */
export function stockPrepGettingStartedSteps(input: StockPrepGettingStartedInput): StockPrepGettingStartedSteps {
  const { preflight, preflightErrorStatus, sourcePreflight, sourcePreflightErrorStatus, binding } = input

  // ①③ — the binding envelope, or no answer at all.
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

  return {
    'source-connect': sourceConnect,
    'source-verify': sourceVerify,
    'source-bind': sourceBind,
    'install-tables': installTables,
    // P0: static, no live probe (line B2). Never done, never unknown — a claim this page cannot back.
    'grant-access': 'held',
    // P0: no embedded project-sync panel yet, so no signal exists to flip this off `held`.
    'first-project-run': 'held',
  }
}

/**
 * 进度 N/6 (wireframe B's header). Only `done` counts — `not_checked`, `unknown` and `held` are all
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
  if (key === 'source-connect' && input.binding) {
    const n = input.binding.eligibleSourceCount
    return n > 0
      ? { zh: `已登记 ${n} 条`, en: `${n} registered` }
      : { zh: '还没有可用的连接', en: 'No usable connection yet' }
  }
  if (key === 'source-bind' && input.binding) {
    return input.binding.effectiveExternalSystemId
      ? { zh: '已绑定', en: 'Bound' }
      : { zh: '还没选用哪一条', en: 'None chosen yet' }
  }
  if (key === 'install-tables' && input.preflightErrorStatus === null && input.preflight) {
    const count = Array.isArray(input.preflight.blockers) ? input.preflight.blockers.length : 0
    return count > 0
      ? { zh: `还差 ${count} 件事`, en: `${count} thing(s) left` }
      : { zh: '都齐了', en: 'All in place' }
  }
  return null
}
