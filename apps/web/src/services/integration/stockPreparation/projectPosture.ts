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
// SCOPE. Table §4.4 lists ten badges; only the six below apply to the three P0 call sites (home card,
// workspace title, sync-panel status line). The remaining four — 未检查/看不到/未接入监控/需要别人做 —
// belong to the install wizard and the ops/health panel, both P1/out of scope for this pass.

export type StockPrepPostureKey =
  | 'pending_decision' // 🟠 等您拿主意 N 件
  | 'blocked' // 🔴 卡住了:缺件 N 种
  | 'running' // 🔵 正在跑
  | 'ready' // 🟢 可以导出 / 已就绪
  | 'not_pulled' // ⚪ 还没拉过
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
 * THE one function every posture badge on the P0 surfaces calls. Priority order matches §4.4's own
 * reading order — a project that is both "还没拉过" and would-be "可以导出" is impossible by
 * construction (ready requires `pulledRowCount > 0`), so the branches below never actually compete for
 * the same input; the order still matters for `busy`, which can be true alongside any count.
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
  const pulled = input.pulledRowCount ?? 0
  if (pulled > 0) return READY
  return NOT_PULLED
}
