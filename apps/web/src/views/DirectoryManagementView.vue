<template>
  <section class="directory-admin">
    <header class="directory-admin__header">
      <div>
        <h1>目录同步</h1>
        <p>管理钉钉组织目录集成，执行连通性测试，并手动触发同步。</p>
      </div>

      <div class="directory-admin__actions">
        <router-link class="directory-admin__link" to="/admin/users">用户管理</router-link>
        <router-link class="directory-admin__link" to="/admin/roles">角色管理</router-link>
        <router-link class="directory-admin__link" to="/admin/audit">管理审计</router-link>
        <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="loading" @click="void loadIntegrations()">
          {{ loading ? '刷新中...' : '刷新列表' }}
        </button>
        <button class="directory-admin__button" type="button" @click="resetDraft()">新建集成</button>
      </div>
    </header>

    <p v-if="status" class="directory-admin__status" :class="{ 'directory-admin__status--error': statusTone === 'error' }">
      {{ status }}
    </p>

    <div class="directory-admin__layout">
      <aside class="directory-admin__panel directory-admin__panel--list">
        <div class="directory-admin__section-head">
          <div>
            <h2>集成列表</h2>
            <p class="directory-admin__hint">当前仅支持钉钉目录拉取与手动同步。</p>
          </div>
        </div>

        <div v-if="integrations.length === 0" class="directory-admin__empty">暂无目录集成</div>
        <button
          v-for="integration in integrations"
          :key="integration.id"
          class="directory-admin__item"
          :class="{ 'directory-admin__item--active': selectedIntegrationId === integration.id }"
          type="button"
          @click="selectIntegration(integration.id)"
        >
          <strong>{{ integration.name }}</strong>
          <span>{{ integration.corpId }}</span>
          <small>
            账号 {{ integration.stats.accountCount }} / 部门 {{ integration.stats.departmentCount }} / 待确认 {{ integration.stats.pendingLinkCount }}
          </small>
          <small>
            最近同步：{{ formatDateTime(integration.lastSyncAt) }} · {{ integration.stats.lastRunStatus || '未运行' }}
          </small>
        </button>
      </aside>

      <section class="directory-admin__panel directory-admin__panel--detail">
        <div class="directory-admin__section-head">
          <div>
            <h2>{{ selectedIntegration ? '编辑集成' : '创建集成' }}</h2>
            <p class="directory-admin__hint">`appSecret` 在更新时可留空，系统会继续使用已保存的值。</p>
          </div>
          <div class="directory-admin__summary" v-if="selectedIntegration">
            <span class="directory-admin__badge">{{ selectedIntegration.status }}</span>
            <span class="directory-admin__badge" :class="{ 'directory-admin__badge--inactive': !selectedIntegration.syncEnabled }">
              {{ selectedIntegration.syncEnabled ? '已启用同步' : '仅手动同步' }}
            </span>
            <span class="directory-admin__badge">已链接 {{ selectedIntegration.stats.linkedCount }}</span>
          </div>
        </div>

        <div class="directory-admin__form-grid">
          <label class="directory-admin__field">
            <span>集成名称</span>
            <input v-model.trim="draft.name" class="directory-admin__input" type="text" placeholder="例如 DingTalk CN" />
          </label>
          <label class="directory-admin__field">
            <span>Corp ID</span>
            <input v-model.trim="draft.corpId" class="directory-admin__input" type="text" placeholder="dingxxxx" />
          </label>
          <label class="directory-admin__field">
            <span>App Key</span>
            <input v-model.trim="draft.appKey" class="directory-admin__input" type="text" placeholder="填写企业应用 appKey" />
          </label>
          <label class="directory-admin__field">
            <span>App Secret</span>
            <input v-model.trim="draft.appSecret" class="directory-admin__input" type="password" placeholder="创建必填，更新可留空" />
          </label>
          <label class="directory-admin__field">
            <span>根部门 ID</span>
            <input v-model.trim="draft.rootDepartmentId" class="directory-admin__input" type="text" placeholder="默认 1" />
          </label>
          <label class="directory-admin__field">
            <span>Base URL</span>
            <input v-model.trim="draft.baseUrl" class="directory-admin__input" type="text" placeholder="默认 https://oapi.dingtalk.com" />
          </label>
          <label class="directory-admin__field">
            <span>Page Size</span>
            <input v-model.number="draft.pageSize" class="directory-admin__input" type="number" min="1" max="100" />
          </label>
          <label class="directory-admin__field">
            <span>状态</span>
            <select v-model="draft.status" class="directory-admin__input">
              <option value="active">active</option>
              <option value="paused">paused</option>
            </select>
          </label>
          <label class="directory-admin__field">
            <span>Schedule Cron</span>
            <input v-model.trim="draft.scheduleCron" class="directory-admin__input" type="text" placeholder="一期可留空" />
          </label>
          <label class="directory-admin__field">
            <span>停权策略</span>
            <select v-model="draft.defaultDeprovisionPolicy" class="directory-admin__input">
              <option value="mark_inactive">mark_inactive</option>
              <option value="manual_review">manual_review</option>
            </select>
          </label>
          <label class="directory-admin__toggle">
            <input v-model="draft.syncEnabled" type="checkbox" />
            <span>保存后允许自动同步</span>
          </label>
        </div>

        <footer class="directory-admin__footer">
          <button class="directory-admin__button" type="button" :disabled="busy || !canSave" @click="void saveIntegration()">
            {{ busy ? '处理中...' : selectedIntegration ? '保存变更' : '创建集成' }}
          </button>
          <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="busy" @click="void testIntegration()">
            测试连通性
          </button>
          <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="busy || !selectedIntegration" @click="void syncIntegration()">
            手动同步
          </button>
        </footer>

        <section v-if="selectedIntegration" class="directory-admin__section">
          <h3>当前概览</h3>
          <div class="directory-admin__chips">
            <span class="directory-admin__chip">部门 {{ selectedIntegration.stats.departmentCount }}</span>
            <span class="directory-admin__chip">账号 {{ selectedIntegration.stats.accountCount }}</span>
            <span class="directory-admin__chip">待确认 {{ selectedIntegration.stats.pendingLinkCount }}</span>
            <span class="directory-admin__chip">已链接 {{ selectedIntegration.stats.linkedCount }}</span>
            <span class="directory-admin__chip">上次成功 {{ formatDateTime(selectedIntegration.lastSuccessAt) }}</span>
          </div>
          <p v-if="selectedIntegration.lastError" class="directory-admin__status directory-admin__status--error">
            最近错误：{{ selectedIntegration.lastError }}
          </p>
        </section>

        <section v-if="testResult" class="directory-admin__section">
          <h3>连通性测试</h3>
          <div class="directory-admin__chips">
            <span class="directory-admin__chip">部门样本 {{ testResult.departmentSampleCount }}</span>
            <span class="directory-admin__chip">用户样本 {{ testResult.userSampleCount }}</span>
            <span class="directory-admin__chip">Root {{ testResult.rootDepartmentId }}</span>
          </div>
          <p class="directory-admin__hint">
            部门：{{ testResult.sampledDepartments.map((item) => item.name).join('，') || '无' }}
          </p>
          <p class="directory-admin__hint">
            用户：{{ testResult.sampledUsers.map((item) => item.name).join('，') || '无' }}
          </p>
        </section>

        <section v-if="selectedIntegration" class="directory-admin__section">
          <div class="directory-admin__section-head">
            <div>
              <h3>运行记录</h3>
              <p class="directory-admin__hint">展示最近同步执行结果与聚合统计。</p>
            </div>
            <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="loadingRuns" @click="void loadRuns(selectedIntegration.id)">
              {{ loadingRuns ? '刷新中...' : '刷新记录' }}
            </button>
          </div>
          <div v-if="runs.length === 0" class="directory-admin__empty">暂无运行记录</div>
          <article v-for="run in runs" :key="run.id" class="directory-admin__run">
            <div class="directory-admin__run-head">
              <strong>{{ run.status }}</strong>
              <small>{{ formatDateTime(run.startedAt) }} → {{ formatDateTime(run.finishedAt) }}</small>
            </div>
            <p class="directory-admin__hint">
              账号 {{ readNumericStat(run.stats, 'accountsSynced') }} / 部门 {{ readNumericStat(run.stats, 'departmentsSynced') }} /
              待确认 {{ readNumericStat(run.stats, 'pendingCount') }} / 已链接 {{ readNumericStat(run.stats, 'linkedCount') }}
            </p>
            <p v-if="run.errorMessage" class="directory-admin__status directory-admin__status--error">{{ run.errorMessage }}</p>
          </article>
        </section>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { apiFetch } from '../utils/api'

type DirectoryIntegration = {
  id: string
  name: string
  corpId: string
  status: string
  syncEnabled: boolean
  scheduleCron: string | null
  defaultDeprovisionPolicy: string
  lastSyncAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  config: {
    appKey: string
    appSecretConfigured: boolean
    rootDepartmentId: string
    baseUrl: string | null
    pageSize: number
  }
  stats: {
    departmentCount: number
    accountCount: number
    pendingLinkCount: number
    linkedCount: number
    lastRunStatus: string | null
  }
}

type DirectoryRun = {
  id: string
  status: string
  startedAt: string
  finishedAt: string | null
  stats: Record<string, unknown>
  errorMessage: string | null
}

type TestResult = {
  rootDepartmentId: string
  departmentSampleCount: number
  sampledDepartments: Array<{ id: string; name: string }>
  userSampleCount: number
  sampledUsers: Array<{ userId: string; name: string }>
}

type DirectoryDraft = {
  name: string
  corpId: string
  appKey: string
  appSecret: string
  rootDepartmentId: string
  baseUrl: string
  pageSize: number
  status: string
  scheduleCron: string
  defaultDeprovisionPolicy: string
  syncEnabled: boolean
}

const integrations = ref<DirectoryIntegration[]>([])
const runs = ref<DirectoryRun[]>([])
const selectedIntegrationId = ref('')
const loading = ref(false)
const loadingRuns = ref(false)
const busy = ref(false)
const status = ref('')
const statusTone = ref<'info' | 'error'>('info')
const testResult = ref<TestResult | null>(null)

const draft = reactive<DirectoryDraft>({
  name: '',
  corpId: '',
  appKey: '',
  appSecret: '',
  rootDepartmentId: '1',
  baseUrl: '',
  pageSize: 50,
  status: 'active',
  scheduleCron: '',
  defaultDeprovisionPolicy: 'mark_inactive',
  syncEnabled: false,
})

const selectedIntegration = computed(() =>
  integrations.value.find((integration) => integration.id === selectedIntegrationId.value) ?? null,
)

const canSave = computed(() =>
  draft.name.trim().length > 0 &&
  draft.corpId.trim().length > 0 &&
  draft.appKey.trim().length > 0 &&
  (selectedIntegration.value !== null || draft.appSecret.trim().length > 0),
)

function setStatus(message: string, tone: 'info' | 'error' = 'info') {
  status.value = message
  statusTone.value = tone
}

function resetDraft() {
  selectedIntegrationId.value = ''
  testResult.value = null
  runs.value = []
  draft.name = ''
  draft.corpId = ''
  draft.appKey = ''
  draft.appSecret = ''
  draft.rootDepartmentId = '1'
  draft.baseUrl = ''
  draft.pageSize = 50
  draft.status = 'active'
  draft.scheduleCron = ''
  draft.defaultDeprovisionPolicy = 'mark_inactive'
  draft.syncEnabled = false
}

function applyIntegrationToDraft(integration: DirectoryIntegration) {
  draft.name = integration.name
  draft.corpId = integration.corpId
  draft.appKey = integration.config.appKey
  draft.appSecret = ''
  draft.rootDepartmentId = integration.config.rootDepartmentId
  draft.baseUrl = integration.config.baseUrl ?? ''
  draft.pageSize = integration.config.pageSize
  draft.status = integration.status
  draft.scheduleCron = integration.scheduleCron ?? ''
  draft.defaultDeprovisionPolicy = integration.defaultDeprovisionPolicy
  draft.syncEnabled = integration.syncEnabled
}

function selectIntegration(integrationId: string) {
  selectedIntegrationId.value = integrationId
  testResult.value = null
  const integration = integrations.value.find((item) => item.id === integrationId)
  if (!integration) return
  applyIntegrationToDraft(integration)
  void loadRuns(integrationId)
}

function readApiError(payload: unknown, fallback: string): string {
  const error = payload && typeof payload === 'object' ? (payload as { error?: { message?: unknown } }).error : undefined
  return typeof error?.message === 'string' && error.message.trim().length > 0 ? error.message : fallback
}

async function readJson(response: Response): Promise<any> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

async function loadIntegrations() {
  loading.value = true
  try {
    const response = await apiFetch('/api/admin/directory/integrations')
    const payload = await readJson(response)
    if (!response.ok) throw new Error(readApiError(payload, '加载目录集成失败'))

    integrations.value = Array.isArray(payload?.data?.items) ? payload.data.items : []
    if (!selectedIntegrationId.value && integrations.value.length > 0) {
      selectIntegration(integrations.value[0].id)
    } else if (selectedIntegrationId.value) {
      const current = integrations.value.find((item) => item.id === selectedIntegrationId.value)
      if (current) applyIntegrationToDraft(current)
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载目录集成失败', 'error')
  } finally {
    loading.value = false
  }
}

function buildPayload() {
  return {
    name: draft.name.trim(),
    corpId: draft.corpId.trim(),
    appKey: draft.appKey.trim(),
    appSecret: draft.appSecret.trim(),
    rootDepartmentId: draft.rootDepartmentId.trim() || '1',
    baseUrl: draft.baseUrl.trim(),
    pageSize: Number(draft.pageSize || 50),
    status: draft.status,
    scheduleCron: draft.scheduleCron.trim(),
    defaultDeprovisionPolicy: draft.defaultDeprovisionPolicy,
    syncEnabled: draft.syncEnabled,
  }
}

async function saveIntegration() {
  busy.value = true
  try {
    const payload = buildPayload()
    const path = selectedIntegration.value
      ? `/api/admin/directory/integrations/${selectedIntegration.value.id}`
      : '/api/admin/directory/integrations'
    const method = selectedIntegration.value ? 'PUT' : 'POST'
    const response = await apiFetch(path, {
      method,
      body: JSON.stringify(payload),
    })
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '保存目录集成失败'))

    const integration = body?.data?.integration as DirectoryIntegration | undefined
    setStatus(selectedIntegration.value ? '目录集成已更新' : '目录集成已创建')
    testResult.value = null
    await loadIntegrations()
    if (integration?.id) selectIntegration(integration.id)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '保存目录集成失败', 'error')
  } finally {
    busy.value = false
  }
}

async function testIntegration() {
  busy.value = true
  try {
    const response = await apiFetch('/api/admin/directory/integrations/test', {
      method: 'POST',
      body: JSON.stringify(buildPayload()),
    })
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '目录连通性测试失败'))
    testResult.value = body?.data ?? null
    setStatus('目录连通性测试通过')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '目录连通性测试失败', 'error')
  } finally {
    busy.value = false
  }
}

async function syncIntegration() {
  if (!selectedIntegration.value) return
  busy.value = true
  try {
    const response = await apiFetch(`/api/admin/directory/integrations/${selectedIntegration.value.id}/sync`, {
      method: 'POST',
    })
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '目录同步失败'))
    setStatus('目录同步已完成')
    await Promise.all([
      loadIntegrations(),
      loadRuns(selectedIntegration.value.id),
    ])
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '目录同步失败', 'error')
  } finally {
    busy.value = false
  }
}

async function loadRuns(integrationId: string) {
  loadingRuns.value = true
  try {
    const response = await apiFetch(`/api/admin/directory/integrations/${integrationId}/runs?page=1&pageSize=10`)
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '加载同步记录失败'))
    runs.value = Array.isArray(body?.data?.items) ? body.data.items : []
  } catch (error) {
    runs.value = []
    setStatus(error instanceof Error ? error.message : '加载同步记录失败', 'error')
  } finally {
    loadingRuns.value = false
  }
}

function formatDateTime(value: string | null): string {
  if (!value) return '未记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function readNumericStat(stats: Record<string, unknown>, key: string): number {
  const value = stats[key]
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim().length > 0 && !Number.isNaN(Number(value))) return Number(value)
  return 0
}

onMounted(() => {
  void loadIntegrations()
})
</script>

<style scoped>
.directory-admin {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 24px;
}

.directory-admin__header,
.directory-admin__section-head,
.directory-admin__footer,
.directory-admin__actions,
.directory-admin__run-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.directory-admin__layout {
  display: grid;
  grid-template-columns: minmax(280px, 340px) minmax(0, 1fr);
  gap: 20px;
}

.directory-admin__panel {
  border: 1px solid #d8dee8;
  border-radius: 18px;
  background: #fff;
  padding: 20px;
  box-shadow: 0 14px 40px rgba(15, 23, 42, 0.06);
}

.directory-admin__panel--list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.directory-admin__panel--detail {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.directory-admin__item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px;
  border: 1px solid #d8dee8;
  border-radius: 14px;
  background: #f8fafc;
  text-align: left;
  cursor: pointer;
}

.directory-admin__item--active {
  border-color: #2563eb;
  background: #eff6ff;
}

.directory-admin__form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.directory-admin__field,
.directory-admin__toggle {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.directory-admin__toggle {
  justify-content: flex-end;
}

.directory-admin__input {
  border: 1px solid #cbd5e1;
  border-radius: 12px;
  padding: 10px 12px;
  font: inherit;
}

.directory-admin__button,
.directory-admin__link {
  border: 1px solid #1d4ed8;
  border-radius: 999px;
  padding: 9px 16px;
  background: #1d4ed8;
  color: #fff;
  text-decoration: none;
  font: inherit;
  cursor: pointer;
}

.directory-admin__button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.directory-admin__button--secondary,
.directory-admin__link {
  background: #eff6ff;
  color: #1d4ed8;
}

.directory-admin__section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.directory-admin__chips,
.directory-admin__summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.directory-admin__chip,
.directory-admin__badge {
  display: inline-flex;
  align-items: center;
  padding: 6px 10px;
  border-radius: 999px;
  background: #e2e8f0;
  color: #0f172a;
  font-size: 13px;
}

.directory-admin__badge--inactive {
  background: #fef3c7;
  color: #92400e;
}

.directory-admin__status {
  margin: 0;
  color: #0f766e;
}

.directory-admin__status--error {
  color: #b91c1c;
}

.directory-admin__hint,
.directory-admin__item small {
  margin: 0;
  color: #475569;
}

.directory-admin__empty {
  color: #64748b;
}

.directory-admin__run {
  border: 1px solid #e2e8f0;
  border-radius: 14px;
  padding: 14px;
  background: #f8fafc;
}

@media (max-width: 960px) {
  .directory-admin__layout,
  .directory-admin__form-grid {
    grid-template-columns: 1fr;
  }
}
</style>
