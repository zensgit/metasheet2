// 人工补充行 (manual supplementary rows) — the web's string table, slice B3 of ADR
// adr-stock-prep-manual-rows-20261030 (docs/development/takeover-beiliao-20260821/).
//
// EN + ZH both explicit, like workbench-labels.ts. The zh refusal texts are the ADR §3.1 table's wording, the same
// sentences the host sends with its refusals (multitable/stock-preparation-manual-rows-gate.ts), so a person sees one
// text whether the web or the server said no. Values-free: no sheet, project number, key or cell value ever enters
// these strings.

export type ManualRowLabelKey =
  // entries
  | 'entry.create' | 'entry.copy' | 'entry.copyTitle'
  // the row mark (OQ3: 网格里，人工补充行的行首显示「人工补充」)
  | 'tag.manual' | 'tag.manualTitle'
  // the note that replaces the generic create entries (ADR §3.1 allowed / §3.7)
  | 'notice.useManualRow'
  // the state-wise reasons (ADR §3.1)
  | 'reason.disabled' | 'reason.lockMissing' | 'reason.lockMissingHeadline' | 'reason.projectArchived'
  | 'reason.projectSheetsOff' | 'reason.contractMismatch' | 'reason.registryUnreadable' | 'reason.unavailable'
  // the 新增人工补充行 dialog
  | 'dialog.title' | 'dialog.projectNo' | 'dialog.projectNoAuto' | 'dialog.requiredHint' | 'dialog.submit'
  | 'dialog.submitting' | 'dialog.cancel' | 'dialog.blockedRequired' | 'dialog.failed' | 'dialog.noFields'
  // 复制为新行
  | 'confirm.copy'
  // toasts
  | 'toast.created' | 'toast.copied' | 'toast.copyFailed'

const MANUAL_ROW_LABELS: Record<ManualRowLabelKey, { en: string; zh: string }> = {
  'entry.create': { en: 'Add manual supplementary row', zh: '新增人工补充行' },
  'entry.copy': { en: 'Copy as new row', zh: '复制为新行' },
  'entry.copyTitle': {
    en: 'Create a manual supplementary row from this row (parent columns, progress and PLM identity are not copied)',
    zh: '用这一行新建一条人工补充行（不复制父组件两列、进度与回复和 PLM 身份列）',
  },
  'tag.manual': { en: 'Manual', zh: '人工补充' },
  'tag.manualTitle': {
    en: 'Manual supplementary row: added by hand; the PLM pull does not change it',
    zh: '人工补充行：人工新增，拉取不会修改这一行',
  },
  'notice.useManualRow': {
    en: 'On a stock-prep project sheet, add rows with "Add manual supplementary row"; PLM rows come from the pull.',
    zh: '备料项目表上请用「新增人工补充行」新增行；PLM 行由拉取写入。',
  },
  'reason.disabled': {
    en: '"Allow manual supplementary rows" is off for this project sheet, so rows cannot be added; ask the stock-prep administrator if you need one.',
    zh: '本项目表已关闭「允许人工补充行」，不能新增行；如需新增请联系备料管理员。',
  },
  'reason.lockMissing': {
    en: 'The PLM column lock of this sheet is not complete yet, so rows cannot be added for now; ask an administrator to repair this sheet.',
    zh: '本表的 PLM 列锁还没有补齐，暂时不能新增行；请联系管理员修复本表。',
  },
  'reason.lockMissingHeadline': { en: 'An administrator needs to repair this sheet', zh: '需管理员修复本表' },
  'reason.projectArchived': {
    en: 'This project\'s stock-prep sheet is archived, so rows cannot be added.',
    zh: '本项目的备料表已归档，不能新增行。',
  },
  'reason.projectSheetsOff': {
    en: '"One stock-prep sheet per project" is not switched on, so rows cannot be added on this sheet.',
    zh: '「一个项目一张备料表」功能未开启，不能在这张表上新增行。',
  },
  'reason.contractMismatch': {
    en: 'This sheet does not match the stock-prep template, so rows cannot be added for now; ask an administrator to check this sheet.',
    zh: '本表结构与备料模板不一致，暂时不能新增行；请联系管理员核对本表。',
  },
  'reason.registryUnreadable': {
    en: 'The project registration cannot be read right now; try again later, and ask an administrator if it keeps failing.',
    zh: '暂时读不到项目登记信息，请稍后重试；仍不行请联系管理员。',
  },
  'reason.unavailable': {
    en: 'Rows cannot be added on this sheet for now; ask an administrator.',
    zh: '暂时不能在这张表上新增行；请联系管理员。',
  },
  'dialog.title': { en: 'Add manual supplementary row', zh: '新增人工补充行' },
  'dialog.projectNo': { en: 'Project No', zh: '项目号' },
  'dialog.projectNoAuto': { en: 'Filled in by the system from this sheet\'s project', zh: '由系统按本表的项目自动填写' },
  'dialog.requiredHint': { en: 'Fields marked * are required.', zh: '带 * 的为必填。' },
  'dialog.submit': { en: 'Add', zh: '新增' },
  'dialog.submitting': { en: 'Adding...', zh: '正在新增…' },
  'dialog.cancel': { en: 'Cancel', zh: '取消' },
  'dialog.blockedRequired': {
    en: 'A required column of this sheet is not writable for you, so you cannot add a row here; ask an administrator.',
    zh: '本表有必填列你没有填写权限，不能新增行；请联系管理员。',
  },
  'dialog.failed': { en: 'Failed to add the manual supplementary row', zh: '新增人工补充行失败' },
  'dialog.noFields': { en: 'No column of this sheet can be filled in here.', zh: '这张表没有可以在这里填写的列。' },
  'confirm.copy': {
    en: 'Create a new manual supplementary row from this row? The new row gets its own key; this row is not changed.',
    zh: '用这一行新建一条人工补充行吗？新行有自己的唯一键，这一行不会改变。',
  },
  'toast.created': { en: 'Manual supplementary row added', zh: '已新增人工补充行' },
  'toast.copied': { en: 'Copied as a new manual supplementary row', zh: '已复制为新的人工补充行' },
  'toast.copyFailed': { en: 'Failed to copy as a new row', zh: '复制为新行失败' },
}

export function manualRowLabel(key: ManualRowLabelKey, isZh: boolean): string {
  const entry = MANUAL_ROW_LABELS[key]
  return isZh ? entry.zh : entry.en
}

/** The 「请填写…」 line under a required dialog column left empty. The column name is the sheet's own (schema, not a value). */
export function manualRowRequiredMessage(fieldName: string, isZh: boolean): string {
  return isZh ? `请填写「${fieldName}」` : `Fill in "${fieldName}"`
}

export const MANUAL_ROW_LABEL_KEYS = Object.freeze(Object.keys(MANUAL_ROW_LABELS) as ManualRowLabelKey[])
