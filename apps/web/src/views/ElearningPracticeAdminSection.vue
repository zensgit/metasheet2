<template>
  <section
    class="practice-admin"
    data-testid="elearning-practice-admin-section"
    aria-labelledby="elearning-practice-admin-title"
  >
    <header>
      <h2 id="elearning-practice-admin-title">{{ elearningLabel('practiceAdmin.title', isZh) }}</h2>
      <p>{{ elearningLabel('practiceAdmin.subtitle', isZh) }}</p>
    </header>

    <form class="practice-admin__form" @submit.prevent="void createSet()">
      <label>
        <span>{{ elearningLabel('practiceAdmin.paperId', isZh) }}</span>
        <input
          v-model="paperId"
          data-testid="elearning-practice-paper-id"
          type="text"
          autocomplete="off"
          :disabled="busy"
        >
      </label>
      <label>
        <span>{{ elearningLabel('practiceAdmin.setTitle', isZh) }}</span>
        <input
          v-model="title"
          data-testid="elearning-practice-title"
          type="text"
          maxlength="200"
          autocomplete="off"
          :disabled="busy"
        >
      </label>
      <button type="submit" data-testid="elearning-practice-create" :disabled="busy">
        {{ busy
          ? elearningLabel('practiceAdmin.creating', isZh)
          : elearningLabel('practiceAdmin.create', isZh) }}
      </button>
    </form>

    <p
      v-if="status"
      data-testid="elearning-practice-admin-status"
      :class="{ 'practice-admin__error': statusTone === 'error' }"
      role="status"
    >
      {{ status }}
    </p>

    <h3>{{ elearningLabel('practiceAdmin.available', isZh) }}</h3>
    <p v-if="sets.length === 0">{{ elearningLabel('practiceAdmin.empty', isZh) }}</p>
    <ul v-else data-testid="elearning-practice-admin-list">
      <li v-for="set in sets" :key="set.practiceSetId">
        <strong>{{ set.title }}</strong>
        <code>{{ set.paperId }}</code>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useLocale } from '../composables/useLocale'
import { ElearningApiError } from '../services/elearning'
import {
  createElearningPracticeRequestIds,
  createElearningPracticeSet,
  listElearningPracticeSets,
  type ElearningPracticeSet,
} from '../services/elearningPractice'
import { elearningFailure, elearningLabel } from './elearningLabels'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const { isZh } = useLocale()
const requestIds = createElearningPracticeRequestIds()
const paperId = ref('')
const title = ref('')
const sets = ref<ElearningPracticeSet[]>([])
const busy = ref(false)
const status = ref('')
const statusTone = ref<'info' | 'error'>('info')

function errorText(error: unknown): string {
  if (error instanceof ElearningApiError) {
    return elearningFailure(error.code, error.status, isZh.value)
  }
  return elearningFailure('request_failed', 0, isZh.value)
}

async function refresh(): Promise<void> {
  const result = await listElearningPracticeSets()
  sets.value = result.practiceSets
}

async function createSet(): Promise<void> {
  if (busy.value) return
  status.value = ''
  const normalizedPaperId = paperId.value.trim().toLowerCase()
  const normalizedTitle = title.value.trim()
  if (!UUID_RE.test(normalizedPaperId)) {
    statusTone.value = 'error'
    status.value = elearningLabel('validation.practicePaperRequired', isZh.value)
    return
  }
  if (normalizedTitle === '') {
    statusTone.value = 'error'
    status.value = elearningLabel('validation.practiceTitleRequired', isZh.value)
    return
  }
  busy.value = true
  try {
    await createElearningPracticeSet({
      requestId: requestIds.forSet(normalizedPaperId, normalizedTitle),
      paperId: normalizedPaperId,
      title: normalizedTitle,
    })
    await refresh()
    statusTone.value = 'info'
    status.value = elearningLabel('practiceAdmin.created', isZh.value)
  } catch (error) {
    statusTone.value = 'error'
    status.value = errorText(error)
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  void refresh().catch((error) => {
    statusTone.value = 'error'
    status.value = errorText(error)
  })
})
</script>

<style scoped>
.practice-admin {
  display: grid;
  gap: 12px;
  padding: 16px;
  border: 1px solid #cbd9e8;
  border-radius: 10px;
  background: #f8fbff;
}
.practice-admin h2,
.practice-admin h3,
.practice-admin p { margin: 0; }
.practice-admin__form { display: grid; gap: 10px; }
.practice-admin__form label { display: grid; gap: 4px; }
.practice-admin__form input,
.practice-admin__form button { min-height: 36px; }
.practice-admin ul { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.practice-admin li { display: grid; gap: 4px; }
.practice-admin__error { color: #b42318; }
</style>
