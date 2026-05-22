import { describe, expect, it } from 'vitest'
import {
  workbenchLabel,
  conflictMessage,
  presenceLabel,
  presenceTitle,
  commentInboxTitle,
  mentionsUnread,
  mentionsRecords,
  templateInstalled,
  formSubmitSuccess,
  recordsImported,
  recordsFailedToImport,
  duplicateRowsSkipped,
  recordsDeleted,
  recordNotFound,
  cardSheets,
  cardFields,
  cardViews,
  type WorkbenchLabelKey,
} from '../src/multitable/utils/workbench-labels'

// Every static key the T2 dev MD §3 enumerates. If a key is added/removed
// this list must change in lockstep — that is the point of the test.
const ALL_KEYS: WorkbenchLabelKey[] = [
  'conflict.fieldFallback',
  'conflict.title', 'conflict.reload', 'conflict.retry', 'conflict.dismiss',
  'toolbar.commentInbox', 'toolbar.fields', 'toolbar.access', 'toolbar.views',
  'toolbar.workflow', 'toolbar.automations', 'toolbar.templates',
  'toolbar.dashboard', 'toolbar.shareForm', 'toolbar.apiWebhooks',
  'toolbar.mentions',
  'tpl.title', 'tpl.subtitle', 'tpl.loading', 'tpl.more', 'tpl.errorLoad',
  'kbd.title', 'kbd.navigateCells', 'kbd.editCell', 'kbd.cancelClose',
  'kbd.nextCell', 'kbd.copy', 'kbd.paste', 'kbd.undo', 'kbd.redo',
  'kbd.toggleHelp',
  'toast.recordCreateBlocked', 'toast.recordEditBlocked', 'toast.recordDeleteBlocked',
  'toast.datesUpdated', 'toast.hierarchyUpdated', 'toast.recordDeleted',
  'toast.loadedLatest', 'toast.changeReapplied', 'toast.recordUpdated',
  'toast.commentUpdated', 'toast.commentAdded',
  'toast.commentResolved', 'toast.commentDeleted', 'toast.linkedRecordsUpdated',
  'toast.viewSettingsSaved', 'toast.templateInstallBlocked', 'toast.templateRefreshFailed',
  'toast.templateInstallFailed',
  'toast.timelineDatesUpdateFailed', 'toast.hierarchyParentUpdateFailed',
  'toast.formSubmitFailed',
  'toast.commentUpdateFailed', 'toast.commentAddFailed',
  'toast.commentResolveFailed', 'toast.commentDeleteFailed',
  'toast.linkedRecordsUpdateFailed',
  'toast.fieldCreateFailed', 'toast.fieldUpdateFailed', 'toast.fieldDeleteFailed',
  'toast.viewCreateFailed', 'toast.viewUpdateFailed', 'toast.viewDeleteFailed',
  'toast.sheetAccessRefreshFailed',
  'toast.sheetCreateBlocked', 'toast.sheetRefreshFailed', 'toast.sheetCreateFailed',
  'toast.baseLoadFailed', 'toast.contextSyncFailed',
  'toast.externalContextBusy', 'toast.externalContextUnsaved',
  'toast.baseCreateBlocked', 'toast.baseCreateFailed',
  'toast.importCancelled', 'toast.importFailed',
  'toast.excelExportFailed', 'toast.bulkDeleteFailed',
  'toast.workbenchInitFailed',
  'confirm.discardContextChanges', 'confirm.discardRecordChanges',
  'confirm.pageLeaveBusy', 'confirm.pageLeaveDirty',
  'card.install', 'card.installing',
  'error.loadSheets', 'error.loadSheetMetadata', 'error.loadBaseMetadata',
]

describe('workbench-labels static table', () => {
  it('every key resolves to a non-empty en and zh string', () => {
    for (const key of ALL_KEYS) {
      const en = workbenchLabel(key, false)
      const zh = workbenchLabel(key, true)
      expect(en, `en empty for ${key}`).toBeTruthy()
      expect(zh, `zh empty for ${key}`).toBeTruthy()
    }
  })

  it('en and zh differ for every translatable key', () => {
    for (const key of ALL_KEYS) {
      const en = workbenchLabel(key, false)
      const zh = workbenchLabel(key, true)
      expect(en, `en===zh for ${key}: ${en}`).not.toBe(zh)
    }
  })

  it('isZh selects the correct branch for a representative sample', () => {
    expect(workbenchLabel('toolbar.fields', true)).toBe('字段')
    expect(workbenchLabel('toolbar.fields', false)).toBe('Fields')
    expect(workbenchLabel('conflict.fieldFallback', true)).toBe('单元格')
    expect(workbenchLabel('conflict.fieldFallback', false)).toBe('cell')
    expect(workbenchLabel('card.install', true)).toBe('使用模板')
    expect(workbenchLabel('card.installing', false)).toBe('Installing...')
    expect(workbenchLabel('error.loadSheets', true)).toBe('加载 Sheet 失败')
    expect(workbenchLabel('error.loadSheetMetadata', false)).toBe('Failed to load sheet metadata')
  })
})

describe('workbench-labels interpolation helpers', () => {
  it('conflictMessage includes the version segment only when version is finite, never literal brackets', () => {
    const withVer = conflictMessage('Status', 7, true)
    expect(withVer).toContain('Status')
    expect(withVer).toContain('最新版本为 7')
    expect(withVer).not.toContain('[')
    expect(withVer).not.toContain(']')

    const noVerZh = conflictMessage('Status', null, true)
    expect(noVerZh).not.toContain('最新版本')
    expect(noVerZh).not.toContain('[')

    const noVerEn = conflictMessage('Status', undefined, false)
    expect(noVerEn).toBe('Status changed elsewhere. Reload the row or retry your edit.')
    expect(noVerEn).not.toContain('[')

    // NaN / non-finite is treated as "no version"
    expect(conflictMessage('Cell', Number.NaN, false)).not.toContain('Latest version')
  })

  it('presenceLabel pluralizes en, zh has no plural', () => {
    expect(presenceLabel(1, false)).toBe('1 active collaborator')
    expect(presenceLabel(3, false)).toBe('3 active collaborators')
    expect(presenceLabel(1, true)).toBe('1 位活跃协作者')
    expect(presenceLabel(3, true)).toBe('3 位活跃协作者')
  })

  it('presenceTitle handles empty and non-empty id lists, ids are not translated', () => {
    expect(presenceTitle([], false)).toBe('No active collaborators')
    expect(presenceTitle([], true)).toBe('无活跃协作者')
    expect(presenceTitle(['u_1', 'u_2'], false)).toBe('Active now: u_1, u_2')
    expect(presenceTitle(['u_1', 'u_2'], true)).toBe('当前在线：u_1, u_2')
  })

  it('commentInboxTitle switches on the badge count (0 = open-inbox title)', () => {
    expect(commentInboxTitle(0, false)).toBe('Open comment inbox')
    expect(commentInboxTitle(0, true)).toBe('打开评论收件箱')
    expect(commentInboxTitle(5, false)).toBe('5 comment updates need attention')
    expect(commentInboxTitle(5, true)).toBe('5 条评论待处理')
  })

  it('mentions + card count helpers interpolate n and pluralize en', () => {
    expect(mentionsUnread(2, true)).toBe('2 条未读')
    expect(mentionsUnread(2, false)).toBe('2 unread')
    expect(mentionsRecords(1, false)).toBe('1 record')
    expect(mentionsRecords(4, false)).toBe('4 records')
    expect(mentionsRecords(4, true)).toBe('4 条记录')

    expect(cardSheets(1, true)).toBe('1 个 Sheet')
    expect(cardSheets(1, false)).toBe('1 sheet')
    expect(cardSheets(2, false)).toBe('2 sheets')
    expect(cardFields(0, true)).toBe('0 个字段')
    expect(cardFields(0, false)).toBe('0 fields')
    expect(cardViews(3, true)).toBe('3 个视图')
    expect(cardViews(1, false)).toBe('1 view')
  })

  it('templateInstalled localizes surrounding chrome and keeps template name raw', () => {
    expect(templateInstalled('CRM Pipeline', false)).toBe('Installed CRM Pipeline')
    expect(templateInstalled('CRM Pipeline', true)).toBe('已安装 CRM Pipeline')
    expect(templateInstalled('合同管理', true)).toBe('已安装 合同管理')
  })

  it('formSubmitSuccess switches on the explicit create/update discriminator', () => {
    expect(formSubmitSuccess('create', false)).toBe('Record created')
    expect(formSubmitSuccess('update', false)).toBe('Changes saved')
    expect(formSubmitSuccess('create', true)).toBe('记录已创建')
    expect(formSubmitSuccess('update', true)).toBe('更改已保存')
  })

  it('dynamic count helpers pluralize en and keep zh count forms stable', () => {
    expect(recordsImported(1, false)).toBe('1 record imported')
    expect(recordsImported(3, false)).toBe('3 records imported')
    expect(recordsImported(3, true)).toBe('3 条记录已导入')

    expect(duplicateRowsSkipped(1, false)).toBe('1 duplicate row skipped')
    expect(duplicateRowsSkipped(2, false)).toBe('2 duplicate rows skipped')
    expect(duplicateRowsSkipped(2, true)).toBe('2 条重复行已跳过')

    expect(recordsDeleted(1, false)).toBe('1 record deleted')
    expect(recordsDeleted(4, false)).toBe('4 records deleted')
    expect(recordsDeleted(4, true)).toBe('4 条记录已删除')
  })

  it('recordsFailedToImport formats row chrome and preserves raw firstError', () => {
    expect(recordsFailedToImport(1, [2], 'Bad value', false)).toBe('1 record failed to import (row 2). Bad value')
    expect(recordsFailedToImport(2, [2, 3], 'Invalid SKU', false)).toBe('2 records failed to import (row 2, row 3). Invalid SKU')
    expect(recordsFailedToImport(2, [2, 3], 'Invalid SKU', true)).toBe('2 条记录导入失败（第 2 行，第 3 行）。Invalid SKU')
    expect(recordsFailedToImport(2, [], '', true)).toBe('2 条记录导入失败')
  })

  it('recordNotFound localizes surrounding chrome and keeps record id raw', () => {
    expect(recordNotFound('rec_abc123', false)).toBe('Record not found: rec_abc123')
    expect(recordNotFound('rec_abc123', true)).toBe('未找到记录：rec_abc123')
  })
})
