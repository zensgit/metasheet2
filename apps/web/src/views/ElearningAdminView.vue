<template>
  <section class="elearning-admin" aria-labelledby="elearning-admin-title">
    <header class="elearning-admin__header">
      <h1 id="elearning-admin-title">{{ elearningLabel('admin.title', isZh) }}</h1>
      <p>{{ elearningLabel('admin.subtitle', isZh) }}</p>
    </header>

    <form class="elearning-admin__form" @submit.prevent="void submitPublishAndAssign()">
      <label class="elearning-field">
        <span>{{ elearningLabel('admin.videoFile', isZh) }}</span>
        <input
          data-testid="elearning-admin-file"
          type="file"
          accept="video/mp4,.mp4"
          :disabled="busy || published !== null"
          @change="onFileChange"
        >
        <span
          v-if="file"
          class="elearning-selected-file"
          data-testid="elearning-admin-selected-file"
        >
          {{ elearningSelectedFile(file.name, isZh) }}
        </span>
      </label>

      <label class="elearning-field">
        <span>{{ elearningLabel('admin.courseTitle', isZh) }}</span>
        <input
          v-model="title"
          data-testid="elearning-admin-title-input"
          type="text"
          maxlength="200"
          required
          :disabled="busy || published !== null"
          autocomplete="off"
        >
      </label>

      <fieldset class="elearning-questions">
        <legend>{{ elearningLabel('admin.questions', isZh) }}</legend>
        <article
          v-for="(question, qIndex) in questions"
          :key="question.localId"
          class="elearning-question"
          :data-testid="`elearning-admin-question-${qIndex}`"
        >
          <div class="elearning-question__row">
            <label class="elearning-field">
              <span>{{ elearningLabel('admin.questionType', isZh) }}</span>
              <select
                :value="question.questionType"
                :disabled="busy || published !== null"
                @change="onQuestionTypeEvent($event, qIndex)"
              >
                <option value="single_choice">{{ elearningLabel('admin.questionTypeSingle', isZh) }}</option>
                <option value="multiple_choice">{{ elearningLabel('admin.questionTypeMultiple', isZh) }}</option>
                <option value="true_false">{{ elearningLabel('admin.questionTypeTrueFalse', isZh) }}</option>
              </select>
            </label>
            <label class="elearning-field elearning-field--narrow">
              <span>{{ elearningLabel('admin.points', isZh) }}</span>
              <input
                v-model.number="question.points"
                type="number"
                min="1"
                step="1"
                required
                :disabled="busy || published !== null"
              >
            </label>
            <button
              v-if="questions.length > 1"
              type="button"
              class="elearning-btn elearning-btn--ghost"
              :disabled="busy || published !== null"
              @click="removeQuestion(qIndex)"
            >
              {{ elearningLabel('admin.removeQuestion', isZh) }}
            </button>
          </div>

          <label class="elearning-field">
            <span>{{ elearningLabel('admin.prompt', isZh) }}</span>
            <textarea
              v-model="question.prompt"
              :data-testid="`elearning-admin-prompt-${qIndex}`"
              rows="2"
              required
              :disabled="busy || published !== null"
            />
          </label>

          <fieldset class="elearning-options">
            <legend>{{ elearningLabel('admin.optionsLegend', isZh) }}</legend>
            <label
              v-for="(option, oIndex) in question.options"
              :key="option.id"
              class="elearning-option"
            >
              <input
                :type="question.questionType === 'multiple_choice' ? 'checkbox' : 'radio'"
                :name="`elearning-correct-${question.localId}`"
                :value="option.id"
                :checked="question.correctOptionIds.includes(option.id)"
                :disabled="busy || published !== null"
                :aria-label="elearningCorrectOptionAria(option.id, isZh)"
                @change="onCorrectEvent($event, qIndex, option.id)"
              >
              <input
                v-model="option.text"
                type="text"
                required
                :disabled="busy || published !== null || question.questionType === 'true_false'"
                :aria-label="elearningOptionAria(oIndex + 1, isZh)"
              >
              <button
                v-if="question.questionType !== 'true_false' && question.options.length > 2"
                type="button"
                class="elearning-btn elearning-btn--ghost"
                :disabled="busy || published !== null"
                @click="removeOption(qIndex, oIndex)"
              >
                {{ elearningLabel('admin.removeOption', isZh) }}
              </button>
            </label>
            <button
              v-if="question.questionType !== 'true_false'"
              type="button"
              class="elearning-btn elearning-btn--secondary"
              :disabled="busy || published !== null || question.options.length >= 20"
              @click="addOption(qIndex)"
            >
              {{ elearningLabel('admin.addOption', isZh) }}
            </button>
          </fieldset>
        </article>
        <button
          type="button"
          class="elearning-btn elearning-btn--secondary"
          :disabled="busy || published !== null || questions.length >= 50"
          data-testid="elearning-admin-add-question"
          @click="addQuestion"
        >
          {{ elearningLabel('admin.addQuestion', isZh) }}
        </button>
      </fieldset>

      <div class="elearning-admin__grid">
        <label class="elearning-field">
          <span>{{ elearningLabel('admin.passScore', isZh) }}</span>
          <input
            v-model.number="passScore"
            data-testid="elearning-admin-pass-score"
            type="number"
            min="0"
            step="1"
            required
            :disabled="busy || published !== null"
          >
        </label>
        <label class="elearning-field">
          <span>{{ elearningLabel('admin.maxAttempts', isZh) }}</span>
          <input
            v-model.number="maxAttempts"
            data-testid="elearning-admin-max-attempts"
            type="number"
            min="1"
            step="1"
            required
            :disabled="busy || published !== null"
          >
        </label>
        <label class="elearning-field">
          <span>{{ elearningLabel('admin.targetUser', isZh) }}</span>
          <input
            v-model="targetUserId"
            data-testid="elearning-admin-target"
            type="text"
            required
            :disabled="busy || published !== null"
            autocomplete="off"
          >
        </label>
        <label class="elearning-field">
          <span>{{ elearningLabel('admin.deadline', isZh) }}</span>
          <input
            v-model="deadlineLocal"
            data-testid="elearning-admin-deadline"
            type="datetime-local"
            :disabled="busy || published !== null"
          >
        </label>
      </div>

      <div class="elearning-admin__actions">
        <button
          class="elearning-btn elearning-btn--primary"
          type="submit"
          data-testid="elearning-admin-publish"
          :disabled="busy || published !== null || !ready"
        >
          {{ publishButtonLabel }}
        </button>
        <button
          v-if="published !== null && !assigned"
          class="elearning-btn elearning-btn--primary"
          type="button"
          data-testid="elearning-admin-retry"
          :disabled="busy || !ready"
          @click="void retryAssign()"
        >
          {{ busy ? elearningLabel('admin.retrying', isZh) : elearningLabel('admin.retry', isZh) }}
        </button>
      </div>
    </form>

    <p
      v-if="operationStage"
      class="elearning-operation-stage"
      data-testid="elearning-admin-operation-stage"
      role="status"
      aria-live="polite"
    >
      {{ operationStageLabel }}
    </p>

    <p
      v-if="status"
      class="elearning-status"
      :class="{ 'elearning-status--error': statusTone === 'error', 'elearning-status--partial': statusTone === 'partial' }"
      data-testid="elearning-admin-status"
      role="status"
      aria-live="polite"
    >
      {{ status }}
    </p>

    <ElearningContentAdminSection
      v-if="contentEnabled"
      :assignment-enabled="assignmentEnabled"
    />

    <ElearningCreditAdminSection v-if="incentiveEnabled" />

    <div class="elearning-admin__assessment-toggle">
      <button
        type="button"
        class="elearning-btn elearning-btn--secondary"
        data-testid="elearning-assessment-toggle"
        @click="showAssessmentAdmin = !showAssessmentAdmin"
      >
        {{ elearningLabel(showAssessmentAdmin ? 'admin.assessmentClose' : 'admin.assessmentOpen', isZh) }}
      </button>
    </div>

    <ElearningAssessmentAdminSection v-if="showAssessmentAdmin" />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useLocale } from '../composables/useLocale'
import {
  assignElearningDirect,
  ElearningApiError,
  getElearningCapabilities,
  isElearningContentReady,
  isElearningV01Ready,
  publishElearningCourse,
  uploadElearningMedia,
  type ElearningCoursePublishResult,
  type ElearningDirectAssignmentRequest,
  type ElearningQuestionType,
} from '../services/elearning'
import ElearningAssessmentAdminSection from './ElearningAssessmentAdminSection.vue'
import ElearningContentAdminSection from './ElearningContentAdminSection.vue'
import ElearningCreditAdminSection from './ElearningCreditAdminSection.vue'
import {
  elearningAssignIncomplete,
  elearningCorrectOptionAria,
  elearningFailure,
  elearningLabel,
  elearningOptionAria,
  elearningSelectedFile,
  elearningTrueFalseOptions,
} from './elearningLabels'

const { isZh } = useLocale()

type OperationStage = 'uploading' | 'publishing' | 'assigning'

interface OptionDraft {
  id: string
  text: string
}

interface QuestionDraft {
  localId: string
  questionType: ElearningQuestionType
  prompt: string
  options: OptionDraft[]
  correctOptionIds: string[]
  points: number
}

const title = ref('')
const file = ref<File | null>(null)
const passScore = ref(1)
const maxAttempts = ref(1)
const targetUserId = ref('')
const deadlineLocal = ref('')
const questions = ref<QuestionDraft[]>([newQuestion()])
const requestId = ref('')
const sourceKey = ref('')
const published = ref<ElearningCoursePublishResult | null>(null)
const frozenAssignment = ref<ElearningDirectAssignmentRequest | null>(null)
const assigned = ref(false)
const busy = ref(false)
const ready = ref(false)
const incentiveEnabled = ref(false)
const contentEnabled = ref(false)
const assignmentEnabled = ref(false)
const status = ref('')
const statusTone = ref<'info' | 'error' | 'partial'>('info')
const operationStage = ref<OperationStage | null>(null)
const showAssessmentAdmin = ref(false)

const operationStageLabel = computed(() => {
  const stage = operationStage.value
  if (stage === null) return ''
  const zh = isZh.value
  if (stage === 'uploading') return elearningLabel('admin.uploading', zh)
  if (stage === 'publishing') return elearningLabel('admin.publishingCourse', zh)
  return elearningLabel('admin.assigning', zh)
})

const publishButtonLabel = computed(() => {
  const zh = isZh.value
  if (!(busy.value && published.value === null)) return elearningLabel('admin.publish', zh)
  if (operationStage.value === 'uploading') return elearningLabel('admin.uploading', zh)
  if (operationStage.value === 'publishing') return elearningLabel('admin.publishingCourse', zh)
  return elearningLabel('admin.publishing', zh)
})

function newLocalId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `local-${Date.now()}`
}

function newQuestion(): QuestionDraft {
  return {
    localId: newLocalId(),
    questionType: 'single_choice',
    prompt: '',
    options: [
      { id: 'a', text: '' },
      { id: 'b', text: '' },
    ],
    correctOptionIds: [],
    points: 1,
  }
}

function formatError(error: unknown): string {
  if (error instanceof ElearningApiError) {
    return elearningFailure(error.code, error.status, isZh.value)
  }
  return elearningFailure('request_failed', 0, isZh.value)
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  file.value = input.files && input.files[0] ? input.files[0] : null
}

function onQuestionTypeEvent(event: Event, index: number): void {
  const raw = event.target instanceof HTMLSelectElement ? event.target.value : ''
  onQuestionTypeChange(index, raw)
}

function onCorrectEvent(event: Event, index: number, optionId: string): void {
  const checked = event.target instanceof HTMLInputElement ? event.target.checked : false
  onCorrectToggle(index, optionId, checked)
}

function onQuestionTypeChange(index: number, raw: string): void {
  const question = questions.value[index]
  if (!question) return
  if (raw !== 'single_choice' && raw !== 'multiple_choice' && raw !== 'true_false') return
  question.questionType = raw
  if (raw === 'true_false') {
    question.options = elearningTrueFalseOptions(isZh.value).map((option) => ({ ...option }))
    question.correctOptionIds = question.correctOptionIds.filter((id) => id === 'true' || id === 'false').slice(0, 1)
    return
  }
  if (question.options.length < 2) {
    question.options = [
      { id: 'a', text: '' },
      { id: 'b', text: '' },
    ]
  }
  if (raw === 'single_choice') {
    question.correctOptionIds = question.correctOptionIds.slice(0, 1)
  }
}

function onCorrectToggle(index: number, optionId: string, checked: boolean): void {
  const question = questions.value[index]
  if (!question) return
  if (question.questionType === 'multiple_choice') {
    if (checked) {
      if (!question.correctOptionIds.includes(optionId)) question.correctOptionIds.push(optionId)
    } else {
      question.correctOptionIds = question.correctOptionIds.filter((id) => id !== optionId)
    }
    return
  }
  question.correctOptionIds = checked ? [optionId] : []
}

function nextOptionId(options: OptionDraft[]): string {
  const used = new Set(options.map((option) => option.id))
  let serial = options.length + 1
  let id = `o${serial}`
  while (used.has(id)) {
    serial += 1
    id = `o${serial}`
  }
  return id
}

function addOption(index: number): void {
  const question = questions.value[index]
  if (!question || question.questionType === 'true_false' || question.options.length >= 20) return
  question.options.push({ id: nextOptionId(question.options), text: '' })
}

function removeOption(index: number, optionIndex: number): void {
  const question = questions.value[index]
  if (!question || question.options.length <= 2) return
  const [removed] = question.options.splice(optionIndex, 1)
  if (removed) {
    question.correctOptionIds = question.correctOptionIds.filter((id) => id !== removed.id)
  }
}

function addQuestion(): void {
  if (questions.value.length >= 50) return
  questions.value.push(newQuestion())
}

function removeQuestion(index: number): void {
  if (questions.value.length <= 1) return
  questions.value.splice(index, 1)
}

function readDeadlineIso(): string | undefined {
  const raw = deadlineLocal.value.trim()
  if (raw === '') return undefined
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) {
    throw new ElearningApiError('invalid_input', 400)
  }
  return parsed.toISOString()
}

function validateForm(): string | null {
  const zh = isZh.value
  if (!file.value) return elearningLabel('validation.mp4Required', zh)
  if (title.value.trim() === '') return elearningLabel('validation.titleRequired', zh)
  if (!Number.isSafeInteger(passScore.value) || passScore.value < 0) return elearningLabel('validation.passScoreInteger', zh)
  if (!Number.isSafeInteger(maxAttempts.value) || maxAttempts.value < 1) return elearningLabel('validation.maxAttemptsInteger', zh)
  if (targetUserId.value.trim() === '') return elearningLabel('validation.targetRequired', zh)
  if (questions.value.length < 1) return elearningLabel('validation.questionRequired', zh)
  let total = 0
  for (const question of questions.value) {
    if (question.prompt.trim() === '') return elearningLabel('validation.promptRequired', zh)
    if (!Number.isSafeInteger(question.points) || question.points < 1) return elearningLabel('validation.pointsInteger', zh)
    if (question.questionType === 'true_false') {
      if (question.options.length !== 2) return elearningLabel('validation.trueFalseOptions', zh)
    } else if (question.options.length < 2) {
      return elearningLabel('validation.choiceOptions', zh)
    }
    if (question.options.some((option) => option.text.trim() === '')) return elearningLabel('validation.optionsRequired', zh)
    if (question.correctOptionIds.length < 1) return elearningLabel('validation.correctRequired', zh)
    if (question.questionType !== 'multiple_choice' && question.correctOptionIds.length !== 1) {
      return elearningLabel('validation.singleCorrect', zh)
    }
    total += question.points
  }
  if (passScore.value > total) return elearningLabel('validation.passScoreTooHigh', zh)
  return null
}

function buildAssignmentPayload(courseVersionId: string): ElearningDirectAssignmentRequest {
  const deadline = readDeadlineIso()
  return deadline === undefined
    ? {
        targetUserId: targetUserId.value.trim(),
        courseVersionId,
        sourceKey: sourceKey.value,
      }
    : {
        targetUserId: targetUserId.value.trim(),
        courseVersionId,
        sourceKey: sourceKey.value,
        deadline,
      }
}

async function ensureV01Ready(): Promise<void> {
  const capabilities = await getElearningCapabilities()
  contentEnabled.value = isElearningContentReady(capabilities)
  assignmentEnabled.value = capabilities.enabled === true
    && capabilities.capabilities.assignment === true
  incentiveEnabled.value = capabilities.enabled === true
    && capabilities.capabilities.incentive === true
  ready.value = isElearningV01Ready(capabilities)
  if (!ready.value && !contentEnabled.value) {
    throw new ElearningApiError('feature_disabled', 404)
  }
}

async function runAssign(): Promise<boolean> {
  const payload = frozenAssignment.value
  if (!payload) return false
  try {
    await assignElearningDirect(payload)
    assigned.value = true
    statusTone.value = 'info'
    status.value = elearningLabel('admin.assignSuccess', isZh.value)
    return true
  } catch (error) {
    assigned.value = false
    statusTone.value = 'partial'
    status.value = elearningAssignIncomplete(formatError(error), isZh.value)
    return false
  }
}

async function submitPublishAndAssign(): Promise<void> {
  if (busy.value || published.value || !ready.value) return
  status.value = ''
  operationStage.value = null
  const invalid = validateForm()
  if (invalid) {
    statusTone.value = 'error'
    status.value = invalid
    return
  }
  const selected = file.value
  if (!selected) return
  busy.value = true
  operationStage.value = 'uploading'
  try {
    const media = await uploadElearningMedia(selected)
    operationStage.value = 'publishing'
    const result = await publishElearningCourse({
      requestId: requestId.value,
      title: title.value.trim(),
      mediaId: media.id,
      passScore: passScore.value,
      maxAttempts: maxAttempts.value,
      questions: questions.value.map((question) => ({
        questionType: question.questionType,
        prompt: question.prompt.trim(),
        options: question.options.map((option) => ({ id: option.id, text: option.text.trim() })),
        correctOptionIds: [...question.correctOptionIds],
        points: question.points,
      })),
    })
    published.value = result
    frozenAssignment.value = Object.freeze(buildAssignmentPayload(result.courseVersionId))
    operationStage.value = 'assigning'
    await runAssign()
  } catch (error) {
    statusTone.value = 'error'
    status.value = formatError(error)
  } finally {
    operationStage.value = null
    busy.value = false
  }
}

async function retryAssign(): Promise<void> {
  const current = published.value
  if (!current || assigned.value || busy.value || !ready.value || frozenAssignment.value == null) return
  status.value = ''
  busy.value = true
  operationStage.value = 'assigning'
  try {
    await runAssign()
  } finally {
    operationStage.value = null
    busy.value = false
  }
}

onMounted(() => {
  requestId.value = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : ''
  sourceKey.value = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : ''
  busy.value = true
  void ensureV01Ready()
    .catch((error) => {
      ready.value = false
      statusTone.value = 'error'
      status.value = formatError(error)
    })
    .finally(() => {
      busy.value = false
    })
})
</script>

<style scoped>
.elearning-admin {
  width: min(880px, 100%);
  margin: 0 auto;
  padding: 16px;
  display: grid;
  gap: 16px;
  color: #123154;
}

.elearning-admin__header h1 {
  margin: 0;
  font-size: 1.35rem;
}

.elearning-admin__header p,
.elearning-field span,
.elearning-questions legend,
.elearning-options legend {
  color: #5f7088;
  font-size: 0.9rem;
}

.elearning-admin__form,
.elearning-questions,
.elearning-question,
.elearning-options {
  display: grid;
  gap: 12px;
}

.elearning-admin__grid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
}

.elearning-field {
  display: grid;
  gap: 6px;
}

.elearning-field--narrow {
  max-width: 120px;
}

.elearning-field input,
.elearning-field select,
.elearning-field textarea,
.elearning-option input[type='text'] {
  width: 100%;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 8px 10px;
  font: inherit;
}

.elearning-question,
.elearning-questions {
  border: 1px solid #dfe7f4;
  border-radius: 10px;
  padding: 12px;
  background: #fff;
}

.elearning-question__row,
.elearning-option,
.elearning-admin__actions,
.elearning-admin__assessment-toggle {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: end;
}

.elearning-option {
  align-items: center;
}

.elearning-btn {
  border: 0;
  border-radius: 8px;
  padding: 8px 12px;
  font: inherit;
  cursor: pointer;
}

.elearning-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.elearning-btn--primary {
  background: #2563eb;
  color: #fff;
}

.elearning-btn--secondary,
.elearning-btn--ghost {
  background: #eef3fb;
  color: #123154;
}

.elearning-selected-file,
.elearning-operation-stage {
  margin: 0;
  color: #5f7088;
  font-size: 0.9rem;
}

.elearning-selected-file {
  overflow-wrap: anywhere;
}

.elearning-operation-stage {
  padding: 10px 12px;
  border-radius: 8px;
  background: #eef7ff;
  color: #123154;
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

.elearning-status--partial {
  background: #fff7e6;
  color: #8a5a00;
}

@media (max-width: 640px) {
  .elearning-admin {
    padding: 12px;
  }

  .elearning-question__row,
  .elearning-admin__actions {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
