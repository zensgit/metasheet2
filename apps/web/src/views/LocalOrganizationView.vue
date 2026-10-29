<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { useAuth } from '../composables/useAuth'
import { onAuthPrincipalChange, readAuthSessionSignature, TOKEN_KEYS } from '../composables/authPrincipal'
import { EXPLICIT_SESSION_ORG_KEY } from '../utils/explicitSessionOrg'
import { localOrganizationClient as client, LocalOrganizationError, localOrganizationMessage } from '../services/localOrganizationClient'
import type { DepartmentInput, LocalCandidate, LocalHead, LocalMember, LocalWorkspace } from '../services/localOrganizationClient'
import LocalDepartmentPanel from '../components/localOrganization/LocalDepartmentPanel.vue'
import LocalMemberPanel from '../components/localOrganization/LocalMemberPanel.vue'
import LocalProjectionPanel from '../components/localOrganization/LocalProjectionPanel.vue'

const auth = useAuth()
const workspace = ref<LocalWorkspace | null>(null)
const members = ref<LocalMember[]>([])
const candidates = ref<LocalCandidate[]>([])
const candidateId = ref('')
const candidateQ = ref('')
const candidatePage = ref(1)
const candidateTotal = ref(0)
const candidateError = ref('')
const candidatesLoading = ref(false)
const selectedId = ref('')
const membershipId = ref('')
const head = ref<LocalHead | null>(null)
const headError = ref('')
const error = ref('')
const notice = ref('')
const q = ref('')
const page = ref(1)
const total = ref(0)
const pageSize = 25
const loading = ref(false)
const membersLoading = ref(false)
const headLoading = ref(false)
const writing = ref(false)
const allowed = ref(auth.hasAdminAccess())
const selected = computed(() => members.value.find(m => m.id === selectedId.value))
const writable = computed(() => allowed.value && workspace.value?.integration?.isActive === true && !loading.value)
const blocked = computed(() => !writable.value || writing.value)
let alive = true
let epoch = 0
let viewSession = readAuthSessionSignature()
const revisions = { workspace: 0, members: 0, candidates: 0, head: 0 }
type Lane = keyof typeof revisions
function clearSelection() {
  selectedId.value = ''; membershipId.value = ''; head.value = null; headError.value = ''
  revisions.head++; headLoading.value = false
}
function clearPrivate() {
  workspace.value = null; members.value = []; clearSelection()
  q.value = ''; total.value = 0; page.value = 1; error.value = ''; notice.value = ''
  loading.value = false; membersLoading.value = false
  candidates.value = []; candidateId.value = ''; candidateQ.value = ''; candidatePage.value = 1
  candidateTotal.value = 0; candidateError.value = ''; candidatesLoading.value = false
}
function invalidate() { epoch++; clearPrivate() }
function sessionChanged() {
  if (!alive) return
  invalidate(); allowed.value = false; error.value = '会话已变化，请重新加载组织。'
}
function sameSession(): boolean {
  if (viewSession === readAuthSessionSignature()) return true
  sessionChanged()
  return false
}
function ticket(lane: Lane) {
  const revision = ++revisions[lane]
  const startedEpoch = epoch
  const session = viewSession
  return () => {
    if (!alive || epoch !== startedEpoch || revisions[lane] !== revision) return false
    if (session !== readAuthSessionSignature()) { sessionChanged(); return false }
    return true
  }
}
function refusal(cause: unknown): boolean {
  if (cause instanceof LocalOrganizationError && (cause.status === 401 || cause.status === 403 || cause.code === 'LOCAL_ORG_CONTEXT_CHANGED')) {
    invalidate(); allowed.value = false; error.value = localOrganizationMessage(cause)
    return true
  }
  return false
}
async function loadWorkspace() {
  if (writing.value || !alive) return
  invalidate(); viewSession = readAuthSessionSignature(); allowed.value = auth.hasAdminAccess()
  if (!allowed.value) { error.value = '当前会话无权管理组织。'; return }
  const current = ticket('workspace')
  loading.value = true
  try {
    const result = await client.workspace()
    if (!current()) return
    workspace.value = result
    loading.value = false
    if (result.integration) { void loadMembers(1); void loadCandidates(1) }
  } catch (cause) {
    if (current() && !refusal(cause)) error.value = localOrganizationMessage(cause)
  } finally { if (current()) loading.value = false }
}
async function loadMembers(nextPage = page.value) {
  const integrationId = workspace.value?.integration?.id
  if (!integrationId || writing.value || !alive || !sameSession()) return
  const query = { integrationId, page: nextPage, pageSize, q: q.value.trim() }
  const current = ticket('members')
  clearSelection(); members.value = []; total.value = 0; page.value = nextPage
  membersLoading.value = true; error.value = ''
  try {
    const result = await client.members(query)
    if (!current() || workspace.value?.integration?.id !== integrationId) return
    members.value = result.items; total.value = result.total
  } catch (cause) {
    if (current() && !refusal(cause)) error.value = localOrganizationMessage(cause)
  } finally { if (current()) membersLoading.value = false }
}
async function loadCandidates(nextPage = candidatePage.value) {
  const integrationId = workspace.value?.integration?.id
  if (!integrationId || writing.value || !alive || !sameSession()) return
  const query = { integrationId, page: nextPage, pageSize, q: candidateQ.value.trim() }
  const current = ticket('candidates')
  candidates.value = []; candidateId.value = ''; candidateTotal.value = 0; candidatePage.value = nextPage
  candidatesLoading.value = true; candidateError.value = ''
  try {
    const result = await client.candidates(query)
    if (!current() || workspace.value?.integration?.id !== integrationId) return
    candidates.value = result.items; candidateTotal.value = result.total
  } catch (cause) {
    if (current() && !refusal(cause)) candidateError.value = localOrganizationMessage(cause)
  } finally { if (current()) candidatesLoading.value = false }
}
function selectCandidate(id: string) {
  if (writing.value || candidatesLoading.value || !sameSession()) return
  candidateId.value = candidates.value.some(c => c.id === id && (c.name?.trim() || c.username?.trim())) ? id : ''
}
function project() {
  const integrationId = workspace.value?.integration?.id
  const candidate = candidates.value.find(c => c.id === candidateId.value)
  if (!integrationId || candidatesLoading.value || !candidate || !(candidate.name?.trim() || candidate.username?.trim())) return
  const localUserId = candidate.id
  void perform(() => client.project(integrationId, localUserId), '目录表示已确认，可在成员列表按姓名查找。')
}
function selectMember(id: string) {
  if (writing.value || membersLoading.value || !sameSession()) return
  clearSelection(); selectedId.value = id
}
async function selectMembership(id: string) {
  if (writing.value || !alive || !sameSession()) return
  membershipId.value = id; head.value = null; headError.value = ''
  const current = ticket('head')
  headLoading.value = false
  const accountId = selectedId.value
  if (!id || !selected.value?.memberships.some(m => m.id === id)) return
  headLoading.value = true
  try {
    const result = await client.head(id)
    if (current() && selectedId.value === accountId && membershipId.value === id) head.value = result
  } catch (cause) {
    if (current() && !refusal(cause)) headError.value = localOrganizationMessage(cause)
  } finally { if (current()) headLoading.value = false }
}
async function perform(command: () => Promise<unknown>, savedMessage = '已保存。') {
  if (blocked.value || !alive || !sameSession()) return
  const session = viewSession
  const startedEpoch = epoch
  const current = () => {
    if (!alive || epoch !== startedEpoch) return false
    if (session !== readAuthSessionSignature()) { sessionChanged(); return false }
    return true
  }
  writing.value = true; error.value = ''; notice.value = ''
  let succeeded = false
  try {
    await command()
    succeeded = true
    if (!current()) return
  } catch (cause) {
    if (current() && !refusal(cause)) error.value = localOrganizationMessage(cause)
  } finally {
    // The server may have committed. Disposal suppresses all subsequent refresh/state effects.
    if (alive) writing.value = false
  }
  if (succeeded && current()) {
    const refreshEpoch = epoch + 1
    await loadWorkspace()
    if (alive && epoch === refreshEpoch && session === readAuthSessionSignature() && workspace.value && !error.value) notice.value = savedMessage
  }
}
function saveDepartment(id: string | null, value: DepartmentInput) {
  const captured = { ...value }
  void perform(() => id ? client.updateDepartment(id, captured) : client.createDepartment(captured))
}
function saveMember(id: string, value: { name: string }) {
  const captured = { ...value }
  void perform(() => client.updateMember(id, captured))
}
function setHead(id: string, value: boolean) {
  if (!head.value || headLoading.value || head.value.readOnly || head.value.id !== id) return
  void perform(() => client.setHead(id, value))
}
const unsubscribe = onAuthPrincipalChange(sessionChanged)
function storageChanged(event: StorageEvent) {
  if (event.key === null || event.key === EXPLICIT_SESSION_ORG_KEY || (TOKEN_KEYS as readonly string[]).includes(event.key)) sessionChanged()
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (writing.value) { event.preventDefault(); event.returnValue = '' }
}
onBeforeRouteLeave(() => !writing.value)
onMounted(() => {
  window.addEventListener('storage', storageChanged)
  window.addEventListener('beforeunload', beforeUnload)
  void loadWorkspace()
})
onBeforeUnmount(() => {
  alive = false; unsubscribe(); invalidate()
  window.removeEventListener('storage', storageChanged)
  window.removeEventListener('beforeunload', beforeUnload)
})
</script>

<template>
  <main class="local-organization" aria-labelledby="organization-heading">
    <header><h1 id="organization-heading">组织管理</h1>
      <p>MetaSheet 维护本组织的部门与成员；钉钉等外部通讯录通过匹配与绑定接入。</p>
      <p>此页维护本地目录关系，不会自动选择审批组织来源、启用审批策略或发布模板；审批来源与可用性仍需按现有策略另行确认。</p>
      <a href="/admin/users" :aria-disabled="writing" @click="writing && $event.preventDefault()">维护平台岗位</a>
      <button type="button" :disabled="writing || loading" @click="loadWorkspace">重新加载组织</button>
    </header>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="writing" role="status">正在保存，请等待完成后切换。离开页面不会撤销已经提交的操作。</p>
    <p v-if="loading" role="status">正在加载组织…</p>
    <template v-if="workspace">
      <p v-if="!workspace.integration">暂无本地组织目录。此页面不会创建或重新激活组织，请联系组织管理员。</p>
      <template v-else>
        <p>{{ workspace.integration.name }} <strong v-if="!workspace.integration.isActive">（只读：目录已停用）</strong></p>
        <div class="organization-layout">
          <LocalDepartmentPanel
        :departments="workspace.departments" :disabled="blocked"
            @save="saveDepartment" @archive="id => perform(() => client.archiveDepartment(id))" />
          <section aria-labelledby="members-heading">
            <h2 id="members-heading">成员</h2>
            <form @submit.prevent="loadMembers(1)"><label>查找组织成员<input v-model="q" maxlength="200" :disabled="writing" /></label>
              <button :disabled="writing" type="submit">搜索成员</button></form>
            <p v-if="membersLoading" role="status">正在加载成员…</p>
            <p v-else-if="!members.length">本页暂无成员，请调整搜索或页码。</p>
            <ul class="member-list" aria-label="组织成员">
              <li v-for="m in members" :key="m.id"><button type="button" :disabled="writing || membersLoading" :aria-pressed="selectedId === m.id" @click="selectMember(m.id)">{{ m.name }}{{ m.isActive ? '' : '（已归档）' }}</button></li>
            </ul>
            <nav aria-label="成员分页">
              <button type="button" :disabled="writing || page <= 1" @click="loadMembers(page - 1)">上一页成员</button>
              <span>第 {{ page }} 页，共 {{ total }} 人</span>
              <button type="button" :disabled="writing || membersLoading || page * pageSize >= total" @click="loadMembers(page + 1)">下一页成员</button>
            </nav>
            <LocalMemberPanel
        v-if="selected" :key="selected.id" :member="selected" :departments="workspace.departments"
              :disabled="blocked" :membership-id="membershipId" :head="head" :head-loading="headLoading" :head-error="headError"
              @save="saveMember" @archive="id => perform(() => client.archiveMember(id))"
              @add="(account, department) => perform(() => client.addMembership(account, department))"
              @select-membership="selectMembership" @primary="id => perform(() => client.primary(id))"
              @manager="(id, value) => perform(() => client.manager(id, value))" @head="setHead" @retry-head="selectMembership(membershipId)" />
            <p v-else>请选择成员查看资料和部门关系。</p>
          </section>
          <LocalProjectionPanel
        :candidates="candidates" :selected-id="candidateId" :query="candidateQ"
            :page="candidatePage" :total="candidateTotal" :page-size="pageSize" :loading="candidatesLoading"
            :disabled="blocked" :writing="writing" :error="candidateError"
            @update-query="value => candidateQ = value" @select="selectCandidate"
            @search="loadCandidates(1)" @page="loadCandidates" @project="project" />
        </div>
      </template>
    </template>
  </main>
</template>

<style scoped>
.local-organization { box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%; padding: 1rem; overflow-wrap: anywhere; }
.organization-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 1rem; }
.organization-layout > section { min-width: 0; }
.organization-layout > :last-child { grid-column: 1 / -1; }
label { display: grid; gap: .3rem; margin-block: .7rem; }
input, select { box-sizing: border-box; min-width: 0; width: 100%; max-width: 100%; }
button { max-width: 100%; white-space: normal; overflow-wrap: anywhere; margin: .25rem; padding: .45rem .65rem; }
nav { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; }
.member-list { list-style: none; padding: 0; max-height: 20rem; overflow-y: auto; }
:deep(button:focus-visible), :deep(input:focus-visible), :deep(select:focus-visible) { outline: 2px solid #245fc4; outline-offset: 2px; }
@media (max-width: 800px) { .organization-layout { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 420px) { .local-organization { padding: .5rem; } }
</style>
