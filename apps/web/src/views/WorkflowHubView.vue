<template>
  <section class="workflow-hub">
    <header class="workflow-hub__header">
      <div>
        <h1>{{ workflowHubLabel('header.title', isZh) }}</h1>
        <p>{{ workflowHubLabel('header.subtitle', isZh) }}</p>
      </div>
      <div class="workflow-hub__actions">
        <button class="btn btn--ghost" type="button" @click="saveCurrentView">
          {{ workflowHubLabel('actions.saveView', isZh) }}
        </button>
        <button class="btn btn--ghost" type="button" @click="saveCurrentTeamView">
          {{ workflowHubLabel('actions.saveTeamView', isZh) }}
        </button>
        <button class="btn btn--ghost" type="button" :disabled="isRefreshing" @click="refreshAll({ force: true })">
          {{ isRefreshing ? workflowHubLabel('actions.refreshing', isZh) : workflowHubLabel('actions.refresh', isZh) }}
        </button>
        <router-link class="btn btn--primary" :to="{ name: 'workflow-designer' }">
          {{ workflowHubLabel('actions.newWorkflow', isZh) }}
        </router-link>
      </div>
    </header>

    <section class="workflow-hub__saved" v-if="savedViews.length">
      <div class="workflow-hub__saved-header">
        <div>
          <h2>{{ workflowHubLabel('savedViews.title', isZh) }}</h2>
          <p>{{ workflowHubLabel('savedViews.subtitle', isZh) }}</p>
        </div>
        <button class="btn btn--ghost" type="button" @click="saveCurrentView">
          {{ workflowHubLabel('savedViews.saveCurrent', isZh) }}
        </button>
      </div>
      <div class="workflow-hub__saved-list">
        <article v-for="view in savedViews" :key="view.id" class="workflow-hub__saved-card">
          <div class="workflow-hub__template-top">
            <div>
              <h3>{{ view.name }}</h3>
              <p>{{ describeSavedView(view.state) }}</p>
            </div>
            <span class="chip">{{ workflowHubLabel('savedViews.chip', isZh) }}</span>
          </div>
          <div class="workflow-hub__meta-row">
            <span>{{ workflowHubLabel('savedViews.updatedPrefix', isZh) }} {{ formatDateTime(view.updatedAt) }}</span>
          </div>
          <div class="workflow-hub__template-actions">
            <button class="btn btn--primary btn--mini" type="button" @click="applySavedView(view.id)">
              {{ workflowHubLabel('savedViews.apply', isZh) }}
            </button>
            <button class="btn btn--ghost btn--mini" type="button" @click="deleteSavedView(view.id, view.name)">
              {{ workflowHubLabel('savedViews.delete', isZh) }}
            </button>
          </div>
        </article>
      </div>
    </section>

    <section class="workflow-hub__saved" v-if="teamViews.length || teamViewsError">
      <div class="workflow-hub__saved-header">
        <div>
          <h2>{{ workflowHubLabel('teamViews.title', isZh) }}</h2>
          <p>{{ workflowHubLabel('teamViews.subtitle', isZh) }}</p>
        </div>
        <button class="btn btn--ghost" type="button" :disabled="teamViewsLoading" @click="saveCurrentTeamView">
          {{ teamViewsLoading ? workflowHubLabel('teamViews.saving', isZh) : workflowHubLabel('actions.saveTeamView', isZh) }}
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
            <span class="chip" data-tone="team">{{ workflowHubLabel('teamViews.chip', isZh) }}</span>
          </div>
          <div class="workflow-hub__meta-row">
            <span>{{ workflowHubLabel('teamViews.ownerPrefix', isZh) }} {{ view.ownerUserId || workflowHubLabel('teamViews.systemOwner', isZh) }}</span>
            <span>{{ workflowHubLabel('savedViews.updatedPrefix', isZh) }} {{ formatDateTime(view.updatedAt) }}</span>
          </div>
          <div class="workflow-hub__template-actions">
            <button class="btn btn--primary btn--mini" type="button" @click="applyTeamView(view.id)">
              {{ workflowHubLabel('savedViews.apply', isZh) }}
            </button>
            <button
              v-if="view.canManage"
              class="btn btn--ghost btn--mini"
              type="button"
              :disabled="teamViewsLoading"
              @click="deleteTeamView(view.id, view.name)"
            >
              {{ workflowHubLabel('savedViews.delete', isZh) }}
            </button>
          </div>
        </article>
      </div>
    </section>

    <div class="workflow-hub__grid">
      <article class="workflow-hub__card">
        <div class="workflow-hub__card-header">
          <div>
            <h2>{{ workflowHubLabel('workflowCard.title', isZh) }}</h2>
            <p>{{ workflowHubLabel('workflowCard.subtitle', isZh) }}</p>
          </div>
          <span class="workflow-hub__count">{{ workflowPagination.total }}</span>
        </div>

        <div class="workflow-hub__toolbar">
          <input
            v-model="workflowSearch"
            class="workflow-hub__input"
            type="search"
            :placeholder="workflowHubLabel('workflowCard.searchPlaceholder', isZh)"
            @keydown.enter="refreshWorkflows(0)"
          />
          <select v-model="workflowStatus" class="workflow-hub__select" @change="refreshWorkflows(0)">
            <option value="">{{ workflowHubLabel('statusFilter.all', isZh) }}</option>
            <option value="draft">{{ workflowHubLabel('statusFilter.draft', isZh) }}</option>
            <option value="published">{{ workflowHubLabel('statusFilter.published', isZh) }}</option>
            <option value="archived">{{ workflowHubLabel('statusFilter.archived', isZh) }}</option>
          </select>
          <select v-model="workflowSortBy" class="workflow-hub__select" @change="refreshWorkflows(0)">
            <option value="updated_at">{{ workflowHubLabel('sortBy.recentlyUpdated', isZh) }}</option>
            <option value="created_at">{{ workflowHubLabel('sortBy.recentlyCreated', isZh) }}</option>
            <option value="name">{{ workflowHubLabel('sortBy.name', isZh) }}</option>
          </select>
          <button class="btn btn--ghost" type="button" :disabled="workflowLoading" @click="refreshWorkflows(0)">
            {{ workflowLoading ? workflowHubLabel('workflowCard.loading', isZh) : workflowHubLabel('workflowCard.apply', isZh) }}
          </button>
        </div>

        <p v-if="workflowError" class="workflow-hub__error">{{ workflowError }}</p>

        <div v-if="workflowLoading" class="workflow-hub__empty">{{ workflowHubLabel('workflowCard.loadingDrafts', isZh) }}</div>
        <div v-else-if="!workflowItems.length" class="workflow-hub__empty">
          {{ workflowHubLabel('workflowCard.noMatch', isZh) }}
        </div>
        <table v-else class="workflow-hub__table">
          <thead>
            <tr>
              <th>{{ workflowHubLabel('workflowCard.colName', isZh) }}</th>
              <th>{{ workflowHubLabel('workflowCard.colStatus', isZh) }}</th>
              <th>{{ workflowHubLabel('workflowCard.colRole', isZh) }}</th>
              <th>{{ workflowHubLabel('workflowCard.colCategory', isZh) }}</th>
              <th>{{ workflowHubLabel('workflowCard.colUpdated', isZh) }}</th>
              <th>{{ workflowHubLabel('workflowCard.colActions', isZh) }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="workflow in workflowItems" :key="workflow.id">
              <td>
                <div class="workflow-hub__primary">{{ workflow.name || workflowHubLabel('workflowCard.unnamed', isZh) }}</div>
                <div class="workflow-hub__secondary">{{ workflow.description || workflowHubLabel('workflowCard.noDescription', isZh) }}</div>
              </td>
              <td><span class="chip" :data-tone="workflow.status">{{ workflowStatusChipLabel(workflow.status, isZh) }}</span></td>
              <td><span class="chip" :data-tone="workflow.role || 'viewer'">{{ workflowRoleChipLabel(workflow.role || 'viewer', isZh) }}</span></td>
              <td>{{ workflow.category || '-' }}</td>
              <td>{{ formatDateTime(workflow.updatedAt) }}</td>
              <td>
                <div class="workflow-hub__table-actions">
                  <router-link class="btn btn--ghost btn--mini" :to="{ name: 'workflow-designer', params: { id: workflow.id } }">
                    {{ workflowHubLabel('action.open', isZh) }}
                  </router-link>
                  <button class="btn btn--ghost btn--mini" type="button" :disabled="workflowLoading" @click="duplicateDraft(workflow.id, workflow.name)">
                    {{ workflowHubLabel('action.duplicate', isZh) }}
                  </button>
                  <button
                    v-if="workflow.status !== 'archived'"
                    class="btn btn--ghost btn--mini"
                    type="button"
                    :disabled="workflowLoading || workflow.status === 'archived' || workflow.role === 'viewer'"
                    @click="archiveDraft(workflow.id, workflow.name)"
                  >
                    {{ workflowHubLabel('action.archive', isZh) }}
                  </button>
                  <button
                    v-else
                    class="btn btn--ghost btn--mini"
                    type="button"
                    :disabled="workflowLoading || workflow.role === 'viewer'"
                    @click="restoreDraft(workflow.id, workflow.name)"
                  >
                    {{ workflowHubLabel('action.restore', isZh) }}
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
              {{ workflowHubLabel('pager.previous', isZh) }}
            </button>
            <button class="btn btn--ghost btn--mini" type="button" :disabled="workflowLoading || workflowPagination.offset + workflowPagination.returned >= workflowPagination.total" @click="refreshWorkflows(workflowPagination.offset + workflowPagination.limit)">
              {{ workflowHubLabel('pager.next', isZh) }}
            </button>
          </div>
        </footer>
      </article>

      <article class="workflow-hub__card">
        <div class="workflow-hub__card-header">
          <div>
            <h2>{{ workflowHubLabel('templateCard.title', isZh) }}</h2>
            <p>{{ workflowHubLabel('templateCard.subtitle', isZh) }}</p>
          </div>
          <span class="workflow-hub__count">{{ templatePagination.total }}</span>
        </div>

        <section v-if="recentTemplateItems.length" class="workflow-hub__recent">
          <div class="workflow-hub__recent-header">
            <div>
              <h3>{{ workflowHubLabel('recentTemplates.title', isZh) }}</h3>
              <p>{{ workflowHubLabel('recentTemplates.subtitle', isZh) }}</p>
            </div>
          </div>
          <div class="workflow-hub__recent-list">
            <article v-for="template in recentTemplateItems" :key="template.id" class="workflow-hub__recent-card">
              <div class="workflow-hub__template-top">
                <div>
                  <h3>{{ template.name }}</h3>
                  <p>{{ template.description || workflowHubLabel('templateCard.noDescription', isZh) }}</p>
                </div>
                <span class="chip" :data-tone="template.source">{{ templateSourceChipLabel(template.source, isZh) }}</span>
              </div>
              <div class="workflow-hub__meta-row">
                <span>{{ template.category }}</span>
                <span>{{ workflowHubLabel('recentTemplates.lastUsedPrefix', isZh) }} {{ formatDateTime(template.usedAt) }}</span>
              </div>
              <div class="workflow-hub__template-actions">
                <router-link
                  class="btn btn--primary btn--mini"
                  :to="{ name: 'workflow-designer', query: { templateId: template.id } }"
                >
                  {{ workflowHubLabel('recentTemplates.useAgain', isZh) }}
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
            :placeholder="workflowHubLabel('templateCard.searchPlaceholder', isZh)"
            @keydown.enter="refreshTemplates(0)"
          />
          <select v-model="templateSource" class="workflow-hub__select" @change="refreshTemplates(0)">
            <option value="all">{{ workflowHubLabel('sourceFilter.all', isZh) }}</option>
            <option value="builtin">{{ workflowHubLabel('sourceFilter.builtin', isZh) }}</option>
            <option value="database">{{ workflowHubLabel('sourceFilter.database', isZh) }}</option>
          </select>
          <select v-model="templateSortBy" class="workflow-hub__select" @change="refreshTemplates(0)">
            <option value="usage_count">{{ workflowHubLabel('templateSortBy.usage', isZh) }}</option>
            <option value="name">{{ workflowHubLabel('templateSortBy.name', isZh) }}</option>
            <option value="updated_at">{{ workflowHubLabel('templateSortBy.updated', isZh) }}</option>
          </select>
          <button class="btn btn--ghost" type="button" :disabled="templateLoading" @click="refreshTemplates(0)">
            {{ templateLoading ? workflowHubLabel('templateCard.loading', isZh) : workflowHubLabel('templateCard.apply', isZh) }}
          </button>
        </div>

        <p v-if="templateError" class="workflow-hub__error">{{ templateError }}</p>

        <div v-if="templateLoading" class="workflow-hub__empty">{{ workflowHubLabel('templateCard.loadingTemplates', isZh) }}</div>
        <div v-else-if="!templateItems.length" class="workflow-hub__empty">
          {{ workflowHubLabel('templateCard.noMatch', isZh) }}
        </div>
        <div v-else class="workflow-hub__template-list">
          <article v-for="template in templateItems" :key="template.id" class="workflow-hub__template-card">
            <div class="workflow-hub__template-top">
              <div>
                <h3>{{ template.name }}</h3>
                <p>{{ template.description || workflowHubLabel('templateCard.noDescription', isZh) }}</p>
              </div>
              <span class="chip" :data-tone="template.source">{{ templateSourceChipLabel(template.source, isZh) }}</span>
            </div>
            <div class="workflow-hub__meta-row">
              <span>{{ template.category }}</span>
              <span>{{ workflowHubLabel('templateCard.requiredPrefix', isZh) }} {{ template.requiredVariables.length }}</span>
              <span>{{ workflowHubLabel('templateCard.optionalPrefix', isZh) }} {{ template.optionalVariables.length }}</span>
              <span>{{ workflowHubLabel('templateCard.usagePrefix', isZh) }} {{ template.usageCount }}</span>
            </div>
            <div v-if="template.tags.length" class="workflow-hub__tag-list">
              <span v-for="tag in template.tags" :key="tag" class="tag">{{ tag }}</span>
            </div>
            <div class="workflow-hub__template-actions">
              <router-link
                class="btn btn--primary btn--mini"
                :to="{ name: 'workflow-designer', query: { templateId: template.id } }"
              >
                {{ workflowHubLabel('templateCard.useTemplate', isZh) }}
              </router-link>
            </div>
          </article>
        </div>

        <footer class="workflow-hub__pager">
          <span>{{ templateRangeLabel }}</span>
          <div class="workflow-hub__pager-actions">
            <button class="btn btn--ghost btn--mini" type="button" :disabled="templateLoading || templatePagination.offset === 0" @click="refreshTemplates(Math.max(0, templatePagination.offset - templatePagination.limit))">
              {{ workflowHubLabel('pager.previous', isZh) }}
            </button>
            <button class="btn btn--ghost btn--mini" type="button" :disabled="templateLoading || templatePagination.offset + templatePagination.returned >= templatePagination.total" @click="refreshTemplates(templatePagination.offset + templatePagination.limit)">
              {{ workflowHubLabel('pager.next', isZh) }}
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
import { useLocale } from '../composables/useLocale'
import {
  templateSourceChipLabel,
  workflowHubArchiveConfirm,
  workflowHubDeleteTeamViewConfirm,
  workflowHubDeleteViewConfirm,
  workflowHubDuplicatePrompt,
  workflowHubLabel,
  workflowHubRangeLabel,
  workflowHubRestoreConfirm,
  workflowHubSharedByLabel,
  workflowHubSwitchedToTeamViewLabel,
  workflowHubSwitchedToViewLabel,
  workflowRoleChipLabel,
  workflowStatusChipLabel,
} from './workflowHubLabels'

const { isZh } = useLocale()
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
  if (!workflowPagination.value.total) return workflowHubLabel('pager.zeroItems', isZh.value)
  const start = workflowPagination.value.offset + 1
  const end = workflowPagination.value.offset + workflowPagination.value.returned
  return workflowHubRangeLabel(start, end, workflowPagination.value.total, isZh.value)
})

const templateRangeLabel = computed(() => {
  if (!templatePagination.value.total) return workflowHubLabel('pager.zeroItems', isZh.value)
  const start = templatePagination.value.offset + 1
  const end = templatePagination.value.offset + templatePagination.value.returned
  return workflowHubRangeLabel(start, end, templatePagination.value.total, isZh.value)
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
    workflowError.value = error instanceof Error ? error.message : workflowHubLabel('error.loadWorkflowDrafts', isZh.value)
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
    templateError.value = error instanceof Error ? error.message : workflowHubLabel('error.loadWorkflowTemplates', isZh.value)
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
    teamViewsError.value = error instanceof Error ? error.message : workflowHubLabel('error.loadTeamViews', isZh.value)
    teamViews.value = []
  } finally {
    teamViewsLoading.value = false
  }
}

function describeSavedView(state: WorkflowHubRouteState) {
  const parts: string[] = []
  if (state.workflowSearch) parts.push(`${workflowHubLabel('label.workflowSearchPrefix', isZh.value)}${state.workflowSearch}`)
  if (state.workflowStatus) parts.push(`${workflowHubLabel('label.statusPrefix', isZh.value)}${state.workflowStatus}`)
  if (state.templateSearch) parts.push(`${workflowHubLabel('label.templateSearchPrefix', isZh.value)}${state.templateSearch}`)
  if (state.templateSource !== 'all') parts.push(`${workflowHubLabel('label.sourcePrefix', isZh.value)}${state.templateSource}`)
  if (state.workflowOffset > 0) parts.push(`${workflowHubLabel('label.workflowPagePrefix', isZh.value)}${state.workflowOffset / workflowPagination.value.limit + 1}`)
  if (state.templateOffset > 0) parts.push(`${workflowHubLabel('label.templatePagePrefix', isZh.value)}${state.templateOffset / templatePagination.value.limit + 1}`)
  return parts.length ? parts.join(' · ') : workflowHubLabel('label.defaultView', isZh.value)
}

function describeTeamView(view: WorkflowHubTeamView) {
  const summary = describeSavedView(view.state)
  const owner = view.ownerUserId || workflowHubLabel('teamViews.systemOwner', isZh.value)
  return summary === workflowHubLabel('label.defaultView', isZh.value)
    ? workflowHubSharedByLabel(owner, isZh.value)
    : `${summary} · ${workflowHubSharedByLabel(owner, isZh.value)}`
}

async function saveCurrentView() {
  try {
    const promptResult = await ElMessageBox.prompt(
      workflowHubLabel('dialog.saveView.prompt', isZh.value),
      workflowHubLabel('dialog.saveView.title', isZh.value),
      {
        confirmButtonText: workflowHubLabel('dialog.saveView.confirm', isZh.value),
        cancelButtonText: workflowHubLabel('dialog.saveView.cancel', isZh.value),
        inputPlaceholder: workflowHubLabel('dialog.saveView.placeholder', isZh.value),
      },
    )
    const trimmed = promptResult.value.trim()
    if (!trimmed) return
    savedViews.value = saveWorkflowHubSavedView(trimmed, currentRouteState())
    ElMessage.success(workflowHubLabel('dialog.saveView.success', isZh.value))
  } catch {
    return
  }
}

async function saveCurrentTeamView() {
  try {
    const promptResult = await ElMessageBox.prompt(
      workflowHubLabel('dialog.saveTeamView.prompt', isZh.value),
      workflowHubLabel('dialog.saveTeamView.title', isZh.value),
      {
        confirmButtonText: workflowHubLabel('dialog.saveView.confirm', isZh.value),
        cancelButtonText: workflowHubLabel('dialog.saveView.cancel', isZh.value),
        inputPlaceholder: workflowHubLabel('dialog.saveTeamView.placeholder', isZh.value),
      },
    )
    const trimmed = promptResult.value.trim()
    if (!trimmed) return

    teamViewsLoading.value = true
    const saved = await saveWorkflowHubTeamView(trimmed, currentRouteState())
    teamViews.value = [saved, ...teamViews.value.filter((item) => item.id !== saved.id)]
      .sort((left, right) => (right.updatedAt || '').localeCompare(left.updatedAt || ''))
    ElMessage.success(workflowHubLabel('dialog.saveTeamView.success', isZh.value))
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
  ElMessage.success(workflowHubSwitchedToViewLabel(target.name, isZh.value))
}

async function applyTeamView(viewId: string) {
  const target = teamViews.value.find((item) => item.id === viewId)
  if (!target) return

  applyRouteState(target.state)
  await syncHubQuery(target.state.workflowOffset, target.state.templateOffset)
  await refreshAll({ force: true })
  ElMessage.success(workflowHubSwitchedToTeamViewLabel(target.name, isZh.value))
}

async function deleteSavedView(viewId: string, viewName: string) {
  try {
    await ElMessageBox.confirm(workflowHubDeleteViewConfirm(viewName, isZh.value), workflowHubLabel('dialog.deleteView.title', isZh.value), {
      confirmButtonText: workflowHubLabel('dialog.deleteView.confirm', isZh.value),
      cancelButtonText: workflowHubLabel('dialog.deleteView.cancel', isZh.value),
      type: 'warning',
    })
  } catch {
    return
  }

  savedViews.value = removeWorkflowHubSavedView(viewId)
  ElMessage.success(workflowHubLabel('dialog.deleteView.success', isZh.value))
}

async function deleteTeamView(viewId: string, viewName: string) {
  try {
    await ElMessageBox.confirm(workflowHubDeleteTeamViewConfirm(viewName, isZh.value), workflowHubLabel('dialog.deleteTeamView.title', isZh.value), {
      confirmButtonText: workflowHubLabel('dialog.deleteView.confirm', isZh.value),
      cancelButtonText: workflowHubLabel('dialog.deleteView.cancel', isZh.value),
      type: 'warning',
    })
  } catch {
    return
  }

  try {
    teamViewsLoading.value = true
    await deleteWorkflowHubTeamView(viewId)
    teamViews.value = teamViews.value.filter((item) => item.id !== viewId)
    ElMessage.success(workflowHubLabel('dialog.deleteTeamView.success', isZh.value))
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : workflowHubLabel('dialog.deleteTeamView.errorFallback', isZh.value))
  } finally {
    teamViewsLoading.value = false
  }
}

async function duplicateDraft(workflowId: string, workflowName: string) {
  let nextName: string | undefined

  try {
    const promptResult = await ElMessageBox.prompt(
      workflowHubDuplicatePrompt(workflowName, isZh.value),
      workflowHubLabel('dialog.duplicate.title', isZh.value),
      {
        confirmButtonText: workflowHubLabel('dialog.duplicate.confirm', isZh.value),
        cancelButtonText: workflowHubLabel('dialog.saveView.cancel', isZh.value),
        inputPlaceholder: workflowHubLabel('dialog.duplicate.placeholder', isZh.value),
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
    ElMessage.success(result.message || workflowHubLabel('dialog.duplicate.successFallback', isZh.value))
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : workflowHubLabel('dialog.duplicate.errorFallback', isZh.value))
  } finally {
    workflowLoading.value = false
  }
}

async function restoreDraft(workflowId: string, workflowName: string) {
  try {
    await ElMessageBox.confirm(workflowHubRestoreConfirm(workflowName, isZh.value), workflowHubLabel('dialog.restore.title', isZh.value), {
      confirmButtonText: workflowHubLabel('dialog.restore.confirm', isZh.value),
      cancelButtonText: workflowHubLabel('dialog.saveView.cancel', isZh.value),
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
    ElMessage.success(result.message || workflowHubLabel('dialog.restore.successFallback', isZh.value))
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : workflowHubLabel('dialog.restore.errorFallback', isZh.value))
  } finally {
    workflowLoading.value = false
  }
}

async function archiveDraft(workflowId: string, workflowName: string) {
  try {
    await ElMessageBox.confirm(workflowHubArchiveConfirm(workflowName, isZh.value), workflowHubLabel('dialog.archive.title', isZh.value), {
      confirmButtonText: workflowHubLabel('dialog.archive.confirm', isZh.value),
      cancelButtonText: workflowHubLabel('dialog.saveView.cancel', isZh.value),
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
    ElMessage.success(result.message || workflowHubLabel('dialog.archive.successFallback', isZh.value))
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : workflowHubLabel('dialog.archive.errorFallback', isZh.value))
  } finally {
    workflowLoading.value = false
  }
}

function formatDateTime(value?: string) {
  if (!value) return '-'
  return new Date(value).toLocaleString(isZh.value ? 'zh-CN' : 'en-US', {
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
    ElMessage.success(workflowHubLabel('session.restored', isZh.value))
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
