<template>
  <section class="sp-members" data-testid="stock-prep-members">
    <!-- 备料「成员与权限」(ADR §11.6, S5b, R-39). Everything below renders from the SERVER's answer: the
         shell only mounts this view after GET …/members answered (switch on, caller admitted by the host
         port), so with the switch off nothing here exists. Not shown, ever: data-source credentials,
         platform switches, platform roles or codes — the server sends stock-prep roles and stock-prep
         codes only. -->
    <p
      v-if="outcome && outcome.kind === 'scope-required'"
      class="sp-members__notice"
      data-testid="stock-prep-members-scope-required"
      role="status"
    >
      {{ bi(
        '您是备料主管理员，但还没有可管理的部门或成员组。请平台管理员在「角色委派」里给您配置后再来。',
        'You are the stock-prep main administrator, but no department or member group has been delegated to you yet. Ask a platform administrator to set one up under role delegation, then come back.',
      ) }}
    </p>

    <div v-else-if="view" class="sp-members__page" data-testid="stock-prep-members-page">
      <p class="sp-members__intro">
        {{ bi(
          '在这里任命本应用的成员、开通插件使用，并建自定义角色。内置角色只能查看；主管理员由平台管理员任命。',
          'Appoint this app\'s members, turn on their plugin access, and create custom roles here. Built-in roles are read-only; the main administrator is appointed by a platform administrator.',
        ) }}
      </p>

      <p v-if="failure" class="sp-members__error" data-testid="stock-prep-members-error" role="alert">
        {{ bi(failure.zh, failure.en) }}
        <code v-if="failure.code" class="sp-members__token">{{ failure.code }}</code>
      </p>
      <p v-if="notice" class="sp-members__ok" data-testid="stock-prep-members-notice" role="status">{{ bi(notice.zh, notice.en) }}</p>

      <!-- 内置角色 -->
      <h3 class="sp-members__h3">{{ bi('内置角色', 'Built-in roles') }}</h3>
      <div
        v-for="role in view.builtInRoles"
        :key="role.id"
        class="sp-members__role"
        :data-testid="`stock-prep-members-role-${role.id}`"
        :data-installed="role.installed ? 'true' : 'false'"
      >
        <p class="sp-members__role-title">
          <strong>{{ builtInLabel(role.id) }}</strong>
          <code class="sp-members__token">{{ role.id }}</code>
        </p>
        <p v-if="!role.installed" class="sp-members__hint" data-testid="stock-prep-members-role-not-installed">
          {{ bi('这个内置角色还没有安装（需要先升级迁移）。', 'This built-in role is not installed yet (the upgrade migration has not run).') }}
        </p>
        <template v-else>
          <p class="sp-members__codes">{{ codesLabel(role.permissionCodes) }}</p>
          <p v-if="role.id === mainAdminRoleId" class="sp-members__hint" data-testid="stock-prep-members-main-admin-note">
            {{ bi('主管理员由平台管理员任命，这里只能查看。', 'The main administrator is appointed by a platform administrator; read-only here.') }}
          </p>
          <StockPreparationMembersList :role="role" :busy="busy" @revoke="revoke" @admit="admit" />
          <StockPreparationMembersAppointForm v-if="role.appointable" :role-id="role.id" :busy="busy" @appoint="appoint" />
        </template>
      </div>

      <!-- 自定义角色 -->
      <h3 class="sp-members__h3">{{ bi('自定义角色', 'Custom roles') }}</h3>
      <p class="sp-members__hint">
        {{ bi(
          '自定义角色只能从备料的权限里选（看、填写确认、拉取），不能超过您自己的权限；项目表只能加，第一步不支持从角色上移除项目表。',
          'A custom role can only carry stock-prep permissions (read, fill/confirm, pull), never more than you hold yourself; project sheets can only be added — removing a sheet from a role is not supported in this first step.',
        ) }}
      </p>
      <div
        v-for="role in view.customRoles"
        :key="role.id"
        class="sp-members__role"
        :data-testid="`stock-prep-members-role-${role.id}`"
      >
        <p class="sp-members__role-title">
          <strong>{{ role.name || role.id }}</strong>
          <code class="sp-members__token">{{ role.id }}</code>
        </p>
        <div class="sp-members__edit">
          <input
            v-model="edits[role.id].name"
            type="text"
            maxlength="64"
            :aria-label="bi('角色名称', 'Role name')"
            :data-testid="`stock-prep-members-custom-role-name-${role.id}`"
          >
          <label v-for="code in editableCodes" :key="code" class="sp-members__check">
            <input
              v-model="edits[role.id].codes"
              type="checkbox"
              :value="code"
              :data-testid="`stock-prep-members-custom-role-code-${role.id}-${code}`"
            >
            {{ codeLabel(code) }}
          </label>
          <button
            type="button"
            data-testid="stock-prep-members-custom-role-save"
            :disabled="busy"
            @click="saveRole(role.id)"
          >
            {{ bi('保存', 'Save') }}
          </button>
        </div>
        <p class="sp-members__codes" data-testid="stock-prep-members-custom-role-sheets">
          {{ sheetsLabel(role) }}
        </p>
        <div v-if="sheetChoices" class="sp-members__tables">
          <label v-for="choice in addableChoices(role)" :key="choice.projectNo" class="sp-members__check">
            <input
              v-model="tableTicks[role.id]"
              type="checkbox"
              :value="choice.projectNo"
              :data-testid="`stock-prep-members-custom-role-table-${role.id}-${choice.projectNo}`"
            >
            {{ choice.projectNo }}
          </label>
          <button
            v-if="addableChoices(role).length > 0"
            type="button"
            data-testid="stock-prep-members-custom-role-add-tables"
            :disabled="busy || (tableTicks[role.id] || []).length === 0"
            @click="addTables(role.id)"
          >
            {{ bi('把勾选的项目表加给这个角色', 'Add the ticked project sheets to this role') }}
          </button>
        </div>
        <StockPreparationMembersList :role="role" :busy="busy" @revoke="revoke" @admit="admit" />
        <StockPreparationMembersAppointForm v-if="role.appointable" :role-id="role.id" :busy="busy" @appoint="appoint" />
      </div>

      <div class="sp-members__create">
        <input
          v-model="draftName"
          type="text"
          maxlength="64"
          :placeholder="bi('新角色名称', 'New role name')"
          data-testid="stock-prep-members-custom-role-new-name"
        >
        <label v-for="code in editableCodes" :key="code" class="sp-members__check">
          <input v-model="draftCodes" type="checkbox" :value="code" :data-testid="`stock-prep-members-custom-role-new-code-${code}`">
          {{ codeLabel(code) }}
        </label>
        <button
          type="button"
          data-testid="stock-prep-members-custom-role-create"
          :disabled="busy || draftName.trim().length === 0"
          @click="createRole"
        >
          {{ bi('新建自定义角色', 'Create custom role') }}
        </button>
      </div>

      <template v-if="view.otherRoles.length > 0">
        <h3 class="sp-members__h3">{{ bi('本应用的其他角色（只读）', 'Other roles of this app (read-only)') }}</h3>
        <div v-for="role in view.otherRoles" :key="role.id" class="sp-members__role" :data-testid="`stock-prep-members-role-${role.id}`">
          <p class="sp-members__role-title"><strong>{{ role.name || role.id }}</strong> <code class="sp-members__token">{{ role.id }}</code></p>
          <p class="sp-members__codes">{{ codesLabel(role.permissionCodes) }}</p>
          <StockPreparationMembersList :role="role" :busy="busy" read-only @revoke="revoke" @admit="admit" />
        </div>
      </template>

      <!-- 本应用审计（只读） -->
      <h3 class="sp-members__h3">{{ bi('本应用的变更记录', 'This app\'s change record') }}</h3>
      <p v-if="!view.audit.available" class="sp-members__hint" data-testid="stock-prep-members-audit-unavailable">
        {{ bi('变更记录暂时读不到。', 'The change record cannot be read right now.') }}
      </p>
      <ul v-else class="sp-members__audit" data-testid="stock-prep-members-audit">
        <li v-for="(entry, index) in view.audit.entries" :key="index" data-testid="stock-prep-members-audit-entry">
          <span>{{ entry.at || '—' }}</span>
          <span>{{ auditLabel(entry) }}</span>
          <code class="sp-members__token">{{ entry.roleId || entry.namespace || '' }}</code>
        </li>
        <li v-if="view.audit.entries.length === 0" data-testid="stock-prep-members-audit-empty">{{ bi('还没有记录。', 'Nothing recorded yet.') }}</li>
      </ul>
    </div>
  </section>
</template>

<script setup lang="ts">
// 备料「成员与权限」— the workbench page of slice S5b (ADR adr-stock-prep-project-sheets-20261008 §11.6;
// register R-39). It renders the shell's members read and drives four kinds of change, each through
// the server that decides it:
//   * custom roles (create / rename / codes / add project sheets) → the S5b plugin routes, which hand
//     every decision to the host's narrow members port;
//   * appoint / revoke / plugin admission → the EXISTING /api/admin/role-delegation routes.
// The page never offers appointing the main administrator (ADR §11.7); the client also refuses it.
import { computed, reactive, ref, watch } from 'vue'
import StockPreparationMembersList from './StockPreparationMembersList.vue'
import StockPreparationMembersAppointForm from './StockPreparationMembersAppointForm.vue'
import { useLocale } from '../../../composables/useLocale'
import type { IntegrationScope } from '../../../services/integration/workbench'
import {
  STOCK_PREP_CUSTOM_ROLE_SELECTABLE_CODES,
  STOCK_PREP_MAIN_ADMIN_ROLE_ID,
  addStockPrepCustomRoleProjectTargets,
  appointStockPrepMember,
  createStockPrepCustomRole,
  readStockPrepMembers,
  readStockPrepProjectSheetChoices,
  revokeStockPrepMember,
  setStockPrepMemberAdmission,
  stockPrepMembersErrorPlain,
  updateStockPrepCustomRole,
  type StockPrepMembersAuditEntry,
  type StockPrepMembersReadOutcome,
  type StockPrepMembersRole,
} from '../../../services/integration/stockPreparation/members'

const props = defineProps<{
  scope: IntegrationScope
  initialOutcome: StockPrepMembersReadOutcome | null
}>()

const emit = defineEmits<{ (e: 'outcome', outcome: StockPrepMembersReadOutcome): void }>()

const { locale } = useLocale()
function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const mainAdminRoleId = STOCK_PREP_MAIN_ADMIN_ROLE_ID
const outcome = ref<StockPrepMembersReadOutcome | null>(props.initialOutcome)
const view = computed(() => (outcome.value && outcome.value.kind === 'ready' ? outcome.value.view : null))
const busy = ref(false)
const failure = ref<{ zh: string; en: string; code: string | null } | null>(null)
const notice = ref<{ zh: string; en: string } | null>(null)
const sheetChoices = ref<Array<{ projectNo: string; sheetId: string; status: string }> | null>(null)
const edits = reactive<Record<string, { name: string; codes: string[] }>>({})
const tableTicks = reactive<Record<string, string[]>>({})
const draftName = ref('')
const draftCodes = ref<string[]>([])

/** What the editor offers: the server's selectable list ∩ what THIS grantor may hand out. */
const editableCodes = computed<string[]>(() => {
  const grantable = view.value ? view.value.grantableCodes : []
  return (STOCK_PREP_CUSTOM_ROLE_SELECTABLE_CODES as readonly string[]).filter((code) => grantable.includes(code))
})

function syncEdits(): void {
  for (const role of view.value?.customRoles ?? []) {
    edits[role.id] = { name: role.name ?? '', codes: role.permissionCodes.filter((code) => editableCodes.value.includes(code)) }
    tableTicks[role.id] = []
  }
}

watch(() => props.initialOutcome, (next) => { if (next) outcome.value = next })
watch(view, syncEdits, { immediate: true })

async function loadSheetChoices(): Promise<void> {
  if (!view.value || view.value.customRoles.length === 0) {
    sheetChoices.value = null
    return
  }
  sheetChoices.value = await readStockPrepProjectSheetChoices(props.scope)
}
watch(view, () => { void loadSheetChoices() }, { immediate: true })

async function reload(): Promise<void> {
  const next = await readStockPrepMembers()
  outcome.value = next
  emit('outcome', next)
}

async function run(action: () => Promise<{ zh: string; en: string } | void>): Promise<void> {
  busy.value = true
  failure.value = null
  notice.value = null
  try {
    const done = await action()
    if (done) notice.value = done
    await reload()
  } catch (error) {
    failure.value = stockPrepMembersErrorPlain(error)
  } finally {
    busy.value = false
  }
}

function appoint(roleId: string, userId: string): void {
  void run(async () => {
    const result = await appointStockPrepMember(userId, roleId)
    return result.admitted
      ? { zh: '已任命，并已开通插件使用。', en: 'Appointed, with plugin access turned on.' }
      : { zh: '已任命，但插件使用还没开通，请在成员一行点「开通插件使用」。', en: 'Appointed, but plugin access is not on yet; use 「turn on plugin access」 on the member row.' }
  })
}

function revoke(roleId: string, userId: string): void {
  void run(async () => {
    await revokeStockPrepMember(userId, roleId)
    return { zh: '已撤销。', en: 'Revoked.' }
  })
}

function admit(userId: string): void {
  void run(async () => {
    await setStockPrepMemberAdmission(userId, true)
    return { zh: '已开通插件使用。', en: 'Plugin access turned on.' }
  })
}

function createRole(): void {
  const name = draftName.value.trim()
  const codes = draftCodes.value.filter((code) => editableCodes.value.includes(code))
  void run(async () => {
    await createStockPrepCustomRole(name, codes)
    draftName.value = ''
    draftCodes.value = []
    return { zh: '自定义角色已建好。', en: 'Custom role created.' }
  })
}

function saveRole(roleId: string): void {
  const edit = edits[roleId]
  if (!edit) return
  void run(async () => {
    await updateStockPrepCustomRole(roleId, { name: edit.name.trim(), permissionCodes: edit.codes.filter((code) => editableCodes.value.includes(code)) })
    return { zh: '已保存。', en: 'Saved.' }
  })
}

function addTables(roleId: string): void {
  const projectNos = [...(tableTicks[roleId] || [])]
  if (projectNos.length === 0) return
  void run(async () => {
    await addStockPrepCustomRoleProjectTargets(roleId, projectNos)
    return { zh: '项目表已加给这个角色。', en: 'Project sheets added to this role.' }
  })
}

function addableChoices(role: StockPrepMembersRole): Array<{ projectNo: string; sheetId: string }> {
  return (sheetChoices.value ?? []).filter((choice) => choice.status === 'active' && !role.sheetIds.includes(choice.sheetId))
}

function sheetsLabel(role: StockPrepMembersRole): string {
  const byId = new Map((sheetChoices.value ?? []).map((choice) => [choice.sheetId, choice.projectNo]))
  const named = role.sheetIds.map((sheetId) => byId.get(sheetId) ?? null).filter((value): value is string => value !== null)
  const unnamed = role.sheetIds.length - named.length + role.otherSheetCount
  const list = named.length > 0 ? named.join('、') : bi('无', 'none')
  return bi(`已授权的项目表：${list}${unnamed > 0 ? `（另有 ${unnamed} 张）` : ''}`, `Project sheets granted: ${list}${unnamed > 0 ? ` (and ${unnamed} more)` : ''}`)
}

const BUILT_IN_LABELS: Record<string, [string, string]> = {
  'stock-prep_admin': ['备料主管理员', 'Main administrator'],
  'stock-prep_puller': ['数据管理员（拉取人员）', 'Data manager (puller)'],
  'stock-prep_developer': ['开发成员', 'Developer'],
  'stock-prep_frontline': ['一线填写', 'Floor operator'],
}

function builtInLabel(id: string): string {
  const label = BUILT_IN_LABELS[id]
  return label ? bi(label[0], label[1]) : id
}

const CODE_LABELS: Record<string, [string, string]> = {
  'stock-prep:read': ['看', 'Read'],
  'stock-prep:operate': ['填写与确认', 'Fill & confirm'],
  'stock-prep:pull': ['拉取', 'Pull'],
  'stock-prep:admin': ['主管理', 'Administer'],
}

function codeLabel(code: string): string {
  const label = CODE_LABELS[code]
  return label ? bi(label[0], label[1]) : code
}

function codesLabel(codes: string[]): string {
  return codes.length > 0 ? codes.map(codeLabel).join(' · ') : bi('（没有备料权限）', '(no stock-prep permission)')
}

function auditLabel(entry: StockPrepMembersAuditEntry): string {
  if (entry.resourceType === 'user-role') return entry.action === 'grant' ? bi('任命', 'appointed') : bi('撤销', 'revoked')
  if (entry.resourceType === 'user-namespace-admission') return entry.enabled === false ? bi('关闭插件使用', 'plugin access off') : bi('开通插件使用', 'plugin access on')
  if (entry.action === 'create') return bi('新建角色', 'role created')
  if (entry.action === 'update') return bi('修改角色', 'role changed')
  if (entry.action === 'grant') return bi('授权项目表', 'project sheet granted')
  return entry.action ?? '—'
}

</script>

<style scoped>
.sp-members,
.sp-members__page {
  display: grid;
  gap: 10px;
}

.sp-members__h3 {
  margin: 8px 0 0;
}

.sp-members__intro,
.sp-members__hint,
.sp-members__codes {
  margin: 0;
  color: #475569;
  font-size: 13px;
}

.sp-members__notice {
  margin: 0;
  color: #92400e;
}

.sp-members__error {
  margin: 0;
  color: #b91c1c;
}

.sp-members__ok {
  margin: 0;
  color: #166534;
}

.sp-members__warn {
  color: #92400e;
}

.sp-members__token {
  margin-left: 6px;
  font-size: 12px;
}

.sp-members__role {
  display: grid;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--ms-border-light, #e2e8f0);
  border-radius: 6px;
}

.sp-members__role-title {
  margin: 0;
}

.sp-members__edit,
.sp-members__create,
.sp-members__tables,
.sp-members__appoint {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.sp-members__check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
}

.sp-members__list,
.sp-members__audit {
  margin: 0;
  padding-left: 18px;
  display: grid;
  gap: 4px;
  font-size: 13px;
}
</style>
