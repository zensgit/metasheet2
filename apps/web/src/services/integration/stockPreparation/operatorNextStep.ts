// 「下一步」条的规则表 (P0-3) — 设计稿 §4.2, a pure, front-end-only rule engine.
//
// WHY A PURE FUNCTION. The workspace's "下一步" bar is, by design (G1: 每屏一个主操作位), the ONLY
// place on the project workspace that renders a filled primary button. Seven situations compete for
// that one slot, and if the priority order lived inline in the component template it would drift the
// first time somebody reordered a `v-if` chain without reading the other six. This module is the one
// place that order is decided, so a spec can pin it directly without mounting a component.
//
// ZERO NEW INTERFACE. Every field below is already on screen somewhere on this page today:
// `board.pulledRowCount` / `board.pendingDecisionCount` (project board), `report.missingComponents`
// (the composed sync panel), `handoff.isCurrentHandler` (通知下一步). This module adds no fetch of
// its own — see 设计稿 §4.2's own note: "状态全部由既有数据反推 … 零新接口。"

export type OperatorNextStepAction =
  | 'pull'
  | 'view-missing'
  | 'go-confirm'
  | 'resync'
  | 'open-fill'
  | 'notify-next'
  | null

export interface OperatorNextStepInput {
  /** False on a 404 / a project that has never been opened successfully. */
  boardFound: boolean
  /** Rows already written into the sheet for this project. */
  pulledRowCount: number
  /** Distinct missing parts the latest dry-run/report found; 0 when none or unknown. */
  missingComponentsCount: number
  /** Rows in the confirmation ledger still waiting on a human, for this project. */
  pendingDecisionCount: number
  /**
   * SESSION-LOCAL: the last sync report this browser saw for this project ended `held`, and
   * `pendingDecisionCount` has since dropped to 0 — i.e. the operator went and confirmed everything
   * and has not yet pressed sync again. Never derived from anything persisted across a reload.
   */
  justConfirmed: boolean
  /** `board.lastExportAt` is present. */
  hasExported: boolean
  /** The signed-in operator holds the current handoff step, and it is not the terminal one. */
  isCurrentHandler: boolean
}

export interface OperatorNextStepResult {
  key: 'pull' | 'missing' | 'pending' | 'resync' | 'fill' | 'notify' | 'clear'
  zh: string
  en: string
  /** Empty string on the one rule (`clear`) that has no primary button (G1: absent, not disabled). */
  actionZh: string
  actionEn: string
  action: OperatorNextStepAction
}

/**
 * THE seven rules, read top to bottom exactly as 设计稿 §4.2 lists them — the first one whose
 * condition is true wins, and it is the ONLY one that renders.
 */
export function operatorNextStep(input: OperatorNextStepInput): OperatorNextStepResult {
  // 1. 看板 404 / 从没拉过
  if (!input.boardFound || input.pulledRowCount <= 0) {
    return {
      key: 'pull',
      zh: '这个项目号在您这里还没有数据。先把它从 PLM 拉进来。',
      en: 'There is no data for this project number here yet. Pull it in from PLM first.',
      actionZh: '从 PLM 拉取数据',
      actionEn: 'Pull data from PLM',
      action: 'pull',
    }
  }
  // 2. 缺件 > 0
  if (input.missingComponentsCount > 0) {
    const n = input.missingComponentsCount
    return {
      key: 'missing',
      zh: `有 ${n} 种零件在源系统里找不到,补齐之前整个项目一行都写不进去。`,
      en: `${n} part(s) cannot be found in the source system — not one row of this project can be `
        + 'written until they are fixed.',
      actionZh: '看缺哪些件',
      actionEn: 'See which parts are missing',
      action: 'view-missing',
    }
  }
  // 3. pendingDecisionCount > 0
  if (input.pendingDecisionCount > 0) {
    const n = input.pendingDecisionCount
    return {
      key: 'pending',
      zh: `有 ${n} 件系统拿不准的事等您拿主意;处理完回来再同步一次。`,
      en: `${n} thing(s) need your call — come back and sync again once you are done.`,
      actionZh: `现在就处理这 ${n} 件事`,
      actionEn: `Handle these ${n} now`,
      action: 'go-confirm',
    }
  }
  // 4. 刚确认完(本次会话内 pending 归零且上次 verdict=held)
  if (input.justConfirmed) {
    return {
      key: 'resync',
      zh: '都确认完了。再同步一次,数据才会写进多维表。',
      en: 'All confirmed. Sync again so the data is written into the multitable.',
      actionZh: '再同步一次',
      actionEn: 'Sync again',
      action: 'resync',
    }
  }
  // 5. 已写入 且 未导出 (pulledRowCount > 0 is already guaranteed by rule 1 having fallen through)
  if (!input.hasExported) {
    return {
      key: 'fill',
      zh: '数据都在多维表里了。可以去填采购/仓库进度,或者导出给别人。',
      en: 'The data is in the multitable. Fill in purchasing/warehouse progress, or export it for '
        + 'someone else.',
      actionZh: '到多维表填写这个项目',
      actionEn: 'Open the multitable for this project',
      action: 'open-fill',
    }
  }
  // 6. handoff.isCurrentHandler
  if (input.isCurrentHandler) {
    return {
      key: 'notify',
      zh: '填完了就通知下一步,后面的人才知道该他了。',
      en: 'Once you are done, tell the next person — that is how they know it is their turn.',
      actionZh: '通知下一步',
      actionEn: 'Tell the next person',
      action: 'notify-next',
    }
  }
  // 7. 全清
  return {
    key: 'clear',
    zh: '这个项目现在没有等您的事。',
    en: 'Nothing on this project is waiting on you right now.',
    actionZh: '',
    actionEn: '',
    action: null,
  }
}
