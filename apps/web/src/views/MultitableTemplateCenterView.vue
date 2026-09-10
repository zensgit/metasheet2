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
        <!--
          「把 Base 存为模板」入口。隐藏只是 UX:真正的门在服务端(POST /api/multitable/templates
          要 canManageFields —— 管理员角色或 multitable:manage-schema),这里沿用首页改名入口
          同一套 useAuth().hasPermission() 口径,权限不够的人看不到按钮,看到也照样 403。
        -->
        <MtButton
          v-if="canAuthorTemplates"
          variant="primary"
          class="multitable-templates__create"
          data-testid="template-create-open"
          @click="toggleCreateForm"
        >
          {{ showCreateForm ? '收起' : '把 Base 存为模板' }}
        </MtButton>
        <MtButton class="multitable-templates__refresh" :disabled="loading" @click="loadTemplates({ force: true })">
          {{ loading ? '加载中...' : '刷新' }}
        </MtButton>
      </div>
    </header>

    <!--
      服务端在自定义模板那一段读失败(表没迁移 / 库没起来)时会回退成「只有内置模板」并带
      customTemplatesUnavailable:true。这里必须明说,否则页面看起来就是「你没建过模板」——
      用户会以为自己刚存的模板丢了。
    -->
    <p
      v-if="customTemplatesUnavailable"
      class="multitable-templates__warning"
      role="status"
      data-testid="template-custom-unavailable"
    >
      自定义模板暂不可用(服务端读取用户模板失败),下面只列出内置模板。已保存的自定义模板不会丢失,请联系管理员检查数据库迁移。
    </p>

    <section
      v-if="canAuthorTemplates && showCreateForm"
      class="multitable-templates__create-panel"
      data-testid="template-create-form"
      aria-label="把 Base 存为模板"
    >
      <p class="multitable-templates__create-hint">
        只抽取所选 Base 的<strong>结构</strong>(表、字段、视图),不会复制任何一行记录数据。
      </p>
      <div class="multitable-templates__create-row">
        <label>
          <span>选择 Base</span>
          <select
            v-model="createBaseId"
            data-testid="template-create-base"
            :disabled="creating"
            @change="onCreateBaseChange"
          >
            <option value="">请选择…</option>
            <option v-for="base in createBases" :key="base.id" :value="base.id">{{ base.name }}</option>
          </select>
        </label>
        <label>
          <span>模板名称</span>
          <input
            v-model="createName"
            type="text"
            maxlength="255"
            data-testid="template-create-name"
            :disabled="creating"
            placeholder="例如:订单跟进模板"
          />
        </label>
        <label>
          <span>分类</span>
          <input
            v-model="createCategory"
            type="text"
            maxlength="64"
            data-testid="template-create-category"
            :disabled="creating"
            placeholder="Custom"
          />
        </label>
      </div>
      <label class="multitable-templates__create-desc">
        <span>说明</span>
        <input
          v-model="createDescription"
          type="text"
          maxlength="500"
          data-testid="template-create-description"
          :disabled="creating"
          placeholder="这个模板适合什么场景"
        />
      </label>
      <label class="multitable-templates__create-share">
        <input
          v-model="createShared"
          type="checkbox"
          data-testid="template-create-shared"
          :disabled="creating"
        />
        <span>
          共享给本租户(同事都能看到并使用)。不勾选时只有你自己看得见 ——
          模板会带上表名与全部字段名,共享等于把这些名字给整个租户看。
        </span>
      </label>
      <div class="multitable-templates__create-actions">
        <MtButton
          variant="primary"
          data-testid="template-create-submit"
          :disabled="!canSubmitCreate"
          @click="submitCreate"
        >
          {{ creating ? '保存中...' : '保存为模板' }}
        </MtButton>
        <MtButton data-testid="template-create-cancel" :disabled="creating" @click="closeCreateForm">取消</MtButton>
      </div>
      <p v-if="createError" class="multitable-templates__error" role="alert" data-testid="template-create-error">
        {{ createError }}
      </p>
      <p v-if="createNotice" class="multitable-templates__stats" role="status" data-testid="template-create-notice">
        {{ createNotice }}
      </p>
      <ul v-if="createWarnings.length" class="multitable-templates__create-warnings" data-testid="template-create-warnings">
        <li v-for="(warning, index) in createWarnings" :key="index">{{ warning }}</li>
      </ul>
    </section>

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
      <MtButton class="multitable-templates__retry" @click="loadTemplates({ force: true })">重试</MtButton>
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
        :deletable="canAuthorTemplates"
        @install="onInstall"
        @detail="onDetail"
        @delete="onDelete"
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
import type { MetaBase, MetaTemplate } from '../multitable/types'
import { AppRouteNames } from '../router/types'
import { MtButton } from '../multitable/ui'
import { useAuth } from '../composables/useAuth'

const ALL_CATEGORY = '__all__'
const HomeRouteName = AppRouteNames.MULTITABLE_HOME

const router = useRouter()
const templates = ref<MetaTemplate[]>([])
const loading = ref(false)
const errorMessage = ref('')
const activeCategory = ref<string>(ALL_CATEGORY)
const searchQuery = ref('')

const { installingTemplateId, errorMessage: installError, installAndOpen } = useTemplateInstall()

// 入口显隐镜像服务端的 canManageFields 门(管理员角色或 multitable:manage-schema),
// 与 MultitableHomeView 的改名入口同一套写法。隐藏只是 UX,服务端才是执行者。
const auth = useAuth()
const canAuthorTemplates = computed(() => auth.hasPermission('multitable:manage-schema'))

const showCreateForm = ref(false)
const customTemplatesUnavailable = ref(false)
const createBases = ref<MetaBase[]>([])
const createBaseId = ref('')
const createName = ref('')
const createDescription = ref('')
const createCategory = ref('')
const creating = ref(false)
// 默认不勾:模板携带表名与全部字段名,发布给整租户必须是一次显式动作(服务端默认也是 private)。
const createShared = ref(false)
const createError = ref('')
const createNotice = ref('')
const createWarnings = ref<string[]>([])

const canSubmitCreate = computed(
  () => !creating.value && createBaseId.value.trim().length > 0 && createName.value.trim().length > 0,
)

async function toggleCreateForm(): Promise<void> {
  if (showCreateForm.value) {
    closeCreateForm()
    return
  }
  showCreateForm.value = true
  createError.value = ''
  try {
    const data = await multitableClient.listBases()
    createBases.value = data.bases ?? []
  } catch (error) {
    createError.value = error instanceof Error ? error.message : '加载 Base 列表失败'
  }
}

function closeCreateForm(): void {
  showCreateForm.value = false
  createBaseId.value = ''
  createName.value = ''
  createDescription.value = ''
  createCategory.value = ''
  createShared.value = false
  createError.value = ''
  createWarnings.value = []
}

function onCreateBaseChange(): void {
  // 名称留空时用所选 Base 的名字兜底,用户改过就不覆盖。
  const base = createBases.value.find((item) => item.id === createBaseId.value)
  if (base && !createName.value.trim()) createName.value = base.name
}

async function submitCreate(): Promise<void> {
  if (!canSubmitCreate.value) return
  creating.value = true
  createError.value = ''
  createNotice.value = ''
  createWarnings.value = []
  try {
    const result = await multitableClient.createTemplateFromBase({
      baseId: createBaseId.value.trim(),
      name: createName.value.trim(),
      description: createDescription.value.trim() || undefined,
      category: createCategory.value.trim() || undefined,
      visibility: createShared.value ? 'tenant' : 'private',
    })
    createWarnings.value = Array.isArray(result.warnings) ? result.warnings : []
    // 可见性以**服务端返回的那份**为准(不是本地勾选框),免得前后端默认值不一致时骗人。
    const shared = result.template.visibility === 'tenant'
    createNotice.value = `已保存模板「${result.template.name}」(${shared ? '已共享给本租户' : '仅自己可见'})。`
    createBaseId.value = ''
    createName.value = ''
    createDescription.value = ''
    createCategory.value = ''
    createShared.value = false
    await loadTemplates({ force: true })
  } catch (error) {
    createError.value = error instanceof Error ? error.message : '保存模板失败'
  } finally {
    creating.value = false
  }
}

async function onDelete(template: MetaTemplate): Promise<void> {
  if (!template.custom) return
  if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
    if (!window.confirm(`删除模板「${template.name}」?已用它创建的 Base 不受影响。`)) return
  }
  createError.value = ''
  try {
    await multitableClient.deleteTemplate(template.id)
    createNotice.value = `已删除模板「${template.name}」。`
    await loadTemplates({ force: true })
  } catch (error) {
    createError.value = error instanceof Error ? error.message : '删除模板失败'
    showCreateForm.value = true
  }
}

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

async function loadTemplates(opts?: { force?: boolean }): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    const data = await multitableClient.listTemplates(opts?.force ? { force: true } : undefined)
    templates.value = data.templates ?? []
    customTemplatesUnavailable.value = data.customTemplatesUnavailable === true
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

.multitable-templates__create-panel {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  border: 1px solid #cbd5e1;
  border-radius: 12px;
  padding: 1rem;
  background: #f8fafc;
}

.multitable-templates__create-hint {
  margin: 0;
  font-size: 0.8125rem;
  color: #475569;
}

.multitable-templates__create-row {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.multitable-templates__create-row label,
.multitable-templates__create-desc {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.8125rem;
  color: #334155;
  min-width: 200px;
  flex: 1;
}

.multitable-templates__create-actions {
  display: flex;
  gap: 0.5rem;
}

.multitable-templates__create-share {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  font-size: 0.8125rem;
  color: #334155;
}

.multitable-templates__create-warnings {
  margin: 0;
  padding-left: 1.25rem;
  font-size: 0.8125rem;
  color: #b45309;
}

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
</style>
