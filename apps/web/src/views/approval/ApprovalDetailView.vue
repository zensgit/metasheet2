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
          <el-timeline v-if="store.history.length">
            <el-timeline-item
              v-for="item in store.history"
              :key="item.id"
              :type="timelineItemType(item.action, item.toStatus)"
              :icon="timelineIcon(item.action)"
              :hollow="item.toStatus === 'pending'"
              size="large"
              :timestamp="item.occurredAt ? formatDate(item.occurredAt) : '-'"
              placement="top"
            >
              <div class="approval-detail__timeline-content">
                <div class="approval-detail__timeline-header">
                  <strong>{{ item.actorName ?? '系统' }}</strong>
                  <el-tag :type="statusTagType(item.toStatus)" size="small">
                    {{ actionLabel(item.action) }}
                  </el-tag>
                </div>
                <p v-if="item.comment" class="approval-detail__timeline-comment">
                  {{ item.comment }}
                </p>
              </div>
            </el-timeline-item>
          </el-timeline>
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
              v-if="canAct"
              type="warning"
              :loading="store.loading"
              @click="openTransferDialog"
            >
              转交
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

const route = useRoute()
const router = useRouter()
const store = useApprovalStore()
const { canAct } = useApprovalPermissions()

const approval = computed(() => store.activeApproval)
const isRequester = computed(() => {
  // Simple heuristic: mock current user as 'user_1'
  return approval.value?.requester?.id === 'user_1'
})

const actionDialogVisible = ref(false)
const transferDialogVisible = ref(false)
const commentDialogVisible = ref(false)
const currentAction = ref<ApprovalActionType>('approve')
const actionComment = ref('')
const transferUserId = ref('')

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

function actionLabel(action: string) {
  const map: Record<string, string> = {
    created: '发起',
    approve: '通过',
    reject: '驳回',
    transfer: '转交',
    revoke: '撤回',
    comment: '评论',
  }
  return map[action] ?? action
}

function timelineItemType(action: string, toStatus: string): string {
  if (action === 'approve') return 'success'
  if (action === 'reject') return 'danger'
  if (action === 'transfer') return 'warning'
  if (action === 'revoke') return 'warning'
  if (toStatus === 'pending') return 'primary'
  return 'info'
}

function timelineIcon(action: string) {
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

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
onMounted(async () => {
  const id = route.params.id as string
  await Promise.all([store.loadDetail(id), store.loadHistory(id)])
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
