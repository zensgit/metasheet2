<template>
  <section class="delegation-page">
    <header class="delegation-page__header">
      <div>
        <h1>角色委派</h1>
        <p>插件管理员只能分配自己负责命名空间下的角色；平台管理员可作为兜底入口使用。</p>
      </div>
      <div class="delegation-page__actions">
        <router-link class="delegation-page__link" to="/admin/users">用户管理</router-link>
        <input
          v-model.trim="search"
          class="delegation-page__input"
          type="search"
          placeholder="搜索邮箱、姓名或用户 ID"
          @keyup.enter="void loadUsers()"
        />
        <button class="delegation-page__button" type="button" :disabled="loading" @click="void loadUsers()">
          {{ loading ? '加载中...' : '查询' }}
        </button>
      </div>
    </header>

    <p v-if="status" class="delegation-page__status" :class="{ 'delegation-page__status--error': statusTone === 'error' }">
      {{ status }}
    </p>

    <section class="delegation-page__panel">
      <div class="delegation-page__chips">
        <span class="delegation-page__chip" :class="{ 'delegation-page__chip--success': summary?.isPlatformAdmin }">
          {{ summary?.isPlatformAdmin ? '平台管理员模式' : '插件管理员模式' }}
        </span>
        <span v-for="namespace in summary?.delegableNamespaces || []" :key="namespace" class="delegation-page__chip">
          {{ namespace }}
        </span>
        <span v-if="summary && summary.delegableNamespaces.length === 0 && !summary.isPlatformAdmin" class="delegation-page__chip delegation-page__chip--danger">
          无可委派命名空间
        </span>
      </div>
    </section>

    <div class="delegation-page__layout">
      <aside class="delegation-page__panel">
        <h2>成员</h2>
        <div v-if="users.length === 0" class="delegation-page__empty">暂无成员</div>
        <button
          v-for="user in users"
          :key="user.id"
          class="delegation-page__user"
          :class="{ 'delegation-page__user--active': selectedUserId === user.id }"
          type="button"
          @click="void selectUser(user.id)"
        >
          <strong>{{ user.name || user.email }}</strong>
          <span>{{ user.email }}</span>
          <small>{{ user.role }} · {{ user.is_active ? '启用' : '停用' }}</small>
        </button>
      </aside>

      <section class="delegation-page__panel delegation-page__panel--detail">
        <template v-if="selectedAccess">
          <div class="delegation-page__detail-head">
            <div>
              <h2>{{ selectedAccess.user.name || selectedAccess.user.email }}</h2>
              <p>{{ selectedAccess.user.email }}</p>
            </div>
          </div>

          <div class="delegation-page__section">
            <h3>当前可委派角色</h3>
            <div class="delegation-page__chips">
              <span v-for="roleId in selectedAccess.delegableRoles" :key="roleId" class="delegation-page__chip delegation-page__chip--success">
                {{ roleId }}
              </span>
              <span v-if="selectedAccess.delegableRoles.length === 0" class="delegation-page__empty">未分配当前委派范围内的角色</span>
            </div>
          </div>

          <div class="delegation-page__section">
            <h3>委派操作</h3>
            <div class="delegation-page__role-actions">
              <select v-model="selectedRoleId" class="delegation-page__input">
                <option value="">请选择角色</option>
                <option v-for="role in selectedAccess.roleCatalog" :key="role.id" :value="role.id">
                  {{ role.name }} ({{ role.id }})
                </option>
              </select>
              <button class="delegation-page__button" type="button" :disabled="busy || !selectedRoleId" @click="void updateRole('assign')">
                分配角色
              </button>
              <button class="delegation-page__button delegation-page__button--secondary" type="button" :disabled="busy || !selectedRoleId" @click="void updateRole('unassign')">
                撤销角色
              </button>
            </div>
          </div>

          <div class="delegation-page__section">
            <h3>可委派角色目录</h3>
            <div class="delegation-page__role-list">
              <article v-for="role in selectedAccess.roleCatalog" :key="role.id" class="delegation-page__role-card">
                <strong>{{ role.name }}</strong>
                <span>{{ role.id }}</span>
                <p>{{ role.permissions.join(', ') || '无权限映射' }}</p>
              </article>
            </div>
          </div>
        </template>

        <div v-else class="delegation-page__empty">
          请选择一个成员
        </div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { apiFetch } from '../utils/api'

type ManagedUser = {
  id: string
  email: string
  name: string | null
  role: string
  is_active: boolean
}

type RoleCatalogItem = {
  id: string
  name: string
  permissions: string[]
}

type DelegationSummary = {
  actorId: string
  isPlatformAdmin: boolean
  delegableNamespaces: string[]
  roleCatalog: RoleCatalogItem[]
}

type DelegatedUserAccess = {
  actorId: string
  isPlatformAdmin: boolean
  delegableNamespaces: string[]
  roleCatalog: RoleCatalogItem[]
  user: ManagedUser
  roles: string[]
  delegableRoles: string[]
}

const loading = ref(false)
const busy = ref(false)
const status = ref('')
const statusTone = ref<'info' | 'error'>('info')
const search = ref('')
const users = ref<ManagedUser[]>([])
const selectedUserId = ref('')
const selectedRoleId = ref('')
const summary = ref<DelegationSummary | null>(null)
const selectedAccess = ref<DelegatedUserAccess | null>(null)

function setStatus(message: string, tone: 'info' | 'error' = 'info') {
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

async function loadSummary(): Promise<void> {
  const response = await apiFetch('/api/admin/role-delegation/summary')
  const payload = await readJson(response)
  if (!response.ok || payload.ok !== true) {
    throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载角色委派摘要失败'))
  }
  summary.value = payload.data as DelegationSummary
}

async function loadUsers(): Promise<void> {
  loading.value = true
  try {
    const params = new URLSearchParams()
    if (search.value) params.set('q', search.value)
    const response = await apiFetch(`/api/admin/role-delegation/users${params.size ? `?${params.toString()}` : ''}`)
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载成员失败'))
    }

    const data = payload.data as { items?: ManagedUser[] } | undefined
    users.value = Array.isArray(data?.items) ? data.items : []
    if (!selectedUserId.value && users.value.length > 0) {
      await selectUser(users.value[0].id)
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载成员失败', 'error')
  } finally {
    loading.value = false
  }
}

async function selectUser(userId: string): Promise<void> {
  selectedUserId.value = userId
  selectedRoleId.value = ''
  try {
    const response = await apiFetch(`/api/admin/role-delegation/users/${encodeURIComponent(userId)}/access`)
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载成员委派权限失败'))
    }

    selectedAccess.value = payload.data as DelegatedUserAccess
  } catch (error) {
    selectedAccess.value = null
    setStatus(error instanceof Error ? error.message : '加载成员委派权限失败', 'error')
  }
}

async function updateRole(action: 'assign' | 'unassign'): Promise<void> {
  if (!selectedUserId.value || !selectedRoleId.value) return
  busy.value = true
  try {
    const response = await apiFetch(`/api/admin/role-delegation/users/${encodeURIComponent(selectedUserId.value)}/roles/${action}`, {
      method: 'POST',
      body: JSON.stringify({ roleId: selectedRoleId.value }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '保存委派角色失败'))
    }

    selectedAccess.value = payload.data as DelegatedUserAccess
    setStatus(action === 'assign' ? '角色已分配' : '角色已撤销')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '保存委派角色失败', 'error')
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  try {
    await loadSummary()
    await loadUsers()
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载角色委派页面失败', 'error')
  }
})
</script>

<style scoped>
.delegation-page {
  display: grid;
  gap: 16px;
  padding: 24px;
}

.delegation-page__header,
.delegation-page__actions,
.delegation-page__detail-head,
.delegation-page__role-actions,
.delegation-page__chips,
.delegation-page__role-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.delegation-page__header,
.delegation-page__detail-head {
  justify-content: space-between;
  align-items: flex-start;
}

.delegation-page__header h1,
.delegation-page__panel h2,
.delegation-page__section h3 {
  margin: 0;
}

.delegation-page__header p,
.delegation-page__detail-head p,
.delegation-page__role-card span,
.delegation-page__role-card p,
.delegation-page__empty {
  margin: 4px 0 0;
  color: #6b7280;
}

.delegation-page__layout {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 16px;
}

.delegation-page__panel {
  display: grid;
  gap: 12px;
  padding: 16px;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  background: #fff;
}

.delegation-page__panel--detail {
  gap: 16px;
}

.delegation-page__user {
  display: grid;
  gap: 4px;
  width: 100%;
  text-align: left;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  background: #fff;
  padding: 12px;
  cursor: pointer;
}

.delegation-page__user--active {
  border-color: #2563eb;
  background: #eff6ff;
}

.delegation-page__input {
  min-width: 240px;
  height: 38px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 0 12px;
}

.delegation-page__button,
.delegation-page__link {
  height: 38px;
  border-radius: 8px;
}

.delegation-page__button {
  border: 0;
  background: #2563eb;
  color: #fff;
  padding: 0 14px;
  cursor: pointer;
}

.delegation-page__button--secondary {
  background: #475569;
}

.delegation-page__button:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.delegation-page__link {
  display: inline-flex;
  align-items: center;
  padding: 0 12px;
  color: #2563eb;
  text-decoration: none;
  font-weight: 600;
}

.delegation-page__status {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: #eff6ff;
  color: #1d4ed8;
}

.delegation-page__status--error {
  background: #fef2f2;
  color: #dc2626;
}

.delegation-page__chip {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  background: #f3f4f6;
  color: #111827;
  padding: 4px 10px;
  font-size: 12px;
}

.delegation-page__chip--success {
  background: #dcfce7;
  color: #166534;
}

.delegation-page__chip--danger {
  background: #fef2f2;
  color: #b91c1c;
}

.delegation-page__role-card {
  width: min(320px, 100%);
  display: grid;
  gap: 4px;
  padding: 12px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
}

@media (max-width: 960px) {
  .delegation-page__layout,
  .delegation-page__header {
    display: grid;
    grid-template-columns: 1fr;
  }
}
</style>
