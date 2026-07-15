<template>
  <div class="sp-snap" data-testid="stock-prep-snapshot-diff-view">
    <!-- No project selected: this slice has no project picker, so we simply ask for one. -->
    <p
      v-if="!hasProject"
      class="sp-snap__state sp-snap__state--muted"
      data-testid="stock-prep-snapshot-no-project"
      role="status"
    >
      {{ bi('请选择一个项目以查看其快照批次。', 'Select a project to see its snapshot batches.') }}
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
    <p
      v-else-if="errored"
      class="sp-snap__state sp-snap__state--muted"
      data-testid="stock-prep-snapshot-error"
      role="status"
    >
      {{ bi('同步后端尚未就绪,稍后再试。', 'Backend read not ready yet — try again later.') }}
    </p>

    <!-- Empty: the project exists but has produced no immutable snapshot batches yet. -->
    <p
      v-else-if="isEmpty"
      class="sp-snap__state sp-snap__state--muted"
      data-testid="stock-prep-snapshot-empty"
    >
      {{ bi('尚无快照批次。', 'No snapshot batches yet.') }}
    </p>

    <!-- Data: values-free batches table + a diff-summary panel for the selected batch. -->
    <div v-else-if="result" class="sp-snap__overview" data-testid="stock-prep-snapshot-overview">
      <header class="sp-snap__summary" data-testid="stock-prep-snapshot-summary">
        <span class="sp-snap__summary-count">
          {{ bi('快照批次', 'Snapshot batches') }}: {{ result.batchCount }}
        </span>
      </header>

      <div class="sp-snap__table-wrap">
        <table class="sp-snap__table">
          <thead>
            <tr>
              <th scope="col">{{ bi('版本', 'Version') }}</th>
              <th scope="col">{{ bi('状态', 'Status') }}</th>
              <th scope="col">{{ bi('批次行数', 'Line count') }}</th>
              <th scope="col">{{ bi('同步运行', 'Sync run') }}</th>
              <th scope="col">{{ bi('创建时间', 'Recorded') }}</th>
              <th scope="col" class="sp-snap__col-action">{{ bi('差异', 'Diff') }}</th>
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
                  {{ bi('不完整', 'incomplete') }}
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
                      ? bi('批次不完整(缺批次行或缺同步运行),差异不可用。', 'Batch incomplete (no lines or missing sync run) — diff unavailable.')
                      : undefined
                  "
                  @click="selectBatch(batch)"
                >
                  {{ bi('查看差异', 'View diff') }}
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
          {{ bi('选择一个批次以查看其差异。', 'Select a batch to see its diff.') }}
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
        <p
          v-else-if="diffErrored"
          class="sp-snap__state sp-snap__state--muted"
          data-testid="stock-prep-diff-error"
          role="status"
        >
          {{ bi('同步后端尚未就绪,稍后再试。', 'Backend read not ready yet — try again later.') }}
        </p>

        <!-- Diff data: values-free per-kind change counts + blocking-exception count + base handle. -->
        <div v-else-if="diff" class="sp-snap__diff" data-testid="stock-prep-snapshot-diff">
          <header class="sp-snap__diff-head">
            <span class="sp-snap__diff-base" data-testid="stock-prep-snapshot-diff-base">
              {{ bi('对比基准批次', 'Base batch') }}:
              <code v-if="diff.baseSnapshotBatchId" class="sp-snap__handle">{{
                diff.baseSnapshotBatchId
              }}</code>
              <span v-else>{{ bi('无前序批次', 'no predecessor') }}</span>
            </span>
            <span class="sp-snap__diff-blocking" data-testid="stock-prep-snapshot-diff-blocking">
              {{ bi('阻断级异常', 'Blocking exceptions') }}: {{ diff.blockingExceptionCount }}
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
              <dt class="sp-snap__count-label">{{ bi(entry.zh, entry.en) }}</dt>
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
              {{ rowDetailOpen ? bi('收起逐行明细', 'Hide row detail') : bi('查看逐行明细', 'View row detail') }}
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
              <p
                v-else-if="rowsErrored"
                class="sp-snap__state sp-snap__state--muted"
                data-testid="stock-prep-snapshot-diff-rows-error"
                role="status"
              >
                {{ bi('逐行明细暂不可用,稍后再试。', 'Row detail is not available yet — try again later.') }}
              </p>
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
                <div class="sp-snap__rows-scroll">
                  <table class="sp-snap__rows-table" data-testid="stock-prep-snapshot-diff-rows-table">
                    <thead>
                      <tr>
                        <th>{{ bi('差异句柄', 'Diff') }}</th>
                        <th>{{ bi('类型', 'Type') }}</th>
                        <th>{{ bi('复核状态', 'Review') }}</th>
                        <th>{{ bi('变更类别', 'Changes') }}</th>
                        <th>{{ bi('行数', 'Rows') }}</th>
                        <th>{{ bi('键指纹', 'Key fp') }}</th>
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
                        <td>{{ row.diffType }}</td>
                        <td>{{ row.reviewStatus }}</td>
                        <td>{{ row.changeTypes.length ? row.changeTypes.join(', ') : '—' }}</td>
                        <td>{{ row.rowCount }}</td>
                        <td><code class="sp-snap__handle">{{ shortFingerprint(row.keyFingerprint) }}</code></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>
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
import { computed, onMounted, ref, watch } from 'vue'
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

const hasProject = computed(() => Boolean(props.projectId))

const loading = ref(Boolean(props.projectId))
const errored = ref(false)
const result = ref<StockPreparationSnapshotBatchListResult | null>(null)

const isEmpty = computed(() => result.value !== null && result.value.batchCount === 0)

// Diff sub-state for the currently selected batch.
const selectedBatchId = ref<string | null>(null)
const diffLoading = ref(false)
const diffErrored = ref(false)
const diff = ref<StockPreparationSnapshotDiffSummary | null>(null)

// Per-row detail sub-state (the view-2 drill-down under the summary). Lazy: the rows GET is issued only
// when the operator opens the detail, and re-fetched fresh per batch — never eagerly with the summary.
const rowDetailOpen = ref(false)
const rowsLoading = ref(false)
const rowsErrored = ref(false)
const diffRows = ref<StockPreparationSnapshotDiffRowsResult | null>(null)

// A diff/path-key fingerprint is already an opaque SHA-16 (never the raw path key); show a short prefix
// so the table stays scannable while remaining a values-free handle.
function shortFingerprint(fp: string | null): string {
  return fp ? fp.slice(0, 10) : '—'
}

// Fixed whitelist of the eight values-free change-count kinds (counts of lines, never the values).
const changeCountEntries = computed(() => {
  const counts = diff.value?.changeCounts
  if (!counts) return []
  return [
    { key: 'added', zh: '新增', en: 'Added', value: counts.added },
    { key: 'removed', zh: '删除', en: 'Removed', value: counts.removed },
    { key: 'quantityChanged', zh: '数量变化', en: 'Quantity changed', value: counts.quantityChanged },
    { key: 'unitChanged', zh: '单位变化', en: 'Unit changed', value: counts.unitChanged },
    { key: 'versionChanged', zh: '版本变化', en: 'Version changed', value: counts.versionChanged },
    { key: 'pathChanged', zh: '路径变化', en: 'Path changed', value: counts.pathChanged },
    { key: 'missingChildBom', zh: '缺失子 BOM', en: 'Missing child BOM', value: counts.missingChildBom },
    { key: 'fingerprintChanged', zh: '指纹变化', en: 'Fingerprint changed', value: counts.fingerprintChanged },
  ]
})

function resetRowDetail(): void {
  rowDetailOpen.value = false
  rowsLoading.value = false
  rowsErrored.value = false
  diffRows.value = null
}

function resetDiff(): void {
  selectedBatchId.value = null
  diffLoading.value = false
  diffErrored.value = false
  diff.value = null
  resetRowDetail()
}

async function loadBatches(): Promise<void> {
  resetDiff()
  if (!props.projectId) {
    // No project handle → neutral select-a-project state; issue no GET.
    loading.value = false
    errored.value = false
    result.value = null
    return
  }
  loading.value = true
  errored.value = false
  try {
    result.value = await listStockPreparationSnapshotBatches({
      ...props.scope,
      projectId: props.projectId,
    })
  } catch {
    // 404-soft: the backend read route may not exist yet. Surface a neutral state, NEVER the raw body.
    errored.value = true
    result.value = null
  } finally {
    loading.value = false
  }
}

async function selectBatch(batch: StockPreparationSnapshotBatchSummary): Promise<void> {
  // Defense-in-depth (Layer B). Layer A — the row button's `:disabled` binding — is the observable,
  // tested guard, and today it is the ONLY caller, so this line has no reachable second path. It
  // exists solely so any future caller also cannot issue a diff GET for an incomplete batch.
  if (batch.incomplete) return
  selectedBatchId.value = batch.snapshotBatchId
  diffLoading.value = true
  diffErrored.value = false
  diff.value = null
  resetRowDetail() // a new batch starts collapsed; its rows are re-fetched fresh when opened
  try {
    diff.value = await getStockPreparationSnapshotDiff(batch.snapshotBatchId, props.scope)
  } catch {
    // 404-soft for the diff GET as well.
    diffErrored.value = true
    diff.value = null
  } finally {
    diffLoading.value = false
  }
}

async function loadRowDetail(): Promise<void> {
  if (!selectedBatchId.value) return
  rowsLoading.value = true
  rowsErrored.value = false
  diffRows.value = null
  try {
    diffRows.value = await listStockPreparationSnapshotDiffRows(selectedBatchId.value, {
      ...props.scope,
      projectId: props.projectId,
    })
  } catch {
    // 404-soft, same as the batch/diff GETs: neutral state, never the raw error body.
    rowsErrored.value = true
    diffRows.value = null
  } finally {
    rowsLoading.value = false
  }
}

function toggleRowDetail(): void {
  rowDetailOpen.value = !rowDetailOpen.value
  // Lazy first-open fetch; a re-open reuses what we already have (batch switch clears it via resetRowDetail).
  if (rowDetailOpen.value && !diffRows.value && !rowsLoading.value) void loadRowDetail()
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

.sp-snap__table-wrap {
  overflow-x: auto;
}

.sp-snap__table {
  width: 100%;
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

.sp-snap__rows-scroll {
  overflow-x: auto;
}

.sp-snap__rows-table {
  width: 100%;
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
  color: var(--ms-text-2);
  font-weight: var(--ms-font-weight-title);
}

.sp-snap__rows-table td {
  color: var(--ms-text-1);
  font-variant-numeric: tabular-nums;
}
</style>
