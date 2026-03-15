<template>
  <div class="attendance__admin-section">
    <div class="attendance__admin-section-header">
      <h4>{{ tr('User Access', '用户权限') }}</h4>
      <div class="attendance__admin-actions">
        <button class="attendance__btn" :disabled="provisionLoading" @click="loadProvisioningUser">
          {{ provisionLoading ? tr('Loading...', '加载中...') : tr('Load', '加载') }}
        </button>
        <button class="attendance__btn attendance__btn--primary" :disabled="provisionLoading" @click="grantProvisioningRole">
          {{ provisionLoading ? tr('Working...', '处理中...') : tr('Assign role', '分配角色') }}
        </button>
        <button class="attendance__btn" :disabled="provisionLoading" @click="revokeProvisioningRole">
          {{ provisionLoading ? tr('Working...', '处理中...') : tr('Remove role', '移除角色') }}
        </button>
      </div>
    </div>
    <div class="attendance__admin-grid">
      <label class="attendance__field attendance__field--full" for="attendance-provision-search">
        <span>{{ tr('User search (email/name/id)', '用户搜索（邮箱/姓名/ID）') }}</span>
        <input
          id="attendance-provision-search"
          v-model="provisionSearchQuery"
          type="text"
          :placeholder="tr('Search users to avoid pasting UUIDs', '搜索用户，避免手工粘贴 UUID')"
          @keydown.enter.prevent="searchProvisionUsers(1)"
        />
      </label>
    </div>
    <div class="attendance__admin-actions">
      <button class="attendance__btn" :disabled="provisionSearchLoading" @click="searchProvisionUsers(1)">
        {{ provisionSearchLoading ? tr('Searching...', '搜索中...') : tr('Search', '搜索') }}
      </button>
      <button
        class="attendance__btn"
        :disabled="provisionSearchLoading || provisionSearchPage <= 1"
        @click="searchProvisionUsers(provisionSearchPage - 1)"
      >
        {{ tr('Prev', '上一页') }}
      </button>
      <button
        class="attendance__btn"
        :disabled="provisionSearchLoading || !provisionSearchHasNext"
        @click="searchProvisionUsers(provisionSearchPage + 1)"
      >
        {{ tr('Next', '下一页') }}
      </button>
      <span v-if="provisionSearchHasSearched" class="attendance__field-hint">
        {{ tr('Page', '页码') }} {{ provisionSearchPage }} · {{ provisionSearchTotal }} {{ tr('result(s)', '条结果') }}
      </span>
    </div>
    <div v-if="provisionSearchResults.length > 0" class="attendance__table-wrapper">
      <table class="attendance__table">
        <thead>
          <tr>
            <th>{{ tr('Email', '邮箱') }}</th>
            <th>{{ tr('Name', '姓名') }}</th>
            <th>{{ tr('User ID', '用户 ID') }}</th>
            <th>{{ tr('Actions', '操作') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="user in provisionSearchResults" :key="user.id">
            <td>{{ user.email }}</td>
            <td>{{ user.name || '--' }}</td>
            <td><code>{{ user.id.slice(0, 8) }}</code></td>
            <td class="attendance__table-actions">
              <button class="attendance__btn" @click="selectProvisionUser(user)">{{ tr('Select', '选择') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else-if="provisionSearchHasSearched" class="attendance__empty">{{ tr('No users found.', '未找到用户。') }}</p>
    <div class="attendance__admin-grid">
      <label class="attendance__field attendance__field--full" for="attendance-provision-user-id">
        <span>{{ tr('User ID (UUID)', '用户 ID（UUID）') }}</span>
        <input
          id="attendance-provision-user-id"
          v-model="provisionForm.userId"
          name="provisionUserId"
          type="text"
          :placeholder="tr('e.g. 0cdf4a9c-4fe1-471b-be08-854b683dc930', '例如 0cdf4a9c-4fe1-471b-be08-854b683dc930')"
        />
        <small v-if="provisionUserProfile" class="attendance__field-hint">
          {{ tr('Selected', '已选择') }}: {{ provisionUserProfile.email }}{{ provisionUserProfile.name ? ` (${provisionUserProfile.name})` : '' }}
        </small>
      </label>
      <label class="attendance__field" for="attendance-provision-role">
        <span>{{ tr('Role template', '角色模板') }}</span>
        <select id="attendance-provision-role" v-model="provisionForm.role" name="provisionRole">
          <option value="employee">{{ tr('employee', '员工') }}</option>
          <option value="approver">{{ tr('approver', '审批人') }}</option>
          <option value="admin">{{ tr('admin', '管理员') }}</option>
        </select>
      </label>
    </div>
    <p v-if="provisionStatusMessage" class="attendance__status" :class="{ 'attendance__status--error': provisionStatusKind === 'error' }">
      {{ provisionStatusMessage }}
    </p>
    <div v-if="provisionRoles.length > 0" class="attendance__chip-list">
      <span v-for="role in provisionRoles" :key="role" class="attendance__status-chip">
        {{ role }}
      </span>
    </div>
    <div v-if="provisionPermissions.length > 0" class="attendance__chip-list">
      <span v-for="perm in provisionPermissions" :key="perm" class="attendance__status-chip">
        {{ perm }}
      </span>
      <span v-if="provisionUserIsAdmin" class="attendance__status-chip">isAdmin=true</span>
    </div>
    <p v-else-if="provisionHasLoaded" class="attendance__empty">{{ tr('No permissions loaded.', '未加载到权限。') }}</p>
  </div>

  <div class="attendance__admin-section">
    <div class="attendance__admin-section-header">
      <h4>{{ tr('Batch Provisioning', '批量授权') }}</h4>
      <div class="attendance__admin-actions">
        <button
          class="attendance__btn"
          :disabled="provisionBatchLoading || provisionBatchPreviewLoading"
          @click="previewProvisionBatchUsers"
        >
          {{ provisionBatchPreviewLoading ? tr('Previewing...', '预览中...') : tr('Preview users', '预览用户') }}
        </button>
        <button class="attendance__btn attendance__btn--primary" :disabled="provisionBatchLoading" @click="grantProvisioningRoleBatch">
          {{ provisionBatchLoading ? tr('Working...', '处理中...') : tr('Assign role (batch)', '分配角色（批量）') }}
        </button>
        <button class="attendance__btn" :disabled="provisionBatchLoading" @click="revokeProvisioningRoleBatch">
          {{ provisionBatchLoading ? tr('Working...', '处理中...') : tr('Remove role (batch)', '移除角色（批量）') }}
        </button>
        <button class="attendance__btn" :disabled="provisionBatchLoading" @click="clearProvisionBatch">
          {{ tr('Clear', '清空') }}
        </button>
      </div>
    </div>
    <div class="attendance__admin-grid">
      <label class="attendance__field attendance__field--full" for="attendance-provision-batch-user-ids">
        <span>{{ tr('User IDs (UUIDs)', '用户 ID（UUID）') }}</span>
        <textarea
          id="attendance-provision-batch-user-ids"
          v-model="provisionBatchUserIdsText"
          rows="4"
          placeholder="uuid1\nuuid2\n..."
        />
        <small class="attendance__field-hint">
          {{ tr('Parsed', '已解析') }}: {{ provisionBatchIds.length }} {{ tr('user(s)', '个用户') }}
          <template v-if="provisionBatchInvalidIds.length">
            · {{ tr('Invalid', '无效') }}: {{ provisionBatchInvalidIds.length }}
          </template>
        </small>
      </label>
      <label class="attendance__field" for="attendance-provision-batch-role">
        <span>{{ tr('Role template', '角色模板') }}</span>
        <select id="attendance-provision-batch-role" v-model="provisionBatchRole" name="provisionBatchRole">
          <option value="employee">{{ tr('employee', '员工') }}</option>
          <option value="approver">{{ tr('approver', '审批人') }}</option>
          <option value="admin">{{ tr('admin', '管理员') }}</option>
        </select>
      </label>
    </div>
    <p
      v-if="provisionBatchStatusMessage"
      class="attendance__status"
      :class="{ 'attendance__status--error': provisionBatchStatusKind === 'error' }"
    >
      {{ provisionBatchStatusMessage }}
    </p>
    <p v-if="provisionBatchPreviewHasResult" class="attendance__field-hint">
      {{ tr('Preview', '预览') }}: {{ provisionBatchPreviewItems.length }}/{{ provisionBatchPreviewRequested }} {{ tr('found', '已找到') }}
      · {{ tr('Missing', '缺失') }} {{ provisionBatchPreviewMissingIds.length }}
      · {{ tr('Inactive', '未激活') }} {{ provisionBatchPreviewInactiveIds.length }}
    </p>
    <div v-if="provisionBatchPreviewItems.length > 0" class="attendance__table-wrapper">
      <table class="attendance__table">
        <thead>
          <tr>
            <th>{{ tr('Email', '邮箱') }}</th>
            <th>{{ tr('Name', '姓名') }}</th>
            <th>{{ tr('User ID', '用户 ID') }}</th>
            <th>{{ tr('Active', '启用') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in provisionBatchPreviewItems" :key="item.id">
            <td>{{ item.email }}</td>
            <td>{{ item.name || '--' }}</td>
            <td><code>{{ item.id.slice(0, 8) }}</code></td>
            <td>{{ item.is_active ? tr('yes', '是') : tr('no', '否') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="provisionBatchPreviewMissingIds.length > 0" class="attendance__field-hint">
      {{ tr('Missing user IDs', '缺失用户 ID') }}:
      <code>{{ provisionBatchPreviewMissingIds.slice(0, 6).join(', ') }}</code>
      <template v-if="provisionBatchPreviewMissingIds.length > 6"> ...</template>
    </p>
    <p v-if="provisionBatchAffectedIds.length > 0" class="attendance__field-hint">
      {{ tr('Affected user IDs', '受影响用户 ID') }}:
      <code>{{ provisionBatchAffectedIds.slice(0, 6).join(', ') }}</code>
      <template v-if="provisionBatchAffectedIds.length > 6"> ...</template>
    </p>
    <p v-if="provisionBatchUnchangedIds.length > 0" class="attendance__field-hint">
      {{ tr('Unchanged user IDs', '未变更用户 ID') }}:
      <code>{{ provisionBatchUnchangedIds.slice(0, 6).join(', ') }}</code>
      <template v-if="provisionBatchUnchangedIds.length > 6"> ...</template>
    </p>
  </div>
</template>

<script setup lang="ts">
import type { Ref } from 'vue'

type Translate = (en: string, zh: string) => string
type ProvisionRole = 'employee' | 'approver' | 'admin'
type ProvisionStatusKind = 'info' | 'error'
type MaybePromise<T> = T | Promise<T>

interface ProvisionSearchItem {
  id: string
  email: string
  name: string | null
  role: string
  is_active: boolean
  is_admin: boolean
  last_login_at: string | null
  created_at: string
}

interface ProvisionUserProfile {
  id: string
  email: string
  name: string | null
}

interface ProvisionBatchResolveItem {
  id: string
  email: string
  name: string | null
  is_active: boolean
}

interface ProvisionFormState {
  userId: string
  role: ProvisionRole
}

interface ProvisioningBindings {
  clearProvisionBatch: () => MaybePromise<void>
  grantProvisioningRole: () => MaybePromise<void>
  grantProvisioningRoleBatch: () => MaybePromise<void>
  loadProvisioningUser: () => MaybePromise<void>
  previewProvisionBatchUsers: () => MaybePromise<void>
  provisionBatchAffectedIds: Ref<string[]>
  provisionBatchIds: Ref<string[]>
  provisionBatchInvalidIds: Ref<string[]>
  provisionBatchLoading: Ref<boolean>
  provisionBatchPreviewHasResult: Ref<boolean>
  provisionBatchPreviewInactiveIds: Ref<string[]>
  provisionBatchPreviewItems: Ref<ProvisionBatchResolveItem[]>
  provisionBatchPreviewLoading: Ref<boolean>
  provisionBatchPreviewMissingIds: Ref<string[]>
  provisionBatchPreviewRequested: Ref<number>
  provisionBatchRole: Ref<ProvisionRole>
  provisionBatchStatusKind: Ref<ProvisionStatusKind>
  provisionBatchStatusMessage: Ref<string>
  provisionBatchUnchangedIds: Ref<string[]>
  provisionBatchUserIdsText: Ref<string>
  provisionForm: ProvisionFormState
  provisionHasLoaded: Ref<boolean>
  provisionLoading: Ref<boolean>
  provisionPermissions: Ref<string[]>
  provisionRoles: Ref<string[]>
  provisionSearchHasNext: Ref<boolean>
  provisionSearchHasSearched: Ref<boolean>
  provisionSearchLoading: Ref<boolean>
  provisionSearchPage: Ref<number>
  provisionSearchQuery: Ref<string>
  provisionSearchResults: Ref<ProvisionSearchItem[]>
  provisionSearchTotal: Ref<number>
  provisionStatusKind: Ref<ProvisionStatusKind>
  provisionStatusMessage: Ref<string>
  provisionUserIsAdmin: Ref<boolean>
  provisionUserProfile: Ref<ProvisionUserProfile | null>
  revokeProvisioningRole: () => MaybePromise<void>
  revokeProvisioningRoleBatch: () => MaybePromise<void>
  searchProvisionUsers: (page: number) => MaybePromise<void>
  selectProvisionUser: (user: ProvisionSearchItem) => MaybePromise<void>
}

const props = defineProps<{
  provisioning: ProvisioningBindings
  tr: Translate
}>()

const tr = props.tr
const clearProvisionBatch = () => props.provisioning.clearProvisionBatch()
const grantProvisioningRole = () => props.provisioning.grantProvisioningRole()
const grantProvisioningRoleBatch = () => props.provisioning.grantProvisioningRoleBatch()
const loadProvisioningUser = () => props.provisioning.loadProvisioningUser()
const previewProvisionBatchUsers = () => props.provisioning.previewProvisionBatchUsers()
const provisionBatchAffectedIds = props.provisioning.provisionBatchAffectedIds
const provisionBatchIds = props.provisioning.provisionBatchIds
const provisionBatchInvalidIds = props.provisioning.provisionBatchInvalidIds
const provisionBatchLoading = props.provisioning.provisionBatchLoading
const provisionBatchPreviewHasResult = props.provisioning.provisionBatchPreviewHasResult
const provisionBatchPreviewInactiveIds = props.provisioning.provisionBatchPreviewInactiveIds
const provisionBatchPreviewItems = props.provisioning.provisionBatchPreviewItems
const provisionBatchPreviewLoading = props.provisioning.provisionBatchPreviewLoading
const provisionBatchPreviewMissingIds = props.provisioning.provisionBatchPreviewMissingIds
const provisionBatchPreviewRequested = props.provisioning.provisionBatchPreviewRequested
const provisionBatchRole = props.provisioning.provisionBatchRole
const provisionBatchStatusKind = props.provisioning.provisionBatchStatusKind
const provisionBatchStatusMessage = props.provisioning.provisionBatchStatusMessage
const provisionBatchUnchangedIds = props.provisioning.provisionBatchUnchangedIds
const provisionBatchUserIdsText = props.provisioning.provisionBatchUserIdsText
const provisionForm = props.provisioning.provisionForm
const provisionHasLoaded = props.provisioning.provisionHasLoaded
const provisionLoading = props.provisioning.provisionLoading
const provisionPermissions = props.provisioning.provisionPermissions
const provisionRoles = props.provisioning.provisionRoles
const provisionSearchHasNext = props.provisioning.provisionSearchHasNext
const provisionSearchHasSearched = props.provisioning.provisionSearchHasSearched
const provisionSearchLoading = props.provisioning.provisionSearchLoading
const provisionSearchPage = props.provisioning.provisionSearchPage
const provisionSearchQuery = props.provisioning.provisionSearchQuery
const provisionSearchResults = props.provisioning.provisionSearchResults
const provisionSearchTotal = props.provisioning.provisionSearchTotal
const provisionStatusKind = props.provisioning.provisionStatusKind
const provisionStatusMessage = props.provisioning.provisionStatusMessage
const provisionUserIsAdmin = props.provisioning.provisionUserIsAdmin
const provisionUserProfile = props.provisioning.provisionUserProfile
const revokeProvisioningRole = () => props.provisioning.revokeProvisioningRole()
const revokeProvisioningRoleBatch = () => props.provisioning.revokeProvisioningRoleBatch()
const searchProvisionUsers = (page: number) => props.provisioning.searchProvisionUsers(page)
const selectProvisionUser = (user: ProvisionSearchItem) => props.provisioning.selectProvisionUser(user)
</script>

<style scoped>
.attendance__admin-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 16px;
}

.attendance__admin-section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.attendance__admin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.attendance__admin-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.attendance__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.attendance__field--full {
  grid-column: 1 / -1;
}

.attendance__field-hint {
  color: #666;
  font-size: 12px;
}

.attendance__btn {
  padding: 8px 14px;
  border-radius: 6px;
  border: 1px solid #d0d0d0;
  background: #fff;
  cursor: pointer;
}

.attendance__btn--primary {
  background: #1f6feb;
  border-color: #1f6feb;
  color: #fff;
}

.attendance__btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.attendance__table-wrapper {
  width: 100%;
  overflow-x: auto;
}

.attendance__table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 12px;
}

.attendance__table th,
.attendance__table td {
  border-bottom: 1px solid #e0e0e0;
  padding: 8px;
  text-align: left;
  font-size: 13px;
}

.attendance__table-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.attendance__status {
  font-size: 13px;
}

.attendance__status--error {
  color: #c62828;
}

.attendance__chip-list {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.attendance__status-chip {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 4px 10px;
  background: #eef4ff;
  color: #345;
  font-size: 12px;
}

.attendance__empty {
  color: #888;
  font-size: 13px;
  margin-top: 8px;
}
</style>
