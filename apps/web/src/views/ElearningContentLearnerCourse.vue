<template>
  <section class="elearning-content-course" :aria-label="elearningLabel('learner.contentItems', isZh)">
    <h3>{{ elearningLabel('learner.contentItems', isZh) }}</h3>
    <ol class="elearning-content-course__items">
      <li
        v-for="(item, index) in course.items"
        :key="item.itemId"
        class="elearning-content-course__item"
        :data-testid="`elearning-content-learner-item-${index}`"
      >
        <div class="elearning-content-course__heading">
          <strong>{{ item.title }}</strong>
          <span>{{ item.itemType === 'article'
            ? elearningLabel('learner.contentArticle', isZh)
            : elearningLabel('learner.contentExternalLink', isZh) }}</span>
          <span>{{ item.status === 'completed'
            ? elearningLabel('status.completed', isZh)
            : elearningLabel('video.notStarted', isZh) }}</span>
        </div>

        <button
          type="button"
          :data-testid="`elearning-content-open-${index}`"
          :disabled="openingItemId !== null"
          @click="void openItem(item)"
        >
          {{ openingItemId === item.itemId
            ? elearningLabel('learner.contentOpening', isZh)
            : elearningLabel('learner.contentOpen', isZh) }}
        </button>

        <!-- Only the closed open-item client result reaches this script-disabled sandbox. Draft HTML is never rendered. -->
        <iframe
          v-if="opened[item.itemId]?.itemType === 'article'"
          class="elearning-content-course__article"
          :data-testid="`elearning-content-article-rendered-${index}`"
          :title="item.title"
          :srcdoc="opened[item.itemId]?.articleHtml || ''"
          sandbox=""
          referrerpolicy="no-referrer"
        />
        <a
          v-else-if="opened[item.itemId]?.itemType === 'external_link'"
          :href="opened[item.itemId]?.externalUrl || undefined"
          target="_blank"
          rel="noopener noreferrer"
          :data-testid="`elearning-content-external-link-${index}`"
        >
          {{ elearningLabel('learner.contentOpenLink', isZh) }}
        </a>
      </li>
    </ol>

    <p
      v-if="status"
      class="elearning-content-course__status"
      :class="{ 'elearning-content-course__status--error': statusTone === 'error' }"
      data-testid="elearning-content-learner-status"
      role="status"
      aria-live="polite"
    >
      {{ status }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useLocale } from '../composables/useLocale'
import {
  ElearningApiError,
  type ElearningLearnerContentCourse,
  type ElearningLearnerContentItem,
} from '../services/elearning'
import {
  createElearningContentRequestIdTracker,
  openElearningContentItem,
  type ElearningContentOpenResult,
} from '../services/elearningContent'
import { elearningFailure, elearningLabel } from './elearningLabels'

const props = defineProps<{ course: ElearningLearnerContentCourse }>()
const emit = defineEmits<{ completed: [] }>()
const { isZh } = useLocale()
const requestIds = createElearningContentRequestIdTracker()
const opened = ref<Record<string, ElearningContentOpenResult>>({})
const openingItemId = ref<string | null>(null)
const status = ref('')
const statusTone = ref<'info' | 'error'>('info')

function formatError(error: unknown): string {
  if (error instanceof ElearningApiError) {
    return elearningFailure(error.code, error.status, isZh.value)
  }
  return elearningFailure('request_failed', 0, isZh.value)
}

async function openItem(item: ElearningLearnerContentItem): Promise<void> {
  if (openingItemId.value !== null) return
  status.value = ''
  openingItemId.value = item.itemId
  try {
    const result = await openElearningContentItem(
      item.itemId,
      requestIds.forOpen(item.itemId),
    )
    if (
      result.itemId !== item.itemId
      || result.itemType !== item.itemType
      || !props.course.items.some((candidate) => candidate.itemId === result.itemId)
    ) {
      throw new ElearningApiError('invalid_response', 200)
    }
    opened.value = { ...opened.value, [item.itemId]: result }
    statusTone.value = 'info'
    status.value = elearningLabel('learner.contentOpened', isZh.value)
    emit('completed')
  } catch (error) {
    statusTone.value = 'error'
    status.value = formatError(error)
  } finally {
    openingItemId.value = null
  }
}
</script>

<style scoped>
.elearning-content-course,
.elearning-content-course__items,
.elearning-content-course__item {
  display: grid;
  gap: 10px;
}

.elearning-content-course h3,
.elearning-content-course__items,
.elearning-content-course__status {
  margin: 0;
}

.elearning-content-course__items {
  padding-left: 24px;
}

.elearning-content-course__item {
  border-top: 1px solid #dfe7f4;
  padding-top: 10px;
}

.elearning-content-course__heading {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
}

.elearning-content-course__heading span {
  color: #5f7088;
  font-size: 0.85rem;
}

.elearning-content-course button {
  justify-self: start;
  border: 0;
  border-radius: 8px;
  padding: 8px 12px;
  background: #2563eb;
  color: #fff;
  cursor: pointer;
}

.elearning-content-course button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.elearning-content-course__article {
  width: 100%;
  min-height: 180px;
  border: 1px solid #dfe7f4;
  border-radius: 8px;
  overflow-wrap: anywhere;
}

.elearning-content-course__status {
  padding: 10px 12px;
  border-radius: 8px;
  background: #eef7ff;
}

.elearning-content-course__status--error {
  background: #fdecec;
  color: #9b1c1c;
}
</style>
