<template>
  <div class="attendance__admin-section">
    <div class="attendance__admin-section-header">
      <h4>{{ tr('Rule Sets', '规则集') }}</h4>
      <button class="attendance__btn" :disabled="ruleSetLoading" @click="loadRuleSets">
        {{ ruleSetLoading ? tr('Loading...', '加载中...') : tr('Reload rule sets', '重载规则集') }}
      </button>
    </div>
    <div class="attendance__admin-grid">
      <label class="attendance__field" for="attendance-rule-set-name">
        <span>{{ tr('Name', '名称') }}</span>
        <input id="attendance-rule-set-name" v-model="ruleSetForm.name" name="ruleSetName" type="text" />
      </label>
      <label class="attendance__field" for="attendance-rule-set-scope">
        <span>{{ tr('Scope', '范围') }}</span>
        <select id="attendance-rule-set-scope" v-model="ruleSetForm.scope" name="ruleSetScope">
          <option value="org">{{ tr('Org', '组织') }}</option>
          <option value="department">{{ tr('Department', '部门') }}</option>
          <option value="project">{{ tr('Project', '项目') }}</option>
          <option value="user">{{ tr('User', '用户') }}</option>
          <option value="custom">{{ tr('Custom', '自定义') }}</option>
        </select>
      </label>
      <label class="attendance__field" for="attendance-rule-set-version">
        <span>{{ tr('Version', '版本') }}</span>
        <input
          id="attendance-rule-set-version"
          v-model.number="ruleSetForm.version"
          name="ruleSetVersion"
          type="number"
          min="1"
        />
      </label>
      <label class="attendance__field attendance__field--checkbox" for="attendance-rule-set-default">
        <span>{{ tr('Default', '默认') }}</span>
        <input
          id="attendance-rule-set-default"
          v-model="ruleSetForm.isDefault"
          name="ruleSetDefault"
          type="checkbox"
        />
      </label>
      <label class="attendance__field attendance__field--full" for="attendance-rule-set-description">
        <span>{{ tr('Description', '描述') }}</span>
        <input
          id="attendance-rule-set-description"
          v-model="ruleSetForm.description"
          name="ruleSetDescription"
          type="text"
          :placeholder="tr('Optional', '可选')"
        />
      </label>
      <label class="attendance__field attendance__field--full" for="attendance-rule-set-config">
        <span>{{ tr('Config (JSON)', '配置（JSON）') }}</span>
        <textarea
          id="attendance-rule-set-config"
          v-model="ruleSetForm.config"
          name="ruleSetConfig"
          rows="5"
          placeholder='{"source":"dingtalk","mappings":{"columns":[{"sourceField":"1_on_duty_user_check_time","targetField":"firstInAt"}]}}'
        />
        <small class="attendance__field-hint">
          {{ tr('Paste a JSON object for source mappings, filters, or rule-specific settings. The template loader can seed a starter example.', '填写一个 JSON 对象，用于来源映射、过滤条件或规则专属设置。可先用模板加载器生成示例。') }}
        </small>
      </label>
    </div>
    <div class="attendance__admin-actions">
      <button class="attendance__btn attendance__btn--primary" :disabled="ruleSetSaving" @click="saveRuleSet">
        {{ ruleSetSaving ? tr('Saving...', '保存中...') : ruleSetEditingId ? tr('Update rule set', '更新规则集') : tr('Create rule set', '创建规则集') }}
      </button>
      <button class="attendance__btn" :disabled="ruleSetSaving" @click="loadRuleSetTemplate">
        {{ tr('Load template', '加载模板') }}
      </button>
      <button v-if="ruleSetEditingId" class="attendance__btn" :disabled="ruleSetSaving" @click="resetRuleSetForm">
        {{ tr('Cancel edit', '取消编辑') }}
      </button>
    </div>
    <div v-if="ruleSets.length === 0" class="attendance__empty">{{ tr('No rule sets yet.', '暂无规则集。') }}</div>
    <div v-else class="attendance__table-wrapper">
      <table class="attendance__table">
        <thead>
          <tr>
            <th>{{ tr('Name', '名称') }}</th>
            <th>{{ tr('Scope', '范围') }}</th>
            <th>{{ tr('Version', '版本') }}</th>
            <th>{{ tr('Default', '默认') }}</th>
            <th>{{ tr('Actions', '操作') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in ruleSets" :key="item.id">
            <td>{{ item.name }}</td>
            <td>{{ item.scope }}</td>
            <td>{{ item.version }}</td>
            <td>{{ item.isDefault ? tr('Yes', '是') : tr('No', '否') }}</td>
            <td class="attendance__table-actions">
              <button class="attendance__btn" @click="editRuleSet(item)">{{ tr('Edit', '编辑') }}</button>
              <button class="attendance__btn attendance__btn--danger" @click="deleteRuleSet(item.id)">
                {{ tr('Delete', '删除') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="attendance__admin-section">
    <div class="attendance__admin-section-header">
      <h4>{{ tr('Rule Template Library', '规则模板库') }}</h4>
      <button
        class="attendance__btn"
        :disabled="ruleTemplateLoading || ruleTemplateSaving || ruleTemplateRestoring"
        @click="loadRuleTemplates"
      >
        {{ ruleTemplateLoading ? tr('Loading...', '加载中...') : tr('Reload templates', '重载模板') }}
      </button>
    </div>
    <div class="attendance__admin-grid">
      <label class="attendance__field attendance__field--full" for="attendance-rule-template-system">
        <span>{{ tr('System templates (read-only)', '系统模板（只读）') }}</span>
        <textarea
          id="attendance-rule-template-system"
          v-model="ruleTemplateSystemText"
          name="ruleTemplateSystem"
          rows="14"
          readonly
        />
        <small class="attendance__field-hint">
          {{ tr('Reference only: these templates are generated by the system and cannot be edited here.', '仅供参考：这些模板由系统生成，不能在此直接修改。') }}
        </small>
      </label>
      <label class="attendance__field attendance__field--full" for="attendance-rule-template-library">
        <span>{{ tr('Library templates (JSON)', '库模板（JSON）') }}</span>
        <textarea
          id="attendance-rule-template-library"
          v-model="ruleTemplateLibraryText"
          name="ruleTemplateLibrary"
          rows="22"
          placeholder="[]"
        />
        <small class="attendance__field-hint">
          {{ tr('Edit the JSON array of templates here, then save to update the editable library.', '在此编辑模板 JSON 数组，然后保存到可编辑模板库。') }}
        </small>
      </label>
    </div>
    <div class="attendance__admin-actions">
      <button class="attendance__btn" :disabled="ruleTemplateSaving || ruleTemplateRestoring" @click="copySystemTemplates">
        {{ tr('Copy system to library', '复制系统模板到库') }}
      </button>
      <button
        class="attendance__btn attendance__btn--primary"
        :disabled="ruleTemplateSaving || ruleTemplateRestoring"
        @click="saveRuleTemplates"
      >
        {{ ruleTemplateSaving ? tr('Saving...', '保存中...') : tr('Save library', '保存模板库') }}
      </button>
    </div>
    <div class="attendance__admin-subsection">
      <div class="attendance__admin-section-header">
        <h5>{{ tr('Template Versions', '模板版本') }}</h5>
        <small class="attendance__field-hint">
          {{ tr('Click View to inspect a historical snapshot before restoring it.', '点击“查看”即可打开历史快照，再决定是否恢复。') }}
        </small>
      </div>
      <div v-if="ruleTemplateVersions.length === 0" class="attendance__empty">{{ tr('No versions yet.', '暂无版本。') }}</div>
      <div v-else class="attendance__table-wrapper">
        <table class="attendance__table">
          <thead>
            <tr>
              <th>{{ tr('Version', '版本') }}</th>
              <th>{{ tr('Items', '条目') }}</th>
              <th>{{ tr('Created', '创建时间') }}</th>
              <th>{{ tr('Created by', '创建人') }}</th>
              <th>{{ tr('Actions', '操作') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="version in ruleTemplateVersions" :key="version.id">
              <td>{{ version.version }}</td>
              <td>{{ version.itemCount ?? '--' }}</td>
              <td>{{ formatDateTime(version.createdAt ?? null) }}</td>
              <td>{{ version.createdBy || '--' }}</td>
              <td class="attendance__table-actions">
                <button class="attendance__btn" :disabled="ruleTemplateVersionLoading" @click="openRuleTemplateVersion(version.id)">
                  {{ ruleTemplateVersionLoading && selectedRuleTemplateVersion && selectedRuleTemplateVersion.id === version.id ? tr('Loading...', '加载中...') : tr('View', '查看') }}
                </button>
                <button
                  class="attendance__btn"
                  :disabled="ruleTemplateRestoring || ruleTemplateSaving"
                  @click="restoreRuleTemplates(version.id)"
                >
                  {{ tr('Restore', '恢复') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="selectedRuleTemplateVersion" class="attendance__template-version-panel">
        <div class="attendance__admin-section-header">
          <h5>{{ tr('Selected version', '已选版本') }} #{{ selectedRuleTemplateVersion.version }}</h5>
          <button class="attendance__btn" @click="closeRuleTemplateVersionView">{{ tr('Close', '关闭') }}</button>
        </div>
        <div class="attendance__template-version-meta">
          <span>{{ tr('Created', '创建时间') }}: {{ formatDateTime(selectedRuleTemplateVersion.createdAt ?? null) }}</span>
          <span>{{ tr('Created by', '创建人') }}: {{ selectedRuleTemplateVersion.createdBy || '--' }}</span>
          <span>{{ tr('Items', '条目') }}: {{ selectedRuleTemplateVersion.itemCount ?? '--' }}</span>
          <span>{{ tr('Source version', '来源版本') }}: {{ selectedRuleTemplateVersion.sourceVersionId || '--' }}</span>
        </div>
        <pre class="attendance__code attendance__code--viewer">{{ formatJson(selectedRuleTemplateVersion.templates ?? selectedRuleTemplateVersion) }}</pre>
      </div>
    </div>
  </div>

  <div class="attendance__admin-section">
    <div class="attendance__admin-section-header">
      <h4>{{ tr('Attendance groups', '考勤组') }}</h4>
      <button class="attendance__btn" :disabled="attendanceGroupLoading" @click="loadAttendanceGroups">
        {{ attendanceGroupLoading ? tr('Loading...', '加载中...') : tr('Reload groups', '重载分组') }}
      </button>
    </div>
    <div class="attendance__admin-grid">
      <label class="attendance__field" for="attendance-group-name">
        <span>{{ tr('Name', '名称') }}</span>
        <input id="attendance-group-name" v-model="attendanceGroupForm.name" type="text" />
      </label>
      <label class="attendance__field" for="attendance-group-code">
        <span>{{ tr('Code', '编码') }}</span>
        <input
          id="attendance-group-code"
          v-model="attendanceGroupForm.code"
          type="text"
          :placeholder="tr('Auto-generated from name', '名称自动生成')"
        />
      </label>
      <label class="attendance__field" for="attendance-group-timezone">
        <span>{{ tr('Timezone', '时区') }}</span>
        <select id="attendance-group-timezone" v-model="attendanceGroupForm.timezone">
          <option v-for="timezone in attendanceGroupTimezones" :key="timezone" :value="timezone">
            {{ timezone }}
          </option>
        </select>
      </label>
      <label class="attendance__field" for="attendance-group-rule-set">
        <span>{{ tr('Rule set', '规则集') }}</span>
        <select
          id="attendance-group-rule-set"
          v-model="attendanceGroupForm.ruleSetId"
          :disabled="ruleSets.length === 0"
        >
          <option value="">{{ tr('(Optional) Use default rule', '（可选）使用默认规则') }}</option>
          <option v-for="item in ruleSets" :key="item.id" :value="item.id">
            {{ item.name }}
          </option>
        </select>
      </label>
      <label class="attendance__field attendance__field--full" for="attendance-group-description">
        <span>{{ tr('Description', '描述') }}</span>
        <input id="attendance-group-description" v-model="attendanceGroupForm.description" type="text" />
      </label>
    </div>
    <div class="attendance__admin-actions">
      <button class="attendance__btn attendance__btn--primary" :disabled="attendanceGroupSaving" @click="saveAttendanceGroup">
        {{ attendanceGroupSaving ? tr('Saving...', '保存中...') : attendanceGroupEditingId ? tr('Update group', '更新分组') : tr('Create group', '创建分组') }}
      </button>
      <button class="attendance__btn" :disabled="attendanceGroupSaving" @click="resetAttendanceGroupForm">
        {{ tr('Reset', '重置') }}
      </button>
    </div>
    <div v-if="attendanceGroups.length === 0" class="attendance__empty">{{ tr('No attendance groups.', '暂无考勤组。') }}</div>
    <div v-else class="attendance__table-wrapper">
      <table class="attendance__table">
        <thead>
          <tr>
            <th>{{ tr('Name', '名称') }}</th>
            <th>{{ tr('Code', '编码') }}</th>
            <th>{{ tr('Timezone', '时区') }}</th>
            <th>{{ tr('Rule set', '规则集') }}</th>
            <th>{{ tr('Actions', '操作') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in attendanceGroups" :key="item.id">
            <td>{{ item.name }}</td>
            <td>{{ item.code || '-' }}</td>
            <td>{{ item.timezone }}</td>
            <td>{{ resolveRuleSetName(item.ruleSetId) }}</td>
            <td class="attendance__table-actions">
              <button class="attendance__btn" @click="editAttendanceGroup(item)">{{ tr('Edit', '编辑') }}</button>
              <button class="attendance__btn attendance__btn--danger" @click="deleteAttendanceGroup(item.id)">
                {{ tr('Delete', '删除') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="attendance__admin-section">
    <div class="attendance__admin-section-header">
      <h4>{{ tr('Group members', '分组成员') }}</h4>
      <button class="attendance__btn" :disabled="attendanceGroupMemberLoading" @click="loadAttendanceGroupMembers">
        {{ attendanceGroupMemberLoading ? tr('Loading...', '加载中...') : tr('Reload members', '重载成员') }}
      </button>
    </div>
    <div class="attendance__admin-grid">
      <label class="attendance__field" for="attendance-group-member-group">
        <span>{{ tr('Group', '分组') }}</span>
        <select
          id="attendance-group-member-group"
          v-model="attendanceGroupMemberGroupId"
          :disabled="attendanceGroups.length === 0"
        >
          <option value="">{{ tr('Select a group', '选择分组') }}</option>
          <option v-for="group in attendanceGroups" :key="group.id" :value="group.id">
            {{ group.name }}
          </option>
        </select>
      </label>
      <AttendanceUserPickerField
        v-model="attendanceGroupMemberSelectedUserId"
        :tr="tr"
        :label="tr('User picker', '用户选择器')"
        name="attendanceGroupMemberUserPicker"
        :help-text="tr('Pick one user and append it to the bulk list below, or type multiple IDs manually.', '先选一个用户再追加到下方批量列表，也可以直接手动输入多个 ID。')"
        :search-placeholder="tr('Search users to append', '搜索要追加的用户')"
        :full-width="false"
        input-id="attendance-group-member-user-picker"
      />
      <label class="attendance__field attendance__field--full" for="attendance-group-member-user-ids">
        <span>{{ tr('User IDs (bulk)', '用户 ID（批量）') }}</span>
        <input
          id="attendance-group-member-user-ids"
          v-model="attendanceGroupMemberUserIds"
          type="text"
          :placeholder="tr('userId1, userId2', 'userId1, userId2')"
        />
        <small class="attendance__field-hint">{{ tr('Separate multiple IDs with commas or spaces. The picker above can append one selected user at a time.', '多个 ID 请用逗号或空格分隔。上方选择器可一次追加一个用户。') }}</small>
      </label>
    </div>
    <div class="attendance__admin-actions">
      <button
        class="attendance__btn"
        :disabled="attendanceGroupMemberSaving || !attendanceGroupMemberSelectedUserId"
        @click="appendAttendanceGroupMemberSelectedUser"
      >
        {{ tr('Append selected user', '追加所选用户') }}
      </button>
      <button
        class="attendance__btn attendance__btn--primary"
        :disabled="attendanceGroupMemberSaving"
        @click="addAttendanceGroupMembers"
      >
        {{ attendanceGroupMemberSaving ? tr('Saving...', '保存中...') : tr('Add members', '添加成员') }}
      </button>
    </div>
    <div v-if="attendanceGroupMembers.length === 0" class="attendance__empty">{{ tr('No group members yet.', '暂无分组成员。') }}</div>
    <div v-else class="attendance__table-wrapper">
      <table class="attendance__table">
        <thead>
          <tr>
            <th>{{ tr('User ID', '用户 ID') }}</th>
            <th>{{ tr('Joined', '加入时间') }}</th>
            <th>{{ tr('Actions', '操作') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="member in attendanceGroupMembers" :key="member.id">
            <td>{{ member.userId }}</td>
            <td>{{ formatDateTime(member.createdAt ?? null) }}</td>
            <td class="attendance__table-actions">
              <button
                class="attendance__btn attendance__btn--danger"
                :disabled="attendanceGroupMemberSaving"
                @click="removeAttendanceGroupMember(member.userId)"
              >
                {{ tr('Remove', '移除') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, type Ref } from 'vue'
import type {
  AttendanceGroup,
  AttendanceGroupMember,
  AttendanceRuleSet,
  AttendanceRuleTemplateVersion,
} from './useAttendanceAdminRulesAndGroups'
import AttendanceUserPickerField from './AttendanceUserPickerField.vue'
import { buildTimezoneOptions } from './attendanceTimezones'

type Translate = (en: string, zh: string) => string
type MaybePromise<T> = T | Promise<T>

interface RuleSetFormState {
  name: string
  description: string
  version: number
  scope: string
  isDefault: boolean
  config: string
}

interface AttendanceGroupFormState {
  name: string
  code: string
  timezone: string
  ruleSetId: string
  description: string
}

interface RulesAndGroupsBindings {
  attendanceGroupEditingId: Ref<string | null>
  attendanceGroupForm: AttendanceGroupFormState
  attendanceGroupLoading: Ref<boolean>
  attendanceGroupMemberGroupId: Ref<string>
  attendanceGroupMemberLoading: Ref<boolean>
  attendanceGroupMemberSaving: Ref<boolean>
  attendanceGroupMemberUserIds: Ref<string>
  attendanceGroupMembers: Ref<AttendanceGroupMember[]>
  attendanceGroupSaving: Ref<boolean>
  attendanceGroups: Ref<AttendanceGroup[]>
  copySystemTemplates: () => MaybePromise<void>
  deleteAttendanceGroup: (id: string) => MaybePromise<void>
  deleteRuleSet: (id: string) => MaybePromise<void>
  editAttendanceGroup: (item: AttendanceGroup) => MaybePromise<void>
  editRuleSet: (item: AttendanceRuleSet) => MaybePromise<void>
  loadAttendanceGroupMembers: () => MaybePromise<void>
  loadAttendanceGroups: () => MaybePromise<void>
  loadRuleSetTemplate: () => MaybePromise<void>
  loadRuleSets: () => MaybePromise<void>
  loadRuleTemplates: () => MaybePromise<void>
  addAttendanceGroupMembers: () => MaybePromise<void>
  removeAttendanceGroupMember: (userId: string) => MaybePromise<void>
  resetAttendanceGroupForm: () => MaybePromise<void>
  resetRuleSetForm: () => MaybePromise<void>
  closeRuleTemplateVersionView: () => MaybePromise<void>
  resolveRuleSetName: (ruleSetId?: string | null) => string
  restoreRuleTemplates: (versionId: string) => MaybePromise<void>
  openRuleTemplateVersion: (versionId: string) => MaybePromise<void>
  ruleTemplateVersionLoading: Ref<boolean>
  selectedRuleTemplateVersion: Ref<AttendanceRuleTemplateVersion | null>
  ruleSetEditingId: Ref<string | null>
  ruleSetForm: RuleSetFormState
  ruleSetLoading: Ref<boolean>
  ruleSetSaving: Ref<boolean>
  ruleSets: Ref<AttendanceRuleSet[]>
  ruleTemplateLibraryText: Ref<string>
  ruleTemplateLoading: Ref<boolean>
  ruleTemplateRestoring: Ref<boolean>
  ruleTemplateSaving: Ref<boolean>
  ruleTemplateSystemText: Ref<string>
  ruleTemplateVersions: Ref<AttendanceRuleTemplateVersion[]>
  saveAttendanceGroup: () => MaybePromise<void>
  saveRuleSet: () => MaybePromise<void>
  saveRuleTemplates: () => MaybePromise<void>
}

const props = defineProps<{
  tr: Translate
  rules: RulesAndGroupsBindings
  formatDateTime: (value: string | null | undefined) => string
}>()

const tr = props.tr
const formatDateTime = props.formatDateTime
const attendanceGroupEditingId = props.rules.attendanceGroupEditingId
const attendanceGroupForm = props.rules.attendanceGroupForm
const attendanceGroupTimezones = computed(() => buildTimezoneOptions(attendanceGroupForm.timezone))
const attendanceGroupLoading = props.rules.attendanceGroupLoading
const attendanceGroupMemberGroupId = props.rules.attendanceGroupMemberGroupId
const attendanceGroupMemberLoading = props.rules.attendanceGroupMemberLoading
const attendanceGroupMemberSaving = props.rules.attendanceGroupMemberSaving
const attendanceGroupMemberUserIds = props.rules.attendanceGroupMemberUserIds
const attendanceGroupMembers = props.rules.attendanceGroupMembers
const attendanceGroupMemberSelectedUserId = ref('')
const attendanceGroupSaving = props.rules.attendanceGroupSaving
const attendanceGroups = props.rules.attendanceGroups
const copySystemTemplates = () => props.rules.copySystemTemplates()
const deleteAttendanceGroup = (id: string) => props.rules.deleteAttendanceGroup(id)
const deleteRuleSet = (id: string) => props.rules.deleteRuleSet(id)
const editAttendanceGroup = (item: AttendanceGroup) => props.rules.editAttendanceGroup(item)
const editRuleSet = (item: AttendanceRuleSet) => props.rules.editRuleSet(item)
const loadAttendanceGroupMembers = () => props.rules.loadAttendanceGroupMembers()
const loadAttendanceGroups = () => props.rules.loadAttendanceGroups()
const loadRuleSetTemplate = () => props.rules.loadRuleSetTemplate()
const loadRuleSets = () => props.rules.loadRuleSets()
const loadRuleTemplates = () => props.rules.loadRuleTemplates()
const addAttendanceGroupMembers = () => props.rules.addAttendanceGroupMembers()
const removeAttendanceGroupMember = (userId: string) => props.rules.removeAttendanceGroupMember(userId)
const resetAttendanceGroupForm = () => props.rules.resetAttendanceGroupForm()
const resetRuleSetForm = () => props.rules.resetRuleSetForm()
const closeRuleTemplateVersionView = () => props.rules.closeRuleTemplateVersionView()
const resolveRuleSetName = props.rules.resolveRuleSetName
const restoreRuleTemplates = (versionId: string) => props.rules.restoreRuleTemplates(versionId)
const openRuleTemplateVersion = (versionId: string) => props.rules.openRuleTemplateVersion(versionId)
const selectedRuleTemplateVersion = props.rules.selectedRuleTemplateVersion
const ruleSetEditingId = props.rules.ruleSetEditingId
const ruleSetForm = props.rules.ruleSetForm
const ruleSetLoading = props.rules.ruleSetLoading
const ruleSetSaving = props.rules.ruleSetSaving
const ruleSets = props.rules.ruleSets
const ruleTemplateLibraryText = props.rules.ruleTemplateLibraryText
const ruleTemplateLoading = props.rules.ruleTemplateLoading
const ruleTemplateRestoring = props.rules.ruleTemplateRestoring
const ruleTemplateSaving = props.rules.ruleTemplateSaving
const ruleTemplateSystemText = props.rules.ruleTemplateSystemText
const ruleTemplateVersionLoading = props.rules.ruleTemplateVersionLoading
const ruleTemplateVersions = props.rules.ruleTemplateVersions
const saveAttendanceGroup = () => props.rules.saveAttendanceGroup()
const saveRuleSet = () => props.rules.saveRuleSet()
const saveRuleTemplates = () => props.rules.saveRuleTemplates()

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function appendAttendanceGroupMemberSelectedUser() {
  const userId = attendanceGroupMemberSelectedUserId.value.trim()
  if (!userId) return
  const ids = attendanceGroupMemberUserIds.value
    .split(/[\n,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
  if (!ids.includes(userId)) {
    ids.push(userId)
  }
  attendanceGroupMemberUserIds.value = ids.join(', ')
  attendanceGroupMemberSelectedUserId.value = ''
}
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

.attendance__admin-subsection {
  display: flex;
  flex-direction: column;
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

.attendance__field--checkbox {
  justify-content: flex-end;
}

.attendance__template-version-panel {
  display: grid;
  gap: 12px;
  padding: 14px;
  border: 1px solid #d9e3f1;
  border-radius: 10px;
  background: #f8fbff;
}

.attendance__template-version-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 18px;
  color: #44546a;
  font-size: 13px;
}

.attendance__code--viewer {
  min-height: 280px;
  max-height: 520px;
  overflow: auto;
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

.attendance__btn--danger {
  color: #c62828;
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

.attendance__empty {
  color: #888;
  font-size: 13px;
  margin-top: 8px;
}
</style>
