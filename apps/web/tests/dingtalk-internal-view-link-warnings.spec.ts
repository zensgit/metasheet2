import { describe, expect, it } from 'vitest'

import {
  listDingTalkInternalViewLinkBlockingErrors,
  listDingTalkInternalViewLinkWarnings,
} from '../src/multitable/utils/dingtalkInternalViewLinkWarnings'

const views = [
  { id: 'view_grid', name: 'Grid' },
  { id: 'view_form', name: 'Public Form' },
]

describe('dingtalk internal view link warnings', () => {
  it('returns no warning for empty or available internal views', () => {
    expect(listDingTalkInternalViewLinkBlockingErrors('', views)).toEqual([])
    expect(listDingTalkInternalViewLinkBlockingErrors('view_grid', views)).toEqual([])
    expect(listDingTalkInternalViewLinkWarnings('view_form', views)).toEqual([])
  })

  it('blocks missing internal processing views', () => {
    expect(listDingTalkInternalViewLinkBlockingErrors('missing_view', views)).toEqual([
      'Internal processing view "missing_view" is not available in this sheet; DingTalk messages may not include a working processing link.',
    ])
    expect(listDingTalkInternalViewLinkWarnings('missing_view', views)).toEqual([
      'Internal processing view "missing_view" is not available in this sheet; DingTalk messages may not include a working processing link.',
    ])
  })

  it('localizes missing internal processing view warnings while preserving raw ids', () => {
    expect(listDingTalkInternalViewLinkBlockingErrors('missing_view', views, true)).toEqual([
      '内部处理视图 "missing_view" 在此表中不可用；钉钉消息可能不包含可用的处理链接。',
    ])
  })
})
