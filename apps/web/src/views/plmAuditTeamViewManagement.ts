import type { PlmWorkbenchTeamView } from './plm/plmPanelModels'

export type PlmAuditTeamViewLifecycleActionKind = 'archive' | 'restore' | 'delete'

export type PlmAuditTeamViewLifecycleAction = {
  kind: PlmAuditTeamViewLifecycleActionKind
  label: string
  disabled: boolean
  hint: string
}

export type PlmAuditTeamViewManagementItem = {
  id: string
  name: string
  ownerUserId: string
  isDefault: boolean
  isArchived: boolean
  updatedAt?: string
  selected: boolean
  selectable: boolean
  selectionHint: string
  lifecycleActions: PlmAuditTeamViewLifecycleAction[]
}

export type PlmAuditTeamViewBatchAction = {
  kind: PlmAuditTeamViewLifecycleActionKind
  label: string
  disabled: boolean
  hint: string
  eligibleCount: number
  eligibleIds: string[]
}

export type PlmAuditTeamViewManagementModel = {
  items: PlmAuditTeamViewManagementItem[]
  batchActions: PlmAuditTeamViewBatchAction[]
  selectedCount: number
  selectableCount: number
}

export function canManagePlmAuditTeamView(
  view: Pick<PlmWorkbenchTeamView<'audit'>, 'canManage' | 'permissions'>,
) {
  if (typeof view.permissions?.canManage === 'boolean') {
    return view.permissions.canManage
  }
  return Boolean(view.canManage)
}

function canArchiveAuditTeamView(view: PlmWorkbenchTeamView<'audit'>) {
  if (view.isArchived) return false
  return view.permissions?.canArchive ?? view.canManage
}

function canRestoreAuditTeamView(view: PlmWorkbenchTeamView<'audit'>) {
  if (!view.isArchived) return false
  return view.permissions?.canRestore ?? view.canManage
}

function canDeleteAuditTeamView(view: PlmWorkbenchTeamView<'audit'>) {
  return view.permissions?.canDelete ?? view.canManage
}

export function canApplyPlmAuditTeamView(view: Pick<PlmWorkbenchTeamView<'audit'>, 'isArchived' | 'permissions'>) {
  if (typeof view.permissions?.canApply === 'boolean') {
    return view.permissions.canApply
  }
  return !view.isArchived
}

export function isSelectablePlmAuditTeamView(view: PlmWorkbenchTeamView<'audit'>) {
  return canArchiveAuditTeamView(view)
    || canRestoreAuditTeamView(view)
    || canDeleteAuditTeamView(view)
}

function buildLifecycleActions(
  view: PlmWorkbenchTeamView<'audit'>,
  tr: (en: string, zh: string) => string,
): PlmAuditTeamViewLifecycleAction[] {
  const actions: PlmAuditTeamViewLifecycleAction[] = []

  if (canArchiveAuditTeamView(view)) {
    actions.push({
      kind: 'archive',
      label: tr('Archive', '归档'),
      disabled: false,
      hint: tr('Archive this team view and remove it from active recommendations.', '归档这个团队视图，并从活跃推荐里移除。'),
    })
  }

  if (canRestoreAuditTeamView(view)) {
    actions.push({
      kind: 'restore',
      label: tr('Restore', '恢复'),
      disabled: false,
      hint: tr('Restore this archived team view back into the active catalog.', '把这个已归档团队视图恢复到活跃目录。'),
    })
  }

  if (canDeleteAuditTeamView(view)) {
    actions.push({
      kind: 'delete',
      label: tr('Delete', '删除'),
      disabled: false,
      hint: tr('Delete this team view permanently.', '永久删除这个团队视图。'),
    })
  }

  return actions
}

function buildBatchAction(
  kind: PlmAuditTeamViewLifecycleActionKind,
  selectedViews: PlmWorkbenchTeamView<'audit'>[],
  tr: (en: string, zh: string) => string,
): PlmAuditTeamViewBatchAction {
  const eligibleIds = selectedViews
    .filter((view) => {
      if (kind === 'archive') return canArchiveAuditTeamView(view)
      if (kind === 'restore') return canRestoreAuditTeamView(view)
      return canDeleteAuditTeamView(view)
    })
    .map((view) => view.id)

  const labels: Record<PlmAuditTeamViewLifecycleActionKind, string> = {
    archive: tr('Batch archive', '批量归档'),
    restore: tr('Batch restore', '批量恢复'),
    delete: tr('Batch delete', '批量删除'),
  }

  let hint = tr('Select one or more team views first.', '请先选择一个或多个团队视图。')
  if (selectedViews.length && eligibleIds.length === 0) {
    hint = kind === 'archive'
      ? tr('None of the selected views can be archived.', '所选视图都不能归档。')
      : kind === 'restore'
        ? tr('None of the selected views can be restored.', '所选视图都不能恢复。')
        : tr('None of the selected views can be deleted.', '所选视图都不能删除。')
  }
  if (eligibleIds.length > 0) {
    hint = kind === 'archive'
      ? tr('Archive the selected active team views.', '归档所选的活跃团队视图。')
      : kind === 'restore'
        ? tr('Restore the selected archived team views.', '恢复所选的已归档团队视图。')
        : tr('Delete the selected team views permanently.', '永久删除所选团队视图。')
  }

  return {
    kind,
    label: labels[kind],
    disabled: eligibleIds.length === 0,
    hint,
    eligibleCount: eligibleIds.length,
    eligibleIds,
  }
}

export function buildPlmAuditTeamViewManagement(
  views: PlmWorkbenchTeamView<'audit'>[],
  selectedIds: string[],
  tr: (en: string, zh: string) => string,
): PlmAuditTeamViewManagementModel {
  const selectedSet = new Set(selectedIds)
  const items = views.map<PlmAuditTeamViewManagementItem>((view) => {
    const lifecycleActions = buildLifecycleActions(view, tr)
    return {
      id: view.id,
      name: view.name,
      ownerUserId: view.ownerUserId,
      isDefault: Boolean(view.isDefault),
      isArchived: Boolean(view.isArchived),
      updatedAt: view.updatedAt || view.createdAt,
      selected: selectedSet.has(view.id),
      selectable: isSelectablePlmAuditTeamView(view),
      selectionHint: lifecycleActions.length
        ? ''
        : tr('This team view is read-only in the current account.', '当前账号对这个团队视图只有只读权限。'),
      lifecycleActions,
    }
  })

  const selectedViews = views.filter((view) => selectedSet.has(view.id))
  const batchActions = (['archive', 'restore', 'delete'] as const).map((kind) =>
    buildBatchAction(kind, selectedViews, tr))

  return {
    items,
    batchActions,
    selectedCount: selectedViews.length,
    selectableCount: items.filter((item) => item.selectable).length,
  }
}
