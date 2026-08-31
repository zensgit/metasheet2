<template>
  <div class="sp-dash" data-testid="stock-prep-dashboard">
    <p
      v-if="overviewLoading"
      class="sp-dash__state sp-dash__state--muted"
      data-testid="stock-prep-dashboard-loading"
      role="status"
    >
      {{ bi('正在读取项目情况…', 'Reading the projects…') }}
    </p>

    <div
      v-else-if="overviewErrored"
      class="sp-dash__state sp-dash__state--muted"
      data-testid="stock-prep-dashboard-error"
      role="status"
    >
      <p class="sp-dash__state-msg">{{ bi('暂时读不到数据,稍后再试。', 'Cannot read the data right now — try again shortly.') }}</p>
      <!-- H4-1 retry: re-runs the read-gated overview load. Idempotent + safe — loadOverview resets
           overviewErrored and re-fetches; no stale race (this is the coarse /projects read, and the
           stage-detail load carries its own monotonic seq guard). -->
      <button
        ref="overviewRetryEl"
        type="button"
        class="sp-dash__retry"
        data-testid="stock-prep-dashboard-retry"
        :disabled="overviewLoading"
        :aria-label="bi('重试读取工作台概览', 'Retry loading workbench overview')"
        @click="onOverviewRetry"
      >
        {{ bi('重试', 'Retry') }}
      </button>
    </div>

    <p
      v-else-if="isEmpty"
      class="sp-dash__state sp-dash__state--muted"
      data-testid="stock-prep-dashboard-empty"
    >
      {{ bi('还没有同步过任何项目。', 'Nothing has been synced yet.') }}
    </p>

    <div v-else class="sp-dash__body" data-testid="stock-prep-dashboard-body">
      <!-- Compact project selector (T1 GET /projects — handle + status + counts). Selecting here
           updates the shell's shared selectedProjectId WITHOUT switching tabs (unlike view 1's row
           action, which jumps straight to view 2) — the operator stays on the dashboard to read the
           stage overview for the project they just picked. -->
      <div class="sp-dash__picker" data-testid="stock-prep-dashboard-picker">
        <label class="sp-dash__field">
          <span class="sp-dash__field-label">{{ bi('当前项目', 'Current project') }}</span>
          <select
            class="sp-dash__select"
            data-testid="stock-prep-dashboard-project-select"
            :value="projectId ?? ''"
            @change="onPick($event)"
          >
            <option value="" disabled>{{ bi('请选择项目', 'Select a project') }}</option>
            <!-- VALUES-FREE options: the projectId handle rides the option VALUE (never rendered as
                 text — same idiom as view 1's row :key and select-project emit); the visible LABEL is
                 built only from status/counts/handle, mirroring the fields view 1's own table shows
                 for the identical row. -->
            <option v-for="project in overview!.projects" :key="project.projectId" :value="project.projectId">
              {{ optionLabel(project) }}
            </option>
          </select>
        </label>
      </div>

      <p
        v-if="!projectId"
        class="sp-dash__state sp-dash__state--muted"
        data-testid="stock-prep-dashboard-no-project"
      >
        {{ bi(
          '选一个项目,这里就会显示它做到哪一步、有几件事卡着、接下来该做什么。',
          'Select a project and this page shows how far it has got, what is stuck, and what to do next.',
        ) }}
      </p>

      <template v-else>
        <div v-if="selectedProject" class="sp-dash__current" data-testid="stock-prep-dashboard-current">
          <span class="sp-dash__current-item" data-testid="stock-prep-dashboard-current-status">
            {{ bi('项目状态', 'Project status') }}: {{ selectedProject.projectStatus }}
          </span>
          <!-- The run handle is an internal navigation id, not a business value. It is what we ask
               for when someone reports "this sync looks wrong", so it stays — subordinate. -->
          <span class="sp-dash__current-item" data-testid="stock-prep-dashboard-current-run">
            {{ bi('最近一次同步', 'Last sync') }} <code>{{ selectedProject.lastSyncRunId ?? '—' }}</code>
          </span>
        </div>

        <!-- Recommended next step (H1): a deterministic rule over counts/status only (never a
             business value) — see stageOverview.ts deriveRecommendedNextStep. Degrades honestly to a
             coarser tier-1 recommendation (from the read-gated /projects counts alone) when the five
             admin-gated stage reads are unavailable to this operator. -->
        <div
          class="sp-dash__recommend"
          :class="`sp-dash__recommend--${recommendedStep.kind}`"
          :data-kind="recommendedStep.kind"
          data-testid="stock-prep-dashboard-recommend"
        >
          <span class="sp-dash__recommend-label">{{ bi('推荐下一步', 'Recommended next step') }}</span>
          <p class="sp-dash__recommend-text" data-testid="stock-prep-dashboard-recommend-text">{{ recommendCopy }}</p>
          <button
            v-if="recommendedStep.kind === 'go_to_stage' && recommendedStep.stage"
            type="button"
            class="sp-dash__recommend-action"
            data-testid="stock-prep-dashboard-recommend-action"
            @click="onStageNavigate(recommendedStep.stage)"
          >
            {{ bi('前往处理', 'Go there') }}
          </button>
          <!-- H4-1 detail retry — ONLY for detail_unavailable (a transient, non-permission stage-read
               failure). NOT for admin_required: a 403 is not a transient fault, so retrying is pointless.
               loadStageDetail re-runs under its own monotonic seq guard, so a project switched during the
               retry never lets a stale response win. -->
          <button
            v-else-if="recommendedStep.kind === 'detail_unavailable'"
            ref="detailRetryEl"
            type="button"
            class="sp-dash__recommend-action"
            data-testid="stock-prep-dashboard-detail-retry"
            :disabled="stageDetailLoading"
            :aria-label="bi('重试读取阶段详情', 'Retry loading stage detail')"
            @click="onDetailRetry"
          >
            {{ bi('重试', 'Retry') }}
          </button>
        </div>

        <!-- H2 six-stage stepper — SAME activeKey navigation surface as the tab bar (satellite, not a
             second nav system): clicking a stage translates to a tab switch via STOCK_PREPARATION_STAGE_VIEW_KEY. -->
        <StockPreparationStageStepper
          :stages="allStages"
          :loading="stageDetailLoading"
          :errored="false"
          @navigate="onStageNavigate"
        />

        <!-- What the banner above decided, and what it decided it from. The recommendation is a
             deterministic rule over counts and status (stageOverview.ts deriveRecommendedNextStep),
             so naming the rule that fired is how an implementer checks it against the data. -->
        <StockPrepTechnicalDetails testid="stock-prep-dashboard-tech">
          <dl>
            <dt>{{ bi('推荐规则命中的分支', 'Recommendation rule that fired') }}</dt>
            <dd>
              <code>{{ recommendedStep.reason }}</code>
              · <code>{{ recommendedStep.kind }}</code>
              <span v-if="recommendedStep.stage"> · <code>{{ recommendedStep.stage }}</code></span>
            </dd>
            <dt>{{ bi('六个阶段的原始读数', 'Raw readings for the six stages') }}</dt>
            <dd>
              <ul>
                <li v-for="stage in allStages" :key="stage.key">
                  <code>{{ stage.key }}</code> = <code>{{ stage.status }}</code>
                  · count={{ stage.count ?? '—' }}
                  · blocking={{ stage.blockingCount ?? '—' }}
                  <span v-if="stage.caveat"> · <code>{{ stage.caveat }}</code></span>
                </li>
              </ul>
            </dd>
            <dt>{{ bi('权限口径', 'Permission reading') }}</dt>
            <dd>
              {{ detailForbidden
                ? bi(
                  '五个阶段详情读取被服务端拒绝(requireAccess admin),已退回到只用项目计数的粗粒度推荐。',
                  'The five stage-detail reads were refused server-side (requireAccess admin), so the recommendation fell back to the coarser project-count rule.',
                )
                : bi(
                  '五个阶段详情读取正常;它们与下面各视图复用同一批只读端点,本页不新增后端。',
                  'The five stage-detail reads succeeded; they reuse the same readonly endpoints as the views below — this page adds no backend of its own.',
                ) }}
            </dd>
          </dl>
        </StockPrepTechnicalDetails>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
// Stock Preparation UI humanization H1/H2 (H0 plane-boundary design-lock PR #4202 — PLANE A ONLY,
// values-free). The "task-oriented entry" dashboard: a project picker + a "current project" chip +
// the recommended-next-step banner (H1) + the six-stage stepper (H2, StockPreparationStageStepper.vue).
//
// READONLY: this view only issues GETs through the existing per-view service modules (T1 /projects,
// plus the five admin-gated stage reads reused from views 2/3/4/5/6). It never adds a new backend
// endpoint and never widens any route's permission — see stageOverview.ts header for the exact
// scope/permission facts this was built against.
//
// PERMISSION HONESTY: stages sync/map/unit/generate/exception are admin-gated server-side
// (requireAccess(req, 'admin')). This component fires all five reads and treats a CONFIRMED 403 from
// the two robustly-status-bearing calls (prep-lines / exceptions, which throw
// StockPreparationConfirmApiError with a real HTTP status) as the authoritative "this operator lacks
// admin" signal — never a client-side role heuristic. When forbidden, the six-stage stepper still
// shows all six slots (provision stays visible — it is read-gated) but each of the five detail stages
// renders its own "requires admin" degrade instead of fabricated numbers, and the recommended-next-step
// banner falls back to the coarser tier-1 rule sourced from the read-gated /projects counts alone.
//
// VALUES-FREE: the template reads a fixed whitelist — status enums, counts, and internal handles
// (projectId as an <option> VALUE only, never rendered text; lastSyncRunId rendered the same way
// view 1 already does). No drawing number, material code, ERP id, or other business value ever
// crosses here — that surface is H3 (gated on OD-W3-1) and is not touched by this component.
import { computed, nextTick, onMounted, ref, watch, type Ref } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import type { IntegrationScope } from '../../../services/integration/workbench'
import {
  getStockPreparationWorkspaceOverview,
  type StockPreparationProjectSummary,
  type StockPreparationWorkspaceOverview,
} from '../../../services/integration/stockPreparation/projectWorkspace'
import { listStockPreparationSnapshotBatches } from '../../../services/integration/stockPreparation/bomSnapshotDiff'
import { getStockPreparationMaterialMappingSummary } from '../../../services/integration/stockPreparation/materialMapping'
import { getStockPreparationUnitConversionSummary } from '../../../services/integration/stockPreparation/unitConversion'
import { listStockPreparationPrepLines } from '../../../services/integration/stockPreparation/prepLine'
import { listStockPreparationExceptions } from '../../../services/integration/stockPreparation/exceptionQueue'
import { StockPreparationConfirmApiError } from '../../../services/integration/stockPreparation/confirmApi'
import {
  classifyDetailStageStatus,
  classifyProvisionStatus,
  deriveRecommendedNextStep,
  STOCK_PREPARATION_STAGE_VIEW_KEY,
  type StockPreparationStageCaveat,
  type StockPreparationStageKey,
  type StockPreparationStageMetric,
} from '../../../services/integration/stockPreparation/stageOverview'
import StockPreparationStageStepper from './StockPreparationStageStepper.vue'
import StockPrepTechnicalDetails from './StockPrepTechnicalDetails.vue'

const props = withDefaults(
  defineProps<{
    /** Shell-owned shared context (#4017 pattern) — absent until a project is picked. */
    projectId?: string
    scope?: IntegrationScope
  }>(),
  { projectId: undefined, scope: () => ({}) },
)

const emit = defineEmits<{
  /** Fired from THIS view's own picker — the shell updates selectedProjectId WITHOUT switching tabs. */
  (e: 'select-project', projectId: string): void
  /** Fired from the stepper/recommend-action — the shell's EXISTING activeKey, not a second nav system. */
  (e: 'navigate-stage', viewKey: string): void
}>()

const { locale } = useLocale()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const overviewLoading = ref(true)
const overviewErrored = ref(false)
const overview = ref<StockPreparationWorkspaceOverview | null>(null)

const isEmpty = computed(() => overview.value !== null && overview.value.projectCount === 0)

const selectedProject = computed<StockPreparationProjectSummary | null>(() => {
  if (!props.projectId || !overview.value) return null
  return overview.value.projects.find((project) => project.projectId === props.projectId) ?? null
})

function optionLabel(project: StockPreparationProjectSummary): string {
  const parts = [
    project.projectStatus,
    `${bi('批次', 'batches')} ${project.snapshotBatchCount}`,
    `${bi('异常', 'exceptions')} ${project.openExceptionCount}`,
    `${bi('就绪', 'ready')} ${project.readyLineCount}`,
    `${bi('暂挂', 'held')} ${project.heldLineCount}`,
  ]
  if (project.lastSyncRunId) parts.push(project.lastSyncRunId)
  return parts.join(' · ')
}

async function loadOverview(): Promise<void> {
  overviewLoading.value = true
  overviewErrored.value = false
  try {
    overview.value = await getStockPreparationWorkspaceOverview(props.scope)
  } catch {
    // 404-soft: neutral state, NEVER the raw error body — same discipline as the other six views.
    overviewErrored.value = true
    overview.value = null
  } finally {
    overviewLoading.value = false
  }
}

function onPick(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  if (value) emit('select-project', value)
}

// ── H2 stage detail (five admin-gated reads, reused verbatim from views 2/3/4/5/6) ─────────────────

// Monotonic load counter: every loadStageDetail run claims the next number, and only the run whose
// number is still the latest may write the result. A plain projectId comparison is NOT enough — with
// A → B → A the newest run and a stale earliest-A run share the same projectId, so an id-only guard
// lets the late earliest-A response overwrite the newest A's numbers. The sequence is per-load, so
// only the single most-recent load ever wins.
let stageDetailSeq = 0
const stageDetailLoading = ref(false)
const detailForbidden = ref(false)
const detailStages = ref<StockPreparationStageMetric[] | null>(null)

function isForbiddenError(reason: unknown): boolean {
  return reason instanceof StockPreparationConfirmApiError && (reason.status === 403 || reason.code === 'FORBIDDEN')
}

// Build one stage metric from a settled read. `extract` only runs on a fulfilled result, so a
// caveat is only ever attached alongside REAL numbers (never next to a forbidden/unknown placeholder
// — see StockPreparationStageStepper's own template for why that pairing would be meaningless).
function stageFromResult<T>(
  key: StockPreparationStageKey,
  result: PromiseSettledResult<T>,
  forbidden: boolean,
  extract: (data: T) => { count: number; blockingCount: number | null; caveat?: StockPreparationStageCaveat },
): StockPreparationStageMetric {
  if (result.status === 'fulfilled') {
    const { count, blockingCount, caveat } = extract(result.value)
    return { key, count, blockingCount, caveat, status: classifyDetailStageStatus({ count, blockingCount, forbidden, errored: false }) }
  }
  return { key, count: null, blockingCount: null, status: classifyDetailStageStatus({ count: null, blockingCount: null, forbidden, errored: true }) }
}

async function loadStageDetail(): Promise<void> {
  // Claim this load's sequence FIRST — BEFORE the empty-project early return. The watcher re-fires
  // loadStageDetail on every projectId change, so several loads can be in flight at once; only the run
  // that is still the most recent may commit. Claiming the sequence here means clearing the selection
  // (projectId → '') ALSO bumps the sequence and cancels any in-flight load — otherwise an A-load still
  // in flight when the user deselects keeps a sequence that still matches, and would commit its stale
  // result on resolve (owner review P2: A in flight → deselect → reselect A briefly showed the stale A).
  const seq = ++stageDetailSeq
  if (!props.projectId) {
    stageDetailLoading.value = false
    detailForbidden.value = false
    detailStages.value = null
    return
  }
  stageDetailLoading.value = true
  // Clear stale detail at the start of each new load so a superseded response can never render while the
  // fresh load is in flight (owner review P2: "每次新加载开始时清空旧 detail 状态").
  detailStages.value = null
  detailForbidden.value = false
  const scope = { ...props.scope, projectId: props.projectId }
  const [syncResult, mapResult, unitResult, generateResult, exceptionResult] = await Promise.allSettled([
    listStockPreparationSnapshotBatches(scope),
    getStockPreparationMaterialMappingSummary(scope),
    getStockPreparationUnitConversionSummary(scope),
    listStockPreparationPrepLines({ ...scope, projectId: props.projectId }),
    listStockPreparationExceptions({ ...scope, projectId: props.projectId }),
  ])

  // Drop a superseded response: if another loadStageDetail started after us (project switched, even
  // A → B → A), it owns the state. Comparing the monotonic sequence — not the projectId — is what
  // makes A → B → A safe: the stale earliest-A run has a lower seq than the newest A run.
  if (seq !== stageDetailSeq) return

  // Authoritative forbidden signal: only these two calls throw StockPreparationConfirmApiError with
  // a REAL HTTP status (the three summary-shaped calls above lose status/code through
  // parseIntegrationResponse's generic Error) — but all five share the identical admin gate, so a
  // confirmed 403 from either one means the WHOLE detail tier is off-limits to this operator.
  const forbidden = isForbiddenError(generateResult.status === 'rejected' ? generateResult.reason : undefined)
    || isForbiddenError(exceptionResult.status === 'rejected' ? exceptionResult.reason : undefined)
  detailForbidden.value = forbidden

  detailStages.value = [
    stageFromResult('sync', syncResult, forbidden, (data) => ({
      count: data.batchCount,
      blockingCount: data.batches.filter((batch) => batch.incomplete).length,
    })),
    // map: TENANT-WIDE (see stageOverview.ts header) — never presented as project-specific.
    stageFromResult('map', mapResult, forbidden, (data) => ({
      count: data.activeMappingCount,
      blockingCount: data.pendingConfirmCount,
      caveat: 'tenant_wide',
    })),
    // unit: the ONE field of this tenant-wide summary that IS computed over this project's latest
    // complete snapshot batch — count and blockingCount coincide because it is the only honestly
    // project-scoped number available (no caveat needed for this one).
    stageFromResult('unit', unitResult, forbidden, (data) => ({
      count: data.pendingUnitLineCount,
      blockingCount: data.pendingUnitLineCount,
    })),
    stageFromResult('generate', generateResult, forbidden, (data) => ({
      count: data.rowCount,
      blockingCount: data.byPrepStatus.held ?? 0,
    })),
    // exception: unresolvedBlockingCount is a post-filter, READ-TIME subset, never the generation
    // gate's authoritative value (see stageOverview.ts header) — tagged accordingly.
    stageFromResult('exception', exceptionResult, forbidden, (data) => ({
      count: data.rowCount,
      blockingCount: data.unresolvedBlockingCount,
      caveat: 'display_only',
    })),
  ]
  stageDetailLoading.value = false
}

const allStages = computed<StockPreparationStageMetric[]>(() => {
  const provisionStage: StockPreparationStageMetric = {
    key: 'provision',
    status: classifyProvisionStatus({ projectCount: overview.value?.projectCount ?? 0, hasSelection: Boolean(props.projectId) }),
    count: overview.value?.projectCount ?? null,
    blockingCount: null,
  }
  // A missing detail array (no project picked yet, or the fetch hasn't settled) is fine — the
  // stepper itself fills the five remaining slots with an 'unknown' placeholder.
  return [provisionStage, ...(detailStages.value ?? [])]
})

const recommendedStep = computed(() =>
  deriveRecommendedNextStep({
    hasProject: Boolean(props.projectId),
    adminDetailAvailable: detailStages.value !== null && !detailForbidden.value,
    stages: allStages.value,
    projectSignals: selectedProject.value
      ? {
          snapshotBatchCount: selectedProject.value.snapshotBatchCount,
          openExceptionCount: selectedProject.value.openExceptionCount,
          readyLineCount: selectedProject.value.readyLineCount,
          heldLineCount: selectedProject.value.heldLineCount,
        }
      : undefined,
  }),
)

const recommendCopy = computed<string>(() => {
  const step = recommendedStep.value
  switch (step.reason) {
    case 'no_project_selected':
      return bi('请选择一个项目开始。', 'Select a project to get started.')
    case 'admin_permission_required':
      return bi('需要管理员权限才能查看阶段详情与推荐下一步。', 'Admin access is required to see stage detail and a recommended next step.')
    case 'sync_incomplete_batches':
      return bi(
        `有 ${step.count} 批同步的数据不完整 → 去「BOM 快照批次与差异」看看是哪几批。`,
        `${step.count} sync batch(es) came through incomplete → check which ones on the snapshot page.`,
      )
    case 'mapping_pending_tenant_wide':
      return bi(
        `有 ${step.count} 个物料还没对上(这个数是全公司共用的,不只本项目)→ 去「物料映射确认」处理。`,
        `${step.count} material(s) are not matched yet (that count is shared company-wide, not just this project) → handle them on the material-mapping page.`,
      )
    case 'unit_pending_lines':
      return bi(`有 ${step.count} 行的单位还没定 → 去「单位换算确认」处理。`, `${step.count} row(s) still have no unit settled → sort them on the unit page.`)
    case 'generate_not_run':
      return bi('还没生成过备料明细 → 现在可以生成了。', 'No prep lines have been built yet → you can build them now.')
    case 'exception_unresolved_blocking':
      return bi(
        `有 ${step.count} 件事卡着出不了料(这里显示的数,不是最终判定)→ 去「异常队列」处理。`,
        `${step.count} thing(s) are blocking the result (this is what is shown here, not the final verdict) → clear them on the exception page.`,
      )
    case 'project_open_exceptions':
      return bi(`该项目有 ${step.count} 件事待处理 → 去「异常队列」看看。`, `This project has ${step.count} thing(s) waiting to be handled → take a look at the exception page.`)
    case 'project_held_lines':
      return bi(`该项目有 ${step.count} 行备料明细卡着 → 去「备料行」看看卡在哪。`, `${step.count} prep line(s) on this project are stuck → see what is holding them up on the prep-line page.`)
    case 'project_no_snapshot_yet':
      return bi('该项目尚无快照(还没从 PLM 同步过)→ 先同步一次。', 'This project has no snapshot yet — nothing has been synced from PLM → sync it first.')
    case 'all_clear':
      return bi('当前没有需要处理的事,可以继续往下走。', 'Nothing needs attention right now — you can carry on.')
    case 'detail_read_incomplete':
      return bi(
        '部分阶段详情暂时读不到,现在还看不全有没有卡住的事 → 请稍后重试。',
        'Some of the per-step detail could not be read, so this is not the whole picture yet — try again shortly.',
      )
    default:
      return ''
  }
})

function onStageNavigate(stage: StockPreparationStageKey): void {
  emit('navigate-stage', STOCK_PREPARATION_STAGE_VIEW_KEY[stage])
}

// H4 keyboard — retry focus restore. Both retry buttons carry `:disabled` while their load is in
// flight (H4-1, #4272), and a NATIVE disabled button is pulled out of the tab order, so the browser
// drops focus to <body>: a keyboard operator who pressed Retry is stranded at the top of the page and
// has to Tab all the way back. After the load settles we put focus back on the button — but ONLY when
// it is still rendered (i.e. the retry failed again, so there is something to press) AND focus is
// still on <body> (i.e. it was OUR disable that dropped it and the operator has not Tabbed elsewhere
// meanwhile). Without that second condition this would STEAL focus from wherever they moved to.
const overviewRetryEl = ref<HTMLButtonElement | null>(null)
const detailRetryEl = ref<HTMLButtonElement | null>(null)

async function restoreRetryFocus(el: Ref<HTMLButtonElement | null>): Promise<void> {
  await nextTick()
  if (document.activeElement === document.body) el.value?.focus()
}

async function onOverviewRetry(): Promise<void> {
  await loadOverview()
  await restoreRetryFocus(overviewRetryEl)
}

async function onDetailRetry(): Promise<void> {
  await loadStageDetail()
  await restoreRetryFocus(detailRetryEl)
}

onMounted(loadOverview)
watch(() => props.projectId, loadStageDetail, { immediate: true })
</script>

<style scoped>
.sp-dash {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
}

.sp-dash__state {
  margin: 0;
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
  line-height: 1.6;
}

.sp-dash__state--muted {
  color: var(--ms-text-3);
}

.sp-dash__body {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
}

.sp-dash__field {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
  font-size: 13px;
  color: var(--ms-text-2);
  max-width: 480px;
}

.sp-dash__field-label {
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-dash__select {
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  padding: 4px 8px;
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  font: inherit;
  font-size: 13px;
}

/* H4 keyboard: the project picker is the FIRST Tab stop of the dashboard body — same ring as every
   other control here (one system). */
.sp-dash__select:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}

.sp-dash__current {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-3);
  font-size: 13px;
  color: var(--ms-text-2);
}

.sp-dash__current-item code {
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-dash__recommend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ms-space-2) var(--ms-space-3);
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-left: 3px solid var(--ms-color-primary);
  border-radius: 8px;
  background: var(--ms-bg-card);
}

.sp-dash__recommend--go_to_stage {
  border-left-color: var(--ms-color-danger, #c45656);
}

.sp-dash__recommend-label {
  color: var(--ms-text-3);
  font-size: 12px;
  font-weight: var(--ms-font-weight-title);
}

.sp-dash__recommend-text {
  margin: 0;
  color: var(--ms-text-1);
  flex: 1 1 auto;
}

.sp-dash__recommend-action {
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: transparent;
  padding: 4px 12px;
  color: var(--ms-color-primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

/* H4 keyboard: same ring as the H4-1 retry — one focus system across every control this view owns.
   (The detail-retry button reuses this class, so it inherits the ring here too.) */
.sp-dash__recommend-action:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}

.sp-dash__recommend-action:hover {
  background: var(--el-fill-color-light);
}

.sp-dash__state-msg {
  margin: 0 0 8px;
}

/* H4-1 retry button — mirrors the recommend-action, plus a visible focus ring (H4-2 keyboard) and a
   disabled state while a load is already in flight. */
.sp-dash__retry {
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: transparent;
  padding: 4px 12px;
  color: var(--ms-color-primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.sp-dash__retry:hover:not(:disabled) {
  background: var(--el-fill-color-light);
}

.sp-dash__retry:disabled {
  opacity: 0.5;
  cursor: default;
}

.sp-dash__retry:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}
</style>
