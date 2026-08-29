<template>
  <section
    class="elearning-content-admin"
    data-testid="elearning-content-admin-section"
    aria-labelledby="elearning-content-admin-title"
  >
    <header>
      <h2 id="elearning-content-admin-title">{{ elearningLabel('contentAdmin.title', isZh) }}</h2>
      <p>{{ elearningLabel('contentAdmin.subtitle', isZh) }}</p>
    </header>

    <form class="elearning-content-admin__form" @submit.prevent="void publishCourse()">
      <label class="elearning-content-field">
        <span>{{ elearningLabel('contentAdmin.courseTitle', isZh) }}</span>
        <input
          v-model="courseTitle"
          data-testid="elearning-content-course-title"
          type="text"
          maxlength="200"
          :disabled="busy"
        >
      </label>

      <ol class="elearning-content-admin__items">
        <li
          v-for="(item, index) in items"
          :key="item.localId"
          class="elearning-content-admin__item"
          :data-testid="`elearning-content-admin-item-${index}`"
        >
          <strong>{{ item.itemType === 'article'
            ? elearningLabel('learner.contentArticle', isZh)
            : elearningLabel('learner.contentExternalLink', isZh) }}</strong>
          <label class="elearning-content-field">
            <span>{{ elearningLabel('contentAdmin.itemTitle', isZh) }}</span>
            <input
              v-model="item.title"
              :data-testid="`elearning-content-item-title-${index}`"
              type="text"
              maxlength="200"
              :disabled="busy"
            >
          </label>
          <label v-if="item.itemType === 'article'" class="elearning-content-field">
            <span>{{ elearningLabel('contentAdmin.articleBody', isZh) }}</span>
            <textarea
              v-model="item.articleHtml"
              :data-testid="`elearning-content-article-${index}`"
              rows="5"
              :disabled="busy"
            />
          </label>
          <label v-else class="elearning-content-field">
            <span>{{ elearningLabel('contentAdmin.externalUrl', isZh) }}</span>
            <input
              v-model="item.externalUrl"
              :data-testid="`elearning-content-link-${index}`"
              type="url"
              placeholder="https://"
              :disabled="busy"
            >
          </label>
          <div class="elearning-content-admin__item-actions">
            <button
              type="button"
              :disabled="busy || index === 0"
              :data-testid="`elearning-content-move-up-${index}`"
              @click="moveItem(index, -1)"
            >
              {{ elearningLabel('contentAdmin.moveUp', isZh) }}
            </button>
            <button
              type="button"
              :disabled="busy || index === items.length - 1"
              :data-testid="`elearning-content-move-down-${index}`"
              @click="moveItem(index, 1)"
            >
              {{ elearningLabel('contentAdmin.moveDown', isZh) }}
            </button>
            <button
              type="button"
              :disabled="busy"
              :data-testid="`elearning-content-remove-${index}`"
              @click="removeItem(index)"
            >
              {{ elearningLabel('contentAdmin.remove', isZh) }}
            </button>
          </div>
        </li>
      </ol>

      <div class="elearning-content-admin__actions">
        <button type="button" data-testid="elearning-content-add-article" :disabled="busy" @click="addItem('article')">
          {{ elearningLabel('contentAdmin.addArticle', isZh) }}
        </button>
        <button type="button" data-testid="elearning-content-add-link" :disabled="busy" @click="addItem('external_link')">
          {{ elearningLabel('contentAdmin.addLink', isZh) }}
        </button>
      </div>

      <label v-if="assignmentEnabled" class="elearning-content-field">
        <span>{{ elearningLabel('contentAdmin.optionalAssignee', isZh) }}</span>
        <input
          v-model="targetUserId"
          data-testid="elearning-content-target-user"
          type="text"
          :disabled="busy"
          autocomplete="off"
        >
      </label>

      <button
        class="elearning-content-admin__publish"
        data-testid="elearning-content-publish"
        type="submit"
        :disabled="busy"
      >
        {{ busy
          ? elearningLabel('contentAdmin.publishing', isZh)
          : elearningLabel('contentAdmin.publish', isZh) }}
      </button>
    </form>

    <p
      v-if="status"
      class="elearning-content-admin__status"
      :class="{ 'elearning-content-admin__status--error': statusTone === 'error', 'elearning-content-admin__status--partial': statusTone === 'partial' }"
      data-testid="elearning-content-admin-status"
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
import { assignElearningDirect, ElearningApiError } from '../services/elearning'
import {
  createElearningContentRequestIdTracker,
  createElearningContentRevision,
  publishElearningContentCourse,
  type ElearningContentItemType,
  type ElearningContentRevisionDraft,
} from '../services/elearningContent'
import {
  elearningAssignIncomplete,
  elearningFailure,
  elearningLabel,
} from './elearningLabels'

defineProps<{ assignmentEnabled: boolean }>()

interface ContentDraft {
  localId: string
  itemType: ElearningContentItemType
  title: string
  articleHtml: string
  externalUrl: string
}

const { isZh } = useLocale()
const requestIds = createElearningContentRequestIdTracker()
let localSerial = 0
const courseTitle = ref('')
const targetUserId = ref('')
const items = ref<ContentDraft[]>([newItem('article')])
const busy = ref(false)
const status = ref('')
const statusTone = ref<'info' | 'error' | 'partial'>('info')
const assignmentSourceKeys = new Map<string, string>()

function newItem(itemType: ElearningContentItemType): ContentDraft {
  localSerial += 1
  return {
    localId: `content-${localSerial}`,
    itemType,
    title: '',
    articleHtml: '',
    externalUrl: '',
  }
}

function newUuid(): string {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new ElearningApiError('request_failed', 0)
  }
  return crypto.randomUUID()
}

function formatError(error: unknown): string {
  if (error instanceof ElearningApiError) {
    return elearningFailure(error.code, error.status, isZh.value)
  }
  return elearningFailure('request_failed', 0, isZh.value)
}

function addItem(itemType: ElearningContentItemType): void {
  items.value.push(newItem(itemType))
}

function removeItem(index: number): void {
  items.value.splice(index, 1)
}

function moveItem(index: number, delta: -1 | 1): void {
  const target = index + delta
  if (target < 0 || target >= items.value.length) return
  const [item] = items.value.splice(index, 1)
  if (item) items.value.splice(target, 0, item)
}

function revisionDraft(item: ContentDraft): ElearningContentRevisionDraft {
  return item.itemType === 'article'
    ? {
        itemType: 'article',
        title: item.title.trim(),
        articleHtml: item.articleHtml,
        externalUrl: null,
      }
    : {
        itemType: 'external_link',
        title: item.title.trim(),
        articleHtml: null,
        externalUrl: item.externalUrl.trim(),
      }
}

function validationError(): string | null {
  const zh = isZh.value
  if (courseTitle.value.trim() === '') return elearningLabel('validation.titleRequired', zh)
  if (items.value.length === 0) return elearningLabel('validation.contentItemRequired', zh)
  for (const item of items.value) {
    if (item.title.trim() === '') return elearningLabel('validation.contentItemTitleRequired', zh)
    if (item.itemType === 'article' && item.articleHtml.trim() === '') {
      return elearningLabel('validation.articleBodyRequired', zh)
    }
    if (item.itemType === 'external_link' && item.externalUrl.trim() === '') {
      return elearningLabel('validation.externalUrlRequired', zh)
    }
  }
  return null
}

function assignmentSourceKey(courseVersionId: string): string {
  const existing = assignmentSourceKeys.get(courseVersionId)
  if (existing) return existing
  const created = newUuid()
  assignmentSourceKeys.set(courseVersionId, created)
  return created
}

async function publishCourse(): Promise<void> {
  if (busy.value) return
  status.value = ''
  const invalid = validationError()
  if (invalid) {
    statusTone.value = 'error'
    status.value = invalid
    return
  }
  busy.value = true
  try {
    const revisions = []
    for (const item of items.value) {
      const draft = revisionDraft(item)
      revisions.push(await createElearningContentRevision({
        requestId: requestIds.forRevision(item.localId, draft),
        ...draft,
      }))
    }
    const publishDraft = {
      title: courseTitle.value.trim(),
      items: revisions.map((revision) => ({
        itemType: revision.itemType,
        contentRevisionId: revision.contentRevisionId,
      })),
    }
    const published = await publishElearningContentCourse({
      requestId: requestIds.forPublish(publishDraft),
      ...publishDraft,
    })
    const target = targetUserId.value.trim()
    if (target !== '') {
      try {
        await assignElearningDirect({
          targetUserId: target,
          courseVersionId: published.courseVersionId,
          sourceKey: assignmentSourceKey(published.courseVersionId),
        })
        statusTone.value = 'info'
        status.value = elearningLabel('admin.assignSuccess', isZh.value)
        return
      } catch (error) {
        statusTone.value = 'partial'
        status.value = elearningAssignIncomplete(formatError(error), isZh.value)
        return
      }
    }
    statusTone.value = 'info'
    status.value = elearningLabel('contentAdmin.publishSuccess', isZh.value)
  } catch (error) {
    statusTone.value = 'error'
    status.value = formatError(error)
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.elearning-content-admin,
.elearning-content-admin__form,
.elearning-content-admin__items,
.elearning-content-admin__item,
.elearning-content-field {
  display: grid;
  gap: 10px;
}

.elearning-content-admin {
  border: 1px solid #dfe7f4;
  border-radius: 10px;
  padding: 14px;
  background: #f8fbff;
}

.elearning-content-admin h2,
.elearning-content-admin p {
  margin: 0;
}

.elearning-content-admin header p,
.elearning-content-field span {
  color: #5f7088;
  font-size: 0.9rem;
}

.elearning-content-admin__items {
  margin: 0;
  padding-left: 24px;
}

.elearning-content-admin__item {
  border: 1px solid #dfe7f4;
  border-radius: 8px;
  padding: 12px;
  background: #fff;
}

.elearning-content-field input,
.elearning-content-field textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 8px 10px;
  font: inherit;
}

.elearning-content-admin__actions,
.elearning-content-admin__item-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.elearning-content-admin button {
  border: 0;
  border-radius: 8px;
  padding: 8px 12px;
  background: #eef3fb;
  color: #123154;
  cursor: pointer;
}

.elearning-content-admin button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.elearning-content-admin__publish {
  justify-self: start;
  background: #2563eb !important;
  color: #fff !important;
}

.elearning-content-admin__status {
  padding: 10px 12px;
  border-radius: 8px;
  background: #eef7ff;
}

.elearning-content-admin__status--error {
  background: #fdecec;
  color: #9b1c1c;
}

.elearning-content-admin__status--partial {
  background: #fff7e6;
  color: #8a5a00;
}
</style>
