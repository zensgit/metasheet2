import { computed, ref, type Ref } from 'vue'
import {
  archivePlmTeamFilterPreset,
  batchPlmTeamFilterPresets,
  clearPlmTeamFilterPresetDefault,
  duplicatePlmTeamFilterPreset,
  deletePlmTeamFilterPreset,
  listPlmTeamFilterPresets,
  renamePlmTeamFilterPreset,
  restorePlmTeamFilterPreset,
  savePlmTeamFilterPreset,
  setPlmTeamFilterPresetDefault,
  transferPlmTeamFilterPreset,
  type PlmTeamFilterPresetBatchAction,
} from '../../services/plm/plmWorkbenchClient'
import type {
  FilterPreset,
  PlmTeamFilterPreset,
  PlmTeamFilterPresetKind,
} from './plmPanelModels'
import { usePlmCollaborativePermissions } from './usePlmCollaborativePermissions'

type UsePlmTeamFilterPresetsOptions = {
  kind: PlmTeamFilterPresetKind
  label: string
  getCurrentPresetState: () => Pick<FilterPreset, 'field' | 'value'> & { group?: string }
  applyPreset: (preset: FilterPreset) => void
  setMessage: (message: string, isError?: boolean) => void
  shouldAutoApplyDefault?: () => boolean
  requestedPresetId?: Ref<string>
  syncRequestedPresetId?: (value?: string) => void
  buildShareUrl?: (preset: PlmTeamFilterPreset) => string
  copyShareUrl?: (url: string) => Promise<boolean>
}

function upsertTeamPreset(
  presets: PlmTeamFilterPreset[],
  preset: PlmTeamFilterPreset,
) {
  const next = presets.filter((entry) => entry.id !== preset.id)
  next.unshift(preset)
  return sortTeamPresets(next)
}

function getPresetTimestamp(preset: PlmTeamFilterPreset) {
  const raw = preset.updatedAt || preset.createdAt || ''
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

function sortTeamPresets(presets: PlmTeamFilterPreset[]) {
  return [...presets].sort((left, right) => {
    if (Boolean(left.isArchived) !== Boolean(right.isArchived)) {
      return Number(Boolean(left.isArchived)) - Number(Boolean(right.isArchived))
    }
    if (left.isDefault !== right.isDefault) {
      return Number(right.isDefault) - Number(left.isDefault)
    }
    return getPresetTimestamp(right) - getPresetTimestamp(left)
  })
}

function applyDefaultPresetUpdate(
  presets: PlmTeamFilterPreset[],
  preset: PlmTeamFilterPreset,
) {
  const next = presets.map((entry) => {
    if (entry.id === preset.id) return preset
    return entry.isDefault ? { ...entry, isDefault: false } : entry
  })
  return sortTeamPresets(next)
}

function replaceTeamPreset(
  presets: PlmTeamFilterPreset[],
  preset: PlmTeamFilterPreset,
) {
  return sortTeamPresets(
    presets.map((entry) => (entry.id === preset.id ? preset : entry)),
  )
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message
  }
  return fallback
}

function buildPromotedTeamPresetName(label: string, presets: PlmTeamFilterPreset[]) {
  const baseLabel = label.trim()
  if (!baseLabel) return '未命名团队预设'

  const normalizedNames = new Set(
    presets
      .map((preset) => preset.name.trim().toLowerCase())
      .filter(Boolean),
  )

  if (!normalizedNames.has(baseLabel.toLowerCase())) {
    return baseLabel
  }

  const duplicateBase = `${baseLabel} 团队`
  if (!normalizedNames.has(duplicateBase.toLowerCase())) {
    return duplicateBase
  }

  let suffix = 2
  while (normalizedNames.has(`${duplicateBase} ${suffix}`.toLowerCase())) {
    suffix += 1
  }
  return `${duplicateBase} ${suffix}`
}

function buildLocalPresetState(preset: FilterPreset) {
  return {
    field: preset.field,
    value: preset.value.trim(),
    group: String(preset.group || '').trim(),
  }
}

function readTeamPresetPermissions(preset: PlmTeamFilterPreset) {
  const fallbackCanManage = Boolean(preset.canManage)
  const isArchived = Boolean(preset.isArchived)
  const permissions = preset.permissions

  return {
    canManage: permissions?.canManage ?? fallbackCanManage,
    canArchive: permissions?.canArchive ?? (fallbackCanManage && !isArchived),
    canRestore: permissions?.canRestore ?? (fallbackCanManage && isArchived),
    canDelete: permissions?.canDelete ?? fallbackCanManage,
  }
}

export function usePlmTeamFilterPresets(options: UsePlmTeamFilterPresetsOptions) {
  const teamPresetKey = ref('')
  const teamPresetName = ref('')
  const teamPresetGroup = ref('')
  const teamPresetOwnerUserId = ref('')
  const teamPresets = ref<PlmTeamFilterPreset[]>([])
  const teamPresetsLoading = ref(false)
  const teamPresetsError = ref('')
  const lastAutoAppliedDefaultId = ref('')
  const showTeamPresetManager = ref(false)
  const teamPresetSelection = ref<string[]>([])

  const selectedTeamPreset = computed(
    () => teamPresets.value.find((preset) => preset.id === teamPresetKey.value) || null,
  )
  const defaultTeamPreset = computed(
    () => teamPresets.value.find((preset) => preset.isDefault && !preset.isArchived) || null,
  )
  const manageableTeamPresets = computed(
    () => teamPresets.value.filter((preset) => readTeamPresetPermissions(preset).canManage),
  )
  const hasManageableTeamPresets = computed(() => manageableTeamPresets.value.length > 0)
  const selectedTeamPresetEntries = computed(() => {
    const selectedIds = new Set(teamPresetSelection.value)
    return teamPresets.value.filter((preset) => selectedIds.has(preset.id))
  })
  const selectedBatchArchivableTeamPresetIds = computed(() =>
    selectedTeamPresetEntries.value
      .filter((preset) => readTeamPresetPermissions(preset).canArchive)
      .map((preset) => preset.id),
  )
  const selectedBatchRestorableTeamPresetIds = computed(() =>
    selectedTeamPresetEntries.value
      .filter((preset) => readTeamPresetPermissions(preset).canRestore)
      .map((preset) => preset.id),
  )
  const selectedBatchDeletableTeamPresetIds = computed(() =>
    selectedTeamPresetEntries.value
      .filter((preset) => readTeamPresetPermissions(preset).canDelete)
      .map((preset) => preset.id),
  )
  const teamPresetSelectionCount = computed(() => selectedTeamPresetEntries.value.length)

  const canSaveTeamPreset = computed(() => {
    const current = options.getCurrentPresetState()
    return Boolean(teamPresetName.value.trim() && current.value.trim())
  })
  const {
    showManagementActions,
    canApply: canApplyTeamPreset,
    canDuplicate: canDuplicateTeamPreset,
    canShare: canShareTeamPreset,
    canDelete: canDeleteTeamPreset,
    canArchive: canArchiveTeamPreset,
    canRestore: canRestoreTeamPreset,
    canRename: canRenameTeamPreset,
    canTransferTarget: canTransferTeamPresetTarget,
    canTransfer: canTransferTeamPreset,
    canSetDefault: canSetTeamPresetDefault,
    canClearDefault: canClearTeamPresetDefault,
  } = usePlmCollaborativePermissions({
    selectedEntry: selectedTeamPreset,
    nameRef: teamPresetName,
    ownerUserIdRef: teamPresetOwnerUserId,
  })
  const defaultTeamPresetLabel = computed(() => {
    const preset = defaultTeamPreset.value
    if (!preset) return ''
    return preset.state.group ? `${preset.name} (${preset.state.group})` : preset.name
  })

  function applyPresetToTarget(preset: PlmTeamFilterPreset) {
    teamPresetKey.value = preset.id
    options.syncRequestedPresetId?.(preset.id)
    options.applyPreset({
      key: preset.id,
      label: preset.name,
      field: preset.state.field,
      value: preset.state.value,
      group: preset.state.group,
    })
  }

  function maybeAutoApplyDefault(items: PlmTeamFilterPreset[]) {
    if (teamPresetKey.value) return
    const requestedPresetId = options.requestedPresetId?.value.trim() || ''
    if (requestedPresetId) {
      const requestedPreset = items.find((entry) => entry.id === requestedPresetId && !entry.isArchived)
      if (requestedPreset) {
        applyPresetToTarget(requestedPreset)
        return
      }
      options.syncRequestedPresetId?.(undefined)
    }
    if (!options.shouldAutoApplyDefault?.()) return

    const preset = items.find((entry) => entry.isDefault && !entry.isArchived)
    if (!preset) return
    if (lastAutoAppliedDefaultId.value === preset.id) return

    applyPresetToTarget(preset)
    lastAutoAppliedDefaultId.value = preset.id
    options.setMessage(`已应用${options.label}默认团队预设：${preset.name}`)
  }

  async function refreshTeamPresets() {
    teamPresetsLoading.value = true
    teamPresetsError.value = ''
    try {
      const result = await listPlmTeamFilterPresets(options.kind)
      teamPresets.value = sortTeamPresets(result.items)
      const availableIds = new Set(result.items.map((preset) => preset.id))
      teamPresetSelection.value = teamPresetSelection.value.filter((id) => availableIds.has(id))
      if (!result.items.some((preset) => preset.id === teamPresetKey.value)) {
        teamPresetKey.value = ''
      }
      if (
        options.requestedPresetId?.value
        && !result.items.some((preset) => preset.id === options.requestedPresetId?.value)
      ) {
        options.syncRequestedPresetId?.(undefined)
      }
      maybeAutoApplyDefault(teamPresets.value)
    } catch (error) {
      teamPresetsError.value = getErrorMessage(error, `加载${options.label}团队预设失败`)
    } finally {
      teamPresetsLoading.value = false
    }
  }

  async function saveTeamPreset() {
    if (!canSaveTeamPreset.value) {
      options.setMessage(`请输入${options.label}过滤条件和团队预设名称。`, true)
      return
    }

    teamPresetsLoading.value = true
    teamPresetsError.value = ''

    try {
      const current = options.getCurrentPresetState()
      const saved = await savePlmTeamFilterPreset(options.kind, teamPresetName.value.trim(), {
        field: current.field,
        value: current.value.trim(),
        group: teamPresetGroup.value.trim() || String(current.group || '').trim(),
      })

      teamPresets.value = upsertTeamPreset(teamPresets.value, saved)
      applyPresetToTarget(saved)
      teamPresetName.value = ''
      teamPresetGroup.value = ''
      options.setMessage(`已保存${options.label}团队预设。`)
    } catch (error) {
      teamPresetsError.value = getErrorMessage(error, `保存${options.label}团队预设失败`)
      options.setMessage(teamPresetsError.value, true)
    } finally {
      teamPresetsLoading.value = false
    }
  }

  async function promoteFilterPresetToTeam(preset: FilterPreset) {
    const state = buildLocalPresetState(preset)
    if (!state.value) {
      options.setMessage(`请选择有效的${options.label}本地预设后再提升。`, true)
      return null
    }

    teamPresetsLoading.value = true
    teamPresetsError.value = ''

    try {
      const saved = await savePlmTeamFilterPreset(
        options.kind,
        buildPromotedTeamPresetName(preset.label, teamPresets.value),
        state,
      )

      teamPresets.value = upsertTeamPreset(teamPresets.value, saved)
      applyPresetToTarget(saved)
      teamPresetName.value = ''
      teamPresetGroup.value = ''
      options.setMessage(`已将${options.label}本地预设提升为团队预设：${saved.name}`)
      return saved
    } catch (error) {
      teamPresetsError.value = getErrorMessage(error, `提升${options.label}团队预设失败`)
      options.setMessage(teamPresetsError.value, true)
      return null
    } finally {
      teamPresetsLoading.value = false
    }
  }

  async function promoteFilterPresetToTeamDefault(preset: FilterPreset) {
    const state = buildLocalPresetState(preset)
    if (!state.value) {
      options.setMessage(`请选择有效的${options.label}本地预设后再提升并设为默认。`, true)
      return null
    }

    teamPresetsLoading.value = true
    teamPresetsError.value = ''

    try {
      const created = await savePlmTeamFilterPreset(
        options.kind,
        buildPromotedTeamPresetName(preset.label, teamPresets.value),
        state,
      )

      teamPresets.value = upsertTeamPreset(teamPresets.value, created)
      applyPresetToTarget(created)

      const defaulted = await setPlmTeamFilterPresetDefault(created.id)
      teamPresets.value = applyDefaultPresetUpdate(teamPresets.value, defaulted)
      applyPresetToTarget(defaulted)
      lastAutoAppliedDefaultId.value = defaulted.id
      teamPresetName.value = ''
      teamPresetGroup.value = ''
      options.setMessage(`已将${options.label}本地预设提升为默认团队预设：${defaulted.name}`)
      return defaulted
    } catch (error) {
      teamPresetsError.value = getErrorMessage(error, `提升${options.label}默认团队预设失败`)
      options.setMessage(teamPresetsError.value, true)
      return null
    } finally {
      teamPresetsLoading.value = false
    }
  }

  function applyTeamPreset() {
    const preset = selectedTeamPreset.value
    if (!preset) {
      options.setMessage(`请选择${options.label}团队预设。`, true)
      return
    }
    if (!canApplyTeamPreset.value) {
      if (preset.isArchived) {
        options.setMessage(`请先恢复${options.label}团队预设，再执行应用。`, true)
        return
      }
      options.setMessage(`当前${options.label}团队预设不可应用。`, true)
      return
    }

    if (preset.isArchived) {
      options.setMessage(`请先恢复${options.label}团队预设，再执行应用。`, true)
      return
    }

    applyPresetToTarget(preset)
    options.setMessage(`已应用${options.label}团队预设：${preset.name}`)
  }

  async function shareTeamPreset() {
    const preset = selectedTeamPreset.value
    if (!preset) {
      options.setMessage(`请选择${options.label}团队预设。`, true)
      return
    }
    if (!canShareTeamPreset.value) {
      if (preset.isArchived) {
        options.setMessage(`请先恢复${options.label}团队预设，再执行分享。`, true)
        return
      }
      options.setMessage(`当前${options.label}团队预设不可分享。`, true)
      return
    }
    if (!options.buildShareUrl || !options.copyShareUrl) {
      options.setMessage(`${options.label}团队预设分享能力未启用。`, true)
      return
    }

    const url = options.buildShareUrl(preset)
    if (!url) {
      options.setMessage(`生成${options.label}团队预设分享链接失败。`, true)
      return
    }

    const copied = await options.copyShareUrl(url)
    if (!copied) {
      options.setMessage(`复制${options.label}团队预设分享链接失败。`, true)
      return
    }

    options.setMessage(`已复制${options.label}团队预设分享链接。`)
  }

  async function duplicateTeamPreset() {
    const preset = selectedTeamPreset.value
    if (!preset) {
      options.setMessage(`请选择${options.label}团队预设。`, true)
      return
    }
    if (!canDuplicateTeamPreset.value) {
      options.setMessage(`当前${options.label}团队预设不可复制。`, true)
      return
    }

    teamPresetsLoading.value = true
    teamPresetsError.value = ''

    try {
      const duplicated = await duplicatePlmTeamFilterPreset(
        preset.id,
        teamPresetName.value.trim() || undefined,
      )
      teamPresets.value = upsertTeamPreset(teamPresets.value, duplicated)
      applyPresetToTarget(duplicated)
      teamPresetName.value = ''
      teamPresetGroup.value = duplicated.state.group || ''
      options.setMessage(`已复制${options.label}团队预设：${duplicated.name}`)
    } catch (error) {
      teamPresetsError.value = getErrorMessage(error, `复制${options.label}团队预设失败`)
      options.setMessage(teamPresetsError.value, true)
    } finally {
      teamPresetsLoading.value = false
    }
  }

  async function renameTeamPreset() {
    const preset = selectedTeamPreset.value
    if (!preset) {
      options.setMessage(`请选择${options.label}团队预设。`, true)
      return
    }
    if (!teamPresetName.value.trim()) {
      options.setMessage(`请输入${options.label}团队预设名称。`, true)
      return
    }
    if (!canRenameTeamPreset.value) {
      if (preset.isArchived) {
        options.setMessage(`请先恢复${options.label}团队预设，再执行重命名。`, true)
        return
      }
      options.setMessage(`当前${options.label}团队预设不可重命名。`, true)
      return
    }

    teamPresetsLoading.value = true
    teamPresetsError.value = ''

    try {
      const renamed = await renamePlmTeamFilterPreset(
        preset.id,
        teamPresetName.value.trim(),
      )
      teamPresets.value = replaceTeamPreset(teamPresets.value, renamed)
      applyPresetToTarget(renamed)
      teamPresetName.value = ''
      teamPresetGroup.value = renamed.state.group || ''
      options.setMessage(`已重命名${options.label}团队预设：${renamed.name}`)
    } catch (error) {
      teamPresetsError.value = getErrorMessage(error, `重命名${options.label}团队预设失败`)
      options.setMessage(teamPresetsError.value, true)
    } finally {
      teamPresetsLoading.value = false
    }
  }

  async function transferTeamPreset() {
    const preset = selectedTeamPreset.value
    const targetOwnerUserId = teamPresetOwnerUserId.value.trim()
    if (!preset) {
      options.setMessage(`请选择${options.label}团队预设。`, true)
      return
    }
    if (!targetOwnerUserId) {
      options.setMessage(`请输入${options.label}团队预设目标用户 ID。`, true)
      return
    }
    if (targetOwnerUserId === preset.ownerUserId) {
      options.setMessage(`${options.label}团队预设已经属于该用户。`)
      return
    }
    if (!canTransferTeamPresetTarget.value) {
      options.setMessage(`当前${options.label}团队预设不可转移。`, true)
      return
    }

    teamPresetsLoading.value = true
    teamPresetsError.value = ''

    try {
      const saved = await transferPlmTeamFilterPreset(preset.id, targetOwnerUserId)
      teamPresets.value = replaceTeamPreset(teamPresets.value, saved)
      applyPresetToTarget(saved)
      teamPresetOwnerUserId.value = ''
      options.setMessage(`已将${options.label}团队预设转移给：${saved.ownerUserId}`)
    } catch (error) {
      teamPresetsError.value = getErrorMessage(error, `转移${options.label}团队预设失败`)
      options.setMessage(teamPresetsError.value, true)
    } finally {
      teamPresetsLoading.value = false
    }
  }

  async function deleteTeamPreset() {
    const preset = selectedTeamPreset.value
    if (!preset) return
    if (!canDeleteTeamPreset.value) {
      options.setMessage(`当前${options.label}团队预设不可删除。`, true)
      return
    }

    teamPresetsLoading.value = true
    teamPresetsError.value = ''

    try {
      await deletePlmTeamFilterPreset(preset.id)
      teamPresets.value = teamPresets.value.filter((entry) => entry.id !== preset.id)
      if (teamPresetKey.value === preset.id) {
        teamPresetKey.value = ''
        teamPresetName.value = ''
        teamPresetGroup.value = ''
      }
      if (options.requestedPresetId?.value === preset.id) {
        options.syncRequestedPresetId?.(undefined)
      }
      if (lastAutoAppliedDefaultId.value === preset.id) {
        lastAutoAppliedDefaultId.value = ''
      }
      options.setMessage(`已删除${options.label}团队预设。`)
    } catch (error) {
      teamPresetsError.value = getErrorMessage(error, `删除${options.label}团队预设失败`)
      options.setMessage(teamPresetsError.value, true)
    } finally {
      teamPresetsLoading.value = false
    }
  }

  async function setTeamPresetDefault() {
    const preset = selectedTeamPreset.value
    if (!preset) {
      options.setMessage(`请选择${options.label}团队预设。`, true)
      return
    }
    if (!canSetTeamPresetDefault.value) {
      if (preset.isArchived) {
        options.setMessage(`请先恢复${options.label}团队预设，再设为默认。`, true)
        return
      }
      options.setMessage(`当前${options.label}团队预设不可设为默认。`, true)
      return
    }

    teamPresetsLoading.value = true
    teamPresetsError.value = ''

    try {
      const saved = await setPlmTeamFilterPresetDefault(preset.id)
      teamPresets.value = applyDefaultPresetUpdate(teamPresets.value, saved)
      applyPresetToTarget(saved)
      lastAutoAppliedDefaultId.value = saved.id
      options.setMessage(`已设为${options.label}默认团队预设：${saved.name}`)
    } catch (error) {
      teamPresetsError.value = getErrorMessage(error, `设置${options.label}默认团队预设失败`)
      options.setMessage(teamPresetsError.value, true)
    } finally {
      teamPresetsLoading.value = false
    }
  }

  async function clearTeamPresetDefault() {
    const preset = selectedTeamPreset.value
    if (!preset) {
      options.setMessage(`请选择${options.label}团队预设。`, true)
      return
    }
    if (!canClearTeamPresetDefault.value) {
      if (preset.isArchived) {
        options.setMessage(`已归档的${options.label}团队预设无需取消默认。`, true)
        return
      }
      options.setMessage(`当前${options.label}团队预设不可取消默认。`, true)
      return
    }

    teamPresetsLoading.value = true
    teamPresetsError.value = ''

    try {
      const saved = await clearPlmTeamFilterPresetDefault(preset.id)
      teamPresets.value = replaceTeamPreset(teamPresets.value, saved)
      applyPresetToTarget(saved)
      if (lastAutoAppliedDefaultId.value === preset.id) {
        lastAutoAppliedDefaultId.value = ''
      }
      options.setMessage(`已取消${options.label}默认团队预设。`)
    } catch (error) {
      teamPresetsError.value = getErrorMessage(error, `取消${options.label}默认团队预设失败`)
      options.setMessage(teamPresetsError.value, true)
    } finally {
      teamPresetsLoading.value = false
    }
  }

  async function archiveTeamPreset() {
    const preset = selectedTeamPreset.value
    if (!preset) {
      options.setMessage(`请选择${options.label}团队预设。`, true)
      return
    }
    if (preset.isArchived) {
      options.setMessage(`${options.label}团队预设已归档。`)
      return
    }
    if (!canArchiveTeamPreset.value) {
      options.setMessage(`当前${options.label}团队预设不可归档。`, true)
      return
    }

    teamPresetsLoading.value = true
    teamPresetsError.value = ''

    try {
      const saved = await archivePlmTeamFilterPreset(preset.id)
      teamPresets.value = replaceTeamPreset(teamPresets.value, saved)
      if (teamPresetKey.value === preset.id) {
        teamPresetKey.value = ''
        teamPresetName.value = ''
        teamPresetGroup.value = ''
      }
      if (options.requestedPresetId?.value === preset.id) {
        options.syncRequestedPresetId?.(undefined)
      }
      if (lastAutoAppliedDefaultId.value === preset.id) {
        lastAutoAppliedDefaultId.value = ''
      }
      options.setMessage(`已归档${options.label}团队预设：${saved.name}`)
    } catch (error) {
      teamPresetsError.value = getErrorMessage(error, `归档${options.label}团队预设失败`)
      options.setMessage(teamPresetsError.value, true)
    } finally {
      teamPresetsLoading.value = false
    }
  }

  async function restoreTeamPreset() {
    const preset = selectedTeamPreset.value
    if (!preset) {
      options.setMessage(`请选择${options.label}团队预设。`, true)
      return
    }
    if (!preset.isArchived) {
      options.setMessage(`${options.label}团队预设无需恢复。`)
      return
    }
    if (!canRestoreTeamPreset.value) {
      options.setMessage(`当前${options.label}团队预设不可恢复。`, true)
      return
    }

    teamPresetsLoading.value = true
    teamPresetsError.value = ''

    try {
      const saved = await restorePlmTeamFilterPreset(preset.id)
      teamPresets.value = replaceTeamPreset(teamPresets.value, saved)
      applyPresetToTarget(saved)
      teamPresetName.value = ''
      teamPresetGroup.value = saved.state.group || ''
      options.setMessage(`已恢复${options.label}团队预设：${saved.name}`)
    } catch (error) {
      teamPresetsError.value = getErrorMessage(error, `恢复${options.label}团队预设失败`)
      options.setMessage(teamPresetsError.value, true)
    } finally {
      teamPresetsLoading.value = false
    }
  }

  function selectAllTeamPresets() {
    teamPresetSelection.value = manageableTeamPresets.value.map((preset) => preset.id)
  }

  function clearTeamPresetSelection() {
    teamPresetSelection.value = []
  }

  async function runBatchTeamPresetAction(
    action: PlmTeamFilterPresetBatchAction,
    presetIds: string[],
  ) {
    if (!presetIds.length) {
      const verbMap: Record<PlmTeamFilterPresetBatchAction, string> = {
        archive: '归档',
        restore: '恢复',
        delete: '删除',
      }
      options.setMessage(`没有可${verbMap[action]}的${options.label}团队预设。`, true)
      return
    }

    teamPresetsLoading.value = true
    teamPresetsError.value = ''

    try {
      const result = await batchPlmTeamFilterPresets(action, presetIds)
      const processedSet = new Set(result.processedIds)

      if (action === 'delete') {
        teamPresets.value = sortTeamPresets(
          teamPresets.value.filter((preset) => !processedSet.has(preset.id)),
        )
      } else {
        const nextMap = new Map(result.items.map((preset) => [preset.id, preset]))
        teamPresets.value = sortTeamPresets(
          teamPresets.value.map((preset) => nextMap.get(preset.id) || preset),
        )
      }

      teamPresetSelection.value = teamPresetSelection.value.filter((id) => !processedSet.has(id))

      const selectedId = teamPresetKey.value
      if (selectedId && processedSet.has(selectedId)) {
        if (action === 'restore') {
          const restored = result.items.find((preset) => preset.id === selectedId)
          if (restored) {
            applyPresetToTarget(restored)
            teamPresetName.value = ''
            teamPresetGroup.value = restored.state.group || ''
          }
        } else {
          teamPresetKey.value = ''
          teamPresetName.value = ''
          teamPresetGroup.value = ''
        }
      }

      const requestedPresetId = options.requestedPresetId?.value.trim() || ''
      if (requestedPresetId && processedSet.has(requestedPresetId)) {
        if (action === 'restore') {
          const restored = result.items.find((preset) => preset.id === requestedPresetId)
          options.syncRequestedPresetId?.(restored?.id || undefined)
        } else {
          options.syncRequestedPresetId?.(undefined)
        }
      }

      if (action !== 'restore' && lastAutoAppliedDefaultId.value && processedSet.has(lastAutoAppliedDefaultId.value)) {
        lastAutoAppliedDefaultId.value = ''
      }

      const actionLabelMap: Record<PlmTeamFilterPresetBatchAction, string> = {
        archive: '归档',
        restore: '恢复',
        delete: '删除',
      }
      const skippedPart = result.skippedIds.length ? `，跳过 ${result.skippedIds.length} 项` : ''
      options.setMessage(`已批量${actionLabelMap[action]}${options.label}团队预设 ${result.processedIds.length} 项${skippedPart}。`)
    } catch (error) {
      teamPresetsError.value = getErrorMessage(error, `批量处理${options.label}团队预设失败`)
      options.setMessage(teamPresetsError.value, true)
    } finally {
      teamPresetsLoading.value = false
    }
  }

  async function archiveTeamPresetSelection() {
    await runBatchTeamPresetAction('archive', selectedBatchArchivableTeamPresetIds.value)
  }

  async function restoreTeamPresetSelection() {
    await runBatchTeamPresetAction('restore', selectedBatchRestorableTeamPresetIds.value)
  }

  async function deleteTeamPresetSelection() {
    await runBatchTeamPresetAction('delete', selectedBatchDeletableTeamPresetIds.value)
  }

  return {
    teamPresetKey,
    teamPresetName,
    teamPresetGroup,
    teamPresetOwnerUserId,
    teamPresets,
    teamPresetsLoading,
    teamPresetsError,
    canSaveTeamPreset,
    canApplyTeamPreset,
    canDuplicateTeamPreset,
    showManagementActions,
    canShareTeamPreset,
    canDeleteTeamPreset,
    canArchiveTeamPreset,
    canRestoreTeamPreset,
    canRenameTeamPreset,
    canTransferTeamPreset,
    canSetTeamPresetDefault,
    canClearTeamPresetDefault,
    defaultTeamPresetLabel,
    hasManageableTeamPresets,
    showTeamPresetManager,
    teamPresetSelection,
    teamPresetSelectionCount,
    selectedBatchArchivableTeamPresetIds,
    selectedBatchRestorableTeamPresetIds,
    selectedBatchDeletableTeamPresetIds,
    refreshTeamPresets,
    saveTeamPreset,
    promoteFilterPresetToTeam,
    promoteFilterPresetToTeamDefault,
    applyTeamPreset,
    shareTeamPreset,
    duplicateTeamPreset,
    deleteTeamPreset,
    archiveTeamPreset,
    restoreTeamPreset,
    renameTeamPreset,
    transferTeamPreset,
    setTeamPresetDefault,
    clearTeamPresetDefault,
    selectAllTeamPresets,
    clearTeamPresetSelection,
    archiveTeamPresetSelection,
    restoreTeamPresetSelection,
    deleteTeamPresetSelection,
  }
}
