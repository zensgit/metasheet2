<template>
  <section class="panel">
    <div class="panel-header">
      <h2>CAD 元数据</h2>
      <div class="panel-actions">
        <button class="btn ghost" @click="panel.copyDeepLink('cad')">复制深链接</button>
        <button class="btn" :disabled="!panel.cadFileId.value || panel.cadLoading.value" @click="panel.loadCadMetadata">
          {{ panel.cadLoading.value ? '加载中...' : '刷新 CAD' }}
        </button>
      </div>
    </div>
    <div class="form-grid compact">
      <label for="plm-cad-file-id">
        CAD File ID
        <input
          id="plm-cad-file-id"
          v-model.trim="panel.cadFileId.value"
          name="plmCadFileId"
          placeholder="从文档选择或输入 file_id"
        />
      </label>
      <label for="plm-cad-other-file-id">
        对比 File ID
        <input
          id="plm-cad-other-file-id"
          v-model.trim="panel.cadOtherFileId.value"
          name="plmCadOtherFileId"
          placeholder="可选，用于差异对比"
        />
      </label>
    </div>
    <PlmTeamViewsBlock
      label="CAD"
      select-id="plm-cad-team-view"
      select-name="plmCadTeamView"
      input-id="plm-cad-team-view-name"
      input-name="plmCadTeamViewName"
      owner-input-id="plm-cad-team-view-owner-user-id"
      owner-input-name="plmCadTeamViewOwnerUserId"
      :team-view-key="panel.cadTeamViewKey"
      :team-view-name="panel.cadTeamViewName"
      :team-view-owner-user-id="panel.cadTeamViewOwnerUserId"
      :team-views="panel.cadTeamViews"
      :loading="panel.cadTeamViewsLoading"
      :error="panel.cadTeamViewsError"
      :can-save="panel.canSaveCadTeamView"
      :can-apply="panel.canApplyCadTeamView"
      :show-manage-actions="panel.showManageCadTeamViewActions"
      :can-duplicate="panel.canDuplicateCadTeamView"
      :can-share="panel.canShareCadTeamView"
      :can-delete="panel.canDeleteCadTeamView"
      :can-archive="panel.canArchiveCadTeamView"
      :can-restore="panel.canRestoreCadTeamView"
      :can-rename="panel.canRenameCadTeamView"
      :can-transfer-target="panel.canTransferCadTeamViewTarget"
      :can-transfer="panel.canTransferCadTeamView"
      :can-set-default="panel.canSetCadTeamViewDefault"
      :can-clear-default="panel.canClearCadTeamViewDefault"
      :default-label="panel.cadDefaultTeamViewLabel"
      :has-manageable-team-views="panel.hasManageableCadTeamViews"
      :show-batch-manager="panel.showCadTeamViewManager"
      :team-view-selection="panel.cadTeamViewSelection"
      :team-view-selection-count="panel.cadTeamViewSelectionCount"
      :selected-batch-archivable-team-view-ids="panel.selectedBatchArchivableCadTeamViewIds"
      :selected-batch-restorable-team-view-ids="panel.selectedBatchRestorableCadTeamViewIds"
      :selected-batch-deletable-team-view-ids="panel.selectedBatchDeletableCadTeamViewIds"
      :refresh="panel.refreshCadTeamViews"
      :apply="panel.applyCadTeamView"
      :save="panel.saveCadTeamView"
      :duplicate="panel.duplicateCadTeamView"
      :share="panel.shareCadTeamView"
      :remove="panel.deleteCadTeamView"
      :archive="panel.archiveCadTeamView"
      :restore="panel.restoreCadTeamView"
      :rename="panel.renameCadTeamView"
      :transfer="panel.transferCadTeamView"
      :set-default="panel.setCadTeamViewDefault"
      :clear-default="panel.clearCadTeamViewDefault"
      :select-all-team-views="panel.selectAllCadTeamViews"
      :clear-team-view-selection="panel.clearCadTeamViewSelection"
      :archive-team-view-selection="panel.archiveCadTeamViewSelection"
      :restore-team-view-selection="panel.restoreCadTeamViewSelection"
      :delete-team-view-selection="panel.deleteCadTeamViewSelection"
    />
    <p v-if="panel.cadStatus.value" class="status">{{ panel.cadStatus.value }}</p>
    <p v-if="panel.cadError.value" class="status error">{{ panel.cadError.value }}</p>
    <p v-if="panel.cadActionStatus.value" class="status">{{ panel.cadActionStatus.value }}</p>
    <p v-if="panel.cadActionError.value" class="status error">{{ panel.cadActionError.value }}</p>
    <div class="cad-grid">
      <div class="cad-card">
        <div class="cad-card-header">
          <h3>属性</h3>
          <button class="btn ghost mini" :disabled="!panel.cadFileId.value || panel.cadUpdating.value" @click="panel.updateCadProperties">
            {{ panel.cadUpdating.value ? '处理中...' : '更新' }}
          </button>
        </div>
        <textarea
          v-model="panel.cadPropertiesDraft.value"
          class="cad-textarea"
          rows="6"
          placeholder='{"properties": {"material": "AL-6061"}, "source": "metasheet"}'
        ></textarea>
        <details class="json-block">
          <summary>原始数据</summary>
          <pre>{{ panel.formatJson(panel.cadProperties.value) }}</pre>
        </details>
      </div>
      <div class="cad-card">
        <div class="cad-card-header">
          <h3>视图状态</h3>
          <button class="btn ghost mini" :disabled="!panel.cadFileId.value || panel.cadUpdating.value" @click="panel.updateCadViewState">
            {{ panel.cadUpdating.value ? '处理中...' : '更新' }}
          </button>
        </div>
        <textarea
          v-model="panel.cadViewStateDraft.value"
          class="cad-textarea"
          rows="6"
          placeholder='{"hidden_entity_ids": [12, 15], "notes": [{"entity_id": 12, "note": "check hole"}]}'
        ></textarea>
        <details class="json-block">
          <summary>原始数据</summary>
          <pre>{{ panel.formatJson(panel.cadViewState.value) }}</pre>
        </details>
      </div>
      <div class="cad-card">
        <div class="cad-card-header">
          <h3>评审</h3>
          <button class="btn ghost mini" :disabled="!panel.cadFileId.value || panel.cadUpdating.value" @click="panel.updateCadReview">
            {{ panel.cadUpdating.value ? '处理中...' : '提交' }}
          </button>
        </div>
        <div class="form-grid compact cad-review-form">
          <label for="plm-cad-review-state">
            状态
            <input
              id="plm-cad-review-state"
              v-model.trim="panel.cadReviewState.value"
              name="plmCadReviewState"
              placeholder="approved / rejected"
            />
          </label>
          <label for="plm-cad-review-note">
            备注
            <input
              id="plm-cad-review-note"
              v-model.trim="panel.cadReviewNote.value"
              name="plmCadReviewNote"
              placeholder="可选"
            />
          </label>
        </div>
        <details class="json-block">
          <summary>原始数据</summary>
          <pre>{{ panel.formatJson(panel.cadReview.value) }}</pre>
        </details>
      </div>
      <div class="cad-card cad-span">
        <div class="cad-card-header">
          <h3>变更历史</h3>
        </div>
        <div v-if="!panel.cadHistoryEntries.value.length" class="empty">暂无历史</div>
        <table v-else class="data-table">
          <thead>
            <tr>
              <th>动作</th>
              <th>时间</th>
              <th>用户</th>
              <th>Payload</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in panel.cadHistoryEntries.value" :key="entry.id">
              <td>{{ entry.action }}</td>
              <td>{{ panel.formatTime(entry.created_at) }}</td>
              <td>{{ entry.user_id ?? '-' }}</td>
              <td>
                <details class="inline-details">
                  <summary>查看</summary>
                  <pre class="inline-pre">{{ panel.formatJson(entry.payload) }}</pre>
                </details>
              </td>
            </tr>
          </tbody>
        </table>
        <details class="json-block">
          <summary>原始数据</summary>
          <pre>{{ panel.formatJson(panel.cadHistory.value) }}</pre>
        </details>
      </div>
      <div class="cad-card">
        <div class="cad-card-header">
          <h3>差异</h3>
          <button
            class="btn ghost mini"
            :disabled="!panel.cadFileId.value || !panel.cadOtherFileId.value || panel.cadDiffLoading.value"
            @click="panel.loadCadDiff"
          >
            {{ panel.cadDiffLoading.value ? '对比中...' : '加载' }}
          </button>
        </div>
        <div v-if="!panel.cadDiff.value" class="empty">暂无差异数据</div>
        <details v-else class="json-block">
          <summary>原始数据</summary>
          <pre>{{ panel.formatJson(panel.cadDiff.value) }}</pre>
        </details>
      </div>
      <div class="cad-card">
        <div class="cad-card-header">
          <h3>网格统计</h3>
        </div>
        <div v-if="!panel.cadMeshStats.value" class="empty">暂无网格统计</div>
        <details v-else class="json-block">
          <summary>原始数据</summary>
          <pre>{{ panel.formatJson(panel.cadMeshStats.value) }}</pre>
        </details>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import PlmTeamViewsBlock from './PlmTeamViewsBlock.vue'
import type { PlmCadPanelModel } from '../../views/plm/plmPanelModels'

defineProps<{
  panel: PlmCadPanelModel
}>()
</script>

<style scoped src="./PlmPanelShared.css"></style>
