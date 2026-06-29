<template>
  <div v-if="visible" class="meta-rule-editor__overlay" @click.self="$emit('close')">
    <div class="meta-rule-editor">
      <div class="meta-rule-editor__header">
        <h4 class="meta-rule-editor__title">{{ rule ? automationLabel('editor.titleEdit', isZh) : automationLabel('editor.titleNew', isZh) }}</h4>
        <button class="meta-rule-editor__close" type="button" @click="$emit('close')">&times;</button>
      </div>

      <div class="meta-rule-editor__body">
        <div v-if="error" class="meta-rule-editor__error" role="alert">{{ error }}</div>

        <!-- Name -->
        <label class="meta-rule-editor__label">{{ automationLabel('editor.name', isZh) }}</label>
        <input v-model="draft.name" class="meta-rule-editor__input" type="text" :placeholder="automationLabel('editor.namePlaceholder', isZh)" data-field="name" />

        <!-- Execution mode (A6-1 opt-in): persist a per-action WorkflowJob plane -->
        <label class="meta-rule-editor__label" data-field="executionModeToggle">
          <input
            type="checkbox"
            :checked="draft.executionMode === 'workflow_job_v1' || requiresJobMode"
            :disabled="requiresJobMode"
            data-field="executionMode"
            @change="setExecutionMode(($event.target as HTMLInputElement).checked)"
          />
          {{ automationLabel('editor.executionModeLabel', isZh) }}
        </label>
        <div class="meta-rule-editor__hint" data-field="executionModeHint">{{ requiresJobMode ? automationLabel('editor.executionModeRequiredHint', isZh) : automationLabel('editor.executionModeHint', isZh) }}</div>

        <!-- 1. Trigger selector -->
        <section class="meta-rule-editor__section">
          <div class="meta-rule-editor__section-title">{{ automationLabel('trigger.title', isZh) }}</div>
          <select v-model="draft.triggerType" class="meta-rule-editor__select" data-field="triggerType">
            <option value="record.created">{{ automationTriggerTypeLabel('record.created', isZh) }}</option>
            <option value="record.updated">{{ automationTriggerTypeLabel('record.updated', isZh) }}</option>
            <option value="record.deleted">{{ automationTriggerTypeLabel('record.deleted', isZh) }}</option>
            <option value="field.value_changed">{{ automationTriggerTypeLabel('field.value_changed', isZh) }}</option>
            <option value="form.submitted">{{ automationTriggerTypeLabel('form.submitted', isZh) }}</option>
            <option value="schedule.cron">{{ automationTriggerTypeLabel('schedule.cron', isZh) }}</option>
            <option value="schedule.interval">{{ automationTriggerTypeLabel('schedule.interval', isZh) }}</option>
            <option value="schedule.date_field">{{ automationTriggerTypeLabel('schedule.date_field', isZh) }}</option>
            <option value="webhook.received">{{ automationTriggerTypeLabel('webhook.received', isZh) }}</option>
          </select>

          <!-- field.value_changed config -->
          <template v-if="draft.triggerType === 'field.value_changed'">
            <label class="meta-rule-editor__label">{{ automationLabel('trigger.watchField', isZh) }}</label>
            <select v-model="draft.triggerConfig.fieldId" class="meta-rule-editor__select" data-field="triggerFieldId">
              <option value="">{{ automationLabel('trigger.selectField', isZh) }}</option>
              <option v-for="f in fields" :key="f.id" :value="f.id">{{ f.name }}</option>
            </select>
            <label class="meta-rule-editor__label">{{ automationLabel('trigger.condition', isZh) }}</label>
            <select v-model="draft.triggerConfig.condition" class="meta-rule-editor__select" data-field="triggerCondition">
              <option value="any">{{ automationTriggerConditionLabel('any', isZh) }}</option>
              <option value="equals">{{ automationTriggerConditionLabel('equals', isZh) }}</option>
              <option value="changed_to">{{ automationTriggerConditionLabel('changed_to', isZh) }}</option>
            </select>
            <template v-if="draft.triggerConfig.condition !== 'any'">
              <label class="meta-rule-editor__label">{{ automationLabel('editor.value', isZh) }}</label>
              <input v-model="draft.triggerConfig.value" class="meta-rule-editor__input" type="text" :placeholder="automationLabel('editor.value', isZh)" data-field="triggerValue" />
            </template>
          </template>

          <!-- schedule.cron config -->
          <template v-if="draft.triggerType === 'schedule.cron'">
            <label class="meta-rule-editor__label">{{ automationLabel('trigger.preset', isZh) }}</label>
            <select v-model="cronPreset" class="meta-rule-editor__select" data-field="cronPreset">
              <option value="*/5 * * * *">{{ automationCronPresetLabel('*/5 * * * *', isZh) }}</option>
              <option value="0 * * * *">{{ automationCronPresetLabel('0 * * * *', isZh) }}</option>
              <option value="0 0 * * *">{{ automationCronPresetLabel('0 0 * * *', isZh) }}</option>
              <option value="0 0 * * 1">{{ automationCronPresetLabel('0 0 * * 1', isZh) }}</option>
              <option value="custom">{{ automationCronPresetLabel('custom', isZh) }}</option>
            </select>
            <template v-if="cronPreset === 'custom'">
              <label class="meta-rule-editor__label">{{ automationLabel('trigger.cronExpression', isZh) }}</label>
              <input v-model="draft.triggerConfig.cron" class="meta-rule-editor__input" type="text" placeholder="* * * * *" data-field="cronExpression" />
            </template>
          </template>

          <!-- schedule.interval config -->
          <template v-if="draft.triggerType === 'schedule.interval'">
            <label class="meta-rule-editor__label">{{ automationLabel('trigger.intervalMinutes', isZh) }}</label>
            <input v-model.number="draft.triggerConfig.intervalMinutes" class="meta-rule-editor__input" type="number" min="1" placeholder="5" data-field="intervalMinutes" />
          </template>

          <!-- schedule.date_field (date reminder) config -->
          <template v-if="draft.triggerType === 'schedule.date_field'">
            <label class="meta-rule-editor__label">{{ isZh ? '日期字段' : 'Date field' }}</label>
            <select v-model="draft.triggerConfig.dateFieldId" class="meta-rule-editor__select" data-field="dateFieldId">
              <option value="">{{ isZh ? '请选择日期字段' : 'Select a date field' }}</option>
              <option v-for="field in dateReminderCandidateFields" :key="field.id" :value="field.id">{{ field.name }}</option>
            </select>
            <label class="meta-rule-editor__label">{{ isZh ? '提前 / 延后天数' : 'Days offset' }}</label>
            <input v-model.number="draft.triggerConfig.offsetDays" class="meta-rule-editor__input" type="number" min="0" placeholder="3" data-field="offsetDays" />
            <label class="meta-rule-editor__label">{{ isZh ? '方向' : 'Direction' }}</label>
            <select v-model="draft.triggerConfig.direction" class="meta-rule-editor__select" data-field="direction">
              <option value="before">{{ isZh ? '日期之前' : 'Before the date' }}</option>
              <option value="after">{{ isZh ? '日期之后' : 'After the date' }}</option>
            </select>
            <label class="meta-rule-editor__label">{{ isZh ? '触发时间（UTC，可选）' : 'Time of day (UTC, optional)' }}</label>
            <input v-model="draft.triggerConfig.timeOfDay" class="meta-rule-editor__input" type="time" placeholder="09:00" data-field="timeOfDay" />
            <div class="meta-rule-editor__hint" data-field="dateFieldTimeHint">{{ isZh ? '每天按此 UTC 时间触发；服务重启后会补发当天到点的提醒。' : 'Fires daily at this UTC time; a restart catches up today\'s due reminders.' }}</div>
          </template>
        </section>

        <!-- 2. Conditions -->
        <section class="meta-rule-editor__section">
          <div class="meta-rule-editor__section-title">
            {{ automationLabel('condition.title', isZh) }}
            <span class="meta-rule-editor__hint">{{ automationLabel('condition.optional', isZh) }}</span>
          </div>
          <div v-if="draft.conditions.conditions.length > 1" class="meta-rule-editor__conjunction">
            <button
              type="button"
              class="meta-rule-editor__toggle-btn"
              :class="{ 'meta-rule-editor__toggle-btn--active': draft.conditions.conjunction === 'AND' }"
              @click="draft.conditions.conjunction = 'AND'"
            >{{ automationLabel('condition.and', isZh) }}</button>
            <button
              type="button"
              class="meta-rule-editor__toggle-btn"
              :class="{ 'meta-rule-editor__toggle-btn--active': draft.conditions.conjunction === 'OR' }"
              @click="draft.conditions.conjunction = 'OR'"
            >{{ automationLabel('condition.or', isZh) }}</button>
          </div>
          <div class="meta-rule-editor__condition-list">
            <template v-for="entry in conditionEditorEntries" :key="entry.pathKey">
              <div
                v-if="entry.kind === 'group'"
                class="meta-rule-editor__condition-group"
                :style="conditionIndentStyle(entry.depth)"
                :data-condition-group-path="entry.pathKey"
              >
                <span class="meta-rule-editor__group-label">{{ automationLabel('condition.group', isZh) }}</span>
                <div class="meta-rule-editor__conjunction">
                  <button
                    type="button"
                    class="meta-rule-editor__toggle-btn"
                    :class="{ 'meta-rule-editor__toggle-btn--active': normalizeConditionConjunction(entry.group) === 'AND' }"
                    @click="setGroupConjunction(entry.group, 'AND')"
                  >{{ automationLabel('condition.and', isZh) }}</button>
                  <button
                    type="button"
                    class="meta-rule-editor__toggle-btn"
                    :class="{ 'meta-rule-editor__toggle-btn--active': normalizeConditionConjunction(entry.group) === 'OR' }"
                    @click="setGroupConjunction(entry.group, 'OR')"
                  >{{ automationLabel('condition.or', isZh) }}</button>
                </div>
                <div class="meta-rule-editor__condition-actions">
                  <button class="meta-rule-editor__btn" type="button" data-action="add-nested-condition" @click="addConditionToGroup(entry.path)">{{ automationLabel('condition.addNestedCondition', isZh) }}</button>
                  <button
                    class="meta-rule-editor__btn"
                    type="button"
                    data-action="add-condition-group"
                    :disabled="!entry.canAddGroup"
                    @click="addGroupToGroup(entry.path)"
                  >{{ automationLabel('condition.addNestedGroup', isZh) }}</button>
                  <button class="meta-rule-editor__btn meta-rule-editor__btn--icon" type="button" @click="removeConditionNode(entry.path)" :title="automationLabel('condition.removeGroupTitle', isZh)">&times;</button>
                </div>
              </div>
              <div
                v-else
                class="meta-rule-editor__condition-row"
                :style="conditionIndentStyle(entry.depth)"
                :data-condition-index="entry.pathKey"
                :data-condition-path="entry.pathKey"
              >
                <select
                  :value="entry.condition.fieldId"
                  class="meta-rule-editor__select meta-rule-editor__select--sm"
                  @change="onConditionFieldChange(entry.condition, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">{{ automationLabel('condition.selectField', isZh) }}</option>
                  <option v-for="f in fields" :key="f.id" :value="f.id">{{ f.name }}</option>
                </select>
                <select
                  :value="entry.condition.operator"
                  class="meta-rule-editor__select meta-rule-editor__select--sm"
                  @change="onConditionOperatorChange(entry.condition, ($event.target as HTMLSelectElement).value as ConditionOperator)"
                >
                  <option v-for="op in conditionOperatorsForField(entry.condition.fieldId)" :key="op.value" :value="op.value">{{ automationConditionOperatorLabel(op.value, isZh) }}</option>
                </select>
                <template v-if="!isUnaryOperator(entry.condition.operator)">
                  <select
                    v-if="conditionValueWidget(entry.condition) === 'booleanMultiSelect'"
                    :value="booleanMultiSelectConditionValues(entry.condition)"
                    class="meta-rule-editor__select meta-rule-editor__select--sm"
                    data-condition-value="boolean-multi-select"
                    multiple
                    @change="onBooleanMultiSelectConditionValueChange(entry.condition, $event)"
                  >
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                  <select
                    v-else-if="conditionValueWidget(entry.condition) === 'boolean'"
                    :value="booleanConditionValue(entry.condition)"
                    class="meta-rule-editor__select meta-rule-editor__select--sm"
                    data-condition-value="boolean"
                    @change="onBooleanConditionValueChange(entry.condition, ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="">{{ automationLabel('condition.selectValue', isZh) }}</option>
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                  <select
                    v-else-if="conditionValueWidget(entry.condition) === 'select'"
                    :value="singleSelectConditionValue(entry.condition)"
                    class="meta-rule-editor__select meta-rule-editor__select--sm"
                    data-condition-value="select"
                    @change="entry.condition.value = ($event.target as HTMLSelectElement).value"
                  >
                    <option value="">{{ automationLabel('condition.selectValue', isZh) }}</option>
                    <option v-for="option in conditionFieldOptions(entry.condition)" :key="option.value" :value="option.value">
                      {{ optionLabel(option) }}
                    </option>
                  </select>
                  <select
                    v-else-if="conditionValueWidget(entry.condition) === 'multiSelect'"
                    :value="multiSelectConditionValues(entry.condition)"
                    class="meta-rule-editor__select meta-rule-editor__select--sm"
                    data-condition-value="multi-select"
                    multiple
                    @change="onMultiSelectConditionValueChange(entry.condition, $event)"
                  >
                    <option v-for="option in conditionFieldOptions(entry.condition)" :key="option.value" :value="option.value">
                      {{ optionLabel(option) }}
                    </option>
                  </select>
                  <input
                    v-else
                    v-model="entry.condition.value"
                    class="meta-rule-editor__input meta-rule-editor__input--sm"
                    :type="conditionValueInputType(entry.condition)"
                    :inputmode="conditionValueInputMode(entry.condition)"
                    :placeholder="conditionValuePlaceholder(entry.condition)"
                  />
                </template>
                <button class="meta-rule-editor__btn meta-rule-editor__btn--icon" type="button" @click="removeConditionNode(entry.path)" :title="automationLabel('condition.removeConditionTitle', isZh)">&times;</button>
              </div>
            </template>
          </div>
          <div class="meta-rule-editor__condition-actions">
            <button class="meta-rule-editor__btn" type="button" data-action="add-condition" @click="addCondition">{{ automationLabel('condition.addCondition', isZh) }}</button>
            <button class="meta-rule-editor__btn" type="button" data-action="add-condition-group" @click="addGroupToGroup([])">{{ automationLabel('condition.addGroup', isZh) }}</button>
          </div>
        </section>

        <!-- 3. Actions -->
        <section class="meta-rule-editor__section">
          <div class="meta-rule-editor__section-title">{{ automationLabel('editor.actions', isZh) }} <span class="meta-rule-editor__hint">{{ automationLabel('editor.actionStepHint', isZh) }}</span></div>
          <div
            v-for="(action, idx) in draft.actions"
            :key="idx"
            class="meta-rule-editor__action-row"
            :data-action-index="idx"
          >
            <div class="meta-rule-editor__action-header">
              <span class="meta-rule-editor__action-num">{{ idx + 1 }}.</span>
              <select v-model="action.type" class="meta-rule-editor__select" @change="onDraftActionTypeChange(action)">
                <option
                  v-for="type in selectableActionTypes(action.type)"
                  :key="type"
                  :value="type"
                  :disabled="isUnsupportedSelectableActionType(type)"
                >
                  {{ automationActionTypeLabel(type, isZh) }}
                </option>
              </select>
              <div class="meta-rule-editor__action-btns">
                <button v-if="idx > 0" class="meta-rule-editor__btn meta-rule-editor__btn--icon" type="button" @click="moveAction(idx, -1)" :title="automationLabel('editor.moveUpTitle', isZh)">&#x2191;</button>
                <button v-if="idx < draft.actions.length - 1" class="meta-rule-editor__btn meta-rule-editor__btn--icon" type="button" @click="moveAction(idx, 1)" :title="automationLabel('editor.moveDownTitle', isZh)">&#x2193;</button>
                <button class="meta-rule-editor__btn meta-rule-editor__btn--icon" type="button" @click="removeAction(idx)" :title="automationLabel('editor.removeActionTitle', isZh)">&times;</button>
              </div>
            </div>

            <!-- update_record config -->
            <div v-if="action.type === 'update_record'" class="meta-rule-editor__action-config">
              <div v-for="(pair, pidx) in (action.config.fieldUpdates as FieldPair[] || [])" :key="pidx" class="meta-rule-editor__field-pair">
                <select v-model="pair.fieldId" class="meta-rule-editor__select meta-rule-editor__select--sm">
                  <option value="">{{ automationLabel('condition.selectField', isZh) }}</option>
                  <option v-for="f in fields" :key="f.id" :value="f.id">{{ f.name }}</option>
                </select>
                <input v-model="pair.value" class="meta-rule-editor__input meta-rule-editor__input--sm" type="text" :placeholder="automationLabel('editor.value', isZh)" />
                <button class="meta-rule-editor__btn meta-rule-editor__btn--icon" type="button" @click="removeFieldUpdate(action, pidx)">&times;</button>
              </div>
              <button class="meta-rule-editor__btn" type="button" @click="addFieldUpdate(action)">{{ automationLabel('editor.addField', isZh) }}</button>
            </div>

            <!-- create_record config -->
            <div v-if="action.type === 'create_record'" class="meta-rule-editor__action-config">
              <label class="meta-rule-editor__label">{{ automationLabel('actionConfig.targetSheetId', isZh) }}</label>
              <input v-model="action.config.targetSheetId" class="meta-rule-editor__input" type="text" :placeholder="automationLabel('actionConfig.sheetIdPlaceholder', isZh)" />
              <div v-for="(pair, pidx) in (action.config.fieldValues as FieldPair[] || [])" :key="pidx" class="meta-rule-editor__field-pair">
                <input v-model="pair.fieldId" class="meta-rule-editor__input meta-rule-editor__input--sm" type="text" :placeholder="automationLabel('actionConfig.fieldIdPlaceholder', isZh)" />
                <input v-model="pair.value" class="meta-rule-editor__input meta-rule-editor__input--sm" type="text" :placeholder="automationLabel('editor.value', isZh)" />
                <button class="meta-rule-editor__btn meta-rule-editor__btn--icon" type="button" @click="removeCreateFieldValue(action, pidx)">&times;</button>
              </div>
              <button class="meta-rule-editor__btn" type="button" @click="addCreateFieldValue(action)">{{ automationLabel('editor.addField', isZh) }}</button>
            </div>

            <!-- send_webhook config -->
            <div v-if="action.type === 'send_webhook'" class="meta-rule-editor__action-config">
              <label class="meta-rule-editor__label">{{ automationLabel('actionConfig.url', isZh) }}</label>
              <input v-model="action.config.url" class="meta-rule-editor__input" type="url" placeholder="https://..." />
              <label class="meta-rule-editor__label">{{ automationLabel('actionConfig.method', isZh) }}</label>
              <select v-model="action.config.method" class="meta-rule-editor__select">
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
                <option value="GET">GET</option>
              </select>
            </div>

            <!-- send_notification config -->
            <div v-if="action.type === 'send_notification'" class="meta-rule-editor__action-config">
              <label class="meta-rule-editor__label">{{ automationLabel('actionConfig.userId', isZh) }}</label>
              <input v-model="action.config.userId" class="meta-rule-editor__input" type="text" :placeholder="automationLabel('actionConfig.userId', isZh)" />
              <label class="meta-rule-editor__label">{{ automationLabel('actionConfig.message', isZh) }}</label>
              <textarea v-model="action.config.message" class="meta-rule-editor__textarea" :placeholder="automationLabel('actionConfig.notificationMessagePlaceholder', isZh)" rows="3"></textarea>
            </div>

            <!-- start_approval config -->
            <div v-if="action.type === 'start_approval'" class="meta-rule-editor__action-config">
              <label class="meta-rule-editor__label">{{ isZh ? '审批模板' : 'Approval template' }}</label>
              <select v-if="approvalTemplates.length > 0" v-model="action.config.templateId" class="meta-rule-editor__select" data-field="approvalTemplateId">
                <option value="">{{ isZh ? '请选择审批模板' : 'Select an approval template' }}</option>
                <option v-for="t in approvalTemplates" :key="t.id" :value="t.id">{{ t.name || t.id }}</option>
              </select>
              <input v-else v-model="action.config.templateId" class="meta-rule-editor__input" type="text" :placeholder="isZh ? '审批模板 ID' : 'Approval template ID'" data-field="approvalTemplateId" />
              <label class="meta-rule-editor__label">{{ isZh ? '表单字段映射（审批字段 → 记录字段）' : 'Form-data mapping (approval field → record field)' }}</label>
              <div v-for="(pair, pidx) in (action.config.formDataMappingPairs as FieldPair[] || [])" :key="pidx" class="meta-rule-editor__field-pair">
                <input v-model="pair.fieldId" class="meta-rule-editor__input meta-rule-editor__input--sm" type="text" :placeholder="isZh ? '审批字段' : 'Approval field'" data-field="approvalMappingKey" />
                <select v-model="pair.value" class="meta-rule-editor__select meta-rule-editor__select--sm" data-field="approvalMappingValue">
                  <option value="">{{ automationLabel('condition.selectField', isZh) }}</option>
                  <option v-for="f in fields" :key="f.id" :value="f.id">{{ f.name }}</option>
                </select>
                <button class="meta-rule-editor__btn meta-rule-editor__btn--icon" type="button" @click="removeApprovalMapping(action, pidx)">&times;</button>
              </div>
              <button class="meta-rule-editor__btn" type="button" @click="addApprovalMapping(action)">{{ automationLabel('editor.addField', isZh) }}</button>
            </div>

            <!-- send_email config -->
            <div v-if="action.type === 'send_email'" class="meta-rule-editor__action-config">
              <label class="meta-rule-editor__label">{{ automationLabel('actionConfig.recipients', isZh) }}</label>
              <textarea
                v-model="action.config.recipientsText"
                class="meta-rule-editor__textarea"
                rows="3"
                placeholder="ops@example.com, owner@example.com"
                data-field="emailRecipients"
              ></textarea>
              <div class="meta-rule-editor__hint">{{ automationLabel('actionConfig.emailRecipientsHint', isZh) }}</div>
              <label class="meta-rule-editor__label">{{ automationLabel('actionConfig.subjectTemplate', isZh) }}</label>
              <input
                v-model="action.config.subjectTemplate"
                class="meta-rule-editor__input"
                type="text"
                :placeholder="automationLabel('actionConfig.emailSubjectPlaceholder', isZh)"
                data-field="emailSubjectTemplate"
              />
              <label class="meta-rule-editor__label">{{ automationLabel('actionConfig.bodyTemplate', isZh) }}</label>
              <textarea
                v-model="action.config.bodyTemplate"
                class="meta-rule-editor__textarea"
                rows="4"
                :placeholder="automationLabel('actionConfig.emailBodyPlaceholder', isZh)"
                data-field="emailBodyTemplate"
              ></textarea>
            </div>

            <!-- send_dingtalk_group_message config -->
            <div v-if="action.type === 'send_dingtalk_group_message'" class="meta-rule-editor__action-config">
              <div class="meta-rule-editor__preset-row">
                <span class="meta-rule-editor__preset-label">{{ automationLabel('dingtalk.preset', isZh) }}</span>
                <button class="meta-rule-editor__btn" type="button" data-field="groupPresetForm" @click="applyGroupPreset(action, 'form_request')">{{ automationDingTalkPresetLabel('form_request', isZh) }}</button>
                <button class="meta-rule-editor__btn" type="button" data-field="groupPresetInternal" @click="applyGroupPreset(action, 'internal_process')">{{ automationDingTalkPresetLabel('internal_process', isZh) }}</button>
                <button class="meta-rule-editor__btn" type="button" data-field="groupPresetBoth" @click="applyGroupPreset(action, 'form_and_process')">{{ automationDingTalkPresetLabel('form_and_process', isZh) }}</button>
              </div>
              <label class="meta-rule-editor__label">{{ automationLabel('dingtalk.addGroups', isZh) }}</label>
              <select
                v-model="action.config.destinationPickerId"
                class="meta-rule-editor__select"
                data-field="dingtalkDestinationPickerId"
                @change="appendGroupDestination(action, $event.target as HTMLSelectElement)"
              >
                <option value="">{{ automationLabel('dingtalk.addGroupOption', isZh) }}</option>
                <option v-for="destination in availableGroupDestinations(action)" :key="destination.id" :value="destination.id">
                  {{ destination.name }} · {{ groupDestinationScopeLabel(destination) }}
                </option>
              </select>
              <div class="meta-rule-editor__hint" data-field="dingtalkDestinationPickerHint">
                {{ automationLabel('dingtalk.groupsRegisteredHint', isZh) }}
              </div>
              <div
                v-if="!dingTalkDestinationsError && dingTalkDestinations.length === 0"
                class="meta-rule-editor__hint"
                data-field="dingtalkDestinationEmpty"
              >
                {{ automationLabel('dingtalk.noGroupsAvailable', isZh) }}
              </div>
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
                  <em>{{ automationLabel('dingtalk.remove', isZh) }}</em>
                </button>
              </div>
              <div v-if="dingTalkDestinationsError" class="meta-rule-editor__hint">{{ dingTalkDestinationsError }}</div>
              <label class="meta-rule-editor__label">{{ automationLabel('dingtalk.recordGroupFieldPaths', isZh) }}</label>
              <input
                v-model="action.config.destinationFieldPath"
                class="meta-rule-editor__input"
                type="text"
                placeholder="record.opsDestinationId, record.escalationDestinationIds"
                data-field="dingtalkDestinationFieldPath"
              />
              <div class="meta-rule-editor__hint" data-field="dingtalkDestinationFieldPathHint">
                {{ automationLabel('dingtalk.recordGroupFieldPathHint', isZh) }}
              </div>
              <label class="meta-rule-editor__label">{{ automationLabel('dingtalk.pickGroupField', isZh) }}</label>
              <select
                class="meta-rule-editor__select"
                data-field="dingtalkDestinationFieldSelect"
                @change="appendGroupDestinationFieldPath(action, $event.target as HTMLSelectElement)"
              >
                <option value="">{{ automationLabel('dingtalk.pickFieldOption', isZh) }}</option>
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
                  <em>{{ automationLabel('dingtalk.remove', isZh) }}</em>
                </button>
              </div>
              <div
                v-for="warning in groupDestinationFieldPathWarnings(action.config.destinationFieldPath)"
                :key="`group-destination-${warning}`"
                class="meta-rule-editor__hint meta-rule-editor__hint--warning"
              >
                {{ warning }}
              </div>
              <label class="meta-rule-editor__label">{{ automationLabel('dingtalk.titleTemplate', isZh) }}</label>
              <input
                v-model="action.config.titleTemplate"
                class="meta-rule-editor__input"
                type="text"
                :placeholder="automationLabel('dingtalk.titleTemplatePlaceholder', isZh)"
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
                <span class="meta-rule-editor__preset-label">{{ automationLabel('dingtalk.templateTokens', isZh) }}</span>
                <button
                  v-for="token in DINGTALK_TITLE_TEMPLATE_TOKENS"
                  :key="token.key"
                  class="meta-rule-editor__btn"
                  type="button"
                  :data-field="`groupTitleToken-${token.key}`"
                  @click="appendGroupTemplateToken(action, 'titleTemplate', token.value)"
                >
                  {{ dingTalkTemplateTokenLabel(token, isZh) }}
                </button>
              </div>
              <label class="meta-rule-editor__label">{{ automationLabel('dingtalk.bodyTemplate', isZh) }}</label>
              <textarea
                v-model="action.config.bodyTemplate"
                class="meta-rule-editor__textarea"
                rows="4"
                :placeholder="automationLabel('dingtalk.bodyTemplatePlaceholder', isZh)"
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
                <span class="meta-rule-editor__preset-label">{{ automationLabel('dingtalk.templateTokens', isZh) }}</span>
                <button
                  v-for="token in DINGTALK_BODY_TEMPLATE_TOKENS"
                  :key="token.key"
                  class="meta-rule-editor__btn"
                  type="button"
                  :data-field="`groupBodyToken-${token.key}`"
                  @click="appendGroupTemplateToken(action, 'bodyTemplate', token.value, true)"
                >
                  {{ dingTalkTemplateTokenLabel(token, isZh) }}
                </button>
              </div>
              <label class="meta-rule-editor__label">{{ automationLabel('dingtalk.publicFormView', isZh) }}</label>
              <select
                v-model="action.config.publicFormViewId"
                class="meta-rule-editor__select"
                data-field="publicFormViewId"
              >
                  <option value="">{{ automationLabel('dingtalk.noPublicFormLinkOption', isZh) }}</option>
                <option v-for="view in formViews" :key="view.id" :value="view.id">{{ view.name }}</option>
              </select>
              <div
                v-for="warning in publicFormLinkWarnings(action.config.publicFormViewId, true)"
                :key="`group-public-form-${warning}`"
                class="meta-rule-editor__hint meta-rule-editor__hint--warning"
              >
                {{ warning }}
              </div>
              <template
                v-for="accessState in [publicFormAccessState(action.config.publicFormViewId)]"
                :key="`group-public-form-access-${idx}-${accessState.level}`"
              >
                <div
                  v-if="accessState.hasSelection"
                  class="meta-rule-editor__hint meta-rule-editor__access-summary"
                  :class="`meta-rule-editor__access-summary--${accessState.level}`"
                  :data-field="`groupPublicFormAccessSummary-${idx}`"
                  :data-access-level="accessState.level"
                >
                  <strong>{{ automationLabel('dingtalk.publicFormAccess', isZh) }}:</strong> {{ accessState.summary }}
                </div>
                <div
                  v-if="accessState.hasSelection"
                  class="meta-rule-editor__hint meta-rule-editor__access-audience"
                  :data-field="`groupPublicFormAudienceSummary-${idx}`"
                >
                  <strong>{{ automationLabel('dingtalk.allowedAudience', isZh) }}:</strong> {{ accessState.audienceSummary }}
                </div>
              </template>
              <label class="meta-rule-editor__label">{{ automationLabel('dingtalk.internalProcessingView', isZh) }}</label>
              <select
                v-model="action.config.internalViewId"
                class="meta-rule-editor__select"
                data-field="internalViewId"
              >
                <option value="">{{ automationLabel('dingtalk.noInternalLinkOption', isZh) }}</option>
                <option v-for="view in internalViews" :key="view.id" :value="view.id">{{ view.name }}</option>
              </select>
              <div
                v-for="warning in internalViewLinkWarnings(action.config.internalViewId)"
                :key="`group-internal-view-${warning}`"
                class="meta-rule-editor__hint meta-rule-editor__hint--warning"
              >
                {{ warning }}
              </div>
              <div class="meta-rule-editor__preview" data-field="groupMessageSummary">
                <div class="meta-rule-editor__preview-title">{{ automationLabel('dingtalk.messageSummary', isZh) }}</div>
                <div><strong>{{ automationLabel('dingtalk.groups', isZh) }}:</strong> {{ dingTalkGroupSummary(action) }}</div>
                <div><strong>{{ automationLabel('dingtalk.recordGroups', isZh) }}:</strong> {{ groupDestinationFieldPathSummary(action.config.destinationFieldPath) }}</div>
                <div><strong>{{ automationLabel('dingtalk.titleTemplate', isZh) }}:</strong> {{ templatePreviewText(action.config.titleTemplate, automationLabel('dingtalk.noTitleTemplate', isZh)) }}</div>
                <div class="meta-rule-editor__preview-body"><strong>{{ automationLabel('dingtalk.bodyTemplate', isZh) }}:</strong> {{ templatePreviewText(action.config.bodyTemplate, automationLabel('dingtalk.noBodyTemplate', isZh)) }}</div>
                <div class="meta-rule-editor__preview-line">
                  <span><strong>{{ automationLabel('dingtalk.renderedTitle', isZh) }}:</strong> {{ renderedTemplateExample(action.config.titleTemplate, automationLabel('dingtalk.noRenderedTitle', isZh)) }}</span>
                  <button
                    class="meta-rule-editor__copy-btn"
                    type="button"
                    :data-field="`groupRenderedTitleCopy-${idx}`"
                    @click="copyPreviewText(`group-title-${idx}`, renderedTemplateExample(action.config.titleTemplate, ''))"
                  >
                    {{ copiedPreviewKey === `group-title-${idx}` ? automationLabel('dingtalk.copied', isZh) : automationLabel('dingtalk.copy', isZh) }}
                  </button>
                </div>
                <div class="meta-rule-editor__preview-line meta-rule-editor__preview-body">
                  <span><strong>{{ automationLabel('dingtalk.renderedBody', isZh) }}:</strong> {{ renderedTemplateExample(action.config.bodyTemplate, automationLabel('dingtalk.noRenderedBody', isZh)) }}</span>
                  <button
                    class="meta-rule-editor__copy-btn"
                    type="button"
                    :data-field="`groupRenderedBodyCopy-${idx}`"
                    @click="copyPreviewText(`group-body-${idx}`, renderedTemplateExample(action.config.bodyTemplate, ''))"
                  >
                    {{ copiedPreviewKey === `group-body-${idx}` ? automationLabel('dingtalk.copied', isZh) : automationLabel('dingtalk.copy', isZh) }}
                  </button>
                </div>
                <div><strong>{{ automationLabel('dingtalk.publicForm', isZh) }}:</strong> {{ viewSummaryName(action.config.publicFormViewId, automationLabel('dingtalk.noPublicFormLink', isZh)) }}</div>
                <div><strong>{{ automationLabel('dingtalk.publicFormAccess', isZh) }}:</strong> {{ publicFormAccessState(action.config.publicFormViewId).summary }}</div>
                <div><strong>{{ automationLabel('dingtalk.allowedAudience', isZh) }}:</strong> {{ publicFormAccessState(action.config.publicFormViewId).audienceSummary }}</div>
                <div><strong>{{ automationLabel('dingtalk.internalProcessing', isZh) }}:</strong> {{ viewSummaryName(action.config.internalViewId, automationLabel('dingtalk.noInternalLink', isZh)) }}</div>
              </div>
            </div>

            <!-- send_dingtalk_person_message config -->
            <div v-if="action.type === 'send_dingtalk_person_message'" class="meta-rule-editor__action-config">
              <div class="meta-rule-editor__preset-row">
                <span class="meta-rule-editor__preset-label">{{ automationLabel('dingtalk.preset', isZh) }}</span>
                <button class="meta-rule-editor__btn" type="button" data-field="personPresetForm" @click="applyPersonPreset(action, 'form_request')">{{ automationDingTalkPresetLabel('form_request', isZh) }}</button>
                <button class="meta-rule-editor__btn" type="button" data-field="personPresetInternal" @click="applyPersonPreset(action, 'internal_process')">{{ automationDingTalkPresetLabel('internal_process', isZh) }}</button>
                <button class="meta-rule-editor__btn" type="button" data-field="personPresetBoth" @click="applyPersonPreset(action, 'form_and_process')">{{ automationDingTalkPresetLabel('form_and_process', isZh) }}</button>
              </div>
              <label class="meta-rule-editor__label">{{ automationLabel('dingtalk.searchUsersOrGroups', isZh) }}</label>
              <input
                v-model="action.config.userIdsSearch"
                class="meta-rule-editor__input"
                type="text"
                :placeholder="automationLabel('dingtalk.searchUsersOrGroupsPlaceholder', isZh)"
                data-field="dingtalkPersonUserSearch"
                @input="void loadPersonRecipientSuggestions(idx, action)"
              />
              <div v-if="personRecipientLoading[idx]" class="meta-rule-editor__hint">{{ automationLabel('dingtalk.searchingUsersOrGroups', isZh) }}</div>
              <div v-else-if="personRecipientErrors[idx]" class="meta-rule-editor__hint meta-rule-editor__hint--error">{{ personRecipientErrors[idx] }}</div>
              <div v-else-if="availablePersonRecipientSuggestions(idx, action).length" class="meta-rule-editor__recipient-list">
                <button
                  v-for="candidate in availablePersonRecipientSuggestions(idx, action)"
                  :key="personRecipientCandidateKey(candidate)"
                  class="meta-rule-editor__recipient-option"
                  type="button"
                  :disabled="isInactivePersonRecipientCandidate(candidate)"
                  :data-person-recipient-suggestion="personRecipientCandidateKey(candidate)"
                  @click="addPersonRecipient(action, candidate, idx)"
                >
                  <strong>{{ candidate.label }}</strong>
                  <span>{{ candidate.subtitle || candidate.subjectId }}</span>
                  <span>{{ personRecipientSubjectLabel(candidate) }}</span>
                  <span v-if="candidate.accessLevel">{{ personRecipientAccessLabel(candidate.accessLevel) }}</span>
                  <span v-if="personRecipientDingTalkStatusLabel(candidate.subjectType, candidate)">{{ personRecipientDingTalkStatusLabel(candidate.subjectType, candidate) }}</span>
                  <span v-if="isInactivePersonRecipientCandidate(candidate)">{{ automationLabel('dingtalk.inactiveUsersCannotBeAdded', isZh) }}</span>
                </button>
              </div>
              <div v-else-if="typeof action.config.userIdsSearch === 'string' && action.config.userIdsSearch.trim()" class="meta-rule-editor__hint">{{ automationLabel('dingtalk.noMatchingUsersOrGroups', isZh) }}</div>
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
                  <span v-if="personRecipientDingTalkStatusLabel('user', recipient)">{{ personRecipientDingTalkStatusLabel('user', recipient) }}</span>
                  <em>{{ automationLabel('dingtalk.remove', isZh) }}</em>
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
                  <span v-if="personRecipientDingTalkStatusLabel('member-group', group)">{{ personRecipientDingTalkStatusLabel('member-group', group) }}</span>
                  <em>{{ automationLabel('dingtalk.remove', isZh) }}</em>
                </button>
              </div>
              <label class="meta-rule-editor__label">{{ automationLabel('dingtalk.localUserIds', isZh) }}</label>
              <textarea
                v-model="action.config.userIdsText"
                class="meta-rule-editor__textarea"
                rows="3"
                :placeholder="automationLabel('dingtalk.localUserIdsPlaceholder', isZh)"
                data-field="dingtalkPersonUserIds"
              ></textarea>
              <label class="meta-rule-editor__label">{{ automationLabel('dingtalk.memberGroupIds', isZh) }}</label>
              <textarea
                v-model="action.config.memberGroupIdsText"
                class="meta-rule-editor__textarea"
                rows="2"
                :placeholder="automationLabel('dingtalk.memberGroupIdsPlaceholder', isZh)"
                data-field="dingtalkPersonMemberGroupIds"
              ></textarea>
              <label class="meta-rule-editor__label">{{ automationLabel('dingtalk.recordRecipientFieldPaths', isZh) }}</label>
              <input
                v-model="action.config.recipientFieldPath"
                class="meta-rule-editor__input"
                type="text"
                :placeholder="automationLabel('dingtalk.recordRecipientFieldPathPlaceholder', isZh)"
                data-field="dingtalkPersonRecipientFieldPath"
              />
              <label class="meta-rule-editor__label">{{ automationLabel('dingtalk.pickRecipientField', isZh) }}</label>
              <select
                class="meta-rule-editor__select"
                data-field="dingtalkPersonRecipientFieldSelect"
                @change="appendRecipientFieldPath(action, ($event.target as HTMLSelectElement))"
              >
                <option value="">{{ automationLabel('dingtalk.chooseUserFieldOption', isZh) }}</option>
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
                  <em>{{ automationLabel('dingtalk.remove', isZh) }}</em>
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
                {{ automationLabel('dingtalk.recordRecipientFieldPathHint', isZh) }}
              </div>
              <label class="meta-rule-editor__label">{{ automationLabel('dingtalk.recordMemberGroupFieldPaths', isZh) }}</label>
              <input
                v-model="action.config.memberGroupRecipientFieldPath"
                class="meta-rule-editor__input"
                type="text"
                :placeholder="automationLabel('dingtalk.recordMemberGroupFieldPathPlaceholder', isZh)"
                data-field="dingtalkPersonMemberGroupRecipientFieldPath"
              />
              <label class="meta-rule-editor__label">{{ automationLabel('dingtalk.pickMemberGroupField', isZh) }}</label>
              <select
                class="meta-rule-editor__select"
                data-field="dingtalkPersonMemberGroupRecipientFieldSelect"
                @change="appendMemberGroupRecipientFieldPath(action, $event.target as HTMLSelectElement)"
              >
                <option value="">{{ automationLabel('dingtalk.chooseMemberGroupFieldOption', isZh) }}</option>
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
                  <em>{{ automationLabel('dingtalk.remove', isZh) }}</em>
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
                {{ automationLabel('dingtalk.recordMemberGroupFieldPathHint', isZh) }}
              </div>
              <label class="meta-rule-editor__label">{{ automationLabel('dingtalk.titleTemplate', isZh) }}</label>
              <input
                v-model="action.config.titleTemplate"
                class="meta-rule-editor__input"
                type="text"
                :placeholder="automationLabel('dingtalk.titleTemplatePlaceholder', isZh)"
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
                <span class="meta-rule-editor__preset-label">{{ automationLabel('dingtalk.templateTokens', isZh) }}</span>
                <button
                  v-for="token in DINGTALK_TITLE_TEMPLATE_TOKENS"
                  :key="token.key"
                  class="meta-rule-editor__btn"
                  type="button"
                  :data-field="`personTitleToken-${token.key}`"
                  @click="appendPersonTemplateToken(action, 'titleTemplate', token.value)"
                >
                  {{ dingTalkTemplateTokenLabel(token, isZh) }}
                </button>
              </div>
              <label class="meta-rule-editor__label">{{ automationLabel('dingtalk.bodyTemplate', isZh) }}</label>
              <textarea
                v-model="action.config.bodyTemplate"
                class="meta-rule-editor__textarea"
                rows="4"
                :placeholder="automationLabel('dingtalk.bodyTemplatePlaceholder', isZh)"
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
                <span class="meta-rule-editor__preset-label">{{ automationLabel('dingtalk.templateTokens', isZh) }}</span>
                <button
                  v-for="token in DINGTALK_BODY_TEMPLATE_TOKENS"
                  :key="token.key"
                  class="meta-rule-editor__btn"
                  type="button"
                  :data-field="`personBodyToken-${token.key}`"
                  @click="appendPersonTemplateToken(action, 'bodyTemplate', token.value, true)"
                >
                  {{ dingTalkTemplateTokenLabel(token, isZh) }}
                </button>
              </div>
              <label class="meta-rule-editor__label">{{ automationLabel('dingtalk.publicFormView', isZh) }}</label>
              <select
                v-model="action.config.publicFormViewId"
                class="meta-rule-editor__select"
                data-field="dingtalkPersonPublicFormViewId"
              >
                <option value="">{{ automationLabel('dingtalk.noPublicFormLinkOption', isZh) }}</option>
                <option v-for="view in formViews" :key="view.id" :value="view.id">{{ view.name }}</option>
              </select>
              <div
                v-for="warning in publicFormLinkWarnings(action.config.publicFormViewId, true)"
                :key="`person-public-form-${warning}`"
                class="meta-rule-editor__hint meta-rule-editor__hint--warning"
              >
                {{ warning }}
              </div>
              <template
                v-for="accessState in [publicFormAccessState(action.config.publicFormViewId)]"
                :key="`person-public-form-access-${idx}-${accessState.level}`"
              >
                <div
                  v-if="accessState.hasSelection"
                  class="meta-rule-editor__hint meta-rule-editor__access-summary"
                  :class="`meta-rule-editor__access-summary--${accessState.level}`"
                  :data-field="`personPublicFormAccessSummary-${idx}`"
                  :data-access-level="accessState.level"
                >
                  <strong>{{ automationLabel('dingtalk.publicFormAccess', isZh) }}:</strong> {{ accessState.summary }}
                </div>
                <div
                  v-if="accessState.hasSelection"
                  class="meta-rule-editor__hint meta-rule-editor__access-audience"
                  :data-field="`personPublicFormAudienceSummary-${idx}`"
                >
                  <strong>{{ automationLabel('dingtalk.allowedAudience', isZh) }}:</strong> {{ accessState.audienceSummary }}
                </div>
              </template>
              <label class="meta-rule-editor__label">{{ automationLabel('dingtalk.internalProcessingView', isZh) }}</label>
              <select
                v-model="action.config.internalViewId"
                class="meta-rule-editor__select"
                data-field="dingtalkPersonInternalViewId"
              >
                <option value="">{{ automationLabel('dingtalk.noInternalLinkOption', isZh) }}</option>
                <option v-for="view in internalViews" :key="view.id" :value="view.id">{{ view.name }}</option>
              </select>
              <div
                v-for="warning in internalViewLinkWarnings(action.config.internalViewId)"
                :key="`person-internal-view-${warning}`"
                class="meta-rule-editor__hint meta-rule-editor__hint--warning"
              >
                {{ warning }}
              </div>
              <div class="meta-rule-editor__preview" data-field="personMessageSummary">
                <div class="meta-rule-editor__preview-title">{{ automationLabel('dingtalk.messageSummary', isZh) }}</div>
                <div><strong>{{ automationLabel('dingtalk.recipients', isZh) }}:</strong> {{ personRecipientSummary(action) }}</div>
                <div><strong>{{ automationLabel('dingtalk.recordRecipients', isZh) }}:</strong> {{ recipientFieldPathSummary(action.config.recipientFieldPath) }}</div>
                <div><strong>{{ automationLabel('dingtalk.recordMemberGroups', isZh) }}:</strong> {{ memberGroupRecipientFieldPathSummary(action.config.memberGroupRecipientFieldPath) }}</div>
                <div><strong>{{ automationLabel('dingtalk.titleTemplate', isZh) }}:</strong> {{ templatePreviewText(action.config.titleTemplate, automationLabel('dingtalk.noTitleTemplate', isZh)) }}</div>
                <div class="meta-rule-editor__preview-body"><strong>{{ automationLabel('dingtalk.bodyTemplate', isZh) }}:</strong> {{ templatePreviewText(action.config.bodyTemplate, automationLabel('dingtalk.noBodyTemplate', isZh)) }}</div>
                <div class="meta-rule-editor__preview-line">
                  <span><strong>{{ automationLabel('dingtalk.renderedTitle', isZh) }}:</strong> {{ renderedTemplateExample(action.config.titleTemplate, automationLabel('dingtalk.noRenderedTitle', isZh)) }}</span>
                  <button
                    class="meta-rule-editor__copy-btn"
                    type="button"
                    :data-field="`personRenderedTitleCopy-${idx}`"
                    @click="copyPreviewText(`person-title-${idx}`, renderedTemplateExample(action.config.titleTemplate, ''))"
                  >
                    {{ copiedPreviewKey === `person-title-${idx}` ? automationLabel('dingtalk.copied', isZh) : automationLabel('dingtalk.copy', isZh) }}
                  </button>
                </div>
                <div class="meta-rule-editor__preview-line meta-rule-editor__preview-body">
                  <span><strong>{{ automationLabel('dingtalk.renderedBody', isZh) }}:</strong> {{ renderedTemplateExample(action.config.bodyTemplate, automationLabel('dingtalk.noRenderedBody', isZh)) }}</span>
                  <button
                    class="meta-rule-editor__copy-btn"
                    type="button"
                    :data-field="`personRenderedBodyCopy-${idx}`"
                    @click="copyPreviewText(`person-body-${idx}`, renderedTemplateExample(action.config.bodyTemplate, ''))"
                  >
                    {{ copiedPreviewKey === `person-body-${idx}` ? automationLabel('dingtalk.copied', isZh) : automationLabel('dingtalk.copy', isZh) }}
                  </button>
                </div>
                <div><strong>{{ automationLabel('dingtalk.publicForm', isZh) }}:</strong> {{ viewSummaryName(action.config.publicFormViewId, automationLabel('dingtalk.noPublicFormLink', isZh)) }}</div>
                <div><strong>{{ automationLabel('dingtalk.publicFormAccess', isZh) }}:</strong> {{ publicFormAccessState(action.config.publicFormViewId).summary }}</div>
                <div><strong>{{ automationLabel('dingtalk.allowedAudience', isZh) }}:</strong> {{ publicFormAccessState(action.config.publicFormViewId).audienceSummary }}</div>
                <div><strong>{{ automationLabel('dingtalk.internalProcessing', isZh) }}:</strong> {{ viewSummaryName(action.config.internalViewId, automationLabel('dingtalk.noInternalLink', isZh)) }}</div>
              </div>
            </div>

            <!-- lock_record config -->
            <div v-if="action.type === 'lock_record'" class="meta-rule-editor__action-config">
              <label class="meta-rule-editor__toggle-label">
                <input type="checkbox" v-model="action.config.locked" />
                {{ automationLabel('actionConfig.lockRecord', isZh) }}
              </label>
            </div>

            <!-- wait_for_callback config (A6-2: info-only, ZERO params — the suspend point; no
                 webhook-URL / timer / manual-task fields. An admin resumes from the runs detail.) -->
            <div v-if="action.type === 'wait_for_callback'" class="meta-rule-editor__action-config" data-action-config="wait_for_callback">
              <div class="meta-rule-editor__hint" data-field="wait-for-callback-hint">{{ automationLabel('actionConfig.waitForCallbackHint', isZh) }}</div>
            </div>

            <!-- A6-3-2a condition_branch builder (form-based; no canvas / BPMN vocab per design-lock §10) -->
            <div v-if="action.type === 'condition_branch'" class="meta-rule-editor__action-config" data-action-config="condition_branch">
              <div v-if="action.config.branchUnsupportedReason" class="meta-rule-editor__alert" data-field="condition-branch-readonly">
                {{ automationLabel('conditionBranch.readOnly', isZh) }}
              </div>
              <template v-else>
                <div class="meta-rule-editor__hint">{{ automationLabel('conditionBranch.hint', isZh) }}</div>
                <div v-for="(branch, bIdx) in action.config.branches" :key="bIdx" class="meta-rule-editor__branch" :data-branch-index="bIdx">
                  <div class="meta-rule-editor__branch-header">
                    <input v-model="branch.key" class="meta-rule-editor__input meta-rule-editor__input--sm" :placeholder="automationLabel('conditionBranch.key', isZh)" data-field="branch-key" />
                    <input v-model="branch.label" class="meta-rule-editor__input meta-rule-editor__input--sm" :placeholder="automationLabel('conditionBranch.label', isZh)" data-field="branch-label" />
                    <button class="meta-rule-editor__btn meta-rule-editor__btn--icon" type="button" data-action="remove-branch" @click="removeBranch(action, bIdx)">&times;</button>
                  </div>
                  <div v-if="branch.conditions.length > 1" class="meta-rule-editor__conjunction">
                    <button type="button" class="meta-rule-editor__toggle-btn" :class="{ 'meta-rule-editor__toggle-btn--active': branch.conjunction === 'AND' }" @click="branch.conjunction = 'AND'">{{ automationLabel('condition.and', isZh) }}</button>
                    <button type="button" class="meta-rule-editor__toggle-btn" :class="{ 'meta-rule-editor__toggle-btn--active': branch.conjunction === 'OR' }" @click="branch.conjunction = 'OR'">{{ automationLabel('condition.or', isZh) }}</button>
                  </div>
                  <div v-for="(cond, cIdx) in branch.conditions" :key="cIdx" class="meta-rule-editor__condition-row" :data-branch-condition-index="cIdx">
                    <select :value="cond.fieldId" class="meta-rule-editor__select meta-rule-editor__select--sm" @change="onConditionFieldChange(cond, ($event.target as HTMLSelectElement).value)">
                      <option value="">{{ automationLabel('condition.selectField', isZh) }}</option>
                      <option v-for="f in fields" :key="f.id" :value="f.id">{{ f.name }}</option>
                    </select>
                    <select :value="cond.operator" class="meta-rule-editor__select meta-rule-editor__select--sm" @change="onConditionOperatorChange(cond, ($event.target as HTMLSelectElement).value as ConditionOperator)">
                      <option v-for="op in conditionOperatorsForField(cond.fieldId)" :key="op.value" :value="op.value">{{ automationConditionOperatorLabel(op.value, isZh) }}</option>
                    </select>
                    <input v-if="!isUnaryOperator(cond.operator)" v-model="cond.value" class="meta-rule-editor__input meta-rule-editor__input--sm" :placeholder="automationLabel('condition.selectValue', isZh)" />
                    <button class="meta-rule-editor__btn meta-rule-editor__btn--icon" type="button" @click="removeBranchCondition(branch, cIdx)">&times;</button>
                  </div>
                  <button class="meta-rule-editor__btn" type="button" data-action="add-branch-condition" @click="addBranchCondition(branch)">{{ automationLabel('condition.addCondition', isZh) }}</button>
                  <div v-for="(bAct, aIdx) in branch.actions" :key="aIdx" class="meta-rule-editor__branch-action" :data-branch-action-index="aIdx">
                    <select v-model="bAct.type" class="meta-rule-editor__select meta-rule-editor__select--sm" @change="onBranchActionTypeChange(bAct)">
                      <option v-for="t in CONDITION_BRANCH_AUTHORABLE_ACTION_TYPES" :key="t" :value="t">{{ automationActionTypeLabel(t, isZh) }}</option>
                    </select>
                    <template v-if="bAct.type === 'update_record'">
                      <div v-for="(pair, pIdx) in bAct.fieldUpdates" :key="pIdx" class="meta-rule-editor__field-pair">
                        <select v-model="pair.fieldId" class="meta-rule-editor__select meta-rule-editor__select--sm">
                          <option value="">{{ automationLabel('condition.selectField', isZh) }}</option>
                          <option v-for="f in fields" :key="f.id" :value="f.id">{{ f.name }}</option>
                        </select>
                        <input v-model="pair.value" class="meta-rule-editor__input meta-rule-editor__input--sm" :placeholder="automationLabel('conditionBranch.value', isZh)" />
                        <button class="meta-rule-editor__btn meta-rule-editor__btn--icon" type="button" @click="removeBranchFieldPair(bAct, pIdx)">&times;</button>
                      </div>
                      <button class="meta-rule-editor__btn" type="button" data-action="add-branch-field" @click="addBranchFieldPair(bAct)">{{ automationLabel('conditionBranch.addField', isZh) }}</button>
                    </template>
                    <template v-else-if="bAct.type === 'send_notification'">
                      <input v-model="bAct.userId" class="meta-rule-editor__input meta-rule-editor__input--sm" :placeholder="automationLabel('conditionBranch.userIds', isZh)" />
                      <input v-model="bAct.message" class="meta-rule-editor__input meta-rule-editor__input--sm" :placeholder="automationLabel('conditionBranch.message', isZh)" />
                    </template>
                    <!-- A6-3-3b branch-local wait_for_callback: zero-param suspend point (no fields to author) -->
                    <template v-else-if="bAct.type === 'wait_for_callback'">
                      <span class="meta-rule-editor__hint" data-field="branch-wait-for-callback-hint">{{ automationLabel('actionConfig.waitForCallbackHint', isZh) }}</span>
                    </template>
                    <button class="meta-rule-editor__btn meta-rule-editor__btn--icon" type="button" @click="removeBranchAction(branch, aIdx)">&times;</button>
                  </div>
                  <button class="meta-rule-editor__btn" type="button" data-action="add-branch-action" @click="addBranchAction(branch)">{{ automationLabel('conditionBranch.addAction', isZh) }}</button>
                </div>
                <button class="meta-rule-editor__btn" type="button" data-action="add-branch" @click="addBranch(action)">{{ automationLabel('conditionBranch.addBranch', isZh) }}</button>
                <div v-if="action.config.defaultBranch" class="meta-rule-editor__branch" data-field="default-branch">
                  <div class="meta-rule-editor__branch-header">
                    <span class="meta-rule-editor__group-label">{{ automationLabel('conditionBranch.default', isZh) }}</span>
                    <input v-model="action.config.defaultBranch.key" class="meta-rule-editor__input meta-rule-editor__input--sm" :placeholder="automationLabel('conditionBranch.key', isZh)" data-field="default-branch-key" />
                    <button class="meta-rule-editor__btn meta-rule-editor__btn--icon" type="button" data-action="remove-default-branch" @click="removeDefaultBranch(action)">&times;</button>
                  </div>
                  <div v-for="(bAct, aIdx) in action.config.defaultBranch.actions" :key="aIdx" class="meta-rule-editor__branch-action" :data-default-branch-action-index="aIdx">
                    <select v-model="bAct.type" class="meta-rule-editor__select meta-rule-editor__select--sm" @change="onBranchActionTypeChange(bAct)">
                      <option v-for="t in CONDITION_BRANCH_AUTHORABLE_ACTION_TYPES" :key="t" :value="t">{{ automationActionTypeLabel(t, isZh) }}</option>
                    </select>
                    <template v-if="bAct.type === 'update_record'">
                      <div v-for="(pair, pIdx) in bAct.fieldUpdates" :key="pIdx" class="meta-rule-editor__field-pair">
                        <select v-model="pair.fieldId" class="meta-rule-editor__select meta-rule-editor__select--sm">
                          <option value="">{{ automationLabel('condition.selectField', isZh) }}</option>
                          <option v-for="f in fields" :key="f.id" :value="f.id">{{ f.name }}</option>
                        </select>
                        <input v-model="pair.value" class="meta-rule-editor__input meta-rule-editor__input--sm" :placeholder="automationLabel('conditionBranch.value', isZh)" />
                        <button class="meta-rule-editor__btn meta-rule-editor__btn--icon" type="button" @click="removeBranchFieldPair(bAct, pIdx)">&times;</button>
                      </div>
                      <button class="meta-rule-editor__btn" type="button" @click="addBranchFieldPair(bAct)">{{ automationLabel('conditionBranch.addField', isZh) }}</button>
                    </template>
                    <template v-else-if="bAct.type === 'send_notification'">
                      <input v-model="bAct.userId" class="meta-rule-editor__input meta-rule-editor__input--sm" :placeholder="automationLabel('conditionBranch.userIds', isZh)" />
                      <input v-model="bAct.message" class="meta-rule-editor__input meta-rule-editor__input--sm" :placeholder="automationLabel('conditionBranch.message', isZh)" />
                    </template>
                    <!-- A6-3-3b branch-local wait_for_callback (default branch): zero-param suspend point -->
                    <template v-else-if="bAct.type === 'wait_for_callback'">
                      <span class="meta-rule-editor__hint" data-field="branch-wait-for-callback-hint">{{ automationLabel('actionConfig.waitForCallbackHint', isZh) }}</span>
                    </template>
                    <button class="meta-rule-editor__btn meta-rule-editor__btn--icon" type="button" @click="removeBranchAction(action.config.defaultBranch, aIdx)">&times;</button>
                  </div>
                  <button class="meta-rule-editor__btn" type="button" @click="addBranchAction(action.config.defaultBranch)">{{ automationLabel('conditionBranch.addAction', isZh) }}</button>
                </div>
                <button v-else class="meta-rule-editor__btn" type="button" data-action="add-default-branch" @click="addDefaultBranch(action)">{{ automationLabel('conditionBranch.addDefault', isZh) }}</button>
                <div v-if="conditionBranchKeyError" class="meta-rule-editor__error" data-field="branch-key-error">{{ conditionBranchKeyError }}</div>
              </template>
            </div>

            <!-- A6-3-4/W3-2a parallel_branch builder (join-all only; no canvas / worker-parallel controls) -->
            <div v-if="action.type === 'parallel_branch'" class="meta-rule-editor__action-config" data-action-config="parallel_branch">
              <div v-if="action.config.parallelBranchUnsupportedReason" class="meta-rule-editor__alert" data-field="parallel-branch-readonly">
                {{ automationLabel('parallelBranch.readOnly', isZh) }}
              </div>
              <template v-else>
                <div class="meta-rule-editor__hint">{{ automationLabel('parallelBranch.hint', isZh) }}</div>
                <div v-for="(branch, bIdx) in action.config.parallelBranches" :key="bIdx" class="meta-rule-editor__branch" :data-parallel-branch-index="bIdx">
                  <div class="meta-rule-editor__branch-header">
                    <input v-model="branch.key" class="meta-rule-editor__input meta-rule-editor__input--sm" :placeholder="automationLabel('parallelBranch.key', isZh)" data-field="parallel-branch-key" />
                    <input v-model="branch.label" class="meta-rule-editor__input meta-rule-editor__input--sm" :placeholder="automationLabel('parallelBranch.label', isZh)" data-field="parallel-branch-label" />
                    <button class="meta-rule-editor__btn meta-rule-editor__btn--icon" type="button" data-action="remove-parallel-branch" @click="removeParallelBranch(action, bIdx)">&times;</button>
                  </div>
                  <div v-for="(bAct, aIdx) in branch.actions" :key="aIdx" class="meta-rule-editor__branch-action" :data-parallel-branch-action-index="aIdx">
                    <select v-model="bAct.type" class="meta-rule-editor__select meta-rule-editor__select--sm" @change="onBranchActionTypeChange(bAct)">
                      <option v-for="t in BRANCH_AUTHORABLE_ACTION_TYPES" :key="t" :value="t">{{ automationActionTypeLabel(t, isZh) }}</option>
                    </select>
                    <template v-if="bAct.type === 'update_record'">
                      <div v-for="(pair, pIdx) in bAct.fieldUpdates" :key="pIdx" class="meta-rule-editor__field-pair">
                        <select v-model="pair.fieldId" class="meta-rule-editor__select meta-rule-editor__select--sm">
                          <option value="">{{ automationLabel('condition.selectField', isZh) }}</option>
                          <option v-for="f in fields" :key="f.id" :value="f.id">{{ f.name }}</option>
                        </select>
                        <input v-model="pair.value" class="meta-rule-editor__input meta-rule-editor__input--sm" :placeholder="automationLabel('parallelBranch.value', isZh)" />
                        <button class="meta-rule-editor__btn meta-rule-editor__btn--icon" type="button" @click="removeBranchFieldPair(bAct, pIdx)">&times;</button>
                      </div>
                      <button class="meta-rule-editor__btn" type="button" data-action="add-parallel-branch-field" @click="addBranchFieldPair(bAct)">{{ automationLabel('parallelBranch.addField', isZh) }}</button>
                    </template>
                    <template v-else-if="bAct.type === 'send_notification'">
                      <input v-model="bAct.userId" class="meta-rule-editor__input meta-rule-editor__input--sm" :placeholder="automationLabel('parallelBranch.userIds', isZh)" />
                      <input v-model="bAct.message" class="meta-rule-editor__input meta-rule-editor__input--sm" :placeholder="automationLabel('parallelBranch.message', isZh)" />
                    </template>
                    <button class="meta-rule-editor__btn meta-rule-editor__btn--icon" type="button" @click="removeBranchAction(branch, aIdx)">&times;</button>
                  </div>
                  <button class="meta-rule-editor__btn" type="button" data-action="add-parallel-branch-action" @click="addBranchAction(branch)">{{ automationLabel('parallelBranch.addAction', isZh) }}</button>
                </div>
                <button class="meta-rule-editor__btn" type="button" data-action="add-parallel-branch" @click="addParallelBranch(action)">{{ automationLabel('parallelBranch.addBranch', isZh) }}</button>
                <div v-if="parallelBranchKeyError" class="meta-rule-editor__error" data-field="parallel-branch-key-error">{{ parallelBranchKeyError }}</div>
                <div v-if="parallelBranchActionError" class="meta-rule-editor__error" data-field="parallel-branch-action-error">{{ parallelBranchActionError }}</div>
              </template>
            </div>
          </div>
          <button
            v-if="draft.actions.length < 3"
            class="meta-rule-editor__btn"
            type="button"
            data-action="add-action"
            @click="addAction"
          >{{ automationLabel('editor.addAction', isZh) }}</button>
        </section>
      </div>

      <!-- Footer -->
      <div class="meta-rule-editor__footer">
        <div class="meta-rule-editor__test-run-feedback">
          <div v-if="savedRuleHasDingTalkActions" class="meta-rule-editor__hint meta-rule-editor__hint--warning" data-field="dingtalkTestRunWarning">
            {{ automationLabel('testRun.warning', isZh) }}
          </div>
          <div v-if="!props.rule?.id" class="meta-rule-editor__hint" data-field="testRunUnsavedHint">
            {{ automationLabel('testRun.unsavedHint', isZh) }}
          </div>
          <div
            v-if="props.testRunState"
            class="meta-rule-editor__test-run-status"
            :class="`meta-rule-editor__test-run-status--${props.testRunState.status}`"
            data-field="testRunStatus"
            :data-status="props.testRunState.status"
          >
            {{ props.testRunState.message }}
          </div>
        </div>
        <button class="meta-rule-editor__btn meta-rule-editor__btn--primary" type="button" :disabled="!canSave || saving" data-action="save" @click="onSave">
          {{ saving ? automationLabel('editor.saving', isZh) : automationLabel('editor.save', isZh) }}
        </button>
        <button
          class="meta-rule-editor__btn"
          type="button"
          :disabled="saving || !props.rule?.id || props.testRunState?.status === 'running'"
          @click="onTestRun"
          data-action="test"
        >
          {{ props.testRunState?.status === 'running' ? automationLabel('testRun.running', isZh) : automationLabel('testRun.button', isZh) }}
        </button>
        <button class="meta-rule-editor__btn" type="button" @click="$emit('close')">{{ automationLabel('editor.cancel', isZh) }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { MultitableApiClient } from '../api/client'
import type {
  AutomationRule,
  AutomationTriggerType,
  AutomationActionType,
  ConditionOperator,
  AutomationCondition,
  AutomationConditionNode,
  ConditionGroup,
  DingTalkGroupDestination,
  MetaSheetPermissionCandidate,
  MetaView,
} from '../types'
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
  listDingTalkPublicFormLinkBlockingErrors,
  listDingTalkPublicFormLinkWarnings,
} from '../utils/dingtalkPublicFormLinkWarnings'
import {
  listDingTalkInternalViewLinkBlockingErrors,
  listDingTalkInternalViewLinkWarnings,
} from '../utils/dingtalkInternalViewLinkWarnings'
import {
  automationActionTypeLabel,
  automationConditionOperatorLabel,
  automationConditionValuePlaceholder,
  automationCronPresetLabel,
  automationDingTalkDestinationScopeLabel,
  automationDingTalkDestinationSubtitle,
  automationDingTalkPersonAccessLabel,
  automationDingTalkPersonStatusLabel,
  automationDingTalkPersonSubjectLabel,
  automationDingTalkPresetLabel,
  automationLabel,
  automationTriggerConditionLabel,
  automationTriggerTypeLabel,
} from '../utils/meta-automation-labels'
import {
  type BranchActionDraft,
  type BranchDraft,
  type DefaultBranchDraft,
  BRANCH_AUTHORABLE_ACTION_TYPES,
  CONDITION_BRANCH_AUTHORABLE_ACTION_TYPES,
  buildConditionBranchConfig,
  conditionBranchUnsupportedReason,
  parseConditionBranchDraft,
  validateConditionBranchKeys,
} from '../utils/conditionBranchAuthoring'
import {
  type ParallelBranchDraft,
  buildParallelBranchConfig,
  parallelBranchUnsupportedReason,
  parseParallelBranchDraft,
  validateParallelBranchActions,
  validateParallelBranchKeys,
} from '../utils/parallelBranchAuthoring'

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
  recipientsText?: string
  recipients?: string[]
  subjectTemplate?: string
  destinationId?: string
  destinationIds?: string[]
  destinationPickerId?: string
  destinationFieldPath?: string
  titleTemplate?: string
  bodyTemplate?: string
  publicFormViewId?: string
  internalViewId?: string
  locked?: boolean
  // A6-3-2a condition_branch authoring (supported → editable draft; unsupported → read-only + original preserved)
  branches?: BranchDraft[]
  defaultBranch?: DefaultBranchDraft | null
  branchUnsupportedReason?: string | null
  branchOriginal?: Record<string, unknown> | null
  // A6-3-4/W3-2a parallel_branch authoring (supported → editable draft; unsupported → read-only + original preserved)
  parallelBranches?: ParallelBranchDraft[]
  parallelBranchUnsupportedReason?: string | null
  parallelBranchOriginal?: Record<string, unknown> | null
}

interface DraftAction {
  type: AutomationActionType
  config: DraftActionConfig
}

interface Draft {
  name: string
  triggerType: AutomationTriggerType
  triggerConfig: Record<string, unknown>
  conditions: ConditionGroup & { conjunction: 'AND' | 'OR' }
  actions: DraftAction[]
  executionMode: string | null
}

type FieldOption = { value: string; label?: string; color?: string }
type AutomationRuleEditorField = {
  id: string
  name: string
  type: string
  property?: Record<string, unknown>
  options?: FieldOption[]
}

const props = defineProps<{
  sheetId: string
  rule?: AutomationRule
  testRunState?: {
    status: 'running' | 'success' | 'failed' | 'skipped'
    message: string
  }
  visible: boolean
  fields: AutomationRuleEditorField[]
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
// start_approval template picker. Empty (incl. on a 401/403 for an author lacking `approvals:read`) →
// the config block degrades to a free-text template-id input; the select is never a hard dependency.
const approvalTemplates = ref<Array<{ id: string; name?: string }>>([])
const personRecipientSuggestions = ref<Record<number, MetaSheetPermissionCandidate[]>>({})
const personRecipientLoading = ref<Record<number, boolean>>({})
const personRecipientErrors = ref<Record<number, string>>({})

type PersonRecipientDirectoryEntry = {
  label: string
  subtitle?: string
  dingtalkBound?: boolean | null
  dingtalkGrantEnabled?: boolean | null
  dingtalkPersonDeliveryAvailable?: boolean | null
}

const personRecipientDirectory = ref<Record<string, PersonRecipientDirectoryEntry>>({})
const copiedPreviewKey = ref('')
let personRecipientSuggestionLoadId = 0
let copiedPreviewResetTimer: ReturnType<typeof setTimeout> | null = null
const { isZh } = useLocale()

const SUPPORTED_SELECTABLE_ACTION_TYPES: AutomationActionType[] = [
  'update_record',
  'create_record',
  'send_webhook',
  'send_notification',
  'start_approval',
  'send_email',
  'send_dingtalk_group_message',
  'send_dingtalk_person_message',
  'wait_for_callback',
  'condition_branch',
  'parallel_branch',
  // lock_record is now a complete contract (record-locking storage + write-path enforcement, rank 8),
  // so it is a first-class selectable action — both for new rules and to keep existing lock_record rules
  // editable (it must appear in SUPPORTED so an existing rule's option isn't dropped to empty).
  'lock_record',
]

// A6-3-2a: BRANCH_AUTHORABLE_ACTION_TYPES (the v1 in-branch action subset) is imported from
// ../utils/conditionBranchAuthoring — the single source of truth shared with the seam + tests.

// lock_record is now a complete contract (record-locking storage + write-path enforcement), so it is
// re-exposed in the rule-editor dropdown (reversing the #2278 stop-gap that hid the then-broken action).
const UNSUPPORTED_SELECTABLE_ACTION_TYPES: AutomationActionType[] = []

function isUnsupportedSelectableActionType(type: AutomationActionType): boolean {
  return UNSUPPORTED_SELECTABLE_ACTION_TYPES.includes(type)
}

function selectableActionTypes(currentType: AutomationActionType): AutomationActionType[] {
  if (isUnsupportedSelectableActionType(currentType)) {
    return [...SUPPORTED_SELECTABLE_ACTION_TYPES, currentType]
  }
  return SUPPORTED_SELECTABLE_ACTION_TYPES
}

const formViews = computed(() => (props.views ?? []).filter((view) =>
  view.type === 'form' && (!view.sheetId || view.sheetId === props.sheetId),
))
const internalViews = computed(() => (props.views ?? []).filter((view) => !view.sheetId || view.sheetId === props.sheetId))
const groupDestinationCandidateFields = computed(() => props.fields)
const recipientCandidateFields = computed(() => props.fields.filter((field) => field.type === 'user'))
const memberGroupRecipientCandidateFields = computed(() => props.fields.filter(isDingTalkMemberGroupRecipientField))
const dateReminderCandidateFields = computed(() => props.fields.filter((field) => field.type === 'date' || field.type === 'dateTime'))
const savedRuleHasDingTalkActions = computed(() => ruleHasDingTalkActions(props.rule))
function dingTalkTestRunConfirmMessage(): string {
  const separator = isZh.value ? '' : ' '
  return `${automationLabel('testRun.warning', isZh.value)}${separator}${automationLabel('testRun.confirmSuffix', isZh.value)}`
}

type ConditionOperatorOption = { value: ConditionOperator; label: string }
type ConditionValueWidget = 'text' | 'number' | 'date' | 'dateTime' | 'boolean' | 'booleanMultiSelect' | 'select' | 'multiSelect'
type ConditionPath = number[]
type ConditionEditorEntry =
  | {
    kind: 'group'
    group: ConditionGroup
    path: ConditionPath
    pathKey: string
    depth: number
    canAddGroup: boolean
  }
  | {
    kind: 'condition'
    condition: AutomationCondition
    path: ConditionPath
    pathKey: string
    depth: number
  }

const conditionOperators: ConditionOperatorOption[] = [
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
  { value: 'in', label: 'In list' },
  { value: 'not_in', label: 'Not in list' },
]

const CONDITION_OPERATOR_LOOKUP = new Map(conditionOperators.map((operator) => [operator.value, operator]))
const EMPTY_VALUE_OPERATOR_OPTIONS = ['is_empty', 'is_not_empty'] as const
const EQUALITY_OPERATOR_OPTIONS = ['equals', 'not_equals', 'in', 'not_in', 'is_empty', 'is_not_empty'] as const
const TEXT_OPERATOR_OPTIONS = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'in',
  'not_in',
  'is_empty',
  'is_not_empty',
] as const
const COMPARABLE_OPERATOR_OPTIONS = [
  'equals',
  'not_equals',
  'greater_than',
  'less_than',
  'greater_or_equal',
  'less_or_equal',
  'in',
  'not_in',
  'is_empty',
  'is_not_empty',
] as const
const MULTI_VALUE_OPERATOR_OPTIONS = [
  'contains',
  'not_contains',
  'in',
  'not_in',
  'is_empty',
  'is_not_empty',
] as const
const MAX_CONDITION_GROUP_DEPTH = 5

function optionsFromOperators(operators: readonly ConditionOperator[]): ConditionOperatorOption[] {
  return operators
    .map((operator) => CONDITION_OPERATOR_LOOKUP.get(operator))
    .filter((operator): operator is ConditionOperatorOption => !!operator)
}

function conditionOperatorsForField(fieldId: string): ConditionOperatorOption[] {
  const fieldType = props.fields.find((field) => field.id === fieldId)?.type
  if (!fieldType) return optionsFromOperators(EMPTY_VALUE_OPERATOR_OPTIONS)

  switch (fieldType) {
    case 'number':
    case 'currency':
    case 'percent':
    case 'rating':
    case 'duration':
    case 'date':
    case 'dateTime':
    case 'createdTime':
    case 'modifiedTime':
    case 'autoNumber':
      return optionsFromOperators(COMPARABLE_OPERATOR_OPTIONS)
    case 'boolean':
      return optionsFromOperators(EQUALITY_OPERATOR_OPTIONS)
    case 'select':
    case 'person':
    case 'link':
    case 'lookup':
    case 'rollup':
    case 'createdBy':
    case 'modifiedBy':
      return optionsFromOperators(EQUALITY_OPERATOR_OPTIONS)
    case 'multiSelect':
      return optionsFromOperators(MULTI_VALUE_OPERATOR_OPTIONS)
    case 'attachment':
      return optionsFromOperators(EMPTY_VALUE_OPERATOR_OPTIONS)
    default:
      return optionsFromOperators(TEXT_OPERATOR_OPTIONS)
  }
}

function firstOperatorForField(fieldId: string): ConditionOperator {
  return conditionOperatorsForField(fieldId)[0]?.value ?? 'is_empty'
}

function conditionField(condition: AutomationCondition): AutomationRuleEditorField | undefined {
  return props.fields.find((field) => field.id === condition.fieldId)
}

function conditionFieldOptions(condition: AutomationCondition): FieldOption[] {
  return conditionField(condition)?.options ?? []
}

function optionLabel(option: FieldOption): string {
  return option.label ?? option.value
}

function conditionValueWidget(condition: AutomationCondition): ConditionValueWidget {
  const field = conditionField(condition)
  if (!field) return 'text'
  if (field.type === 'boolean') return isArrayOperator(condition.operator) ? 'booleanMultiSelect' : 'boolean'
  if (isNumericConditionFieldType(field.type)) return 'number'
  if (field.type === 'date') return 'date'
  if (field.type === 'dateTime' || field.type === 'createdTime' || field.type === 'modifiedTime') return 'dateTime'
  if ((field.type === 'select' || field.type === 'multiSelect') && conditionFieldOptions(condition).length > 0) {
    return isArrayOperator(condition.operator) ? 'multiSelect' : 'select'
  }
  return 'text'
}

function conditionValueInputType(condition: AutomationCondition): string {
  if (isArrayOperator(condition.operator)) return 'text'
  const widget = conditionValueWidget(condition)
  if (widget === 'number') return 'number'
  if (widget === 'date') return 'date'
  if (widget === 'dateTime') return 'datetime-local'
  return 'text'
}

function conditionValueInputMode(condition: AutomationCondition): 'decimal' | undefined {
  if (isArrayOperator(condition.operator)) return undefined
  return conditionValueWidget(condition) === 'number' ? 'decimal' : undefined
}

function booleanConditionValue(condition: AutomationCondition): string {
  if (condition.value === true) return 'true'
  if (condition.value === false) return 'false'
  if (condition.value === 'true' || condition.value === 'false') return condition.value
  return ''
}

function booleanMultiSelectConditionValues(condition: AutomationCondition): string[] {
  return (parseBooleanConditionArrayValue(condition.value) ?? [])
    .map((entry) => entry ? 'true' : 'false')
}

function singleSelectConditionValue(condition: AutomationCondition): string {
  return typeof condition.value === 'string' ? condition.value : ''
}

function multiSelectConditionValues(condition: AutomationCondition): string[] {
  return parseConditionArrayValue(condition.value).map(String)
}

function onBooleanConditionValueChange(condition: AutomationCondition, value: string) {
  if (value === 'true') {
    condition.value = true
  } else if (value === 'false') {
    condition.value = false
  } else {
    condition.value = ''
  }
}

function onBooleanMultiSelectConditionValueChange(condition: AutomationCondition, event: Event) {
  const select = event.target as HTMLSelectElement
  condition.value = Array.from(select.selectedOptions).map((option) => option.value)
}

function onMultiSelectConditionValueChange(condition: AutomationCondition, event: Event) {
  const select = event.target as HTMLSelectElement
  condition.value = Array.from(select.selectedOptions).map((option) => option.value)
}

function isNumericConditionFieldType(fieldType: string | undefined): boolean {
  return fieldType === 'number' ||
    fieldType === 'currency' ||
    fieldType === 'percent' ||
    fieldType === 'rating' ||
    fieldType === 'duration' ||
    fieldType === 'autoNumber'
}

function resetConditionValue(condition: AutomationCondition) {
  if (isUnaryOperator(condition.operator)) {
    delete condition.value
  } else if (isArrayOperator(condition.operator)) {
    condition.value = ''
  } else {
    condition.value = ''
  }
}

function onConditionFieldChange(condition: AutomationCondition, fieldId: string) {
  const previousFieldId = condition.fieldId
  condition.fieldId = fieldId
  const allowedOperators = conditionOperatorsForField(fieldId)
  if (!previousFieldId || !allowedOperators.some((operator) => operator.value === condition.operator)) {
    condition.operator = firstOperatorForField(fieldId)
  }
  if (previousFieldId !== fieldId) {
    resetConditionValue(condition)
  }
}

function onConditionOperatorChange(condition: AutomationCondition, operator: ConditionOperator) {
  condition.operator = operator
  resetConditionValue(condition)
}

function isUnaryOperator(op: ConditionOperator): boolean {
  return op === 'is_empty' || op === 'is_not_empty'
}

function isArrayOperator(op: ConditionOperator): boolean {
  return op === 'in' || op === 'not_in'
}

function conditionValuePlaceholder(condition: AutomationCondition): string {
  return automationConditionValuePlaceholder(conditionValueWidget(condition), isArrayOperator(condition.operator), isZh.value)
}

function isConditionGroupNode(node: AutomationConditionNode): node is ConditionGroup {
  return Array.isArray((node as ConditionGroup).conditions)
}

function normalizeConditionConjunction(group: ConditionGroup | undefined): 'AND' | 'OR' {
  if (group?.conjunction === 'OR') return 'OR'
  if (group?.conjunction === 'AND') return 'AND'
  return group?.logic === 'or' ? 'OR' : 'AND'
}

function cloneConditionLeaf(condition: AutomationCondition): AutomationCondition {
  const cloned: AutomationCondition = {
    fieldId: condition.fieldId,
    operator: condition.operator,
  }
  if (condition.value !== undefined) {
    cloned.value = isArrayOperator(condition.operator) && Array.isArray(condition.value)
      ? condition.value.join(', ')
      : condition.value
  }
  return cloned
}

function cloneConditionNode(node: AutomationConditionNode): AutomationConditionNode {
  if (isConditionGroupNode(node)) {
    const cloned: ConditionGroup = {
      conjunction: normalizeConditionConjunction(node),
      conditions: node.conditions.map(cloneConditionNode),
    }
    return cloned
  }
  return cloneConditionLeaf(node)
}

function conditionGroupFromRule(group: ConditionGroup | undefined): Draft['conditions'] {
  return {
    conjunction: normalizeConditionConjunction(group),
    conditions: group?.conditions.map(cloneConditionNode) ?? [],
  }
}

function parseConditionArrayValue(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => typeof entry === 'string' ? entry.trim() : entry)
      .filter((entry) => typeof entry === 'string' ? entry.length > 0 : entry !== null && entry !== undefined)
  }
  if (typeof value !== 'string') return []
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function parseNumberConditionValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

function parseNumericConditionArrayValue(value: unknown): number[] | null {
  const values = parseConditionArrayValue(value)
  if (!values.length) return null
  const numbers = values.map(parseNumberConditionValue)
  return numbers.every((entry): entry is number => entry !== null) ? numbers : null
}

function parseBooleanConditionValue(value: unknown): boolean | null {
  if (value === true || value === false) return value
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}

function parseBooleanConditionArrayValue(value: unknown): boolean[] | null {
  const values = parseConditionArrayValue(value)
  if (!values.length) return null
  const booleans = values.map(parseBooleanConditionValue)
  return booleans.every((entry): entry is boolean => entry !== null) ? booleans : null
}

function conditionFieldType(fieldId: string): string | undefined {
  return props.fields.find((field) => field.id === fieldId)?.type
}

function buildConditionValuePayload(condition: AutomationCondition): unknown {
  const fieldType = conditionFieldType(condition.fieldId)
  if (isArrayOperator(condition.operator)) {
    if (isNumericConditionFieldType(fieldType)) return parseNumericConditionArrayValue(condition.value) ?? []
    if (fieldType === 'boolean') return parseBooleanConditionArrayValue(condition.value) ?? []
    return parseConditionArrayValue(condition.value)
  }
  if (isNumericConditionFieldType(fieldType)) {
    return parseNumberConditionValue(condition.value)
  }
  if (fieldType === 'boolean') {
    return parseBooleanConditionValue(condition.value)
  }
  return typeof condition.value === 'string' ? condition.value.trim() : condition.value
}

function isConditionLeafComplete(condition: AutomationCondition): boolean {
  if (!condition.fieldId.trim()) return false
  if (isUnaryOperator(condition.operator)) return true
  const fieldType = conditionFieldType(condition.fieldId)
  if (isArrayOperator(condition.operator)) {
    if (isNumericConditionFieldType(fieldType)) return parseNumericConditionArrayValue(condition.value) !== null
    if (fieldType === 'boolean') return parseBooleanConditionArrayValue(condition.value) !== null
    return parseConditionArrayValue(condition.value).length > 0
  }
  if (isNumericConditionFieldType(fieldType)) return parseNumberConditionValue(condition.value) !== null
  if (fieldType === 'boolean') return parseBooleanConditionValue(condition.value) !== null
  return typeof condition.value === 'string'
    ? condition.value.trim().length > 0
    : condition.value !== undefined && condition.value !== null
}

function areConditionsComplete(node: AutomationConditionNode): boolean {
  if (isConditionGroupNode(node)) return node.conditions.length > 0 && node.conditions.every(areConditionsComplete)
  return isConditionLeafComplete(node)
}

function buildConditionNodePayload(node: AutomationConditionNode): AutomationConditionNode {
  if (isConditionGroupNode(node)) {
    const group: ConditionGroup = {
      conjunction: normalizeConditionConjunction(node),
      conditions: node.conditions.map(buildConditionNodePayload),
    }
    return group
  }

  const condition: AutomationCondition = {
    fieldId: node.fieldId.trim(),
    operator: node.operator,
  }
  if (!isUnaryOperator(node.operator)) {
    condition.value = buildConditionValuePayload(node)
  }
  return condition
}

function emptyDraft(): Draft {
  return {
    name: '',
    triggerType: 'record.created',
    triggerConfig: {},
    conditions: { conjunction: 'AND', conditions: [] },
    actions: [{ type: 'update_record', config: defaultConfigForActionType('update_record') }],
    executionMode: null,
  }
}

function draftConfigFromAction(type: AutomationActionType, config: Record<string, unknown>): DraftActionConfig {
  if (type === 'condition_branch') {
    const reason = conditionBranchUnsupportedReason(config)
    if (reason) {
      // A6-3-2a point #3: a loaded shape the v1 UI can't faithfully round-trip → read-only.
      // Preserve the ORIGINAL config verbatim; buildPayload re-emits it unchanged — never flatten.
      return { branchUnsupportedReason: reason, branchOriginal: config, branches: [], defaultBranch: null }
    }
    const parsed = parseConditionBranchDraft(config)
    return { branches: parsed.branches, defaultBranch: parsed.defaultBranch, branchUnsupportedReason: null, branchOriginal: null }
  }
  if (type === 'parallel_branch') {
    const reason = parallelBranchUnsupportedReason(config)
    if (reason) {
      return { parallelBranchUnsupportedReason: reason, parallelBranchOriginal: config, parallelBranches: [] }
    }
    const parsed = parseParallelBranchDraft(config)
    return { parallelBranches: parsed.branches, parallelBranchUnsupportedReason: null, parallelBranchOriginal: null }
  }
  if (type === 'update_record') {
    const fields = isPlainRecord(config.fields)
      ? config.fields
      : isPlainRecord(config.fieldUpdates)
        ? config.fieldUpdates
        : {}
    const fieldUpdates = Array.isArray(config.fieldUpdates)
      ? config.fieldUpdates
      : Object.entries(fields).map(([fieldId, value]) => ({ fieldId, value: String(value ?? '') }))
    return { ...config, fieldUpdates }
  }
  if (type === 'create_record') {
    const data = isPlainRecord(config.data)
      ? config.data
      : isPlainRecord(config.fieldValues)
        ? config.fieldValues
        : {}
    const fieldValues = Array.isArray(config.fieldValues)
      ? config.fieldValues
      : Object.entries(data).map(([fieldId, value]) => ({ fieldId, value: String(value ?? '') }))
    return {
      ...config,
      targetSheetId: typeof config.sheetId === 'string' ? config.sheetId : typeof config.targetSheetId === 'string' ? config.targetSheetId : '',
      fieldValues,
    }
  }
  if (type === 'send_notification') {
    return {
      ...config,
      userId: Array.isArray(config.userIds)
        ? config.userIds.join(', ')
        : typeof config.userId === 'string'
          ? config.userId
          : '',
      message: typeof config.message === 'string' ? config.message : '',
    }
  }
  if (type === 'start_approval') {
    // Backfill: disassemble the persisted formDataMapping object into editable {fieldId, value} rows
    // (inverse of buildActionPayload's fieldPairsToRecord). templateId loads as-is.
    const mapping = isPlainRecord(config.formDataMapping) ? config.formDataMapping : {}
    const formDataMappingPairs = Array.isArray(config.formDataMappingPairs)
      ? config.formDataMappingPairs
      : Object.entries(mapping).map(([fieldId, value]) => ({ fieldId, value: String(value ?? '') }))
    return {
      ...config,
      templateId: typeof config.templateId === 'string' ? config.templateId : '',
      formDataMappingPairs,
    }
  }
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
  if (type === 'send_email') {
    return {
      ...config,
      recipientsText: Array.isArray(config.recipients)
        ? config.recipients.join(', ')
        : '',
    }
  }
  return { ...config }
}

function draftFromRule(rule: AutomationRule): Draft {
  return {
    name: rule.name,
    triggerType: rule.triggerType,
    triggerConfig: { ...rule.triggerConfig, ...(rule.trigger?.config ?? {}) },
    conditions: conditionGroupFromRule(rule.conditions),
    actions: rule.actions && rule.actions.length
      ? rule.actions.map((a) => ({ type: a.type, config: draftConfigFromAction(a.type, a.config) }))
      : [{ type: rule.actionType, config: draftConfigFromAction(rule.actionType, rule.actionConfig) }],
    executionMode: rule.executionMode ?? null,
  }
}

const draft = ref<Draft>(emptyDraft())
const conditionEditorEntries = computed(() => collectConditionEditorEntries(draft.value.conditions.conditions))

// A6-2b/A6-3-2a/A6-3-4 + start_approval (W6-1): wait_for_callback, condition_branch, parallel_branch, AND
// start_approval all REQUIRE execution_mode 'workflow_job_v1' — the backend (collectNestedAutomationActions /
// validateStartApprovalActionConfigs) fail-closes a legacy rule that contains any of them. So whenever such an
// action is present the job-mode toggle is forced on (and disabled), and buildPayload enforces it regardless
// of toggle/loaded state. (start_approval MUST be here, else the editor would save executionMode:null and the
// server would reject the rule — breaking the "form.submitted → start_approval" authoring path.)
const JOB_MODE_REQUIRING_ACTION_TYPES: AutomationActionType[] = ['wait_for_callback', 'condition_branch', 'parallel_branch', 'start_approval']
const requiresJobMode = computed(() =>
  draft.value.actions.some((a) => JOB_MODE_REQUIRING_ACTION_TYPES.includes(a.type)),
)

// A6-3-2a: empty drafts for a fresh condition_branch action.
function createEmptyBranchActionDraft(): BranchActionDraft {
  return { type: 'update_record', fieldUpdates: [] }
}
function createEmptyBranchDraft(index = 1): BranchDraft {
  return { key: `branch_${index}`, label: '', conjunction: 'AND', conditions: [], actions: [createEmptyBranchActionDraft()] }
}
function createEmptyDefaultBranchDraft(): DefaultBranchDraft {
  return { key: 'default', label: '', actions: [createEmptyBranchActionDraft()] }
}
function createEmptyParallelBranchDraft(index = 1): ParallelBranchDraft {
  return { key: `branch_${index}`, label: '', actions: [createEmptyBranchActionDraft()] }
}

// A6-3-2a read-only guard (point #3) + branch-key validation (point #1) over the draft's
// condition_branch actions. Both feed canSave (block-save) and the template (alert).
const conditionBranchReadOnlyReason = computed<string | null>(() => {
  for (const a of draft.value.actions) {
    if (a.type === 'condition_branch' && a.config.branchUnsupportedReason) return a.config.branchUnsupportedReason
  }
  return null
})
const conditionBranchKeyError = computed<string | null>(() => {
  for (const a of draft.value.actions) {
    if (a.type === 'condition_branch' && !a.config.branchUnsupportedReason) {
      const err = validateConditionBranchKeys({
        branches: a.config.branches ?? [],
        defaultBranch: a.config.defaultBranch ?? null,
      })
      if (err) return err
    }
  }
  return null
})
const parallelBranchReadOnlyReason = computed<string | null>(() => {
  for (const a of draft.value.actions) {
    if (a.type === 'parallel_branch' && a.config.parallelBranchUnsupportedReason) return a.config.parallelBranchUnsupportedReason
  }
  return null
})
const parallelBranchKeyError = computed<string | null>(() => {
  for (const a of draft.value.actions) {
    if (a.type === 'parallel_branch' && !a.config.parallelBranchUnsupportedReason) {
      const err = validateParallelBranchKeys({ branches: a.config.parallelBranches ?? [] })
      if (err) return err
    }
  }
  return null
})
const parallelBranchActionError = computed<string | null>(() => {
  for (const a of draft.value.actions) {
    if (a.type === 'parallel_branch' && !a.config.parallelBranchUnsupportedReason) {
      const err = validateParallelBranchActions({ branches: a.config.parallelBranches ?? [] })
      if (err) return err
    }
  }
  return null
})

// A6-3-2a branch-builder mutations (operate on the draft action's config in place; Vue deep-reactive).
function addBranch(action: DraftAction): void {
  const branches = action.config.branches ?? (action.config.branches = [])
  branches.push(createEmptyBranchDraft(branches.length + 1))
}
function removeBranch(action: DraftAction, index: number): void {
  action.config.branches?.splice(index, 1)
}
function addBranchCondition(branch: BranchDraft): void {
  branch.conditions.push({ fieldId: '', operator: 'equals', value: '' })
}
function removeBranchCondition(branch: BranchDraft, index: number): void {
  branch.conditions.splice(index, 1)
}
function addBranchAction(branch: BranchDraft | DefaultBranchDraft | ParallelBranchDraft): void {
  branch.actions.push(createEmptyBranchActionDraft())
}
function removeBranchAction(branch: BranchDraft | DefaultBranchDraft | ParallelBranchDraft, index: number): void {
  branch.actions.splice(index, 1)
}
function onBranchActionTypeChange(action: BranchActionDraft): void {
  if (action.type === 'update_record') {
    action.fieldUpdates = action.fieldUpdates ?? []
    delete action.userId
    delete action.message
  } else if (action.type === 'wait_for_callback') {
    // A6-3-3b: zero-param suspend point — clear every field so the draft round-trips to `config: {}`.
    delete action.fieldUpdates
    delete action.userId
    delete action.message
  } else {
    action.userId = action.userId ?? ''
    action.message = action.message ?? ''
    delete action.fieldUpdates
  }
}
function addBranchFieldPair(action: BranchActionDraft): void {
  action.fieldUpdates = action.fieldUpdates ?? []
  action.fieldUpdates.push({ fieldId: '', value: '' })
}
function removeBranchFieldPair(action: BranchActionDraft, index: number): void {
  action.fieldUpdates?.splice(index, 1)
}
function addDefaultBranch(action: DraftAction): void {
  action.config.defaultBranch = createEmptyDefaultBranchDraft()
}
function removeDefaultBranch(action: DraftAction): void {
  action.config.defaultBranch = null
}
function addParallelBranch(action: DraftAction): void {
  const branches = action.config.parallelBranches ?? (action.config.parallelBranches = [])
  branches.push(createEmptyParallelBranchDraft(branches.length + 1))
}
function removeParallelBranch(action: DraftAction, index: number): void {
  action.config.parallelBranches?.splice(index, 1)
}

function setExecutionMode(checked: boolean): void {
  // A6-1 opt-in: checkbox → the rule's persistent WorkflowJob mode (off = legacy/null).
  // A6-2b/A6-3-2a: cannot turn it off while a required-job-mode action is present.
  if (requiresJobMode.value) {
    draft.value.executionMode = 'workflow_job_v1'
    return
  }
  draft.value.executionMode = checked ? 'workflow_job_v1' : null
}

function conditionPathKey(path: ConditionPath): string {
  return path.join('-') || 'root'
}

function conditionIndentStyle(depth: number): Record<string, string> {
  return { '--condition-depth': String(Math.max(0, depth)) }
}

function createBlankCondition(): AutomationCondition {
  return { fieldId: '', operator: 'equals', value: '' }
}

function createBlankConditionGroup(): ConditionGroup {
  return {
    conjunction: 'AND',
    conditions: [createBlankCondition()],
  }
}

function collectConditionEditorEntries(
  nodes: AutomationConditionNode[],
  parentPath: ConditionPath = [],
): ConditionEditorEntry[] {
  const entries: ConditionEditorEntry[] = []
  nodes.forEach((node, index) => {
    const path = [...parentPath, index]
    const pathKey = conditionPathKey(path)
    const depth = Math.max(0, path.length - 1)
    if (isConditionGroupNode(node)) {
      entries.push({
        kind: 'group',
        group: node,
        path,
        pathKey,
        depth,
        canAddGroup: canAddGroupToPath(path),
      })
      entries.push(...collectConditionEditorEntries(node.conditions, path))
      return
    }
    entries.push({
      kind: 'condition',
      condition: node,
      path,
      pathKey,
      depth,
    })
  })
  return entries
}

function canAddGroupToPath(path: ConditionPath): boolean {
  return path.length < MAX_CONDITION_GROUP_DEPTH
}

function groupAtPath(path: ConditionPath): ConditionGroup | null {
  let group: ConditionGroup = draft.value.conditions
  for (const index of path) {
    const node = group.conditions[index]
    if (!node || !isConditionGroupNode(node)) return null
    group = node
  }
  return group
}

function parentGroupForPath(path: ConditionPath): { group: ConditionGroup; index: number } | null {
  const index = path[path.length - 1]
  if (index === undefined) return null
  const group = groupAtPath(path.slice(0, -1))
  return group ? { group, index } : null
}

function setGroupConjunction(group: ConditionGroup, conjunction: 'AND' | 'OR') {
  group.conjunction = conjunction
  delete group.logic
}

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
        try {
          // Best-effort: a 401/403 (author lacks approvals:read) or any error → empty → text-input fallback.
          const res = await props.client.listApprovalTemplates()
          approvalTemplates.value = Array.isArray(res?.data) ? res.data : []
        } catch {
          approvalTemplates.value = []
        }
      } else {
        dingTalkDestinations.value = []
        approvalTemplates.value = []
      }
    }
  },
  { immediate: true },
)

const canSave = computed(() => {
  if (!draft.value.name.trim()) return false
  if (draft.value.actions.length < 1) return false
  if (conditionBranchReadOnlyReason.value) return false // A6-3-2a point #3: never save a non-round-trippable loaded branch
  if (conditionBranchKeyError.value) return false // A6-3-2a point #1: branch key safe/unique mirror
  if (parallelBranchReadOnlyReason.value) return false // A6-3-4/W3-2a: never save a non-round-trippable loaded join
  if (parallelBranchKeyError.value) return false // W3-2a: frontend mirror of backend branch bounds/keys
  if (parallelBranchActionError.value) return false // W3-2a: nested branch actions must be executable, not executor-failing shells
  if (!draft.value.conditions.conditions.every(areConditionsComplete)) return false
  for (const action of draft.value.actions) {
    if (action.type === 'send_dingtalk_group_message') {
      const destinationIds = parseGroupDestinationIds(action.config.destinationIds ?? action.config.destinationId)
      const destinationFieldPaths = parseRecipientFieldPathsText(action.config.destinationFieldPath)
      const titleTemplate = typeof action.config.titleTemplate === 'string' ? action.config.titleTemplate.trim() : ''
      const bodyTemplate = typeof action.config.bodyTemplate === 'string' ? action.config.bodyTemplate.trim() : ''
      if ((!destinationIds.length && !destinationFieldPaths.length) || !titleTemplate || !bodyTemplate) return false
      if (publicFormLinkBlockingErrors(action.config.publicFormViewId).length) return false
      if (internalViewLinkBlockingErrors(action.config.internalViewId).length) return false
    }
    if (action.type === 'send_dingtalk_person_message') {
      const userIds = parseUserIdsText(action.config.userIdsText)
      const memberGroupIds = parseMemberGroupIdsText(action.config.memberGroupIdsText)
      const recipientFieldPaths = parseRecipientFieldPathsText(action.config.recipientFieldPath)
      const memberGroupRecipientFieldPaths = parseRecipientFieldPathsText(action.config.memberGroupRecipientFieldPath)
      const titleTemplate = typeof action.config.titleTemplate === 'string' ? action.config.titleTemplate.trim() : ''
      const bodyTemplate = typeof action.config.bodyTemplate === 'string' ? action.config.bodyTemplate.trim() : ''
      if ((!userIds.length && !memberGroupIds.length && !recipientFieldPaths.length && !memberGroupRecipientFieldPaths.length) || !titleTemplate || !bodyTemplate) return false
      if (publicFormLinkBlockingErrors(action.config.publicFormViewId).length) return false
      if (internalViewLinkBlockingErrors(action.config.internalViewId).length) return false
    }
    if (action.type === 'send_email') {
      const recipients = parseEmailRecipientsText(action.config.recipientsText)
      const subjectTemplate = typeof action.config.subjectTemplate === 'string' ? action.config.subjectTemplate.trim() : ''
      const bodyTemplate = typeof action.config.bodyTemplate === 'string' ? action.config.bodyTemplate.trim() : ''
      if (!recipients.length || !subjectTemplate || !bodyTemplate) return false
    }
  }
  return true
})

function addCondition() {
  addConditionToGroup([])
}

function addConditionToGroup(path: ConditionPath) {
  const group = groupAtPath(path)
  if (!group) return
  group.conditions.push(createBlankCondition())
}

function addGroupToGroup(path: ConditionPath) {
  if (!canAddGroupToPath(path)) return
  const group = groupAtPath(path)
  if (!group) return
  group.conditions.push(createBlankConditionGroup())
}

function removeConditionNode(path: ConditionPath) {
  const parent = parentGroupForPath(path)
  if (!parent) return
  parent.group.conditions.splice(parent.index, 1)
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function fieldPairsToRecord(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) return {}
  const fields: Record<string, unknown> = {}
  for (const pair of value) {
    if (!isPlainRecord(pair)) continue
    const fieldId = typeof pair.fieldId === 'string' ? pair.fieldId.trim() : ''
    if (!fieldId) continue
    fields[fieldId] = pair.value ?? ''
  }
  return fields
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

function parseEmailRecipientsText(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return Array.from(new Set(
    value
      .split(/[\n,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  ))
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

function rememberPersonRecipientSuggestions(items: MetaSheetPermissionCandidate[]) {
  const next = { ...personRecipientDirectory.value }
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
  personRecipientDirectory.value = next
}

function selectedPersonRecipients(action: DraftAction) {
  return parseUserIdsText(action.config.userIdsText).map((id) => {
    const directoryEntry = personRecipientDirectory.value[personRecipientDirectoryKey('user', id)]
    return {
      id,
      label: directoryEntry?.label ?? id,
      subtitle: directoryEntry?.subtitle,
      dingtalkBound: directoryEntry?.dingtalkBound ?? null,
      dingtalkGrantEnabled: directoryEntry?.dingtalkGrantEnabled ?? null,
      dingtalkPersonDeliveryAvailable: directoryEntry?.dingtalkPersonDeliveryAvailable ?? null,
    }
  })
}

function selectedPersonRecipientGroups(action: DraftAction) {
  return parseMemberGroupIdsText(action.config.memberGroupIdsText).map((id) => {
    const directoryEntry = personRecipientDirectory.value[personRecipientDirectoryKey('member-group', id)]
    return {
      id,
      label: directoryEntry?.label ?? id,
      subtitle: directoryEntry?.subtitle,
      dingtalkBound: directoryEntry?.dingtalkBound ?? null,
      dingtalkGrantEnabled: directoryEntry?.dingtalkGrantEnabled ?? null,
      dingtalkPersonDeliveryAvailable: directoryEntry?.dingtalkPersonDeliveryAvailable ?? null,
    }
  })
}

function availablePersonRecipientSuggestions(idx: number, action: DraftAction) {
  const selected = new Set(parseUserIdsText(action.config.userIdsText))
  const selectedGroups = new Set(parseMemberGroupIdsText(action.config.memberGroupIdsText))
  return (personRecipientSuggestions.value[idx] ?? []).filter((candidate) => {
    if (!isPersonRecipientCandidate(candidate)) return false
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
  if (!isPersonRecipientCandidate(candidate)) return
  if (isInactivePersonRecipientCandidate(candidate)) return
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

function groupDestinationScope(destination?: DingTalkGroupDestination): 'private' | 'sheet' | 'org' {
  if (!destination) return 'private'
  if (destination.scope === 'org' || destination.orgId) return 'org'
  if (destination.scope === 'sheet' || destination.sheetId) return 'sheet'
  return 'private'
}

function groupDestinationScopeLabel(destination?: DingTalkGroupDestination): string {
  const scope = groupDestinationScope(destination)
  return automationDingTalkDestinationScopeLabel(scope, isZh.value)
}

function groupDestinationSubtitle(destination?: DingTalkGroupDestination): string | undefined {
  const scope = groupDestinationScope(destination)
  return automationDingTalkDestinationSubtitle(scope, scope === 'org' ? destination?.orgId ?? '' : destination?.sheetId ?? '', isZh.value)
}

function selectedGroupDestinations(action: DraftAction) {
  return parseGroupDestinationIds(action.config.destinationIds ?? action.config.destinationId).map((id) => {
    const destination = dingTalkDestinations.value.find((item) => item.id === id)
    return {
      id,
      label: destination?.name ?? id,
      subtitle: groupDestinationSubtitle(destination),
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
  if (!selected.length) return automationLabel('dingtalk.noGroupsSelected', isZh.value)
  return selected.map((item) => item.label).join(', ')
}

function groupDestinationFieldPathWarnings(value: unknown) {
  return listDingTalkGroupDestinationFieldPathWarnings(value, props.fields, isZh.value)
}

function groupDestinationFieldPathSummary(value: unknown) {
  const labels = parseRecipientFieldPathsText(value)
    .map((path) => recipientFieldSummaryLabel(path))
    .filter(Boolean)
  if (!labels.length) return automationLabel('dingtalk.noDynamicGroupField', isZh.value)
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
  const id = typeof viewId === 'string' ? viewId.trim() : ''
  if (!id) return fallback
  return (props.views ?? []).find((view) => view.id === id)?.name ?? id
}

function templatePreviewText(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function renderedTemplateExample(value: unknown, fallback: string) {
  if (typeof value !== 'string' || !value.trim()) return fallback
  const rendered = renderDingTalkTemplateExample(value, isZh.value).trim()
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

function publicFormAccessState(value: unknown) {
  return getDingTalkPublicFormLinkAccessState(value, formViews.value, { isZh: isZh.value })
}

function isDingTalkActionType(value: unknown): boolean {
  return value === 'send_dingtalk_group_message' || value === 'send_dingtalk_person_message'
}

function ruleHasDingTalkActions(rule: AutomationRule | undefined): boolean {
  if (!rule) return false
  return isDingTalkActionType(rule.actionType)
    || (rule.actions ?? []).some((action) => isDingTalkActionType(action.type))
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
    selectedUsers.length ? `${isZh.value ? '用户' : 'Users'}: ${selectedUsers.join(', ')}` : '',
    selectedGroups.length ? `${isZh.value ? '成员组' : 'Groups'}: ${selectedGroups.join(', ')}` : '',
  ].filter(Boolean)
  if (!parts.length) return automationLabel('dingtalk.noRecipientsSelected', isZh.value)
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
  return listDingTalkPersonRecipientFieldPathWarnings(value, props.fields, isZh.value)
}

function memberGroupRecipientFieldPathWarnings(value: unknown) {
  return listDingTalkPersonMemberGroupRecipientFieldPathWarnings(value, props.fields, isZh.value)
}

function recipientFieldPathSummary(value: unknown) {
  const labels = parseRecipientFieldPathsText(value)
    .map((path) => recipientFieldSummaryLabel(path))
    .filter(Boolean)
  if (!labels.length) return automationLabel('dingtalk.noDynamicRecipientField', isZh.value)
  return labels.join(', ')
}

function memberGroupRecipientFieldPathSummary(value: unknown) {
  const labels = parseRecipientFieldPathsText(value)
    .map((path) => recipientFieldSummaryLabel(path))
    .filter(Boolean)
  if (!labels.length) return automationLabel('dingtalk.noDynamicMemberGroupField', isZh.value)
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
  return typeof value === 'string' ? listDingTalkTemplateSyntaxWarnings(value, isZh.value) : []
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
      isZh.value,
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
      isZh.value,
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
    case 'condition_branch':
      return { branches: [createEmptyBranchDraft(1)], defaultBranch: null, branchUnsupportedReason: null, branchOriginal: null }
    case 'parallel_branch':
      return { parallelBranches: [createEmptyParallelBranchDraft(1)], parallelBranchUnsupportedReason: null, parallelBranchOriginal: null }
    case 'update_record':
      return { fieldUpdates: [] }
    case 'create_record':
      return { fieldValues: [] }
    case 'send_webhook':
      return { method: 'POST' }
    case 'send_notification':
      return { userId: '', message: '' }
    case 'send_email':
      return { recipientsText: '', subjectTemplate: '', bodyTemplate: '' }
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
    case 'wait_for_callback':
      return {} // A6-2: zero-param suspend point (no webhook-URL/timer/manual-task fields)
    default:
      return {}
  }
}

function onDraftActionTypeChange(action: DraftAction) {
  action.config = defaultConfigForActionType(action.type)
  if (JOB_MODE_REQUIRING_ACTION_TYPES.includes(action.type)) draft.value.executionMode = 'workflow_job_v1'
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

// start_approval: formDataMapping rows reuse the FieldPair shape (fieldId = the approval-form field key,
// value = the source record field id). buildActionPayload assembles them into the {key: value} object the
// backend's validateStartApprovalConfig requires.
function addApprovalMapping(action: DraftAction) {
  if (!Array.isArray(action.config.formDataMappingPairs)) action.config.formDataMappingPairs = []
  ;(action.config.formDataMappingPairs as FieldPair[]).push({ fieldId: '', value: '' })
}

function removeApprovalMapping(action: DraftAction, idx: number) {
  ;(action.config.formDataMappingPairs as FieldPair[]).splice(idx, 1)
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
  if (d.triggerType === 'schedule.date_field') {
    // Normalize the date-reminder config so an unset/garbage direction or offset can't persist a no-op rule.
    triggerConfig.direction = triggerConfig.direction === 'after' ? 'after' : 'before'
    triggerConfig.offsetDays = Number(triggerConfig.offsetDays) || 0
  }
  const actions = d.actions.map((action) => {
    if (action.type === 'condition_branch') {
      // A6-3-2a point #3: read-only (unsupported loaded shape) re-emits the preserved original
      // verbatim — never flattened. (canSave blocks save here anyway; this is the defensive floor.)
      if (action.config.branchUnsupportedReason && action.config.branchOriginal) {
        return { type: action.type, config: action.config.branchOriginal }
      }
      return {
        type: action.type,
        config: buildConditionBranchConfig({
          branches: action.config.branches ?? [],
          defaultBranch: action.config.defaultBranch ?? null,
        }),
      }
    }
    if (action.type === 'update_record') {
      return {
        type: action.type,
        config: {
          fields: fieldPairsToRecord(action.config.fieldUpdates),
        },
      }
    }
    if (action.type === 'start_approval') {
      // Assemble the {key: value} formDataMapping the backend requires from the editable rows. templateId +
      // mapping non-emptiness are enforced server-side (validateStartApprovalConfig) — the UI is authoring,
      // not the validation gate.
      return {
        type: action.type,
        config: {
          templateId: typeof action.config.templateId === 'string' ? action.config.templateId.trim() : '',
          formDataMapping: fieldPairsToRecord(action.config.formDataMappingPairs),
        },
      }
    }
    if (action.type === 'parallel_branch') {
      if (action.config.parallelBranchUnsupportedReason && action.config.parallelBranchOriginal) {
        return { type: action.type, config: action.config.parallelBranchOriginal }
      }
      return {
        type: action.type,
        config: buildParallelBranchConfig({
          branches: action.config.parallelBranches ?? [],
        }),
      }
    }
    if (action.type === 'create_record') {
      return {
        type: action.type,
        config: {
          sheetId: typeof action.config.targetSheetId === 'string' && action.config.targetSheetId.trim()
            ? action.config.targetSheetId.trim()
            : undefined,
          data: fieldPairsToRecord(action.config.fieldValues),
        },
      }
    }
    if (action.type === 'send_notification') {
      return {
        type: action.type,
        config: {
          userIds: parseUserIdsText(action.config.userId),
          message: typeof action.config.message === 'string' ? action.config.message.trim() : '',
        },
      }
    }
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
    if (action.type === 'send_email') {
      return {
        type: action.type,
        config: {
          recipients: parseEmailRecipientsText(action.config.recipientsText),
          subjectTemplate: typeof action.config.subjectTemplate === 'string' ? action.config.subjectTemplate.trim() : '',
          bodyTemplate: typeof action.config.bodyTemplate === 'string' ? action.config.bodyTemplate.trim() : '',
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
    conditions: d.conditions.conditions.length > 0
      ? {
        conjunction: d.conditions.conjunction,
        conditions: d.conditions.conditions.map(buildConditionNodePayload),
      }
      : undefined,
    actions,
    actionType: actions[0]?.type ?? 'update_record',
    actionConfig: actions[0]?.config ?? {},
    // A6-2b/A6-3-2a: required-job-mode actions force workflow_job_v1 (backend fail-closes
    // legacy waits/branches) — enforced here so the payload is correct regardless of toggle state.
    executionMode: requiresJobMode.value ? 'workflow_job_v1' : d.executionMode,
  }
}

async function onSave() {
  if (!canSave.value) return
  saving.value = true
  error.value = ''
  try {
    emit('save', buildPayload())
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : automationLabel('error.saveFailed', isZh.value)
  } finally {
    saving.value = false
  }
}

function onTestRun() {
  if (saving.value || props.testRunState?.status === 'running' || !props.rule?.id) return
  if (savedRuleHasDingTalkActions.value && !window.confirm(dingTalkTestRunConfirmMessage())) return
  emit('test', props.rule.id)
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

.meta-rule-editor__access-summary {
  border-radius: 8px;
  padding: 6px 8px;
}

.meta-rule-editor__access-audience {
  border-radius: 8px;
  background: #f8fafc;
  color: #475569;
  padding: 6px 8px;
}

.meta-rule-editor__access-summary--public {
  background: #fffbeb;
  color: #92400e;
}

.meta-rule-editor__access-summary--dingtalk {
  background: #eff6ff;
  color: #1d4ed8;
}

.meta-rule-editor__access-summary--dingtalk_granted {
  background: #ecfdf5;
  color: #047857;
}

.meta-rule-editor__access-summary--unavailable {
  background: #fef2f2;
  color: #b91c1c;
}

.meta-rule-editor__label { font-size: 12px; font-weight: 600; color: #475569; margin-top: 4px; }

.meta-rule-editor__hint--error { color: #b91c1c; }

.meta-rule-editor__hint--warning { color: #b45309; }

.meta-rule-editor__test-run-feedback {
  flex: 1 1 280px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.meta-rule-editor__test-run-status {
  font-size: 12px;
  font-weight: 600;
}

.meta-rule-editor__test-run-status--success { color: #15803d; }
.meta-rule-editor__test-run-status--failed { color: #b91c1c; }
.meta-rule-editor__test-run-status--skipped { color: #b45309; }
.meta-rule-editor__test-run-status--running { color: #1d4ed8; }

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

.meta-rule-editor__condition-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.meta-rule-editor__condition-row,
.meta-rule-editor__condition-group {
  margin-left: calc(var(--condition-depth, 0) * 18px);
}

.meta-rule-editor__condition-group {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px;
  border: 1px dashed #cbd5e1;
  border-radius: 8px;
  background: #f8fafc;
}

.meta-rule-editor__group-label {
  color: #475569;
  font-size: 12px;
  font-weight: 600;
}

.meta-rule-editor__condition-actions {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
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
  align-items: center;
  flex-wrap: wrap;
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
