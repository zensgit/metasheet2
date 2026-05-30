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
          <input v-model.trim="form.host" required data-testid="ds-field-host" placeholder="10.0.0.5" />
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
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useDataSourcesStore } from '../stores/dataSources'
import {
  DATA_SOURCE_TYPES,
  DATA_SOURCE_TYPE_LABELS,
  type DataSourceDetail,
  type DataSourceType,
} from '../data-sources/types'
import { buildCreatePayload, buildCredentialRotationPayload, buildUpdatePayload } from '../data-sources/buildPayload'

const store = useDataSourcesStore()
const formOpen = ref(false)
const formMode = ref<'create' | 'edit' | 'credentials'>('create')
const editingId = ref<string | null>(null)
const submitting = ref(false)
const detailLoading = ref(false)

const form = reactive({
  id: '',
  name: '',
  type: 'postgres' as DataSourceType,
  host: '',
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

function typeLabel(type: string): string {
  return DATA_SOURCE_TYPE_LABELS[type as DataSourceType] ?? type
}

function testResultText(id: string): string {
  const result = store.testResults[id]
  if (!result) return ''
  if (result.success) {
    return `通过${result.latency ? ` · ${result.latency}` : ''}`
  }
  return `失败${result.error?.message ? ` · ${result.error.message}` : ''}`
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
    id: '', name: '', type: 'postgres', host: '', port: undefined, database: '',
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

async function confirmRemove(id: string, name: string): Promise<void> {
  if (typeof window !== 'undefined' && !window.confirm(`删除数据源「${name}」?此操作不可撤销。`)) return
  await store.remove(id)
}

onMounted(() => {
  void store.fetchAll()
})
</script>

<style scoped>
.data-sources { padding: 24px; max-width: 960px; margin: 0 auto; }
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
.data-sources__actions { display: flex; justify-content: flex-end; gap: 8px; }
.data-sources__test-result { margin: 6px 0 0; font-size: 12px; max-width: 260px; overflow-wrap: anywhere; }
.data-sources__test-result.is-ok { color: #237804; }
.data-sources__test-result.is-fail { color: #cf1322; }
</style>
