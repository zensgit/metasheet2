<template>
  <div class="sp-exq" data-testid="stock-prep-exception-view">
    <!-- No project selected: this slice has no project picker, so we simply ask for one. -->
    <p
      v-if="!hasProject"
      class="sp-exq__state sp-exq__state--muted"
      data-testid="stock-prep-exception-no-project"
      role="status"
    >
      {{ bi('请选择一个项目以查看异常确认队列。', 'Select a project to see the exception confirmation queue.') }}
    </p>

    <!-- Loading: values-free spinner copy only. -->
    <p
      v-else-if="loading"
      class="sp-exq__state sp-exq__state--muted"
      data-testid="stock-prep-exception-loading"
      role="status"
    >
      {{ bi('正在加载异常队列…', 'Loading exception queue…') }}
    </p>

    <!-- Error / endpoint-not-ready (GET rejects or 404s): neutral, never the raw body. -->
    <p
      v-else-if="errored"
      class="sp-exq__state sp-exq__state--muted"
      data-testid="stock-prep-exception-error"
      role="status"
    >
      {{ bi('同步后端尚未就绪,稍后再试。', 'Backend read not ready yet — try again later.') }}
    </p>

    <div v-else-if="list" class="sp-exq__overview" data-testid="stock-prep-exception-overview">
      <!-- Header cards: the blocking gate count + total + values-free type/status counts. -->
      <header class="sp-exq__summary" data-testid="stock-prep-exception-summary">
        <div class="sp-exq__metric" data-testid="stock-prep-exception-metric" data-kind="blocking">
          <span class="sp-exq__metric-label">{{ bi('未解决阻断异常', 'Unresolved blocking') }}</span>
          <span class="sp-exq__metric-value" data-testid="stock-prep-exception-blocking-count">{{ list.unresolvedBlockingCount }}</span>
        </div>
        <div class="sp-exq__metric" data-testid="stock-prep-exception-metric" data-kind="total">
          <span class="sp-exq__metric-label">{{ bi('异常总数', 'Total exceptions') }}</span>
          <span class="sp-exq__metric-value">{{ list.rowCount }}</span>
        </div>
        <div class="sp-exq__metric sp-exq__metric--chips" data-testid="stock-prep-exception-metric" data-kind="type">
          <span class="sp-exq__metric-label">{{ bi('按异常类型', 'By type') }}</span>
          <span class="sp-exq__chips">
            <span
              v-for="entry in typeEntries"
              :key="entry.key"
              class="sp-exq__chip"
              data-testid="stock-prep-exception-type-count"
              :data-type="entry.key"
            >{{ entry.key }}: {{ entry.count }}</span>
          </span>
        </div>
        <div class="sp-exq__metric sp-exq__metric--chips" data-testid="stock-prep-exception-metric" data-kind="status">
          <span class="sp-exq__metric-label">{{ bi('按状态', 'By status') }}</span>
          <span class="sp-exq__chips">
            <span
              v-for="entry in statusEntries"
              :key="entry.key"
              class="sp-exq__chip"
              data-testid="stock-prep-exception-status-count"
              :data-status="entry.key"
            >{{ entry.key }}: {{ entry.count }}</span>
          </span>
        </div>
      </header>

      <!-- Queue filters (closed enums) + the REQUIRED resolution-action selector (no default): both
           the per-row and the bulk resolve stay disabled until the operator picks a reason. -->
      <div class="sp-exq__controls">
        <label class="sp-exq__field sp-exq__field--inline">
          <span class="sp-exq__field-label">{{ bi('状态过滤', 'Status filter') }}</span>
          <select v-model="statusFilter" data-testid="stock-prep-exception-filter-status">
            <option value="">{{ bi('全部', 'all') }}</option>
            <option v-for="status in exceptionStatuses" :key="status" :value="status">{{ status }}</option>
          </select>
        </label>
        <label class="sp-exq__field sp-exq__field--inline">
          <span class="sp-exq__field-label">{{ bi('类型过滤', 'Type filter') }}</span>
          <select v-model="typeFilter" data-testid="stock-prep-exception-filter-type">
            <option value="">{{ bi('全部', 'all') }}</option>
            <option v-for="type in exceptionTypes" :key="type" :value="type">{{ type }}</option>
          </select>
        </label>
        <label class="sp-exq__field sp-exq__field--inline">
          <span class="sp-exq__field-label">{{ bi('处理动作(必选)', 'Resolution action (required)') }}</span>
          <select v-model="resolutionAction" data-testid="stock-prep-exception-action-select">
            <option value="" disabled>{{ bi('请选择处理动作', 'Select a resolution action') }}</option>
            <option v-for="action in resolutionActions" :key="action" :value="action">{{ action }}</option>
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
          {{ bi('批量解决', 'Bulk resolve') }}
        </button>
        <span
          v-if="mixedTypesSelected"
          class="sp-exq__hint"
          data-testid="stock-prep-exception-mixed-hint"
          role="alert"
        >
          {{ bi(
            '所选行的异常类型不一致——批量解决要求同一类型(同因闸,以服务端校验为准)。',
            'Selected rows mix exception types — bulk resolve requires ONE shared type (same-reason gate; the server check stays authoritative).',
          ) }}
        </span>
      </div>

      <!-- Row-action feedback (values-free: clamped code / field NAME / mode enums / counts only). -->
      <p v-if="actionNotice" class="sp-exq__state sp-exq__state--ok" data-testid="stock-prep-exception-action-notice">
        {{ bi('操作完成', 'Action done') }}: {{ actionNotice.mode }}
        <template v-if="actionNotice.resolved !== null"> · {{ bi('已解决', 'resolved') }} {{ actionNotice.resolved }} · {{ bi('跳过', 'skipped') }} {{ actionNotice.skipped }}</template>
      </p>
      <p v-if="actionError" class="sp-exq__state sp-exq__state--warn" data-testid="stock-prep-exception-action-error" role="alert">
        {{ bi('操作失败', 'Action failed') }} ({{ actionError.code }}<template v-if="actionError.field">/{{ actionError.field }}</template>)
      </p>

      <p v-if="list.rowCount === 0" class="sp-exq__state sp-exq__state--muted" data-testid="stock-prep-exception-empty">
        {{ bi('当前无异常行。', 'No exception rows.') }}
      </p>
      <!-- VALUES-FREE queue rows: handles + enums + booleans only — the exception message (business
           text) never crosses the wire, so it can never render here. Resolved rows are READ-ONLY:
           selection and resolve are disabled. -->
      <div v-else class="sp-exq__table-wrap">
        <table class="sp-exq__table" data-testid="stock-prep-exception-queue">
          <thead>
            <tr>
              <th scope="col" class="sp-exq__col-select">{{ bi('选择', 'Select') }}</th>
              <th scope="col">{{ bi('异常标识', 'Exception handle') }}</th>
              <th scope="col">{{ bi('类型', 'Type') }}</th>
              <th scope="col">{{ bi('级别', 'Severity') }}</th>
              <th scope="col">{{ bi('状态', 'Status') }}</th>
              <th scope="col">{{ bi('处理动作', 'Resolution') }}</th>
              <th scope="col">{{ bi('处理人', 'Resolver') }}</th>
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
              <td>
                <span class="sp-exq__badge" data-testid="stock-prep-exception-row-type" :data-type="row.exceptionType ?? 'unknown'">
                  {{ row.exceptionType ?? '—' }}
                </span>
              </td>
              <td>
                <span class="sp-exq__badge" data-testid="stock-prep-exception-row-severity" :data-severity="row.severity ?? 'unknown'">
                  {{ row.severity ?? '—' }}
                </span>
              </td>
              <td>
                <span class="sp-exq__badge" data-testid="stock-prep-exception-row-status" :data-status="row.status ?? 'unknown'">
                  {{ row.status ?? '—' }}
                </span>
              </td>
              <td>
                <span class="sp-exq__badge" data-testid="stock-prep-exception-row-resolution" :data-action="row.resolutionAction ?? 'none'">
                  {{ row.resolutionAction ?? '—' }}
                </span>
              </td>
              <td data-testid="stock-prep-exception-row-resolver" :data-flag="String(row.resolvedByPresent)">
                {{ row.resolvedByPresent ? bi('有', 'present') : bi('无', 'absent') }}
              </td>
              <td class="sp-exq__col-action">
                <button
                  type="button"
                  class="sp-exq__action"
                  data-testid="stock-prep-exception-row-resolve"
                  :disabled="row.resolved || !row.exceptionId || !resolutionAction || busy"
                  @click="resolveRow(row)"
                >
                  {{ bi('解决', 'Resolve') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
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
import { computed, onMounted, ref, watch } from 'vue'
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

.sp-exq__table-wrap {
  overflow-x: auto;
}

.sp-exq__table {
  width: 100%;
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
</style>
