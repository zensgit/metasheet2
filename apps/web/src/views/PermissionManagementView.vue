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
          @keyup.enter="void submitSearch()"
        >
        <button class="permission-admin__button permission-admin__button--secondary" type="button" :disabled="loading" @click="void loadAll()">
          {{ loading ? '加载中...' : '刷新' }}
        </button>
      </div>
    </header>

    <p v-if="status" class="permission-admin__status" :class="{ 'permission-admin__status--error': statusTone === 'error' }">
      {{ status }}
    </p>
    <button
      v-if="unconfirmedReadbackUserId && unconfirmedReadbackUserId === selectedUserId"
      class="permission-admin__button permission-admin__button--secondary"
      type="button"
      data-testid="permission-unconfirmed-refresh"
      :disabled="busy"
      @click="void refreshUnconfirmedReadback()"
    >
      只读重新读取
    </button>

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
        <p data-testid="user-list-total">共 {{ userTotal }} 人</p>
        <div class="permission-admin__pager" data-testid="user-list-pager">
          <button class="permission-admin__button permission-admin__button--secondary" type="button" data-testid="user-list-prev" :disabled="page <= 1 || loading" @click="void goToPage(page - 1)">上一页</button>
          <span data-testid="user-list-page">第 {{ page }} / {{ pageCount }} 页</span>
          <button class="permission-admin__button permission-admin__button--secondary" type="button" data-testid="user-list-next" :disabled="page >= pageCount || loading" @click="void goToPage(page + 1)">下一页</button>
        </div>
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
              <span class="permission-admin__chip" :class="{ 'permission-admin__chip--admin': grantView.adminLabel === '管理员' }">
                {{ grantView.adminLabel }}
              </span>
            </div>
          </div>

          <p
            v-if="grantView.unread"
            class="permission-admin__status permission-admin__status--error"
            data-testid="permission-inspection-unavailable"
          >
            权限来源暂时不可用，不能把空列表当作已回收或未授予。
          </p>

          <section class="permission-admin__section" data-testid="permission-direct-section">
            <div class="permission-admin__section-head">
              <h3>直接授予</h3>
              <span>{{ grantView.directLabel }}</span>
            </div>
            <div class="permission-admin__chips">
              <span v-for="permission in grantView.showDirectChips ? (selectedUserAccess?.direct || []) : []" :key="`direct-${permission}`" class="permission-admin__chip permission-admin__chip--permission">
                {{ presentGrantedCode(permission).name }}
                <small v-if="presentGrantedCode(permission).showTechnicalCode" class="permission-admin__technical-code">{{ permission }}</small>
              </span>
              <span v-if="grantView.showDirectEmpty" class="permission-admin__empty">暂无直接授予</span>
            </div>
          </section>

          <section class="permission-admin__section" data-testid="permission-inherited-section">
            <div class="permission-admin__section-head">
              <h3>角色继承</h3>
              <span>{{ grantView.inheritedLabel }}</span>
            </div>
            <div class="permission-admin__chips">
              <span v-for="permission in grantView.showInheritedChips ? (selectedUserAccess?.inherited || []) : []" :key="`inherited-${permission}`" class="permission-admin__chip">
                {{ presentGrantedCode(permission).name }}
                <small v-if="presentGrantedCode(permission).showTechnicalCode" class="permission-admin__technical-code">{{ permission }}</small>
              </span>
              <span v-if="grantView.showInheritedEmpty" class="permission-admin__empty">暂无角色继承权限</span>
            </div>
          </section>

          <section class="permission-admin__section" data-testid="permission-legacy-section">
            <details data-testid="permission-legacy-details">
              <summary class="permission-admin__section-head">
                <h3>历史授权</h3>
                <span>{{ grantView.legacyLabel }}</span>
              </summary>
              <p class="permission-admin__hint">以前留下的授权，和直接授权、角色继承分开显示。暂时看不清时，不会显示成没有任何记录。</p>
              <div class="permission-admin__chips">
                <span v-for="permission in grantView.showLegacyChips ? (selectedUserAccess?.legacy || []) : []" :key="`legacy-${permission}`" class="permission-admin__chip">
                  {{ presentGrantedCode(permission).name }}
                  <small v-if="presentGrantedCode(permission).showTechnicalCode" class="permission-admin__technical-code">{{ permission }}</small>
                </span>
                <span v-if="grantView.showLegacyEmpty" class="permission-admin__empty">暂无历史授权</span>
              </div>
            </details>
          </section>

          <section class="permission-admin__section" data-testid="permission-effective-section">
            <div class="permission-admin__section-head">
              <h3>权限码快照</h3>
              <span>{{ grantView.effectiveLabel }}</span>
            </div>
            <p class="permission-admin__hint">这里只是这次读到的权限码，不是最终能不能做业务操作。全局权限码仍可能留在这份快照里。未开通的内容不会因此变得可用，本页也不会自动开通。</p>
            <div class="permission-admin__chips">
              <span v-for="permission in grantView.showEffectiveChips ? assignedPermissions : []" :key="`effective-${permission}`" class="permission-admin__chip permission-admin__chip--permission">
                {{ presentGrantedCode(permission).name }}
                <small v-if="presentGrantedCode(permission).showTechnicalCode" class="permission-admin__technical-code">{{ permission }}</small>
              </span>
              <span v-if="grantView.showEffectiveEmpty" class="permission-admin__empty">暂无生效权限</span>
            </div>
          </section>

          <section
            v-if="(selectedUserAccess?.blockedByNamespaceAdmission.length || 0) > 0"
            class="permission-admin__section"
            data-testid="permission-blocked-section"
          >
            <div class="permission-admin__section-head">
              <h3>未生效（命名空间准入）</h3>
              <span>{{ selectedUserAccess?.blockedByNamespaceAdmission.length }} 项</span>
            </div>
            <p class="permission-admin__hint">这些权限已经记下，但对应插件还没开通，所以没有放进上面的权限码快照。本页不会自动开通。</p>
            <div class="permission-admin__chips">
              <span
                v-for="permission in selectedUserAccess?.blockedByNamespaceAdmission || []"
                :key="`blocked-${permission}`"
                class="permission-admin__chip permission-admin__chip--blocked"
              >
                {{ presentGrantedCode(permission).name }}
                <small v-if="presentGrantedCode(permission).showTechnicalCode" class="permission-admin__technical-code">{{ permission }}</small>
              </span>
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
                <button class="permission-admin__button" type="button" data-testid="apply-permission-template-button" :disabled="busy || !selectedTemplateId || !grantView.actionsEnabled" @click="void applyPermissionTemplate()">
                  按模板补齐
                </button>
              </div>
            </div>
            <div v-if="selectedTemplate" class="permission-admin__chips">
              <span class="permission-admin__chip">{{ selectedTemplate.productMode }}</span>
              <span v-if="selectedTemplate.roleId" class="permission-admin__chip">{{ selectedTemplate.roleId }}</span>
              <span v-for="permission in selectedTemplate.permissions" :key="`tpl-${permission}`" class="permission-admin__chip permission-admin__chip--permission">
                {{ presentGrantedCode(permission).name }}
                <small v-if="presentGrantedCode(permission).showTechnicalCode" class="permission-admin__technical-code">{{ permission }}</small>
              </span>
            </div>
            <p v-if="selectedTemplate" class="permission-admin__hint">{{ selectedTemplate.description }}</p>
          </section>

          <section class="permission-admin__section">
            <div class="permission-admin__section-head">
              <h3>权限目录</h3>
              <div class="permission-admin__role-actions">
                <select v-model="selectedPermissionCode" class="permission-admin__select" data-testid="permission-select" aria-label="选择要授予或回收的权限">
                  <option value="">请选择权限</option>
                  <option v-for="permission in permissions" :key="permission.code" :value="permission.code">
                    {{ catalogOptionLabel(permission) }}
                  </option>
                </select>
                <button class="permission-admin__button" type="button" data-testid="grant-permission-button" :disabled="busy || !selectedPermissionCode || !grantView.actionsEnabled" @click="void grantPermission()">
                  添加直接授权
                </button>
                <button class="permission-admin__button permission-admin__button--secondary" type="button" data-testid="revoke-permission-button" :disabled="busy || !selectedPermissionCode || !grantView.actionsEnabled" @click="void revokePermission()">
                  移除直接授权
                </button>
              </div>
            </div>
            <p v-if="selectedPermissionHint" data-testid="selected-permission-hint" class="permission-admin__hint">{{ selectedPermissionHint }}</p>
            <p
              v-if="permissionActionFeedback"
              data-testid="permission-action-feedback"
              class="permission-admin__status"
              :class="{ 'permission-admin__status--error': permissionActionFeedback.tone === 'error' }"
              aria-live="polite"
            >
              {{ permissionActionFeedback.message }}
            </p>

            <div class="permission-admin__catalog">
              <article v-for="permission in permissions" :key="permission.code" class="permission-admin__permission">
                <div>
                  <strong>{{ presentCatalogPermission(permission).name }}</strong>
                  <p>{{ presentCatalogPermission(permission).description || '无描述' }}</p>
                  <details v-if="presentCatalogPermission(permission).name !== permission.code" class="permission-admin__technical">
                    <summary>技术明细</summary>
                    <code>{{ permission.code }}</code>
                  </details>
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
import { computed, inject, onMounted, ref, watch } from 'vue'
import { routeLocationKey } from 'vue-router'
import { apiFetch } from '../utils/api'
import {
  accessReadStillCurrent,
  describePermissionInspectionView,
  describePermissionTemplateApply,
  describePermissionWrite,
  describeSelectedPermissionHint,
  describeUnconfirmedPermissionWrite,
  nextAccessReadGeneration,
  readPermissionTemplateApplyAcknowledgement,
  readPermissionWriteAcknowledgement,
  readUserPermissionInspection,
  unreadUserPermissionInspection,
  type UserPermissionInspection,
} from './adminPermissionGrantDisplay'
import { presentPermission } from './builtinCatalogPresentation'

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

type UserPermissionState = UserPermissionInspection

type PermissionTemplate = {
  id: string
  name: string
  description: string
  productMode: 'platform' | 'attendance' | 'plm-workbench'
  permissions: string[]
  presetId: string | null
  roleId: string | null
}

const pageSize = 20
const loading = ref(false)
const busy = ref(false)
const status = ref('')
const statusTone = ref<'info' | 'error'>('info')
const search = ref('')
const page = ref(1)
const userTotal = ref(0)
const userListGeneration = ref(0)
const users = ref<ManagedUser[]>([])
const knownUsers = ref<Record<string, ManagedUser>>({})
const permissions = ref<PermissionCatalogItem[]>([])
const permissionTemplates = ref<PermissionTemplate[]>([])
const selectedUserId = ref('')
const userAccessReadGeneration = ref(0)
const selectedPermissionCode = ref('')
const selectedTemplateId = ref('')
const templateModeFilter = ref<'' | 'platform' | 'attendance' | 'plm-workbench'>('')
const selectedUserAccess = ref<UserPermissionState | null>(null)
const permissionActionFeedback = ref<{ tone: 'info' | 'error'; message: string } | null>(null)
const unconfirmedReadbackUserId = ref('')
// Direct createApp mounts have no router. A defaulted inject reads the deep link without warning.
const route = inject(routeLocationKey, null)
let routeTargetGeneration = 0

const requestedTargetUserId = computed<string | null>(() => {
  if (!route || !Object.prototype.hasOwnProperty.call(route.query, 'userId')) return null
  const raw = route.query.userId
  if (typeof raw !== 'string') return ''
  return raw.trim()
})

const selectedUser = computed(() => (
  users.value.find((user) => user.id === selectedUserId.value)
  || knownUsers.value[selectedUserId.value]
  || null
))
const pageCount = computed(() => Math.max(1, Math.ceil(userTotal.value / pageSize)))
const grantView = computed(() => describePermissionInspectionView(selectedUserAccess.value, selectedUserId.value))
const assignedPermissions = computed(() => {
  if (!grantView.value.showEffectiveChips) return []
  return selectedUserAccess.value?.effective || []
})
const selectedPermissionHint = computed(() => describeSelectedPermissionHint(selectedPermissionCode.value, selectedUserAccess.value))
const selectedTemplate = computed(() => permissionTemplates.value.find((template) => template.id === selectedTemplateId.value) || null)

function presentCatalogPermission(permission: PermissionCatalogItem): { name: string; description: string | null; code: string } {
  const shown = presentPermission(permission)
  return {
    name: shown.name.trim() || permission.code,
    description: shown.description,
    code: permission.code,
  }
}

function presentGrantedCode(code: string): { name: string; code: string; showTechnicalCode: boolean } {
  const catalogItem = permissions.value.find((item) => item.code === code)
  const name = catalogItem
    ? presentCatalogPermission(catalogItem).name
    : (presentPermission({ code, name: '', description: null }).name.trim() || code)
  return { name, code, showTechnicalCode: name !== code }
}

function catalogOptionLabel(permission: PermissionCatalogItem): string {
  const shown = presentCatalogPermission(permission)
  if (shown.name === permission.code) return shown.name
  return `${shown.name}（${permission.code}）`
}

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

async function loadUsers(targetPage?: number): Promise<void> {
  const generation = userListGeneration.value + 1
  userListGeneration.value = generation
  const requestedPage = Math.max(1, targetPage ?? page.value)
  const requestedSearch = search.value
  const params = new URLSearchParams()
  params.set('page', String(requestedPage))
  params.set('pageSize', String(pageSize))
  if (requestedSearch) params.set('q', requestedSearch)
  let items: ManagedUser[] = []
  let total = 0
  try {
    const response = await apiFetch(`/api/admin/users?${params.toString()}`)
    const payload = await readJson(response)
    if (generation !== userListGeneration.value) return
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载用户失败'))
    }
    const data = payload.data as { items?: ManagedUser[]; total?: number } | undefined
    items = Array.isArray(data?.items) ? data.items : []
    total = typeof data?.total === 'number' ? data.total : items.length
  } catch (error) {
    if (generation !== userListGeneration.value) return
    throw error
  }
  if (generation !== userListGeneration.value) return
  const nextCount = Math.max(1, Math.ceil(total / pageSize))
  const clamped = Math.min(requestedPage, nextCount)
  if (clamped !== requestedPage) {
    await loadUsers(clamped)
    return
  }
  if (generation !== userListGeneration.value) return
  page.value = requestedPage
  users.value = items
  userTotal.value = total
  const remembered = { ...knownUsers.value }
  for (const user of items) remembered[user.id] = user
  knownUsers.value = remembered
  if (selectedUserId.value && userTotal.value === 0 && selectedUserId.value !== requestedTargetUserId.value) {
    selectedUserId.value = ''
    selectedUserAccess.value = null
  }
}

async function submitSearch(): Promise<void> {
  try {
    await loadUsers(1)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载用户失败', 'error')
  }
}

async function goToPage(nextPage: number): Promise<void> {
  const bounded = Math.min(Math.max(1, nextPage), pageCount.value)
  if (bounded === page.value) return
  try {
    await loadUsers(bounded)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载用户失败', 'error')
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

async function loadUserAccess(userId: string): Promise<UserPermissionState> {
  const response = await apiFetch(`/api/permissions/user/${encodeURIComponent(userId)}`)
  const payload = await readJson(response)
  if (!response.ok) {
    throw new Error(String(payload.error || '加载用户权限失败'))
  }

  return readUserPermissionInspection(payload, userId)
}

async function reloadSelectedUserAccess(): Promise<void> {
  const userId = selectedUserId.value
  if (!userId) return
  const generation = nextAccessReadGeneration(userAccessReadGeneration.value)
  userAccessReadGeneration.value = generation
  selectedUserAccess.value = null
  try {
    const inspection = await loadUserAccess(userId)
    if (!accessReadStillCurrent(generation, userAccessReadGeneration.value, userId, selectedUserId.value)) return
    selectedUserAccess.value = inspection
  } catch (error) {
    if (!accessReadStillCurrent(generation, userAccessReadGeneration.value, userId, selectedUserId.value)) return
    selectedUserAccess.value = unreadUserPermissionInspection(userId)
    setStatus(error instanceof Error ? error.message : '加载用户权限失败', 'error')
  }
}

async function refreshUnconfirmedReadback(): Promise<void> {
  const userId = unconfirmedReadbackUserId.value
  if (!userId || userId !== selectedUserId.value) return
  const generation = nextAccessReadGeneration(userAccessReadGeneration.value)
  userAccessReadGeneration.value = generation
  selectedUserAccess.value = null
  try {
    const inspection = await loadUserAccess(userId)
    if (!accessReadStillCurrent(generation, userAccessReadGeneration.value, userId, selectedUserId.value)) return
    if (unconfirmedReadbackUserId.value !== userId) return
    selectedUserAccess.value = inspection.subjectMatched ? inspection : unreadUserPermissionInspection(userId)
    if (inspection.subjectMatched && !inspection.degraded) unconfirmedReadbackUserId.value = ''
  } catch (error) {
    if (!accessReadStillCurrent(generation, userAccessReadGeneration.value, userId, selectedUserId.value)) return
    if (unconfirmedReadbackUserId.value !== userId) return
    selectedUserAccess.value = unreadUserPermissionInspection(userId)
    setStatus(error instanceof Error ? error.message : '加载用户权限失败', 'error')
  }
}

function routeTargetStillCurrent(generation: number, userId: string): boolean {
  return generation === routeTargetGeneration && requestedTargetUserId.value === userId
}

function rememberManagedUser(user: ManagedUser): void {
  knownUsers.value = { ...knownUsers.value, [user.id]: user }
}

function readRouteTargetUser(payload: Record<string, unknown>, requestedId: string): ManagedUser | null {
  const data = payload.data
  if (!data || typeof data !== 'object') return null
  const user = (data as { user?: unknown }).user
  if (!user || typeof user !== 'object') return null
  const record = user as Record<string, unknown>
  if (record.id !== requestedId) return null
  return {
    id: requestedId,
    email: typeof record.email === 'string' ? record.email : '',
    name: typeof record.name === 'string' ? record.name : null,
    role: typeof record.role === 'string' ? record.role : 'user',
    is_active: record.is_active !== false,
    is_admin: record.is_admin === true,
    last_login_at: typeof record.last_login_at === 'string' ? record.last_login_at : null,
    created_at: typeof record.created_at === 'string' ? record.created_at : '',
  }
}

function routeTargetFailureMessage(userId: string): string {
  return userId
    ? `没有打开用户 ${userId}，也没有改成列表中的其他人。`
    : '没有打开指定用户，也没有改成列表中的其他人。'
}

function clearFailedRouteTarget(userId: string): void {
  if (userId && selectedUserId.value !== userId) return
  selectedUserId.value = ''
  selectedUserAccess.value = null
  selectedPermissionCode.value = ''
  permissionActionFeedback.value = null
}

function rejectEmptyRouteTarget(): void {
  routeTargetGeneration += 1
  const generation = routeTargetGeneration
  userAccessReadGeneration.value = nextAccessReadGeneration(userAccessReadGeneration.value)
  selectedUserId.value = ''
  selectedUserAccess.value = null
  selectedPermissionCode.value = ''
  permissionActionFeedback.value = null
  if (generation !== routeTargetGeneration || requestedTargetUserId.value !== '') return
  setStatus(routeTargetFailureMessage(''), 'error')
}

async function applyRouteTarget(userId: string): Promise<void> {
  const generation = routeTargetGeneration + 1
  routeTargetGeneration = generation
  const accessGeneration = nextAccessReadGeneration(userAccessReadGeneration.value)
  userAccessReadGeneration.value = accessGeneration
  selectedUserId.value = userId
  selectedPermissionCode.value = ''
  permissionActionFeedback.value = null
  selectedUserAccess.value = unreadUserPermissionInspection(userId)
  let identityVerified = false
  try {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}/access`)
    const payload = await readJson(response)
    if (!routeTargetStillCurrent(generation, userId)) return
    const user = response.ok && payload.ok === true ? readRouteTargetUser(payload, userId) : null
    if (!user) {
      clearFailedRouteTarget(userId)
      setStatus(routeTargetFailureMessage(userId), 'error')
      return
    }
    rememberManagedUser(user)
    identityVerified = true
    const inspection = await loadUserAccess(userId)
    if (!routeTargetStillCurrent(generation, userId)) return
    if (!accessReadStillCurrent(accessGeneration, userAccessReadGeneration.value, userId, selectedUserId.value)) return
    selectedUserAccess.value = inspection
  } catch (error) {
    if (!routeTargetStillCurrent(generation, userId)) return
    if (!identityVerified) {
      clearFailedRouteTarget(userId)
      setStatus(routeTargetFailureMessage(userId), 'error')
      return
    }
    if (!accessReadStillCurrent(accessGeneration, userAccessReadGeneration.value, userId, selectedUserId.value)) return
    selectedUserAccess.value = unreadUserPermissionInspection(userId)
    setStatus(error instanceof Error ? error.message : '加载用户权限失败', 'error')
  }
}

async function loadAll(): Promise<void> {
  loading.value = true
  const requestedUserId = selectedUserId.value
  const targetAtStart = requestedTargetUserId.value
  const generation = targetAtStart === null && requestedUserId
    ? nextAccessReadGeneration(userAccessReadGeneration.value)
    : userAccessReadGeneration.value
  if (targetAtStart === null && requestedUserId) {
    userAccessReadGeneration.value = generation
    selectedUserAccess.value = unreadUserPermissionInspection(requestedUserId)
  }
  const targetPromise = targetAtStart === null
    ? Promise.resolve()
    : targetAtStart
      ? applyRouteTarget(targetAtStart)
      : Promise.resolve(rejectEmptyRouteTarget())
  try {
    await Promise.all([loadUsers(), loadPermissions(), targetPromise])
    if (targetAtStart !== null || requestedTargetUserId.value !== null) return
    if (!selectedUserId.value && users.value.length > 0) {
      await selectUser(users.value[0].id)
    } else if (selectedUserId.value) {
      await reloadSelectedUserAccess()
    }
  } catch (error) {
    if (
      targetAtStart === null
      && requestedUserId
      && accessReadStillCurrent(generation, userAccessReadGeneration.value, requestedUserId, selectedUserId.value)
    ) {
      selectedUserAccess.value = unreadUserPermissionInspection(requestedUserId)
    }
    setStatus(error instanceof Error ? error.message : '加载权限管理数据失败', 'error')
  } finally {
    loading.value = false
  }
}

async function selectUser(userId: string): Promise<void> {
  selectedUserId.value = userId
  selectedPermissionCode.value = ''
  permissionActionFeedback.value = null
  await reloadSelectedUserAccess()
}

function applyPermissionReadback(
  generation: number,
  requestedUserId: string,
  inspection: UserPermissionInspection,
  outcomeApply: boolean,
): void {
  if (!accessReadStillCurrent(generation, userAccessReadGeneration.value, requestedUserId, selectedUserId.value)) return
  if (outcomeApply || inspection.degraded || !inspection.subjectMatched || !inspection.sourceKnown) {
    selectedUserAccess.value = inspection.subjectMatched ? inspection : unreadUserPermissionInspection(requestedUserId)
  }
}

async function mutatePermission(action: 'grant' | 'revoke'): Promise<void> {
  if (!selectedUserId.value || !selectedPermissionCode.value || !grantView.value.actionsEnabled) return
  const requestedUserId = selectedUserId.value
  const requestedPermission = selectedPermissionCode.value
  const generation = userAccessReadGeneration.value

  busy.value = true
  if (unconfirmedReadbackUserId.value === requestedUserId) unconfirmedReadbackUserId.value = ''
  let acknowledged = false
  let writeObserved = false
  try {
    const response = await apiFetch(`/api/permissions/${action}`, {
      method: 'POST',
      body: JSON.stringify({
        userId: requestedUserId,
        permission: requestedPermission,
      }),
    })
    writeObserved = true
    const payload = await readJson(response)
    if (!response.ok) {
      const outcome = describePermissionWrite({
        action,
        requestedUserId,
        selectedUserId: selectedUserId.value,
        permission: requestedPermission,
        ok: false,
        httpStatus: response.status,
        errorMessage: String(payload.error || `${action} permission failed`),
        inspection: selectedUserAccess.value,
      })
      permissionActionFeedback.value = { tone: outcome.tone, message: outcome.message }
      setStatus(outcome.message, 'error')
      return
    }

    const acknowledgement = readPermissionWriteAcknowledgement(payload, requestedUserId, requestedPermission)
    if (!acknowledgement.accepted) {
      if (accessReadStillCurrent(generation, userAccessReadGeneration.value, requestedUserId, selectedUserId.value)) {
        selectedUserAccess.value = unreadUserPermissionInspection(requestedUserId)
      }
      const outcome = describePermissionWrite({
        action,
        requestedUserId,
        selectedUserId: selectedUserId.value,
        permission: requestedPermission,
        ok: true,
        writeAcknowledged: false,
        errorMessage: acknowledgement.message,
      })
      permissionActionFeedback.value = { tone: outcome.tone, message: outcome.message }
      setStatus(outcome.message, 'error')
      return
    }

    acknowledged = true
    const inspection = await loadUserAccess(requestedUserId)
    const outcome = describePermissionWrite({
      action,
      requestedUserId,
      selectedUserId: selectedUserId.value,
      permission: requestedPermission,
      ok: true,
      writeAcknowledged: true,
      inspection,
    })
    permissionActionFeedback.value = { tone: outcome.tone, message: outcome.message }
    setStatus(outcome.message, outcome.tone)
    applyPermissionReadback(generation, requestedUserId, inspection, outcome.applyInspection)
  } catch (error) {
    const stillCurrent = selectedUserId.value === requestedUserId && userAccessReadGeneration.value === generation
    if (!writeObserved || acknowledged) {
      unconfirmedReadbackUserId.value = requestedUserId
      if (stillCurrent) selectedUserAccess.value = unreadUserPermissionInspection(requestedUserId)
      const outcome = describeUnconfirmedPermissionWrite(requestedUserId)
      permissionActionFeedback.value = { tone: outcome.tone, message: outcome.message }
      setStatus(outcome.message, 'error')
      return
    }
    const outcome = describePermissionWrite({
      action,
      requestedUserId,
      selectedUserId: selectedUserId.value,
      permission: requestedPermission,
      ok: false,
      errorMessage: error instanceof Error ? error.message : '权限操作失败',
      inspection: selectedUserAccess.value,
    })
    permissionActionFeedback.value = { tone: outcome.tone, message: outcome.message }
    setStatus(outcome.message, 'error')
  } finally {
    busy.value = false
  }
}

async function applyPermissionTemplate(): Promise<void> {
  if (!selectedUserId.value || !selectedTemplateId.value || !grantView.value.actionsEnabled) return
  const requestedUserId = selectedUserId.value
  const requestedTemplateId = selectedTemplateId.value
  const templateName = selectedTemplate.value?.name || requestedTemplateId
  const requestedPermissions = [...(selectedTemplate.value?.permissions ?? [])]
  const generation = userAccessReadGeneration.value

  busy.value = true
  if (unconfirmedReadbackUserId.value === requestedUserId) unconfirmedReadbackUserId.value = ''
  let writeObserved = false
  let submitted = false
  try {
    const response = await apiFetch('/api/admin/permission-templates/apply', {
      method: 'POST',
      body: JSON.stringify({
        userId: requestedUserId,
        templateId: requestedTemplateId,
      }),
    })
    writeObserved = true
    const payload = await readJson(response)
    if (!response.ok) {
      throw new Error(String(payload.error || '应用权限模板失败'))
    }

    const acknowledgement = readPermissionTemplateApplyAcknowledgement(payload, requestedUserId, requestedTemplateId)
    if (!acknowledgement.accepted) {
      if (accessReadStillCurrent(generation, userAccessReadGeneration.value, requestedUserId, selectedUserId.value)) {
        selectedUserAccess.value = unreadUserPermissionInspection(requestedUserId)
        setStatus(acknowledgement.message, 'error')
      }
      return
    }

    submitted = true
    const inspection = await loadUserAccess(requestedUserId)
    const outcome = describePermissionTemplateApply({ templateName, requestedPermissions, inspection })
    const stillCurrent = accessReadStillCurrent(generation, userAccessReadGeneration.value, requestedUserId, selectedUserId.value)
    if (!stillCurrent) {
      if (selectedUserId.value !== requestedUserId) {
        setStatus(`${outcome.message} 未覆盖当前选中用户 ${selectedUserId.value} 的状态`, outcome.tone)
      }
      return
    }
    selectedUserAccess.value = inspection
    setStatus(outcome.message, outcome.tone)
  } catch (error) {
    const stillCurrent = accessReadStillCurrent(generation, userAccessReadGeneration.value, requestedUserId, selectedUserId.value)
    if (!writeObserved || submitted) {
      unconfirmedReadbackUserId.value = requestedUserId
      if (stillCurrent) {
        selectedUserAccess.value = unreadUserPermissionInspection(requestedUserId)
      }
      if (stillCurrent || selectedUserId.value !== requestedUserId) {
        const outcome = describeUnconfirmedPermissionWrite(requestedUserId)
        setStatus(outcome.message, 'error')
      }
      return
    }
    if (stillCurrent) {
      setStatus(error instanceof Error ? error.message : '应用权限模板失败', 'error')
    }
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

watch(requestedTargetUserId, (userId, previousUserId) => {
  if (userId === previousUserId || userId === null) return
  if (!userId) {
    rejectEmptyRouteTarget()
    return
  }
  void applyRouteTarget(userId)
})
</script>

<style scoped>
.permission-admin,
.permission-admin * {
  box-sizing: border-box;
}

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

.permission-admin__chip--blocked {
  background: #fef3c7;
  color: #92400e;
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

.permission-admin__pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.permission-admin__technical-code {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  font-weight: 500;
  color: #64748b;
}

.permission-admin__technical {
  color: #64748b;
}

@media (max-width: 960px) {
  .permission-admin__layout {
    grid-template-columns: 1fr;
  }

  .permission-admin__header,
  .permission-admin__detail-head,
  .permission-admin__section-head,
  .permission-admin__actions,
  .permission-admin__role-actions {
    flex-direction: column;
    align-items: stretch;
  }

  .permission-admin__header .permission-admin__search,
  .permission-admin__header .permission-admin__button {
    width: 100%;
  }
}
</style>
