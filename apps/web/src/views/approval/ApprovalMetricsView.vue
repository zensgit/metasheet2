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
          :shortcuts="DATE_RANGE_SHORTCUTS"
          @change="loadAll"
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
        <el-table-column prop="templateId" label="模板" min-width="240">
          <template #default="{ row }">
            <el-link
              v-if="row.templateId"
              :to="{ name: 'approval-template-detail', params: { id: row.templateId } }"
              type="primary"
              @click="goTemplate(row.templateId)"
            >
              {{ templateDisplayName(row.templateId) }}
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

    <el-card class="approval-metrics__section" data-testid="metrics-section-teams">
      <template #header>
        <span>按部门汇总</span>
      </template>
      <div data-testid="metrics-table-teams">
        <el-table :data="teams" stripe v-loading="teamsLoading" empty-text="暂无部门数据">
          <el-table-column label="部门" min-width="220">
            <template #default="{ row }">
              <span>{{ row.name || row.key || '未归属部门' }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="total" label="总量" width="90" />
          <el-table-column prop="approved" label="通过" width="90" />
          <el-table-column prop="rejected" label="驳回" width="90" />
          <el-table-column prop="revoked" label="撤回" width="90" />
          <el-table-column label="平均耗时" width="130">
            <template #default="{ row }">{{ formatDuration(row.avgDurationSeconds) }}</template>
          </el-table-column>
          <el-table-column label="SLA 超时率" min-width="180">
            <template #default="{ row }">
              <div class="metric-bar">
                <div class="metric-bar__track">
                  <div class="metric-bar__fill" :style="{ width: barWidth(row.slaBreachRate) }"></div>
                </div>
                <span class="metric-bar__label">{{ formatPercent(row.slaBreachRate) }}</span>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </el-card>

    <el-card
      v-if="canViewPeople"
      class="approval-metrics__section"
      data-testid="metrics-section-people"
    >
      <template #header>
        <span>按发起人汇总</span>
      </template>
      <div data-testid="metrics-table-people">
        <el-table :data="people" stripe v-loading="peopleLoading" empty-text="暂无发起人数据">
          <el-table-column label="发起人" min-width="220">
            <template #default="{ row }">
              <span>{{ row.name || row.key || '未归属发起人' }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="total" label="总量" width="90" />
          <el-table-column prop="approved" label="通过" width="90" />
          <el-table-column prop="rejected" label="驳回" width="90" />
          <el-table-column prop="revoked" label="撤回" width="90" />
          <el-table-column label="平均耗时" width="130">
            <template #default="{ row }">{{ formatDuration(row.avgDurationSeconds) }}</template>
          </el-table-column>
          <el-table-column label="SLA 超时率" min-width="180">
            <template #default="{ row }">
              <div class="metric-bar">
                <div class="metric-bar__track">
                  <div class="metric-bar__fill" :style="{ width: barWidth(row.slaBreachRate) }"></div>
                </div>
                <span class="metric-bar__label">{{ formatPercent(row.slaBreachRate) }}</span>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>
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

    <div class="approval-metrics__topn">
      <el-card class="approval-metrics__section">
        <template #header>
          <span>TopN 最慢实例</span>
        </template>
        <el-table :data="slowestInstances" stripe v-loading="reportLoading" empty-text="暂无已完成实例">
          <el-table-column label="实例" min-width="220">
            <template #default="{ row }">
              <el-link type="primary" @click="goInstance(row.instanceId)">
                {{ row.instanceId }}
              </el-link>
            </template>
          </el-table-column>
          <el-table-column label="模板" min-width="180">
            <template #default="{ row }">
              <el-link v-if="row.templateId" type="primary" @click="goTemplate(row.templateId)">
                {{ templateDisplayName(row.templateId) }}
              </el-link>
              <span v-else class="metric-muted">未关联模板</span>
            </template>
          </el-table-column>
          <el-table-column label="耗时" width="120">
            <template #default="{ row }">{{ formatDuration(row.durationSeconds) }}</template>
          </el-table-column>
          <el-table-column label="状态" width="120">
            <template #default="{ row }">{{ row.terminalState || '-' }}</template>
          </el-table-column>
          <el-table-column label="完成时间" width="220">
            <template #default="{ row }">{{ formatTimestamp(row.terminalAt) }}</template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card class="approval-metrics__section">
        <template #header>
          <span>TopN SLA 风险模板</span>
        </template>
        <el-table :data="breachedTemplates" stripe v-loading="reportLoading" empty-text="暂无 SLA 模板数据">
          <el-table-column label="模板" min-width="220">
            <template #default="{ row }">
              <el-link v-if="row.templateId" type="primary" @click="goTemplate(row.templateId)">
                {{ templateDisplayName(row.templateId) }}
              </el-link>
              <span v-else class="metric-muted">未关联模板</span>
            </template>
          </el-table-column>
          <el-table-column prop="total" label="总量" width="90" />
          <el-table-column label="SLA 超时" width="120">
            <template #default="{ row }">{{ row.slaBreachCount }} / {{ row.slaCandidateCount }}</template>
          </el-table-column>
          <el-table-column label="超时率" width="110">
            <template #default="{ row }">{{ formatPercent(row.slaBreachRate) }}</template>
          </el-table-column>
          <el-table-column label="平均耗时" width="130">
            <template #default="{ row }">{{ formatDuration(row.avgDurationSeconds) }}</template>
          </el-table-column>
          <el-table-column label="P95" width="130">
            <template #default="{ row }">{{ formatDuration(row.p95DurationSeconds) }}</template>
          </el-table-column>
        </el-table>
      </el-card>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '../../composables/useAuth'
import {
  fetchApprovalMetricsBreaches,
  fetchApprovalMetricsPeople,
  fetchApprovalMetricsReport,
  fetchApprovalMetricsSummary,
  fetchApprovalMetricsTeams,
  listTemplates,
  type ApprovalMetricsDimensionRow,
  type ApprovalMetricsRow,
  type ApprovalMetricsSummary,
  type ApprovalMetricsTopInstanceRow,
  type ApprovalMetricsTopTemplateRow,
} from '../../approvals/api'

const router = useRouter()
const { hasPermission } = useAuth()

// Person-level analytics (/people) is gated behind a SEPARATE `approvals:analytics`
// permission on the backend (a who-is-slowest ranking is more sensitive than
// approval administration). Mirror that gate here as defense-in-depth: hide the
// requester section (and skip its fetch) when the actor lacks the permission.
// The hard gate remains the backend rbacGuard — a 403 is caught gracefully below.
const canViewPeople = computed(() => hasPermission('approvals:analytics'))

const summary = ref<ApprovalMetricsSummary>({
  total: 0, approved: 0, rejected: 0, revoked: 0, returned: 0, running: 0,
  avgDurationSeconds: null, p50DurationSeconds: null, p95DurationSeconds: null,
  slaBreachCount: 0, slaCandidateCount: 0, slaBreachRate: 0, byTemplate: [],
})
const breaches = ref<ApprovalMetricsRow[]>([])
const slowestInstances = ref<ApprovalMetricsTopInstanceRow[]>([])
const breachedTemplates = ref<ApprovalMetricsTopTemplateRow[]>([])
const teams = ref<ApprovalMetricsDimensionRow[]>([])
const people = ref<ApprovalMetricsDimensionRow[]>([])
const dateRange = ref<[string, string] | null>(null)
const loading = ref(false)
const breachLoading = ref(false)
const reportLoading = ref(false)
const teamsLoading = ref(false)
const peopleLoading = ref(false)
const errorMessage = ref('')
// B2-04: template id → name, fetched ONCE on mount (not tied to the date range/refresh) so the
// per-template tables below can render a scannable name instead of a raw UUID.
const templateNameById = ref<Map<string, string>>(new Map())

const BREAKDOWN_LIMIT = 20
// B2-04: quick date-range presets for the toolbar picker. Each `value` is a function so "近 7
// 天"/"近 30 天"/"本月" stay relative to "now" at the moment the shortcut is clicked, not frozen
// at module-eval time.
const DATE_RANGE_SHORTCUTS = [
  {
    text: '近 7 天',
    value: (): [Date, Date] => {
      const end = new Date()
      const start = new Date()
      start.setDate(start.getDate() - 7)
      return [start, end]
    },
  },
  {
    text: '近 30 天',
    value: (): [Date, Date] => {
      const end = new Date()
      const start = new Date()
      start.setDate(start.getDate() - 30)
      return [start, end]
    },
  },
  {
    text: '本月',
    value: (): [Date, Date] => {
      const end = new Date()
      const start = new Date(end.getFullYear(), end.getMonth(), 1)
      return [start, end]
    },
  },
]

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

async function loadReport(): Promise<void> {
  reportLoading.value = true
  try {
    const query: { since?: string; until?: string; limit?: number } = { limit: 10 }
    if (dateRange.value && dateRange.value[0]) query.since = `${dateRange.value[0]}T00:00:00Z`
    if (dateRange.value && dateRange.value[1]) query.until = `${dateRange.value[1]}T23:59:59Z`
    const report = await fetchApprovalMetricsReport(query)
    slowestInstances.value = report.slowestInstances
    breachedTemplates.value = report.breachedTemplates
  } catch (error) {
    errorMessage.value = `加载 TopN 报表失败: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    reportLoading.value = false
  }
}

function rangeQuery(base: { limit?: number } = {}): { since?: string; until?: string; limit?: number } {
  const query: { since?: string; until?: string; limit?: number } = { ...base }
  if (dateRange.value && dateRange.value[0]) query.since = `${dateRange.value[0]}T00:00:00Z`
  if (dateRange.value && dateRange.value[1]) query.until = `${dateRange.value[1]}T23:59:59Z`
  return query
}

async function loadTeams(): Promise<void> {
  teamsLoading.value = true
  try {
    teams.value = await fetchApprovalMetricsTeams(rangeQuery({ limit: BREAKDOWN_LIMIT }))
  } catch (error) {
    errorMessage.value = `加载部门汇总失败: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    teamsLoading.value = false
  }
}

async function loadPeople(): Promise<void> {
  // Skip entirely without the analytics permission — the section is hidden and
  // the backend would answer 403.
  if (!canViewPeople.value) {
    people.value = []
    return
  }
  peopleLoading.value = true
  try {
    people.value = await fetchApprovalMetricsPeople(rangeQuery({ limit: BREAKDOWN_LIMIT }))
  } catch (error) {
    // Graceful degrade: an unexpected 403 (permission drift) must not blank the
    // whole dashboard — surface a note and leave the other sections intact.
    people.value = []
    errorMessage.value = `加载发起人汇总失败: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    peopleLoading.value = false
  }
}

async function loadAll(): Promise<void> {
  await Promise.all([loadSummary(), loadBreaches(), loadReport(), loadTeams(), loadPeople()])
}

// B2-04: best-effort id→name lookup, fetched once (a generous pageSize so typical template
// catalogs resolve in one page — the backend caps pageSize at 200 regardless). Non-fatal: a
// failure (or a template outside the fetched page) just leaves the id unmapped, and
// `templateDisplayName` falls back to the raw id, same as before this change.
async function loadTemplateNames(): Promise<void> {
  try {
    const { data } = await listTemplates({ pageSize: 200 })
    templateNameById.value = new Map(data.map((template) => [template.id, template.name]))
  } catch {
    templateNameById.value = new Map()
  }
}

function templateDisplayName(templateId: string): string {
  return templateNameById.value.get(templateId) ?? templateId
}

function barWidth(rate: number | null | undefined): string {
  const pct = typeof rate === 'number' && Number.isFinite(rate) ? rate * 100 : 0
  return `${Math.min(100, Math.max(0, pct))}%`
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

onMounted(() => {
  void loadAll()
  void loadTemplateNames()
})
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
.approval-metrics__topn {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: 16px;
}
.metric-bar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.metric-bar__track {
  flex: 1;
  min-width: 48px;
  height: 8px;
  border-radius: 4px;
  background: #f0f0f0;
  overflow: hidden;
}
.metric-bar__fill {
  height: 100%;
  border-radius: 4px;
  background: #f59e0b;
}
.metric-bar__label {
  font-size: 12px;
  color: #4b5563;
  min-width: 44px;
  text-align: right;
}
</style>
