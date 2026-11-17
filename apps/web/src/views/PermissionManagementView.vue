<template>
  <section class="permission-admin">
    <header class="permission-admin__header">
      <div>
        <h1 data-testid="permission-page-title">权限来源与例外</h1>
        <p>先检查选中用户的一项权限码，再查看直接授予、角色继承和历史授权。直接授权和模板补齐默认收起。</p>
        <p data-testid="permission-object-permissions">
          {{ permissionExceptionObjectNote }}
          <a :href="permissionExceptionMultitableHref" data-testid="permission-multitable-workbench-link">打开多维表</a>
        </p>
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
    <div v-if="recoveredOperationVisible" data-testid="permission-operation-recovery">
      <p data-testid="permission-operation-recovery-status">{{ recoveredOperationNote }}</p>
      <button
        class="permission-admin__button permission-admin__button--secondary"
        type="button"
        data-testid="permission-operation-recovery-reread"
        :disabled="busy || confirmBusy"
        @click="void rereadRecoveredOperation()"
      >
        只读重新读取
      </button>
    </div>

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

          <section class="permission-admin__section" data-testid="permission-checker" aria-labelledby="permission-checker-title">
            <div class="permission-admin__section-head">
              <h3 id="permission-checker-title">{{ permissionCheckMode === 'business' ? '业务检查' : '权限码预检' }}</h3>
            </div>
            <div class="permission-admin__role-actions" role="group" aria-label="检查方式">
              <button
                class="permission-admin__button"
                :class="{ 'permission-admin__button--secondary': permissionCheckMode !== 'business' }"
                type="button"
                data-testid="permission-check-mode-business"
                :aria-pressed="permissionCheckMode === 'business'"
                @click="permissionCheckMode = 'business'"
              >
                业务检查
              </button>
              <button
                class="permission-admin__button"
                :class="{ 'permission-admin__button--secondary': permissionCheckMode !== 'code' }"
                type="button"
                data-testid="permission-check-mode-code"
                :aria-pressed="permissionCheckMode === 'code'"
                @click="permissionCheckMode = 'code'"
              >
                权限码预检
              </button>
            </div>
            <PermissionBusinessChecker v-if="permissionCheckMode === 'business'" :user-id="selectedUserId" />
            <template v-if="permissionCheckMode === 'code'">
            <p class="permission-admin__hint" data-testid="permission-code-precheck-note">权限码预检没有业务上下文，不能当作业务动作是否可做的结论。</p>
            <p class="permission-admin__hint" data-testid="permission-checker-scope">{{ permissionCheckerScopeNote }}</p>
            <div class="permission-admin__role-actions">
              <select
                v-model="selectedPermissionCode"
                class="permission-admin__select"
                data-testid="permission-select"
                aria-label="选择要检查的权限码"
              >
                <option value="">请选择权限</option>
                <option v-for="permission in permissions" :key="permission.code" :value="permission.code">
                  {{ catalogOptionLabel(permission) }}
                </option>
              </select>
              <button
                class="permission-admin__button"
                type="button"
                data-testid="permission-checker-run"
                :disabled="permissionCheckerView.phase === 'pending' || !selectedPermissionCode"
                @click="void runPermissionChecker()"
              >
                {{ permissionCheckerView.phase === 'pending' ? '检查中...' : '检查这项权限码' }}
              </button>
            </div>
            <p
              v-if="permissionCheckerView.phase !== 'idle'"
              data-testid="permission-checker-result"
              :data-phase="permissionCheckerView.phase"
              class="permission-checker__result"
              role="status"
              aria-live="polite"
            >
              {{ permissionCheckerView.detail }}
            </p>
            </template>
          </section>

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
            <div v-if="inheritedSourceView.mode === 'roles'" data-testid="permission-inherited-roles">
              <p class="permission-admin__hint">移除直接授权不会去掉这些角色继承。要调整成员，请打开对应角色。</p>
              <p v-for="role in inheritedSourceView.roles" :key="role.roleId" :data-testid="`permission-inherited-role-${role.roleId}`">
                <a :href="role.href" data-testid="permission-inherited-role-link">{{ role.label }}</a>
                <span v-if="role.unknownName">角色名称没有随回读返回。</span>
                <span v-if="role.permissionsKnown">{{ role.permissionText }}</span>
                <span v-else>这个角色带回的权限码不完整，没有把空列表当成没有权限。</span>
              </p>
            </div>
            <p v-else-if="inheritedSourceView.mode === 'generic'" data-testid="permission-inherited-generic">
              这次没有返回具体角色。请打开角色页或成员页查看。
              <a :href="permissionExceptionRolesHref" data-testid="permission-inherited-roles-link">角色页</a>
              <a :href="permissionExceptionUsersHref" data-testid="permission-inherited-users-link">成员页</a>
            </p>
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
                  <button
                    class="permission-admin__link"
                    type="button"
                    :data-testid="`permission-legacy-clear-${permission}`"
                    :disabled="busy || !grantView.actionsEnabled"
                    @click="openLegacyConfirm(permission)"
                  >
                    清除这条历史授权
                  </button>
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

          <details class="permission-admin__section" data-testid="permission-exception-controls">
            <summary>直接授权与例外</summary>
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
                  <button class="permission-admin__button" type="button" data-testid="apply-permission-template-button" :disabled="busy || !selectedTemplateId || !grantView.actionsEnabled" @click="openTemplateConfirm()">
                    按模板补齐
                  </button>
                </div>
              </div>
              <div v-if="selectedTemplate" class="permission-admin__chips">
                <span class="permission-admin__chip" data-testid="permission-template-role-badge">参考角色（不会分配）</span>
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
                <h3>直接授权操作</h3>
                <div class="permission-admin__role-actions">
                  <button class="permission-admin__button" type="button" data-testid="grant-permission-button" :disabled="busy || !selectedPermissionCode || !grantView.actionsEnabled" @click="openDirectConfirm('grant')">
                    添加直接授权
                  </button>
                  <button class="permission-admin__button permission-admin__button--secondary" type="button" data-testid="revoke-permission-button" :disabled="busy || !selectedPermissionCode || !grantView.actionsEnabled" @click="openDirectConfirm('revoke')">
                    移除直接授权
                  </button>
                </div>
              </div>
              <p class="permission-admin__hint">授予和回收使用上方权限码预检里选中的权限码。移除直接授权不会去掉角色继承。</p>
              <label class="permission-admin__hint" data-testid="permission-operation-reason-label">
                原因（添加直接授权和按模板写入必填，最多 255 个字符，超出不会提交）
                <textarea
                  v-model="operationReason"
                  data-testid="permission-operation-reason"
                  rows="2"
                ></textarea>
              </label>
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
            </section>
          </details>

          <section class="permission-admin__section">
            <div class="permission-admin__section-head">
              <h3>权限目录</h3>
            </div>
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
    <PermissionExceptionConfirm
      v-if="operationDialogOpen && confirmCopy"
      :title="confirmCopy.title"
      :summary="confirmCopy.summary"
      :busy="confirmBusy"
      @confirm="void confirmPendingMutation()"
      @cancel="cancelOperationDialog()"
    />
    <span v-if="operationReady" data-testid="permission-operation-ready" hidden></span>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'
import { routeLocationKey } from 'vue-router'
import { useAuth } from '../composables/useAuth'
import { useAdminAuthorizationOperation } from '../composables/useAdminAuthorizationOperation'
import { apiFetch } from '../utils/api'
import {
  type AdminAuthorizationAction,
  type AdminAuthorizationEffectiveSource,
  type AdminAuthorizationImpact,
  type AdminAuthorizationReceipt,
  type AdminAuthorizationRequest,
  type AdminAuthorizationTransportRequest,
  type AdminAuthorizationTransportResponse,
} from '../utils/adminAuthorizationOperation'
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
import PermissionExceptionConfirm from './PermissionExceptionConfirm.vue'
import {
  PERMISSION_EXCEPTION_MULTITABLE_HREF,
  PERMISSION_EXCEPTION_OBJECT_NOTE,
  PERMISSION_EXCEPTION_ROLES_HREF,
  PERMISSION_EXCEPTION_USERS_HREF,
  describePermissionExceptionConfirm,
  describePermissionExceptionInheritedSources,
  describePermissionExceptionLegacyRevoke,
  readPermissionExceptionLegacyRevokeAcknowledgement,
} from './permissionExceptionSources'
import PermissionBusinessChecker from './PermissionBusinessChecker.vue'
import {
  PERMISSION_CHECKER_SCOPE_NOTE,
  idlePermissionCheckerView,
  pendingPermissionCheckerView,
  permissionCheckerRequestBody,
  permissionCheckerStillCurrent,
  readPermissionCheckerResponse,
  type PermissionCheckerView,
} from './permissionChecker'

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
const permissionCheckerView = ref<PermissionCheckerView>(idlePermissionCheckerView())
const permissionCheckMode = ref<'business' | 'code'>('code')
const permissionCheckerScopeNote = PERMISSION_CHECKER_SCOPE_NOTE
const permissionExceptionObjectNote = PERMISSION_EXCEPTION_OBJECT_NOTE
const permissionExceptionMultitableHref = PERMISSION_EXCEPTION_MULTITABLE_HREF
const permissionExceptionRolesHref = PERMISSION_EXCEPTION_ROLES_HREF
const permissionExceptionUsersHref = PERMISSION_EXCEPTION_USERS_HREF
const operationReason = ref('')
const operationDialogOpen = ref(false)
const operationSummaryText = ref('')
const confirmBusy = ref(false)
const frozenRequest = ref<AdminAuthorizationRequest | null>(null)
const submittedRequest = ref<AdminAuthorizationRequest | null>(null)
const recoveredOperationNote = ref('')
const recoveredOperationId = ref('')
const REASON_LIMIT = 255
let operationEpoch = 0
let confirmLatch = false
let previewAbort: AbortController | null = null
let liveInspection: UserPermissionInspection | null = null
let liveReadFailed = false
let lastTransportStatus = 0
let lastTransportBody: Record<string, unknown> | null = null
let lastTransportThrew = false
let permissionCheckerGeneration = 0
let permissionCheckerAbort: AbortController | null = null
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
const inheritedSourceView = computed(() => describePermissionExceptionInheritedSources({
  userId: selectedUserId.value,
  readable: !grantView.value.unread,
  inheritedRoles: selectedUserAccess.value?.inheritedRoles ?? null,
}))
const auth = useAuth()

function currentPrincipalId(): string {
  const reader = auth.getCurrentUser
  if (typeof reader !== 'function') return ''
  const user = reader()
  if (!user || typeof user !== 'object') return ''
  const id = (user as { id?: unknown }).id
  return typeof id === 'string' ? id.trim() : ''
}

async function authorizationTransport(
  request: AdminAuthorizationTransportRequest,
): Promise<AdminAuthorizationTransportResponse> {
  lastTransportThrew = false
  lastTransportStatus = 0
  lastTransportBody = null
  try {
    const response = await apiFetch(request.path, {
      method: request.method,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: request.signal,
    })
    const payload = await readJson(response)
    if (request.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    lastTransportStatus = response.status
    lastTransportBody = payload
    return { status: response.status, body: payload }
  } catch (error) {
    lastTransportThrew = true
    throw error
  }
}

async function verifyAuthorizationLive(): Promise<boolean> {
  liveInspection = null
  liveReadFailed = false
  const receipt = authorizationOperation.receipt.value
  const principalId = currentPrincipalId()
  if (!receipt || !principalId || selectedUserId.value !== receipt.targetUserId) return false
  const generation = userAccessReadGeneration.value
  const targetId = receipt.targetUserId
  try {
    const inspection = await loadUserAccess(targetId)
    if (currentPrincipalId() !== principalId) return false
    if (!accessReadStillCurrent(generation, userAccessReadGeneration.value, targetId, selectedUserId.value)) return false
    const remembered = submittedRequest.value
    if (
      remembered
      && remembered.targetUserId === receipt.targetUserId
      && !sameExceptionAction(remembered.action, receipt.action)
    ) {
      liveInspection = inspection
      return false
    }
    liveInspection = inspection
    return permissionSourceAgrees(receipt.action, receipt.impact, inspection)
  } catch {
    liveReadFailed = true
    return false
  }
}

const authorizationOperation = useAdminAuthorizationOperation({
  transport: authorizationTransport,
  getPrincipalId: () => currentPrincipalId(),
  getTargetId: () => selectedUserId.value.trim(),
  verifyLive: () => verifyAuthorizationLive(),
})

const confirmCopy = computed(() => {
  if (!operationDialogOpen.value || !frozenRequest.value) return null
  return {
    title: operationDialogTitle(frozenRequest.value),
    summary: operationSummaryText.value,
  }
})
const recoveredOperationVisible = computed(() => {
  if (!recoveredOperationNote.value || !selectedUserId.value) return false
  const phase = authorizationOperation.phase.value
  return phase === 'pending' || phase === 'committed' || phase === 'unverified_no_read'
})
const operationReady = computed(() => (
  operationDialogOpen.value
  && authorizationOperation.phase.value === 'awaiting_confirmation'
  && frozenRequest.value !== null
  && requestFingerprint(frozenRequest.value) === requestFingerprint(liveOperationRequest())
))
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

function selectedUserLabel(): string {
  const user = selectedUser.value
  if (!user) return selectedUserId.value
  return user.name || user.email || user.id
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
  invalidatePermissionChecker()
  const userId = unconfirmedReadbackUserId.value
  if (!userId || userId !== selectedUserId.value) return
  const phase = authorizationOperation.phase.value
  if (phase === 'pending' || phase === 'unverified_no_read' || phase === 'committed') {
    await authorizationOperation.lookup()
    await authorizationOperation.whenSettled()
    const request = submittedRequest.value
    if (
      request
      && request.targetUserId === userId
      && authorizationOperation.phase.value === 'committed'
    ) {
      await finishCommitted(request, userAccessReadGeneration.value)
      return
    }
  }
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
  invalidatePermissionChecker()
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
    if (selectedUserId.value) await reloadSelectedUserAccess()
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
  invalidatePermissionChecker()
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

function preparedReason(): { reason?: string } | { error: string } {
  const points = Array.from(operationReason.value.trim())
  if (points.length > REASON_LIMIT) {
    return { error: '原因超过 255 个字符，没有提交预览。' }
  }
  const reason = points.join('')
  return reason ? { reason } : {}
}

function requestFingerprint(request: AdminAuthorizationRequest | null): string {
  if (!request) return ''
  return JSON.stringify(request)
}

function liveOperationRequest(): AdminAuthorizationRequest | null {
  const frozen = frozenRequest.value
  if (!frozen || selectedUserId.value !== frozen.targetUserId) return null
  const action = frozen.action
  if ((action.kind === 'direct.grant' || action.kind === 'direct.revoke') && selectedPermissionCode.value !== action.code) {
    return null
  }
  if (action.kind === 'template.apply' && selectedTemplateId.value !== action.templateId) return null
  return buildOperationRequest(action, frozen.targetUserId)
}

function operationDialogTitle(request: AdminAuthorizationRequest): string {
  if (request.action.kind === 'direct.grant') return '确认添加直接授权'
  if (request.action.kind === 'direct.revoke') return '确认移除直接授权'
  if (request.action.kind === 'template.apply') return '确认按模板写入直接授权'
  if (request.action.kind === 'legacy.revoke') return '确认清除历史授权'
  return '确认授权操作'
}

function sourceKindLabel(source: AdminAuthorizationEffectiveSource): string {
  if (source.kind === 'direct') return '直接授权'
  if (source.kind === 'legacy') return '历史授权'
  if (source.kind === 'role') return `角色 ${source.id}`
  return '来源不明'
}

function describeImpactLines(impact: AdminAuthorizationImpact): string {
  const lines: string[] = []
  if (impact.sourceChanges.length === 0) {
    lines.push('来源不明，不能判断这次会改哪些权限。')
  }
  for (const change of impact.sourceChanges) {
    const name = change.source === 'role' ? '角色' : change.source === 'direct' ? '直接授权' : '历史授权'
    if (!change.changed) {
      lines.push(`${name} ${change.id} 没有变化。`)
      continue
    }
    lines.push(change.operation === 'assign'
      ? `将添加${name} ${change.id}。`
      : `将去掉${name} ${change.id}。`)
  }
  for (const item of impact.retainedOtherGrants) {
    const kinds = item.sources.map((source) => sourceKindLabel(source))
    lines.push(kinds.length > 0
      ? `仍保留 ${item.code}，来源：${kinds.join('、')}。`
      : `仍保留 ${item.code}，来源不明。`)
  }
  const seen = new Set<string>()
  for (const item of [...impact.effectiveBefore, ...impact.effectiveAfter]) {
    if (item.sources.length > 0 || seen.has(item.code)) continue
    seen.add(item.code)
    lines.push(`${item.code} 来源不明。`)
  }
  for (const change of impact.admissionChanges) {
    lines.push(`插件准入 ${change.namespace} 将变为 ${change.after ? '开通' : '关闭'}。`)
  }
  for (const warning of impact.warnings) {
    if (warning.trim()) lines.push(warning.trim())
  }
  return lines.join('')
}

function summaryWithImpact(staticSummary: string, request: AdminAuthorizationRequest, impact: AdminAuthorizationImpact): string {
  const roleChanged = impact.sourceChanges.some((change) => change.source === 'role' && change.changed)
  const admissionChanged = impact.admissionChanges.length > 0
  let summary = staticSummary
  if (roleChanged || admissionChanged) {
    summary = summary.split('角色不会改变，插件准入不会改变。').join('')
    summary = summary.split('角色不会改变，插件准入不会改变').join('')
    summary = summary.split('角色不会改变').join('')
    summary = summary.split('准入不会改变').join('')
  }
  if (!roleChanged && !admissionChanged) {
    if (request.action.kind === 'template.apply') {
      summary += '角色不会改变，插件准入不会改变。参考角色（不会分配）。'
    } else if (!summary.includes('角色不会改变')) {
      summary += '角色不会改变，插件准入不会改变。'
    }
  }
  if (request.action.kind === 'legacy.revoke' && !summary.includes('不是整项权限的总撤销')) {
    summary += '这不是整项权限的总撤销。'
  }
  return `${summary}${describeImpactLines(impact)}`
}

function permissionSourceAgrees(
  action: AdminAuthorizationAction,
  impact: AdminAuthorizationImpact,
  inspection: UserPermissionInspection,
): boolean {
  if (!inspection.subjectMatched || inspection.degraded || !inspection.sourceKnown) return false
  const roleChanged = impact.sourceChanges.some((change) => change.source === 'role' && change.changed)
  const admissionChanged = impact.admissionChanges.length > 0
  if (action.kind === 'template.apply') {
    if (roleChanged || admissionChanged) return false
    const codes = impact.sourceChanges
      .filter((change) => change.source === 'direct' && change.operation === 'assign')
      .map((change) => change.id)
    return codes.length > 0 && codes.every((code) => inspection.direct.includes(code))
  }
  if (roleChanged || admissionChanged) return false
  if (action.kind === 'direct.grant') return inspection.direct.includes(action.code)
  if (action.kind === 'direct.revoke') return !inspection.direct.includes(action.code)
  if (action.kind === 'legacy.revoke') {
    const directChanged = impact.sourceChanges.some((change) => change.source === 'direct' && change.changed)
    if (directChanged) return false
    return !inspection.legacy.includes(action.code)
  }
  return false
}

function sameExceptionAction(expected: AdminAuthorizationAction, actual: AdminAuthorizationAction): boolean {
  if (expected.kind === 'template.apply' || actual.kind === 'template.apply') {
    return expected.kind === 'template.apply'
      && actual.kind === 'template.apply'
      && expected.templateId === actual.templateId
  }
  if (expected.kind === 'direct.grant' || expected.kind === 'direct.revoke' || expected.kind === 'legacy.revoke') {
    return actual.kind === expected.kind && actual.code === expected.code
  }
  return false
}

function requestFromReceipt(receipt: AdminAuthorizationReceipt): AdminAuthorizationRequest | null {
  const action = receipt.action
  if (action.kind === 'direct.grant' || action.kind === 'direct.revoke' || action.kind === 'legacy.revoke') {
    return {
      targetUserId: receipt.targetUserId,
      action: { kind: action.kind, code: action.code },
      admissionChanges: [],
    }
  }
  if (action.kind === 'template.apply') {
    return {
      targetUserId: receipt.targetUserId,
      action: { kind: 'template.apply', templateId: action.templateId },
      admissionChanges: [],
    }
  }
  return null
}

function supportedRecoveryReceipt(receipt: AdminAuthorizationReceipt | null): AdminAuthorizationRequest | null {
  if (!receipt || receipt.targetUserId !== selectedUserId.value) return null
  return requestFromReceipt(receipt)
}

function staticConfirmSummary(request: AdminAuthorizationRequest): string {
  const label = selectedUserLabel()
  if (request.action.kind === 'direct.grant' || request.action.kind === 'direct.revoke') {
    return describePermissionExceptionConfirm({
      kind: request.action.kind === 'direct.grant' ? 'grant' : 'revoke',
      userId: request.targetUserId,
      userLabel: label,
      permission: request.action.code,
    }).summary
  }
  if (request.action.kind === 'template.apply') {
    const templateId = request.action.templateId
    const template = permissionTemplates.value.find((item) => item.id === templateId)
    return describePermissionExceptionConfirm({
      kind: 'template',
      userId: request.targetUserId,
      userLabel: label,
      templateId: request.action.templateId,
      templateName: template?.name || request.action.templateId,
      permissions: template ? [...template.permissions] : [],
    }).summary
  }
  if (request.action.kind === 'legacy.revoke') {
    return describePermissionExceptionConfirm({
      kind: 'legacy',
      userId: request.targetUserId,
      userLabel: label,
      permission: request.action.code,
    }).summary
  }
  return '来源不明，不能判断这次会改哪些权限。'
}

function buildOperationRequest(action: AdminAuthorizationAction, targetUserId: string): AdminAuthorizationRequest | null {
  const prepared = preparedReason()
  if ('error' in prepared) return null
  const needsReason = action.kind === 'direct.grant' || action.kind === 'template.apply'
  if (needsReason && !prepared.reason) return null
  return {
    targetUserId,
    action,
    admissionChanges: [],
    ...(prepared.reason ? { reason: prepared.reason } : {}),
  }
}

function rejectOverlongReason(): boolean {
  const prepared = preparedReason()
  if (!('error' in prepared)) return false
  setStatus(prepared.error, 'error')
  return true
}

function beginOperation(request: AdminAuthorizationRequest): void {
  if (busy.value || confirmLatch || confirmBusy.value || operationDialogOpen.value) return
  if (!currentPrincipalId()) {
    setStatus('当前操作者身份未读取，没有提交。', 'error')
    return
  }
  operationEpoch += 1
  const epoch = operationEpoch
  frozenRequest.value = request
  operationSummaryText.value = staticConfirmSummary(request)
  operationDialogOpen.value = true
  previewAbort?.abort()
  const abort = new AbortController()
  previewAbort = abort
  busy.value = true
  void runPreview(request, epoch, abort.signal)
}

async function runPreview(request: AdminAuthorizationRequest, epoch: number, signal: AbortSignal): Promise<void> {
  try {
    authorizationOperation.syncContext()
    await authorizationOperation.preview(request, signal)
    await authorizationOperation.whenSettled()
    if (epoch !== operationEpoch || signal.aborted) return
    if (selectedUserId.value !== request.targetUserId || currentPrincipalId() === '') return
    if (authorizationOperation.phase.value !== 'awaiting_confirmation') {
      const outcome = previewFailureMessage(request)
      permissionActionFeedback.value = { tone: 'error', message: outcome }
      setStatus(outcome, 'error')
      operationDialogOpen.value = false
      frozenRequest.value = null
      return
    }
    const impact = authorizationOperation.impact.value
    if (impact && frozenRequest.value && requestFingerprint(frozenRequest.value) === requestFingerprint(request)) {
      operationSummaryText.value = summaryWithImpact(staticConfirmSummary(request), request, impact)
    }
  } finally {
    if (!confirmBusy.value && (epoch === operationEpoch || !operationDialogOpen.value)) busy.value = false
  }
}

function previewFailureMessage(request: AdminAuthorizationRequest): string {
  if (authorizationOperation.detail.value === 'no_access' || authorizationOperation.phase.value === 'forbidden') {
    return `没有预览用户 ${request.targetUserId} 的这次授权。`
  }
  return `没有得到用户 ${request.targetUserId} 的授权预览，还不能确认。`
}

function cancelOperationDialog(): void {
  if (confirmLatch || confirmBusy.value) return
  operationEpoch += 1
  previewAbort?.abort()
  previewAbort = null
  operationDialogOpen.value = false
  frozenRequest.value = null
  busy.value = false
}

function openDirectConfirm(action: 'grant' | 'revoke'): void {
  if (busy.value || !selectedUserId.value || !selectedPermissionCode.value || !grantView.value.actionsEnabled) return
  if (rejectOverlongReason()) return
  const kind = action === 'grant' ? 'direct.grant' : 'direct.revoke'
  const request = buildOperationRequest(
    { kind, code: selectedPermissionCode.value },
    selectedUserId.value,
  )
  if (!request) {
    setStatus('添加直接授权和按模板写入需要填写原因。', 'error')
    return
  }
  beginOperation(request)
}

function openTemplateConfirm(): void {
  const template = selectedTemplate.value
  if (busy.value || !selectedUserId.value || !template || !grantView.value.actionsEnabled) return
  if (rejectOverlongReason()) return
  const request = buildOperationRequest(
    { kind: 'template.apply', templateId: template.id },
    selectedUserId.value,
  )
  if (!request) {
    setStatus('添加直接授权和按模板写入需要填写原因。', 'error')
    return
  }
  beginOperation(request)
}

function openLegacyConfirm(permission: string): void {
  if (busy.value || !selectedUserId.value || !permission || !grantView.value.actionsEnabled) return
  if (rejectOverlongReason()) return
  const request = buildOperationRequest(
    { kind: 'legacy.revoke', code: permission },
    selectedUserId.value,
  )
  if (!request) return
  beginOperation(request)
}

function markUnread(userId: string, generation: number): void {
  if (!accessReadStillCurrent(generation, userAccessReadGeneration.value, userId, selectedUserId.value)) return
  selectedUserAccess.value = unreadUserPermissionInspection(userId)
}

function showFeedback(message: string, tone: 'info' | 'error', template: boolean): void {
  if (template) permissionActionFeedback.value = null
  else permissionActionFeedback.value = { tone, message }
  setStatus(message, tone)
}

function actionCode(action: AdminAuthorizationAction): string {
  if (action.kind === 'direct.grant' || action.kind === 'direct.revoke' || action.kind === 'legacy.revoke') return action.code
  return ''
}

function rejectedAcknowledgementMessage(request: AdminAuthorizationRequest): string | null {
  const payload = lastTransportBody
  if (!payload) return null
  if (request.action.kind === 'template.apply') {
    const acknowledgement = readPermissionTemplateApplyAcknowledgement(payload, request.targetUserId, request.action.templateId)
    if (acknowledgement.accepted) return null
    return acknowledgement.message
  }
  if (request.action.kind === 'legacy.revoke') {
    const acknowledgement = readPermissionExceptionLegacyRevokeAcknowledgement(payload, request.targetUserId, request.action.code)
    if (acknowledgement.accepted) return null
    return acknowledgement.message
  }
  if (request.action.kind === 'direct.grant' || request.action.kind === 'direct.revoke') {
    const acknowledgement = readPermissionWriteAcknowledgement(payload, request.targetUserId, request.action.code)
    if (acknowledgement.accepted) return null
    return acknowledgement.message
  }
  return null
}

function showTransportFailure(request: AdminAuthorizationRequest, generation: number): void {
  const status = lastTransportThrew ? undefined : lastTransportStatus
  const errorMessage = typeof lastTransportBody?.error === 'string' ? lastTransportBody.error : undefined
  if (request.action.kind === 'legacy.revoke') {
    const outcome = describePermissionExceptionLegacyRevoke({
      requestedUserId: request.targetUserId,
      selectedUserId: selectedUserId.value,
      permission: request.action.code,
      ok: false,
      httpStatus: status,
      errorMessage,
    })
    if (outcome.offerReadOnlyReread) {
      unconfirmedReadbackUserId.value = request.targetUserId
      markUnread(request.targetUserId, generation)
    }
    showFeedback(outcome.message, 'error', false)
    return
  }
  if (request.action.kind === 'direct.grant' || request.action.kind === 'direct.revoke') {
    const outcome = describePermissionWrite({
      action: request.action.kind === 'direct.grant' ? 'grant' : 'revoke',
      requestedUserId: request.targetUserId,
      selectedUserId: selectedUserId.value,
      permission: request.action.code,
      ok: false,
      httpStatus: status,
      errorMessage: errorMessage || '权限操作失败',
      inspection: selectedUserAccess.value,
    })
    showFeedback(outcome.message, 'error', false)
    return
  }
  showFeedback(errorMessage || '应用权限模板失败', 'error', true)
}

function showPendingResult(request: AdminAuthorizationRequest, generation: number): void {
  const unknown = lastTransportThrew || lastTransportStatus === 0 || lastTransportStatus >= 500
  if (unknown) {
    if (request.action.kind === 'legacy.revoke') {
      const outcome = describePermissionExceptionLegacyRevoke({
        requestedUserId: request.targetUserId,
        selectedUserId: selectedUserId.value,
        permission: request.action.code,
        ok: false,
        httpStatus: lastTransportThrew ? undefined : lastTransportStatus,
      })
      if (outcome.offerReadOnlyReread) {
        unconfirmedReadbackUserId.value = request.targetUserId
        markUnread(request.targetUserId, generation)
      }
      showFeedback(outcome.message, 'error', false)
      return
    }
    unconfirmedReadbackUserId.value = request.targetUserId
    markUnread(request.targetUserId, generation)
    const outcome = describeUnconfirmedPermissionWrite(request.targetUserId)
    showFeedback(outcome.message, 'error', request.action.kind === 'template.apply')
    return
  }
  const rejected = rejectedAcknowledgementMessage(request)
  if (rejected) {
    markUnread(request.targetUserId, generation)
    if (request.action.kind === 'legacy.revoke') {
      const outcome = describePermissionExceptionLegacyRevoke({
        requestedUserId: request.targetUserId,
        selectedUserId: selectedUserId.value,
        permission: request.action.code,
        ok: true,
        writeAcknowledged: false,
        errorMessage: rejected,
      })
      showFeedback(outcome.message, outcome.tone, false)
      return
    }
    if (request.action.kind === 'direct.grant' || request.action.kind === 'direct.revoke') {
      const outcome = describePermissionWrite({
        action: request.action.kind === 'direct.grant' ? 'grant' : 'revoke',
        requestedUserId: request.targetUserId,
        selectedUserId: selectedUserId.value,
        permission: actionCode(request.action),
        ok: true,
        writeAcknowledged: false,
        errorMessage: rejected,
      })
      showFeedback(outcome.message, outcome.tone, false)
      return
    }
    showFeedback(rejected, 'error', true)
    return
  }
  unconfirmedReadbackUserId.value = request.targetUserId
  markUnread(request.targetUserId, generation)
  const outcome = describeUnconfirmedPermissionWrite(request.targetUserId)
  showFeedback(outcome.message, 'error', request.action.kind === 'template.apply')
}

function committedReceiptMatches(request: AdminAuthorizationRequest): boolean {
  const phase = authorizationOperation.phase.value
  if (phase !== 'committed' && phase !== 'verified') return false
  const receipt = authorizationOperation.receipt.value
  if (!receipt || receipt.targetUserId !== request.targetUserId) return false
  return sameExceptionAction(request.action, receipt.action)
}

function showDetachedUnknown(request: AdminAuthorizationRequest): void {
  const outcome = describeUnconfirmedPermissionWrite(request.targetUserId)
  const message = selectedUserId.value !== request.targetUserId
    ? `${outcome.message} 未覆盖当前选中用户 ${selectedUserId.value} 的状态`
    : outcome.message
  showFeedback(message, 'error', request.action.kind === 'template.apply')
}

async function reportDetached(request: AdminAuthorizationRequest, generation: number): Promise<void> {
  if (!committedReceiptMatches(request)) {
    showDetachedUnknown(request)
    return
  }
  const detachedAction = request.action
  if (detachedAction.kind === 'template.apply') {
    try {
      const template = permissionTemplates.value.find((item) => item.id === detachedAction.templateId)
      const inspection = await loadUserAccess(request.targetUserId)
      if (userAccessReadGeneration.value !== generation && selectedUserId.value === request.targetUserId) return
      const outcome = describePermissionTemplateApply({
        templateName: template?.name || detachedAction.templateId,
        requestedPermissions: template ? [...template.permissions] : [],
        inspection,
      })
      if (selectedUserId.value !== request.targetUserId) {
        setStatus(`${outcome.message} 未覆盖当前选中用户 ${selectedUserId.value} 的状态`, outcome.tone)
      }
    } catch {
      const outcome = describeUnconfirmedPermissionWrite(request.targetUserId)
      setStatus(outcome.message, 'error')
    }
    return
  }
  if (request.action.kind !== 'direct.grant' && request.action.kind !== 'direct.revoke' && request.action.kind !== 'legacy.revoke') return
  try {
    const inspection = await loadUserAccess(request.targetUserId)
    if (request.action.kind === 'legacy.revoke') {
      const outcome = describePermissionExceptionLegacyRevoke({
        requestedUserId: request.targetUserId,
        selectedUserId: selectedUserId.value,
        permission: request.action.code,
        ok: true,
        writeAcknowledged: true,
        inspection,
      })
      showFeedback(outcome.message, outcome.tone, false)
      return
    }
    const outcome = describePermissionWrite({
      action: request.action.kind === 'direct.grant' ? 'grant' : 'revoke',
      requestedUserId: request.targetUserId,
      selectedUserId: selectedUserId.value,
      permission: request.action.code,
      ok: true,
      writeAcknowledged: true,
      inspection,
    })
    showFeedback(outcome.message, outcome.tone, false)
  } catch {
    const outcome = describeUnconfirmedPermissionWrite(request.targetUserId)
    showFeedback(outcome.message, 'error', false)
  }
}

async function finishCommitted(request: AdminAuthorizationRequest, generation: number): Promise<void> {
  await authorizationOperation.verify()
  await authorizationOperation.whenSettled()
  if (selectedUserId.value !== request.targetUserId) {
    await reportDetached(request, generation)
    return
  }
  if (liveReadFailed || !liveInspection) {
    unconfirmedReadbackUserId.value = request.targetUserId
    markUnread(request.targetUserId, generation)
    const outcome = describeUnconfirmedPermissionWrite(request.targetUserId)
    showFeedback(outcome.message, 'error', request.action.kind === 'template.apply')
    return
  }
  const inspection = liveInspection
  const committedAction = request.action
  if (committedAction.kind === 'template.apply') {
    const template = permissionTemplates.value.find((item) => item.id === committedAction.templateId)
    const provenCodes = impactPermissionCodes(request)
    const outcome = describePermissionTemplateApply({
      templateName: template?.name || committedAction.templateId,
      requestedPermissions: provenCodes.length > 0 ? provenCodes : (template ? [...template.permissions] : []),
      inspection,
    })
    const stillCurrent = accessReadStillCurrent(generation, userAccessReadGeneration.value, request.targetUserId, selectedUserId.value)
    if (!stillCurrent) {
      if (selectedUserId.value !== request.targetUserId) {
        setStatus(`${outcome.message} 未覆盖当前选中用户 ${selectedUserId.value} 的状态`, outcome.tone)
      }
      return
    }
    selectedUserAccess.value = inspection
    permissionActionFeedback.value = null
    setStatus(outcome.message, outcome.tone)
    return
  }
  if (request.action.kind === 'legacy.revoke') {
    const outcome = describePermissionExceptionLegacyRevoke({
      requestedUserId: request.targetUserId,
      selectedUserId: selectedUserId.value,
      permission: request.action.code,
      ok: true,
      writeAcknowledged: true,
      inspection,
    })
    showFeedback(outcome.message, outcome.tone, false)
    applyPermissionReadback(generation, request.targetUserId, inspection, outcome.applyInspection)
    return
  }
  if (request.action.kind === 'direct.grant' || request.action.kind === 'direct.revoke') {
    const outcome = describePermissionWrite({
      action: request.action.kind === 'direct.grant' ? 'grant' : 'revoke',
      requestedUserId: request.targetUserId,
      selectedUserId: selectedUserId.value,
      permission: request.action.code,
      ok: true,
      writeAcknowledged: true,
      inspection,
    })
    showFeedback(outcome.message, outcome.tone, false)
    applyPermissionReadback(generation, request.targetUserId, inspection, outcome.applyInspection)
  }
}

async function presentRecoveredOperation(): Promise<void> {
  if (submittedRequest.value || confirmLatch || confirmBusy.value || operationDialogOpen.value) return
  const userId = selectedUserId.value
  const phase = authorizationOperation.phase.value
  if (!userId || (phase !== 'pending' && phase !== 'committed' && phase !== 'unverified_no_read')) return
  const receipt = authorizationOperation.receipt.value
  if (receipt && receipt.targetUserId !== userId) return
  if (phase === 'pending' || phase === 'unverified_no_read' || !receipt) {
    recoveredOperationNote.value = describeUnconfirmedPermissionWrite(userId).message
    return
  }
  const request = supportedRecoveryReceipt(receipt)
  if (!request) {
    recoveredOperationNote.value = '这次回执是角色或准入变更。权限来源页不能用当前读取确认它，也不会清除这条未完成记录。'
    return
  }
  const operationId = authorizationOperation.clientOperationId.value
  if (!operationId || recoveredOperationId.value === operationId) return
  recoveredOperationId.value = operationId
  recoveredOperationNote.value = describeUnconfirmedPermissionWrite(userId).message
  await finishCommitted(request, userAccessReadGeneration.value)
  if (selectedUserId.value !== userId) return
  if (authorizationOperation.phase.value === 'verified') {
    recoveredOperationNote.value = ''
    return
  }
  recoveredOperationNote.value = status.value || describeUnconfirmedPermissionWrite(userId).message
}

async function rereadRecoveredOperation(): Promise<void> {
  if (confirmLatch || confirmBusy.value) return
  const userId = selectedUserId.value
  if (!userId) return
  recoveredOperationId.value = ''
  const phase = authorizationOperation.phase.value
  if (phase === 'pending' || phase === 'unverified_no_read' || phase === 'committed') {
    await authorizationOperation.lookup()
    await authorizationOperation.whenSettled()
  }
  await presentRecoveredOperation()
}

function impactPermissionCodes(request: AdminAuthorizationRequest): string[] {
  const impact = authorizationOperation.impact.value
  if (!impact || request.action.kind !== 'template.apply') return []
  return impact.sourceChanges
    .filter((change) => change.source === 'direct' && change.operation === 'assign')
    .map((change) => change.id)
}

async function settleOperation(request: AdminAuthorizationRequest, generation: number): Promise<void> {
  if (selectedUserId.value !== request.targetUserId || currentPrincipalId() === '') {
    await reportDetached(request, generation)
    return
  }
  const phase = authorizationOperation.phase.value
  if (phase === 'validation_failed' || phase === 'forbidden') {
    showTransportFailure(request, generation)
    return
  }
  if (phase === 'pending' || phase === 'unverified_no_read') {
    showPendingResult(request, generation)
    return
  }
  if (phase === 'committed' || phase === 'verified') {
    await finishCommitted(request, generation)
  }
}

async function confirmPendingMutation(): Promise<void> {
  if (confirmLatch || confirmBusy.value) return
  const request = frozenRequest.value
  if (!request || !operationReady.value) return
  if (authorizationOperation.phase.value !== 'awaiting_confirmation') return
  if (selectedUserId.value !== request.targetUserId) return
  const principalId = currentPrincipalId()
  if (!principalId) return
  confirmLatch = true
  confirmBusy.value = true
  busy.value = true
  const generation = userAccessReadGeneration.value
  submittedRequest.value = request
  invalidatePermissionChecker()
  if (unconfirmedReadbackUserId.value === request.targetUserId) unconfirmedReadbackUserId.value = ''
  try {
    await authorizationOperation.confirm()
    await authorizationOperation.whenSettled()
    if (
      userAccessReadGeneration.value !== generation
      || currentPrincipalId() !== principalId
    ) {
      if (selectedUserId.value !== request.targetUserId || currentPrincipalId() !== principalId) {
        await reportDetached(request, generation)
      }
      return
    }
    await settleOperation(request, generation)
  } finally {
    confirmLatch = false
    confirmBusy.value = false
    busy.value = false
    operationDialogOpen.value = false
    frozenRequest.value = null
    operationEpoch += 1
  }
}

function invalidatePermissionChecker(): void {
  permissionCheckerGeneration += 1
  permissionCheckerAbort?.abort()
  permissionCheckerAbort = null
  permissionCheckerView.value = idlePermissionCheckerView()
}

async function runPermissionChecker(): Promise<void> {
  const userId = selectedUserId.value
  const permission = selectedPermissionCode.value.trim()
  if (!userId || !permission || permissionCheckerView.value.phase === 'pending') return
  permissionCheckerAbort?.abort()
  permissionCheckerGeneration += 1
  const generation = permissionCheckerGeneration
  const abort = new AbortController()
  permissionCheckerAbort = abort
  permissionCheckerView.value = pendingPermissionCheckerView(userId, permission)
  try {
    const response = await apiFetch('/api/permissions/check', {
      method: 'POST',
      body: JSON.stringify(permissionCheckerRequestBody(userId, permission)),
      signal: abort.signal,
    })
    const payload = await readJson(response)
    if (!permissionCheckerStillCurrent(
      generation,
      permissionCheckerGeneration,
      userId,
      permission,
      selectedUserId.value,
      selectedPermissionCode.value,
    )) return
    permissionCheckerView.value = readPermissionCheckerResponse({
      httpStatus: response.status,
      payload,
      requestedUserId: userId,
      requestedPermission: permission,
    })
  } catch {
    if (!permissionCheckerStillCurrent(
      generation,
      permissionCheckerGeneration,
      userId,
      permission,
      selectedUserId.value,
      selectedPermissionCode.value,
    )) return
    if (abort.signal.aborted) return
    permissionCheckerView.value = {
      phase: 'error',
      userId,
      permission,
      detail: `检查用户 ${userId} 的权限码 ${permission} 失败，本次没有结论。`,
    }
  }
}

onMounted(async () => {
  await loadAll()
})

onUnmounted(() => {
  invalidatePermissionChecker()
})

watch([selectedUserId, selectedPermissionCode], () => {
  invalidatePermissionChecker()
})

watch([selectedUserId, selectedPermissionCode, selectedTemplateId, operationReason], () => {
  authorizationOperation.syncContext()
  if (confirmLatch || confirmBusy.value || !operationDialogOpen.value) return
  operationEpoch += 1
  previewAbort?.abort()
  operationDialogOpen.value = false
  frozenRequest.value = null
  busy.value = false
})

watch(
  () => [
    selectedUserId.value,
    authorizationOperation.phase.value,
    authorizationOperation.clientOperationId.value,
  ] as const,
  () => {
    void presentRecoveredOperation()
  },
)

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
  min-width: 0;
  max-width: 100%;
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
  min-width: 0;
}

.permission-admin__layout > *,
.permission-admin__header,
.permission-admin__detail-head,
.permission-admin__section-head,
.permission-admin__actions,
.permission-admin__role-actions,
.permission-admin__pager,
.permission-admin__chips,
.permission-admin__catalog,
.permission-admin__permission,
.permission-admin__user,
.permission-admin__section,
.permission-admin__header > *,
.permission-admin__detail-head > *,
.permission-admin__section-head > *,
.permission-admin__actions > *,
.permission-admin__role-actions > *,
.permission-admin__permission > *,
.permission-admin__user > *,
.permission-admin__chips > * {
  min-width: 0;
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
  max-width: 100%;
  overflow-wrap: anywhere;
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
  min-width: 0;
  max-width: 100%;
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
  overflow-wrap: anywhere;
}

.permission-admin__user strong,
.permission-admin__user span,
.permission-admin__user small,
.permission-admin__detail-head h2,
.permission-admin__detail-head p,
.permission-admin__technical,
.permission-admin__technical code,
.permission-admin a,
.permission-checker__result,
.permission-admin__status,
.permission-admin__hint {
  overflow-wrap: anywhere;
}

.permission-admin__technical {
  color: #64748b;
}

.permission-checker__result {
  margin: 0;
  color: #0f172a;
}

.permission-checker__result[data-phase='error'],
.permission-checker__result[data-phase='forbidden'],
.permission-checker__result[data-phase='degraded'] {
  color: #b45309;
}

@media (max-width: 960px) {
  .permission-admin__layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .permission-admin__header,
  .permission-admin__detail-head,
  .permission-admin__section-head,
  .permission-admin__actions,
  .permission-admin__role-actions {
    flex-direction: column;
    align-items: stretch;
  }

  .permission-admin__search,
  .permission-admin__select,
  .permission-admin__header .permission-admin__button {
    width: 100%;
    max-width: 100%;
  }
}
</style>
