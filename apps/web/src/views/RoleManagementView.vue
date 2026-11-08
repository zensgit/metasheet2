<template>
  <section class="admin-page">
    <header class="admin-page__header">
      <div>
        <h1>角色管理</h1>
        <p>维护平台角色及其权限映射，供用户管理与业务模块复用。</p>
      </div>

      <div class="admin-page__actions">
        <button class="admin-page__button admin-page__button--secondary" type="button" data-role-refresh :disabled="loading || controlsLocked" @click="void requestRefresh()">
          {{ loading ? '加载中...' : '刷新' }}
        </button>
        <button class="admin-page__button" type="button" data-role-new :disabled="controlsLocked" @click="void requestReset()">新建角色</button>
      </div>
    </header>

    <p v-if="status" class="admin-page__status" :class="{ 'admin-page__status--error': statusTone === 'error' }">
      {{ status }}
    </p>

    <div v-if="leavePromptOpen" class="admin-page__leave-shield" data-role-leave-shield>
      <div class="admin-page__leave" role="dialog" aria-modal="true" data-role-leave-dialog>
        <p>当前角色有未保存的修改。</p>
        <div class="admin-page__leave-actions">
          <button class="admin-page__button" type="button" data-role-leave-save @click="chooseLeave('save')">保存并继续</button>
          <button class="admin-page__button admin-page__button--secondary" type="button" data-role-leave-discard @click="chooseLeave('discard')">放弃并继续</button>
          <button class="admin-page__button admin-page__button--secondary" type="button" data-role-leave-stay @click="chooseLeave('stay')">留在此页</button>
        </div>
      </div>
    </div>

    <section v-if="conflictDraft" class="admin-page__conflict" data-role-conflict-draft>
      <p>你冲突前的未保存修改单独保留。编辑区现在显示的是已载入的角色；恢复后才会写回那份修改。</p>
      <p v-if="conflictServerReady">服务端当前权限：{{ authoritativePermissionLabel }}</p>
      <p v-else>未能载入服务端最新权限。未保存修改仍留在编辑区，确认令牌仍对应当前编辑基线。</p>
      <p>未保存名称：{{ conflictDraft.name }}</p>
      <p>未保存修改：{{ conflictPermissionLabel }}</p>
      <button class="admin-page__button admin-page__button--secondary" type="button" data-role-conflict-recover :disabled="controlsLocked" @click="recoverConflictDraft()">恢复未保存修改</button>
    </section>

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
          :disabled="controlsLocked"
          @click="void selectRole(role)"
        >
          <strong>{{ presentRoleTitle(role) }}</strong>
          <span>{{ role.id }}</span>
          <small>成员数：{{ role.memberCount }}</small>
        </button>
      </aside>

      <section class="admin-page__panel admin-page__panel--detail">
        <div class="admin-page__form-grid">
          <label class="admin-page__field">
            <span>角色 ID</span>
            <input v-model.trim="draftRoleId" class="admin-page__input" type="text" placeholder="例如 attendance_admin" :disabled="isEditing || controlsLocked">
          </label>
          <label class="admin-page__field">
            <span>角色名称</span>
            <input v-model.trim="draftRoleName" class="admin-page__input" data-role-name-input type="text" placeholder="例如 Attendance Admin" :disabled="controlsLocked">
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
                :disabled="controlsLocked"
                @change="togglePermission(permission.code, ($event.target as HTMLInputElement).checked)"
              >
              <div>
                <strong>{{ permission.code }}</strong>
                <p>{{ presentPermission(permission).name }}</p>
                <small>{{ presentPermission(permission).description || '无描述' }}</small>
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

        <RoleMembersPanel v-if="isEditing" :role-id="selectedRoleId" />

        <footer class="admin-page__footer">
          <button class="admin-page__button" type="button" :disabled="controlsLocked || !canSave" @click="void saveRole()">
            {{ busy ? '保存中...' : isEditing ? '保存角色' : '创建角色' }}
          </button>
          <button class="admin-page__button admin-page__button--secondary" type="button" data-role-cancel :disabled="controlsLocked" @click="void requestReset()">
            取消
          </button>
          <button
            v-if="isEditing"
            class="admin-page__button admin-page__button--danger"
            type="button"
            :disabled="controlsLocked"
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
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'
import { matchedRouteKey, onBeforeRouteLeave } from 'vue-router'
import { apiFetch } from '../utils/api'
import { presentPermission, presentRoleTitle, roleNameForSave } from './builtinCatalogPresentation'
import RoleMembersPanel from './RoleMembersPanel.vue'

type RoleCatalogItem = {
  id: string
  name: string
  permissions: string[]
  memberCount: number
  /**
   * Optimistic-concurrency token from GET /api/admin/roles. Echoed back on save as
   * `expectedUpdatedAt` so that saving a grid loaded before someone else's revoke is
   * answered 409 instead of silently resurrecting the revoked codes.
   */
  updatedAt?: string | null
}

type PermissionCatalogItem = {
  code: string
  name: string
  description: string | null
}

type LoadedRoleBaseline = {
  id: string
  name: string
  displayName: string
  permissions: string[]
  updatedAt: string | null
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
// Concurrency tokens for the role currently in the editor. Catalog reloads update
// `roles` only; this snapshot changes when the editor baseline is applied.
const loadedBaseline = ref<LoadedRoleBaseline | null>(null)

type PreservedRoleDraft = {
  roleId: string
  name: string
  permissions: string[]
}

type LeaveChoice = 'save' | 'discard' | 'stay'

const conflictDraft = ref<PreservedRoleDraft | null>(null)
const conflictServerReady = ref(false)
const leavePromptOpen = ref(false)
const transitionActive = ref(false)
let leaveResolver: ((choice: LeaveChoice) => void) | null = null
let pendingLeave: Promise<LeaveChoice> | null = null

function sameCodeSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const left = [...a].sort()
  const right = [...b].sort()
  return left.every((code, index) => code === right[index])
}

function formatPermissionList(codes: readonly string[]): string {
  return codes.length > 0 ? codes.join('、') : '（无）'
}

const selectedRole = computed(() => roles.value.find((role) => role.id === selectedRoleId.value) || null)
const isEditing = computed(() => selectedRoleId.value.length > 0)
const canSave = computed(() => draftRoleName.value.trim().length > 0 && draftRoleId.value.trim().length > 0)
function draftDiffersFromLoadedRole(): boolean {
  const baseline = loadedBaseline.value
  if (draftRoleName.value.trim() !== (baseline?.displayName ?? '')) return true
  if (!baseline) {
    return draftRoleId.value.trim().length > 0 || selectedPermissions.value.length > 0
  }
  return !sameCodeSet(selectedPermissions.value, baseline.permissions)
}

const isDirty = computed(() => draftDiffersFromLoadedRole() || conflictDraft.value !== null)
const controlsLocked = computed(() => leavePromptOpen.value || busy.value || transitionActive.value)
const authoritativePermissionLabel = computed(() => formatPermissionList(loadedBaseline.value?.permissions || []))
const conflictPermissionLabel = computed(() => formatPermissionList(conflictDraft.value?.permissions || []))

/**
 * Server refusal codes this page words itself (the server message is English). zh is shown; en is kept
 * for a later locale switch. ROLE_NAME_RESERVED: POST / PUT /api/roles refuse `admin` and the built-in
 * role names in any spelling (#6348 follow-up).
 */
const ROLE_WRITE_ERROR_COPY: Record<string, { zh: string; en: string }> = {
  ROLE_NAME_RESERVED: {
    zh: '该名称为系统保留名，不能用于自定义角色',
    en: 'This name is reserved for a built-in role and cannot be used for a custom role.',
  },
}

function roleWriteErrorMessage(error: unknown, fallback: string): string {
  const record = (error ?? {}) as Record<string, unknown>
  const copy = ROLE_WRITE_ERROR_COPY[String(record.code || '')]
  return copy ? copy.zh : String(record.message || fallback)
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

function snapshotBaseline(role: RoleCatalogItem): LoadedRoleBaseline {
  return {
    id: role.id,
    name: role.name,
    displayName: presentRoleTitle(role),
    permissions: [...(role.permissions || [])],
    updatedAt: role.updatedAt ?? null,
  }
}

function applyRole(role: RoleCatalogItem | null, options?: { keepConflict?: boolean }): void {
  const preserved = options?.keepConflict ? conflictDraft.value : null
  const baseline = role ? snapshotBaseline(role) : null
  selectedRoleId.value = baseline?.id || ''
  draftRoleId.value = baseline?.id || ''
  draftRoleName.value = baseline?.displayName || ''
  selectedPermissions.value = [...(baseline?.permissions || [])]
  loadedBaseline.value = baseline
  conflictDraft.value = preserved
  if (!options?.keepConflict) conflictServerReady.value = false
}

function resetForm(): void {
  applyRole(null)
}

function draftToPreserve(): PreservedRoleDraft {
  // A clean editor is the loaded baseline. Replacing an existing side draft with it
  // would drop the only copy of the conflicted edit.
  if (!draftDiffersFromLoadedRole() && conflictDraft.value?.roleId === selectedRoleId.value) {
    return conflictDraft.value
  }
  return {
    roleId: selectedRoleId.value,
    name: draftRoleName.value,
    permissions: [...selectedPermissions.value],
  }
}

function recoverConflictDraft(): void {
  const snapshot = conflictDraft.value
  if (!snapshot || snapshot.roleId !== selectedRoleId.value) return
  draftRoleName.value = snapshot.name
  selectedPermissions.value = [...snapshot.permissions]
}

function askLeaveChoice(): Promise<LeaveChoice> {
  if (pendingLeave) return pendingLeave
  leavePromptOpen.value = true
  pendingLeave = new Promise((resolve) => {
    leaveResolver = resolve
  })
  return pendingLeave
}

function chooseLeave(choice: LeaveChoice): void {
  const resolve = leaveResolver
  leaveResolver = null
  pendingLeave = null
  leavePromptOpen.value = false
  resolve?.(choice)
}

async function resolveLeave(): Promise<'proceed' | 'stay' | 'save'> {
  if (busy.value) return 'stay'
  if (!isDirty.value) return 'proceed'
  const choice = await askLeaveChoice()
  if (choice === 'discard') return 'proceed'
  if (choice === 'save') return 'save'
  return 'stay'
}

function transitionBusy(): boolean {
  return transitionActive.value || leavePromptOpen.value || busy.value
}

async function selectRole(role: RoleCatalogItem): Promise<void> {
  if (transitionBusy()) return
  if (role.id === selectedRoleId.value && !isDirty.value) return
  transitionActive.value = true
  try {
    const choice = await resolveLeave()
    if (choice === 'stay') return
    if (choice === 'save') {
      const saved = await saveRole({ keepDraftOnReadbackFailure: true })
      if (!saved) return
    }
    applyRole(role)
  } finally {
    transitionActive.value = false
  }
}

async function requestReset(): Promise<void> {
  if (transitionBusy()) return
  transitionActive.value = true
  try {
    const choice = await resolveLeave()
    if (choice === 'stay') return
    if (choice === 'save') {
      const saved = await saveRole({ keepDraftOnReadbackFailure: true })
      if (!saved) return
    }
    applyRole(null)
  } finally {
    transitionActive.value = false
  }
}

async function requestRefresh(): Promise<void> {
  if (transitionBusy()) return
  transitionActive.value = true
  try {
    const choice = await resolveLeave()
    if (choice === 'stay') return
    if (choice === 'save') {
      await saveRole({ keepDraftOnReadbackFailure: true })
      return
    }
    const currentId = selectedRoleId.value
    const reloaded = await loadCatalog()
    if (!reloaded) return
    applyRole(currentId ? roles.value.find((role) => role.id === currentId) || null : null)
  } finally {
    transitionActive.value = false
  }
}

async function leaveRoute(): Promise<boolean> {
  if (transitionBusy()) return false
  transitionActive.value = true
  try {
    const choice = await resolveLeave()
    if (choice === 'stay') return false
    if (choice === 'save') return saveRole({ keepDraftOnReadbackFailure: true })
    return true
  } finally {
    transitionActive.value = false
  }
}

function togglePermission(code: string, checked: boolean): void {
  const current = new Set(selectedPermissions.value)
  if (checked) current.add(code)
  else current.delete(code)
  selectedPermissions.value = Array.from(current.values()).sort()
}

/**
 * Returns whether the reload actually SUCCEEDED. The caller needs that distinction: this
 * function swallows its own error and leaves `roles.value` holding the pre-save array, so a
 * post-save reconciliation that cannot tell "reload failed" from "reload disagrees" would
 * report a data loss that never happened — and teach admins to ignore the one message this
 * page added to make silent drops visible.
 */
async function loadCatalog(): Promise<boolean> {
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
    // Catalog data and the editor draft are separate. Callers apply a role only after the
    // admin confirms a discard, or after a save readback matches what was submitted.
    return true
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载角色失败', 'error')
    return false
  } finally {
    loading.value = false
  }
}

async function saveRole(options?: { keepDraftOnReadbackFailure?: boolean }): Promise<boolean> {
  if (busy.value || leavePromptOpen.value) return false
  if (!canSave.value) {
    setStatus('请填写角色 ID 和角色名称后再保存', 'error')
    return false
  }
  busy.value = true
  // Captured before any reload. applyRole() may replace the editor after readback, and the
  // closing message still has to describe the action that was actually taken.
  const baseline = loadedBaseline.value
  const wasEditing = baseline !== null
  const editingId = baseline?.id ?? ''
  const baselineName = baseline?.name ?? null
  const baselineDisplay = baseline?.displayName ?? ''
  const baselinePermissions = baseline ? [...baseline.permissions] : []
  const baselineUpdatedAt = baseline?.updatedAt ?? null
  const keepDraftOnReadbackFailure = options?.keepDraftOnReadbackFailure === true
  try {
    const nameChanged = draftRoleName.value.trim() !== baselineDisplay
    const payload: Record<string, unknown> = {
      id: wasEditing ? editingId : draftRoleId.value.trim(),
      // The name field may show a Chinese builtin title. Leaving it untouched keeps the
      // loaded raw name; an actual edit of the field is an explicit rename. Restoring the
      // displayed title is not an edit, so the localized title is not written back.
      name: wasEditing
        ? roleNameForSave(baselineName, draftRoleName.value, nameChanged)
        : draftRoleName.value.trim(),
      permissions: selectedPermissions.value,
    }
    // Tokens belong to the editor baseline, not the catalog a failed or disagreeing
    // readback just refreshed. A later save of the preserved draft must still name the
    // set the admin loaded.
    if (wasEditing && baselineUpdatedAt) {
      payload.expectedUpdatedAt = baselineUpdatedAt
    }
    if (wasEditing) {
      payload.expectedPermissions = [...baselinePermissions]
    }
    const submittedPermissions = [...selectedPermissions.value]
    const submittedId = String(payload.id)
    const submittedName = String(payload.name)

    // An EXISTING role is addressed by the id it was LOADED with, never a trimmed copy: a
    // stored id that differs only by invisible padding would otherwise address its
    // look-alike — e.g. the real `<ns>_admin` instead of the padded duplicate.
    const response = await apiFetch(wasEditing ? `/api/roles/${encodeURIComponent(editingId)}` : '/api/roles', {
      method: wasEditing ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    })
    const body = await readJson(response)
    const errorCode = String((body.error as Record<string, unknown> | undefined)?.code || '')
    if (response.status === 409 && errorCode === 'ROLE_MODIFIED') {
      // Keep the unsaved edit beside the catalog. The editor itself shows the reloaded
      // role, so the next Save submits that baseline and its new tokens. The old draft is
      // written again only after 恢复未保存修改. A failed reload leaves the draft in place
      // and does not move the token baseline.
      const preserved = draftToPreserve()
      const reloaded = await loadCatalog()
      const latest = roles.value.find((role) => role.id === preserved.roleId) || null
      if (reloaded && latest) {
        conflictDraft.value = preserved
        conflictServerReady.value = true
        applyRole(latest, { keepConflict: true })
        setStatus('该角色已被其他人修改，已重新加载最新权限，请确认后再保存', 'error')
      } else {
        conflictDraft.value = preserved
        conflictServerReady.value = false
        draftRoleName.value = preserved.name
        selectedPermissions.value = [...preserved.permissions]
        setStatus(
          reloaded
            ? '该角色已被其他人修改，重新加载后未找到该角色，未保存修改已保留'
            : '该角色已被其他人修改，但无法重新加载最新权限，未保存修改已保留',
          'error',
        )
      }
      return false
    }
    if (!response.ok || body.ok !== true) {
      throw new Error(roleWriteErrorMessage(body.error, '保存角色失败'))
    }

    const acknowledgedId = String((body.data as Record<string, unknown> | undefined)?.id || payload.id)
    const reloaded = await loadCatalog()
    const persisted = roles.value.find((role) => role.id === submittedId) || null
    const subjectAcknowledged = acknowledgedId === submittedId
    const nameMatches = persisted?.name === submittedName
    const permissionsMatch = Boolean(persisted && sameCodeSet(persisted.permissions || [], submittedPermissions))
    const reconciled = Boolean(reloaded && persisted && subjectAcknowledged && nameMatches && permissionsMatch)
    // Continuation stays unless id, name, and permissions all match. A direct save still
    // shows a same-subject permission readback; a different name or id keeps the draft.
    const showPermissionReadback = !keepDraftOnReadbackFailure && reloaded && Boolean(persisted) && subjectAcknowledged && nameMatches
    if (reconciled || showPermissionReadback) applyRole(persisted)

    // Do not claim success on the strength of `ok: true` alone. This page used to report
    // 角色已更新 while the reloaded role still showed the OLD checkboxes, because the
    // backend silently dropped the permission set on edit; the reverted grid was the only
    // signal, and it looked like a rendering quirk. Re-reading the persisted set and
    // saying so when it disagrees with what was submitted makes that class of silent drop
    // visible here — including against a server that has not been updated yet.
    if (!reloaded) {
      // The write itself answered ok:true; only the re-read failed. Saying「不一致」here
      // would assert a data loss that did not happen (roles.value still holds the PRE-save
      // array, so the comparison below would be old-vs-submitted and always disagree).
      setStatus('已保存，但无法重新加载角色目录以核对，请刷新确认', 'error')
    } else if (!subjectAcknowledged) {
      setStatus('已保存，但服务端确认的角色与提交的不一致，请刷新确认', 'error')
    } else if (!persisted) {
      setStatus('已保存，但重新加载后未找到该角色，请刷新确认', 'error')
    } else if (!nameMatches) {
      setStatus(`已保存，但服务端记录的名称为 ${persisted.name}，与提交的名称不一致，请刷新确认`, 'error')
    } else if (!permissionsMatch) {
      setStatus(`已保存名称，但服务端记录的权限为 ${persisted.permissions?.length ?? 0} 项，与提交的 ${submittedPermissions.length} 项不一致，请刷新确认`, 'error')
    } else {
      setStatus(wasEditing ? '角色已更新' : '角色已创建')
    }
    return reconciled
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '保存角色失败', 'error')
    return false
  } finally {
    busy.value = false
  }
}

async function deleteRole(): Promise<void> {
  if (!isEditing.value || transitionBusy()) return
  if (!window.confirm(`确认删除角色 ${draftRoleName.value || draftRoleId.value}？`)) return

  busy.value = true
  const editingId = loadedBaseline.value?.id || selectedRoleId.value
  try {
    // The id as LOADED (see saveRole): a trimmed id would delete the real `<ns>_admin` — and
    // with it every membership and delegated audience — when the admin meant to remove a
    // padded look-alike of it.
    const response = await apiFetch(`/api/roles/${encodeURIComponent(editingId)}`, {
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

function handleBeforeUnload(event: BeforeUnloadEvent): void {
  if (!isDirty.value) return
  event.preventDefault()
  event.returnValue = ''
}

watch(isDirty, (dirty) => {
  if (dirty) window.addEventListener('beforeunload', handleBeforeUnload)
  else window.removeEventListener('beforeunload', handleBeforeUnload)
})

onMounted(async () => {
  await loadCatalog()
})

onUnmounted(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload)
  chooseLeave('stay')
})

// Tests mount this view with createApp and no router. onBeforeRouteLeave warns in that
// case unless a matched route record is actually present, which it is under <router-view>.
const matchedRoute = inject(matchedRouteKey, null)
if (matchedRoute?.value) {
  onBeforeRouteLeave(() => leaveRoute())
}
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

.admin-page__leave,
.admin-page__conflict {
  border: 1px solid #f59e0b;
  background: #fffbeb;
  border-radius: 12px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.admin-page__leave-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.admin-page__leave-shield {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(15, 23, 42, 0.45);
  box-sizing: border-box;
}

.admin-page__leave-shield .admin-page__leave {
  width: min(520px, 100%);
  box-sizing: border-box;
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

  .admin-page__header,
  .admin-page__actions {
    flex-direction: column;
    align-items: stretch;
  }

  .admin-page__actions .admin-page__button {
    width: 100%;
    box-sizing: border-box;
  }
}
</style>
