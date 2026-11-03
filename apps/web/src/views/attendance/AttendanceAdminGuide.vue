<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  ATTENDANCE_GUIDE_SECTIONS,
  attendanceGuideGroups,
  attendanceGuideTopicForSection,
  attendanceGuideTopicText,
  attendanceGuideTopics,
  type GuideTopic,
} from './attendanceAdminGuideContent'

type Translate = (en: string, zh: string) => string

const props = defineProps<{
  tr: Translate
  activeSectionId?: string
}>()

const emit = defineEmits<{
  'select-section': [id: string]
}>()

const topicId = ref('overview')
const query = ref('')
const root = ref<HTMLDetailsElement | null>(null)
const articleEl = ref<HTMLElement | null>(null)

const filteredTopics = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return attendanceGuideTopics
  return attendanceGuideTopics.filter(topic => attendanceGuideTopicText(topic).includes(needle))
})

const visibleGroups = computed(() => {
  const allowed = new Set(filteredTopics.value.map(topic => topic.id))
  return attendanceGuideGroups
    .map(group => ({
      ...group,
      topics: group.topicIds
        .map(id => attendanceGuideTopics.find(topic => topic.id === id))
        .filter((topic): topic is GuideTopic => Boolean(topic && allowed.has(topic.id))),
    }))
    .filter(group => group.topics.length > 0)
})

watch(query, () => {
  if (filteredTopics.value.some(topic => topic.id === topicId.value)) return
  if (filteredTopics.value[0]) topicId.value = filteredTopics.value[0].id
})

watch(() => props.activeSectionId, (sectionId) => {
  topicId.value = attendanceGuideTopicForSection(sectionId)
}, { immediate: true })

const active = computed(() => attendanceGuideTopics.find(topic => topic.id === topicId.value) ?? attendanceGuideTopics[0])

function closeHelp(): void {
  if (root.value) root.value.open = false
}

function openSection(): void {
  const sectionId = active.value?.sectionId
  if (sectionId) emit('select-section', sectionId)
}

function showSection(id: string): void {
  const node = articleEl.value?.querySelector<HTMLElement>(`[data-attendance-guide-section="${id}"]`)
  node?.scrollIntoView({ block: 'start' })
}
</script>

<template>
  <details ref="root" class="admin-guide" data-attendance-admin-guide>
    <summary>{{ tr('Attendance help', '考勤帮助') }}</summary>
    <div class="admin-guide__shell" data-attendance-guide-page>
      <header class="admin-guide__bar">
        <strong>{{ tr('Attendance help', '考勤帮助') }}</strong>
        <input
          v-model="query"
          class="admin-guide__search"
          type="search"
          data-attendance-guide-search
          :placeholder="tr('Search keywords', '输入关键字搜索')"
          :aria-label="tr('Search keywords', '输入关键字搜索')"
        />
        <button class="admin-guide__close" type="button" @click="closeHelp">
          {{ tr('Close', '关闭') }}
        </button>
      </header>
      <div class="admin-guide__panel">
        <nav class="admin-guide__topics" :aria-label="tr('All articles', '全部文章')">
          <p class="admin-guide__toc-label">{{ tr('All articles', '全部文章') }}</p>
          <div
            v-for="group in visibleGroups"
            :key="group.id"
            class="admin-guide__group"
            :data-attendance-guide-group="group.id"
          >
            <p class="admin-guide__group-label">{{ tr(group.labelEn, group.labelZh) }}</p>
            <button
              v-for="topic in group.topics"
              :key="topic.id"
              type="button"
              class="admin-guide__topic"
              :class="{ 'admin-guide__topic--active': topic.id === active?.id }"
              :aria-current="topic.id === active?.id ? 'page' : undefined"
              :data-attendance-guide-topic="topic.id"
              @click="topicId = topic.id"
            >
              {{ tr(topic.labelEn, topic.labelZh) }}
            </button>
          </div>
          <p v-if="visibleGroups.length === 0" class="admin-guide__empty">
            {{ tr('No help topics match.', '没有匹配的帮助。') }}
          </p>
        </nav>
        <article
          v-if="active"
          ref="articleEl"
          class="admin-guide__article"
          :data-attendance-guide-article="active.id"
        >
          <h1>{{ tr(active.labelEn, active.labelZh) }}</h1>
          <section data-attendance-guide-section="intro">
            <h2>{{ tr('What it does', '功能简介') }}</h2>
            <p v-for="(paragraph, index) in active.intro" :key="`intro-${index}`">
              {{ tr(paragraph[0], paragraph[1]) }}
            </p>
          </section>
          <section data-attendance-guide-section="scenarios">
            <h2>{{ tr('When to use it', '适用场景') }}</h2>
            <ul>
              <li v-for="(paragraph, index) in active.scenarios" :key="`scene-${index}`">
                {{ tr(paragraph[0], paragraph[1]) }}
              </li>
            </ul>
          </section>
          <section data-attendance-guide-section="steps">
            <h2>{{ tr('How to configure', '操作流程') }}</h2>
            <ol class="admin-guide__steps">
              <li v-for="(step, index) in active.steps" :key="`step-${index}`">
                <strong>{{ tr(step.path[0], step.path[1]) }}</strong>
                <span>{{ tr(step.detail[0], step.detail[1]) }}</span>
              </li>
            </ol>
            <figure v-if="active.figureRows" class="admin-guide__figure">
              <figcaption>{{ tr(active.figureTitle![0], active.figureTitle![1]) }}</figcaption>
              <ol>
                <li v-for="(row, index) in active.figureRows" :key="`fig-${index}`">{{ tr(row[0], row[1]) }}</li>
              </ol>
            </figure>
            <p v-if="active.callout" class="admin-guide__callout">
              <strong>{{ tr('Note', '操作须知') }}</strong>
              {{ tr(active.callout[0], active.callout[1]) }}
            </p>
            <button
              v-if="active.sectionId"
              class="admin-guide__open"
              type="button"
              data-attendance-guide-open
              @click="openSection"
            >
              {{ tr('Open this section', '打开该区块') }}
            </button>
          </section>
          <section data-attendance-guide-section="faq">
            <h2>{{ tr('FAQ', '常见问题') }}</h2>
            <div v-for="(item, index) in active.faqs" :key="`faq-${index}`" class="admin-guide__faq">
              <h3>{{ index + 1 }}. {{ tr(item.q[0], item.q[1]) }}</h3>
              <p><strong>{{ tr('Answer', '答') }}：</strong>{{ tr(item.a[0], item.a[1]) }}</p>
            </div>
          </section>
        </article>
        <nav v-if="active" class="admin-guide__outline" data-attendance-guide-outline :aria-label="tr('On this page', '本页目录')">
          <p class="admin-guide__toc-label">{{ tr('On this page', '本页目录') }}</p>
          <button
            v-for="section in ATTENDANCE_GUIDE_SECTIONS"
            :key="section.id"
            type="button"
            class="admin-guide__outline-link"
            :data-attendance-guide-outline-item="section.id"
            @click="showSection(section.id)"
          >
            {{ tr(section.labelEn, section.labelZh) }}
          </button>
        </nav>
      </div>
    </div>
  </details>
</template>

<style scoped>
.admin-guide {
  margin-left: auto;
  font-size: 13px;
  color: var(--ms-text-2, #667085);
}

.admin-guide summary {
  cursor: pointer;
  color: var(--ms-color-primary, #2563eb);
  font-weight: 600;
}

.admin-guide__shell {
  position: fixed;
  z-index: 40;
  inset: 20px;
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--ms-border-light, #eaecf0);
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 18px 48px rgba(15, 23, 42, 0.18);
  color: var(--ms-text-1, #1f2329);
}

.admin-guide__bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--ms-border-light, #eaecf0);
}

.admin-guide__search {
  margin-left: auto;
  width: min(280px, 40vw);
  padding: 8px 10px;
  border: 1px solid #d0d5dd;
  border-radius: 8px;
}

.admin-guide__close {
  border: 0;
  background: transparent;
  color: #475569;
  cursor: pointer;
}

.admin-guide__panel {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr) 168px;
  gap: 0;
  min-height: 0;
  flex: 1 1 auto;
}

.admin-guide__topics,
.admin-guide__outline {
  overflow: auto;
  padding: 12px 10px 20px;
  background: #f8fafc;
}

.admin-guide__topics {
  border-right: 1px solid var(--ms-border-light, #eaecf0);
}

.admin-guide__outline {
  border-left: 1px solid var(--ms-border-light, #eaecf0);
}

.admin-guide__toc-label,
.admin-guide__group-label {
  margin: 0 0 6px;
  color: #667085;
  font-size: 12px;
  font-weight: 600;
}

.admin-guide__group {
  margin-bottom: 12px;
}

.admin-guide__topic,
.admin-guide__outline-link {
  display: block;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #475569;
  text-align: left;
  cursor: pointer;
}

.admin-guide__topic {
  padding-left: 14px;
}

.admin-guide__topic--active,
.admin-guide__outline-link:hover,
.admin-guide__topic:hover {
  background: #e8eefc;
  color: #1e3a8a;
}

.admin-guide__topic--active {
  font-weight: 600;
}

.admin-guide__article {
  overflow: auto;
  padding: 28px 36px 48px;
}

.admin-guide__article h1 {
  margin: 0 0 20px;
  font-size: 28px;
  line-height: 1.3;
}

.admin-guide__article h2 {
  margin: 22px 0 8px;
  font-size: 18px;
}

.admin-guide__article h3 {
  margin: 14px 0 4px;
  font-size: 15px;
}

.admin-guide__article p,
.admin-guide__article li {
  margin: 0 0 8px;
  line-height: 1.6;
}

.admin-guide__steps {
  margin: 0;
  padding-left: 1.2rem;
}

.admin-guide__steps li {
  margin-bottom: 12px;
}

.admin-guide__steps strong {
  display: block;
  margin-bottom: 2px;
}

.admin-guide__callout {
  margin: 12px 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: #eff6ff;
  color: #1e3a8a;
}

.admin-guide__callout strong {
  display: block;
  margin-bottom: 4px;
}

.admin-guide__figure {
  margin: 12px 0;
}

.admin-guide__figure ol {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}

.admin-guide__figure li {
  padding: 6px 8px;
  border-radius: 6px;
  background: #f8fafc;
  border-left: 3px solid #1d4ed8;
}

.admin-guide__open {
  margin-top: 8px;
  padding: 4px 10px;
  border: 1px solid #1d4ed8;
  border-radius: 6px;
  background: #fff;
  color: #1d4ed8;
  cursor: pointer;
}

.admin-guide__empty {
  margin: 8px 0 0;
  color: #667085;
  font-size: 12px;
}

@media (max-width: 960px) {
  .admin-guide__panel {
    grid-template-columns: 180px minmax(0, 1fr);
  }

  .admin-guide__outline {
    display: none;
  }
}
</style>
