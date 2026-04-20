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
            <option value="send_dingtalk_group_message">Send DingTalk group message</option>
            <option value="send_dingtalk_person_message">Send DingTalk person message</option>
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

          <template v-if="draft.actionType === 'send_dingtalk_group_message'">
            <div class="meta-automation__preset-row">
              <span class="meta-automation__preset-label">Message preset</span>
              <button class="meta-automation__btn" type="button" data-automation-preset="group-form" @click="applyGroupPreset('form_request')">Form request</button>
              <button class="meta-automation__btn" type="button" data-automation-preset="group-internal" @click="applyGroupPreset('internal_process')">Internal processing</button>
              <button class="meta-automation__btn" type="button" data-automation-preset="group-both" @click="applyGroupPreset('form_and_process')">Form + processing</button>
            </div>
            <label class="meta-automation__label">DingTalk group</label>
            <select v-model="draft.dingtalkDestinationId" class="meta-automation__select" data-automation-field="dingtalkDestinationId">
              <option value="">-- select DingTalk group --</option>
              <option v-for="destination in dingTalkDestinations" :key="destination.id" :value="destination.id">
                {{ destination.name }}
              </option>
            </select>
            <label class="meta-automation__label">Title template</label>
            <input
              v-model="draft.dingtalkTitleTemplate"
              class="meta-automation__input"
              type="text"
              placeholder="例如：{{record.title}} 待处理"
              data-automation-field="dingtalkTitleTemplate"
            />
            <div
              v-for="warning in templateSyntaxWarnings(draft.dingtalkTitleTemplate)"
              :key="`draft-group-title-${warning}`"
              class="meta-automation__hint meta-automation__hint--warning"
            >
              {{ warning }}
            </div>
            <div class="meta-automation__preset-row">
              <span class="meta-automation__preset-label">Template tokens</span>
              <button
                v-for="token in DINGTALK_TITLE_TEMPLATE_TOKENS"
                :key="token.key"
                class="meta-automation__btn"
                type="button"
                :data-automation-token="`group-title-${token.key}`"
                @click="appendGroupTemplateToken('title', token.value)"
              >
                {{ token.label }}
              </button>
            </div>
            <label class="meta-automation__label">Body template</label>
            <textarea
              v-model="draft.dingtalkBodyTemplate"
              class="meta-automation__input"
              rows="4"
              placeholder="支持 {{record.xxx}}、{{recordId}}、{{sheetId}}、{{actorId}}"
              data-automation-field="dingtalkBodyTemplate"
            ></textarea>
            <div
              v-for="warning in templateSyntaxWarnings(draft.dingtalkBodyTemplate)"
              :key="`draft-group-body-${warning}`"
              class="meta-automation__hint meta-automation__hint--warning"
            >
              {{ warning }}
            </div>
            <div class="meta-automation__preset-row">
              <span class="meta-automation__preset-label">Template tokens</span>
              <button
                v-for="token in DINGTALK_BODY_TEMPLATE_TOKENS"
                :key="token.key"
                class="meta-automation__btn"
                type="button"
                :data-automation-token="`group-body-${token.key}`"
                @click="appendGroupTemplateToken('body', token.value)"
              >
                {{ token.label }}
              </button>
            </div>
            <label class="meta-automation__label">Public form view (optional)</label>
            <select v-model="draft.publicFormViewId" class="meta-automation__select" data-automation-field="publicFormViewId">
              <option value="">-- no public form link --</option>
              <option v-for="view in formViews" :key="view.id" :value="view.id">{{ view.name }}</option>
            </select>
            <label class="meta-automation__label">Internal processing view (optional)</label>
            <select v-model="draft.internalViewId" class="meta-automation__select" data-automation-field="internalViewId">
              <option value="">-- no internal link --</option>
              <option v-for="view in internalViews" :key="view.id" :value="view.id">{{ view.name }}</option>
            </select>
            <div class="meta-automation__preview" data-automation-summary="group">
              <div class="meta-automation__preview-title">Message summary</div>
              <div><strong>Group:</strong> {{ dingTalkGroupName(draft.dingtalkDestinationId) }}</div>
              <div><strong>Title template:</strong> {{ templatePreviewText(draft.dingtalkTitleTemplate, 'No title template') }}</div>
              <div class="meta-automation__preview-body"><strong>Body template:</strong> {{ templatePreviewText(draft.dingtalkBodyTemplate, 'No body template') }}</div>
              <div class="meta-automation__preview-line">
                <span><strong>Rendered title:</strong> {{ renderedTemplateExample(draft.dingtalkTitleTemplate, 'No rendered title') }}</span>
                <button
                  class="meta-automation__copy-btn"
                  type="button"
                  data-automation-copy="group-rendered-title"
                  @click="copyPreviewText('group-title', renderedTemplateExample(draft.dingtalkTitleTemplate, ''))"
                >
                  {{ copiedPreviewKey === 'group-title' ? 'Copied' : 'Copy' }}
                </button>
              </div>
              <div class="meta-automation__preview-line meta-automation__preview-body">
                <span><strong>Rendered body:</strong> {{ renderedTemplateExample(draft.dingtalkBodyTemplate, 'No rendered body') }}</span>
                <button
                  class="meta-automation__copy-btn"
                  type="button"
                  data-automation-copy="group-rendered-body"
                  @click="copyPreviewText('group-body', renderedTemplateExample(draft.dingtalkBodyTemplate, ''))"
                >
                  {{ copiedPreviewKey === 'group-body' ? 'Copied' : 'Copy' }}
                </button>
              </div>
              <div><strong>Public form:</strong> {{ viewSummaryName(draft.publicFormViewId, 'No public form link') }}</div>
              <div><strong>Internal processing:</strong> {{ viewSummaryName(draft.internalViewId, 'No internal link') }}</div>
            </div>
          </template>

          <template v-if="draft.actionType === 'send_dingtalk_person_message'">
            <div class="meta-automation__preset-row">
              <span class="meta-automation__preset-label">Message preset</span>
              <button class="meta-automation__btn" type="button" data-automation-preset="person-form" @click="applyPersonPreset('form_request')">Form request</button>
              <button class="meta-automation__btn" type="button" data-automation-preset="person-internal" @click="applyPersonPreset('internal_process')">Internal processing</button>
              <button class="meta-automation__btn" type="button" data-automation-preset="person-both" @click="applyPersonPreset('form_and_process')">Form + processing</button>
            </div>
            <label class="meta-automation__label">Search and add users</label>
            <input
              v-model="dingtalkPersonUserSearch"
              class="meta-automation__input"
              type="text"
              placeholder="Search by name, email, or userId"
              data-automation-field="dingtalkPersonUserSearch"
              @input="void loadDingTalkPersonSuggestions()"
            />
            <div v-if="dingtalkPersonUserSearchLoading" class="meta-automation__hint">Searching users…</div>
            <div v-else-if="dingtalkPersonUserSearchError" class="meta-automation__hint meta-automation__hint--error">{{ dingtalkPersonUserSearchError }}</div>
            <div v-else-if="availableDingTalkPersonSuggestions.length" class="meta-automation__recipient-list">
              <button
                v-for="candidate in availableDingTalkPersonSuggestions"
                :key="candidate.id"
                class="meta-automation__recipient-option"
                type="button"
                :data-automation-person-suggestion="candidate.id"
                @click="addDingTalkPersonRecipient(candidate)"
              >
                <strong>{{ candidate.label }}</strong>
                <span>{{ candidate.subtitle || candidate.id }}</span>
              </button>
            </div>
            <div v-else-if="dingtalkPersonUserSearch.trim()" class="meta-automation__hint">No matching users</div>
            <div v-if="selectedDingTalkPersonRecipients.length" class="meta-automation__recipient-list meta-automation__recipient-list--selected">
              <button
                v-for="recipient in selectedDingTalkPersonRecipients"
                :key="recipient.id"
                class="meta-automation__recipient-chip"
                type="button"
                :data-automation-person-recipient="recipient.id"
                @click="removeDingTalkPersonRecipient(recipient.id)"
              >
                <strong>{{ recipient.label }}</strong>
                <span>{{ recipient.subtitle || recipient.id }}</span>
                <em>Remove</em>
              </button>
            </div>
            <label class="meta-automation__label">Local user IDs</label>
            <textarea
              v-model="draft.dingtalkPersonUserIds"
              class="meta-automation__input"
              rows="3"
              placeholder="使用逗号或换行分隔本地 userId"
              data-automation-field="dingtalkPersonUserIds"
            ></textarea>
            <label class="meta-automation__label">Record recipient field path (optional)</label>
            <input
              v-model="draft.dingtalkPersonRecipientFieldPath"
              class="meta-automation__input"
              type="text"
              placeholder="例如：record.assigneeUserIds"
              data-automation-field="dingtalkPersonRecipientFieldPath"
            />
            <div class="meta-automation__hint">
              Supports `record.xxx` paths that resolve to one userId, a comma-separated string, or a userId array.
            </div>
            <label class="meta-automation__label">Title template</label>
            <input
              v-model="draft.dingtalkPersonTitleTemplate"
              class="meta-automation__input"
              type="text"
              placeholder="例如：{{record.title}} 待处理"
              data-automation-field="dingtalkPersonTitleTemplate"
            />
            <div
              v-for="warning in templateSyntaxWarnings(draft.dingtalkPersonTitleTemplate)"
              :key="`draft-person-title-${warning}`"
              class="meta-automation__hint meta-automation__hint--warning"
            >
              {{ warning }}
            </div>
            <div class="meta-automation__preset-row">
              <span class="meta-automation__preset-label">Template tokens</span>
              <button
                v-for="token in DINGTALK_TITLE_TEMPLATE_TOKENS"
                :key="token.key"
                class="meta-automation__btn"
                type="button"
                :data-automation-token="`person-title-${token.key}`"
                @click="appendPersonTemplateToken('title', token.value)"
              >
                {{ token.label }}
              </button>
            </div>
            <label class="meta-automation__label">Body template</label>
            <textarea
              v-model="draft.dingtalkPersonBodyTemplate"
              class="meta-automation__input"
              rows="4"
              placeholder="支持 {{record.xxx}}、{{recordId}}、{{sheetId}}、{{actorId}}"
              data-automation-field="dingtalkPersonBodyTemplate"
            ></textarea>
            <div
              v-for="warning in templateSyntaxWarnings(draft.dingtalkPersonBodyTemplate)"
              :key="`draft-person-body-${warning}`"
              class="meta-automation__hint meta-automation__hint--warning"
            >
              {{ warning }}
            </div>
            <div class="meta-automation__preset-row">
              <span class="meta-automation__preset-label">Template tokens</span>
              <button
                v-for="token in DINGTALK_BODY_TEMPLATE_TOKENS"
                :key="token.key"
                class="meta-automation__btn"
                type="button"
                :data-automation-token="`person-body-${token.key}`"
                @click="appendPersonTemplateToken('body', token.value)"
              >
                {{ token.label }}
              </button>
            </div>
            <label class="meta-automation__label">Public form view (optional)</label>
            <select v-model="draft.dingtalkPersonPublicFormViewId" class="meta-automation__select" data-automation-field="dingtalkPersonPublicFormViewId">
              <option value="">-- no public form link --</option>
              <option v-for="view in formViews" :key="view.id" :value="view.id">{{ view.name }}</option>
            </select>
            <label class="meta-automation__label">Internal processing view (optional)</label>
            <select v-model="draft.dingtalkPersonInternalViewId" class="meta-automation__select" data-automation-field="dingtalkPersonInternalViewId">
              <option value="">-- no internal link --</option>
              <option v-for="view in internalViews" :key="view.id" :value="view.id">{{ view.name }}</option>
            </select>
            <div class="meta-automation__preview" data-automation-summary="person">
              <div class="meta-automation__preview-title">Message summary</div>
              <div><strong>Recipients:</strong> {{ dingTalkPersonRecipientSummary }}</div>
              <div><strong>Record recipients:</strong> {{ dingTalkPersonRecipientFieldSummary }}</div>
              <div><strong>Title template:</strong> {{ templatePreviewText(draft.dingtalkPersonTitleTemplate, 'No title template') }}</div>
              <div class="meta-automation__preview-body"><strong>Body template:</strong> {{ templatePreviewText(draft.dingtalkPersonBodyTemplate, 'No body template') }}</div>
              <div class="meta-automation__preview-line">
                <span><strong>Rendered title:</strong> {{ renderedTemplateExample(draft.dingtalkPersonTitleTemplate, 'No rendered title') }}</span>
                <button
                  class="meta-automation__copy-btn"
                  type="button"
                  data-automation-copy="person-rendered-title"
                  @click="copyPreviewText('person-title', renderedTemplateExample(draft.dingtalkPersonTitleTemplate, ''))"
                >
                  {{ copiedPreviewKey === 'person-title' ? 'Copied' : 'Copy' }}
                </button>
              </div>
              <div class="meta-automation__preview-line meta-automation__preview-body">
                <span><strong>Rendered body:</strong> {{ renderedTemplateExample(draft.dingtalkPersonBodyTemplate, 'No rendered body') }}</span>
                <button
                  class="meta-automation__copy-btn"
                  type="button"
                  data-automation-copy="person-rendered-body"
                  @click="copyPreviewText('person-body', renderedTemplateExample(draft.dingtalkPersonBodyTemplate, ''))"
                >
                  {{ copiedPreviewKey === 'person-body' ? 'Copied' : 'Copy' }}
                </button>
              </div>
              <div><strong>Public form:</strong> {{ viewSummaryName(draft.dingtalkPersonPublicFormViewId, 'No public form link') }}</div>
              <div><strong>Internal processing:</strong> {{ viewSummaryName(draft.dingtalkPersonInternalViewId, 'No internal link') }}</div>
            </div>
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
          <div v-if="ruleStats[rule.id]" class="meta-automation__card-stats">
            <span class="meta-automation__stat meta-automation__stat--success">{{ ruleStats[rule.id].success }} ok</span>
            <span class="meta-automation__stat meta-automation__stat--failed">{{ ruleStats[rule.id].failed }} fail</span>
          </div>
          <div class="meta-automation__card-actions">
            <button class="meta-automation__btn" type="button" data-automation-edit="true" @click="openRuleEditor(rule)">Edit</button>
            <button class="meta-automation__btn" type="button" data-automation-logs="true" @click="openLogViewer(rule)">View Logs</button>
            <button
              v-if="rule.actionType === 'send_dingtalk_group_message'"
              class="meta-automation__btn"
              type="button"
              :data-automation-group-deliveries="rule.id"
              @click="openGroupDeliveryViewer(rule)"
            >
              View Deliveries
            </button>
            <button
              v-if="rule.actionType === 'send_dingtalk_person_message'"
              class="meta-automation__btn"
              type="button"
              :data-automation-person-deliveries="rule.id"
              @click="openPersonDeliveryViewer(rule)"
            >
              View Deliveries
            </button>
            <button class="meta-automation__btn meta-automation__btn--danger" type="button" data-automation-delete="true" @click="onDelete(rule)">Delete</button>
          </div>
        </div>
      </div>
    </div>
    <MetaAutomationRuleEditor
      :visible="showRuleEditor"
      :sheet-id="sheetId"
      :rule="editingRule ?? undefined"
      :fields="fields"
      :client="client"
      :views="views"
      @close="showRuleEditor = false"
      @save="onRuleEditorSave"
      @test="onTestRule"
    />
    <MetaAutomationLogViewer
      :visible="showLogViewer"
      :sheet-id="sheetId"
      :rule-id="logViewerRuleId"
      :client="client"
      @close="showLogViewer = false"
    />
    <MetaAutomationPersonDeliveryViewer
      :visible="showPersonDeliveryViewer"
      :sheet-id="sheetId"
      :rule-id="personDeliveryViewerRuleId"
      :client="client"
      @close="showPersonDeliveryViewer = false"
    />
    <MetaAutomationGroupDeliveryViewer
      :visible="showGroupDeliveryViewer"
      :sheet-id="sheetId"
      :rule-id="groupDeliveryViewerRuleId"
      :client="client"
      @close="showGroupDeliveryViewer = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import type {
  AutomationRule,
  AutomationTriggerType,
  AutomationActionType,
  AutomationStats,
  DingTalkGroupDestination,
  MetaCommentMentionSuggestion,
  MetaView,
} from '../types'
import { useMultitableAutomations } from '../composables/useMultitableAutomations'
import type { MultitableApiClient } from '../api/client'
import MetaAutomationRuleEditor from './MetaAutomationRuleEditor.vue'
import MetaAutomationLogViewer from './MetaAutomationLogViewer.vue'
import MetaAutomationGroupDeliveryViewer from './MetaAutomationGroupDeliveryViewer.vue'
import MetaAutomationPersonDeliveryViewer from './MetaAutomationPersonDeliveryViewer.vue'
import { applyDingTalkNotificationPreset, type DingTalkNotificationPreset } from '../utils/dingtalkNotificationPresets'
import {
  appendTemplateToken,
  DINGTALK_BODY_TEMPLATE_TOKENS,
  DINGTALK_TITLE_TEMPLATE_TOKENS,
} from '../utils/dingtalkNotificationTemplateTokens'
import { listDingTalkTemplateSyntaxWarnings } from '../utils/dingtalkNotificationTemplateLint'
import { renderDingTalkTemplateExample } from '../utils/dingtalkNotificationTemplateExample'

const props = defineProps<{
  visible: boolean
  sheetId: string
  fields: Array<{ id: string; name: string; type: string }>
  client?: MultitableApiClient
  views?: MetaView[]
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
  dingtalkDestinationId: string
  dingtalkTitleTemplate: string
  dingtalkBodyTemplate: string
  publicFormViewId: string
  internalViewId: string
  dingtalkPersonUserIds: string
  dingtalkPersonRecipientFieldPath: string
  dingtalkPersonTitleTemplate: string
  dingtalkPersonBodyTemplate: string
  dingtalkPersonPublicFormViewId: string
  dingtalkPersonInternalViewId: string
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
    dingtalkDestinationId: '',
    dingtalkTitleTemplate: '',
    dingtalkBodyTemplate: '',
    publicFormViewId: '',
    internalViewId: '',
    dingtalkPersonUserIds: '',
    dingtalkPersonRecipientFieldPath: '',
    dingtalkPersonTitleTemplate: '',
    dingtalkPersonBodyTemplate: '',
    dingtalkPersonPublicFormViewId: '',
    dingtalkPersonInternalViewId: '',
  }
}

const draft = ref<DraftState>(emptyDraft())
const dingTalkDestinations = ref<DingTalkGroupDestination[]>([])
const dingtalkPersonUserSearch = ref('')
const dingtalkPersonUserSearchLoading = ref(false)
const dingtalkPersonUserSearchError = ref('')
const dingtalkPersonUserSuggestions = ref<MetaCommentMentionSuggestion[]>([])
const dingtalkPersonUserDirectory = ref<Record<string, { label: string; subtitle?: string }>>({})
const copiedPreviewKey = ref('')
let dingtalkPersonSuggestionLoadId = 0
let copiedPreviewResetTimer: ReturnType<typeof setTimeout> | null = null
const formViews = computed(() => (props.views ?? []).filter((view) => view.type === 'form'))
const internalViews = computed(() => props.views ?? [])

function parseUserIdsText(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function rememberDingTalkPersonSuggestions(items: MetaCommentMentionSuggestion[]) {
  const next = { ...dingtalkPersonUserDirectory.value }
  for (const item of items) {
    next[item.id] = { label: item.label, subtitle: item.subtitle }
  }
  dingtalkPersonUserDirectory.value = next
}

const selectedDingTalkPersonRecipients = computed(() =>
  parseUserIdsText(draft.value.dingtalkPersonUserIds).map((id) => ({
    id,
    label: dingtalkPersonUserDirectory.value[id]?.label ?? id,
    subtitle: dingtalkPersonUserDirectory.value[id]?.subtitle,
  })),
)

const availableDingTalkPersonSuggestions = computed(() => {
  const selected = new Set(parseUserIdsText(draft.value.dingtalkPersonUserIds))
  return dingtalkPersonUserSuggestions.value.filter((candidate) => !selected.has(candidate.id))
})

async function loadDingTalkPersonSuggestions() {
  const query = dingtalkPersonUserSearch.value.trim()
  if (!props.client || !showForm.value || draft.value.actionType !== 'send_dingtalk_person_message' || !query) {
    dingtalkPersonUserSuggestions.value = []
    dingtalkPersonUserSearchError.value = ''
    dingtalkPersonUserSearchLoading.value = false
    return
  }

  const requestId = ++dingtalkPersonSuggestionLoadId
  dingtalkPersonUserSearchLoading.value = true
  dingtalkPersonUserSearchError.value = ''
  try {
    const response = await props.client.listCommentMentionSuggestions({
      spreadsheetId: props.sheetId,
      q: query,
      limit: 8,
    })
    if (requestId !== dingtalkPersonSuggestionLoadId) return
    rememberDingTalkPersonSuggestions(response.items)
    dingtalkPersonUserSuggestions.value = response.items
  } catch (error) {
    if (requestId !== dingtalkPersonSuggestionLoadId) return
    dingtalkPersonUserSuggestions.value = []
    dingtalkPersonUserSearchError.value = error instanceof Error ? error.message : 'Failed to search users'
  } finally {
    if (requestId === dingtalkPersonSuggestionLoadId) {
      dingtalkPersonUserSearchLoading.value = false
    }
  }
}

function addDingTalkPersonRecipient(candidate: MetaCommentMentionSuggestion) {
  const ids = new Set(parseUserIdsText(draft.value.dingtalkPersonUserIds))
  ids.add(candidate.id)
  draft.value.dingtalkPersonUserIds = Array.from(ids).join(', ')
  rememberDingTalkPersonSuggestions([candidate])
  dingtalkPersonUserSearch.value = ''
  dingtalkPersonUserSuggestions.value = []
  dingtalkPersonUserSearchError.value = ''
}

function removeDingTalkPersonRecipient(userId: string) {
  draft.value.dingtalkPersonUserIds = parseUserIdsText(draft.value.dingtalkPersonUserIds)
    .filter((id) => id !== userId)
    .join(', ')
}

function dingTalkGroupName(destinationId: string) {
  if (!destinationId) return 'No group selected'
  return dingTalkDestinations.value.find((item) => item.id === destinationId)?.name ?? destinationId
}

function viewSummaryName(viewId: string, fallback: string) {
  if (!viewId) return fallback
  return (props.views ?? []).find((view) => view.id === viewId)?.name ?? viewId
}

function templatePreviewText(value: string, fallback: string) {
  return value.trim() ? value.trim() : fallback
}

function renderedTemplateExample(value: string, fallback: string) {
  const trimmed = value.trim()
  if (!trimmed) return fallback
  const rendered = renderDingTalkTemplateExample(trimmed).trim()
  return rendered || fallback
}

function copyPreviewText(key: string, text: string) {
  const trimmed = text.trim()
  if (!trimmed || !navigator.clipboard?.writeText) return
  void navigator.clipboard.writeText(trimmed).then(() => {
    copiedPreviewKey.value = key
    if (copiedPreviewResetTimer) window.clearTimeout(copiedPreviewResetTimer)
    copiedPreviewResetTimer = window.setTimeout(() => {
      if (copiedPreviewKey.value === key) copiedPreviewKey.value = ''
    }, 1500)
  }).catch(() => {})
}

const dingTalkPersonRecipientSummary = computed(() => {
  if (!selectedDingTalkPersonRecipients.value.length) return 'No recipients selected'
  return selectedDingTalkPersonRecipients.value.map((item) => item.label).join(', ')
})

const dingTalkPersonRecipientFieldSummary = computed(() => {
  const trimmed = draft.value.dingtalkPersonRecipientFieldPath.trim()
  if (!trimmed) return 'No dynamic recipient field'
  const normalized = trimmed.replace(/^record\./, '')
  return normalized ? `record.${normalized}` : 'No dynamic recipient field'
})

function templateSyntaxWarnings(value: string) {
  return listDingTalkTemplateSyntaxWarnings(value)
}

onBeforeUnmount(() => {
  if (copiedPreviewResetTimer) window.clearTimeout(copiedPreviewResetTimer)
})

function applyGroupPreset(preset: DingTalkNotificationPreset) {
  const next = applyDingTalkNotificationPreset(
    {
      titleTemplate: draft.value.dingtalkTitleTemplate,
      bodyTemplate: draft.value.dingtalkBodyTemplate,
      publicFormViewId: draft.value.publicFormViewId,
      internalViewId: draft.value.internalViewId,
    },
    preset,
    props.views ?? [],
  )
  draft.value.dingtalkTitleTemplate = next.titleTemplate ?? ''
  draft.value.dingtalkBodyTemplate = next.bodyTemplate ?? ''
  draft.value.publicFormViewId = next.publicFormViewId ?? ''
  draft.value.internalViewId = next.internalViewId ?? ''
}

function applyPersonPreset(preset: DingTalkNotificationPreset) {
  const next = applyDingTalkNotificationPreset(
    {
      titleTemplate: draft.value.dingtalkPersonTitleTemplate,
      bodyTemplate: draft.value.dingtalkPersonBodyTemplate,
      publicFormViewId: draft.value.dingtalkPersonPublicFormViewId,
      internalViewId: draft.value.dingtalkPersonInternalViewId,
    },
    preset,
    props.views ?? [],
  )
  draft.value.dingtalkPersonTitleTemplate = next.titleTemplate ?? ''
  draft.value.dingtalkPersonBodyTemplate = next.bodyTemplate ?? ''
  draft.value.dingtalkPersonPublicFormViewId = next.publicFormViewId ?? ''
  draft.value.dingtalkPersonInternalViewId = next.internalViewId ?? ''
}

function appendGroupTemplateToken(field: 'title' | 'body', token: string) {
  if (field === 'title') {
    draft.value.dingtalkTitleTemplate = appendTemplateToken(draft.value.dingtalkTitleTemplate, token)
    return
  }
  draft.value.dingtalkBodyTemplate = appendTemplateToken(draft.value.dingtalkBodyTemplate, token, true)
}

function appendPersonTemplateToken(field: 'title' | 'body', token: string) {
  if (field === 'title') {
    draft.value.dingtalkPersonTitleTemplate = appendTemplateToken(draft.value.dingtalkPersonTitleTemplate, token)
    return
  }
  draft.value.dingtalkPersonBodyTemplate = appendTemplateToken(draft.value.dingtalkPersonBodyTemplate, token, true)
}

// --- Rule editor + log viewer state ---
const showRuleEditor = ref(false)
const editingRule = ref<AutomationRule | null>(null)
const showLogViewer = ref(false)
const logViewerRuleId = ref('')
const showGroupDeliveryViewer = ref(false)
const groupDeliveryViewerRuleId = ref('')
const showPersonDeliveryViewer = ref(false)
const personDeliveryViewerRuleId = ref('')
const ruleStats = ref<Record<string, AutomationStats>>({})

function openRuleEditor(rule?: AutomationRule) {
  editingRule.value = rule ?? null
  editingRuleId.value = rule?.id ?? null
  showRuleEditor.value = true
  showForm.value = false
}

function openLogViewer(rule: AutomationRule) {
  logViewerRuleId.value = rule.id
  showLogViewer.value = true
}

function openGroupDeliveryViewer(rule: AutomationRule) {
  groupDeliveryViewerRuleId.value = rule.id
  showGroupDeliveryViewer.value = true
}

function openPersonDeliveryViewer(rule: AutomationRule) {
  personDeliveryViewerRuleId.value = rule.id
  showPersonDeliveryViewer.value = true
}

async function onRuleEditorSave(payload: Partial<AutomationRule>) {
  try {
    if (editingRule.value?.id) {
      await updateRule(props.sheetId, editingRule.value.id, payload)
    } else {
      await createRule(props.sheetId, payload as Omit<AutomationRule, 'id' | 'sheetId' | 'enabled' | 'createdAt' | 'updatedAt' | 'createdBy'>)
    }
    showRuleEditor.value = false
    editingRule.value = null
    emit('updated')
  } catch {
    // error ref is set by composable
  }
}

async function onTestRule(ruleId: string) {
  if (!props.client) return
  try {
    await props.client.testAutomationRule(props.sheetId, ruleId)
  } catch {
    // silently fail
  }
}

async function loadRuleStats() {
  if (!props.client) return
  for (const rule of rules.value) {
    try {
      const st = await props.client.getAutomationStats(props.sheetId, rule.id)
      ruleStats.value[rule.id] = st
    } catch {
      // skip
    }
  }
}

const canSave = computed(() => {
  if (!draft.value.name.trim()) return false
  if (draft.value.triggerType === 'field.changed' && !draft.value.triggerFieldId) return false
  if (draft.value.actionType === 'notify' && !draft.value.notifyMessage.trim()) return false
  if (draft.value.actionType === 'update_field' && (!draft.value.targetFieldId || !draft.value.targetValue.trim())) return false
  if (draft.value.actionType === 'send_dingtalk_group_message') {
    if (!draft.value.dingtalkDestinationId) return false
    if (!draft.value.dingtalkTitleTemplate.trim()) return false
    if (!draft.value.dingtalkBodyTemplate.trim()) return false
  }
  if (draft.value.actionType === 'send_dingtalk_person_message') {
    if (!draft.value.dingtalkPersonUserIds.trim() && !draft.value.dingtalkPersonRecipientFieldPath.trim()) return false
    if (!draft.value.dingtalkPersonTitleTemplate.trim()) return false
    if (!draft.value.dingtalkPersonBodyTemplate.trim()) return false
  }
  return true
})

function openCreateForm() {
  editingRuleId.value = null
  draft.value = emptyDraft()
  dingtalkPersonUserSearch.value = ''
  dingtalkPersonUserSuggestions.value = []
  dingtalkPersonUserSearchError.value = ''
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
    dingtalkDestinationId: (rule.actionConfig?.destinationId as string) ?? '',
    dingtalkTitleTemplate: (rule.actionConfig?.titleTemplate as string) ?? '',
    dingtalkBodyTemplate: (rule.actionConfig?.bodyTemplate as string) ?? '',
    publicFormViewId: (rule.actionConfig?.publicFormViewId as string) ?? '',
    internalViewId: (rule.actionConfig?.internalViewId as string) ?? '',
    dingtalkPersonUserIds: Array.isArray(rule.actionConfig?.userIds) ? rule.actionConfig?.userIds.join(', ') : '',
    dingtalkPersonRecipientFieldPath: (rule.actionConfig?.userIdFieldPath as string) ?? '',
    dingtalkPersonTitleTemplate: (rule.actionConfig?.titleTemplate as string) ?? '',
    dingtalkPersonBodyTemplate: (rule.actionConfig?.bodyTemplate as string) ?? '',
    dingtalkPersonPublicFormViewId: (rule.actionConfig?.publicFormViewId as string) ?? '',
    dingtalkPersonInternalViewId: (rule.actionConfig?.internalViewId as string) ?? '',
  }
  dingtalkPersonUserSearch.value = ''
  dingtalkPersonUserSuggestions.value = []
  dingtalkPersonUserSearchError.value = ''
  showForm.value = true
}

function cancelForm() {
  showForm.value = false
  editingRuleId.value = null
  draft.value = emptyDraft()
  dingtalkPersonUserSearch.value = ''
  dingtalkPersonUserSuggestions.value = []
  dingtalkPersonUserSearchError.value = ''
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
  if (draft.value.actionType === 'send_dingtalk_group_message') {
    return {
      destinationId: draft.value.dingtalkDestinationId,
      titleTemplate: draft.value.dingtalkTitleTemplate,
      bodyTemplate: draft.value.dingtalkBodyTemplate,
      publicFormViewId: draft.value.publicFormViewId || undefined,
      internalViewId: draft.value.internalViewId || undefined,
    }
  }
  if (draft.value.actionType === 'send_dingtalk_person_message') {
    return {
      userIds: draft.value.dingtalkPersonUserIds
        .split(/[\n,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
      userIdFieldPath: draft.value.dingtalkPersonRecipientFieldPath.trim() || undefined,
      titleTemplate: draft.value.dingtalkPersonTitleTemplate,
      bodyTemplate: draft.value.dingtalkPersonBodyTemplate,
      publicFormViewId: draft.value.dingtalkPersonPublicFormViewId || undefined,
      internalViewId: draft.value.dingtalkPersonInternalViewId || undefined,
    }
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
    case 'send_dingtalk_group_message':
      return 'Send DingTalk group message'
    case 'send_dingtalk_person_message':
      return 'Send DingTalk person message'
    default:
      return String(rule.actionType)
  }
}

watch(
  () => props.visible,
  async (v) => {
    if (v && props.sheetId) {
      if (props.client) {
        try {
          dingTalkDestinations.value = await props.client.listDingTalkGroups(props.sheetId)
        } catch {
          dingTalkDestinations.value = []
        }
      }
      await loadRules(props.sheetId)
      cancelForm()
      void loadRuleStats()
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

.meta-automation__hint {
  font-size: 12px;
  color: #64748b;
}

.meta-automation__hint--error {
  color: #b91c1c;
}

.meta-automation__hint--warning {
  color: #b45309;
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

.meta-automation__recipient-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.meta-automation__recipient-list--selected {
  margin-bottom: 4px;
}

.meta-automation__preset-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.meta-automation__preset-label {
  font-size: 12px;
  font-weight: 600;
  color: #475569;
}

.meta-automation__preview {
  border: 1px solid #dbeafe;
  background: #f8fbff;
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #334155;
}

.meta-automation__preview-title {
  font-weight: 700;
  color: #1e3a8a;
}

.meta-automation__preview-line {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.meta-automation__preview-body {
  white-space: pre-wrap;
}

.meta-automation__copy-btn {
  flex-shrink: 0;
  border: 1px solid #bfdbfe;
  background: #fff;
  color: #1d4ed8;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
}

.meta-automation__recipient-option,
.meta-automation__recipient-chip {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  background: #fff;
  padding: 8px 10px;
  cursor: pointer;
  color: #0f172a;
}

.meta-automation__recipient-option span,
.meta-automation__recipient-chip span,
.meta-automation__recipient-chip em {
  font-size: 12px;
  color: #64748b;
  font-style: normal;
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

.meta-automation__card-stats {
  display: flex;
  gap: 10px;
  font-size: 12px;
}

.meta-automation__stat { font-weight: 600; }
.meta-automation__stat--success { color: #16a34a; }
.meta-automation__stat--failed { color: #dc2626; }
</style>
