<template>
  <section class="trip-card" data-attendance-business-trip-card>
    <h4>{{ tr('Business trip request', '出差申请') }}</h4>
    <button v-if="!open" type="button" :disabled="guard.stale.value" data-trip-open @click="open = true">
      {{ tr('Create request', '填写申请') }}
    </button>
    <form v-else @submit.prevent="submit">
      <fieldset :disabled="submitting || guard.stale.value">
        <label for="attendance-trip-zone">{{ tr('Destination timezone', '目的地时区') }}</label>
        <select id="attendance-trip-zone" v-model="form.destinationTimezone" data-trip-zone>
          <option value="" disabled>{{ tr('Select timezone', '选择时区') }}</option>
          <option v-for="zone in zones" :key="zone" :value="zone">{{ zone }}</option>
        </select>
        <div v-for="field in endpoints" :key="field.key" class="trip-card__endpoint">
          <label :for="'attendance-trip-' + field.key">{{ tr(field.en, field.zh) }}</label>
          <input :id="'attendance-trip-' + field.key" v-model="form[field.key]" type="datetime-local" :data-trip-local="field.key" />
          <small v-if="resolved[field.key].kind === 'unique'" :data-trip-offset="field.key">
            {{ tr('UTC offset', 'UTC 偏移') }}: {{ resolved[field.key].choices[0]?.offsetLabel }}
          </small>
          <p v-if="resolved[field.key].kind === 'gap'" role="alert">
            {{ tr('This local time does not exist. Choose another time.', '该当地时间不存在，请调整时间。') }}
          </p>
          <label v-if="resolved[field.key].kind === 'fold'">
            {{ tr('This time occurs twice. Confirm its UTC offset.', '该时间出现两次，请确认 UTC 偏移。') }}
            <select v-model="selected[field.key]" :data-trip-fold="field.key">
              <option value="" disabled>{{ tr('Confirm offset', '确认偏移') }}</option>
              <option v-for="choice in resolved[field.key].choices" :key="choice.instant" :value="choice.instant">
                {{ choice.offsetLabel }}
              </option>
            </select>
          </label>
        </div>
        <label for="attendance-trip-reason">{{ tr('Reason', '原因') }}</label>
        <textarea id="attendance-trip-reason" v-model="form.reason" maxlength="2000" rows="2" data-trip-reason />
        <p>{{ tr('Times are entered in the destination timezone. Approved trips use it only when multiple timezones are enabled.', '起止时间按目的地当地时间填写；多时区启用后，已批准出差才按目的地时区生效。') }}</p>
        <button type="button" @click="open = false">{{ tr('Cancel', '取消') }}</button>
        <button type="submit" data-trip-submit>{{ submitting ? tr('Submitting...', '提交中...') : tr('Submit request', '提交申请') }}</button>
      </fieldset>
    </form>
    <p v-if="message" :role="failed ? 'alert' : 'status'">{{ message }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, reactive, ref, watch } from 'vue'
import { apiFetch } from '../../utils/api'
import { randomUuid } from '../../utils/uuid'
import { useAttendanceSessionGuard } from '../../composables/useAttendanceSessionGuard'
import { buildTimezoneOptions } from './attendanceTimezones'
import { resolveAttendanceWallTime, type AttendanceWallTimeResult } from './attendanceWallTime'

const props = defineProps<{
  tr: (en: string, zh: string) => string
  refreshRequests: () => Promise<void>
}>()
const guard = useAttendanceSessionGuard()
const fetch = guard.wrapFetch(apiFetch)
const open = ref(false)
const submitting = ref(false)
const message = ref('')
const failed = ref(false)
const zones = buildTimezoneOptions()
const endpoints = [
  { key: 'startAt' as const, en: 'Start (destination local time)', zh: '开始（目的地当地时间）' },
  { key: 'endAt' as const, en: 'End (destination local time)', zh: '结束（目的地当地时间）' },
]
const form = reactive({ destinationTimezone: '', startAt: '', endAt: '', reason: '' })
const selected = reactive({ startAt: '', endAt: '' })
const resolved = computed(() => ({
  startAt: resolveAttendanceWallTime(form.startAt, form.destinationTimezone),
  endAt: resolveAttendanceWallTime(form.endAt, form.destinationTimezone),
}))
let retry: { key: string; operationId: string } | null = null
let generation = 0
function instant(result: AttendanceWallTimeResult, choice: string): string {
  if (result.kind === 'unique') return result.choices[0].instant
  return result.kind === 'fold' && result.choices.some(item => item.instant === choice) ? choice : ''
}
function fail(en: string, zh: string): void { failed.value = true; message.value = props.tr(en, zh) }

async function submit(): Promise<void> {
  if (submitting.value || !guard.isCurrent()) return
  message.value = ''
  failed.value = false
  const startAt = instant(resolved.value.startAt, selected.startAt)
  const endAt = instant(resolved.value.endAt, selected.endAt)
  if (!startAt || !endAt || Date.parse(endAt) <= Date.parse(startAt)) {
    fail('Choose valid destination times and confirm any repeated time.', '请选择有效的目的地起止时间，并确认重复时间的偏移。')
    return
  }
  const body = { destinationTimezone: form.destinationTimezone, startAt, endAt, ...(form.reason.trim() ? { reason: form.reason.trim() } : {}) }
  const key = JSON.stringify(body)
  if (!retry || retry.key !== key) {
    try { retry = { key, operationId: randomUuid() } } catch {
      fail('Request identity is unavailable. Reload in a secure browser.', '无法生成申请标识，请在安全浏览器环境中重新加载。')
      return
    }
  }
  const current = ++generation
  submitting.value = true
  try {
    const response = await fetch('/api/attendance/business-trip-requests', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, operationId: retry.operationId }),
    })
    const payload = await response.json()
    if (current !== generation || !guard.isCurrent()) return
    if (!response.ok || payload?.ok !== true) {
      fail('Request could not be submitted. Check permission, approval configuration, and shift boundaries.', '申请未能提交，请检查权限、审批配置及班次边界。')
      return
    }
    const trip = payload.data?.businessTrip
    if (typeof payload.data?.request?.id !== 'string' || !trip || trip.requestId !== payload.data.request.id
      || trip.orgId !== guard.orgId || trip.destinationTimezone !== body.destinationTimezone
      || Date.parse(trip.startAt) !== Date.parse(startAt) || Date.parse(trip.endAt) !== Date.parse(endAt)) {
      fail('Unable to confirm the submitted request. Retry the same request.', '无法确认提交结果，请重试同一申请。')
      return
    }
    retry = null
    open.value = false
    message.value = props.tr('Request submitted. It takes effect after approval.', '出差申请已提交，审批通过后生效。')
    try { await props.refreshRequests() } catch {
      if (current === generation && guard.isCurrent()) message.value = props.tr(
        'Request submitted. Refresh the request list manually.', '出差申请已提交，请手动刷新申请列表。',
      )
    }
  } catch {
    if (current === generation && guard.isCurrent()) fail(
      'Submission could not be confirmed. Retry the same request.', '提交结果未能确认，请重试同一申请。',
    )
  } finally { if (current === generation) submitting.value = false }
}
watch(guard.stale, () => {
  ++generation
  open.value = false
  submitting.value = false
  Object.assign(form, { destinationTimezone: '', startAt: '', endAt: '', reason: '' })
  Object.assign(selected, { startAt: '', endAt: '' })
  retry = null
  message.value = ''
})
onScopeDispose(() => { ++generation })
</script>

<style scoped>
.trip-card { display: grid; gap: 10px; margin: 12px 0; }
.trip-card fieldset { display: grid; gap: 8px; border: 1px solid var(--ms-border-light); border-radius: var(--ms-radius-md); padding: 12px; }
.trip-card__endpoint { display: grid; gap: 6px; }
.trip-card input, .trip-card select, .trip-card textarea { min-width: 0; max-width: 100%; padding: 6px; }
.trip-card p { margin: 4px 0; }
</style>
