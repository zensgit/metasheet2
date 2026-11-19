<template>
  <section class="role-members">
    <div class="role-members__head">
      <h3>角色成员</h3>
      <button class="role-members__refresh" type="button" :disabled="actionsLocked" @click="reload()">刷新</button>
    </div>

    <form class="role-members__search" @submit.prevent="submitSearch()">
      <input
        v-model="queryDraft"
        class="role-members__query"
        data-role-member-query
        type="search"
        placeholder="姓名、账号或用户 ID"
        :disabled="actionsLocked"
      >
      <button class="role-members__search-button" data-role-member-search type="submit" :disabled="actionsLocked">搜索用户</button>
    </form>

    <p v-if="searchLoading" class="role-members__status">正在搜索用户...</p>
    <p v-else-if="searchFailed" class="role-members__status">用户搜索暂时不可用</p>
    <p v-else-if="searchSubmitted && searchItems.length === 0" class="role-members__status">没有匹配的用户</p>
    <ul v-else-if="searchItems.length > 0" class="role-members__list">
      <li v-for="candidate in searchItems" :key="`search-${candidate.id}`">
        <button
          class="role-members__pick"
          type="button"
          :data-user-id="candidate.id"
          data-role-member-candidate
          :aria-pressed="selectedUserId === candidate.id"
          :disabled="actionsLocked"
          @click="selectCandidate(candidate)"
        >
          {{ candidate.displayName }}
        </button>
      </li>
    </ul>
    <div v-if="searchSubmitted && !searchFailed" class="role-members__pager">
      <button class="role-members__search-prev" type="button" :disabled="actionsLocked || searchPage <= 1" @click="searchPrev()">上一页</button>
      <span>搜索第 {{ searchPage }} 页</span>
      <button class="role-members__search-next" type="button" :disabled="actionsLocked || !canSearchNext" @click="searchNext()">下一页</button>
    </div>

    <p v-if="selectedUserId" class="role-members__selected" :data-user-id="selectedUserId">已选用户：{{ selectedUserName }}（{{ selectedUserId }}）</p>
    <p v-else class="role-members__selected">尚未选择用户</p>

    <p v-if="mutationsDisabled" class="role-members__locked" data-role-members-locked>角色权限有未保存修改，成员变更已暂停。</p>

    <div class="role-members__write">
      <div class="role-members__actions">
        <button
          class="role-members__add"
          data-role-member-add
          type="button"
          :disabled="memberActionDisabled"
          @click="void openAuthorization('assign')"
        >
          加入此角色
        </button>
        <button
          class="role-members__remove"
          data-role-member-remove
          type="button"
          :disabled="memberActionDisabled"
          @click="void openAuthorization('unassign')"
        >
          移出此角色
        </button>
      </div>
      <div
        v-if="showOperationStatus"
        class="role-members__operation"
        data-testid="role-member-authorization-status"
      >
        <p data-testid="role-member-authorization-phase">{{ operationStatusText }}</p>
        <p v-if="operationPreviewText" data-testid="role-member-authorization-preview">{{ operationPreviewText }}</p>
        <button
          class="role-members__reread"
          type="button"
          data-testid="role-member-authorization-reread"
          :disabled="!rereadAllowed || submitting"
          @click="void rereadAuthorization()"
        >
          重新读取
        </button>
        <button
          v-if="dialogVisible"
          class="role-members__reread"
          type="button"
          data-testid="role-member-authorization-dismiss"
          :disabled="dialogBusy"
          @click="dismissAuthorization()"
        >
          关闭
        </button>
      </div>
    </div>

    <p v-if="feedback" class="role-members__feedback" :data-tone="feedbackTone">{{ feedback }}</p>

    <p v-if="loading" class="role-members__status">正在加载成员...</p>
    <p v-else-if="failed" class="role-members__status">成员名单暂时不可用</p>
    <p v-else-if="total === 0" class="role-members__status">暂无成员</p>
    <p v-else-if="items.length === 0" class="role-members__status">这一页没有成员</p>
    <ul v-else class="role-members__list">
      <li v-for="member in items" :key="member.id" class="role-members__item">
        <button
          class="role-members__pick"
          type="button"
          :data-user-id="member.id"
          data-role-member-row
          :aria-pressed="selectedUserId === member.id"
          :disabled="actionsLocked"
          @click="selectCandidate(member)"
        >
          {{ member.displayName }}
        </button>
      </li>
    </ul>

    <p v-if="total !== null && !loading && !failed" class="role-members__total">共 {{ total }} 人</p>

    <div class="role-members__pager">
      <button class="role-members__prev" type="button" :disabled="actionsLocked || page <= 1" @click="goPrev()">上一页</button>
      <span>第 {{ page }} 页</span>
      <button class="role-members__next" type="button" :disabled="actionsLocked || !canGoNext" @click="goNext()">下一页</button>
    </div>

    <AdminAuthorizationConfirmDialog
      v-if="authorizationDraft && dialogVisible"
      :draft="authorizationDraft"
      :phrase="phrase"
      :busy="dialogBusy"
      :phase="operationPhase"
      :impact="operationImpact"
      :outcome-text="operationOutcomeText"
      :allow-read-again="rereadAllowed"
      @update:phrase="phrase = $event"
      @confirm="void submitAuthorization()"
      @cancel="cancelAuthorization()"
      @close="dismissAuthorization()"
      @read-again="void rereadAuthorization()"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useAdminAuthorizationOperation } from '../composables/useAdminAuthorizationOperation'
import type { AdminAuthorizationOperationPhase } from '../composables/useAdminAuthorizationOperation'
import { useAuth } from '../composables/useAuth'
import type {
  AdminAuthorizationImpact,
  AdminAuthorizationTransportRequest,
  AdminAuthorizationTransportResponse,
} from '../utils/adminAuthorizationOperation'
import {
  adminAuthorizationStillCurrent,
  buildRoleMembershipAuthorization,
  type AdminAuthorizationDraft,
} from './AdminAuthorizationConfirm'
import AdminAuthorizationConfirmDialog from './AdminAuthorizationConfirmDialog.vue'
import {
  fetchRoleMemberAccess,
  fetchRoleMemberCandidates,
  fetchRoleMembers,
  ROLE_MEMBER_PAGE_SIZE,
} from './roleMembers'
import type { RoleMember } from './roleMembers'
import { apiFetch } from '../utils/api'

const ROLE_EFFECT_LIMIT = '这里只核对了角色成员。派生准入和范围清理只记在回执里。'

const props = defineProps<{
  roleId: string
  roleName: string
  permissionCodes: string[]
  expectedUpdatedAt: string | null
  namespacesByRoleId: Record<string, unknown>
  mutationsDisabled: boolean
  actionsLocked: boolean
  focusUserId: string
}>()

const emit = defineEmits<{
  rosterTotal: [payload: { roleId: string; total: number }]
  membershipAdjusted: [payload: { roleId: string; delta: number }]
}>()

const generation = ref(0)
const items = ref<RoleMember[]>([])
const total = ref<number | null>(null)
const failed = ref(false)
const loading = ref(false)
const page = ref(1)

const queryDraft = ref('')
const submittedQuery = ref('')
const searchItems = ref<RoleMember[]>([])
const searchTotal = ref<number | null>(null)
const searchPage = ref(1)
const searchLoading = ref(false)
const searchFailed = ref(false)
const searchSubmitted = ref(false)
const searchGeneration = ref(0)

const selectedUserId = ref('')
const selectedUserName = ref('')
const feedback = ref('')
const feedbackTone = ref<'info' | 'error'>('info')
const authorizationDraft = ref<AdminAuthorizationDraft | null>(null)
const phrase = ref('')
const writeBusy = ref(false)
const submitting = ref(false)
const dialogVisible = ref(false)
const accessGeneration = ref(0)
const epoch = ref(0)
const frozenHeldRoleIds = ref<string[]>([])
const frozenHeldRolesKnown = ref(false)
const focusGeneration = ref(0)
let disposed = false

const auth = useAuth()

function currentPrincipalId(): string {
  const id = auth.getCurrentUser()?.id
  return typeof id === 'string' ? id.trim() : ''
}

async function authorizationTransport(
  request: AdminAuthorizationTransportRequest,
): Promise<AdminAuthorizationTransportResponse> {
  const response = await apiFetch(request.path, {
    method: request.method,
    signal: request.signal,
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  })
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  return { status: response.status, body }
}

async function verifyRoleMembership(): Promise<boolean> {
  const receipt = operation.receipt.value
  const action = receipt?.action
  const roleAction = action && (action.kind === 'role.assign' || action.kind === 'role.revoke')
    ? action
    : null
  if (!receipt || !roleAction) return false
  if (receipt.targetUserId !== selectedUserId.value || roleAction.roleId !== props.roleId) return false
  const fact = await fetchRoleMemberAccess(receipt.targetUserId)
  if (!fact || fact.userId !== receipt.targetUserId || fact.heldRolesKnown !== true) return false
  if (receipt.targetUserId !== selectedUserId.value || roleAction.roleId !== props.roleId) return false
  const holds = fact.heldRoleIds.includes(roleAction.roleId)
  return roleAction.kind === 'role.assign' ? holds : !holds
}

const operation = useAdminAuthorizationOperation({
  transport: authorizationTransport,
  getPrincipalId: currentPrincipalId,
  getTargetId: () => selectedUserId.value,
  verifyLive: () => verifyRoleMembership(),
})

const operationPhase = computed(() => operation.phase.value)
const operationImpact = computed(() => operation.impact.value)
const blocksMemberWrite = computed(() => {
  const phase = operationPhase.value
  return phase === 'previewing'
    || phase === 'committing'
    || phase === 'pending'
    || phase === 'committed'
    || phase === 'unverified_no_read'
})
const dialogBusy = computed(() => (
  writeBusy.value
  || submitting.value
  || operationPhase.value === 'previewing'
  || operationPhase.value === 'committing'
))
const rereadAllowed = computed(() => {
  const phase = operationPhase.value
  return (phase === 'pending' || phase === 'committed' || phase === 'unverified_no_read')
    && Boolean(operation.clientOperationId.value)
})

const canGoNext = computed(() => total.value === null || page.value * ROLE_MEMBER_PAGE_SIZE < total.value)
const canSearchNext = computed(() => searchTotal.value !== null && searchPage.value * ROLE_MEMBER_PAGE_SIZE < searchTotal.value)
const memberActionDisabled = computed(() => (
  props.mutationsDisabled
  || props.actionsLocked
  || writeBusy.value
  || submitting.value
  || blocksMemberWrite.value
  || !selectedUserId.value
  || dialogVisible.value
))

function setFeedback(message: string, tone: 'info' | 'error'): void {
  feedback.value = message
  feedbackTone.value = tone
}

function selectCandidate(candidate: RoleMember): void {
  if (props.actionsLocked) return
  // A deep-link access read must not replace an explicit choice when it returns.
  focusGeneration.value += 1
  selectedUserId.value = candidate.id
  selectedUserName.value = candidate.displayName
}

function closePendingAuthorization(message?: string): void {
  const open = authorizationDraft.value !== null || dialogVisible.value
  authorizationDraft.value = null
  dialogVisible.value = false
  phrase.value = ''
  if (open && message) setFeedback(message, 'error')
}

function joinedLabels(values: readonly string[]): string {
  return values.length > 0 ? values.join('、') : '无'
}

function pushUnique(target: string[], value: string): void {
  const label = value.trim()
  if (!label || target.includes(label)) return
  target.push(label)
}

function receiptRecordsUnreadableEffects(impact: AdminAuthorizationImpact | null): boolean {
  if (!impact) return false
  if (impact.scopeCleanup.length > 0) return true
  return impact.admissionChanges.some((change) => change.cause === 'role_revoke')
}

function previewSummary(impact: AdminAuthorizationImpact | null): string {
  if (!impact) return ''
  const roleSources: string[] = []
  for (const change of impact.sourceChanges) {
    if (change.source === 'role') pushUnique(roleSources, change.id)
  }
  for (const permission of [...impact.effectiveBefore, ...impact.effectiveAfter]) {
    for (const source of permission.sources) {
      if (source.kind === 'role') pushUnique(roleSources, source.id)
    }
  }
  const explicitAdmissions = impact.admissionChanges
    .filter((change) => change.cause === 'explicit')
    .map((change) => `${change.after ? '开通' : '关闭'} ${change.namespace}`)
  const derivedAdmissions = impact.admissionChanges
    .filter((change) => change.cause === 'role_revoke')
    .map((change) => `${change.after ? '开通' : '关闭'} ${change.namespace}`)
  const retainedSources = impact.retainedOtherGrants.map((grant) => grant.code)
  return [
    `角色来源：${joinedLabels(roleSources)}`,
    `显式准入：${joinedLabels(explicitAdmissions)}`,
    `派生准入：${joinedLabels(derivedAdmissions)}`,
    `范围清理：${impact.scopeCleanup.length}`,
    `其他仍保留来源：${joinedLabels(retainedSources)}`,
  ].join(' ')
}

const operationPreviewText = computed(() => previewSummary(operationImpact.value))
const operationStatusText = computed(() => {
  const limited = receiptRecordsUnreadableEffects(operationImpact.value)
  const limit = limited ? ROLE_EFFECT_LIMIT : ''
  switch (operationPhase.value) {
    case 'previewing':
      return '正在读取服务器预览。'
    case 'awaiting_confirmation':
      return '请核对服务器预览后再确认。这次只变更角色。'
    case 'committing':
      return '正在提交。请不要再次确认。'
    case 'pending':
      return '提交结果还不能确认。请重新读取。不会再次提交。'
    case 'validation_failed':
      return '这次没有写入。请重新预览后再确认。'
    case 'forbidden':
      return '没有执行这次授权的权限。'
    case 'unverified_no_read':
      return `已有回执，但这次读取不能确认角色。${limit}`
    case 'committed':
      return `回执已记录。角色回读还没有对上。${limit}`
    case 'verified':
      return limited
        ? `已核对同一用户的角色成员状态。${ROLE_EFFECT_LIMIT}`
        : '已核对同一用户的角色成员状态。'
    default:
      return operation.detail.value === 'preview_failed' ? '服务器预览没有完成，尚未写入。' : ''
  }
})
const operationOutcomeText = computed(() => {
  const preview = operationPreviewText.value
  return preview ? `${operationStatusText.value} ${preview}` : operationStatusText.value
})
const showOperationStatus = computed(() => {
  const phase = operationPhase.value
  if (
    phase === 'previewing'
    || phase === 'committing'
    || phase === 'pending'
    || phase === 'committed'
    || phase === 'verified'
    || phase === 'unverified_no_read'
    || phase === 'validation_failed'
    || phase === 'forbidden'
  ) return true
  if (operation.detail.value === 'preview_failed') return true
  return dialogVisible.value && phase === 'awaiting_confirmation'
})

function contextStill(token: number, userId: string, roleId: string): boolean {
  return token === epoch.value && selectedUserId.value === userId && props.roleId === roleId && !disposed
}

function publishOutcome(): void {
  const message = operationStatusText.value
  if (!message) return
  const phase = operationPhase.value
  const tone = phase === 'verified' || phase === 'awaiting_confirmation' || phase === 'committed'
    ? 'info'
    : 'error'
  setFeedback(message, tone)
}

async function confirmRoleReadbackIfCommitted(): Promise<void> {
  if (operation.phase.value !== 'committed') return
  const token = epoch.value
  const userId = selectedUserId.value
  const roleId = props.roleId
  await operation.verify()
  await operation.whenSettled()
  if (!contextStill(token, userId, roleId) || !operation.verified.value) return
  const reloaded = await load(roleId, page.value)
  if (!contextStill(token, userId, roleId)) return
  if (reloaded || !frozenHeldRolesKnown.value) return
  const action = operation.receipt.value?.action
  const roleAction = action && (action.kind === 'role.assign' || action.kind === 'role.revoke')
    ? action
    : null
  if (!roleAction || roleAction.roleId !== roleId) return
  const held = frozenHeldRoleIds.value.includes(roleId)
  const delta = roleAction.kind === 'role.assign' ? (held ? 0 : 1) : (held ? -1 : 0)
  if (delta === 0) return
  emit('membershipAdjusted', { roleId, delta })
}

async function load(roleId: string, nextPage: number): Promise<boolean> {
  const token = generation.value + 1
  generation.value = token
  page.value = nextPage
  items.value = []
  total.value = null
  failed.value = false
  loading.value = true
  try {
    const result = await fetchRoleMembers(roleId, nextPage)
    if (token !== generation.value) return false
    items.value = result.items
    total.value = result.total
    page.value = result.page
    emit('rosterTotal', { roleId, total: result.total })
    return true
  } catch {
    if (token !== generation.value) return false
    items.value = []
    total.value = null
    failed.value = true
    return false
  } finally {
    if (token === generation.value) loading.value = false
  }
}

function reload(): void {
  if (props.actionsLocked) return
  void load(props.roleId, page.value)
}

function goPrev(): void {
  if (props.actionsLocked || page.value <= 1) return
  void load(props.roleId, page.value - 1)
}

function goNext(): void {
  if (props.actionsLocked || !canGoNext.value) return
  void load(props.roleId, page.value + 1)
}

async function loadSearch(query: string, nextPage: number): Promise<void> {
  const token = searchGeneration.value + 1
  searchGeneration.value = token
  searchPage.value = nextPage
  searchItems.value = []
  searchTotal.value = null
  searchFailed.value = false
  searchLoading.value = true
  searchSubmitted.value = true
  try {
    const result = await fetchRoleMemberCandidates(query, nextPage)
    if (token !== searchGeneration.value) return
    searchItems.value = result.items
    searchTotal.value = result.total
    searchPage.value = result.page
  } catch {
    if (token !== searchGeneration.value) return
    searchItems.value = []
    searchTotal.value = null
    searchFailed.value = true
  } finally {
    if (token === searchGeneration.value) searchLoading.value = false
  }
}

function submitSearch(): void {
  if (props.actionsLocked) return
  submittedQuery.value = queryDraft.value.trim()
  void loadSearch(submittedQuery.value, 1)
}

function searchPrev(): void {
  if (props.actionsLocked || searchPage.value <= 1) return
  void loadSearch(submittedQuery.value, searchPage.value - 1)
}

function searchNext(): void {
  if (props.actionsLocked || !canSearchNext.value) return
  void loadSearch(submittedQuery.value, searchPage.value + 1)
}

function buildDraft(
  action: 'assign' | 'unassign',
  userId: string,
  userName: string,
  heldRoleIds: readonly string[],
  heldRolesKnown: boolean,
): AdminAuthorizationDraft {
  return buildRoleMembershipAuthorization({
    action,
    userId,
    userName,
    roleId: props.roleId,
    roleName: props.roleName,
    permissionCodes: props.permissionCodes,
    expectedUpdatedAt: props.expectedUpdatedAt,
    heldRoleIds,
    heldRolesKnown,
    namespacesByRoleId: props.namespacesByRoleId,
    dropdownRoleId: props.roleId,
  })
}

async function openAuthorization(action: 'assign' | 'unassign'): Promise<void> {
  if (memberActionDisabled.value || !props.roleId) return
  const userId = selectedUserId.value
  const roleId = props.roleId
  const token = accessGeneration.value
  writeBusy.value = true
  let heldRoleIds: string[] = []
  let heldRolesKnown = false
  let userName = selectedUserName.value
  try {
    const fact = await fetchRoleMemberAccess(userId)
    if (token !== accessGeneration.value || selectedUserId.value !== userId || props.roleId !== roleId) return
    if (fact && fact.userId === userId) {
      heldRoleIds = fact.heldRoleIds
      heldRolesKnown = fact.heldRolesKnown
      if (fact.displayName) userName = fact.displayName
    }
  } catch {
    if (token !== accessGeneration.value || selectedUserId.value !== userId || props.roleId !== roleId) return
    heldRolesKnown = false
  } finally {
    if (!disposed) writeBusy.value = false
  }
  if (disposed) return
  if (token !== accessGeneration.value || selectedUserId.value !== userId || props.roleId !== roleId) return
  if (props.mutationsDisabled || props.actionsLocked) return
  selectedUserName.value = userName || userId
  frozenHeldRoleIds.value = heldRoleIds
  frozenHeldRolesKnown.value = heldRolesKnown
  phrase.value = ''
  authorizationDraft.value = buildDraft(action, userId, selectedUserName.value, heldRoleIds, heldRolesKnown)
  dialogVisible.value = true
  const openedEpoch = epoch.value
  operation.syncContext()
  await operation.preview({
    targetUserId: userId,
    action: {
      kind: action === 'assign' ? 'role.assign' : 'role.revoke',
      roleId,
    },
    admissionChanges: [],
  })
  await operation.whenSettled()
  if (openedEpoch !== epoch.value || selectedUserId.value !== userId || props.roleId !== roleId || disposed) return
  await confirmRoleReadbackIfCommitted()
  if (openedEpoch !== epoch.value || selectedUserId.value !== userId || props.roleId !== roleId || disposed) return
  publishOutcome()
}

function cancelAuthorization(): void {
  if (dialogBusy.value) return
  const phase: AdminAuthorizationOperationPhase = operation.phase.value
  if (
    phase === 'pending'
    || phase === 'committed'
    || phase === 'verified'
    || phase === 'unverified_no_read'
    || phase === 'committing'
  ) return
  closePendingAuthorization()
}

function dismissAuthorization(): void {
  if (dialogBusy.value) return
  dialogVisible.value = false
  const phase = operation.phase.value
  if (
    phase === 'pending'
    || phase === 'committed'
    || phase === 'verified'
    || phase === 'unverified_no_read'
  ) return
  authorizationDraft.value = null
  phrase.value = ''
}

async function rereadAuthorization(): Promise<void> {
  if (!rereadAllowed.value || submitting.value || dialogBusy.value) return
  const token = epoch.value
  const userId = selectedUserId.value
  const roleId = props.roleId
  submitting.value = true
  try {
    await operation.lookup()
    await operation.whenSettled()
    if (!contextStill(token, userId, roleId)) return
    await confirmRoleReadbackIfCommitted()
    if (!contextStill(token, userId, roleId)) return
    publishOutcome()
  } finally {
    if (!disposed) submitting.value = false
  }
}

async function submitAuthorization(): Promise<void> {
  const draft = authorizationDraft.value
  if (!draft || writeBusy.value || submitting.value) return
  if (operation.phase.value !== 'awaiting_confirmation') return
  const action = draft.kind === 'unassign-role' ? 'unassign' : 'assign'
  // Leave, save, and role transition lock the parent before the role id changes.
  // A dialog that is still on screen must not post into that window.
  if (props.actionsLocked || props.mutationsDisabled) {
    if (props.mutationsDisabled) setFeedback('角色权限有未保存修改，成员变更已暂停。', 'error')
    closePendingAuthorization()
    return
  }
  if (draft.requiresTypedPhrase && phrase.value !== draft.requiresTypedPhrase) return
  // The prompt froze the user and role. A later selection must not be written, and the old ids
  // must not be posted once the admin is looking at someone else.
  if (draft.targetUserId !== selectedUserId.value || draft.roleId !== props.roleId) {
    closePendingAuthorization('确认对象已变化，本次未写入。')
    return
  }
  const live = buildDraft(
    action,
    selectedUserId.value,
    selectedUserName.value,
    frozenHeldRoleIds.value,
    frozenHeldRolesKnown.value,
  )
  if (!adminAuthorizationStillCurrent(draft, live.fingerprint)) {
    setFeedback('确认对象已变化，本次未写入。', 'error')
    closePendingAuthorization()
    return
  }

  const token = epoch.value
  const frozenUserId = draft.targetUserId
  const frozenRoleId = draft.roleId
  submitting.value = true
  try {
    await operation.confirm()
    await operation.whenSettled()
    if (!contextStill(token, frozenUserId, frozenRoleId)) return
    await confirmRoleReadbackIfCommitted()
    if (!contextStill(token, frozenUserId, frozenRoleId)) return
    publishOutcome()
  } finally {
    if (!disposed) submitting.value = false
  }
}

watch(() => props.roleId, (roleId, previous) => {
  accessGeneration.value += 1
  epoch.value += 1
  searchGeneration.value += 1
  if (previous !== undefined) {
    authorizationDraft.value = null
    dialogVisible.value = false
    phrase.value = ''
    selectedUserId.value = ''
    selectedUserName.value = ''
    feedback.value = ''
    searchItems.value = []
    searchTotal.value = null
    searchFailed.value = false
    searchSubmitted.value = false
    searchLoading.value = false
    queryDraft.value = ''
    submittedQuery.value = ''
  }
  if (!roleId) return
  void load(roleId, 1)
}, { immediate: true })

watch(selectedUserId, () => {
  accessGeneration.value += 1
  epoch.value += 1
  closePendingAuthorization('确认对象已变化，本次未写入。')
  operation.syncContext()
  void recoverSelectedReceipt()
})

async function recoverSelectedReceipt(): Promise<void> {
  const token = epoch.value
  const userId = selectedUserId.value
  await operation.whenSettled()
  if (!contextStill(token, userId, props.roleId)) return
  if (operation.phase.value === 'committed') await confirmRoleReadbackIfCommitted()
  if (!contextStill(token, userId, props.roleId)) return
  const phase = operation.phase.value
  if (phase === 'idle' || phase === 'awaiting_confirmation' || phase === 'previewing') return
  publishOutcome()
}

watch(() => props.actionsLocked, (locked) => {
  if (!locked || writeBusy.value || submitting.value || operation.phase.value === 'committing') return
  closePendingAuthorization()
})

watch(() => props.mutationsDisabled, (disabled) => {
  if (!disabled || writeBusy.value || submitting.value || operation.phase.value === 'committing') return
  if (!dialogVisible.value && authorizationDraft.value === null) return
  setFeedback('角色权限有未保存修改，成员变更已暂停。', 'error')
  closePendingAuthorization()
})

onUnmounted(() => {
  disposed = true
  generation.value += 1
  searchGeneration.value += 1
  accessGeneration.value += 1
  epoch.value += 1
  focusGeneration.value += 1
})

watch(() => [props.roleId, props.focusUserId] as const, ([roleId, userId]) => {
  const generationToken = focusGeneration.value + 1
  focusGeneration.value = generationToken
  if (!roleId || !userId) return
  void (async () => {
    const fact = await fetchRoleMemberAccess(userId)
    if (disposed || generationToken !== focusGeneration.value) return
    if (props.roleId !== roleId || props.focusUserId !== userId) return
    if (!fact || fact.userId !== userId) return
    selectedUserId.value = fact.userId
    selectedUserName.value = fact.displayName
  })()
}, { immediate: true })
</script>

<style scoped>
.role-members {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-top: 1px solid #e5e7eb;
  padding-top: 12px;
}

.role-members__head,
.role-members__pager,
.role-members__actions,
.role-members__search,
.role-members__write,
.role-members__operation {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.role-members__write {
  align-items: flex-start;
}

.role-members__operation {
  flex: 1;
  flex-wrap: wrap;
  justify-content: flex-start;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 8px 10px;
}

.role-members__query {
  flex: 1;
  min-width: 0;
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  padding: 8px 10px;
  font: inherit;
}

.role-members__list {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.role-members__pick {
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  padding: 0;
}

.role-members__pick[aria-pressed='true'] {
  color: #1d4ed8;
  font-weight: 700;
}

.role-members__status,
.role-members__total,
.role-members__selected,
.role-members__locked,
.role-members__feedback {
  margin: 0;
  color: #64748b;
}

.role-members__locked,
.role-members__feedback[data-tone='error'] {
  color: #b45309;
}

.role-members__feedback[data-tone='info'] {
  color: #1d4ed8;
}

.role-members__refresh,
.role-members__prev,
.role-members__next,
.role-members__search-button,
.role-members__search-prev,
.role-members__search-next,
.role-members__add,
.role-members__remove,
.role-members__reread {
  border: none;
  border-radius: 10px;
  background: #e2e8f0;
  color: #0f172a;
  padding: 8px 12px;
  font: inherit;
  cursor: pointer;
}

.role-members__add {
  background: #2563eb;
  color: #fff;
}

.role-members__refresh:disabled,
.role-members__prev:disabled,
.role-members__next:disabled,
.role-members__search-button:disabled,
.role-members__search-prev:disabled,
.role-members__search-next:disabled,
.role-members__add:disabled,
.role-members__remove:disabled,
.role-members__reread:disabled,
.role-members__pick:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
</style>
