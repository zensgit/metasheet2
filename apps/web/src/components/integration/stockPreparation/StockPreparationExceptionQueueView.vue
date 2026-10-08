<template>
  <div class="sp-exq" data-testid="stock-prep-exception-view">
    <!-- No project selected: this slice has no project picker, so we simply ask for one. -->
    <p
      v-if="!hasProject"
      class="sp-exq__state sp-exq__state--muted"
      data-testid="stock-prep-exception-no-project"
      role="status"
    >
      {{ bi('请选择一个项目,这里会列出这个项目卡住的事。', 'Select a project and this page lists what is stuck on it.') }}
    </p>

    <!-- Loading: values-free spinner copy only. -->
    <p
      v-else-if="loading"
      class="sp-exq__state sp-exq__state--muted"
      data-testid="stock-prep-exception-loading"
      role="status"
    >
      {{ bi('正在读取待处理的事…', 'Reading what needs handling…') }}
    </p>

    <!-- Error / endpoint-not-ready (GET rejects or 404s): neutral, never the raw body. -->
    <div
      v-else-if="errored"
      class="sp-exq__state sp-exq__state--muted"
      data-testid="stock-prep-exception-error"
      role="status"
    >
      <p class="sp-exq__state-msg">{{ bi('同步后端尚未就绪,稍后再试。', 'Backend read not ready yet — try again later.') }}</p>
      <!-- H4-3 retry: re-runs the same readonly loadList(); idempotent, no new endpoint. -->
      <button
        ref="retryEl"
        type="button"
        class="sp-exq__retry"
        data-testid="stock-prep-exception-retry"
        :disabled="loading"
        :aria-label="bi('重试读取异常队列', 'Retry loading the exception queue')"
        @click="onRetry"
      >
        {{ bi('重试', 'Retry') }}
      </button>
    </div>

    <div v-else-if="list" class="sp-exq__overview" data-testid="stock-prep-exception-overview">
      <!-- Header cards: the blocking gate count + total + values-free type/status counts. -->
      <header class="sp-exq__summary" data-testid="stock-prep-exception-summary">
        <!-- CAVEAT (P3 FE cleanup, #3751): this count follows the ACTIVE status/type filters below
             (server stock-preparation-confirm-reads.cjs computes it over the post-filter subset) — it
             is a display figure for the current view, NOT the generation gate's determination. The
             generation route recomputes the real unresolved-blocking count over the full unfiltered
             set at run time; this header never gates or substitutes for that server recompute. -->
        <div
          class="sp-exq__metric"
          data-testid="stock-prep-exception-metric"
          data-kind="blocking"
          :title="bi(
            '当前视图筛选下的未解决阻断异常计数——展示口径,并非生成闸实际执行的判定值;生成时服务端会基于全量重新计算真实值。',
            'Unresolved blocking count under the current view filter — a display figure, not the value the generation gate enforces; the server recomputes it from the full set when generation runs.',
          )"
        >
          <span class="sp-exq__metric-label">
            {{ bi('卡着出不了料的事', 'Blocking the result') }}
            <span class="sp-exq__metric-caveat" data-testid="stock-prep-exception-blocking-caveat">
              {{ bi('(按当前筛选统计,不是最终判定)', '(counted under the current filter, not the final verdict)') }}
            </span>
          </span>
          <span class="sp-exq__metric-value" data-testid="stock-prep-exception-blocking-count">{{ list.unresolvedBlockingCount }}</span>
        </div>
        <div class="sp-exq__metric" data-testid="stock-prep-exception-metric" data-kind="total">
          <span class="sp-exq__metric-label">{{ bi('一共几件事', 'Things in total') }}</span>
          <span class="sp-exq__metric-value">{{ list.rowCount }}</span>
        </div>
        <div class="sp-exq__metric sp-exq__metric--chips" data-testid="stock-prep-exception-metric" data-kind="type">
          <span class="sp-exq__metric-label">{{ bi('按问题分', 'By what went wrong') }}</span>
          <span class="sp-exq__chips">
            <span
              v-for="entry in typeEntries"
              :key="entry.key"
              class="sp-exq__chip"
              data-testid="stock-prep-exception-type-count"
              :data-type="entry.key"
              :title="entry.key"
            >{{ typeLabel(entry.key) }}: {{ entry.count }}</span>
          </span>
        </div>
        <div class="sp-exq__metric sp-exq__metric--chips" data-testid="stock-prep-exception-metric" data-kind="status">
          <span class="sp-exq__metric-label">{{ bi('按进展分', 'By where it stands') }}</span>
          <span class="sp-exq__chips">
            <span
              v-for="entry in statusEntries"
              :key="entry.key"
              class="sp-exq__chip"
              data-testid="stock-prep-exception-status-count"
              :data-status="entry.key"
              :title="entry.key"
            >{{ statusLabel(entry.key) }}: {{ entry.count }}</span>
          </span>
        </div>
      </header>

      <!-- Queue filters (closed enums) + the REQUIRED resolution-action selector (no default): both
           the per-row and the bulk resolve stay disabled until the operator picks a reason. -->
      <div class="sp-exq__controls">
        <label class="sp-exq__field sp-exq__field--inline">
          <span class="sp-exq__field-label">{{ bi('只看这种进展', 'Show only') }}</span>
          <select v-model="statusFilter" data-testid="stock-prep-exception-filter-status">
            <option value="">{{ bi('全部', 'all') }}</option>
            <option v-for="status in exceptionStatuses" :key="status" :value="status">{{ statusLabel(status) }}</option>
          </select>
        </label>
        <label class="sp-exq__field sp-exq__field--inline">
          <span class="sp-exq__field-label">{{ bi('只看这类问题', 'Only this problem') }}</span>
          <select v-model="typeFilter" data-testid="stock-prep-exception-filter-type">
            <option value="">{{ bi('全部', 'all') }}</option>
            <option v-for="type in exceptionTypes" :key="type" :value="type">{{ typeLabel(type) }}</option>
          </select>
        </label>
        <label class="sp-exq__field sp-exq__field--inline">
          <span class="sp-exq__field-label">{{ bi('打算怎么处理(必选)', 'How to handle it (required)') }}</span>
          <select v-model="resolutionAction" data-testid="stock-prep-exception-action-select">
            <option value="" disabled>{{ bi('请先选一个处理办法', 'Pick how to handle it first') }}</option>
            <option v-for="action in resolutionActions" :key="action" :value="action">{{ actionLabel(action) }}</option>
          </select>
        </label>
      </div>

      <!-- Bulk bar: FE MIRROR of the server's same-reason gate (#3890) — mixed exceptionTypes
           disable the entry, but the server's 409 EXCEPTION_BULK_MIXED_TYPES stays authoritative. -->
      <div class="sp-exq__bulk" data-testid="stock-prep-exception-bulk-block">
        <span class="sp-exq__count" data-testid="stock-prep-exception-selected-count">
          {{ bi('已选', 'Selected') }}: {{ selectedIds.length }}
        </span>
        <button
          type="button"
          class="sp-exq__action"
          data-testid="stock-prep-exception-bulk-resolve"
          :disabled="busy || !resolutionAction || selectedIds.length === 0 || mixedTypesSelected"
          @click="bulkResolve"
        >
          {{ bi('选中的一起处理', 'Handle the selected ones together') }}
        </button>
        <span
          v-if="mixedTypesSelected"
          class="sp-exq__hint"
          data-testid="stock-prep-exception-mixed-hint"
          role="alert"
        >
          {{ bi(
            '您选的这几行不是同一类问题。一起处理只能用在同一类问题上 —— 请分批选,或逐条处理。',
            'The rows you picked are not all the same kind of problem. Handling several at once only works within one kind — select them in batches, or handle them one by one.',
          ) }}
        </span>
      </div>

      <!-- Row-action feedback (values-free: clamped code / field NAME / mode enums / counts only). -->
      <p v-if="actionNotice" class="sp-exq__state sp-exq__state--ok" data-testid="stock-prep-exception-action-notice">
        {{ bi('处理好了', 'Handled') }}<template v-if="actionNotice.resolved !== null">:{{ bi('处理了', 'handled') }} {{ actionNotice.resolved }} {{ bi('件,跳过', ', skipped') }} {{ actionNotice.skipped }} {{ bi('件(那几件已经处理过了)', ' that were already handled') }}</template>
        <code class="sp-exq__token">{{ actionNotice.mode }}</code>
      </p>
      <p v-if="actionError" class="sp-exq__state sp-exq__state--warn" data-testid="stock-prep-exception-action-error" role="alert">
        {{ bi(errorPlain(actionError.code).zh, errorPlain(actionError.code).en) }}
        <code class="sp-exq__token">{{ actionError.code }}<template v-if="actionError.field">/{{ actionError.field }}</template></code>
      </p>

      <p v-if="list.rowCount === 0" class="sp-exq__state sp-exq__state--muted" data-testid="stock-prep-exception-empty">
        {{ bi('没有需要处理的事 —— 都清了。', 'Nothing to handle — it is all clear.') }}
      </p>
      <!-- VALUES-FREE queue rows: handles + enums + booleans only — the exception message (business
           text) never crosses the wire, so it can never render here. Resolved rows are READ-ONLY:
           selection and resolve are disabled. -->
      <!-- H4-3 keyboard: this wrap is the scroll container (both axes). The select-checkbox and
           Resolve button are BOTH disabled once a row is resolved — a filter/view where every row is
           already resolved would leave NO focusable content, so the wrap itself is ALSO a native
           scroll-region. -->
      <div
        v-else
        class="sp-exq__table-wrap"
        tabindex="0"
        role="region"
        :aria-label="bi('异常队列表格,可滚动', 'Exception queue table, scrollable')"
      >
        <table class="sp-exq__table" data-testid="stock-prep-exception-queue">
          <thead>
            <tr>
              <th scope="col" class="sp-exq__col-select">{{ bi('选择', 'Select') }}</th>
              <th scope="col">{{ bi('编号', 'Reference') }}</th>
              <th scope="col">{{ bi('什么问题', 'What went wrong') }}</th>
              <th scope="col">{{ bi('要紧程度', 'How urgent') }}</th>
              <th scope="col">{{ bi('进展', 'Where it stands') }}</th>
              <th scope="col">{{ bi('怎么处理的', 'How it was handled') }}</th>
              <th scope="col">{{ bi('有人处理了吗', 'Someone handled it') }}</th>
              <th scope="col" class="sp-exq__col-action">{{ bi('操作', 'Actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, index) in list.rows"
              :key="row.exceptionId ?? `row-${index}`"
              class="sp-exq__row"
              data-testid="stock-prep-exception-row"
              :data-resolved="String(row.resolved)"
            >
              <td class="sp-exq__col-select">
                <input
                  type="checkbox"
                  data-testid="stock-prep-exception-row-select"
                  :disabled="row.resolved || !row.exceptionId || busy"
                  :checked="row.exceptionId !== null && selectedSet.has(row.exceptionId)"
                  @change="toggleSelect(row)"
                />
              </td>
              <td><code class="sp-exq__handle" data-testid="stock-prep-exception-row-handle">{{ row.exceptionId ?? '—' }}</code></td>
              <!-- PLAIN FIRST, TOKEN KEPT. The badge says what went wrong in words; the element
                   carrying the testid still holds the server enum, unchanged and byte-exact, because
                   that is what an implementer greps and what the values-free suites pin. -->
              <td>
                <span v-if="row.exceptionType" class="sp-exq__badge">{{ typeLabel(row.exceptionType) }}</span>
                <code class="sp-exq__token" data-testid="stock-prep-exception-row-type" :data-type="row.exceptionType ?? 'unknown'">{{ row.exceptionType ?? '—' }}</code>
              </td>
              <td>
                <span
                  v-if="row.severity"
                  class="sp-exq__badge"
                  :class="{ 'sp-exq__badge--blocking': row.severity === 'blocking' }"
                >{{ severityLabel(row.severity) }}</span>
                <code class="sp-exq__token" data-testid="stock-prep-exception-row-severity" :data-severity="row.severity ?? 'unknown'">{{ row.severity ?? '—' }}</code>
              </td>
              <td>
                <span v-if="row.status" class="sp-exq__badge">{{ statusLabel(row.status) }}</span>
                <code class="sp-exq__token" data-testid="stock-prep-exception-row-status" :data-status="row.status ?? 'unknown'">{{ row.status ?? '—' }}</code>
              </td>
              <td>
                <span v-if="row.resolutionAction" class="sp-exq__badge">{{ actionLabel(row.resolutionAction) }}</span>
                <code class="sp-exq__token" data-testid="stock-prep-exception-row-resolution" :data-action="row.resolutionAction ?? 'none'">{{ row.resolutionAction ?? '—' }}</code>
              </td>
              <td data-testid="stock-prep-exception-row-resolver" :data-flag="String(row.resolvedByPresent)">
                {{ row.resolvedByPresent ? bi('有', 'yes') : bi('无', 'not yet') }}
              </td>
              <td class="sp-exq__col-action">
                <button
                  type="button"
                  class="sp-exq__action"
                  data-testid="stock-prep-exception-row-resolve"
                  :disabled="row.resolved || !row.exceptionId || !resolutionAction || busy"
                  @click="resolveRow(row)"
                >
                  {{ bi('处理掉', 'Handle it') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- The vocabularies this queue speaks, and the one caveat the blocking count carries. -->
      <StockPrepTechnicalDetails testid="stock-prep-exception-tech">
        <dl>
          <dt>{{ bi('问题类型枚举', 'Exception-type vocabulary') }}</dt>
          <dd>
            <span v-for="type in exceptionTypes" :key="type"><code>{{ type }}</code> = {{ typeLabel(type) }}; </span>
          </dd>
          <dt>{{ bi('进展枚举', 'Status vocabulary') }}</dt>
          <dd>
            <span v-for="status in exceptionStatuses" :key="status"><code>{{ status }}</code> = {{ statusLabel(status) }}; </span>
          </dd>
          <dt>{{ bi('处理办法枚举', 'Resolution-action vocabulary') }}</dt>
          <dd>
            <span v-for="action in resolutionActions" :key="action"><code>{{ action }}</code> = {{ actionLabel(action) }}; </span>
          </dd>
          <dt>{{ bi('阻断计数的口径', 'What the blocking count is') }}</dt>
          <dd>
            {{ bi(
              '当前视图筛选下的未解决阻断异常计数 —— 展示口径,并非生成闸实际执行的判定值;生成时服务端会基于全量重新计算真实值。',
              'The unresolved blocking count under the current view filter — a display figure, not the value the generation gate enforces; the server recomputes it from the full set when generation runs.',
            ) }}
          </dd>
          <dt>{{ bi('批量同因闸', 'Same-reason bulk gate') }}</dt>
          <dd>
            {{ bi(
              '批量解决要求所选行 exceptionType 一致;前端只是镜像,服务端 409 EXCEPTION_BULK_MIXED_TYPES 为准。',
              'A bulk resolve requires one shared exceptionType. The front end only mirrors that; the server\'s 409 EXCEPTION_BULK_MIXED_TYPES stays authoritative.',
            ) }}
          </dd>
        </dl>
      </StockPrepTechnicalDetails>
    </div>
  </div>
</template>

<script setup lang="ts">
// Stock Preparation MVP (#3751 — docs/development/stock-preparation-mvp-design-20260707.md),
// Frontend MVP view 6: EXCEPTION CONFIRMATION QUEUE, rendered inside the workspace shell's sixth
// tab. Reads = W5a values-free exception queue; writes = W4a human resolution (single + bulk) —
// MULTITABLE-INTERNAL row patches only, no external ERP/K3 write.
//
// VALUES-FREE: the template reads a fixed whitelist — counts, exception type/severity/status/
// resolution enums, presence booleans, and sha16 handles. The exception `message` never crosses the
// wire; error surfaces render only the clamped code / field NAME.
//
// SAME-REASON MIRROR (#3890): the bulk entry disables itself when the selection mixes
// exceptionTypes — a pure convenience mirror; the server's 409 EXCEPTION_BULK_MIXED_TYPES gate
// (checked BEFORE any patch) stays authoritative and lands in the same error surface.
// resolvedBy / resolvedAt are server-stamped and NEVER enter any request body.
import { computed, nextTick, onMounted, ref, watch, type Ref } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import type { IntegrationScope } from '../../../services/integration/workbench'
import { StockPreparationConfirmApiError } from '../../../services/integration/stockPreparation/confirmApi'
import {
  STOCK_PREPARATION_EXCEPTION_STATUSES,
  STOCK_PREPARATION_EXCEPTION_TYPES,
  STOCK_PREPARATION_RESOLUTION_ACTIONS,
  bulkResolveStockPreparationExceptions,
  listStockPreparationExceptions,
  resolveStockPreparationException,
  type StockPreparationExceptionList,
  type StockPreparationExceptionRow,
  type StockPreparationExceptionStatus,
  type StockPreparationExceptionType,
  type StockPreparationResolutionAction,
} from '../../../services/integration/stockPreparation/exceptionQueue'
import StockPrepTechnicalDetails from './StockPrepTechnicalDetails.vue'
import {
  STOCK_PREP_EXCEPTION_ACTION_PLAIN,
  STOCK_PREP_EXCEPTION_SEVERITY_PLAIN,
  STOCK_PREP_EXCEPTION_STATUS_PLAIN,
  STOCK_PREP_EXCEPTION_TYPE_PLAIN,
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

// Same synchronous locale idiom as the shell / views 1-5 / the rest of the integration surface.
function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

/**
 * The four server vocabularies in words. Every one falls back to the raw token, so an enum added
 * server-side reads exactly as it does today instead of blanking a cell — and the token itself is
 * still on screen beside the words, because it is what a support thread quotes.
 */
function typeLabel(type: string | null): string {
  const plain = stockPrepEnumPlain(STOCK_PREP_EXCEPTION_TYPE_PLAIN, type)
  return plain ? bi(plain.zh, plain.en) : (type ?? '—')
}

function severityLabel(severity: string | null): string {
  const plain = stockPrepEnumPlain(STOCK_PREP_EXCEPTION_SEVERITY_PLAIN, severity)
  return plain ? bi(plain.zh, plain.en) : (severity ?? '—')
}

function statusLabel(status: string | null): string {
  const plain = stockPrepEnumPlain(STOCK_PREP_EXCEPTION_STATUS_PLAIN, status)
  return plain ? bi(plain.zh, plain.en) : (status ?? '—')
}

function actionLabel(action: string | null): string {
  const plain = stockPrepEnumPlain(STOCK_PREP_EXCEPTION_ACTION_PLAIN, action)
  return plain ? bi(plain.zh, plain.en) : (action ?? '—')
}

const errorPlain = stockPrepErrorPlain

const exceptionStatuses = STOCK_PREPARATION_EXCEPTION_STATUSES
const exceptionTypes = STOCK_PREPARATION_EXCEPTION_TYPES
const resolutionActions = STOCK_PREPARATION_RESOLUTION_ACTIONS

const hasProject = computed(() => Boolean(props.projectId))

const loading = ref(Boolean(props.projectId))
const errored = ref(false)
const list = ref<StockPreparationExceptionList | null>(null)

const statusFilter = ref<'' | StockPreparationExceptionStatus>('')
const typeFilter = ref<'' | StockPreparationExceptionType>('')
const resolutionAction = ref<'' | StockPreparationResolutionAction>('')

const busy = ref(false)
const actionNotice = ref<{ mode: string; resolved: number | null; skipped: number | null } | null>(null)
const actionError = ref<{ code: string; field: string | null } | null>(null)

// Selection is a set of exceptionId handles; it is PRUNED on every reload so a resolved or
// filtered-out row can never linger in the bulk payload.
const selectedSet = ref<Set<string>>(new Set())
const selectedIds = computed(() => [...selectedSet.value])

const selectedRows = computed<StockPreparationExceptionRow[]>(() =>
  (list.value?.rows ?? []).filter((row) => row.exceptionId !== null && selectedSet.value.has(row.exceptionId)),
)

// FE mirror of the server's same-reason gate: >1 distinct exceptionType (absent folds to 'unknown',
// matching the server's bulk-gate fold) disables the bulk entry.
const mixedTypesSelected = computed(() => {
  const types = new Set(selectedRows.value.map((row) => row.exceptionType ?? 'unknown'))
  return types.size > 1
})

const typeEntries = computed(() =>
  Object.entries(list.value?.byType ?? {}).map(([key, count]) => ({ key, count })),
)
const statusEntries = computed(() =>
  Object.entries(list.value?.byStatus ?? {}).map(([key, count]) => ({ key, count })),
)

function requestScope(): IntegrationScope & { projectId: string } {
  return { ...props.scope, projectId: props.projectId as string }
}

function pruneSelection(): void {
  const alive = new Set(
    (list.value?.rows ?? [])
      .filter((row) => row.exceptionId !== null && !row.resolved)
      .map((row) => row.exceptionId as string),
  )
  selectedSet.value = new Set([...selectedSet.value].filter((id) => alive.has(id)))
}

async function loadList(): Promise<void> {
  if (!props.projectId) {
    loading.value = false
    errored.value = false
    list.value = null
    selectedSet.value = new Set()
    return
  }
  loading.value = true
  errored.value = false
  try {
    list.value = await listStockPreparationExceptions({
      ...requestScope(),
      status: statusFilter.value || undefined,
      exceptionType: typeFilter.value || undefined,
    })
    pruneSelection()
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
    list.value = await listStockPreparationExceptions({
      ...requestScope(),
      status: statusFilter.value || undefined,
      exceptionType: typeFilter.value || undefined,
    })
    pruneSelection()
  } catch {
    errored.value = true
    list.value = null
  }
}

function toggleSelect(row: StockPreparationExceptionRow): void {
  if (!row.exceptionId || row.resolved) return
  const next = new Set(selectedSet.value)
  if (next.has(row.exceptionId)) {
    next.delete(row.exceptionId)
  } else {
    next.add(row.exceptionId)
  }
  selectedSet.value = next
}

function captureActionError(error: unknown): void {
  if (error instanceof StockPreparationConfirmApiError) {
    actionError.value = { code: error.code, field: error.field }
  } else {
    actionError.value = { code: 'STOCK_PREPARATION_CONFIRM_REQUEST_FAILED', field: null }
  }
}

function resetFeedback(): void {
  actionNotice.value = null
  actionError.value = null
}

async function resolveRow(row: StockPreparationExceptionRow): Promise<void> {
  // Layer B of the required-action gate (layer A disables the button); resolved rows are read-only.
  if (!row.exceptionId || row.resolved || !resolutionAction.value || busy.value) return
  resetFeedback()
  busy.value = true
  try {
    const result = await resolveStockPreparationException(
      { exceptionId: row.exceptionId, resolutionAction: resolutionAction.value },
      requestScope(),
    )
    actionNotice.value = { mode: result.mode, resolved: null, skipped: null }
    await reloadList()
  } catch (error) {
    captureActionError(error)
  } finally {
    busy.value = false
  }
}

async function bulkResolve(): Promise<void> {
  if (selectedIds.value.length === 0 || !resolutionAction.value || mixedTypesSelected.value || busy.value) return
  resetFeedback()
  busy.value = true
  try {
    const result = await bulkResolveStockPreparationExceptions(
      { exceptionIds: selectedIds.value, resolutionAction: resolutionAction.value },
      requestScope(),
    )
    actionNotice.value = { mode: result.mode, resolved: result.resolved, skipped: result.skipped }
    await reloadList()
  } catch (error) {
    captureActionError(error)
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
watch([statusFilter, typeFilter], reloadList)
</script>

<style scoped>
.sp-exq {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
}

.sp-exq__state {
  margin: 0;
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
  line-height: 1.6;
}

.sp-exq__state--muted {
  color: var(--ms-text-3);
}

.sp-exq__state--ok {
  color: var(--ms-text-2);
}

.sp-exq__state--warn {
  color: var(--ms-color-danger, #c45656);
}

.sp-exq__state-msg {
  margin: 0 0 var(--ms-space-2);
}

.sp-exq__retry {
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: transparent;
  padding: 4px 12px;
  color: var(--ms-color-primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.sp-exq__retry:hover:not(:disabled) {
  background: var(--el-fill-color-light);
}

.sp-exq__retry:disabled {
  opacity: 0.5;
  cursor: default;
}

.sp-exq__retry:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}

.sp-exq__overview {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
}

.sp-exq__summary {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: var(--ms-space-2);
}

.sp-exq__metric {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
  padding: var(--ms-space-2) var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
}

.sp-exq__metric-label {
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-exq__metric-caveat {
  display: block;
  font-size: 11px;
  font-style: italic;
  color: var(--ms-text-3);
  opacity: 0.85;
}

.sp-exq__metric-value {
  color: var(--ms-text-1);
  font-variant-numeric: tabular-nums;
  font-weight: var(--ms-font-weight-title);
  font-size: 18px;
}

.sp-exq__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-1);
}

/* The server token, kept beside the words it means: still selectable and copyable, visibly
   subordinate to the badge in front of it. */
.sp-exq__token {
  display: inline-block;
  margin-left: var(--ms-space-1);
  color: var(--ms-text-3);
  font-size: 11px;
  word-break: break-all;
}

.sp-exq__badge--blocking {
  background: var(--el-color-danger-light-9, #fde2e2);
  color: var(--el-color-danger, #c45656);
}

.sp-exq__chip,
.sp-exq__badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--el-fill-color-light);
  color: var(--ms-text-2);
  font-size: 12px;
}

.sp-exq__controls,
.sp-exq__bulk {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ms-space-3);
}

.sp-exq__count {
  color: var(--ms-text-1);
  font-weight: var(--ms-font-weight-title);
}

.sp-exq__hint {
  color: var(--ms-color-danger, #c45656);
  font-size: 12px;
}

.sp-exq__field {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
  font-size: 13px;
  color: var(--ms-text-2);
}

.sp-exq__field--inline {
  flex-direction: row;
  align-items: center;
  gap: var(--ms-space-2);
}

.sp-exq__field-label {
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-exq__field select {
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  padding: 4px 8px;
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  font: inherit;
  font-size: 13px;
}

/* H4-3 long-table: bounded height + BOTH-axis overflow, so the table scrolls inside its OWN box and
   the sticky thead below has an actual scroll range to stick within (an `overflow-x: auto`-only wrap
   never scrolls vertically, so a sticky header inside it would never engage). */
.sp-exq__table-wrap {
  max-height: 420px;
  overflow: auto;
}

.sp-exq__table-wrap:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}

.sp-exq__table {
  width: 100%;
  min-width: 840px;
  border-collapse: collapse;
  font-size: 13px;
}

.sp-exq__table th,
.sp-exq__table td {
  padding: var(--ms-space-2) var(--ms-space-3);
  border-bottom: 1px solid var(--ms-border-light);
  text-align: left;
  white-space: nowrap;
}

.sp-exq__table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--ms-bg-card);
  color: var(--ms-text-3);
  font-weight: var(--ms-font-weight-title);
}

.sp-exq__handle {
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-exq__col-select {
  width: 40px;
}

.sp-exq__col-action {
  text-align: right;
}

.sp-exq__action {
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: transparent;
  padding: 2px 10px;
  color: var(--ms-color-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.sp-exq__action:disabled {
  color: var(--ms-text-3);
  cursor: not-allowed;
}

.sp-exq__action:hover:not(:disabled) {
  background: var(--el-fill-color-light);
}

/* H4-3 keyboard: one focus-ring system across the stock-prep surface (same idiom as the H4-2
   dashboard/stepper rings). Covers the resolve/bulk-resolve buttons, the 3 filter/action selects, and
   the per-row select-checkbox (native, but the UA default ring is inconsistent across browsers). */
.sp-exq__action:focus-visible,
.sp-exq__field select:focus-visible,
.sp-exq__col-select input[type='checkbox']:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}
</style>
