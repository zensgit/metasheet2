<template>
    <div class="attendance__admin-section">
      <div class="attendance__admin-section-header">
        <h4>{{ tr('Rule Sets', '规则集') }}</h4>
        <button class="attendance__btn" :disabled="ruleSetLoading" @click="loadRuleSets">
          {{ ruleSetLoading ? tr('Loading...', '加载中...') : tr('Reload rule sets', '重载规则集') }}
      </button>
    </div>
    <div class="attendance__admin-grid">
      <label class="attendance__field" for="attendance-rule-set-name">
        <span>{{ tr('Name', '名称') }}</span>
        <input
          id="attendance-rule-set-name"
          v-model="ruleSetForm.name"
          name="ruleSetName"
          type="text"
          required
          :placeholder="tr('Required rule set name', '必填规则集名称')"
        />
      </label>
      <label class="attendance__field" for="attendance-rule-set-scope">
        <span>{{ tr('Scope', '范围') }}</span>
        <select id="attendance-rule-set-scope" v-model="ruleSetForm.scope" name="ruleSetScope">
          <option value="org">{{ tr('Org', '组织') }}</option>
          <option value="department">{{ tr('Department', '部门') }}</option>
          <option value="project">{{ tr('Project', '项目') }}</option>
          <option value="user">{{ tr('User', '用户') }}</option>
          <option value="custom">{{ tr('Custom', '自定义') }}</option>
        </select>
      </label>
      <label class="attendance__field" for="attendance-rule-set-version">
        <span>{{ tr('Version', '版本') }}</span>
        <input
          id="attendance-rule-set-version"
          v-model.number="ruleSetForm.version"
          name="ruleSetVersion"
          type="number"
          min="1"
        />
      </label>
      <label class="attendance__field attendance__field--checkbox" for="attendance-rule-set-default">
        <span>{{ tr('Default', '默认') }}</span>
        <input
          id="attendance-rule-set-default"
          v-model="ruleSetForm.isDefault"
          name="ruleSetDefault"
          type="checkbox"
        />
      </label>
        <label class="attendance__field attendance__field--full" for="attendance-rule-set-description">
          <span>{{ tr('Description', '描述') }}</span>
          <input
            id="attendance-rule-set-description"
            v-model="ruleSetForm.description"
            name="ruleSetDescription"
            type="text"
            :placeholder="tr('Optional', '可选')"
          />
        </label>
      </div>
      <div class="attendance__rule-builder">
        <div class="attendance__admin-section-header">
          <div>
            <h5 class="attendance__subheading">{{ tr('Structured rule builder', '结构化规则构建器') }}</h5>
            <p class="attendance__field-hint">
              {{ tr('The builder keeps the JSON config in sync and preserves any advanced fields already stored in the rule draft.', '构建器会同步 JSON 配置，并保留规则草稿中已有的高级字段。') }}
            </p>
          </div>
          <div class="attendance__rule-builder-summary">
            <span>{{ tr('Source', '来源') }}: <strong>{{ ruleBuilderSource || '--' }}</strong></span>
            <span>{{ tr('Timezone', '时区') }}: <strong>{{ ruleBuilderTimezone || '--' }}</strong></span>
            <span>{{ tr('Working days', '工作日') }}: <strong>{{ formatWorkingDays(ruleBuilderWorkingDays) }}</strong></span>
          </div>
        </div>

        <div class="attendance__admin-grid">
          <label class="attendance__field" for="attendance-rule-builder-source">
            <span>{{ tr('Source', '来源') }}</span>
            <input
              id="attendance-rule-builder-source"
              v-model="ruleBuilderSource"
              type="text"
              :placeholder="tr('dingtalk / manual / csv', 'dingtalk / manual / csv')"
            />
          </label>
          <label class="attendance__field" for="attendance-rule-builder-timezone">
            <span>{{ tr('Timezone', '时区') }}</span>
            <input
              id="attendance-rule-builder-timezone"
              v-model="ruleBuilderTimezone"
              type="text"
              :placeholder="tr('Asia/Shanghai', 'Asia/Shanghai')"
            />
          </label>
          <label class="attendance__field" for="attendance-rule-builder-start">
            <span>{{ tr('Work start time', '上班时间') }}</span>
            <input
              id="attendance-rule-builder-start"
              v-model="ruleBuilderWorkStartTime"
              type="time"
            />
          </label>
          <label class="attendance__field" for="attendance-rule-builder-end">
            <span>{{ tr('Work end time', '下班时间') }}</span>
            <input
              id="attendance-rule-builder-end"
              v-model="ruleBuilderWorkEndTime"
              type="time"
            />
          </label>
          <label class="attendance__field" for="attendance-rule-builder-late-grace">
            <span>{{ tr('Late grace minutes', '迟到宽限分钟') }}</span>
            <input
              id="attendance-rule-builder-late-grace"
              v-model.number="ruleBuilderLateGraceMinutes"
              type="number"
              min="0"
            />
          </label>
          <label class="attendance__field" for="attendance-rule-builder-early-grace">
            <span>{{ tr('Early grace minutes', '早退宽限分钟') }}</span>
            <input
              id="attendance-rule-builder-early-grace"
              v-model.number="ruleBuilderEarlyGraceMinutes"
              type="number"
              min="0"
            />
          </label>
        </div>

        <div class="attendance__rule-builder-days">
          <span class="attendance__field-label">{{ tr('Working days', '工作日') }}</span>
          <div class="attendance__rule-builder-day-grid">
            <label
              v-for="day in ruleBuilderDayOptions"
              :key="day.value"
              class="attendance__rule-builder-day"
            >
              <input v-model="ruleBuilderWorkingDays" type="checkbox" :value="day.value" />
              <span>{{ tr(day.labelEn, day.labelZh) }}</span>
            </label>
          </div>
          <small class="attendance__field-hint">
            {{ tr('Use the same weekday numbers as the scheduling module. Monday is 1 and Sunday is 0.', '使用与排班模块一致的星期编号。周一是 1，周日是 0。') }}
          </small>
        </div>

        <div class="attendance__rule-builder-preview">
          <div class="attendance__admin-section-header">
            <div>
              <h6 class="attendance__subheading">{{ tr('Draft preview', '草稿预览') }}</h6>
              <p class="attendance__field-hint">
                {{ tr('This preview reflects the current builder state before saving.', '该预览展示的是当前构建器状态，尚未保存。') }}
              </p>
            </div>
            <div class="attendance__admin-actions">
              <button
                v-if="previewRuleSet"
                class="attendance__btn attendance__btn--primary"
                type="button"
                :disabled="ruleSetPreviewLoading || ruleSetSaving"
                @click="previewRuleSet"
              >
                {{ ruleSetPreviewLoading ? tr('Previewing...', '预览中...') : tr('Preview rule set', '预览规则集') }}
              </button>
              <button
                v-if="resetRuleBuilder"
                class="attendance__btn"
                type="button"
                :disabled="ruleSetPreviewLoading || ruleSetSaving"
                @click="resetRuleBuilder"
              >
                {{ tr('Reset builder', '重置构建器') }}
              </button>
            </div>
          </div>

          <div class="attendance__preview-builder">
            <div class="attendance__admin-section-header">
              <div>
                <h6 class="attendance__subheading">{{ tr('Sample event builder', '样本事件构建器') }}</h6>
                <p class="attendance__field-hint">
                  {{ tr('Build preview events row by row. The JSON textarea below remains the advanced mode.', '按行构建预览事件。下方 JSON 文本框仍保留为高级模式。') }}
                </p>
              </div>
              <div class="attendance__admin-actions">
                <button class="attendance__btn" type="button" @click="addPreviewEvent">
                  {{ tr('Add event', '新增事件') }}
                </button>
                <button class="attendance__btn" type="button" @click="resetPreviewEvents">
                  {{ tr('Reset events', '重置事件') }}
                </button>
              </div>
            </div>

            <div class="attendance__scenario-lab">
              <div class="attendance__field-label">{{ tr('Scenario presets', '场景预设') }}</div>
              <div class="attendance__scenario-grid">
                <button
                  v-for="scenario in previewScenarioPresets"
                  :key="scenario.id"
                  type="button"
                  class="attendance__scenario-card"
                  :class="{ 'attendance__scenario-card--active': activePreviewScenarioId === scenario.id }"
                  @click="applyPreviewScenario(scenario.id)"
                >
                  <strong>{{ tr(scenario.labelEn, scenario.labelZh) }}</strong>
                  <span>{{ tr(scenario.descriptionEn, scenario.descriptionZh) }}</span>
                </button>
              </div>
            </div>

            <div v-if="previewEventDrafts.length === 0" class="attendance__empty">
              {{ tr('No sample events yet. Add one to preview rule results.', '尚无样本事件。添加一条后即可预览规则结果。') }}
            </div>
            <div v-else class="attendance__table-wrapper">
              <table class="attendance__table">
                <thead>
                  <tr>
                    <th>{{ tr('Type', '类型') }}</th>
                    <th>{{ tr('Occurred at', '发生时间') }}</th>
                    <th>{{ tr('Work date', '工作日期') }}</th>
                    <th>{{ tr('User ID', '用户 ID') }}</th>
                    <th>{{ tr('Actions', '操作') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(event, index) in previewEventDrafts" :key="event.id">
                    <td>
                      <select v-model="event.eventType">
                        <option value="check_in">{{ tr('Check in', '上班打卡') }}</option>
                        <option value="check_out">{{ tr('Check out', '下班打卡') }}</option>
                      </select>
                    </td>
                    <td>
                      <input v-model="event.occurredAt" type="datetime-local" />
                    </td>
                    <td>
                      <input v-model="event.workDate" type="date" />
                    </td>
                    <td>
                      <input v-model="event.userId" type="text" :placeholder="tr('user-1', 'user-1')" />
                    </td>
                    <td class="attendance__table-actions">
                      <button class="attendance__btn" type="button" @click="duplicatePreviewEvent(index)">
                        {{ tr('Duplicate', '复制') }}
                      </button>
                      <button class="attendance__btn attendance__btn--danger" type="button" @click="removePreviewEvent(index)">
                        {{ tr('Remove', '移除') }}
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <label class="attendance__field attendance__field--full" for="attendance-rule-preview-events">
            <span>{{ tr('Preview events (JSON advanced mode)', '预览事件（JSON 高级模式）') }}</span>
            <textarea
              id="attendance-rule-preview-events"
              v-model="ruleSetPreviewEventsText"
              rows="6"
              placeholder='[{"eventType":"check_in","occurredAt":"2026-03-21T09:02:00+08:00","workDate":"2026-03-21","userId":"user-1"},{"eventType":"check_out","occurredAt":"2026-03-21T18:08:00+08:00","workDate":"2026-03-21","userId":"user-1"}]'
            />
            <small class="attendance__field-hint">
              {{ tr('Use check_in/check_out events. You can keep workDate fixed and adjust occurredAt to simulate late arrivals or early leaves.', '使用 check_in/check_out 事件。可固定 workDate，再通过调整 occurredAt 模拟迟到或早退。') }}
            </small>
          </label>

          <div v-if="ruleSetPreviewLoading" class="attendance__preview-state">
            {{ tr('Preview is running against the current draft...', '预览正在基于当前草稿运行...') }}
          </div>
          <div v-else-if="ruleSetPreviewError" class="attendance__empty attendance__empty--error">
            {{ ruleSetPreviewError }}
          </div>
          <template v-else>
            <div class="attendance__preview-summary">
              <span>{{ tr('Rule source', '规则来源') }}: <strong>{{ ruleBuilderSource || '--' }}</strong></span>
              <span>{{ tr('Work window', '工作时间窗') }}: <strong>{{ ruleBuilderWorkStartTime || '--' }} - {{ ruleBuilderWorkEndTime || '--' }}</strong></span>
              <span>{{ tr('Grace', '宽限') }}: <strong>{{ ruleBuilderLateGraceMinutes }} / {{ ruleBuilderEarlyGraceMinutes }} min</strong></span>
            </div>
            <div class="attendance__preview-config-panels">
              <div v-if="ruleSetPreviewConfigDiff" class="attendance__template-version-panel attendance__template-version-panel--full">
                <div class="attendance__subheading-row">
                  <div>
                    <div class="attendance__field-label">{{ tr('Config change summary', '配置变化摘要') }}</div>
                    <small class="attendance__field-hint">
                      {{ tr('Highlights how the preview API resolved or normalized the draft before evaluating events.', '展示预演接口在评估事件前，如何补齐默认值或归一化当前草稿。') }}
                    </small>
                  </div>
                  <span class="attendance__field-hint">
                    {{ tr('Compared against the current draft config.', '与当前草稿配置对比。') }}
                  </span>
                </div>
                <div class="attendance__preview-scorecards">
                  <div class="attendance__preview-scorecard">
                    <span>{{ tr('Changed fields', '变更字段') }}</span>
                    <strong>{{ ruleSetPreviewConfigDiff.changedCount }}</strong>
                    <small>{{ tr('Value rewritten during resolution', '服务端归一化后改写的值') }}</small>
                  </div>
                  <div class="attendance__preview-scorecard">
                    <span>{{ tr('Added defaults', '新增默认值') }}</span>
                    <strong>{{ ruleSetPreviewConfigDiff.addedCount }}</strong>
                    <small>{{ tr('Fields returned only by resolved config', '仅在生效配置中返回的字段') }}</small>
                  </div>
                  <div class="attendance__preview-scorecard">
                    <span>{{ tr('Removed fields', '移除字段') }}</span>
                    <strong>{{ ruleSetPreviewConfigDiff.removedCount }}</strong>
                    <small>{{ tr('Draft keys not kept by resolved config', '草稿里有但生效配置未保留的字段') }}</small>
                  </div>
                  <div class="attendance__preview-scorecard">
                    <span>{{ tr('Touched paths', '涉及路径') }}</span>
                    <strong>{{ ruleSetPreviewConfigDiff.totalChanges }}</strong>
                    <small>{{ tr('Leaf-level config differences', '叶子级配置差异数') }}</small>
                  </div>
                </div>
                <div v-if="ruleSetPreviewConfigDiff.items.length" class="attendance__preview-recommendations">
                  <div
                    v-for="item in ruleSetPreviewConfigDiff.items"
                    :key="item.path"
                    class="attendance__preview-recommendation"
                    :class="`attendance__preview-recommendation--${item.severity}`"
                  >
                    <div class="attendance__subheading-row">
                      <strong>{{ item.label }}</strong>
                      <span class="attendance__severity" :class="`attendance__severity--${item.severity}`">
                        {{ formatPreviewSeverity(item.severity) }}
                      </span>
                    </div>
                    <span>{{ item.summary }}</span>
                    <code class="attendance__inline-code">{{ item.path }}</code>
                  </div>
                </div>
                <div v-else class="attendance__preview-recommendation attendance__preview-recommendation--info">
                  <strong>{{ tr('Resolved config matches the draft', '生效配置与草稿一致') }}</strong>
                  <span>{{ tr('Preview did not need to add defaults or rewrite any leaf-level config values.', '预演没有补齐默认值，也没有改写任何叶子级配置值。') }}</span>
                </div>
              </div>
              <div class="attendance__template-version-panel">
                <div class="attendance__field-label">{{ tr('Draft config', '草稿配置') }}</div>
                <small class="attendance__field-hint">
                  {{ tr('Builder-generated config before preview execution.', '基于当前构建器生成、尚未发送到服务端前的配置。') }}
                </small>
                <pre class="attendance__code attendance__code--builder">{{ formatJson(ruleBuilderPreviewConfig) }}</pre>
              </div>
              <div v-if="ruleSetPreviewEffectiveConfig" class="attendance__template-version-panel">
                <div class="attendance__field-label">{{ tr('Resolved config', '生效配置') }}</div>
                <small class="attendance__field-hint">
                  {{ tr('Normalized by the preview API after defaults and server-side resolution.', '由预演接口在补齐默认值和服务端归一化后返回。') }}
                </small>
                <pre class="attendance__code attendance__code--builder">{{ formatJson(ruleSetPreviewEffectiveConfig) }}</pre>
              </div>
            </div>
          </template>

          <div v-if="ruleSetPreviewResult" class="attendance__preview-result">
            <div class="attendance__preview-result-meta">
              <span>{{ tr('Events', '事件') }}: {{ ruleSetPreviewResult.totalEvents ?? ruleSetPreviewRows.length }}</span>
              <span v-if="ruleSetPreviewResult.ruleSetId">{{ tr('Rule set id', '规则集 ID') }}: <code>{{ ruleSetPreviewResult.ruleSetId }}</code></span>
            </div>
            <div class="attendance__preview-scorecards">
              <div class="attendance__preview-scorecard">
                <span>{{ tr('Rows affected', '受影响行') }}</span>
                <strong>{{ ruleSetPreviewSummary.flaggedRows }}</strong>
                <small>{{ tr('Clean rows', '正常行') }}: {{ ruleSetPreviewSummary.cleanRows }}</small>
              </div>
              <div class="attendance__preview-scorecard">
                <span>{{ tr('Late / early', '迟到 / 早退') }}</span>
                <strong>{{ ruleSetPreviewSummary.lateRows }} / {{ ruleSetPreviewSummary.earlyLeaveRows }}</strong>
                <small>{{ tr('Minutes', '分钟') }}: {{ ruleSetPreviewSummary.totalLateMinutes }} / {{ ruleSetPreviewSummary.totalEarlyLeaveMinutes }}</small>
              </div>
              <div class="attendance__preview-scorecard">
                <span>{{ tr('Missing punches', '缺卡') }}</span>
                <strong>{{ ruleSetPreviewSummary.missingCheckInRows }} / {{ ruleSetPreviewSummary.missingCheckOutRows }}</strong>
                <small>{{ tr('In / out', '上班 / 下班') }}</small>
              </div>
              <div class="attendance__preview-scorecard">
                <span>{{ tr('Non-working days', '非工作日') }}</span>
                <strong>{{ ruleSetPreviewSummary.nonWorkingDayRows }}</strong>
                <small>{{ tr('Abnormal status', '异常状态') }}: {{ ruleSetPreviewSummary.abnormalStatusRows }}</small>
              </div>
              <div class="attendance__preview-scorecard">
                <span>{{ tr('Average work minutes', '平均工时分钟') }}</span>
                <strong>{{ ruleSetPreviewSummary.averageWorkMinutes }}</strong>
                <small>{{ tr('Preview rows', '预演行数') }}: {{ ruleSetPreviewSummary.totalRows }}</small>
              </div>
            </div>
            <div v-if="ruleSetPreviewRecommendations.length" class="attendance__preview-recommendations">
              <div
                v-for="item in ruleSetPreviewRecommendations"
                :key="item.key"
                class="attendance__preview-recommendation"
                :class="`attendance__preview-recommendation--${item.severity}`"
              >
                <div class="attendance__subheading-row">
                  <strong>{{ formatRuleSetRecommendationTitle(item) }}</strong>
                  <span class="attendance__severity" :class="`attendance__severity--${item.severity}`">
                    {{ formatPreviewSeverity(item.severity) }}
                  </span>
                </div>
                <span>{{ formatRuleSetRecommendationBody(item) }}</span>
              </div>
            </div>
            <div v-else class="attendance__preview-recommendation attendance__preview-recommendation--info">
              <strong>{{ tr('Current draft looks stable', '当前草稿表现稳定') }}</strong>
              <span>{{ tr('The selected preview rows are clean under the current builder settings.', '当前构建器设置下，所选预演样本没有暴露规则问题。') }}</span>
            </div>
            <div v-if="ruleSetPreviewNotes.length" class="attendance__field-hint">
              {{ tr('Notes', '说明') }}: {{ ruleSetPreviewNotes.join(' · ') }}
            </div>
            <div v-if="ruleSetPreviewRows.length" class="attendance__table-wrapper">
              <table class="attendance__table">
                <thead>
                  <tr>
                    <th>{{ tr('Work date', '工作日期') }}</th>
                    <th>{{ tr('User ID', '用户 ID') }}</th>
                    <th>{{ tr('Check in / out', '上下班') }}</th>
                    <th>{{ tr('Work minutes', '工时分钟') }}</th>
                    <th>{{ tr('Late', '迟到') }}</th>
                    <th>{{ tr('Early leave', '早退') }}</th>
                    <th>{{ tr('Working day', '工作日') }}</th>
                    <th>{{ tr('Status', '状态') }}</th>
                    <th>{{ tr('Actions', '操作') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in ruleSetPreviewRows"
                    :key="`${row.userId}-${row.workDate}`"
                    :class="{ 'attendance__preview-row--selected': selectedRuleSetPreviewRowKey === getRuleSetPreviewRowKey(row) }"
                  >
                    <td>{{ row.workDate }}</td>
                    <td>{{ row.userId }}</td>
                    <td>{{ row.firstInAt ? formatDateTime(row.firstInAt) : '--' }} / {{ row.lastOutAt ? formatDateTime(row.lastOutAt) : '--' }}</td>
                    <td>{{ row.workMinutes ?? '--' }}</td>
                    <td>{{ row.lateMinutes ?? '--' }}</td>
                    <td>{{ row.earlyLeaveMinutes ?? '--' }}</td>
                    <td>{{ row.isWorkingDay === false ? tr('No', '否') : tr('Yes', '是') }}</td>
                    <td>{{ row.status ?? '--' }}</td>
                    <td class="attendance__table-actions">
                      <button class="attendance__btn" type="button" @click="selectRuleSetPreviewRow(row)">
                        {{ tr('Inspect', '诊断') }}
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-if="selectedRuleSetPreviewRow" class="attendance__template-version-panel">
              <div class="attendance__subheading-row">
                <h6 class="attendance__subheading">{{ tr('Selected preview diagnosis', '选中预演诊断') }}</h6>
                <span class="attendance__severity" :class="`attendance__severity--${selectedRuleSetPreviewSeverity}`">
                  {{ formatPreviewSeverity(selectedRuleSetPreviewSeverity) }}
                </span>
              </div>
              <div class="attendance__preview-summary">
                <span>{{ tr('User', '用户') }}: <strong>{{ selectedRuleSetPreviewRow.userId || '--' }}</strong></span>
                <span>{{ tr('Work date', '工作日期') }}: <strong>{{ selectedRuleSetPreviewRow.workDate || '--' }}</strong></span>
                <span>{{ tr('Status', '状态') }}: <strong>{{ selectedRuleSetPreviewRow.status || '--' }}</strong></span>
                <span>{{ tr('Working day', '工作日') }}: <strong>{{ selectedRuleSetPreviewRow.isWorkingDay === false ? tr('No', '否') : tr('Yes', '是') }}</strong></span>
              </div>
              <div class="attendance__preview-scorecards">
                <div v-for="metric in selectedRuleSetPreviewMetrics" :key="metric.key" class="attendance__preview-scorecard">
                  <span>{{ metric.label }}</span>
                  <strong>{{ metric.value }}</strong>
                </div>
              </div>
              <div v-if="selectedRuleSetPreviewHints.length" class="attendance__preview-recommendations">
                <div
                  v-for="hint in selectedRuleSetPreviewHints"
                  :key="hint"
                  class="attendance__preview-recommendation attendance__preview-recommendation--info"
                >
                  <span>{{ hint }}</span>
                </div>
              </div>
              <div v-if="selectedRuleSetPreviewSource" class="attendance__preview-config-panels attendance__preview-config-panels--single">
                <div class="attendance__template-version-panel">
                  <div class="attendance__field-label">{{ tr('Rule source payload', '规则源诊断载荷') }}</div>
                  <small class="attendance__field-hint">
                    {{ tr('Raw row payload returned by preview for explanation and troubleshooting.', '预演返回的原始行载荷，可用于解释命中原因和排查规则问题。') }}
                  </small>
                  <pre class="attendance__code attendance__code--viewer">{{ formatJson(selectedRuleSetPreviewSource) }}</pre>
                </div>
              </div>
            </div>
          </div>
        </div>
      <label class="attendance__field attendance__field--full" for="attendance-rule-set-config">
        <span>{{ tr('Config (JSON)', '配置（JSON）') }}</span>
        <textarea
          id="attendance-rule-set-config"
          v-model="ruleSetForm.config"
          name="ruleSetConfig"
          rows="7"
          placeholder='{"source":"dingtalk","rule":{"timezone":"Asia/Shanghai","workStartTime":"09:00","workEndTime":"18:00","lateGraceMinutes":10,"earlyGraceMinutes":10,"workingDays":[1,2,3,4,5]}}'
        />
        <small class="attendance__field-hint">
          {{ tr('Advanced edits stay here. The builder above keeps this JSON synchronized with the structured fields.', '高级编辑仍在这里完成。上方构建器会与这些结构化字段保持同步。') }}
        </small>
        <small v-if="ruleBuilderConfigError" class="attendance__field-hint attendance__field-hint--error">
          {{ ruleBuilderConfigError }}
        </small>
      </label>
    </div>
    <div class="attendance__admin-actions">
      <button class="attendance__btn attendance__btn--primary" :disabled="ruleSetSaving" @click="saveRuleSet">
        {{ ruleSetSaving ? tr('Saving...', '保存中...') : ruleSetEditingId ? tr('Update rule set', '更新规则集') : tr('Create rule set', '创建规则集') }}
      </button>
      <button class="attendance__btn" :disabled="ruleSetSaving" @click="loadRuleSetTemplate">
        {{ tr('Load template', '加载模板') }}
      </button>
      <button v-if="ruleSetEditingId" class="attendance__btn" :disabled="ruleSetSaving" @click="resetRuleSetForm">
        {{ tr('Cancel edit', '取消编辑') }}
      </button>
    </div>
    <div v-if="ruleSets.length === 0" class="attendance__empty">{{ tr('No rule sets yet.', '暂无规则集。') }}</div>
    <div v-else class="attendance__table-wrapper">
      <table class="attendance__table">
        <thead>
          <tr>
            <th>{{ tr('Name', '名称') }}</th>
            <th>{{ tr('Scope', '范围') }}</th>
            <th>{{ tr('Version', '版本') }}</th>
            <th>{{ tr('Default', '默认') }}</th>
            <th>{{ tr('Actions', '操作') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in ruleSets" :key="item.id">
            <td>{{ item.name }}</td>
            <td>{{ item.scope }}</td>
            <td>{{ item.version }}</td>
            <td>{{ item.isDefault ? tr('Yes', '是') : tr('No', '否') }}</td>
            <td class="attendance__table-actions">
              <button class="attendance__btn" @click="editRuleSet(item)">{{ tr('Edit', '编辑') }}</button>
              <button class="attendance__btn attendance__btn--danger" @click="deleteRuleSet(item.id)">
                {{ tr('Delete', '删除') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="attendance__admin-section">
    <div class="attendance__admin-section-header">
      <h4>{{ tr('Rule Template Library', '规则模板库') }}</h4>
      <button
        class="attendance__btn"
        :disabled="ruleTemplateLoading || ruleTemplateSaving || ruleTemplateRestoring"
        @click="loadRuleTemplates"
      >
        {{ ruleTemplateLoading ? tr('Loading...', '加载中...') : tr('Reload templates', '重载模板') }}
      </button>
    </div>
    <div class="attendance__admin-grid">
      <label class="attendance__field attendance__field--full" for="attendance-rule-template-system">
        <span>{{ tr('System templates (read-only)', '系统模板（只读）') }}</span>
        <textarea
          id="attendance-rule-template-system"
          v-model="ruleTemplateSystemText"
          name="ruleTemplateSystem"
          rows="14"
          readonly
        />
        <small class="attendance__field-hint">
          {{ tr('Reference only: these templates are generated by the system and cannot be edited here.', '仅供参考：这些模板由系统生成，不能在此直接修改。') }}
        </small>
      </label>
      <label class="attendance__field attendance__field--full" for="attendance-rule-template-library">
        <span>{{ tr('Library templates (JSON)', '库模板（JSON）') }}</span>
        <textarea
          id="attendance-rule-template-library"
          v-model="ruleTemplateLibraryText"
          name="ruleTemplateLibrary"
          rows="22"
          placeholder="[]"
        />
        <small class="attendance__field-hint">
          {{ tr('Edit the JSON array of templates here, then save to update the editable library.', '在此编辑模板 JSON 数组，然后保存到可编辑模板库。') }}
        </small>
      </label>
    </div>
    <div class="attendance__admin-actions">
      <button class="attendance__btn" :disabled="ruleTemplateSaving || ruleTemplateRestoring" @click="copySystemTemplates">
        {{ tr('Copy system to library', '复制系统模板到库') }}
      </button>
      <button
        class="attendance__btn attendance__btn--primary"
        :disabled="ruleTemplateSaving || ruleTemplateRestoring"
        @click="saveRuleTemplates"
      >
        {{ ruleTemplateSaving ? tr('Saving...', '保存中...') : tr('Save library', '保存模板库') }}
      </button>
    </div>
    <div class="attendance__admin-subsection">
      <div class="attendance__admin-section-header">
        <h5>{{ tr('Template Versions', '模板版本') }}</h5>
        <small class="attendance__field-hint">
          {{ tr('Click View to inspect a historical snapshot before restoring it.', '点击“查看”即可打开历史快照，再决定是否恢复。') }}
        </small>
      </div>
      <div v-if="ruleTemplateVersions.length === 0" class="attendance__empty">{{ tr('No versions yet.', '暂无版本。') }}</div>
      <div v-else class="attendance__table-wrapper">
        <table class="attendance__table">
          <thead>
            <tr>
              <th>{{ tr('Version', '版本') }}</th>
              <th>{{ tr('Items', '条目') }}</th>
              <th>{{ tr('Created', '创建时间') }}</th>
              <th>{{ tr('Created by', '创建人') }}</th>
              <th>{{ tr('Actions', '操作') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="version in ruleTemplateVersions" :key="version.id">
              <td>{{ version.version }}</td>
              <td>{{ version.itemCount ?? '--' }}</td>
              <td>{{ formatDateTime(version.createdAt ?? null) }}</td>
              <td>{{ version.createdBy || '--' }}</td>
              <td class="attendance__table-actions">
                <button class="attendance__btn" :disabled="ruleTemplateVersionLoading" @click="openRuleTemplateVersion(version.id)">
                  {{ ruleTemplateVersionLoading && selectedRuleTemplateVersion && selectedRuleTemplateVersion.id === version.id ? tr('Loading...', '加载中...') : tr('View', '查看') }}
                </button>
                <button
                  class="attendance__btn"
                  :disabled="ruleTemplateRestoring || ruleTemplateSaving"
                  @click="restoreRuleTemplates(version.id)"
                >
                  {{ tr('Restore', '恢复') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="selectedRuleTemplateVersion" class="attendance__template-version-panel">
        <div class="attendance__admin-section-header">
          <h5>{{ tr('Selected version', '已选版本') }} #{{ selectedRuleTemplateVersion.version }}</h5>
          <button class="attendance__btn" @click="closeRuleTemplateVersionView">{{ tr('Close', '关闭') }}</button>
        </div>
        <div class="attendance__template-version-meta">
          <span>{{ tr('Created', '创建时间') }}: {{ formatDateTime(selectedRuleTemplateVersion.createdAt ?? null) }}</span>
          <span>{{ tr('Created by', '创建人') }}: {{ selectedRuleTemplateVersion.createdBy || '--' }}</span>
          <span>{{ tr('Items', '条目') }}: {{ selectedRuleTemplateVersion.itemCount ?? '--' }}</span>
          <span>{{ tr('Source version', '来源版本') }}: {{ selectedRuleTemplateVersion.sourceVersionId || '--' }}</span>
        </div>
        <pre class="attendance__code attendance__code--viewer">{{ formatJson(selectedRuleTemplateVersion.templates ?? selectedRuleTemplateVersion) }}</pre>
      </div>
    </div>
  </div>

  <div class="attendance__admin-section">
    <div class="attendance__admin-section-header">
      <h4>{{ tr('Attendance groups', '考勤组') }}</h4>
      <button class="attendance__btn" :disabled="attendanceGroupLoading" @click="loadAttendanceGroups">
        {{ attendanceGroupLoading ? tr('Loading...', '加载中...') : tr('Reload groups', '重载分组') }}
      </button>
    </div>
    <div class="attendance__admin-grid">
      <label class="attendance__field" for="attendance-group-name">
        <span>{{ tr('Name', '名称') }}</span>
        <input id="attendance-group-name" v-model="attendanceGroupForm.name" type="text" />
      </label>
      <label class="attendance__field" for="attendance-group-code">
        <span>{{ tr('Code', '编码') }}</span>
        <input
          id="attendance-group-code"
          v-model="attendanceGroupForm.code"
          type="text"
          :placeholder="tr('Auto-generated from name', '名称自动生成')"
        />
      </label>
      <label class="attendance__field" for="attendance-group-timezone">
        <span>{{ tr('Timezone', '时区') }}</span>
        <select id="attendance-group-timezone" v-model="attendanceGroupForm.timezone">
          <option v-for="timezone in attendanceGroupTimezones" :key="timezone" :value="timezone">
            {{ timezone }}
          </option>
        </select>
      </label>
      <label class="attendance__field" for="attendance-group-rule-set">
        <span>{{ tr('Rule set', '规则集') }}</span>
        <select
          id="attendance-group-rule-set"
          v-model="attendanceGroupForm.ruleSetId"
          :disabled="ruleSets.length === 0"
        >
          <option value="">{{ tr('(Optional) Use default rule', '（可选）使用默认规则') }}</option>
          <option v-for="item in ruleSets" :key="item.id" :value="item.id">
            {{ item.name }}
          </option>
        </select>
      </label>
      <label class="attendance__field attendance__field--full" for="attendance-group-description">
        <span>{{ tr('Description', '描述') }}</span>
        <input id="attendance-group-description" v-model="attendanceGroupForm.description" type="text" />
      </label>
    </div>
    <div class="attendance__admin-actions">
      <button class="attendance__btn attendance__btn--primary" :disabled="attendanceGroupSaving" @click="saveAttendanceGroup">
        {{ attendanceGroupSaving ? tr('Saving...', '保存中...') : attendanceGroupEditingId ? tr('Update group', '更新分组') : tr('Create group', '创建分组') }}
      </button>
      <button class="attendance__btn" :disabled="attendanceGroupSaving" @click="resetAttendanceGroupForm">
        {{ tr('Reset', '重置') }}
      </button>
    </div>
    <div v-if="attendanceGroups.length === 0" class="attendance__empty">{{ tr('No attendance groups.', '暂无考勤组。') }}</div>
    <div v-else class="attendance__table-wrapper">
      <table class="attendance__table">
        <thead>
          <tr>
            <th>{{ tr('Name', '名称') }}</th>
            <th>{{ tr('Code', '编码') }}</th>
            <th>{{ tr('Timezone', '时区') }}</th>
            <th>{{ tr('Rule set', '规则集') }}</th>
            <th>{{ tr('Actions', '操作') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in attendanceGroups" :key="item.id">
            <td>{{ item.name }}</td>
            <td>{{ item.code || '-' }}</td>
            <td>{{ item.timezone }}</td>
            <td>{{ resolveRuleSetName(item.ruleSetId) }}</td>
            <td class="attendance__table-actions">
              <button class="attendance__btn" @click="editAttendanceGroup(item)">{{ tr('Edit', '编辑') }}</button>
              <button class="attendance__btn attendance__btn--danger" @click="deleteAttendanceGroup(item.id)">
                {{ tr('Delete', '删除') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="attendance__admin-section">
    <div class="attendance__admin-section-header">
      <h4>{{ tr('Group members', '分组成员') }}</h4>
      <button class="attendance__btn" :disabled="attendanceGroupMemberLoading" @click="loadAttendanceGroupMembers">
        {{ attendanceGroupMemberLoading ? tr('Loading...', '加载中...') : tr('Reload members', '重载成员') }}
      </button>
    </div>
    <div class="attendance__admin-grid">
      <label class="attendance__field" for="attendance-group-member-group">
        <span>{{ tr('Group', '分组') }}</span>
        <select
          id="attendance-group-member-group"
          v-model="attendanceGroupMemberGroupId"
          :disabled="attendanceGroups.length === 0"
        >
          <option value="">{{ tr('Select a group', '选择分组') }}</option>
          <option v-for="group in attendanceGroups" :key="group.id" :value="group.id">
            {{ group.name }}
          </option>
        </select>
      </label>
      <AttendanceUserPickerField
        v-model="attendanceGroupMemberSelectedUserId"
        :tr="tr"
        :label="tr('User picker', '用户选择器')"
        name="attendanceGroupMemberUserPicker"
        :help-text="tr('Pick one user and append it to the bulk list below, or type multiple IDs manually.', '先选一个用户再追加到下方批量列表，也可以直接手动输入多个 ID。')"
        :search-placeholder="tr('Search users to append', '搜索要追加的用户')"
        :full-width="false"
        input-id="attendance-group-member-user-picker"
      />
      <label class="attendance__field attendance__field--full" for="attendance-group-member-user-ids">
        <span>{{ tr('User IDs (bulk)', '用户 ID（批量）') }}</span>
        <input
          id="attendance-group-member-user-ids"
          v-model="attendanceGroupMemberUserIds"
          type="text"
          :placeholder="tr('userId1, userId2', 'userId1, userId2')"
        />
        <small class="attendance__field-hint">{{ tr('Separate multiple IDs with commas or spaces. The picker above can append one selected user at a time.', '多个 ID 请用逗号或空格分隔。上方选择器可一次追加一个用户。') }}</small>
      </label>
    </div>
    <div class="attendance__admin-actions">
      <button
        class="attendance__btn"
        :disabled="attendanceGroupMemberSaving || !attendanceGroupMemberSelectedUserId"
        @click="appendAttendanceGroupMemberSelectedUser"
      >
        {{ tr('Append selected user', '追加所选用户') }}
      </button>
      <button
        class="attendance__btn attendance__btn--primary"
        :disabled="attendanceGroupMemberSaving"
        @click="addAttendanceGroupMembers"
      >
        {{ attendanceGroupMemberSaving ? tr('Saving...', '保存中...') : tr('Add members', '添加成员') }}
      </button>
    </div>
    <div v-if="attendanceGroupMembers.length === 0" class="attendance__empty">{{ tr('No group members yet.', '暂无分组成员。') }}</div>
    <div v-else class="attendance__table-wrapper">
      <table class="attendance__table">
        <thead>
          <tr>
            <th>{{ tr('User ID', '用户 ID') }}</th>
            <th>{{ tr('Joined', '加入时间') }}</th>
            <th>{{ tr('Actions', '操作') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="member in attendanceGroupMembers" :key="member.id">
            <td>{{ member.userId }}</td>
            <td>{{ formatDateTime(member.createdAt ?? null) }}</td>
            <td class="attendance__table-actions">
              <button
                class="attendance__btn attendance__btn--danger"
                :disabled="attendanceGroupMemberSaving"
                @click="removeAttendanceGroupMember(member.userId)"
              >
                {{ tr('Remove', '移除') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, type Ref } from 'vue'
import {
  buildRuleSetPreviewRecommendations,
  summarizeRuleSetPreviewResult,
} from './useAttendanceAdminRulesAndGroups'
import type {
  AttendanceGroup,
  AttendanceGroupMember,
  AttendanceRuleBuilderState,
  AttendanceRuleSetPreviewItem,
  AttendanceRuleSet,
  AttendanceRuleSetPreviewRecommendation,
  AttendanceRuleSetPreviewSummary,
  AttendanceRuleTemplateVersion,
} from './useAttendanceAdminRulesAndGroups'
import AttendanceUserPickerField from './AttendanceUserPickerField.vue'
import { buildTimezoneOptions } from './attendanceTimezones'

type Translate = (en: string, zh: string) => string
type MaybePromise<T> = T | Promise<T>

interface RuleSetFormState {
  name: string
  description: string
  version: number
  scope: string
  isDefault: boolean
  config: string
}

interface AttendanceGroupFormState {
  name: string
  code: string
  timezone: string
  ruleSetId: string
  description: string
}

interface RuleSetPreviewRow {
  userId: string
  workDate: string
  firstInAt?: string | null
  lastOutAt?: string | null
  workMinutes?: number
  lateMinutes?: number
  earlyLeaveMinutes?: number
  status?: string
  isWorkingDay?: boolean
  source?: unknown
}

interface RuleSetPreviewResult {
  ruleSetId?: string | null
  totalEvents?: number
  preview?: RuleSetPreviewRow[]
  rows?: RuleSetPreviewRow[]
  config?: Record<string, unknown> | null
  notes?: string[]
}

interface PreviewEventDraft {
  id: string
  eventType: 'check_in' | 'check_out'
  occurredAt: string
  workDate: string
  userId: string
}

interface PreviewConfigDiffLeaf {
  kind: 'added' | 'removed' | 'changed'
  path: string
  draftValue?: unknown
  resolvedValue?: unknown
}

interface PreviewConfigDiffItem {
  path: string
  label: string
  summary: string
  severity: 'info' | 'warning'
}

interface PreviewConfigDiffSummary {
  addedCount: number
  removedCount: number
  changedCount: number
  totalChanges: number
  items: PreviewConfigDiffItem[]
}

interface RulesAndGroupsBindings {
  attendanceGroupEditingId: Ref<string | null>
  attendanceGroupForm: AttendanceGroupFormState
  attendanceGroupLoading: Ref<boolean>
  attendanceGroupMemberGroupId: Ref<string>
  attendanceGroupMemberLoading: Ref<boolean>
  attendanceGroupMemberSaving: Ref<boolean>
  attendanceGroupMemberUserIds: Ref<string>
  attendanceGroupMembers: Ref<AttendanceGroupMember[]>
  attendanceGroupSaving: Ref<boolean>
  attendanceGroups: Ref<AttendanceGroup[]>
  copySystemTemplates: () => MaybePromise<void>
  deleteAttendanceGroup: (id: string) => MaybePromise<void>
  deleteRuleSet: (id: string) => MaybePromise<void>
  editAttendanceGroup: (item: AttendanceGroup) => MaybePromise<void>
  editRuleSet: (item: AttendanceRuleSet) => MaybePromise<void>
  loadAttendanceGroupMembers: () => MaybePromise<void>
  loadAttendanceGroups: () => MaybePromise<void>
  loadRuleSetTemplate: () => MaybePromise<void>
  loadRuleSets: () => MaybePromise<void>
  loadRuleTemplates: () => MaybePromise<void>
  addAttendanceGroupMembers: () => MaybePromise<void>
  removeAttendanceGroupMember: (userId: string) => MaybePromise<void>
  resetAttendanceGroupForm: () => MaybePromise<void>
  resetRuleSetForm: () => MaybePromise<void>
  closeRuleTemplateVersionView: () => MaybePromise<void>
  resolveRuleSetName: (ruleSetId?: string | null) => string
  restoreRuleTemplates: (versionId: string) => MaybePromise<void>
  openRuleTemplateVersion: (versionId: string) => MaybePromise<void>
  ruleTemplateVersionLoading: Ref<boolean>
  selectedRuleTemplateVersion: Ref<AttendanceRuleTemplateVersion | null>
  ruleSetEditingId: Ref<string | null>
  ruleSetForm: RuleSetFormState
  ruleSetLoading: Ref<boolean>
  ruleSetSaving: Ref<boolean>
  ruleSets: Ref<AttendanceRuleSet[]>
  ruleTemplateLibraryText: Ref<string>
  ruleTemplateLoading: Ref<boolean>
  ruleTemplateRestoring: Ref<boolean>
  ruleTemplateSaving: Ref<boolean>
  ruleTemplateSystemText: Ref<string>
  ruleTemplateVersions: Ref<AttendanceRuleTemplateVersion[]>
  ruleBuilderSource?: Ref<string>
  ruleBuilderTimezone?: Ref<string>
  ruleBuilderWorkStartTime?: Ref<string>
  ruleBuilderWorkEndTime?: Ref<string>
  ruleBuilderLateGraceMinutes?: Ref<number>
  ruleBuilderEarlyGraceMinutes?: Ref<number>
  ruleBuilderWorkingDays?: Ref<string>
  ruleSetPreviewLoading?: Ref<boolean>
  ruleSetPreviewError?: Ref<string>
  ruleSetPreviewEventsText?: Ref<string>
  ruleSetPreviewResult?: Ref<RuleSetPreviewResult | null>
  previewRuleSet?: () => MaybePromise<void>
  resetRuleBuilder?: () => MaybePromise<void>
  saveAttendanceGroup: () => MaybePromise<void>
  saveRuleSet: () => MaybePromise<void>
  saveRuleTemplates: () => MaybePromise<void>
}

const props = defineProps<{
  tr: Translate
  rules: RulesAndGroupsBindings
  formatDateTime: (value: string | null | undefined) => string
}>()

const tr = props.tr
const formatDateTime = props.formatDateTime
const attendanceGroupEditingId = props.rules.attendanceGroupEditingId
const attendanceGroupForm = props.rules.attendanceGroupForm
const attendanceGroupTimezones = computed(() => buildTimezoneOptions(attendanceGroupForm.timezone))
const attendanceGroupLoading = props.rules.attendanceGroupLoading
const attendanceGroupMemberGroupId = props.rules.attendanceGroupMemberGroupId
const attendanceGroupMemberLoading = props.rules.attendanceGroupMemberLoading
const attendanceGroupMemberSaving = props.rules.attendanceGroupMemberSaving
const attendanceGroupMemberUserIds = props.rules.attendanceGroupMemberUserIds
const attendanceGroupMembers = props.rules.attendanceGroupMembers
const attendanceGroupMemberSelectedUserId = ref('')
const attendanceGroupSaving = props.rules.attendanceGroupSaving
const attendanceGroups = props.rules.attendanceGroups
const copySystemTemplates = () => props.rules.copySystemTemplates()
const deleteAttendanceGroup = (id: string) => props.rules.deleteAttendanceGroup(id)
const deleteRuleSet = (id: string) => props.rules.deleteRuleSet(id)
const editAttendanceGroup = (item: AttendanceGroup) => props.rules.editAttendanceGroup(item)
const editRuleSet = (item: AttendanceRuleSet) => props.rules.editRuleSet(item)
const loadAttendanceGroupMembers = () => props.rules.loadAttendanceGroupMembers()
const loadAttendanceGroups = () => props.rules.loadAttendanceGroups()
const loadRuleSetTemplate = () => props.rules.loadRuleSetTemplate()
const loadRuleSets = () => props.rules.loadRuleSets()
const loadRuleTemplates = () => props.rules.loadRuleTemplates()
const addAttendanceGroupMembers = () => props.rules.addAttendanceGroupMembers()
const removeAttendanceGroupMember = (userId: string) => props.rules.removeAttendanceGroupMember(userId)
const resetAttendanceGroupForm = () => props.rules.resetAttendanceGroupForm()
const resetRuleSetForm = () => props.rules.resetRuleSetForm()
const closeRuleTemplateVersionView = () => props.rules.closeRuleTemplateVersionView()
const resolveRuleSetName = props.rules.resolveRuleSetName
const restoreRuleTemplates = (versionId: string) => props.rules.restoreRuleTemplates(versionId)
const openRuleTemplateVersion = (versionId: string) => props.rules.openRuleTemplateVersion(versionId)
const selectedRuleTemplateVersion = props.rules.selectedRuleTemplateVersion
const ruleSetEditingId = props.rules.ruleSetEditingId
const ruleSetForm = props.rules.ruleSetForm
const ruleSetLoading = props.rules.ruleSetLoading
const ruleSetSaving = props.rules.ruleSetSaving
const ruleSets = props.rules.ruleSets
const ruleTemplateLibraryText = props.rules.ruleTemplateLibraryText
const ruleTemplateLoading = props.rules.ruleTemplateLoading
const ruleTemplateRestoring = props.rules.ruleTemplateRestoring
const ruleTemplateSaving = props.rules.ruleTemplateSaving
const ruleTemplateSystemText = props.rules.ruleTemplateSystemText
const ruleTemplateVersionLoading = props.rules.ruleTemplateVersionLoading
const ruleTemplateVersions = props.rules.ruleTemplateVersions
const localRuleBuilderSource = ref('')
const localRuleBuilderTimezone = ref('')
const localRuleBuilderWorkStartTime = ref('09:00')
const localRuleBuilderWorkEndTime = ref('18:00')
const localRuleBuilderLateGraceMinutes = ref(10)
const localRuleBuilderEarlyGraceMinutes = ref(10)
const localRuleBuilderWorkingDays = ref('1, 2, 3, 4, 5')
const localRuleSetPreviewLoading = ref(false)
const localRuleSetPreviewError = ref('')
const localRuleSetPreviewEventsText = ref('[]')
const localRuleSetPreviewResult = ref<RuleSetPreviewResult | null>(null)
const ruleBuilderSource = props.rules.ruleBuilderSource ?? localRuleBuilderSource
const ruleBuilderTimezone = props.rules.ruleBuilderTimezone ?? localRuleBuilderTimezone
const ruleBuilderWorkStartTime = props.rules.ruleBuilderWorkStartTime ?? localRuleBuilderWorkStartTime
const ruleBuilderWorkEndTime = props.rules.ruleBuilderWorkEndTime ?? localRuleBuilderWorkEndTime
const ruleBuilderLateGraceMinutes = props.rules.ruleBuilderLateGraceMinutes ?? localRuleBuilderLateGraceMinutes
const ruleBuilderEarlyGraceMinutes = props.rules.ruleBuilderEarlyGraceMinutes ?? localRuleBuilderEarlyGraceMinutes
const ruleBuilderWorkingDaysText = props.rules.ruleBuilderWorkingDays ?? localRuleBuilderWorkingDays
const ruleSetPreviewLoading = props.rules.ruleSetPreviewLoading ?? localRuleSetPreviewLoading
const ruleSetPreviewError = props.rules.ruleSetPreviewError ?? localRuleSetPreviewError
const ruleSetPreviewEventsText = props.rules.ruleSetPreviewEventsText ?? localRuleSetPreviewEventsText
const ruleSetPreviewResult = props.rules.ruleSetPreviewResult ?? localRuleSetPreviewResult
const previewRuleSet = props.rules.previewRuleSet
const resetRuleBuilder = props.rules.resetRuleBuilder
const saveAttendanceGroup = () => props.rules.saveAttendanceGroup()
const saveRuleSet = () => props.rules.saveRuleSet()
const saveRuleTemplates = () => props.rules.saveRuleTemplates()

const weekdayLabels = computed(() => [
  tr('Sun', '周日'),
  tr('Mon', '周一'),
  tr('Tue', '周二'),
  tr('Wed', '周三'),
  tr('Thu', '周四'),
  tr('Fri', '周五'),
  tr('Sat', '周六'),
])

const ruleBuilderDayOptions = computed(() => [
  { value: 0, labelEn: 'Sun', labelZh: '周日' },
  { value: 1, labelEn: 'Mon', labelZh: '周一' },
  { value: 2, labelEn: 'Tue', labelZh: '周二' },
  { value: 3, labelEn: 'Wed', labelZh: '周三' },
  { value: 4, labelEn: 'Thu', labelZh: '周四' },
  { value: 5, labelEn: 'Fri', labelZh: '周五' },
  { value: 6, labelEn: 'Sat', labelZh: '周六' },
])

const ruleBuilderHydrated = ref(false)
const ruleBuilderSyncing = ref(false)
const ruleBuilderConfigError = ref('')
const previewEventDrafts = ref<PreviewEventDraft[]>([])
const activePreviewScenarioId = ref('')
const selectedRuleSetPreviewRowKey = ref('')

function asPlainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseRuleSetConfig(value: string): Record<string, unknown> | null {
  const trimmed = value.trim()
  if (!trimmed) return {}
  try {
    const parsed = JSON.parse(trimmed)
    return asPlainObject(parsed)
  } catch {
    return null
  }
}

function normalizeInteger(value: unknown, fallback: number): number {
  const normalized = Number(value)
  return Number.isFinite(normalized) && normalized >= 0 ? Math.floor(normalized) : fallback
}

function flattenConfigEntries(value: unknown, basePath = ''): Array<{ path: string; value: unknown }> {
  if (Array.isArray(value) || !isPlainObject(value)) {
    return basePath ? [{ path: basePath, value }] : []
  }

  const keys = Object.keys(value).sort()
  if (keys.length === 0) {
    return basePath ? [{ path: basePath, value: {} }] : []
  }

  return keys.flatMap((key) => {
    const nextPath = basePath ? `${basePath}.${key}` : key
    const nextValue = value[key]
    if (Array.isArray(nextValue) || !isPlainObject(nextValue)) {
      return [{ path: nextPath, value: nextValue }]
    }
    return flattenConfigEntries(nextValue, nextPath)
  })
}

function formatDiffValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  if (value === undefined) return '--'
  return JSON.stringify(value)
}

function formatDiffLabel(path: string): string {
  const parts = path.split('.').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function buildPreviewConfigDiffSummary(
  draftConfig: Record<string, unknown>,
  resolvedConfig: Record<string, unknown> | null,
): PreviewConfigDiffSummary | null {
  if (!resolvedConfig) return null

  const draftEntries = new Map(flattenConfigEntries(draftConfig).map((entry) => [entry.path, entry.value]))
  const resolvedEntries = new Map(flattenConfigEntries(resolvedConfig).map((entry) => [entry.path, entry.value]))
  const allPaths = Array.from(new Set([...draftEntries.keys(), ...resolvedEntries.keys()])).sort()

  const leaves: PreviewConfigDiffLeaf[] = []
  for (const path of allPaths) {
    const hasDraft = draftEntries.has(path)
    const hasResolved = resolvedEntries.has(path)
    if (!hasDraft && hasResolved) {
      leaves.push({ kind: 'added', path, resolvedValue: resolvedEntries.get(path) })
      continue
    }
    if (hasDraft && !hasResolved) {
      leaves.push({ kind: 'removed', path, draftValue: draftEntries.get(path) })
      continue
    }

    const draftValue = draftEntries.get(path)
    const resolvedValue = resolvedEntries.get(path)
    if (JSON.stringify(draftValue) !== JSON.stringify(resolvedValue)) {
      leaves.push({ kind: 'changed', path, draftValue, resolvedValue })
    }
  }

  const items = leaves.map((item) => {
    if (item.kind === 'added') {
      return {
        path: item.path,
        label: tr('Added default', '新增默认值'),
        summary: tr(
          `Resolved config added ${formatDiffLabel(item.path)} = ${formatDiffValue(item.resolvedValue)}.`,
          `生效配置新增了 ${formatDiffLabel(item.path)} = ${formatDiffValue(item.resolvedValue)}。`,
        ),
        severity: 'info' as const,
      }
    }
    if (item.kind === 'removed') {
      return {
        path: item.path,
        label: tr('Removed during normalization', '归一化后移除'),
        summary: tr(
          `Draft value ${formatDiffLabel(item.path)} = ${formatDiffValue(item.draftValue)} was not kept in resolved config.`,
          `草稿中的 ${formatDiffLabel(item.path)} = ${formatDiffValue(item.draftValue)} 未保留在生效配置中。`,
        ),
        severity: 'warning' as const,
      }
    }
    return {
      path: item.path,
      label: tr('Resolved value changed', '生效值被改写'),
      summary: tr(
        `${formatDiffLabel(item.path)} changed from ${formatDiffValue(item.draftValue)} to ${formatDiffValue(item.resolvedValue)}.`,
        `${formatDiffLabel(item.path)} 从 ${formatDiffValue(item.draftValue)} 变为 ${formatDiffValue(item.resolvedValue)}。`,
      ),
      severity: 'warning' as const,
    }
  })

  return {
    addedCount: leaves.filter((item) => item.kind === 'added').length,
    removedCount: leaves.filter((item) => item.kind === 'removed').length,
    changedCount: leaves.filter((item) => item.kind === 'changed').length,
    totalChanges: leaves.length,
    items,
  }
}

function normalizeWorkingDays(value: unknown): number[] {
  const source = Array.isArray(value)
    ? value
    : String(value ?? '')
      .split(/[\n,，\s]+/)
      .map((item) => item.trim())
      .filter(Boolean)
  return Array.from(new Set(
    source
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item >= 0 && item <= 6),
  )).sort((left, right) => left - right)
}

function formatWorkingDaysInput(value: unknown): string {
  return normalizeWorkingDays(value).join(', ')
}

function formatWorkingDays(days: number[] | null | undefined): string {
  const normalized = normalizeWorkingDays(days)
  if (normalized.length === 0) return tr('Not set', '未设置')
  return normalized
    .map((day) => weekdayLabels.value[day] ?? String(day))
    .join(', ')
}

const ruleBuilderWorkingDays = computed<number[]>({
  get: () => normalizeWorkingDays(ruleBuilderWorkingDaysText.value),
  set: (days) => {
    ruleBuilderWorkingDaysText.value = formatWorkingDaysInput(days)
  },
})

function buildRuleSetPreviewConfig(): Record<string, unknown> {
  const parsed = parseRuleSetConfig(ruleSetForm.config) ?? {}
  const next = { ...parsed }
  const source = ruleBuilderSource.value.trim()
  if (source) next.source = source
  else delete next.source

  const ruleConfig = asPlainObject(next.rule)
  const rule = ruleConfig ? { ...(ruleConfig as Record<string, unknown>) } : {}
  const timezone = ruleBuilderTimezone.value.trim()
  if (timezone) rule.timezone = timezone
  else delete rule.timezone

  const workStartTime = ruleBuilderWorkStartTime.value.trim()
  if (workStartTime) rule.workStartTime = workStartTime
  else delete rule.workStartTime

  const workEndTime = ruleBuilderWorkEndTime.value.trim()
  if (workEndTime) rule.workEndTime = workEndTime
  else delete rule.workEndTime

  const lateGraceMinutes = normalizeInteger(ruleBuilderLateGraceMinutes.value, 10)
  rule.lateGraceMinutes = lateGraceMinutes

  const earlyGraceMinutes = normalizeInteger(ruleBuilderEarlyGraceMinutes.value, 10)
  rule.earlyGraceMinutes = earlyGraceMinutes

  const workingDays = normalizeWorkingDays(ruleBuilderWorkingDaysText.value)
  if (workingDays.length > 0) {
    rule.workingDays = workingDays
  } else {
    delete rule.workingDays
  }

  if (Object.keys(rule).length > 0) {
    next.rule = rule
  } else {
    delete next.rule
  }

  return next
}

function syncRuleBuilderFromConfig(value: string) {
  const parsed = parseRuleSetConfig(value)
  if (parsed === null) {
    ruleBuilderConfigError.value = tr('Rule set config must be valid JSON.', '规则集配置必须是合法 JSON。')
    return
  }

  ruleBuilderConfigError.value = ''
  const rule = asPlainObject(parsed.rule)
  ruleBuilderSource.value = typeof parsed.source === 'string' ? parsed.source : ''
  ruleBuilderTimezone.value = typeof rule?.timezone === 'string' ? rule.timezone : ''
  ruleBuilderWorkStartTime.value = typeof rule?.workStartTime === 'string' ? rule.workStartTime : '09:00'
  ruleBuilderWorkEndTime.value = typeof rule?.workEndTime === 'string' ? rule.workEndTime : '18:00'
  ruleBuilderLateGraceMinutes.value = normalizeInteger(rule?.lateGraceMinutes, 10)
  ruleBuilderEarlyGraceMinutes.value = normalizeInteger(rule?.earlyGraceMinutes, 10)
  ruleBuilderWorkingDaysText.value = formatWorkingDaysInput(rule?.workingDays)
}

function syncRuleSetConfigFromBuilder() {
  if (!ruleBuilderHydrated.value || ruleBuilderSyncing.value) return
  ruleBuilderSyncing.value = true
  try {
    const nextConfig = JSON.stringify(buildRuleSetPreviewConfig(), null, 2)
    if (nextConfig !== ruleSetForm.config) {
      ruleSetForm.config = nextConfig
    }
  } finally {
    ruleBuilderSyncing.value = false
    ruleBuilderConfigError.value = ''
  }
}

function resolveRuleSetPreviewRows(result: RuleSetPreviewResult | null | undefined): RuleSetPreviewRow[] {
  if (!result) return []
  if (Array.isArray(result.preview)) return result.preview
  if (Array.isArray(result.rows)) return result.rows
  return []
}

function createPreviewEventDraft(overrides: Partial<PreviewEventDraft> = {}): PreviewEventDraft {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const localIso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`
  return {
    id: `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    eventType: 'check_in',
    occurredAt: localIso,
    workDate: localIso.slice(0, 10),
    userId: '',
    ...overrides,
  }
}

function normalizePreviewEventDateTime(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return ''
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) {
    return text
  }
  const parsed = new Date(text.replace(' ', 'T'))
  if (Number.isNaN(parsed.getTime())) {
    return text
  }
  const pad = (input: number) => String(input).padStart(2, '0')
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
}

function normalizePreviewEventDraft(value: unknown): PreviewEventDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const eventType = item.eventType === 'check_out' ? 'check_out' : 'check_in'
  const occurredAt = normalizePreviewEventDateTime(item.occurredAt)
  if (!occurredAt) return null
  return {
    id: typeof item.id === 'string' && item.id.trim() ? item.id : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    eventType,
    occurredAt,
    workDate: typeof item.workDate === 'string' && item.workDate.trim() ? item.workDate.trim() : occurredAt.slice(0, 10),
    userId: typeof item.userId === 'string' ? item.userId.trim() : '',
  }
}

function parsePreviewEventDrafts(value: string): PreviewEventDraft[] | null {
  const trimmed = value.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    if (!Array.isArray(parsed)) return null
    const drafts = parsed.map((item) => normalizePreviewEventDraft(item))
    if (drafts.some((item) => item === null)) return null
    return drafts.filter((item): item is PreviewEventDraft => item !== null)
  } catch {
    return null
  }
}

function serializePreviewEventDrafts(items: PreviewEventDraft[]): string {
  return JSON.stringify(
    items.map((item) => ({
      eventType: item.eventType,
      occurredAt: item.occurredAt,
      workDate: item.workDate,
      userId: item.userId,
    })),
    null,
    2,
  )
}

function syncPreviewEventTextFromDrafts() {
  const serialized = serializePreviewEventDrafts(previewEventDrafts.value)
  if (serialized !== ruleSetPreviewEventsText.value) {
    ruleSetPreviewEventsText.value = serialized
  }
}

function addPreviewEvent() {
  previewEventDrafts.value = [...previewEventDrafts.value, createPreviewEventDraft()]
}

function duplicatePreviewEvent(index: number) {
  const source = previewEventDrafts.value[index]
  if (!source) return
  const next = createPreviewEventDraft({
    eventType: source.eventType,
    occurredAt: source.occurredAt,
    workDate: source.workDate,
    userId: source.userId,
  })
  previewEventDrafts.value = [
    ...previewEventDrafts.value.slice(0, index + 1),
    next,
    ...previewEventDrafts.value.slice(index + 1),
  ]
}

function removePreviewEvent(index: number) {
  previewEventDrafts.value = previewEventDrafts.value.filter((_, itemIndex) => itemIndex !== index)
}

function resetPreviewEvents() {
  previewEventDrafts.value = []
  activePreviewScenarioId.value = ''
  syncPreviewEventTextFromDrafts()
}

const previewScenarioOptions = [
  {
    id: 'onTime',
    labelEn: 'On-time day',
    labelZh: '准点工作日',
    descriptionEn: 'Baseline check-in and check-out on a scheduled workday.',
    descriptionZh: '在工作日生成基准上下班打卡。',
  },
  {
    id: 'lateArrival',
    labelEn: 'Late arrival',
    labelZh: '迟到场景',
    descriptionEn: 'Starts after the configured late grace.',
    descriptionZh: '在当前迟到宽限后再上班。',
  },
  {
    id: 'earlyLeave',
    labelEn: 'Early leave',
    labelZh: '早退场景',
    descriptionEn: 'Leaves before the configured early-leave grace.',
    descriptionZh: '在当前早退宽限前提前下班。',
  },
  {
    id: 'missingCheckOut',
    labelEn: 'Missing check-out',
    labelZh: '缺少下班卡',
    descriptionEn: 'Keeps only the check-in event to test missing-punch handling.',
    descriptionZh: '仅保留上班卡，测试缺卡处理。',
  },
  {
    id: 'restDayOvertime',
    labelEn: 'Rest-day overtime',
    labelZh: '休息日加班',
    descriptionEn: 'Simulates a full-day attendance on a non-working day.',
    descriptionZh: '在非工作日模拟全天打卡。',
  },
]

function padDatePart(value: number): string {
  return String(value).padStart(2, '0')
}

function formatDateOnly(date: Date): string {
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`
}

function parseTimeText(value: string, fallbackHour: number, fallbackMinute = 0): { hour: number; minute: number } {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!match) {
    return { hour: fallbackHour, minute: fallbackMinute }
  }
  return {
    hour: Math.min(23, Math.max(0, Number(match[1]))),
    minute: Math.min(59, Math.max(0, Number(match[2]))),
  }
}

function formatDateTimeLocal(date: Date): string {
  return `${formatDateOnly(date)}T${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}`
}

function withLocalTime(dateText: string, timeText: string, fallbackHour: number, fallbackMinute = 0): string {
  const base = /^\d{4}-\d{2}-\d{2}$/.test(dateText) ? dateText : formatDateOnly(new Date())
  const { hour, minute } = parseTimeText(timeText, fallbackHour, fallbackMinute)
  const date = new Date(`${base}T00:00`)
  date.setHours(hour, minute, 0, 0)
  return formatDateTimeLocal(date)
}

function shiftDateTimeLocal(value: string, minutes: number): string {
  const normalized = normalizePreviewEventDateTime(value)
  const date = new Date(normalized.replace('T', ' ') || value)
  if (Number.isNaN(date.getTime())) {
    return normalized
  }
  date.setMinutes(date.getMinutes() + minutes)
  return formatDateTimeLocal(date)
}

function isWorkingDayForDate(date: Date): boolean {
  return ruleBuilderWorkingDays.value.includes(date.getDay())
}

function resolveScenarioDate(kind: 'working' | 'rest'): string {
  const seed = previewEventDrafts.value[0]?.workDate
  const fallback = /^\d{4}-\d{2}-\d{2}$/.test(seed ?? '') ? new Date(`${seed}T00:00`) : new Date()
  for (let offset = 0; offset < 14; offset += 1) {
    const candidate = new Date(fallback)
    candidate.setDate(candidate.getDate() + offset)
    if (kind === 'working' && isWorkingDayForDate(candidate)) {
      return formatDateOnly(candidate)
    }
    if (kind === 'rest' && !isWorkingDayForDate(candidate)) {
      return formatDateOnly(candidate)
    }
  }
  return formatDateOnly(fallback)
}

function buildPreviewScenarioDrafts(kind: string): PreviewEventDraft[] {
  const userId = previewEventDrafts.value[0]?.userId || 'user-1'
  const workDate = kind === 'restDayOvertime' ? resolveScenarioDate('rest') : resolveScenarioDate('working')
  const startAt = withLocalTime(workDate, ruleBuilderWorkStartTime.value, 9, 0)
  const endAt = withLocalTime(workDate, ruleBuilderWorkEndTime.value, 18, 0)
  const lateShift = normalizeInteger(ruleBuilderLateGraceMinutes.value, 10) + 5
  const earlyShift = -1 * (normalizeInteger(ruleBuilderEarlyGraceMinutes.value, 10) + 15)

  switch (kind) {
    case 'lateArrival':
      return [
        createPreviewEventDraft({
          eventType: 'check_in',
          occurredAt: shiftDateTimeLocal(startAt, lateShift),
          workDate,
          userId,
        }),
        createPreviewEventDraft({
          eventType: 'check_out',
          occurredAt: endAt,
          workDate,
          userId,
        }),
      ]
    case 'earlyLeave':
      return [
        createPreviewEventDraft({
          eventType: 'check_in',
          occurredAt: startAt,
          workDate,
          userId,
        }),
        createPreviewEventDraft({
          eventType: 'check_out',
          occurredAt: shiftDateTimeLocal(endAt, earlyShift),
          workDate,
          userId,
        }),
      ]
    case 'missingCheckOut':
      return [
        createPreviewEventDraft({
          eventType: 'check_in',
          occurredAt: startAt,
          workDate,
          userId,
        }),
      ]
    case 'restDayOvertime':
      return [
        createPreviewEventDraft({
          eventType: 'check_in',
          occurredAt: withLocalTime(workDate, '10:00', 10, 0),
          workDate,
          userId,
        }),
        createPreviewEventDraft({
          eventType: 'check_out',
          occurredAt: withLocalTime(workDate, '18:30', 18, 30),
          workDate,
          userId,
        }),
      ]
    default:
      return [
        createPreviewEventDraft({
          eventType: 'check_in',
          occurredAt: startAt,
          workDate,
          userId,
        }),
        createPreviewEventDraft({
          eventType: 'check_out',
          occurredAt: endAt,
          workDate,
          userId,
        }),
      ]
  }
}

function applyPreviewScenario(kind: string) {
  activePreviewScenarioId.value = kind
  previewEventDrafts.value = buildPreviewScenarioDrafts(kind)
}

const ruleBuilderPreviewConfig = computed(() => buildRuleSetPreviewConfig())
const ruleSetPreviewRows = computed(() => resolveRuleSetPreviewRows(ruleSetPreviewResult.value))
const normalizedRuleSetPreviewRows = computed<AttendanceRuleSetPreviewItem[]>(() => (
  ruleSetPreviewRows.value.map((row) => ({
    userId: row.userId || 'unknown',
    workDate: row.workDate || '',
    firstInAt: row.firstInAt ?? null,
    lastOutAt: row.lastOutAt ?? null,
    workMinutes: normalizeInteger(row.workMinutes, 0),
    lateMinutes: normalizeInteger(row.lateMinutes, 0),
    earlyLeaveMinutes: normalizeInteger(row.earlyLeaveMinutes, 0),
    status: String(row.status ?? 'unknown'),
    isWorkingDay: row.isWorkingDay,
    source: row.source,
  }))
))
const ruleSetPreviewNotes = computed(() => ruleSetPreviewResult.value?.notes ?? [])
const previewScenarioPresets = computed(() => previewScenarioOptions)
const ruleSetPreviewSummary = computed<AttendanceRuleSetPreviewSummary>(() => summarizeRuleSetPreviewResult({
  ruleSetId: ruleSetPreviewResult.value?.ruleSetId ?? null,
  totalEvents: ruleSetPreviewResult.value?.totalEvents ?? previewEventDrafts.value.length,
  preview: normalizedRuleSetPreviewRows.value,
  config: ruleBuilderPreviewConfig.value,
  notes: ruleSetPreviewNotes.value,
}))
const ruleBuilderState = computed<AttendanceRuleBuilderState>(() => ({
  source: ruleBuilderSource.value,
  timezone: ruleBuilderTimezone.value,
  workStartTime: ruleBuilderWorkStartTime.value,
  workEndTime: ruleBuilderWorkEndTime.value,
  lateGraceMinutes: normalizeInteger(ruleBuilderLateGraceMinutes.value, 10),
  earlyGraceMinutes: normalizeInteger(ruleBuilderEarlyGraceMinutes.value, 10),
  workingDays: ruleBuilderWorkingDaysText.value,
}))
const rulePreviewRecommendations = computed<AttendanceRuleSetPreviewRecommendation[]>(() => buildRuleSetPreviewRecommendations({
  ruleSetId: ruleSetPreviewResult.value?.ruleSetId ?? null,
  totalEvents: ruleSetPreviewResult.value?.totalEvents ?? previewEventDrafts.value.length,
  preview: normalizedRuleSetPreviewRows.value,
  config: ruleBuilderPreviewConfig.value,
  notes: ruleSetPreviewNotes.value,
}, ruleBuilderState.value))
const ruleSetPreviewRecommendations = computed(() => rulePreviewRecommendations.value)
const ruleSetPreviewEffectiveConfig = computed<Record<string, unknown> | null>(() => {
  const config = asPlainObject(ruleSetPreviewResult.value?.config)
  return config && Object.keys(config).length > 0 ? config : null
})
const ruleSetPreviewConfigDiff = computed<PreviewConfigDiffSummary | null>(() => (
  buildPreviewConfigDiffSummary(ruleBuilderPreviewConfig.value, ruleSetPreviewEffectiveConfig.value)
))
const selectedRuleSetPreviewRow = computed(() => {
  const rows = ruleSetPreviewRows.value
  const selected = rows.find((row) => getRuleSetPreviewRowKey(row) === selectedRuleSetPreviewRowKey.value)
  return selected ?? rows.find((row) => isRuleSetPreviewRowFlagged(row)) ?? rows[0] ?? null
})
const selectedRuleSetPreviewSeverity = computed<AttendanceRuleSetPreviewRecommendation['severity']>(() => {
  const row = selectedRuleSetPreviewRow.value
  if (!row) return 'info'
  if (!row.firstInAt || !row.lastOutAt) return 'critical'
  if (row.isWorkingDay === false) return 'warning'
  if (normalizeInteger(row.lateMinutes, 0) > 0 || normalizeInteger(row.earlyLeaveMinutes, 0) > 0) return 'warning'
  if (!isPreviewStatusNormal(row.status)) return 'warning'
  return 'info'
})
const selectedRuleSetPreviewMetrics = computed(() => {
  const row = selectedRuleSetPreviewRow.value
  if (!row) return []
  return [
    { key: 'workMinutes', label: tr('Work minutes', '工时分钟'), value: row.workMinutes ?? '--' },
    { key: 'lateMinutes', label: tr('Late', '迟到'), value: row.lateMinutes ?? 0 },
    { key: 'earlyLeaveMinutes', label: tr('Early leave', '早退'), value: row.earlyLeaveMinutes ?? 0 },
    { key: 'checkIn', label: tr('Check in', '上班打卡'), value: row.firstInAt ? formatDateTime(row.firstInAt) : '--' },
    { key: 'checkOut', label: tr('Check out', '下班打卡'), value: row.lastOutAt ? formatDateTime(row.lastOutAt) : '--' },
  ]
})
const selectedRuleSetPreviewHints = computed(() => {
  const row = selectedRuleSetPreviewRow.value
  if (!row) return []

  const hints: string[] = []
  if (!row.firstInAt || !row.lastOutAt) {
    hints.push(tr('This row is missing a punch event. Use it to verify missing-punch policy, exception flow, and whether the import source guarantees paired events.', '该行缺少打卡事件。请用它核对缺卡策略、异常流程，以及导入源是否保证上下班成对事件。'))
  }
  if (normalizeInteger(row.lateMinutes, 0) > 0) {
    hints.push(tr(`This row still arrives ${row.lateMinutes} minutes late after the current rule. Review shift start time or increase total grace.`, `该行在当前规则下仍迟到 ${row.lateMinutes} 分钟。请复核上班时间或提高总宽限。`))
  }
  if (normalizeInteger(row.earlyLeaveMinutes, 0) > 0) {
    hints.push(tr(`This row still leaves ${row.earlyLeaveMinutes} minutes early after the current rule. Review shift end time or increase total grace.`, `该行在当前规则下仍早退 ${row.earlyLeaveMinutes} 分钟。请复核下班时间或提高总宽限。`))
  }
  if (row.isWorkingDay === false) {
    hints.push(tr('This row lands on a non-working day. Confirm whether it should be treated as overtime, a temporary working-day override, or an out-of-policy record.', '该行落在非工作日。请确认它应被视为加班、临时调班，还是越界记录。'))
  }
  if (!isPreviewStatusNormal(row.status)) {
    hints.push(tr(`Preview returned status "${row.status || 'unknown'}". Use the source payload below to understand which rule branch produced it.`, `预演返回状态 "${row.status || 'unknown'}"。请结合下方源载荷判断是哪条规则分支命中了它。`))
  }
  if (hints.length === 0) {
    hints.push(tr('This row looks clean under the current draft. Keep it as a baseline sample when tuning edge cases.', '该行在当前草稿下表现正常，可作为调试边界场景时的基线样本。'))
  }
  return hints
})
const selectedRuleSetPreviewSource = computed<Record<string, unknown> | null>(() => {
  const source = selectedRuleSetPreviewRow.value?.source
  return asPlainObject(source)
})

function formatPreviewRecommendationTitle(recommendation: AttendanceRuleSetPreviewRecommendation): string {
  switch (recommendation.key) {
    case 'raiseLateGrace':
      return tr('Raise late grace', '提高迟到宽限')
    case 'raiseEarlyGrace':
      return tr('Raise early-leave grace', '提高早退宽限')
    case 'reviewWorkingDays':
      return tr('Review working-day calendar', '复核工作日历')
    case 'reviewMissingPunches':
      return tr('Review missing punches', '复核缺卡')
    case 'reviewAbnormalStatuses':
      return tr('Review abnormal statuses', '复核异常状态')
    default:
      return tr('Review preview output', '复核预演输出')
  }
}

function formatPreviewRecommendationDetail(recommendation: AttendanceRuleSetPreviewRecommendation): string {
  switch (recommendation.key) {
    case 'raiseLateGrace':
      return tr(
        `${recommendation.affectedRows} row(s) still land late after the current rule. Preview suggests raising total late grace to about ${recommendation.suggestedMinutes} min.`,
        `${recommendation.affectedRows} 条记录在当前规则下仍然迟到。预演建议把总迟到宽限提高到约 ${recommendation.suggestedMinutes} 分钟。`,
      )
    case 'raiseEarlyGrace':
      return tr(
        `${recommendation.affectedRows} row(s) still leave early after the current rule. Preview suggests raising total early-leave grace to about ${recommendation.suggestedMinutes} min.`,
        `${recommendation.affectedRows} 条记录在当前规则下仍然早退。预演建议把总早退宽限提高到约 ${recommendation.suggestedMinutes} 分钟。`,
      )
    case 'reviewWorkingDays':
      return tr(
        `${recommendation.affectedRows} row(s) landed on non-working days. Confirm weekend/overtime policy or working-day overrides.`,
        `${recommendation.affectedRows} 条记录落在非工作日。请确认周末加班策略或调班工作日覆盖。`,
      )
    case 'reviewMissingPunches':
      return tr(
        `${recommendation.affectedRows} row(s) are missing check-in or check-out events.`,
        `${recommendation.affectedRows} 条记录缺少上班卡或下班卡。`,
      )
    case 'reviewAbnormalStatuses':
      return tr(
        `${recommendation.affectedRows} row(s) still return non-normal statuses after preview.`,
        `${recommendation.affectedRows} 条记录在预演后仍返回非正常状态。`,
      )
    default:
      return tr('Review the generated rows before saving this rule set.', '保存规则集前请先复核生成结果。')
  }
}

function formatRuleSetRecommendationTitle(recommendation: AttendanceRuleSetPreviewRecommendation): string {
  return formatPreviewRecommendationTitle(recommendation)
}

function formatRuleSetRecommendationBody(recommendation: AttendanceRuleSetPreviewRecommendation): string {
  return formatPreviewRecommendationDetail(recommendation)
}

function getRuleSetPreviewRowKey(row: RuleSetPreviewRow): string {
  return `${row.userId || 'unknown'}:${row.workDate || 'unknown'}`
}

function isPreviewStatusNormal(status: string | undefined): boolean {
  const normalized = String(status ?? '').trim().toLowerCase()
  return normalized.length === 0 || normalized === 'normal' || normalized === 'ok' || normalized === 'adjusted' || normalized === 'off'
}

function isRuleSetPreviewRowFlagged(row: RuleSetPreviewRow): boolean {
  return (
    !row.firstInAt
    || !row.lastOutAt
    || row.isWorkingDay === false
    || normalizeInteger(row.lateMinutes, 0) > 0
    || normalizeInteger(row.earlyLeaveMinutes, 0) > 0
    || !isPreviewStatusNormal(row.status)
  )
}

function selectRuleSetPreviewRow(row: RuleSetPreviewRow) {
  selectedRuleSetPreviewRowKey.value = getRuleSetPreviewRowKey(row)
}

function formatPreviewSeverity(severity: AttendanceRuleSetPreviewRecommendation['severity']): string {
  switch (severity) {
    case 'critical':
      return tr('Critical', '严重')
    case 'warning':
      return tr('Warning', '警告')
    default:
      return tr('Info', '提示')
  }
}

watch(
  () => ruleSetForm.config,
  (value) => {
    ruleBuilderSyncing.value = true
    try {
      syncRuleBuilderFromConfig(value)
      ruleBuilderHydrated.value = true
    } finally {
      ruleBuilderSyncing.value = false
    }
  },
  { immediate: true },
)

watch(
  () => ruleSetPreviewEventsText.value,
  (value) => {
    const drafts = parsePreviewEventDrafts(value)
    if (drafts === null) {
      return
    }
    previewEventDrafts.value = drafts
  },
  { immediate: true },
)

watch(
  previewEventDrafts,
  () => {
    syncPreviewEventTextFromDrafts()
  },
  { deep: true },
)

watch(
  ruleSetPreviewRows,
  (rows) => {
    if (rows.length === 0) {
      selectedRuleSetPreviewRowKey.value = ''
      return
    }
    const selected = rows.find((row) => getRuleSetPreviewRowKey(row) === selectedRuleSetPreviewRowKey.value)
    if (selected) return
    const fallback = rows.find((row) => isRuleSetPreviewRowFlagged(row)) ?? rows[0]
    selectedRuleSetPreviewRowKey.value = fallback ? getRuleSetPreviewRowKey(fallback) : ''
  },
  { immediate: true },
)

watch(
  [
    ruleBuilderSource,
    ruleBuilderTimezone,
    ruleBuilderWorkStartTime,
    ruleBuilderWorkEndTime,
    ruleBuilderLateGraceMinutes,
    ruleBuilderEarlyGraceMinutes,
    ruleBuilderWorkingDaysText,
  ],
  () => {
    syncRuleSetConfigFromBuilder()
  },
  { deep: true },
)

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function appendAttendanceGroupMemberSelectedUser() {
  const userId = attendanceGroupMemberSelectedUserId.value.trim()
  if (!userId) return
  const ids = attendanceGroupMemberUserIds.value
    .split(/[\n,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
  if (!ids.includes(userId)) {
    ids.push(userId)
  }
  attendanceGroupMemberUserIds.value = ids.join(', ')
  attendanceGroupMemberSelectedUserId.value = ''
}
</script>

<style scoped>
.attendance__admin-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 16px;
}

.attendance__admin-section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.attendance__admin-subsection {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.attendance__admin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.attendance__admin-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.attendance__rule-builder {
  display: grid;
  gap: 16px;
  padding: 16px;
  border: 1px solid #dbe7f5;
  border-radius: 14px;
  background:
    linear-gradient(180deg, rgba(244, 249, 255, 0.95), rgba(255, 255, 255, 1)),
    radial-gradient(circle at top right, rgba(31, 111, 235, 0.08), transparent 32%);
}

.attendance__subheading {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: #17324d;
}

.attendance__rule-builder-summary,
.attendance__preview-summary,
.attendance__preview-result-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
  font-size: 13px;
  color: #44546a;
}

.attendance__rule-builder-summary strong,
.attendance__preview-summary strong,
.attendance__preview-result-meta strong {
  color: #11243d;
}

.attendance__rule-builder-days {
  display: grid;
  gap: 10px;
}

.attendance__field-label {
  font-size: 13px;
  font-weight: 600;
  color: #17324d;
}

.attendance__rule-builder-day-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(92px, 1fr));
  gap: 8px;
}

.attendance__rule-builder-day {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid #dbe3ee;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.9);
  font-size: 13px;
}

.attendance__rule-builder-preview {
  display: grid;
  gap: 12px;
  padding: 14px;
  border: 1px solid #d9e3f1;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.92);
}

.attendance__preview-builder,
.attendance__preview-config-panels {
  display: grid;
  gap: 12px;
}

.attendance__preview-config-panels {
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
}

.attendance__preview-config-panels--single {
  grid-template-columns: minmax(0, 1fr);
}

.attendance__preview-state {
  padding: 10px 12px;
  border-radius: 10px;
  background: #eff6ff;
  color: #284b7a;
  font-size: 13px;
}

.attendance__preview-result {
  display: grid;
  gap: 12px;
}

.attendance__scenario-lab {
  display: grid;
  gap: 10px;
}

.attendance__scenario-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}

.attendance__scenario-card {
  display: grid;
  gap: 6px;
  padding: 12px;
  border: 1px solid #d8e2ef;
  border-radius: 12px;
  background: #fff;
  text-align: left;
  cursor: pointer;
}

.attendance__scenario-card strong {
  color: #17324d;
}

.attendance__scenario-card span {
  color: #516074;
  font-size: 12px;
}

.attendance__scenario-card--active {
  border-color: #2563eb;
  background: #eef5ff;
  box-shadow: 0 0 0 1px rgba(37, 99, 235, 0.12);
}

.attendance__preview-scorecards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
}

.attendance__preview-scorecard {
  display: grid;
  gap: 4px;
  padding: 12px;
  border: 1px solid #dce4ef;
  border-radius: 12px;
  background: linear-gradient(180deg, #fbfdff 0%, #f5f8fc 100%);
}

.attendance__preview-scorecard span,
.attendance__preview-scorecard small {
  color: #516074;
  font-size: 12px;
}

.attendance__preview-scorecard strong {
  color: #11243d;
  font-size: 22px;
  font-weight: 700;
}

.attendance__preview-recommendations {
  display: grid;
  gap: 10px;
}

.attendance__preview-recommendation {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid #dbe4ef;
  border-radius: 12px;
  background: #fff;
}

.attendance__preview-recommendation strong {
  color: #17324d;
}

.attendance__preview-recommendation span {
  color: #4b5565;
  font-size: 13px;
}

.attendance__inline-code {
  display: inline-flex;
  width: fit-content;
  padding: 4px 8px;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.06);
  color: #17324d;
  font-size: 12px;
}

.attendance__preview-recommendation--critical {
  border-color: #fecaca;
  background: #fff5f5;
}

.attendance__preview-recommendation--warning {
  border-color: #fcd34d;
  background: #fff9db;
}

.attendance__preview-recommendation--info {
  border-color: #bfdbfe;
  background: #eff6ff;
}

.attendance__preview-row--selected {
  background: rgba(239, 246, 255, 0.7);
}

.attendance__severity {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 70px;
  padding: 4px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}

.attendance__severity--critical {
  background: #fee2e2;
  color: #b42318;
}

.attendance__severity--warning {
  background: #fef3c7;
  color: #9a6700;
}

.attendance__severity--info {
  background: #dbeafe;
  color: #1d4ed8;
}

.attendance__code--builder {
  min-height: 180px;
  max-height: 420px;
  overflow: auto;
}

.attendance__empty--error,
.attendance__field-hint--error {
  color: #b42318;
}

.attendance__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.attendance__field--full {
  grid-column: 1 / -1;
}

.attendance__field--checkbox {
  justify-content: flex-end;
}

.attendance__template-version-panel {
  display: grid;
  gap: 12px;
  padding: 14px;
  border: 1px solid #d9e3f1;
  border-radius: 10px;
  background: #f8fbff;
}

.attendance__template-version-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 18px;
  color: #44546a;
  font-size: 13px;
}

.attendance__code--viewer {
  min-height: 280px;
  max-height: 520px;
  overflow: auto;
}

.attendance__field-hint {
  color: #666;
  font-size: 12px;
}

.attendance__btn {
  padding: 8px 14px;
  border-radius: 6px;
  border: 1px solid #d0d0d0;
  background: #fff;
  cursor: pointer;
}

.attendance__btn--primary {
  background: #1f6feb;
  border-color: #1f6feb;
  color: #fff;
}

.attendance__btn--danger {
  color: #c62828;
}

.attendance__btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.attendance__table-wrapper {
  width: 100%;
  overflow-x: auto;
}

.attendance__table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 12px;
}

.attendance__table th,
.attendance__table td {
  border-bottom: 1px solid #e0e0e0;
  padding: 8px;
  text-align: left;
  font-size: 13px;
}

.attendance__table-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.attendance__empty {
  color: #888;
  font-size: 13px;
  margin-top: 8px;
}
</style>
