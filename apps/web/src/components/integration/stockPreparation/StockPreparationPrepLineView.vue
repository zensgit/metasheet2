<template>
  <div class="sp-line" data-testid="stock-prep-line-view">
    <!-- No project selected: this slice has no project picker, so we simply ask for one. -->
    <p
      v-if="!hasProject"
      class="sp-line__state sp-line__state--muted"
      data-testid="stock-prep-line-no-project"
      role="status"
    >
      {{ bi('请选择一个项目,这里会列出它的备料明细。', 'Select a project and this page lists its prep lines.') }}
    </p>

    <!-- Loading: values-free spinner copy only. -->
    <p
      v-else-if="loading"
      class="sp-line__state sp-line__state--muted"
      data-testid="stock-prep-line-loading"
      role="status"
    >
      {{ bi('正在读取备料明细…', 'Reading the prep lines…') }}
    </p>

    <!-- Error / endpoint-not-ready (GET rejects or 404s): neutral, never the raw body. -->
    <div
      v-else-if="errored"
      class="sp-line__state sp-line__state--muted"
      data-testid="stock-prep-line-error"
      role="status"
    >
      <p class="sp-line__state-msg">{{ bi('同步后端尚未就绪,稍后再试。', 'Backend read not ready yet — try again later.') }}</p>
      <!-- H4-3 retry: re-runs the same readonly loadList(); idempotent, no new endpoint. -->
      <button
        ref="retryEl"
        type="button"
        class="sp-line__retry"
        data-testid="stock-prep-line-retry"
        :disabled="loading"
        :aria-label="bi('重试读取备料明细', 'Retry loading prep lines')"
        @click="onRetry"
      >
        {{ bi('重试', 'Retry') }}
      </button>
    </div>

    <div v-else-if="list" class="sp-line__overview" data-testid="stock-prep-line-overview">
      <!-- Header cards: total + the three values-free status count groups. -->
      <header class="sp-line__summary" data-testid="stock-prep-line-summary">
        <div class="sp-line__metric" data-testid="stock-prep-line-metric" data-kind="total">
          <span class="sp-line__metric-label">{{ bi('备料明细行数', 'Prep lines') }}</span>
          <span class="sp-line__metric-value">{{ list.rowCount }}</span>
        </div>
        <div class="sp-line__metric sp-line__metric--chips" data-testid="stock-prep-line-metric" data-kind="prep-status">
          <span class="sp-line__metric-label">{{ bi('能不能用', 'Usable or not') }}</span>
          <span class="sp-line__chips">
            <span
              v-for="entry in prepStatusEntries"
              :key="entry.key"
              class="sp-line__chip"
              data-testid="stock-prep-line-prep-status-count"
              :data-status="entry.key"
              :title="entry.key"
            >{{ prepStatusLabel(entry.key) }}: {{ entry.count }}</span>
          </span>
        </div>
        <div class="sp-line__metric sp-line__metric--chips" data-testid="stock-prep-line-metric" data-kind="mapping-status">
          <span class="sp-line__metric-label">{{ bi('物料对上了吗', 'Materials matched') }}</span>
          <span class="sp-line__chips">
            <span
              v-for="entry in mappingStatusEntries"
              :key="entry.key"
              class="sp-line__chip"
              data-testid="stock-prep-line-mapping-status-count"
              :data-status="entry.key"
              :title="entry.key"
            >{{ mappingStatusLabel(entry.key) }}: {{ entry.count }}</span>
          </span>
        </div>
        <div class="sp-line__metric sp-line__metric--chips" data-testid="stock-prep-line-metric" data-kind="unit-status">
          <span class="sp-line__metric-label">{{ bi('单位定了吗', 'Units settled') }}</span>
          <span class="sp-line__chips">
            <span
              v-for="entry in unitStatusEntries"
              :key="entry.key"
              class="sp-line__chip"
              data-testid="stock-prep-line-unit-status-count"
              :data-status="entry.key"
              :title="entry.key"
            >{{ unitStatusLabel(entry.key) }}: {{ entry.count }}</span>
          </span>
        </div>
      </header>

      <!-- Generation run: MULTITABLE-INTERNAL table op (W4a) — no ERP/K3 write. The result note is
           values-free: verdict enums + counts only. -->
      <div class="sp-line__generate" data-testid="stock-prep-line-generate-block">
        <button
          type="button"
          class="sp-line__action"
          data-testid="stock-prep-line-generate"
          :disabled="busy"
          @click="runGeneration"
        >
          {{ bi('生成备料明细', 'Build the prep lines') }}
        </button>
        <span class="sp-line__note">
          {{ bi('只写本系统自己的表,不会写到 ERP/K3。', 'Writes only into this system\'s own tables — nothing goes to ERP/K3.') }}
        </span>
      </div>
      <p v-if="runResult" class="sp-line__state sp-line__state--ok" data-testid="stock-prep-line-generate-result">
        {{ runResult.ready
          ? bi('生成完成,结果可以用了。', 'Built, and the result is usable.')
          : bi('生成完成,但结果还不能用 —— 见下面一行。', 'Built, but the result is not usable yet — see the line below.') }}
        {{ bi('新增', 'added') }} {{ runResult.created.lines }} {{ bi('行、更新', 'row(s), updated') }} {{ runResult.patched.lines }} {{ bi('行,新记下', 'row(s), and noted') }} {{ runResult.created.exceptions }} {{ bi('件待处理的事。', 'new thing(s) to handle.') }}
        <code class="sp-line__token">{{ runResult.status }} · ready={{ runResult.ready ? bi('是', 'yes') : bi('否', 'no') }} · unresolvedBlocking={{ runResult.unresolvedBlockingExceptionCount }}</code>
      </p>
      <p
        v-if="runResult && !runResult.ready"
        class="sp-line__state sp-line__state--warn"
        data-testid="stock-prep-line-generate-blocked"
        role="alert"
      >
        {{ bi(
          '还有事卡着没处理,所以这次没能产出可用的行 —— 请到「异常队列」把它们逐条处理掉,再生成一次。',
          'Some things are still stuck, so no usable line came out of this run — clear them on the exception page, then build again.',
        ) }}
      </p>
      <p v-if="actionError" class="sp-line__state sp-line__state--warn" data-testid="stock-prep-line-action-error" role="alert">
        {{ bi(errorPlain(actionError.code).zh, errorPlain(actionError.code).en) }}
        <code class="sp-line__token">{{ actionError.code }}<template v-if="actionError.field">/{{ actionError.field }}</template></code>
      </p>

      <!-- Line table: prepStatus filter + values-free rows. -->
      <div class="sp-line__table-head">
        <span class="sp-line__count" data-testid="stock-prep-line-row-count">
          {{ bi('明细行', 'Rows') }}: {{ list.rowCount }}
        </span>
        <label class="sp-line__field sp-line__field--inline">
          <span class="sp-line__field-label">{{ bi('只看', 'Show only') }}</span>
          <select v-model="statusFilter" data-testid="stock-prep-line-filter">
            <option value="">{{ bi('全部', 'all') }}</option>
            <option v-for="status in prepLineStatuses" :key="status" :value="status">{{ prepStatusLabel(status) }}</option>
          </select>
        </label>
      </div>

      <p v-if="list.rowCount === 0" class="sp-line__state sp-line__state--muted" data-testid="stock-prep-line-empty">
        {{ bi('还没有备料明细 —— 点上面的「生成备料明细」开始。', 'No prep lines yet — use “Build the prep lines” above to start.') }}
      </p>
      <!-- VALUES-FREE rows: handles + status enums + counts + presence booleans ONLY. The drawing
           number, design/issue quantity, and unit columns are OWNER-GATED value surfaces (OD-W3-1)
           and are DELIBERATELY not shown in the MVP. -->
      <!-- H4-3 keyboard: this table has NO focusable content in ANY row (plain-text/badge cells
           only — the drawing-number/quantity/unit columns are OWNER-GATED and deliberately absent).
           Without this, a keyboard operator would have no way to reach its horizontal scroll at all,
           so the wrap itself is a native scroll-region. -->
      <div
        v-else
        class="sp-line__table-wrap"
        tabindex="0"
        role="region"
        :aria-label="bi('备料明细表格,可滚动', 'Prep line table, scrollable')"
      >
        <table class="sp-line__table" data-testid="stock-prep-line-table">
          <thead>
            <tr>
              <th scope="col">{{ bi('编号', 'Reference') }}</th>
              <th scope="col">{{ bi('能不能用', 'Usable') }}</th>
              <th scope="col">{{ bi('物料对上了吗', 'Material matched') }}</th>
              <th scope="col">{{ bi('单位定了吗', 'Unit settled') }}</th>
              <th scope="col">{{ bi('几件事卡着', 'Things stuck') }}</th>
              <th scope="col">{{ bi('领用数量定了吗', 'Issue quantity set') }}</th>
              <th scope="col">{{ bi('ERP 物料齐了吗', 'ERP material complete') }}</th>
              <th scope="col">{{ bi('哪次生成的', 'Which run built it') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, index) in list.rows"
              :key="row.stockPrepLineId ?? `row-${index}`"
              class="sp-line__row"
              data-testid="stock-prep-line-row"
            >
              <td><code class="sp-line__handle" data-testid="stock-prep-line-row-handle">{{ row.stockPrepLineId ?? '—' }}</code></td>
              <!-- PLAIN FIRST, TOKEN KEPT. The badge says it in words; the element carrying the
                   testid still holds the server enum byte-exact, for grepping and for the
                   values-free suites that pin exactly what leaks into these cells. -->
              <td>
                <span v-if="row.prepStatus" class="sp-line__badge">{{ prepStatusLabel(row.prepStatus) }}</span>
                <code class="sp-line__token" data-testid="stock-prep-line-row-prep-status" :data-status="row.prepStatus ?? 'unknown'">{{ row.prepStatus ?? '—' }}</code>
              </td>
              <td>
                <span v-if="row.mappingStatus" class="sp-line__badge">{{ mappingStatusLabel(row.mappingStatus) }}</span>
                <code class="sp-line__token" data-testid="stock-prep-line-row-mapping-status" :data-status="row.mappingStatus ?? 'unknown'">{{ row.mappingStatus ?? '—' }}</code>
              </td>
              <td>
                <span v-if="row.unitStatus" class="sp-line__badge">{{ unitStatusLabel(row.unitStatus) }}</span>
                <code class="sp-line__token" data-testid="stock-prep-line-row-unit-status" :data-status="row.unitStatus ?? 'unknown'">{{ row.unitStatus ?? '—' }}</code>
              </td>
              <td class="sp-line__num" data-testid="stock-prep-line-row-exceptions">{{ row.exceptionCount }}</td>
              <td data-testid="stock-prep-line-row-issue-qty" :data-flag="String(row.hasIssueQty)">
                {{ row.hasIssueQty ? bi('已定', 'yes') : bi('还没定', 'not yet') }}
              </td>
              <td data-testid="stock-prep-line-row-erp-target" :data-flag="String(row.hasErpTarget)">
                {{ row.hasErpTarget ? bi('齐了', 'yes') : bi('还差', 'not yet') }}
              </td>
              <td><code class="sp-line__handle" data-testid="stock-prep-line-row-run">{{ row.createdFromRunId ?? '—' }}</code></td>
            </tr>
          </tbody>
        </table>
      </div>

      <StockPrepTechnicalDetails testid="stock-prep-line-tech">
        <dl>
          <dt>{{ bi('备料状态枚举', 'Prep-status vocabulary') }}</dt>
          <dd>
            <span v-for="status in prepLineStatuses" :key="status"><code>{{ status }}</code> = {{ prepStatusLabel(status) }}; </span>
          </dd>
          <dt>{{ bi('生成写入的范围', 'What generation writes') }}</dt>
          <dd>
            {{ bi(
              '生成运行只做 multitable 内部表操作(备料行 upsert + 仅新建异常 + 运行台账),从不写 ERP/K3。',
              'A generation run performs multitable-internal table operations only (prep-line upsert, create-only exceptions, a run ledger). It never writes to ERP/K3.',
            ) }}
          </dd>
          <dt>{{ bi('这张表为什么没有图号 / 数量 / 单位列', 'Why there is no drawing / quantity / unit column here') }}</dt>
          <dd>
            {{ bi(
              '那三列是值面,受 OD-W3-1 单独授权,MVP 有意不在此展示。本表只显示句柄、状态枚举、计数与存在性布尔。',
              'Those three are value surfaces under their own authorisation (OD-W3-1) and are deliberately not shown in the MVP. This table carries handles, status enums, counts and presence booleans only.',
            ) }}
          </dd>
        </dl>
      </StockPrepTechnicalDetails>
    </div>
  </div>
</template>

<script setup lang="ts">
// Stock Preparation MVP (#3751 — docs/development/stock-preparation-mvp-design-20260707.md),
// Frontend MVP view 5: STOCK PREPARATION LINES, rendered inside the workspace shell's fifth tab.
// Reads = W5a values-free prep-line list; write = the W4a generation run — a MULTITABLE-INTERNAL
// table op (prep-line upsert + create-only exceptions + run ledger), never an ERP/K3 write.
//
// VALUES-FREE: the template reads a fixed whitelist — counts, prep/mapping/unit status enums,
// presence booleans, and sha16 handles (stockPrepLineId / createdFromRunId). The drawing-number /
// quantity / unit columns are OWNER-GATED value surfaces (OD-W3-1) and are deliberately NOT shown
// in the MVP; error surfaces render only the clamped code / field NAME, never the raw body.
import { computed, nextTick, onMounted, ref, watch, type Ref } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import type { IntegrationScope } from '../../../services/integration/workbench'
import { StockPreparationConfirmApiError } from '../../../services/integration/stockPreparation/confirmApi'
import {
  STOCK_PREPARATION_PREP_LINE_STATUSES,
  listStockPreparationPrepLines,
  runStockPreparationGeneration,
  type StockPreparationGenerationRunResult,
  type StockPreparationPrepLineList,
  type StockPreparationPrepLineStatus,
} from '../../../services/integration/stockPreparation/prepLine'
import StockPrepTechnicalDetails from './StockPrepTechnicalDetails.vue'
import {
  STOCK_PREP_LINE_MAPPING_STATUS_PLAIN,
  STOCK_PREP_LINE_STATUS_PLAIN,
  STOCK_PREP_LINE_UNIT_STATUS_PLAIN,
  stockPrepEnumPlain,
  stockPrepErrorPlain,
} from '../../../services/integration/stockPreparation/plainLanguage'

const props = withDefaults(
  defineProps<{
    /** Internal MetaSheet project handle (shell-owned shared context). Absent → select-a-project. */
    projectId?: string
    /** Optional tenant/workspace scope passed straight through to every request. */
    scope?: IntegrationScope
  }>(),
  { projectId: undefined, scope: () => ({}) },
)

const { locale } = useLocale()

// Same synchronous locale idiom as the shell / views 1-4 / the rest of the integration surface.
function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const prepLineStatuses = STOCK_PREPARATION_PREP_LINE_STATUSES

/** The three row vocabularies in words; each falls back to the raw token it does not know. */
function prepStatusLabel(status: string | null): string {
  const plain = stockPrepEnumPlain(STOCK_PREP_LINE_STATUS_PLAIN, status)
  return plain ? bi(plain.zh, plain.en) : (status ?? '—')
}

function mappingStatusLabel(status: string | null): string {
  const plain = stockPrepEnumPlain(STOCK_PREP_LINE_MAPPING_STATUS_PLAIN, status)
  return plain ? bi(plain.zh, plain.en) : (status ?? '—')
}

function unitStatusLabel(status: string | null): string {
  const plain = stockPrepEnumPlain(STOCK_PREP_LINE_UNIT_STATUS_PLAIN, status)
  return plain ? bi(plain.zh, plain.en) : (status ?? '—')
}

const errorPlain = stockPrepErrorPlain

const hasProject = computed(() => Boolean(props.projectId))

const loading = ref(Boolean(props.projectId))
const errored = ref(false)
const list = ref<StockPreparationPrepLineList | null>(null)

const statusFilter = ref<'' | StockPreparationPrepLineStatus>('')

const busy = ref(false)
const runResult = ref<StockPreparationGenerationRunResult | null>(null)
const actionError = ref<{ code: string; field: string | null } | null>(null)

const prepStatusEntries = computed(() =>
  Object.entries(list.value?.byPrepStatus ?? {}).map(([key, count]) => ({ key, count })),
)
const mappingStatusEntries = computed(() =>
  Object.entries(list.value?.byMappingStatus ?? {}).map(([key, count]) => ({ key, count })),
)
const unitStatusEntries = computed(() =>
  Object.entries(list.value?.byUnitStatus ?? {}).map(([key, count]) => ({ key, count })),
)

function requestScope(): IntegrationScope & { projectId: string } {
  return { ...props.scope, projectId: props.projectId as string }
}

async function loadList(): Promise<void> {
  if (!props.projectId) {
    loading.value = false
    errored.value = false
    list.value = null
    return
  }
  loading.value = true
  errored.value = false
  try {
    list.value = await listStockPreparationPrepLines({
      ...requestScope(),
      prepStatus: statusFilter.value || undefined,
    })
  } catch {
    // 404-soft: neutral state, NEVER the raw error body.
    errored.value = true
    list.value = null
  } finally {
    loading.value = false
  }
}

async function reloadList(): Promise<void> {
  if (!props.projectId) return
  try {
    list.value = await listStockPreparationPrepLines({
      ...requestScope(),
      prepStatus: statusFilter.value || undefined,
    })
  } catch {
    errored.value = true
    list.value = null
  }
}

async function runGeneration(): Promise<void> {
  if (!props.projectId || busy.value) return
  actionError.value = null
  runResult.value = null
  busy.value = true
  try {
    // No snapshotBatchId → the server resolves the LATEST complete batch (view has no batch picker).
    runResult.value = await runStockPreparationGeneration({}, requestScope())
    await reloadList()
  } catch (error) {
    if (error instanceof StockPreparationConfirmApiError) {
      actionError.value = { code: error.code, field: error.field }
    } else {
      actionError.value = { code: 'STOCK_PREPARATION_CONFIRM_REQUEST_FAILED', field: null }
    }
  } finally {
    busy.value = false
  }
}

// H4-3 keyboard — retry focus restore (same pattern as StockPreparationDashboardView.vue's H4-1
// retry). The retry button carries `:disabled` while its own load is in flight, and the button UNMOUNTS — its error branch
// yields to the loading branch, leaving the DOM entirely — the browser drops focus to <body>, stranding a
// keyboard operator who just pressed Retry. After the load settles we put focus back on the button,
// but ONLY when it is still rendered (the retry failed again, so there is something to press) AND
// focus is still on <body> (our own unmount dropped it, and the operator has not Tabbed elsewhere
// meanwhile) — the second condition is REQUIRED so this can never steal focus from wherever the
// operator moved to.
const retryEl = ref<HTMLButtonElement | null>(null)

async function restoreRetryFocus(el: Ref<HTMLButtonElement | null>): Promise<void> {
  await nextTick()
  if (document.activeElement === document.body) el.value?.focus()
}

async function onRetry(): Promise<void> {
  await loadList()
  await restoreRetryFocus(retryEl)
}

onMounted(loadList)
watch(() => props.projectId, loadList)
// watch (not @change) so the reload always sees the UPDATED filter value — v-model's own change
// handler and a template @change handler have no guaranteed relative order.
watch(statusFilter, reloadList)
</script>

<style scoped>
.sp-line {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
}

.sp-line__state {
  margin: 0;
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
  line-height: 1.6;
}

.sp-line__state--muted {
  color: var(--ms-text-3);
}

.sp-line__state--ok {
  color: var(--ms-text-2);
}

.sp-line__state--warn {
  color: var(--ms-color-danger, #c45656);
}

.sp-line__state-msg {
  margin: 0 0 var(--ms-space-2);
}

.sp-line__retry {
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: transparent;
  padding: 4px 12px;
  color: var(--ms-color-primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.sp-line__retry:hover:not(:disabled) {
  background: var(--el-fill-color-light);
}

.sp-line__retry:disabled {
  opacity: 0.5;
  cursor: default;
}

.sp-line__retry:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}

.sp-line__overview {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
}

.sp-line__summary {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: var(--ms-space-2);
}

.sp-line__metric {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
  padding: var(--ms-space-2) var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
}

.sp-line__metric-label {
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-line__metric-value {
  color: var(--ms-text-1);
  font-variant-numeric: tabular-nums;
  font-weight: var(--ms-font-weight-title);
  font-size: 18px;
}

.sp-line__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-1);
}

/* The server token, kept beside the words it means — subordinate, still copyable. */
.sp-line__token {
  display: inline-block;
  margin-left: var(--ms-space-1);
  color: var(--ms-text-3);
  font-size: 11px;
  word-break: break-all;
}

.sp-line__chip,
.sp-line__badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--el-fill-color-light);
  color: var(--ms-text-2);
  font-size: 12px;
}

.sp-line__generate,
.sp-line__table-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ms-space-3);
}

.sp-line__count {
  color: var(--ms-text-1);
  font-weight: var(--ms-font-weight-title);
}

.sp-line__field {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
  font-size: 13px;
  color: var(--ms-text-2);
}

.sp-line__field--inline {
  flex-direction: row;
  align-items: center;
  gap: var(--ms-space-2);
}

.sp-line__field-label {
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-line__field select {
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  padding: 4px 8px;
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  font: inherit;
  font-size: 13px;
}

.sp-line__note {
  color: var(--ms-text-3);
  font-size: 12px;
}

/* H4-3 long-table: bounded height + BOTH-axis overflow, so the table scrolls inside its OWN box and
   the sticky thead below has an actual scroll range to stick within (an `overflow-x: auto`-only wrap
   never scrolls vertically, so a sticky header inside it would never engage). */
.sp-line__table-wrap {
  max-height: 420px;
  overflow: auto;
}

.sp-line__table-wrap:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}

.sp-line__table {
  width: 100%;
  min-width: 820px;
  border-collapse: collapse;
  font-size: 13px;
}

.sp-line__table th,
.sp-line__table td {
  padding: var(--ms-space-2) var(--ms-space-3);
  border-bottom: 1px solid var(--ms-border-light);
  text-align: left;
  white-space: nowrap;
}

.sp-line__table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--ms-bg-card);
  color: var(--ms-text-3);
  font-weight: var(--ms-font-weight-title);
}

.sp-line__num {
  color: var(--ms-text-1);
  font-variant-numeric: tabular-nums;
}

.sp-line__handle {
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-line__action {
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: transparent;
  padding: 2px 10px;
  color: var(--ms-color-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.sp-line__action:disabled {
  color: var(--ms-text-3);
  cursor: not-allowed;
}

.sp-line__action:hover:not(:disabled) {
  background: var(--el-fill-color-light);
}

/* H4-3 keyboard: one focus-ring system across the stock-prep surface (same idiom as the H4-2
   dashboard/stepper rings). Covers the generate button and the prep-status filter. */
.sp-line__action:focus-visible,
.sp-line__field select:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}
</style>
