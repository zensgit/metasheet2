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

    <div class="attendance__admin-grid">
      <label class="attendance__field" for="attendance-ta-group">
        <span>{{ tr('Group ID', '考勤组 ID') }}</span>
        <input id="attendance-ta-group" v-model.trim="groupId" type="text" :placeholder="tr('attendance group UUID', '考勤组 UUID')" @keydown.enter.prevent="reload" />
      </label>
      <label class="attendance__field" for="attendance-ta-from">
        <span>{{ tr('From', '起') }}</span>
        <input id="attendance-ta-from" v-model="from" type="date" />
      </label>
      <label class="attendance__field" for="attendance-ta-to">
        <span>{{ tr('To', '止') }}</span>
        <input id="attendance-ta-to" v-model="to" type="date" />
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
              <th>{{ tr('Member', '成员') }}</th>
              <th v-for="d in dates" :key="d">{{ d }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="member in memberIds" :key="member">
              <td class="attendance-ta__member">{{ member }}</td>
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
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { TranslateFn } from './useAttendanceAdminRail'
import { useTeamAvailability } from './useTeamAvailability'
import { teamAvailabilityStateMeta, type TeamAvailabilityStateMeta } from '../../services/attendance/teamAvailability'

const props = defineProps<{ tr: TranslateFn }>()
const tr = props.tr

const groupId = ref('')
const from = ref('')
const to = ref('')

const { data, loading, errorStatus, errorMessage, load } = useTeamAvailability()

const canLoad = computed(() => Boolean(groupId.value && from.value && to.value))
const pendingTooltip = computed(() => tr('Pending approval, not yet effective', '待审批，未生效'))

const errorText = computed(() => {
  if (errorStatus.value === null && !errorMessage.value) return ''
  if (errorStatus.value === 403) return tr('You do not have permission to view this group.', '你没有查看该考勤组的权限。')
  if (errorStatus.value === 404) return tr('Attendance group not found.', '考勤组不存在。')
  return errorMessage.value ?? tr('Failed to load team availability.', '加载团队可用性失败。')
})

// unique sorted dates (from the summary) + unique members (from items).
const dates = computed(() => (data.value?.summary ?? []).map((s) => s.date))
const memberIds = computed(() => {
  const seen = new Set<string>()
  for (const it of data.value?.items ?? []) seen.add(it.userId)
  return Array.from(seen).sort()
})

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
  await load(groupId.value, from.value, to.value)
}
</script>

<style scoped>
.attendance-ta__matrix-wrap { overflow-x: auto; }
.attendance-ta__member { font-family: var(--font-mono, monospace); font-size: 0.85em; white-space: nowrap; }
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
