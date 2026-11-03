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
  | 'archived' // 已归档 — 项目表的登记行已归档(ADR adr-stock-prep-project-sheets-20261008 §5 「状态」,S3)
  | 'blocked_pull_state' // 批量刷新第 4 步 PR-5:刷新状态未完成或读不到(待确认 / 已确认待执行 / 正在写入 / 上次写入未完成 / 已执行待核对 / 变更待复核 / 状态读取失败),正式导出被服务端拒绝,永远不是「可以导出」

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
  /**
   * S3 (ADR §5 「状态」, register R-37): the project's sheet is ARCHIVED in the server's registry.
   * Checked FIRST, before every other input — 「已归档」 wins over a pending count, a missing part
   * and even a run in flight, exactly as the server-side mirror (`projectOverviewPosture` in
   * plugins/plugin-integration-core/lib/stock-preparation-project-overview.cjs) ranks it; the
   * cross-language mirror block in StockPreparationProjectOverview.spec.ts drives both with the same
   * inputs. Only a registry row can set it (the directory's `archived`); nothing remembers it.
   */
  archived?: boolean
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
  /**
   * Batch-refresh step 4 PR-5 (design §11; plan §5.3 U01): the project's derived REFRESH STATE token as
   * the server's board `refresh.status` / overview row carries it (`not_governed`, `complete`,
   * `pending_confirmation`, `confirmed_pending_execution`, `executing`, `failed_pending_recovery`,
   * `executed_pending_settlement`, `change_pending_review`, `unreadable`). Any token other than
   * `not_governed` or a SETTLED `complete` is `blocked_pull_state` — checked before 「可以导出」 / 「还没拉过」
   * and after the two count badges, exactly as the server mirror `projectOverviewPosture` ranks it
   * (plugins/plugin-integration-core/lib/stock-preparation-project-overview.cjs; the PO-MIRROR spec drives
   * both). Absent: the pre-PR-5 posture (a caller that has no state to show).
   */
  refreshStatus?: string
  /** PR-5: the derived state's `settled`. A `complete` that is not settled is 「待核对」, never 「可以导出」 (fail closed). */
  refreshSettled?: boolean
  /** PR-5: the derived counts.pendingConfirm, folded into 「待确认 N 件」. */
  refreshPendingConfirmCount?: number
}

// PR-5: the words of every blocked refresh state — WORD FOR WORD the server's REFRESH_BLOCKED_TEXT.
type BlockedRefreshText = { zh: (n: number) => string; en: (n: number) => string; tone: StockPrepPostureTone }
const REFRESH_BLOCKED_TEXT: Readonly<Record<string, BlockedRefreshText>> = Object.freeze({
  pending_confirmation: { zh: (n) => (n > 0 ? `待确认 ${n} 件` : '待确认'), en: (n) => (n > 0 ? `Awaiting confirmation (${n})` : 'Awaiting confirmation'), tone: 'warning' },
  confirmed_pending_execution: { zh: () => '已确认待执行', en: () => 'Confirmed, awaiting execution', tone: 'warning' },
  executing: { zh: () => '正在写入', en: () => 'Writing now', tone: 'primary' },
  failed_pending_recovery: { zh: () => '上次写入未完成', en: () => 'Last write unfinished', tone: 'danger' },
  executed_pending_settlement: { zh: () => '已执行待核对', en: () => 'Executed, awaiting check', tone: 'warning' },
  change_pending_review: { zh: () => '变更待复核', en: () => 'Change awaiting review', tone: 'warning' },
  unreadable: { zh: () => '状态读取失败', en: () => 'Refresh state unreadable', tone: 'danger' },
  unsettled: { zh: () => '待核对', en: () => 'Awaiting check', tone: 'warning' },
  unknown: { zh: () => '刷新未完成', en: () => 'Refresh unfinished', tone: 'warning' },
})

function refreshBlockedPosture(input: StockPrepPostureInput): StockPrepPosture | null {
  const status = input.refreshStatus
  if (status === undefined || status === null) return null
  if (status === 'not_governed') return null
  if (status === 'complete' && input.refreshSettled === true) return null
  const token = status === 'complete' ? 'unsettled' : (Object.prototype.hasOwnProperty.call(REFRESH_BLOCKED_TEXT, status) ? status : 'unknown')
  const text = REFRESH_BLOCKED_TEXT[token]
  const raw = input.refreshPendingConfirmCount
  const n = Number.isInteger(raw) && (raw as number) >= 0 ? (raw as number) : 0
  return { key: 'blocked_pull_state', zh: text.zh(n), en: text.en(n), tone: text.tone }
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

const ARCHIVED: StockPrepPosture = Object.freeze({
  key: 'archived',
  zh: '已归档',
  en: 'Archived',
  tone: 'neutral',
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
 *
 * S3: `archived` comes before ALL of it (ADR §5: 「已归档」优先) — an archived project is not waiting on
 * anyone, whatever its ledger still holds, and the overview's 「状态」 column says the same word.
 */
export function stockPrepPosture(input: StockPrepPostureInput): StockPrepPosture {
  if (input.archived === true) return ARCHIVED
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
  // PR-5: an unfinished / unreadable refresh state is never 「可以导出」 (and outranks 「看不到进度」: a state
  // that IS known says more than "this screen cannot see the pull").
  const blockedPull = refreshBlockedPosture(input)
  if (blockedPull) return blockedPull
  if (input.progressUnknown) return UNKNOWN
  const pulled = input.pulledRowCount ?? 0
  if (pulled > 0) return READY
  return NOT_PULLED
}
