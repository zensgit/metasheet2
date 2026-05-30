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
        @click="toggleForm"
      >
        {{ formOpen ? '取消' : '新建数据源' }}
      </button>
    </header>

    <p v-if="store.error" class="data-sources__error" data-testid="ds-error" role="alert">
      {{ store.error }}
    </p>

    <form v-if="formOpen" class="data-sources__form" data-testid="ds-create-form" @submit.prevent="submit">
      <div class="data-sources__grid">
        <label>ID
          <input v-model.trim="form.id" required data-testid="ds-field-id" placeholder="my-erp-db" />
        </label>
        <label>名称 Name
          <input v-model.trim="form.name" required data-testid="ds-field-name" placeholder="客户 ERP 库" />
        </label>
        <label>类型 Type
          <select v-model="form.type" data-testid="ds-field-type">
            <option v-for="t in DATA_SOURCE_TYPES" :key="t" :value="t">{{ DATA_SOURCE_TYPE_LABELS[t] }}</option>
          </select>
        </label>
      </div>

      <!-- SQL connection -->
      <div v-if="isSql" class="data-sources__grid">
        <label>Host
          <input v-model.trim="form.host" data-testid="ds-field-host" placeholder="10.0.0.5" />
        </label>
        <label>Port
          <input v-model.number="form.port" type="number" data-testid="ds-field-port" :placeholder="defaultPort" />
        </label>
        <label>Database
          <input v-model.trim="form.database" data-testid="ds-field-database" placeholder="erp" />
        </label>
        <label>Username
          <input v-model.trim="form.username" autocomplete="off" data-testid="ds-field-username" />
        </label>
        <label>Password
          <input v-model="form.password" type="password" autocomplete="new-password" data-testid="ds-field-password" />
        </label>
      </div>

      <!-- HTTP connection -->
      <div v-else class="data-sources__grid">
        <label>Base URL
          <input v-model.trim="form.baseURL" data-testid="ds-field-baseurl" placeholder="https://api.example.com" />
        </label>
        <label>API Key
          <input v-model="form.apiKey" type="password" autocomplete="off" data-testid="ds-field-apikey" />
        </label>
      </div>

      <label class="data-sources__checkbox">
        <input v-model="form.readOnly" type="checkbox" data-testid="ds-field-readonly" />
        只读(推荐;关闭后允许写 SQL)
      </label>

      <div class="data-sources__form-actions">
        <button type="submit" class="data-sources__btn data-sources__btn--primary" :disabled="submitting" data-testid="ds-submit">
          {{ submitting ? '创建中…' : '创建' }}
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
          <tr><th>名称</th><th>类型</th><th>状态</th><th></th></tr>
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
                class="data-sources__btn data-sources__btn--danger"
                data-testid="ds-delete"
                @click="confirmRemove(ds.id, ds.name)"
              >删除</button>
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
  type DataSourceType,
} from '../data-sources/types'
import { buildCreatePayload } from '../data-sources/buildPayload'

const store = useDataSourcesStore()
const formOpen = ref(false)
const submitting = ref(false)

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

function typeLabel(type: string): string {
  return DATA_SOURCE_TYPE_LABELS[type as DataSourceType] ?? type
}

function toggleForm(): void {
  formOpen.value = !formOpen.value
  store.error = null
}

function resetForm(): void {
  Object.assign(form, {
    id: '', name: '', type: 'postgres', host: '', port: undefined, database: '',
    username: '', password: '', baseURL: '', apiKey: '', readOnly: true,
  })
}

async function submit(): Promise<void> {
  submitting.value = true
  try {
    const ok = await store.create(buildCreatePayload(form))
    if (ok) {
      resetForm()
      formOpen.value = false
    }
  } finally {
    submitting.value = false
  }
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
.data-sources__btn--primary { background: #2563eb; border-color: #2563eb; color: #fff; }
.data-sources__btn--primary:disabled { opacity: 0.6; cursor: default; }
.data-sources__btn--danger { color: #cf1322; border-color: #ffccc7; }
.data-sources__list { margin-top: 8px; }
.data-sources__muted { color: #9ca3af; font-size: 13px; }
.data-sources__table { width: 100%; border-collapse: collapse; font-size: 13px; }
.data-sources__table th, .data-sources__table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
.data-sources__status { font-size: 12px; padding: 2px 8px; border-radius: 10px; }
.data-sources__status.is-on { background: #f6ffed; color: #389e0d; }
.data-sources__status.is-off { background: #f5f5f5; color: #8c8c8c; }
</style>
