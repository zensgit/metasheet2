<!--
  Approval form grouping — design lock v2.13 (RATIFIED 2026-09-18) §6 phase 1, A-2 scope item 2:
  the template center's minimal integration point for the seven `/api/approval-template-groups*`
  endpoints, and the ONLY place in this slice that exercises acceptance J (§4): a multi-org member
  who has not picked a session organization yet has no `authenticatedTenantId`
  (`AuthService.resolveSessionTenantId:387-420` only mints one when the member belongs to exactly
  one org), so every group endpoint fail-closes 403 `SESSION_ORG_REQUIRED`.

  This panel shows the shared `SessionOrgSwitcher` ONLY once a group call has actually come back
  with that code — it does not proactively load session orgs on mount the way
  `AttendanceView.vue`'s always-visible switcher does. That is a deliberate divergence from the
  attendance precedent, not an oversight: the lock's own mechanism (§2 "多 org 成员") is "403 响应带
  SESSION_ORG_REQUIRED 供前端触发选择器" — reactive, not proactive — and it is the only way to get
  acceptance J's "a single-org member never sees the selector" for free: a single-org member's
  `authenticatedTenantId` is always populated at login, so no call from this panel ever receives
  SESSION_ORG_REQUIRED, `loadSessionOrgs()` is therefore never invoked, and the switcher's own
  `orgs.length > 0` visibility gate never opens.

  Neither `useSessionOrg.ts` nor `views/attendance/AttendanceSessionOrgSwitcher.vue` is touched —
  moving or editing either would narrow `attendance-web-guard.yml:297-301,:397-400`'s closed-world
  census (design lock §2, 第 8 轮 P3-b).

  Daily-ops fix round (groups-daily-ops-real-browser-acceptance-20260920.md) added three things,
  none of them a new backend capability — every endpoint/client function below already shipped in
  §6 phase 1 (A-1/A-2), this only wires UI onto it:
    P2-1 — archived groups get a visible "Archived" badge + `data-group-id` (the server already
           sends `archivedAt` on every row; this list never filtered it, per `listApprovalTemplateGroups`'s
           own doc comment — "every reader sees the group list", archived rows included, by design).
    P2-2 — failures route through `describeApprovalTemplateGroupError` (`approvals/api.ts`) instead
           of the raw server `.message`, so a mapped code (e.g. `GROUP_NAME_UNSUPPORTED`) renders
           product copy instead of the internal-jargon string the finding screenshotted.
    P2-4 — rename / archive / unarchive controls, consuming the pre-existing
           `renameApprovalTemplateGroup` / `archiveApprovalTemplateGroup` / `unarchiveApprovalTemplateGroup`
           client functions (A-2 design MD §1.2: "已在 api.ts 就绪待未来切片消费"). Archiving
           unlinks every member of the group (Q4, I8) — a native `confirm()` states that
           consequence in general terms before the request fires; no member COUNT is shown because
           no endpoint returns one. `link`/`unlink` are NOT added here — they already have a UI
           consumer (`TemplateGroupSections.vue`'s "移动到…" select, A-4).
-->
<template>
  <section class="approval-template-groups-panel" data-testid="approval-template-groups-panel">
    <h3 class="approval-template-groups-panel__title">
      {{ tr('Template groups', '模板分组') }}
    </h3>

    <SessionOrgSwitcher
      v-if="showSessionOrgSwitcher"
      :tr="tr"
      :orgs="orgs"
      :model-value="selectedOrgId"
      :loading="sessionOrgLoading"
      :switching="sessionOrgSwitching"
      :error-message="sessionOrgError"
      @change="onSessionOrgChange"
    />

    <p
      v-if="loadError"
      role="alert"
      class="approval-template-groups-panel__error"
      data-testid="approval-template-groups-load-error"
    >
      {{ loadError }}
    </p>

    <ul
      v-if="!showSessionOrgSwitcher"
      class="approval-template-groups-panel__list"
      data-testid="approval-template-groups-list"
    >
      <li
        v-for="group in groups"
        :key="group.id"
        :data-group-id="group.id"
        :data-testid="group.archivedAt ? 'approval-template-groups-item-archived' : 'approval-template-groups-item'"
        class="approval-template-groups-panel__item"
        :class="{ 'approval-template-groups-panel__item--archived': group.archivedAt }"
      >
        <span v-if="renamingId !== group.id" class="approval-template-groups-panel__item-name">
          {{ group.name }}
          <span
            v-if="group.archivedAt"
            class="approval-template-groups-panel__badge"
            data-testid="approval-template-groups-item-archived-badge"
          >{{ tr('Archived', '已归档') }}</span>
        </span>
        <span v-else class="approval-template-groups-panel__rename">
          <input
            v-model="renameValue"
            type="text"
            data-testid="approval-template-groups-rename-input"
            @keyup.enter="submitRename(group)"
            @keyup.esc="cancelRename"
          />
          <button
            type="button"
            :disabled="actionBusyId === group.id || !renameValue.trim()"
            data-testid="approval-template-groups-rename-save"
            @click="submitRename(group)"
          >{{ tr('Save', '保存') }}</button>
          <button
            type="button"
            data-testid="approval-template-groups-rename-cancel"
            @click="cancelRename"
          >{{ tr('Cancel', '取消') }}</button>
        </span>
        <span class="approval-template-groups-panel__item-actions">
          <button
            v-if="!group.archivedAt && renamingId !== group.id"
            type="button"
            :disabled="actionBusyId === group.id"
            data-testid="approval-template-groups-rename-button"
            @click="startRename(group)"
          >{{ tr('Rename', '重命名') }}</button>
          <button
            v-if="!group.archivedAt"
            type="button"
            :disabled="actionBusyId === group.id"
            data-testid="approval-template-groups-archive-button"
            @click="onArchive(group)"
          >{{ tr('Archive', '归档') }}</button>
          <button
            v-else
            type="button"
            :disabled="actionBusyId === group.id"
            data-testid="approval-template-groups-unarchive-button"
            @click="onUnarchive(group)"
          >{{ tr('Unarchive', '取消归档') }}</button>
        </span>
      </li>
      <li v-if="!loading && groups.length === 0" class="approval-template-groups-panel__empty">
        {{ tr('No groups yet.', '暂无分组。') }}
      </li>
    </ul>

    <form class="approval-template-groups-panel__create" @submit.prevent="onCreate">
      <input
        v-model="newGroupName"
        type="text"
        :placeholder="tr('New group name', '新分组名称')"
        data-testid="approval-template-groups-create-input"
      />
      <button
        type="submit"
        :disabled="creating || !newGroupName.trim()"
        data-testid="approval-template-groups-create-button"
      >
        {{ tr('Create group', '新建分组') }}
      </button>
    </form>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import SessionOrgSwitcher from '../../components/SessionOrgSwitcher.vue'
import { useSessionOrg } from '../../composables/useSessionOrg'
import {
  ApprovalApiError,
  archiveApprovalTemplateGroup,
  createApprovalTemplateGroup,
  describeApprovalTemplateGroupError,
  listApprovalTemplateGroups,
  renameApprovalTemplateGroup,
  unarchiveApprovalTemplateGroup,
  type ApprovalTemplateGroupDTO,
} from '../../approvals/api'

const props = defineProps<{
  tr: (en: string, zh: string) => string
}>()

// A-2 x A-4 merge convergence (2026-09-20) — this panel is the group MANAGEMENT entry; A-4's
// TemplateGroupSections is the surface that renders the org's groups and owns their order. The
// two do not share a reactive store (the sections view fetches its own list on mount, which its
// spec pins), so a mutation here has to tell the parent to re-read rather than mutate the other
// component's state: `changed` fires only after a mutation the server accepted, and
// TemplateCenterView re-runs the sections view's own `loadAll()`. Nothing is emitted on load or
// on a failed submit.
const emit = defineEmits<{ changed: [] }>()

const {
  orgs,
  // `selectedOrgId` (not the raw `currentOrgId`) — the composable already normalizes `null` to
  // `''` here, which is what `SessionOrgSwitcher`'s `modelValue: string` prop requires.
  selectedOrgId,
  loading: sessionOrgLoading,
  switching: sessionOrgSwitching,
  errorMessage: sessionOrgError,
  loadSessionOrgs,
  switchSessionOrg,
} = useSessionOrg()

const groups = ref<ApprovalTemplateGroupDTO[]>([])
const loading = ref(false)
const loadError = ref('')
const showSessionOrgSwitcher = ref(false)
const newGroupName = ref('')
const creating = ref(false)

// P2-4 (daily-ops fix round) — rename / archive / unarchive state. `actionBusyId` is a SINGLE
// slot (one group id, or null): the panel already serializes its own writes (create/rename/
// archive/unarchive all guard on it or on `creating`), so only one row-level action is ever in
// flight, and disabling every action button for the busy row (not just the one clicked) is the
// simplest correct behaviour while a rename/archive/unarchive round-trips.
const renamingId = ref<string | null>(null)
const renameValue = ref('')
const actionBusyId = ref<string | null>(null)

// The one blocked action to replay once the session-org switch resolves. Only ever one of
// `loadGroups`/`onCreate` is in flight from this panel at a time (both guard on
// loading/creating), so a single slot is enough — no queue needed.
let pendingRetry: (() => Promise<void>) | null = null

function handleSessionOrgRequired(retry: () => Promise<void>): void {
  pendingRetry = retry
  showSessionOrgSwitcher.value = true
  // Fire-and-forget: populates the switcher's `orgs` list. A rejection here only leaves the
  // switcher's own errorMessage set (useSessionOrg's own failure surface); it must never throw
  // back into the caller's try/catch.
  void loadSessionOrgs()
}

async function loadGroups(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    groups.value = await listApprovalTemplateGroups()
    showSessionOrgSwitcher.value = false
  } catch (err) {
    if (err instanceof ApprovalApiError && err.code === 'SESSION_ORG_REQUIRED') {
      handleSessionOrgRequired(loadGroups)
      return
    }
    loadError.value = describeApprovalTemplateGroupError(err, props.tr)
  } finally {
    loading.value = false
  }
}

async function onCreate(): Promise<void> {
  const name = newGroupName.value.trim()
  if (!name || creating.value) return
  creating.value = true
  try {
    const group = await createApprovalTemplateGroup(name)
    groups.value = [...groups.value, group]
    newGroupName.value = ''
    showSessionOrgSwitcher.value = false
    emit('changed')
  } catch (err) {
    if (err instanceof ApprovalApiError && err.code === 'SESSION_ORG_REQUIRED') {
      handleSessionOrgRequired(() => onCreate())
      return
    }
    loadError.value = describeApprovalTemplateGroupError(err, props.tr)
  } finally {
    creating.value = false
  }
}

function startRename(group: ApprovalTemplateGroupDTO): void {
  if (actionBusyId.value) return
  renamingId.value = group.id
  renameValue.value = group.name
}

function cancelRename(): void {
  renamingId.value = null
  renameValue.value = ''
}

function replaceGroup(updated: ApprovalTemplateGroupDTO): void {
  const idx = groups.value.findIndex((g) => g.id === updated.id)
  if (idx !== -1) groups.value.splice(idx, 1, updated)
}

async function submitRename(group: ApprovalTemplateGroupDTO): Promise<void> {
  const name = renameValue.value.trim()
  if (!name || actionBusyId.value) return
  actionBusyId.value = group.id
  loadError.value = ''
  try {
    const updated = await renameApprovalTemplateGroup(group.id, name)
    replaceGroup(updated)
    cancelRename()
    emit('changed')
  } catch (err) {
    if (err instanceof ApprovalApiError && err.code === 'SESSION_ORG_REQUIRED') {
      handleSessionOrgRequired(() => submitRename(group))
      return
    }
    loadError.value = describeApprovalTemplateGroupError(err, props.tr)
  } finally {
    actionBusyId.value = null
  }
}

async function onArchive(group: ApprovalTemplateGroupDTO): Promise<void> {
  if (actionBusyId.value) return
  // Q4 (design lock v2.13, ratified): archiving unlinks every member of the group — this states
  // that consequence in general terms (no endpoint returns a member COUNT, so none is printed).
  const confirmed = window.confirm(props.tr('Archiving this group will remove it from every template currently linked to it. Continue?', '归档该分组会解除其下所有模板与该分组的关联。是否继续？'))
  if (!confirmed) return
  actionBusyId.value = group.id
  loadError.value = ''
  try {
    const updated = await archiveApprovalTemplateGroup(group.id)
    replaceGroup(updated)
    emit('changed')
  } catch (err) {
    if (err instanceof ApprovalApiError && err.code === 'SESSION_ORG_REQUIRED') {
      handleSessionOrgRequired(() => onArchive(group))
      return
    }
    loadError.value = describeApprovalTemplateGroupError(err, props.tr)
  } finally {
    actionBusyId.value = null
  }
}

async function onUnarchive(group: ApprovalTemplateGroupDTO): Promise<void> {
  if (actionBusyId.value) return
  actionBusyId.value = group.id
  loadError.value = ''
  try {
    const updated = await unarchiveApprovalTemplateGroup(group.id)
    replaceGroup(updated)
    emit('changed')
  } catch (err) {
    if (err instanceof ApprovalApiError && err.code === 'SESSION_ORG_REQUIRED') {
      handleSessionOrgRequired(() => onUnarchive(group))
      return
    }
    loadError.value = describeApprovalTemplateGroupError(err, props.tr)
  } finally {
    actionBusyId.value = null
  }
}

async function onSessionOrgChange(orgId: string): Promise<void> {
  const ok = await switchSessionOrg(orgId)
  if (!ok) return
  showSessionOrgSwitcher.value = false
  const retry = pendingRetry
  pendingRetry = null
  if (retry) await retry()
}

onMounted(loadGroups)

defineExpose({ loadGroups })
</script>

<style scoped>
.approval-template-groups-panel {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid #e4e7ec;
  border-radius: 8px;
  margin-bottom: 16px;
}

.approval-template-groups-panel__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.approval-template-groups-panel__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
}

.approval-template-groups-panel__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

/* P2-1 — archived rows are greyed out, on top of the "Archived" badge, so the two are
   distinguishable even at a glance / in a screenshot with text cut off. */
.approval-template-groups-panel__item--archived {
  color: #8a97a6;
}

.approval-template-groups-panel__badge {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  color: #66788a;
  background: #eef1f4;
  vertical-align: middle;
}

.approval-template-groups-panel__rename {
  display: flex;
  gap: 4px;
  flex: 1;
}

.approval-template-groups-panel__rename input {
  flex: 1;
  min-width: 0;
}

.approval-template-groups-panel__item-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.approval-template-groups-panel__empty {
  color: #66788a;
  font-size: 12px;
}

.approval-template-groups-panel__error {
  color: #b42318;
  font-size: 12px;
  margin: 0;
}

.approval-template-groups-panel__create {
  display: flex;
  gap: 8px;
}
</style>
