import type { PlmWorkbenchTeamView } from './plm/plmPanelModels'

export type PlmAuditTeamViewShareEntryActionKind = 'duplicate' | 'set-default' | 'dismiss'

export type PlmAuditTeamViewShareEntry = {
  teamViewId: string
}

export type PlmAuditTeamViewShareEntryNotice = {
  sourceLabel: string
  title: string
  description: string
  actions: Array<{
    kind: PlmAuditTeamViewShareEntryActionKind
    label: string
    emphasis: 'primary' | 'secondary'
  }>
}

export function isPlmAuditSharedLinkEntry(value: unknown) {
  return value === 'share'
}

export function buildPlmAuditTeamViewShareEntryNotice(
  view: Pick<PlmWorkbenchTeamView<'audit'>, 'id' | 'isDefault' | 'isArchived'>,
  entry: PlmAuditTeamViewShareEntry | null,
  options: {
    canDuplicate: boolean
    canSetDefault: boolean
  },
  tr: (en: string, zh: string) => string,
): PlmAuditTeamViewShareEntryNotice | null {
  if (!entry || entry.teamViewId !== view.id) return null

  const actions: PlmAuditTeamViewShareEntryNotice['actions'] = []
  if (options.canDuplicate && !view.isArchived) {
    actions.push({
      kind: 'duplicate',
      label: tr('Duplicate for my workflow', '复制为我的工作流视图'),
      emphasis: 'primary',
    })
  }
  if (options.canSetDefault && !view.isArchived && !view.isDefault) {
    actions.push({
      kind: 'set-default',
      label: tr('Set as default', '设为默认'),
      emphasis: actions.length ? 'secondary' : 'primary',
    })
  }
  actions.push({
    kind: 'dismiss',
    label: tr('Dismiss', '关闭'),
    emphasis: 'secondary',
  })

  return {
    sourceLabel: tr('Shared team view link', '团队视图分享链接'),
    title: tr('Opened from a shared audit team view.', '已通过分享链接打开审计团队视图。'),
    description: tr(
      'This team view came from a share link. You can keep exploring it, duplicate it into your own workflow, or promote it to the default audit entry.',
      '这个团队视图来自分享链接。你可以继续查看，也可以复制到自己的工作流里，或将其提升为默认审计入口。',
    ),
    actions,
  }
}
