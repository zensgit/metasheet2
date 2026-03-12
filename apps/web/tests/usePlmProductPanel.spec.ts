import { computed, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { usePlmProductPanel } from '../src/views/plm/usePlmProductPanel'

describe('usePlmProductPanel', () => {
  function createPanel() {
    const refreshAuthStatus = vi.fn()
    const copyDeepLink = vi.fn().mockResolvedValue(undefined)
    const resetAll = vi.fn()
    const applyDeepLinkPreset = vi.fn()
    const movePreset = vi.fn()
    const clearDeepLinkScope = vi.fn()
    const saveDeepLinkPreset = vi.fn()
    const deleteDeepLinkPreset = vi.fn()
    const applyPresetRename = vi.fn()
    const exportCustomPresets = vi.fn()
    const importCustomPresets = vi.fn()
    const triggerPresetFileImport = vi.fn()
    const handlePresetFileImport = vi.fn().mockResolvedValue(undefined)
    const handlePresetDragEnter = vi.fn()
    const handlePresetDragOver = vi.fn()
    const handlePresetDragLeave = vi.fn()
    const handlePresetDrop = vi.fn().mockResolvedValue(undefined)
    const loadProduct = vi.fn().mockResolvedValue(undefined)
    const copyProductField = vi.fn().mockResolvedValue(undefined)
    const hasProductCopyValue = vi.fn().mockReturnValue(true)
    const refreshWorkbenchTeamViews = vi.fn().mockResolvedValue(undefined)
    const applyWorkbenchTeamView = vi.fn().mockResolvedValue(undefined)
    const duplicateWorkbenchTeamView = vi.fn().mockResolvedValue(undefined)
    const shareWorkbenchTeamView = vi.fn().mockResolvedValue(undefined)
    const deleteWorkbenchTeamView = vi.fn().mockResolvedValue(undefined)
    const archiveWorkbenchTeamView = vi.fn().mockResolvedValue(undefined)
    const restoreWorkbenchTeamView = vi.fn().mockResolvedValue(undefined)
    const renameWorkbenchTeamView = vi.fn().mockResolvedValue(undefined)
    const transferWorkbenchTeamView = vi.fn().mockResolvedValue(undefined)
    const saveWorkbenchTeamView = vi.fn().mockResolvedValue(undefined)
    const setWorkbenchTeamViewDefault = vi.fn().mockResolvedValue(undefined)
    const clearWorkbenchTeamViewDefault = vi.fn().mockResolvedValue(undefined)
    const selectAllWorkbenchTeamViews = vi.fn()
    const clearWorkbenchTeamViewSelection = vi.fn()
    const archiveWorkbenchTeamViewSelection = vi.fn().mockResolvedValue(undefined)
    const restoreWorkbenchTeamViewSelection = vi.fn().mockResolvedValue(undefined)
    const deleteWorkbenchTeamViewSelection = vi.fn().mockResolvedValue(undefined)

    const panel = usePlmProductPanel({
      authState: ref('expiring'),
      authExpiresAt: ref(new Date('2026-03-08T12:00:00Z').getTime()),
      plmAuthState: ref('missing'),
      plmAuthExpiresAt: ref(null),
      plmAuthLegacy: ref(true),
      authError: ref(''),
      refreshAuthStatus,
      deepLinkStatus: ref(''),
      deepLinkError: ref(''),
      copyDeepLink,
      resetAll,
      deepLinkPreset: ref(''),
      applyDeepLinkPreset,
      deepLinkPresets: computed(() => []),
      movePreset,
      deepLinkPanelOptions: [{ key: 'product', label: '产品' }],
      deepLinkScope: ref([]),
      clearDeepLinkScope,
      customPresetName: ref(''),
      saveDeepLinkPreset,
      deleteDeepLinkPreset,
      editingPresetLabel: ref(''),
      applyPresetRename,
      exportCustomPresets,
      importPresetText: ref(''),
      importCustomPresets,
      triggerPresetFileImport,
      importFileInput: ref(null),
      handlePresetFileImport,
      isPresetDropActive: ref(false),
      handlePresetDragEnter,
      handlePresetDragOver,
      handlePresetDragLeave,
      handlePresetDrop,
      refreshWorkbenchTeamViews,
      applyWorkbenchTeamView,
      duplicateWorkbenchTeamView,
      shareWorkbenchTeamView,
      deleteWorkbenchTeamView,
      archiveWorkbenchTeamView,
      restoreWorkbenchTeamView,
      renameWorkbenchTeamView,
      transferWorkbenchTeamView,
      saveWorkbenchTeamView,
      setWorkbenchTeamViewDefault,
      clearWorkbenchTeamViewDefault,
      workbenchTeamViewKey: ref(''),
      workbenchTeamViewName: ref(''),
      workbenchTeamViewOwnerUserId: ref(''),
      showManageWorkbenchTeamViewActions: computed(() => true),
      canSaveWorkbenchTeamView: computed(() => true),
      canApplyWorkbenchTeamView: computed(() => true),
      canDuplicateWorkbenchTeamView: computed(() => true),
      canShareWorkbenchTeamView: computed(() => true),
      canDeleteWorkbenchTeamView: computed(() => true),
      canArchiveWorkbenchTeamView: computed(() => true),
      canRestoreWorkbenchTeamView: computed(() => true),
      canRenameWorkbenchTeamView: computed(() => true),
      canTransferWorkbenchTeamView: computed(() => true),
      canSetWorkbenchTeamViewDefault: computed(() => true),
      canClearWorkbenchTeamViewDefault: computed(() => true),
      workbenchDefaultTeamViewLabel: computed(() => ''),
      workbenchTeamViews: ref([]),
      workbenchTeamViewsLoading: ref(false),
      workbenchTeamViewsError: ref(''),
      hasManageableWorkbenchTeamViews: computed(() => true),
      showWorkbenchTeamViewManager: ref(false),
      workbenchTeamViewSelection: ref([]),
      workbenchTeamViewSelectionCount: computed(() => 0),
      selectedBatchArchivableWorkbenchTeamViewIds: computed(() => []),
      selectedBatchRestorableWorkbenchTeamViewIds: computed(() => []),
      selectedBatchDeletableWorkbenchTeamViewIds: computed(() => []),
      selectAllWorkbenchTeamViews,
      clearWorkbenchTeamViewSelection,
      archiveWorkbenchTeamViewSelection,
      restoreWorkbenchTeamViewSelection,
      deleteWorkbenchTeamViewSelection,
      productId: ref('ITEM-1'),
      productItemNumber: ref('PN-1'),
      itemType: ref('Part'),
      productLoading: ref(false),
      loadProduct,
      productError: ref(''),
      product: ref({ id: 'ITEM-1' }),
      productView: computed(() => ({
        id: 'ITEM-1',
        name: 'Widget',
        partNumber: 'PN-1',
        revision: 'A',
        status: 'Released',
        itemType: 'Part',
        description: '',
        createdAt: '',
        updatedAt: '',
      })),
      formatTime: (value?: string) => value || '-',
      hasProductCopyValue,
      copyProductField,
      productFieldCatalog: [
        {
          key: 'name',
          label: '名称',
          source: 'name',
          fallback: 'id',
        },
      ],
      formatJson: (payload: unknown) => JSON.stringify(payload),
    })

    return {
      ...panel,
      refreshAuthStatus,
      copyDeepLink,
      resetAll,
      loadProduct,
      copyProductField,
      hasProductCopyValue,
      refreshWorkbenchTeamViews,
      applyWorkbenchTeamView,
      duplicateWorkbenchTeamView,
      shareWorkbenchTeamView,
      deleteWorkbenchTeamView,
      archiveWorkbenchTeamView,
      restoreWorkbenchTeamView,
      renameWorkbenchTeamView,
      transferWorkbenchTeamView,
      saveWorkbenchTeamView,
      setWorkbenchTeamViewDefault,
      clearWorkbenchTeamViewDefault,
      selectAllWorkbenchTeamViews,
      clearWorkbenchTeamViewSelection,
      archiveWorkbenchTeamViewSelection,
      restoreWorkbenchTeamViewSelection,
      deleteWorkbenchTeamViewSelection,
    }
  }

  it('derives auth copy and classes from raw token state', () => {
    const panel = createPanel()

    expect(panel.authStateText.value).toBe('即将过期')
    expect(panel.authStateClass.value).toBe('auth-expiring')
    expect(panel.authHint.value).toContain('即将过期')
    expect(panel.plmAuthStateText.value).toBe('未设置')
    expect(panel.plmAuthHint.value).toContain('旧字段 jwt')
  })

  it('exposes passthrough actions through the panel contract', async () => {
    const panel = createPanel()

    panel.productPanel.refreshAuthStatus()
    await panel.productPanel.copyDeepLink('product')
    await panel.productPanel.loadProduct()
    await panel.productPanel.copyProductField('id')
    panel.productPanel.resetAll()

    expect(panel.refreshAuthStatus).toHaveBeenCalledTimes(1)
    expect(panel.copyDeepLink).toHaveBeenCalledWith('product')
    expect(panel.loadProduct).toHaveBeenCalledTimes(1)
    expect(panel.copyProductField).toHaveBeenCalledWith('id')
    expect(panel.resetAll).toHaveBeenCalledTimes(1)
  })

  it('exposes workbench batch actions through the panel contract', async () => {
    const panel = createPanel()

    panel.productPanel.selectAllWorkbenchTeamViews()
    panel.productPanel.clearWorkbenchTeamViewSelection()
    await panel.productPanel.archiveWorkbenchTeamViewSelection()
    await panel.productPanel.restoreWorkbenchTeamViewSelection()
    await panel.productPanel.deleteWorkbenchTeamViewSelection()

    expect(panel.selectAllWorkbenchTeamViews).toHaveBeenCalledTimes(1)
    expect(panel.clearWorkbenchTeamViewSelection).toHaveBeenCalledTimes(1)
    expect(panel.archiveWorkbenchTeamViewSelection).toHaveBeenCalledTimes(1)
    expect(panel.restoreWorkbenchTeamViewSelection).toHaveBeenCalledTimes(1)
    expect(panel.deleteWorkbenchTeamViewSelection).toHaveBeenCalledTimes(1)
  })
})
