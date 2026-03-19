import { computed, type ComputedRef, type Ref } from 'vue'
import type {
  AuthState,
  DeepLinkPreset,
  PlmDeepLinkPanelOption,
  FilterFieldOption,
  PlmProductFieldCatalogEntry,
  PlmProductPanelModel,
  PlmRecommendedWorkbenchScene,
  PlmWorkbenchSceneSummaryChip,
  PlmWorkbenchSceneSummaryHint,
  PlmWorkbenchSceneRecommendationFilter,
  ProductRecord,
  PlmProductViewModel,
  PlmWorkbenchTeamView,
  ProductCopyKind,
} from './plmPanelModels'

type UsePlmProductPanelOptions = {
  authState: Ref<AuthState>
  authExpiresAt: Ref<number | null>
  plmAuthState: Ref<AuthState>
  plmAuthExpiresAt: Ref<number | null>
  plmAuthLegacy: Ref<boolean>
  authError: Ref<string>
  refreshAuthStatus: () => void
  deepLinkStatus: Ref<string>
  deepLinkError: Ref<string>
  copyDeepLink: (panel?: string) => Promise<void>
  resetAll: () => void
  refreshWorkbenchTeamViews: () => Promise<void>
  applyWorkbenchTeamView: () => void
  duplicateWorkbenchTeamView: () => Promise<void>
  shareWorkbenchTeamView: () => Promise<void>
  deleteWorkbenchTeamView: () => Promise<void>
  archiveWorkbenchTeamView: () => Promise<void>
  restoreWorkbenchTeamView: () => Promise<void>
  renameWorkbenchTeamView: () => Promise<void>
  transferWorkbenchTeamView: () => Promise<void>
  saveWorkbenchTeamView: () => Promise<void>
  setWorkbenchTeamViewDefault: () => Promise<void>
  clearWorkbenchTeamViewDefault: () => Promise<void>
  deepLinkPreset: Ref<string>
  applyDeepLinkPreset: () => void
  deepLinkPresets: ComputedRef<DeepLinkPreset[]>
  movePreset: (direction: 'up' | 'down') => void
  deepLinkPanelOptions: PlmDeepLinkPanelOption[]
  deepLinkScope: Ref<string[]>
  clearDeepLinkScope: () => void
  customPresetName: Ref<string>
  saveDeepLinkPreset: () => void
  deleteDeepLinkPreset: () => void
  editingPresetLabel: Ref<string>
  applyPresetRename: () => void
  exportCustomPresets: () => void
  importPresetText: Ref<string>
  importCustomPresets: () => void
  triggerPresetFileImport: () => void
  importFileInput: Ref<HTMLInputElement | null>
  handlePresetFileImport: (event: Event) => Promise<void>
  isPresetDropActive: Ref<boolean>
  handlePresetDragEnter: (event: DragEvent) => void
  handlePresetDragOver: (event: DragEvent) => void
  handlePresetDragLeave: (event: DragEvent) => void
  handlePresetDrop: (event: DragEvent) => Promise<void>
  workbenchTeamViewKey: Ref<string>
  workbenchTeamViewName: Ref<string>
  workbenchTeamViewOwnerUserId: Ref<string>
  showManageWorkbenchTeamViewActions: ComputedRef<boolean>
  canSaveWorkbenchTeamView: ComputedRef<boolean>
  canApplyWorkbenchTeamView: ComputedRef<boolean>
  canDuplicateWorkbenchTeamView: ComputedRef<boolean>
  canShareWorkbenchTeamView: ComputedRef<boolean>
  canDeleteWorkbenchTeamView: ComputedRef<boolean>
  canArchiveWorkbenchTeamView: ComputedRef<boolean>
  canRestoreWorkbenchTeamView: ComputedRef<boolean>
  canRenameWorkbenchTeamView: ComputedRef<boolean>
  canTransferWorkbenchTeamView: ComputedRef<boolean>
  canSetWorkbenchTeamViewDefault: ComputedRef<boolean>
  canClearWorkbenchTeamViewDefault: ComputedRef<boolean>
  workbenchDefaultTeamViewLabel: ComputedRef<string>
  workbenchTeamViews: Ref<PlmWorkbenchTeamView<'workbench'>[]>
  workbenchTeamViewsLoading: Ref<boolean>
  workbenchTeamViewsError: Ref<string>
  hasManageableWorkbenchTeamViews: ComputedRef<boolean>
  showWorkbenchTeamViewManager: Ref<boolean>
  workbenchTeamViewSelection: Ref<string[]>
  workbenchTeamViewSelectionCount: ComputedRef<number>
  selectedBatchArchivableWorkbenchTeamViewIds: ComputedRef<string[]>
  selectedBatchRestorableWorkbenchTeamViewIds: ComputedRef<string[]>
  selectedBatchDeletableWorkbenchTeamViewIds: ComputedRef<string[]>
  sceneCatalogOwnerFilter: Ref<string>
  sceneCatalogOwnerOptions: ComputedRef<string[]>
  sceneCatalogRecommendationFilter: Ref<PlmWorkbenchSceneRecommendationFilter>
  sceneCatalogRecommendationOptions: FilterFieldOption[]
  sceneCatalogSummaryChips: ComputedRef<PlmWorkbenchSceneSummaryChip[]>
  sceneCatalogSummaryHint: ComputedRef<PlmWorkbenchSceneSummaryHint>
  setSceneCatalogRecommendationFilter: (value: PlmWorkbenchSceneRecommendationFilter) => void
  recommendedWorkbenchScenes: ComputedRef<PlmRecommendedWorkbenchScene[]>
  selectAllWorkbenchTeamViews: () => void
  clearWorkbenchTeamViewSelection: () => void
  archiveWorkbenchTeamViewSelection: () => Promise<void>
  restoreWorkbenchTeamViewSelection: () => Promise<void>
  deleteWorkbenchTeamViewSelection: () => Promise<void>
  applyRecommendedWorkbenchScene: (viewId: string) => void
  openRecommendedWorkbenchSceneAudit: (scene: PlmRecommendedWorkbenchScene) => Promise<void>
  copyRecommendedWorkbenchSceneLink: (viewId: string) => Promise<void>
  openWorkbenchSceneAudit: () => Promise<void>
  productId: Ref<string>
  productItemNumber: Ref<string>
  itemType: Ref<string>
  productLoading: Ref<boolean>
  loadProduct: () => Promise<void>
  productError: Ref<string>
  product: Ref<ProductRecord | null>
  productView: ComputedRef<PlmProductViewModel>
  formatTime: (value?: string) => string
  hasProductCopyValue: (kind: ProductCopyKind) => boolean
  copyProductField: (kind: ProductCopyKind) => Promise<void>
  productFieldCatalog: PlmProductFieldCatalogEntry[]
  formatJson: (payload: unknown) => string
}

function formatExpiryText(value: number | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `有效至 ${date.toLocaleString()}`
}

function getAuthStateText(state: AuthState, missingText: string): string {
  switch (state) {
    case 'valid':
      return '已登录'
    case 'expiring':
      return '即将过期'
    case 'expired':
      return '已过期'
    case 'invalid':
      return '无效 Token'
    default:
      return missingText
  }
}

function getMetaAuthHint(state: AuthState): string {
  if (state === 'missing') {
    return '未检测到 auth_token（MetaSheet token），请在 localStorage 写入后刷新。'
  }
  if (state === 'invalid') {
    return 'MetaSheet Token 解析失败，请重新获取并写入 auth_token。'
  }
  if (state === 'expired') {
    return 'MetaSheet Token 已过期，请重新登录或刷新 Token。'
  }
  if (state === 'expiring') {
    return 'MetaSheet Token 即将过期，建议提前刷新。'
  }
  return ''
}

function getPlmAuthHint(state: AuthState, isLegacy: boolean): string {
  if (isLegacy) {
    return '检测到旧字段 jwt，建议迁移为 plm_token。'
  }
  if (state === 'missing') {
    return '未检测到 plm_token（可选，仅用于显示 PLM Token 状态）。'
  }
  if (state === 'invalid') {
    return 'PLM Token 解析失败，请重新获取并写入 plm_token。'
  }
  if (state === 'expired') {
    return 'PLM Token 已过期，请重新登录或刷新 Token。'
  }
  if (state === 'expiring') {
    return 'PLM Token 即将过期，建议提前刷新。'
  }
  return ''
}

export function usePlmProductPanel(options: UsePlmProductPanelOptions) {
  const authStateText = computed(() => getAuthStateText(options.authState.value, '未登录'))
  const authStateClass = computed(() => `auth-${options.authState.value}`)
  const authExpiryText = computed(() => formatExpiryText(options.authExpiresAt.value))
  const authHint = computed(() => getMetaAuthHint(options.authState.value))

  const plmAuthStateText = computed(() => getAuthStateText(options.plmAuthState.value, '未设置'))
  const plmAuthStateClass = computed(() => `auth-${options.plmAuthState.value}`)
  const plmAuthExpiryText = computed(() => formatExpiryText(options.plmAuthExpiresAt.value))
  const plmAuthHint = computed(() => getPlmAuthHint(options.plmAuthState.value, options.plmAuthLegacy.value))

  const productPanel: PlmProductPanelModel = {
    authStateClass,
    authStateText,
    authExpiryText,
    refreshAuthStatus: options.refreshAuthStatus,
    plmAuthStateClass,
    plmAuthStateText,
    plmAuthExpiryText,
    authHint,
    plmAuthHint,
    authError: options.authError,
    deepLinkStatus: options.deepLinkStatus,
    deepLinkError: options.deepLinkError,
    copyDeepLink: options.copyDeepLink,
    resetAll: options.resetAll,
    refreshWorkbenchTeamViews: options.refreshWorkbenchTeamViews,
    applyWorkbenchTeamView: options.applyWorkbenchTeamView,
    duplicateWorkbenchTeamView: options.duplicateWorkbenchTeamView,
    shareWorkbenchTeamView: options.shareWorkbenchTeamView,
    deleteWorkbenchTeamView: options.deleteWorkbenchTeamView,
    archiveWorkbenchTeamView: options.archiveWorkbenchTeamView,
    restoreWorkbenchTeamView: options.restoreWorkbenchTeamView,
    renameWorkbenchTeamView: options.renameWorkbenchTeamView,
    transferWorkbenchTeamView: options.transferWorkbenchTeamView,
    saveWorkbenchTeamView: options.saveWorkbenchTeamView,
    setWorkbenchTeamViewDefault: options.setWorkbenchTeamViewDefault,
    clearWorkbenchTeamViewDefault: options.clearWorkbenchTeamViewDefault,
    deepLinkPreset: options.deepLinkPreset,
    applyDeepLinkPreset: options.applyDeepLinkPreset,
    deepLinkPresets: options.deepLinkPresets,
    movePreset: options.movePreset,
    deepLinkPanelOptions: options.deepLinkPanelOptions,
    deepLinkScope: options.deepLinkScope,
    clearDeepLinkScope: options.clearDeepLinkScope,
    customPresetName: options.customPresetName,
    saveDeepLinkPreset: options.saveDeepLinkPreset,
    deleteDeepLinkPreset: options.deleteDeepLinkPreset,
    editingPresetLabel: options.editingPresetLabel,
    applyPresetRename: options.applyPresetRename,
    exportCustomPresets: options.exportCustomPresets,
    importPresetText: options.importPresetText,
    importCustomPresets: options.importCustomPresets,
    triggerPresetFileImport: options.triggerPresetFileImport,
    importFileInput: options.importFileInput,
    handlePresetFileImport: options.handlePresetFileImport,
    isPresetDropActive: options.isPresetDropActive,
    handlePresetDragEnter: options.handlePresetDragEnter,
    handlePresetDragOver: options.handlePresetDragOver,
    handlePresetDragLeave: options.handlePresetDragLeave,
    handlePresetDrop: options.handlePresetDrop,
    workbenchTeamViewKey: options.workbenchTeamViewKey,
    workbenchTeamViewName: options.workbenchTeamViewName,
    workbenchTeamViewOwnerUserId: options.workbenchTeamViewOwnerUserId,
    showManageWorkbenchTeamViewActions: options.showManageWorkbenchTeamViewActions,
    canSaveWorkbenchTeamView: options.canSaveWorkbenchTeamView,
    canApplyWorkbenchTeamView: options.canApplyWorkbenchTeamView,
    canDuplicateWorkbenchTeamView: options.canDuplicateWorkbenchTeamView,
    canShareWorkbenchTeamView: options.canShareWorkbenchTeamView,
    canDeleteWorkbenchTeamView: options.canDeleteWorkbenchTeamView,
    canArchiveWorkbenchTeamView: options.canArchiveWorkbenchTeamView,
    canRestoreWorkbenchTeamView: options.canRestoreWorkbenchTeamView,
    canRenameWorkbenchTeamView: options.canRenameWorkbenchTeamView,
    canTransferWorkbenchTeamView: options.canTransferWorkbenchTeamView,
    canSetWorkbenchTeamViewDefault: options.canSetWorkbenchTeamViewDefault,
    canClearWorkbenchTeamViewDefault: options.canClearWorkbenchTeamViewDefault,
    workbenchDefaultTeamViewLabel: options.workbenchDefaultTeamViewLabel,
    workbenchTeamViews: options.workbenchTeamViews,
    workbenchTeamViewsLoading: options.workbenchTeamViewsLoading,
    workbenchTeamViewsError: options.workbenchTeamViewsError,
    hasManageableWorkbenchTeamViews: options.hasManageableWorkbenchTeamViews,
    showWorkbenchTeamViewManager: options.showWorkbenchTeamViewManager,
    workbenchTeamViewSelection: options.workbenchTeamViewSelection,
    workbenchTeamViewSelectionCount: options.workbenchTeamViewSelectionCount,
    selectedBatchArchivableWorkbenchTeamViewIds: options.selectedBatchArchivableWorkbenchTeamViewIds,
    selectedBatchRestorableWorkbenchTeamViewIds: options.selectedBatchRestorableWorkbenchTeamViewIds,
    selectedBatchDeletableWorkbenchTeamViewIds: options.selectedBatchDeletableWorkbenchTeamViewIds,
    sceneCatalogOwnerFilter: options.sceneCatalogOwnerFilter,
    sceneCatalogOwnerOptions: options.sceneCatalogOwnerOptions,
    sceneCatalogRecommendationFilter: options.sceneCatalogRecommendationFilter,
    sceneCatalogRecommendationOptions: options.sceneCatalogRecommendationOptions,
    sceneCatalogSummaryChips: options.sceneCatalogSummaryChips,
    sceneCatalogSummaryHint: options.sceneCatalogSummaryHint,
    setSceneCatalogRecommendationFilter: options.setSceneCatalogRecommendationFilter,
    recommendedWorkbenchScenes: options.recommendedWorkbenchScenes,
    selectAllWorkbenchTeamViews: options.selectAllWorkbenchTeamViews,
    clearWorkbenchTeamViewSelection: options.clearWorkbenchTeamViewSelection,
    archiveWorkbenchTeamViewSelection: options.archiveWorkbenchTeamViewSelection,
    restoreWorkbenchTeamViewSelection: options.restoreWorkbenchTeamViewSelection,
    deleteWorkbenchTeamViewSelection: options.deleteWorkbenchTeamViewSelection,
    applyRecommendedWorkbenchScene: options.applyRecommendedWorkbenchScene,
    openRecommendedWorkbenchSceneAudit: options.openRecommendedWorkbenchSceneAudit,
    copyRecommendedWorkbenchSceneLink: options.copyRecommendedWorkbenchSceneLink,
    openWorkbenchSceneAudit: options.openWorkbenchSceneAudit,
    productId: options.productId,
    productItemNumber: options.productItemNumber,
    itemType: options.itemType,
    productLoading: options.productLoading,
    loadProduct: options.loadProduct,
    productError: options.productError,
    product: options.product,
    productView: options.productView,
    formatTime: options.formatTime,
    hasProductCopyValue: options.hasProductCopyValue,
    copyProductField: options.copyProductField,
    productFieldCatalog: options.productFieldCatalog,
    formatJson: options.formatJson,
  }

  return {
    authStateText,
    authStateClass,
    authExpiryText,
    authHint,
    plmAuthStateText,
    plmAuthStateClass,
    plmAuthExpiryText,
    plmAuthHint,
    productPanel,
  }
}
