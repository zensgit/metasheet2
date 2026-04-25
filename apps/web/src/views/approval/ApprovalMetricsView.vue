<template>
  <section class="approval-metrics">
    <header class="approval-metrics__header">
      <h1>审批 SLA 与耗时</h1>
      <div class="approval-metrics__toolbar">
        <el-date-picker
          v-model="dateRange"
          type="daterange"
          unlink-panels
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          value-format="YYYY-MM-DD"
          @change="loadSummary"
        />
        <el-button type="primary" @click="loadAll" :loading="loading">
          刷新
        </el-button>
      </div>
    </header>

    <el-alert
      v-if="errorMessage"
      :title="errorMessage"
      type="error"
      show-icon
      closable
      @close="errorMessage = ''"
    />

    <div class="approval-metrics__cards">
      <el-card shadow="hover">
        <div class="metric-label">总量</div>
        <div class="metric-value" data-testid="metric-total">{{ summary.total }}</div>
        <div class="metric-sub">运行中 {{ summary.running }}</div>
      </el-card>
      <el-card shadow="hover">
        <div class="metric-label">通过率</div>
        <div class="metric-value" data-testid="metric-approval-rate">{{ approvalRatePercent }}</div>
        <div class="metric-sub">通过 {{ summary.approved }} · 驳回 {{ summary.rejected }}</div>
      </el-card>
      <el-card shadow="hover">
        <div class="metric-label">平均耗时</div>
        <div class="metric-value" data-testid="metric-avg-duration">{{ formatDuration(summary.avgDurationSeconds) }}</div>
        <div class="metric-sub">
          P50 {{ formatDuration(summary.p50DurationSeconds) }} · P95 {{ formatDuration(summary.p95DurationSeconds) }}
        </div>
      </el-card>
      <el-card shadow="hover" class="approval-metrics__card--breach">
        <div class="metric-label">SLA 超时率</div>
        <div class="metric-value" data-testid="metric-sla-rate">{{ slaBreachRatePercent }}</div>
        <div class="metric-sub">{{ summary.slaBreachCount }} / {{ slaCandidateCount }}</div>
      </el-card>
    </div>

    <el-card class="approval-metrics__section">
      <template #header>
        <span>按模板汇总</span>
      </template>
      <el-table :data="summary.byTemplate" stripe v-loading="loading">
        <el-table-column prop="templateId" label="模板 ID" min-width="240">
          <template #default="{ row }">
            <el-link
              v-if="row.templateId"
              :to="{ name: 'approval-template-detail', params: { id: row.templateId } }"
              type="primary"
              @click="goTemplate(row.templateId)"
            >
              {{ row.templateId }}
            </el-link>
            <span v-else class="metric-muted">未关联模板</span>
          </template>
        </el-table-column>
        <el-table-column prop="total" label="总量" width="100" />
        <el-table-column prop="approved" label="通过" width="100" />
        <el-table-column prop="rejected" label="驳回" width="100" />
        <el-table-column prop="revoked" label="撤回" width="100" />
        <el-table-column label="平均耗时" width="160">
          <template #default="{ row }">
            {{ formatDuration(row.avgDurationSeconds) }}
          </template>
        </el-table-column>
        <el-table-column label="SLA 超时率" width="160">
          <template #default="{ row }">
            {{ formatPercent(row.slaBreachRate) }}
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card class="approval-metrics__section">
      <template #header>
        <span>运行中且已超时实例</span>
      </template>
      <el-table :data="breaches" stripe v-loading="breachLoading" empty-text="当前无超时实例">
        <el-table-column label="实例" min-width="260">
          <template #default="{ row }">
            <el-link type="primary" @click="goInstance(row.instance_id)">
              {{ row.instance_id }}
            </el-link>
          </template>
        </el-table-column>
        <el-table-column prop="sla_hours" label="SLA (小时)" width="140" />
        <el-table-column label="开始时间" width="220">
          <template #default="{ row }">{{ formatTimestamp(row.started_at) }}</template>
        </el-table-column>
        <el-table-column label="超时标记时间" width="220">
          <template #default="{ row }">{{ formatTimestamp(row.sla_breached_at) }}</template>
        </el-table-column>
      </el-table>
    </el-card>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  fetchApprovalMetricsBreaches,
  fetchApprovalMetricsSummary,
  type ApprovalMetricsRow,
  type ApprovalMetricsSummary,
} from '../../approvals/api'

const router = useRouter()

const summary = ref<ApprovalMetricsSummary>({
  total: 0, approved: 0, rejected: 0, revoked: 0, returned: 0, running: 0,
  avgDurationSeconds: null, p50DurationSeconds: null, p95DurationSeconds: null,
  slaBreachCount: 0, slaCandidateCount: 0, slaBreachRate: 0, byTemplate: [],
})
const breaches = ref<ApprovalMetricsRow[]>([])
const dateRange = ref<[string, string] | null>(null)
const loading = ref(false)
const breachLoading = ref(false)
const errorMessage = ref('')

const approvalRatePercent = computed(() => {
  const decided = summary.value.approved + summary.value.rejected + summary.value.revoked + summary.value.returned
  if (decided === 0) return '-'
  return `${((summary.value.approved / decided) * 100).toFixed(1)}%`
})

const slaBreachRatePercent = computed(() => formatPercent(summary.value.slaBreachRate))

const slaCandidateCount = computed(() => summary.value.slaCandidateCount)

async function loadSummary(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    const query: { since?: string; until?: string } = {}
    if (dateRange.value && dateRange.value[0]) query.since = `${dateRange.value[0]}T00:00:00Z`
    if (dateRange.value && dateRange.value[1]) query.until = `${dateRange.value[1]}T23:59:59Z`
    summary.value = await fetchApprovalMetricsSummary(query)
  } catch (error) {
    errorMessage.value = `加载汇总失败: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    loading.value = false
  }
}

async function loadBreaches(): Promise<void> {
  breachLoading.value = true
  try {
    breaches.value = await fetchApprovalMetricsBreaches()
  } catch (error) {
    errorMessage.value = `加载超时实例失败: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    breachLoading.value = false
  }
}

async function loadAll(): Promise<void> {
  await Promise.all([loadSummary(), loadBreaches()])
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '-'
  if (seconds < 60) return `${seconds.toFixed(0)}s`
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`
  return `${(seconds / 3600).toFixed(2)}h`
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-'
  return `${(value * 100).toFixed(1)}%`
}

function formatTimestamp(value: string | null): string {
  if (!value) return '-'
  const d = new Date(value)
  if (!Number.isFinite(d.getTime())) return value
  return d.toLocaleString()
}

function goInstance(instanceId: string): void {
  router.push({ name: 'approval-detail', params: { id: instanceId } })
}

function goTemplate(templateId: string): void {
  router.push({ name: 'approval-template-detail', params: { id: templateId } })
}

onMounted(() => { void loadAll() })
</script>

<style scoped>
.approval-metrics {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.approval-metrics__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.approval-metrics__toolbar {
  display: flex;
  gap: 12px;
}
.approval-metrics__cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
}
.approval-metrics__card--breach :deep(.el-card__body) {
  background: #fff7e6;
}
.metric-label {
  font-size: 13px;
  color: #6b7280;
  margin-bottom: 8px;
}
.metric-value {
  font-size: 28px;
  font-weight: 600;
  color: #1f2937;
}
.metric-sub {
  font-size: 12px;
  color: #9ca3af;
  margin-top: 6px;
}
.metric-muted {
  color: #9ca3af;
}
.approval-metrics__section {
  width: 100%;
}
</style>
