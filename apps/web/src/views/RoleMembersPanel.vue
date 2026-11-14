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
      v-if="authorizationDraft"
      :draft="authorizationDraft"
      :phrase="phrase"
      :busy="writeBusy"
      @update:phrase="phrase = $event"
      @confirm="void submitAuthorization()"
      @cancel="cancelAuthorization()"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import {
  LAST_PLATFORM_ADMIN_MESSAGE,
  ROLE_VERSION_MISMATCH_MESSAGE,
  adminAuthorizationStillCurrent,
  buildRoleMembershipAuthorization,
  type AdminAuthorizationDraft,
} from './AdminAuthorizationConfirm'
import AdminAuthorizationConfirmDialog from './AdminAuthorizationConfirmDialog.vue'
import {
  describeRoleMembershipWrite,
  roleWriteOutcomeFromPayload,
} from './adminUserRoleAction'
import {
  fetchRoleMemberAccess,
  fetchRoleMemberCandidates,
  fetchRoleMembers,
  ROLE_MEMBER_PAGE_SIZE,
} from './roleMembers'
import type { RoleMember } from './roleMembers'
import { apiFetch } from '../utils/api'

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
const accessGeneration = ref(0)
const epoch = ref(0)
const frozenHeldRoleIds = ref<string[]>([])
const frozenHeldRolesKnown = ref(false)
const focusGeneration = ref(0)
let disposed = false

const canGoNext = computed(() => total.value === null || page.value * ROLE_MEMBER_PAGE_SIZE < total.value)
const canSearchNext = computed(() => searchTotal.value !== null && searchPage.value * ROLE_MEMBER_PAGE_SIZE < searchTotal.value)
const memberActionDisabled = computed(() => (
  props.mutationsDisabled
  || props.actionsLocked
  || writeBusy.value
  || !selectedUserId.value
  || authorizationDraft.value !== null
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
  const open = authorizationDraft.value !== null
  authorizationDraft.value = null
  phrase.value = ''
  if (open && message) setFeedback(message, 'error')
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
}

function cancelAuthorization(): void {
  if (writeBusy.value) return
  authorizationDraft.value = null
  phrase.value = ''
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>
  } catch {
    return {}
  }
}

function errorRecord(payload: Record<string, unknown>): Record<string, unknown> | null {
  const error = payload.error
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null
  return error as Record<string, unknown>
}

function membershipChanged(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  return (data as { membershipChanged?: unknown }).membershipChanged === true
}

async function submitAuthorization(): Promise<void> {
  const draft = authorizationDraft.value
  if (!draft || writeBusy.value) return
  const action = draft.kind === 'unassign-role' ? 'unassign' : 'assign'
  // Leave, save, and role transition lock the parent before the role id changes.
  // A dialog that is still on screen must not post into that window.
  if (props.actionsLocked || props.mutationsDisabled) {
    if (props.mutationsDisabled) setFeedback('角色权限有未保存修改，成员变更已暂停。', 'error')
    authorizationDraft.value = null
    phrase.value = ''
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
    authorizationDraft.value = null
    phrase.value = ''
    return
  }

  const startedEpoch = epoch.value
  const frozenUserId = draft.targetUserId
  const frozenRoleId = draft.roleId
  writeBusy.value = true
  try {
    const body: Record<string, unknown> = { roleId: frozenRoleId }
    if (action === 'assign' && draft.expectedUpdatedAt) body.expectedUpdatedAt = draft.expectedUpdatedAt
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(frozenUserId)}/roles/${action}`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    const payload = await readJson(response)
    if (startedEpoch !== epoch.value || selectedUserId.value !== frozenUserId || props.roleId !== frozenRoleId) {
      authorizationDraft.value = null
      phrase.value = ''
      return
    }
    const error = errorRecord(payload)
    const code = typeof error?.code === 'string' ? error.code : ''
    if (response.status === 409 && code === 'LAST_PLATFORM_ADMIN') {
      setFeedback(LAST_PLATFORM_ADMIN_MESSAGE, 'error')
      authorizationDraft.value = null
      phrase.value = ''
      return
    }
    if (response.status === 409 && (code === 'ROLE_MODIFIED' || code === 'ROLE_VERSION_MISMATCH')) {
      setFeedback(ROLE_VERSION_MISMATCH_MESSAGE, 'error')
      authorizationDraft.value = null
      phrase.value = ''
      return
    }
    if (!response.ok || payload.ok !== true) {
      const message = typeof error?.message === 'string' && error.message
        ? error.message
        : '保存角色失败'
      const outcome = describeRoleMembershipWrite({
        action,
        requestedUserId: frozenUserId,
        selectedUserId: selectedUserId.value,
        roleId: frozenRoleId,
        persistedRoleIds: [],
        ok: false,
        errorMessage: message,
      })
      setFeedback(outcome.message, outcome.tone)
      authorizationDraft.value = null
      phrase.value = ''
      return
    }

    const result = roleWriteOutcomeFromPayload(payload.data, {
      action,
      requestedUserId: frozenUserId,
      selectedUserId: selectedUserId.value,
      roleId: frozenRoleId,
    })
    if (startedEpoch !== epoch.value || selectedUserId.value !== frozenUserId || props.roleId !== frozenRoleId) {
      authorizationDraft.value = null
      phrase.value = ''
      return
    }
    setFeedback(result.outcome.message, result.outcome.tone)
    authorizationDraft.value = null
    phrase.value = ''
    const changed = membershipChanged(payload.data)
    if (!(result.outcome.applySnapshot && result.outcome.tone === 'info' && changed)) return
    const reloaded = await load(frozenRoleId, page.value)
    if (startedEpoch !== epoch.value || props.roleId !== frozenRoleId) return
    if (!reloaded) {
      emit('membershipAdjusted', { roleId: frozenRoleId, delta: action === 'assign' ? 1 : -1 })
    }
  } catch (error) {
    if (startedEpoch !== epoch.value || selectedUserId.value !== frozenUserId || props.roleId !== frozenRoleId) return
    const message = error instanceof Error ? error.message : '保存角色失败'
    const outcome = describeRoleMembershipWrite({
      action,
      requestedUserId: frozenUserId,
      selectedUserId: selectedUserId.value,
      roleId: frozenRoleId,
      persistedRoleIds: [],
      ok: false,
      errorMessage: message,
    })
    setFeedback(outcome.message, outcome.tone)
    authorizationDraft.value = null
    phrase.value = ''
  } finally {
    if (!disposed) writeBusy.value = false
  }
}

watch(() => props.roleId, (roleId, previous) => {
  accessGeneration.value += 1
  epoch.value += 1
  searchGeneration.value += 1
  if (previous !== undefined) {
    authorizationDraft.value = null
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
})

watch(() => props.actionsLocked, (locked) => {
  if (!locked || writeBusy.value) return
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
.role-members__search {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
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
.role-members__remove {
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
.role-members__pick:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
</style>
