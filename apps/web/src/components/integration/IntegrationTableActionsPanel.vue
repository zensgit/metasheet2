<template>
  <div class="integration-workbench__table-action" data-testid="table-action-panel">
    <div class="integration-workbench__panel-head">
      <div>
        <h3>参数化表动作</h3>
        <p>面向已由管理员配置的安全动作。浏览器只填写 allowlist 参数；来源、目标表和写入计划由服务端决定。</p>
      </div>
      <span class="integration-workbench__badge" data-testid="table-action-permission-note">dry-run=read · apply=write/admin</span>
    </div>
    <div v-if="tableActions.length === 0" class="integration-workbench__empty" data-testid="table-action-empty">
      <strong data-testid="table-action-empty-what">{{ bi(
        '参数化表动作是管理员预先配置好的安全写入操作，浏览器只填 allowlist 参数，来源/目标由服务端决定。',
        'Parameterized table actions are safe write operations pre-configured by an admin — the browser only fills allowlisted parameters; source/target are decided server-side.',
      ) }}</strong>
      <p data-testid="table-action-empty-first-step">{{ bi(
        '当前部署没有暴露表动作；如需要，请联系管理员在后端配置。',
        'This deployment does not expose any table actions; contact an admin to configure one on the backend if needed.',
      ) }}</p>
    </div>
    <template v-else>
      <div class="integration-workbench__grid integration-workbench__grid--compact">
        <label>
          <span>动作</span>
          <select v-model="selectedTableActionId" data-testid="table-action-id">
            <option v-for="action in tableActions" :key="action.actionId" :value="action.actionId">
              {{ tableActionOptionLabel(action) }} · {{ action.configured ? '已配置' : '未配置' }}
            </option>
          </select>
        </label>
        <label>
          <span>项目号 projectNo</span>
          <input v-model="tableActionProjectNo" data-testid="table-action-project-no" placeholder="例如 P2026-001" />
        </label>
      </div>
      <p class="integration-workbench__hint" data-testid="table-action-boundary">
        不提供 raw SQL、source/object、sheetId、C3 plan 或 C4 payload 输入；apply 会用 dry-run token 触发服务端重新计算。
      </p>
      <p v-if="tableActionDisplayContextItems.length" class="integration-workbench__hint" data-testid="table-action-display-context">
        {{ tableActionDisplayContextItems.join(' · ') }}
      </p>
      <div class="integration-workbench__actions">
        <button
          type="button"
          class="integration-workbench__button"
          data-testid="table-action-dry-run"
          :disabled="!tableActionCanDryRun"
          @click="dryRunTableAction"
        >
          {{ runningTableAction === 'dry-run' ? 'Dry-run 中' : 'Dry-run 表动作' }}
        </button>
        <button
          type="button"
          class="integration-workbench__button integration-workbench__button--danger"
          data-testid="table-action-apply"
          :disabled="!tableActionCanApply"
          @click="applyTableAction"
        >
          {{ runningTableAction === 'apply' ? 'Apply 中' : tableActionApplyCommandLabel }}
        </button>
      </div>
      <div v-if="tableActionDryRunResult" class="integration-workbench__table-action-review" data-testid="table-action-review">
        <strong>{{ tableActionReviewSummary }}</strong>
        <div class="integration-workbench__metric-row">
          <span>add {{ tableActionCounts.add || 0 }}</span>
          <span>update {{ tableActionCounts.update || 0 }}</span>
          <span>skip {{ tableActionCounts.skip || 0 }}</span>
          <span>inactive {{ tableActionCounts.inactive || 0 }}</span>
          <span>manual {{ tableActionCounts.manual_confirm || 0 }}</span>
        </div>
        <div v-if="tableActionLargeBomBounded" class="integration-workbench__bounded-preview" data-testid="table-action-large-bom-bounded">
          <div>
            <strong>大 BOM 有界预览</strong>
            <span class="integration-workbench__badge" data-status="error">Apply blocked</span>
          </div>
          <p>本次只展开了有界子集，冲突/重复计数不是完整计划；不会签发 dry-run token。</p>
          <div class="integration-workbench__metric-row">
            <span v-for="metric in tableActionBoundedPreviewMetrics" :key="metric.id">{{ metric.label }} {{ metric.value }}</span>
          </div>
          <p v-if="tableActionBoundedErrorTypes.length" class="integration-workbench__hint">
            errorTypes: {{ tableActionBoundedErrorTypes.join(', ') }}
          </p>
        </div>
        <div v-if="tableActionDuplicateDiagnostics" class="integration-workbench__bounded-preview" data-testid="table-action-duplicate-diagnostics">
          <div>
            <strong>重复行分组待处理</strong>
            <span class="integration-workbench__badge" data-status="warning">manual_confirm</span>
          </div>
          <p>重复行策略只在 fresh dry-run evidence 中生效；已解决的分组仍需本次显式确认后才能 apply，未解决分组保持不写。</p>
          <div class="integration-workbench__metric-row">
            <span v-for="metric in tableActionDuplicateMetrics" :key="metric.id">{{ metric.label }} {{ metric.value }}</span>
          </div>
          <p v-if="tableActionDuplicatePolicies.length" class="integration-workbench__hint">
            policies: {{ tableActionDuplicatePolicies.join(', ') }}
          </p>
          <p class="integration-workbench__hint" data-testid="table-action-duplicate-policy-scope">
            本表已保存策略 {{ tableActionStoredConflictPolicyCount }} 条；本次 dry-run 已解决 {{ tableActionResolvedDuplicateGroupCount }} 组，仍 hold {{ tableActionHeldDuplicateGroupCount }} 组；未选择时默认 hold。
          </p>
          <div v-if="tableActionHeldReasonMetrics.length" class="integration-workbench__metric-row" data-testid="table-action-held-reason-summary">
            <span v-for="metric in tableActionHeldReasonMetrics" :key="metric.id">heldReason {{ metric.label }} {{ metric.value }}</span>
          </div>
          <ul v-if="tableActionDuplicateGroups.length" class="integration-workbench__mini-list">
            <li v-for="group in tableActionDuplicateGroups" :key="group.fingerprint">
              <div>
                #{{ group.ordinal }} {{ group.fingerprint }} · rows {{ group.rowCount }} · {{ group.parentShape }} · quantity {{ group.quantityShape }} · attrs {{ group.attributeShape }} · stable {{ group.stableDiscriminator }}
              </div>
              <div class="integration-workbench__connection-row">
                <label class="integration-workbench__inline-field">
                  <span>策略</span>
                  <select
                    :value="group.draftPolicy"
                    data-testid="table-action-duplicate-policy-select"
                    @change="onDuplicatePolicyDraftChange(group.fingerprint, $event)"
                  >
                    <option v-for="policy in tableActionDuplicatePolicies" :key="policy" :value="policy">
                      {{ policy }}
                    </option>
                  </select>
                </label>
                <span class="integration-workbench__hint">当前 {{ group.currentPolicy }} · {{ group.currentScope }} · {{ group.resolutionLabel }}</span>
                <button
                  type="button"
                  class="integration-workbench__button"
                  data-testid="table-action-duplicate-run-only"
                  @click="setDuplicateRunOnlyPolicy(group)"
                >
                  只此次有效
                </button>
                <button
                  v-if="hasPermission('integration:admin')"
                  type="button"
                  class="integration-workbench__button"
                  data-testid="table-action-duplicate-table-save"
                  :disabled="tableActionConflictPolicySaving === group.fingerprint"
                  @click="saveDuplicateTableScopePolicy(group)"
                >
                  保存为本表策略
                </button>
                <button
                  v-if="hasPermission('integration:admin')"
                  type="button"
                  class="integration-workbench__button"
                  data-testid="table-action-duplicate-table-revoke"
                  :disabled="tableActionConflictPolicySaving === group.fingerprint"
                  @click="revokeDuplicateTableScopePolicy(group)"
                >
                  撤销本表策略
                </button>
              </div>
            </li>
          </ul>
        </div>
        <p class="integration-workbench__hint" data-testid="table-action-token-state">
          {{ tableActionDryRunToken ? 'dry-run token 已签发；token 仅保存在当前页面内存，不展示、不复制到 evidence。' : '本次 dry-run 不可 apply；请处理失败项后重跑。' }}
        </p>
        <label v-if="tableActionManualConfirmCount > 0" class="integration-workbench__inline-check">
          <input v-model="tableActionAcceptManualConfirmHold" type="checkbox" data-testid="table-action-accept-manual-hold" />
          <span>确认 manual_confirm 行保持不写，只应用 clean add/update/inactive 决策。</span>
        </label>
        <label v-if="tableActionResolvedDuplicateGroupCount > 0" class="integration-workbench__inline-check">
          <input v-model="tableActionAcceptDuplicateResolution" type="checkbox" data-testid="table-action-accept-duplicate-resolution" />
          <span>确认已复核本次自动解决的重复分组，只应用 dry-run evidence 中列出的解决结果。</span>
        </label>
      </div>
      <div v-if="tableActionApplyResult" class="integration-workbench__table-action-review" data-testid="table-action-apply-result">
        <strong>apply {{ tableActionApplyResult.status }}</strong>
        <p class="integration-workbench__hint">已消费 dry-run token；如需再次 apply，必须重新 dry-run。</p>
      </div>
      <pre v-if="tableActionEvidenceText" data-testid="table-action-evidence">{{ tableActionEvidenceText }}</pre>
      <p class="integration-workbench__hint">Issue / 客户证据只粘贴 values-free summary counts、status、error code；不要粘贴 PLM 行、备料表值或 payload。</p>
    </template>
  </div>
</template>

<script setup lang="ts">
// IU-2d (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-2,
// stage D — `int-sec-run-push` decomposition): the generic parameterized table-action panel
// (with its own duplicate-policy sub-editor), one of five focused sub-panels the prior monolithic
// `int-sec-run-push` section bundled. Pure template/markup move — no state or service-call logic
// lives here.
//
// This panel is never gated by a root `v-if` (unlike stock-prep/field-option-sync), but two of its
// *inner* buttons (save/revoke a table-scope duplicate-conflict policy) were gated by
// `auth.hasPermission('integration:admin')` inline. Rather than passing the whole `auth` composable
// down, the parent forwards just the one method it needs — `:has-permission="auth.hasPermission"` —
// mirroring the existing function-prop pattern this codebase already uses for
// `isDeadLetterReplayable`/`canViewRowProvenance`/etc. `auth.hasPermission` is a plain closure
// function (no `this` binding), so passing it detached from the `auth` object is safe.
import type {
  IntegrationTableActionApplyResult,
  IntegrationTableActionDryRunResult,
  IntegrationTableActionMetadata,
} from '../../services/integration/workbench'
import type { DuplicateExpandedGroupView, MetricRow } from './integrationWorkbenchSectionTypes'

defineProps<{
  tableActions: IntegrationTableActionMetadata[]
  /** Bilingual copy helper — same shape as the view's local `bi(zh, en)` function. */
  bi: (zh: string, en: string) => string
  tableActionOptionLabel: (action: IntegrationTableActionMetadata) => string
  tableActionDisplayContextItems: string[]
  tableActionCanDryRun: boolean
  runningTableAction: 'dry-run' | 'apply' | ''
  tableActionCanApply: boolean
  tableActionApplyCommandLabel: string
  tableActionDryRunResult: IntegrationTableActionDryRunResult | null
  tableActionReviewSummary: string
  tableActionCounts: Record<string, number>
  tableActionLargeBomBounded: boolean
  tableActionBoundedPreviewMetrics: MetricRow[]
  tableActionBoundedErrorTypes: string[]
  tableActionDuplicateDiagnostics: unknown
  tableActionDuplicateMetrics: MetricRow[]
  tableActionDuplicatePolicies: string[]
  tableActionStoredConflictPolicyCount: number
  tableActionResolvedDuplicateGroupCount: number
  tableActionHeldDuplicateGroupCount: number
  tableActionHeldReasonMetrics: MetricRow[]
  tableActionDuplicateGroups: DuplicateExpandedGroupView[]
  tableActionConflictPolicySaving: string
  tableActionDryRunToken: string
  tableActionManualConfirmCount: number
  tableActionApplyResult: IntegrationTableActionApplyResult | null
  tableActionEvidenceText: string
  hasPermission: (permission: string) => boolean
  dryRunTableAction: () => Promise<void>
  applyTableAction: () => Promise<void>
  onDuplicatePolicyDraftChange: (fingerprint: string, event: Event) => void
  setDuplicateRunOnlyPolicy: (group: DuplicateExpandedGroupView) => void
  saveDuplicateTableScopePolicy: (group: DuplicateExpandedGroupView) => Promise<void>
  revokeDuplicateTableScopePolicy: (group: DuplicateExpandedGroupView) => Promise<void>
}>()

const selectedTableActionId = defineModel<string>('selectedTableActionId', { default: '' })
const tableActionProjectNo = defineModel<string>('tableActionProjectNo', { default: '' })
const tableActionAcceptManualConfirmHold = defineModel<boolean>('tableActionAcceptManualConfirmHold', { default: false })
const tableActionAcceptDuplicateResolution = defineModel<boolean>('tableActionAcceptDuplicateResolution', { default: false })
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

.integration-workbench__table-action-review {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.integration-workbench__bounded-preview {
  display: grid;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--el-color-warning-light-7);
  border-radius: 6px;
  background: var(--el-color-warning-light-9);
}

.integration-workbench__bounded-preview > div:first-child {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.integration-workbench__bounded-preview strong {
  color: var(--el-color-warning-dark-2);
}

.integration-workbench__mini-list {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.integration-workbench__mini-list li {
  padding: 8px;
  border: 1px solid var(--el-color-warning-light-7);
  border-radius: 6px;
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning-dark-2);
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
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

.integration-workbench__badge[data-status="error"] {
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}

.integration-workbench__badge[data-status="warning"] {
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning-dark-2);
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

.integration-workbench label {
  display: grid;
  gap: 6px;
  color: var(--ms-text-1);
  font-size: 13px;
  font-weight: 700;
}

.integration-workbench input,
.integration-workbench select {
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

.integration-workbench__connection-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
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
  .integration-workbench__panel-head,
  .integration-workbench__grid {
    grid-template-columns: 1fr;
  }

  .integration-workbench__panel-head {
    display: grid;
  }
}
</style>
