<template>
  <section class="admin-audit">
    <header class="admin-audit__header">
      <div>
        <h1>管理审计</h1>
        <p>查看后台敏感操作的审计日志（对应 <code>operation_audit_logs</code>），支持按资源、动作、时间范围过滤与导出。</p>
      </div>

      <div class="admin-audit__actions">
        <router-link class="admin-audit__link" to="/admin/users">用户管理</router-link>
        <router-link class="admin-audit__link" to="/admin/roles">角色管理</router-link>
        <router-link class="admin-audit__link" to="/admin/permissions">权限管理</router-link>
        <input
          v-model.trim="resourceIdInput"
          class="admin-audit__input"
          type="search"
          placeholder="按 resource_id 精确匹配"
          title="精确匹配 resource_id（例如 user UUID 或 租户 ID）"
          @keyup.enter="void loadActivityLogs(1)"
        >
        <input
          v-model.trim="actorIdInput"
          class="admin-audit__input"
          type="search"
          placeholder="按 actor_id 精确匹配"
          title="精确匹配 actor_id（操作人 ID）"
          @keyup.enter="void loadActivityLogs(1)"
        >
        <select v-model="resourceTypeFilter" class="admin-audit__select">
          <option value="">全部资源</option>
          <option v-for="item in resourceTypeOptions" :key="item.value" :value="item.value">
            {{ item.label }}
          </option>
        </select>
        <select v-model="actionFilter" class="admin-audit__select">
          <option value="">全部动作</option>
          <option value="create">create</option>
          <option value="update">update</option>
          <option value="grant">grant</option>
          <option value="revoke">revoke</option>
          <option value="delete">delete</option>
        </select>
        <input v-model="fromDate" class="admin-audit__input" type="date">
        <input v-model="toDate" class="admin-audit__input" type="date">
        <button class="admin-audit__button admin-audit__button--primary" type="button" :disabled="activityLoading" @click="void loadActivityLogs(1)">
          {{ activityLoading ? '加载中...' : '刷新' }}
        </button>
        <button class="admin-audit__button" type="button" :disabled="exporting || activityLoading" @click="void exportActivityCsv()">
          {{ exporting ? '导出中...' : '导出 CSV' }}
        </button>
      </div>
    </header>

    <p v-if="status" class="admin-audit__status" :class="{ 'admin-audit__status--error': statusTone === 'error' }">
      {{ status }}
    </p>

    <section class="admin-audit__scenes">
      <article
        v-for="scene in auditScenes"
        :key="scene.key"
        class="admin-audit__scene-card"
        :class="{ 'admin-audit__scene-card--active': activeSceneKey === scene.key }"
      >
        <div class="admin-audit__scene-copy">
          <span class="admin-audit__scene-kicker">{{ scene.kicker }}</span>
          <h2>{{ scene.title }}</h2>
          <p>{{ scene.description }}</p>
        </div>
        <div class="admin-audit__scene-actions">
          <button
            class="admin-audit__button"
            type="button"
            :disabled="activityLoading || activeSceneKey === scene.key"
            @click="void applyAuditScene(scene.key)"
          >
            {{ activeSceneKey === scene.key ? '当前场景已应用' : scene.cta }}
          </button>
        </div>
      </article>
    </section>

    <section class="admin-audit__summary">
      <article class="admin-audit__summary-card">
        <span class="admin-audit__summary-label">审计日志总数</span>
        <strong>{{ activityTotal }}</strong>
      </article>
      <article class="admin-audit__summary-card">
        <span class="admin-audit__summary-label">当前过滤条件</span>
        <strong>{{ activeFilterSummary }}</strong>
      </article>
    </section>

    <div class="admin-audit__layout admin-audit__layout--single">
      <section class="admin-audit__panel">
        <div class="admin-audit__panel-head">
          <div>
            <h2>操作审计日志</h2>
            <p>覆盖用户、角色、权限、会话等后台管理动作。按 occurred_at 倒序排序。</p>
          </div>
          <div class="admin-audit__pagination">
            <button class="admin-audit__button" type="button" :disabled="activityLoading || activityPage <= 1" @click="void loadActivityLogs(activityPage - 1)">
              上一页
            </button>
            <span>第 {{ activityPage }} / {{ activityTotalPages }} 页</span>
            <button class="admin-audit__button" type="button" :disabled="activityLoading || activityPage >= activityTotalPages" @click="void loadActivityLogs(activityPage + 1)">
              下一页
            </button>
          </div>
        </div>

        <div class="admin-audit__table-wrapper">
          <table v-if="activityLogs.length" class="admin-audit__table">
            <thead>
              <tr>
                <th>时间</th>
                <th>操作人</th>
                <th>资源</th>
                <th>动作</th>
                <th>对象</th>
                <th>请求信息</th>
                <th>Meta 摘要</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in activityLogs" :key="item.id">
                <td>{{ formatDate(item.occurred_at) }}</td>
                <td>
                  <div>{{ item.actor_id || '—' }}</div>
                  <small class="admin-audit__muted">{{ item.actor_type || '' }}</small>
                </td>
                <td>{{ item.resource_type || '—' }}</td>
                <td>{{ item.action || '—' }}</td>
                <td>{{ item.resource_id || '—' }}</td>
                <td>
                  <div class="admin-audit__detail-line">{{ item.ip || '—' }}</div>
                  <small class="admin-audit__muted">{{ item.route || '' }}{{ item.status_code != null ? ` · ${item.status_code}` : '' }}</small>
                </td>
                <td>
                  <div class="admin-audit__detail-line">{{ summarizeMeta(item) }}</div>
                  <small v-if="item.request_id" class="admin-audit__muted">req: {{ item.request_id }}</small>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="admin-audit__empty">
            {{ activityLoading ? '正在加载日志...' : '暂无审计日志。' }}
          </div>
        </div>
      </section>

      <section class="admin-audit__panel admin-audit__panel--placeholder">
        <div class="admin-audit__panel-head">
          <div>
            <h2>会话撤销记录</h2>
            <p>暂未提供后端数据源，将在后续版本接入 <code>/api/admin/session-revocations</code>。</p>
          </div>
        </div>
        <div class="admin-audit__empty">当前版本使用 <code>/api/audit-logs</code> 的 <code>user-session</code> 资源条目作为替代，请在上方资源过滤中选择「用户会话」。</div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { apiFetch } from '../utils/api'

type AdminAuditLogItem = {
  id: string
  occurred_at: string
  actor_id: string | null
  actor_type: string | null
  action: string
  resource_type: string | null
  resource_id: string | null
  request_id: string | null
  ip: string | null
  user_agent: string | null
  meta: Record<string, unknown> | null
  route: string | null
  status_code: number | null
  latency_ms: number | null
}

type AuditSceneKey = 'dingtalk-governance' | 'dingtalk-governance-recent'

const resourceTypeOptions = [
  { value: 'user', label: '用户' },
  { value: 'user-auth-grant', label: '钉钉登录授权' },
  { value: 'user-role', label: '用户角色' },
  { value: 'user-invite', label: '用户邀请' },
  { value: 'permission', label: '直接权限' },
  { value: 'permission-template', label: '权限模板' },
  { value: 'user-password', label: '用户密码' },
  { value: 'user-session', label: '用户会话' },
  { value: 'role', label: '角色' },
] as const

const activityLoading = ref(false)
const exporting = ref(false)
const status = ref('')
const statusTone = ref<'info' | 'error'>('info')
const actorIdInput = ref('')
const resourceIdInput = ref('')
const resourceTypeFilter = ref('')
const actionFilter = ref('')
const fromDate = ref('')
const toDate = ref('')
const activityLogs = ref<AdminAuditLogItem[]>([])
const activityPage = ref(1)
const activityTotal = ref(0)
const pageSize = 20

const activityTotalPages = computed(() => Math.max(1, Math.ceil(activityTotal.value / pageSize)))
const auditScenes = [
  {
    key: 'dingtalk-governance',
    kicker: '治理场景',
    title: '钉钉治理动作',
    description: '一键切到钉钉登录授权撤销审计，适合排查缺 OpenID 收口、批量关闭钉钉扫码和后续责任追踪。',
    cta: '打开钉钉治理审计',
  },
  {
    key: 'dingtalk-governance-recent',
    kicker: '巡检场景',
    title: '最近 7 天收口结果',
    description: '聚焦最近 7 天的钉钉登录授权撤销记录，适合日常巡检最近关闭钉钉扫码的治理结果。',
    cta: '查看最近 7 天收口',
  },
] as const satisfies ReadonlyArray<{
  key: AuditSceneKey
  kicker: string
  title: string
  description: string
  cta: string
}>

const activeSceneKey = computed<AuditSceneKey | ''>(() => {
  if (
    resourceTypeFilter.value !== 'user-auth-grant'
    || actionFilter.value !== 'revoke'
    || actorIdInput.value
    || resourceIdInput.value
  ) {
    return ''
  }
  if (!fromDate.value && !toDate.value) return 'dingtalk-governance'
  const recentRange = buildRecentDayRange(7)
  if (fromDate.value === recentRange.fromDate && toDate.value === recentRange.toDate) {
    return 'dingtalk-governance-recent'
  }
  return ''
})

const activeFilterSummary = computed(() => {
  const parts: string[] = []
  if (actorIdInput.value) parts.push(`actor=${actorIdInput.value}`)
  if (resourceIdInput.value) parts.push(`resourceId=${resourceIdInput.value}`)
  if (resourceTypeFilter.value) parts.push(`resourceType=${resourceTypeFilter.value}`)
  if (actionFilter.value) parts.push(`action=${actionFilter.value}`)
  if (fromDate.value) parts.push(`from=${fromDate.value}`)
  if (toDate.value) parts.push(`to=${toDate.value}`)
  return parts.length ? parts.join(' · ') : '无（显示全部）'
})

function setStatus(message: string, tone: 'info' | 'error' = 'info'): void {
  status.value = message
  statusTone.value = tone
}

function applyFiltersFromLocation(): void {
  if (typeof window === 'undefined') return
  const params = new URL(window.location.href).searchParams
  resourceIdInput.value = params.get('resourceId')?.trim() || ''
  actorIdInput.value = params.get('actorId')?.trim() || ''
  resourceTypeFilter.value = params.get('resourceType')?.trim() || ''
  actionFilter.value = params.get('action')?.trim() || ''
  const from = params.get('from')?.trim() || ''
  const to = params.get('to')?.trim() || ''
  fromDate.value = from ? from.slice(0, 10) : ''
  toDate.value = to ? to.slice(0, 10) : ''
}

function formatDateInput(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function buildRecentDayRange(days: number): { fromDate: string; toDate: string } {
  const end = new Date()
  const start = new Date(end)
  start.setDate(start.getDate() - Math.max(0, days - 1))
  return {
    fromDate: formatDateInput(start),
    toDate: formatDateInput(end),
  }
}

function syncFiltersToLocation(): void {
  if (typeof window === 'undefined') return
  const params = buildQueryParams()
  const path = window.location.pathname || '/admin/audit'
  const url = params.toString() ? `${path}?${params.toString()}` : path
  window.history.replaceState({}, '', url)
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>
  } catch {
    return {}
  }
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.toLocaleDateString('zh-CN')} ${date.toLocaleTimeString('zh-CN', { hour12: false })}`
}

function summarizeMeta(item: AdminAuditLogItem): string {
  const meta = item.meta || {}
  if (!meta || typeof meta !== 'object') return '—'
  const pairs: string[] = []
  const append = (label: string, value: unknown) => {
    if (value == null) return
    if (Array.isArray(value)) {
      if (value.length) pairs.push(`${label}: ${value.join(', ')}`)
      return
    }
    if (typeof value === 'object') {
      try {
        const text = JSON.stringify(value)
        if (text && text !== '{}') pairs.push(`${label}: ${text}`)
      } catch {
        /* ignore */
      }
      return
    }
    const text = String(value).trim()
    if (text) pairs.push(`${label}: ${text}`)
  }

  append('email', (meta as Record<string, unknown>).email)
  append('name', (meta as Record<string, unknown>).name)
  append('role', (meta as Record<string, unknown>).roleId || (meta as Record<string, unknown>).role)
  append('preset', (meta as Record<string, unknown>).presetId)
  append('permissions', (meta as Record<string, unknown>).permissions)
  append('reason', (meta as Record<string, unknown>).reason)

  const before = (meta as Record<string, unknown>).before
  const after = (meta as Record<string, unknown>).after
  if (before != null && after != null) {
    try {
      const beforeState = JSON.stringify(before)
      const afterState = JSON.stringify(after)
      if (beforeState !== afterState) {
        pairs.push(`变更: ${beforeState} -> ${afterState}`)
      }
    } catch {
      /* ignore */
    }
  }

  if (pairs.length) return pairs.join(' · ')

  try {
    const fallback = JSON.stringify(meta)
    return fallback === '{}' ? '—' : fallback.slice(0, 280)
  } catch {
    return '—'
  }
}

function toIsoBound(value: string, endOfDay = false): string {
  // value is a YYYY-MM-DD from <input type="date">
  if (!value) return ''
  if (endOfDay) return `${value}T23:59:59.999Z`
  return `${value}T00:00:00.000Z`
}

function buildQueryParams(extra: Record<string, string> = {}): URLSearchParams {
  const params = new URLSearchParams()
  if (actorIdInput.value) params.set('actorId', actorIdInput.value)
  if (resourceIdInput.value) params.set('resourceId', resourceIdInput.value)
  if (resourceTypeFilter.value) params.set('resourceType', resourceTypeFilter.value)
  if (actionFilter.value) params.set('action', actionFilter.value)
  if (fromDate.value) params.set('from', toIsoBound(fromDate.value))
  if (toDate.value) params.set('to', toIsoBound(toDate.value, true))
  for (const [key, value] of Object.entries(extra)) {
    params.set(key, value)
  }
  return params
}

async function applyAuditScene(scene: AuditSceneKey): Promise<void> {
  actorIdInput.value = ''
  resourceIdInput.value = ''
  resourceTypeFilter.value = 'user-auth-grant'
  actionFilter.value = 'revoke'
  if (scene === 'dingtalk-governance-recent') {
    const recentRange = buildRecentDayRange(7)
    fromDate.value = recentRange.fromDate
    toDate.value = recentRange.toDate
  } else {
    fromDate.value = ''
    toDate.value = ''
  }
  await loadActivityLogs(1)
}

async function loadActivityLogs(page = 1): Promise<void> {
  activityLoading.value = true
  setStatus('')
  try {
    const params = buildQueryParams({ page: String(page), pageSize: String(pageSize) })
    syncFiltersToLocation()
    const response = await apiFetch(`/api/audit-logs?${params.toString()}`)
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载审计日志失败'))
    }

    const data = payload.data as { items?: AdminAuditLogItem[]; total?: number; page?: number } | undefined
    activityLogs.value = Array.isArray(data?.items) ? data!.items! : []
    activityTotal.value = Number(data?.total ?? activityLogs.value.length) || 0
    activityPage.value = Number(data?.page ?? page) || page
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载审计日志失败', 'error')
  } finally {
    activityLoading.value = false
  }
}

function downloadBlob(filename: string, blob: Blob): void {
  const link = document.createElement('a')
  const url = URL.createObjectURL(blob)
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function resolveExportFilename(response: Response): string {
  const disposition = response.headers.get('content-disposition') || ''
  const match = disposition.match(/filename="([^"]+)"/i)
  return match?.[1] || 'audit-logs.csv'
}

async function exportActivityCsv(): Promise<void> {
  exporting.value = true
  try {
    const params = buildQueryParams({ format: 'csv', limit: '100000' })
    const response = await apiFetch(`/api/audit-logs?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'text/csv' },
    })
    if (!response.ok) {
      const payload = await readJson(response)
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '导出审计日志失败'))
    }

    downloadBlob(resolveExportFilename(response), await response.blob())
    setStatus('审计日志 CSV 已导出')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '导出审计日志失败', 'error')
  } finally {
    exporting.value = false
  }
}

onMounted(() => {
  applyFiltersFromLocation()
  void loadActivityLogs(1)
})
</script>

<style scoped>
.admin-audit {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.admin-audit__header,
.admin-audit__scenes,
.admin-audit__summary,
.admin-audit__panel {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 16px;
  padding: 16px;
}

.admin-audit__header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
}

.admin-audit__actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
}

.admin-audit__link,
.admin-audit__button {
  border: 1px solid #d1d5db;
  border-radius: 10px;
  background: #fff;
  color: #374151;
  padding: 8px 12px;
  text-decoration: none;
  cursor: pointer;
}

.admin-audit__button--primary {
  background: #2563eb;
  color: #fff;
  border-color: #2563eb;
}

.admin-audit__input,
.admin-audit__select {
  border: 1px solid #d1d5db;
  border-radius: 10px;
  padding: 8px 12px;
  min-width: 180px;
}

.admin-audit__summary {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.admin-audit__scene-card {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
}

.admin-audit__scene-card--active {
  padding: 12px;
  border-radius: 12px;
  background: linear-gradient(135deg, #eff6ff, #f8fafc);
}

.admin-audit__scene-copy {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.admin-audit__scene-copy h2,
.admin-audit__scene-copy p {
  margin: 0;
}

.admin-audit__scene-copy p,
.admin-audit__scene-kicker {
  color: #6b7280;
}

.admin-audit__scene-kicker {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.admin-audit__scene-actions {
  display: flex;
  align-items: center;
}

.admin-audit__summary-card {
  background: #f8fafc;
  border-radius: 12px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.admin-audit__summary-label,
.admin-audit__muted {
  color: #6b7280;
  font-size: 12px;
}

.admin-audit__layout {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
  gap: 16px;
}

.admin-audit__layout--single {
  grid-template-columns: minmax(0, 1fr);
}

.admin-audit__panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.admin-audit__panel--placeholder {
  background: #f8fafc;
  border-style: dashed;
}

.admin-audit__panel-head,
.admin-audit__pagination {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.admin-audit__table-wrapper {
  overflow: auto;
}

.admin-audit__table {
  width: 100%;
  border-collapse: collapse;
}

.admin-audit__table th,
.admin-audit__table td {
  text-align: left;
  padding: 10px 8px;
  border-bottom: 1px solid #e5e7eb;
  vertical-align: top;
}

.admin-audit__detail-line {
  font-size: 13px;
  color: #111827;
}

.admin-audit__status {
  margin: 0;
  padding: 10px 12px;
  border-radius: 10px;
  background: #eff6ff;
  color: #1d4ed8;
}

.admin-audit__status--error {
  background: #fef2f2;
  color: #b91c1c;
}

.admin-audit__empty {
  padding: 24px;
  text-align: center;
  color: #6b7280;
}

@media (max-width: 1100px) {
  .admin-audit__header,
  .admin-audit__scene-card,
  .admin-audit__panel-head,
  .admin-audit__pagination {
    flex-direction: column;
    align-items: stretch;
  }

  .admin-audit__layout,
  .admin-audit__summary {
    grid-template-columns: 1fr;
  }

  .admin-audit__actions {
    justify-content: flex-start;
  }
}
</style>
