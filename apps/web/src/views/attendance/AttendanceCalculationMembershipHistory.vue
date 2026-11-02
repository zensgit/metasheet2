<template>
  <section v-if="available()" class="calculation-membership-history" data-attendance-calculation-history>
    <h3>{{ tr('Calculation-group history', '核算组归属记录') }}</h3>
    <p>{{ tr('Recorded date intervals for one person across groups in this organization. Management-group Joined time is separate; this view does not change membership.', '查看所选人员在本组织内跨组的核算日期区间。管理名单的加入时间与此不同；此处不修改成员归属。') }}</p>
    <div class="calculation-membership-history__controls">
      <label for="attendance-calculation-person-search">
        {{ tr('Find an organization person', '查找组织人员') }}
        <input id="attendance-calculation-person-search" v-model="searchQuery" type="search" autocomplete="off" />
      </label>
      <button type="button" :disabled="searchLoading || !searchQuery.trim()" data-attendance-calculation-search @click="searchPeople">
        {{ searchLoading ? tr('Searching...', '搜索中...') : tr('Search', '搜索') }}
      </button>
      <label for="attendance-calculation-person">
        {{ tr('Person', '人员') }}
        <select id="attendance-calculation-person" v-model="userId" data-attendance-calculation-person>
          <option value="">{{ tr('Select a person', '选择人员') }}</option>
          <option v-for="person in people" :key="person.id" :value="person.id">{{ personLabel(person) }}</option>
        </select>
      </label>
    </div>
    <p v-if="searchError" role="status" data-attendance-calculation-search-error>{{ tr('Organization person search unavailable.', '组织人员搜索暂不可用。') }}</p>
    <p v-else-if="searchSettled && !people.length" role="status">{{ tr('No matching people returned.', '未返回匹配人员。') }}</p>
    <details>
      <summary>{{ tr('Known technical person ID', '已知的人员技术 ID') }}</summary>
      <label for="attendance-calculation-person-id">
        {{ tr('Person ID', '人员 ID') }}
        <input id="attendance-calculation-person-id" v-model.trim="userId" data-attendance-calculation-person-id autocomplete="off" />
      </label>
    </details>
    <p v-if="userId">
      <strong data-attendance-calculation-person-label>{{ selectedPersonLabel }}</strong>
    </p>
    <button type="button" :disabled="loading || !userId" data-attendance-calculation-view @click="loadHistory">
      {{ loading ? tr('Loading...', '加载中...') : tr('View / refresh recorded intervals', '查看 / 刷新归属区间') }}
    </button>
    <div aria-live="polite">
      <p v-if="error === 'forbidden'" data-attendance-calculation-error>{{ tr('Administrator access required for this organization.', '需要此组织的管理员权限。') }}</p>
      <p v-else-if="error" data-attendance-calculation-error>{{ tr('Recorded calculation-group history unavailable.', '核算组归属记录暂不可用。') }}</p>
      <p v-else-if="loaded && !rows.length" data-attendance-calculation-empty>{{ tr('No recorded calculation-group intervals for this person in this organization. This does not imply an organization default.', '本组织内没有此人员的核算组归属区间记录；这不代表继承组织默认。') }}</p>
      <table v-else-if="loaded" data-attendance-calculation-intervals>
        <caption>{{ tr('Recorded intervals, both dates inclusive', '归属记录：起止日期均包含当天') }}</caption>
        <thead>
          <tr>
            <th scope="col">{{ tr('Calculation group', '核算组') }}</th>
            <th scope="col">{{ tr('Effective from (inclusive)', '生效起日（包含）') }}</th>
            <th scope="col">{{ tr('Effective through (inclusive)', '生效止日（包含）') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id" data-attendance-calculation-interval>
            <td>
              <strong data-attendance-calculation-group-name>{{ groupLabel(row.groupId) }}</strong>
              <details><summary>{{ tr('Technical group ID', '考勤组技术 ID') }}</summary><code>{{ row.groupId }}</code></details>
            </td>
            <td data-attendance-calculation-from>{{ row.effectiveFrom }}</td>
            <td data-attendance-calculation-through>{{ row.effectiveTo ?? tr('No recorded end', '未记录止日') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { apiFetch } from '../../utils/api'
import { useLocale } from '../../composables/useLocale'
import { useAttendanceSessionGuard } from '../../composables/useAttendanceSessionGuard'
import { useAttendanceCalculationCapability } from './useAttendanceCalculationCapability'
import { attendanceGroupEffectivePolicyNeutralMemberLabel } from './attendanceGroupEffectivePolicyLabels'
import {
  readAttendanceCalculationMembershipHistory,
  type AttendanceCalculationHistoryInterval,
} from './attendanceCalculationMembershipHistory'

const props = defineProps<{
  enabled: boolean
  active: boolean
  canRead: () => boolean
  orgId: string
  groupId: string
  groups: readonly { id: string; orgId?: string; name: string }[]
}>()
interface Person { id: string; name: string; email: string }
const { isZh } = useLocale()
const tr = (en: string, zh: string) => isZh.value ? zh : en
const session = useAttendanceSessionGuard()
const send = session.wrapFetch(apiFetch)
const capabilityEpoch = useAttendanceCalculationCapability(() => props.canRead())
const userId = ref('')
const searchQuery = ref('')
const people = ref<Person[]>([])
const rows = ref<readonly AttendanceCalculationHistoryInterval[]>([])
const loading = ref(false)
const searchLoading = ref(false)
const searchError = ref(false)
const searchSettled = ref(false)
const loaded = ref(false)
const error = ref<'forbidden' | 'unavailable' | ''>('')
let mounted = true
let contextVersion = 0
let timelineVersion = 0
let searchVersion = 0
let timelineController: AbortController | null = null
let searchController: AbortController | null = null

function available(): boolean {
  return mounted && props.enabled && props.active && props.canRead() === true
    && Boolean(props.orgId && props.groupId) && !session.stale.value
}
function clearTimeline(): void {
  timelineVersion += 1
  timelineController?.abort()
  timelineController = null
  rows.value = []
  loaded.value = false
  loading.value = false
  error.value = ''
}
function clearSearch(): void {
  searchVersion += 1
  searchController?.abort()
  searchController = null
  people.value = []
  searchLoading.value = false
  searchError.value = false
  searchSettled.value = false
}
watch(userId, clearTimeline, { flush: 'sync' })
watch(searchQuery, clearSearch, { flush: 'sync' })
watch(
  [() => props.orgId, () => props.groupId, () => props.active, () => props.enabled, () => capabilityEpoch.value, () => session.stale.value],
  () => { contextVersion += 1; userId.value = ''; searchQuery.value = ''; clearTimeline(); clearSearch() },
  { immediate: true, flush: 'sync' },
)
onBeforeUnmount(() => { mounted = false; contextVersion += 1; clearTimeline(); clearSearch() })
function current(version: number): boolean {
  return version === contextVersion && available() && session.isCurrent()
}
function personLabel(person: Person): string {
  const email = person.email.trim()
  return person.name.trim() || (email !== person.id ? email : '')
    || attendanceGroupEffectivePolicyNeutralMemberLabel('unknown', tr)
}
const selectedPersonLabel = computed(() => {
  const person = people.value.find(item => item.id === userId.value)
  return person ? personLabel(person) : attendanceGroupEffectivePolicyNeutralMemberLabel('unknown', tr)
})
function groupLabel(id: string): string {
  const group = props.groups.find(item => item.id === id && item.orgId === props.orgId)
  return group?.name.trim() || tr('Unavailable group', '无法识别的考勤组')
}
function readPeople(payload: unknown): Person[] | null {
  if (!payload || typeof payload !== 'object' || !('ok' in payload) || payload.ok !== true || !('data' in payload)) return null
  const data = payload.data
  if (!data || typeof data !== 'object' || !('items' in data) || !Array.isArray(data.items)) return null
  const result: Person[] = []
  const ids = new Set<string>()
  for (const candidate of data.items as unknown[]) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
    const item = candidate as Record<string, unknown>
    const { id, name, email } = item
    if (typeof id !== 'string' || !id.trim() || ids.has(id)) return null
    if ((name != null && typeof name !== 'string') || (email != null && typeof email !== 'string')) return null
    ids.add(id)
    result.push({ id, name: typeof name === 'string' ? name : '', email: typeof email === 'string' ? email : '' })
  }
  return result
}
async function searchPeople(): Promise<void> {
  if (!available() || !session.isCurrent() || searchLoading.value || !searchQuery.value.trim()) return
  const context = contextVersion
  const version = ++searchVersion
  searchController?.abort()
  const controller = new AbortController()
  searchController = controller
  const isCurrent = () => version === searchVersion && current(context)
  const params = new URLSearchParams({ orgId: props.orgId, q: searchQuery.value.trim() })
  searchLoading.value = true
  searchError.value = false
  searchSettled.value = false
  try {
    const response = await send('/api/attendance-admin/users/search?' + params.toString(), {
      signal: controller.signal, suppressUnauthorizedRedirect: true,
    })
    const ok = response.ok
    if (!isCurrent()) return
    if (!ok) { searchError.value = true; return }
    const payload: unknown = await response.json()
    if (!isCurrent()) return
    const parsed = readPeople(payload)
    if (!parsed) { searchError.value = true; return }
    people.value = parsed
    searchSettled.value = true
  } catch {
    if (isCurrent()) searchError.value = true
  } finally {
    if (searchController === controller) searchController = null
    if (isCurrent()) searchLoading.value = false
  }
}
async function loadHistory(): Promise<void> {
  if (!available() || !session.isCurrent() || loading.value || !userId.value) return
  clearTimeline()
  const context = contextVersion
  const version = timelineVersion
  const controller = new AbortController()
  timelineController = controller
  const scope = { orgId: props.orgId, userId: userId.value }
  const isCurrent = () => version === timelineVersion && current(context)
  loading.value = true
  const params = new URLSearchParams(scope)
  try {
    const response = await send('/api/attendance-admin/calculation-group-memberships?' + params.toString(), {
      signal: controller.signal, suppressUnauthorizedRedirect: true,
    })
    const ok = response.ok
    const status = response.status
    if (!isCurrent()) return
    if (!ok) { error.value = status === 401 || status === 403 ? 'forbidden' : 'unavailable'; return }
    const payload: unknown = await response.json()
    if (!isCurrent()) return
    const parsed = readAttendanceCalculationMembershipHistory(payload, scope)
    if (!parsed) { error.value = 'unavailable'; return }
    rows.value = parsed
    loaded.value = true
  } catch {
    if (isCurrent()) error.value = 'unavailable'
  } finally {
    if (timelineController === controller) timelineController = null
    if (isCurrent()) loading.value = false
  }
}
</script>

<style scoped>
.calculation-membership-history { margin-top: 12px; padding: 14px; border: 1px solid #d5dbea; border-radius: 12px; background: #fff; color: #172033; }
.calculation-membership-history h3 { margin: 0 0 8px; font-size: 16px; }
.calculation-membership-history p, .calculation-membership-history caption { font-size: 13px; line-height: 1.5; text-align: left; }
.calculation-membership-history__controls { display: flex; flex-wrap: wrap; align-items: end; gap: 10px; }
.calculation-membership-history label { display: grid; gap: 4px; min-width: 0; }
.calculation-membership-history input, .calculation-membership-history select { max-width: 100%; box-sizing: border-box; padding: 7px; border: 1px solid #cad2e2; border-radius: 6px; }
.calculation-membership-history button { padding: 7px 10px; margin: 6px 0; cursor: pointer; }
.calculation-membership-history table { width: 100%; border-collapse: collapse; font-size: 13px; }
.calculation-membership-history th, .calculation-membership-history td { padding: 8px 4px; border-bottom: 1px solid #e5e9f0; text-align: left; overflow-wrap: anywhere; }
.calculation-membership-history details { font-size: 12px; margin: 6px 0; }
.calculation-membership-history code { overflow-wrap: anywhere; }
</style>
