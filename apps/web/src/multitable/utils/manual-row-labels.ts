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
  // 父组件 (ADR §12.2): the 新增 dialog's fieldset, the picker, and the drawer's 「修改父组件」
  | 'parent.legend' | 'parent.modeNone' | 'parent.modePick' | 'parent.modeNew' | 'parent.noneHint' | 'parent.newHint'
  | 'parent.code' | 'parent.name' | 'parent.search' | 'parent.groupParents' | 'parent.groupComponents' | 'parent.change'
  | 'parent.searching' | 'parent.empty' | 'parent.truncated' | 'parent.loadFailed' | 'parent.noName'
  | 'parent.problem.pickRequired' | 'parent.problem.codeRequired' | 'parent.problem.nameRequired'
  | 'parent.problem.nameWithoutCode' | 'parent.problem.selfParent'
  | 'parent.edit.entry' | 'parent.edit.title' | 'parent.edit.current' | 'parent.edit.currentNone' | 'parent.edit.modePick'
  | 'parent.edit.modeNew' | 'parent.edit.modeRemove' | 'parent.edit.hint' | 'parent.edit.removeHint' | 'parent.edit.save'
  | 'parent.edit.saving' | 'parent.edit.saved' | 'parent.edit.failed' | 'parent.edit.pickRequired'

const MANUAL_ROW_LABELS: Record<ManualRowLabelKey, { en: string; zh: string }> = {
  'entry.create': { en: 'Add manual supplementary row', zh: '新增人工补充行' },
  'entry.copy': { en: 'Copy as new row', zh: '复制为新行' },
  'entry.copyTitle': {
    en: 'Create a manual supplementary row from this row (the parent columns come along when both can; progress and PLM identity are not copied)',
    zh: '用这一行新建一条人工补充行（父组件两列能一起带上时带上；不复制进度与回复和 PLM 身份列）',
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
  'parent.legend': { en: 'Parent component', zh: '父组件' },
  'parent.modeNone': { en: 'No parent', zh: '不挂父组件' },
  'parent.modePick': { en: 'Pick an existing one', zh: '选已有的' },
  'parent.modeNew': { en: 'New parent', zh: '新建父组件' },
  'parent.noneHint': {
    en: 'This row appears in the empty group of the fill view (headed "(No value)").',
    zh: '这一行会出现在填写视图的空值组（组头显示「(无值)」）。',
  },
  'parent.newHint': {
    en: 'This only writes the parent onto this row; no row is created for the parent itself. If the parent needs stock prep too, add it as a manual supplementary row first, then pick it for its children.',
    zh: '只给这一行写上父组件，不会自动为父组件本身建一行。父组件本身也要备料的，先把它新增成一行人工补充行，再给子件选它。',
  },
  'parent.code': { en: 'Parent code', zh: '父组件图号' },
  'parent.name': { en: 'Parent name', zh: '父组件名称' },
  'parent.search': { en: 'Search by code or name', zh: '按图号或名称搜索' },
  'parent.groupParents': { en: 'Existing parents', zh: '已有父组件' },
  'parent.groupComponents': { en: 'Materials of this project (picking one makes it a parent)', zh: '本项目物料（选它就让它成为父组件）' },
  'parent.change': { en: 'Change', zh: '更换' },
  'parent.searching': { en: 'Searching...', zh: '正在搜索…' },
  'parent.empty': { en: 'No parent or material matches.', zh: '没有匹配的父组件或物料。' },
  'parent.truncated': { en: 'Only the first matches are shown; type more to narrow them down.', zh: '只显示了前一部分，请多输入几个字缩小范围。' },
  'parent.loadFailed': { en: 'Failed to load the parent candidates', zh: '读取父组件候选失败' },
  'parent.noName': { en: '(no name)', zh: '（无名称）' },
  'parent.problem.pickRequired': {
    en: 'Pick a parent, or choose "No parent".',
    zh: '请选一个父组件，或者改选「不挂父组件」。',
  },
  'parent.problem.codeRequired': { en: 'Fill in the parent code', zh: '请填写父组件图号' },
  'parent.problem.nameRequired': { en: 'Fill in the parent name', zh: '请填写父组件名称' },
  'parent.problem.nameWithoutCode': {
    en: 'A parent name without a parent code cannot be saved; add the parent code, or clear both.',
    zh: '只填了父组件名称、没有父组件图号，不能保存；请补上父组件图号，或者把两项都清空。',
  },
  'parent.problem.selfParent': {
    en: 'The parent code cannot be the code of this row itself.',
    zh: '父组件图号不能和这一行自己的图号相同。',
  },
  'parent.edit.entry': { en: 'Change parent', zh: '修改父组件' },
  'parent.edit.title': { en: 'Change parent', zh: '修改父组件' },
  'parent.edit.current': { en: 'Current', zh: '当前' },
  'parent.edit.currentNone': { en: 'No parent', zh: '未挂父组件' },
  'parent.edit.modePick': { en: 'Change to an existing one', zh: '改成已有的' },
  'parent.edit.modeNew': { en: 'New parent', zh: '新建父组件' },
  'parent.edit.modeRemove': { en: 'Remove from parent', zh: '移出父组件' },
  'parent.edit.hint': {
    en: 'Only this row changes. What was already pushed or exported is not updated; the next formal export follows the new parent.',
    zh: '只改这一行。已经推送或导出过的不会自动更新；正式导出下次按新的父组件排。',
  },
  'parent.edit.removeHint': {
    en: 'After saving, this row moves to the empty group of the fill view.',
    zh: '保存后，这一行回到填写视图的空值组。',
  },
  'parent.edit.save': { en: 'Save', zh: '保存' },
  'parent.edit.saving': { en: 'Saving...', zh: '正在保存…' },
  'parent.edit.saved': { en: 'Parent changed', zh: '已修改父组件' },
  'parent.edit.failed': { en: 'Failed to change the parent', zh: '修改父组件失败' },
  'parent.edit.pickRequired': { en: 'Pick a parent.', zh: '请选一个父组件。' },
}

export function manualRowLabel(key: ManualRowLabelKey, isZh: boolean): string {
  const entry = MANUAL_ROW_LABELS[key]
  return isZh ? entry.zh : entry.en
}

/** The 「请填写…」 line under a required dialog column left empty. The column name is the sheet's own (schema, not a value). */
export function manualRowRequiredMessage(fieldName: string, isZh: boolean): string {
  return isZh ? `请填写「${fieldName}」` : `Fill in "${fieldName}"`
}

/** 「N 个子件」 beside an existing parent in the picker (a count, never a value). */
export function manualRowParentChildCountText(count: number, isZh: boolean): string {
  return isZh ? `${count} 个子件` : `${count} ${count === 1 ? 'child' : 'children'}`
}

/**
 * ADR §12.7 ①: the confirm before a manual row's 图号 changes or the row is deleted while other manual rows name it as
 * their parent. Only the number — never a 图号 or a row.
 */
export function manualRowParentDependentsConfirmText(count: number, isZh: boolean): string {
  return isZh
    ? `有 ${count} 行人工补充行以它为父组件，修改/删除后它们不会跟着变。要继续吗？`
    : `${count} manual supplementary ${count === 1 ? 'row names' : 'rows name'} this row as parent; they will not follow the change or deletion. Continue?`
}

export const MANUAL_ROW_LABEL_KEYS = Object.freeze(Object.keys(MANUAL_ROW_LABELS) as ManualRowLabelKey[])
