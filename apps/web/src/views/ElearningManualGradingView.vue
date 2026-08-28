<template>
  <section class="grading-view" aria-labelledby="grading-view-title">
    <header class="grading-view__header">
      <h1 id="grading-view-title">{{ elearningLabel('grading.title', isZh) }}</h1>
      <p>{{ elearningLabel('grading.subtitle', isZh) }}</p>
    </header>

    <ElearningManualGradingAttempt
      v-if="selectedAttemptId"
      :attempt-id="selectedAttemptId"
      @back="onBack"
      @graded="onGraded"
      @conflict="onConflict"
    />

    <template v-else>
      <div class="grading-view__toolbar">
        <button
          type="button"
          class="grading-btn grading-btn--secondary"
          data-testid="elearning-grading-refresh"
          :disabled="loading"
          @click="void loadQueue()"
        >
          {{ elearningLabel('grading.refresh', isZh) }}
        </button>
      </div>

      <p
        v-if="loading"
        class="grading-status"
        data-testid="elearning-grading-loading"
        role="status"
        aria-live="polite"
      >
        {{ elearningLabel('grading.loadingQueue', isZh) }}
      </p>
      <p
        v-else-if="closed"
        class="grading-status grading-status--error"
        data-testid="elearning-grading-closed"
        role="alert"
      >
        {{ closedMessage }}
      </p>
      <p
        v-else-if="errorMessage"
        class="grading-status grading-status--error"
        data-testid="elearning-grading-error"
        role="alert"
      >
        {{ errorMessage }}
      </p>
      <template v-else>
        <p
          v-if="reconciliationNotice"
          class="grading-status"
          data-testid="elearning-grading-reconciled"
          role="status"
          aria-live="polite"
        >
          {{ reconciliationNotice }}
        </p>
        <p
          v-if="items.length === 0"
          class="grading-status"
          data-testid="elearning-grading-empty"
          role="status"
        >
          {{ elearningLabel('grading.queueEmpty', isZh) }}
        </p>
        <table v-else class="grading-view__table" data-testid="elearning-grading-queue">
          <thead>
            <tr>
              <th>{{ elearningLabel('grading.columnLearner', isZh) }}</th>
              <th>{{ elearningLabel('grading.columnExam', isZh) }}</th>
              <th>{{ elearningLabel('grading.columnCourse', isZh) }}</th>
              <th>{{ elearningLabel('grading.columnSubmitted', isZh) }}</th>
              <th>{{ elearningLabel('grading.columnProgress', isZh) }}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="item in items"
              :key="item.attemptId"
              :data-testid="`elearning-grading-row-${item.attemptId}`"
            >
              <td>{{ item.userId }}</td>
              <td>{{ item.examTitle }}</td>
              <td>{{ item.courseTitle }}</td>
              <td>{{ item.submittedAt }}</td>
              <td>{{ elearningManualGradingProgressLabel(item.gradedQuestions, item.manualQuestions) }}</td>
              <td>
                <button
                  type="button"
                  class="grading-btn grading-btn--primary"
                  :data-testid="`elearning-grading-open-${item.attemptId}`"
                  @click="selectedAttemptId = item.attemptId"
                >
                  {{ elearningLabel('grading.openAttempt', isZh) }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>

        <div class="grading-view__pagination">
          <button
            type="button"
            class="grading-btn grading-btn--secondary"
            data-testid="elearning-grading-previous"
            :disabled="loading || page <= 1"
            @click="void changePage(-1)"
          >
            {{ elearningLabel('grading.previousPage', isZh) }}
          </button>
          <span data-testid="elearning-grading-page">{{ pageLabel }}</span>
          <button
            type="button"
            class="grading-btn grading-btn--secondary"
            data-testid="elearning-grading-next"
            :disabled="loading || !hasMore"
            @click="void changePage(1)"
          >
            {{ elearningLabel('grading.nextPage', isZh) }}
          </button>
        </div>
      </template>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useLocale } from '../composables/useLocale'
import { ElearningApiError } from '../services/elearning'
import {
  listElearningManualGradingQueue,
  type ElearningManualGradingQueueItem,
} from '../services/elearningManualGrading'
import ElearningManualGradingAttempt from './ElearningManualGradingAttempt.vue'
import {
  elearningLabel,
  elearningManualGradingErrorMessage,
  elearningManualGradingProgressLabel,
  elearningManualGradingQueuePageLabel,
} from './elearningLabels'

const { isZh } = useLocale()

const loading = ref(false)
const closed = ref(false)
const errorMessage = ref('')
const reconciliationNotice = ref('')
const items = ref<ElearningManualGradingQueueItem[]>([])
const page = ref(1)
const hasMore = ref(false)
const selectedAttemptId = ref<string | null>(null)

const pageLabel = computed(() => elearningManualGradingQueuePageLabel(page.value, isZh.value))
const closedMessage = computed(() => elearningManualGradingErrorMessage(404, 'not_found', isZh.value))

// Re-fetches with the SAME page by default so a post-grade refresh (onGraded)
// re-lands where the grader was. QUEUE_SQL filters on status = 'awaiting_manual',
// so finalizing the only attempt left on a page > 1 makes that page come back
// empty even though earlier pages still have rows — step back one page rather
// than showing a false "queue is empty" state.
async function loadQueue(targetPage = page.value, preserveNotice = false): Promise<void> {
  if (loading.value) return
  loading.value = true
  closed.value = false
  errorMessage.value = ''
  if (!preserveNotice) reconciliationNotice.value = ''
  try {
    const result = await listElearningManualGradingQueue(targetPage)
    if (result.items.length === 0 && result.page > 1) {
      loading.value = false
      await loadQueue(result.page - 1)
      return
    }
    items.value = result.items
    page.value = result.page
    hasMore.value = result.hasMore
  } catch (error) {
    items.value = []
    hasMore.value = false
    reconciliationNotice.value = ''
    if (error instanceof ElearningApiError && error.status === 404) {
      closed.value = true
    } else {
      errorMessage.value = elearningManualGradingErrorMessage(
        error instanceof ElearningApiError ? error.status : 0,
        error instanceof ElearningApiError ? error.code : 'request_failed',
        isZh.value,
      )
    }
  } finally {
    loading.value = false
  }
}

async function changePage(delta: -1 | 1): Promise<void> {
  const target = page.value + delta
  if (target < 1) return
  if (delta > 0 && !hasMore.value) return
  await loadQueue(target)
}

function onBack(): void {
  selectedAttemptId.value = null
}

function onGraded(): void {
  selectedAttemptId.value = null
  void loadQueue()
}

function onConflict(): void {
  selectedAttemptId.value = null
  reconciliationNotice.value = elearningLabel('grading.conflictRefreshNotice', isZh.value)
  void loadQueue(1, true)
}

onMounted(() => {
  void loadQueue()
})
</script>

<style scoped>
.grading-view {
  width: min(960px, 100%);
  margin: 0 auto;
  padding: 16px;
  display: grid;
  gap: 16px;
  color: #123154;
}

.grading-view__header h1 {
  margin: 0;
  font-size: 1.35rem;
}

.grading-view__header p {
  color: #5f7088;
  font-size: 0.9rem;
}

.grading-view__toolbar,
.grading-view__pagination {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.grading-view__pagination {
  justify-content: flex-end;
}

.grading-view__table {
  width: 100%;
  border-collapse: collapse;
  background: #fff;
}

.grading-view__table th,
.grading-view__table td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid #edf1f7;
  font-size: 0.9rem;
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

@media (max-width: 640px) {
  .grading-view__table {
    display: block;
    overflow-x: auto;
  }
}
</style>
