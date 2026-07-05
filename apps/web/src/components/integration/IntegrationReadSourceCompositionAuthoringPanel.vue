<template>
  <div class="integration-read-source-composition-authoring" data-testid="rscomp-author-panel">
    <p class="integration-read-source-composition-authoring__hint">
      顾问/管理员在这里把两个已审批 resolver_lookup 读取源编排成只读组合链。面板只保存组合配置版本,
      不执行组合、不提交逐跳 key、不含写入能力。
    </p>

    <div class="integration-read-source-composition-authoring__columns">
      <div class="integration-read-source-composition-authoring__form" data-testid="rscomp-author-form">
        <h3>新建组合版本</h3>

        <label class="integration-read-source-composition-authoring__field">
          <span>组合名称</span>
          <input v-model="draft.name" data-testid="rscomp-author-name" placeholder="material-to-bom" />
        </label>

        <label class="integration-read-source-composition-authoring__field">
          <span>step 1 resolver_lookup</span>
          <select v-model="draft.step1ConfigId" data-testid="rscomp-author-step1">
            <option value="">选择已审批 resolver 读取源…</option>
            <option v-for="row in resolverConfigs" :key="row.id" :value="row.id">
              {{ readConfigLabel(row) }}
            </option>
          </select>
        </label>

        <label class="integration-read-source-composition-authoring__field">
          <span>step 2 resolver_lookup</span>
          <select v-model="draft.step2ConfigId" data-testid="rscomp-author-step2">
            <option value="">选择已审批 resolver 读取源…</option>
            <option v-for="row in resolverConfigs" :key="row.id" :value="row.id">
              {{ readConfigLabel(row) }}
            </option>
          </select>
        </label>

        <label class="integration-read-source-composition-authoring__field">
          <span>sourceTarget(step 1 输出目标,必须匹配 step 2 wiring)</span>
          <input v-model="draft.sourceTarget" data-testid="rscomp-author-source-target" placeholder="itemId" />
        </label>

        <ul v-if="validationProblems.length > 0" class="integration-read-source-composition-authoring__problems" data-testid="rscomp-author-validation">
          <li v-for="problem in validationProblems" :key="problem">{{ problem }}</li>
        </ul>

        <div class="integration-read-source-composition-authoring__actions">
          <button type="button" class="integration-workbench__button" data-testid="rscomp-author-refresh" :disabled="loading" @click="refresh">
            {{ loading ? '加载中…' : '刷新配置与组合' }}
          </button>
          <button type="button" class="integration-workbench__button" data-testid="rscomp-author-save" :disabled="saving || validationProblems.length > 0" @click="saveVersion">
            {{ saving ? '保存中…' : '保存组合版本' }}
          </button>
        </div>

        <p v-if="actionError" class="integration-read-source-composition-authoring__error" data-testid="rscomp-author-error">{{ actionError }}</p>

        <ul v-if="fieldErrors.length > 0" class="integration-read-source-composition-authoring__field-errors" data-testid="rscomp-author-field-errors">
          <li v-for="entry in fieldErrors" :key="`${entry.code}:${entry.field}:${entry.reason}`">
            {{ entry.code }} · {{ entry.field }} · {{ entry.reason }}
          </li>
        </ul>

        <p v-if="saveResult" class="integration-read-source-composition-authoring__save-result" data-testid="rscomp-author-save-result">
          {{ saveResult.reused ? `已复用现有组合 v${saveResult.version}` : `已保存新组合 v${saveResult.version}` }}(status: {{ saveResult.status }})
        </p>
      </div>

      <div class="integration-read-source-composition-authoring__list" data-testid="rscomp-author-list">
        <div class="integration-read-source-composition-authoring__list-head">
          <h3>已保存组合</h3>
          <span>{{ compositions.length }} 项</span>
        </div>

        <p v-if="listError" class="integration-read-source-composition-authoring__error" data-testid="rscomp-author-list-error">{{ listError }}</p>
        <p v-if="!loading && compositions.length === 0" class="integration-read-source-composition-authoring__empty" data-testid="rscomp-author-empty">
          暂无组合配置。
        </p>

        <table v-if="compositions.length > 0" class="integration-read-source-composition-authoring__table">
          <thead>
            <tr>
              <th>名称</th><th>版本</th><th>状态</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="row in compositions" :key="row.id">
              <tr :data-testid="`rscomp-author-row-${row.id}`">
                <td>{{ row.name || row.id }}</td>
                <td>v{{ row.version }}</td>
                <td>
                  <span class="integration-read-source-composition-authoring__status" :data-status="row.status" :data-testid="`rscomp-author-status-${row.id}`">
                    {{ statusLabel(row.status) }}
                  </span>
                </td>
                <td class="integration-read-source-composition-authoring__row-actions">
                  <button
                    v-if="row.status === 'draft'"
                    type="button"
                    class="integration-workbench__button"
                    :data-testid="`rscomp-author-approve-${row.id}`"
                    @click="approve(row)"
                  >审批</button>
                  <button
                    v-if="row.status === 'approved'"
                    type="button"
                    class="integration-workbench__button"
                    :data-testid="`rscomp-author-retire-${row.id}`"
                    @click="retire(row)"
                  >停用</button>
                  <button
                    type="button"
                    class="integration-workbench__button"
                    :data-testid="`rscomp-author-audit-toggle-${row.id}`"
                    @click="toggleAudit(row)"
                  >{{ auditConfigId === row.id ? '收起审计' : '审计' }}</button>
                </td>
              </tr>
              <tr v-if="auditConfigId === row.id" :data-testid="`rscomp-author-audit-${row.id}`">
                <td colspan="4">
                  <ul class="integration-read-source-composition-authoring__audit" data-testid="rscomp-author-audit-list">
                    <li v-if="auditRows.length === 0">暂无审计记录。</li>
                    <li v-for="(entry, index) in auditRows" :key="index">
                      {{ auditActionLabel(entry.action) }} · {{ entry.actor || '(unknown)' }} · {{ entry.createdAt || '' }}<template v-if="auditDetailLabel(entry)"> · {{ auditDetailLabel(entry) }}</template>
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
// Read-source composition authoring panel (N2, #1709). Consultant/config tier only:
// choose two approved resolver_lookup read configs, save a read-only composition version, then approve/retire.
// It never runs the chain, never submits a runtime key, and renders only clamped error/audit metadata.
import { computed, reactive, ref, watch } from 'vue'
import {
  ReadSourceApiError,
  listReadSourceConfigs,
  type ReadSourceConfigRow,
} from '../../services/integration/readSourceConfigs'
import {
  ReadSourceCompositionApiError,
  approveReadSourceComposition,
  createReadSourceCompositionDraft,
  listReadSourceCompositionAudit,
  listReadSourceCompositions,
  retireReadSourceComposition,
  saveReadSourceCompositionVersion,
  validateReadSourceCompositionDraft,
  type CompositionStatus,
  type ReadSourceCompositionAuditRow,
  type ReadSourceCompositionFieldError,
  type ReadSourceCompositionRow,
  type ReadSourceCompositionSaveResult,
} from '../../services/integration/readSourceCompositions'
import type { IntegrationScope } from '../../services/integration/workbench'

const props = defineProps<{
  scope: IntegrationScope
}>()

const draft = reactive(createReadSourceCompositionDraft())
const readConfigs = ref<ReadSourceConfigRow[]>([])
const compositions = ref<ReadSourceCompositionRow[]>([])
const auditConfigId = ref('')
const auditRows = ref<ReadSourceCompositionAuditRow[]>([])
const fieldErrors = ref<ReadSourceCompositionFieldError[]>([])
const saveResult = ref<ReadSourceCompositionSaveResult | null>(null)
const loading = ref(false)
const saving = ref(false)
const actionError = ref('')
const listError = ref('')

const resolverConfigs = computed(() =>
  readConfigs.value.filter((row) => row.status === 'approved' && row.mode === 'resolver_lookup'))
const validationProblems = computed(() => validateReadSourceCompositionDraft(draft))

watch(draft, () => {
  saveResult.value = null
  fieldErrors.value = []
  actionError.value = ''
})

function readConfigLabel(row: ReadSourceConfigRow): string {
  return `${row.object || row.id} · ${row.systemId || '(system?)'} · v${row.version}`
}

function statusLabel(status: CompositionStatus): string {
  if (status === 'approved') return '已审批'
  if (status === 'retired') return '已停用'
  return '草稿'
}

function auditActionLabel(action: ReadSourceCompositionAuditRow['action']): string {
  if (action === 'save_version') return '保存版本'
  if (action === 'reuse_version') return '复用版本'
  return '状态变更'
}

function auditDetailLabel(entry: ReadSourceCompositionAuditRow): string {
  const { from, to } = entry.detail
  return from || to ? `${from || '?'}→${to || '?'}` : ''
}

function setError(error: unknown): void {
  fieldErrors.value = []
  if (error instanceof ReadSourceCompositionApiError) {
    actionError.value = error.message
    fieldErrors.value = error.fieldErrors
    return
  }
  if (error instanceof ReadSourceApiError) {
    actionError.value = error.message
    return
  }
  actionError.value = '组合配置请求失败'
}

async function refresh(): Promise<void> {
  loading.value = true
  listError.value = ''
  try {
    const [configs, rows] = await Promise.all([
      listReadSourceConfigs(props.scope, { status: 'approved' }),
      listReadSourceCompositions(props.scope),
    ])
    readConfigs.value = configs
    compositions.value = rows
  } catch (error) {
    listError.value = error instanceof ReadSourceApiError || error instanceof ReadSourceCompositionApiError
      ? error.message
      : '组合配置列表加载失败'
  } finally {
    loading.value = false
  }
}

async function saveVersion(): Promise<void> {
  actionError.value = ''
  fieldErrors.value = []
  saveResult.value = null
  saving.value = true
  try {
    saveResult.value = await saveReadSourceCompositionVersion(draft, props.scope)
    await refresh()
  } catch (error) {
    setError(error)
  } finally {
    saving.value = false
  }
}

async function approve(row: ReadSourceCompositionRow): Promise<void> {
  if (!window.confirm(`审批后运行时即可选用该组合(${row.name || row.id} v${row.version})。确认审批?`)) return
  actionError.value = ''
  try {
    await approveReadSourceComposition(row.id, props.scope)
    await refresh()
  } catch (error) {
    setError(error)
  }
}

async function retire(row: ReadSourceCompositionRow): Promise<void> {
  actionError.value = ''
  try {
    await retireReadSourceComposition(row.id, props.scope)
    await refresh()
  } catch (error) {
    setError(error)
  }
}

async function toggleAudit(row: ReadSourceCompositionRow): Promise<void> {
  if (auditConfigId.value === row.id) {
    auditConfigId.value = ''
    auditRows.value = []
    return
  }
  actionError.value = ''
  try {
    auditRows.value = await listReadSourceCompositionAudit(row.id, props.scope)
    auditConfigId.value = row.id
  } catch (error) {
    setError(error)
  }
}

void refresh()
</script>

<style scoped>
.integration-read-source-composition-authoring__hint {
  color: #666;
  font-size: 13px;
  margin: 0 0 12px;
}
.integration-read-source-composition-authoring__columns {
  display: grid;
  grid-template-columns: minmax(320px, 1fr) minmax(360px, 1.2fr);
  gap: 20px;
}
.integration-read-source-composition-authoring__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
  font-size: 13px;
}
.integration-read-source-composition-authoring__field input,
.integration-read-source-composition-authoring__field select {
  padding: 6px 8px;
  border: 1px solid #d0d0d0;
  border-radius: 4px;
}
.integration-read-source-composition-authoring__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 10px 0;
}
.integration-read-source-composition-authoring__problems,
.integration-read-source-composition-authoring__field-errors {
  color: #b45309;
  font-size: 12px;
  padding-left: 18px;
}
.integration-read-source-composition-authoring__error {
  color: #b91c1c;
  font-size: 13px;
}
.integration-read-source-composition-authoring__save-result {
  color: #15803d;
  font-size: 13px;
}
.integration-read-source-composition-authoring__list-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.integration-read-source-composition-authoring__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.integration-read-source-composition-authoring__table th,
.integration-read-source-composition-authoring__table td {
  border-bottom: 1px solid #eee;
  padding: 6px 8px;
  text-align: left;
}
.integration-read-source-composition-authoring__status[data-status='approved'] {
  color: #15803d;
}
.integration-read-source-composition-authoring__status[data-status='draft'] {
  color: #b45309;
}
.integration-read-source-composition-authoring__status[data-status='retired'] {
  color: #6b7280;
}
.integration-read-source-composition-authoring__row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.integration-read-source-composition-authoring__empty {
  color: #888;
  font-size: 13px;
}
.integration-read-source-composition-authoring__audit {
  margin: 4px 0;
  padding-left: 18px;
  font-size: 12px;
  color: #555;
}
@media (max-width: 960px) {
  .integration-read-source-composition-authoring__columns {
    grid-template-columns: 1fr;
  }
}
</style>
