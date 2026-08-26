<template>
  <section class="assessment-admin" aria-labelledby="assessment-admin-title">
    <header class="assessment-admin__header">
      <div>
        <h2 id="assessment-admin-title">{{ elearningLabel('assessment.title', isZh) }}</h2>
        <p>{{ elearningLabel('assessment.subtitle', isZh) }}</p>
      </div>
      <button
        type="button"
        class="assessment-btn assessment-btn--secondary"
        :disabled="busy || !ready"
        data-testid="elearning-assessment-refresh"
        @click="void refreshBanks()"
      >
        {{ elearningLabel('assessment.refresh', isZh) }}
      </button>
    </header>

    <p
      v-if="loading"
      class="assessment-status"
      data-testid="elearning-assessment-loading"
      role="status"
    >
      {{ elearningLabel('assessment.loading', isZh) }}
    </p>

    <template v-if="ready">
      <div class="assessment-card">
        <form class="assessment-row" @submit.prevent="void createBank()">
          <label class="assessment-field assessment-field--grow">
            <span>{{ elearningLabel('assessment.bankTitle', isZh) }}</span>
            <input
              v-model="newBankTitle"
              data-testid="elearning-assessment-bank-title"
              type="text"
              maxlength="200"
              :disabled="busy || pipelineFrozen"
              autocomplete="off"
            >
          </label>
          <button
            type="submit"
            class="assessment-btn assessment-btn--primary"
            :disabled="busy || pipelineFrozen"
            data-testid="elearning-assessment-create-bank"
          >
            {{ elearningLabel('assessment.createBank', isZh) }}
          </button>
        </form>

        <label v-if="banks.length > 0" class="assessment-field">
          <span>{{ elearningLabel('assessment.bankSelect', isZh) }}</span>
          <select
            v-model="selectedBankId"
            data-testid="elearning-assessment-bank-select"
            :disabled="busy || pipelineFrozen"
            @change="void selectBank()"
          >
            <option v-for="bank in banks" :key="bank.bankId" :value="bank.bankId">
              {{ bank.title }} ({{ bank.questionCount }})
            </option>
          </select>
        </label>
        <p v-else class="assessment-muted">{{ elearningLabel('assessment.noBanks', isZh) }}</p>

        <form class="assessment-row" @submit.prevent="void importQuestions()">
          <label class="assessment-field assessment-field--grow">
            <span>{{ elearningLabel('assessment.importFile', isZh) }}</span>
            <input
              data-testid="elearning-assessment-xlsx"
              type="file"
              accept="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx"
              :disabled="busy || pipelineFrozen || !selectedBankId"
              @change="onXlsxFileChange"
            >
          </label>
          <button
            type="submit"
            class="assessment-btn assessment-btn--primary"
            :disabled="busy || pipelineFrozen || !selectedBankId"
            data-testid="elearning-assessment-import"
          >
            {{ elearningLabel('assessment.import', isZh) }}
          </button>
        </form>
      </div>

      <fieldset class="assessment-card" :disabled="busy || pipelineFrozen || !selectedBankId">
        <legend>{{ elearningLabel('assessment.questions', isZh) }}</legend>
        <p v-if="questions.length === 0" class="assessment-muted">
          {{ elearningLabel('assessment.noQuestions', isZh) }}
        </p>
        <label
          v-for="question in questions"
          :key="question.questionRevisionId"
          class="assessment-question"
          :data-testid="`elearning-assessment-question-${question.questionRevisionId}`"
        >
          <input
            v-model="selectedQuestionRevisionIds"
            type="checkbox"
            :value="question.questionRevisionId"
          >
          <span class="assessment-question__body">
            <span class="assessment-question__heading">
              <strong>{{ question.prompt }}</strong>
              <span>{{ questionTypeLabel(question.questionType) }}</span>
              <span>{{ elearningAssessmentRevision(question.revision, isZh) }}</span>
              <span>{{ elearningQuestionPoints(question.points, isZh) }}</span>
            </span>
            <span>
              {{ elearningLabel('assessment.correctAnswers', isZh) }}:
              {{ question.correctOptionIds.join(', ') }}
            </span>
            <span v-if="question.explanation">
              {{ elearningLabel('assessment.explanation', isZh) }}: {{ question.explanation }}
            </span>
          </span>
        </label>
      </fieldset>

      <form class="assessment-card assessment-form" @submit.prevent="void publishPaper()">
        <label class="assessment-field">
          <span>{{ elearningLabel('assessment.paperTitle', isZh) }}</span>
          <input
            v-model="paperTitle"
            data-testid="elearning-assessment-paper-title"
            type="text"
            maxlength="200"
            :disabled="busy || pipelineFrozen"
            autocomplete="off"
          >
        </label>
        <button
          type="submit"
          class="assessment-btn assessment-btn--primary"
          :disabled="busy || pipelineFrozen || selectedQuestionRevisionIds.length === 0"
          data-testid="elearning-assessment-publish-paper"
        >
          {{ elearningLabel('assessment.publishPaper', isZh) }}
        </button>
      </form>

      <form
        v-if="publishedPaper"
        class="assessment-card assessment-form"
        @submit.prevent="void publishExam()"
      >
        <label class="assessment-field">
          <span>{{ elearningLabel('assessment.examTitle', isZh) }}</span>
          <input
            v-model="examTitle"
            data-testid="elearning-assessment-exam-title"
            type="text"
            maxlength="200"
            :disabled="busy || publishedExam !== null"
            autocomplete="off"
          >
        </label>

        <div class="assessment-grid">
          <label class="assessment-field">
            <span>{{ elearningLabel('admin.passScore', isZh) }}</span>
            <input
              v-model.number="passScore"
              data-testid="elearning-assessment-pass-score"
              type="number"
              min="0"
              step="1"
              :max="publishedPaper.totalPoints"
              :disabled="busy || publishedExam !== null"
            >
          </label>
          <label class="assessment-field">
            <span>{{ elearningLabel('admin.maxAttempts', isZh) }}</span>
            <input
              v-model.number="maxAttempts"
              data-testid="elearning-assessment-max-attempts"
              type="number"
              min="1"
              step="1"
              :disabled="busy || publishedExam !== null"
            >
          </label>
          <label class="assessment-field">
            <span>{{ elearningLabel('assessment.duration', isZh) }}</span>
            <input
              v-model.number="durationMinutes"
              data-testid="elearning-assessment-duration"
              type="number"
              min="1"
              step="1"
              :disabled="busy || publishedExam !== null"
            >
          </label>
          <label class="assessment-field">
            <span>{{ elearningLabel('assessment.disclosure', isZh) }}</span>
            <select
              v-model="disclosurePolicy"
              data-testid="elearning-assessment-disclosure"
              :disabled="busy || publishedExam !== null"
            >
              <option value="no_review">{{ elearningLabel('assessment.disclosureNoReview', isZh) }}</option>
              <option value="correctness_after_submit">{{ elearningLabel('assessment.disclosureCorrectness', isZh) }}</option>
              <option value="wrong_items_after_submit">{{ elearningLabel('assessment.disclosureWrongItems', isZh) }}</option>
            </select>
          </label>
        </div>

        <div class="assessment-row assessment-row--start">
          <label class="assessment-check">
            <input v-model="shuffleQuestions" type="checkbox" :disabled="busy || publishedExam !== null">
            <span>{{ elearningLabel('assessment.shuffleQuestions', isZh) }}</span>
          </label>
          <label class="assessment-check">
            <input v-model="shuffleOptions" type="checkbox" :disabled="busy || publishedExam !== null">
            <span>{{ elearningLabel('assessment.shuffleOptions', isZh) }}</span>
          </label>
        </div>

        <div class="assessment-row assessment-row--start">
          <button
            type="submit"
            class="assessment-btn assessment-btn--primary"
            :disabled="busy || publishedExam !== null"
            data-testid="elearning-assessment-publish-exam"
          >
            {{ elearningLabel('assessment.publishExam', isZh) }}
          </button>
          <button
            type="button"
            class="assessment-btn assessment-btn--secondary"
            :disabled="busy"
            data-testid="elearning-assessment-reset"
            @click="resetPaperFlow"
          >
            {{ elearningLabel('assessment.startAnother', isZh) }}
          </button>
        </div>
      </form>

      <p
        v-if="publishedExam"
        class="assessment-boundary"
        data-testid="elearning-assessment-unbound"
        role="status"
      >
        {{ elearningLabel('assessment.unbound', isZh) }}
      </p>
    </template>

    <p
      v-if="status"
      class="assessment-status"
      :class="{ 'assessment-status--error': statusTone === 'error' }"
      data-testid="elearning-assessment-status"
      role="status"
      aria-live="polite"
    >
      {{ status }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useLocale } from '../composables/useLocale'
import {
  ElearningApiError,
  getElearningCapabilities,
  type ElearningQuestionType,
} from '../services/elearning'
import {
  createElearningQuestionBank,
  importElearningQuestionBankXlsx,
  isElearningAssessmentAdminReady,
  listElearningBankQuestions,
  listElearningQuestionBanks,
  publishElearningFixedPaper,
  publishElearningPaperExam,
  type ElearningAdminQuestionRevision,
  type ElearningExamDisclosurePolicy,
  type ElearningFixedPaperResult,
  type ElearningPaperExamResult,
  type ElearningQuestionBankListItem,
} from '../services/elearningAssessmentAdmin'
import {
  elearningAssessmentExamPublished,
  elearningAssessmentImported,
  elearningAssessmentPaperPublished,
  elearningAssessmentRevision,
  elearningFailure,
  elearningLabel,
  elearningQuestionPoints,
} from './elearningLabels'

type BusyAction = 'loading' | 'create_bank' | 'load_questions' | 'import' | 'paper' | 'exam'

const { isZh } = useLocale()
const ready = ref(false)
const busyAction = ref<BusyAction | null>('loading')
const status = ref('')
const statusTone = ref<'info' | 'error'>('info')
const banks = ref<ElearningQuestionBankListItem[]>([])
const selectedBankId = ref('')
const newBankTitle = ref('')
const xlsxFile = ref<File | null>(null)
const questions = ref<ElearningAdminQuestionRevision[]>([])
const selectedQuestionRevisionIds = ref<string[]>([])
const paperTitle = ref('')
const publishedPaper = ref<ElearningFixedPaperResult | null>(null)
const examTitle = ref('')
const passScore = ref(1)
const maxAttempts = ref(1)
const durationMinutes = ref<number | ''>('')
const shuffleQuestions = ref(false)
const shuffleOptions = ref(false)
const disclosurePolicy = ref<ElearningExamDisclosurePolicy>('correctness_after_submit')
const publishedExam = ref<ElearningPaperExamResult | null>(null)

const loading = computed(() => busyAction.value === 'loading')
const busy = computed(() => busyAction.value !== null)
const pipelineFrozen = computed(() => publishedPaper.value !== null)

function formatError(error: unknown): string {
  if (error instanceof ElearningApiError) {
    return elearningFailure(error.code, error.status, isZh.value)
  }
  return elearningFailure('request_failed', 0, isZh.value)
}

function showValidation(key: Parameters<typeof elearningLabel>[0]): void {
  statusTone.value = 'error'
  status.value = elearningLabel(key, isZh.value)
}

async function runAction(action: BusyAction, operation: () => Promise<void>): Promise<boolean> {
  if (busy.value) return false
  busyAction.value = action
  status.value = ''
  try {
    await operation()
    return true
  } catch (error) {
    statusTone.value = 'error'
    status.value = formatError(error)
    return false
  } finally {
    busyAction.value = null
  }
}

async function loadQuestions(): Promise<void> {
  selectedQuestionRevisionIds.value = []
  questions.value = []
  if (!selectedBankId.value) return
  const result = await listElearningBankQuestions(selectedBankId.value, 1, 100)
  questions.value = result.items
}

async function loadBanks(preferredBankId?: string): Promise<void> {
  const result = await listElearningQuestionBanks(1, 100)
  banks.value = result.items
  const preferred = preferredBankId ?? selectedBankId.value
  selectedBankId.value = preferred && result.items.some((bank) => bank.bankId === preferred)
    ? preferred
    : (result.items[0]?.bankId ?? '')
  await loadQuestions()
}

async function refreshBanks(): Promise<void> {
  if (!ready.value || pipelineFrozen.value) return
  await runAction('load_questions', () => loadBanks())
}

async function selectBank(): Promise<void> {
  if (!ready.value || pipelineFrozen.value) return
  await runAction('load_questions', loadQuestions)
}

async function createBank(): Promise<void> {
  if (!ready.value || pipelineFrozen.value) return
  const title = newBankTitle.value.trim()
  if (!title) {
    showValidation('validation.bankTitleRequired')
    return
  }
  await runAction('create_bank', async () => {
    const result = await createElearningQuestionBank(title)
    newBankTitle.value = ''
    await loadBanks(result.bankId)
  })
}

function onXlsxFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  xlsxFile.value = input.files && input.files[0] ? input.files[0] : null
}

async function importQuestions(): Promise<void> {
  if (!ready.value || pipelineFrozen.value) return
  if (!selectedBankId.value) {
    showValidation('validation.bankRequired')
    return
  }
  const file = xlsxFile.value
  if (!file) {
    showValidation('validation.xlsxRequired')
    return
  }
  await runAction('import', async () => {
    const result = await importElearningQuestionBankXlsx(selectedBankId.value, file)
    await loadQuestions()
    statusTone.value = 'info'
    status.value = elearningAssessmentImported(result.importedCount, isZh.value)
  })
}

async function publishPaper(): Promise<void> {
  if (!ready.value || pipelineFrozen.value) return
  const title = paperTitle.value.trim()
  if (!title) {
    showValidation('validation.paperTitleRequired')
    return
  }
  if (selectedQuestionRevisionIds.value.length < 1) {
    showValidation('validation.questionSelectionRequired')
    return
  }
  const byId = new Map(questions.value.map((question) => [question.questionRevisionId, question]))
  const items = selectedQuestionRevisionIds.value.map((questionRevisionId) => {
    const question = byId.get(questionRevisionId)
    if (!question) throw new ElearningApiError('invalid_input', 400)
    return { questionRevisionId, points: question.points }
  })
  await runAction('paper', async () => {
    const result = await publishElearningFixedPaper({ title, items })
    publishedPaper.value = result
    examTitle.value = examTitle.value.trim() || title
    passScore.value = Math.min(passScore.value, result.totalPoints)
    statusTone.value = 'info'
    status.value = elearningAssessmentPaperPublished(result.itemCount, result.totalPoints, isZh.value)
  })
}

function readDurationSeconds(): number | null {
  if (durationMinutes.value === '') return null
  if (!Number.isSafeInteger(durationMinutes.value) || durationMinutes.value < 1) {
    throw new ElearningApiError('invalid_duration', 400)
  }
  return durationMinutes.value * 60
}

async function publishExam(): Promise<void> {
  const paper = publishedPaper.value
  if (!ready.value || !paper || publishedExam.value) return
  const title = examTitle.value.trim()
  if (!title) {
    showValidation('validation.examTitleRequired')
    return
  }
  if (!Number.isSafeInteger(passScore.value) || passScore.value < 0) {
    showValidation('validation.passScoreInteger')
    return
  }
  if (passScore.value > paper.totalPoints) {
    showValidation('validation.passScoreTooHigh')
    return
  }
  if (!Number.isSafeInteger(maxAttempts.value) || maxAttempts.value < 1) {
    showValidation('validation.maxAttemptsInteger')
    return
  }
  let durationSeconds: number | null
  try {
    durationSeconds = readDurationSeconds()
  } catch {
    showValidation('validation.durationInteger')
    return
  }
  await runAction('exam', async () => {
    const result = await publishElearningPaperExam({
      paperId: paper.paperId,
      title,
      passScore: passScore.value,
      maxAttempts: maxAttempts.value,
      windowStartsAt: null,
      windowEndsAt: null,
      durationSeconds,
      shuffleQuestions: shuffleQuestions.value,
      shuffleOptions: shuffleOptions.value,
      disclosurePolicy: disclosurePolicy.value,
    })
    publishedExam.value = result
    statusTone.value = 'info'
    status.value = elearningAssessmentExamPublished(result.totalPoints, isZh.value)
  })
}

function resetPaperFlow(): void {
  if (busy.value) return
  publishedPaper.value = null
  publishedExam.value = null
  selectedQuestionRevisionIds.value = []
  paperTitle.value = ''
  examTitle.value = ''
  passScore.value = 1
  maxAttempts.value = 1
  durationMinutes.value = ''
  shuffleQuestions.value = false
  shuffleOptions.value = false
  disclosurePolicy.value = 'correctness_after_submit'
  status.value = ''
}

function questionTypeLabel(type: ElearningQuestionType): string {
  if (type === 'single_choice') return elearningLabel('admin.questionTypeSingle', isZh.value)
  if (type === 'multiple_choice') return elearningLabel('admin.questionTypeMultiple', isZh.value)
  return elearningLabel('admin.questionTypeTrueFalse', isZh.value)
}

onMounted(() => {
  void (async () => {
    try {
      const capabilities = await getElearningCapabilities()
      if (!isElearningAssessmentAdminReady(capabilities)) {
        throw new ElearningApiError('feature_disabled', 404)
      }
      ready.value = true
      await loadBanks()
    } catch (error) {
      ready.value = false
      statusTone.value = 'error'
      status.value = formatError(error)
    } finally {
      busyAction.value = null
    }
  })()
})
</script>

<style scoped>
.assessment-admin {
  display: grid;
  gap: 14px;
  padding: 16px;
  border: 1px solid #cbd8eb;
  border-radius: 12px;
  background: #f8fbff;
}

.assessment-admin__header,
.assessment-row,
.assessment-question__heading {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: end;
}

.assessment-admin__header {
  justify-content: space-between;
  align-items: start;
}

.assessment-admin__header h2,
.assessment-admin__header p,
.assessment-muted,
.assessment-status,
.assessment-boundary {
  margin: 0;
}

.assessment-admin__header h2 {
  font-size: 1.15rem;
}

.assessment-admin__header p,
.assessment-muted,
.assessment-field span,
.assessment-question__body {
  color: #5f7088;
  font-size: 0.9rem;
}

.assessment-card,
.assessment-form,
.assessment-field,
.assessment-question__body {
  display: grid;
  gap: 10px;
}

.assessment-card {
  margin: 0;
  padding: 12px;
  border: 1px solid #dfe7f4;
  border-radius: 10px;
  background: #fff;
}

.assessment-field--grow {
  flex: 1 1 280px;
}

.assessment-field input,
.assessment-field select {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 8px 10px;
  font: inherit;
}

.assessment-grid {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
}

.assessment-question {
  display: flex;
  gap: 10px;
  align-items: start;
  padding: 10px;
  border: 1px solid #edf1f7;
  border-radius: 8px;
}

.assessment-question__body {
  flex: 1;
}

.assessment-question__heading {
  align-items: center;
}

.assessment-question__heading strong {
  color: #123154;
}

.assessment-check {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}

.assessment-row--start {
  align-items: center;
}

.assessment-btn {
  border: 0;
  border-radius: 8px;
  padding: 8px 12px;
  font: inherit;
  cursor: pointer;
}

.assessment-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.assessment-btn--primary {
  background: #2563eb;
  color: #fff;
}

.assessment-btn--secondary {
  background: #e8eef8;
  color: #123154;
}

.assessment-status,
.assessment-boundary {
  padding: 10px 12px;
  border-radius: 8px;
  background: #eef7ff;
}

.assessment-status--error {
  background: #fdecec;
  color: #9b1c1c;
}

.assessment-boundary {
  background: #fff7e6;
  color: #7a5100;
  font-weight: 600;
}

@media (max-width: 640px) {
  .assessment-admin__header,
  .assessment-row {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
