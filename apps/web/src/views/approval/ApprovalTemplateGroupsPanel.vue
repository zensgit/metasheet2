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

  P1-A (impl-gate-A5-daily-ops-round1-20260920.md, round 2): the paragraph above describes this
  panel STANDALONE, which is still exactly what it does when nothing provides a `SessionOrgHost`
  (its own spec mounts it that way, and acceptance J's mutation — remove the handling of that code
  ⇒ the flow stops at 403 — is load-bearing there). Mounted inside TemplateCenterView the page is
  the host: it owns the single `useSessionOrg()` instance, renders the single switcher and replays
  `loadGroups()` after a switch; this panel then reports the 403 upward and draws no control of its
  own. That is not a style preference — two live `useSessionOrg()` instances on one page destroy
  each other's `orgs` (see `SessionOrgSwitcher.vue`'s `SessionOrgHost` doc comment).

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
      v-if="!sessionOrgBlocked"
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
import { computed, inject, onMounted, ref } from 'vue'
import SessionOrgSwitcher, { SessionOrgHostKey } from '../../components/SessionOrgSwitcher.vue'
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

// P1-A — the page's host instance when there is one, this panel's own otherwise (see the header
// comment). `inject` with an explicit `null` default: no host is the normal case for every mount
// outside TemplateCenterView.
const sessionOrgHost = inject(SessionOrgHostKey, null)

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
} = sessionOrgHost?.sessionOrg ?? useSessionOrg()

const groups = ref<ApprovalTemplateGroupDTO[]>([])
const loading = ref(false)
const loadError = ref('')
// "this panel's load/create is blocked on a session-org choice" — it suppresses the group list
// (which is empty in that state, so the "No groups yet." empty row would be a lie) no matter who
// renders the control.
const sessionOrgBlocked = ref(false)
// Whether THIS panel draws the control. Never while hosted: the page draws exactly one.
const showSessionOrgSwitcher = computed(() => sessionOrgBlocked.value && sessionOrgHost === null)
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

// The one blocked action to replay once the session-org switch resolves. A single slot is enough
// because this panel serializes its own writes: `loadGroups` and `onCreate` guard on
// `loading`/`creating`, and `submitRename`/`onArchive`/`onUnarchive` (added in the daily-ops
// round, NIT-3 of that round's gate: the old wording "only ever one of loadGroups/onCreate" named
// two writers when there are now five) all guard on the single `actionBusyId` slot — so at most
// one of the five is ever in flight, and at most one can be waiting on a session org.
// Stays empty while hosted: the host replays `loadGroups()` itself after a successful switch.
let pendingRetry: (() => Promise<void>) | null = null

function handleSessionOrgRequired(retry: () => Promise<void>): void {
  sessionOrgBlocked.value = true
  if (sessionOrgHost) {
    // Hosted: the page owns the one fetch, the one rendered control and the replay. It replays
    // `loadGroups()` only — a blocked create/rename/archive/unarchive is deliberately NOT
    // auto-resubmitted into a freshly-chosen organization (see TemplateCenterView's
    // `onPageSessionOrgChange`); the admin re-submits it against the org they just picked.
    pendingRetry = null
    sessionOrgHost.notifySessionOrgRequired()
    return
  }
  pendingRetry = retry
  // Fire-and-forget: populates the switcher's `orgs` list. A rejection here only leaves the
  // switcher's own errorMessage set (useSessionOrg's own failure surface); it must never throw
  // back into the caller's try/catch.
  void loadSessionOrgs()
}

// Request-algebra guard (impl-gate-A5-daily-ops-round2-20260920.md, additional load-bearing
// scenario (ii)) — sibling of `TemplateGroupSections.vue`'s `loadAll()` guard (see its comment for
// the full rationale): the host replays `loadGroups()` on every successful session-org switch
// (`TemplateCenterView.onPageSessionOrgChange`), so two rapid switches can have this panel's two
// `loadGroups()` calls in flight together. Without a generation check, whichever call's network
// round trip happens to finish LAST wins — even when it was fired FIRST, for the org the admin has
// already switched away from — and would silently roll the panel's list back to the stale org.
let loadGeneration = 0

async function loadGroups(): Promise<void> {
  const generation = ++loadGeneration
  const isCurrent = () => generation === loadGeneration
  loading.value = true
  loadError.value = ''
  try {
    const result = await listApprovalTemplateGroups()
    if (!isCurrent()) return // a newer loadGroups() has since been issued — this answer is stale.
    groups.value = result
    sessionOrgBlocked.value = false
  } catch (err) {
    if (!isCurrent()) return
    if (err instanceof ApprovalApiError && err.code === 'SESSION_ORG_REQUIRED') {
      handleSessionOrgRequired(loadGroups)
      return
    }
    loadError.value = describeApprovalTemplateGroupError(err, props.tr)
  } finally {
    if (isCurrent()) loading.value = false
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
    sessionOrgBlocked.value = false
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

/**
 * In-place row swap, so the clicked row reflects the server's response immediately.
 *
 * P3-3 (impl-gate-A5-daily-ops-round1-20260920.md): this is a CONTENT update, never an ORDER
 * update. The server orders the list `ORDER BY (archived_at IS NOT NULL), sort_order NULLS LAST,
 * archived_at DESC NULLS LAST, name` (`ApprovalTemplateGroupService.ts:222`), and archiving nulls
 * `sort_order` while unarchiving takes `MAX+1` — so both of those actions move the row, and an
 * in-place swap alone leaves a just-archived group sitting among the active ones until the admin
 * collapses and reopens the panel. Those two actions therefore re-read the list from the server
 * (`loadGroups()`), which keeps the server the single ordering authority instead of reimplementing
 * that four-key comparator here. Rename does NOT re-read: the rename control is rendered only for
 * ACTIVE rows, and active rows are fully ordered by their unique non-null `sort_order`, so `name`
 * — the last key — can never decide their order.
 */
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
    // P3-3 — archiving nulls `sort_order` and moves the row to the archived tail. Re-read so the
    // panel's own order matches the server's (see `replaceGroup`'s doc comment). `loadGroups`
    // never throws; a failure there lands in its own error surface.
    await loadGroups()
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
    // P3-3 — unarchiving takes `sort_order = MAX+1` and moves the row back among the active ones
    // at the END of them. Re-read for the same reason as `onArchive`.
    await loadGroups()
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
  sessionOrgBlocked.value = false
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
