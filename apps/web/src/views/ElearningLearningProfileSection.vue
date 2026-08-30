<template>
  <section class="learning-profile" aria-labelledby="learning-profile-title">
    <header>
      <h2 id="learning-profile-title">{{ text('Learning archive', '学习档案') }}</h2>
      <dl data-testid="elearning-profile-summary">
        <div><dt>{{ text('Completed', '已完成') }}</dt><dd>{{ summary.completedCourses }}</dd></div>
        <div><dt>{{ text('Assessments', '考试课程') }}</dt><dd>{{ summary.assessmentCourses }}</dd></div>
        <div><dt>{{ text('Content', '内容课程') }}</dt><dd>{{ summary.contentCourses }}</dd></div>
      </dl>
    </header>
    <p v-if="error" class="learning-profile__error" data-testid="elearning-profile-error" role="status">{{ error }}</p>
    <p v-if="loading && courses.length === 0" data-testid="elearning-profile-loading">{{ text('Loading learning archive...', '正在加载学习档案…') }}</p>
    <p v-else-if="courses.length === 0 && !error" data-testid="elearning-profile-empty">{{ text('No completed courses yet.', '暂无已完成课程。') }}</p>
    <ol v-else data-testid="elearning-profile-courses">
      <li v-for="course in courses" :key="course.courseVersionId">
        <div>
          <strong>{{ course.title }}</strong>
          <span>{{ course.kind === 'assessment' ? text('Assessment', '考试课程') : text('Content', '内容课程') }}</span>
        </div>
        <time :datetime="course.completedAt">{{ formatDate(course.completedAt) }}</time>
        <ul v-if="course.kind === 'assessment'">
          <li v-for="exam in course.exams" :key="exam.itemId">
            {{ text('Score', '成绩') }}: {{ exam.earnedScore }} / {{ exam.totalScore }}
          </li>
        </ul>
      </li>
    </ol>
    <button
      v-if="nextCursor"
      type="button"
      data-testid="elearning-profile-more"
      :disabled="loading"
      @click="void load(nextCursor)"
    >
      {{ loading ? text('Loading...', '正在加载…') : text('Load more', '加载更多') }}
    </button>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useLocale } from '../composables/useLocale'
import { ElearningApiError } from '../services/elearning'
import {
  getMyElearningLearningProfile,
  type ElearningLearningProfileCourse,
} from '../services/elearningProfile'

const { isZh } = useLocale()
const summary = ref({ completedCourses: 0, assessmentCourses: 0, contentCourses: 0 })
const courses = ref<ElearningLearningProfileCourse[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const error = ref('')

function text(en: string, zh: string): string {
  return isZh.value ? zh : en
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(isZh.value ? 'zh-CN' : 'en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function errorText(value: unknown): string {
  if (value instanceof ElearningApiError) {
    if (value.status === 403) return text('You cannot read this archive.', '您无权查看该学习档案。')
    if (value.status === 404) return text('Learning archive is unavailable.', '当前无法查看学习档案。')
  }
  return text('Unable to load learning archive. Try again.', '无法加载学习档案，请重试。')
}

async function load(cursor: string | null): Promise<void> {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    const result = await getMyElearningLearningProfile(cursor)
    summary.value = result.summary
    courses.value = cursor === null ? result.courses : [...courses.value, ...result.courses]
    nextCursor.value = result.nextCursor
  } catch (value) {
    error.value = errorText(value)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load(null)
})
</script>

<style scoped>
.learning-profile { display: grid; gap: 10px; padding: 14px 16px; border: 1px solid #c8ddcf; border-radius: 10px; background: #f7fcf8; }
.learning-profile h2,
.learning-profile p { margin: 0; }
.learning-profile header { display: grid; gap: 8px; }
.learning-profile dl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 0; }
.learning-profile dl div { display: grid; gap: 2px; padding: 8px; border-radius: 6px; background: #fff; }
.learning-profile dt { color: #49685a; }
.learning-profile dd { margin: 0; font-size: 1.25rem; font-weight: 700; }
.learning-profile > ol { display: grid; gap: 10px; margin: 0; padding-left: 22px; }
.learning-profile > ol > li { padding: 8px; }
.learning-profile > ol > li > div { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; }
.learning-profile ul { margin: 6px 0 0; padding-left: 18px; }
.learning-profile__error { color: #b42318; }
.learning-profile button { min-height: 36px; }
@media (max-width: 560px) { .learning-profile dl { grid-template-columns: 1fr; } }
</style>
