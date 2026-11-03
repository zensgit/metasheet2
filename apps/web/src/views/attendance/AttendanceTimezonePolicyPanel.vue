<template>
  <section class="attendance-timezone-policy" data-attendance-timezone-policy>
    <h5>{{ tr('Attendance timezone', '考勤时区') }}</h5>
    <button type="button" :disabled="status === 'loading' || busy" @click="load">
      {{ status === 'loading' ? tr('Loading...', '加载中...') : tr('View / refresh', '查看／刷新') }}
    </button>
    <p v-if="status === 'idle'">{{ tr('View the organization attendance timezone configuration.', '查看组织考勤时区配置。') }}</p>
    <p v-else-if="status === 'unavailable'" role="status">{{ tr('Configuration unavailable. Check your session and attendance administrator permission.', '配置不可用，请确认登录会话和考勤管理权限。') }}</p>
    <p v-else-if="status === 'error'" role="alert">{{ tr('Unable to read timezone configuration.', '无法读取考勤时区配置。') }}</p>
    <dl v-else-if="status === 'ready' && policy">
      <dt>{{ tr('Multiple timezones', '多时区') }}</dt>
      <dd data-timezone-enabled>{{ policy.enabled ? tr('Enabled', '已启用') : tr('Disabled', '未启用') }}</dd>
      <dt>{{ tr('System default timezone', '系统默认时区') }}</dt>
      <dd data-timezone-default>{{ policy.systemDefault.timezone }}</dd>
    </dl>
    <p v-if="status === 'ready' && policy && !policy.enabled">
      {{ tr('When disabled, attendance uses the system default timezone.', '未启用多时区时，考勤使用系统默认时区。') }}
    </p>
    <fieldset v-if="status === 'ready' && policy" class="attendance-timezone-policy__change">
      <label>
        <input v-model="proposedEnabled" type="checkbox" :disabled="busy" data-timezone-proposed />
        {{ tr('Enable multiple attendance timezones', '启用多时区考勤') }}
      </label>
      <p>{{ tr('Preview the impact before saving. Changes must respect complete shift boundaries.', '保存前先预览影响；变更必须满足完整班次边界。') }}</p>
      <button type="button" data-timezone-preview :disabled="busy || proposedEnabled === policy.enabled" @click="preview">
        {{ tr('Preview impact', '预览影响') }}
      </button>
      <dl v-if="impact" data-timezone-impact>
        <dt>{{ tr('Evaluated employees', '已检查员工') }}</dt><dd data-timezone-evaluated>{{ impact.evaluatedUsers }}</dd>
        <dt>{{ tr('Affected employees', '受影响员工') }}</dt><dd data-timezone-affected>{{ impact.affectedUsers }}</dd>
        <dt>{{ tr('Employees with conflicts', '存在冲突的员工') }}</dt><dd data-timezone-conflicting>{{ impact.conflictingUsers }}</dd>
        <dt>{{ tr('Started shifts', '已开始班次冲突') }}</dt><dd>{{ impact.conflictCounts.startedContext }}</dd>
        <dt>{{ tr('Approved trip context', '已批准出差冲突') }}</dt><dd>{{ impact.conflictCounts.tripContext }}</dd>
        <dt>{{ tr('Invalid target context', '无效目标上下文') }}</dt><dd>{{ impact.conflictCounts.invalidTargetContext }}</dd>
      </dl>
      <p v-if="impact && impact.conflictingUsers > 0">{{ tr('Resolve conflicts and preview again before saving.', '请处理冲突后重新预览，再保存。') }}</p>
      <button type="button" data-timezone-save :disabled="busy || !canSave" @click="save">
        {{ tr('Save timezone policy', '保存时区设置') }}
      </button>
    </fieldset>
    <p v-if="changeMessage" role="status" data-timezone-change-message>{{ changeMessage }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import { apiFetch } from '../../utils/api'
import { useAttendanceSessionGuard } from '../../composables/useAttendanceSessionGuard'

const props = defineProps<{ tr: (en: string, zh: string) => string }>()

interface TimezonePolicy {
  enabled: boolean
  version: number
  systemDefault: { orgId: string; referenceId: string; timezone: string; version: number }
}

const guard = useAttendanceSessionGuard()
const fetch = guard.wrapFetch(apiFetch)
const status = ref<'idle' | 'loading' | 'ready' | 'error' | 'unavailable'>('idle')
const policy = ref<TimezonePolicy | null>(null)
interface TimezoneImpact {
  currentVersion: number
  proposedEnabled: boolean
  evaluatedUsers: number
  affectedUsers: number
  conflictingUsers: number
  conflictCounts: { startedContext: number; tripContext: number; invalidTargetContext: number }
}
const proposedEnabled = ref(false)
const impact = ref<TimezoneImpact | null>(null)
const busy = ref(false)
const changeMessage = ref('')
const canSave = computed(() => Boolean(policy.value && impact.value && guard.isCurrent()
  && proposedEnabled.value !== policy.value.enabled
  && impact.value.currentVersion === policy.value.version
  && impact.value.proposedEnabled === proposedEnabled.value && impact.value.conflictingUsers === 0))
let generation = 0

function readPolicy(value: unknown): TimezonePolicy | null {
  if (!value || typeof value !== 'object') return null
  const body = value as { ok?: unknown; data?: unknown }
  if (body.ok !== true || !body.data || typeof body.data !== 'object') return null
  const data = body.data as Partial<TimezonePolicy>
  const system = data.systemDefault
  if (typeof data.enabled !== 'boolean' || !Number.isSafeInteger(data.version) || Number(data.version) < 0
    || !system || system.orgId !== guard.orgId || typeof system.referenceId !== 'string' || !system.referenceId
    || typeof system.timezone !== 'string' || !system.timezone
    || !Number.isSafeInteger(system.version) || system.version < 1) return null
  try { new Intl.DateTimeFormat('en', { timeZone: system.timezone }) } catch { return null }
  return data as TimezonePolicy
}

async function load(): Promise<void> {
  if (!guard.isCurrent() || busy.value) return
  const current = ++generation
  impact.value = null
  policy.value = null
  status.value = 'loading'
  try {
    const response = await fetch('/api/attendance/timezone-policy')
    if (current !== generation || !guard.isCurrent()) return
    if ([401, 403, 404].includes(response.status)) {
      status.value = 'unavailable'
      return
    }
    if (!response.ok) {
      status.value = 'error'
      return
    }
    const next = readPolicy(await response.json())
    if (current !== generation || !guard.isCurrent()) return
    if (!next) {
      status.value = 'error'
      return
    }
    policy.value = next
    proposedEnabled.value = next.enabled
    status.value = 'ready'
  } catch {
    if (current === generation && guard.isCurrent()) status.value = 'error'
  }
}

function readImpact(value: unknown, enabled: boolean, version: number): TimezoneImpact | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as { ok?: unknown; data?: unknown }
  if (body.ok !== true || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) return null
  const data = body.data as Partial<TimezoneImpact>
  const counts = data.conflictCounts
  const fields = ['currentVersion', 'proposedEnabled', 'evaluatedUsers', 'affectedUsers', 'conflictingUsers', 'conflictCounts']
  const categories = ['startedContext', 'tripContext', 'invalidTargetContext']
  if (Object.keys(body.data).length !== fields.length || fields.some(key => !Object.prototype.hasOwnProperty.call(body.data, key))
    || data.currentVersion !== version || data.proposedEnabled !== enabled
    || !counts || Object.keys(counts).length !== categories.length || categories.some(key => !Object.prototype.hasOwnProperty.call(counts, key))
    || [data.evaluatedUsers, data.affectedUsers, data.conflictingUsers,
      counts.startedContext, counts.tripContext, counts.invalidTargetContext].some(value => !Number.isSafeInteger(value) || Number(value) < 0)
    || [data.affectedUsers, data.conflictingUsers, counts.startedContext, counts.tripContext,
      counts.invalidTargetContext].some(value => Number(value) > Number(data.evaluatedUsers))
    || counts.startedContext + counts.tripContext + counts.invalidTargetContext !== data.conflictingUsers) return null
  return data as TimezoneImpact
}

async function preview(): Promise<void> {
  if (busy.value || !policy.value || proposedEnabled.value === policy.value.enabled || !guard.isCurrent()) return
  const enabled = proposedEnabled.value
  const expectedVersion = policy.value.version
  const current = ++generation
  impact.value = null
  changeMessage.value = ''
  busy.value = true
  try {
    const response = await fetch('/api/attendance/timezone-policy/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, expectedVersion }),
    })
    const body = await response.json()
    if (current !== generation || !guard.isCurrent() || !policy.value
      || policy.value.version !== expectedVersion || proposedEnabled.value !== enabled) return
    const parsed = response.ok ? readImpact(body, enabled, expectedVersion) : null
    if (!parsed) {
      changeMessage.value = props.tr('Impact could not be confirmed. Refresh the configuration and try again.', '无法确认影响，请刷新配置后重试。')
      return
    }
    impact.value = parsed
  } catch {
    if (current === generation && guard.isCurrent()) changeMessage.value = props.tr(
      'Impact could not be confirmed. Refresh the configuration and try again.', '无法确认影响，请刷新配置后重试。',
    )
  } finally { if (current === generation) busy.value = false }
}

async function save(): Promise<void> {
  if (busy.value || !canSave.value || !policy.value || !guard.isCurrent()) return
  const enabled = proposedEnabled.value
  const expectedVersion = policy.value.version
  const current = ++generation
  changeMessage.value = ''
  busy.value = true
  try {
    const response = await fetch('/api/attendance/timezone-policy', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, expectedVersion }),
    })
    const body = await response.json()
    if (current !== generation || !guard.isCurrent()) return
    const ack = body?.data
    if (!response.ok || body?.ok !== true || !ack || Object.keys(ack).length !== 2
      || ack.enabled !== enabled || ack.version !== expectedVersion + 1) throw new Error('UNCONFIRMED_POLICY_WRITE')
    impact.value = null
    busy.value = false
    await load()
    if (guard.isCurrent()) changeMessage.value = status.value === 'ready'
      ? props.tr('Timezone policy saved. The displayed configuration was refreshed.', '时区设置已保存，已刷新显示的配置。')
      : props.tr('Timezone policy saved. Refresh to confirm the displayed configuration.', '时区设置已保存，请刷新确认显示的配置。')
  } catch {
    if (current === generation && guard.isCurrent()) {
      impact.value = null
      policy.value = null
      status.value = 'error'
      changeMessage.value = props.tr('Save could not be confirmed. Refresh before making another change.', '无法确认保存结果，请先刷新再修改。')
    }
  } finally { if (current === generation) busy.value = false }
}

watch(proposedEnabled, () => { impact.value = null; changeMessage.value = '' })

watch(guard.stale, () => {
  ++generation
  policy.value = null
  impact.value = null
  proposedEnabled.value = false
  busy.value = false
  changeMessage.value = ''
  status.value = 'unavailable'
})
onScopeDispose(() => { ++generation })
</script>

<style scoped>
.attendance-timezone-policy {
  display: grid;
  gap: 8px;
}
.attendance-timezone-policy dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px 16px;
}
.attendance-timezone-policy__change { display: grid; gap: 8px; min-width: 0; }
.attendance-timezone-policy dd {
  margin: 0;
}
</style>
