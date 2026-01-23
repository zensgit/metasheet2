<template>
  <div class="univer-kanban">
    <div class="univer-kanban__header">
      <div>
        <h2 class="univer-kanban__title">Univer + Kanban (POC)</h2>
        <div class="univer-kanban__subtitle">单一数据源，多视图同步（Phase 0.D）</div>
      </div>
      <div class="univer-kanban__meta">
        <div>viewId: {{ viewId }}</div>
        <div v-if="activeSheetId && activeSheetId !== viewId" class="univer-kanban__sheet-id">
          sheetId: {{ activeSheetId }}
        </div>
        <label v-if="sourceIsMeta" class="univer-kanban__view-picker" for="univer-kanban-view-select">
          <span>视图</span>
          <select
            id="univer-kanban-view-select"
            name="selectedViewId"
            v-model="selectedViewId"
            class="univer-kanban__select"
            @change="handleViewChange"
          >
            <option value="">(当前 Sheet)</option>
            <option v-for="view in availableViews" :key="view.id" :value="view.id">
              {{ view.name || view.id }} ({{ view.type }})
            </option>
          </select>
        </label>
        <div v-if="viewSummary" class="univer-kanban__view-summary">
          <span class="univer-kanban__view-chip">view: {{ viewSummary.name }} ({{ viewSummary.type }})</span>
          <span class="univer-kanban__view-chip">id: {{ viewSummary.id }}</span>
          <span v-if="viewSummary.groupLabel" class="univer-kanban__view-chip">group: {{ viewSummary.groupLabel }}</span>
          <span v-if="viewSummary.sortLabel" class="univer-kanban__view-chip">sort: {{ viewSummary.sortLabel }}</span>
          <span v-if="viewSummary.filterLabel" class="univer-kanban__view-chip">filter: {{ viewSummary.filterLabel }}</span>
          <span v-if="viewSummary.hiddenCount > 0" class="univer-kanban__view-chip">hidden: {{ viewSummary.hiddenCount }}</span>
          <span
            v-if="viewSummary.computedFilterSort"
            class="univer-kanban__view-chip univer-kanban__view-chip--warn"
          >
            computed filter/sort
          </span>
        </div>
        <div v-if="diagnosticsItems.length" class="univer-kanban__diagnostics">
          <span class="univer-kanban__diagnostics-label">诊断</span>
          <span
            v-for="item in diagnosticsItems"
            :key="item.label"
            class="univer-kanban__diagnostics-chip"
            :title="item.ids.join(', ')"
          >
            {{ item.label }} ({{ item.ids.length }})
          </span>
        </div>
        <div v-if="page">loaded: {{ loadedCount }}/{{ page.total }}</div>
        <button
          v-if="page && page.hasMore"
          type="button"
          class="univer-kanban__btn"
          :disabled="loadingMore"
          @click="loadMore"
        >
          {{ loadingMore ? '加载中...' : '加载更多' }}
        </button>
        <button type="button" class="univer-kanban__btn" @click="reload">重算</button>
        <div v-if="statusText" :class="statusKind === 'error' ? 'univer-kanban__status univer-kanban__status--error' : 'univer-kanban__status'">
          {{ statusText }}
        </div>
        <div v-if="statusHint && statusText.startsWith('Sheet not found:')" class="univer-kanban__status-hint">
          {{ statusHint }}
        </div>
        <div v-if="viewWarnings.length" class="univer-kanban__warning">
          <div v-for="(warning, idx) in viewWarnings" :key="idx">
            {{ warning }}
          </div>
        </div>
        <div v-if="relatedUpdateCount > 0" class="univer-kanban__related">
          <span>外表更新 {{ relatedUpdateCount }} 条</span>
          <button type="button" class="univer-kanban__btn" @click="reload">点击刷新</button>
          <span v-if="relatedUpdateSheets.length" class="univer-kanban__related-note">
            来源: {{ relatedUpdateSheets.join(', ') }}
          </span>
        </div>
        <div v-if="demoHint" class="univer-kanban__hint">
          <span>{{ demoHint.text }}</span>
          <a :href="demoHint.href" class="univer-kanban__hint-link">打开可编辑示例表</a>
          <span class="univer-kanban__hint-note">{{ demoHint.note }}</span>
        </div>
        <div v-if="readonlyFields.length" class="univer-kanban__readonly">
          <span class="univer-kanban__readonly-label">只读字段</span>
          <button
            v-for="item in readonlyFields"
            :key="item.id"
            type="button"
            class="univer-kanban__readonly-item"
            :title="item.reason"
            @click="focusReadonlyField(item.id)"
          >
            <span class="univer-kanban__readonly-name">{{ item.label }}</span>
            <span class="univer-kanban__readonly-tag">{{ item.tag }}</span>
          </button>
        </div>
        <details v-if="sourceIsMeta && fieldVisibilityOptions.length" class="univer-kanban__visibility">
          <summary class="univer-kanban__visibility-summary">
            字段可见性
            <span v-if="hiddenFieldIds.length" class="univer-kanban__visibility-count">
              hidden {{ hiddenFieldIds.length }}
            </span>
          </summary>
          <div class="univer-kanban__visibility-list">
            <label
              v-for="field in fieldVisibilityOptions"
              :key="field.id"
              class="univer-kanban__visibility-item"
              :for="`univer-kanban-field-visible-${field.id}`"
            >
              <input
                type="checkbox"
                :id="`univer-kanban-field-visible-${field.id}`"
                :name="`fieldVisible-${field.id}`"
                :checked="!isFieldHidden(field.id)"
                :disabled="viewConfigSaving"
                @change="toggleFieldVisibility(field.id, $event)"
              />
              <span class="univer-kanban__visibility-name">{{ field.name }}</span>
              <span class="univer-kanban__visibility-type">{{ field.type }}</span>
            </label>
          </div>
          <div v-if="viewConfigStatus" class="univer-kanban__visibility-status">{{ viewConfigStatus }}</div>
        </details>
        <button
          v-if="hasConflict"
          type="button"
          class="univer-kanban__btn univer-kanban__btn--danger"
          @click="reload"
        >
          重新加载
        </button>
        <button type="button" class="univer-kanban__btn" @click="createRecord">+ 新记录</button>
      </div>
    </div>

    <div class="univer-kanban__body" :class="{ 'univer-kanban__body--with-comments': commentsEnabled }">
      <div ref="gridWrapperRef" class="univer-kanban__grid">
        <div ref="gridMountRef" class="univer-kanban__grid-mount" />

        <div v-if="readonlyHeaderIcons.length" class="univer-kanban__header-icons">
          <div
            v-for="icon in readonlyHeaderIcons"
            :key="icon.fieldId"
            class="univer-kanban__header-icon"
            :style="{ left: `${icon.left}px`, top: `${icon.top}px` }"
            :title="icon.title"
            :data-readonly-header-icon="icon.fieldId"
            tabindex="0"
            @mouseenter="showHeaderTooltip(icon)"
            @mouseleave="hideHeaderTooltip"
            @focus="showHeaderTooltip(icon)"
            @blur="hideHeaderTooltip"
          >
            RO
          </div>
          <div
            v-if="headerTooltip"
            class="univer-kanban__header-tooltip"
            :style="{ left: `${headerTooltip.left}px`, top: `${headerTooltip.top}px` }"
          >
            {{ headerTooltip.text }}
          </div>
        </div>

        <div
          v-if="overlay?.kind === 'select'"
          class="univer-kanban__overlay"
          :style="{ left: `${overlay.left}px`, top: `${overlay.top}px` }"
          @mousedown.stop
        >
          <div v-if="overlay.options.length === 0" class="univer-kanban__overlay-empty">No options</div>
          <button
            v-for="opt in overlay.options"
            :key="opt.value"
            type="button"
            class="univer-kanban__pill"
            :style="{ background: opt.color || resolveFallbackSelectColor(opt.value) || '#1677ff' }"
            @click="applySelect(opt.value, opt.color)"
          >
            {{ opt.value }}
          </button>
        </div>

        <div
          v-if="overlay?.kind === 'link'"
          class="univer-kanban__overlay"
          :style="{ left: `${overlay.left}px`, top: `${overlay.top}px` }"
          @mousedown.stop
        >
          <LinkPicker
            v-model="linkDraft"
            :foreign-sheet-id="overlay.foreignSheetId"
            :display-field-id="overlay.displayFieldId"
            :multiple="overlay.multiple"
            :api-prefix="getApiPrefix()"
            placeholder="Select linked record..."
            @change="applyLink"
          />
          <div class="univer-kanban__link-actions">
            <button type="button" class="univer-kanban__btn" @click="overlay = null">Cancel</button>
          </div>
        </div>

        <div
          v-if="overlay?.kind === 'readonly'"
          class="univer-kanban__overlay univer-kanban__overlay--readonly"
          :style="{ left: `${overlay.left}px`, top: `${overlay.top}px` }"
        >
          {{ overlay.message }}
        </div>
      </div>

      <div class="univer-kanban__kanban">
        <div
          v-for="col in kanbanColumns"
          :key="col.id"
          class="univer-kanban__column"
          :data-kanban-column="col.id"
          @drop="handleDrop($event, col.id)"
          @dragover.prevent
          @dragenter.prevent
        >
          <div class="univer-kanban__column-header">
            <div class="univer-kanban__column-title">{{ col.title }}</div>
            <div class="univer-kanban__column-count">{{ col.cards.length }}</div>
          </div>

          <div class="univer-kanban__cards">
            <div
              v-for="card in col.cards"
              :key="card.id"
              class="univer-kanban__card"
              :data-kanban-card="card.id"
              draggable="true"
              @click="selectRecord(card.id)"
              @dragstart="handleDragStart($event, card.id, col.id)"
            >
              <div class="univer-kanban__card-header">
                <div class="univer-kanban__card-title">{{ card.title }}</div>
                <button
                  type="button"
                  class="univer-kanban__card-delete"
                  title="删除"
                  @mousedown.stop
                  @click.stop="deleteRecord(card.id)"
                >
                  ×
                </button>
              </div>
              <div class="univer-kanban__card-meta">
                <span class="univer-kanban__card-meta-text">{{ card.meta }}</span>
                <span
                  v-if="commentSummary[card.id]?.total"
                  class="univer-kanban__comment-badge"
                  :title="commentSummary[card.id].open > 0 ? `${commentSummary[card.id].open} 未解决 / ${commentSummary[card.id].total} 总计` : `${commentSummary[card.id].total} 评论`"
                >
                  {{ commentSummary[card.id].open > 0 ? `${commentSummary[card.id].open}/${commentSummary[card.id].total}` : commentSummary[card.id].total }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <CommentsPanel
        v-if="commentsEnabled"
        class="univer-kanban__comments"
        :spreadsheet-id="commentsSpreadsheetId"
        :record-id="selectedRecordId"
        :field-id="selectedFieldId"
        :field-label="selectedFieldLabel"
        @comment-updated="handleCommentUpdated"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { ICellData, IWorkbookData } from '@univerjs/core'
import { LocaleType } from '@univerjs/core'
import { defaultTheme } from '@univerjs/design'
import { createUniver } from '@univerjs/presets'
import type { FUniver } from '@univerjs/presets'
import { UniverSheetsCorePreset } from '@univerjs/presets/preset-sheets-core'
import { SetRangeValuesMutation, SetSelectionsOperation } from '@univerjs/sheets'

import '@univerjs/design/lib/index.css'
import '@univerjs/ui/lib/index.css'
import '@univerjs/sheets-ui/lib/index.css'

import { apiFetch, apiGet } from '../utils/api'
import { formatApiErrorMessage } from '../utils/apiErrors'
import { buildUniverSheetsLocalesMinimal } from '../utils/univerLocales'
import { createUniverEmbed } from '../utils/univerEmbed'
import { createUniverPatchQueue, type UniverPatchQueue } from '../utils/univerPatchQueue'
import {
  buildLinkCell,
  buildSelectCell,
  applyReadonlyStyle,
  extractValueFromCell,
  isFormulaValue,
  resolveFallbackSelectColor,
} from '../utils/univerValue'
import CommentsPanel from '../components/CommentsPanel.vue'
import LinkPicker, { type LinkChangePayload } from '../components/LinkPicker.vue'

type UniverMockField = {
  id: string
  name: string
  type: 'string' | 'number' | 'boolean' | 'formula' | 'select' | 'link' | 'lookup' | 'rollup'
  options?: Array<{ value: string; color?: string }>
  property?: {
    foreignDatasheetId?: string
    foreignSheetId?: string
    limitSingleRecord?: boolean
    displayFieldId?: string
    readonly?: boolean
    relatedLinkFieldId?: string
    lookUpTargetFieldId?: string
    linkedFieldId?: string
    targetFieldId?: string
    aggregation?: string
    [key: string]: unknown
  }
}

type UniverMockRecord = {
  id: string
  version: number
  data: Record<string, unknown>
}

type RelatedRecord = {
  sheetId: string
  recordId: string
  data: Record<string, unknown>
}

type UniverMockViewConfig = {
  id: string
  sheetId: string
  name: string
  type: string
  filterInfo?: Record<string, unknown>
  sortInfo?: Record<string, unknown>
  groupInfo?: Record<string, unknown>
  hiddenFieldIds?: string[]
}

type UniverMockView = {
  id: string
  fields: UniverMockField[]
  rows: UniverMockRecord[]
  view?: UniverMockViewConfig
  meta?: {
    warnings?: string[]
    computedFilterSort?: boolean
    ignoredSortFieldIds?: string[]
    ignoredFilterFieldIds?: string[]
    ignoredHiddenFieldIds?: string[]
    ignoredGroupFieldIds?: string[]
  }
  page?: {
    offset: number
    limit: number
    total: number
    hasMore: boolean
  }
}

type UniverMockViewResponse = {
  ok: boolean
  data?: UniverMockView
  error?: { code: string; message: string }
}

type UniverMockPatchResponse = {
  ok: boolean
  data?: { updated: Array<{ recordId: string; version: number }> }
  error?: { code: string; message: string; serverVersion?: number }
}

type ViewSummary = {
  id: string
  name: string
  type: string
  groupLabel: string | null
  sortLabel: string | null
  filterLabel: string | null
  hiddenCount: number
  computedFilterSort: boolean
}

type DiagnosticsItem = {
  label: string
  ids: string[]
}

type UniverMockCreateRecordResponse = {
  ok: boolean
  data?: { record: { id: string; version: number; data: Record<string, unknown> } }
  error?: { code: string; message: string }
}

type UniverMockDeleteRecordResponse = {
  ok: boolean
  data?: { deleted: string }
  error?: { code: string; message: string; serverVersion?: number }
}

type OverlayState =
  | {
      kind: 'select'
      row: number
      col: number
      left: number
      top: number
      fieldId: string
      options: Array<{ value: string; color?: string }>
    }
  | {
      kind: 'link'
      row: number
      col: number
      left: number
      top: number
      fieldId: string
      foreignSheetId: string
      displayFieldId?: string
      multiple: boolean
    }
  | {
      kind: 'readonly'
      row: number
      col: number
      left: number
      top: number
      message: string
    }

type ReadonlyFieldEntry = {
  id: string
  label: string
  reason: string
  tag: string
}

type ReadonlyHeaderIcon = {
  fieldId: string
  left: number
  top: number
  title: string
}

type ReadonlyHeaderTooltip = {
  text: string
  left: number
  top: number
}

type ReadonlyHitKind = 'select' | 'list' | 'edit'

type ReadonlyMetrics = {
  total: number
  byField: Record<string, number>
  byKind: Record<string, number>
  lastFieldId: string | null
  lastReason: string | null
  lastKind: ReadonlyHitKind | null
}

const route = useRoute()
const router = useRouter()
const EDITABLE_DEMO_ID = 'editable_demo'

const demoHint = computed(() => {
  const source = toStr(route.query.source)?.toLowerCase()
  const sheetId = toStr(route.query.sheetId)
  if (source !== 'meta' || sheetId !== 'lookup_source_demo') return null
  return {
    text: '此表包含 lookup/rollup/只读字段，仅用于验证。',
    href: `/univer-kanban?source=meta&sheetId=${EDITABLE_DEMO_ID}`,
    note: '如需可编辑示例，运行 scripts/setup-editable-demo.sh',
  }
})

const DEFAULT_SOURCE = 'meta'
const DEFAULT_SHEET_ID = 'univer_demo_meta'

const gridWrapperRef = ref<HTMLDivElement | null>(null)
const gridMountRef = ref<HTMLDivElement | null>(null)

const viewId = ref<string>('univer_demo_view')
const activeSheetId = ref<string>('')
const statusText = ref<string>('')
const statusKind = ref<'ok' | 'error'>('ok')
const statusHint = ref<string>('')
const viewWarnings = ref<string[]>([])
const viewSummary = ref<ViewSummary | null>(null)
const hiddenFieldIds = ref<string[]>([])
const stableHiddenFieldIds = ref<string[]>([])
const viewConfigId = ref<string>('')
const viewFields = ref<UniverMockField[]>([])
const viewConfigStatus = ref<string>('')
const viewConfigSaving = ref<boolean>(false)
const availableViews = ref<Array<{ id: string; name: string; type: string }>>([])
const selectedViewId = ref<string>('')
const diagnosticsItems = ref<DiagnosticsItem[]>([])
const hasConflict = ref<boolean>(false)
const conflictServerVersion = ref<number | null>(null)
const page = ref<UniverMockView['page'] | null>(null)
const loadedCount = ref<number>(0)
const baseOffset = ref<number>(0)
const loadingMore = ref<boolean>(false)
const readonlyFields = ref<ReadonlyFieldEntry[]>([])
const readonlyHeaderIcons = ref<ReadonlyHeaderIcon[]>([])
const headerTooltip = ref<ReadonlyHeaderTooltip | null>(null)
const readonlyMetrics = ref<ReadonlyMetrics>({
  total: 0,
  byField: {},
  byKind: {},
  lastFieldId: null,
  lastReason: null,
  lastKind: null,
})
const relatedUpdates = ref<RelatedRecord[]>([])
const relatedUpdateCount = computed(() => relatedUpdates.value.length)
const relatedUpdateSheets = computed(() =>
  Array.from(new Set(relatedUpdates.value.map((record) => record.sheetId))).filter((id) => id.length > 0),
)
const commentsEnabled = computed(() => toStr(route.query.source)?.toLowerCase() === 'meta')
const commentsSpreadsheetId = computed(() => (commentsEnabled.value ? viewId.value : ''))
const selectedRecordId = ref<string>('')
const selectedFieldId = ref<string | undefined>(undefined)
const selectedFieldLabel = computed(() => {
  const fieldId = selectedFieldId.value
  if (!fieldId) return ''
  return mapping.fieldIdToLabel[fieldId] ?? fieldId
})
const commentSummary = ref<Record<string, { total: number; open: number }>>({})
let commentSummaryTimer = 0

const overlay = ref<OverlayState | null>(null)
const linkDraft = ref<string[]>([])

const recordsById = ref<Record<string, UniverMockRecord>>({})
const titleFieldId = ref<string>('name')
const priorityFieldId = ref<string>('priority')
const relatedFieldId = ref<string>('related')

const dragState = ref<{ recordId: string; from: string } | null>(null)

let univerAPI: FUniver | null = null
let univerDispose: (() => void) | null = null
let patchQueue: UniverPatchQueue | null = null
let startLoad: (() => Promise<void>) | null = null
let sheetRowCount = 0
let suppressChanges = false
let headerIconRaf = 0
let headerIconCleanup: (() => void) | null = null
let viewConfigTimer = 0

const mapping = {
  rowIndexToRecordId: [] as string[],
  colIndexToFieldId: [] as string[],
  recordIdToVersion: {} as Record<string, number>,
  recordIdToRowIndex: {} as Record<string, number>,
  recordIdToData: {} as Record<string, Record<string, unknown>>,
  fieldIdToColIndex: {} as Record<string, number>,
  fieldIdToType: {} as Record<string, UniverMockField['type']>,
  fieldIdToSelectOptions: {} as Record<string, Array<{ value: string; color?: string }>>,
  fieldIdToProperty: {} as Record<string, UniverMockField['property']>,
  fieldIdToReadonlyReason: {} as Record<string, string>,
  fieldIdToLabel: {} as Record<string, string>,
}

function toStr(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function normalizeQueryRecord(
  query: Record<string, unknown>
): Record<string, string | string[] | undefined> {
  const normalized: Record<string, string | string[] | undefined> = {}
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string') {
      normalized[key] = value
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      normalized[key] = String(value)
    } else if (Array.isArray(value)) {
      const items = value.filter((item) => typeof item === 'string') as string[]
      if (items.length > 0) normalized[key] = items
    }
  }
  return normalized
}

async function resolveInitialSheetId(): Promise<string | null> {
  try {
    const res = await apiFetch('/api/univer-meta/sheets')
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      data?: { sheets?: Array<{ id?: string; name?: string }> }
    }
    if (res.ok && json.ok && Array.isArray(json.data?.sheets) && json.data!.sheets!.length > 0) {
      const first = json.data!.sheets!.find((s) => typeof s.id === 'string' && s.id.trim().length > 0)
      if (first?.id) return first.id
    }
  } catch {
    // ignore and fallback
  }

  try {
    const res = await apiFetch('/api/univer-meta/sheets', {
      method: 'POST',
      body: JSON.stringify({ name: '默认表', description: '自动创建的默认表' }),
    })
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      data?: { sheet?: { id?: string } }
    }
    if (res.ok && json.ok && json.data?.sheet?.id) {
      return json.data.sheet.id
    }
  } catch {
    // ignore and fallback
  }

  return DEFAULT_SHEET_ID
}

async function ensureMetaQueryDefaults(): Promise<void> {
  const nextQuery = normalizeQueryRecord(route.query as Record<string, unknown>)
  const source = toStr(nextQuery.source)?.toLowerCase()
  let changed = false

  if (!source) {
    nextQuery.source = DEFAULT_SOURCE
    changed = true
  }

  const effectiveSource = (toStr(nextQuery.source) || DEFAULT_SOURCE).toLowerCase()
  if (effectiveSource === 'meta') {
    const sheetId = toStr(nextQuery.sheetId)
    const viewId = toStr(nextQuery.viewId)
    if (!sheetId && !viewId) {
      const resolved = await resolveInitialSheetId()
      if (resolved) {
        nextQuery.sheetId = resolved
        changed = true
      }
    }
  }

  if (changed) {
    await router.replace({ query: nextQuery }).catch(() => null)
  }
}

function queueCommentSummaryRefresh(rowIds?: string[]) {
  if (commentSummaryTimer) window.clearTimeout(commentSummaryTimer)
  commentSummaryTimer = window.setTimeout(() => {
    commentSummaryTimer = 0
    fetchCommentSummary(rowIds).catch((err) => {
      console.error('[UniverKanbanPOC] load comment summary failed:', err)
    })
  }, 200)
}

async function fetchCommentSummary(rowIds?: string[]) {
  if (!commentsEnabled.value || !commentsSpreadsheetId.value) {
    commentSummary.value = {}
    return
  }

  const ids = rowIds && rowIds.length > 0 ? rowIds : Object.keys(recordsById.value)
  if (ids.length === 0) {
    commentSummary.value = {}
    return
  }

  const qs = new URLSearchParams({
    spreadsheetId: commentsSpreadsheetId.value,
    rowIds: ids.join(','),
  })

  const res = await apiFetch(`/api/comments/summary?${qs.toString()}`)
  const json = await res.json().catch(() => ({}))
  if (!res.ok || !json.ok) {
    throw new Error(json.error?.message || 'Failed to load comment summary')
  }

  const next = { ...commentSummary.value }
  for (const rowId of ids) {
    next[rowId] = { total: 0, open: 0 }
  }

  const items = Array.isArray(json.data?.items) ? json.data.items : []
  for (const item of items) {
    const rowId = String(item.rowId)
    next[rowId] = {
      total: Number(item.total ?? 0),
      open: Number(item.open ?? 0),
    }
  }

  commentSummary.value = next
}

const DEFAULT_WINDOW = {
  size: 200,
  buffer: 100,
  max: 1000,
}

function toPositiveInt(value: string | undefined, fallback: number, min = 1): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  if (parsed < min) return fallback
  return parsed
}

function resolveWindowing() {
  const flag = toStr(route.query.window)?.toLowerCase()
  const enabled = flag === '1' || flag === 'true' || flag === 'on'
  const size = toPositiveInt(toStr(route.query.windowSize), DEFAULT_WINDOW.size, 1)
  const buffer = toPositiveInt(toStr(route.query.windowBuffer), DEFAULT_WINDOW.buffer, 0)
  const maxRaw = toPositiveInt(toStr(route.query.windowMax), DEFAULT_WINDOW.max, 1)
  const max = Math.max(size, maxRaw)
  return { enabled, size, buffer, max }
}

function resolveWindowRowCount(total: number | undefined, loaded: number, windowing: { enabled: boolean; max: number }) {
  if (!windowing.enabled) return Math.max(loaded, 50)
  const safeTotal = typeof total === 'number' && Number.isFinite(total) ? total : loaded
  const cap = Math.min(windowing.max, safeTotal)
  return Math.max(loaded, 50, cap)
}

function buildMissingSheetHint(error: unknown): { title: string; hint: string } | null {
  const message = error instanceof Error ? error.message : String(error)
  if (!message.includes('404')) return null
  const source = toStr(route.query.source)?.toLowerCase()
  const sheetId = toStr(route.query.sheetId)
  if (source !== 'meta' || !sheetId) return null
  return {
    title: `Sheet not found: ${sheetId}`,
    hint: 'Run: scripts/setup-lookup-rollup-demo.sh then reload.',
  }
}

function getApiPrefix(): string {
  const source = toStr(route.query.source)?.toLowerCase()
  return source === 'meta' ? '/api/univer-meta' : '/api/univer-mock'
}

const sourceIsMeta = computed(() => toStr(route.query.source)?.toLowerCase() === 'meta')

type UniverMetaViewsResponse = {
  ok: boolean
  data?: { views: Array<{ id: string; name: string; type: string }> }
  error?: { code: string; message: string }
}

async function loadAvailableViews(sheetId: string) {
  if (!sheetId) return
  try {
    const res = await apiFetch(`/api/univer-meta/views?sheetId=${encodeURIComponent(sheetId)}`)
    const json = (await res.json().catch(() => ({}))) as UniverMetaViewsResponse
    if (!res.ok || !json.ok || !json.data) return
    availableViews.value = json.data.views ?? []
  } catch {
    availableViews.value = []
  }
}

function handleViewChange() {
  const nextViewId = selectedViewId.value
  const query = normalizeQueryRecord(route.query as Record<string, unknown>)
  if (nextViewId) {
    query.viewId = nextViewId
    delete query.sheetId
  } else {
    delete query.viewId
  }
  router.replace({ query }).catch(() => null)
  reload()
}

function resolveFieldId(fields: UniverMockField[], opts: { preferId: string; type: UniverMockField['type']; nameRe: RegExp }): string {
  const byId = fields.find(f => f.id === opts.preferId)
  if (byId) return byId.id

  const byTypeName = fields.find(f => f.type === opts.type && opts.nameRe.test(f.name))
  if (byTypeName) return byTypeName.id

  const byType = fields.find(f => f.type === opts.type)
  if (byType) return byType.id

  return fields[0]?.id ?? opts.preferId
}

function getQueryString(): string {
  const qs = new URLSearchParams()
  const rows = toStr(route.query.rows)
  const cols = toStr(route.query.cols)
  const queryViewId = toStr(route.query.viewId)
  const mode = toStr(route.query.mode)
  const refresh = toStr(route.query.refresh)
  const source = toStr(route.query.source)?.toLowerCase()
  const sheetId = toStr(route.query.sheetId)
  const seed = toStr(route.query.seed)
  const limit = toStr(route.query.limit)
  const offset = toStr(route.query.offset)
  const windowing = resolveWindowing()
  const resolvedLimit = source === 'meta' ? (limit || (windowing.enabled ? String(windowing.size) : '50')) : limit
  const resolvedOffset = source === 'meta' ? (offset || '0') : offset

  if (rows) qs.set('rows', rows)
  if (cols) qs.set('cols', cols)
  if (queryViewId) qs.set('viewId', queryViewId)
  if (mode) qs.set('mode', mode)
  if (refresh) qs.set('refresh', refresh)
  if (source === 'meta') {
    if (sheetId) qs.set('sheetId', sheetId)
    if (seed) qs.set('seed', seed)
    qs.set('limit', resolvedLimit ?? '50')
    qs.set('offset', resolvedOffset ?? '0')
  }

  const text = qs.toString()
  return text ? `?${text}` : ''
}

function resolveFieldLabel(fields: UniverMockField[], fieldId: string): string {
  const field = fields.find((f) => f.id === fieldId)
  return field?.name?.trim() || fieldId
}

function isFilterValueDisabled(operator: string): boolean {
  const op = operator.trim().toLowerCase()
  return op === 'isempty' || op === 'isnotempty'
}

function formatFilterValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((v) => toStr(v))
      .filter((v): v is string => Boolean(v))
      .join(', ')
  }
  return toStr(value) ?? ''
}

function buildViewSummary(view: UniverMockView): ViewSummary | null {
  const cfg = view.view
  if (!cfg) return null

  const name = typeof cfg.name === 'string' && cfg.name.trim().length > 0 ? cfg.name.trim() : '未命名视图'
  const id = typeof cfg.id === 'string' && cfg.id.trim().length > 0 ? cfg.id.trim() : view.id
  const type = typeof cfg.type === 'string' && cfg.type.trim().length > 0 ? cfg.type.trim() : 'grid'
  const hiddenCount = Array.isArray(cfg.hiddenFieldIds)
    ? cfg.hiddenFieldIds.filter((v) => typeof v === 'string' && v.trim().length > 0).length
    : 0

  const summary: ViewSummary = {
    id,
    name,
    type,
    groupLabel: null,
    sortLabel: null,
    filterLabel: null,
    hiddenCount,
    computedFilterSort: view.meta?.computedFilterSort === true,
  }

  const groupId =
    cfg.groupInfo && typeof cfg.groupInfo === 'object' && !Array.isArray(cfg.groupInfo)
      ? (cfg.groupInfo as Record<string, unknown>).fieldId
      : undefined
  if (typeof groupId === 'string' && groupId.trim().length > 0) {
    summary.groupLabel = resolveFieldLabel(view.fields, groupId.trim())
  }

  const rules =
    cfg.sortInfo && typeof cfg.sortInfo === 'object' && !Array.isArray(cfg.sortInfo)
      ? (cfg.sortInfo as Record<string, unknown>).rules
      : undefined
  if (Array.isArray(rules) && rules.length > 0) {
    const rule = rules[0] as Record<string, unknown>
    const fieldId = typeof rule.fieldId === 'string' ? rule.fieldId.trim() : ''
    if (fieldId) {
      const dir = rule.desc === true ? '↓' : '↑'
      summary.sortLabel = `${resolveFieldLabel(view.fields, fieldId)} ${dir}`
    }
  }

  const conditions =
    cfg.filterInfo && typeof cfg.filterInfo === 'object' && !Array.isArray(cfg.filterInfo)
      ? (cfg.filterInfo as Record<string, unknown>).conditions
      : undefined
  if (Array.isArray(conditions) && conditions.length > 0) {
    const cond = conditions[0] as Record<string, unknown>
    const fieldId = typeof cond.fieldId === 'string' ? cond.fieldId.trim() : ''
    const operator = typeof cond.operator === 'string' ? cond.operator.trim() : ''
    if (fieldId && operator) {
      const label = resolveFieldLabel(view.fields, fieldId)
      if (isFilterValueDisabled(operator)) {
        summary.filterLabel = `${label} ${operator}`
      } else {
        const value = formatFilterValue(cond.value)
        summary.filterLabel = value ? `${label} ${operator} ${value}` : `${label} ${operator}`
      }
    }
  }

  return summary
}

function buildDiagnostics(view: UniverMockView): DiagnosticsItem[] {
  const meta = view.meta
  if (!meta) return []
  const items: DiagnosticsItem[] = []
  const add = (label: string, ids?: string[]) => {
    if (!ids || ids.length === 0) return
    items.push({ label, ids })
  }
  add('sort', meta.ignoredSortFieldIds)
  add('filter', meta.ignoredFilterFieldIds)
  add('hidden', meta.ignoredHiddenFieldIds)
  add('group', meta.ignoredGroupFieldIds)
  return items
}

type FieldVisibilityOption = {
  id: string
  name: string
  type: string
}

const fieldVisibilityOptions = computed<FieldVisibilityOption[]>(() => {
  if (!sourceIsMeta.value) return []
  const fields = viewFields.value
  if (!fields.length) return []
  const order = mapping.fieldIdToColIndex
  return fields
    .map((field) => ({
      id: field.id,
      name: field.name?.trim() || field.id,
      type: field.type,
    }))
    .sort((a, b) => (order[a.id] ?? 0) - (order[b.id] ?? 0))
})

watch(
  () => [route.query.source, route.query.sheetId, route.query.viewId],
  () => {
    if (!sourceIsMeta.value) {
      availableViews.value = []
      selectedViewId.value = ''
      return
    }
    const sheetId = toStr(route.query.sheetId) || activeSheetId.value
    if (sheetId) loadAvailableViews(sheetId)
    selectedViewId.value = toStr(route.query.viewId) ?? ''
  },
  { immediate: true },
)

const READONLY_HINTS = {
  property: '只读字段',
  lookup: 'Lookup 计算结果',
  rollup: 'Rollup 计算结果',
}

function resolveReadonlyTag(field: UniverMockField): string {
  if (field.type === 'lookup') return 'Lookup'
  if (field.type === 'rollup') return 'Rollup'
  if (field.property?.readonly) return '只读'
  return '只读'
}

function formatReadonlyReason(field: UniverMockField, reason: string): string {
  const label = field.name?.trim() || '该字段'
  return `字段【${label}】为${reason}，无法编辑`
}

function resolveReadonlyReason(field: UniverMockField): string | null {
  if (field.type === 'lookup') return formatReadonlyReason(field, READONLY_HINTS.lookup)
  if (field.type === 'rollup') return formatReadonlyReason(field, READONLY_HINTS.rollup)
  if (field.property?.readonly) return formatReadonlyReason(field, READONLY_HINTS.property)
  return null
}

function buildReadonlyFields(fields: UniverMockField[]): ReadonlyFieldEntry[] {
  return fields
    .map((field) => {
      const reason = resolveReadonlyReason(field)
      if (!reason) return null
      return {
        id: field.id,
        label: field.name?.trim() || String(field.id),
        reason,
        tag: resolveReadonlyTag(field),
      }
    })
    .filter((entry): entry is ReadonlyFieldEntry => Boolean(entry))
}

function syncReadonlyFields(fields: UniverMockField[]) {
  readonlyFields.value = buildReadonlyFields(fields)
  requestReadonlyHeaderUpdate()
}

function getReadonlyReason(fieldId: string): string | null {
  const reason = mapping.fieldIdToReadonlyReason[fieldId]
  return reason && reason.trim().length > 0 ? reason : null
}

function requestReadonlyHeaderUpdate() {
  if (headerIconRaf) window.cancelAnimationFrame(headerIconRaf)
  headerIconRaf = window.requestAnimationFrame(() => {
    headerIconRaf = 0
    updateReadonlyHeaderIcons()
  })
}

function showHeaderTooltip(icon: ReadonlyHeaderIcon) {
  headerTooltip.value = {
    text: icon.title,
    left: icon.left + 8,
    top: Math.max(6, icon.top - 32),
  }
}

function hideHeaderTooltip() {
  headerTooltip.value = null
}

function recordReadonlyHit(fieldId: string, reason: string, kind: ReadonlyHitKind) {
  readonlyMetrics.value.total += 1
  readonlyMetrics.value.byField[fieldId] = (readonlyMetrics.value.byField[fieldId] ?? 0) + 1
  readonlyMetrics.value.byKind[kind] = (readonlyMetrics.value.byKind[kind] ?? 0) + 1
  readonlyMetrics.value.lastFieldId = fieldId
  readonlyMetrics.value.lastReason = reason
  readonlyMetrics.value.lastKind = kind
  try {
    ;(window as any).__readonlyMetrics = { ...readonlyMetrics.value }
  } catch {
    // ignore
  }
}

function updateReadonlyHeaderIcons() {
  const sheet = univerAPI?.getActiveWorkbook?.()?.getActiveSheet?.()
  const wrapperEl = gridWrapperRef.value
  hideHeaderTooltip()
  if (!sheet || !wrapperEl) return
  if (readonlyFields.value.length === 0) {
    readonlyHeaderIcons.value = []
    return
  }

  const wrapperRect = wrapperEl.getBoundingClientRect()
  const icons: ReadonlyHeaderIcon[] = []
  for (const entry of readonlyFields.value) {
    const colIndex = mapping.fieldIdToColIndex[entry.id]
    if (typeof colIndex !== 'number' || !Number.isFinite(colIndex)) continue

    let rect: DOMRect | undefined
    try {
      const range = sheet.getRange(0, colIndex) as any
      rect = range?.getCellRect?.()
    } catch {
      rect = undefined
    }
    if (!rect || rect.width < 4) continue

    const left = rect.left - wrapperRect.left + Math.max(2, rect.width - 18)
    const top = rect.top - wrapperRect.top - 18

    icons.push({
      fieldId: entry.id,
      left: Math.max(4, left),
      top: Math.max(2, top),
      title: entry.reason,
    })
  }
  readonlyHeaderIcons.value = icons
}

function showReadonlyOverlay(fieldId: string, row: number, col: number, message: string, kind: ReadonlyHitKind): boolean {
  const wrapperEl = gridWrapperRef.value
  const sheet = univerAPI?.getActiveWorkbook?.()?.getActiveSheet?.()
  recordReadonlyHit(fieldId, message, kind)
  if (!wrapperEl || !sheet) return false

  let rect: DOMRect | undefined
  try {
    const range = sheet.getRange(row, col) as any
    rect = range?.getCellRect?.()
  } catch {
    rect = undefined
  }
  if (!rect) return false

  const wrapperRect = wrapperEl.getBoundingClientRect()
  const left = rect.left - wrapperRect.left
  const top = rect.bottom - wrapperRect.top + 4

  overlay.value = {
    kind: 'readonly',
    row,
    col,
    left,
    top,
    message,
  }
  return true
}

function focusReadonlyField(fieldId: string) {
  const colIndex = mapping.fieldIdToColIndex[fieldId]
  if (typeof colIndex !== 'number' || !Number.isFinite(colIndex)) return
  const reason = getReadonlyReason(fieldId) || `字段【${mapping.fieldIdToLabel[fieldId] ?? fieldId}】只读，无法编辑`
  const sheet = univerAPI?.getActiveWorkbook?.()?.getActiveSheet?.()
  if (!sheet) return

  try {
    const range = sheet.getRange(0, colIndex) as any
    sheet.setActiveRange(range)
  } catch {
    // ignore
  }

  if (!showReadonlyOverlay(fieldId, 0, colIndex, reason, 'list')) {
    statusText.value = reason
    statusKind.value = 'error'
  }
}

function buildCellValue(fieldType: UniverMockField['type'], raw: unknown): ICellData | null {
  if (raw === null || raw === undefined) return null

  if (typeof raw === 'string' && raw.startsWith('=')) {
    return { f: raw }
  }

  if (fieldType === 'link') {
    if (typeof raw === 'string') {
      if (!raw.trim()) return null
      return buildLinkCell(raw) as any
    }
    if (Array.isArray(raw)) {
      const text = raw
        .filter((v) => typeof v === 'string' || typeof v === 'number')
        .map((v) => String(v))
        .join(', ')
      if (!text.trim()) return null
      return buildLinkCell(text) as any
    }
  }

  if (fieldType === 'lookup') {
    if (Array.isArray(raw)) {
      const text = raw
        .filter((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
        .map((v) => String(v))
        .join(', ')
      if (!text.trim()) return null
      return { v: text }
    }
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      return { v: raw }
    }
  }

  if (fieldType === 'rollup') {
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      return { v: raw }
    }
  }

  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    return { v: raw }
  }

  return { v: JSON.stringify(raw) }
}

function buildCellForField(field: UniverMockField, raw: unknown): ICellData | null {
  const cell = buildCellValue(field.type, raw)
  if (!cell) return null
  const reason = resolveReadonlyReason(field)
  return reason ? applyReadonlyStyle(cell, reason) : cell
}

function restoreReadonlyCell(row: number, col: number, recordId: string, fieldId: string) {
  const sheet = univerAPI?.getActiveWorkbook?.()?.getActiveSheet?.()
  if (!sheet) return
  const raw = recordsById.value[recordId]?.data?.[fieldId]
  const fieldType = mapping.fieldIdToType[fieldId]
  const reason = getReadonlyReason(fieldId)
  const baseCell = buildCellValue(fieldType, raw) ?? { v: '' }
  const cell = reason ? applyReadonlyStyle(baseCell as any, reason) : baseCell

  try {
    suppressChanges = true
    sheet.getRange(row, col).setValueForCell(cell as any)
  } catch {
    // ignore
  } finally {
    suppressChanges = false
  }
}

function applyReadonlyIfNeeded(fieldId: string, cell: ICellData) {
  const reason = getReadonlyReason(fieldId)
  return reason ? applyReadonlyStyle(cell as any, reason) : cell
}

function applyComputedRecords(records: Array<{ recordId: string; data: Record<string, unknown> }>) {
  if (!records.length) return
  const sheet = univerAPI?.getActiveWorkbook?.()?.getActiveSheet?.()
  if (!sheet) return

  try {
    suppressChanges = true
    const nextRecords: Record<string, UniverMockRecord> = { ...recordsById.value }

    for (const record of records) {
      const rowIndex = mapping.recordIdToRowIndex[record.recordId]
      if (typeof rowIndex !== 'number' || !Number.isFinite(rowIndex)) continue

      const existing = mapping.recordIdToData[record.recordId] ?? {}
      mapping.recordIdToData[record.recordId] = { ...existing, ...record.data }

      const kanbanRecord = nextRecords[record.recordId]
      if (kanbanRecord) {
        kanbanRecord.data = { ...kanbanRecord.data, ...record.data }
      }

      for (const [fieldId, value] of Object.entries(record.data)) {
        const fieldType = mapping.fieldIdToType[fieldId]
        if (fieldType !== 'lookup' && fieldType !== 'rollup') continue
        const colIndex = mapping.fieldIdToColIndex[fieldId]
        if (typeof colIndex !== 'number' || !Number.isFinite(colIndex)) continue

        const baseCell = buildCellValue(fieldType, value) ?? { v: '' }
        const cell = applyReadonlyIfNeeded(fieldId, baseCell)
        sheet.getRange(rowIndex, colIndex).setValueForCell(cell as any)
      }
    }

    recordsById.value = nextRecords
  } finally {
    suppressChanges = false
  }
}

function mergeRelatedUpdates(existing: RelatedRecord[], incoming: RelatedRecord[]): RelatedRecord[] {
  const merged = new Map<string, RelatedRecord>()
  for (const record of existing) {
    merged.set(`${record.sheetId}:${record.recordId}`, record)
  }
  for (const record of incoming) {
    merged.set(`${record.sheetId}:${record.recordId}`, record)
  }
  return Array.from(merged.values())
}

function handleRelatedRecords(records: RelatedRecord[]) {
  if (!records.length) return
  const currentSheetId = viewId.value
  const sameSheet = records.filter((record) => record.sheetId === currentSheetId)
  if (sameSheet.length > 0) {
    applyComputedRecords(sameSheet.map((record) => ({ recordId: record.recordId, data: record.data })))
  }
  const external = records.filter((record) => record.sheetId !== currentSheetId)
  if (external.length === 0) return
  relatedUpdates.value = mergeRelatedUpdates(relatedUpdates.value, external)
}

function transformToWorkbook(view: UniverMockView): IWorkbookData {
  const sheetId = view.id

  const cellData: Record<number, Record<number, ICellData>> = {}
  view.rows.forEach((record, rowIndex) => {
    const rowCells: Record<number, ICellData> = {}
    view.fields.forEach((field, colIndex) => {
      const raw = (record.data[field.id] ?? record.data[field.name]) as unknown
      const cell = buildCellForField(field, raw)
      if (cell) rowCells[colIndex] = cell
    })
  if (Object.keys(rowCells).length > 0) {
      cellData[rowIndex] = rowCells
    }
  })

  const windowing = resolveWindowing()
  const rowTotal = view.page?.total ?? view.rows.length
  const rowCount = resolveWindowRowCount(rowTotal, view.rows.length, windowing)

  return {
    id: `workbook_${sheetId}`,
    name: `MetaSheet(${sheetId})`,
    appVersion: '0.12.4',
    locale: LocaleType.ZH_CN,
    styles: {},
    sheetOrder: [sheetId],
    sheets: {
      [sheetId]: {
        id: sheetId,
        name: 'Sheet1',
        rowCount,
        columnCount: Math.max(view.fields.length, 10),
        cellData,
      },
    },
  }
}

function applySelect(value: string, color?: string) {
  const current = overlay.value
  if (!current || current.kind !== 'select' || !univerAPI) return
  const sheet = univerAPI.getActiveWorkbook?.()?.getActiveSheet?.()
  if (!sheet) return

  const resolvedColor = color || resolveFallbackSelectColor(value) || '#1677ff'
  try {
    sheet.getRange(current.row, current.col).setValueForCell(buildSelectCell(value, resolvedColor) as any)
  } catch (err) {
    console.error('[UniverKanbanPOC] applySelect failed:', err)
  }
  overlay.value = null
}

function applyLink(payload: LinkChangePayload) {
  const current = overlay.value
  if (!current || current.kind !== 'link' || !univerAPI) return
  const sheet = univerAPI.getActiveWorkbook?.()?.getActiveSheet?.()
  if (!sheet) return

  try {
    const { ids, displays } = payload
    const displayText = displays.filter(Boolean).join(', ')
    const cell = buildLinkCell(displayText)
    ;(cell as any).__linkIds = ids
    sheet.getRange(current.row, current.col).setValueForCell(cell as any)
  } catch (err) {
    console.error('[UniverKanbanPOC] applyLink failed:', err)
  }
  overlay.value = null
}

function getSelectColor(fieldId: string, value: string): string | undefined {
  const opt = mapping.fieldIdToSelectOptions[fieldId]?.find(o => o.value === value)
  return opt?.color ?? resolveFallbackSelectColor(value)
}

function isFieldHidden(fieldId: string): boolean {
  if (!fieldId) return false
  return hiddenFieldIds.value.includes(fieldId)
}

function applyHiddenFieldsToSheet(nextHiddenIds: string[]) {
  const sheet = univerAPI?.getActiveWorkbook?.()?.getActiveSheet?.()
  if (!sheet) return
  const hiddenSet = new Set(nextHiddenIds)
  for (const [fieldId, colIndex] of Object.entries(mapping.fieldIdToColIndex)) {
    if (!Number.isFinite(colIndex)) continue
    try {
      if (hiddenSet.has(fieldId)) {
        sheet.hideColumns(colIndex, 1)
      } else if (typeof sheet.showColumns === 'function') {
        sheet.showColumns(colIndex, 1)
      }
    } catch {
      // ignore
    }
  }
}

function setHiddenFieldIds(nextHiddenIds: string[], options: { persist?: boolean } = {}) {
  hiddenFieldIds.value = nextHiddenIds
  viewSummary.value = viewSummary.value
    ? { ...viewSummary.value, hiddenCount: nextHiddenIds.length }
    : viewSummary.value
  applyHiddenFieldsToSheet(nextHiddenIds)
  if (options.persist !== false) {
    scheduleViewConfigSave()
  }
}

function scheduleViewConfigSave() {
  if (viewConfigTimer) window.clearTimeout(viewConfigTimer)
  viewConfigTimer = window.setTimeout(() => {
    viewConfigTimer = 0
    void persistHiddenFieldIds(hiddenFieldIds.value)
  }, 300)
}

async function persistHiddenFieldIds(nextHiddenIds: string[]) {
  if (!sourceIsMeta.value || !viewConfigId.value) return
  viewConfigSaving.value = true
  viewConfigStatus.value = 'Saving view config...'
  try {
    const res = await apiFetch(`/api/univer-meta/views/${encodeURIComponent(viewConfigId.value)}`, {
      method: 'PATCH',
      body: JSON.stringify({ hiddenFieldIds: nextHiddenIds }),
    })
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: { message?: string } }
    if (!res.ok || !json.ok) {
      const message = json.error?.message || `Failed to save view (${res.status})`
      viewConfigStatus.value = message
      setHiddenFieldIds(stableHiddenFieldIds.value.slice(), { persist: false })
      return
    }
    stableHiddenFieldIds.value = nextHiddenIds.slice()
    viewConfigStatus.value = 'View config saved'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    viewConfigStatus.value = `Save failed: ${message}`
    setHiddenFieldIds(stableHiddenFieldIds.value.slice(), { persist: false })
  } finally {
    viewConfigSaving.value = false
    if (viewConfigStatus.value) {
      window.setTimeout(() => {
        if (!viewConfigSaving.value) viewConfigStatus.value = ''
      }, 2000)
    }
  }
}

function toggleFieldVisibility(fieldId: string, event: Event) {
  const checked = (event.target as HTMLInputElement | null)?.checked ?? true
  const next = new Set(hiddenFieldIds.value)
  if (checked) {
    next.delete(fieldId)
  } else {
    next.add(fieldId)
  }
  setHiddenFieldIds(Array.from(next))
}

function resolveVisibleTitleFieldId(): string {
  const preferred = titleFieldId.value
  if (preferred && !isFieldHidden(preferred)) return preferred
  for (const fieldId of mapping.colIndexToFieldId) {
    if (!fieldId || isFieldHidden(fieldId)) continue
    if (mapping.fieldIdToType[fieldId] === 'string') return fieldId
  }
  return ''
}

async function createRecord() {
  if (!viewId.value) return
  statusText.value = 'Creating...'
  statusKind.value = 'ok'

  try {
    const initialData: Record<string, unknown> = {}
    const nameId = titleFieldId.value
    const priorityId = priorityFieldId.value
    const relatedId = relatedFieldId.value
    if (mapping.fieldIdToType[nameId] === 'string') {
      initialData[nameId] = `新记录 ${new Date().toISOString().slice(11, 19)}`
    }
    if (mapping.fieldIdToType[priorityId] === 'select') {
      const options = mapping.fieldIdToSelectOptions[priorityId] ?? []
      const prefer = ['P1', 'P0', 'P2', 'Done']
      const picked = prefer.find(v => options.some(o => o.value === v)) ?? options[0]?.value ?? ''
      if (picked) initialData[priorityId] = picked
    }
    if (mapping.fieldIdToType[relatedId] === 'link') {
      initialData[relatedId] = `PLM#${Math.floor(Date.now() / 1000)}`
    }

    const res = await apiFetch(`${getApiPrefix()}/records`, {
      method: 'POST',
      body: JSON.stringify({ viewId: viewId.value, data: Object.keys(initialData).length > 0 ? initialData : undefined }),
    })
    const json = (await res.json().catch(() => ({}))) as UniverMockCreateRecordResponse
    if (!res.ok || !json.ok || !json.data) {
      statusText.value = `Create failed: ${formatApiErrorMessage(json.error, String(res.status))}`
      statusKind.value = 'error'
      return
    }

    const record = json.data.record
    const rowIndex = mapping.rowIndexToRecordId.length
    mapping.rowIndexToRecordId.push(record.id)
    mapping.recordIdToRowIndex[record.id] = rowIndex
    mapping.recordIdToVersion[record.id] = record.version
    mapping.recordIdToData[record.id] = { ...record.data }
    recordsById.value = {
      ...recordsById.value,
      [record.id]: { id: record.id, version: record.version, data: { ...record.data } },
    }
    loadedCount.value += 1
    if (page.value) {
      page.value = { ...page.value, total: page.value.total + 1 }
    }
    try {
      ;(window as any).__pocRecordIds = mapping.rowIndexToRecordId.slice()
    } catch {
      // ignore
    }

    const sheet = univerAPI?.getActiveWorkbook?.()?.getActiveSheet?.()
    if (sheet) {
      try {
        suppressChanges = true
        const nextRowCount = Math.max(sheetRowCount, rowIndex + 1, 50)
        if (sheetRowCount < nextRowCount) {
          ;(sheet as any).setRowCount(nextRowCount)
          sheetRowCount = nextRowCount
        }

        for (let colIndex = 0; colIndex < mapping.colIndexToFieldId.length; colIndex += 1) {
          const fieldId = mapping.colIndexToFieldId[colIndex]
          const fieldType = mapping.fieldIdToType[fieldId]
          const raw = record.data[fieldId] as unknown
          if (raw == null) continue

          if (typeof raw === 'string' && raw.startsWith('=')) {
            sheet.getRange(rowIndex, colIndex).setValueForCell(applyReadonlyIfNeeded(fieldId, { f: raw }) as any)
            continue
          }

          if (fieldType === 'select' && typeof raw === 'string') {
            const color = raw ? getSelectColor(fieldId, raw) ?? '#1677ff' : undefined
            if (color) sheet.getRange(rowIndex, colIndex).setValueForCell(applyReadonlyIfNeeded(fieldId, buildSelectCell(raw, color) as any))
            else sheet.getRange(rowIndex, colIndex).setValueForCell(applyReadonlyIfNeeded(fieldId, { v: raw }) as any)
            continue
          }

          if (fieldType === 'link') {
            if (typeof raw === 'string') {
              if (raw.trim().length > 0) {
                sheet.getRange(rowIndex, colIndex).setValueForCell(applyReadonlyIfNeeded(fieldId, buildLinkCell(raw) as any))
              } else {
                sheet.getRange(rowIndex, colIndex).setValueForCell(applyReadonlyIfNeeded(fieldId, { v: raw }) as any)
              }
              continue
            }
            if (Array.isArray(raw)) {
              const text = raw
                .filter((v) => typeof v === 'string' || typeof v === 'number')
                .map((v) => String(v))
                .join(', ')
              if (text.trim().length > 0) {
                sheet.getRange(rowIndex, colIndex).setValueForCell(applyReadonlyIfNeeded(fieldId, buildLinkCell(text) as any))
              } else {
                sheet.getRange(rowIndex, colIndex).setValueForCell(applyReadonlyIfNeeded(fieldId, { v: text }) as any)
              }
              continue
            }
          }

          if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
            sheet.getRange(rowIndex, colIndex).setValueForCell(applyReadonlyIfNeeded(fieldId, { v: raw }) as any)
            continue
          }

          sheet.getRange(rowIndex, colIndex).setValueForCell(applyReadonlyIfNeeded(fieldId, { v: JSON.stringify(raw) }) as any)
        }
      } catch (err) {
        console.error('[UniverKanbanPOC] append created row failed:', err)
      } finally {
        suppressChanges = false
      }
    }
    statusText.value = `Created (${record.id})`
    statusKind.value = 'ok'
  } catch (err) {
    console.error('[UniverKanbanPOC] create record failed:', err)
    statusText.value = 'Create failed (network error)'
    statusKind.value = 'error'
  }
}

async function deleteRecord(recordId: string) {
  if (!viewId.value) return
  if (!recordId) return

  const rowIndex = mapping.recordIdToRowIndex[recordId]
  const expectedVersion = mapping.recordIdToVersion[recordId]

  statusText.value = 'Deleting...'
  statusKind.value = 'ok'

  try {
    const qs = new URLSearchParams()
    if (typeof expectedVersion === 'number') qs.set('expectedVersion', String(expectedVersion))
    if (getApiPrefix() === '/api/univer-mock') qs.set('viewId', viewId.value)

    const url = `${getApiPrefix()}/records/${encodeURIComponent(recordId)}${qs.toString() ? `?${qs.toString()}` : ''}`
    const res = await apiFetch(url, { method: 'DELETE' })
    const json = (await res.json().catch(() => ({}))) as UniverMockDeleteRecordResponse
    if (!res.ok || !json.ok) {
      statusText.value = `Delete failed: ${formatApiErrorMessage(json.error, String(res.status))}`
      statusKind.value = 'error'
      return
    }

      if (typeof rowIndex === 'number' && Number.isFinite(rowIndex)) {
        mapping.rowIndexToRecordId.splice(rowIndex, 1)
        delete mapping.recordIdToRowIndex[recordId]
        delete mapping.recordIdToVersion[recordId]
        delete mapping.recordIdToData[recordId]
        for (let i = rowIndex; i < mapping.rowIndexToRecordId.length; i += 1) {
          const rid = mapping.rowIndexToRecordId[i]
          if (rid) mapping.recordIdToRowIndex[rid] = i
        }

      const sheet = univerAPI?.getActiveWorkbook?.()?.getActiveSheet?.()
      if (sheet) {
        try {
          suppressChanges = true
          sheet.deleteRows(rowIndex, 1)
          sheetRowCount = Math.max(1, sheetRowCount - 1)
        } catch (err) {
          console.error('[UniverKanbanPOC] deleteRows failed:', err)
        } finally {
          suppressChanges = false
        }
      }
    }

    const nextRecords = { ...recordsById.value }
    delete nextRecords[recordId]
    recordsById.value = nextRecords
    loadedCount.value = Math.max(0, loadedCount.value - 1)
    if (selectedRecordId.value === recordId) {
      selectedRecordId.value = ''
      selectedFieldId.value = undefined
    }

    if (page.value) {
      const total = Math.max(0, page.value.total - 1)
      const windowing = resolveWindowing()
      const offset = windowing.enabled ? baseOffset.value : Math.min(page.value.offset, total)
      const hasMore = baseOffset.value + loadedCount.value < total
      page.value = { ...page.value, total, offset, hasMore }
    }

    try {
      ;(window as any).__pocRecordIds = mapping.rowIndexToRecordId.slice()
    } catch {
      // ignore
    }

    statusText.value = `Deleted (${recordId})`
    statusKind.value = 'ok'
  } catch (err) {
    console.error('[UniverKanbanPOC] delete record failed:', err)
    statusText.value = 'Delete failed (network error)'
    statusKind.value = 'error'
  }
}

const loadMore = async () => {
  const currentPage = page.value
  const source = toStr(route.query.source)?.toLowerCase()
  if (!currentPage || source !== 'meta') return
  if (loadingMore.value) return

  const sheet = univerAPI?.getActiveWorkbook?.()?.getActiveSheet?.()
  if (!sheet) return

  const windowing = resolveWindowing()
  const nextOffset = baseOffset.value + loadedCount.value
  if (nextOffset >= currentPage.total) {
    page.value = { ...currentPage, hasMore: false }
    return
  }

  loadingMore.value = true
  statusText.value = 'Loading more...'
  statusKind.value = 'ok'

  try {
    const qs = new URLSearchParams()
    const queryViewId = toStr(route.query.viewId)
    const resolvedSheetId = viewId.value
    if (queryViewId) {
      qs.set('viewId', queryViewId)
      if (resolvedSheetId) qs.set('sheetId', resolvedSheetId)
    } else if (resolvedSheetId) {
      qs.set('sheetId', resolvedSheetId)
    } else {
      return
    }
    qs.set('limit', String(currentPage.limit))
    qs.set('offset', String(nextOffset))
    if (toStr(route.query.seed)) qs.set('seed', String(route.query.seed))

    const response = await apiGet<UniverMockViewResponse>(`${getApiPrefix()}/view?${qs.toString()}`)
    if (!response.ok || !response.data) {
      throw new Error(response.error?.message ?? 'failed to load next page')
    }

    const rows = response.data.rows ?? []
    const newRows = rows.filter((r) => typeof mapping.recordIdToRowIndex[r.id] !== 'number')
    if (newRows.length === 0) {
      const total = response.data.page?.total ?? currentPage.total
      page.value = {
        ...currentPage,
        offset: windowing.enabled ? baseOffset.value : currentPage.offset,
        limit: response.data.page?.limit ?? currentPage.limit,
        total,
        hasMore: baseOffset.value + loadedCount.value < total,
      }
      statusText.value = 'No more rows'
      statusKind.value = 'ok'
      return
    }

    const startRowIndex = mapping.rowIndexToRecordId.length
    const total = response.data.page?.total ?? currentPage.total
    const nextRowCount = resolveWindowRowCount(total, startRowIndex + newRows.length, windowing)

    suppressChanges = true
    if (sheetRowCount < nextRowCount) {
      ;(sheet as any).setRowCount(nextRowCount)
      sheetRowCount = nextRowCount
    }

    const nextRecords: Record<string, UniverMockRecord> = { ...recordsById.value }
    for (let i = 0; i < newRows.length; i += 1) {
      const record = newRows[i]
      const rowIndex = startRowIndex + i
      mapping.rowIndexToRecordId.push(record.id)
      mapping.recordIdToRowIndex[record.id] = rowIndex
      mapping.recordIdToVersion[record.id] = record.version
      mapping.recordIdToData[record.id] = { ...record.data }
      nextRecords[record.id] = { id: record.id, version: record.version, data: { ...record.data } }

      for (let colIndex = 0; colIndex < response.data.fields.length; colIndex += 1) {
        const field = response.data.fields[colIndex]
        const fieldId = field.id
        const raw = (record.data[fieldId] ?? record.data[field.name]) as unknown
        const cell = buildCellForField(field, raw)
        if (cell) sheet.getRange(rowIndex, colIndex).setValueForCell(cell as any)
      }
    }

    recordsById.value = nextRecords
    loadedCount.value += newRows.length
    if (windowing.enabled && windowing.max > 0 && loadedCount.value > windowing.max) {
      const evictCount = loadedCount.value - windowing.max
      if (evictCount > 0) {
        patchQueue?.flushNow()
        const evictedIds = mapping.rowIndexToRecordId.splice(0, evictCount)
        const updatedRecords: Record<string, UniverMockRecord> = { ...recordsById.value }
        for (const recordId of evictedIds) {
          if (!recordId) continue
          delete mapping.recordIdToRowIndex[recordId]
          delete mapping.recordIdToVersion[recordId]
          delete mapping.recordIdToData[recordId]
          delete updatedRecords[recordId]
        }
        for (let i = 0; i < mapping.rowIndexToRecordId.length; i += 1) {
          const rid = mapping.rowIndexToRecordId[i]
          if (rid) mapping.recordIdToRowIndex[rid] = i
        }
        recordsById.value = updatedRecords
        try {
          sheet.deleteRows(0, evictCount)
        } catch (err) {
          console.error('[UniverKanbanPOC] deleteRows failed:', err)
        }
        baseOffset.value += evictCount
        loadedCount.value = mapping.rowIndexToRecordId.length
        const windowRowCount = resolveWindowRowCount(total, loadedCount.value, windowing)
        ;(sheet as any).setRowCount(windowRowCount)
        sheetRowCount = windowRowCount
      }
    }
    page.value = {
      ...currentPage,
      offset: windowing.enabled ? baseOffset.value : currentPage.offset,
      limit: response.data.page?.limit ?? currentPage.limit,
      total,
      hasMore: baseOffset.value + loadedCount.value < total,
    }
    try {
      ;(window as any).__pocRecordIds = mapping.rowIndexToRecordId.slice()
    } catch {
      // ignore
    }

    statusText.value = `Loaded +${newRows.length}`
    statusKind.value = 'ok'
  } catch (err) {
    console.error('[UniverKanbanPOC] loadMore failed:', err)
    statusText.value = 'Load more failed'
    statusKind.value = 'error'
  } finally {
    suppressChanges = false
    loadingMore.value = false
    requestReadonlyHeaderUpdate()
  }
}

async function reloadView() {
  if (!startLoad) return
  relatedUpdates.value = []
  hasConflict.value = false
  conflictServerVersion.value = null
  overlay.value = null
  statusText.value = 'Reloading...'
  statusKind.value = 'ok'
  await startLoad()
}

function reload() {
  reloadView().catch((err) => {
    console.error('[UniverKanbanPOC] reload failed:', err)
  })
}

function selectRecord(recordId: string) {
  if (!recordId) {
    selectedRecordId.value = ''
    selectedFieldId.value = undefined
    return
  }
  selectedRecordId.value = recordId
  selectedFieldId.value = undefined
}

function handleCommentUpdated(payload: { rowId: string }) {
  if (!payload?.rowId) return
  queueCommentSummaryRefresh([payload.rowId])
}

function handleDragStart(_event: DragEvent, recordId: string, fromColumn: string) {
  dragState.value = { recordId, from: fromColumn }
  selectRecord(recordId)
}

function handleDrop(_event: DragEvent, toColumn: string) {
  const dragged = dragState.value
  if (!dragged || dragged.from === toColumn) return
  dragState.value = null

  const record = recordsById.value[dragged.recordId]
  if (!record) return

  const fieldId = priorityFieldId.value
  const row = mapping.recordIdToRowIndex[record.id]
  const col = mapping.fieldIdToColIndex[fieldId]
  const sheet = univerAPI?.getActiveWorkbook?.()?.getActiveSheet?.()
  if (!sheet || typeof row !== 'number' || typeof col !== 'number') return

  const color = getSelectColor(fieldId, toColumn) ?? '#1677ff'
  try {
    sheet.getRange(row, col).setValueForCell(buildSelectCell(toColumn, color) as any)
  } catch (err) {
    console.error('[UniverKanbanPOC] drop setValueForCell failed:', err)
  }
}

const kanbanColumns = computed(() => {
  const priorityId = priorityFieldId.value
  const titleId = resolveVisibleTitleFieldId()
  const metaId = relatedFieldId.value

  const optionValues = (mapping.fieldIdToSelectOptions[priorityId] ?? []).map(o => o.value).filter(Boolean)
  const order = optionValues.length > 0 ? optionValues : (['P0', 'P1', 'P2', 'Done'] as const)
  const groups: Record<string, Array<{ id: string; title: string; meta: string }>> = Object.fromEntries(order.map(v => [v, []]))
  const fallback = order.includes('P1') ? 'P1' : (order[0] ?? 'P1')

  for (const r of Object.values(recordsById.value)) {
    const rawPriority = r.data[priorityId]
    const priority = typeof rawPriority === 'string' && rawPriority ? rawPriority : fallback
    const key = priority in groups ? priority : fallback
    const rawTitle = titleId ? r.data[titleId] : undefined
    const title = typeof rawTitle === 'string' && rawTitle ? rawTitle : r.id
    const rawMeta = isFieldHidden(metaId) ? undefined : r.data[metaId]
    const meta =
      typeof rawMeta === 'string'
        ? rawMeta
        : Array.isArray(rawMeta)
          ? rawMeta
              .filter((v) => typeof v === 'string' || typeof v === 'number')
              .map((v) => String(v))
              .join(', ')
          : ''
    groups[key].push({ id: r.id, title, meta })
  }

  return order.map((id) => ({ id, title: id, cards: groups[id].slice(0, 50) }))
})

watch(
  () => [commentsEnabled.value, commentsSpreadsheetId.value, Object.keys(recordsById.value).join('|')],
  () => {
    queueCommentSummaryRefresh()
  },
  { immediate: true }
)

onMounted(async () => {
  await ensureMetaQueryDefaults()

  const hostEl = gridMountRef.value
  if (!hostEl) return

  const embed = createUniverEmbed(
    hostEl,
    (mountEl: HTMLElement) =>
      createUniver({
        theme: defaultTheme,
        locale: LocaleType.ZH_CN,
        locales: buildUniverSheetsLocalesMinimal() as any,
        presets: [UniverSheetsCorePreset({ container: mountEl })],
      }),
    { exposeToWindow: true },
  )

  univerAPI = embed.univerAPI

  const handleScroll = () => requestReadonlyHeaderUpdate()
  gridWrapperRef.value?.addEventListener('scroll', handleScroll, true)
  window.addEventListener('resize', handleScroll)
  headerIconCleanup = () => {
    gridWrapperRef.value?.removeEventListener('scroll', handleScroll, true)
    window.removeEventListener('resize', handleScroll)
    if (headerIconRaf) window.cancelAnimationFrame(headerIconRaf)
    headerIconRaf = 0
  }

  patchQueue = createUniverPatchQueue({
    getViewId: () => viewId.value,
    getApiPrefix,
    mapping,
    setStatus: (text: string, kind: 'ok' | 'error') => {
      statusText.value = text
      statusKind.value = kind
    },
    onUpdated: (updated) => {
      for (const u of updated) {
        const record = recordsById.value[u.recordId]
        if (record) record.version = u.version
      }
    },
    onRecords: applyComputedRecords,
    onRelatedRecords: handleRelatedRecords,
    onConflict: (serverVersion: number) => {
      hasConflict.value = true
      conflictServerVersion.value = serverVersion
    },
    flushDelayMs: 120,
  })

  const univer = univerAPI!
  const disposable = univer.addEvent(univer.Event.CommandExecuted, (event: any) => {
    if (event.id === SetSelectionsOperation.id) {
      const selections = (event.params as { selections?: Array<{ primary?: { actualRow?: number; actualColumn?: number } | null }> })
        ?.selections
      const primary = selections?.find(s => s?.primary)?.primary
      const row = primary?.actualRow
      const col = primary?.actualColumn
      if (typeof row !== 'number' || typeof col !== 'number') {
        overlay.value = null
        return
      }

      const fieldId = mapping.colIndexToFieldId[col]
      const fieldType = mapping.fieldIdToType[fieldId]
      if (!fieldId) {
        overlay.value = null
        selectedRecordId.value = ''
        selectedFieldId.value = undefined
        return
      }

      const recordId = mapping.rowIndexToRecordId[row] ?? ''
      if (!recordId) {
        overlay.value = null
        selectedRecordId.value = ''
        selectedFieldId.value = undefined
        return
      }
      selectedRecordId.value = recordId
      selectedFieldId.value = fieldId

      const readonlyReason = getReadonlyReason(fieldId)
      if (readonlyReason) {
        if (!showReadonlyOverlay(fieldId, row, col, readonlyReason, 'select')) {
          overlay.value = null
        }
        return
      }
      if (fieldType !== 'select' && fieldType !== 'link') {
        overlay.value = null
        return
      }

      const wrapperEl = gridWrapperRef.value
      const sheet = univerAPI?.getActiveWorkbook?.()?.getActiveSheet?.()
      if (!wrapperEl || !sheet) {
        overlay.value = null
        return
      }

      let rect: DOMRect | undefined
      try {
        const range = sheet.getRange(row, col) as any
        rect = range?.getCellRect?.()
      } catch {
        rect = undefined
      }
      if (!rect) {
        overlay.value = null
        return
      }

      const wrapperRect = wrapperEl.getBoundingClientRect()
      const left = rect.left - wrapperRect.left
      const top = rect.bottom - wrapperRect.top + 4

      if (fieldType === 'select') {
        overlay.value = {
          kind: 'select',
          row,
          col,
          left,
          top,
          fieldId,
          options: mapping.fieldIdToSelectOptions[fieldId] ?? [],
        }
        return
      }

      overlay.value = {
        kind: 'link',
        row,
        col,
        left,
        top,
        fieldId,
        foreignSheetId: (mapping.fieldIdToProperty[fieldId]?.foreignDatasheetId
          ?? mapping.fieldIdToProperty[fieldId]?.foreignSheetId
          ?? '') as string,
        displayFieldId: mapping.fieldIdToProperty[fieldId]?.displayFieldId,
        multiple: mapping.fieldIdToProperty[fieldId]?.limitSingleRecord !== true,
      }
      try {
        const current = sheet.getRange(row, col).getCellData?.() as { v?: unknown; __linkIds?: unknown } | undefined
        const rawIds = Array.isArray(current?.__linkIds) ? current?.__linkIds : undefined
        const val = rawIds ?? current?.v
        if (Array.isArray(val)) {
          linkDraft.value = val.filter((v): v is string => typeof v === 'string')
        } else if (typeof val === 'string' && val.trim()) {
          try {
            const parsed = JSON.parse(val)
            linkDraft.value = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [val]
          } catch {
            linkDraft.value = val.includes(',') ? val.split(',').map((s) => s.trim()).filter(Boolean) : [val]
          }
        } else {
          linkDraft.value = []
        }
      } catch {
        linkDraft.value = []
      }
      return
    }

    if (event.id !== SetRangeValuesMutation.id) return
    if (suppressChanges) return
    const cellValue = (event.params as { cellValue?: Record<string, Record<string, unknown>> })?.cellValue
    if (!cellValue) return

    for (const [rowKey, rowValue] of Object.entries(cellValue)) {
      const row = Number(rowKey)
      if (!Number.isFinite(row)) continue
      const recordId = mapping.rowIndexToRecordId[row]
      if (!recordId) continue

      for (const [colKey, cell] of Object.entries(rowValue)) {
        const col = Number(colKey)
        if (!Number.isFinite(col)) continue
        const fieldId = mapping.colIndexToFieldId[col]
        if (!fieldId) continue

        const readonlyReason = getReadonlyReason(fieldId)
        if (readonlyReason) {
          restoreReadonlyCell(row, col, recordId, fieldId)
          recordReadonlyHit(fieldId, readonlyReason, 'edit')
          statusText.value = readonlyReason
          statusKind.value = 'error'
          continue
        }

        const value = extractValueFromCell(cell)
        const fieldType = mapping.fieldIdToType[fieldId]
        if (fieldType === 'lookup' || fieldType === 'rollup') continue
        if (fieldType === 'formula' && !isFormulaValue(value)) continue

        // Store sync (grid -> kanban)
        const record = recordsById.value[recordId]
        if (record) record.data[fieldId] = value
        if (mapping.recordIdToData[recordId]) {
          mapping.recordIdToData[recordId][fieldId] = value as any
        }

        patchQueue?.stageChange(recordId, fieldId, value)
      }
    }

    patchQueue?.requestFlush(120)
  })

  const start = async () => {
    try {
      viewConfigStatus.value = ''
      viewConfigSaving.value = false
      const qs = getQueryString()
      const response = await apiGet<UniverMockViewResponse>(`${getApiPrefix()}/view${qs}`)
      if (!response.ok || !response.data) {
        throw new Error(response.error?.message ?? 'failed to load view')
      }

      titleFieldId.value = resolveFieldId(response.data.fields, { preferId: 'name', type: 'string', nameRe: /名称|name|title/i })
      priorityFieldId.value = resolveFieldId(response.data.fields, { preferId: 'priority', type: 'select', nameRe: /优先|priority/i })
      relatedFieldId.value = resolveFieldId(response.data.fields, { preferId: 'related', type: 'link', nameRe: /关联|related|link/i })

      const source = toStr(route.query.source)?.toLowerCase()
      const groupInfo = response.data.view?.groupInfo
      const groupFieldId = toStr(
        groupInfo && typeof groupInfo === 'object' && !Array.isArray(groupInfo)
          ? (groupInfo as Record<string, unknown>).fieldId
          : undefined,
      )
      if (source === 'meta' && groupFieldId) {
        const groupField = response.data.fields.find((f) => f.id === groupFieldId)
        if (groupField?.type === 'select') {
          priorityFieldId.value = groupField.id
        }
      }

      activeSheetId.value = response.data.id
      viewSummary.value = buildViewSummary(response.data)
      viewId.value = response.data.id
      selectedViewId.value = toStr(route.query.viewId) ?? ''
      viewWarnings.value = Array.isArray(response.data.meta?.warnings) ? response.data.meta!.warnings!.slice() : []
      diagnosticsItems.value = buildDiagnostics(response.data)
      mapping.rowIndexToRecordId = response.data.rows.map(r => r.id)
      mapping.recordIdToRowIndex = Object.fromEntries(mapping.rowIndexToRecordId.map((id, idx) => [id, idx]))
      mapping.colIndexToFieldId = response.data.fields.map(f => f.id)
      mapping.fieldIdToColIndex = Object.fromEntries(mapping.colIndexToFieldId.map((id, idx) => [id, idx]))
      mapping.recordIdToVersion = Object.fromEntries(response.data.rows.map(r => [r.id, r.version]))
      mapping.fieldIdToType = Object.fromEntries(response.data.fields.map(f => [f.id, f.type]))
      mapping.fieldIdToSelectOptions = Object.fromEntries(
        response.data.fields
          .filter((f) => f.type === 'select' && Array.isArray(f.options))
          .map((f) => [f.id, f.options ?? []]),
      )
      mapping.fieldIdToProperty = Object.fromEntries(
        response.data.fields
          .filter((f) => f.property)
          .map((f) => [f.id, f.property]),
      )
      mapping.fieldIdToReadonlyReason = Object.fromEntries(
        response.data.fields
          .map((f) => [f.id, resolveReadonlyReason(f)] as const)
          .filter((entry) => Boolean(entry[1])),
      ) as Record<string, string>
      mapping.fieldIdToLabel = Object.fromEntries(
        response.data.fields
          .map((f) => [f.id, f.name?.trim() || String(f.id)] as const),
      ) as Record<string, string>
      syncReadonlyFields(response.data.fields)
      viewFields.value = response.data.fields
      viewConfigId.value = response.data.view?.id ?? ''
      const windowing = resolveWindowing()
      const viewRows =
        windowing.enabled && source !== 'meta'
          ? response.data.rows.slice(0, windowing.size)
          : response.data.rows
      const viewData = { ...response.data, rows: viewRows }

      mapping.recordIdToData = Object.fromEntries(viewRows.map((r) => [r.id, { ...r.data }]))

      recordsById.value = Object.fromEntries(viewRows.map((r) => [r.id, { id: r.id, version: r.version, data: { ...r.data } }]))

      univerAPI!.createWorkbook(transformToWorkbook(viewData))
      requestReadonlyHeaderUpdate()
      const sheet = univerAPI?.getActiveWorkbook?.()?.getActiveSheet?.()
      const hiddenIds = Array.isArray(response.data.view?.hiddenFieldIds)
        ? response.data.view!.hiddenFieldIds!.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length > 0)
        : []
      stableHiddenFieldIds.value = hiddenIds.slice()
      setHiddenFieldIds(hiddenIds, { persist: false })
      try {
        ;(window as any).__pocHiddenFieldIds = hiddenIds
        ;(window as any).__pocHiddenCols = sheet?.getSheet?.().getHiddenCols?.() ?? []
      } catch {
        // ignore
      }
      const total = response.data.page?.total ?? response.data.rows.length
      sheetRowCount = resolveWindowRowCount(total, viewRows.length, windowing)
      page.value = response.data.page ?? null
      loadedCount.value = viewRows.length
      baseOffset.value = response.data.page?.offset ?? 0
      if (page.value) {
        page.value = {
          ...page.value,
          offset: windowing.enabled ? baseOffset.value : page.value.offset,
          hasMore: baseOffset.value + loadedCount.value < page.value.total,
        }
      }
      try {
        ;(window as any).__pocRecordIds = mapping.rowIndexToRecordId.slice()
      } catch {
        // ignore
      }
      statusText.value = 'Loaded'
      statusKind.value = 'ok'
      statusHint.value = ''
    } catch (err) {
      console.error('[UniverKanbanPOC] load view failed:', err)
      const hint = buildMissingSheetHint(err)
      if (hint) {
        statusText.value = hint.title
        statusHint.value = hint.hint
      } else {
        statusText.value = 'Load failed'
        statusHint.value = ''
      }
      statusKind.value = 'error'
      viewWarnings.value = []
      activeSheetId.value = ''
      viewSummary.value = null
      hiddenFieldIds.value = []
      stableHiddenFieldIds.value = []
      viewFields.value = []
      viewConfigId.value = ''
      diagnosticsItems.value = []
    }
  }

  startLoad = async () => {
    await start()
  }

  startLoad().catch((err) => {
    console.error('[UniverKanbanPOC] start failed:', err)
  })

  univerDispose = () => {
    headerIconCleanup?.()
    patchQueue?.dispose()
    disposable.dispose()
    embed.dispose()
  }
})

onUnmounted(() => {
  univerDispose?.()
  univerDispose = null
  univerAPI = null
  startLoad = null
  overlay.value = null
})
</script>

<style scoped>
.univer-kanban {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 50px);
}

.univer-kanban__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid #e0e0e0;
  background: #fff;
}

.univer-kanban__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #1f2937;
}

.univer-kanban__subtitle {
  margin-top: 4px;
  font-size: 12px;
  color: #6b7280;
}

.univer-kanban__meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  font-size: 12px;
  color: #6b7280;
}

.univer-kanban__view-picker {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #4b5563;
}

.univer-kanban__select {
  height: 26px;
  border-radius: 6px;
  border: 1px solid rgba(0, 0, 0, 0.16);
  background: #fff;
  padding: 0 6px;
  font-size: 12px;
}

.univer-kanban__sheet-id {
  color: #4b5563;
}

.univer-kanban__view-summary {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: flex-end;
}

.univer-kanban__diagnostics {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  justify-content: flex-end;
  color: #92400e;
}

.univer-kanban__diagnostics-label {
  font-weight: 600;
}

.univer-kanban__diagnostics-chip {
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid rgba(234, 179, 8, 0.5);
  background: rgba(234, 179, 8, 0.15);
  color: #92400e;
  font-size: 11px;
}

.univer-kanban__view-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  background: #f8fafc;
  color: #374151;
  font-size: 11px;
}

.univer-kanban__view-chip--warn {
  border-color: rgba(255, 77, 79, 0.35);
  background: rgba(255, 77, 79, 0.08);
  color: #c2410c;
}

.univer-kanban__status {
  color: #1677ff;
}

.univer-kanban__status--error {
  color: #ff4d4f;
}

.univer-kanban__status-hint {
  font-size: 12px;
  color: #6b7280;
}

.univer-kanban__warning {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 10px;
  border-radius: 10px;
  border: 1px solid #ffd591;
  background: #fff7e6;
  color: #8c6d1f;
  font-size: 12px;
}

.univer-kanban__related {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid #ffd591;
  background: #fff7e6;
  color: #8c6d1f;
  font-size: 12px;
}

.univer-kanban__related-note {
  color: #6b7280;
}

.univer-kanban__hint {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  color: #8c6d1f;
}

.univer-kanban__hint-link {
  color: #1677ff;
  text-decoration: none;
}

.univer-kanban__hint-link:hover {
  text-decoration: underline;
}

.univer-kanban__hint-note {
  color: #6b7280;
}

.univer-kanban__readonly {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  color: #6b7280;
}

.univer-kanban__readonly-label {
  font-weight: 600;
  color: #8c6d1f;
}

.univer-kanban__readonly-item {
  border: 1px solid #ffe58f;
  background: #fffbe6;
  color: #8c6d1f;
  border-radius: 999px;
  padding: 2px 8px;
  cursor: pointer;
  display: inline-flex;
  gap: 6px;
  align-items: center;
}

.univer-kanban__readonly-item:hover {
  border-color: #ffd666;
}

.univer-kanban__readonly-name {
  font-weight: 600;
}

.univer-kanban__readonly-tag {
  font-size: 11px;
  color: #8c6d1f;
}

.univer-kanban__visibility {
  margin-top: 6px;
  border: 1px dashed #d1d5db;
  border-radius: 10px;
  padding: 6px 10px;
  background: #fafafa;
  font-size: 12px;
  color: #4b5563;
}

.univer-kanban__visibility-summary {
  cursor: pointer;
  font-weight: 600;
  color: #1f2937;
  display: flex;
  align-items: center;
  gap: 8px;
}

.univer-kanban__visibility-count {
  font-weight: 500;
  color: #8c6d1f;
}

.univer-kanban__visibility-list {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
}

.univer-kanban__visibility-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 6px;
  border-radius: 8px;
  background: #fff;
  border: 1px solid #e5e7eb;
}

.univer-kanban__visibility-name {
  font-weight: 500;
  color: #111827;
}

.univer-kanban__visibility-type {
  font-size: 11px;
  color: #6b7280;
}

.univer-kanban__visibility-status {
  margin-top: 6px;
  font-size: 11px;
  color: #6b7280;
}

.univer-kanban__body {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 380px;
  background: #f3f4f6;
  overflow: hidden;
}

.univer-kanban__body--with-comments {
  grid-template-columns: minmax(0, 1fr) 380px 280px;
}

.univer-kanban__grid {
  position: relative;
  background: #fff;
  min-height: 0;
}

.univer-kanban__grid-mount {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.univer-kanban__header-icons {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 15;
}

.univer-kanban__header-icon {
  position: absolute;
  width: 16px;
  height: 16px;
  border-radius: 999px;
  border: 1px solid #ffe58f;
  background: #fffbe6;
  color: #8c6d1f;
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
  cursor: help;
}

.univer-kanban__header-tooltip {
  position: absolute;
  z-index: 16;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(17, 17, 17, 0.88);
  color: #fff;
  font-size: 11px;
  line-height: 1.4;
  max-width: 220px;
  transform: translateX(-50%);
  pointer-events: none;
}

.univer-kanban__kanban {
  border-left: 1px solid rgba(0, 0, 0, 0.08);
  background: #f5f5f5;
  padding: 10px;
  overflow: auto;
  display: grid;
  gap: 10px;
}

.univer-kanban__comments {
  border-left: 1px solid #e5e7eb;
  background: #fafafa;
  min-height: 0;
  overflow: hidden;
}

.univer-kanban__column {
  background: rgba(255, 255, 255, 0.9);
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 10px;
  overflow: hidden;
}

.univer-kanban__column-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  background: #fff;
}

.univer-kanban__column-title {
  font-weight: 600;
  font-size: 13px;
  color: rgba(0, 0, 0, 0.78);
}

.univer-kanban__column-count {
  font-size: 12px;
  color: rgba(0, 0, 0, 0.45);
}

.univer-kanban__cards {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 44px;
}

.univer-kanban__card {
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 10px;
  padding: 10px;
  cursor: grab;
}

.univer-kanban__card:active {
  cursor: grabbing;
}

.univer-kanban__card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
}

.univer-kanban__card-title {
  font-size: 13px;
  font-weight: 600;
  color: rgba(0, 0, 0, 0.82);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.univer-kanban__card-delete {
  border: 0;
  border-radius: 8px;
  padding: 2px 6px;
  cursor: pointer;
  font-size: 12px;
  line-height: 16px;
  color: rgba(0, 0, 0, 0.65);
  background: rgba(0, 0, 0, 0.06);
}

.univer-kanban__card-delete:hover {
  background: rgba(0, 0, 0, 0.1);
}

.univer-kanban__card-meta {
  margin-top: 6px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: rgba(0, 0, 0, 0.55);
}

.univer-kanban__card-meta-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.univer-kanban__comment-badge {
  flex: 0 0 auto;
  border-radius: 999px;
  padding: 2px 6px;
  font-size: 11px;
  font-weight: 600;
  color: #0f766e;
  background: #ecfdf3;
  border: 1px solid #bbf7d0;
}

.univer-kanban__overlay {
  position: absolute;
  z-index: 20;
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px;
  background: rgba(255, 255, 255, 0.96);
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 8px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12);
  backdrop-filter: blur(6px);
}

.univer-kanban__link-actions {
  display: flex;
  justify-content: flex-end;
  width: 100%;
}

.univer-kanban__overlay--readonly {
  padding: 6px 10px;
  font-size: 12px;
  color: #8c6d1f;
  background: #fffbe6;
  border-color: #ffe58f;
  pointer-events: none;
}

.univer-kanban__overlay-empty {
  font-size: 12px;
  color: rgba(0, 0, 0, 0.6);
}

.univer-kanban__pill {
  border: 0;
  border-radius: 999px;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 12px;
  line-height: 16px;
  color: #fff;
}

.univer-kanban__link-input {
  width: 220px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid rgba(0, 0, 0, 0.18);
  outline: none;
}

.univer-kanban__btn {
  border: 0;
  border-radius: 8px;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 12px;
  color: #fff;
  background: #1677ff;
}

.univer-kanban__btn--danger {
  background: #ff4d4f;
}
</style>
