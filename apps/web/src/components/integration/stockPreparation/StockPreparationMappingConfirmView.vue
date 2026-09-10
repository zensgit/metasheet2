<template>
  <div class="sp-map" data-testid="stock-prep-mapping-view">
    <!-- No project selected: this slice has no project picker, so we simply ask for one. -->
    <p
      v-if="!hasProject"
      class="sp-map__state sp-map__state--muted"
      data-testid="stock-prep-mapping-no-project"
      role="status"
    >
      {{ bi('请选择一个项目,这里会列出等着对物料的行。', 'Select a project and this page lists what still needs matching to a material.') }}
    </p>

    <!-- Loading: values-free spinner copy only. -->
    <p
      v-else-if="loading"
      class="sp-map__state sp-map__state--muted"
      data-testid="stock-prep-mapping-loading"
      role="status"
    >
      {{ bi('正在读取物料对应关系…', 'Reading the material matches…') }}
    </p>

    <!-- Error / endpoint-not-ready (GET rejects or 404s): neutral, never the raw body. -->
    <div
      v-else-if="errored"
      class="sp-map__state sp-map__state--muted"
      data-testid="stock-prep-mapping-error"
      role="status"
    >
      <p class="sp-map__state-msg">{{ bi('同步后端尚未就绪,稍后再试。', 'Backend read not ready yet — try again later.') }}</p>
      <!-- H4-3 retry: re-runs the same readonly loadAll(); idempotent, no new endpoint. -->
      <button
        ref="retryEl"
        type="button"
        class="sp-map__retry"
        data-testid="stock-prep-mapping-retry"
        :disabled="loading"
        :aria-label="bi('重试读取物料映射确认', 'Retry loading the material-mapping confirmation queue')"
        @click="onRetry"
      >
        {{ bi('重试', 'Retry') }}
      </button>
    </div>

    <div v-else-if="summary && queue" class="sp-map__overview" data-testid="stock-prep-mapping-overview">
      <!-- Summary header card: the five values-free summary indicators. -->
      <header class="sp-map__summary" data-testid="stock-prep-mapping-summary">
        <div class="sp-map__metric" data-testid="stock-prep-mapping-metric" data-kind="total">
          <span class="sp-map__metric-label">{{ bi('一共记了多少条对应关系', 'Matches on record') }}</span>
          <span class="sp-map__metric-value">{{ summary.totalMappingCount }}</span>
        </div>
        <div class="sp-map__metric" data-testid="stock-prep-mapping-metric" data-kind="active">
          <span class="sp-map__metric-label">{{ bi('正在用的', 'In use') }}</span>
          <span class="sp-map__metric-value">{{ summary.activeMappingCount }}</span>
        </div>
        <div class="sp-map__metric" data-testid="stock-prep-mapping-metric" data-kind="pending-confirm">
          <span class="sp-map__metric-label">{{ bi('等您确认的', 'Waiting for you' ) }}</span>
          <span class="sp-map__metric-value">{{ summary.pendingConfirmCount }}</span>
        </div>
        <div class="sp-map__metric sp-map__metric--chips" data-testid="stock-prep-mapping-metric" data-kind="match-status">
          <span class="sp-map__metric-label">{{ bi('对上了没有', 'Matched or not') }}</span>
          <span class="sp-map__chips">
            <span
              v-for="entry in summaryStatusEntries"
              :key="entry.key"
              class="sp-map__chip"
              data-testid="stock-prep-mapping-status-count"
              :data-status="entry.key"
              :title="entry.key"
            >{{ matchStatusLabel(entry.key) }}: {{ entry.count }}</span>
          </span>
        </div>
        <div class="sp-map__metric sp-map__metric--chips" data-testid="stock-prep-mapping-metric" data-kind="version-policy">
          <span class="sp-map__metric-label">{{ bi('按什么算同一个物料', 'What counts as the same material') }}</span>
          <span class="sp-map__chips">
            <span
              v-for="entry in summaryPolicyEntries"
              :key="entry.key"
              class="sp-map__chip"
              data-testid="stock-prep-mapping-policy-count"
              :data-policy="entry.key"
              :title="entry.key"
            >{{ versionPolicyLabel(entry.key) }}: {{ entry.count }}</span>
          </span>
        </div>
      </header>

      <!-- CAVEAT (P3 FE cleanup, #3751): the mapping table has no projectId field (server
           stock-preparation-confirm-reads.cjs R3) — it is a tenant-level, cross-project reuse asset
           by design, so the five counts above are NOT filtered to the project selected in this view. -->
      <p class="sp-map__scope-note" data-testid="stock-prep-mapping-scope-note" role="note">
        {{ bi(
          '物料对应关系是全公司共用的:一旦对上,别的项目也能直接用。所以上面这几个数统计的是全部,不只是当前选中的项目。',
          'A material match is shared company-wide: once it is made, other projects reuse it. So the counts above cover everything, not just the project selected here.',
        ) }}
      </p>

      <!-- Candidate sync: feeds the review queue. defaultVersionPolicy is REQUIRED with NO default
           (OD2) — the sync entry stays disabled until the operator picks one. -->
      <div class="sp-map__sync" data-testid="stock-prep-mapping-sync-block">
        <label class="sp-map__field">
          <span class="sp-map__field-label">{{ bi('按什么算同一个物料(必选)', 'What counts as the same material (required)') }}</span>
          <select v-model="syncPolicy" data-testid="stock-prep-mapping-sync-policy">
            <option value="" disabled>{{ bi('请先选一个', 'Pick one first') }}</option>
            <option v-for="policy in versionPolicies" :key="policy" :value="policy">{{ versionPolicyLabel(policy) }}</option>
          </select>
        </label>
        <button
          type="button"
          class="sp-map__action"
          data-testid="stock-prep-mapping-sync"
          :disabled="!syncPolicy || busy"
          @click="runCandidateSync"
        >
          {{ bi('去找可能对得上的物料', 'Look for materials that might match') }}
        </button>
        <span v-if="syncResult" class="sp-map__note" data-testid="stock-prep-mapping-sync-result">
          {{ bi('找完了,新增了', 'Done — added') }} {{ syncResult.created.mappings }} {{ bi('条待确认的对应关系。', 'match(es) for you to confirm.') }}
          <code class="sp-map__token">{{ syncResult.mode }}</code>
        </span>
      </div>

      <!-- Row-action feedback (values-free: clamped code / field NAME / mode enums only). -->
      <p v-if="actionNotice" class="sp-map__state sp-map__state--ok" data-testid="stock-prep-mapping-action-notice">
        {{ bi('保存好了。', 'Saved.') }}
        <code class="sp-map__token">{{ actionNotice.mode }}</code>
        <code v-if="actionNotice.handle" class="sp-map__handle">{{ actionNotice.handle }}</code>
      </p>
      <p v-if="actionError" class="sp-map__state sp-map__state--warn" data-testid="stock-prep-mapping-action-error" role="alert">
        {{ bi(errorPlain(actionError.code).zh, errorPlain(actionError.code).en) }}
        <code class="sp-map__token">{{ actionError.code }}<template v-if="actionError.field">/{{ actionError.field }}</template></code>
      </p>

      <!-- Review queue: matchStatus filter + values-free candidate rows. -->
      <div class="sp-map__queue-head">
        <span class="sp-map__queue-count" data-testid="stock-prep-mapping-queue-count">
          {{ bi('待看的对应关系', 'Matches to review') }}: {{ queue.rowCount }}
        </span>
        <label class="sp-map__field sp-map__field--inline">
          <span class="sp-map__field-label">{{ bi('只看', 'Show only') }}</span>
          <select v-model="statusFilter" data-testid="stock-prep-mapping-filter">
            <option value="">{{ bi('全部', 'all') }}</option>
            <option v-for="status in matchStatuses" :key="status" :value="status">{{ matchStatusLabel(status) }}</option>
          </select>
        </label>
      </div>

      <p v-if="queue.rowCount === 0" class="sp-map__state sp-map__state--muted" data-testid="stock-prep-mapping-empty">
        {{ bi('没有等着看的对应关系。', 'Nothing here is waiting to be reviewed.') }}
      </p>
      <!-- H4-3 keyboard: this wrap is the scroll container (both axes). Confirm/Retire are DISABLED
           when a row lacks mappingId/hasErpTarget — if every row in the current filter lacked those,
           row content alone would give a keyboard operator no way to reach this scroll area, so the
           wrap itself is ALSO a native scroll-region. -->
      <div
        v-else
        class="sp-map__table-wrap"
        tabindex="0"
        role="region"
        :aria-label="bi('物料映射候选行表格,可滚动', 'Material-mapping candidate table, scrollable')"
      >
        <table class="sp-map__table" data-testid="stock-prep-mapping-queue">
          <thead>
            <tr>
              <th scope="col">{{ bi('编号', 'Reference') }}</th>
              <th scope="col">{{ bi('对上了没有', 'Matched or not') }}</th>
              <th scope="col">{{ bi('凭什么认为是它', 'Why we think it matches') }}</th>
              <th scope="col">{{ bi('有多确定', 'How sure') }}</th>
              <th scope="col">{{ bi('按什么算同一个', 'What counts as the same') }}</th>
              <th scope="col">{{ bi('ERP 物料齐了吗', 'ERP material complete') }}</th>
              <th scope="col">{{ bi('有 PLM 版本吗', 'PLM version present') }}</th>
              <th scope="col">{{ bi('确认过了吗', 'Confirmed yet') }}</th>
              <th scope="col" class="sp-map__col-action">{{ bi('操作', 'Actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, index) in queue.rows"
              :key="row.mappingId ?? `row-${index}`"
              class="sp-map__row"
              data-testid="stock-prep-mapping-row"
            >
              <td><code class="sp-map__handle" data-testid="stock-prep-mapping-row-handle">{{ row.mappingId ?? '—' }}</code></td>
              <!-- PLAIN FIRST, TOKEN KEPT: the badge carries the words, the testid'd element keeps
                   the server enum byte-exact for grepping and for the values-free suites. -->
              <td>
                <span class="sp-map__badge">{{ matchStatusLabel(row.matchStatus) }}</span>
                <code class="sp-map__token" data-testid="stock-prep-mapping-row-status" :data-status="row.matchStatus">{{ row.matchStatus }}</code>
              </td>
              <td data-testid="stock-prep-mapping-row-method">
                <span v-if="row.matchMethod">{{ matchMethodLabel(row.matchMethod) }}</span>
                <code v-if="row.matchMethod" class="sp-map__token">{{ row.matchMethod }}</code>
                <template v-else>—</template>
              </td>
              <td class="sp-map__num" data-testid="stock-prep-mapping-row-confidence">{{ row.confidence ?? '—' }}</td>
              <td data-testid="stock-prep-mapping-row-policy">
                <span>{{ versionPolicyLabel(row.versionPolicy) }}</span>
                <code class="sp-map__token">{{ row.versionPolicy }}</code>
              </td>
              <td data-testid="stock-prep-mapping-row-erp-target" :data-flag="String(row.hasErpTarget)">
                {{ row.hasErpTarget ? bi('齐了', 'yes') : bi('还差', 'not yet') }}
              </td>
              <td data-testid="stock-prep-mapping-row-version-present" :data-flag="String(row.plmVersionPresent)">
                {{ row.plmVersionPresent ? bi('有', 'yes') : bi('无', 'no') }}
              </td>
              <td data-testid="stock-prep-mapping-row-confirmed" :data-flag="String(row.confirmed)">
                {{ row.confirmed ? bi('已确认', 'yes') : bi('还没确认', 'not yet') }}
              </td>
              <td class="sp-map__col-action">
                <!-- Confirm (mappingId mode): only a row with BOTH ERP identifiers is confirmable —
                     the server 409s otherwise (a poisoned matched row would block generation). -->
                <button
                  type="button"
                  class="sp-map__action"
                  data-testid="stock-prep-mapping-row-confirm"
                  :disabled="!row.hasErpTarget || !row.mappingId || busy"
                  @click="confirmRow(row)"
                >
                  {{ bi('就是它', 'That\'s the one') }}
                </button>
                <button
                  type="button"
                  class="sp-map__action sp-map__action--muted"
                  data-testid="stock-prep-mapping-row-retire"
                  :disabled="!row.mappingId || busy"
                  @click="retireRow(row)"
                >
                  {{ bi('停用这条', 'Stop using this one') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Manual create-confirm form (create mode): fully operator-specified mapping. Client
           validation MIRRORS the server rules, but the server's {field} error stays authoritative. -->
      <form class="sp-map__form" data-testid="stock-prep-mapping-create-form" @submit.prevent="submitCreate">
        <h3 class="sp-map__form-title">{{ bi('系统没找到?自己填一条', 'Nothing found? Enter the match yourself') }}</h3>
        <div class="sp-map__form-grid">
          <label class="sp-map__field">
            <span class="sp-map__field-label">{{ bi('PLM 图号(必填)', 'PLM drawing no (required)') }}</span>
            <input v-model.trim="form.plmDrawingNo" type="text" data-testid="stock-prep-mapping-form-drawing" />
          </label>
          <label class="sp-map__field">
            <span class="sp-map__field-label">{{ bi('PLM 版本', 'PLM version') }}</span>
            <input v-model.trim="form.plmVersion" type="text" data-testid="stock-prep-mapping-form-version" />
          </label>
          <label class="sp-map__field">
            <span class="sp-map__field-label">{{ bi('PLM 物料名称', 'PLM material name') }}</span>
            <input v-model.trim="form.plmMaterialName" type="text" data-testid="stock-prep-mapping-form-name" />
          </label>
          <label class="sp-map__field">
            <span class="sp-map__field-label">{{ bi('PLM 规格', 'PLM spec') }}</span>
            <input v-model.trim="form.plmSpec" type="text" data-testid="stock-prep-mapping-form-spec" />
          </label>
          <label class="sp-map__field">
            <span class="sp-map__field-label">{{ bi('ERP 物料编码(必填)', 'ERP material code (required)') }}</span>
            <input v-model.trim="form.erpMaterialCode" type="text" data-testid="stock-prep-mapping-form-erp-code" />
          </label>
          <label class="sp-map__field">
            <span class="sp-map__field-label">{{ bi('ERP 内部 ID(必填)', 'ERP internal id (required)') }}</span>
            <input v-model.trim="form.erpMaterialInternalId" type="text" data-testid="stock-prep-mapping-form-erp-internal" />
          </label>
          <label class="sp-map__field">
            <span class="sp-map__field-label">{{ bi('ERP 物料名称', 'ERP material name') }}</span>
            <input v-model.trim="form.erpMaterialName" type="text" data-testid="stock-prep-mapping-form-erp-name" />
          </label>
          <label class="sp-map__field">
            <span class="sp-map__field-label">{{ bi('ERP 规格', 'ERP spec') }}</span>
            <input v-model.trim="form.erpSpec" type="text" data-testid="stock-prep-mapping-form-erp-spec" />
          </label>
          <label class="sp-map__field">
            <span class="sp-map__field-label">{{ bi('按什么算同一个物料(必选)', 'What counts as the same material (required)') }}</span>
            <select v-model="form.versionPolicy" data-testid="stock-prep-mapping-form-policy">
              <option value="" disabled>{{ bi('请先选一个', 'Pick one first') }}</option>
              <option v-for="policy in versionPolicies" :key="policy" :value="policy">{{ versionPolicyLabel(policy) }}</option>
            </select>
          </label>
          <label class="sp-map__field">
            <span class="sp-map__field-label">{{ bi('备注', 'Notes') }}</span>
            <input v-model.trim="form.notes" type="text" data-testid="stock-prep-mapping-form-notes" />
          </label>
        </div>
        <!-- Field error: the offending field NAME only — never a submitted value. -->
        <p v-if="formErrorField" class="sp-map__state sp-map__state--warn" data-testid="stock-prep-mapping-form-error" role="alert">
          {{ bi('这一项还没填对,请检查:', 'One field still needs attention:') }} <code class="sp-map__token">{{ formErrorField }}</code>
        </p>
        <button type="submit" class="sp-map__action" data-testid="stock-prep-mapping-form-submit" :disabled="busy">
          {{ bi('保存这条对应关系', 'Save this match') }}
        </button>
      </form>

      <StockPrepTechnicalDetails testid="stock-prep-mapping-tech">
        <dl>
          <dt>{{ bi('匹配状态枚举', 'Match-status vocabulary') }}</dt>
          <dd>
            <span v-for="status in matchStatuses" :key="status"><code>{{ status }}</code> = {{ matchStatusLabel(status) }}; </span>
          </dd>
          <dt>{{ bi('版本策略枚举', 'Version-policy vocabulary') }}</dt>
          <dd>
            <span v-for="policy in versionPolicies" :key="policy"><code>{{ policy }}</code> = {{ versionPolicyLabel(policy) }}; </span>
          </dd>
          <dt>{{ bi('作用范围', 'Scope') }}</dt>
          <dd>
            {{ bi(
              '映射表没有 projectId 字段(服务端 R3):它是租户级、跨项目复用资产,上方计数不按已选项目过滤。',
              'The mapping table has no projectId field (server R3): it is a tenant-level, cross-project reuse asset, so the counts above are not filtered to the selected project.',
            ) }}
          </dd>
          <dt>{{ bi('确认的两种模式', 'The two confirm modes') }}</dt>
          <dd>
            {{ bi(
              '行内确认走 mappingId 模式(仅当两个 ERP 标识都齐备时可用,否则服务端 409);手工新建走 create 模式,字段名与服务端 {field} 报错一致。',
              'Confirming a row uses mappingId mode (available only when both ERP identifiers are present; otherwise the server answers 409). The manual form uses create mode, and its field names match the server\'s {field} error exactly.',
            ) }}
          </dd>
        </dl>
      </StockPrepTechnicalDetails>
    </div>
  </div>
</template>

<script setup lang="ts">
// Stock Preparation MVP (#3751 — docs/development/stock-preparation-mvp-design-20260707.md),
// Frontend MVP view 3: MATERIAL MAPPING CONFIRMATION, rendered inside the workspace shell's third
// tab. Reads = W3c confirm reads (summary + review queue); writes = W3b human confirm writes
// (candidate sync / confirm XOR modes / retire) — all MULTITABLE-INTERNAL, no external ERP/K3 write.
//
// VALUES-FREE: the template reads a fixed whitelist of fields — counts, status/method/policy enums,
// booleans, confidence scores, and the sha16 mappingId handle. It never renders a PLM drawing
// number, material name, spec, or ERP identifier FROM the server (the read shapes carry none), and
// error surfaces render only the clamped code / field NAME. Operator-entered form values flow only
// UPWARD through the closed create-mode allowlist; confirmedBy / confirmedAt never enter any body.
import { computed, nextTick, onMounted, reactive, ref, watch, type Ref } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import type { IntegrationScope } from '../../../services/integration/workbench'
import { StockPreparationConfirmApiError } from '../../../services/integration/stockPreparation/confirmApi'
import {
  STOCK_PREPARATION_MATCH_STATUSES,
  STOCK_PREPARATION_VERSION_POLICIES,
  confirmStockPreparationMaterialMapping,
  getStockPreparationMaterialMappingSummary,
  listStockPreparationMaterialMappingCandidates,
  retireStockPreparationMaterialMapping,
  syncStockPreparationMaterialMappingCandidates,
  type StockPreparationMaterialMappingCandidateList,
  type StockPreparationMaterialMappingCandidateRow,
  type StockPreparationMaterialMappingDraft,
  type StockPreparationMaterialMappingSummary,
  type StockPreparationMaterialMappingSyncResult,
  type StockPreparationMatchStatus,
  type StockPreparationVersionPolicy,
} from '../../../services/integration/stockPreparation/materialMapping'
import StockPrepTechnicalDetails from './StockPrepTechnicalDetails.vue'
import {
  STOCK_PREP_MATCH_METHOD_PLAIN,
  STOCK_PREP_MATCH_STATUS_PLAIN,
  STOCK_PREP_VERSION_POLICY_PLAIN,
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

// Same synchronous locale idiom as the shell / views 1-2 / the rest of the integration surface.
function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const matchStatuses = STOCK_PREPARATION_MATCH_STATUSES
const versionPolicies = STOCK_PREPARATION_VERSION_POLICIES

/** The three vocabularies in words; each falls back to the raw token it does not know. */
function matchStatusLabel(status: string | null): string {
  const plain = stockPrepEnumPlain(STOCK_PREP_MATCH_STATUS_PLAIN, status)
  return plain ? bi(plain.zh, plain.en) : (status ?? '—')
}

function versionPolicyLabel(policy: string | null): string {
  const plain = stockPrepEnumPlain(STOCK_PREP_VERSION_POLICY_PLAIN, policy)
  return plain ? bi(plain.zh, plain.en) : (policy ?? '—')
}

function matchMethodLabel(method: string | null): string {
  const plain = stockPrepEnumPlain(STOCK_PREP_MATCH_METHOD_PLAIN, method)
  return plain ? bi(plain.zh, plain.en) : (method ?? '—')
}

const errorPlain = stockPrepErrorPlain

const hasProject = computed(() => Boolean(props.projectId))

const loading = ref(Boolean(props.projectId))
const errored = ref(false)
const summary = ref<StockPreparationMaterialMappingSummary | null>(null)
const queue = ref<StockPreparationMaterialMappingCandidateList | null>(null)

const statusFilter = ref<'' | StockPreparationMatchStatus>('')
const syncPolicy = ref<'' | StockPreparationVersionPolicy>('')
const syncResult = ref<StockPreparationMaterialMappingSyncResult | null>(null)

const busy = ref(false)
const actionNotice = ref<{ mode: string; handle: string | null } | null>(null)
const actionError = ref<{ code: string; field: string | null } | null>(null)
const formErrorField = ref<string | null>(null)

const form = reactive({
  plmDrawingNo: '',
  plmVersion: '',
  plmMaterialName: '',
  plmSpec: '',
  erpMaterialCode: '',
  erpMaterialInternalId: '',
  erpMaterialName: '',
  erpSpec: '',
  versionPolicy: '' as '' | StockPreparationVersionPolicy,
  notes: '',
})

const summaryStatusEntries = computed(() =>
  Object.entries(summary.value?.matchStatusCounts ?? {}).map(([key, count]) => ({ key, count })),
)
const summaryPolicyEntries = computed(() =>
  Object.entries(summary.value?.versionPolicyCounts ?? {}).map(([key, count]) => ({ key, count })),
)

function requestScope(): IntegrationScope & { projectId: string } {
  return { ...props.scope, projectId: props.projectId as string }
}

async function loadAll(): Promise<void> {
  if (!props.projectId) {
    loading.value = false
    errored.value = false
    summary.value = null
    queue.value = null
    return
  }
  loading.value = true
  errored.value = false
  try {
    const [summaryResult, queueResult] = await Promise.all([
      getStockPreparationMaterialMappingSummary(requestScope()),
      listStockPreparationMaterialMappingCandidates({
        ...requestScope(),
        matchStatus: statusFilter.value || undefined,
      }),
    ])
    summary.value = summaryResult
    queue.value = queueResult
  } catch {
    // 404-soft: neutral state, NEVER the raw error body.
    errored.value = true
    summary.value = null
    queue.value = null
  } finally {
    loading.value = false
  }
}

async function reloadQueue(): Promise<void> {
  if (!props.projectId) return
  try {
    queue.value = await listStockPreparationMaterialMappingCandidates({
      ...requestScope(),
      matchStatus: statusFilter.value || undefined,
    })
  } catch {
    errored.value = true
    queue.value = null
  }
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

async function confirmRow(row: StockPreparationMaterialMappingCandidateRow): Promise<void> {
  if (!row.mappingId || !row.hasErpTarget || busy.value) return
  resetFeedback()
  busy.value = true
  try {
    const result = await confirmStockPreparationMaterialMapping({ mappingId: row.mappingId }, requestScope())
    actionNotice.value = { mode: result.mode, handle: result.mappingId }
    await loadAll()
  } catch (error) {
    captureActionError(error)
  } finally {
    busy.value = false
  }
}

async function retireRow(row: StockPreparationMaterialMappingCandidateRow): Promise<void> {
  if (!row.mappingId || busy.value) return
  resetFeedback()
  busy.value = true
  try {
    const result = await retireStockPreparationMaterialMapping({ mappingId: row.mappingId }, requestScope())
    actionNotice.value = { mode: result.mode, handle: result.mappingId }
    await loadAll()
  } catch (error) {
    captureActionError(error)
  } finally {
    busy.value = false
  }
}

async function runCandidateSync(): Promise<void> {
  // OD2: no default — the entry is disabled until a policy is chosen; this guard is layer B.
  if (!syncPolicy.value || busy.value) return
  resetFeedback()
  syncResult.value = null
  busy.value = true
  try {
    syncResult.value = await syncStockPreparationMaterialMappingCandidates(
      { defaultVersionPolicy: syncPolicy.value },
      requestScope(),
    )
    await loadAll()
  } catch (error) {
    captureActionError(error)
  } finally {
    busy.value = false
  }
}

// Client-side MIRROR of the server's create-mode rules (both ERP identifiers required; plmVersion
// required under drawing_and_version). The server's {field} error remains authoritative — a server
// 400 lands in the same field-error surface.
function clientValidateDraft(): string | null {
  if (!form.plmDrawingNo) return 'plmDrawingNo'
  if (!form.erpMaterialCode) return 'erpMaterialCode'
  if (!form.erpMaterialInternalId) return 'erpMaterialInternalId'
  if (!form.versionPolicy) return 'versionPolicy'
  if (form.versionPolicy === 'drawing_and_version' && !form.plmVersion) return 'plmVersion'
  return null
}

async function submitCreate(): Promise<void> {
  if (busy.value) return
  resetFeedback()
  formErrorField.value = clientValidateDraft()
  if (formErrorField.value) return
  const draft: StockPreparationMaterialMappingDraft = {
    plmDrawingNo: form.plmDrawingNo,
    ...(form.plmVersion ? { plmVersion: form.plmVersion } : {}),
    ...(form.plmMaterialName ? { plmMaterialName: form.plmMaterialName } : {}),
    ...(form.plmSpec ? { plmSpec: form.plmSpec } : {}),
    erpMaterialCode: form.erpMaterialCode,
    erpMaterialInternalId: form.erpMaterialInternalId,
    ...(form.erpMaterialName ? { erpMaterialName: form.erpMaterialName } : {}),
    ...(form.erpSpec ? { erpSpec: form.erpSpec } : {}),
    versionPolicy: form.versionPolicy as StockPreparationVersionPolicy,
    ...(form.notes ? { notes: form.notes } : {}),
  }
  busy.value = true
  try {
    const result = await confirmStockPreparationMaterialMapping({ mapping: draft }, requestScope())
    actionNotice.value = { mode: result.mode, handle: result.mappingId }
    Object.assign(form, {
      plmDrawingNo: '',
      plmVersion: '',
      plmMaterialName: '',
      plmSpec: '',
      erpMaterialCode: '',
      erpMaterialInternalId: '',
      erpMaterialName: '',
      erpSpec: '',
      versionPolicy: '',
      notes: '',
    })
    await loadAll()
  } catch (error) {
    // Server {field} error → the form's field-error surface (authoritative over the client mirror).
    if (error instanceof StockPreparationConfirmApiError && error.field) {
      formErrorField.value = error.field
    } else {
      captureActionError(error)
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
  await loadAll()
  await restoreRetryFocus(retryEl)
}

onMounted(loadAll)
watch(() => props.projectId, loadAll)
// watch (not @change) so the reload always sees the UPDATED filter value — v-model's own change
// handler and a template @change handler have no guaranteed relative order.
watch(statusFilter, reloadQueue)
</script>

<style scoped>
.sp-map {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
}

.sp-map__state {
  margin: 0;
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
  line-height: 1.6;
}

.sp-map__state--muted {
  color: var(--ms-text-3);
}

.sp-map__state--ok {
  color: var(--ms-text-2);
}

.sp-map__state--warn {
  color: var(--ms-color-danger, #c45656);
}

.sp-map__state-msg {
  margin: 0 0 var(--ms-space-2);
}

.sp-map__retry {
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: transparent;
  padding: 4px 12px;
  color: var(--ms-color-primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.sp-map__retry:hover:not(:disabled) {
  background: var(--el-fill-color-light);
}

.sp-map__retry:disabled {
  opacity: 0.5;
  cursor: default;
}

.sp-map__retry:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}

.sp-map__overview {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
}

.sp-map__summary {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: var(--ms-space-2);
}

.sp-map__metric {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
  padding: var(--ms-space-2) var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
}

.sp-map__metric-label {
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-map__metric-value {
  color: var(--ms-text-1);
  font-variant-numeric: tabular-nums;
  font-weight: var(--ms-font-weight-title);
  font-size: 18px;
}

.sp-map__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-1);
}

.sp-map__chip,
.sp-map__badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--el-fill-color-light);
  color: var(--ms-text-2);
  font-size: 12px;
}

.sp-map__sync,
.sp-map__queue-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ms-space-3);
}

.sp-map__queue-count {
  color: var(--ms-text-1);
  font-weight: var(--ms-font-weight-title);
}

.sp-map__field {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
  font-size: 13px;
  color: var(--ms-text-2);
}

.sp-map__field--inline {
  flex-direction: row;
  align-items: center;
  gap: var(--ms-space-2);
}

.sp-map__field-label {
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-map__field input,
.sp-map__field select {
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  padding: 4px 8px;
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  font: inherit;
  font-size: 13px;
}

.sp-map__note {
  color: var(--ms-text-2);
  font-size: 13px;
}

.sp-map__scope-note {
  margin: 0;
  color: var(--ms-text-3);
  font-size: 12px;
  font-style: italic;
}

/* H4-3 long-table: bounded height + BOTH-axis overflow, so the table scrolls inside its OWN box and
   the sticky thead below has an actual scroll range to stick within (an `overflow-x: auto`-only wrap
   never scrolls vertically, so a sticky header inside it would never engage). */
.sp-map__table-wrap {
  max-height: 420px;
  overflow: auto;
}

.sp-map__table-wrap:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}

.sp-map__table {
  width: 100%;
  min-width: 920px;
  border-collapse: collapse;
  font-size: 13px;
}

.sp-map__table th,
.sp-map__table td {
  padding: var(--ms-space-2) var(--ms-space-3);
  border-bottom: 1px solid var(--ms-border-light);
  text-align: left;
  white-space: nowrap;
}

.sp-map__table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--ms-bg-card);
  color: var(--ms-text-3);
  font-weight: var(--ms-font-weight-title);
}

.sp-map__num {
  color: var(--ms-text-1);
  font-variant-numeric: tabular-nums;
}

.sp-map__handle {
  color: var(--ms-text-3);
  font-size: 12px;
}

/* The server token, kept beside the words it means — subordinate, still copyable. */
.sp-map__token {
  display: inline-block;
  margin-left: var(--ms-space-1);
  color: var(--ms-text-3);
  font-size: 11px;
  word-break: break-all;
}

.sp-map__col-action {
  text-align: right;
}

.sp-map__action {
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: transparent;
  padding: 2px 10px;
  color: var(--ms-color-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.sp-map__action:disabled {
  color: var(--ms-text-3);
  cursor: not-allowed;
}

.sp-map__action--muted {
  color: var(--ms-text-2);
}

.sp-map__action:hover:not(:disabled) {
  background: var(--el-fill-color-light);
}

/* H4-3 keyboard: one focus-ring system across the stock-prep surface (same idiom as the H4-2
   dashboard/stepper rings). Covers the sync/confirm/retire/submit buttons and every field control. */
.sp-map__action:focus-visible,
.sp-map__field input:focus-visible,
.sp-map__field select:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}

.sp-map__form {
  border-top: 1px solid var(--ms-border-light);
  padding-top: var(--ms-space-3);
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
}

.sp-map__form-title {
  margin: 0;
  font-size: 14px;
  color: var(--ms-text-1);
}

.sp-map__form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: var(--ms-space-2) var(--ms-space-3);
}

.sp-map__form .sp-map__action {
  align-self: flex-start;
}
</style>
