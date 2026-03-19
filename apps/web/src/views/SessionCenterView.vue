<template>
  <section class="session-center">
    <header class="session-center__header">
      <div>
        <h1>我的会话</h1>
        <p>查看当前账号的登录设备，并按会话结束异常登录。</p>
      </div>
      <div class="session-center__actions">
        <span v-if="accountEmail" class="session-center__account">{{ accountEmail }}</span>
        <button class="session-center__button session-center__button--secondary" type="button" :disabled="loading" @click="void loadSessions()">
          {{ loading ? '刷新中...' : '刷新会话' }}
        </button>
      </div>
    </header>

    <p
      v-if="status"
      class="session-center__status"
      :class="{ 'session-center__status--error': statusTone === 'error' }"
    >
      {{ status }}
    </p>

    <section class="session-center__panel">
      <div class="session-center__summary">
        <div class="session-center__metric">
          <strong>{{ sessions.length }}</strong>
          <span>全部会话</span>
        </div>
        <div class="session-center__metric">
          <strong>{{ activeSessionCount }}</strong>
          <span>活动会话</span>
        </div>
        <div class="session-center__metric">
          <strong>{{ revokedSessionCount }}</strong>
          <span>已撤销</span>
        </div>
      </div>

      <section v-if="currentSession" class="session-center__current">
        <div class="session-center__current-copy">
          <p class="session-center__current-label">当前设备</p>
          <strong>{{ summarizeDevice(currentSession) }}</strong>
          <p class="session-center__current-meta">
            最近活跃：{{ formatDate(currentSession.lastSeenAt) }}
            <span v-if="currentSession.ipAddress"> · IP {{ currentSession.ipAddress }}</span>
          </p>
        </div>
        <button
          class="session-center__button session-center__button--secondary"
          type="button"
          :disabled="heartbeatLoading"
          @click="void pingCurrentSession()"
        >
          {{ heartbeatLoading ? '同步中...' : '同步当前设备' }}
        </button>
      </section>

      <div v-if="loading && sessions.length === 0" class="session-center__empty">
        正在加载会话列表...
      </div>
      <div v-else-if="sessions.length === 0" class="session-center__empty">
        当前没有可展示的会话记录。
      </div>
      <div v-else class="session-center__list">
        <article v-for="session in sessions" :key="session.id" class="session-center__card">
          <header class="session-center__card-head">
            <div>
              <strong>{{ session.id }}</strong>
              <div class="session-center__badges">
                <span
                  class="session-center__badge"
                  :class="{ 'session-center__badge--current': session.id === currentSessionId }"
                >
                  {{ session.id === currentSessionId ? '当前设备' : '其他设备' }}
                </span>
                <span
                  class="session-center__badge"
                  :class="{ 'session-center__badge--revoked': Boolean(session.revokedAt) }"
                >
                  {{ session.revokedAt ? '已撤销' : '活动中' }}
                </span>
              </div>
            </div>
            <button
              v-if="!session.revokedAt"
              class="session-center__button"
              type="button"
              :disabled="busySessionId === session.id"
              @click="void revokeSession(session.id)"
            >
              {{ busySessionId === session.id ? '处理中...' : session.id === currentSessionId ? '退出当前会话' : '结束此会话' }}
            </button>
          </header>

          <dl class="session-center__meta">
            <div>
              <dt>签发时间</dt>
              <dd>{{ formatDate(session.issuedAt) }}</dd>
            </div>
            <div>
              <dt>过期时间</dt>
              <dd>{{ formatDate(session.expiresAt) }}</dd>
            </div>
            <div>
              <dt>最近活跃</dt>
              <dd>{{ formatDate(session.lastSeenAt) }}</dd>
            </div>
            <div v-if="session.ipAddress">
              <dt>IP 地址</dt>
              <dd>{{ session.ipAddress }}</dd>
            </div>
            <div v-if="session.userAgent">
              <dt>浏览器 / 客户端</dt>
              <dd>{{ summarizeUserAgent(session.userAgent) }}</dd>
            </div>
            <div v-if="session.revokedAt">
              <dt>撤销时间</dt>
              <dd>{{ formatDate(session.revokedAt) }}</dd>
            </div>
            <div v-if="session.revokeReason">
              <dt>撤销原因</dt>
              <dd>{{ session.revokeReason }}</dd>
            </div>
          </dl>
        </article>
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '../composables/useAuth'
import { apiFetch } from '../utils/api'

type SessionRecord = {
  id: string
  issuedAt: string
  expiresAt: string
  lastSeenAt: string
  revokedAt: string | null
  revokedBy: string | null
  revokeReason: string | null
  ipAddress: string | null
  userAgent: string | null
  createdAt: string
  updatedAt: string
}

type StatusTone = 'info' | 'error'

const router = useRouter()
const auth = useAuth()

const loading = ref(false)
const heartbeatLoading = ref(false)
const busySessionId = ref<string | null>(null)
const sessions = ref<SessionRecord[]>([])
const currentSessionId = ref<string | null>(null)
const status = ref('')
const statusTone = ref<StatusTone>('info')
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null

const accountEmail = computed(() => auth.getAccessSnapshot().email)
const activeSessionCount = computed(() => sessions.value.filter((session) => !session.revokedAt).length)
const revokedSessionCount = computed(() => sessions.value.filter((session) => Boolean(session.revokedAt)).length)
const currentSession = computed(() => sessions.value.find((session) => session.id === currentSessionId.value) ?? null)

function setStatus(message: string, tone: StatusTone = 'info') {
  status.value = message
  statusTone.value = tone
}

function clearFeatureCache() {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.removeItem('metasheet_features')
    localStorage.removeItem('metasheet_product_mode')
  } catch {
    // ignore local cleanup failures
  }
}

async function redirectToLogin() {
  auth.clearToken()
  clearFeatureCache()
  await router.replace({
    name: 'login',
    query: {
      redirect: '/settings',
    },
  }).catch(() => undefined)
}

function extractError(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>
  if (typeof record.error === 'string') return record.error
  const data = record.data
  if (data && typeof data === 'object' && typeof (data as Record<string, unknown>).error === 'string') {
    return (data as Record<string, unknown>).error as string
  }
  return ''
}

function summarizeUserAgent(userAgent: string): string {
  const trimmed = userAgent.trim()
  if (trimmed.length <= 96) return trimmed
  return `${trimmed.slice(0, 93)}...`
}

function summarizeDevice(session: SessionRecord): string {
  if (session.userAgent) return summarizeUserAgent(session.userAgent)
  if (session.ipAddress) return `IP ${session.ipAddress}`
  return '当前浏览器会话'
}

function formatDate(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

async function loadSessions() {
  loading.value = true
  setStatus('')

  try {
    const response = await apiFetch('/api/auth/sessions')
    const payload = await response.json().catch(() => null)

    if (response.status === 401) {
      await redirectToLogin()
      return
    }

    if (!response.ok) {
      setStatus(extractError(payload) || '加载会话失败', 'error')
      return
    }

    const data = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).data : null
    const record = data && typeof data === 'object' ? data as Record<string, unknown> : {}
    const items = Array.isArray(record.items) ? record.items as SessionRecord[] : []
    sessions.value = items
    currentSessionId.value = typeof record.currentSessionId === 'string' ? record.currentSessionId : null
    setStatus(`已同步 ${items.length} 条会话记录`)
    scheduleHeartbeat()
  } catch {
    setStatus('加载会话失败，请稍后重试', 'error')
  } finally {
    loading.value = false
  }
}

function clearHeartbeatTimer() {
  if (heartbeatTimer) {
    clearTimeout(heartbeatTimer)
    heartbeatTimer = null
  }
}

function scheduleHeartbeat() {
  clearHeartbeatTimer()
  if (!currentSessionId.value) return
  heartbeatTimer = setTimeout(() => {
    void pingCurrentSession({ quiet: true })
  }, 60_000)
}

function mergeSessionRecord(updated: SessionRecord) {
  const index = sessions.value.findIndex((session) => session.id === updated.id)
  if (index >= 0) {
    sessions.value.splice(index, 1, updated)
  } else {
    sessions.value = [updated, ...sessions.value]
  }
}

async function pingCurrentSession(options: { quiet?: boolean } = {}) {
  heartbeatLoading.value = true
  if (!options.quiet) setStatus('')

  try {
    const response = await apiFetch('/api/auth/sessions/current/ping', {
      method: 'POST',
    })
    const payload = await response.json().catch(() => null)

    if (response.status === 401) {
      await redirectToLogin()
      return
    }

    if (!response.ok) {
      if (!options.quiet) {
        setStatus(extractError(payload) || '同步当前设备失败', 'error')
      }
      return
    }

    const data = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).data : null
    const record = data && typeof data === 'object' ? data as Record<string, unknown> : {}
    const session = record.session as SessionRecord | null | undefined
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : currentSessionId.value
    if (sessionId) currentSessionId.value = sessionId
    if (session) mergeSessionRecord(session)
    if (!options.quiet) {
      setStatus('当前设备已同步')
    }
    scheduleHeartbeat()
  } catch {
    if (!options.quiet) {
      setStatus('同步当前设备失败，请稍后重试', 'error')
    }
  } finally {
    heartbeatLoading.value = false
  }
}

async function revokeSession(sessionId: string) {
  busySessionId.value = sessionId
  setStatus('')

  try {
    const response = await apiFetch(`/api/auth/sessions/${encodeURIComponent(sessionId)}/logout`, {
      method: 'POST',
    })
    const payload = await response.json().catch(() => null)

    if (response.status === 401) {
      await redirectToLogin()
      return
    }

    if (!response.ok) {
      setStatus(extractError(payload) || '结束会话失败', 'error')
      return
    }

    if (sessionId === currentSessionId.value) {
      setStatus('当前会话已退出，正在返回登录页')
      await redirectToLogin()
      return
    }

    setStatus('会话已结束')
    await loadSessions()
  } catch {
    setStatus('结束会话失败，请稍后重试', 'error')
  } finally {
    busySessionId.value = null
  }
}

onMounted(() => {
  void loadSessions()
})

onBeforeUnmount(() => {
  clearHeartbeatTimer()
})
</script>

<style scoped>
.session-center {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.session-center__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.session-center__header h1 {
  margin: 0 0 8px;
  font-size: 28px;
  font-weight: 700;
  color: #0f172a;
}

.session-center__header p {
  margin: 0;
  color: #475569;
}

.session-center__actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.session-center__account {
  display: inline-flex;
  align-items: center;
  padding: 8px 12px;
  border-radius: 999px;
  background: #eff6ff;
  color: #1d4ed8;
  font-weight: 600;
}

.session-center__status {
  margin: 0;
  padding: 10px 14px;
  border-radius: 10px;
  background: #eff6ff;
  color: #1d4ed8;
}

.session-center__status--error {
  background: #fef2f2;
  color: #b91c1c;
}

.session-center__panel {
  padding: 20px;
  border-radius: 18px;
  background: #fff;
  border: 1px solid #e2e8f0;
  box-shadow: 0 8px 30px rgba(15, 23, 42, 0.05);
}

.session-center__summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.session-center__metric {
  padding: 14px;
  border-radius: 14px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
}

.session-center__metric strong {
  display: block;
  font-size: 24px;
  color: #0f172a;
}

.session-center__metric span {
  color: #64748b;
}

.session-center__current {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
  padding: 16px 18px;
  border-radius: 14px;
  background: linear-gradient(90deg, #eff6ff 0%, #f8fafc 100%);
  border: 1px solid #bfdbfe;
}

.session-center__current-copy {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.session-center__current-label {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: #1d4ed8;
}

.session-center__current-copy strong {
  color: #0f172a;
}

.session-center__current-meta {
  margin: 0;
  color: #475569;
}

.session-center__empty {
  padding: 18px;
  border-radius: 14px;
  background: #f8fafc;
  color: #64748b;
  text-align: center;
}

.session-center__list {
  display: grid;
  gap: 16px;
}

.session-center__card {
  padding: 18px;
  border-radius: 16px;
  border: 1px solid #e2e8f0;
  background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
}

.session-center__card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}

.session-center__card-head strong {
  display: block;
  margin-bottom: 8px;
  font-size: 15px;
  color: #0f172a;
  word-break: break-all;
}

.session-center__badges {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.session-center__badge {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 999px;
  background: #e2e8f0;
  color: #334155;
  font-size: 12px;
  font-weight: 600;
}

.session-center__badge--current {
  background: #dcfce7;
  color: #166534;
}

.session-center__badge--revoked {
  background: #fee2e2;
  color: #b91c1c;
}

.session-center__meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px 18px;
}

.session-center__meta div {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.session-center__meta dt {
  color: #64748b;
  font-size: 12px;
  font-weight: 600;
}

.session-center__meta dd {
  margin: 0;
  color: #0f172a;
  word-break: break-word;
}

.session-center__button {
  appearance: none;
  border: none;
  border-radius: 10px;
  padding: 10px 14px;
  background: #2563eb;
  color: #fff;
  font-weight: 600;
  cursor: pointer;
}

.session-center__button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.session-center__button--secondary {
  background: #e2e8f0;
  color: #0f172a;
}

@media (max-width: 720px) {
  .session-center {
    padding: 16px;
  }

  .session-center__header,
  .session-center__card-head {
    flex-direction: column;
  }

  .session-center__current {
    flex-direction: column;
    align-items: flex-start;
  }

  .session-center__actions {
    width: 100%;
    justify-content: space-between;
  }
}
</style>
