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

    <!-- G-5 / P1-B: editable approval node — ALL assignee-source cards (assigneeSources[]), one
         card per array entry, each an independent roster + per-kind picker. The node's
         approvalMode / emptyAssigneePolicy / autoApprovalPolicy + edges are preserved. Legacy
         nodes (no assigneeSources) aren't seeded → fall to the read-only summary below. Master
         §P1-B / M5: array order is display order; the runtime resolver owns the union + identity
         dedup — this editor only appends/removes/edits cards, never reorders or merges them.
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
      <!-- P1-B: one card per assigneeSources[] entry, keyed by its (stable, positional) index — the
           array IS the identity model here (no separate id field), and add/remove/edit only ever
           append/splice/replace by index, so index-as-key is safe. Each card is byte-identical to
           the old single-source markup (every inner data-testid is UNCHANGED — only the radio
           `name` gains a per-card suffix, which native radiogroups require) so a single-source node
           renders the exact same DOM as before this slice (positive control). -->
      <div
        v-for="(source, sourceIndex) in (approvalNodeEditFor(node.key)?.assigneeSources ?? [])"
        :key="sourceIndex"
        class="approval-node-source-card"
        data-testid="approval-node-source-card"
        :data-source-index="sourceIndex"
      >
        <!-- Lock-0 L0-2: registry-driven radio-grid roster (replaces the single el-select). §10.3
             constrains the picker to be ONE component with plain labels + a configured summary
             echo, not a specific control shape — a radio grid needs no further delta. -->
        <el-form-item :label="(node.type === 'handler' ? '办理人来源' : '审批人来源') + (approvalSourceCount(node.key) > 1 ? ` ${sourceIndex + 1}` : '')">
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
                :name="`approval-node-source-kind-${node.key}-${sourceIndex}`"
                :checked="approvalSourceKind(node.key, sourceIndex) === opt.kind"
                :disabled="readOnly"
                :data-testid="`approval-node-source-kind-${opt.kind}`"
                @change="() => { setApprovalSourceKind(node.key, sourceIndex, opt.kind); syncApprovalNodeOptions(node.key) }"
              />
              <span>{{ opt.label }}</span>
            </label>
          </div>
          <!-- L0-2 / A-4: a persisted source kind outside the registry stays read-only and
               round-trips unchanged — never flattened to a registry default. -->
          <p
            v-if="!isKnownAssigneeSourceKind(node.key, sourceIndex)"
            class="template-authoring__hint template-authoring__hint--warn"
            data-testid="approval-node-source-kind-unknown"
          >当前来源「{{ approvalSourceKind(node.key, sourceIndex) }}」不在能力清单中，保留为只读，保存时不会被覆盖或清空</p>
          <!-- D2: configured summary echo (parent §10.3), reusing the existing shared wording. -->
          <p
            v-if="configuredSourceSummaryLine(node.key, sourceIndex)"
            class="template-authoring__hint"
            data-testid="approval-node-source-configured-summary"
          >{{ configuredSourceSummaryLine(node.key, sourceIndex) }}</p>
        </el-form-item>
        <!-- G-B2-18 + D1: typed directory pickers only; no ordinary raw-ID authoring path. -->
        <template v-if="approvalSourceKind(node.key, sourceIndex) === 'static_user' || approvalSourceKind(node.key, sourceIndex) === 'static_role'">
          <el-form-item v-if="approvalSourceKind(node.key, sourceIndex) === 'static_user'" label="选择用户">
            <el-select
              :model-value="approvalSourceIds(node.key, sourceIndex)"
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
              @update:model-value="(ids: string[]) => setApprovalSourceIdsFromPicker(node.key, sourceIndex, ids)"
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
              :model-value="approvalSourceIds(node.key, sourceIndex)"
              multiple
              filterable
              size="small"
              :disabled="readOnly"
              class="ms-w-360"
              placeholder="选择角色"
              data-testid="approval-node-source-role-picker"
              @update:model-value="(ids: string[]) => setApprovalSourceIdsFromPicker(node.key, sourceIndex, ids)"
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
          v-else-if="approvalSourceKind(node.key, sourceIndex) === 'form_field_user'"
          label="表单用户字段"
        >
          <el-select
            :model-value="approvalSourceFieldId(node.key, sourceIndex)"
            size="small"
            :disabled="readOnly"
            class="ms-w-240"
            placeholder="选择表单用户字段"
            data-testid="approval-node-source-field"
            @update:model-value="(fieldId: string) => setApprovalSourceFieldId(node.key, sourceIndex, fieldId)"
          >
            <el-option
              v-for="field in userFields"
              :key="field.id"
              :label="field.label || '未命名字段'"
              :value="field.id"
            />
          </el-select>
        </el-form-item>
        <!-- Lock-2 §L2-C (表单内联系人上级 / 表单内联系人部门负责人) authoring sub-form: the SAME
             typed field picker as form_field_user (top-level `user` fields only — never a raw field
             id input) PLUS a single level input. The picker only OFFERS schema fields; the
             required / no-visibility-rule / no-multi pins are enforced by the backend publish
             validator, and the hint DISCLOSES them at authoring time (OD-L2-4's authoring-copy
             disclosure posture). Both controls are live and emitted on save — no inert control. -->
        <template v-else-if="approvalSourceKind(node.key, sourceIndex) === 'form_field_user_manager' || approvalSourceKind(node.key, sourceIndex) === 'form_field_user_dept_head'">
          <el-form-item label="表单内联系人字段">
            <el-select
              :model-value="approvalSourceFieldId(node.key, sourceIndex)"
              size="small"
              :disabled="readOnly"
              class="ms-w-240"
              placeholder="选择表单联系人字段"
              data-testid="approval-node-source-contact-field"
              @update:model-value="(fieldId: string) => setApprovalSourceFieldId(node.key, sourceIndex, fieldId)"
            >
              <el-option
                v-for="field in userFields"
                :key="field.id"
                :label="field.label || '未命名字段'"
                :value="field.id"
              />
            </el-select>
            <p
              class="template-authoring__hint"
              data-testid="approval-node-source-contact-field-hint"
            >所选联系人字段须为必填且不带显示条件，发布时校验</p>
          </el-form-item>
          <el-form-item :label="approvalSourceKind(node.key, sourceIndex) === 'form_field_user_manager' ? '指定联系人上级层级' : '指定联系人部门负责人层级'">
            <el-input-number
              :model-value="approvalSourceLevel(node.key, sourceIndex)"
              :min="1"
              :max="10"
              :step="1"
              size="small"
              :disabled="readOnly"
              data-testid="approval-node-source-contact-level"
              @update:model-value="(value: number) => setApprovalSourceLevel(node.key, sourceIndex, value ?? 1)"
            />
          </el-form-item>
        </template>
        <el-form-item
          v-else-if="approvalSourceKind(node.key, sourceIndex) === 'manager_at_level' || approvalSourceKind(node.key, sourceIndex) === 'continuous_managers' || approvalSourceKind(node.key, sourceIndex) === 'continuous_dept_heads' || approvalSourceKind(node.key, sourceIndex) === 'dept_head_at_level'"
          :label="approvalSourceKind(node.key, sourceIndex) === 'manager_at_level' ? '指定上级层级' : approvalSourceKind(node.key, sourceIndex) === 'continuous_dept_heads' ? '部门负责人层级数' : approvalSourceKind(node.key, sourceIndex) === 'dept_head_at_level' ? '指定部门负责人层级' : '上级层级数'"
        >
          <el-input-number
            :model-value="approvalSourceLevel(node.key, sourceIndex)"
            :min="1"
            :max="10"
            :step="1"
            size="small"
            :disabled="readOnly"
            data-testid="approval-node-source-level"
            @update:model-value="(value: number) => setApprovalSourceLevel(node.key, sourceIndex, value ?? 1)"
          />
        </el-form-item>
        <!-- Lock-1 §K2 (提交人自选) authoring sub-form: mode radio (单选/多选) + scope select
             (全公司/指定成员/指定角色) with TYPED pickers only (D0 §10.2 — no raw-ID input).
             The submit-time chooser itself lives in ApprovalNewView; this only authors the
             mode + scope the server validates the requester's choice against. -->
        <template v-else-if="approvalSourceKind(node.key, sourceIndex) === 'requester_choice'">
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
                  :name="`approval-node-requester-choice-mode-${node.key}-${sourceIndex}`"
                  :checked="requesterChoiceMode(node.key, sourceIndex) === 'single'"
                  :disabled="readOnly"
                  data-testid="approval-node-requester-choice-mode-single"
                  @change="() => setRequesterChoiceMode(node.key, sourceIndex, 'single')"
                />
                <span>单选（提交时选一人）</span>
              </label>
              <label class="approval-node-source-roster-option">
                <input
                  type="radio"
                  :name="`approval-node-requester-choice-mode-${node.key}-${sourceIndex}`"
                  :checked="requesterChoiceMode(node.key, sourceIndex) === 'multi'"
                  :disabled="readOnly"
                  data-testid="approval-node-requester-choice-mode-multi"
                  @change="() => setRequesterChoiceMode(node.key, sourceIndex, 'multi')"
                />
                <span>多选（提交时可选多人）</span>
              </label>
            </div>
          </el-form-item>
          <el-form-item label="可选范围">
            <el-select
              :model-value="requesterChoiceScopeType(node.key, sourceIndex)"
              size="small"
              :disabled="readOnly"
              class="ms-w-240"
              data-testid="approval-node-requester-choice-scope"
              @update:model-value="(type: 'company' | 'members' | 'role') => setRequesterChoiceScopeType(node.key, sourceIndex, type)"
            >
              <el-option label="全公司（任意成员）" value="company" />
              <el-option label="指定成员" value="members" />
              <el-option label="指定角色的成员" value="role" />
            </el-select>
          </el-form-item>
          <el-form-item v-if="requesterChoiceScopeType(node.key, sourceIndex) === 'members'" label="可选成员">
            <el-select
              :model-value="requesterChoiceScopeIds(node.key, sourceIndex)"
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
              @update:model-value="(ids: string[] | string) => setRequesterChoiceScopeIds(node.key, sourceIndex, ids)"
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
          <el-form-item v-else-if="requesterChoiceScopeType(node.key, sourceIndex) === 'role'" label="可选角色">
            <el-select
              :model-value="requesterChoiceScopeIds(node.key, sourceIndex)"
              multiple
              filterable
              size="small"
              :disabled="readOnly"
              class="ms-w-360"
              placeholder="选择角色"
              data-testid="approval-node-requester-choice-role-picker"
              @update:model-value="(ids: string[] | string) => setRequesterChoiceScopeIds(node.key, sourceIndex, ids)"
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
        <!-- Lock-1 §K3 (节点审批人) authoring sub-form: a TYPED node picker restricted to the
             publish-time-legal upstream approval nodes (D0 §10.2 — never a free-text node-key
             input). Candidates come from the api's `priorApproverNodeOptions` (the shipped app
             derives them via `legalPriorApproverNodeKeys` — the FE mirror of the backend publish
             dominance gate, which stays the sole arbiter). -->
        <el-form-item
          v-else-if="approvalSourceKind(node.key, sourceIndex) === 'prior_node_approver'"
          label="引用审批节点"
        >
          <el-select
            :model-value="priorNodeApproverKey(node.key, sourceIndex)"
            size="small"
            :disabled="readOnly"
            class="ms-w-240"
            placeholder="选择上游审批节点"
            data-testid="approval-node-source-prior-node"
            @update:model-value="(key: string) => setPriorNodeApproverKey(node.key, sourceIndex, key)"
          >
            <el-option
              v-for="option in priorApproverNodeOptionsFor(node.key)"
              :key="option.key"
              :label="option.label"
              :value="option.key"
            />
          </el-select>
          <p
            v-if="priorApproverNodeOptionsFor(node.key).length === 0"
            class="template-authoring__hint template-authoring__hint--warn"
            data-testid="approval-node-source-prior-node-empty"
          >当前节点上游没有可引用的审批节点（引用目标必须位于每条可达路径的上游）</p>
        </el-form-item>
        <!-- Lock-1 §K1 (用户组) authoring sub-form: a TYPED multi-select restricted to groups
             BOUND to the template's org (D0 §10.2 — never a free-text/raw-id input). A group
             outside the binding fails publish (values-free 400), never at dispatch; the picker
             only OFFERS bound candidates so authoring stays honest without relaxing the backend
             arbiter (`assertUserGroupSourcesBoundToOrg`). -->
        <el-form-item
          v-else-if="approvalSourceKind(node.key, sourceIndex) === 'user_group'"
          label="选择用户组"
        >
          <el-select
            :model-value="approvalSourceGroupIds(node.key, sourceIndex)"
            multiple
            filterable
            size="small"
            :disabled="readOnly"
            :loading="memberGroupOptionsLoading"
            class="ms-w-360"
            placeholder="选择已绑定的用户组"
            data-testid="approval-node-source-group-picker"
            @update:model-value="(ids: string[]) => setApprovalSourceGroupIds(node.key, sourceIndex, ids)"
          >
            <el-option
              v-for="group in memberGroupOptions"
              :key="group.id"
              :label="formatMemberGroupLabel(group)"
              :value="group.id"
            />
          </el-select>
          <p
            v-if="!readOnly && memberGroupOptions.length === 0 && !memberGroupOptionsLoading"
            class="template-authoring__hint template-authoring__hint--warn"
            data-testid="approval-node-source-group-empty"
          >当前组织尚无已绑定的可用用户组（需管理员先绑定用户组才能选择）</p>
        </el-form-item>
        <!-- G-5 sentinel hint: a starter preset's placeholder role surfaces HERE, in the editor,
             so the admin replaces it before publish (rather than hitting the publish-time 400).
             P1-B: scoped to THIS card's own source, not the node-wide aggregate — a node with N
             cards points the hint at the exact offending card. -->
        <el-alert
          v-if="approvalSourceIsPlaceholder(node.key, sourceIndex)"
          type="warning"
          :closable="false"
          show-icon
          class="template-authoring__placeholder-hint"
          data-testid="approval-node-placeholder-hint"
          title="此为占位审批角色，发布前请替换为真实角色 ID"
          description="占位角色无人可认领，未替换将无法发布该模板。"
        />
        <!-- P1-B remove affordance: fail-closed — a node must always keep ≥1 source. `disabled` here
             is the UX signal; the actual guard lives in `removeApprovalSourceCard` itself (refuses
             at length<=1 regardless of this attribute — M7: this is a real, working control, not
             theater, and it stays correct even if a caller bypasses the disabled state). -->
        <div class="approval-node-source-card-actions">
          <el-button
            size="small"
            :disabled="readOnly || approvalSourceCount(node.key) <= 1"
            data-testid="approval-node-source-remove"
            @click="removeApprovalSourceCard(node.key, sourceIndex)"
          >移除此{{ node.type === 'handler' ? '办理人' : '审批人' }}来源</el-button>
        </div>
      </div>
      <!-- P1-B "＋添加审批人": appends one more source card, defaulted from the registry roster (never
           a hand-picked kind — see defaultNewSourceKind). Sources form a UNION at runtime; the
           resolver dedups overlapping people across cards (M8 — this editor never dedups, sorts, or
           reorders; master §P1-B item 4 / M5). -->
      <div class="approval-node-source-add">
        <el-button
          size="small"
          :disabled="readOnly"
          data-testid="approval-node-source-add"
          @click="addApprovalSourceCard(node.key, defaultNewSourceKind())"
        ><el-icon><Plus /></el-icon>{{ node.type === 'handler' ? '＋添加办理人' : '＋添加审批人' }}</el-button>
        <p
          v-if="approvalSourceCount(node.key) > 1"
          class="template-authoring__hint"
          data-testid="approval-node-source-union-hint"
        >已配置 {{ approvalSourceCount(node.key) }} 个来源，取其并集；同一人出现在多个来源时，系统运行时自动去重（此编辑器本身不做去重或排序）</p>
      </div>
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
            <!-- P1-C (T2-4 N-of-M / 门槛会签): linear-only in v1 — the backend rejects a 'threshold'
                 node inside a parallel region (APPROVAL_THRESHOLD_IN_PARALLEL). Disabled (not
                 hidden) here so an already-threshold node picked up from outside a parallel region
                 stays visibly selected if later moved into one; `setApprovalNodeMode` is the actual
                 fail-closed floor (a disabled option cannot dispatch anyway, but that guard is not
                 the ONLY enforcement point). -->
            <el-option
              label="门槛会签（N 人同意）"
              value="threshold"
              :disabled="approvalNodeInParallelRegion(node.key)"
              data-testid="approval-node-mode-threshold-option"
            />
          </el-select>
          <p
            v-if="approvalNodeInParallelRegion(node.key)"
            class="template-authoring__hint"
            data-testid="approval-node-threshold-parallel-hint"
          >位于并行分支内，暂不支持门槛会签（v1 仅支持线性路径）</p>
        </el-form-item>
        <!-- P1-C: typed N-of-M control, rendered only under 'threshold' mode. M is resolved from
             this node's assignee-source UNION at runtime (the backend's static N<=M publish bound
             applies only to the legacy assigneeType/assigneeIds shape this editor never emits), so
             an unreachable N fails closed at dispatch (APPROVAL_THRESHOLD_UNREACHABLE), not here —
             this hint says so honestly rather than pretending to validate M (M8). -->
        <el-form-item v-if="approvalNodeMode(node.key) === 'threshold'" label="通过所需人数（N）">
          <el-input-number
            :model-value="approvalNodeThreshold(node.key)"
            :min="1"
            :step="1"
            :disabled="readOnly"
            data-testid="approval-node-threshold"
            @update:model-value="(value: number) => setApprovalNodeThreshold(node.key, value ?? 1)"
          />
          <p class="template-authoring__hint">
            需要 N 位不同审批人同意才通过；实际可用人数（M）由上方审批人来源在实例运行时解析，若解析结果不足 N 人，该节点会在运行时失败（而非发布时被拒绝）。
          </p>
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
      <!-- P1-C (T1-1) node-level SLA timeout — approval-node-only (a handler config forbids the
           `timeout` key, §1.2), so this section renders only in the SAME `node.type === 'approval'`
           scope as the policy grid above, never for a handler. -->
      <div v-if="node.type === 'approval'" class="template-authoring__approval-node-timeout" data-testid="approval-node-timeout-section">
        <el-form-item label="节点超时">
          <el-checkbox
            :model-value="Boolean(approvalNodeTimeout(node.key))"
            :disabled="readOnly || approvalNodeInParallelRegion(node.key)"
            data-testid="approval-node-timeout-enabled"
            @update:model-value="(enabled: boolean) => setApprovalNodeTimeoutEnabled(node.key, enabled)"
          >启用超时处理</el-checkbox>
          <p
            v-if="approvalNodeInParallelRegion(node.key)"
            class="template-authoring__hint"
            data-testid="approval-node-timeout-parallel-hint"
          >位于并行分支内，暂不支持节点超时（v1 仅支持线性路径）</p>
        </el-form-item>
        <template v-if="approvalNodeTimeout(node.key)">
          <el-form-item label="超时时长（分钟）">
            <el-input-number
              :model-value="approvalNodeTimeout(node.key)?.afterMinutes"
              :min="1"
              :max="NODE_TIMEOUT_MAX_AFTER_MINUTES"
              :step="1"
              :disabled="readOnly"
              data-testid="approval-node-timeout-after-minutes"
              @update:model-value="(value: number) => setApprovalNodeTimeoutAfterMinutes(node.key, value ?? 1)"
            />
          </el-form-item>
          <el-form-item label="超时后动作">
            <el-select
              :model-value="approvalNodeTimeout(node.key)?.effect"
              :disabled="readOnly"
              class="ms-w-100pct"
              data-testid="approval-node-timeout-effect"
              @update:model-value="(effect: SupportedNodeTimeoutEffect) => setApprovalNodeTimeoutEffect(node.key, effect)"
            >
              <!-- P1-C: ONLY the effects `ApprovalSlaScheduler.fireNodeTimeouts` actually acts on and
                   publish accepts — 'auto_approve'/'auto_reject' are reserved and NEVER offered here
                   (M6/M8: do not invent a capability the engine doesn't implement). -->
              <el-option
                v-for="effect in NODE_TIMEOUT_SUPPORTED_EFFECTS"
                :key="effect"
                :label="nodeTimeoutEffectOptionLabel(effect)"
                :value="effect"
              />
            </el-select>
          </el-form-item>
          <el-form-item v-if="approvalNodeTimeout(node.key)?.effect === 'transfer'" label="转交给">
            <el-select
              :model-value="approvalNodeTimeout(node.key)?.transferToUserId"
              filterable
              remote
              :remote-method="onUserSearch"
              :loading="directoryUsersLoading"
              :disabled="readOnly"
              class="ms-w-360"
              placeholder="搜索用户名 / 邮箱"
              data-testid="approval-node-timeout-transfer-target"
              @update:model-value="(userId: string) => setApprovalNodeTimeoutTransferToUserId(node.key, userId)"
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
          <el-form-item v-else-if="approvalNodeTimeout(node.key)?.effect === 'jump'" label="跳转到节点">
            <!-- Business labels only (`timeoutJumpTargetOptions`'s `label`) — never a raw node key in
                 the rendered option text (M8). Options already exclude this node and any node inside
                 a parallel region (mirrors `validateNodeTimeoutConfigs`'s jump-target legality). -->
            <el-select
              :model-value="approvalNodeTimeout(node.key)?.jumpToNodeKey"
              :disabled="readOnly"
              class="ms-w-240"
              placeholder="选择目标审批节点"
              data-testid="approval-node-timeout-jump-target"
              @update:model-value="(targetNodeKey: string) => setApprovalNodeTimeoutJumpToNodeKey(node.key, targetNodeKey)"
            >
              <el-option
                v-for="option in timeoutJumpTargetOptions(node.key)"
                :key="option.key"
                :label="option.label"
                :value="option.key"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="计时方式">
            <div
              class="approval-node-source-roster"
              role="radiogroup"
              aria-label="计时方式"
              data-testid="approval-node-timeout-unit"
            >
              <label class="approval-node-source-roster-option">
                <input
                  type="radio"
                  name="approval-node-timeout-unit"
                  :checked="(approvalNodeTimeout(node.key)?.unit ?? 'wall_clock') === 'wall_clock'"
                  :disabled="readOnly"
                  data-testid="approval-node-timeout-unit-wall-clock"
                  @change="() => setApprovalNodeTimeoutUnit(node.key, 'wall_clock')"
                />
                <span>自然时间</span>
              </label>
              <label class="approval-node-source-roster-option">
                <input
                  type="radio"
                  name="approval-node-timeout-unit"
                  :checked="approvalNodeTimeout(node.key)?.unit === 'business'"
                  :disabled="readOnly"
                  data-testid="approval-node-timeout-unit-business"
                  @change="() => setApprovalNodeTimeoutUnit(node.key, 'business')"
                />
                <span>工作时间</span>
              </label>
            </div>
          </el-form-item>
        </template>
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

    <!-- Lock-0 L0-1 / Lock-5 §1.1 L5-A: 操作权限 tab content. Only reachable when the tabs context is
         active AND the registry declared ≥1 ratified operation policy for this node type. Every row
         is driven by `operationPoliciesForNode` — the registry's OWN data — so a capability whose
         server enforcement has not landed cannot render a control (master M7/M8, gate E-2), and a
         registry fixture with no entries renders no tab at all (gate E-1's positive control).

         `returnReviewMode` and `commentRequired` deliberately have NO control here: they are part of
         the persisted schema (publish validates them) but are not enforced yet — Lock-5 §1.2 ("no
         `returnReviewMode` control renders") and §1.3 respectively. `signaturePolicy` renders no
         control anywhere (OD-L5-10(a)). -->
    <section
      v-if="isTabbed && activeTabId === 'operations'"
      class="template-authoring__approval-node-section"
      data-testid="approval-node-section-operations"
    >
      <div class="template-authoring__field-perms" data-testid="approval-node-operation-policies">
        <div
          v-for="policy in operationPoliciesForNode"
          :key="policy.id"
          class="template-authoring__field-perm-row"
          data-testid="approval-node-operation-policy-row"
        >
          <el-checkbox
            :model-value="operationPolicyChecked(policy)"
            :disabled="readOnly || operationPolicyIsMixed(policy)"
            :data-testid="`approval-node-operation-policy-${policy.id}`"
            @update:model-value="(allowed: boolean) => setOperationPolicy(policy, allowed)"
          >{{ policy.label }}</el-checkbox>
          <!-- A-7 / M8: a persisted MIXED add/reduce pair is unrepresentable by one checkbox, so the
               control is disabled and says exactly why — never silently picking an arm. -->
          <span
            v-if="operationPolicyIsMixed(policy)"
            class="template-authoring__hint template-authoring__hint--warn"
            :data-testid="`approval-node-operation-policy-mixed-${policy.id}`"
          >{{ OPERATION_POLICY_MIXED_HINT }}</span>
        </div>
        <!-- §1.1 A-4: an in-flight instance pins its own frozen `published_definition_id`, so a flip
             reaches only instances created AFTER the next publish. The authoring copy must say so or
             an administrator reads the checkbox as immediate. -->
        <p class="template-authoring__hint" data-testid="approval-node-operation-policy-scope-hint">
          {{ OPERATION_POLICY_SCOPE_HINT }}
        </p>
      </div>
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
  ApprovalAssigneeSource,
  ApprovalAssigneeSourceKind,
  ApprovalMode,
  ApprovalNode,
  EmptyAssigneePolicy,
  HandlerMode,
  NodeFieldAccess,
  NodeOperationPolicy,
  ParallelNodeConfig,
  RequesterChoiceAssigneeSource,
  SupportedNodeTimeoutEffect,
} from '../../types/approval'
import {
  APPROVAL_NODE_CONFIG_EDITOR_KEY,
} from '../nodeConfigEditorContext'
import {
  CONDITION_RULE_OPERATORS,
  PARALLEL_JOIN_MODES,
  CC_TARGET_TYPES,
  NODE_TIMEOUT_MAX_AFTER_MINUTES,
  NODE_TIMEOUT_SUPPORTED_EFFECTS,
} from '../templateAuthoring'
import {
  APPROVAL_ASSIGNEE_SOURCE_LABELS,
  DEFAULT_APPROVAL_CAPABILITY_REGISTRY,
  assigneeSourceRoster,
  isRegisteredAssigneeSourceKind,
  type ApprovalCapabilityRegistry,
  type ApprovalOperationPolicyCapability,
} from '../approvalCapabilityRegistry'
import {
  OPERATION_POLICY_MIXED_HINT,
  OPERATION_POLICY_SCOPE_HINT,
  applyOperationPolicyControl,
  operationPolicyControlState,
} from '../nodeOperationPolicyEdit'
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
const assigneeSourceRosterForNode = computed(() => {
  const roster = assigneeSourceRoster(registry.value, props.node.type)
  // Lock-2 §2.4 C-7 form-schema precondition (gate D-6): the two contact-derived kinds are
  // OFFERED only when the form declares an eligible (top-level `user`) field — the affordance is
  // schema-selected, and the backend publish validator remains the enforcement (an affordance is
  // not a boundary). A kind ALREADY configured on this node stays offered regardless, so a
  // persisted source never loses its checked radio when the form's last user field is removed
  // (the unknown-value-safety posture: presentation must not orphan a stored value).
  if (userFields.value.length > 0) return roster
  const configuredKinds = new Set(
    (approvalNodeEditFor(props.node.key)?.assigneeSources ?? []).map((source) => source.kind),
  )
  return roster.filter(
    (capability) =>
      (capability.kind !== 'form_field_user_manager' && capability.kind !== 'form_field_user_dept_head')
      || configuredKinds.has(capability.kind),
  )
})
const operationPoliciesForNode = computed(
  () => registry.value.operationPoliciesByNodeType[props.node.type] ?? [],
)

// ── Lock-5 §1.1 L5-A — 操作权限 controls ───────────────────────────────────────────────────────
// The tab reads and writes the SAME `nodeOperationPolicy` object the server enforces (§2.3: one
// config, two doors — the FE mirror is not a second predicate). All projection logic lives in the
// pure `nodeOperationPolicyEdit` module so it is testable without mounting.
const nodeOperationPolicy = computed<NodeOperationPolicy | undefined>(() => {
  const edit = approvalNodeEditFor(props.node.key)
  // `null` ≡ the author cleared every switch; the persisted key is being removed.
  if (edit && edit.nodeOperationPolicy !== undefined) return edit.nodeOperationPolicy ?? undefined
  const config = props.node.config as { nodeOperationPolicy?: NodeOperationPolicy } | undefined
  return config?.nodeOperationPolicy
})

function operationPolicyIsMixed(capability: ApprovalOperationPolicyCapability): boolean {
  return operationPolicyControlState(nodeOperationPolicy.value, capability).kind === 'mixed'
}

function operationPolicyChecked(capability: ApprovalOperationPolicyCapability): boolean {
  const state = operationPolicyControlState(nodeOperationPolicy.value, capability)
  // A mixed pair has no single truth to show; the box renders unchecked AND disabled, with the
  // honest hint beside it saying the editor cannot express the persisted combination.
  return state.kind === 'editable' ? state.allowed : false
}

function setOperationPolicy(capability: ApprovalOperationPolicyCapability, allowed: boolean): void {
  const edit = approvalNodeEditFor(props.node.key)
  if (!edit) return
  // Fail-closed at the mutator, not only via `:disabled`: a disabled Element-Plus checkbox still
  // has a programmatic update path, and a mixed pair must never be collapsed by a stray write.
  if (operationPolicyIsMixed(capability)) return
  edit.nodeOperationPolicy = applyOperationPolicyControl(nodeOperationPolicy.value, capability, allowed) ?? null
}

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
// Lock-1 §K1: org-scoped bound-group picker options + loading flag.
const memberGroupOptions = computed(() => unwrap(api.memberGroupOptions))
const memberGroupOptionsLoading = computed(() => Boolean(unwrap(api.memberGroupOptionsLoading)))

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
// Lock-1 §K1: the user_group source's dedicated id carrier.
const approvalSourceGroupIds = api.approvalSourceGroupIds
const setApprovalSourceGroupIds = api.setApprovalSourceGroupIds
const approvalSourceFieldId = api.approvalSourceFieldId
const setApprovalSourceFieldId = api.setApprovalSourceFieldId
const approvalSourceLevel = api.approvalSourceLevel
const setApprovalSourceLevel = api.setApprovalSourceLevel
const approvalSourceIsPlaceholder = api.approvalSourceIsPlaceholder
// P1-B: multi-source card list — count drives the v-for, add/remove mutate the array. remove is
// fail-closed in the mutator itself (api.removeApprovalSourceCard refuses at length<=1); the
// `:disabled` binding below is UX only, never the sole guard.
const approvalSourceCount = api.approvalSourceCount
const addApprovalSourceCard = api.addApprovalSourceCard
const removeApprovalSourceCard = api.removeApprovalSourceCard
const approvalNodeMode = api.approvalNodeMode
const setApprovalNodeMode = api.setApprovalNodeMode
// P1-C (T2-4 N-of-M / 门槛会签 + T1-1 node timeout).
const approvalNodeThreshold = api.approvalNodeThreshold
const setApprovalNodeThreshold = api.setApprovalNodeThreshold
const approvalNodeInParallelRegion = api.approvalNodeInParallelRegion
const approvalNodeTimeout = api.approvalNodeTimeout
const setApprovalNodeTimeoutEnabled = api.setApprovalNodeTimeoutEnabled
const setApprovalNodeTimeoutAfterMinutes = api.setApprovalNodeTimeoutAfterMinutes
const setApprovalNodeTimeoutEffect = api.setApprovalNodeTimeoutEffect
const setApprovalNodeTimeoutTransferToUserId = api.setApprovalNodeTimeoutTransferToUserId
const setApprovalNodeTimeoutJumpToNodeKey = api.setApprovalNodeTimeoutJumpToNodeKey
const setApprovalNodeTimeoutUnit = api.setApprovalNodeTimeoutUnit
const timeoutJumpTargetOptions = api.timeoutJumpTargetOptions
const NODE_TIMEOUT_EFFECT_OPTION_LABELS: Record<SupportedNodeTimeoutEffect, string> = {
  remind: '催办提醒',
  transfer: '转交他人',
  jump: '跳转节点',
}
function nodeTimeoutEffectOptionLabel(effect: SupportedNodeTimeoutEffect): string {
  return NODE_TIMEOUT_EFFECT_OPTION_LABELS[effect]
}
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
const formatMemberGroupLabel = api.formatMemberGroupLabel
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
 *  not know about (legacy/unratified). Read-only in that case — never mutated, never flattened.
 *  P1-B: per-CARD now — a node with N sources can have an unknown kind on any one of them, and only
 *  THAT card must warn/read-only, not the whole node. */
function isKnownAssigneeSourceKind(nodeKey: string, sourceIndex: number): boolean {
  return isRegisteredAssigneeSourceKind(registry.value, props.node.type, approvalSourceKind(nodeKey, sourceIndex))
}
/** Registry-driven default kind for a brand-new card. Prefers `requester` — the SAME default
 *  `appendApprovalNode` seeds a brand-new node with (`graphTopologyEdit.ts`) — because it is valid
 *  with ZERO further configuration (`isAssigneeSourceValid` returns true for `{ kind: 'requester' }`
 *  unconditionally). The roster's raw first entry (`static_user`) is NOT a safe default: its shape
 *  is `{ kind: 'static_user', userIds: [] }`, which `isAssigneeSourceValid` REJECTS (empty
 *  `userIds`) — defaulting to it would make "＋添加审批人" immediately disable Save on every click
 *  until the author manually picks users, on a template that validated fine before the click. Falls
 *  back to the roster's first entry only if `requester` is somehow absent from this node type's
 *  roster (never true at the shipped baseline: both `approval` and `handler` include it — defensive
 *  only, never hand-picked outside the registry per master M4). */
function defaultNewSourceKind(): ApprovalAssigneeSourceKind {
  const roster = assigneeSourceRosterForNode.value
  if (roster.some((opt) => opt.kind === 'requester')) return 'requester'
  return roster[0]?.kind ?? 'requester'
}

// ── Lock-1 §K2 requester_choice sub-form ────────────────────────────────────────────────────
// Reads/writes the CARD AT sourceIndex of the SHARED approvalNodeEditFor edit model directly (the
// same live model the roster's kind switch mutates), so no new context-api surface is needed
// and both presentations (canvas inspector tabs / flat structured list) stay one source. P1-B:
// parameterized by sourceIndex — a node may carry more than one requester_choice card.
function requesterChoiceSourceFor(nodeKey: string, sourceIndex: number): RequesterChoiceAssigneeSource | null {
  const source = approvalNodeEditFor(nodeKey)?.assigneeSources[sourceIndex]
  return source?.kind === 'requester_choice' ? source : null
}
function replaceRequesterChoiceSource(nodeKey: string, sourceIndex: number, next: RequesterChoiceAssigneeSource): void {
  const edit = approvalNodeEditFor(nodeKey)
  if (!edit) return
  if (sourceIndex < 0 || sourceIndex >= edit.assigneeSources.length) return
  const nextSources = edit.assigneeSources.slice()
  nextSources[sourceIndex] = next
  edit.assigneeSources = nextSources
}
function requesterChoiceMode(nodeKey: string, sourceIndex: number): 'single' | 'multi' {
  return requesterChoiceSourceFor(nodeKey, sourceIndex)?.mode ?? 'single'
}
function setRequesterChoiceMode(nodeKey: string, sourceIndex: number, mode: 'single' | 'multi'): void {
  const source = requesterChoiceSourceFor(nodeKey, sourceIndex)
  if (!source || source.mode === mode) return
  replaceRequesterChoiceSource(nodeKey, sourceIndex, { ...source, mode })
}
function requesterChoiceScopeType(nodeKey: string, sourceIndex: number): 'company' | 'members' | 'role' {
  return requesterChoiceSourceFor(nodeKey, sourceIndex)?.scope.type ?? 'company'
}
function setRequesterChoiceScopeType(nodeKey: string, sourceIndex: number, type: 'company' | 'members' | 'role'): void {
  const source = requesterChoiceSourceFor(nodeKey, sourceIndex)
  if (!source || source.scope.type === type) return
  // A scope switch starts with an EMPTY id list deliberately: userIds and roleIds are different
  // id domains, so carrying one list into the other scope would author wrong config.
  const scope: RequesterChoiceAssigneeSource['scope'] =
    type === 'members' ? { type: 'members', userIds: [] }
      : type === 'role' ? { type: 'role', roleIds: [] }
        : { type: 'company' }
  replaceRequesterChoiceSource(nodeKey, sourceIndex, { ...source, scope })
}
function requesterChoiceScopeIds(nodeKey: string, sourceIndex: number): string[] {
  const source = requesterChoiceSourceFor(nodeKey, sourceIndex)
  if (source?.scope.type === 'members') return source.scope.userIds
  if (source?.scope.type === 'role') return source.scope.roleIds
  return []
}
function setRequesterChoiceScopeIds(nodeKey: string, sourceIndex: number, ids: string[] | string): void {
  const source = requesterChoiceSourceFor(nodeKey, sourceIndex)
  if (!source) return
  const list = Array.isArray(ids) ? ids : ids ? [ids] : []
  if (source.scope.type === 'members') {
    replaceRequesterChoiceSource(nodeKey, sourceIndex, { ...source, scope: { type: 'members', userIds: list } })
  } else if (source.scope.type === 'role') {
    replaceRequesterChoiceSource(nodeKey, sourceIndex, { ...source, scope: { type: 'role', roleIds: list } })
  }
}

// ── Lock-1 §K3 prior_node_approver sub-form ─────────────────────────────────────────────────
// Same pattern as the §K2 sub-form above: reads/writes the card AT sourceIndex of the SHARED
// approvalNodeEditFor edit model directly. Candidates come from the api's OPTIONAL
// `priorApproverNodeOptions` (always present on the shipped app's api object; component tests
// that don't exercise K3 omit it — the picker then offers nothing, mutating nothing).
function priorNodeApproverSourceFor(nodeKey: string, sourceIndex: number): Extract<ApprovalAssigneeSource, { kind: 'prior_node_approver' }> | null {
  const source = approvalNodeEditFor(nodeKey)?.assigneeSources[sourceIndex]
  return source?.kind === 'prior_node_approver' ? source : null
}
function priorNodeApproverKey(nodeKey: string, sourceIndex: number): string {
  return priorNodeApproverSourceFor(nodeKey, sourceIndex)?.nodeKey ?? ''
}
function setPriorNodeApproverKey(nodeKey: string, sourceIndex: number, referencedNodeKey: string): void {
  const source = priorNodeApproverSourceFor(nodeKey, sourceIndex)
  if (!source || source.nodeKey === referencedNodeKey) return
  const edit = approvalNodeEditFor(nodeKey)
  if (!edit) return
  if (sourceIndex < 0 || sourceIndex >= edit.assigneeSources.length) return
  const nextSources = edit.assigneeSources.slice()
  nextSources[sourceIndex] = { ...source, nodeKey: referencedNodeKey }
  edit.assigneeSources = nextSources
}
const priorApproverNodeOptionsApi = api.priorApproverNodeOptions
function priorApproverNodeOptionsFor(nodeKey: string): Array<{ key: string; label: string }> {
  return priorApproverNodeOptionsApi?.(nodeKey) ?? []
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
 *  `nodeConfigSummary` already applies to those three kinds (count/label only).
 *  P1-B: per-card now — each source card echoes its OWN configured summary. */
function configuredSourceSummaryLine(nodeKey: string, sourceIndex: number): string {
  if (!isKnownAssigneeSourceKind(nodeKey, sourceIndex)) return ''
  const source = approvalNodeEditFor(nodeKey)?.assigneeSources[sourceIndex]
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
  if (source.kind === 'prior_node_approver') {
    // §K3 echo — the referenced node's display label (a template-authored name/key, no person id).
    return `已配置：${label}${source.nodeKey ? `（${graphNodeLabel(source.nodeKey)}）` : '（未选择）'}`
  }
  return `已配置：${label}`
}

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

/* P1-B: cards stay flat (no nested box) — a thin top divider separates card N+1 from card N, same
   "flat, no card-in-card" posture as the roster above. First card gets no divider. */
.approval-node-source-card + .approval-node-source-card {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed var(--el-border-color);
}

.approval-node-source-card-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 4px;
}

.approval-node-source-add {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
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
