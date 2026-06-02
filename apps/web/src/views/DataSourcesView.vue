<template>
  <section class="data-sources">
    <header class="data-sources__header">
      <div>
        <h1>外接数据源 <span class="data-sources__sub">Data Sources</span></h1>
        <p class="data-sources__lead">
          连接外部 PostgreSQL / SQL Server / HTTP 数据源(只读优先,凭据加密落库)。
        </p>
      </div>
      <button
        type="button"
        class="data-sources__btn data-sources__btn--primary"
        data-testid="ds-new-button"
        @click="toggleCreateForm"
      >
        {{ formOpen && formMode === 'create' ? '取消' : '新建数据源' }}
      </button>
    </header>

    <p v-if="store.error" class="data-sources__error" data-testid="ds-error" role="alert">
      {{ store.error }}
    </p>

    <form v-if="formOpen" class="data-sources__form" data-testid="ds-create-form" @submit.prevent="submit">
      <div class="data-sources__grid">
        <label>ID
          <input v-model.trim="form.id" required data-testid="ds-field-id" :disabled="formMode !== 'create'" placeholder="my-erp-db" />
        </label>
        <label>名称 Name
          <input v-model.trim="form.name" required data-testid="ds-field-name" :disabled="formMode === 'credentials'" placeholder="客户 ERP 库" />
        </label>
        <label>类型 Type
          <select v-model="form.type" data-testid="ds-field-type" :disabled="formMode !== 'create'">
            <option v-for="t in DATA_SOURCE_TYPES" :key="t" :value="t">{{ DATA_SOURCE_TYPE_LABELS[t] }}</option>
          </select>
        </label>
      </div>

      <!-- SQL connection -->
      <div v-if="isSql && formMode !== 'credentials'" class="data-sources__grid">
        <label>Host
          <input v-model.trim="form.host" data-testid="ds-field-host" placeholder="10.0.0.5" />
        </label>
        <label v-if="form.type === 'sqlserver'">Server
          <input v-model.trim="form.server" data-testid="ds-field-server" placeholder="命名实例(Host 备选)" />
        </label>
        <label>Port
          <input v-model.number="form.port" type="number" data-testid="ds-field-port" :placeholder="defaultPort" />
        </label>
        <label>Database
          <input v-model.trim="form.database" required data-testid="ds-field-database" placeholder="erp" />
        </label>
        <label v-if="formMode === 'create'">Username
          <input v-model.trim="form.username" autocomplete="off" data-testid="ds-field-username" />
        </label>
        <label v-if="formMode === 'create'">Password
          <input v-model="form.password" type="password" autocomplete="new-password" data-testid="ds-field-password" />
        </label>
      </div>

      <!-- HTTP connection -->
      <div v-else-if="formMode !== 'credentials'" class="data-sources__grid">
        <label>Base URL
          <input v-model.trim="form.baseURL" required data-testid="ds-field-baseurl" placeholder="https://api.example.com" />
        </label>
        <label v-if="formMode === 'create'">API Key
          <input v-model="form.apiKey" type="password" autocomplete="off" data-testid="ds-field-apikey" />
        </label>
      </div>

      <p v-if="formMode === 'edit'" class="data-sources__muted" data-testid="ds-edit-secret-note">
        凭据保持不变;如需轮换凭据,请走单独的凭据更新流程。
      </p>

      <div v-if="formMode === 'credentials'" class="data-sources__grid" data-testid="ds-credential-fields">
        <template v-if="isSql">
          <label>Username
            <input v-model.trim="form.username" autocomplete="off" data-testid="ds-field-username" placeholder="留空则保持不变" />
          </label>
          <label>Password
            <input v-model="form.password" type="password" autocomplete="new-password" data-testid="ds-field-password" placeholder="留空则保持不变" />
          </label>
        </template>
        <label v-else>API Key
          <input v-model="form.apiKey" type="password" autocomplete="off" data-testid="ds-field-apikey" placeholder="留空则保持不变" />
        </label>
      </div>

      <p v-if="formMode === 'credentials'" class="data-sources__muted" data-testid="ds-credential-note">
        仅更新填写的凭据字段;留空字段保持不变,不会作为空字符串提交。
      </p>

      <label v-if="formMode !== 'credentials'" class="data-sources__checkbox">
        <input v-model="form.readOnly" type="checkbox" data-testid="ds-field-readonly" />
        只读(推荐;关闭后允许写 SQL)
      </label>

      <div class="data-sources__form-actions">
        <button type="submit" class="data-sources__btn data-sources__btn--primary" :disabled="submitDisabled" data-testid="ds-submit">
          {{ submitLabel }}
        </button>
      </div>
    </form>

    <div class="data-sources__list" data-testid="ds-list">
      <p v-if="store.loading" class="data-sources__muted" data-testid="ds-loading">加载中…</p>
      <p v-else-if="store.items.length === 0" class="data-sources__muted" data-testid="ds-empty">
        还没有数据源。点击「新建数据源」连接一个。
      </p>
      <table v-else class="data-sources__table">
        <thead>
          <tr><th>名称</th><th>类型</th><th>状态</th><th>连接测试</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="ds in store.items" :key="ds.id" data-testid="ds-row" :data-ds-id="ds.id">
            <td>{{ ds.name }}<br /><small class="data-sources__muted">{{ ds.id }}</small></td>
            <td>{{ typeLabel(ds.type) }}</td>
            <td>
              <span class="data-sources__status" :class="ds.connected ? 'is-on' : 'is-off'">
                {{ ds.connected ? '已连接' : '未连接' }}
              </span>
            </td>
            <td>
              <button
                type="button"
                class="data-sources__btn"
                data-testid="ds-test"
                :disabled="store.isTesting(ds.id)"
                @click="testConnection(ds.id)"
              >
                {{ store.isTesting(ds.id) ? '测试中…' : '测试连接' }}
              </button>
              <p
                v-if="store.testResults[ds.id]"
                class="data-sources__test-result"
                :class="store.testResults[ds.id].success ? 'is-ok' : 'is-fail'"
                data-testid="ds-test-result"
              >
                {{ testResultText(ds.id) }}
              </p>
            </td>
            <td>
              <div class="data-sources__actions">
                <button
                  v-if="isSqlSource(ds.type)"
                  type="button"
                  class="data-sources__btn"
                  data-testid="ds-schema"
                  :disabled="store.isSchemaLoading(ds.id)"
                  @click="openSchemaBrowser(ds.id)"
                >结构</button>
                <button
                  v-if="isSqlSource(ds.type)"
                  type="button"
                  class="data-sources__btn"
                  data-testid="ds-preview"
                  :disabled="store.isSchemaLoading(ds.id) || store.isPreviewLoading(ds.id)"
                  @click="openPreview(ds.id)"
                >{{ activePreviewId === ds.id ? '刷新预览' : '预览' }}</button>
                <button
                  type="button"
                  class="data-sources__btn"
                  data-testid="ds-edit"
                  :disabled="detailLoading"
                  @click="openEditForm(ds.id)"
                >编辑</button>
                <button
                  type="button"
                  class="data-sources__btn"
                  data-testid="ds-credentials"
                  :disabled="detailLoading"
                  @click="openCredentialForm(ds.id)"
                >凭据</button>
                <button
                  type="button"
                  class="data-sources__btn data-sources__btn--danger"
                  data-testid="ds-delete"
                  @click="confirmRemove(ds.id, ds.name)"
                >删除</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <section v-if="activeSchemaId" class="data-sources__preview" data-testid="ds-schema-panel">
        <header class="data-sources__preview-header">
          <div>
            <h2>库表结构</h2>
            <p class="data-sources__muted">只读浏览 schema / table / columns,不读取业务数据。</p>
          </div>
          <button type="button" class="data-sources__btn" @click="closeSchemaBrowser">关闭</button>
        </header>

        <div class="data-sources__preview-controls">
          <label>表 / 视图
            <select
              v-model="schemaTable"
              data-testid="ds-schema-table"
              :disabled="schemaTableChoices.length === 0 || activeSchemaBusy"
              @change="loadActiveTableInfo"
            >
              <option value="" disabled>选择表</option>
              <option v-for="choice in schemaTableChoices" :key="choice.value" :value="choice.value">
                {{ choice.label }}
              </option>
            </select>
          </label>
          <button
            type="button"
            class="data-sources__btn data-sources__btn--primary"
            data-testid="ds-schema-refresh"
            :disabled="!schemaTable || activeSchemaBusy"
            @click="loadActiveTableInfo"
          >
            {{ activeSchemaBusy ? '读取中…' : '读取字段' }}
          </button>
        </div>

        <p
          v-if="activeSchemaId && store.schemaErrors[activeSchemaId]"
          class="data-sources__error"
          data-testid="ds-schema-error"
          role="alert"
        >
          {{ store.schemaErrors[activeSchemaId] }}
        </p>
        <p v-else-if="activeSchemaBusy" class="data-sources__muted" data-testid="ds-schema-loading">读取中…</p>
        <p v-else-if="schemaTableChoices.length === 0" class="data-sources__muted" data-testid="ds-schema-empty">
          当前数据源未返回表或视图。
        </p>

        <div v-if="activeTableDetail" class="data-sources__preview-result" data-testid="ds-schema-detail">
          <p class="data-sources__muted">
            {{ tableDisplayName(activeTableDetail) }} · {{ activeTableDetail.columns?.length ?? 0 }} 个字段
          </p>
          <div v-if="(activeTableDetail.columns?.length ?? 0) > 0" class="data-sources__preview-scroll">
            <table class="data-sources__table data-sources__preview-table">
              <thead>
                <tr><th>字段</th><th>类型</th><th>约束</th><th>默认值</th></tr>
              </thead>
              <tbody>
                <tr v-for="column in activeTableDetail.columns" :key="column.name">
                  <td data-testid="ds-schema-column">{{ column.name }}</td>
                  <td>{{ column.type || '-' }}</td>
                  <td>{{ columnConstraintText(column) }}</td>
                  <td>{{ formatCell(column.defaultValue) || '-' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="data-sources__muted" data-testid="ds-schema-empty-columns">该表未返回字段信息。</p>
        </div>
      </section>

      <section v-if="activePreviewId" class="data-sources__preview" data-testid="ds-preview-panel">
        <header class="data-sources__preview-header">
          <div>
            <h2>只读数据预览</h2>
            <p class="data-sources__muted">只读预览 · 最多 {{ PREVIEW_ROW_LIMIT }} 行。</p>
          </div>
          <button type="button" class="data-sources__btn" @click="closePreview">关闭</button>
        </header>

        <div class="data-sources__preview-controls">
          <label>表 / 视图
            <select
              v-model="previewTable"
              data-testid="ds-preview-table"
              :disabled="previewTableChoices.length === 0 || activePreviewBusy"
              @change="runActivePreview"
            >
              <option value="" disabled>选择表</option>
              <option v-for="choice in previewTableChoices" :key="choice.value" :value="choice.value">
                {{ choice.label }}
              </option>
            </select>
          </label>
          <button
            type="button"
            class="data-sources__btn data-sources__btn--primary"
            data-testid="ds-preview-refresh"
            :disabled="!previewTable || activePreviewBusy"
            @click="runActivePreview"
          >
            {{ activePreviewBusy ? '读取中…' : '读取预览' }}
          </button>
        </div>

        <p
          v-if="activePreviewId && store.previewErrors[activePreviewId]"
          class="data-sources__error"
          data-testid="ds-preview-error"
          role="alert"
        >
          {{ store.previewErrors[activePreviewId] }}
        </p>
        <p v-else-if="activePreviewBusy" class="data-sources__muted" data-testid="ds-preview-loading">读取中…</p>
        <p v-else-if="previewTableChoices.length === 0" class="data-sources__muted" data-testid="ds-preview-empty-schema">
          当前数据源没有可预览的表或视图。
        </p>

        <div v-if="activePreviewResult" class="data-sources__preview-result" data-testid="ds-preview-result">
          <p class="data-sources__muted">
            {{ previewRows.length }} 行 · {{ previewColumns.length }} 列 · limit={{ PREVIEW_ROW_LIMIT }}
          </p>
          <div v-if="previewRows.length > 0 && previewColumns.length > 0" class="data-sources__preview-scroll">
            <table class="data-sources__table data-sources__preview-table">
              <thead>
                <tr>
                  <th v-for="column in previewColumns" :key="column">{{ column }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, rowIndex) in previewRows" :key="rowIndex">
                  <td v-for="column in previewColumns" :key="column" data-testid="ds-preview-cell">
                    {{ formatCell(row[column]) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="data-sources__muted" data-testid="ds-preview-empty-result">该表暂无返回行。</p>
        </div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useDataSourcesStore } from '../stores/dataSources'
import {
  DATA_SOURCE_TYPES,
  DATA_SOURCE_TYPE_LABELS,
  type DataSourceColumnInfo,
  type DataSourceDetail,
  type DataSourceTableInfo,
  type DataSourceType,
} from '../data-sources/types'
import { buildCreatePayload, buildCredentialRotationPayload, buildUpdatePayload } from '../data-sources/buildPayload'

const PREVIEW_ROW_LIMIT = 100
const store = useDataSourcesStore()
const formOpen = ref(false)
const formMode = ref<'create' | 'edit' | 'credentials'>('create')
const editingId = ref<string | null>(null)
const submitting = ref(false)
const detailLoading = ref(false)
const activeSchemaId = ref<string | null>(null)
const schemaTable = ref('')
const activePreviewId = ref<string | null>(null)
const previewTable = ref('')

interface TableChoice {
  value: string
  label: string
  name: string
  schema?: string
  kind: 'table' | 'view'
}

const form = reactive({
  id: '',
  name: '',
  type: 'postgres' as DataSourceType,
  host: '',
  server: '',
  port: undefined as number | undefined,
  database: '',
  username: '',
  password: '',
  baseURL: '',
  apiKey: '',
  readOnly: true,
})

const isSql = computed(() => form.type !== 'http')
const defaultPort = computed(() => (form.type === 'sqlserver' ? '1433' : '5432'))
const credentialFieldsFilled = computed(() => (
  form.type === 'http'
    ? form.apiKey.length > 0
    : form.username.length > 0 || form.password.length > 0
))
const submitDisabled = computed(() => (
  submitting.value || (formMode.value === 'credentials' && !credentialFieldsFilled.value)
))
const submitLabel = computed(() => {
  if (submitting.value) return '保存中…'
  if (formMode.value === 'credentials') return '更新凭据'
  return formMode.value === 'edit' ? '保存' : '创建'
})

// `server` is a SQL-Server-only concept; clear it when switching away so a stale value can't linger
// (the builder + guard already ignore it for non-sqlserver — this keeps the form state clean).
watch(() => form.type, (type) => {
  if (type !== 'sqlserver') form.server = ''
})

function typeLabel(type: string): string {
  return DATA_SOURCE_TYPE_LABELS[type as DataSourceType] ?? type
}

function isSqlSource(type: string): boolean {
  // Keep this in step with backend SUPPORTED_DATA_SOURCE_TYPES. It is intentionally fail-safe:
  // an unknown future SQL type simply hides table preview until the UI mapping is reviewed.
  return type === 'postgres' || type === 'postgresql' || type === 'sqlserver'
}

function tableValue(table: DataSourceTableInfo): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name
}

function tableLabel(table: DataSourceTableInfo, kind: 'table' | 'view'): string {
  const qualified = tableValue(table)
  return `${qualified} · ${kind === 'view' ? '视图' : '表'}`
}

function tableChoice(table: DataSourceTableInfo, kind: 'table' | 'view'): TableChoice {
  return {
    value: tableValue(table),
    label: tableLabel(table, kind),
    name: table.name,
    schema: table.schema,
    kind,
  }
}

function tableChoicesFor(schema: { tables?: DataSourceTableInfo[]; views?: DataSourceTableInfo[] } | null): TableChoice[] {
  const tables = (schema?.tables ?? []).map((table) => tableChoice(table, 'table'))
  const views = (schema?.views ?? []).map((view) => tableChoice(view, 'view'))
  return [...tables, ...views]
}

const activePreviewSchema = computed(() => (
  activePreviewId.value ? store.schemas[activePreviewId.value] : null
))

const activeSchemaInfo = computed(() => (
  activeSchemaId.value ? store.schemas[activeSchemaId.value] : null
))

const previewTableChoices = computed(() => tableChoicesFor(activePreviewSchema.value))

const schemaTableChoices = computed(() => tableChoicesFor(activeSchemaInfo.value))

const selectedSchemaChoice = computed(() => (
  schemaTableChoices.value.find((choice) => choice.value === schemaTable.value) ?? null
))

const activeTableDetail = computed(() => {
  const id = activeSchemaId.value
  const choice = selectedSchemaChoice.value
  if (!id || !choice) return null
  return store.tableDetails[store.tableDetailKey(id, choice.name, choice.schema)] ?? null
})

const activePreviewResult = computed(() => (
  activePreviewId.value ? store.previewResults[activePreviewId.value] : null
))

const activeSchemaBusy = computed(() => {
  const id = activeSchemaId.value
  const choice = selectedSchemaChoice.value
  if (!id) return false
  const tableBusy = choice ? store.isTableInfoLoading(store.tableDetailKey(id, choice.name, choice.schema)) : false
  return store.isSchemaLoading(id) || tableBusy
})

const activePreviewBusy = computed(() => {
  const id = activePreviewId.value
  return !!id && (store.isSchemaLoading(id) || store.isPreviewLoading(id))
})

const previewRows = computed(() => activePreviewResult.value?.data ?? [])

const previewColumns = computed(() => {
  const metadataColumns = activePreviewResult.value?.metadata?.columns
    ?.map((column) => column.name)
    .filter(Boolean) ?? []
  if (metadataColumns.length > 0) return metadataColumns

  const names = new Set<string>()
  for (const row of previewRows.value) {
    Object.keys(row).forEach((key) => names.add(key))
  }
  return Array.from(names)
})

function testResultText(id: string): string {
  const result = store.testResults[id]
  if (!result) return ''
  if (result.success) {
    return `通过${result.latency ? ` · ${result.latency}` : ''}`
  }
  return `失败${result.error?.message ? ` · ${result.error.message}` : ''}`
}

function tableDisplayName(table: DataSourceTableInfo): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name
}

function columnConstraintText(column: DataSourceColumnInfo): string {
  const parts = []
  if (column.primaryKey) parts.push('PK')
  parts.push(column.nullable === false ? 'NOT NULL' : 'NULL')
  return parts.join(' · ')
}

function toggleCreateForm(): void {
  if (formOpen.value && formMode.value === 'create') {
    formOpen.value = false
    return
  }
  resetForm()
  formMode.value = 'create'
  editingId.value = null
  formOpen.value = true
  store.error = null
}

function resetForm(): void {
  Object.assign(form, {
    id: '', name: '', type: 'postgres', host: '', server: '', port: undefined, database: '',
    username: '', password: '', baseURL: '', apiKey: '', readOnly: true,
  })
}

function fillFormFromDetail(detail: DataSourceDetail): void {
  resetForm()
  const connection = detail.connection ?? {}
  form.id = detail.id
  form.name = detail.name
  form.type = DATA_SOURCE_TYPES.includes(detail.type as DataSourceType)
    ? detail.type as DataSourceType
    : 'postgres'
  form.host = String(connection.host ?? '')
  form.server = String(connection.server ?? '')
  form.port = typeof connection.port === 'number' ? connection.port : undefined
  form.database = String(connection.database ?? '')
  form.baseURL = String(connection.baseURL ?? '')
  form.readOnly = detail.options?.readOnly !== false
}

async function openEditForm(id: string): Promise<void> {
  detailLoading.value = true
  try {
    const detail = await store.loadDetail(id)
    if (!detail) return
    fillFormFromDetail(detail)
    formMode.value = 'edit'
    editingId.value = id
    formOpen.value = true
  } finally {
    detailLoading.value = false
  }
}

async function openCredentialForm(id: string): Promise<void> {
  detailLoading.value = true
  try {
    const detail = await store.loadDetail(id)
    if (!detail) return
    fillFormFromDetail(detail)
    formMode.value = 'credentials'
    editingId.value = id
    formOpen.value = true
  } finally {
    detailLoading.value = false
  }
}

async function submit(): Promise<void> {
  // P2: `server` (SQL Server named instance) is a host alternative ONLY for sqlserver — Postgres
  // ignores it, so Postgres still requires host (UI-1's rule), while SQL Server accepts host OR
  // server (so a server-only source is editable/savable rather than blocked by an empty Host).
  if (isSql.value) {
    const hasHost = !!form.host.trim()
    const hasServer = form.type === 'sqlserver' && !!form.server.trim()
    if (!hasHost && !hasServer) {
      store.error = form.type === 'sqlserver' ? 'SQL Server 源需填写 Host 或 Server 之一' : '请填写 Host'
      return
    }
  }
  submitting.value = true
  try {
    const ok = editingId.value && formMode.value === 'edit'
      ? await store.update(editingId.value, buildUpdatePayload(form))
      : editingId.value && formMode.value === 'credentials'
        ? await store.rotateCredentials(editingId.value, buildCredentialRotationPayload(form))
        : await store.create(buildCreatePayload(form))
    if (ok) {
      resetForm()
      formMode.value = 'create'
      editingId.value = null
      formOpen.value = false
    }
  } finally {
    submitting.value = false
  }
}

async function testConnection(id: string): Promise<void> {
  await store.testConnection(id)
}

async function openSchemaBrowser(id: string): Promise<void> {
  const requestedId = id
  activeSchemaId.value = id
  // Clear the prior panel's selection up front so it cannot linger while the new schema loads.
  schemaTable.value = ''
  const schema = store.schemas[id] ?? await store.loadSchema(id)
  // A newer panel may have opened while loadSchema was in flight (fast A→B switch). Drop this
  // stale response so it cannot clobber schemaTable or load the wrong source's table info.
  if (activeSchemaId.value !== requestedId) return
  const firstChoice = tableChoicesFor(schema)[0]
  schemaTable.value = firstChoice?.value ?? ''
  if (firstChoice) {
    await store.loadTableInfo(id, firstChoice.name, firstChoice.schema)
  }
}

async function loadActiveTableInfo(): Promise<void> {
  const id = activeSchemaId.value
  const choice = selectedSchemaChoice.value
  if (!id || !choice) return
  await store.loadTableInfo(id, choice.name, choice.schema)
}

function closeSchemaBrowser(): void {
  activeSchemaId.value = null
  schemaTable.value = ''
}

async function openPreview(id: string): Promise<void> {
  const requestedId = id
  activePreviewId.value = id
  // Clear the prior panel's selection up front so it cannot linger while the new schema loads.
  previewTable.value = ''
  store.clearPreviewError(id)
  const schema = store.schemas[id] ?? await store.loadSchema(id)
  // A newer preview may have opened while loadSchema was in flight (fast A→B switch). Drop this
  // stale response so it cannot set previewTable to the wrong source's table and then run a
  // cross-source query — runActivePreview() reads the *current* activePreviewId.
  if (activePreviewId.value !== requestedId) return
  const firstChoice = [
    ...(schema?.tables ?? []),
    ...(schema?.views ?? []),
  ][0]
  previewTable.value = firstChoice ? tableValue(firstChoice) : ''
  if (previewTable.value) {
    await runActivePreview()
  }
}

async function runActivePreview(): Promise<void> {
  const id = activePreviewId.value
  if (!id || !previewTable.value) return
  await store.previewRows(id, {
    table: previewTable.value,
    limit: PREVIEW_ROW_LIMIT,
  })
}

function closePreview(): void {
  activePreviewId.value = null
  previewTable.value = ''
}

function formatCell(value: unknown): string {
  if (value === null) return 'NULL'
  if (value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

async function confirmRemove(id: string, name: string): Promise<void> {
  if (typeof window !== 'undefined' && !window.confirm(`删除数据源「${name}」?此操作不可撤销。`)) return
  await store.remove(id)
}

onMounted(() => {
  void store.fetchAll()
})
</script>

<style scoped>
.data-sources { padding: 24px; max-width: 1180px; margin: 0 auto; }
.data-sources__header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.data-sources__header h1 { font-size: 22px; margin: 0 0 4px; }
.data-sources__sub { font-size: 13px; color: #8a8f99; font-weight: 400; }
.data-sources__lead { color: #6b7280; margin: 0; font-size: 13px; }
.data-sources__error { background: #fff1f0; border: 1px solid #ffccc7; color: #cf1322; padding: 8px 12px; border-radius: 6px; }
.data-sources__form { margin: 16px 0; padding: 16px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fafafa; }
.data-sources__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 12px; }
.data-sources__grid label, .data-sources__checkbox { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: #374151; }
.data-sources__grid input, .data-sources__grid select { padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 13px; }
.data-sources__checkbox { flex-direction: row; align-items: center; gap: 8px; }
.data-sources__form-actions { margin-top: 8px; }
.data-sources__btn { padding: 6px 14px; border-radius: 6px; border: 1px solid #d1d5db; background: #fff; cursor: pointer; font-size: 13px; }
.data-sources__btn:disabled { opacity: 0.6; cursor: default; }
.data-sources__btn--primary { background: #2563eb; border-color: #2563eb; color: #fff; }
.data-sources__btn--danger { color: #cf1322; border-color: #ffccc7; }
.data-sources__list { margin-top: 8px; }
.data-sources__muted { color: #9ca3af; font-size: 13px; }
.data-sources__table { width: 100%; border-collapse: collapse; font-size: 13px; }
.data-sources__table th, .data-sources__table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
.data-sources__status { font-size: 12px; padding: 2px 8px; border-radius: 10px; white-space: nowrap; }
.data-sources__status.is-on { background: #f6ffed; color: #389e0d; }
.data-sources__status.is-off { background: #f5f5f5; color: #8c8c8c; }
.data-sources__actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.data-sources__test-result { margin: 6px 0 0; font-size: 12px; max-width: 260px; overflow-wrap: anywhere; }
.data-sources__test-result.is-ok { color: #237804; }
.data-sources__test-result.is-fail { color: #cf1322; }
.data-sources__preview { margin-top: 16px; padding: 16px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; }
.data-sources__preview-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
.data-sources__preview-header h2 { font-size: 16px; margin: 0 0 4px; }
.data-sources__preview-controls { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.data-sources__preview-controls label { display: flex; flex-direction: column; gap: 4px; min-width: 260px; font-size: 13px; color: #374151; }
.data-sources__preview-controls select { padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 13px; }
.data-sources__preview-result { margin-top: 10px; }
.data-sources__preview-scroll { max-width: 100%; overflow: auto; border: 1px solid #f0f0f0; border-radius: 6px; }
.data-sources__preview-table th, .data-sources__preview-table td { white-space: nowrap; max-width: 280px; overflow: hidden; text-overflow: ellipsis; }
</style>
