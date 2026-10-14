<template>
  <div class="attendance__admin-section" data-attendance-team-availability>
    <div class="attendance__admin-section-header">
      <h4>{{ tr('Team availability', '团队可用性') }}</h4>
      <div class="attendance__admin-actions">
        <button class="attendance__btn attendance__btn--primary" :disabled="loading || !canLoad" @click="reload">
          {{ loading ? tr('Loading...', '加载中...') : tr('Load', '加载') }}
        </button>
      </div>
    </div>

    <p class="attendance__hint">
      {{ tr(
        'Read-only view of a group’s availability (scheduled / rest / approved-leave / pending-leave / unscheduled). Pending leave is shown as tentative — it is NOT subtracted from the available headcount.',
        '某考勤组可用性的只读视图（排班 / 休息 / 已批请假 / 待审批请假 / 未排班）。待审批请假以“暂定”呈现 — 不从可用人数中扣减。',
      ) }}
    </p>

    <div class="attendance-ta__filters" data-attendance-team-availability-filters>
      <label class="attendance-ta__field attendance-ta__group" for="attendance-ta-group">
        <span>{{ tr('Attendance group', '考勤组') }}</span>
        <input
          id="attendance-ta-group"
          :value="groupDraft"
          type="search"
          autocomplete="off"
          :placeholder="tr('Search by group name', '按考勤组名称搜索')"
          data-attendance-team-availability-group
          @input="onGroupInput"
          @focus="menuOpen = true"
          @keydown.enter.prevent="reload"
        />
        <ul v-if="menuOpen && groupMatches.length > 0" class="attendance-ta__group-menu" data-attendance-team-availability-group-menu>
          <li v-for="group in groupMatches" :key="group.id">
            <button type="button" @click="chooseGroup(group)">{{ group.name }}</button>
          </li>
        </ul>
      </label>
      <label class="attendance-ta__field" for="attendance-ta-from">
        <span>{{ tr('From', '起') }}</span>
        <AttendanceLocaleDateInput id="attendance-ta-from" v-model="from" />
      </label>
      <label class="attendance-ta__field" for="attendance-ta-to">
        <span>{{ tr('To', '止') }}</span>
        <AttendanceLocaleDateInput id="attendance-ta-to" v-model="to" />
      </label>
    </div>

    <p v-if="errorText" class="attendance__error" data-attendance-team-availability-error>{{ errorText }}</p>

    <template v-if="data">
      <!-- §3a summary: availableFormal counts scheduled + pending; pending is tentative, never a deduction. -->
      <table class="attendance__table" data-attendance-team-availability-summary>
        <thead>
          <tr>
            <th>{{ tr('Date', '日期') }}</th>
            <th>{{ tr('Available (formal)', '可用（正式）') }}</th>
            <th>{{ tr('Scheduled', '排班') }}</th>
            <th class="attendance-ta__col--provisional">{{ tr('Pending (tentative)', '待审批（暂定）') }}</th>
            <th>{{ tr('Approved leave', '已批请假') }}</th>
            <th>{{ tr('Rest', '休息') }}</th>
            <th>{{ tr('Unscheduled', '未排班') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in data.summary" :key="row.date">
            <td>{{ row.date }}</td>
            <td><strong>{{ row.availableFormal }}</strong></td>
            <td>{{ row.scheduled }}</td>
            <td class="attendance-ta__col--provisional" :title="pendingTooltip">{{ row.pendingLeaveTentative }}</td>
            <td>{{ row.approvedLeave }}</td>
            <td>{{ row.rest }}</td>
            <td>{{ row.unscheduled }}</td>
          </tr>
        </tbody>
      </table>

      <!-- member × date matrix; each cell is a state chip (pending = provisional style + tooltip). -->
      <div class="attendance-ta__matrix-wrap">
        <table class="attendance__table attendance-ta__matrix" data-attendance-team-availability-matrix>
          <thead>
            <tr>
              <th>{{ tr('Name', '姓名') }}</th>
              <th v-for="d in dates" :key="d">{{ d }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="member in members" :key="member">
              <td class="attendance-ta__member">
                <span class="attendance-ta__member-identity">
                  <strong
                    v-if="memberPrimaryLabel(member)"
                    data-attendance-team-availability-member-label
                  >{{ memberPrimaryLabel(member) }}</strong>
                  <span
                    data-attendance-team-availability-member-id
                    :class="{ 'attendance-ta__id-clip': Boolean(memberPrimaryLabel(member)) }"
                  >{{ member }}</span>
                </span>
              </td>
              <td v-for="d in dates" :key="d">
                <span
                  v-if="metaAt(member, d)"
                  class="attendance-ta__chip"
                  :class="[metaAt(member, d)!.className, { 'attendance-ta__chip--provisional': metaAt(member, d)!.provisional }]"
                  :title="chipTitle(metaAt(member, d)!)"
                >{{ tr(metaAt(member, d)!.enLabel, metaAt(member, d)!.zhLabel) }}</span>
                <span v-else class="attendance-ta__chip attendance-ta__chip--none">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- legend -->
      <p class="attendance__hint attendance-ta__legend">
        <span class="attendance-ta__chip attendance-ta__chip--provisional ta-state--pending-leave" :title="pendingTooltip">{{ tr('Pending leave', '待审批请假') }}</span>
        {{ tr('= pending approval, not yet effective (shown distinct from approved leave).', '= 待审批，未生效（与已批请假明确区分）。') }}
      </p>
      <!-- #3575 caliber-transparency lock (G2): spells out the availableFormal equation so the
           summary table's headline number is never a bare, unexplained figure. -->
      <p class="attendance__hint attendance-ta__legend" data-attendance-team-availability-caliber-equation>
        {{
          tr(
            'Available (formal) = Scheduled + Pending (tentative, not deducted). Excluded = Approved leave / Rest / Unscheduled.',
            '可用(正式) = 已排班 + 待审批（暂定，不扣减）；排除项 = 已批请假/休息/未排班。',
          )
        }}
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
import AttendanceLocaleDateInput from './AttendanceLocaleDateInput.vue'
import { computed, onMounted, ref, watch } from 'vue'
import type { TranslateFn } from './useAttendanceAdminRail'
import { useTeamAvailability } from './useTeamAvailability'
import { fetchTeamAvailability, teamAvailabilityStateMeta, type TeamAvailabilityStateMeta } from '../../services/attendance/teamAvailability'
import { useAttendanceSessionGuard } from '../../composables/useAttendanceSessionGuard'
import { apiFetch } from '../../utils/api'

const props = defineProps<{
  tr: TranslateFn
  /** Same directory scope the group-member name resolver sends. Null skips the lookup. */
  userScope?: { scope: 'global' } | { orgId: string } | null
}>()
const tr = props.tr

interface AttendanceGroupChoice { id: string; name: string }
interface ResolvedMemberLabel { name: string | null; email: string }

const groupId = ref('')
const groupDraft = ref('')
const menuOpen = ref(false)
const groups = ref<AttendanceGroupChoice[]>([])
const from = ref('')
const to = ref('')

const sessionGuard = useAttendanceSessionGuard()
const guardedFetch = sessionGuard.wrapFetch(apiFetch)
const { data, loading, errorStatus, errorMessage, load } = useTeamAvailability({
  fetchAvailability: options => fetchTeamAvailability(options, guardedFetch),
  isSessionCurrent: sessionGuard.isCurrent,
})

const canLoad = computed(() => Boolean(groupId.value && from.value && to.value))
const groupMatches = computed(() => {
  const query = groupDraft.value.trim().toLowerCase()
  const source = groups.value.filter(group => group.name.trim())
  if (!query) return source.slice(0, 8)
  return source.filter(group => group.name.toLowerCase().includes(query)).slice(0, 8)
})

async function loadGroupChoices(): Promise<void> {
  if (groups.value.length > 0) return
  try {
    const response = await guardedFetch('/api/attendance/groups?pageSize=200')
    const payload = await response.json()
    const items = Array.isArray(payload?.data?.items) ? payload.data.items : []
    groups.value = items
      .map((item: { id?: string; name?: string }) => ({
        id: String(item?.id || '').trim(),
        name: String(item?.name || '').trim(),
      }))
      .filter((item: AttendanceGroupChoice) => item.id && item.name)
  } catch {
    groups.value = []
  }
}

function applyKnownGroup(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  const byName = groups.value.find(group => group.name === trimmed)
  if (byName) {
    groupDraft.value = byName.name
    groupId.value = byName.id
    return true
  }
  const byId = groups.value.find(group => group.id === trimmed)
  if (byId) {
    groupDraft.value = byId.name
    groupId.value = byId.id
    return true
  }
  return false
}

function onGroupInput(event: Event): void {
  const text = (event.target as HTMLInputElement).value
  groupDraft.value = text
  if (!applyKnownGroup(text)) groupId.value = text.trim()
  menuOpen.value = true
  void loadGroupChoices()
}

function chooseGroup(group: AttendanceGroupChoice): void {
  groupDraft.value = group.name
  groupId.value = group.id
  menuOpen.value = false
}

watch(groups, () => {
  if (groupDraft.value.trim()) applyKnownGroup(groupDraft.value)
})

onMounted(() => { void loadGroupChoices() })
const pendingTooltip = computed(() => tr('Pending approval, not yet effective', '待审批，未生效'))

const errorText = computed(() => {
  if (errorStatus.value === null && !errorMessage.value) return ''
  if (errorStatus.value === 403) return tr('You do not have permission to view this group.', '你没有查看该考勤组的权限。')
  if (errorStatus.value === 404) return tr('Attendance group not found.', '考勤组不存在。')
  return errorMessage.value ?? tr('Failed to load team availability.', '加载团队可用性失败。')
})

// unique sorted dates (from the summary) + unique members (from items).
const dates = computed(() => (data.value?.summary ?? []).map((s) => s.date))
const memberLabels = ref<Record<string, ResolvedMemberLabel>>({})
let resolveSeq = 0

function memberPrimaryLabel(userId: string): string {
  const item = memberLabels.value[userId]
  if (!item) return ''
  const name = item.name?.trim() || ''
  if (name) return name
  return item.email.trim()
}

const members = computed(() => {
  const seen = new Set<string>()
  for (const it of data.value?.items ?? []) {
    if (it.userId) seen.add(it.userId)
  }
  return Array.from(seen).sort((a, b) => {
    const left = memberPrimaryLabel(a) || a
    const right = memberPrimaryLabel(b) || b
    const byLabel = left.localeCompare(right, 'zh')
    return byLabel || a.localeCompare(b)
  })
})

async function resolveMemberLabels(userIds: string[], seq: number): Promise<void> {
  const scope = props.userScope
  if (!scope || userIds.length === 0) {
    if (seq === resolveSeq) memberLabels.value = {}
    return
  }
  try {
    const response = await guardedFetch('/api/attendance-admin/users/batch/resolve', {
      method: 'POST',
      body: JSON.stringify({ userIds, ...scope }),
    })
    if (seq !== resolveSeq) return
    if (!response || response.status === 403 || response.status === 404) {
      memberLabels.value = {}
      return
    }
    const payload = await response.json().catch(() => null)
    if (seq !== resolveSeq) return
    if (!response.ok || !payload?.ok) {
      memberLabels.value = {}
      return
    }
    const items = Array.isArray(payload?.data?.items) ? payload.data.items : []
    const requested = new Set(userIds)
    const next: Record<string, ResolvedMemberLabel> = {}
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue
      const id = String((raw as { id?: string }).id || '').trim()
      if (!id || !requested.has(id) || next[id]) continue
      const record = raw as { name?: unknown; email?: unknown }
      next[id] = {
        name: record.name == null ? null : String(record.name),
        email: String(record.email || ''),
      }
    }
    memberLabels.value = next
  } catch {
    if (seq === resolveSeq) memberLabels.value = {}
  }
}

const metaIndex = computed(() => {
  const map = new Map<string, TeamAvailabilityStateMeta>()
  for (const it of data.value?.items ?? []) map.set(`${it.userId}|${it.date}`, teamAvailabilityStateMeta(it.state))
  return map
})
function metaAt(member: string, date: string): TeamAvailabilityStateMeta | undefined {
  return metaIndex.value.get(`${member}|${date}`)
}
function chipTitle(meta: TeamAvailabilityStateMeta): string {
  const note = tr(meta.enTooltip ?? '', meta.zhTooltip ?? '')
  const label = tr(meta.enLabel, meta.zhLabel)
  return note ? `${label} — ${note}` : label
}

async function reload(): Promise<void> {
  if (!canLoad.value) return
  const seq = ++resolveSeq
  memberLabels.value = {}
  await load(groupId.value, from.value, to.value)
  if (seq !== resolveSeq) return
  const userIds = Array.from(new Set((data.value?.items ?? []).map(item => item.userId).filter(Boolean)))
  await resolveMemberLabels(userIds, seq)
}
</script>

<style scoped>
.attendance-ta__filters {
  display: flex;
  flex-flow: row nowrap;
  align-items: center;
  gap: 12px;
}
.attendance-ta__field {
  display: flex;
  flex-flow: row nowrap;
  align-items: center;
  gap: 8px;
  flex: 1 1 0;
  min-width: 0;
  font-size: 12px;
  color: #555;
}
.attendance-ta__field > span {
  flex: 0 0 auto;
  white-space: nowrap;
}
.attendance-ta__field > input {
  flex: 1 1 auto;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  padding: 6px 10px;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
}
.attendance-ta__filters :deep(.attendance-locale-date) {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
}
.attendance-ta__group { position: relative; }
.attendance-ta__group-menu {
  position: absolute;
  z-index: 5;
  top: calc(100% - 4px);
  left: 0;
  right: 0;
  margin: 0;
  padding: 4px;
  list-style: none;
  border: 1px solid var(--ms-border, #d0d5dd);
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 8px 24px rgba(16, 24, 40, 0.12);
}
.attendance-ta__group-menu button {
  width: 100%;
  padding: 6px 8px;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.attendance-ta__matrix-wrap { overflow-x: auto; }
.attendance-ta__member { font-size: 13px; white-space: nowrap; }
.attendance-ta__member-identity {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.attendance-ta__member-identity strong {
  font-weight: 600;
}
.attendance-ta__id-clip {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.attendance-ta__col--provisional { color: #b45309; }
.attendance-ta__chip {
  display: inline-block;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  font-size: 0.8em;
  line-height: 1.4;
  border-left: 3px solid transparent;
}
.attendance-ta__chip--none { color: var(--text-muted, #6e7681); }
.ta-state--scheduled { background: #e6f4ea; border-left-color: #2e7d32; }
.ta-state--rest { background: #f1f3f5; border-left-color: #6e7681; }
.ta-state--approved-leave { background: #fdecea; border-left-color: #d73a4a; }
.ta-state--unscheduled { background: #f8f9fa; border-left-color: #ced4da; color: #6e7681; }
/* §3c: pending is PROVISIONAL — a distinct dashed, amber, lower-emphasis style, never the approved red. */
.ta-state--pending-leave,
.attendance-ta__chip--provisional {
  background: #fff8e1;
  border-left-color: #f59e0b;
  border-left-style: dashed;
  color: #92400e;
  font-style: italic;
}
</style>
