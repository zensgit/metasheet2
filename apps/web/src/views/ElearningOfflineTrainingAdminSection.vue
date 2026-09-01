<template>
  <section
    class="offline-admin"
    data-testid="elearning-offline-admin-section"
    aria-labelledby="elearning-offline-admin-title"
  >
    <header>
      <h2 id="elearning-offline-admin-title">{{ elearningLabel('offlineAdmin.title', isZh) }}</h2>
      <p>{{ elearningLabel('offlineAdmin.subtitle', isZh) }}</p>
    </header>

    <form class="offline-admin__form" @submit.prevent="void publish()">
      <label>
        <span>{{ elearningLabel('offlineAdmin.trainingTitle', isZh) }}</span>
        <input v-model="title" data-testid="elearning-offline-title" maxlength="200" :disabled="busy">
      </label>
      <label>
        <span>{{ elearningLabel('offlineAdmin.location', isZh) }}</span>
        <input v-model="location" data-testid="elearning-offline-location" maxlength="500" :disabled="busy">
      </label>
      <label>
        <span>{{ elearningLabel('offlineAdmin.members', isZh) }}</span>
        <textarea
          v-model="memberUserIds"
          data-testid="elearning-offline-members"
          rows="3"
          :disabled="busy"
        />
      </label>

      <fieldset>
        <legend>{{ elearningLabel('offlineAdmin.target', isZh) }}</legend>
        <label>
          <span>{{ elearningLabel('offlineAdmin.targetTitle', isZh) }}</span>
          <input v-model="targetTitle" data-testid="elearning-offline-target-title" maxlength="200" :disabled="busy">
        </label>
        <label v-for="field in timeFields" :key="field.key">
          <span>{{ elearningLabel(field.label, isZh) }}</span>
          <input
            v-model="times[field.key]"
            :data-testid="`elearning-offline-${field.key}`"
            type="datetime-local"
            step="1"
            :disabled="busy"
          >
        </label>
      </fieldset>

      <button type="submit" data-testid="elearning-offline-publish" :disabled="busy">
        {{ busy
          ? elearningLabel('offlineAdmin.publishing', isZh)
          : elearningLabel('offlineAdmin.publish', isZh) }}
      </button>
    </form>

    <section v-if="published" class="offline-admin__qr" data-testid="elearning-offline-published">
      <h3>{{ elearningLabel('offlineAdmin.qrTitle', isZh) }}</h3>
      <p>{{ published.title }} · {{ published.location }}</p>
      <div class="offline-admin__qr-actions">
        <button
          type="button"
          data-testid="elearning-offline-issue-check-in"
          :disabled="busy"
          @click="void issue('check_in')"
        >
          {{ elearningLabel('offlineAdmin.issueCheckIn', isZh) }}
        </button>
        <button
          type="button"
          data-testid="elearning-offline-issue-check-out"
          :disabled="busy"
          @click="void issue('check_out')"
        >
          {{ elearningLabel('offlineAdmin.issueCheckOut', isZh) }}
        </button>
      </div>
      <label v-if="qr">
        <span>{{ elearningLabel('offlineAdmin.qrToken', isZh) }}</span>
        <textarea
          data-testid="elearning-offline-qr-token"
          rows="4"
          readonly
          :value="qr.token"
        />
      </label>
      <p v-if="qr" data-testid="elearning-offline-qr-expiry">
        {{ elearningLabel('offlineAdmin.qrExpires', isZh) }}: {{ qr.expiresAt }}
      </p>
    </section>

    <p
      v-if="status"
      data-testid="elearning-offline-admin-status"
      :class="{ 'offline-admin__error': statusTone === 'error' }"
      role="status"
    >
      {{ status }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useLocale } from '../composables/useLocale'
import { ElearningApiError } from '../services/elearning'
import {
  createElearningOfflineRequestIds,
  issueElearningOfflineQr,
  publishElearningOfflineTraining,
  type ElearningOfflineAttendanceAction,
  type ElearningOfflinePublishResult,
  type ElearningOfflineQrResult,
  type PublishElearningOfflineInput,
} from '../services/elearningOfflineTraining'
import { elearningFailure, elearningLabel, type ElearningLabelKey } from './elearningLabels'

type TimeKey = 'startsAt' | 'endsAt' | 'checkInOpensAt' | 'checkInClosesAt'
  | 'checkOutOpensAt' | 'checkOutClosesAt'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const { isZh } = useLocale()
const requestIds = createElearningOfflineRequestIds()
const title = ref('')
const location = ref('')
const memberUserIds = ref('')
const targetTitle = ref('')
const times = reactive<Record<TimeKey, string>>({
  startsAt: '',
  endsAt: '',
  checkInOpensAt: '',
  checkInClosesAt: '',
  checkOutOpensAt: '',
  checkOutClosesAt: '',
})
const timeFields: Array<{ key: TimeKey; label: ElearningLabelKey }> = [
  { key: 'startsAt', label: 'offlineAdmin.startsAt' },
  { key: 'endsAt', label: 'offlineAdmin.endsAt' },
  { key: 'checkInOpensAt', label: 'offlineAdmin.checkInOpensAt' },
  { key: 'checkInClosesAt', label: 'offlineAdmin.checkInClosesAt' },
  { key: 'checkOutOpensAt', label: 'offlineAdmin.checkOutOpensAt' },
  { key: 'checkOutClosesAt', label: 'offlineAdmin.checkOutClosesAt' },
]
const published = ref<ElearningOfflinePublishResult | null>(null)
const qr = ref<ElearningOfflineQrResult | null>(null)
const busy = ref(false)
const status = ref('')
const statusTone = ref<'info' | 'error'>('info')

function errorText(error: unknown): string {
  if (error instanceof ElearningApiError) {
    return elearningFailure(error.code, error.status, isZh.value)
  }
  return elearningFailure('request_failed', 0, isZh.value)
}

function instant(value: string): string | null {
  if (value === '') return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
}

function payload(): Omit<PublishElearningOfflineInput, 'requestId'> | null {
  const members = memberUserIds.value
    .split(/[\s,]+/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  const parsedTimes = Object.fromEntries(
    timeFields.map(({ key }) => [key, instant(times[key])]),
  ) as Record<TimeKey, string | null>
  if (
    title.value.trim() === ''
    || location.value.trim() === ''
    || targetTitle.value.trim() === ''
    || members.length === 0
    || members.some((id) => !UUID_RE.test(id))
    || new Set(members).size !== members.length
    || Object.values(parsedTimes).some((value) => value === null)
  ) return null
  return {
    title: title.value.trim(),
    location: location.value.trim(),
    attendanceMode: 'training',
    targets: [{
      title: targetTitle.value.trim(),
      startsAt: parsedTimes.startsAt!,
      endsAt: parsedTimes.endsAt!,
      checkInOpensAt: parsedTimes.checkInOpensAt!,
      checkInClosesAt: parsedTimes.checkInClosesAt!,
      checkOutOpensAt: parsedTimes.checkOutOpensAt!,
      checkOutClosesAt: parsedTimes.checkOutClosesAt!,
    }],
    memberUserIds: members,
  }
}

async function publish(): Promise<void> {
  if (busy.value) return
  const command = payload()
  if (!command) {
    statusTone.value = 'error'
    status.value = elearningLabel('offlineAdmin.validation', isZh.value)
    return
  }
  busy.value = true
  status.value = ''
  try {
    published.value = await publishElearningOfflineTraining({
      ...command,
      requestId: requestIds.forPublish(command),
    })
    requestIds.settlePublish(command)
    qr.value = null
    statusTone.value = 'info'
    status.value = elearningLabel('offlineAdmin.published', isZh.value)
  } catch (error) {
    statusTone.value = 'error'
    status.value = errorText(error)
  } finally {
    busy.value = false
  }
}

async function issue(action: ElearningOfflineAttendanceAction): Promise<void> {
  const current = published.value
  const target = current?.targets[0]
  if (!current || !target || busy.value) return
  busy.value = true
  status.value = ''
  try {
    qr.value = await issueElearningOfflineQr({
      requestId: requestIds.forQr(current.trainingId, target.targetId, action),
      trainingId: current.trainingId,
      targetId: target.targetId,
      action,
    })
    requestIds.settleQr(current.trainingId, target.targetId, action)
    statusTone.value = 'info'
    status.value = elearningLabel('offlineAdmin.qrIssued', isZh.value)
  } catch (error) {
    statusTone.value = 'error'
    status.value = errorText(error)
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.offline-admin {
  display: grid;
  gap: 12px;
  padding: 16px;
  border: 1px solid #cbd9e8;
  border-radius: 10px;
  background: #f8fbff;
}
.offline-admin h2,
.offline-admin h3,
.offline-admin p { margin: 0; }
.offline-admin__form,
.offline-admin__form label,
.offline-admin__qr,
.offline-admin__qr label { display: grid; gap: 8px; }
.offline-admin__form fieldset { display: grid; gap: 8px; border: 1px solid #d6e2ef; }
.offline-admin__form input,
.offline-admin__form textarea,
.offline-admin__form button,
.offline-admin__qr button,
.offline-admin__qr textarea { min-height: 36px; }
.offline-admin__qr-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.offline-admin__error { color: #b42318; }
</style>
