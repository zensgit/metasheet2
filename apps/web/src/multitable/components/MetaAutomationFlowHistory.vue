<template>
  <section v-if="canLoad" class="meta-flow-history" data-flow-history="true">
    <div class="meta-flow-history__head">
      <span class="meta-flow-history__title">{{ l('flowHistory.title') }}</span>
      <span v-if="!loading && !loadFailed && rows.length" class="meta-flow-history__count" data-flow-history-count="true">{{ rows.length }}</span>
    </div>
    <p class="meta-flow-history__hint">{{ l('flowHistory.hint') }}</p>

    <div v-if="loading" class="meta-flow-history__state" data-flow-history-loading="true">{{ l('flowHistory.loading') }}</div>
    <div v-else-if="loadFailed" class="meta-flow-history__state meta-flow-history__state--error" data-flow-history-error="true" role="alert">
      <span>{{ l('flowHistory.loadFailed') }}</span>
      <button type="button" class="meta-flow-history__link" data-flow-history-retry="true" @click="load">{{ l('flowHistory.retry') }}</button>
    </div>
    <div v-else-if="rows.length === 0" class="meta-flow-history__state" data-flow-history-empty="true">{{ l('flowHistory.empty') }}</div>
    <div v-else class="meta-flow-history__list">
      <button
        v-for="row in rows"
        :key="row.id"
        type="button"
        class="meta-flow-history__row"
        :class="{ 'meta-flow-history__row--selected': selectedId === row.id }"
        :data-flow-history-run="row.id"
        :data-status="row.status"
        :aria-pressed="selectedId === row.id"
        @click="select(row.id)"
      >
        <span class="meta-flow-history__time" data-flow-history-time="true">{{ row.time }}</span>
        <span class="meta-flow-history__badge" :class="`meta-flow-history__badge--${row.status}`" data-flow-history-status="true">{{ statusLabel(row.status) }}</span>
        <span class="meta-flow-history__by" data-flow-history-by="true">{{ l('flowHistory.triggeredBy') }}: {{ row.triggeredBy || '-' }}</span>
        <span class="meta-flow-history__counts" data-flow-history-counts="true">{{ countsText(row.counts) }}</span>
      </button>
    </div>

    <div v-if="overlay" class="meta-flow-history__note" :class="`meta-flow-history__note--${overlay.kind}`" :data-flow-history-overlay="overlay.kind">
      <span>{{ overlayText }}</span>
      <button type="button" class="meta-flow-history__link" data-flow-history-clear="true" @click="select(null)">{{ l('flowHistory.clear') }}</button>
    </div>
  </section>
</template>

<script setup lang="ts">
// Integration assistant stage 1d (register R-99 ③): the flow view's 「最近执行」. Reads the rule's recent runs
// through the run log's own client call (getAutomationLogs — no new endpoint) and shows time / status /
// triggeredBy / step counts. Picking a run emits a per-step STATUS overlay for the flow's step cards, only when
// automationFlowHistory.matchExecutionToFlow can match it without guessing. Read-only: no write, no retry, no
// test run. Values-free: step output, step error and execution error are never read or rendered here.
import { computed, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { MultitableApiClient } from '../api/client'
import type { AutomationExecution, AutomationRule } from '../types'
import {
  FLOW_HISTORY_LIMIT,
  flowHistoryRow,
  matchExecutionToFlow,
  type FlowHistoryRow,
  type FlowHistoryStepCounts,
  type FlowStepOverlay,
} from '../automationFlowHistory'
import { automationLabel, automationStatusLabel, type AutomationLabelKey } from '../utils/meta-automation-labels'

const props = defineProps<{
  visible: boolean
  rule: AutomationRule | null
  sheetId?: string
  client?: MultitableApiClient
}>()

const emit = defineEmits<{ (e: 'overlay', overlay: FlowStepOverlay | null): void }>()

const { isZh } = useLocale()

function l(key: AutomationLabelKey): string {
  return automationLabel(key, isZh.value)
}

const loading = ref(false)
const loadFailed = ref(false)
const executions = ref<AutomationExecution[]>([])
const selectedId = ref<string | null>(null)
let generation = 0

const ruleId = computed(() => props.rule?.id ?? '')
const canLoad = computed(() => !!props.client && !!props.sheetId && !!ruleId.value)
const rows = computed<FlowHistoryRow[]>(() => executions.value.map(flowHistoryRow))

const overlay = computed<FlowStepOverlay | null>(() => {
  if (!selectedId.value || !props.rule) return null
  const execution = executions.value.find((entry) => String(entry.id) === selectedId.value)
  return execution ? matchExecutionToFlow(props.rule, execution) : null
})

const overlayText = computed(() => {
  switch (overlay.value?.kind) {
    case 'matched': return l('flowHistory.overlayShown')
    case 'no_steps': return l('flowHistory.noSteps')
    case 'rule_changed': return l('flowHistory.ruleChanged')
    default: return ''
  }
})

watch(overlay, (next) => emit('overlay', next), { immediate: true })

function select(id: string | null): void {
  selectedId.value = id === null || selectedId.value === id ? null : id
}

function statusLabel(status: string): string {
  return automationStatusLabel(status, isZh.value)
}

const STEP_STATUS_KEYS = {
  success: 'flowHistory.stepStatus.success',
  failed: 'flowHistory.stepStatus.failed',
  skipped: 'flowHistory.stepStatus.skipped',
  simulated: 'flowHistory.stepStatus.simulated',
} as const satisfies Record<string, AutomationLabelKey>

function countsText(counts: FlowHistoryStepCounts): string {
  const parts = [l('flowHistory.stepTotal').replace('{n}', String(counts.total))]
  for (const status of ['success', 'failed', 'skipped', 'simulated'] as const) {
    if (counts[status] > 0) parts.push(`${l(STEP_STATUS_KEYS[status])} ${counts[status]}`)
  }
  return parts.join(' · ')
}

async function load(): Promise<void> {
  const client = props.client
  const sheetId = props.sheetId
  const id = ruleId.value
  generation += 1
  const mine = generation
  selectedId.value = null
  if (!client || !sheetId || !id) {
    executions.value = []
    loading.value = false
    loadFailed.value = false
    return
  }
  loading.value = true
  loadFailed.value = false
  try {
    const result = await client.getAutomationLogs(sheetId, id, FLOW_HISTORY_LIMIT)
    if (mine !== generation) return
    executions.value = Array.isArray(result) ? result : []
  } catch {
    // Values-free: a fixed sentence and a retry — the failure text (which can carry server detail) is not shown.
    if (mine !== generation) return
    executions.value = []
    loadFailed.value = true
  } finally {
    if (mine === generation) loading.value = false
  }
}

watch(
  () => [props.visible, ruleId.value, props.sheetId, props.client] as const,
  ([visible]) => {
    if (visible) void load()
    else {
      generation += 1
      selectedId.value = null
    }
  },
  { immediate: true },
)
</script>

<style scoped>
/* 1d: design tokens only (apps/web/src/styles/tokens.css) — no hex / rgb literals (UI foundation style guard). */
.meta-flow-history {
  margin-top: 14px;
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-lg);
  background: var(--ms-bg-card);
  padding: 10px 12px;
}

.meta-flow-history__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.meta-flow-history__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ms-text-1);
}

.meta-flow-history__count {
  font-size: 11px;
  border-radius: 999px;
  padding: 0 7px;
  border: 1px solid var(--ms-border);
  color: var(--ms-text-3);
}

.meta-flow-history__hint {
  margin: 4px 0 8px;
  font-size: 12px;
  color: var(--ms-text-3);
}

.meta-flow-history__state {
  font-size: 12px;
  color: var(--ms-text-3);
  padding: 6px 0;
}

.meta-flow-history__state--error {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ms-color-danger);
}

.meta-flow-history__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 220px;
  overflow: auto;
}

.meta-flow-history__row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  width: 100%;
  box-sizing: border-box;
  text-align: left;
  font: inherit;
  font-size: 12px;
  color: var(--ms-text-2);
  background: transparent;
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-md);
  padding: 5px 8px;
  cursor: pointer;
}

.meta-flow-history__row:hover { border-color: var(--ms-border); }

.meta-flow-history__row--selected {
  border-color: var(--ms-color-primary);
  color: var(--ms-text-1);
}

.meta-flow-history__time { font-variant-numeric: tabular-nums; }

.meta-flow-history__badge {
  font-size: 11px;
  border-radius: var(--ms-radius-sm);
  padding: 0 6px;
  border: 1px solid var(--ms-border);
  color: var(--ms-text-2);
}

.meta-flow-history__badge--success { border-color: var(--ms-color-success); color: var(--ms-color-success); }
.meta-flow-history__badge--failed { border-color: var(--ms-color-danger); color: var(--ms-color-danger); }
.meta-flow-history__badge--skipped { border-color: var(--ms-color-info); color: var(--ms-color-info); }
.meta-flow-history__badge--running { border-color: var(--ms-color-warning); color: var(--ms-color-warning); }

.meta-flow-history__by,
.meta-flow-history__counts { color: var(--ms-text-3); }

.meta-flow-history__counts { margin-left: auto; }

.meta-flow-history__note {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--ms-text-2);
}

.meta-flow-history__note--rule_changed,
.meta-flow-history__note--no_steps { color: var(--ms-color-warning); }

.meta-flow-history__link {
  font: inherit;
  font-size: 12px;
  border: 0;
  background: transparent;
  color: var(--ms-color-primary);
  cursor: pointer;
  padding: 0;
}
</style>
