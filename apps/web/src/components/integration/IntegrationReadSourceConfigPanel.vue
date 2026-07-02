<template>
  <div class="integration-read-source" data-testid="read-source-panel">
    <p class="integration-read-source__hint">
      顾问/管理员在这里配置第三方 API 的只读读取源：填写 S1 结构 → 定位容器探测(values-free)→ 保存版本(内容寻址,幂等)→ 审批后运行时才可选用。
      终端用户只能选择已审批的读取源并提供业务 key,永远不能提交原始端点 / 过滤器 / 响应路径。本面板不含任何写入 / 删除能力。
    </p>

    <div class="integration-read-source__columns">
      <div class="integration-read-source__form" data-testid="read-source-form">
        <h3>新建 / 试配读取源</h3>

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
          <span>requiredKind(随所选系统)</span>
          <input :value="draft.requiredKind" data-testid="rsc-required-kind" readonly placeholder="选择系统后自动填充" />
        </label>

        <label class="integration-read-source__field">
          <span>object(读取对象名)</span>
          <input v-model="draft.object" data-testid="rsc-object" placeholder="material" />
        </label>

        <label class="integration-read-source__field">
          <span>mode(四种已验证读取模式)</span>
          <select v-model="draft.mode" data-testid="rsc-mode">
            <option v-for="mode in READ_SOURCE_MODES" :key="mode" :value="mode">{{ mode }}</option>
          </select>
        </label>

        <label class="integration-read-source__field">
          <span>readPath(仅相对路径;绝对 URL、%、\、.. 会被拒绝)</span>
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
            <span>keyField{{ keyFieldRequired ? '(必填)' : '(可选)' }}</span>
            <input v-model="draft.keyField" data-testid="rsc-key-field" placeholder="FNumber" />
          </label>
          <label class="integration-read-source__field">
            <span>keyEncoding(可选)</span>
            <select v-model="draft.keyEncoding" data-testid="rsc-key-encoding">
              <option value="">(不指定)</option>
              <option v-for="encoding in READ_SOURCE_KEY_ENCODINGS" :key="encoding" :value="encoding">{{ encoding }}</option>
            </select>
          </label>
        </template>

        <label v-if="draft.mode === 'resolver_lookup'" class="integration-read-source__field">
          <span>multiplicityRuleField(必填)</span>
          <input v-model="draft.multiplicityRuleField" data-testid="rsc-multiplicity-field" placeholder="FIsCurrent" />
        </label>

        <label v-if="draft.mode !== 'detail_with_lines'" class="integration-read-source__field">
          <span>containerPaths(逗号/换行分隔的点号路径,必填)</span>
          <input v-model="draft.containerPaths" data-testid="rsc-container-paths" placeholder="Data.Data, Data.DATA" />
        </label>

        <template v-if="draft.mode === 'detail_with_lines'">
          <label class="integration-read-source__field">
            <span>headerContainerPaths(必填)</span>
            <input v-model="draft.headerContainerPaths" data-testid="rsc-header-container-paths" placeholder="Data.Page1" />
          </label>
          <label class="integration-read-source__field">
            <span>lineContainerPaths(必填)</span>
            <input v-model="draft.lineContainerPaths" data-testid="rsc-line-container-paths" placeholder="Data.Page2" />
          </label>
        </template>

        <div class="integration-read-source__field-map">
          <div class="integration-read-source__field-map-head">
            <span>fieldMap(数据面字段映射,可选;source=响应字段路径,target=清洗列)</span>
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
            <span>bounded smoke(受平台上限约束的试读计数)</span>
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
            <li v-if="probeEvidence.errorCode" data-testid="rsc-evidence-error-code">errorCode: {{ probeEvidence.errorCode }}</li>
            <li v-if="probeEvidence.errorType" data-testid="rsc-evidence-error-type">errorType: {{ probeEvidence.errorType }}</li>
          </ul>
        </div>

        <p v-if="saveResult" class="integration-read-source__save-result" data-testid="rsc-save-result">
          {{ saveResult.reused ? `已复用现有版本 v${saveResult.version}` : `已保存新版本 v${saveResult.version}` }}(status: {{ saveResult.status }})
        </p>
      </div>

      <div class="integration-read-source__list" data-testid="read-source-list">
        <div class="integration-read-source__list-head">
          <h3>已保存读取源</h3>
          <button type="button" class="integration-workbench__button" data-testid="rsc-refresh" :disabled="loading" @click="refresh">
            {{ loading ? '加载中…' : '刷新' }}
          </button>
        </div>
        <p v-if="listError" class="integration-read-source__error" data-testid="rsc-list-error">{{ listError }}</p>
        <p v-if="!loading && configs.length === 0" class="integration-read-source__empty" data-testid="rsc-empty">
          暂无读取源配置。
        </p>
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
import type { IntegrationScope, WorkbenchExternalSystem } from '../../services/integration/workbench'
import {
  READ_SOURCE_KEY_ENCODINGS,
  READ_SOURCE_METHODS,
  READ_SOURCE_MODES,
  approveReadSourceConfig,
  buildReadSourceConfigPayload,
  createReadSourceConfigDraft,
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

const props = defineProps<{
  scope: IntegrationScope
  systems: WorkbenchExternalSystem[]
}>()

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
const evidenceContainers = computed(() => {
  const containers = probeEvidence.value?.containers
  if (!containers) return []
  return (['primary', 'header', 'lines'] as const).flatMap((alias) => {
    const shape = containers[alias]
    return shape ? [{ alias, shape }] : []
  })
})
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
