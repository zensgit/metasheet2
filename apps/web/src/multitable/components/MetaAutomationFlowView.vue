<template>
  <div v-if="visible && model" class="meta-flow-view__overlay" data-automation-flow-view="true" @click.self="$emit('close')">
    <div class="meta-flow-view" role="dialog" :aria-label="t('流程视图', 'Flow view')">
      <div class="meta-flow-view__header">
        <div class="meta-flow-view__titles">
          <h4 class="meta-flow-view__title">{{ t('流程视图', 'Flow view') }}</h4>
          <span class="meta-flow-view__rule" data-flow-rule-name="true">{{ model.ruleName }}</span>
          <span
            class="meta-flow-view__pill"
            :class="model.enabled ? 'meta-flow-view__pill--on' : 'meta-flow-view__pill--off'"
            data-flow-enabled="true"
          >{{ model.enabled ? t('已启用', 'Enabled') : t('未启用', 'Disabled') }}</span>
        </div>
        <MtIconButton class="meta-flow-view__close" data-flow-close="true" @click="$emit('close')">&times;</MtIconButton>
      </div>

      <div class="meta-flow-view__body">
        <p class="meta-flow-view__hint">{{ t('只读：按执行顺序自上而下显示这条规则。要修改请用「编辑」。', 'Read-only: this rule top-down in execution order. Use Edit to change it.') }}</p>

        <div class="meta-flow-view__flow">
          <div class="meta-flow-view__card meta-flow-view__card--trigger" data-flow-trigger="true" :data-trigger-type="model.trigger.type">
            <div class="meta-flow-view__card-head">
              <span class="meta-flow-view__badge meta-flow-view__badge--trigger">{{ t('触发', 'Trigger') }}</span>
              <span class="meta-flow-view__card-label">{{ model.trigger.label }}</span>
            </div>
            <div v-if="model.trigger.detail" class="meta-flow-view__card-summary" data-flow-trigger-detail="true">{{ model.trigger.detail }}</div>
          </div>

          <template v-if="model.hasRuleConditions">
            <div class="meta-flow-view__wire" />
            <div class="meta-flow-view__gate" data-flow-conditions="true">{{ t('满足规则条件才继续', 'Continues only when the rule conditions match') }}</div>
          </template>

          <div v-if="model.steps.length === 0" class="meta-flow-view__empty" data-flow-empty="true">{{ t('这条规则没有动作', 'This rule has no actions') }}</div>

          <template v-for="step in model.steps" :key="step.stepKey">
            <div class="meta-flow-view__wire" />
            <div
              class="meta-flow-view__card"
              :class="`meta-flow-view__card--${step.category}`"
              data-flow-step="true"
              :data-step-key="step.stepKey"
              :data-step-type="step.type"
              :data-step-run-status="stepRunStatus(step.stepKey) || undefined"
            >
              <div class="meta-flow-view__card-head">
                <span class="meta-flow-view__badge" :class="`meta-flow-view__badge--${step.category}`">{{ categoryLabel(step.category) }}</span>
                <span class="meta-flow-view__card-label">{{ step.label }}</span>
                <!-- 1d: the selected run's result for this top-level step (status only; never its output). -->
                <span
                  v-if="stepRunStatus(step.stepKey)"
                  class="meta-flow-view__run"
                  :class="`meta-flow-view__run--${stepRunStatus(step.stepKey)}`"
                  data-flow-step-run="true"
                >{{ stepRunLabel(stepRunStatus(step.stepKey)) }}</span>
                <code class="meta-flow-view__key">steps.{{ step.stepKey }}</code>
              </div>
              <div class="meta-flow-view__card-summary" data-flow-step-summary="true">{{ step.summary }}</div>

              <div v-if="step.branches.length" class="meta-flow-view__branches">
                <div
                  v-for="branch in step.branches"
                  :key="`${branch.kind}:${branch.key}`"
                  class="meta-flow-view__branch"
                  data-flow-branch="true"
                  :data-branch-key="branch.key"
                  :data-branch-default="branch.isDefault ? 'true' : 'false'"
                >
                  <div class="meta-flow-view__branch-head">{{ branch.label }}</div>
                  <div v-if="branch.steps.length === 0" class="meta-flow-view__empty">{{ t('（无动作）', '(no actions)') }}</div>
                  <div
                    v-for="child in branch.steps"
                    :key="child.stepKey"
                    class="meta-flow-view__child"
                    data-flow-branch-step="true"
                    :data-step-key="child.stepKey"
                  >
                    <span class="meta-flow-view__child-label">{{ child.summary }}</span>
                    <code class="meta-flow-view__key">{{ child.stepKey }}</code>
                  </div>
                </div>
              </div>
            </div>
          </template>

          <div class="meta-flow-view__end">{{ t('— 流程结束 —', '— end of flow —') }}</div>
        </div>

        <MetaAutomationFlowHistory
          :visible="visible"
          :rule="rule"
          :sheet-id="sheetId"
          :client="client"
          @overlay="runOverlay = $event"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// Integration assistant stage 1a (register R-99 ③): read-only flow view of one saved rule. It renders the
// pure model from automationFlowView.ts and never writes or saves anything. Stage 1d adds 「最近执行」
// (MetaAutomationFlowHistory): the one read — the run log's own getAutomationLogs call — and a per-step status
// overlay on the top-level cards when a picked run matches the rule without guessing.
import { computed, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { MultitableApiClient } from '../api/client'
import type { AutomationRule } from '../types'
import { buildAutomationFlow, flowStepCategoryLabel, type FlowStepCategory } from '../automationFlowView'
import type { FlowStepOverlay } from '../automationFlowHistory'
import { automationLabel } from '../utils/meta-automation-labels'
import { MtIconButton } from '../ui'
import MetaAutomationFlowHistory from './MetaAutomationFlowHistory.vue'

const props = defineProps<{
  visible: boolean
  rule: AutomationRule | null
  fields?: Array<{ id: string; name: string }>
  /** 1d: the run log's client + sheet; without them 「最近执行」 is not shown. */
  sheetId?: string
  client?: MultitableApiClient
}>()

defineEmits<{ (e: 'close'): void }>()

const { isZh } = useLocale()

function t(zh: string, en: string): string {
  return isZh.value ? zh : en
}

const model = computed(() => {
  if (!props.rule) return null
  const fields = props.fields ?? []
  return buildAutomationFlow(props.rule, {
    isZh: isZh.value,
    fieldLabel: (id: string) => fields.find((f) => f.id === id)?.name ?? id,
  })
})

function categoryLabel(category: FlowStepCategory): string {
  return flowStepCategoryLabel(category, isZh.value)
}

// 1d: set by MetaAutomationFlowHistory; only a 'matched' overlay paints the cards.
const runOverlay = ref<FlowStepOverlay | null>(null)

function stepRunStatus(stepKey: string): string {
  const overlay = runOverlay.value
  if (!overlay || overlay.kind !== 'matched') return ''
  return overlay.byStepKey[stepKey] ?? ''
}

function stepRunLabel(status: string): string {
  switch (status) {
    case 'success': return automationLabel('flowHistory.stepStatus.success', isZh.value)
    case 'failed': return automationLabel('flowHistory.stepStatus.failed', isZh.value)
    case 'skipped': return automationLabel('flowHistory.stepStatus.skipped', isZh.value)
    case 'simulated': return automationLabel('flowHistory.stepStatus.simulated', isZh.value)
    default: return status
  }
}
</script>

<style scoped>
.meta-flow-view__overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
}

.meta-flow-view {
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
  width: 560px;
  max-width: 95vw;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
}

.meta-flow-view__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid #eef0f3;
}

.meta-flow-view__titles {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}

.meta-flow-view__title {
  margin: 0;
  font-size: 15px;
}

.meta-flow-view__rule {
  color: #6b7280;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 260px;
}

.meta-flow-view__pill {
  font-size: 12px;
  border-radius: 999px;
  padding: 1px 8px;
}

.meta-flow-view__pill--on { background: #e7f6ec; color: #16a34a; }
.meta-flow-view__pill--off { background: #f3f4f6; color: #6b7280; }

.meta-flow-view__body {
  overflow: auto;
  padding: 14px 18px 20px;
  background: radial-gradient(circle, #e5e7eb 1px, transparent 1px) 0 0 / 18px 18px, #f8f9fb;
}

.meta-flow-view__hint {
  margin: 0 0 12px;
  font-size: 12px;
  color: #6b7280;
}

.meta-flow-view__flow {
  display: flex;
  flex-direction: column;
  align-items: stretch;
}

.meta-flow-view__card {
  background: #fff;
  border: 1.5px solid #e3e6eb;
  border-radius: 10px;
  padding: 10px 12px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.06);
}

.meta-flow-view__card--trigger { border-color: #f6c6a8; }

.meta-flow-view__card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.meta-flow-view__card-label {
  font-weight: 600;
  font-size: 13.5px;
  flex: 1;
  min-width: 0;
}

.meta-flow-view__card-summary {
  margin-top: 4px;
  font-size: 12.5px;
  color: #4b5563;
  word-break: break-word;
}

.meta-flow-view__badge {
  font-size: 11px;
  border-radius: 6px;
  padding: 1px 6px;
  color: #fff;
  background: #6b7280;
  flex: none;
}

.meta-flow-view__badge--trigger { background: #e8590c; }
.meta-flow-view__badge--record { background: #3b6ef5; }
.meta-flow-view__badge--message { background: #0f9d8a; }
.meta-flow-view__badge--control { background: #6b7280; }
.meta-flow-view__badge--integration { background: #7c5cd6; }
.meta-flow-view__badge--approval { background: #c27803; }

/* 1d: per-step run status — design tokens only. */
.meta-flow-view__run {
  font-size: 11px;
  border-radius: var(--ms-radius-sm);
  padding: 0 6px;
  border: 1px solid var(--ms-border);
  color: var(--ms-text-2);
  flex: none;
}

.meta-flow-view__run--success { border-color: var(--ms-color-success); color: var(--ms-color-success); }
.meta-flow-view__run--failed { border-color: var(--ms-color-danger); color: var(--ms-color-danger); }
.meta-flow-view__run--skipped { border-color: var(--ms-color-info); color: var(--ms-color-info); }
.meta-flow-view__run--simulated { border-color: var(--ms-color-warning); color: var(--ms-color-warning); }

.meta-flow-view__key {
  font-size: 11px;
  color: #9aa1ad;
  flex: none;
}

.meta-flow-view__wire {
  width: 2px;
  height: 18px;
  background: #d1d5db;
  align-self: center;
}

.meta-flow-view__gate {
  align-self: center;
  font-size: 12px;
  color: #92400e;
  background: #fdf3e1;
  border-radius: 999px;
  padding: 2px 10px;
}

.meta-flow-view__branches {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px;
  margin-top: 8px;
}

.meta-flow-view__branch {
  border: 1px dashed #d1d5db;
  border-radius: 8px;
  padding: 6px 8px;
  background: #fafbfc;
}

.meta-flow-view__branch-head {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 4px;
}

.meta-flow-view__child {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  font-size: 12px;
  color: #4b5563;
  padding: 2px 0;
}

.meta-flow-view__child-label {
  min-width: 0;
  word-break: break-word;
}

.meta-flow-view__empty {
  font-size: 12px;
  color: #9aa1ad;
  text-align: center;
  padding: 8px 0;
}

.meta-flow-view__end {
  margin-top: 8px;
  text-align: center;
  font-size: 12px;
  color: #9aa1ad;
}
</style>
