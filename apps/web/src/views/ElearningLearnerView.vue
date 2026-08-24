<template>
  <section class="elearning-learner" aria-labelledby="elearning-learner-title">
    <header class="elearning-learner__header">
      <h1 id="elearning-learner-title">学习中心</h1>
      <p>观看已指派课程。考试仅在服务端确认视频完成后开放。</p>
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

    <p v-if="loading && courses.length === 0" class="elearning-muted">正在加载课程…</p>
    <p v-else-if="courses.length === 0 && statusTone !== 'error'" class="elearning-muted">暂无已指派课程。</p>

    <article
      v-for="course in courses"
      :key="course.courseId"
      class="elearning-course"
      :data-testid="`elearning-course-${course.courseId}`"
    >
      <h2>{{ course.title }}</h2>
      <dl class="elearning-meta">
        <div>
          <dt>截止日期</dt>
          <dd>{{ course.assignment.deadline || '无' }}</dd>
        </div>
        <div>
          <dt>视频进度</dt>
          <dd>{{ videoStatusLabel(course.video.status) }}</dd>
        </div>
        <div>
          <dt>课程完成</dt>
          <dd>{{ course.completed ? '已完成' : '未完成' }}</dd>
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
          开始学习
        </button>
        <button
          type="button"
          class="elearning-btn elearning-btn--secondary"
          data-testid="elearning-start-exam"
          :disabled="busy || course.video.status !== 'completed'"
          :aria-disabled="course.video.status !== 'completed'"
          @click="void startExam(course)"
        >
          开始考试
        </button>
      </div>

      <video
        v-if="activeCourseId === course.courseId && playbackSrc"
        class="elearning-video"
        data-testid="elearning-learner-video"
        controls
        :src="playbackSrc"
        @play="onPlay($event)"
        @pause="onPause($event)"
        @ended="onEnded($event)"
        @seeking="onSeeking($event)"
        @seeked="onSeeked($event)"
      >
        您的浏览器不支持视频播放。
      </video>

      <p
        v-if="course.exam.latestAttempt && course.exam.latestAttempt.status === 'graded'"
        class="elearning-result"
        data-testid="elearning-latest-attempt"
      >
        最近成绩：{{ course.exam.latestAttempt.autoScore }} / {{ course.exam.latestAttempt.totalScore }}
        · {{ course.exam.latestAttempt.passed ? '通过' : '未通过' }}
      </p>

      <form
        v-if="examCourseId === course.courseId && paper"
        class="elearning-exam"
        data-testid="elearning-exam-form"
        @submit.prevent="void submitExam()"
      >
        <fieldset
          v-for="question in paper.questions"
          :key="question.questionRevisionId"
          class="elearning-exam-question"
        >
          <legend>{{ question.position }}. {{ question.prompt }}</legend>
          <p class="elearning-muted">分值 {{ question.points }}</p>
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
              @change="onAnswerChange($event, question.questionRevisionId, option.id, question.questionType)"
            >
            <span>{{ option.text }}</span>
          </label>
        </fieldset>
        <button
          type="submit"
          class="elearning-btn elearning-btn--primary"
          data-testid="elearning-submit-exam"
          :disabled="busy"
        >
          提交答卷
        </button>
      </form>

      <p
        v-if="examCourseId === course.courseId && examResult"
        class="elearning-result"
        data-testid="elearning-exam-result"
      >
        得分 {{ examResult.autoScore }} / {{ examResult.totalScore }}
        · {{ examResult.passed ? '通过' : '未通过' }}
      </p>
    </article>
  </section>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import {
  ELEARNING_WATCH_HEARTBEAT_INTERVAL_MS,
  ElearningApiError,
  elearningPlaybackSourceUrl,
  getElearningCapabilities,
  isElearningV01Ready,
  issueElearningPlaybackTicket,
  listMyElearningCourses,
  sendElearningHeartbeat,
  startElearningExam,
  startElearningWatch,
  submitElearningExam,
  type ElearningExamSubmitResult,
  type ElearningLearnerCourse,
  type ElearningPublicPaper,
  type ElearningQuestionType,
} from '../services/elearning'

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

interface PendingBeat {
  playing: boolean
  positionMs: number
  sessionId: string
  epoch: number
}

let sessionId: string | null = null
let lastSequence = 0
let heartbeatTimer: number | null = null
let sendingHeartbeat = false
let watchStopped = false
let watchEpoch = 0
let videoNode: HTMLVideoElement | null = null
let pendingBeats: PendingBeat[] = []

function formatError(error: unknown): string {
  if (error instanceof ElearningApiError) {
    return `失败：${error.code}（${error.status}）`
  }
  return '失败：request_failed（0）'
}

function videoStatusLabel(status: ElearningLearnerCourse['video']['status']): string {
  if (status === 'completed') return '已完成'
  if (status === 'in_progress') return '学习中'
  return '未开始'
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
  pendingBeats = []
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
  if (watchStopped || !sessionId) return
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
      if (result.status === 'completed') {
        stopWatchSession()
        await refreshCourses()
        break
      }
    }
  } catch (error) {
    if (drainEpoch === watchEpoch) {
      statusTone.value = 'error'
      status.value = formatError(error)
      stopWatchSession()
    }
  } finally {
    sendingHeartbeat = false
  }
  if (pendingBeats.length > 0 && !watchStopped && sessionId) {
    void flushHeartbeatQueue()
  }
}

function onPlay(event: Event): void {
  bindVideo(event)
  if (!sessionId || watchStopped) return
  startHeartbeatTimer()
  enqueueBeat(true)
}

function onPause(event: Event): void {
  const video = bindVideo(event)
  clearHeartbeatTimer()
  if (!sessionId || watchStopped) return
  if (isNaturalVideoEnd(video)) return
  enqueueBeat(false)
}

function onEnded(event: Event): void {
  bindVideo(event)
  clearHeartbeatTimer()
  enqueueBeat(true)
}

function onSeeking(event: Event): void {
  const video = bindVideo(event)
  clearHeartbeatTimer()
  if (!sessionId || watchStopped) return
  if (video?.ended) return
  enqueueBeat(false)
}

function onSeeked(event: Event): void {
  const video = bindVideo(event)
  if (!sessionId || watchStopped || !video || video.paused || video.ended) return
  startHeartbeatTimer()
}

function isSelected(questionRevisionId: string, optionId: string): boolean {
  return (answers.value[questionRevisionId] ?? []).includes(optionId)
}

function onAnswerChange(
  event: Event,
  questionRevisionId: string,
  optionId: string,
  questionType: ElearningQuestionType,
): void {
  const checked = event.target instanceof HTMLInputElement ? event.target.checked : false
  const current = answers.value[questionRevisionId] ?? []
  if (questionType === 'multiple_choice') {
    answers.value = {
      ...answers.value,
      [questionRevisionId]: checked
        ? [...current.filter((id) => id !== optionId), optionId]
        : current.filter((id) => id !== optionId),
    }
    return
  }
  answers.value = {
    ...answers.value,
    [questionRevisionId]: checked ? [optionId] : [],
  }
}

async function startWatch(course: ElearningLearnerCourse): Promise<void> {
  if (busy.value || !ready.value) return
  busy.value = true
  status.value = ''
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
    playbackSrc.value = elearningPlaybackSourceUrl(ticket.token)
    if (watch.status === 'completed') {
      await refreshCourses()
    }
  } catch (error) {
    statusTone.value = 'error'
    status.value = formatError(error)
  } finally {
    busy.value = false
  }
}

async function startExam(course: ElearningLearnerCourse): Promise<void> {
  if (busy.value || !ready.value || course.video.status !== 'completed') return
  busy.value = true
  status.value = ''
  try {
    const result = await startElearningExam(course.exam.itemId)
    examCourseId.value = course.courseId
    paper.value = result.paper
    attemptId.value = result.attemptId
    examResult.value = null
    answers.value = Object.fromEntries(result.paper.questions.map((question) => [question.questionRevisionId, []]))
  } catch (error) {
    statusTone.value = 'error'
    status.value = formatError(error)
  } finally {
    busy.value = false
  }
}

async function submitExam(): Promise<void> {
  if (busy.value || !ready.value || !attemptId.value || !paper.value) return
  busy.value = true
  try {
    const payload: Record<string, string[]> = {}
    for (const question of paper.value.questions) {
      payload[question.questionRevisionId] = [...(answers.value[question.questionRevisionId] ?? [])]
    }
    examResult.value = await submitElearningExam(attemptId.value, payload)
    paper.value = null
    await refreshCourses()
  } catch (error) {
    statusTone.value = 'error'
    status.value = formatError(error)
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  loading.value = true
  void ensureV01Ready()
    .then(() => refreshCourses())
    .catch((error) => {
      statusTone.value = 'error'
      status.value = formatError(error)
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
