<template>
  <div
    class="approval-node-config-editor"
    data-testid="approval-node-config-editor"
    :data-node-key="node.key"
    :data-node-type="node.type"
  >
    <!-- G-2: editable condition node (rules / conjunction / default fall-through edge).
         Topology (which branches exist, their edgeKeys/targets) is NOT editable here — only
         the matching LOGIC. Branch add/remove is a later slice. -->
    <div
      v-if="node.type === 'condition' && conditionEditFor(node.key)"
      class="template-authoring__condition"
      data-testid="approval-condition-editor"
      :data-condition-node="node.key"
    >
      <!-- D0 §4.1: the evaluation-order hint lives once, in the condition inspector header —
           verbatim string, do not duplicate elsewhere in this component.
           M8 honesty (P1-2 same class): "全部不满足时走默认分支" is only true when a default IS
           configured — with no defaultEdgeKey the runtime falls through to the FIRST outgoing
           edge instead (see the default card's gated copy below, same predicate). Gating
           VISIBILITY (not the string, which stays verbatim) keeps "lives once" satisfied (count
           is 0 or 1, never 2+) without asserting a routing fact this node doesn't have. -->
      <p
        v-if="conditionEditFor(node.key)!.defaultEdgeKey"
        class="template-authoring__condition-order-hint"
        data-testid="approval-condition-order-hint"
      >
        分支按优先级从上到下依次判断，全部不满足时走默认分支。
      </p>
      <div
        v-for="(branch, branchIndex) in conditionEditFor(node.key)!.branches"
        :key="branch.edgeKey"
        class="template-authoring__condition-branch"
        data-testid="approval-condition-branch"
      >
        <div class="template-authoring__condition-branch-head">
          <!-- D0 §4.1 / P1-D: branch order IS priority — never expose the array-index mechanic as
               such, only the ordinary-user "优先级 N" copy. Priority 1 carries the explicit
               direction cue ("最高") D0 §4.1 mandates so the chips alone communicate evaluation
               order, not just the header hint above. -->
          <span
            class="template-authoring__condition-branch-priority"
            data-testid="approval-condition-branch-priority"
          >优先级 {{ branchIndex + 1 }}{{ branchIndex === 0 ? ' 最高' : '' }}</span>
          <span>分支「{{ liveBranchSummary(branch) }}」</span>
          <el-select
            :model-value="branch.predicateMode"
            size="small"
            :disabled="readOnly"
            class="ms-w-130"
            data-testid="approval-condition-predicate-mode"
            @update:model-value="(mode: string) => setConditionBranchPredicateMode(branch, mode)"
          >
            <el-option label="简单规则" value="rules" />
            <el-option label="公式" value="formula" />
          </el-select>
          <el-select
            v-if="branch.predicateMode === 'rules'"
            v-model="branch.conjunction"
            size="small"
            :disabled="readOnly"
            class="ms-w-110"
            data-testid="approval-condition-conjunction"
          >
            <el-option label="全部满足 (AND)" value="and" />
            <el-option label="任一满足 (OR)" value="or" />
          </el-select>
        </div>
        <template v-if="branch.predicateMode === 'rules'">
          <div
            v-for="(rule, ruleIndex) in branch.rules"
            :key="ruleIndex"
            class="template-authoring__condition-rule"
            data-testid="approval-condition-rule"
          >
            <el-select
              v-model="rule.fieldId"
              size="small"
              filterable
              placeholder="字段"
              :disabled="readOnly"
              class="ms-w-160"
              data-testid="approval-condition-rule-field"
            >
              <el-option
                v-for="field in conditionFieldOptions"
                :key="field.id"
                :label="field.label"
                :value="field.id"
              />
            </el-select>
            <el-select
              v-model="rule.operator"
              size="small"
              :disabled="readOnly"
              class="ms-w-120"
              data-testid="approval-condition-rule-operator"
            >
              <el-option
                v-for="operator in CONDITION_RULE_OPERATORS"
                :key="operator"
                :label="conditionOperatorLabel(operator)"
                :value="operator"
              />
            </el-select>
            <el-input
              v-if="rule.operator !== 'isEmpty'"
              :model-value="conditionRuleValueText(rule)"
              size="small"
              placeholder="比较值"
              :disabled="readOnly"
              class="ms-w-160"
              data-testid="approval-condition-rule-value"
              @update:model-value="(text: string) => setConditionRuleValue(rule, text)"
            />
            <el-button
              size="small"
              type="danger"
              :disabled="readOnly || branch.rules.length === 1"
              data-testid="approval-condition-rule-remove"
              @click="removeConditionRule(branch, ruleIndex)"
            >删除</el-button>
          </div>
        </template>
        <el-button
          v-if="branch.predicateMode === 'rules'"
          size="small"
          :disabled="readOnly"
          data-testid="approval-condition-rule-add"
          @click="addConditionRule(branch)"
        >
          <el-icon><Plus /></el-icon>
          添加规则
        </el-button>
        <div
          v-else
          class="template-authoring__condition-formula"
          data-testid="approval-condition-formula"
        >
          <el-input
            v-model="branch.formulaExpression"
            type="textarea"
            :rows="3"
            :disabled="readOnly"
            placeholder='例如 SUM({purchase_items.amount}) >= 20000'
            data-testid="approval-condition-formula-expression"
          />
          <div class="template-authoring__condition-formula-tools">
            <el-button
              v-for="option in conditionFormulaInsertOptions"
              :key="option.token"
              size="small"
              :disabled="readOnly"
              :title="option.label"
              :data-testid="`approval-condition-formula-insert-${option.token}`"
              @click="insertConditionFormulaToken(branch, option.token)"
            >{{ option.token }}</el-button>
            <el-button
              size="small"
              :disabled="readOnly"
              data-testid="approval-condition-formula-insert-sum"
              @click="insertConditionFormulaFunction(branch, 'SUM')"
            >SUM()</el-button>
            <el-button
              size="small"
              :disabled="readOnly"
              data-testid="approval-condition-formula-insert-count"
              @click="insertConditionFormulaFunction(branch, 'COUNT')"
            >COUNT()</el-button>
            <el-button
              size="small"
              :disabled="readOnly"
              data-testid="approval-condition-formula-insert-min"
              @click="insertConditionFormulaFunction(branch, 'MIN')"
            >MIN()</el-button>
            <el-button
              size="small"
              :disabled="readOnly"
              data-testid="approval-condition-formula-insert-max"
              @click="insertConditionFormulaFunction(branch, 'MAX')"
            >MAX()</el-button>
            <template v-if="formulaRoles.length > 0">
              <span
                class="template-authoring__condition-formula-role-hint"
                data-testid="approval-condition-formula-role-hint"
              >requester.role（审批可用角色）：</span>
              <el-button
                v-for="role in formulaRoles"
                :key="role.id"
                size="small"
                :disabled="readOnly"
                :title="`插入 requester.role in [&quot;${role.id}&quot;]`"
                :data-testid="`approval-condition-formula-insert-role-${role.id}`"
                @click="insertConditionFormulaRoleMembership(branch, role.id)"
              >{{ formatRoleLabel(role) }}</el-button>
            </template>
          </div>
          <div class="template-authoring__condition-formula-dryrun">
            <p
              class="template-authoring__hint"
              data-testid="approval-condition-formula-dry-run-sample-hint"
            >
              使用「测试发布」页的试运行样例值进行测试
            </p>
            <div class="template-authoring__condition-formula-dryrun-actions">
              <el-button
                size="small"
                :loading="conditionFormulaDryRunLoading(node.key, branch.edgeKey)"
                :disabled="readOnly || conditionFormulaDryRunLoading(node.key, branch.edgeKey)"
                data-testid="approval-condition-formula-dry-run-button"
                @click="dryRunConditionFormula(node.key, branch)"
              >测试公式</el-button>
              <span
                v-if="conditionFormulaDryRunResult(node.key, branch.edgeKey)"
                class="template-authoring__condition-formula-dryrun-result"
                data-testid="approval-condition-formula-dry-run-result"
              >
                {{ conditionFormulaDryRunResult(node.key, branch.edgeKey) }}
              </span>
            </div>
          </div>
        </div>
      </div>
      <!-- D0 §4.1 / P1-D: the default (fall-through) branch is presented as an explanatory card,
           visually de-emphasized from the ordered branch cards above, and excluded from rule
           editing. It is not a mutable topology affordance in this slice — no delete/duplicate is
           mounted here (a future slice may add branch delete with its own authorization).
           M8 honesty: the explanatory copy is gated on a real `defaultEdgeKey` — when none is
           designated, the runtime falls through to the FIRST outgoing edge
           (ApprovalGraphExecutor.resolveConditionTarget), never an undefined "default flow", so
           the empty state must say that plainly instead of asserting a default path exists. -->
      <div
        class="template-authoring__condition-branch template-authoring__condition-default-card"
        data-testid="approval-condition-default-branch"
      >
        <div class="template-authoring__condition-branch-head">
          <span class="template-authoring__condition-branch-priority template-authoring__condition-branch-priority--default">
            默认分支（其他情况）
          </span>
        </div>
        <p
          v-if="conditionEditFor(node.key)!.defaultEdgeKey"
          class="template-authoring__condition-default-copy"
          data-testid="approval-condition-default-copy"
        >
          未满足其他条件时进入默认流程
        </p>
        <p
          v-else
          class="template-authoring__condition-default-copy template-authoring__condition-default-copy--empty"
          data-testid="approval-condition-default-copy-empty"
        >
          未指定默认分支：所有条件都不满足时，流程走向不确定，请指定默认分支。
        </p>
        <el-form-item label="默认分支（无匹配时）" class="template-authoring__condition-default">
          <el-select
            v-model="conditionEditFor(node.key)!.defaultEdgeKey"
            size="small"
            clearable
            :disabled="readOnly"
            class="ms-w-220"
            placeholder="（无默认分支）"
            data-testid="approval-condition-default-edge"
          >
            <el-option
              v-for="edgeKey in conditionOutgoingEdgeKeys(node.key)"
              :key="edgeKey"
              :label="conditionEdgeLabel(node.key, edgeKey)"
              :value="edgeKey"
            />
          </el-select>
        </el-form-item>
      </div>
    </div>

    <!-- G-3: editable parallel node — `joinMode` ONLY (会签 all / 或签 any, both
         backend-accepted). `branches` (fork edges) + `joinNodeKey` are TOPOLOGY: shown
         read-only, preserved byte-for-byte on save. -->
    <div
      v-else-if="node.type === 'parallel' && parallelEditFor(node.key)"
      class="template-authoring__parallel"
      data-testid="approval-parallel-editor"
      :data-parallel-node="node.key"
    >
      <el-form-item label="汇聚模式" class="template-authoring__parallel-join-mode">
        <el-select
          v-model="parallelEditFor(node.key)!.joinMode"
          size="small"
          :disabled="readOnly"
          class="ms-w-240"
          data-testid="approval-parallel-join-mode"
        >
          <el-option
            v-for="mode in PARALLEL_JOIN_MODES"
            :key="mode"
            :label="parallelJoinModeLabel(mode)"
            :value="mode"
          />
        </el-select>
      </el-form-item>
      <!-- branches + join target are preserved topology (not editable here). -->
      <ul class="template-authoring__node-summary" data-testid="approval-parallel-topology">
        <li>并行分支：{{ (node.config as ParallelNodeConfig).branches.map((edgeKey) => graphEdgeTargetLabel(node.key, edgeKey)).join('、') || '（无）' }}</li>
        <li>汇聚节点：{{ (node.config as ParallelNodeConfig).joinNodeKey ? graphNodeLabel((node.config as ParallelNodeConfig).joinNodeKey) : '（无）' }}</li>
      </ul>
    </div>

    <!-- G-4: editable cc node — targetType (用户/角色) + targetIds. The cc node's edges /
         position are TOPOLOGY: preserved byte-for-byte on save. -->
    <div
      v-else-if="node.type === 'cc' && ccEditFor(node.key)"
      class="template-authoring__cc"
      data-testid="approval-cc-editor"
      :data-cc-node="node.key"
    >
      <el-form-item label="抄送类型">
        <el-select
          v-model="ccEditFor(node.key)!.targetType"
          size="small"
          :disabled="readOnly"
          class="ms-w-240"
          data-testid="approval-cc-target-type"
          @change="syncCcOptions(node.key)"
        >
          <el-option
            v-for="targetType in CC_TARGET_TYPES"
            :key="targetType"
            :label="ccTargetTypeLabel(targetType)"
            :value="targetType"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="抄送对象">
        <el-select
          v-if="ccEditFor(node.key)!.targetType === 'user'"
          :model-value="ccEditFor(node.key)!.targetIds"
          multiple
          filterable
          remote
          :remote-method="onUserSearch"
          :loading="directoryUsersLoading"
          size="small"
          :disabled="readOnly"
          class="ms-w-360"
          placeholder="搜索用户名 / 邮箱"
          data-testid="approval-cc-target-ids"
          @update:model-value="(ids: string[]) => setCcTargetIds(node.key, ids)"
          @visible-change="(visible: boolean) => visible && onUserSearch('')"
        >
          <el-option
            v-for="user in directoryUsers"
            :key="user.id"
            :label="formatUserLabel(user)"
            :value="user.id"
          />
        </el-select>
        <el-select
          v-else
          :model-value="ccEditFor(node.key)!.targetIds"
          multiple
          filterable
          size="small"
          :disabled="readOnly"
          class="ms-w-360"
          placeholder="选择角色"
          data-testid="approval-cc-target-ids"
          @update:model-value="(ids: string[]) => setCcTargetIds(node.key, ids)"
          @visible-change="(visible: boolean) => visible && syncCcOptions(node.key)"
        >
          <el-option
            v-for="role in directoryRoles"
            :key="role.id"
            :label="formatRoleLabel(role)"
            :value="role.id"
          />
        </el-select>
      </el-form-item>
    </div>

    <!-- G-5: editable approval node — approver SOURCE only (assigneeSources[0]). The node's
         approvalMode / emptyAssigneePolicy / autoApprovalPolicy + edges are preserved. Legacy
         nodes (no assigneeSources) aren't seeded → fall to the read-only summary below.
         Lock-3 §1.5: the SAME section renders a `handler` node (办理节点) — it reuses the exact roster
         radio-grid + per-kind typed pickers (registry-driven per node TYPE), swapping only the
         type-specific labels + the mode/opinion controls (handler has NO empty-policy / self-approval /
         fallback — M7 no inert controls). -->
    <div
      v-else-if="(node.type === 'approval' || node.type === 'handler') && approvalNodeEditFor(node.key)"
      class="template-authoring__approval-node"
      :data-testid="node.type === 'handler' ? 'handler-node-editor' : 'approval-node-editor'"
      :data-approval-node="node.key"
    >
    <!-- Lock-0 L0-1: this section renders alone when inside the canvas inspector's tabbed
         presentation (activeTabId === 'assignee'); it renders alongside the field-permissions
         section, unchanged, in the flat/list presentation (no tabs context injected). -->
    <section
      v-show="showAssigneeSection"
      class="template-authoring__approval-node-section"
      data-testid="approval-node-section-assignee"
    >
      <!-- Lock-0 L0-2: registry-driven radio-grid roster (replaces the single el-select). §10.3
           constrains the picker to be ONE component with plain labels + a configured summary
           echo, not a specific control shape — a radio grid needs no further delta. -->
      <el-form-item :label="node.type === 'handler' ? '办理人来源' : '审批人来源'">
        <div
          class="approval-node-source-roster"
          role="radiogroup"
          :aria-label="node.type === 'handler' ? '办理人来源' : '审批人来源'"
          data-testid="approval-node-source-roster"
        >
          <label
            v-for="opt in assigneeSourceRosterForNode"
            :key="opt.kind"
            class="approval-node-source-roster-option"
          >
            <input
              type="radio"
              :name="`approval-node-source-kind-${node.key}`"
              :checked="approvalSourceKind(node.key) === opt.kind"
              :disabled="readOnly"
              :data-testid="`approval-node-source-kind-${opt.kind}`"
              @change="() => { setApprovalSourceKind(node.key, opt.kind); syncApprovalNodeOptions(node.key) }"
            />
            <span>{{ opt.label }}</span>
          </label>
        </div>
        <!-- L0-2 / A-4: a persisted source kind outside the registry stays read-only and
             round-trips unchanged — never flattened to a registry default. -->
        <p
          v-if="!isKnownAssigneeSourceKind"
          class="template-authoring__hint template-authoring__hint--warn"
          data-testid="approval-node-source-kind-unknown"
        >当前来源「{{ approvalSourceKind(node.key) }}」不在能力清单中，保留为只读，保存时不会被覆盖或清空</p>
        <!-- D2: configured summary echo (parent §10.3), reusing the existing shared wording. -->
        <p
          v-if="configuredSourceSummaryLine"
          class="template-authoring__hint"
          data-testid="approval-node-source-configured-summary"
        >{{ configuredSourceSummaryLine }}</p>
      </el-form-item>
      <!-- G-B2-18 + D1: typed directory pickers only; no ordinary raw-ID authoring path. -->
      <template v-if="approvalSourceKind(node.key) === 'static_user' || approvalSourceKind(node.key) === 'static_role'">
        <el-form-item v-if="approvalSourceKind(node.key) === 'static_user'" label="选择用户">
          <el-select
            :model-value="approvalSourceIds(node.key)"
            multiple
            filterable
            remote
            :remote-method="onUserSearch"
            :loading="directoryUsersLoading"
            size="small"
            :disabled="readOnly"
            class="ms-w-360"
            placeholder="搜索用户名 / 邮箱"
            data-testid="approval-node-source-user-picker"
            @update:model-value="(ids: string[]) => setApprovalSourceIdsFromPicker(node.key, ids)"
            @visible-change="(visible: boolean) => visible && onUserSearch('')"
          >
            <el-option
              v-for="user in directoryUsers"
              :key="user.id"
              :label="formatUserLabel(user)"
              :value="user.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item v-else label="选择角色">
          <el-select
            :model-value="approvalSourceIds(node.key)"
            multiple
            filterable
            size="small"
            :disabled="readOnly"
            class="ms-w-360"
            placeholder="选择角色"
            data-testid="approval-node-source-role-picker"
            @update:model-value="(ids: string[]) => setApprovalSourceIdsFromPicker(node.key, ids)"
          >
            <el-option
              v-for="role in directoryRoles"
              :key="role.id"
              :label="formatRoleLabel(role)"
              :value="role.id"
            />
          </el-select>
        </el-form-item>
      </template>
      <el-form-item
        v-else-if="approvalSourceKind(node.key) === 'form_field_user'"
        label="表单用户字段"
      >
        <el-select
          :model-value="approvalSourceFieldId(node.key)"
          size="small"
          :disabled="readOnly"
          class="ms-w-240"
          placeholder="选择表单用户字段"
          data-testid="approval-node-source-field"
          @update:model-value="(fieldId: string) => setApprovalSourceFieldId(node.key, fieldId)"
        >
          <el-option
            v-for="field in userFields"
            :key="field.id"
            :label="field.label || '未命名字段'"
            :value="field.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item
        v-else-if="approvalSourceKind(node.key) === 'manager_at_level' || approvalSourceKind(node.key) === 'continuous_managers' || approvalSourceKind(node.key) === 'continuous_dept_heads' || approvalSourceKind(node.key) === 'dept_head_at_level'"
        :label="approvalSourceKind(node.key) === 'manager_at_level' ? '指定上级层级' : approvalSourceKind(node.key) === 'continuous_dept_heads' ? '部门负责人层级数' : approvalSourceKind(node.key) === 'dept_head_at_level' ? '指定部门负责人层级' : '上级层级数'"
      >
        <el-input-number
          :model-value="approvalSourceLevel(node.key)"
          :min="1"
          :max="10"
          :step="1"
          size="small"
          :disabled="readOnly"
          data-testid="approval-node-source-level"
          @update:model-value="(value: number) => setApprovalSourceLevel(node.key, value ?? 1)"
        />
      </el-form-item>
      <!-- Lock-1 §K2 (提交人自选) authoring sub-form: mode radio (单选/多选) + scope select
           (全公司/指定成员/指定角色) with TYPED pickers only (D0 §10.2 — no raw-ID input).
           The submit-time chooser itself lives in ApprovalNewView; this only authors the
           mode + scope the server validates the requester's choice against. -->
      <template v-else-if="approvalSourceKind(node.key) === 'requester_choice'">
        <el-form-item label="选择方式">
          <div
            class="approval-node-source-roster"
            role="radiogroup"
            aria-label="选择方式"
            data-testid="approval-node-requester-choice-mode"
          >
            <label class="approval-node-source-roster-option">
              <input
                type="radio"
                :name="`approval-node-requester-choice-mode-${node.key}`"
                :checked="requesterChoiceMode(node.key) === 'single'"
                :disabled="readOnly"
                data-testid="approval-node-requester-choice-mode-single"
                @change="() => setRequesterChoiceMode(node.key, 'single')"
              />
              <span>单选（提交时选一人）</span>
            </label>
            <label class="approval-node-source-roster-option">
              <input
                type="radio"
                :name="`approval-node-requester-choice-mode-${node.key}`"
                :checked="requesterChoiceMode(node.key) === 'multi'"
                :disabled="readOnly"
                data-testid="approval-node-requester-choice-mode-multi"
                @change="() => setRequesterChoiceMode(node.key, 'multi')"
              />
              <span>多选（提交时可选多人）</span>
            </label>
          </div>
        </el-form-item>
        <el-form-item label="可选范围">
          <el-select
            :model-value="requesterChoiceScopeType(node.key)"
            size="small"
            :disabled="readOnly"
            class="ms-w-240"
            data-testid="approval-node-requester-choice-scope"
            @update:model-value="(type: 'company' | 'members' | 'role') => setRequesterChoiceScopeType(node.key, type)"
          >
            <el-option label="全公司（任意成员）" value="company" />
            <el-option label="指定成员" value="members" />
            <el-option label="指定角色的成员" value="role" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="requesterChoiceScopeType(node.key) === 'members'" label="可选成员">
          <el-select
            :model-value="requesterChoiceScopeIds(node.key)"
            multiple
            filterable
            remote
            :remote-method="onUserSearch"
            :loading="directoryUsersLoading"
            size="small"
            :disabled="readOnly"
            class="ms-w-360"
            placeholder="搜索用户名 / 邮箱"
            data-testid="approval-node-requester-choice-user-picker"
            @update:model-value="(ids: string[] | string) => setRequesterChoiceScopeIds(node.key, ids)"
            @visible-change="(visible: boolean) => visible && onUserSearch('')"
          >
            <el-option
              v-for="user in directoryUsers"
              :key="user.id"
              :label="formatUserLabel(user)"
              :value="user.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item v-else-if="requesterChoiceScopeType(node.key) === 'role'" label="可选角色">
          <el-select
            :model-value="requesterChoiceScopeIds(node.key)"
            multiple
            filterable
            size="small"
            :disabled="readOnly"
            class="ms-w-360"
            placeholder="选择角色"
            data-testid="approval-node-requester-choice-role-picker"
            @update:model-value="(ids: string[] | string) => setRequesterChoiceScopeIds(node.key, ids)"
          >
            <el-option
              v-for="role in directoryRoles"
              :key="role.id"
              :label="formatRoleLabel(role)"
              :value="role.id"
            />
          </el-select>
        </el-form-item>
      </template>
      <!-- G-5 sentinel hint: a starter preset's placeholder role surfaces HERE, in the editor,
           so the admin replaces it before publish (rather than hitting the publish-time 400). -->
      <el-alert
        v-if="approvalSourceIsPlaceholder(node.key)"
        type="warning"
        :closable="false"
        show-icon
        class="template-authoring__placeholder-hint"
        data-testid="approval-node-placeholder-hint"
        title="此为占位审批角色，发布前请替换为真实角色 ID"
        description="占位角色无人可认领，未替换将无法发布该模板。"
      />
      <!-- Approval-node policy grid: 审批模式 / 空审批人策略 / 自审策略. Handler nodes render NONE of
           these (M7 no inert controls) — a handler has NO empty-assignee/fallback key (§1.2) and no
           self-approval merge; its own controls are the 办理模式 + 办理意见 below. -->
      <div v-if="node.type === 'approval'" class="template-authoring__grid template-authoring__approval-node-policy">
        <el-form-item label="审批模式">
          <el-select
            :model-value="approvalNodeMode(node.key)"
            :disabled="readOnly"
            class="ms-w-100pct"
            data-testid="approval-node-mode"
            @update:model-value="(mode: ApprovalMode) => setApprovalNodeMode(node.key, mode)"
          >
            <el-option label="单人通过" value="single" />
            <el-option label="全部通过" value="all" />
            <el-option label="任一通过" value="any" />
          </el-select>
        </el-form-item>
        <el-form-item label="空审批人策略">
          <el-select
            :model-value="approvalNodeEmptyPolicy(node.key)"
            :disabled="readOnly"
            class="ms-w-100pct"
            data-testid="approval-node-empty-policy"
            @update:model-value="(policy: EmptyAssigneePolicy) => setApprovalNodeEmptyPolicy(node.key, policy)"
          >
            <el-option label="报错" value="error" />
            <el-option label="自动通过" value="auto-approve" />
          </el-select>
        </el-form-item>
        <el-form-item label="自审策略">
          <el-checkbox
            :model-value="approvalNodeMergeWithRequester(node.key)"
            :disabled="readOnly"
            data-testid="approval-node-merge-with-requester"
            @update:model-value="(enabled: boolean) => setApprovalNodeMergeWithRequester(node.key, enabled)"
          >发起人自动通过（自审合并）</el-checkbox>
        </el-form-item>
      </div>
      <!-- Lock-3 §1.1 — handler-node controls: 办理模式 (会签/或签) + 办理意见 (opt-in). NO empty policy,
           NO self-approval, NO fallback control renders here (M7). -->
      <div v-else-if="node.type === 'handler'" class="template-authoring__grid template-authoring__approval-node-policy">
        <el-form-item label="办理模式">
          <el-select
            :model-value="handlerNodeMode(node.key)"
            :disabled="readOnly"
            class="ms-w-100pct"
            data-testid="handler-node-mode"
            @update:model-value="(mode: HandlerMode) => setHandlerNodeMode(node.key, mode)"
          >
            <el-option label="会签（全部提交）" value="all" />
            <el-option label="或签（任一提交）" value="any" />
          </el-select>
        </el-form-item>
        <el-form-item label="办理意见">
          <el-checkbox
            :model-value="handlerNodeOpinionRequired(node.key)"
            :disabled="readOnly"
            data-testid="handler-node-opinion-required"
            @update:model-value="(required: boolean) => setHandlerNodeOpinionRequired(node.key, required)"
          >提交时必须填写办理意见</el-checkbox>
        </el-form-item>
      </div>
    </section>

    <!-- Lock-0 L0-1/L0-6: 表单权限 tab content. Renders alone when tabbed (activeTabId ===
         'fieldPermissions'); alongside the assignee section, unchanged, in flat/list mode. -->
    <section
      v-show="showFieldPermissionsSection"
      class="template-authoring__approval-node-section"
      data-testid="approval-node-section-field-permissions"
    >
      <div class="template-authoring__field-perms" data-testid="approval-node-field-permissions">
        <div class="template-authoring__field-perms-head"><strong>字段权限</strong></div>
        <div
          v-for="field in fieldPermissionFields"
          :key="field.id"
          class="template-authoring__field-perm-row"
          data-testid="approval-node-field-permission-row"
        >
          <span class="template-authoring__field-perm-label">{{ field.label || '未命名字段' }}</span>
          <el-select
            :model-value="approvalNodeFieldAccess(node.key, field.id)"
            :disabled="readOnly"
            size="small"
            class="ms-w-130"
            :data-testid="`approval-node-field-access-${field.id}`"
            @update:model-value="(access: NodeFieldAccess) => setApprovalNodeFieldAccess(node.key, field.id, access)"
          >
            <el-option label="可编辑" value="editable" />
            <el-option label="只读" value="readonly" />
            <el-option label="隐藏" value="hidden" />
          </el-select>
          <!-- Lock-7 G-13: the readonly honesty copy is retired here in the SAME change as the linear
               editor (L0-6 one-change rule) — `只读`/`隐藏` are now enforced server-side. -->
          <!-- D5: same render condition as the linear editor — WIRED: renders whenever a hidden field
               is a routing driver (graph-wide routingDriverFieldIds is provided via the api). Accurate
               under OD-L7-8(a): a driver can never be editable, so hiding only affects the echo. -->
          <span
            v-if="approvalNodeFieldAccess(node.key, field.id) === 'hidden' && routingDriverFieldIds.has(field.id)"
            class="template-authoring__hint template-authoring__hint--warn"
            data-testid="approval-node-field-routing-hint"
          >{{ FIELD_PERMISSION_ROUTING_HINT }}</span>
        </div>
      </div>
    </section>

    <!-- Lock-0 L0-1: 操作权限 tab content. Only reachable when the tabs context is active AND the
         registry declared ≥1 ratified operation policy for this node type — never true at the
         shipped baseline (operationPoliciesByNodeType is empty everywhere), so this renders
         nothing in production. Content, when it exists, echoes the registry's OWN data rather than
         fabricating UI ("empty tab theater" — Lock-0 delta §1 L0-1). -->
    <section
      v-if="isTabbed && activeTabId === 'operations'"
      class="template-authoring__approval-node-section"
      data-testid="approval-node-section-operations"
    >
      <p
        v-for="policy in operationPoliciesForNode"
        :key="policy.id"
        class="template-authoring__hint"
      >{{ policy.label }}</p>
    </section>
    </div>

    <!-- approval (legacy / no edit) / other — read-only summary. -->
    <template v-else>
      <ul v-if="nodeConfigSummary(node).length" class="template-authoring__node-summary">
        <li v-for="(line, lineIndex) in nodeConfigSummary(node)" :key="lineIndex">{{ line }}</li>
      </ul>
      <div v-else class="template-authoring__hint">（无可编辑配置）</div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, toRefs, unref, type ComputedRef, type Ref } from 'vue'
import { Plus } from '@element-plus/icons-vue'
import type {
  ApprovalMode,
  ApprovalNode,
  EmptyAssigneePolicy,
  HandlerMode,
  NodeFieldAccess,
  ParallelNodeConfig,
  RequesterChoiceAssigneeSource,
} from '../../types/approval'
import {
  APPROVAL_NODE_CONFIG_EDITOR_KEY,
} from '../nodeConfigEditorContext'
import {
  CONDITION_RULE_OPERATORS,
  PARALLEL_JOIN_MODES,
  CC_TARGET_TYPES,
} from '../templateAuthoring'
import {
  APPROVAL_ASSIGNEE_SOURCE_LABELS,
  DEFAULT_APPROVAL_CAPABILITY_REGISTRY,
  assigneeSourceRoster,
  isRegisteredAssigneeSourceKind,
  type ApprovalCapabilityRegistry,
} from '../approvalCapabilityRegistry'
import { APPROVAL_CANVAS_INSPECTOR_TABS_KEY } from '../canvasInspectorTabsContext'
import { FIELD_PERMISSION_ROUTING_HINT } from '../fieldPermissionHonestyCopy'

const props = defineProps<{
  node: ApprovalNode
  /** Lock-0 L0-2 capability registry. Optional — defaults to the shipped registry; tests override
   *  it for the A-3 exact-set / A-4 unknown-kind fixtures. */
  registry?: ApprovalCapabilityRegistry
}>()

const api = inject(APPROVAL_NODE_CONFIG_EDITOR_KEY)
if (!api) {
  throw new Error('ApprovalGraphNodeConfigEditor requires APPROVAL_NODE_CONFIG_EDITOR_KEY')
}

// ── Lock-0 L0-1 tab presentation (optional — absent in the flat/list "辅助编辑模式" surface) ──
const tabsCtx = inject(APPROVAL_CANVAS_INSPECTOR_TABS_KEY, undefined)
const isTabbed = computed(() => Boolean(tabsCtx?.active.value))
const activeTabId = computed(() => (isTabbed.value ? tabsCtx!.activeTab.value : null))
const showAssigneeSection = computed(() => activeTabId.value === null || activeTabId.value === 'assignee')
const showFieldPermissionsSection = computed(
  () => activeTabId.value === null || activeTabId.value === 'fieldPermissions',
)

// ── Lock-0 L0-2 capability registry ──────────────────────────────────────────────────────────
const registry = computed(() => props.registry ?? DEFAULT_APPROVAL_CAPABILITY_REGISTRY)
const assigneeSourceRosterForNode = computed(() => assigneeSourceRoster(registry.value, props.node.type))
const operationPoliciesForNode = computed(
  () => registry.value.operationPoliciesByNodeType[props.node.type] ?? [],
)

function unwrap<T>(value: ComputedRef<T> | Ref<T> | T): T {
  return unref(value as ComputedRef<T> | Ref<T> | T)
}

const readOnly = computed(() => Boolean(unwrap(api.readOnly)))
const conditionFieldOptions = computed(() => unwrap(api.conditionFieldOptions))
const userFields = computed(() => unwrap(api.userFields))
const conditionFormulaInsertOptions = computed(() => unwrap(api.conditionFormulaInsertOptions))
const fieldPermissionFields = computed(() => unwrap(api.fieldPermissionFields))
const directoryUsers = computed(() => unwrap(api.directoryUsers))
const directoryUsersLoading = computed(() => Boolean(unwrap(api.directoryUsersLoading)))
const directoryRoles = computed(() => unwrap(api.directoryRoles))
const formulaRoles = computed(() => unwrap(api.formulaRoles))

const conditionEditFor = api.conditionEditFor
const parallelEditFor = api.parallelEditFor
const ccEditFor = api.ccEditFor
const approvalNodeEditFor = api.approvalNodeEditFor
const conditionOperatorLabel = api.conditionOperatorLabel
const liveBranchSummary = api.liveBranchSummary
const conditionRuleValueText = api.conditionRuleValueText
const setConditionRuleValue = api.setConditionRuleValue
const addConditionRule = api.addConditionRule
const removeConditionRule = api.removeConditionRule
const setConditionBranchPredicateMode = api.setConditionBranchPredicateMode
const insertConditionFormulaToken = api.insertConditionFormulaToken
const insertConditionFormulaFunction = api.insertConditionFormulaFunction
const insertConditionFormulaRoleMembership = api.insertConditionFormulaRoleMembership
const conditionFormulaDryRunResult = api.conditionFormulaDryRunResult
const conditionFormulaDryRunLoading = api.conditionFormulaDryRunLoading
const dryRunConditionFormula = api.dryRunConditionFormula
const conditionOutgoingEdgeKeys = api.conditionOutgoingEdgeKeys
const conditionEdgeLabel = api.conditionEdgeLabel
const graphEdgeTargetLabel = api.graphEdgeTargetLabel
const graphNodeLabel = api.graphNodeLabel
const parallelJoinModeLabel = api.parallelJoinModeLabel
const ccTargetTypeLabel = api.ccTargetTypeLabel
const setCcTargetIds = api.setCcTargetIds
const syncCcOptions = api.syncCcOptions
const approvalSourceKind = api.approvalSourceKind
const setApprovalSourceKind = api.setApprovalSourceKind
const syncApprovalNodeOptions = api.syncApprovalNodeOptions
const approvalSourceIds = api.approvalSourceIds
const setApprovalSourceIdsFromPicker = api.setApprovalSourceIdsFromPicker
const approvalSourceFieldId = api.approvalSourceFieldId
const setApprovalSourceFieldId = api.setApprovalSourceFieldId
const approvalSourceLevel = api.approvalSourceLevel
const setApprovalSourceLevel = api.setApprovalSourceLevel
const approvalSourceIsPlaceholder = api.approvalSourceIsPlaceholder
const approvalNodeMode = api.approvalNodeMode
const setApprovalNodeMode = api.setApprovalNodeMode
const approvalNodeEmptyPolicy = api.approvalNodeEmptyPolicy
const setApprovalNodeEmptyPolicy = api.setApprovalNodeEmptyPolicy
const approvalNodeMergeWithRequester = api.approvalNodeMergeWithRequester
const setApprovalNodeMergeWithRequester = api.setApprovalNodeMergeWithRequester
// Lock-3 §1.1 — handler-only controls (办理模式 / 办理意见).
const handlerNodeMode = api.handlerNodeMode
const setHandlerNodeMode = api.setHandlerNodeMode
const handlerNodeOpinionRequired = api.handlerNodeOpinionRequired
const setHandlerNodeOpinionRequired = api.setHandlerNodeOpinionRequired
const approvalNodeFieldAccess = api.approvalNodeFieldAccess
const setApprovalNodeFieldAccess = api.setApprovalNodeFieldAccess
const nodeConfigSummary = api.nodeConfigSummary
const onUserSearch = api.onUserSearch
const formatUserLabel = api.formatUserLabel
const formatRoleLabel = api.formatRoleLabel
// L0-6/D5 — wired: `TemplateAuthoringView.vue` provides its graph-wide `routingDriverFieldIds`
// computed here (see nodeConfigEditorContext.ts's doc comment for why it must union the linear
// `draft.steps` model with the graph `draft.approvalNodeEdits` model). Falls back to an empty set
// only for component-level tests that inject an api object without this optional field.
const routingDriverFieldIds = computed(() => unwrap(api.routingDriverFieldIds ?? new Set<string>()))

// D1: the incidental shipped el-select strings ("指定用户"/"发起人"/"部门主管"/"表单用户字段" — an
// independent hand-written array) are SUPERSEDED by the L0-2 capability registry
// (assigneeSourceRosterForNode above), which carries the ratified parent §10.3 wording. No
// hand-written roster is kept here anymore — the registry is the only source.

/** L0-2 / A-4: the currently configured source kind may be a persisted value the registry does
 *  not know about (legacy/unratified). Read-only in that case — never mutated, never flattened. */
const isKnownAssigneeSourceKind = computed(() =>
  isRegisteredAssigneeSourceKind(registry.value, props.node.type, approvalSourceKind(props.node.key)),
)

// ── Lock-1 §K2 requester_choice sub-form ────────────────────────────────────────────────────
// Reads/writes the PRIMARY source of the SHARED approvalNodeEditFor edit model directly (the
// same live model the roster's kind switch mutates), so no new context-api surface is needed
// and both presentations (canvas inspector tabs / flat structured list) stay one source.
function requesterChoiceSourceFor(nodeKey: string): RequesterChoiceAssigneeSource | null {
  const source = approvalNodeEditFor(nodeKey)?.assigneeSources[0]
  return source?.kind === 'requester_choice' ? source : null
}
function replaceRequesterChoiceSource(nodeKey: string, next: RequesterChoiceAssigneeSource): void {
  const edit = approvalNodeEditFor(nodeKey)
  if (!edit) return
  edit.assigneeSources = [next, ...edit.assigneeSources.slice(1)]
}
function requesterChoiceMode(nodeKey: string): 'single' | 'multi' {
  return requesterChoiceSourceFor(nodeKey)?.mode ?? 'single'
}
function setRequesterChoiceMode(nodeKey: string, mode: 'single' | 'multi'): void {
  const source = requesterChoiceSourceFor(nodeKey)
  if (!source || source.mode === mode) return
  replaceRequesterChoiceSource(nodeKey, { ...source, mode })
}
function requesterChoiceScopeType(nodeKey: string): 'company' | 'members' | 'role' {
  return requesterChoiceSourceFor(nodeKey)?.scope.type ?? 'company'
}
function setRequesterChoiceScopeType(nodeKey: string, type: 'company' | 'members' | 'role'): void {
  const source = requesterChoiceSourceFor(nodeKey)
  if (!source || source.scope.type === type) return
  // A scope switch starts with an EMPTY id list deliberately: userIds and roleIds are different
  // id domains, so carrying one list into the other scope would author wrong config.
  const scope: RequesterChoiceAssigneeSource['scope'] =
    type === 'members' ? { type: 'members', userIds: [] }
      : type === 'role' ? { type: 'role', roleIds: [] }
        : { type: 'company' }
  replaceRequesterChoiceSource(nodeKey, { ...source, scope })
}
function requesterChoiceScopeIds(nodeKey: string): string[] {
  const source = requesterChoiceSourceFor(nodeKey)
  if (source?.scope.type === 'members') return source.scope.userIds
  if (source?.scope.type === 'role') return source.scope.roleIds
  return []
}
function setRequesterChoiceScopeIds(nodeKey: string, ids: string[] | string): void {
  const source = requesterChoiceSourceFor(nodeKey)
  if (!source) return
  const list = Array.isArray(ids) ? ids : ids ? [ids] : []
  if (source.scope.type === 'members') {
    replaceRequesterChoiceSource(nodeKey, { ...source, scope: { type: 'members', userIds: list } })
  } else if (source.scope.type === 'role') {
    replaceRequesterChoiceSource(nodeKey, { ...source, scope: { type: 'role', roleIds: list } })
  }
}

/** D2: configured summary echo. Reads the LIVE edit model (not `node.config`, which is the stale
 *  pre-edit snapshot in list mode — `TemplateAuthoringView.vue`'s `graphPreviewNodes` is sourced
 *  from `draft.preservedGraph`, not the live effective graph) so it stays correct in both
 *  presentations.
 *
 *  Labels come from `APPROVAL_ASSIGNEE_SOURCE_LABELS` (the SAME D1-ratified §10.3 wording the
 *  roster uses) — NOT from `assigneeSourceSummary` (`../assigneeSource.ts`), which is shipped copy
 *  for a different, requester-facing audience (`nodeAssigneeSourceSummary`'s docstring) and still
 *  carries the incidental pre-D1 strings ("发起人", "部门主管") that this echo would otherwise
 *  contradict one line below the D1-labelled roster it belongs to. `static_user`/`static_role`/
 *  `form_field_user` also avoid raw ids/field-ids — the same no-raw-id rule the existing read-only
 *  `nodeConfigSummary` already applies to those three kinds (count/label only). */
const configuredSourceSummaryLine = computed(() => {
  if (!isKnownAssigneeSourceKind.value) return ''
  const source = approvalNodeEditFor(props.node.key)?.assigneeSources[0]
  if (!source) return ''
  const label = APPROVAL_ASSIGNEE_SOURCE_LABELS[source.kind]
  if (source.kind === 'static_user') {
    const count = source.userIds?.length ?? 0
    return `已配置：${label}${count ? `（${count} 人）` : '（未选择）'}`
  }
  if (source.kind === 'static_role') {
    const count = source.roleIds?.length ?? 0
    return `已配置：${label}${count ? `（${count} 个）` : '（未选择）'}`
  }
  if (source.kind === 'form_field_user') {
    const field = userFields.value.find((entry) => entry.id === source.fieldId)
    return `已配置：${label}：${field ? (field.label || '未命名字段') : '（未选择）'}`
  }
  if (source.kind === 'continuous_managers') {
    return `已配置：${label}（${source.levels} 级）`
  }
  if (source.kind === 'manager_at_level') {
    return `已配置：${label}（第 ${source.level} 级）`
  }
  if (source.kind === 'requester_choice') {
    // §K2 echo — mode + scope, count-only (same no-raw-id rule as static_user/static_role).
    const mode = source.mode === 'multi' ? '多选' : '单选'
    const scope = source.scope.type === 'members'
      ? `指定成员${source.scope.userIds.length ? `（${source.scope.userIds.length} 人）` : '（未选择）'}`
      : source.scope.type === 'role'
        ? `指定角色${source.scope.roleIds.length ? `（${source.scope.roleIds.length} 个）` : '（未选择）'}`
        : '全公司'
    return `已配置：${label}（${mode} · ${scope}）`
  }
  return `已配置：${label}`
})

const { node } = toRefs(props)
</script>


<style scoped>
/* Child-owned styles (Canvas V2 Slice A): parent TemplateAuthoringView uses scoped CSS, so these
   selectors must live here for both the structure-list rows and the canvas inspector. Shared class
   names used elsewhere in the parent are defined here independently so THIS SFC's markup receives
   them; the parent's scoped rules continue to style only markup rendered by the parent. */
.approval-node-config-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
}

.template-authoring__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 16px;
  min-width: 0;
}

.template-authoring__hint {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}

.template-authoring__node-summary {
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--el-text-color-regular);
}

/* G-2 condition editor */
.template-authoring__condition {
  margin-top: 8px;
  min-width: 0;
}

.template-authoring__condition-branch {
  border: 1px dashed var(--el-border-color);
  border-radius: 6px;
  padding: 10px 12px;
  margin-bottom: 10px;
  min-width: 0;
  box-sizing: border-box;
}

.template-authoring__condition-branch-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 13px;
  color: var(--el-text-color-regular);
  min-width: 0;
}

.template-authoring__condition-rule {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  min-width: 0;
}

.template-authoring__condition-formula {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.template-authoring__condition-formula-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.template-authoring__condition-formula-role-hint {
  margin-left: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.template-authoring__condition-formula-dryrun {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.template-authoring__condition-formula-dryrun-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.template-authoring__condition-formula-dryrun-result {
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-regular);
}

.template-authoring__condition-default {
  margin: 4px 0 0;
}

/* P1-D — priority chip (condition branches) / de-emphasized default-branch label. Text-only
   information carrier (branch order + "default" are both spelled out in words); the token colors
   below are a supplementary accent, never the sole carrier (V-6/V-8). */
.template-authoring__condition-branch-priority {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.template-authoring__condition-branch-priority--default {
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
}

/* De-emphasized relative to the ordered branch cards above via a muted fill — the dashed border is
   already inherited from `.template-authoring__condition-branch` above (both classes are always
   applied together on this card), so it is not repeated here. Same card shape; no delete/duplicate
   affordance is mounted on this card. */
.template-authoring__condition-default-card {
  background: var(--el-fill-color-lighter);
}

.template-authoring__condition-default-copy {
  margin: 0 0 8px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}

/* G-3 / G-4 shells (compact; no nested cards) */
.template-authoring__parallel,
.template-authoring__cc,
.template-authoring__approval-node {
  min-width: 0;
}

.template-authoring__approval-node-policy {
  margin-top: 8px;
}

/* Lock-0 L0-1: transparent section wrappers — no border/shadow of their own (parent §3.2). */
.template-authoring__approval-node-section {
  min-width: 0;
}

/* Lock-0 L0-2: radio-grid roster replacing the single el-select. Flat, no card-in-card. */
.approval-node-source-roster {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  min-width: 0;
}

.approval-node-source-roster-option {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--el-text-color-regular);
  cursor: pointer;
}

.template-authoring__placeholder-hint {
  margin: 8px 0;
}

.template-authoring__field-perms {
  margin-top: 10px;
  min-width: 0;
}

.template-authoring__field-perms-head {
  margin-bottom: 6px;
  font-size: 13px;
}

.template-authoring__field-perm-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  min-width: 0;
}

.template-authoring__field-perm-label {
  flex: 1 1 140px;
  min-width: 0;
  font-size: 12px;
  color: var(--el-text-color-regular);
  word-break: break-word;
}

@media (max-width: 960px) {
  .template-authoring__grid {
    grid-template-columns: 1fr;
  }
}
</style>
