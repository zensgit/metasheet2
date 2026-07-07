<template>
  <section id="int-sec-monitoring" class="integration-workbench__panel">
    <el-card shadow="never">
      <template #header>
        <div class="integration-workbench__panel-head">
          <div>
            <h2>运行监控</h2>
        <p>{{ observationSummary }}。展示最近 5 条 run（状态 / 写入 / 失败 + 行级结果）与 open dead letters（可重放），便于清洗后回看失败原因。</p>
      </div>
      <button type="button" class="integration-workbench__button" data-testid="refresh-observation" :disabled="observingPipeline" @click="refreshPipelineObservation(false)">
        {{ observingPipeline ? '刷新中' : '刷新监控' }}
      </button>
    </div>
      </template>


    <div class="integration-workbench__observation">
      <div>
        <h3>最近运行</h3>
        <div v-if="pipelineRuns.length === 0" class="integration-workbench__empty" data-testid="pipeline-runs-empty">
          <strong data-testid="pipeline-runs-empty-what">{{ bi(
            '这里展示最近的清洗流程运行记录（状态 / 读取 / 清洗 / 写入 / 失败行数）。',
            'This shows recent pipeline run records (status / rows read / cleaned / written / failed).',
          ) }}</strong>
          <p data-testid="pipeline-runs-empty-first-step">{{ bi(
            '第一步：在上方"运行与推送"区保存清洗流程后执行一次 Dry-run 或 Save-only 推送，运行记录会出现在这里。',
            'First step: save the pipeline above, then run a Dry-run or Save-only push — the run record will then appear here.',
          ) }}</p>
        </div>
        <ol v-else class="integration-workbench__record-list" data-testid="pipeline-runs">
          <li v-for="run in pipelineRuns" :key="run.id" :data-testid="`pipeline-run-${run.id}`">
            <div class="integration-workbench__run-head">
              <strong :class="`integration-workbench__run-status integration-workbench__run-status--${run.status}`" :data-testid="`run-status-${run.id}`">{{ run.status }}</strong>
              <span>{{ run.mode }}</span>
              <span v-if="run.triggeredBy">by {{ run.triggeredBy }}</span>
            </div>
            <div class="integration-workbench__run-metrics">
              <span>read {{ run.rowsRead }}</span>
              <span>clean {{ run.rowsCleaned }}</span>
              <span class="integration-workbench__run-metric--write">write {{ run.rowsWritten }}</span>
              <span class="integration-workbench__run-metric--fail">fail {{ run.rowsFailed }}</span>
              <span v-if="run.durationMs != null">{{ run.durationMs }}ms</span>
            </div>
            <small>{{ run.startedAt || run.createdAt || run.id }}<template v-if="run.finishedAt"> → {{ run.finishedAt }}</template></small>
            <p v-if="run.errorSummary" class="integration-workbench__run-error" :data-testid="`run-error-${run.id}`">{{ run.errorSummary }}</p>
            <div v-if="runRowSummaries(run).length > 0" class="integration-workbench__run-summaries">
              <button type="button" class="integration-workbench__link-button" :data-testid="`toggle-run-summaries-${run.id}`" @click="toggleRunSummaries(run.id)">
                {{ isRunExpanded(run.id) ? '收起行级结果' : `展开行级结果（${runRowSummaries(run).length}）` }}
              </button>
              <pre v-if="isRunExpanded(run.id)" :data-testid="`run-row-summaries-${run.id}`">{{ JSON.stringify(runRowSummaries(run), null, 2) }}</pre>
            </div>
          </li>
        </ol>
      </div>
      <div>
        <h3>Open Dead Letters</h3>
        <div v-if="deadLetters.length === 0" class="integration-workbench__empty" data-testid="dead-letters-empty">
          <strong data-testid="dead-letters-empty-what">{{ bi(
            'Dead letter 是清洗流程运行中未能成功写入的行，按原因分组，便于排查后再决定是否重放。',
            'Dead letters are rows that failed to write during a pipeline run, grouped by reason so you can investigate before deciding whether to replay.',
          ) }}</strong>
          <p data-testid="dead-letters-empty-first-step">{{ bi(
            '当前没有 open dead letters；出现失败行时会自动列在这里，可点击"准备 Replay"重跑。',
            'There are no open dead letters right now; failed rows will be listed here automatically, and you can click "prepare replay" to re-run them.',
          ) }}</p>
        </div>
        <ol v-else class="integration-workbench__record-list" data-testid="dead-letters">
          <li v-for="deadLetter in deadLetters" :key="deadLetter.id" :data-testid="`dead-letter-${deadLetter.id}`">
            <strong :data-testid="`dead-letter-label-${deadLetter.id}`">{{ deadLetterErrorLabel(deadLetter) }}</strong>
            <span v-if="deadLetterErrorHint(deadLetter)">{{ deadLetterErrorHint(deadLetter) }}</span>
            <small :data-testid="`dead-letter-code-${deadLetter.id}`">errorCode: {{ deadLetter.errorCode }}</small>
            <small>
              {{ deadLetter.status }} · {{ deadLetter.createdAt || deadLetter.id }}<template v-if="deadLetter.retryCount"> · retries {{ deadLetter.retryCount }}</template><template v-if="deadLetter.idempotencyKey"> · key {{ deadLetter.idempotencyKey }}</template>
            </small>
            <div class="integration-workbench__dead-letter-actions">
              <span
                :class="['integration-workbench__badge', isDeadLetterReplayable(deadLetter) ? 'integration-workbench__badge--retryable' : '']"
                :data-testid="`dead-letter-retryable-${deadLetter.id}`"
              >{{ isDeadLetterReplayable(deadLetter) ? '可重放' : '不可重放' }}</span>
              <template v-if="isDeadLetterReplayable(deadLetter)">
                <button
                  v-if="confirmReplayDeadLetterId !== deadLetter.id"
                  type="button"
                  class="integration-workbench__button integration-workbench__button--ghost"
                  :data-testid="`replay-dead-letter-${deadLetter.id}`"
                  :disabled="replayingDeadLetterId === deadLetter.id"
                  @click="requestReplay(deadLetter.id)"
                >准备 Replay</button>
                <template v-else>
                  <button
                    type="button"
                    class="integration-workbench__button integration-workbench__button--danger"
                    :data-testid="`confirm-replay-dead-letter-${deadLetter.id}`"
                    :disabled="replayingDeadLetterId === deadLetter.id"
                    @click="replayDeadLetter(deadLetter)"
                  >{{ replayingDeadLetterId === deadLetter.id ? 'Replay 中…' : '确认 Replay（会真实写入）' }}</button>
                  <button
                    type="button"
                    class="integration-workbench__link-button"
                    :data-testid="`cancel-replay-dead-letter-${deadLetter.id}`"
                    :disabled="replayingDeadLetterId === deadLetter.id"
                    @click="cancelReplay"
                  >取消</button>
                </template>
              </template>
            </div>
            <div class="integration-workbench__dead-letter-provenance">
              <button
                type="button"
                class="integration-workbench__link-button"
                :data-testid="`toggle-dead-letter-provenance-${deadLetter.id}`"
                :disabled="!canViewRowProvenance(deadLetter)"
                :title="canViewRowProvenance(deadLetter) ? '查看该行(rowId)跨 run 的写入血缘（只读）' : '该 dead letter 无 idempotency key（rowId），无法查询血缘'"
                @click="toggleDeadLetterProvenance(deadLetter)"
              >{{ isRowProvenanceExpanded(deadLetter.id) ? '收起血缘' : '查看跨-run 血缘' }}</button>
              <span
                v-if="!canViewRowProvenance(deadLetter)"
                class="integration-workbench__hint"
                :data-testid="`dead-letter-provenance-unavailable-${deadLetter.id}`"
              >无 rowId（idempotency key），不可查血缘</span>
              <div
                v-if="isRowProvenanceExpanded(deadLetter.id)"
                class="integration-workbench__provenance-timeline"
                :data-testid="`dead-letter-provenance-${deadLetter.id}`"
              >
                <div
                  v-if="isRowProvenanceLoading(deadLetter.id)"
                  class="integration-workbench__hint"
                  :data-testid="`dead-letter-provenance-loading-${deadLetter.id}`"
                >血缘加载中…</div>
                <div
                  v-else-if="rowProvenanceError(deadLetter.id)"
                  class="integration-workbench__hint integration-workbench__hint--strong"
                  :data-testid="`dead-letter-provenance-error-${deadLetter.id}`"
                >{{ rowProvenanceError(deadLetter.id) }}</div>
                <ol
                  v-else-if="rowProvenanceTimeline(deadLetter.id).length > 0"
                  class="integration-workbench__record-list"
                  :data-testid="`dead-letter-provenance-timeline-${deadLetter.id}`"
                >
                  <li
                    v-for="(entry, index) in rowProvenanceTimeline(deadLetter.id)"
                    :key="`${entry.runId}-${entry.eventIndex}`"
                    :data-testid="`provenance-entry-${deadLetter.id}-${index}`"
                  >
                    <div class="integration-workbench__provenance-event-head">
                      <strong>{{ entry.eventType }}</strong>
                      <span
                        class="integration-workbench__run-status"
                        :class="`integration-workbench__run-status--${entry.runStatus}`"
                      >run {{ entry.runStatus }}</span>
                      <span>{{ entry.runCreatedAt || entry.at }}</span>
                    </div>
                    <small>runId {{ entry.runId }} · pipeline {{ entry.pipelineId }} · {{ entry.runMode }}</small>
                    <p
                      v-if="rowProvenanceAttrsSummary(entry.attrs)"
                      class="integration-workbench__provenance-attrs"
                    >{{ rowProvenanceAttrsSummary(entry.attrs) }}</p>
                  </li>
                </ol>
                <div
                  v-else
                  class="integration-workbench__empty"
                  :data-testid="`dead-letter-provenance-empty-${deadLetter.id}`"
                >暂无血缘事件。</div>
                <p class="integration-workbench__hint">只读：仅展示脱敏后的事件，不含 payload 原文，不触发任何写入/重放。</p>
              </div>
            </div>
          </li>
        </ol>
      </div>
    </div>
    </el-card>
  </section>
</template>

<script setup lang="ts">
// IU-2b (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-2,
// stage B): extracted verbatim from IntegrationWorkbenchView.vue's `int-sec-monitoring` section
// (pure template/markup move — no state or service-call logic lives here). The parent view owns
// every ref/computed/service-call; this component only renders them and forwards user actions
// back up by calling the exact same function references it is handed as props (mirrors the
// `tr` function-prop pattern already established by IntegrationWorkbenchRail.vue in IU-2a).
import type {
  IntegrationDeadLetter,
  IntegrationPipelineRun,
  IntegrationProvenanceTimelineEntry,
  IntegrationTargetWriteSummary,
} from '../../services/integration/workbench'

defineProps<{
  observationSummary: string
  observingPipeline: boolean
  pipelineRuns: IntegrationPipelineRun[]
  deadLetters: IntegrationDeadLetter[]
  /** Bilingual copy helper — same shape as the view's local `bi(zh, en)` function. */
  bi: (zh: string, en: string) => string
  runRowSummaries: (run: IntegrationPipelineRun) => IntegrationTargetWriteSummary[]
  isRunExpanded: (runId: string) => boolean
  deadLetterErrorLabel: (deadLetter: IntegrationDeadLetter) => string
  deadLetterErrorHint: (deadLetter: IntegrationDeadLetter) => string | null
  isDeadLetterReplayable: (deadLetter: IntegrationDeadLetter) => boolean
  confirmReplayDeadLetterId: string
  replayingDeadLetterId: string
  canViewRowProvenance: (deadLetter: IntegrationDeadLetter) => boolean
  isRowProvenanceExpanded: (deadLetterId: string) => boolean
  isRowProvenanceLoading: (deadLetterId: string) => boolean
  rowProvenanceError: (deadLetterId: string) => string
  rowProvenanceTimeline: (deadLetterId: string) => IntegrationProvenanceTimelineEntry[]
  rowProvenanceAttrsSummary: (attrs: Record<string, unknown> | undefined) => string
  refreshPipelineObservation: (silent?: boolean) => Promise<void>
  toggleRunSummaries: (runId: string) => void
  requestReplay: (deadLetterId: string) => void
  cancelReplay: () => void
  replayDeadLetter: (deadLetter: IntegrationDeadLetter) => Promise<void>
  toggleDeadLetterProvenance: (deadLetter: IntegrationDeadLetter) => Promise<void>
}>()
</script>

<style scoped>
/* Verbatim copies of the rules in IntegrationWorkbenchView.vue's <style scoped> block that
   target markup now rendered by this component. Duplication (not relocation) is intentional:
   Vue's scoped CSS only reaches a component's OWN template output, not a child component's
   inner DOM, so classes shared with sections still living in the parent (e.g. `__button`,
   `__hint`, `__panel`) must keep their rule in the parent AND get a copy here. Selectors that
   have an ancestor class outside this component's own root (e.g. `.integration-workbench h3`,
   `.integration-workbench pre`) still work: Vue's scoped-css compiler only appends the
   `[data-v-hash]` attribute to the rightmost compound selector, so the unscoped ancestor part
   keeps matching the real DOM regardless of which component rendered it. */
.integration-workbench h3 {
  margin: 0 0 10px;
  font-size: 14px;
}

.integration-workbench pre {
  min-height: 260px;
  max-height: 420px;
  overflow: auto;
  margin: 12px 0 0;
  padding: 12px;
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: var(--ms-text-1);
  color: var(--el-color-primary-light-9);
  font-size: 12px;
  line-height: 1.5;
}

.integration-workbench__panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.integration-workbench__panel p {
  margin: 8px 0 0;
  color: var(--ms-text-2);
  line-height: 1.5;
}

.integration-workbench__button,
.integration-workbench__icon-button {
  border: 1px solid var(--ms-border);
  border-radius: 6px;
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  cursor: pointer;
  font-weight: 700;
  text-decoration: none;
}

.integration-workbench__button {
  padding: 8px 12px;
}

.integration-workbench__button:hover,
.integration-workbench__icon-button:hover {
  border-color: var(--ms-color-primary);
}

.integration-workbench__button:disabled,
.integration-workbench__icon-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.integration-workbench__button--danger {
  border-color: var(--el-color-danger-light-3);
  color: var(--el-color-danger);
}

.integration-workbench__panel {
  margin-bottom: 16px;
  padding: 16px;
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-card);
}

.integration-workbench__hint {
  margin-top: 10px;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.5;
}

.integration-workbench__hint--strong {
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning-dark-2);
}

.integration-workbench__badge {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  padding: 5px 8px;
  border-radius: 999px;
  background: var(--el-fill-color-light);
  color: var(--ms-text-2);
  font-size: 12px;
  font-weight: 700;
}

.integration-workbench__badge--retryable {
  background: var(--el-color-success-light-9);
  color: var(--el-color-success-dark-2);
}

.integration-workbench__observation {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-top: 14px;
}

.integration-workbench__empty {
  padding: 12px;
  border: 1px dashed var(--ms-border);
  border-radius: 6px;
  color: var(--ms-text-2);
}

.integration-workbench__empty strong {
  color: var(--ms-text-1);
}

.integration-workbench__empty p {
  margin: 6px 0 0;
}

.integration-workbench__record-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.integration-workbench__record-list li {
  display: grid;
  gap: 4px;
  padding: 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--ms-bg-page);
}

.integration-workbench__record-list small {
  color: var(--ms-text-2);
}

.integration-workbench__run-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.integration-workbench__run-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  color: var(--ms-text-2);
}

.integration-workbench__run-metric--write {
  color: var(--el-color-success-dark-2);
  font-weight: 600;
}

.integration-workbench__run-metric--fail {
  color: var(--el-color-danger);
  font-weight: 600;
}

.integration-workbench__run-status {
  text-transform: uppercase;
  font-size: 11px;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--el-color-primary-light-9);
  color: var(--ms-text-1);
}

.integration-workbench__run-error {
  margin: 0;
  font-size: 12px;
  color: var(--el-color-danger);
}

.integration-workbench__run-summaries {
  display: grid;
  gap: 4px;
}

/* Inline row-level results: override the global tall/dark `pre` so each
   expanded run stays compact within the record list. */
.integration-workbench__run-summaries pre {
  min-height: 0;
  max-height: 200px;
  margin: 4px 0 0;
}

.integration-workbench__dead-letter-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

/* DF-N2-3 (read-only): cross-run provenance timeline (per dead-letter row). */
.integration-workbench__dead-letter-provenance {
  margin-top: 6px;
  display: grid;
  gap: 4px;
}

.integration-workbench__provenance-timeline {
  display: grid;
  gap: 6px;
  padding: 6px 0 0;
}

.integration-workbench__provenance-event-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.integration-workbench__provenance-attrs {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--ms-text-2);
  word-break: break-word;
}

.integration-workbench__button--ghost {
  background: transparent;
}

.integration-workbench__link-button {
  border: none;
  background: none;
  padding: 0;
  color: var(--ms-color-primary);
  cursor: pointer;
  font: inherit;
  text-decoration: underline;
}

.integration-workbench__link-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

@media (max-width: 900px) {
  .integration-workbench__panel-head,
  .integration-workbench__observation {
    grid-template-columns: 1fr;
  }

  .integration-workbench__panel-head {
    display: grid;
  }
}
</style>
