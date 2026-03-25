<template>
  <section class="panel">
    <div class="panel-header">
      <h2>审批</h2>
      <div class="panel-actions">
        <button class="btn ghost" @click="panel.copyDeepLink('approvals')">复制深链接</button>
        <button class="btn ghost" :disabled="!panel.approvalsFiltered.value.length" @click="panel.exportApprovalsCsv">
          导出 CSV
        </button>
        <button class="btn" :disabled="panel.approvalsLoading.value" @click="panel.loadApprovals">
          {{ panel.approvalsLoading.value ? '加载中...' : '刷新审批' }}
        </button>
      </div>
    </div>
    <div class="form-grid compact">
      <label for="plm-approvals-status">
        状态
        <select id="plm-approvals-status" v-model="panel.approvalsStatus.value" name="plmApprovalsStatus">
          <option value="all">全部</option>
          <option value="pending">待处理</option>
          <option value="approved">已通过</option>
          <option value="rejected">已拒绝</option>
        </select>
      </label>
      <label for="plm-approvals-filter">
        过滤
        <input
          id="plm-approvals-filter"
          v-model.trim="panel.approvalsFilter.value"
          name="plmApprovalsFilter"
          placeholder="标题/发起人/产品"
        />
      </label>
      <label for="plm-approvals-comment">
        审批备注
        <input
          id="plm-approvals-comment"
          v-model.trim="panel.approvalComment.value"
          name="plmApprovalsComment"
          placeholder="拒绝必填，可选用于通过"
        />
      </label>
      <label for="plm-approvals-sort">
        排序
        <select id="plm-approvals-sort" v-model="panel.approvalSortKey.value" name="plmApprovalsSort">
          <option value="created">创建时间</option>
          <option value="title">标题</option>
          <option value="status">状态</option>
          <option value="requester">发起人</option>
          <option value="product">产品</option>
        </select>
      </label>
      <label for="plm-approvals-sort-dir">
        顺序
        <select id="plm-approvals-sort-dir" v-model="panel.approvalSortDir.value" name="plmApprovalsSortDir">
          <option value="desc">降序</option>
          <option value="asc">升序</option>
        </select>
      </label>
    </div>
    <div class="toggle-grid">
      <span class="toggle-label">显示列</span>
      <label v-for="col in panel.approvalColumnOptions" :key="col.key" class="checkbox-field" :for="`plm-approval-column-${col.key}`">
        <input
          :id="`plm-approval-column-${col.key}`"
          :name="`plmApprovalColumn-${col.key}`"
          type="checkbox"
          v-model="panel.approvalColumns.value[col.key]"
        />
        <span>{{ col.label }}</span>
      </label>
    </div>
    <PlmTeamViewsBlock
      label="审批"
      select-id="plm-approvals-team-view"
      select-name="plmApprovalsTeamView"
      input-id="plm-approvals-team-view-name"
      input-name="plmApprovalsTeamViewName"
      owner-input-id="plm-approvals-team-view-owner-user-id"
      owner-input-name="plmApprovalsTeamViewOwnerUserId"
      :team-view-key="panel.approvalsTeamViewKey"
      :team-view-name="panel.approvalsTeamViewName"
      :team-view-owner-user-id="panel.approvalsTeamViewOwnerUserId"
      :team-views="panel.approvalsTeamViews"
      :loading="panel.approvalsTeamViewsLoading"
      :error="panel.approvalsTeamViewsError"
      :can-save="panel.canSaveApprovalsTeamView"
      :can-apply="panel.canApplyApprovalsTeamView"
      :show-manage-actions="panel.showManageApprovalsTeamViewActions"
      :can-duplicate="panel.canDuplicateApprovalsTeamView"
      :can-share="panel.canShareApprovalsTeamView"
      :can-delete="panel.canDeleteApprovalsTeamView"
      :can-archive="panel.canArchiveApprovalsTeamView"
      :can-restore="panel.canRestoreApprovalsTeamView"
      :can-rename="panel.canRenameApprovalsTeamView"
      :can-transfer-target="panel.canTransferApprovalsTeamViewTarget"
      :can-transfer="panel.canTransferApprovalsTeamView"
      :can-set-default="panel.canSetApprovalsTeamViewDefault"
      :can-clear-default="panel.canClearApprovalsTeamViewDefault"
      :default-label="panel.approvalsDefaultTeamViewLabel"
      :has-manageable-team-views="panel.hasManageableApprovalsTeamViews"
      :show-batch-manager="panel.showApprovalsTeamViewManager"
      :team-view-selection="panel.approvalsTeamViewSelection"
      :team-view-selection-count="panel.approvalsTeamViewSelectionCount"
      :selected-batch-archivable-team-view-ids="panel.selectedBatchArchivableApprovalsTeamViewIds"
      :selected-batch-restorable-team-view-ids="panel.selectedBatchRestorableApprovalsTeamViewIds"
      :selected-batch-deletable-team-view-ids="panel.selectedBatchDeletableApprovalsTeamViewIds"
      :refresh="panel.refreshApprovalsTeamViews"
      :apply="panel.applyApprovalsTeamView"
      :save="panel.saveApprovalsTeamView"
      :duplicate="panel.duplicateApprovalsTeamView"
      :share="panel.shareApprovalsTeamView"
      :remove="panel.deleteApprovalsTeamView"
      :archive="panel.archiveApprovalsTeamView"
      :restore="panel.restoreApprovalsTeamView"
      :rename="panel.renameApprovalsTeamView"
      :transfer="panel.transferApprovalsTeamView"
      :set-default="panel.setApprovalsTeamViewDefault"
      :clear-default="panel.clearApprovalsTeamViewDefault"
      :select-all-team-views="panel.selectAllApprovalsTeamViews"
      :clear-team-view-selection="panel.clearApprovalsTeamViewSelection"
      :archive-team-view-selection="panel.archiveApprovalsTeamViewSelection"
      :restore-team-view-selection="panel.restoreApprovalsTeamViewSelection"
      :delete-team-view-selection="panel.deleteApprovalsTeamViewSelection"
    />
    <p v-if="panel.approvalActionError.value" class="status error">{{ panel.approvalActionError.value }}</p>
    <p v-else-if="panel.approvalActionStatus.value" class="status">{{ panel.approvalActionStatus.value }}</p>
    <p v-if="panel.approvalsError.value" class="status error">{{ panel.approvalsError.value }}</p>
    <div v-if="!panel.approvals.value.length" class="empty">
      暂无审批数据
      <span class="empty-hint">（可调整状态筛选或创建 ECO 流程）</span>
    </div>
    <p v-else class="status">共 {{ panel.approvals.value.length }} 条，展示 {{ panel.approvalsSorted.value.length }} 条</p>
    <div v-if="panel.approvals.value.length && !panel.approvalsSorted.value.length" class="empty">
      暂无匹配项
      <span class="empty-hint">（可清空过滤条件）</span>
    </div>
    <table v-else class="data-table">
      <thead>
        <tr>
          <th v-if="panel.approvalColumns.value.id">审批 ID</th>
          <th>标题</th>
          <th v-if="panel.approvalColumns.value.status">状态</th>
          <th v-if="panel.approvalColumns.value.type">类型</th>
          <th v-if="panel.approvalColumns.value.requester">发起人</th>
          <th v-if="panel.approvalColumns.value.requesterId">发起人 ID</th>
          <th v-if="panel.approvalColumns.value.created">创建时间</th>
          <th v-if="panel.approvalColumns.value.product">产品</th>
          <th v-if="panel.approvalColumns.value.productId">产品 ID</th>
          <th v-if="panel.approvalColumns.value.actions">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="approval in panel.approvalsSorted.value" :key="approval.id">
          <td v-if="panel.approvalColumns.value.id" class="mono">{{ panel.getApprovalId(approval) }}</td>
          <td>{{ panel.getApprovalTitle(approval) }}</td>
          <td v-if="panel.approvalColumns.value.status">
            <span class="tag" :class="panel.approvalStatusClass(panel.getApprovalStatus(approval))">
              {{ panel.getApprovalStatus(approval) }}
            </span>
          </td>
          <td v-if="panel.approvalColumns.value.type">{{ panel.getApprovalType(approval) }}</td>
          <td v-if="panel.approvalColumns.value.requester">{{ panel.getApprovalRequester(approval) }}</td>
          <td v-if="panel.approvalColumns.value.requesterId" class="mono">{{ panel.getApprovalRequesterId(approval) }}</td>
          <td v-if="panel.approvalColumns.value.created">{{ panel.formatTime(panel.getApprovalCreatedAt(approval)) }}</td>
          <td v-if="panel.approvalColumns.value.product">
            <div>{{ panel.getApprovalProductNumber(approval) }}</div>
            <div class="muted">{{ panel.getApprovalProductName(approval) }}</div>
          </td>
          <td v-if="panel.approvalColumns.value.productId" class="mono">{{ panel.getApprovalProductId(approval) }}</td>
          <td v-if="panel.approvalColumns.value.actions">
            <div class="inline-actions">
              <button class="btn ghost mini" @click="panel.applyProductFromApproval(approval)">切换产品</button>
              <button class="btn ghost mini" @click="panel.copyApprovalId(approval)">复制 ID</button>
              <button class="btn ghost mini" @click="panel.loadApprovalHistory(approval)">记录</button>
              <button
                v-if="panel.isApprovalPending(approval)"
                class="btn ghost mini"
                :disabled="panel.approvalActingId.value === panel.getApprovalId(approval) || panel.getApprovalId(approval) === '-'"
                @click="panel.approveApproval(approval)"
              >
                通过
              </button>
              <button
                v-if="panel.isApprovalPending(approval)"
                class="btn ghost mini"
                :disabled="panel.approvalActingId.value === panel.getApprovalId(approval) || panel.getApprovalId(approval) === '-'"
                @click="panel.rejectApproval(approval)"
              >
                拒绝
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
    <div class="compare-detail" data-approval-history="true">
      <div class="compare-detail-header">
        <h3>审批记录</h3>
        <div class="compare-detail-actions">
          <span v-if="panel.approvalHistoryLabel.value" class="muted mono">{{ panel.approvalHistoryLabel.value }}</span>
          <button
            class="btn ghost mini"
            :disabled="!panel.approvalHistoryFor.value || panel.approvalHistoryLoading.value"
            @click="panel.loadApprovalHistory()"
          >
            刷新记录
          </button>
          <button class="btn ghost mini" :disabled="!panel.approvalHistoryFor.value" @click="panel.clearApprovalHistory">
            清空
          </button>
        </div>
      </div>
      <p v-if="panel.approvalHistoryError.value" class="status error">{{ panel.approvalHistoryError.value }}</p>
      <div v-if="!panel.approvalHistoryFor.value" class="empty">选择审批记录查看详情</div>
      <div v-else-if="panel.approvalHistoryLoading.value" class="status">审批记录加载中...</div>
      <div v-else-if="!panel.approvalHistoryRows.value.length" class="empty">暂无审批记录</div>
      <table v-else class="data-table compact">
        <thead>
          <tr>
            <th>状态</th>
            <th>阶段</th>
            <th>审批类型</th>
            <th>角色</th>
            <th>用户</th>
            <th>备注</th>
            <th>批准时间</th>
            <th>创建时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in panel.approvalHistoryRows.value" :key="entry.id">
            <td>
              <span class="tag" :class="panel.approvalStatusClass(panel.getApprovalHistoryStatus(entry))">
                {{ panel.getApprovalHistoryStatus(entry) }}
              </span>
            </td>
            <td class="mono">{{ panel.getApprovalHistoryStage(entry) }}</td>
            <td>{{ panel.getApprovalHistoryType(entry) }}</td>
            <td>{{ panel.getApprovalHistoryRole(entry) }}</td>
            <td class="mono">{{ panel.getApprovalHistoryUser(entry) }}</td>
            <td>{{ panel.getApprovalHistoryComment(entry) }}</td>
            <td>{{ panel.formatTime(panel.getApprovalHistoryApprovedAt(entry)) }}</td>
            <td>{{ panel.formatTime(panel.getApprovalHistoryCreatedAt(entry)) }}</td>
          </tr>
        </tbody>
      </table>
      <details v-if="panel.approvalHistoryFor.value" class="json-block">
        <summary>原始数据</summary>
        <pre>{{ panel.formatJson(panel.approvalHistory.value) }}</pre>
      </details>
    </div>
    <details class="field-map">
      <summary>字段对照清单</summary>
      <table class="data-table">
        <thead>
          <tr>
            <th>字段</th>
            <th>Key</th>
            <th>来源</th>
            <th>回退</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="field in panel.approvalFieldCatalog" :key="field.key">
            <td>{{ field.label }}</td>
            <td class="mono">{{ field.key }}</td>
            <td>{{ field.source }}</td>
            <td class="muted">{{ field.fallback }}</td>
          </tr>
        </tbody>
      </table>
    </details>
  </section>
</template>

<script setup lang="ts">
import PlmTeamViewsBlock from './PlmTeamViewsBlock.vue'
import type { PlmApprovalsPanelModel } from '../../views/plm/plmPanelModels'

defineProps<{
  panel: PlmApprovalsPanelModel
}>()
</script>

<style scoped src="./PlmPanelShared.css"></style>
