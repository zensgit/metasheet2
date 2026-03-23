import type { PlmWorkbenchTeamView } from './plm/plmPanelModels'

export type PlmAuditTeamViewShareEntryActionKind = 'save-local' | 'duplicate' | 'set-default' | 'dismiss'

export type PlmAuditTeamViewShareEntry = {
  teamViewId: string
}

export type PlmAuditTeamViewShareEntryAction =
  | { kind: 'filter-navigation' }
  | { kind: 'route-query'; auditEntry: unknown }

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

export type PlmAuditSharedEntryRouteSyncDecision = {
  shouldSync: boolean
  replace: boolean
}

export function shouldResolvePlmAuditSharedEntryOnQueryChange(options: {
  routeReady: boolean
  routeChanged: boolean
  teamViewId: string
  nextAuditEntry: unknown
  previousAuditEntry: unknown
}) {
  return options.routeReady
    && !options.routeChanged
    && Boolean(options.teamViewId.trim())
    && isPlmAuditSharedLinkEntry(options.nextAuditEntry)
    && !isPlmAuditSharedLinkEntry(options.previousAuditEntry)
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
  if (!view.isArchived) {
    actions.push({
      kind: 'save-local',
      label: tr('Save as local view', '保存为本地视图'),
      emphasis: 'primary',
    })
  }
  if (options.canDuplicate && !view.isArchived) {
    actions.push({
      kind: 'duplicate',
      label: tr('Duplicate for my workflow', '复制为我的工作流视图'),
      emphasis: 'secondary',
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

export function buildPlmAuditSharedEntrySavedViewName(
  view: Pick<PlmWorkbenchTeamView<'audit'>, 'name'>,
  tr: (en: string, zh: string) => string,
) {
  return `${view.name} · ${tr('Local view', '本地视图')}`
}

export function resolvePlmAuditSharedEntryRouteSyncDecision(options: {
  routeChanged: boolean
  replace: boolean
  consumeSharedEntry?: boolean
  auditEntry: unknown
}): PlmAuditSharedEntryRouteSyncDecision {
  const shouldConsumeSharedEntry = Boolean(options.consumeSharedEntry)
    && isPlmAuditSharedLinkEntry(options.auditEntry)

  return {
    shouldSync: options.routeChanged || shouldConsumeSharedEntry,
    replace: options.replace || !options.routeChanged,
  }
}

export function reducePlmAuditTeamViewShareEntry(
  entry: PlmAuditTeamViewShareEntry | null,
  action: PlmAuditTeamViewShareEntryAction,
): PlmAuditTeamViewShareEntry | null {
  if (!entry) return null

  if (action.kind === 'filter-navigation') {
    return null
  }

  if (action.kind === 'route-query' && !isPlmAuditSharedLinkEntry(action.auditEntry)) {
    return null
  }

  return entry
}

export function shouldKeepPlmAuditTeamViewShareEntry(
  entry: Pick<PlmAuditTeamViewShareEntry, 'teamViewId'> | null,
  teamViewId: string,
) {
  return entry?.teamViewId === teamViewId
}

export function findPlmAuditTeamViewShareEntryView<T extends { id: string }>(
  views: readonly T[],
  entry: Pick<PlmAuditTeamViewShareEntry, 'teamViewId'> | null,
): T | null {
  if (!entry) return null
  return views.find((view) => view.id === entry.teamViewId) || null
}

export function resolvePlmAuditTeamViewShareEntryActionTarget<T>(
  entryTarget: T | null,
  _selectedTarget: T | null,
) {
  return entryTarget
}

export function resolvePlmAuditSharedEntryTakeoverSelection(
  _selectedIds: string[],
) {
  return []
}

export function prunePlmAuditTeamViewShareEntryForRemovedViews(
  entry: PlmAuditTeamViewShareEntry | null,
  removedViewIds: readonly string[],
): PlmAuditTeamViewShareEntry | null {
  if (!entry || !removedViewIds.includes(entry.teamViewId)) return entry
  return null
}

export function shouldTakeOverPlmAuditSharedEntryOnLocalSave(
  entry: Pick<PlmAuditTeamViewShareEntry, 'teamViewId'> | null,
  selectedTeamViewId: string,
) {
  return shouldKeepPlmAuditTeamViewShareEntry(entry, selectedTeamViewId)
}

export function shouldTakeOverPlmAuditSharedEntryOnManagementHandoff(
  entry: Pick<PlmAuditTeamViewShareEntry, 'teamViewId'> | null,
  targetTeamViewId: string,
) {
  return shouldKeepPlmAuditTeamViewShareEntry(entry, targetTeamViewId)
}

export function shouldTakeOverPlmAuditSharedEntryOnSavedViewTakeover(
  entry: Pick<PlmAuditTeamViewShareEntry, 'teamViewId'> | null,
) {
  return Boolean(entry)
}

export function shouldTakeOverPlmAuditSharedEntryOnSceneContextTakeover(
  entry: Pick<PlmAuditTeamViewShareEntry, 'teamViewId'> | null,
) {
  return Boolean(entry)
}

export function shouldTakeOverPlmAuditSharedEntryOnSourceAction(
  entry: Pick<PlmAuditTeamViewShareEntry, 'teamViewId'> | null,
  sourceAware: boolean,
  targetTeamViewId: string,
) {
  return sourceAware && shouldKeepPlmAuditTeamViewShareEntry(entry, targetTeamViewId)
}
