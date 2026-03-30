<template>
  <section class="directory-mgmt">
    <header class="directory-mgmt__header">
      <div>
        <h1>目录同步管理</h1>
        <p>管理目录同步状态、查看同步历史和处理人员脱管操作。</p>
      </div>
      <div class="directory-mgmt__actions">
        <router-link class="directory-mgmt__link" to="/admin/users">用户管理</router-link>
        <button class="directory-mgmt__button directory-mgmt__button--secondary" type="button" :disabled="loadingStatus" @click="void loadSyncStatus()">
          {{ loadingStatus ? '刷新中...' : '刷新状态' }}
        </button>
      </div>
    </header>

    <p v-if="!adminAllowed" class="directory-mgmt__warning">
      当前账号不是平台管理员。页面可见，但后端接口会拒绝非管理员操作。
    </p>
    <p v-if="status" class="directory-mgmt__status" :class="{ 'directory-mgmt__status--error': statusTone === 'error' }">
      {{ status }}
    </p>

    <!-- Section 1: Sync Status & Alerts -->
    <el-card class="directory-mgmt__card">
      <template #header>
        <div class="directory-mgmt__card-header">
          <span>同步状态</span>
        </div>
      </template>

      <el-alert
        v-if="syncStatus?.hasAlert"
        :title="syncStatus?.alertMessage || '存在未确认的告警'"
        type="warning"
        show-icon
        :closable="false"
        class="directory-mgmt__alert"
      >
        <template #default>
          <el-button size="small" type="warning" :loading="acknowledging" @click="void acknowledgeAlert()">
            确认告警
          </el-button>
        </template>
      </el-alert>

      <div v-if="loadingStatus && !syncStatus" class="directory-mgmt__empty">正在加载同步状态...</div>
      <div v-else-if="!syncStatus" class="directory-mgmt__empty">暂无同步状态数据</div>
      <dl v-else class="directory-mgmt__meta">
        <div>
          <dt>同步状态</dt>
          <dd>
            <el-tag :type="syncStatusTagType">{{ syncStatus.status }}</el-tag>
          </dd>
        </div>
        <div>
          <dt>上次同步</dt>
          <dd>{{ formatDate(syncStatus.lastSyncAt) }}</dd>
        </div>
        <div>
          <dt>下次同步</dt>
          <dd>{{ formatDate(syncStatus.nextSyncAt) }}</dd>
        </div>
      </dl>
    </el-card>

    <!-- Section 2: Sync History -->
    <el-card class="directory-mgmt__card">
      <template #header>
        <div class="directory-mgmt__card-header">
          <span>同步历史</span>
          <el-button size="small" :loading="loadingHistory" @click="void loadSyncHistory()">刷新</el-button>
        </div>
      </template>

      <el-table :data="syncHistory" stripe :loading="loadingHistory" empty-text="暂无同步记录">
        <el-table-column prop="createdAt" label="时间" width="180">
          <template #default="{ row }">{{ formatDate(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="120">
          <template #default="{ row }">
            <el-tag :type="row.status === 'completed' ? 'success' : row.status === 'failed' ? 'danger' : 'info'" size="small">
              {{ row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="syncedCount" label="同步数" width="100" />
        <el-table-column prop="failedCount" label="失败数" width="100" />
        <el-table-column prop="message" label="消息" min-width="200" />
      </el-table>

      <el-pagination
        v-if="historyTotal > historyPageSize"
        class="directory-mgmt__pagination"
        layout="prev, pager, next"
        :total="historyTotal"
        :page-size="historyPageSize"
        :current-page="historyPage"
        @current-change="handleHistoryPageChange"
      />
    </el-card>

    <!-- Section 3: Deprovision Audit -->
    <el-card class="directory-mgmt__card">
      <template #header>
        <div class="directory-mgmt__card-header">
          <span>脱管审计</span>
          <el-button size="small" :loading="loadingDeprovisions" @click="void loadDeprovisions()">刷新</el-button>
        </div>
      </template>

      <el-table :data="deprovisions" stripe :loading="loadingDeprovisions" empty-text="暂无脱管记录">
        <el-table-column prop="targetUserId" label="目标用户" width="160" />
        <el-table-column prop="performedBy" label="操作人" width="160" />
        <el-table-column prop="reason" label="原因" min-width="200" />
        <el-table-column prop="status" label="状态" width="120">
          <template #default="{ row }">
            <el-tag :type="row.status === 'executed' ? 'warning' : row.status === 'rolled-back' ? 'info' : 'success'" size="small">
              {{ row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="createdAt" label="时间" width="180">
          <template #default="{ row }">{{ formatDate(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.status === 'executed'"
              size="small"
              type="danger"
              :loading="rollingBackId === row.id"
              @click="void confirmRollback(row)"
            >
              回滚
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        v-if="deprovisionTotal > deprovisionPageSize"
        class="directory-mgmt__pagination"
        layout="prev, pager, next"
        :total="deprovisionTotal"
        :page-size="deprovisionPageSize"
        :current-page="deprovisionPage"
        @current-change="handleDeprovisionPageChange"
      />
    </el-card>

    <!-- Rollback Confirmation Dialog -->
    <el-dialog
      v-model="rollbackDialogVisible"
      title="确认回滚"
      width="420px"
    >
      <p>确定要回滚对用户 <strong>{{ rollbackTarget?.targetUserId }}</strong> 的脱管操作吗？此操作将恢复该用户的访问权限。</p>
      <template #footer>
        <el-button @click="rollbackDialogVisible = false">取消</el-button>
        <el-button type="danger" :loading="rollingBackId === rollbackTarget?.id" @click="void executeRollback()">确认回滚</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useAuth } from '../composables/useAuth'
import { apiFetch } from '../utils/api'
import { readErrorMessage } from '../utils/error'

type SyncStatus = {
  lastSyncAt: string | null
  nextSyncAt: string | null
  status: string
  hasAlert: boolean
  alertMessage: string | null
  alertAcknowledgedAt: string | null
  alertAcknowledgedBy: string | null
}

type SyncHistoryItem = {
  id: string
  createdAt: string
  status: string
  syncedCount: number
  failedCount: number
  message: string
}

type DeprovisionItem = {
  id: string
  targetUserId: string
  performedBy: string
  reason: string
  status: string
  createdAt: string
}

const { hasAdminAccess } = useAuth()

const adminAllowed = hasAdminAccess()
const status = ref('')
const statusTone = ref<'info' | 'error'>('info')
const loadingStatus = ref(false)
const loadingHistory = ref(false)
const loadingDeprovisions = ref(false)
const acknowledging = ref(false)
const rollingBackId = ref<string | null>(null)
const rollbackDialogVisible = ref(false)
const rollbackTarget = ref<DeprovisionItem | null>(null)

const syncStatus = ref<SyncStatus | null>(null)
const syncHistory = ref<SyncHistoryItem[]>([])
const historyPage = ref(1)
const historyPageSize = 10
const historyTotal = ref(0)

const deprovisions = ref<DeprovisionItem[]>([])
const deprovisionPage = ref(1)
const deprovisionPageSize = 10
const deprovisionTotal = ref(0)

const syncStatusTagType = computed(() => {
  if (!syncStatus.value) return 'info'
  const s = syncStatus.value.status
  if (s === 'ok' || s === 'success') return 'success'
  if (s === 'error' || s === 'failed') return 'danger'
  if (s === 'syncing' || s === 'running') return 'warning'
  return 'info'
})

function setStatus(message: string, tone: 'info' | 'error' = 'info'): void {
  status.value = message
  statusTone.value = tone
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.toLocaleDateString('zh-CN')} ${date.toLocaleTimeString('zh-CN', { hour12: false })}`
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>
  } catch {
    return {}
  }
}

async function loadSyncStatus(): Promise<void> {
  loadingStatus.value = true
  try {
    const response = await apiFetch('/api/admin/directory/sync/status')
    const payload = await readJson(response)
    if (!response.ok) {
      throw new Error(readErrorMessage(payload, '加载同步状态失败'))
    }
    const data = (payload.data ?? payload) as Record<string, unknown>
    syncStatus.value = {
      lastSyncAt: typeof data.lastSyncAt === 'string' ? data.lastSyncAt : null,
      nextSyncAt: typeof data.nextSyncAt === 'string' ? data.nextSyncAt : null,
      status: String(data.status || 'unknown'),
      hasAlert: data.hasAlert === true,
      alertMessage: typeof data.alertMessage === 'string' ? data.alertMessage : null,
      alertAcknowledgedAt: typeof data.alertAcknowledgedAt === 'string' ? data.alertAcknowledgedAt : null,
      alertAcknowledgedBy: typeof data.alertAcknowledgedBy === 'string' ? data.alertAcknowledgedBy : null,
    }
  } catch (error) {
    setStatus(readErrorMessage(error, '加载同步状态失败'), 'error')
  } finally {
    loadingStatus.value = false
  }
}

async function acknowledgeAlert(): Promise<void> {
  acknowledging.value = true
  try {
    const response = await apiFetch('/api/admin/directory/sync/acknowledge', {
      method: 'POST',
    })
    const payload = await readJson(response)
    if (!response.ok) {
      throw new Error(readErrorMessage(payload, '确认告警失败'))
    }
    setStatus('告警已确认')
    await loadSyncStatus()
  } catch (error) {
    setStatus(readErrorMessage(error, '确认告警失败'), 'error')
  } finally {
    acknowledging.value = false
  }
}

async function loadSyncHistory(): Promise<void> {
  loadingHistory.value = true
  try {
    const params = new URLSearchParams({
      page: String(historyPage.value),
      pageSize: String(historyPageSize),
    })
    const response = await apiFetch(`/api/admin/directory/sync/history?${params.toString()}`)
    const payload = await readJson(response)
    if (!response.ok) {
      throw new Error(readErrorMessage(payload, '加载同步历史失败'))
    }
    const data = (payload.data ?? payload) as Record<string, unknown>
    const items = Array.isArray(data.items) ? data.items : []
    syncHistory.value = items.map((item: Record<string, unknown>) => ({
      id: String(item.id || ''),
      createdAt: String(item.createdAt || ''),
      status: String(item.status || ''),
      syncedCount: Number(item.syncedCount ?? 0),
      failedCount: Number(item.failedCount ?? 0),
      message: String(item.message || ''),
    }))
    historyTotal.value = typeof data.total === 'number' ? data.total : syncHistory.value.length
  } catch (error) {
    setStatus(readErrorMessage(error, '加载同步历史失败'), 'error')
  } finally {
    loadingHistory.value = false
  }
}

async function loadDeprovisions(): Promise<void> {
  loadingDeprovisions.value = true
  try {
    const params = new URLSearchParams({
      page: String(deprovisionPage.value),
      pageSize: String(deprovisionPageSize),
    })
    const response = await apiFetch(`/api/admin/directory/deprovisions?${params.toString()}`)
    const payload = await readJson(response)
    if (!response.ok) {
      throw new Error(readErrorMessage(payload, '加载脱管记录失败'))
    }
    const data = (payload.data ?? payload) as Record<string, unknown>
    const items = Array.isArray(data.items) ? data.items : []
    deprovisions.value = items.map((item: Record<string, unknown>) => ({
      id: String(item.id || ''),
      targetUserId: String(item.targetUserId || ''),
      performedBy: String(item.performedBy || ''),
      reason: String(item.reason || ''),
      status: String(item.status || ''),
      createdAt: String(item.createdAt || ''),
    }))
    deprovisionTotal.value = typeof data.total === 'number' ? data.total : deprovisions.value.length
  } catch (error) {
    setStatus(readErrorMessage(error, '加载脱管记录失败'), 'error')
  } finally {
    loadingDeprovisions.value = false
  }
}

function confirmRollback(item: DeprovisionItem): void {
  rollbackTarget.value = item
  rollbackDialogVisible.value = true
}

async function executeRollback(): Promise<void> {
  if (!rollbackTarget.value) return
  const targetId = rollbackTarget.value.id
  rollingBackId.value = targetId
  try {
    const response = await apiFetch(`/api/admin/directory/deprovisions/${encodeURIComponent(targetId)}/rollback`, {
      method: 'POST',
    })
    const payload = await readJson(response)
    if (!response.ok) {
      throw new Error(readErrorMessage(payload, '回滚失败'))
    }
    rollbackDialogVisible.value = false
    rollbackTarget.value = null
    setStatus('脱管操作已回滚')
    await loadDeprovisions()
  } catch (error) {
    setStatus(readErrorMessage(error, '回滚失败'), 'error')
  } finally {
    rollingBackId.value = null
  }
}

function handleHistoryPageChange(page: number): void {
  historyPage.value = page
  void loadSyncHistory()
}

function handleDeprovisionPageChange(page: number): void {
  deprovisionPage.value = page
  void loadDeprovisions()
}

onMounted(async () => {
  await Promise.all([loadSyncStatus(), loadSyncHistory(), loadDeprovisions()])
})
</script>

<style scoped>
.directory-mgmt {
  display: grid;
  gap: 16px;
  padding: 24px;
}

.directory-mgmt__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.directory-mgmt__header h1 {
  margin: 0 0 4px;
  font-size: 24px;
}

.directory-mgmt__header p {
  margin: 0;
  color: #6b7280;
}

.directory-mgmt__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.directory-mgmt__link {
  color: #2563eb;
  text-decoration: none;
  font-weight: 600;
}

.directory-mgmt__link:hover {
  text-decoration: underline;
}

.directory-mgmt__button {
  height: 38px;
  border: 0;
  border-radius: 8px;
  background: #2563eb;
  color: #fff;
  padding: 0 14px;
  cursor: pointer;
}

.directory-mgmt__button:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}

.directory-mgmt__button--secondary {
  background: #475569;
}

.directory-mgmt__warning,
.directory-mgmt__status {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: #eff6ff;
  color: #1d4ed8;
}

.directory-mgmt__status--error {
  background: #fef2f2;
  color: #dc2626;
}

.directory-mgmt__card {
  margin-bottom: 0;
}

.directory-mgmt__card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.directory-mgmt__alert {
  margin-bottom: 16px;
}

.directory-mgmt__empty {
  padding: 18px;
  border-radius: 14px;
  background: #f8fafc;
  color: #64748b;
  text-align: center;
}

.directory-mgmt__meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px 18px;
}

.directory-mgmt__meta div {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.directory-mgmt__meta dt {
  color: #64748b;
  font-size: 12px;
  font-weight: 600;
}

.directory-mgmt__meta dd {
  margin: 0;
  color: #0f172a;
}

.directory-mgmt__pagination {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}
</style>
