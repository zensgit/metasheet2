<template>
  <section class="approval-detail">
    <header class="approval-detail__header">
      <el-button text @click="goBack">
        <el-icon><ArrowLeft /></el-icon>
        返回列表
      </el-button>
      <h1 v-if="approval">{{ approval.title ?? '审批详情' }}</h1>
      <el-tag
        v-if="approval"
        :type="statusTagType(approval.status)"
        size="large"
      >
        {{ statusLabel(approval.status) }}
      </el-tag>
      <el-tag
        v-if="approval && isInParallelRegion"
        type="warning"
        size="large"
        class="approval-detail__parallel-badge"
        effect="light"
      >
        并行中 · {{ parallelBranchNodeKeys.map(nodeLabel).join(' / ') }}
      </el-tag>
    </header>

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

    <div v-loading="store.loading" class="approval-detail__content-wrapper">
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
            <div
              v-for="(value, key) in approval.formSnapshot"
              :key="key"
              class="approval-detail__field"
            >
              <span class="approval-detail__label">{{ String(key) }}</span>
              <span>{{ formatFieldValue(value) }}</span>
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
                          节点: {{ item.metadata.nodeKey }}
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
                      节点: {{ item.metadata.nodeKey }}
                    </span>
                  </div>
                </div>
              </el-timeline-item>
            </el-timeline>
          </template>
          <el-empty v-else description="暂无审批历史" :image-size="80" />
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
            <el-button
              v-if="canAct && returnableNodes.length > 0"
              type="warning"
              :loading="store.loading"
              @click="openReturnDialog"
            >
              退回
            </el-button>
            <el-button
              v-if="canAct"
              type="warning"
              :loading="store.loading"
              @click="openTransferDialog"
            >
              转交
            </el-button>
            <!-- Wave 2 WP3 slice 1: 催办. Visible only for the requester on
                 a pending instance; server-side rate-limits to once per hour
                 per user per instance (429 → surfaced as a friendly toast). -->
            <el-button
              v-if="isRequester"
              type="primary"
              plain
              :loading="remindLoading"
              data-testid="approval-remind-button"
              @click="handleRemind"
            >
              <el-icon style="margin-right: 4px"><Bell /></el-icon>催一下
            </el-button>
            <el-popconfirm
              v-if="isRequester"
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
        <el-alert
          v-else
          title="该审批已结束"
          type="info"
          show-icon
          :closable="false"
          style="flex: 1"
        />
      </div>
    </div>

    <!-- Approve / Reject dialog -->
    <el-dialog
      v-model="actionDialogVisible"
      :title="actionDialogTitle"
      width="480px"
    >
      <el-form>
        <el-form-item label="审批意见">
          <el-input
            v-model="actionComment"
            type="textarea"
            :rows="3"
            placeholder="请输入审批意见"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="actionDialogVisible = false">取消</el-button>
        <el-button
          :type="currentAction === 'approve' ? 'success' : 'danger'"
          :loading="store.loading"
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
          <el-select v-model="transferUserId" placeholder="选择用户" filterable style="width: 100%">
            <template #prefix>
              <el-icon><Search /></el-icon>
            </template>
            <el-option label="李四 (部门经理)" value="user_2" />
            <el-option label="王五 (总监)" value="user_3" />
            <el-option label="赵六 (VP)" value="user_4" />
          </el-select>
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

    <!-- Comment dialog -->
    <el-dialog
      v-model="commentDialogVisible"
      title="添加评论"
      width="480px"
    >
      <el-form>
        <el-form-item label="评论内容">
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
          <el-select v-model="returnTargetNodeKey" placeholder="选择退回目标节点" style="width: 100%">
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
  </section>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  ArrowLeft,
  Search,
  Check,
  Close,
  Right,
  ChatDotSquare,
  Bell,
  RefreshLeft,
} from '@element-plus/icons-vue'
import type { ApprovalActionType } from '../../types/approval'
import { useApprovalStore } from '../../approvals/store'
import { useApprovalPermissions } from '../../approvals/permissions'
import { useApprovalTemplateStore } from '../../approvals/templateStore'
import { remindApproval } from '../../approvals/api'

const route = useRoute()
const router = useRouter()
const store = useApprovalStore()
const templateStore = useApprovalTemplateStore()
const { canAct } = useApprovalPermissions()

const approval = computed(() => store.activeApproval)
const isRequester = computed(() => {
  // Simple heuristic: mock current user as 'user_1'
  return approval.value?.requester?.id === 'user_1'
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

const actionDialogVisible = ref(false)
const transferDialogVisible = ref(false)
const commentDialogVisible = ref(false)
const returnDialogVisible = ref(false)
const currentAction = ref<ApprovalActionType>('approve')
const actionComment = ref('')
const transferUserId = ref('')
const returnTargetNodeKey = ref('')

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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

function statusLabel(status: string) {
  const map: Record<string, string> = {
    pending: '待处理',
    approved: '已通过',
    rejected: '已驳回',
    revoked: '已撤回',
    cancelled: '已取消',
  }
  return map[status] ?? status
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

function openActionDialog(action: 'approve' | 'reject') {
  currentAction.value = action
  actionComment.value = ''
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
  actionComment.value = ''
  commentDialogVisible.value = true
}

async function submitAction() {
  const id = route.params.id as string
  try {
    await store.executeAction(id, {
      action: currentAction.value,
      comment: actionComment.value || undefined,
    })
    ElMessage.success(currentAction.value === 'approve' ? '审批已通过' : '审批已驳回')
    actionDialogVisible.value = false
    await store.loadHistory(id)
  } catch {
    ElMessage.error('操作失败，请重试')
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

async function submitComment() {
  if (!actionComment.value.trim()) return
  const id = route.params.id as string
  try {
    await store.executeAction(id, {
      action: 'comment',
      comment: actionComment.value,
    })
    ElMessage.success('评论已提交')
    commentDialogVisible.value = false
    await store.loadHistory(id)
  } catch {
    ElMessage.error('评论提交失败，请重试')
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
  await Promise.all([store.loadDetail(id), store.loadHistory(id)])
  if (store.activeApproval?.templateId) {
    await templateStore.loadTemplate(store.activeApproval.templateId).catch(() => undefined)
  }
})
</script>

<style scoped>
.approval-detail {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px;
}

.approval-detail__header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
}

.approval-detail__header h1 {
  font-size: 20px;
  font-weight: 600;
  margin: 0;
  flex: 1;
}

.approval-detail__error {
  margin-bottom: 16px;
}

.approval-detail__content-wrapper {
  min-height: 200px;
}

.approval-detail__body {
  display: grid;
  grid-template-columns: 1fr 400px;
  gap: 24px;
}

.approval-detail__form,
.approval-detail__timeline {
  background: #fff;
  border: 1px solid var(--el-border-color-lighter, #e4e7ed);
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
  color: var(--el-text-color-secondary, #909399);
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
  color: var(--el-text-color-regular, #606266);
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
  background: var(--el-fill-color-light, #f5f7fa);
  color: var(--el-text-color-secondary, #909399);
}

.approval-detail__meta-badge--auto {
  background: #e6f7ff;
  color: #1890ff;
}

.approval-detail__meta-badge--complete {
  background: #f6ffed;
  color: #52c41a;
}

.approval-detail__meta-badge--return {
  background: #fff7e6;
  color: #fa8c16;
}

.approval-detail__parallel-badge {
  margin-left: 8px;
  font-weight: 500;
  letter-spacing: 0.05em;
}

.approval-detail__timeline-group {
  border: 1px solid var(--el-border-color-lighter, #e4e7ed);
  border-radius: 6px;
  padding: 12px 16px;
  margin-bottom: 12px;
  background: var(--el-fill-color-blank, #fff);
}

.approval-detail__timeline-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px dashed var(--el-border-color-lighter, #ebedf0);
}

.approval-detail__timeline-group-label {
  font-weight: 600;
  color: var(--el-text-color-primary, #303133);
}

.approval-detail__timeline-group-count {
  font-size: 12px;
  color: var(--el-text-color-secondary, #606266);
}

.approval-detail__actions {
  margin-top: 24px;
  padding: 16px 20px;
  background: #fff;
  border: 1px solid var(--el-border-color-lighter, #e4e7ed);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.approval-detail__actions-primary {
  display: flex;
  gap: 12px;
}

.approval-detail__actions-secondary {
  display: flex;
  gap: 12px;
}

/* Responsive: stack on small screens */
@media (max-width: 768px) {
  .approval-detail__body {
    grid-template-columns: 1fr;
  }

  .approval-detail__actions {
    flex-direction: column;
    align-items: stretch;
  }

  .approval-detail__actions-primary,
  .approval-detail__actions-secondary {
    justify-content: center;
  }
}
</style>
