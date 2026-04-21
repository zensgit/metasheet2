<template>
  <div v-if="visible" class="meta-rule-editor__overlay" @click.self="$emit('close')">
    <div class="meta-rule-editor">
      <div class="meta-rule-editor__header">
        <h4 class="meta-rule-editor__title">{{ rule ? 'Edit Automation Rule' : 'New Automation Rule' }}</h4>
        <button class="meta-rule-editor__close" type="button" @click="$emit('close')">&times;</button>
      </div>

      <div class="meta-rule-editor__body">
        <div v-if="error" class="meta-rule-editor__error" role="alert">{{ error }}</div>

        <!-- Name -->
        <label class="meta-rule-editor__label">Name</label>
        <input v-model="draft.name" class="meta-rule-editor__input" type="text" placeholder="Automation name" data-field="name" />

        <!-- 1. Trigger selector -->
        <section class="meta-rule-editor__section">
          <div class="meta-rule-editor__section-title">Trigger</div>
          <select v-model="draft.triggerType" class="meta-rule-editor__select" data-field="triggerType">
            <option value="record.created">When record created</option>
            <option value="record.updated">When record updated</option>
            <option value="record.deleted">When record deleted</option>
            <option value="field.value_changed">When field value changed</option>
            <option value="schedule.cron">Schedule (cron)</option>
            <option value="schedule.interval">Schedule (interval)</option>
            <option value="webhook.received">Webhook received</option>
          </select>

          <!-- field.value_changed config -->
          <template v-if="draft.triggerType === 'field.value_changed'">
            <label class="meta-rule-editor__label">Watch field</label>
            <select v-model="draft.triggerConfig.fieldId" class="meta-rule-editor__select" data-field="triggerFieldId">
              <option value="">-- select field --</option>
              <option v-for="f in fields" :key="f.id" :value="f.id">{{ f.name }}</option>
            </select>
            <label class="meta-rule-editor__label">Condition</label>
            <select v-model="draft.triggerConfig.condition" class="meta-rule-editor__select" data-field="triggerCondition">
              <option value="any">Any change</option>
              <option value="equals">Equals</option>
              <option value="changed_to">Changed to</option>
            </select>
            <template v-if="draft.triggerConfig.condition !== 'any'">
              <label class="meta-rule-editor__label">Value</label>
              <input v-model="draft.triggerConfig.value" class="meta-rule-editor__input" type="text" placeholder="Value" data-field="triggerValue" />
            </template>
          </template>

          <!-- schedule.cron config -->
          <template v-if="draft.triggerType === 'schedule.cron'">
            <label class="meta-rule-editor__label">Preset</label>
            <select v-model="cronPreset" class="meta-rule-editor__select" data-field="cronPreset">
              <option value="*/5 * * * *">Every 5 minutes</option>
              <option value="0 * * * *">Every hour</option>
              <option value="0 0 * * *">Daily at midnight</option>
              <option value="0 0 * * 1">Weekly (Monday)</option>
              <option value="custom">Custom</option>
            </select>
            <template v-if="cronPreset === 'custom'">
              <label class="meta-rule-editor__label">Cron expression</label>
              <input v-model="draft.triggerConfig.cron" class="meta-rule-editor__input" type="text" placeholder="* * * * *" data-field="cronExpression" />
            </template>
          </template>

          <!-- schedule.interval config -->
          <template v-if="draft.triggerType === 'schedule.interval'">
            <label class="meta-rule-editor__label">Interval (minutes)</label>
            <input v-model.number="draft.triggerConfig.intervalMinutes" class="meta-rule-editor__input" type="number" min="1" placeholder="5" data-field="intervalMinutes" />
          </template>
        </section>

        <!-- 2. Conditions -->
        <section class="meta-rule-editor__section">
          <div class="meta-rule-editor__section-title">
            Conditions
            <span class="meta-rule-editor__hint">(optional)</span>
          </div>
          <div v-if="draft.conditions.conditions.length > 1" class="meta-rule-editor__conjunction">
            <button
              type="button"
              class="meta-rule-editor__toggle-btn"
              :class="{ 'meta-rule-editor__toggle-btn--active': draft.conditions.conjunction === 'AND' }"
              @click="draft.conditions.conjunction = 'AND'"
            >AND</button>
            <button
              type="button"
              class="meta-rule-editor__toggle-btn"
              :class="{ 'meta-rule-editor__toggle-btn--active': draft.conditions.conjunction === 'OR' }"
              @click="draft.conditions.conjunction = 'OR'"
            >OR</button>
          </div>
          <div
            v-for="(cond, idx) in draft.conditions.conditions"
            :key="idx"
            class="meta-rule-editor__condition-row"
            :data-condition-index="idx"
          >
            <select v-model="cond.fieldId" class="meta-rule-editor__select meta-rule-editor__select--sm">
              <option value="">-- field --</option>
              <option v-for="f in fields" :key="f.id" :value="f.id">{{ f.name }}</option>
            </select>
            <select v-model="cond.operator" class="meta-rule-editor__select meta-rule-editor__select--sm">
              <option v-for="op in conditionOperators" :key="op.value" :value="op.value">{{ op.label }}</option>
            </select>
            <input
              v-if="!isUnaryOperator(cond.operator)"
              v-model="cond.value"
              class="meta-rule-editor__input meta-rule-editor__input--sm"
              type="text"
              placeholder="Value"
            />
            <button class="meta-rule-editor__btn meta-rule-editor__btn--icon" type="button" @click="removeCondition(idx)" title="Remove condition">&times;</button>
          </div>
          <button class="meta-rule-editor__btn" type="button" data-action="add-condition" @click="addCondition">+ Add condition</button>
        </section>

        <!-- 3. Actions -->
        <section class="meta-rule-editor__section">
          <div class="meta-rule-editor__section-title">Actions <span class="meta-rule-editor__hint">(1-3 steps)</span></div>
          <div
            v-for="(action, idx) in draft.actions"
            :key="idx"
            class="meta-rule-editor__action-row"
            :data-action-index="idx"
          >
            <div class="meta-rule-editor__action-header">
              <span class="meta-rule-editor__action-num">{{ idx + 1 }}.</span>
              <select v-model="action.type" class="meta-rule-editor__select" @change="onDraftActionTypeChange(action)">
                <option value="update_record">Update record</option>
                <option value="create_record">Create record</option>
                <option value="send_webhook">Send webhook</option>
                <option value="send_notification">Send notification</option>
                <option value="send_dingtalk_group_message">Send DingTalk group message</option>
                <option value="send_dingtalk_person_message">Send DingTalk person message</option>
                <option value="lock_record">Lock record</option>
              </select>
              <div class="meta-rule-editor__action-btns">
                <button v-if="idx > 0" class="meta-rule-editor__btn meta-rule-editor__btn--icon" type="button" @click="moveAction(idx, -1)" title="Move up">&#x2191;</button>
                <button v-if="idx < draft.actions.length - 1" class="meta-rule-editor__btn meta-rule-editor__btn--icon" type="button" @click="moveAction(idx, 1)" title="Move down">&#x2193;</button>
                <button class="meta-rule-editor__btn meta-rule-editor__btn--icon" type="button" @click="removeAction(idx)" title="Remove action">&times;</button>
              </div>
            </div>

            <!-- update_record config -->
            <div v-if="action.type === 'update_record'" class="meta-rule-editor__action-config">
              <div v-for="(pair, pidx) in (action.config.fieldUpdates as FieldPair[] || [])" :key="pidx" class="meta-rule-editor__field-pair">
                <select v-model="pair.fieldId" class="meta-rule-editor__select meta-rule-editor__select--sm">
                  <option value="">-- field --</option>
                  <option v-for="f in fields" :key="f.id" :value="f.id">{{ f.name }}</option>
                </select>
                <input v-model="pair.value" class="meta-rule-editor__input meta-rule-editor__input--sm" type="text" placeholder="Value" />
                <button class="meta-rule-editor__btn meta-rule-editor__btn--icon" type="button" @click="removeFieldUpdate(action, pidx)">&times;</button>
              </div>
              <button class="meta-rule-editor__btn" type="button" @click="addFieldUpdate(action)">+ Field</button>
            </div>

            <!-- create_record config -->
            <div v-if="action.type === 'create_record'" class="meta-rule-editor__action-config">
              <label class="meta-rule-editor__label">Target sheet ID</label>
              <input v-model="action.config.targetSheetId" class="meta-rule-editor__input" type="text" placeholder="Sheet ID" />
              <div v-for="(pair, pidx) in (action.config.fieldValues as FieldPair[] || [])" :key="pidx" class="meta-rule-editor__field-pair">
                <input v-model="pair.fieldId" class="meta-rule-editor__input meta-rule-editor__input--sm" type="text" placeholder="Field ID" />
                <input v-model="pair.value" class="meta-rule-editor__input meta-rule-editor__input--sm" type="text" placeholder="Value" />
                <button class="meta-rule-editor__btn meta-rule-editor__btn--icon" type="button" @click="removeCreateFieldValue(action, pidx)">&times;</button>
              </div>
              <button class="meta-rule-editor__btn" type="button" @click="addCreateFieldValue(action)">+ Field</button>
            </div>

            <!-- send_webhook config -->
            <div v-if="action.type === 'send_webhook'" class="meta-rule-editor__action-config">
              <label class="meta-rule-editor__label">URL</label>
              <input v-model="action.config.url" class="meta-rule-editor__input" type="url" placeholder="https://..." />
              <label class="meta-rule-editor__label">Method</label>
              <select v-model="action.config.method" class="meta-rule-editor__select">
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
                <option value="GET">GET</option>
              </select>
            </div>

            <!-- send_notification config -->
            <div v-if="action.type === 'send_notification'" class="meta-rule-editor__action-config">
              <label class="meta-rule-editor__label">User ID</label>
              <input v-model="action.config.userId" class="meta-rule-editor__input" type="text" placeholder="User ID" />
              <label class="meta-rule-editor__label">Message</label>
              <textarea v-model="action.config.message" class="meta-rule-editor__textarea" placeholder="Notification message" rows="3"></textarea>
            </div>

            <!-- send_dingtalk_group_message config -->
            <div v-if="action.type === 'send_dingtalk_group_message'" class="meta-rule-editor__action-config">
              <div class="meta-rule-editor__preset-row">
                <span class="meta-rule-editor__preset-label">Message preset</span>
                <button class="meta-rule-editor__btn" type="button" data-field="groupPresetForm" @click="applyGroupPreset(action, 'form_request')">Form request</button>
                <button class="meta-rule-editor__btn" type="button" data-field="groupPresetInternal" @click="applyGroupPreset(action, 'internal_process')">Internal processing</button>
                <button class="meta-rule-editor__btn" type="button" data-field="groupPresetBoth" @click="applyGroupPreset(action, 'form_and_process')">Form + processing</button>
              </div>
              <label class="meta-rule-editor__label">Add DingTalk groups</label>
              <select
                v-model="action.config.destinationPickerId"
                class="meta-rule-editor__select"
                data-field="dingtalkDestinationPickerId"
                @change="appendGroupDestination(action, $event.target as HTMLSelectElement)"
              >
                <option value="">-- add DingTalk group --</option>
                <option v-for="destination in availableGroupDestinations(action)" :key="destination.id" :value="destination.id">
                  {{ destination.name }}
                </option>
              </select>
              <div
                v-if="selectedGroupDestinations(action).length"
                class="meta-rule-editor__recipient-list meta-rule-editor__recipient-list--selected"
              >
                <button
                  v-for="destination in selectedGroupDestinations(action)"
                  :key="destination.id"
                  class="meta-rule-editor__recipient-chip"
                  type="button"
                  :data-group-destination="destination.id"
                  @click="removeGroupDestination(action, destination.id)"
                >
                  <strong>{{ destination.label }}</strong>
                  <span>{{ destination.subtitle || destination.id }}</span>
                  <em>Remove</em>
                </button>
              </div>
              <div v-if="dingTalkDestinationsError" class="meta-rule-editor__hint">{{ dingTalkDestinationsError }}</div>
              <label class="meta-rule-editor__label">Record group field paths (optional)</label>
              <input
                v-model="action.config.destinationFieldPath"
                class="meta-rule-editor__input"
                type="text"
                placeholder="record.opsDestinationId, record.escalationDestinationIds"
                data-field="dingtalkDestinationFieldPath"
              />
              <label class="meta-rule-editor__label">Pick group field</label>
              <select
                class="meta-rule-editor__select"
                data-field="dingtalkDestinationFieldSelect"
                @change="appendGroupDestinationFieldPath(action, $event.target as HTMLSelectElement)"
              >
                <option value="">-- pick field --</option>
                <option v-for="field in groupDestinationCandidateFields" :key="field.id" :value="field.id">
                  {{ field.name }}
                </option>
              </select>
              <div
                v-if="selectedGroupDestinationFields(action).length"
                class="meta-rule-editor__recipient-list meta-rule-editor__recipient-list--selected"
              >
                <button
                  v-for="field in selectedGroupDestinationFields(action)"
                  :key="field.id"
                  class="meta-rule-editor__recipient-chip"
                  type="button"
                  :data-group-destination-field="field.id"
                  @click="removeGroupDestinationFieldPath(action, field.id)"
                >
                  <strong>{{ field.label }}</strong>
                  <span>{{ field.id }}</span>
                  <em>Remove</em>
                </button>
              </div>
              <div
                v-for="warning in groupDestinationFieldPathWarnings(action.config.destinationFieldPath)"
                :key="`group-destination-${warning}`"
                class="meta-rule-editor__hint meta-rule-editor__hint--warning"
              >
                {{ warning }}
              </div>
              <label class="meta-rule-editor__label">Title template</label>
              <input
                v-model="action.config.titleTemplate"
                class="meta-rule-editor__input"
                type="text"
                placeholder="例如：{{record.title}} 待处理"
                data-field="dingtalkTitleTemplate"
              />
              <div
                v-for="warning in templateSyntaxWarnings(action.config.titleTemplate)"
                :key="`group-title-${warning}`"
                class="meta-rule-editor__hint meta-rule-editor__hint--warning"
              >
                {{ warning }}
              </div>
              <div class="meta-rule-editor__token-row">
                <span class="meta-rule-editor__preset-label">Template tokens</span>
                <button
                  v-for="token in DINGTALK_TITLE_TEMPLATE_TOKENS"
                  :key="token.key"
                  class="meta-rule-editor__btn"
                  type="button"
                  :data-field="`groupTitleToken-${token.key}`"
                  @click="appendGroupTemplateToken(action, 'titleTemplate', token.value)"
                >
                  {{ token.label }}
                </button>
              </div>
              <label class="meta-rule-editor__label">Body template</label>
              <textarea
                v-model="action.config.bodyTemplate"
                class="meta-rule-editor__textarea"
                rows="4"
                placeholder="支持 {{record.xxx}}、{{recordId}}、{{sheetId}}、{{actorId}}"
                data-field="dingtalkBodyTemplate"
              ></textarea>
              <div
                v-for="warning in templateSyntaxWarnings(action.config.bodyTemplate)"
                :key="`group-body-${warning}`"
                class="meta-rule-editor__hint meta-rule-editor__hint--warning"
              >
                {{ warning }}
              </div>
              <div class="meta-rule-editor__token-row">
                <span class="meta-rule-editor__preset-label">Template tokens</span>
                <button
                  v-for="token in DINGTALK_BODY_TEMPLATE_TOKENS"
                  :key="token.key"
                  class="meta-rule-editor__btn"
                  type="button"
                  :data-field="`groupBodyToken-${token.key}`"
                  @click="appendGroupTemplateToken(action, 'bodyTemplate', token.value, true)"
                >
                  {{ token.label }}
                </button>
              </div>
              <label class="meta-rule-editor__label">Public form view (optional)</label>
              <select
                v-model="action.config.publicFormViewId"
                class="meta-rule-editor__select"
                data-field="publicFormViewId"
              >
                <option value="">-- no public form link --</option>
                <option v-for="view in formViews" :key="view.id" :value="view.id">{{ view.name }}</option>
              </select>
              <div
                v-for="warning in publicFormLinkWarnings(action.config.publicFormViewId, true)"
                :key="`group-public-form-${warning}`"
                class="meta-rule-editor__hint meta-rule-editor__hint--warning"
              >
                {{ warning }}
              </div>
              <label class="meta-rule-editor__label">Internal processing view (optional)</label>
              <select
                v-model="action.config.internalViewId"
                class="meta-rule-editor__select"
                data-field="internalViewId"
              >
                <option value="">-- no internal link --</option>
                <option v-for="view in internalViews" :key="view.id" :value="view.id">{{ view.name }}</option>
              </select>
              <div class="meta-rule-editor__preview" data-field="groupMessageSummary">
                <div class="meta-rule-editor__preview-title">Message summary</div>
                <div><strong>Groups:</strong> {{ dingTalkGroupSummary(action) }}</div>
                <div><strong>Record groups:</strong> {{ groupDestinationFieldPathSummary(action.config.destinationFieldPath) }}</div>
                <div><strong>Title template:</strong> {{ templatePreviewText(action.config.titleTemplate, 'No title template') }}</div>
                <div class="meta-rule-editor__preview-body"><strong>Body template:</strong> {{ templatePreviewText(action.config.bodyTemplate, 'No body template') }}</div>
                <div class="meta-rule-editor__preview-line">
                  <span><strong>Rendered title:</strong> {{ renderedTemplateExample(action.config.titleTemplate, 'No rendered title') }}</span>
                  <button
                    class="meta-rule-editor__copy-btn"
                    type="button"
                    :data-field="`groupRenderedTitleCopy-${idx}`"
                    @click="copyPreviewText(`group-title-${idx}`, renderedTemplateExample(action.config.titleTemplate, ''))"
                  >
                    {{ copiedPreviewKey === `group-title-${idx}` ? 'Copied' : 'Copy' }}
                  </button>
                </div>
                <div class="meta-rule-editor__preview-line meta-rule-editor__preview-body">
                  <span><strong>Rendered body:</strong> {{ renderedTemplateExample(action.config.bodyTemplate, 'No rendered body') }}</span>
                  <button
                    class="meta-rule-editor__copy-btn"
                    type="button"
                    :data-field="`groupRenderedBodyCopy-${idx}`"
                    @click="copyPreviewText(`group-body-${idx}`, renderedTemplateExample(action.config.bodyTemplate, ''))"
                  >
                    {{ copiedPreviewKey === `group-body-${idx}` ? 'Copied' : 'Copy' }}
                  </button>
                </div>
                <div><strong>Public form:</strong> {{ viewSummaryName(action.config.publicFormViewId, 'No public form link') }}</div>
                <div><strong>Public form access:</strong> {{ publicFormAccessSummary(action.config.publicFormViewId) }}</div>
                <div><strong>Internal processing:</strong> {{ viewSummaryName(action.config.internalViewId, 'No internal link') }}</div>
              </div>
            </div>

            <!-- send_dingtalk_person_message config -->
            <div v-if="action.type === 'send_dingtalk_person_message'" class="meta-rule-editor__action-config">
              <div class="meta-rule-editor__preset-row">
                <span class="meta-rule-editor__preset-label">Message preset</span>
                <button class="meta-rule-editor__btn" type="button" data-field="personPresetForm" @click="applyPersonPreset(action, 'form_request')">Form request</button>
                <button class="meta-rule-editor__btn" type="button" data-field="personPresetInternal" @click="applyPersonPreset(action, 'internal_process')">Internal processing</button>
                <button class="meta-rule-editor__btn" type="button" data-field="personPresetBoth" @click="applyPersonPreset(action, 'form_and_process')">Form + processing</button>
              </div>
              <label class="meta-rule-editor__label">Search and add users or member groups</label>
              <input
                v-model="action.config.userIdsSearch"
                class="meta-rule-editor__input"
                type="text"
                placeholder="Search by user, member group, email, or subject ID"
                data-field="dingtalkPersonUserSearch"
                @input="void loadPersonRecipientSuggestions(idx, action)"
              />
              <div v-if="personRecipientLoading[idx]" class="meta-rule-editor__hint">Searching users and member groups…</div>
              <div v-else-if="personRecipientErrors[idx]" class="meta-rule-editor__hint meta-rule-editor__hint--error">{{ personRecipientErrors[idx] }}</div>
              <div v-else-if="availablePersonRecipientSuggestions(idx, action).length" class="meta-rule-editor__recipient-list">
                <button
                  v-for="candidate in availablePersonRecipientSuggestions(idx, action)"
                  :key="personRecipientCandidateKey(candidate)"
                  class="meta-rule-editor__recipient-option"
                  type="button"
                  :data-person-recipient-suggestion="personRecipientCandidateKey(candidate)"
                  @click="addPersonRecipient(action, candidate, idx)"
                >
                  <strong>{{ candidate.label }}</strong>
                  <span>{{ candidate.subtitle || candidate.subjectId }}</span>
                </button>
              </div>
              <div v-else-if="typeof action.config.userIdsSearch === 'string' && action.config.userIdsSearch.trim()" class="meta-rule-editor__hint">No matching users or member groups</div>
              <div v-if="selectedPersonRecipients(action).length" class="meta-rule-editor__recipient-list meta-rule-editor__recipient-list--selected">
                <button
                  v-for="recipient in selectedPersonRecipients(action)"
                  :key="recipient.id"
                  class="meta-rule-editor__recipient-chip"
                  type="button"
                  :data-person-recipient="recipient.id"
                  @click="removePersonRecipient(action, recipient.id)"
                >
                  <strong>{{ recipient.label }}</strong>
                  <span>{{ recipient.subtitle || recipient.id }}</span>
                  <em>Remove</em>
                </button>
              </div>
              <div v-if="selectedPersonRecipientGroups(action).length" class="meta-rule-editor__recipient-list meta-rule-editor__recipient-list--selected">
                <button
                  v-for="group in selectedPersonRecipientGroups(action)"
                  :key="group.id"
                  class="meta-rule-editor__recipient-chip"
                  type="button"
                  :data-person-member-group="group.id"
                  @click="removePersonRecipientGroup(action, group.id)"
                >
                  <strong>{{ group.label }}</strong>
                  <span>{{ group.subtitle || group.id }}</span>
                  <em>Remove</em>
                </button>
              </div>
              <label class="meta-rule-editor__label">Local user IDs</label>
              <textarea
                v-model="action.config.userIdsText"
                class="meta-rule-editor__textarea"
                rows="3"
                placeholder="使用逗号或换行分隔本地 userId"
                data-field="dingtalkPersonUserIds"
              ></textarea>
              <label class="meta-rule-editor__label">Member group IDs (optional)</label>
              <textarea
                v-model="action.config.memberGroupIdsText"
                class="meta-rule-editor__textarea"
                rows="2"
                placeholder="使用逗号或换行分隔成员组 ID"
                data-field="dingtalkPersonMemberGroupIds"
              ></textarea>
              <label class="meta-rule-editor__label">Record recipient field paths (optional)</label>
              <input
                v-model="action.config.recipientFieldPath"
                class="meta-rule-editor__input"
                type="text"
                placeholder="例如：record.assigneeUserIds, record.reviewerUserId"
                data-field="dingtalkPersonRecipientFieldPath"
              />
              <label class="meta-rule-editor__label">Pick recipient field</label>
              <select
                class="meta-rule-editor__select"
                data-field="dingtalkPersonRecipientFieldSelect"
                @change="appendRecipientFieldPath(action, ($event.target as HTMLSelectElement))"
              >
                <option value="">-- choose a user field --</option>
                <option v-for="field in recipientCandidateFields" :key="field.id" :value="field.id">
                  {{ field.name }} (record.{{ field.id }})
                </option>
              </select>
              <div
                v-if="selectedRecipientFields(action).length"
                class="meta-rule-editor__recipient-list meta-rule-editor__recipient-list--selected"
              >
                <button
                  v-for="field in selectedRecipientFields(action)"
                  :key="field.id"
                  class="meta-rule-editor__recipient-chip"
                  type="button"
                  :data-field-recipient="field.id"
                  @click="removeRecipientFieldPath(action, field.id)"
                >
                  <strong>{{ field.label }}</strong>
                  <em>Remove</em>
                </button>
              </div>
              <div
                v-for="warning in recipientFieldPathWarnings(action.config.recipientFieldPath)"
                :key="`person-recipient-${warning}`"
                class="meta-rule-editor__hint meta-rule-editor__hint--warning"
              >
                {{ warning }}
              </div>
              <div class="meta-rule-editor__hint">
                Record data is keyed by field ID. Use comma or newline separated <code>record.&lt;fieldId&gt;</code> paths. The picker only lists user fields.
              </div>
              <label class="meta-rule-editor__label">Record member group field paths (optional)</label>
              <input
                v-model="action.config.memberGroupRecipientFieldPath"
                class="meta-rule-editor__input"
                type="text"
                placeholder="例如：record.watcherGroupIds, record.escalationGroupId"
                data-field="dingtalkPersonMemberGroupRecipientFieldPath"
              />
              <label class="meta-rule-editor__label">Pick member group field</label>
              <select
                class="meta-rule-editor__select"
                data-field="dingtalkPersonMemberGroupRecipientFieldSelect"
                @change="appendMemberGroupRecipientFieldPath(action, $event.target as HTMLSelectElement)"
              >
                <option value="">-- choose a member group field --</option>
                <option v-for="field in memberGroupRecipientCandidateFields" :key="field.id" :value="field.id">
                  {{ field.name }} (record.{{ field.id }})
                </option>
              </select>
              <div
                v-if="selectedMemberGroupRecipientFields(action).length"
                class="meta-rule-editor__recipient-list meta-rule-editor__recipient-list--selected"
              >
                <button
                  v-for="field in selectedMemberGroupRecipientFields(action)"
                  :key="field.id"
                  class="meta-rule-editor__recipient-chip"
                  type="button"
                  :data-member-group-recipient-field="field.id"
                  @click="removeMemberGroupRecipientFieldPath(action, field.id)"
                >
                  <strong>{{ field.label }}</strong>
                  <em>Remove</em>
                </button>
              </div>
              <div
                v-for="warning in memberGroupRecipientFieldPathWarnings(action.config.memberGroupRecipientFieldPath)"
                :key="`person-member-group-recipient-${warning}`"
                class="meta-rule-editor__hint meta-rule-editor__hint--warning"
              >
                {{ warning }}
              </div>
              <div class="meta-rule-editor__hint">
                Use comma or newline separated <code>record.&lt;fieldId&gt;</code> paths whose values resolve to member group IDs. The picker only lists explicit member group fields.
              </div>
              <label class="meta-rule-editor__label">Title template</label>
              <input
                v-model="action.config.titleTemplate"
                class="meta-rule-editor__input"
                type="text"
                placeholder="例如：{{record.title}} 待处理"
                data-field="dingtalkPersonTitleTemplate"
              />
              <div
                v-for="warning in templateSyntaxWarnings(action.config.titleTemplate)"
                :key="`person-title-${warning}`"
                class="meta-rule-editor__hint meta-rule-editor__hint--warning"
              >
                {{ warning }}
              </div>
              <div class="meta-rule-editor__token-row">
                <span class="meta-rule-editor__preset-label">Template tokens</span>
                <button
                  v-for="token in DINGTALK_TITLE_TEMPLATE_TOKENS"
                  :key="token.key"
                  class="meta-rule-editor__btn"
                  type="button"
                  :data-field="`personTitleToken-${token.key}`"
                  @click="appendPersonTemplateToken(action, 'titleTemplate', token.value)"
                >
                  {{ token.label }}
                </button>
              </div>
              <label class="meta-rule-editor__label">Body template</label>
              <textarea
                v-model="action.config.bodyTemplate"
                class="meta-rule-editor__textarea"
                rows="4"
                placeholder="支持 {{record.xxx}}、{{recordId}}、{{sheetId}}、{{actorId}}"
                data-field="dingtalkPersonBodyTemplate"
              ></textarea>
              <div
                v-for="warning in templateSyntaxWarnings(action.config.bodyTemplate)"
                :key="`person-body-${warning}`"
                class="meta-rule-editor__hint meta-rule-editor__hint--warning"
              >
                {{ warning }}
              </div>
              <div class="meta-rule-editor__token-row">
                <span class="meta-rule-editor__preset-label">Template tokens</span>
                <button
                  v-for="token in DINGTALK_BODY_TEMPLATE_TOKENS"
                  :key="token.key"
                  class="meta-rule-editor__btn"
                  type="button"
                  :data-field="`personBodyToken-${token.key}`"
                  @click="appendPersonTemplateToken(action, 'bodyTemplate', token.value, true)"
                >
                  {{ token.label }}
                </button>
              </div>
              <label class="meta-rule-editor__label">Public form view (optional)</label>
              <select
                v-model="action.config.publicFormViewId"
                class="meta-rule-editor__select"
                data-field="dingtalkPersonPublicFormViewId"
              >
                <option value="">-- no public form link --</option>
                <option v-for="view in formViews" :key="view.id" :value="view.id">{{ view.name }}</option>
              </select>
              <div
                v-for="warning in publicFormLinkWarnings(action.config.publicFormViewId)"
                :key="`person-public-form-${warning}`"
                class="meta-rule-editor__hint meta-rule-editor__hint--warning"
              >
                {{ warning }}
              </div>
              <label class="meta-rule-editor__label">Internal processing view (optional)</label>
              <select
                v-model="action.config.internalViewId"
                class="meta-rule-editor__select"
                data-field="dingtalkPersonInternalViewId"
              >
                <option value="">-- no internal link --</option>
                <option v-for="view in internalViews" :key="view.id" :value="view.id">{{ view.name }}</option>
              </select>
              <div class="meta-rule-editor__preview" data-field="personMessageSummary">
                <div class="meta-rule-editor__preview-title">Message summary</div>
                <div><strong>Recipients:</strong> {{ personRecipientSummary(action) }}</div>
                <div><strong>Record recipients:</strong> {{ recipientFieldPathSummary(action.config.recipientFieldPath) }}</div>
                <div><strong>Record member groups:</strong> {{ recipientFieldPathSummary(action.config.memberGroupRecipientFieldPath) }}</div>
                <div><strong>Title template:</strong> {{ templatePreviewText(action.config.titleTemplate, 'No title template') }}</div>
                <div class="meta-rule-editor__preview-body"><strong>Body template:</strong> {{ templatePreviewText(action.config.bodyTemplate, 'No body template') }}</div>
                <div class="meta-rule-editor__preview-line">
                  <span><strong>Rendered title:</strong> {{ renderedTemplateExample(action.config.titleTemplate, 'No rendered title') }}</span>
                  <button
                    class="meta-rule-editor__copy-btn"
                    type="button"
                    :data-field="`personRenderedTitleCopy-${idx}`"
                    @click="copyPreviewText(`person-title-${idx}`, renderedTemplateExample(action.config.titleTemplate, ''))"
                  >
                    {{ copiedPreviewKey === `person-title-${idx}` ? 'Copied' : 'Copy' }}
                  </button>
                </div>
                <div class="meta-rule-editor__preview-line meta-rule-editor__preview-body">
                  <span><strong>Rendered body:</strong> {{ renderedTemplateExample(action.config.bodyTemplate, 'No rendered body') }}</span>
                  <button
                    class="meta-rule-editor__copy-btn"
                    type="button"
                    :data-field="`personRenderedBodyCopy-${idx}`"
                    @click="copyPreviewText(`person-body-${idx}`, renderedTemplateExample(action.config.bodyTemplate, ''))"
                  >
                    {{ copiedPreviewKey === `person-body-${idx}` ? 'Copied' : 'Copy' }}
                  </button>
                </div>
                <div><strong>Public form:</strong> {{ viewSummaryName(action.config.publicFormViewId, 'No public form link') }}</div>
                <div><strong>Public form access:</strong> {{ publicFormAccessSummary(action.config.publicFormViewId) }}</div>
                <div><strong>Internal processing:</strong> {{ viewSummaryName(action.config.internalViewId, 'No internal link') }}</div>
              </div>
            </div>

            <!-- lock_record config -->
            <div v-if="action.type === 'lock_record'" class="meta-rule-editor__action-config">
              <label class="meta-rule-editor__toggle-label">
                <input type="checkbox" v-model="action.config.locked" />
                Lock record
              </label>
            </div>
          </div>
          <button
            v-if="draft.actions.length < 3"
            class="meta-rule-editor__btn"
            type="button"
            data-action="add-action"
            @click="addAction"
          >+ Add action</button>
        </section>
      </div>

      <!-- Footer -->
      <div class="meta-rule-editor__footer">
        <button class="meta-rule-editor__btn meta-rule-editor__btn--primary" type="button" :disabled="!canSave || saving" data-action="save" @click="onSave">
          {{ saving ? 'Saving...' : 'Save' }}
        </button>
        <button class="meta-rule-editor__btn" type="button" :disabled="saving" @click="onTestRun" data-action="test">Test Run</button>
        <button class="meta-rule-editor__btn" type="button" @click="$emit('close')">Cancel</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import type { MultitableApiClient } from '../api/client'
import type {
  AutomationRule,
  AutomationTriggerType,
  AutomationActionType,
  ConditionOperator,
  AutomationAction,
  AutomationCondition,
  DingTalkGroupDestination,
  MetaSheetPermissionCandidate,
  MetaView,
} from '../types'
import { applyDingTalkNotificationPreset, type DingTalkNotificationPreset } from '../utils/dingtalkNotificationPresets'
import {
  appendTemplateToken,
  DINGTALK_BODY_TEMPLATE_TOKENS,
  DINGTALK_TITLE_TEMPLATE_TOKENS,
} from '../utils/dingtalkNotificationTemplateTokens'
import { listDingTalkTemplateSyntaxWarnings } from '../utils/dingtalkNotificationTemplateLint'
import { renderDingTalkTemplateExample } from '../utils/dingtalkNotificationTemplateExample'
import {
  isDingTalkMemberGroupRecipientField,
  listDingTalkGroupDestinationFieldPathWarnings,
} from '../utils/dingtalkRecipientFieldWarnings'
import {
  describeDingTalkPublicFormLinkAccess,
  listDingTalkPublicFormLinkBlockingErrors,
  listDingTalkPublicFormLinkWarnings,
} from '../utils/dingtalkPublicFormLinkWarnings'

interface FieldPair {
  fieldId: string
  value: string
}

type DraftActionConfig = Record<string, unknown> & {
  fieldUpdates?: FieldPair[]
  targetSheetId?: string
  fieldValues?: FieldPair[]
  url?: string
  method?: string
  userId?: string
  userIdsText?: string
  memberGroupIdsText?: string
  userIdsSearch?: string
  recipientFieldPath?: string
  memberGroupRecipientFieldPath?: string
  message?: string
  destinationId?: string
  destinationIds?: string[]
  destinationPickerId?: string
  destinationFieldPath?: string
  titleTemplate?: string
  bodyTemplate?: string
  publicFormViewId?: string
  internalViewId?: string
  locked?: boolean
}

interface DraftAction {
  type: AutomationActionType
  config: DraftActionConfig
}

interface Draft {
  name: string
  triggerType: AutomationTriggerType
  triggerConfig: Record<string, unknown>
  conditions: { conjunction: 'AND' | 'OR'; conditions: AutomationCondition[] }
  actions: DraftAction[]
}

const props = defineProps<{
  sheetId: string
  rule?: AutomationRule
  visible: boolean
  fields: Array<{ id: string; name: string; type: string; property?: Record<string, unknown> }>
  client?: MultitableApiClient
  views?: MetaView[]
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'save', payload: Partial<AutomationRule>): void
  (e: 'test', ruleId: string): void
}>()

const error = ref('')
const saving = ref(false)
const cronPreset = ref('0 * * * *')
const dingTalkDestinations = ref<DingTalkGroupDestination[]>([])
const dingTalkDestinationsError = ref('')
const personRecipientSuggestions = ref<Record<number, MetaSheetPermissionCandidate[]>>({})
const personRecipientLoading = ref<Record<number, boolean>>({})
const personRecipientErrors = ref<Record<number, string>>({})
const personRecipientDirectory = ref<Record<string, { label: string; subtitle?: string }>>({})
const copiedPreviewKey = ref('')
let personRecipientSuggestionLoadId = 0
let copiedPreviewResetTimer: ReturnType<typeof setTimeout> | null = null

const formViews = computed(() => (props.views ?? []).filter((view) => view.type === 'form'))
const internalViews = computed(() => props.views ?? [])
const groupDestinationCandidateFields = computed(() => props.fields)
const recipientCandidateFields = computed(() => props.fields.filter((field) => field.type === 'user'))
const memberGroupRecipientCandidateFields = computed(() => props.fields.filter(isDingTalkMemberGroupRecipientField))

const conditionOperators: Array<{ value: ConditionOperator; label: string }> = [
  { value: 'equals', label: 'Equals' },
  { value: 'not_equals', label: 'Not equals' },
  { value: 'contains', label: 'Contains' },
  { value: 'not_contains', label: 'Not contains' },
  { value: 'greater_than', label: 'Greater than' },
  { value: 'less_than', label: 'Less than' },
  { value: 'greater_or_equal', label: 'Greater or equal' },
  { value: 'less_or_equal', label: 'Less or equal' },
  { value: 'is_empty', label: 'Is empty' },
  { value: 'is_not_empty', label: 'Is not empty' },
]

function isUnaryOperator(op: ConditionOperator): boolean {
  return op === 'is_empty' || op === 'is_not_empty'
}

function emptyDraft(): Draft {
  return {
    name: '',
    triggerType: 'record.created',
    triggerConfig: {},
    conditions: { conjunction: 'AND', conditions: [] },
    actions: [{ type: 'update_record', config: defaultConfigForActionType('update_record') }],
  }
}

function draftConfigFromAction(type: AutomationActionType, config: Record<string, unknown>): DraftActionConfig {
  if (type === 'send_dingtalk_group_message') {
    return {
      ...config,
      destinationIds: parseGroupDestinationIds(config.destinationIds ?? config.destinationId),
      destinationFieldPath: Array.isArray(config.destinationIdFieldPaths)
        ? config.destinationIdFieldPaths.join(', ')
        : typeof config.destinationIdFieldPath === 'string'
          ? config.destinationIdFieldPath
          : '',
      destinationPickerId: '',
    }
  }
  if (type === 'send_dingtalk_person_message') {
    return {
      ...config,
      userIdsText: Array.isArray(config.userIds)
        ? config.userIds.join(', ')
        : '',
      memberGroupIdsText: Array.isArray(config.memberGroupIds)
        ? config.memberGroupIds.join(', ')
        : '',
      recipientFieldPath: Array.isArray(config.userIdFieldPaths)
        ? config.userIdFieldPaths.join(', ')
        : typeof config.userIdFieldPath === 'string'
          ? config.userIdFieldPath
          : '',
      memberGroupRecipientFieldPath: Array.isArray(config.memberGroupIdFieldPaths)
        ? config.memberGroupIdFieldPaths.join(', ')
        : typeof config.memberGroupIdFieldPath === 'string'
          ? config.memberGroupIdFieldPath
          : '',
      userIdsSearch: '',
    }
  }
  return { ...config }
}

function draftFromRule(rule: AutomationRule): Draft {
  return {
    name: rule.name,
    triggerType: rule.triggerType,
    triggerConfig: { ...rule.triggerConfig, ...(rule.trigger?.config ?? {}) },
    conditions: rule.conditions
      ? { conjunction: rule.conditions.conjunction, conditions: rule.conditions.conditions.map((c) => ({ ...c })) }
      : { conjunction: 'AND', conditions: [] },
    actions: rule.actions && rule.actions.length
      ? rule.actions.map((a) => ({ type: a.type, config: draftConfigFromAction(a.type, a.config) }))
      : [{ type: rule.actionType, config: draftConfigFromAction(rule.actionType, rule.actionConfig) }],
  }
}

const draft = ref<Draft>(emptyDraft())

watch(
  () => props.visible,
  async (v) => {
    if (v) {
      draft.value = props.rule ? draftFromRule(props.rule) : emptyDraft()
      error.value = ''
      saving.value = false
      dingTalkDestinationsError.value = ''
      personRecipientSuggestions.value = {}
      personRecipientLoading.value = {}
      personRecipientErrors.value = {}
      if (props.client) {
        try {
          dingTalkDestinations.value = await props.client.listDingTalkGroups(props.sheetId)
        } catch (err) {
          dingTalkDestinations.value = []
          dingTalkDestinationsError.value = err instanceof Error ? err.message : 'Failed to load DingTalk groups'
        }
      } else {
        dingTalkDestinations.value = []
      }
    }
  },
  { immediate: true },
)

const canSave = computed(() => {
  if (!draft.value.name.trim()) return false
  if (draft.value.actions.length < 1) return false
  for (const action of draft.value.actions) {
    if (action.type === 'send_dingtalk_group_message') {
      const destinationIds = parseGroupDestinationIds(action.config.destinationIds ?? action.config.destinationId)
      const destinationFieldPath = typeof action.config.destinationFieldPath === 'string' ? action.config.destinationFieldPath.trim() : ''
      const titleTemplate = typeof action.config.titleTemplate === 'string' ? action.config.titleTemplate.trim() : ''
      const bodyTemplate = typeof action.config.bodyTemplate === 'string' ? action.config.bodyTemplate.trim() : ''
      if ((!destinationIds.length && !destinationFieldPath) || !titleTemplate || !bodyTemplate) return false
      if (publicFormLinkBlockingErrors(action.config.publicFormViewId).length) return false
    }
    if (action.type === 'send_dingtalk_person_message') {
      const userIdsText = typeof action.config.userIdsText === 'string' ? action.config.userIdsText.trim() : ''
      const memberGroupIdsText = typeof action.config.memberGroupIdsText === 'string' ? action.config.memberGroupIdsText.trim() : ''
      const recipientFieldPath = typeof action.config.recipientFieldPath === 'string' ? action.config.recipientFieldPath.trim() : ''
      const memberGroupRecipientFieldPath = typeof action.config.memberGroupRecipientFieldPath === 'string'
        ? action.config.memberGroupRecipientFieldPath.trim()
        : ''
      const titleTemplate = typeof action.config.titleTemplate === 'string' ? action.config.titleTemplate.trim() : ''
      const bodyTemplate = typeof action.config.bodyTemplate === 'string' ? action.config.bodyTemplate.trim() : ''
      if ((!userIdsText && !memberGroupIdsText && !recipientFieldPath && !memberGroupRecipientFieldPath) || !titleTemplate || !bodyTemplate) return false
      if (publicFormLinkBlockingErrors(action.config.publicFormViewId).length) return false
    }
  }
  return true
})

function addCondition() {
  draft.value.conditions.conditions.push({ fieldId: '', operator: 'equals', value: '' })
}

function removeCondition(idx: number) {
  draft.value.conditions.conditions.splice(idx, 1)
}

function addAction() {
  if (draft.value.actions.length >= 3) return
  draft.value.actions.push({ type: 'update_record', config: defaultConfigForActionType('update_record') })
}

function parseUserIdsText(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function parseGroupDestinationIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean),
    ))
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()]
  }
  return []
}

function parseMemberGroupIdsText(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function personRecipientDirectoryKey(subjectType: 'user' | 'member-group', subjectId: string) {
  return `${subjectType}:${subjectId}`
}

function personRecipientCandidateKey(candidate: MetaSheetPermissionCandidate) {
  return personRecipientDirectoryKey(candidate.subjectType === 'member-group' ? 'member-group' : 'user', candidate.subjectId)
}

function rememberPersonRecipientSuggestions(items: MetaSheetPermissionCandidate[]) {
  const next = { ...personRecipientDirectory.value }
  for (const item of items) {
    if (item.subjectType !== 'user' && item.subjectType !== 'member-group') continue
    next[personRecipientDirectoryKey(item.subjectType, item.subjectId)] = { label: item.label, subtitle: item.subtitle ?? undefined }
  }
  personRecipientDirectory.value = next
}

function selectedPersonRecipients(action: DraftAction) {
  return parseUserIdsText(action.config.userIdsText).map((id) => ({
    id,
    label: personRecipientDirectory.value[personRecipientDirectoryKey('user', id)]?.label ?? id,
    subtitle: personRecipientDirectory.value[personRecipientDirectoryKey('user', id)]?.subtitle,
  }))
}

function selectedPersonRecipientGroups(action: DraftAction) {
  return parseMemberGroupIdsText(action.config.memberGroupIdsText).map((id) => ({
    id,
    label: personRecipientDirectory.value[personRecipientDirectoryKey('member-group', id)]?.label ?? id,
    subtitle: personRecipientDirectory.value[personRecipientDirectoryKey('member-group', id)]?.subtitle,
  }))
}

function availablePersonRecipientSuggestions(idx: number, action: DraftAction) {
  const selected = new Set(parseUserIdsText(action.config.userIdsText))
  const selectedGroups = new Set(parseMemberGroupIdsText(action.config.memberGroupIdsText))
  return (personRecipientSuggestions.value[idx] ?? []).filter((candidate) => {
    if (candidate.subjectType === 'member-group') return !selectedGroups.has(candidate.subjectId)
    return !selected.has(candidate.subjectId)
  })
}

async function loadPersonRecipientSuggestions(idx: number, action: DraftAction) {
  const query = typeof action.config.userIdsSearch === 'string' ? action.config.userIdsSearch.trim() : ''
  if (!props.client || !query) {
    personRecipientSuggestions.value = { ...personRecipientSuggestions.value, [idx]: [] }
    personRecipientErrors.value = { ...personRecipientErrors.value, [idx]: '' }
    personRecipientLoading.value = { ...personRecipientLoading.value, [idx]: false }
    return
  }

  const requestId = ++personRecipientSuggestionLoadId
  personRecipientLoading.value = { ...personRecipientLoading.value, [idx]: true }
  personRecipientErrors.value = { ...personRecipientErrors.value, [idx]: '' }
  try {
    const response = await props.client.listFormShareCandidates(props.sheetId, {
      q: query,
      limit: 8,
    })
    if (requestId !== personRecipientSuggestionLoadId) return
    rememberPersonRecipientSuggestions(response.items)
    personRecipientSuggestions.value = { ...personRecipientSuggestions.value, [idx]: response.items }
  } catch (error) {
    if (requestId !== personRecipientSuggestionLoadId) return
    personRecipientSuggestions.value = { ...personRecipientSuggestions.value, [idx]: [] }
    personRecipientErrors.value = {
      ...personRecipientErrors.value,
      [idx]: error instanceof Error ? error.message : 'Failed to search users and member groups',
    }
  } finally {
    if (requestId === personRecipientSuggestionLoadId) {
      personRecipientLoading.value = { ...personRecipientLoading.value, [idx]: false }
    }
  }
}

function addPersonRecipient(action: DraftAction, candidate: MetaSheetPermissionCandidate, idx: number) {
  if (candidate.subjectType === 'member-group') {
    const ids = new Set(parseMemberGroupIdsText(action.config.memberGroupIdsText))
    ids.add(candidate.subjectId)
    action.config.memberGroupIdsText = Array.from(ids).join(', ')
  } else {
    const ids = new Set(parseUserIdsText(action.config.userIdsText))
    ids.add(candidate.subjectId)
    action.config.userIdsText = Array.from(ids).join(', ')
  }
  action.config.userIdsSearch = ''
  rememberPersonRecipientSuggestions([candidate])
  personRecipientSuggestions.value = { ...personRecipientSuggestions.value, [idx]: [] }
  personRecipientErrors.value = { ...personRecipientErrors.value, [idx]: '' }
}

function removePersonRecipient(action: DraftAction, userId: string) {
  action.config.userIdsText = parseUserIdsText(action.config.userIdsText)
    .filter((id) => id !== userId)
    .join(', ')
}

function selectedGroupDestinations(action: DraftAction) {
  return parseGroupDestinationIds(action.config.destinationIds ?? action.config.destinationId).map((id) => {
    const destination = dingTalkDestinations.value.find((item) => item.id === id)
    return {
      id,
      label: destination?.name ?? id,
      subtitle: destination?.sheetId ? `sheet: ${destination.sheetId}` : undefined,
    }
  })
}

function selectedGroupDestinationFields(action: DraftAction) {
  return parseRecipientFieldPathsText(action.config.destinationFieldPath)
    .map((path) => ({
      id: path,
      label: recipientFieldSummaryLabel(path),
    }))
    .filter((item) => item.label)
}

function availableGroupDestinations(action: DraftAction) {
  const selected = new Set(parseGroupDestinationIds(action.config.destinationIds ?? action.config.destinationId))
  return dingTalkDestinations.value.filter((destination) => !selected.has(destination.id))
}

function appendGroupDestination(action: DraftAction, select: HTMLSelectElement) {
  const destinationId = select.value.trim()
  if (!destinationId) return
  const destinationIds = parseGroupDestinationIds(action.config.destinationIds ?? action.config.destinationId)
  destinationIds.push(destinationId)
  action.config.destinationIds = Array.from(new Set(destinationIds))
  action.config.destinationId = action.config.destinationIds[0] || ''
  action.config.destinationPickerId = ''
  select.value = ''
}

function removeGroupDestination(action: DraftAction, destinationId: string) {
  action.config.destinationIds = parseGroupDestinationIds(action.config.destinationIds ?? action.config.destinationId)
    .filter((id) => id !== destinationId)
  action.config.destinationId = action.config.destinationIds[0] || ''
}

function dingTalkGroupSummary(action: DraftAction) {
  const selected = selectedGroupDestinations(action)
  if (!selected.length) return 'No groups selected'
  return selected.map((item) => item.label).join(', ')
}

function groupDestinationFieldPathWarnings(value: unknown) {
  return listDingTalkGroupDestinationFieldPathWarnings(value, props.fields)
}

function groupDestinationFieldPathSummary(value: unknown) {
  const labels = parseRecipientFieldPathsText(value)
    .map((path) => recipientFieldSummaryLabel(path))
    .filter(Boolean)
  if (!labels.length) return 'No dynamic group field'
  return labels.join(', ')
}

function appendGroupDestinationFieldPath(action: DraftAction, select: HTMLSelectElement) {
  const fieldId = select.value.trim()
  if (!fieldId) return
  const paths = parseRecipientFieldPathsText(action.config.destinationFieldPath)
  paths.push(fieldId)
  action.config.destinationFieldPath = Array.from(new Set(paths))
    .map((path) => `record.${path}`)
    .join(', ')
  select.value = ''
}

function removeGroupDestinationFieldPath(action: DraftAction, path: string) {
  action.config.destinationFieldPath = parseRecipientFieldPathsText(action.config.destinationFieldPath)
    .filter((entry) => entry !== path)
    .map((entry) => `record.${entry}`)
    .join(', ')
}

function removePersonRecipientGroup(action: DraftAction, groupId: string) {
  action.config.memberGroupIdsText = parseMemberGroupIdsText(action.config.memberGroupIdsText)
    .filter((id) => id !== groupId)
    .join(', ')
}

function viewSummaryName(viewId: unknown, fallback: string) {
  const id = typeof viewId === 'string' ? viewId : ''
  if (!id) return fallback
  return (props.views ?? []).find((view) => view.id === id)?.name ?? id
}

function templatePreviewText(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function renderedTemplateExample(value: unknown, fallback: string) {
  if (typeof value !== 'string' || !value.trim()) return fallback
  const rendered = renderDingTalkTemplateExample(value).trim()
  return rendered || fallback
}

function publicFormLinkWarnings(value: unknown, warnWhenGroupAccessRisk = false) {
  return listDingTalkPublicFormLinkWarnings(value, props.views ?? [], {
    warnWhenFullyPublic: warnWhenGroupAccessRisk,
    warnWhenProtectedWithoutAllowlist: warnWhenGroupAccessRisk,
  })
}

function publicFormLinkBlockingErrors(value: unknown) {
  return listDingTalkPublicFormLinkBlockingErrors(value, props.views ?? [])
}

function publicFormAccessSummary(value: unknown) {
  return describeDingTalkPublicFormLinkAccess(value, props.views ?? [])
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

function personRecipientSummary(action: DraftAction) {
  const selectedUsers = selectedPersonRecipients(action).map((item) => item.label)
  const selectedGroups = selectedPersonRecipientGroups(action).map((item) => item.label)
  const parts = [
    selectedUsers.length ? `Users: ${selectedUsers.join(', ')}` : '',
    selectedGroups.length ? `Groups: ${selectedGroups.join(', ')}` : '',
  ].filter(Boolean)
  if (!parts.length) return 'No recipients selected'
  return parts.join(' | ')
}

function parseRecipientFieldPathsText(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return Array.from(new Set(
    value
      .split(/[\n,]+/)
      .map((entry) => entry.trim().replace(/^record\./, ''))
      .filter(Boolean),
  ))
}

function recipientFieldSummaryLabel(path: string) {
  const normalized = path.trim().replace(/^record\./, '')
  if (!normalized) return ''
  const field = props.fields.find((item) => item.id === normalized)
  return field ? `${field.name} (record.${normalized})` : `record.${normalized}`
}

function selectedRecipientFields(action: DraftAction) {
  return parseRecipientFieldPathsText(action.config.recipientFieldPath)
    .map((path) => ({
      id: path,
      label: recipientFieldSummaryLabel(path),
    }))
    .filter((item) => item.label)
}

function selectedMemberGroupRecipientFields(action: DraftAction) {
  return parseRecipientFieldPathsText(action.config.memberGroupRecipientFieldPath)
    .map((path) => ({
      id: path,
      label: recipientFieldSummaryLabel(path),
    }))
    .filter((item) => item.label)
}

function recipientFieldPathWarnings(value: unknown) {
  const candidateIds = new Set(recipientCandidateFields.value.map((field) => field.id))
  return parseRecipientFieldPathsText(value)
    .filter((path) => !candidateIds.has(path))
    .map((path) => `record.${path} is not a user field; DingTalk person messages expect local user IDs.`)
}

function memberGroupRecipientFieldPathWarnings(value: unknown) {
  const fieldMap = new Map(props.fields.map((field) => [field.id, field]))
  return parseRecipientFieldPathsText(value).flatMap((path) => {
    const field = fieldMap.get(path)
    if (!field) {
      return [`record.${path} is not a known field in this sheet; DingTalk person member-group recipients expect field IDs that resolve to member group IDs.`]
    }
    if (field.type === 'user') {
      return [`record.${path} is a user field; use Record recipient field paths instead.`]
    }
    return []
  })
}

function recipientFieldPathSummary(value: unknown) {
  const labels = parseRecipientFieldPathsText(value)
    .map((path) => recipientFieldSummaryLabel(path))
    .filter(Boolean)
  if (!labels.length) return 'No dynamic recipient field'
  return labels.join(', ')
}

function appendRecipientFieldPath(action: DraftAction, select: HTMLSelectElement) {
  const fieldId = select.value.trim()
  if (!fieldId) return
  const paths = parseRecipientFieldPathsText(action.config.recipientFieldPath)
  paths.push(fieldId)
  action.config.recipientFieldPath = Array.from(new Set(paths))
    .map((path) => `record.${path}`)
    .join(', ')
  select.value = ''
}

function removeRecipientFieldPath(action: DraftAction, path: string) {
  action.config.recipientFieldPath = parseRecipientFieldPathsText(action.config.recipientFieldPath)
    .filter((entry) => entry !== path)
    .map((entry) => `record.${entry}`)
    .join(', ')
}

function appendMemberGroupRecipientFieldPath(action: DraftAction, select: HTMLSelectElement) {
  const fieldId = select.value.trim()
  if (!fieldId) return
  const paths = parseRecipientFieldPathsText(action.config.memberGroupRecipientFieldPath)
  paths.push(fieldId)
  action.config.memberGroupRecipientFieldPath = Array.from(new Set(paths))
    .map((path) => `record.${path}`)
    .join(', ')
  select.value = ''
}

function removeMemberGroupRecipientFieldPath(action: DraftAction, path: string) {
  action.config.memberGroupRecipientFieldPath = parseRecipientFieldPathsText(action.config.memberGroupRecipientFieldPath)
    .filter((entry) => entry !== path)
    .map((entry) => `record.${entry}`)
    .join(', ')
}

function templateSyntaxWarnings(value: unknown) {
  return typeof value === 'string' ? listDingTalkTemplateSyntaxWarnings(value) : []
}

onBeforeUnmount(() => {
  if (copiedPreviewResetTimer) window.clearTimeout(copiedPreviewResetTimer)
})

function applyGroupPreset(action: DraftAction, preset: DingTalkNotificationPreset) {
  action.config = {
    ...action.config,
    ...applyDingTalkNotificationPreset(
      {
        titleTemplate: typeof action.config.titleTemplate === 'string' ? action.config.titleTemplate : '',
        bodyTemplate: typeof action.config.bodyTemplate === 'string' ? action.config.bodyTemplate : '',
        publicFormViewId: typeof action.config.publicFormViewId === 'string' ? action.config.publicFormViewId : '',
        internalViewId: typeof action.config.internalViewId === 'string' ? action.config.internalViewId : '',
      },
      preset,
      props.views ?? [],
    ),
  }
}

function applyPersonPreset(action: DraftAction, preset: DingTalkNotificationPreset) {
  action.config = {
    ...action.config,
    ...applyDingTalkNotificationPreset(
      {
        titleTemplate: typeof action.config.titleTemplate === 'string' ? action.config.titleTemplate : '',
        bodyTemplate: typeof action.config.bodyTemplate === 'string' ? action.config.bodyTemplate : '',
        publicFormViewId: typeof action.config.publicFormViewId === 'string' ? action.config.publicFormViewId : '',
        internalViewId: typeof action.config.internalViewId === 'string' ? action.config.internalViewId : '',
      },
      preset,
      props.views ?? [],
    ),
  }
}

function appendGroupTemplateToken(
  action: DraftAction,
  field: 'titleTemplate' | 'bodyTemplate',
  token: string,
  multiline = false,
) {
  const current = typeof action.config[field] === 'string' ? action.config[field] : ''
  action.config[field] = appendTemplateToken(current, token, multiline)
}

function appendPersonTemplateToken(
  action: DraftAction,
  field: 'titleTemplate' | 'bodyTemplate',
  token: string,
  multiline = false,
) {
  const current = typeof action.config[field] === 'string' ? action.config[field] : ''
  action.config[field] = appendTemplateToken(current, token, multiline)
}

function defaultConfigForActionType(type: AutomationActionType): DraftActionConfig {
  switch (type) {
    case 'update_record':
      return { fieldUpdates: [] }
    case 'create_record':
      return { fieldValues: [] }
    case 'send_webhook':
      return { method: 'POST' }
    case 'send_notification':
      return { userId: '', message: '' }
    case 'send_dingtalk_group_message':
      return {
        destinationId: '',
        destinationIds: [],
        destinationPickerId: '',
        destinationFieldPath: '',
        titleTemplate: '',
        bodyTemplate: '',
        publicFormViewId: '',
        internalViewId: '',
      }
    case 'send_dingtalk_person_message':
      return {
        userIdsText: '',
        memberGroupIdsText: '',
        userIdsSearch: '',
        recipientFieldPath: '',
        memberGroupRecipientFieldPath: '',
        titleTemplate: '',
        bodyTemplate: '',
        publicFormViewId: '',
        internalViewId: '',
      }
    case 'lock_record':
      return { locked: true }
    default:
      return {}
  }
}

function onDraftActionTypeChange(action: DraftAction) {
  action.config = defaultConfigForActionType(action.type)
}

function removeAction(idx: number) {
  draft.value.actions.splice(idx, 1)
}

function moveAction(idx: number, dir: number) {
  const target = idx + dir
  if (target < 0 || target >= draft.value.actions.length) return
  const arr = draft.value.actions
  ;[arr[idx], arr[target]] = [arr[target], arr[idx]]
}

function addFieldUpdate(action: DraftAction) {
  if (!Array.isArray(action.config.fieldUpdates)) action.config.fieldUpdates = []
  ;(action.config.fieldUpdates as FieldPair[]).push({ fieldId: '', value: '' })
}

function removeFieldUpdate(action: DraftAction, idx: number) {
  ;(action.config.fieldUpdates as FieldPair[]).splice(idx, 1)
}

function addCreateFieldValue(action: DraftAction) {
  if (!Array.isArray(action.config.fieldValues)) action.config.fieldValues = []
  ;(action.config.fieldValues as FieldPair[]).push({ fieldId: '', value: '' })
}

function removeCreateFieldValue(action: DraftAction, idx: number) {
  ;(action.config.fieldValues as FieldPair[]).splice(idx, 1)
}

function buildPayload(): Partial<AutomationRule> {
  const d = draft.value
  const triggerConfig = { ...d.triggerConfig }
  if (d.triggerType === 'schedule.cron' && cronPreset.value !== 'custom') {
    triggerConfig.cron = cronPreset.value
  }
  const actions = d.actions.map((action) => {
    if (action.type === 'send_dingtalk_group_message') {
      const destinationIds = parseGroupDestinationIds(action.config.destinationIds ?? action.config.destinationId)
      const destinationIdFieldPaths = parseRecipientFieldPathsText(action.config.destinationFieldPath)
        .map((path) => `record.${path}`)
      return {
        type: action.type,
        config: {
          destinationId: destinationIds[0] || undefined,
          destinationIds: destinationIds.length ? destinationIds : undefined,
          ...(destinationIdFieldPaths[0] ? { destinationIdFieldPath: destinationIdFieldPaths[0] } : {}),
          ...(destinationIdFieldPaths.length ? { destinationIdFieldPaths } : {}),
          titleTemplate: typeof action.config.titleTemplate === 'string' ? action.config.titleTemplate.trim() : '',
          bodyTemplate: typeof action.config.bodyTemplate === 'string' ? action.config.bodyTemplate.trim() : '',
          publicFormViewId: typeof action.config.publicFormViewId === 'string' && action.config.publicFormViewId.trim()
            ? action.config.publicFormViewId.trim()
            : undefined,
          internalViewId: typeof action.config.internalViewId === 'string' && action.config.internalViewId.trim()
            ? action.config.internalViewId.trim()
            : undefined,
        },
      }
    }
    if (action.type === 'send_dingtalk_person_message') {
      const userIds = typeof action.config.userIdsText === 'string'
        ? action.config.userIdsText
          .split(/[\n,]+/)
          .map((entry) => entry.trim())
          .filter(Boolean)
        : []
      const memberGroupIds = typeof action.config.memberGroupIdsText === 'string'
        ? action.config.memberGroupIdsText
          .split(/[\n,]+/)
          .map((entry) => entry.trim())
          .filter(Boolean)
        : []
      const userIdFieldPaths = parseRecipientFieldPathsText(action.config.recipientFieldPath)
        .map((path) => `record.${path}`)
      const memberGroupIdFieldPaths = parseRecipientFieldPathsText(action.config.memberGroupRecipientFieldPath)
        .map((path) => `record.${path}`)
      return {
        type: action.type,
        config: {
          userIds,
          memberGroupIds: memberGroupIds.length ? memberGroupIds : undefined,
          ...(userIdFieldPaths[0] ? { userIdFieldPath: userIdFieldPaths[0] } : {}),
          ...(userIdFieldPaths.length ? { userIdFieldPaths } : {}),
          ...(memberGroupIdFieldPaths[0] ? { memberGroupIdFieldPath: memberGroupIdFieldPaths[0] } : {}),
          ...(memberGroupIdFieldPaths.length ? { memberGroupIdFieldPaths } : {}),
          titleTemplate: typeof action.config.titleTemplate === 'string' ? action.config.titleTemplate.trim() : '',
          bodyTemplate: typeof action.config.bodyTemplate === 'string' ? action.config.bodyTemplate.trim() : '',
          publicFormViewId: typeof action.config.publicFormViewId === 'string' && action.config.publicFormViewId.trim()
            ? action.config.publicFormViewId.trim()
            : undefined,
          internalViewId: typeof action.config.internalViewId === 'string' && action.config.internalViewId.trim()
            ? action.config.internalViewId.trim()
            : undefined,
        },
      }
    }
    return { type: action.type, config: action.config }
  })
  return {
    name: d.name.trim(),
    triggerType: d.triggerType,
    triggerConfig,
    trigger: { type: d.triggerType, config: triggerConfig },
    conditions: d.conditions.conditions.length > 0 ? d.conditions : undefined,
    actions,
    actionType: actions[0]?.type ?? 'update_record',
    actionConfig: actions[0]?.config ?? {},
  }
}

async function onSave() {
  if (!canSave.value) return
  saving.value = true
  error.value = ''
  try {
    emit('save', buildPayload())
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Save failed'
  } finally {
    saving.value = false
  }
}

function onTestRun() {
  if (props.rule?.id) {
    emit('test', props.rule.id)
  }
}
</script>

<style scoped>
.meta-rule-editor__overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
}

.meta-rule-editor {
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
  width: 640px;
  max-width: 95vw;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
}

.meta-rule-editor__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 20px 12px;
  border-bottom: 1px solid #e2e8f0;
}

.meta-rule-editor__title { margin: 0; font-size: 16px; font-weight: 700; color: #0f172a; }
.meta-rule-editor__close { border: none; background: none; font-size: 22px; cursor: pointer; color: #64748b; line-height: 1; padding: 0 4px; }

.meta-rule-editor__body {
  padding: 16px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
}

.meta-rule-editor__error { padding: 10px 12px; border-radius: 10px; font-size: 13px; background: #fef2f2; color: #b91c1c; }

.meta-rule-editor__section {
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.meta-rule-editor__section-title { font-size: 14px; font-weight: 600; color: #0f172a; }
.meta-rule-editor__hint { font-weight: 400; color: #94a3b8; font-size: 12px; }

.meta-rule-editor__label { font-size: 12px; font-weight: 600; color: #475569; margin-top: 4px; }

.meta-rule-editor__hint--error { color: #b91c1c; }

.meta-rule-editor__hint--warning { color: #b45309; }

.meta-rule-editor__input,
.meta-rule-editor__select,
.meta-rule-editor__textarea {
  width: 100%;
  min-width: 0;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 13px;
  background: #fff;
  box-sizing: border-box;
}

.meta-rule-editor__textarea { resize: vertical; font-family: inherit; }

.meta-rule-editor__input--sm,
.meta-rule-editor__select--sm {
  flex: 1;
  min-width: 80px;
}

.meta-rule-editor__condition-row,
.meta-rule-editor__field-pair {
  display: flex;
  gap: 6px;
  align-items: center;
}

.meta-rule-editor__conjunction { display: flex; gap: 4px; }

.meta-rule-editor__toggle-btn {
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 4px 12px;
  background: #fff;
  font-size: 12px;
  cursor: pointer;
  color: #475569;
}

.meta-rule-editor__toggle-btn--active {
  background: #2563eb;
  border-color: #2563eb;
  color: #fff;
}

.meta-rule-editor__action-row {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.meta-rule-editor__action-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.meta-rule-editor__action-num { font-weight: 700; font-size: 14px; color: #2563eb; }

.meta-rule-editor__action-btns { display: flex; gap: 4px; margin-left: auto; }

.meta-rule-editor__action-config {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-left: 20px;
}

.meta-rule-editor__preset-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.meta-rule-editor__token-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0 12px;
}

.meta-rule-editor__preset-label {
  font-size: 12px;
  font-weight: 600;
  color: #475569;
}

.meta-rule-editor__preview {
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

.meta-rule-editor__preview-title {
  font-weight: 700;
  color: #1e3a8a;
}

.meta-rule-editor__preview-line {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.meta-rule-editor__preview-body {
  white-space: pre-wrap;
}

.meta-rule-editor__copy-btn {
  flex-shrink: 0;
  border: 1px solid #bfdbfe;
  background: #fff;
  color: #1d4ed8;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
}

.meta-rule-editor__recipient-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.meta-rule-editor__recipient-list--selected {
  margin-bottom: 4px;
}

.meta-rule-editor__recipient-option,
.meta-rule-editor__recipient-chip {
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

.meta-rule-editor__recipient-option span,
.meta-rule-editor__recipient-chip span,
.meta-rule-editor__recipient-chip em {
  font-size: 12px;
  color: #64748b;
  font-style: normal;
}

.meta-rule-editor__toggle-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #475569;
}

.meta-rule-editor__footer {
  display: flex;
  gap: 8px;
  padding: 12px 20px 16px;
  border-top: 1px solid #e2e8f0;
}

.meta-rule-editor__btn {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 6px 14px;
  background: #fff;
  color: #0f172a;
  font-size: 13px;
  cursor: pointer;
}

.meta-rule-editor__btn:disabled { opacity: 0.55; cursor: not-allowed; }
.meta-rule-editor__btn--primary { border-color: #2563eb; background: #2563eb; color: #fff; }
.meta-rule-editor__btn--danger { border-color: #ef4444; color: #b91c1c; }
.meta-rule-editor__btn--icon { padding: 4px 8px; font-size: 14px; line-height: 1; }
</style>
