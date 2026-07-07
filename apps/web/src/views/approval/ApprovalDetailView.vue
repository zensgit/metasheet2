<template>
  <PageShell width="default">
    <PageHeader
      class="approval-detail__header"
      :title="headerTitle"
      back
      back-label="返回列表"
      @back="goBack"
    >
      <template v-if="approval" #meta>
        <StatusTag domain="approvalInstance" :status="approval.status" force-locale="zh" />
        <!-- B1-03: 已等待 aging — glanceable next to the status tag, only while still pending. -->
        <el-tag
          v-if="approval.status === 'pending'"
          :type="waitChipType"
          size="large"
          effect="plain"
          data-testid="approval-wait-chip"
        >
          已等待 {{ waitChipLabel }}
        </el-tag>
        <el-tag
          v-if="isInParallelRegion"
          type="warning"
          size="large"
          class="approval-detail__parallel-badge"
          effect="light"
        >
          并行中 · {{ parallelBranchNodeKeys.map(nodeLabel).join(' / ') }}
        </el-tag>
        <!-- B1-01: my-turn cue — the reader is an active assignee at the current node(s). -->
        <el-tag
          v-if="isMyTurn"
          type="success"
          size="large"
          effect="light"
          data-testid="approval-my-turn-badge"
        >
          等待你处理
        </el-tag>
      </template>
    </PageHeader>

    <el-alert
      v-if="store.error"
      :title="store.error"
      type="error"
      show-icon
      :closable="true"
      class="approval-detail__error"
      @close="store.error = null"
    >
      <template #default>
        <el-button type="primary" link @click="retryLoad">重新加载</el-button>
      </template>
    </el-alert>

    <div v-loading="store.loading && !!approval" class="approval-detail__content-wrapper">
      <!-- UF-8 (design-lock §3.6): first paint only — no `approval` yet AND still loading. Once
           data arrives, `v-loading` above takes over for subsequent refreshes (unchanged markup). -->
      <div v-if="!approval && store.loading" class="approval-detail__skeleton" data-testid="detail-skeleton">
        <el-skeleton :rows="3" animated />
        <el-skeleton class="approval-detail__skeleton-timeline" :rows="6" animated />
      </div>
      <div v-if="approval" class="approval-detail__body">
        <!-- Left: form snapshot -->
        <div class="approval-detail__form">
          <h2>表单信息</h2>
          <div class="approval-detail__meta">
            <div class="approval-detail__meta-item">
              <span class="approval-detail__label">审批编号</span>
              <span>{{ approval.requestNo ?? '-' }}</span>
            </div>
            <div class="approval-detail__meta-item">
              <span class="approval-detail__label">发起人</span>
              <span>{{ approval.requester?.name ?? '-' }}</span>
            </div>
            <div class="approval-detail__meta-item">
              <span class="approval-detail__label">部门</span>
              <span>{{ approval.requester?.department ?? '-' }}</span>
            </div>
            <div class="approval-detail__meta-item">
              <span class="approval-detail__label">发起时间</span>
              <span>{{ formatDate(approval.createdAt) }}</span>
            </div>
            <div class="approval-detail__meta-item">
              <span class="approval-detail__label">进度</span>
              <span>{{ approval.currentStep ?? '-' }} / {{ approval.totalSteps ?? '-' }}</span>
            </div>
          </div>

          <el-divider />

          <div v-if="approval.formSnapshot" class="approval-detail__snapshot">
            <!-- B1-02: humanized scalar fields — ordered + labeled via the frozen formSchema
                 (buildDisplayFields), so readers see field labels and option labels instead of
                 raw machine keys/values. `detail` fields are excluded here; they keep rendering
                 via the detailTables loop below, unchanged. -->
            <div
              v-for="field in displayFields"
              :key="field.key"
              class="approval-detail__field"
            >
              <span class="approval-detail__label">{{ field.label }}</span>
              <span>{{ field.value }}</span>
            </div>
            <!-- detail / sub-form (明细): render the frozen rows × columns as a read-only
                 table driven by the instance's FROZEN formSchema columns (never the live
                 template). -->
            <div
              v-for="(table, key) in detailTables"
              :key="key"
              class="approval-detail__field"
            >
              <span class="approval-detail__label">{{ key }}</span>
              <el-table
                :data="table.rows"
                border
                size="small"
                class="approval-detail__detail-table"
              >
                <el-table-column
                  v-for="column in table.columns"
                  :key="column.id"
                  :label="column.label"
                >
                  <template #default="{ row }">
                    {{ formatFieldValue(row.cells[column.id]) }}
                  </template>
                </el-table-column>
              </el-table>
            </div>
          </div>
          <el-empty v-else description="暂无表单数据" :image-size="80" />
        </div>

        <!-- Right: history timeline -->
        <div class="approval-detail__timeline">
          <h2>审批流程</h2>
          <template v-if="store.history.length">
            <!-- Parallel gateway (并行分支): cluster history entries under
                 each branch's approval-node key so reviewers can trace
                 per-branch decisions without re-reading the full timeline. -->
            <template v-if="isInParallelRegion && timelineBranchGroups.length">
              <div
                v-for="group in timelineBranchGroups"
                :key="group.key"
                class="approval-detail__timeline-group"
              >
                <div class="approval-detail__timeline-group-header">
                  <span class="approval-detail__timeline-group-label">
                    {{ group.label }}
                  </span>
                  <span class="approval-detail__timeline-group-count">
                    {{ group.items.length }} 条
                  </span>
                </div>
                <el-timeline>
                  <el-timeline-item
                    v-for="item in group.items"
                    :key="item.id"
                    :type="timelineItemType(item.action, item.toStatus)"
                    :icon="timelineIcon(item.action, item.metadata)"
                    :hollow="item.toStatus === 'pending'"
                    size="large"
                    :timestamp="item.occurredAt ? formatDate(item.occurredAt) : '-'"
                    placement="top"
                  >
                    <div class="approval-detail__timeline-content">
                      <div class="approval-detail__timeline-header">
                        <strong>{{ item.metadata?.autoApproved ? '系统自动审批' : (item.actorName ?? '系统') }}</strong>
                        <el-tag :type="timelineActionTagType(item.action, item.metadata)" size="small">
                          {{ actionLabel(item.action, item.metadata) }}
                        </el-tag>
                      </div>
                      <p v-if="item.comment" class="approval-detail__timeline-comment">
                        {{ item.comment }}
                      </p>
                      <div v-if="hasTimelineMetadata(item.metadata)" class="approval-detail__timeline-meta">
                        <span v-if="item.metadata?.autoApproved" class="approval-detail__meta-badge approval-detail__meta-badge--auto">自动审批</span>
                        <span v-if="item.metadata?.approvalMode" class="approval-detail__meta-badge">
                          审批模式: {{ approvalModeLabel(item.metadata.approvalMode as string) }}
                        </span>
                        <span v-if="item.metadata?.aggregateComplete && item.metadata?.approvalMode === 'all'" class="approval-detail__meta-badge approval-detail__meta-badge--complete">会签完成</span>
                        <span v-if="item.metadata?.aggregateComplete && item.metadata?.approvalMode === 'any'" class="approval-detail__meta-badge approval-detail__meta-badge--complete">或签完成</span>
                        <span v-if="cancelledAssigneesLabel(item.metadata)" class="approval-detail__meta-badge approval-detail__meta-badge--cancelled">
                          {{ cancelledAssigneesLabel(item.metadata) }}
                        </span>
                        <span v-if="item.action === 'sign' && item.metadata?.autoCancelled" class="approval-detail__meta-badge approval-detail__meta-badge--cancelled">
                          （已被 {{ item.metadata?.aggregateCancelledBy || '发起人' }} 的决定覆盖）
                        </span>
                        <span v-if="item.action === 'return' && item.metadata?.targetNodeKey" class="approval-detail__meta-badge approval-detail__meta-badge--return">
                          退回至: {{ nodeLabel(item.metadata.targetNodeKey as string) }}
                        </span>
                        <span v-if="item.metadata?.nodeKey" class="approval-detail__meta-badge">
                          节点: {{ nodeLabel(item.metadata.nodeKey as string) }}
                        </span>
                      </div>
                    </div>
                  </el-timeline-item>
                </el-timeline>
              </div>
            </template>
            <el-timeline v-else>
              <el-timeline-item
                v-for="item in store.history"
                :key="item.id"
                :type="timelineItemType(item.action, item.toStatus)"
                :icon="timelineIcon(item.action, item.metadata)"
                :hollow="item.toStatus === 'pending'"
                size="large"
                :timestamp="item.occurredAt ? formatDate(item.occurredAt) : '-'"
                placement="top"
              >
                <div class="approval-detail__timeline-content">
                  <div class="approval-detail__timeline-header">
                    <strong>{{ item.metadata?.autoApproved ? '系统自动审批' : (item.actorName ?? '系统') }}</strong>
                    <el-tag :type="timelineActionTagType(item.action, item.metadata)" size="small">
                      {{ actionLabel(item.action, item.metadata) }}
                    </el-tag>
                  </div>
                  <p v-if="item.comment" class="approval-detail__timeline-comment">
                    {{ item.comment }}
                  </p>
                  <div v-if="hasTimelineMetadata(item.metadata)" class="approval-detail__timeline-meta">
                    <span v-if="item.metadata?.autoApproved" class="approval-detail__meta-badge approval-detail__meta-badge--auto">自动审批</span>
                    <span v-if="item.metadata?.approvalMode" class="approval-detail__meta-badge">
                      审批模式: {{ approvalModeLabel(item.metadata.approvalMode as string) }}
                    </span>
                    <span v-if="item.metadata?.aggregateComplete && item.metadata?.approvalMode === 'all'" class="approval-detail__meta-badge approval-detail__meta-badge--complete">会签完成</span>
                    <span v-if="item.metadata?.aggregateComplete && item.metadata?.approvalMode === 'any'" class="approval-detail__meta-badge approval-detail__meta-badge--complete">或签完成</span>
                    <span v-if="cancelledAssigneesLabel(item.metadata)" class="approval-detail__meta-badge approval-detail__meta-badge--cancelled">
                      {{ cancelledAssigneesLabel(item.metadata) }}
                    </span>
                    <span v-if="item.action === 'sign' && item.metadata?.autoCancelled" class="approval-detail__meta-badge approval-detail__meta-badge--cancelled">
                      （已被 {{ item.metadata?.aggregateCancelledBy || '发起人' }} 的决定覆盖）
                    </span>
                    <span v-if="item.action === 'return' && item.metadata?.targetNodeKey" class="approval-detail__meta-badge approval-detail__meta-badge--return">
                      退回至: {{ nodeLabel(item.metadata.targetNodeKey as string) }}
                    </span>
                    <span v-if="item.metadata?.nodeKey" class="approval-detail__meta-badge">
                      节点: {{ nodeLabel(item.metadata.nodeKey as string) }}
                    </span>
                  </div>
                </div>
              </el-timeline-item>
            </el-timeline>
          </template>
          <el-empty v-else description="暂无审批历史" :image-size="80" />

          <!-- UX B2-08: current handler + upcoming nodes — synthesized (NOT real history rows),
               appended at the END of the timeline so a requester can see who it's stuck with and
               what's next, not just what already happened. Deliberately NOT built from
               `<el-timeline-item>` — its own lightweight dot+line rail instead — so it stays
               visually distinct (upcoming = greyed) and never perturbs the real history item
               count above. -->
          <div
            v-if="currentHandlerEntries.length > 0 || upcomingTimelineNodes.length > 0"
            class="approval-detail__timeline-upcoming"
            data-testid="approval-timeline-upcoming-section"
          >
            <div
              v-for="entry in currentHandlerEntries"
              :key="`current-${entry.assignmentId}`"
              class="approval-detail__timeline-upcoming-item approval-detail__timeline-upcoming-item--current"
              data-testid="approval-current-handler-item"
            >
              <span class="approval-detail__timeline-upcoming-dot" />
              <span class="approval-detail__timeline-upcoming-text">
                当前处理人：{{ entry.label }} · 已等待 {{ entry.wait }}
              </span>
            </div>
            <div
              v-for="node in upcomingTimelineNodes"
              :key="`upcoming-${node.key}`"
              class="approval-detail__timeline-upcoming-item approval-detail__timeline-upcoming-item--future"
              :class="{ 'approval-detail__timeline-upcoming-item--conditional': node.isConditional }"
              data-testid="approval-upcoming-node-item"
            >
              <span class="approval-detail__timeline-upcoming-dot" />
              <span class="approval-detail__timeline-upcoming-text">
                <strong>{{ node.name }}</strong>
                <span class="approval-detail__timeline-upcoming-summary">{{ node.assigneeSummary }}</span>
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Action bar -->
      <div v-if="approval" class="approval-detail__actions">
        <template v-if="approval.status === 'pending'">
          <div class="approval-detail__actions-primary">
            <el-button
              v-if="canAct"
              type="success"
              :loading="store.loading"
              @click="openActionDialog('approve')"
            >
              通过
            </el-button>
            <el-button
              v-if="canAct"
              type="danger"
              :loading="store.loading"
              @click="openActionDialog('reject')"
            >
              驳回
            </el-button>
          </div>
          <div class="approval-detail__actions-secondary">
            <!-- T3-1 v0 (ballot Q8): the deferred action set —
                 退回/转交/加签/减签/催办/撤回 — is desktop-only. The mobile
                 surface exposes approve/reject/comment only, so each deferred
                 control is additionally gated on `!isMobileLayout`. 评论 stays
                 visible on both surfaces. -->
            <el-button
              v-if="canAct && !isMobileLayout && returnableNodes.length > 0"
              type="warning"
              :loading="store.loading"
              @click="openReturnDialog"
            >
              退回
            </el-button>
            <el-button
              v-if="canAct && !isMobileLayout"
              type="warning"
              :loading="store.loading"
              @click="openTransferDialog"
            >
              转交
            </el-button>
            <!-- P1-B 加签: pull additional co-signer(s) into the current node. -->
            <el-button
              v-if="canAct && !isMobileLayout"
              type="primary"
              plain
              :loading="store.loading"
              data-testid="approval-add-sign-button"
              @click="openAddSignDialog"
            >
              加签
            </el-button>
            <!-- P1-B 减签: remove a previously add-signed co-signer at the
                 current node. Only shown when at least one such row exists. -->
            <el-button
              v-if="canAct && !isMobileLayout && reducibleAssignees.length > 0"
              type="primary"
              plain
              :loading="store.loading"
              data-testid="approval-reduce-sign-button"
              @click="openReduceSignDialog"
            >
              减签
            </el-button>
            <!-- Wave 2 WP3 slice 1: 催办. Visible only for the requester on
                 a pending instance; server-side rate-limits to once per hour
                 per user per instance (429 → surfaced as a friendly toast). -->
            <el-button
              v-if="isRequester && !isMobileLayout"
              type="primary"
              plain
              :loading="remindLoading"
              data-testid="approval-remind-button"
              @click="handleRemind"
            >
              <el-icon class="ms-mr-4"><Bell /></el-icon>催一下
            </el-button>
            <el-popconfirm
              v-if="isRequester && !isMobileLayout"
              title="确认撤回此审批？"
              confirm-button-text="确认"
              cancel-button-text="取消"
              @confirm="handleRevoke"
            >
              <template #reference>
                <el-button type="info" :loading="store.loading">撤回</el-button>
              </template>
            </el-popconfirm>
            <el-button plain :loading="store.loading" @click="openCommentDialog">评论</el-button>
          </div>
        </template>
        <template v-else>
          <el-alert
            title="该审批已结束"
            type="info"
            show-icon
            :closable="false"
            class="ms-flex-1"
          />
          <!-- UX B2-13: 再次提交 — own+terminal (rejected/revoked/cancelled) only; see
               `canResubmit`/`handleResubmit`. -->
          <el-button
            v-if="canResubmit"
            type="primary"
            data-testid="approval-resubmit-button"
            @click="handleResubmit"
          >
            再次提交
          </el-button>
        </template>
      </div>
    </div>

    <!-- Approve / Reject dialog -->
    <el-dialog
      v-model="actionDialogVisible"
      :title="actionDialogTitle"
      width="480px"
    >
      <!-- B1-04: dialog-scoped failure message — the server's own reason, kept in place of a
           generic toast so the reader learns WHY without losing the dialog/typed comment. -->
      <el-alert
        v-if="actionDialogError"
        type="error"
        show-icon
        :closable="false"
        :title="actionDialogError"
        data-testid="approval-action-dialog-error"
        class="approval-detail__dialog-error"
      />
      <el-form>
        <el-form-item :label="actionCommentLabel">
          <!-- B1-05: quick phrases — this user's recently-used phrases first, then the fixed
               preset list for 通过/驳回. Clicking a chip fills (or appends to) the textarea;
               free-typed text is never remembered, only a submitted phrase that exactly
               matches one of these chips (see `rememberQuickPhraseIfOffered`). -->
          <div v-if="quickPhraseChips.length > 0" class="approval-detail__quick-phrases">
            <el-tag
              v-for="(phrase, index) in quickPhraseChips"
              :key="phrase"
              class="approval-detail__quick-phrase-chip"
              effect="plain"
              :data-testid="`approval-quick-phrase-${index}`"
              @click="applyQuickPhrase(phrase)"
            >
              {{ phrase }}
            </el-tag>
          </div>
          <el-input
            v-model="actionComment"
            type="textarea"
            :rows="3"
            :placeholder="actionCommentPlaceholder"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="actionDialogVisible = false">取消</el-button>
        <el-button
          :type="currentAction === 'approve' ? 'success' : 'danger'"
          :loading="store.loading"
          :disabled="actionConfirmDisabled"
          @click="submitAction"
        >
          确认
        </el-button>
      </template>
    </el-dialog>

    <!-- Transfer dialog -->
    <el-dialog
      v-model="transferDialogVisible"
      title="转交审批"
      width="480px"
    >
      <el-form>
        <el-form-item label="转交给">
          <ApprovalUserPicker
            :model-value="transferUserId || null"
            placeholder="搜索并选择转交对象"
            @update:model-value="transferUserId = $event ?? ''"
          />
        </el-form-item>
        <el-form-item label="转交说明">
          <el-input
            v-model="actionComment"
            type="textarea"
            :rows="2"
            placeholder="请输入转交说明"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="transferDialogVisible = false">取消</el-button>
        <el-button type="warning" :loading="store.loading" @click="submitTransfer">
          确认转交
        </el-button>
      </template>
    </el-dialog>

    <!-- P1-B 加签 dialog -->
    <el-dialog
      v-model="addSignDialogVisible"
      title="加签"
      width="480px"
    >
      <el-form>
        <el-form-item label="加签人">
          <!-- P1-B 加签 target picker: ApprovalUserPicker is single-select by design (v-model one
               id), so multi-target add-sign uses a REPEATED-PICK pattern instead of a multi-select
               dropdown — pick one, it lands as a removable chip below, the picker resets for the
               next pick. `addSignUserIds` (the submit payload shape) is unchanged. -->
          <div v-if="addSignUserIds.length > 0" class="approval-detail__add-sign-chips" data-testid="approval-add-sign-chips">
            <el-tag
              v-for="uid in addSignUserIds"
              :key="uid"
              closable
              class="approval-detail__add-sign-chip"
              @close="removeAddSignUser(uid)"
            >
              {{ addSignUserLabels[uid] || uid }}
            </el-tag>
          </div>
          <ApprovalUserPicker
            :model-value="addSignPickerValue"
            placeholder="搜索并添加加签人"
            @select="onAddSignUserSelected"
          />
        </el-form-item>
        <el-form-item label="加签方式">
          <el-radio-group v-model="addSignMode" data-testid="approval-add-sign-mode">
            <el-radio value="parallel">并加签</el-radio>
            <el-radio value="before">前加签</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="加签说明">
          <el-input
            v-model="actionComment"
            type="textarea"
            :rows="2"
            placeholder="请输入加签说明"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addSignDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="store.loading"
          :disabled="addSignUserIds.length === 0"
          data-testid="approval-add-sign-submit"
          @click="submitAddSign"
        >
          确认加签
        </el-button>
      </template>
    </el-dialog>

    <!-- P1-B 减签 dialog -->
    <el-dialog
      v-model="reduceSignDialogVisible"
      title="减签"
      width="480px"
    >
      <el-form>
        <el-form-item label="减签人">
          <el-select
            v-model="reduceSignUserId"
            filterable
            placeholder="选择要移除的加签人"
            class="ms-w-100pct"
            data-testid="approval-reduce-sign-user"
          >
            <el-option
              v-for="assignee in reducibleAssignees"
              :key="assignee.assigneeId"
              :label="assignee.label"
              :value="assignee.assigneeId"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="减签说明">
          <el-input
            v-model="actionComment"
            type="textarea"
            :rows="2"
            placeholder="请输入减签说明"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="reduceSignDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="store.loading"
          :disabled="!reduceSignUserId"
          data-testid="approval-reduce-sign-submit"
          @click="submitReduceSign"
        >
          确认减签
        </el-button>
      </template>
    </el-dialog>

    <!-- Comment dialog -->
    <el-dialog
      v-model="commentDialogVisible"
      title="添加评论"
      width="480px"
    >
      <!-- B1-04: same dialog-scoped failure message as the 通过/驳回 dialog above. -->
      <el-alert
        v-if="actionDialogError"
        type="error"
        show-icon
        :closable="false"
        :title="actionDialogError"
        data-testid="approval-action-dialog-error"
        class="approval-detail__dialog-error"
      />
      <el-form>
        <el-form-item label="评论内容">
          <!-- B1-05: quick phrases — see the 通过/驳回 dialog above for the same mechanics. -->
          <div v-if="quickPhraseChips.length > 0" class="approval-detail__quick-phrases">
            <el-tag
              v-for="(phrase, index) in quickPhraseChips"
              :key="phrase"
              class="approval-detail__quick-phrase-chip"
              effect="plain"
              :data-testid="`approval-quick-phrase-${index}`"
              @click="applyQuickPhrase(phrase)"
            >
              {{ phrase }}
            </el-tag>
          </div>
          <el-input
            v-model="actionComment"
            type="textarea"
            :rows="3"
            placeholder="请输入评论内容"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="commentDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="store.loading" @click="submitComment">
          提交评论
        </el-button>
      </template>
    </el-dialog>

    <!-- Return dialog -->
    <el-dialog
      v-model="returnDialogVisible"
      title="退回审批"
      width="480px"
    >
      <el-form>
        <el-form-item label="退回至节点">
          <el-select v-model="returnTargetNodeKey" placeholder="选择退回目标节点" class="ms-w-100pct">
            <el-option
              v-for="node in returnableNodes"
              :key="node.key"
              :label="node.label"
              :value="node.key"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="退回说明">
          <el-input
            v-model="actionComment"
            type="textarea"
            :rows="2"
            placeholder="请输入退回说明"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="returnDialogVisible = false">取消</el-button>
        <el-button type="warning" :loading="store.loading" @click="submitReturn">
          确认退回
        </el-button>
      </template>
    </el-dialog>
  </PageShell>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import PageShell from '../../components/layout/PageShell.vue'
import PageHeader from '../../components/layout/PageHeader.vue'
import {
  Check,
  Close,
  Right,
  ChatDotSquare,
  Bell,
  RefreshLeft,
  CirclePlus,
  Remove,
} from '@element-plus/icons-vue'
import type { ApprovalActionType, ApprovalAssignmentDTO, ApprovalGraph } from '../../types/approval'
import { useApprovalStore } from '../../approvals/store'
import { useApprovalPermissions } from '../../approvals/permissions'
import { useApprovalTemplateStore } from '../../approvals/templateStore'
import { markApprovalRead, remindApproval, type ApprovalDirectoryUser } from '../../approvals/api'
import ApprovalUserPicker from '../../approvals/components/ApprovalUserPicker.vue'
import { useAuth } from '../../composables/useAuth'
import { useFeatureFlags } from '../../stores/featureFlags'
import { useMobileViewport } from '../../composables/useMobileViewport'
import {
  buildDetailRowsForDisplay,
  buildDisplayFields,
  findDetailFieldInSchema,
  type DetailDisplayTable,
  type DisplayField,
} from '../../approvals/detailField'
import { phrasesForAction, recentPhrases, rememberPhrase } from '../../approvals/quickPhrases'
import { formatRelativeWait, waitSeverity } from '../../approvals/relativeWait'
import { buildUpcomingNodes, type UpcomingApprovalNode } from '../../approvals/upcomingNodes'
import StatusTag from '../../components/status/StatusTag.vue'

const route = useRoute()
const router = useRouter()
const store = useApprovalStore()
const templateStore = useApprovalTemplateStore()
const { canAct } = useApprovalPermissions()

// T3-1 v0 — mobile approval surface (ballot Q8/Q11). When the tenant/user has
// opted into `approvalMobile` AND the viewport is narrow, the action bar is
// restricted to the v0 mobile action set — approve / reject / comment — and the
// deferred actions (transfer / return / add-sign / reduce-sign / revoke /
// remind) are hidden. The flag is loaded by the app shell; this view only reads
// it, so with the flag OFF the desktop action bar is unchanged for every
// viewport.
const { hasFeature } = useFeatureFlags()
const { isMobile } = useMobileViewport()
const isMobileLayout = computed(() => hasFeature('approvalMobile') && isMobile.value)

const approval = computed(() => store.activeApproval)
// PageHeader requires a non-optional title; before the detail loads (or on error) fall back to
// the same generic copy the original hand-rolled `<h1 v-if="approval">` used.
const headerTitle = computed(() => approval.value?.title ?? '审批详情')

// B1-03: 已等待 chip — a glanceable "how long has this been sitting" cue next to the status tag,
// only meaningful while the instance is still pending (once resolved, `updatedAt`/the history
// timeline already tell that story). Severity mirrors the list view's warn/urgent bands.
const waitChipLabel = computed(() => (approval.value ? formatRelativeWait(approval.value.createdAt) : ''))
const waitChipType = computed(() => {
  const severity = approval.value ? waitSeverity(approval.value.createdAt) : 'normal'
  if (severity === 'urgent') return 'danger'
  if (severity === 'warn') return 'warning'
  return 'info'
})

// Read-only detail (明细) tables, keyed by snapshot field id. Built from the instance's FROZEN
// formSchema (C-3a read-path) so a later column rename/reorder on the live template never
// mis-renders frozen rows. A key is present only when the field is a `detail` carrying
// `columns` AND its snapshot value is an array; everything else falls back to stringify.
const detailTables = computed<Record<string, DetailDisplayTable>>(() => {
  const snapshot = approval.value?.formSnapshot
  const formSchema = approval.value?.formSchema
  if (!snapshot || !formSchema) return {}
  const result: Record<string, DetailDisplayTable> = {}
  for (const [key, value] of Object.entries(snapshot)) {
    const detailField = findDetailFieldInSchema(formSchema, key)
    if (!detailField) continue
    const table = buildDetailRowsForDisplay(detailField, value)
    if (table) result[key] = table
  }
  return result
})

// B1-02: humanized scalar fields (label + formatted value, schema-ordered) — see
// `buildDisplayFields` for the full contract. `detail` fields are excluded; they render via
// `detailTables` above.
const displayFields = computed<DisplayField[]>(() =>
  buildDisplayFields(approval.value?.formSchema ?? null, approval.value?.formSnapshot ?? null),
)

// B1-01: real session identity — the previous `=== 'user_1'` mock meant production requesters
// NEVER saw the requester-only actions (撤回/催办) this view already ships. Seeded SYNCHRONOUSLY
// from the session cache so the first paint is already correct (no requester-actions pop-in);
// a cold cache falls back to the async lookup in onMounted. Until either resolves the requester
// affordances simply stay hidden (fail-closed).
const auth = useAuth()
const currentUserId = ref<string | null>(((): string | null => {
  const user = auth.getCurrentUser?.()
  const id = user && typeof user === 'object' ? (user as { id?: unknown }).id : null
  return typeof id === 'string' && id.length > 0 ? id : null
})())

const isRequester = computed(() => {
  return !!currentUserId.value && approval.value?.requester?.id === currentUserId.value
})

// UX B2-13 (再次提交) — the reject→fix→resubmit loop is a requester's biggest-friction moment
// today (hand-retype the whole form). Eligible ONLY for the CURRENT USER'S OWN instance (reuses
// `isRequester` above) in a TERMINAL state that means "this didn't go through and nothing
// downstream is acting on it any more": rejected / revoked / cancelled. `approved` is deliberately
// EXCLUDED — it already succeeded, there is nothing to fix/resubmit. An instance with no
// `templateId` (e.g. synced in from an external source system) has no fill-form to route back to,
// so it is excluded too — fail-closed rather than a dead button.
const RESUBMIT_ELIGIBLE_STATUSES = new Set(['rejected', 'revoked', 'cancelled'])
const canResubmit = computed(() => {
  const detail = approval.value
  if (!detail || !isRequester.value || !detail.templateId) return false
  return RESUBMIT_ELIGIBLE_STATUSES.has(detail.status)
})

// B1-01: "等待你处理" cue — the reader holds a still-active user assignment at the current
// node (or any branch of a parallel region). Mirrors, not replaces, the server-side action gate.
const isMyTurn = computed(() => {
  const me = currentUserId.value
  const detail = approval.value
  if (!me || !detail || detail.status !== 'pending') return false
  const currentKeys = new Set(currentActiveNodeKeys.value)
  if (currentKeys.size === 0) return false
  return detail.assignments.some(
    (a) => a.isActive && a.type === 'user' && a.assigneeId === me && !!a.nodeKey && currentKeys.has(a.nodeKey),
  )
})

// Parallel gateway (并行分支) — the instance is inside a parallel region when
// the backend surfaces `currentNodeKeys` with at least two entries. Templates
// with a single-branch fallback or any other shape leave the field absent, so
// existing linear-flow rendering is untouched.
const parallelBranchNodeKeys = computed<string[]>(() => {
  const nodeKeys = approval.value?.currentNodeKeys
  return Array.isArray(nodeKeys) ? nodeKeys : []
})
const isInParallelRegion = computed(() => parallelBranchNodeKeys.value.length >= 2)

interface TimelineGroup {
  key: string
  label: string
  items: typeof store.history
}

// Group the history timeline by the approval-node key each entry targets so a
// reviewer can scan each branch's decisions without interleaving. Entries
// that lack a `metadata.nodeKey` (e.g. the 'created' row or cc broadcasts
// from before the parallel fork) land in an "其他" group rendered last. The
// group order follows first-seen order in the timeline, so branches appear
// in the order the backend recorded them.
const timelineBranchGroups = computed<TimelineGroup[]>(() => {
  if (!isInParallelRegion.value) return []
  const buckets = new Map<string, TimelineGroup>()
  const order: string[] = []
  const OTHER_KEY = '__other'
  for (const item of store.history) {
    const nodeKey = typeof item.metadata?.nodeKey === 'string' ? item.metadata.nodeKey : null
    const bucketKey = nodeKey && parallelBranchNodeKeys.value.includes(nodeKey) ? nodeKey : OTHER_KEY
    if (!buckets.has(bucketKey)) {
      order.push(bucketKey)
      buckets.set(bucketKey, {
        key: bucketKey,
        label: bucketKey === OTHER_KEY ? '其他' : nodeLabel(bucketKey),
        items: [],
      })
    }
    buckets.get(bucketKey)!.items.push(item)
  }
  return order.map((key) => buckets.get(key)!)
})

// ---------------------------------------------------------------------------
// UX B2-08: current handler + upcoming nodes ("卡在谁那里 / 接下来到谁")
// ---------------------------------------------------------------------------
// The history timeline above only ever has PAST actions — there is no history row for the
// CURRENTLY open step — so a requester can't tell who it's stuck with or what comes next. This
// synthesizes that (NOT real history rows) and is rendered at the very end of the timeline, only
// while the instance is still `pending`.

// Every node key with an active pending assignment right now. Single source of truth for both
// `isMyTurn` (above) and `currentHandlerEntries` (below) — mirrors the same parallel-vs-linear
// resolution `isMyTurn` used inline before this slice.
const currentActiveNodeKeys = computed<string[]>(() => {
  if (!approval.value) return []
  if (parallelBranchNodeKeys.value.length > 0) return parallelBranchNodeKeys.value
  return approval.value.currentNodeKey ? [approval.value.currentNodeKey] : []
})

interface CurrentHandlerEntry {
  assignmentId: string
  label: string
  wait: string
}

// `assignment.metadata` carries no display name today — only `assigneeId` (see
// `ApprovalAssignmentDTO`). This defensively prefers a future `metadata.assigneeName` if the
// backend ever adds one, else falls back to the raw id — same "don't fetch, just display"
// convention `reducibleAssignees` already uses above.
function assignmentDisplayLabel(assignment: ApprovalAssignmentDTO): string {
  const metaName = assignment.metadata.assigneeName
  return typeof metaName === 'string' && metaName.trim() ? metaName : assignment.assigneeId
}

// One entry per ACTIVE assignment at the current node(s) — every currently-pending handler, not
// just "is it me" (that's `isMyTurn`). `wait` reuses `formatRelativeWait` (B1-03) against
// `updatedAt` rather than `createdAt`: an assignment row carries no timestamp of its own, and
// `updatedAt` — bumped whenever an action actually moves/changes the instance, but NOT by a plain
// comment (see backend `ApprovalProductService`) — approximates "since this step became current"
// far better than the header chip's `createdAt` (since the whole approval was first created).
const currentHandlerEntries = computed<CurrentHandlerEntry[]>(() => {
  const detail = approval.value
  if (!detail || detail.status !== 'pending') return []
  const keys = new Set(currentActiveNodeKeys.value)
  if (keys.size === 0) return []
  const wait = formatRelativeWait(detail.updatedAt)
  return detail.assignments
    .filter((a) => a.isActive && !!a.nodeKey && keys.has(a.nodeKey))
    .map((a) => ({ assignmentId: a.id, label: assignmentDisplayLabel(a), wait }))
})

// Prefer the instance's FROZEN template version (pinned at creation) over the LIVE template
// loaded below for `nodeLabel` — the live template may have been edited (renamed/reordered/
// removed nodes) since this instance started, which would silently mis-render the "upcoming
// nodes" preview against a graph the instance will never actually traverse. Falls back to the
// live template when no pinned version was reachable (see `onMounted`) — DRIFT RISK: that
// fallback path can render upcoming nodes that no longer match this instance's real remaining
// path.
const pinnedGraph = computed<ApprovalGraph | null>(() => {
  return templateStore.activeVersion?.approvalGraph ?? templateStore.activeTemplate?.approvalGraph ?? null
})

// Parallel regions have no single unambiguous "current node" to walk forward from until the
// branches rejoin at their `joinNodeKey` — skip rather than fabricate a merged/guessed path (the
// "并行中" badge in the header already communicates the parallel state itself).
const upcomingTimelineNodes = computed<UpcomingApprovalNode[]>(() => {
  const detail = approval.value
  if (!detail || detail.status !== 'pending') return []
  if (isInParallelRegion.value) return []
  const currentNodeKey = detail.currentNodeKey
  if (!currentNodeKey) return []
  const graph = pinnedGraph.value
  if (!graph) return []
  return buildUpcomingNodes(graph, currentNodeKey)
})

const actionDialogVisible = ref(false)
const transferDialogVisible = ref(false)
const commentDialogVisible = ref(false)
const returnDialogVisible = ref(false)
const currentAction = ref<ApprovalActionType>('approve')
const actionComment = ref('')
// B1-04: dialog-scoped failure message for the approve/reject + comment dialogs (宽恕型错误三件套
// part 2). Cleared on next dialog open / next submit attempt; the catch blocks below set it
// INSTEAD OF a generic toast so the reader sees the server's actual reason without losing their
// typed comment — the dialog stays open (see `submitAction`/`submitComment`). Non-dialog actions
// (revoke's popconfirm) are unaffected and keep their existing toast.
const actionDialogError = ref<string | null>(null)
const transferUserId = ref('')
const returnTargetNodeKey = ref('')
// P1-B 加签/减签 dialog state.
const addSignDialogVisible = ref(false)
const addSignUserIds = ref<string[]>([])
// B3-04 D-2: the repeated-pick picker's OWN transient slot (always reset to null after each pick
// so it is ready for the next one) + a display-name side map keyed by id (ApprovalUserPicker only
// carries ids in `addSignUserIds` — the submit payload shape — so the chip labels need their own
// lookup, populated from the picker's richer `select` event).
const addSignPickerValue = ref<string | null>(null)
const addSignUserLabels = ref<Record<string, string>>({})
const addSignMode = ref<'before' | 'parallel'>('parallel')
const reduceSignDialogVisible = ref(false)
const reduceSignUserId = ref('')

// P1-B 减签 picker — only previously add-signed (`metadata.addSign === true`),
// still-active, user-typed assignments at the CURRENT node are reducible.
// Requester-original / template-resolved / role rows are never listed (mirrors
// the backend `reduce_sign` `removable` predicate — INV-2).
const reducibleAssignees = computed<Array<{ assigneeId: string; label: string }>>(() => {
  if (!approval.value || approval.value.status !== 'pending') return []
  const currentNodeKey = approval.value.currentNodeKey
  if (!currentNodeKey) return []
  const seen = new Set<string>()
  const result: Array<{ assigneeId: string; label: string }> = []
  for (const assignment of approval.value.assignments) {
    if (!assignment.isActive) continue
    if (assignment.type !== 'user') continue
    if (assignment.nodeKey !== currentNodeKey) continue
    if (assignment.metadata?.addSign !== true) continue
    if (seen.has(assignment.assigneeId)) continue
    seen.add(assignment.assigneeId)
    result.push({ assigneeId: assignment.assigneeId, label: assignment.assigneeId })
  }
  return result
})

const returnableNodes = computed(() => {
  if (!approval.value || approval.value.status !== 'pending') return []
  const currentNodeKey = approval.value.currentNodeKey
  const visited = new Set<string>()
  for (const h of store.history) {
    const nk = h.metadata?.nodeKey as string | undefined
    if (nk && nk !== currentNodeKey && nk !== 'start' && nk !== 'end') {
      visited.add(nk)
    }
  }
  return Array.from(visited).map((key) => ({
    key,
    label: nodeLabel(key),
  }))
})

const actionDialogTitle = computed(() =>
  currentAction.value === 'approve' ? '审批通过' : '审批驳回',
)

// B1-04: reject-comment pre-flight. `policy.rejectCommentRequired` defaults to "required" — only
// an explicit `false` waives it, so an absent/legacy policy snapshot stays conservative. Scoped to
// the reject action only; the 通过 dialog's "审批意见" stays optional (mirrors the add-sign
// disabled-until-complete pattern already used by `submitAddSign`/`submitReduceSign` below).
const rejectCommentRequired = computed(() =>
  currentAction.value === 'reject' && approval.value?.policy?.rejectCommentRequired !== false,
)
const actionCommentLabel = computed(() => (rejectCommentRequired.value ? '驳回原因（必填）' : '审批意见'))
const actionCommentPlaceholder = computed(() => (rejectCommentRequired.value ? '请填写驳回原因' : '请输入审批意见'))
const actionConfirmDisabled = computed(() => rejectCommentRequired.value && !actionComment.value.trim())

// B1-05: quick-phrase chips for whichever action's dialog is currently open — this user's own
// recently-used phrases (most-recent-first) first, then the fixed preset list, deduped, capped
// at 5. `currentAction` is kept in sync with the open dialog by `openActionDialog`/
// `openCommentDialog` below.
const quickPhraseChips = computed<string[]>(() => {
  const merged = [...recentPhrases(currentUserId.value, currentAction.value), ...phrasesForAction(currentAction.value)]
  return Array.from(new Set(merged)).slice(0, 5)
})

function applyQuickPhrase(phrase: string): void {
  actionComment.value = actionComment.value ? `${actionComment.value}，${phrase}` : phrase
}

/**
 * Only remembers a submitted comment as a quick-phrase shortcut when it exactly matches one of
 * the phrases OFFERED for the currently open dialog's action (recent ∪ preset, i.e.
 * `quickPhraseChips` at submit time) — free-typed comments are never persisted, so this can't
 * become a backdoor free-text log.
 */
function rememberQuickPhraseIfOffered(comment: string): void {
  if (!quickPhraseChips.value.includes(comment)) return
  rememberPhrase(currentUserId.value, currentAction.value, comment)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// UF-3: the header status tag now renders via <StatusTag domain="approvalInstance"> (see
// utils/statusDomains.ts). `statusTagType` stays — it's still used below by
// `timelineActionTagType` to color the timeline's per-entry ACTION tag (approve/reject/pending
// are borrowed here as an action-outcome palette, not a rendered instance status — the timeline's
// own event-kind badges like 自动审批/会签完成/退回 are a separate, out-of-scope concept; see
// `.approval-detail__meta-badge*`).
function statusTagType(status: string) {
  const map: Record<string, string> = {
    pending: 'warning',
    approved: 'success',
    rejected: 'danger',
    revoked: 'info',
    cancelled: 'info',
  }
  return map[status] ?? ''
}

function actionLabel(action: string, metadata?: Record<string, unknown>) {
  if (action === 'approve' && metadata?.autoApproved) return '自动通过'
  if (action === 'sign' && metadata?.autoCancelled) return '自动失效'
  const map: Record<string, string> = {
    created: '发起',
    approve: '通过',
    reject: '驳回',
    transfer: '转交',
    revoke: '撤回',
    comment: '评论',
    return: '退回',
    sign: '签字',
    add_sign: '加签',
    reduce_sign: '减签',
  }
  return map[action] ?? action
}

function timelineItemType(action: string, toStatus: string): string {
  if (action === 'return') return 'warning'
  if (action === 'approve') return 'success'
  if (action === 'reject') return 'danger'
  if (action === 'transfer') return 'warning'
  if (action === 'revoke') return 'warning'
  if (toStatus === 'pending') return 'primary'
  return 'info'
}

function timelineActionTagType(action: string, metadata?: Record<string, unknown>): string {
  if (action === 'approve' && metadata?.autoApproved) return 'info'
  if (action === 'return') return 'warning'
  return statusTagType(action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'pending')
}

function timelineIcon(action: string, metadata?: Record<string, unknown>) {
  if (action === 'return') return RefreshLeft
  if (action === 'approve' && metadata?.autoApproved) return Bell
  const map: Record<string, any> = {
    approve: Check,
    reject: Close,
    transfer: Right,
    comment: ChatDotSquare,
    cc: Bell,
    revoke: RefreshLeft,
    add_sign: CirclePlus,
    reduce_sign: Remove,
  }
  return map[action] ?? undefined
}

function hasTimelineMetadata(metadata?: Record<string, unknown>): boolean {
  if (!metadata) return false
  return !!(
    metadata.autoApproved
    || metadata.approvalMode
    || metadata.aggregateComplete
    || metadata.aggregateCancelled
    || metadata.autoCancelled
    || metadata.aggregateCancelledBy
    || metadata.nodeKey
    || metadata.targetNodeKey
  )
}

function approvalModeLabel(mode: string): string {
  const map: Record<string, string> = { single: '单人', all: '会签', any: '或签' }
  return map[mode] ?? mode
}

/**
 * Builds a muted note listing sibling approvers whose active assignments were cancelled by
 * an any-mode (或签) first-wins resolution. Returns empty string when metadata carries no
 * aggregateCancelled list or when the list is empty — callers `v-if` on the truthy string.
 */
function cancelledAssigneesLabel(metadata?: Record<string, unknown>): string {
  if (!metadata) return ''
  const cancelled = metadata.aggregateCancelled
  if (!Array.isArray(cancelled) || cancelled.length === 0) return ''
  return `其他审批人已失效: ${cancelled.map((id) => String(id)).join(', ')}`
}

function nodeLabel(nodeKey: string): string {
  if (!nodeKey) return '-'
  const node = templateStore.activeTemplate?.approvalGraph.nodes.find((entry) => entry.key === nodeKey)
  return node?.name?.trim() || nodeKey
}

function formatDate(dateStr: string) {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleString('zh-CN')
}

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return '-'
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
function goBack() {
  router.push({ name: 'approval-list' })
}

function retryLoad() {
  const id = route.params.id as string
  store.error = null
  Promise.all([store.loadDetail(id), store.loadHistory(id)])
}

// UX B2-13 (再次提交) — route to the SAME template's fill page, carrying this instance's id as
// `fromInstance` so `ApprovalNewView` can load it and prefill the fresh draft (see
// `prefillFromSnapshot`). Does NOT submit anything itself — the requester still reviews + submits
// the new draft normally (B2-15 validation, B2-07 preview, etc. all still apply).
function handleResubmit(): void {
  const detail = approval.value
  if (!detail?.templateId) return
  router.push({
    name: 'approval-create',
    params: { templateId: detail.templateId },
    query: { fromInstance: detail.id },
  })
}

function openActionDialog(action: 'approve' | 'reject') {
  currentAction.value = action
  actionComment.value = ''
  actionDialogError.value = null
  actionDialogVisible.value = true
}

function openTransferDialog() {
  transferUserId.value = ''
  actionComment.value = ''
  transferDialogVisible.value = true
}

function openReturnDialog() {
  returnTargetNodeKey.value = ''
  actionComment.value = ''
  returnDialogVisible.value = true
}

function openCommentDialog() {
  // B1-05: keeps `currentAction` in sync with the open dialog so `quickPhraseChips` offers the
  // 'comment' preset/recent list here (rather than whatever approve/reject dialog ran last).
  currentAction.value = 'comment'
  actionComment.value = ''
  actionDialogError.value = null
  commentDialogVisible.value = true
}

// T3-1 v0 (ballot Q7): the mobile surface reuses the SAME version-less unified
// `/api/approvals/:id/actions` endpoint as desktop (via `store.executeAction`).
// Its only concurrency guard is refresh-on-4xx: when the action is rejected with
// a 4xx (the instance advanced under the approver — a stale action), re-pull the
// detail + history so the mobile action bar reflects live state instead of a
// stale one. Scoped to the mobile layout so desktop behavior is unchanged.
function is4xxConflict(error: unknown): boolean {
  // B1-04: `dispatchAction`'s real failures now carry a typed `.status` (see
  // `ApprovalApiError`/`approvalRequestError` in approvals/api.ts) whose `.message` is the
  // server's own text — it no longer matches the legacy "API error: NNN" shape below. Check
  // `.status` first; keep the regex as a fallback for anything still throwing the old generic
  // format (e.g. a mocked/legacy rejection).
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status
    if (typeof status === 'number') return status >= 400 && status < 500
  }
  const message = error instanceof Error ? error.message : String(error ?? '')
  const match = /API error:\s*(\d{3})/.exec(message)
  if (!match) return false
  const status = Number(match[1])
  return status >= 400 && status < 500
}

// B1-04: prefer the typed/thrown error's own message (server text, or the helper's
// status-coded fallback); anything else (a non-Error throw) falls back to the caller-supplied
// generic copy so the dialog never renders a blank alert.
function dialogErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

async function refreshAfterStaleMobileAction(id: string, error: unknown): Promise<void> {
  if (!isMobileLayout.value) return
  if (!is4xxConflict(error)) return
  await Promise.all([store.loadDetail(id), store.loadHistory(id)]).catch(() => undefined)
}

async function submitAction() {
  if (actionConfirmDisabled.value) return
  const id = route.params.id as string
  actionDialogError.value = null
  try {
    await store.executeAction(id, {
      action: currentAction.value,
      comment: actionComment.value || undefined,
    })
    ElMessage.success(currentAction.value === 'approve' ? '审批已通过' : '审批已驳回')
    rememberQuickPhraseIfOffered(actionComment.value)
    actionDialogVisible.value = false
    await store.loadHistory(id)
  } catch (error) {
    // B1-04: keep the dialog open + show the server's own reason inline instead of a generic
    // toast (see `actionDialogError` above); non-dialog actions further down keep their toasts.
    actionDialogError.value = dialogErrorMessage(error, '操作失败，请重试')
    await refreshAfterStaleMobileAction(id, error)
  }
}

async function submitTransfer() {
  if (!transferUserId.value) return
  const id = route.params.id as string
  try {
    await store.executeAction(id, {
      action: 'transfer',
      comment: actionComment.value || undefined,
      targetUserId: transferUserId.value,
    })
    ElMessage.success('已成功转交')
    transferDialogVisible.value = false
    await store.loadHistory(id)
  } catch {
    ElMessage.error('转交失败，请重试')
  }
}

function openAddSignDialog() {
  addSignUserIds.value = []
  addSignUserLabels.value = {}
  addSignPickerValue.value = null
  addSignMode.value = 'parallel'
  actionComment.value = ''
  addSignDialogVisible.value = true
}

// B3-04 D-2: repeated-pick handler for the add-sign target picker — append the picked id (no
// duplicates), remember its display label for the chip, then reset the picker's transient slot
// so it is ready for the next pick.
function onAddSignUserSelected(option: ApprovalDirectoryUser | null): void {
  if (!option) return
  if (!addSignUserIds.value.includes(option.id)) {
    addSignUserIds.value = [...addSignUserIds.value, option.id]
    addSignUserLabels.value = { ...addSignUserLabels.value, [option.id]: option.name || option.id }
  }
  addSignPickerValue.value = null
}

function removeAddSignUser(id: string): void {
  addSignUserIds.value = addSignUserIds.value.filter((existing) => existing !== id)
}

async function submitAddSign() {
  if (addSignUserIds.value.length === 0) return
  const id = route.params.id as string
  try {
    await store.executeAction(id, {
      action: 'add_sign',
      comment: actionComment.value || undefined,
      targetUserIds: addSignUserIds.value,
      addSignMode: addSignMode.value,
    })
    ElMessage.success('已成功加签')
    addSignDialogVisible.value = false
    await store.loadHistory(id)
  } catch {
    ElMessage.error('加签失败，请重试')
  }
}

function openReduceSignDialog() {
  reduceSignUserId.value = ''
  actionComment.value = ''
  reduceSignDialogVisible.value = true
}

async function submitReduceSign() {
  if (!reduceSignUserId.value) return
  const id = route.params.id as string
  try {
    await store.executeAction(id, {
      action: 'reduce_sign',
      comment: actionComment.value || undefined,
      targetAssignmentUserId: reduceSignUserId.value,
    })
    ElMessage.success('已成功减签')
    reduceSignDialogVisible.value = false
    await store.loadHistory(id)
  } catch {
    ElMessage.error('减签失败，请重试')
  }
}

async function submitComment() {
  if (!actionComment.value.trim()) return
  const id = route.params.id as string
  actionDialogError.value = null
  try {
    await store.executeAction(id, {
      action: 'comment',
      comment: actionComment.value,
    })
    ElMessage.success('评论已提交')
    rememberQuickPhraseIfOffered(actionComment.value)
    commentDialogVisible.value = false
    await store.loadHistory(id)
  } catch (error) {
    // B1-04: same dialog-scoped inline error as `submitAction` above.
    actionDialogError.value = dialogErrorMessage(error, '评论提交失败，请重试')
    await refreshAfterStaleMobileAction(id, error)
  }
}

async function submitReturn() {
  if (!returnTargetNodeKey.value) return
  const id = route.params.id as string
  try {
    await store.executeAction(id, {
      action: 'return',
      comment: actionComment.value || undefined,
      targetNodeKey: returnTargetNodeKey.value,
    })
    ElMessage.success('已退回审批')
    returnDialogVisible.value = false
    await store.loadHistory(id)
  } catch {
    ElMessage.error('退回失败，请重试')
  }
}

async function handleRevoke() {
  const id = route.params.id as string
  try {
    await store.executeAction(id, { action: 'revoke' })
    ElMessage.success('审批已撤回')
    await store.loadHistory(id)
  } catch {
    ElMessage.error('撤回失败，请重试')
  }
}

// Wave 2 WP3 slice 1: 催办. Loading state is local to this button so the main
// approve/reject action row does not go into a spinner while a requester
// nudges. On 429 we surface the server-supplied `lastRemindedAt` so the user
// knows why the button rejected them.
const remindLoading = ref(false)

function formatRemindAgo(lastRemindedAt?: string): string {
  if (!lastRemindedAt) return '刚刚'
  const timestamp = new Date(lastRemindedAt).getTime()
  if (!Number.isFinite(timestamp)) return '刚刚'
  const diffMs = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(diffMs / 60000)
  if (minutes <= 0) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时前`
}

async function handleRemind() {
  const id = route.params.id as string
  if (remindLoading.value) return
  remindLoading.value = true
  try {
    const result = await remindApproval(id)
    if (result.ok) {
      ElMessage.success('已催办')
      await store.loadHistory(id)
    } else if (result.status === 429) {
      ElMessage.warning(`已在 ${formatRemindAgo(result.error.lastRemindedAt)}催办过`)
    } else {
      ElMessage.error(result.error.message || '催办失败，请重试')
    }
  } finally {
    remindLoading.value = false
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
onMounted(async () => {
  const id = route.params.id as string
  // Wave 2 WP3 slice 2 — fire-and-forget mark-read. Runs in parallel with the
  // detail load so the unread badge drops immediately while the detail view
  // keeps rendering regardless of mark-read's outcome. Errors are logged but
  // never surfaced via toast: this is silent presence data, not an action.
  void markApprovalRead(id).catch((error) => {
    // eslint-disable-next-line no-console
    console.warn('[approval-detail] mark-read failed', error)
  })
  // B1-01: cold-cache fallback for the session identity — fire-and-forget in parallel with
  // the detail load; a failed session lookup just leaves requester-only actions hidden.
  if (!currentUserId.value) {
    void auth
      .getCurrentUserId()
      .then((uid) => {
        currentUserId.value = uid
      })
      .catch(() => {})
  }
  await Promise.all([store.loadDetail(id), store.loadHistory(id)])
  const detail = store.activeApproval
  if (detail?.templateId) {
    const templateFetches: Array<Promise<unknown>> = [
      templateStore.loadTemplate(detail.templateId).catch(() => undefined),
    ]
    // B2-08: ALSO fetch the instance's pinned template version (if the DTO exposes one) so
    // `pinnedGraph`/the current+upcoming synthesis can walk the FROZEN graph. Kept as an
    // ADDITIONAL fetch (not a replacement) so `nodeLabel`'s existing history lookups keep using
    // the live template exactly as before.
    if (detail.templateVersionId) {
      templateFetches.push(templateStore.loadVersion(detail.templateId, detail.templateVersionId).catch(() => undefined))
    }
    await Promise.all(templateFetches)
  }
})
</script>

<style scoped>
.approval-detail__error {
  margin-bottom: 16px;
}

/* B1-04: dialog-scoped failure alert (approve/reject + comment dialogs). */
.approval-detail__dialog-error {
  margin-bottom: 16px;
}

.approval-detail__content-wrapper {
  min-height: 200px;
}

/* UF-8: first-paint skeleton (form snapshot + timeline), see the wrapper's v-if/v-loading split. */
.approval-detail__skeleton {
  padding: var(--ms-space-4) 0;
}

.approval-detail__skeleton-timeline {
  margin-top: var(--ms-space-4);
}

.approval-detail__body {
  display: grid;
  grid-template-columns: 1fr 400px;
  gap: 24px;
}

.approval-detail__form,
.approval-detail__timeline {
  background: var(--ms-bg-card);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 20px;
}

.approval-detail__form h2,
.approval-detail__timeline h2 {
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 16px;
}

.approval-detail__meta {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.approval-detail__meta-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.approval-detail__label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.approval-detail__snapshot {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.approval-detail__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.approval-detail__detail-table {
  margin-top: 4px;
}

.approval-detail__quick-phrases {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.approval-detail__quick-phrase-chip {
  cursor: pointer;
}

.approval-detail__add-sign-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.approval-detail__timeline-content {
  padding: 0;
}

.approval-detail__timeline-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.approval-detail__timeline-comment {
  margin: 4px 0 0;
  color: var(--el-text-color-regular);
  font-size: 13px;
}

.approval-detail__timeline-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.approval-detail__meta-badge {
  display: inline-block;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
}

.approval-detail__meta-badge--auto {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.approval-detail__meta-badge--complete {
  background: var(--el-color-success-light-9);
  color: var(--el-color-success);
}

.approval-detail__meta-badge--return {
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning);
}

.approval-detail__parallel-badge {
  margin-left: 8px;
  font-weight: 500;
  letter-spacing: 0.05em;
}

.approval-detail__timeline-group {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  padding: 12px 16px;
  margin-bottom: 12px;
  background: var(--el-fill-color-blank);
}

.approval-detail__timeline-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px dashed var(--el-border-color-lighter);
}

.approval-detail__timeline-group-label {
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.approval-detail__timeline-group-count {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* UX B2-08: synthesized "current handler + upcoming nodes" rail, appended after the real
   history entries. A lightweight dot+line rail of its own (not `<el-timeline-item>`) so the
   upcoming (future/uncertain) entries can render visibly greyed without touching the styling
   of real history rows above. */
.approval-detail__timeline-upcoming {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px dashed var(--el-border-color-lighter);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.approval-detail__timeline-upcoming-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  line-height: 1.5;
}

.approval-detail__timeline-upcoming-dot {
  flex: none;
  width: 8px;
  height: 8px;
  margin-top: 4px;
  border-radius: 50%;
  background: var(--el-color-primary);
}

.approval-detail__timeline-upcoming-item--future .approval-detail__timeline-upcoming-dot {
  background: var(--el-text-color-placeholder);
}

.approval-detail__timeline-upcoming-item--current .approval-detail__timeline-upcoming-text {
  color: var(--el-text-color-primary);
  font-weight: 500;
}

.approval-detail__timeline-upcoming-item--future .approval-detail__timeline-upcoming-text {
  color: var(--el-text-color-placeholder);
}

.approval-detail__timeline-upcoming-summary {
  margin-left: 6px;
}

/* B1-05: sticky at the viewport bottom so approve/reject/... stay reachable while the form
   snapshot / timeline scroll underneath, instead of requiring a scroll-to-bottom first. The
   safe-area padding keeps the buttons clear of the home-indicator area on notched devices. */
.approval-detail__actions {
  margin-top: 24px;
  padding: 16px 20px;
  padding-bottom: calc(8px + env(safe-area-inset-bottom));
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  position: sticky;
  bottom: 0;
  z-index: 1;
}

.approval-detail__actions-primary {
  display: flex;
  gap: 12px;
}

.approval-detail__actions-secondary {
  display: flex;
  gap: 12px;
}

/* Responsive: stack on small screens.
   T3-1 v0: on the mobile approval surface the action set is restricted to
   approve/reject/comment (deferred actions hidden), so the remaining controls
   are laid out as full-width, comfortably tappable rows. */
@media (max-width: 768px) {
  .approval-detail__body {
    grid-template-columns: 1fr;
  }

  .approval-detail__meta {
    grid-template-columns: 1fr;
  }

  .approval-detail__actions {
    flex-direction: column;
    align-items: stretch;
  }

  /* B1-05: the primary 通过/驳回 pair stays a two-up row (not a full column stack) so both
     land in comfortable thumb reach; flex: 1 + min-height 44px keeps them evenly-sized,
     tappable targets. The deferred secondary set keeps the existing full-width column stack —
     its visibility/action set is unchanged (T3-1 v0 mobile gating still applies above). */
  .approval-detail__actions-primary {
    flex-direction: row;
  }

  .approval-detail__actions-secondary {
    flex-direction: column;
    align-items: stretch;
    justify-content: center;
  }

  .approval-detail__actions-primary :deep(.el-button) {
    flex: 1;
    min-height: 44px;
    margin-left: 0;
  }

  .approval-detail__actions-secondary :deep(.el-button) {
    width: 100%;
    margin-left: 0;
  }
}
</style>
