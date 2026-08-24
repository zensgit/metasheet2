<template>
  <section class="elearning-admin" aria-labelledby="elearning-admin-title">
    <header class="elearning-admin__header">
      <h1 id="elearning-admin-title">云课堂管理</h1>
      <p>上传一段 MP4、编写客观题后发布并直接指派给一名学员。</p>
    </header>

    <form class="elearning-admin__form" @submit.prevent="void submitPublishAndAssign()">
      <label class="elearning-field">
        <span>课程视频（MP4）</span>
        <input
          data-testid="elearning-admin-file"
          type="file"
          accept="video/mp4,.mp4"
          :disabled="busy || published !== null"
          @change="onFileChange"
        >
      </label>

      <label class="elearning-field">
        <span>课程标题</span>
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
        <legend>客观题</legend>
        <article
          v-for="(question, qIndex) in questions"
          :key="question.localId"
          class="elearning-question"
          :data-testid="`elearning-admin-question-${qIndex}`"
        >
          <div class="elearning-question__row">
            <label class="elearning-field">
              <span>题型</span>
              <select
                :value="question.questionType"
                :disabled="busy || published !== null"
                @change="onQuestionTypeEvent($event, qIndex)"
              >
                <option value="single_choice">单选</option>
                <option value="multiple_choice">多选</option>
                <option value="true_false">判断</option>
              </select>
            </label>
            <label class="elearning-field elearning-field--narrow">
              <span>分值</span>
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
              删除本题
            </button>
          </div>

          <label class="elearning-field">
            <span>题干</span>
            <textarea
              v-model="question.prompt"
              :data-testid="`elearning-admin-prompt-${qIndex}`"
              rows="2"
              required
              :disabled="busy || published !== null"
            />
          </label>

          <fieldset class="elearning-options">
            <legend>选项与正确答案</legend>
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
                :aria-label="`正确答案 ${option.id}`"
                @change="onCorrectEvent($event, qIndex, option.id)"
              >
              <input
                v-model="option.text"
                type="text"
                required
                :disabled="busy || published !== null || question.questionType === 'true_false'"
                :aria-label="`选项 ${oIndex + 1}`"
              >
              <button
                v-if="question.questionType !== 'true_false' && question.options.length > 2"
                type="button"
                class="elearning-btn elearning-btn--ghost"
                :disabled="busy || published !== null"
                @click="removeOption(qIndex, oIndex)"
              >
                删除选项
              </button>
            </label>
            <button
              v-if="question.questionType !== 'true_false'"
              type="button"
              class="elearning-btn elearning-btn--secondary"
              :disabled="busy || published !== null || question.options.length >= 20"
              @click="addOption(qIndex)"
            >
              添加选项
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
          添加题目
        </button>
      </fieldset>

      <div class="elearning-admin__grid">
        <label class="elearning-field">
          <span>及格分</span>
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
          <span>最大尝试次数</span>
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
          <span>指派对象（用户 ID）</span>
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
          <span>截止日期（可选）</span>
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
          {{ busy && published === null ? '正在发布…' : '发布并指派' }}
        </button>
        <button
          v-if="published !== null && !assigned"
          class="elearning-btn elearning-btn--primary"
          type="button"
          data-testid="elearning-admin-retry"
          :disabled="busy || !ready"
          @click="void retryAssign()"
        >
          {{ busy ? '正在重试指派…' : '重试指派' }}
        </button>
      </div>
    </form>

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
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  assignElearningDirect,
  ElearningApiError,
  getElearningCapabilities,
  isElearningV01Ready,
  publishElearningCourse,
  uploadElearningMedia,
  type ElearningCoursePublishResult,
  type ElearningDirectAssignmentRequest,
  type ElearningQuestionType,
} from '../services/elearning'

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

const TRUE_FALSE_OPTIONS: OptionDraft[] = [
  { id: 'true', text: '正确' },
  { id: 'false', text: '错误' },
]

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
const status = ref('')
const statusTone = ref<'info' | 'error' | 'partial'>('info')

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
    return `失败：${error.code}（${error.status}）`
  }
  return '失败：request_failed（0）'
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
    question.options = TRUE_FALSE_OPTIONS.map((option) => ({ ...option }))
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
  if (!file.value) return '请选择一个 MP4 文件。'
  if (title.value.trim() === '') return '请填写课程标题。'
  if (!Number.isSafeInteger(passScore.value) || passScore.value < 0) return '及格分须为非负整数。'
  if (!Number.isSafeInteger(maxAttempts.value) || maxAttempts.value < 1) return '最大尝试次数须为正整数。'
  if (targetUserId.value.trim() === '') return '请填写指派对象。'
  if (questions.value.length < 1) return '至少需要一道客观题。'
  let total = 0
  for (const question of questions.value) {
    if (question.prompt.trim() === '') return '请填写题干。'
    if (!Number.isSafeInteger(question.points) || question.points < 1) return '分值须为正整数。'
    if (question.questionType === 'true_false') {
      if (question.options.length !== 2) return '判断题必须恰好两个选项。'
    } else if (question.options.length < 2) {
      return '选择题至少需要两个选项。'
    }
    if (question.options.some((option) => option.text.trim() === '')) return '请填写全部选项。'
    if (question.correctOptionIds.length < 1) return '请选择正确答案。'
    if (question.questionType !== 'multiple_choice' && question.correctOptionIds.length !== 1) {
      return '单选和判断题只能有一个正确答案。'
    }
    total += question.points
  }
  if (passScore.value > total) return '及格分不能大于总分。'
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
  if (!isElearningV01Ready(capabilities)) {
    throw new ElearningApiError('feature_disabled', 404)
  }
  ready.value = true
}

async function runAssign(): Promise<boolean> {
  const payload = frozenAssignment.value
  if (!payload) return false
  try {
    await assignElearningDirect(payload)
    assigned.value = true
    statusTone.value = 'info'
    status.value = '课程已发布并完成指派。'
    return true
  } catch (error) {
    assigned.value = false
    statusTone.value = 'partial'
    status.value = `课程已发布，指派未完成。${formatError(error)} 可重试指派，无需重新发布。`
    return false
  }
}

async function submitPublishAndAssign(): Promise<void> {
  if (busy.value || published.value || !ready.value) return
  status.value = ''
  const invalid = validateForm()
  if (invalid) {
    statusTone.value = 'error'
    status.value = invalid
    return
  }
  const selected = file.value
  if (!selected) return
  busy.value = true
  try {
    const media = await uploadElearningMedia(selected)
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
    await runAssign()
  } catch (error) {
    statusTone.value = 'error'
    status.value = formatError(error)
  } finally {
    busy.value = false
  }
}

async function retryAssign(): Promise<void> {
  const current = published.value
  if (!current || assigned.value || busy.value || !ready.value || frozenAssignment.value == null) return
  busy.value = true
  try {
    await runAssign()
  } finally {
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
.elearning-admin__actions {
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
