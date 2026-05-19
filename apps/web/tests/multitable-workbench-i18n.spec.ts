import { describe, expect, it } from 'vitest'
import {
  workbenchLabel,
  conflictMessage,
  presenceLabel,
  presenceTitle,
  commentInboxTitle,
  mentionsUnread,
  mentionsRecords,
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
  'tpl.title', 'tpl.subtitle', 'tpl.loading', 'tpl.more',
  'kbd.title', 'kbd.navigateCells', 'kbd.editCell', 'kbd.cancelClose',
  'kbd.nextCell', 'kbd.copy', 'kbd.paste', 'kbd.undo', 'kbd.redo',
  'kbd.toggleHelp',
  'toast.recordCreateBlocked', 'toast.recordEditBlocked', 'toast.recordDeleteBlocked',
  'toast.datesUpdated', 'toast.hierarchyUpdated', 'toast.recordDeleted',
  'toast.loadedLatest', 'toast.changeReapplied', 'toast.recordUpdated',
  'toast.formSubmitted', 'toast.commentUpdated', 'toast.commentAdded',
  'toast.commentResolved', 'toast.commentDeleted', 'toast.linkedRecordsUpdated',
  'toast.viewSettingsSaved',
  'card.install', 'card.installing',
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
})
