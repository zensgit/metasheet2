<template>
  <section class="user-admin">
    <header class="user-admin__header">
      <div>
        <h1>用户管理</h1>
        <p>平台管理员可在此查看用户访问状态并分配角色。</p>
      </div>

      <div class="user-admin__actions">
        <router-link class="user-admin__link" to="/admin/roles">角色管理</router-link>
        <router-link class="user-admin__link" to="/admin/permissions">权限管理</router-link>
        <router-link class="user-admin__link" to="/admin/audit">管理审计</router-link>
        <input
          v-model.trim="search"
          class="user-admin__search"
          type="search"
          placeholder="搜索邮箱、姓名或用户 ID"
          @keyup.enter="void loadUsers()"
        />
        <button class="user-admin__button" type="button" :disabled="loading" @click="void loadUsers()">
          {{ loading ? '加载中...' : '查询' }}
        </button>
      </div>
    </header>

    <p v-if="!adminAllowed" class="user-admin__warning">
      当前账号不是平台管理员。页面可见，但后端接口会拒绝非管理员操作。
    </p>
    <p v-if="status" class="user-admin__status" :class="{ 'user-admin__status--error': statusTone === 'error' }">
      {{ status }}
    </p>

    <section class="user-admin__panel user-admin__panel--create">
      <div class="user-admin__section-head">
        <div>
          <h2>创建用户</h2>
          <p class="user-admin__hint">可选择自动生成临时密码，后续再在权限页补充直接权限。密码需至少 8 位，包含大小写字母和数字。</p>
        </div>
      </div>
      <div class="user-admin__create-grid">
        <input v-model.trim="createForm.name" class="user-admin__search" type="text" placeholder="姓名" />
        <input v-model.trim="createForm.email" class="user-admin__search" type="email" placeholder="邮箱" />
        <input v-model.trim="createForm.password" class="user-admin__search" type="text" placeholder="可选：初始密码" />
        <select v-model="presetModeFilter" class="user-admin__select">
          <option value="">预设模式（全部）</option>
          <option value="platform">platform</option>
          <option value="attendance">attendance</option>
          <option value="plm-workbench">plm-workbench</option>
        </select>
        <select v-model="createForm.presetId" class="user-admin__select">
          <option value="">选择访问预设（可选）</option>
          <option v-for="preset in filteredAccessPresets" :key="preset.id" :value="preset.id">
            {{ preset.name }} · {{ preset.productMode }}
          </option>
        </select>
        <input v-model.trim="createForm.role" class="user-admin__search" type="text" placeholder="显示角色，默认 user" />
        <select v-model="createForm.roleId" class="user-admin__select">
          <option value="">初始 RBAC 角色（可选）</option>
          <option v-for="role in roleCatalog" :key="role.id" :value="role.id">
            {{ role.name }} ({{ role.id }})
          </option>
        </select>
        <label class="user-admin__toggle">
          <input v-model="createForm.isActive" type="checkbox" />
          <span>创建后立即启用</span>
        </label>
      </div>
      <div class="user-admin__role-actions">
        <button class="user-admin__button" type="button" :disabled="busy" @click="void createUser()">
          创建用户
        </button>
        <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="!createdInviteMessage" @click="void copyInviteMessage()">
          复制邀请文案
        </button>
      </div>
      <p v-if="createdTemporaryPassword" class="user-admin__status">
        新用户临时密码：{{ createdTemporaryPassword }}
      </p>
      <div v-if="selectedPreset" class="user-admin__preset">
        <strong>{{ selectedPreset.name }}</strong>
        <p>{{ selectedPreset.description }}</p>
        <small>推荐入口：{{ selectedPreset.homePath }} · 权限：{{ selectedPreset.permissions.join(', ') }}</small>
      </div>
      <p v-if="createdOnboarding?.acceptInviteUrl" class="user-admin__hint">
        首次设置密码链接：
        <a :href="createdOnboarding.acceptInviteUrl" target="_blank" rel="noreferrer">{{ createdOnboarding.acceptInviteUrl }}</a>
      </p>
      <pre v-if="createdInviteMessage" class="user-admin__invite">{{ createdInviteMessage }}</pre>
    </section>

    <section class="user-admin__panel">
      <div class="user-admin__section-head">
        <div>
          <h2>邀请记录</h2>
          <p class="user-admin__hint">展示最近发出的邀请及其当前状态。</p>
        </div>
        <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="loadingInvites" @click="void loadInviteRecords(selectedUserId || undefined)">
          {{ loadingInvites ? '刷新中...' : '刷新邀请记录' }}
        </button>
      </div>
      <div v-if="inviteRecords.length === 0" class="user-admin__empty">暂无邀请记录</div>
      <div v-else class="user-admin__role-list">
        <article v-for="record in inviteRecords" :key="record.id" class="user-admin__role-card">
          <strong>{{ record.userName || record.email }}</strong>
          <span>{{ record.email }}</span>
          <small>{{ record.productMode }} · {{ record.status }} · 创建于 {{ formatDate(record.createdAt) }}</small>
          <p>最近发送：{{ formatDate(record.lastSentAt) }}</p>
          <p v-if="record.acceptedAt">接受时间：{{ formatDate(record.acceptedAt) }}</p>
          <a :href="buildInviteUrl(record.inviteToken)" target="_blank" rel="noreferrer">打开邀请链接</a>
          <button
            v-if="record.status !== 'accepted'"
            class="user-admin__button user-admin__button--secondary"
            type="button"
            :disabled="busy || loadingInvites"
            @click="void resendInvite(record)"
          >
            重发邀请
          </button>
          <button
            v-if="record.status === 'pending'"
            class="user-admin__button user-admin__button--secondary"
            type="button"
            :disabled="busy || loadingInvites"
            @click="void revokeInvite(record)"
          >
            撤销邀请
          </button>
        </article>
      </div>
    </section>

    <section class="user-admin__panel user-admin__panel--batch">
      <div class="user-admin__section-head">
        <div>
          <h2>批量操作</h2>
          <p class="user-admin__hint">对待审核用户（未启用且状态为 pending）进行批量审批或拒绝。</p>
        </div>
        <button class="user-admin__button user-admin__button--secondary" type="button" @click="batchExpanded = !batchExpanded">
          {{ batchExpanded ? '收起' : '展开' }}
        </button>
      </div>
      <template v-if="batchExpanded">
        <div v-if="pendingUsers.length === 0" class="user-admin__empty">暂无待审核用户</div>
        <template v-else>
          <div class="user-admin__batch-select-all">
            <label class="user-admin__toggle">
              <input type="checkbox" :checked="allPendingSelected" @change="toggleAllPending" />
              <span>全选待审核用户（{{ pendingUsers.length }}）</span>
            </label>
          </div>
          <div class="user-admin__batch-list">
            <label v-for="user in pendingUsers" :key="user.id" class="user-admin__batch-item">
              <input
                type="checkbox"
                :checked="batchSelectedIds.has(user.id)"
                @change="toggleBatchUser(user.id)"
              />
              <span>{{ user.name || user.email }} ({{ user.email }})</span>
            </label>
          </div>
          <div class="user-admin__batch-reason">
            <input
              v-model.trim="batchReason"
              class="user-admin__search"
              type="text"
              placeholder="可选：操作原因"
            />
          </div>
          <div class="user-admin__role-actions">
            <button
              class="user-admin__button"
              type="button"
              :disabled="batchBusy || batchSelectedIds.size === 0"
              @click="void executeBatchAction('approve')"
            >
              {{ batchBusy ? '处理中...' : `批量通过 (${batchSelectedIds.size})` }}
            </button>
            <button
              class="user-admin__button user-admin__button--secondary"
              type="button"
              :disabled="batchBusy || batchSelectedIds.size === 0"
              @click="void executeBatchAction('reject')"
            >
              {{ batchBusy ? '处理中...' : `批量拒绝 (${batchSelectedIds.size})` }}
            </button>
          </div>
          <p v-if="batchResult" class="user-admin__status" :class="{ 'user-admin__status--error': batchResultTone === 'error' }">
            {{ batchResult }}
          </p>
        </template>
      </template>
    </section>

    <div class="user-admin__layout">
      <aside class="user-admin__panel">
        <h2>用户列表</h2>
        <div v-if="users.length === 0" class="user-admin__empty">暂无用户数据</div>
        <button
          v-for="user in users"
          :key="user.id"
          class="user-admin__user"
          :class="{ 'user-admin__user--active': selectedUserId === user.id }"
          type="button"
          @click="void selectUser(user.id)"
        >
          <strong>{{ user.name || user.email }}</strong>
          <span>{{ user.email }}</span>
          <span class="user-admin__meta">{{ user.role }} · {{ user.is_active ? '启用' : '停用' }}</span>
        </button>
      </aside>

      <section class="user-admin__panel user-admin__panel--detail">
        <template v-if="access">
          <div class="user-admin__detail-head">
            <div>
              <h2>{{ access.user.name || access.user.email }}</h2>
              <p>{{ access.user.email }}</p>
            </div>
            <div class="user-admin__badges">
              <span class="user-admin__badge">{{ access.user.role }}</span>
              <span class="user-admin__badge" :class="{ 'user-admin__badge--inactive': !access.user.is_active }">
                {{ access.user.is_active ? '已启用' : '已停用' }}
              </span>
              <span class="user-admin__badge" :class="{ 'user-admin__badge--admin': access.isAdmin }">
                {{ access.isAdmin ? '管理员' : '普通用户' }}
              </span>
            </div>
          </div>

          <div class="user-admin__section">
            <h3>角色</h3>
            <div class="user-admin__chips">
              <span v-for="role in access.roles" :key="role" class="user-admin__chip">
                {{ role }}
              </span>
              <span v-if="access.roles.length === 0" class="user-admin__empty">未分配角色</span>
            </div>
          </div>

          <div class="user-admin__section">
            <h3>权限</h3>
            <div class="user-admin__chips">
              <span v-for="permission in access.permissions" :key="permission" class="user-admin__chip user-admin__chip--permission">
                {{ permission }}
              </span>
              <span v-if="access.permissions.length === 0" class="user-admin__empty">未授予额外权限</span>
            </div>
          </div>

          <div class="user-admin__section">
            <h3>账号操作</h3>
            <div class="user-admin__role-actions">
              <button class="user-admin__button" type="button" :disabled="busy" @click="void toggleUserStatus()">
                {{ access.user.is_active ? '停用账号' : '启用账号' }}
              </button>
              <input
                v-model.trim="manualPassword"
                class="user-admin__search"
                type="text"
                placeholder="可选：设置临时密码"
              />
              <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="busy" @click="void resetPassword()">
                重置密码
              </button>
              <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="busy" @click="void revokeSessions()">
                全部下线
              </button>
            </div>
            <p class="user-admin__hint">重置密码或停用账号会让该用户的现有会话失效。</p>
            <p v-if="temporaryPassword" class="user-admin__status">
              临时密码：{{ temporaryPassword }}
            </p>
          </div>

          <div class="user-admin__section">
            <div class="user-admin__section-head">
              <div>
                <h3>会话</h3>
                <p class="user-admin__hint">支持按单会话踢下线，避免一刀切影响全部设备。</p>
              </div>
              <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="loadingSessions" @click="void loadUserSessions(access.user.id)">
                {{ loadingSessions ? '刷新中...' : '刷新会话' }}
              </button>
            </div>
            <div v-if="userSessions.length === 0" class="user-admin__empty">暂无活动会话</div>
            <div v-else class="user-admin__role-list">
              <article v-for="session in userSessions" :key="session.id" class="user-admin__role-card">
                <strong>{{ session.id }}</strong>
                <small>签发：{{ formatDate(session.issuedAt) }}</small>
                <small>过期：{{ formatDate(session.expiresAt) }}</small>
                <small>最近活跃：{{ formatDate(session.lastSeenAt) }}</small>
                <small v-if="session.ipAddress">IP：{{ session.ipAddress }}</small>
                <small v-if="session.userAgent">UA：{{ session.userAgent }}</small>
                <small v-if="session.revokedAt">已撤销：{{ formatDate(session.revokedAt) }}</small>
                <button
                  v-if="!session.revokedAt"
                  class="user-admin__button user-admin__button--secondary"
                  type="button"
                  :disabled="busy || loadingSessions"
                  @click="void revokeSingleSession(session.id)"
                >
                  踢下线
                </button>
              </article>
            </div>
          </div>

          <div class="user-admin__section">
            <h3>角色操作</h3>
            <div class="user-admin__role-actions">
              <select v-model="selectedRoleId" class="user-admin__select">
                <option value="">请选择角色</option>
                <option v-for="role in roleCatalog" :key="role.id" :value="role.id">
                  {{ role.name }} ({{ role.id }})
                </option>
              </select>
              <button class="user-admin__button" type="button" :disabled="busy || !selectedRoleId" @click="void assignRole()">
                分配角色
              </button>
              <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="busy || !selectedRoleId" @click="void unassignRole()">
                撤销角色
              </button>
            </div>
          </div>

          <div class="user-admin__section">
            <h3>角色目录</h3>
            <div class="user-admin__role-list">
              <article v-for="role in roleCatalog" :key="role.id" class="user-admin__role-card">
                <strong>{{ role.name }}</strong>
                <span>{{ role.id }}</span>
                <small>成员数：{{ role.memberCount }}</small>
                <p>{{ role.permissions.join(', ') || '无权限映射' }}</p>
              </article>
            </div>
          </div>
        </template>

        <div v-else class="user-admin__empty">
          请选择一个用户查看访问详情
        </div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useAuth } from '../composables/useAuth'
import { apiFetch } from '../utils/api'
import { readErrorMessage } from '../utils/error'
import { parseUserSessionRecord } from '../utils/session'
import type { UserSessionRecord } from '../utils/session'

type ManagedUser = {
  id: string
  email: string
  name: string | null
  role: string
  is_active: boolean
  is_admin: boolean
  last_login_at: string | null
  created_at: string
}

type RoleCatalogItem = {
  id: string
  name: string
  permissions: string[]
  memberCount: number
}

type UserAccess = {
  user: ManagedUser
  roles: string[]
  permissions: string[]
  isAdmin: boolean
}

type CreateUserForm = {
  name: string
  email: string
  password: string
  presetId: string
  role: string
  roleId: string
  isActive: boolean
}

type AccessPreset = {
  id: string
  name: string
  description: string
  productMode: 'platform' | 'attendance' | 'plm-workbench'
  role: string
  roleId?: string
  permissions: string[]
  homePath: string
  welcomeTitle: string
  checklist: string[]
}

type OnboardingPacket = {
  presetId: string | null
  productMode: 'platform' | 'attendance' | 'plm-workbench'
  homePath: string
  loginPath: string
  loginUrl: string
  acceptInvitePath: string
  acceptInviteUrl: string
  welcomeTitle: string
  checklist: string[]
  inviteMessage: string
}

type InviteLedgerRecord = {
  id: string
  userId: string
  email: string
  userName: string | null
  presetId: string | null
  productMode: 'platform' | 'attendance' | 'plm-workbench'
  roleId: string | null
  invitedByEmail: string | null
  invitedByName: string | null
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  acceptedAt: string | null
  inviteToken: string
  lastSentAt: string
  createdAt: string
}

const { hasAdminAccess } = useAuth()

const adminAllowed = hasAdminAccess()
const loading = ref(false)
const loadingInvites = ref(false)
const loadingSessions = ref(false)
const busy = ref(false)
const status = ref('')
const statusTone = ref<'info' | 'error'>('info')
const search = ref('')
const users = ref<ManagedUser[]>([])
const roleCatalog = ref<RoleCatalogItem[]>([])
const accessPresets = ref<AccessPreset[]>([])
const presetModeFilter = ref<'' | 'platform' | 'attendance' | 'plm-workbench'>('')
const selectedUserId = ref('')
const selectedRoleId = ref('')
const manualPassword = ref('')
const temporaryPassword = ref('')
const createdTemporaryPassword = ref('')
const createdInviteMessage = ref('')
const createdOnboarding = ref<OnboardingPacket | null>(null)
const inviteRecords = ref<InviteLedgerRecord[]>([])
const userSessions = ref<UserSessionRecord[]>([])
const access = ref<UserAccess | null>(null)
const createForm = ref<CreateUserForm>({
  name: '',
  email: '',
  password: '',
  presetId: '',
  role: 'user',
  roleId: '',
  isActive: true,
})
const batchExpanded = ref(false)
const batchBusy = ref(false)
const batchSelectedIds = ref<Set<string>>(new Set())
const batchReason = ref('')
const batchResult = ref('')
const batchResultTone = ref<'info' | 'error'>('info')

const pendingUsers = computed(() => users.value.filter((user) => !user.is_active))
const allPendingSelected = computed(() => pendingUsers.value.length > 0 && pendingUsers.value.every((user) => batchSelectedIds.value.has(user.id)))

function toggleBatchUser(userId: string): void {
  const next = new Set(batchSelectedIds.value)
  if (next.has(userId)) {
    next.delete(userId)
  } else {
    next.add(userId)
  }
  batchSelectedIds.value = next
}

function toggleAllPending(): void {
  if (allPendingSelected.value) {
    batchSelectedIds.value = new Set()
  } else {
    batchSelectedIds.value = new Set(pendingUsers.value.map((user) => user.id))
  }
}

async function executeBatchAction(action: 'approve' | 'reject'): Promise<void> {
  if (batchSelectedIds.value.size === 0) return
  batchBusy.value = true
  batchResult.value = ''
  try {
    const response = await apiFetch('/api/admin/users/batch', {
      method: 'POST',
      body: JSON.stringify({
        action,
        userIds: Array.from(batchSelectedIds.value),
        reason: batchReason.value || undefined,
      }),
    })
    const payload = await readJson(response)
    if (!response.ok) {
      throw new Error(readErrorMessage(payload, '批量操作失败'))
    }
    const data = (payload.data ?? payload) as Record<string, unknown>
    const processed = typeof data.processed === 'number' ? data.processed : 0
    const failed = typeof data.failed === 'number' ? data.failed : 0
    const actionLabel = action === 'approve' ? '通过' : '拒绝'
    batchResult.value = `批量${actionLabel}完成：已处理 ${processed} 个用户，失败 ${failed} 个`
    batchResultTone.value = failed > 0 ? 'error' : 'info'
    batchSelectedIds.value = new Set()
    batchReason.value = ''
    await loadUsers()
  } catch (error) {
    batchResult.value = readErrorMessage(error, '批量操作失败')
    batchResultTone.value = 'error'
  } finally {
    batchBusy.value = false
  }
}

const selectedPreset = computed(() => accessPresets.value.find((preset) => preset.id === createForm.value.presetId) || null)
const filteredAccessPresets = computed(() => {
  return accessPresets.value.filter((preset) => !presetModeFilter.value || preset.productMode === presetModeFilter.value)
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

function buildInviteUrl(token: string): string {
  if (createdOnboarding.value?.acceptInviteUrl) {
    try {
      const url = new URL(createdOnboarding.value.acceptInviteUrl)
      url.searchParams.set('token', token)
      return url.toString()
    } catch {
      // ignore and fall back
    }
  }
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}/accept-invite?token=${encodeURIComponent(token)}`
  }
  return `/accept-invite?token=${encodeURIComponent(token)}`
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>
  } catch {
    return {}
  }
}

async function loadUsers(): Promise<void> {
  loading.value = true
  try {
    const params = new URLSearchParams()
    if (search.value) params.set('q', search.value)
    const query = params.toString()
    const response = await apiFetch(`/api/admin/users${query ? `?${query}` : ''}`)
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(readErrorMessage(payload, '加载用户失败'))
    }

    const data = payload.data as { items?: ManagedUser[] } | undefined
    users.value = Array.isArray(data?.items) ? data.items : []

    if (!selectedUserId.value && users.value.length > 0) {
      await selectUser(users.value[0].id)
    }
  } catch (error) {
    setStatus(readErrorMessage(error, '加载用户失败'), 'error')
  } finally {
    loading.value = false
  }
}

async function loadRoles(): Promise<void> {
  try {
    const response = await apiFetch('/api/admin/roles')
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(readErrorMessage(payload, '加载角色失败'))
    }

    const data = payload.data as { items?: RoleCatalogItem[] } | undefined
    roleCatalog.value = Array.isArray(data?.items) ? data.items : []
  } catch (error) {
    setStatus(readErrorMessage(error, '加载角色失败'), 'error')
  }
}

async function loadAccessPresets(): Promise<void> {
  try {
    const params = new URLSearchParams()
    if (presetModeFilter.value) params.set('mode', presetModeFilter.value)
    const response = await apiFetch(`/api/admin/access-presets${params.size ? `?${params.toString()}` : ''}`)
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(readErrorMessage(payload, '加载访问预设失败'))
    }

    const data = payload.data as { items?: AccessPreset[] } | undefined
    accessPresets.value = Array.isArray(data?.items) ? data.items : []
  } catch (error) {
    setStatus(readErrorMessage(error, '加载访问预设失败'), 'error')
  }
}

async function loadInviteRecords(userId?: string): Promise<void> {
  loadingInvites.value = true
  try {
    const params = new URLSearchParams({ page: '1', pageSize: '10' })
    if (userId) params.set('userId', userId)
    const response = await apiFetch(`/api/admin/invites?${params.toString()}`)
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(readErrorMessage(payload, '加载邀请记录失败'))
    }

    const data = payload.data as { items?: Array<Record<string, unknown>> } | undefined
    inviteRecords.value = Array.isArray(data?.items)
      ? data.items.map((item) => ({
          id: String(item.id || ''),
          userId: String(item.user_id || item.userId || ''),
          email: String(item.email || ''),
          userName: typeof item.user_name === 'string' ? item.user_name : typeof item.userName === 'string' ? item.userName : null,
          presetId: typeof item.preset_id === 'string' ? item.preset_id : typeof item.presetId === 'string' ? item.presetId : null,
          productMode: (item.product_mode || item.productMode || 'platform') as InviteLedgerRecord['productMode'],
          roleId: typeof item.role_id === 'string' ? item.role_id : typeof item.roleId === 'string' ? item.roleId : null,
          invitedByEmail: typeof item.invited_by_email === 'string' ? item.invited_by_email : typeof item.invitedByEmail === 'string' ? item.invitedByEmail : null,
          invitedByName: typeof item.invited_by_name === 'string' ? item.invited_by_name : typeof item.invitedByName === 'string' ? item.invitedByName : null,
          status: (item.status || 'pending') as InviteLedgerRecord['status'],
          acceptedAt: typeof item.accepted_at === 'string' ? item.accepted_at : typeof item.acceptedAt === 'string' ? item.acceptedAt : null,
          inviteToken: String(item.invite_token || item.inviteToken || ''),
          lastSentAt: String(item.last_sent_at || item.lastSentAt || item.created_at || item.createdAt || ''),
          createdAt: String(item.created_at || item.createdAt || ''),
        }))
      : []
  } catch (error) {
    setStatus(readErrorMessage(error, '加载邀请记录失败'), 'error')
  } finally {
    loadingInvites.value = false
  }
}

async function loadUserSessions(userId?: string): Promise<void> {
  if (!userId) {
    userSessions.value = []
    return
  }

  loadingSessions.value = true
  try {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}/sessions`)
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(readErrorMessage(payload, '加载用户会话失败'))
    }

    const data = payload.data as { items?: Array<Record<string, unknown>> } | undefined
    userSessions.value = Array.isArray(data?.items)
      ? data.items
          .map(parseUserSessionRecord)
          .filter((session): session is UserSessionRecord => session !== null)
      : []
  } catch (error) {
    setStatus(readErrorMessage(error, '加载用户会话失败'), 'error')
  } finally {
    loadingSessions.value = false
  }
}

async function selectUser(userId: string): Promise<void> {
  selectedUserId.value = userId
  selectedRoleId.value = ''
  manualPassword.value = ''
  temporaryPassword.value = ''
  createdTemporaryPassword.value = ''
  try {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}/access`)
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(readErrorMessage(payload, '加载用户权限失败'))
    }

    access.value = payload.data as UserAccess
    await Promise.all([loadInviteRecords(userId), loadUserSessions(userId)])
  } catch (error) {
    setStatus(readErrorMessage(error, '加载用户权限失败'), 'error')
  }
}

async function createUser(): Promise<void> {
  busy.value = true
  createdTemporaryPassword.value = ''
  createdInviteMessage.value = ''
  createdOnboarding.value = null
  try {
    const response = await apiFetch('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        name: createForm.value.name,
        email: createForm.value.email,
        password: createForm.value.password || undefined,
        presetId: createForm.value.presetId || undefined,
        role: createForm.value.role || undefined,
        roleId: createForm.value.roleId || undefined,
        isActive: createForm.value.isActive,
      }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      const errorPayload = payload.error as Record<string, unknown> | undefined
      const detailText = Array.isArray(errorPayload?.details) ? `：${(errorPayload?.details as string[]).join('；')}` : ''
      throw new Error(readErrorMessage(payload, '创建用户失败') + detailText)
    }

    access.value = payload.data as UserAccess
    selectedUserId.value = access.value.user.id
    createdTemporaryPassword.value = String((payload.data as Record<string, unknown>).temporaryPassword || '')
    createdOnboarding.value = ((payload.data as Record<string, unknown>).onboarding as OnboardingPacket | undefined) || null
    createdInviteMessage.value = String(createdOnboarding.value?.inviteMessage || '')
    createForm.value = {
      name: '',
      email: '',
      password: '',
      presetId: '',
      role: 'user',
      roleId: '',
      isActive: true,
    }
    presetModeFilter.value = ''
    await Promise.all([loadUsers(), loadInviteRecords(access.value?.user.id)])
    setStatus('用户已创建')
  } catch (error) {
    setStatus(readErrorMessage(error, '创建用户失败'), 'error')
  } finally {
    busy.value = false
  }
}

async function revokeInvite(record: InviteLedgerRecord): Promise<void> {
  busy.value = true
  try {
    const response = await apiFetch(`/api/admin/invites/${encodeURIComponent(record.id)}/revoke`, {
      method: 'POST',
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(readErrorMessage(payload, '撤销邀请失败'))
    }

    await loadInviteRecords(selectedUserId.value || undefined)
    setStatus(`邀请已撤销：${record.email}`)
  } catch (error) {
    setStatus(readErrorMessage(error, '撤销邀请失败'), 'error')
  } finally {
    busy.value = false
  }
}

async function resendInvite(record: InviteLedgerRecord): Promise<void> {
  busy.value = true
  try {
    const response = await apiFetch(`/api/admin/invites/${encodeURIComponent(record.id)}/resend`, {
      method: 'POST',
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(readErrorMessage(payload, '重发邀请失败'))
    }

    const data = payload.data as Record<string, unknown>
    createdOnboarding.value = (data.onboarding as OnboardingPacket | undefined) || null
    createdInviteMessage.value = String(createdOnboarding.value?.inviteMessage || '')
    await loadInviteRecords(selectedUserId.value || undefined)
    setStatus(`邀请已重发：${record.email}`)
  } catch (error) {
    setStatus(readErrorMessage(error, '重发邀请失败'), 'error')
  } finally {
    busy.value = false
  }
}

async function copyInviteMessage(): Promise<void> {
  if (!createdInviteMessage.value) return
  try {
    await navigator.clipboard.writeText(createdInviteMessage.value)
    setStatus('邀请文案已复制')
  } catch (error) {
    setStatus(readErrorMessage(error, '复制邀请文案失败'), 'error')
  }
}

watch(selectedPreset, (preset) => {
  if (!preset) return
  createForm.value.role = preset.role
  createForm.value.roleId = preset.roleId || ''
})

watch(presetModeFilter, async () => {
  await loadAccessPresets()
  if (createForm.value.presetId && !accessPresets.value.some((preset) => preset.id === createForm.value.presetId)) {
    createForm.value.presetId = ''
  }
})

async function toggleUserStatus(): Promise<void> {
  if (!access.value) return
  busy.value = true
  try {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(access.value.user.id)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: !access.value.user.is_active }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(readErrorMessage(payload, '更新用户状态失败'))
    }

    access.value = payload.data as UserAccess
    await loadUsers()
    setStatus(access.value.user.is_active ? '账号已启用' : '账号已停用')
  } catch (error) {
    setStatus(readErrorMessage(error, '更新用户状态失败'), 'error')
  } finally {
    busy.value = false
  }
}

async function resetPassword(): Promise<void> {
  if (!access.value) return
  busy.value = true
  try {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(access.value.user.id)}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({
        password: manualPassword.value || undefined,
      }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(readErrorMessage(payload, '重置密码失败'))
    }

    temporaryPassword.value = String((payload.data as Record<string, unknown> | undefined)?.temporaryPassword || '')
    manualPassword.value = ''
    setStatus('密码已重置')
  } catch (error) {
    setStatus(readErrorMessage(error, '重置密码失败'), 'error')
  } finally {
    busy.value = false
  }
}

async function revokeSessions(): Promise<void> {
  if (!access.value) return
  busy.value = true
  try {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(access.value.user.id)}/revoke-sessions`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'admin-console-force-logout' }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(readErrorMessage(payload, '强制下线失败'))
    }

    const data = payload.data as Record<string, unknown> | undefined
    const revokedAfter = typeof data?.revokedAfter === 'string' ? data.revokedAfter : null
    if (revokedAfter) {
      setStatus(`该用户会话已失效（截止：${formatDate(revokedAfter)}）`)
    } else {
      setStatus('该用户现有会话已失效')
    }
    await loadUserSessions(access.value.user.id)
  } catch (error) {
    setStatus(readErrorMessage(error, '强制下线失败'), 'error')
  } finally {
    busy.value = false
  }
}

async function revokeSingleSession(sessionId: string): Promise<void> {
  if (!access.value) return
  busy.value = true
  try {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(access.value.user.id)}/sessions/${encodeURIComponent(sessionId)}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'admin-console-force-single-session-logout' }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(readErrorMessage(payload, '踢下线失败'))
    }

    const data = payload.data as Record<string, unknown> | undefined
    const revokedAt = typeof data?.revokedAt === 'string' ? data.revokedAt : null
    if (revokedAt) {
      setStatus(`会话已踢下线（${formatDate(revokedAt)}）`)
    } else {
      setStatus('会话已踢下线')
    }
    await loadUserSessions(access.value.user.id)
  } catch (error) {
    setStatus(readErrorMessage(error, '踢下线失败'), 'error')
  } finally {
    busy.value = false
  }
}

async function updateRole(action: 'assign' | 'unassign'): Promise<void> {
  if (!selectedUserId.value || !selectedRoleId.value) return
  busy.value = true
  try {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(selectedUserId.value)}/roles/${action}`, {
      method: 'POST',
      body: JSON.stringify({ roleId: selectedRoleId.value }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(readErrorMessage(payload, '保存角色失败'))
    }

    access.value = payload.data as UserAccess
    await loadUsers()
    setStatus(action === 'assign' ? '角色已分配' : '角色已撤销')
  } catch (error) {
    setStatus(readErrorMessage(error, '保存角色失败'), 'error')
  } finally {
    busy.value = false
  }
}

async function assignRole(): Promise<void> {
  await updateRole('assign')
}

async function unassignRole(): Promise<void> {
  await updateRole('unassign')
}

onMounted(async () => {
  await Promise.all([loadRoles(), loadUsers(), loadAccessPresets(), loadInviteRecords()])
})
</script>

<style scoped>
.user-admin {
  display: grid;
  gap: 16px;
  padding: 24px;
}

.user-admin__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.user-admin__header h1 {
  margin: 0 0 4px;
  font-size: 24px;
}

.user-admin__header p {
  margin: 0;
  color: #6b7280;
}

.user-admin__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.user-admin__link {
  color: #2563eb;
  text-decoration: none;
  font-weight: 600;
}

.user-admin__link:hover {
  text-decoration: underline;
}

.user-admin__search,
.user-admin__select {
  min-width: 240px;
  height: 38px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 0 12px;
}

.user-admin__button {
  height: 38px;
  border: 0;
  border-radius: 8px;
  background: #2563eb;
  color: #fff;
  padding: 0 14px;
  cursor: pointer;
}

.user-admin__button:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}

.user-admin__button--secondary {
  background: #475569;
}

.user-admin__hint {
  margin: 4px 0 0;
  color: #6b7280;
  font-size: 13px;
}

.user-admin__warning,
.user-admin__status {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: #eff6ff;
  color: #1d4ed8;
}

.user-admin__status--error {
  background: #fef2f2;
  color: #dc2626;
}

.user-admin__layout {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 16px;
  min-height: 520px;
}

.user-admin__panel--create {
  gap: 16px;
}

.user-admin__preset,
.user-admin__invite {
  margin: 0;
  padding: 12px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  background: #f8fafc;
  color: #334155;
}

.user-admin__preset p,
.user-admin__preset small {
  margin: 4px 0 0;
  display: block;
}

.user-admin__invite {
  white-space: pre-wrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
  font-size: 12px;
}

.user-admin__panel {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 16px;
  display: grid;
  gap: 12px;
  align-content: start;
}

.user-admin__panel h2,
.user-admin__section h3 {
  margin: 0;
}

.user-admin__section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.user-admin__panel--detail {
  gap: 16px;
}

.user-admin__user {
  display: grid;
  gap: 4px;
  text-align: left;
  width: 100%;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  background: #fff;
  padding: 12px;
  cursor: pointer;
}

.user-admin__user--active {
  border-color: #2563eb;
  background: #eff6ff;
}

.user-admin__meta {
  color: #6b7280;
  font-size: 12px;
}

.user-admin__detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.user-admin__detail-head p {
  margin: 4px 0 0;
  color: #6b7280;
}

.user-admin__create-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.user-admin__badges,
.user-admin__chips,
.user-admin__role-actions,
.user-admin__role-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.user-admin__badge,
.user-admin__chip {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  background: #f3f4f6;
  color: #111827;
  padding: 4px 10px;
  font-size: 12px;
}

.user-admin__toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  color: #374151;
}

.user-admin__badge--admin {
  background: #dbeafe;
  color: #1d4ed8;
}

.user-admin__badge--inactive {
  background: #fef2f2;
  color: #b91c1c;
}

.user-admin__chip--permission {
  background: #ecfeff;
  color: #155e75;
}

.user-admin__role-card {
  width: min(280px, 100%);
  display: grid;
  gap: 4px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 12px;
}

.user-admin__role-card span,
.user-admin__role-card small,
.user-admin__role-card p,
.user-admin__empty {
  color: #6b7280;
}

.user-admin__role-card p {
  margin: 0;
}

.user-admin__panel--batch {
  gap: 12px;
}

.user-admin__batch-select-all {
  padding: 8px 0;
  border-bottom: 1px solid #e5e7eb;
}

.user-admin__batch-list {
  display: grid;
  gap: 6px;
  max-height: 240px;
  overflow-y: auto;
  padding: 8px 0;
}

.user-admin__batch-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  color: #374151;
}

.user-admin__batch-item:hover {
  background: #f3f4f6;
}

.user-admin__batch-reason {
  padding: 4px 0;
}

@media (max-width: 960px) {
  .user-admin__header,
  .user-admin__layout {
    display: grid;
    grid-template-columns: 1fr;
  }

  .user-admin__create-grid {
    grid-template-columns: 1fr;
  }

  .user-admin__actions {
    flex-wrap: wrap;
  }
}
</style>
