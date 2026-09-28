// 「复制数据表（含数据）」S1 string table (ADR docs/development/multitable-copy-sheet-with-data-adr-20260926.md
// §3 user-visible behaviour, §8 failure modes).
//
// Scope: MetaCopySheetDialog.vue chrome, the dry-run disclosure lines, the refusal copy for every
// ADR error code, the success toast, and the 「存为模板」 hand-off link. The rail's entry button and the
// 快照副本 / 不随 PLM 刷新 badges live with the rest of the rail chrome in meta-sheet-view-rail-labels.ts.
//
// Two rules every function here keeps:
//   1. values-free — nothing a server sends as prose is ever rendered (the client drops `message`), and
//      no cell value can reach these strings; only codes, counts the ADR allows, the user-chosen new
//      name, and schema names (column / view names) the caller already reads.
//   2. no raw enum in the zh UI — an unknown reason / error code falls back to a generic localized line,
//      never to the code itself.

import { isCopySheetError } from '../api/client'

type LocaleText = { en: string; zh: string }

export type MetaCopySheetLabelKey =
  | 'copySheet.title'
  | 'copySheet.close'
  | 'copySheet.sourceLabel'
  | 'copySheet.nameLabel'
  | 'copySheet.targetBaseLabel'
  | 'copySheet.targetBaseCurrent'
  | 'copySheet.targetBaseNote'
  | 'copySheet.permissionLabel'
  | 'copySheet.permissionInherit'
  | 'copySheet.permissionNote'
  | 'copySheet.dryRunLoading'
  | 'copySheet.disclosuresTitle'
  | 'copySheet.notCopied'
  | 'copySheet.cancel'
  | 'copySheet.submit'
  | 'copySheet.submitting'
  | 'copySheet.errorNoName'
  | 'copySheet.unlistedField'
  | 'copySheet.unlistedView'
  | 'copySheet.entryFromTemplate'
  | 'copySheet.formulaRecomputeFailed'
  | 'copySheet.error.notFullyReadable'
  | 'copySheet.error.unmappedFieldRef'
  | 'copySheet.error.ruleUnbuildable'
  | 'copySheet.error.ruleOnRenumberedField'
  | 'copySheet.error.permissionParityFailed'
  | 'copySheet.error.sourceChanged'
  | 'copySheet.error.tooLarge'
  | 'copySheet.error.systemSheet'
  | 'copySheet.error.tooManyFields'
  | 'copySheet.error.linkTargetNotLive'
  | 'copySheet.error.unsupportedFieldType'
  | 'copySheet.error.nameInvalid'
  | 'copySheet.error.sourceGone'
  | 'copySheet.error.forbidden'
  | 'copySheet.error.busy'
  | 'copySheet.error.temporarilyUnavailable'
  | 'copySheet.error.generic'
  | 'copySheet.error.probeFailed'

const META_COPY_SHEET_LABELS: Record<MetaCopySheetLabelKey, LocaleText> = {
  'copySheet.title': { en: 'Copy table', zh: '复制数据表' },
  'copySheet.close': { en: 'Close', zh: '关闭' },
  'copySheet.sourceLabel': { en: 'Source table', zh: '源数据表' },
  'copySheet.nameLabel': { en: 'New table name', zh: '新数据表名称' },
  'copySheet.targetBaseLabel': { en: 'Target base', zh: '目标工作区' },
  'copySheet.targetBaseCurrent': { en: 'Current base', zh: '当前工作区' },
  'copySheet.targetBaseNote': {
    en: 'For now a copy can only be created in the source table\'s own base.',
    zh: '目前只能复制到源数据表所在的工作区。',
  },
  'copySheet.permissionLabel': { en: 'Permissions', zh: '权限' },
  'copySheet.permissionInherit': { en: 'Same as the source table', zh: '与源表相同' },
  // ADR §11-9: the copy's permissions are a snapshot at copy time — disclosed, not synced.
  'copySheet.permissionNote': {
    en: 'Table, field and record permissions are copied as they are right now. Later permission changes on the source table are not applied to the copy.',
    zh: '表、字段、记录级权限按复制时刻照搬；之后源数据表的权限变更不会同步到副本。',
  },
  'copySheet.dryRunLoading': { en: 'Checking what will be copied…', zh: '正在预检复制内容…' },
  'copySheet.disclosuresTitle': { en: 'What changes in the copy', zh: '复制说明' },
  // ADR §3 / §10: never copied, whatever the options — the backend's fixed COPY_SHEET_NOT_COPIED list
  // (copy-sheet-service.ts on feat/multitable-copy-sheet-s1), in the same order.
  'copySheet.notCopied': {
    en: 'Not copied: automations, comments, subscriptions, form sharing, record locks, revision history, personal view settings, attachment files.',
    zh: '不会复制：自动化、评论、订阅、表单分享、记录锁定、修订历史、个人视图设置、附件文件。',
  },
  'copySheet.cancel': { en: 'Cancel', zh: '取消' },
  'copySheet.submit': { en: 'Copy', zh: '复制' },
  'copySheet.submitting': { en: 'Copying…', zh: '正在复制…' },
  'copySheet.errorNoName': { en: 'Enter a name for the new table.', zh: '请输入新数据表名称。' },
  'copySheet.unlistedField': { en: '(unlisted column)', zh: '（未列出的列）' },
  'copySheet.unlistedView': { en: '(unlisted view)', zh: '（未列出的视图）' },
  'copySheet.entryFromTemplate': { en: 'Copy this table with its data instead', zh: '改为复制数据表（含数据）' },
  'copySheet.formulaRecomputeFailed': {
    en: 'The copy was created, but some formula columns could not be recomputed. Re-save the formula in the field settings to recompute it.',
    zh: '副本已创建，但部分公式列未能重算。可在字段设置中重新保存该公式以重算。',
  },
  // ADR CS-5 / §8: gate refusal — deliberately says which KIND of gate, never how much was hidden.
  'copySheet.error.notFullyReadable': {
    en: 'You don\'t have full read access to this table (some columns, rows or formula results are hidden from you), so it can\'t be copied. Ask the table\'s admin.',
    zh: '你对这张数据表没有完整的读取权限（有列、行或公式结果对你不可见），不能复制。请联系表管理员。',
  },
  'copySheet.error.unmappedFieldRef': {
    en: 'A column\'s settings reference another column in a way copying can\'t carry over yet, so nothing was copied. Contact an administrator.',
    zh: '有列的设置引用了复制暂时无法对应的列，未做任何复制。请联系管理员。',
  },
  'copySheet.error.ruleUnbuildable': {
    en: 'A row-visibility rule on this table uses a column the copy cannot create (such as a two-way link\'s mirror column). Copying would loosen who can see which rows, so it was refused.',
    zh: '这张表的行级可见规则用到了副本无法创建的列（如双向关联的镜像列）。复制会放宽行的可见范围，已拒绝。',
  },
  'copySheet.error.ruleOnRenumberedField': {
    en: 'A row-visibility rule on this table uses an auto-number column, and copying renumbers it — that could change which rows are hidden, so it was refused. You can untick “Include data” to copy the structure only.',
    zh: '这张表的行级可见规则用到了自动编号列，而复制会重新编号，可能改变哪些行被隐藏，已拒绝。可取消勾选「包含数据」只复制结构。',
  },
  'copySheet.error.permissionParityFailed': {
    en: 'The copied permissions could not be matched one-to-one with the source (they may have changed during the copy). Everything was rolled back and no table was created. Try again.',
    zh: '副本的权限无法与源数据表逐条对应（可能在复制期间被修改），已整体回滚，未创建任何数据表。请重试。',
  },
  'copySheet.error.sourceChanged': {
    en: 'The source table changed while it was being copied. Everything was rolled back and no table was created. Try again.',
    zh: '复制期间源数据表被修改，已整体回滚，未创建任何数据表。请重试。',
  },
  'copySheet.error.tooLarge': {
    en: 'This table is over the single-copy limit (too many rows or columns).',
    zh: '这张数据表超出单次复制上限（行数或列数过多）。',
  },
  'copySheet.error.systemSheet': { en: 'System tables can\'t be copied.', zh: '系统数据表不能复制。' },
  'copySheet.error.tooManyFields': {
    en: 'This table has more columns than a single copy allows.',
    zh: '这张数据表的列数超出单次复制上限。',
  },
  'copySheet.error.linkTargetNotLive': {
    en: 'A link column points to a table that no longer exists, so nothing was copied. Fix or remove that link column first.',
    zh: '有关联列指向的数据表已不存在，未做任何复制。请先修正或删除该关联列。',
  },
  // 400 NAME_INVALID_CHARACTERS (display-name-hygiene.ts): the typed name carries control / replacement /
  // unpaired-surrogate code points (usually an encoding mishap). The server's message lists code points —
  // never shown; this line just asks for a clean name.
  'copySheet.error.nameInvalid': {
    en: 'The new table name contains characters that can\'t be used. Retype the name and try again.',
    zh: '新数据表名称包含无法使用的字符，请重新输入名称后重试。',
  },
  'copySheet.error.unsupportedFieldType': {
    en: 'A column type can\'t be copied yet, so nothing was copied.',
    zh: '有列的类型暂不支持复制，未做任何复制。',
  },
  'copySheet.error.sourceGone': {
    en: 'The source table no longer exists or was deleted.',
    zh: '源数据表不存在或已被删除。',
  },
  'copySheet.error.forbidden': {
    en: 'You don\'t have permission to create a table in this base.',
    zh: '你没有在当前工作区新建数据表的权限。',
  },
  'copySheet.error.busy': {
    en: 'The table is busy with another operation. Try again shortly.',
    zh: '数据表正被其他操作占用，请稍后重试。',
  },
  // 503 COPY_TEMPORARILY_UNAVAILABLE: the server's dedupe ledger is not migrated yet, so the copy refuses (fail-closed,
  // decision register R-20). Nothing was written; retrying does not help until an administrator upgrades the database.
  'copySheet.error.temporarilyUnavailable': {
    en: 'Copy is temporarily unavailable: the server needs a database upgrade first; contact your administrator.',
    zh: '复制暂不可用：服务器需要先完成数据库升级，请联系管理员。',
  },
  'copySheet.error.generic': { en: 'Copy failed. Try again later.', zh: '复制失败，请稍后重试。' },
  // The dry-run itself did not answer (network / 5xx): nothing was attempted, and copying stays locked
  // because the disclosures could not be shown.
  'copySheet.error.probeFailed': {
    en: 'The pre-check did not complete, so copying is not available yet (nothing was changed). Close and reopen this dialog to try again.',
    zh: '预检未完成，暂时不能复制（未做任何修改）。请关闭后重新打开再试。',
  },
}

export function copySheetLabel(key: MetaCopySheetLabelKey, isZh: boolean): string {
  const entry = META_COPY_SHEET_LABELS[key]
  return isZh ? entry.zh : entry.en
}

// --- Interpolation helpers (not keys) ---

/** ADR CS-4 default name: 「<源表名> 副本」 / "<name> copy". The server re-applies display-name hygiene. */
export function copySheetDefaultName(sourceName: string, isZh: boolean): string {
  const base = sourceName.trim()
  return isZh ? `${base} 副本` : `${base} copy`
}

/** 「包含数据（共 N 行）」 — N only once the dry-run passed the gate; before that (or on a refusal) no count. */
export function copySheetWithDataLabel(rowCount: number | null, isZh: boolean): string {
  if (rowCount === null) return isZh ? '包含数据' : 'Include data'
  return isZh ? `包含数据（共 ${rowCount} 行）` : `Include data (${rowCount} ${rowCount === 1 ? 'row' : 'rows'})`
}

function joinNames(names: string[], isZh: boolean): string {
  return isZh ? names.map((n) => `「${n}」`).join('、') : names.map((n) => `“${n}”`).join(', ')
}

/**
 * One line per disclosure reason (ADR §3 / §5.1), naming the affected columns. An unknown reason code
 * gets a generic line — the code itself is never shown.
 */
export function copySheetDisclosureText(reason: string, fieldNames: string[], isZh: boolean): string {
  const names = joinNames(fieldNames, isZh)
  switch (reason) {
    case 'ATTACHMENT_BLANKED':
      return isZh ? `附件列 ${names}：列会保留，附件不复制（副本中为空）` : `Attachment columns ${names}: kept, but files are not copied (empty in the copy)`
    case 'SELF_LINK_BLANKED':
      return isZh ? `关联本表的列 ${names}：列会保留，值为空` : `Columns linking to this table ${names}: kept, values empty`
    case 'MIRROR_NOT_BUILT':
      return isZh ? `双向关联的镜像列 ${names}：不会创建` : `Two-way link mirror columns ${names}: not created`
    case 'DEPENDS_ON_BLANKED_COLUMN':
      return isZh
        ? `依赖上述列的列 ${names}：保留并实时计算，结果可能为空`
        : `Columns depending on the ones above ${names}: kept and computed live; results may be empty`
    case 'BUTTON_DISABLED':
      return isZh ? `按钮列 ${names}：保留按钮，按钮动作不复制` : `Button columns ${names}: kept, but their actions are not copied`
    case 'PROPERTY_HIDDEN_BLANKED':
      return isZh ? `已隐藏的列 ${names}：列会保留（仍隐藏），值为空` : `Hidden columns ${names}: kept (still hidden), values empty`
    default:
      return isZh ? `列 ${names}：复制后会有差异` : `Columns ${names}: will differ in the copy`
  }
}

/**
 * ADR CS-12: autoNumber is renumbered 1..N on copy — disclose how many numbers change. The backend's
 * `autoNumberRenumberedRows` counts once per auto-number COLUMN per row (copy-sheet-service.ts, the
 * `for (plan of autoNumberPlans) records.forEach(...)` loop — unchanged at the #6112 fix head 6410ea0c4),
 * i.e. changed CELLS, so the copy says
 * 「N 处编号」 (N numbers), not 「N 行」 — a sheet with two auto-number columns would otherwise double the rows.
 */
export function copySheetAutoNumberText(changedNumbers: number, isZh: boolean): string {
  return isZh
    ? `自动编号列会重新编号：共 ${changedNumbers} 处编号将发生变化`
    : `Auto-number columns are renumbered: ${changedNumbers} ${changedNumbers === 1 ? 'number changes' : 'numbers change'}`
}

/** ADR §5.2: filter conditions on blanked / unbuilt columns are removed from the copied view. */
export function copySheetViewFilterDropText(viewName: string, count: number, isZh: boolean): string {
  return isZh
    ? `视图「${viewName}」：将移除 ${count} 个筛选条件`
    : `View “${viewName}”: ${count} filter ${count === 1 ? 'condition is' : 'conditions are'} removed`
}

/** Dry-run says the rows exceed the synchronous cap (ADR CS-15, default 2000). */
export function copySheetOverLimitText(limit: number | null, isZh: boolean): string {
  if (limit === null) {
    return isZh
      ? '数据行数超出单次复制上限。可取消勾选「包含数据」只复制结构。'
      : 'The rows exceed the single-copy limit. Untick “Include data” to copy the structure only.'
  }
  return isZh
    ? `数据行数超出单次复制上限（${limit} 行）。可取消勾选「包含数据」只复制结构。`
    : `The rows exceed the single-copy limit (${limit} rows). Untick “Include data” to copy the structure only.`
}

export interface CopySheetErrorContext {
  /** Resolve a column id to its display name (schema metadata the caller already has), or null. */
  fieldName?: (fieldId: string) => string | null
  /** Resolve a view id to its display name (schema metadata the caller already has), or null. */
  viewName?: (viewId: string) => string | null
}

/**
 * Where a post-gate structural refusal points, as display names (ids are never shown). `hasView` is true
 * whenever the server named a view; `view` is its display name, or null when the caller cannot name it
 * (the text then says "a view" rather than dropping the view). An unnamed column is simply omitted.
 */
function refusalLocation(error: { fieldId?: string; viewId?: string }, ctx: CopySheetErrorContext) {
  return {
    column: error.fieldId ? (ctx.fieldName?.(error.fieldId) ?? null) : null,
    hasView: Boolean(error.viewId),
    view: error.viewId ? (ctx.viewName?.(error.viewId) ?? null) : null,
  }
}

/** COPY_UNMAPPED_FIELD_REF naming the view and/or column whose settings hold the unmappable reference. */
function copySheetUnmappedRefText(error: { fieldId?: string; viewId?: string }, isZh: boolean, ctx: CopySheetErrorContext): string {
  const { column, hasView, view } = refusalLocation(error, ctx)
  if (!hasView && !column) return copySheetLabel('copySheet.error.unmappedFieldRef', isZh)
  if (isZh) {
    const viewText = view ? `视图「${view}」` : '某个视图'
    const owner = hasView && column ? `${viewText}中「${column}」列的设置` : hasView ? `${viewText}的设置` : `「${column}」列的设置`
    return `${owner}引用了复制暂时无法对应的列，未做任何复制。请联系管理员。`
  }
  const viewText = view ? `view “${view}”` : 'a view'
  const owner = hasView && column
    ? `The settings of column “${column}” in ${viewText}`
    : hasView ? `The settings of ${viewText}` : `The settings of column “${column}”`
  return `${owner} reference a column the copy can't map yet, so nothing was copied. Contact an administrator.`
}

/** Other post-gate structural refusals: the fixed sentence, prefixed by the view and/or column at fault. */
function withLocation(sentence: string, error: { fieldId?: string; viewId?: string }, isZh: boolean, ctx: CopySheetErrorContext): string {
  const { column, hasView, view } = refusalLocation(error, ctx)
  const parts: string[] = []
  if (hasView) parts.push(isZh ? (view ? `视图「${view}」` : '某个视图') : (view ? `View “${view}”` : 'A view'))
  if (column) parts.push(isZh ? `「${column}」列` : (parts.length ? `column “${column}”` : `Column “${column}”`))
  if (!parts.length) return sentence
  return isZh ? `${parts.join('、')}：${sentence}` : `${parts.join(', ')}: ${sentence}`
}

/**
 * Refusal copy by CODE (ADR §8). Only `CopySheetError` extras are used — never `error.message` of an
 * unknown error (it could be arbitrary text), so an unrecognized failure reads as the generic line.
 * The 403 gate refusal carries no counts by construction (neither the server nor this function adds any).
 */
export function copySheetErrorMessage(error: unknown, isZh: boolean, ctx: CopySheetErrorContext = {}): string {
  if (!isCopySheetError(error)) return copySheetLabel('copySheet.error.generic', isZh)
  // Post-gate structural refusals name the source view / column at fault when the client carried their
  // ids (only these codes can — see buildCopySheetError) and the caller can resolve them to schema names.
  const column = (key: MetaCopySheetLabelKey): string => withLocation(copySheetLabel(key, isZh), error, isZh, ctx)
  switch (error.code) {
    case 'COPY_SOURCE_NOT_FULLY_READABLE':
      return copySheetLabel('copySheet.error.notFullyReadable', isZh)
    case 'COPY_UNMAPPED_FIELD_REF':
      return copySheetUnmappedRefText(error, isZh, ctx)
    case 'COPY_UNSUPPORTED_FIELD_TYPE':
      return column('copySheet.error.unsupportedFieldType')
    case 'COPY_LINK_TARGET_NOT_LIVE':
      return column('copySheet.error.linkTargetNotLive')
    case 'COPY_SOURCE_RULE_UNBUILDABLE':
      return column('copySheet.error.ruleUnbuildable')
    case 'COPY_SOURCE_RULE_ON_RENUMBERED_FIELD':
      return column('copySheet.error.ruleOnRenumberedField')
    case 'COPY_PERMISSION_PARITY_FAILED':
      return copySheetLabel('copySheet.error.permissionParityFailed', isZh)
    case 'COPY_SOURCE_CHANGED':
      return copySheetLabel('copySheet.error.sourceChanged', isZh)
    case 'COPY_TOO_LARGE':
      return copySheetTooLargeText(error.rowCount, error.limit, isZh)
    case 'COPY_TOO_MANY_FIELDS':
      return copySheetTooManyFieldsText(error.fieldCount, error.limit, isZh)
    case 'COPY_ROW_VALIDATION_FAILED':
      return copySheetRowFailureText(error.rowIndex, error.fieldId, isZh, ctx)
    case 'COPY_SOURCE_SYSTEM_SHEET':
      return copySheetLabel('copySheet.error.systemSheet', isZh)
    case 'COPY_TEMPORARILY_UNAVAILABLE':
      return copySheetLabel('copySheet.error.temporarilyUnavailable', isZh)
    case 'NAME_INVALID_CHARACTERS':
      return copySheetLabel('copySheet.error.nameInvalid', isZh)
    case 'SHEET_NOT_LIVE':
    case 'SHEET_DELETED':
    case 'NOT_FOUND':
      return copySheetLabel('copySheet.error.sourceGone', isZh)
    default:
      break
  }
  if (error.status === 404) return copySheetLabel('copySheet.error.sourceGone', isZh)
  if (error.status === 403) return copySheetLabel('copySheet.error.forbidden', isZh)
  if (error.status === 409) return copySheetLabel('copySheet.error.busy', isZh)
  if (error.status === 413) return copySheetTooLargeText(error.rowCount, error.limit, isZh)
  return copySheetLabel('copySheet.error.generic', isZh)
}

function copySheetTooManyFieldsText(fieldCount: number | undefined, limit: number | undefined, isZh: boolean): string {
  if (typeof fieldCount !== 'number' || typeof limit !== 'number') return copySheetLabel('copySheet.error.tooManyFields', isZh)
  return isZh
    ? `这张数据表的列数超出单次复制上限（共 ${fieldCount} 列，上限 ${limit} 列）。`
    : `This table has too many columns to copy at once (${fieldCount} columns, limit ${limit}).`
}

function copySheetTooLargeText(rowCount: number | undefined, limit: number | undefined, isZh: boolean): string {
  // Row numbers only when the server said this is a ROW refusal (rowCount present) — a bare `limit`
  // could be the column cap, and calling it "rows" would be wrong.
  if (typeof rowCount !== 'number') return copySheetLabel('copySheet.error.tooLarge', isZh)
  if (typeof limit === 'number') {
    return isZh
      ? `数据超出单次复制上限（共 ${rowCount} 行，上限 ${limit} 行）。可取消勾选「包含数据」只复制结构。`
      : `Too many rows to copy at once (${rowCount} rows, limit ${limit}). Untick “Include data” to copy the structure only.`
  }
  return isZh
    ? `数据超出单次复制上限（共 ${rowCount} 行）。可取消勾选「包含数据」只复制结构。`
    : `Too many rows to copy at once (${rowCount} rows). Untick “Include data” to copy the structure only.`
}

function copySheetRowFailureText(
  rowIndex: number | undefined,
  fieldId: string | undefined,
  isZh: boolean,
  ctx: CopySheetErrorContext,
): string {
  // `rowIndex` is the 0-based position in the source's default order (created_at, id — ADR §7.2 step 5);
  // shown 1-based. Column shown by NAME (schema), never by id and never with the offending value.
  const fieldName = fieldId ? (ctx.fieldName?.(fieldId) ?? null) : null
  const column = fieldName
    ? (isZh ? `「${fieldName}」列` : `column “${fieldName}”`)
    : (isZh ? '某一列' : 'a column')
  if (typeof rowIndex === 'number') {
    const row = rowIndex + 1
    return isZh
      ? `第 ${row} 行（按创建顺序）的${column}未通过校验，复制已整体取消，未创建任何数据表。`
      : `Row ${row} (in creation order), ${column}, failed validation. The copy was cancelled and no table was created.`
  }
  return isZh
    ? `有一行的${column}未通过校验，复制已整体取消，未创建任何数据表。`
    : `A row failed validation in ${column}. The copy was cancelled and no table was created.`
}

export interface CopySheetToastSummary {
  rowCount: number | null
  fieldCount: number | null
  permissionRowCount: number | null
  recordPermissionRowCount: number | null
}

/**
 * Success toast (ADR §3): 「已复制为「新名」」 + the values-free counts when the server sent them, + a
 * replay note when the 201 was an idempotent replay of the same intent.
 */
export function copySheetSuccessToast(
  newName: string,
  summary: CopySheetToastSummary,
  replayed: boolean,
  isZh: boolean,
): string {
  const parts: string[] = []
  if (summary.rowCount !== null) parts.push(isZh ? `${summary.rowCount} 行` : `${summary.rowCount} rows`)
  if (summary.fieldCount !== null) parts.push(isZh ? `${summary.fieldCount} 列` : `${summary.fieldCount} columns`)
  if (summary.permissionRowCount !== null) {
    const grants = isZh ? `${summary.permissionRowCount} 条授权` : `${summary.permissionRowCount} permission grants`
    const record = summary.recordPermissionRowCount !== null
      ? (isZh ? `（含 ${summary.recordPermissionRowCount} 条记录级）` : ` (${summary.recordPermissionRowCount} record-level)`)
      : ''
    parts.push(`${grants}${record}`)
  }
  const head = isZh ? `已复制为「${newName}」` : `Copied as “${newName}”`
  const counts = parts.length ? (isZh ? `：${parts.join(' / ')}` : `: ${parts.join(' / ')}`) : ''
  const replay = replayed
    ? (isZh ? '（同一复制请求刚刚已完成，已打开那份副本）' : ' (the same copy just finished; opened that copy)')
    : ''
  return `${head}${counts}${replay}`
}
