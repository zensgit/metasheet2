<template>
  <el-drawer
    v-if="visible"
    :model-value="visible"
    class="meta-automation"
    direction="rtl"
    size="640px"
    @update:model-value="(value) => { if (!value) $emit('close') }"
  >
    <template #header>
      <h4 class="meta-automation__title">{{ l('manager.title') }}</h4>
    </template>

    <div class="meta-automation__body">
        <div v-if="error" class="meta-automation__error" role="alert">{{ error }}</div>

        <!-- Create / Edit form -->
        <section v-if="showForm" class="meta-automation__form">
          <div class="meta-automation__form-title">{{ editingRuleId ? l('manager.quickEditTitle') : l('manager.quickNewTitle') }}</div>

          <label class="meta-automation__label">{{ l('editor.name') }}</label>
          <el-input
            v-model="draft.name"
            type="text"
            :placeholder="l('editor.namePlaceholder')"
            data-automation-field="name"
          />

          <label class="meta-automation__label">{{ l('trigger.title') }}</label>
          <el-select v-model="draft.triggerType" class="meta-automation__select" data-automation-field="triggerType">
            <el-option value="record.created" data-value="record.created" :label="automationTriggerTypeLabel('record.created', isZh)" />
            <el-option value="record.updated" data-value="record.updated" :label="automationTriggerTypeLabel('record.updated', isZh)" />
            <el-option value="form.submitted" data-value="form.submitted" :label="automationTriggerTypeLabel('form.submitted', isZh)" />
            <el-option value="field.changed" data-value="field.changed" :label="automationTriggerTypeLabel('field.changed', isZh)" />
          </el-select>

          <template v-if="draft.triggerType === 'field.changed'">
            <label class="meta-automation__label">{{ l('trigger.watchField') }}</label>
            <el-select v-model="draft.triggerFieldId" class="meta-automation__select" :placeholder="l('trigger.selectField')" data-automation-field="triggerFieldId">
              <el-option value="" data-value="" :label="l('trigger.selectField')" />
              <el-option v-for="f in fields" :key="f.id" :value="f.id" :data-value="f.id" :label="f.name" />
            </el-select>
          </template>

          <label class="meta-automation__label">{{ l('manager.action') }}</label>
          <el-select v-model="draft.actionType" class="meta-automation__select" data-automation-field="actionType">
            <el-option value="notify" data-value="notify" :label="automationActionTypeLabel('notify', isZh)" />
            <el-option value="update_field" data-value="update_field" :label="automationActionTypeLabel('update_field', isZh)" />
            <el-option value="send_dingtalk_group_message" data-value="send_dingtalk_group_message" :label="automationActionTypeLabel('send_dingtalk_group_message', isZh)" />
            <el-option value="send_dingtalk_person_message" data-value="send_dingtalk_person_message" :label="automationActionTypeLabel('send_dingtalk_person_message', isZh)" />
          </el-select>

          <template v-if="draft.actionType === 'notify'">
            <label class="meta-automation__label">{{ l('actionConfig.message') }}</label>
            <el-input
              v-model="draft.notifyMessage"
              type="text"
              :placeholder="l('actionConfig.notificationMessagePlaceholder')"
              data-automation-field="notifyMessage"
            />
          </template>

          <template v-if="draft.actionType === 'update_field'">
            <label class="meta-automation__label">{{ l('manager.targetField') }}</label>
            <el-select v-model="draft.targetFieldId" class="meta-automation__select" :placeholder="l('trigger.selectField')" data-automation-field="targetFieldId">
              <el-option value="" data-value="" :label="l('trigger.selectField')" />
              <el-option v-for="f in fields" :key="f.id" :value="f.id" :data-value="f.id" :label="f.name" />
            </el-select>
            <label class="meta-automation__label">{{ l('editor.value') }}</label>
            <el-input
              v-model="draft.targetValue"
              type="text"
              :placeholder="l('manager.newValuePlaceholder')"
              data-automation-field="targetValue"
            />
          </template>

          <template v-if="draft.actionType === 'send_dingtalk_group_message'">
            <div class="meta-automation__preset-row">
              <span class="meta-automation__preset-label">{{ l('dingtalk.preset') }}</span>
              <el-button size="small" data-automation-preset="group-form" @click="applyGroupPreset('form_request')">{{ automationDingTalkPresetLabel('form_request', isZh) }}</el-button>
              <el-button size="small" data-automation-preset="group-internal" @click="applyGroupPreset('internal_process')">{{ automationDingTalkPresetLabel('internal_process', isZh) }}</el-button>
              <el-button size="small" data-automation-preset="group-both" @click="applyGroupPreset('form_and_process')">{{ automationDingTalkPresetLabel('form_and_process', isZh) }}</el-button>
            </div>
            <label class="meta-automation__label">{{ l('dingtalk.addGroups') }}</label>
            <el-select
              v-model="draft.dingtalkDestinationPickerId"
              class="meta-automation__select"
              :placeholder="l('dingtalk.addGroupOption')"
              data-automation-field="dingtalkDestinationPickerId"
              @change="appendDingTalkGroupDestination"
            >
              <el-option value="" data-value="" :label="l('dingtalk.addGroupOption')" />
              <el-option
                v-for="destination in availableDingTalkGroupDestinations"
                :key="destination.id"
                :value="destination.id"
                :data-value="destination.id"
                :label="`${destination.name} · ${dingTalkDestinationScopeLabel(destination)}`"
              />
            </el-select>
            <div class="meta-automation__hint" data-automation-field="dingtalkDestinationPickerHint">
              {{ l('dingtalk.groupsRegisteredHint') }}
            </div>
            <div
              v-if="!dingTalkDestinations.length"
              class="meta-automation__hint"
              data-automation-field="dingtalkDestinationEmpty"
            >
              {{ l('dingtalk.noGroupsAvailable') }}
            </div>
            <div
              v-if="selectedDingTalkGroupDestinations.length"
              class="meta-automation__recipient-list meta-automation__recipient-list--selected"
            >
              <button
                v-for="destination in selectedDingTalkGroupDestinations"
                :key="destination.id"
                class="meta-automation__recipient-chip"
                type="button"
                :data-automation-group-destination="destination.id"
                @click="removeDingTalkGroupDestination(destination.id)"
              >
                <strong>{{ destination.label }}</strong>
                <span>{{ destination.subtitle || destination.id }}</span>
                <em>{{ l('dingtalk.remove') }}</em>
              </button>
            </div>
            <label class="meta-automation__label">{{ l('dingtalk.recordGroupFieldPaths') }}</label>
            <el-input
              v-model="draft.dingtalkDestinationFieldPath"
              type="text"
              placeholder="record.opsDestinationId, record.escalationDestinationIds"
              data-automation-field="dingtalkDestinationFieldPath"
            />
            <label class="meta-automation__label">{{ l('dingtalk.pickGroupField') }}</label>
            <el-select
              :model-value="''"
              class="meta-automation__select"
              :placeholder="l('dingtalk.pickFieldOption')"
              data-automation-field="dingtalkDestinationFieldSelect"
              @change="appendDingTalkGroupDestinationField"
            >
              <el-option value="" data-value="" :label="l('dingtalk.pickFieldOption')" />
              <el-option v-for="field in dingTalkGroupDestinationCandidateFields" :key="field.id" :value="field.id" :data-value="field.id" :label="field.name" />
            </el-select>
            <div
              v-if="selectedDingTalkGroupDestinationFields.length"
              class="meta-automation__recipient-list meta-automation__recipient-list--selected"
            >
              <button
                v-for="field in selectedDingTalkGroupDestinationFields"
                :key="field.id"
                class="meta-automation__recipient-chip"
                type="button"
                :data-automation-group-destination-field="field.id"
                @click="removeDingTalkGroupDestinationField(field.id)"
              >
                <strong>{{ field.label }}</strong>
                <span>{{ field.id }}</span>
                <em>{{ l('dingtalk.remove') }}</em>
              </button>
            </div>
            <div
              v-for="warning in groupDestinationFieldPathWarnings(draft.dingtalkDestinationFieldPath)"
              :key="`draft-group-destination-${warning}`"
              class="meta-automation__hint meta-automation__hint--warning"
            >
              {{ warning }}
            </div>
            <label class="meta-automation__label">{{ l('dingtalk.titleTemplate') }}</label>
            <el-input
              v-model="draft.dingtalkTitleTemplate"
              type="text"
              :placeholder="l('dingtalk.titleTemplatePlaceholder')"
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
              <span class="meta-automation__preset-label">{{ l('dingtalk.templateTokens') }}</span>
              <el-button
                v-for="token in DINGTALK_TITLE_TEMPLATE_TOKENS"
                :key="token.key"
                size="small"
                :data-automation-token="`group-title-${token.key}`"
                @click="appendGroupTemplateToken('title', token.value)"
              >
                {{ dingTalkTemplateTokenLabel(token, isZh) }}
              </el-button>
            </div>
            <label class="meta-automation__label">{{ l('dingtalk.bodyTemplate') }}</label>
            <el-input
              v-model="draft.dingtalkBodyTemplate"
              type="textarea"
              :rows="4"
              :placeholder="l('dingtalk.bodyTemplatePlaceholder')"
              data-automation-field="dingtalkBodyTemplate"
            />
            <div
              v-for="warning in templateSyntaxWarnings(draft.dingtalkBodyTemplate)"
              :key="`draft-group-body-${warning}`"
              class="meta-automation__hint meta-automation__hint--warning"
            >
              {{ warning }}
            </div>
            <div class="meta-automation__preset-row">
              <span class="meta-automation__preset-label">{{ l('dingtalk.templateTokens') }}</span>
              <el-button
                v-for="token in DINGTALK_BODY_TEMPLATE_TOKENS"
                :key="token.key"
                size="small"
                :data-automation-token="`group-body-${token.key}`"
                @click="appendGroupTemplateToken('body', token.value)"
              >
                {{ dingTalkTemplateTokenLabel(token, isZh) }}
              </el-button>
            </div>
            <label class="meta-automation__label">{{ l('dingtalk.publicFormView') }}</label>
            <el-select v-model="draft.publicFormViewId" class="meta-automation__select" :placeholder="l('dingtalk.noPublicFormLinkOption')" data-automation-field="publicFormViewId">
              <el-option value="" data-value="" :label="l('dingtalk.noPublicFormLinkOption')" />
              <el-option v-for="view in formViews" :key="view.id" :value="view.id" :data-value="view.id" :label="view.name" />
            </el-select>
            <div
              v-for="warning in publicFormLinkWarnings(draft.publicFormViewId, true)"
              :key="`draft-group-public-form-${warning}`"
              class="meta-automation__hint meta-automation__hint--warning"
            >
              {{ warning }}
            </div>
            <label class="meta-automation__label">{{ l('dingtalk.internalProcessingView') }}</label>
            <el-select v-model="draft.internalViewId" class="meta-automation__select" :placeholder="l('dingtalk.noInternalLinkOption')" data-automation-field="internalViewId">
              <el-option value="" data-value="" :label="l('dingtalk.noInternalLinkOption')" />
              <el-option v-for="view in internalViews" :key="view.id" :value="view.id" :data-value="view.id" :label="view.name" />
            </el-select>
            <div
              v-for="warning in internalViewLinkWarnings(draft.internalViewId)"
              :key="`draft-group-internal-view-${warning}`"
              class="meta-automation__hint meta-automation__hint--warning"
            >
              {{ warning }}
            </div>
            <div class="meta-automation__preview" data-automation-summary="group">
              <div class="meta-automation__preview-title">{{ l('dingtalk.messageSummary') }}</div>
              <div><strong>{{ l('dingtalk.groups') }}:</strong> {{ dingTalkGroupSummary }}</div>
              <div><strong>{{ l('dingtalk.recordGroups') }}:</strong> {{ dingTalkGroupFieldSummary }}</div>
              <div><strong>{{ l('dingtalk.titleTemplate') }}:</strong> {{ templatePreviewText(draft.dingtalkTitleTemplate, l('dingtalk.noTitleTemplate')) }}</div>
              <div class="meta-automation__preview-body"><strong>{{ l('dingtalk.bodyTemplate') }}:</strong> {{ templatePreviewText(draft.dingtalkBodyTemplate, l('dingtalk.noBodyTemplate')) }}</div>
              <div class="meta-automation__preview-line">
                <span><strong>{{ l('dingtalk.renderedTitle') }}:</strong> {{ renderedTemplateExample(draft.dingtalkTitleTemplate, l('dingtalk.noRenderedTitle')) }}</span>
                <el-button
                  size="small"
                  round
                  class="meta-automation__copy-btn"
                  data-automation-copy="group-rendered-title"
                  @click="copyPreviewText('group-title', renderedTemplateExample(draft.dingtalkTitleTemplate, ''))"
                >
                  {{ copiedPreviewKey === 'group-title' ? l('dingtalk.copied') : l('dingtalk.copy') }}
                </el-button>
              </div>
              <div class="meta-automation__preview-line meta-automation__preview-body">
                <span><strong>{{ l('dingtalk.renderedBody') }}:</strong> {{ renderedTemplateExample(draft.dingtalkBodyTemplate, l('dingtalk.noRenderedBody')) }}</span>
                <el-button
                  size="small"
                  round
                  class="meta-automation__copy-btn"
                  data-automation-copy="group-rendered-body"
                  @click="copyPreviewText('group-body', renderedTemplateExample(draft.dingtalkBodyTemplate, ''))"
                >
                  {{ copiedPreviewKey === 'group-body' ? l('dingtalk.copied') : l('dingtalk.copy') }}
                </el-button>
              </div>
              <div><strong>{{ l('dingtalk.publicForm') }}:</strong> {{ viewSummaryName(draft.publicFormViewId, l('dingtalk.noPublicFormLink')) }}</div>
              <div
                class="meta-automation__public-form-access"
                :class="`meta-automation__public-form-access--${draftGroupPublicFormAccessState.level}`"
                data-automation-public-form-access="group"
                :data-access-level="draftGroupPublicFormAccessState.level"
              >
                <strong>{{ l('dingtalk.publicFormAccess') }}:</strong> {{ draftGroupPublicFormAccessState.summary }}
              </div>
              <div data-automation-public-form-audience="group">
                <strong>{{ l('dingtalk.allowedAudience') }}:</strong> {{ draftGroupPublicFormAccessState.audienceSummary }}
              </div>
              <div><strong>{{ l('dingtalk.internalProcessing') }}:</strong> {{ viewSummaryName(draft.internalViewId, l('dingtalk.noInternalLink')) }}</div>
            </div>
          </template>

          <template v-if="draft.actionType === 'send_dingtalk_person_message'">
            <div class="meta-automation__preset-row">
              <span class="meta-automation__preset-label">{{ l('dingtalk.preset') }}</span>
              <el-button size="small" data-automation-preset="person-form" @click="applyPersonPreset('form_request')">{{ automationDingTalkPresetLabel('form_request', isZh) }}</el-button>
              <el-button size="small" data-automation-preset="person-internal" @click="applyPersonPreset('internal_process')">{{ automationDingTalkPresetLabel('internal_process', isZh) }}</el-button>
              <el-button size="small" data-automation-preset="person-both" @click="applyPersonPreset('form_and_process')">{{ automationDingTalkPresetLabel('form_and_process', isZh) }}</el-button>
            </div>
            <label class="meta-automation__label">{{ l('dingtalk.searchUsersOrGroups') }}</label>
            <el-input
              v-model="dingtalkPersonUserSearch"
              type="text"
              :placeholder="l('dingtalk.searchUsersOrGroupsPlaceholder')"
              data-automation-field="dingtalkPersonUserSearch"
              @input="void loadDingTalkPersonSuggestions()"
            />
            <div v-if="dingtalkPersonUserSearchLoading" class="meta-automation__hint">{{ l('dingtalk.searchingUsersOrGroups') }}</div>
            <div v-else-if="dingtalkPersonUserSearchError" class="meta-automation__hint meta-automation__hint--error">{{ dingtalkPersonUserSearchError }}</div>
            <div v-else-if="availableDingTalkPersonSuggestions.length" class="meta-automation__recipient-list">
              <button
                v-for="candidate in availableDingTalkPersonSuggestions"
                :key="personRecipientCandidateKey(candidate)"
                class="meta-automation__recipient-option"
                type="button"
                :disabled="isInactivePersonRecipientCandidate(candidate)"
                :data-automation-person-suggestion="personRecipientCandidateKey(candidate)"
                @click="addDingTalkPersonRecipient(candidate)"
              >
                <strong>{{ candidate.label }}</strong>
                <span>{{ candidate.subtitle || candidate.subjectId }}</span>
                <span>{{ personRecipientSubjectLabel(candidate) }}</span>
                <span v-if="candidate.accessLevel">{{ personRecipientAccessLabel(candidate.accessLevel) }}</span>
                <span v-if="personRecipientDingTalkStatusLabel(candidate.subjectType, candidate)">{{ personRecipientDingTalkStatusLabel(candidate.subjectType, candidate) }}</span>
                <span v-if="isInactivePersonRecipientCandidate(candidate)">{{ l('dingtalk.inactiveUsersCannotBeAdded') }}</span>
              </button>
            </div>
            <div v-else-if="dingtalkPersonUserSearch.trim()" class="meta-automation__hint">{{ l('dingtalk.noMatchingUsersOrGroups') }}</div>
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
                <span v-if="personRecipientDingTalkStatusLabel('user', recipient)">{{ personRecipientDingTalkStatusLabel('user', recipient) }}</span>
                <em>{{ l('dingtalk.remove') }}</em>
              </button>
            </div>
            <div v-if="selectedDingTalkPersonMemberGroups.length" class="meta-automation__recipient-list meta-automation__recipient-list--selected">
              <button
                v-for="group in selectedDingTalkPersonMemberGroups"
                :key="group.id"
                class="meta-automation__recipient-chip"
                type="button"
                :data-automation-person-member-group="group.id"
                @click="removeDingTalkPersonMemberGroup(group.id)"
              >
                <strong>{{ group.label }}</strong>
                <span>{{ group.subtitle || group.id }}</span>
                <span v-if="personRecipientDingTalkStatusLabel('member-group', group)">{{ personRecipientDingTalkStatusLabel('member-group', group) }}</span>
                <em>{{ l('dingtalk.remove') }}</em>
              </button>
            </div>
            <label class="meta-automation__label">{{ l('dingtalk.localUserIds') }}</label>
            <el-input
              v-model="draft.dingtalkPersonUserIds"
              type="textarea"
              :rows="3"
              :placeholder="l('dingtalk.localUserIdsPlaceholder')"
              data-automation-field="dingtalkPersonUserIds"
            />
            <label class="meta-automation__label">{{ l('dingtalk.memberGroupIds') }}</label>
            <el-input
              v-model="draft.dingtalkPersonMemberGroupIds"
              type="textarea"
              :rows="2"
              :placeholder="l('dingtalk.memberGroupIdsPlaceholder')"
              data-automation-field="dingtalkPersonMemberGroupIds"
            />
            <label class="meta-automation__label">{{ l('dingtalk.recordRecipientFieldPaths') }}</label>
            <el-input
              v-model="draft.dingtalkPersonRecipientFieldPath"
              type="text"
              :placeholder="l('dingtalk.recordRecipientFieldPathPlaceholder')"
              data-automation-field="dingtalkPersonRecipientFieldPath"
            />
            <label class="meta-automation__label">{{ l('dingtalk.pickRecipientField') }}</label>
            <el-select
              :model-value="''"
              class="meta-automation__select"
              :placeholder="l('dingtalk.chooseUserFieldOption')"
              data-automation-field="dingtalkPersonRecipientFieldSelect"
              @change="appendDingTalkPersonRecipientField"
            >
              <el-option value="" data-value="" :label="l('dingtalk.chooseUserFieldOption')" />
              <el-option
                v-for="field in dingTalkPersonRecipientCandidateFields"
                :key="field.id"
                :value="field.id"
                :data-value="field.id"
                :label="`${field.name} (record.${field.id})`"
              />
            </el-select>
            <div
              v-if="selectedDingTalkPersonRecipientFields.length"
              class="meta-automation__recipient-list meta-automation__recipient-list--selected"
            >
              <button
                v-for="field in selectedDingTalkPersonRecipientFields"
                :key="field.id"
                class="meta-automation__recipient-chip"
                type="button"
                :data-automation-recipient-field="field.id"
                @click="removeDingTalkPersonRecipientField(field.id)"
              >
                <strong>{{ field.label }}</strong>
                <em>{{ l('dingtalk.remove') }}</em>
              </button>
            </div>
            <div
              v-for="warning in recipientFieldPathWarnings(draft.dingtalkPersonRecipientFieldPath)"
              :key="`draft-person-recipient-${warning}`"
              class="meta-automation__hint meta-automation__hint--warning"
            >
              {{ warning }}
            </div>
            <div class="meta-automation__hint">
              {{ l('dingtalk.recordRecipientFieldPathHint') }}
            </div>
            <label class="meta-automation__label">{{ l('dingtalk.recordMemberGroupFieldPaths') }}</label>
            <el-input
              v-model="draft.dingtalkPersonMemberGroupRecipientFieldPath"
              type="text"
              :placeholder="l('dingtalk.recordMemberGroupFieldPathPlaceholder')"
              data-automation-field="dingtalkPersonMemberGroupRecipientFieldPath"
            />
            <label class="meta-automation__label">{{ l('dingtalk.pickMemberGroupField') }}</label>
            <el-select
              :model-value="''"
              class="meta-automation__select"
              :placeholder="l('dingtalk.chooseMemberGroupFieldOption')"
              data-automation-field="dingtalkPersonMemberGroupRecipientFieldSelect"
              @change="appendDingTalkPersonMemberGroupRecipientField"
            >
              <el-option value="" data-value="" :label="l('dingtalk.chooseMemberGroupFieldOption')" />
              <el-option
                v-for="field in dingTalkPersonMemberGroupRecipientCandidateFields"
                :key="field.id"
                :value="field.id"
                :data-value="field.id"
                :label="`${field.name} (record.${field.id})`"
              />
            </el-select>
            <div
              v-if="selectedDingTalkPersonMemberGroupRecipientFields.length"
              class="meta-automation__recipient-list meta-automation__recipient-list--selected"
            >
              <button
                v-for="field in selectedDingTalkPersonMemberGroupRecipientFields"
                :key="field.id"
                class="meta-automation__recipient-chip"
                type="button"
                :data-automation-member-group-recipient-field="field.id"
                @click="removeDingTalkPersonMemberGroupRecipientField(field.id)"
              >
                <strong>{{ field.label }}</strong>
                <em>{{ l('dingtalk.remove') }}</em>
              </button>
            </div>
            <div
              v-for="warning in memberGroupRecipientFieldPathWarnings(draft.dingtalkPersonMemberGroupRecipientFieldPath)"
              :key="`draft-person-member-group-recipient-${warning}`"
              class="meta-automation__hint meta-automation__hint--warning"
            >
              {{ warning }}
            </div>
            <div class="meta-automation__hint">
              {{ l('dingtalk.recordMemberGroupFieldPathHint') }}
            </div>
            <label class="meta-automation__label">{{ l('dingtalk.titleTemplate') }}</label>
            <el-input
              v-model="draft.dingtalkPersonTitleTemplate"
              type="text"
              :placeholder="l('dingtalk.titleTemplatePlaceholder')"
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
              <span class="meta-automation__preset-label">{{ l('dingtalk.templateTokens') }}</span>
              <el-button
                v-for="token in DINGTALK_TITLE_TEMPLATE_TOKENS"
                :key="token.key"
                size="small"
                :data-automation-token="`person-title-${token.key}`"
                @click="appendPersonTemplateToken('title', token.value)"
              >
                {{ dingTalkTemplateTokenLabel(token, isZh) }}
              </el-button>
            </div>
            <label class="meta-automation__label">{{ l('dingtalk.bodyTemplate') }}</label>
            <el-input
              v-model="draft.dingtalkPersonBodyTemplate"
              type="textarea"
              :rows="4"
              :placeholder="l('dingtalk.bodyTemplatePlaceholder')"
              data-automation-field="dingtalkPersonBodyTemplate"
            />
            <div
              v-for="warning in templateSyntaxWarnings(draft.dingtalkPersonBodyTemplate)"
              :key="`draft-person-body-${warning}`"
              class="meta-automation__hint meta-automation__hint--warning"
            >
              {{ warning }}
            </div>
            <div class="meta-automation__preset-row">
              <span class="meta-automation__preset-label">{{ l('dingtalk.templateTokens') }}</span>
              <el-button
                v-for="token in DINGTALK_BODY_TEMPLATE_TOKENS"
                :key="token.key"
                size="small"
                :data-automation-token="`person-body-${token.key}`"
                @click="appendPersonTemplateToken('body', token.value)"
              >
                {{ dingTalkTemplateTokenLabel(token, isZh) }}
              </el-button>
            </div>
            <label class="meta-automation__label">{{ l('dingtalk.publicFormView') }}</label>
            <el-select v-model="draft.dingtalkPersonPublicFormViewId" class="meta-automation__select" :placeholder="l('dingtalk.noPublicFormLinkOption')" data-automation-field="dingtalkPersonPublicFormViewId">
              <el-option value="" data-value="" :label="l('dingtalk.noPublicFormLinkOption')" />
              <el-option v-for="view in formViews" :key="view.id" :value="view.id" :data-value="view.id" :label="view.name" />
            </el-select>
            <div
              v-for="warning in publicFormLinkWarnings(draft.dingtalkPersonPublicFormViewId, true)"
              :key="`draft-person-public-form-${warning}`"
              class="meta-automation__hint meta-automation__hint--warning"
            >
              {{ warning }}
            </div>
            <label class="meta-automation__label">{{ l('dingtalk.internalProcessingView') }}</label>
            <el-select v-model="draft.dingtalkPersonInternalViewId" class="meta-automation__select" :placeholder="l('dingtalk.noInternalLinkOption')" data-automation-field="dingtalkPersonInternalViewId">
              <el-option value="" data-value="" :label="l('dingtalk.noInternalLinkOption')" />
              <el-option v-for="view in internalViews" :key="view.id" :value="view.id" :data-value="view.id" :label="view.name" />
            </el-select>
            <div
              v-for="warning in internalViewLinkWarnings(draft.dingtalkPersonInternalViewId)"
              :key="`draft-person-internal-view-${warning}`"
              class="meta-automation__hint meta-automation__hint--warning"
            >
              {{ warning }}
            </div>
            <div class="meta-automation__preview" data-automation-summary="person">
              <div class="meta-automation__preview-title">{{ l('dingtalk.messageSummary') }}</div>
              <div><strong>{{ l('dingtalk.recipients') }}:</strong> {{ dingTalkPersonRecipientSummary }}</div>
              <div><strong>{{ l('dingtalk.recordRecipients') }}:</strong> {{ dingTalkPersonRecipientFieldSummary }}</div>
              <div><strong>{{ l('dingtalk.recordMemberGroups') }}:</strong> {{ dingTalkPersonMemberGroupFieldSummary }}</div>
              <div><strong>{{ l('dingtalk.titleTemplate') }}:</strong> {{ templatePreviewText(draft.dingtalkPersonTitleTemplate, l('dingtalk.noTitleTemplate')) }}</div>
              <div class="meta-automation__preview-body"><strong>{{ l('dingtalk.bodyTemplate') }}:</strong> {{ templatePreviewText(draft.dingtalkPersonBodyTemplate, l('dingtalk.noBodyTemplate')) }}</div>
              <div class="meta-automation__preview-line">
                <span><strong>{{ l('dingtalk.renderedTitle') }}:</strong> {{ renderedTemplateExample(draft.dingtalkPersonTitleTemplate, l('dingtalk.noRenderedTitle')) }}</span>
                <el-button
                  size="small"
                  round
                  class="meta-automation__copy-btn"
                  data-automation-copy="person-rendered-title"
                  @click="copyPreviewText('person-title', renderedTemplateExample(draft.dingtalkPersonTitleTemplate, ''))"
                >
                  {{ copiedPreviewKey === 'person-title' ? l('dingtalk.copied') : l('dingtalk.copy') }}
                </el-button>
              </div>
              <div class="meta-automation__preview-line meta-automation__preview-body">
                <span><strong>{{ l('dingtalk.renderedBody') }}:</strong> {{ renderedTemplateExample(draft.dingtalkPersonBodyTemplate, l('dingtalk.noRenderedBody')) }}</span>
                <el-button
                  size="small"
                  round
                  class="meta-automation__copy-btn"
                  data-automation-copy="person-rendered-body"
                  @click="copyPreviewText('person-body', renderedTemplateExample(draft.dingtalkPersonBodyTemplate, ''))"
                >
                  {{ copiedPreviewKey === 'person-body' ? l('dingtalk.copied') : l('dingtalk.copy') }}
                </el-button>
              </div>
              <div><strong>{{ l('dingtalk.publicForm') }}:</strong> {{ viewSummaryName(draft.dingtalkPersonPublicFormViewId, l('dingtalk.noPublicFormLink')) }}</div>
              <div
                class="meta-automation__public-form-access"
                :class="`meta-automation__public-form-access--${draftPersonPublicFormAccessState.level}`"
                data-automation-public-form-access="person"
                :data-access-level="draftPersonPublicFormAccessState.level"
              >
                <strong>{{ l('dingtalk.publicFormAccess') }}:</strong> {{ draftPersonPublicFormAccessState.summary }}
              </div>
              <div data-automation-public-form-audience="person">
                <strong>{{ l('dingtalk.allowedAudience') }}:</strong> {{ draftPersonPublicFormAccessState.audienceSummary }}
              </div>
              <div><strong>{{ l('dingtalk.internalProcessing') }}:</strong> {{ viewSummaryName(draft.dingtalkPersonInternalViewId, l('dingtalk.noInternalLink')) }}</div>
            </div>
          </template>

          <div class="meta-automation__form-actions">
            <el-button type="primary" class="meta-automation__btn--primary" :disabled="!canSave" @click="onSave">
              {{ editingRuleId ? l('manager.update') : l('manager.create') }}
            </el-button>
            <el-button @click="cancelForm">{{ l('editor.cancel') }}</el-button>
          </div>
        </section>

        <!-- Add buttons -->
        <div v-if="!showForm && !showRuleEditor" class="meta-automation__add-row">
          <el-button
            type="primary"
            class="meta-automation__btn--primary"
            data-automation-new-rule="advanced"
            @click="openRuleEditor()"
          >
            {{ l('manager.newAutomation') }}
          </el-button>
          <el-button
            class="meta-automation__btn-add"
            data-automation-new-rule="quick"
            @click="openCreateForm"
          >
            {{ l('manager.quickLegacyForm') }}
          </el-button>
        </div>

        <!-- Rule list -->
        <div v-if="loading" class="meta-automation__empty">{{ l('manager.loading') }}</div>
        <div v-else-if="!rules.length && !showForm" class="meta-automation__empty" data-automation-empty="true">
          {{ l('manager.empty') }}
        </div>
        <div
          v-for="rule in rules"
          :key="rule.id"
          class="meta-automation__card"
          :data-automation-rule="rule.id"
        >
          <div class="meta-automation__card-header">
            <strong class="meta-automation__card-name">{{ rule.name }}</strong>
            <el-checkbox
              class="meta-automation__toggle"
              :model-value="rule.enabled"
              data-automation-toggle="true"
              @change="onToggle(rule)"
            >
              {{ rule.enabled ? l('manager.enabled') : l('manager.disabled') }}
            </el-checkbox>
          </div>
          <div class="meta-automation__card-desc">
            {{ describeTrigger(rule) }} &rarr; {{ describeAction(rule) }}
          </div>
          <div v-if="dingTalkCardLinks(rule).length" class="meta-automation__card-links">
            <div
              v-for="link in dingTalkCardLinks(rule)"
              :key="link.key"
              class="meta-automation__card-link-item"
            >
              <el-button
                v-if="link.href"
                tag="a"
                class="meta-automation__btn-link"
                :href="link.href"
                target="_blank"
                rel="noopener noreferrer"
                :data-automation-card-link="link.key"
              >
                {{ link.label }}
              </el-button>
              <el-button
                v-else
                class="meta-automation__btn-link"
                :data-automation-card-link="link.key"
                @click="openInternalView(link.viewId ?? '')"
              >
                {{ link.label }}
              </el-button>
              <span
                v-if="link.accessSummary"
                class="meta-automation__card-link-access"
                :class="`meta-automation__card-link-access--${link.accessLevel ?? 'none'}`"
                :data-automation-card-link-access="link.key"
                :data-access-level="link.accessLevel"
              >
                {{ link.accessSummary }}
              </span>
              <span
                v-if="link.audienceSummary"
                class="meta-automation__card-link-audience"
                :data-automation-card-link-audience="link.key"
              >
                {{ allowedAudienceText(link.audienceSummary) }}
              </span>
            </div>
          </div>
          <div v-if="ruleStats[rule.id]" class="meta-automation__card-stats">
            <span class="meta-automation__stat meta-automation__stat--success">{{ automationCardStats(ruleStats[rule.id].success, 'ok', isZh) }}</span>
            <span class="meta-automation__stat meta-automation__stat--failed">{{ automationCardStats(ruleStats[rule.id].failed, 'fail', isZh) }}</span>
          </div>
          <div
            v-if="ruleLastRun[rule.id]"
            class="meta-automation__last-run-chip"
            :class="`meta-automation__last-run-chip--${ruleLastRunChipFor(rule.id).status}`"
            :data-automation-last-run="rule.id"
            :data-status="ruleLastRunChipFor(rule.id).status"
          >
            {{ ruleLastRunChipFor(rule.id).text }}
          </div>
          <div
            v-if="ruleTestRunStates[rule.id]"
            class="meta-automation__test-run-status"
            :class="`meta-automation__test-run-status--${ruleTestRunStates[rule.id].status}`"
            :data-automation-test-status="rule.id"
            :data-status="ruleTestRunStates[rule.id].status"
          >
            {{ ruleTestRunStates[rule.id].message }}
          </div>
          <div class="meta-automation__card-actions">
            <el-button data-automation-edit="true" @click="openRuleEditor(rule)">{{ l('manager.edit') }}</el-button>
            <el-button data-automation-logs="true" @click="openLogViewer(rule)">{{ l('manager.viewLogs') }}</el-button>
            <el-button
              v-if="ruleHasActionType(rule, 'send_dingtalk_group_message')"
              :data-automation-group-deliveries="rule.id"
              @click="openGroupDeliveryViewer(rule)"
            >
              {{ l('manager.viewDeliveries') }}
            </el-button>
            <el-button
              v-if="ruleHasActionType(rule, 'send_dingtalk_person_message')"
              :data-automation-person-deliveries="rule.id"
              @click="openPersonDeliveryViewer(rule)"
            >
              {{ l('manager.viewDeliveries') }}
            </el-button>
            <el-button type="danger" plain data-automation-delete="true" @click="onDelete(rule)">{{ l('manager.delete') }}</el-button>
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
      :test-run-state="activeRuleTestRunState"
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
  </el-drawer>
</template>

<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { ElButton, ElCheckbox, ElDrawer, ElInput, ElMessageBox, ElOption, ElSelect } from 'element-plus'
import { useRouter } from 'vue-router'
import type {
  AutomationExecution,
  AutomationRule,
  AutomationTriggerType,
  AutomationActionType,
  AutomationStats,
  DingTalkGroupDestination,
  MetaSheetPermissionCandidate,
  MetaView,
} from '../types'
import { AppRouteNames } from '../../router/types'
import { useLocale } from '../../composables/useLocale'
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
  dingTalkTemplateTokenLabel,
} from '../utils/dingtalkNotificationTemplateTokens'
import { listDingTalkTemplateSyntaxWarnings } from '../utils/dingtalkNotificationTemplateLint'
import { renderDingTalkTemplateExample } from '../utils/dingtalkNotificationTemplateExample'
import {
  isDingTalkMemberGroupRecipientField,
  listDingTalkGroupDestinationFieldPathWarnings,
  listDingTalkPersonMemberGroupRecipientFieldPathWarnings,
  listDingTalkPersonRecipientFieldPathWarnings,
} from '../utils/dingtalkRecipientFieldWarnings'
import {
  getDingTalkPublicFormLinkAccessState,
  type DingTalkPublicFormLinkAccessLevel,
  listDingTalkPublicFormLinkBlockingErrors,
  listDingTalkPublicFormLinkWarnings,
} from '../utils/dingtalkPublicFormLinkWarnings'
import {
  listDingTalkInternalViewLinkBlockingErrors,
  listDingTalkInternalViewLinkWarnings,
} from '../utils/dingtalkInternalViewLinkWarnings'
import {
  automationActionTypeLabel,
  automationCardActionSummary,
  automationCardLinkLabel,
  automationCardLinkSummary,
  automationCardStats,
  automationCardTriggerSummary,
  automationDeleteRuleConfirmMessage,
  automationDingTalkDestinationScopeLabel,
  automationDingTalkDestinationSubtitle,
  automationDingTalkPersonAccessLabel,
  automationDingTalkPersonStatusLabel,
  automationDingTalkPersonSubjectLabel,
  automationDingTalkPresetLabel,
  automationLabel,
  automationLastRunChip,
  automationTestRunFailed,
  automationTestRunRequestFailed,
  automationTestRunSkipped,
  automationTestRunSucceeded,
  automationTriggerTypeLabel,
  type AutomationLabelKey,
  type AutomationLastRunChip,
} from '../utils/meta-automation-labels'
import { loadRuleEntriesConcurrently, mergeRuleEntries } from '../utils/automation-rule-concurrent-merge'

const props = defineProps<{
  visible: boolean
  sheetId: string
  fields: Array<{ id: string; name: string; type: string; property?: Record<string, unknown> }>
  client?: MultitableApiClient
  views?: MetaView[]
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'updated'): void
}>()

const router = useRouter()
const { isZh } = useLocale()
const l = (key: AutomationLabelKey) => automationLabel(key, isZh.value)

type AutomationTestRunState = {
  status: 'running' | 'success' | 'failed' | 'skipped'
  message: string
}

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
  dingtalkDestinationIds: string[]
  dingtalkDestinationPickerId: string
  dingtalkDestinationFieldPath: string
  dingtalkTitleTemplate: string
  dingtalkBodyTemplate: string
  publicFormViewId: string
  internalViewId: string
  dingtalkPersonUserIds: string
  dingtalkPersonMemberGroupIds: string
  dingtalkPersonRecipientFieldPath: string
  dingtalkPersonMemberGroupRecipientFieldPath: string
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
    dingtalkDestinationIds: [],
    dingtalkDestinationPickerId: '',
    dingtalkDestinationFieldPath: '',
    dingtalkTitleTemplate: '',
    dingtalkBodyTemplate: '',
    publicFormViewId: '',
    internalViewId: '',
    dingtalkPersonUserIds: '',
    dingtalkPersonMemberGroupIds: '',
    dingtalkPersonRecipientFieldPath: '',
    dingtalkPersonMemberGroupRecipientFieldPath: '',
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
const dingtalkPersonUserSuggestions = ref<MetaSheetPermissionCandidate[]>([])

type DingTalkPersonRecipientDirectoryEntry = {
  label: string
  subtitle?: string
  dingtalkBound?: boolean | null
  dingtalkGrantEnabled?: boolean | null
  dingtalkPersonDeliveryAvailable?: boolean | null
}

const dingtalkPersonUserDirectory = ref<Record<string, DingTalkPersonRecipientDirectoryEntry>>({})
const copiedPreviewKey = ref('')
let dingtalkPersonSuggestionLoadId = 0
let copiedPreviewResetTimer: ReturnType<typeof setTimeout> | null = null
const formViews = computed(() => (props.views ?? []).filter((view) =>
  view.type === 'form' && (!view.sheetId || view.sheetId === props.sheetId),
))
const internalViews = computed(() => (props.views ?? []).filter((view) => !view.sheetId || view.sheetId === props.sheetId))
const draftGroupPublicFormAccessState = computed(() =>
  getDingTalkPublicFormLinkAccessState(draft.value.publicFormViewId, formViews.value, { isZh: isZh.value }),
)
const draftPersonPublicFormAccessState = computed(() =>
  getDingTalkPublicFormLinkAccessState(draft.value.dingtalkPersonPublicFormViewId, formViews.value, { isZh: isZh.value }),
)

interface DingTalkCardLink {
  key: string
  label: string
  href?: string
  viewId?: string
  accessSummary?: string
  audienceSummary?: string
  accessLevel?: DingTalkPublicFormLinkAccessLevel
}

function parseUserIdsText(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function parseMemberGroupIdsText(value: string): string[] {
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

function isPersonRecipientCandidate(candidate: MetaSheetPermissionCandidate): boolean {
  return candidate.subjectType === 'user' || candidate.subjectType === 'member-group'
}

function isInactivePersonRecipientCandidate(candidate: MetaSheetPermissionCandidate): boolean {
  return candidate.subjectType === 'user' && candidate.isActive === false
}

function personRecipientSubjectLabel(candidate: MetaSheetPermissionCandidate): string {
  return automationDingTalkPersonSubjectLabel(candidate.subjectType === 'member-group' ? 'member-group' : 'user', isZh.value)
}

function personRecipientAccessLabel(accessLevel: MetaSheetPermissionCandidate['accessLevel']): string {
  return accessLevel ? automationDingTalkPersonAccessLabel(accessLevel, isZh.value) : ''
}

function personRecipientDingTalkStatusLabel(
  subjectType: MetaSheetPermissionCandidate['subjectType'],
  status: Pick<MetaSheetPermissionCandidate, 'dingtalkBound' | 'dingtalkGrantEnabled' | 'dingtalkPersonDeliveryAvailable'>,
): string {
  if (subjectType === 'member-group') return automationDingTalkPersonStatusLabel('memberGroupCheckedIndividually', isZh.value)
  if (subjectType !== 'user') return ''
  if (status.dingtalkPersonDeliveryAvailable === false) return automationDingTalkPersonStatusLabel('noDeliveryLink', isZh.value)
  if (status.dingtalkPersonDeliveryAvailable === true && status.dingtalkGrantEnabled === true) return automationDingTalkPersonStatusLabel('deliveryReadyGrantEnabled', isZh.value)
  if (status.dingtalkPersonDeliveryAvailable === true && status.dingtalkGrantEnabled === false) return automationDingTalkPersonStatusLabel('deliveryReadyGrantDisabled', isZh.value)
  if (status.dingtalkBound === false) return automationDingTalkPersonStatusLabel('notBound', isZh.value)
  if (status.dingtalkBound === true && status.dingtalkGrantEnabled === true) return automationDingTalkPersonStatusLabel('boundGrantEnabled', isZh.value)
  if (status.dingtalkBound === true && status.dingtalkGrantEnabled === false) return automationDingTalkPersonStatusLabel('boundGrantDisabled', isZh.value)
  return ''
}

function rememberDingTalkPersonSuggestions(items: MetaSheetPermissionCandidate[]) {
  const next = { ...dingtalkPersonUserDirectory.value }
  for (const item of items) {
    if (item.subjectType !== 'user' && item.subjectType !== 'member-group') continue
    next[personRecipientDirectoryKey(item.subjectType, item.subjectId)] = {
      label: item.label,
      subtitle: item.subtitle ?? undefined,
      dingtalkBound: item.dingtalkBound ?? null,
      dingtalkGrantEnabled: item.dingtalkGrantEnabled ?? null,
      dingtalkPersonDeliveryAvailable: item.dingtalkPersonDeliveryAvailable ?? null,
    }
  }
  dingtalkPersonUserDirectory.value = next
}

const selectedDingTalkPersonRecipients = computed(() =>
  parseUserIdsText(draft.value.dingtalkPersonUserIds).map((id) => {
    const directoryEntry = dingtalkPersonUserDirectory.value[personRecipientDirectoryKey('user', id)]
    return {
      id,
      label: directoryEntry?.label ?? id,
      subtitle: directoryEntry?.subtitle,
      dingtalkBound: directoryEntry?.dingtalkBound ?? null,
      dingtalkGrantEnabled: directoryEntry?.dingtalkGrantEnabled ?? null,
      dingtalkPersonDeliveryAvailable: directoryEntry?.dingtalkPersonDeliveryAvailable ?? null,
    }
  }),
)

const selectedDingTalkPersonMemberGroups = computed(() =>
  parseMemberGroupIdsText(draft.value.dingtalkPersonMemberGroupIds).map((id) => {
    const directoryEntry = dingtalkPersonUserDirectory.value[personRecipientDirectoryKey('member-group', id)]
    return {
      id,
      label: directoryEntry?.label ?? id,
      subtitle: directoryEntry?.subtitle,
      dingtalkBound: directoryEntry?.dingtalkBound ?? null,
      dingtalkGrantEnabled: directoryEntry?.dingtalkGrantEnabled ?? null,
      dingtalkPersonDeliveryAvailable: directoryEntry?.dingtalkPersonDeliveryAvailable ?? null,
    }
  }),
)

const availableDingTalkPersonSuggestions = computed(() => {
  const selected = new Set(parseUserIdsText(draft.value.dingtalkPersonUserIds))
  const selectedGroups = new Set(parseMemberGroupIdsText(draft.value.dingtalkPersonMemberGroupIds))
  return dingtalkPersonUserSuggestions.value.filter((candidate) => {
    if (!isPersonRecipientCandidate(candidate)) return false
    if (candidate.subjectType === 'member-group') return !selectedGroups.has(candidate.subjectId)
    return !selected.has(candidate.subjectId)
  })
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
    const response = await props.client.listFormShareCandidates(props.sheetId, {
      q: query,
      limit: 8,
    })
    if (requestId !== dingtalkPersonSuggestionLoadId) return
    rememberDingTalkPersonSuggestions(response.items)
    dingtalkPersonUserSuggestions.value = response.items
  } catch (error) {
    if (requestId !== dingtalkPersonSuggestionLoadId) return
    dingtalkPersonUserSuggestions.value = []
    dingtalkPersonUserSearchError.value = error instanceof Error ? error.message : 'Failed to search users and member groups'
  } finally {
    if (requestId === dingtalkPersonSuggestionLoadId) {
      dingtalkPersonUserSearchLoading.value = false
    }
  }
}

function addDingTalkPersonRecipient(candidate: MetaSheetPermissionCandidate) {
  if (!isPersonRecipientCandidate(candidate)) return
  if (isInactivePersonRecipientCandidate(candidate)) return
  if (candidate.subjectType === 'member-group') {
    const ids = new Set(parseMemberGroupIdsText(draft.value.dingtalkPersonMemberGroupIds))
    ids.add(candidate.subjectId)
    draft.value.dingtalkPersonMemberGroupIds = Array.from(ids).join(', ')
  } else {
    const ids = new Set(parseUserIdsText(draft.value.dingtalkPersonUserIds))
    ids.add(candidate.subjectId)
    draft.value.dingtalkPersonUserIds = Array.from(ids).join(', ')
  }
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

function removeDingTalkPersonMemberGroup(groupId: string) {
  draft.value.dingtalkPersonMemberGroupIds = parseMemberGroupIdsText(draft.value.dingtalkPersonMemberGroupIds)
    .filter((id) => id !== groupId)
    .join(', ')
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

function dingTalkGroupName(destinationId: string) {
  if (!destinationId) return 'No group selected'
  return dingTalkDestinations.value.find((item) => item.id === destinationId)?.name ?? destinationId
}

function dingTalkDestinationScope(destination?: DingTalkGroupDestination): 'private' | 'sheet' | 'org' {
  if (!destination) return 'private'
  if (destination.scope === 'org' || destination.orgId) return 'org'
  if (destination.scope === 'sheet' || destination.sheetId) return 'sheet'
  return 'private'
}

function dingTalkDestinationScopeLabel(destination?: DingTalkGroupDestination): string {
  const scope = dingTalkDestinationScope(destination)
  return automationDingTalkDestinationScopeLabel(scope, isZh.value)
}

function dingTalkDestinationSubtitle(destination?: DingTalkGroupDestination): string | undefined {
  const scope = dingTalkDestinationScope(destination)
  return automationDingTalkDestinationSubtitle(scope, scope === 'org' ? destination?.orgId ?? '' : destination?.sheetId ?? '', isZh.value)
}

const selectedDingTalkGroupDestinations = computed(() =>
  draft.value.dingtalkDestinationIds.map((id) => {
    const destination = dingTalkDestinations.value.find((item) => item.id === id)
    return {
      id,
      label: destination?.name ?? id,
      subtitle: dingTalkDestinationSubtitle(destination),
    }
  }),
)

const dingTalkGroupDestinationCandidateFields = computed(() => props.fields)

const availableDingTalkGroupDestinations = computed(() => {
  const selected = new Set(draft.value.dingtalkDestinationIds)
  return dingTalkDestinations.value.filter((destination) => !selected.has(destination.id))
})

function appendDingTalkGroupDestination(value: string) {
  const destinationId = value.trim()
  if (!destinationId) return
  draft.value.dingtalkDestinationIds = Array.from(new Set([...draft.value.dingtalkDestinationIds, destinationId]))
  draft.value.dingtalkDestinationPickerId = ''
}

function removeDingTalkGroupDestination(destinationId: string) {
  draft.value.dingtalkDestinationIds = draft.value.dingtalkDestinationIds.filter((id) => id !== destinationId)
}

const dingTalkGroupSummary = computed(() => {
  if (!selectedDingTalkGroupDestinations.value.length) return l('dingtalk.noGroupsSelected')
  return selectedDingTalkGroupDestinations.value.map((item) => item.label).join(', ')
})

function viewSummaryName(viewId: string, fallback: string) {
  const id = viewId.trim()
  if (!id) return fallback
  return (props.views ?? []).find((view) => view.id === id)?.name ?? id
}

function templatePreviewText(value: string, fallback: string) {
  return value.trim() ? value.trim() : fallback
}

function renderedTemplateExample(value: string, fallback: string) {
  const trimmed = value.trim()
  if (!trimmed) return fallback
  const rendered = renderDingTalkTemplateExample(trimmed, isZh.value).trim()
  return rendered || fallback
}

function publicFormLinkWarnings(value: unknown, warnWhenDingTalkAccessRisk = false) {
  return listDingTalkPublicFormLinkWarnings(value, formViews.value, {
    isZh: isZh.value,
    warnWhenFullyPublic: warnWhenDingTalkAccessRisk,
    warnWhenProtectedWithoutAllowlist: warnWhenDingTalkAccessRisk,
  })
}

function publicFormLinkBlockingErrors(value: unknown) {
  return listDingTalkPublicFormLinkBlockingErrors(value, formViews.value, { isZh: isZh.value })
}

function internalViewLinkWarnings(value: unknown) {
  return listDingTalkInternalViewLinkWarnings(value, internalViews.value, isZh.value)
}

function internalViewLinkBlockingErrors(value: unknown) {
  return listDingTalkInternalViewLinkBlockingErrors(value, internalViews.value, isZh.value)
}

function readPublicFormToken(view: MetaView): string {
  const publicForm = view.config?.publicForm
  if (!publicForm || typeof publicForm !== 'object' || Array.isArray(publicForm)) return ''
  const token = (publicForm as Record<string, unknown>).publicToken
  return typeof token === 'string' ? token.trim() : ''
}

function buildPublicFormHref(viewId: string, publicToken: string): string {
  return `${window.location.origin}/multitable/public-form/${props.sheetId}/${viewId}?publicToken=${encodeURIComponent(publicToken)}`
}

function dingTalkActionConfigs(rule: AutomationRule): Record<string, unknown>[] {
  const actionTypes: AutomationActionType[] = ['send_dingtalk_group_message', 'send_dingtalk_person_message']
  const configs = (rule.actions ?? [])
    .filter((action) => actionTypes.includes(action.type))
    .map((action) => action.config)
  if (!configs.length && actionTypes.includes(rule.actionType)) {
    configs.push(rule.actionConfig)
  }
  return configs
}

function dingTalkCardLinks(rule: AutomationRule): DingTalkCardLink[] {
  const seen = new Set<string>()
  const links: DingTalkCardLink[] = []

  for (const actionConfig of dingTalkActionConfigs(rule)) {
    const publicFormViewId = typeof actionConfig.publicFormViewId === 'string'
      ? actionConfig.publicFormViewId.trim()
      : ''
    if (publicFormViewId && !listDingTalkPublicFormLinkBlockingErrors(publicFormViewId, formViews.value).length) {
      const view = formViews.value.find((item) => item.id === publicFormViewId)
      const publicToken = view ? readPublicFormToken(view) : ''
      const key = `public-form:${publicFormViewId}`
      if (view && publicToken && !seen.has(key)) {
        const accessState = getDingTalkPublicFormLinkAccessState(publicFormViewId, formViews.value)
        seen.add(key)
        links.push({
          key,
          label: automationCardLinkLabel('publicForm', viewSummaryName(publicFormViewId, publicFormViewId), isZh.value),
          href: buildPublicFormHref(publicFormViewId, publicToken),
          accessSummary: accessState.summary,
          audienceSummary: accessState.audienceSummary,
          accessLevel: accessState.level,
        })
      }
    }

    const internalViewId = typeof actionConfig.internalViewId === 'string'
      ? actionConfig.internalViewId.trim()
      : ''
    if (internalViewId && !listDingTalkInternalViewLinkBlockingErrors(internalViewId, internalViews.value).length) {
      const key = `internal-view:${internalViewId}`
      if (!seen.has(key)) {
        seen.add(key)
        links.push({
          key,
          label: automationCardLinkLabel('internalView', viewSummaryName(internalViewId, internalViewId), isZh.value),
          viewId: internalViewId,
        })
      }
    }
  }

  return links
}

function openInternalView(viewId: string) {
  if (!viewId) return
  void router.push({
    name: AppRouteNames.MULTITABLE,
    params: {
      sheetId: props.sheetId,
      viewId,
    },
  })
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
  const userLabels = selectedDingTalkPersonRecipients.value.map((item) => item.label)
  const groupLabels = selectedDingTalkPersonMemberGroups.value.map((item) => item.label)
  const parts = [
    userLabels.length ? `${isZh.value ? '用户' : 'Users'}: ${userLabels.join(', ')}` : '',
    groupLabels.length ? `${isZh.value ? '成员组' : 'Groups'}: ${groupLabels.join(', ')}` : '',
  ].filter(Boolean)
  if (!parts.length) return l('dingtalk.noRecipientsSelected')
  return parts.join(' | ')
})

const selectedDingTalkGroupDestinationFields = computed(() => parseRecipientFieldPathsText(draft.value.dingtalkDestinationFieldPath)
  .map((path) => ({
    id: path,
    label: recipientFieldSummaryLabel(path),
  }))
  .filter((item) => item.label))

function parseRecipientFieldPathsText(value: string): string[] {
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

function groupDestinationFieldPathWarnings(value: string) {
  return listDingTalkGroupDestinationFieldPathWarnings(value, props.fields, isZh.value)
}

const dingTalkPersonRecipientCandidateFields = computed(() => props.fields.filter((field) => field.type === 'user'))
const dingTalkPersonMemberGroupRecipientCandidateFields = computed(() => props.fields.filter(isDingTalkMemberGroupRecipientField))

const selectedDingTalkPersonRecipientFields = computed(() => parseRecipientFieldPathsText(draft.value.dingtalkPersonRecipientFieldPath)
  .map((path) => ({
    id: path,
    label: recipientFieldSummaryLabel(path),
  }))
  .filter((item) => item.label))

const selectedDingTalkPersonMemberGroupRecipientFields = computed(() => parseRecipientFieldPathsText(draft.value.dingtalkPersonMemberGroupRecipientFieldPath)
  .map((path) => ({
    id: path,
    label: recipientFieldSummaryLabel(path),
  }))
  .filter((item) => item.label))

function recipientFieldPathWarnings(value: string) {
  return listDingTalkPersonRecipientFieldPathWarnings(value, props.fields, isZh.value)
}

function memberGroupRecipientFieldPathWarnings(value: string) {
  return listDingTalkPersonMemberGroupRecipientFieldPathWarnings(value, props.fields, isZh.value)
}

const dingTalkPersonRecipientFieldSummary = computed(() => {
  const labels = selectedDingTalkPersonRecipientFields.value.map((item) => item.label)
  if (!labels.length) return l('dingtalk.noDynamicRecipientField')
  return labels.join(', ')
})

const dingTalkPersonMemberGroupFieldSummary = computed(() => {
  const labels = parseRecipientFieldPathsText(draft.value.dingtalkPersonMemberGroupRecipientFieldPath)
    .map((path) => recipientFieldSummaryLabel(path))
    .filter(Boolean)
  if (!labels.length) return l('dingtalk.noDynamicMemberGroupField')
  return labels.join(', ')
})

const dingTalkGroupFieldSummary = computed(() => {
  const labels = selectedDingTalkGroupDestinationFields.value.map((item) => item.label)
  if (!labels.length) return l('dingtalk.noDynamicGroupField')
  return labels.join(', ')
})

function appendDingTalkGroupDestinationField(selected: string) {
  const value = selected.trim()
  if (!value) return
  const paths = parseRecipientFieldPathsText(draft.value.dingtalkDestinationFieldPath)
  paths.push(value)
  draft.value.dingtalkDestinationFieldPath = Array.from(new Set(paths))
    .map((path) => `record.${path}`)
    .join(', ')
}

function removeDingTalkGroupDestinationField(path: string) {
  draft.value.dingtalkDestinationFieldPath = parseRecipientFieldPathsText(draft.value.dingtalkDestinationFieldPath)
    .filter((entry) => entry !== path)
    .map((entry) => `record.${entry}`)
    .join(', ')
}

function appendDingTalkPersonRecipientField(selected: string) {
  const value = selected.trim()
  if (!value) return
  const paths = parseRecipientFieldPathsText(draft.value.dingtalkPersonRecipientFieldPath)
  paths.push(value)
  draft.value.dingtalkPersonRecipientFieldPath = Array.from(new Set(paths))
    .map((path) => `record.${path}`)
    .join(', ')
}

function removeDingTalkPersonRecipientField(path: string) {
  draft.value.dingtalkPersonRecipientFieldPath = parseRecipientFieldPathsText(draft.value.dingtalkPersonRecipientFieldPath)
    .filter((entry) => entry !== path)
    .map((entry) => `record.${entry}`)
    .join(', ')
}

function appendDingTalkPersonMemberGroupRecipientField(selected: string) {
  const value = selected.trim()
  if (!value) return
  const paths = parseRecipientFieldPathsText(draft.value.dingtalkPersonMemberGroupRecipientFieldPath)
  paths.push(value)
  draft.value.dingtalkPersonMemberGroupRecipientFieldPath = Array.from(new Set(paths))
    .map((path) => `record.${path}`)
    .join(', ')
}

function removeDingTalkPersonMemberGroupRecipientField(path: string) {
  draft.value.dingtalkPersonMemberGroupRecipientFieldPath = parseRecipientFieldPathsText(draft.value.dingtalkPersonMemberGroupRecipientFieldPath)
    .filter((entry) => entry !== path)
    .map((entry) => `record.${entry}`)
    .join(', ')
}

function templateSyntaxWarnings(value: string) {
  return listDingTalkTemplateSyntaxWarnings(value, isZh.value)
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
    isZh.value,
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
    isZh.value,
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
// G-B2-23: most-recent-first execution page (0 or 1 entries) per rule, feeding the card's
// "last run" chip. Absent key = not fetched yet (component v-ifs the chip away); a rule
// whose fetch failed is simply omitted this round rather than recorded as an error state,
// same "skip on failure" semantics `ruleStats` already had (a stale/missing chip is an
// honest degrade — see `loadRuleLastRuns` below — not a rendering error for the whole list).
const ruleLastRun = ref<Record<string, AutomationExecution[]>>({})
const ruleTestRunStates = ref<Record<string, AutomationTestRunState>>({})
const activeRuleTestRunState = computed(() => {
  const ruleId = editingRule.value?.id
  return ruleId ? ruleTestRunStates.value[ruleId] : undefined
})

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
  setRuleTestRunState(ruleId, {
    status: 'running',
    message: testRunPendingMessage(ruleId),
  })
  try {
    const execution = await props.client.testAutomationRule(props.sheetId, ruleId)
    setRuleTestRunState(ruleId, describeTestRunExecution(execution))
    await refreshRuleCardData(ruleId)
  } catch (err: unknown) {
    setRuleTestRunState(ruleId, {
      status: 'failed',
      message: automationTestRunRequestFailed(readErrorMessage(err), isZh.value),
    })
  }
}

function setRuleTestRunState(ruleId: string, state: AutomationTestRunState) {
  ruleTestRunStates.value = { ...ruleTestRunStates.value, [ruleId]: state }
}

function readErrorMessage(err: unknown): string {
  return err instanceof Error && err.message.trim() ? err.message : ''
}

function testRunPendingMessage(ruleId: string): string {
  return hasDingTalkRuleActions(rules.value.find((rule) => rule.id === ruleId))
    ? l('manager.testRunningDingTalkWarning')
    : l('manager.testRunning')
}

function hasDingTalkRuleActions(rule: AutomationRule | undefined): boolean {
  if (!rule) return false
  return isDingTalkActionType(rule.actionType) || Boolean(rule.actions?.some((action) => isDingTalkActionType(action.type)))
}

function isDingTalkActionType(actionType: AutomationActionType): boolean {
  return actionType === 'send_dingtalk_group_message' || actionType === 'send_dingtalk_person_message'
}

function describeTestRunExecution(execution: AutomationExecution): AutomationTestRunState {
  const failedStep = execution.steps?.find((step) => step.status === 'failed')
  const durationMs = typeof execution.duration === 'number' ? execution.duration : undefined
  const duration = typeof durationMs === 'number' ? ` (${Math.round(durationMs)} ms)` : ''
  if (execution.status === 'failed' || failedStep) {
    return {
      status: 'failed',
      message: automationTestRunFailed(execution.error || failedStep?.error || '', isZh.value),
    }
  }
  if (execution.status === 'skipped') {
    return {
      status: 'skipped',
      message: automationTestRunSkipped(duration, isZh.value),
    }
  }
  return {
    status: 'success',
    message: automationTestRunSucceeded(duration, isZh.value),
  }
}

// G-B2-23: stats used to load one rule at a time (`for (const rule of rules.value) await
// loadRuleStatsForRule(rule.id)`), paying every rule's request round-trip serially — N
// rules meant N sequential network waits before the last card's stats appeared. Fetching
// concurrently and folding the results into `ruleStats` in a single assignment (via
// `loadRuleEntriesConcurrently` / `mergeRuleEntries`, see automation-rule-concurrent-merge.ts
// for why the merge must happen in one pass) removes that serial tax without reintroducing
// the "N separate `ruleStats.value = {...ruleStats.value, [id]: st}` writes" shape that
// function is built to avoid. A rule whose stats fetch fails is simply left out of this
// round's merge — matches the previous per-rule try/catch's "skip on failure" behavior.
async function loadRuleStats() {
  if (!props.client) return
  const client = props.client
  const sheetId = props.sheetId
  ruleStats.value = await loadRuleEntriesConcurrently(
    ruleStats.value,
    rules.value.map((rule) => rule.id),
    (ruleId) => client.getAutomationStats(sheetId, ruleId),
  )
}

// G-B2-23: "last run" chip data — same concurrent-fetch-then-one-shot-merge shape as
// `loadRuleStats` above, requesting just the newest execution per rule
// (`getAutomationLogs(sheetId, ruleId, 1)`, newest-first per the backend contract) rather
// than the full log page the log viewer needs.
async function loadRuleLastRuns() {
  if (!props.client) return
  const client = props.client
  const sheetId = props.sheetId
  ruleLastRun.value = await loadRuleEntriesConcurrently(
    ruleLastRun.value,
    rules.value.map((rule) => rule.id),
    (ruleId) => client.getAutomationLogs(sheetId, ruleId, 1),
  )
}

function ruleLastRunChipFor(ruleId: string): AutomationLastRunChip {
  return automationLastRunChip(ruleLastRun.value[ruleId] ?? [], new Date(), isZh.value)
}

/**
 * Refresh a single rule's stats + last-run chip after a manual test run creates a fresh
 * execution for it. Each fetch is independently merged with `mergeRuleEntries` (a plain
 * one-entry batch) and independently swallowed on failure, so a stats-fetch failure can't
 * suppress the last-run chip update or vice versa — same "one bad fetch doesn't blank
 * data we already have" rule the concurrent multi-rule loaders follow.
 */
async function refreshRuleCardData(ruleId: string) {
  if (!props.client) return
  const client = props.client
  const sheetId = props.sheetId
  try {
    const st = await client.getAutomationStats(sheetId, ruleId)
    ruleStats.value = mergeRuleEntries(ruleStats.value, [[ruleId, st]])
  } catch {
    // skip — leave whatever stats we already had for this rule in place
  }
  try {
    const executions = await client.getAutomationLogs(sheetId, ruleId, 1)
    ruleLastRun.value = mergeRuleEntries(ruleLastRun.value, [[ruleId, executions]])
  } catch {
    // skip — leave whatever last-run chip we already had for this rule in place
  }
}

const canSave = computed(() => {
  if (!draft.value.name.trim()) return false
  if (draft.value.triggerType === 'field.changed' && !draft.value.triggerFieldId) return false
  if (draft.value.actionType === 'notify' && !draft.value.notifyMessage.trim()) return false
  if (draft.value.actionType === 'update_field' && (!draft.value.targetFieldId || !draft.value.targetValue.trim())) return false
  if (draft.value.actionType === 'send_dingtalk_group_message') {
    const destinationFieldPaths = parseRecipientFieldPathsText(draft.value.dingtalkDestinationFieldPath)
    if (!draft.value.dingtalkDestinationIds.length && !destinationFieldPaths.length) return false
    if (!draft.value.dingtalkTitleTemplate.trim()) return false
    if (!draft.value.dingtalkBodyTemplate.trim()) return false
    if (publicFormLinkBlockingErrors(draft.value.publicFormViewId).length) return false
    if (internalViewLinkBlockingErrors(draft.value.internalViewId).length) return false
  }
  if (draft.value.actionType === 'send_dingtalk_person_message') {
    const userIds = parseUserIdsText(draft.value.dingtalkPersonUserIds)
    const memberGroupIds = parseMemberGroupIdsText(draft.value.dingtalkPersonMemberGroupIds)
    const recipientFieldPaths = parseRecipientFieldPathsText(draft.value.dingtalkPersonRecipientFieldPath)
    const memberGroupRecipientFieldPaths = parseRecipientFieldPathsText(draft.value.dingtalkPersonMemberGroupRecipientFieldPath)
    if (
      !userIds.length
      && !memberGroupIds.length
      && !recipientFieldPaths.length
      && !memberGroupRecipientFieldPaths.length
    ) return false
    if (!draft.value.dingtalkPersonTitleTemplate.trim()) return false
    if (!draft.value.dingtalkPersonBodyTemplate.trim()) return false
    if (publicFormLinkBlockingErrors(draft.value.dingtalkPersonPublicFormViewId).length) return false
    if (internalViewLinkBlockingErrors(draft.value.dingtalkPersonInternalViewId).length) return false
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
    dingtalkDestinationIds: parseGroupDestinationIds(rule.actionConfig?.destinationIds ?? rule.actionConfig?.destinationId),
    dingtalkDestinationPickerId: '',
    dingtalkDestinationFieldPath: Array.isArray(rule.actionConfig?.destinationIdFieldPaths)
      ? (rule.actionConfig?.destinationIdFieldPaths as string[]).join(', ')
      : (rule.actionConfig?.destinationIdFieldPath as string) ?? '',
    dingtalkTitleTemplate: (rule.actionConfig?.titleTemplate as string) ?? '',
    dingtalkBodyTemplate: (rule.actionConfig?.bodyTemplate as string) ?? '',
    publicFormViewId: (rule.actionConfig?.publicFormViewId as string) ?? '',
    internalViewId: (rule.actionConfig?.internalViewId as string) ?? '',
    dingtalkPersonUserIds: Array.isArray(rule.actionConfig?.userIds) ? rule.actionConfig?.userIds.join(', ') : '',
    dingtalkPersonMemberGroupIds: Array.isArray(rule.actionConfig?.memberGroupIds) ? rule.actionConfig?.memberGroupIds.join(', ') : '',
    dingtalkPersonRecipientFieldPath: Array.isArray(rule.actionConfig?.userIdFieldPaths)
      ? (rule.actionConfig?.userIdFieldPaths as string[]).join(', ')
      : (rule.actionConfig?.userIdFieldPath as string) ?? '',
    dingtalkPersonMemberGroupRecipientFieldPath: Array.isArray(rule.actionConfig?.memberGroupIdFieldPaths)
      ? (rule.actionConfig?.memberGroupIdFieldPaths as string[]).join(', ')
      : (rule.actionConfig?.memberGroupIdFieldPath as string) ?? '',
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
    const destinationIds = Array.from(new Set(draft.value.dingtalkDestinationIds.map((id) => id.trim()).filter(Boolean)))
    const destinationIdFieldPaths = parseRecipientFieldPathsText(draft.value.dingtalkDestinationFieldPath)
      .map((path) => `record.${path}`)
    return {
      destinationId: destinationIds[0] || undefined,
      destinationIds: destinationIds.length ? destinationIds : undefined,
      destinationIdFieldPath: destinationIdFieldPaths[0] || undefined,
      destinationIdFieldPaths: destinationIdFieldPaths.length ? destinationIdFieldPaths : undefined,
      titleTemplate: draft.value.dingtalkTitleTemplate,
      bodyTemplate: draft.value.dingtalkBodyTemplate,
      publicFormViewId: draft.value.publicFormViewId || undefined,
      internalViewId: draft.value.internalViewId || undefined,
    }
  }
  if (draft.value.actionType === 'send_dingtalk_person_message') {
    const memberGroupIds = draft.value.dingtalkPersonMemberGroupIds
      .split(/[\n,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
    const userIdFieldPaths = parseRecipientFieldPathsText(draft.value.dingtalkPersonRecipientFieldPath)
      .map((path) => `record.${path}`)
    const memberGroupIdFieldPaths = parseRecipientFieldPathsText(draft.value.dingtalkPersonMemberGroupRecipientFieldPath)
      .map((path) => `record.${path}`)
    return {
      userIds: draft.value.dingtalkPersonUserIds
        .split(/[\n,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
      memberGroupIds: memberGroupIds.length ? memberGroupIds : undefined,
      userIdFieldPath: userIdFieldPaths[0] || undefined,
      userIdFieldPaths: userIdFieldPaths.length ? userIdFieldPaths : undefined,
      memberGroupIdFieldPath: memberGroupIdFieldPaths[0] || undefined,
      memberGroupIdFieldPaths: memberGroupIdFieldPaths.length ? memberGroupIdFieldPaths : undefined,
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

// UF-8: ElMessageBox.confirm replaces window.confirm (design-lock §3.6).
async function confirmDeleteRule(rule: AutomationRule): Promise<boolean> {
  try {
    await ElMessageBox.confirm(
      automationDeleteRuleConfirmMessage(rule.name, ruleStats.value[rule.id], isZh.value),
      automationLabel('manager.deleteConfirmTitle', isZh.value),
      { type: 'warning', confirmButtonText: automationLabel('manager.delete', isZh.value), cancelButtonText: automationLabel('editor.cancel', isZh.value) },
    )
    return true
  } catch {
    return false
  }
}

async function onDelete(rule: AutomationRule) {
  // B1-06: irreversible + takes the rule's execution-history entry point with it — confirm first,
  // with cumulative run counts as blast radius when stats are already loaded.
  if (!(await confirmDeleteRule(rule))) return
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
      return automationCardTriggerSummary(rule.triggerType, '', isZh.value)
    case 'record.updated':
      return automationCardTriggerSummary(rule.triggerType, '', isZh.value)
    case 'field.changed': {
      const fid = rule.triggerConfig?.fieldId as string | undefined
      return automationCardTriggerSummary(rule.triggerType, fid ? fieldNameById(fid) : '', isZh.value)
    }
    // T1-2/T1-3: editor-exposed triggers get their localized type label in the card summary.
    case 'webhook.received':
    case 'approval.completed':
    case 'approval.task_created':
      return automationTriggerTypeLabel(rule.triggerType, isZh.value)
    default:
      return String(rule.triggerType)
  }
}

function describeAction(rule: AutomationRule): string {
  if (rule.actions?.length) {
    return rule.actions.map((action) => describeActionType(action.type, action.config)).join(' + ')
  }
  return describeActionType(rule.actionType, rule.actionConfig)
}

function describeActionType(actionType: AutomationActionType, actionConfig: Record<string, unknown>): string {
  switch (actionType) {
    case 'notify':
    case 'send_notification':
      return automationCardActionSummary(actionType, '', isZh.value)
    case 'update_field': {
      const fid = actionConfig?.fieldId as string | undefined
      return automationCardActionSummary(actionType, fid ? fieldNameById(fid) : '', isZh.value)
    }
    case 'update_record':
    case 'create_record':
    case 'send_webhook':
    case 'delete_record':
    case 'lock_record':
      return automationCardActionSummary(actionType, '', isZh.value)
    case 'send_dingtalk_group_message':
    case 'send_dingtalk_person_message':
      return `${automationCardActionSummary(actionType, '', isZh.value)}${describeDingTalkActionLinks(actionConfig)}`
    default:
      return String(actionType)
  }
}

function describeDingTalkActionLinks(actionConfig: Record<string, unknown>): string {
  const publicFormViewId = typeof actionConfig.publicFormViewId === 'string'
    ? actionConfig.publicFormViewId.trim()
    : ''
  const internalViewId = typeof actionConfig.internalViewId === 'string'
    ? actionConfig.internalViewId.trim()
    : ''
  const parts = [
    publicFormViewId ? automationCardLinkSummary('publicForm', viewSummaryName(publicFormViewId, publicFormViewId), isZh.value) : '',
    internalViewId ? automationCardLinkSummary('internalView', viewSummaryName(internalViewId, internalViewId), isZh.value) : '',
  ].filter(Boolean)
  return parts.length ? ` · ${parts.join(' · ')}` : ''
}

function allowedAudienceText(summary: string): string {
  return `${l('manager.allowedAudiencePrefix')}${isZh.value ? '' : ' '}${summary}`
}

function ruleHasActionType(rule: AutomationRule, actionType: AutomationActionType): boolean {
  return rule.actionType === actionType || (rule.actions ?? []).some((action) => action.type === actionType)
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
      void loadRuleLastRuns()
    }
  },
  { immediate: true },
)
</script>

<style scoped>
/* UF-4: the hand-rolled fixed overlay + panel + header/close chrome is now provided by el-drawer,
   and native control skins (.meta-automation__input/__select/__btn…) by Element Plus. Remaining
   rules are layout + this component's own semantic surfaces, colored via tokens.css only. */
.meta-automation__title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--ms-text-1);
}

.meta-automation__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.meta-automation__error {
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger-dark-2);
}

.meta-automation__empty {
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
  background: var(--ms-bg-page);
  color: var(--ms-text-3);
}

/* Form */
.meta-automation__form {
  border: 1px solid var(--ms-border-light);
  border-radius: 10px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.meta-automation__form-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--ms-text-1);
  margin-bottom: 4px;
}

.meta-automation__label {
  font-size: 12px;
  font-weight: 600;
  color: var(--ms-text-2);
  margin-top: 4px;
}

.meta-automation__hint {
  font-size: 12px;
  color: var(--ms-text-3);
}

.meta-automation__hint--error {
  color: var(--el-color-danger-dark-2);
}

.meta-automation__hint--warning {
  color: var(--el-color-warning-dark-2);
}

.meta-automation__recipient-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.meta-automation__recipient-list--selected {
  margin-bottom: 4px;
}

.meta-automation__add-row,
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
  color: var(--ms-text-2);
}

.meta-automation__preview {
  border: 1px solid var(--el-color-primary-light-8);
  background: var(--el-color-primary-light-9);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--ms-text-2);
}

.meta-automation__preview-title {
  font-weight: 700;
  color: var(--el-color-primary-dark-2);
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
}

.meta-automation__recipient-option,
.meta-automation__recipient-chip {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  border: 1px solid var(--ms-border);
  border-radius: 8px;
  background: var(--ms-bg-card);
  padding: 8px 10px;
  cursor: pointer;
  color: var(--ms-text-1);
}

.meta-automation__recipient-option span,
.meta-automation__recipient-chip span,
.meta-automation__recipient-chip em {
  font-size: 12px;
  color: var(--ms-text-3);
  font-style: normal;
}

.meta-automation__form-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

/* Cards */
.meta-automation__card {
  border: 1px solid var(--ms-border-light);
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
  color: var(--ms-text-1);
}

.meta-automation__card-desc {
  font-size: 13px;
  color: var(--ms-text-2);
}

.meta-automation__card-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 2px;
}

.meta-automation__card-link-item {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.meta-automation__card-link-access {
  border-radius: 999px;
  background: var(--ms-bg-page);
  color: var(--ms-text-2);
  font-size: 12px;
  line-height: 1;
  padding: 5px 8px;
}

.meta-automation__card-link-access--public {
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning-dark-2);
}

.meta-automation__card-link-access--dingtalk {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary-dark-2);
}

.meta-automation__card-link-access--dingtalk_granted {
  background: var(--el-color-success-light-9);
  color: var(--el-color-success-dark-2);
}

.meta-automation__card-link-access--unavailable {
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger-dark-2);
}

.meta-automation__card-link-audience {
  border-radius: 999px;
  background: var(--ms-bg-page);
  color: var(--ms-text-2);
  font-size: 12px;
  line-height: 1;
  padding: 5px 8px;
}

.meta-automation__public-form-access {
  border-radius: 8px;
  padding: 6px 8px;
}

.meta-automation__public-form-access--none {
  background: var(--ms-bg-page);
  color: var(--ms-text-2);
}

.meta-automation__public-form-access--public {
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning-dark-2);
}

.meta-automation__public-form-access--dingtalk {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary-dark-2);
}

.meta-automation__public-form-access--dingtalk_granted {
  background: var(--el-color-success-light-9);
  color: var(--el-color-success-dark-2);
}

.meta-automation__public-form-access--unavailable {
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger-dark-2);
}

.meta-automation__card-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.meta-automation__btn-link {
  text-decoration: none;
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
.meta-automation__stat--success { color: var(--ms-color-success); }
.meta-automation__stat--failed { color: var(--ms-color-danger); }

/* G-B2-23: rule card "last run" chip — same pill shape as .meta-automation__card-link-access. */
.meta-automation__last-run-chip {
  display: inline-flex;
  align-self: flex-start;
  border-radius: 999px;
  font-size: 12px;
  line-height: 1;
  padding: 5px 8px;
}

.meta-automation__last-run-chip--success { background: var(--el-color-success-light-9); color: var(--el-color-success-dark-2); }
.meta-automation__last-run-chip--failed { background: var(--el-color-danger-light-9); color: var(--el-color-danger-dark-2); }
.meta-automation__last-run-chip--skipped { background: var(--el-color-warning-light-9); color: var(--el-color-warning-dark-2); }
.meta-automation__last-run-chip--none { background: var(--ms-bg-page); color: var(--ms-text-2); }

.meta-automation__test-run-status {
  font-size: 12px;
  font-weight: 600;
}

.meta-automation__test-run-status--success { color: var(--el-color-success-dark-2); }
.meta-automation__test-run-status--failed { color: var(--el-color-danger-dark-2); }
.meta-automation__test-run-status--skipped { color: var(--el-color-warning-dark-2); }
.meta-automation__test-run-status--running { color: var(--el-color-primary-dark-2); }
</style>
