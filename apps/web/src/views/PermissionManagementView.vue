<template>
  <section class="permission-admin">
    <header class="permission-admin__header">
      <div>
        <h1>权限管理</h1>
        <p>查看权限目录，并对指定用户执行直接授予或回收。</p>
      </div>

      <div class="permission-admin__actions">
        <input
          v-model.trim="search"
          class="permission-admin__search"
          type="search"
          placeholder="搜索邮箱、姓名或用户 ID"
          @keyup.enter="void loadUsers()"
        >
        <button class="permission-admin__button permission-admin__button--secondary" type="button" :disabled="loading" @click="void loadAll()">
          {{ loading ? '加载中...' : '刷新' }}
        </button>
      </div>
    </header>

    <p v-if="status" class="permission-admin__status" :class="{ 'permission-admin__status--error': statusTone === 'error' }">
      {{ status }}
    </p>

    <div class="permission-admin__layout">
      <aside class="permission-admin__panel permission-admin__panel--users">
        <h2>用户列表</h2>
        <div v-if="users.length === 0" class="permission-admin__empty">暂无用户数据</div>
        <button
          v-for="user in users"
          :key="user.id"
          class="permission-admin__user"
          :class="{ 'permission-admin__user--active': selectedUserId === user.id }"
          type="button"
          @click="void selectUser(user.id)"
        >
          <strong>{{ user.name || user.email }}</strong>
          <span>{{ user.email }}</span>
          <small>{{ user.role }} · {{ user.is_active ? '启用' : '停用' }}</small>
        </button>
      </aside>

      <section class="permission-admin__panel permission-admin__panel--detail">
        <template v-if="selectedUser">
          <div class="permission-admin__detail-head">
            <div>
              <h2>{{ selectedUser.name || selectedUser.email }}</h2>
              <p>{{ selectedUser.email }}</p>
            </div>
            <div class="permission-admin__chips">
              <span class="permission-admin__chip">{{ selectedUser.role }}</span>
              <span class="permission-admin__chip" :class="{ 'permission-admin__chip--admin': selectedUserAccess?.isAdmin }">
                {{ selectedUserAccess?.isAdmin ? '管理员' : '普通用户' }}
              </span>
            </div>
          </div>

          <section class="permission-admin__section">
            <div class="permission-admin__section-head">
              <h3>已授予权限</h3>
              <span>{{ assignedPermissions.length }} 项</span>
            </div>
            <div class="permission-admin__chips">
              <span v-for="permission in assignedPermissions" :key="permission" class="permission-admin__chip permission-admin__chip--permission">
                {{ permission }}
              </span>
              <span v-if="assignedPermissions.length === 0" class="permission-admin__empty">暂无直接权限</span>
            </div>
          </section>

          <section class="permission-admin__section">
            <div class="permission-admin__section-head">
              <h3>权限模板</h3>
              <div class="permission-admin__role-actions">
                <select v-model="templateModeFilter" class="permission-admin__select">
                  <option value="">全部模式</option>
                  <option value="platform">platform</option>
                  <option value="attendance">attendance</option>
                  <option value="plm-workbench">plm-workbench</option>
                </select>
                <select v-model="selectedTemplateId" class="permission-admin__select">
                  <option value="">请选择模板</option>
                  <option v-for="template in permissionTemplates" :key="template.id" :value="template.id">
                    {{ template.name }} · {{ template.productMode }}
                  </option>
                </select>
                <button class="permission-admin__button" type="button" :disabled="busy || !selectedTemplateId" @click="void applyPermissionTemplate()">
                  按模板补齐
                </button>
              </div>
            </div>
            <div v-if="selectedTemplate" class="permission-admin__chips">
              <span class="permission-admin__chip">{{ selectedTemplate.productMode }}</span>
              <span v-if="selectedTemplate.roleId" class="permission-admin__chip">{{ selectedTemplate.roleId }}</span>
              <span v-for="permission in selectedTemplate.permissions" :key="`tpl-${permission}`" class="permission-admin__chip permission-admin__chip--permission">
                {{ permission }}
              </span>
            </div>
            <p v-if="selectedTemplate" class="permission-admin__hint">{{ selectedTemplate.description }}</p>
          </section>

          <section class="permission-admin__section">
            <div class="permission-admin__section-head">
              <h3>权限目录</h3>
              <div class="permission-admin__role-actions">
                <select v-model="selectedPermissionCode" class="permission-admin__select">
                  <option value="">请选择权限</option>
                  <option v-for="permission in permissions" :key="permission.code" :value="permission.code">
                    {{ permission.code }}
                  </option>
                </select>
                <button class="permission-admin__button" type="button" :disabled="busy || !selectedPermissionCode" @click="void grantPermission()">
                  授予
                </button>
                <button class="permission-admin__button permission-admin__button--secondary" type="button" :disabled="busy || !selectedPermissionCode" @click="void revokePermission()">
                  回收
                </button>
              </div>
            </div>

            <div class="permission-admin__catalog">
              <article v-for="permission in permissions" :key="permission.code" class="permission-admin__permission">
                <div>
                  <strong>{{ permission.code }}</strong>
                  <p>{{ permission.name }}</p>
                  <small>{{ permission.description || '无描述' }}</small>
                </div>
                <button
                  class="permission-admin__link"
                  type="button"
                  @click="selectedPermissionCode = permission.code"
                >
                  选择
                </button>
              </article>
            </div>
          </section>
        </template>

        <div v-else class="permission-admin__empty">请选择用户查看其权限状态</div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { apiFetch } from '../utils/api'

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

type PermissionCatalogItem = {
  code: string
  name: string
  description: string | null
}

type UserPermissionState = {
  userId: string
  permissions: string[]
  isAdmin: boolean
}

type PermissionTemplate = {
  id: string
  name: string
  description: string
  productMode: 'platform' | 'attendance' | 'plm-workbench'
  permissions: string[]
  presetId: string | null
  roleId: string | null
}

const loading = ref(false)
const busy = ref(false)
const status = ref('')
const statusTone = ref<'info' | 'error'>('info')
const search = ref('')
const users = ref<ManagedUser[]>([])
const permissions = ref<PermissionCatalogItem[]>([])
const permissionTemplates = ref<PermissionTemplate[]>([])
const selectedUserId = ref('')
const selectedPermissionCode = ref('')
const selectedTemplateId = ref('')
const templateModeFilter = ref<'' | 'platform' | 'attendance' | 'plm-workbench'>('')
const selectedUserAccess = ref<UserPermissionState | null>(null)

const selectedUser = computed(() => users.value.find((user) => user.id === selectedUserId.value) || null)
const assignedPermissions = computed(() => selectedUserAccess.value?.permissions || [])
const selectedTemplate = computed(() => permissionTemplates.value.find((template) => template.id === selectedTemplateId.value) || null)

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

async function loadUsers(): Promise<void> {
  const params = new URLSearchParams()
  if (search.value) params.set('q', search.value)
  const query = params.toString()
  const response = await apiFetch(`/api/admin/users${query ? `?${query}` : ''}`)
  const payload = await readJson(response)
  if (!response.ok || payload.ok !== true) {
    throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载用户失败'))
  }

  const data = payload.data as { items?: ManagedUser[] } | undefined
  users.value = Array.isArray(data?.items) ? data.items : []

  if (selectedUserId.value) {
    const exists = users.value.some((user) => user.id === selectedUserId.value)
    if (!exists) {
      selectedUserId.value = ''
      selectedUserAccess.value = null
    }
  }
}

async function loadPermissions(): Promise<void> {
  const [permissionsResponse, templatesResponse] = await Promise.all([
    apiFetch('/api/permissions'),
    apiFetch(`/api/admin/permission-templates${templateModeFilter.value ? `?mode=${encodeURIComponent(templateModeFilter.value)}` : ''}`),
  ])
  const [permissionsPayload, templatesPayload] = await Promise.all([
    readJson(permissionsResponse),
    readJson(templatesResponse),
  ])
  if (!permissionsResponse.ok) {
    throw new Error(String(permissionsPayload.error || '加载权限目录失败'))
  }
  if (!templatesResponse.ok) {
    throw new Error(String(templatesPayload.error || '加载权限模板失败'))
  }

  permissions.value = Array.isArray(permissionsPayload.data) ? permissionsPayload.data as PermissionCatalogItem[] : []
  permissionTemplates.value = Array.isArray(templatesPayload.data) ? templatesPayload.data as PermissionTemplate[] : []
  if (selectedTemplateId.value && !permissionTemplates.value.some((template) => template.id === selectedTemplateId.value)) {
    selectedTemplateId.value = ''
  }
}

async function loadUserAccess(userId: string): Promise<void> {
  const response = await apiFetch(`/api/permissions/user/${encodeURIComponent(userId)}`)
  const payload = await readJson(response)
  if (!response.ok) {
    throw new Error(String(payload.error || '加载用户权限失败'))
  }

  selectedUserAccess.value = {
    userId: String(payload.userId || userId),
    permissions: Array.isArray(payload.permissions) ? payload.permissions as string[] : [],
    isAdmin: Boolean(payload.isAdmin),
  }
}

async function loadAll(): Promise<void> {
  loading.value = true
  try {
    await Promise.all([loadUsers(), loadPermissions()])
    if (!selectedUserId.value && users.value.length > 0) {
      await selectUser(users.value[0].id)
    } else if (selectedUserId.value) {
      await loadUserAccess(selectedUserId.value)
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载权限管理数据失败', 'error')
  } finally {
    loading.value = false
  }
}

async function selectUser(userId: string): Promise<void> {
  selectedUserId.value = userId
  selectedPermissionCode.value = ''
  try {
    await loadUserAccess(userId)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载用户权限失败', 'error')
  }
}

async function mutatePermission(action: 'grant' | 'revoke'): Promise<void> {
  if (!selectedUserId.value || !selectedPermissionCode.value) return

  busy.value = true
  try {
    const response = await apiFetch(`/api/permissions/${action}`, {
      method: 'POST',
      body: JSON.stringify({
        userId: selectedUserId.value,
        permission: selectedPermissionCode.value,
      }),
    })
    const payload = await readJson(response)
    if (!response.ok) {
      throw new Error(String(payload.error || `${action} permission failed`))
    }

    await loadUserAccess(selectedUserId.value)
    setStatus(action === 'grant' ? '权限已授予' : '权限已回收')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '权限操作失败', 'error')
  } finally {
    busy.value = false
  }
}

async function applyPermissionTemplate(): Promise<void> {
  if (!selectedUserId.value || !selectedTemplateId.value) return

  busy.value = true
  try {
    const response = await apiFetch('/api/admin/permission-templates/apply', {
      method: 'POST',
      body: JSON.stringify({
        userId: selectedUserId.value,
        templateId: selectedTemplateId.value,
      }),
    })
    const payload = await readJson(response)
    if (!response.ok) {
      throw new Error(String(payload.error || '应用权限模板失败'))
    }

    selectedUserAccess.value = {
      userId: selectedUserId.value,
      permissions: Array.isArray(payload.permissions) ? payload.permissions as string[] : [],
      isAdmin: Boolean(payload.isAdmin),
    }
    setStatus(`已按模板 ${selectedTemplate.value?.name || selectedTemplateId.value} 补齐权限`)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '应用权限模板失败', 'error')
  } finally {
    busy.value = false
  }
}

async function grantPermission(): Promise<void> {
  await mutatePermission('grant')
}

async function revokePermission(): Promise<void> {
  await mutatePermission('revoke')
}

onMounted(async () => {
  await loadAll()
})

watch(templateModeFilter, () => {
  void loadPermissions().catch((error) => {
    setStatus(error instanceof Error ? error.message : '加载权限模板失败', 'error')
  })
})
</script>

<style scoped>
.permission-admin {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.permission-admin__header,
.permission-admin__detail-head,
.permission-admin__section-head,
.permission-admin__actions,
.permission-admin__role-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.permission-admin__layout {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 16px;
}

.permission-admin__panel {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 14px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.permission-admin__panel--users {
  max-height: calc(100vh - 180px);
  overflow: auto;
}

.permission-admin__user,
.permission-admin__permission {
  border: 1px solid #dbe3f0;
  border-radius: 12px;
  background: #fff;
  padding: 12px;
}

.permission-admin__user {
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 4px;
  cursor: pointer;
}

.permission-admin__user--active {
  border-color: #2563eb;
  background: #eff6ff;
}

.permission-admin__permission {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.permission-admin__catalog {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.permission-admin__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.permission-admin__chip {
  border-radius: 999px;
  padding: 6px 10px;
  background: #e2e8f0;
  color: #0f172a;
  font-size: 12px;
  font-weight: 600;
}

.permission-admin__chip--permission,
.permission-admin__chip--admin {
  background: #eff6ff;
  color: #1d4ed8;
}

.permission-admin__search,
.permission-admin__select {
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  padding: 10px 12px;
  font: inherit;
}

.permission-admin__button {
  border: none;
  border-radius: 10px;
  background: #2563eb;
  color: #fff;
  padding: 10px 14px;
  cursor: pointer;
  font: inherit;
}

.permission-admin__button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.permission-admin__button--secondary,
.permission-admin__link {
  background: #e2e8f0;
  color: #0f172a;
}

.permission-admin__link {
  border: none;
  border-radius: 10px;
  padding: 8px 12px;
  cursor: pointer;
  font: inherit;
}

.permission-admin__status {
  margin: 0;
  color: #1d4ed8;
}

.permission-admin__status--error {
  color: #dc2626;
}

.permission-admin__empty,
.permission-admin__permission p,
.permission-admin__permission small,
.permission-admin__user small {
  color: #64748b;
}

.permission-admin__hint {
  margin: 0;
  color: #64748b;
}

@media (max-width: 960px) {
  .permission-admin__layout {
    grid-template-columns: 1fr;
  }

  .permission-admin__detail-head,
  .permission-admin__section-head,
  .permission-admin__actions,
  .permission-admin__role-actions {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
