<template>
  <PageShell width="default">
    <PageHeader
      :title="t.title"
      :subtitle="t.subtitle"
    />

    <!-- Same gate as 批量转交: nothing below the header renders until the server's own
         approval-administrator answer arrives, and only `granted` may state what a person has. -->
    <p
      v-if="capability === 'pending'"
      class="user-lookup__gate"
      data-testid="user-lookup-capability-pending"
    >{{ t.capabilityPending }}</p>

    <el-alert
      v-else-if="capability === 'denied'"
      type="warning"
      show-icon
      :closable="false"
      class="user-lookup__alert"
      data-testid="user-lookup-forbidden"
      :title="t.forbiddenTitle"
      :description="t.forbiddenBody"
    />

    <el-alert
      v-else-if="capability === 'unavailable'"
      type="info"
      show-icon
      :closable="false"
      class="user-lookup__alert"
      data-testid="user-lookup-capability-unavailable"
      :title="t.capabilityUnavailableTitle"
      :description="t.capabilityUnavailableBody"
    />

    <template v-else>
      <section class="user-lookup__form" :aria-label="t.formRegion">
        <div class="user-lookup__field">
          <span class="user-lookup__label">{{ t.personLabel }}</span>
          <!-- Administrator directory: deactivated accounts are listed and tagged 「已停用」. -->
          <ApprovalUserPicker
            :model-value="userId || null"
            :placeholder="t.userPickerPlaceholder"
            :include-inactive="true"
            data-testid="user-lookup-picker"
            @update:model-value="onUserChange"
          />
        </div>

        <div class="user-lookup__field">
          <span class="user-lookup__label">{{ t.kindLabel }}</span>
          <div class="user-lookup__kinds" role="radiogroup" :aria-label="t.kindLabel">
            <el-button
              v-for="option in kindOptions"
              :key="option.kind"
              :type="option.kind === kind ? 'primary' : 'default'"
              role="radio"
              :aria-checked="option.kind === kind ? 'true' : 'false'"
              :data-testid="`user-lookup-kind-${option.kind}`"
              @click="onKindChange(option.kind)"
            >
              {{ option.label }}
            </el-button>
          </div>
        </div>
        <p class="user-lookup__hint" data-testid="user-lookup-kind-hint">{{ kindHint }}</p>

        <div class="user-lookup__actions">
          <el-button
            type="primary"
            :loading="loading"
            :disabled="!userId"
            data-testid="user-lookup-search"
            @click="search(1)"
          >
            {{ t.search }}
          </el-button>
        </div>
      </section>

      <el-alert
        v-if="loadError"
        type="error"
        show-icon
        :closable="false"
        class="user-lookup__alert"
        data-testid="user-lookup-error"
        :title="t.loadFailed"
      />

      <section v-if="result" class="user-lookup__results" :aria-label="t.resultsRegion">
        <p class="user-lookup__total" data-testid="user-lookup-total">{{ totalText }}</p>

        <!-- Reachable only on `granted` and only for a read that succeeded, so "nothing here" is
             never stated off a narrowed scope or a failed request. -->
        <p v-if="result.total === 0" class="user-lookup__empty" data-testid="user-lookup-empty">
          {{ emptyText }}
        </p>

        <ul v-else class="user-lookup__list">
          <li
            v-for="(row, index) in result.items"
            :key="row.id"
            class="user-lookup__row"
            :data-testid="`user-lookup-row-${row.id}`"
          >
            <el-button
              link
              type="primary"
              class="user-lookup__row-title"
              :data-testid="`user-lookup-open-${row.id}`"
              @click="openApproval(row.id)"
            >
              {{ rowLabel(row, index) }}
            </el-button>
            <span v-if="row.requestNo && row.title" class="user-lookup__row-meta">{{ row.requestNo }}</span>
            <span class="user-lookup__row-meta" :data-testid="`user-lookup-status-${row.id}`">{{ statusLabel(row.status) }}</span>
            <span v-if="row.requester.name" class="user-lookup__row-meta">{{ t.requesterPrefix }}{{ row.requester.name }}</span>
            <span class="user-lookup__row-meta">{{ formatTime(row.updatedAt) }}</span>
          </li>
        </ul>

        <div v-if="totalPages > 1" class="user-lookup__pager">
          <el-button
            :disabled="loading || result.page <= 1"
            data-testid="user-lookup-prev"
            @click="search(result.page - 1)"
          >
            {{ t.prevPage }}
          </el-button>
          <span data-testid="user-lookup-page">{{ pageText }}</span>
          <el-button
            :disabled="loading || result.page >= totalPages"
            data-testid="user-lookup-next"
            @click="search(result.page + 1)"
          >
            {{ t.nextPage }}
          </el-button>
        </div>
      </section>
    </template>
  </PageShell>
</template>

<script setup lang="ts">
// 按人查单（管理员）: one person's 当前待审批 / 已审批 / 参与过 approvals — including a person whose
// account has been deactivated, which is the case 流程交接 after a departure needs.
//
// EVERY RULE IS THE SERVER'S. The read is `GET /api/approvals/admin/by-user` (`approvals:admin`, the
// same permission as 批量转交; no new permission code). It is the ordinary approval list with one
// filter added; access checks stay consistent with the existing approval read permission and the
// detail / history endpoints. This page waits for the administrator confirmation
// (`useApprovalAdminCapability`) before it lists anything, exactly like 批量转交, and states "this
// person has none" only on `granted`. Opening a row goes to the ordinary detail page.
//
// ONE PERSON AND ONE KIND PER READ. A response is applied only if the person, the kind and the
// read generation it was issued for are all still current, so a slow answer about someone else
// can never fill the page.
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageShell from '../../components/layout/PageShell.vue'
import PageHeader from '../../components/layout/PageHeader.vue'
import ApprovalUserPicker from '../../approvals/components/ApprovalUserPicker.vue'
import {
  APPROVAL_BY_USER_DEFAULT_PAGE_SIZE,
  APPROVAL_BY_USER_KINDS,
  listApprovalsByUser,
  type ApprovalByUserKind,
  type ApprovalByUserPage,
  type ApprovalByUserRow,
} from '../../approvals/api'
import { useApprovalAdminCapability } from '../../approvals/useApprovalAdminCapability'
import {
  userLookupEmptyText,
  userLookupKindHint,
  userLookupKindLabel,
  userLookupRowLabel,
  userLookupTotalPages,
} from '../../approvals/userLookup'
import { resolveStatusDisplay } from '../../utils/statusDomains'
import { useLocale } from '../../composables/useLocale'

const { isZh } = useLocale()
const router = useRouter()

const ZH = {
  title: '按人查单',
  subtitle: '查看某个人当前待审批、已审批和参与过的审批，包括已停用的账号。只读，不改变任何审批。',
  formRegion: '查询条件',
  resultsRegion: '查询结果',
  personLabel: '人员',
  kindLabel: '范围',
  userPickerPlaceholder: '搜索用户名 / 邮箱 / ID（含已停用）',
  search: '查询',
  loadFailed: '查询失败，请重试',
  totalPrefix: '共',
  totalSuffix: '条',
  requesterPrefix: '发起人：',
  prevPage: '上一页',
  nextPage: '下一页',
  capabilityPending: '正在确认权限…',
  forbiddenTitle: '权限不足：无法按人查看审批',
  forbiddenBody: '按人查单需要审批管理员权限（由服务端按账号判定），与批量转交相同。当前账号不具备该权限，因此本页不会列出任何人的审批。请联系平台管理员。',
  capabilityUnavailableTitle: '暂时无法确认权限',
  capabilityUnavailableBody: '服务端未能确认当前账号是否为审批管理员。这不代表权限不足；在确认之前，本页不会列出任何审批。请稍后重试。',
} as const

const EN: Record<keyof typeof ZH, string> = {
  title: 'Look Up by Person',
  subtitle: 'See one person’s pending, decided and involved approvals, including a deactivated account. Read-only; nothing is changed.',
  formRegion: 'Lookup criteria',
  resultsRegion: 'Lookup results',
  personLabel: 'Person',
  kindLabel: 'Scope',
  userPickerPlaceholder: 'Search by name / email / ID (deactivated included)',
  search: 'Look up',
  loadFailed: 'The lookup failed; please retry',
  totalPrefix: 'Total',
  totalSuffix: 'items',
  requesterPrefix: 'Requester: ',
  prevPage: 'Previous',
  nextPage: 'Next',
  capabilityPending: 'Confirming your access…',
  forbiddenTitle: 'Insufficient privilege: approvals cannot be looked up by person',
  forbiddenBody: 'Looking up by person requires approval-administrator access, which the server decides per account — the same access as batch transfer. This account does not have it, so nobody’s approvals are listed here. Please contact a platform administrator.',
  capabilityUnavailableTitle: 'Your access could not be confirmed right now',
  capabilityUnavailableBody: 'The server did not confirm whether this account is an approval administrator. That is not the same as being refused; until it is confirmed, this page lists nothing. Please retry shortly.',
}

const t = computed(() => (isZh.value ? ZH : EN))

const userId = ref('')
const kind = ref<ApprovalByUserKind>('pending')
const loading = ref(false)
const loadError = ref(false)
const result = ref<ApprovalByUserPage | null>(null)
// Monotonic per read; also bumped by anything that makes an in-flight read stale.
const generation = ref(0)

function clearResults(): void {
  generation.value += 1
  loading.value = false
  loadError.value = false
  result.value = null
}

// A new principal gets an empty page. Unlike 批量转交 this page holds no unsent work, so it clears
// on every transition rather than comparing subjects.
const capability = useApprovalAdminCapability({
  onInvalidated: () => {
    userId.value = ''
    clearResults()
  },
})

const kindOptions = computed(() => APPROVAL_BY_USER_KINDS.map((value) => ({
  kind: value,
  label: userLookupKindLabel(value, isZh.value),
})))
const kindHint = computed(() => userLookupKindHint(kind.value, isZh.value))
const emptyText = computed(() => userLookupEmptyText(result.value?.kind ?? kind.value, isZh.value))
const totalPages = computed(() => (result.value
  ? userLookupTotalPages(result.value.total, result.value.pageSize)
  : 1))
const totalText = computed(() => (result.value
  ? `${t.value.totalPrefix} ${result.value.total} ${t.value.totalSuffix}`
  : ''))
const pageText = computed(() => {
  if (!result.value) return ''
  return isZh.value
    ? `第 ${result.value.page} / ${totalPages.value} 页`
    : `Page ${result.value.page} of ${totalPages.value}`
})

function onUserChange(next: string | null): void {
  userId.value = next ?? ''
  clearResults()
}

function onKindChange(next: ApprovalByUserKind): void {
  if (next === kind.value) return
  kind.value = next
  clearResults()
  if (userId.value) void search(1)
}

async function search(page: number): Promise<void> {
  const person = userId.value
  const requestedKind = kind.value
  if (!person) return
  generation.value += 1
  const mine = generation.value
  loading.value = true
  loadError.value = false
  try {
    const answer = await listApprovalsByUser(person, requestedKind, page, APPROVAL_BY_USER_DEFAULT_PAGE_SIZE)
    if (mine !== generation.value || person !== userId.value || requestedKind !== kind.value) return
    result.value = answer
  } catch {
    if (mine !== generation.value || person !== userId.value || requestedKind !== kind.value) return
    // A failed read is never shown as an empty one.
    result.value = null
    loadError.value = true
  } finally {
    if (mine === generation.value) loading.value = false
  }
}

function rowLabel(row: ApprovalByUserRow, index: number): string {
  return userLookupRowLabel(row, index, isZh.value)
}

function statusLabel(status: string): string {
  return resolveStatusDisplay('approvalInstance', status, isZh.value).label
}

function formatTime(value: string): string {
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return ''
  return new Date(parsed).toLocaleString(isZh.value ? 'zh-CN' : 'en-US')
}

function openApproval(id: string): void {
  void router.push({ name: 'approval-detail', params: { id } })
}
</script>

<style scoped>
.user-lookup__form {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
  margin-bottom: var(--ms-space-4);
}

.user-lookup__field {
  display: flex;
  align-items: flex-start;
  gap: var(--ms-space-3);
}

.user-lookup__label {
  flex: 0 0 auto;
  min-width: 4em;
  padding-top: 6px;
}

.user-lookup__kinds {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-2);
}

.user-lookup__hint,
.user-lookup__gate,
.user-lookup__total,
.user-lookup__empty {
  margin: 0;
  color: var(--el-text-color-secondary);
}

.user-lookup__alert {
  margin-bottom: var(--ms-space-4);
}

.user-lookup__list {
  list-style: none;
  margin: var(--ms-space-3) 0;
  padding: 0;
}

.user-lookup__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ms-space-3);
  padding: var(--ms-space-2) 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.user-lookup__row-meta {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.user-lookup__pager {
  display: flex;
  align-items: center;
  gap: var(--ms-space-3);
}

@media (max-width: 640px) {
  .user-lookup__field {
    flex-direction: column;
  }
}
</style>
