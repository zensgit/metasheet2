<template>
  <div v-if="hasIntegrationAdmin" class="integration-workbench__table-action" data-testid="stock-preparation-s1-panel">
    <div class="integration-workbench__panel-head">
      <div>
        <h3>标准备料表 S1</h3>
        <p>创建或绑定 `plm.stock-preparation.main.v1` 标准备料表，并检查目标 readiness；本步骤只处理元数据。</p>
      </div>
      <span class="integration-workbench__badge">admin · metadata-only</span>
    </div>
    <div class="integration-workbench__grid integration-workbench__grid--compact">
      <label>
        <span>目标 baseId（可选，仅创建/绑定时使用）</span>
        <input v-model="stockPreparationTargetBaseId" data-testid="stock-preparation-s1-base-id" :disabled="stockPreparationTargetRunning !== ''" placeholder="创建或绑定时可填写目标 baseId；readiness 检查针对已绑定目标，不受此输入影响" />
      </label>
    </div>
    <p class="integration-workbench__hint" data-testid="stock-preparation-s1-boundary">
      只调用 target readiness / ensure；不读取 PLM，不写业务行，不执行 table action，不触发 Apply，不调用 K3 Save / Submit / Audit / BOM write。
    </p>
    <div class="integration-workbench__actions">
      <button
        type="button"
        class="integration-workbench__button"
        data-testid="stock-preparation-s1-readiness"
        :disabled="stockPreparationTargetRunning !== ''"
        @click="checkStockPreparationTargetReadiness"
      >
        {{ stockPreparationTargetRunning === 'readiness' ? '检查中' : '检查 readiness' }}
      </button>
      <button
        type="button"
        class="integration-workbench__button"
        data-testid="stock-preparation-s1-ensure"
        :disabled="stockPreparationTargetRunning !== ''"
        @click="ensureStockPreparationTarget"
      >
        {{ stockPreparationTargetRunning === 'ensure' ? '处理中' : '创建或绑定标准表' }}
      </button>
    </div>
    <div v-if="stockPreparationTargetResult" class="integration-workbench__table-action-review" data-testid="stock-preparation-s1-result">
      <strong>{{ stockPreparationTargetSummary }}</strong>
      <div class="integration-workbench__metric-row" data-testid="stock-preparation-s1-metrics">
        <span v-for="metric in stockPreparationTargetMetrics" :key="metric.id">{{ metric.label }} {{ metric.value }}</span>
      </div>
      <p class="integration-workbench__hint" data-testid="stock-preparation-s1-token-state">
        target binding 仅用于当前租户运行时；公开证据只贴 readiness status / mode / counts / missingFields。
      </p>
      <pre v-if="stockPreparationTargetEvidenceText" data-testid="stock-preparation-s1-evidence">{{ stockPreparationTargetEvidenceText }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
// IU-2d (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-2,
// stage D — `int-sec-run-push` decomposition): stock-preparation S1 admin panel, one of five
// focused sub-panels the prior monolithic `int-sec-run-push` section bundled. Pure template/
// markup move — no state or service-call logic lives here.
//
// The `integration:admin` permission gate stays on this block's own root `v-if` exactly where the
// pre-extraction markup had it, driven by the `hasIntegrationAdmin` prop — the parent passes the
// byte-identical expression (`:has-integration-admin="auth.hasPermission('integration:admin')"`),
// so gate behavior is unchanged: when the check fails this root div renders nothing and none of
// this panel's data-testids exist in the DOM — the exact assertion
// `apps/web/tests/IntegrationWorkbenchView.spec.ts` checks for the unauthorized case, plus the
// component-level negative in `IntegrationStockPrepPanel.spec.ts`.
import type { IntegrationStockPreparationTargetReadinessResult } from '../../services/integration/workbench'
import type { MetricRow } from './integrationWorkbenchSectionTypes'

defineProps<{
  hasIntegrationAdmin: boolean
  stockPreparationTargetRunning: 'readiness' | 'ensure' | ''
  stockPreparationTargetResult: IntegrationStockPreparationTargetReadinessResult | null
  stockPreparationTargetSummary: string
  stockPreparationTargetMetrics: MetricRow[]
  stockPreparationTargetEvidenceText: string
  checkStockPreparationTargetReadiness: () => Promise<void>
  ensureStockPreparationTarget: () => Promise<void>
}>()

const stockPreparationTargetBaseId = defineModel<string>('stockPreparationTargetBaseId', { default: '' })
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

.integration-workbench label {
  display: grid;
  gap: 6px;
  color: var(--ms-text-1);
  font-size: 13px;
  font-weight: 700;
}

.integration-workbench input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--ms-border);
  border-radius: 6px;
  padding: 8px 10px;
  color: var(--ms-text-1);
  font: inherit;
}

.integration-workbench__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-top: 16px;
}

.integration-workbench__grid--compact {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
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
  .integration-workbench__panel-head,
  .integration-workbench__grid {
    grid-template-columns: 1fr;
  }

  .integration-workbench__panel-head {
    display: grid;
  }
}
</style>
