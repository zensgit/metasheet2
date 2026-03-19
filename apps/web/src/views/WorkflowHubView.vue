<template>
  <section class="workflow-hub">
    <header class="workflow-hub__header">
      <div>
        <h1>Workflow Hub</h1>
        <p>面向平台流程的草稿目录、模板入口和设计器起点。</p>
      </div>
      <div class="workflow-hub__actions">
        <button class="btn btn--ghost" type="button" @click="saveCurrentView">
          Save view
        </button>
        <button class="btn btn--ghost" type="button" @click="saveCurrentTeamView">
          Save team view
        </button>
        <button class="btn btn--ghost" type="button" :disabled="isRefreshing" @click="refreshAll({ force: true })">
          {{ isRefreshing ? 'Refreshing...' : 'Refresh' }}
        </button>
        <router-link class="btn btn--primary" :to="{ name: 'workflow-designer' }">
          New workflow
        </router-link>
      </div>
    </header>

    <section class="workflow-hub__saved" v-if="savedViews.length">
      <div class="workflow-hub__saved-header">
        <div>
          <h2>Saved Views</h2>
          <p>把当前过滤视角保存成可复用入口。</p>
        </div>
        <button class="btn btn--ghost" type="button" @click="saveCurrentView">
          Save current view
        </button>
      </div>
      <div class="workflow-hub__saved-list">
        <article v-for="view in savedViews" :key="view.id" class="workflow-hub__saved-card">
          <div class="workflow-hub__template-top">
            <div>
              <h3>{{ view.name }}</h3>
              <p>{{ describeSavedView(view.state) }}</p>
            </div>
            <span class="chip">Saved</span>
          </div>
          <div class="workflow-hub__meta-row">
            <span>Updated: {{ formatDateTime(view.updatedAt) }}</span>
          </div>
          <div class="workflow-hub__template-actions">
            <button class="btn btn--primary btn--mini" type="button" @click="applySavedView(view.id)">
              Apply view
            </button>
            <button class="btn btn--ghost btn--mini" type="button" @click="deleteSavedView(view.id, view.name)">
              Delete
            </button>
          </div>
        </article>
      </div>
    </section>

    <section class="workflow-hub__saved" v-if="teamViews.length || teamViewsError">
      <div class="workflow-hub__saved-header">
        <div>
          <h2>Team Views</h2>
          <p>把当前 Workflow Hub 视角保存成租户内可复用入口。</p>
        </div>
        <button class="btn btn--ghost" type="button" :disabled="teamViewsLoading" @click="saveCurrentTeamView">
          {{ teamViewsLoading ? 'Saving...' : 'Save team view' }}
        </button>
      </div>
      <p v-if="teamViewsError" class="workflow-hub__error">{{ teamViewsError }}</p>
      <div v-else-if="teamViews.length" class="workflow-hub__saved-list">
        <article v-for="view in teamViews" :key="view.id" class="workflow-hub__saved-card">
          <div class="workflow-hub__template-top">
            <div>
              <h3>{{ view.name }}</h3>
              <p>{{ describeTeamView(view) }}</p>
            </div>
            <span class="chip" data-tone="team">Team</span>
          </div>
          <div class="workflow-hub__meta-row">
            <span>Owner: {{ view.ownerUserId || 'system' }}</span>
            <span>Updated: {{ formatDateTime(view.updatedAt) }}</span>
          </div>
          <div class="workflow-hub__template-actions">
            <button class="btn btn--primary btn--mini" type="button" @click="applyTeamView(view.id)">
              Apply view
            </button>
            <button
              v-if="view.canManage"
              class="btn btn--ghost btn--mini"
              type="button"
              :disabled="teamViewsLoading"
              @click="deleteTeamView(view.id, view.name)"
            >
              Delete
            </button>
          </div>
        </article>
      </div>
    </section>

    <div class="workflow-hub__grid">
      <article class="workflow-hub__card">
        <div class="workflow-hub__card-header">
          <div>
            <h2>Workflow Drafts</h2>
            <p>从 draft model 直接读取，可按状态、名称和更新时间筛选。</p>
          </div>
          <span class="workflow-hub__count">{{ workflowPagination.total }}</span>
        </div>

        <div class="workflow-hub__toolbar">
          <input
            v-model="workflowSearch"
            class="workflow-hub__input"
            type="search"
            placeholder="Search workflows"
            @keydown.enter="refreshWorkflows(0)"
          />
          <select v-model="workflowStatus" class="workflow-hub__select" @change="refreshWorkflows(0)">
            <option value="">All status</option>
            <option value="draft">Draft</option>
            <option value="published">Published</option>
            <option value="archived">Archived</option>
          </select>
          <select v-model="workflowSortBy" class="workflow-hub__select" @change="refreshWorkflows(0)">
            <option value="updated_at">Recently updated</option>
            <option value="created_at">Recently created</option>
            <option value="name">Name</option>
          </select>
          <button class="btn btn--ghost" type="button" :disabled="workflowLoading" @click="refreshWorkflows(0)">
            {{ workflowLoading ? 'Loading...' : 'Apply' }}
          </button>
        </div>

        <p v-if="workflowError" class="workflow-hub__error">{{ workflowError }}</p>

        <div v-if="workflowLoading" class="workflow-hub__empty">Loading workflow drafts...</div>
        <div v-else-if="!workflowItems.length" class="workflow-hub__empty">
          No workflow drafts matched the current filters.
        </div>
        <table v-else class="workflow-hub__table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Role</th>
              <th>Category</th>
              <th>Updated</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="workflow in workflowItems" :key="workflow.id">
              <td>
                <div class="workflow-hub__primary">{{ workflow.name || 'Unnamed workflow' }}</div>
                <div class="workflow-hub__secondary">{{ workflow.description || 'No description' }}</div>
              </td>
              <td><span class="chip" :data-tone="workflow.status">{{ workflow.status }}</span></td>
              <td><span class="chip" :data-tone="workflow.role || 'viewer'">{{ workflow.role || 'viewer' }}</span></td>
              <td>{{ workflow.category || '-' }}</td>
              <td>{{ formatDateTime(workflow.updatedAt) }}</td>
              <td>
                <div class="workflow-hub__table-actions">
                  <router-link class="btn btn--ghost btn--mini" :to="{ name: 'workflow-designer', params: { id: workflow.id } }">
                    Open
                  </router-link>
                  <button class="btn btn--ghost btn--mini" type="button" :disabled="workflowLoading" @click="duplicateDraft(workflow.id, workflow.name)">
                    Duplicate
                  </button>
                  <button
                    v-if="workflow.status !== 'archived'"
                    class="btn btn--ghost btn--mini"
                    type="button"
                    :disabled="workflowLoading || workflow.status === 'archived' || workflow.role === 'viewer'"
                    @click="archiveDraft(workflow.id, workflow.name)"
                  >
                    Archive
                  </button>
                  <button
                    v-else
                    class="btn btn--ghost btn--mini"
                    type="button"
                    :disabled="workflowLoading || workflow.role === 'viewer'"
                    @click="restoreDraft(workflow.id, workflow.name)"
                  >
                    Restore
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>

        <footer class="workflow-hub__pager">
          <span>{{ workflowRangeLabel }}</span>
          <div class="workflow-hub__pager-actions">
            <button class="btn btn--ghost btn--mini" type="button" :disabled="workflowLoading || workflowPagination.offset === 0" @click="refreshWorkflows(Math.max(0, workflowPagination.offset - workflowPagination.limit))">
              Previous
            </button>
            <button class="btn btn--ghost btn--mini" type="button" :disabled="workflowLoading || workflowPagination.offset + workflowPagination.returned >= workflowPagination.total" @click="refreshWorkflows(workflowPagination.offset + workflowPagination.limit)">
              Next
            </button>
          </div>
        </footer>
      </article>

      <article class="workflow-hub__card">
        <div class="workflow-hub__card-header">
          <div>
            <h2>Template Catalog</h2>
            <p>支持 builtin / database 来源过滤，可直接进入 designer 实例化。</p>
          </div>
          <span class="workflow-hub__count">{{ templatePagination.total }}</span>
        </div>

        <section v-if="recentTemplateItems.length" class="workflow-hub__recent">
          <div class="workflow-hub__recent-header">
            <div>
              <h3>Recent Templates</h3>
              <p>把最近使用过的模板前置成高频入口。</p>
            </div>
          </div>
          <div class="workflow-hub__recent-list">
            <article v-for="template in recentTemplateItems" :key="template.id" class="workflow-hub__recent-card">
              <div class="workflow-hub__template-top">
                <div>
                  <h3>{{ template.name }}</h3>
                  <p>{{ template.description || 'No description' }}</p>
                </div>
                <span class="chip" :data-tone="template.source">{{ template.source }}</span>
              </div>
              <div class="workflow-hub__meta-row">
                <span>{{ template.category }}</span>
                <span>Last used: {{ formatDateTime(template.usedAt) }}</span>
              </div>
              <div class="workflow-hub__template-actions">
                <router-link
                  class="btn btn--primary btn--mini"
                  :to="{ name: 'workflow-designer', query: { templateId: template.id } }"
                >
                  Use again
                </router-link>
              </div>
            </article>
          </div>
        </section>

        <div class="workflow-hub__toolbar">
          <input
            v-model="templateSearch"
            class="workflow-hub__input"
            type="search"
            placeholder="Search templates"
            @keydown.enter="refreshTemplates(0)"
          />
          <select v-model="templateSource" class="workflow-hub__select" @change="refreshTemplates(0)">
            <option value="all">All sources</option>
            <option value="builtin">Builtin</option>
            <option value="database">Database</option>
          </select>
          <select v-model="templateSortBy" class="workflow-hub__select" @change="refreshTemplates(0)">
            <option value="usage_count">Usage</option>
            <option value="name">Name</option>
            <option value="updated_at">Updated</option>
          </select>
          <button class="btn btn--ghost" type="button" :disabled="templateLoading" @click="refreshTemplates(0)">
            {{ templateLoading ? 'Loading...' : 'Apply' }}
          </button>
        </div>

        <p v-if="templateError" class="workflow-hub__error">{{ templateError }}</p>

        <div v-if="templateLoading" class="workflow-hub__empty">Loading templates...</div>
        <div v-else-if="!templateItems.length" class="workflow-hub__empty">
          No templates matched the current filters.
        </div>
        <div v-else class="workflow-hub__template-list">
          <article v-for="template in templateItems" :key="template.id" class="workflow-hub__template-card">
            <div class="workflow-hub__template-top">
              <div>
                <h3>{{ template.name }}</h3>
                <p>{{ template.description || 'No description' }}</p>
              </div>
              <span class="chip" :data-tone="template.source">{{ template.source }}</span>
            </div>
            <div class="workflow-hub__meta-row">
              <span>{{ template.category }}</span>
              <span>Required: {{ template.requiredVariables.length }}</span>
              <span>Optional: {{ template.optionalVariables.length }}</span>
              <span>Usage: {{ template.usageCount }}</span>
            </div>
            <div v-if="template.tags.length" class="workflow-hub__tag-list">
              <span v-for="tag in template.tags" :key="tag" class="tag">{{ tag }}</span>
            </div>
            <div class="workflow-hub__template-actions">
              <router-link
                class="btn btn--primary btn--mini"
                :to="{ name: 'workflow-designer', query: { templateId: template.id } }"
              >
                Use template
              </router-link>
            </div>
          </article>
        </div>

        <footer class="workflow-hub__pager">
          <span>{{ templateRangeLabel }}</span>
          <div class="workflow-hub__pager-actions">
            <button class="btn btn--ghost btn--mini" type="button" :disabled="templateLoading || templatePagination.offset === 0" @click="refreshTemplates(Math.max(0, templatePagination.offset - templatePagination.limit))">
              Previous
            </button>
            <button class="btn btn--ghost btn--mini" type="button" :disabled="templateLoading || templatePagination.offset + templatePagination.returned >= templatePagination.total" @click="refreshTemplates(templatePagination.offset + templatePagination.limit)">
              Next
            </button>
          </div>
        </footer>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import 'element-plus/es/components/message/style/css'
import 'element-plus/es/components/message-box/style/css'
import {
  archiveWorkflowDraft,
  deleteWorkflowHubTeamView,
  duplicateWorkflowDraft,
  listWorkflowHubTeamViews,
  restoreWorkflowDraft,
  saveWorkflowHubTeamView,
  type WorkflowDesignerPagination,
  type WorkflowHubTeamView,
  type WorkflowDesignerTemplateListItem,
  type WorkflowDesignerWorkflowListItem,
} from './workflowDesignerPersistence'
import {
  invalidateWorkflowDraftCatalogCache,
  listWorkflowDraftsCached,
  listWorkflowTemplatesCached,
} from './workflowDesignerCatalogCache'
import {
  buildWorkflowHubRouteQuery,
  getNextWorkflowHubOffset,
  isWorkflowHubRouteStateEqual,
  parseWorkflowHubRouteState,
  type WorkflowHubRouteState,
} from './workflowHubQueryState'
import {
  readRecentWorkflowTemplates,
  type RecentWorkflowTemplateItem,
} from './workflowDesignerRecentTemplates'
import {
  deleteWorkflowHubSavedView as removeWorkflowHubSavedView,
  readWorkflowHubSavedViews,
  saveWorkflowHubSavedView,
  type WorkflowHubSavedView,
} from './workflowHubSavedViews'
import {
  readWorkflowHubSessionState,
  shouldRestoreWorkflowHubSessionState,
  writeWorkflowHubSessionState,
} from './workflowHubSessionState'

const router = useRouter()
const route = useRoute()
const initialRouteState = parseWorkflowHubRouteState(route.query)
const workflowItems = ref<WorkflowDesignerWorkflowListItem[]>([])
const workflowLoading = ref(false)
const workflowError = ref('')
const workflowSearch = ref(initialRouteState.workflowSearch)
const workflowStatus = ref(initialRouteState.workflowStatus)
const workflowSortBy = ref<'updated_at' | 'created_at' | 'name'>(initialRouteState.workflowSortBy)
const workflowPagination = ref<WorkflowDesignerPagination>({
  total: 0,
  limit: 8,
  offset: initialRouteState.workflowOffset,
  returned: 0,
})

const templateItems = ref<WorkflowDesignerTemplateListItem[]>([])
const recentTemplateItems = ref<RecentWorkflowTemplateItem[]>([])
const savedViews = ref<WorkflowHubSavedView[]>([])
const teamViews = ref<WorkflowHubTeamView[]>([])
const templateLoading = ref(false)
const templateError = ref('')
const teamViewsLoading = ref(false)
const teamViewsError = ref('')
const templateSearch = ref(initialRouteState.templateSearch)
const templateSource = ref<'all' | 'builtin' | 'database'>(initialRouteState.templateSource)
const templateSortBy = ref<'usage_count' | 'name' | 'updated_at'>(initialRouteState.templateSortBy)
const templatePagination = ref<WorkflowDesignerPagination>({
  total: 0,
  limit: 6,
  offset: initialRouteState.templateOffset,
  returned: 0,
})

const isRefreshing = computed(() => workflowLoading.value || templateLoading.value)

const workflowRangeLabel = computed(() => {
  if (!workflowPagination.value.total) return '0 items'
  const start = workflowPagination.value.offset + 1
  const end = workflowPagination.value.offset + workflowPagination.value.returned
  return `${start}-${end} / ${workflowPagination.value.total}`
})

const templateRangeLabel = computed(() => {
  if (!templatePagination.value.total) return '0 items'
  const start = templatePagination.value.offset + 1
  const end = templatePagination.value.offset + templatePagination.value.returned
  return `${start}-${end} / ${templatePagination.value.total}`
})

async function syncHubQuery(workflowOffset = workflowPagination.value.offset, templateOffset = templatePagination.value.offset) {
  const nextQuery = buildWorkflowHubRouteQuery({
    workflowSearch: workflowSearch.value.trim(),
    workflowStatus: workflowStatus.value,
    workflowSortBy: workflowSortBy.value,
    workflowOffset,
    templateSearch: templateSearch.value.trim(),
    templateSource: templateSource.value,
    templateSortBy: templateSortBy.value,
    templateOffset,
  })

  const currentQuery = buildWorkflowHubRouteQuery(parseWorkflowHubRouteState(route.query))
  if (JSON.stringify(currentQuery) === JSON.stringify(nextQuery)) {
    return
  }

  await router.replace({ query: nextQuery })
}

function currentRouteState(workflowOffset = workflowPagination.value.offset, templateOffset = templatePagination.value.offset): WorkflowHubRouteState {
  return {
    workflowSearch: workflowSearch.value.trim(),
    workflowStatus: workflowStatus.value,
    workflowSortBy: workflowSortBy.value,
    workflowOffset,
    templateSearch: templateSearch.value.trim(),
    templateSource: templateSource.value,
    templateSortBy: templateSortBy.value,
    templateOffset,
  }
}

function persistSessionState(workflowOffset = workflowPagination.value.offset, templateOffset = templatePagination.value.offset) {
  writeWorkflowHubSessionState(currentRouteState(workflowOffset, templateOffset))
}

function applyRouteState(state: WorkflowHubRouteState) {
  workflowSearch.value = state.workflowSearch
  workflowStatus.value = state.workflowStatus
  workflowSortBy.value = state.workflowSortBy
  workflowPagination.value = {
    ...workflowPagination.value,
    offset: state.workflowOffset,
  }
  templateSearch.value = state.templateSearch
  templateSource.value = state.templateSource
  templateSortBy.value = state.templateSortBy
  templatePagination.value = {
    ...templatePagination.value,
    offset: state.templateOffset,
  }
}

async function refreshWorkflows(offset = workflowPagination.value.offset, options: { force?: boolean; syncRoute?: boolean } = {}) {
  workflowLoading.value = true
  workflowError.value = ''

  if (options.syncRoute !== false) {
    await syncHubQuery(offset, templatePagination.value.offset)
  }

  try {
    const result = await listWorkflowDraftsCached({
      search: workflowSearch.value.trim() || undefined,
      status: workflowStatus.value || undefined,
      sortBy: workflowSortBy.value,
      sortOrder: 'desc',
      limit: workflowPagination.value.limit,
      offset,
    }, options)
    workflowItems.value = result.items
    workflowPagination.value = {
      ...result.pagination,
      limit: workflowPagination.value.limit,
    }

    const nextOffset = getNextWorkflowHubOffset(
      result.pagination.total,
      result.pagination.returned,
      result.pagination.offset,
      workflowPagination.value.limit,
    )
    if (nextOffset !== null) {
      void listWorkflowDraftsCached({
        search: workflowSearch.value.trim() || undefined,
        status: workflowStatus.value || undefined,
        sortBy: workflowSortBy.value,
        sortOrder: 'desc',
        limit: workflowPagination.value.limit,
        offset: nextOffset,
      }).catch(() => null)
    }
    persistSessionState(result.pagination.offset, templatePagination.value.offset)
  } catch (error) {
    workflowError.value = error instanceof Error ? error.message : 'Failed to load workflow drafts'
    workflowItems.value = []
    workflowPagination.value = {
      ...workflowPagination.value,
      total: 0,
      offset: 0,
      returned: 0,
    }
  } finally {
    workflowLoading.value = false
  }
}

async function refreshTemplates(offset = templatePagination.value.offset, options: { force?: boolean; syncRoute?: boolean } = {}) {
  templateLoading.value = true
  templateError.value = ''

  if (options.syncRoute !== false) {
    await syncHubQuery(workflowPagination.value.offset, offset)
  }

  try {
    const result = await listWorkflowTemplatesCached({
      search: templateSearch.value.trim() || undefined,
      source: templateSource.value,
      sortBy: templateSortBy.value,
      sortOrder: 'desc',
      limit: templatePagination.value.limit,
      offset,
    }, options)
    templateItems.value = result.items
    templatePagination.value = {
      ...result.pagination,
      limit: templatePagination.value.limit,
    }

    const nextOffset = getNextWorkflowHubOffset(
      result.pagination.total,
      result.pagination.returned,
      result.pagination.offset,
      templatePagination.value.limit,
    )
    if (nextOffset !== null) {
      void listWorkflowTemplatesCached({
        search: templateSearch.value.trim() || undefined,
        source: templateSource.value,
        sortBy: templateSortBy.value,
        sortOrder: 'desc',
        limit: templatePagination.value.limit,
        offset: nextOffset,
      }).catch(() => null)
    }
    persistSessionState(workflowPagination.value.offset, result.pagination.offset)
  } catch (error) {
    templateError.value = error instanceof Error ? error.message : 'Failed to load workflow templates'
    templateItems.value = []
    templatePagination.value = {
      ...templatePagination.value,
      total: 0,
      offset: 0,
      returned: 0,
    }
  } finally {
    templateLoading.value = false
  }
}

async function refreshAll(options: { force?: boolean } = {}) {
  await Promise.all([
    refreshWorkflows(workflowPagination.value.offset, { force: options.force, syncRoute: false }),
    refreshTemplates(templatePagination.value.offset, { force: options.force, syncRoute: false }),
  ])
}

function refreshRecentTemplates() {
  recentTemplateItems.value = readRecentWorkflowTemplates()
}

function refreshSavedViews() {
  savedViews.value = readWorkflowHubSavedViews()
}

async function refreshTeamViews() {
  teamViewsLoading.value = true
  teamViewsError.value = ''

  try {
    const result = await listWorkflowHubTeamViews()
    teamViews.value = result.items
  } catch (error) {
    teamViewsError.value = error instanceof Error ? error.message : 'Failed to load team views'
    teamViews.value = []
  } finally {
    teamViewsLoading.value = false
  }
}

function describeSavedView(state: WorkflowHubRouteState) {
  const parts: string[] = []
  if (state.workflowSearch) parts.push(`WF:${state.workflowSearch}`)
  if (state.workflowStatus) parts.push(`Status:${state.workflowStatus}`)
  if (state.templateSearch) parts.push(`TPL:${state.templateSearch}`)
  if (state.templateSource !== 'all') parts.push(`Source:${state.templateSource}`)
  if (state.workflowOffset > 0) parts.push(`WF Page:${state.workflowOffset / workflowPagination.value.limit + 1}`)
  if (state.templateOffset > 0) parts.push(`TPL Page:${state.templateOffset / templatePagination.value.limit + 1}`)
  return parts.length ? parts.join(' · ') : 'Default workflow hub view'
}

function describeTeamView(view: WorkflowHubTeamView) {
  const summary = describeSavedView(view.state)
  return summary === 'Default workflow hub view'
    ? `Shared by ${view.ownerUserId || 'system'}`
    : `${summary} · Shared by ${view.ownerUserId || 'system'}`
}

async function saveCurrentView() {
  try {
    const promptResult = await ElMessageBox.prompt(
      '为当前 Workflow Hub 视角输入名称。',
      '保存视图',
      {
        confirmButtonText: '保存',
        cancelButtonText: '取消',
        inputPlaceholder: '例如：Parallel Templates',
      },
    )
    const trimmed = promptResult.value.trim()
    if (!trimmed) return
    savedViews.value = saveWorkflowHubSavedView(trimmed, currentRouteState())
    ElMessage.success('视图已保存')
  } catch {
    return
  }
}

async function saveCurrentTeamView() {
  try {
    const promptResult = await ElMessageBox.prompt(
      '为当前 Workflow Hub 视角输入团队视图名称。',
      '保存团队视图',
      {
        confirmButtonText: '保存',
        cancelButtonText: '取消',
        inputPlaceholder: '例如：Team Parallel Templates',
      },
    )
    const trimmed = promptResult.value.trim()
    if (!trimmed) return

    teamViewsLoading.value = true
    const saved = await saveWorkflowHubTeamView(trimmed, currentRouteState())
    teamViews.value = [saved, ...teamViews.value.filter((item) => item.id !== saved.id)]
      .sort((left, right) => (right.updatedAt || '').localeCompare(left.updatedAt || ''))
    ElMessage.success('团队视图已保存')
  } catch (error) {
    if (error instanceof Error) {
      ElMessage.error(error.message)
    }
  } finally {
    teamViewsLoading.value = false
  }
}

async function applySavedView(viewId: string) {
  const target = savedViews.value.find((item) => item.id === viewId)
  if (!target) return

  applyRouteState(target.state)
  await syncHubQuery(target.state.workflowOffset, target.state.templateOffset)
  await refreshAll()
  ElMessage.success(`已切换到视图 “${target.name}”`)
}

async function applyTeamView(viewId: string) {
  const target = teamViews.value.find((item) => item.id === viewId)
  if (!target) return

  applyRouteState(target.state)
  await syncHubQuery(target.state.workflowOffset, target.state.templateOffset)
  await refreshAll({ force: true })
  ElMessage.success(`已切换到团队视图 “${target.name}”`)
}

async function deleteSavedView(viewId: string, viewName: string) {
  try {
    await ElMessageBox.confirm(`删除视图 “${viewName}” 后将无法恢复，是否继续？`, '删除视图', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }

  savedViews.value = removeWorkflowHubSavedView(viewId)
  ElMessage.success('视图已删除')
}

async function deleteTeamView(viewId: string, viewName: string) {
  try {
    await ElMessageBox.confirm(`删除团队视图 “${viewName}” 后，租户内其他同事也将无法再使用，是否继续？`, '删除团队视图', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }

  try {
    teamViewsLoading.value = true
    await deleteWorkflowHubTeamView(viewId)
    teamViews.value = teamViews.value.filter((item) => item.id !== viewId)
    ElMessage.success('团队视图已删除')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除团队视图失败')
  } finally {
    teamViewsLoading.value = false
  }
}

async function duplicateDraft(workflowId: string, workflowName: string) {
  let nextName: string | undefined

  try {
    const promptResult = await ElMessageBox.prompt(
      `为 “${workflowName || '未命名工作流'}” 输入副本名称；留空则使用系统默认命名。`,
      '复制工作流',
      {
        confirmButtonText: '复制',
        cancelButtonText: '取消',
        inputPlaceholder: '例如：审批流程 - 业务线 A',
      },
    )
    const trimmed = promptResult.value.trim()
    nextName = trimmed || undefined
  } catch {
    return
  }

  try {
    workflowLoading.value = true
    const result = await duplicateWorkflowDraft(workflowId, nextName)
    invalidateWorkflowDraftCatalogCache()
    await refreshWorkflows(workflowPagination.value.offset, { force: true })
    if (result.workflowId) {
      await router.push({ name: 'workflow-designer', params: { id: result.workflowId } })
    }
    ElMessage.success(result.message || '工作流已复制')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '复制工作流失败')
  } finally {
    workflowLoading.value = false
  }
}

async function restoreDraft(workflowId: string, workflowName: string) {
  try {
    await ElMessageBox.confirm(`恢复后 “${workflowName || '未命名工作流'}” 将重新回到 draft 列表，是否继续？`, '恢复工作流', {
      confirmButtonText: '恢复',
      cancelButtonText: '取消',
      type: 'info',
    })
  } catch {
    return
  }

  try {
    workflowLoading.value = true
    const result = await restoreWorkflowDraft(workflowId)
    invalidateWorkflowDraftCatalogCache()
    await refreshWorkflows(workflowPagination.value.offset, { force: true })
    ElMessage.success(result.message || '工作流已恢复')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '恢复工作流失败')
  } finally {
    workflowLoading.value = false
  }
}

async function archiveDraft(workflowId: string, workflowName: string) {
  try {
    await ElMessageBox.confirm(`归档后将从默认草稿列表移出 “${workflowName || '未命名工作流'}”，是否继续？`, '归档工作流', {
      confirmButtonText: '归档',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }

  try {
    workflowLoading.value = true
    const result = await archiveWorkflowDraft(workflowId)
    invalidateWorkflowDraftCatalogCache()
    await refreshWorkflows(workflowPagination.value.offset, { force: true })
    ElMessage.success(result.message || '工作流已归档')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '归档工作流失败')
  } finally {
    workflowLoading.value = false
  }
}

function formatDateTime(value?: string) {
  if (!value) return '-'
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

onMounted(async () => {
  refreshRecentTemplates()
  refreshSavedViews()
  void refreshTeamViews()

  const storedSession = readWorkflowHubSessionState()
  if (shouldRestoreWorkflowHubSessionState(currentRouteState(), storedSession)) {
    const sessionState = storedSession!.state
    applyRouteState(sessionState)
    await syncHubQuery(sessionState.workflowOffset, sessionState.templateOffset)
    await refreshAll({ force: true })
    ElMessage.success('已恢复上次 Workflow Hub 会话')
    return
  }

  await refreshAll()
})

watch(
  () => route.query,
  async (query) => {
    const nextState = parseWorkflowHubRouteState(query)
    const currentState = currentRouteState()
    if (isWorkflowHubRouteStateEqual(nextState, currentState)) {
      return
    }

    applyRouteState(nextState)
    await refreshAll()
  },
)
</script>

<style scoped>
.workflow-hub {
  padding: 24px;
  display: grid;
  gap: 20px;
}

.workflow-hub__header,
.workflow-hub__saved-header,
.workflow-hub__card-header,
.workflow-hub__recent-header,
.workflow-hub__template-top,
.workflow-hub__pager {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}

.workflow-hub__header h1,
.workflow-hub__card-header h2,
.workflow-hub__template-top h3 {
  margin: 0;
}

.workflow-hub__header p,
.workflow-hub__card-header p,
.workflow-hub__template-top p,
.workflow-hub__secondary {
  margin: 6px 0 0;
  color: #6b7280;
}

.workflow-hub__grid {
  display: grid;
  gap: 20px;
  grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.95fr);
}

.workflow-hub__saved {
  display: grid;
  gap: 12px;
  padding: 18px;
  border-radius: 18px;
  border: 1px solid #dbeafe;
  background: linear-gradient(180deg, #f8fbff 0%, #eef6ff 100%);
}

.workflow-hub__saved-list {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}

.workflow-hub__saved-card {
  border: 1px solid #dbeafe;
  border-radius: 14px;
  padding: 14px;
  display: grid;
  gap: 10px;
  background: #fff;
}

.workflow-hub__actions,
.workflow-hub__toolbar,
.workflow-hub__pager-actions,
.workflow-hub__table-actions,
.workflow-hub__template-actions,
.workflow-hub__meta-row,
.workflow-hub__tag-list {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.workflow-hub__card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 18px;
  padding: 20px;
  display: grid;
  gap: 16px;
  align-self: start;
}

.workflow-hub__count,
.chip,
.tag {
  min-width: 32px;
  padding: 4px 10px;
  border-radius: 999px;
  text-align: center;
  font-size: 12px;
  font-weight: 600;
}

.workflow-hub__count {
  background: #eff6ff;
  color: #1d4ed8;
}

.chip {
  background: #f3f4f6;
  color: #374151;
}

.chip[data-tone='draft'] {
  background: #fff7ed;
  color: #c2410c;
}

.chip[data-tone='published'] {
  background: #ecfdf5;
  color: #047857;
}

.chip[data-tone='archived'] {
  background: #f3f4f6;
  color: #6b7280;
}

.chip[data-tone='owner'] {
  background: #ede9fe;
  color: #6d28d9;
}

.chip[data-tone='editor'] {
  background: #eff6ff;
  color: #1d4ed8;
}

.chip[data-tone='viewer'] {
  background: #f3f4f6;
  color: #4b5563;
}

.chip[data-tone='builtin'] {
  background: #ecfccb;
  color: #3f6212;
}

.chip[data-tone='database'] {
  background: #ede9fe;
  color: #7c3aed;
}

.tag {
  background: #f8fafc;
  color: #475569;
}

.workflow-hub__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

.workflow-hub__table th,
.workflow-hub__table td {
  padding: 10px 12px;
  border-bottom: 1px solid #f1f5f9;
  text-align: left;
  vertical-align: top;
}

.workflow-hub__primary {
  font-weight: 600;
}

.workflow-hub__template-list {
  display: grid;
  gap: 12px;
}

.workflow-hub__recent {
  display: grid;
  gap: 12px;
  padding: 16px;
  border-radius: 16px;
  border: 1px solid #dbeafe;
  background: linear-gradient(180deg, #f8fbff 0%, #eef6ff 100%);
}

.workflow-hub__recent-list {
  display: grid;
  gap: 12px;
}

.workflow-hub__recent-card {
  border: 1px solid #dbeafe;
  border-radius: 14px;
  padding: 14px;
  display: grid;
  gap: 10px;
  background: #fff;
}

.workflow-hub__template-card {
  border: 1px solid #e5e7eb;
  border-radius: 14px;
  padding: 14px;
  display: grid;
  gap: 12px;
  background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
}

.workflow-hub__meta-row {
  font-size: 12px;
  color: #64748b;
}

.workflow-hub__input,
.workflow-hub__select {
  min-height: 38px;
  border: 1px solid #d1d5db;
  border-radius: 10px;
  padding: 0 12px;
  background: #fff;
  color: #111827;
}

.workflow-hub__input {
  min-width: 220px;
  flex: 1;
}

.workflow-hub__select {
  min-width: 160px;
}

.workflow-hub__empty,
.workflow-hub__error {
  padding: 18px;
  border-radius: 12px;
  background: #f8fafc;
  color: #475569;
}

.workflow-hub__error {
  background: #fef2f2;
  color: #b91c1c;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 36px;
  padding: 0 14px;
  border-radius: 10px;
  border: 1px solid #d1d5db;
  background: #fff;
  color: #111827;
  text-decoration: none;
  cursor: pointer;
}

.btn--primary {
  background: #111827;
  border-color: #111827;
  color: #fff;
}

.btn--ghost {
  background: #fff;
}

.btn--mini {
  min-height: 28px;
  padding: 0 10px;
  font-size: 12px;
}

@media (max-width: 1080px) {
  .workflow-hub__grid {
    grid-template-columns: 1fr;
  }
}
</style>
