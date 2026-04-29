<template>
  <div v-if="visible" class="meta-view-mgr__overlay" @click.self="requestClose">
    <div class="meta-view-mgr">
      <div class="meta-view-mgr__header">
        <h4 class="meta-view-mgr__title">Manage Views</h4>
        <button class="meta-view-mgr__close" @click="requestClose">&times;</button>
      </div>

      <div class="meta-view-mgr__body">
        <div
          v-for="view in views"
          :key="view.id"
          class="meta-view-mgr__row"
          :class="{ 'meta-view-mgr__row--active': view.id === activeViewId }"
        >
          <span class="meta-view-mgr__icon">{{ VIEW_ICONS[view.type] ?? '?' }}</span>

          <template v-if="editingId === view.id">
            <input
              class="meta-view-mgr__rename"
              :value="editingName"
              @input="editingName = ($event.target as HTMLInputElement).value"
              @keydown.enter="confirmRename(view.id)"
              @keydown.escape="cancelRename"
            />
            <button class="meta-view-mgr__action meta-view-mgr__action--ok" @click="confirmRename(view.id)">&#x2713;</button>
            <button class="meta-view-mgr__action" @click="cancelRename">&#x2717;</button>
          </template>
          <template v-else>
            <span class="meta-view-mgr__name" :title="view.name">{{ view.name }}</span>
            <span class="meta-view-mgr__type">{{ view.type }}</span>
            <button class="meta-view-mgr__action" title="Configure" @click="openConfig(view)">&#x2699;</button>
            <button class="meta-view-mgr__action" title="Conditional formatting" @click="openConditionalFormatting(view)">&#x1F3A8;</button>
            <button class="meta-view-mgr__action" title="Rename" @click="startRename(view)">&#x270E;</button>
            <button
              class="meta-view-mgr__action meta-view-mgr__action--danger"
              title="Delete"
              :disabled="views.length <= 1"
              @click="onDeleteView(view)"
            >&#x1F5D1;</button>
          </template>
        </div>

        <div v-if="!views.length" class="meta-view-mgr__empty">No views defined</div>
      </div>

      <div v-if="configTarget" class="meta-view-mgr__config">
        <div class="meta-view-mgr__config-header">
          <strong>Configure {{ configTarget.name }}</strong>
          <span>{{ configTarget.type }}</span>
        </div>
        <div v-if="viewConfigOutdated" class="meta-view-mgr__warning">
          <span>{{ viewConfigWarningText }}</span>
          <button class="meta-view-mgr__btn-inline" @click="reloadLatestConfig">Reload latest</button>
        </div>
        <div v-else-if="viewConfigLiveRefreshText" class="meta-view-mgr__refresh">
          <span>{{ viewConfigLiveRefreshText }}</span>
          <button class="meta-view-mgr__btn-inline" @click="dismissLiveRefreshNotice">Dismiss</button>
        </div>

        <template v-if="configTarget.type === 'gallery'">
          <label class="meta-view-mgr__field">
            <span>Title field</span>
            <select v-model="galleryDraft.titleFieldId" class="meta-view-mgr__select">
              <option value="">(auto)</option>
              <option v-for="field in stringFields" :key="field.id" :value="field.id">{{ field.name }}</option>
            </select>
          </label>
          <label class="meta-view-mgr__field">
            <span>Cover field</span>
            <select v-model="galleryDraft.coverFieldId" class="meta-view-mgr__select">
              <option value="">None</option>
              <option v-for="field in attachmentFields" :key="field.id" :value="field.id">{{ field.name }}</option>
            </select>
          </label>
          <div class="meta-view-mgr__field">
            <span>Card fields</span>
            <div class="meta-view-mgr__checks">
              <label v-for="field in configTargetFields" :key="field.id" class="meta-view-mgr__check">
                <input
                  type="checkbox"
                  :checked="galleryDraft.fieldIds.includes(field.id)"
                  @change="toggleFieldSelection(galleryDraft.fieldIds, field.id)"
                />
                <span>{{ field.name }}</span>
              </label>
            </div>
          </div>
          <div class="meta-view-mgr__grid">
            <label class="meta-view-mgr__field">
              <span>Columns</span>
              <input v-model.number="galleryDraft.columns" class="meta-view-mgr__input" type="number" min="1" max="4" />
            </label>
            <label class="meta-view-mgr__field">
              <span>Card size</span>
              <select v-model="galleryDraft.cardSize" class="meta-view-mgr__select">
                <option value="small">small</option>
                <option value="medium">medium</option>
                <option value="large">large</option>
              </select>
            </label>
          </div>
        </template>

        <template v-else-if="configTarget.type === 'calendar'">
          <div class="meta-view-mgr__grid">
            <label class="meta-view-mgr__field">
              <span>Date field</span>
              <select v-model="calendarDraft.dateFieldId" class="meta-view-mgr__select">
                <option value="">(auto)</option>
                <option v-for="field in dateLikeFields" :key="field.id" :value="field.id">{{ field.name }}</option>
              </select>
            </label>
            <label class="meta-view-mgr__field">
              <span>End date field</span>
              <select v-model="calendarDraft.endDateFieldId" class="meta-view-mgr__select">
                <option value="">None</option>
                <option v-for="field in dateLikeFields" :key="field.id" :value="field.id">{{ field.name }}</option>
              </select>
            </label>
          </div>
          <div class="meta-view-mgr__grid">
            <label class="meta-view-mgr__field">
              <span>Title field</span>
              <select v-model="calendarDraft.titleFieldId" class="meta-view-mgr__select">
                <option value="">(auto)</option>
                <option v-for="field in configTargetFields" :key="field.id" :value="field.id">{{ field.name }}</option>
              </select>
            </label>
            <label class="meta-view-mgr__field">
              <span>Week starts on</span>
              <select v-model.number="calendarDraft.weekStartsOn" class="meta-view-mgr__select">
                <option :value="0">Sunday</option>
                <option :value="1">Monday</option>
              </select>
            </label>
          </div>
        </template>

        <template v-else-if="configTarget.type === 'timeline'">
          <div class="meta-view-mgr__grid">
            <label class="meta-view-mgr__field">
              <span>Start field</span>
              <select v-model="timelineDraft.startFieldId" class="meta-view-mgr__select">
                <option value="">(auto)</option>
                <option v-for="field in dateFields" :key="field.id" :value="field.id">{{ field.name }}</option>
              </select>
            </label>
            <label class="meta-view-mgr__field">
              <span>End field</span>
              <select v-model="timelineDraft.endFieldId" class="meta-view-mgr__select">
                <option value="">(auto)</option>
                <option v-for="field in dateFields" :key="field.id" :value="field.id">{{ field.name }}</option>
              </select>
            </label>
          </div>
          <div class="meta-view-mgr__grid">
            <label class="meta-view-mgr__field">
              <span>Label field</span>
              <select v-model="timelineDraft.labelFieldId" class="meta-view-mgr__select">
                <option value="">(auto)</option>
                <option v-for="field in configTargetFields" :key="field.id" :value="field.id">{{ field.name }}</option>
              </select>
            </label>
            <label class="meta-view-mgr__field">
              <span>Zoom</span>
              <select v-model="timelineDraft.zoom" class="meta-view-mgr__select">
                <option value="day">day</option>
                <option value="week">week</option>
                <option value="month">month</option>
              </select>
            </label>
          </div>
        </template>

        <template v-else-if="configTarget.type === 'gantt'">
          <div class="meta-view-mgr__grid">
            <label class="meta-view-mgr__field">
              <span>Start field</span>
              <select v-model="ganttDraft.startFieldId" class="meta-view-mgr__select">
                <option value="">(auto)</option>
                <option v-for="field in dateFields" :key="field.id" :value="field.id">{{ field.name }}</option>
              </select>
            </label>
            <label class="meta-view-mgr__field">
              <span>End field</span>
              <select v-model="ganttDraft.endFieldId" class="meta-view-mgr__select">
                <option value="">(auto)</option>
                <option v-for="field in dateFields" :key="field.id" :value="field.id">{{ field.name }}</option>
              </select>
            </label>
          </div>
          <div class="meta-view-mgr__grid">
            <label class="meta-view-mgr__field">
              <span>Title field</span>
              <select v-model="ganttDraft.titleFieldId" class="meta-view-mgr__select">
                <option value="">(auto)</option>
                <option v-for="field in configTargetFields" :key="field.id" :value="field.id">{{ field.name }}</option>
              </select>
            </label>
            <label class="meta-view-mgr__field">
              <span>Progress field</span>
              <select v-model="ganttDraft.progressFieldId" class="meta-view-mgr__select">
                <option value="">None</option>
                <option v-for="field in numericFields" :key="field.id" :value="field.id">{{ field.name }}</option>
              </select>
            </label>
          </div>
          <div class="meta-view-mgr__grid">
            <label class="meta-view-mgr__field">
              <span>Gantt group field</span>
              <select v-model="ganttDraft.groupFieldId" class="meta-view-mgr__select">
                <option value="">None</option>
                <option v-for="field in groupableFields" :key="field.id" :value="field.id">{{ field.name }}</option>
              </select>
            </label>
            <label class="meta-view-mgr__field">
              <span>Zoom</span>
              <select v-model="ganttDraft.zoom" class="meta-view-mgr__select">
                <option value="day">day</option>
                <option value="week">week</option>
                <option value="month">month</option>
              </select>
            </label>
          </div>
        </template>

        <template v-else-if="configTarget.type === 'kanban'">
          <label class="meta-view-mgr__field">
            <span>Group field</span>
            <select v-model="kanbanDraft.groupFieldId" class="meta-view-mgr__select">
              <option value="">(none)</option>
              <option v-for="field in selectFields" :key="field.id" :value="field.id">{{ field.name }}</option>
            </select>
          </label>
          <div class="meta-view-mgr__field">
            <span>Card fields</span>
            <div class="meta-view-mgr__checks">
              <label v-for="field in configTargetFields" :key="field.id" class="meta-view-mgr__check">
                <input
                  type="checkbox"
                  :checked="kanbanDraft.cardFieldIds.includes(field.id)"
                  @change="toggleFieldSelection(kanbanDraft.cardFieldIds, field.id)"
                />
                <span>{{ field.name }}</span>
              </label>
            </div>
          </div>
        </template>

        <template v-else-if="configTarget.type === 'hierarchy'">
          <div class="meta-view-mgr__grid">
            <label class="meta-view-mgr__field">
              <span>Parent field</span>
              <select v-model="hierarchyDraft.parentFieldId" class="meta-view-mgr__select">
                <option value="">(auto link field)</option>
                <option v-for="field in linkFields" :key="field.id" :value="field.id">{{ field.name }}</option>
              </select>
            </label>
            <label class="meta-view-mgr__field">
              <span>Title field</span>
              <select v-model="hierarchyDraft.titleFieldId" class="meta-view-mgr__select">
                <option value="">(auto)</option>
                <option v-for="field in configTargetFields" :key="field.id" :value="field.id">{{ field.name }}</option>
              </select>
            </label>
          </div>
          <div class="meta-view-mgr__grid">
            <label class="meta-view-mgr__field">
              <span>Default expand depth</span>
              <input v-model.number="hierarchyDraft.defaultExpandDepth" class="meta-view-mgr__input" type="number" min="0" max="8" />
            </label>
            <label class="meta-view-mgr__field">
              <span>Orphan records</span>
              <select v-model="hierarchyDraft.orphanMode" class="meta-view-mgr__select">
                <option value="root">show at root</option>
                <option value="hidden">hide</option>
              </select>
            </label>
          </div>
        </template>

        <div v-else class="meta-view-mgr__config-note">
          No additional configuration is required for this view type.
        </div>

        <div class="meta-view-mgr__common">
          <div class="meta-view-mgr__common-header">
            <strong>Filter, sort, group</strong>
            <span>Shared by grid and visual views</span>
          </div>

          <div class="meta-view-mgr__field">
            <div class="meta-view-mgr__subheader">
              <span>Filters</span>
              <select
                v-if="filterDraft.conditions.length > 1"
                v-model="filterDraft.conjunction"
                class="meta-view-mgr__select meta-view-mgr__select--compact"
              >
                <option value="and">all conditions</option>
                <option value="or">any condition</option>
              </select>
            </div>
            <div v-if="filterDraft.conditions.length" class="meta-view-mgr__rules">
              <div
                v-for="(rule, idx) in filterDraft.conditions"
                :key="idx"
                class="meta-view-mgr__rule-row meta-view-mgr__rule-row--filter"
              >
                <select
                  :value="rule.fieldId"
                  class="meta-view-mgr__select"
                  @change="updateFilterField(idx, ($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="field in configTargetFields" :key="field.id" :value="field.id">{{ field.name }}</option>
                </select>
                <select
                  :value="rule.operator"
                  class="meta-view-mgr__select"
                  @change="updateFilterOperator(idx, ($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="operator in operatorsForField(rule.fieldId)" :key="operator.value" :value="operator.value">{{ operator.label }}</option>
                </select>
                <input
                  v-if="!isUnaryFilterOperator(rule.operator)"
                  class="meta-view-mgr__input"
                  :type="inputTypeForField(rule.fieldId)"
                  :value="rule.value ?? ''"
                  @change="updateFilterValue(idx, ($event.target as HTMLInputElement).value)"
                />
                <span v-else class="meta-view-mgr__rule-empty">no value</span>
                <button class="meta-view-mgr__action meta-view-mgr__action--danger" @click="removeFilterRule(idx)">&times;</button>
              </div>
            </div>
            <button v-if="configTargetFields.length" class="meta-view-mgr__btn-inline" @click="addFilterRule">+ Add filter</button>
          </div>

          <div class="meta-view-mgr__field">
            <div class="meta-view-mgr__subheader">
              <span>Sorts</span>
            </div>
            <div v-if="sortDraft.rules.length" class="meta-view-mgr__rules">
              <div
                v-for="(rule, idx) in sortDraft.rules"
                :key="idx"
                class="meta-view-mgr__rule-row"
              >
                <select
                  :value="rule.fieldId"
                  class="meta-view-mgr__select"
                  @change="updateSortField(idx, ($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="field in configTargetFields" :key="field.id" :value="field.id">{{ field.name }}</option>
                </select>
                <select
                  :value="rule.direction"
                  class="meta-view-mgr__select"
                  @change="updateSortDirection(idx, ($event.target as HTMLSelectElement).value as 'asc' | 'desc')"
                >
                  <option value="asc">A to Z</option>
                  <option value="desc">Z to A</option>
                </select>
                <button class="meta-view-mgr__action meta-view-mgr__action--danger" @click="removeSortRule(idx)">&times;</button>
              </div>
            </div>
            <button v-if="configTargetFields.length" class="meta-view-mgr__btn-inline" @click="addSortRule">+ Add sort</button>
          </div>

          <label v-if="configTarget.type !== 'kanban' && configTarget.type !== 'gantt' && configTarget.type !== 'hierarchy'" class="meta-view-mgr__field">
            <span>Group field</span>
            <select v-model="groupDraft.fieldId" class="meta-view-mgr__select">
              <option value="">None</option>
              <option v-for="field in groupableFields" :key="field.id" :value="field.id">{{ field.name }}</option>
            </select>
          </label>
        </div>

        <div class="meta-view-mgr__config-actions">
          <button class="meta-view-mgr__btn-cancel" @click="closeConfig">Cancel</button>
          <button class="meta-view-mgr__btn-add" :disabled="Boolean(viewConfigBlockingReason)" @click="saveConfig">Save view settings</button>
        </div>
      </div>

      <div class="meta-view-mgr__add-section">
        <div class="meta-view-mgr__add-row">
          <input
            v-model="newViewName"
            class="meta-view-mgr__input"
            placeholder="View name"
            @keydown.enter="onAddView"
          />
          <select v-model="newViewType" class="meta-view-mgr__select">
            <option v-for="t in VIEW_TYPES" :key="t" :value="t">{{ t }}</option>
          </select>
          <button class="meta-view-mgr__btn-add" :disabled="!newViewName.trim()" @click="onAddView">+ Add</button>
        </div>
      </div>

      <div v-if="deleteTarget" class="meta-view-mgr__confirm">
        <p>Delete view <strong>{{ deleteTarget.name }}</strong>? This cannot be undone.</p>
        <div class="meta-view-mgr__confirm-actions">
          <button class="meta-view-mgr__btn-cancel" @click="deleteTargetId = null">Cancel</button>
          <button class="meta-view-mgr__btn-delete" @click="confirmDelete">Delete</button>
        </div>
      </div>
    </div>
    <ConditionalFormattingDialog
      :visible="conditionalFormattingTargetId !== null"
      :fields="fields"
      :view-config="conditionalFormattingTargetView?.config"
      @update:dirty="conditionalFormattingDirty = $event"
      @close="closeConditionalFormatting"
      @save="onSaveConditionalFormatting"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import type {
  ConditionalFormattingRule,
  MetaCalendarViewConfig,
  MetaField,
  MetaGanttViewConfig,
  MetaGalleryViewConfig,
  MetaHierarchyViewConfig,
  MetaKanbanViewConfig,
  MetaTimelineViewConfig,
  MetaView,
} from '../types'
import {
  FILTER_OPERATORS_BY_TYPE,
  type FilterConjunction,
  type FilterRule,
  type SortRule,
} from '../composables/useMultitableGrid'
import {
  resolveCalendarViewConfig,
  resolveGanttViewConfig,
  resolveGalleryViewConfig,
  resolveHierarchyViewConfig,
  resolveKanbanViewConfig,
  resolveTimelineViewConfig,
} from '../utils/view-config'
import ConditionalFormattingDialog from './ConditionalFormattingDialog.vue'

const VIEW_TYPES = ['grid', 'form', 'kanban', 'gallery', 'calendar', 'timeline', 'gantt', 'hierarchy'] as const
const VIEW_ICONS: Record<string, string> = {
  grid: '\u2637',
  form: '\u2263',
  kanban: '\u2630',
  gallery: '\u25A6',
  calendar: '\u2339',
  timeline: '\u2500',
  gantt: '\u25AC',
  hierarchy: '\u251C',
}

const props = defineProps<{
  visible: boolean
  views: MetaView[]
  fields: MetaField[]
  sheetId: string
  activeViewId: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'create-view', input: { sheetId: string; name: string; type: string }): void
  (e: 'update-view', viewId: string, input: {
    name?: string
    config?: Record<string, unknown>
    filterInfo?: Record<string, unknown>
    sortInfo?: Record<string, unknown>
    groupInfo?: Record<string, unknown>
  }): void
  (e: 'delete-view', viewId: string): void
  (e: 'update:dirty', dirty: boolean): void
}>()

const newViewName = ref('')
const newViewType = ref<string>('grid')
const editingId = ref<string | null>(null)
const editingName = ref('')
const deleteTargetId = ref<string | null>(null)
const configTargetId = ref<string | null>(null)

const galleryDraft = reactive<Required<MetaGalleryViewConfig>>({
  titleFieldId: null,
  coverFieldId: null,
  fieldIds: [],
  columns: 3,
  cardSize: 'medium',
})
const calendarDraft = reactive<Required<MetaCalendarViewConfig>>({
  dateFieldId: null,
  endDateFieldId: null,
  titleFieldId: null,
  defaultView: 'month',
  weekStartsOn: 0,
})
const kanbanDraft = reactive<Required<MetaKanbanViewConfig>>({
  groupFieldId: null,
  cardFieldIds: [],
})
const timelineDraft = reactive<Required<MetaTimelineViewConfig>>({
  startFieldId: null,
  endFieldId: null,
  labelFieldId: null,
  zoom: 'week',
})
const ganttDraft = reactive<Required<MetaGanttViewConfig>>({
  startFieldId: null,
  endFieldId: null,
  titleFieldId: null,
  progressFieldId: null,
  groupFieldId: null,
  zoom: 'week',
})
const hierarchyDraft = reactive<Required<MetaHierarchyViewConfig>>({
  parentFieldId: null,
  titleFieldId: null,
  defaultExpandDepth: 2,
  orphanMode: 'root',
})
const filterDraft = reactive<{ conjunction: FilterConjunction; conditions: FilterRule[] }>({
  conjunction: 'and',
  conditions: [],
})
const sortDraft = reactive<{ rules: SortRule[] }>({
  rules: [],
})
const groupDraft = reactive<{ fieldId: string }>({
  fieldId: '',
})
const viewConfigBaseline = ref('')
const viewConfigOutdated = ref(false)
const viewConfigLiveRefreshText = ref('')
const viewConfigSourceSignature = ref('')
const conditionalFormattingTargetId = ref<string | null>(null)
const conditionalFormattingDirty = ref(false)

const configTarget = computed(() => props.views.find((view) => view.id === configTargetId.value) ?? null)
const conditionalFormattingTargetView = computed(() =>
  props.views.find((view) => view.id === conditionalFormattingTargetId.value) ?? null,
)
const deleteTarget = computed(() => props.views.find((view) => view.id === deleteTargetId.value) ?? null)
const configTargetFields = computed(() => props.fields)
const attachmentFields = computed(() => props.fields.filter((field) => field.type === 'attachment'))
const dateFields = computed(() => props.fields.filter((field) => field.type === 'date'))
const dateLikeFields = computed(() => props.fields.filter((field) => field.type === 'date' || field.type === 'string' || field.type === 'number'))
const numericFields = computed(() => props.fields.filter((field) => ['number', 'currency', 'percent', 'rating'].includes(field.type)))
const selectFields = computed(() => props.fields.filter((field) => field.type === 'select'))
const linkFields = computed(() => props.fields.filter((field) => field.type === 'link'))
const stringFields = computed(() => props.fields.filter((field) => ['string', 'formula', 'lookup'].includes(field.type)))
const groupableFields = computed(() => props.fields.filter((field) => ['select', 'string', 'boolean', 'number', 'date'].includes(field.type)))
const validFieldIds = computed(() => new Set(props.fields.map((field) => field.id)))
const validStringFieldIds = computed(() => new Set(stringFields.value.map((field) => field.id)))
const validAttachmentFieldIds = computed(() => new Set(attachmentFields.value.map((field) => field.id)))
const validDateFieldIds = computed(() => new Set(dateFields.value.map((field) => field.id)))
const validDateLikeFieldIds = computed(() => new Set(dateLikeFields.value.map((field) => field.id)))
const validSelectFieldIds = computed(() => new Set(selectFields.value.map((field) => field.id)))
const validLinkFieldIds = computed(() => new Set(linkFields.value.map((field) => field.id)))
const validGroupableFieldIds = computed(() => new Set(groupableFields.value.map((field) => field.id)))

const viewConfigBlockingReason = computed(() => {
  const target = configTarget.value
  if (!target || !viewConfigOutdated.value) return ''

  if (target.type === 'gallery') {
    if (galleryDraft.titleFieldId && !validStringFieldIds.value.has(galleryDraft.titleFieldId)) {
      return 'A selected title field is no longer a text-like field. Reload latest before saving.'
    }
    if (galleryDraft.coverFieldId && !validAttachmentFieldIds.value.has(galleryDraft.coverFieldId)) {
      return 'A selected cover field is no longer an attachment field. Reload latest before saving.'
    }
    if (galleryDraft.fieldIds.some((fieldId) => !validFieldIds.value.has(fieldId))) {
      return 'One or more selected card fields disappeared in the background. Reload latest before saving.'
    }
  }

  if (target.type === 'calendar') {
    if (calendarDraft.dateFieldId && !validDateLikeFieldIds.value.has(calendarDraft.dateFieldId)) {
      return 'The selected date field is no longer date-like. Reload latest before saving.'
    }
    if (calendarDraft.endDateFieldId && !validDateLikeFieldIds.value.has(calendarDraft.endDateFieldId)) {
      return 'The selected end date field is no longer date-like. Reload latest before saving.'
    }
    if (calendarDraft.titleFieldId && !validFieldIds.value.has(calendarDraft.titleFieldId)) {
      return 'The selected title field disappeared in the background. Reload latest before saving.'
    }
  }

  if (target.type === 'timeline') {
    if (timelineDraft.startFieldId && !validDateFieldIds.value.has(timelineDraft.startFieldId)) {
      return 'The selected start field is no longer a date field. Reload latest before saving.'
    }
    if (timelineDraft.endFieldId && !validDateFieldIds.value.has(timelineDraft.endFieldId)) {
      return 'The selected end field is no longer a date field. Reload latest before saving.'
    }
    if (timelineDraft.labelFieldId && !validFieldIds.value.has(timelineDraft.labelFieldId)) {
      return 'The selected label field disappeared in the background. Reload latest before saving.'
    }
  }

  if (target.type === 'gantt') {
    if (ganttDraft.startFieldId && !validDateFieldIds.value.has(ganttDraft.startFieldId)) {
      return 'The selected start field is no longer a date field. Reload latest before saving.'
    }
    if (ganttDraft.endFieldId && !validDateFieldIds.value.has(ganttDraft.endFieldId)) {
      return 'The selected end field is no longer a date field. Reload latest before saving.'
    }
    if (ganttDraft.titleFieldId && !validFieldIds.value.has(ganttDraft.titleFieldId)) {
      return 'The selected title field disappeared in the background. Reload latest before saving.'
    }
    if (ganttDraft.progressFieldId && !numericFields.value.some((field) => field.id === ganttDraft.progressFieldId)) {
      return 'The selected progress field is no longer numeric. Reload latest before saving.'
    }
    if (ganttDraft.groupFieldId && !validGroupableFieldIds.value.has(ganttDraft.groupFieldId)) {
      return 'The selected Gantt group field is no longer groupable. Reload latest before saving.'
    }
  }

  if (target.type === 'kanban') {
    if (kanbanDraft.groupFieldId && !validSelectFieldIds.value.has(kanbanDraft.groupFieldId)) {
      return 'The selected group field is no longer a select field. Reload latest before saving.'
    }
    if (kanbanDraft.cardFieldIds.some((fieldId) => !validFieldIds.value.has(fieldId))) {
      return 'One or more selected card fields disappeared in the background. Reload latest before saving.'
    }
  }

  if (target.type === 'hierarchy') {
    if (hierarchyDraft.parentFieldId && !validLinkFieldIds.value.has(hierarchyDraft.parentFieldId)) {
      return 'The selected parent field is no longer a link field. Reload latest before saving.'
    }
    if (hierarchyDraft.titleFieldId && !validFieldIds.value.has(hierarchyDraft.titleFieldId)) {
      return 'The selected title field disappeared in the background. Reload latest before saving.'
    }
  }

  if (filterDraft.conditions.some((condition) => condition.fieldId && !validFieldIds.value.has(condition.fieldId))) {
    return 'One or more selected filter fields disappeared in the background. Reload latest before saving.'
  }
  if (sortDraft.rules.some((rule) => rule.fieldId && !validFieldIds.value.has(rule.fieldId))) {
    return 'One or more selected sort fields disappeared in the background. Reload latest before saving.'
  }
  if (target.type !== 'kanban' && target.type !== 'gantt' && target.type !== 'hierarchy' && groupDraft.fieldId && !validGroupableFieldIds.value.has(groupDraft.fieldId)) {
    return 'The selected group field is no longer groupable. Reload latest before saving.'
  }

  return ''
})

const viewConfigWarningText = computed(() => {
  return viewConfigBlockingReason.value || 'This view changed in the background. Save keeps your draft, or reload the latest settings.'
})

function resetConfigDrafts() {
  Object.assign(galleryDraft, {
    titleFieldId: null,
    coverFieldId: null,
    fieldIds: [],
    columns: 3,
    cardSize: 'medium',
  } satisfies Required<MetaGalleryViewConfig>)
  Object.assign(calendarDraft, {
    dateFieldId: null,
    endDateFieldId: null,
    titleFieldId: null,
    defaultView: 'month',
    weekStartsOn: 0,
  } satisfies Required<MetaCalendarViewConfig>)
  Object.assign(kanbanDraft, {
    groupFieldId: null,
    cardFieldIds: [],
  } satisfies Required<MetaKanbanViewConfig>)
  Object.assign(timelineDraft, {
    startFieldId: null,
    endFieldId: null,
    labelFieldId: null,
    zoom: 'week',
  } satisfies Required<MetaTimelineViewConfig>)
  Object.assign(ganttDraft, {
    startFieldId: null,
    endFieldId: null,
    titleFieldId: null,
    progressFieldId: null,
    groupFieldId: null,
    zoom: 'week',
  } satisfies Required<MetaGanttViewConfig>)
  Object.assign(hierarchyDraft, {
    parentFieldId: null,
    titleFieldId: null,
    defaultExpandDepth: 2,
    orphanMode: 'root',
  } satisfies Required<MetaHierarchyViewConfig>)
  filterDraft.conjunction = 'and'
  filterDraft.conditions.splice(0)
  sortDraft.rules.splice(0)
  groupDraft.fieldId = ''
}

function resetTransientState() {
  newViewName.value = ''
  newViewType.value = 'grid'
  editingId.value = null
  editingName.value = ''
  deleteTargetId.value = null
  configTargetId.value = null
  viewConfigBaseline.value = ''
  viewConfigOutdated.value = false
  viewConfigLiveRefreshText.value = ''
  viewConfigSourceSignature.value = ''
  conditionalFormattingTargetId.value = null
  conditionalFormattingDirty.value = false
  resetConfigDrafts()
}

function requestClose() {
  if (!confirmDiscardViewManagerChanges()) return
  resetTransientState()
  emit('close')
}

function onAddView() {
  const name = newViewName.value.trim()
  if (!name) return
  emit('create-view', { sheetId: props.sheetId, name, type: newViewType.value })
  newViewName.value = ''
}

function startRename(view: MetaView) {
  if (editingId.value !== view.id && !confirmDiscardViewManagerChanges()) return
  editingId.value = view.id
  editingName.value = view.name
}

function confirmRename(viewId: string) {
  const name = editingName.value.trim()
  if (name && name !== props.views.find((view) => view.id === viewId)?.name) {
    emit('update-view', viewId, { name })
  }
  cancelRename()
}

function cancelRename() {
  editingId.value = null
  editingName.value = ''
}

function onDeleteView(view: MetaView) {
  deleteTargetId.value = view.id
}

function confirmDelete() {
  if (deleteTarget.value) {
    emit('delete-view', deleteTarget.value.id)
    deleteTargetId.value = null
  }
}

function openConfig(view: MetaView) {
  if (configTargetId.value && configTargetId.value !== view.id && !confirmDiscardViewManagerChanges()) return
  hydrateExistingViewConfig(view)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function hasPayload(value: Record<string, unknown> | null | undefined): boolean {
  return Boolean(value && Object.keys(value).length > 0)
}

function hydrateCommonViewRules(view: MetaView) {
  const filterInfo = asRecord(view.filterInfo)
  const conditions = Array.isArray(filterInfo.conditions) ? filterInfo.conditions : []
  filterDraft.conjunction = filterInfo.conjunction === 'or' ? 'or' : 'and'
  filterDraft.conditions.splice(0, filterDraft.conditions.length, ...conditions
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      fieldId: String(item.fieldId ?? ''),
      operator: String(item.operator ?? 'is'),
      value: item.value,
    }))
    .filter((item) => item.fieldId))

  const sortInfo = asRecord(view.sortInfo)
  const sortRules = Array.isArray(sortInfo.rules) ? sortInfo.rules : []
  sortDraft.rules.splice(0, sortDraft.rules.length, ...sortRules
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      fieldId: String(item.fieldId ?? ''),
      direction: item.desc === true ? 'desc' as const : 'asc' as const,
    }))
    .filter((item) => item.fieldId))

  const groupInfo = asRecord(view.groupInfo)
  groupDraft.fieldId = typeof groupInfo.fieldId === 'string' ? groupInfo.fieldId : ''
}

function serializeCommonViewDraft(type: MetaView['type'] | null): Record<string, unknown> {
  return {
    filterInfo: filterDraft.conditions.map((condition) => ({
      fieldId: condition.fieldId,
      operator: condition.operator,
      value: condition.value,
    })),
    filterConjunction: filterDraft.conjunction,
    sortInfo: sortDraft.rules.map((rule) => ({
      fieldId: rule.fieldId,
      direction: rule.direction,
    })),
    groupInfo: type === 'kanban'
      ? kanbanDraft.groupFieldId
      : type === 'gantt'
        ? ganttDraft.groupFieldId
        : type === 'hierarchy'
          ? ''
        : groupDraft.fieldId,
  }
}

function serializeViewDraft(type: MetaView['type'] | null): string {
  if (type === 'gallery') {
    return JSON.stringify({
      titleFieldId: galleryDraft.titleFieldId,
      coverFieldId: galleryDraft.coverFieldId,
      fieldIds: [...galleryDraft.fieldIds],
      columns: galleryDraft.columns,
      cardSize: galleryDraft.cardSize,
      ...serializeCommonViewDraft(type),
    })
  }
  if (type === 'calendar') {
    return JSON.stringify({
      dateFieldId: calendarDraft.dateFieldId,
      endDateFieldId: calendarDraft.endDateFieldId,
      titleFieldId: calendarDraft.titleFieldId,
      defaultView: calendarDraft.defaultView,
      weekStartsOn: calendarDraft.weekStartsOn,
      ...serializeCommonViewDraft(type),
    })
  }
  if (type === 'timeline') {
    return JSON.stringify({
      startFieldId: timelineDraft.startFieldId,
      endFieldId: timelineDraft.endFieldId,
      labelFieldId: timelineDraft.labelFieldId,
      zoom: timelineDraft.zoom,
      ...serializeCommonViewDraft(type),
    })
  }
  if (type === 'gantt') {
    return JSON.stringify({
      startFieldId: ganttDraft.startFieldId,
      endFieldId: ganttDraft.endFieldId,
      titleFieldId: ganttDraft.titleFieldId,
      progressFieldId: ganttDraft.progressFieldId,
      groupFieldId: ganttDraft.groupFieldId,
      zoom: ganttDraft.zoom,
      ...serializeCommonViewDraft(type),
    })
  }
  if (type === 'kanban') {
    return JSON.stringify({
      groupFieldId: kanbanDraft.groupFieldId,
      cardFieldIds: [...kanbanDraft.cardFieldIds],
      ...serializeCommonViewDraft(type),
    })
  }
  if (type === 'hierarchy') {
    return JSON.stringify({
      parentFieldId: hierarchyDraft.parentFieldId,
      titleFieldId: hierarchyDraft.titleFieldId,
      defaultExpandDepth: hierarchyDraft.defaultExpandDepth,
      orphanMode: hierarchyDraft.orphanMode,
      ...serializeCommonViewDraft(type),
    })
  }
  return JSON.stringify(serializeCommonViewDraft(type))
}

function serializeViewSourceSignature(view: MetaView | null): string {
  if (!view) return ''
  return JSON.stringify({
    id: view.id,
    name: view.name,
    type: view.type,
    config: view.config ?? null,
    filterInfo: view.filterInfo ?? null,
    sortInfo: view.sortInfo ?? null,
    groupInfo: view.groupInfo ?? null,
    fields: props.fields.map((field) => ({
      id: field.id,
      name: field.name,
      type: field.type,
    })),
  })
}

function hydrateExistingViewConfig(view: MetaView, options?: { liveRefreshText?: string }) {
  configTargetId.value = view.id
  viewConfigOutdated.value = false
  viewConfigLiveRefreshText.value = options?.liveRefreshText ?? ''
  hydrateCommonViewRules(view)
  if (view.type === 'gallery') {
    Object.assign(galleryDraft, resolveGalleryViewConfig(props.fields, view.config))
  } else if (view.type === 'calendar') {
    Object.assign(calendarDraft, resolveCalendarViewConfig(props.fields, view.config))
  } else if (view.type === 'timeline') {
    Object.assign(timelineDraft, resolveTimelineViewConfig(props.fields, view.config))
  } else if (view.type === 'gantt') {
    Object.assign(ganttDraft, resolveGanttViewConfig(props.fields, view.config, view.groupInfo))
  } else if (view.type === 'kanban') {
    Object.assign(kanbanDraft, resolveKanbanViewConfig(props.fields, view.config, view.groupInfo))
  } else if (view.type === 'hierarchy') {
    Object.assign(hierarchyDraft, resolveHierarchyViewConfig(props.fields, view.config))
  }
  viewConfigBaseline.value = serializeViewDraft(view.type)
  viewConfigSourceSignature.value = serializeViewSourceSignature(view)
}

function closeConfig() {
  configTargetId.value = null
  viewConfigBaseline.value = ''
  viewConfigOutdated.value = false
  viewConfigLiveRefreshText.value = ''
  viewConfigSourceSignature.value = ''
  resetConfigDrafts()
}

function dismissLiveRefreshNotice() {
  viewConfigLiveRefreshText.value = ''
}

function toggleFieldSelection(values: string[], fieldId: string) {
  const next = values.includes(fieldId)
    ? values.filter((value) => value !== fieldId)
    : [...values, fieldId]
  values.splice(0, values.length, ...next)
}

function preserveConditionalFormattingRules(target: MetaView, config: Record<string, unknown>): Record<string, unknown> {
  const existingConfig = target.config ?? {}
  if (!Object.prototype.hasOwnProperty.call(existingConfig, 'conditionalFormattingRules')) {
    return config
  }
  return {
    ...config,
    conditionalFormattingRules: existingConfig.conditionalFormattingRules,
  }
}

const UNARY_FILTER_OPERATORS = new Set(['isEmpty', 'isNotEmpty'])

function isUnaryFilterOperator(operator: string): boolean {
  return UNARY_FILTER_OPERATORS.has(operator)
}

function operatorsForField(fieldId: string) {
  const fieldType = props.fields.find((field) => field.id === fieldId)?.type ?? 'string'
  return FILTER_OPERATORS_BY_TYPE[fieldType] ?? FILTER_OPERATORS_BY_TYPE.string
}

function inputTypeForField(fieldId: string): string {
  const fieldType = props.fields.find((field) => field.id === fieldId)?.type ?? 'string'
  if (fieldType === 'number' || fieldType === 'currency' || fieldType === 'percent' || fieldType === 'rating') return 'number'
  if (fieldType === 'date') return 'date'
  return 'text'
}

function addFilterRule() {
  const firstField = configTargetFields.value[0]
  if (!firstField) return
  const operator = operatorsForField(firstField.id)[0]?.value ?? 'is'
  filterDraft.conditions.push({ fieldId: firstField.id, operator, value: isUnaryFilterOperator(operator) ? undefined : '' })
}

function updateFilterField(index: number, fieldId: string) {
  const operator = operatorsForField(fieldId)[0]?.value ?? 'is'
  filterDraft.conditions[index] = {
    fieldId,
    operator,
    value: isUnaryFilterOperator(operator) ? undefined : '',
  }
}

function updateFilterOperator(index: number, operator: string) {
  const rule = filterDraft.conditions[index]
  if (!rule) return
  filterDraft.conditions[index] = {
    ...rule,
    operator,
    value: isUnaryFilterOperator(operator) ? undefined : rule.value ?? '',
  }
}

function updateFilterValue(index: number, value: string) {
  const rule = filterDraft.conditions[index]
  if (!rule) return
  const fieldType = props.fields.find((field) => field.id === rule.fieldId)?.type ?? 'string'
  filterDraft.conditions[index] = {
    ...rule,
    value: ['number', 'currency', 'percent', 'rating'].includes(fieldType) && value !== '' ? Number(value) : value,
  }
}

function removeFilterRule(index: number) {
  filterDraft.conditions.splice(index, 1)
}

function addSortRule() {
  const firstField = configTargetFields.value[0]
  if (!firstField) return
  sortDraft.rules.push({ fieldId: firstField.id, direction: 'asc' })
}

function updateSortField(index: number, fieldId: string) {
  const rule = sortDraft.rules[index]
  if (!rule) return
  sortDraft.rules[index] = { ...rule, fieldId }
}

function updateSortDirection(index: number, direction: 'asc' | 'desc') {
  const rule = sortDraft.rules[index]
  if (!rule) return
  sortDraft.rules[index] = { ...rule, direction }
}

function removeSortRule(index: number) {
  sortDraft.rules.splice(index, 1)
}

function buildFilterInfoPayload(): Record<string, unknown> {
  const conditions = filterDraft.conditions
    .filter((condition) => validFieldIds.value.has(condition.fieldId))
    .map((condition) => ({
      fieldId: condition.fieldId,
      operator: condition.operator,
      value: condition.value,
    }))
  return conditions.length > 0 ? { conjunction: filterDraft.conjunction, conditions } : {}
}

function buildSortInfoPayload(): Record<string, unknown> {
  const rules = sortDraft.rules
    .filter((rule) => validFieldIds.value.has(rule.fieldId))
    .map((rule) => ({ fieldId: rule.fieldId, desc: rule.direction === 'desc' }))
  return rules.length > 0 ? { rules } : {}
}

function buildCommonViewPayload(target: MetaView): {
  filterInfo?: Record<string, unknown>
  sortInfo?: Record<string, unknown>
  groupInfo?: Record<string, unknown>
} {
  const filterInfo = buildFilterInfoPayload()
  const sortInfo = buildSortInfoPayload()
  const groupInfo = target.type === 'kanban'
    ? undefined
    : target.type === 'gantt'
      ? ganttDraft.groupFieldId && validGroupableFieldIds.value.has(ganttDraft.groupFieldId)
        ? { fieldId: ganttDraft.groupFieldId }
        : {}
      : target.type === 'hierarchy'
        ? undefined
        : groupDraft.fieldId && validGroupableFieldIds.value.has(groupDraft.fieldId)
          ? { fieldId: groupDraft.fieldId }
          : {}
  return {
    ...(hasPayload(filterInfo) || hasPayload(target.filterInfo) ? { filterInfo } : {}),
    ...(hasPayload(sortInfo) || hasPayload(target.sortInfo) ? { sortInfo } : {}),
    ...(groupInfo && (hasPayload(groupInfo) || hasPayload(target.groupInfo)) ? { groupInfo } : {}),
  }
}

function saveConfig() {
  const target = configTarget.value
  if (!target || viewConfigBlockingReason.value) return
  const commonPayload = buildCommonViewPayload(target)

  if (target.type === 'gallery') {
    const fieldIds = galleryDraft.fieldIds.filter((fieldId) => validFieldIds.value.has(fieldId))
    emit('update-view', target.id, {
      ...commonPayload,
      config: preserveConditionalFormattingRules(target, {
        titleFieldId: galleryDraft.titleFieldId && validStringFieldIds.value.has(galleryDraft.titleFieldId) ? galleryDraft.titleFieldId : null,
        coverFieldId: galleryDraft.coverFieldId && validAttachmentFieldIds.value.has(galleryDraft.coverFieldId) ? galleryDraft.coverFieldId : null,
        fieldIds,
        columns: galleryDraft.columns,
        cardSize: galleryDraft.cardSize,
      }),
    })
  } else if (target.type === 'calendar') {
    emit('update-view', target.id, {
      ...commonPayload,
      config: preserveConditionalFormattingRules(target, {
        dateFieldId: calendarDraft.dateFieldId && validDateLikeFieldIds.value.has(calendarDraft.dateFieldId) ? calendarDraft.dateFieldId : null,
        endDateFieldId: calendarDraft.endDateFieldId && validDateLikeFieldIds.value.has(calendarDraft.endDateFieldId) ? calendarDraft.endDateFieldId : null,
        titleFieldId: calendarDraft.titleFieldId && validFieldIds.value.has(calendarDraft.titleFieldId) ? calendarDraft.titleFieldId : null,
        defaultView: calendarDraft.defaultView,
        weekStartsOn: calendarDraft.weekStartsOn,
      }),
    })
  } else if (target.type === 'timeline') {
    emit('update-view', target.id, {
      ...commonPayload,
      config: preserveConditionalFormattingRules(target, {
        startFieldId: timelineDraft.startFieldId && validDateFieldIds.value.has(timelineDraft.startFieldId) ? timelineDraft.startFieldId : null,
        endFieldId: timelineDraft.endFieldId && validDateFieldIds.value.has(timelineDraft.endFieldId) ? timelineDraft.endFieldId : null,
        labelFieldId: timelineDraft.labelFieldId && validFieldIds.value.has(timelineDraft.labelFieldId) ? timelineDraft.labelFieldId : null,
        zoom: timelineDraft.zoom,
      }),
    })
  } else if (target.type === 'gantt') {
    emit('update-view', target.id, {
      ...commonPayload,
      config: preserveConditionalFormattingRules(target, {
        startFieldId: ganttDraft.startFieldId && validDateFieldIds.value.has(ganttDraft.startFieldId) ? ganttDraft.startFieldId : null,
        endFieldId: ganttDraft.endFieldId && validDateFieldIds.value.has(ganttDraft.endFieldId) ? ganttDraft.endFieldId : null,
        titleFieldId: ganttDraft.titleFieldId && validFieldIds.value.has(ganttDraft.titleFieldId) ? ganttDraft.titleFieldId : null,
        progressFieldId: ganttDraft.progressFieldId && numericFields.value.some((field) => field.id === ganttDraft.progressFieldId) ? ganttDraft.progressFieldId : null,
        groupFieldId: ganttDraft.groupFieldId && validGroupableFieldIds.value.has(ganttDraft.groupFieldId) ? ganttDraft.groupFieldId : null,
        zoom: ganttDraft.zoom,
      }),
    })
  } else if (target.type === 'kanban') {
    const groupFieldId = kanbanDraft.groupFieldId && validSelectFieldIds.value.has(kanbanDraft.groupFieldId)
      ? kanbanDraft.groupFieldId
      : null
    const cardFieldIds = kanbanDraft.cardFieldIds.filter((fieldId) => validFieldIds.value.has(fieldId))
    emit('update-view', target.id, {
      ...commonPayload,
      config: preserveConditionalFormattingRules(target, {
        groupFieldId,
        cardFieldIds,
      }),
      groupInfo: groupFieldId ? { fieldId: groupFieldId } : {},
    })
  } else if (target.type === 'hierarchy') {
    const defaultExpandDepth = Math.max(0, Math.min(8, Math.round(Number(hierarchyDraft.defaultExpandDepth) || 0)))
    emit('update-view', target.id, {
      ...commonPayload,
      config: preserveConditionalFormattingRules(target, {
        parentFieldId: hierarchyDraft.parentFieldId && validLinkFieldIds.value.has(hierarchyDraft.parentFieldId) ? hierarchyDraft.parentFieldId : null,
        titleFieldId: hierarchyDraft.titleFieldId && validFieldIds.value.has(hierarchyDraft.titleFieldId) ? hierarchyDraft.titleFieldId : null,
        defaultExpandDepth,
        orphanMode: hierarchyDraft.orphanMode === 'hidden' ? 'hidden' : 'root',
      }),
    })
  } else {
    emit('update-view', target.id, commonPayload)
  }

  closeConfig()
}

const viewConfigDirty = computed(() => {
  if (!configTarget.value) return false
  return serializeViewDraft(configTarget.value.type) !== viewConfigBaseline.value
})

const newViewDraftDirty = computed(() => newViewName.value.trim().length > 0 || newViewType.value !== 'grid')

const renameDirty = computed(() => {
  if (!editingId.value) return false
  return editingName.value.trim() !== (props.views.find((view) => view.id === editingId.value)?.name ?? '')
})

const hasPendingDrafts = computed(() => viewConfigDirty.value || newViewDraftDirty.value || renameDirty.value || conditionalFormattingDirty.value)
const managerDirty = computed(() => props.visible && hasPendingDrafts.value)

function confirmDiscardViewManagerChanges() {
  if (!hasPendingDrafts.value) return true
  return window.confirm('Discard unsaved view manager changes?')
}

function reloadLatestConfig() {
  if (configTarget.value) hydrateExistingViewConfig(configTarget.value)
}

function openConditionalFormatting(view: MetaView) {
  if (conditionalFormattingTargetId.value && conditionalFormattingTargetId.value !== view.id) {
    if (conditionalFormattingDirty.value && !window.confirm('Discard unsaved formatting rules?')) return
  }
  conditionalFormattingTargetId.value = view.id
}

function closeConditionalFormatting() {
  conditionalFormattingTargetId.value = null
  conditionalFormattingDirty.value = false
}

function onSaveConditionalFormatting(rules: ConditionalFormattingRule[]) {
  const target = conditionalFormattingTargetView.value
  if (!target) return
  const nextConfig: Record<string, unknown> = { ...(target.config ?? {}) }
  nextConfig.conditionalFormattingRules = rules
  emit('update-view', target.id, { config: nextConfig })
  closeConditionalFormatting()
}

watch(
  () => props.visible,
  (visible) => {
    if (!visible) resetTransientState()
  },
)

watch(
  [() => props.views, () => configTargetId.value, () => deleteTargetId.value, () => editingId.value],
  () => {
    if (configTargetId.value && !configTarget.value) {
      closeConfig()
    } else if (configTarget.value) {
      const latestSignature = serializeViewSourceSignature(configTarget.value)
      if (latestSignature !== viewConfigSourceSignature.value) {
        if (viewConfigDirty.value) {
          viewConfigOutdated.value = true
          viewConfigLiveRefreshText.value = ''
        } else {
          hydrateExistingViewConfig(configTarget.value, {
            liveRefreshText: 'Latest view metadata loaded from the sheet context.',
          })
        }
      }
    }
    if (deleteTargetId.value && !deleteTarget.value) deleteTargetId.value = null
    if (editingId.value && !props.views.some((view) => view.id === editingId.value)) cancelRename()
  },
)

watch(
  () => props.fields,
  () => {
    if (!configTarget.value) return
    const latestSignature = serializeViewSourceSignature(configTarget.value)
    if (latestSignature === viewConfigSourceSignature.value) return
    if (viewConfigDirty.value) {
      viewConfigOutdated.value = true
      viewConfigLiveRefreshText.value = ''
    } else {
      hydrateExistingViewConfig(configTarget.value, {
        liveRefreshText: 'Latest field metadata loaded from the sheet context.',
      })
    }
  },
)

watch(
  viewConfigDirty,
  (dirty) => {
    if (dirty) viewConfigLiveRefreshText.value = ''
  },
)

watch(
  managerDirty,
  (dirty) => {
    emit('update:dirty', dirty)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  emit('update:dirty', false)
})
</script>

<style scoped>
.meta-view-mgr__overlay { position: fixed; inset: 0; background: rgba(0,0,0,.3); z-index: 100; display: flex; align-items: center; justify-content: center; }
.meta-view-mgr { width: 620px; max-height: 80vh; background: #fff; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.15); display: flex; flex-direction: column; }
.meta-view-mgr__header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid #eee; }
.meta-view-mgr__title { font-size: 15px; font-weight: 600; margin: 0; }
.meta-view-mgr__close { border: none; background: none; font-size: 20px; cursor: pointer; color: #999; }
.meta-view-mgr__body { flex: 1; overflow-y: auto; padding: 8px 16px; }
.meta-view-mgr__row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid #f5f5f5; }
.meta-view-mgr__row--active { background: #f0f7ff; border-radius: 4px; margin: 0 -4px; padding: 6px 4px; }
.meta-view-mgr__icon { width: 24px; text-align: center; color: #999; font-size: 13px; }
.meta-view-mgr__name { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-view-mgr__type { font-size: 11px; color: #999; background: #f5f5f5; padding: 1px 6px; border-radius: 3px; }
.meta-view-mgr__rename { flex: 1; padding: 2px 6px; border: 1px solid #409eff; border-radius: 3px; font-size: 13px; }
.meta-view-mgr__action { border: none; background: none; color: #999; cursor: pointer; font-size: 13px; padding: 2px 4px; }
.meta-view-mgr__action:hover { color: #333; }
.meta-view-mgr__action:disabled { opacity: 0.3; cursor: not-allowed; }
.meta-view-mgr__action--ok { color: #67c23a; }
.meta-view-mgr__action--danger:hover { color: #f56c6c; }
.meta-view-mgr__empty { text-align: center; padding: 20px; color: #999; font-size: 13px; }
.meta-view-mgr__config { padding: 14px 16px; border-top: 1px solid #eee; background: #fbfdff; display: flex; flex-direction: column; gap: 12px; }
.meta-view-mgr__config-header { display: flex; justify-content: space-between; align-items: center; font-size: 13px; color: #666; }
.meta-view-mgr__config-note { font-size: 12px; color: #999; }
.meta-view-mgr__warning { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 10px; border: 1px solid #f3d19e; border-radius: 6px; background: #fff7e6; color: #8a5a00; font-size: 12px; }
.meta-view-mgr__refresh { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 10px; border: 1px solid #bfd6ff; border-radius: 6px; background: #eef5ff; color: #1d4ed8; font-size: 12px; }
.meta-view-mgr__field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #666; }
.meta-view-mgr__common { display: flex; flex-direction: column; gap: 12px; padding: 12px; border: 1px solid #e2e8f0; border-radius: 8px; background: #fff; }
.meta-view-mgr__common-header { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: #64748b; }
.meta-view-mgr__common-header strong { color: #334155; }
.meta-view-mgr__subheader { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.meta-view-mgr__rules { display: flex; flex-direction: column; gap: 6px; }
.meta-view-mgr__rule-row { display: grid; grid-template-columns: 1fr 120px auto; gap: 8px; align-items: center; }
.meta-view-mgr__rule-row--filter { grid-template-columns: 1fr 130px minmax(80px, 1fr) auto; }
.meta-view-mgr__rule-empty { padding: 5px 10px; border: 1px dashed #cbd5e1; border-radius: 4px; color: #94a3b8; background: #f8fafc; }
.meta-view-mgr__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.meta-view-mgr__checks { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 12px; max-height: 180px; overflow: auto; padding: 8px; border: 1px solid #e5e7eb; border-radius: 6px; background: #fff; }
.meta-view-mgr__check { display: flex; gap: 8px; align-items: center; font-size: 12px; color: #444; }
.meta-view-mgr__add-section { padding: 10px 16px; border-top: 1px solid #eee; }
.meta-view-mgr__add-row { display: flex; gap: 8px; }
.meta-view-mgr__input, .meta-view-mgr__select { width: 100%; padding: 5px 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; background: #fff; }
.meta-view-mgr__select--compact { width: auto; min-width: 130px; }
.meta-view-mgr__btn-add { padding: 5px 14px; background: #409eff; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
.meta-view-mgr__btn-add:disabled { opacity: 0.4; cursor: not-allowed; }
.meta-view-mgr__btn-add:hover:not(:disabled) { background: #66b1ff; }
.meta-view-mgr__btn-inline { align-self: flex-start; padding: 4px 10px; border: 1px dashed #cbd5e1; border-radius: 4px; background: #fff; color: #475569; cursor: pointer; font-size: 12px; }
.meta-view-mgr__confirm { padding: 12px 16px; border-top: 1px solid #eee; background: #fef0f0; }
.meta-view-mgr__confirm p { margin: 0 0 8px; font-size: 13px; color: #333; }
.meta-view-mgr__confirm-actions, .meta-view-mgr__config-actions { display: flex; gap: 8px; justify-content: flex-end; }
.meta-view-mgr__btn-cancel { padding: 4px 12px; border: 1px solid #ddd; border-radius: 3px; background: #fff; cursor: pointer; font-size: 12px; }
.meta-view-mgr__btn-delete { padding: 4px 12px; background: #f56c6c; color: #fff; border: none; border-radius: 3px; cursor: pointer; font-size: 12px; }
</style>
