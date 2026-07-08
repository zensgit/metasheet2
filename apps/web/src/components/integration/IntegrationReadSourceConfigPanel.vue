<template>
  <div class="integration-read-source" data-testid="read-source-panel">
    <p class="integration-read-source__hint">
      顾问/管理员在这里配置第三方 API 的只读读取源：填写 S1 结构 → 定位容器探测(values-free)→ 保存版本(内容寻址,幂等)→ 审批后运行时才可选用。
      终端用户只能选择已审批的读取源并提供业务 key,永远不能提交原始端点 / 过滤器 / 响应路径。本面板不含任何写入 / 删除能力。
    </p>

    <div class="integration-read-source__columns">
      <div class="integration-read-source__form" data-testid="read-source-form">
        <h3>新建 / 试配读取源</h3>

        <!-- TC-1 (design-lock docs/development/integration-connector-template-catalog-design-lock-20260708.md,
             #3879): an ADD-ONLY alternative entry point — collapsed by default, so the pre-existing
             wizard/flat-form default surface and every existing assertion about it are untouched.
             Selecting a card seeds `draft.mode` (the exact field IntegrationReadSourceWizard.vue's own
             `selectMode()` sets) and forces the view back to the wizard, then falls through to the
             SAME step-1/2/3/4 flow — no new state, no new path. -->
        <IntegrationTemplateCatalogPicker
          seeds-wizard="read-source"
          testid-prefix="rsc"
          @select="applyReadSourceTemplate"
        />

        <!-- IU-3 (design-lock docs/development/integration-iu3-read-source-wizard-design-lock-20260707.md):
             the wizard is the DEFAULT surface; this toggle switches to the untouched full flat form
             below (折叠≠删除 — expert mode is retained, never removed). Native <button>, not an
             el-switch/el-radio-group: those Element Plus controls only toggle via their OWN internal
             JS, which is a no-op when EP isn't globally registered (e.g. this file's existing spec's
             bare `createApp()`) — a native button works identically everywhere. -->
        <div class="integration-read-source__mode-toggle">
          <button
            type="button"
            class="integration-read-source__mode-toggle-button"
            data-testid="rsc-mode-toggle"
            @click="toggleViewMode"
          >
            <el-icon><component :is="viewMode === 'wizard' ? Setting : MagicStick" /></el-icon>
            {{ viewMode === 'wizard' ? bi('专家表单', 'Expert form') : bi('返回向导', 'Back to wizard') }}
          </button>
        </div>

        <IntegrationReadSourceWizard
          v-if="viewMode === 'wizard'"
          :draft="draft"
          :systems="systems"
          :probing="probing"
          :saving="saving"
          :action-error="actionError"
          :probe-evidence="probeEvidence"
          :save-result="saveResult"
          v-model:bounded-smoke="boundedSmoke"
          v-model:probe-key="probeKey"
          @run-probe="runProbe"
          @save-version="saveVersion"
          @approve-saved="approveSavedResult"
        />

        <template v-else>
        <label class="integration-read-source__field">
          <span>外部系统(systemId)</span>
          <select v-model="draft.systemId" data-testid="rsc-system" @change="onSystemChange">
            <option value="">请选择已配置系统</option>
            <option v-for="system in systems" :key="system.id" :value="system.id">
              {{ system.name }} ({{ system.kind }})
            </option>
          </select>
        </label>

        <label class="integration-read-source__field">
          <el-tooltip :content="fieldHint('readSource.requiredKind')" placement="top" data-testid="rsc-hint-required-kind">
            <span>requiredKind(随所选系统)</span>
          </el-tooltip>
          <input :value="draft.requiredKind" data-testid="rsc-required-kind" readonly placeholder="选择系统后自动填充" />
        </label>

        <label class="integration-read-source__field">
          <span>object(读取对象名)</span>
          <input v-model="draft.object" data-testid="rsc-object" placeholder="material" />
        </label>

        <label class="integration-read-source__field">
          <el-tooltip :content="fieldHint('readSource.mode')" placement="top" data-testid="rsc-hint-mode">
            <span>mode(四种已验证读取模式)</span>
          </el-tooltip>
          <select v-model="draft.mode" data-testid="rsc-mode">
            <option v-for="mode in READ_SOURCE_MODES" :key="mode" :value="mode">{{ mode }}</option>
          </select>
        </label>

        <label class="integration-read-source__field">
          <el-tooltip :content="fieldHint('readSource.readPath')" placement="top" data-testid="rsc-hint-read-path">
            <span>readPath(仅相对路径;绝对 URL、%、\、.. 会被拒绝)</span>
          </el-tooltip>
          <input v-model="draft.readPath" data-testid="rsc-read-path" placeholder="/K3API/Material/GetDetail" />
        </label>

        <label class="integration-read-source__field">
          <span>readMethod</span>
          <select v-model="draft.readMethod" data-testid="rsc-read-method">
            <option v-for="method in READ_SOURCE_METHODS" :key="method" :value="method">{{ method }}</option>
          </select>
        </label>

        <label class="integration-read-source__field">
          <span>operations(本线只读,不可编辑)</span>
          <input value="read" data-testid="rsc-operations" readonly disabled />
        </label>

        <label class="integration-read-source__field">
          <span>version(正整数)</span>
          <input v-model.number="draft.version" type="number" min="1" data-testid="rsc-version" />
        </label>

        <template v-if="showKeyField">
          <label class="integration-read-source__field">
            <el-tooltip :content="fieldHint('readSource.keyField')" placement="top" data-testid="rsc-hint-key-field">
              <span>keyField{{ keyFieldRequired ? '(必填)' : '(可选)' }}</span>
            </el-tooltip>
            <input v-model="draft.keyField" data-testid="rsc-key-field" placeholder="FNumber" />
          </label>
          <label class="integration-read-source__field">
            <el-tooltip :content="fieldHint('readSource.keyEncoding')" placement="top" data-testid="rsc-hint-key-encoding">
              <span>keyEncoding(可选)</span>
            </el-tooltip>
            <select v-model="draft.keyEncoding" data-testid="rsc-key-encoding">
              <option value="">(不指定)</option>
              <option v-for="encoding in READ_SOURCE_KEY_ENCODINGS" :key="encoding" :value="encoding">{{ encoding }}</option>
            </select>
          </label>
        </template>

        <template v-if="draft.mode === 'resolver_lookup'">
          <label class="integration-read-source__field">
            <el-tooltip :content="fieldHint('readSource.resolverRule')" placement="top" data-testid="rsc-hint-resolver-rule">
              <span>resolverRule(必填)</span>
            </el-tooltip>
            <select v-model="draft.resolverRule" data-testid="rsc-resolver-rule">
              <option value="">选择解析规则…</option>
              <option value="exactly_one">exactly_one(唯一命中)</option>
              <option value="first_when_sorted">first_when_sorted(排序取首)</option>
              <option value="field_equals">field_equals(判别字段相等)</option>
            </select>
          </label>
          <!-- first_when_sorted: sort field + direction. exactly_one shows none of these three. -->
          <label v-if="draft.resolverRule === 'first_when_sorted'" class="integration-read-source__field">
            <el-tooltip :content="fieldHint('readSource.resolverSortField')" placement="top" data-testid="rsc-hint-resolver-sort-field">
              <span>multiplicityRuleField(排序字段,必填)</span>
            </el-tooltip>
            <input v-model="draft.multiplicityRuleField" data-testid="rsc-resolver-sort-field" placeholder="FVersion" />
          </label>
          <label v-if="draft.resolverRule === 'first_when_sorted'" class="integration-read-source__field">
            <el-tooltip :content="fieldHint('readSource.resolverSortDirection')" placement="top" data-testid="rsc-hint-resolver-sort-direction">
              <span>resolverSortDirection(必填)</span>
            </el-tooltip>
            <select v-model="draft.resolverSortDirection" data-testid="rsc-resolver-sort-direction">
              <option value="">选择方向…</option>
              <option value="asc">asc(升序取首)</option>
              <option value="desc">desc(降序取首)</option>
            </select>
          </label>
          <!-- field_equals: discriminator field + bounded token value. -->
          <label v-if="draft.resolverRule === 'field_equals'" class="integration-read-source__field">
            <el-tooltip :content="fieldHint('readSource.resolverDiscriminatorField')" placement="top" data-testid="rsc-hint-resolver-discriminator-field">
              <span>multiplicityRuleField(判别字段,必填)</span>
            </el-tooltip>
            <input v-model="draft.multiplicityRuleField" data-testid="rsc-resolver-discriminator-field" placeholder="FIsCurrent" />
          </label>
          <label v-if="draft.resolverRule === 'field_equals'" class="integration-read-source__field">
            <el-tooltip :content="fieldHint('readSource.resolverDiscriminatorValue')" placement="top" data-testid="rsc-hint-resolver-discriminator-value">
              <span>resolverDiscriminatorValue(有界枚举样 token,必填)</span>
            </el-tooltip>
            <input v-model="draft.resolverDiscriminatorValue" data-testid="rsc-resolver-discriminator-value" placeholder="Y" />
          </label>
        </template>

        <label v-if="draft.mode !== 'detail_with_lines'" class="integration-read-source__field">
          <el-tooltip :content="fieldHint('readSource.containerPaths')" placement="top" data-testid="rsc-hint-container-paths">
            <span>containerPaths(逗号/换行分隔的点号路径,必填)</span>
          </el-tooltip>
          <input v-model="draft.containerPaths" data-testid="rsc-container-paths" placeholder="Data.Data, Data.DATA" />
        </label>

        <template v-if="draft.mode === 'detail_with_lines'">
          <label class="integration-read-source__field">
            <el-tooltip :content="fieldHint('readSource.headerContainerPaths')" placement="top" data-testid="rsc-hint-header-container-paths">
              <span>headerContainerPaths(必填)</span>
            </el-tooltip>
            <input v-model="draft.headerContainerPaths" data-testid="rsc-header-container-paths" placeholder="Data.Page1" />
          </label>
          <label class="integration-read-source__field">
            <el-tooltip :content="fieldHint('readSource.lineContainerPaths')" placement="top" data-testid="rsc-hint-line-container-paths">
              <span>lineContainerPaths(必填)</span>
            </el-tooltip>
            <input v-model="draft.lineContainerPaths" data-testid="rsc-line-container-paths" placeholder="Data.Page2" />
          </label>
        </template>

        <div class="integration-read-source__field-map">
          <div class="integration-read-source__field-map-head">
            <el-tooltip :content="fieldHint('readSource.fieldMap')" placement="top" data-testid="rsc-hint-field-map">
              <span>fieldMap(数据面字段映射,可选;source=响应字段路径,target=清洗列)</span>
            </el-tooltip>
            <button type="button" class="integration-workbench__button" data-testid="rsc-field-map-add" @click="addFieldMapRow">
              添加映射行
            </button>
          </div>
          <div
            v-for="(entry, index) in draft.fieldMap"
            :key="index"
            class="integration-read-source__field-map-row"
          >
            <input v-model="entry.source" :data-testid="`rsc-field-map-source-${index}`" placeholder="FName" />
            <span>→</span>
            <input v-model="entry.target" :data-testid="`rsc-field-map-target-${index}`" placeholder="material_name" />
            <button type="button" class="integration-workbench__button" :data-testid="`rsc-field-map-remove-${index}`" @click="removeFieldMapRow(index)">
              删除
            </button>
          </div>
        </div>

        <ul v-if="validationProblems.length > 0" class="integration-read-source__problems" data-testid="rsc-validation">
          <li v-for="problem in validationProblems" :key="problem">{{ problem }}</li>
        </ul>

        <div class="integration-read-source__probe-controls">
          <label class="integration-read-source__inline">
            <input v-model="boundedSmoke" type="checkbox" data-testid="rsc-bounded-smoke" />
            <el-tooltip :content="fieldHint('readSource.boundedSmoke')" placement="top" data-testid="rsc-hint-bounded-smoke">
              <span>bounded smoke(受平台上限约束的试读计数)</span>
            </el-tooltip>
          </label>
          <label v-if="probeNeedsKey" class="integration-read-source__inline">
            <span>探测 key(业务键值,仅用于本次探测,不会保存)</span>
            <input v-model="probeKey" data-testid="rsc-probe-key" placeholder="MAT-001" />
          </label>
        </div>

        <div class="integration-read-source__actions">
          <button
            type="button"
            class="integration-workbench__button"
            data-testid="rsc-probe"
            :disabled="probing || validationProblems.length > 0"
            @click="runProbe"
          >{{ probing ? '探测中…' : '定位容器探测' }}</button>
          <button
            type="button"
            class="integration-workbench__button"
            data-testid="rsc-save"
            :disabled="saving || validationProblems.length > 0"
            @click="saveVersion"
          >{{ saving ? '保存中…' : '保存版本' }}</button>
        </div>

        <p v-if="actionError" class="integration-read-source__error" data-testid="rsc-error">{{ actionError }}</p>

        <div v-if="probeEvidence" class="integration-read-source__evidence" data-testid="rsc-probe-evidence">
          <h4>探测证据(values-free)</h4>
          <ul>
            <li data-testid="rsc-evidence-ok">ok: {{ probeEvidence.ok ? 'true' : 'false' }}</li>
            <li v-if="probeEvidence.containerLocated !== undefined" data-testid="rsc-evidence-located">
              containerLocated: {{ probeEvidence.containerLocated ? 'true' : 'false' }}
            </li>
            <li
              v-for="entry in evidenceContainers"
              :key="entry.alias"
              :data-testid="`rsc-evidence-container-${entry.alias}`"
            >
              {{ entry.alias }}: type={{ entry.shape.type }}<template v-if="entry.shape.arrayLength !== undefined">, arrayLength={{ entry.shape.arrayLength === null ? 'null' : entry.shape.arrayLength }}</template>
            </li>
            <li v-if="probeEvidence.boundedSmokeExecuted !== undefined" data-testid="rsc-evidence-smoke">
              boundedSmokeExecuted: {{ probeEvidence.boundedSmokeExecuted ? 'true' : 'false' }}
            </li>
            <li v-if="probeEvidence.recordCount !== undefined" data-testid="rsc-evidence-record-count">
              recordCount: {{ probeEvidence.recordCount }}
            </li>
            <li v-if="probeEvidence.capReached !== undefined" data-testid="rsc-evidence-cap">
              capReached: {{ probeEvidence.capReached ? 'true' : 'false' }}
            </li>
            <li v-if="probeEvidence.timeoutReached !== undefined" data-testid="rsc-evidence-timeout">
              timeoutReached: {{ probeEvidence.timeoutReached ? 'true' : 'false' }}
            </li>
            <li v-if="probeEvidence.errorCode" data-testid="rsc-evidence-error-label">
              {{ probeEvidenceErrorLabel }}<template v-if="probeEvidenceErrorHint"> — {{ probeEvidenceErrorHint }}</template>
              <small data-testid="rsc-evidence-error-code">errorCode: {{ probeEvidence.errorCode }}</small>
            </li>
            <li v-if="probeEvidence.errorType" data-testid="rsc-evidence-error-type">errorType: {{ probeEvidence.errorType }}</li>
          </ul>
        </div>

        <p v-if="saveResult" class="integration-read-source__save-result" data-testid="rsc-save-result">
          {{ saveResult.reused ? `已复用现有版本 v${saveResult.version}` : `已保存新版本 v${saveResult.version}` }}(status: {{ saveResult.status }})
        </p>
        </template>
      </div>

      <div class="integration-read-source__list" data-testid="read-source-list">
        <div class="integration-read-source__list-head">
          <h3>已保存读取源</h3>
          <button type="button" class="integration-workbench__button" data-testid="rsc-refresh" :disabled="loading" @click="refresh">
            {{ loading ? '加载中…' : '刷新' }}
          </button>
        </div>
        <p v-if="listError" class="integration-read-source__error" data-testid="rsc-list-error">{{ listError }}</p>
        <div
          v-if="!loading && configs.length === 0"
          class="integration-read-source__empty integration-read-source__empty--guided"
          data-testid="rsc-empty"
        >
          <strong data-testid="rsc-empty-what">{{ bi(
            '这里展示已保存的读取源版本（草稿 / 已审批 / 已停用）。',
            'This list shows saved read-source versions (draft / approved / retired).',
          ) }}</strong>
          <p data-testid="rsc-empty-first-step">{{ bi(
            '第一步：在左侧表单选系统、填必填字段并「定位容器探测」，通过后「保存版本」即可出现在此列表。',
            'First step: pick a system on the left, fill in the required fields, run "locate container probe", then "save version" — it will then appear in this list.',
          ) }}</p>
        </div>
        <table v-if="configs.length > 0" class="integration-read-source__table">
          <thead>
            <tr>
              <th>system</th><th>object</th><th>mode</th><th>版本</th><th>状态</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="row in configs" :key="row.id">
              <tr :data-testid="`rsc-row-${row.id}`">
                <td>{{ row.systemId }}</td>
                <td>{{ row.object }}</td>
                <td>{{ row.mode }}</td>
                <td>v{{ row.version }}</td>
                <td>
                  <span class="integration-read-source__status" :data-status="row.status" :data-testid="`rsc-status-${row.id}`">
                    {{ statusLabel(row.status) }}
                  </span>
                </td>
                <td class="integration-read-source__row-actions">
                  <button
                    v-if="row.status === 'draft'"
                    type="button"
                    class="integration-workbench__button"
                    :data-testid="`rsc-approve-${row.id}`"
                    @click="approve(row)"
                  >审批</button>
                  <button
                    v-if="row.status === 'approved'"
                    type="button"
                    class="integration-workbench__button"
                    :data-testid="`rsc-retire-${row.id}`"
                    @click="retire(row)"
                  >停用</button>
                  <button
                    type="button"
                    class="integration-workbench__button"
                    :data-testid="`rsc-audit-toggle-${row.id}`"
                    @click="toggleAudit(row)"
                  >{{ auditConfigId === row.id ? '收起审计' : '审计' }}</button>
                </td>
              </tr>
              <tr v-if="auditConfigId === row.id" :data-testid="`rsc-audit-${row.id}`">
                <td colspan="6">
                  <ul class="integration-read-source__audit" data-testid="rsc-audit-list">
                    <li v-if="auditRows.length === 0">暂无审计记录。</li>
                    <li v-for="(entry, index) in auditRows" :key="index">
                      {{ auditActionLabel(entry.action) }} · {{ entry.actor || '(unknown)' }} · {{ entry.createdAt || '' }}
                    </li>
                  </ul>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// External-API read self-service (#1709) — S3 consultant self-service panel.
// Consultant/config tier only; probe + save + approve/retire + values-free audit.
// The probe evidence path is allowlist-normalized in the service layer, so row values or
// field keys can never reach this template even from a malformed response.
import { computed, reactive, ref, watch } from 'vue'
import { MagicStick, Setting } from '@element-plus/icons-vue'
import { useLocale } from '../../composables/useLocale'
import { integrationErrorCodeDisplayLabel, integrationErrorCodeHint } from '../../services/integration/errorCodeLabels'
import { integrationFieldHint, type IntegrationFieldHintKey } from '../../services/integration/fieldHints'
import type { IntegrationScope, WorkbenchExternalSystem } from '../../services/integration/workbench'
import {
  READ_SOURCE_KEY_ENCODINGS,
  READ_SOURCE_METHODS,
  READ_SOURCE_MODES,
  approveReadSourceConfig,
  buildReadSourceConfigPayload,
  createReadSourceConfigDraft,
  deriveReadSourceProbeEvidenceContainers,
  listReadSourceConfigAudit,
  listReadSourceConfigs,
  probeReadSourceConfig,
  retireReadSourceConfig,
  saveReadSourceConfigVersion,
  validateReadSourceDraft,
  type ReadSourceAuditRow,
  type ReadSourceConfigRow,
  type ReadSourceProbeEvidence,
  type ReadSourceSaveResult,
  type ReadSourceStatus,
} from '../../services/integration/readSourceConfigs'
import {
  isReadSourceTemplateEntry,
  seedReadSourceDraft,
  type IntegrationTemplateCatalogEntry,
} from '../../services/integration/readSourceTemplateCatalog'
import IntegrationReadSourceWizard from './IntegrationReadSourceWizard.vue'
import IntegrationTemplateCatalogPicker from './IntegrationTemplateCatalogPicker.vue'

// IU-3 (design-lock docs/development/integration-iu3-read-source-wizard-design-lock-20260707.md):
// the wizard is the DEFAULT new-config surface; `initialViewMode` lets a caller (incl. this file's
// own spec, which targets the pre-existing flat-form testids) pin the panel to 'expert' so it renders
// today's full field-flat form with ZERO wizard indirection — no existing assertion had to change.
const props = defineProps<{
  scope: IntegrationScope
  systems: WorkbenchExternalSystem[]
  initialViewMode?: 'wizard' | 'expert'
}>()

const viewMode = ref<'wizard' | 'expert'>(props.initialViewMode ?? 'wizard')
function toggleViewMode(): void {
  viewMode.value = viewMode.value === 'wizard' ? 'expert' : 'wizard'
}

const { locale } = useLocale()

const draft = reactive(createReadSourceConfigDraft())
const boundedSmoke = ref(false)
const probeKey = ref('')
const probing = ref(false)
const saving = ref(false)
const loading = ref(false)
const actionError = ref('')
const listError = ref('')
const probeEvidence = ref<ReadSourceProbeEvidence | null>(null)
const saveResult = ref<ReadSourceSaveResult | null>(null)
const configs = ref<ReadSourceConfigRow[]>([])
const auditConfigId = ref('')
const auditRows = ref<ReadSourceAuditRow[]>([])

const validationProblems = computed(() => validateReadSourceDraft(draft))
const evidenceContainers = computed(() => deriveReadSourceProbeEvidenceContainers(probeEvidence.value?.containers))
// IU-1: humanized probe evidence errorCode label (+ optional hint). The raw code stays visible in a
// demoted/secondary spot (data-testid="rsc-evidence-error-code") for expert troubleshooting — only the
// backend's free-text errorMessage (which does not exist on this evidence shape) would be unsafe to
// render; the code itself is a registered, values-free vocabulary.
const probeEvidenceErrorLabel = computed(() =>
  integrationErrorCodeDisplayLabel(probeEvidence.value?.errorCode, locale.value),
)
const probeEvidenceErrorHint = computed(() =>
  integrationErrorCodeHint(probeEvidence.value?.errorCode, locale.value),
)
// IU-6b: field-level hint copy (values-free, zh+en) for the highest-confusion fields. Exact-key
// lookup against the dedicated fieldHints module — no copy lives in this component.
function fieldHint(key: IntegrationFieldHintKey): string {
  return integrationFieldHint(key, locale.value)
}

// IU-6a: bilingual guidance copy helper — same locale pattern as `fieldHint`/the IU-1 error labels
// (reads `locale.value` synchronously; Vue's render tracking makes template calls to this reactive
// without needing a dedicated `computed` per string).
function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const showKeyField = computed(() => draft.mode !== 'list_page')
const keyFieldRequired = computed(() => draft.mode === 'single_record' || draft.mode === 'resolver_lookup')
// The S2-b runtime requires inputs.key exactly when the config declares a keyField.
const probeNeedsKey = computed(() => showKeyField.value && draft.keyField.trim().length > 0)

// Probe evidence / save result describe the config that was probed/saved — ANY draft change
// (system switch, mode, path, containers, fieldMap, …) makes them stale, so clear both. watch on a
// reactive object is implicitly deep.
watch(draft, () => {
  probeEvidence.value = null
  saveResult.value = null
})

function onSystemChange(): void {
  const system = props.systems.find((item) => item.id === draft.systemId)
  draft.requiredKind = system ? system.kind : ''
}

function addFieldMapRow(): void {
  draft.fieldMap.push({ source: '', target: '' })
}

function removeFieldMapRow(index: number): void {
  draft.fieldMap.splice(index, 1)
}

// TC-1 (design-lock docs/development/integration-connector-template-catalog-design-lock-20260708.md):
// seed-then-present — the SAME shared `draft` the wizard/flat-form already bind to, mutated by exactly
// one field (`seedReadSourceDraft` mirrors the wizard's own `selectMode()`), then the view is forced
// back to 'wizard' so the pre-filled state is immediately visible on the surface it was seeded for.
// The picker is wired with seeds-wizard="read-source" so only ReadSourceTemplateCatalogEntry values are
// ever emitted here; the type guard is a defensive narrowing, not a behavior branch.
function applyReadSourceTemplate(entry: IntegrationTemplateCatalogEntry): void {
  if (!isReadSourceTemplateEntry(entry)) return
  seedReadSourceDraft(draft, entry)
  viewMode.value = 'wizard'
}

function statusLabel(status: ReadSourceStatus): string {
  if (status === 'approved') return '已审批'
  if (status === 'retired') return '已停用'
  return '草稿'
}

function auditActionLabel(action: ReadSourceAuditRow['action']): string {
  if (action === 'save_version') return '保存新版本'
  if (action === 'reuse_version') return '复用已有版本'
  return '状态变更'
}

function coarseErrorMessage(error: unknown): string {
  // Coarse only: code/reason enums, never submitted values.
  if (error instanceof Error) return error.message
  return '读取源接口请求失败'
}

async function refresh(): Promise<void> {
  loading.value = true
  listError.value = ''
  try {
    configs.value = await listReadSourceConfigs(props.scope)
  } catch (error) {
    listError.value = coarseErrorMessage(error)
  } finally {
    loading.value = false
  }
}

async function runProbe(): Promise<void> {
  actionError.value = ''
  probeEvidence.value = null
  if (probeNeedsKey.value && !probeKey.value.trim()) {
    actionError.value = '该配置声明了 keyField,探测需要提供业务 key'
    return
  }
  probing.value = true
  try {
    probeEvidence.value = await probeReadSourceConfig(draft.systemId.trim(), {
      config: buildReadSourceConfigPayload(draft),
      boundedSmoke: boundedSmoke.value,
      key: probeNeedsKey.value ? probeKey.value : undefined,
    }, props.scope)
  } catch (error) {
    actionError.value = coarseErrorMessage(error)
  } finally {
    probing.value = false
  }
}

async function saveVersion(): Promise<void> {
  actionError.value = ''
  saveResult.value = null
  saving.value = true
  try {
    saveResult.value = await saveReadSourceConfigVersion(buildReadSourceConfigPayload(draft), props.scope)
    await refresh()
  } catch (error) {
    actionError.value = coarseErrorMessage(error)
  } finally {
    saving.value = false
  }
}

async function approve(row: ReadSourceConfigRow): Promise<void> {
  if (!window.confirm(`审批后运行时即可选用该读取源(${row.object} v${row.version})。确认审批?`)) return
  actionError.value = ''
  try {
    await approveReadSourceConfig(row.id, props.scope)
    await refresh()
  } catch (error) {
    actionError.value = coarseErrorMessage(error)
  }
}

// IU-3 step 4 (审批): the wizard's "save version → submit for approval" flow saves via the SAME
// `saveVersion()` above, then approves the just-saved id via the SAME `approveReadSourceConfig` +
// `refresh()` service path the list-row `approve()` button already uses below — existing service
// paths only, no new route/call shape (design-lock §2 hard lock).
async function approveSavedResult(): Promise<void> {
  const result = saveResult.value
  if (!result) return
  if (!window.confirm(`审批后运行时即可选用该读取源(${draft.object} v${result.version})。确认审批?`)) return
  actionError.value = ''
  try {
    await approveReadSourceConfig(result.id, props.scope)
    await refresh()
  } catch (error) {
    actionError.value = coarseErrorMessage(error)
  }
}

async function retire(row: ReadSourceConfigRow): Promise<void> {
  actionError.value = ''
  try {
    await retireReadSourceConfig(row.id, props.scope)
    await refresh()
  } catch (error) {
    actionError.value = coarseErrorMessage(error)
  }
}

async function toggleAudit(row: ReadSourceConfigRow): Promise<void> {
  if (auditConfigId.value === row.id) {
    auditConfigId.value = ''
    auditRows.value = []
    return
  }
  actionError.value = ''
  try {
    auditRows.value = await listReadSourceConfigAudit(row.id, props.scope)
    auditConfigId.value = row.id
  } catch (error) {
    actionError.value = coarseErrorMessage(error)
  }
}

void refresh()
</script>

<style scoped>
.integration-read-source__hint {
  color: #666;
  font-size: 13px;
  margin: 0 0 12px;
}
/* IU-3 (design-lock docs/development/integration-iu3-read-source-wizard-design-lock-20260707.md):
   new markup only — token-only per §3 hard lock (the rules above/below this block are the
   pre-existing IU-2-scope styles and are left untouched, hex and all). */
.integration-read-source__mode-toggle {
  display: flex;
  justify-content: flex-end;
  margin-bottom: var(--ms-space-3);
}
.integration-read-source__mode-toggle-button {
  display: inline-flex;
  align-items: center;
  gap: var(--ms-space-1);
  padding: var(--ms-space-1) var(--ms-space-3);
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-sm);
  background: var(--ms-bg-card);
  color: var(--ms-color-primary);
  font-size: 13px;
  cursor: pointer;
}
.integration-read-source__mode-toggle-button:hover {
  background: var(--ms-bg-page);
}
.integration-read-source__columns {
  display: grid;
  grid-template-columns: minmax(320px, 1fr) minmax(360px, 1.2fr);
  gap: 20px;
}
.integration-read-source__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
  font-size: 13px;
}
.integration-read-source__field input,
.integration-read-source__field select {
  padding: 6px 8px;
  border: 1px solid #d0d0d0;
  border-radius: 4px;
}
.integration-read-source__field-map-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 6px 0;
}
.integration-read-source__inline {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  margin: 6px 0;
}
.integration-read-source__actions {
  display: flex;
  gap: 8px;
  margin: 10px 0;
}
.integration-read-source__problems {
  color: #b45309;
  font-size: 12px;
  padding-left: 18px;
}
.integration-read-source__error {
  color: #b91c1c;
  font-size: 13px;
}
.integration-read-source__evidence {
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  padding: 10px 12px;
  margin-top: 10px;
  font-size: 13px;
}
.integration-read-source__evidence ul {
  margin: 6px 0 0;
  padding-left: 18px;
}
.integration-read-source__save-result {
  color: #15803d;
  font-size: 13px;
}
.integration-read-source__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.integration-read-source__table th,
.integration-read-source__table td {
  border-bottom: 1px solid #eee;
  padding: 6px 8px;
  text-align: left;
}
.integration-read-source__status[data-status='approved'] {
  color: #15803d;
}
.integration-read-source__status[data-status='draft'] {
  color: #b45309;
}
.integration-read-source__status[data-status='retired'] {
  color: #6b7280;
}
.integration-read-source__row-actions {
  display: flex;
  gap: 6px;
}
.integration-read-source__list-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.integration-read-source__empty {
  color: #888;
  font-size: 13px;
}
/* IU-6a guided empty state: "what this is" + "first step" — new styling only, tokens per UF-1. */
.integration-read-source__empty--guided {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
}
.integration-read-source__empty--guided strong {
  color: var(--ms-text-1);
}
.integration-read-source__empty--guided p {
  margin: 0;
}
.integration-read-source__audit {
  margin: 4px 0;
  padding-left: 18px;
  font-size: 12px;
  color: #555;
}
@media (max-width: 960px) {
  .integration-read-source__columns {
    grid-template-columns: 1fr;
  }
}
</style>
