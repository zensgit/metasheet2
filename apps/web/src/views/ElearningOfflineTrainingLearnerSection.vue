<template>
  <section
    class="offline-learner"
    data-testid="elearning-offline-learner-section"
    aria-labelledby="elearning-offline-learner-title"
  >
    <header>
      <h2 id="elearning-offline-learner-title">{{ elearningLabel('offlineLearner.title', isZh) }}</h2>
      <p>{{ elearningLabel('offlineLearner.subtitle', isZh) }}</p>
    </header>

    <p v-if="loading">{{ elearningLabel('offlineLearner.loading', isZh) }}</p>
    <p v-else-if="trainings.length === 0">{{ elearningLabel('offlineLearner.empty', isZh) }}</p>
    <article
      v-for="training in trainings"
      v-else
      :key="training.trainingId"
      class="offline-learner__training"
      :data-testid="`elearning-offline-training-${training.trainingId}`"
    >
      <h3>{{ training.title }}</h3>
      <p>{{ training.location }}</p>
      <p>
        {{ elearningLabel('offlineLearner.completion', isZh) }}:
        {{ elearningLabel(
          training.completionStatus === 'completed' ? 'status.completed' : 'status.incomplete',
          isZh,
        ) }}
      </p>
      <p v-if="training.registrationEnabled">
        {{ elearningLabel('offlineLearner.registration', isZh) }}:
        {{ elearningLabel(
          training.registrationStatus === 'registered'
            ? 'offlineLearner.registered'
            : 'offlineLearner.notRegistered',
          isZh,
        ) }}
      </p>
      <button
        v-if="training.status === 'active' && training.registrationEnabled"
        type="button"
        :data-testid="`elearning-offline-registration-${training.trainingId}`"
        :disabled="busy"
        @click="void changeRegistration(training)"
      >
        {{ elearningLabel(
          training.registrationStatus === 'registered'
            ? 'offlineLearner.cancelRegistration'
            : 'offlineLearner.register',
          isZh,
        ) }}
      </button>
      <ol>
        <li v-for="target in training.targets" :key="target.targetId">
          <strong>{{ target.title }}</strong>
          <span>{{ target.startsAt }} — {{ target.endsAt }}</span>
          <span>{{ attendanceText(target.attendanceStatus) }}</span>
        </li>
      </ol>
    </article>

    <form class="offline-learner__attendance" @submit.prevent="void attend()">
      <label>
        <span>{{ elearningLabel('offlineLearner.token', isZh) }}</span>
        <textarea
          v-model="token"
          data-testid="elearning-offline-attendance-token"
          rows="4"
          :disabled="busy"
        />
      </label>
      <button type="submit" data-testid="elearning-offline-attend" :disabled="busy">
        {{ busy
          ? elearningLabel('offlineLearner.recording', isZh)
          : elearningLabel('offlineLearner.record', isZh) }}
      </button>
    </form>

    <p
      v-if="status"
      data-testid="elearning-offline-learner-status"
      :class="{ 'offline-learner__error': statusTone === 'error' }"
      role="status"
    >
      {{ status }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useLocale } from '../composables/useLocale'
import { ElearningApiError } from '../services/elearning'
import {
  changeElearningOfflineRegistration,
  createElearningOfflineRequestIds,
  listMyElearningOfflineTrainings,
  readElearningOfflineAttendanceToken,
  recordElearningOfflineAttendance,
  type ElearningOfflineLearnerTraining,
  type ElearningOfflineLearnerTarget,
} from '../services/elearningOfflineTraining'
import { elearningFailure, elearningLabel } from './elearningLabels'

const { isZh } = useLocale()
const requestIds = createElearningOfflineRequestIds()
const trainings = ref<ElearningOfflineLearnerTraining[]>([])
const token = ref('')
const loading = ref(true)
const busy = ref(false)
const status = ref('')
const statusTone = ref<'info' | 'error'>('info')

function errorText(error: unknown): string {
  if (error instanceof ElearningApiError) {
    return elearningFailure(error.code, error.status, isZh.value)
  }
  return elearningFailure('request_failed', 0, isZh.value)
}

function attendanceText(value: ElearningOfflineLearnerTarget['attendanceStatus']): string {
  if (value === 'checked_out') return elearningLabel('offlineLearner.checkedOut', isZh.value)
  if (value === 'checked_in') return elearningLabel('offlineLearner.checkedIn', isZh.value)
  return elearningLabel('offlineLearner.notCheckedIn', isZh.value)
}

async function refresh(): Promise<void> {
  const result = await listMyElearningOfflineTrainings()
  trainings.value = result.trainings
}

async function attend(): Promise<void> {
  if (busy.value) return
  const normalizedToken = token.value.trim()
  if (normalizedToken === '') {
    statusTone.value = 'error'
    status.value = elearningLabel('offlineLearner.tokenRequired', isZh.value)
    return
  }
  busy.value = true
  status.value = ''
  try {
    const result = await recordElearningOfflineAttendance({
      requestId: requestIds.forAttendance(normalizedToken),
      token: normalizedToken,
    })
    requestIds.settleAttendance(normalizedToken)
    await refresh()
    token.value = ''
    statusTone.value = 'info'
    status.value = elearningLabel(
      result.action === 'check_in' ? 'offlineLearner.checkedIn' : 'offlineLearner.checkedOut',
      isZh.value,
    )
  } catch (error) {
    statusTone.value = 'error'
    status.value = errorText(error)
  } finally {
    busy.value = false
  }
}

async function changeRegistration(training: ElearningOfflineLearnerTraining): Promise<void> {
  if (busy.value || training.status !== 'active' || !training.registrationEnabled) return
  const action = training.registrationStatus === 'registered' ? 'cancel' : 'register'
  busy.value = true
  status.value = ''
  try {
    await changeElearningOfflineRegistration({
      requestId: requestIds.forRegistration(training.trainingId, action),
      trainingId: training.trainingId,
      action,
    })
    await refresh()
    requestIds.settleRegistration(training.trainingId, action)
    statusTone.value = 'info'
    status.value = elearningLabel(
      action === 'register' ? 'offlineLearner.registered' : 'offlineLearner.registrationCancelled',
      isZh.value,
    )
  } catch (error) {
    statusTone.value = 'error'
    status.value = errorText(error)
  } finally {
    busy.value = false
  }
}

function consumeScannedToken(): string | null {
  const scanned = readElearningOfflineAttendanceToken(window.location.hash)
  if (!scanned) return null
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
  return scanned
}

onMounted(() => {
  const scanned = consumeScannedToken()
  if (scanned) token.value = scanned
  void refresh()
    .then(async () => {
      if (scanned) await attend()
    })
    .catch((error) => {
      statusTone.value = 'error'
      status.value = errorText(error)
    })
    .finally(() => {
      loading.value = false
    })
})
</script>

<style scoped>
.offline-learner {
  display: grid;
  gap: 12px;
  padding: 16px;
  border: 1px solid #cbd9e8;
  border-radius: 10px;
  background: #f8fbff;
}
.offline-learner h2,
.offline-learner h3,
.offline-learner p { margin: 0; }
.offline-learner__training,
.offline-learner__training li,
.offline-learner__attendance,
.offline-learner__attendance label { display: grid; gap: 6px; }
.offline-learner__training ol { display: grid; gap: 8px; }
.offline-learner__training button { min-height: 36px; justify-self: start; }
.offline-learner__attendance textarea,
.offline-learner__attendance button { min-height: 36px; }
.offline-learner__error { color: #b42318; }
</style>
