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
      <!-- 自定义模板角标:内置模板(常量表里的 8 张)不带 custom,所以永远不显示。 -->
      <span
        v-if="template.custom"
        class="meta-template-card__custom-badge"
        data-testid="template-card-custom-badge"
      >{{ workbenchLabel('card.customBadge', isZh) }}</span>
      <!-- 私有角标:自定义模板默认只有建它的人看得见(visibility='private'),
           共享给租户的(visibility='tenant')不显示这个角标。 -->
      <span
        v-if="template.custom && template.visibility !== 'tenant'"
        class="meta-template-card__private-badge"
        data-testid="template-card-private-badge"
      >{{ workbenchLabel('card.privateBadge', isZh) }}</span>
    </div>
    <h3 class="meta-template-card__name">{{ template.name }}</h3>
    <p class="meta-template-card__description">{{ template.description }}</p>
    <small class="meta-template-card__meta">
      {{ cardSheets(template.sheets.length, isZh) }} ·
      {{ cardFields(fieldCount, isZh) }} ·
      {{ cardViews(viewCount, isZh) }}
    </small>
    <div class="meta-template-card__actions">
      <!-- S2: opt-in detail entry (template center only); other consumers
           (home view, workbench modal) keep the install-only card. -->
      <MtButton
        v-if="showDetail"
        class="meta-template-card__detail"
        @click="emit('detail', template)"
      >
        {{ workbenchLabel('card.viewDetail', isZh) }}
      </MtButton>
      <!-- 删除只对自定义模板开放,且要调用方显式打开(模板中心开,首页/工作台不开)。
           服务端才是真正的门:内置模板 403,别的租户的模板 404。 -->
      <MtButton
        v-if="deletable && template.custom"
        class="meta-template-card__delete"
        data-testid="template-card-delete"
        @click="emit('delete', template)"
      >
        {{ workbenchLabel('card.delete', isZh) }}
      </MtButton>
      <MtButton
        variant="primary"
        class="meta-template-card__install"
        :disabled="installing"
        @click="emit('install', template)"
      >
        {{ installing ? workbenchLabel('card.installing', isZh) : workbenchLabel('card.install', isZh) }}
      </MtButton>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { MetaTemplate } from '../types'
import { categoryLabel } from '../utils/category-labels'
import { useLocale } from '../../composables/useLocale'
import {
  cardSheets,
  cardFields,
  cardViews,
  workbenchLabel,
} from '../utils/workbench-labels'
import { MtButton } from '../ui'

const props = defineProps<{
  template: MetaTemplate
  installing?: boolean
  showDetail?: boolean
  deletable?: boolean
}>()

const emit = defineEmits<{
  (e: 'install', template: MetaTemplate): void
  (e: 'detail', template: MetaTemplate): void
  (e: 'delete', template: MetaTemplate): void
}>()

// useLocale().isZh is already a ComputedRef<boolean>; template auto-unwraps it,
// script reads isZh.value.
const { isZh } = useLocale()

const categoryDisplay = computed(() =>
  categoryLabel(props.template.category, isZh.value ? 'zh-CN' : 'en'),
)

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

.meta-template-card__custom-badge {
  font-size: 0.75rem;
  color: #0f766e;
  background: #ccfbf1;
  border-radius: 999px;
  padding: 0.125rem 0.5rem;
  white-space: nowrap;
}

.meta-template-card__private-badge {
  font-size: 0.75rem;
  color: #7c2d12;
  background: #ffedd5;
  border-radius: 999px;
  padding: 0.125rem 0.5rem;
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

.meta-template-card__actions {
  margin-top: auto;
  display: flex;
  gap: 0.5rem;
}

/* .meta-template-card__detail / __install: the two action controls are now <MtButton> (detail = ghost,
   install = variant="primary"; the bespoke #2563eb == --ms-color-primary). Their bespoke hardcoded-hex
   button CSS was removed to avoid double-styling the MtButton root. Only the install control's LAYOUT
   property (flex: it stretches to fill the actions row) is kept — MtButton doesn't provide it. Classes
   kept for selector stability. */
.meta-template-card__install {
  flex: 1 1 auto;
}
</style>
