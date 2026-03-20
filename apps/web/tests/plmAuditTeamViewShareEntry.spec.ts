import { describe, expect, it } from 'vitest'
import {
  buildPlmAuditTeamViewShareEntryNotice,
  isPlmAuditSharedLinkEntry,
} from '../src/views/plmAuditTeamViewShareEntry'

function tr(en: string, zh: string) {
  return `${en}|${zh}`
}

describe('plmAuditTeamViewShareEntry', () => {
  it('detects share-entry query markers', () => {
    expect(isPlmAuditSharedLinkEntry('share')).toBe(true)
    expect(isPlmAuditSharedLinkEntry('')).toBe(false)
    expect(isPlmAuditSharedLinkEntry(undefined)).toBe(false)
  })

  it('builds shared-link entry actions for active team views', () => {
    expect(buildPlmAuditTeamViewShareEntryNotice({
      id: 'audit-view-1',
      isDefault: false,
      isArchived: false,
    }, {
      teamViewId: 'audit-view-1',
    }, {
      canDuplicate: true,
      canSetDefault: true,
    }, tr)).toEqual({
      sourceLabel: 'Shared team view link|团队视图分享链接',
      title: 'Opened from a shared audit team view.|已通过分享链接打开审计团队视图。',
      description:
        'This team view came from a share link. You can keep exploring it, duplicate it into your own workflow, or promote it to the default audit entry.|这个团队视图来自分享链接。你可以继续查看，也可以复制到自己的工作流里，或将其提升为默认审计入口。',
      actions: [
        {
          kind: 'duplicate',
          label: 'Duplicate for my workflow|复制为我的工作流视图',
          emphasis: 'primary',
        },
        {
          kind: 'set-default',
          label: 'Set as default|设为默认',
          emphasis: 'secondary',
        },
        {
          kind: 'dismiss',
          label: 'Dismiss|关闭',
          emphasis: 'secondary',
        },
      ],
    })
  })

  it('omits unavailable actions for default archived views', () => {
    expect(buildPlmAuditTeamViewShareEntryNotice({
      id: 'audit-view-2',
      isDefault: true,
      isArchived: true,
    }, {
      teamViewId: 'audit-view-2',
    }, {
      canDuplicate: false,
      canSetDefault: false,
    }, tr)?.actions).toEqual([
      {
        kind: 'dismiss',
        label: 'Dismiss|关闭',
        emphasis: 'secondary',
      },
    ])
  })
})
