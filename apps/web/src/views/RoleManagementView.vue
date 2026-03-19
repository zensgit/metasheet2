<template>
  <section class="admin-page">
    <header class="admin-page__header">
      <div>
        <h1>角色管理</h1>
        <p>维护平台角色及其权限映射，供用户管理与业务模块复用。</p>
      </div>

      <div class="admin-page__actions">
        <button class="admin-page__button admin-page__button--secondary" type="button" :disabled="loading" @click="void loadCatalog()">
          {{ loading ? '加载中...' : '刷新' }}
        </button>
        <button class="admin-page__button" type="button" @click="resetForm()">新建角色</button>
      </div>
    </header>

    <p v-if="status" class="admin-page__status" :class="{ 'admin-page__status--error': statusTone === 'error' }">
      {{ status }}
    </p>

    <div class="admin-page__layout">
      <aside class="admin-page__panel admin-page__panel--list">
        <h2>角色目录</h2>
        <div v-if="roles.length === 0" class="admin-page__empty">暂无角色数据</div>
        <button
          v-for="role in roles"
          :key="role.id"
          class="admin-page__item"
          :class="{ 'admin-page__item--active': selectedRoleId === role.id }"
          type="button"
          @click="selectRole(role)"
        >
          <strong>{{ role.name }}</strong>
          <span>{{ role.id }}</span>
          <small>成员数：{{ role.memberCount }}</small>
        </button>
      </aside>

      <section class="admin-page__panel admin-page__panel--detail">
        <div class="admin-page__form-grid">
          <label class="admin-page__field">
            <span>角色 ID</span>
            <input v-model.trim="draftRoleId" class="admin-page__input" type="text" placeholder="例如 attendance_admin" :disabled="isEditing">
          </label>
          <label class="admin-page__field">
            <span>角色名称</span>
            <input v-model.trim="draftRoleName" class="admin-page__input" type="text" placeholder="例如 Attendance Admin">
          </label>
        </div>

        <section class="admin-page__section">
          <div class="admin-page__section-head">
            <h3>权限映射</h3>
            <span>{{ selectedPermissions.length }} 项</span>
          </div>
          <div v-if="permissions.length === 0" class="admin-page__empty">暂无权限目录</div>
          <div v-else class="admin-page__checkbox-grid">
            <label v-for="permission in permissions" :key="permission.code" class="admin-page__checkbox">
              <input
                :checked="selectedPermissions.includes(permission.code)"
                type="checkbox"
                @change="togglePermission(permission.code, ($event.target as HTMLInputElement).checked)"
              >
              <div>
                <strong>{{ permission.code }}</strong>
                <p>{{ permission.name }}</p>
                <small>{{ permission.description || '无描述' }}</small>
              </div>
            </label>
          </div>
        </section>

        <section class="admin-page__section">
          <div class="admin-page__section-head">
            <h3>当前角色摘要</h3>
            <span v-if="isEditing">成员数：{{ selectedRole?.memberCount ?? 0 }}</span>
          </div>
          <div class="admin-page__chips">
            <span v-for="permission in selectedPermissions" :key="permission" class="admin-page__chip">
              {{ permission }}
            </span>
            <span v-if="selectedPermissions.length === 0" class="admin-page__empty">尚未选择权限</span>
          </div>
        </section>

        <footer class="admin-page__footer">
          <button class="admin-page__button" type="button" :disabled="busy || !canSave" @click="void saveRole()">
            {{ busy ? '保存中...' : isEditing ? '保存角色' : '创建角色' }}
          </button>
          <button class="admin-page__button admin-page__button--secondary" type="button" :disabled="busy" @click="resetForm()">
            取消
          </button>
          <button
            v-if="isEditing"
            class="admin-page__button admin-page__button--danger"
            type="button"
            :disabled="busy"
            @click="void deleteRole()"
          >
            删除角色
          </button>
        </footer>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { apiFetch } from '../utils/api'

type RoleCatalogItem = {
  id: string
  name: string
  permissions: string[]
  memberCount: number
}

type PermissionCatalogItem = {
  code: string
  name: string
  description: string | null
}

const loading = ref(false)
const busy = ref(false)
const status = ref('')
const statusTone = ref<'info' | 'error'>('info')
const roles = ref<RoleCatalogItem[]>([])
const permissions = ref<PermissionCatalogItem[]>([])
const selectedRoleId = ref('')
const draftRoleId = ref('')
const draftRoleName = ref('')
const selectedPermissions = ref<string[]>([])

const selectedRole = computed(() => roles.value.find((role) => role.id === selectedRoleId.value) || null)
const isEditing = computed(() => selectedRoleId.value.length > 0)
const canSave = computed(() => draftRoleName.value.trim().length > 0 && draftRoleId.value.trim().length > 0)

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

function applyRole(role: RoleCatalogItem | null): void {
  selectedRoleId.value = role?.id || ''
  draftRoleId.value = role?.id || ''
  draftRoleName.value = role?.name || ''
  selectedPermissions.value = [...(role?.permissions || [])]
}

function resetForm(): void {
  applyRole(null)
}

function selectRole(role: RoleCatalogItem): void {
  applyRole(role)
}

function togglePermission(code: string, checked: boolean): void {
  const current = new Set(selectedPermissions.value)
  if (checked) current.add(code)
  else current.delete(code)
  selectedPermissions.value = Array.from(current.values()).sort()
}

async function loadCatalog(): Promise<void> {
  loading.value = true
  try {
    const [rolesResponse, permissionsResponse] = await Promise.all([
      apiFetch('/api/admin/roles'),
      apiFetch('/api/permissions'),
    ])

    const [rolesPayload, permissionsPayload] = await Promise.all([
      readJson(rolesResponse),
      readJson(permissionsResponse),
    ])

    if (!rolesResponse.ok || rolesPayload.ok !== true) {
      throw new Error(String((rolesPayload.error as Record<string, unknown> | undefined)?.message || '加载角色失败'))
    }
    if (!permissionsResponse.ok) {
      throw new Error(String(permissionsPayload.error || '加载权限目录失败'))
    }

    const roleData = rolesPayload.data as { items?: RoleCatalogItem[] } | undefined
    const permissionData = permissionsPayload.data

    roles.value = Array.isArray(roleData?.items) ? roleData.items : []
    permissions.value = Array.isArray(permissionData) ? permissionData as PermissionCatalogItem[] : []

    if (selectedRoleId.value) {
      const latest = roles.value.find((role) => role.id === selectedRoleId.value) || null
      applyRole(latest)
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载角色失败', 'error')
  } finally {
    loading.value = false
  }
}

async function saveRole(): Promise<void> {
  if (!canSave.value) return
  busy.value = true
  try {
    const payload = {
      id: draftRoleId.value.trim(),
      name: draftRoleName.value.trim(),
      permissions: selectedPermissions.value,
    }

    const response = await apiFetch(isEditing.value ? `/api/roles/${encodeURIComponent(draftRoleId.value.trim())}` : '/api/roles', {
      method: isEditing.value ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    })
    const body = await readJson(response)
    if (!response.ok || body.ok !== true) {
      throw new Error(String((body.error as Record<string, unknown> | undefined)?.message || '保存角色失败'))
    }

    const currentId = String((body.data as Record<string, unknown> | undefined)?.id || payload.id)
    await loadCatalog()
    const latest = roles.value.find((role) => role.id === currentId) || null
    applyRole(latest)
    setStatus(isEditing.value ? '角色已更新' : '角色已创建')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '保存角色失败', 'error')
  } finally {
    busy.value = false
  }
}

async function deleteRole(): Promise<void> {
  if (!isEditing.value) return
  if (!window.confirm(`确认删除角色 ${draftRoleName.value || draftRoleId.value}？`)) return

  busy.value = true
  try {
    const response = await apiFetch(`/api/roles/${encodeURIComponent(draftRoleId.value.trim())}`, {
      method: 'DELETE',
    })
    const body = await readJson(response)
    if (!response.ok || body.ok !== true) {
      throw new Error(String((body.error as Record<string, unknown> | undefined)?.message || '删除角色失败'))
    }

    resetForm()
    await loadCatalog()
    setStatus('角色已删除')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '删除角色失败', 'error')
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  await loadCatalog()
})
</script>

<style scoped>
.admin-page {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.admin-page__header,
.admin-page__section-head,
.admin-page__footer,
.admin-page__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.admin-page__layout {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 16px;
}

.admin-page__panel {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 14px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.admin-page__panel--list {
  max-height: calc(100vh - 180px);
  overflow: auto;
}

.admin-page__item {
  text-align: left;
  border: 1px solid #dbe3f0;
  border-radius: 12px;
  background: #fff;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  cursor: pointer;
}

.admin-page__item--active {
  border-color: #2563eb;
  background: #eff6ff;
}

.admin-page__form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.admin-page__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.admin-page__input {
  width: 100%;
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  padding: 10px 12px;
  font: inherit;
}

.admin-page__section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.admin-page__checkbox-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.admin-page__checkbox {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 10px 12px;
}

.admin-page__checkbox p,
.admin-page__checkbox small,
.admin-page__item small {
  color: #64748b;
}

.admin-page__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.admin-page__chip {
  border-radius: 999px;
  background: #eff6ff;
  color: #1d4ed8;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 600;
}

.admin-page__button {
  border: none;
  border-radius: 10px;
  background: #2563eb;
  color: #fff;
  padding: 10px 14px;
  font: inherit;
  cursor: pointer;
}

.admin-page__button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.admin-page__button--secondary {
  background: #e2e8f0;
  color: #0f172a;
}

.admin-page__button--danger {
  background: #dc2626;
}

.admin-page__status {
  margin: 0;
  color: #1d4ed8;
}

.admin-page__status--error {
  color: #dc2626;
}

.admin-page__empty {
  color: #64748b;
}

@media (max-width: 960px) {
  .admin-page__layout,
  .admin-page__form-grid,
  .admin-page__checkbox-grid {
    grid-template-columns: 1fr;
  }
}
</style>
