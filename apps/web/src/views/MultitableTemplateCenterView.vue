<template>
  <section class="multitable-templates" data-testid="multitable-template-center">
    <header class="multitable-templates__hero">
      <div>
        <p class="multitable-templates__eyebrow">Multitable Templates</p>
        <h1>模板中心</h1>
        <p class="multitable-templates__subtitle">
          从行业模板开始一个新的多维表 Base。安装时会自动跳转到新建 Base 的默认视图。
        </p>
      </div>
      <div class="multitable-templates__hero-actions">
        <router-link class="multitable-templates__back" :to="{ name: HomeRouteName }">
          ← 返回多维表首页
        </router-link>
        <MtButton class="multitable-templates__refresh" :disabled="loading" @click="loadTemplates">
          {{ loading ? '加载中...' : '刷新' }}
        </MtButton>
      </div>
    </header>

    <section class="multitable-templates__controls" aria-label="筛选与搜索">
      <nav v-if="categories.length" class="multitable-templates__categories" aria-label="分类筛选">
        <MtButton
          class="multitable-templates__category-btn"
          :class="{ 'multitable-templates__category-btn--active': activeCategory === ALL_CATEGORY }"
          @click="activeCategory = ALL_CATEGORY"
        >
          全部
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
        <span>搜索模板</span>
        <input
          v-model="searchQuery"
          type="search"
          placeholder="按名称、描述或分类搜索"
          aria-label="Search templates"
        />
      </label>
    </section>

    <p v-if="visibleStats" class="multitable-templates__stats" role="status">
      {{ visibleStats }}
    </p>

    <p v-if="errorMessage" class="multitable-templates__error" role="alert">
      {{ errorMessage }}
      <MtButton class="multitable-templates__retry" @click="loadTemplates">重试</MtButton>
    </p>

    <p v-if="installError" class="multitable-templates__warning" role="status">
      {{ installError }}
    </p>

    <div v-if="loading && !templates.length" class="multitable-templates__state">
      正在加载模板...
    </div>
    <div v-else-if="!templates.length && !errorMessage" class="multitable-templates__empty">
      暂无可用模板。请刷新或返回首页直接新建空白 Base。
    </div>
    <div v-else-if="!visibleTemplates.length" class="multitable-templates__empty">
      没有匹配的模板。请调整分类或搜索关键词。
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
import { categoryLabel } from '../multitable/utils/category-labels'
import type { MetaTemplate } from '../multitable/types'
import { AppRouteNames } from '../router/types'
import { MtButton } from '../multitable/ui'

const ALL_CATEGORY = '__all__'
const HomeRouteName = AppRouteNames.MULTITABLE_HOME

const router = useRouter()
const templates = ref<MetaTemplate[]>([])
const loading = ref(false)
const errorMessage = ref('')
const activeCategory = ref<string>(ALL_CATEGORY)
const searchQuery = ref('')

const { installingTemplateId, errorMessage: installError, installAndOpen } = useTemplateInstall()

const categories = computed(() => {
  const counts = new Map<string, number>()
  for (const tpl of templates.value) {
    counts.set(tpl.category, (counts.get(tpl.category) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, label: categoryLabel(value), count }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
})

const visibleTemplates = computed<MetaTemplate[]>(() => {
  const query = searchQuery.value.trim().toLowerCase()
  return templates.value.filter((tpl) => {
    if (activeCategory.value !== ALL_CATEGORY && tpl.category !== activeCategory.value) {
      return false
    }
    if (!query) return true
    return (
      tpl.name.toLowerCase().includes(query) ||
      tpl.description.toLowerCase().includes(query) ||
      tpl.category.toLowerCase().includes(query) ||
      categoryLabel(tpl.category).toLowerCase().includes(query)
    )
  })
})

const visibleStats = computed(() => {
  if (loading.value || errorMessage.value) return ''
  if (!templates.value.length) return ''
  const total = templates.value.length
  const shown = visibleTemplates.value.length
  if (shown === total && activeCategory.value === ALL_CATEGORY && !searchQuery.value.trim()) {
    return `共 ${total} 个模板`
  }
  return `匹配 ${shown} / ${total} 个模板`
})

async function loadTemplates(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    const data = await multitableClient.listTemplates()
    templates.value = data.templates ?? []
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '加载模板失败'
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
.multitable-templates__category-btn--active {
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
</style>
