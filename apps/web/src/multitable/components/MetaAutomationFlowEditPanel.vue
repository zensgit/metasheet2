<template>
  <div class="meta-flow-edit" data-automation-flow-edit="true">
    <p class="meta-flow-edit__hint">{{ automationLabel('editor.flowHint', isZh) }}</p>

    <div class="meta-flow-edit__flow">
      <button
        type="button"
        class="meta-flow-edit__card meta-flow-edit__card--trigger"
        data-flow-trigger="true"
        :data-trigger-type="trigger.type"
        :title="automationLabel('editor.flowTriggerEditTitle', isZh)"
        @click="$emit('edit-trigger')"
      >
        <span class="meta-flow-edit__card-head">
          <span class="meta-flow-edit__badge meta-flow-edit__badge--trigger">{{ automationLabel('editor.flowTriggerBadge', isZh) }}</span>
          <span class="meta-flow-edit__card-label">{{ trigger.label }}</span>
        </span>
        <span v-if="trigger.detail" class="meta-flow-edit__card-summary" data-flow-trigger-detail="true">{{ trigger.detail }}</span>
      </button>

      <template v-if="hasRuleConditions">
        <div class="meta-flow-edit__wire" />
        <div class="meta-flow-edit__gate" data-flow-conditions="true">{{ automationLabel('editor.flowConditionsGate', isZh) }}</div>
      </template>

      <div v-if="steps.length === 0" class="meta-flow-edit__empty" data-flow-empty="true">{{ automationLabel('editor.flowEmpty', isZh) }}</div>

      <template v-for="(step, idx) in steps" :key="step.id">
        <div class="meta-flow-edit__wire" />
        <div
          class="meta-flow-edit__card"
          data-flow-step="true"
          :data-step-index="idx"
          :data-step-type="step.type"
        >
          <div class="meta-flow-edit__card-head">
            <span class="meta-flow-edit__num">{{ idx + 1 }}</span>
            <span class="meta-flow-edit__badge" :class="`meta-flow-edit__badge--${step.category}`">{{ flowStepCategoryLabel(step.category, isZh) }}</span>
            <span class="meta-flow-edit__card-label" data-flow-step-label="true">{{ step.label }}</span>
            <span class="meta-flow-edit__btns">
              <button
                v-if="idx > 0"
                type="button"
                class="meta-flow-edit__icon-btn"
                data-flow-step-action="up"
                :title="automationLabel('editor.moveUpTitle', isZh)"
                @click="$emit('move', idx, -1)"
              >&#x2191;</button>
              <button
                v-if="idx < steps.length - 1"
                type="button"
                class="meta-flow-edit__icon-btn"
                data-flow-step-action="down"
                :title="automationLabel('editor.moveDownTitle', isZh)"
                @click="$emit('move', idx, 1)"
              >&#x2193;</button>
              <button
                type="button"
                class="meta-flow-edit__icon-btn"
                data-flow-step-action="remove"
                :title="automationLabel('editor.removeActionTitle', isZh)"
                @click="$emit('remove', idx)"
              >&times;</button>
              <button
                type="button"
                class="meta-flow-edit__text-btn"
                data-flow-step-action="configure"
                @click="$emit('configure', idx)"
              >{{ automationLabel('editor.flowConfigure', isZh) }}</button>
            </span>
          </div>
          <div class="meta-flow-edit__card-summary" data-flow-step-summary="true">{{ step.summary }}</div>
        </div>
      </template>

      <div class="meta-flow-edit__wire" />
      <button
        type="button"
        class="meta-flow-edit__add"
        data-flow-add-step="true"
        :disabled="addBlockedReason !== ''"
        :title="addBlockedReason || undefined"
        @click="$emit('add')"
      >{{ automationLabel('editor.flowAddStep', isZh) }}</button>
      <div v-if="addBlockedReason" class="meta-flow-edit__blocked" data-flow-add-blocked="true">{{ addBlockedReason }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
// Integration assistant stage 1b (register R-99 ③): the rule editor's Flow mode. Purely presentational —
// it renders the editor's own draft (trigger card, conditions gate, one card per top-level action) and only
// EMITS intents; the editor routes each one to its existing moveAction / removeAction / addAction or back to
// Form mode. No inputs, no draft of its own, no save path, no fetch.
import { useLocale } from '../../composables/useLocale'
import { automationLabel } from '../utils/meta-automation-labels'
import { flowStepCategoryLabel, type FlowEditStep, type FlowTriggerCard } from '../automationFlowView'

defineProps<{
  trigger: FlowTriggerCard
  hasRuleConditions: boolean
  steps: FlowEditStep[]
  /** '' when a step can be added; otherwise why the editor's addAction() would refuse. */
  addBlockedReason: string
}>()

defineEmits<{
  (e: 'move', idx: number, dir: number): void
  (e: 'remove', idx: number): void
  (e: 'configure', idx: number): void
  (e: 'add'): void
  (e: 'edit-trigger'): void
}>()

const { isZh } = useLocale()
</script>

<style scoped>
.meta-flow-edit {
  border-radius: 10px;
  padding: 10px 12px 14px;
  background: radial-gradient(circle, #e5e7eb 1px, transparent 1px) 0 0 / 18px 18px, #f8f9fb;
}

.meta-flow-edit__hint {
  margin: 0 0 10px;
  font-size: 12px;
  color: #6b7280;
}

.meta-flow-edit__flow {
  display: flex;
  flex-direction: column;
  align-items: stretch;
}

.meta-flow-edit__card {
  display: block;
  width: 100%;
  box-sizing: border-box;
  text-align: left;
  font: inherit;
  color: inherit;
  background: #fff;
  border: 1.5px solid #e3e6eb;
  border-radius: 10px;
  padding: 10px 12px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.06);
}

.meta-flow-edit__card--trigger {
  border-color: #f6c6a8;
  cursor: pointer;
}

.meta-flow-edit__card--trigger:hover { border-color: #e8590c; }

.meta-flow-edit__card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.meta-flow-edit__num {
  font-size: 12px;
  font-weight: 600;
  color: #9aa1ad;
  flex: none;
}

.meta-flow-edit__card-label {
  font-weight: 600;
  font-size: 13.5px;
  flex: 1;
  min-width: 0;
}

.meta-flow-edit__card-summary {
  display: block;
  margin-top: 4px;
  font-size: 12.5px;
  color: #4b5563;
  word-break: break-word;
}

.meta-flow-edit__badge {
  font-size: 11px;
  border-radius: 6px;
  padding: 1px 6px;
  color: #fff;
  background: #6b7280;
  flex: none;
}

.meta-flow-edit__badge--trigger { background: #e8590c; }
.meta-flow-edit__badge--record { background: #3b6ef5; }
.meta-flow-edit__badge--message { background: #0f9d8a; }
.meta-flow-edit__badge--control { background: #6b7280; }
.meta-flow-edit__badge--integration { background: #7c5cd6; }
.meta-flow-edit__badge--approval { background: #c27803; }

.meta-flow-edit__btns {
  display: flex;
  gap: 4px;
  flex: none;
}

.meta-flow-edit__icon-btn,
.meta-flow-edit__text-btn {
  font: inherit;
  font-size: 12px;
  line-height: 1;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  color: #374151;
  padding: 4px 7px;
  cursor: pointer;
}

.meta-flow-edit__icon-btn:hover,
.meta-flow-edit__text-btn:hover { border-color: #3b6ef5; color: #3b6ef5; }

.meta-flow-edit__wire {
  width: 2px;
  height: 18px;
  background: #d1d5db;
  align-self: center;
}

.meta-flow-edit__gate {
  align-self: center;
  font-size: 12px;
  color: #92400e;
  background: #fdf3e1;
  border-radius: 999px;
  padding: 2px 10px;
}

.meta-flow-edit__empty {
  font-size: 12px;
  color: #9aa1ad;
  text-align: center;
  padding: 8px 0;
}

.meta-flow-edit__add {
  align-self: center;
  font: inherit;
  font-size: 12.5px;
  border: 1.5px dashed #9aa1ad;
  border-radius: 8px;
  background: #fff;
  color: #374151;
  padding: 5px 14px;
  cursor: pointer;
}

.meta-flow-edit__add:hover:not(:disabled) { border-color: #3b6ef5; color: #3b6ef5; }

.meta-flow-edit__add:disabled {
  cursor: not-allowed;
  color: #9aa1ad;
  border-color: #d1d5db;
}

.meta-flow-edit__blocked {
  margin-top: 6px;
  text-align: center;
  font-size: 12px;
  color: #9aa1ad;
}
</style>
