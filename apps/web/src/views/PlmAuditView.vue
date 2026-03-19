<template>
  <section class="plm-audit">
    <header class="plm-audit__header">
      <div>
        <p class="plm-audit__eyebrow">{{ tr('PLM collaborative operations', 'PLM 协作操作') }}</p>
        <h1>{{ tr('PLM Audit', 'PLM 审计') }}</h1>
        <p class="plm-audit__subtitle">
          {{ tr('Track batch archive, restore, and delete activity across presets and team views.', '查看预设和团队视图的批量归档、恢复、删除审计。') }}
        </p>
      </div>
      <div class="plm-audit__actions">
        <button class="plm-audit__button" type="button" :disabled="exporting" @click="exportCsv">
          {{ exporting ? tr('Exporting...', '导出中...') : tr('Export CSV', '导出 CSV') }}
        </button>
        <button class="plm-audit__button" type="button" :disabled="summaryLoading" @click="loadSummary()">
          {{ summaryLoading ? tr('Refreshing...', '刷新中...') : tr('Refresh summary', '刷新汇总') }}
        </button>
        <button class="plm-audit__button plm-audit__button--primary" type="button" :disabled="logsLoading" @click="reloadLogs">
          {{ logsLoading ? tr('Loading...', '加载中...') : tr('Reload logs', '重载日志') }}
        </button>
      </div>
    </header>

    <section v-if="auditSceneContext" class="plm-audit__context">
      <div>
        <small class="plm-audit__summary-source">{{ auditSceneContext.sourceLabel }}</small>
        <strong>{{ auditSceneContext.title }}</strong>
        <p class="plm-audit__muted">{{ auditSceneContext.description }}</p>
      </div>
      <div class="plm-audit__context-meta">
        <span v-if="auditSceneContext.sceneName">{{ tr('Scene', '场景') }}: {{ auditSceneContext.sceneName }}</span>
        <span v-if="auditSceneContext.sceneId">ID: {{ auditSceneContext.sceneId }}</span>
        <span v-if="auditSceneContext.sceneOwnerUserId">Owner: {{ auditSceneContext.sceneOwnerUserId }}</span>
      </div>
      <div class="plm-audit__context-actions">
        <button
          v-for="actionItem in auditSceneToken?.actions || []"
          :key="`scene-context-${actionItem.kind}-${actionItem.emphasis}`"
          class="plm-audit__button"
          type="button"
          :disabled="logsLoading"
          @click="runAuditSceneTokenAction(actionItem.kind)"
        >
          {{ actionItem.label }}
        </button>
      </div>
    </section>

    <section class="plm-audit__summary">
      <article class="plm-audit__summary-card">
        <span class="plm-audit__summary-label">{{ tr('Window', '窗口') }}</span>
        <strong>{{ summary.windowMinutes }} {{ tr('minutes', '分钟') }}</strong>
      </article>
      <article class="plm-audit__summary-card">
        <span class="plm-audit__summary-label">{{ tr('Resource buckets', '资源桶') }}</span>
        <strong>{{ totalSummaryEvents }}</strong>
      </article>
      <article class="plm-audit__summary-card">
        <span class="plm-audit__summary-label">{{ tr('Top actions', '主要动作') }}</span>
        <strong>{{ actionLabel(summary.actions[0]?.action || '') || '--' }}</strong>
      </article>
      <article
        v-if="auditSceneSummaryCard"
        class="plm-audit__summary-card plm-audit__summary-card--context"
        :class="{
          'plm-audit__summary-card--active': auditSceneSummaryCard.active,
          'plm-audit__summary-card--owner': auditSceneSummaryCard.kind === 'owner',
          'plm-audit__summary-card--scene': auditSceneSummaryCard.kind === 'scene',
        }"
      >
        <small class="plm-audit__summary-source">{{ auditSceneSummaryCard.sourceLabel }}</small>
        <span class="plm-audit__summary-label">{{ auditSceneSummaryCard.label }}</span>
        <strong>{{ auditSceneSummaryCard.value }}</strong>
        <span class="plm-audit__muted">{{ auditSceneSummaryCard.description }}</span>
        <button
          v-if="auditSceneSummaryCard.action"
          class="plm-audit__button plm-audit__button--inline"
          type="button"
          :disabled="logsLoading"
          @click="runAuditSceneSummaryAction(auditSceneSummaryCard.action)"
        >
          {{ auditSceneSummaryCard.actionLabel }}
        </button>
      </article>
    </section>

    <section class="plm-audit__summary-grid">
      <div class="plm-audit__summary-panel">
        <h2>{{ tr('Actions', '动作') }}</h2>
        <div v-if="summary.actions.length" class="plm-audit__pill-list">
          <span v-for="item in summary.actions" :key="`action-${item.action || 'unknown'}`" class="plm-audit__pill">
            {{ actionLabel(item.action || '') }} · {{ item.total }}
          </span>
        </div>
        <p v-else class="plm-audit__empty">{{ tr('No action data yet.', '暂无动作数据。') }}</p>
      </div>
      <div class="plm-audit__summary-panel">
        <h2>{{ tr('Resource types', '资源类型') }}</h2>
        <div v-if="summary.resourceTypes.length" class="plm-audit__pill-list">
          <span v-for="item in summary.resourceTypes" :key="`type-${item.resourceType}`" class="plm-audit__pill">
            {{ resourceTypeLabel(item.resourceType) }} · {{ item.total }}
          </span>
        </div>
        <p v-else class="plm-audit__empty">{{ tr('No resource data yet.', '暂无资源数据。') }}</p>
      </div>
    </section>

    <form class="plm-audit__filters" @submit.prevent="applyFilters">
      <div
        v-if="auditSceneFilterHighlight"
        class="plm-audit__filter-highlight"
        :class="{
          'plm-audit__filter-highlight--owner': auditSceneFilterHighlight.kind === 'owner',
          'plm-audit__filter-highlight--scene': auditSceneFilterHighlight.kind === 'scene',
        }"
      >
        <div>
          <small class="plm-audit__summary-source">{{ auditSceneFilterHighlight.sourceLabel }}</small>
          <strong>{{ auditSceneFilterHighlight.label }}</strong>
          <span class="plm-audit__filter-highlight-value">{{ auditSceneFilterHighlight.value }}</span>
          <p class="plm-audit__muted">{{ auditSceneFilterHighlight.description }}</p>
        </div>
        <button
          v-for="actionItem in auditSceneFilterHighlight.actions"
          :key="`scene-filter-${actionItem.kind}-${actionItem.emphasis}`"
          class="plm-audit__button plm-audit__button--inline"
          type="button"
          :disabled="logsLoading"
          @click="runAuditSceneTokenAction(actionItem.kind)"
        >
          {{ actionItem.label }}
        </button>
      </div>

      <label class="plm-audit__field" :class="{ 'plm-audit__field--active': auditSceneOwnerContextActive || auditSceneQueryContextActive }">
        <span>{{ tr('Search', '搜索') }}</span>
        <div
          v-if="auditSceneInputToken"
          class="plm-audit__field-token"
          :class="{
            'plm-audit__field-token--locked': auditSceneInputToken.locked,
            'plm-audit__field-token--owner': auditSceneInputToken.kind === 'owner',
            'plm-audit__field-token--scene': auditSceneInputToken.kind === 'scene',
          }"
        >
          <div class="plm-audit__field-token-meta">
            <strong>{{ auditSceneInputToken.label }}</strong>
            <span class="plm-audit__field-token-value">{{ auditSceneInputToken.value }}</span>
            <small class="plm-audit__muted">{{ auditSceneInputToken.description }}</small>
          </div>
          <div class="plm-audit__field-token-actions">
            <button
              v-for="actionItem in auditSceneInputToken.actions"
              :key="`scene-input-${actionItem.kind}-${actionItem.emphasis}`"
              class="plm-audit__button plm-audit__button--inline"
              type="button"
              :disabled="logsLoading"
              @click="runAuditSceneTokenAction(actionItem.kind)"
            >
              {{ actionItem.label }}
            </button>
          </div>
        </div>
        <input v-model="query" type="text" :placeholder="tr('Search actor, resource, or metadata', '搜索操作者、资源或元数据')" />
      </label>
      <label class="plm-audit__field">
        <span>{{ tr('Actor', '操作者') }}</span>
        <input v-model="actorId" type="text" :placeholder="tr('actor id', '操作者 ID')" />
      </label>
      <label class="plm-audit__field">
        <span>{{ tr('Kind', '类型') }}</span>
        <select v-model="kind">
          <option value="">{{ tr('All', '全部') }}</option>
          <option value="bom">BOM</option>
          <option value="where-used">Where-Used</option>
          <option value="documents">Documents</option>
          <option value="cad">CAD</option>
          <option value="approvals">Approvals</option>
          <option value="workbench">Workbench</option>
        </select>
      </label>
      <label class="plm-audit__field">
        <span>{{ tr('Action', '动作') }}</span>
        <select v-model="action">
          <option value="">{{ tr('All', '全部') }}</option>
          <option value="archive">{{ tr('Archive', '归档') }}</option>
          <option value="restore">{{ tr('Restore', '恢复') }}</option>
          <option value="delete">{{ tr('Delete', '删除') }}</option>
          <option value="set-default">{{ tr('Set default', '设为默认') }}</option>
          <option value="clear-default">{{ tr('Clear default', '取消默认') }}</option>
        </select>
      </label>
      <label class="plm-audit__field">
        <span>{{ tr('Resource', '资源') }}</span>
        <select v-model="resourceType">
          <option value="">{{ tr('All', '全部') }}</option>
          <option value="plm-team-preset-batch">{{ tr('Team preset batch', '团队预设批量') }}</option>
          <option value="plm-team-view-batch">{{ tr('Team view batch', '团队视图批量') }}</option>
          <option value="plm-team-view-default">{{ tr('Team default scene', '团队默认场景') }}</option>
        </select>
      </label>
      <label class="plm-audit__field">
        <span>{{ tr('Window', '窗口') }}</span>
        <select v-model="windowMinutes">
          <option :value="60">60 {{ tr('minutes', '分钟') }}</option>
          <option :value="180">180 {{ tr('minutes', '分钟') }}</option>
          <option :value="720">720 {{ tr('minutes', '分钟') }}</option>
          <option :value="1440">1440 {{ tr('minutes', '分钟') }}</option>
        </select>
      </label>
      <label class="plm-audit__field">
        <span>{{ tr('From', '起始') }}</span>
        <input v-model="from" type="datetime-local" />
      </label>
      <label class="plm-audit__field">
        <span>{{ tr('To', '截止') }}</span>
        <input v-model="to" type="datetime-local" />
      </label>
      <div class="plm-audit__filter-actions">
        <button class="plm-audit__button plm-audit__button--primary" type="submit" :disabled="logsLoading">
          {{ tr('Apply filters', '应用过滤') }}
        </button>
        <button class="plm-audit__button" type="button" :disabled="logsLoading" @click="resetFilters">
          {{ tr('Reset', '重置') }}
        </button>
      </div>
    </form>

    <section class="plm-audit__team-views">
      <div class="plm-audit__saved-views-header">
        <div>
          <h2>{{ tr('Team views', '团队视图') }}</h2>
          <p class="plm-audit__muted">
            {{ tr('Persist an audit view for the whole PLM team and reopen it through an explicit deep link.', '把审计视图保存为团队视角，并通过显式 deep link 重新打开。') }}
          </p>
        </div>
        <button class="plm-audit__button" type="button" :disabled="auditTeamViewsLoading" @click="refreshAuditTeamViews">
          {{ auditTeamViewsLoading ? tr('Refreshing...', '刷新中...') : tr('Refresh team views', '刷新团队视图') }}
        </button>
      </div>

      <div class="plm-audit__team-view-row">
        <select v-model="auditTeamViewKey" class="plm-audit__saved-view-input">
          <option value="">{{ tr('Select team view', '选择团队视图') }}</option>
          <option v-for="view in auditTeamViews" :key="view.id" :value="view.id">
            {{ view.name }} · {{ view.ownerUserId }}{{ view.isDefault ? ' · 默认' : '' }}{{ view.isArchived ? ' · 已归档' : '' }}
          </option>
        </select>
        <button class="plm-audit__button" type="button" :disabled="!canApplyAuditTeamView || auditTeamViewsLoading" @click="applyAuditTeamView">
          {{ tr('Apply', '应用') }}
        </button>
        <button class="plm-audit__button" type="button" :disabled="!canShareAuditTeamView || auditTeamViewsLoading" @click="shareAuditTeamView">
          {{ tr('Share', '分享') }}
        </button>
        <button class="plm-audit__button" type="button" :disabled="!canSetAuditTeamViewDefault || auditTeamViewsLoading" @click="setAuditTeamViewDefault">
          {{ tr('Set default', '设为默认') }}
        </button>
        <button class="plm-audit__button" type="button" :disabled="!canClearAuditTeamViewDefault || auditTeamViewsLoading" @click="clearAuditTeamViewDefault">
          {{ tr('Clear default', '取消默认') }}
        </button>
        <button class="plm-audit__button" type="button" :disabled="!canDeleteAuditTeamView || auditTeamViewsLoading" @click="deleteAuditTeamView">
          {{ tr('Delete', '删除') }}
        </button>
      </div>

      <div
        v-if="auditTeamViewContextNote"
        class="plm-audit__team-view-context"
        :class="{
          'plm-audit__team-view-context--active': auditTeamViewContextNote.active,
          'plm-audit__team-view-context--owner': auditTeamViewContextNote.kind === 'owner',
          'plm-audit__team-view-context--scene': auditTeamViewContextNote.kind === 'scene',
        }"
      >
        <div class="plm-audit__team-view-context-meta">
          <small class="plm-audit__summary-source">{{ auditTeamViewContextNote.sourceLabel }}</small>
          <strong>{{ auditTeamViewContextNote.label }}: {{ auditTeamViewContextNote.value }}</strong>
          <span class="plm-audit__muted">{{ auditTeamViewContextNote.description }}</span>
        </div>
        <div class="plm-audit__team-view-context-actions">
          <button
            v-for="actionItem in auditTeamViewContextNote.actions"
            :key="`team-view-context-${actionItem.kind}-${actionItem.emphasis}`"
            class="plm-audit__button plm-audit__button--inline"
            type="button"
            :disabled="logsLoading || auditTeamViewsLoading"
            @click="runAuditSceneTokenAction(actionItem.kind)"
          >
            {{ actionItem.label }}
          </button>
        </div>
      </div>

      <p v-if="defaultAuditTeamViewLabel" class="plm-audit__muted">
        {{ tr('Current default', '当前默认') }}: {{ defaultAuditTeamViewLabel }}
      </p>

      <div class="plm-audit__saved-view-create">
        <input
          v-model="auditTeamViewName"
          class="plm-audit__saved-view-input"
          type="text"
          :placeholder="tr('Team view name', '团队视图名称')"
          @keydown.enter.prevent="saveAuditTeamView"
        />
        <button class="plm-audit__button plm-audit__button--primary" type="button" :disabled="!canSaveAuditTeamView || auditTeamViewsLoading" @click="saveAuditTeamView">
          {{ tr('Save to team', '保存到团队') }}
        </button>
      </div>

      <p v-if="auditTeamViewsError" class="plm-audit__status plm-audit__status--error">
        {{ auditTeamViewsError }}
      </p>
    </section>

    <section class="plm-audit__saved-views">
      <div class="plm-audit__saved-views-header">
        <div>
          <h2>{{ tr('Saved views', '已保存视图') }}</h2>
          <p class="plm-audit__muted">
            {{ tr('Save the current audit filters and reopen them later from this device.', '保存当前审计筛选，并在本机稍后快速恢复。') }}
          </p>
        </div>
        <div class="plm-audit__saved-view-create">
          <input
            v-model="savedViewName"
            class="plm-audit__saved-view-input"
            type="text"
            :placeholder="tr('View name', '视图名称')"
            @keydown.enter.prevent="saveCurrentView"
          />
          <button class="plm-audit__button plm-audit__button--primary" type="button" @click="saveCurrentView">
            {{ tr('Save current view', '保存当前视图') }}
          </button>
        </div>
      </div>

      <div v-if="savedViews.length" class="plm-audit__saved-view-list">
        <article
          v-for="view in savedViews"
          :key="view.id"
          class="plm-audit__saved-view-card"
          :class="{ 'plm-audit__saved-view-card--active': isSavedViewActive(view) }"
        >
          <div class="plm-audit__saved-view-meta">
            <strong>{{ view.name }}</strong>
            <div v-if="savedViewContextBadge(view)" class="plm-audit__saved-view-badges">
              <span class="plm-audit__saved-view-source">{{ savedViewContextBadge(view)?.sourceLabel }}</span>
              <span
                class="plm-audit__saved-view-badge"
                :class="{
                  'plm-audit__saved-view-badge--active': savedViewContextBadge(view)?.active,
                  'plm-audit__saved-view-badge--owner': savedViewContextBadge(view)?.kind === 'owner',
                  'plm-audit__saved-view-badge--scene': savedViewContextBadge(view)?.kind === 'scene',
                }"
              >
                {{ savedViewContextBadge(view)?.label }}: {{ savedViewContextBadge(view)?.value }}
              </span>
              <button
                v-if="savedViewContextBadge(view)?.quickAction"
                class="plm-audit__button plm-audit__button--inline"
                type="button"
                :disabled="savedViewContextBadge(view)?.quickAction?.disabled"
                @click="runSavedViewContextAction(view, savedViewContextBadge(view)!.quickAction!.kind)"
              >
                {{ savedViewContextBadge(view)?.quickAction?.label }}
              </button>
            </div>
            <span
              v-if="savedViewContextBadge(view)?.quickAction?.disabled"
              class="plm-audit__muted"
            >
              {{ savedViewContextBadge(view)?.quickAction?.hint }}
            </span>
            <span class="plm-audit__muted">{{ savedViewSummary(view.state) }}</span>
            <span class="plm-audit__muted">{{ tr('Updated', '更新于') }}: {{ formatDate(view.updatedAt) }}</span>
          </div>
          <div class="plm-audit__saved-view-actions">
            <button class="plm-audit__button" type="button" @click="applySavedView(view)">
              {{ tr('Apply', '应用') }}
            </button>
            <button class="plm-audit__button" type="button" @click="deleteSavedViewEntry(view.id)">
              {{ tr('Delete', '删除') }}
            </button>
          </div>
        </article>
      </div>
      <p v-else class="plm-audit__empty">{{ tr('No saved audit views yet.', '暂无已保存的审计视图。') }}</p>
    </section>

    <p v-if="statusMessage" class="plm-audit__status" :class="{ 'plm-audit__status--error': statusKind === 'error' }">
      {{ statusMessage }}
    </p>

    <div class="plm-audit__table-wrapper">
      <table v-if="logs.length" class="plm-audit__table">
        <thead>
          <tr>
            <th>{{ tr('Occurred', '发生时间') }}</th>
            <th>{{ tr('Action', '动作') }}</th>
            <th>{{ tr('Resource', '资源') }}</th>
            <th>{{ tr('Actor', '操作者') }}</th>
            <th>{{ tr('Result', '结果') }}</th>
            <th>{{ tr('Details', '详情') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in logs" :key="item.id">
            <td>{{ formatDate(item.occurredAt) }}</td>
            <td>{{ actionLabel(item.action) }}</td>
            <td>
              <div>{{ resourceTypeLabel(item.resourceType) }}</div>
              <small class="plm-audit__muted">{{ formatKinds(item.meta.processedKinds) }}</small>
            </td>
            <td>
              <div>{{ item.actorId || '--' }}</div>
              <small class="plm-audit__muted">{{ item.actorType || '--' }}</small>
            </td>
            <td>
              <div>{{ formatProcessed(item.meta.processedTotal) }} / {{ formatProcessed(item.meta.requestedTotal) }}</div>
              <small class="plm-audit__muted">
                {{ tr('Skipped', '跳过') }}: {{ formatProcessed(item.meta.skippedTotal) }}
              </small>
            </td>
            <td>
              <details class="plm-audit__details">
                <summary>{{ tr('View meta', '查看元数据') }}</summary>
                <pre>{{ prettyMeta(item.meta) }}</pre>
              </details>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="plm-audit__empty plm-audit__empty--table">
        {{ logsLoading ? tr('Loading audit logs...', '正在加载审计日志...') : tr('No PLM collaborative audit logs yet.', '暂无 PLM 协作审计日志。') }}
      </div>
    </div>

    <footer class="plm-audit__pagination">
      <button class="plm-audit__button" type="button" :disabled="logsLoading || page <= 1" @click="goToPage(page - 1)">
        {{ tr('Previous', '上一页') }}
      </button>
      <span>{{ tr('Page', '页码') }} {{ page }} / {{ totalPages }} · {{ total }} {{ tr('rows', '行') }}</span>
      <button class="plm-audit__button" type="button" :disabled="logsLoading || page >= totalPages" @click="goToPage(page + 1)">
        {{ tr('Next', '下一页') }}
      </button>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useLocale } from '../composables/useLocale'
import {
  clearPlmWorkbenchTeamViewDefault,
  deletePlmWorkbenchTeamView,
  exportPlmCollaborativeAuditLogsCsv,
  getPlmCollaborativeAuditSummary,
  listPlmCollaborativeAuditLogs,
  listPlmWorkbenchTeamViews,
  savePlmWorkbenchTeamView,
  setPlmWorkbenchTeamViewDefault,
  type PlmCollaborativeAuditAction,
  type PlmCollaborativeAuditLogItem,
  type PlmCollaborativeAuditResourceType,
  type PlmCollaborativeAuditSummaryRow,
} from '../services/plm/plmWorkbenchClient'
import {
  buildPlmAuditRouteStateFromTeamView,
  buildPlmAuditTeamViewState,
  buildPlmAuditRouteQuery,
  DEFAULT_PLM_AUDIT_ROUTE_STATE,
  hasExplicitPlmAuditFilters,
  isPlmAuditRouteStateEqual,
  parsePlmAuditRouteState,
  type PlmAuditRouteState,
} from './plmAuditQueryState'
import {
  deletePlmAuditSavedView,
  readPlmAuditSavedViews,
  savePlmAuditSavedView,
  type PlmAuditSavedView,
} from './plmAuditSavedViews'
import {
  buildPlmAuditSavedViewContextBadge,
  buildPlmAuditSavedViewSummary,
} from './plmAuditSavedViewSummary'
import {
  buildPlmAuditSceneContextBanner,
  buildPlmAuditSceneFilterHighlight,
  resolvePlmAuditSceneSemantic,
} from './plmAuditSceneCopy'
import {
  buildPlmAuditSceneQueryValue,
  isPlmAuditSceneOwnerContextActive,
  isPlmAuditSceneQueryContextActive,
  withPlmAuditSceneOwnerContext,
  withPlmAuditSceneQueryContext,
} from './plmAuditSceneContext'
import { buildPlmAuditSceneInputToken } from './plmAuditSceneInputToken'
import { buildPlmAuditSceneSummaryCard } from './plmAuditSceneSummary'
import {
  buildPlmAuditSceneToken,
  type PlmAuditSceneTokenActionKind,
} from './plmAuditSceneToken'
import { buildPlmAuditTeamViewContextNote } from './plmAuditTeamViewContext'
import { copyTextToClipboard } from './plm/plmClipboard'
import type { PlmWorkbenchTeamView } from './plm/plmPanelModels'
import { buildPlmWorkbenchTeamViewShareUrl } from './plm/plmWorkbenchViewState'

const route = useRoute()
const router = useRouter()
const { isZh } = useLocale()

const logs = ref<PlmCollaborativeAuditLogItem[]>([])
const page = ref(DEFAULT_PLM_AUDIT_ROUTE_STATE.page)
const pageSize = 20
const total = ref(0)
const logsLoading = ref(false)
const summaryLoading = ref(false)
const exporting = ref(false)
const statusMessage = ref('')
const statusKind = ref<'info' | 'error'>('info')
const routeReady = ref(false)
const savedViewName = ref('')
const savedViews = ref<PlmAuditSavedView[]>(readPlmAuditSavedViews())
const auditTeamViewKey = ref(DEFAULT_PLM_AUDIT_ROUTE_STATE.teamViewId)
const auditTeamViewName = ref('')
const auditTeamViews = ref<PlmWorkbenchTeamView<'audit'>[]>([])
const auditTeamViewsLoading = ref(false)
const auditTeamViewsError = ref('')

const query = ref(DEFAULT_PLM_AUDIT_ROUTE_STATE.q)
const actorId = ref(DEFAULT_PLM_AUDIT_ROUTE_STATE.actorId)
const kind = ref(DEFAULT_PLM_AUDIT_ROUTE_STATE.kind)
const action = ref<PlmCollaborativeAuditAction | ''>(DEFAULT_PLM_AUDIT_ROUTE_STATE.action)
const resourceType = ref<PlmCollaborativeAuditResourceType | ''>(DEFAULT_PLM_AUDIT_ROUTE_STATE.resourceType)
const from = ref(DEFAULT_PLM_AUDIT_ROUTE_STATE.from)
const to = ref(DEFAULT_PLM_AUDIT_ROUTE_STATE.to)
const windowMinutes = ref(DEFAULT_PLM_AUDIT_ROUTE_STATE.windowMinutes)
const auditSceneId = ref(DEFAULT_PLM_AUDIT_ROUTE_STATE.sceneId)
const auditSceneName = ref(DEFAULT_PLM_AUDIT_ROUTE_STATE.sceneName)
const auditSceneOwnerUserId = ref(DEFAULT_PLM_AUDIT_ROUTE_STATE.sceneOwnerUserId)

const summary = ref<{
  windowMinutes: number
  actions: PlmCollaborativeAuditSummaryRow[]
  resourceTypes: Array<{ resourceType: PlmCollaborativeAuditResourceType; total: number }>
}>({
  windowMinutes: DEFAULT_PLM_AUDIT_ROUTE_STATE.windowMinutes,
  actions: [],
  resourceTypes: [],
})

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))
const totalSummaryEvents = computed(() => summary.value.resourceTypes.reduce((sum, item) => sum + item.total, 0))
const selectedAuditTeamView = computed(
  () => auditTeamViews.value.find((view) => view.id === auditTeamViewKey.value) || null,
)
const defaultAuditTeamView = computed(
  () => auditTeamViews.value.find((view) => view.isDefault && !view.isArchived) || null,
)
const defaultAuditTeamViewLabel = computed(() => defaultAuditTeamView.value?.name || '')
const canSaveAuditTeamView = computed(() => Boolean(auditTeamViewName.value.trim()))
const auditSceneContext = computed(() => {
  return buildPlmAuditSceneContextBanner({
    sceneId: auditSceneId.value,
    sceneName: auditSceneName.value,
    sceneOwnerUserId: auditSceneOwnerUserId.value,
    action: action.value,
    resourceType: resourceType.value,
    semantic: resolvePlmAuditSceneSemantic({
      sceneValue: buildPlmAuditSceneQueryValue(readCurrentRouteState()),
      ownerValue: auditSceneOwnerUserId.value,
      ownerContextActive: isPlmAuditSceneOwnerContextActive(readCurrentRouteState()),
      sceneQueryContextActive: isPlmAuditSceneQueryContextActive(readCurrentRouteState()),
    }),
  }, tr)
})
const auditSceneOwnerContextActive = computed(() => isPlmAuditSceneOwnerContextActive(readCurrentRouteState()))
const auditSceneQueryContextActive = computed(() => isPlmAuditSceneQueryContextActive(readCurrentRouteState()))
const auditSceneToken = computed(() => buildPlmAuditSceneToken({
  sceneValue: buildPlmAuditSceneQueryValue(readCurrentRouteState()),
  ownerValue: auditSceneOwnerUserId.value,
  ownerContextActive: auditSceneOwnerContextActive.value,
  sceneQueryContextActive: auditSceneQueryContextActive.value,
}, tr))
const auditSceneInputToken = computed(() => buildPlmAuditSceneInputToken(auditSceneToken.value, tr))
const auditTeamViewContextNote = computed(() => buildPlmAuditTeamViewContextNote(auditSceneToken.value, tr))
const auditSceneSummaryCard = computed(() => buildPlmAuditSceneSummaryCard({
  sceneId: auditSceneId.value,
  sceneName: auditSceneName.value,
  sceneOwnerUserId: auditSceneOwnerUserId.value,
  ownerContextActive: auditSceneOwnerContextActive.value,
  sceneQueryContextActive: auditSceneQueryContextActive.value,
}, tr))
const auditSceneFilterHighlight = computed(() => buildPlmAuditSceneFilterHighlight(auditSceneToken.value, tr))
const canApplyAuditTeamView = computed(() => {
  const view = selectedAuditTeamView.value
  if (!view || view.isArchived) return false
  return view.permissions?.canApply ?? !view.isArchived
})
const canShareAuditTeamView = computed(() => {
  const view = selectedAuditTeamView.value
  if (!view || view.isArchived) return false
  return view.permissions?.canShare ?? view.canManage
})
const canDeleteAuditTeamView = computed(() => {
  const view = selectedAuditTeamView.value
  if (!view) return false
  return view.permissions?.canDelete ?? view.canManage
})
const canSetAuditTeamViewDefault = computed(() => {
  const view = selectedAuditTeamView.value
  if (!view || view.isArchived) return false
  return view.permissions?.canSetDefault ?? (view.canManage && !view.isDefault)
})
const canClearAuditTeamViewDefault = computed(() => {
  const view = selectedAuditTeamView.value
  if (!view || view.isArchived) return false
  return view.permissions?.canClearDefault ?? (view.canManage && view.isDefault)
})

function readCurrentRouteState(): PlmAuditRouteState {
  return {
    page: page.value,
    q: query.value,
    actorId: actorId.value,
    kind: kind.value,
    action: action.value,
    resourceType: resourceType.value,
    from: from.value,
    to: to.value,
    windowMinutes: windowMinutes.value,
    teamViewId: auditTeamViewKey.value,
    sceneId: auditSceneId.value,
    sceneName: auditSceneName.value,
    sceneOwnerUserId: auditSceneOwnerUserId.value,
  }
}

function applyRouteState(state: PlmAuditRouteState) {
  page.value = state.page
  query.value = state.q
  actorId.value = state.actorId
  kind.value = state.kind
  action.value = state.action
  resourceType.value = state.resourceType
  from.value = state.from
  to.value = state.to
  windowMinutes.value = state.windowMinutes
  auditTeamViewKey.value = state.teamViewId
  auditSceneId.value = state.sceneId
  auditSceneName.value = state.sceneName
  auditSceneOwnerUserId.value = state.sceneOwnerUserId
}

async function syncRouteState(nextState: PlmAuditRouteState, replace = false) {
  const nextQuery = buildPlmAuditRouteQuery(nextState)
  const currentState = parsePlmAuditRouteState(route.query)
  if (isPlmAuditRouteStateEqual(nextState, currentState)) return
  const method = replace ? router.replace : router.push
  await method.call(router, {
    name: 'plm-audit',
    query: nextQuery,
  })
}

async function clearAuditSceneContext() {
  await syncRouteState({
    ...readCurrentRouteState(),
    sceneId: '',
    sceneName: '',
    sceneOwnerUserId: '',
  })
}

async function applyAuditSceneOwnerContext() {
  await syncRouteState(withPlmAuditSceneOwnerContext(readCurrentRouteState()))
}

async function restoreAuditSceneQuery() {
  await syncRouteState(withPlmAuditSceneQueryContext(readCurrentRouteState()))
}

async function runAuditSceneTokenAction(actionKind: PlmAuditSceneTokenActionKind | null) {
  if (actionKind === 'clear') {
    await clearAuditSceneContext()
    return
  }
  if (actionKind === 'owner') {
    await applyAuditSceneOwnerContext()
    return
  }
  if (actionKind === 'scene') {
    await restoreAuditSceneQuery()
  }
}

async function runAuditSceneSummaryAction(actionKind: 'owner' | 'scene' | null) {
  await runAuditSceneTokenAction(actionKind)
}

function tr(en: string, zh: string): string {
  return isZh.value ? zh : en
}

function setStatus(message: string, kindValue: 'info' | 'error' = 'info') {
  statusMessage.value = message
  statusKind.value = kindValue
}

function actionLabel(value: string): string {
  if (value === 'archive') return tr('Archive', '归档')
  if (value === 'restore') return tr('Restore', '恢复')
  if (value === 'delete') return tr('Delete', '删除')
  if (value === 'set-default') return tr('Set default', '设为默认')
  if (value === 'clear-default') return tr('Clear default', '取消默认')
  return value || '--'
}

function resourceTypeLabel(value: string): string {
  if (value === 'plm-team-preset-batch') return tr('Team preset batch', '团队预设批量')
  if (value === 'plm-team-view-batch') return tr('Team view batch', '团队视图批量')
  if (value === 'plm-team-view-default') return tr('Team default scene', '团队默认场景')
  return value || '--'
}

function formatKinds(value: string[] | undefined): string {
  if (!value?.length) return '--'
  return value.join(', ')
}

function formatProcessed(value: number | undefined): string {
  return typeof value === 'number' ? String(value) : '--'
}

function formatDate(value: string): string {
  if (!value) return '--'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString(isZh.value ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function prettyMeta(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function getAuditTeamViewTimestamp(view: PlmWorkbenchTeamView<'audit'>) {
  const raw = view.updatedAt || view.createdAt || ''
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

function sortAuditTeamViews(views: PlmWorkbenchTeamView<'audit'>[]) {
  return [...views].sort((left, right) => {
    if (Boolean(left.isArchived) !== Boolean(right.isArchived)) {
      return Number(Boolean(left.isArchived)) - Number(Boolean(right.isArchived))
    }
    if (left.isDefault !== right.isDefault) {
      return Number(right.isDefault) - Number(left.isDefault)
    }
    return getAuditTeamViewTimestamp(right) - getAuditTeamViewTimestamp(left)
  })
}

function upsertAuditTeamView(view: PlmWorkbenchTeamView<'audit'>) {
  auditTeamViews.value = sortAuditTeamViews([
    view,
    ...auditTeamViews.value.filter((entry) => entry.id !== view.id),
  ])
}

function replaceAuditTeamView(view: PlmWorkbenchTeamView<'audit'>) {
  auditTeamViews.value = sortAuditTeamViews(
    auditTeamViews.value.map((entry) => (entry.id === view.id ? view : entry)),
  )
}

function buildCurrentAuditTeamViewState() {
  return buildPlmAuditTeamViewState(readCurrentRouteState())
}

function applyAuditTeamViewState(view: PlmWorkbenchTeamView<'audit'>) {
  auditTeamViewKey.value = view.id
  page.value = view.state.page
  query.value = view.state.q
  actorId.value = view.state.actorId
  kind.value = view.state.kind
  action.value = view.state.action
  resourceType.value = view.state.resourceType
  from.value = view.state.from
  to.value = view.state.to
  windowMinutes.value = view.state.windowMinutes
}

function buildAuditTeamViewShareUrl(view: PlmWorkbenchTeamView<'audit'>) {
  return buildPlmWorkbenchTeamViewShareUrl('audit', view, route.path)
}

function savedViewSummary(state: PlmAuditRouteState) {
  return buildPlmAuditSavedViewSummary(state, tr, actionLabel, resourceTypeLabel)
}

function savedViewContextBadge(view: PlmAuditSavedView) {
  return buildPlmAuditSavedViewContextBadge(view.state, tr, readCurrentRouteState())
}

function buildSavedViewContextState(
  view: PlmAuditSavedView,
  actionKind: 'owner' | 'scene',
) {
  if (actionKind === 'owner') return withPlmAuditSceneOwnerContext(view.state)
  return withPlmAuditSceneQueryContext(view.state)
}

function isSavedViewActive(view: PlmAuditSavedView) {
  return isPlmAuditRouteStateEqual(view.state, readCurrentRouteState())
}

function runSavedViewContextAction(
  view: PlmAuditSavedView,
  actionKind: 'owner' | 'scene',
) {
  const badge = savedViewContextBadge(view)
  if (badge?.quickAction?.disabled) return
  void syncRouteState(buildSavedViewContextState(view, actionKind))
}

function downloadCsvText(filename: string, csvText: string) {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = filename
  link.click()
  URL.revokeObjectURL(link.href)
}

async function refreshAuditTeamViews() {
  auditTeamViewsLoading.value = true
  auditTeamViewsError.value = ''
  try {
    const result = await listPlmWorkbenchTeamViews('audit')
    auditTeamViews.value = sortAuditTeamViews(result.items)

    const requestedState = parsePlmAuditRouteState(route.query)
    const requestedViewId = requestedState.teamViewId.trim()
    const requestedView = requestedViewId
      ? auditTeamViews.value.find((view) => view.id === requestedViewId && !view.isArchived) || null
      : null

    if (requestedView) {
      const nextState = buildPlmAuditRouteStateFromTeamView(requestedView.id, requestedView.state)
      applyAuditTeamViewState(requestedView)
      if (!isPlmAuditRouteStateEqual(nextState, requestedState)) {
        await syncRouteState(nextState, true)
      }
      return
    }

    if (requestedViewId) {
      auditTeamViewKey.value = ''
      const nextState = {
        ...requestedState,
        teamViewId: '',
      }
      if (!isPlmAuditRouteStateEqual(nextState, requestedState)) {
        await syncRouteState(nextState, true)
      }
      return
    }

    if (!hasExplicitPlmAuditFilters(requestedState)) {
      const defaultView = defaultAuditTeamView.value
      if (defaultView) {
        const nextState = buildPlmAuditRouteStateFromTeamView(defaultView.id, defaultView.state)
        applyAuditTeamViewState(defaultView)
        if (!isPlmAuditRouteStateEqual(nextState, requestedState)) {
          await syncRouteState(nextState, true)
        }
      }
    }
  } catch (error: unknown) {
    auditTeamViewsError.value = error instanceof Error
      ? error.message
      : tr('Failed to load audit team views', '加载审计团队视图失败')
  } finally {
    auditTeamViewsLoading.value = false
  }
}

async function saveAuditTeamView() {
  const name = auditTeamViewName.value.trim()
  if (!name) {
    setStatus(tr('Enter a team view name.', '请输入团队视图名称。'), 'error')
    return
  }

  auditTeamViewsLoading.value = true
  auditTeamViewsError.value = ''
  try {
    const saved = await savePlmWorkbenchTeamView('audit', name, buildCurrentAuditTeamViewState())
    upsertAuditTeamView(saved)
    applyAuditTeamViewState(saved)
    auditTeamViewName.value = ''
    await syncRouteState(buildPlmAuditRouteStateFromTeamView(saved.id, saved.state))
    setStatus(tr('Audit team view saved.', '审计团队视图已保存。'))
  } catch (error: unknown) {
    auditTeamViewsError.value = error instanceof Error
      ? error.message
      : tr('Failed to save audit team view', '保存审计团队视图失败')
    setStatus(auditTeamViewsError.value, 'error')
  } finally {
    auditTeamViewsLoading.value = false
  }
}

async function applyAuditTeamView() {
  const view = selectedAuditTeamView.value
  if (!view || !canApplyAuditTeamView.value) return

  applyAuditTeamViewState(view)
  await syncRouteState(buildPlmAuditRouteStateFromTeamView(view.id, view.state))
  setStatus(tr('Audit team view applied.', '审计团队视图已应用。'))
}

async function shareAuditTeamView() {
  const view = selectedAuditTeamView.value
  if (!view || !canShareAuditTeamView.value) return

  const ok = await copyTextToClipboard(buildAuditTeamViewShareUrl(view))
  if (!ok) {
    setStatus(tr('Failed to copy team view link.', '复制团队视图链接失败。'), 'error')
    return
  }
  setStatus(tr('Audit team view link copied.', '审计团队视图链接已复制。'))
}

async function setAuditTeamViewDefault() {
  const view = selectedAuditTeamView.value
  if (!view || !canSetAuditTeamViewDefault.value) return

  auditTeamViewsLoading.value = true
  auditTeamViewsError.value = ''
  try {
    const saved = await setPlmWorkbenchTeamViewDefault('audit', view.id)
    auditTeamViews.value = sortAuditTeamViews(
      auditTeamViews.value.map((entry) => {
        if (entry.id === saved.id) return saved
        return entry.isDefault ? { ...entry, isDefault: false } : entry
      }),
    )
    applyAuditTeamViewState(saved)
    await syncRouteState(buildPlmAuditRouteStateFromTeamView(saved.id, saved.state))
    setStatus(tr('Audit team view set as default.', '审计团队视图已设为默认。'))
  } catch (error: unknown) {
    auditTeamViewsError.value = error instanceof Error
      ? error.message
      : tr('Failed to set audit team view default', '设置审计团队视图默认失败')
    setStatus(auditTeamViewsError.value, 'error')
  } finally {
    auditTeamViewsLoading.value = false
  }
}

async function clearAuditTeamViewDefault() {
  const view = selectedAuditTeamView.value
  if (!view || !canClearAuditTeamViewDefault.value) return

  auditTeamViewsLoading.value = true
  auditTeamViewsError.value = ''
  try {
    const saved = await clearPlmWorkbenchTeamViewDefault('audit', view.id)
    replaceAuditTeamView(saved)
    applyAuditTeamViewState(saved)
    await syncRouteState(buildPlmAuditRouteStateFromTeamView(saved.id, saved.state))
    setStatus(tr('Audit team view default cleared.', '审计团队视图默认已取消。'))
  } catch (error: unknown) {
    auditTeamViewsError.value = error instanceof Error
      ? error.message
      : tr('Failed to clear audit team view default', '取消审计团队视图默认失败')
    setStatus(auditTeamViewsError.value, 'error')
  } finally {
    auditTeamViewsLoading.value = false
  }
}

async function deleteAuditTeamView() {
  const view = selectedAuditTeamView.value
  if (!view || !canDeleteAuditTeamView.value) return

  auditTeamViewsLoading.value = true
  auditTeamViewsError.value = ''
  try {
    await deletePlmWorkbenchTeamView(view.id)
    auditTeamViews.value = auditTeamViews.value.filter((entry) => entry.id !== view.id)
    auditTeamViewKey.value = ''
    const nextState = {
      ...readCurrentRouteState(),
      teamViewId: '',
    }
    await syncRouteState(nextState)
    setStatus(tr('Audit team view deleted.', '审计团队视图已删除。'))
  } catch (error: unknown) {
    auditTeamViewsError.value = error instanceof Error
      ? error.message
      : tr('Failed to delete audit team view', '删除审计团队视图失败')
    setStatus(auditTeamViewsError.value, 'error')
  } finally {
    auditTeamViewsLoading.value = false
  }
}

async function loadSummary(nextWindowMinutes = windowMinutes.value) {
  summaryLoading.value = true
  try {
    summary.value = await getPlmCollaborativeAuditSummary({
      windowMinutes: nextWindowMinutes,
      limit: 8,
    })
  } catch (error: unknown) {
    setStatus(
      error instanceof Error ? error.message : tr('Failed to load summary', '加载汇总失败'),
      'error',
    )
  } finally {
    summaryLoading.value = false
  }
}

async function loadLogs(nextPage = page.value) {
  logsLoading.value = true
  try {
    const result = await listPlmCollaborativeAuditLogs({
      page: nextPage,
      pageSize,
      q: query.value,
      actorId: actorId.value,
      action: action.value,
      resourceType: resourceType.value,
      kind: kind.value,
      from: from.value ? new Date(from.value).toISOString() : '',
      to: to.value ? new Date(to.value).toISOString() : '',
    })

    logs.value = result.items
    page.value = result.page
    total.value = result.total
    setStatus(tr(`Loaded ${result.items.length} audit log(s).`, `已加载 ${result.items.length} 条审计日志。`))
  } catch (error: unknown) {
    setStatus(
      error instanceof Error ? error.message : tr('Failed to load audit logs', '加载审计日志失败'),
      'error',
    )
  } finally {
    logsLoading.value = false
  }
}

async function exportCsv() {
  exporting.value = true
  try {
    const result = await exportPlmCollaborativeAuditLogsCsv({
      q: query.value,
      actorId: actorId.value,
      action: action.value,
      resourceType: resourceType.value,
      kind: kind.value,
      from: from.value ? new Date(from.value).toISOString() : '',
      to: to.value ? new Date(to.value).toISOString() : '',
      limit: 5000,
    })
    downloadCsvText(result.filename, result.csvText)
    setStatus(tr('Audit CSV exported.', '审计 CSV 已导出。'))
  } catch (error: unknown) {
    setStatus(
      error instanceof Error ? error.message : tr('Failed to export audit CSV', '导出审计 CSV 失败'),
      'error',
    )
  } finally {
    exporting.value = false
  }
}

function saveCurrentView() {
  const trimmedName = savedViewName.value.trim()
  if (!trimmedName) {
    setStatus(tr('Enter a name for the saved view.', '请输入已保存视图名称。'), 'error')
    return
  }

  savedViews.value = savePlmAuditSavedView(trimmedName, readCurrentRouteState())
  savedViewName.value = ''
  setStatus(tr('Audit saved view stored.', '审计已保存视图已保存。'))
}

function applySavedView(view: PlmAuditSavedView) {
  void syncRouteState(view.state)
}

function deleteSavedViewEntry(id: string) {
  savedViews.value = deletePlmAuditSavedView(id)
  setStatus(tr('Audit saved view deleted.', '审计已保存视图已删除。'))
}

function applyFilters() {
  void syncRouteState({
    ...readCurrentRouteState(),
    page: 1,
  })
}

function resetFilters() {
  void syncRouteState({ ...DEFAULT_PLM_AUDIT_ROUTE_STATE })
}

function reloadLogs() {
  void loadLogs(page.value)
}

function goToPage(nextPage: number) {
  void syncRouteState({
    ...readCurrentRouteState(),
    page: nextPage,
  })
}

watch(
  () => route.query,
  async (queryState) => {
    const nextState = parsePlmAuditRouteState(queryState)
    const currentState = readCurrentRouteState()
    if (routeReady.value && isPlmAuditRouteStateEqual(nextState, currentState)) return
    applyRouteState(nextState)
    routeReady.value = true
    await Promise.all([loadSummary(nextState.windowMinutes), loadLogs(nextState.page)])
    if (
      nextState.teamViewId
      || !auditTeamViews.value.length
      || !hasExplicitPlmAuditFilters(nextState)
    ) {
      await refreshAuditTeamViews()
    }
  },
  { immediate: true },
)
</script>

<style scoped>
.plm-audit {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 24px;
}

.plm-audit__header,
.plm-audit__summary,
.plm-audit__summary-grid,
.plm-audit__filters,
.plm-audit__pagination {
  display: flex;
  gap: 12px;
}

.plm-audit__header,
.plm-audit__pagination {
  align-items: center;
  justify-content: space-between;
}

.plm-audit__eyebrow {
  color: #2563eb;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.plm-audit__subtitle {
  color: #475569;
  margin-top: 6px;
}

.plm-audit__actions,
.plm-audit__filter-actions {
  display: flex;
  gap: 8px;
}

.plm-audit__context {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 14px;
}

.plm-audit__context-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: #1e3a8a;
  font-size: 12px;
}

.plm-audit__context-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.plm-audit__summary {
  flex-wrap: wrap;
}

.plm-audit__summary-card,
.plm-audit__summary-panel,
.plm-audit__filters,
.plm-audit__team-views,
.plm-audit__saved-views,
.plm-audit__table-wrapper {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 14px;
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.04);
}

.plm-audit__summary-card {
  min-width: 180px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.plm-audit__summary-card--context {
  min-width: 240px;
}

.plm-audit__summary-card--active {
  border-color: #3b82f6;
  box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.18);
}

.plm-audit__summary-card--owner {
  background: linear-gradient(180deg, #f8fbff 0%, #ffffff 100%);
}

.plm-audit__summary-card--scene {
  background: linear-gradient(180deg, #f0fdf4 0%, #ffffff 100%);
}

.plm-audit__button--inline {
  align-self: flex-start;
  margin-top: 4px;
}

.plm-audit__summary-label,
.plm-audit__muted {
  color: #64748b;
  font-size: 12px;
}

.plm-audit__summary-source,
.plm-audit__saved-view-source {
  color: #475569;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.plm-audit__summary-grid {
  flex-wrap: wrap;
}

.plm-audit__summary-panel {
  flex: 1 1 320px;
  padding: 16px;
}

.plm-audit__pill-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.plm-audit__pill {
  background: #eff6ff;
  color: #1d4ed8;
  border-radius: 999px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 600;
}

.plm-audit__filters {
  flex-wrap: wrap;
  align-items: flex-end;
  padding: 16px;
}

.plm-audit__filter-highlight {
  display: flex;
  flex: 1 1 100%;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid #dbeafe;
  border-radius: 12px;
  background: #f8fbff;
}

.plm-audit__filter-highlight--scene {
  border-color: #bbf7d0;
  background: #f0fdf4;
}

.plm-audit__filter-highlight-value {
  display: inline-flex;
  margin-left: 8px;
  font-weight: 700;
}

.plm-audit__team-views,
.plm-audit__saved-views {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
}

.plm-audit__team-view-row,
.plm-audit__saved-views-header,
.plm-audit__saved-view-create,
.plm-audit__saved-view-actions {
  display: flex;
  gap: 8px;
}

.plm-audit__team-view-row {
  flex-wrap: wrap;
  align-items: center;
}

.plm-audit__team-view-context {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid #dbeafe;
  border-radius: 12px;
  background: #f8fbff;
}

.plm-audit__team-view-context--scene {
  border-color: #bbf7d0;
  background: #f0fdf4;
}

.plm-audit__team-view-context-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.plm-audit__team-view-context-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.plm-audit__saved-views-header {
  align-items: flex-start;
  justify-content: space-between;
}

.plm-audit__saved-view-create {
  align-items: center;
}

.plm-audit__saved-view-input {
  min-width: 220px;
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  padding: 10px 12px;
}

.plm-audit__saved-view-list {
  display: grid;
  gap: 10px;
}

.plm-audit__saved-view-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 12px 14px;
  background: #f8fafc;
}

.plm-audit__saved-view-card--active {
  border-color: #2563eb;
  box-shadow: 0 0 0 1px rgba(37, 99, 235, 0.18);
}

.plm-audit__saved-view-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.plm-audit__saved-view-badges {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.plm-audit__saved-view-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 1px solid #dbeafe;
  border-radius: 999px;
  background: #eff6ff;
  color: #1d4ed8;
  font-size: 12px;
  font-weight: 600;
}

.plm-audit__saved-view-badge--scene {
  border-color: #bbf7d0;
  background: #f0fdf4;
  color: #15803d;
}

.plm-audit__saved-view-badge--active {
  box-shadow: 0 0 0 1px rgba(37, 99, 235, 0.14);
}

.plm-audit__field {
  display: flex;
  flex: 1 1 180px;
  flex-direction: column;
  gap: 6px;
}

.plm-audit__field-token {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid #dbeafe;
  border-radius: 10px;
  background: #f8fbff;
}

.plm-audit__field-token--locked {
  box-shadow: 0 0 0 1px rgba(37, 99, 235, 0.12);
}

.plm-audit__field-token--scene {
  border-color: #bbf7d0;
  background: #f0fdf4;
}

.plm-audit__field-token-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.plm-audit__field-token-value {
  display: inline-flex;
  font-weight: 700;
}

.plm-audit__field-token-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.plm-audit__field input,
.plm-audit__field select {
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  padding: 10px 12px;
}

.plm-audit__field--active span {
  color: #2563eb;
  font-weight: 600;
}

.plm-audit__field--active input,
.plm-audit__field--active select {
  border-color: #93c5fd;
  background: #eff6ff;
}

.plm-audit__button {
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  background: #fff;
  color: #1f2937;
  padding: 9px 14px;
  cursor: pointer;
}

.plm-audit__button--primary {
  background: #2563eb;
  border-color: #2563eb;
  color: #fff;
}

.plm-audit__button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.plm-audit__status {
  padding: 10px 12px;
  border-radius: 10px;
  background: #eff6ff;
  color: #1d4ed8;
}

.plm-audit__status--error {
  background: #fef2f2;
  color: #b91c1c;
}

.plm-audit__table-wrapper {
  overflow: hidden;
}

.plm-audit__table {
  width: 100%;
  border-collapse: collapse;
}

.plm-audit__table th,
.plm-audit__table td {
  border-bottom: 1px solid #e5e7eb;
  padding: 12px 14px;
  vertical-align: top;
  text-align: left;
}

.plm-audit__table th {
  background: #f8fafc;
  color: #334155;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.plm-audit__details summary {
  cursor: pointer;
  color: #2563eb;
}

.plm-audit__details pre {
  margin-top: 8px;
  white-space: pre-wrap;
  word-break: break-word;
  background: #0f172a;
  color: #e2e8f0;
  border-radius: 10px;
  padding: 10px;
  font-size: 12px;
}

.plm-audit__empty {
  color: #64748b;
}

.plm-audit__empty--table {
  padding: 32px 16px;
  text-align: center;
}

@media (max-width: 960px) {
  .plm-audit {
    padding: 16px;
  }

  .plm-audit__header,
  .plm-audit__pagination,
  .plm-audit__saved-views-header,
  .plm-audit__saved-view-card {
    flex-direction: column;
    align-items: flex-start;
  }

  .plm-audit__saved-view-create {
    width: 100%;
    flex-direction: column;
    align-items: stretch;
  }

  .plm-audit__team-view-row {
    width: 100%;
    flex-direction: column;
    align-items: stretch;
  }

  .plm-audit__saved-view-input {
    min-width: 0;
    width: 100%;
  }
}
</style>
