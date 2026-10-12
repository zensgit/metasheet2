<template>
  <section class="stock-prep-source" data-testid="stock-prep-source-binding">
    <h3 class="stock-prep-source__h3">
      {{ bi('数据从哪里来', 'Where the data comes from') }}
    </h3>
    <p class="stock-prep-source__intro" data-testid="stock-prep-source-intro">
      {{ bi(
        '备料要读贵司的 BOM,得先知道去哪个库读。这里选一个已经登记好的只读数据库连接就行 —— 只是「读哪里」,不会改动那个库里的任何东西。',
        '备料 reads your BOM, so it needs to know which database to read. Pick one of the read-only database connections already registered here — this only chooses WHERE to read; nothing in that database is ever changed.',
      ) }}
    </p>

    <!-- The affordance this whole change exists to be able to show. Rendered from the SERVER's own
         `takesEffectWithoutRestart`, not asserted by the page on its own authority: if a future
         deployment could not honour it, the line would disappear rather than lie. -->
    <p
      v-if="view?.takesEffectWithoutRestart === true"
      class="stock-prep-source__no-restart"
      data-testid="stock-prep-source-no-restart"
    >
      {{ bi(noRestart.zh, noRestart.en) }}
    </p>

    <p v-if="errorStatus !== null" class="stock-prep-source__error" data-testid="stock-prep-source-error">
      <span v-if="refusalText">{{ bi(refusalText.zh, refusalText.en) }}</span>
      <span v-else>{{ bi('读取或保存失败。', 'The read or save failed.') }}</span>
      <code class="stock-prep-source__token">HTTP {{ errorStatus }}</code>
    </p>

    <!-- CURRENT STATE — shown to every reader who can open this tab. -->
    <p v-if="view" class="stock-prep-source__current" data-testid="stock-prep-source-current">
      <strong>{{ bi('当前来源:', 'Current source: ') }}</strong>
      <span data-testid="stock-prep-source-current-name">{{ currentName }}</span>
      <code v-if="view.effectiveExternalSystemId" class="stock-prep-source__token" data-testid="stock-prep-source-current-id">
        {{ view.effectiveExternalSystemId }}
      </code>
    </p>
    <p v-if="view" class="stock-prep-source__origin" data-testid="stock-prep-source-origin">
      {{ bi(originText.zh, originText.en) }}
    </p>
    <p v-else class="stock-prep-source__current" data-testid="stock-prep-source-unknown">
      {{ bi('当前来源：尚未核实。', 'Current source: not yet verified.') }}
    </p>

    <!-- The source the action reads TODAY cannot actually be read. Named here rather than left for
         the admin to discover on the next failed refresh — an env default pointing at a deleted or
         deactivated system, or a cross-kind row persisted before the server enforced the action's
         kind, both land here. -->
    <p
      v-if="view && problemText"
      class="stock-prep-source__problem"
      data-testid="stock-prep-source-problem"
    >
      {{ bi('当前来源现在读不了:', 'The current source cannot be read right now: ') }}
      {{ bi(problemText.zh, problemText.en) }}
    </p>

    <!-- R-11: the picker and Save render ONLY for a principal the server would accept. A
         `stock-prep:admin` holder who can open this tab still sees the current source and is told,
         in words, who changes it — rather than a control that 403s. -->
    <template v-if="canBind">
      <div class="stock-prep-source__picker">
        <button
          type="button"
          class="stock-prep-source__save"
          data-testid="stock-prep-source-refresh"
          :disabled="busy"
          @click="load"
        >
          {{ bi('刷新来源', 'Refresh sources') }}
        </button>
        <label class="stock-prep-source__label" for="stock-prep-source-select">
          {{ bi('换成这个连接', 'Switch to this connection') }}
        </label>
        <select
          id="stock-prep-source-select"
          v-model="selected"
          class="stock-prep-source__select"
          data-testid="stock-prep-source-select"
          :disabled="busy"
        >
          <option value="" disabled>{{ bi('请选择…', 'Choose…') }}</option>
          <option
            v-for="candidate in candidates"
            :key="candidate.externalSystemId"
            :value="candidate.externalSystemId"
            data-testid="stock-prep-source-option"
          >
            {{ optionLabel(candidate) }}
          </option>
        </select>
        <button
          type="button"
          class="stock-prep-source__save"
          data-testid="stock-prep-source-save"
          :disabled="busy || !canSaveSelectedSource"
          @click="askToSave"
        >
          {{ bi('保存', 'Save') }}
        </button>
      </div>

      <p v-if="persistedBindingOutsideScope" data-testid="stock-prep-source-scope-binding-note">
        {{ bi(
          '当前来源来自其他范围的绑定。您可以显式在当前范围建立来源绑定，原范围绑定保留；本页不会自动保存或切换范围。',
          'The current source comes from a binding in another scope. You can explicitly establish a source binding in the current scope; the original binding is retained. This page does not save or switch scopes automatically.',
        ) }}
      </p>

      <p v-if="candidates.length === 0" class="stock-prep-source__empty" data-testid="stock-prep-source-empty">
        {{ bi(
          '这里没有可选的连接 —— 请先在「对接」里登记一个只读数据库连接并启用它。已登记但不属于您管理的连接不会出现在这里。',
          'There are no connections to choose from — register a read-only database connection under 对接 and activate it first. Connections you do not manage are not listed here.',
        ) }}
      </p>

      <!-- The confirmation. Repointing 备料 at a different database changes what every subsequent
           row is built from, so it is a confirm-then-act, never a one-click. -->
      <div v-if="pending" class="stock-prep-source__confirm" data-testid="stock-prep-source-confirm">
        <p class="stock-prep-source__confirm-text" data-testid="stock-prep-source-confirm-text">
          {{ pendingScopeCreation ? bi(
            `确认在当前范围建立指向「${pendingName}」的来源绑定吗？原范围绑定保留。之后在当前范围的每一次「同步这个项目」都会从这个库取数。`,
            `Establish a source binding to “${pendingName}” in the current scope? The original scope's binding is retained. Every later 同步这个项目 in this scope will read from that database.`,
          ) : bi(
            `确认把备料的数据来源改成「${pendingName}」吗?之后的每一次「同步这个项目」都会从这个库取数。`,
            `Change 备料's data source to “${pendingName}”? Every later 同步这个项目 will read from that database.`,
          ) }}
        </p>
        <p
          v-if="view?.takesEffectWithoutRestart === true"
          class="stock-prep-source__confirm-note"
          data-testid="stock-prep-source-confirm-note"
        >
          {{ bi(noRestart.zh, noRestart.en) }}
        </p>
        <button
          type="button"
          class="stock-prep-source__save"
          data-testid="stock-prep-source-confirm-save"
          :disabled="busy"
          @click="save"
        >
          {{ bi('确认更改', 'Confirm the change') }}
        </button>
        <button
          type="button"
          class="stock-prep-source__cancel"
          data-testid="stock-prep-source-cancel"
          :disabled="busy"
          @click="pending = null"
        >
          {{ bi('取消', 'Cancel') }}
        </button>
      </div>

      <p v-if="saved" class="stock-prep-source__saved" data-testid="stock-prep-source-saved">
        {{ bi(
          '已保存,并且已经生效 —— 下一次「同步这个项目」就会从新来源取数,不用重启。',
          'Saved, and already live — the next 同步这个项目 reads from the new source. No restart needed.',
        ) }}
      </p>
      <p v-else-if="unconfirmed" class="stock-prep-source__unconfirmed" data-testid="stock-prep-source-unconfirmed">
        {{ bi(
          '保存请求已经提交,但核对结果还不能用来显示生效。请点「刷新来源」再看当前来源,本页不会自动再次保存。',
          'The save request was submitted, but the check is not enough to show it as effective. Use Refresh sources to look at the current source again. This page will not save again by itself.',
        ) }}
      </p>

      <!-- Local editing stays independent of source binding. Tenant-level version management
           requires its own explicit opt-in and target; it never changes the page's scope. -->
      <details class="stock-prep-source__draft" data-testid="stock-prep-source-plan-draft">
        <summary data-testid="stock-prep-source-plan-draft-summary">
          {{ bi('PLM字段角色草稿与版本', 'PLM field-role drafts and versions') }}
        </summary>
        <p class="stock-prep-source__draft-note" data-testid="stock-prep-source-plan-draft-note">
          {{ bi(
            '这是 SQL 只读来源的字段角色草稿。本地校验只检查结构，不证明源库物理列存在，也不证明业务含义。显式核对只针对已保存的所选版本，比较物理列名是否存在，不读取未保存草稿或当前激活指针。样本只显示最多 20 行规范化业务单元格，不是源库原始行。确认、审批和激活要使用 15 分钟内的服务器回执；该窗口不表示运行时到期。读取调用预算不是行数。schema 标识可能敏感，请仅保存在已授权位置；未审批不会生效。',
            'This is a field-role draft for a SQL read-only source. The local check only checks structure. It does not prove that physical columns exist, and it does not prove business meaning. An explicit check targets only the saved version you select and compares physical column names. It does not read an unsaved draft or the current activation pointer. The sample shows at most 20 normalized business cells, not raw source rows. Confirmation, approval, and activation use the server receipt inside its 15-minute window. That window is not a runtime expiry. The read-call budget is not a row count. Schema identifiers may be sensitive: keep them only in authorized locations. Nothing takes effect without approval.',
          ) }}
        </p>

        <div class="stock-prep-source__draft-actions">
          <label class="stock-prep-source__draft-import" for="stock-prep-source-plan-draft-import">
            {{ bi('导入待审 JSON', 'Import review JSON') }}
            <input
              id="stock-prep-source-plan-draft-import"
              type="file"
              accept="application/json,.json"
              data-testid="stock-prep-source-plan-draft-import"
              @change="importDraftFile"
            >
          </label>
          <button
            type="button"
            class="stock-prep-source__draft-button"
            data-testid="stock-prep-source-plan-draft-synthetic"
            @click="loadSyntheticDraft"
          >
            {{ bi('载入合成示例', 'Load synthetic example') }}
          </button>
          <label class="stock-prep-source__draft-budget" for="stock-prep-source-plan-draft-max-read-count">
            {{ bi('读取调用预算（次）', 'Read-call budget') }}
            <input
              id="stock-prep-source-plan-draft-max-read-count"
              v-model.number="draft.maxReadCount"
              type="number"
              min="1"
              max="1000"
              step="1"
              :aria-invalid="hasDraftIssue('maxReadCount')"
              :aria-describedby="hasDraftIssue('maxReadCount') ? 'stock-prep-source-plan-draft-issues' : undefined"
              data-testid="stock-prep-source-plan-draft-max-read-count"
              @input="invalidateDraftPreview"
            >
          </label>
          <button
            type="button"
            class="stock-prep-source__draft-button"
            data-testid="stock-prep-source-plan-draft-preview"
            @click="previewDraft"
          >
            {{ bi('校验并预览待审 JSON', 'Validate and preview review JSON') }}
          </button>
        </div>

        <fieldset
          v-for="section in SOURCE_PLAN_DRAFT_SECTIONS"
          :key="section.key"
          class="stock-prep-source__draft-section"
          :data-testid="`stock-prep-source-plan-draft-section-${section.key}`"
        >
          <legend>{{ bi(section.zh, section.en) }}</legend>
          <label
            v-for="field in section.fields"
            :key="field.key"
            class="stock-prep-source__draft-field"
            :for="`stock-prep-source-plan-draft-${section.key}-${field.key}`"
          >
            {{ bi(field.zh, field.en) }}{{ field.required ? ' *' : '' }}
            <input
              :id="`stock-prep-source-plan-draft-${section.key}-${field.key}`"
              v-model="draft.roles[section.key][field.key]"
              type="text"
              autocomplete="off"
              :aria-required="field.required"
              :aria-invalid="hasDraftIssue(`roles.${section.key}.${field.key}`)"
              :aria-describedby="hasDraftIssue(`roles.${section.key}.${field.key}`) ? 'stock-prep-source-plan-draft-issues' : undefined"
              :data-testid="`stock-prep-source-plan-draft-input-${section.key}-${field.key}`"
              @input="invalidateDraftPreview"
            >
          </label>
        </fieldset>

        <ul
          v-if="draftIssues.length"
          class="stock-prep-source__draft-issues"
          data-testid="stock-prep-source-plan-draft-issues"
          id="stock-prep-source-plan-draft-issues"
          role="alert"
        >
          <li v-for="item in draftIssues" :key="`${item.path}-${item.code}`">
            {{ issueLabel(item) }}: {{ bi(item.zh, item.en) }}
          </li>
        </ul>

        <template v-if="draftPreview">
          <p class="stock-prep-source__draft-review" data-testid="stock-prep-source-plan-draft-review">
            {{ bi('仅供待审；未生效。', 'For review only; not effective.') }}
          </p>
          <pre class="stock-prep-source__draft-json" data-testid="stock-prep-source-plan-draft-json">{{ draftPreview }}</pre>
          <button
            type="button"
            class="stock-prep-source__draft-button"
            data-testid="stock-prep-source-plan-draft-download"
            @click="downloadDraft"
          >
            {{ bi('下载待审 JSON', 'Download review JSON') }}
          </button>
        </template>

        <label class="stock-prep-source__draft-management-toggle">
          <input v-model="planManagement" type="checkbox" data-testid="stock-prep-plan-management-toggle">
          {{ bi('管理租户级读取计划', 'Manage tenant-level read plans') }}
        </label>
        <section v-if="planManagement" class="stock-prep-source__draft-online" data-testid="stock-prep-plan-management">
          <p data-testid="stock-prep-plan-management-scope">
            {{ bi('管理范围：当前登录租户，workspace=null。', 'Management scope: the signed-in tenant, workspace=null.') }}
          </p>
          <p data-testid="stock-prep-plan-execution-scope">
            {{ bi('页面执行范围：', 'Page execution scope: ') }}{{ scope.workspaceId || bi('租户级', 'tenant level') }}。
            {{ bi('本页未查询执行时的有效计划。租户级激活不代表当前工作区已采用，也不会切换数据来源。', 'Execution-time effective state has not been queried here. Tenant-level activation does not establish use by this workspace or switch its data source.') }}
          </p>
          <p>{{ bi('输入您拥有的只读连接所对应的外部系统编号；服务器会校验连接所有权。', 'Enter the external-system ID for a read-only connection you own; the server checks connection ownership.') }}</p>
          <div class="stock-prep-source__draft-actions">
            <label for="stock-prep-plan-system">
              {{ bi('计划目标系统', 'Plan target system') }}
              <input id="stock-prep-plan-system" v-model="planTargetSystemId" type="text" autocomplete="off" data-testid="stock-prep-plan-system">
            </label>
            <button type="button" class="stock-prep-source__draft-button" data-testid="stock-prep-plan-refresh" :disabled="planBusy || !validPlanTarget" @click="loadPlanVersions">
              {{ bi('读取版本与激活状态', 'Load versions and activation') }}
            </button>
            <button type="button" class="stock-prep-source__draft-button" data-testid="stock-prep-plan-save" :disabled="planBusy || !planState" @click="savePlanDraft">
              {{ bi('保存当前草稿版本', 'Save current draft version') }}
            </button>
          </div>
          <p>{{ bi('相同内容可能复用已有版本。保存不会自动审批或激活；请选择一个保存版本并单独确认。', 'Identical content may reuse an existing version. Saving does not approve or activate it; select a saved version and confirm each action separately.') }}</p>
          <p v-if="planErrorStatus !== null" role="alert" class="stock-prep-source__error" data-testid="stock-prep-plan-error">
            {{ planErrorText }} <code>HTTP {{ planErrorStatus }}</code>
          </p>
          <p v-if="planState" data-testid="stock-prep-plan-activation">
            {{ bi('服务器返回的租户级激活状态：', 'Server-reported tenant-level activation: ') }}
            <template v-if="planState.activation">
              {{ bi(planState.activation.status === 'active' ? '已激活' : '已停用', planState.activation.status) }}
              · {{ bi('版本', 'version') }} <code>{{ planState.activation.versionId }}</code>
              · {{ bi('系统', 'system') }} <code>{{ planState.activation.systemId }}</code>
              · {{ bi('激活指针代次', 'activation pointer generation') }} {{ planState.activation.generation }}
              <span v-if="planState.activation.systemId !== planTargetSystemId">{{ bi('（当前指向另一系统）', '(currently points to another system)') }}</span>
            </template>
            <template v-else>{{ bi('尚无激活记录；部署默认计划是否有效未查询。', 'No activation record; deployment-default effectiveness has not been queried.') }}</template>
          </p>
          <p v-if="planState && !planState.versions.length" data-testid="stock-prep-plan-empty">{{ bi('该系统尚无已保存版本。', 'No saved versions for this system.') }}</p>
          <ul v-if="planState" class="stock-prep-source__draft-versions" data-testid="stock-prep-plan-versions">
            <li v-for="version in planState.versions" :key="version.id">
              <label>
                <input v-model="selectedPlanVersionId" type="radio" name="stock-prep-plan-version" :value="version.id" :disabled="planBusy" :data-testid="`stock-prep-plan-version-${version.id}`">
                v{{ version.version }} · {{ planStatusText(version.status) }} · <code>{{ version.id }}</code>
                · <span :data-testid="`stock-prep-plan-validation-${version.id}`">{{ validationStatusText(version.validation) }}</span>
              </label>
            </li>
          </ul>
          <details v-if="selectedPlanVersion" data-testid="stock-prep-plan-selected-details">
            <summary>{{ bi('查看所选不可变版本内容', 'Inspect selected immutable version') }}</summary>
            <p><code>{{ selectedPlanVersion.contentKey }}</code></p>
            <pre class="stock-prep-source__draft-json">{{ JSON.stringify(selectedPlanVersion.config.readPlan, null, 2) }}</pre>
          </details>
          <button v-if="planState" type="button" class="stock-prep-source__draft-button" data-testid="stock-prep-plan-copy-draft" :disabled="!canCopyPlanDraft" @click="askCopyPlanDraft">
            {{ bi('载入所选版本为本地待审草稿', 'Load selected version as a local review draft') }}
          </button>
          <div v-if="pendingDraftCopy" class="stock-prep-source__confirm" data-testid="stock-prep-plan-copy-confirm">
            <p>{{ bi('确认用所选已保存版本的字段角色替换当前本地草稿？仅复制读取计划，不继承来源、审批、回执或激活权限；不会保存、读取来源、审批或激活。请在本地复核后单独预览或下载待审 JSON。', 'Replace the current local draft with field roles from the selected saved version? Only the read plan is copied; source, approval, receipt and activation authority are not inherited. This does not save, read the source, approve or activate. Review locally, then preview or download the review JSON separately.') }}</p>
            <button type="button" class="stock-prep-source__draft-button" data-testid="stock-prep-plan-copy-confirm-submit" :disabled="!canCopyPlanDraft" @click="confirmCopyPlanDraft">{{ bi('确认替换本地草稿', 'Confirm local draft replacement') }}</button>
            <button type="button" class="stock-prep-source__draft-button" data-testid="stock-prep-plan-copy-confirm-cancel" @click="pendingDraftCopy = null">{{ bi('取消', 'Cancel') }}</button>
          </div>
          <section v-if="planState" class="stock-prep-source__sample-panel" data-testid="stock-prep-plan-validation">
            <p data-testid="stock-prep-plan-validation-target">
              {{ selectedPlanVersion
                ? bi(`核对已保存版本 ${selectedPlanVersion.id}。不会读取本地未保存草稿，也不会改读当前激活指针。`, `Check saved version ${selectedPlanVersion.id}. This does not read the unsaved local draft or switch to the current activation pointer.`)
                : bi('先选择一个已保存版本。本地未保存草稿和当前激活指针都不会被读取。', 'Select a saved version first. The unsaved local draft and the current activation pointer are not read.') }}
            </p>
            <p data-testid="stock-prep-plan-receipt">
              {{ bi(
                '审批和激活需要这条已保存版本的最新已确认回执，并且当前时间早于回执到期时间。只看到“已读到样本”或重新读取到的摘要，都不能代替本页对这一样本的确认。服务器仍会拒绝不符合的请求。回执窗口是 15 分钟，只约束确认、审批和激活；到期不会使已经激活的计划停止读取。',
                'Approval and activation require this saved version’s latest confirmed receipt, and the current time must be before that receipt expires. A passed sample, or a summary loaded again, does not replace confirmation of the sample this page received. The server still rejects a request that does not qualify. The 15-minute receipt window applies to confirmation, approval, and activation. Expiry does not stop an already activated plan from being read.',
              ) }}
            </p>
            <div class="stock-prep-source__draft-actions">
              <label class="stock-prep-source__draft-field" for="stock-prep-plan-project">
                {{ bi('项目号（仅这一次显式核对）', 'Project number (this explicit check only)') }}
                <input id="stock-prep-plan-project" v-model="planProjectNo" type="text" autocomplete="off" spellcheck="false" data-testid="stock-prep-plan-project">
              </label>
              <button type="button" class="stock-prep-source__draft-button" data-testid="stock-prep-plan-validate" :disabled="!canValidatePlan" @click="validatePlanSample">
                {{ bi('核对所选已保存版本', 'Check the selected saved version') }}
              </button>
              <button type="button" class="stock-prep-source__draft-button" data-testid="stock-prep-plan-confirm-sample" :disabled="planBusy || !canConfirmPlanSample" @click="confirmPlanSample">
                {{ bi('我已核对这一样本', 'I have checked this sample') }}
              </button>
            </div>
            <div v-if="planSample" data-testid="stock-prep-plan-sample">
              <p data-testid="stock-prep-plan-sample-meta">
                {{ bi(
                  `已显示 ${planSample.sample.displayedRows} 行，共 ${planSample.sample.totalRows} 行，最多 20 行。读取 ${planSample.validation.counts?.readCount ?? ''} 次，对象 ${planSample.validation.counts?.objectCount ?? ''} 个。`,
                  `Showing ${planSample.sample.displayedRows} of ${planSample.sample.totalRows} rows, maximum 20. Reads ${planSample.validation.counts?.readCount ?? ''}, objects ${planSample.validation.counts?.objectCount ?? ''}.`,
                ) }}
                <template v-if="planSample.sample.truncated">{{ bi('未显示的行不在这里展开。', 'Rows not shown are not expanded here.') }}</template>
                <time :datetime="planSample.validation.expiresAt" data-testid="stock-prep-plan-sample-expiry">{{ planSample.validation.expiresAt }}</time>
              </p>
              <p data-testid="stock-prep-plan-sample-version-note">{{ bi('物料来源版本与订单指定 BOM 版本含义不同。订单指定 BOM 版本留空表示来源未提供，不表示与物料来源版本相同；不会从父项继承或回退到物料来源版本。', 'Material source version and order-requested BOM version have different meanings. An absent order-requested BOM version means it was not supplied, not that it matches the material source version; it is not inherited from a parent or filled from the material source version.') }}</p>
              <div class="stock-prep-source__sample-scroll" tabindex="0">
                <table class="stock-prep-source__sample" data-testid="stock-prep-plan-sample-table">
                  <caption>{{ bi('规范化业务单元格。物理列核对只说明列名存在，不证明业务含义，也不是源库原始行。', 'Normalized business cells. The physical-column check only shows that column names exist. It does not prove business meaning, and these are not raw source rows.') }}</caption>
                  <thead>
                    <tr>
                      <th v-for="field in SOURCE_PLAN_SAMPLE_FIELDS" :key="field" scope="col">
                        {{ bi(SAMPLE_FIELD_LABELS[field].zh, SAMPLE_FIELD_LABELS[field].en) }}
                        <code>{{ field }}</code>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(sampleRow, index) in planSample.sample.rows" :key="index">
                      <td v-for="field in SOURCE_PLAN_SAMPLE_FIELDS" :key="field" :data-testid="`stock-prep-plan-sample-${index}-${field}`">{{ sampleCellText(sampleRow, field) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </section>
          <div v-if="planState" class="stock-prep-source__draft-actions">
            <button type="button" class="stock-prep-source__draft-button" data-testid="stock-prep-plan-approve" :disabled="planBusy || selectedPlanVersion?.status !== 'draft' || !selectedReceiptOpen" @click="askPlanAction('approve')">{{ bi('审批所选版本', 'Approve selected version') }}</button>
            <button type="button" class="stock-prep-source__draft-button" data-testid="stock-prep-plan-activate" :disabled="planBusy || selectedPlanVersion?.status !== 'approved' || !selectedReceiptOpen" @click="askPlanAction('activate')">{{ bi('激活所选版本', 'Activate selected version') }}</button>
            <button type="button" class="stock-prep-source__draft-button" data-testid="stock-prep-plan-deactivate" :disabled="planBusy || !canDeactivatePlan" @click="askPlanAction('deactivate')">{{ bi('停用当前激活', 'Disable current activation') }}</button>
          </div>
          <div v-if="pendingPlanAction" class="stock-prep-source__confirm" data-testid="stock-prep-plan-confirm">
            <p>{{ planActionText(pendingPlanAction.action) }} · <code>{{ pendingPlanAction.versionId }}</code> · {{ bi('租户级', 'tenant level') }}</p>
            <p v-if="pendingPlanAction.action !== 'approve'" data-testid="stock-prep-plan-confirm-generation">{{ bi('预期激活指针代次（并发校验）：', 'Expected activation pointer generation (concurrency check): ') }} {{ pendingPlanAction.expectedGeneration }}</p>
            <p v-if="pendingPlanAction.action === 'approve'">{{ bi('只审批这一已保存版本。物理列核对不等于业务含义正确，审批不会激活。这需要该版本最新且未过期的已确认样本回执；服务器仍会拒绝不符合的请求。', 'This approves only this saved version. A physical-column check does not establish business meaning, and approval does not activate it. It requires this version’s latest unexpired confirmed sample receipt; the server still rejects a request that does not qualify.') }}</p>
            <p v-else-if="pendingPlanAction.action === 'activate'">{{ bi('激活这一已保存版本需要其最新且未过期的已确认样本回执，并校验激活指针代次。服务器仍会拒绝不符合的请求。激活完成后，回执到期不会停用该激活。', 'Activation requires this saved version’s latest unexpired confirmed sample receipt and checks the activation pointer generation. The server still rejects a request that does not qualify. After activation, receipt expiry does not disable that activation.') }}</p>
            <p v-else>{{ bi('停用此激活记录；不会自动选择较早版本。', 'Disable this activation; no earlier version is automatically selected.') }}</p>
            <button type="button" class="stock-prep-source__draft-button" data-testid="stock-prep-plan-confirm-submit" :disabled="planBusy" @click="confirmPlanAction">{{ bi('确认', 'Confirm') }}</button>
            <button type="button" class="stock-prep-source__draft-button" data-testid="stock-prep-plan-confirm-cancel" :disabled="planBusy" @click="pendingPlanAction = null">{{ bi('取消', 'Cancel') }}</button>
          </div>
        </section>
      </details>
    </template>

    <p v-else class="stock-prep-source__readonly" data-testid="stock-prep-source-readonly">
      {{ bi(adminOnly.zh, adminOnly.en) }}
    </p>
  </section>
</template>

<script setup lang="ts">
// BOM备料 数据来源 —— the picker that ends "SSH in, edit the env file, restart the backend".
//
// WHAT IT IS FOR. The stock-preparation pull action reads a customer's BOM out of ONE external
// system, and until now which one was pinned in a server env var read at plugin activation. Every
// new customer therefore needed an implementer with a shell just to say "read our PLM, not the demo
// database". This panel is that sentence, as a dropdown; the server persists it and resolves it per
// request, so the next 同步 uses it with no restart.
//
// WHO SEES WHAT (R-11 — what is not permitted must not be visible):
//   * a platform admin gets the current source, the candidate list, and Save;
//   * a `stock-prep:admin` holder who can open the 数据来源与体检 tab gets the current source and is told
//     who changes it. They are NOT shown a Save that would 403, and the panel does not call the
//     admin-tier routes on their behalf.
// `canRunStockPrepInstall` is reused rather than a new predicate invented: it already means "this
// caller holds `integration:admin`", which is exactly the tier both source-binding routes require.
//
// THE PAGE DECIDES NOTHING ABOUT ELIGIBILITY. `eligibleSources` arrives already filtered by the
// server — the two BOM read kinds only, active only, non-write roles only, and only data sources
// this principal may actually use (#5401 is owner-only; being an admin does not make a colleague's
// connection yours). Re-deriving any of that here would be a second authority that drifts. The page
// renders the list it is given, and a refusal is rendered from the server's own closed reason token.
//
// PLAIN LANGUAGE FIRST (#5391 register), identifier second. The name an admin recognises leads;
// the connector kind is shown in words from 对接总览's own register ("只读数据库桥接"), not as a raw
// token; the id sits beside it in a <code> because an implementer greps for it.
//
// BINDING/ERROR PROJECTION IS VALUES-FREE. Ids, kinds, status enums, operator-authored connection
// names, and committed plain-language constants may render from the server. No server message text
// ever reaches the DOM — only an HTTP status and a closed reason token — so this projection cannot
// quote a customer value or credential. The separate local role draft can display user-entered
// schema metadata, but never logs, persists, or sends it automatically.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import { useAuth } from '../../../composables/useAuth'
import { onAuthPrincipalChange, onAuthSessionSwitch, readAuthSessionSignature } from '../../../composables/authPrincipal'
import type { IntegrationScope } from '../../../services/integration/workbench'
import { canRunStockPrepInstall } from '../../../services/integration/stockPreparation/workbenchAccess'
import type { StockPrepGettingStartedBinding } from '../../../services/integration/stockPreparation/gettingStarted'
import {
  countDataSourceBackedCandidates,
  readStockPreparationSourceBinding,
  setStockPreparationSourceBinding,
  stockPrepSourceRefusalText,
  StockPreparationSourceBindingError,
  STOCK_PREPARATION_PULL_ACTION_ID,
  STOCK_PREP_SOURCE_ADMIN_ONLY,
  STOCK_PREP_SOURCE_NO_RESTART,
  STOCK_PREP_SOURCE_ORIGIN_TEXT,
  type StockPreparationSourceBindingView,
  type StockPreparationSourceCandidate,
} from '../../../services/integration/stockPreparation/sourceBinding'
import {
  SOURCE_PLAN_DRAFT_SECTIONS,
  SOURCE_PLAN_DRAFT_MAX_JSON_BYTES,
  compileSourcePlanDraft,
  createEmptySourcePlanDraft,
  createSyntheticSourcePlanDraft,
  parseSourcePlanDraftJson,
  type SourcePlanDraft,
  type SourcePlanDraftIssue,
} from '../../../services/integration/stockPreparation/sourcePlanDraft'
import {
  SOURCE_PLAN_SAMPLE_FIELDS,
  activateSourcePlanVersion,
  approveSourcePlanVersion,
  confirmSourcePlanVersionSample,
  deactivateSourcePlanVersion,
  listSourcePlanVersions,
  saveSourcePlanVersion,
  validateSourcePlanVersionSample,
  SourcePlanVersionsError,
  type SourcePlanDiagnosticCode,
  type SourcePlanSampleField,
  type SourcePlanSampleRow,
  type SourcePlanValidation,
  type SourcePlanVersion,
  type SourcePlanVersionList,
} from '../../../services/integration/stockPreparation/sourcePlanVersions'

const props = defineProps<{ scope: IntegrationScope }>()

/**
 * WHAT THE SERVER SAID ABOUT THE BINDING, handed upward so the getting-started wizard's steps
 * (1b) and (3) can PROJECT this answer instead of re-deriving 「备料用哪条源」 out of the source
 * preflight's topology check (R7). NOT step (1a): `eligibleSources` enumerates external SYSTEMS, so
 * it is silent about whether a DATA SOURCE is registered, and the wizard reads that separately. `null` means "no answer exists" — the read failed, or was never attempted because this
 * caller may not run it — which the wizard renders as 「? 看不到」, never as 「没做」.
 *
 * This is a report, not a control: nothing here becomes a button, so the workbench capability mirror
 * (`workbenchAccess.ts` ↔ the plugin's `.cjs`) is untouched by it.
 */
const emit = defineEmits<{
  (event: 'binding-read', binding: StockPrepGettingStartedBinding | null): void
}>()

const { locale } = useLocale()
const auth = useAuth()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

// The auth snapshot reads browser storage, not reactive Vue state. Invalidate this
// computed value when the existing auth/session notifications or storage checks fire.
const accessRevision = ref(0)
const canBind = computed(() => {
  void accessRevision.value
  return readAuthSessionSignature() !== 'invalid' && canRunStockPrepInstall(auth.getAccessSnapshot())
})

const busy = ref(false)
const errorStatus = ref<number | null>(null)
const refusalReason = ref<string | null>(null)
const view = ref<StockPreparationSourceBindingView | null>(null)
// Last-read picker metadata is not an observation of the currently effective binding.
const candidates = ref<StockPreparationSourceCandidate[]>([])
const selected = ref('')
const pending = ref<StockPreparationSourceCandidate | null>(null)
const pendingScopeCreation = ref(false)
const saved = ref(false)
const unconfirmed = ref(false)

// The draft is intentionally born empty and stays local to this component. In particular, never
// initialise it from the server-held read plan: a reviewer must be able to tell it is not a claim
// about the currently bound source or deployed configuration.
const draft = ref<SourcePlanDraft>(createEmptySourcePlanDraft())
const draftIssues = ref<SourcePlanDraftIssue[]>([])
const draftPreview = ref<string | null>(null)
const draftGeneration = ref(0)
let draftComponentMounted = true
let sessionGeneration = 0

const planManagement = ref(false)
const planTargetSystemId = ref('')
const planProjectNo = ref('')
const selectedPlanVersionId = ref('')
const planState = ref<SourcePlanVersionList | null>(null)
const planBusy = ref(false)
const planErrorStatus = ref<number | null>(null)
const planErrorCode = ref<SourcePlanDiagnosticCode | undefined>(undefined)
const planClock = ref(Date.now())
let planGeneration = 0
let sampleGeneration = 0
let receiptTimer: number | null = null
const RECEIPT_WINDOW_MS = 15 * 60 * 1000
const SAMPLE_FIELD_LABELS: Record<SourcePlanSampleField, { zh: string; en: string }> = {
  componentSourceId: { zh: '组件来源编号', en: 'Component source id' },
  parentSourceId: { zh: '上级来源编号', en: 'Parent source id' },
  path: { zh: '路径', en: 'Path' },
  depth: { zh: '层级', en: 'Depth' },
  componentCode: { zh: '组件编码', en: 'Component code' },
  componentName: { zh: '组件名称', en: 'Component name' },
  material: { zh: '材料', en: 'Material' },
  sourceVersion: { zh: '物料来源版本', en: 'Material source version' },
  orderBomVersion: { zh: '订单指定 BOM 版本', en: 'Order-requested BOM version' },
  rawQuantity: { zh: '原始数量', en: 'Raw quantity' },
  totalQuantity: { zh: '合计数量', en: 'Total quantity' },
  active: { zh: '有效', en: 'Active' },
  spec: { zh: '规格', en: 'Specification' },
  sortLine: { zh: '排序行', en: 'Sort line' },
}
// Sample rows belong only to the response that delivered them. A list summary
// cannot confirm them, and a later context must not put that table back.
type PlanSampleView = {
  systemId: string
  versionId: string
  contentKey: string
  projectNo: string
  validation: SourcePlanValidation
  sample: { rows: SourcePlanSampleRow[]; totalRows: number; displayedRows: number; truncated: boolean }
}
const planSample = ref<PlanSampleView | null>(null)
type PlanAction = 'approve' | 'activate' | 'deactivate'
type PlanContext = { local: LocalContext; generation: number; systemId: string }
type PendingPlanAction = {
  action: PlanAction
  context: PlanContext
  versionId: string
  contentKey: string
  expectedGeneration: number
}
const pendingPlanAction = ref<PendingPlanAction | null>(null)
const pendingDraftCopy = ref<{ context: PlanContext; versionId: string; contentKey: string; draftGeneration: number } | null>(null)

type LocalContext = { generation: number; session: string; scope: IntegrationScope }

function sessionSignature(): string {
  try {
    return JSON.stringify([readAuthSessionSignature(), localStorage.getItem('user_permissions'), localStorage.getItem('user_roles')])
  } catch {
    return 'invalid'
  }
}

let displayedSession = sessionSignature()

function invalidateSession(): void {
  if (!draftComponentMounted) return
  sessionGeneration += 1
  accessRevision.value += 1
  displayedSession = sessionSignature()
  draft.value = createEmptySourcePlanDraft()
  invalidateDraftPreview()
  view.value = null
  candidates.value = []
  selected.value = ''
  pending.value = null
  saved.value = false
  unconfirmed.value = false
  errorStatus.value = null
  refusalReason.value = null
  planManagement.value = false
  planTargetSystemId.value = ''
  resetPlanManagement()
  // An already-issued request may still finish on the server. Keep busy until its
  // actual promise settles; invalidating local state does not cancel that request.
  publishBinding()
}

function checkSession(): void {
  if (!draftComponentMounted) return
  if (displayedSession !== sessionSignature()) invalidateSession()
  accessRevision.value += 1
}

function captureContext(): LocalContext | null {
  checkSession()
  if (!draftComponentMounted || !canBind.value) return null
  return {
    generation: sessionGeneration,
    session: sessionSignature(),
    scope: { tenantId: props.scope.tenantId, workspaceId: props.scope.workspaceId },
  }
}

function isCurrent(context: LocalContext): boolean {
  checkSession()
  return draftComponentMounted && canBind.value
    && context.generation === sessionGeneration && context.session === sessionSignature()
    && context.scope.tenantId === props.scope.tenantId && context.scope.workspaceId === props.scope.workspaceId
}

const unsubscribePrincipal = onAuthPrincipalChange(invalidateSession)
const unsubscribeSession = onAuthSessionSwitch(invalidateSession)
window.addEventListener('storage', checkSession)
window.addEventListener('focus', checkSession)
watch([() => props.scope.tenantId, () => props.scope.workspaceId], invalidateSession, { flush: 'sync' })

const noRestart = STOCK_PREP_SOURCE_NO_RESTART
const adminOnly = STOCK_PREP_SOURCE_ADMIN_ONLY

const refusalText = computed(() => stockPrepSourceRefusalText(refusalReason.value))

/** Why the CURRENTLY effective source cannot be read, in words. Same closed vocabulary as a refusal. */
const problemText = computed(() => stockPrepSourceRefusalText(view.value?.effectiveSourceProblem ?? null))

// Degrade rather than blank: a server that grows a fourth origin token, or an envelope that omits
// the field, renders the "nothing chosen" line instead of throwing on an undefined lookup.
function bindingMatchesScope(binding: StockPreparationSourceBindingView['persistedBinding'], scope: IntegrationScope): boolean {
  return binding !== null && typeof binding === 'object'
    && typeof scope.tenantId === 'string' && scope.tenantId.length > 0
    && binding.tenantId === scope.tenantId && binding.workspaceId === (scope.workspaceId ?? null)
}

const persistedBindingOutsideScope = computed(() => {
  const binding = view.value?.persistedBinding
  return Boolean(binding) && !bindingMatchesScope(binding ?? null, props.scope)
})
const canSaveSelectedSource = computed(() => Boolean(selected.value)
  && (selected.value !== view.value?.effectiveExternalSystemId || persistedBindingOutsideScope.value))
const originText = computed(() => persistedBindingOutsideScope.value
  ? { zh: '当前生效来源来自其他范围的绑定，不是当前范围的精确绑定。',
    en: 'The effective source comes from another scope, not an exact binding in the current scope.' }
  : (view.value && STOCK_PREP_SOURCE_ORIGIN_TEXT[view.value.origin]) || STOCK_PREP_SOURCE_ORIGIN_TEXT.unconfigured)

/** The bound system's NAME when the candidate list knows it, else its id — never a blank line. */
const currentName = computed(() => {
  const id = view.value?.effectiveExternalSystemId
  if (!id) return bi('尚未设置', 'not set yet')
  const match = candidates.value.find((candidate) => candidate.externalSystemId === id)
  return match?.name || id
})

const pendingName = computed(() => pending.value?.name || pending.value?.externalSystemId || '')

/** Name first, kind in words, id last — the #5391 order. */
function optionLabel(candidate: StockPreparationSourceCandidate): string {
  const kind = locale.value === 'zh-CN' ? candidate.kindLabel?.zh : candidate.kindLabel?.en
  const parts = [candidate.name || candidate.externalSystemId]
  if (kind) parts.push(`(${kind})`)
  return parts.join(' ')
}

const validPlanTarget = computed(() => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(planTargetSystemId.value))
const selectedPlanVersion = computed(() => planState.value?.versions.find((row) => row.id === selectedPlanVersionId.value) ?? null)
const canDeactivatePlan = computed(() => planState.value?.activation?.status === 'active'
  && planState.value.activation.systemId === planTargetSystemId.value)
const selectedReceiptOpen = computed(() => receiptOpen(selectedPlanVersion.value?.validation, selectedPlanVersion.value?.validationId))
const canCopyPlanDraft = computed(() => Boolean(selectedPlanVersion.value && !planBusy.value && canBind.value
  && readAuthSessionSignature() !== 'invalid'))
const canValidatePlan = computed(() => Boolean(selectedPlanVersion.value && selectedPlanVersion.value.status !== 'retired'
  && !planBusy.value && validPlanProject(planProjectNo.value)))
const canConfirmPlanSample = computed(() => {
  const sample = planSample.value
  const version = selectedPlanVersion.value
  if (!sample || !version || planBusy.value || !version.validation) return false
  const expiresAt = Date.parse(sample.validation.expiresAt)
  return sample.systemId === planTargetSystemId.value
    && sample.versionId === version.id
    && sample.contentKey === version.contentKey
    && sample.projectNo === planProjectNo.value.trim()
    && sample.validation.status === 'passed'
    && sample.validation.counts !== null
    && sample.validation.validationId === version.validationId
    && version.validation.status === 'passed'
    && version.validation.validationId === sample.validation.validationId
    && Number.isFinite(expiresAt)
    && planClock.value < expiresAt
})
const planErrorText = computed(() => {
  switch (planErrorCode.value) {
    case 'READ_PLAN_VALIDATION_CATALOG_UNVERIFIED':
      return bi('物理列核对未通过。请重新读取版本，检查已保存版本的对象和字段映射，修正并保存后手动核对样本；物理列匹配不代表业务含义正确。', 'Physical column verification did not pass. Reload the versions, check the saved version’s object and field mappings, correct and save them, then check the sample manually; matching physical columns does not verify business meaning.')
    case 'READ_PLAN_VALIDATION_INCOMPLETE':
      return bi('样本读取不完整，未通过核对；这不代表零数据或读取成功。请重新读取版本，检查项目号、映射和读取限制，修正后手动重新核对。', 'The sample read was incomplete and did not pass verification; this does not mean zero data or a successful read. Reload the versions, check the project number, mappings and read limits, then check again manually after correcting them.')
    case 'READ_PLAN_VALIDATION_TIMEOUT':
      return bi('样本核对已超时，未通过核对；正在进行的来源调用可能仍会完成，超时不代表已取消。请先确认来源状态和读取范围，手动重新读取版本后再决定何时手动重新核对。', 'The sample check timed out and did not pass verification; an outstanding source call may still finish, so timeout does not mean cancellation. Check the source status and read scope, then reload the versions manually before deciding when to check again manually.')
    case 'READ_PLAN_VALIDATION_SOURCE_FAILED':
      return bi('来源读取失败，未通过核对。请确认连接可用和读取权限，再手动重新读取版本并核对样本。', 'The source read failed and did not pass verification. Check connection availability and read permissions, then reload the versions and check the sample again manually.')
    case 'READ_PLAN_VALIDATION_EXPIRED':
      return bi('样本回执已过期。请重新读取版本，手动核对并确认新样本后再审批或激活。', 'The sample receipt expired. Reload the versions, manually check and confirm a new sample before approving or activating.')
    case 'READ_PLAN_VALIDATION_REQUIRED':
      return bi('缺少当前已确认的样本回执。请重新读取版本，手动核对并确认样本后再审批或激活。', 'A current confirmed sample receipt is required. Reload the versions, manually check and confirm the sample before approving or activating.')
    case 'READ_PLAN_VALIDATION_SUPERSEDED':
      return bi('样本回执已被后续核对替代。请重新读取版本，手动核对并确认当前样本。', 'A later check replaced this sample receipt. Reload the versions, then manually check and confirm the current sample.')
    case 'READ_PLAN_VALIDATION_SOURCE_CHANGED':
      return bi('来源配置已变化，原样本回执不可继续使用。请重新读取版本，确认来源后手动核对并确认新样本。', 'The source configuration changed and the previous sample receipt cannot be reused. Reload the versions, check the source, then manually check and confirm a new sample.')
    case 'READ_PLAN_VALIDATION_IN_PROGRESS':
      return bi('已有样本核对进行中。请等待该次核对结束后手动重新读取版本，确认状态后再决定下一步。', 'A sample check is already in progress. Wait for it to finish, then reload the versions manually and check the status before choosing the next step.')
    case 'READ_PLAN_GENERATION_CONFLICT':
      return bi('激活记录已被其他操作更新。请重新读取版本和激活状态，再选择并确认操作。', 'Another operation updated the activation record. Reload the versions and activation status, then select and confirm the operation again.')
  }
  if (planErrorStatus.value === 401 || planErrorStatus.value === 403) {
    return bi('需要当前登录租户的平台管理权限及相关连接所有权。请重新确认登录身份和目标。', 'The signed-in tenant requires platform management permission and ownership of the relevant connections. Check the session and target.')
  }
  if (planErrorStatus.value === 409) return bi('版本、激活或样本回执已变化，或当前来源不可用。请重新读取后选择。', 'The version, activation, or sample receipt changed, or the source is unavailable. Reload before choosing again.')
  return bi('读取或保存计划失败。请重新读取后重试。', 'The plan request failed. Reload before retrying.')
})

function clearPlanError(): void {
  planErrorStatus.value = null
  planErrorCode.value = undefined
}

function clearPlanSample(): void {
  pendingDraftCopy.value = null
  sampleGeneration += 1
  planSample.value = null
}

function resetPlanManagement(): void {
  planGeneration += 1
  clearPlanSample()
  planProjectNo.value = ''
  planState.value = null
  selectedPlanVersionId.value = ''
  pendingPlanAction.value = null
  clearPlanError()
  // Busy describes the real outstanding promise, not the displayed context.
}

watch([planManagement, planTargetSystemId], () => {
  resetPlanManagement()
  invalidateDraftPreview()
}, { flush: 'sync' })
watch(selectedPlanVersionId, () => {
  planGeneration += 1
  pendingPlanAction.value = null
  clearPlanSample()
}, { flush: 'sync' })
watch(planProjectNo, (next, previous) => {
  if (next.trim() === (previous ?? '').trim()) return
  clearPlanSample()
}, { flush: 'sync' })
watch(() => selectedPlanVersion.value?.contentKey ?? '', (next, previous) => {
  if (!next || !previous || next === previous) return
  planGeneration += 1
  pendingPlanAction.value = null
  clearPlanSample()
}, { flush: 'sync' })
watch(view, (next, previous) => {
  if (previous && next === null) {
    clearPlanSample()
    clearPlanError()
  }
}, { flush: 'sync' })
watch(() => view.value?.effectiveExternalSystemId ?? '', (next, previous) => {
  if (previous && next !== previous) clearPlanSample()
}, { flush: 'sync' })

function capturePlanContext(): PlanContext | null {
  const local = captureContext()
  if (!local || !planManagement.value || !validPlanTarget.value) return null
  return { local, generation: planGeneration, systemId: planTargetSystemId.value }
}

function isCurrentPlan(context: PlanContext): boolean {
  return isCurrent(context.local) && planManagement.value
    && context.generation === planGeneration && context.systemId === planTargetSystemId.value
}

function planStatusText(status: SourcePlanVersion['status']): string {
  return status === 'draft' ? bi('待审', 'draft') : status === 'approved' ? bi('已审批', 'approved') : bi('已退役', 'retired')
}

function planActionText(action: PlanAction): string {
  return action === 'approve' ? bi('审批此版本', 'Approve this version')
    : action === 'activate' ? bi('激活此版本', 'Activate this version') : bi('停用此激活记录', 'Disable this activation')
}

function validPlanProject(value: string): boolean {
  const projectNo = value.trim()
  return projectNo.length > 0 && projectNo.length <= 128
    && ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

function touchPlanClock(): void {
  planClock.value = Date.now()
}

function receiptOpen(validation: SourcePlanValidation | null | undefined, validationId: string | null | undefined): boolean {
  if (!validation || !validationId || validation.validationId !== validationId) return false
  if (validation.status !== 'confirmed' || validation.counts === null || validation.confirmedAt === null) return false
  const expiresAt = Date.parse(validation.expiresAt)
  return Number.isFinite(expiresAt) && planClock.value < expiresAt
}

function validationStatusText(validation: SourcePlanValidation | null): string {
  if (!validation) return bi('无样本回执', 'no sample receipt')
  if (validation.status === 'pending') return bi('核对进行中', 'check in progress')
  if (validation.status === 'passed') return bi('已读到样本，尚未确认', 'sample read, not confirmed')
  if (validation.status === 'confirmed') return bi('已确认样本', 'sample confirmed')
  return bi('核对未通过', 'check failed')
}

function sampleCellText(row: SourcePlanSampleRow, field: SourcePlanSampleField): string {
  if (!Object.prototype.hasOwnProperty.call(row, field)) return ''
  const value = row[field]
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? bi('是', 'yes') : bi('否', 'no')
  return String(value)
}

function replaceVersionReceipt(versionId: string, contentKey: string, validation: SourcePlanValidation | null): void {
  const state = planState.value
  if (!state) return
  planState.value = {
    ...state,
    versions: state.versions.map((row) => {
      if (row.id !== versionId || row.contentKey !== contentKey) return row
      return { ...row, validationId: validation?.validationId ?? null, validation }
    }),
  }
}

function armReceiptTimer(): void {
  if (receiptTimer !== null) {
    window.clearTimeout(receiptTimer)
    receiptTimer = null
  }
  if (!draftComponentMounted) return
  const instants = [planSample.value?.validation.expiresAt, selectedPlanVersion.value?.validation?.expiresAt]
  const next = instants
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value) && value > Date.now())
    .sort((left, right) => left - right)[0]
  if (next === undefined) return
  const delay = next - Date.now()
  if (delay <= 0 || delay > RECEIPT_WINDOW_MS) return
  receiptTimer = window.setTimeout(() => {
    receiptTimer = null
    if (!draftComponentMounted) return
    touchPlanClock()
  }, delay)
}

watch([planSample, selectedPlanVersion, planClock], () => {
  armReceiptTimer()
})

async function validatePlanSample(): Promise<void> {
  touchPlanClock()
  const context = capturePlanContext()
  const version = selectedPlanVersion.value
  const projectNo = planProjectNo.value.trim()
  if (!context || planBusy.value || !version || version.status === 'retired' || !validPlanProject(planProjectNo.value)) return
  const versionId = version.id
  const contentKey = version.contentKey
  planBusy.value = true
  clearPlanError()
  pendingPlanAction.value = null
  clearPlanSample()
  const generation = sampleGeneration
  replaceVersionReceipt(versionId, contentKey, null)
  try {
    const result = await validateSourcePlanVersionSample(context.systemId, versionId, projectNo)
    if (!isCurrentPlan(context) || generation !== sampleGeneration) return
    if (selectedPlanVersion.value?.id !== versionId || selectedPlanVersion.value.contentKey !== contentKey) return
    if (planProjectNo.value.trim() !== projectNo) return
    if (result.validation.status !== 'passed' || result.canApply !== false
      || result.tokenIssued !== false || result.authorizesExecution !== false) throw new SourcePlanVersionsError(0)
    replaceVersionReceipt(versionId, contentKey, result.validation)
    planSample.value = {
      systemId: context.systemId, versionId, contentKey, projectNo,
      validation: result.validation, sample: result.sample,
    }
  } catch (error) {
    if (isCurrentPlan(context) && generation === sampleGeneration) recordPlanError(error)
  } finally {
    planBusy.value = false
  }
}

async function confirmPlanSample(): Promise<void> {
  touchPlanClock()
  const context = capturePlanContext()
  const sample = planSample.value
  const version = selectedPlanVersion.value
  if (!context || planBusy.value || !sample || !version || !canConfirmPlanSample.value) return
  const generation = sampleGeneration
  const versionId = version.id
  const contentKey = version.contentKey
  const projectNo = sample.projectNo
  const validationId = sample.validation.validationId
  planBusy.value = true
  clearPlanError()
  pendingPlanAction.value = null
  try {
    const validation = await confirmSourcePlanVersionSample(context.systemId, versionId, validationId)
    if (!isCurrentPlan(context) || generation !== sampleGeneration) return
    if (selectedPlanVersion.value?.id !== versionId || selectedPlanVersion.value.contentKey !== contentKey) return
    if (planProjectNo.value.trim() !== projectNo) return
    if (validation.validationId !== validationId || validation.status !== 'confirmed') throw new SourcePlanVersionsError(0)
    replaceVersionReceipt(versionId, contentKey, validation)
    if (planSample.value?.validation.validationId === validationId && planSample.value.versionId === versionId) {
      planSample.value = { ...planSample.value, validation }
    }
  } catch (error) {
    if (isCurrentPlan(context) && generation === sampleGeneration) recordPlanError(error)
  } finally {
    planBusy.value = false
  }
}

function recordPlanError(error: unknown): void {
  planErrorStatus.value = error instanceof SourcePlanVersionsError ? error.status : 0
  planErrorCode.value = error instanceof SourcePlanVersionsError ? error.code : undefined
  planState.value = null
  pendingPlanAction.value = null
  clearPlanSample()
}

async function refreshPlanContext(context: PlanContext): Promise<void> {
  // A list carries the receipt summary only. It must not keep or restore sample rows.
  clearPlanSample()
  const result = await listSourcePlanVersions(context.systemId)
  if (!isCurrentPlan(context)) return
  planState.value = result
  if (!result.versions.some((row) => row.id === selectedPlanVersionId.value)) selectedPlanVersionId.value = ''
}

async function loadPlanVersions(): Promise<void> {
  const context = capturePlanContext()
  if (!context || planBusy.value) return
  planBusy.value = true
  clearPlanError()
  pendingPlanAction.value = null
  planState.value = null
  try {
    await refreshPlanContext(context)
  } catch (error) {
    if (isCurrentPlan(context)) recordPlanError(error)
  } finally {
    planBusy.value = false
  }
}

async function savePlanDraft(): Promise<void> {
  const context = capturePlanContext()
  if (!context || planBusy.value || !planState.value) return
  pendingDraftCopy.value = null
  // Compile at the explicit click, never trust a prior preview or a mutable later form.
  const result = compileSourcePlanDraft(draft.value)
  draftIssues.value = result.issues
  if (!result.ok || !result.envelope) return
  planBusy.value = true
  clearPlanError()
  pendingPlanAction.value = null
  try {
    await saveSourcePlanVersion(context.systemId, result.envelope.readPlan)
    if (!isCurrentPlan(context)) return
    // Saving does not select, approve, activate, or replace the local draft.
    await refreshPlanContext(context)
  } catch (error) {
    if (isCurrentPlan(context)) recordPlanError(error)
  } finally {
    planBusy.value = false
  }
}

function askPlanAction(action: PlanAction): void {
  touchPlanClock()
  const context = capturePlanContext()
  const state = planState.value
  if (!context || planBusy.value || !state) return
  pendingDraftCopy.value = null
  const version = selectedPlanVersion.value
  if (action === 'deactivate') {
    if (!canDeactivatePlan.value || !state.activation) return
    pendingPlanAction.value = {
      action, context, versionId: state.activation.versionId, contentKey: state.activation.contentKey,
      expectedGeneration: state.activation.generation,
    }
    return
  }
  if (!version || version.status !== (action === 'approve' ? 'draft' : 'approved')
    || !receiptOpen(version.validation, version.validationId)) return
  pendingPlanAction.value = {
    action, context, versionId: version.id, contentKey: version.contentKey,
    expectedGeneration: state.activation?.generation ?? 0,
  }
}

async function confirmPlanAction(): Promise<void> {
  touchPlanClock()
  const pendingAction = pendingPlanAction.value
  if (!pendingAction || planBusy.value || !isCurrentPlan(pendingAction.context) || !planState.value) return
  const state = planState.value
  if ((state.activation?.generation ?? 0) !== pendingAction.expectedGeneration) return
  if (pendingAction.action === 'deactivate') {
    if (!canDeactivatePlan.value || state.activation?.versionId !== pendingAction.versionId
      || state.activation.contentKey !== pendingAction.contentKey) return
  } else if (selectedPlanVersion.value?.id !== pendingAction.versionId
    || selectedPlanVersion.value.contentKey !== pendingAction.contentKey
    || selectedPlanVersion.value.status !== (pendingAction.action === 'approve' ? 'draft' : 'approved')
    || !receiptOpen(selectedPlanVersion.value.validation, selectedPlanVersion.value.validationId)) return
  planBusy.value = true
  clearPlanError()
  pendingPlanAction.value = null
  const context = pendingAction.context
  try {
    const result = pendingAction.action === 'approve'
      ? await approveSourcePlanVersion(context.systemId, pendingAction.versionId)
      : pendingAction.action === 'activate'
        ? await activateSourcePlanVersion(context.systemId, pendingAction.versionId, pendingAction.expectedGeneration)
        : await deactivateSourcePlanVersion(context.systemId, pendingAction.expectedGeneration)
    if (!isCurrentPlan(context)) return
    if (result.contentKey !== pendingAction.contentKey) throw new SourcePlanVersionsError(0)
    await refreshPlanContext(context)
  } catch (error) {
    if (isCurrentPlan(context)) recordPlanError(error)
  } finally {
    planBusy.value = false
  }
}

/** Only an HTTP status and the server's closed reason token reach state. */
function recordError(error: unknown): void {
  if (error instanceof StockPreparationSourceBindingError) {
    errorStatus.value = error.status
    refusalReason.value = error.reason
    return
  }
  errorStatus.value = 0
  refusalReason.value = null
}

/** The upward projection of whatever `view` now holds — or `null` for "this page has no answer". */
function publishBinding(): void {
  emit('binding-read', view.value
    ? {
        effectiveExternalSystemId: view.value.effectiveExternalSystemId,
        eligibleSourceCount: Array.isArray(view.value.eligibleSources) ? view.value.eligibleSources.length : 0,
        // WHICH ROAD, for the wizard's (1b) evidence line. A subset of the count above, over the
        // `kind` token the server already decided — the page adds no eligibility rule of its own.
        dataSourceBackedSourceCount: countDataSourceBackedCandidates(view.value.eligibleSources),
        // THE ACTION'S OWN FROZEN KIND, as the server resolved it. The wizard needs it to know
        // whether ①a/①b APPLY AT ALL: a `bridge:legacy-sql-readonly` deployment can never be
        // offered a `data-source:sql-readonly` system, so telling it to go register a data source
        // is telling it to do work that cannot help. Projected, never re-derived (R7).
        requiredKind: view.value.effectiveSourceKind,
      }
    : null)
}

function invalidateBindingObservation(): void {
  pendingDraftCopy.value = null
  // A submitted write may have reached the server even if its response is lost. A refresh can
  // likewise discover a concurrent change. Neither operation may keep the previous answer current.
  view.value = null
  saved.value = false
  publishBinding()
}

async function load(): Promise<void> {
  // A non-admin never calls the admin-tier route: the server would refuse, and rendering that
  // refusal as an error would tell them a control exists that does not exist for them.
  // Upward, that is NOT the same as "there is no binding" — it is "nobody asked", so the wizard is
  // told `null` explicitly rather than being left at its own initial null by coincidence.
  const context = captureContext()
  if (!context) {
    if (draftComponentMounted) publishBinding()
    return
  }
  if (busy.value) return
  busy.value = true
  errorStatus.value = null
  refusalReason.value = null
  unconfirmed.value = false
  pending.value = null
  invalidateBindingObservation()
  try {
    const result = await readStockPreparationSourceBinding(context.scope)
    if (!isCurrent(context)) return
    view.value = result
    candidates.value = result.eligibleSources ?? []
    selected.value = view.value.effectiveExternalSystemId || ''
  } catch (error) {
    if (isCurrent(context)) recordError(error)
  } finally {
    busy.value = false
    if (isCurrent(context)) publishBinding()
  }
}

function askToSave(): void {
  if (!captureContext() || busy.value || !canSaveSelectedSource.value) return
  saved.value = false
  unconfirmed.value = false
  errorStatus.value = null
  refusalReason.value = null
  pendingScopeCreation.value = persistedBindingOutsideScope.value
  pending.value = candidates.value.find((candidate) => candidate.externalSystemId === selected.value) || null
}

function invalidateDraftPreview(): number {
  pendingDraftCopy.value = null
  // A preview is a candidate for exactly one input state. Do not leave a previous valid JSON on
  // screen after an edit, where it could be downloaded as though it described the edited form.
  draftGeneration.value += 1
  draftPreview.value = null
  draftIssues.value = []
  return draftGeneration.value
}

function askCopyPlanDraft(): void {
  const context = capturePlanContext()
  const version = selectedPlanVersion.value
  if (!context || !version || !canCopyPlanDraft.value) return
  pendingPlanAction.value = null
  const generation = invalidateDraftPreview()
  pendingDraftCopy.value = { context, versionId: version.id, contentKey: version.contentKey, draftGeneration: generation }
}

function confirmCopyPlanDraft(): void {
  const pendingCopy = pendingDraftCopy.value
  pendingDraftCopy.value = null
  if (!pendingCopy || !canCopyPlanDraft.value || !isCurrentPlan(pendingCopy.context)
    || pendingCopy.draftGeneration !== draftGeneration.value) return
  const version = selectedPlanVersion.value
  if (!version || version.id !== pendingCopy.versionId || version.contentKey !== pendingCopy.contentKey) return
  const generation = invalidateDraftPreview()
  const parsed = parseSourcePlanDraftJson(JSON.stringify({
    schemaVersion: 1, kind: 'stock-preparation-plm-role-draft', status: 'confirm-required',
    validation: 'structure-only', readPlan: version.config.readPlan,
  }))
  applyImportedDraftResult(generation, parsed)
}

function loadSyntheticDraft(): void {
  if (!captureContext()) return
  draft.value = createSyntheticSourcePlanDraft()
  invalidateDraftPreview()
}

function importDraftFile(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // Reset allows an admin to deliberately retry the same file; no file object is retained.
  input.value = ''
  const context = captureContext()
  if (!context || !file) return
  const generation = invalidateDraftPreview()
  if (file.size > SOURCE_PLAN_DRAFT_MAX_JSON_BYTES) {
    applyImportedDraftResult(generation, {
      ok: false,
      draft: null,
      issues: [{
        path: 'draft',
        code: 'payload-too-large',
        zh: '待审 JSON 超过 128 KiB 限制',
        en: 'Review JSON exceeds the 128 KiB limit',
      }],
    })
    return
  }

  const reader = new FileReader()
  reader.onload = () => {
    if (!isCurrent(context) || generation !== draftGeneration.value) return
    const text = typeof reader.result === 'string' ? reader.result : ''
    applyImportedDraftResult(generation, parseSourcePlanDraftJson(text))
  }
  const readFailure = () => {
    if (!isCurrent(context)) return
    applyImportedDraftResult(generation, {
      ok: false,
      draft: null,
      issues: [{
        path: 'draft',
        code: 'invalid-json',
        zh: '待审 JSON 无法读取',
        en: 'Review JSON cannot be read',
      }],
    })
  }
  reader.onerror = readFailure
  try {
    reader.readAsText(file)
  } catch {
    readFailure()
  }
}

function applyImportedDraftResult(
  generation: number,
  result: { ok: boolean; draft: SourcePlanDraft | null; issues: SourcePlanDraftIssue[] },
): void {
  // The user can type, load a synthetic sample, or choose another file while FileReader is still
  // resolving. A stale result must never overwrite that later local action (or an unmounted view).
  if (!draftComponentMounted || generation !== draftGeneration.value) return
  // A user may have previewed the pre-import form while the reader was pending. That JSON no
  // longer describes either the successfully imported draft or the preserved form after a failed
  // import, so it must disappear before applying either result.
  draftPreview.value = null
  draftIssues.value = result.issues
  if (result.ok && result.draft) draft.value = result.draft
}

function previewDraft(): void {
  if (!captureContext()) return
  const result = compileSourcePlanDraft(draft.value)
  draftIssues.value = result.issues
  draftPreview.value = result.ok && result.envelope
    ? JSON.stringify(result.envelope, null, 2)
    : null
}

function hasDraftIssue(path: string): boolean {
  return draftIssues.value.some((item) => item.path === path)
}

function issueLabel(item: SourcePlanDraftIssue): string {
  if (item.path === 'maxReadCount') return bi('读取调用预算（次）', 'Read-call budget')
  const parts = item.path.split('.')
  if (parts[0] === 'roles' && parts.length >= 2) {
    const section = SOURCE_PLAN_DRAFT_SECTIONS.find((candidate) => candidate.key === parts[1])
    if (section) {
      if (parts.length === 2) return bi(section.zh, section.en)
      const field = section.fields.find((candidate) => candidate.key === parts[2])
      if (field) return `${bi(section.zh, section.en)} / ${bi(field.zh, field.en)}`
    }
  }
  // Compiler paths are fixed, non-value-bearing structural names. Keep an honest fallback for a
  // future validation path rather than discarding the explanation or exposing input contents.
  return bi(`字段 ${item.path}`, `Field ${item.path}`)
}

function downloadDraft(): void {
  if (!captureContext() || !draftPreview.value) return
  const objectUrl = URL.createObjectURL(new Blob([draftPreview.value], { type: 'application/json;charset=utf-8' }))
  try {
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = 'stock-preparation-plm-role-draft.review.json'
    link.click()
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
  }
}

function readbackConfirmsSelectedSource(
  readback: StockPreparationSourceBindingView,
  selectedId: string,
  scope: IntegrationScope,
): boolean {
  // readEnvelope casts the JSON, so only an absent problem may count. Objects,
  // booleans, and other non-null values must not confirm the save as live.
  // A getter fallback may report the same effective source from another scope;
  // only the exact persisted tuple can confirm this captured scope's write.
  const problem: unknown = readback.effectiveSourceProblem
  return readback.actionId === STOCK_PREPARATION_PULL_ACTION_ID
    && readback.origin === 'persisted'
    && bindingMatchesScope(readback.persistedBinding, scope)
    && readback.persistedBinding?.actionId === STOCK_PREPARATION_PULL_ACTION_ID
    && readback.persistedBinding?.externalSystemId === selectedId
    && readback.effectiveExternalSystemId === selectedId
    && (problem === null || problem === undefined)
    && readback.takesEffectWithoutRestart === true
}

async function save(): Promise<void> {
  const context = captureContext()
  const target = pending.value
  if (!context || !target || busy.value) return
  const selectedId = target.externalSystemId
  busy.value = true
  errorStatus.value = null
  refusalReason.value = null
  saved.value = false
  unconfirmed.value = false
  invalidateBindingObservation()
  try {
    await setStockPreparationSourceBinding(context.scope, selectedId)
    if (!isCurrent(context)) return
    pending.value = null
    // The write is not claimed live until this same captured scope's readback confirms
    // the selected source. A failed or disagreeing read is not written again.
    let readback: StockPreparationSourceBindingView | null = null
    try {
      readback = await readStockPreparationSourceBinding(context.scope)
    } catch {
      readback = null
    }
    if (!isCurrent(context)) return
    if (readback) {
      view.value = readback
      candidates.value = readback.eligibleSources ?? []
      selected.value = readback.effectiveExternalSystemId || ''
    }
    const confirmed = readback !== null && readbackConfirmsSelectedSource(readback, selectedId, context.scope)
    saved.value = confirmed
    unconfirmed.value = !confirmed
  } catch (error) {
    if (isCurrent(context)) {
      recordError(error)
      pending.value = null
      saved.value = false
      unconfirmed.value = false
    }
  } finally {
    busy.value = false
    if (isCurrent(context)) publishBinding()
  }
}

onMounted(load)

onBeforeUnmount(() => {
  draftComponentMounted = false
  if (receiptTimer !== null) {
    window.clearTimeout(receiptTimer)
    receiptTimer = null
  }
  sessionGeneration += 1
  draftGeneration.value += 1
  unsubscribePrincipal()
  unsubscribeSession()
  window.removeEventListener('storage', checkSession)
  window.removeEventListener('focus', checkSession)
})

defineExpose({ load })
</script>

<style scoped>
.stock-prep-source {
  margin-bottom: var(--ms-space-4);
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
}

.stock-prep-source__h3 {
  margin: 0 0 var(--ms-space-2);
  font-size: 14px;
  font-weight: 600;
}

.stock-prep-source__intro,
.stock-prep-source__origin,
.stock-prep-source__empty,
.stock-prep-source__readonly {
  margin: 0 0 var(--ms-space-2);
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.6;
}

.stock-prep-source__no-restart {
  margin: 0 0 var(--ms-space-2);
  color: var(--el-color-success, #4c9a5a);
  font-size: 13px;
}

.stock-prep-source__current {
  margin: 0 0 var(--ms-space-1);
  font-size: 13px;
}

.stock-prep-source__error {
  margin: 0 0 var(--ms-space-2);
  color: var(--el-color-danger, #c45656);
  font-size: 13px;
}

.stock-prep-source__problem {
  margin: 0 0 var(--ms-space-2);
  color: var(--el-color-warning, #b88230);
  font-size: 13px;
  line-height: 1.6;
}

.stock-prep-source__token {
  margin-left: var(--ms-space-1);
  padding: 0 4px;
  border-radius: 3px;
  background: var(--ms-bg-hover);
  color: var(--ms-text-3);
  font-size: 12px;
}

.stock-prep-source__picker {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-2);
  align-items: center;
  margin-bottom: var(--ms-space-2);
}

.stock-prep-source__label {
  font-size: 13px;
  color: var(--ms-text-2);
}

.stock-prep-source__select {
  min-width: 260px;
  padding: 4px 6px;
  border: 1px solid var(--ms-border-light);
  border-radius: 4px;
  font-size: 13px;
}

.stock-prep-source__save,
.stock-prep-source__cancel {
  padding: 4px 12px;
  border: 1px solid var(--ms-border-light);
  border-radius: 4px;
  background: var(--ms-bg-page);
  font-size: 13px;
  cursor: pointer;
}

.stock-prep-source__save:disabled,
.stock-prep-source__cancel:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.stock-prep-source__confirm {
  margin-bottom: var(--ms-space-2);
  padding: var(--ms-space-2);
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: var(--ms-bg-hover);
}

.stock-prep-source__confirm-text,
.stock-prep-source__confirm-note {
  margin: 0 0 var(--ms-space-2);
  font-size: 13px;
  line-height: 1.6;
}

.stock-prep-source__saved {
  margin: 0;
  color: var(--el-color-success, #4c9a5a);
  font-size: 13px;
}

.stock-prep-source__unconfirmed {
  margin: 0;
  color: var(--el-color-warning, #b88230);
  font-size: 13px;
  line-height: 1.6;
}

.stock-prep-source__draft {
  margin-top: var(--ms-space-3);
  padding-top: var(--ms-space-3);
  border-top: 1px solid var(--ms-border-light);
}

.stock-prep-source__draft summary {
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
}

.stock-prep-source__draft-note,
.stock-prep-source__draft-review,
.stock-prep-source__draft-issues {
  margin: var(--ms-space-2) 0;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.6;
}

.stock-prep-source__draft-issues {
  padding-left: 20px;
  color: var(--el-color-danger, #c45656);
}

.stock-prep-source__draft-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: var(--ms-space-2);
  margin-bottom: var(--ms-space-2);
}

.stock-prep-source__draft-button {
  padding: 4px 12px;
  border: 1px solid var(--ms-border-light);
  border-radius: 4px;
  background: var(--ms-bg-page);
  font-size: 13px;
  cursor: pointer;
}

.stock-prep-source__draft-button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.stock-prep-source__draft-management-toggle {
  display: block;
  margin-top: var(--ms-space-3);
  font-size: 13px;
}

.stock-prep-source__draft-online {
  margin-top: var(--ms-space-2);
  padding: var(--ms-space-2);
  border: 1px solid var(--ms-border-light);
  border-radius: 4px;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.6;
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
}

.stock-prep-source__draft-versions {
  padding-left: 0;
  list-style: none;
}

.stock-prep-source__draft-budget,
.stock-prep-source__draft-import,
.stock-prep-source__draft-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--ms-text-2);
  font-size: 13px;
}

.stock-prep-source__draft-budget input,
.stock-prep-source__draft-field input {
  min-width: 150px;
  padding: 4px 6px;
  border: 1px solid var(--ms-border-light);
  border-radius: 4px;
  font-size: 13px;
}

.stock-prep-source__draft-section {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--ms-space-2);
  margin: var(--ms-space-2) 0;
  padding: var(--ms-space-2);
  border: 1px solid var(--ms-border-light);
  border-radius: 4px;
}

.stock-prep-source__draft-section legend {
  padding: 0 4px;
  color: var(--ms-text-1);
  font-size: 13px;
  font-weight: 600;
}

.stock-prep-source__draft-json {
  max-height: 320px;
  overflow: auto;
  margin: var(--ms-space-2) 0;
  padding: var(--ms-space-2);
  border-radius: 4px;
  background: var(--ms-bg-hover);
  font-size: 12px;
  line-height: 1.5;
}

.stock-prep-source__sample-panel {
  margin: var(--ms-space-2) 0;
  min-width: 0;
  max-width: 100%;
}

.stock-prep-source__sample-scroll {
  display: block;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  max-height: 320px;
  overflow-x: auto;
  overflow-y: auto;
}

.stock-prep-source__sample-scroll:focus-visible {
  outline: 2px solid var(--el-color-primary, #409eff);
  outline-offset: 2px;
}

.stock-prep-source__sample {
  width: max-content;
  min-width: 1100px;
  border-collapse: collapse;
  font-size: 12px;
  line-height: 1.4;
}

.stock-prep-source__sample caption {
  caption-side: bottom;
  padding: var(--ms-space-2) 0;
  color: var(--ms-text-2);
  text-align: left;
  white-space: normal;
  overflow-wrap: normal;
  word-break: normal;
}

.stock-prep-source__sample th,
.stock-prep-source__sample td {
  padding: 4px 8px;
  border: 1px solid var(--ms-border-light);
  text-align: left;
  vertical-align: top;
  white-space: nowrap;
  overflow-wrap: normal;
  word-break: normal;
}

.stock-prep-source__sample th code {
  display: block;
  margin-top: 2px;
  font-weight: 400;
}
</style>
