<template>
  <section class="multitable-templates" data-testid="multitable-template-center">
    <header class="multitable-templates__hero">
      <div>
        <p class="multitable-templates__eyebrow">
          {{ templateCatalogLabel('center.eyebrow', isZh) }}
        </p>
        <h1>{{ templateCatalogLabel('center.title', isZh) }}</h1>
        <p class="multitable-templates__subtitle">
          {{ templateCatalogLabel('center.subtitle', isZh) }}
        </p>
      </div>
      <div class="multitable-templates__hero-actions">
        <router-link class="multitable-templates__back" :to="{ name: HomeRouteName }">
          {{ templateCatalogLabel('center.back', isZh) }}
        </router-link>
        <MtButton class="multitable-templates__refresh" :disabled="loading" @click="loadTemplates">
          {{ loading
            ? templateCatalogLabel('center.refreshing', isZh)
            : templateCatalogLabel('center.refresh', isZh) }}
        </MtButton>
      </div>
    </header>

    <section
      class="multitable-templates__controls"
      :aria-label="templateCatalogLabel('center.controlsAria', isZh)"
    >
      <nav
        v-if="categories.length"
        class="multitable-templates__categories"
        :aria-label="templateCatalogLabel('center.categoriesAria', isZh)"
      >
        <MtButton
          class="multitable-templates__category-btn"
          :class="{ 'multitable-templates__category-btn--active': activeCategory === ALL_CATEGORY }"
          @click="activeCategory = ALL_CATEGORY"
        >
          {{ templateCatalogLabel('center.all', isZh) }}
          <span class="multitable-templates__category-count">{{ templates.length }}</span>
        </MtButton>
        <MtButton
          v-for="cat in categories"
          :key="cat.value"
          class="multitable-templates__category-btn"
          :class="{ 'multitable-templates__category-btn--active': activeCategory === cat.value }"
          :data-category-value="cat.value"
          @click="activeCategory = cat.value"
        >
          {{ cat.label }}
          <span class="multitable-templates__category-count">{{ cat.count }}</span>
        </MtButton>
      </nav>
      <label class="multitable-templates__search">
        <span>{{ templateCatalogLabel('center.search', isZh) }}</span>
        <input
          v-model="searchQuery"
          type="search"
          :placeholder="templateCatalogLabel('center.searchPlaceholder', isZh)"
          :aria-label="templateCatalogLabel('center.search', isZh)"
        />
      </label>
    </section>

    <p v-if="visibleStats" class="multitable-templates__stats" role="status">
      {{ visibleStats }}
    </p>

    <p v-if="errorMessage" class="multitable-templates__error" role="alert">
      {{ errorMessage }}
      <MtButton class="multitable-templates__retry" @click="loadTemplates">
        {{ templateCatalogLabel('center.retry', isZh) }}
      </MtButton>
    </p>

    <p v-if="installError" class="multitable-templates__warning" role="status">
      {{ installError }}
    </p>

    <div v-if="loading && !templates.length" class="multitable-templates__state">
      {{ templateCatalogLabel('center.loading', isZh) }}
    </div>
    <div v-else-if="!templates.length && !errorMessage" class="multitable-templates__empty">
      {{ templateCatalogLabel('center.empty', isZh) }}
    </div>
    <div v-else-if="!visibleTemplates.length" class="multitable-templates__empty">
      {{ templateCatalogLabel('center.noMatch', isZh) }}
    </div>
    <div v-else class="multitable-templates__grid">
      <MetaTemplateCard
        v-for="template in visibleTemplates"
        :key="template.id"
        :template="template"
        :installing="installingTemplateId === template.id"
        show-detail
        @install="onInstall"
        @detail="onDetail"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import MetaTemplateCard from '../multitable/components/MetaTemplateCard.vue'
import { multitableClient } from '../multitable/api/client'
import { useTemplateInstall } from '../multitable/composables/useTemplateInstall'
import { useLocale } from '../composables/useLocale'
import {
  localizeTemplate,
  templateCatalogLabel,
  templateMatchCount,
  templateTotal,
} from '../multitable/utils/template-localization'
import type { MetaTemplate } from '../multitable/types'
import { AppRouteNames } from '../router/types'
import { MtButton } from '../multitable/ui'

const ALL_CATEGORY = '__all__'
const HomeRouteName = AppRouteNames.MULTITABLE_HOME

const router = useRouter()
const { isZh } = useLocale()
const templates = ref<MetaTemplate[]>([])
const loading = ref(false)
const errorMessage = ref('')
const activeCategory = ref<string>(ALL_CATEGORY)
const searchQuery = ref('')

const { installingTemplateId, errorMessage: installError, installAndOpen } = useTemplateInstall()

const activeLocale = computed(() => isZh.value ? 'zh-CN' : 'en')

const categories = computed(() => {
  const counts = new Map<string, number>()
  for (const tpl of templates.value) {
    counts.set(tpl.category, (counts.get(tpl.category) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([value, count]) => {
      const sample = templates.value.find((template) => template.category === value)
      return {
        value,
        label: sample ? localizeTemplate(sample, activeLocale.value).category : value,
        count,
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label, activeLocale.value))
})

const visibleTemplates = computed<MetaTemplate[]>(() => {
  const query = searchQuery.value.trim().toLowerCase()
  return templates.value.filter((tpl) => {
    if (activeCategory.value !== ALL_CATEGORY && tpl.category !== activeCategory.value) {
      return false
    }
    if (!query) return true
    const localized = localizeTemplate(tpl, activeLocale.value)
    return [
      tpl.name,
      tpl.description,
      tpl.category,
      localized.name,
      localized.description,
      localized.category,
    ].some((value) => value.toLowerCase().includes(query))
  })
})

const visibleStats = computed(() => {
  if (loading.value || errorMessage.value) return ''
  if (!templates.value.length) return ''
  const total = templates.value.length
  const shown = visibleTemplates.value.length
  if (shown === total && activeCategory.value === ALL_CATEGORY && !searchQuery.value.trim()) {
    return templateTotal(total, isZh.value)
  }
  return templateMatchCount(shown, total, isZh.value)
})

async function loadTemplates(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    const data = await multitableClient.listTemplates()
    templates.value = data.templates ?? []
  } catch (error) {
    errorMessage.value = error instanceof Error
      ? error.message
      : templateCatalogLabel('center.loadFailed', isZh.value)
  } finally {
    loading.value = false
  }
}

async function onInstall(template: MetaTemplate): Promise<void> {
  await installAndOpen(template)
}

function onDetail(template: MetaTemplate): void {
  void router.push({
    name: AppRouteNames.MULTITABLE_TEMPLATE_DETAIL,
    params: { templateId: template.id },
  })
}

onMounted(() => {
  void loadTemplates()
})
</script>

<style scoped>
.multitable-templates {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  padding: 1.5rem;
  max-width: 1200px;
  margin: 0 auto;
}

.multitable-templates__hero {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  flex-wrap: wrap;
}

.multitable-templates__eyebrow {
  margin: 0;
  font-size: 0.75rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: #64748b;
}

.multitable-templates__hero h1 {
  margin: 0.25rem 0;
  font-size: 1.5rem;
  color: #0f172a;
}

.multitable-templates__subtitle {
  margin: 0;
  font-size: 0.875rem;
  color: #475569;
  max-width: 640px;
}

.multitable-templates__hero-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.multitable-templates__back {
  font-size: 0.875rem;
  color: #2563eb;
  text-decoration: none;
}

.multitable-templates__back:hover {
  text-decoration: underline;
}

/* .multitable-templates__refresh: the hero refresh control is now <MtButton> (default ghost — sanctioned
   border drop, same family as batch-1/batch-3 refresh migrations). Bespoke resting/disabled CSS removed to
   avoid double-styling the MtButton root; class kept on the element for selector stability. */

.multitable-templates__controls {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.multitable-templates__categories {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  overflow-x: auto;
}

/* .multitable-templates__category-btn: the "全部" + per-category filter chips are now <MtButton> (default
   ghost, both sharers of this class migrated together per the shared-class rule). The bespoke resting/hover
   CSS was removed to avoid double-styling the MtButton root; classes are kept on the elements for selector
   stability. The `--active` rule below is deliberately KEPT as an additive overlay — same pattern as
   MultitableHomeView's `.multitable-home__favorite[aria-pressed='true']` — since MtButton has no
   selected/active variant and the active category still needs a persistent visual cue beyond the (behavioral,
   unchanged) label text. */
/* Specificity (0,3,0) so the active tint robustly beats MtButton's own `.mt-button--ghost` (0,2,0)
   base rule rather than relying on stylesheet source order (gate P3-1). */
.mt-button.multitable-templates__category-btn--active {
  border-color: #2563eb;
  background: #eff6ff;
  color: #1d4ed8;
}

/* margin-left (was the parent button's `gap: 0.375rem` between the label text and the count badge) — the
   count badge is now nested one level deeper inside MtButton's `.mt-button__label` wrapper, which has no
   gap of its own, so the spacing is reproduced here instead (layout-only, same visual result). */
.multitable-templates__category-count {
  font-size: 0.75rem;
  background: rgba(15, 23, 42, 0.06);
  border-radius: 999px;
  padding: 0 0.5rem;
  margin-left: 0.375rem;
}

.multitable-templates__category-btn--active .multitable-templates__category-count {
  background: rgba(37, 99, 235, 0.12);
  color: #1d4ed8;
}

.multitable-templates__search {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  color: #475569;
}

.multitable-templates__search input {
  flex: 0 0 280px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 0.375rem 0.625rem;
  font-size: 0.875rem;
}

.multitable-templates__stats {
  margin: 0;
  font-size: 0.75rem;
  color: #94a3b8;
}

.multitable-templates__error {
  margin: 0;
  padding: 0.75rem 1rem;
  border: 1px solid #fca5a5;
  background: #fef2f2;
  color: #b91c1c;
  border-radius: 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
}

/* .multitable-templates__retry: now <MtButton> (default ghost — retry's red accent dropped, same sanctioned
   normalization as MetaChartLoadError #3823 / MetaAutomationLogViewer `__btn--retry` #4089). Bespoke CSS
   removed; class kept for selector stability. */

.multitable-templates__warning {
  margin: 0;
  padding: 0.5rem 0.875rem;
  background: #fef3c7;
  border: 1px solid #f59e0b;
  color: #92400e;
  border-radius: 6px;
  font-size: 0.875rem;
}

.multitable-templates__state,
.multitable-templates__empty {
  padding: 2rem;
  text-align: center;
  color: #64748b;
  font-size: 0.875rem;
  background: #f8fafc;
  border-radius: 8px;
}

.multitable-templates__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
}

@media (max-width: 640px) {
  .multitable-templates__hero {
    flex-direction: column;
  }

  .multitable-templates__hero-actions {
    flex-wrap: wrap;
    width: 100%;
  }

  .multitable-templates__search {
    align-items: stretch;
    flex-direction: column;
  }

  .multitable-templates__search input {
    flex: 1 1 auto;
    min-width: 0;
    width: 100%;
  }
}
</style>
