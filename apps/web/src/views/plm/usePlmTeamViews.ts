import { computed, ref, shallowRef, type Ref } from 'vue'
import {
  archivePlmWorkbenchTeamView,
  batchPlmWorkbenchTeamViews,
  duplicatePlmWorkbenchTeamView,
  clearPlmWorkbenchTeamViewDefault,
  deletePlmWorkbenchTeamView,
  listPlmWorkbenchTeamViews,
  renamePlmWorkbenchTeamView,
  restorePlmWorkbenchTeamView,
  savePlmWorkbenchTeamView,
  setPlmWorkbenchTeamViewDefault,
  transferPlmWorkbenchTeamView,
  type PlmWorkbenchTeamViewBatchAction,
} from '../../services/plm/plmWorkbenchClient'
import type {
  PlmWorkbenchTeamView,
  PlmWorkbenchTeamViewKind,
  PlmWorkbenchTeamViewStateByKind,
} from './plmPanelModels'
import { canApplyPlmCollaborativeEntry, usePlmCollaborativePermissions } from './usePlmCollaborativePermissions'

type UsePlmTeamViewsOptions<Kind extends PlmWorkbenchTeamViewKind> = {
  kind: Kind
  label: string
  getCurrentViewState: () => PlmWorkbenchTeamViewStateByKind[Kind]
  applyViewState: (state: PlmWorkbenchTeamViewStateByKind[Kind]) => void
  setMessage: (message: string, isError?: boolean) => void
  shouldAutoApplyDefault?: () => boolean
  requestedViewId?: Ref<string>
  syncRequestedViewId?: (value?: string) => void
  buildShareUrl?: (view: PlmWorkbenchTeamView<Kind>) => string
  copyShareUrl?: (url: string) => Promise<boolean>
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message
  }
  return fallback
}

function getViewTimestamp(view: PlmWorkbenchTeamView) {
  const raw = view.updatedAt || view.createdAt || ''
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

function sortTeamViews<Kind extends PlmWorkbenchTeamViewKind>(views: PlmWorkbenchTeamView<Kind>[]) {
  return [...views].sort((left, right) => {
    if (Boolean(left.isArchived) !== Boolean(right.isArchived)) {
      return Number(Boolean(left.isArchived)) - Number(Boolean(right.isArchived))
    }
    if (left.isDefault !== right.isDefault) {
      return Number(right.isDefault) - Number(left.isDefault)
    }
    return getViewTimestamp(right) - getViewTimestamp(left)
  })
}

function upsertTeamView<Kind extends PlmWorkbenchTeamViewKind>(
  views: PlmWorkbenchTeamView<Kind>[],
  view: PlmWorkbenchTeamView<Kind>,
) {
  const next = views.filter((entry) => entry.id !== view.id)
  next.unshift(view)
  return sortTeamViews(next)
}

function applyDefaultTeamViewUpdate<Kind extends PlmWorkbenchTeamViewKind>(
  views: PlmWorkbenchTeamView<Kind>[],
  view: PlmWorkbenchTeamView<Kind>,
) {
  const next = views.map((entry) => {
    if (entry.id === view.id) return view
    return entry.isDefault ? { ...entry, isDefault: false } : entry
  })
  return sortTeamViews(next as PlmWorkbenchTeamView<Kind>[])
}

function replaceTeamView<Kind extends PlmWorkbenchTeamViewKind>(
  views: PlmWorkbenchTeamView<Kind>[],
  view: PlmWorkbenchTeamView<Kind>,
) {
  return sortTeamViews(views.map((entry) => (entry.id === view.id ? view : entry)) as PlmWorkbenchTeamView<Kind>[])
}

export function usePlmTeamViews<Kind extends PlmWorkbenchTeamViewKind>(
  options: UsePlmTeamViewsOptions<Kind>,
) {
  const teamViewKey = ref('')
  const teamViewName = ref('')
  const teamViewOwnerUserId = ref('')
  const teamViews = shallowRef<PlmWorkbenchTeamView<Kind>[]>([])
  const teamViewsLoading = ref(false)
  const teamViewsError = ref('')
  const lastAutoAppliedDefaultId = ref('')
  const showTeamViewManager = ref(false)
  const teamViewSelection = ref<string[]>([])

  const selectedTeamView = computed(
    () => teamViews.value.find((view) => view.id === teamViewKey.value) || null,
  )
  const defaultTeamView = computed(
    () => teamViews.value.find((view) => view.isDefault && !view.isArchived) || null,
  )
  const manageableTeamViews = computed(
    () => teamViews.value.filter((view) => Boolean(view.permissions?.canManage ?? view.canManage)),
  )
  const selectedTeamViewEntries = computed(() => {
    const selectedIds = new Set(teamViewSelection.value)
    return teamViews.value.filter((view) => selectedIds.has(view.id))
  })
  const teamViewSelectionCount = computed(() => selectedTeamViewEntries.value.length)
  const hasManageableTeamViews = computed(() => manageableTeamViews.value.length > 0)
  const selectedBatchArchivableTeamViewIds = computed(() =>
    selectedTeamViewEntries.value
      .filter((view) => Boolean(view.permissions?.canArchive ?? (view.canManage && !view.isArchived)))
      .map((view) => view.id),
  )
  const selectedBatchRestorableTeamViewIds = computed(() =>
    selectedTeamViewEntries.value
      .filter((view) => Boolean(view.permissions?.canRestore ?? (view.canManage && view.isArchived)))
      .map((view) => view.id),
  )
  const selectedBatchDeletableTeamViewIds = computed(() =>
    selectedTeamViewEntries.value
      .filter((view) => Boolean(view.permissions?.canDelete ?? view.canManage))
      .map((view) => view.id),
  )

  const canSaveTeamView = computed(() => Boolean(teamViewName.value.trim()))
  const {
    canManageSelectedEntry: canManageSelectedTeamView,
    showManagementActions,
    canApply: canApplyTeamView,
    canDuplicate: canDuplicateTeamView,
    canShare: canShareTeamView,
    canDelete: canDeleteTeamView,
    canArchive: canArchiveTeamView,
    canRestore: canRestoreTeamView,
    canRename: canRenameTeamView,
    canTransfer: canTransferTeamView,
    canSetDefault: canSetTeamViewDefault,
    canClearDefault: canClearTeamViewDefault,
  } = usePlmCollaborativePermissions({
    selectedEntry: selectedTeamView,
    nameRef: teamViewName,
    ownerUserIdRef: teamViewOwnerUserId,
  })
  const defaultTeamViewLabel = computed(() => defaultTeamView.value?.name || '')

  function applyView(view: PlmWorkbenchTeamView<Kind>) {
    teamViewKey.value = view.id
    options.syncRequestedViewId?.(view.id)
    options.applyViewState(view.state)
  }

  function maybeAutoApplyDefault(items: PlmWorkbenchTeamView<Kind>[]) {
    if (teamViewKey.value) return
    const requestedViewId = options.requestedViewId?.value.trim() || ''
    if (requestedViewId) {
      const requestedView = items.find((entry) => entry.id === requestedViewId && !entry.isArchived)
      if (requestedView) {
        applyView(requestedView)
        return
      }
      options.syncRequestedViewId?.(undefined)
    }
    if (!options.shouldAutoApplyDefault?.()) return

    const view = items.find((entry) => entry.isDefault)
    if (!view) return
    if (lastAutoAppliedDefaultId.value === view.id) return

    applyView(view)
    lastAutoAppliedDefaultId.value = view.id
    options.setMessage(`已应用${options.label}默认团队视角：${view.name}`)
  }

  async function refreshTeamViews() {
    teamViewsLoading.value = true
    teamViewsError.value = ''
    try {
      const result = await listPlmWorkbenchTeamViews(options.kind)
      const items = result.items as PlmWorkbenchTeamView<Kind>[]
      teamViews.value = sortTeamViews(items)
      const availableIds = new Set(items.map((view) => view.id))
      teamViewSelection.value = teamViewSelection.value.filter((id) => availableIds.has(id))
      if (!items.some((view) => view.id === teamViewKey.value)) {
        teamViewKey.value = ''
      }
      if (options.requestedViewId?.value && !items.some((view) => view.id === options.requestedViewId?.value)) {
        options.syncRequestedViewId?.(undefined)
      }
      maybeAutoApplyDefault(teamViews.value)
    } catch (error) {
      teamViewsError.value = getErrorMessage(error, `加载${options.label}团队视角失败`)
    } finally {
      teamViewsLoading.value = false
    }
  }

  async function saveTeamView() {
    if (!canSaveTeamView.value) {
      options.setMessage(`请输入${options.label}团队视角名称。`, true)
      return
    }

    teamViewsLoading.value = true
    teamViewsError.value = ''
    try {
      const saved = await savePlmWorkbenchTeamView(
        options.kind,
        teamViewName.value.trim(),
        options.getCurrentViewState(),
      )
      teamViews.value = upsertTeamView(teamViews.value, saved)
      applyView(saved)
      teamViewName.value = ''
      options.setMessage(`已保存${options.label}团队视角。`)
    } catch (error) {
      teamViewsError.value = getErrorMessage(error, `保存${options.label}团队视角失败`)
      options.setMessage(teamViewsError.value, true)
    } finally {
      teamViewsLoading.value = false
    }
  }

  function applyTeamView() {
    const view = selectedTeamView.value
    if (!view) {
      options.setMessage(`请选择${options.label}团队视角。`, true)
      return
    }
    if (!canApplyPlmCollaborativeEntry(view)) {
      options.setMessage(`请先恢复${options.label}团队视角，再执行应用。`, true)
      return
    }

    applyView(view)
    options.setMessage(`已应用${options.label}团队视角：${view.name}`)
  }

  async function deleteTeamView() {
    const view = selectedTeamView.value
    if (!view) return
    if (!view.canManage) {
      options.setMessage(`仅创建者可删除${options.label}团队视角。`, true)
      return
    }

    teamViewsLoading.value = true
    teamViewsError.value = ''
    try {
      await deletePlmWorkbenchTeamView(view.id)
      teamViews.value = teamViews.value.filter((entry) => entry.id !== view.id)
      if (teamViewKey.value === view.id) {
        teamViewKey.value = ''
        teamViewName.value = ''
      }
      if (options.requestedViewId?.value === view.id) {
        options.syncRequestedViewId?.(undefined)
      }
      if (lastAutoAppliedDefaultId.value === view.id) {
        lastAutoAppliedDefaultId.value = ''
      }
      options.setMessage(`已删除${options.label}团队视角。`)
    } catch (error) {
      teamViewsError.value = getErrorMessage(error, `删除${options.label}团队视角失败`)
      options.setMessage(teamViewsError.value, true)
    } finally {
      teamViewsLoading.value = false
    }
  }

  async function archiveTeamView() {
    const view = selectedTeamView.value
    if (!view) {
      options.setMessage(`请选择${options.label}团队视角。`, true)
      return
    }
    if (!view.canManage) {
      options.setMessage(`仅创建者可归档${options.label}团队视角。`, true)
      return
    }
    if (view.isArchived) {
      options.setMessage(`${options.label}团队视角已归档。`)
      return
    }

    teamViewsLoading.value = true
    teamViewsError.value = ''
    try {
      const saved = await archivePlmWorkbenchTeamView(options.kind, view.id)
      teamViews.value = replaceTeamView(teamViews.value, saved)
      if (teamViewKey.value === view.id) {
        teamViewKey.value = ''
        teamViewName.value = ''
      }
      if (options.requestedViewId?.value === view.id) {
        options.syncRequestedViewId?.(undefined)
      }
      if (lastAutoAppliedDefaultId.value === view.id) {
        lastAutoAppliedDefaultId.value = ''
      }
      options.setMessage(`已归档${options.label}团队视角：${saved.name}`)
    } catch (error) {
      teamViewsError.value = getErrorMessage(error, `归档${options.label}团队视角失败`)
      options.setMessage(teamViewsError.value, true)
    } finally {
      teamViewsLoading.value = false
    }
  }

  async function restoreTeamView() {
    const view = selectedTeamView.value
    if (!view) {
      options.setMessage(`请选择${options.label}团队视角。`, true)
      return
    }
    if (!view.canManage) {
      options.setMessage(`仅创建者可恢复${options.label}团队视角。`, true)
      return
    }
    if (!view.isArchived) {
      options.setMessage(`${options.label}团队视角无需恢复。`)
      return
    }

    teamViewsLoading.value = true
    teamViewsError.value = ''
    try {
      const saved = await restorePlmWorkbenchTeamView(options.kind, view.id)
      teamViews.value = replaceTeamView(teamViews.value, saved)
      applyView(saved)
      teamViewName.value = ''
      options.setMessage(`已恢复${options.label}团队视角：${saved.name}`)
    } catch (error) {
      teamViewsError.value = getErrorMessage(error, `恢复${options.label}团队视角失败`)
      options.setMessage(teamViewsError.value, true)
    } finally {
      teamViewsLoading.value = false
    }
  }

  async function duplicateTeamView() {
    const view = selectedTeamView.value
    if (!view) {
      options.setMessage(`请选择${options.label}团队视角。`, true)
      return
    }

    teamViewsLoading.value = true
    teamViewsError.value = ''
    try {
      const duplicated = await duplicatePlmWorkbenchTeamView(
        options.kind,
        view.id,
        teamViewName.value.trim() || undefined,
      )
      teamViews.value = upsertTeamView(teamViews.value, duplicated)
      applyView(duplicated)
      teamViewName.value = ''
      options.setMessage(`已复制${options.label}团队视角：${duplicated.name}`)
    } catch (error) {
      teamViewsError.value = getErrorMessage(error, `复制${options.label}团队视角失败`)
      options.setMessage(teamViewsError.value, true)
    } finally {
      teamViewsLoading.value = false
    }
  }

  async function shareTeamView() {
    const view = selectedTeamView.value
    if (!view) {
      options.setMessage(`请选择${options.label}团队视角。`, true)
      return
    }
    if (view.isArchived) {
      options.setMessage(`请先恢复${options.label}团队视角，再执行分享。`, true)
      return
    }
    if (!canShareTeamView.value) {
      options.setMessage(`仅创建者可分享${options.label}团队视角。`, true)
      return
    }
    if (!options.buildShareUrl || !options.copyShareUrl) {
      options.setMessage(`${options.label}团队视角暂不支持分享。`, true)
      return
    }

    const ok = await options.copyShareUrl(options.buildShareUrl(view))
    if (!ok) {
      options.setMessage(`复制${options.label}团队视角分享链接失败`, true)
      return
    }
    options.setMessage(`已复制${options.label}团队视角分享链接。`)
  }

  async function renameTeamView() {
    const view = selectedTeamView.value
    if (!view) {
      options.setMessage(`请选择${options.label}团队视角。`, true)
      return
    }
    if (!view.canManage) {
      options.setMessage(`仅创建者可重命名${options.label}团队视角。`, true)
      return
    }
    if (!teamViewName.value.trim()) {
      options.setMessage(`请输入${options.label}团队视角名称。`, true)
      return
    }

    teamViewsLoading.value = true
    teamViewsError.value = ''
    try {
      const renamed = await renamePlmWorkbenchTeamView(
        options.kind,
        view.id,
        teamViewName.value.trim(),
      )
      teamViews.value = replaceTeamView(teamViews.value, renamed)
      applyView(renamed)
      teamViewName.value = ''
      options.setMessage(`已重命名${options.label}团队视角：${renamed.name}`)
    } catch (error) {
      teamViewsError.value = getErrorMessage(error, `重命名${options.label}团队视角失败`)
      options.setMessage(teamViewsError.value, true)
    } finally {
      teamViewsLoading.value = false
    }
  }

  async function setTeamViewDefault() {
    const view = selectedTeamView.value
    if (!view) {
      options.setMessage(`请选择${options.label}团队视角。`, true)
      return
    }
    if (!view.canManage) {
      options.setMessage(`仅创建者可设置${options.label}默认团队视角。`, true)
      return
    }
    if (view.isArchived) {
      options.setMessage(`请先恢复${options.label}团队视角，再设为默认。`, true)
      return
    }

    teamViewsLoading.value = true
    teamViewsError.value = ''
    try {
      const saved = await setPlmWorkbenchTeamViewDefault(options.kind, view.id)
      teamViews.value = applyDefaultTeamViewUpdate(teamViews.value, saved)
      lastAutoAppliedDefaultId.value = saved.id
      applyView(saved)
      options.setMessage(`已设为${options.label}默认团队视角：${saved.name}`)
    } catch (error) {
      teamViewsError.value = getErrorMessage(error, `设置${options.label}默认团队视角失败`)
      options.setMessage(teamViewsError.value, true)
    } finally {
      teamViewsLoading.value = false
    }
  }

  async function transferTeamView() {
    const view = selectedTeamView.value
    const targetOwnerUserId = teamViewOwnerUserId.value.trim()
    if (!view) {
      options.setMessage(`请选择${options.label}团队视角。`, true)
      return
    }
    if (view.isArchived) {
      options.setMessage(`请先恢复${options.label}团队视角，再执行转移所有者。`, true)
      return
    }
    if (!targetOwnerUserId) {
      options.setMessage(`请输入${options.label}团队视角目标用户 ID。`, true)
      return
    }
    if (targetOwnerUserId === view.ownerUserId) {
      options.setMessage(`${options.label}团队视角已经属于该用户。`)
      return
    }
    if (!canManageSelectedTeamView.value) {
      options.setMessage(`仅创建者可转移${options.label}团队视角。`, true)
      return
    }

    teamViewsLoading.value = true
    teamViewsError.value = ''
    try {
      const saved = await transferPlmWorkbenchTeamView(options.kind, view.id, targetOwnerUserId)
      teamViews.value = replaceTeamView(teamViews.value, saved)
      applyView(saved)
      teamViewOwnerUserId.value = ''
      options.setMessage(`已将${options.label}团队视角转移给：${saved.ownerUserId}`)
    } catch (error) {
      teamViewsError.value = getErrorMessage(error, `转移${options.label}团队视角失败`)
      options.setMessage(teamViewsError.value, true)
    } finally {
      teamViewsLoading.value = false
    }
  }

  async function clearTeamViewDefault() {
    const view = selectedTeamView.value
    if (!view) {
      options.setMessage(`请选择${options.label}团队视角。`, true)
      return
    }
    if (!view.canManage) {
      options.setMessage(`仅创建者可取消${options.label}默认团队视角。`, true)
      return
    }
    if (view.isArchived) {
      options.setMessage(`请先恢复${options.label}团队视角，再取消默认。`, true)
      return
    }

    teamViewsLoading.value = true
    teamViewsError.value = ''
    try {
      const saved = await clearPlmWorkbenchTeamViewDefault(options.kind, view.id)
      teamViews.value = replaceTeamView(teamViews.value, saved)
      applyView(saved)
      if (lastAutoAppliedDefaultId.value === saved.id) {
        lastAutoAppliedDefaultId.value = ''
      }
      options.setMessage(`已取消${options.label}默认团队视角。`)
    } catch (error) {
      teamViewsError.value = getErrorMessage(error, `取消${options.label}默认团队视角失败`)
      options.setMessage(teamViewsError.value, true)
    } finally {
      teamViewsLoading.value = false
    }
  }

  function selectAllTeamViews() {
    teamViewSelection.value = manageableTeamViews.value.map((view) => view.id)
  }

  function clearTeamViewSelection() {
    teamViewSelection.value = []
  }

  async function runBatchTeamViewAction(action: PlmWorkbenchTeamViewBatchAction, ids: string[]) {
    if (!ids.length) {
      const actionLabel = action === 'archive' ? '归档' : action === 'restore' ? '恢复' : '删除'
      options.setMessage(`请选择可${actionLabel}的${options.label}团队视角。`, true)
      return
    }

    const selectedIdBeforeAction = teamViewKey.value
    teamViewsLoading.value = true
    teamViewsError.value = ''
    try {
      const result = await batchPlmWorkbenchTeamViews(options.kind, action, ids)
      const processedSet = new Set(result.processedIds)

      if (action === 'delete') {
        teamViews.value = teamViews.value.filter((view) => !processedSet.has(view.id))
      } else {
        const updates = new Map(result.items.map((view) => [view.id, view]))
        teamViews.value = sortTeamViews(
          teamViews.value.map((view) => updates.get(view.id) || view) as PlmWorkbenchTeamView<Kind>[],
        )
      }

      if (selectedIdBeforeAction && processedSet.has(selectedIdBeforeAction)) {
        if (action === 'restore') {
          const restored = result.items.find((view) => view.id === selectedIdBeforeAction)
          if (restored) {
            applyView(restored)
          }
        } else {
          teamViewKey.value = ''
          teamViewName.value = ''
          options.syncRequestedViewId?.(undefined)
        }
      }

      if (lastAutoAppliedDefaultId.value && processedSet.has(lastAutoAppliedDefaultId.value) && action !== 'restore') {
        lastAutoAppliedDefaultId.value = ''
      }

      teamViewSelection.value = teamViewSelection.value.filter((id) => !processedSet.has(id))
      const actionLabel = action === 'archive' ? '归档' : action === 'restore' ? '恢复' : '删除'
      options.setMessage(`已批量${actionLabel}${options.label}团队视角 ${result.processedIds.length} 项，跳过 ${result.skippedIds.length} 项。`)
    } catch (error) {
      teamViewsError.value = getErrorMessage(error, `批量处理${options.label}团队视角失败`)
      options.setMessage(teamViewsError.value, true)
    } finally {
      teamViewsLoading.value = false
    }
  }

  async function archiveTeamViewSelection() {
    await runBatchTeamViewAction('archive', selectedBatchArchivableTeamViewIds.value)
  }

  async function restoreTeamViewSelection() {
    await runBatchTeamViewAction('restore', selectedBatchRestorableTeamViewIds.value)
  }

  async function deleteTeamViewSelection() {
    await runBatchTeamViewAction('delete', selectedBatchDeletableTeamViewIds.value)
  }

  return {
    teamViewKey,
    teamViewName,
    teamViewOwnerUserId,
    teamViews,
    teamViewsLoading,
    teamViewsError,
    canSaveTeamView,
    canApplyTeamView,
    canManageSelectedTeamView,
    showManagementActions,
    canDuplicateTeamView,
    canShareTeamView,
    canDeleteTeamView,
    canArchiveTeamView,
    canRestoreTeamView,
    canRenameTeamView,
    canTransferTeamView,
    canSetTeamViewDefault,
    canClearTeamViewDefault,
    defaultTeamViewLabel,
    hasManageableTeamViews,
    showTeamViewManager,
    teamViewSelection,
    teamViewSelectionCount,
    selectedBatchArchivableTeamViewIds,
    selectedBatchRestorableTeamViewIds,
    selectedBatchDeletableTeamViewIds,
    refreshTeamViews,
    saveTeamView,
    applyTeamView,
    duplicateTeamView,
    shareTeamView,
    deleteTeamView,
    archiveTeamView,
    restoreTeamView,
    renameTeamView,
    transferTeamView,
    setTeamViewDefault,
    clearTeamViewDefault,
    selectAllTeamViews,
    clearTeamViewSelection,
    archiveTeamViewSelection,
    restoreTeamViewSelection,
    deleteTeamViewSelection,
  }
}
