// 状态徽标 (P0-6) — ONE pure function, three call sites.
//
// 设计稿 §4.4 "状态徽标(一个纯函数,三处同色同词)": the home card, the workspace title, and the
// composed sync panel's own status line must never invent their own wording for the same fact. Before
// this file each surface would have grown its own `if (pending > 0) …` and the first typo between them
// would have been invisible until someone actually compared two screens side by side. This module is
// the single source those three call sites read instead — see StockPreparationOperatorHome.vue,
// StockPreparationProjectBoardView.vue (workspace title) and StockPreparationProjectSyncPanel.vue.
//
// VALUES-FREE. Every field this module accepts is a count or a boolean, never a part number, a
// quantity, or a person's name. The rendered `zh`/`en` strings below fold at most ONE of those counts
// into a sentence ("等您拿主意 2 件") — the count itself is not a "数量" in the guardrail's sense (a
// business quantity off a BOM line); it is how many decisions/parts are outstanding, the same kind of
// number `board.pendingDecisionCount` already renders elsewhere on this page today.
//
// SCOPE. Table §4.4 lists ten badges; the seven below are the ones the P0 call sites can reach (home
// card, workspace title, sync-panel status line, and the stepper's 第④步 ⊘不归您做). The remaining
// three — 未检查 / 未接入监控 / 需要别人做 — belong to the install wizard and the ops/health panel,
// both P1/out of scope for this pass.
//
// WHY `unknown` EXISTS (G4 诚实态). The operator project directory carries an ARCHIVE's line counts,
// written by the platform-admin `mvp-persist` surface — never the live pull target (F1). A directory
// row with no pending decisions therefore says NOTHING about whether rows were pulled: reading it as
// 「还没拉过」 or as 「可以导出」 are both fabrications, in opposite directions. `unknown` is §4.4's
// `? 看不到` third state for exactly that: not green, not grey-meaning-empty, just "this screen
// cannot see it from here". See operatorHomeCards.ts for the one place that asks for it.

export type StockPrepPostureKey =
  | 'pending_decision' // 🟠 等您拿主意 N 件
  | 'blocked' // 🔴 卡住了:缺件 N 种
  | 'running' // 🔵 正在跑
  | 'ready' // 🟢 可以导出 / 已就绪
  | 'not_pulled' // ⚪ 还没拉过
  | 'unknown' // ? 看不到 — 这一屏拿不到判断依据(§4.4 第三态,G4)
  | 'not_yours' // ⊘ 不归您做 — stepper 第④步(存档),对一线恒为此

export type StockPrepPostureTone = 'warning' | 'danger' | 'primary' | 'success' | 'neutral' | 'info'

export interface StockPrepPosture {
  key: StockPrepPostureKey
  zh: string
  en: string
  /** Maps 1:1 to a `--ms-color-*` token at the call site: warning/danger/primary/success/info, or
   *  `neutral` for the one badge (还没拉过) design deliberately keeps OFF the semantic palette. */
  tone: StockPrepPostureTone
}

export interface StockPrepPostureInput {
  /** A sync run is in flight right now — takes priority over every count below. */
  busy?: boolean
  /** Rows in the confirmation ledger still waiting on a human, for this project. */
  pendingDecisionCount?: number
  /** Distinct missing parts the latest dry-run/report found; 0 when none or unknown. */
  missingComponentsCount?: number
  /** Rows already written into the sheet for this project; 0/absent = never pulled. */
  pulledRowCount?: number
  /** Step-4-only override: on this deployment archiving is never the operator's job. */
  notYours?: boolean
  /**
   * THIS SCREEN CANNOT SEE the pull state at all — not "it is zero", not "it is fine". Set by the
   * home page's directory branch, whose row carries an archive's counts rather than the live pull
   * target (F1). Ranked below the two counts that ARE trustworthy on such a row, and above every
   * branch that would have to guess.
   */
  progressUnknown?: boolean
}

const NOT_YOURS: StockPrepPosture = Object.freeze({
  key: 'not_yours',
  zh: '不归您做',
  en: 'Not yours to do',
  tone: 'info',
})

const RUNNING: StockPrepPosture = Object.freeze({
  key: 'running',
  zh: '正在跑',
  en: 'Running',
  tone: 'primary',
})

const UNKNOWN: StockPrepPosture = Object.freeze({
  key: 'unknown',
  zh: '看不到进度',
  en: 'Progress not visible',
  tone: 'neutral',
})

const NOT_PULLED: StockPrepPosture = Object.freeze({
  key: 'not_pulled',
  zh: '还没拉过',
  en: 'Not pulled yet',
  tone: 'neutral',
})

const READY: StockPrepPosture = Object.freeze({
  key: 'ready',
  zh: '可以导出',
  en: 'Ready to export',
  tone: 'success',
})

/**
 * THE one function every posture badge on the P0 surfaces calls.
 *
 * PRIORITY ORDER, AND WHERE IT DEPARTS FROM §4.4's TABLE ORDER. The table lists 正在跑 third, after
 * the two count-bearing badges; this function checks `busy` SECOND, before them. That is deliberate
 * and it is the only departure: `busy` is the one input that can be true simultaneously with any
 * count, and while a run is in flight every count on screen is the PREVIOUS run's. Saying 「正在跑」
 * over a stale number is honest; saying 「等您拿主意 2 件」 while a sync is actively changing that 2
 * is not. `notYours` is checked first because it is a hard override, not a state. Below `busy` the
 * branches are mutually exclusive by construction (ready requires `pulledRowCount > 0`), so their
 * relative order is documentation rather than behaviour.
 */
export function stockPrepPosture(input: StockPrepPostureInput): StockPrepPosture {
  if (input.notYours) return NOT_YOURS
  if (input.busy) return RUNNING
  const pending = input.pendingDecisionCount ?? 0
  if (pending > 0) {
    return {
      key: 'pending_decision',
      zh: `等您拿主意 ${pending} 件`,
      en: `${pending} waiting on your decision`,
      tone: 'warning',
    }
  }
  const missing = input.missingComponentsCount ?? 0
  if (missing > 0) {
    return {
      key: 'blocked',
      zh: `卡住了:缺件 ${missing} 种`,
      en: `Blocked: ${missing} missing part(s)`,
      tone: 'danger',
    }
  }
  if (input.progressUnknown) return UNKNOWN
  const pulled = input.pulledRowCount ?? 0
  if (pulled > 0) return READY
  return NOT_PULLED
}
