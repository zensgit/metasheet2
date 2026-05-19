<template>
  <article
    class="meta-template-card"
    :style="{ borderColor: template.color || '#cbd5e1' }"
    :data-template-id="template.id"
  >
    <div class="meta-template-card__top">
      <span class="meta-template-card__icon" :style="{ background: template.color || '#2563eb' }">
        {{ template.icon || template.name.slice(0, 1).toUpperCase() }}
      </span>
      <span class="meta-template-card__category">{{ categoryDisplay }}</span>
    </div>
    <h3 class="meta-template-card__name">{{ template.name }}</h3>
    <p class="meta-template-card__description">{{ template.description }}</p>
    <small class="meta-template-card__meta">
      {{ template.sheets.length }} 个 Sheet ·
      {{ fieldCount }} 个字段 ·
      {{ viewCount }} 个视图
    </small>
    <button
      type="button"
      class="meta-template-card__install"
      :disabled="installing"
      @click="emit('install', template)"
    >
      {{ installing ? '创建中...' : '使用模板' }}
    </button>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { MetaTemplate } from '../types'
import { categoryLabel } from '../utils/category-labels'

const props = defineProps<{
  template: MetaTemplate
  installing?: boolean
}>()

const emit = defineEmits<{
  (e: 'install', template: MetaTemplate): void
}>()

const categoryDisplay = computed(() => categoryLabel(props.template.category))

const fieldCount = computed(() => {
  return props.template.sheets.reduce((sum, sheet) => sum + sheet.fields.length, 0)
})

const viewCount = computed(() => {
  return props.template.sheets.reduce((sum, sheet) => sum + sheet.views.length, 0)
})
</script>

<style scoped>
.meta-template-card {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  border: 2px solid #cbd5e1;
  border-radius: 12px;
  background: #ffffff;
  padding: 1rem;
  min-height: 200px;
}

.meta-template-card__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.meta-template-card__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 8px;
  color: #ffffff;
  font-weight: 600;
  font-size: 1rem;
}

.meta-template-card__category {
  font-size: 0.75rem;
  color: #64748b;
  background: #f1f5f9;
  border-radius: 999px;
  padding: 0.125rem 0.625rem;
  white-space: nowrap;
}

.meta-template-card__name {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  color: #0f172a;
}

.meta-template-card__description {
  margin: 0;
  font-size: 0.875rem;
  color: #475569;
  flex: 1 1 auto;
}

.meta-template-card__meta {
  font-size: 0.75rem;
  color: #94a3b8;
}

.meta-template-card__install {
  margin-top: auto;
  border: 1px solid #2563eb;
  background: #2563eb;
  color: #ffffff;
  border-radius: 8px;
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
}

.meta-template-card__install:disabled {
  opacity: 0.6;
  cursor: progress;
}

.meta-template-card__install:hover:not(:disabled) {
  background: #1d4ed8;
  border-color: #1d4ed8;
}
</style>
