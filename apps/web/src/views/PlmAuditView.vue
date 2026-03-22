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

    <section v-if="auditSceneContext" id="plm-audit-scene-context" class="plm-audit__context">
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
          v-if="auditReturnToPlmPath"
          class="plm-audit__button plm-audit__button--primary"
          type="button"
          :disabled="logsLoading"
          @click="returnToWorkbenchScene"
        >
          {{ tr('Return to scene', '返回原场景') }}
        </button>
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
      <div v-if="auditSceneSaveDraft" class="plm-audit__context-save">
        <span class="plm-audit__muted">{{ auditSceneSaveDraft.description }}</span>
        <div class="plm-audit__context-actions">
          <button class="plm-audit__button" type="button" :disabled="logsLoading" @click="runAuditSceneSaveAction('saved-view')">
            {{ tr('Save scene view', '保存场景视图') }}
          </button>
          <button class="plm-audit__button" type="button" :disabled="logsLoading || auditTeamViewsLoading" @click="runAuditSceneSaveAction('team-view')">
            {{ tr('Save scene to team', '保存场景到团队') }}
          </button>
          <button class="plm-audit__button" type="button" :disabled="logsLoading || auditTeamViewsLoading" @click="runAuditSceneSaveAction('team-default')">
            {{ tr('Save scene as default', '保存场景为默认') }}
          </button>
        </div>
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

    <section id="plm-audit-team-view-controls" class="plm-audit__team-views">
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
        <button class="plm-audit__button" type="button" :disabled="!canDuplicateAuditTeamView || auditTeamViewsLoading" @click="duplicateAuditTeamView">
          {{ tr('Duplicate', '复制副本') }}
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
        <button class="plm-audit__button" type="button" :disabled="!canArchiveAuditTeamView || auditTeamViewsLoading" @click="archiveAuditTeamView">
          {{ tr('Archive', '归档') }}
        </button>
        <button class="plm-audit__button" type="button" :disabled="!canRestoreAuditTeamView || auditTeamViewsLoading" @click="restoreAuditTeamView">
          {{ tr('Restore', '恢复') }}
        </button>
      </div>

      <div v-if="auditTeamViewCollaborationNotice" class="plm-audit__team-view-collaboration">
        <div class="plm-audit__team-view-collaboration-meta">
          <small class="plm-audit__summary-source">{{ auditTeamViewCollaborationNotice.sourceLabel }}</small>
          <strong>{{ auditTeamViewCollaborationNotice.title }}</strong>
          <span class="plm-audit__muted">{{ auditTeamViewCollaborationNotice.description }}</span>
        </div>
        <div class="plm-audit__team-view-collaboration-actions">
          <button
            v-for="actionItem in auditTeamViewCollaborationNotice.actions"
            :key="`team-view-collaboration-${actionItem.kind}`"
            class="plm-audit__button"
            :class="{ 'plm-audit__button--primary': actionItem.emphasis === 'primary' }"
            type="button"
            :disabled="auditTeamViewsLoading"
            @click="runAuditTeamViewCollaborationAction(actionItem.kind)"
          >
            {{ actionItem.label }}
          </button>
        </div>
      </div>

      <div v-if="auditTeamViewShareEntryNotice" class="plm-audit__team-view-share-entry">
        <div class="plm-audit__team-view-collaboration-meta">
          <small class="plm-audit__summary-source">{{ auditTeamViewShareEntryNotice.sourceLabel }}</small>
          <strong>{{ auditTeamViewShareEntryNotice.title }}</strong>
          <span class="plm-audit__muted">{{ auditTeamViewShareEntryNotice.description }}</span>
        </div>
        <div class="plm-audit__team-view-collaboration-actions">
          <button
            v-for="actionItem in auditTeamViewShareEntryNotice.actions"
            :key="`team-view-share-entry-${actionItem.kind}`"
            class="plm-audit__button"
            :class="{ 'plm-audit__button--primary': actionItem.emphasis === 'primary' }"
            type="button"
            :disabled="auditTeamViewsLoading"
            @click="runAuditTeamViewShareEntryAction(actionItem.kind)"
          >
            {{ actionItem.label }}
          </button>
        </div>
      </div>

      <div v-if="auditTeamViewCollaborationFollowupNotice" class="plm-audit__team-view-followup">
        <div class="plm-audit__team-view-collaboration-meta">
          <small class="plm-audit__summary-source">{{ auditTeamViewCollaborationFollowupNotice.sourceLabel }}</small>
          <strong>{{ auditTeamViewCollaborationFollowupNotice.title }}</strong>
          <span class="plm-audit__muted">{{ auditTeamViewCollaborationFollowupNotice.description }}</span>
        </div>
        <div class="plm-audit__team-view-collaboration-actions">
          <button
            v-for="actionItem in auditTeamViewCollaborationFollowupNotice.actions"
            :key="`team-view-collaboration-followup-${actionItem.kind}`"
            class="plm-audit__button"
            :class="{ 'plm-audit__button--primary': actionItem.emphasis === 'primary' }"
            type="button"
            :disabled="auditTeamViewsLoading || logsLoading"
            @click="runAuditTeamViewCollaborationFollowupAction(actionItem.kind)"
          >
            {{ actionItem.label }}
          </button>
        </div>
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

      <div id="plm-audit-recommended-team-views" v-if="recommendedAuditTeamViews.length" class="plm-audit__recommended-team-views">
        <div class="plm-audit__recommended-header">
          <div>
            <h3>{{ tr('Recommended audit team views', '推荐审计团队视图') }}</h3>
            <p class="plm-audit__muted">{{ auditTeamViewSummaryHint.description }}</p>
          </div>
          <div class="plm-audit__summary-chips">
            <button
              v-for="chip in auditTeamViewSummaryChips"
              :key="`audit-team-view-chip-${chip.value || 'all'}`"
              class="plm-audit__summary-chip"
              :class="{ 'plm-audit__summary-chip--active': chip.active }"
              type="button"
              @click="setAuditTeamViewRecommendationFilter(chip.value)"
            >
              {{ chip.label }} · {{ chip.count }}
            </button>
          </div>
        </div>

        <div class="plm-audit__recommended-grid">
          <article
            v-for="view in recommendedAuditTeamViews"
            :key="view.id"
            class="plm-audit__recommended-card"
            :class="{
              'plm-audit__recommended-card--default': view.isDefault,
              'plm-audit__recommended-card--focused': focusedRecommendedAuditTeamViewId === view.id,
            }"
          >
            <div class="plm-audit__recommended-meta">
              <strong>{{ view.name }}</strong>
              <span class="plm-audit__saved-view-source">{{ view.recommendationSourceLabel }}</span>
              <span class="plm-audit__muted">{{ tr('Owner', 'Owner') }}: {{ view.ownerUserId }}</span>
              <span v-if="view.recommendationSourceTimestamp" class="plm-audit__muted">
                {{ formatDate(view.recommendationSourceTimestamp) }}
              </span>
              <span class="plm-audit__muted">{{ view.actionNote }}</span>
            </div>
            <div class="plm-audit__recommended-actions">
              <button
                class="plm-audit__button plm-audit__button--primary"
                type="button"
                :disabled="auditTeamViewsLoading || !findAuditTeamViewById(view.id)"
                @click="applyRecommendedAuditTeamView(view)"
              >
                {{ view.primaryActionLabel }}
              </button>
              <button class="plm-audit__button" type="button" :disabled="auditTeamViewsLoading" @click="runRecommendedAuditTeamViewSecondaryAction(view)">
                {{ view.secondaryActionLabel }}
              </button>
              <button class="plm-audit__button" type="button" :disabled="auditTeamViewsLoading" @click="focusAuditTeamViewManagement(view)">
                {{ view.managementActionLabel }}
              </button>
            </div>
          </article>
        </div>
      </div>

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
        <button class="plm-audit__button" type="button" :disabled="!canRenameAuditTeamView || auditTeamViewsLoading" @click="renameAuditTeamView">
          {{ tr('Rename', '重命名') }}
        </button>
      </div>

      <div class="plm-audit__saved-view-create">
        <input
          v-model="auditTeamViewOwnerUserId"
          class="plm-audit__saved-view-input"
          type="text"
          :placeholder="tr('Target owner user ID', '目标所有者用户 ID')"
          @keydown.enter.prevent="transferAuditTeamView"
        />
        <button class="plm-audit__button" type="button" :disabled="!canTransferAuditTeamView || auditTeamViewsLoading" @click="transferAuditTeamView">
          {{ tr('Transfer owner', '转移所有者') }}
        </button>
      </div>

      <div v-if="auditTeamViewManagementItems.length" class="plm-audit__team-view-manager">
        <div class="plm-audit__recommended-header">
          <div>
            <h3>{{ tr('Manage audit team views', '管理审计团队视图') }}</h3>
            <p class="plm-audit__muted">
              {{ tr('Batch archive, restore, or delete team views without leaving the audit workbench.', '在审计工作台内直接批量归档、恢复或删除团队视图。') }}
            </p>
          </div>
          <div class="plm-audit__summary-chips">
            <button
              class="plm-audit__summary-chip"
              type="button"
              :class="{ 'plm-audit__summary-chip--active': allSelectableAuditTeamViewsSelected }"
              :disabled="!selectableAuditTeamViewCount || auditTeamViewsLoading"
              @click="setAllSelectableAuditTeamViewsSelected(!allSelectableAuditTeamViewsSelected)"
            >
              {{ allSelectableAuditTeamViewsSelected ? tr('Clear selection', '清空选择') : tr('Select all manageable', '全选可管理项') }}
            </button>
          </div>
        </div>

        <div class="plm-audit__team-view-batch-bar">
          <span class="plm-audit__muted">
            {{ tr('Selected', '已选') }} {{ selectedAuditTeamViewCount }} / {{ selectableAuditTeamViewCount }}
          </span>
          <button
            v-for="batchAction in auditTeamViewBatchActions"
            :key="`audit-team-batch-${batchAction.kind}`"
            class="plm-audit__button"
            type="button"
            :disabled="batchAction.disabled || auditTeamViewsLoading"
            @click="runAuditTeamViewBatchAction(batchAction.kind)"
          >
            {{ batchAction.label }} · {{ batchAction.eligibleCount }}
          </button>
        </div>

        <div class="plm-audit__team-view-list">
          <article
            v-for="view in auditTeamViewManagementItems"
            :key="view.id"
            :id="`plm-audit-team-view-${view.id}`"
            class="plm-audit__team-view-card"
            :class="{
              'plm-audit__team-view-card--selected': view.selected,
              'plm-audit__team-view-card--archived': view.isArchived,
              'plm-audit__team-view-card--default': view.isDefault,
              'plm-audit__team-view-card--focused': focusedAuditTeamViewId === view.id,
            }"
          >
            <label class="plm-audit__team-view-select">
              <input
                v-model="auditTeamViewSelection"
                type="checkbox"
                :value="view.id"
                :disabled="!view.selectable || auditTeamViewsLoading"
              />
              <div class="plm-audit__team-view-card-meta">
                <strong>{{ view.name }}</strong>
                <div class="plm-audit__saved-view-badges">
                  <span class="plm-audit__saved-view-source">
                    {{ view.isArchived ? tr('Archived team view', '已归档团队视图') : tr('Active team view', '活跃团队视图') }}
                  </span>
                  <span v-if="view.isDefault" class="plm-audit__saved-view-badge">
                    {{ tr('Default', '默认') }}
                  </span>
                  <span
                    v-if="view.isArchived"
                    class="plm-audit__saved-view-badge plm-audit__saved-view-badge--scene"
                  >
                    {{ tr('Archived', '已归档') }}
                  </span>
                </div>
                <span class="plm-audit__muted">{{ tr('Owner', 'Owner') }}: {{ view.ownerUserId }}</span>
                <span v-if="view.updatedAt" class="plm-audit__muted">
                  {{ tr('Updated', '更新于') }}: {{ formatDate(view.updatedAt) }}
                </span>
                <span v-if="view.selectionHint" class="plm-audit__muted">
                  {{ view.selectionHint }}
                </span>
              </div>
            </label>
            <div class="plm-audit__team-view-card-actions">
              <button
                v-for="actionItem in view.lifecycleActions"
                :key="`${view.id}-${actionItem.kind}`"
                class="plm-audit__button"
                type="button"
                :disabled="actionItem.disabled || auditTeamViewsLoading"
                @click="runAuditTeamViewLifecycleAction(view.id, actionItem.kind)"
              >
                {{ actionItem.label }}
              </button>
            </div>
          </article>
        </div>
      </div>

      <p v-if="auditTeamViewsError" class="plm-audit__status plm-audit__status--error">
        {{ auditTeamViewsError }}
      </p>
    </section>

    <section id="plm-audit-saved-views" class="plm-audit__saved-views">
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

      <div v-if="auditSavedViewShareFollowupNotice" class="plm-audit__team-view-followup">
        <div class="plm-audit__team-view-collaboration-meta">
          <small class="plm-audit__summary-source">{{ auditSavedViewShareFollowupNotice.sourceLabel }}</small>
          <strong>{{ auditSavedViewShareFollowupNotice.title }}</strong>
          <span class="plm-audit__muted">{{ auditSavedViewShareFollowupNotice.description }}</span>
        </div>
        <div class="plm-audit__team-view-collaboration-actions">
          <button
            v-for="actionItem in auditSavedViewShareFollowupNotice.actions"
            :key="`saved-view-share-followup-${actionItem.kind}`"
            class="plm-audit__button"
            :class="{ 'plm-audit__button--primary': actionItem.emphasis === 'primary' }"
            type="button"
            :disabled="auditTeamViewsLoading"
            @click="runAuditSavedViewShareFollowupAction(actionItem.kind)"
          >
            {{ actionItem.label }}
          </button>
        </div>
      </div>

      <div v-if="savedViews.length" class="plm-audit__saved-view-list">
        <article
          v-for="view in savedViews"
          :key="view.id"
          class="plm-audit__saved-view-card"
          :class="{
            'plm-audit__saved-view-card--active': isSavedViewActive(view),
            'plm-audit__saved-view-card--focused': auditSavedViewShareFollowup?.savedViewId === view.id,
          }"
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
            <span v-if="savedViewTeamPromotionNote(view)" class="plm-audit__muted">
              {{ savedViewTeamPromotionNote(view) }}
            </span>
            <span class="plm-audit__muted">{{ savedViewSummary(view.state) }}</span>
            <span class="plm-audit__muted">{{ tr('Updated', '更新于') }}: {{ formatDate(view.updatedAt) }}</span>
          </div>
          <div class="plm-audit__saved-view-actions">
            <button class="plm-audit__button" type="button" @click="applySavedView(view)">
              {{ tr('Apply', '应用') }}
            </button>
            <button class="plm-audit__button" type="button" :disabled="auditTeamViewsLoading" @click="promoteSavedViewToTeam(view)">
              {{ tr('Save to team', '保存到团队') }}
            </button>
            <button class="plm-audit__button" type="button" :disabled="auditTeamViewsLoading" @click="promoteSavedViewToTeam(view, { isDefault: true })">
              {{ tr('Save as default team view', '保存为团队默认视图') }}
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

    <div id="plm-audit-log-results" class="plm-audit__table-wrapper">
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
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useLocale } from '../composables/useLocale'
import {
  archivePlmWorkbenchTeamView,
  batchPlmWorkbenchTeamViews,
  clearPlmWorkbenchTeamViewDefault,
  deletePlmWorkbenchTeamView,
  duplicatePlmWorkbenchTeamView,
  exportPlmCollaborativeAuditLogsCsv,
  getPlmCollaborativeAuditSummary,
  listPlmCollaborativeAuditLogs,
  listPlmWorkbenchTeamViews,
  renamePlmWorkbenchTeamView,
  restorePlmWorkbenchTeamView,
  savePlmWorkbenchTeamView,
  setPlmWorkbenchTeamViewDefault,
  transferPlmWorkbenchTeamView,
  type PlmCollaborativeAuditAction,
  type PlmCollaborativeAuditLogItem,
  type PlmCollaborativeAuditResourceType,
  type PlmCollaborativeAuditSummaryRow,
} from '../services/plm/plmWorkbenchClient'
import {
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
  buildPlmAuditSavedViewShareFollowupNotice,
  type PlmAuditSavedViewShareFollowup,
  type PlmAuditSavedViewShareFollowupActionKind,
} from './plmAuditSavedViewShareFollowup'
import {
  buildPlmAuditSavedViewTeamPromotionDraft,
  resolvePlmAuditSavedViewPromotionBehavior,
} from './plmAuditSavedViewPromotion'
import {
  buildPlmAuditSavedViewContextBadge,
  buildPlmAuditSavedViewSummary,
} from './plmAuditSavedViewSummary'
import {
  buildAuditTeamViewSummaryChips,
  buildAuditTeamViewSummaryHint,
  buildRecommendedAuditTeamViews,
  resolveAuditTeamViewRecommendationFilter,
  type PlmRecommendedAuditTeamView,
  type PlmRecommendedAuditTeamViewFilter,
} from './plmAuditTeamViewCatalog'
import {
  buildPlmAuditTeamViewCollaborationActionOutcome,
  buildPlmAuditTeamViewCollaborationHandoff,
  buildPlmAuditTeamViewCollaborationFollowupNotice,
  buildPlmAuditTeamViewCollaborationNotice,
  findPlmAuditTeamViewCollaborationFollowupView,
  type PlmAuditTeamViewCollaborationActionKind,
  type PlmAuditTeamViewCollaborationDraft,
  type PlmAuditTeamViewCollaborationFollowup,
  type PlmAuditTeamViewCollaborationFollowupActionKind,
  type PlmAuditTeamViewCollaborationHandoff,
  type PlmAuditTeamViewCollaborationSource,
} from './plmAuditTeamViewCollaboration'
import {
  buildPlmAuditSharedEntrySavedViewName,
  buildPlmAuditTeamViewShareEntryNotice,
  isPlmAuditSharedLinkEntry,
  type PlmAuditTeamViewShareEntry,
  type PlmAuditTeamViewShareEntryActionKind,
} from './plmAuditTeamViewShareEntry'
import {
  buildPlmAuditTeamViewBatchLogState,
  buildPlmAuditTeamViewLogState,
} from './plmAuditTeamViewAudit'
import {
  buildPlmAuditTeamViewManagement,
  type PlmAuditTeamViewLifecycleActionKind,
} from './plmAuditTeamViewManagement'
import {
  buildPlmAuditSceneContextBanner,
  buildPlmAuditSceneFilterHighlight,
  resolvePlmAuditSceneSemantic,
} from './plmAuditSceneCopy'
import {
  buildPlmAuditSceneQueryValue,
  isPlmAuditSceneOwnerContextActive,
  isPlmAuditSceneQueryContextActive,
  withoutPlmAuditSceneContext,
  withPlmAuditSceneOwnerContext,
  withPlmAuditSceneQueryContext,
} from './plmAuditSceneContext'
import { buildPlmAuditSceneInputToken } from './plmAuditSceneInputToken'
import { buildPlmAuditSceneSaveDraft } from './plmAuditSceneSaveDraft'
import { buildPlmAuditSceneSummaryCard } from './plmAuditSceneSummary'
import {
  buildPlmAuditSceneToken,
  type PlmAuditSceneTokenActionKind,
} from './plmAuditSceneToken'
import { buildPlmAuditTeamViewContextNote } from './plmAuditTeamViewContext'
import {
  buildPlmAuditPersistedTeamViewRouteState,
  buildPlmAuditSelectedTeamViewRouteState,
  resolvePlmAuditRequestedTeamViewRouteState,
} from './plmAuditTeamViewRouteState'
import { copyTextToClipboard } from './plm/plmClipboard'
import type { PlmWorkbenchTeamView } from './plm/plmPanelModels'
import {
  canSetDefaultPlmCollaborativeEntry,
  usePlmCollaborativePermissions,
} from './plm/usePlmCollaborativePermissions'
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
const auditSavedViewShareFollowup = ref<PlmAuditSavedViewShareFollowup | null>(null)
const auditTeamViewKey = ref(DEFAULT_PLM_AUDIT_ROUTE_STATE.teamViewId)
const auditTeamViewName = ref('')
const auditTeamViewOwnerUserId = ref('')
const auditTeamViewShareEntry = ref<PlmAuditTeamViewShareEntry | null>(null)
const auditTeamViewCollaborationDraft = ref<PlmAuditTeamViewCollaborationDraft | null>(null)
const auditTeamViewCollaborationFollowup = ref<PlmAuditTeamViewCollaborationFollowup | null>(null)
const auditTeamViews = ref<PlmWorkbenchTeamView<'audit'>[]>([])
const auditTeamViewSelection = ref<string[]>([])
const focusedAuditTeamViewId = ref('')
const focusedRecommendedAuditTeamViewId = ref('')
const auditTeamViewsLoading = ref(false)
const auditTeamViewsError = ref('')
const auditTeamViewRecommendationFilter = ref<PlmRecommendedAuditTeamViewFilter>('')

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
const auditSceneRecommendationReason = ref(DEFAULT_PLM_AUDIT_ROUTE_STATE.sceneRecommendationReason)
const auditSceneRecommendationSourceLabel = ref(DEFAULT_PLM_AUDIT_ROUTE_STATE.sceneRecommendationSourceLabel)
const auditReturnToPlmPath = ref(DEFAULT_PLM_AUDIT_ROUTE_STATE.returnToPlmPath)

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
const recommendedAuditTeamViews = computed(() => buildRecommendedAuditTeamViews(auditTeamViews.value, {
  recommendationFilter: auditTeamViewRecommendationFilter.value,
}))
const auditTeamViewSummaryChips = computed(() => buildAuditTeamViewSummaryChips(auditTeamViews.value, {
  recommendationFilter: auditTeamViewRecommendationFilter.value,
}))
const auditTeamViewSummaryHint = computed(() => buildAuditTeamViewSummaryHint(auditTeamViewSummaryChips.value))
const auditTeamViewManagement = computed(() => buildPlmAuditTeamViewManagement(
  auditTeamViews.value,
  auditTeamViewSelection.value,
  tr,
))
const auditTeamViewManagementItems = computed(() => auditTeamViewManagement.value.items)
const auditTeamViewBatchActions = computed(() => auditTeamViewManagement.value.batchActions)
const selectedAuditTeamViewCount = computed(() => auditTeamViewManagement.value.selectedCount)
const selectableAuditTeamViewCount = computed(() => auditTeamViewManagement.value.selectableCount)
const allSelectableAuditTeamViewsSelected = computed(() => (
  selectableAuditTeamViewCount.value > 0
  && selectedAuditTeamViewCount.value === selectableAuditTeamViewCount.value
))
const canSaveAuditTeamView = computed(() => Boolean(auditTeamViewName.value.trim()))
const auditSceneContext = computed(() => {
  return buildPlmAuditSceneContextBanner({
    sceneId: auditSceneId.value,
    sceneName: auditSceneName.value,
    sceneOwnerUserId: auditSceneOwnerUserId.value,
    recommendationReason: auditSceneRecommendationReason.value,
    recommendationSourceLabel: auditSceneRecommendationSourceLabel.value,
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
const auditSceneSaveDraft = computed(() => buildPlmAuditSceneSaveDraft({
  sceneId: auditSceneId.value,
  sceneName: auditSceneName.value,
  sceneOwnerUserId: auditSceneOwnerUserId.value,
  recommendationReason: auditSceneRecommendationReason.value,
}, tr))
const auditSceneFilterHighlight = computed(() => buildPlmAuditSceneFilterHighlight(auditSceneToken.value, tr))
const {
  canApply: canApplyAuditTeamView,
  canDuplicate: canDuplicateAuditTeamView,
  canShare: canShareAuditTeamView,
  canDelete: canDeleteAuditTeamView,
  canArchive: canArchiveAuditTeamView,
  canRestore: canRestoreAuditTeamView,
  canRename: canRenameAuditTeamView,
  canTransfer: canTransferAuditTeamView,
  canSetDefault: canSetAuditTeamViewDefault,
  canClearDefault: canClearAuditTeamViewDefault,
} = usePlmCollaborativePermissions({
  selectedEntry: selectedAuditTeamView,
  nameRef: auditTeamViewName,
  ownerUserIdRef: auditTeamViewOwnerUserId,
})
const auditTeamViewCollaborationNotice = computed(() => {
  const view = selectedAuditTeamView.value
  if (!view) return null
  if (auditTeamViewCollaborationFollowup.value?.teamViewId === view.id) return null
  if (auditTeamViewShareEntry.value?.teamViewId === view.id) return null
  return buildPlmAuditTeamViewCollaborationNotice(
    view,
    auditTeamViewCollaborationDraft.value,
    {
      canShare: canShareAuditTeamView.value,
      canSetDefault: canSetAuditTeamViewDefault.value,
    },
    tr,
  )
})
const auditTeamViewShareEntryNotice = computed(() => {
  const view = selectedAuditTeamView.value
  if (!view) return null
  return buildPlmAuditTeamViewShareEntryNotice(
    view,
    auditTeamViewShareEntry.value,
    {
      canDuplicate: canDuplicateAuditTeamView.value,
      canSetDefault: canSetAuditTeamViewDefault.value,
    },
    tr,
  )
})
const auditTeamViewCollaborationFollowupNotice = computed(() => {
  const view = findPlmAuditTeamViewCollaborationFollowupView(
    auditTeamViews.value,
    auditTeamViewCollaborationFollowup.value,
  )
  if (!view) return null
  return buildPlmAuditTeamViewCollaborationFollowupNotice(
    view,
    auditTeamViewCollaborationFollowup.value,
    {
      canSetDefault: canSetDefaultPlmCollaborativeEntry(view),
    },
    tr,
  )
})
const auditSavedViewShareFollowupNotice = computed(() => {
  const followup = auditSavedViewShareFollowup.value
  if (!followup) return null
  const view = savedViews.value.find((entry) => entry.id === followup.savedViewId)
  if (!view) return null
  return buildPlmAuditSavedViewShareFollowupNotice(view, followup, tr)
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
    sceneRecommendationReason: auditSceneRecommendationReason.value,
    sceneRecommendationSourceLabel: auditSceneRecommendationSourceLabel.value,
    returnToPlmPath: auditReturnToPlmPath.value,
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
  auditSceneRecommendationReason.value = state.sceneRecommendationReason
  auditSceneRecommendationSourceLabel.value = state.sceneRecommendationSourceLabel
  auditReturnToPlmPath.value = state.returnToPlmPath
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
  await syncRouteState(withoutPlmAuditSceneContext(readCurrentRouteState()))
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
  if (actionKind === 'scene' || actionKind === 'reapply-scene') {
    await restoreAuditSceneQuery()
  }
}

async function runAuditSceneSummaryAction(actionKind: 'owner' | 'scene' | 'reapply-scene' | null) {
  if (actionKind === 'reapply-scene') {
    await restoreAuditSceneQuery()
    return
  }
  await runAuditSceneTokenAction(actionKind)
}

async function returnToWorkbenchScene() {
  if (!auditReturnToPlmPath.value) return
  await router.push(auditReturnToPlmPath.value).catch(() => null)
}

async function runAuditSceneSaveAction(actionKind: 'saved-view' | 'team-view' | 'team-default') {
  const draft = auditSceneSaveDraft.value
  if (!draft) return

  if (actionKind === 'saved-view') {
    const saved = storeAuditSavedView(
      draft.savedViewName,
      tr('Scene audit saved view stored.', '场景审计已保存为本地视图。'),
    )
    if (!saved) return
    auditSavedViewShareFollowup.value = {
      savedViewId: saved.id,
      source: 'scene-context',
    }
    await nextTick()
    document.getElementById('plm-audit-saved-views')?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    })
    return
  }

  const saved = await persistAuditTeamView(
    draft.teamViewName,
    {
      isDefault: actionKind === 'team-default',
    },
    actionKind === 'team-default'
      ? tr('Scene audit saved as the default team view.', '场景审计已保存为团队默认视图。')
      : tr('Scene audit saved to team views.', '场景审计已保存到团队视图。'),
  )
  if (!saved) return
  const collaborationHandoff = buildPlmAuditTeamViewCollaborationHandoff(
    saved,
    {
      source: 'scene-context',
      mode: actionKind === 'team-default' ? 'set-default-followup' : 'draft',
      selectable: Boolean(auditTeamViewManagementItems.value.find((item) => item.id === saved.id)?.selectable),
      sceneContextAvailable: Boolean(auditSceneContext.value),
    },
    tr,
  )
  if (actionKind === 'team-default') {
    applyAuditTeamViewCollaborationHandoff(collaborationHandoff)
    await nextTick()
    document.getElementById(collaborationHandoff.scrollTargetId)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    })
    return
  }
  applyAuditTeamViewCollaborationHandoff(collaborationHandoff)
  await nextTick()
  document.getElementById(collaborationHandoff.scrollTargetId)?.scrollIntoView({
    behavior: 'smooth',
    block: 'start',
  })
}

function tr(en: string, zh: string): string {
  return isZh.value ? zh : en
}

function setStatus(message: string, kindValue: 'info' | 'error' = 'info') {
  statusMessage.value = message
  statusKind.value = kindValue
}

function storeAuditSavedView(name: string, successMessage?: string) {
  const trimmedName = name.trim()
  if (!trimmedName) {
    setStatus(tr('Enter a name for the saved view.', '请输入已保存视图名称。'), 'error')
    return null
  }

  savedViews.value = savePlmAuditSavedView(trimmedName, readCurrentRouteState())
  clearAuditSavedViewShareFollowup()
  savedViewName.value = ''
  setStatus(successMessage || tr('Audit saved view stored.', '审计已保存视图已保存。'))
  return savedViews.value[0] || null
}

async function persistAuditTeamView(
  name: string,
  options?: {
    isDefault?: boolean
  },
  successMessage?: string,
) {
  const trimmedName = name.trim()
  if (!trimmedName) {
    setStatus(tr('Enter a team view name.', '请输入团队视图名称。'), 'error')
    return null
  }

  auditTeamViewsLoading.value = true
  auditTeamViewsError.value = ''
  try {
    const saved = await savePlmWorkbenchTeamView('audit', trimmedName, buildCurrentAuditTeamViewState(), {
      isDefault: options?.isDefault,
    })
    const savedState = buildPlmAuditPersistedTeamViewRouteState(
      saved,
      readCurrentRouteState(),
      {
        isDefault: options?.isDefault,
      },
    )
    upsertAuditTeamView(saved)
    applyAuditTeamViewState(saved)
    auditTeamViewName.value = ''
    focusedAuditTeamViewId.value = saved.id
    await syncRouteState(savedState)
    setStatus(successMessage || tr('Audit team view saved.', '审计团队视图已保存。'))
    return saved
  } catch (error: unknown) {
    auditTeamViewsError.value = error instanceof Error
      ? error.message
      : tr('Failed to save audit team view', '保存审计团队视图失败')
    setStatus(auditTeamViewsError.value, 'error')
  } finally {
    auditTeamViewsLoading.value = false
  }
  return null
}

function clearAuditTeamViewCollaborationDraft() {
  auditTeamViewCollaborationDraft.value = null
}

function clearAuditTeamViewShareEntry() {
  auditTeamViewShareEntry.value = null
}

function clearAuditTeamViewCollaborationFollowup() {
  auditTeamViewCollaborationFollowup.value = null
}

function clearAuditSavedViewShareFollowup() {
  auditSavedViewShareFollowup.value = null
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

function setAuditTeamViewRecommendationFilter(value: PlmRecommendedAuditTeamViewFilter) {
  auditTeamViewRecommendationFilter.value = value
}

function findAuditTeamViewById(viewId: string) {
  return auditTeamViews.value.find((entry) => entry.id === viewId) || null
}

function upsertAuditTeamView(view: PlmWorkbenchTeamView<'audit'>) {
  const nextItems = auditTeamViews.value
    .filter((entry) => entry.id !== view.id)
    .map((entry) => {
      if (!view.isDefault || !entry.isDefault) return entry
      return {
        ...entry,
        isDefault: false,
      }
    })

  auditTeamViews.value = sortAuditTeamViews([
    view,
    ...nextItems,
  ])
}

function replaceAuditTeamView(view: PlmWorkbenchTeamView<'audit'>) {
  auditTeamViews.value = sortAuditTeamViews(
    auditTeamViews.value.map((entry) => (entry.id === view.id ? view : entry)),
  )
}

function trimAuditTeamViewSelection() {
  const existingIds = new Set(auditTeamViews.value.map((view) => view.id))
  auditTeamViewSelection.value = auditTeamViewSelection.value.filter((id) => existingIds.has(id))
  if (focusedAuditTeamViewId.value && !existingIds.has(focusedAuditTeamViewId.value)) {
    focusedAuditTeamViewId.value = ''
  }
  if (focusedRecommendedAuditTeamViewId.value && !existingIds.has(focusedRecommendedAuditTeamViewId.value)) {
    focusedRecommendedAuditTeamViewId.value = ''
  }
}

function setAllSelectableAuditTeamViewsSelected(nextSelected: boolean) {
  if (!nextSelected) {
    auditTeamViewSelection.value = []
    return
  }
  auditTeamViewSelection.value = auditTeamViewManagementItems.value
    .filter((item) => item.selectable)
    .map((item) => item.id)
}

function removeAuditTeamViews(viewIds: string[]) {
  const removed = new Set(viewIds)
  auditTeamViews.value = auditTeamViews.value.filter((entry) => !removed.has(entry.id))
  auditTeamViewSelection.value = auditTeamViewSelection.value.filter((id) => !removed.has(id))
}

async function clearCurrentAuditTeamViewSelectionIfNeeded(viewIds: string[]) {
  const selectedId = auditTeamViewKey.value
  if (!selectedId || !viewIds.includes(selectedId)) return
  auditTeamViewKey.value = ''
  await syncRouteState({
    ...readCurrentRouteState(),
    teamViewId: '',
  })
}

function buildCurrentAuditTeamViewState() {
  return buildPlmAuditTeamViewState(readCurrentRouteState())
}

function applyAuditTeamViewState(view: Pick<PlmWorkbenchTeamView<'audit'>, 'id' | 'state'>) {
  applyRouteState(buildPlmAuditSelectedTeamViewRouteState(view))
}

function applyAuditTeamViewCollaborationHandoff(handoff: PlmAuditTeamViewCollaborationHandoff) {
  auditTeamViewCollaborationDraft.value = handoff.draft
  auditTeamViewCollaborationFollowup.value = handoff.followup
  auditTeamViewKey.value = handoff.selectedTeamViewId || ''
  if (handoff.teamViewName !== null) {
    auditTeamViewName.value = handoff.teamViewName
  }
  if (handoff.teamViewOwnerUserId !== null) {
    auditTeamViewOwnerUserId.value = handoff.teamViewOwnerUserId
  }
  if (handoff.selectedIds) {
    auditTeamViewSelection.value = handoff.selectedIds
  }
  focusedAuditTeamViewId.value = handoff.focusedTeamViewId
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

function savedViewTeamPromotionNote(view: PlmAuditSavedView) {
  return buildPlmAuditSavedViewTeamPromotionDraft(view, tr).localContextNote
}

function buildSavedViewContextState(
  view: PlmAuditSavedView,
  actionKind: 'owner' | 'scene' | 'reapply-scene',
) {
  if (actionKind === 'owner') return withPlmAuditSceneOwnerContext(view.state)
  return withPlmAuditSceneQueryContext(view.state)
}

function isSavedViewActive(view: PlmAuditSavedView) {
  return isPlmAuditRouteStateEqual(view.state, readCurrentRouteState())
}

function runSavedViewContextAction(
  view: PlmAuditSavedView,
  actionKind: 'owner' | 'scene' | 'reapply-scene',
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
  const requestedSharedEntry = isPlmAuditSharedLinkEntry(route.query.auditEntry)
  try {
    const result = await listPlmWorkbenchTeamViews('audit')
    auditTeamViews.value = sortAuditTeamViews(result.items)

    const requestedState = parsePlmAuditRouteState(route.query)
    const resolution = resolvePlmAuditRequestedTeamViewRouteState(
      requestedState,
      auditTeamViews.value,
      defaultAuditTeamView.value,
    )

    if (resolution.kind === 'apply-view') {
      if (requestedSharedEntry && requestedState.teamViewId.trim()) {
        auditTeamViewShareEntry.value = {
          teamViewId: resolution.viewId,
        }
      }
      applyRouteState(resolution.nextState)
      if (!isPlmAuditRouteStateEqual(resolution.nextState, requestedState)) {
        await syncRouteState(resolution.nextState, true)
      }
      return
    }

    if (resolution.kind === 'clear-selection') {
      applyRouteState(resolution.nextState)
      if (!isPlmAuditRouteStateEqual(resolution.nextState, requestedState)) {
        await syncRouteState(resolution.nextState, true)
      }
      return
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
  await persistAuditTeamView(
    auditTeamViewName.value.trim(),
    {},
    tr('Audit team view saved.', '审计团队视图已保存。'),
  )
}

async function applyAuditTeamView() {
  const view = selectedAuditTeamView.value
  if (!view || !canApplyAuditTeamView.value) return

  await applyAuditTeamViewEntry(view)
}

async function shareAuditTeamView() {
  const view = selectedAuditTeamView.value
  if (!view || !canShareAuditTeamView.value) return

  await shareAuditTeamViewEntry(view)
}

async function duplicateAuditTeamView() {
  const view = selectedAuditTeamView.value
  if (!view || !canDuplicateAuditTeamView.value) return

  auditTeamViewsLoading.value = true
  auditTeamViewsError.value = ''
  try {
    const duplicated = await duplicatePlmWorkbenchTeamView(
      'audit',
      view.id,
      auditTeamViewName.value.trim() || undefined,
    )
    const duplicatedState = buildPlmAuditSelectedTeamViewRouteState(duplicated)
    upsertAuditTeamView(duplicated)
    applyRouteState(duplicatedState)
    clearAuditTeamViewShareEntry()
    auditTeamViewName.value = ''
    focusedAuditTeamViewId.value = duplicated.id
    await syncRouteState(duplicatedState)
    setStatus(tr('Audit team view duplicated.', '审计团队视图已复制。'))
  } catch (error: unknown) {
    auditTeamViewsError.value = error instanceof Error
      ? error.message
      : tr('Failed to duplicate audit team view', '复制审计团队视图失败')
    setStatus(auditTeamViewsError.value, 'error')
  } finally {
    auditTeamViewsLoading.value = false
  }
}

async function renameAuditTeamView() {
  const view = selectedAuditTeamView.value
  if (!view || !canRenameAuditTeamView.value) return

  auditTeamViewsLoading.value = true
  auditTeamViewsError.value = ''
  try {
    const renamed = await renamePlmWorkbenchTeamView(
      'audit',
      view.id,
      auditTeamViewName.value.trim(),
    )
    replaceAuditTeamView(renamed)
    applyAuditTeamViewState(renamed)
    auditTeamViewKey.value = renamed.id
    auditTeamViewName.value = ''
    focusedAuditTeamViewId.value = renamed.id
    setStatus(tr('Audit team view renamed.', '审计团队视图已重命名。'))
  } catch (error: unknown) {
    auditTeamViewsError.value = error instanceof Error
      ? error.message
      : tr('Failed to rename audit team view', '重命名审计团队视图失败')
    setStatus(auditTeamViewsError.value, 'error')
  } finally {
    auditTeamViewsLoading.value = false
  }
}

async function setAuditTeamViewDefault() {
  const view = selectedAuditTeamView.value
  if (!view || !canSetAuditTeamViewDefault.value) return

  await setAuditTeamViewDefaultEntry(view)
}

async function transferAuditTeamView() {
  const view = selectedAuditTeamView.value
  if (!view || !canTransferAuditTeamView.value) return

  auditTeamViewsLoading.value = true
  auditTeamViewsError.value = ''
  try {
    const saved = await transferPlmWorkbenchTeamView(
      'audit',
      view.id,
      auditTeamViewOwnerUserId.value.trim(),
    )
    replaceAuditTeamView(saved)
    applyAuditTeamViewState(saved)
    auditTeamViewKey.value = saved.id
    auditTeamViewOwnerUserId.value = ''
    focusedAuditTeamViewId.value = saved.id
    setStatus(tr('Audit team view owner transferred.', '审计团队视图所有者已转移。'))
  } catch (error: unknown) {
    auditTeamViewsError.value = error instanceof Error
      ? error.message
      : tr('Failed to transfer audit team view owner', '转移审计团队视图所有者失败')
    setStatus(auditTeamViewsError.value, 'error')
  } finally {
    auditTeamViewsLoading.value = false
  }
}

async function applyAuditTeamViewEntry(view: PlmWorkbenchTeamView<'audit'>) {
  const nextState = buildPlmAuditSelectedTeamViewRouteState(view)
  applyRouteState(nextState)
  clearAuditTeamViewCollaborationDraft()
  clearAuditTeamViewShareEntry()
  clearAuditTeamViewCollaborationFollowup()
  await syncRouteState(nextState)
  setStatus(tr('Audit team view applied.', '审计团队视图已应用。'))
}

async function shareAuditTeamViewEntry(
  view: PlmWorkbenchTeamView<'audit'>,
  source?: PlmAuditTeamViewCollaborationSource,
) {
  const ok = await copyTextToClipboard(buildAuditTeamViewShareUrl(view))
  if (!ok) {
    setStatus(tr('Failed to copy team view link.', '复制团队视图链接失败。'), 'error')
    return false
  }
  const outcome = buildPlmAuditTeamViewCollaborationActionOutcome(
    view.id,
    source,
    'share',
    tr,
    {
      sceneContextAvailable: Boolean(auditSceneContext.value),
    },
  )
  setStatus(outcome.statusMessage)
  auditTeamViewCollaborationFollowup.value = outcome.followup
  return true
}

async function setAuditTeamViewDefaultEntry(
  view: PlmWorkbenchTeamView<'audit'>,
  source?: PlmAuditTeamViewCollaborationSource,
) {
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
    focusedAuditTeamViewId.value = saved.id
    await syncRouteState(buildPlmAuditTeamViewLogState(saved, 'set-default', readCurrentRouteState()))
    const outcome = buildPlmAuditTeamViewCollaborationActionOutcome(
      saved.id,
      source,
      'set-default',
      tr,
      {
        sceneContextAvailable: Boolean(auditSceneContext.value),
      },
    )
    setStatus(outcome.statusMessage)
    auditTeamViewCollaborationFollowup.value = outcome.followup
    await nextTick()
    if (outcome.scrollTargetId) {
      document.getElementById(outcome.scrollTargetId)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      })
    }
    return true
  } catch (error: unknown) {
    auditTeamViewsError.value = error instanceof Error
      ? error.message
      : tr('Failed to set audit team view default', '设置审计团队视图默认失败')
    setStatus(auditTeamViewsError.value, 'error')
  } finally {
    auditTeamViewsLoading.value = false
  }
  return false
}

async function applyRecommendedAuditTeamView(view: PlmRecommendedAuditTeamView) {
  const target = findAuditTeamViewById(view.id)
  if (!target || target.isArchived) return
  await applyAuditTeamViewEntry(target)
}

async function focusAuditTeamViewManagement(view: PlmRecommendedAuditTeamView) {
  const target = findAuditTeamViewById(view.id)
  if (!target) return

  const collaborationHandoff = buildPlmAuditTeamViewCollaborationHandoff(
    target,
    {
      source: 'recommendation',
      mode: 'draft',
      selectable: Boolean(auditTeamViewManagementItems.value.find((item) => item.id === target.id)?.selectable),
    },
    tr,
  )
  applyAuditTeamViewCollaborationHandoff(collaborationHandoff)
  await nextTick()
  document.getElementById(collaborationHandoff.scrollTargetId)?.scrollIntoView({
    behavior: 'smooth',
    block: 'center',
  })
  setStatus(collaborationHandoff.statusMessage)
}

async function focusRecommendedAuditTeamView(view: PlmWorkbenchTeamView<'audit'>) {
  auditTeamViewRecommendationFilter.value = resolveAuditTeamViewRecommendationFilter(view)
  focusedRecommendedAuditTeamViewId.value = view.id
  await nextTick()
  document.getElementById('plm-audit-recommended-team-views')?.scrollIntoView({
    behavior: 'smooth',
    block: 'start',
  })
}

async function runRecommendedAuditTeamViewSecondaryAction(view: PlmRecommendedAuditTeamView) {
  const target = findAuditTeamViewById(view.id)
  if (!target || target.isArchived) return

  if (view.secondaryActionKind === 'set-default') {
    await setAuditTeamViewDefaultEntry(target, 'recommendation')
    return
  }

  await shareAuditTeamViewEntry(target, 'recommendation')
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
    focusedAuditTeamViewId.value = saved.id
    await syncRouteState(buildPlmAuditTeamViewLogState(saved, 'clear-default', readCurrentRouteState()))
    setStatus(tr('Audit team view default cleared. Showing matching audit logs.', '审计团队视图默认已取消，已切换到对应审计日志。'))
  } catch (error: unknown) {
    auditTeamViewsError.value = error instanceof Error
      ? error.message
      : tr('Failed to clear audit team view default', '取消审计团队视图默认失败')
    setStatus(auditTeamViewsError.value, 'error')
  } finally {
    auditTeamViewsLoading.value = false
  }
}

async function runAuditTeamViewCollaborationAction(actionKind: PlmAuditTeamViewCollaborationActionKind) {
  const view = selectedAuditTeamView.value
  if (!view) return
  const source = auditTeamViewCollaborationDraft.value?.source

  if (actionKind === 'dismiss') {
    clearAuditTeamViewCollaborationDraft()
    return
  }

  if (actionKind === 'share') {
    await shareAuditTeamViewEntry(view, source)
    return
  }

  const ok = await setAuditTeamViewDefaultEntry(view, source)
  if (ok) clearAuditTeamViewCollaborationDraft()
}

async function runAuditTeamViewCollaborationFollowupAction(
  actionKind: PlmAuditTeamViewCollaborationFollowupActionKind,
) {
  const followup = auditTeamViewCollaborationFollowup.value
  if (!followup) return

  if (actionKind === 'dismiss') {
    clearAuditTeamViewCollaborationFollowup()
    return
  }

  if (actionKind === 'view-logs') {
    document.getElementById(followup.logsAnchorId)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    })
    return
  }

  if (actionKind === 'focus-source') {
    document.getElementById(followup.sourceAnchorId)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    })
    return
  }

  const view = findAuditTeamViewById(followup.teamViewId)
  if (!view) return
  await setAuditTeamViewDefaultEntry(view, followup.source)
}

async function runAuditTeamViewShareEntryAction(actionKind: PlmAuditTeamViewShareEntryActionKind) {
  if (actionKind === 'dismiss') {
    clearAuditTeamViewShareEntry()
    return
  }

  const view = selectedAuditTeamView.value
  if (!view) return

  if (actionKind === 'save-local') {
    savedViews.value = savePlmAuditSavedView(
      buildPlmAuditSharedEntrySavedViewName(view, tr),
      readCurrentRouteState(),
    )
    const savedEntry = savedViews.value[0]
    auditSavedViewShareFollowup.value = savedEntry
      ? { savedViewId: savedEntry.id, source: 'shared-entry' }
      : null
    savedViewName.value = ''
    clearAuditTeamViewShareEntry()
    setStatus(tr('Shared audit team view saved locally.', '已将分享的审计团队视图保存为本地视图。'))
    await nextTick()
    document.getElementById('plm-audit-saved-views')?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    })
    return
  }

  if (actionKind === 'duplicate') {
    await duplicateAuditTeamView()
    return
  }

  const ok = await setAuditTeamViewDefaultEntry(view)
  if (ok) clearAuditTeamViewShareEntry()
}

async function runAuditSavedViewShareFollowupAction(actionKind: PlmAuditSavedViewShareFollowupActionKind) {
  const followup = auditSavedViewShareFollowup.value
  if (!followup) return

  if (actionKind === 'dismiss') {
    clearAuditSavedViewShareFollowup()
    return
  }

  const view = savedViews.value.find((entry) => entry.id === followup.savedViewId)
  if (!view) {
    clearAuditSavedViewShareFollowup()
    return
  }

  await promoteSavedViewToTeam(view, actionKind === 'promote-default' ? { isDefault: true } : undefined)
}

async function archiveAuditTeamView() {
  const view = selectedAuditTeamView.value
  if (!view || !canArchiveAuditTeamView.value) return
  await runAuditTeamViewLifecycleAction(view.id, 'archive')
}

async function restoreAuditTeamView() {
  const view = selectedAuditTeamView.value
  if (!view || !canRestoreAuditTeamView.value) return
  await runAuditTeamViewLifecycleAction(view.id, 'restore')
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

async function runAuditTeamViewLifecycleAction(
  viewId: string,
  actionKind: PlmAuditTeamViewLifecycleActionKind,
) {
  const view = findAuditTeamViewById(viewId)
  if (!view) return

  auditTeamViewsLoading.value = true
  auditTeamViewsError.value = ''
  try {
    if (actionKind === 'delete') {
      await deletePlmWorkbenchTeamView(view.id)
      removeAuditTeamViews([view.id])
      await clearCurrentAuditTeamViewSelectionIfNeeded([view.id])
      focusedAuditTeamViewId.value = ''
      await syncRouteState(buildPlmAuditTeamViewLogState(view, 'delete', readCurrentRouteState()))
      setStatus(tr('Audit team view deleted. Showing matching audit logs.', '审计团队视图已删除，已切换到对应审计日志。'))
      return
    }

    const saved = actionKind === 'archive'
      ? await archivePlmWorkbenchTeamView('audit', view.id)
      : await restorePlmWorkbenchTeamView('audit', view.id)

    replaceAuditTeamView(saved)
    focusedAuditTeamViewId.value = saved.id

    if (actionKind === 'archive') {
      auditTeamViewSelection.value = auditTeamViewSelection.value.filter((id) => id !== view.id)
      await clearCurrentAuditTeamViewSelectionIfNeeded([view.id])
      await syncRouteState(buildPlmAuditTeamViewLogState(saved, 'archive', readCurrentRouteState()))
      setStatus(tr('Audit team view archived. Showing matching audit logs.', '审计团队视图已归档，已切换到对应审计日志。'))
      return
    }

    await syncRouteState(buildPlmAuditTeamViewLogState(saved, 'restore', readCurrentRouteState()))
    setStatus(tr('Audit team view restored. Showing matching audit logs.', '审计团队视图已恢复，已切换到对应审计日志。'))
  } catch (error: unknown) {
    auditTeamViewsError.value = error instanceof Error
      ? error.message
      : actionKind === 'archive'
        ? tr('Failed to archive audit team view', '归档审计团队视图失败')
        : actionKind === 'restore'
          ? tr('Failed to restore audit team view', '恢复审计团队视图失败')
          : tr('Failed to delete audit team view', '删除审计团队视图失败')
    setStatus(auditTeamViewsError.value, 'error')
  } finally {
    auditTeamViewsLoading.value = false
  }
}

async function runAuditTeamViewBatchAction(actionKind: PlmAuditTeamViewLifecycleActionKind) {
  const batchAction = auditTeamViewBatchActions.value.find((item) => item.kind === actionKind)
  if (!batchAction || batchAction.disabled) return

  auditTeamViewsLoading.value = true
  auditTeamViewsError.value = ''
  try {
    const result = await batchPlmWorkbenchTeamViews('audit', actionKind, batchAction.eligibleIds)

    if (actionKind === 'delete') {
      removeAuditTeamViews(result.processedIds)
      await clearCurrentAuditTeamViewSelectionIfNeeded(result.processedIds)
    } else {
      const updatedViews = new Map(result.items.map((item) => [item.id, item]))
      auditTeamViews.value = sortAuditTeamViews(
        auditTeamViews.value.map((entry) => updatedViews.get(entry.id) || entry),
      )
      if (actionKind === 'archive') {
        auditTeamViewSelection.value = result.skippedIds
      } else {
        auditTeamViewSelection.value = result.skippedIds.length ? result.skippedIds : batchAction.eligibleIds
      }
      if (actionKind === 'archive') {
        await clearCurrentAuditTeamViewSelectionIfNeeded(result.processedIds)
      }
    }

    const processedTotal = result.processedIds.length
    const skippedTotal = result.skippedIds.length
    const actionLabelText = actionKind === 'archive'
      ? tr('archived', '已归档')
      : actionKind === 'restore'
        ? tr('restored', '已恢复')
        : tr('deleted', '已删除')
    const skippedSuffix = skippedTotal
      ? tr(` (${skippedTotal} skipped)`, `（跳过 ${skippedTotal} 项）`)
      : ''
    const processedViews = result.processedIds
      .map((id) => findAuditTeamViewById(id))
      .filter((view): view is PlmWorkbenchTeamView<'audit'> => Boolean(view))
    await syncRouteState(buildPlmAuditTeamViewBatchLogState(
      processedViews.length ? processedViews : batchAction.eligibleIds.map((id) => ({ id, kind: 'audit' as const })),
      actionKind,
      readCurrentRouteState(),
    ))
    focusedAuditTeamViewId.value = processedViews[0]?.id || ''
    setStatus(tr(`${processedTotal} team views ${actionLabelText}${skippedSuffix}. Showing matching audit logs.`, `${processedTotal} 个团队视图${actionLabelText}${skippedSuffix}，已切换到对应审计日志。`))
  } catch (error: unknown) {
    auditTeamViewsError.value = error instanceof Error
      ? error.message
      : actionKind === 'archive'
        ? tr('Failed to batch archive audit team views', '批量归档审计团队视图失败')
        : actionKind === 'restore'
          ? tr('Failed to batch restore audit team views', '批量恢复审计团队视图失败')
          : tr('Failed to batch delete audit team views', '批量删除审计团队视图失败')
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
  storeAuditSavedView(savedViewName.value.trim())
}

function applySavedView(view: PlmAuditSavedView) {
  void syncRouteState(view.state)
}

function deleteSavedViewEntry(id: string) {
  savedViews.value = deletePlmAuditSavedView(id)
  if (auditSavedViewShareFollowup.value?.savedViewId === id) {
    clearAuditSavedViewShareFollowup()
  }
  setStatus(tr('Audit saved view deleted.', '审计已保存视图已删除。'))
}

async function promoteSavedViewToTeam(
  view: PlmAuditSavedView,
  options?: {
    isDefault?: boolean
  },
) {
  auditTeamViewsLoading.value = true
  auditTeamViewsError.value = ''
  try {
    const followupSource = auditSavedViewShareFollowup.value?.savedViewId === view.id
      ? auditSavedViewShareFollowup.value.source
      : null
    const promotionBehavior = resolvePlmAuditSavedViewPromotionBehavior(followupSource, options)
    const draft = buildPlmAuditSavedViewTeamPromotionDraft(view, tr)
    const saved = await savePlmWorkbenchTeamView('audit', draft.name, draft.state, {
      isDefault: options?.isDefault,
    })
    const savedState = buildPlmAuditPersistedTeamViewRouteState(
      saved,
      readCurrentRouteState(),
      {
        isDefault: options?.isDefault,
      },
    )
    upsertAuditTeamView(saved)
    if (auditSavedViewShareFollowup.value?.savedViewId === view.id) {
      clearAuditSavedViewShareFollowup()
    }
    applyAuditTeamViewState(saved)
    const collaborationHandoff = buildPlmAuditTeamViewCollaborationHandoff(
      saved,
      {
        source: promotionBehavior.collaborationSource,
        mode: promotionBehavior.shouldShowDefaultFollowup ? 'set-default-followup' : 'draft',
        selectable: Boolean(auditTeamViewManagementItems.value.find((item) => item.id === saved.id)?.selectable),
        sceneContextAvailable: Boolean(auditSceneContext.value),
        statusSuffix: draft.localContextNote,
      },
      tr,
    )
    applyAuditTeamViewCollaborationHandoff(collaborationHandoff)
    // Let the canonical route settle before creating draft/follow-up UI so watcher cleanup
    // does not discard freshly created promotion state.
    await syncRouteState(savedState)
    if (promotionBehavior.shouldShowDefaultFollowup) {
      applyAuditTeamViewCollaborationHandoff(collaborationHandoff)
      await nextTick()
      document.getElementById(collaborationHandoff.scrollTargetId)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      })
      setStatus(collaborationHandoff.statusMessage)
      return
    }
    applyAuditTeamViewCollaborationHandoff(collaborationHandoff)
    await nextTick()
    if (promotionBehavior.shouldFocusRecommendation) {
      await focusRecommendedAuditTeamView(saved)
    } else {
      document.getElementById(collaborationHandoff.scrollTargetId)?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
    }
    setStatus(
      [
        options?.isDefault
          ? tr('Saved view promoted as the default audit team view.', '已将保存视图提升为默认审计团队视图。')
          : tr('Saved view promoted to the audit team views.', '已将保存视图提升到审计团队视图。'),
        promotionBehavior.shouldFocusRecommendation
          ? tr('The new team view is highlighted in recommendations.', '新的团队视图已在推荐区高亮显示。')
          : '',
        collaborationHandoff.statusMessage,
      ].filter(Boolean).join(' '),
    )
  } catch (error: unknown) {
    auditTeamViewsError.value = error instanceof Error
      ? error.message
      : tr('Failed to promote saved view to team', '提升保存视图到团队失败')
    setStatus(auditTeamViewsError.value, 'error')
  } finally {
    auditTeamViewsLoading.value = false
  }
}

watch(auditTeamViewKey, (value) => {
  if (auditTeamViewShareEntry.value && value !== auditTeamViewShareEntry.value.teamViewId) {
    clearAuditTeamViewShareEntry()
  }
  if (auditTeamViewCollaborationDraft.value && value !== auditTeamViewCollaborationDraft.value.teamViewId) {
    clearAuditTeamViewCollaborationDraft()
  }
  if (auditTeamViewCollaborationFollowup.value && value !== auditTeamViewCollaborationFollowup.value.teamViewId) {
    clearAuditTeamViewCollaborationFollowup()
  }
})

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

watch(auditTeamViews, () => {
  trimAuditTeamViewSelection()
})

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

.plm-audit__context-save {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 260px;
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

.plm-audit__recommended-team-views {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 8px;
}

.plm-audit__team-view-manager {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.plm-audit__recommended-header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.plm-audit__summary-chips {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 8px;
}

.plm-audit__summary-chip {
  border: 1px solid #d0d5dd;
  background: #fff;
  color: #344054;
  border-radius: 999px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.plm-audit__summary-chip--active {
  border-color: #2563eb;
  background: #eff6ff;
  color: #1d4ed8;
}

.plm-audit__recommended-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
}

.plm-audit__recommended-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid #dbe4f0;
  border-radius: 12px;
  background: linear-gradient(180deg, #f8fbff 0%, #ffffff 100%);
}

.plm-audit__recommended-card--default {
  border-color: #93c5fd;
  box-shadow: 0 0 0 1px rgba(37, 99, 235, 0.12);
}

.plm-audit__recommended-card--focused {
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.18);
}

.plm-audit__recommended-meta,
.plm-audit__recommended-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.plm-audit__team-view-batch-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.plm-audit__team-view-list {
  display: grid;
  gap: 10px;
}

.plm-audit__team-view-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid #dbe4f0;
  border-radius: 12px;
  padding: 12px 14px;
  background: #f8fafc;
}

.plm-audit__team-view-card--selected {
  border-color: #2563eb;
  box-shadow: 0 0 0 1px rgba(37, 99, 235, 0.12);
}

.plm-audit__team-view-card--focused {
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.2);
}

.plm-audit__team-view-card--default {
  background: linear-gradient(180deg, #eff6ff 0%, #f8fafc 100%);
}

.plm-audit__team-view-card--archived {
  background: linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%);
}

.plm-audit__team-view-select {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  flex: 1 1 auto;
}

.plm-audit__team-view-select input {
  margin-top: 4px;
}

.plm-audit__team-view-card-meta,
.plm-audit__team-view-card-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.plm-audit__team-view-card-actions {
  align-items: flex-end;
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

.plm-audit__team-view-collaboration {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid #fde68a;
  border-radius: 12px;
  background: #fffbeb;
}

.plm-audit__team-view-share-entry {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid #c7d2fe;
  border-radius: 12px;
  background: #eef2ff;
}

.plm-audit__team-view-followup {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid #bfdbfe;
  border-radius: 12px;
  background: #eff6ff;
}

.plm-audit__team-view-collaboration-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.plm-audit__team-view-collaboration-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
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

.plm-audit__saved-view-card--focused {
  border-color: #93c5fd;
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.16);
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
  .plm-audit__saved-view-card,
  .plm-audit__team-view-card {
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

  .plm-audit__team-view-card-actions {
    width: 100%;
    align-items: stretch;
  }

  .plm-audit__saved-view-input {
    min-width: 0;
    width: 100%;
  }
}
</style>
