<template>
  <div class="univer-poc">
    <div class="univer-poc__header">
      <h2 class="univer-poc__title">Univer Grid POC</h2>
      <div class="univer-poc__subtitle">Vue 外壳嵌入验证（Phase 0.F1）</div>
      <div class="univer-poc__meta">
        <div>viewId: {{ viewId }}</div>
        <div v-if="activeSheetId && activeSheetId !== viewId" class="univer-poc__sheet-id">
          sheetId: {{ activeSheetId }}
        </div>
        <label v-if="sourceIsMeta" class="univer-poc__view-picker" for="univer-grid-view-select">
          <span>视图</span>
          <select
            id="univer-grid-view-select"
            name="selectedViewId"
            v-model="selectedViewId"
            class="univer-poc__select"
            @change="handleViewChange"
          >
            <option value="">(当前 Sheet)</option>
            <option v-for="view in availableViews" :key="view.id" :value="view.id">
              {{ view.name || view.id }} ({{ view.type }})
            </option>
          </select>
        </label>
        <div v-if="viewSummary" class="univer-poc__view-summary">
          <span class="univer-poc__view-chip">view: {{ viewSummary.name }} ({{ viewSummary.type }})</span>
          <span class="univer-poc__view-chip">id: {{ viewSummary.id }}</span>
          <span v-if="viewSummary.groupLabel" class="univer-poc__view-chip">group: {{ viewSummary.groupLabel }}</span>
          <span v-if="viewSummary.sortLabel" class="univer-poc__view-chip">sort: {{ viewSummary.sortLabel }}</span>
          <span v-if="viewSummary.filterLabel" class="univer-poc__view-chip">filter: {{ viewSummary.filterLabel }}</span>
          <span v-if="viewSummary.hiddenCount > 0" class="univer-poc__view-chip">hidden: {{ viewSummary.hiddenCount }}</span>
          <span
            v-if="viewSummary.computedFilterSort"
            class="univer-poc__view-chip univer-poc__view-chip--warn"
          >
            computed filter/sort
          </span>
        </div>
        <div v-if="diagnosticsItems.length" class="univer-poc__diagnostics">
          <span class="univer-poc__diagnostics-label">诊断</span>
          <span
            v-for="item in diagnosticsItems"
            :key="item.label"
            class="univer-poc__diagnostics-chip"
            :title="item.ids.join(', ')"
          >
            {{ item.label }} ({{ item.ids.length }})
          </span>
        </div>
        <div v-if="page">loaded: {{ loadedCount }}/{{ page.total }}</div>
        <button
          v-if="page && page.hasMore"
          type="button"
          class="univer-poc__meta-btn"
          :disabled="loadingMore"
          @click="loadMore"
        >
          {{ loadingMore ? '加载中...' : '加载更多' }}
        </button>
        <button type="button" class="univer-poc__meta-btn" @click="reloadView">重算</button>
        <button
          v-if="hasConflict"
          type="button"
          class="univer-poc__meta-btn univer-poc__meta-btn--danger"
          @click="reloadView"
        >
          重新加载
        </button>
        <span v-if="hasConflict && conflictServerVersion !== null" class="univer-poc__conflict">
          serverVersion {{ conflictServerVersion }}
        </span>
        <div v-if="statusText" :class="statusKind === 'error' ? 'univer-poc__status univer-poc__status--error' : 'univer-poc__status'">
          {{ statusText }}
        </div>
        <div v-if="statusHint && statusText.startsWith('Sheet not found:')" class="univer-poc__status-hint">
          {{ statusHint }}
        </div>
        <div v-if="viewWarnings.length" class="univer-poc__warning">
          <div v-for="(warning, idx) in viewWarnings" :key="idx">
            {{ warning }}
          </div>
        </div>
        <div v-if="relatedUpdateCount > 0" class="univer-poc__related">
          <span>外表更新 {{ relatedUpdateCount }} 条</span>
          <button type="button" class="univer-poc__meta-btn" @click="reloadView">点击刷新</button>
          <span v-if="relatedUpdateSheets.length" class="univer-poc__related-note">
            来源: {{ relatedUpdateSheets.join(', ') }}
          </span>
        </div>
        <div v-if="demoHint" class="univer-poc__hint">
          <span>{{ demoHint.text }}</span>
          <a :href="demoHint.href" class="univer-poc__hint-link">打开可编辑示例表</a>
          <span class="univer-poc__hint-note">{{ demoHint.note }}</span>
        </div>
        <div v-if="readonlyFields.length" class="univer-poc__readonly">
          <span class="univer-poc__readonly-label">只读字段</span>
          <button
            v-for="item in readonlyFields"
            :key="item.id"
            type="button"
            class="univer-poc__readonly-item"
            :title="item.reason"
            @click="focusReadonlyField(item.id)"
          >
            <span class="univer-poc__readonly-name">{{ item.label }}</span>
            <span class="univer-poc__readonly-tag">{{ item.tag }}</span>
          </button>
        </div>
        <details v-if="sourceIsMeta && fieldVisibilityOptions.length" class="univer-poc__visibility">
          <summary class="univer-poc__visibility-summary">
            字段可见性
            <span v-if="viewHiddenFieldIds.length" class="univer-poc__visibility-count">
              hidden {{ viewHiddenFieldIds.length }}
            </span>
          </summary>
          <div class="univer-poc__visibility-list">
            <label
              v-for="field in fieldVisibilityOptions"
              :key="field.id"
              class="univer-poc__visibility-item"
              :for="`univer-grid-field-visible-${field.id}`"
            >
              <input
                type="checkbox"
                :id="`univer-grid-field-visible-${field.id}`"
                :name="`fieldVisible-${field.id}`"
                :checked="!isFieldHidden(field.id)"
                :disabled="viewConfigSaving"
                @change="toggleFieldVisibility(field.id, $event)"
              />
              <span class="univer-poc__visibility-name">{{ field.name }}</span>
              <span class="univer-poc__visibility-type">{{ field.type }}</span>
            </label>
          </div>
          <div v-if="viewConfigStatus" class="univer-poc__visibility-status">{{ viewConfigStatus }}</div>
        </details>
      </div>
    </div>
    <div class="univer-poc__body" :class="{ 'univer-poc__body--with-comments': commentsEnabled }">
      <div
        ref="wrapperRef"
        class="univer-poc__container"
        :class="{ 'univer-poc__container--with-comments': commentsEnabled }"
      >
        <div ref="containerRef" class="univer-poc__mount" />

        <div v-if="readonlyHeaderIcons.length" class="univer-poc__header-icons">
          <div
            v-for="icon in readonlyHeaderIcons"
            :key="icon.fieldId"
            class="univer-poc__header-icon"
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
            class="univer-poc__header-tooltip"
            :style="{ left: `${headerTooltip.left}px`, top: `${headerTooltip.top}px` }"
          >
            {{ headerTooltip.text }}
          </div>
        </div>

        <div v-if="commentsEnabled && commentBadges.length" class="univer-poc__comment-badges">
          <div
            v-for="badge in commentBadges"
            :key="badge.recordId"
            class="univer-poc__comment-badge"
            :style="{ left: `${badge.left}px`, top: `${badge.top}px` }"
            :title="badge.title"
          >
            {{ badge.text }}
          </div>
        </div>

        <div
          v-if="overlay?.kind === 'select'"
          class="univer-poc__overlay"
          :style="{ left: `${overlay.left}px`, top: `${overlay.top}px` }"
          @mousedown.stop
        >
          <div v-if="overlay.options.length === 0" class="univer-poc__overlay-empty">No options</div>
          <button
            v-for="opt in overlay.options"
            :key="opt.value"
            type="button"
            class="univer-poc__pill"
            :style="{ background: opt.color || resolveFallbackSelectColor(opt.value) || '#1677ff' }"
            @click="applySelect(opt.value, opt.color)"
          >
            {{ opt.value }}
          </button>
        </div>

        <div
          v-if="overlay?.kind === 'link'"
          class="univer-poc__overlay univer-poc__overlay--link"
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
          <div class="univer-poc__link-actions">
            <button type="button" class="univer-poc__btn" @click="overlay = null">Cancel</button>
          </div>
        </div>

        <div
          v-if="overlay?.kind === 'readonly'"
          class="univer-poc__overlay univer-poc__overlay--readonly"
          :style="{ left: `${overlay.left}px`, top: `${overlay.top}px` }"
        >
          {{ overlay.message }}
        </div>
      </div>

      <CommentsPanel
        v-if="commentsEnabled"
        class="univer-poc__comments"
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
import { buildUniverSheetsLocales } from '../utils/univerLocales'
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
import LinkPicker, { type LinkChangePayload } from '../components/LinkPicker.vue'
import CommentsPanel from '../components/CommentsPanel.vue'

const wrapperRef = ref<HTMLDivElement | null>(null)
const containerRef = ref<HTMLDivElement | null>(null)
const viewId = ref<string>('')
const activeSheetId = ref<string>('')
const statusText = ref<string>('')
const statusKind = ref<'ok' | 'error'>('ok')
const statusHint = ref<string>('')
const viewWarnings = ref<string[]>([])
const viewSummary = ref<ViewSummary | null>(null)
const diagnosticsItems = ref<DiagnosticsItem[]>([])
const availableViews = ref<Array<{ id: string; name: string; type: string }>>([])
const selectedViewId = ref<string>('')
const page = ref<UniverMockView['page'] | null>(null)
const loadedCount = ref<number>(0)
const baseOffset = ref<number>(0)
const loadingMore = ref<boolean>(false)
const hasConflict = ref<boolean>(false)
const conflictServerVersion = ref<number | null>(null)
const readonlyFields = ref<ReadonlyFieldEntry[]>([])
const viewConfigId = ref<string>('')
const viewHiddenFieldIds = ref<string[]>([])
const stableHiddenFieldIds = ref<string[]>([])
const viewFields = ref<UniverMockField[]>([])
const viewConfigStatus = ref<string>('')
const viewConfigSaving = ref<boolean>(false)
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
const commentBadges = ref<Array<{ recordId: string; left: number; top: number; text: string; title: string }>>([])
let commentSummaryTimer = 0
let viewConfigTimer = 0

const route = useRoute()
const router = useRouter()
const EDITABLE_DEMO_ID = 'editable_demo'

const demoHint = computed(() => {
  const source = toStr(route.query.source)?.toLowerCase()
  const sheetId = toStr(route.query.sheetId)
  if (source !== 'meta' || sheetId !== 'lookup_source_demo') return null
  return {
    text: '此表包含 lookup/rollup/只读字段，仅用于验证。',
    href: `/univer?source=meta&sheetId=${EDITABLE_DEMO_ID}`,
    note: '如需可编辑示例，运行 scripts/setup-editable-demo.sh',
  }
})

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

const overlay = ref<OverlayState | null>(null)
const linkDraft = ref<string[]>([])

let univerAPI: FUniver | null = null
let univerDispose: (() => void) | null = null
let patchQueue: UniverPatchQueue | null = null
let startLoad: (() => Promise<void>) | null = null

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
  id?: string
  sheetId?: string
  name?: string
  type?: string
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

type UniverMetaViewsResponse = {
  ok: boolean
  data?: { views: Array<{ id: string; name: string; type: string }> }
  error?: { code: string; message: string }
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

let suppressChanges = false
let sheetRowCount = 0
let headerIconRaf = 0
let headerIconCleanup: (() => void) | null = null
let commentBadgeRaf = 0

function createDemoWorkbook(): IWorkbookData {
  const sheetId = 'sheet-1'
  return {
    id: 'workbook-1',
    name: 'MetaSheet Univer POC',
    appVersion: '0.12.4',
    locale: LocaleType.ZH_CN,
    styles: {},
    sheetOrder: [sheetId],
    sheets: {
      [sheetId]: {
        id: sheetId,
        name: 'Sheet1',
        rowCount: 50,
        columnCount: 10,
        cellData: {
          0: {
            0: { v: 'Hello' },
            1: { v: 1 },
            2: { v: 2 },
            3: { f: '=SUM(B1,C1)' },
          },
        },
      },
    },
  }
}

function toStr(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function queueCommentSummaryRefresh(recordIds?: string[]) {
  if (commentSummaryTimer) window.clearTimeout(commentSummaryTimer)
  commentSummaryTimer = window.setTimeout(() => {
    commentSummaryTimer = 0
    fetchCommentSummary(recordIds).catch((err) => {
      console.error('[UniverGridPOC] load comment summary failed:', err)
    })
  }, 200)
}

async function fetchCommentSummary(recordIds?: string[]) {
  if (!commentsEnabled.value || !commentsSpreadsheetId.value) {
    commentSummary.value = {}
    commentBadges.value = []
    return
  }

  const ids = recordIds && recordIds.length > 0 ? recordIds : mapping.rowIndexToRecordId.filter(Boolean)
  if (ids.length === 0) {
    commentSummary.value = {}
    commentBadges.value = []
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
  requestCommentBadgeUpdate()
}

function requestCommentBadgeUpdate() {
  if (commentBadgeRaf) window.cancelAnimationFrame(commentBadgeRaf)
  commentBadgeRaf = window.requestAnimationFrame(() => {
    commentBadgeRaf = 0
    updateCommentBadges()
  })
}

function updateCommentBadges() {
  const sheet = univerAPI?.getActiveWorkbook?.()?.getActiveSheet?.()
  const wrapperEl = wrapperRef.value
  if (!sheet || !wrapperEl || !commentsEnabled.value) {
    commentBadges.value = []
    return
  }

  const wrapperRect = wrapperEl.getBoundingClientRect()
  const badges: Array<{ recordId: string; left: number; top: number; text: string; title: string }> = []
  for (let rowIndex = 0; rowIndex < mapping.rowIndexToRecordId.length; rowIndex += 1) {
    const recordId = mapping.rowIndexToRecordId[rowIndex]
    if (!recordId) continue
    const summary = commentSummary.value[recordId]
    if (!summary || summary.total <= 0) continue

    let rect: DOMRect | undefined
    try {
      const range = sheet.getRange(rowIndex, 0) as any
      rect = range?.getCellRect?.()
    } catch {
      rect = undefined
    }
    if (!rect || rect.width < 6 || rect.height < 6) continue

    const text = summary.open > 0 ? `${summary.open}/${summary.total}` : `${summary.total}`
    const title =
      summary.open > 0 ? `${summary.open} 未解决 / ${summary.total} 总计` : `${summary.total} 评论`
    const left = rect.left - wrapperRect.left + rect.width - 28
    const top = rect.top - wrapperRect.top + 4
    badges.push({
      recordId,
      left: Math.max(4, left),
      top: Math.max(2, top),
      text,
      title,
    })
  }
  commentBadges.value = badges
}

watch(
  () => [commentsEnabled.value, commentsSpreadsheetId.value],
  () => {
    queueCommentSummaryRefresh()
  },
  { immediate: true }
)

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
  const query = { ...route.query }
  if (nextViewId) {
    query.viewId = nextViewId
    delete query.sheetId
  } else {
    delete query.viewId
  }
  router.replace({ query }).catch(() => null)
  reloadView()
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

function isFieldHidden(fieldId: string): boolean {
  return viewHiddenFieldIds.value.includes(fieldId)
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
  viewHiddenFieldIds.value = nextHiddenIds
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
    void persistHiddenFieldIds(viewHiddenFieldIds.value)
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
  const next = new Set(viewHiddenFieldIds.value)
  if (checked) {
    next.delete(fieldId)
  } else {
    next.add(fieldId)
  }
  setHiddenFieldIds(Array.from(next))
}

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

function handleCommentUpdated(payload: { rowId: string }) {
  if (!payload?.rowId) return
  queueCommentSummaryRefresh([payload.rowId])
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
  const wrapperEl = wrapperRef.value
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
  const wrapperEl = wrapperRef.value
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
    if (typeof raw === 'number' || typeof raw === 'string' || typeof raw === 'boolean') {
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
  const raw = mapping.recordIdToData[recordId]?.[fieldId]
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

function applyComputedRecords(records: Array<{ recordId: string; data: Record<string, unknown> }>) {
  if (!records.length) return
  const sheet = univerAPI?.getActiveWorkbook?.()?.getActiveSheet?.()
  if (!sheet) return

  try {
    suppressChanges = true
    for (const record of records) {
      const rowIndex = mapping.recordIdToRowIndex[record.recordId]
      if (typeof rowIndex !== 'number' || !Number.isFinite(rowIndex)) continue

      const existing = mapping.recordIdToData[record.recordId] ?? {}
      mapping.recordIdToData[record.recordId] = { ...existing, ...record.data }

      for (const [fieldId, value] of Object.entries(record.data)) {
        const fieldType = mapping.fieldIdToType[fieldId]
        if (fieldType !== 'lookup' && fieldType !== 'rollup') continue
        const colIndex = mapping.fieldIdToColIndex[fieldId]
        if (typeof colIndex !== 'number' || !Number.isFinite(colIndex)) continue

        const baseCell = buildCellValue(fieldType, value) ?? { v: '' }
        const reason = getReadonlyReason(fieldId)
        const cell = reason ? applyReadonlyStyle(baseCell as any, reason) : baseCell
        sheet.getRange(rowIndex, colIndex).setValueForCell(cell as any)
      }
    }
  } finally {
    suppressChanges = false
  }
}

function mergeRelatedUpdates(
  existing: RelatedRecord[],
  incoming: RelatedRecord[],
): RelatedRecord[] {
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

async function reloadView() {
  relatedUpdates.value = []
  hasConflict.value = false
  conflictServerVersion.value = null
  await loadView()
}

async function loadView() {
  if (!univerAPI || !startLoad) return
  statusText.value = 'Reloading...'
  statusKind.value = 'ok'
  await startLoad()
}

function transformToWorkbook(view: UniverMockView): {
  workbook: IWorkbookData
  mapping: {
    rowIndexToRecordId: string[]
    colIndexToFieldId: string[]
    recordIdToVersion: Record<string, number>
    recordIdToRowIndex: Record<string, number>
    recordIdToData: Record<string, Record<string, unknown>>
    fieldIdToColIndex: Record<string, number>
    fieldIdToType: Record<string, UniverMockField['type']>
    fieldIdToReadonlyReason: Record<string, string>
    fieldIdToLabel: Record<string, string>
  }
} {
  const sheetId = view.id
  const rowIndexToRecordId = view.rows.map((r) => r.id)
  const colIndexToFieldId = view.fields.map((f) => f.id)

  const recordIdToVersion = Object.fromEntries(view.rows.map((r) => [r.id, r.version]))
  const recordIdToRowIndex = Object.fromEntries(rowIndexToRecordId.map((id, idx) => [id, idx]))
  const recordIdToData = Object.fromEntries(view.rows.map((r) => [r.id, { ...r.data }]))
  const fieldIdToColIndex = Object.fromEntries(colIndexToFieldId.map((id, idx) => [id, idx]))
  const fieldIdToType = Object.fromEntries(view.fields.map((f) => [f.id, f.type]))
  const fieldIdToReadonlyReason: Record<string, string> = {}
  const fieldIdToLabel: Record<string, string> = {}
  view.fields.forEach((field) => {
    const label = field.name?.trim() || String(field.id)
    fieldIdToLabel[field.id] = label
    const reason = resolveReadonlyReason(field)
    if (reason) fieldIdToReadonlyReason[field.id] = reason
  })

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
  const workbook: IWorkbookData = {
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

  return {
    workbook,
    mapping: {
      rowIndexToRecordId,
      colIndexToFieldId,
      recordIdToVersion,
      recordIdToRowIndex,
      recordIdToData,
      fieldIdToColIndex,
      fieldIdToType,
      fieldIdToReadonlyReason,
      fieldIdToLabel,
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
    console.error('[UniverGridPOC] applySelect failed:', err)
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
    // Display text shows names, but internal value stores IDs
    const displayText = displays.filter(Boolean).join(', ')
    // Build cell with display text but mark the underlying data as IDs for patch
    const cell = buildLinkCell(displayText)
    // Store IDs in cell custom field for patch queue to extract
    ;(cell as any).__linkIds = ids
    sheet.getRange(current.row, current.col).setValueForCell(cell as any)
  } catch (err) {
    console.error('[UniverGridPOC] applyLink failed:', err)
  }
  overlay.value = null
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
    if (rows.length === 0) {
      page.value = {
        ...currentPage,
        offset: windowing.enabled ? baseOffset.value : currentPage.offset,
        hasMore: false,
      }
      statusText.value = 'No more rows'
      statusKind.value = 'ok'
      return
    }

    const startRow = mapping.rowIndexToRecordId.length
    const total = response.data.page?.total ?? currentPage.total
    const nextRowCount = resolveWindowRowCount(total, startRow + rows.length, windowing)

    suppressChanges = true
    if (sheetRowCount < nextRowCount) {
      sheet.setRowCount(nextRowCount)
      sheetRowCount = nextRowCount
    }

    for (let i = 0; i < rows.length; i += 1) {
      const record = rows[i]
      const rowIndex = startRow + i
      mapping.rowIndexToRecordId[rowIndex] = record.id
      mapping.recordIdToVersion[record.id] = record.version
      mapping.recordIdToRowIndex[record.id] = rowIndex
      mapping.recordIdToData[record.id] = { ...record.data }

      for (let colIndex = 0; colIndex < response.data.fields.length; colIndex += 1) {
        const field = response.data.fields[colIndex]
        const raw = (record.data[field.id] ?? record.data[field.name]) as unknown
        const cell = buildCellForField(field, raw)
        if (cell) sheet.getRange(rowIndex, colIndex).setValueForCell(cell as any)
      }
    }

    loadedCount.value += rows.length
    if (windowing.enabled && windowing.max > 0 && loadedCount.value > windowing.max) {
      const evictCount = loadedCount.value - windowing.max
      if (evictCount > 0) {
        patchQueue?.flushNow()
        const evictedIds = mapping.rowIndexToRecordId.splice(0, evictCount)
        for (const recordId of evictedIds) {
          if (!recordId) continue
          delete mapping.recordIdToRowIndex[recordId]
          delete mapping.recordIdToData[recordId]
          delete mapping.recordIdToVersion[recordId]
        }
        for (let i = 0; i < mapping.rowIndexToRecordId.length; i += 1) {
          const rid = mapping.rowIndexToRecordId[i]
          if (rid) mapping.recordIdToRowIndex[rid] = i
        }
        try {
          sheet.deleteRows(0, evictCount)
        } catch (err) {
          console.error('[UniverGridPOC] deleteRows failed:', err)
        }
        baseOffset.value += evictCount
        loadedCount.value = mapping.rowIndexToRecordId.length
        const windowRowCount = resolveWindowRowCount(total, loadedCount.value, windowing)
        sheet.setRowCount(windowRowCount)
        sheetRowCount = windowRowCount
      }
    }
    page.value = {
      ...currentPage,
      offset: windowing.enabled ? baseOffset.value : currentPage.offset,
      total,
      hasMore: baseOffset.value + loadedCount.value < total,
    }
    queueCommentSummaryRefresh()
    requestCommentBadgeUpdate()
    try {
      ;(window as any).__pocRecordIds = mapping.rowIndexToRecordId.slice()
    } catch {
      // ignore
    }

    statusText.value = `Loaded +${rows.length}`
    statusKind.value = 'ok'
  } catch (err) {
    console.error('[UniverGridPOC] loadMore failed:', err)
    statusText.value = 'Load more failed'
    statusKind.value = 'error'
  } finally {
    suppressChanges = false
    loadingMore.value = false
    requestReadonlyHeaderUpdate()
  }
}

onMounted(() => {
  const hostEl = containerRef.value
  if (!hostEl) return

  const embed = createUniverEmbed(
    hostEl,
    (mountEl) =>
      createUniver({
        theme: defaultTheme,
        locale: LocaleType.ZH_CN,
        locales: buildUniverSheetsLocales(),
        presets: [UniverSheetsCorePreset({ container: mountEl })],
      }),
    { exposeToWindow: true },
  )

  univerAPI = embed.univerAPI

  const handleScroll = () => {
    requestReadonlyHeaderUpdate()
    requestCommentBadgeUpdate()
  }
  wrapperRef.value?.addEventListener('scroll', handleScroll, true)
  window.addEventListener('resize', handleScroll)
  headerIconCleanup = () => {
    wrapperRef.value?.removeEventListener('scroll', handleScroll, true)
    window.removeEventListener('resize', handleScroll)
    if (headerIconRaf) window.cancelAnimationFrame(headerIconRaf)
    headerIconRaf = 0
    if (commentBadgeRaf) window.cancelAnimationFrame(commentBadgeRaf)
    commentBadgeRaf = 0
  }

  patchQueue = createUniverPatchQueue({
    getViewId: () => viewId.value,
    getApiPrefix,
    mapping,
    setStatus: (text, kind) => {
      statusText.value = text
      statusKind.value = kind
    },
    onRecords: applyComputedRecords,
    onRelatedRecords: handleRelatedRecords,
    onConflict: (serverVersion) => {
      hasConflict.value = true
      conflictServerVersion.value = serverVersion
      statusText.value = 'Version conflict'
      statusKind.value = 'error'
    },
    flushDelayMs: 120,
  })

  const disposable = univerAPI.addEvent(univerAPI.Event.CommandExecuted, (event) => {
    if (event.id === SetSelectionsOperation.id) {
      const selections = (event.params as { selections?: Array<{ primary?: { actualRow?: number; actualColumn?: number } | null }> })
        ?.selections
      const primary = selections?.find(s => s?.primary)?.primary
      const row = primary?.actualRow
      const col = primary?.actualColumn
      if (typeof row !== 'number' || typeof col !== 'number') {
        overlay.value = null
        selectedRecordId.value = ''
        selectedFieldId.value = undefined
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

      const wrapperEl = wrapperRef.value
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

      // Get field property for foreignSheetId and limitSingleRecord
      const fieldProp = mapping.fieldIdToProperty[fieldId] ?? {}
      const foreignSheetId = fieldProp.foreignDatasheetId ?? fieldProp.foreignSheetId ?? ''
      const multiple = fieldProp.limitSingleRecord !== true
      const displayFieldId = fieldProp.displayFieldId ?? undefined

      overlay.value = {
        kind: 'link',
        row,
        col,
        left,
        top,
        fieldId,
        foreignSheetId,
        displayFieldId,
        multiple,
      }
      try {
        // Parse current value as array of IDs (prefer __linkIds if present)
        const current = sheet.getRange(row, col).getCellData?.() as { v?: unknown; __linkIds?: unknown } | undefined
        const rawIds = Array.isArray(current?.__linkIds) ? current?.__linkIds : undefined
        const val = rawIds ?? current?.v
        if (Array.isArray(val)) {
          linkDraft.value = val.filter((v): v is string => typeof v === 'string')
        } else if (typeof val === 'string' && val.trim()) {
          // Try to parse as JSON array or comma-separated
          try {
            const parsed = JSON.parse(val)
            linkDraft.value = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [val]
          } catch {
            linkDraft.value = val.includes(',') ? val.split(',').map(s => s.trim()).filter(Boolean) : [val]
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
      hasConflict.value = false
      conflictServerVersion.value = null
      const qs = getQueryString()
      const response = await apiGet<UniverMockViewResponse>(`${getApiPrefix()}/view${qs}`)
      if (!response.ok || !response.data) {
        throw new Error(response.error?.message ?? 'failed to load view')
      }
      activeSheetId.value = response.data.id
      viewSummary.value = buildViewSummary(response.data)
      viewId.value = response.data.id
      selectedViewId.value = toStr(route.query.viewId) ?? ''
      viewWarnings.value = Array.isArray(response.data.meta?.warnings) ? response.data.meta!.warnings!.slice() : []
      diagnosticsItems.value = buildDiagnostics(response.data)
      const source = toStr(route.query.source)?.toLowerCase()
      const windowing = resolveWindowing()
      const viewRows =
        windowing.enabled && source !== 'meta'
          ? response.data.rows.slice(0, windowing.size)
          : response.data.rows
      const viewData = { ...response.data, rows: viewRows }
      const transformed = transformToWorkbook(viewData)
      Object.assign(mapping, transformed.mapping)
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
      const hiddenFieldIds = Array.isArray(response.data.view?.hiddenFieldIds)
        ? response.data.view!.hiddenFieldIds!.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length > 0)
        : []
      viewHiddenFieldIds.value = hiddenFieldIds
      stableHiddenFieldIds.value = hiddenFieldIds.slice()
      univerAPI!.createWorkbook(transformed.workbook)
      requestReadonlyHeaderUpdate()
      queueCommentSummaryRefresh()
      requestCommentBadgeUpdate()
      const sheet = univerAPI?.getActiveWorkbook?.()?.getActiveSheet?.()
      if (sheet && hiddenFieldIds.length > 0) {
        for (const fieldId of hiddenFieldIds) {
          const colIndex = mapping.fieldIdToColIndex[fieldId]
          if (typeof colIndex !== 'number' || !Number.isFinite(colIndex)) continue
          try {
            sheet.hideColumns(colIndex, 1)
          } catch {
            // ignore
          }
        }
      }
      try {
        ;(window as any).__pocHiddenFieldIds = hiddenFieldIds
        ;(window as any).__pocHiddenCols = sheet?.getSheet?.().getHiddenCols?.() ?? []
        ;(window as any).__pocRecordIds = mapping.rowIndexToRecordId.slice()
      } catch {
        // ignore
      }
      sheetRowCount = transformed.workbook.sheets?.[response.data.id]?.rowCount ?? 0
      page.value = response.data.page ?? null
      loadedCount.value = transformed.mapping.rowIndexToRecordId.length
      baseOffset.value = response.data.page?.offset ?? 0
      if (page.value) {
        page.value = {
          ...page.value,
          offset: windowing.enabled ? baseOffset.value : page.value.offset,
          hasMore: baseOffset.value + loadedCount.value < page.value.total,
        }
      }
      statusText.value = 'Loaded'
      statusKind.value = 'ok'
      statusHint.value = ''
    } catch (err) {
      console.error('[UniverGridPOC] load view failed, fallback to demo:', err)
      viewId.value = 'demo'
      activeSheetId.value = ''
      viewSummary.value = null
      diagnosticsItems.value = []
      univerAPI!.createWorkbook(createDemoWorkbook())
      requestReadonlyHeaderUpdate()
      commentSummary.value = {}
      commentBadges.value = []
      page.value = null
      loadedCount.value = 0
      baseOffset.value = 0
      viewWarnings.value = []
      viewFields.value = []
      viewConfigId.value = ''
      viewHiddenFieldIds.value = []
      stableHiddenFieldIds.value = []
      const hint = buildMissingSheetHint(err)
      if (hint) {
        statusText.value = hint.title
        statusHint.value = hint.hint
      } else {
        statusText.value = 'Loaded demo workbook (backend unavailable)'
        statusHint.value = ''
      }
      statusKind.value = 'error'
    }
  }

  startLoad = async () => {
    await start()
  }

  startLoad().catch((err) => {
    console.error('[UniverGridPOC] start failed:', err)
  })

  univerDispose = () => {
    headerIconCleanup?.()
    if (commentSummaryTimer) window.clearTimeout(commentSummaryTimer)
    commentSummaryTimer = 0
    commentBadges.value = []
    commentSummary.value = {}
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
.univer-poc {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 50px);
}

.univer-poc__header {
  flex: 0 0 auto;
  padding: 12px 16px;
  border-bottom: 1px solid #e0e0e0;
  background: #fff;
}

.univer-poc__body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  overflow: hidden;
  background: #f8fafc;
}

.univer-poc__body--with-comments {
  background: #f3f4f6;
}

.univer-poc__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #1f2937;
}

.univer-poc__subtitle {
  margin-top: 4px;
  font-size: 12px;
  color: #6b7280;
}

.univer-poc__meta {
  margin-top: 6px;
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
  color: #6b7280;
}

.univer-poc__sheet-id {
  color: #4b5563;
}

.univer-poc__view-summary {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
}

.univer-poc__diagnostics {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #92400e;
}

.univer-poc__diagnostics-label {
  font-weight: 600;
}

.univer-poc__diagnostics-chip {
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid rgba(234, 179, 8, 0.5);
  background: rgba(234, 179, 8, 0.15);
  color: #92400e;
  font-size: 11px;
}

.univer-poc__view-chip {
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

.univer-poc__view-chip--warn {
  border-color: rgba(255, 77, 79, 0.35);
  background: rgba(255, 77, 79, 0.08);
  color: #c2410c;
}

.univer-poc__status {
  color: #1677ff;
}

.univer-poc__status--error {
  color: #ff4d4f;
}

.univer-poc__status-hint {
  font-size: 12px;
  color: #6b7280;
}

.univer-poc__warning {
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

.univer-poc__related {
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

.univer-poc__related-note {
  color: #6b7280;
}

.univer-poc__hint {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  color: #8c6d1f;
}

.univer-poc__hint-link {
  color: #1677ff;
  text-decoration: none;
}

.univer-poc__hint-link:hover {
  text-decoration: underline;
}

.univer-poc__hint-note {
  color: #6b7280;
}

.univer-poc__readonly {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  color: #6b7280;
}

.univer-poc__readonly-label {
  font-weight: 600;
  color: #8c6d1f;
}

.univer-poc__readonly-item {
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

.univer-poc__readonly-item:hover {
  border-color: #ffd666;
}

.univer-poc__readonly-name {
  font-weight: 600;
}

.univer-poc__readonly-tag {
  font-size: 11px;
  color: #8c6d1f;
}

.univer-poc__visibility {
  margin-top: 6px;
  border: 1px dashed #d1d5db;
  border-radius: 10px;
  padding: 6px 10px;
  background: #fafafa;
  font-size: 12px;
  color: #4b5563;
}

.univer-poc__visibility-summary {
  cursor: pointer;
  font-weight: 600;
  color: #1f2937;
  display: flex;
  align-items: center;
  gap: 8px;
}

.univer-poc__visibility-count {
  font-weight: 500;
  color: #8c6d1f;
}

.univer-poc__visibility-list {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
}

.univer-poc__visibility-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 6px;
  border-radius: 8px;
  background: #fff;
  border: 1px solid #e5e7eb;
}

.univer-poc__visibility-name {
  font-weight: 500;
  color: #111827;
}

.univer-poc__visibility-type {
  font-size: 11px;
  color: #6b7280;
}

.univer-poc__visibility-status {
  margin-top: 6px;
  font-size: 11px;
  color: #6b7280;
}

.univer-poc__meta-btn {
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: #fff;
  color: #1677ff;
  padding: 4px 10px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 12px;
  line-height: 18px;
}

.univer-poc__meta-btn--danger {
  border-color: #ffccc7;
  background: #fff1f0;
  color: #cf1322;
}

.univer-poc__meta-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.univer-poc__conflict {
  font-size: 12px;
  color: #cf1322;
}

.univer-poc__container {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  background: #fff;
  position: relative;
  overflow: hidden;
}

.univer-poc__container--with-comments {
  border-right: 1px solid #e5e7eb;
}

.univer-poc__comments {
  flex: 0 0 280px;
  max-width: 320px;
}

.univer-poc__mount {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.univer-poc__header-icons {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 15;
}

.univer-poc__header-icon {
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

.univer-poc__header-tooltip {
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

.univer-poc__comment-badges {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 16;
}

.univer-poc__comment-badge {
  position: absolute;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  color: #0f766e;
  background: #ecfdf3;
  border: 1px solid #bbf7d0;
  white-space: nowrap;
}

.univer-poc__overlay {
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

.univer-poc__overlay-empty {
  font-size: 12px;
  color: rgba(0, 0, 0, 0.6);
}

.univer-poc__pill {
  border: 0;
  border-radius: 999px;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 12px;
  line-height: 16px;
  color: #fff;
}

.univer-poc__overlay--link {
  min-width: 300px;
  max-width: 400px;
}

.univer-poc__overlay--readonly {
  padding: 6px 10px;
  font-size: 12px;
  color: #8c6d1f;
  background: #fffbe6;
  border-color: #ffe58f;
  pointer-events: none;
}

.univer-poc__link-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}

.univer-poc__link-input {
  width: 260px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid rgba(0, 0, 0, 0.18);
  outline: none;
}

.univer-poc__btn {
  border: 0;
  border-radius: 8px;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 12px;
  color: #fff;
  background: #1677ff;
}
</style>
