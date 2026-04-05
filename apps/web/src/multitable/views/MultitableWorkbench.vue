<template>
  <div class="mt-workbench" @keydown="onGlobalKeydown">
    <MetaToast ref="toastRef" />
    <div v-if="grid.conflict.value" class="mt-workbench__conflict" role="alert">
      <div class="mt-workbench__conflict-copy">
        <strong>Update conflict</strong>
        <span>{{ conflictMessage }}</span>
      </div>
      <div class="mt-workbench__conflict-actions">
        <button class="mt-workbench__conflict-btn" @click="onReloadConflict">Reload latest</button>
        <button class="mt-workbench__conflict-btn mt-workbench__conflict-btn--primary" @click="onRetryConflict">Retry change</button>
        <button class="mt-workbench__conflict-btn" @click="grid.dismissConflict()">Dismiss</button>
      </div>
    </div>
    <div v-if="bases.length" class="mt-workbench__base-bar">
      <MetaBasePicker :bases="bases" :active-base-id="activeBaseId" :can-create="caps.canManageFields.value" @select="onSelectBase" @create="onCreateBase" />
    </div>
    <MetaViewTabBar :sheets="workbench.sheets.value" :views="visibleWorkbenchViews" :active-sheet-id="workbench.activeSheetId.value" :active-view-id="workbench.activeViewId.value" :can-create-sheet="caps.canManageFields.value" @select-sheet="onSelectSheet" @select-view="onSelectView" @create-sheet="onCreateSheet" />
    <div class="mt-workbench__actions">
      <div
        v-if="sheetPresenceState.activeCollaboratorCount.value > 0"
        class="mt-workbench__presence-chip"
        :title="sheetPresenceTitle"
      >
        &#x1F465; <strong>{{ sheetPresenceState.activeCollaboratorCount.value }}</strong>
        <span>{{ sheetPresenceLabel }}</span>
      </div>
      <button
        v-if="mentionInboxState.summary.value && mentionInboxState.summary.value.unresolvedMentionCount > 0"
        class="mt-workbench__mention-chip"
        :class="{ 'mt-workbench__mention-chip--unread': mentionInboxState.unreadMentionCount.value > 0 }"
        @click="onMentionChipClick"
      >
        &#x1F4EC; Mentions <strong>{{ mentionInboxState.unreadMentionCount.value || mentionInboxState.summary.value.unresolvedMentionCount }}</strong>
        <span v-if="mentionInboxState.unreadMentionCount.value > 0" class="mt-workbench__mention-chip-unread">{{ mentionInboxState.unreadMentionCount.value }} unread</span>
        <span class="mt-workbench__mention-chip-records">{{ mentionInboxState.summary.value.mentionedRecordCount }} records</span>
      </button>
      <button v-if="caps.canManageFields.value" class="mt-workbench__mgr-btn" @click="showFieldManager = true">&#x2699; Fields</button>
      <button v-if="caps.canManageViews.value && canConfigureCurrentView" class="mt-workbench__mgr-btn" @click="showViewManager = true">&#x2630; Views</button>
      <button v-if="caps.canManageAutomation.value" class="mt-workbench__mgr-btn" @click="openWorkflowDesigner()">&#x2699; Workflow</button>
    </div>
    <MetaMentionPopover
      :visible="showMentionPopover"
      :items="mentionInboxState.summary.value?.items ?? []"
      :rows="grid.rows.value"
      :fields="propertyVisibleGridFields"
      :display-field-id="mentionDisplayFieldId"
      @close="showMentionPopover = false"
      @select-record="onMentionPopoverSelect"
    />
    <MetaToolbar
      :fields="propertyVisibleGridFields" :hidden-field-ids="grid.hiddenFieldIds.value"
      :sort-rules="grid.sortRules.value" :filter-rules="grid.filterRules.value"
      :filter-conjunction="grid.filterConjunction.value"
      :can-create-record="caps.canCreateRecord.value" :can-undo="grid.canUndo.value" :can-redo="grid.canRedo.value"
      @toggle-field="grid.toggleFieldVisibility" @add-sort="grid.addSortRule" @remove-sort="grid.removeSortRule"
      @update-sort="onUpdateSort" @add-filter="grid.addFilterRule" @update-filter="grid.updateFilterRule"
      @remove-filter="grid.removeFilterRule" @clear-filters="onClearFilters" @set-conjunction="onSetConjunction"
      :group-field-id="grid.groupFieldId.value"
      :search-text="searchText" :total-rows="grid.page.value.total" :row-density="rowDensity"
      @apply-sort-filter="grid.applySortFilter" @add-record="onAddRecord" @undo="grid.undo" @redo="grid.redo"
      @set-group-field="grid.setGroupField" @export-csv="onExportCsv" @import="onOpenImportModal" @update:search-text="onSearchTextUpdate"
      @print="onPrint" @set-row-density="rowDensity = $event" @auto-fit-columns="onAutoFitColumns"
    />
    <div class="mt-workbench__content">
      <div class="mt-workbench__main">
        <MetaFormView
          v-if="activeViewType === 'form'"
          :fields="scopedAllFields" :hidden-field-ids="workbench.activeView.value?.hiddenFieldIds"
          :record="selectedRecordResolved" :loading="grid.loading.value"
          :read-only="formReadOnly"
          :field-permissions="effectiveFieldPermissions"
          :row-actions="effectiveRowActions"
          :submitting="formSubmitting"
          :success-message="formSuccessMessage"
          :error-message="formErrorMessage"
          :field-errors="formFieldErrors"
          :link-summaries-by-field="selectedRecordLinkSummaries"
          :attachment-summaries-by-field="selectedRecordAttachmentSummaries"
          :upload-fn="uploadAttachmentFn"
          :delete-attachment-fn="deleteAttachmentFn"
          :can-comment="effectiveRowActions.canComment"
          :comment-presence="selectedRecordCommentPresence"
          @submit="onFormSubmit" @open-link-picker="openLinkPicker" @update:dirty="formDirty = $event"
          @comment-field="onToggleFieldComments"
        />
        <MetaKanbanView
          v-else-if="activeViewType === 'kanban'"
          :rows="grid.rows.value" :fields="scopedAllFields" :loading="grid.loading.value"
          :group-info="workbench.activeView.value?.groupInfo"
          :view-config="workbench.activeView.value?.config"
          :link-summaries="grid.linkSummaries.value" :attachment-summaries="grid.attachmentSummaries.value"
          :can-create="caps.canCreateRecord.value" :can-edit="effectiveRowActions.canEdit"
          :can-comment="effectiveRowActions.canComment"
          :comment-presence="commentPresenceState.presenceByRecordId.value"
          @select-record="onSelectRecord" @patch-cell="onPatchCell" @create-record="onKanbanCreateRecord"
          @open-comments="onOpenRecordComments"
          @open-field-comments="onOpenGridFieldComments"
          @update-view-config="onPersistActiveViewConfig"
        />
        <MetaGalleryView
          v-else-if="activeViewType === 'gallery'"
          :rows="grid.rows.value" :fields="scopedAllFields" :loading="grid.loading.value"
          :view-config="workbench.activeView.value?.config"
          :link-summaries="grid.linkSummaries.value" :attachment-summaries="grid.attachmentSummaries.value"
          :can-create="caps.canCreateRecord.value"
          :current-page="grid.currentPage.value" :total-pages="grid.totalPages.value"
          :can-comment="effectiveRowActions.canComment"
          :comment-presence="commentPresenceState.presenceByRecordId.value"
          @select-record="onSelectRecord" @go-to-page="grid.goToPage" @create-record="onKanbanCreateRecord"
          @open-comments="onOpenRecordComments"
          @open-field-comments="onOpenGridFieldComments"
          @update-view-config="onPersistActiveViewConfig"
        />
        <MetaCalendarView
          v-else-if="activeViewType === 'calendar'"
          :rows="grid.rows.value" :fields="scopedAllFields" :loading="grid.loading.value"
          :view-config="workbench.activeView.value?.config"
          :link-summaries="grid.linkSummaries.value" :attachment-summaries="grid.attachmentSummaries.value"
          :can-create="caps.canCreateRecord.value"
          :can-comment="effectiveRowActions.canComment"
          :comment-presence="commentPresenceState.presenceByRecordId.value"
          @select-record="onSelectRecord" @create-record="onKanbanCreateRecord"
          @open-comments="onOpenRecordComments"
          @open-field-comments="onOpenGridFieldComments"
          @update-view-config="onPersistActiveViewConfig"
        />
        <MetaTimelineView
          v-else-if="activeViewType === 'timeline'"
          :rows="grid.rows.value" :fields="scopedAllFields" :loading="grid.loading.value"
          :view-config="workbench.activeView.value?.config"
          :link-summaries="grid.linkSummaries.value" :attachment-summaries="grid.attachmentSummaries.value"
          :can-create="caps.canCreateRecord.value" :can-edit="effectiveRowActions.canEdit"
          :can-comment="effectiveRowActions.canComment"
          :comment-presence="commentPresenceState.presenceByRecordId.value"
          @select-record="onSelectRecord" @create-record="onKanbanCreateRecord"
          @open-comments="onOpenRecordComments"
          @open-field-comments="onOpenGridFieldComments"
          @patch-dates="onTimelinePatchDates"
          @update-view-config="onPersistActiveViewConfig"
        />
        <MetaGridTable
          v-else
          :rows="grid.rows.value" :visible-fields="scopedGridFields" :sort-rules="grid.sortRules.value"
          :loading="grid.loading.value" :current-page="grid.currentPage.value" :total-pages="grid.totalPages.value"
          :start-index="pageStartIndex" :selected-record-id="selectedRecordId" :can-edit="effectiveRowActions.canEdit"
          :can-delete="effectiveRowActions.canDelete" :field-read-only-ids="readOnlyFieldIds" :column-widths="grid.columnWidths.value"
          :link-summaries="grid.linkSummaries.value" :attachment-summaries="grid.attachmentSummaries.value"
          :enable-multi-select="effectiveRowActions.canDelete"
          :group-field="grid.groupField.value"
          :search-text="searchText" :row-density="rowDensity"
          :upload-fn="uploadAttachmentFn"
          :delete-attachment-fn="deleteAttachmentFn"
          :can-comment="effectiveRowActions.canComment"
          :comment-presence="commentPresenceState.presenceByRecordId.value"
          @select-record="onSelectRecord" @toggle-sort="onToggleSort" @patch-cell="onPatchCell"
          @go-to-page="grid.goToPage" @open-link-picker="onGridLinkPicker" @resize-column="grid.setColumnWidth"
          @bulk-delete="onBulkDelete" @reorder-field="onReorderField"
          @open-comments="onOpenRecordComments"
          @open-field-comments="onOpenGridFieldComments"
        />
      </div>
      <MetaRecordDrawer
        :visible="!!selectedRecordId" :record="selectedRecordResolved" :fields="scopedAllFields"
        :can-edit="effectiveRowActions.canEdit" :can-comment="effectiveRowActions.canComment" :can-delete="effectiveRowActions.canDelete"
        :can-manage-automation="caps.canManageAutomation.value"
        :field-permissions="effectiveFieldPermissions"
        :row-actions="effectiveRowActions"
        :comment-presence="selectedRecordCommentPresence"
        :link-summaries-by-field="selectedRecordLinkSummaries"
        :attachment-summaries-by-field="selectedRecordAttachmentSummaries"
        :record-ids="drawerRecordIds"
        :upload-fn="uploadAttachmentFn"
        :delete-attachment-fn="deleteAttachmentFn"
        @close="onCloseDrawer" @delete="onDeleteRecord" @patch="onDrawerPatch"
        @toggle-comments="onToggleComments" @comment-field="onToggleFieldComments" @open-automation="openWorkflowDesigner(selectedRecordId ?? undefined)" @open-link-picker="openLinkPicker"
        @navigate="onDrawerNavigate"
      />
      <MetaCommentsDrawer
        :visible="showComments && !!selectedRecordId" :comments="commentsState.comments.value"
        :loading="commentsState.loading.value" :can-comment="effectiveRowActions.canComment" :can-resolve="effectiveRowActions.canComment"
        :highlighted-comment-id="highlightedCommentId"
        :unread-count="commentInboxState.unreadCount.value"
        :target-field-id="activeCommentFieldId"
        :scope-label="commentsScopeLabel"
        :reply-to-comment-id="selectedReplyCommentId"
        :editing-comment-id="selectedEditingCommentId"
        :draft="commentDraft" :submitting="commentsState.submitting.value" :error="commentsState.error.value"
        :resolving-ids="commentsState.resolvingIds.value"
        :updating-ids="commentsState.updatingIds.value"
        :deleting-ids="commentsState.deletingIds.value"
        :current-user-id="currentUserId"
        :mention-suggestions="commentMentionSuggestions"
        :composer-initial-mentions="commentComposerInitialMentions"
        @close="onCloseComments" @submit="onSubmitComment" @resolve="onResolveComment" @reply="onReplyToComment" @edit="onEditComment" @delete="onDeleteComment" @cancel-reply="onCancelCommentReply" @cancel-edit="onCancelCommentEdit" @update:draft="commentDraft = $event"
      />
    </div>
    <div v-if="showShortcuts" class="mt-workbench__shortcuts-overlay" @click.self="showShortcuts = false">
      <div class="mt-workbench__shortcuts">
        <div class="mt-workbench__shortcuts-header">
          <strong>Keyboard Shortcuts</strong>
          <button class="mt-workbench__shortcuts-close" @click="showShortcuts = false">&times;</button>
        </div>
        <div class="mt-workbench__shortcuts-grid">
          <div class="mt-workbench__shortcut"><kbd>&#x2191; &#x2193; &#x2190; &#x2192;</kbd><span>Navigate cells</span></div>
          <div class="mt-workbench__shortcut"><kbd>Enter</kbd><span>Edit cell</span></div>
          <div class="mt-workbench__shortcut"><kbd>Escape</kbd><span>Cancel edit / close</span></div>
          <div class="mt-workbench__shortcut"><kbd>Tab</kbd><span>Next cell</span></div>
          <div class="mt-workbench__shortcut"><kbd>Ctrl+C</kbd><span>Copy cell value</span></div>
          <div class="mt-workbench__shortcut"><kbd>Ctrl+V</kbd><span>Paste into cell</span></div>
          <div class="mt-workbench__shortcut"><kbd>Ctrl+Z</kbd><span>Undo</span></div>
          <div class="mt-workbench__shortcut"><kbd>Ctrl+Y</kbd><span>Redo</span></div>
          <div class="mt-workbench__shortcut"><kbd>?</kbd><span>Toggle this help</span></div>
        </div>
      </div>
    </div>
    <MetaImportModal
      :visible="showImportModal"
      :sheet-id="workbench.activeSheetId.value"
      :fields="importSurfaceFields"
      :field-resolvers="importFieldResolvers"
      :importing="importSubmitting"
      :result="importResult"
      @update:dirty="importDirty = $event"
      @close="closeImportModal"
      @cancel-import="cancelImport"
      @import="onBulkImport"
    />
    <MetaLinkPicker :visible="linkPickerVisible" :field="linkPickerField" :current-value="linkPickerCurrentValue"
      @close="linkPickerVisible = false" @confirm="onLinkPickerConfirm"
    />
    <MetaFieldManager
      :visible="showFieldManager" :fields="propertyVisibleWorkbenchFields" :sheets="workbench.sheets.value" :sheet-id="workbench.activeSheetId.value"
      @update:dirty="fieldManagerDirty = $event"
      @close="showFieldManager = false" @create-field="onCreateField" @update-field="onUpdateField" @delete-field="onDeleteField"
    />
    <MetaViewManager
      :visible="showViewManager" :views="workbench.views.value" :fields="propertyVisibleWorkbenchFields" :sheet-id="workbench.activeSheetId.value"
      :active-view-id="workbench.activeViewId.value"
      @update:dirty="viewManagerDirty = $event"
      @close="showViewManager = false" @create-view="onCreateView" @update-view="onUpdateView" @delete-view="onDeleteView"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '../../composables/useAuth'
import type {
  LinkedRecordSummary,
  MetaAttachment,
  MetaAttachmentDeleteFn,
  MetaAttachmentUploadContext,
  MetaAttachmentUploadFn,
  MetaCommentMentionSuggestion,
  MetaCommentsScope,
  MetaFieldPermission,
  MetaField,
  MetaFieldCreateType,
  MetaFieldType,
  MetaRecord,
  MetaRowActions,
  MetaViewPermission,
  RowDensity,
} from '../types'
import type { MultitableRole } from '../composables/useMultitableCapabilities'
import type { SortRule, FilterConjunction } from '../composables/useMultitableGrid'
import { useMultitableWorkbench } from '../composables/useMultitableWorkbench'
import { useMultitableGrid } from '../composables/useMultitableGrid'
import { useMultitableCapabilities } from '../composables/useMultitableCapabilities'
import { useMultitableComments } from '../composables/useMultitableComments'
import { useMultitableCommentPresence } from '../composables/useMultitableCommentPresence'
import { useMultitableCommentInbox } from '../composables/useMultitableCommentInbox'
import { useMultitableCommentInboxSummary } from '../composables/useMultitableCommentInboxSummary'
import { useMultitableCommentRealtime } from '../composables/useMultitableCommentRealtime'
import { useMultitableSheetPresence } from '../composables/useMultitableSheetPresence'
import { useMultitableSheetRealtime } from '../composables/useMultitableSheetRealtime'
import { subscribeToMultitableCommentSheetRealtime } from '../realtime/comments-realtime'
import MetaViewTabBar from '../components/MetaViewTabBar.vue'
import MetaToolbar from '../components/MetaToolbar.vue'
import MetaGridTable from '../components/MetaGridTable.vue'
import MetaFormView from '../components/MetaFormView.vue'
import MetaRecordDrawer from '../components/MetaRecordDrawer.vue'
import MetaCommentsDrawer from '../components/MetaCommentsDrawer.vue'
import MetaLinkPicker from '../components/MetaLinkPicker.vue'
import MetaFieldManager from '../components/MetaFieldManager.vue'
import MetaViewManager from '../components/MetaViewManager.vue'
import MetaBasePicker from '../components/MetaBasePicker.vue'
import MetaKanbanView from '../components/MetaKanbanView.vue'
import MetaGalleryView from '../components/MetaGalleryView.vue'
import MetaCalendarView from '../components/MetaCalendarView.vue'
import MetaTimelineView from '../components/MetaTimelineView.vue'
import MetaToast from '../components/MetaToast.vue'
import MetaImportModal from '../components/MetaImportModal.vue'
import MetaMentionPopover from '../components/MetaMentionPopover.vue'
import type { MetaBase } from '../types'
import { bulkImportRecords, skipDuplicateImportRows } from '../import/bulk-import'
import { extractImportTokens, type ImportBuildFailure, type ImportBuildResult, type ImportValueResolver } from '../import/delimited'
import { filterPropertyVisibleFields } from '../utils/field-permissions'
import { isLinkField, isPersonField } from '../utils/link-fields'
import { addPeopleLookupToken, inferPeopleLookupKind, resolvePeopleImportValue } from '../utils/people-import'

const props = defineProps<{ sheetId?: string; viewId?: string; baseId?: string; recordId?: string; commentId?: string; fieldId?: string; openComments?: boolean; mode?: string; role?: MultitableRole }>()
const emit = defineEmits<{
  (e: 'ready', payload: { baseId: string; sheetId: string; viewId: string }): void
  (e: 'external-context-result', payload: {
    status: 'applied' | 'failed' | 'superseded'
    context: { baseId: string; sheetId: string; viewId: string }
    reason?: 'sync-failed' | 'superseded'
    requestId?: string | number
  }): void
}>()

const role = ref<MultitableRole>(props.role ?? 'editor')
const router = useRouter()
const auth = useAuth()
const workbench = useMultitableWorkbench({ initialBaseId: props.baseId, initialSheetId: props.sheetId, initialViewId: props.viewId })
const capabilitySource = computed(() => workbench.capabilities.value ?? role.value)
const caps = useMultitableCapabilities(capabilitySource)
const grid = useMultitableGrid({ sheetId: workbench.activeSheetId, viewId: workbench.activeViewId })
const commentsState = useMultitableComments()
const commentPresenceState = useMultitableCommentPresence()
const commentInboxState = useMultitableCommentInbox()
const mentionInboxState = useMultitableCommentInboxSummary()
const sheetPresenceState = useMultitableSheetPresence({
  sheetId: computed(() => workbench.activeSheetId.value || undefined),
})

const selectedRecordId = ref<string | null>(null)
const showComments = ref(false)
const selectedCommentFieldId = ref<string | null>(null)
const selectedReplyCommentId = ref<string | null>(null)
const selectedEditingCommentId = ref<string | null>(null)
const showMentionPopover = ref(false)
const linkPickerVisible = ref(false)
const linkPickerField = ref<MetaField | null>(null)
const linkPickerRecordId = ref<string | null>(null)
const linkPickerCurrentValue = ref<unknown>(null)
const showFieldManager = ref(false)
const showViewManager = ref(false)
const bases = ref<MetaBase[]>([])
const activeBaseId = computed(() => workbench.activeBaseId.value)
const toastRef = ref<InstanceType<typeof MetaToast> | null>(null)
const commentDraft = ref('')
const currentUserId = ref<string | null>(null)
const commentMentionSuggestions = ref<MetaCommentMentionSuggestion[]>([])
const commentMentionSuggestionsLoadedForSheetId = ref<string | null>(null)
const searchText = ref('')
const showShortcuts = ref(false)
const showImportModal = ref(false)
const importSubmitting = ref(false)
const importAbortController = ref<AbortController | null>(null)
const formDirty = ref(false)
const fieldManagerDirty = ref(false)
const viewManagerDirty = ref(false)
const importDirty = ref(false)
const pendingExternalContext = ref<{ context: { baseId: string; sheetId: string; viewId: string }; requestId?: string | number } | null>(null)
const pendingExternalContextReason = ref<Extract<ExternalContextSyncReason, 'busy' | 'unsaved-drafts'> | null>(null)
const pendingExternalContextNoticeKey = ref('')
type ExternalContextSyncStatus = 'applied' | 'deferred' | 'blocked' | 'failed' | 'superseded'
type ExternalContextSyncReason = 'busy' | 'unsaved-drafts' | 'user-cancelled' | 'sync-failed' | 'superseded'
type ExternalContextSyncResult = {
  status: ExternalContextSyncStatus
  context: { baseId: string; sheetId: string; viewId: string }
  reason?: ExternalContextSyncReason
  requestId?: string | number
}
type ImportFailure = ImportBuildFailure & { rowIndex: number; retryable?: boolean; skipped?: boolean }
type ImportResult = {
  attempted: number
  succeeded: number
  failed: number
  skipped: number
  firstError: string | null
  failures: ImportFailure[]
}
const importResult = ref<ImportResult | null>(null)
const rowDensity = ref<RowDensity>('normal')
const peopleResolverCache = new Map<string, Promise<ImportValueResolver | null>>()
const linkResolverCache = new Map<string, Map<string, Promise<string[] | null>>>()
const formSubmitting = ref(false)
const formSuccessMessage = ref<string | null>(null)
const formErrorMessage = ref<string | null>(null)
const formFieldErrors = ref<Record<string, string>>({})
const deepLinkedRecordLinkSummaries = ref<Record<string, LinkedRecordSummary[]>>({})
const deepLinkedRecordAttachmentSummaries = ref<Record<string, MetaAttachment[]>>({})
const deepLinkedRecordCommentsScope = ref<MetaCommentsScope | null>(null)
const deepLinkedRecordFieldPermissions = ref<Record<string, MetaFieldPermission>>({})
const deepLinkedRecordViewPermissions = ref<Record<string, MetaViewPermission>>({})
const deepLinkedRecordRowActions = ref<MetaRowActions | null>(null)
const standaloneFormFieldPermissions = ref<Record<string, MetaFieldPermission>>({})
const standaloneFormViewPermissions = ref<Record<string, MetaViewPermission>>({})
const standaloneFormRowActions = ref<MetaRowActions | null>(null)
const highlightedCommentId = ref<string | null>(props.commentId ?? null)
const workbenchReady = ref(false)
let dialogMetaRefreshTimer: number | null = null
let dialogMetaRefreshInFlight = false
let dialogMetaRefreshQueued = false
let standaloneFormLoadVersion = 0
let unsubscribeMentionRealtime: (() => void) | null = null

function showError(msg: string) {
  workbench.error.value = null
  toastRef.value?.showError(msg)
}

function showSuccess(msg: string) {
  toastRef.value?.showSuccess(msg)
}

function ensureCanCreateRecord(): boolean {
  if (caps.canCreateRecord.value) return true
  showError('Record creation is not allowed in this view.')
  return false
}

function ensureCanEditRecord(): boolean {
  if (effectiveRowActions.value.canEdit) return true
  showError('Record editing is not allowed for this row.')
  return false
}

function ensureCanDeleteRecord(): boolean {
  if (effectiveRowActions.value.canDelete) return true
  showError('Record deletion is not allowed for this row.')
  return false
}

const activeViewType = computed(() => {
  if (props.mode === 'form') return 'form'
  if (props.mode === 'grid') return 'grid'
  return workbench.activeView.value?.type ?? 'grid'
})
const effectiveViewPermissions = computed<Record<string, MetaViewPermission>>(() => {
  const merged: Record<string, MetaViewPermission> = { ...workbench.viewPermissions.value }
  if (workbench.activeViewId.value && grid.viewPermission.value) {
    merged[workbench.activeViewId.value] = grid.viewPermission.value
  }
  Object.assign(merged, standaloneFormViewPermissions.value)
  Object.assign(merged, deepLinkedRecordViewPermissions.value)
  return merged
})
const currentViewPermission = computed<MetaViewPermission | null>(() => {
  const activeViewId = workbench.activeViewId.value
  return activeViewId ? effectiveViewPermissions.value[activeViewId] ?? null : null
})
const mentionDisplayFieldId = computed(() =>
  grid.visibleFields.value.find((field) => field.type === 'string')?.id
  ?? grid.fields.value.find((field) => field.type === 'string')?.id
  ?? null,
)
const canConfigureCurrentView = computed(() => currentViewPermission.value?.canConfigure ?? true)
const visibleWorkbenchViews = computed(() =>
  workbench.views.value.filter((view) => effectiveViewPermissions.value[view.id]?.canAccess !== false),
)
const effectiveFieldPermissions = computed<Record<string, MetaFieldPermission>>(() => {
  if (deepLinkedRecord.value?.id === selectedRecordId.value && Object.keys(deepLinkedRecordFieldPermissions.value).length > 0) {
    return deepLinkedRecordFieldPermissions.value
  }
  if (activeViewType.value === 'form' && Object.keys(standaloneFormFieldPermissions.value).length > 0) {
    return standaloneFormFieldPermissions.value
  }
  if (Object.keys(grid.fieldPermissions.value).length > 0) {
    return grid.fieldPermissions.value
  }
  return workbench.fieldPermissions.value
})
const effectiveRowActions = computed<MetaRowActions>(() => {
  if (deepLinkedRecord.value?.id === selectedRecordId.value && deepLinkedRecordRowActions.value) {
    return deepLinkedRecordRowActions.value
  }
  if (activeViewType.value === 'form' && standaloneFormRowActions.value) {
    return standaloneFormRowActions.value
  }
  return grid.rowActions.value ?? {
    canEdit: caps.canEditRecord.value,
    canDelete: caps.canDeleteRecord.value,
    canComment: caps.canComment.value,
  }
})
const scopedAllFields = computed(() =>
  grid.fields.value.filter((field) => effectiveFieldPermissions.value[field.id]?.visible !== false),
)
const scopedGridFields = computed(() =>
  grid.visibleFields.value.filter((field) => effectiveFieldPermissions.value[field.id]?.visible !== false),
)
const readOnlyFieldIds = computed(() =>
  Object.entries(effectiveFieldPermissions.value)
    .filter(([, permission]) => permission.readOnly)
    .map(([fieldId]) => fieldId),
)
const importSurfaceFields = computed(() =>
  propertyVisibleGridFields.value.filter((field) => {
    const permission = effectiveFieldPermissions.value[field.id]
    return permission?.visible !== false && permission?.readOnly !== true
  }),
)
const importFieldResolvers = computed<Record<string, ImportValueResolver>>(() => {
  const resolvers: Record<string, ImportValueResolver> = {}
  for (const field of importSurfaceFields.value) {
    if (!isLinkField(field)) continue
    resolvers[field.id] = async (rawValue, currentField) => {
      if (isPersonField(currentField)) {
        const resolver = await getPeopleResolver(currentField)
        return resolver ? resolver(rawValue, currentField) : null
      }
      return resolveLinkedImportValue(rawValue, currentField)
    }
  }
  return resolvers
})
const formReadOnly = computed(() => {
  return selectedRecordResolved.value ? !effectiveRowActions.value.canEdit : !caps.canCreateRecord.value
})
const pageStartIndex = computed(() => grid.page.value.offset)
const selectedRecordLinkSummaries = computed<Record<string, LinkedRecordSummary[]>>(() => {
  const recordId = selectedRecordId.value
  if (!recordId) return {}
  const fromGrid = grid.linkSummaries.value[recordId]
  if (fromGrid) return fromGrid
  if (deepLinkedRecord.value?.id === recordId) return deepLinkedRecordLinkSummaries.value
  return {}
})

const selectedRecordAttachmentSummaries = computed<Record<string, MetaAttachment[]>>(() => {
  const recordId = selectedRecordId.value
  if (!recordId) return {}
  const fromGrid = grid.attachmentSummaries.value[recordId]
  if (fromGrid) return fromGrid
  if (deepLinkedRecord.value?.id === recordId) return deepLinkedRecordAttachmentSummaries.value
  return {}
})
const visibleCommentPresenceRecordIds = computed(() => {
  const nextIds = grid.rows.value.map((row) => row.id)
  if (selectedRecordId.value && !nextIds.includes(selectedRecordId.value)) {
    nextIds.push(selectedRecordId.value)
  }
  return nextIds
})
const structuralRealtimeFieldIds = computed(() => {
  const next = new Set<string>()
  for (const rule of grid.sortRules.value) {
    if (rule.fieldId) next.add(rule.fieldId)
  }
  for (const rule of grid.filterRules.value) {
    if (rule.fieldId) next.add(rule.fieldId)
  }
  if (grid.groupFieldId.value) next.add(grid.groupFieldId.value)
  return [...next]
})

function isCellRealtimeLocallyPatchable(fieldId: string): boolean {
  const field = grid.fields.value.find((candidate) => candidate.id === fieldId)
  if (!field) return false
  return !['link', 'attachment', 'lookup', 'rollup', 'formula'].includes(field.type)
}

function patchDeepLinkedRealtimeRecord(recordId: string, version: number | undefined, patch: Record<string, unknown>): boolean {
  if (deepLinkedRecord.value?.id !== recordId) return false
  deepLinkedRecord.value = {
    ...deepLinkedRecord.value,
    version: typeof version === 'number' ? version : deepLinkedRecord.value.version,
    data: {
      ...deepLinkedRecord.value.data,
      ...patch,
    },
  }
  return true
}

const selectedRecordCommentPresence = computed(() => (
  selectedRecordId.value ? commentPresenceState.presenceByRecordId.value[selectedRecordId.value] ?? null : null
))
const selectedRecordCommentsScope = computed<MetaCommentsScope | null>(() => {
  if (!selectedRecordId.value || !workbench.activeSheetId.value) return null
  if (deepLinkedRecord.value?.id === selectedRecordId.value && deepLinkedRecordCommentsScope.value) {
    return deepLinkedRecordCommentsScope.value
  }
  return {
    targetType: 'meta_record',
    targetId: selectedRecordId.value,
    baseId: workbench.activeBaseId.value || null,
    sheetId: workbench.activeSheetId.value || null,
    viewId: workbench.activeViewId.value || null,
    recordId: selectedRecordId.value,
    containerType: 'meta_sheet',
    containerId: workbench.activeSheetId.value,
  }
})
const activeCommentFieldId = computed(() => selectedCommentFieldId.value ?? selectedRecordCommentsScope.value?.targetFieldId ?? null)
const selectedCommentField = computed<MetaField | null>(() => {
  const fieldId = activeCommentFieldId.value
  if (!fieldId) return null
  return grid.fields.value.find((field) => field.id === fieldId) ?? null
})
const commentsScopeLabel = computed(() => selectedCommentField.value?.name ?? null)
const activeEditingComment = computed(() => (
  selectedEditingCommentId.value
    ? commentsState.comments.value.find((comment) => comment.id === selectedEditingCommentId.value) ?? null
    : null
))
const commentComposerInitialMentions = computed(() => (
  activeEditingComment.value ? buildEditingMentionSuggestions(activeEditingComment.value) : []
))
const sheetPresenceLabel = computed(() => (
  sheetPresenceState.activeCollaboratorCount.value === 1 ? 'active collaborator' : 'active collaborators'
))
const sheetPresenceTitle = computed(() => {
  const ids = sheetPresenceState.activeCollaborators.value.map((user) => user.id)
  return ids.length > 0 ? ids.join(', ') : 'No active collaborators'
})
const conflictFieldName = computed(() => {
  const fieldId = grid.conflict.value?.fieldId
  if (!fieldId) return 'cell'
  return grid.fields.value.find((field) => field.id === fieldId)?.name ?? fieldId
})
const conflictMessage = computed(() => {
  const current = grid.conflict.value
  if (!current) return ''
  const versionPart = typeof current.serverVersion === 'number' ? ` Latest version is ${current.serverVersion}.` : ''
  return `${conflictFieldName.value} changed elsewhere.${versionPart} Reload the row or retry your edit.`
})
const hasUnsavedWorkbenchDrafts = computed(() => (
  formDirty.value ||
  fieldManagerDirty.value ||
  viewManagerDirty.value ||
  importDirty.value ||
  commentDraft.value.trim().length > 0
))
const hasCommentDraft = computed(() => commentDraft.value.trim().length > 0)
const hasRecordScopedDrafts = computed(() => formDirty.value || hasCommentDraft.value)
const hasBlockingUnloadState = computed(() => (
  hasUnsavedWorkbenchDrafts.value ||
  formSubmitting.value ||
  importSubmitting.value
))
const currentBlockingReason = computed<Extract<ExternalContextSyncReason, 'busy' | 'unsaved-drafts'> | null>(() => {
  if (formSubmitting.value || importSubmitting.value) return 'busy'
  if (hasUnsavedWorkbenchDrafts.value) return 'unsaved-drafts'
  return null
})

function applyLocalLinkSummaries(recordId: string, fieldId: string, summaries: LinkedRecordSummary[]) {
  grid.linkSummaries.value = {
    ...grid.linkSummaries.value,
    [recordId]: {
      ...(grid.linkSummaries.value[recordId] ?? {}),
      [fieldId]: summaries,
    },
  }
  if (deepLinkedRecord.value?.id === recordId) {
    deepLinkedRecordLinkSummaries.value = {
      ...deepLinkedRecordLinkSummaries.value,
      [fieldId]: summaries,
    }
  }
}

function pushUniqueIds(target: string[], ids: string[]) {
  for (const id of ids) {
    if (!target.includes(id)) target.push(id)
  }
}

function resetCommentInteractionState() {
  selectedCommentFieldId.value = null
  selectedReplyCommentId.value = null
  selectedEditingCommentId.value = null
  commentDraft.value = ''
  highlightedCommentId.value = null
}

function parseCommentMentionTokens(content: string): MetaCommentMentionSuggestion[] {
  const seen = new Set<string>()
  const mentions: MetaCommentMentionSuggestion[] = []
  for (const match of content.matchAll(/@\[([^\]]+)\]\(([^)]+)\)/g)) {
    const label = match[1]?.trim()
    const id = match[2]?.trim()
    if (!label || !id || seen.has(id)) continue
    seen.add(id)
    mentions.push({ id, label })
  }
  return mentions
}

function formatCommentDraftContent(content: string): string {
  return content.replace(/@\[([^\]]+)\]\(([^)]+)\)/g, (_match, label) => `@${label}`)
}

function buildEditingMentionSuggestions(comment: { content: string; mentions: string[] }): MetaCommentMentionSuggestion[] {
  const byId = new Map<string, MetaCommentMentionSuggestion>()
  for (const token of parseCommentMentionTokens(comment.content)) {
    byId.set(token.id, token)
  }
  for (const suggestion of commentMentionSuggestions.value) {
    if (byId.has(suggestion.id)) {
      byId.set(suggestion.id, { ...suggestion })
    }
  }
  for (const mentionId of comment.mentions) {
    if (byId.has(mentionId)) continue
    const suggestion = commentMentionSuggestions.value.find((item) => item.id === mentionId)
    byId.set(mentionId, suggestion ? { ...suggestion } : { id: mentionId, label: mentionId })
  }
  return [...byId.values()]
}

function normalizeImportLookupKey(value: string): string {
  return value.trim().toLowerCase()
}

function getImportPrimaryField(records: Array<Record<string, unknown>>) {
  const importedFieldIds = new Set(records.flatMap((record) => Object.keys(record)))
  // The current multitable model does not expose an explicit primary-key field yet,
  // so import dedupe follows the first mapped field in sheet order.
  return [...grid.fields.value]
    .sort((left, right) => Number(left.order ?? 0) - Number(right.order ?? 0))
    .find((field) => importedFieldIds.has(field.id)) ?? null
}

async function loadAllRecordSummaries(sheetId: string, displayFieldId: string) {
  const records: LinkedRecordSummary[] = []
  const displayMap: Record<string, string> = {}
  let offset = 0
  const limit = 200

  for (;;) {
    const page = await workbench.client.listRecordSummaries({
      sheetId,
      displayFieldId,
      limit,
      offset,
    })
    records.push(...(page.records ?? []))
    Object.assign(displayMap, page.displayMap ?? {})
    if (!page.page?.hasMore) break
    offset += limit
  }

  return { records, displayMap }
}

async function getPeopleResolver(field: MetaField): Promise<ImportValueResolver | null> {
  if (!isPersonField(field)) return null
  const targetSheetId = typeof field.property?.foreignSheetId === 'string' ? field.property.foreignSheetId.trim() : ''
  if (!targetSheetId) return null

  const existing = peopleResolverCache.get(targetSheetId)
  if (existing) return existing

  const promise = (async () => {
    const { fields } = await workbench.client.listFields(targetSheetId)
    const stringFields = fields.filter((targetField) => targetField.type === 'string')
    const emailFieldIds = stringFields.filter((targetField) => inferPeopleLookupKind(targetField.name) === 'email').map((targetField) => targetField.id)
    const nameFieldIds = stringFields.filter((targetField) => inferPeopleLookupKind(targetField.name) === 'name').map((targetField) => targetField.id)
    const aliasFieldIds = stringFields.filter((targetField) => inferPeopleLookupKind(targetField.name) === 'alias').map((targetField) => targetField.id)
    const fallbackAliasFieldId = stringFields.find(
      (targetField) => !emailFieldIds.includes(targetField.id) && !nameFieldIds.includes(targetField.id),
    )?.id

    const recordIdLookup = new Map<string, string | null>()
    const emailLookup = new Map<string, string | null>()
    const nameLookup = new Map<string, string | null>()
    const aliasLookup = new Map<string, string | null>()

    async function hydrateLookup(fieldIds: string[], targetLookup: Map<string, string | null>) {
      await Promise.all(fieldIds.map(async (displayFieldId) => {
        const summary = await loadAllRecordSummaries(targetSheetId, displayFieldId)
        for (const record of summary.records ?? []) {
          addPeopleLookupToken(recordIdLookup, record.id, record.id)
          addPeopleLookupToken(targetLookup, record.display, record.id)
        }
        for (const [recordId, display] of Object.entries(summary.displayMap ?? {})) {
          addPeopleLookupToken(recordIdLookup, recordId, recordId)
          addPeopleLookupToken(targetLookup, display, recordId)
        }
      }))
    }

    await Promise.all([
      hydrateLookup(emailFieldIds, emailLookup),
      hydrateLookup(nameFieldIds, nameLookup),
      hydrateLookup(
        [
          ...aliasFieldIds,
          ...(fallbackAliasFieldId && !aliasFieldIds.includes(fallbackAliasFieldId) ? [fallbackAliasFieldId] : []),
        ],
        aliasLookup,
      ),
    ])

    return async (rawValue: string, currentField?: MetaField) =>
      resolvePeopleImportValue({
        rawValue,
        currentField,
        lookups: {
          recordId: recordIdLookup,
          email: emailLookup,
          name: nameLookup,
          alias: aliasLookup,
        },
      })
  })().catch((error) => {
    peopleResolverCache.delete(targetSheetId)
    throw error
  })

  peopleResolverCache.set(targetSheetId, promise)
  return promise
}

async function resolveLinkToken(field: MetaField, token: string): Promise<string[] | null> {
  const normalizedToken = normalizeImportLookupKey(token)
  if (!normalizedToken) return null
  let cacheForField = linkResolverCache.get(field.id)
  if (!cacheForField) {
    cacheForField = new Map()
    linkResolverCache.set(field.id, cacheForField)
  }
  const existing = cacheForField.get(normalizedToken)
  if (existing) return existing

  const promise = (async () => {
    const data = await workbench.client.listLinkOptions(field.id, {
      search: token,
      limit: 50,
      offset: 0,
    })
    const exact = [...(data.selected ?? []), ...(data.records ?? [])].filter((record) => {
      const recordId = normalizeImportLookupKey(record.id)
      const display = normalizeImportLookupKey(record.display ?? '')
      return recordId === normalizedToken || display === normalizedToken
    })
    const uniqueIds = [...new Set(exact.map((record) => record.id))]
    if (uniqueIds.length > 1) {
      throw new Error(`Multiple linked records match "${token}" for ${field.name}. Use a more specific value or repair it with the picker.`)
    }
    return uniqueIds.length ? uniqueIds : null
  })().catch((error) => {
    cacheForField?.delete(normalizedToken)
    throw error
  })

  cacheForField.set(normalizedToken, promise)
  return promise
}

async function resolveLinkedImportValue(rawValue: string, field: MetaField): Promise<string[] | null> {
  const tokens = extractImportTokens(rawValue)
  if (!tokens.length) return null
  const resolvedIds: string[] = []
  for (const token of tokens) {
    const matches = await resolveLinkToken(field, token)
    if (matches?.length) pushUniqueIds(resolvedIds, matches)
  }
  if (!resolvedIds.length) return null
  if (field.property?.limitSingleRecord === true && resolvedIds.length > 1) {
    throw new Error(`Linked field only allows one record: ${rawValue}`)
  }
  return resolvedIds
}

const propertyVisibleWorkbenchFields = computed(() => filterPropertyVisibleFields(workbench.fields.value))
const propertyVisibleGridFields = computed(() => filterPropertyVisibleFields(grid.fields.value))

const uploadAttachmentFn: MetaAttachmentUploadFn = async (file: File, context?: MetaAttachmentUploadContext) =>
  workbench.client.uploadAttachment(file, {
    sheetId: workbench.activeSheetId.value || undefined,
    recordId: context?.recordId,
    fieldId: context?.fieldId,
  })

const deleteAttachmentFn: MetaAttachmentDeleteFn = async (attachmentId: string, context?: MetaAttachmentUploadContext) => {
  await workbench.client.deleteAttachment(attachmentId)
  if (context?.recordId && selectedRecordId.value === context.recordId) {
    const updatedIds = (selectedRecordResolved.value?.data[context.fieldId ?? ''] as unknown[] | undefined)
      ?.map(String)
      .filter((id) => id !== attachmentId) ?? []
    if (deepLinkedRecord.value?.id === context.recordId && context.fieldId) {
      deepLinkedRecord.value = {
        ...deepLinkedRecord.value,
        version: deepLinkedRecord.value.version + 1,
        data: {
          ...deepLinkedRecord.value.data,
          [context.fieldId]: updatedIds,
        },
      }
      deepLinkedRecordAttachmentSummaries.value = {
        ...deepLinkedRecordAttachmentSummaries.value,
        [context.fieldId]: (deepLinkedRecordAttachmentSummaries.value[context.fieldId] ?? []).filter((item) => item.id !== attachmentId),
      }
    }
  }
  await grid.loadViewData(grid.page.value.offset)
}

async function loadCommentsForRecord(recordId: string, options?: { highlightCommentId?: string | null; markReadCommentId?: string | null }) {
  if (!workbench.activeSheetId.value) return
  const scope = deepLinkedRecord.value?.id === recordId && deepLinkedRecordCommentsScope.value
    ? deepLinkedRecordCommentsScope.value
    : {
      targetType: 'meta_record',
      targetId: recordId,
      baseId: workbench.activeBaseId.value || null,
      sheetId: workbench.activeSheetId.value || null,
      viewId: workbench.activeViewId.value || null,
      recordId,
      containerType: 'meta_sheet',
      containerId: workbench.activeSheetId.value,
    }
  await Promise.all([
    commentsState.loadComments(scope),
    ensureCommentMentionSuggestions(),
  ])
  highlightedCommentId.value = options?.highlightCommentId ?? null
  if (options?.markReadCommentId) {
    await workbench.client.markCommentRead(options.markReadCommentId).catch(() => undefined)
    await commentInboxState.refreshUnreadCount().catch(() => undefined)
  }
}

async function ensureCommentMentionSuggestions(force = false) {
  const sheetId = workbench.activeSheetId.value
  if (!sheetId) {
    commentMentionSuggestions.value = []
    commentMentionSuggestionsLoadedForSheetId.value = null
    return
  }
  if (!force && commentMentionSuggestionsLoadedForSheetId.value === sheetId) return

  try {
    const result = await workbench.client.listCommentMentionSuggestions({
      spreadsheetId: sheetId,
      limit: 100,
    })
    if (workbench.activeSheetId.value !== sheetId) return
    commentMentionSuggestions.value = result.items
    commentMentionSuggestionsLoadedForSheetId.value = sheetId
  } catch {
    if (workbench.activeSheetId.value !== sheetId) return
    commentMentionSuggestions.value = []
    commentMentionSuggestionsLoadedForSheetId.value = null
  }
}

async function selectRecord(recordId: string, opts?: { openComments?: boolean; highlightCommentId?: string | null; markReadCommentId?: string | null; targetFieldId?: string | null }) {
  if (recordId !== selectedRecordId.value && !confirmDiscardRecordChanges()) return
  selectedRecordId.value = recordId
  commentDraft.value = ''
  if (!opts?.openComments) {
    selectedCommentFieldId.value = null
    selectedReplyCommentId.value = null
    selectedEditingCommentId.value = null
  } else {
    selectedCommentFieldId.value = opts.targetFieldId ?? null
    selectedReplyCommentId.value = null
    selectedEditingCommentId.value = null
  }
  showComments.value = opts?.openComments === true
  await loadCommentsForRecord(recordId, {
    highlightCommentId: opts?.openComments ? (opts.highlightCommentId ?? null) : null,
    markReadCommentId: opts?.markReadCommentId ?? null,
  })
}

function onSelectRecord(recordId: string) {
  void selectRecord(recordId)
}

function onMentionChipClick() {
  showMentionPopover.value = !showMentionPopover.value
}

async function onMentionPopoverSelect(payload: { rowId: string; fieldId: string | null; mentionedFieldIds: string[] }) {
  showMentionPopover.value = false
  await selectRecord(payload.rowId, { openComments: true })
  if (payload.fieldId) {
    selectedCommentFieldId.value = payload.fieldId
    selectedReplyCommentId.value = null
  }
  if (workbench.activeSheetId.value) {
    await mentionInboxState.markRead({ spreadsheetId: workbench.activeSheetId.value })
  }
}

function onToggleSort(fieldId: string) {
  const ex = grid.sortRules.value.find((r) => r.fieldId === fieldId)
  if (!ex) grid.addSortRule({ fieldId, direction: 'asc' })
  else if (ex.direction === 'asc') grid.addSortRule({ fieldId, direction: 'desc' })
  else grid.removeSortRule(fieldId)
  grid.applySortFilter()
}

function onUpdateSort(index: number, rule: SortRule) {
  grid.sortRules.value[index] = rule; grid.sortFilterDirty.value = true
}

function onSearchTextUpdate(text: string) {
  searchText.value = text
  grid.setSearchQuery(text)
}

function onClearFilters() { grid.clearFilters(); grid.applySortFilter() }
function onSetConjunction(c: FilterConjunction) { grid.filterConjunction.value = c; grid.sortFilterDirty.value = true }

async function onPatchCell(recordId: string, fieldId: string, value: unknown, version: number) {
  if (!ensureCanEditRecord()) return
  await grid.patchCell(recordId, fieldId, value, version)
}
async function onTimelinePatchDates(payload: {
  recordId: string
  version: number
  startFieldId: string
  endFieldId: string
  startValue: string
  endValue: string
}) {
  if (!ensureCanEditRecord()) return
  try {
    await workbench.client.patchRecords({
      sheetId: workbench.activeSheetId.value || undefined,
      viewId: workbench.activeViewId.value || undefined,
      changes: [
        { recordId: payload.recordId, fieldId: payload.startFieldId, value: payload.startValue, expectedVersion: payload.version },
        { recordId: payload.recordId, fieldId: payload.endFieldId, value: payload.endValue, expectedVersion: payload.version },
      ],
    })
    await grid.loadViewData(grid.page.value.offset)
    if (selectedRecordId.value === payload.recordId) {
      await resolveDeepLink(payload.recordId)
    }
    showSuccess('Timeline updated')
  } catch (error: any) {
    showError(error?.message ?? 'Failed to update timeline dates')
  }
}
async function onAddRecord() {
  if (!ensureCanCreateRecord()) return
  await grid.createRecord()
}
async function onKanbanCreateRecord(data: Record<string, unknown>) {
  if (!ensureCanCreateRecord()) return
  await grid.createRecord(data)
}
async function onDeleteRecord() {
  if (!selectedRecordId.value) return
  if (!ensureCanDeleteRecord()) return
  const deleted = await grid.deleteRecord(selectedRecordId.value)
  if (deleted) {
    selectedRecordId.value = null
    showComments.value = false
    commentDraft.value = ''
    showSuccess('Record deleted')
    return
  }
  if (grid.error.value) showError(grid.error.value)
}

async function onReloadConflict() {
  await grid.reloadCurrentPage()
  if (selectedRecordId.value) {
    await resolveDeepLink(selectedRecordId.value)
  }
  showSuccess('Loaded the latest row state')
}

async function onRetryConflict() {
  const retried = await grid.retryConflict()
  if (retried) {
    if (selectedRecordId.value) {
      await resolveDeepLink(selectedRecordId.value)
    }
    showSuccess('Change reapplied')
    return
  }
  if (grid.error.value) showError(grid.error.value)
}

async function onDrawerPatch(fieldId: string, value: unknown) {
  if (!selectedRecordResolved.value) return
  if (!ensureCanEditRecord()) return
  const record = selectedRecordResolved.value
  await grid.patchCell(record.id, fieldId, value, record.version)
  if (grid.error.value) {
    showError(grid.error.value)
    return
  }
  if (deepLinkedRecord.value?.id === record.id) {
    deepLinkedRecord.value = {
      ...deepLinkedRecord.value,
      version: deepLinkedRecord.value.version + 1,
      data: { ...deepLinkedRecord.value.data, [fieldId]: value },
    }
  }
  showSuccess('Record updated')
}

async function onFormSubmit(data: Record<string, unknown>) {
  const viewId = workbench.activeViewId.value
  if (viewId && activeViewType.value === 'form') {
    if (!(selectedRecordResolved.value ? ensureCanEditRecord() : ensureCanCreateRecord())) return
    try {
      formSubmitting.value = true
      formSuccessMessage.value = null
      formErrorMessage.value = null
      formFieldErrors.value = {}
      const result = await workbench.client.submitForm(viewId, {
        recordId: selectedRecordResolved.value?.id,
        expectedVersion: selectedRecordResolved.value?.version,
        data,
      })
      deepLinkedRecord.value = result.record
      deepLinkedRecordAttachmentSummaries.value = result.attachmentSummaries ?? {}
      deepLinkedRecordCommentsScope.value = result.commentsScope
      selectedRecordId.value = result.record.id
      formDirty.value = false
      await grid.loadViewData(grid.page.value.offset)
      formSuccessMessage.value = result.mode === 'create' ? 'Record created' : 'Changes saved'
      formFieldErrors.value = {}
      showSuccess('Form submitted')
    } catch (e: any) {
      const message = e.message ?? 'Form submit failed'
      formErrorMessage.value = message
      formFieldErrors.value = e.fieldErrors ?? {}
      showError(message)
    } finally {
      formSubmitting.value = false
      await nextTick()
      await replayPendingExternalContextIfReady()
    }
  } else if (selectedRecordResolved.value) {
    if (!ensureCanEditRecord()) return
    const changes = Object.entries(data).filter(([k, v]) => v !== selectedRecordResolved.value!.data[k]).map(([fieldId, value]) => ({ recordId: selectedRecordResolved.value!.id, fieldId, value, expectedVersion: selectedRecordResolved.value!.version }))
    if (changes.length) {
      await workbench.client.patchRecords({ sheetId: workbench.activeSheetId.value || undefined, viewId: viewId || undefined, changes })
      await grid.loadViewData(grid.page.value.offset)
      showSuccess('Record updated')
    }
  } else {
    if (!ensureCanCreateRecord()) return
    await grid.createRecord(data)
  }
}

async function onSubmitComment(payload: { content: string; mentions: string[] }) {
  if (!selectedRecordCommentsScope.value) return
  try {
    if (selectedEditingCommentId.value) {
      await commentsState.updateComment(selectedEditingCommentId.value, {
        content: payload.content,
        mentions: payload.mentions,
      })
      showSuccess('Comment updated')
    } else {
      await commentsState.addComment({
        ...selectedRecordCommentsScope.value,
        content: payload.content,
        mentions: payload.mentions,
        targetFieldId: activeCommentFieldId.value ?? undefined,
        parentId: selectedReplyCommentId.value ?? undefined,
      })
      showSuccess('Comment added')
    }
    commentDraft.value = ''
    selectedReplyCommentId.value = null
    selectedEditingCommentId.value = null
  } catch (e: any) {
    showError(commentsState.error.value ?? e.message ?? (selectedEditingCommentId.value ? 'Failed to update comment' : 'Failed to add comment'))
  }
}

async function onResolveComment(commentId: string) {
  try {
    await commentsState.resolveComment(commentId)
    showSuccess('Comment resolved')
  } catch (e: any) {
    showError(commentsState.error.value ?? e.message ?? 'Failed to resolve comment')
  }
}

function onEditComment(commentId: string) {
  const comment = commentsState.comments.value.find((item) => item.id === commentId)
  if (!comment) return
  selectedEditingCommentId.value = comment.id
  selectedReplyCommentId.value = null
  selectedCommentFieldId.value = comment.targetFieldId ?? comment.fieldId ?? null
  commentDraft.value = formatCommentDraftContent(comment.content)
  showComments.value = true
}

async function onDeleteComment(commentId: string) {
  try {
    await commentsState.deleteComment(commentId)
    if (selectedEditingCommentId.value === commentId) {
      selectedEditingCommentId.value = null
      commentDraft.value = ''
    }
    if (selectedReplyCommentId.value === commentId) {
      selectedReplyCommentId.value = null
    }
    if (highlightedCommentId.value === commentId) {
      highlightedCommentId.value = null
    }
    showSuccess('Comment deleted')
  } catch (e: any) {
    showError(commentsState.error.value ?? e.message ?? 'Failed to delete comment')
  }
}

function openLinkPicker(field: MetaField) { linkPickerField.value = field; linkPickerRecordId.value = selectedRecordId.value; linkPickerCurrentValue.value = selectedRecordResolved.value?.data[field.id] ?? null; linkPickerVisible.value = true }
function onGridLinkPicker(ctx: { recordId: string; field: MetaField }) { const row = grid.rows.value.find((r) => r.id === ctx.recordId); linkPickerField.value = ctx.field; linkPickerRecordId.value = ctx.recordId; linkPickerCurrentValue.value = row?.data[ctx.field.id] ?? null; linkPickerVisible.value = true }
async function onLinkPickerConfirm(payload: { recordIds: string[]; summaries: LinkedRecordSummary[] }) {
  linkPickerVisible.value = false
  if (!linkPickerRecordId.value || !linkPickerField.value) return
  if (!ensureCanEditRecord()) return
  const recordId = linkPickerRecordId.value
  const fieldId = linkPickerField.value.id
  const previousSummaries = selectedRecordLinkSummaries.value[fieldId] ?? grid.linkSummaries.value[recordId]?.[fieldId]
  const row = grid.rows.value.find((r) => r.id === recordId)
  if (row) {
    await grid.patchCell(row.id, fieldId, payload.recordIds, row.version, {
      previousLinkSummaries: previousSummaries,
      nextLinkSummaries: payload.summaries,
    })
    if (grid.error.value) {
      showError(grid.error.value)
      return
    }
  } else if (selectedRecordResolved.value?.id === recordId) {
    try {
      const result = await workbench.client.patchRecords({
        sheetId: workbench.activeSheetId.value || undefined,
        viewId: workbench.activeViewId.value || undefined,
        changes: [{ recordId, fieldId, value: payload.recordIds, expectedVersion: selectedRecordResolved.value.version }],
      })
      const nextVersion = result.updated?.find((item) => item.recordId === recordId)?.version ?? selectedRecordResolved.value.version + 1
      deepLinkedRecord.value = {
        ...selectedRecordResolved.value,
        version: nextVersion,
        data: {
          ...selectedRecordResolved.value.data,
          [fieldId]: payload.recordIds,
        },
      }
      applyLocalLinkSummaries(recordId, fieldId, result.linkSummaries?.[recordId]?.[fieldId] ?? payload.summaries)
    } catch (e: any) {
      showError(e.message ?? 'Failed to update linked records')
      return
    }
  } else {
    return
  }
  showSuccess('Linked records updated')
}

// --- Field management ---
async function onCreateField(input: { sheetId: string; name: string; type: MetaFieldCreateType | string; property?: Record<string, unknown> }) {
  try {
    if (input.type === 'person') {
      const preset = await workbench.client.preparePersonField(input.sheetId)
      await workbench.client.createField({
        sheetId: input.sheetId,
        name: input.name,
        type: 'link',
        property: {
          ...preset.fieldProperty,
          ...(input.property ?? {}),
        },
      })
    } else {
      await workbench.client.createField({
        sheetId: input.sheetId,
        name: input.name,
        type: input.type as MetaFieldType,
        property: input.property,
      })
    }
    await workbench.loadSheetMeta(workbench.activeSheetId.value)
    await grid.loadViewData(grid.page.value.offset)
  } catch (e: any) { showError(e.message ?? 'Failed to create field') }
}

async function onUpdateField(fieldId: string, input: { name?: string; order?: number; type?: string; property?: Record<string, unknown> }) {
  try {
    await workbench.client.updateField(fieldId, input)
    await workbench.loadSheetMeta(workbench.activeSheetId.value)
    await grid.loadViewData(grid.page.value.offset)
  } catch (e: any) { showError(e.message ?? 'Failed to update field') }
}

async function onDeleteField(fieldId: string) {
  try {
    await workbench.client.deleteField(fieldId)
    await workbench.loadSheetMeta(workbench.activeSheetId.value)
    await grid.loadViewData(grid.page.value.offset)
  } catch (e: any) { showError(e.message ?? 'Failed to delete field') }
}

// --- View management ---
async function onCreateView(input: { sheetId: string; name: string; type: string; config?: Record<string, unknown>; groupInfo?: Record<string, unknown> }) {
  try {
    const res = await workbench.client.createView({
      sheetId: input.sheetId,
      name: input.name,
      type: input.type,
      config: input.config,
      groupInfo: input.groupInfo,
    })
    await workbench.loadSheetMeta(workbench.activeSheetId.value)
    workbench.selectView(res.view.id)
    await grid.loadViewData(grid.page.value.offset)
  } catch (e: any) { showError(e.message ?? 'Failed to create view') }
}

async function onUpdateView(viewId: string, input: { name?: string; config?: Record<string, unknown>; groupInfo?: Record<string, unknown> }) {
  await updateViewInternal(viewId, input, true)
}

async function onPersistActiveViewConfig(input: { config?: Record<string, unknown>; groupInfo?: Record<string, unknown> }) {
  const viewId = workbench.activeViewId.value
  if (!viewId) return
  await updateViewInternal(viewId, input, false)
}

async function updateViewInternal(
  viewId: string,
  input: { name?: string; config?: Record<string, unknown>; groupInfo?: Record<string, unknown> },
  notify: boolean,
) {
  try {
    await workbench.client.updateView(viewId, input)
    await workbench.loadSheetMeta(workbench.activeSheetId.value)
    await grid.loadViewData(grid.page.value.offset)
    if (notify) showSuccess('View settings saved')
  } catch (e: any) { showError(e.message ?? 'Failed to update view') }
}

async function onDeleteView(viewId: string) {
  try {
    await workbench.client.deleteView(viewId)
    await workbench.loadSheetMeta(workbench.activeSheetId.value)
    if (workbench.activeViewId.value === viewId) workbench.selectView(workbench.views.value[0]?.id ?? '')
  } catch (e: any) { showError(e.message ?? 'Failed to delete view') }
}

// --- Sheet management ---
async function onCreateSheet(name: string) {
  if (!confirmDiscardContextChanges()) return
  try {
    const res = await workbench.client.createSheet({ name, baseId: workbench.activeBaseId.value || undefined, seed: true })
    const ok = await workbench.syncExternalContext({
      baseId: (res.sheet.baseId ?? workbench.activeBaseId.value) || undefined,
      sheetId: res.sheet.id,
    })
    if (!ok) {
      showError(workbench.error.value ?? 'Created sheet but failed to refresh workbench context')
      return
    }
  } catch (e: any) { showError(e.message ?? 'Failed to create sheet') }
}

// --- Base management ---
async function loadBases() {
  try {
    const data = await workbench.client.listBases()
    bases.value = data.bases ?? []
    if (!workbench.activeBaseId.value && bases.value.length) workbench.selectBase(bases.value[0].id)
  } catch { /* silent */ }
}

async function onSelectBase(baseId: string) {
  if (baseId === workbench.activeBaseId.value) return
  if (!confirmDiscardContextChanges()) return
  const ok = await workbench.switchBase(baseId)
  if (!ok) showError(workbench.error.value ?? 'Failed to load base')
}

function onSelectSheet(sheetId: string) {
  if (sheetId === workbench.activeSheetId.value) return
  if (!confirmDiscardContextChanges()) return
  workbench.selectSheet(sheetId)
}

function onSelectView(viewId: string) {
  if (viewId === workbench.activeViewId.value) return
  if (!confirmDiscardContextChanges()) return
  workbench.selectView(viewId)
}

function onOpenImportModal() {
  showImportModal.value = true
}

function onCloseDrawer() {
  if (!confirmDiscardRecordChanges()) return
  selectedRecordId.value = null
  showComments.value = false
  resetCommentInteractionState()
}

function onToggleComments() {
  if (showComments.value) {
    if (!confirmDiscardCommentDraft()) return
    showComments.value = false
    resetCommentInteractionState()
    return
  }
  showComments.value = true
  selectedCommentFieldId.value = null
  selectedReplyCommentId.value = null
  selectedEditingCommentId.value = null
  void commentInboxState.refreshUnreadCount().catch(() => undefined)
}

function onToggleFieldComments(field: MetaField) {
  if (!selectedRecordId.value) return
  selectedCommentFieldId.value = field.id
  selectedReplyCommentId.value = null
  selectedEditingCommentId.value = null
  showComments.value = true
  commentDraft.value = ''
  void loadCommentsForRecord(selectedRecordId.value, {
    highlightCommentId: highlightedCommentId.value,
  })
}

function onOpenRecordComments(recordId: string) {
  void selectRecord(recordId, { openComments: true }).then(() => {
    selectedCommentFieldId.value = null
    selectedReplyCommentId.value = null
    selectedEditingCommentId.value = null
  })
}

function onOpenGridFieldComments(payload: { recordId: string; fieldId: string }) {
  void selectRecord(payload.recordId, { openComments: true }).then(() => {
    selectedCommentFieldId.value = payload.fieldId
    selectedReplyCommentId.value = null
    selectedEditingCommentId.value = null
  })
}

function onReplyToComment(commentId: string) {
  selectedReplyCommentId.value = commentId
  selectedEditingCommentId.value = null
  showComments.value = true
}

function onCancelCommentReply() {
  selectedReplyCommentId.value = null
}

function onCancelCommentEdit() {
  selectedEditingCommentId.value = null
  commentDraft.value = ''
}

function onCloseComments() {
  if (!confirmDiscardCommentDraft()) return
  showComments.value = false
  resetCommentInteractionState()
}

function confirmDiscardContextChanges() {
  if (!hasUnsavedWorkbenchDrafts.value) return true
  return window.confirm('Discard unsaved changes before leaving the current sheet or view?')
}

function confirmDiscardRecordChanges() {
  if (!hasRecordScopedDrafts.value) return true
  return window.confirm('Discard unsaved record changes?')
}

function confirmDiscardCommentDraft() {
  if (!hasCommentDraft.value) return true
  return window.confirm('Discard unsaved comment draft?')
}

function discardWorkbenchDraftsForExternalContextChange() {
  formDirty.value = false
  fieldManagerDirty.value = false
  viewManagerDirty.value = false
  importDirty.value = false
  commentDraft.value = ''
  formSuccessMessage.value = null
  formErrorMessage.value = null
  formFieldErrors.value = {}
  showComments.value = false
  resetCommentInteractionState()
  selectedRecordId.value = null
  deepLinkedRecord.value = null
  deepLinkedRecordLinkSummaries.value = {}
  deepLinkedRecordAttachmentSummaries.value = {}
  deepLinkedRecordCommentsScope.value = null
  showImportModal.value = false
  importResult.value = null
  importAbortController.value = null
}

function confirmPageLeave() {
  if (formSubmitting.value || importSubmitting.value) {
    return window.confirm('Leave the multitable while the current save or import is still running?')
  }
  if (!hasUnsavedWorkbenchDrafts.value) return true
  return window.confirm('Discard unsaved multitable changes before leaving this page?')
}

function normalizeExternalContext(input: { baseId?: string; sheetId?: string; viewId?: string }) {
  return {
    baseId: input.baseId ?? '',
    sheetId: input.sheetId ?? '',
    viewId: input.viewId ?? '',
  }
}

function serializeExternalContext(input: { baseId: string; sheetId: string; viewId: string }) {
  return `${input.baseId}::${input.sheetId}::${input.viewId}`
}

function externalContextMatchesWorkbench(input: { baseId: string; sheetId: string; viewId: string }) {
  return input.baseId === (workbench.activeBaseId.value ?? '') &&
    input.sheetId === (workbench.activeSheetId.value ?? '') &&
    input.viewId === (workbench.activeViewId.value ?? '')
}

function getCurrentExternalContext() {
  return {
    baseId: workbench.activeBaseId.value ?? '',
    sheetId: workbench.activeSheetId.value ?? '',
    viewId: workbench.activeViewId.value ?? '',
  }
}

async function applyExternalContext(input: { baseId: string; sheetId: string; viewId: string }) {
  pendingExternalContext.value = null
  pendingExternalContextReason.value = null
  pendingExternalContextNoticeKey.value = ''
  const ok = await workbench.syncExternalContext(input)
  if (!ok) showError(workbench.error.value ?? 'Failed to sync workbench context')
  return ok
}

async function replayPendingExternalContextIfReady() {
  const pending = pendingExternalContext.value
  if (!workbenchReady.value || hasBlockingUnloadState.value || !pending) return false
  if (externalContextMatchesWorkbench(pending.context)) {
    pendingExternalContext.value = null
    pendingExternalContextReason.value = null
    pendingExternalContextNoticeKey.value = ''
    emit('external-context-result', {
      status: 'applied',
      context: getCurrentExternalContext(),
      requestId: pending.requestId,
    })
    return true
  }
  const replay = pending
  pendingExternalContext.value = null
  pendingExternalContextReason.value = null
  pendingExternalContextNoticeKey.value = ''
  const ok = await applyExternalContext(replay.context)
  emit('external-context-result', ok
    ? {
      status: 'applied',
      context: replay.context,
      requestId: replay.requestId,
    }
    : {
      status: 'failed',
      context: replay.context,
      reason: 'sync-failed',
      requestId: replay.requestId,
    })
  return ok
}

function deferExternalContextSync(
  input: { baseId: string; sheetId: string; viewId: string },
  reason: Extract<ExternalContextSyncReason, 'busy' | 'unsaved-drafts'>,
  requestId?: string | number,
): ExternalContextSyncResult {
  const previousPending = pendingExternalContext.value
  const previousReason = pendingExternalContextReason.value
  if (
    previousPending &&
    (previousPending.requestId !== requestId ||
      serializeExternalContext(previousPending.context) !== serializeExternalContext(input))
  ) {
    emit('external-context-result', {
      status: 'superseded',
      context: previousPending.context,
      reason: 'superseded',
      requestId: previousPending.requestId,
    })
    if (previousReason === reason) {
      pendingExternalContextNoticeKey.value = ''
    }
  }
  pendingExternalContext.value = { context: input, requestId }
  pendingExternalContextReason.value = reason
  const noticeKey = `${reason}::${requestId ?? ''}::${serializeExternalContext(input)}`
  if (pendingExternalContextNoticeKey.value !== noticeKey) {
    pendingExternalContextNoticeKey.value = noticeKey
    if (reason === 'busy') {
      showError('Host multitable context change is waiting for the current save or import to finish.')
    } else {
      showError('Host multitable context changed while unsaved drafts are open. Resolve or discard changes to continue.')
    }
  }
  return { status: 'deferred', context: input, reason, requestId }
}

function getEmbedHostState() {
  return {
    currentContext: getCurrentExternalContext(),
    hasBlockingState: hasBlockingUnloadState.value,
    blockingReason: currentBlockingReason.value,
    hasUnsavedDrafts: hasUnsavedWorkbenchDrafts.value,
    busy: formSubmitting.value || importSubmitting.value,
    pendingContext: pendingExternalContext.value
      ? {
        ...pendingExternalContext.value.context,
        requestId: pendingExternalContext.value.requestId,
        reason: pendingExternalContextReason.value ?? undefined,
      }
      : null,
  }
}

async function requestExternalContextSync(
  input: { baseId?: string; sheetId?: string; viewId?: string },
  options?: { confirmIfBlocked?: boolean; requestId?: string | number },
): Promise<ExternalContextSyncResult> {
  const nextContext = normalizeExternalContext(input)
  if (externalContextMatchesWorkbench(nextContext)) {
    pendingExternalContext.value = null
    pendingExternalContextReason.value = null
    pendingExternalContextNoticeKey.value = ''
    return { status: 'applied', context: getCurrentExternalContext(), requestId: options?.requestId }
  }
  if (formSubmitting.value || importSubmitting.value) {
    return deferExternalContextSync(nextContext, 'busy', options?.requestId)
  }
  if (hasUnsavedWorkbenchDrafts.value) {
    if (!options?.confirmIfBlocked) {
      return deferExternalContextSync(nextContext, 'unsaved-drafts', options?.requestId)
    }
    if (!confirmDiscardContextChanges()) {
      return { status: 'blocked', context: nextContext, reason: 'user-cancelled', requestId: options?.requestId }
    }
    discardWorkbenchDraftsForExternalContextChange()
  }
  const ok = await applyExternalContext(nextContext)
  if (!ok) {
    return { status: 'failed', context: nextContext, reason: 'sync-failed', requestId: options?.requestId }
  }
  return { status: 'applied', context: nextContext, requestId: options?.requestId }
}

async function onCreateBase(name: string) {
  try {
    const res = await workbench.client.createBase({ name })
    bases.value.push(res.base)
    await onSelectBase(res.base.id)
  } catch (e: any) { showError(e.message ?? 'Failed to create base') }
}

// --- Print ---
function onPrint() { window.print() }

// --- Column auto-fit ---
function onAutoFitColumns() {
  const fields = grid.visibleFields.value
  const rows = grid.rows.value
  for (const f of fields) {
    let maxLen = f.name.length
    for (const r of rows) {
      const v = r.data[f.id]
      if (v != null) maxLen = Math.max(maxLen, String(v).length)
    }
    const width = Math.max(80, Math.min(400, maxLen * 8 + 24))
    grid.setColumnWidth(f.id, width)
  }
}

// --- Field reorder ---
function onReorderField(fromId: string, toId: string) {
  const arr = [...grid.fields.value]
  const fromIdx = arr.findIndex((f) => f.id === fromId)
  const toIdx = arr.findIndex((f) => f.id === toId)
  if (fromIdx < 0 || toIdx < 0) return
  const [moved] = arr.splice(fromIdx, 1)
  arr.splice(toIdx, 0, moved)
  grid.fields.value = arr
  // Persist order through field.order until backend exposes a dedicated view column-order contract.
  Promise.all(arr.map((field, index) => workbench.client.updateField(field.id, { order: index }))).catch(() => {})
}

// --- Bulk import ---
async function onBulkImport(payload: ImportBuildResult) {
  const controller = new AbortController()
  importAbortController.value = controller
  importSubmitting.value = true
  importResult.value = null
  try {
    const primaryField = getImportPrimaryField(payload.records)
    let recordsToImport = payload.records
    let rowIndexesToImport = payload.rowIndexes
    let skippedRows: ImportFailure[] = []

    if (primaryField && workbench.activeSheetId.value && payload.records.length > 0) {
      try {
        const existingSummary = await loadAllRecordSummaries(workbench.activeSheetId.value, primaryField.id)
        const existingKeys = existingSummary.records
          .map((record) => normalizeImportLookupKey(record.display))
          .filter((key) => key.length > 0)
        const deduped = skipDuplicateImportRows({
          records: payload.records,
          rowIndexes: payload.rowIndexes,
          primaryFieldId: primaryField.id,
          primaryFieldName: primaryField.name,
          existingKeys,
        })
        recordsToImport = deduped.records
        rowIndexesToImport = deduped.rowIndexes
        skippedRows = deduped.skippedRows.map((row) => ({
          ...row,
          retryable: false,
        }))
      } catch {
        // Duplicate detection should not block imports when summary prefetch fails.
      }
    }

    const importRowsResult = recordsToImport.length > 0
      ? await bulkImportRecords({
        client: workbench.client,
        sheetId: workbench.activeSheetId.value || undefined,
        viewId: workbench.activeViewId.value || undefined,
        records: recordsToImport,
        signal: controller.signal,
      })
      : { attempted: 0, succeeded: 0, failed: 0, firstError: null, failures: [] }

    const actualFailures = [
      ...payload.failures.map((failure) => ({ ...failure, retryable: false })),
      ...importRowsResult.failures.map((failure) => ({
        ...failure,
        rowIndex: rowIndexesToImport[failure.index] ?? failure.index,
        retryable: failure.retryable,
      })),
    ].sort((a, b) => a.rowIndex - b.rowIndex)
    const failures = [...actualFailures, ...skippedRows].sort((a, b) => a.rowIndex - b.rowIndex)

    const result = {
      attempted: payload.records.length + payload.failures.length,
      succeeded: importRowsResult.succeeded,
      failed: actualFailures.length,
      skipped: skippedRows.length,
      firstError: actualFailures[0]?.message ?? importRowsResult.firstError,
      failures,
    }

    importResult.value = result
    if (result.succeeded > 0) {
      await grid.loadViewData(grid.page.value.offset)
    }
    if (result.failed === 0 && result.skipped === 0) {
      closeImportModal()
      showSuccess(`${result.succeeded} record(s) imported`)
      return
    }
    if (result.succeeded > 0) {
      const failedRows = actualFailures.slice(0, 3).map((failure) => `row ${failure.rowIndex + 2}`).join(', ')
      if (result.failed > 0) {
        showError(`${result.failed} record(s) failed to import${failedRows ? ` (${failedRows})` : ''}. ${result.firstError ?? ''}`.trim())
      } else if (result.skipped > 0) {
        showError(`${result.skipped} duplicate row(s) were skipped`)
      }
      showSuccess(`${result.succeeded} record(s) imported`)
      return
    }
    if (result.skipped > 0) {
      showError(`${result.skipped} duplicate row(s) were skipped`)
      return
    }
    showError(result.firstError ?? 'Import failed')
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      closeImportModal()
      await grid.loadViewData(grid.page.value.offset)
      showError('Import cancelled')
      return
    }
    const fallbackMessage = e?.message ?? 'Import failed'
    const failures = [
      ...payload.failures.map((failure) => ({ ...failure, retryable: false })),
      ...payload.rowIndexes.map((rowIndex, index) => ({
        index,
        rowIndex,
        message: fallbackMessage,
        retryable: true,
      })),
    ].sort((a, b) => a.rowIndex - b.rowIndex)

    importResult.value = {
      attempted: payload.records.length + payload.failures.length,
      succeeded: 0,
      failed: failures.length,
      skipped: 0,
      firstError: fallbackMessage,
      failures,
    }
    showError(fallbackMessage)
  } finally {
    if (importAbortController.value === controller) {
      importAbortController.value = null
    }
    importSubmitting.value = false
    await nextTick()
    await replayPendingExternalContextIfReady()
  }
}

function cancelImport() {
  importAbortController.value?.abort()
}

function closeImportModal() {
  showImportModal.value = false
  importSubmitting.value = false
  importResult.value = null
  importAbortController.value = null
}

// --- CSV export ---
function onExportCsv() {
  const visibleFields = scopedGridFields.value
  if (!visibleFields.length) return
  const header = visibleFields.map((f) => csvEscape(f.name)).join(',')
  const rows = grid.rows.value.map((row) =>
    visibleFields.map((f) => {
      const v = row.data[f.id]
      if (v === null || v === undefined) return ''
      if (typeof v === 'boolean') return v ? 'true' : 'false'
      if (Array.isArray(v)) return csvEscape(v.map(String).join('; '))
      return csvEscape(String(v))
    }).join(','),
  )
  const csv = [header, ...rows].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${workbench.activeSheetId.value || 'export'}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function csvEscape(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) return `"${val.replace(/"/g, '""')}"`
  return val
}

const drawerRecordIds = computed(() => grid.rows.value.map((r) => r.id))

function onDrawerNavigate(recordId: string) {
  void selectRecord(recordId)
}

// --- Beforeunload: warn on unsaved changes ---
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (!hasBlockingUnloadState.value) return
  e.preventDefault()
  e.returnValue = ''
}

function onGlobalKeydown(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey
  if (mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); grid.undo() }
  else if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); grid.redo() }
  else if (e.key === '?' && !(e.target as HTMLElement)?.closest('input, textarea, select')) { showShortcuts.value = !showShortcuts.value }
}

// --- Record deep-link (read recordId from URL hash) ---
function parseDeepLink(): string | null {
  try {
    const hash = window.location.hash // e.g. #recordId=rec_abc123
    const m = hash.match(/recordId=([^&]+)/)
    return m ? decodeURIComponent(m[1]) : null
  } catch { return null }
}

// Update URL hash when a record is selected
watch(selectedRecordId, (rid) => {
  try {
    if (rid) window.history.replaceState(null, '', `#recordId=${encodeURIComponent(rid)}`)
    else if (window.location.hash.includes('recordId=')) window.history.replaceState(null, '', window.location.pathname + window.location.search)
  } catch { /* */ }
})

watch([selectedRecordId, () => workbench.activeViewId.value], () => {
  formSuccessMessage.value = null
  formErrorMessage.value = null
  formFieldErrors.value = {}
})

async function refreshDialogMeta() {
  const activeSheetId = workbench.activeSheetId.value
  if (!activeSheetId) return
  if (dialogMetaRefreshInFlight) {
    dialogMetaRefreshQueued = true
    return
  }
  dialogMetaRefreshInFlight = true
  try {
    dialogMetaRefreshQueued = false
    const refreshed = await workbench.loadSheetMeta(activeSheetId)
    if (refreshed && workbench.activeSheetId.value === activeSheetId) {
      grid.fields.value = [...propertyVisibleWorkbenchFields.value]
    }
  } catch {
    // Keep dialog refresh silent; explicit save paths still surface errors.
  } finally {
    dialogMetaRefreshInFlight = false
    const shouldRefresh = Boolean((showFieldManager.value || showViewManager.value || showImportModal.value) && workbench.activeSheetId.value)
    if (shouldRefresh && (dialogMetaRefreshQueued || workbench.activeSheetId.value !== activeSheetId)) {
      dialogMetaRefreshQueued = false
      void refreshDialogMeta()
    }
  }
}

function stopDialogMetaRefresh() {
  if (dialogMetaRefreshTimer != null) {
    window.clearInterval(dialogMetaRefreshTimer)
    dialogMetaRefreshTimer = null
  }
  dialogMetaRefreshQueued = false
}

function startDialogMetaRefresh() {
  stopDialogMetaRefresh()
  void refreshDialogMeta()
  dialogMetaRefreshTimer = window.setInterval(() => {
    void refreshDialogMeta()
  }, 1200)
}

// --- Bulk delete ---
async function onBulkDelete(recordIds: string[]) {
  if (!ensureCanDeleteRecord()) return
  try {
    await Promise.all(recordIds.map((rid) => grid.deleteRecord(rid)))
    if (selectedRecordId.value && recordIds.includes(selectedRecordId.value)) selectedRecordId.value = null
    showSuccess(`${recordIds.length} record(s) deleted`)
  } catch (e: any) { showError(e.message ?? 'Bulk delete failed') }
}

// --- Deep-link record fetch (when record not in current page) ---
const deepLinkedRecord = ref<MetaRecord | null>(null)

async function resolveDeepLink(recordId: string, options?: { openComments?: boolean; highlightCommentId?: string | null; markReadCommentId?: string | null; targetFieldId?: string | null }) {
  // First check if it's in the current rows
  const inPage = grid.rows.value.find((r) => r.id === recordId)
  if (inPage) {
    await selectRecord(recordId, options)
    return
  }
  // Fetch from server
  try {
    const ctx = await workbench.client.getRecord(recordId, {
      sheetId: workbench.activeSheetId.value || undefined,
      viewId: workbench.activeViewId.value || undefined,
    })
    deepLinkedRecord.value = ctx.record
    deepLinkedRecordLinkSummaries.value = ctx.linkSummaries ?? {}
    deepLinkedRecordAttachmentSummaries.value = ctx.attachmentSummaries ?? {}
    deepLinkedRecordCommentsScope.value = ctx.commentsScope
    deepLinkedRecordFieldPermissions.value = ctx.fieldPermissions ?? {}
    deepLinkedRecordViewPermissions.value = ctx.viewPermissions ?? {}
    deepLinkedRecordRowActions.value = ctx.rowActions ?? null
    await selectRecord(recordId, options)
  } catch (e: any) {
    showError(`Record not found: ${recordId}`)
  }
}

function clearDeepLinkedRecordState() {
  deepLinkedRecord.value = null
  deepLinkedRecordLinkSummaries.value = {}
  deepLinkedRecordAttachmentSummaries.value = {}
  deepLinkedRecordCommentsScope.value = null
  deepLinkedRecordFieldPermissions.value = {}
  deepLinkedRecordViewPermissions.value = {}
  deepLinkedRecordRowActions.value = null
}

async function mergeRemoteRecordContext(recordId: string): Promise<boolean> {
  if (!recordId) return false
  const inPage = grid.rows.value.some((row) => row.id === recordId)
  const isSelected = selectedRecordId.value === recordId
  if (!inPage && !isSelected) return false
  if (activeViewType.value === 'form' && isSelected) {
    await loadStandaloneForm()
    return true
  }

  try {
    const ctx = await workbench.client.getRecord(recordId, {
      sheetId: workbench.activeSheetId.value || undefined,
      viewId: workbench.activeViewId.value || undefined,
    })
    const mergedInPage = grid.mergeRemoteRecord(ctx.record, {
      linkSummaries: ctx.linkSummaries,
      attachmentSummaries: ctx.attachmentSummaries,
    })
    if (selectedRecordId.value === recordId) {
      deepLinkedRecord.value = ctx.record
      deepLinkedRecordLinkSummaries.value = ctx.linkSummaries ?? {}
      deepLinkedRecordAttachmentSummaries.value = ctx.attachmentSummaries ?? {}
      deepLinkedRecordCommentsScope.value = ctx.commentsScope
      deepLinkedRecordFieldPermissions.value = ctx.fieldPermissions ?? {}
      deepLinkedRecordViewPermissions.value = ctx.viewPermissions ?? {}
      deepLinkedRecordRowActions.value = ctx.rowActions ?? null
    }
    return mergedInPage || selectedRecordId.value === recordId
  } catch {
    return false
  }
}

async function applyRemoteRecordPatchContext(payload: {
  recordId: string
  version?: number
  fieldIds: string[]
  patch: Record<string, unknown>
}): Promise<boolean> {
  const fieldIds = payload.fieldIds.length > 0 ? payload.fieldIds : Object.keys(payload.patch)
  if (!payload.recordId || fieldIds.length === 0) return false
  if (fieldIds.some((fieldId) => !isCellRealtimeLocallyPatchable(fieldId))) return false

  let handled = grid.applyRemoteRecordPatch(payload.recordId, {
    version: payload.version,
    patch: payload.patch,
  })

  if (patchDeepLinkedRealtimeRecord(payload.recordId, payload.version, payload.patch)) {
    handled = true
  }

  return handled
}

function removeLocalRealtimeRecord(recordId: string): boolean {
  let handled = grid.removeRemoteRecord(recordId)
  if (selectedRecordId.value === recordId) {
    selectedRecordId.value = null
    showComments.value = false
    resetCommentInteractionState()
    clearDeepLinkedRecordState()
    handled = true
  } else if (deepLinkedRecord.value?.id === recordId) {
    clearDeepLinkedRecordState()
    handled = true
  }
  return handled
}

async function refreshSelectedRecordContext(recordId: string) {
  if (!recordId || selectedRecordId.value !== recordId) return
  if (activeViewType.value === 'form') {
    await loadStandaloneForm()
    return
  }
  const inPage = grid.rows.value.some((row) => row.id === recordId)
  if (inPage) return

  try {
    const ctx = await workbench.client.getRecord(recordId, {
      sheetId: workbench.activeSheetId.value || undefined,
      viewId: workbench.activeViewId.value || undefined,
    })
    if (selectedRecordId.value !== recordId) return
    deepLinkedRecord.value = ctx.record
    deepLinkedRecordLinkSummaries.value = ctx.linkSummaries ?? {}
    deepLinkedRecordAttachmentSummaries.value = ctx.attachmentSummaries ?? {}
    deepLinkedRecordCommentsScope.value = ctx.commentsScope
    deepLinkedRecordFieldPermissions.value = ctx.fieldPermissions ?? {}
    deepLinkedRecordViewPermissions.value = ctx.viewPermissions ?? {}
    deepLinkedRecordRowActions.value = ctx.rowActions ?? null
  } catch {
    // Silent best-effort refresh; explicit fetch paths surface errors.
  }
}

// Override selectedRecord to also consider deep-linked record
const selectedRecordResolved = computed<MetaRecord | null>(() => {
  if (selectedRecordId.value) {
    if (deepLinkedRecord.value?.id === selectedRecordId.value) return deepLinkedRecord.value
    const inPage = grid.rows.value.find((r) => r.id === selectedRecordId.value)
    if (inPage) return inPage
  }
  return null
})

watch(
  [() => workbench.activeSheetId.value, visibleCommentPresenceRecordIds, () => effectiveRowActions.value.canComment],
  ([sheetId, recordIds, canComment]) => {
    if (!sheetId || !canComment || !recordIds.length) {
      commentPresenceState.clearPresence()
      return
    }
    void commentPresenceState.loadPresence({
      containerId: sheetId,
      targetIds: recordIds,
    })
  },
  { immediate: true },
)

// --- Standalone form bootstrap ---
async function loadStandaloneForm() {
  if (activeViewType.value !== 'form' || !workbench.activeViewId.value) return
  const loadVersion = ++standaloneFormLoadVersion
  try {
    const ctx = await workbench.client.loadFormContext({
      sheetId: workbench.activeSheetId.value || undefined,
      viewId: workbench.activeViewId.value || undefined,
      recordId: selectedRecordId.value || undefined,
    })
    if (loadVersion !== standaloneFormLoadVersion) return
    if (ctx.fields?.length) grid.fields.value = ctx.fields
    standaloneFormFieldPermissions.value = ctx.fieldPermissions ?? {}
    standaloneFormViewPermissions.value = ctx.viewPermissions ?? {}
    standaloneFormRowActions.value = ctx.rowActions ?? null
    if (ctx.record) {
      deepLinkedRecord.value = ctx.record
      deepLinkedRecordAttachmentSummaries.value = ctx.attachmentSummaries ?? {}
      deepLinkedRecordCommentsScope.value = ctx.commentsScope ?? null
      deepLinkedRecordFieldPermissions.value = ctx.fieldPermissions ?? {}
      deepLinkedRecordViewPermissions.value = ctx.viewPermissions ?? {}
      deepLinkedRecordRowActions.value = ctx.rowActions ?? null
      selectedRecordId.value = ctx.record.id
    }
  } catch { /* silent — grid loadViewData will handle */ }
}

function openWorkflowDesigner(recordId?: string) {
  void router.push({
    name: 'workflow-designer',
    query: {
      baseId: workbench.activeBaseId.value || undefined,
      sheetId: workbench.activeSheetId.value || undefined,
      viewId: workbench.activeViewId.value || undefined,
      recordId: recordId || undefined,
    },
  })
}

watch(
  [activeViewType, () => workbench.activeViewId.value, selectedRecordId],
  ([type, viewId]) => {
    if (type === 'form' && viewId) void loadStandaloneForm()
  },
)

watch(
  () => workbench.activeSheetId.value,
  (sheetId) => {
    showMentionPopover.value = false
    unsubscribeMentionRealtime?.()
    unsubscribeMentionRealtime = null
    commentMentionSuggestions.value = []
    commentMentionSuggestionsLoadedForSheetId.value = null

    if (!sheetId) {
      mentionInboxState.clearSummary()
      return
    }

    void mentionInboxState.loadSummary({ spreadsheetId: sheetId })
    void ensureCommentMentionSuggestions(true)
    unsubscribeMentionRealtime = subscribeToMultitableCommentSheetRealtime(sheetId, {
      onCommentCreated: mentionInboxState.onRealtimeCommentCreated,
      onCommentUpdated: mentionInboxState.onRealtimeCommentUpdated,
      onCommentResolved: mentionInboxState.onRealtimeCommentResolved,
      onCommentDeleted: mentionInboxState.onRealtimeCommentDeleted,
    })
  },
  { immediate: true },
)

watch(
  [() => workbench.activeSheetId.value, () => workbench.activeViewId.value],
  () => {
    standaloneFormFieldPermissions.value = {}
    standaloneFormViewPermissions.value = {}
    standaloneFormRowActions.value = null
    if (deepLinkedRecord.value && deepLinkedRecord.value.id !== selectedRecordId.value) {
      deepLinkedRecordFieldPermissions.value = {}
      deepLinkedRecordViewPermissions.value = {}
      deepLinkedRecordRowActions.value = null
    }
  },
)

watch(
  [showFieldManager, showViewManager, showImportModal, () => workbench.activeSheetId.value],
  ([fieldManagerVisible, viewManagerVisible, importVisible, activeSheetId], [_prevFieldVisible, _prevViewVisible, _prevImportVisible, prevSheetId]) => {
    const shouldRefresh = Boolean((fieldManagerVisible || viewManagerVisible || importVisible) && activeSheetId)
    if (!shouldRefresh) {
      stopDialogMetaRefresh()
      return
    }
    if (dialogMetaRefreshTimer == null || activeSheetId !== prevSheetId) {
      startDialogMetaRefresh()
    }
  },
)

watch(
  () => [props.baseId ?? '', props.sheetId ?? '', props.viewId ?? ''] as const,
  async ([baseId, sheetId, viewId], [prevBaseId, prevSheetId, prevViewId]) => {
    if (!workbenchReady.value) return
    if (baseId === prevBaseId && sheetId === prevSheetId && viewId === prevViewId) return
    await requestExternalContextSync({ baseId, sheetId, viewId })
  },
)

watch(
  [hasBlockingUnloadState, pendingExternalContext],
  ([blocked, pending]) => {
    if (!workbenchReady.value || blocked || !pending) return
    void replayPendingExternalContextIfReady()
  },
)

onMounted(async () => {
  window.addEventListener('beforeunload', onBeforeUnload)
  void auth.getCurrentUserId().then((userId) => {
    currentUserId.value = userId
  }).catch(() => undefined)
  try {
    await loadBases()
    if (workbench.activeBaseId.value) {
      await workbench.loadBaseContext(workbench.activeBaseId.value, {
        sheetId: props.sheetId,
        viewId: props.viewId,
      })
    } else {
      await workbench.loadSheets()
    }
    await commentInboxState.refreshUnreadCount().catch(() => undefined)
    const deepRecordId = props.recordId ?? parseDeepLink()
    if (deepRecordId) {
      await resolveDeepLink(deepRecordId, {
        openComments: props.openComments === true || Boolean(props.commentId),
        highlightCommentId: props.commentId ?? null,
        markReadCommentId: props.commentId ?? null,
        targetFieldId: props.fieldId ?? null,
      })
    }
    if (activeViewType.value === 'form') {
      await loadStandaloneForm()
    }
  } catch (e: any) {
    showError(e.message ?? 'Failed to initialize workbench')
  } finally {
    workbenchReady.value = true
    emit('ready', {
      baseId: workbench.activeBaseId.value ?? '',
      sheetId: workbench.activeSheetId.value ?? '',
      viewId: workbench.activeViewId.value ?? '',
    })
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
  stopDialogMetaRefresh()
  unsubscribeMentionRealtime?.()
})

useMultitableCommentRealtime({
  sheetId: computed(() => workbench.activeSheetId.value || undefined),
  selectedRecordId,
  commentsVisible: showComments,
  reloadSelectedRecordComments: async () => {
    if (!selectedRecordId.value) return
    await loadCommentsForRecord(selectedRecordId.value, {
      highlightCommentId: highlightedCommentId.value,
    })
  },
  refreshUnreadCount: async () => {
    await commentInboxState.refreshUnreadCount()
  },
})

useMultitableSheetRealtime({
  sheetId: computed(() => workbench.activeSheetId.value || undefined),
  selectedRecordId,
  visibleRecordIds: visibleCommentPresenceRecordIds,
  structuralFieldIds: structuralRealtimeFieldIds,
  reloadCurrentSheetPage: async () => {
    await grid.reloadCurrentPage()
  },
  reloadSelectedRecordContext: refreshSelectedRecordContext,
  applyRemoteRecordPatch: applyRemoteRecordPatchContext,
  mergeRemoteRecord: mergeRemoteRecordContext,
  removeLocalRecord: removeLocalRealtimeRecord,
})

defineExpose({
  confirmPageLeave,
  getEmbedHostState,
  requestExternalContextSync,
})
</script>

<style scoped>
.mt-workbench { display: flex; flex-direction: column; height: 100%; background: #fff; }
.mt-workbench__content { display: flex; flex: 1; min-height: 0; }
.mt-workbench__main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.mt-workbench__conflict {
  margin: 8px 16px 0;
  padding: 10px 12px;
  border: 1px solid #f3d08a;
  border-radius: 10px;
  background: #fff7e6;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.mt-workbench__conflict-copy { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #8a5a00; }
.mt-workbench__conflict-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mt-workbench__conflict-btn {
  padding: 6px 10px;
  border: 1px solid #d9b56d;
  border-radius: 8px;
  background: #fff;
  color: #8a5a00;
  cursor: pointer;
  font-size: 12px;
}
.mt-workbench__conflict-btn--primary { background: #f59e0b; border-color: #f59e0b; color: #fff; }
.mt-workbench__actions { display: flex; gap: 6px; padding: 4px 16px 0; }
.mt-workbench__presence-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border: 1px solid #91caff; border-radius: 12px; background: #e6f4ff; color: #0958d9; font-size: 12px; }
.mt-workbench__presence-chip strong { font-weight: 600; color: #003eb3; }
.mt-workbench__mention-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border: 1px solid #e6a23c; border-radius: 12px; background: #fdf6ec; font-size: 12px; cursor: pointer; color: #e6a23c; }
.mt-workbench__mention-chip:hover { background: #faecd8; border-color: #d48806; }
.mt-workbench__mention-chip strong { font-weight: 600; color: #d48806; }
.mt-workbench__mention-chip--unread { border-color: #d48806; background: #faecd8; }
.mt-workbench__mention-chip-unread { color: #d48806; font-size: 11px; font-weight: 600; }
.mt-workbench__mention-chip-records { color: #999; font-size: 11px; }
.mt-workbench__mgr-btn { padding: 3px 10px; border: 1px solid #ddd; border-radius: 4px; background: #fff; font-size: 12px; cursor: pointer; color: #666; }
.mt-workbench__mgr-btn:hover { background: #f5f7fa; color: #409eff; border-color: #c0d8f0; }
.mt-workbench__base-bar { padding: 8px 16px 0; border-bottom: 1px solid #f0f0f0; }
.mt-workbench__shortcuts-overlay { position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,.3); display: flex; align-items: center; justify-content: center; }
.mt-workbench__shortcuts { background: #fff; border-radius: 8px; padding: 20px 24px; min-width: 320px; box-shadow: 0 8px 24px rgba(0,0,0,.15); }
.mt-workbench__shortcuts-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; font-size: 15px; }
.mt-workbench__shortcuts-close { border: none; background: none; font-size: 20px; cursor: pointer; color: #999; }
.mt-workbench__shortcuts-grid { display: flex; flex-direction: column; gap: 8px; }
.mt-workbench__shortcut { display: flex; align-items: center; gap: 12px; font-size: 13px; }
.mt-workbench__shortcut kbd { background: #f0f0f0; border: 1px solid #ddd; border-radius: 3px; padding: 2px 8px; font-family: monospace; font-size: 12px; min-width: 80px; text-align: center; }
@media print {
  .mt-workbench__base-bar, .mt-workbench__actions, .mt-workbench__shortcuts-overlay { display: none !important; }
  .mt-workbench__content { overflow: visible !important; }
  .mt-workbench__main { overflow: visible !important; }
}
</style>
