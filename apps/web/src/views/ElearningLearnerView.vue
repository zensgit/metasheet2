<template>
  <section class="elearning-learner" aria-labelledby="elearning-learner-title">
    <header class="elearning-learner__header">
      <h1 id="elearning-learner-title">{{ elearningLabel('learner.title', isZh) }}</h1>
      <p>{{ elearningLabel('learner.subtitle', isZh) }}</p>
    </header>

    <ElearningCreditWalletSection v-if="incentiveEnabled" />

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
      :key="course.courseVersionId"
      class="elearning-course"
      :data-testid="`elearning-course-${course.courseId}`"
      :data-course-version-id="course.courseVersionId"
    >
      <h2>{{ course.title }}</h2>
      <dl class="elearning-meta">
        <div>
          <dt>{{ elearningLabel('learner.access', isZh) }}</dt>
          <dd>{{ course.access.required
            ? elearningLabel('learner.required', isZh)
            : elearningLabel('learner.selfStudy', isZh) }}</dd>
        </div>
        <div>
          <dt>{{ elearningLabel('learner.deadline', isZh) }}</dt>
          <dd>{{ course.assignment?.deadline || elearningLabel('learner.deadlineNone', isZh) }}</dd>
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
          :disabled="busy
            || course.video.status !== 'completed'
            || course.exam.latestAttempt?.status === 'awaiting_manual'"
          :aria-disabled="course.video.status !== 'completed'
            || course.exam.latestAttempt?.status === 'awaiting_manual'"
          @click="void startExam(course)"
        >
          {{ course.exam.latestAttempt?.status === 'awaiting_manual'
            ? elearningLabel('learner.awaitingManual', isZh)
            : course.exam.latestAttempt?.status === 'started'
              ? elearningLabel('learner.continueExam', isZh)
              : elearningLabel('learner.startExam', isZh) }}
        </button>
      </div>

      <video
        v-if="activeCourseVersionId === course.courseVersionId && playbackSrc"
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
        @error="onPlaybackError($event)"
      >
        {{ elearningLabel('learner.videoUnsupported', isZh) }}
      </video>

      <p
        v-if="course.exam.latestAttempt
          && (course.exam.latestAttempt.status === 'graded'
            || course.exam.latestAttempt.status === 'awaiting_manual')"
        class="elearning-result"
        data-testid="elearning-latest-attempt"
      >
        {{ course.exam.latestAttempt.status === 'awaiting_manual'
          ? elearningLabel('learner.awaitingManual', isZh)
          : elearningLatestAttempt(course.exam.latestAttempt.autoScore, course.exam.latestAttempt.totalScore, course.exam.latestAttempt.passed, isZh) }}
      </p>

      <form
        v-if="examCourseVersionId === course.courseVersionId && paper"
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
        <p
          v-if="examDeadlineAt !== null"
          class="elearning-muted"
          data-testid="elearning-exam-countdown"
          role="timer"
          aria-live="polite"
          aria-atomic="true"
          :aria-label="examCountdownLabel"
        >
          {{ examCountdownLabel }}
        </p>
        <fieldset
          v-for="question in paper.questions"
          :key="question.questionRevisionId"
          class="elearning-exam-question"
        >
          <legend>{{ question.position }}. {{ question.prompt }}</legend>
          <p class="elearning-muted">{{ elearningQuestionPoints(question.points, isZh) }}</p>
          <textarea
            v-if="question.questionType === 'short_answer'"
            class="elearning-short-answer"
            data-testid="elearning-short-answer"
            :value="shortAnswerValue(question.questionRevisionId)"
            :maxlength="ELEARNING_SHORT_ANSWER_MAX_CHARS"
            :disabled="busy || examLocked"
            @input="onShortAnswerInput($event, question.questionRevisionId)"
          />
          <template v-else>
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
          </template>
        </fieldset>
        <button
          type="submit"
          class="elearning-btn elearning-btn--primary"
          data-testid="elearning-submit-exam"
          :disabled="busy || examLocked || !examFullyAnswered"
        >
          {{ elearningLabel('learner.submitExam', isZh) }}
        </button>
      </form>

      <p
        v-if="examCourseVersionId === course.courseVersionId && examResult"
        class="elearning-result"
        data-testid="elearning-exam-result"
      >
        {{ examResult.status === 'awaiting_manual'
          ? elearningLabel('learner.awaitingManual', isZh)
          : elearningExamScore(examResult.autoScore, examResult.totalScore, examResult.passed, isZh) }}
      </p>
    </article>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useLocale } from '../composables/useLocale'
import {
  ELEARNING_WATCH_HEARTBEAT_INTERVAL_MS,
  ELEARNING_SHORT_ANSWER_MAX_CHARS,
  ElearningApiError,
  elearningPlaybackSourceUrl,
  getElearningCapabilities,
  isElearningLearnerReady,
  issueElearningPlaybackTicket,
  listMyElearningCourses,
  sendElearningHeartbeat,
  saveElearningExamAnswers,
  startElearningExam,
  startElearningWatch,
  submitElearningExam,
  type ElearningExamSubmitResult,
  type ElearningExamAnswers,
  type ElearningLearnerCourse,
  type ElearningPlaybackTicket,
  type ElearningPublicPaper,
  type ElearningExamQuestionType,
  type ElearningWatchState,
} from '../services/elearning'
import ElearningCreditWalletSection from './ElearningCreditWalletSection.vue'
import {
  elearningExamAnswerProgress,
  elearningExamCountdown,
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
const incentiveEnabled = ref(false)
const status = ref('')
const statusTone = ref<'info' | 'error'>('info')
const activeCourseVersionId = ref<string | null>(null)
const playbackSrc = ref('')
const examCourseVersionId = ref<string | null>(null)
const paper = ref<ElearningPublicPaper | null>(null)
const attemptId = ref<string | null>(null)
const answers = ref<ElearningExamAnswers>({})
const examResult = ref<ElearningExamSubmitResult | null>(null)
const examLocked = ref(false)
const examDeadlineAt = ref<string | null>(null)
const examRemainingMs = ref(0)

const answeredCount = computed(() => {
  if (!paper.value) return 0
  let count = 0
  for (const question of paper.value.questions) {
    if (answerHasValue(answers.value[question.questionRevisionId])) count += 1
  }
  return count
})

const examFullyAnswered = computed(() => {
  if (!paper.value || paper.value.questions.length === 0) return false
  return paper.value.questions.every(
    (question) => answerHasValue(answers.value[question.questionRevisionId]),
  )
})

const examCountdownLabel = computed(() => (
  elearningExamCountdown(examRemainingMs.value, isZh.value)
))

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
let viewMounted = false
let watchStartPending = false
let pendingDraft: ElearningExamAnswers | null = null
let saveWork: Promise<void> = Promise.resolve()
let examEpoch = 0
let statusSource: 'draft' | null = null
let examCountdownTimer: number | null = null

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

function clearExamCountdownTimer(): void {
  if (examCountdownTimer != null) {
    window.clearInterval(examCountdownTimer)
    examCountdownTimer = null
  }
}

function clearExamDeadline(): void {
  clearExamCountdownTimer()
  examDeadlineAt.value = null
  examRemainingMs.value = 0
}

function updateExamCountdown(): void {
  if (examDeadlineAt.value === null) return
  const deadlineMs = Date.parse(examDeadlineAt.value)
  examRemainingMs.value = Number.isFinite(deadlineMs)
    ? Math.max(0, deadlineMs - Date.now())
    : 0
  if (examRemainingMs.value === 0) clearExamCountdownTimer()
}

function applyExamDeadline(deadlineAt: string | null): void {
  clearExamCountdownTimer()
  if (
    !viewMounted
    || typeof deadlineAt !== 'string'
    || !Number.isFinite(Date.parse(deadlineAt))
  ) {
    examDeadlineAt.value = null
    examRemainingMs.value = 0
    return
  }
  examDeadlineAt.value = deadlineAt
  updateExamCountdown()
  if (examRemainingMs.value === 0) return
  examCountdownTimer = window.setInterval(updateExamCountdown, 1000)
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
  const leadMs = Math.min(TICKET_RENEWAL_LEAD_MS, Math.floor(ttlMs / 2))
  const localExpiryMs = nowMs + ttlMs
  const serverExpiryMs = Number.isFinite(parsedExpiryMs) ? parsedExpiryMs : localExpiryMs
  const safeExpiryMs = Math.min(serverExpiryMs, localExpiryMs)
  return Math.max(TICKET_RENEWAL_MIN_DELAY_MS, safeExpiryMs - nowMs - leadMs)
}

function isUsablePlaybackTicket(
  ticket: ElearningPlaybackTicket,
  itemId: string,
  nowMs = Date.now(),
): boolean {
  if (ticket.itemId !== itemId) return false
  const ttlMs = ticket.ttlSeconds * 1000
  if (!Number.isFinite(ttlMs) || ttlMs <= TICKET_RENEWAL_MIN_DELAY_MS) return false
  const parsedExpiryMs = Date.parse(ticket.expiresAt)
  if (!Number.isFinite(parsedExpiryMs)) return false
  return parsedExpiryMs - nowMs > TICKET_RENEWAL_MIN_DELAY_MS
}

function ownsPendingWatchStart(epoch: number, courseVersionId: string): boolean {
  return viewMounted && epoch === watchEpoch && activeCourseVersionId.value === courseVersionId
}

function isCurrentPlaybackContext(
  epoch: number,
  courseVersionId: string | null,
  itemId: string | null,
): boolean {
  return (
    viewMounted
    && !watchStopped
    && epoch === watchEpoch
    && courseVersionId != null
    && itemId != null
    && activeCourseVersionId.value === courseVersionId
    && activeItemId === itemId
  )
}

function rejectPlaybackTicket(): void {
  writeStatus(formatError(null), 'error')
  stopWatchSession()
}

function schedulePlaybackTicketRenewal(expiresAt: string, ttlSeconds: number): void {
  clearTicketRenewalTimer()
  if (!viewMounted || watchStopped || !activeItemId) return
  const epoch = watchEpoch
  const courseVersionId = activeCourseVersionId.value
  const itemId = activeItemId
  ticketRenewalTimer = window.setTimeout(() => {
    ticketRenewalTimer = null
    void renewPlaybackTicket(epoch, courseVersionId, itemId)
  }, ticketRenewalDelayMs(expiresAt, ttlSeconds))
}

function isPlaybackIntendedPlaying(video: HTMLVideoElement | null): boolean {
  if (heartbeatTimer != null) return true
  if (!video) return false
  return !video.paused && !video.ended
}

function applyRenewedPlaybackTicket(token: string): void {
  ticketRenewalRestorePlaying = isPlaybackIntendedPlaying(videoNode)
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
    if (shouldPlay && viewMounted && !watchStopped && epoch === watchEpoch) {
      try {
        await video.play()
        if (viewMounted && epoch === watchEpoch && !watchStopped && sessionId) {
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
  courseVersionId: string | null,
  itemId: string | null,
): Promise<void> {
  if (!isCurrentPlaybackContext(epoch, courseVersionId, itemId) || !itemId) return
  try {
    const ticket = await issueElearningPlaybackTicket(itemId)
    if (!isCurrentPlaybackContext(epoch, courseVersionId, itemId)) return
    if (!isUsablePlaybackTicket(ticket, itemId)) {
      rejectPlaybackTicket()
      return
    }
    applyRenewedPlaybackTicket(ticket.token)
    schedulePlaybackTicketRenewal(ticket.expiresAt, ticket.ttlSeconds)
  } catch (error) {
    if (!isCurrentPlaybackContext(epoch, courseVersionId, itemId)) return
    writeStatus(formatError(error), 'error')
    stopWatchSession()
  }
}

function applyServerWatchProgress(
  courseVersionId: string,
  watch: Pick<ElearningWatchState, 'status' | 'effectiveMs' | 'maxPositionMs'>,
): void {
  courses.value = courses.value.map((course) => {
    if (course.courseVersionId !== courseVersionId) return course
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
  incentiveEnabled.value = capabilities.enabled === true
    && capabilities.capabilities.incentive === true
  if (!isElearningLearnerReady(capabilities)) {
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
      if (activeCourseVersionId.value) {
        applyServerWatchProgress(activeCourseVersionId.value, result)
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

function onPlaybackError(event: Event): void {
  bindVideo(event)
  if (!applyingTicketRenewal) return
  writeStatus(formatError(null), 'error')
  stopWatchSession()
  playbackSrc.value = ''
  sessionId = null
  videoNode = null
}

function isSelected(questionRevisionId: string, optionId: string): boolean {
  const answer = answers.value[questionRevisionId]
  return Array.isArray(answer) && answer.includes(optionId)
}

function answerHasValue(answer: string[] | string | undefined): boolean {
  return typeof answer === 'string' ? answer.trim().length > 0 : (answer?.length ?? 0) > 0
}

function shortAnswerValue(questionRevisionId: string): string {
  const answer = answers.value[questionRevisionId]
  return typeof answer === 'string' ? answer : ''
}

function canonicalDraft(): ElearningExamAnswers {
  const payload: ElearningExamAnswers = {}
  if (!paper.value) return payload
  for (const question of paper.value.questions) {
    const answer = answers.value[question.questionRevisionId]
    payload[question.questionRevisionId] = question.questionType === 'short_answer'
      ? typeof answer === 'string' ? answer : ''
      : Array.isArray(answer) ? [...answer] : []
  }
  return payload
}

function ownsDraftSave(attempt: string, epoch: number): boolean {
  return epoch === examEpoch && attemptId.value === attempt
}

function isAttemptExpired(error: unknown): error is ElearningApiError {
  return error instanceof ElearningApiError && error.code === 'attempt_expired'
}

async function handleAttemptExpired(
  error: unknown,
  options: {
    expectedAttempt?: string
    expectedEpoch?: number
    lockActiveAttempt: boolean
    refresh: boolean
  },
): Promise<boolean> {
  if (!isAttemptExpired(error)) return false
  if (
    options.expectedAttempt !== undefined
    && options.expectedEpoch !== undefined
    && !ownsDraftSave(options.expectedAttempt, options.expectedEpoch)
  ) {
    return false
  }
  if (options.lockActiveAttempt) {
    pendingDraft = null
    examLocked.value = true
    examEpoch += 1
    clearExamDeadline()
  }
  statusSource = null
  statusTone.value = 'error'
  status.value = elearningLabel('learner.examExpired', isZh.value)
  if (options.refresh && ready.value && viewMounted) {
    try {
      await refreshCourses()
    } catch {
      /* Preserve the authoritative expiry message if the follow-up refresh fails. */
    }
  }
  return true
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
      const result = await saveElearningExamAnswers(currentAttempt, payload)
      if (ownsDraftSave(currentAttempt, epoch)) applyExamDeadline(result.deadlineAt)
      clearOwnedDraftSaveError(currentAttempt, epoch)
    } catch (error) {
      if (await handleAttemptExpired(error, {
        expectedAttempt: currentAttempt,
        expectedEpoch: epoch,
        lockActiveAttempt: true,
        refresh: true,
      })) return
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
  questionType: ElearningExamQuestionType,
): void {
  if (examLocked.value || questionType === 'short_answer') return
  const checked = event.target instanceof HTMLInputElement ? event.target.checked : false
  const stored = answers.value[questionRevisionId]
  const current = Array.isArray(stored) ? stored : []
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

function onShortAnswerInput(event: Event, questionRevisionId: string): void {
  if (examLocked.value) return
  const value = event.target instanceof HTMLTextAreaElement ? event.target.value : ''
  answers.value = {
    ...answers.value,
    [questionRevisionId]: value.slice(0, ELEARNING_SHORT_ANSWER_MAX_CHARS),
  }
  queueDraftSave()
}

async function startWatch(course: ElearningLearnerCourse): Promise<void> {
  if (!ready.value || !viewMounted) return
  if (busy.value && !watchStartPending) return
  busy.value = true
  watchStartPending = true
  clearStatus()
  stopWatchSession()
  sessionId = null
  videoNode = null
  playbackSrc.value = ''
  activeCourseVersionId.value = course.courseVersionId
  const epoch = watchEpoch
  const courseVersionId = course.courseVersionId
  const itemId = course.video.itemId
  try {
    const watch = await startElearningWatch(itemId)
    if (!ownsPendingWatchStart(epoch, courseVersionId)) return
    const ticket = await issueElearningPlaybackTicket(itemId)
    if (!ownsPendingWatchStart(epoch, courseVersionId)) return
    if (!isUsablePlaybackTicket(ticket, itemId)) {
      writeStatus(formatError(null), 'error')
      return
    }
    lastSequence = watch.lastSequence
    sessionId = watch.sessionId
    watchStopped = false
    activeItemId = itemId
    applyServerWatchProgress(courseVersionId, watch)
    resumePositionMs = watch.status === 'in_progress' ? watch.maxPositionMs : null
    playbackSrc.value = elearningPlaybackSourceUrl(ticket.token)
    schedulePlaybackTicketRenewal(ticket.expiresAt, ticket.ttlSeconds)
    if (watch.status === 'completed' && ownsPendingWatchStart(epoch, courseVersionId)) {
      await refreshCourses()
    }
  } catch (error) {
    if (!ownsPendingWatchStart(epoch, courseVersionId)) return
    writeStatus(formatError(error), 'error')
  } finally {
    if (epoch === watchEpoch) {
      busy.value = false
      watchStartPending = false
    }
  }
}

async function startExam(course: ElearningLearnerCourse): Promise<void> {
  if (
    busy.value
    || !ready.value
    || course.video.status !== 'completed'
    || course.exam.latestAttempt?.status === 'awaiting_manual'
  ) return
  const epochBeforeDraftDrain = examEpoch
  busy.value = true
  try {
    await awaitExamDraftSaves()
    if (examEpoch !== epochBeforeDraftDrain || statusSource === 'draft') return
    clearStatus()
    pendingDraft = null
    examEpoch += 1
    const result = await startElearningExam(course.exam.itemId)
    clearExamDeadline()
    examCourseVersionId.value = course.courseVersionId
    paper.value = result.paper
    attemptId.value = result.attemptId
    examResult.value = null
    examLocked.value = false
    applyExamDeadline(result.deadlineAt)
    answers.value = Object.fromEntries(
      result.paper.questions.map((question) => [
        question.questionRevisionId,
        typeof result.answers[question.questionRevisionId] === 'string'
          ? result.answers[question.questionRevisionId]
          : [...(result.answers[question.questionRevisionId] ?? [])],
      ]),
    )
  } catch (error) {
    const currentAttempt = attemptId.value
    const locksCurrentAttempt = currentAttempt !== null
      && examCourseVersionId.value === course.courseVersionId
    if (await handleAttemptExpired(error, {
      ...(locksCurrentAttempt
        ? { expectedAttempt: currentAttempt, expectedEpoch: examEpoch }
        : {}),
      lockActiveAttempt: locksCurrentAttempt,
      refresh: locksCurrentAttempt || course.exam.latestAttempt !== null,
    })) return
    writeStatus(formatError(error), 'error')
  } finally {
    busy.value = false
  }
}

async function submitExam(): Promise<void> {
  if (busy.value || !ready.value || !attemptId.value || !paper.value) return
  if (!examFullyAnswered.value) return
  const currentAttempt = attemptId.value
  const currentEpoch = examEpoch
  examLocked.value = true
  busy.value = true
  try {
    await awaitExamDraftSaves()
    if (attemptId.value !== currentAttempt || examEpoch !== currentEpoch) return
    const payload = canonicalDraft()
    examResult.value = await submitElearningExam(currentAttempt, payload)
    examEpoch += 1
    clearExamDeadline()
    paper.value = null
    pendingDraft = null
    clearOwnedDraftSaveError()
    await refreshCourses()
  } catch (error) {
    if (await handleAttemptExpired(error, {
      expectedAttempt: currentAttempt,
      expectedEpoch: currentEpoch,
      lockActiveAttempt: true,
      refresh: true,
    })) return
    examLocked.value = false
    writeStatus(formatError(error), 'error')
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  viewMounted = true
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
  viewMounted = false
  clearExamCountdownTimer()
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

.elearning-short-answer {
  width: 100%;
  min-height: 120px;
  resize: vertical;
  box-sizing: border-box;
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
