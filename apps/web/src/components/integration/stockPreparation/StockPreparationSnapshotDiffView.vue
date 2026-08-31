<template>
  <div class="sp-snap" data-testid="stock-prep-snapshot-diff-view">
    <!-- No project selected: this slice has no project picker, so we simply ask for one. -->
    <p
      v-if="!hasProject"
      class="sp-snap__state sp-snap__state--muted"
      data-testid="stock-prep-snapshot-no-project"
      role="status"
    >
      {{ bi('请选择一个项目,这里会列出它历次同步存下的数据。', 'Select a project and this page lists each copy stored by its syncs.') }}
    </p>

    <!-- Loading: values-free spinner copy only. -->
    <p
      v-else-if="loading"
      class="sp-snap__state sp-snap__state--muted"
      data-testid="stock-prep-snapshot-loading"
      role="status"
    >
      {{ bi('正在加载快照批次…', 'Loading snapshot batches…') }}
    </p>

    <!-- Error / endpoint-not-ready (GET rejects or 404s): neutral, non-alarming, never the raw body. -->
    <div
      v-else-if="errored"
      class="sp-snap__state sp-snap__state--muted"
      data-testid="stock-prep-snapshot-error"
      role="status"
    >
      <p class="sp-snap__state-msg">{{ bi('同步后端尚未就绪,稍后再试。', 'Backend read not ready yet — try again later.') }}</p>
      <!-- H4-3 retry: re-runs the same readonly batch-list load(); idempotent, no new endpoint. -->
      <button
        ref="batchRetryEl"
        type="button"
        class="sp-snap__retry"
        data-testid="stock-prep-snapshot-retry"
        :disabled="loading"
        :aria-label="bi('重试读取快照批次', 'Retry loading snapshot batches')"
        @click="onBatchRetry"
      >
        {{ bi('重试', 'Retry') }}
      </button>
    </div>

    <!-- Empty: the project exists but has produced no immutable snapshot batches yet. -->
    <p
      v-else-if="isEmpty"
      class="sp-snap__state sp-snap__state--muted"
      data-testid="stock-prep-snapshot-empty"
    >
      {{ bi('这个项目还没同步过 —— 先同步一次,这里就会有记录。', 'This project has never synced — run one and a copy will appear here.') }}
    </p>

    <!-- Data: values-free batches table + a diff-summary panel for the selected batch. -->
    <div v-else-if="result" class="sp-snap__overview" data-testid="stock-prep-snapshot-overview">
      <header class="sp-snap__summary" data-testid="stock-prep-snapshot-summary">
        <span class="sp-snap__summary-count">
          {{ bi('快照批次', 'Snapshot batches') }}: {{ result.batchCount }}
        </span>
      </header>

      <!-- H4-3 keyboard: this wrap is the scroll container (both axes). Most rows carry a "View diff"
           button, but an incomplete batch's entry is DISABLED (removed from tab order) — if every
           batch happened to be incomplete the row content alone would give a keyboard operator no way
           to reach this scroll area, so the wrap itself is ALSO a native scroll-region. -->
      <div
        class="sp-snap__table-wrap"
        tabindex="0"
        role="region"
        :aria-label="bi('快照批次表格,可滚动', 'Snapshot batches table, scrollable')"
      >
        <table class="sp-snap__table">
          <thead>
            <tr>
              <th scope="col">{{ bi('第几次同步', 'Which sync') }}</th>
              <th scope="col">{{ bi('这一份还在用吗', 'Still the current one') }}</th>
              <th scope="col">{{ bi('这一份有多少行', 'Rows in this copy') }}</th>
              <th scope="col">{{ bi('哪次同步存的', 'Which run stored it') }}</th>
              <th scope="col">{{ bi('存下时间', 'Time recorded') }}</th>
              <th scope="col" class="sp-snap__col-action">{{ bi('和上一份比', 'Compare with the previous') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="batch in result.batches"
              :key="batch.snapshotBatchId"
              class="sp-snap__row"
              :class="{ 'sp-snap__row--selected': batch.snapshotBatchId === selectedBatchId }"
              data-testid="stock-prep-snapshot-batch-row"
            >
              <td class="sp-snap__num">{{ batch.snapshotVersion }}</td>
              <td>
                <span class="sp-snap__status" data-testid="stock-prep-snapshot-status-chip">
                  {{ batch.snapshotStatus }}
                </span>
                <!-- Values-free completeness flag (#4002): boolean only — a batch whose persist path
                     did not finish (zero lines or missing run row) is explicitly marked. -->
                <span
                  v-if="batch.incomplete"
                  class="sp-snap__incomplete"
                  data-testid="stock-prep-snapshot-incomplete-badge"
                >
                  {{ bi('不完整(这次没存全)', 'incomplete — this one did not finish saving') }}
                </span>
              </td>
              <td class="sp-snap__num">{{ batch.lineCount }}</td>
              <td>
                <code class="sp-snap__handle" data-testid="stock-prep-snapshot-run-handle">{{
                  batch.syncRunId ?? '—'
                }}</code>
              </td>
              <td>
                <span class="sp-snap__recorded" data-testid="stock-prep-snapshot-recorded">
                  {{ batch.createdAtPresent ? bi('已记录', 'recorded') : '—' }}
                </span>
              </td>
              <td class="sp-snap__col-action">
                <!-- Incomplete batches keep their diff entry visible but disabled: a diff against a
                     half-persisted batch would be misleading (lighter than hiding the column). -->
                <button
                  type="button"
                  class="sp-snap__select"
                  data-testid="stock-prep-snapshot-batch-select"
                  :disabled="batch.incomplete"
                  :title="
                    batch.incomplete
                      ? bi('这一份没存全,拿它作比较会得出错的结论,所以不能比。', 'This copy did not finish saving; comparing against it would give a wrong answer, so it is not offered.')
                      : undefined
                  "
                  @click="selectBatch(batch)"
                >
                  {{ bi('看改了什么', 'See what changed') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Diff-summary panel for the selected batch. -->
      <div class="sp-snap__diff-wrap">
        <!-- Default: nothing selected yet. -->
        <p
          v-if="!selectedBatchId"
          class="sp-snap__state sp-snap__state--muted"
          data-testid="stock-prep-snapshot-diff-hint"
        >
          {{ bi('上面选一份,这里会显示它和上一份比改了什么。', 'Pick one above and this shows what changed since the previous copy.') }}
        </p>

        <!-- Diff loading. -->
        <p
          v-else-if="diffLoading"
          class="sp-snap__state sp-snap__state--muted"
          data-testid="stock-prep-diff-loading"
          role="status"
        >
          {{ bi('正在加载差异…', 'Loading diff…') }}
        </p>

        <!-- Diff error / endpoint-not-ready: neutral copy, never the raw body. -->
        <div
          v-else-if="diffErrored"
          class="sp-snap__state sp-snap__state--muted"
          data-testid="stock-prep-diff-error"
          role="status"
        >
          <p class="sp-snap__state-msg">{{ bi('同步后端尚未就绪,稍后再试。', 'Backend read not ready yet — try again later.') }}</p>
          <!-- H4-3 retry: re-fetches the diff summary for the SAME selected batch (no re-selection). -->
          <button
            ref="diffRetryEl"
            type="button"
            class="sp-snap__retry"
            data-testid="stock-prep-diff-retry"
            :disabled="diffLoading"
            :aria-label="bi('重试读取差异', 'Retry loading the diff')"
            @click="onDiffRetry"
          >
            {{ bi('重试', 'Retry') }}
          </button>
        </div>

        <!-- Diff data: values-free per-kind change counts + blocking-exception count + base handle. -->
        <div v-else-if="diff" class="sp-snap__diff" data-testid="stock-prep-snapshot-diff">
          <header class="sp-snap__diff-head">
            <span class="sp-snap__diff-base" data-testid="stock-prep-snapshot-diff-base">
              {{ bi('拿来作比较的那一份', 'Compared against') }}
              <code v-if="diff.baseSnapshotBatchId" class="sp-snap__handle">{{
                diff.baseSnapshotBatchId
              }}</code>
              <span v-else>{{ bi('无前序批次(这是第一次同步,没得比)', 'no predecessor — this is the first sync, so there is nothing to compare with') }}</span>
            </span>
            <span class="sp-snap__diff-blocking" data-testid="stock-prep-snapshot-diff-blocking">
              {{ bi('这次改动带出几件卡住的事', 'Things this change left stuck') }}: {{ diff.blockingExceptionCount }}
            </span>
          </header>

          <dl class="sp-snap__counts">
            <div
              v-for="entry in changeCountEntries"
              :key="entry.key"
              class="sp-snap__count"
              data-testid="stock-prep-snapshot-diff-count"
              :data-kind="entry.key"
            >
              <dt class="sp-snap__count-label">{{ entry.label }}</dt>
              <dd class="sp-snap__count-value">{{ entry.value }}</dd>
            </div>
          </dl>

          <!-- View-2 per-row drill-down: lazy, values-free (handles + enums + counts + opaque SHA-16
               fingerprints only — never a raw path key / drawing number / quantity / unit). -->
          <div class="sp-snap__rows-wrap">
            <button
              type="button"
              class="sp-snap__rows-toggle"
              data-testid="stock-prep-snapshot-diff-rows-toggle"
              :aria-expanded="rowDetailOpen"
              @click="toggleRowDetail"
            >
              {{ rowDetailOpen ? bi('收起逐行明细', 'Hide the row-by-row list') : bi('看逐行明细', 'See it row by row') }}
            </button>

            <template v-if="rowDetailOpen">
              <p
                v-if="rowsLoading"
                class="sp-snap__state sp-snap__state--muted"
                data-testid="stock-prep-snapshot-diff-rows-loading"
                role="status"
              >
                {{ bi('正在加载逐行明细…', 'Loading row detail…') }}
              </p>
              <div
                v-else-if="rowsErrored"
                class="sp-snap__state sp-snap__state--muted"
                data-testid="stock-prep-snapshot-diff-rows-error"
                role="status"
              >
                <p class="sp-snap__state-msg">{{ bi('逐行明细暂不可用,稍后再试。', 'Row detail is not available yet — try again later.') }}</p>
                <!-- H4-3 retry: re-runs the existing loadRowDetail() for the same batch. -->
                <button
                  ref="rowsRetryEl"
                  type="button"
                  class="sp-snap__retry"
                  data-testid="stock-prep-snapshot-diff-rows-retry"
                  :disabled="rowsLoading"
                  :aria-label="bi('重试读取逐行明细', 'Retry loading row detail')"
                  @click="onRowsRetry"
                >
                  {{ bi('重试', 'Retry') }}
                </button>
              </div>
              <p
                v-else-if="diffRows && diffRows.rowCount === 0"
                class="sp-snap__state sp-snap__state--muted"
                data-testid="stock-prep-snapshot-diff-rows-empty"
              >
                {{ bi('该批次无差异行。', 'No diff rows for this batch.') }}
              </p>
              <div v-else-if="diffRows" data-testid="stock-prep-snapshot-diff-rows">
                <p class="sp-snap__rows-meta" data-testid="stock-prep-snapshot-diff-rows-meta">
                  {{ bi('差异行', 'Diff rows') }}: {{ diffRows.rowCount }} ·
                  {{ bi('待处理', 'Held') }}: {{ diffRows.heldRowCount }}
                </p>
                <!-- H4-3 keyboard: this drill-down table has NO focusable content in any row (plain
                     text cells only) — without this, a keyboard operator would have no way to reach
                     its horizontal scroll at all, so the wrap itself is a native scroll-region. -->
                <div
                  class="sp-snap__rows-scroll"
                  tabindex="0"
                  role="region"
                  :aria-label="bi('逐行差异明细表格,可滚动', 'Row-detail diff table, scrollable')"
                >
                  <table class="sp-snap__rows-table" data-testid="stock-prep-snapshot-diff-rows-table">
                    <thead>
                      <tr>
                        <th>{{ bi('编号', 'Reference') }}</th>
                        <th>{{ bi('怎么变的', 'How it changed') }}</th>
                        <th>{{ bi('看过了吗', 'Reviewed yet') }}</th>
                        <th>{{ bi('变了哪些方面', 'What changed about it') }}</th>
                        <th>{{ bi('涉及几行', 'Rows affected') }}</th>
                        <th>{{ bi('内部标识', 'Internal identifier') }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr
                        v-for="row in diffRows.rows"
                        :key="row.diffId"
                        data-testid="stock-prep-snapshot-diff-row"
                        :data-diff-type="row.diffType"
                        :data-review-status="row.reviewStatus"
                      >
                        <td><code class="sp-snap__handle">{{ row.diffId }}</code></td>
                        <!-- PLAIN FIRST, TOKEN KEPT: the words say what happened, the code beside
                             them is the engine's own enum, unchanged. -->
                        <td>
                          <span>{{ diffKindLabel(row.diffType) }}</span>
                          <code class="sp-snap__token">{{ row.diffType }}</code>
                        </td>
                        <td>
                          <span>{{ reviewLabel(row.reviewStatus) }}</span>
                          <code class="sp-snap__token">{{ row.reviewStatus }}</code>
                        </td>
                        <td>
                          <span v-if="row.changeTypes.length">{{ row.changeTypes.map(diffKindLabel).join('、') }}</span>
                          <template v-else>—</template>
                          <code v-if="row.changeTypes.length" class="sp-snap__token">{{ row.changeTypes.join(', ') }}</code>
                        </td>
                        <td>{{ row.rowCount }}</td>
                        <td><code class="sp-snap__handle">{{ fingerprintLabel(row.keyFingerprint) }}</code></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>

      <StockPrepTechnicalDetails testid="stock-prep-snapshot-tech">
        <dl>
          <dt>{{ bi('变更类别枚举', 'Change-kind vocabulary') }}</dt>
          <dd>
            <span v-for="entry in changeCountEntries" :key="entry.key">
              <code>{{ entry.key }}</code> = {{ entry.label }};
            </span>
          </dd>
          <dt>{{ bi('「不完整」是什么意思', 'What “incomplete” means') }}</dt>
          <dd>
            {{ bi(
              '批次不完整 = 零行,或缺同步运行记录 —— 持久化没走完。此类批次的差异入口保持可见但禁用:拿半份数据比出来的结论会误导人。',
              'A batch is incomplete when it has zero lines or no sync-run row — the persist path did not finish. Its diff entry stays visible but disabled: a comparison against half a batch would mislead.',
            ) }}
          </dd>
          <dt>{{ bi('这些编号是什么', 'What those references are') }}</dt>
          <dd>
            {{ bi(
              '句柄与 sha16 指纹是内部导航标识,不是业务值 —— 原始路径键、图号、数量、单位从不越过这一层。',
              'The handles and sha16 fingerprints are internal navigation identifiers, not business values — raw path keys, drawing numbers, quantities and units never cross this boundary.',
            ) }}
          </dd>
        </dl>
      </StockPrepTechnicalDetails>
    </div>
  </div>
</template>

<script setup lang="ts">
// Stock Preparation MVP (#3751 — docs/development/stock-preparation-mvp-design-20260707.md),
// Frontend MVP view 2: BOM SNAPSHOT BATCH & DIFF, rendered inside the workspace shell's second tab.
//
// READONLY: this view only GETs the values-free snapshot-batch list and per-batch diff summary
// through the landed service stub. It has no write path, issues no method override, and never
// triggers ERP/K3 writes. The backend read routes may 404 until the read-endpoints slice lands;
// both GETs are handled 404-soft (neutral state, never the raw error body).
//
// VALUES-FREE: it renders ONLY change counts, status enums, booleans and internal MetaSheet
// navigation handles (syncRunId / baseSnapshotBatchId). It deliberately does NOT render projectId as
// a visible column, nor any customer business value — no drawing numbers, material codes,
// quantities, versions of parts, path keys, or project names — because the summary shapes carry none
// and the template reads a fixed whitelist of fields rather than stringifying the row.
import { computed, nextTick, onMounted, ref, watch, type Ref } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import type { IntegrationScope } from '../../../services/integration/workbench'
import {
  getStockPreparationSnapshotDiff,
  listStockPreparationSnapshotBatches,
  listStockPreparationSnapshotDiffRows,
  type StockPreparationSnapshotBatchListResult,
  type StockPreparationSnapshotBatchSummary,
  type StockPreparationSnapshotDiffSummary,
  type StockPreparationSnapshotDiffRowsResult,
} from '../../../services/integration/stockPreparation/bomSnapshotDiff'
import StockPrepTechnicalDetails from './StockPrepTechnicalDetails.vue'
import {
  STOCK_PREP_DIFF_KIND_PLAIN,
  STOCK_PREP_DIFF_REVIEW_PLAIN,
  stockPrepEnumPlain,
} from '../../../services/integration/stockPreparation/plainLanguage'

const props = withDefaults(
  defineProps<{
    /** Internal MetaSheet project handle to list snapshot batches for. Absent → select-a-project. */
    projectId?: string
    /** Optional tenant/workspace scope passed straight through to the readonly GETs. */
    scope?: IntegrationScope
  }>(),
  { projectId: undefined, scope: () => ({}) },
)

const { locale } = useLocale()

// Same synchronous locale idiom as the shell / view 1 / the rest of the integration surface.
function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

/** The two diff vocabularies in words; each falls back to the raw token it does not know. */
function diffKindLabel(kind: string | null): string {
  const plain = stockPrepEnumPlain(STOCK_PREP_DIFF_KIND_PLAIN, kind)
  return plain ? bi(plain.zh, plain.en) : (kind ?? '—')
}

function reviewLabel(status: string | null): string {
  const plain = stockPrepEnumPlain(STOCK_PREP_DIFF_REVIEW_PLAIN, status)
  return plain ? bi(plain.zh, plain.en) : (status ?? '—')
}

const hasProject = computed(() => Boolean(props.projectId))

const loading = ref(Boolean(props.projectId))
const errored = ref(false)
const result = ref<StockPreparationSnapshotBatchListResult | null>(null)
// Monotonic guard for the batch-LIST load: a project switch bumps it, so a slow list response for the
// previous project (arriving after the operator moved on) is dropped, not committed over the new project.
let batchListSeq = 0

const isEmpty = computed(() => result.value !== null && result.value.batchCount === 0)

// Diff sub-state for the currently selected batch.
const selectedBatchId = ref<string | null>(null)
const diffLoading = ref(false)
const diffErrored = ref(false)
const diff = ref<StockPreparationSnapshotDiffSummary | null>(null)
// Monotonic guard for the diff-SUMMARY load: a batch switch (or project switch, via resetDiff) bumps it,
// so batch A's late summary cannot overwrite batch B's.
let diffSeq = 0

// Per-row detail sub-state (the view-2 drill-down under the summary). Lazy: the rows GET is issued only
// when the operator opens the detail, and re-fetched fresh per batch — never eagerly with the summary.
const rowDetailOpen = ref(false)
const rowsLoading = ref(false)
const rowsErrored = ref(false)
const diffRows = ref<StockPreparationSnapshotDiffRowsResult | null>(null)
// Monotonic guard: only the NEWEST rows load may commit. A batch switch (or re-open) bumps this, so a
// slow response for the previous batch — arriving after the operator moved on — is discarded instead of
// being cached under the wrong batch (A's late reply must never show up when B is open).
let rowsSeq = 0

// The fingerprint is the full opaque `sha16:<16 hex>` handle (never the raw path key) — 22 chars, short
// enough to show whole. (The old slice(0,10) cut the `sha16:` prefix down to 4 hex, which was misleading.)
function fingerprintLabel(fp: string | null): string {
  return fp ?? '—'
}

// Fixed whitelist of the eight values-free change-count kinds (counts of lines, never the values).
const changeCountEntries = computed(() => {
  const counts = diff.value?.changeCounts
  if (!counts) return []
  return [
    { key: 'added', value: counts.added },
    { key: 'removed', value: counts.removed },
    { key: 'quantityChanged', value: counts.quantityChanged },
    { key: 'unitChanged', value: counts.unitChanged },
    { key: 'versionChanged', value: counts.versionChanged },
    { key: 'pathChanged', value: counts.pathChanged },
    { key: 'missingChildBom', value: counts.missingChildBom },
    { key: 'fingerprintChanged', value: counts.fingerprintChanged },
  ].map((entry) => {
    const plain = stockPrepEnumPlain(STOCK_PREP_DIFF_KIND_PLAIN, entry.key)
    return { ...entry, label: plain ? bi(plain.zh, plain.en) : entry.key }
  })
})

function resetRowDetail(): void {
  rowsSeq += 1 // invalidate any in-flight rows load for the batch we are leaving
  rowDetailOpen.value = false
  rowsLoading.value = false
  rowsErrored.value = false
  diffRows.value = null
}

function resetDiff(): void {
  diffSeq += 1 // invalidate any in-flight diff-summary load for the batch/project we are leaving
  selectedBatchId.value = null
  diffLoading.value = false
  diffErrored.value = false
  diff.value = null
  resetRowDetail()
}

async function loadBatches(): Promise<void> {
  resetDiff()
  const seq = (batchListSeq += 1)
  const projectId = props.projectId
  if (!projectId) {
    // No project handle → neutral select-a-project state; issue no GET.
    loading.value = false
    errored.value = false
    result.value = null
    return
  }
  loading.value = true
  errored.value = false
  try {
    const listed = await listStockPreparationSnapshotBatches({ ...props.scope, projectId })
    if (seq !== batchListSeq || projectId !== props.projectId) return // superseded by a newer project load
    result.value = listed
  } catch {
    if (seq !== batchListSeq || projectId !== props.projectId) return
    // 404-soft: the backend read route may not exist yet. Surface a neutral state, NEVER the raw body.
    errored.value = true
    result.value = null
  } finally {
    if (seq === batchListSeq) loading.value = false
  }
}

// Shared by selectBatch (first load) and retryDiff (H4-3 error retry) — both fetch the diff summary
// for a batch already recorded in selectedBatchId, under the SAME monotonic diffSeq guard, so a
// retry can never let a stale response (from a batch switch mid-retry) win.
async function fetchDiffSummary(batchId: string): Promise<void> {
  const seq = (diffSeq += 1)
  diffLoading.value = true
  diffErrored.value = false
  try {
    const summary = await getStockPreparationSnapshotDiff(batchId, props.scope)
    if (seq !== diffSeq || batchId !== selectedBatchId.value) return // superseded — batch A's late summary must not overwrite B
    diff.value = summary
  } catch {
    if (seq !== diffSeq || batchId !== selectedBatchId.value) return
    // 404-soft for the diff GET as well.
    diffErrored.value = true
    diff.value = null
  } finally {
    if (seq === diffSeq) diffLoading.value = false
  }
}

async function selectBatch(batch: StockPreparationSnapshotBatchSummary): Promise<void> {
  // Defense-in-depth (Layer B). Layer A — the row button's `:disabled` binding — is the observable,
  // tested guard, and today it is the ONLY caller, so this line has no reachable second path. It
  // exists solely so any future caller also cannot issue a diff GET for an incomplete batch.
  if (batch.incomplete) return
  const batchId = batch.snapshotBatchId
  selectedBatchId.value = batchId
  diff.value = null
  resetRowDetail() // a new batch starts collapsed; its rows are re-fetched fresh when opened
  await fetchDiffSummary(batchId)
}

// H4-3 retry: re-fetch the diff summary for the CURRENTLY selected batch (selectedBatchId is already
// set — selectBatch sets it before the first fetch, and it is never cleared on a failed fetch), without
// re-running resetRowDetail — a plain retry of the summary should not discard an already-open row
// detail from a PRIOR successful load for this same batch.
async function retryDiff(): Promise<void> {
  const batchId = selectedBatchId.value
  if (!batchId) return
  await fetchDiffSummary(batchId)
}

async function loadRowDetail(): Promise<void> {
  const batchId = selectedBatchId.value
  if (!batchId) return
  const seq = (rowsSeq += 1) // this load owns the newest ticket
  rowsLoading.value = true
  rowsErrored.value = false
  diffRows.value = null
  try {
    const result = await listStockPreparationSnapshotDiffRows(batchId, {
      ...props.scope,
      projectId: props.projectId,
    })
    if (seq !== rowsSeq) return // superseded (batch switched / re-opened) — drop this stale response
    diffRows.value = result
  } catch {
    if (seq !== rowsSeq) return
    // 404-soft, same as the batch/diff GETs: neutral state, never the raw error body.
    rowsErrored.value = true
    diffRows.value = null
  } finally {
    if (seq === rowsSeq) rowsLoading.value = false
  }
}

function toggleRowDetail(): void {
  rowDetailOpen.value = !rowDetailOpen.value
  // Lazy first-open fetch; a re-open reuses what we already have (batch switch clears it via resetRowDetail).
  if (rowDetailOpen.value && !diffRows.value && !rowsLoading.value) void loadRowDetail()
}

// H4-3 keyboard — retry focus restore (same pattern as StockPreparationDashboardView.vue's H4-1
// retry). Each of the three retry buttons above carries `:disabled` while its own load is in
// flight, and the button UNMOUNTS (its error branch yields to the loading branch, leaving the DOM) — the browser drops focus to
// <body>, stranding a keyboard operator who just pressed Retry. After the load settles we put focus
// back on the button, but ONLY when it is still rendered (the retry failed again, so there is
// something to press) AND focus is still on <body> (our own unmount dropped it, and the operator
// has not Tabbed elsewhere meanwhile) — the second condition is REQUIRED so this can never steal
// focus from wherever the operator moved to.
const batchRetryEl = ref<HTMLButtonElement | null>(null)
const diffRetryEl = ref<HTMLButtonElement | null>(null)
const rowsRetryEl = ref<HTMLButtonElement | null>(null)

async function restoreRetryFocus(el: Ref<HTMLButtonElement | null>): Promise<void> {
  await nextTick()
  if (document.activeElement === document.body) el.value?.focus()
}

async function onBatchRetry(): Promise<void> {
  await loadBatches()
  await restoreRetryFocus(batchRetryEl)
}

async function onDiffRetry(): Promise<void> {
  await retryDiff()
  await restoreRetryFocus(diffRetryEl)
}

async function onRowsRetry(): Promise<void> {
  await loadRowDetail()
  await restoreRetryFocus(rowsRetryEl)
}

onMounted(loadBatches)
watch(() => props.projectId, loadBatches)
</script>

<style scoped>
.sp-snap {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
}

.sp-snap__state {
  margin: 0;
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
  line-height: 1.6;
}

.sp-snap__state--muted {
  color: var(--ms-text-3);
}

.sp-snap__state-msg {
  margin: 0 0 var(--ms-space-2);
}

.sp-snap__retry {
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: transparent;
  padding: 4px 12px;
  color: var(--ms-color-primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.sp-snap__retry:hover:not(:disabled) {
  background: var(--el-fill-color-light);
}

.sp-snap__retry:disabled {
  opacity: 0.5;
  cursor: default;
}

.sp-snap__retry:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}

.sp-snap__overview {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
}

.sp-snap__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ms-space-2);
}

.sp-snap__summary-count {
  color: var(--ms-text-1);
  font-weight: var(--ms-font-weight-title);
}

/* H4-3 long-table: bounded height + BOTH-axis overflow, so the table scrolls inside its OWN box and
   the sticky thead below has an actual scroll range to stick within (an `overflow-x: auto`-only wrap
   never scrolls vertically, so a sticky header inside it would never engage). */
.sp-snap__table-wrap {
  max-height: 420px;
  overflow: auto;
}

.sp-snap__table-wrap:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}

.sp-snap__table {
  width: 100%;
  min-width: 720px;
  border-collapse: collapse;
  font-size: 13px;
}

.sp-snap__table th,
.sp-snap__table td {
  padding: var(--ms-space-2) var(--ms-space-3);
  border-bottom: 1px solid var(--ms-border-light);
  text-align: left;
  white-space: nowrap;
}

.sp-snap__table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--ms-bg-card);
  color: var(--ms-text-3);
  font-weight: var(--ms-font-weight-title);
}

.sp-snap__col-action {
  text-align: right;
}

.sp-snap__num {
  color: var(--ms-text-1);
  font-variant-numeric: tabular-nums;
}

.sp-snap__status {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--el-fill-color-light);
  color: var(--ms-text-2);
  font-size: 12px;
}

/* Same warning-chip idiom as the workbench sections (IntegrationObjectTemplateSection). */
.sp-snap__incomplete {
  display: inline-flex;
  align-items: center;
  margin-left: var(--ms-space-1);
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning-dark-2);
  font-size: 12px;
}

.sp-snap__handle {
  color: var(--ms-text-3);
  font-size: 12px;
}

/* The engine's own enum, kept beside the words it means — subordinate, still copyable. */
.sp-snap__token {
  display: inline-block;
  margin-left: var(--ms-space-1);
  color: var(--ms-text-3);
  font-size: 11px;
  word-break: break-all;
}

.sp-snap__recorded {
  color: var(--ms-text-2);
  font-size: 12px;
}

.sp-snap__row--selected {
  background: var(--el-fill-color-light);
}

.sp-snap__select {
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: transparent;
  padding: 2px 10px;
  color: var(--ms-color-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.sp-snap__select:hover {
  background: var(--el-fill-color-light);
}

.sp-snap__select:disabled {
  color: var(--ms-text-3);
  cursor: not-allowed;
}

.sp-snap__select:disabled:hover {
  background: transparent;
}

/* H4-3 keyboard: same ring idiom as the H4-2 dashboard/stepper rings and this file's own
   rows-toggle ring below — one focus-ring system across the stock-prep surface. */
.sp-snap__select:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}

.sp-snap__diff-wrap {
  border-top: 1px solid var(--ms-border-light);
  padding-top: var(--ms-space-3);
}

.sp-snap__diff {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
}

.sp-snap__diff-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ms-space-3);
}

.sp-snap__diff-base,
.sp-snap__diff-blocking {
  color: var(--ms-text-2);
  font-size: 13px;
}

.sp-snap__counts {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: var(--ms-space-2);
  margin: 0;
}

.sp-snap__count {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--ms-space-2);
  padding: var(--ms-space-2) var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
}

.sp-snap__count-label {
  margin: 0;
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-snap__count-value {
  margin: 0;
  color: var(--ms-text-1);
  font-variant-numeric: tabular-nums;
  font-weight: var(--ms-font-weight-title);
}

.sp-snap__rows-wrap {
  margin-top: var(--ms-space-3);
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
}

.sp-snap__rows-toggle {
  align-self: flex-start;
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: transparent;
  padding: 4px 12px;
  color: var(--ms-color-primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.sp-snap__rows-toggle:hover {
  background: var(--el-fill-color-light);
}

.sp-snap__rows-toggle:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}

.sp-snap__rows-meta {
  margin: 0;
  color: var(--ms-text-2);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

/* H4-3 long-table: bounded height (smaller than the batches table above — this is the secondary,
   nested drill-down) + BOTH-axis overflow, so its sticky thead has a real scroll range. */
.sp-snap__rows-scroll {
  max-height: 360px;
  overflow: auto;
}

.sp-snap__rows-scroll:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}

.sp-snap__rows-table {
  width: 100%;
  min-width: 720px;
  border-collapse: collapse;
  font-size: 13px;
}

.sp-snap__rows-table th,
.sp-snap__rows-table td {
  text-align: left;
  padding: var(--ms-space-2) var(--ms-space-3);
  border-bottom: 1px solid var(--ms-border-light);
  white-space: nowrap;
}

.sp-snap__rows-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--ms-bg-card);
  color: var(--ms-text-2);
  font-weight: var(--ms-font-weight-title);
}

.sp-snap__rows-table td {
  color: var(--ms-text-1);
  font-variant-numeric: tabular-nums;
}
</style>
