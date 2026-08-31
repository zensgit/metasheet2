<template>
  <div class="sp-unit" data-testid="stock-prep-unit-view">
    <!-- No project selected: this slice has no project picker, so we simply ask for one. -->
    <p
      v-if="!hasProject"
      class="sp-unit__state sp-unit__state--muted"
      data-testid="stock-prep-unit-no-project"
      role="status"
    >
      {{ bi('请选择一个项目,这里会列出还没定单位的行。', 'Select a project and this page lists what still has no unit settled.') }}
    </p>

    <!-- Loading: values-free spinner copy only. -->
    <p
      v-else-if="loading"
      class="sp-unit__state sp-unit__state--muted"
      data-testid="stock-prep-unit-loading"
      role="status"
    >
      {{ bi('正在读取单位换算情况…', 'Reading the unit conversions…') }}
    </p>

    <!-- Summary error / endpoint-not-ready: neutral, never the raw body. -->
    <div
      v-else-if="errored"
      class="sp-unit__state sp-unit__state--muted"
      data-testid="stock-prep-unit-error"
      role="status"
    >
      <p class="sp-unit__state-msg">{{ bi('同步后端尚未就绪,稍后再试。', 'Backend read not ready yet — try again later.') }}</p>
      <!-- H4-3 retry: re-runs the same readonly loadAll(); idempotent, no new endpoint. -->
      <button
        ref="retryEl"
        type="button"
        class="sp-unit__retry"
        data-testid="stock-prep-unit-retry"
        :disabled="loading"
        :aria-label="bi('重试读取单位换算确认', 'Retry loading unit-conversion confirmation')"
        @click="onRetry"
      >
        {{ bi('重试', 'Retry') }}
      </button>
    </div>

    <div v-else-if="summary" class="sp-unit__overview" data-testid="stock-prep-unit-overview">
      <!-- Summary header card: the six values-free summary indicators. -->
      <header class="sp-unit__summary" data-testid="stock-prep-unit-summary">
        <div class="sp-unit__metric" data-testid="stock-prep-unit-metric" data-kind="total">
          <span class="sp-unit__metric-label">{{ bi('一共记了多少条换算规则', 'Conversion rules on record') }}</span>
          <span class="sp-unit__metric-value">{{ summary.totalRuleCount }}</span>
        </div>
        <div class="sp-unit__metric" data-testid="stock-prep-unit-metric" data-kind="active">
          <span class="sp-unit__metric-label">{{ bi('正在用的', 'In use') }}</span>
          <span class="sp-unit__metric-value">{{ summary.activeRuleCount }}</span>
        </div>
        <div class="sp-unit__metric" data-testid="stock-prep-unit-metric" data-kind="requires-confirmation">
          <span class="sp-unit__metric-label">{{ bi('等您确认的规则', 'Rules waiting for you') }}</span>
          <span class="sp-unit__metric-value">{{ summary.requiresConfirmationCount }}</span>
        </div>
        <div class="sp-unit__metric" data-testid="stock-prep-unit-metric" data-kind="pending-lines">
          <span class="sp-unit__metric-label">{{ bi('本项目还没定单位的行', 'Rows on this project with no unit yet') }}</span>
          <span class="sp-unit__metric-value">{{ summary.pendingUnitLineCount }}</span>
        </div>
        <div class="sp-unit__metric sp-unit__metric--chips" data-testid="stock-prep-unit-metric" data-kind="scope-type">
          <span class="sp-unit__metric-label">{{ bi('规则管多大范围', 'How wide each rule reaches') }}</span>
          <span class="sp-unit__chips">
            <span
              v-for="entry in summaryScopeEntries"
              :key="entry.key"
              class="sp-unit__chip"
              data-testid="stock-prep-unit-scope-count"
              :data-scope="entry.key"
              :title="entry.key"
            >{{ scopeLabel(entry.key) }}: {{ entry.count }}</span>
          </span>
        </div>
        <div class="sp-unit__metric sp-unit__metric--chips" data-testid="stock-prep-unit-metric" data-kind="rounding-rule">
          <span class="sp-unit__metric-label">{{ bi('算出零头怎么处理', 'What happens to a fraction') }}</span>
          <span class="sp-unit__chips">
            <span
              v-for="entry in summaryRoundingEntries"
              :key="entry.key"
              class="sp-unit__chip"
              data-testid="stock-prep-unit-rounding-count"
              :data-rounding="entry.key"
              :title="entry.key"
            >{{ roundingLabel(entry.key) }}: {{ entry.count }}</span>
          </span>
        </div>
      </header>

      <!-- CAVEAT (P3 FE cleanup, #3751): the unit-conversion rule table has no projectId field
           (server stock-preparation-confirm-reads.cjs R8) — it is a tenant-level, cross-project
           reuse asset by design, so "Total/Active/Rules pending confirmation/By scope/By rounding"
           above are NOT filtered to the project selected in this view. "Pending unit lines" is the
           one exception: it IS computed over this project's latest complete snapshot batch. -->
      <p class="sp-unit__scope-note" data-testid="stock-prep-unit-scope-note" role="note">
        {{ bi(
          '换算规则是全公司共用的:定好一次,别的项目也能直接用。所以除了「本项目还没定单位的行」,上面的数统计的是全部规则,不只是当前选中的项目。',
          'Conversion rules are shared company-wide: settle one and other projects reuse it. So apart from “rows on this project with no unit yet”, the counts above cover every rule, not just the project selected here.',
        ) }}
      </p>

      <!-- Stale-candidate notice (409 CONFIRM_UNIT_CANDIDATE_NOT_FOUND): the computed view drifted
           (snapshot changed / a rule landed meanwhile) — the operator must re-read before confirming. -->
      <p v-if="staleCandidates" class="sp-unit__state sp-unit__state--warn" data-testid="stock-prep-unit-stale" role="alert">
        {{ bi('您看的这份建议已经过期了(期间数据变过),请刷新后重看再确认。', 'The suggestions you are looking at are out of date — the data changed while you were reading. Refresh and look again before confirming.') }}
        <button type="button" class="sp-unit__action" data-testid="stock-prep-unit-stale-refresh" @click="refreshCandidates">
          {{ bi('刷新重看', 'Refresh and look again') }}
        </button>
      </p>

      <!-- Action feedback (values-free: clamped code / field NAME / mode enums only). -->
      <p v-if="actionNotice" class="sp-unit__state sp-unit__state--ok" data-testid="stock-prep-unit-action-notice">
        {{ bi('保存好了。', 'Saved.') }}
        <code class="sp-unit__token">{{ actionNotice.mode }}</code>
        <code v-if="actionNotice.handle" class="sp-unit__handle">{{ actionNotice.handle }}</code>
      </p>
      <p v-if="actionError" class="sp-unit__state sp-unit__state--warn" data-testid="stock-prep-unit-action-error" role="alert">
        {{ bi(errorPlain(actionError.code).zh, errorPlain(actionError.code).en) }}
        <code class="sp-unit__token">{{ actionError.code }}<template v-if="actionError.field">/{{ actionError.field }}</template></code>
      </p>

      <!-- Computed candidate list (server recomputes per read; candidate values never cross). -->
      <p
        v-if="noCompleteBatch"
        class="sp-unit__state sp-unit__state--muted"
        data-testid="stock-prep-unit-no-batch"
      >
        {{ bi('这个项目还没有一批完整的同步数据,算不出单位建议 —— 请先同步一次。', 'This project has no complete sync yet, so no unit suggestions can be worked out — sync it first.') }}
      </p>
      <div
        v-else-if="candidatesErrored"
        class="sp-unit__state sp-unit__state--muted"
        data-testid="stock-prep-unit-candidates-error"
        role="status"
      >
        <p class="sp-unit__state-msg">{{ bi('候选读取尚未就绪,稍后再试。', 'Candidate read not ready yet — try again later.') }}</p>
        <!-- H4-3 retry: re-runs the existing loadCandidates() for the same project/batch. Bound to its
             OWN candidatesLoading flag (NOT the summary `loading`) — loadCandidates never touched
             `loading`, so the NIT-1 `:disabled="loading"` binding never actually flipped true here and
             the in-flight double-click guard it was meant to provide was dead on this entry. (The
             keyboard focus-restore below does NOT depend on this: loadCandidates also resets
             candidatesErrored to false before its GET, so the surrounding v-else-if unmounts this
             button's whole parent for the retry's duration regardless of :disabled — that unmount is
             what drops focus to <body>, verified by re-running the H4-2 candidates spec with the stale
             `:disabled="loading"` binding restored, which still passed.) -->
        <button
          ref="candidatesRetryEl"
          type="button"
          class="sp-unit__retry"
          data-testid="stock-prep-unit-candidates-retry"
          :disabled="candidatesLoading"
          :aria-label="bi('重试读取计算候选行', 'Retry loading computed candidate rows')"
          @click="onCandidatesRetry"
        >
          {{ bi('重试', 'Retry') }}
        </button>
      </div>
      <div v-else-if="candidates" class="sp-unit__candidates">
        <div class="sp-unit__queue-head">
          <span class="sp-unit__queue-count" data-testid="stock-prep-unit-queue-count">
            {{ bi('这次算出来的建议', 'Suggestions from this pass') }}: {{ candidates.rowCount }}
          </span>
          <span class="sp-unit__token" data-testid="stock-prep-unit-status" :data-status="candidates.status">
            {{ candidates.status }}
          </span>
          <span class="sp-unit__batch" data-testid="stock-prep-unit-batch-handle">
            {{ bi('算的是这一批同步的数据', 'Computed over this sync') }} <code class="sp-unit__handle">{{ candidates.snapshotBatchId }}</code>
          </span>
          <span class="sp-unit__chips">
            <span
              v-for="entry in outcomeEntries"
              :key="entry.key"
              class="sp-unit__chip"
              data-testid="stock-prep-unit-outcome-count"
              :data-outcome="entry.key"
              :title="entry.key"
            >{{ outcomeLabel(entry.key) }}: {{ entry.count }}</span>
          </span>
        </div>

        <p v-if="candidates.rowCount === 0" class="sp-unit__state sp-unit__state--muted" data-testid="stock-prep-unit-empty">
          {{ bi('这一批数据里没有需要换算单位的行。', 'Nothing in this batch needs a unit converted.') }}
        </p>
        <!-- H4-3 keyboard: the Confirm button only renders (v-if, not just :disabled) for
             candidate+hasCandidate rows — a filter/view with no such row leaves NO focusable content
             in the table, so the wrap itself is ALSO a native scroll-region. -->
        <div
          v-else
          class="sp-unit__table-wrap"
          tabindex="0"
          role="region"
          :aria-label="bi('单位换算计算候选表格,可滚动', 'Unit-conversion candidate table, scrollable')"
        >
          <table class="sp-unit__table" data-testid="stock-prep-unit-queue">
            <thead>
              <tr>
                <th scope="col">{{ bi('编号', 'Reference') }}</th>
                <th scope="col">{{ bi('算出什么结果', 'What came out') }}</th>
                <th scope="col">{{ bi('为什么', 'Why') }}</th>
                <th scope="col">{{ bi('用的哪条规则', 'Which rule was used') }}</th>
                <th scope="col">{{ bi('有建议吗', 'Is there a suggestion') }}</th>
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
                <!-- PLAIN FIRST, TOKEN KEPT: the badge carries the words, the testid'd element keeps
                     the engine's own enum byte-exact for grepping and for the values-free suites. -->
                <td>
                  <span v-if="row.outcome" class="sp-unit__badge">{{ outcomeLabel(row.outcome) }}</span>
                  <code class="sp-unit__token" data-testid="stock-prep-unit-row-outcome" :data-outcome="row.outcome ?? 'unknown'">{{ row.outcome ?? '—' }}</code>
                </td>
                <td data-testid="stock-prep-unit-row-reason">
                  <span v-if="row.reason">{{ reasonLabel(row.reason) }}</span>
                  <code v-if="row.reason" class="sp-unit__token">{{ row.reason }}</code>
                  <template v-else>—</template>
                </td>
                <!-- reused rows: READ-ONLY display of the covering rule's handle. -->
                <td><code class="sp-unit__handle" data-testid="stock-prep-unit-row-rule-handle">{{ row.conversionRuleId ?? '—' }}</code></td>
                <td data-testid="stock-prep-unit-row-candidate" :data-flag="String(row.hasCandidate)">
                  {{ row.hasCandidate ? bi('有', 'yes') : bi('没有', 'no') }}
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
                    {{ bi('就按这个算', 'Use this one') }}
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
          <span class="sp-unit__field-label">{{ bi('停用一条规则(填它的编号)', 'Stop using a rule (enter its reference)') }}</span>
          <input v-model.trim="retireRuleId" type="text" data-testid="stock-prep-unit-retire-input" />
        </label>
        <button
          type="button"
          class="sp-unit__action sp-unit__action--muted"
          data-testid="stock-prep-unit-retire-submit"
          :disabled="!retireRuleId || busy"
          @click="retireRule"
        >
          {{ bi('停用', 'Stop using it') }}
        </button>
      </div>

      <!-- Manual rule form (rule mode): fully user-entered (OD3/OD4). Client validation MIRRORS the
           server rules, but the server's {field} error stays authoritative. -->
      <form class="sp-unit__form" data-testid="stock-prep-unit-rule-form" @submit.prevent="submitRule">
        <h3 class="sp-unit__form-title">{{ bi('没有合适的规则?自己定一条', 'No suitable rule? Set one yourself') }}</h3>
        <div class="sp-unit__form-grid">
          <label class="sp-unit__field">
            <span class="sp-unit__field-label">{{ bi('图纸上的单位(必填)', 'The unit on the drawing (required)') }}</span>
            <input v-model.trim="form.plmUnit" type="text" data-testid="stock-prep-unit-form-plm-unit" />
          </label>
          <label class="sp-unit__field">
            <span class="sp-unit__field-label">{{ bi('实际领用的单位(必填)', 'The unit it is issued in (required)') }}</span>
            <input v-model.trim="form.erpIssueUnit" type="text" data-testid="stock-prep-unit-form-erp-unit" />
          </label>
          <label class="sp-unit__field">
            <span class="sp-unit__field-label">{{ bi('一个图纸单位等于几个领用单位(必填,大于 0)', 'One drawing unit equals how many issue units (required, above zero)') }}</span>
            <input v-model.trim="form.conversionFactor" type="text" inputmode="decimal" data-testid="stock-prep-unit-form-factor" />
          </label>
          <label class="sp-unit__field">
            <span class="sp-unit__field-label">{{ bi('这条规则管多大范围(必选)', 'How wide this rule reaches (required)') }}</span>
            <select v-model="form.scopeType" data-testid="stock-prep-unit-form-scope-type">
              <option value="" disabled>{{ bi('请先选一个', 'Pick one first') }}</option>
              <option v-for="scope in scopeTypes" :key="scope" :value="scope">{{ scopeLabel(scope) }}</option>
            </select>
          </label>
          <label v-if="form.scopeType !== 'generic'" class="sp-unit__field">
            <span class="sp-unit__field-label">{{ bi('管哪个物料 / 哪一类(必填)', 'Which material or category (required)') }}</span>
            <input v-model.trim="form.scopeKey" type="text" data-testid="stock-prep-unit-form-scope-key" />
          </label>
          <label class="sp-unit__field">
            <span class="sp-unit__field-label">{{ bi('损耗率(可不填)', 'Wastage allowance (optional)') }}</span>
            <input v-model.trim="form.lossRate" type="text" inputmode="decimal" data-testid="stock-prep-unit-form-loss" />
          </label>
          <label class="sp-unit__field">
            <span class="sp-unit__field-label">{{ bi('算出零头怎么处理', 'What to do with a fraction') }}</span>
            <select v-model="form.roundingRule" data-testid="stock-prep-unit-form-rounding">
              <option v-for="rule in roundingRules" :key="rule" :value="rule">{{ roundingLabel(rule) }}</option>
            </select>
          </label>
          <label class="sp-unit__field">
            <span class="sp-unit__field-label">{{ bi('最少领多少(可不填)', 'Minimum to issue (optional)') }}</span>
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
          {{ bi('这一项还没填对,请检查:', 'One field still needs attention:') }} <code class="sp-unit__token">{{ formErrorField }}</code>
        </p>
        <button type="submit" class="sp-unit__action" data-testid="stock-prep-unit-form-submit" :disabled="busy">
          {{ bi('保存这条规则', 'Save this rule') }}
        </button>
      </form>

      <StockPrepTechnicalDetails testid="stock-prep-unit-tech">
        <dl>
          <dt>{{ bi('计算结果枚举', 'Outcome vocabulary') }}</dt>
          <dd>
            <span v-for="outcome in ['reused', 'candidate', 'held']" :key="outcome">
              <code>{{ outcome }}</code> = {{ outcomeLabel(outcome) }};
            </span>
          </dd>
          <dt>{{ bi('作用域与取整枚举', 'Scope and rounding vocabularies') }}</dt>
          <dd>
            <span v-for="scope in scopeTypes" :key="scope"><code>{{ scope }}</code> = {{ scopeLabel(scope) }}; </span>
            <span v-for="rule in roundingRules" :key="rule"><code>{{ rule }}</code> = {{ roundingLabel(rule) }}; </span>
          </dd>
          <dt>{{ bi('候选是算出来的,不是存下来的', 'Candidates are computed, never stored') }}</dt>
          <dd>
            {{ bi(
              '候选每次读取时重新推导,所以一次确认可能撞上快照/规则变化 —— 服务端答 409 CONFIRM_UNIT_CANDIDATE_NOT_FOUND,本页转成「已过期,请刷新重看」而不是盲目重试。',
              'The candidate list is re-derived on every read, so a confirm can race a snapshot or rule change. The server answers 409 CONFIRM_UNIT_CANDIDATE_NOT_FOUND and this page turns that into "out of date, refresh and look again" rather than a blind retry.',
            ) }}
          </dd>
          <dt>{{ bi('作用范围', 'Scope') }}</dt>
          <dd>
            {{ bi(
              '换算规则表没有 projectId 字段(服务端 R8):它是租户级、跨项目复用资产;只有「本项目还没定单位的行」是按本项目最新完整快照批次计算的。',
              'The rule table has no projectId field (server R8): it is a tenant-level, cross-project reuse asset. Only "rows on this project with no unit yet" is computed over this project\'s latest complete snapshot batch.',
            ) }}
          </dd>
        </dl>
      </StockPrepTechnicalDetails>
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
import { computed, nextTick, onMounted, reactive, ref, watch, type Ref } from 'vue'
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
import StockPrepTechnicalDetails from './StockPrepTechnicalDetails.vue'
import {
  STOCK_PREP_ROUNDING_PLAIN,
  STOCK_PREP_UNIT_OUTCOME_PLAIN,
  STOCK_PREP_UNIT_REASON_PLAIN,
  STOCK_PREP_UNIT_SCOPE_PLAIN,
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

// Same synchronous locale idiom as the shell / views 1-3 / the rest of the integration surface.
function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const scopeTypes = STOCK_PREPARATION_UNIT_SCOPE_TYPES
const roundingRules = STOCK_PREPARATION_ROUNDING_RULES

/** The four engine vocabularies in words; each falls back to the raw token it does not know. */
function outcomeLabel(outcome: string | null): string {
  const plain = stockPrepEnumPlain(STOCK_PREP_UNIT_OUTCOME_PLAIN, outcome)
  return plain ? bi(plain.zh, plain.en) : (outcome ?? '—')
}

function reasonLabel(reason: string | null): string {
  const plain = stockPrepEnumPlain(STOCK_PREP_UNIT_REASON_PLAIN, reason)
  return plain ? bi(plain.zh, plain.en) : (reason ?? '—')
}

function scopeLabel(scope: string | null): string {
  const plain = stockPrepEnumPlain(STOCK_PREP_UNIT_SCOPE_PLAIN, scope)
  return plain ? bi(plain.zh, plain.en) : (scope ?? '—')
}

function roundingLabel(rule: string | null): string {
  const plain = stockPrepEnumPlain(STOCK_PREP_ROUNDING_PLAIN, rule)
  return plain ? bi(plain.zh, plain.en) : (rule ?? '—')
}

const errorPlain = stockPrepErrorPlain

const hasProject = computed(() => Boolean(props.projectId))

const loading = ref(Boolean(props.projectId))
const errored = ref(false)
const summary = ref<StockPreparationUnitConversionSummary | null>(null)
const candidates = ref<StockPreparationUnitConversionCandidateList | null>(null)
const candidatesErrored = ref(false)
// Own loading flag for the candidates-only load (H4-3 keyboard): `loading` is owned by loadAll() and
// never flips during a loadCandidates()-only retry, so the candidates-retry button's :disabled must
// read THIS flag, not `loading`, or the button would never actually leave the tab order on retry.
const candidatesLoading = ref(false)
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
  candidatesLoading.value = true
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
  } finally {
    candidatesLoading.value = false
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

// H4-3 keyboard — retry focus restore (same pattern as StockPreparationDashboardView.vue's H4-1
// retry). Both retry buttons above carry `:disabled` while their own load is in flight, and the button UNMOUNTS — its error branch
// yields to the loading branch, leaving the DOM entirely — the browser drops focus to <body>, stranding a
// keyboard operator who just pressed Retry. After the load settles we put focus back on the button,
// but ONLY when it is still rendered (the retry failed again, so there is something to press) AND
// focus is still on <body> (our own unmount dropped it, and the operator has not Tabbed elsewhere
// meanwhile) — the second condition is REQUIRED so this can never steal focus from wherever the
// operator moved to.
const retryEl = ref<HTMLButtonElement | null>(null)
const candidatesRetryEl = ref<HTMLButtonElement | null>(null)

async function restoreRetryFocus(el: Ref<HTMLButtonElement | null>): Promise<void> {
  await nextTick()
  if (document.activeElement === document.body) el.value?.focus()
}

async function onRetry(): Promise<void> {
  await loadAll()
  await restoreRetryFocus(retryEl)
}

async function onCandidatesRetry(): Promise<void> {
  await loadCandidates()
  await restoreRetryFocus(candidatesRetryEl)
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

.sp-unit__state-msg {
  margin: 0 0 var(--ms-space-2);
}

.sp-unit__retry {
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: transparent;
  padding: 4px 12px;
  color: var(--ms-color-primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.sp-unit__retry:hover:not(:disabled) {
  background: var(--el-fill-color-light);
}

.sp-unit__retry:disabled {
  opacity: 0.5;
  cursor: default;
}

.sp-unit__retry:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
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

.sp-unit__scope-note {
  margin: 0;
  color: var(--ms-text-3);
  font-size: 12px;
  font-style: italic;
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

/* H4-3 long-table: bounded height + BOTH-axis overflow, so the table scrolls inside its OWN box and
   the sticky thead below has an actual scroll range to stick within (an `overflow-x: auto`-only wrap
   never scrolls vertically, so a sticky header inside it would never engage). */
.sp-unit__table-wrap {
  max-height: 420px;
  overflow: auto;
}

.sp-unit__table-wrap:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}

.sp-unit__table {
  width: 100%;
  min-width: 700px;
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
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--ms-bg-card);
  color: var(--ms-text-3);
  font-weight: var(--ms-font-weight-title);
}

/* The server token, kept beside the words it means — subordinate, still copyable. */
.sp-unit__token {
  display: inline-block;
  margin-left: var(--ms-space-1);
  color: var(--ms-text-3);
  font-size: 11px;
  word-break: break-all;
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

/* H4-3 keyboard: one focus-ring system across the stock-prep surface (same idiom as the H4-2
   dashboard/stepper rings). Covers the confirm/retire/submit/stale-refresh buttons and every field
   control (the stale-refresh button above already carries this class). */
.sp-unit__action:focus-visible,
.sp-unit__field input:focus-visible,
.sp-unit__field select:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
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
