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
      <li v-for="group in groups" :key="group.id" data-testid="approval-template-groups-item">
        {{ group.name }}
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
  createApprovalTemplateGroup,
  listApprovalTemplateGroups,
  type ApprovalTemplateGroupDTO,
} from '../../approvals/api'

defineProps<{
  tr: (en: string, zh: string) => string
}>()

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
    loadError.value = err instanceof Error ? err.message : String(err)
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
  } catch (err) {
    if (err instanceof ApprovalApiError && err.code === 'SESSION_ORG_REQUIRED') {
      handleSessionOrgRequired(() => onCreate())
      return
    }
    loadError.value = err instanceof Error ? err.message : String(err)
  } finally {
    creating.value = false
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
