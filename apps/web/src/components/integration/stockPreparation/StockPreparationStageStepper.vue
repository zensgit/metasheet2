<template>
  <div class="sp-stage" data-testid="stock-prep-stage-stepper">
    <p
      v-if="loading"
      class="sp-stage__state sp-stage__state--muted"
      data-testid="stock-prep-stage-loading"
      role="status"
    >
      {{ bi('正在加载阶段概览…', 'Loading stage overview…') }}
    </p>

    <p
      v-else-if="errored"
      class="sp-stage__state sp-stage__state--muted"
      data-testid="stock-prep-stage-error"
      role="status"
    >
      {{ bi('同步后端尚未就绪,稍后再试。', 'Backend read not ready yet — try again later.') }}
    </p>

    <ol v-else class="sp-stage__list" data-testid="stock-prep-stage-list">
      <li
        v-for="stage in orderedStages"
        :key="stage.key"
        class="sp-stage__item"
        :class="`sp-stage__item--${stage.status}`"
        data-testid="stock-prep-stage-item"
        :data-stage="stage.key"
        :data-status="stage.status"
      >
        <button
          type="button"
          class="sp-stage__button"
          :data-testid="`stock-prep-stage-nav-${stage.key}`"
          @click="emit('navigate', stage.key)"
        >
          <span class="sp-stage__label">{{ bi(STAGE_LABELS[stage.key].zh, STAGE_LABELS[stage.key].en) }}</span>
          <span
            class="sp-stage__status-badge"
            :data-testid="`stock-prep-stage-status-${stage.key}`"
          >{{ bi(STATUS_LABELS[stage.status].zh, STATUS_LABELS[stage.status].en) }}</span>

          <span v-if="stage.status === 'forbidden'" class="sp-stage__forbidden" :data-testid="`stock-prep-stage-forbidden-${stage.key}`">
            {{ bi('需要管理员权限查看详情', 'Requires admin access to view detail') }}
          </span>
          <template v-else>
            <span class="sp-stage__metric" :data-testid="`stock-prep-stage-count-${stage.key}`">
              {{ bi('数量', 'Count') }}: {{ stage.count ?? '—' }}
            </span>
            <span
              v-if="stage.blockingCount !== null"
              class="sp-stage__metric sp-stage__metric--blocking"
              :class="{ 'sp-stage__metric--warn': stage.blockingCount > 0 }"
              :data-testid="`stock-prep-stage-blocking-${stage.key}`"
            >
              {{ bi('阻断', 'Blocking') }}: {{ stage.blockingCount }}
            </span>
          </template>

          <span
            v-if="stage.caveat"
            class="sp-stage__caveat"
            :data-testid="`stock-prep-stage-caveat-${stage.key}`"
            :title="bi(CAVEAT_LABELS[stage.caveat].zhTitle, CAVEAT_LABELS[stage.caveat].enTitle)"
          >
            {{ bi(CAVEAT_LABELS[stage.caveat].zh, CAVEAT_LABELS[stage.caveat].en) }}
          </span>
        </button>
      </li>
    </ol>
  </div>
</template>

<script setup lang="ts">
// Stock Preparation UI humanization H2 (H0 plane-boundary design-lock #4202 — PLANE A ONLY): the
// six-stage progress stepper (provision -> sync -> map -> unit -> generate -> exception). Pure
// PRESENTATIONAL component — it fetches nothing itself; the parent (StockPreparationDashboardView)
// owns every read and hands this component the already-derived StockPreparationStageMetric[] plus
// coarse loading/errored flags. Clicking a stage emits its STAGE KEY (not a view key) so the single
// stage->view mapping lives in ONE place (stageOverview.ts STOCK_PREPARATION_STAGE_VIEW_KEY) — the
// parent translates that into the shell's existing activeKey tab-switch, so this widget is a SATELLITE
// of the shell's one navigation surface, never a second one.
//
// VALUES-FREE: the template reads a fixed whitelist — stage key (a closed enum), FE-derived status
// enum, counts, and a closed caveat enum. It never renders a business value; a stage's `count` /
// `blockingCount` are the same values-free integers the six existing views already display.
import { computed } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import {
  STOCK_PREPARATION_STAGE_KEYS,
  type StockPreparationStageCaveat,
  type StockPreparationStageKey,
  type StockPreparationStageMetric,
  type StockPreparationStageStatus,
} from '../../../services/integration/stockPreparation/stageOverview'

const props = defineProps<{
  stages: StockPreparationStageMetric[]
  loading: boolean
  errored: boolean
}>()

const emit = defineEmits<{
  (e: 'navigate', stage: StockPreparationStageKey): void
}>()

const { locale } = useLocale()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

// Always render all six stage slots in canonical pipeline order, even if the parent's array is
// partial (a stage the parent hasn't computed yet falls back to an 'unknown' placeholder row rather
// than silently disappearing — the operator should always see there ARE six phases).
const orderedStages = computed<StockPreparationStageMetric[]>(() => {
  const byKey = new Map(props.stages.map((stage) => [stage.key, stage]))
  return STOCK_PREPARATION_STAGE_KEYS.map(
    (key) => byKey.get(key) ?? { key, status: 'unknown' as StockPreparationStageStatus, count: null, blockingCount: null },
  )
})

const STAGE_LABELS: Record<StockPreparationStageKey, { zh: string; en: string }> = {
  provision: { zh: '选定项目', en: 'Provision' },
  sync: { zh: '同步快照', en: 'Sync' },
  map: { zh: '映射确认', en: 'Map' },
  unit: { zh: '单位确认', en: 'Unit' },
  generate: { zh: '生成备料行', en: 'Generate' },
  exception: { zh: '异常队列', en: 'Exception' },
}

const STATUS_LABELS: Record<StockPreparationStageStatus, { zh: string; en: string }> = {
  not_started: { zh: '尚未开始', en: 'Not started' },
  pending: { zh: '待选择', en: 'Pending' },
  blocked: { zh: '有阻断', en: 'Blocked' },
  clear: { zh: '正常', en: 'Clear' },
  forbidden: { zh: '权限不足', en: 'Forbidden' },
  unknown: { zh: '未知', en: 'Unknown' },
}

const CAVEAT_LABELS: Record<StockPreparationStageCaveat, { zh: string; en: string; zhTitle: string; enTitle: string }> = {
  tenant_wide: {
    zh: '(租户级,非本项目专属)',
    en: '(tenant-wide, not project-specific)',
    zhTitle: '物料映射为租户级、跨项目复用资产,此计数覆盖当前租户全部映射,不按已选项目过滤。',
    enTitle: 'Material mappings are a tenant-level, cross-project asset — this count covers the whole tenant, not filtered to the selected project.',
  },
  display_only: {
    zh: '(展示口径,非生成闸判定值)',
    en: '(display only, not the generation gate)',
    zhTitle: '当前为读取时的展示计数,并非生成闸实际执行的判定值;生成时服务端会基于全量重新计算真实值。',
    enTitle: 'A read-time display figure — not the value the generation gate enforces; the server recomputes it from the full set when generation runs.',
  },
}
</script>

<style scoped>
.sp-stage {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
}

.sp-stage__state {
  margin: 0;
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
  line-height: 1.6;
}

.sp-stage__state--muted {
  color: var(--ms-text-3);
}

.sp-stage__list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.sp-stage__item {
  flex: 1 1 150px;
  min-width: 150px;
}

.sp-stage__button {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  width: 100%;
  border: 1px solid var(--ms-border-light);
  border-left: 3px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
  padding: var(--ms-space-2) var(--ms-space-3);
  color: var(--ms-text-1);
  font: inherit;
  cursor: pointer;
  text-align: left;
}

.sp-stage__button:hover {
  background: var(--el-fill-color-light);
}

.sp-stage__item--blocked .sp-stage__button {
  border-left-color: var(--ms-color-danger, #c45656);
}

.sp-stage__item--clear .sp-stage__button {
  border-left-color: var(--ms-color-primary);
}

.sp-stage__item--forbidden .sp-stage__button,
.sp-stage__item--unknown .sp-stage__button {
  border-left-color: var(--ms-text-3);
}

.sp-stage__label {
  font-weight: var(--ms-font-weight-title);
  color: var(--ms-text-1);
}

.sp-stage__status-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--el-fill-color-light);
  color: var(--ms-text-2);
  font-size: 12px;
}

.sp-stage__metric {
  color: var(--ms-text-2);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.sp-stage__metric--warn {
  color: var(--ms-color-danger, #c45656);
  font-weight: var(--ms-font-weight-title);
}

.sp-stage__forbidden {
  color: var(--ms-text-3);
  font-size: 12px;
  font-style: italic;
}

.sp-stage__caveat {
  color: var(--ms-text-3);
  font-size: 11px;
  font-style: italic;
}
</style>
