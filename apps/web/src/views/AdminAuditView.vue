<template>
  <section class="admin-audit">
    <header class="admin-audit__header">
      <div>
        <h1>管理审计</h1>
        <p>查看用户、角色、权限和会话治理相关的后台操作记录。</p>
      </div>

      <div class="admin-audit__actions">
        <router-link class="admin-audit__link" to="/admin/users">用户管理</router-link>
        <router-link class="admin-audit__link" to="/admin/roles">角色管理</router-link>
        <router-link class="admin-audit__link" to="/admin/permissions">权限管理</router-link>
        <input
          v-model.trim="search"
          class="admin-audit__input"
          type="search"
          placeholder="搜索用户、资源 ID、邮箱或原因"
          @keyup.enter="void reloadAll()"
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
        </select>
        <input v-model="fromDate" class="admin-audit__input" type="date">
        <input v-model="toDate" class="admin-audit__input" type="date">
        <button class="admin-audit__button admin-audit__button--primary" type="button" :disabled="activityLoading || revocationLoading" @click="void reloadAll()">
          {{ activityLoading || revocationLoading ? '加载中...' : '刷新' }}
        </button>
        <button class="admin-audit__button" type="button" :disabled="exporting || activityLoading" @click="void exportActivityCsv()">
          {{ exporting ? '导出中...' : '导出 CSV' }}
        </button>
      </div>
    </header>

    <p v-if="status" class="admin-audit__status" :class="{ 'admin-audit__status--error': statusTone === 'error' }">
      {{ status }}
    </p>

    <section class="admin-audit__summary">
      <article class="admin-audit__summary-card">
        <span class="admin-audit__summary-label">IAM 活动日志</span>
        <strong>{{ activityTotal }}</strong>
      </article>
      <article class="admin-audit__summary-card">
        <span class="admin-audit__summary-label">会话撤销记录</span>
        <strong>{{ revocationTotal }}</strong>
      </article>
    </section>

    <div class="admin-audit__layout">
      <section class="admin-audit__panel">
        <div class="admin-audit__panel-head">
          <div>
            <h2>IAM 活动日志</h2>
            <p>覆盖用户创建、账号启停、密码重置、角色分配、直接授权等管理动作。</p>
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
                <th>资源</th>
                <th>动作</th>
                <th>对象</th>
                <th>摘要</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in activityLogs" :key="item.id">
                <td>{{ formatDate(item.created_at) }}</td>
                <td>{{ item.resource_type || '--' }}</td>
                <td>{{ item.action }}</td>
                <td>{{ item.resource_id || '--' }}</td>
                <td>
                  <div class="admin-audit__detail-line">{{ summarizeAction(item) }}</div>
                  <small class="admin-audit__muted">{{ actorSummary(item) }}</small>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="admin-audit__empty">
            {{ activityLoading ? '正在加载日志...' : '暂无 IAM 管理日志。' }}
          </div>
        </div>
      </section>

      <section class="admin-audit__panel">
        <div class="admin-audit__panel-head">
          <div>
            <h2>会话撤销记录</h2>
            <p>记录强制下线、停用账号、重置密码触发的会话失效事件。</p>
          </div>
          <div class="admin-audit__pagination">
            <button class="admin-audit__button" type="button" :disabled="revocationLoading || revocationPage <= 1" @click="void loadSessionRevocations(revocationPage - 1)">
              上一页
            </button>
            <span>第 {{ revocationPage }} / {{ revocationTotalPages }} 页</span>
            <button class="admin-audit__button" type="button" :disabled="revocationLoading || revocationPage >= revocationTotalPages" @click="void loadSessionRevocations(revocationPage + 1)">
              下一页
            </button>
          </div>
        </div>

        <div class="admin-audit__table-wrapper">
          <table v-if="sessionRevocations.length" class="admin-audit__table">
            <thead>
              <tr>
                <th>用户</th>
                <th>原因</th>
                <th>操作人</th>
                <th>撤销时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in sessionRevocations" :key="`${item.user_id}-${item.updated_at}`">
                <td>
                  <div>{{ item.user_name || item.user_email || item.user_id }}</div>
                  <small class="admin-audit__muted">{{ item.user_email || item.user_id }}</small>
                </td>
                <td>{{ item.reason || '--' }}</td>
                <td>
                  <div>{{ item.updated_by_name || item.updated_by_email || item.updated_by || '--' }}</div>
                  <small class="admin-audit__muted">{{ item.updated_by_email || item.updated_by || '' }}</small>
                </td>
                <td>{{ formatDate(item.revoked_after) }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="admin-audit__empty">
            {{ revocationLoading ? '正在加载会话撤销记录...' : '暂无会话撤销记录。' }}
          </div>
        </div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { apiFetch } from '../utils/api'

type AdminAuditLogItem = {
  id: number
  created_at: string
  event_type: string
  event_category: string
  event_severity: string
  action: string
  resource_type: string | null
  resource_id: string | null
  user_id: number | null
  user_name: string | null
  user_email: string | null
  action_details: Record<string, unknown> | null
  error_code: string | null
}

type SessionRevocationItem = {
  user_id: string
  revoked_after: string
  updated_at: string
  updated_by: string | null
  reason: string | null
  user_email: string | null
  user_name: string | null
  updated_by_email: string | null
  updated_by_name: string | null
}

const resourceTypeOptions = [
  { value: 'user', label: '用户' },
  { value: 'user-role', label: '用户角色' },
  { value: 'user-invite', label: '用户邀请' },
  { value: 'permission', label: '直接权限' },
  { value: 'permission-template', label: '权限模板' },
  { value: 'user-password', label: '用户密码' },
  { value: 'user-session', label: '用户会话' },
  { value: 'role', label: '角色' },
] as const

const activityLoading = ref(false)
const revocationLoading = ref(false)
const exporting = ref(false)
const status = ref('')
const statusTone = ref<'info' | 'error'>('info')
const search = ref('')
const resourceTypeFilter = ref('')
const actionFilter = ref('')
const fromDate = ref('')
const toDate = ref('')
const activityLogs = ref<AdminAuditLogItem[]>([])
const sessionRevocations = ref<SessionRevocationItem[]>([])
const activityPage = ref(1)
const revocationPage = ref(1)
const activityTotal = ref(0)
const revocationTotal = ref(0)
const pageSize = 20

const activityTotalPages = computed(() => Math.max(1, Math.ceil(activityTotal.value / pageSize)))
const revocationTotalPages = computed(() => Math.max(1, Math.ceil(revocationTotal.value / pageSize)))

function setStatus(message: string, tone: 'info' | 'error' = 'info'): void {
  status.value = message
  statusTone.value = tone
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>
  } catch {
    return {}
  }
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.toLocaleDateString('zh-CN')} ${date.toLocaleTimeString('zh-CN', { hour12: false })}`
}

function summarizeAction(item: AdminAuditLogItem): string {
  const details = item.action_details || {}
  const pairs: string[] = []
  const append = (label: string, value: unknown) => {
    if (value == null) return
    if (Array.isArray(value)) {
      if (value.length) pairs.push(`${label}: ${value.join(', ')}`)
      return
    }
    if (typeof value === 'object') return
    const text = String(value).trim()
    if (text) pairs.push(`${label}: ${text}`)
  }

  append('邮箱', details.email)
  append('姓名', details.name)
  append('角色', details.roleId || details.role)
  append('预设', details.presetId)
  append('权限', details.permissions)
  append('原因', details.reason)
  append('临时密码', details.generatedPassword === true ? '系统生成' : undefined)

  const before = details.before
  const after = details.after
  if (before && after && typeof before === 'object' && typeof after === 'object') {
    const beforeState = JSON.stringify(before)
    const afterState = JSON.stringify(after)
    if (beforeState !== afterState) {
      pairs.push(`变更: ${beforeState} -> ${afterState}`)
    }
  }

  return pairs.join(' · ') || '无补充摘要'
}

function actorSummary(item: AdminAuditLogItem): string {
  const adminUserId = typeof item.action_details?.adminUserId === 'string' ? item.action_details.adminUserId : ''
  if (item.user_email || item.user_name) {
    return `${item.user_name || item.user_email}${adminUserId ? ` · ${adminUserId}` : ''}`
  }
  return adminUserId ? `操作人：${adminUserId}` : '操作人未记录'
}

async function loadActivityLogs(page = 1): Promise<void> {
  activityLoading.value = true
  try {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
    })
    if (search.value) params.set('q', search.value)
    if (resourceTypeFilter.value) params.set('resourceType', resourceTypeFilter.value)
    if (actionFilter.value) params.set('action', actionFilter.value)
    if (fromDate.value) params.set('from', fromDate.value)
    if (toDate.value) params.set('to', toDate.value)

    const response = await apiFetch(`/api/admin/audit-activity?${params.toString()}`)
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载管理审计失败'))
    }

    const data = payload.data as { items?: AdminAuditLogItem[]; total?: number; page?: number } | undefined
    activityLogs.value = Array.isArray(data?.items) ? data.items : []
    activityTotal.value = Number(data?.total ?? activityLogs.value.length) || 0
    activityPage.value = Number(data?.page ?? page) || page
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载管理审计失败', 'error')
  } finally {
    activityLoading.value = false
  }
}

async function loadSessionRevocations(page = 1): Promise<void> {
  revocationLoading.value = true
  try {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
    })
    if (search.value) params.set('q', search.value)
    if (fromDate.value) params.set('from', fromDate.value)
    if (toDate.value) params.set('to', toDate.value)

    const response = await apiFetch(`/api/admin/session-revocations?${params.toString()}`)
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载会话撤销记录失败'))
    }

    const data = payload.data as { items?: SessionRevocationItem[]; total?: number; page?: number } | undefined
    sessionRevocations.value = Array.isArray(data?.items) ? data.items : []
    revocationTotal.value = Number(data?.total ?? sessionRevocations.value.length) || 0
    revocationPage.value = Number(data?.page ?? page) || page
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载会话撤销记录失败', 'error')
  } finally {
    revocationLoading.value = false
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
  return match?.[1] || 'iam-admin-audit.csv'
}

async function exportActivityCsv(): Promise<void> {
  exporting.value = true
  try {
    const params = new URLSearchParams({ limit: '5000' })
    if (search.value) params.set('q', search.value)
    if (resourceTypeFilter.value) params.set('resourceType', resourceTypeFilter.value)
    if (actionFilter.value) params.set('action', actionFilter.value)
    if (fromDate.value) params.set('from', fromDate.value)
    if (toDate.value) params.set('to', toDate.value)

    const response = await apiFetch(`/api/admin/audit-activity/export.csv?${params.toString()}`)
    if (!response.ok) {
      const payload = await readJson(response)
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '导出管理审计失败'))
    }

    downloadBlob(resolveExportFilename(response), await response.blob())
    setStatus('管理审计 CSV 已导出')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '导出管理审计失败', 'error')
  } finally {
    exporting.value = false
  }
}

async function reloadAll(): Promise<void> {
  setStatus('')
  await Promise.all([loadActivityLogs(1), loadSessionRevocations(1)])
}

onMounted(() => {
  void reloadAll()
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

.admin-audit__panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
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
