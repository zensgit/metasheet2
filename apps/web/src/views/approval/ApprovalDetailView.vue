<template>
  <section class="approval-detail" v-loading="store.loading">
    <header class="approval-detail__header">
      <el-button text @click="goBack">← 返回列表</el-button>
      <h1 v-if="approval">{{ approval.title ?? '审批详情' }}</h1>
      <el-tag
        v-if="approval"
        :type="statusTagType(approval.status)"
        size="large"
      >
        {{ statusLabel(approval.status) }}
      </el-tag>
    </header>

    <div v-if="store.error" class="approval-detail__error">
      <el-alert :title="store.error" type="error" show-icon :closable="false" />
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
        <div v-if="store.history.length" class="approval-detail__history">
          <div
            v-for="item in store.history"
            :key="item.id"
            class="approval-detail__history-item"
          >
            <div class="approval-detail__history-dot" :class="`dot--${item.toStatus}`" />
            <div class="approval-detail__history-content">
              <div class="approval-detail__history-header">
                <strong>{{ item.actorName ?? '系统' }}</strong>
                <el-tag :type="statusTagType(item.toStatus)" size="small">
                  {{ actionLabel(item.action) }}
                </el-tag>
              </div>
              <p v-if="item.comment" class="approval-detail__history-comment">
                {{ item.comment }}
              </p>
              <time class="approval-detail__history-time">
                {{ item.occurredAt ? formatDate(item.occurredAt) : '-' }}
              </time>
            </div>
          </div>
        </div>
        <el-empty v-else description="暂无审批历史" :image-size="80" />
      </div>
    </div>

    <!-- Action bar -->
    <div v-if="approval && approval.status === 'pending'" class="approval-detail__actions">
      <el-button type="primary" @click="openActionDialog('approve')">通过</el-button>
      <el-button type="danger" @click="openActionDialog('reject')">驳回</el-button>
      <el-button @click="openTransferDialog">转交</el-button>
      <el-button @click="handleRevoke">撤回</el-button>
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
          :type="currentAction === 'approve' ? 'primary' : 'danger'"
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
          <el-select v-model="transferUserId" placeholder="选择用户" style="width: 100%">
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
        <el-button type="primary" :loading="store.loading" @click="submitTransfer">
          确认转交
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { ApprovalActionType } from '../../types/approval'
import { useApprovalStore } from '../../approvals/store'

const route = useRoute()
const router = useRouter()
const store = useApprovalStore()

const approval = computed(() => store.activeApproval)

const actionDialogVisible = ref(false)
const transferDialogVisible = ref(false)
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

async function submitAction() {
  const id = route.params.id as string
  await store.executeAction(id, {
    action: currentAction.value,
    comment: actionComment.value || undefined,
  })
  actionDialogVisible.value = false
  await store.loadHistory(id)
}

async function submitTransfer() {
  if (!transferUserId.value) return
  const id = route.params.id as string
  await store.executeAction(id, {
    action: 'transfer',
    comment: actionComment.value || undefined,
    targetUserId: transferUserId.value,
  })
  transferDialogVisible.value = false
  await store.loadHistory(id)
}

async function handleRevoke() {
  const id = route.params.id as string
  await store.executeAction(id, { action: 'revoke' })
  await store.loadHistory(id)
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

.approval-detail__body {
  display: grid;
  grid-template-columns: 1fr 360px;
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

.approval-detail__history {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.approval-detail__history-item {
  display: flex;
  gap: 12px;
  padding: 12px 0;
  border-left: 2px solid var(--el-border-color-lighter, #e4e7ed);
  padding-left: 16px;
  position: relative;
}

.approval-detail__history-dot {
  position: absolute;
  left: -6px;
  top: 16px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--el-color-info, #909399);
}

.dot--approved { background: var(--el-color-success, #67c23a); }
.dot--rejected { background: var(--el-color-danger, #f56c6c); }
.dot--pending { background: var(--el-color-warning, #e6a23c); }
.dot--revoked { background: var(--el-color-info, #909399); }

.approval-detail__history-content {
  flex: 1;
}

.approval-detail__history-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.approval-detail__history-comment {
  margin: 4px 0;
  color: var(--el-text-color-regular, #606266);
  font-size: 13px;
}

.approval-detail__history-time {
  font-size: 12px;
  color: var(--el-text-color-secondary, #909399);
}

.approval-detail__actions {
  margin-top: 24px;
  padding: 16px 20px;
  background: #fff;
  border: 1px solid var(--el-border-color-lighter, #e4e7ed);
  border-radius: 8px;
  display: flex;
  gap: 12px;
}
</style>
