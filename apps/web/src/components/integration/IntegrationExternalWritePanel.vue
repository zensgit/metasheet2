<template>
  <div class="integration-workbench__table-action" data-testid="external-write-panel">
    <div class="integration-workbench__panel-head">
      <div>
        <h3>外部写入 C6</h3>
        <p>先 dry-run 复核计数，再用一次性 token apply；浏览器不提供 source、target、plan、payload 或 sheet scope。</p>
      </div>
      <span class="integration-workbench__badge" data-testid="external-write-permission-note">dry-run=read · apply=write/admin</span>
    </div>
    <p class="integration-workbench__hint" data-testid="external-write-boundary">
      仅展示 status/count/error token；dry-run token 只保存在内存中，不显示、不复制到证据。
    </p>
    <div class="integration-workbench__actions">
      <button
        type="button"
        class="integration-workbench__button"
        data-testid="external-write-dry-run"
        :disabled="!externalWriteCanDryRun"
        @click="dryRunExternalWrite"
      >
        {{ runningExternalWrite === 'dry-run' ? '外部写 dry-run 中' : '外部写 dry-run' }}
      </button>
      <button
        type="button"
        class="integration-workbench__button integration-workbench__button--danger"
        data-testid="external-write-apply"
        :disabled="!externalWriteCanApply"
        @click="applyExternalWrite"
      >
        {{ runningExternalWrite === 'apply' ? '外部写 apply 中' : 'Apply external write' }}
      </button>
    </div>
    <div v-if="externalWriteDryRunResult" class="integration-workbench__table-action-review" data-testid="external-write-review">
      <strong>{{ externalWriteReviewSummary }}</strong>
      <div class="integration-workbench__metric-row">
        <span v-for="metric in externalWriteDryRunMetrics" :key="metric.id">{{ metric.label }} {{ metric.value }}</span>
      </div>
      <p class="integration-workbench__hint" data-testid="external-write-token-state">
        {{ externalWriteDryRunToken ? 'token 已签发（隐藏）' : '未签发可 apply token' }}
      </p>
      <label class="integration-workbench__inline-check">
        <input v-model="externalWriteAcceptReview" type="checkbox" data-testid="external-write-accept-review" />
        <span>我已复核 dry-run counts / status / error token；apply 将使用本次 dry-run token，服务端会重新计算并校验 revision。</span>
      </label>
      <pre v-if="externalWriteEvidenceText" data-testid="external-write-evidence">{{ externalWriteEvidenceText }}</pre>
    </div>
    <div v-if="externalWriteApplyResult" class="integration-workbench__table-action-review" data-testid="external-write-apply-result">
      <strong>apply {{ externalWriteApplyResult.status || 'unknown' }}</strong>
      <div class="integration-workbench__metric-row">
        <span v-for="metric in externalWriteApplyMetrics" :key="metric.id">{{ metric.label }} {{ metric.value }}</span>
      </div>
      <p v-if="externalWriteApplyRunId" class="integration-workbench__hint">run {{ externalWriteApplyRunId }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
// IU-2d (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-2,
// stage D — `int-sec-run-push` decomposition): external-write C6 dry-run/apply panel, one of five
// focused sub-panels the prior monolithic `int-sec-run-push` section bundled. Pure template/
// markup move — no state or service-call logic lives here. Unlike the stock-prep and
// field-option-sync panels, this block was never gated by a root `v-if` (the dry-run/apply
// buttons are individually disabled via `externalWriteCanDryRun`/`externalWriteCanApply`, which
// already incorporate the `integration:write`/`integration:admin` checks) — so it renders
// unconditionally here too, matching the pre-extraction markup exactly. This panel's
// `data-testid="external-write-panel"` is also a documented "mount anchor" other specs query
// against — the wrapping element/testid stays exactly where it was.
import type {
  IntegrationExternalWriteApplyResult,
  IntegrationExternalWriteDryRunResult,
} from '../../services/integration/workbench'
import type { MetricRow } from './integrationWorkbenchSectionTypes'

defineProps<{
  externalWriteCanDryRun: boolean
  runningExternalWrite: 'dry-run' | 'apply' | ''
  externalWriteCanApply: boolean
  externalWriteDryRunResult: IntegrationExternalWriteDryRunResult | null
  externalWriteReviewSummary: string
  externalWriteDryRunMetrics: MetricRow[]
  externalWriteDryRunToken: string
  externalWriteEvidenceText: string
  externalWriteApplyResult: IntegrationExternalWriteApplyResult | null
  externalWriteApplyMetrics: MetricRow[]
  externalWriteApplyRunId: string
  dryRunExternalWrite: () => Promise<void>
  applyExternalWrite: () => Promise<void>
}>()

const externalWriteAcceptReview = defineModel<boolean>('externalWriteAcceptReview', { default: false })
</script>

<style scoped>
/* Verbatim copies (selectively trimmed to the tags/classes this component actually renders) of
   the rules in IntegrationWorkbenchView.vue's <style scoped> block that target this markup. */
.integration-workbench__table-action {
  margin: 16px 0;
  padding: 14px;
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
}

.integration-workbench__table-action h3 {
  margin: 0 0 4px;
  font-size: 16px;
}

.integration-workbench__table-action p {
  margin: 0;
}

.integration-workbench__panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
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

.integration-workbench__hint {
  margin-top: 10px;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.5;
}

.integration-workbench__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 14px;
}

.integration-workbench__button {
  border: 1px solid var(--ms-border);
  border-radius: 6px;
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  cursor: pointer;
  font-weight: 700;
  text-decoration: none;
  padding: 8px 12px;
}

.integration-workbench__button:hover {
  border-color: var(--ms-color-primary);
}

.integration-workbench__button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.integration-workbench__button--danger {
  border-color: var(--el-color-danger-light-3);
  color: var(--el-color-danger);
}

.integration-workbench__table-action-review {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.integration-workbench__metric-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.integration-workbench__metric-row span {
  display: inline-flex;
  color: var(--ms-text-2);
  font-size: 12px;
}

.integration-workbench__inline-check {
  display: flex;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}

.integration-workbench__inline-check input {
  width: auto;
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

@media (max-width: 900px) {
  .integration-workbench__panel-head {
    grid-template-columns: 1fr;
  }

  .integration-workbench__panel-head {
    display: grid;
  }
}
</style>
