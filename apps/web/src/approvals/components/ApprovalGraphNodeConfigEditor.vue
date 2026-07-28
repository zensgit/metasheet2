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
      <div
        v-for="branch in conditionEditFor(node.key)!.branches"
        :key="branch.edgeKey"
        class="template-authoring__condition-branch"
        data-testid="approval-condition-branch"
      >
        <div class="template-authoring__condition-branch-head">
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
         nodes (no assigneeSources) aren't seeded → fall to the read-only summary below. -->
    <div
      v-else-if="node.type === 'approval' && approvalNodeEditFor(node.key)"
      class="template-authoring__approval-node"
      data-testid="approval-node-editor"
      :data-approval-node="node.key"
    >
      <el-form-item label="审批人来源">
        <el-select
          :model-value="approvalSourceKind(node.key)"
          size="small"
          :disabled="readOnly"
          class="ms-w-240"
          data-testid="approval-node-source-kind"
          @update:model-value="(kind: ApprovalAssigneeSourceKind) => { setApprovalSourceKind(node.key, kind); syncApprovalNodeOptions(node.key) }"
        >
          <el-option
            v-for="opt in APPROVAL_NODE_SOURCE_KINDS"
            :key="opt.value"
            :label="opt.label"
            :value="opt.value"
          />
        </el-select>
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
        v-else-if="approvalSourceKind(node.key) === 'manager_at_level' || approvalSourceKind(node.key) === 'continuous_managers'"
        :label="approvalSourceKind(node.key) === 'manager_at_level' ? '指定上级层级' : '上级层级数'"
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
      <div class="template-authoring__grid template-authoring__approval-node-policy">
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
        </div>
      </div>
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
  ApprovalAssigneeSourceKind,
  ApprovalMode,
  ApprovalNode,
  EmptyAssigneePolicy,
  NodeFieldAccess,
  ParallelNodeConfig,
} from '../../types/approval'
import {
  APPROVAL_NODE_CONFIG_EDITOR_KEY,
} from '../nodeConfigEditorContext'
import {
  CONDITION_RULE_OPERATORS,
  PARALLEL_JOIN_MODES,
  CC_TARGET_TYPES,
} from '../templateAuthoring'

const props = defineProps<{
  node: ApprovalNode
}>()

const api = inject(APPROVAL_NODE_CONFIG_EDITOR_KEY)
if (!api) {
  throw new Error('ApprovalGraphNodeConfigEditor requires APPROVAL_NODE_CONFIG_EDITOR_KEY')
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
const approvalNodeFieldAccess = api.approvalNodeFieldAccess
const setApprovalNodeFieldAccess = api.setApprovalNodeFieldAccess
const nodeConfigSummary = api.nodeConfigSummary
const onUserSearch = api.onUserSearch
const formatUserLabel = api.formatUserLabel
const formatRoleLabel = api.formatRoleLabel

const APPROVAL_NODE_SOURCE_KINDS: { value: import('../../types/approval').ApprovalAssigneeSourceKind; label: string }[] = [
  { value: 'static_user', label: '指定用户' },
  { value: 'static_role', label: '指定角色' },
  { value: 'requester', label: '发起人' },
  { value: 'direct_manager', label: '直属上级' },
  { value: 'dept_head', label: '部门主管' },
  { value: 'continuous_managers', label: '连续多级上级' },
  { value: 'manager_at_level', label: '指定层级上级' },
  { value: 'form_field_user', label: '表单用户字段' },
]

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

/* G-3 / G-4 shells (compact; no nested cards) */
.template-authoring__parallel,
.template-authoring__cc,
.template-authoring__approval-node {
  min-width: 0;
}

.template-authoring__approval-node-policy {
  margin-top: 8px;
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
