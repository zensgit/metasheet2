<template>
  <section class="delegation-page">
    <header class="delegation-page__header">
      <div>
        <h1>角色委派</h1>
        <p>插件管理员只能分配自己负责命名空间下、且位于授权部门或成员集范围内的成员；平台管理员可作为兜底入口使用。</p>
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
      <div v-if="summary && !summary.isPlatformAdmin" class="delegation-page__section">
        <h3>当前管理范围</h3>
        <div v-if="summary.scopeAssignments.length > 0" class="delegation-page__scope-list">
          <article v-for="scope in summary.scopeAssignments" :key="scope.id" class="delegation-page__scope-card">
            <strong>{{ scope.namespace }}</strong>
            <span>{{ scope.integrationName }}</span>
            <p>{{ scope.departmentFullPath || scope.departmentName }}</p>
          </article>
        </div>
        <div v-if="summary.groupAssignments.length > 0" class="delegation-page__scope-list">
          <article v-for="group in summary.groupAssignments" :key="group.id" class="delegation-page__scope-card">
            <strong>{{ group.namespace }}</strong>
            <span>{{ group.name }}</span>
            <p>{{ group.description || `成员 ${group.memberCount}` }}</p>
          </article>
        </div>
        <div
          v-if="summary.scopeAssignments.length === 0 && summary.groupAssignments.length === 0"
          class="delegation-page__empty"
        >
          当前插件管理员尚未配置任何部门或成员集范围，因此不能委派成员。
        </div>
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
            <h3>成员集归属</h3>
            <div class="delegation-page__chips">
              <span v-for="group in selectedAccess.memberGroups" :key="group.id" class="delegation-page__chip">
                {{ group.name }}
              </span>
              <span v-if="selectedAccess.memberGroups.length === 0" class="delegation-page__empty">该成员尚未加入任何平台成员集</span>
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

          <div v-if="summary?.isPlatformAdmin" class="delegation-page__section">
            <h3>平台成员集</h3>
            <p class="delegation-page__hint">平台管理员可维护一组固定成员，再将该成员集直接分配给插件管理员命名空间或组织范围模板。</p>
            <div class="delegation-page__role-actions">
              <input
                v-model.trim="memberGroupName"
                class="delegation-page__input"
                type="text"
                placeholder="成员集名称，例如 制造中心"
              />
              <input
                v-model.trim="memberGroupDescription"
                class="delegation-page__input"
                type="text"
                placeholder="成员集说明，可选"
              />
              <button class="delegation-page__button" type="button" :disabled="groupBusy || !memberGroupName" @click="void createMemberGroup()">
                创建成员集
              </button>
            </div>
            <div class="delegation-page__role-actions">
              <input
                v-model.trim="memberGroupSearch"
                class="delegation-page__input"
                type="search"
                placeholder="搜索成员集"
                @keyup.enter="void loadMemberGroups()"
              />
              <button class="delegation-page__button delegation-page__button--secondary" type="button" :disabled="groupBusy" @click="void loadMemberGroups()">
                查询成员集
              </button>
              <select v-model="selectedMemberGroupId" class="delegation-page__input" @change="void selectMemberGroup(selectedMemberGroupId)">
                <option value="">请选择成员集</option>
                <option v-for="group in memberGroups" :key="group.id" :value="group.id">
                  {{ group.name }} ({{ group.memberCount }})
                </option>
              </select>
              <button
                class="delegation-page__button"
                type="button"
                :disabled="groupBusy || !hasSelectedMemberGroup || !selectedUserId"
                @click="void updateUserMemberGroup('assign')"
              >
                将当前成员加入成员集
              </button>
            </div>

            <template v-if="selectedMemberGroup">
              <div class="delegation-page__section">
                <h3>{{ selectedMemberGroup.name }}</h3>
                <p class="delegation-page__hint">{{ selectedMemberGroup.description || '暂无说明' }}</p>
                <div v-if="selectedMemberGroup.members.length > 0" class="delegation-page__role-list">
                  <article v-for="member in selectedMemberGroup.members" :key="member.id" class="delegation-page__role-card">
                    <strong>{{ member.name || member.email }}</strong>
                    <span>{{ member.email }}</span>
                    <p>{{ member.role }} · {{ member.isActive ? '启用' : '停用' }}</p>
                    <div class="delegation-page__chips">
                      <span class="delegation-page__chip" :class="{ 'delegation-page__chip--success': member.platformAdminEnabled }">
                        {{ member.platformAdminEnabled ? '平台管理员' : '非平台管理员' }}
                      </span>
                      <span class="delegation-page__chip" :class="{ 'delegation-page__chip--success': member.attendanceAdminEnabled }">
                        {{ member.attendanceAdminEnabled ? '考勤管理员' : '非考勤管理员' }}
                      </span>
                      <span class="delegation-page__chip" :class="{ 'delegation-page__chip--success': member.dingtalkLoginEnabled }">
                        {{ member.dingtalkLoginEnabled ? '钉钉已开通' : '钉钉未开通' }}
                      </span>
                      <span class="delegation-page__chip" :class="{ 'delegation-page__chip--success': member.directoryLinked }">
                        {{ member.directoryLinked ? '目录已链接' : '目录未链接' }}
                      </span>
                    </div>
                    <p v-if="member.businessRoleIds.length > 0">业务角色：{{ member.businessRoleIds.join(', ') }}</p>
                    <button
                      class="delegation-page__button delegation-page__button--danger"
                      type="button"
                      :disabled="groupBusy"
                      @click="void updateUserMemberGroup('unassign', member.id)"
                    >
                      移出成员集
                    </button>
                  </article>
                </div>
                <div v-else class="delegation-page__empty">
                  该成员集还没有成员。
                </div>
              </div>
            </template>
          </div>

          <div v-if="summary?.isPlatformAdmin && selectedScopeConfig" class="delegation-page__section">
            <h3>插件管理员范围配置</h3>
            <p class="delegation-page__hint">平台管理员可为持有 `xxx_admin` 角色的成员分配可管理的钉钉部门范围或平台成员集。</p>
            <div v-if="selectedScopeConfig.adminNamespaces.length === 0" class="delegation-page__empty">
              该成员尚未持有任何插件管理员角色。
            </div>
            <template v-else>
              <div class="delegation-page__role-actions">
                <select v-model="selectedScopeNamespace" class="delegation-page__input">
                  <option value="">请选择管理员命名空间</option>
                  <option v-for="namespace in selectedScopeConfig.adminNamespaces" :key="namespace" :value="namespace">
                    {{ namespace }}
                  </option>
                </select>
                <input
                  v-model.trim="departmentSearch"
                  class="delegation-page__input"
                  type="search"
                  placeholder="搜索部门路径、部门名或集成名"
                  @keyup.enter="void loadDepartments()"
                />
                <button class="delegation-page__button delegation-page__button--secondary" type="button" :disabled="scopeBusy" @click="void loadDepartments()">
                  查询部门
                </button>
              </div>
              <div class="delegation-page__role-actions">
                <select v-model="selectedDepartmentId" class="delegation-page__input">
                  <option value="">请选择部门</option>
                  <option v-for="department in departments" :key="department.directoryDepartmentId" :value="department.directoryDepartmentId">
                    {{ department.integrationName }} / {{ department.departmentFullPath || department.departmentName }}
                  </option>
                </select>
                <button class="delegation-page__button" type="button" :disabled="scopeBusy || !selectedScopeNamespace || !selectedDepartmentId" @click="void updateScope('assign')">
                  添加部门范围
                </button>
              </div>
              <div class="delegation-page__role-actions">
                <select v-model="selectedAudienceGroupId" class="delegation-page__input">
                  <option value="">请选择平台成员集</option>
                  <option v-for="group in memberGroups" :key="group.id" :value="group.id">
                    {{ group.name }} ({{ group.memberCount }})
                  </option>
                </select>
                <button class="delegation-page__button" type="button" :disabled="scopeBusy || !selectedScopeNamespace || !selectedAudienceGroupId" @click="void updateScopeGroup('assign')">
                  添加成员集范围
                </button>
              </div>
              <div v-if="selectedScopeConfig.scopeAssignments.length > 0" class="delegation-page__scope-list">
                <article v-for="scope in selectedScopeConfig.scopeAssignments" :key="scope.id" class="delegation-page__scope-card">
                  <strong>{{ scope.namespace }}</strong>
                  <span>{{ scope.integrationName }}</span>
                  <p>{{ scope.departmentFullPath || scope.departmentName }}</p>
                  <button
                    class="delegation-page__button delegation-page__button--danger"
                    type="button"
                    :disabled="scopeBusy"
                    @click="void updateScope('unassign', scope)"
                  >
                    移除部门范围
                  </button>
                </article>
              </div>
              <div v-if="selectedScopeConfig.groupAssignments.length > 0" class="delegation-page__scope-list">
                <article v-for="group in selectedScopeConfig.groupAssignments" :key="group.id" class="delegation-page__scope-card">
                  <strong>{{ group.namespace }}</strong>
                  <span>{{ group.name }}</span>
                  <p>{{ group.description || `成员 ${group.memberCount}` }}</p>
                  <button
                    class="delegation-page__button delegation-page__button--danger"
                    type="button"
                    :disabled="scopeBusy"
                    @click="void updateScopeGroup('unassign', group)"
                  >
                    移除成员集范围
                  </button>
                </article>
              </div>
              <div
                v-if="selectedScopeConfig.scopeAssignments.length === 0 && selectedScopeConfig.groupAssignments.length === 0"
                class="delegation-page__empty"
              >
                该成员尚未配置任何插件管理员范围。
              </div>
            </template>
          </div>

          <div v-if="summary?.isPlatformAdmin" class="delegation-page__section">
            <h3>组织范围模板</h3>
            <p class="delegation-page__hint">模板用于复用一组部门范围与平台成员集，再一键覆盖到某个插件管理员命名空间。</p>
            <div class="delegation-page__role-actions">
              <input
                v-model.trim="templateName"
                class="delegation-page__input"
                type="text"
                placeholder="模板名称，例如 华东销售"
              />
              <input
                v-model.trim="templateDescription"
                class="delegation-page__input"
                type="text"
                placeholder="模板说明，可选"
              />
              <button class="delegation-page__button" type="button" :disabled="scopeBusy || !templateName" @click="void createTemplate()">
                创建模板
              </button>
            </div>
            <div class="delegation-page__role-actions">
              <input
                v-model.trim="templateSearch"
                class="delegation-page__input"
                type="search"
                placeholder="搜索模板"
                @keyup.enter="void loadTemplates()"
              />
              <button class="delegation-page__button delegation-page__button--secondary" type="button" :disabled="scopeBusy" @click="void loadTemplates()">
                查询模板
              </button>
              <select v-model="selectedTemplateId" class="delegation-page__input" @change="void selectTemplate(selectedTemplateId)">
                <option value="">请选择模板</option>
                <option v-for="template in templates" :key="template.id" :value="template.id">
                  {{ template.name }} ({{ template.departmentCount }})
                </option>
              </select>
              <button
                class="delegation-page__button"
                type="button"
                :disabled="scopeBusy || !selectedTemplateId || !selectedScopeNamespace || !selectedScopeConfig?.adminNamespaces.length"
                @click="void applyTemplate()"
              >
                覆盖应用到当前命名空间
              </button>
            </div>

            <template v-if="selectedTemplate">
              <div class="delegation-page__role-actions">
                <select v-model="selectedTemplateDepartmentId" class="delegation-page__input">
                  <option value="">选择部门加入模板</option>
                  <option v-for="department in departments" :key="department.directoryDepartmentId" :value="department.directoryDepartmentId">
                    {{ department.integrationName }} / {{ department.departmentFullPath || department.departmentName }}
                  </option>
                </select>
                <button class="delegation-page__button" type="button" :disabled="scopeBusy || !selectedTemplateDepartmentId" @click="void updateTemplateDepartment('assign')">
                  添加模板部门
                </button>
              </div>
              <div class="delegation-page__role-actions">
                <select v-model="selectedTemplateMemberGroupId" class="delegation-page__input">
                  <option value="">选择成员集加入模板</option>
                  <option v-for="group in memberGroups" :key="group.id" :value="group.id">
                    {{ group.name }} ({{ group.memberCount }})
                  </option>
                </select>
                <button class="delegation-page__button" type="button" :disabled="scopeBusy || !selectedTemplateMemberGroupId" @click="void updateTemplateMemberGroup('assign')">
                  添加模板成员集
                </button>
              </div>

              <div v-if="selectedTemplate.departments.length > 0" class="delegation-page__scope-list">
                <article v-for="department in selectedTemplate.departments" :key="department.directoryDepartmentId" class="delegation-page__scope-card">
                  <strong>{{ selectedTemplate.name }}</strong>
                  <span>{{ department.integrationName }}</span>
                  <p>{{ department.departmentFullPath || department.departmentName }}</p>
                  <button
                    class="delegation-page__button delegation-page__button--danger"
                    type="button"
                    :disabled="scopeBusy"
                    @click="void updateTemplateDepartment('unassign', department.directoryDepartmentId)"
                  >
                    移除模板部门
                  </button>
                </article>
              </div>
              <div v-if="selectedTemplate.memberGroups.length > 0" class="delegation-page__scope-list">
                <article v-for="group in selectedTemplate.memberGroups" :key="group.id" class="delegation-page__scope-card">
                  <strong>{{ selectedTemplate.name }}</strong>
                  <span>{{ group.name }}</span>
                  <p>{{ group.description || `成员 ${group.memberCount}` }}</p>
                  <button
                    class="delegation-page__button delegation-page__button--danger"
                    type="button"
                    :disabled="scopeBusy"
                    @click="void updateTemplateMemberGroup('unassign', group.id)"
                  >
                    移除模板成员集
                  </button>
                </article>
              </div>
              <div
                v-if="selectedTemplate.departments.length === 0 && selectedTemplate.memberGroups.length === 0"
                class="delegation-page__empty"
              >
                当前模板还没有任何部门或成员集范围。
              </div>
            </template>
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
import { computed, onMounted, ref } from 'vue'
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

type ScopeAssignment = {
  id: string
  namespace: string
  directoryDepartmentId: string
  integrationId: string
  integrationName: string
  provider: string
  corpId: string | null
  externalDepartmentId: string
  departmentName: string
  departmentFullPath: string | null
  departmentActive: boolean
}

type GroupAssignment = {
  id: string
  namespace: string
  groupId: string
  name: string
  description: string | null
  memberCount: number
}

type DepartmentCatalogItem = {
  directoryDepartmentId: string
  integrationId: string
  integrationName: string
  provider: string
  corpId: string | null
  externalDepartmentId: string
  departmentName: string
  departmentFullPath: string | null
  departmentActive: boolean
}

type MemberGroupSummary = {
  id: string
  name: string
  description: string | null
  createdBy: string | null
  updatedBy: string | null
  createdAt: string
  updatedAt: string
  memberCount: number
}

type MemberGroupMember = {
  id: string
  email: string
  name: string | null
  role: string
  isActive: boolean
  isAdmin: boolean
  roles: string[]
  platformAdminEnabled: boolean
  attendanceAdminEnabled: boolean
  businessRoleIds: string[]
  dingtalkLoginEnabled: boolean
  directoryLinked: boolean
}

type MemberGroupDetail = MemberGroupSummary & {
  members: MemberGroupMember[]
}

type DelegationSummary = {
  actorId: string
  isPlatformAdmin: boolean
  delegableNamespaces: string[]
  roleCatalog: RoleCatalogItem[]
  scopeAssignments: ScopeAssignment[]
  groupAssignments: GroupAssignment[]
}

type DelegatedUserAccess = {
  actorId: string
  isPlatformAdmin: boolean
  delegableNamespaces: string[]
  roleCatalog: RoleCatalogItem[]
  scopeAssignments: ScopeAssignment[]
  groupAssignments: GroupAssignment[]
  memberGroups: MemberGroupSummary[]
  user: ManagedUser
  roles: string[]
  delegableRoles: string[]
}

type DelegatedAdminScopeConfig = {
  actorId: string
  user: ManagedUser
  adminNamespaces: string[]
  scopeAssignments: ScopeAssignment[]
  groupAssignments: GroupAssignment[]
}

type ScopeTemplateSummary = {
  id: string
  name: string
  description: string | null
  createdBy: string | null
  updatedBy: string | null
  createdAt: string
  updatedAt: string
  departmentCount: number
}

type ScopeTemplateDetail = ScopeTemplateSummary & {
  departments: DepartmentCatalogItem[]
  memberGroups: MemberGroupSummary[]
}

const loading = ref(false)
const busy = ref(false)
const scopeBusy = ref(false)
const groupBusy = ref(false)
const status = ref('')
const statusTone = ref<'info' | 'error'>('info')
const search = ref('')
const departmentSearch = ref('')
const templateSearch = ref('')
const templateName = ref('')
const templateDescription = ref('')
const memberGroupSearch = ref('')
const memberGroupName = ref('')
const memberGroupDescription = ref('')
const users = ref<ManagedUser[]>([])
const departments = ref<DepartmentCatalogItem[]>([])
const templates = ref<ScopeTemplateSummary[]>([])
const memberGroups = ref<MemberGroupSummary[]>([])
const selectedUserId = ref('')
const selectedRoleId = ref('')
const selectedScopeNamespace = ref('')
const selectedDepartmentId = ref('')
const selectedAudienceGroupId = ref('')
const selectedTemplateDepartmentId = ref('')
const selectedTemplateMemberGroupId = ref('')
const selectedTemplateId = ref('')
const selectedMemberGroupId = ref('')
const summary = ref<DelegationSummary | null>(null)
const selectedAccess = ref<DelegatedUserAccess | null>(null)
const selectedScopeConfig = ref<DelegatedAdminScopeConfig | null>(null)
const selectedTemplate = ref<ScopeTemplateDetail | null>(null)
const selectedMemberGroup = ref<MemberGroupDetail | null>(null)

const hasSelectedMemberGroup = computed(() => (
  !!selectedMemberGroupId.value
  && memberGroups.value.some((group) => group.id === selectedMemberGroupId.value)
))

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

async function loadDepartments(): Promise<void> {
  if (!summary.value?.isPlatformAdmin) return
  scopeBusy.value = true
  try {
    const params = new URLSearchParams()
    if (departmentSearch.value) params.set('q', departmentSearch.value)
    const response = await apiFetch(`/api/admin/role-delegation/departments${params.size ? `?${params.toString()}` : ''}`)
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载部门目录失败'))
    }
    const data = payload.data as { items?: DepartmentCatalogItem[] } | undefined
    departments.value = Array.isArray(data?.items) ? data.items : []
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载部门目录失败', 'error')
  } finally {
    scopeBusy.value = false
  }
}

async function loadMemberGroups(): Promise<void> {
  if (!summary.value?.isPlatformAdmin) return
  groupBusy.value = true
  try {
    const params = new URLSearchParams()
    if (memberGroupSearch.value) params.set('q', memberGroupSearch.value)
    const response = await apiFetch(`/api/admin/role-delegation/member-groups${params.size ? `?${params.toString()}` : ''}`)
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载平台成员集失败'))
    }
    const data = payload.data as { items?: MemberGroupSummary[] } | undefined
    memberGroups.value = Array.isArray(data?.items) ? data.items : []
    const selectedStillExists = memberGroups.value.some((group) => group.id === selectedMemberGroupId.value)
    if (selectedMemberGroupId.value && !selectedStillExists) {
      selectedMemberGroupId.value = ''
      selectedMemberGroup.value = null
    }
    if (selectedMemberGroupId.value && selectedStillExists) {
      await selectMemberGroup(selectedMemberGroupId.value)
    } else if (memberGroups.value.length > 0) {
      await selectMemberGroup(memberGroups.value[0].id)
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载平台成员集失败', 'error')
  } finally {
    groupBusy.value = false
  }
}

async function selectMemberGroup(groupId: string): Promise<void> {
  selectedMemberGroupId.value = groupId
  if (!summary.value?.isPlatformAdmin || !groupId) {
    selectedMemberGroup.value = null
    return
  }
  const response = await apiFetch(`/api/admin/role-delegation/member-groups/${encodeURIComponent(groupId)}`)
  const payload = await readJson(response)
  if (!response.ok || payload.ok !== true) {
    throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载平台成员集详情失败'))
  }
  selectedMemberGroup.value = (payload.data as { item: MemberGroupDetail }).item
}

async function createMemberGroup(): Promise<void> {
  if (!summary.value?.isPlatformAdmin || !memberGroupName.value.trim()) return
  groupBusy.value = true
  try {
    const response = await apiFetch('/api/admin/role-delegation/member-groups', {
      method: 'POST',
      body: JSON.stringify({
        name: memberGroupName.value,
        description: memberGroupDescription.value,
      }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '创建平台成员集失败'))
    }
    const item = (payload.data as { item: MemberGroupDetail }).item
    memberGroupName.value = ''
    memberGroupDescription.value = ''
    await loadMemberGroups()
    await selectMemberGroup(item.id)
    setStatus('平台成员集已创建')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '创建平台成员集失败', 'error')
  } finally {
    groupBusy.value = false
  }
}

async function loadTemplates(): Promise<void> {
  if (!summary.value?.isPlatformAdmin) return
  scopeBusy.value = true
  try {
    const params = new URLSearchParams()
    if (templateSearch.value) params.set('q', templateSearch.value)
    const response = await apiFetch(`/api/admin/role-delegation/scope-templates${params.size ? `?${params.toString()}` : ''}`)
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载范围模板失败'))
    }
    const data = payload.data as { items?: ScopeTemplateSummary[] } | undefined
    templates.value = Array.isArray(data?.items) ? data.items : []
    if (!selectedTemplateId.value && templates.value.length > 0) {
      await selectTemplate(templates.value[0].id)
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载范围模板失败', 'error')
  } finally {
    scopeBusy.value = false
  }
}

async function selectTemplate(templateId: string): Promise<void> {
  if (!summary.value?.isPlatformAdmin) return
  selectedTemplateId.value = templateId
  selectedTemplateDepartmentId.value = ''
  selectedTemplateMemberGroupId.value = ''
  if (!templateId) {
    selectedTemplate.value = null
    return
  }
  const response = await apiFetch(`/api/admin/role-delegation/scope-templates/${encodeURIComponent(templateId)}`)
  const payload = await readJson(response)
  if (!response.ok || payload.ok !== true) {
    throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载范围模板详情失败'))
  }
  selectedTemplate.value = (payload.data as { item: ScopeTemplateDetail }).item
}

async function createTemplate(): Promise<void> {
  if (!summary.value?.isPlatformAdmin || !templateName.value.trim()) return
  scopeBusy.value = true
  try {
    const response = await apiFetch('/api/admin/role-delegation/scope-templates', {
      method: 'POST',
      body: JSON.stringify({
        name: templateName.value,
        description: templateDescription.value,
      }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '创建范围模板失败'))
    }
    const item = (payload.data as { item: ScopeTemplateDetail }).item
    templateName.value = ''
    templateDescription.value = ''
    await loadTemplates()
    await selectTemplate(item.id)
    setStatus('组织范围模板已创建')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '创建范围模板失败', 'error')
  } finally {
    scopeBusy.value = false
  }
}

async function updateTemplateDepartment(action: 'assign' | 'unassign', directoryDepartmentId?: string): Promise<void> {
  if (!summary.value?.isPlatformAdmin || !selectedTemplateId.value) return
  const departmentId = directoryDepartmentId || selectedTemplateDepartmentId.value
  if (!departmentId) return
  scopeBusy.value = true
  try {
    const response = await apiFetch(`/api/admin/role-delegation/scope-templates/${encodeURIComponent(selectedTemplateId.value)}/departments/${action}`, {
      method: 'POST',
      body: JSON.stringify({ directoryDepartmentId: departmentId }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '更新模板部门失败'))
    }
    selectedTemplate.value = (payload.data as { item: ScopeTemplateDetail }).item
    if (action === 'assign') {
      selectedTemplateDepartmentId.value = ''
      setStatus('模板部门已添加')
    } else {
      setStatus('模板部门已移除')
    }
    await loadTemplates()
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '更新模板部门失败', 'error')
  } finally {
    scopeBusy.value = false
  }
}

async function updateTemplateMemberGroup(action: 'assign' | 'unassign', groupId?: string): Promise<void> {
  if (!summary.value?.isPlatformAdmin || !selectedTemplateId.value) return
  const effectiveGroupId = groupId || selectedTemplateMemberGroupId.value
  if (!effectiveGroupId) return
  scopeBusy.value = true
  try {
    const response = await apiFetch(`/api/admin/role-delegation/scope-templates/${encodeURIComponent(selectedTemplateId.value)}/member-groups/${action}`, {
      method: 'POST',
      body: JSON.stringify({ groupId: effectiveGroupId }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '更新模板成员集失败'))
    }
    selectedTemplate.value = (payload.data as { item: ScopeTemplateDetail }).item
    if (action === 'assign') {
      selectedTemplateMemberGroupId.value = ''
      setStatus('模板成员集已添加')
    } else {
      setStatus('模板成员集已移除')
    }
    await loadTemplates()
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '更新模板成员集失败', 'error')
  } finally {
    scopeBusy.value = false
  }
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
  selectedDepartmentId.value = ''
  selectedAudienceGroupId.value = ''
  try {
    const response = await apiFetch(`/api/admin/role-delegation/users/${encodeURIComponent(userId)}/access`)
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载成员委派权限失败'))
    }

    selectedAccess.value = payload.data as DelegatedUserAccess
    if (summary.value?.isPlatformAdmin) {
      await loadScopeConfig(userId)
    } else {
      selectedScopeConfig.value = null
    }
  } catch (error) {
    selectedAccess.value = null
    selectedScopeConfig.value = null
    setStatus(error instanceof Error ? error.message : '加载成员委派权限失败', 'error')
  }
}

async function loadScopeConfig(userId: string): Promise<void> {
  if (!summary.value?.isPlatformAdmin) return

  const response = await apiFetch(`/api/admin/role-delegation/users/${encodeURIComponent(userId)}/scopes`)
  const payload = await readJson(response)
  if (!response.ok || payload.ok !== true) {
    throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载管理员范围失败'))
  }

  selectedScopeConfig.value = payload.data as DelegatedAdminScopeConfig
  if (!selectedScopeConfig.value.adminNamespaces.includes(selectedScopeNamespace.value)) {
    selectedScopeNamespace.value = selectedScopeConfig.value.adminNamespaces[0] || ''
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
    if (summary.value?.isPlatformAdmin) {
      await loadScopeConfig(selectedUserId.value)
    }
    setStatus(action === 'assign' ? '角色已分配' : '角色已撤销')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '保存委派角色失败', 'error')
  } finally {
    busy.value = false
  }
}

async function updateScope(action: 'assign' | 'unassign', scope?: ScopeAssignment): Promise<void> {
  if (!summary.value?.isPlatformAdmin || !selectedUserId.value) return
  const namespace = action === 'assign' ? selectedScopeNamespace.value : scope?.namespace || ''
  const directoryDepartmentId = action === 'assign' ? selectedDepartmentId.value : scope?.directoryDepartmentId || ''
  if (!namespace || !directoryDepartmentId) return

  scopeBusy.value = true
  try {
    const response = await apiFetch(`/api/admin/role-delegation/users/${encodeURIComponent(selectedUserId.value)}/scopes/${action}`, {
      method: 'POST',
      body: JSON.stringify({ namespace, directoryDepartmentId }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '保存管理员范围失败'))
    }

    selectedScopeConfig.value = payload.data as DelegatedAdminScopeConfig
    if (action === 'assign') {
      selectedDepartmentId.value = ''
      setStatus('插件管理员部门范围已添加')
    } else {
      setStatus('插件管理员部门范围已移除')
    }
    await loadSummary()
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '保存管理员范围失败', 'error')
  } finally {
    scopeBusy.value = false
  }
}

async function updateScopeGroup(action: 'assign' | 'unassign', assignment?: GroupAssignment): Promise<void> {
  if (!summary.value?.isPlatformAdmin || !selectedUserId.value) return
  const namespace = action === 'assign' ? selectedScopeNamespace.value : assignment?.namespace || ''
  const groupId = action === 'assign' ? selectedAudienceGroupId.value : assignment?.groupId || ''
  if (!namespace || !groupId) return

  scopeBusy.value = true
  try {
    const response = await apiFetch(`/api/admin/role-delegation/users/${encodeURIComponent(selectedUserId.value)}/scope-groups/${action}`, {
      method: 'POST',
      body: JSON.stringify({ namespace, groupId }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '保存成员集范围失败'))
    }
    selectedScopeConfig.value = payload.data as DelegatedAdminScopeConfig
    if (action === 'assign') {
      selectedAudienceGroupId.value = ''
      setStatus('插件管理员成员集范围已添加')
    } else {
      setStatus('插件管理员成员集范围已移除')
    }
    await loadSummary()
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '保存成员集范围失败', 'error')
  } finally {
    scopeBusy.value = false
  }
}

async function updateUserMemberGroup(action: 'assign' | 'unassign', userIdOverride?: string): Promise<void> {
  const targetUserId = userIdOverride || selectedUserId.value
  if (!summary.value?.isPlatformAdmin || !targetUserId || !selectedMemberGroupId.value || !hasSelectedMemberGroup.value) return
  groupBusy.value = true
  try {
    const response = await apiFetch(`/api/admin/role-delegation/users/${encodeURIComponent(targetUserId)}/member-groups/${action}`, {
      method: 'POST',
      body: JSON.stringify({ groupId: selectedMemberGroupId.value }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '保存成员集成员失败'))
    }
    if (selectedAccess.value && selectedUserId.value === targetUserId) {
      selectedAccess.value = {
        ...selectedAccess.value,
        user: (payload.data as { user: ManagedUser }).user,
        roles: (payload.data as { roles: string[] }).roles,
        memberGroups: (payload.data as { memberGroups: MemberGroupSummary[] }).memberGroups,
      }
    }
    await loadMemberGroups()
    if (selectedMemberGroupId.value) {
      await selectMemberGroup(selectedMemberGroupId.value)
    }
    setStatus(action === 'assign' ? '成员已加入平台成员集' : '成员已移出平台成员集')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '保存成员集成员失败', 'error')
  } finally {
    groupBusy.value = false
  }
}

async function applyTemplate(): Promise<void> {
  if (!summary.value?.isPlatformAdmin || !selectedUserId.value || !selectedScopeNamespace.value || !selectedTemplateId.value) return
  scopeBusy.value = true
  try {
    const response = await apiFetch(`/api/admin/role-delegation/users/${encodeURIComponent(selectedUserId.value)}/scope-templates/apply`, {
      method: 'POST',
      body: JSON.stringify({
        namespace: selectedScopeNamespace.value,
        templateId: selectedTemplateId.value,
        mode: 'replace',
      }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '应用范围模板失败'))
    }

    selectedScopeConfig.value = payload.data as DelegatedAdminScopeConfig
    setStatus('范围模板已覆盖应用到该插件管理员命名空间')
    await loadSummary()
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '应用范围模板失败', 'error')
  } finally {
    scopeBusy.value = false
  }
}

onMounted(async () => {
  try {
    await loadSummary()
    if (summary.value?.isPlatformAdmin) {
      await loadDepartments()
      await loadTemplates()
      await loadMemberGroups()
    }
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
.delegation-page__scope-card span,
.delegation-page__scope-card p,
.delegation-page__hint,
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

.delegation-page__button--danger {
  background: #b91c1c;
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

.delegation-page__scope-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.delegation-page__scope-card {
  width: min(320px, 100%);
  display: grid;
  gap: 4px;
  padding: 12px;
  border: 1px solid #dbeafe;
  border-radius: 10px;
  background: #f8fbff;
}

@media (max-width: 960px) {
  .delegation-page__layout,
  .delegation-page__header {
    display: grid;
    grid-template-columns: 1fr;
  }
}
</style>
