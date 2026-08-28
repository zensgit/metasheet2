<template>
  <section class="grading-attempt" aria-labelledby="grading-attempt-title">
    <div class="grading-attempt__toolbar">
      <button
        type="button"
        class="grading-btn grading-btn--secondary"
        data-testid="elearning-grading-back"
        @click="$emit('back')"
      >
        {{ elearningLabel('grading.backToQueue', isZh) }}
      </button>
    </div>

    <p
      v-if="loading"
      class="grading-status"
      data-testid="elearning-grading-attempt-loading"
      role="status"
      aria-live="polite"
    >
      {{ elearningLabel('grading.detailLoading', isZh) }}
    </p>
    <p
      v-else-if="closed"
      class="grading-status grading-status--error"
      data-testid="elearning-grading-attempt-closed"
      role="alert"
    >
      {{ closedMessage }}
    </p>
    <p
      v-else-if="errorMessage"
      class="grading-status grading-status--error"
      data-testid="elearning-grading-attempt-error"
      role="alert"
    >
      {{ errorMessage }}
    </p>

    <template v-else-if="detail">
      <header class="grading-attempt__header">
        <h2 id="grading-attempt-title">{{ detail.examTitle }} · {{ detail.courseTitle }}</h2>
        <p data-testid="elearning-grading-attempt-learner">
          {{ elearningLabel('grading.learnerIdLabel', isZh) }}: {{ detail.userId }}
        </p>
        <p>{{ detail.submittedAt }}</p>
      </header>

      <p
        v-if="completed"
        class="grading-status"
        data-testid="elearning-grading-complete"
        role="status"
        aria-live="polite"
      >
        {{ elearningLabel('grading.completeNotice', isZh) }}
        <button
          type="button"
          class="grading-btn grading-btn--primary"
          data-testid="elearning-grading-done"
          @click="$emit('graded')"
        >
          {{ elearningLabel('grading.backToQueue', isZh) }}
        </button>
      </p>

      <article
        v-for="question in detail.questions"
        :key="question.questionRevisionId"
        class="grading-question"
        :data-testid="`elearning-grading-question-${question.questionRevisionId}`"
      >
        <p class="grading-question__prompt">{{ question.prompt }}</p>
        <p
          class="grading-question__answer"
          :data-testid="`elearning-grading-answer-${question.questionRevisionId}`"
        >
          {{ elearningLabel('grading.learnerAnswerLabel', isZh) }}: {{ question.learnerAnswer }}
        </p>

        <template v-if="question.grade">
          <p
            class="grading-question__graded"
            :data-testid="`elearning-grading-graded-${question.questionRevisionId}`"
          >
            {{ elearningManualGradingGradedLabel(question.grade.score, question.grade.maxScore, isZh) }}
          </p>
          <p v-if="question.grade.comment">{{ question.grade.comment }}</p>
          <p
            v-if="duplicateQuestions.has(question.questionRevisionId)"
            class="grading-question__duplicate"
            :data-testid="`elearning-grading-duplicate-${question.questionRevisionId}`"
          >
            {{ elearningLabel('grading.duplicateNotice', isZh) }}
          </p>
        </template>

        <form
          v-else-if="drafts[question.questionRevisionId]"
          class="grading-question__form"
          novalidate
          @submit.prevent="void submitQuestion(question)"
        >
          <label class="grading-field">
            <span>{{ elearningLabel('grading.scoreLabel', isZh) }} (0-{{ question.points }})</span>
            <input
              v-model="drafts[question.questionRevisionId].score"
              :data-testid="`elearning-grading-score-${question.questionRevisionId}`"
              type="number"
              min="0"
              :max="question.points"
              step="1"
              :disabled="submittingQuestionId !== null"
              required
            >
          </label>
          <label class="grading-field">
            <span>{{ elearningLabel('grading.commentLabel', isZh) }}</span>
            <textarea
              v-model="drafts[question.questionRevisionId].comment"
              :data-testid="`elearning-grading-comment-${question.questionRevisionId}`"
              :maxlength="ELEARNING_MANUAL_GRADE_COMMENT_MAX"
              :placeholder="elearningLabel('grading.commentPlaceholder', isZh)"
              :disabled="submittingQuestionId !== null"
              rows="2"
            />
          </label>
          <p
            v-if="drafts[question.questionRevisionId].error"
            class="grading-question__error"
            :data-testid="`elearning-grading-question-error-${question.questionRevisionId}`"
            role="alert"
          >
            {{ drafts[question.questionRevisionId].error }}
          </p>
          <button
            type="submit"
            class="grading-btn grading-btn--primary"
            :data-testid="`elearning-grading-submit-${question.questionRevisionId}`"
            :disabled="submittingQuestionId !== null"
          >
            {{ submittingQuestionId === question.questionRevisionId
              ? elearningLabel('grading.submitting', isZh)
              : elearningLabel('grading.submit', isZh) }}
          </button>
        </form>
      </article>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useLocale } from '../composables/useLocale'
import { ElearningApiError } from '../services/elearning'
import {
  ELEARNING_MANUAL_GRADE_COMMENT_MAX,
  getElearningManualGradingDetail,
  submitElearningManualGrade,
  type ElearningManualGradingDetail,
  type ElearningManualGradingQuestionDetail,
} from '../services/elearningManualGrading'
import {
  elearningLabel,
  elearningManualGradingErrorMessage,
  elearningManualGradingGradedLabel,
  elearningManualGradingScoreRangeError,
} from './elearningLabels'

const props = defineProps<{ attemptId: string }>()
const emit = defineEmits<{ back: []; graded: []; conflict: [] }>()

const { isZh } = useLocale()

interface Draft {
  // Vue's v-model on <input type="number"> casts through looseToNumber on every
  // input event REGARDLESS of the .number modifier — an empty or otherwise
  // unparseable value stays the original string, but "8" becomes the number 8.
  // Draft.score therefore has to accept both; validateDraft normalizes via
  // String(draft.score).
  score: string | number
  comment: string
  error: string
  pendingIntent: {
    requestId: string
    score: number
    comment: string | null
  } | null
}

type DetailLoadOutcome = 'loaded' | 'closed' | 'failed'

const loading = ref(true)
const closed = ref(false)
const errorMessage = ref('')
const detail = ref<ElearningManualGradingDetail | null>(null)
const completed = ref(false)
const submittingQuestionId = ref<string | null>(null)
const duplicateQuestions = ref<Set<string>>(new Set())
const drafts = reactive<Record<string, Draft>>({})

const closedMessage = computed(() => elearningManualGradingErrorMessage(404, 'not_found', isZh.value))

function resetDrafts(questions: ElearningManualGradingQuestionDetail[]): void {
  for (const key of Object.keys(drafts)) delete drafts[key]
  for (const question of questions) {
    if (!question.grade) {
      drafts[question.questionRevisionId] = {
        score: '',
        comment: '',
        error: '',
        pendingIntent: null,
      }
    }
  }
}

async function loadDetail(): Promise<DetailLoadOutcome> {
  loading.value = true
  closed.value = false
  errorMessage.value = ''
  try {
    const result = await getElearningManualGradingDetail(props.attemptId)
    detail.value = result
    resetDrafts(result.questions)
    return 'loaded'
  } catch (error) {
    detail.value = null
    if (error instanceof ElearningApiError && error.status === 404) {
      closed.value = true
      return 'closed'
    } else {
      errorMessage.value = elearningManualGradingErrorMessage(
        error instanceof ElearningApiError ? error.status : 0,
        error instanceof ElearningApiError ? error.code : 'request_failed',
        isZh.value,
      )
      return 'failed'
    }
  } finally {
    loading.value = false
  }
}

function validateDraft(question: ElearningManualGradingQuestionDetail, draft: Draft): number | null {
  const raw = String(draft.score).trim()
  if (raw === '') {
    draft.error = elearningLabel('grading.scoreRequired', isZh.value)
    return null
  }
  if (!/^-?\d+$/.test(raw)) {
    draft.error = elearningLabel('grading.scoreInteger', isZh.value)
    return null
  }
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > question.points) {
    draft.error = elearningManualGradingScoreRangeError(question.points, isZh.value)
    return null
  }
  draft.error = ''
  return parsed
}

function freshRequestId(): string {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new Error('crypto.randomUUID unavailable')
  }
  return crypto.randomUUID()
}

function resolveSubmissionIntent(
  draft: Draft,
  score: number,
  comment: string | null,
): NonNullable<Draft['pendingIntent']> {
  const pending = draft.pendingIntent
  if (pending && pending.score === score && pending.comment === comment) {
    return pending
  }
  const next = {
    requestId: freshRequestId(),
    score,
    comment,
  }
  draft.pendingIntent = next
  return next
}

async function submitQuestion(question: ElearningManualGradingQuestionDetail): Promise<void> {
  // Handler-level guard (in addition to the template's :disabled) — closes the
  // window between a fast second click and Vue's next DOM patch.
  if (submittingQuestionId.value !== null) return
  const draft = drafts[question.questionRevisionId]
  if (!draft) return
  const score = validateDraft(question, draft)
  if (score === null) return

  const trimmedComment = draft.comment.trim()
  const comment = trimmedComment === '' ? null : trimmedComment
  let intent: NonNullable<Draft['pendingIntent']>
  try {
    // One UUID identifies one logical payload. A retry after a timeout or a
    // retryable server failure reuses it, so a committed-but-lost response is
    // recovered through the backend duplicate=true path. Editing score or
    // comment creates a new logical payload and therefore a new UUID.
    intent = resolveSubmissionIntent(draft, score, comment)
  } catch {
    draft.error = elearningLabel('grading.clientIdUnavailable', isZh.value)
    return
  }

  submittingQuestionId.value = question.questionRevisionId
  try {
    const result = await submitElearningManualGrade(props.attemptId, {
      requestId: intent.requestId,
      questionRevisionId: question.questionRevisionId,
      score: intent.score,
      comment: intent.comment,
    })
    if (result.duplicate) {
      duplicateQuestions.value = new Set(duplicateQuestions.value).add(question.questionRevisionId)
    }
    // Optimistic local patch so the form disappears immediately; when the
    // attempt is not yet finalized this is superseded a moment later by the
    // authoritative loadDetail() refresh below.
    if (detail.value) {
      detail.value = {
        ...detail.value,
        gradedQuestions: result.gradedQuestions,
        questions: detail.value.questions.map((existing) =>
          existing.questionRevisionId === question.questionRevisionId
            ? {
                ...existing,
                grade: {
                  score: result.score,
                  maxScore: result.maxScore,
                  comment: intent.comment,
                  graderId: existing.grade?.graderId ?? '',
                  gradedAt: existing.grade?.gradedAt ?? '',
                },
              }
            : existing,
        ),
      }
    }
    delete drafts[question.questionRevisionId]
    if (result.status === 'graded') {
      // DETAIL_SQL only returns rows with status = 'awaiting_manual' — a
      // refetch here would 404 on the very attempt we just finished grading.
      // Show the completion state from the submit response instead.
      completed.value = true
    } else {
      await loadDetail()
    }
  } catch (error) {
    if (error instanceof ElearningApiError && error.status === 409) {
      // The same question may have been graded concurrently, or the attempt
      // may already have finalized. Re-read the authoritative detail first,
      // then always ask the parent for a page-1 queue refresh. The queue is the
      // authoritative pending-work surface; if either read is unavailable, the
      // final visible state is an explicit error rather than stale success.
      draft.pendingIntent = null
      await loadDetail()
      emit('conflict')
      return
    }
    draft.error = elearningManualGradingErrorMessage(
      error instanceof ElearningApiError ? error.status : 0,
      error instanceof ElearningApiError ? error.code : 'request_failed',
      isZh.value,
    )
  } finally {
    submittingQuestionId.value = null
  }
}

onMounted(() => {
  void loadDetail()
})

watch(() => props.attemptId, () => {
  completed.value = false
  duplicateQuestions.value = new Set()
  void loadDetail()
})
</script>

<style scoped>
.grading-attempt {
  display: grid;
  gap: 14px;
}

.grading-attempt__toolbar {
  display: flex;
}

.grading-attempt__header h2 {
  margin: 0;
  font-size: 1.1rem;
}

.grading-attempt__header p {
  margin: 2px 0 0;
  color: #5f7088;
  font-size: 0.85rem;
}

.grading-question {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid #dfe7f4;
  border-radius: 10px;
  background: #fff;
}

.grading-question__prompt {
  font-weight: 600;
  color: #123154;
}

.grading-question__answer {
  color: #334155;
  white-space: pre-wrap;
}

.grading-question__graded {
  color: #14532d;
  font-weight: 600;
}

.grading-question__duplicate {
  color: #8a5a00;
}

.grading-question__form {
  display: grid;
  gap: 10px;
}

.grading-question__error {
  color: #9b1c1c;
  margin: 0;
}

.grading-field {
  display: grid;
  gap: 6px;
}

.grading-field input,
.grading-field textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 8px 10px;
  font: inherit;
}

.grading-btn {
  border: 0;
  border-radius: 8px;
  padding: 8px 12px;
  font: inherit;
  cursor: pointer;
}

.grading-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.grading-btn--primary {
  background: #2563eb;
  color: #fff;
}

.grading-btn--secondary {
  background: #eef3fb;
  color: #123154;
}

.grading-status {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: #eef7ff;
}

.grading-status--error {
  background: #fdecec;
  color: #9b1c1c;
}
</style>
