// BOM备料 接入向导「开始使用」— 六步地图的纯派生逻辑 (P0-4).
//
// ARCHITECTURE: this module invents NO new read. Every badge below is derived from data the install
// page already fetches through EXISTING calls (the manifest, the deployment preflight, the source
// preflight) — the six-step map is a NARRATIVE layer over state `StockPreparationInstallView.vue`
// already owns, passed down as props. R7 (design §8.1): "每一步判定只用服务端答的字段,不在前端二次
// 推导" — this file only RE-READS fields the server already decided (`preflight.ready`,
// `sourcePreflight.verdict`, `blocker.fix.kind`), it never invents a second opinion about readiness.
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
  | 'in_progress'
  | 'not_started'
  | 'held'
  | 'unknown'
  | 'blocked'

export interface StockPrepGettingStartedBadgeText {
  zh: string
  en: string
  /** A `--ms-color-*` token family name, never a raw hex — the view maps this to the class it applies. */
  tone: 'success' | 'primary' | 'muted' | 'warning' | 'danger'
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
  in_progress: Object.freeze({ zh: '进行中', en: 'In progress', tone: 'primary', glyph: '◐' }),
  not_started: Object.freeze({ zh: '还没开始', en: 'Not started yet', tone: 'muted', glyph: '○' }),
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

export interface StockPrepGettingStartedInput {
  preflight: StockPreparationPreflight | null
  /** Non-null only on a read FAILURE (manifest or deployment-preflight); 403 is what flips to `unknown`. */
  preflightErrorStatus: number | null
  sourcePreflight: StockPrepSourcePreflight | null
  /** Non-null only on a source-preflight read failure. */
  sourcePreflightErrorStatus: number | null
}

export type StockPrepGettingStartedSteps = Record<StockPrepGettingStartedStepKey, StockPrepGettingStartedBadgeKey>

/**
 * THE DERIVATION. Every branch reads a field the server already answered; nothing here re-probes or
 * guesses. Steps ①③⑤⑥ are, in P0, HELD by construction (§14/design line 236-244: none of the four is
 * driven from this page in this wave) — ① and ③ flip to `done` only once evidence from a source
 * preflight the OPERATOR already ran (elsewhere on this same page) says so; ⑤ is fully static in P0
 * (no live role check — that is P1-3) and always reads `held`; ⑥ has no derivable signal in P0 (the
 * project-sync panel is not embedded here yet — that is a later wave) and always reads `held` too.
 */
export function stockPrepGettingStartedSteps(input: StockPrepGettingStartedInput): StockPrepGettingStartedSteps {
  const { preflight, preflightErrorStatus, sourcePreflight, sourcePreflightErrorStatus } = input

  const sourceUnknown = sourcePreflightErrorStatus === 403
  const sourceNotRun = sourcePreflight === null && sourcePreflightErrorStatus === null

  const sourceConnect: StockPrepGettingStartedBadgeKey = sourceUnknown
    ? 'unknown'
    : sourcePreflight && typeof sourcePreflight.externalSystemId === 'string' && sourcePreflight.externalSystemId.length > 0
      ? 'done'
      : 'held'

  const sourceVerify: StockPrepGettingStartedBadgeKey = sourceUnknown
    ? 'unknown'
    : sourceNotRun
      ? 'not_started'
      : sourcePreflight && sourcePreflight.verdict === 'go'
        ? 'done'
        : 'blocked'

  const sourceBind: StockPrepGettingStartedBadgeKey = sourceUnknown
    ? 'unknown'
    : sourcePreflight && sourcePreflight.verdict === 'go' && sourcePreflight.checks?.topology?.matchesConfigured === true
      ? 'done'
      : 'held'

  const installUnknown = preflightErrorStatus === 403
  const installNotRun = preflight === null && preflightErrorStatus === null
  const blockers = Array.isArray(preflight?.blockers) ? (preflight!.blockers as StockPreparationPreflightBlocker[]) : []
  const installTables: StockPrepGettingStartedBadgeKey = installUnknown
    ? 'unknown'
    : installNotRun
      ? 'not_started'
      : preflight && preflight.ready === true
        ? 'done'
        : (blockers.length > 0 && blockers.every((blocker) => !stockPrepBlockerNeedsDeploymentData(blocker))
          ? 'in_progress'
          : 'blocked')

  return {
    'source-connect': sourceConnect,
    'source-verify': sourceVerify,
    'source-bind': sourceBind,
    'install-tables': installTables,
    // P0: static, no live probe (line B2). Always 「需要别人做」 — never done, never unknown, never a
    // claim this page cannot back. Real detection is P1-3.
    'grant-access': 'held',
    // P0: no embedded project-sync panel yet, so no signal exists to flip this off `held`.
    'first-project-run': 'held',
  }
}

/** Derived readiness for the whole six-step map: every step reads `done`. Narrative only — see G5. */
export function stockPrepGettingStartedAllDone(steps: StockPrepGettingStartedSteps): boolean {
  return STOCK_PREP_GETTING_STARTED_STEP_ORDER.every((key) => steps[key] === 'done')
}
