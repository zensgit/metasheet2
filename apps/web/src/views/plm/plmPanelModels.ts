import type { ComputedRef, Ref } from 'vue'
import type { PlmAuditTeamViewState } from '../plmAuditQueryState'

export type AuthState = 'missing' | 'invalid' | 'expired' | 'expiring' | 'valid'

export type ProductCopyKind = 'id' | 'number' | 'revision' | 'type' | 'status'

export type DeepLinkPreset = {
  key: string
  label: string
  panels: string[]
  params?: Record<string, string | number | boolean>
}

export type PlmDeepLinkPanelOption = {
  key: string
  label: string
}

export type QuickPickOption = {
  key: string
  value: string
  label: string
}

export type SearchItem = {
  id?: string | number
  item_id?: string | number
  itemId?: string | number
  name?: string
  partNumber?: string
  item_number?: string
  itemNumber?: string
  code?: string
  status?: string
  itemType?: string
  updatedAt?: string
  updated_at?: string
  [key: string]: unknown
}

export type ProductProperties = Record<string, unknown> & {
  name?: string
  item_name?: string
  title?: string
  label?: string
  item_number?: string
  part_number?: string
  number?: string
  code?: string
  internal_reference?: string
  revision?: string
  version?: string
  rev?: string
  version_label?: string
  state?: string
  current_state?: string
  status?: string
  lifecycle_state?: string
  item_type?: string
  itemType?: string
  item_type_id?: string
  type?: string
  description?: string
  desc?: string
  created_at?: string
  created_on?: string
  create_date?: string
  updated_at?: string
  modified_on?: string
  write_date?: string
}

export type ProductRecord = Record<string, unknown> & {
  id?: string | number
  name?: string
  item_name?: string
  title?: string
  partNumber?: string
  item_number?: string
  itemNumber?: string
  code?: string
  revision?: string
  version?: string
  version_label?: string
  status?: string
  state?: string
  current_state?: string
  itemType?: string
  item_type_id?: string
  item_type?: string
  type?: string
  description?: string
  createdAt?: string
  created_at?: string
  created_on?: string
  updatedAt?: string
  updated_at?: string
  modified_on?: string
  properties?: ProductProperties | null
}

export type PlmProductViewModel = {
  id: string
  name: string
  partNumber: string
  revision: string
  status: string
  itemType: string
  description: string
  createdAt: string
  updatedAt: string
}

export type PlmProductFieldCatalogEntry = {
  key: string
  label: string
  source: string
  fallback: string
}

export type CompareChangeEntry = UnknownRecord & {
  field?: string
  left?: unknown
  right?: unknown
  normalized_left?: unknown
  normalized_right?: unknown
  severity?: string
}

export type CompareEffectivityEntry = UnknownRecord & {
  type?: string
  start?: string
  end?: string
  start_date?: string
  end_date?: string
}

export type CompareLineProps = UnknownRecord & {
  quantity?: unknown
  uom?: unknown
  unit?: unknown
  find_num?: unknown
  findNum?: unknown
  refdes?: unknown
  effectivity_from?: unknown
  effectivityFrom?: unknown
  effectivity_from_date?: unknown
  effectivity_to?: unknown
  effectivityTo?: unknown
  effectivity_to_date?: unknown
  effectivities?: CompareEffectivityEntry[]
  substitutes?: unknown[]
  substitute_items?: unknown[]
  substitute_count?: unknown
  substitutes_count?: unknown
  substituteCount?: unknown
}

export type CompareEntry = UnknownRecord & {
  relationship_id?: string
  line_key?: string
  child_id?: string
  level?: number
  severity?: string
  parent?: UnknownRecord | null
  child?: UnknownRecord | null
  path?: UnknownRecord[]
  line?: CompareLineProps
  properties?: CompareLineProps
  relationship?: UnknownRecord & {
    id?: string
    properties?: CompareLineProps
  }
  before_line?: CompareLineProps
  before?: CompareLineProps
  after_line?: CompareLineProps
  after?: CompareLineProps
  line_normalized?: CompareLineProps
  before_normalized?: CompareLineProps
  after_normalized?: CompareLineProps
  changes?: CompareChangeEntry[]
}

export type CompareFieldCatalogEntry = {
  key: string
  label: string
  source: string
  severity: string
  normalized: string
}

export type CompareSelectionMeta = {
  kindLabel: string
  tagClass: string
  lineKey: string
  relationshipId: string
  pathLabel: string
}

export type CompareDetailRow = {
  key: string
  label: string
  description: string
  left: string
  right: string
  normalizedLeft: string
  normalizedRight: string
  severity: string
  changed: boolean
}

export type CompareChangeRow = {
  key: string
  field: string
  label: string
  description: string
  normalized: string
  severity: string
  left: unknown
  right: unknown
}

export type CompareSchemaField = {
  field: string
  severity: string
  normalized: string
  description?: string
}

export type CompareModeOption = {
  mode: string
  line_key?: string
  include_relationship_props?: string[]
  aggregate_quantities?: boolean
  aliases?: string[]
  description?: string
}

export type CompareSummary = Record<string, number | undefined>

export type CompareSchemaPayload = {
  line_fields: CompareSchemaField[]
  compare_modes: CompareModeOption[]
  line_key_options: string[]
  defaults?: Record<string, unknown>
}

export type ComparePayload = Record<string, unknown> & {
  summary?: CompareSummary
  added?: CompareEntry[]
  removed?: CompareEntry[]
  changed?: CompareEntry[]
}

export type BomLineContext = Record<string, unknown> & {
  component_code?: string
  componentCode?: string
  component_id?: string
  componentId?: string
  component_name?: string
  componentName?: string
  quantity?: number | string
  unit?: string
  uom?: string
  sequence?: number | string
  find_num?: string | number
  findNum?: string | number
  find_number?: string | number
  refdes?: string | string[]
  parent_item_id?: string
  parentItemId?: string
  bom_line_id?: string
  relationship_id?: string
  relationshipId?: string
}

export type SubstitutePartRecord = UnknownRecord & {
  id?: string | number
  item_number?: string
  itemNumber?: string
  code?: string
  name?: string
  label?: string
  title?: string
  state?: string
  status?: string
  lifecycle_state?: string
}

export type SubstituteRelationshipProperties = UnknownRecord & {
  rank?: string | number
  note?: string
  comment?: string
}

export type SubstituteRelationship = UnknownRecord & {
  id?: string
  properties?: SubstituteRelationshipProperties
}

export type SubstituteEntry = UnknownRecord & {
  id?: string
  rank?: string | number
  relationship?: SubstituteRelationship
  part?: SubstitutePartRecord | null
  substitute_part?: SubstitutePartRecord | null
  substitutePart?: SubstitutePartRecord | null
  source_part?: SubstitutePartRecord | null
  original_part?: SubstitutePartRecord | null
}

export type SubstituteMutationResult = UnknownRecord & {
  substitute_id?: string
  substitute_item_id?: string
}

export type SubstitutesPayload = {
  count?: number
  bom_line_id?: string
  substitutes?: SubstituteEntry[]
}

export type UnknownRecord = Record<string, unknown>

export type DocumentMetadata = UnknownRecord & {
  id?: string | number
  file_id?: string | number
  filename?: string
  file_name?: string
  document_type?: string
  file_type?: string
  document_version?: string
  file_role?: string
  role?: string
  mime_type?: string
  file_size?: string | number
  updated_at?: string
  created_at?: string
  preview_url?: string
  download_url?: string
  author?: string
  source_system?: string
  source_version?: string
}

export type DocumentEntry = UnknownRecord & {
  id?: string | number
  file_id?: string | number
  name?: string
  filename?: string
  file_name?: string
  document_type?: string
  engineering_revision?: string
  revision?: string
  document_version?: string
  engineering_state?: string
  file_role?: string
  mime_type?: string
  file_type?: string
  file_size?: string | number
  size?: string | number
  updated_at?: string
  created_at?: string
  preview_url?: string
  download_url?: string
  author?: string
  source_system?: string
  source_version?: string
  metadata?: DocumentMetadata | null
}

export type ApprovalProductRef = UnknownRecord & {
  id?: string | number
  item_number?: string
}

export type ApprovalEntry = UnknownRecord & {
  id?: string | number
  request_id?: string | number
  version?: string | number
  title?: string
  name?: string
  status?: string
  state?: string
  request_type?: string
  type?: string
  eco_type?: string
  requester_name?: string
  created_by_name?: string
  requester_id?: string | number
  created_by_id?: string | number
  approver_name?: string
  approver_id?: string | number
  created_at?: string
  createdAt?: string
  updated_at?: string
  product_number?: string
  productNumber?: string
  product_code?: string
  product_id?: string | number
  productId?: string | number
  product_name?: string
  productName?: string
  product?: ApprovalProductRef | null
}

export type ApprovalHistoryEntry = UnknownRecord & {
  id?: string | number
  status?: string
  state?: string
  stage?: string
  node?: string
  approval_type?: string
  type?: string
  role?: string
  approver_role?: string
  user_name?: string
  username?: string
  approver_name?: string
  user_id?: string | number
  approver_id?: string | number
  comment?: string
  note?: string
  approved_at?: string
  acted_at?: string
  created_at?: string
}

export type CadPayload = UnknownRecord

export type CadHistoryEntry = UnknownRecord & {
  id?: string | number
  action?: string
  created_at?: string
  user_id?: string | number
  payload?: unknown
}

export type CadHistoryPayload = UnknownRecord & {
  entries?: CadHistoryEntry[]
}

type PanelAction = () => void | Promise<void>
type PanelActionWithArg<T> = (arg: T) => void | Promise<void>

export type FilterPreset = {
  key: string
  label: string
  field: string
  value: string
  group?: string
}

export type PlmTeamViewKind = 'bom' | 'where-used' | 'documents' | 'cad' | 'approvals' | 'workbench' | 'audit'

export type PlmTeamViewState = Record<string, unknown> | PlmAuditTeamViewState

export type PlmTeamFilterPresetKind = 'bom' | 'where-used'

export type PlmTeamFilterPresetState = {
  field: string
  value: string
  group: string
}

export type PlmCollaborativePermissions = {
  canManage: boolean
  canApply: boolean
  canDuplicate: boolean
  canShare: boolean
  canDelete: boolean
  canArchive: boolean
  canRestore: boolean
  canRename: boolean
  canTransfer: boolean
  canSetDefault: boolean
  canClearDefault: boolean
}

export type DocumentSortKey = 'updated' | 'created' | 'name' | 'type' | 'revision' | 'role' | 'mime' | 'size'

export type ApprovalSortKey = 'created' | 'title' | 'status' | 'requester' | 'product'

export type SortDir = 'asc' | 'desc'

export type DocumentColumnState = Record<string, boolean>

export type ApprovalColumnState = Record<string, boolean>

export type PlmTeamView<TState extends object = PlmTeamViewState> = {
  id: string
  kind: PlmTeamViewKind
  scope: 'team'
  name: string
  ownerUserId: string
  canManage: boolean
  permissions?: PlmCollaborativePermissions
  isDefault: boolean
  isArchived?: boolean
  lastDefaultSetAt?: string
  state: TState
  archivedAt?: string
  createdAt?: string
  updatedAt?: string
}

export type PlmTeamFilterPreset = PlmTeamView<PlmTeamFilterPresetState> & {
  kind: PlmTeamFilterPresetKind
}

export type PlmPanelTeamViewsModel<TState extends object = PlmTeamViewState> = {
  key: Ref<string>
  name: Ref<string>
  views: Ref<PlmTeamView<TState>[]>
  loading: Ref<boolean>
  error: Ref<string>
  canSave: ComputedRef<boolean>
  canDelete: ComputedRef<boolean>
  canSetDefault: ComputedRef<boolean>
  canClearDefault: ComputedRef<boolean>
  defaultLabel: ComputedRef<string>
  refresh: PanelAction
  save: PanelAction
  apply: PanelAction
  delete: PanelAction
  setDefault: PanelAction
  clearDefault: PanelAction
}

export type PlmDocumentsTeamViewState = {
  role: string
  filter: string
  sortKey: DocumentSortKey
  sortDir: SortDir
  columns: DocumentColumnState
}

export type PlmCadTeamViewState = {
  fileId: string
  otherFileId: string
  reviewState: string
  reviewNote: string
}

export type PlmApprovalsTeamViewState = {
  status: 'all' | 'pending' | 'approved' | 'rejected'
  filter: string
  sortKey: ApprovalSortKey
  sortDir: SortDir
  columns: ApprovalColumnState
}

export type PlmWorkbenchViewQueryState = {
  query: Record<string, string>
}

export type PlmWorkbenchTeamViewKind = 'documents' | 'cad' | 'approvals' | 'workbench' | 'audit'

export type PlmWorkbenchTeamViewStateByKind = {
  documents: PlmDocumentsTeamViewState
  cad: PlmCadTeamViewState
  approvals: PlmApprovalsTeamViewState
  workbench: PlmWorkbenchViewQueryState
  audit: PlmAuditTeamViewState
}

export type PlmWorkbenchTeamView<
  Kind extends PlmWorkbenchTeamViewKind = PlmWorkbenchTeamViewKind,
> = PlmTeamView<PlmWorkbenchTeamViewStateByKind[Kind]> & { kind: Kind }

export type PlmRecommendedWorkbenchScene = {
  id: string
  name: string
  ownerUserId: string
  isDefault: boolean
  lastDefaultSetAt?: string
  recommendationReason: 'default' | 'recent-default' | 'recent-update'
  recommendationSourceLabel: string
  recommendationSourceTimestamp?: string
  primaryActionKind: 'apply-scene'
  primaryActionLabel: string
  primaryActionDisabled: boolean
  secondaryActionKind: 'copy-link' | 'open-audit'
  secondaryActionLabel: string
  secondaryActionDisabled: boolean
  actionNote: string
  updatedAt?: string
}

export type PlmWorkbenchSceneRecommendationFilter =
  | ''
  | PlmRecommendedWorkbenchScene['recommendationReason']

export type PlmWorkbenchSceneSummaryChip = {
  value: PlmWorkbenchSceneRecommendationFilter
  label: string
  count: number
  active: boolean
}

export type PlmWorkbenchSceneSummaryHint = {
  value: PlmWorkbenchSceneRecommendationFilter
  label: string
  count: number
  description: string
}

export type FilterFieldOption = {
  value: string
  label: string
  placeholder?: string
}

export type BomLineRecord = UnknownRecord & {
  id?: string | number
  level?: unknown
  component_code?: unknown
  component_id?: unknown
  component_name?: unknown
  quantity?: unknown
  unit?: unknown
  parent_item_id?: unknown
}

export type WhereUsedPathNode = {
  id: string
  label: string
  name: string
}

export type WhereUsedLineProps = UnknownRecord & {
  quantity?: unknown
  uom?: unknown
  find_num?: unknown
  findNum?: unknown
  refdes?: unknown
  ref_des?: unknown
}

export type WhereUsedRelationship = UnknownRecord & {
  id?: string
  source_id?: string
  related_id?: string
  parent_id?: string
  quantity?: unknown
  uom?: unknown
  find_num?: unknown
  findNum?: unknown
  refdes?: unknown
  ref_des?: unknown
  properties?: WhereUsedLineProps | null
}

export type WhereUsedEntry = UnknownRecord & {
  _key?: string | number
  level?: unknown
  parent?: UnknownRecord
  line?: WhereUsedLineProps | null
  relationship?: WhereUsedRelationship | null
  pathLabel?: string
  pathNodes?: WhereUsedPathNode[]
}

export type WhereUsedPayload = UnknownRecord & {
  item_id?: string
  parents?: WhereUsedEntry[]
}

export type BomTreeRowModel = {
  key: string
  parentKey?: string
  depth: number
  line?: BomLineRecord
  label: string
  name: string
  componentId: string
  lineId: string
  hasChildren: boolean
  pathLabels: string[]
  pathIds: string[]
}

export type WhereUsedTreeRowModel = {
  key: string
  parentKey?: string
  id: string
  label: string
  name: string
  depth: number
  hasChildren: boolean
  entries: UnknownRecord[]
  entryCount: number
  pathLabels: string[]
  pathIds: string[]
}

export type PlmSearchPanelModel = {
  searchLoading: Ref<boolean>
  searchQuery: Ref<string>
  searchItemType: Ref<string>
  searchLimit: Ref<number>
  searchError: Ref<string>
  searchResults: Ref<SearchItem[]>
  searchTotal: Ref<number>
  searchProducts: () => Promise<void>
  applySearchItem: (item: SearchItem) => Promise<void>
  applyCompareFromSearch: (item: SearchItem, side: 'left' | 'right') => void
  copySearchValue: (item: SearchItem, kind: 'id' | 'number') => Promise<void>
}

export type PlmProductPanelModel = {
  authStateClass: ComputedRef<string>
  authStateText: ComputedRef<string>
  authExpiryText: ComputedRef<string>
  refreshAuthStatus: () => void
  plmAuthStateClass: ComputedRef<string>
  plmAuthStateText: ComputedRef<string>
  plmAuthExpiryText: ComputedRef<string>
  authHint: ComputedRef<string>
  plmAuthHint: ComputedRef<string>
  authError: Ref<string>
  deepLinkStatus: Ref<string>
  deepLinkError: Ref<string>
  copyDeepLink: (panel?: string) => Promise<void>
  resetAll: () => void
  refreshWorkbenchTeamViews: PanelAction
  applyWorkbenchTeamView: PanelAction
  duplicateWorkbenchTeamView: PanelAction
  shareWorkbenchTeamView: PanelAction
  deleteWorkbenchTeamView: PanelAction
  archiveWorkbenchTeamView: PanelAction
  restoreWorkbenchTeamView: PanelAction
  renameWorkbenchTeamView: PanelAction
  transferWorkbenchTeamView: PanelAction
  saveWorkbenchTeamView: PanelAction
  setWorkbenchTeamViewDefault: PanelAction
  clearWorkbenchTeamViewDefault: PanelAction
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
  canSaveWorkbenchTeamView: ComputedRef<boolean>
  canApplyWorkbenchTeamView: ComputedRef<boolean>
  showManageWorkbenchTeamViewActions: ComputedRef<boolean>
  canDuplicateWorkbenchTeamView: ComputedRef<boolean>
  canShareWorkbenchTeamView: ComputedRef<boolean>
  canDeleteWorkbenchTeamView: ComputedRef<boolean>
  canArchiveWorkbenchTeamView: ComputedRef<boolean>
  canRestoreWorkbenchTeamView: ComputedRef<boolean>
  canRenameWorkbenchTeamView: ComputedRef<boolean>
  canTransferWorkbenchTeamViewTarget: ComputedRef<boolean>
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
  sceneCatalogAutoFocusSceneId: Ref<string>
  clearSceneCatalogAutoFocusSceneId: () => void
  setSceneCatalogRecommendationFilter: (value: PlmWorkbenchSceneRecommendationFilter) => void
  recommendedWorkbenchScenes: ComputedRef<PlmRecommendedWorkbenchScene[]>
  selectAllWorkbenchTeamViews: () => void
  clearWorkbenchTeamViewSelection: () => void
  archiveWorkbenchTeamViewSelection: PanelAction
  restoreWorkbenchTeamViewSelection: PanelAction
  deleteWorkbenchTeamViewSelection: PanelAction
  applyRecommendedWorkbenchScene: (viewId: string) => void
  openRecommendedWorkbenchSceneAudit: (scene: PlmRecommendedWorkbenchScene) => Promise<void>
  copyRecommendedWorkbenchSceneLink: (viewId: string) => Promise<void>
  openWorkbenchSceneAudit: PanelAction
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

export type PlmDocumentsPanelModel = {
  copyDeepLink: (panel?: string) => Promise<void>
  exportDocumentsCsv: PanelAction
  loadDocuments: PanelAction
  selectCadFile: (doc: DocumentEntry, target?: 'primary' | 'other') => void
  copyDocumentId: (doc: DocumentEntry) => Promise<void>
  copyDocumentUrl: (doc: DocumentEntry, kind: 'preview' | 'download') => Promise<void>
  getDocumentName: (doc: DocumentEntry) => string
  getDocumentId: (doc: DocumentEntry) => string
  getDocumentType: (doc: DocumentEntry) => string
  getDocumentRevision: (doc: DocumentEntry) => string
  getDocumentRole: (doc: DocumentEntry) => string
  getDocumentAuthor: (doc: DocumentEntry) => string
  getDocumentSourceSystem: (doc: DocumentEntry) => string
  getDocumentSourceVersion: (doc: DocumentEntry) => string
  getDocumentMime: (doc: DocumentEntry) => string
  getDocumentSize: (doc: DocumentEntry) => number | undefined
  getDocumentCreatedAt: (doc: DocumentEntry) => string
  getDocumentUpdatedAt: (doc: DocumentEntry) => string
  getDocumentPreviewUrl: (doc: DocumentEntry) => string
  getDocumentDownloadUrl: (doc: DocumentEntry) => string
  formatBytes: (value?: number) => string
  formatTime: (value?: string) => string
  refreshDocumentTeamViews: PanelAction
  applyDocumentTeamView: PanelAction
  duplicateDocumentTeamView: PanelAction
  shareDocumentTeamView: PanelAction
  deleteDocumentTeamView: PanelAction
  archiveDocumentTeamView: PanelAction
  restoreDocumentTeamView: PanelAction
  renameDocumentTeamView: PanelAction
  transferDocumentTeamView: PanelAction
  saveDocumentTeamView: PanelAction
  setDocumentTeamViewDefault: PanelAction
  clearDocumentTeamViewDefault: PanelAction
  productId: Ref<string>
  documentRole: Ref<string>
  documentFilter: Ref<string>
  documentSortKey: Ref<DocumentSortKey>
  documentSortDir: Ref<SortDir>
  documentColumnOptions: Array<{ key: string; label: string }>
  documentColumns: Ref<Record<string, boolean>>
  documentTeamViewKey: Ref<string>
  documentTeamViewName: Ref<string>
  documentTeamViewOwnerUserId: Ref<string>
  canSaveDocumentTeamView: ComputedRef<boolean>
  canApplyDocumentTeamView: ComputedRef<boolean>
  showManageDocumentTeamViewActions: ComputedRef<boolean>
  canDuplicateDocumentTeamView: ComputedRef<boolean>
  canShareDocumentTeamView: ComputedRef<boolean>
  canDeleteDocumentTeamView: ComputedRef<boolean>
  canArchiveDocumentTeamView: ComputedRef<boolean>
  canRestoreDocumentTeamView: ComputedRef<boolean>
  canRenameDocumentTeamView: ComputedRef<boolean>
  canTransferDocumentTeamViewTarget: ComputedRef<boolean>
  canTransferDocumentTeamView: ComputedRef<boolean>
  canSetDocumentTeamViewDefault: ComputedRef<boolean>
  canClearDocumentTeamViewDefault: ComputedRef<boolean>
  documentDefaultTeamViewLabel: ComputedRef<string>
  hasManageableDocumentTeamViews: ComputedRef<boolean>
  showDocumentTeamViewManager: Ref<boolean>
  documentTeamViewSelection: Ref<string[]>
  documentTeamViewSelectionCount: ComputedRef<number>
  selectedBatchArchivableDocumentTeamViewIds: ComputedRef<string[]>
  selectedBatchRestorableDocumentTeamViewIds: ComputedRef<string[]>
  selectedBatchDeletableDocumentTeamViewIds: ComputedRef<string[]>
  documentTeamViews: Ref<PlmWorkbenchTeamView<'documents'>[]>
  documentTeamViewsLoading: Ref<boolean>
  documentTeamViewsError: Ref<string>
  selectAllDocumentTeamViews: PanelAction
  clearDocumentTeamViewSelection: PanelAction
  archiveDocumentTeamViewSelection: PanelAction
  restoreDocumentTeamViewSelection: PanelAction
  deleteDocumentTeamViewSelection: PanelAction
  documents: Ref<DocumentEntry[]>
  documentsLoading: Ref<boolean>
  documentsError: Ref<string>
  documentsFiltered: ComputedRef<DocumentEntry[]>
  documentsSorted: ComputedRef<DocumentEntry[]>
  documentFieldCatalog: Array<{ key: string; label: string; source: string; fallback: string }>
}

export type PlmCadPanelModel = {
  copyDeepLink: (panel?: string) => Promise<void>
  loadCadMetadata: PanelAction
  loadCadDiff: PanelAction
  updateCadProperties: PanelAction
  updateCadViewState: PanelAction
  updateCadReview: PanelAction
  formatJson: (payload: unknown) => string
  formatTime: (value?: string) => string
  refreshCadTeamViews: PanelAction
  applyCadTeamView: PanelAction
  duplicateCadTeamView: PanelAction
  shareCadTeamView: PanelAction
  deleteCadTeamView: PanelAction
  archiveCadTeamView: PanelAction
  restoreCadTeamView: PanelAction
  renameCadTeamView: PanelAction
  transferCadTeamView: PanelAction
  saveCadTeamView: PanelAction
  setCadTeamViewDefault: PanelAction
  clearCadTeamViewDefault: PanelAction
  cadFileId: Ref<string>
  cadOtherFileId: Ref<string>
  cadTeamViewKey: Ref<string>
  cadTeamViewName: Ref<string>
  cadTeamViewOwnerUserId: Ref<string>
  canSaveCadTeamView: ComputedRef<boolean>
  canApplyCadTeamView: ComputedRef<boolean>
  showManageCadTeamViewActions: ComputedRef<boolean>
  canDuplicateCadTeamView: ComputedRef<boolean>
  canShareCadTeamView: ComputedRef<boolean>
  canDeleteCadTeamView: ComputedRef<boolean>
  canArchiveCadTeamView: ComputedRef<boolean>
  canRestoreCadTeamView: ComputedRef<boolean>
  canRenameCadTeamView: ComputedRef<boolean>
  canTransferCadTeamViewTarget: ComputedRef<boolean>
  canTransferCadTeamView: ComputedRef<boolean>
  canSetCadTeamViewDefault: ComputedRef<boolean>
  canClearCadTeamViewDefault: ComputedRef<boolean>
  cadDefaultTeamViewLabel: ComputedRef<string>
  hasManageableCadTeamViews: ComputedRef<boolean>
  showCadTeamViewManager: Ref<boolean>
  cadTeamViewSelection: Ref<string[]>
  cadTeamViewSelectionCount: ComputedRef<number>
  selectedBatchArchivableCadTeamViewIds: ComputedRef<string[]>
  selectedBatchRestorableCadTeamViewIds: ComputedRef<string[]>
  selectedBatchDeletableCadTeamViewIds: ComputedRef<string[]>
  cadTeamViews: Ref<PlmWorkbenchTeamView<'cad'>[]>
  cadTeamViewsLoading: Ref<boolean>
  cadTeamViewsError: Ref<string>
  selectAllCadTeamViews: PanelAction
  clearCadTeamViewSelection: PanelAction
  archiveCadTeamViewSelection: PanelAction
  restoreCadTeamViewSelection: PanelAction
  deleteCadTeamViewSelection: PanelAction
  cadProperties: Ref<CadPayload | null>
  cadViewState: Ref<CadPayload | null>
  cadReview: Ref<CadPayload | null>
  cadHistory: Ref<CadHistoryPayload | null>
  cadDiff: Ref<CadPayload | null>
  cadMeshStats: Ref<CadPayload | null>
  cadPropertiesDraft: Ref<string>
  cadViewStateDraft: Ref<string>
  cadReviewState: Ref<string>
  cadReviewNote: Ref<string>
  cadLoading: Ref<boolean>
  cadDiffLoading: Ref<boolean>
  cadUpdating: Ref<boolean>
  cadStatus: Ref<string>
  cadError: Ref<string>
  cadActionStatus: Ref<string>
  cadActionError: Ref<string>
  cadHistoryEntries: ComputedRef<CadHistoryEntry[]>
}

export type PlmApprovalsPanelModel = {
  copyDeepLink: (panel?: string) => Promise<void>
  exportApprovalsCsv: PanelAction
  loadApprovals: PanelAction
  refreshApprovalsTeamViews: PanelAction
  applyApprovalsTeamView: PanelAction
  duplicateApprovalsTeamView: PanelAction
  shareApprovalsTeamView: PanelAction
  deleteApprovalsTeamView: PanelAction
  archiveApprovalsTeamView: PanelAction
  restoreApprovalsTeamView: PanelAction
  renameApprovalsTeamView: PanelAction
  transferApprovalsTeamView: PanelAction
  saveApprovalsTeamView: PanelAction
  setApprovalsTeamViewDefault: PanelAction
  clearApprovalsTeamViewDefault: PanelAction
  approvalsLoading: Ref<boolean>
  approvalsStatus: Ref<'all' | 'pending' | 'approved' | 'rejected'>
  approvalsFilter: Ref<string>
  approvalComment: Ref<string>
  approvalSortKey: Ref<ApprovalSortKey>
  approvalSortDir: Ref<SortDir>
  approvalColumnOptions: Array<{ key: string; label: string }>
  approvalColumns: Ref<Record<string, boolean>>
  approvalsTeamViewKey: Ref<string>
  approvalsTeamViewName: Ref<string>
  approvalsTeamViewOwnerUserId: Ref<string>
  canSaveApprovalsTeamView: ComputedRef<boolean>
  canApplyApprovalsTeamView: ComputedRef<boolean>
  showManageApprovalsTeamViewActions: ComputedRef<boolean>
  canDuplicateApprovalsTeamView: ComputedRef<boolean>
  canShareApprovalsTeamView: ComputedRef<boolean>
  canDeleteApprovalsTeamView: ComputedRef<boolean>
  canArchiveApprovalsTeamView: ComputedRef<boolean>
  canRestoreApprovalsTeamView: ComputedRef<boolean>
  canRenameApprovalsTeamView: ComputedRef<boolean>
  canTransferApprovalsTeamViewTarget: ComputedRef<boolean>
  canTransferApprovalsTeamView: ComputedRef<boolean>
  canSetApprovalsTeamViewDefault: ComputedRef<boolean>
  canClearApprovalsTeamViewDefault: ComputedRef<boolean>
  approvalsDefaultTeamViewLabel: ComputedRef<string>
  hasManageableApprovalsTeamViews: ComputedRef<boolean>
  showApprovalsTeamViewManager: Ref<boolean>
  approvalsTeamViewSelection: Ref<string[]>
  approvalsTeamViewSelectionCount: ComputedRef<number>
  selectedBatchArchivableApprovalsTeamViewIds: ComputedRef<string[]>
  selectedBatchRestorableApprovalsTeamViewIds: ComputedRef<string[]>
  selectedBatchDeletableApprovalsTeamViewIds: ComputedRef<string[]>
  approvalsTeamViews: Ref<PlmWorkbenchTeamView<'approvals'>[]>
  approvalsTeamViewsLoading: Ref<boolean>
  approvalsTeamViewsError: Ref<string>
  selectAllApprovalsTeamViews: PanelAction
  clearApprovalsTeamViewSelection: PanelAction
  archiveApprovalsTeamViewSelection: PanelAction
  restoreApprovalsTeamViewSelection: PanelAction
  deleteApprovalsTeamViewSelection: PanelAction
  approvalActionError: Ref<string>
  approvalActionStatus: Ref<string>
  approvalsError: Ref<string>
  approvals: Ref<ApprovalEntry[]>
  approvalsFiltered: ComputedRef<ApprovalEntry[]>
  approvalsSorted: ComputedRef<ApprovalEntry[]>
  approvalActingId: Ref<string>
  approvalHistoryFor: Ref<string>
  approvalHistoryLabel: Ref<string>
  approvalHistoryLoading: Ref<boolean>
  approvalHistoryError: Ref<string>
  approvalHistory: Ref<ApprovalHistoryEntry[]>
  approvalHistoryRows: ComputedRef<ApprovalHistoryEntry[]>
  approvalFieldCatalog: Array<{ key: string; label: string; source: string; fallback: string }>
  formatJson: (payload: unknown) => string
  formatTime: (value?: string) => string
  approvalStatusClass: (value?: string) => string
  getApprovalId: (entry: ApprovalEntry) => string
  getApprovalTitle: (entry: ApprovalEntry) => string
  getApprovalStatus: (entry: ApprovalEntry) => string
  getApprovalType: (entry: ApprovalEntry) => string
  getApprovalRequester: (entry: ApprovalEntry) => string
  getApprovalRequesterId: (entry: ApprovalEntry) => string
  getApprovalCreatedAt: (entry: ApprovalEntry) => string
  getApprovalProductNumber: (entry: ApprovalEntry) => string
  getApprovalProductName: (entry: ApprovalEntry) => string
  getApprovalProductId: (entry: ApprovalEntry) => string
  getApprovalHistoryStatus: (entry: ApprovalHistoryEntry) => string
  getApprovalHistoryStage: (entry: ApprovalHistoryEntry) => string
  getApprovalHistoryType: (entry: ApprovalHistoryEntry) => string
  getApprovalHistoryRole: (entry: ApprovalHistoryEntry) => string
  getApprovalHistoryUser: (entry: ApprovalHistoryEntry) => string
  getApprovalHistoryComment: (entry: ApprovalHistoryEntry) => string
  getApprovalHistoryApprovedAt: (entry: ApprovalHistoryEntry) => string
  getApprovalHistoryCreatedAt: (entry: ApprovalHistoryEntry) => string
  applyProductFromApproval: (entry: ApprovalEntry) => Promise<void>
  copyApprovalId: (entry: ApprovalEntry) => Promise<void>
  loadApprovalHistory: (entry?: ApprovalEntry) => Promise<void>
  clearApprovalHistory: PanelAction
  isApprovalPending: (entry: ApprovalEntry) => boolean
  canActOnApproval: (entry: ApprovalEntry) => boolean
  approveApproval: (entry: ApprovalEntry) => Promise<void>
  rejectApproval: (entry: ApprovalEntry) => Promise<void>
}

export type PlmComparePanelModel = {
  copyDeepLink: (panel?: string) => Promise<void>
  applyCompareFromProduct: (side: 'left' | 'right') => void
  applyCompareQuickPick: (side: 'left' | 'right') => void
  swapCompareSides: () => void
  loadBomCompare: () => Promise<void>
  selectCompareEntry: (entry: CompareEntry, kind: 'added' | 'removed' | 'changed') => void
  clearCompareSelection: () => void
  isCompareEntrySelected: (entry: CompareEntry, kind: 'added' | 'removed' | 'changed') => boolean
  resolveCompareChildKey: (entry: CompareEntry) => string
  resolveCompareLineId: (entry: CompareEntry) => string
  resolveCompareParentKey: (entry: CompareEntry) => string
  getCompareParent: (entry: CompareEntry) => UnknownRecord | null | undefined
  getCompareChild: (entry: CompareEntry) => UnknownRecord | null | undefined
  getCompareProp: (entry: CompareEntry, key: string) => string
  applyProductFromCompareParent: (entry: CompareEntry) => void
  applyWhereUsedFromCompare: (entry: CompareEntry) => void
  applySubstitutesFromCompare: (entry: CompareEntry) => void
  copyCompareLineId: (entry: CompareEntry) => Promise<void>
  formatEffectivity: (entry: CompareEntry) => string
  formatSubstituteCount: (entry: CompareEntry) => string
  getCompareEntrySeverity: (entry: CompareEntry) => string
  getCompareChangeRows: (entry: CompareEntry) => CompareChangeRow[]
  formatDiffValue: (value: unknown) => string
  severityClass: (value?: string) => string
  compareRowClass: (entry: CompareEntry) => string
  copyCompareDetailRows: () => Promise<void>
  exportCompareDetailCsv: () => void
  exportBomCompareCsv: () => void
  getItemNumber: (item: UnknownRecord | null | undefined) => string
  getItemName: (item: UnknownRecord | null | undefined) => string
  formatJson: (payload: unknown) => string
  productId: Ref<string>
  productLoading: Ref<boolean>
  whereUsedLoading: Ref<boolean>
  substitutesLoading: Ref<boolean>
  compareLeftId: Ref<string>
  compareRightId: Ref<string>
  compareLeftQuickPick: Ref<string>
  compareRightQuickPick: Ref<string>
  compareMode: Ref<string>
  compareMaxLevels: Ref<number>
  compareLineKey: Ref<string>
  compareIncludeChildFields: Ref<boolean>
  compareIncludeSubstitutes: Ref<boolean>
  compareIncludeEffectivity: Ref<boolean>
  compareSyncEnabled: Ref<boolean>
  compareEffectiveAt: Ref<string>
  compareFilter: Ref<string>
  compareRelationshipProps: Ref<string>
  bomCompare: Ref<ComparePayload | null>
  compareLoading: Ref<boolean>
  compareError: Ref<string>
  compareSchemaLoading: Ref<boolean>
  compareSchemaError: Ref<string>
  compareQuickOptions: ComputedRef<QuickPickOption[]>
  compareLineKeyOptions: ComputedRef<string[]>
  compareModeOptions: ComputedRef<CompareModeOption[]>
  compareSummary: ComputedRef<CompareSummary>
  compareAdded: ComputedRef<CompareEntry[]>
  compareRemoved: ComputedRef<CompareEntry[]>
  compareChanged: ComputedRef<CompareEntry[]>
  compareAddedFiltered: ComputedRef<CompareEntry[]>
  compareRemovedFiltered: ComputedRef<CompareEntry[]>
  compareChangedFiltered: ComputedRef<CompareEntry[]>
  compareTotalFiltered: ComputedRef<number>
  compareSelectedEntry: ComputedRef<CompareEntry | null>
  compareSelectedMeta: ComputedRef<CompareSelectionMeta | null>
  compareDetailRows: ComputedRef<CompareDetailRow[]>
  compareFieldCatalog: ComputedRef<CompareFieldCatalogEntry[]>
  compareFieldLabelMap: ComputedRef<Map<string, string>>
}

export type PlmSubstitutesPanelModel = {
  copyDeepLink: (panel?: string) => Promise<void>
  loadSubstitutes: () => Promise<void>
  applyBomLineQuickPick: () => void
  applySubstituteQuickPick: () => void
  addSubstitute: () => Promise<void>
  removeSubstitute: (entry: SubstituteEntry) => Promise<void>
  copyBomLineId: () => Promise<void>
  applyWhereUsedFromBom: (entry: BomLineRecord) => void
  getSubstituteNumber: (entry: SubstituteEntry) => string
  getSubstituteId: (entry: SubstituteEntry) => string
  getSubstituteName: (entry: SubstituteEntry) => string
  getSubstituteStatus: (entry: SubstituteEntry) => string
  formatSubstituteRank: (entry: SubstituteEntry) => string
  formatSubstituteNote: (entry: SubstituteEntry) => string
  resolveSubstituteTargetKey: (entry: SubstituteEntry, target: 'substitute' | 'part') => string
  applyProductFromSubstitute: (entry: SubstituteEntry, target: 'substitute' | 'part') => void
  getItemNumber: (item: UnknownRecord | null | undefined) => string
  getItemName: (item: UnknownRecord | null | undefined) => string
  itemStatusClass: (value?: string) => string
  exportSubstitutesCsv: () => void
  formatJson: (payload: unknown) => string
  bomLineId: Ref<string>
  bomLineQuickPick: Ref<string>
  bomLineOptions: ComputedRef<QuickPickOption[]>
  bomLineContext: ComputedRef<BomLineContext | null>
  substitutes: Ref<SubstitutesPayload | null>
  substitutesLoading: Ref<boolean>
  substitutesError: Ref<string>
  substitutesFilter: Ref<string>
  substituteItemId: Ref<string>
  substituteQuickOptions: ComputedRef<QuickPickOption[]>
  substituteQuickPick: Ref<string>
  substituteRank: Ref<string>
  substituteNote: Ref<string>
  substitutesActionStatus: Ref<string>
  substitutesActionError: Ref<string>
  substitutesMutating: Ref<boolean>
  substitutesDeletingId: Ref<string | null>
  substitutesRows: ComputedRef<SubstituteEntry[]>
  productLoading: Ref<boolean>
  whereUsedLoading: Ref<boolean>
}

export type PlmBomPanelModel = {
  copyDeepLink: (panel?: string) => Promise<void>
  loadBom: PanelAction
  expandAllBom: PanelAction
  collapseAllBom: PanelAction
  expandBomToDepth: PanelActionWithArg<number>
  copyBomTablePathIdsBulk: PanelAction
  copyBomTreePathIdsBulk: PanelAction
  copyBomSelectedChildIds: PanelAction
  clearBomSelection: PanelAction
  exportBomCsv: PanelAction
  setBomDepthQuick: PanelActionWithArg<number>
  applyBomFilterPreset: PanelAction
  duplicateBomFilterPreset: PanelAction
  renameBomFilterPreset: PanelAction
  deleteBomFilterPreset: PanelAction
  promoteBomFilterPresetToTeam: PanelAction
  promoteBomFilterPresetToTeamDefault: PanelAction
  shareBomFilterPreset: PanelAction
  assignBomPresetGroup: PanelAction
  saveBomFilterPreset: PanelAction
  refreshBomTeamPresets: PanelAction
  applyBomTeamPreset: PanelAction
  duplicateBomTeamPreset: PanelAction
  shareBomTeamPreset: PanelAction
  archiveBomTeamPreset: PanelAction
  restoreBomTeamPreset: PanelAction
  deleteBomTeamPreset: PanelAction
  renameBomTeamPreset: PanelAction
  transferBomTeamPreset: PanelAction
  saveBomTeamPreset: PanelAction
  setBomTeamPresetDefault: PanelAction
  clearBomTeamPresetDefault: PanelAction
  selectAllBomTeamPresets: PanelAction
  clearBomTeamPresetSelection: PanelAction
  archiveBomTeamPresetSelection: PanelAction
  restoreBomTeamPresetSelection: PanelAction
  deleteBomTeamPresetSelection: PanelAction
  exportBomFilterPresets: PanelAction
  importBomFilterPresets: PanelAction
  triggerBomFilterPresetFileImport: PanelAction
  handleBomFilterPresetFileImport: PanelActionWithArg<Event>
  clearBomFilterPresets: PanelAction
  selectAllBomPresets: PanelAction
  clearBomPresetSelection: PanelAction
  applyBomPresetBatchGroup: PanelAction
  deleteBomPresetSelection: PanelAction
  toggleBomNode: PanelActionWithArg<string>
  isBomCollapsed: (key: string) => boolean
  isBomTreeSelected: (row: BomTreeRowModel) => boolean
  selectBomTreeRow: (row: BomTreeRowModel) => void
  resolveBomLineId: (item: BomLineRecord | null | undefined) => string
  formatBomFindNum: (item: BomLineRecord | null | undefined) => string
  formatBomRefdes: (item: BomLineRecord | null | undefined) => string
  formatBomPathIds: (row: BomTreeRowModel) => string
  copyBomPathIds: PanelActionWithArg<BomTreeRowModel>
  resolveBomChildId: (item: BomLineRecord | null | undefined) => string
  resolveBomChildNumber: (item: BomLineRecord | null | undefined) => string
  applyProductFromBom: (item: BomLineRecord) => void
  applyWhereUsedFromBom: (item: BomLineRecord) => void
  applySubstitutesFromBom: (item: BomLineRecord) => void
  copyBomChildId: PanelActionWithArg<BomLineRecord>
  isBomItemSelected: (item: BomLineRecord) => boolean
  selectBomTableRow: (item: BomLineRecord) => void
  formatBomTablePathIds: (item: BomLineRecord) => string
  copyBomTablePathIds: PanelActionWithArg<BomLineRecord>
  BOM_DEPTH_QUICK_OPTIONS: number[]
  bomView: Ref<'table' | 'tree'>
  bomHasTree: ComputedRef<boolean>
  bomTablePathIdsCount: ComputedRef<number>
  bomTreePathIdsCount: ComputedRef<number>
  bomSelectedCount: ComputedRef<number>
  bomExportCount: ComputedRef<number>
  productId: Ref<string>
  bomLoading: Ref<boolean>
  bomDepth: Ref<number>
  bomEffectiveAt: Ref<string>
  bomFilterFieldOptions: FilterFieldOption[]
  bomFilterField: Ref<string>
  bomFilter: Ref<string>
  bomFilterPlaceholder: ComputedRef<string>
  bomFilterPresetGroupFilter: Ref<string>
  bomFilterPresetGroups: ComputedRef<string[]>
  bomFilterPresetKey: Ref<string>
  bomFilteredPresets: ComputedRef<FilterPreset[]>
  bomFilterPresetName: Ref<string>
  bomFilterPresetGroup: Ref<string>
  canSaveBomFilterPreset: ComputedRef<boolean>
  bomFilterPresets: Ref<FilterPreset[]>
  bomTeamPresetKey: Ref<string>
  bomTeamPresetName: Ref<string>
  bomTeamPresetGroup: Ref<string>
  bomTeamPresetOwnerUserId: Ref<string>
  showManageBomTeamPresetActions: ComputedRef<boolean>
  canSaveBomTeamPreset: ComputedRef<boolean>
  canApplyBomTeamPreset: ComputedRef<boolean>
  canDuplicateBomTeamPreset: ComputedRef<boolean>
  canShareBomTeamPreset: ComputedRef<boolean>
  canDeleteBomTeamPreset: ComputedRef<boolean>
  canArchiveBomTeamPreset: ComputedRef<boolean>
  canRestoreBomTeamPreset: ComputedRef<boolean>
  canRenameBomTeamPreset: ComputedRef<boolean>
  canTransferBomTeamPreset: ComputedRef<boolean>
  canSetBomTeamPresetDefault: ComputedRef<boolean>
  canClearBomTeamPresetDefault: ComputedRef<boolean>
  bomDefaultTeamPresetLabel: ComputedRef<string>
  hasManageableBomTeamPresets: ComputedRef<boolean>
  bomTeamPresets: Ref<PlmTeamFilterPreset[]>
  bomTeamPresetsLoading: Ref<boolean>
  bomTeamPresetsError: Ref<string>
  showBomTeamPresetManager: Ref<boolean>
  bomTeamPresetSelectionCount: ComputedRef<number>
  bomTeamPresetSelection: Ref<string[]>
  selectedBatchArchivableBomTeamPresetIds: ComputedRef<string[]>
  selectedBatchRestorableBomTeamPresetIds: ComputedRef<string[]>
  selectedBatchDeletableBomTeamPresetIds: ComputedRef<string[]>
  bomFilterPresetImportText: Ref<string>
  bomFilterPresetImportMode: Ref<'merge' | 'replace'>
  bomFilterPresetFileInput: Ref<HTMLInputElement | null>
  showBomPresetManager: Ref<boolean>
  bomPresetSelectionCount: ComputedRef<number>
  bomPresetBatchGroup: Ref<string>
  bomPresetSelection: Ref<string[]>
  bomError: Ref<string>
  bomItems: Ref<BomLineRecord[]>
  bomDisplayCount: ComputedRef<number>
  bomTreeVisibleCount: ComputedRef<number>
  bomFilteredItems: ComputedRef<BomLineRecord[]>
  bomTreeVisibleRows: ComputedRef<BomTreeRowModel[]>
  productLoading: Ref<boolean>
  whereUsedLoading: Ref<boolean>
  substitutesLoading: Ref<boolean>
}

export type PlmWhereUsedPanelModel = {
  copyDeepLink: (panel?: string) => Promise<void>
  expandAllWhereUsed: PanelAction
  collapseAllWhereUsed: PanelAction
  copyWhereUsedTablePathIdsBulk: PanelAction
  copyWhereUsedTreePathIdsBulk: PanelAction
  copyWhereUsedSelectedParents: PanelAction
  clearWhereUsedSelection: PanelAction
  exportWhereUsedCsv: PanelAction
  loadWhereUsed: PanelAction
  applyWhereUsedQuickPick: PanelAction
  applyWhereUsedFilterPreset: PanelAction
  duplicateWhereUsedFilterPreset: PanelAction
  renameWhereUsedFilterPreset: PanelAction
  deleteWhereUsedFilterPreset: PanelAction
  promoteWhereUsedFilterPresetToTeam: PanelAction
  promoteWhereUsedFilterPresetToTeamDefault: PanelAction
  shareWhereUsedFilterPreset: PanelAction
  assignWhereUsedPresetGroup: PanelAction
  saveWhereUsedFilterPreset: PanelAction
  refreshWhereUsedTeamPresets: PanelAction
  applyWhereUsedTeamPreset: PanelAction
  duplicateWhereUsedTeamPreset: PanelAction
  shareWhereUsedTeamPreset: PanelAction
  archiveWhereUsedTeamPreset: PanelAction
  restoreWhereUsedTeamPreset: PanelAction
  deleteWhereUsedTeamPreset: PanelAction
  renameWhereUsedTeamPreset: PanelAction
  transferWhereUsedTeamPreset: PanelAction
  saveWhereUsedTeamPreset: PanelAction
  setWhereUsedTeamPresetDefault: PanelAction
  clearWhereUsedTeamPresetDefault: PanelAction
  selectAllWhereUsedTeamPresets: PanelAction
  clearWhereUsedTeamPresetSelection: PanelAction
  archiveWhereUsedTeamPresetSelection: PanelAction
  restoreWhereUsedTeamPresetSelection: PanelAction
  deleteWhereUsedTeamPresetSelection: PanelAction
  exportWhereUsedFilterPresets: PanelAction
  importWhereUsedFilterPresets: PanelAction
  triggerWhereUsedFilterPresetFileImport: PanelAction
  handleWhereUsedFilterPresetFileImport: PanelActionWithArg<Event>
  clearWhereUsedFilterPresets: PanelAction
  selectAllWhereUsedPresets: PanelAction
  clearWhereUsedPresetSelection: PanelAction
  applyWhereUsedPresetBatchGroup: PanelAction
  deleteWhereUsedPresetSelection: PanelAction
  toggleWhereUsedNode: PanelActionWithArg<string>
  isWhereUsedCollapsed: (key: string) => boolean
  isWhereUsedTreeSelected: (row: WhereUsedTreeRowModel) => boolean
  selectWhereUsedTreeRow: (row: WhereUsedTreeRowModel) => void
  getWhereUsedTreeLineValue: (row: WhereUsedTreeRowModel, key: string) => string
  getWhereUsedTreeRefdes: (row: WhereUsedTreeRowModel) => string
  getWhereUsedTreeRelationship: (row: WhereUsedTreeRowModel) => string
  formatWhereUsedPathIds: (row: WhereUsedTreeRowModel) => string
  copyWhereUsedPathIds: PanelActionWithArg<WhereUsedTreeRowModel>
  applyProductFromWhereUsedRow: (row: WhereUsedTreeRowModel) => void
  isWhereUsedEntrySelected: (entry: WhereUsedEntry) => boolean
  selectWhereUsedTableRow: (entry: WhereUsedEntry) => void
  getItemNumber: (item: UnknownRecord | null | undefined) => string
  getItemName: (item: UnknownRecord | null | undefined) => string
  formatWhereUsedEntryPathIds: (entry: WhereUsedEntry) => string
  copyWhereUsedEntryPathIds: PanelActionWithArg<WhereUsedEntry>
  getWhereUsedLineValue: (entry: WhereUsedEntry, key: string) => string
  getWhereUsedRefdes: (entry: WhereUsedEntry) => string
  resolveWhereUsedParentId: (entry: WhereUsedEntry) => string
  applyProductFromWhereUsed: (entry: WhereUsedEntry) => void
  formatJson: (payload: unknown) => string
  whereUsedView: Ref<'table' | 'tree'>
  whereUsedHasTree: ComputedRef<boolean>
  whereUsedPathIdsCount: ComputedRef<number>
  whereUsedTreePathIdsCount: ComputedRef<number>
  whereUsedSelectedCount: ComputedRef<number>
  whereUsedFilteredRows: ComputedRef<WhereUsedEntry[]>
  whereUsedItemId: Ref<string>
  whereUsedLoading: Ref<boolean>
  whereUsedQuickPick: Ref<string>
  whereUsedQuickOptions: ComputedRef<QuickPickOption[]>
  whereUsedRecursive: Ref<boolean>
  whereUsedMaxLevels: Ref<number>
  whereUsedFilterFieldOptions: FilterFieldOption[]
  whereUsedFilterField: Ref<string>
  whereUsedFilter: Ref<string>
  whereUsedFilterPlaceholder: ComputedRef<string>
  whereUsedFilterPresetGroupFilter: Ref<string>
  whereUsedFilterPresetGroups: ComputedRef<string[]>
  whereUsedFilterPresetKey: Ref<string>
  whereUsedFilteredPresets: ComputedRef<FilterPreset[]>
  whereUsedFilterPresetName: Ref<string>
  whereUsedFilterPresetGroup: Ref<string>
  canSaveWhereUsedFilterPreset: ComputedRef<boolean>
  whereUsedFilterPresets: Ref<FilterPreset[]>
  whereUsedTeamPresetKey: Ref<string>
  whereUsedTeamPresetName: Ref<string>
  whereUsedTeamPresetGroup: Ref<string>
  whereUsedTeamPresetOwnerUserId: Ref<string>
  showManageWhereUsedTeamPresetActions: ComputedRef<boolean>
  canSaveWhereUsedTeamPreset: ComputedRef<boolean>
  canApplyWhereUsedTeamPreset: ComputedRef<boolean>
  canDuplicateWhereUsedTeamPreset: ComputedRef<boolean>
  canShareWhereUsedTeamPreset: ComputedRef<boolean>
  canDeleteWhereUsedTeamPreset: ComputedRef<boolean>
  canArchiveWhereUsedTeamPreset: ComputedRef<boolean>
  canRestoreWhereUsedTeamPreset: ComputedRef<boolean>
  canRenameWhereUsedTeamPreset: ComputedRef<boolean>
  canTransferWhereUsedTeamPreset: ComputedRef<boolean>
  canSetWhereUsedTeamPresetDefault: ComputedRef<boolean>
  canClearWhereUsedTeamPresetDefault: ComputedRef<boolean>
  whereUsedDefaultTeamPresetLabel: ComputedRef<string>
  hasManageableWhereUsedTeamPresets: ComputedRef<boolean>
  whereUsedTeamPresets: Ref<PlmTeamFilterPreset[]>
  whereUsedTeamPresetsLoading: Ref<boolean>
  whereUsedTeamPresetsError: Ref<string>
  showWhereUsedTeamPresetManager: Ref<boolean>
  whereUsedTeamPresetSelectionCount: ComputedRef<number>
  whereUsedTeamPresetSelection: Ref<string[]>
  selectedBatchArchivableWhereUsedTeamPresetIds: ComputedRef<string[]>
  selectedBatchRestorableWhereUsedTeamPresetIds: ComputedRef<string[]>
  selectedBatchDeletableWhereUsedTeamPresetIds: ComputedRef<string[]>
  whereUsedFilterPresetImportText: Ref<string>
  whereUsedFilterPresetImportMode: Ref<'merge' | 'replace'>
  whereUsedFilterPresetFileInput: Ref<HTMLInputElement | null>
  showWhereUsedPresetManager: Ref<boolean>
  whereUsedPresetSelectionCount: ComputedRef<number>
  whereUsedPresetBatchGroup: Ref<string>
  whereUsedPresetSelection: Ref<string[]>
  whereUsedError: Ref<string>
  whereUsed: Ref<WhereUsedPayload | null>
  whereUsedTreeVisibleRows: ComputedRef<WhereUsedTreeRowModel[]>
  productLoading: Ref<boolean>
}
