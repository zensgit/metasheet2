<template>
  <section
    class="sp-large-bom"
    data-testid="stock-prep-large-bom-pull"
    :data-phase="state.phase"
    role="status"
  >
    <p class="sp-large-bom__status" data-testid="stock-prep-large-bom-status">
      <strong>{{ statusText }}</strong>
      <span v-if="statusNext" class="sp-large-bom__next">{{ statusNext }}</span>
    </p>

    <p v-if="state.percent !== null" class="sp-large-bom__percent" data-testid="stock-prep-large-bom-percent">
      {{ bi(`已用展开预算 ${state.percent}%`, `${state.percent}% of the expansion budget used`) }}
    </p>

    <p v-if="state.applyCounts" class="sp-large-bom__counts" data-testid="stock-prep-large-bom-apply-counts">
      {{ appliedCountsSentence }}
    </p>

    <button
      v-if="state.phase === 'done'"
      type="button"
      class="sp-large-bom__link"
      data-testid="stock-prep-large-bom-open-multitable"
      @click="emit('open-multitable')"
    >
      {{ bi('到多维表看数据', 'Open the multitable and look at the data') }}
    </button>

    <StockPrepTechnicalDetails testid="stock-prep-large-bom-tech">
      <dl>
        <dt>{{ bi('后台展开与写入用到的路由', 'The routes the background channel drove') }}</dt>
        <dd>
          <ul>
            <li><code>{{ bi('展开任务', 'expansion job') }}</code> <code data-testid="stock-prep-large-bom-tech-job-id">{{ state.jobId ?? '—' }}</code> <code>{{ state.expansionStatus ?? '—' }}</code></li>
            <li><code>{{ bi('写入任务', 'apply job') }}</code> <code data-testid="stock-prep-large-bom-tech-apply-job-id">{{ state.applyJobId ?? '—' }}</code> <code>{{ state.applyStatus ?? '—' }}</code></li>
            <li v-if="state.errorCode"><code>{{ bi('错误码', 'error code') }}</code> <code data-testid="stock-prep-large-bom-tech-error-code">{{ state.errorCode }}</code></li>
          </ul>
        </dd>
      </dl>
    </StockPrepTechnicalDetails>
  </section>
</template>

<script setup lang="ts">
// 大 BOM 后台通道 — the panel half of largeBomPull.ts. Mounted by StockPreparationProjectSyncPanel
// ONLY when a run's 试算 SKIPped with `PLAN_LARGE_BOM_BOUNDED`; it starts driving the background
// channel as soon as it exists, because that SKIP is exactly the moment the audit found the operator
// stranded with no link, no progress and no completion signal.
//
// VALUES-FREE, same register as the parent panel: every string on screen is a status token, a count,
// or plainLanguage.ts prose keyed by one of those tokens. `open-multitable` is the SAME event the
// parent panel emits on a normal import — this component invents no new destination, because there
// is none to invent (see StockPreparationWorkspace.vue's `handleOpenMultitable` for why the sheetId
// itself is never available to route with).
import { computed, onMounted, onUnmounted, reactive } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import StockPrepTechnicalDetails from './StockPrepTechnicalDetails.vue'
import {
  createStockPreparationLargeBomJobApi,
  runStockPreparationLargeBomPull,
  type StockPreparationLargeBomJobApi,
  type StockPreparationLargeBomPullState,
} from '../../../services/integration/stockPreparation/largeBomPull'
import { STOCK_PREPARATION_PULL_BOM_ACTION_ID } from '../../../services/integration/stockPreparation/projectSync'
import type { IntegrationScope } from '../../../services/integration/workbench'
import {
  stockPrepErrorPlain,
  stockPrepLargeBomPhasePlain,
} from '../../../services/integration/stockPreparation/plainLanguage'

const props = withDefaults(
  defineProps<{
    projectNo: string
    scope?: IntegrationScope
    actionId?: string
    /** Test seam ONLY — production always builds its own client from `scope`/`actionId`. */
    api?: StockPreparationLargeBomJobApi | null
    /** Test seam ONLY — an instant resolver so specs never wait on a real timer. */
    wait?: ((ms: number) => Promise<void>) | null
    pollIntervalMs?: number
  }>(),
  { scope: () => ({}), actionId: STOCK_PREPARATION_PULL_BOM_ACTION_ID, api: null, wait: null, pollIntervalMs: 2000 },
)

const emit = defineEmits<{
  /** Identical to the parent panel's own event — the shell owns the one navigation this surface has. */
  (e: 'open-multitable'): void
}>()

const { locale } = useLocale()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const state = reactive<StockPreparationLargeBomPullState>({
  phase: 'queued',
  jobId: null,
  applyJobId: null,
  expansionStatus: null,
  applyStatus: null,
  percent: null,
  applyCounts: null,
  manualConfirmCount: 0,
  errorCode: null,
  imported: false,
})

let cancelled = false

// FAILED renders through `stockPrepErrorPlain` — the SAME lookup every other failure on this
// workbench uses (it already fails soft to the generic "did not save" sentence for a null or
// unmapped code) — never a bespoke sentence and never the raw code itself. Every other phase
// renders through the six-entry table above.
const statusText = computed<string>(() => {
  if (state.phase === 'failed') {
    const reason = stockPrepErrorPlain(state.errorCode ?? '')
    return bi(reason.zh, reason.en)
  }
  const plain = stockPrepLargeBomPhasePlain(state.phase)
  return plain ? bi(plain.zh, plain.en) : ''
})

const statusNext = computed<string>(() => {
  if (state.phase === 'failed') return ''
  const plain = stockPrepLargeBomPhasePlain(state.phase)
  return plain ? bi(plain.zhNext ?? '', plain.enNext ?? '') : ''
})

const appliedCountsSentence = computed<string>(() => {
  const counts = state.applyCounts
  if (!counts) return ''
  const parts: string[] = []
  if (counts.created > 0) parts.push(bi(`新增 ${counts.created} 行`, `${counts.created} rows added`))
  if (counts.updated > 0) parts.push(bi(`更新 ${counts.updated} 行`, `${counts.updated} rows updated`))
  if (counts.failed > 0) parts.push(bi(`${counts.failed} 行没有写成`, `${counts.failed} rows did not write`))
  if (parts.length === 0) return ''
  return bi(`已处理:${parts.join('、')}。`, `Processed so far: ${parts.join(', ')}.`)
})

onMounted(async () => {
  const api = props.api ?? createStockPreparationLargeBomJobApi(props.scope, props.actionId)
  await runStockPreparationLargeBomPull(api, props.projectNo, {
    onUpdate: (next) => Object.assign(state, next),
    wait: props.wait ?? undefined,
    pollIntervalMs: props.pollIntervalMs,
    isCancelled: () => cancelled,
  })
})

onUnmounted(() => {
  // No timer to clear directly — `runStockPreparationLargeBomPull` is one async function, not a
  // self-rescheduling setTimeout chain — but the flag stops it from making another API call or
  // another `onUpdate` after this component is gone, which is the same guarantee useAiBulkFill's
  // `pollToken` gives its own poll loop.
  cancelled = true
})
</script>

<style scoped>
.sp-large-bom {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
  margin-top: var(--ms-space-3);
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
}

.sp-large-bom__status {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  color: var(--ms-text-1);
  line-height: 1.6;
}

.sp-large-bom__next {
  color: var(--ms-text-2);
  font-size: 13px;
}

.sp-large-bom__percent,
.sp-large-bom__counts {
  margin: 0;
  color: var(--ms-text-2);
  font-size: 13px;
}

.sp-large-bom__link {
  align-self: flex-start;
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: transparent;
  padding: 4px 12px;
  color: var(--ms-color-primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.sp-large-bom__link:hover {
  background: var(--el-fill-color-light);
}

.sp-large-bom__link:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}
</style>
