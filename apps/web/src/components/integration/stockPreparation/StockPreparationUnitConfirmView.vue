<template>
  <div class="sp-unit" data-testid="stock-prep-unit-view">
    <!-- No project selected: this slice has no project picker, so we simply ask for one. -->
    <p
      v-if="!hasProject"
      class="sp-unit__state sp-unit__state--muted"
      data-testid="stock-prep-unit-no-project"
      role="status"
    >
      {{ bi('请选择一个项目以查看单位换算确认。', 'Select a project to see unit-conversion confirmation.') }}
    </p>

    <!-- Loading: values-free spinner copy only. -->
    <p
      v-else-if="loading"
      class="sp-unit__state sp-unit__state--muted"
      data-testid="stock-prep-unit-loading"
      role="status"
    >
      {{ bi('正在加载单位换算确认状态…', 'Loading unit-conversion confirmation state…') }}
    </p>

    <!-- Summary error / endpoint-not-ready: neutral, never the raw body. -->
    <p
      v-else-if="errored"
      class="sp-unit__state sp-unit__state--muted"
      data-testid="stock-prep-unit-error"
      role="status"
    >
      {{ bi('同步后端尚未就绪,稍后再试。', 'Backend read not ready yet — try again later.') }}
    </p>

    <div v-else-if="summary" class="sp-unit__overview" data-testid="stock-prep-unit-overview">
      <!-- Summary header card: the six values-free summary indicators. -->
      <header class="sp-unit__summary" data-testid="stock-prep-unit-summary">
        <div class="sp-unit__metric" data-testid="stock-prep-unit-metric" data-kind="total">
          <span class="sp-unit__metric-label">{{ bi('规则总数', 'Total rules') }}</span>
          <span class="sp-unit__metric-value">{{ summary.totalRuleCount }}</span>
        </div>
        <div class="sp-unit__metric" data-testid="stock-prep-unit-metric" data-kind="active">
          <span class="sp-unit__metric-label">{{ bi('生效规则', 'Active rules') }}</span>
          <span class="sp-unit__metric-value">{{ summary.activeRuleCount }}</span>
        </div>
        <div class="sp-unit__metric" data-testid="stock-prep-unit-metric" data-kind="requires-confirmation">
          <span class="sp-unit__metric-label">{{ bi('待确认规则', 'Rules pending confirmation') }}</span>
          <span class="sp-unit__metric-value">{{ summary.requiresConfirmationCount }}</span>
        </div>
        <div class="sp-unit__metric" data-testid="stock-prep-unit-metric" data-kind="pending-lines">
          <span class="sp-unit__metric-label">{{ bi('待处理单位行', 'Pending unit lines') }}</span>
          <span class="sp-unit__metric-value">{{ summary.pendingUnitLineCount }}</span>
        </div>
        <div class="sp-unit__metric sp-unit__metric--chips" data-testid="stock-prep-unit-metric" data-kind="scope-type">
          <span class="sp-unit__metric-label">{{ bi('按作用域', 'By scope type') }}</span>
          <span class="sp-unit__chips">
            <span
              v-for="entry in summaryScopeEntries"
              :key="entry.key"
              class="sp-unit__chip"
              data-testid="stock-prep-unit-scope-count"
              :data-scope="entry.key"
            >{{ entry.key }}: {{ entry.count }}</span>
          </span>
        </div>
        <div class="sp-unit__metric sp-unit__metric--chips" data-testid="stock-prep-unit-metric" data-kind="rounding-rule">
          <span class="sp-unit__metric-label">{{ bi('按取整规则', 'By rounding rule') }}</span>
          <span class="sp-unit__chips">
            <span
              v-for="entry in summaryRoundingEntries"
              :key="entry.key"
              class="sp-unit__chip"
              data-testid="stock-prep-unit-rounding-count"
              :data-rounding="entry.key"
            >{{ entry.key }}: {{ entry.count }}</span>
          </span>
        </div>
      </header>

      <!-- Stale-candidate notice (409 CONFIRM_UNIT_CANDIDATE_NOT_FOUND): the computed view drifted
           (snapshot changed / a rule landed meanwhile) — the operator must re-read before confirming. -->
      <p v-if="staleCandidates" class="sp-unit__state sp-unit__state--warn" data-testid="stock-prep-unit-stale" role="alert">
        {{ bi('候选已过期(快照或规则已变化),请刷新重读后再确认。', 'Candidates are stale (snapshot or rules changed) — refresh and re-read before confirming.') }}
        <button type="button" class="sp-unit__action" data-testid="stock-prep-unit-stale-refresh" @click="refreshCandidates">
          {{ bi('刷新重读', 'Refresh') }}
        </button>
      </p>

      <!-- Action feedback (values-free: clamped code / field NAME / mode enums only). -->
      <p v-if="actionNotice" class="sp-unit__state sp-unit__state--ok" data-testid="stock-prep-unit-action-notice">
        {{ bi('操作完成', 'Action done') }}: {{ actionNotice.mode }}
        <code v-if="actionNotice.handle" class="sp-unit__handle">{{ actionNotice.handle }}</code>
      </p>
      <p v-if="actionError" class="sp-unit__state sp-unit__state--warn" data-testid="stock-prep-unit-action-error" role="alert">
        {{ bi('操作失败', 'Action failed') }} ({{ actionError.code }}<template v-if="actionError.field">/{{ actionError.field }}</template>)
      </p>

      <!-- Computed candidate list (server recomputes per read; candidate values never cross). -->
      <p
        v-if="noCompleteBatch"
        class="sp-unit__state sp-unit__state--muted"
        data-testid="stock-prep-unit-no-batch"
      >
        {{ bi('该项目尚无完整快照批次,无法计算单位候选。', 'No complete snapshot batch for this project yet — unit candidates cannot be computed.') }}
      </p>
      <p
        v-else-if="candidatesErrored"
        class="sp-unit__state sp-unit__state--muted"
        data-testid="stock-prep-unit-candidates-error"
        role="status"
      >
        {{ bi('候选读取尚未就绪,稍后再试。', 'Candidate read not ready yet — try again later.') }}
      </p>
      <div v-else-if="candidates" class="sp-unit__candidates">
        <div class="sp-unit__queue-head">
          <span class="sp-unit__queue-count" data-testid="stock-prep-unit-queue-count">
            {{ bi('计算候选行', 'Computed rows') }}: {{ candidates.rowCount }}
          </span>
          <span class="sp-unit__badge" data-testid="stock-prep-unit-status" :data-status="candidates.status">
            {{ candidates.status }}
          </span>
          <span class="sp-unit__batch" data-testid="stock-prep-unit-batch-handle">
            {{ bi('快照批次', 'Snapshot batch') }}: <code class="sp-unit__handle">{{ candidates.snapshotBatchId }}</code>
          </span>
          <span class="sp-unit__chips">
            <span
              v-for="entry in outcomeEntries"
              :key="entry.key"
              class="sp-unit__chip"
              data-testid="stock-prep-unit-outcome-count"
              :data-outcome="entry.key"
            >{{ entry.key }}: {{ entry.count }}</span>
          </span>
        </div>

        <p v-if="candidates.rowCount === 0" class="sp-unit__state sp-unit__state--muted" data-testid="stock-prep-unit-empty">
          {{ bi('当前批次没有需要单位换算的上下文。', 'No unit-conversion contexts in this batch.') }}
        </p>
        <div v-else class="sp-unit__table-wrap">
          <table class="sp-unit__table" data-testid="stock-prep-unit-queue">
            <thead>
              <tr>
                <th scope="col">{{ bi('上下文指纹', 'Context fingerprint') }}</th>
                <th scope="col">{{ bi('结果', 'Outcome') }}</th>
                <th scope="col">{{ bi('原因', 'Reason') }}</th>
                <th scope="col">{{ bi('复用规则', 'Reused rule') }}</th>
                <th scope="col">{{ bi('有候选', 'Has candidate') }}</th>
                <th scope="col" class="sp-unit__col-action">{{ bi('操作', 'Actions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(row, index) in candidates.rows"
                :key="row.contextFingerprint ?? `row-${index}`"
                class="sp-unit__row"
                data-testid="stock-prep-unit-row"
                :data-outcome="row.outcome ?? 'unknown'"
              >
                <td><code class="sp-unit__handle" data-testid="stock-prep-unit-row-fingerprint">{{ row.contextFingerprint ?? '—' }}</code></td>
                <td>
                  <span class="sp-unit__badge" data-testid="stock-prep-unit-row-outcome" :data-outcome="row.outcome ?? 'unknown'">
                    {{ row.outcome ?? '—' }}
                  </span>
                </td>
                <td data-testid="stock-prep-unit-row-reason">{{ row.reason ?? '—' }}</td>
                <!-- reused rows: READ-ONLY display of the covering rule's handle. -->
                <td><code class="sp-unit__handle" data-testid="stock-prep-unit-row-rule-handle">{{ row.conversionRuleId ?? '—' }}</code></td>
                <td data-testid="stock-prep-unit-row-candidate" :data-flag="String(row.hasCandidate)">
                  {{ row.hasCandidate ? bi('有', 'yes') : bi('无', 'no') }}
                </td>
                <td class="sp-unit__col-action">
                  <!-- Fingerprint confirm: only a computed 1:1 candidate row is confirmable — the
                       server re-derives the rule values (they never crossed the wire). -->
                  <button
                    v-if="row.outcome === 'candidate' && row.hasCandidate && row.contextFingerprint"
                    type="button"
                    class="sp-unit__action"
                    data-testid="stock-prep-unit-row-confirm"
                    :disabled="busy"
                    @click="confirmCandidate(row)"
                  >
                    {{ bi('确认', 'Confirm') }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Rule retire entry: required before re-creating a same-scope rule with a different factor. -->
      <div class="sp-unit__retire" data-testid="stock-prep-unit-retire-block">
        <label class="sp-unit__field sp-unit__field--inline">
          <span class="sp-unit__field-label">{{ bi('退役规则(规则标识)', 'Retire rule (rule handle)') }}</span>
          <input v-model.trim="retireRuleId" type="text" data-testid="stock-prep-unit-retire-input" />
        </label>
        <button
          type="button"
          class="sp-unit__action sp-unit__action--muted"
          data-testid="stock-prep-unit-retire-submit"
          :disabled="!retireRuleId || busy"
          @click="retireRule"
        >
          {{ bi('退役', 'Retire') }}
        </button>
      </div>

      <!-- Manual rule form (rule mode): fully user-entered (OD3/OD4). Client validation MIRRORS the
           server rules, but the server's {field} error stays authoritative. -->
      <form class="sp-unit__form" data-testid="stock-prep-unit-rule-form" @submit.prevent="submitRule">
        <h3 class="sp-unit__form-title">{{ bi('手工新建换算规则', 'Create a conversion rule manually') }}</h3>
        <div class="sp-unit__form-grid">
          <label class="sp-unit__field">
            <span class="sp-unit__field-label">{{ bi('PLM 设计单位(必填)', 'PLM design unit (required)') }}</span>
            <input v-model.trim="form.plmUnit" type="text" data-testid="stock-prep-unit-form-plm-unit" />
          </label>
          <label class="sp-unit__field">
            <span class="sp-unit__field-label">{{ bi('ERP 领用单位(必填)', 'ERP issue unit (required)') }}</span>
            <input v-model.trim="form.erpIssueUnit" type="text" data-testid="stock-prep-unit-form-erp-unit" />
          </label>
          <label class="sp-unit__field">
            <span class="sp-unit__field-label">{{ bi('换算系数(必填,>0)', 'Conversion factor (required, >0)') }}</span>
            <input v-model.trim="form.conversionFactor" type="text" inputmode="decimal" data-testid="stock-prep-unit-form-factor" />
          </label>
          <label class="sp-unit__field">
            <span class="sp-unit__field-label">{{ bi('作用域(必选)', 'Scope type (required)') }}</span>
            <select v-model="form.scopeType" data-testid="stock-prep-unit-form-scope-type">
              <option value="" disabled>{{ bi('请选择作用域', 'Select a scope type') }}</option>
              <option v-for="scope in scopeTypes" :key="scope" :value="scope">{{ scope }}</option>
            </select>
          </label>
          <label v-if="form.scopeType !== 'generic'" class="sp-unit__field">
            <span class="sp-unit__field-label">{{ bi('作用域键(material/category 必填)', 'Scope key (required for material/category)') }}</span>
            <input v-model.trim="form.scopeKey" type="text" data-testid="stock-prep-unit-form-scope-key" />
          </label>
          <label class="sp-unit__field">
            <span class="sp-unit__field-label">{{ bi('损耗率(≥0,可选)', 'Loss rate (≥0, optional)') }}</span>
            <input v-model.trim="form.lossRate" type="text" inputmode="decimal" data-testid="stock-prep-unit-form-loss" />
          </label>
          <label class="sp-unit__field">
            <span class="sp-unit__field-label">{{ bi('取整规则', 'Rounding rule') }}</span>
            <select v-model="form.roundingRule" data-testid="stock-prep-unit-form-rounding">
              <option v-for="rule in roundingRules" :key="rule" :value="rule">{{ rule }}</option>
            </select>
          </label>
          <label class="sp-unit__field">
            <span class="sp-unit__field-label">{{ bi('最小领用量(≥0,可选)', 'Minimum issue qty (≥0, optional)') }}</span>
            <input v-model.trim="form.minimumIssueQty" type="text" inputmode="decimal" data-testid="stock-prep-unit-form-min-qty" />
          </label>
          <label class="sp-unit__field">
            <span class="sp-unit__field-label">{{ bi('生效起(可选)', 'Effective from (optional)') }}</span>
            <input v-model.trim="form.effectiveFrom" type="text" data-testid="stock-prep-unit-form-from" />
          </label>
          <label class="sp-unit__field">
            <span class="sp-unit__field-label">{{ bi('生效止(可选)', 'Effective to (optional)') }}</span>
            <input v-model.trim="form.effectiveTo" type="text" data-testid="stock-prep-unit-form-to" />
          </label>
        </div>
        <!-- Field error: the offending field NAME only — never a submitted value. -->
        <p v-if="formErrorField" class="sp-unit__state sp-unit__state--warn" data-testid="stock-prep-unit-form-error" role="alert">
          {{ bi('字段无效', 'Invalid field') }}: {{ formErrorField }}
        </p>
        <button type="submit" class="sp-unit__action" data-testid="stock-prep-unit-form-submit" :disabled="busy">
          {{ bi('新建并确认规则', 'Create confirmed rule') }}
        </button>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
// Stock Preparation MVP (#3751 — docs/development/stock-preparation-mvp-design-20260707.md),
// Frontend MVP view 4: UNIT CONVERSION CONFIRMATION, rendered inside the workspace shell's fourth
// tab. Reads = W3c confirm reads (summary + COMPUTED candidate list); writes = W3b human confirm
// writes (tri-XOR confirm / retire) — all MULTITABLE-INTERNAL, no external ERP/K3 write.
//
// CANDIDATES ARE COMPUTED, NEVER PERSISTED: the list is re-derived per read, so a fingerprint
// confirm can race a snapshot/rule change — the server answers 409 CONFIRM_UNIT_CANDIDATE_NOT_FOUND
// and this view surfaces a STALE notice with a refresh entry (never a blind retry).
//
// VALUES-FREE: the template reads a fixed whitelist — counts, outcome/reason/scope/rounding enums,
// booleans, and sha16 handles (contextFingerprint / conversionRuleId / snapshotBatchId). It never
// renders a unit symbol, conversion factor, loss rate, or quantity FROM the server (the read shapes
// carry none), and error surfaces render only the clamped code / field NAME. Operator-entered rule
// values flow only UPWARD through the closed rule allowlist; confirmedBy / confirmedAt never enter
// any body.
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import type { IntegrationScope } from '../../../services/integration/workbench'
import { StockPreparationConfirmApiError } from '../../../services/integration/stockPreparation/confirmApi'
import {
  STOCK_PREPARATION_ROUNDING_RULES,
  STOCK_PREPARATION_UNIT_SCOPE_TYPES,
  confirmStockPreparationUnitConversionRule,
  getStockPreparationUnitConversionSummary,
  listStockPreparationUnitConversionCandidates,
  retireStockPreparationUnitConversionRule,
  type StockPreparationRoundingRule,
  type StockPreparationUnitConversionCandidateList,
  type StockPreparationUnitConversionCandidateRow,
  type StockPreparationUnitConversionRuleDraft,
  type StockPreparationUnitConversionSummary,
  type StockPreparationUnitScopeType,
} from '../../../services/integration/stockPreparation/unitConversion'

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

// Same synchronous locale idiom as the shell / views 1-3 / the rest of the integration surface.
function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const scopeTypes = STOCK_PREPARATION_UNIT_SCOPE_TYPES
const roundingRules = STOCK_PREPARATION_ROUNDING_RULES

const hasProject = computed(() => Boolean(props.projectId))

const loading = ref(Boolean(props.projectId))
const errored = ref(false)
const summary = ref<StockPreparationUnitConversionSummary | null>(null)
const candidates = ref<StockPreparationUnitConversionCandidateList | null>(null)
const candidatesErrored = ref(false)
const noCompleteBatch = ref(false)
const staleCandidates = ref(false)

const busy = ref(false)
const actionNotice = ref<{ mode: string; handle: string | null } | null>(null)
const actionError = ref<{ code: string; field: string | null } | null>(null)
const formErrorField = ref<string | null>(null)
const retireRuleId = ref('')

const form = reactive({
  plmUnit: '',
  erpIssueUnit: '',
  conversionFactor: '',
  scopeType: '' as '' | StockPreparationUnitScopeType,
  scopeKey: '',
  lossRate: '',
  roundingRule: 'none' as StockPreparationRoundingRule,
  minimumIssueQty: '',
  effectiveFrom: '',
  effectiveTo: '',
})

const summaryScopeEntries = computed(() =>
  Object.entries(summary.value?.scopeTypeCounts ?? {}).map(([key, count]) => ({ key, count })),
)
const summaryRoundingEntries = computed(() =>
  Object.entries(summary.value?.roundingRuleCounts ?? {}).map(([key, count]) => ({ key, count })),
)
const outcomeEntries = computed(() =>
  Object.entries(candidates.value?.byOutcome ?? {}).map(([key, count]) => ({ key, count })),
)

function requestScope(): IntegrationScope & { projectId: string } {
  return { ...props.scope, projectId: props.projectId as string }
}

async function loadCandidates(): Promise<void> {
  candidatesErrored.value = false
  noCompleteBatch.value = false
  try {
    candidates.value = await listStockPreparationUnitConversionCandidates(requestScope())
  } catch (error) {
    candidates.value = null
    // No COMPLETE batch is an expected empty condition, not a failure (values-free neutral state).
    if (error instanceof StockPreparationConfirmApiError && error.code === 'CONFIRM_READS_BATCH_NOT_FOUND') {
      noCompleteBatch.value = true
    } else {
      candidatesErrored.value = true
    }
  }
}

async function loadAll(): Promise<void> {
  staleCandidates.value = false
  if (!props.projectId) {
    loading.value = false
    errored.value = false
    summary.value = null
    candidates.value = null
    return
  }
  loading.value = true
  errored.value = false
  try {
    const [summaryResult] = await Promise.all([
      getStockPreparationUnitConversionSummary(requestScope()),
      loadCandidates(),
    ])
    summary.value = summaryResult
  } catch {
    // 404-soft: neutral state, NEVER the raw error body.
    errored.value = true
    summary.value = null
    candidates.value = null
  } finally {
    loading.value = false
  }
}

async function refreshCandidates(): Promise<void> {
  staleCandidates.value = false
  await loadCandidates()
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
  staleCandidates.value = false
}

async function confirmCandidate(row: StockPreparationUnitConversionCandidateRow): Promise<void> {
  if (!row.contextFingerprint || busy.value || !candidates.value) return
  resetFeedback()
  busy.value = true
  try {
    const result = await confirmStockPreparationUnitConversionRule(
      {
        contextFingerprint: row.contextFingerprint,
        projectId: props.projectId as string,
        // Pin the confirm to the batch the operator is LOOKING AT (the list's batch handle).
        snapshotBatchId: candidates.value.snapshotBatchId,
      },
      requestScope(),
    )
    actionNotice.value = { mode: result.mode, handle: result.conversionRuleId }
    await loadAll()
  } catch (error) {
    if (error instanceof StockPreparationConfirmApiError && error.code === 'CONFIRM_UNIT_CANDIDATE_NOT_FOUND') {
      // Stale computed view → prompt a refresh + re-read; never blind-retry the confirm.
      staleCandidates.value = true
    } else {
      captureActionError(error)
    }
  } finally {
    busy.value = false
  }
}

async function retireRule(): Promise<void> {
  if (!retireRuleId.value || busy.value) return
  resetFeedback()
  busy.value = true
  try {
    const result = await retireStockPreparationUnitConversionRule(
      { conversionRuleId: retireRuleId.value },
      requestScope(),
    )
    actionNotice.value = { mode: result.mode, handle: result.conversionRuleId }
    retireRuleId.value = ''
    await loadAll()
  } catch (error) {
    captureActionError(error)
  } finally {
    busy.value = false
  }
}

// Mirror the server rule: scopeKey is FORBIDDEN for the generic scope — clear it on switch so a
// leftover key can never reach the wire. (watch, not @change: v-model's own change handler and a
// template @change handler have no guaranteed relative order.)
watch(() => form.scopeType, (scopeType) => {
  if (scopeType === 'generic') form.scopeKey = ''
})

function parseOptionalNumber(raw: string): number | null | undefined {
  if (raw === '') return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

// Client-side MIRROR of the server's rule-mode checks (required units, factor > 0, scopeKey
// required for material/category and forbidden for generic, non-negative optionals). The server's
// {field} error remains authoritative — a server 400 lands in the same field-error surface.
function clientValidateRule(): string | null {
  if (!form.plmUnit) return 'plmUnit'
  if (!form.erpIssueUnit) return 'erpIssueUnit'
  const factor = parseOptionalNumber(form.conversionFactor)
  if (factor === undefined || factor === null || factor <= 0) return 'conversionFactor'
  if (!form.scopeType) return 'scopeType'
  if ((form.scopeType === 'material' || form.scopeType === 'category') && !form.scopeKey) return 'scopeKey'
  const lossRate = parseOptionalNumber(form.lossRate)
  if (lossRate === null || (lossRate !== undefined && lossRate < 0)) return 'lossRate'
  const minimumIssueQty = parseOptionalNumber(form.minimumIssueQty)
  if (minimumIssueQty === null || (minimumIssueQty !== undefined && minimumIssueQty < 0)) return 'minimumIssueQty'
  return null
}

async function submitRule(): Promise<void> {
  if (busy.value) return
  resetFeedback()
  formErrorField.value = clientValidateRule()
  if (formErrorField.value) return
  const draft: StockPreparationUnitConversionRuleDraft = {
    plmUnit: form.plmUnit,
    erpIssueUnit: form.erpIssueUnit,
    conversionFactor: Number(form.conversionFactor),
    scopeType: form.scopeType as StockPreparationUnitScopeType,
    ...(form.scopeType !== 'generic' && form.scopeKey ? { scopeKey: form.scopeKey } : {}),
    ...(form.lossRate !== '' ? { lossRate: Number(form.lossRate) } : {}),
    roundingRule: form.roundingRule,
    ...(form.minimumIssueQty !== '' ? { minimumIssueQty: Number(form.minimumIssueQty) } : {}),
    ...(form.effectiveFrom ? { effectiveFrom: form.effectiveFrom } : {}),
    ...(form.effectiveTo ? { effectiveTo: form.effectiveTo } : {}),
  }
  busy.value = true
  try {
    const result = await confirmStockPreparationUnitConversionRule({ rule: draft }, requestScope())
    actionNotice.value = { mode: result.mode, handle: result.conversionRuleId }
    Object.assign(form, {
      plmUnit: '',
      erpIssueUnit: '',
      conversionFactor: '',
      scopeType: '',
      scopeKey: '',
      lossRate: '',
      roundingRule: 'none',
      minimumIssueQty: '',
      effectiveFrom: '',
      effectiveTo: '',
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

onMounted(loadAll)
watch(() => props.projectId, loadAll)
</script>

<style scoped>
.sp-unit {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
}

.sp-unit__state {
  margin: 0;
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
  line-height: 1.6;
}

.sp-unit__state--muted {
  color: var(--ms-text-3);
}

.sp-unit__state--ok {
  color: var(--ms-text-2);
}

.sp-unit__state--warn {
  color: var(--ms-color-danger, #c45656);
}

.sp-unit__overview,
.sp-unit__candidates {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
}

.sp-unit__summary {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: var(--ms-space-2);
}

.sp-unit__metric {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
  padding: var(--ms-space-2) var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
}

.sp-unit__metric-label {
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-unit__metric-value {
  color: var(--ms-text-1);
  font-variant-numeric: tabular-nums;
  font-weight: var(--ms-font-weight-title);
  font-size: 18px;
}

.sp-unit__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-1);
}

.sp-unit__chip,
.sp-unit__badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--el-fill-color-light);
  color: var(--ms-text-2);
  font-size: 12px;
}

.sp-unit__queue-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ms-space-3);
}

.sp-unit__queue-count {
  color: var(--ms-text-1);
  font-weight: var(--ms-font-weight-title);
}

.sp-unit__batch {
  color: var(--ms-text-2);
  font-size: 13px;
}

.sp-unit__table-wrap {
  overflow-x: auto;
}

.sp-unit__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.sp-unit__table th,
.sp-unit__table td {
  padding: var(--ms-space-2) var(--ms-space-3);
  border-bottom: 1px solid var(--ms-border-light);
  text-align: left;
  white-space: nowrap;
}

.sp-unit__table th {
  color: var(--ms-text-3);
  font-weight: var(--ms-font-weight-title);
}

.sp-unit__handle {
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-unit__col-action {
  text-align: right;
}

.sp-unit__action {
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: transparent;
  padding: 2px 10px;
  color: var(--ms-color-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.sp-unit__action:disabled {
  color: var(--ms-text-3);
  cursor: not-allowed;
}

.sp-unit__action--muted {
  color: var(--ms-text-2);
}

.sp-unit__action:hover:not(:disabled) {
  background: var(--el-fill-color-light);
}

.sp-unit__retire {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ms-space-3);
  border-top: 1px solid var(--ms-border-light);
  padding-top: var(--ms-space-3);
}

.sp-unit__field {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
  font-size: 13px;
  color: var(--ms-text-2);
}

.sp-unit__field--inline {
  flex-direction: row;
  align-items: center;
  gap: var(--ms-space-2);
}

.sp-unit__field-label {
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-unit__field input,
.sp-unit__field select {
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  padding: 4px 8px;
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  font: inherit;
  font-size: 13px;
}

.sp-unit__form {
  border-top: 1px solid var(--ms-border-light);
  padding-top: var(--ms-space-3);
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
}

.sp-unit__form-title {
  margin: 0;
  font-size: 14px;
  color: var(--ms-text-1);
}

.sp-unit__form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: var(--ms-space-2) var(--ms-space-3);
}

.sp-unit__form .sp-unit__action {
  align-self: flex-start;
}
</style>
