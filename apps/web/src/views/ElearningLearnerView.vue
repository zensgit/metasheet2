<template>
  <section class="elearning-learner" aria-labelledby="elearning-learner-title">
    <header class="elearning-learner__header">
      <h1 id="elearning-learner-title">{{ elearningLabel('learner.title', isZh) }}</h1>
      <p>{{ elearningLabel('learner.subtitle', isZh) }}</p>
    </header>

    <p
      v-if="status"
      class="elearning-status"
      :class="{ 'elearning-status--error': statusTone === 'error' }"
      data-testid="elearning-learner-status"
      role="status"
      aria-live="polite"
    >
      {{ status }}
    </p>

    <p v-if="loading && courses.length === 0" class="elearning-muted">{{ elearningLabel('learner.loading', isZh) }}</p>
    <p v-else-if="courses.length === 0 && statusTone !== 'error'" class="elearning-muted">{{ elearningLabel('learner.empty', isZh) }}</p>

    <article
      v-for="course in courses"
      :key="course.courseId"
      class="elearning-course"
      :data-testid="`elearning-course-${course.courseId}`"
    >
      <h2>{{ course.title }}</h2>
      <dl class="elearning-meta">
        <div>
          <dt>{{ elearningLabel('learner.deadline', isZh) }}</dt>
          <dd>{{ course.assignment.deadline || elearningLabel('learner.deadlineNone', isZh) }}</dd>
        </div>
        <div>
          <dt>{{ elearningLabel('learner.videoProgress', isZh) }}</dt>
          <dd data-testid="elearning-video-progress">{{ elearningLearnerVideoProgressLabel(course.video.status, course.video.effectiveMs, course.video.durationMs, isZh) }}</dd>
        </div>
        <div>
          <dt>{{ elearningLabel('learner.courseCompletion', isZh) }}</dt>
          <dd>{{ course.completed ? elearningLabel('status.completed', isZh) : elearningLabel('status.incomplete', isZh) }}</dd>
        </div>
      </dl>

      <div class="elearning-course__actions">
        <button
          type="button"
          class="elearning-btn elearning-btn--primary"
          data-testid="elearning-start-watch"
          :disabled="busy"
          @click="void startWatch(course)"
        >
          {{ elearningLabel('learner.startWatch', isZh) }}
        </button>
        <button
          type="button"
          class="elearning-btn elearning-btn--secondary"
          data-testid="elearning-start-exam"
          :disabled="busy || course.video.status !== 'completed'"
          :aria-disabled="course.video.status !== 'completed'"
          @click="void startExam(course)"
        >
          {{ course.exam.latestAttempt?.status === 'started'
            ? elearningLabel('learner.continueExam', isZh)
            : elearningLabel('learner.startExam', isZh) }}
        </button>
      </div>

      <video
        v-if="activeCourseId === course.courseId && playbackSrc"
        class="elearning-video"
        data-testid="elearning-learner-video"
        controls
        :src="playbackSrc"
        @loadedmetadata="tryApplyResumeCursor($event)"
        @durationchange="tryApplyResumeCursor($event)"
        @play="onPlay($event)"
        @pause="onPause($event)"
        @ended="onEnded($event)"
        @seeking="onSeeking($event)"
        @seeked="onSeeked($event)"
      >
        {{ elearningLabel('learner.videoUnsupported', isZh) }}
      </video>

      <p
        v-if="course.exam.latestAttempt && course.exam.latestAttempt.status === 'graded'"
        class="elearning-result"
        data-testid="elearning-latest-attempt"
      >
        {{ elearningLatestAttempt(course.exam.latestAttempt.autoScore, course.exam.latestAttempt.totalScore, course.exam.latestAttempt.passed, isZh) }}
      </p>

      <form
        v-if="examCourseId === course.courseId && paper"
        class="elearning-exam"
        data-testid="elearning-exam-form"
        @submit.prevent="void submitExam()"
      >
        <p
          class="elearning-muted"
          data-testid="elearning-exam-answer-progress"
          role="status"
          aria-live="polite"
        >
          {{ elearningExamAnswerProgress(answeredCount, paper.questions.length, isZh) }}
        </p>
        <fieldset
          v-for="question in paper.questions"
          :key="question.questionRevisionId"
          class="elearning-exam-question"
        >
          <legend>{{ question.position }}. {{ question.prompt }}</legend>
          <p class="elearning-muted">{{ elearningQuestionPoints(question.points, isZh) }}</p>
          <label
            v-for="option in question.options"
            :key="option.id"
            class="elearning-option"
          >
            <input
              :type="question.questionType === 'multiple_choice' ? 'checkbox' : 'radio'"
              :name="`elearning-answer-${question.questionRevisionId}`"
              :value="option.id"
              :checked="isSelected(question.questionRevisionId, option.id)"
              :disabled="busy || examLocked"
              @change="onAnswerChange($event, question.questionRevisionId, option.id, question.questionType)"
            >
            <span>{{ option.text }}</span>
          </label>
        </fieldset>
        <button
          type="submit"
          class="elearning-btn elearning-btn--primary"
          data-testid="elearning-submit-exam"
          :disabled="busy || !examFullyAnswered"
        >
          {{ elearningLabel('learner.submitExam', isZh) }}
        </button>
      </form>

      <p
        v-if="examCourseId === course.courseId && examResult"
        class="elearning-result"
        data-testid="elearning-exam-result"
      >
        {{ elearningExamScore(examResult.autoScore, examResult.totalScore, examResult.passed, isZh) }}
      </p>
    </article>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useLocale } from '../composables/useLocale'
import {
  ELEARNING_WATCH_HEARTBEAT_INTERVAL_MS,
  ElearningApiError,
  elearningPlaybackSourceUrl,
  getElearningCapabilities,
  isElearningV01Ready,
  issueElearningPlaybackTicket,
  listMyElearningCourses,
  sendElearningHeartbeat,
  saveElearningExamAnswers,
  startElearningExam,
  startElearningWatch,
  submitElearningExam,
  type ElearningExamSubmitResult,
  type ElearningLearnerCourse,
  type ElearningPublicPaper,
  type ElearningQuestionType,
  type ElearningWatchState,
} from '../services/elearning'
import {
  elearningExamAnswerProgress,
  elearningExamScore,
  elearningFailure,
  elearningLabel,
  elearningLatestAttempt,
  elearningLearnerVideoProgressLabel,
  elearningQuestionPoints,
} from './elearningLabels'

const { isZh } = useLocale()

const courses = ref<ElearningLearnerCourse[]>([])
const loading = ref(false)
const busy = ref(false)
const ready = ref(false)
const status = ref('')
const statusTone = ref<'info' | 'error'>('info')
const activeCourseId = ref<string | null>(null)
const playbackSrc = ref('')
const examCourseId = ref<string | null>(null)
const paper = ref<ElearningPublicPaper | null>(null)
const attemptId = ref<string | null>(null)
const answers = ref<Record<string, string[]>>({})
const examResult = ref<ElearningExamSubmitResult | null>(null)
const examLocked = ref(false)

const answeredCount = computed(() => {
  if (!paper.value) return 0
  let count = 0
  for (const question of paper.value.questions) {
    if ((answers.value[question.questionRevisionId] ?? []).length > 0) count += 1
  }
  return count
})

const examFullyAnswered = computed(() => {
  if (!paper.value || paper.value.questions.length === 0) return false
  return paper.value.questions.every(
    (question) => (answers.value[question.questionRevisionId] ?? []).length > 0,
  )
})

interface PendingBeat {
  playing: boolean
  positionMs: number
  sessionId: string
  epoch: number
}

const TICKET_RENEWAL_LEAD_MS = 30_000
const TICKET_RENEWAL_MIN_DELAY_MS = 5_000

let sessionId: string | null = null
let lastSequence = 0
let heartbeatTimer: number | null = null
let sendingHeartbeat = false
let watchStopped = false
let watchEpoch = 0
let videoNode: HTMLVideoElement | null = null
let pendingBeats: PendingBeat[] = []
let resumePositionMs: number | null = null
let applyingResumeSeek = false
let activeItemId: string | null = null
let ticketRenewalTimer: number | null = null
let applyingTicketRenewal = false
let ticketRenewalRestorePlaying = false
let finishingTicketRenewal = false
let pendingDraft: Record<string, string[]> | null = null
let saveWork: Promise<void> = Promise.resolve()
let examEpoch = 0
let statusSource: 'draft' | null = null

function formatError(error: unknown): string {
  if (error instanceof ElearningApiError) {
    return elearningFailure(error.code, error.status, isZh.value)
  }
  return elearningFailure('request_failed', 0, isZh.value)
}

function invalidateDraftStatusOwnership(): void {
  statusSource = null
}

function writeStatus(text: string, tone: 'info' | 'error'): void {
  invalidateDraftStatusOwnership()
  statusTone.value = tone
  status.value = text
}

function clearStatus(): void {
  invalidateDraftStatusOwnership()
  statusTone.value = 'info'
  status.value = ''
}

function bindVideo(event: Event): HTMLVideoElement | null {
  if (event.currentTarget instanceof HTMLVideoElement) {
    videoNode = event.currentTarget
  }
  return videoNode
}

function clearHeartbeatTimer(): void {
  if (heartbeatTimer != null) {
    window.clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function clearTicketRenewalTimer(): void {
  if (ticketRenewalTimer != null) {
    window.clearTimeout(ticketRenewalTimer)
    ticketRenewalTimer = null
  }
}

function startHeartbeatTimer(): void {
  if (heartbeatTimer != null || watchStopped || !sessionId) return
  heartbeatTimer = window.setInterval(() => {
    enqueueBeat(true)
  }, ELEARNING_WATCH_HEARTBEAT_INTERVAL_MS)
}

function stopWatchSession(): void {
  watchStopped = true
  watchEpoch += 1
  clearHeartbeatTimer()
  clearTicketRenewalTimer()
  pendingBeats = []
  resumePositionMs = null
  applyingResumeSeek = false
  applyingTicketRenewal = false
  ticketRenewalRestorePlaying = false
  finishingTicketRenewal = false
  activeItemId = null
}

function ticketRenewalDelayMs(expiresAt: string, ttlSeconds: number, nowMs = Date.now()): number {
  const ttlMs = Math.max(1, ttlSeconds) * 1000
  const parsedExpiryMs = Date.parse(expiresAt)
  const expiryMs = Number.isFinite(parsedExpiryMs) ? parsedExpiryMs : nowMs + ttlMs
  const leadMs = Math.min(TICKET_RENEWAL_LEAD_MS, Math.floor(ttlMs / 2))
  return Math.max(TICKET_RENEWAL_MIN_DELAY_MS, expiryMs - nowMs - leadMs)
}

function isCurrentPlaybackContext(epoch: number, courseId: string | null, itemId: string | null): boolean {
  return (
    !watchStopped
    && epoch === watchEpoch
    && courseId != null
    && itemId != null
    && activeCourseId.value === courseId
    && activeItemId === itemId
    && sessionId != null
  )
}

function schedulePlaybackTicketRenewal(expiresAt: string, ttlSeconds: number): void {
  clearTicketRenewalTimer()
  if (watchStopped || !sessionId || !activeItemId) return
  const epoch = watchEpoch
  const courseId = activeCourseId.value
  const itemId = activeItemId
  ticketRenewalTimer = window.setTimeout(() => {
    ticketRenewalTimer = null
    void renewPlaybackTicket(epoch, courseId, itemId)
  }, ticketRenewalDelayMs(expiresAt, ttlSeconds))
}

function applyRenewedPlaybackTicket(token: string): void {
  ticketRenewalRestorePlaying = heartbeatTimer != null
  if (videoNode && Number.isFinite(videoNode.currentTime)) {
    resumePositionMs = positionMs()
  }
  applyingTicketRenewal = true
  finishingTicketRenewal = false
  clearHeartbeatTimer()
  playbackSrc.value = elearningPlaybackSourceUrl(token)
}

function finishTicketRenewalRestore(video: HTMLVideoElement): void {
  if (!applyingTicketRenewal || finishingTicketRenewal) return
  if (resumePositionMs != null || applyingResumeSeek) return
  finishingTicketRenewal = true
  void settleTicketRenewalRestore(video)
}

async function settleTicketRenewalRestore(video: HTMLVideoElement): Promise<void> {
  const epoch = watchEpoch
  const shouldPlay = ticketRenewalRestorePlaying
  ticketRenewalRestorePlaying = false
  try {
    if (shouldPlay && !watchStopped && sessionId && epoch === watchEpoch) {
      try {
        await video.play()
        if (epoch === watchEpoch && !watchStopped && sessionId) {
          startHeartbeatTimer()
        }
      } catch {
        /* autoplay/play rejection must not claim playing credit */
      }
    }
  } finally {
    if (epoch === watchEpoch) {
      applyingTicketRenewal = false
      finishingTicketRenewal = false
    }
  }
}

async function renewPlaybackTicket(
  epoch: number,
  courseId: string | null,
  itemId: string | null,
): Promise<void> {
  if (!isCurrentPlaybackContext(epoch, courseId, itemId) || !itemId) return
  try {
    const ticket = await issueElearningPlaybackTicket(itemId)
    if (!isCurrentPlaybackContext(epoch, courseId, itemId)) return
    if (ticket.itemId !== itemId) {
      writeStatus(formatError(null), 'error')
      stopWatchSession()
      return
    }
    applyRenewedPlaybackTicket(ticket.token)
    schedulePlaybackTicketRenewal(ticket.expiresAt, ticket.ttlSeconds)
  } catch (error) {
    if (!isCurrentPlaybackContext(epoch, courseId, itemId)) return
    writeStatus(formatError(error), 'error')
    stopWatchSession()
  }
}

function applyServerWatchProgress(
  courseId: string,
  watch: Pick<ElearningWatchState, 'status' | 'effectiveMs' | 'maxPositionMs'>,
): void {
  courses.value = courses.value.map((course) => {
    if (course.courseId !== courseId) return course
    return {
      ...course,
      video: {
        ...course.video,
        status: watch.status,
        effectiveMs: watch.effectiveMs,
        maxPositionMs: watch.maxPositionMs,
      },
    }
  })
}

function applyResumeCursor(video: HTMLVideoElement): void {
  if (resumePositionMs == null) return
  const durationSec = video.duration
  if (!Number.isFinite(durationSec) || durationSec <= 0) return
  const targetSec = Math.max(0, Math.min(resumePositionMs / 1000, durationSec))
  resumePositionMs = null
  const currentSec = Number.isFinite(video.currentTime) ? video.currentTime : 0
  if (Math.abs(currentSec - targetSec) < 0.001) return
  applyingResumeSeek = true
  video.currentTime = targetSec
}

function releaseResumeSeek(): void {
  applyingResumeSeek = false
}

function positionMs(): number {
  const video = videoNode
  if (!video || !Number.isFinite(video.currentTime)) return 0
  return Math.max(0, Math.round(video.currentTime * 1000))
}

function isNaturalVideoEnd(video: HTMLVideoElement | null): boolean {
  if (!video) return false
  if (video.ended) return true
  const duration = video.duration
  const currentTime = video.currentTime
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(currentTime)) return false
  return currentTime >= duration
}

async function ensureV01Ready(): Promise<void> {
  const capabilities = await getElearningCapabilities()
  if (!isElearningV01Ready(capabilities)) {
    throw new ElearningApiError('feature_disabled', 404)
  }
  ready.value = true
}

async function refreshCourses(): Promise<void> {
  if (!ready.value) return
  const result = await listMyElearningCourses()
  courses.value = result.courses
}

function enqueueBeat(playing: boolean): void {
  if (watchStopped || !sessionId || applyingTicketRenewal) return
  pendingBeats.push({
    playing,
    positionMs: positionMs(),
    sessionId,
    epoch: watchEpoch,
  })
  void flushHeartbeatQueue()
}

async function flushHeartbeatQueue(): Promise<void> {
  if (sendingHeartbeat) return
  sendingHeartbeat = true
  const drainEpoch = watchEpoch
  try {
    while (pendingBeats.length > 0) {
      const beat = pendingBeats.shift()
      if (!beat) break
      if (watchStopped || !sessionId || beat.sessionId !== sessionId || beat.epoch !== watchEpoch) {
        continue
      }
      const epoch = watchEpoch
      const currentSession = sessionId
      const result = await sendElearningHeartbeat(currentSession, {
        sequence: lastSequence + 1,
        positionMs: beat.positionMs,
        playing: beat.playing,
      })
      if (watchStopped || epoch !== watchEpoch || sessionId !== currentSession) {
        break
      }
      lastSequence = result.lastSequence
      if (activeCourseId.value) {
        applyServerWatchProgress(activeCourseId.value, result)
      }
      if (result.status === 'completed') {
        stopWatchSession()
        await refreshCourses()
        break
      }
    }
  } catch (error) {
    if (drainEpoch === watchEpoch) {
      writeStatus(formatError(error), 'error')
      stopWatchSession()
    }
  } finally {
    sendingHeartbeat = false
  }
  if (pendingBeats.length > 0 && !watchStopped && sessionId) {
    void flushHeartbeatQueue()
  }
}

function tryApplyResumeCursor(event: Event): void {
  const video = bindVideo(event)
  if (video) applyResumeCursor(video)
  if (video && applyingTicketRenewal) finishTicketRenewalRestore(video)
}

function onPlay(event: Event): void {
  bindVideo(event)
  if (applyingTicketRenewal) return
  releaseResumeSeek()
  if (!sessionId || watchStopped) return
  startHeartbeatTimer()
  enqueueBeat(true)
}

function onPause(event: Event): void {
  const video = bindVideo(event)
  if (applyingTicketRenewal || applyingResumeSeek) return
  clearHeartbeatTimer()
  if (!sessionId || watchStopped) return
  if (isNaturalVideoEnd(video)) return
  enqueueBeat(false)
}

function onEnded(event: Event): void {
  bindVideo(event)
  if (applyingTicketRenewal || applyingResumeSeek) return
  clearHeartbeatTimer()
  enqueueBeat(true)
}

function onSeeking(event: Event): void {
  const video = bindVideo(event)
  if (applyingTicketRenewal || applyingResumeSeek) return
  clearHeartbeatTimer()
  if (!sessionId || watchStopped) return
  if (video?.ended) return
  enqueueBeat(false)
}

function onSeeked(event: Event): void {
  const video = bindVideo(event)
  if (applyingResumeSeek) {
    releaseResumeSeek()
    if (applyingTicketRenewal && video) finishTicketRenewalRestore(video)
    return
  }
  if (applyingTicketRenewal) {
    if (video) finishTicketRenewalRestore(video)
    return
  }
  if (!sessionId || watchStopped || !video || video.paused || video.ended) return
  startHeartbeatTimer()
}

function isSelected(questionRevisionId: string, optionId: string): boolean {
  return (answers.value[questionRevisionId] ?? []).includes(optionId)
}

function canonicalDraft(): Record<string, string[]> {
  const payload: Record<string, string[]> = {}
  if (!paper.value) return payload
  for (const question of paper.value.questions) {
    payload[question.questionRevisionId] = [...(answers.value[question.questionRevisionId] ?? [])]
  }
  return payload
}

function ownsDraftSave(attempt: string, epoch: number): boolean {
  return epoch === examEpoch && attemptId.value === attempt
}

function applyDraftSaveFailure(error: unknown, attempt: string, epoch: number): void {
  if (examLocked.value || !ownsDraftSave(attempt, epoch)) return
  statusTone.value = 'error'
  status.value = formatError(error)
  statusSource = 'draft'
}

function clearOwnedDraftSaveError(attempt?: string, epoch?: number): void {
  if (statusSource !== 'draft') return
  if (attempt !== undefined && epoch !== undefined && !ownsDraftSave(attempt, epoch)) return
  statusSource = null
  statusTone.value = 'info'
  status.value = ''
}

async function runPendingDraftSave(): Promise<void> {
  while (pendingDraft && attemptId.value) {
    const payload = pendingDraft
    pendingDraft = null
    const currentAttempt = attemptId.value
    const epoch = examEpoch
    try {
      await saveElearningExamAnswers(currentAttempt, payload)
      clearOwnedDraftSaveError(currentAttempt, epoch)
    } catch (error) {
      applyDraftSaveFailure(error, currentAttempt, epoch)
      if (pendingDraft === null) return
    }
  }
}

function queueDraftSave(): void {
  if (examLocked.value || !attemptId.value || !paper.value) return
  pendingDraft = canonicalDraft()
  saveWork = saveWork.then(runPendingDraftSave, runPendingDraftSave)
}

async function awaitExamDraftSaves(): Promise<void> {
  let current = saveWork
  await current
  while (saveWork !== current) {
    current = saveWork
    await current
  }
}

function onAnswerChange(
  event: Event,
  questionRevisionId: string,
  optionId: string,
  questionType: ElearningQuestionType,
): void {
  if (examLocked.value) return
  const checked = event.target instanceof HTMLInputElement ? event.target.checked : false
  const current = answers.value[questionRevisionId] ?? []
  if (questionType === 'multiple_choice') {
    answers.value = {
      ...answers.value,
      [questionRevisionId]: checked
        ? [...current.filter((id) => id !== optionId), optionId]
        : current.filter((id) => id !== optionId),
    }
  } else {
    answers.value = {
      ...answers.value,
      [questionRevisionId]: checked ? [optionId] : [],
    }
  }
  queueDraftSave()
}

async function startWatch(course: ElearningLearnerCourse): Promise<void> {
  if (busy.value || !ready.value) return
  busy.value = true
  clearStatus()
  stopWatchSession()
  sessionId = null
  videoNode = null
  playbackSrc.value = ''
  activeCourseId.value = course.courseId
  try {
    const watch = await startElearningWatch(course.video.itemId)
    const ticket = await issueElearningPlaybackTicket(course.video.itemId)
    lastSequence = watch.lastSequence
    sessionId = watch.sessionId
    watchStopped = sessionId == null
    activeItemId = course.video.itemId
    applyServerWatchProgress(course.courseId, watch)
    resumePositionMs = watch.status === 'in_progress' ? watch.maxPositionMs : null
    playbackSrc.value = elearningPlaybackSourceUrl(ticket.token)
    if (!watchStopped) {
      schedulePlaybackTicketRenewal(ticket.expiresAt, ticket.ttlSeconds)
    }
    if (watch.status === 'completed') {
      await refreshCourses()
    }
  } catch (error) {
    writeStatus(formatError(error), 'error')
  } finally {
    busy.value = false
  }
}

async function startExam(course: ElearningLearnerCourse): Promise<void> {
  if (busy.value || !ready.value || course.video.status !== 'completed') return
  busy.value = true
  try {
    await awaitExamDraftSaves()
    if (statusSource === 'draft') return
    clearStatus()
    examLocked.value = false
    pendingDraft = null
    examEpoch += 1
    const result = await startElearningExam(course.exam.itemId)
    examCourseId.value = course.courseId
    paper.value = result.paper
    attemptId.value = result.attemptId
    examResult.value = null
    answers.value = Object.fromEntries(
      result.paper.questions.map((question) => [
        question.questionRevisionId,
        [...(result.answers[question.questionRevisionId] ?? [])],
      ]),
    )
  } catch (error) {
    writeStatus(formatError(error), 'error')
  } finally {
    busy.value = false
  }
}

async function submitExam(): Promise<void> {
  if (busy.value || !ready.value || !attemptId.value || !paper.value) return
  if (!examFullyAnswered.value) return
  examLocked.value = true
  busy.value = true
  try {
    await awaitExamDraftSaves()
    const payload = canonicalDraft()
    examResult.value = await submitElearningExam(attemptId.value, payload)
    paper.value = null
    pendingDraft = null
    clearOwnedDraftSaveError()
    await refreshCourses()
  } catch (error) {
    examLocked.value = false
    writeStatus(formatError(error), 'error')
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  loading.value = true
  void ensureV01Ready()
    .then(() => refreshCourses())
    .catch((error) => {
      writeStatus(formatError(error), 'error')
    })
    .finally(() => {
      loading.value = false
    })
})

onUnmounted(() => {
  stopWatchSession()
})
</script>

<style scoped>
.elearning-learner {
  width: min(880px, 100%);
  margin: 0 auto;
  padding: 16px;
  display: grid;
  gap: 16px;
  color: #123154;
}

.elearning-learner__header h1,
.elearning-course h2 {
  margin: 0 0 6px;
}

.elearning-course,
.elearning-exam,
.elearning-exam-question {
  display: grid;
  gap: 10px;
  border: 1px solid #dfe7f4;
  border-radius: 10px;
  padding: 12px;
  background: #fff;
}

.elearning-meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 8px;
  margin: 0;
}

.elearning-meta dt {
  color: #5f7088;
  font-size: 0.8rem;
}

.elearning-meta dd {
  margin: 0;
}

.elearning-course__actions,
.elearning-option {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.elearning-video {
  width: 100%;
  max-height: 360px;
  background: #0f172a;
}

.elearning-btn {
  border: 0;
  border-radius: 8px;
  padding: 8px 12px;
  font: inherit;
  cursor: pointer;
}

.elearning-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.elearning-btn--primary {
  background: #2563eb;
  color: #fff;
}

.elearning-btn--secondary {
  background: #eef3fb;
  color: #123154;
}

.elearning-muted {
  color: #5f7088;
  font-size: 0.9rem;
}

.elearning-status {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: #eef7ff;
}

.elearning-status--error {
  background: #fdecec;
  color: #9b1c1c;
}

.elearning-result {
  margin: 0;
  font-weight: 600;
}

@media (max-width: 640px) {
  .elearning-learner {
    padding: 12px;
  }

  .elearning-course__actions {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
