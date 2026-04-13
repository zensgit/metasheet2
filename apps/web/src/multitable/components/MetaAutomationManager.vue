<template>
  <div v-if="visible" class="meta-automation__overlay" @click.self="$emit('close')">
    <div class="meta-automation">
      <div class="meta-automation__header">
        <h4 class="meta-automation__title">Automations</h4>
        <button class="meta-automation__close" type="button" @click="$emit('close')">&times;</button>
      </div>

      <div class="meta-automation__body">
        <div v-if="error" class="meta-automation__error" role="alert">{{ error }}</div>

        <!-- Create / Edit form -->
        <section v-if="showForm" class="meta-automation__form">
          <div class="meta-automation__form-title">{{ editingRuleId ? 'Edit Automation' : 'New Automation' }}</div>

          <label class="meta-automation__label">Name</label>
          <input
            v-model="draft.name"
            class="meta-automation__input"
            type="text"
            placeholder="Automation name"
            data-automation-field="name"
          />

          <label class="meta-automation__label">Trigger</label>
          <select v-model="draft.triggerType" class="meta-automation__select" data-automation-field="triggerType">
            <option value="record.created">When record created</option>
            <option value="record.updated">When record updated</option>
            <option value="field.changed">When field changes</option>
          </select>

          <template v-if="draft.triggerType === 'field.changed'">
            <label class="meta-automation__label">Watch field</label>
            <select v-model="draft.triggerFieldId" class="meta-automation__select" data-automation-field="triggerFieldId">
              <option value="">-- select field --</option>
              <option v-for="f in fields" :key="f.id" :value="f.id">{{ f.name }}</option>
            </select>
          </template>

          <label class="meta-automation__label">Action</label>
          <select v-model="draft.actionType" class="meta-automation__select" data-automation-field="actionType">
            <option value="notify">Send notification</option>
            <option value="update_field">Update field value</option>
          </select>

          <template v-if="draft.actionType === 'notify'">
            <label class="meta-automation__label">Message</label>
            <input
              v-model="draft.notifyMessage"
              class="meta-automation__input"
              type="text"
              placeholder="Notification message"
              data-automation-field="notifyMessage"
            />
          </template>

          <template v-if="draft.actionType === 'update_field'">
            <label class="meta-automation__label">Target field</label>
            <select v-model="draft.targetFieldId" class="meta-automation__select" data-automation-field="targetFieldId">
              <option value="">-- select field --</option>
              <option v-for="f in fields" :key="f.id" :value="f.id">{{ f.name }}</option>
            </select>
            <label class="meta-automation__label">Value</label>
            <input
              v-model="draft.targetValue"
              class="meta-automation__input"
              type="text"
              placeholder="New value"
              data-automation-field="targetValue"
            />
          </template>

          <div class="meta-automation__form-actions">
            <button class="meta-automation__btn meta-automation__btn--primary" type="button" :disabled="!canSave" @click="onSave">
              {{ editingRuleId ? 'Update' : 'Create' }}
            </button>
            <button class="meta-automation__btn" type="button" @click="cancelForm">Cancel</button>
          </div>
        </section>

        <!-- Add button -->
        <button v-if="!showForm" class="meta-automation__btn meta-automation__btn--primary meta-automation__btn-add" type="button" @click="openCreateForm">
          + New Automation
        </button>

        <!-- Rule list -->
        <div v-if="loading" class="meta-automation__empty">Loading automations&#x2026;</div>
        <div v-else-if="!rules.length && !showForm" class="meta-automation__empty" data-automation-empty="true">
          No automations yet. Create your first automation rule.
        </div>
        <div
          v-for="rule in rules"
          :key="rule.id"
          class="meta-automation__card"
          :data-automation-rule="rule.id"
        >
          <div class="meta-automation__card-header">
            <strong class="meta-automation__card-name">{{ rule.name }}</strong>
            <label class="meta-automation__toggle">
              <input
                type="checkbox"
                :checked="rule.enabled"
                data-automation-toggle="true"
                @change="onToggle(rule)"
              />
              <span>{{ rule.enabled ? 'Enabled' : 'Disabled' }}</span>
            </label>
          </div>
          <div class="meta-automation__card-desc">
            {{ describeTrigger(rule) }} &rarr; {{ describeAction(rule) }}
          </div>
          <div class="meta-automation__card-actions">
            <button class="meta-automation__btn" type="button" data-automation-edit="true" @click="openEditForm(rule)">Edit</button>
            <button class="meta-automation__btn meta-automation__btn--danger" type="button" data-automation-delete="true" @click="onDelete(rule)">Delete</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { AutomationRule, AutomationTriggerType, AutomationActionType } from '../types'
import { useMultitableAutomations } from '../composables/useMultitableAutomations'
import type { MultitableApiClient } from '../api/client'

const props = defineProps<{
  visible: boolean
  sheetId: string
  fields: Array<{ id: string; name: string; type: string }>
  client?: MultitableApiClient
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'updated'): void
}>()

const { rules, loading, error, loadRules, createRule, updateRule, deleteRule, toggleRule } =
  useMultitableAutomations(props.client)

const showForm = ref(false)
const editingRuleId = ref<string | null>(null)

interface DraftState {
  name: string
  triggerType: AutomationTriggerType
  triggerFieldId: string
  actionType: AutomationActionType
  notifyMessage: string
  targetFieldId: string
  targetValue: string
}

function emptyDraft(): DraftState {
  return {
    name: '',
    triggerType: 'record.created',
    triggerFieldId: '',
    actionType: 'notify',
    notifyMessage: '',
    targetFieldId: '',
    targetValue: '',
  }
}

const draft = ref<DraftState>(emptyDraft())

const canSave = computed(() => {
  if (!draft.value.name.trim()) return false
  if (draft.value.triggerType === 'field.changed' && !draft.value.triggerFieldId) return false
  if (draft.value.actionType === 'notify' && !draft.value.notifyMessage.trim()) return false
  if (draft.value.actionType === 'update_field' && (!draft.value.targetFieldId || !draft.value.targetValue.trim())) return false
  return true
})

function openCreateForm() {
  editingRuleId.value = null
  draft.value = emptyDraft()
  showForm.value = true
}

function openEditForm(rule: AutomationRule) {
  editingRuleId.value = rule.id
  draft.value = {
    name: rule.name,
    triggerType: rule.triggerType,
    triggerFieldId: (rule.triggerConfig?.fieldId as string) ?? '',
    actionType: rule.actionType,
    notifyMessage: (rule.actionConfig?.message as string) ?? '',
    targetFieldId: (rule.actionConfig?.fieldId as string) ?? '',
    targetValue: (rule.actionConfig?.value as string) ?? '',
  }
  showForm.value = true
}

function cancelForm() {
  showForm.value = false
  editingRuleId.value = null
  draft.value = emptyDraft()
}

function buildTriggerConfig(): Record<string, unknown> {
  if (draft.value.triggerType === 'field.changed') {
    return { fieldId: draft.value.triggerFieldId }
  }
  return {}
}

function buildActionConfig(): Record<string, unknown> {
  if (draft.value.actionType === 'notify') {
    return { message: draft.value.notifyMessage }
  }
  if (draft.value.actionType === 'update_field') {
    return { fieldId: draft.value.targetFieldId, value: draft.value.targetValue }
  }
  return {}
}

async function onSave() {
  if (!canSave.value) return
  const payload = {
    name: draft.value.name.trim(),
    triggerType: draft.value.triggerType,
    triggerConfig: buildTriggerConfig(),
    actionType: draft.value.actionType,
    actionConfig: buildActionConfig(),
  }
  try {
    if (editingRuleId.value) {
      await updateRule(props.sheetId, editingRuleId.value, payload)
    } else {
      await createRule(props.sheetId, payload)
    }
    cancelForm()
    emit('updated')
  } catch {
    // error ref is set by composable
  }
}

async function onToggle(rule: AutomationRule) {
  try {
    await toggleRule(props.sheetId, rule.id, !rule.enabled)
    emit('updated')
  } catch {
    // error ref is set by composable
  }
}

async function onDelete(rule: AutomationRule) {
  try {
    await deleteRule(props.sheetId, rule.id)
    emit('updated')
  } catch {
    // error ref is set by composable
  }
}

function fieldNameById(fieldId: string): string {
  const field = props.fields.find((f) => f.id === fieldId)
  return field?.name ?? fieldId
}

function describeTrigger(rule: AutomationRule): string {
  switch (rule.triggerType) {
    case 'record.created':
      return 'When a record is created'
    case 'record.updated':
      return 'When a record is updated'
    case 'field.changed': {
      const fid = rule.triggerConfig?.fieldId as string | undefined
      return fid ? `When "${fieldNameById(fid)}" changes` : 'When a field changes'
    }
    default:
      return String(rule.triggerType)
  }
}

function describeAction(rule: AutomationRule): string {
  switch (rule.actionType) {
    case 'notify':
      return 'Send notification'
    case 'update_field': {
      const fid = rule.actionConfig?.fieldId as string | undefined
      return fid ? `Update "${fieldNameById(fid)}"` : 'Update field value'
    }
    default:
      return String(rule.actionType)
  }
}

watch(
  () => props.visible,
  (v) => {
    if (v && props.sheetId) {
      void loadRules(props.sheetId)
      cancelForm()
    }
  },
  { immediate: true },
)
</script>

<style scoped>
.meta-automation__overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
}

.meta-automation {
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
  width: 560px;
  max-width: 95vw;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
}

.meta-automation__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 20px 12px;
  border-bottom: 1px solid #e2e8f0;
}

.meta-automation__title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #0f172a;
}

.meta-automation__close {
  border: none;
  background: none;
  font-size: 22px;
  cursor: pointer;
  color: #64748b;
  line-height: 1;
  padding: 0 4px;
}

.meta-automation__body {
  padding: 16px 20px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.meta-automation__error {
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
  background: #fef2f2;
  color: #b91c1c;
}

.meta-automation__empty {
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
  background: #f8fafc;
  color: #64748b;
}

/* Form */
.meta-automation__form {
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.meta-automation__form-title {
  font-size: 14px;
  font-weight: 600;
  color: #0f172a;
  margin-bottom: 4px;
}

.meta-automation__label {
  font-size: 12px;
  font-weight: 600;
  color: #475569;
  margin-top: 4px;
}

.meta-automation__input,
.meta-automation__select {
  width: 100%;
  min-width: 0;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 13px;
  background: #fff;
  box-sizing: border-box;
}

.meta-automation__form-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

/* Cards */
.meta-automation__card {
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.meta-automation__card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.meta-automation__card-name {
  font-size: 14px;
  color: #0f172a;
}

.meta-automation__toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #64748b;
  cursor: pointer;
}

.meta-automation__card-desc {
  font-size: 13px;
  color: #475569;
}

.meta-automation__card-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

/* Buttons */
.meta-automation__btn {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 6px 14px;
  background: #fff;
  color: #0f172a;
  font-size: 13px;
  cursor: pointer;
}

.meta-automation__btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.meta-automation__btn--primary {
  border-color: #2563eb;
  background: #2563eb;
  color: #fff;
}

.meta-automation__btn--danger {
  border-color: #ef4444;
  color: #b91c1c;
}

.meta-automation__btn-add {
  align-self: flex-start;
}
</style>
