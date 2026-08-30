<template>
  <section
    class="practice-learner"
    data-testid="elearning-practice-learner-section"
    aria-labelledby="elearning-practice-learner-title"
  >
    <header>
      <h2 id="elearning-practice-learner-title">{{ elearningLabel('practiceLearner.title', isZh) }}</h2>
      <p>{{ elearningLabel('practiceLearner.subtitle', isZh) }}</p>
    </header>

    <p v-if="loading">{{ elearningLabel('practiceLearner.loading', isZh) }}</p>
    <p v-else-if="sets.length === 0">{{ elearningLabel('practiceLearner.empty', isZh) }}</p>
    <form v-else class="practice-learner__start" @submit.prevent="void startSession()">
      <label>
        <span>{{ elearningLabel('practiceAdmin.available', isZh) }}</span>
        <select v-model="selectedSetId" data-testid="elearning-practice-set-select" :disabled="busy">
          <option value="">—</option>
          <option v-for="set in sets" :key="set.practiceSetId" :value="set.practiceSetId">
            {{ set.title }}
          </option>
        </select>
      </label>
      <label>
        <span>{{ elearningLabel('practiceLearner.mode', isZh) }}</span>
        <select v-model="mode" data-testid="elearning-practice-mode" :disabled="busy">
          <option value="sequential">{{ elearningLabel('practiceLearner.modeSequential', isZh) }}</option>
          <option value="random">{{ elearningLabel('practiceLearner.modeRandom', isZh) }}</option>
          <option value="wrong_book">{{ elearningLabel('practiceLearner.modeWrongBook', isZh) }}</option>
        </select>
      </label>
      <button type="submit" data-testid="elearning-practice-start" :disabled="busy">
        {{ busy
          ? elearningLabel('practiceLearner.starting', isZh)
          : elearningLabel('practiceLearner.start', isZh) }}
      </button>
    </form>

    <article v-if="currentQuestion" data-testid="elearning-practice-question">
      <h3>{{ currentQuestion.position }}. {{ currentQuestion.prompt }}</h3>
      <label v-for="option in currentQuestion.options" :key="option.id">
        <input
          :type="currentQuestion.questionType === 'multiple_choice' ? 'checkbox' : 'radio'"
          :name="`practice-${currentQuestion.questionRevisionId}`"
          :value="option.id"
          :checked="selectedOptionIds.includes(option.id)"
          :disabled="busy"
          @change="onOptionChange($event, option.id)"
        >
        <span>{{ option.text }}</span>
      </label>
      <button
        type="button"
        data-testid="elearning-practice-submit"
        :disabled="busy"
        @click="void submitAnswer()"
      >
        {{ busy
          ? elearningLabel('practiceLearner.submitting', isZh)
          : elearningLabel('practiceLearner.submit', isZh) }}
      </button>
    </article>

    <p
      v-if="status"
      data-testid="elearning-practice-learner-status"
      :class="{ 'practice-learner__error': statusTone === 'error' }"
      role="status"
    >
      {{ status }}
    </p>

    <section v-if="selectedSetId" class="practice-learner__wrong" aria-labelledby="wrong-book-title">
      <h3 id="wrong-book-title">{{ elearningLabel('practiceLearner.wrongBook', isZh) }}</h3>
      <p v-if="wrongQuestions.length === 0">{{ elearningLabel('practiceLearner.wrongBookEmpty', isZh) }}</p>
      <ol v-else data-testid="elearning-practice-wrong-list">
        <li v-for="question in wrongQuestions" :key="question.questionRevisionId">
          {{ question.prompt }}
        </li>
      </ol>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useLocale } from '../composables/useLocale'
import { ElearningApiError } from '../services/elearning'
import {
  createElearningPracticeRequestIds,
  listElearningPracticeSets,
  listElearningWrongQuestions,
  startElearningPracticeSession,
  submitElearningPracticeAnswer,
  type ElearningPracticeMode,
  type ElearningPracticeQuestion,
  type ElearningPracticeSession,
  type ElearningPracticeSet,
} from '../services/elearningPractice'
import { elearningFailure, elearningLabel } from './elearningLabels'

const { isZh } = useLocale()
const requestIds = createElearningPracticeRequestIds()
const sets = ref<ElearningPracticeSet[]>([])
const selectedSetId = ref('')
const mode = ref<ElearningPracticeMode>('sequential')
const session = ref<ElearningPracticeSession | null>(null)
const questionIndex = ref(0)
const selectedOptionIds = ref<string[]>([])
const wrongQuestions = ref<ElearningPracticeQuestion[]>([])
const loading = ref(true)
const busy = ref(false)
const status = ref('')
const statusTone = ref<'info' | 'error'>('info')

const currentQuestion = computed(() => session.value?.questions[questionIndex.value] ?? null)

function errorText(error: unknown): string {
  if (error instanceof ElearningApiError) {
    return elearningFailure(error.code, error.status, isZh.value)
  }
  return elearningFailure('request_failed', 0, isZh.value)
}

async function refreshWrong(): Promise<void> {
  const setId = selectedSetId.value
  if (!setId) {
    wrongQuestions.value = []
    return
  }
  const result = await listElearningWrongQuestions(setId)
  if (result.practiceSetId !== setId) throw new ElearningApiError('invalid_response', 200)
  wrongQuestions.value = result.questions
}

async function startSession(): Promise<void> {
  if (busy.value) return
  status.value = ''
  if (!selectedSetId.value) {
    statusTone.value = 'error'
    status.value = elearningLabel('validation.practiceSetRequired', isZh.value)
    return
  }
  busy.value = true
  try {
    session.value = await startElearningPracticeSession({
      requestId: requestIds.forSession(selectedSetId.value, mode.value),
      practiceSetId: selectedSetId.value,
      mode: mode.value,
    })
    questionIndex.value = 0
    selectedOptionIds.value = []
    statusTone.value = 'info'
    status.value = session.value.questions.length === 0
      ? elearningLabel('practiceLearner.finished', isZh.value)
      : ''
    await refreshWrong()
  } catch (error) {
    statusTone.value = 'error'
    status.value = errorText(error)
  } finally {
    busy.value = false
  }
}

function onOptionChange(event: Event, optionId: string): void {
  const target = event.target as HTMLInputElement
  const question = currentQuestion.value
  if (!question) return
  if (question.questionType !== 'multiple_choice') {
    selectedOptionIds.value = target.checked ? [optionId] : []
    return
  }
  const selected = new Set(selectedOptionIds.value)
  if (target.checked) selected.add(optionId)
  else selected.delete(optionId)
  selectedOptionIds.value = [...selected].sort()
}

async function submitAnswer(): Promise<void> {
  const activeSession = session.value
  const question = currentQuestion.value
  if (!activeSession || !question || busy.value) return
  if (selectedOptionIds.value.length === 0) {
    statusTone.value = 'error'
    status.value = elearningLabel('validation.practiceAnswerRequired', isZh.value)
    return
  }
  const selected = [...selectedOptionIds.value].sort()
  busy.value = true
  try {
    const result = await submitElearningPracticeAnswer(activeSession.sessionId, {
      requestId: requestIds.forAnswer(
        activeSession.sessionId,
        question.questionRevisionId,
        selected,
      ),
      questionRevisionId: question.questionRevisionId,
      selectedOptionIds: selected,
    })
    statusTone.value = 'info'
    status.value = result.wrongState === 'resolved'
      ? elearningLabel('practiceLearner.resolved', isZh.value)
      : result.correct
        ? elearningLabel('practiceLearner.correct', isZh.value)
        : elearningLabel('practiceLearner.wrong', isZh.value)
    if (result.wrongState !== 'unchanged') await refreshWrong()
    questionIndex.value += 1
    selectedOptionIds.value = []
    if (!currentQuestion.value) status.value = elearningLabel('practiceLearner.finished', isZh.value)
  } catch (error) {
    statusTone.value = 'error'
    status.value = errorText(error)
  } finally {
    busy.value = false
  }
}

watch(selectedSetId, () => {
  session.value = null
  questionIndex.value = 0
  selectedOptionIds.value = []
  void refreshWrong().catch((error) => {
    statusTone.value = 'error'
    status.value = errorText(error)
  })
})

onMounted(() => {
  void listElearningPracticeSets()
    .then((result) => {
      sets.value = result.practiceSets
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
.practice-learner {
  display: grid;
  gap: 12px;
  padding: 16px;
  border: 1px solid #cbd9e8;
  border-radius: 10px;
  background: #f8fbff;
}
.practice-learner h2,
.practice-learner h3,
.practice-learner p { margin: 0; }
.practice-learner__start { display: grid; gap: 10px; }
.practice-learner__start label,
.practice-learner article { display: grid; gap: 8px; }
.practice-learner select,
.practice-learner button { min-height: 36px; }
.practice-learner__wrong ol { display: grid; gap: 6px; }
.practice-learner__error { color: #b42318; }
</style>
