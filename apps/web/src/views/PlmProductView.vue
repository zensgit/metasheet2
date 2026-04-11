<template>
  <div class="plm-page">
    <PlmSearchPanel :panel="searchPanel" />

    <PlmProductPanel :panel="productPanel" />

    <PlmBomPanel :panel="bomPanel" />

    <PlmDocumentsPanel :panel="documentsPanel" />

    <PlmCadPanel :panel="cadPanel" />

    <PlmApprovalsPanel :panel="approvalsPanel" />

    <PlmWhereUsedPanel :panel="whereUsedPanel" />
    <PlmComparePanel :panel="comparePanel" />

    <PlmSubstitutesPanel :panel="substitutesPanel" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { type LocationQueryValue, useRoute, useRouter } from 'vue-router'
import PlmApprovalsPanel from '../components/plm/PlmApprovalsPanel.vue'
import PlmBomPanel from '../components/plm/PlmBomPanel.vue'
import PlmCadPanel from '../components/plm/PlmCadPanel.vue'
import PlmComparePanel from '../components/plm/PlmComparePanel.vue'
import PlmDocumentsPanel from '../components/plm/PlmDocumentsPanel.vue'
import PlmProductPanel from '../components/plm/PlmProductPanel.vue'
import PlmSearchPanel from '../components/plm/PlmSearchPanel.vue'
import PlmSubstitutesPanel from '../components/plm/PlmSubstitutesPanel.vue'
import PlmWhereUsedPanel from '../components/plm/PlmWhereUsedPanel.vue'
import { plmService } from '../services/PlmService'
import type { PlmItemMetadata } from '../services/PlmService'
import type { PlmTeamFilterPresetBatchResult } from '../services/plm/plmWorkbenchClient'
import { copyListToClipboard, copyTextToClipboard } from './plm/plmClipboard'
import { downloadCsvFile } from './plm/plmCsv'
import { resolveApprovalActionVersion } from './approvalInboxActionPayload'
import {
  reconcileApprovalInboxConflictVersion,
  resolveApprovalInboxThrownErrorRecord,
} from './approvalInboxFeedback'
import type {
  ApprovalEntry,
  ApprovalHistoryEntry,
  BomLineRecord,
  BomTreeRowModel,
  CadHistoryEntry,
  CadHistoryPayload,
  CadPayload,
  CompareEffectivityEntry,
  CompareLineProps,
  CompareChangeRow,
  CompareEntry,
  ComparePayload,
  CompareSchemaPayload,
  DeepLinkPreset,
  DocumentMetadata,
  DocumentEntry,
  FilterPreset,
  FilterFieldOption,
  PlmApprovalsPanelModel,
  PlmCadPanelModel,
  PlmDocumentsPanelModel,
  ProductRecord,
  ProductCopyKind,
  PlmRecommendedWorkbenchScene,
  QuickPickOption,
  SubstituteEntry,
  SubstituteMutationResult,
  SubstitutePartRecord,
  SubstitutesPayload,
  UnknownRecord,
  PlmWorkbenchViewQueryState,
  WhereUsedEntry,
  WhereUsedPayload,
  WhereUsedTreeRowModel,
} from './plm/plmPanelModels'
import { usePlmBomPanel } from './plm/usePlmBomPanel'
import { usePlmBomState } from './plm/usePlmBomState'
import { usePlmAuthStatus } from './plm/usePlmAuthStatus'
import { usePlmComparePanel } from './plm/usePlmComparePanel'
import { usePlmCrossPanelActions } from './plm/usePlmCrossPanelActions'
import { usePlmDeepLinkState } from './plm/usePlmDeepLinkState'
import { usePlmExportActions } from './plm/usePlmExportActions'
import { usePlmProductPanel } from './plm/usePlmProductPanel'
import { usePlmSearchPanel } from './plm/usePlmSearchPanel'
import { usePlmSubstitutesPanel } from './plm/usePlmSubstitutesPanel'
import { usePlmTeamFilterPresets } from './plm/usePlmTeamFilterPresets'
import { usePlmTeamViews } from './plm/usePlmTeamViews'
import {
  canApplyPlmCollaborativeEntry,
  canSharePlmCollaborativeEntry,
} from './plm/usePlmCollaborativePermissions'
import {
  applyPlmDeferredRouteQueryPatch,
  mergePlmDeferredRouteQueryPatch,
  resolvePlmDeferredRouteQueryPatch,
} from './plm/plmRouteHydrationPatch'
import { buildProductMetadataRows } from './plm/plmProductMetadata'
import { usePlmWhereUsedPanel } from './plm/usePlmWhereUsedPanel'
import { usePlmWhereUsedState } from './plm/usePlmWhereUsedState'
import {
  buildRecommendedWorkbenchScenes,
  buildWorkbenchSceneCatalogOwnerOptions,
  buildWorkbenchSceneSummaryChips,
  buildWorkbenchSceneSummaryHint,
  WORKBENCH_SCENE_RECOMMENDATION_OPTIONS,
} from './plm/plmWorkbenchSceneCatalog'
import {
  buildPlmWorkbenchLegacyLocalDraftQueryPatch,
  hasExplicitPlmBomTeamPresetAutoApplyQueryState,
  hasExplicitPlmApprovalsAutoApplyQueryState,
  hasExplicitPlmCadAutoApplyQueryState,
  hasExplicitPlmDocumentAutoApplyQueryState,
  buildPlmWorkbenchResetHydratedPanelQueryPatch,
  buildPlmWorkbenchRoutePath,
  buildPlmWorkbenchTeamViewShareUrl,
  hasExplicitPlmWorkbenchAutoApplyQueryState,
  hasExplicitPlmWhereUsedTeamPresetAutoApplyQueryState,
  matchPlmWorkbenchQuerySnapshot,
  mergePlmWorkbenchRouteQuery,
  normalizePlmWorkbenchCollaborativeQuerySnapshot,
  resolvePlmFilterFieldQueryValue,
  normalizePlmWorkbenchLocalRouteQuerySnapshot,
  normalizePlmWorkbenchPanelScope,
  shouldAutoloadPlmProductContext,
  shouldAutoloadPlmWorkbenchSnapshot,
} from './plm/plmWorkbenchViewState'
import {
  matchPlmTeamViewStateSnapshot,
  mergePlmTeamViewBooleanMapDefaults,
  pickPlmTeamViewStateKeys,
} from './plm/plmTeamViewStateMatch'
import {
  matchPlmTeamFilterPresetStateSnapshot,
  pickPlmTeamFilterPresetRouteOwnerState,
} from './plm/plmTeamFilterPresetStateMatch'
import {
  resolvePlmHydratedRemovedTeamPresetOwner,
  resolvePlmHydratedTeamPresetOwnerTakeover,
} from './plm/plmHydratedTeamPresetOwnerTakeover'
import {
  type PlmHydratedPanelDataRouteState,
  resolvePlmHydratedPanelDataReset,
} from './plm/plmHydratedPanelDataReset'
import { resolvePlmHydratedRouteQueryTransition } from './plm/plmHydratedRouteQueryTransition'
import { resolvePlmHydratedLocalFilterPresetTakeover } from './plm/plmHydratedLocalFilterPresetTakeover'
import {
  buildPlmLocalFilterPresetRouteOwnerWatchKey,
  resolvePlmLocalFilterPresetRouteIdentity,
} from './plm/plmLocalFilterPresetRouteIdentity'
import {
  resolvePlmHydratedRemovedTeamViewOwner,
  resolvePlmHydratedTeamViewOwnerTakeover,
} from './plm/plmHydratedTeamViewOwnerTakeover'
import {
  buildClearedPlmLocalPresetManagementState,
  runPlmLocalPresetOwnershipAction,
  shouldClearLocalPresetOwnerAfterTeamPresetAction,
  shouldClearLocalPresetOwnerAfterTeamPresetBatchRestore,
  shouldClearLocalPresetOwnerAfterTeamPresetSingleRestore,
} from './plm/plmLocalPresetOwnership'
import {
  canActOnPlmApproval,
  getPlmApprovalApproverId,
  resolvePlmApprovalActorIds,
} from './plm/plmApprovalActionability'
import {
  resolvePlmApprovalHistoryActorLabel,
  resolvePlmApprovalHistoryVersionLabel,
} from './plm/plmApprovalHistoryDisplay'
import {
  buildRecommendedWorkbenchSceneAuditQuery,
  buildWorkbenchAuditQuery,
} from './plm/plmWorkbenchSceneAudit'
import {
  buildPlmDocumentDegradationMessage,
  type PlmDocumentSourceStatus,
} from './plm/plmDocumentDegradation'
import {
  readWorkbenchSceneFocus,
} from './plm/plmWorkbenchSceneFocus'
import {
  applyFilterPreset,
  buildFilterPresetShareUrl,
  buildTeamFilterPresetShareUrl,
  duplicateFilterPreset,
  renameFilterPreset,
  confirmFilterPresetImport,
  decodeFilterPresetSharePayload,
  exportFilterPresetsFile,
  loadStoredFilterPresets,
  mergeImportedFilterPresets,
  parseFilterPresetImport,
  persistFilterPresets,
  resolveFilterPresetCatalogDraftState,
  resolveFilterPresetShareMode,
  upsertFilterPreset,
} from './plm/plmFilterPresetUtils'

const route = useRoute()
const router = useRouter()

const DEFAULT_ITEM_TYPE = 'Part'
const DEFAULT_SEARCH_LIMIT = 10
const DEFAULT_WHERE_USED_MAX_LEVELS = 5
const DEFAULT_BOM_DEPTH = 2
const BOM_DEPTH_QUICK_OPTIONS = [1, 2, 3]
const DEFAULT_COMPARE_MAX_LEVELS = 10
const DEFAULT_COMPARE_LINE_KEY = 'child_config'
const DEFAULT_COMPARE_REL_PROPS = 'quantity,uom,find_num,refdes'
const DEFAULT_APPROVAL_STATUS = 'pending'
const DEFAULT_COMPARE_LINE_KEYS = [
  'child_config',
  'child_id',
  'relationship_id',
  'child_config_find_num',
  'child_config_refdes',
  'child_config_find_refdes',
  'child_id_find_num',
  'child_id_refdes',
  'child_id_find_refdes',
  'child_config_find_num_qty',
  'child_id_find_num_qty',
  'line_full',
]
const deepLinkPanelOptions = [
  { key: 'search', label: '搜索' },
  { key: 'product', label: '产品' },
  { key: 'documents', label: '文档' },
  { key: 'approvals', label: '审批' },
  { key: 'cad', label: 'CAD 元数据' },
  { key: 'where-used', label: 'Where-Used' },
  { key: 'compare', label: 'BOM 对比' },
  { key: 'substitutes', label: '替代件' },
]
const deepLinkPanelLabels: Record<string, string> = {
  all: '全部',
  search: '搜索',
  product: '产品',
  documents: '文档',
  approvals: '审批',
  cad: 'CAD 元数据',
  'where-used': 'Where-Used',
  compare: 'BOM 对比',
  substitutes: '替代件',
}
const builtInDeepLinkPresets: DeepLinkPreset[] = [
  { key: 'cad-meta', label: 'CAD 元数据', panels: ['cad'] },
  { key: 'product-where-used', label: '产品 + Where-Used', panels: ['product', 'where-used'] },
  { key: 'product-bom-tree', label: '产品 + BOM 树形', panels: ['product'], params: { bomView: 'tree' } },
  { key: 'compare-substitutes', label: 'BOM 对比 + 替代件', panels: ['compare', 'substitutes'] },
  { key: 'docs-approvals', label: '文档 + 审批', panels: ['documents', 'approvals'] },
  { key: 'full-bom', label: '产品 + BOM 全链路', panels: ['product', 'where-used', 'compare', 'substitutes'] },
]

const {
  authState,
  authExpiresAt,
  plmAuthState,
  plmAuthExpiresAt,
  plmAuthLegacy,
  authError,
  refreshAuthStatus,
  handleAuthError,
  startAuthStatusPolling,
  stopAuthStatusPolling,
} = usePlmAuthStatus()

const productId = ref('')
const productItemNumber = ref('')
const itemType = ref(DEFAULT_ITEM_TYPE)
const product = ref<ProductRecord | null>(null)
const productLoading = ref(false)
const productError = ref('')
const productMetadata = ref<PlmItemMetadata | null>(null)
const productMetadataLoading = ref(false)
const productMetadataError = ref('')
const productView = computed(() => {
  const data = product.value || {}
  const props = data.properties || {}
  const name =
    data.name ||
    data.item_name ||
    data.title ||
    props.name ||
    props.item_name ||
    props.title ||
    props.label ||
    data.id ||
    '-'
  const partNumber =
    data.partNumber ||
    data.item_number ||
    data.itemNumber ||
    data.code ||
    props.item_number ||
    props.part_number ||
    props.number ||
    props.code ||
    props.internal_reference ||
    '-'
  const revision =
    data.revision ||
    data.version ||
    data.version_label ||
    props.revision ||
    props.version ||
    props.rev ||
    props.version_label ||
    '-'
  const status =
    data.status ||
    data.state ||
    data.current_state ||
    props.state ||
    props.current_state ||
    props.status ||
    props.lifecycle_state ||
    '-'
  const itemType =
    data.itemType ||
    data.item_type_id ||
    data.item_type ||
    data.type ||
    props.item_type ||
    props.itemType ||
    props.item_type_id ||
    props.type ||
    DEFAULT_ITEM_TYPE
  const description = data.description || props.description || props.desc || ''
  const createdAt =
    data.createdAt ||
    data.created_at ||
    data.created_on ||
    props.created_at ||
    props.created_on ||
    props.create_date ||
    ''
  const updatedAt =
    data.updatedAt ||
    data.updated_at ||
    data.modified_on ||
    props.updated_at ||
    props.modified_on ||
    props.write_date ||
    createdAt ||
    ''
  return {
    id: String(data.id || ''),
    name: String(name),
    partNumber,
    revision,
    status,
    itemType,
    description,
    createdAt,
    updatedAt,
  }
})
const productMetadataRows = computed(() => buildProductMetadataRows(product.value, productMetadata.value))

const documentRole = ref('')
const documentFilter = ref('')
const documentSortKey = ref<'updated' | 'created' | 'name' | 'type' | 'revision' | 'role' | 'mime' | 'size'>('updated')
const documentSortDir = ref<'asc' | 'desc'>('desc')
const defaultDocumentColumns: Record<string, boolean> = {
  fileId: false,
  type: true,
  revision: true,
  role: true,
  author: false,
  sourceSystem: false,
  sourceVersion: false,
  mime: true,
  size: true,
  created: false,
  updated: true,
  preview: true,
  download: true,
  cad: true,
  actions: true,
}
const documentColumns = ref<Record<string, boolean>>({ ...defaultDocumentColumns })
const documentColumnOptions = [
  { key: 'fileId', label: 'File ID' },
  { key: 'type', label: '类型' },
  { key: 'revision', label: '版本' },
  { key: 'role', label: '角色' },
  { key: 'author', label: '作者' },
  { key: 'sourceSystem', label: '来源系统' },
  { key: 'sourceVersion', label: '来源版本' },
  { key: 'mime', label: 'MIME' },
  { key: 'size', label: '大小' },
  { key: 'created', label: '创建时间' },
  { key: 'updated', label: '更新时间' },
  { key: 'preview', label: '预览' },
  { key: 'download', label: '下载' },
  { key: 'cad', label: 'CAD' },
  { key: 'actions', label: '操作' },
]
const documents = ref<DocumentEntry[]>([])
const documentsLoading = ref(false)
const documentsError = ref('')
const documentsWarning = ref('')
const documentSourceProductId = ref('')
const documentSourceItemType = ref('')

const cadFileId = ref('')
const cadOtherFileId = ref('')
const cadProperties = ref<CadPayload | null>(null)
const cadViewState = ref<CadPayload | null>(null)
const cadReview = ref<CadPayload | null>(null)
const cadHistory = ref<CadHistoryPayload | null>(null)
const cadDiff = ref<CadPayload | null>(null)
const cadMeshStats = ref<CadPayload | null>(null)
const cadPropertiesDraft = ref('')
const cadViewStateDraft = ref('')
const cadReviewState = ref('')
const cadReviewNote = ref('')
const cadLoading = ref(false)
const cadDiffLoading = ref(false)
const cadUpdating = ref(false)
const cadStatus = ref('')
const cadError = ref('')
const cadActionStatus = ref('')
const cadActionError = ref('')

const approvals = ref<ApprovalEntry[]>([])
const approvalsStatus = ref<'all' | 'pending' | 'approved' | 'rejected'>(DEFAULT_APPROVAL_STATUS)
const approvalsLoading = ref(false)
const approvalsError = ref('')
const approvalComment = ref('')
const approvalActionStatus = ref('')
const approvalActionError = ref('')
const approvalActingId = ref('')
const approvalActionabilityById = ref<Record<string, boolean>>({})
const approvalActionabilityLoadingById = ref<Record<string, boolean>>({})
const approvalActionabilityActorKey = ref('')
const approvalHistoryFor = ref('')
const approvalHistoryLabel = ref('')
const approvalHistory = ref<ApprovalHistoryEntry[]>([])
const approvalHistoryLoading = ref(false)
const approvalHistoryError = ref('')
const approvalsFilter = ref('')
const approvalSortKey = ref<'created' | 'title' | 'status' | 'requester' | 'product'>('created')
const approvalSortDir = ref<'asc' | 'desc'>('desc')
const defaultApprovalColumns: Record<string, boolean> = {
  id: false,
  status: true,
  type: true,
  requester: true,
  requesterId: false,
  created: true,
  product: true,
  productId: false,
  actions: true,
}
const approvalColumns = ref<Record<string, boolean>>({ ...defaultApprovalColumns })
const approvalColumnOptions = [
  { key: 'id', label: '审批 ID' },
  { key: 'status', label: '状态' },
  { key: 'type', label: '类型' },
  { key: 'requester', label: '发起人' },
  { key: 'requesterId', label: '发起人 ID' },
  { key: 'created', label: '创建时间' },
  { key: 'product', label: '产品' },
  { key: 'productId', label: '产品 ID' },
  { key: 'actions', label: '操作' },
]

const whereUsedFilterFieldOptions = [
  { value: 'all', label: '全部', placeholder: '父件/路径/关系 ID' },
  { value: 'parent_number', label: '父件编号', placeholder: '父件编号' },
  { value: 'parent_name', label: '父件名称', placeholder: '父件名称' },
  { value: 'relationship_id', label: '关系 ID', placeholder: '关系 ID' },
  { value: 'path', label: '路径 ID', placeholder: '路径 ID' },
  { value: 'find_num', label: 'Find #', placeholder: 'Find #' },
  { value: 'refdes', label: 'Refdes', placeholder: 'Refdes' },
  { value: 'quantity', label: '数量', placeholder: '数量' },
  { value: 'uom', label: '单位', placeholder: '单位' },
]
const {
  deepLinkStatus,
  deepLinkError,
  deepLinkScope,
  deepLinkPreset,
  customPresetName,
  editingPresetLabel,
  importPresetText,
  importFileInput,
  isPresetDropActive,
  deepLinkPresets,
  scheduleQuerySync: scheduleBaseQuerySync,
  cancelScheduledQuerySync,
  setDeepLinkMessage,
  resetDeepLinkState,
  clearDeepLinkScope,
  applyDeepLinkPreset,
  saveDeepLinkPreset,
  deleteDeepLinkPreset,
  applyPresetRename,
  movePreset,
  exportCustomPresets,
  importCustomPresets,
  triggerPresetFileImport,
  handlePresetFileImport,
  handlePresetDragEnter,
  handlePresetDragOver,
  handlePresetDragLeave,
  handlePresetDrop,
  parseDeepLinkPanels,
  copyDeepLink,
  cleanupDeepLinkState,
} = usePlmDeepLinkState({
  builtInPresets: builtInDeepLinkPresets,
  panelLabels: deepLinkPanelLabels,
  syncQueryParams,
  buildDeepLinkUrl,
  formatDeepLinkTargets,
  applyPresetParams,
  copyText: copyToClipboard,
})
const isApplyingRouteQueryState = ref(false)
let pendingRouteQueryHydration = false
let deferredRouteQueryPatch: Record<string, string | number | boolean | undefined> | null = null

function scheduleQuerySync(patch: Record<string, string | number | boolean | undefined>) {
  if (isApplyingRouteQueryState.value) {
    deferredRouteQueryPatch = mergePlmDeferredRouteQueryPatch(deferredRouteQueryPatch, patch)
    return
  }
  scheduleBaseQuerySync(patch)
}
const compareLeftId = ref('')
const compareRightId = ref('')
const {
  searchQuery,
  searchItemType,
  searchLimit,
  searchResults,
  searchTotal,
  searchError,
  searchProducts,
  searchPanel,
} = usePlmSearchPanel({
  defaultItemType: DEFAULT_ITEM_TYPE,
  defaultSearchLimit: DEFAULT_SEARCH_LIMIT,
  productId,
  productItemNumber,
  itemType,
  compareLeftId,
  compareRightId,
  loadProduct,
  scheduleQuerySync,
  setDeepLinkMessage,
  copyToClipboard,
  handleAuthError,
})
type CompareSelectionKind = 'added' | 'removed' | 'changed'
const productFieldCatalog = [
  {
    key: 'name',
    label: '名称',
    source: 'name / item_name / title / properties.name / properties.item_name / properties.title / properties.label',
    fallback: 'id',
  },
  {
    key: 'partNumber',
    label: '料号',
    source: 'partNumber / item_number / itemNumber / part_number / number / code / properties.item_number',
    fallback: 'properties.internal_reference',
  },
  {
    key: 'revision',
    label: '版本',
    source: 'revision / version / version_label / properties.revision / properties.version / properties.version_label',
    fallback: '-',
  },
  {
    key: 'status',
    label: '状态',
    source: 'status / state / current_state / properties.state / properties.current_state / properties.status',
    fallback: '-',
  },
  {
    key: 'itemType',
    label: '类型',
    source: 'itemType / item_type_id / item_type / type / properties.item_type / properties.itemType / properties.item_type_id',
    fallback: 'Part',
  },
  {
    key: 'createdAt',
    label: '创建时间',
    source: 'createdAt / created_at / created_on / properties.created_at / properties.created_on / properties.create_date',
    fallback: 'search hit created_at',
  },
  {
    key: 'updatedAt',
    label: '更新时间',
    source: 'updatedAt / updated_at / modified_on / properties.updated_at / properties.modified_on',
    fallback: 'search hit updated_at',
  },
]
const documentFieldCatalog = [
  {
    key: 'file_id',
    label: 'File ID',
    source: 'id / file_id / metadata.file_id',
    fallback: 'id',
  },
  {
    key: 'name',
    label: '名称',
    source: 'name / metadata.filename / filename',
    fallback: 'id',
  },
  {
    key: 'document_type',
    label: '类型',
    source: 'document_type / metadata.document_type / file_type',
    fallback: 'other',
  },
  {
    key: 'engineering_revision',
    label: '版本',
    source: 'engineering_revision / document_version / metadata.document_version',
    fallback: '-',
  },
  {
    key: 'author',
    label: '作者',
    source: 'author / metadata.author',
    fallback: '-',
  },
  {
    key: 'source_system',
    label: '来源系统',
    source: 'source_system / metadata.source_system',
    fallback: '-',
  },
  {
    key: 'source_version',
    label: '来源版本',
    source: 'source_version / metadata.source_version',
    fallback: '-',
  },
  {
    key: 'file_size',
    label: '大小',
    source: 'file_size / metadata.file_size',
    fallback: '0',
  },
  {
    key: 'mime_type',
    label: 'MIME',
    source: 'mime_type / metadata.mime_type / file_type',
    fallback: '-',
  },
  {
    key: 'preview_url',
    label: '预览链接',
    source: 'preview_url / metadata.preview_url',
    fallback: '-',
  },
  {
    key: 'download_url',
    label: '下载链接',
    source: 'download_url / metadata.download_url',
    fallback: '-',
  },
  {
    key: 'engineering_state',
    label: '文档角色',
    source: 'engineering_state / file_role / metadata.file_role',
    fallback: 'unknown',
  },
  {
    key: 'created_at',
    label: '创建时间',
    source: 'created_at / metadata.created_at',
    fallback: '-',
  },
  {
    key: 'updated_at',
    label: '更新时间',
    source: 'updated_at / metadata.updated_at / metadata.created_at',
    fallback: '-',
  },
]
const approvalFieldCatalog = [
  {
    key: 'id',
    label: '审批 ID',
    source: 'id / eco.id',
    fallback: '-',
  },
  {
    key: 'title',
    label: '标题',
    source: 'title / eco.name',
    fallback: 'id',
  },
  {
    key: 'status',
    label: '状态',
    source: 'status / eco.state',
    fallback: 'pending',
  },
  {
    key: 'request_type',
    label: '类型',
    source: 'request_type / eco.eco_type',
    fallback: 'eco',
  },
  {
    key: 'requester_name',
    label: '发起人',
    source: 'requester_name / created_by_name / created_by_id',
    fallback: 'unknown',
  },
  {
    key: 'requester_id',
    label: '发起人 ID',
    source: 'requester_id / created_by_id',
    fallback: '-',
  },
  {
    key: 'created_at',
    label: '创建时间',
    source: 'created_at / updated_at',
    fallback: '-',
  },
  {
    key: 'product_id',
    label: '产品',
    source: 'eco.product_id',
    fallback: '-',
  },
  {
    key: 'product_number',
    label: '产品编号',
    source: 'product_number / product.partNumber / product.code',
    fallback: '-',
  },
  {
    key: 'product_name',
    label: '产品名称',
    source: 'product_name / product.name',
    fallback: '-',
  },
]
const compareFieldLabels: Record<string, string> = {
  quantity: '数量',
  uom: '单位',
  find_num: 'Find #',
  refdes: 'Refdes',
  effectivity_from: '生效起',
  effectivity_to: '生效止',
  effectivities: '生效性',
  substitutes: '替代件',
}
const defaultCompareFieldCatalog = [
  {
    key: 'quantity',
    label: compareFieldLabels.quantity,
    source: 'relationship.properties.quantity',
    severity: 'major',
    normalized: 'float',
  },
  {
    key: 'uom',
    label: compareFieldLabels.uom,
    source: 'relationship.properties.uom',
    severity: 'major',
    normalized: 'uppercase',
  },
  {
    key: 'find_num',
    label: compareFieldLabels.find_num,
    source: 'relationship.properties.find_num',
    severity: 'minor',
    normalized: 'trim',
  },
  {
    key: 'refdes',
    label: compareFieldLabels.refdes,
    source: 'relationship.properties.refdes',
    severity: 'minor',
    normalized: 'list/uppercase',
  },
  {
    key: 'effectivity_from',
    label: compareFieldLabels.effectivity_from,
    source: 'relationship.properties.effectivity_from',
    severity: 'major',
    normalized: 'iso datetime',
  },
  {
    key: 'effectivity_to',
    label: compareFieldLabels.effectivity_to,
    source: 'relationship.properties.effectivity_to',
    severity: 'major',
    normalized: 'iso datetime',
  },
  {
    key: 'effectivities',
    label: compareFieldLabels.effectivities,
    source: 'effectivity records (includeEffectivity)',
    severity: 'major',
    normalized: 'sorted tuples',
  },
  {
    key: 'substitutes',
    label: compareFieldLabels.substitutes,
    source: 'substitutes (includeSubstitutes)',
    severity: 'minor',
    normalized: 'sorted tuples',
  },
]
const bomFilterFieldOptions = [
  { value: 'all', label: '全部', placeholder: '编号/名称/行 ID' },
  { value: 'component', label: '组件编码/ID', placeholder: '组件编码/ID' },
  { value: 'name', label: '组件名称', placeholder: '组件名称' },
  { value: 'line_id', label: 'BOM 行 ID', placeholder: 'BOM 行 ID' },
  { value: 'parent_id', label: '父件 ID', placeholder: '父件 ID' },
  { value: 'find_num', label: 'Find #', placeholder: 'Find #' },
  { value: 'refdes', label: 'Refdes', placeholder: 'Refdes' },
  { value: 'path', label: '路径 ID', placeholder: '路径 ID' },
  { value: 'quantity', label: '数量', placeholder: '数量' },
  { value: 'unit', label: '单位', placeholder: '单位' },
]
function buildQuickPickLabel(source: string, main: string, name: string, id: string): string {
  const mainLabel = main && main !== '-' ? main : id
  const nameLabel = name && name !== '-' ? name : ''
  const base = [mainLabel, nameLabel].filter(Boolean).join(' · ')
  const suffix = id && id !== mainLabel ? ` (${id})` : ''
  return `${source}: ${base || id}${suffix}`
}

function mergeQuickPickOptions(options: QuickPickOption[]): QuickPickOption[] {
  const seen = new Set<string>()
  const merged: QuickPickOption[] = []
  for (const option of options) {
    if (!option?.value || seen.has(option.value)) continue
    seen.add(option.value)
    merged.push(option)
  }
  return merged
}

const searchResultOptions = computed<QuickPickOption[]>(() => {
  const options: QuickPickOption[] = []
  const seen = new Set<string>()
  for (const item of searchResults.value) {
    const { id } = resolveItemKey(item)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const number = getItemNumber(item)
    const name = getItemName(item)
    options.push({
      key: `search:${id}`,
      value: id,
      label: buildQuickPickLabel('搜索', number, name, id),
    })
  }
  return options
})

const {
  bomItems,
  bomLoading,
  bomError,
  bomDepth,
  bomEffectiveAt,
  bomView,
  bomCollapsed,
  bomFilterField,
  bomFilter,
  bomFilterPresetKey,
  bomFilterPresetName,
  bomFilterPresets,
  bomFilterPresetImportText,
  bomFilterPresetImportMode,
  bomFilterPresetGroup,
  bomFilterPresetGroupFilter,
  bomFilterPresetFileInput,
  showBomPresetManager,
  bomPresetSelection,
  bomPresetBatchGroup,
  bomFilterPlaceholder,
  canSaveBomFilterPreset,
  bomFilterPresetGroups,
  bomFilteredPresets,
  bomPresetSelectionCount,
  bomFilteredItems,
  bomSelectedChildIds,
  bomChildOptions,
  bomLineOptions,
  bomSelectedCount,
  bomTreeRows,
  bomTreeFilteredKeys,
  bomTreeVisibleRows,
  bomTreeVisibleCount,
  bomTablePathIdsList,
  bomTablePathIdsCount,
  bomTreePathIdsList,
  bomTreePathIdsCount,
  bomHasTree,
  bomDisplayCount,
  bomExportCount,
  setBomDepthQuick,
  clearBomSelection,
  isBomItemSelected,
  isBomTreeSelected,
  selectBomTreeRow,
  selectBomTableRow,
  isBomCollapsed,
  toggleBomNode,
  expandAllBom,
  collapseAllBom,
  expandBomToDepth,
} = usePlmBomState({
  defaultBomDepth: DEFAULT_BOM_DEPTH,
  bomDepthQuickOptions: BOM_DEPTH_QUICK_OPTIONS,
  filterFieldOptions: bomFilterFieldOptions,
  productId,
  productView,
  searchResultOptions,
  resolveBomLineId,
  resolveBomChildId,
  resolveBomChildNumber,
  formatBomFindNum,
  formatBomRefdes,
  formatBomPathIds,
  formatBomTablePathIds,
})

const whereUsedQuickOptions = computed(() =>
  mergeQuickPickOptions([...bomChildOptions.value, ...searchResultOptions.value])
)
const substituteQuickOptions = computed(() =>
  mergeQuickPickOptions([...bomChildOptions.value, ...searchResultOptions.value])
)
const compareQuickOptions = computed(() => searchResultOptions.value)

const {
  whereUsedItemId,
  whereUsedQuickPick,
  whereUsedRecursive,
  whereUsedMaxLevels,
  whereUsedView,
  whereUsedFilterField,
  whereUsedFilter,
  whereUsedFilterPresetKey,
  whereUsedFilterPresetName,
  whereUsedFilterPresets,
  whereUsedFilterPresetImportText,
  whereUsedFilterPresetImportMode,
  whereUsedFilterPresetGroup,
  whereUsedFilterPresetGroupFilter,
  whereUsedFilterPresetFileInput,
  showWhereUsedPresetManager,
  whereUsedPresetSelection,
  whereUsedPresetBatchGroup,
  whereUsed,
  whereUsedLoading,
  whereUsedError,
  whereUsedFilterPlaceholder,
  canSaveWhereUsedFilterPreset,
  whereUsedFilterPresetGroups,
  whereUsedFilteredPresets,
  whereUsedPresetSelectionCount,
  whereUsedFilteredRows,
  whereUsedPathIdsList,
  whereUsedPathIdsCount,
  whereUsedSelectedParents,
  whereUsedSelectedCount,
  whereUsedTreeVisibleRows,
  whereUsedHasTree,
  whereUsedTreePathIdsList,
  whereUsedTreePathIdsCount,
  clearWhereUsedSelection,
  isWhereUsedEntrySelected,
  isWhereUsedTreeSelected,
  selectWhereUsedTreeRow,
  selectWhereUsedTableRow,
  isWhereUsedCollapsed,
  toggleWhereUsedNode,
  expandAllWhereUsed,
  collapseAllWhereUsed,
} = usePlmWhereUsedState({
  defaultWhereUsedMaxLevels: DEFAULT_WHERE_USED_MAX_LEVELS,
  filterFieldOptions: whereUsedFilterFieldOptions,
  getItemNumber,
  getItemName,
  getWhereUsedLineValue,
  getWhereUsedRefdes,
  resolveWhereUsedParentId,
  formatWhereUsedEntryPathIds,
})

const {
  applyWhereUsedFromBom,
  applySubstitutesFromBom,
  applyProductFromBom,
  applySubstitutesFromCompare,
  applyProductFromWhereUsed,
  applyProductFromWhereUsedRow,
  applyProductFromCompareParent,
  applyWhereUsedFromCompare,
  copyCompareLineId,
  applyProductFromSubstitute,
} = usePlmCrossPanelActions({
  setDeepLinkMessage,
  scheduleQuerySync,
  copyToClipboard,
  resolveBomChildId,
  resolveBomChildNumber,
  resolveBomLineId,
  resolveCompareLineId,
  resolveWhereUsedParentId,
  resolveItemKey,
  getCompareParent,
  getCompareChild,
  resolveSubstituteTarget,
  setProductTarget: (target) => {
    productId.value = target.id
    productItemNumber.value = target.itemNumber
  },
  clearProductError: () => {
    productError.value = ''
  },
  loadProduct: () => loadProduct(),
  setWhereUsedItemId: (value) => {
    whereUsedItemId.value = value
  },
  clearWhereUsedError: () => {
    whereUsedError.value = ''
  },
  isWhereUsedLoading: () => whereUsedLoading.value,
  loadWhereUsed: () => loadWhereUsed(),
  setBomLineId: (value) => {
    bomLineId.value = value
  },
  clearSubstitutesState: () => {
    substitutesError.value = ''
    substitutesActionStatus.value = ''
    substitutesActionError.value = ''
  },
  isSubstitutesLoading: () => substitutesLoading.value,
  loadSubstitutes: () => loadSubstitutes(),
})

const {
  exportWhereUsedCsv,
  exportBomCompareCsv,
  copyCompareDetailRows,
  exportCompareDetailCsv,
  exportBomCsv,
  exportSubstitutesCsv,
  exportDocumentsCsv,
  exportApprovalsCsv,
} = usePlmExportActions({
  setDeepLinkMessage,
  copyToClipboard,
  downloadCsv,
  getWhereUsedFilteredRows: () => whereUsedFilteredRows.value,
  formatWhereUsedEntryPathIds,
  getWhereUsedLineValue,
  getWhereUsedRefdes,
  getItemNumber,
  getItemName,
  getCompareAddedFiltered: () => compareAddedFiltered.value,
  getCompareRemovedFiltered: () => compareRemovedFiltered.value,
  getCompareChangedFiltered: () => compareChangedFiltered.value,
  getCompareProp,
  formatEffectivity,
  formatSubstituteCount,
  getCompareDetailRows: () => compareDetailRows.value,
  getBomView: () => bomView.value,
  getBomTreeRows: () => bomTreeRows.value,
  getBomTreeFilteredKeys: () => bomTreeFilteredKeys.value,
  getBomFilteredItems: () => bomFilteredItems.value,
  getProductId: () => productId.value,
  getProductView: () => productView.value,
  resolveBomChildId,
  resolveBomLineId,
  formatBomFindNum,
  formatBomRefdes,
  formatBomTablePathIds,
  getSubstitutesRows: () => substitutesRows.value,
  getSubstitutesPayload: () => substitutes.value,
  getSubstituteSourcePart,
  getSubstituteId,
  getSubstituteNumber,
  getSubstituteName,
  getSubstituteStatus,
  formatSubstituteRank,
  formatSubstituteNote,
  getDocumentsSorted: () => documentsSorted.value,
  getDocumentName,
  getDocumentType,
  getDocumentRevision,
  getDocumentRole,
  getDocumentAuthor,
  getDocumentSourceSystem,
  getDocumentSourceVersion,
  getDocumentMime,
  getDocumentSize,
  getDocumentCreatedAt,
  getDocumentUpdatedAt,
  getDocumentPreviewUrl,
  getDocumentDownloadUrl,
  getApprovalsSorted: () => approvalsSorted.value,
  getApprovalTitle,
  getApprovalStatus,
  getApprovalType,
  getApprovalRequester,
  getApprovalRequesterId,
  getApprovalCreatedAt,
  getApprovalProductNumber,
  getApprovalProductName,
  getApprovalProductId,
})

const {
  bomLineId,
  substitutes,
  substitutesLoading,
  substitutesError,
  substitutesFilter,
  substituteItemId,
  substituteRank,
  substituteNote,
  substitutesActionStatus,
  substitutesActionError,
  substitutesMutating,
  substitutesDeletingId,
  substitutesRows,
  substitutesPanel,
} = usePlmSubstitutesPanel({
  productLoading,
  whereUsedLoading,
  copyToClipboard,
  setDeepLinkMessage,
  scheduleQuerySync,
  bomLineOptions,
  substituteQuickOptions,
  bomItems,
  getSubstituteNumber,
  getSubstituteName,
  getSubstituteStatus,
  formatSubstituteRank,
  formatSubstituteNote,
  copyDeepLink,
  loadSubstitutes,
  addSubstitute,
  removeSubstitute,
  applyWhereUsedFromBom,
  resolveSubstituteTargetKey,
  applyProductFromSubstitute,
  getSubstituteId,
  getItemNumber,
  getItemName,
  itemStatusClass,
  exportSubstitutesCsv,
  formatJson,
})

const {
  compareMode,
  compareMaxLevels,
  compareLineKey,
  compareIncludeChildFields,
  compareIncludeSubstitutes,
  compareIncludeEffectivity,
  compareSyncEnabled,
  compareEffectiveAt,
  compareFilter,
  compareRelationshipProps,
  bomCompare,
  compareLoading,
  compareError,
  compareSchema,
  compareSchemaLoading,
  compareSchemaError,
  compareSelected,
  compareFieldCatalog,
  compareDetailRows,
  compareAddedFiltered,
  compareRemovedFiltered,
  compareChangedFiltered,
  comparePanel,
} = usePlmComparePanel({
  defaultCompareMaxLevels: DEFAULT_COMPARE_MAX_LEVELS,
  defaultCompareLineKey: DEFAULT_COMPARE_LINE_KEY,
  defaultCompareRelationshipProps: DEFAULT_COMPARE_REL_PROPS,
  defaultCompareLineKeys: DEFAULT_COMPARE_LINE_KEYS,
  compareLeftId,
  compareRightId,
  productId,
  productLoading,
  whereUsedLoading,
  substitutesLoading,
  copyToClipboard,
  setDeepLinkMessage,
  scheduleQuerySync,
  compareQuickOptions,
  filterCompareEntries,
  compareFieldLabels,
  defaultCompareFieldCatalog,
  resolveCompareFieldValue,
  resolveCompareNormalizedValue,
  copyDeepLink,
  applyCompareFromProduct,
  loadBomCompare,
  selectCompareEntry,
  clearCompareSelection,
  isCompareEntrySelected,
  resolveCompareChildKey,
  resolveCompareLineId,
  resolveCompareParentKey,
  getCompareParent,
  getCompareChild,
  getCompareProp,
  applyProductFromCompareParent,
  applyWhereUsedFromCompare,
  applySubstitutesFromCompare,
  copyCompareLineId,
  formatEffectivity,
  formatSubstituteCount,
  getCompareEntrySeverity,
  getCompareChangeRows,
  formatDiffValue,
  severityClass,
  compareRowClass,
  copyCompareDetailRows,
  exportCompareDetailCsv,
  exportBomCompareCsv,
  getItemNumber,
  getItemName,
  formatJson,
})

const compareFieldMetaMap = computed(
  () => new Map(compareFieldCatalog.value.map((entry) => [entry.key, entry])),
)

const bomPathRowMaps = computed(() => {
  const rows = bomTreeRows.value
  const byLineId = new Map<string, BomTreeRowModel>()
  const byPair = new Map<string, BomTreeRowModel>()
  const rowMap = new Map(rows.map((row) => [row.key, row]))
  for (const row of rows) {
    if (!row.line) continue
    const lineId = resolveBomLineId(row.line)
    if (lineId) {
      byLineId.set(lineId, row)
    }
    const parentRow = row.parentKey ? rowMap.get(row.parentKey) : undefined
    const parentId =
      row.line?.parent_item_id ??
      row.line?.parentItemId ??
      parentRow?.componentId ??
      ''
    const childId = resolveBomChildId(row.line) || row.componentId
    if (parentId || childId) {
      byPair.set(`${parentId}::${childId}`, row)
    }
  }
  return { byLineId, byPair }
})

const documentsFiltered = computed(() => {
  const needle = documentFilter.value.trim().toLowerCase()
  if (!needle) return documents.value
  return documents.value.filter((doc) => {
    const tokens = [
      getDocumentName(doc),
      getDocumentId(doc),
      getDocumentType(doc),
      getDocumentRevision(doc),
      getDocumentRole(doc),
      getDocumentAuthor(doc),
      getDocumentSourceSystem(doc),
      getDocumentSourceVersion(doc),
      getDocumentMime(doc),
      doc.id,
      doc.file_id,
    ]
    return tokens.some((token) => String(token || '').toLowerCase().includes(needle))
  })
})

const documentSortConfig: SortConfig<DocumentEntry> = {
  name: { type: 'string', accessor: (doc) => getDocumentName(doc) },
  type: { type: 'string', accessor: (doc) => getDocumentType(doc) },
  revision: { type: 'string', accessor: (doc) => getDocumentRevision(doc) },
  role: { type: 'string', accessor: (doc) => getDocumentRole(doc) },
  mime: { type: 'string', accessor: (doc) => getDocumentMime(doc) },
  size: { type: 'number', accessor: (doc) => getDocumentSize(doc) ?? 0 },
  created: { type: 'date', accessor: (doc) => getDocumentCreatedAt(doc) },
  updated: { type: 'date', accessor: (doc) => getDocumentUpdatedAt(doc) },
}

const documentsSorted = computed(() =>
  sortRows(documentsFiltered.value, documentSortKey.value, documentSortDir.value, documentSortConfig)
)

const cadHistoryEntries = computed<CadHistoryEntry[]>(() => cadHistory.value?.entries || [])

const approvalsFiltered = computed(() => {
  const needle = approvalsFilter.value.trim().toLowerCase()
  if (!needle) return approvals.value
  return approvals.value.filter((entry) => {
    const tokens = [
      getApprovalTitle(entry),
      getApprovalRequester(entry),
      getApprovalRequesterId(entry),
      getApprovalProductName(entry),
      getApprovalProductNumber(entry),
      getApprovalProductId(entry),
      entry.product_id,
      entry.id,
    ]
    return tokens.some((token) => String(token || '').toLowerCase().includes(needle))
  })
})

const approvalSortConfig: SortConfig<ApprovalEntry> = {
  created: { type: 'date', accessor: (entry) => getApprovalCreatedAt(entry) },
  title: { type: 'string', accessor: (entry) => getApprovalTitle(entry) },
  status: { type: 'string', accessor: (entry) => getApprovalStatus(entry) },
  requester: { type: 'string', accessor: (entry) => getApprovalRequester(entry) },
  product: { type: 'string', accessor: (entry) => getApprovalProductNumber(entry) },
}

const approvalsSorted = computed(() =>
  sortRows(approvalsFiltered.value, approvalSortKey.value, approvalSortDir.value, approvalSortConfig)
)

const approvalHistoryRows = computed(() => {
  const rows = approvalHistory.value || []
  const sorted = [...rows]
  sorted.sort((left, right) => {
    const leftTime = Date.parse(getApprovalHistoryApprovedAt(left) || getApprovalHistoryCreatedAt(left) || '')
    const rightTime = Date.parse(getApprovalHistoryApprovedAt(right) || getApprovalHistoryCreatedAt(right) || '')
    return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime)
  })
  return sorted
})

const DOCUMENT_COLUMNS_STORAGE_KEY = 'plm_document_columns'
const APPROVAL_COLUMNS_STORAGE_KEY = 'plm_approval_columns'
const BOM_COLLAPSE_STORAGE_KEY = 'plm_bom_tree_collapsed'
const BOM_FILTER_PRESETS_STORAGE_KEY = 'plm_bom_filter_presets'
const WHERE_USED_FILTER_PRESETS_STORAGE_KEY = 'plm_where_used_filter_presets'
const bomFilterPresetQuery = ref('')
const whereUsedFilterPresetQuery = ref('')

function formatJson(payload: unknown): string {
  return JSON.stringify(payload, null, 2)
}

function formatTime(value?: string): string {
  if (!value) return '-'
  return value
}

function formatBytes(value?: number): string {
  if (!value && value !== 0) return '-'
  if (value < 1024) return `${value} B`
  const kb = value / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  const gb = mb / 1024
  return `${gb.toFixed(1)} GB`
}

async function loadProductMetadataSchema(resolvedItemType: string) {
  if (!resolvedItemType.trim()) {
    productMetadata.value = null
    productMetadataError.value = ''
    productMetadataLoading.value = false
    return
  }

  productMetadataLoading.value = true
  productMetadataError.value = ''
  try {
    productMetadata.value = await plmService.getMetadata<PlmItemMetadata>(resolvedItemType)
  } catch (error: any) {
    handleAuthError(error)
    productMetadata.value = null
    productMetadataError.value = error?.message ?? '加载模型字段失败'
  } finally {
    productMetadataLoading.value = false
  }
}

function resetAll() {
  productId.value = ''
  productItemNumber.value = ''
  product.value = null
  productError.value = ''
  productMetadata.value = null
  productMetadataLoading.value = false
  productMetadataError.value = ''
  authError.value = ''
  resetDeepLinkState()
  workbenchTeamViewQuery.value = ''
  workbenchTeamViewKey.value = ''
  workbenchTeamViewName.value = ''
  workbenchTeamViewOwnerUserId.value = ''
  workbenchTeamViewsError.value = ''
  searchQuery.value = ''
  searchItemType.value = DEFAULT_ITEM_TYPE
  searchLimit.value = DEFAULT_SEARCH_LIMIT
  searchResults.value = []
  searchTotal.value = 0
  searchError.value = ''
  bomItems.value = []
  bomError.value = ''
  bomDepth.value = DEFAULT_BOM_DEPTH
  bomEffectiveAt.value = ''
  bomFilter.value = ''
  bomFilterField.value = 'all'
  bomFilterPresetKey.value = ''
  bomFilterPresetName.value = ''
  bomFilterPresetImportText.value = ''
  bomFilterPresetImportMode.value = 'merge'
  bomFilterPresetGroup.value = ''
  bomFilterPresetQuery.value = ''
  bomTeamPresetQuery.value = ''
  bomTeamPresetKey.value = ''
  bomTeamPresetName.value = ''
  bomTeamPresetGroup.value = ''
  bomTeamPresetOwnerUserId.value = ''
  bomTeamPresetsError.value = ''
  bomFilterPresetGroupFilter.value = 'all'
  showBomPresetManager.value = false
  bomPresetSelection.value = []
  bomPresetBatchGroup.value = ''
  bomView.value = 'table'
  bomCollapsed.value = new Set()
  documentRole.value = ''
  documentSortKey.value = 'updated'
  documentSortDir.value = 'desc'
  documents.value = []
  documentsError.value = ''
  documentsWarning.value = ''
  documentSourceProductId.value = ''
  documentSourceItemType.value = ''
  documentFilter.value = ''
  documentColumns.value = { ...defaultDocumentColumns }
  documentTeamViewQuery.value = ''
  documentTeamViewKey.value = ''
  documentTeamViewName.value = ''
  documentTeamViewOwnerUserId.value = ''
  documentTeamViewsError.value = ''
  cadFileId.value = ''
  cadOtherFileId.value = ''
  cadProperties.value = null
  cadViewState.value = null
  cadReview.value = null
  cadHistory.value = null
  cadDiff.value = null
  cadMeshStats.value = null
  cadPropertiesDraft.value = ''
  cadViewStateDraft.value = ''
  cadReviewState.value = ''
  cadReviewNote.value = ''
  cadTeamViewQuery.value = ''
  cadTeamViewKey.value = ''
  cadTeamViewName.value = ''
  cadTeamViewOwnerUserId.value = ''
  cadTeamViewsError.value = ''
  cadLoading.value = false
  cadDiffLoading.value = false
  cadUpdating.value = false
  cadStatus.value = ''
  cadError.value = ''
  cadActionStatus.value = ''
  cadActionError.value = ''
  approvals.value = []
  approvalsStatus.value = DEFAULT_APPROVAL_STATUS
  approvalSortKey.value = 'created'
  approvalSortDir.value = 'desc'
  approvalsError.value = ''
  approvalComment.value = ''
  approvalActionStatus.value = ''
  approvalActionError.value = ''
  approvalActingId.value = ''
  approvalActionabilityById.value = {}
  approvalActionabilityLoadingById.value = {}
  approvalActionabilityActorKey.value = ''
  approvalHistoryFor.value = ''
  approvalHistoryLabel.value = ''
  approvalHistory.value = []
  approvalHistoryError.value = ''
  approvalHistoryLoading.value = false
  approvalsFilter.value = ''
  approvalColumns.value = { ...defaultApprovalColumns }
  approvalsTeamViewQuery.value = ''
  approvalsTeamViewKey.value = ''
  approvalsTeamViewName.value = ''
  approvalsTeamViewOwnerUserId.value = ''
  approvalsTeamViewsError.value = ''
  whereUsedItemId.value = ''
  whereUsedRecursive.value = true
  whereUsedMaxLevels.value = DEFAULT_WHERE_USED_MAX_LEVELS
  whereUsedView.value = 'table'
  whereUsed.value = null
  whereUsedError.value = ''
  whereUsedFilterField.value = 'all'
  compareLeftId.value = ''
  compareRightId.value = ''
  compareMode.value = ''
  compareMaxLevels.value = DEFAULT_COMPARE_MAX_LEVELS
  compareLineKey.value = DEFAULT_COMPARE_LINE_KEY
  compareIncludeChildFields.value = true
  compareIncludeSubstitutes.value = false
  compareIncludeEffectivity.value = false
  compareSyncEnabled.value = true
  compareEffectiveAt.value = ''
  compareFilter.value = ''
  compareRelationshipProps.value = DEFAULT_COMPARE_REL_PROPS
  bomCompare.value = null
  compareError.value = ''
  compareSchemaError.value = ''
  compareSchemaLoading.value = false
  bomLineId.value = ''
  substitutes.value = null
  substitutesError.value = ''
  substitutesFilter.value = ''
  substituteItemId.value = ''
  substituteRank.value = ''
  substituteNote.value = ''
  substitutesActionStatus.value = ''
  substitutesActionError.value = ''
  substitutesMutating.value = false
  substitutesDeletingId.value = null
  whereUsedFilter.value = ''
  whereUsedFilterPresetKey.value = ''
  whereUsedFilterPresetName.value = ''
  whereUsedFilterPresetQuery.value = ''
  whereUsedTeamPresetQuery.value = ''
  whereUsedTeamPresetKey.value = ''
  whereUsedTeamPresetName.value = ''
  whereUsedTeamPresetGroup.value = ''
  whereUsedTeamPresetOwnerUserId.value = ''
  whereUsedTeamPresetsError.value = ''
  whereUsedFilterPresetImportText.value = ''
  whereUsedFilterPresetImportMode.value = 'merge'
  whereUsedFilterPresetGroup.value = ''
  whereUsedFilterPresetGroupFilter.value = 'all'
  showWhereUsedPresetManager.value = false
  whereUsedPresetSelection.value = []
  whereUsedPresetBatchGroup.value = ''
  syncQueryParams({
    ...buildPlmWorkbenchResetHydratedPanelQueryPatch(),
    searchQuery: '',
    searchItemType: '',
    searchLimit: undefined,
    productId: '',
    itemNumber: '',
    itemType: '',
    cadFileId: '',
    cadOtherFileId: '',
    documentRole: '',
    documentFilter: '',
    approvalsStatus: '',
    approvalsFilter: '',
    whereUsedItemId: '',
    whereUsedRecursive: undefined,
    whereUsedMaxLevels: undefined,
    whereUsedFilterPreset: '',
    whereUsedTeamPreset: '',
    whereUsedFilter: '',
    whereUsedFilterField: '',
    compareLeftId: '',
    compareRightId: '',
    compareMode: '',
    compareLineKey: '',
    compareMaxLevels: undefined,
    compareIncludeChildFields: undefined,
    compareIncludeSubstitutes: undefined,
    compareIncludeEffectivity: undefined,
    compareSync: undefined,
    compareEffectiveAt: '',
    compareRelationshipProps: '',
    compareFilter: '',
    bomDepth: undefined,
    bomEffectiveAt: '',
    bomFilterPreset: '',
    bomTeamPreset: '',
    bomFilter: '',
    bomFilterField: '',
    bomView: '',
    bomCollapsed: '',
    bomLineId: '',
    substitutesFilter: '',
    panel: '',
    autoload: undefined,
  })
}

function normalizeProductCopyValue(value?: string): string {
  if (!value) return ''
  if (value === '-') return ''
  return value
}

function getProductCopyValue(kind: ProductCopyKind): string {
  if (kind === 'id') {
    return normalizeProductCopyValue(productView.value.id || productId.value)
  }
  if (kind === 'number') {
    return normalizeProductCopyValue(productView.value.partNumber)
  }
  if (kind === 'type') {
    return normalizeProductCopyValue(productView.value.itemType)
  }
  if (kind === 'status') {
    return normalizeProductCopyValue(productView.value.status)
  }
  return normalizeProductCopyValue(productView.value.revision)
}

function hasProductCopyValue(kind: ProductCopyKind): boolean {
  return Boolean(getProductCopyValue(kind))
}

async function copyProductField(kind: ProductCopyKind) {
  const value = getProductCopyValue(kind)
  if (!value) {
    const label =
      kind === 'id'
        ? 'ID'
        : kind === 'number'
          ? '料号'
          : kind === 'revision'
            ? '版本'
            : kind === 'type'
              ? '类型'
              : '状态'
    setDeepLinkMessage(`产品缺少${label}`, true)
    return
  }
  const ok = await copyToClipboard(value)
  if (!ok) {
    setDeepLinkMessage('复制失败，请手动复制', true)
    return
  }
  const label =
    kind === 'id'
      ? 'ID'
      : kind === 'number'
        ? '料号'
        : kind === 'revision'
          ? '版本'
          : kind === 'type'
            ? '类型'
            : '状态'
  setDeepLinkMessage(`已复制产品 ${label}：${value}`)
}

async function loadProduct() {
  const resolvedId = productId.value || productItemNumber.value
  if (!resolvedId) return
  syncQueryParams({ productId: productId.value, itemNumber: productItemNumber.value, itemType: itemType.value })
  productLoading.value = true
  productError.value = ''
  productMetadata.value = null
  productMetadataError.value = ''
  try {
    const result = await plmService.getProduct<ProductRecord>(resolvedId, {
      itemType: itemType.value || undefined,
      itemNumber: productItemNumber.value || undefined,
    })
    product.value = result
    if (productView.value.partNumber && !productItemNumber.value) {
      productItemNumber.value = productView.value.partNumber === '-' ? '' : productView.value.partNumber
    }
    if (productView.value.itemType && (itemType.value === DEFAULT_ITEM_TYPE || !itemType.value)) {
      itemType.value = productView.value.itemType
    }
    if (result?.id && result.id !== productId.value) {
      productId.value = String(result.id)
      syncQueryParams({ productId: productId.value })
    }
    const resolvedItemType = (() => {
      const viewItemType = typeof productView.value.itemType === 'string'
        ? productView.value.itemType.trim()
        : ''
      if (viewItemType && viewItemType !== '-') return viewItemType
      const selectedItemType = itemType.value.trim()
      return selectedItemType || DEFAULT_ITEM_TYPE
    })()
    await Promise.all([
      loadProductMetadataSchema(resolvedItemType),
      loadBom(),
      loadDocuments(),
      loadApprovals(),
    ])
  } catch (error: any) {
    handleAuthError(error)
    productMetadata.value = null
    productMetadataError.value = ''
    productError.value = error?.message || '加载产品失败'
  } finally {
    productLoading.value = false
  }
}

async function loadBom() {
  if (!productId.value) return
  bomLoading.value = true
  bomError.value = ''
  try {
    const depthValue = Number.isFinite(bomDepth.value) ? Math.max(1, Math.floor(bomDepth.value)) : undefined
    const effectiveAt = normalizeEffectiveAt(bomEffectiveAt.value)
    const result = await plmService.getBom<BomLineRecord>(productId.value, {
      depth: depthValue,
      effectiveAt,
    })
    bomItems.value = result.items || []
  } catch (error: any) {
    handleAuthError(error)
    bomError.value = error?.message || '加载 BOM 失败'
  } finally {
    bomLoading.value = false
  }
}

function resolveBomChildId(item: BomLineRecord | null | undefined): string {
  const value = item?.component_id ?? item?.componentId ?? item?.child_id ?? item?.childId
  return value ? String(value) : ''
}

function resolveBomChildNumber(item: BomLineRecord | null | undefined): string {
  const value =
    item?.component_code ??
    item?.componentCode ??
    item?.child_code ??
    item?.childCode ??
    item?.item_number ??
    item?.itemNumber ??
    item?.code
  return value ? String(value) : ''
}

function resolveBomLineId(item: BomLineRecord | null | undefined): string {
  const value = item?.id ?? item?.bom_line_id ?? item?.relationship_id ?? item?.relationshipId
  return value ? String(value) : ''
}

function formatBomPathIds(row: BomTreeRowModel): string {
  if (!row?.pathIds?.length) return ''
  return row.pathIds.filter((token) => String(token || '').length > 0).join(' / ')
}

function formatBomTablePathIds(item?: BomLineRecord | null): string {
  const lineId = resolveBomLineId(item)
  const { byLineId, byPair } = bomPathRowMaps.value
  let row: BomTreeRowModel | undefined
  if (lineId) {
    row = byLineId.get(lineId)
  }
  if (!row) {
    const parentId = String(item?.parent_item_id ?? item?.parentItemId ?? '')
    const childId = resolveBomChildId(item)
    if (parentId || childId) {
      row = byPair.get(`${parentId}::${childId}`)
    }
  }
  if (!row?.pathIds?.length) return ''
  return row.pathIds.filter((token) => String(token || '').length > 0).join(' / ')
}

function formatBomFindNum(item: BomLineRecord | null | undefined): string {
  const value = item?.find_num ?? item?.findNum ?? item?.find_number ?? item?.sequence
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).join(', ')
  }
  if (value === undefined || value === null || value === '') {
    return '-'
  }
  return String(value)
}

function formatBomRefdes(item: BomLineRecord | null | undefined): string {
  const value = item?.refdes ?? item?.refDes ?? item?.reference_designator
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).join(', ')
  }
  if (value === undefined || value === null || value === '') {
    return '-'
  }
  return String(value)
}

function resolveCompareLineId(entry: CompareEntry): string {
  const value =
    entry?.relationship_id ??
    entry?.relationship?.id ??
    entry?.line?.relationship_id ??
    entry?.line?.id ??
    entry?.line_id ??
    ''
  return value ? String(value) : ''
}

async function copyToClipboard(value: string): Promise<boolean> {
  return copyTextToClipboard(value)
}

function resolveWhereUsedParentId(entry: WhereUsedEntry): string {
  const value =
    entry?.parent?.id ??
    entry?.relationship?.source_id ??
    entry?.relationship?.parent_id ??
    entry?.parent_id ??
    ''
  return value ? String(value) : ''
}

function applyWhereUsedQuickPick() {
  const value = whereUsedQuickPick.value
  if (!value) return
  whereUsedItemId.value = value
  whereUsedError.value = ''
  scheduleQuerySync({ whereUsedItemId: value })
  setDeepLinkMessage(`已填入 Where-Used 子件 ID：${value}`)
  whereUsedQuickPick.value = ''
}

async function copyBomChildId(item: BomLineRecord) {
  const childId = resolveBomChildId(item)
  const childNumber = resolveBomChildNumber(item)
  const target = childId || childNumber
  if (!target) {
    setDeepLinkMessage('BOM 行缺少子件标识', true)
    return
  }
  const ok = await copyToClipboard(target)
  if (!ok) {
    setDeepLinkMessage('复制子件标识失败', true)
    return
  }
  const label = childId ? 'ID' : '料号'
  setDeepLinkMessage(`已复制子件${label}：${target}`)
}

async function copyBomPathIds(row: BomTreeRowModel) {
  const pathIds = formatBomPathIds(row)
  if (!pathIds) {
    setDeepLinkMessage('缺少路径 ID', true)
    return
  }
  const ok = await copyToClipboard(pathIds)
  if (!ok) {
    setDeepLinkMessage('复制路径 ID 失败', true)
    return
  }
  const lastToken = pathIds.split(' / ').slice(-1)[0] || pathIds
  setDeepLinkMessage(`已复制路径 ID（末级：${lastToken}）`)
}

async function copyBomTablePathIds(item: BomLineRecord) {
  const pathIds = formatBomTablePathIds(item)
  if (!pathIds) {
    setDeepLinkMessage('缺少路径 ID', true)
    return
  }
  const ok = await copyToClipboard(pathIds)
  if (!ok) {
    setDeepLinkMessage('复制路径 ID 失败', true)
    return
  }
  const lastToken = pathIds.split(' / ').slice(-1)[0] || pathIds
  setDeepLinkMessage(`已复制路径 ID（末级：${lastToken}）`)
}

async function copyPathIdsList(label: string, list: string[]) {
  if (!list.length) {
    setDeepLinkMessage(`暂无${label}路径 ID`, true)
    return
  }
  const ok = await copyListToClipboard(list)
  if (!ok) {
    setDeepLinkMessage(`复制${label}路径 ID 失败`, true)
    return
  }
  setDeepLinkMessage(`已复制${label}路径 ID：${list.length} 条`)
}

async function copyValueList(label: string, list: string[]) {
  if (!list.length) {
    setDeepLinkMessage(`暂无${label}`, true)
    return
  }
  const ok = await copyListToClipboard(list)
  if (!ok) {
    setDeepLinkMessage(`复制${label}失败`, true)
    return
  }
  setDeepLinkMessage(`已复制${label}：${list.length} 条`)
}

async function copyBomTablePathIdsBulk() {
  await copyPathIdsList('BOM', bomTablePathIdsList.value)
}

async function copyBomTreePathIdsBulk() {
  await copyPathIdsList('BOM树形', bomTreePathIdsList.value)
}

async function copyBomSelectedChildIds() {
  await copyValueList('子件', bomSelectedChildIds.value)
}

async function copyWhereUsedPathIdsValue(pathIds: string) {
  if (!pathIds) {
    setDeepLinkMessage('缺少路径 ID', true)
    return
  }
  const ok = await copyToClipboard(pathIds)
  if (!ok) {
    setDeepLinkMessage('复制路径 ID 失败', true)
    return
  }
  const lastToken = pathIds.split(' / ').slice(-1)[0] || pathIds
  setDeepLinkMessage(`已复制路径 ID（末级：${lastToken}）`)
}

async function copyWhereUsedPathIds(row: WhereUsedTreeRowModel) {
  const pathIds = formatWhereUsedPathIds(row)
  await copyWhereUsedPathIdsValue(pathIds)
}

async function copyWhereUsedEntryPathIds(entry: WhereUsedEntry) {
  const pathIds = formatWhereUsedEntryPathIds(entry)
  await copyWhereUsedPathIdsValue(pathIds)
}

async function copyWhereUsedTablePathIdsBulk() {
  await copyPathIdsList('Where-Used', whereUsedPathIdsList.value)
}

async function copyWhereUsedTreePathIdsBulk() {
  await copyPathIdsList('Where-Used树形', whereUsedTreePathIdsList.value)
}

async function copyWhereUsedSelectedParents() {
  await copyValueList('父件', whereUsedSelectedParents.value)
}

function applyCompareFromProduct(side: 'left' | 'right') {
  if (!productId.value) {
    setDeepLinkMessage('请先加载产品', true)
    return
  }
  if (side === 'left') {
    compareLeftId.value = productId.value
  } else {
    compareRightId.value = productId.value
  }
  scheduleQuerySync({
    compareLeftId: compareLeftId.value || undefined,
    compareRightId: compareRightId.value || undefined,
  })
  setDeepLinkMessage(`已设为对比${side === 'left' ? '左' : '右'}侧：${productId.value}`)
}

async function loadDocuments() {
  if (!productId.value) return
  documentsLoading.value = true
  documentsError.value = ''
  documentsWarning.value = ''
  try {
    const result = await plmService.listDocuments<DocumentEntry>({
      productId: productId.value,
      role: documentRole.value || undefined,
    })
    documents.value = result.items || []
    const degradation = buildPlmDocumentDegradationMessage(
      (result.sources ?? []) as PlmDocumentSourceStatus[],
    )
    if (degradation.error) {
      documentsError.value = degradation.error
    } else if (degradation.warning) {
      documentsWarning.value = degradation.warning
    }
  } catch (error: any) {
    handleAuthError(error)
    documentsError.value = error?.message || '加载文档失败'
  } finally {
    documentsLoading.value = false
  }
}

function resolveCadFileId(doc: DocumentEntry): string {
  const fileId = doc?.id || doc?.file_id
  return fileId ? String(fileId) : ''
}

function selectCadFile(doc: DocumentEntry, target: 'primary' | 'other' = 'primary') {
  const fileId = resolveCadFileId(doc)
  if (!fileId) return
  if (target === 'other') {
    cadOtherFileId.value = fileId
    cadStatus.value = '已设置对比 CAD 文件'
  } else {
    cadFileId.value = fileId
    cadStatus.value = '已设置 CAD 文件'
  }
  scheduleQuerySync({
    cadFileId: cadFileId.value || undefined,
    cadOtherFileId: cadOtherFileId.value || undefined,
  })
}

function resolveErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return fallback
}

async function loadCadMetadata() {
  if (!cadFileId.value) return
  syncQueryParams({ cadFileId: cadFileId.value, cadOtherFileId: cadOtherFileId.value })
  cadLoading.value = true
  cadError.value = ''
  cadStatus.value = ''
  const payload = { fileId: cadFileId.value }
  const tasks = [
    {
      label: '属性',
      run: () => plmService.getCadProperties<CadPayload>(payload.fileId as string),
      apply: (data: any) => {
        cadProperties.value = data
        cadPropertiesDraft.value = JSON.stringify({ properties: data?.properties ?? {} }, null, 2)
      },
    },
    {
      label: '视图状态',
      run: () => plmService.getCadViewState<CadPayload>(payload.fileId as string),
      apply: (data: any) => {
        cadViewState.value = data
        cadViewStateDraft.value = JSON.stringify({
          hidden_entity_ids: data?.hidden_entity_ids ?? [],
          notes: data?.notes ?? [],
        }, null, 2)
      },
    },
    {
      label: '评审',
      run: () => plmService.getCadReview<CadPayload>(payload.fileId as string),
      apply: (data: any) => {
        cadReview.value = data
        cadReviewState.value = data?.state || ''
        cadReviewNote.value = data?.note || ''
      },
    },
    {
      label: '历史',
      run: () => plmService.getCadHistory<CadHistoryPayload>(payload.fileId as string),
      apply: (data: any) => {
        cadHistory.value = data
      },
    },
    {
      label: '网格统计',
      run: () => plmService.getCadMeshStats<CadPayload>(payload.fileId as string),
      apply: (data: any) => {
        cadMeshStats.value = data
      },
    },
  ]
  const results = await Promise.allSettled(tasks.map((task) => task.run()))
  const errors: string[] = []
  results.forEach((result, index) => {
    const task = tasks[index]
    if (result.status === 'fulfilled') {
      task.apply(result.value)
      return
    }
    handleAuthError(result.reason)
    errors.push(`${task.label}: ${resolveErrorMessage(result.reason, '请求失败')}`)
  })
  cadError.value = errors.join('；')
  if (!errors.length) {
    cadStatus.value = 'CAD 元数据已加载'
  }
  cadLoading.value = false
}

async function loadCadDiff() {
  if (!cadFileId.value || !cadOtherFileId.value) return
  syncQueryParams({ cadFileId: cadFileId.value, cadOtherFileId: cadOtherFileId.value })
  cadDiffLoading.value = true
  cadError.value = ''
  try {
    cadDiff.value = await plmService.getCadDiff<CadPayload>({
      fileId: cadFileId.value,
      otherFileId: cadOtherFileId.value,
    })
    cadStatus.value = 'CAD 差异已加载'
  } catch (error: any) {
    handleAuthError(error)
    cadError.value = error?.message || '加载差异失败'
  } finally {
    cadDiffLoading.value = false
  }
}

function parseJsonObject(value: string, label: string): Record<string, unknown> | null {
  const trimmed = value.trim()
  if (!trimmed) return {}
  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label} 需要是 JSON 对象`)
    }
    return parsed as Record<string, unknown>
  } catch (error: any) {
    cadActionError.value = error?.message || `${label} JSON 解析失败`
    return null
  }
}

async function updateCadProperties() {
  if (!cadFileId.value) return
  cadUpdating.value = true
  cadActionError.value = ''
  cadActionStatus.value = ''
  try {
    const payload = parseJsonObject(cadPropertiesDraft.value, '属性')
    if (!payload) return
    const result = await plmService.updateCadProperties<CadPayload>({
      fileId: cadFileId.value,
      payload,
    })
    cadProperties.value = result
    cadPropertiesDraft.value = JSON.stringify({ properties: result?.properties ?? {} }, null, 2)
    cadActionStatus.value = '已更新属性'
  } catch (error: any) {
    handleAuthError(error)
    cadActionError.value = error?.message || '更新属性失败'
  } finally {
    cadUpdating.value = false
  }
}

async function updateCadViewState() {
  if (!cadFileId.value) return
  cadUpdating.value = true
  cadActionError.value = ''
  cadActionStatus.value = ''
  try {
    const payload = parseJsonObject(cadViewStateDraft.value, '视图状态')
    if (!payload) return
    const result = await plmService.updateCadViewState<CadPayload>({
      fileId: cadFileId.value,
      payload,
    })
    cadViewState.value = result
    cadViewStateDraft.value = JSON.stringify({
      hidden_entity_ids: result?.hidden_entity_ids ?? [],
      notes: result?.notes ?? [],
    }, null, 2)
    cadActionStatus.value = '已更新视图状态'
  } catch (error: any) {
    handleAuthError(error)
    cadActionError.value = error?.message || '更新视图状态失败'
  } finally {
    cadUpdating.value = false
  }
}

async function updateCadReview() {
  if (!cadFileId.value) return
  const state = cadReviewState.value.trim()
  if (!state) {
    cadActionError.value = '请填写评审状态'
    return
  }
  cadUpdating.value = true
  cadActionError.value = ''
  cadActionStatus.value = ''
  try {
    const payload: Record<string, unknown> = { state }
    if (cadReviewNote.value.trim()) {
      payload.note = cadReviewNote.value.trim()
    }
    const result = await plmService.updateCadReview<CadPayload>({
      fileId: cadFileId.value,
      payload,
    })
    cadReview.value = result
    cadReviewState.value = typeof result?.state === 'string' ? result.state : state
    cadReviewNote.value = typeof result?.note === 'string' ? result.note : cadReviewNote.value
    cadActionStatus.value = '评审已提交'
  } catch (error: any) {
    handleAuthError(error)
    cadActionError.value = error?.message || '提交评审失败'
  } finally {
    cadUpdating.value = false
  }
}

async function loadApprovals() {
  approvalsLoading.value = true
  approvalsError.value = ''
  try {
    const result = await plmService.listApprovals<ApprovalEntry>({
      productId: productId.value || undefined,
      status: approvalsStatus.value,
    })
    approvals.value = result.items || []
    void warmApprovalActionability(approvals.value)
  } catch (error: any) {
    handleAuthError(error)
    approvalsError.value = error?.message || '加载审批失败'
  } finally {
    approvalsLoading.value = false
  }
}

async function loadWhereUsed() {
  if (!whereUsedItemId.value) return
  syncQueryParams({
    whereUsedItemId: whereUsedItemId.value,
    whereUsedRecursive: whereUsedRecursive.value,
    whereUsedMaxLevels: whereUsedMaxLevels.value,
  })
  whereUsedLoading.value = true
  whereUsedError.value = ''
  try {
    whereUsed.value = await plmService.getWhereUsed<WhereUsedPayload>({
      itemId: whereUsedItemId.value,
      recursive: whereUsedRecursive.value,
      maxLevels: whereUsedMaxLevels.value,
    })
  } catch (error: any) {
    handleAuthError(error)
    whereUsedError.value = error?.message || '查询 where-used 失败'
  } finally {
    whereUsedLoading.value = false
  }
}

function applyCompareSchemaDefaults(schema: CompareSchemaPayload | null) {
  if (!schema) return
  const defaults = schema.defaults || {}
  const defaultMaxLevels = Number(defaults.max_levels)
  if (Number.isFinite(defaultMaxLevels) && compareMaxLevels.value === DEFAULT_COMPARE_MAX_LEVELS) {
    compareMaxLevels.value = defaultMaxLevels
  }
  const defaultLineKey = typeof defaults.line_key === 'string' ? defaults.line_key.trim() : ''
  if (defaultLineKey && (compareLineKey.value === DEFAULT_COMPARE_LINE_KEY || !compareLineKey.value)) {
    compareLineKey.value = defaultLineKey
  }
  if (
    typeof defaults.include_substitutes === 'boolean' &&
    compareIncludeSubstitutes.value === false
  ) {
    compareIncludeSubstitutes.value = defaults.include_substitutes
  }
  if (
    typeof defaults.include_effectivity === 'boolean' &&
    compareIncludeEffectivity.value === false
  ) {
    compareIncludeEffectivity.value = defaults.include_effectivity
  }
}

async function loadBomCompareSchema() {
  compareSchemaLoading.value = true
  compareSchemaError.value = ''
  try {
    const result = await plmService.getBomCompareSchema<CompareSchemaPayload>()
    compareSchema.value = result
    applyCompareSchemaDefaults(result)
  } catch (error: any) {
    handleAuthError(error)
    compareSchemaError.value = error?.message || '加载 BOM 对比字段失败'
  } finally {
    compareSchemaLoading.value = false
  }
}

async function loadBomCompare() {
  if (!compareLeftId.value || !compareRightId.value) return
  syncQueryParams({
    compareLeftId: compareLeftId.value,
    compareRightId: compareRightId.value,
    compareMode: compareMode.value || undefined,
    compareLineKey: compareLineKey.value || undefined,
    compareMaxLevels: compareMaxLevels.value,
    compareIncludeChildFields: compareIncludeChildFields.value,
    compareIncludeSubstitutes: compareIncludeSubstitutes.value,
    compareIncludeEffectivity: compareIncludeEffectivity.value,
    compareEffectiveAt: compareEffectiveAt.value || undefined,
    compareRelationshipProps: compareRelationshipProps.value || undefined,
  })
  compareLoading.value = true
  compareError.value = ''
  try {
    const relProps = compareRelationshipProps.value
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
    const effectiveAt = normalizeEffectiveAt(compareEffectiveAt.value)
    bomCompare.value = await plmService.getBomCompare<ComparePayload>({
      leftId: compareLeftId.value,
      rightId: compareRightId.value,
      leftType: 'item',
      rightType: 'item',
      maxLevels: compareMaxLevels.value,
      compareMode: compareMode.value || undefined,
      lineKey: compareLineKey.value || undefined,
      includeChildFields: compareIncludeChildFields.value,
      includeSubstitutes: compareIncludeSubstitutes.value,
      includeEffectivity: compareIncludeEffectivity.value,
      includeRelationshipProps: relProps.length ? relProps : undefined,
      effectiveAt,
    })
  } catch (error: any) {
    handleAuthError(error)
    compareError.value = error?.message || 'BOM 对比失败'
  } finally {
    compareLoading.value = false
  }
}

async function loadSubstitutes() {
  if (!bomLineId.value) return
  syncQueryParams({ bomLineId: bomLineId.value })
  substitutesLoading.value = true
  substitutesError.value = ''
  try {
    substitutes.value = await plmService.listSubstitutes<SubstitutesPayload>(bomLineId.value)
  } catch (error: any) {
    handleAuthError(error)
    substitutesError.value = error?.message || '查询替代件失败'
  } finally {
    substitutesLoading.value = false
  }
}

function buildSubstituteProperties(): Record<string, unknown> | undefined {
  const props: Record<string, unknown> = {}
  const rankValue = substituteRank.value.trim()
  if (rankValue) {
    const numeric = Number(rankValue)
    props.rank = Number.isNaN(numeric) ? rankValue : numeric
  }
  const noteValue = substituteNote.value.trim()
  if (noteValue) {
    props.note = noteValue
  }
  return Object.keys(props).length ? props : undefined
}

async function addSubstitute() {
  if (!bomLineId.value || !substituteItemId.value) return
  const requestedId = substituteItemId.value
  substitutesMutating.value = true
  substitutesActionError.value = ''
  substitutesActionStatus.value = ''
  try {
    const result = await plmService.addSubstitute<SubstituteMutationResult>({
      bomLineId: bomLineId.value,
      substituteItemId: substituteItemId.value,
      properties: buildSubstituteProperties(),
    })
    const relationId = result?.substitute_id
    const itemId = result?.substitute_item_id || requestedId
    substitutesActionStatus.value = relationId
      ? `已新增替代件 ${itemId}（关系 ${relationId}）`
      : `已新增替代件 ${itemId}`
    substituteItemId.value = ''
    substituteRank.value = ''
    substituteNote.value = ''
    await loadSubstitutes()
  } catch (error: any) {
    handleAuthError(error)
    substitutesActionError.value = error?.message || '新增替代件失败'
  } finally {
    substitutesMutating.value = false
  }
}

async function removeSubstitute(entry: SubstituteEntry) {
  if (!bomLineId.value) return
  const substituteId = entry?.id || entry?.relationship?.id
  if (!substituteId) {
    substitutesActionError.value = '缺少替代关系 ID'
    return
  }
  if (!window.confirm('确认删除该替代件？')) {
    return
  }
  substitutesDeletingId.value = substituteId
  substitutesMutating.value = true
  substitutesActionError.value = ''
  substitutesActionStatus.value = ''
  try {
    await plmService.removeSubstitute({
      bomLineId: bomLineId.value,
      substituteId,
    })
    substitutesActionStatus.value = `已删除替代件 ${substituteId}`
    await loadSubstitutes()
  } catch (error: any) {
    handleAuthError(error)
    substitutesActionError.value = error?.message || '删除替代件失败'
  } finally {
    substitutesMutating.value = false
    substitutesDeletingId.value = null
  }
}

function getItemNumber(item?: UnknownRecord | null): string {
  if (!item) return '-'
  return String(item.item_number || item.itemNumber || item.code || item.id || '-')
}

function getItemName(item?: UnknownRecord | null): string {
  if (!item) return '-'
  return String(item.name || item.label || item.title || '-')
}

function resolveItemKey(item?: UnknownRecord | null): { id: string; itemNumber: string } {
  if (!item) return { id: '', itemNumber: '' }
  const id = item.id || item.item_id || item.itemId || ''
  const itemNumber = item.item_number || item.itemNumber || item.code || ''
  return { id: id ? String(id) : '', itemNumber: itemNumber ? String(itemNumber) : '' }
}

function normalizeText(value: unknown, fallback = '-'): string {
  if (value === undefined || value === null || value === '') return fallback
  return String(value)
}

function getDocumentMetadata(doc: DocumentEntry): DocumentMetadata {
  return doc?.metadata || {}
}

function getDocumentId(doc: DocumentEntry): string {
  const metadata = getDocumentMetadata(doc)
  return String(doc?.id || doc?.file_id || metadata.file_id || metadata.id || '')
}

function getDocumentName(doc: DocumentEntry): string {
  const metadata = getDocumentMetadata(doc)
  return normalizeText(
    doc?.name ||
      metadata.filename ||
      doc?.filename ||
      metadata.file_name ||
      doc?.file_name ||
      doc?.id,
    '-',
  )
}

function getDocumentType(doc: DocumentEntry): string {
  const metadata = getDocumentMetadata(doc)
  return normalizeText(
    doc?.document_type || metadata.document_type || doc?.file_type || metadata.file_type,
    '-',
  )
}

function getDocumentRevision(doc: DocumentEntry): string {
  const metadata = getDocumentMetadata(doc)
  return normalizeText(
    doc?.engineering_revision ||
      doc?.revision ||
      metadata.document_version ||
      doc?.document_version,
    '-',
  )
}

function getDocumentRole(doc: DocumentEntry): string {
  const metadata = getDocumentMetadata(doc)
  return normalizeText(
    doc?.engineering_state || metadata.file_role || doc?.file_role || metadata.role,
    '-',
  )
}

function getDocumentMime(doc: DocumentEntry): string {
  const metadata = getDocumentMetadata(doc)
  return normalizeText(doc?.mime_type || metadata.mime_type || doc?.file_type, '-')
}

function getDocumentSize(doc: DocumentEntry): number | undefined {
  const metadata = getDocumentMetadata(doc)
  const raw = doc?.file_size ?? metadata.file_size ?? doc?.size
  if (raw === undefined || raw === null || raw === '') return undefined
  const size = Number(raw)
  return Number.isFinite(size) ? size : undefined
}

function getDocumentUpdatedAt(doc: DocumentEntry): string {
  const metadata = getDocumentMetadata(doc)
  return normalizeText(
    doc?.updated_at || doc?.created_at || metadata.updated_at || metadata.created_at,
    '',
  )
}

function getDocumentPreviewUrl(doc: DocumentEntry): string {
  const metadata = getDocumentMetadata(doc)
  return normalizeText(doc?.preview_url || metadata.preview_url, '')
}

function getDocumentDownloadUrl(doc: DocumentEntry): string {
  const metadata = getDocumentMetadata(doc)
  return normalizeText(doc?.download_url || metadata.download_url, '')
}

function getDocumentAuthor(doc: DocumentEntry): string {
  const metadata = getDocumentMetadata(doc)
  return normalizeText(doc?.author || metadata.author, '-')
}

function getDocumentSourceSystem(doc: DocumentEntry): string {
  const metadata = getDocumentMetadata(doc)
  return normalizeText(doc?.source_system || metadata.source_system, '-')
}

function getDocumentSourceVersion(doc: DocumentEntry): string {
  const metadata = getDocumentMetadata(doc)
  return normalizeText(doc?.source_version || metadata.source_version, '-')
}

function getDocumentCreatedAt(doc: DocumentEntry): string {
  const metadata = getDocumentMetadata(doc)
  return normalizeText(doc?.created_at || metadata.created_at, '')
}

async function copyDocumentId(doc: DocumentEntry) {
  const value = getDocumentId(doc)
  if (!value) {
    setDeepLinkMessage('文档缺少 ID。', true)
    return
  }
  const ok = await copyToClipboard(value)
  if (!ok) {
    setDeepLinkMessage('复制文档 ID 失败。', true)
    return
  }
  setDeepLinkMessage(`已复制文档 ID：${value}`)
}

async function copyDocumentUrl(doc: DocumentEntry, kind: 'preview' | 'download') {
  const url = kind === 'preview' ? getDocumentPreviewUrl(doc) : getDocumentDownloadUrl(doc)
  if (!url) {
    setDeepLinkMessage(`文档缺少${kind === 'preview' ? '预览' : '下载'}链接。`, true)
    return
  }
  const ok = await copyToClipboard(url)
  if (!ok) {
    setDeepLinkMessage('复制链接失败。', true)
    return
  }
  setDeepLinkMessage(`已复制${kind === 'preview' ? '预览' : '下载'}链接。`)
}

function isAmlRelatedDocument(doc: DocumentEntry): boolean {
  const documentType = String(doc.document_type || doc.metadata?.document_type || '').toLowerCase()
  return !getDocumentDownloadUrl(doc) && (documentType === 'document' || documentType === 'related_document')
}

function resolveDocumentItemId(doc: DocumentEntry): string {
  return String(doc.id || doc.config_id || doc.metadata?.config_id || '')
}

function applyProductFromDocument(doc: DocumentEntry) {
  const documentId = resolveDocumentItemId(doc)
  if (!documentId) {
    setDeepLinkMessage('文档缺少对象 ID', true)
    return
  }
  documentSourceProductId.value = productId.value
  documentSourceItemType.value = itemType.value
  productId.value = documentId
  productItemNumber.value = ''
  itemType.value = 'Document'
  productError.value = ''
  setDeepLinkMessage(`已切换到关联文档：${getDocumentName(doc) || documentId}`)
  void loadProduct()
}

function returnToDocumentSource() {
  if (!documentSourceProductId.value) return
  productId.value = documentSourceProductId.value
  productItemNumber.value = ''
  itemType.value = documentSourceItemType.value || DEFAULT_ITEM_TYPE
  productError.value = ''
  setDeepLinkMessage(`已返回源产品：${documentSourceProductId.value}`)
  documentSourceProductId.value = ''
  documentSourceItemType.value = ''
  void loadProduct()
}

function getApprovalTitle(entry: ApprovalEntry): string {
  return normalizeText(entry?.title || entry?.name || entry?.id, '-')
}

function getApprovalId(entry: ApprovalEntry): string {
  return normalizeText(entry?.id || entry?.request_id, '-')
}

function getApprovalStatus(entry: ApprovalEntry): string {
  return normalizeText(entry?.status || entry?.state, '-')
}

function getApprovalType(entry: ApprovalEntry): string {
  return normalizeText(entry?.request_type || entry?.type || entry?.eco_type, '-')
}

function getApprovalRequester(entry: ApprovalEntry): string {
  return normalizeText(
    entry?.requester_name ||
      entry?.created_by_name ||
      entry?.requester_id ||
      entry?.created_by_id,
    '-',
  )
}

function getApprovalRequesterId(entry: ApprovalEntry): string {
  return normalizeText(entry?.requester_id || entry?.created_by_id, '-')
}

function getApprovalCreatedAt(entry: ApprovalEntry): string {
  return normalizeText(entry?.created_at || entry?.createdAt || entry?.updated_at, '')
}

function getApprovalProductNumber(entry: ApprovalEntry): string {
  return normalizeText(
    entry?.product_number ||
      entry?.productNumber ||
      entry?.product_code ||
      entry?.product_id,
    '-',
  )
}

function getApprovalProductId(entry: ApprovalEntry): string {
  return normalizeText(entry?.product_id || entry?.productId || entry?.product?.id, '-')
}

function getApprovalProductName(entry: ApprovalEntry): string {
  return normalizeText(entry?.product_name || entry?.productName, '-')
}

function resolveApprovalProductKey(entry: ApprovalEntry): { id: string; itemNumber: string } {
  const id = entry?.product_id || entry?.productId || entry?.product?.id || ''
  const itemNumber =
    entry?.product_number ||
    entry?.productNumber ||
    entry?.product_code ||
    entry?.product?.item_number ||
    ''
  return { id: id ? String(id) : '', itemNumber: itemNumber ? String(itemNumber) : '' }
}

async function applyProductFromApproval(entry: ApprovalEntry) {
  const { id, itemNumber } = resolveApprovalProductKey(entry)
  if (!id && !itemNumber) {
    setDeepLinkMessage('审批记录缺少产品标识。', true)
    return
  }
  productId.value = id || ''
  productItemNumber.value = id ? '' : itemNumber
  productError.value = ''
  setDeepLinkMessage(`已切换到产品：${id || itemNumber}`)
  await loadProduct()
}

async function copyApprovalId(entry: ApprovalEntry) {
  const value = entry?.id ? String(entry.id) : ''
  if (!value) {
    setDeepLinkMessage('审批记录缺少 ID。', true)
    return
  }
  const ok = await copyToClipboard(value)
  if (!ok) {
    setDeepLinkMessage('复制审批 ID 失败。', true)
    return
  }
  setDeepLinkMessage(`已复制审批 ID：${value}`)
}

async function loadApprovalHistory(entry?: ApprovalEntry) {
  const approvalId = entry ? getApprovalId(entry) : approvalHistoryFor.value
  if (!approvalId || approvalId === '-') {
    approvalHistoryError.value = '缺少审批 ID'
    return
  }
  approvalHistoryFor.value = approvalId
  approvalHistoryLabel.value = entry
    ? `${getApprovalTitle(entry)} (${approvalId})`
    : approvalHistoryLabel.value || approvalId
  approvalHistoryLoading.value = true
  approvalHistoryError.value = ''
  try {
    const result = await plmService.getApprovalHistory<ApprovalHistoryEntry>(approvalId)
    approvalHistory.value = result.items || []
  } catch (error: any) {
    handleAuthError(error)
    approvalHistoryError.value = error?.message || '加载审批记录失败'
  } finally {
    approvalHistoryLoading.value = false
  }
}

function clearApprovalHistory() {
  approvalHistoryFor.value = ''
  approvalHistoryLabel.value = ''
  approvalHistory.value = []
  approvalHistoryError.value = ''
  approvalHistoryLoading.value = false
}

function getApprovalActionStorage() {
  return typeof localStorage !== 'undefined' ? localStorage : null
}

function getApprovalActorIds(): string[] {
  return resolvePlmApprovalActorIds(getApprovalActionStorage())
}

function getApprovalActorKey(actorIds: readonly string[]): string {
  return actorIds.join('|')
}

function trimApprovalActionabilityCache(entries: ApprovalEntry[], actorKey: string) {
  const pendingIds = new Set(
    entries
      .filter((entry) => isApprovalPending(entry))
      .map((entry) => getApprovalId(entry))
      .filter((approvalId) => approvalId && approvalId !== '-'),
  )

  const nextActionability: Record<string, boolean> = {}
  const nextLoading: Record<string, boolean> = {}

  if (approvalActionabilityActorKey.value === actorKey) {
    Object.entries(approvalActionabilityById.value).forEach(([approvalId, actionable]) => {
      if (pendingIds.has(approvalId)) {
        nextActionability[approvalId] = actionable
      }
    })
    Object.entries(approvalActionabilityLoadingById.value).forEach(([approvalId, loading]) => {
      if (pendingIds.has(approvalId) && loading) {
        nextLoading[approvalId] = true
      }
    })
  }

  approvalActionabilityById.value = nextActionability
  approvalActionabilityLoadingById.value = nextLoading
  approvalActionabilityActorKey.value = actorKey
}

async function resolveApprovalActionability(entry: ApprovalEntry, actorIds: readonly string[]): Promise<boolean> {
  const approvalId = getApprovalId(entry)
  if (!approvalId || approvalId === '-') {
    return false
  }

  const actorKey = getApprovalActorKey(actorIds)
  const directApproverId = getPlmApprovalApproverId(entry)
  if (directApproverId) {
    const actionable = canActOnPlmApproval(entry, actorIds)
    approvalActionabilityById.value = {
      ...approvalActionabilityById.value,
      [approvalId]: actionable,
    }
    return actionable
  }

  approvalActionabilityLoadingById.value = {
    ...approvalActionabilityLoadingById.value,
    [approvalId]: true,
  }

  try {
    const result = await plmService.getApprovalHistory<ApprovalHistoryEntry>(approvalId)
    const actionable = canActOnPlmApproval(entry, actorIds, result.items || [])
    if (approvalActionabilityActorKey.value === actorKey) {
      approvalActionabilityById.value = {
        ...approvalActionabilityById.value,
        [approvalId]: actionable,
      }
    }
    return actionable
  } catch (error: any) {
    handleAuthError(error)
    if (approvalActionabilityActorKey.value === actorKey) {
      approvalActionabilityById.value = {
        ...approvalActionabilityById.value,
        [approvalId]: false,
      }
    }
    return false
  } finally {
    if (approvalActionabilityActorKey.value === actorKey) {
      const nextLoading = { ...approvalActionabilityLoadingById.value }
      delete nextLoading[approvalId]
      approvalActionabilityLoadingById.value = nextLoading
    }
  }
}

async function warmApprovalActionability(entries: ApprovalEntry[]) {
  const actorIds = getApprovalActorIds()
  const actorKey = getApprovalActorKey(actorIds)
  trimApprovalActionabilityCache(entries, actorKey)

  if (!actorIds.length) {
    return
  }

  await Promise.all(
    entries.map(async (entry) => {
      if (!isApprovalPending(entry)) {
        return
      }
      const approvalId = getApprovalId(entry)
      if (!approvalId || approvalId === '-') {
        return
      }
      if (approvalActionabilityLoadingById.value[approvalId]) {
        return
      }
      if (getPlmApprovalApproverId(entry) || approvalId in approvalActionabilityById.value) {
        await resolveApprovalActionability(entry, actorIds)
        return
      }
      await resolveApprovalActionability(entry, actorIds)
    }),
  )
}

function isApprovalPending(entry: ApprovalEntry): boolean {
  return getApprovalStatus(entry).toLowerCase() === 'pending'
}

function canActOnApproval(entry: ApprovalEntry): boolean {
  if (!isApprovalPending(entry)) {
    return false
  }

  const actorIds = getApprovalActorIds()
  if (!actorIds.length) {
    return false
  }

  const approvalId = getApprovalId(entry)
  if (!approvalId || approvalId === '-') {
    return false
  }

  if (getPlmApprovalApproverId(entry)) {
    return canActOnPlmApproval(entry, actorIds)
  }

  return approvalActionabilityActorKey.value === getApprovalActorKey(actorIds)
    && approvalActionabilityById.value[approvalId] === true
}

async function approveApproval(entry: ApprovalEntry) {
  const approvalId = getApprovalId(entry)
  if (!approvalId || approvalId === '-') {
    approvalActionError.value = '审批记录缺少 ID'
    return
  }
  approvalActionStatus.value = ''
  approvalActionError.value = ''
  if (!isApprovalPending(entry)) {
    approvalActionError.value = '当前审批已不是待处理状态'
    return
  }
  const actorIds = getApprovalActorIds()
  const actionable = await resolveApprovalActionability(entry, actorIds)
  if (!actionable) {
    approvalActionError.value = '当前登录用户不是该审批的审批人'
    return
  }
  approvalActingId.value = approvalId
  try {
    const comment = approvalComment.value.trim()
    const version = resolveApprovalActionVersion(entry)
    if (version === null) {
      approvalActionError.value = '审批版本不可用'
      return
    }
    await plmService.approveApproval({
      approvalId,
      version,
      comment: comment || undefined,
    })
    approvalActionStatus.value = `已通过审批 ${approvalId}`
    approvalComment.value = ''
    await loadApprovals()
    if (approvalHistoryFor.value === approvalId) {
      await loadApprovalHistory()
    }
  } catch (error: any) {
    handleAuthError(error)
    const failure = resolveApprovalInboxThrownErrorRecord(error, '审批通过失败')
    if (failure.code === 'APPROVAL_VERSION_CONFLICT') {
      approvals.value = reconcileApprovalInboxConflictVersion(approvals.value, approvalId, failure.currentVersion)
      await loadApprovals()
      if (approvalHistoryFor.value === approvalId) {
        await loadApprovalHistory()
      }
      if (!approvalActionError.value) {
        approvalActionError.value = failure.message
      }
      return
    }
    approvalActionError.value = failure.message
  } finally {
    approvalActingId.value = ''
  }
}

async function rejectApproval(entry: ApprovalEntry) {
  const approvalId = getApprovalId(entry)
  if (!approvalId || approvalId === '-') {
    approvalActionError.value = '审批记录缺少 ID'
    return
  }
  approvalActionStatus.value = ''
  approvalActionError.value = ''
  if (!isApprovalPending(entry)) {
    approvalActionError.value = '当前审批已不是待处理状态'
    return
  }
  const actorIds = getApprovalActorIds()
  const actionable = await resolveApprovalActionability(entry, actorIds)
  if (!actionable) {
    approvalActionError.value = '当前登录用户不是该审批的审批人'
    return
  }
  const comment = approvalComment.value.trim()
  if (!comment) {
    approvalActionError.value = '拒绝需要填写原因'
    return
  }
  if (!window.confirm(`确认拒绝审批 ${approvalId}？`)) {
    return
  }
  approvalActingId.value = approvalId
  try {
    const version = resolveApprovalActionVersion(entry)
    if (version === null) {
      approvalActionError.value = '审批版本不可用'
      return
    }
    await plmService.rejectApproval({
      approvalId,
      version,
      reason: comment,
      comment,
    })
    approvalActionStatus.value = `已拒绝审批 ${approvalId}`
    approvalComment.value = ''
    await loadApprovals()
    if (approvalHistoryFor.value === approvalId) {
      await loadApprovalHistory()
    }
  } catch (error: any) {
    handleAuthError(error)
    const failure = resolveApprovalInboxThrownErrorRecord(error, '审批拒绝失败')
    if (failure.code === 'APPROVAL_VERSION_CONFLICT') {
      approvals.value = reconcileApprovalInboxConflictVersion(approvals.value, approvalId, failure.currentVersion)
      await loadApprovals()
      if (approvalHistoryFor.value === approvalId) {
        await loadApprovalHistory()
      }
      if (!approvalActionError.value) {
        approvalActionError.value = failure.message
      }
      return
    }
    approvalActionError.value = failure.message
  } finally {
    approvalActingId.value = ''
  }
}

function getApprovalHistoryStatus(entry: ApprovalHistoryEntry): string {
  return normalizeText(entry?.status || entry?.state, '-')
}

function getApprovalHistoryStage(entry: ApprovalHistoryEntry): string {
  return normalizeText(entry?.stage_id || entry?.stageId, '-')
}

function getApprovalHistoryType(entry: ApprovalHistoryEntry): string {
  return normalizeText(entry?.approval_type || entry?.approvalType, '-')
}

function getApprovalHistoryRole(entry: ApprovalHistoryEntry): string {
  return normalizeText(entry?.required_role || entry?.requiredRole, '-')
}

function getApprovalHistoryUser(entry: ApprovalHistoryEntry): string {
  return resolvePlmApprovalHistoryActorLabel(entry)
}

function getApprovalHistoryVersion(entry: ApprovalHistoryEntry): string {
  return resolvePlmApprovalHistoryVersionLabel(entry)
}

function getApprovalHistoryComment(entry: ApprovalHistoryEntry): string {
  return normalizeText(entry?.comment, '-')
}

function getApprovalHistoryApprovedAt(entry: ApprovalHistoryEntry): string {
  return normalizeText(entry?.approved_at || entry?.approvedAt, '')
}

function getApprovalHistoryCreatedAt(entry: ApprovalHistoryEntry): string {
  return normalizeText(entry?.created_at || entry?.createdAt, '')
}

function getSubstitutePart(entry: SubstituteEntry): SubstitutePartRecord {
  return entry?.substitute_part || entry?.substitutePart || {}
}

function getSubstituteSourcePart(entry: SubstituteEntry): SubstitutePartRecord {
  return entry?.part || entry?.source_part || entry?.original_part || {}
}

function getSubstituteNumber(entry: SubstituteEntry): string {
  const part = getSubstitutePart(entry)
  return String(part.item_number || part.itemNumber || part.code || part.id || entry.id || '-')
}

function getSubstituteId(entry: SubstituteEntry): string {
  const part = getSubstitutePart(entry)
  return String(part.id || entry.id || '-')
}

function getSubstituteName(entry: SubstituteEntry): string {
  const part = getSubstitutePart(entry)
  return String(part.name || part.label || part.title || '-')
}

function getSubstituteStatus(entry: SubstituteEntry): string {
  const part = getSubstitutePart(entry)
  return String(part.state || part.status || part.lifecycle_state || '-')
}

function resolveSubstituteTarget(entry: SubstituteEntry, target: 'substitute' | 'part'): SubstitutePartRecord {
  return target === 'substitute' ? getSubstitutePart(entry) : getSubstituteSourcePart(entry)
}

function resolveSubstituteTargetKey(entry: SubstituteEntry, target: 'substitute' | 'part'): string {
  const { id, itemNumber } = resolveItemKey(resolveSubstituteTarget(entry, target))
  return id || itemNumber || ''
}

function formatSubstituteRank(entry: SubstituteEntry): string {
  const value = entry?.rank ?? entry?.relationship?.properties?.rank
  if (value === undefined || value === null || value === '') return '-'
  return String(value)
}

function formatSubstituteNote(entry: SubstituteEntry): string {
  const value = entry?.relationship?.properties?.note || entry?.relationship?.properties?.comment
  if (value === undefined || value === null || value === '') return '-'
  return String(value)
}

function getCompareParent(entry?: CompareEntry | null): UnknownRecord | null {
  if (!entry) return null
  if (entry.parent) return entry.parent
  const path = entry.path
  if (Array.isArray(path) && path.length) {
    return path[0] || null
  }
  return null
}

function resolveCompareParentKey(entry?: CompareEntry | null): string {
  const parent = getCompareParent(entry)
  const { id, itemNumber } = resolveItemKey(parent)
  return id || itemNumber || ''
}

function resolveCompareChildKey(entry?: CompareEntry | null): string {
  const child = getCompareChild(entry)
  const { id, itemNumber } = resolveItemKey(child)
  return id || itemNumber || ''
}

function getCompareChild(entry?: CompareEntry | null): UnknownRecord | null {
  if (!entry) return null
  if (entry.child) return entry.child
  const path = entry.path
  if (Array.isArray(path) && path.length > 1) {
    return path[path.length - 1] || null
  }
  return null
}

function resolveCompareLineProps(entry?: CompareEntry | null): CompareLineProps {
  if (!entry) return {}
  return (
    entry.line ||
    entry.properties ||
    entry.relationship?.properties ||
    (entry.relationship as CompareLineProps | undefined) ||
    {}
  )
}

function resolveSnakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, ch) => String(ch).toUpperCase())
}

function getCompareProp(entry: CompareEntry, key: string): string {
  const props = resolveCompareLineProps(entry)
  const value =
    props[key] ??
    props[resolveSnakeToCamel(key)]
  if (value === undefined || value === null || value === '') return '-'
  return String(value)
}

function resolveCompareEntryKey(entry?: CompareEntry | null): string {
  if (!entry) return ''
  return entry.relationship_id || entry.line_key || entry.child_id || ''
}

function resolveCompareLineValue(source: UnknownRecord | null, key: string): unknown {
  if (!source) return undefined
  return source[key] ?? source[resolveSnakeToCamel(key)]
}

function resolveCompareEntryLine(
  entry: CompareEntry,
  kind: CompareSelectionKind,
  side: 'left' | 'right'
): UnknownRecord | null {
  if (kind === 'added') {
    return side === 'right' ? resolveCompareLineProps(entry) : null
  }
  if (kind === 'removed') {
    return side === 'left' ? resolveCompareLineProps(entry) : null
  }
  if (side === 'left') {
    return entry.before_line || entry.before || resolveCompareLineProps(entry)
  }
  return entry.after_line || entry.after || resolveCompareLineProps(entry)
}

function resolveCompareEntryNormalized(
  entry: CompareEntry,
  kind: CompareSelectionKind,
  side: 'left' | 'right'
): UnknownRecord | null {
  if (kind === 'added') {
    return side === 'right' ? entry.line_normalized || null : null
  }
  if (kind === 'removed') {
    return side === 'left' ? entry.line_normalized || null : null
  }
  if (side === 'left') {
    return entry.before_normalized || null
  }
  return entry.after_normalized || null
}

function truncateCompareValue(value: string, limit = 160): string {
  if (value.length <= limit) return value
  return `${value.slice(0, limit - 3)}...`
}

function formatCompareFieldValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '-'
  if (Array.isArray(value)) {
    if (!value.length) return '-'
    const parts = value.map((entry) => {
      if (entry === null || entry === undefined) return ''
      if (typeof entry === 'object') return JSON.stringify(entry)
      return String(entry)
    }).filter(Boolean)
    return truncateCompareValue(parts.join(', ') || '-')
  }
  if (typeof value === 'object') {
    return truncateCompareValue(JSON.stringify(value))
  }
  return truncateCompareValue(String(value))
}

function resolveCompareFieldValue(
  entry: CompareEntry,
  kind: CompareSelectionKind,
  side: 'left' | 'right',
  key: string
): string {
  const line = resolveCompareEntryLine(entry, kind, side)
  const value = resolveCompareLineValue(line, key)
  return formatCompareFieldValue(value)
}

function resolveCompareNormalizedValue(
  entry: CompareEntry,
  kind: CompareSelectionKind,
  side: 'left' | 'right',
  key: string,
  change?: UnknownRecord
): string {
  let normalizedValue: unknown = undefined
  if (change) {
    normalizedValue = side === 'left' ? change.normalized_left : change.normalized_right
  }
  if (normalizedValue === undefined) {
    const normalized = resolveCompareEntryNormalized(entry, kind, side)
    normalizedValue = resolveCompareLineValue(normalized, key)
  }
  const formatted = formatCompareFieldValue(normalizedValue)
  if (formatted === '-') return ''
  const raw = resolveCompareFieldValue(entry, kind, side, key)
  if (formatted === raw) return ''
  return formatted
}

function selectCompareEntry(entry: CompareEntry, kind: CompareSelectionKind): void {
  const key = resolveCompareEntryKey(entry)
  if (!key) return
  const current = compareSelected.value
  if (current && current.key === key && current.kind === kind) {
    compareSelected.value = null
  } else {
    compareSelected.value = { key, kind, entry }
    syncCompareTargets(entry)
  }
}

function clearCompareSelection(): void {
  compareSelected.value = null
}

function isCompareEntrySelected(entry: CompareEntry, kind: CompareSelectionKind): boolean {
  const key = resolveCompareEntryKey(entry)
  if (!key) return false
  return Boolean(compareSelected.value && compareSelected.value.key === key && compareSelected.value.kind === kind)
}

function syncCompareTargets(entry: CompareEntry): void {
  if (!compareSyncEnabled.value) return
  const child = getCompareChild(entry)
  const { id, itemNumber } = resolveItemKey(child)
  const target = id || itemNumber
  const lineId = resolveCompareLineId(entry)
  const messages: string[] = []

  if (target) {
    whereUsedItemId.value = target
    whereUsedError.value = ''
    scheduleQuerySync({ whereUsedItemId: target })
    messages.push(`Where-Used 子件：${target}`)
  }

  if (lineId) {
    bomLineId.value = lineId
    substitutesError.value = ''
    substitutesActionStatus.value = ''
    substitutesActionError.value = ''
    scheduleQuerySync({ bomLineId: lineId })
    messages.push(`替代件 BOM 行：${lineId}`)
  }

  if (!messages.length) {
    setDeepLinkMessage('对比行缺少子件/行 ID', true)
    return
  }

  setDeepLinkMessage(`已联动 ${messages.join('；')}`)
}

function getWhereUsedRefdes(entry: WhereUsedEntry): string {
  const line = entry?.line || entry?.relationship?.properties || entry?.relationship || {}
  const value = line.refdes ?? line.ref_des
  if (value === undefined || value === null || value === '') return '-'
  return String(value)
}

function getWhereUsedLineValue(entry: WhereUsedEntry, key: string): string {
  const line = entry?.line || entry?.relationship?.properties || entry?.relationship || {}
  const value = line[key]
  if (value === undefined || value === null || value === '') return '-'
  return String(value)
}

function getWhereUsedTreeEntry(row: WhereUsedTreeRowModel): WhereUsedEntry | null {
  return row.entries.length ? row.entries[0] : null
}

function getWhereUsedTreeLineValue(row: WhereUsedTreeRowModel, key: string): string {
  const entry = getWhereUsedTreeEntry(row)
  if (!entry) return '-'
  return getWhereUsedLineValue(entry, key)
}

function getWhereUsedTreeRefdes(row: WhereUsedTreeRowModel): string {
  const entry = getWhereUsedTreeEntry(row)
  if (!entry) return '-'
  return getWhereUsedRefdes(entry)
}

function getWhereUsedTreeRelationship(row: WhereUsedTreeRowModel): string {
  const entry = getWhereUsedTreeEntry(row)
  return entry?.relationship?.id || '-'
}

function formatWhereUsedEntryPathIds(entry: WhereUsedEntry): string {
  const nodes = Array.isArray(entry?.pathNodes) ? entry.pathNodes : []
  if (!nodes.length) return ''
  return nodes
    .map((node) => node?.id || node?.label)
    .filter((token) => String(token || '').length > 0)
    .join(' / ')
}

function formatWhereUsedPathIds(row: WhereUsedTreeRowModel): string {
  if (!row?.pathIds?.length) return ''
  return row.pathIds.filter((token) => String(token || '').length > 0).join(' / ')
}

function normalizeEffectiveAt(value: string): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toISOString()
}

function serializeBomCollapsed(value: Set<string>): string {
  return Array.from(value).join('|')
}

function parseBomCollapsed(raw: string): Set<string> {
  if (!raw) return new Set()
  return new Set(raw.split('|').map((entry) => entry.trim()).filter(Boolean))
}

function resolveBomCollapseStorageKey(): string | null {
  const base = productId.value || productView.value.id || productItemNumber.value
  if (!base) return null
  return `${BOM_COLLAPSE_STORAGE_KEY}:${base}`
}

function loadStoredBomCollapsed(): Set<string> | null {
  if (typeof localStorage === 'undefined') return null
  const key = resolveBomCollapseStorageKey()
  if (!key) return null
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return new Set(parsed.map((entry) => String(entry)).filter(Boolean))
  } catch (_err) {
    return null
  }
}

function persistBomCollapsed(value: Set<string>): void {
  if (typeof localStorage === 'undefined') return
  const key = resolveBomCollapseStorageKey()
  if (!key) return
  try {
    if (!value.size) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, JSON.stringify(Array.from(value)))
    }
  } catch (_err) {
    // ignore storage errors
  }
}

function filterBomCollapsed(value: Set<string>): Set<string> {
  const rows = bomTreeRows.value
  if (!rows.length) return value
  const allowed = new Set(rows.map((row) => row.key))
  return new Set(Array.from(value).filter((key) => allowed.has(key)))
}

function resolveBomCollapsedState(): Set<string> {
  const param = readQueryParam('bomCollapsed')
  if (param !== undefined) {
    return filterBomCollapsed(parseBomCollapsed(param))
  }
  const stored = loadStoredBomCollapsed()
  return stored ? filterBomCollapsed(stored) : new Set()
}

function syncBomCollapsedQuery(value: Set<string>): void {
  if (bomView.value !== 'tree') {
    scheduleQuerySync({ bomCollapsed: undefined })
    return
  }
  const serialized = serializeBomCollapsed(value)
  scheduleQuerySync({ bomCollapsed: serialized || undefined })
}

function applyBomCollapsedState(value: Set<string>): void {
  bomCollapsed.value = filterBomCollapsed(value)
}

function readQueryParam(key: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(route.query, key)) {
    return undefined
  }
  const raw = route.query[key]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (value === undefined || value === null) return ''
  return String(value)
}

function parseQueryBoolean(value?: string): boolean | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return undefined
}

function parseQueryNumber(value?: string): number | undefined {
  if (value === undefined || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return undefined
  return parsed
}

function hasExplicitWorkbenchQueryState() {
  return hasExplicitPlmWorkbenchAutoApplyQueryState(
    applyPlmDeferredRouteQueryPatch(
      route.query as Record<string, unknown>,
      deferredRouteQueryPatch,
    ),
  )
}

function serializeColumnQuery(
  columns: Record<string, boolean>,
  defaults: Record<string, boolean>,
): string | undefined {
  const enabled = Object.keys(defaults).filter((key) => Boolean(columns[key]))
  const defaultEnabled = Object.keys(defaults).filter((key) => Boolean(defaults[key]))
  if (enabled.length === defaultEnabled.length && enabled.every((key, index) => key === defaultEnabled[index])) {
    return undefined
  }
  return enabled.join(',')
}

function parseColumnQuery(
  value: string | undefined,
  defaults: Record<string, boolean>,
): Record<string, boolean> | undefined {
  if (value === undefined) return undefined
  const tokens = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (!tokens.length) {
    return { ...defaults }
  }

  const next = Object.keys(defaults).reduce<Record<string, boolean>>((acc, key) => {
    acc[key] = false
    return acc
  }, {})

  let hasKnownKey = false
  for (const token of tokens) {
    if (!(token in defaults)) continue
    next[token] = true
    hasKnownKey = true
  }

  return hasKnownKey ? next : { ...defaults }
}

function syncQueryParams(patch: Record<string, string | number | boolean | undefined>) {
  const nextQuery: Record<string, LocationQueryValue | LocationQueryValue[] | undefined> = { ...route.query }
  let changed = false
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null || value === '') {
      if (key in nextQuery) {
        delete nextQuery[key]
        changed = true
      }
      continue
    }
    const nextValue = String(value)
    const currentValue = nextQuery[key]
    const currentResolved = Array.isArray(currentValue) ? currentValue[0] : currentValue
    if (currentResolved !== nextValue) {
      nextQuery[key] = nextValue
      changed = true
    }
  }
  if (!changed) return
  router.replace({ query: nextQuery }).catch(() => null)
}

function applyPresetParams(preset?: DeepLinkPreset | null): void {
  if (!preset?.params) return
  const bomViewParam = preset.params.bomView
  if (typeof bomViewParam === 'string') {
    const normalized = bomViewParam.trim().toLowerCase()
    if (normalized === 'tree' || normalized === 'table') {
      bomView.value = normalized as typeof bomView.value
    }
  }
}

function saveBomFilterPreset() {
  if (!canSaveBomFilterPreset.value) {
    setDeepLinkMessage('请输入过滤条件和预设名称。', true)
    return
  }
  const { presets, key } = upsertFilterPreset(
    bomFilterPresets.value,
    bomFilterPresetName.value,
    bomFilterField.value,
    bomFilter.value,
    bomFilterPresetGroup.value,
    'bom'
  )
  bomFilterPresets.value = presets
  persistFilterPresets(BOM_FILTER_PRESETS_STORAGE_KEY, presets)
  const saved = presets.find((preset) => preset.key === key) || null
  if (saved) {
    applyBomLocalFilterPresetIdentity(saved)
  }
  bomFilterPresetName.value = ''
  bomFilterPresetGroup.value = ''
  setDeepLinkMessage('已保存 BOM 过滤预设。')
}

function applyBomFilterPreset() {
  const preset = applyFilterPreset(bomFilterPresets.value, bomFilterPresetKey.value)
  if (!preset) {
    setDeepLinkMessage('请选择 BOM 过滤预设。', true)
    return
  }
  applyBomLocalFilterPresetIdentity(preset)
  setDeepLinkMessage(`已应用 BOM 过滤预设：${preset.label}`)
}

function duplicateBomFilterPreset() {
  if (!bomFilterPresetKey.value) {
    setDeepLinkMessage('请选择 BOM 过滤预设后复制。', true)
    return
  }
  const { presets, preset } = duplicateFilterPreset(bomFilterPresets.value, bomFilterPresetKey.value, 'bom')
  if (!preset) {
    setDeepLinkMessage('复制 BOM 过滤预设失败。', true)
    return
  }
  bomFilterPresets.value = presets
  persistFilterPresets(BOM_FILTER_PRESETS_STORAGE_KEY, presets)
  applyBomLocalFilterPresetIdentity(preset)
  setDeepLinkMessage(`已复制 BOM 过滤预设：${preset.label}`)
}

function renameBomFilterPreset() {
  const preset = applyFilterPreset(bomFilterPresets.value, bomFilterPresetKey.value)
  if (!preset) {
    setDeepLinkMessage('请选择 BOM 过滤预设后重命名。', true)
    return
  }
  const nextLabel = prompt('BOM 过滤预设名称：', preset.label)
  if (nextLabel === null) return
  const { presets, preset: renamed, error } = renameFilterPreset(
    bomFilterPresets.value,
    bomFilterPresetKey.value,
    nextLabel,
  )
  if (error === 'empty') {
    setDeepLinkMessage('BOM 过滤预设名称不能为空。', true)
    return
  }
  if (error === 'duplicate') {
    setDeepLinkMessage('已存在同名 BOM 过滤预设。', true)
    return
  }
  if (!renamed) {
    setDeepLinkMessage('重命名 BOM 过滤预设失败。', true)
    return
  }
  bomFilterPresets.value = presets
  persistFilterPresets(BOM_FILTER_PRESETS_STORAGE_KEY, presets)
  applyBomLocalFilterPresetIdentity(renamed)
  setDeepLinkMessage(`已重命名 BOM 过滤预设：${renamed.label}`)
}

function deleteBomFilterPreset() {
  if (!bomFilterPresetKey.value) return
  const deletedKey = bomFilterPresetKey.value
  const next = bomFilterPresets.value.filter((preset) => preset.key !== bomFilterPresetKey.value)
  bomFilterPresets.value = next
  persistFilterPresets(BOM_FILTER_PRESETS_STORAGE_KEY, next)
  const nextSelection = resolveFilterPresetCatalogDraftState({
    availablePresets: next,
    selectedPresetKey: deletedKey,
    routePresetKey: bomFilterPresetQuery.value,
    nameDraft: bomFilterPresetName.value,
    groupDraft: bomFilterPresetGroup.value,
    selectionKeys: bomPresetSelection.value,
    batchGroupDraft: bomPresetBatchGroup.value,
  })
  bomFilterPresetKey.value = nextSelection.nextSelectedPresetKey
  bomFilterPresetName.value = nextSelection.nextNameDraft
  bomFilterPresetGroup.value = nextSelection.nextGroupDraft
  bomPresetSelection.value = nextSelection.nextSelectionKeys
  bomPresetBatchGroup.value = nextSelection.nextBatchGroupDraft
  syncBomFilterPresetQuery(nextSelection.nextRoutePresetKey || undefined)
  setDeepLinkMessage('已删除 BOM 过滤预设。')
}

function assignBomPresetGroup() {
  const group = bomFilterPresetGroup.value.trim()
  if (!bomFilterPresetKey.value) return
  const next = bomFilterPresets.value.map((preset) =>
    preset.key === bomFilterPresetKey.value ? { ...preset, group } : preset
  )
  bomFilterPresets.value = next
  persistFilterPresets(BOM_FILTER_PRESETS_STORAGE_KEY, next)
  setDeepLinkMessage(group ? '已更新 BOM 过滤预设分组。' : '已清空 BOM 过滤预设分组。')
}

async function shareBomFilterPreset() {
  const preset = bomFilterPresets.value.find((entry) => entry.key === bomFilterPresetKey.value)
  if (!preset) {
    setDeepLinkMessage('请选择 BOM 过滤预设后分享。', true)
    return
  }
  const url = buildFilterPresetShareUrl(
    'bom',
    preset,
    bomFilterPresetImportMode.value,
    route.path,
    undefined,
    {
      productId: productId.value,
      itemNumber: productItemNumber.value,
      itemType: itemType.value !== DEFAULT_ITEM_TYPE ? itemType.value : '',
    },
  )
  if (!url) {
    setDeepLinkMessage('生成 BOM 过滤预设分享链接失败。', true)
    return
  }
  const ok = await copyToClipboard(url)
  setDeepLinkMessage(
    ok ? '已复制 BOM 过滤预设分享链接。' : '复制 BOM 过滤预设分享链接失败。',
    !ok
  )
}

function selectAllBomPresets() {
  bomPresetSelection.value = bomFilteredPresets.value.map((preset) => preset.key)
}

function clearBomPresetSelection() {
  bomPresetSelection.value = []
}

function applyBomPresetBatchGroup() {
  if (!bomPresetSelection.value.length) {
    setDeepLinkMessage('请选择要批量修改的 BOM 过滤预设。', true)
    return
  }
  const group = bomPresetBatchGroup.value.trim()
  const selected = new Set(bomPresetSelection.value)
  bomFilterPresets.value = bomFilterPresets.value.map((preset) =>
    selected.has(preset.key) ? { ...preset, group } : preset
  )
  persistFilterPresets(BOM_FILTER_PRESETS_STORAGE_KEY, bomFilterPresets.value)
  bomPresetBatchGroup.value = ''
  setDeepLinkMessage(group ? '已批量更新 BOM 过滤预设分组。' : '已清空选中 BOM 过滤预设分组。')
}

function deleteBomPresetSelection() {
  if (!bomPresetSelection.value.length) {
    setDeepLinkMessage('请选择要删除的 BOM 过滤预设。', true)
    return
  }
  const selected = new Set(bomPresetSelection.value)
  const next = bomFilterPresets.value.filter((preset) => !selected.has(preset.key))
  bomFilterPresets.value = next
  persistFilterPresets(BOM_FILTER_PRESETS_STORAGE_KEY, next)
  const nextSelection = resolveFilterPresetCatalogDraftState({
    availablePresets: next,
    selectedPresetKey: bomFilterPresetKey.value,
    routePresetKey: bomFilterPresetQuery.value,
    nameDraft: bomFilterPresetName.value,
    groupDraft: bomFilterPresetGroup.value,
    selectionKeys: bomPresetSelection.value,
    batchGroupDraft: bomPresetBatchGroup.value,
  })
  bomFilterPresetKey.value = nextSelection.nextSelectedPresetKey
  bomFilterPresetName.value = nextSelection.nextNameDraft
  bomFilterPresetGroup.value = nextSelection.nextGroupDraft
  bomPresetSelection.value = nextSelection.nextSelectionKeys
  bomPresetBatchGroup.value = nextSelection.nextBatchGroupDraft
  syncBomFilterPresetQuery(nextSelection.nextRoutePresetKey || undefined)
  setDeepLinkMessage(`已删除 ${selected.size} 条 BOM 过滤预设。`)
}

function saveWhereUsedFilterPreset() {
  if (!canSaveWhereUsedFilterPreset.value) {
    setDeepLinkMessage('请输入过滤条件和预设名称。', true)
    return
  }
  const { presets, key } = upsertFilterPreset(
    whereUsedFilterPresets.value,
    whereUsedFilterPresetName.value,
    whereUsedFilterField.value,
    whereUsedFilter.value,
    whereUsedFilterPresetGroup.value,
    'where-used'
  )
  whereUsedFilterPresets.value = presets
  persistFilterPresets(WHERE_USED_FILTER_PRESETS_STORAGE_KEY, presets)
  const saved = presets.find((preset) => preset.key === key) || null
  if (saved) {
    applyWhereUsedLocalFilterPresetIdentity(saved)
  }
  whereUsedFilterPresetName.value = ''
  whereUsedFilterPresetGroup.value = ''
  setDeepLinkMessage('已保存 Where-Used 过滤预设。')
}

function applyWhereUsedFilterPreset() {
  const preset = applyFilterPreset(whereUsedFilterPresets.value, whereUsedFilterPresetKey.value)
  if (!preset) {
    setDeepLinkMessage('请选择 Where-Used 过滤预设。', true)
    return
  }
  applyWhereUsedLocalFilterPresetIdentity(preset)
  setDeepLinkMessage(`已应用 Where-Used 过滤预设：${preset.label}`)
}

function duplicateWhereUsedFilterPreset() {
  if (!whereUsedFilterPresetKey.value) {
    setDeepLinkMessage('请选择 Where-Used 过滤预设后复制。', true)
    return
  }
  const { presets, preset } = duplicateFilterPreset(
    whereUsedFilterPresets.value,
    whereUsedFilterPresetKey.value,
    'where-used',
  )
  if (!preset) {
    setDeepLinkMessage('复制 Where-Used 过滤预设失败。', true)
    return
  }
  whereUsedFilterPresets.value = presets
  persistFilterPresets(WHERE_USED_FILTER_PRESETS_STORAGE_KEY, presets)
  applyWhereUsedLocalFilterPresetIdentity(preset)
  setDeepLinkMessage(`已复制 Where-Used 过滤预设：${preset.label}`)
}

function renameWhereUsedFilterPreset() {
  const preset = applyFilterPreset(whereUsedFilterPresets.value, whereUsedFilterPresetKey.value)
  if (!preset) {
    setDeepLinkMessage('请选择 Where-Used 过滤预设后重命名。', true)
    return
  }
  const nextLabel = prompt('Where-Used 过滤预设名称：', preset.label)
  if (nextLabel === null) return
  const { presets, preset: renamed, error } = renameFilterPreset(
    whereUsedFilterPresets.value,
    whereUsedFilterPresetKey.value,
    nextLabel,
  )
  if (error === 'empty') {
    setDeepLinkMessage('Where-Used 过滤预设名称不能为空。', true)
    return
  }
  if (error === 'duplicate') {
    setDeepLinkMessage('已存在同名 Where-Used 过滤预设。', true)
    return
  }
  if (!renamed) {
    setDeepLinkMessage('重命名 Where-Used 过滤预设失败。', true)
    return
  }
  whereUsedFilterPresets.value = presets
  persistFilterPresets(WHERE_USED_FILTER_PRESETS_STORAGE_KEY, presets)
  applyWhereUsedLocalFilterPresetIdentity(renamed)
  setDeepLinkMessage(`已重命名 Where-Used 过滤预设：${renamed.label}`)
}

function deleteWhereUsedFilterPreset() {
  if (!whereUsedFilterPresetKey.value) return
  const deletedKey = whereUsedFilterPresetKey.value
  const next = whereUsedFilterPresets.value.filter(
    (preset) => preset.key !== whereUsedFilterPresetKey.value
  )
  whereUsedFilterPresets.value = next
  persistFilterPresets(WHERE_USED_FILTER_PRESETS_STORAGE_KEY, next)
  const nextSelection = resolveFilterPresetCatalogDraftState({
    availablePresets: next,
    selectedPresetKey: deletedKey,
    routePresetKey: whereUsedFilterPresetQuery.value,
    nameDraft: whereUsedFilterPresetName.value,
    groupDraft: whereUsedFilterPresetGroup.value,
    selectionKeys: whereUsedPresetSelection.value,
    batchGroupDraft: whereUsedPresetBatchGroup.value,
  })
  whereUsedFilterPresetKey.value = nextSelection.nextSelectedPresetKey
  whereUsedFilterPresetName.value = nextSelection.nextNameDraft
  whereUsedFilterPresetGroup.value = nextSelection.nextGroupDraft
  whereUsedPresetSelection.value = nextSelection.nextSelectionKeys
  whereUsedPresetBatchGroup.value = nextSelection.nextBatchGroupDraft
  syncWhereUsedFilterPresetQuery(nextSelection.nextRoutePresetKey || undefined)
  setDeepLinkMessage('已删除 Where-Used 过滤预设。')
}

function assignWhereUsedPresetGroup() {
  const group = whereUsedFilterPresetGroup.value.trim()
  if (!whereUsedFilterPresetKey.value) return
  const next = whereUsedFilterPresets.value.map((preset) =>
    preset.key === whereUsedFilterPresetKey.value ? { ...preset, group } : preset
  )
  whereUsedFilterPresets.value = next
  persistFilterPresets(WHERE_USED_FILTER_PRESETS_STORAGE_KEY, next)
  setDeepLinkMessage(group ? '已更新 Where-Used 过滤预设分组。' : '已清空 Where-Used 过滤预设分组。')
}

async function shareWhereUsedFilterPreset() {
  const preset = whereUsedFilterPresets.value.find(
    (entry) => entry.key === whereUsedFilterPresetKey.value
  )
  if (!preset) {
    setDeepLinkMessage('请选择 Where-Used 过滤预设后分享。', true)
    return
  }
  const url = buildFilterPresetShareUrl(
    'where-used',
    preset,
    whereUsedFilterPresetImportMode.value,
    route.path,
    undefined,
    {
      productId: productId.value,
      itemNumber: productItemNumber.value,
      itemType: itemType.value !== DEFAULT_ITEM_TYPE ? itemType.value : '',
      whereUsedItemId: whereUsedItemId.value,
    },
  )
  if (!url) {
    setDeepLinkMessage('生成 Where-Used 过滤预设分享链接失败。', true)
    return
  }
  const ok = await copyToClipboard(url)
  setDeepLinkMessage(
    ok ? '已复制 Where-Used 过滤预设分享链接。' : '复制 Where-Used 过滤预设分享链接失败。',
    !ok
  )
}

function selectAllWhereUsedPresets() {
  whereUsedPresetSelection.value = whereUsedFilteredPresets.value.map((preset) => preset.key)
}

function clearWhereUsedPresetSelection() {
  whereUsedPresetSelection.value = []
}

function applyWhereUsedPresetBatchGroup() {
  if (!whereUsedPresetSelection.value.length) {
    setDeepLinkMessage('请选择要批量修改的 Where-Used 过滤预设。', true)
    return
  }
  const group = whereUsedPresetBatchGroup.value.trim()
  const selected = new Set(whereUsedPresetSelection.value)
  whereUsedFilterPresets.value = whereUsedFilterPresets.value.map((preset) =>
    selected.has(preset.key) ? { ...preset, group } : preset
  )
  persistFilterPresets(WHERE_USED_FILTER_PRESETS_STORAGE_KEY, whereUsedFilterPresets.value)
  whereUsedPresetBatchGroup.value = ''
  setDeepLinkMessage(group ? '已批量更新 Where-Used 过滤预设分组。' : '已清空选中 Where-Used 过滤预设分组。')
}

function deleteWhereUsedPresetSelection() {
  if (!whereUsedPresetSelection.value.length) {
    setDeepLinkMessage('请选择要删除的 Where-Used 过滤预设。', true)
    return
  }
  const selected = new Set(whereUsedPresetSelection.value)
  const next = whereUsedFilterPresets.value.filter((preset) => !selected.has(preset.key))
  whereUsedFilterPresets.value = next
  persistFilterPresets(WHERE_USED_FILTER_PRESETS_STORAGE_KEY, next)
  const nextSelection = resolveFilterPresetCatalogDraftState({
    availablePresets: next,
    selectedPresetKey: whereUsedFilterPresetKey.value,
    routePresetKey: whereUsedFilterPresetQuery.value,
    nameDraft: whereUsedFilterPresetName.value,
    groupDraft: whereUsedFilterPresetGroup.value,
    selectionKeys: whereUsedPresetSelection.value,
    batchGroupDraft: whereUsedPresetBatchGroup.value,
  })
  whereUsedFilterPresetKey.value = nextSelection.nextSelectedPresetKey
  whereUsedFilterPresetName.value = nextSelection.nextNameDraft
  whereUsedFilterPresetGroup.value = nextSelection.nextGroupDraft
  whereUsedPresetSelection.value = nextSelection.nextSelectionKeys
  whereUsedPresetBatchGroup.value = nextSelection.nextBatchGroupDraft
  syncWhereUsedFilterPresetQuery(nextSelection.nextRoutePresetKey || undefined)
  setDeepLinkMessage(`已删除 ${selected.size} 条 Where-Used 过滤预设。`)
}

function importBomFilterPresetShare(raw: string, mode: 'merge' | 'replace') {
  const entry = decodeFilterPresetSharePayload(raw, bomFilterFieldOptions)
  if (!entry) {
    setDeepLinkMessage('BOM 过滤预设分享链接解析失败。', true)
    return
  }
  const existingLabels = bomFilterPresets.value.map((preset) => preset.label)
  const existingLabelSet = new Set(existingLabels)
  const conflictLabels = existingLabelSet.has(entry.label) ? [entry.label] : []
  const confirmed = confirmFilterPresetImport('BOM', mode, existingLabels, conflictLabels)
  if (!confirmed) {
    setDeepLinkMessage('已取消导入 BOM 过滤预设。', true)
    return
  }
  const { presets, added, updated } = mergeImportedFilterPresets(
    [entry],
    bomFilterPresets.value,
    'bom',
    mode
  )
  bomFilterPresets.value = presets
  persistFilterPresets(BOM_FILTER_PRESETS_STORAGE_KEY, presets)
  const imported = presets.find((preset) => preset.label === entry.label)
  bomFilterPresetKey.value = imported?.key || ''
  if (bomFilterPresetQuery.value && !presets.some((preset) => preset.key === bomFilterPresetQuery.value)) {
    syncBomFilterPresetQuery(undefined)
  }
  reconcileBomLocalFilterPresetIdentityAfterImport()
  const importedCount = added + updated
  if (importedCount) {
    setDeepLinkMessage(
      `已导入 BOM 过滤预设：${entry.label}（新增 ${added}，更新 ${updated}）。`
    )
  } else {
    setDeepLinkMessage('未导入 BOM 过滤预设。', true)
  }
}

function importWhereUsedFilterPresetShare(raw: string, mode: 'merge' | 'replace') {
  const entry = decodeFilterPresetSharePayload(raw, whereUsedFilterFieldOptions)
  if (!entry) {
    setDeepLinkMessage('Where-Used 过滤预设分享链接解析失败。', true)
    return
  }
  const existingLabels = whereUsedFilterPresets.value.map((preset) => preset.label)
  const existingLabelSet = new Set(existingLabels)
  const conflictLabels = existingLabelSet.has(entry.label) ? [entry.label] : []
  const confirmed = confirmFilterPresetImport('Where-Used', mode, existingLabels, conflictLabels)
  if (!confirmed) {
    setDeepLinkMessage('已取消导入 Where-Used 过滤预设。', true)
    return
  }
  const { presets, added, updated } = mergeImportedFilterPresets(
    [entry],
    whereUsedFilterPresets.value,
    'where-used',
    mode
  )
  whereUsedFilterPresets.value = presets
  persistFilterPresets(WHERE_USED_FILTER_PRESETS_STORAGE_KEY, presets)
  const imported = presets.find((preset) => preset.label === entry.label)
  whereUsedFilterPresetKey.value = imported?.key || ''
  if (
    whereUsedFilterPresetQuery.value
    && !presets.some((preset) => preset.key === whereUsedFilterPresetQuery.value)
  ) {
    syncWhereUsedFilterPresetQuery(undefined)
  }
  reconcileWhereUsedLocalFilterPresetIdentityAfterImport()
  const importedCount = added + updated
  if (importedCount) {
    setDeepLinkMessage(
      `已导入 Where-Used 过滤预设：${entry.label}（新增 ${added}，更新 ${updated}）。`
    )
  } else {
    setDeepLinkMessage('未导入 Where-Used 过滤预设。', true)
  }
}

function importBomFilterPresetsFromText(raw: string) {
  const trimmed = raw.trim()
  if (!trimmed) {
    setDeepLinkMessage('请粘贴 BOM 过滤预设 JSON。', true)
    return
  }
  try {
    const { entries, skippedInvalid, skippedMissing, duplicateCount } = parseFilterPresetImport(
      trimmed,
      bomFilterFieldOptions
    )
    const skippedParts: string[] = []
    if (duplicateCount) skippedParts.push(`重复 ${duplicateCount} 条`)
    if (skippedInvalid) skippedParts.push(`格式错误 ${skippedInvalid} 条`)
    if (skippedMissing) skippedParts.push(`缺少字段 ${skippedMissing} 条`)
    const skippedText = skippedParts.length ? `，忽略 ${skippedParts.join('，')}` : ''
    if (!entries.length) {
      if (skippedParts.length) {
        setDeepLinkMessage(`未导入有效 BOM 过滤预设${skippedText}。`, true)
      } else {
        setDeepLinkMessage('未发现可导入的 BOM 过滤预设。', true)
      }
      return
    }
    const existingLabels = bomFilterPresets.value.map((preset) => preset.label)
    const existingLabelSet = new Set(existingLabels)
    const conflictLabels = entries
      .filter((entry) => existingLabelSet.has(entry.label))
      .map((entry) => entry.label)
    const confirmed = confirmFilterPresetImport(
      'BOM',
      bomFilterPresetImportMode.value,
      existingLabels,
      conflictLabels
    )
    if (!confirmed) {
      setDeepLinkMessage('已取消导入 BOM 过滤预设。', true)
      return
    }
    const { presets, added, updated } = mergeImportedFilterPresets(
      entries,
      bomFilterPresets.value,
      'bom',
      bomFilterPresetImportMode.value
    )
    bomFilterPresets.value = presets
    persistFilterPresets(BOM_FILTER_PRESETS_STORAGE_KEY, presets)
    bomFilterPresetImportText.value = ''
    const nextSelection = resolveFilterPresetCatalogDraftState({
      availablePresets: presets,
      selectedPresetKey: bomFilterPresetKey.value,
      routePresetKey: bomFilterPresetQuery.value,
      nameDraft: bomFilterPresetName.value,
      groupDraft: bomFilterPresetGroup.value,
      selectionKeys: bomPresetSelection.value,
      batchGroupDraft: bomPresetBatchGroup.value,
    })
    bomFilterPresetKey.value = nextSelection.nextSelectedPresetKey
    bomFilterPresetName.value = nextSelection.nextNameDraft
    bomFilterPresetGroup.value = nextSelection.nextGroupDraft
    bomPresetSelection.value = nextSelection.nextSelectionKeys
    bomPresetBatchGroup.value = nextSelection.nextBatchGroupDraft
    syncBomFilterPresetQuery(nextSelection.nextRoutePresetKey || undefined)
    reconcileBomLocalFilterPresetIdentityAfterImport()
    const importedCount = added + updated
    if (importedCount) {
      setDeepLinkMessage(
        `已导入 ${importedCount} 条 BOM 过滤预设（新增 ${added}，更新 ${updated}）${skippedText}。`
      )
    } else if (skippedParts.length) {
      setDeepLinkMessage(`未导入有效 BOM 过滤预设${skippedText}。`, true)
    } else {
      setDeepLinkMessage('未发现可导入的 BOM 过滤预设。', true)
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'not-array') {
      setDeepLinkMessage('BOM 过滤预设 JSON 需要是数组。', true)
      return
    }
    setDeepLinkMessage('BOM 过滤预设 JSON 解析失败。', true)
  }
}

function importBomFilterPresets() {
  importBomFilterPresetsFromText(bomFilterPresetImportText.value)
}

function exportBomFilterPresets() {
  if (!exportFilterPresetsFile(bomFilterPresets.value, 'plm-bom-filter-presets')) {
    setDeepLinkMessage('暂无可导出的BOM过滤预设。', true)
    return
  }
  setDeepLinkMessage('已导出BOM过滤预设。')
}

function triggerBomFilterPresetFileImport() {
  bomFilterPresetFileInput.value?.click()
}

async function importBomFilterPresetFile(file: File) {
  if (!file) return
  if (file.type && !file.type.includes('json') && !file.name.endsWith('.json')) {
    setDeepLinkMessage('仅支持 BOM 过滤预设 JSON 文件。', true)
    return
  }
  try {
    const text = await file.text()
    importBomFilterPresetsFromText(text)
  } catch (_err) {
    setDeepLinkMessage('读取 BOM 过滤预设文件失败。', true)
  }
}

async function handleBomFilterPresetFileImport(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  await importBomFilterPresetFile(file)
  target.value = ''
}

function clearBomFilterPresets() {
  if (!bomFilterPresets.value.length) return
  bomFilterPresets.value = []
  persistFilterPresets(BOM_FILTER_PRESETS_STORAGE_KEY, [])
  const nextSelection = resolveFilterPresetCatalogDraftState({
    availablePresets: [],
    selectedPresetKey: bomFilterPresetKey.value,
    routePresetKey: bomFilterPresetQuery.value,
    nameDraft: bomFilterPresetName.value,
    groupDraft: bomFilterPresetGroup.value,
    selectionKeys: bomPresetSelection.value,
    batchGroupDraft: bomPresetBatchGroup.value,
  })
  bomFilterPresetKey.value = nextSelection.nextSelectedPresetKey
  bomFilterPresetName.value = nextSelection.nextNameDraft
  bomFilterPresetGroup.value = nextSelection.nextGroupDraft
  bomPresetSelection.value = nextSelection.nextSelectionKeys
  bomPresetBatchGroup.value = nextSelection.nextBatchGroupDraft
  syncBomFilterPresetQuery(nextSelection.nextRoutePresetKey || undefined)
  bomFilterPresetGroupFilter.value = 'all'
  setDeepLinkMessage('已清空 BOM 过滤预设。')
}

function importWhereUsedFilterPresetsFromText(raw: string) {
  const trimmed = raw.trim()
  if (!trimmed) {
    setDeepLinkMessage('请粘贴 Where-Used 过滤预设 JSON。', true)
    return
  }
  try {
    const { entries, skippedInvalid, skippedMissing, duplicateCount } = parseFilterPresetImport(
      trimmed,
      whereUsedFilterFieldOptions
    )
    const skippedParts: string[] = []
    if (duplicateCount) skippedParts.push(`重复 ${duplicateCount} 条`)
    if (skippedInvalid) skippedParts.push(`格式错误 ${skippedInvalid} 条`)
    if (skippedMissing) skippedParts.push(`缺少字段 ${skippedMissing} 条`)
    const skippedText = skippedParts.length ? `，忽略 ${skippedParts.join('，')}` : ''
    if (!entries.length) {
      if (skippedParts.length) {
        setDeepLinkMessage(`未导入有效 Where-Used 过滤预设${skippedText}。`, true)
      } else {
        setDeepLinkMessage('未发现可导入的 Where-Used 过滤预设。', true)
      }
      return
    }
    const existingLabels = whereUsedFilterPresets.value.map((preset) => preset.label)
    const existingLabelSet = new Set(existingLabels)
    const conflictLabels = entries
      .filter((entry) => existingLabelSet.has(entry.label))
      .map((entry) => entry.label)
    const confirmed = confirmFilterPresetImport(
      'Where-Used',
      whereUsedFilterPresetImportMode.value,
      existingLabels,
      conflictLabels
    )
    if (!confirmed) {
      setDeepLinkMessage('已取消导入 Where-Used 过滤预设。', true)
      return
    }
    const { presets, added, updated } = mergeImportedFilterPresets(
      entries,
      whereUsedFilterPresets.value,
      'where-used',
      whereUsedFilterPresetImportMode.value
    )
    whereUsedFilterPresets.value = presets
    persistFilterPresets(WHERE_USED_FILTER_PRESETS_STORAGE_KEY, presets)
    whereUsedFilterPresetImportText.value = ''
    const nextSelection = resolveFilterPresetCatalogDraftState({
      availablePresets: presets,
      selectedPresetKey: whereUsedFilterPresetKey.value,
      routePresetKey: whereUsedFilterPresetQuery.value,
      nameDraft: whereUsedFilterPresetName.value,
      groupDraft: whereUsedFilterPresetGroup.value,
      selectionKeys: whereUsedPresetSelection.value,
      batchGroupDraft: whereUsedPresetBatchGroup.value,
    })
    whereUsedFilterPresetKey.value = nextSelection.nextSelectedPresetKey
    whereUsedFilterPresetName.value = nextSelection.nextNameDraft
    whereUsedFilterPresetGroup.value = nextSelection.nextGroupDraft
    whereUsedPresetSelection.value = nextSelection.nextSelectionKeys
    whereUsedPresetBatchGroup.value = nextSelection.nextBatchGroupDraft
    syncWhereUsedFilterPresetQuery(nextSelection.nextRoutePresetKey || undefined)
    reconcileWhereUsedLocalFilterPresetIdentityAfterImport()
    const importedCount = added + updated
    if (importedCount) {
      setDeepLinkMessage(
        `已导入 ${importedCount} 条 Where-Used 过滤预设（新增 ${added}，更新 ${updated}）${skippedText}。`
      )
    } else if (skippedParts.length) {
      setDeepLinkMessage(`未导入有效 Where-Used 过滤预设${skippedText}。`, true)
    } else {
      setDeepLinkMessage('未发现可导入的 Where-Used 过滤预设。', true)
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'not-array') {
      setDeepLinkMessage('Where-Used 过滤预设 JSON 需要是数组。', true)
      return
    }
    setDeepLinkMessage('Where-Used 过滤预设 JSON 解析失败。', true)
  }
}

function importWhereUsedFilterPresets() {
  importWhereUsedFilterPresetsFromText(whereUsedFilterPresetImportText.value)
}

function exportWhereUsedFilterPresets() {
  if (!exportFilterPresetsFile(whereUsedFilterPresets.value, 'plm-where-used-filter-presets')) {
    setDeepLinkMessage('暂无可导出的Where-Used过滤预设。', true)
    return
  }
  setDeepLinkMessage('已导出Where-Used过滤预设。')
}

function triggerWhereUsedFilterPresetFileImport() {
  whereUsedFilterPresetFileInput.value?.click()
}

async function importWhereUsedFilterPresetFile(file: File) {
  if (!file) return
  if (file.type && !file.type.includes('json') && !file.name.endsWith('.json')) {
    setDeepLinkMessage('仅支持 Where-Used 过滤预设 JSON 文件。', true)
    return
  }
  try {
    const text = await file.text()
    importWhereUsedFilterPresetsFromText(text)
  } catch (_err) {
    setDeepLinkMessage('读取 Where-Used 过滤预设文件失败。', true)
  }
}

async function handleWhereUsedFilterPresetFileImport(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  await importWhereUsedFilterPresetFile(file)
  target.value = ''
}

function clearWhereUsedFilterPresets() {
  if (!whereUsedFilterPresets.value.length) return
  whereUsedFilterPresets.value = []
  persistFilterPresets(WHERE_USED_FILTER_PRESETS_STORAGE_KEY, [])
  const nextSelection = resolveFilterPresetCatalogDraftState({
    availablePresets: [],
    selectedPresetKey: whereUsedFilterPresetKey.value,
    routePresetKey: whereUsedFilterPresetQuery.value,
    nameDraft: whereUsedFilterPresetName.value,
    groupDraft: whereUsedFilterPresetGroup.value,
    selectionKeys: whereUsedPresetSelection.value,
    batchGroupDraft: whereUsedPresetBatchGroup.value,
  })
  whereUsedFilterPresetKey.value = nextSelection.nextSelectedPresetKey
  whereUsedFilterPresetName.value = nextSelection.nextNameDraft
  whereUsedFilterPresetGroup.value = nextSelection.nextGroupDraft
  whereUsedPresetSelection.value = nextSelection.nextSelectionKeys
  whereUsedPresetBatchGroup.value = nextSelection.nextBatchGroupDraft
  syncWhereUsedFilterPresetQuery(nextSelection.nextRoutePresetKey || undefined)
  whereUsedFilterPresetGroupFilter.value = 'all'
  setDeepLinkMessage('已清空 Where-Used 过滤预设。')
}

function syncBomFilterPresetQuery(value?: string) {
  bomFilterPresetQuery.value = value || ''
  scheduleQuerySync({ bomFilterPreset: value || undefined })
}

function syncWhereUsedFilterPresetQuery(value?: string) {
  whereUsedFilterPresetQuery.value = value || ''
  scheduleQuerySync({ whereUsedFilterPreset: value || undefined })
}

function clearBomLocalFilterPresetIdentity() {
  const nextIdentity = buildClearedPlmLocalPresetManagementState()
  bomFilterPresetKey.value = nextIdentity.nextSelectedPresetKey
  bomFilterPresetName.value = nextIdentity.nextNameDraft
  bomFilterPresetGroup.value = nextIdentity.nextGroupDraft
  bomPresetSelection.value = nextIdentity.nextSelectionKeys
  bomPresetBatchGroup.value = nextIdentity.nextBatchGroupDraft
  syncBomFilterPresetQuery(undefined)
}

function clearWhereUsedLocalFilterPresetIdentity() {
  const nextIdentity = buildClearedPlmLocalPresetManagementState()
  whereUsedFilterPresetKey.value = nextIdentity.nextSelectedPresetKey
  whereUsedFilterPresetName.value = nextIdentity.nextNameDraft
  whereUsedFilterPresetGroup.value = nextIdentity.nextGroupDraft
  whereUsedPresetSelection.value = nextIdentity.nextSelectionKeys
  whereUsedPresetBatchGroup.value = nextIdentity.nextBatchGroupDraft
  syncWhereUsedFilterPresetQuery(undefined)
}

function reconcileBomLocalFilterPresetIdentityAfterImport() {
  const nextIdentity = resolvePlmLocalFilterPresetRouteIdentity({
    routePresetKey: bomFilterPresetQuery.value,
    selectedPresetKey: bomFilterPresetKey.value,
    nameDraft: bomFilterPresetName.value,
    groupDraft: bomFilterPresetGroup.value,
    activePreset: activeBomLocalRoutePreset.value,
    currentState: {
      field: bomFilterField.value,
      value: bomFilter.value,
    },
    selectionKeys: bomPresetSelection.value,
    batchGroupDraft: bomPresetBatchGroup.value,
    preserveSelectedPresetKeyOnClear: true,
  })
  if (!nextIdentity.shouldClear) {
    return
  }
  bomFilterPresetKey.value = nextIdentity.nextSelectedPresetKey
  bomFilterPresetName.value = nextIdentity.nextNameDraft
  bomFilterPresetGroup.value = nextIdentity.nextGroupDraft
  bomPresetSelection.value = nextIdentity.nextSelectionKeys
  bomPresetBatchGroup.value = nextIdentity.nextBatchGroupDraft
  syncBomFilterPresetQuery(nextIdentity.nextRoutePresetKey || undefined)
}

function reconcileWhereUsedLocalFilterPresetIdentityAfterImport() {
  const nextIdentity = resolvePlmLocalFilterPresetRouteIdentity({
    routePresetKey: whereUsedFilterPresetQuery.value,
    selectedPresetKey: whereUsedFilterPresetKey.value,
    nameDraft: whereUsedFilterPresetName.value,
    groupDraft: whereUsedFilterPresetGroup.value,
    activePreset: activeWhereUsedLocalRoutePreset.value,
    currentState: {
      field: whereUsedFilterField.value,
      value: whereUsedFilter.value,
    },
    selectionKeys: whereUsedPresetSelection.value,
    batchGroupDraft: whereUsedPresetBatchGroup.value,
    preserveSelectedPresetKeyOnClear: true,
  })
  if (!nextIdentity.shouldClear) {
    return
  }
  whereUsedFilterPresetKey.value = nextIdentity.nextSelectedPresetKey
  whereUsedFilterPresetName.value = nextIdentity.nextNameDraft
  whereUsedFilterPresetGroup.value = nextIdentity.nextGroupDraft
  whereUsedPresetSelection.value = nextIdentity.nextSelectionKeys
  whereUsedPresetBatchGroup.value = nextIdentity.nextBatchGroupDraft
  syncWhereUsedFilterPresetQuery(nextIdentity.nextRoutePresetKey || undefined)
}

function hasProcessedTeamPresetChanges(result: PlmTeamFilterPresetBatchResult | null | undefined) {
  return Boolean(result?.processedIds.length)
}

function clearBomTeamPresetIdentity() {
  bomTeamPresetKey.value = ''
  bomTeamPresetQuery.value = ''
  scheduleQuerySync({ bomTeamPreset: undefined })
}

function clearWhereUsedTeamPresetIdentity() {
  whereUsedTeamPresetKey.value = ''
  whereUsedTeamPresetQuery.value = ''
  scheduleQuerySync({ whereUsedTeamPreset: undefined })
}

function applyBomLocalFilterPresetIdentity(preset: FilterPreset) {
  clearBomTeamPresetIdentity()
  bomFilterPresetKey.value = preset.key
  syncBomFilterPresetQuery(preset.key)
  bomFilterField.value = preset.field
  bomFilter.value = preset.value
}

function applyWhereUsedLocalFilterPresetIdentity(preset: FilterPreset) {
  clearWhereUsedTeamPresetIdentity()
  whereUsedFilterPresetKey.value = preset.key
  syncWhereUsedFilterPresetQuery(preset.key)
  whereUsedFilterField.value = preset.field
  whereUsedFilter.value = preset.value
}

const bomTeamPresetQuery = ref('')
const whereUsedTeamPresetQuery = ref('')

const activeBomLocalRoutePreset = computed(() => {
  const presetKey = bomFilterPresetQuery.value.trim()
  if (!presetKey) return null
  return bomFilterPresets.value.find((entry) => entry.key === presetKey) || null
})

const hasActiveBomLocalPresetOwner = computed(() => {
  const preset = activeBomLocalRoutePreset.value
  if (!preset) return false
  return matchPlmTeamFilterPresetStateSnapshot(
    pickPlmTeamFilterPresetRouteOwnerState(preset),
    {
      field: bomFilterField.value,
      value: bomFilter.value,
    },
  )
})

const {
  teamPresetKey: bomTeamPresetKey,
  teamPresetName: bomTeamPresetName,
  teamPresetGroup: bomTeamPresetGroup,
  teamPresetOwnerUserId: bomTeamPresetOwnerUserId,
  teamPresets: bomTeamPresets,
  teamPresetsLoading: bomTeamPresetsLoading,
  teamPresetsError: bomTeamPresetsError,
  canSaveTeamPreset: canSaveBomTeamPreset,
  canApplyTeamPreset: canApplyBomTeamPreset,
  showManagementActions: showManageBomTeamPresetActions,
  canDuplicateTeamPreset: canDuplicateBomTeamPreset,
  canShareTeamPreset: canShareBomTeamPreset,
  canDeleteTeamPreset: canDeleteBomTeamPreset,
  canArchiveTeamPreset: canArchiveBomTeamPreset,
  canRestoreTeamPreset: canRestoreBomTeamPreset,
  canRenameTeamPreset: canRenameBomTeamPreset,
  canTransferTargetTeamPreset: canTransferTargetBomTeamPreset,
  canTransferTeamPreset: canTransferBomTeamPreset,
  canSetTeamPresetDefault: canSetBomTeamPresetDefault,
  canClearTeamPresetDefault: canClearBomTeamPresetDefault,
  defaultTeamPresetLabel: bomDefaultTeamPresetLabel,
  hasManageableTeamPresets: hasManageableBomTeamPresets,
  showTeamPresetManager: showBomTeamPresetManager,
  teamPresetSelection: bomTeamPresetSelection,
  teamPresetSelectionCount: bomTeamPresetSelectionCount,
  selectedBatchArchivableTeamPresetIds: selectedBatchArchivableBomTeamPresetIds,
  selectedBatchRestorableTeamPresetIds: selectedBatchRestorableBomTeamPresetIds,
  selectedBatchDeletableTeamPresetIds: selectedBatchDeletableBomTeamPresetIds,
  refreshTeamPresets: refreshBomTeamPresets,
  saveTeamPreset: saveBomTeamPresetBase,
  promoteFilterPresetToTeam: promoteBomFilterPresetToTeamBase,
  promoteFilterPresetToTeamDefault: promoteBomFilterPresetToTeamDefaultBase,
  applyTeamPreset: applyBomTeamPresetBase,
  shareTeamPreset: shareBomTeamPreset,
  duplicateTeamPreset: duplicateBomTeamPresetBase,
  archiveTeamPreset: archiveBomTeamPresetBase,
  restoreTeamPreset: restoreBomTeamPresetBase,
  deleteTeamPreset: deleteBomTeamPreset,
  renameTeamPreset: renameBomTeamPresetBase,
  transferTeamPreset: transferBomTeamPresetBase,
  setTeamPresetDefault: setBomTeamPresetDefaultBase,
  clearTeamPresetDefault: clearBomTeamPresetDefaultBase,
  selectAllTeamPresets: selectAllBomTeamPresets,
  clearTeamPresetSelection: clearBomTeamPresetSelection,
  archiveTeamPresetSelection: archiveBomTeamPresetSelectionBase,
  restoreTeamPresetSelection: restoreBomTeamPresetSelectionBase,
  deleteTeamPresetSelection: deleteBomTeamPresetSelectionBase,
} = usePlmTeamFilterPresets({
  kind: 'bom',
  label: 'BOM',
  getCurrentPresetState: () => ({
    field: bomFilterField.value,
    value: bomFilter.value,
    group: bomFilterPresetGroup.value,
  }),
  applyPreset: (preset) => {
    bomFilterField.value = preset.field
    bomFilter.value = preset.value
    bomFilterPresetGroup.value = preset.group || ''
  },
  setMessage: setDeepLinkMessage,
  requestedPresetId: bomTeamPresetQuery,
  syncRequestedPresetId: (value) => {
    bomTeamPresetQuery.value = value || ''
    scheduleQuerySync({ bomTeamPreset: value || undefined })
  },
  buildShareUrl: (preset) => buildTeamFilterPresetShareUrl(
    'bom',
    preset,
    route.path,
    'bom',
    undefined,
    {
      productId: productId.value,
      itemNumber: productItemNumber.value,
      itemType: itemType.value !== DEFAULT_ITEM_TYPE ? itemType.value : '',
    },
  ),
  copyShareUrl: copyToClipboard,
  shouldAutoApplyDefault: () => {
    const effectiveQuery = applyPlmDeferredRouteQueryPatch(
      route.query as Record<string, unknown>,
      deferredRouteQueryPatch,
    )
    const localPresetKey = typeof effectiveQuery.bomFilterPreset === 'string'
      ? effectiveQuery.bomFilterPreset.trim()
      : ''
    return (
      !hasExplicitPlmBomTeamPresetAutoApplyQueryState(effectiveQuery, {
        hasLocalFilterPresetOwner: !localPresetKey
          || bomFilterPresets.value.some((entry) => entry.key === localPresetKey),
      })
      && !bomFilter.value.trim()
    )
  },
  hasPendingExternalOwnerDrift: () => hasActiveBomLocalPresetOwner.value && Boolean(bomTeamPresetKey.value.trim()),
})

const activeBomRoutePreset = computed(() => {
  const presetId = bomTeamPresetQuery.value.trim()
  if (!presetId) return null
  return bomTeamPresets.value.find((entry) => entry.id === presetId) || null
})

const activeWhereUsedLocalRoutePreset = computed(() => {
  const presetKey = whereUsedFilterPresetQuery.value.trim()
  if (!presetKey) return null
  return whereUsedFilterPresets.value.find((entry) => entry.key === presetKey) || null
})

const hasActiveWhereUsedLocalPresetOwner = computed(() => {
  const preset = activeWhereUsedLocalRoutePreset.value
  if (!preset) return false
  return matchPlmTeamFilterPresetStateSnapshot(
    pickPlmTeamFilterPresetRouteOwnerState(preset),
    {
      field: whereUsedFilterField.value,
      value: whereUsedFilter.value,
    },
  )
})

const {
  teamPresetKey: whereUsedTeamPresetKey,
  teamPresetName: whereUsedTeamPresetName,
  teamPresetGroup: whereUsedTeamPresetGroup,
  teamPresetOwnerUserId: whereUsedTeamPresetOwnerUserId,
  teamPresets: whereUsedTeamPresets,
  teamPresetsLoading: whereUsedTeamPresetsLoading,
  teamPresetsError: whereUsedTeamPresetsError,
  canSaveTeamPreset: canSaveWhereUsedTeamPreset,
  canApplyTeamPreset: canApplyWhereUsedTeamPreset,
  showManagementActions: showManageWhereUsedTeamPresetActions,
  canDuplicateTeamPreset: canDuplicateWhereUsedTeamPreset,
  canShareTeamPreset: canShareWhereUsedTeamPreset,
  canDeleteTeamPreset: canDeleteWhereUsedTeamPreset,
  canArchiveTeamPreset: canArchiveWhereUsedTeamPreset,
  canRestoreTeamPreset: canRestoreWhereUsedTeamPreset,
  canRenameTeamPreset: canRenameWhereUsedTeamPreset,
  canTransferTargetTeamPreset: canTransferTargetWhereUsedTeamPreset,
  canTransferTeamPreset: canTransferWhereUsedTeamPreset,
  canSetTeamPresetDefault: canSetWhereUsedTeamPresetDefault,
  canClearTeamPresetDefault: canClearWhereUsedTeamPresetDefault,
  defaultTeamPresetLabel: whereUsedDefaultTeamPresetLabel,
  hasManageableTeamPresets: hasManageableWhereUsedTeamPresets,
  showTeamPresetManager: showWhereUsedTeamPresetManager,
  teamPresetSelection: whereUsedTeamPresetSelection,
  teamPresetSelectionCount: whereUsedTeamPresetSelectionCount,
  selectedBatchArchivableTeamPresetIds: selectedBatchArchivableWhereUsedTeamPresetIds,
  selectedBatchRestorableTeamPresetIds: selectedBatchRestorableWhereUsedTeamPresetIds,
  selectedBatchDeletableTeamPresetIds: selectedBatchDeletableWhereUsedTeamPresetIds,
  refreshTeamPresets: refreshWhereUsedTeamPresets,
  saveTeamPreset: saveWhereUsedTeamPresetBase,
  promoteFilterPresetToTeam: promoteWhereUsedFilterPresetToTeamBase,
  promoteFilterPresetToTeamDefault: promoteWhereUsedFilterPresetToTeamDefaultBase,
  applyTeamPreset: applyWhereUsedTeamPresetBase,
  shareTeamPreset: shareWhereUsedTeamPreset,
  duplicateTeamPreset: duplicateWhereUsedTeamPresetBase,
  archiveTeamPreset: archiveWhereUsedTeamPresetBase,
  restoreTeamPreset: restoreWhereUsedTeamPresetBase,
  deleteTeamPreset: deleteWhereUsedTeamPreset,
  renameTeamPreset: renameWhereUsedTeamPresetBase,
  transferTeamPreset: transferWhereUsedTeamPresetBase,
  setTeamPresetDefault: setWhereUsedTeamPresetDefaultBase,
  clearTeamPresetDefault: clearWhereUsedTeamPresetDefaultBase,
  selectAllTeamPresets: selectAllWhereUsedTeamPresets,
  clearTeamPresetSelection: clearWhereUsedTeamPresetSelection,
  archiveTeamPresetSelection: archiveWhereUsedTeamPresetSelectionBase,
  restoreTeamPresetSelection: restoreWhereUsedTeamPresetSelectionBase,
  deleteTeamPresetSelection: deleteWhereUsedTeamPresetSelectionBase,
} = usePlmTeamFilterPresets({
  kind: 'where-used',
  label: 'Where-Used',
  getCurrentPresetState: () => ({
    field: whereUsedFilterField.value,
    value: whereUsedFilter.value,
    group: whereUsedFilterPresetGroup.value,
  }),
  applyPreset: (preset) => {
    whereUsedFilterField.value = preset.field
    whereUsedFilter.value = preset.value
    whereUsedFilterPresetGroup.value = preset.group || ''
  },
  setMessage: setDeepLinkMessage,
  requestedPresetId: whereUsedTeamPresetQuery,
  syncRequestedPresetId: (value) => {
    whereUsedTeamPresetQuery.value = value || ''
    scheduleQuerySync({ whereUsedTeamPreset: value || undefined })
  },
  buildShareUrl: (preset) => buildTeamFilterPresetShareUrl(
    'where-used',
    preset,
    route.path,
    'where-used',
    undefined,
    {
      productId: productId.value,
      itemNumber: productItemNumber.value,
      itemType: itemType.value !== DEFAULT_ITEM_TYPE ? itemType.value : '',
      whereUsedItemId: whereUsedItemId.value,
    },
  ),
  copyShareUrl: copyToClipboard,
  shouldAutoApplyDefault: () => {
    const effectiveQuery = applyPlmDeferredRouteQueryPatch(
      route.query as Record<string, unknown>,
      deferredRouteQueryPatch,
    )
    const localPresetKey = typeof effectiveQuery.whereUsedFilterPreset === 'string'
      ? effectiveQuery.whereUsedFilterPreset.trim()
      : ''
    return (
      !hasExplicitPlmWhereUsedTeamPresetAutoApplyQueryState(effectiveQuery, {
        hasLocalFilterPresetOwner: !localPresetKey
          || whereUsedFilterPresets.value.some((entry) => entry.key === localPresetKey),
      })
      && !whereUsedFilter.value.trim()
    )
  },
  hasPendingExternalOwnerDrift: () => hasActiveWhereUsedLocalPresetOwner.value && Boolean(whereUsedTeamPresetKey.value.trim()),
})

const activeWhereUsedRoutePreset = computed(() => {
  const presetId = whereUsedTeamPresetQuery.value.trim()
  if (!presetId) return null
  return whereUsedTeamPresets.value.find((entry) => entry.id === presetId) || null
})

async function applyBomTeamPreset() {
  await runPlmLocalPresetOwnershipAction(
    async () => applyBomTeamPresetBase(),
    {
      clearLocalOwner: clearBomLocalFilterPresetIdentity,
      shouldClear: (saved) => Boolean(saved),
    },
  )
}

async function duplicateBomTeamPreset() {
  await runPlmLocalPresetOwnershipAction(
    () => duplicateBomTeamPresetBase(),
    {
      clearLocalOwner: clearBomLocalFilterPresetIdentity,
      shouldClear: (saved) => Boolean(saved),
    },
  )
}

async function archiveBomTeamPreset() {
  await runPlmLocalPresetOwnershipAction(
    () => archiveBomTeamPresetBase(),
    {
      clearLocalOwner: clearBomLocalFilterPresetIdentity,
      shouldClear: (saved) => shouldClearLocalPresetOwnerAfterTeamPresetAction('archive', saved),
    },
  )
}

async function restoreBomTeamPreset() {
  const hadLocalOwnerBeforeAction = hasActiveBomLocalPresetOwner.value
  await runPlmLocalPresetOwnershipAction(
    () => restoreBomTeamPresetBase(),
    {
      clearLocalOwner: clearBomLocalFilterPresetIdentity,
      shouldClear: (saved) => shouldClearLocalPresetOwnerAfterTeamPresetSingleRestore(
        saved,
        hadLocalOwnerBeforeAction,
      ),
    },
  )
}

async function renameBomTeamPreset() {
  await runPlmLocalPresetOwnershipAction(
    () => renameBomTeamPresetBase(),
    {
      clearLocalOwner: clearBomLocalFilterPresetIdentity,
      shouldClear: (saved) => Boolean(saved),
    },
  )
}

async function transferBomTeamPreset() {
  await runPlmLocalPresetOwnershipAction(
    () => transferBomTeamPresetBase(),
    {
      clearLocalOwner: clearBomLocalFilterPresetIdentity,
      shouldClear: (saved) => Boolean(saved),
    },
  )
}

async function saveBomTeamPreset() {
  await runPlmLocalPresetOwnershipAction(
    () => saveBomTeamPresetBase(),
    {
      clearLocalOwner: clearBomLocalFilterPresetIdentity,
      shouldClear: (saved) => Boolean(saved),
    },
  )
}

async function promoteBomFilterPresetToTeam() {
  const preset = bomFilterPresets.value.find((entry) => entry.key === bomFilterPresetKey.value)
  if (!preset) {
    setDeepLinkMessage('请选择 BOM 过滤预设后再升为团队预设。', true)
    return
  }
  await runPlmLocalPresetOwnershipAction(
    () => promoteBomFilterPresetToTeamBase(preset),
    {
      clearLocalOwner: clearBomLocalFilterPresetIdentity,
      shouldClear: (saved) => Boolean(saved),
    },
  )
}

async function promoteBomFilterPresetToTeamDefault() {
  const preset = bomFilterPresets.value.find((entry) => entry.key === bomFilterPresetKey.value)
  if (!preset) {
    setDeepLinkMessage('请选择 BOM 过滤预设后再升为默认团队预设。', true)
    return
  }
  await runPlmLocalPresetOwnershipAction(
    () => promoteBomFilterPresetToTeamDefaultBase(preset),
    {
      clearLocalOwner: clearBomLocalFilterPresetIdentity,
      shouldClear: (saved) => Boolean(saved),
    },
  )
}

async function setBomTeamPresetDefault() {
  await runPlmLocalPresetOwnershipAction(
    () => setBomTeamPresetDefaultBase(),
    {
      clearLocalOwner: clearBomLocalFilterPresetIdentity,
      shouldClear: (saved) => Boolean(saved),
    },
  )
}

async function clearBomTeamPresetDefault() {
  await runPlmLocalPresetOwnershipAction(
    () => clearBomTeamPresetDefaultBase(),
    {
      clearLocalOwner: clearBomLocalFilterPresetIdentity,
      shouldClear: (saved) => shouldClearLocalPresetOwnerAfterTeamPresetAction('clear-default', saved),
    },
  )
}

async function archiveBomTeamPresetSelection() {
  await runPlmLocalPresetOwnershipAction(
    () => archiveBomTeamPresetSelectionBase(),
    {
      clearLocalOwner: clearBomLocalFilterPresetIdentity,
      shouldClear: (result) => (
        hasProcessedTeamPresetChanges(result)
        && shouldClearLocalPresetOwnerAfterTeamPresetAction('batch-archive', result)
      ),
    },
  )
}

async function restoreBomTeamPresetSelection() {
  const hadLocalOwnerBeforeAction = hasActiveBomLocalPresetOwner.value
  const activeTeamPresetIdBeforeAction = bomTeamPresetKey.value
  const requestedTeamPresetIdBeforeAction = bomTeamPresetQuery.value
  await runPlmLocalPresetOwnershipAction(
    () => restoreBomTeamPresetSelectionBase(),
    {
      clearLocalOwner: clearBomLocalFilterPresetIdentity,
      shouldClear: (result) => shouldClearLocalPresetOwnerAfterTeamPresetBatchRestore(
        result,
        activeTeamPresetIdBeforeAction,
        requestedTeamPresetIdBeforeAction,
        hadLocalOwnerBeforeAction,
      ),
    },
  )
}

async function deleteBomTeamPresetSelection() {
  await runPlmLocalPresetOwnershipAction(
    () => deleteBomTeamPresetSelectionBase(),
    {
      clearLocalOwner: clearBomLocalFilterPresetIdentity,
      shouldClear: (result) => (
        hasProcessedTeamPresetChanges(result)
        && shouldClearLocalPresetOwnerAfterTeamPresetAction('batch-delete', result)
      ),
    },
  )
}

async function applyWhereUsedTeamPreset() {
  await runPlmLocalPresetOwnershipAction(
    async () => applyWhereUsedTeamPresetBase(),
    {
      clearLocalOwner: clearWhereUsedLocalFilterPresetIdentity,
      shouldClear: (saved) => Boolean(saved),
    },
  )
}

async function duplicateWhereUsedTeamPreset() {
  await runPlmLocalPresetOwnershipAction(
    () => duplicateWhereUsedTeamPresetBase(),
    {
      clearLocalOwner: clearWhereUsedLocalFilterPresetIdentity,
      shouldClear: (saved) => Boolean(saved),
    },
  )
}

async function archiveWhereUsedTeamPreset() {
  await runPlmLocalPresetOwnershipAction(
    () => archiveWhereUsedTeamPresetBase(),
    {
      clearLocalOwner: clearWhereUsedLocalFilterPresetIdentity,
      shouldClear: (saved) => shouldClearLocalPresetOwnerAfterTeamPresetAction('archive', saved),
    },
  )
}

async function restoreWhereUsedTeamPreset() {
  const hadLocalOwnerBeforeAction = hasActiveWhereUsedLocalPresetOwner.value
  await runPlmLocalPresetOwnershipAction(
    () => restoreWhereUsedTeamPresetBase(),
    {
      clearLocalOwner: clearWhereUsedLocalFilterPresetIdentity,
      shouldClear: (saved) => shouldClearLocalPresetOwnerAfterTeamPresetSingleRestore(
        saved,
        hadLocalOwnerBeforeAction,
      ),
    },
  )
}

async function renameWhereUsedTeamPreset() {
  await runPlmLocalPresetOwnershipAction(
    () => renameWhereUsedTeamPresetBase(),
    {
      clearLocalOwner: clearWhereUsedLocalFilterPresetIdentity,
      shouldClear: (saved) => Boolean(saved),
    },
  )
}

async function transferWhereUsedTeamPreset() {
  await runPlmLocalPresetOwnershipAction(
    () => transferWhereUsedTeamPresetBase(),
    {
      clearLocalOwner: clearWhereUsedLocalFilterPresetIdentity,
      shouldClear: (saved) => Boolean(saved),
    },
  )
}

async function saveWhereUsedTeamPreset() {
  await runPlmLocalPresetOwnershipAction(
    () => saveWhereUsedTeamPresetBase(),
    {
      clearLocalOwner: clearWhereUsedLocalFilterPresetIdentity,
      shouldClear: (saved) => Boolean(saved),
    },
  )
}

async function promoteWhereUsedFilterPresetToTeam() {
  const preset = whereUsedFilterPresets.value.find((entry) => entry.key === whereUsedFilterPresetKey.value)
  if (!preset) {
    setDeepLinkMessage('请选择 Where-Used 过滤预设后再升为团队预设。', true)
    return
  }
  await runPlmLocalPresetOwnershipAction(
    () => promoteWhereUsedFilterPresetToTeamBase(preset),
    {
      clearLocalOwner: clearWhereUsedLocalFilterPresetIdentity,
      shouldClear: (saved) => Boolean(saved),
    },
  )
}

async function promoteWhereUsedFilterPresetToTeamDefault() {
  const preset = whereUsedFilterPresets.value.find((entry) => entry.key === whereUsedFilterPresetKey.value)
  if (!preset) {
    setDeepLinkMessage('请选择 Where-Used 过滤预设后再升为默认团队预设。', true)
    return
  }
  await runPlmLocalPresetOwnershipAction(
    () => promoteWhereUsedFilterPresetToTeamDefaultBase(preset),
    {
      clearLocalOwner: clearWhereUsedLocalFilterPresetIdentity,
      shouldClear: (saved) => Boolean(saved),
    },
  )
}

async function setWhereUsedTeamPresetDefault() {
  await runPlmLocalPresetOwnershipAction(
    () => setWhereUsedTeamPresetDefaultBase(),
    {
      clearLocalOwner: clearWhereUsedLocalFilterPresetIdentity,
      shouldClear: (saved) => Boolean(saved),
    },
  )
}

async function clearWhereUsedTeamPresetDefault() {
  await runPlmLocalPresetOwnershipAction(
    () => clearWhereUsedTeamPresetDefaultBase(),
    {
      clearLocalOwner: clearWhereUsedLocalFilterPresetIdentity,
      shouldClear: (saved) => shouldClearLocalPresetOwnerAfterTeamPresetAction('clear-default', saved),
    },
  )
}

async function archiveWhereUsedTeamPresetSelection() {
  await runPlmLocalPresetOwnershipAction(
    () => archiveWhereUsedTeamPresetSelectionBase(),
    {
      clearLocalOwner: clearWhereUsedLocalFilterPresetIdentity,
      shouldClear: (result) => (
        hasProcessedTeamPresetChanges(result)
        && shouldClearLocalPresetOwnerAfterTeamPresetAction('batch-archive', result)
      ),
    },
  )
}

async function restoreWhereUsedTeamPresetSelection() {
  const hadLocalOwnerBeforeAction = hasActiveWhereUsedLocalPresetOwner.value
  const activeTeamPresetIdBeforeAction = whereUsedTeamPresetKey.value
  const requestedTeamPresetIdBeforeAction = whereUsedTeamPresetQuery.value
  await runPlmLocalPresetOwnershipAction(
    () => restoreWhereUsedTeamPresetSelectionBase(),
    {
      clearLocalOwner: clearWhereUsedLocalFilterPresetIdentity,
      shouldClear: (result) => shouldClearLocalPresetOwnerAfterTeamPresetBatchRestore(
        result,
        activeTeamPresetIdBeforeAction,
        requestedTeamPresetIdBeforeAction,
        hadLocalOwnerBeforeAction,
      ),
    },
  )
}

async function deleteWhereUsedTeamPresetSelection() {
  await runPlmLocalPresetOwnershipAction(
    () => deleteWhereUsedTeamPresetSelectionBase(),
    {
      clearLocalOwner: clearWhereUsedLocalFilterPresetIdentity,
      shouldClear: (result) => (
        hasProcessedTeamPresetChanges(result)
        && shouldClearLocalPresetOwnerAfterTeamPresetAction('batch-delete', result)
      ),
    },
  )
}

const documentTeamViewQuery = ref('')
const cadTeamViewQuery = ref('')
const approvalsTeamViewQuery = ref('')

function buildWorkbenchTeamViewState(): PlmWorkbenchViewQueryState {
  const query = normalizePlmWorkbenchCollaborativeQuerySnapshot(buildDeepLinkParams(true))
  return {
    query,
  }
}

async function applyWorkbenchTeamViewState(state: PlmWorkbenchViewQueryState) {
  const nextQuery = mergePlmWorkbenchRouteQuery(route.query, normalizePlmWorkbenchCollaborativeQuerySnapshot(state.query))
  if (workbenchTeamViewQuery.value) {
    nextQuery.workbenchTeamView = workbenchTeamViewQuery.value
  }
  await router.replace({ query: nextQuery }).catch(() => null)
  await nextTick()
  await applyQueryState()
}

const workbenchTeamViewQuery = ref('')
const sceneCatalogOwnerFilter = ref('')
const sceneCatalogAutoFocusSceneId = ref('')
const sceneCatalogRecommendationFilter = ref<''
| 'default'
| 'recent-default'
| 'recent-update'>('')
const sceneCatalogRecommendationOptions: FilterFieldOption[] = WORKBENCH_SCENE_RECOMMENDATION_OPTIONS
const {
  teamViewKey: workbenchTeamViewKey,
  teamViewName: workbenchTeamViewName,
  teamViewOwnerUserId: workbenchTeamViewOwnerUserId,
  teamViews: workbenchTeamViews,
  teamViewsLoading: workbenchTeamViewsLoading,
  teamViewsError: workbenchTeamViewsError,
  canSaveTeamView: canSaveWorkbenchTeamView,
  canApplyTeamView: canApplyWorkbenchTeamView,
  showManagementActions: showManageWorkbenchTeamViewActions,
  canDuplicateTeamView: canDuplicateWorkbenchTeamView,
  canShareTeamView: canShareWorkbenchTeamView,
  canDeleteTeamView: canDeleteWorkbenchTeamView,
  canArchiveTeamView: canArchiveWorkbenchTeamView,
  canRestoreTeamView: canRestoreWorkbenchTeamView,
  canRenameTeamView: canRenameWorkbenchTeamView,
  canTransferTargetTeamView: canTransferWorkbenchTeamViewTarget,
  canTransferTeamView: canTransferWorkbenchTeamView,
  canSetTeamViewDefault: canSetWorkbenchTeamViewDefault,
  canClearTeamViewDefault: canClearWorkbenchTeamViewDefault,
  defaultTeamViewLabel: workbenchDefaultTeamViewLabel,
  hasManageableTeamViews: hasManageableWorkbenchTeamViews,
  showTeamViewManager: showWorkbenchTeamViewManager,
  teamViewSelection: workbenchTeamViewSelection,
  teamViewSelectionCount: workbenchTeamViewSelectionCount,
  selectedBatchArchivableTeamViewIds: selectedBatchArchivableWorkbenchTeamViewIds,
  selectedBatchRestorableTeamViewIds: selectedBatchRestorableWorkbenchTeamViewIds,
  selectedBatchDeletableTeamViewIds: selectedBatchDeletableWorkbenchTeamViewIds,
  refreshTeamViews: refreshWorkbenchTeamViews,
  saveTeamView: saveWorkbenchTeamView,
  applyTeamView: applyWorkbenchTeamView,
  duplicateTeamView: duplicateWorkbenchTeamView,
  shareTeamView: shareWorkbenchTeamView,
  deleteTeamView: deleteWorkbenchTeamView,
  archiveTeamView: archiveWorkbenchTeamView,
  restoreTeamView: restoreWorkbenchTeamView,
  renameTeamView: renameWorkbenchTeamView,
  transferTeamView: transferWorkbenchTeamView,
  setTeamViewDefault: setWorkbenchTeamViewDefault,
  clearTeamViewDefault: clearWorkbenchTeamViewDefault,
  selectAllTeamViews: selectAllWorkbenchTeamViews,
  clearTeamViewSelection: clearWorkbenchTeamViewSelection,
  archiveTeamViewSelection: archiveWorkbenchTeamViewSelection,
  restoreTeamViewSelection: restoreWorkbenchTeamViewSelection,
  deleteTeamViewSelection: deleteWorkbenchTeamViewSelection,
} = usePlmTeamViews({
  kind: 'workbench',
  label: '工作台',
  getCurrentViewState: () => buildWorkbenchTeamViewState(),
  applyViewState: (state) => {
    void applyWorkbenchTeamViewState(state)
  },
  setMessage: setDeepLinkMessage,
  requestedViewId: workbenchTeamViewQuery,
  syncRequestedViewId: (value) => {
    workbenchTeamViewQuery.value = value || ''
    scheduleQuerySync({ workbenchTeamView: value || undefined })
  },
  buildShareUrl: (view) => buildPlmWorkbenchTeamViewShareUrl('workbench', view, route.path),
  copyShareUrl: copyToClipboard,
  shouldAutoApplyDefault: () => !hasExplicitWorkbenchQueryState(),
})

const sceneCatalogOwnerOptions = computed(() =>
  buildWorkbenchSceneCatalogOwnerOptions(workbenchTeamViews.value),
)

const recommendedWorkbenchScenes = computed<PlmRecommendedWorkbenchScene[]>(() =>
  buildRecommendedWorkbenchScenes(workbenchTeamViews.value, {
    ownerUserId: sceneCatalogOwnerFilter.value,
    recommendationFilter: sceneCatalogRecommendationFilter.value,
  }),
)

const activeWorkbenchRouteView = computed(() => {
  const viewId = workbenchTeamViewQuery.value.trim()
  if (!viewId) return null
  return workbenchTeamViews.value.find((entry) => entry.id === viewId) || null
})

watch(
  () => [
    workbenchTeamViewQuery.value,
    activeWorkbenchRouteView.value?.id || '',
    JSON.stringify(buildWorkbenchTeamViewState().query),
  ],
  ([viewId, activeViewId]) => {
    if (!viewId || !activeViewId) return
    const activeView = activeWorkbenchRouteView.value
    if (!activeView) return
    if (matchPlmWorkbenchQuerySnapshot(activeView.state.query, buildWorkbenchTeamViewState().query)) return
    workbenchTeamViewQuery.value = ''
    scheduleQuerySync({ workbenchTeamView: undefined })
  },
)

const sceneCatalogSummaryChips = computed(() =>
  buildWorkbenchSceneSummaryChips(workbenchTeamViews.value, {
    ownerUserId: sceneCatalogOwnerFilter.value,
    recommendationFilter: sceneCatalogRecommendationFilter.value,
  }),
)

const sceneCatalogSummaryHint = computed(() =>
  buildWorkbenchSceneSummaryHint(sceneCatalogSummaryChips.value),
)

function clearSceneCatalogAutoFocusSceneId() {
  if (!sceneCatalogAutoFocusSceneId.value) return
  sceneCatalogAutoFocusSceneId.value = ''
  syncQueryParams({ sceneFocus: undefined })
}

function setSceneCatalogRecommendationFilter(value: '' | 'default' | 'recent-default' | 'recent-update') {
  sceneCatalogRecommendationFilter.value = value
}

function applyRecommendedWorkbenchScene(viewId: string) {
  const view = workbenchTeamViews.value.find((entry) => entry.id === viewId)
  if (!view || !canApplyPlmCollaborativeEntry(view)) return
  workbenchTeamViewKey.value = viewId
  applyWorkbenchTeamView()
}

async function copyRecommendedWorkbenchSceneLink(viewId: string) {
  const view = workbenchTeamViews.value.find((entry) => entry.id === viewId)
  if (!view) {
    setDeepLinkMessage('未找到团队场景。', true)
    return
  }
  if (!canSharePlmCollaborativeEntry(view)) {
    setDeepLinkMessage(`当前账号无权分享团队场景：${view.name}`, true)
    return
  }
  const copied = await copyToClipboard(
    buildPlmWorkbenchTeamViewShareUrl('workbench', view, route.path),
  )
  if (!copied) {
    setDeepLinkMessage(`复制团队场景链接失败：${view.name}`, true)
    return
  }
  setDeepLinkMessage(`已复制团队场景链接：${view.name}`)
}

async function openRecommendedWorkbenchSceneAudit(scene: PlmRecommendedWorkbenchScene) {
  const returnToPlmPath = buildPlmWorkbenchRoutePath(
    route.path,
    buildDeepLinkParams(true),
    {
      hash: route.hash,
      extraQuery: { sceneFocus: scene.id },
    },
  )
  await router.push({
    name: 'plm-audit',
    query: buildRecommendedWorkbenchSceneAuditQuery(
      scene,
      returnToPlmPath,
    ),
  })
}

async function openWorkbenchSceneAudit() {
  const returnToPlmPath = buildPlmWorkbenchRoutePath(
    route.path,
    buildDeepLinkParams(true),
    {
      hash: route.hash,
    },
  )
  await router.push({
    name: 'plm-audit',
  query: buildWorkbenchAuditQuery(returnToPlmPath),
  })
}

const {
  teamViewKey: documentTeamViewKey,
  teamViewName: documentTeamViewName,
  teamViewOwnerUserId: documentTeamViewOwnerUserId,
  teamViews: documentTeamViews,
  teamViewsLoading: documentTeamViewsLoading,
  teamViewsError: documentTeamViewsError,
  canSaveTeamView: canSaveDocumentTeamView,
  canApplyTeamView: canApplyDocumentTeamView,
  showManagementActions: showManageDocumentTeamViewActions,
  canDuplicateTeamView: canDuplicateDocumentTeamView,
  canShareTeamView: canShareDocumentTeamView,
  canDeleteTeamView: canDeleteDocumentTeamView,
  canArchiveTeamView: canArchiveDocumentTeamView,
  canRestoreTeamView: canRestoreDocumentTeamView,
  canRenameTeamView: canRenameDocumentTeamView,
  canTransferTargetTeamView: canTransferDocumentTeamViewTarget,
  canTransferTeamView: canTransferDocumentTeamView,
  canSetTeamViewDefault: canSetDocumentTeamViewDefault,
  canClearTeamViewDefault: canClearDocumentTeamViewDefault,
  defaultTeamViewLabel: documentDefaultTeamViewLabel,
  hasManageableTeamViews: hasManageableDocumentTeamViews,
  showTeamViewManager: showDocumentTeamViewManager,
  teamViewSelection: documentTeamViewSelection,
  teamViewSelectionCount: documentTeamViewSelectionCount,
  selectedBatchArchivableTeamViewIds: selectedBatchArchivableDocumentTeamViewIds,
  selectedBatchRestorableTeamViewIds: selectedBatchRestorableDocumentTeamViewIds,
  selectedBatchDeletableTeamViewIds: selectedBatchDeletableDocumentTeamViewIds,
  refreshTeamViews: refreshDocumentTeamViews,
  saveTeamView: saveDocumentTeamView,
  applyTeamView: applyDocumentTeamView,
  duplicateTeamView: duplicateDocumentTeamView,
  shareTeamView: shareDocumentTeamView,
  deleteTeamView: deleteDocumentTeamView,
  archiveTeamView: archiveDocumentTeamView,
  restoreTeamView: restoreDocumentTeamView,
  renameTeamView: renameDocumentTeamView,
  transferTeamView: transferDocumentTeamView,
  setTeamViewDefault: setDocumentTeamViewDefault,
  clearTeamViewDefault: clearDocumentTeamViewDefault,
  selectAllTeamViews: selectAllDocumentTeamViews,
  clearTeamViewSelection: clearDocumentTeamViewSelection,
  archiveTeamViewSelection: archiveDocumentTeamViewSelection,
  restoreTeamViewSelection: restoreDocumentTeamViewSelection,
  deleteTeamViewSelection: deleteDocumentTeamViewSelection,
} = usePlmTeamViews({
  kind: 'documents',
  label: '文档',
  getCurrentViewState: () => ({
    role: documentRole.value,
    filter: documentFilter.value,
    sortKey: documentSortKey.value,
    sortDir: documentSortDir.value,
    columns: { ...documentColumns.value },
  }),
  applyViewState: (state) => {
    documentRole.value = state.role
    documentFilter.value = state.filter
    documentSortKey.value = state.sortKey
    documentSortDir.value = state.sortDir
    documentColumns.value = { ...defaultDocumentColumns, ...state.columns }
  },
  setMessage: setDeepLinkMessage,
  requestedViewId: documentTeamViewQuery,
  syncRequestedViewId: (value) => {
    documentTeamViewQuery.value = value || ''
    scheduleQuerySync({ documentTeamView: value || undefined })
  },
  buildShareUrl: (view) => buildPlmWorkbenchTeamViewShareUrl(
    'documents',
    view,
    route.path,
    undefined,
    {
      productId: productId.value,
      itemNumber: productItemNumber.value,
      itemType: itemType.value !== DEFAULT_ITEM_TYPE ? itemType.value : '',
    },
  ),
  copyShareUrl: copyToClipboard,
  shouldAutoApplyDefault: () => (
    !hasExplicitPlmDocumentAutoApplyQueryState(
      applyPlmDeferredRouteQueryPatch(
        route.query as Record<string, unknown>,
        deferredRouteQueryPatch,
      ),
      defaultDocumentColumns,
    )
    && !documentRole.value.trim()
    && !documentFilter.value.trim()
    && documentSortKey.value === 'updated'
    && documentSortDir.value === 'desc'
  ),
})

const activeDocumentRouteView = computed(() => {
  const viewId = documentTeamViewQuery.value.trim()
  if (!viewId) return null
  return documentTeamViews.value.find((entry) => entry.id === viewId) || null
})

watch(
  () => [
    documentTeamViewQuery.value,
    activeDocumentRouteView.value?.id || '',
    JSON.stringify({
      role: documentRole.value,
      filter: documentFilter.value,
      sortKey: documentSortKey.value,
      sortDir: documentSortDir.value,
      columns: { ...documentColumns.value },
    }),
  ],
  ([viewId, activeViewId]) => {
    if (!viewId || !activeViewId) return
    const activeView = activeDocumentRouteView.value
    if (!activeView) return
    if (matchPlmTeamViewStateSnapshot({
      ...pickPlmTeamViewStateKeys(activeView.state, ['role', 'filter', 'sortKey', 'sortDir']),
      columns: mergePlmTeamViewBooleanMapDefaults(defaultDocumentColumns, activeView.state.columns),
    }, {
      role: documentRole.value,
      filter: documentFilter.value,
      sortKey: documentSortKey.value,
      sortDir: documentSortDir.value,
      columns: mergePlmTeamViewBooleanMapDefaults(defaultDocumentColumns, documentColumns.value),
    })) {
      return
    }
    documentTeamViewQuery.value = ''
    scheduleQuerySync({ documentTeamView: undefined })
  },
)

const {
  teamViewKey: cadTeamViewKey,
  teamViewName: cadTeamViewName,
  teamViewOwnerUserId: cadTeamViewOwnerUserId,
  teamViews: cadTeamViews,
  teamViewsLoading: cadTeamViewsLoading,
  teamViewsError: cadTeamViewsError,
  canSaveTeamView: canSaveCadTeamView,
  canApplyTeamView: canApplyCadTeamView,
  showManagementActions: showManageCadTeamViewActions,
  canDuplicateTeamView: canDuplicateCadTeamView,
  canShareTeamView: canShareCadTeamView,
  canDeleteTeamView: canDeleteCadTeamView,
  canArchiveTeamView: canArchiveCadTeamView,
  canRestoreTeamView: canRestoreCadTeamView,
  canRenameTeamView: canRenameCadTeamView,
  canTransferTargetTeamView: canTransferCadTeamViewTarget,
  canTransferTeamView: canTransferCadTeamView,
  canSetTeamViewDefault: canSetCadTeamViewDefault,
  canClearTeamViewDefault: canClearCadTeamViewDefault,
  defaultTeamViewLabel: cadDefaultTeamViewLabel,
  hasManageableTeamViews: hasManageableCadTeamViews,
  showTeamViewManager: showCadTeamViewManager,
  teamViewSelection: cadTeamViewSelection,
  teamViewSelectionCount: cadTeamViewSelectionCount,
  selectedBatchArchivableTeamViewIds: selectedBatchArchivableCadTeamViewIds,
  selectedBatchRestorableTeamViewIds: selectedBatchRestorableCadTeamViewIds,
  selectedBatchDeletableTeamViewIds: selectedBatchDeletableCadTeamViewIds,
  refreshTeamViews: refreshCadTeamViews,
  saveTeamView: saveCadTeamView,
  applyTeamView: applyCadTeamView,
  duplicateTeamView: duplicateCadTeamView,
  shareTeamView: shareCadTeamView,
  deleteTeamView: deleteCadTeamView,
  archiveTeamView: archiveCadTeamView,
  restoreTeamView: restoreCadTeamView,
  renameTeamView: renameCadTeamView,
  transferTeamView: transferCadTeamView,
  setTeamViewDefault: setCadTeamViewDefault,
  clearTeamViewDefault: clearCadTeamViewDefault,
  selectAllTeamViews: selectAllCadTeamViews,
  clearTeamViewSelection: clearCadTeamViewSelection,
  archiveTeamViewSelection: archiveCadTeamViewSelection,
  restoreTeamViewSelection: restoreCadTeamViewSelection,
  deleteTeamViewSelection: deleteCadTeamViewSelection,
} = usePlmTeamViews({
  kind: 'cad',
  label: 'CAD',
  getCurrentViewState: () => ({
    fileId: cadFileId.value,
    otherFileId: cadOtherFileId.value,
    reviewState: cadReviewState.value,
    reviewNote: cadReviewNote.value,
  }),
  applyViewState: (state) => {
    cadFileId.value = state.fileId
    cadOtherFileId.value = state.otherFileId
    cadReviewState.value = state.reviewState
    cadReviewNote.value = state.reviewNote
  },
  setMessage: setDeepLinkMessage,
  requestedViewId: cadTeamViewQuery,
  syncRequestedViewId: (value) => {
    cadTeamViewQuery.value = value || ''
    scheduleQuerySync({ cadTeamView: value || undefined })
  },
  buildShareUrl: (view) => buildPlmWorkbenchTeamViewShareUrl('cad', view, route.path),
  copyShareUrl: copyToClipboard,
  shouldAutoApplyDefault: () => (
    !hasExplicitPlmCadAutoApplyQueryState(
      applyPlmDeferredRouteQueryPatch(
        route.query as Record<string, unknown>,
        deferredRouteQueryPatch,
      ),
    )
    && !cadFileId.value.trim()
    && !cadOtherFileId.value.trim()
    && !cadReviewState.value.trim()
    && !cadReviewNote.value.trim()
  ),
})

const activeCadRouteView = computed(() => {
  const viewId = cadTeamViewQuery.value.trim()
  if (!viewId) return null
  return cadTeamViews.value.find((entry) => entry.id === viewId) || null
})

watch(
  () => [
    cadTeamViewQuery.value,
    activeCadRouteView.value?.id || '',
    JSON.stringify({
      fileId: cadFileId.value,
      otherFileId: cadOtherFileId.value,
      reviewState: cadReviewState.value,
      reviewNote: cadReviewNote.value,
    }),
  ],
  ([viewId, activeViewId]) => {
    if (!viewId || !activeViewId) return
    const activeView = activeCadRouteView.value
    if (!activeView) return
    if (matchPlmTeamViewStateSnapshot(
      pickPlmTeamViewStateKeys(activeView.state, ['fileId', 'otherFileId', 'reviewState', 'reviewNote']),
      {
      fileId: cadFileId.value,
      otherFileId: cadOtherFileId.value,
      reviewState: cadReviewState.value,
      reviewNote: cadReviewNote.value,
    },
    )) {
      return
    }
    cadTeamViewQuery.value = ''
    scheduleQuerySync({ cadTeamView: undefined })
  },
)

const {
  teamViewKey: approvalsTeamViewKey,
  teamViewName: approvalsTeamViewName,
  teamViewOwnerUserId: approvalsTeamViewOwnerUserId,
  teamViews: approvalsTeamViews,
  teamViewsLoading: approvalsTeamViewsLoading,
  teamViewsError: approvalsTeamViewsError,
  canSaveTeamView: canSaveApprovalsTeamView,
  canApplyTeamView: canApplyApprovalsTeamView,
  showManagementActions: showManageApprovalsTeamViewActions,
  canDuplicateTeamView: canDuplicateApprovalsTeamView,
  canShareTeamView: canShareApprovalsTeamView,
  canDeleteTeamView: canDeleteApprovalsTeamView,
  canArchiveTeamView: canArchiveApprovalsTeamView,
  canRestoreTeamView: canRestoreApprovalsTeamView,
  canRenameTeamView: canRenameApprovalsTeamView,
  canTransferTargetTeamView: canTransferApprovalsTeamViewTarget,
  canTransferTeamView: canTransferApprovalsTeamView,
  canSetTeamViewDefault: canSetApprovalsTeamViewDefault,
  canClearTeamViewDefault: canClearApprovalsTeamViewDefault,
  defaultTeamViewLabel: approvalsDefaultTeamViewLabel,
  hasManageableTeamViews: hasManageableApprovalsTeamViews,
  showTeamViewManager: showApprovalsTeamViewManager,
  teamViewSelection: approvalsTeamViewSelection,
  teamViewSelectionCount: approvalsTeamViewSelectionCount,
  selectedBatchArchivableTeamViewIds: selectedBatchArchivableApprovalsTeamViewIds,
  selectedBatchRestorableTeamViewIds: selectedBatchRestorableApprovalsTeamViewIds,
  selectedBatchDeletableTeamViewIds: selectedBatchDeletableApprovalsTeamViewIds,
  refreshTeamViews: refreshApprovalsTeamViews,
  saveTeamView: saveApprovalsTeamView,
  applyTeamView: applyApprovalsTeamView,
  duplicateTeamView: duplicateApprovalsTeamView,
  shareTeamView: shareApprovalsTeamView,
  deleteTeamView: deleteApprovalsTeamView,
  archiveTeamView: archiveApprovalsTeamView,
  restoreTeamView: restoreApprovalsTeamView,
  renameTeamView: renameApprovalsTeamView,
  transferTeamView: transferApprovalsTeamView,
  setTeamViewDefault: setApprovalsTeamViewDefault,
  clearTeamViewDefault: clearApprovalsTeamViewDefault,
  selectAllTeamViews: selectAllApprovalsTeamViews,
  clearTeamViewSelection: clearApprovalsTeamViewSelection,
  archiveTeamViewSelection: archiveApprovalsTeamViewSelection,
  restoreTeamViewSelection: restoreApprovalsTeamViewSelection,
  deleteTeamViewSelection: deleteApprovalsTeamViewSelection,
} = usePlmTeamViews({
  kind: 'approvals',
  label: '审批',
  getCurrentViewState: () => ({
    status: approvalsStatus.value,
    filter: approvalsFilter.value,
    sortKey: approvalSortKey.value,
    sortDir: approvalSortDir.value,
    columns: { ...approvalColumns.value },
  }),
  applyViewState: (state) => {
    approvalsStatus.value = state.status
    approvalsFilter.value = state.filter
    approvalSortKey.value = state.sortKey
    approvalSortDir.value = state.sortDir
    approvalColumns.value = { ...defaultApprovalColumns, ...state.columns }
  },
  setMessage: setDeepLinkMessage,
  requestedViewId: approvalsTeamViewQuery,
  syncRequestedViewId: (value) => {
    approvalsTeamViewQuery.value = value || ''
    scheduleQuerySync({ approvalsTeamView: value || undefined })
  },
  buildShareUrl: (view) => buildPlmWorkbenchTeamViewShareUrl(
    'approvals',
    view,
    route.path,
    undefined,
    {
      productId: productId.value,
      itemNumber: productItemNumber.value,
      itemType: itemType.value !== DEFAULT_ITEM_TYPE ? itemType.value : '',
    },
  ),
  copyShareUrl: copyToClipboard,
  shouldAutoApplyDefault: () => (
    !hasExplicitPlmApprovalsAutoApplyQueryState(
      applyPlmDeferredRouteQueryPatch(
        route.query as Record<string, unknown>,
        deferredRouteQueryPatch,
      ),
      defaultApprovalColumns,
    )
    && approvalsStatus.value === DEFAULT_APPROVAL_STATUS
    && !approvalsFilter.value.trim()
    && approvalSortKey.value === 'created'
    && approvalSortDir.value === 'desc'
  ),
})

const activeApprovalsRouteView = computed(() => {
  const viewId = approvalsTeamViewQuery.value.trim()
  if (!viewId) return null
  return approvalsTeamViews.value.find((entry) => entry.id === viewId) || null
})

watch(
  () => [
    approvalsTeamViewQuery.value,
    activeApprovalsRouteView.value?.id || '',
    JSON.stringify({
      status: approvalsStatus.value,
      filter: approvalsFilter.value,
      sortKey: approvalSortKey.value,
      sortDir: approvalSortDir.value,
      columns: { ...approvalColumns.value },
    }),
  ],
  ([viewId, activeViewId]) => {
    if (!viewId || !activeViewId) return
    const activeView = activeApprovalsRouteView.value
    if (!activeView) return
    if (matchPlmTeamViewStateSnapshot({
      ...pickPlmTeamViewStateKeys(activeView.state, ['status', 'filter', 'sortKey', 'sortDir']),
      columns: mergePlmTeamViewBooleanMapDefaults(defaultApprovalColumns, activeView.state.columns),
    }, {
      status: approvalsStatus.value,
      filter: approvalsFilter.value,
      sortKey: approvalSortKey.value,
      sortDir: approvalSortDir.value,
      columns: mergePlmTeamViewBooleanMapDefaults(defaultApprovalColumns, approvalColumns.value),
    })) {
      return
    }
    approvalsTeamViewQuery.value = ''
    scheduleQuerySync({ approvalsTeamView: undefined })
  },
)

function formatDeepLinkTargets(panel?: string): string {
  if (panel) {
    const selected = Array.from(parseDeepLinkPanels(panel)).filter((entry) => entry !== 'all')
    if (selected.length) {
      return selected.map((entry) => deepLinkPanelLabels[entry] || entry).join(' / ')
    }
  }

  const hasDocumentsState =
    Boolean(documentRole.value.trim())
    || Boolean(documentFilter.value.trim())
    || documentSortKey.value !== 'updated'
    || documentSortDir.value !== 'desc'
    || !areColumnStatesEqual(documentColumns.value, defaultDocumentColumns)

  const hasCadState =
    Boolean(cadFileId.value.trim())
    || Boolean(cadOtherFileId.value.trim())
    || Boolean(cadReviewState.value.trim())
    || Boolean(cadReviewNote.value.trim())

  const hasApprovalsState =
    approvalsStatus.value !== DEFAULT_APPROVAL_STATUS
    || Boolean(approvalsFilter.value.trim())
    || approvalSortKey.value !== 'created'
    || approvalSortDir.value !== 'desc'
    || !areColumnStatesEqual(approvalColumns.value, defaultApprovalColumns)

  const targets = []
  if (searchQuery.value) targets.push(deepLinkPanelLabels.search)
  if (productId.value || productItemNumber.value) targets.push(deepLinkPanelLabels.product)
  if (hasDocumentsState) targets.push(deepLinkPanelLabels.documents)
  if (hasApprovalsState) {
    targets.push(deepLinkPanelLabels.approvals)
  }
  if (hasCadState) targets.push(deepLinkPanelLabels.cad)
  if (whereUsedItemId.value) targets.push(deepLinkPanelLabels['where-used'])
  if (compareLeftId.value && compareRightId.value) targets.push(deepLinkPanelLabels.compare)
  if (bomLineId.value) targets.push(deepLinkPanelLabels.substitutes)
  return targets.length ? targets.join(' / ') : deepLinkPanelLabels.all
}

function buildDeepLinkParams(includeAutoload: boolean, panelOverride?: string): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {}
  const append = (key: string, value: string | number | boolean | undefined | null) => {
    if (value === undefined || value === null || value === '') return
    params[key] = value
  }
  const resolvedPanel = normalizePlmWorkbenchPanelScope(panelOverride ?? readQueryParam('panel'))

  append('searchQuery', searchQuery.value)
  append('searchItemType', searchItemType.value !== DEFAULT_ITEM_TYPE ? searchItemType.value : undefined)
  append('searchLimit', searchLimit.value !== DEFAULT_SEARCH_LIMIT ? searchLimit.value : undefined)
  append('workbenchTeamView', workbenchTeamViewQuery.value)
  append('productId', productId.value)
  append('itemNumber', productItemNumber.value)
  append('itemType', itemType.value !== DEFAULT_ITEM_TYPE ? itemType.value : undefined)
  append('documentTeamView', documentTeamViewQuery.value)
  append('cadTeamView', cadTeamViewQuery.value)
  append('approvalsTeamView', approvalsTeamViewQuery.value)
  append('cadFileId', cadFileId.value)
  append('cadOtherFileId', cadOtherFileId.value)
  append('cadReviewState', cadReviewState.value)
  append('cadReviewNote', cadReviewNote.value)
  append('documentRole', documentRole.value)
  append('documentFilter', documentFilter.value)
  append('documentSort', documentSortKey.value !== 'updated' ? documentSortKey.value : undefined)
  append('documentSortDir', documentSortDir.value !== 'desc' ? documentSortDir.value : undefined)
  append('documentColumns', serializeColumnQuery(documentColumns.value, defaultDocumentColumns))
  append('approvalsStatus', approvalsStatus.value !== DEFAULT_APPROVAL_STATUS ? approvalsStatus.value : undefined)
  append('approvalsFilter', approvalsFilter.value)
  append('approvalSort', approvalSortKey.value !== 'created' ? approvalSortKey.value : undefined)
  append('approvalSortDir', approvalSortDir.value !== 'desc' ? approvalSortDir.value : undefined)
  append('approvalColumns', serializeColumnQuery(approvalColumns.value, defaultApprovalColumns))
  append('whereUsedItemId', whereUsedItemId.value)
  append('whereUsedRecursive', whereUsedRecursive.value !== true ? whereUsedRecursive.value : undefined)
  append('whereUsedMaxLevels', whereUsedMaxLevels.value !== DEFAULT_WHERE_USED_MAX_LEVELS ? whereUsedMaxLevels.value : undefined)
  append('whereUsedFilterPreset', whereUsedFilterPresetQuery.value)
  append('whereUsedTeamPreset', whereUsedTeamPresetQuery.value)
  append('whereUsedFilter', whereUsedFilter.value)
  append(
    'whereUsedFilterField',
    resolvePlmFilterFieldQueryValue(whereUsedFilter.value, whereUsedFilterField.value),
  )
  append('bomDepth', bomDepth.value !== DEFAULT_BOM_DEPTH ? bomDepth.value : undefined)
  append('bomEffectiveAt', bomEffectiveAt.value)
  append('bomFilterPreset', bomFilterPresetQuery.value)
  append('bomTeamPreset', bomTeamPresetQuery.value)
  append('bomFilter', bomFilter.value)
  append(
    'bomFilterField',
    resolvePlmFilterFieldQueryValue(bomFilter.value, bomFilterField.value),
  )
  append('bomView', bomView.value !== 'table' ? bomView.value : undefined)
  if (bomView.value === 'tree' && bomCollapsed.value.size) {
    const collapsedValue = serializeBomCollapsed(bomCollapsed.value)
    append('bomCollapsed', collapsedValue)
  }
  append('compareLeftId', compareLeftId.value)
  append('compareRightId', compareRightId.value)
  append('compareMode', compareMode.value)
  append('compareLineKey', compareLineKey.value !== DEFAULT_COMPARE_LINE_KEY ? compareLineKey.value : undefined)
  append('compareMaxLevels', compareMaxLevels.value !== DEFAULT_COMPARE_MAX_LEVELS ? compareMaxLevels.value : undefined)
  append('compareIncludeChildFields', compareIncludeChildFields.value !== true ? compareIncludeChildFields.value : undefined)
  append('compareIncludeSubstitutes', compareIncludeSubstitutes.value !== false ? compareIncludeSubstitutes.value : undefined)
  append('compareIncludeEffectivity', compareIncludeEffectivity.value !== false ? compareIncludeEffectivity.value : undefined)
  append('compareSync', compareSyncEnabled.value !== true ? compareSyncEnabled.value : undefined)
  append('compareEffectiveAt', compareEffectiveAt.value)
  append('compareRelationshipProps', compareRelationshipProps.value !== DEFAULT_COMPARE_REL_PROPS ? compareRelationshipProps.value : undefined)
  append('compareFilter', compareFilter.value)
  append('bomLineId', bomLineId.value)
  append('substitutesFilter', substitutesFilter.value)
  append('panel', resolvedPanel)

  if (includeAutoload && shouldAutoloadPlmWorkbenchSnapshot(params as Record<string, string>)) {
    params.autoload = true
  }

  return params
}

function buildDeepLinkUrl(panelOverride?: string): string {
  if (typeof window === 'undefined') return ''
  const base = `${window.location.origin}${route.path}`
  const params = normalizePlmWorkbenchLocalRouteQuerySnapshot(
    buildDeepLinkParams(true, panelOverride),
  )
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    search.set(key, String(value))
  }
  const query = search.toString()
  return query ? `${base}?${query}` : base
}

function applyHydratedTeamViewOwnerTakeover(options: {
  routeOwnerId: string
  teamViewKey: { value: string }
  teamViewName: { value: string }
  teamViewOwnerUserId: { value: string }
  teamViewSelection: { value: string[] }
}) {
  const takeover = resolvePlmHydratedTeamViewOwnerTakeover({
    routeOwnerId: options.routeOwnerId,
    localSelectorId: options.teamViewKey.value,
    localNameDraft: options.teamViewName.value,
    localOwnerUserIdDraft: options.teamViewOwnerUserId.value,
    localSelectionIds: options.teamViewSelection.value,
  })
  if (!takeover.shouldClearLocalSelector) return
  options.teamViewKey.value = takeover.nextSelectorId
  options.teamViewName.value = takeover.nextNameDraft
  options.teamViewOwnerUserId.value = takeover.nextOwnerUserIdDraft
  options.teamViewSelection.value = takeover.nextSelectionIds
}

function applyHydratedRemovedTeamViewOwner(options: {
  removedRouteOwnerId: string
  teamViewQuery: { value: string }
  teamViewKey: { value: string }
  teamViewName: { value: string }
  teamViewOwnerUserId: { value: string }
  teamViewSelection: { value: string[] }
}) {
  const takeover = resolvePlmHydratedRemovedTeamViewOwner({
    removedRouteOwnerId: options.removedRouteOwnerId,
    localSelectorId: options.teamViewKey.value,
    localNameDraft: options.teamViewName.value,
    localOwnerUserIdDraft: options.teamViewOwnerUserId.value,
    localSelectionIds: options.teamViewSelection.value,
  })
  options.teamViewQuery.value = ''
  if (!takeover.shouldClearLocalSelector) return
  options.teamViewKey.value = takeover.nextSelectorId
  options.teamViewName.value = takeover.nextNameDraft
  options.teamViewOwnerUserId.value = takeover.nextOwnerUserIdDraft
  options.teamViewSelection.value = takeover.nextSelectionIds
}

function applyHydratedTeamPresetOwnerTakeover(options: {
  routeOwnerId: string
  teamPresetKey: { value: string }
  teamPresetName: { value: string }
  teamPresetGroup: { value: string }
  teamPresetOwnerUserId: { value: string }
  teamPresetSelection: { value: string[] }
}) {
  const takeover = resolvePlmHydratedTeamPresetOwnerTakeover({
    routeOwnerId: options.routeOwnerId,
    localSelectorId: options.teamPresetKey.value,
    localNameDraft: options.teamPresetName.value,
    localGroupDraft: options.teamPresetGroup.value,
    localOwnerUserIdDraft: options.teamPresetOwnerUserId.value,
    localSelectionIds: options.teamPresetSelection.value,
  })
  if (!takeover.shouldClearLocalSelector) return
  options.teamPresetKey.value = takeover.nextSelectorId
  options.teamPresetName.value = takeover.nextNameDraft
  options.teamPresetGroup.value = takeover.nextGroupDraft
  options.teamPresetOwnerUserId.value = takeover.nextOwnerUserIdDraft
  options.teamPresetSelection.value = takeover.nextSelectionIds
}

function applyHydratedRemovedTeamPresetOwner(options: {
  removedRouteOwnerId: string
  teamPresetQuery: { value: string }
  teamPresetKey: { value: string }
  teamPresetName: { value: string }
  teamPresetGroup: { value: string }
  teamPresetOwnerUserId: { value: string }
  teamPresetSelection: { value: string[] }
}) {
  const takeover = resolvePlmHydratedRemovedTeamPresetOwner({
    removedRouteOwnerId: options.removedRouteOwnerId,
    localSelectorId: options.teamPresetKey.value,
    localNameDraft: options.teamPresetName.value,
    localGroupDraft: options.teamPresetGroup.value,
    localOwnerUserIdDraft: options.teamPresetOwnerUserId.value,
    localSelectionIds: options.teamPresetSelection.value,
  })
  options.teamPresetQuery.value = ''
  if (!takeover.shouldClearLocalSelector) return
  options.teamPresetKey.value = takeover.nextSelectorId
  options.teamPresetName.value = takeover.nextNameDraft
  options.teamPresetGroup.value = takeover.nextGroupDraft
  options.teamPresetOwnerUserId.value = takeover.nextOwnerUserIdDraft
  options.teamPresetSelection.value = takeover.nextSelectionIds
}

function applyHydratedPanelDataReset(options: {
  previousRouteState: PlmHydratedPanelDataRouteState
  nextRouteState: PlmHydratedPanelDataRouteState
}) {
  const reset = resolvePlmHydratedPanelDataReset(options)
  if (reset.clearSearch) {
    searchResults.value = []
    searchTotal.value = 0
    searchError.value = ''
  }
  if (reset.clearProduct) {
    product.value = null
    productLoading.value = false
    productError.value = ''
    productMetadata.value = null
    productMetadataLoading.value = false
    productMetadataError.value = ''
  }
  if (reset.clearBom) {
    bomItems.value = []
    bomLoading.value = false
    bomError.value = ''
    clearBomSelection()
  }
  if (reset.clearDocuments) {
    documents.value = []
    documentsLoading.value = false
    documentsError.value = ''
    documentsWarning.value = ''
  }
  if (reset.clearCad) {
    cadProperties.value = null
    cadViewState.value = null
    cadReview.value = null
    cadHistory.value = null
    cadDiff.value = null
    cadMeshStats.value = null
    cadPropertiesDraft.value = ''
    cadViewStateDraft.value = ''
    cadReviewState.value = ''
    cadReviewNote.value = ''
    cadLoading.value = false
    cadDiffLoading.value = false
    cadUpdating.value = false
    cadStatus.value = ''
    cadError.value = ''
    cadActionStatus.value = ''
    cadActionError.value = ''
  }
  if (reset.clearApprovals) {
    approvals.value = []
    approvalsLoading.value = false
    approvalsError.value = ''
    approvalActionStatus.value = ''
    approvalActionError.value = ''
    approvalActingId.value = ''
    approvalActionabilityById.value = {}
    approvalActionabilityLoadingById.value = {}
    approvalActionabilityActorKey.value = ''
    approvalHistoryFor.value = ''
    approvalHistoryLabel.value = ''
    approvalHistory.value = []
    approvalHistoryLoading.value = false
    approvalHistoryError.value = ''
  }
  if (reset.clearWhereUsed) {
    whereUsed.value = null
    whereUsedLoading.value = false
    whereUsedError.value = ''
    clearWhereUsedSelection()
  }
  if (reset.clearCompare) {
    bomCompare.value = null
    compareLoading.value = false
    compareError.value = ''
    clearCompareSelection()
  }
  if (reset.clearSubstitutes) {
    substitutes.value = null
    substitutesLoading.value = false
    substitutesError.value = ''
    substituteItemId.value = ''
    substituteRank.value = ''
    substituteNote.value = ''
    substitutesActionStatus.value = ''
    substitutesActionError.value = ''
    substitutesMutating.value = false
    substitutesDeletingId.value = null
  }
}

async function applyQueryState() {
  if (isApplyingRouteQueryState.value) {
    pendingRouteQueryHydration = true
    return
  }

  isApplyingRouteQueryState.value = true

  try {
    const previousHydratedRouteQuery = {
      workbenchTeamView: workbenchTeamViewQuery.value,
      documentTeamView: documentTeamViewQuery.value,
      cadTeamView: cadTeamViewQuery.value,
      approvalsTeamView: approvalsTeamViewQuery.value,
      whereUsedFilterPreset: whereUsedFilterPresetQuery.value,
      whereUsedTeamPreset: whereUsedTeamPresetQuery.value,
      bomFilterPreset: bomFilterPresetQuery.value,
      bomTeamPreset: bomTeamPresetQuery.value,
    }
    const previousHydratedPanelDataRouteState: PlmHydratedPanelDataRouteState = {
      searchQuery: searchQuery.value,
      searchItemType: searchItemType.value,
      searchLimit: searchLimit.value,
      productId: productId.value,
      itemNumber: productItemNumber.value,
      itemType: itemType.value,
      bomDepth: bomDepth.value,
      bomEffectiveAt: bomEffectiveAt.value,
      documentRole: documentRole.value,
      approvalsStatus: approvalsStatus.value,
      cadFileId: cadFileId.value,
      cadOtherFileId: cadOtherFileId.value,
      whereUsedItemId: whereUsedItemId.value,
      whereUsedRecursive: whereUsedRecursive.value,
      whereUsedMaxLevels: whereUsedMaxLevels.value,
      compareLeftId: compareLeftId.value,
      compareRightId: compareRightId.value,
      compareMode: compareMode.value,
      compareLineKey: compareLineKey.value,
      compareMaxLevels: compareMaxLevels.value,
      compareIncludeChildFields: compareIncludeChildFields.value,
      compareIncludeSubstitutes: compareIncludeSubstitutes.value,
      compareIncludeEffectivity: compareIncludeEffectivity.value,
      compareEffectiveAt: compareEffectiveAt.value,
      compareRelationshipProps: compareRelationshipProps.value,
      bomLineId: bomLineId.value,
    }
    productId.value = ''
    productItemNumber.value = ''
    itemType.value = DEFAULT_ITEM_TYPE
    searchQuery.value = ''
    searchItemType.value = DEFAULT_ITEM_TYPE
    searchLimit.value = DEFAULT_SEARCH_LIMIT
    workbenchTeamViewQuery.value = ''
    sceneCatalogAutoFocusSceneId.value = ''
    documentTeamViewQuery.value = ''
    cadTeamViewQuery.value = ''
    approvalsTeamViewQuery.value = ''
    documentRole.value = ''
    documentFilter.value = ''
    documentSortKey.value = 'updated'
    documentSortDir.value = 'desc'
    documentColumns.value = loadStoredColumns(DOCUMENT_COLUMNS_STORAGE_KEY, defaultDocumentColumns)
    cadFileId.value = ''
    cadOtherFileId.value = ''
    cadReviewState.value = ''
    cadReviewNote.value = ''
    approvalsStatus.value = DEFAULT_APPROVAL_STATUS
    approvalsFilter.value = ''
    approvalComment.value = ''
    approvalSortKey.value = 'created'
    approvalSortDir.value = 'desc'
    approvalColumns.value = loadStoredColumns(APPROVAL_COLUMNS_STORAGE_KEY, defaultApprovalColumns)
    whereUsedItemId.value = ''
    whereUsedRecursive.value = true
    whereUsedMaxLevels.value = DEFAULT_WHERE_USED_MAX_LEVELS
    whereUsedFilterPresetQuery.value = ''
    whereUsedTeamPresetQuery.value = ''
    whereUsedFilter.value = ''
    whereUsedFilterField.value = 'all'
    bomDepth.value = DEFAULT_BOM_DEPTH
    bomEffectiveAt.value = ''
    bomFilterPresetQuery.value = ''
    bomTeamPresetQuery.value = ''
    bomFilter.value = ''
    bomFilterField.value = 'all'
    bomView.value = 'table'
    bomCollapsed.value = new Set()
    compareLeftId.value = ''
    compareRightId.value = ''
    compareMode.value = ''
    compareLineKey.value = DEFAULT_COMPARE_LINE_KEY
    compareMaxLevels.value = DEFAULT_COMPARE_MAX_LEVELS
    compareEffectiveAt.value = ''
    compareRelationshipProps.value = DEFAULT_COMPARE_REL_PROPS
    compareFilter.value = ''
    compareIncludeChildFields.value = true
    compareIncludeSubstitutes.value = false
    compareIncludeEffectivity.value = false
    compareSyncEnabled.value = true
    bomLineId.value = ''
    substitutesFilter.value = ''
    const productParam = readQueryParam('productId')
    if (productParam !== undefined) {
      productId.value = productParam
    }
    const itemNumberParam = readQueryParam('itemNumber')
    if (itemNumberParam !== undefined) {
      productItemNumber.value = itemNumberParam
    }
    const itemTypeParam = readQueryParam('itemType')
    if (itemTypeParam !== undefined) {
      itemType.value = itemTypeParam || DEFAULT_ITEM_TYPE
    }
    const searchQueryParam = readQueryParam('searchQuery')
    if (searchQueryParam !== undefined) {
      searchQuery.value = searchQueryParam
    }
    const searchItemTypeParam = readQueryParam('searchItemType')
    if (searchItemTypeParam !== undefined) {
      searchItemType.value = searchItemTypeParam || DEFAULT_ITEM_TYPE
    }
    const searchLimitParam = parseQueryNumber(readQueryParam('searchLimit'))
    if (searchLimitParam !== undefined) {
      const clamped = Math.min(50, Math.max(1, Math.floor(searchLimitParam)))
      searchLimit.value = clamped
    }
    const workbenchTeamViewParam = readQueryParam('workbenchTeamView')
    const workbenchTeamViewTransition = resolvePlmHydratedRouteQueryTransition({
      previousRouteValue: previousHydratedRouteQuery.workbenchTeamView,
      nextRouteValue: workbenchTeamViewParam,
    })
    if (workbenchTeamViewTransition.kind === 'apply') {
      applyHydratedTeamViewOwnerTakeover({
        routeOwnerId: workbenchTeamViewTransition.routeValue,
        teamViewKey: workbenchTeamViewKey,
        teamViewName: workbenchTeamViewName,
        teamViewOwnerUserId: workbenchTeamViewOwnerUserId,
        teamViewSelection: workbenchTeamViewSelection,
      })
      workbenchTeamViewQuery.value = workbenchTeamViewTransition.routeValue
    } else if (workbenchTeamViewTransition.kind === 'remove') {
      applyHydratedRemovedTeamViewOwner({
        removedRouteOwnerId: workbenchTeamViewTransition.removedRouteValue,
        teamViewQuery: workbenchTeamViewQuery,
        teamViewKey: workbenchTeamViewKey,
        teamViewName: workbenchTeamViewName,
        teamViewOwnerUserId: workbenchTeamViewOwnerUserId,
        teamViewSelection: workbenchTeamViewSelection,
      })
    }
    const sceneFocus = readWorkbenchSceneFocus(route.query)
    sceneCatalogAutoFocusSceneId.value = sceneFocus || ''
    const documentTeamViewParam = readQueryParam('documentTeamView')
    const documentTeamViewTransition = resolvePlmHydratedRouteQueryTransition({
      previousRouteValue: previousHydratedRouteQuery.documentTeamView,
      nextRouteValue: documentTeamViewParam,
    })
    if (documentTeamViewTransition.kind === 'apply') {
      applyHydratedTeamViewOwnerTakeover({
        routeOwnerId: documentTeamViewTransition.routeValue,
        teamViewKey: documentTeamViewKey,
        teamViewName: documentTeamViewName,
        teamViewOwnerUserId: documentTeamViewOwnerUserId,
        teamViewSelection: documentTeamViewSelection,
      })
      documentTeamViewQuery.value = documentTeamViewTransition.routeValue
    } else if (documentTeamViewTransition.kind === 'remove') {
      applyHydratedRemovedTeamViewOwner({
        removedRouteOwnerId: documentTeamViewTransition.removedRouteValue,
        teamViewQuery: documentTeamViewQuery,
        teamViewKey: documentTeamViewKey,
        teamViewName: documentTeamViewName,
        teamViewOwnerUserId: documentTeamViewOwnerUserId,
        teamViewSelection: documentTeamViewSelection,
      })
    }
    const cadTeamViewParam = readQueryParam('cadTeamView')
    const cadTeamViewTransition = resolvePlmHydratedRouteQueryTransition({
      previousRouteValue: previousHydratedRouteQuery.cadTeamView,
      nextRouteValue: cadTeamViewParam,
    })
    if (cadTeamViewTransition.kind === 'apply') {
      applyHydratedTeamViewOwnerTakeover({
        routeOwnerId: cadTeamViewTransition.routeValue,
        teamViewKey: cadTeamViewKey,
        teamViewName: cadTeamViewName,
        teamViewOwnerUserId: cadTeamViewOwnerUserId,
        teamViewSelection: cadTeamViewSelection,
      })
      cadTeamViewQuery.value = cadTeamViewTransition.routeValue
    } else if (cadTeamViewTransition.kind === 'remove') {
      applyHydratedRemovedTeamViewOwner({
        removedRouteOwnerId: cadTeamViewTransition.removedRouteValue,
        teamViewQuery: cadTeamViewQuery,
        teamViewKey: cadTeamViewKey,
        teamViewName: cadTeamViewName,
        teamViewOwnerUserId: cadTeamViewOwnerUserId,
        teamViewSelection: cadTeamViewSelection,
      })
    }
    const approvalsTeamViewParam = readQueryParam('approvalsTeamView')
    const approvalsTeamViewTransition = resolvePlmHydratedRouteQueryTransition({
      previousRouteValue: previousHydratedRouteQuery.approvalsTeamView,
      nextRouteValue: approvalsTeamViewParam,
    })
    if (approvalsTeamViewTransition.kind === 'apply') {
      applyHydratedTeamViewOwnerTakeover({
        routeOwnerId: approvalsTeamViewTransition.routeValue,
        teamViewKey: approvalsTeamViewKey,
        teamViewName: approvalsTeamViewName,
        teamViewOwnerUserId: approvalsTeamViewOwnerUserId,
        teamViewSelection: approvalsTeamViewSelection,
      })
      approvalsTeamViewQuery.value = approvalsTeamViewTransition.routeValue
    } else if (approvalsTeamViewTransition.kind === 'remove') {
      applyHydratedRemovedTeamViewOwner({
        removedRouteOwnerId: approvalsTeamViewTransition.removedRouteValue,
        teamViewQuery: approvalsTeamViewQuery,
        teamViewKey: approvalsTeamViewKey,
        teamViewName: approvalsTeamViewName,
        teamViewOwnerUserId: approvalsTeamViewOwnerUserId,
        teamViewSelection: approvalsTeamViewSelection,
      })
    }
    const documentRoleParam = readQueryParam('documentRole')
    if (documentRoleParam !== undefined) {
      documentRole.value = documentRoleParam
    }
    const documentFilterParam = readQueryParam('documentFilter')
    if (documentFilterParam !== undefined) {
      documentFilter.value = documentFilterParam
    }
    const documentSortParam = readQueryParam('documentSort')
    if (documentSortParam !== undefined) {
      const normalized = documentSortParam.trim().toLowerCase()
      if (['updated', 'created', 'name', 'type', 'revision', 'role', 'mime', 'size'].includes(normalized)) {
        documentSortKey.value = normalized as typeof documentSortKey.value
      }
    }
    const documentSortDirParam = readQueryParam('documentSortDir')
    if (documentSortDirParam !== undefined) {
      const normalized = documentSortDirParam.trim().toLowerCase()
      if (normalized === 'asc' || normalized === 'desc') {
        documentSortDir.value = normalized as typeof documentSortDir.value
      }
    }
    const documentColumnsParam = parseColumnQuery(readQueryParam('documentColumns'), defaultDocumentColumns)
    if (documentColumnsParam) {
      documentColumns.value = documentColumnsParam
    }
    const cadFileParam = readQueryParam('cadFileId')
    if (cadFileParam !== undefined) {
      cadFileId.value = cadFileParam
    }
    const cadOtherParam = readQueryParam('cadOtherFileId')
    if (cadOtherParam !== undefined) {
      cadOtherFileId.value = cadOtherParam
    }
    const cadReviewStateParam = readQueryParam('cadReviewState')
    if (cadReviewStateParam !== undefined) {
      cadReviewState.value = cadReviewStateParam
    }
    const cadReviewNoteParam = readQueryParam('cadReviewNote')
    if (cadReviewNoteParam !== undefined) {
      cadReviewNote.value = cadReviewNoteParam
    }
    const approvalsStatusParam = readQueryParam('approvalsStatus')
    if (approvalsStatusParam !== undefined) {
      const normalized = approvalsStatusParam.trim().toLowerCase()
      if (['all', 'pending', 'approved', 'rejected'].includes(normalized)) {
        approvalsStatus.value = normalized as typeof approvalsStatus.value
      }
    }
    const approvalsFilterParam = readQueryParam('approvalsFilter')
    if (approvalsFilterParam !== undefined) {
      approvalsFilter.value = approvalsFilterParam
    }
    if (readQueryParam('approvalComment') !== undefined) {
      scheduleQuerySync(
        buildPlmWorkbenchLegacyLocalDraftQueryPatch(route.query as Record<string, unknown>),
      )
    }
    const approvalSortParam = readQueryParam('approvalSort')
    if (approvalSortParam !== undefined) {
      const normalized = approvalSortParam.trim().toLowerCase()
      if (['created', 'title', 'status', 'requester', 'product'].includes(normalized)) {
        approvalSortKey.value = normalized as typeof approvalSortKey.value
      }
    }
    const approvalSortDirParam = readQueryParam('approvalSortDir')
    if (approvalSortDirParam !== undefined) {
      const normalized = approvalSortDirParam.trim().toLowerCase()
      if (normalized === 'asc' || normalized === 'desc') {
        approvalSortDir.value = normalized as typeof approvalSortDir.value
      }
    }
    const approvalColumnsParam = parseColumnQuery(readQueryParam('approvalColumns'), defaultApprovalColumns)
    if (approvalColumnsParam) {
      approvalColumns.value = approvalColumnsParam
    }
    if (['valid', 'expiring'].includes(authState.value)) {
      const teamViewRefreshTasks: Array<Promise<void>> = []
      if (workbenchTeamViewQuery.value) {
        teamViewRefreshTasks.push(refreshWorkbenchTeamViews())
      }
      if (documentTeamViewQuery.value) {
        teamViewRefreshTasks.push(refreshDocumentTeamViews())
      }
      if (cadTeamViewQuery.value) {
        teamViewRefreshTasks.push(refreshCadTeamViews())
      }
      if (approvalsTeamViewQuery.value) {
        teamViewRefreshTasks.push(refreshApprovalsTeamViews())
      }
      if (teamViewRefreshTasks.length) {
        await Promise.all(teamViewRefreshTasks)
      }
    }
    const whereUsedParam = readQueryParam('whereUsedItemId')
    if (whereUsedParam !== undefined) {
      whereUsedItemId.value = whereUsedParam
    }
    const whereUsedRecursiveParam = parseQueryBoolean(readQueryParam('whereUsedRecursive'))
    if (whereUsedRecursiveParam !== undefined) {
      whereUsedRecursive.value = whereUsedRecursiveParam
    }
    const whereUsedMaxLevelsParam = parseQueryNumber(readQueryParam('whereUsedMaxLevels'))
    if (whereUsedMaxLevelsParam !== undefined) {
      whereUsedMaxLevels.value = Math.max(1, Math.floor(whereUsedMaxLevelsParam))
    }
    const whereUsedFilterPresetParam = readQueryParam('whereUsedFilterPreset')
    const whereUsedFilterPresetTransition = resolvePlmHydratedRouteQueryTransition({
      previousRouteValue: previousHydratedRouteQuery.whereUsedFilterPreset,
      nextRouteValue: whereUsedFilterPresetParam,
    })
    if (whereUsedFilterPresetTransition.kind === 'apply') {
      const hydratedTakeover = resolvePlmHydratedLocalFilterPresetTakeover({
        routePresetKey: whereUsedFilterPresetTransition.routeValue,
        localSelectorKey: whereUsedFilterPresetKey.value,
        localNameDraft: whereUsedFilterPresetName.value,
        localGroupDraft: whereUsedFilterPresetGroup.value,
        localSelectionKeys: whereUsedPresetSelection.value,
        localBatchGroupDraft: whereUsedPresetBatchGroup.value,
      })
      whereUsedFilterPresetKey.value = hydratedTakeover.nextSelectorKey
      whereUsedFilterPresetName.value = hydratedTakeover.nextNameDraft
      whereUsedFilterPresetGroup.value = hydratedTakeover.nextGroupDraft
      whereUsedPresetSelection.value = hydratedTakeover.nextSelectionKeys
      whereUsedPresetBatchGroup.value = hydratedTakeover.nextBatchGroupDraft
      whereUsedFilterPresetQuery.value = whereUsedFilterPresetTransition.routeValue
    } else if (whereUsedFilterPresetTransition.kind === 'remove') {
      const nextIdentity = resolvePlmLocalFilterPresetRouteIdentity({
        routePresetKey: whereUsedFilterPresetTransition.removedRouteValue,
        selectedPresetKey: whereUsedFilterPresetKey.value,
        nameDraft: whereUsedFilterPresetName.value,
        groupDraft: whereUsedFilterPresetGroup.value,
        selectionKeys: whereUsedPresetSelection.value,
        batchGroupDraft: whereUsedPresetBatchGroup.value,
        activePreset: null,
        currentState: {
          field: whereUsedFilterField.value,
          value: whereUsedFilter.value,
        },
      })
      whereUsedFilterPresetKey.value = nextIdentity.nextSelectedPresetKey
      whereUsedFilterPresetName.value = nextIdentity.nextNameDraft
      whereUsedFilterPresetGroup.value = nextIdentity.nextGroupDraft
      whereUsedPresetSelection.value = nextIdentity.nextSelectionKeys
      whereUsedPresetBatchGroup.value = nextIdentity.nextBatchGroupDraft
      whereUsedFilterPresetQuery.value = nextIdentity.nextRoutePresetKey
    }
    const whereUsedTeamPresetParam = readQueryParam('whereUsedTeamPreset')
    const whereUsedTeamPresetTransition = resolvePlmHydratedRouteQueryTransition({
      previousRouteValue: previousHydratedRouteQuery.whereUsedTeamPreset,
      nextRouteValue: whereUsedTeamPresetParam,
    })
    if (whereUsedTeamPresetTransition.kind === 'apply') {
      applyHydratedTeamPresetOwnerTakeover({
        routeOwnerId: whereUsedTeamPresetTransition.routeValue,
        teamPresetKey: whereUsedTeamPresetKey,
        teamPresetName: whereUsedTeamPresetName,
        teamPresetGroup: whereUsedTeamPresetGroup,
        teamPresetOwnerUserId: whereUsedTeamPresetOwnerUserId,
        teamPresetSelection: whereUsedTeamPresetSelection,
      })
      whereUsedTeamPresetQuery.value = whereUsedTeamPresetTransition.routeValue
    } else if (whereUsedTeamPresetTransition.kind === 'remove') {
      applyHydratedRemovedTeamPresetOwner({
        removedRouteOwnerId: whereUsedTeamPresetTransition.removedRouteValue,
        teamPresetQuery: whereUsedTeamPresetQuery,
        teamPresetKey: whereUsedTeamPresetKey,
        teamPresetName: whereUsedTeamPresetName,
        teamPresetGroup: whereUsedTeamPresetGroup,
        teamPresetOwnerUserId: whereUsedTeamPresetOwnerUserId,
        teamPresetSelection: whereUsedTeamPresetSelection,
      })
    }
    const whereUsedFilterParam = readQueryParam('whereUsedFilter')
    if (whereUsedFilterParam !== undefined) {
      whereUsedFilter.value = whereUsedFilterParam
    }
    const whereUsedFilterFieldParam = readQueryParam('whereUsedFilterField')
    if (whereUsedFilterFieldParam !== undefined) {
      const matched = whereUsedFilterFieldOptions.find(
        (entry) => entry.value === whereUsedFilterFieldParam
      )
      if (matched) {
        whereUsedFilterField.value = matched.value
      }
    }
    const bomDepthParam = parseQueryNumber(readQueryParam('bomDepth'))
    if (bomDepthParam !== undefined) {
      bomDepth.value = Math.max(1, Math.floor(bomDepthParam))
    }
    const bomEffectiveAtParam = readQueryParam('bomEffectiveAt')
    if (bomEffectiveAtParam !== undefined) {
      bomEffectiveAt.value = bomEffectiveAtParam
    }
    const bomFilterPresetParam = readQueryParam('bomFilterPreset')
    const bomFilterPresetTransition = resolvePlmHydratedRouteQueryTransition({
      previousRouteValue: previousHydratedRouteQuery.bomFilterPreset,
      nextRouteValue: bomFilterPresetParam,
    })
    if (bomFilterPresetTransition.kind === 'apply') {
      const hydratedTakeover = resolvePlmHydratedLocalFilterPresetTakeover({
        routePresetKey: bomFilterPresetTransition.routeValue,
        localSelectorKey: bomFilterPresetKey.value,
        localNameDraft: bomFilterPresetName.value,
        localGroupDraft: bomFilterPresetGroup.value,
        localSelectionKeys: bomPresetSelection.value,
        localBatchGroupDraft: bomPresetBatchGroup.value,
      })
      bomFilterPresetKey.value = hydratedTakeover.nextSelectorKey
      bomFilterPresetName.value = hydratedTakeover.nextNameDraft
      bomFilterPresetGroup.value = hydratedTakeover.nextGroupDraft
      bomPresetSelection.value = hydratedTakeover.nextSelectionKeys
      bomPresetBatchGroup.value = hydratedTakeover.nextBatchGroupDraft
      bomFilterPresetQuery.value = bomFilterPresetTransition.routeValue
    } else if (bomFilterPresetTransition.kind === 'remove') {
      const nextIdentity = resolvePlmLocalFilterPresetRouteIdentity({
        routePresetKey: bomFilterPresetTransition.removedRouteValue,
        selectedPresetKey: bomFilterPresetKey.value,
        nameDraft: bomFilterPresetName.value,
        groupDraft: bomFilterPresetGroup.value,
        selectionKeys: bomPresetSelection.value,
        batchGroupDraft: bomPresetBatchGroup.value,
        activePreset: null,
        currentState: {
          field: bomFilterField.value,
          value: bomFilter.value,
        },
      })
      bomFilterPresetKey.value = nextIdentity.nextSelectedPresetKey
      bomFilterPresetName.value = nextIdentity.nextNameDraft
      bomFilterPresetGroup.value = nextIdentity.nextGroupDraft
      bomPresetSelection.value = nextIdentity.nextSelectionKeys
      bomPresetBatchGroup.value = nextIdentity.nextBatchGroupDraft
      bomFilterPresetQuery.value = nextIdentity.nextRoutePresetKey
    }
    const bomTeamPresetParam = readQueryParam('bomTeamPreset')
    const bomTeamPresetTransition = resolvePlmHydratedRouteQueryTransition({
      previousRouteValue: previousHydratedRouteQuery.bomTeamPreset,
      nextRouteValue: bomTeamPresetParam,
    })
    if (bomTeamPresetTransition.kind === 'apply') {
      applyHydratedTeamPresetOwnerTakeover({
        routeOwnerId: bomTeamPresetTransition.routeValue,
        teamPresetKey: bomTeamPresetKey,
        teamPresetName: bomTeamPresetName,
        teamPresetGroup: bomTeamPresetGroup,
        teamPresetOwnerUserId: bomTeamPresetOwnerUserId,
        teamPresetSelection: bomTeamPresetSelection,
      })
      bomTeamPresetQuery.value = bomTeamPresetTransition.routeValue
    } else if (bomTeamPresetTransition.kind === 'remove') {
      applyHydratedRemovedTeamPresetOwner({
        removedRouteOwnerId: bomTeamPresetTransition.removedRouteValue,
        teamPresetQuery: bomTeamPresetQuery,
        teamPresetKey: bomTeamPresetKey,
        teamPresetName: bomTeamPresetName,
        teamPresetGroup: bomTeamPresetGroup,
        teamPresetOwnerUserId: bomTeamPresetOwnerUserId,
        teamPresetSelection: bomTeamPresetSelection,
      })
    }
    const bomFilterParam = readQueryParam('bomFilter')
    if (bomFilterParam !== undefined) {
      bomFilter.value = bomFilterParam
    }
    const bomFilterFieldParam = readQueryParam('bomFilterField')
    if (bomFilterFieldParam !== undefined) {
      const matched = bomFilterFieldOptions.find((entry) => entry.value === bomFilterFieldParam)
      if (matched) {
        bomFilterField.value = matched.value
      }
    }
    const bomViewParam = readQueryParam('bomView')
    if (bomViewParam !== undefined) {
      const normalized = bomViewParam.trim().toLowerCase()
      if (normalized === 'tree' || normalized === 'table') {
        bomView.value = normalized as typeof bomView.value
      }
    }
    const bomCollapsedParam = readQueryParam('bomCollapsed')
    const currentBomView = String(bomView.value)
    if (bomCollapsedParam !== undefined) {
      const parsed = filterBomCollapsed(parseBomCollapsed(bomCollapsedParam))
      bomCollapsed.value = parsed
      persistBomCollapsed(parsed)
    } else if (currentBomView === 'tree') {
      const stored = loadStoredBomCollapsed()
      if (stored) {
        bomCollapsed.value = filterBomCollapsed(stored)
      }
    }
    if (['valid', 'expiring'].includes(authState.value)) {
      const teamPresetRefreshTasks: Array<Promise<void>> = []
      if (bomTeamPresetQuery.value) {
        teamPresetRefreshTasks.push(refreshBomTeamPresets())
      }
      if (whereUsedTeamPresetQuery.value) {
        teamPresetRefreshTasks.push(refreshWhereUsedTeamPresets())
      }
      if (teamPresetRefreshTasks.length) {
        await Promise.all(teamPresetRefreshTasks)
      }
    }
    if (bomFilterPresetQuery.value) {
      const preset = applyFilterPreset(bomFilterPresets.value, bomFilterPresetQuery.value)
      if (preset) {
        applyBomLocalFilterPresetIdentity(preset)
      } else {
        const nextIdentity = resolvePlmLocalFilterPresetRouteIdentity({
          routePresetKey: bomFilterPresetQuery.value,
          selectedPresetKey: bomFilterPresetKey.value,
          nameDraft: bomFilterPresetName.value,
          groupDraft: bomFilterPresetGroup.value,
          selectionKeys: bomPresetSelection.value,
          batchGroupDraft: bomPresetBatchGroup.value,
          activePreset: null,
          currentState: {
            field: bomFilterField.value,
            value: bomFilter.value,
          },
        })
        bomFilterPresetKey.value = nextIdentity.nextSelectedPresetKey
        bomFilterPresetName.value = nextIdentity.nextNameDraft
        bomFilterPresetGroup.value = nextIdentity.nextGroupDraft
        bomPresetSelection.value = nextIdentity.nextSelectionKeys
        bomPresetBatchGroup.value = nextIdentity.nextBatchGroupDraft
        syncBomFilterPresetQuery(nextIdentity.nextRoutePresetKey || undefined)
      }
    }
    if (whereUsedFilterPresetQuery.value) {
      const preset = applyFilterPreset(whereUsedFilterPresets.value, whereUsedFilterPresetQuery.value)
      if (preset) {
        applyWhereUsedLocalFilterPresetIdentity(preset)
      } else {
        const nextIdentity = resolvePlmLocalFilterPresetRouteIdentity({
          routePresetKey: whereUsedFilterPresetQuery.value,
          selectedPresetKey: whereUsedFilterPresetKey.value,
          nameDraft: whereUsedFilterPresetName.value,
          groupDraft: whereUsedFilterPresetGroup.value,
          selectionKeys: whereUsedPresetSelection.value,
          batchGroupDraft: whereUsedPresetBatchGroup.value,
          activePreset: null,
          currentState: {
            field: whereUsedFilterField.value,
            value: whereUsedFilter.value,
          },
        })
        whereUsedFilterPresetKey.value = nextIdentity.nextSelectedPresetKey
        whereUsedFilterPresetName.value = nextIdentity.nextNameDraft
        whereUsedFilterPresetGroup.value = nextIdentity.nextGroupDraft
        whereUsedPresetSelection.value = nextIdentity.nextSelectionKeys
        whereUsedPresetBatchGroup.value = nextIdentity.nextBatchGroupDraft
        syncWhereUsedFilterPresetQuery(nextIdentity.nextRoutePresetKey || undefined)
      }
    }
    const compareLeftParam = readQueryParam('compareLeftId')
    if (compareLeftParam !== undefined) {
      compareLeftId.value = compareLeftParam
    }
    const compareRightParam = readQueryParam('compareRightId')
    if (compareRightParam !== undefined) {
      compareRightId.value = compareRightParam
    }
    const compareModeParam = readQueryParam('compareMode')
    if (compareModeParam !== undefined) {
      compareMode.value = compareModeParam
    }
    const compareLineKeyParam = readQueryParam('compareLineKey')
    if (compareLineKeyParam !== undefined) {
      compareLineKey.value = compareLineKeyParam
    }
    const compareMaxLevelsParam = parseQueryNumber(readQueryParam('compareMaxLevels'))
    if (compareMaxLevelsParam !== undefined) {
      compareMaxLevels.value = Math.max(1, Math.floor(compareMaxLevelsParam))
    }
    const compareEffectiveAtParam = readQueryParam('compareEffectiveAt')
    if (compareEffectiveAtParam !== undefined) {
      compareEffectiveAt.value = compareEffectiveAtParam
    }
    const compareRelPropsParam = readQueryParam('compareRelationshipProps')
    if (compareRelPropsParam !== undefined) {
      compareRelationshipProps.value = compareRelPropsParam
    }
    const compareFilterParam = readQueryParam('compareFilter')
    if (compareFilterParam !== undefined) {
      compareFilter.value = compareFilterParam
    }
    const includeChildFieldsParam = parseQueryBoolean(readQueryParam('compareIncludeChildFields'))
    if (includeChildFieldsParam !== undefined) {
      compareIncludeChildFields.value = includeChildFieldsParam
    }
    const includeSubstitutesParam = parseQueryBoolean(readQueryParam('compareIncludeSubstitutes'))
    if (includeSubstitutesParam !== undefined) {
      compareIncludeSubstitutes.value = includeSubstitutesParam
    }
    const includeEffectivityParam = parseQueryBoolean(readQueryParam('compareIncludeEffectivity'))
    if (includeEffectivityParam !== undefined) {
      compareIncludeEffectivity.value = includeEffectivityParam
    }
    const compareSyncParam = parseQueryBoolean(readQueryParam('compareSync'))
    if (compareSyncParam !== undefined) {
      compareSyncEnabled.value = compareSyncParam
    }
    const bomLineParam = readQueryParam('bomLineId')
    if (bomLineParam !== undefined) {
      bomLineId.value = bomLineParam
    }
    const substitutesFilterParam = readQueryParam('substitutesFilter')
    if (substitutesFilterParam !== undefined) {
      substitutesFilter.value = substitutesFilterParam
    }

    const bomPresetShareParam = readQueryParam('bomPresetShare')
    if (bomPresetShareParam !== undefined) {
      if (bomPresetShareParam) {
        const mode = resolveFilterPresetShareMode(readQueryParam('bomPresetShareMode'))
        importBomFilterPresetShare(bomPresetShareParam, mode)
      }
      syncQueryParams({ bomPresetShare: undefined, bomPresetShareMode: undefined })
    }
    const whereUsedPresetShareParam = readQueryParam('whereUsedPresetShare')
    if (whereUsedPresetShareParam !== undefined) {
      if (whereUsedPresetShareParam) {
        const mode = resolveFilterPresetShareMode(readQueryParam('whereUsedPresetShareMode'))
        importWhereUsedFilterPresetShare(whereUsedPresetShareParam, mode)
      }
      syncQueryParams({ whereUsedPresetShare: undefined, whereUsedPresetShareMode: undefined })
    }

    const panelParam = readQueryParam('panel')
    if (panelParam !== undefined) {
      const selectedPanels = Array.from(parseDeepLinkPanels(panelParam)).filter((entry) => entry !== 'all')
      deepLinkScope.value = selectedPanels
      deepLinkPreset.value = ''
      editingPresetLabel.value = ''
    }
    const panelTargets = parseDeepLinkPanels(panelParam)
    const allowAllPanels = panelTargets.has('all')
    const allowsPanel = (key: string) => allowAllPanels || panelTargets.has(key)

    const autoLoad = parseQueryBoolean(readQueryParam('autoload')) ?? false
    const nextHydratedPanelDataRouteState: PlmHydratedPanelDataRouteState = {
      autoload: autoLoad,
      panel: panelParam,
      searchQuery: searchQuery.value,
      searchItemType: searchItemType.value,
      searchLimit: searchLimit.value,
      productId: productId.value,
      itemNumber: productItemNumber.value,
      itemType: itemType.value,
      bomDepth: bomDepth.value,
      bomEffectiveAt: bomEffectiveAt.value,
      documentRole: documentRole.value,
      approvalsStatus: approvalsStatus.value,
      cadFileId: cadFileId.value,
      cadOtherFileId: cadOtherFileId.value,
      whereUsedItemId: whereUsedItemId.value,
      whereUsedRecursive: whereUsedRecursive.value,
      whereUsedMaxLevels: whereUsedMaxLevels.value,
      compareLeftId: compareLeftId.value,
      compareRightId: compareRightId.value,
      compareMode: compareMode.value,
      compareLineKey: compareLineKey.value,
      compareMaxLevels: compareMaxLevels.value,
      compareIncludeChildFields: compareIncludeChildFields.value,
      compareIncludeSubstitutes: compareIncludeSubstitutes.value,
      compareIncludeEffectivity: compareIncludeEffectivity.value,
      compareEffectiveAt: compareEffectiveAt.value,
      compareRelationshipProps: compareRelationshipProps.value,
      bomLineId: bomLineId.value,
    }
    applyHydratedPanelDataReset({
      previousRouteState: previousHydratedPanelDataRouteState,
      nextRouteState: nextHydratedPanelDataRouteState,
    })
    if (!autoLoad) {
      return
    }
    const tasks: Array<Promise<void>> = []
    if (allowsPanel('search') && searchQuery.value) tasks.push(searchProducts())
    const shouldBootstrapProductContext = shouldAutoloadPlmProductContext({
      panel: panelParam,
      productId: productId.value,
      itemNumber: productItemNumber.value,
    })
    if (shouldBootstrapProductContext) {
      tasks.push(loadProduct())
    } else {
      if (allowsPanel('documents') && productId.value) tasks.push(loadDocuments())
      if (allowsPanel('approvals') && productId.value) tasks.push(loadApprovals())
    }
    if (allowsPanel('cad') && cadFileId.value) tasks.push(loadCadMetadata())
    if (allowsPanel('where-used') && whereUsedItemId.value) tasks.push(loadWhereUsed())
    if (allowsPanel('compare') && compareLeftId.value && compareRightId.value) tasks.push(loadBomCompare())
    if (allowsPanel('substitutes') && bomLineId.value) tasks.push(loadSubstitutes())
    if (allowsPanel('cad') && cadFileId.value && cadOtherFileId.value) tasks.push(loadCadDiff())
    if (tasks.length) {
      await Promise.all(tasks)
    }
  } finally {
    isApplyingRouteQueryState.value = false
  }

  const { pendingPatch, flushPatch } = resolvePlmDeferredRouteQueryPatch(
    deferredRouteQueryPatch,
    pendingRouteQueryHydration,
  )
  deferredRouteQueryPatch = pendingPatch

  if (pendingRouteQueryHydration) {
    pendingRouteQueryHydration = false
    await applyQueryState()
    return
  }

  if (flushPatch) {
    syncQueryParams(flushPatch)
  }
}

type SortDirection = 'asc' | 'desc'
type SortType = 'string' | 'number' | 'date'
type SortConfig<T> = Record<string, { type: SortType; accessor: (row: T) => unknown }>

function loadStoredColumns<T extends Record<string, boolean>>(key: string, defaults: T): T {
  if (typeof localStorage === 'undefined') {
    return { ...defaults }
  }
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return { ...defaults }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { ...defaults }
    const merged = { ...defaults } as T
    const mergedRecord = merged as Record<string, boolean>
    for (const [column, enabled] of Object.entries(parsed as Record<string, unknown>)) {
      if (column in defaults) {
        mergedRecord[column] = Boolean(enabled)
      }
    }
    return merged
  } catch (_err) {
    return { ...defaults }
  }
}

function persistColumns(key: string, value: Record<string, boolean>) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (_err) {
    // ignore storage errors
  }
}

function areColumnStatesEqual(
  value: Record<string, boolean>,
  defaults: Record<string, boolean>,
) {
  const keys = new Set([...Object.keys(defaults), ...Object.keys(value)])
  for (const key of keys) {
    if (Boolean(value[key]) !== Boolean(defaults[key])) {
      return false
    }
  }
  return true
}

function sortRows<T>(rows: T[], key: string, dir: SortDirection, config: SortConfig<T>): T[] {
  const entry = config[key]
  if (!entry) return rows
  const multiplier = dir === 'desc' ? -1 : 1
  const sorted = [...rows].sort((left, right) => {
    const leftValue = normalizeSortValue(entry.accessor(left), entry.type)
    const rightValue = normalizeSortValue(entry.accessor(right), entry.type)
    if (entry.type === 'number' || entry.type === 'date') {
      return (leftValue as number - (rightValue as number)) * multiplier
    }
    return String(leftValue).localeCompare(String(rightValue)) * multiplier
  })
  return sorted
}

function normalizeSortValue(value: unknown, type: SortType): string | number {
  if (type === 'number') {
    return Number(value ?? 0) || 0
  }
  if (type === 'date') {
    if (!value) return 0
    const date = new Date(String(value))
    return Number.isNaN(date.getTime()) ? 0 : date.getTime()
  }
  return String(value ?? '').toLowerCase()
}

function formatCompareEffectivityEntry(entry: CompareEffectivityEntry): string {
  const start = entry?.start_date || entry?.start || ''
  const end = entry?.end_date || entry?.end || ''
  const range = start || end ? `${start || '-'}~${end || '-'}` : ''
  return entry?.type ? `${entry.type}:${range}` : range
}

function formatEffectivityProps(props: CompareLineProps): string {
  const from = props.effectivity_from ?? props.effectivityFrom ?? props.effectivity_from_date
  const to = props.effectivity_to ?? props.effectivityTo ?? props.effectivity_to_date
  if (from || to) {
    return `${from || '-'} → ${to || '-'}`
  }
  const effectivities = props.effectivities
  if (Array.isArray(effectivities) && effectivities.length) {
    return effectivities
      .map((entry) => formatCompareEffectivityEntry(entry))
      .filter(Boolean)
      .join('; ')
  }
  return '-'
}

function formatEffectivity(entry: CompareEntry): string {
  const props = resolveCompareLineProps(entry)
  const primary = formatEffectivityProps(props)
  if (primary !== '-') return primary

  const beforeProps = entry?.before_line || entry?.before || {}
  const afterProps = entry?.after_line || entry?.after || {}
  const beforeText = formatEffectivityProps(beforeProps)
  const afterText = formatEffectivityProps(afterProps)
  if (beforeText !== '-' || afterText !== '-') {
    if (beforeText !== afterText && beforeText !== '-' && afterText !== '-') {
      return `${beforeText} → ${afterText}`
    }
    return afterText !== '-' ? afterText : beforeText
  }
  return '-'
}

function formatSubstituteCount(entry: CompareEntry): string {
  const resolveCount = (props: CompareLineProps): number | null => {
    const subs = props.substitutes ?? props.substitute_items
    if (Array.isArray(subs)) return subs.length
    const raw = props.substitute_count ?? props.substitutes_count ?? props.substituteCount
    const count = Number(raw)
    if (Number.isFinite(count)) return count
    return null
  }

  const props = resolveCompareLineProps(entry)
  const count = resolveCount(props)
  if (count !== null) {
    return count > 0 ? String(count) : '-'
  }

  const beforeProps = entry?.before_line || entry?.before || {}
  const afterProps = entry?.after_line || entry?.after || {}
  const beforeCount = resolveCount(beforeProps)
  const afterCount = resolveCount(afterProps)
  if (beforeCount !== null || afterCount !== null) {
    const beforeText = beforeCount && beforeCount > 0 ? String(beforeCount) : '-'
    const afterText = afterCount && afterCount > 0 ? String(afterCount) : '-'
    if (beforeText !== afterText) {
      return `${beforeText} → ${afterText}`
    }
    return afterText !== '-' ? afterText : beforeText
  }
  return '-'
}

function filterCompareEntries(entries: CompareEntry[]): CompareEntry[] {
  const needle = compareFilter.value.trim().toLowerCase()
  if (!needle) return entries
  return entries.filter((entry) => {
    const pathNodes = Array.isArray(entry?.path) ? entry.path : []
    const pathTokens = pathNodes.flatMap((node) => [
      node?.id,
      node?.item_number,
      node?.itemNumber,
      node?.code,
      node?.name,
      node?.label,
    ])
    const lineProps = resolveCompareLineProps(entry)
    const tokens = [
      getItemNumber(entry.parent),
      getItemName(entry.parent),
      getItemNumber(entry.child),
      getItemName(entry.child),
      entry.relationship_id,
      entry.line_key,
      lineProps.find_num ?? lineProps.findNum,
      lineProps.refdes,
      lineProps.quantity,
      lineProps.uom,
      ...pathTokens,
    ]
    return tokens.some((token) => String(token || '').toLowerCase().includes(needle))
  })
}

function downloadCsv(filename: string, headers: string[], rows: Array<string[]>): void {
  downloadCsvFile(filename, headers, rows)
}

function approvalStatusClass(value?: string): string {
  const normalized = (value || '').toLowerCase()
  if (normalized === 'approved') return 'status-approved'
  if (normalized === 'rejected') return 'status-rejected'
  return 'status-pending'
}

function itemStatusClass(value?: string): string {
  const normalized = (value || '').toLowerCase()
  if (!normalized || normalized === '-') return 'status-neutral'
  if (['released', 'active', 'approved', 'valid'].includes(normalized)) return 'status-approved'
  if (['obsolete', 'rejected', 'inactive', 'invalid'].includes(normalized)) return 'status-rejected'
  if (['draft', 'inwork', 'pending', 'review', 'wip'].includes(normalized)) return 'status-pending'
  return 'status-neutral'
}

function normalizeCompareSeverity(value?: string): string {
  const normalized = (value || '').toLowerCase()
  if (normalized === 'major') return 'major'
  if (normalized === 'minor') return 'minor'
  return 'info'
}

function compareSeverityRank(value?: string): number {
  const normalized = normalizeCompareSeverity(value)
  if (normalized === 'major') return 3
  if (normalized === 'minor') return 2
  return 1
}

function getCompareEntrySeverity(entry: CompareEntry): string {
  const explicit = entry?.severity
  if (explicit) return normalizeCompareSeverity(explicit)
  const changes = Array.isArray(entry?.changes) ? entry.changes : []
  if (!changes.length) return 'info'
  let best = 'info'
  let bestRank = 0
  for (const change of changes) {
    const meta = compareFieldMetaMap.value.get(String(change.field || ''))
    const resolved = normalizeCompareSeverity(change.severity || meta?.severity)
    const rank = compareSeverityRank(resolved)
    if (rank > bestRank) {
      best = resolved
      bestRank = rank
    }
  }
  return best
}

function getCompareChangeRows(entry: CompareEntry): CompareChangeRow[] {
  const changes = Array.isArray(entry?.changes) ? entry.changes : []
  const rows: CompareChangeRow[] = changes.map((change, idx: number) => {
    const meta = compareFieldMetaMap.value.get(String(change.field || ''))
    const severity = normalizeCompareSeverity(change.severity || meta?.severity)
    return {
      key: `${change.field || 'field'}-${idx}`,
      field: String(change.field || ''),
      label: meta?.label || change.field || '-',
      description: meta?.source || '',
      normalized: meta?.normalized || '',
      severity,
      left: change.left,
      right: change.right,
    }
  })
  rows.sort((a, b) => {
    const rankDiff = compareSeverityRank(b.severity) - compareSeverityRank(a.severity)
    if (rankDiff) return rankDiff
    return String(a.label).localeCompare(String(b.label))
  })
  return rows
}

function formatDiffValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '-'
  return String(value)
}

function severityClass(value?: string): string {
  const normalized = (value || 'info').toLowerCase()
  if (normalized === 'major') return 'severity-major'
  if (normalized === 'minor') return 'severity-minor'
  return 'severity-info'
}

function compareRowClass(entry: CompareEntry): string {
  const severity = getCompareEntrySeverity(entry)
  return `compare-row compare-row-${severity}`
}

const { productPanel } = usePlmProductPanel({
  authState,
  authExpiresAt,
  plmAuthState,
  plmAuthExpiresAt,
  plmAuthLegacy,
  authError,
  refreshAuthStatus,
  deepLinkStatus,
  deepLinkError,
  copyDeepLink,
  resetAll,
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
  deepLinkPreset,
  applyDeepLinkPreset,
  deepLinkPresets,
  movePreset,
  deepLinkPanelOptions,
  deepLinkScope,
  clearDeepLinkScope,
  customPresetName,
  saveDeepLinkPreset,
  deleteDeepLinkPreset,
  editingPresetLabel,
  applyPresetRename,
  exportCustomPresets,
  importPresetText,
  importCustomPresets,
  triggerPresetFileImport,
  importFileInput,
  handlePresetFileImport,
  isPresetDropActive,
  handlePresetDragEnter,
  handlePresetDragOver,
  handlePresetDragLeave,
  handlePresetDrop,
  workbenchTeamViewKey,
  workbenchTeamViewName,
  workbenchTeamViewOwnerUserId,
  showManageWorkbenchTeamViewActions,
  canSaveWorkbenchTeamView,
  canApplyWorkbenchTeamView,
  canDuplicateWorkbenchTeamView,
  canShareWorkbenchTeamView,
  canDeleteWorkbenchTeamView,
  canArchiveWorkbenchTeamView,
  canRestoreWorkbenchTeamView,
  canRenameWorkbenchTeamView,
  canTransferWorkbenchTeamViewTarget,
  canTransferWorkbenchTeamView,
  canSetWorkbenchTeamViewDefault,
  canClearWorkbenchTeamViewDefault,
  workbenchDefaultTeamViewLabel,
  workbenchTeamViews,
  workbenchTeamViewsLoading,
  workbenchTeamViewsError,
  hasManageableWorkbenchTeamViews,
  showWorkbenchTeamViewManager,
  workbenchTeamViewSelection,
  workbenchTeamViewSelectionCount,
  selectedBatchArchivableWorkbenchTeamViewIds,
  selectedBatchRestorableWorkbenchTeamViewIds,
  selectedBatchDeletableWorkbenchTeamViewIds,
  sceneCatalogOwnerFilter,
  sceneCatalogOwnerOptions,
  sceneCatalogRecommendationFilter,
  sceneCatalogRecommendationOptions,
  sceneCatalogSummaryChips,
  sceneCatalogSummaryHint,
  sceneCatalogAutoFocusSceneId,
  clearSceneCatalogAutoFocusSceneId,
  setSceneCatalogRecommendationFilter,
  recommendedWorkbenchScenes,
  selectAllWorkbenchTeamViews,
  clearWorkbenchTeamViewSelection,
  archiveWorkbenchTeamViewSelection,
  restoreWorkbenchTeamViewSelection,
  deleteWorkbenchTeamViewSelection,
  applyRecommendedWorkbenchScene,
  openRecommendedWorkbenchSceneAudit,
  copyRecommendedWorkbenchSceneLink,
  openWorkbenchSceneAudit,
  productId,
  productItemNumber,
  itemType,
  productLoading,
  loadProduct,
  productError,
  product,
  productView,
  formatTime,
  hasProductCopyValue,
  copyProductField,
  productFieldCatalog,
  productMetadataLoading,
  productMetadataError,
  productMetadataRows,
  formatJson,
})

const { bomPanel } = usePlmBomPanel({
  copyDeepLink,
  loadBom,
  expandAllBom,
  collapseAllBom,
  expandBomToDepth,
  copyBomTablePathIdsBulk,
  copyBomTreePathIdsBulk,
  copyBomSelectedChildIds,
  clearBomSelection,
  exportBomCsv,
  setBomDepthQuick,
  applyBomFilterPreset,
  duplicateBomFilterPreset,
  renameBomFilterPreset,
  deleteBomFilterPreset,
  promoteBomFilterPresetToTeam,
  promoteBomFilterPresetToTeamDefault,
  shareBomFilterPreset,
  assignBomPresetGroup,
  saveBomFilterPreset,
  refreshBomTeamPresets,
  applyBomTeamPreset,
  shareBomTeamPreset,
  duplicateBomTeamPreset,
  archiveBomTeamPreset,
  restoreBomTeamPreset,
  deleteBomTeamPreset,
  renameBomTeamPreset,
  transferBomTeamPreset,
  saveBomTeamPreset,
  setBomTeamPresetDefault,
  clearBomTeamPresetDefault,
  selectAllBomTeamPresets,
  clearBomTeamPresetSelection,
  archiveBomTeamPresetSelection,
  restoreBomTeamPresetSelection,
  deleteBomTeamPresetSelection,
  exportBomFilterPresets,
  importBomFilterPresets,
  triggerBomFilterPresetFileImport,
  handleBomFilterPresetFileImport,
  clearBomFilterPresets,
  selectAllBomPresets,
  clearBomPresetSelection,
  applyBomPresetBatchGroup,
  deleteBomPresetSelection,
  toggleBomNode,
  isBomCollapsed,
  isBomTreeSelected,
  selectBomTreeRow,
  resolveBomLineId,
  formatBomFindNum,
  formatBomRefdes,
  formatBomPathIds,
  copyBomPathIds,
  resolveBomChildId,
  resolveBomChildNumber,
  applyProductFromBom,
  applyWhereUsedFromBom,
  applySubstitutesFromBom,
  copyBomChildId,
  isBomItemSelected,
  selectBomTableRow,
  formatBomTablePathIds,
  copyBomTablePathIds,
  BOM_DEPTH_QUICK_OPTIONS,
  bomView,
  bomHasTree,
  bomTablePathIdsCount,
  bomTreePathIdsCount,
  bomSelectedCount,
  bomExportCount,
  productId,
  bomLoading,
  bomDepth,
  bomEffectiveAt,
  bomFilterFieldOptions,
  bomFilterField,
  bomFilter,
  bomFilterPlaceholder,
  bomFilterPresetGroupFilter,
  bomFilterPresetGroups,
  bomFilterPresetKey,
  bomFilteredPresets,
  bomFilterPresetName,
  bomFilterPresetGroup,
  canSaveBomFilterPreset,
  bomFilterPresets,
  bomTeamPresetKey,
  bomTeamPresetName,
  bomTeamPresetGroup,
  bomTeamPresetOwnerUserId,
  showManageBomTeamPresetActions,
  canSaveBomTeamPreset,
  canApplyBomTeamPreset,
  canDuplicateBomTeamPreset,
  canShareBomTeamPreset,
  canDeleteBomTeamPreset,
  canArchiveBomTeamPreset,
  canRestoreBomTeamPreset,
  canRenameBomTeamPreset,
  canTransferTargetBomTeamPreset,
  canTransferBomTeamPreset,
  canSetBomTeamPresetDefault,
  canClearBomTeamPresetDefault,
  bomDefaultTeamPresetLabel,
  hasManageableBomTeamPresets,
  bomTeamPresets,
  bomTeamPresetsLoading,
  bomTeamPresetsError,
  showBomTeamPresetManager,
  bomTeamPresetSelectionCount,
  bomTeamPresetSelection,
  selectedBatchArchivableBomTeamPresetIds,
  selectedBatchRestorableBomTeamPresetIds,
  selectedBatchDeletableBomTeamPresetIds,
  bomFilterPresetImportText,
  bomFilterPresetImportMode,
  bomFilterPresetFileInput,
  showBomPresetManager,
  bomPresetSelectionCount,
  bomPresetBatchGroup,
  bomPresetSelection,
  bomError,
  bomItems,
  bomDisplayCount,
  bomTreeVisibleCount,
  bomFilteredItems,
  bomTreeVisibleRows,
  productLoading,
  whereUsedLoading,
  substitutesLoading,
})

const documentsPanel = {
  copyDeepLink,
  exportDocumentsCsv,
  loadDocuments,
  refreshDocumentTeamViews,
  applyDocumentTeamView,
  duplicateDocumentTeamView,
  shareDocumentTeamView,
  deleteDocumentTeamView,
  archiveDocumentTeamView,
  restoreDocumentTeamView,
  renameDocumentTeamView,
  transferDocumentTeamView,
  saveDocumentTeamView,
  setDocumentTeamViewDefault,
  clearDocumentTeamViewDefault,
  selectCadFile,
  applyProductFromDocument,
  returnToDocumentSource,
  isAmlRelatedDocument,
  copyDocumentId,
  copyDocumentUrl,
  getDocumentName,
  getDocumentId,
  getDocumentType,
  getDocumentRevision,
  getDocumentRole,
  getDocumentAuthor,
  getDocumentSourceSystem,
  getDocumentSourceVersion,
  getDocumentMime,
  getDocumentSize,
  getDocumentCreatedAt,
  getDocumentUpdatedAt,
  getDocumentPreviewUrl,
  getDocumentDownloadUrl,
  formatBytes,
  formatTime,
  productId,
  documentRole,
  documentFilter,
  documentSortKey,
  documentSortDir,
  documentColumnOptions,
  documentColumns,
  documentTeamViewKey,
  documentTeamViewName,
  documentTeamViewOwnerUserId,
  showManageDocumentTeamViewActions,
  canSaveDocumentTeamView,
  canApplyDocumentTeamView,
  canDuplicateDocumentTeamView,
  canShareDocumentTeamView,
  canDeleteDocumentTeamView,
  canArchiveDocumentTeamView,
  canRestoreDocumentTeamView,
  canRenameDocumentTeamView,
  canTransferDocumentTeamViewTarget,
  canTransferDocumentTeamView,
  canSetDocumentTeamViewDefault,
  canClearDocumentTeamViewDefault,
  documentDefaultTeamViewLabel,
  hasManageableDocumentTeamViews,
  showDocumentTeamViewManager,
  documentTeamViewSelection,
  documentTeamViewSelectionCount,
  selectedBatchArchivableDocumentTeamViewIds,
  selectedBatchRestorableDocumentTeamViewIds,
  selectedBatchDeletableDocumentTeamViewIds,
  documentTeamViews,
  documentTeamViewsLoading,
  documentTeamViewsError,
  selectAllDocumentTeamViews,
  clearDocumentTeamViewSelection,
  archiveDocumentTeamViewSelection,
  restoreDocumentTeamViewSelection,
  deleteDocumentTeamViewSelection,
  documents,
  documentsLoading,
  documentsError,
  documentsWarning,
  documentSourceProductId,
  documentsFiltered,
  documentsSorted,
  documentFieldCatalog,
} satisfies PlmDocumentsPanelModel

const cadPanel = {
  copyDeepLink,
  loadCadMetadata,
  loadCadDiff,
  updateCadProperties,
  updateCadViewState,
  updateCadReview,
  refreshCadTeamViews,
  applyCadTeamView,
  duplicateCadTeamView,
  shareCadTeamView,
  deleteCadTeamView,
  archiveCadTeamView,
  restoreCadTeamView,
  renameCadTeamView,
  transferCadTeamView,
  saveCadTeamView,
  setCadTeamViewDefault,
  clearCadTeamViewDefault,
  formatJson,
  formatTime,
  cadFileId,
  cadOtherFileId,
  cadTeamViewKey,
  cadTeamViewName,
  cadTeamViewOwnerUserId,
  showManageCadTeamViewActions,
  canSaveCadTeamView,
  canApplyCadTeamView,
  canDuplicateCadTeamView,
  canShareCadTeamView,
  canDeleteCadTeamView,
  canArchiveCadTeamView,
  canRestoreCadTeamView,
  canRenameCadTeamView,
  canTransferCadTeamViewTarget,
  canTransferCadTeamView,
  canSetCadTeamViewDefault,
  canClearCadTeamViewDefault,
  cadDefaultTeamViewLabel,
  hasManageableCadTeamViews,
  showCadTeamViewManager,
  cadTeamViewSelection,
  cadTeamViewSelectionCount,
  selectedBatchArchivableCadTeamViewIds,
  selectedBatchRestorableCadTeamViewIds,
  selectedBatchDeletableCadTeamViewIds,
  cadTeamViews,
  cadTeamViewsLoading,
  cadTeamViewsError,
  selectAllCadTeamViews,
  clearCadTeamViewSelection,
  archiveCadTeamViewSelection,
  restoreCadTeamViewSelection,
  deleteCadTeamViewSelection,
  cadProperties,
  cadViewState,
  cadReview,
  cadHistory,
  cadDiff,
  cadMeshStats,
  cadPropertiesDraft,
  cadViewStateDraft,
  cadReviewState,
  cadReviewNote,
  cadLoading,
  cadDiffLoading,
  cadUpdating,
  cadStatus,
  cadError,
  cadActionStatus,
  cadActionError,
  cadHistoryEntries,
} satisfies PlmCadPanelModel

const approvalsPanel = {
  copyDeepLink,
  exportApprovalsCsv,
  loadApprovals,
  refreshApprovalsTeamViews,
  applyApprovalsTeamView,
  duplicateApprovalsTeamView,
  shareApprovalsTeamView,
  deleteApprovalsTeamView,
  archiveApprovalsTeamView,
  restoreApprovalsTeamView,
  renameApprovalsTeamView,
  transferApprovalsTeamView,
  saveApprovalsTeamView,
  setApprovalsTeamViewDefault,
  clearApprovalsTeamViewDefault,
  approvalsLoading,
  approvalsStatus,
  approvalsFilter,
  approvalComment,
  approvalSortKey,
  approvalSortDir,
  approvalColumnOptions,
  approvalColumns,
  approvalsTeamViewKey,
  approvalsTeamViewName,
  approvalsTeamViewOwnerUserId,
  showManageApprovalsTeamViewActions,
  canSaveApprovalsTeamView,
  canApplyApprovalsTeamView,
  canDuplicateApprovalsTeamView,
  canShareApprovalsTeamView,
  canDeleteApprovalsTeamView,
  canArchiveApprovalsTeamView,
  canRestoreApprovalsTeamView,
  canRenameApprovalsTeamView,
  canTransferApprovalsTeamViewTarget,
  canTransferApprovalsTeamView,
  canSetApprovalsTeamViewDefault,
  canClearApprovalsTeamViewDefault,
  approvalsDefaultTeamViewLabel,
  hasManageableApprovalsTeamViews,
  showApprovalsTeamViewManager,
  approvalsTeamViewSelection,
  approvalsTeamViewSelectionCount,
  selectedBatchArchivableApprovalsTeamViewIds,
  selectedBatchRestorableApprovalsTeamViewIds,
  selectedBatchDeletableApprovalsTeamViewIds,
  approvalsTeamViews,
  approvalsTeamViewsLoading,
  approvalsTeamViewsError,
  selectAllApprovalsTeamViews,
  clearApprovalsTeamViewSelection,
  archiveApprovalsTeamViewSelection,
  restoreApprovalsTeamViewSelection,
  deleteApprovalsTeamViewSelection,
  approvalActionError,
  approvalActionStatus,
  approvalsError,
  approvals,
  approvalsFiltered,
  approvalsSorted,
  approvalActingId,
  approvalHistoryFor,
  approvalHistoryLabel,
  approvalHistoryLoading,
  approvalHistoryError,
  approvalHistory,
  approvalHistoryRows,
  approvalFieldCatalog,
  formatJson,
  formatTime,
  approvalStatusClass,
  getApprovalId,
  getApprovalTitle,
  getApprovalStatus,
  getApprovalType,
  getApprovalRequester,
  getApprovalRequesterId,
  getApprovalCreatedAt,
  getApprovalProductNumber,
  getApprovalProductName,
  getApprovalProductId,
  getApprovalHistoryStatus,
  getApprovalHistoryStage,
  getApprovalHistoryType,
  getApprovalHistoryRole,
  getApprovalHistoryUser,
  getApprovalHistoryVersion,
  getApprovalHistoryComment,
  getApprovalHistoryApprovedAt,
  getApprovalHistoryCreatedAt,
  applyProductFromApproval,
  copyApprovalId,
  loadApprovalHistory,
  clearApprovalHistory,
  isApprovalPending,
  canActOnApproval,
  approveApproval,
  rejectApproval,
} satisfies PlmApprovalsPanelModel

const { whereUsedPanel } = usePlmWhereUsedPanel({
  copyDeepLink,
  expandAllWhereUsed,
  collapseAllWhereUsed,
  copyWhereUsedTablePathIdsBulk,
  copyWhereUsedTreePathIdsBulk,
  copyWhereUsedSelectedParents,
  clearWhereUsedSelection,
  exportWhereUsedCsv,
  loadWhereUsed,
  applyWhereUsedQuickPick,
  applyWhereUsedFilterPreset,
  duplicateWhereUsedFilterPreset,
  renameWhereUsedFilterPreset,
  deleteWhereUsedFilterPreset,
  promoteWhereUsedFilterPresetToTeam,
  promoteWhereUsedFilterPresetToTeamDefault,
  shareWhereUsedFilterPreset,
  assignWhereUsedPresetGroup,
  saveWhereUsedFilterPreset,
  refreshWhereUsedTeamPresets,
  applyWhereUsedTeamPreset,
  shareWhereUsedTeamPreset,
  duplicateWhereUsedTeamPreset,
  archiveWhereUsedTeamPreset,
  restoreWhereUsedTeamPreset,
  deleteWhereUsedTeamPreset,
  renameWhereUsedTeamPreset,
  transferWhereUsedTeamPreset,
  saveWhereUsedTeamPreset,
  setWhereUsedTeamPresetDefault,
  clearWhereUsedTeamPresetDefault,
  selectAllWhereUsedTeamPresets,
  clearWhereUsedTeamPresetSelection,
  archiveWhereUsedTeamPresetSelection,
  restoreWhereUsedTeamPresetSelection,
  deleteWhereUsedTeamPresetSelection,
  exportWhereUsedFilterPresets,
  importWhereUsedFilterPresets,
  triggerWhereUsedFilterPresetFileImport,
  handleWhereUsedFilterPresetFileImport,
  clearWhereUsedFilterPresets,
  selectAllWhereUsedPresets,
  clearWhereUsedPresetSelection,
  applyWhereUsedPresetBatchGroup,
  deleteWhereUsedPresetSelection,
  toggleWhereUsedNode,
  isWhereUsedCollapsed,
  isWhereUsedTreeSelected,
  selectWhereUsedTreeRow,
  getWhereUsedTreeLineValue,
  getWhereUsedTreeRefdes,
  getWhereUsedTreeRelationship,
  formatWhereUsedPathIds,
  copyWhereUsedPathIds,
  applyProductFromWhereUsedRow,
  isWhereUsedEntrySelected,
  selectWhereUsedTableRow,
  getItemNumber,
  getItemName,
  formatWhereUsedEntryPathIds,
  copyWhereUsedEntryPathIds,
  getWhereUsedLineValue,
  getWhereUsedRefdes,
  resolveWhereUsedParentId,
  applyProductFromWhereUsed,
  formatJson,
  whereUsedView,
  whereUsedHasTree,
  whereUsedPathIdsCount,
  whereUsedTreePathIdsCount,
  whereUsedSelectedCount,
  whereUsedFilteredRows,
  whereUsedItemId,
  whereUsedLoading,
  whereUsedQuickPick,
  whereUsedQuickOptions,
  whereUsedRecursive,
  whereUsedMaxLevels,
  whereUsedFilterFieldOptions,
  whereUsedFilterField,
  whereUsedFilter,
  whereUsedFilterPlaceholder,
  whereUsedFilterPresetGroupFilter,
  whereUsedFilterPresetGroups,
  whereUsedFilterPresetKey,
  whereUsedFilteredPresets,
  whereUsedFilterPresetName,
  whereUsedFilterPresetGroup,
  canSaveWhereUsedFilterPreset,
  whereUsedFilterPresets,
  whereUsedTeamPresetKey,
  whereUsedTeamPresetName,
  whereUsedTeamPresetGroup,
  whereUsedTeamPresetOwnerUserId,
  showManageWhereUsedTeamPresetActions,
  canSaveWhereUsedTeamPreset,
  canApplyWhereUsedTeamPreset,
  canDuplicateWhereUsedTeamPreset,
  canShareWhereUsedTeamPreset,
  canDeleteWhereUsedTeamPreset,
  canArchiveWhereUsedTeamPreset,
  canRestoreWhereUsedTeamPreset,
  canRenameWhereUsedTeamPreset,
  canTransferTargetWhereUsedTeamPreset,
  canTransferWhereUsedTeamPreset,
  canSetWhereUsedTeamPresetDefault,
  canClearWhereUsedTeamPresetDefault,
  whereUsedDefaultTeamPresetLabel,
  hasManageableWhereUsedTeamPresets,
  whereUsedTeamPresets,
  whereUsedTeamPresetsLoading,
  whereUsedTeamPresetsError,
  showWhereUsedTeamPresetManager,
  whereUsedTeamPresetSelectionCount,
  whereUsedTeamPresetSelection,
  selectedBatchArchivableWhereUsedTeamPresetIds,
  selectedBatchRestorableWhereUsedTeamPresetIds,
  selectedBatchDeletableWhereUsedTeamPresetIds,
  whereUsedFilterPresetImportText,
  whereUsedFilterPresetImportMode,
  whereUsedFilterPresetFileInput,
  showWhereUsedPresetManager,
  whereUsedPresetSelectionCount,
  whereUsedPresetBatchGroup,
  whereUsedPresetSelection,
  whereUsedError,
  whereUsed,
  whereUsedTreeVisibleRows,
  productLoading,
})

onMounted(() => {
  startAuthStatusPolling()
  documentColumns.value = loadStoredColumns(DOCUMENT_COLUMNS_STORAGE_KEY, defaultDocumentColumns)
  approvalColumns.value = loadStoredColumns(APPROVAL_COLUMNS_STORAGE_KEY, defaultApprovalColumns)
  bomFilterPresets.value = loadStoredFilterPresets(BOM_FILTER_PRESETS_STORAGE_KEY)
  whereUsedFilterPresets.value = loadStoredFilterPresets(WHERE_USED_FILTER_PRESETS_STORAGE_KEY)
  if (['valid', 'expiring'].includes(authState.value)) {
    void refreshWorkbenchTeamViews()
    void refreshBomTeamPresets()
    void refreshWhereUsedTeamPresets()
    void refreshDocumentTeamViews()
    void refreshCadTeamViews()
    void refreshApprovalsTeamViews()
    void loadBomCompareSchema()
  }
  void applyQueryState()
})

watch(
  () => route.fullPath,
  () => {
    cancelScheduledQuerySync()
    void applyQueryState()
  },
)

onBeforeUnmount(() => {
  stopAuthStatusPolling()
  cleanupDeepLinkState()
})

watch(
  documentColumns,
  (value) => {
    persistColumns(DOCUMENT_COLUMNS_STORAGE_KEY, value)
  },
  { deep: true }
)

watch(
  approvalColumns,
  (value) => {
    persistColumns(APPROVAL_COLUMNS_STORAGE_KEY, value)
  },
  { deep: true }
)

watch(
  () => [searchQuery.value, searchItemType.value, searchLimit.value],
  ([query, type, limit]) => {
    scheduleQuerySync({
      searchQuery: query || undefined,
      searchItemType: type !== DEFAULT_ITEM_TYPE ? type : undefined,
      searchLimit: limit !== DEFAULT_SEARCH_LIMIT ? limit : undefined,
    })
  }
)

watch(
  () => [
    documentRole.value,
    documentFilter.value,
    documentSortKey.value,
    documentSortDir.value,
    serializeColumnQuery(documentColumns.value, defaultDocumentColumns),
  ],
  ([role, filter, sortKey, sortDir, columns]) => {
    scheduleQuerySync({
      documentTeamView: documentTeamViewQuery.value || undefined,
      documentRole: role || undefined,
      documentFilter: filter || undefined,
      documentSort: sortKey !== 'updated' ? sortKey : undefined,
      documentSortDir: sortDir !== 'desc' ? sortDir : undefined,
      documentColumns: columns,
    })
  }
)

watch(
  () => [
    approvalsStatus.value,
    approvalsFilter.value,
    approvalSortKey.value,
    approvalSortDir.value,
    serializeColumnQuery(approvalColumns.value, defaultApprovalColumns),
  ],
  ([status, filter, sortKey, sortDir, columns]) => {
    scheduleQuerySync({
      approvalsTeamView: approvalsTeamViewQuery.value || undefined,
      approvalsStatus: status !== DEFAULT_APPROVAL_STATUS ? status : undefined,
      approvalsFilter: filter || undefined,
      approvalSort: sortKey !== 'created' ? sortKey : undefined,
      approvalSortDir: sortDir !== 'desc' ? sortDir : undefined,
      approvalColumns: columns,
    })
  }
)

watch(
  () => [
    bomFilterPresetQuery.value,
    bomFilterPresetKey.value,
    buildPlmLocalFilterPresetRouteOwnerWatchKey(activeBomLocalRoutePreset.value),
    JSON.stringify({
      field: bomFilterField.value,
      value: bomFilter.value,
    }),
  ],
  ([routePresetKey, selectedPresetKey, activePresetKey]) => {
    if (!routePresetKey || !activePresetKey) return
    const nextIdentity = resolvePlmLocalFilterPresetRouteIdentity({
      routePresetKey,
      selectedPresetKey,
      nameDraft: bomFilterPresetName.value,
      groupDraft: bomFilterPresetGroup.value,
      selectionKeys: bomPresetSelection.value,
      batchGroupDraft: bomPresetBatchGroup.value,
      activePreset: activeBomLocalRoutePreset.value,
      currentState: {
        field: bomFilterField.value,
        value: bomFilter.value,
      },
    })
    if (!nextIdentity.shouldClear) {
      return
    }
    bomFilterPresetKey.value = nextIdentity.nextSelectedPresetKey
    bomFilterPresetName.value = nextIdentity.nextNameDraft
    bomFilterPresetGroup.value = nextIdentity.nextGroupDraft
    bomPresetSelection.value = nextIdentity.nextSelectionKeys
    bomPresetBatchGroup.value = nextIdentity.nextBatchGroupDraft
    syncBomFilterPresetQuery(nextIdentity.nextRoutePresetKey || undefined)
  },
)

watch(
  () => [
    whereUsedFilterPresetQuery.value,
    whereUsedFilterPresetKey.value,
    buildPlmLocalFilterPresetRouteOwnerWatchKey(activeWhereUsedLocalRoutePreset.value),
    JSON.stringify({
      field: whereUsedFilterField.value,
      value: whereUsedFilter.value,
    }),
  ],
  ([routePresetKey, selectedPresetKey, activePresetKey]) => {
    if (!routePresetKey || !activePresetKey) return
    const nextIdentity = resolvePlmLocalFilterPresetRouteIdentity({
      routePresetKey,
      selectedPresetKey,
      nameDraft: whereUsedFilterPresetName.value,
      groupDraft: whereUsedFilterPresetGroup.value,
      selectionKeys: whereUsedPresetSelection.value,
      batchGroupDraft: whereUsedPresetBatchGroup.value,
      activePreset: activeWhereUsedLocalRoutePreset.value,
      currentState: {
        field: whereUsedFilterField.value,
        value: whereUsedFilter.value,
      },
    })
    if (!nextIdentity.shouldClear) {
      return
    }
    whereUsedFilterPresetKey.value = nextIdentity.nextSelectedPresetKey
    whereUsedFilterPresetName.value = nextIdentity.nextNameDraft
    whereUsedFilterPresetGroup.value = nextIdentity.nextGroupDraft
    whereUsedPresetSelection.value = nextIdentity.nextSelectionKeys
    whereUsedPresetBatchGroup.value = nextIdentity.nextBatchGroupDraft
    syncWhereUsedFilterPresetQuery(nextIdentity.nextRoutePresetKey || undefined)
  },
)

watch(
  () => [
    bomTeamPresetQuery.value,
    activeBomRoutePreset.value?.id || '',
    JSON.stringify({
      field: bomFilterField.value,
      value: bomFilter.value,
      group: bomFilterPresetGroup.value,
    }),
  ],
  ([presetId, activePresetId]) => {
    if (!presetId || !activePresetId) return
    const activePreset = activeBomRoutePreset.value
    if (!activePreset) return
    if (matchPlmTeamFilterPresetStateSnapshot(
      pickPlmTeamFilterPresetRouteOwnerState(activePreset.state),
      {
        field: bomFilterField.value,
        value: bomFilter.value,
      },
    )) {
      return
    }
    bomTeamPresetQuery.value = ''
    scheduleQuerySync({ bomTeamPreset: undefined })
  },
)

watch(
  () => [
    whereUsedTeamPresetQuery.value,
    activeWhereUsedRoutePreset.value?.id || '',
    JSON.stringify({
      field: whereUsedFilterField.value,
      value: whereUsedFilter.value,
      group: whereUsedFilterPresetGroup.value,
    }),
  ],
  ([presetId, activePresetId]) => {
    if (!presetId || !activePresetId) return
    const activePreset = activeWhereUsedRoutePreset.value
    if (!activePreset) return
    if (matchPlmTeamFilterPresetStateSnapshot(
      pickPlmTeamFilterPresetRouteOwnerState(activePreset.state),
      {
        field: whereUsedFilterField.value,
        value: whereUsedFilter.value,
      },
    )) {
      return
    }
    whereUsedTeamPresetQuery.value = ''
    scheduleQuerySync({ whereUsedTeamPreset: undefined })
  },
)

watch(
  () => [
    whereUsedFilter.value,
    whereUsedFilterField.value,
    compareFilter.value,
    substitutesFilter.value,
    bomFilter.value,
    bomFilterField.value,
  ],
  ([whereUsed, whereUsedField, compareValue, substituteValue, bomFilterValue, bomFilterFieldValue]) => {
    scheduleQuerySync({
      whereUsedFilter: whereUsed || undefined,
      whereUsedFilterField: resolvePlmFilterFieldQueryValue(whereUsed, whereUsedField),
      compareFilter: compareValue || undefined,
      substitutesFilter: substituteValue || undefined,
      bomFilter: bomFilterValue || undefined,
      bomFilterField: resolvePlmFilterFieldQueryValue(bomFilterValue, bomFilterFieldValue),
    })
  }
)

watch(
  bomItems,
  () => {
    applyBomCollapsedState(resolveBomCollapsedState())
  }
)

watch(bomCollapsed, (value) => {
  persistBomCollapsed(value)
  syncBomCollapsedQuery(value)
})

watch(
  bomCompare,
  () => {
    compareSelected.value = null
  }
)

watch(
  bomView,
  (value) => {
    if (value === 'tree') {
      applyBomCollapsedState(resolveBomCollapsedState())
    } else {
      syncBomCollapsedQuery(bomCollapsed.value)
    }
  }
)

watch(authState, (value) => {
  if (['valid', 'expiring'].includes(value)) {
    void refreshWorkbenchTeamViews()
    void refreshBomTeamPresets()
    void refreshWhereUsedTeamPresets()
    void refreshDocumentTeamViews()
    void refreshCadTeamViews()
    void refreshApprovalsTeamViews()
  }
  if (!compareSchema.value && !compareSchemaLoading.value && ['valid', 'expiring'].includes(value)) {
    void loadBomCompareSchema()
  }
})

watch(
  () => [authState.value, plmAuthState.value, plmAuthLegacy.value],
  () => {
    void warmApprovalActionability(approvals.value)
  },
)

watch(
  () => [
    productId.value,
    itemType.value,
    cadFileId.value,
    cadOtherFileId.value,
    cadReviewState.value,
    cadReviewNote.value,
    whereUsedItemId.value,
    whereUsedRecursive.value,
    whereUsedMaxLevels.value,
    compareLeftId.value,
    compareRightId.value,
    compareMode.value,
    compareLineKey.value,
    compareMaxLevels.value,
    compareIncludeChildFields.value,
    compareIncludeSubstitutes.value,
    compareIncludeEffectivity.value,
    compareSyncEnabled.value,
    compareEffectiveAt.value,
    compareRelationshipProps.value,
    bomDepth.value,
    bomEffectiveAt.value,
    bomLineId.value,
    bomView.value,
  ],
  ([
    productValue,
    itemTypeValue,
    cadFileValue,
    cadOtherValue,
    cadReviewStateValue,
    cadReviewNoteValue,
    whereUsedValue,
    whereUsedRecursiveValue,
    whereUsedLevelsValue,
    compareLeftValue,
    compareRightValue,
    compareModeValue,
    compareLineValue,
    compareMaxValue,
    compareChildValue,
    compareSubsValue,
    compareEffectValue,
    compareSyncValue,
    compareEffectiveValue,
    comparePropsValue,
    bomDepthValue,
    bomEffectiveValue,
    bomLineValue,
    bomViewValue,
  ]) => {
    scheduleQuerySync({
      productId: productValue || undefined,
      itemType: itemTypeValue !== DEFAULT_ITEM_TYPE ? itemTypeValue : undefined,
      cadTeamView: cadTeamViewQuery.value || undefined,
      cadFileId: cadFileValue || undefined,
      cadOtherFileId: cadOtherValue || undefined,
      cadReviewState: cadReviewStateValue || undefined,
      cadReviewNote: cadReviewNoteValue || undefined,
      whereUsedItemId: whereUsedValue || undefined,
      whereUsedRecursive: whereUsedRecursiveValue !== true ? whereUsedRecursiveValue : undefined,
      whereUsedMaxLevels:
        whereUsedLevelsValue !== DEFAULT_WHERE_USED_MAX_LEVELS ? whereUsedLevelsValue : undefined,
      compareLeftId: compareLeftValue || undefined,
      compareRightId: compareRightValue || undefined,
      compareMode: compareModeValue || undefined,
      compareLineKey: compareLineValue !== DEFAULT_COMPARE_LINE_KEY ? compareLineValue : undefined,
      compareMaxLevels:
        compareMaxValue !== DEFAULT_COMPARE_MAX_LEVELS ? compareMaxValue : undefined,
      compareIncludeChildFields:
        compareChildValue !== true ? compareChildValue : undefined,
      compareIncludeSubstitutes:
        compareSubsValue !== false ? compareSubsValue : undefined,
      compareIncludeEffectivity:
        compareEffectValue !== false ? compareEffectValue : undefined,
      compareSync: compareSyncValue !== true ? compareSyncValue : undefined,
      compareEffectiveAt: compareEffectiveValue || undefined,
      compareRelationshipProps:
        comparePropsValue !== DEFAULT_COMPARE_REL_PROPS ? comparePropsValue : undefined,
      bomDepth: bomDepthValue !== DEFAULT_BOM_DEPTH ? bomDepthValue : undefined,
      bomEffectiveAt: bomEffectiveValue || undefined,
      bomLineId: bomLineValue || undefined,
      bomView: bomViewValue !== 'table' ? bomViewValue : undefined,
    })
  }
)
</script>

<style scoped>
.plm-page {
  max-width: 1200px;
  margin: 24px auto 48px;
  padding: 0 24px;
  display: grid;
  gap: 20px;
}

.panel {
  background: #fff;
  border: 1px solid #e6e8eb;
  border-radius: 10px;
  padding: 20px 24px;
  box-shadow: 0 4px 12px rgba(30, 40, 60, 0.06);
}

.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.panel-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.deep-link-scope {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin: 8px 0 4px;
}

.deep-link-label {
  font-size: 12px;
  color: #6b7280;
}

.deep-link-option {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #374151;
}

.deep-link-option input {
  accent-color: #2563eb;
}

.deep-link-input {
  font-size: 12px;
  padding: 4px 8px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  background: #fff;
  color: #111827;
  min-width: 120px;
}

.deep-link-file {
  display: none;
}

.deep-link-drop {
  border: 1px dashed #cbd5f5;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  color: #4b5563;
  background: #f8fafc;
}

.deep-link-drop.active {
  border-color: #3b82f6;
  background: #eff6ff;
  color: #1d4ed8;
}

.deep-link-select {
  font-size: 12px;
  padding: 4px 8px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  background: #fff;
  color: #111827;
}

.toggle-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
  align-items: center;
  margin: 6px 0 14px;
}

.toggle-label {
  font-size: 12px;
  color: #6b7280;
  margin-right: 4px;
}

.panel h1 {
  font-size: 20px;
  margin-bottom: 4px;
}

.panel h2 {
  font-size: 18px;
}

.subtext {
  color: #6b7280;
  font-size: 13px;
}

.hint {
  color: #9ca3af;
  font-size: 12px;
  margin-top: 4px;
}

.auth-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.auth-status.secondary {
  margin-top: 4px;
}

.auth-label {
  font-size: 12px;
  color: #6b7280;
}

.auth-pill {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid transparent;
}

.auth-expiry {
  font-size: 12px;
  color: #6b7280;
}

.auth-valid {
  color: #14532d;
  background: #dcfce7;
  border-color: #bbf7d0;
}

.auth-expiring {
  color: #7c2d12;
  background: #ffedd5;
  border-color: #fed7aa;
}

.auth-expired,
.auth-invalid {
  color: #7f1d1d;
  background: #fee2e2;
  border-color: #fecaca;
}

.auth-missing {
  color: #1f2937;
  background: #f3f4f6;
  border-color: #e5e7eb;
}

.btn.ghost {
  background: transparent;
  border-color: #e5e7eb;
  color: #374151;
}

.field-inline {
  display: flex;
  gap: 6px;
  align-items: center;
}

.field-inline + .field-inline {
  margin-top: 6px;
}

.field-inline select {
  min-width: 120px;
}

.field-inline input {
  flex: 1;
  min-width: 0;
}

.field-actions {
  display: inline-flex;
  gap: 4px;
  flex-wrap: wrap;
}

.preset-manager {
  margin-top: 8px;
  padding: 8px;
  border: 1px dashed #e5e7eb;
  border-radius: 8px;
  background: #fafafa;
  display: grid;
  gap: 6px;
}

.preset-list {
  display: grid;
  gap: 4px;
  max-height: 160px;
  overflow: auto;
  padding-right: 4px;
}

.preset-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #374151;
}

.btn.danger {
  border-color: #fecaca;
  color: #b91c1c;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px 16px;
  align-items: end;
  margin-bottom: 12px;
}

.form-grid.compact {
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}

.checkbox-field {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.checkbox-field input {
  width: auto;
}

label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: #374151;
}

input, select, textarea {
  border: 1px solid #d0d7de;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 13px;
  background: #fff;
}

input:focus, select:focus, textarea:focus {
  outline: none;
  border-color: #1976d2;
  box-shadow: 0 0 0 2px rgba(25, 118, 210, 0.15);
}

.btn {
  border: 1px solid #d0d7de;
  border-radius: 6px;
  padding: 8px 14px;
  background: #f9fafb;
  cursor: pointer;
  font-size: 13px;
}

.btn.primary {
  background: #1976d2;
  color: #fff;
  border-color: #1976d2;
}

.btn:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.btn.mini {
  padding: 4px 8px;
  font-size: 12px;
}

.inline-actions {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}

.context-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin: 8px 0;
  font-size: 12px;
  color: #111827;
}

.context-title {
  font-weight: 600;
  color: #374151;
}

.context-divider {
  width: 1px;
  height: 16px;
  background: #e5e7eb;
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px 16px;
  margin-top: 12px;
}

.detail-grid span {
  display: block;
  font-size: 12px;
  color: #6b7280;
}

.description {
  margin-top: 12px;
  color: #4b5563;
}

.status {
  font-size: 13px;
  color: #374151;
  margin: 8px 0;
}

.status.error {
  color: #b91c1c;
}

.empty {
  color: #9ca3af;
  font-size: 13px;
  padding: 8px 0;
}

.empty-hint {
  margin-left: 6px;
  font-size: 12px;
  color: #9ca3af;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.data-table th,
.data-table td {
  border-bottom: 1px solid #eef0f2;
  padding: 8px 6px;
  text-align: left;
}

.data-table tbody tr {
  cursor: pointer;
}

.data-table tbody tr.row-selected {
  background: #f8fafc;
}

.where-used-tree,
.bom-tree {
  border: 1px solid #eef0f2;
  border-radius: 8px;
  overflow: hidden;
  margin-top: 8px;
}

.tree-row {
  display: grid;
  grid-template-columns: 1.6fr 1.2fr repeat(4, 0.6fr) 1fr 0.8fr;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  border-bottom: 1px solid #eef0f2;
  font-size: 12px;
}

.tree-row:not(.tree-header) {
  cursor: pointer;
}

.tree-row.selected {
  background: #eff6ff;
}

.tree-row:last-child {
  border-bottom: none;
}

.tree-header {
  background: #f8fafc;
  font-weight: 600;
  color: #374151;
}

.tree-cell {
  min-width: 0;
}

.tree-node {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.tree-node-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.tree-bom-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tree-bom-meta .btn {
  align-self: flex-start;
}

.tree-toggle {
  border: none;
  background: transparent;
  color: #4b5563;
  font-size: 12px;
  line-height: 1;
  padding: 0;
  width: 16px;
  height: 16px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.tree-toggle:disabled {
  cursor: default;
  color: #cbd5f5;
}

.tree-root .tree-toggle {
  color: #111827;
}

.tree-multi {
  margin-left: 4px;
  font-size: 11px;
  color: #6b7280;
}

.summary-row {
  display: flex;
  gap: 16px;
  font-size: 13px;
  color: #111827;
  padding: 6px 0 10px;
  flex-wrap: wrap;
}

.compare-section {
  margin-top: 12px;
}

.compare-section h3 {
  font-size: 14px;
  margin-bottom: 6px;
}

.compare-detail {
  margin-top: 12px;
  border: 1px solid #eef0f2;
  border-radius: 8px;
  padding: 10px 12px;
  background: #fdfdfd;
}

.compare-detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.compare-detail-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.compare-field-row.changed {
  background: #eef2ff;
}

.data-table.compact th,
.data-table.compact td {
  padding: 6px 6px;
  font-size: 12px;
}

.compare-row.compare-row-major {
  background: #fff1f2;
}

.compare-row.compare-row-minor {
  background: #fffbeb;
}

.compare-row.compare-row-info {
  background: #f8fafc;
}

.compare-row:hover {
  background: #eef2ff;
}

.json-block {
  margin-top: 12px;
  background: #f8fafc;
  border-radius: 8px;
  padding: 10px 12px;
}

.json-block summary {
  cursor: pointer;
  font-weight: 600;
  margin-bottom: 6px;
}

.json-block pre {
  margin: 0;
  font-size: 12px;
  white-space: pre-wrap;
  color: #1f2937;
}

.muted {
  color: #6b7280;
  font-size: 12px;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 12px;
}

.tag {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid transparent;
}

.severity-major {
  color: #7f1d1d;
  background: #fee2e2;
  border-color: #fecaca;
}

.severity-minor {
  color: #78350f;
  background: #ffedd5;
  border-color: #fed7aa;
}

.severity-info {
  color: #1e3a8a;
  background: #dbeafe;
  border-color: #bfdbfe;
}

.compare-kind-added {
  color: #065f46;
  background: #d1fae5;
  border-color: #a7f3d0;
}

.compare-kind-removed {
  color: #7f1d1d;
  background: #fee2e2;
  border-color: #fecaca;
}

.compare-kind-changed {
  color: #92400e;
  background: #fef3c7;
  border-color: #fde68a;
}

.status-neutral {
  color: #1f2937;
  background: #f3f4f6;
  border-color: #e5e7eb;
}

.status-approved {
  color: #14532d;
  background: #dcfce7;
  border-color: #bbf7d0;
}

.status-pending {
  color: #92400e;
  background: #fef3c7;
  border-color: #fde68a;
}

.status-rejected {
  color: #7f1d1d;
  background: #fee2e2;
  border-color: #fecaca;
}

.diff-list {
  display: grid;
  gap: 6px;
}

.diff-row {
  display: grid;
  grid-template-columns: auto auto 1fr;
  gap: 8px;
  align-items: center;
}

.diff-field {
  font-weight: 600;
  font-size: 12px;
}

.diff-field-code {
  color: #6b7280;
  font-weight: 500;
  font-size: 11px;
  margin-left: 4px;
}

.diff-field-meta {
  display: inline-flex;
  margin-left: 6px;
  font-size: 11px;
  color: #6b7280;
}

.diff-value {
  font-size: 12px;
  color: #111827;
}

.diff-value-left,
.diff-value-right {
  font-variant-numeric: tabular-nums;
}

.diff-arrow {
  margin: 0 6px;
  color: #9ca3af;
}

.field-map {
  margin-top: 12px;
  background: #f8fafc;
  border-radius: 8px;
  padding: 10px 12px;
}

.field-map summary {
  cursor: pointer;
  font-weight: 600;
  margin-bottom: 6px;
}

.inline-details {
  width: 100%;
}

.inline-details summary {
  cursor: pointer;
  font-size: 12px;
  color: #1f2937;
}

.inline-pre {
  margin: 6px 0 0;
  font-size: 12px;
  white-space: pre-wrap;
  color: #1f2937;
}

.cad-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  margin-top: 12px;
}

.cad-card {
  border: 1px solid #eef0f2;
  border-radius: 10px;
  padding: 12px;
  background: #fdfdfd;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cad-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.cad-textarea {
  min-height: 120px;
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}

.cad-span {
  grid-column: 1 / -1;
}

.path-list {
  margin-top: 6px;
  display: grid;
  gap: 6px;
}

.path-node {
  display: grid;
  grid-template-columns: auto auto 1fr;
  gap: 8px;
  align-items: center;
}

.path-index {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #e5e7eb;
  color: #111827;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
}

@media (max-width: 768px) {
  .panel {
    padding: 16px;
  }

  .panel-header {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
