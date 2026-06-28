<template>
  <section class="template-authoring">
    <header class="template-authoring__header">
      <el-button text @click="goBack">
        <el-icon><ArrowLeft /></el-icon>
        返回模板列表
      </el-button>
      <div>
        <h1>{{ isEditMode ? '编辑审批模板' : '新建审批模板' }}</h1>
        <p>面向模板管理员的线性审批模板编辑器</p>
      </div>
      <div class="template-authoring__actions">
        <el-button
          :loading="saving"
          :disabled="!canSave"
          data-testid="approval-template-save-button"
          @click="handleSave"
        >
          保存草稿
        </el-button>
        <el-button
          type="primary"
          :loading="publishing"
          :disabled="!canSave"
          data-testid="approval-template-publish-button"
          @click="handlePublish"
        >
          发布
        </el-button>
      </div>
    </header>

    <el-alert
      v-if="!canManageTemplates"
      title="你没有模板管理权限"
      type="warning"
      show-icon
      :closable="false"
      class="template-authoring__alert"
    />

    <el-alert
      v-if="unsupportedReason"
      :title="unsupportedReason"
      description="该模板包含当前 MVP 不支持编辑的结构。为避免静默覆盖，页面只允许查看，不能保存。"
      type="warning"
      show-icon
      :closable="false"
      class="template-authoring__alert"
      data-testid="approval-template-unsupported-alert"
    />

    <!-- G-1..G-5: a complex graph is preserved, not unsupported — informational, save stays enabled.
         G-2 condition rules, G-3 parallel joinMode, G-4 cc targets, and G-5 approval-node source are
         all editable; branches / join target / all edges are preserved topology. -->
    <el-alert
      v-if="!unsupportedReason && graphReadOnlyMessage"
      :title="graphReadOnlyMessage"
      description="表单与基本信息可编辑；条件分支节点可编辑分支规则，并行节点可编辑汇聚模式，抄送节点可编辑抄送对象，审批节点可编辑审批人来源。分支拓扑与连线在保存时原样保留。"
      type="info"
      show-icon
      :closable="false"
      class="template-authoring__alert"
      data-testid="approval-template-graph-readonly-alert"
    />

    <el-alert
      v-if="loadError || validationErrors.length"
      :title="loadError || '请修正后再保存'"
      type="error"
      show-icon
      class="template-authoring__alert"
      @close="clearErrors"
    >
      <template v-if="validationErrors.length" #default>
        <ul class="template-authoring__error-list">
          <li v-for="error in validationErrors" :key="error">{{ error }}</li>
        </ul>
      </template>
    </el-alert>

    <div v-loading="loading" class="template-authoring__body">
      <el-card
        v-if="showPresetLibrary"
        class="template-authoring__panel"
        shadow="never"
        data-testid="approval-template-preset-library"
      >
        <template #header>
          <div class="template-authoring__panel-header">
            <strong>常用审批模板</strong>
            <span class="template-authoring__hint">创建为草稿，发布前可继续调整字段和审批人。</span>
          </div>
        </template>
        <div class="template-authoring__preset-grid">
          <div
            v-for="preset in commonTemplatePresets"
            :key="preset.id"
            class="template-authoring__preset"
          >
            <div>
              <strong>{{ preset.title }}</strong>
              <p>{{ preset.description }}</p>
            </div>
            <el-button
              type="primary"
              plain
              :loading="creatingPresetId === preset.id"
              :disabled="creatingPresetId !== null"
              :data-testid="`approval-template-preset-${preset.id}`"
              @click="createFromPreset(preset.id)"
            >
              使用模板
            </el-button>
          </div>
        </div>
      </el-card>

      <el-card class="template-authoring__panel" shadow="never">
        <template #header>
          <strong>基本信息</strong>
        </template>
        <el-form label-position="top" class="template-authoring__grid">
          <el-form-item label="模板 Key">
            <el-input v-model="draft.key" :disabled="readOnly" data-testid="approval-template-key" />
          </el-form-item>
          <el-form-item label="模板名称">
            <el-input v-model="draft.name" :disabled="readOnly" data-testid="approval-template-name" />
          </el-form-item>
          <el-form-item label="分类">
            <el-input v-model="draft.category" :disabled="readOnly" placeholder="如 请假 / 采购 / 报销" />
          </el-form-item>
          <el-form-item label="SLA 小时">
            <el-input v-model="draft.slaHoursText" :disabled="readOnly" placeholder="留空表示不启用" />
          </el-form-item>
          <el-form-item label="描述" class="template-authoring__wide">
            <el-input
              v-model="draft.description"
              :disabled="readOnly"
              type="textarea"
              :rows="3"
            />
          </el-form-item>
          <el-form-item label="可见范围">
            <div class="template-authoring__inline">
              <el-select v-model="draft.visibilityType" :disabled="readOnly" style="width: 140px">
                <el-option label="全员" value="all" />
                <el-option label="部门" value="dept" />
                <el-option label="角色" value="role" />
                <el-option label="用户" value="user" />
              </el-select>
              <el-input
                v-model="draft.visibilityIdsText"
                :disabled="readOnly || draft.visibilityType === 'all'"
                placeholder="逗号分隔 id"
              />
            </div>
          </el-form-item>
          <el-form-item label="发布策略">
            <el-checkbox v-model="draft.allowRevoke" :disabled="readOnly">
              允许发起人撤回
            </el-checkbox>
          </el-form-item>
        </el-form>
      </el-card>

      <el-card class="template-authoring__panel" shadow="never">
        <template #header>
          <div class="template-authoring__panel-header">
            <strong>表单字段</strong>
            <el-button
              size="small"
              :disabled="readOnly"
              data-testid="approval-template-add-field"
              @click="addField"
            >
              <el-icon><Plus /></el-icon>
              添加字段
            </el-button>
          </div>
        </template>

        <div
          v-for="(field, index) in draft.fields"
          :key="field.localId"
          class="template-authoring__item"
          data-testid="approval-template-field-row"
          :draggable="!readOnly"
          @dragstart="onFieldDragStart(index)"
          @dragover.prevent
          @drop="onFieldDrop(index)"
        >
          <div class="template-authoring__item-toolbar">
            <strong>字段 {{ index + 1 }}</strong>
            <div>
              <el-button size="small" :disabled="readOnly || index === 0" @click="moveField(index, -1)">上移</el-button>
              <el-button size="small" :disabled="readOnly || index === draft.fields.length - 1" @click="moveField(index, 1)">下移</el-button>
              <el-button size="small" type="danger" :disabled="readOnly || draft.fields.length === 1" @click="removeField(index)">删除</el-button>
            </div>
          </div>
          <div class="template-authoring__grid">
            <el-form-item label="字段 ID">
              <el-input v-model="field.id" :disabled="readOnly" />
            </el-form-item>
            <el-form-item label="字段名称">
              <el-input v-model="field.label" :disabled="readOnly" />
            </el-form-item>
            <el-form-item label="类型">
              <el-select v-model="field.type" :disabled="readOnly" style="width: 100%">
                <el-option label="文本" value="text" />
                <el-option label="多行文本" value="textarea" />
                <el-option label="数字" value="number" />
                <el-option label="日期" value="date" />
                <el-option label="日期时间" value="datetime" />
                <el-option label="单选" value="select" />
                <el-option label="多选" value="multi-select" />
                <el-option label="用户" value="user" />
                <el-option label="明细（子表单）" value="detail" />
              </el-select>
            </el-form-item>
            <el-form-item label="占位文本">
              <el-input v-model="field.placeholder" :disabled="readOnly" />
            </el-form-item>
            <el-form-item label="是否必填">
              <el-checkbox v-model="field.required" :disabled="readOnly">必填</el-checkbox>
            </el-form-item>
            <el-form-item
              v-if="field.type === 'select' || field.type === 'multi-select'"
              label="选项"
              class="template-authoring__wide"
            >
              <el-input
                v-model="field.optionsText"
                :disabled="readOnly"
                type="textarea"
                :rows="3"
                placeholder="每行一个选项，格式：显示名:值"
              />
            </el-form-item>
            <!-- detail / sub-form (明细) config: sub-field list editor + minRows/maxRows. Each
                 sub-field is a LEAF type (no nested detail). Mirrors the backend column schema. -->
            <el-form-item
              v-if="field.type === 'detail'"
              label="明细子字段"
              class="template-authoring__wide"
            >
              <div class="template-authoring__detail" data-testid="approval-detail-config">
                <el-table
                  v-if="field.detailColumns.length > 0"
                  :data="field.detailColumns"
                  border
                  size="small"
                  class="template-authoring__detail-table"
                >
                  <el-table-column label="子字段 ID" min-width="120">
                    <template #default="{ row }">
                      <el-input v-model="row.id" :disabled="readOnly" placeholder="如 product" />
                    </template>
                  </el-table-column>
                  <el-table-column label="名称" min-width="120">
                    <template #default="{ row }">
                      <el-input v-model="row.label" :disabled="readOnly" placeholder="如 品名" />
                    </template>
                  </el-table-column>
                  <el-table-column label="类型" min-width="120">
                    <template #default="{ row }">
                      <el-select v-model="row.type" :disabled="readOnly" style="width: 100%">
                        <el-option
                          v-for="leaf in detailLeafTypeOptions"
                          :key="leaf.value"
                          :label="leaf.label"
                          :value="leaf.value"
                        />
                      </el-select>
                    </template>
                  </el-table-column>
                  <el-table-column label="必填" width="70" align="center">
                    <template #default="{ row }">
                      <el-checkbox v-model="row.required" :disabled="readOnly" />
                    </template>
                  </el-table-column>
                  <el-table-column label="选项" min-width="160">
                    <template #default="{ row }">
                      <el-input
                        v-if="row.type === 'select' || row.type === 'multi-select'"
                        v-model="row.optionsText"
                        :disabled="readOnly"
                        type="textarea"
                        :rows="2"
                        placeholder="每行一个：显示名:值"
                      />
                      <span v-else class="template-authoring__hint">—</span>
                    </template>
                  </el-table-column>
                  <el-table-column label="操作" width="70" align="center">
                    <template #default="{ $index }">
                      <el-button
                        type="danger"
                        link
                        :disabled="readOnly"
                        @click="removeDetailColumn(field, $index)"
                      >
                        删除
                      </el-button>
                    </template>
                  </el-table-column>
                </el-table>
                <div v-else class="template-authoring__hint">尚无子字段，请添加至少一个。</div>
                <div class="template-authoring__detail-actions">
                  <el-button
                    size="small"
                    type="primary"
                    plain
                    :disabled="readOnly"
                    data-testid="approval-detail-add-column"
                    @click="addDetailColumn(field)"
                  >
                    添加子字段
                  </el-button>
                  <el-input
                    v-model="field.minRowsText"
                    :disabled="readOnly"
                    placeholder="最小行数"
                    style="width: 120px"
                  />
                  <el-input
                    v-model="field.maxRowsText"
                    :disabled="readOnly"
                    placeholder="最大行数"
                    style="width: 120px"
                  />
                </div>
              </div>
            </el-form-item>
            <el-form-item label="显隐规则" class="template-authoring__wide">
              <div class="template-authoring__visibility">
                <el-select
                  v-model="field.visibility.dependsOnFieldId"
                  :disabled="readOnly"
                  style="width: 200px"
                  data-testid="approval-field-visibility-depends"
                >
                  <el-option label="无（始终显示）" value="" />
                  <el-option
                    v-for="dep in visibilityFieldOptions(field)"
                    :key="dep.localId"
                    :label="dep.label"
                    :value="dep.id"
                  />
                </el-select>
                <template v-if="field.visibility.dependsOnFieldId">
                  <el-select
                    v-model="field.visibility.operator"
                    :disabled="readOnly"
                    style="width: 130px"
                    data-testid="approval-field-visibility-operator"
                  >
                    <el-option label="等于" value="eq" />
                    <el-option label="不等于" value="neq" />
                    <el-option label="包含" value="in" />
                    <el-option label="为空" value="isEmpty" />
                    <el-option label="不为空" value="notEmpty" />
                  </el-select>
                  <el-input
                    v-if="field.visibility.operator === 'in'"
                    v-model="field.visibility.valueText"
                    :disabled="readOnly"
                    type="textarea"
                    :rows="2"
                    placeholder="每行一个值"
                    style="width: 240px"
                    data-testid="approval-field-visibility-values"
                  />
                  <el-input
                    v-else-if="field.visibility.operator === 'eq' || field.visibility.operator === 'neq'"
                    v-model="field.visibility.valueText"
                    :disabled="readOnly"
                    placeholder="比较值"
                    style="width: 240px"
                    data-testid="approval-field-visibility-value"
                  />
                </template>
              </div>
              <div v-if="field.visibility.dependsOnFieldId" class="template-authoring__hint">
                仅当依赖字段满足条件时才显示本字段。
                <template v-if="field.visibility.operator === 'eq' || field.visibility.operator === 'neq'">
                  比较值留空表示「{{ field.visibility.operator === 'eq' ? '等于' : '不等于' }}空值」；要取消规则请把依赖字段设为「无」。
                </template>
              </div>
            </el-form-item>
          </div>
        </div>
      </el-card>

      <el-card class="template-authoring__panel" shadow="never">
        <template #header>
          <div class="template-authoring__panel-header">
            <strong>{{ graphReadOnly ? '审批流程（结构）' : '审批步骤' }}</strong>
            <el-button
              v-if="!graphReadOnly"
              size="small"
              :disabled="readOnly"
              data-testid="approval-template-add-step"
              @click="addStep"
            >
              <el-icon><Plus /></el-icon>
              添加审批人
            </el-button>
          </div>
        </template>

        <!-- G-1/G-2: structured render of a preserved complex graph. condition nodes are EDITABLE
             (G-2 — branch rules / conjunction / default edge); parallel / cc / approval stay
             READ-ONLY summaries (G-3 / G-4), and every non-condition node + all edges are preserved
             byte-for-byte on save. Nothing renders as a bare "unsupported". -->
        <!-- D-6 view toggle: structured list ⇄ visual canvas (complex graphs only) -->
        <div v-if="graphReadOnly" class="template-authoring__view-toggle" data-testid="approval-graph-view-toggle">
          <el-button size="small" :type="canvasViewMode === 'list' ? 'primary' : 'default'" data-testid="approval-view-list" @click="canvasViewMode = 'list'">结构列表</el-button>
          <el-button size="small" :type="canvasViewMode === 'canvas' ? 'primary' : 'default'" data-testid="approval-view-canvas" @click="canvasViewMode = 'canvas'">画布视图</el-button>
        </div>

        <!-- D-1/D-5 visual canvas: auto-laid-out nodes + SVG edges + topology toolbar + live validity.
             The mouse-drag GESTURE is manual/E2E QA; everything else is unit-covered. Node config is
             edited in the「结构列表」view (D-6 toggle). -->
        <div v-if="graphReadOnly && canvasViewMode === 'canvas'">
          <el-alert
            v-if="canvasValidity.length"
            type="warning"
            :closable="false"
            show-icon
            data-testid="approval-canvas-validity"
            title="画布结构校验（保存时后端为最终判定）"
          >
            <ul class="template-authoring__error-list"><li v-for="issue in canvasValidity" :key="issue">{{ issue }}</li></ul>
          </el-alert>
          <div
            class="template-authoring__canvas"
            data-testid="approval-graph-canvas"
            :style="{ position: 'relative', height: canvasLayout.height + 'px', width: canvasLayout.width + 'px' }"
          >
            <svg class="template-authoring__canvas-edges" :width="canvasLayout.width" :height="canvasLayout.height" style="position:absolute;left:0;top:0">
              <defs>
                <marker id="approval-canvas-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                  <path d="M0,0 L7,3 L0,6 Z" fill="#bbb" />
                </marker>
              </defs>
              <line
                v-for="line in canvasEdgeLines"
                :key="line.key"
                :x1="line.x1"
                :y1="line.y1"
                :x2="line.x2"
                :y2="line.y2"
                stroke="#bbb"
                stroke-width="1.5"
                marker-end="url(#approval-canvas-arrow)"
                data-testid="approval-canvas-edge"
              />
            </svg>
            <div
              v-for="pos in canvasLayout.nodes"
              :key="pos.key"
              class="template-authoring__canvas-node"
              :class="{ 'is-selected': selectedCanvasNode === pos.key }"
              :style="{ position: 'absolute', left: pos.x + 'px', top: pos.y + 'px', width: CANVAS_NODE_W + 'px' }"
              :data-canvas-node="pos.key"
              data-testid="approval-canvas-node"
              :draggable="!readOnly"
              @click="selectedCanvasNode = pos.key"
              @dragstart="onCanvasNodeDragStart(pos.key)"
              @dragend="onCanvasNodeDragEnd($event)"
            >
              <strong>{{ canvasNodeByKey(pos.key)?.name || pos.key }}</strong>
              <span class="template-authoring__node-type" :data-node-type="canvasNodeByKey(pos.key)?.type">
                {{ nodeTypeLabel(canvasNodeByKey(pos.key)?.type ?? 'approval') }}
              </span>
              <div v-if="!readOnly" class="template-authoring__canvas-node-actions">
                <el-button v-if="canvasNodeByKey(pos.key)?.type === 'condition'" size="small" :data-testid="`approval-canvas-add-condition-${pos.key}`" @click.stop="onAddConditionBranch(pos.key)">+条件分支</el-button>
                <el-button v-if="canvasNodeByKey(pos.key)?.type === 'parallel'" size="small" :data-testid="`approval-canvas-add-parallel-${pos.key}`" @click.stop="onAddParallelBranch(pos.key)">+并行分支</el-button>
                <el-button v-if="canInsertAfter(canvasNodeByKey(pos.key)!)" size="small" :data-testid="`approval-canvas-insert-${pos.key}`" @click.stop="onInsertApprovalAfter(pos.key)">下方插入</el-button>
                <el-button v-if="canRemoveNode(canvasNodeByKey(pos.key)!)" size="small" type="danger" :data-testid="`approval-canvas-remove-${pos.key}`" @click.stop="onRemoveNode(pos.key)">删除</el-button>
              </div>
            </div>
          </div>
          <p class="template-authoring__hint">画布用于查看与编排结构（增删节点 / 分支、拖动布局）。各节点的审批人 / 规则配置请切换到「结构列表」编辑。</p>
        </div>

        <div v-if="graphReadOnly && canvasViewMode === 'list'" data-testid="approval-graph-readonly-list">
          <div
            v-for="node in graphPreviewNodes"
            :key="node.key"
            class="template-authoring__item"
            data-testid="approval-graph-node-row"
          >
            <div class="template-authoring__item-toolbar">
              <strong>{{ node.name || node.key }}</strong>
              <span class="template-authoring__node-type" :data-node-type="node.type">
                {{ nodeTypeLabel(node.type) }}
              </span>
              <!-- D-2/D-3 topology authoring (structural, clickable — the free-drag canvas is the gated
                   next slice). Buttons are shown only when the graphTopologyEdit precondition holds. -->
              <div v-if="!readOnly" class="template-authoring__node-topology" data-testid="approval-node-topology-actions">
                <el-button
                  v-if="node.type === 'condition'"
                  size="small"
                  :data-testid="`approval-topology-add-condition-branch-${node.key}`"
                  @click="onAddConditionBranch(node.key)"
                >添加条件分支</el-button>
                <el-button
                  v-if="node.type === 'parallel'"
                  size="small"
                  :data-testid="`approval-topology-add-parallel-branch-${node.key}`"
                  @click="onAddParallelBranch(node.key)"
                >添加并行分支</el-button>
                <el-button
                  v-if="canInsertAfter(node)"
                  size="small"
                  :data-testid="`approval-topology-insert-after-${node.key}`"
                  @click="onInsertApprovalAfter(node.key)"
                >下方插入审批</el-button>
                <el-button
                  v-if="canRemoveNode(node)"
                  size="small"
                  type="danger"
                  :data-testid="`approval-topology-remove-${node.key}`"
                  @click="onRemoveNode(node.key)"
                >删除节点</el-button>
              </div>
            </div>

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
                  <span>分支 → {{ branch.edgeKey }}</span>
                  <el-select
                    :model-value="branch.predicateMode"
                    size="small"
                    :disabled="readOnly"
                    style="width: 130px"
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
                    style="width: 110px"
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
                      style="width: 160px"
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
                      style="width: 120px"
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
                      style="width: 160px"
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
                    <template v-if="directory.formulaRoles.value.length > 0">
                      <span
                        class="template-authoring__condition-formula-role-hint"
                        data-testid="approval-condition-formula-role-hint"
                      >requester.role（审批可用角色）：</span>
                      <el-button
                        v-for="role in directory.formulaRoles.value"
                        :key="role.id"
                        size="small"
                        :disabled="readOnly"
                        :title="`插入 requester.role in [&quot;${role.id}&quot;]`"
                        :data-testid="`approval-condition-formula-insert-role-${role.id}`"
                        @click="insertConditionFormulaRoleMembership(branch, role.id)"
                      >{{ directory.formatRoleLabel(role) }}</el-button>
                    </template>
                  </div>
                  <div class="template-authoring__condition-formula-dryrun">
                    <el-input
                      :model-value="conditionFormulaDryRunSample(node.key, branch.edgeKey)"
                      type="textarea"
                      :rows="2"
                      :disabled="readOnly"
                      placeholder='样例数据 JSON，例如 {"amount": 5000}'
                      data-testid="approval-condition-formula-dry-run-sample"
                      @update:model-value="(text: string) => setConditionFormulaDryRunSample(node.key, branch.edgeKey, text)"
                    />
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
                  style="width: 220px"
                  placeholder="（无默认分支）"
                  data-testid="approval-condition-default-edge"
                >
                  <el-option
                    v-for="edgeKey in conditionOutgoingEdgeKeys(node.key)"
                    :key="edgeKey"
                    :label="edgeKey"
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
                  style="width: 240px"
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
                <li>并行分支：{{ (node.config as ParallelNodeConfig).branches.join('、') || '（无）' }}</li>
                <li>汇聚节点：{{ (node.config as ParallelNodeConfig).joinNodeKey || '（无）' }}</li>
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
                  style="width: 240px"
                  data-testid="approval-cc-target-type"
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
                  v-model="ccEditFor(node.key)!.targetIds"
                  multiple
                  filterable
                  allow-create
                  default-first-option
                  size="small"
                  :disabled="readOnly"
                  style="width: 360px"
                  placeholder="输入用户/角色 ID 后回车"
                  data-testid="approval-cc-target-ids"
                />
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
                  style="width: 240px"
                  data-testid="approval-node-source-kind"
                  @update:model-value="(kind: ApprovalAssigneeSourceKind) => setApprovalSourceKind(node.key, kind)"
                >
                  <el-option
                    v-for="opt in APPROVAL_NODE_SOURCE_KINDS"
                    :key="opt.value"
                    :label="opt.label"
                    :value="opt.value"
                  />
                </el-select>
              </el-form-item>
              <el-form-item
                v-if="approvalSourceKind(node.key) === 'static_user' || approvalSourceKind(node.key) === 'static_role'"
                :label="approvalSourceKind(node.key) === 'static_user' ? '用户 ID' : '角色 ID'"
              >
                <el-select
                  :model-value="approvalSourceIds(node.key)"
                  multiple
                  filterable
                  allow-create
                  default-first-option
                  size="small"
                  :disabled="readOnly"
                  style="width: 360px"
                  placeholder="输入 ID 后回车"
                  data-testid="approval-node-source-ids"
                  @update:model-value="(ids: string[]) => setApprovalSourceIds(node.key, ids)"
                />
              </el-form-item>
              <el-form-item
                v-else-if="approvalSourceKind(node.key) === 'form_field_user'"
                label="表单用户字段 ID"
              >
                <el-input
                  :model-value="approvalSourceFieldId(node.key)"
                  size="small"
                  :disabled="readOnly"
                  style="width: 240px"
                  placeholder="顶层 user 字段 ID"
                  data-testid="approval-node-source-field"
                  @update:model-value="(fieldId: string) => setApprovalSourceFieldId(node.key, fieldId)"
                />
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
            </div>

            <!-- approval (legacy / no edit) / other — read-only summary. -->
            <template v-else>
              <ul v-if="nodeConfigSummary(node).length" class="template-authoring__node-summary">
                <li v-for="(line, lineIndex) in nodeConfigSummary(node)" :key="lineIndex">{{ line }}</li>
              </ul>
              <div v-else class="template-authoring__hint">（无可编辑配置）</div>
            </template>
          </div>
        </div>

        <div
          v-for="(step, index) in draft.steps"
          v-show="!graphReadOnly"
          :key="step.localId"
          class="template-authoring__item"
          data-testid="approval-template-step-row"
        >
          <div class="template-authoring__item-toolbar">
            <strong>审批步骤 {{ index + 1 }}</strong>
            <div>
              <el-button size="small" :disabled="readOnly || index === 0" @click="moveStep(index, -1)">上移</el-button>
              <el-button size="small" :disabled="readOnly || index === draft.steps.length - 1" @click="moveStep(index, 1)">下移</el-button>
              <el-button size="small" type="danger" :disabled="readOnly || draft.steps.length === 1" @click="removeStep(index)">删除</el-button>
            </div>
          </div>
          <div class="template-authoring__grid">
            <el-form-item label="步骤名称">
              <el-input v-model="step.name" :disabled="readOnly" />
            </el-form-item>
            <el-form-item label="审批人来源">
              <el-select v-model="step.sourceKind" :disabled="readOnly" style="width: 100%" data-testid="approval-step-source-kind" @change="syncStepOptions(step)">
                <el-option label="指定用户" value="static_user" />
                <el-option label="指定角色" value="static_role" />
                <el-option label="发起人" value="requester" />
                <el-option label="直属上级" value="direct_manager" />
                <el-option label="部门主管" value="dept_head" />
                <el-option label="连续多级上级" value="continuous_managers" />
                <el-option label="指定层级上级" value="manager_at_level" />
                <el-option label="表单用户字段" value="form_field_user" />
              </el-select>
            </el-form-item>
            <el-form-item v-if="step.sourceKind === 'continuous_managers'" label="上级层级数">
              <!-- v1: UI input cap fixed at 10. The backend cap is configurable
                   (APPROVAL_MANAGER_CHAIN_MAX_LEVELS, default 10, hard ceiling 50);
                   reading the server cap into :max so ops can author >10 is a follow-up. -->
              <el-input-number
                v-model="step.levels"
                :min="1"
                :max="10"
                :step="1"
                :disabled="readOnly"
                data-testid="approval-step-levels"
              />
            </el-form-item>
            <el-form-item v-if="step.sourceKind === 'manager_at_level'" label="指定上级层级">
              <el-input-number
                v-model="step.level"
                :min="1"
                :max="10"
                :step="1"
                :disabled="readOnly"
                data-testid="approval-step-level"
              />
            </el-form-item>
            <el-form-item v-if="step.sourceKind === 'static_user'" label="选择用户">
              <el-select
                :model-value="stepIds(step)"
                multiple
                filterable
                remote
                :remote-method="onUserSearch"
                :loading="directory.usersLoading.value"
                :disabled="readOnly"
                style="width: 100%"
                placeholder="搜索用户名 / 邮箱 / ID"
                data-testid="approval-step-user-picker"
                @update:model-value="(ids: string[]) => setStepIds(step, ids)"
                @visible-change="(visible: boolean) => visible && onUserSearch('')"
              >
                <el-option
                  v-for="user in directory.users.value"
                  :key="user.id"
                  :label="directory.formatUserLabel(user)"
                  :value="user.id"
                />
              </el-select>
            </el-form-item>
            <el-form-item v-if="step.sourceKind === 'static_role'" label="选择角色">
              <el-select
                :model-value="stepIds(step)"
                multiple
                filterable
                :disabled="readOnly"
                style="width: 100%"
                placeholder="选择角色"
                data-testid="approval-step-role-picker"
                @update:model-value="(ids: string[]) => setStepIds(step, ids)"
              >
                <el-option
                  v-for="role in directory.roles.value"
                  :key="role.id"
                  :label="directory.formatRoleLabel(role)"
                  :value="role.id"
                />
              </el-select>
            </el-form-item>
            <el-form-item v-if="step.sourceKind === 'static_user' || step.sourceKind === 'static_role'" label="手动输入 ID（高级）">
              <el-input v-model="step.idsText" :disabled="readOnly" placeholder="逗号或换行分隔" data-testid="approval-step-ids-text" />
            </el-form-item>
            <el-form-item v-if="step.sourceKind === 'form_field_user'" label="表单用户字段">
              <el-select v-model="step.fieldId" :disabled="readOnly" style="width: 100%">
                <el-option
                  v-for="field in userFields"
                  :key="field.id"
                  :label="`${field.label} (${field.id})`"
                  :value="field.id"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="审批模式">
              <el-select v-model="step.approvalMode" :disabled="readOnly" style="width: 100%">
                <el-option label="单人通过" value="single" />
                <el-option label="全部通过" value="all" />
                <el-option label="任一通过" value="any" />
              </el-select>
            </el-form-item>
            <el-form-item label="空审批人策略">
              <el-select v-model="step.emptyAssigneePolicy" :disabled="readOnly" style="width: 100%">
                <el-option label="报错" value="error" />
                <el-option label="自动通过" value="auto-approve" />
              </el-select>
            </el-form-item>
            <el-form-item label="自审策略">
              <el-checkbox
                v-model="step.mergeWithRequester"
                :disabled="readOnly"
                data-testid="approval-step-merge-with-requester"
              >
                发起人自动通过（自审合并）
              </el-checkbox>
            </el-form-item>
          </div>
        </div>
      </el-card>

      <el-card class="template-authoring__panel" shadow="never">
        <template #header>
          <strong>JSON 预览</strong>
        </template>
        <el-collapse>
          <el-collapse-item title="formSchema" name="form">
            <pre data-testid="approval-template-form-preview">{{ formSchemaPreview }}</pre>
          </el-collapse-item>
          <el-collapse-item title="approvalGraph" name="graph">
            <pre data-testid="approval-template-graph-preview">{{ approvalGraphPreview }}</pre>
          </el-collapse-item>
        </el-collapse>
      </el-card>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, Plus } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useApprovalPermissions } from '../../approvals/permissions'
import {
  createTemplate,
  dryRunApprovalConditionFormula,
  getTemplate,
  publishTemplate,
  updateTemplate,
} from '../../approvals/api'
import {
  buildApprovalGraph,
  buildCreateTemplatePayload,
  buildFormSchema,
  buildUpdateTemplatePayload,
  createEmptyDetailColumnDraft,
  createEmptyFieldDraft,
  createEmptyStepDraft,
  createEmptyTemplateDraft,
  DETAIL_LEAF_FIELD_TYPES,
  draftFromTemplate,
  graphReadOnlyReason,
  parseIdsText,
  unsupportedTemplateAuthoringReason,
  validateTemplateDraft,
  approvalFormulaInsertOptions,
  CONDITION_RULE_OPERATORS,
  PARALLEL_JOIN_MODES,
  CC_TARGET_TYPES,
  type ApprovalStepDraft,
  type ConditionBranchEdit,
  type ConditionNodeEdit,
  type ConditionRuleEdit,
  type ConditionRuleOperator,
  type FieldAuthoringDraft,
  type ParallelNodeEdit,
  type CcNodeEdit,
  type ApprovalNodeSourceEdit,
  type TemplateAuthoringDraft,
  applyTopologyToComplexDraft,
  moveItemToIndex,
} from '../../approvals/templateAuthoring'
import {
  addConditionBranch,
  addParallelBranch,
  appendApprovalNode,
  removeLinearNode,
} from '../../approvals/graphTopologyEdit'
import { computeLayout, graphValidityIssues, type GraphLayout } from '../../approvals/graphLayout'
import {
  buildCommonApprovalTemplatePresetPayload,
  COMMON_APPROVAL_TEMPLATE_PRESETS,
  type CommonApprovalTemplatePresetId,
} from '../../approvals/commonTemplatePresets'
import { APPROVAL_ROLE_CONFIGURE_SENTINEL } from '../../types/approval'
import type {
  ApprovalAssigneeSource,
  ApprovalAssigneeSourceKind,
  ApprovalAssigneeType,
  ApprovalGraph,
  ApprovalNode,
  CcNodeConfig,
  ConditionNodeConfig,
  ParallelJoinMode,
  ParallelNodeConfig,
} from '../../types/approval'
import { useApprovalDirectory } from '../../approvals/useApprovalDirectory'

const route = useRoute()
const router = useRouter()
const { canManageTemplates } = useApprovalPermissions()

const loading = ref(false)
const saving = ref(false)
const publishing = ref(false)
const creatingPresetId = ref<CommonApprovalTemplatePresetId | null>(null)
const loadError = ref<string | null>(null)
const validationErrors = ref<string[]>([])
const unsupportedReason = ref<string | null>(null)
// G-1: a COMPLEX (condition/parallel/cc/non-linear) graph renders read-only but is NOT
// unsupported — the form/metadata stay editable and save preserves the graph verbatim.
const graphReadOnlyMessage = ref<string | null>(null)
const draft = ref<TemplateAuthoringDraft>(createEmptyTemplateDraft())
const conditionFormulaDryRunSamples = ref<Record<string, string>>({})
const conditionFormulaDryRunResults = ref<Record<string, string>>({})
const conditionFormulaDryRunBusy = ref<Record<string, boolean>>({})

const templateId = computed(() => typeof route.params.id === 'string' ? route.params.id : '')
const isEditMode = computed(() => templateId.value.length > 0)
const commonTemplatePresets = COMMON_APPROVAL_TEMPLATE_PRESETS
const showPresetLibrary = computed(() => !isEditMode.value && canManageTemplates.value)
// Truly-unsupported (attachment field / unknown node / extra config keys) locks the WHOLE form.
const readOnly = computed(() => !canManageTemplates.value || Boolean(unsupportedReason.value))
// A complex graph is shown via the read-only structured node list (`graphPreviewNodes`); the
// linear steps editor is hidden. The graph is preserved on save, so this does NOT disable save.
const graphReadOnly = computed(() => Boolean(graphReadOnlyMessage.value))
const canSave = computed(() => canManageTemplates.value && !unsupportedReason.value && !loading.value)

// G-1 read-only structured render of a preserved complex graph: a per-node summary of the
// config the v1 editor doesn't yet author, so authors can SEE the flow they're preserving.
const graphPreviewNodes = computed<ApprovalNode[]>(() => draft.value.preservedGraph?.nodes ?? [])

const NODE_TYPE_LABELS: Record<string, string> = {
  start: '发起',
  approval: '审批',
  cc: '抄送',
  condition: '条件分支',
  parallel: '并行分支',
  end: '结束',
}
function nodeTypeLabel(type: string): string {
  return NODE_TYPE_LABELS[type] ?? type
}

function assigneeSourceSummary(source: ApprovalAssigneeSource): string {
  switch (source.kind) {
    case 'static_user': return `指定用户：${source.userIds.join('、') || '（无）'}`
    case 'static_role': return `指定角色：${source.roleIds.join('、') || '（无）'}`
    case 'requester': return '发起人'
    case 'form_field_user': return `表单用户字段：${source.fieldId}`
    case 'direct_manager': return '直属上级'
    case 'dept_head': return '部门主管'
    case 'continuous_managers': return `连续多级上级（${source.levels} 级）`
    case 'manager_at_level': return `指定层级上级（第 ${source.level} 级）`
    default: return JSON.stringify(source)
  }
}

// One read-only descriptor per node config, covering ALL three complex types (condition / parallel
// / cc) plus approval — so no type silently renders as "unsupported". Returns `[]` for nodes
// without summarisable config (start/end).
function nodeConfigSummary(node: ApprovalNode): string[] {
  const config = node.config as Record<string, unknown>
  if (node.type === 'condition') {
    const cfg = config as unknown as ConditionNodeConfig
    const lines = (cfg.branches ?? []).map((branch) => {
      const rules = (branch.rules ?? [])
        .map((rule) => `${rule.fieldId} ${rule.operator}${rule.value === undefined ? '' : ` ${JSON.stringify(rule.value)}`}`)
        .join(` ${branch.conjunction ?? 'and'} `)
      return `分支 → ${branch.edgeKey}：${rules || '（无规则）'}`
    })
    if (cfg.defaultEdgeKey) lines.push(`默认分支 → ${cfg.defaultEdgeKey}`)
    return lines
  }
  if (node.type === 'parallel') {
    const cfg = config as unknown as ParallelNodeConfig
    return [
      `并行分支：${(cfg.branches ?? []).join('、') || '（无）'}`,
      `汇聚节点：${cfg.joinNodeKey ?? '（无）'}`,
      `汇聚模式：${cfg.joinMode ?? '（无）'}`,
    ]
  }
  if (node.type === 'cc') {
    const cfg = config as unknown as CcNodeConfig
    return [
      `抄送类型：${cfg.targetType === 'role' ? '角色' : '用户'}`,
      `抄送对象：${(cfg.targetIds ?? []).join('、') || '（无）'}`,
    ]
  }
  if (node.type === 'approval') {
    const sources = Array.isArray(config.assigneeSources) ? config.assigneeSources as ApprovalAssigneeSource[] : []
    return sources.map((source) => `审批人：${assigneeSourceSummary(source)}`)
  }
  return []
}

// ── G-2 condition editor (logic-only; topology is preserved from `preservedGraph`) ──────────────
// The editable model lives on `draft.conditionEdits[nodeKey]`, seeded 1:1 from the preserved
// condition nodes. The controls below mutate ONLY rules / conjunction / defaultEdgeKey;
// `buildApprovalGraph` re-applies them onto a COPY of the graph (all other nodes + edges untouched).
function conditionEditFor(nodeKey: string): ConditionNodeEdit | undefined {
  return draft.value.conditionEdits?.[nodeKey]
}

// Field options for a rule's fieldId picker — the draft's authorable form fields (id + label).
const conditionFieldOptions = computed(() =>
  draft.value.fields
    .filter((field) => field.id.trim())
    .map((field) => ({ id: field.id.trim(), label: field.label.trim() || field.id.trim() })),
)
const conditionFormulaInsertOptions = computed(() =>
  approvalFormulaInsertOptions(buildFormSchema(draft.value)),
)

const CONDITION_OPERATOR_LABELS: Record<ConditionRuleOperator, string> = {
  eq: '等于',
  neq: '不等于',
  gt: '大于',
  gte: '大于等于',
  lt: '小于',
  lte: '小于等于',
  in: '包含于',
  isEmpty: '为空',
}
function conditionOperatorLabel(operator: ConditionRuleOperator): string {
  return CONDITION_OPERATOR_LABELS[operator] ?? operator
}

// The rule value is carried as `unknown` (round-trips a seeded value verbatim). The text input
// reads/writes a string; `isEmpty` carries no value (handled in the template by hiding the input).
function conditionRuleValueText(rule: ConditionRuleEdit): string {
  if (rule.value === undefined || rule.value === null) return ''
  return typeof rule.value === 'string' ? rule.value : String(rule.value)
}
function setConditionRuleValue(rule: ConditionRuleEdit, text: string): void {
  rule.value = text === '' ? undefined : text
}

function addConditionRule(branch: ConditionBranchEdit): void {
  branch.rules.push({ fieldId: '', operator: 'eq', value: undefined })
}
function removeConditionRule(branch: ConditionBranchEdit, ruleIndex: number): void {
  if (branch.rules.length === 1) return
  branch.rules.splice(ruleIndex, 1)
}
function setConditionBranchPredicateMode(branch: ConditionBranchEdit, mode: string): void {
  branch.predicateMode = mode === 'formula' ? 'formula' : 'rules'
  if (branch.predicateMode === 'rules' && branch.rules.length === 0) {
    branch.rules.push({ fieldId: '', operator: 'eq', value: undefined })
  }
}
function appendFormulaText(branch: ConditionBranchEdit, text: string): void {
  const prefix = branch.formulaExpression.trim() ? ' ' : ''
  branch.formulaExpression = `${branch.formulaExpression}${prefix}${text}`
}
function insertConditionFormulaToken(branch: ConditionBranchEdit, token: string): void {
  appendFormulaText(branch, token)
}
function insertConditionFormulaFunction(branch: ConditionBranchEdit, fn: 'SUM' | 'COUNT' | 'MIN' | 'MAX'): void {
  appendFormulaText(branch, `${fn}()`)
}
// CURATED-VOCABULARY (RA-1b): insert a ready `requester.role in ["<id>"]` membership for a CURATED role
// (from the formula-roles picker). JSON.stringify quotes/escapes the id so the inserted snippet always
// parses. Single-role is the common case; for multiple roles the author edits the array by hand.
function insertConditionFormulaRoleMembership(branch: ConditionBranchEdit, roleId: string): void {
  appendFormulaText(branch, `requester.role in [${JSON.stringify(roleId)}]`)
}

function conditionFormulaDryRunKey(nodeKey: string, edgeKey: string): string {
  return `${nodeKey}:${edgeKey}`
}
function conditionFormulaDryRunSample(nodeKey: string, edgeKey: string): string {
  return conditionFormulaDryRunSamples.value[conditionFormulaDryRunKey(nodeKey, edgeKey)] ?? '{}'
}
function setConditionFormulaDryRunSample(nodeKey: string, edgeKey: string, text: string): void {
  conditionFormulaDryRunSamples.value = {
    ...conditionFormulaDryRunSamples.value,
    [conditionFormulaDryRunKey(nodeKey, edgeKey)]: text,
  }
}
function conditionFormulaDryRunResult(nodeKey: string, edgeKey: string): string {
  return conditionFormulaDryRunResults.value[conditionFormulaDryRunKey(nodeKey, edgeKey)] ?? ''
}
function setConditionFormulaDryRunResult(nodeKey: string, edgeKey: string, text: string): void {
  conditionFormulaDryRunResults.value = {
    ...conditionFormulaDryRunResults.value,
    [conditionFormulaDryRunKey(nodeKey, edgeKey)]: text,
  }
}
function conditionFormulaDryRunLoading(nodeKey: string, edgeKey: string): boolean {
  return Boolean(conditionFormulaDryRunBusy.value[conditionFormulaDryRunKey(nodeKey, edgeKey)])
}
function setConditionFormulaDryRunLoading(nodeKey: string, edgeKey: string, loadingValue: boolean): void {
  conditionFormulaDryRunBusy.value = {
    ...conditionFormulaDryRunBusy.value,
    [conditionFormulaDryRunKey(nodeKey, edgeKey)]: loadingValue,
  }
}
async function dryRunConditionFormula(nodeKey: string, branch: ConditionBranchEdit): Promise<void> {
  const expression = branch.formulaExpression.trim()
  const resultKey = conditionFormulaDryRunKey(nodeKey, branch.edgeKey)
  if (!expression) {
    setConditionFormulaDryRunResult(nodeKey, branch.edgeKey, '请输入公式')
    return
  }
  let formData: Record<string, unknown>
  try {
    const parsed = JSON.parse(conditionFormulaDryRunSamples.value[resultKey] ?? '{}') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('样例数据必须是 JSON 对象')
    }
    formData = parsed as Record<string, unknown>
  } catch (error) {
    const message = error instanceof Error ? error.message : '样例数据不是有效 JSON'
    setConditionFormulaDryRunResult(nodeKey, branch.edgeKey, `样例数据错误：${message}`)
    return
  }
  setConditionFormulaDryRunLoading(nodeKey, branch.edgeKey, true)
  try {
    const result = await dryRunApprovalConditionFormula({
      formSchema: buildFormSchema(draft.value),
      expression,
      formData,
    })
    if (result.success) {
      setConditionFormulaDryRunResult(nodeKey, branch.edgeKey, `结果：${result.result ? 'true' : 'false'}`)
    } else {
      setConditionFormulaDryRunResult(
        nodeKey,
        branch.edgeKey,
        `错误：${result.error?.message ?? '公式测试失败'}`,
      )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '公式测试失败'
    setConditionFormulaDryRunResult(nodeKey, branch.edgeKey, `错误：${message}`)
  } finally {
    setConditionFormulaDryRunLoading(nodeKey, branch.edgeKey, false)
  }
}

// Outgoing edge keys of a condition node (from the preserved graph) — the legal default fall-through
// targets. Topology is read-only here, so these come straight from `preservedGraph.edges`.
function conditionOutgoingEdgeKeys(nodeKey: string): string[] {
  return (draft.value.preservedGraph?.edges ?? [])
    .filter((edge) => edge.source === nodeKey)
    .map((edge) => edge.key)
}

// ── G-3 parallel editor (joinMode ONLY; branches / joinNodeKey are preserved topology, read-only) ──
// The editable model lives on `draft.parallelEdits[nodeKey]`, seeded 1:1 from the preserved parallel
// nodes. The select below mutates ONLY `joinMode`; `buildApprovalGraph` re-applies it onto a COPY of
// the graph (branches/joinNodeKey + every non-parallel node + all edges untouched). Both 'all' and
// 'any' are offered because the backend `normalizeApprovalGraph` accepts both (`PARALLEL_JOIN_MODES`
// = {'all','any'}, joinMode written verbatim) and the runtime executes 'any' (first-wins).
function parallelEditFor(nodeKey: string): ParallelNodeEdit | undefined {
  return draft.value.parallelEdits?.[nodeKey]
}

const PARALLEL_JOIN_MODE_LABELS: Record<ParallelJoinMode, string> = {
  all: '全部完成（会签）',
  any: '任一完成（或签 / 抢占）',
}
function parallelJoinModeLabel(mode: ParallelJoinMode): string {
  return PARALLEL_JOIN_MODE_LABELS[mode] ?? mode
}

// ── G-4 cc editor (targetType + targetIds; the cc node's edges/position are preserved topology) ──
// Editable model on `draft.ccEdits[nodeKey]`, seeded 1:1 from the preserved cc nodes. The controls
// mutate ONLY targetType/targetIds; `buildApprovalGraph` re-applies onto a COPY (every non-cc node +
// all edges untouched). Matches the backend cc rule (targetType ∈ {user,role}, non-empty targetIds).
function ccEditFor(nodeKey: string): CcNodeEdit | undefined {
  return draft.value.ccEdits?.[nodeKey]
}
function ccTargetTypeLabel(targetType: ApprovalAssigneeType): string {
  return targetType === 'role' ? '角色' : '用户'
}

// ── G-5 approval-node editor (approver SOURCE only; the node's mode/policy + edges are preserved) ──
// Edits the FIRST assignee source of an approval node in a preserved complex graph; the edit model
// (`draft.approvalNodeEdits[nodeKey].assigneeSources`) is seeded 1:1 + carried through
// `applyApprovalNodeEditsToGraph` (every other node + all edges byte-identical). Any extra sources
// (index 1+) are preserved verbatim. approvalMode / emptyAssigneePolicy / autoApprovalPolicy are
// NOT editable here (a later slice) — they ride through untouched. Legacy nodes (no `assigneeSources`)
// aren't seeded, so they fall to the read-only summary below.
const APPROVAL_NODE_SOURCE_KINDS: { value: ApprovalAssigneeSourceKind; label: string }[] = [
  { value: 'static_user', label: '指定用户' },
  { value: 'static_role', label: '指定角色' },
  { value: 'requester', label: '发起人' },
  { value: 'direct_manager', label: '直属上级' },
  { value: 'dept_head', label: '部门主管' },
  { value: 'continuous_managers', label: '连续多级上级' },
  { value: 'manager_at_level', label: '指定层级上级' },
  { value: 'form_field_user', label: '表单用户字段' },
]
function approvalNodeEditFor(nodeKey: string): ApprovalNodeSourceEdit | undefined {
  return draft.value.approvalNodeEdits?.[nodeKey]
}
function approvalNodeFirstSource(nodeKey: string): ApprovalAssigneeSource | undefined {
  return approvalNodeEditFor(nodeKey)?.assigneeSources[0]
}
// Replace ONLY the primary (first) source; preserve any extra sources verbatim (no flatten).
function setApprovalNodeSource(nodeKey: string, source: ApprovalAssigneeSource): void {
  const edit = approvalNodeEditFor(nodeKey)
  if (!edit) return
  edit.assigneeSources = [source, ...edit.assigneeSources.slice(1)]
}
function approvalSourceKind(nodeKey: string): ApprovalAssigneeSourceKind {
  return approvalNodeFirstSource(nodeKey)?.kind ?? 'requester'
}
function setApprovalSourceKind(nodeKey: string, kind: ApprovalAssigneeSourceKind): void {
  const next: ApprovalAssigneeSource =
    kind === 'static_user' ? { kind, userIds: [] }
      : kind === 'static_role' ? { kind, roleIds: [] }
        : kind === 'form_field_user' ? { kind, fieldId: '' }
          : kind === 'continuous_managers' ? { kind, levels: 1 }
            : kind === 'manager_at_level' ? { kind, level: 1 }
              : { kind }
  setApprovalNodeSource(nodeKey, next)
}
function approvalSourceIds(nodeKey: string): string[] {
  const source = approvalNodeFirstSource(nodeKey)
  if (source?.kind === 'static_user') return source.userIds
  if (source?.kind === 'static_role') return source.roleIds
  return []
}
// G-5 sentinel hint: true when the source is a static_role still carrying the starter-preset
// placeholder (APPROVAL_ROLE_CONFIGURE_SENTINEL). The backend blocks publish on it; this surfaces it
// in the editor so the admin replaces it first. Non-blocking — the draft still saves.
function approvalSourceIsPlaceholder(nodeKey: string): boolean {
  return approvalSourceKind(nodeKey) === 'static_role'
    && approvalSourceIds(nodeKey).includes(APPROVAL_ROLE_CONFIGURE_SENTINEL)
}

// ── D-2/D-3 topology authoring (structural graph edits via graphTopologyEdit + applyTopologyToComplexDraft) ──
// Each op runs on the EFFECTIVE graph (configs applied) and re-seeds the draft, so the structured
// editors stay in sync. Guards mirror the engine preconditions so a shown button never throws; a
// (defensive) throw surfaces as loadError. The interactive free-drag canvas is the gated next slice.
function runTopologyOp(op: (graph: ApprovalGraph) => ApprovalGraph): void {
  try {
    draft.value = applyTopologyToComplexDraft(draft.value, op)
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '拓扑修改失败'
  }
}
function onAddConditionBranch(nodeKey: string): void {
  runTopologyOp((graph) => addConditionBranch(graph, nodeKey))
}
function onAddParallelBranch(nodeKey: string): void {
  runTopologyOp((graph) => addParallelBranch(graph, nodeKey))
}
function onInsertApprovalAfter(nodeKey: string): void {
  runTopologyOp((graph) => appendApprovalNode(graph, nodeKey))
}
function onRemoveNode(nodeKey: string): void {
  runTopologyOp((graph) => removeLinearNode(graph, nodeKey))
}
function topologyEdgeCount(nodeKey: string, dir: 'source' | 'target'): number {
  return (draft.value.preservedGraph?.edges ?? []).filter((edge) => edge[dir] === nodeKey).length
}
function canInsertAfter(node: ApprovalNode): boolean {
  return node.type !== 'end' && topologyEdgeCount(node.key, 'source') === 1
}
function canRemoveNode(node: ApprovalNode): boolean {
  return (node.type === 'approval' || node.type === 'cc')
    && topologyEdgeCount(node.key, 'target') === 1
    && topologyEdgeCount(node.key, 'source') === 1
}

// ── D-1/D-5/D-6 visual canvas (bespoke SVG/HTML — the render is DATA, so it's unit-testable; only the
// raw mouse-drag GESTURE is manual/E2E QA). Auto-layout via computeLayout, overridable by a position
// SIDECAR (`nodePositions`) that NEVER reaches the saved graph. Reuses the same topology handlers as
// the list; config editing stays in the list view (toggle = D-6 parity). ──
const canvasViewMode = ref<'list' | 'canvas'>('list')
const selectedCanvasNode = ref<string | null>(null)
const nodePositions = ref<Record<string, { x: number; y: number }>>({})
const draggingCanvasNode = ref<string | null>(null)
const CANVAS_NODE_W = 150
const CANVAS_NODE_H = 56
const canvasEffectiveGraph = computed<ApprovalGraph>(() => buildApprovalGraph(draft.value))
const canvasLayout = computed<GraphLayout>(() => {
  const layout = computeLayout(canvasEffectiveGraph.value)
  return {
    ...layout,
    nodes: layout.nodes.map((n) => {
      const override = nodePositions.value[n.key]
      return override ? { ...n, x: override.x, y: override.y } : n
    }),
  }
})
const canvasValidity = computed<string[]>(() => (draft.value.preservedGraph ? graphValidityIssues(canvasEffectiveGraph.value) : []))
function canvasNodeByKey(key: string): ApprovalNode | undefined {
  return canvasEffectiveGraph.value.nodes.find((n) => n.key === key)
}
const canvasEdgeLines = computed(() => {
  const pos = new Map(canvasLayout.value.nodes.map((n) => [n.key, n]))
  return canvasEffectiveGraph.value.edges.map((edge) => {
    const s = pos.get(edge.source)
    const t = pos.get(edge.target)
    return {
      key: edge.key,
      x1: (s?.x ?? 0) + CANVAS_NODE_W,
      y1: (s?.y ?? 0) + CANVAS_NODE_H / 2,
      x2: t?.x ?? 0,
      y2: (t?.y ?? 0) + CANVAS_NODE_H / 2,
    }
  })
})
function onCanvasNodeDragStart(key: string): void {
  if (!readOnly.value) draggingCanvasNode.value = key
}
function onCanvasNodeDragEnd(event: DragEvent): void {
  // The drag GESTURE is manual/E2E QA; this position-update (sidecar only, never saved) is exercised.
  if (readOnly.value || !draggingCanvasNode.value) return
  const surface = (event.currentTarget as HTMLElement | null)?.closest('[data-testid="approval-graph-canvas"]')
  const rect = surface?.getBoundingClientRect()
  if (rect) {
    nodePositions.value = {
      ...nodePositions.value,
      [draggingCanvasNode.value]: {
        x: Math.max(0, Math.round(event.clientX - rect.left - CANVAS_NODE_W / 2)),
        y: Math.max(0, Math.round(event.clientY - rect.top - CANVAS_NODE_H / 2)),
      },
    }
  }
  draggingCanvasNode.value = null
}
function setApprovalSourceIds(nodeKey: string, ids: string[]): void {
  const kind = approvalSourceKind(nodeKey)
  if (kind === 'static_user') setApprovalNodeSource(nodeKey, { kind, userIds: ids })
  else if (kind === 'static_role') setApprovalNodeSource(nodeKey, { kind, roleIds: ids })
}
function approvalSourceFieldId(nodeKey: string): string {
  const source = approvalNodeFirstSource(nodeKey)
  return source?.kind === 'form_field_user' ? source.fieldId : ''
}
function setApprovalSourceFieldId(nodeKey: string, fieldId: string): void {
  setApprovalNodeSource(nodeKey, { kind: 'form_field_user', fieldId })
}
function approvalSourceLevel(nodeKey: string): number {
  const source = approvalNodeFirstSource(nodeKey)
  if (source?.kind === 'manager_at_level') return source.level
  if (source?.kind === 'continuous_managers') return source.levels
  return 1
}
function setApprovalSourceLevel(nodeKey: string, value: number): void {
  const kind = approvalSourceKind(nodeKey)
  if (kind === 'manager_at_level') setApprovalNodeSource(nodeKey, { kind, level: value })
  else if (kind === 'continuous_managers') setApprovalNodeSource(nodeKey, { kind, levels: value })
}

const userFields = computed(() => draft.value.fields.filter((field) => field.type === 'user' && field.id.trim()))
const formSchemaPreview = computed(() => JSON.stringify(buildFormSchema(draft.value), null, 2))
const approvalGraphPreview = computed(() => JSON.stringify(buildApprovalGraph(draft.value), null, 2))

// Directory typeahead for static_user / static_role assignee sources. The picker is purely
// additive: it reads/writes the SAME step.idsText carrier (parseIdsText in, ', ' join out, the
// exact separator formatIds uses), so sourceFromStep / buildApprovalGraph consume it unchanged.
const directory = useApprovalDirectory()

function stepIds(step: ApprovalStepDraft): string[] {
  return parseIdsText(step.idsText)
}

function setStepIds(step: ApprovalStepDraft, ids: string[]): void {
  step.idsText = ids.join(', ')
}

async function onUserSearch(query: string): Promise<void> {
  await directory.searchUsers(query)
  // Keep already-selected ids visible as chips even if the new search page omits them.
  for (const step of draft.value.steps) {
    if (step.sourceKind !== 'static_user') continue
    for (const id of parseIdsText(step.idsText)) directory.ensureUserOptionVisible(id)
  }
}

// On sourceKind change (and on hydrate) make every already-selected id render as a chip,
// even pre-existing / unknown ids absent from the fetched directory page — no silent drop.
function syncStepOptions(step: ApprovalStepDraft): void {
  if (step.sourceKind === 'static_user') {
    for (const id of parseIdsText(step.idsText)) directory.ensureUserOptionVisible(id)
  } else if (step.sourceKind === 'static_role') {
    for (const id of parseIdsText(step.idsText)) directory.ensureRoleOptionVisible(id)
  }
}

function syncAllStepOptions(): void {
  for (const step of draft.value.steps) syncStepOptions(step)
}

function clearErrors() {
  loadError.value = null
  validationErrors.value = []
}

function goBack() {
  router.push({ path: '/approval-templates' })
}

function swap<T>(items: T[], index: number, delta: -1 | 1) {
  const target = index + delta
  if (target < 0 || target >= items.length) return
  const copy = [...items]
  const current = copy[index]
  copy[index] = copy[target]
  copy[target] = current
  return copy
}

function addField() {
  draft.value.fields = [...draft.value.fields, createEmptyFieldDraft(draft.value.fields.length + 1)]
}

function removeField(index: number) {
  if (draft.value.fields.length === 1) return
  draft.value.fields = draft.value.fields.filter((_, i) => i !== index)
}

function moveField(index: number, delta: -1 | 1) {
  draft.value.fields = swap(draft.value.fields, index, delta) ?? draft.value.fields
}
// D-4 drag-reorder: native HTML5 drag wires to the pure `moveItemToIndex` logic. (The drag GESTURE is
// manual/E2E QA — jsdom DragEvent is unreliable; the reorder LOGIC is unit-covered in templateAuthoring.)
const draggedFieldIndex = ref<number | null>(null)
function onFieldDragStart(index: number) {
  if (!readOnly.value) draggedFieldIndex.value = index
}
function onFieldDrop(index: number) {
  if (readOnly.value || draggedFieldIndex.value === null) return
  draft.value.fields = moveItemToIndex(draft.value.fields, draggedFieldIndex.value, index)
  draggedFieldIndex.value = null
}

// detail / sub-form (明细) sub-field authoring. Sub-fields are LEAF types only (no nested
// `detail`), surfaced from the shared `DETAIL_LEAF_FIELD_TYPES` so the picker can never offer
// `detail` — the one-nesting-level invariant the backend also enforces.
const DETAIL_LEAF_TYPE_LABELS: Record<string, string> = {
  text: '文本',
  textarea: '多行文本',
  number: '数字',
  date: '日期',
  datetime: '日期时间',
  select: '单选',
  'multi-select': '多选',
  user: '用户',
}
const detailLeafTypeOptions = computed(() =>
  DETAIL_LEAF_FIELD_TYPES.map((type) => ({ value: type, label: DETAIL_LEAF_TYPE_LABELS[type] ?? type })),
)

function addDetailColumn(field: FieldAuthoringDraft) {
  field.detailColumns = [...field.detailColumns, createEmptyDetailColumnDraft(field.detailColumns.length + 1)]
}

function removeDetailColumn(field: FieldAuthoringDraft, index: number) {
  field.detailColumns = field.detailColumns.filter((_, i) => i !== index)
}

// Visibility-rule depends-on options: other fields that have an id (excludes self).
function visibilityFieldOptions(current: FieldAuthoringDraft) {
  return draft.value.fields
    .filter((field) => field.localId !== current.localId && field.id.trim().length > 0)
    .map((field) => ({ localId: field.localId, id: field.id.trim(), label: field.label.trim() || field.id.trim() }))
}

function addStep() {
  draft.value.steps = [...draft.value.steps, createEmptyStepDraft(draft.value.steps.length + 1)]
}

function removeStep(index: number) {
  if (draft.value.steps.length === 1) return
  draft.value.steps = draft.value.steps.filter((_, i) => i !== index)
}

function moveStep(index: number, delta: -1 | 1) {
  draft.value.steps = swap(draft.value.steps, index, delta) ?? draft.value.steps
}

async function loadTemplateForEdit() {
  if (!isEditMode.value) {
    draft.value = createEmptyTemplateDraft()
    unsupportedReason.value = null
    graphReadOnlyMessage.value = null
    return
  }
  loading.value = true
  loadError.value = null
  try {
    const template = await getTemplate(templateId.value)
    unsupportedReason.value = unsupportedTemplateAuthoringReason(template)
    graphReadOnlyMessage.value = graphReadOnlyReason(template)
    draft.value = draftFromTemplate(template)
    syncAllStepOptions()
  } catch (error: any) {
    loadError.value = error?.message ?? '加载审批模板失败'
  } finally {
    loading.value = false
  }
}

function validate(): boolean {
  validationErrors.value = validateTemplateDraft(draft.value, unsupportedReason.value)
  if (validationErrors.value.length > 0) {
    ElMessage.warning('请先修正模板配置')
    return false
  }
  return true
}

async function persistDraft() {
  if (!validate()) return null
  saving.value = true
  try {
    if (draft.value.templateId) {
      const updated = await updateTemplate(draft.value.templateId, buildUpdateTemplatePayload(draft.value))
      draft.value = draftFromTemplate(updated)
      unsupportedReason.value = unsupportedTemplateAuthoringReason(updated)
      graphReadOnlyMessage.value = graphReadOnlyReason(updated)
      return updated
    }
    const created = await createTemplate(buildCreateTemplatePayload(draft.value))
    draft.value = draftFromTemplate(created)
    unsupportedReason.value = unsupportedTemplateAuthoringReason(created)
    graphReadOnlyMessage.value = graphReadOnlyReason(created)
    await router.replace({ path: `/approval-templates/${created.id}/edit` })
    return created
  } catch (error: any) {
    loadError.value = error?.message ?? '保存模板失败'
    return null
  } finally {
    saving.value = false
  }
}

async function createFromPreset(presetId: CommonApprovalTemplatePresetId) {
  if (!canManageTemplates.value || creatingPresetId.value) return
  creatingPresetId.value = presetId
  loadError.value = null
  try {
    const created = await createTemplate(buildCommonApprovalTemplatePresetPayload(presetId))
    draft.value = draftFromTemplate(created)
    unsupportedReason.value = unsupportedTemplateAuthoringReason(created)
    graphReadOnlyMessage.value = graphReadOnlyReason(created)
    syncAllStepOptions()
    await router.replace({ path: `/approval-templates/${created.id}/edit` })
    ElMessage.success('模板草稿已创建')
  } catch (error: any) {
    loadError.value = error?.message ?? '创建常用模板失败'
  } finally {
    creatingPresetId.value = null
  }
}

async function handleSave() {
  if (!canSave.value || saving.value) return
  const saved = await persistDraft()
  if (saved) {
    ElMessage.success('草稿已保存')
  }
}

async function handlePublish() {
  if (!canSave.value || publishing.value) return
  try {
    await ElMessageBox.confirm('发布后用户即可从模板中心发起审批，确认发布吗？', '发布审批模板', {
      confirmButtonText: '发布',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  publishing.value = true
  try {
    const saved = await persistDraft()
    if (!saved) return
    await publishTemplate(saved.id, { policy: { allowRevoke: draft.value.allowRevoke } })
    ElMessage.success('模板已发布')
    await router.push({ path: `/approval-templates/${saved.id}` })
  } catch (error: any) {
    loadError.value = error?.message ?? '发布模板失败'
  } finally {
    publishing.value = false
  }
}

onMounted(() => {
  if (!canManageTemplates.value) return
  void directory.loadRoles()
  void directory.loadFormulaRoles()
  void loadTemplateForEdit()
})
</script>

<style scoped>
.template-authoring {
  max-width: 1120px;
  margin: 0 auto;
  padding: 24px;
}

.template-authoring__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

.template-authoring__header h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
}

.template-authoring__header p {
  margin: 4px 0 0;
  color: var(--el-text-color-secondary, #606266);
}

.template-authoring__actions,
.template-authoring__inline,
.template-authoring__panel-header,
.template-authoring__item-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.template-authoring__actions {
  justify-content: flex-end;
}

.template-authoring__alert {
  margin-bottom: 16px;
}

.template-authoring__body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.template-authoring__panel {
  border-radius: 8px;
}

.template-authoring__panel-header,
.template-authoring__item-toolbar {
  justify-content: space-between;
}

.template-authoring__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 16px;
}

.template-authoring__wide {
  grid-column: 1 / -1;
}

.template-authoring__preset-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.template-authoring__preset {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 12px;
  min-height: 148px;
  padding: 14px;
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  border-radius: 8px;
}

.template-authoring__preset p {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--el-text-color-secondary, #606266);
}

.template-authoring__visibility {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: flex-start;
}

.template-authoring__hint {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary, #909399);
}

.template-authoring__inline > .el-input {
  flex: 1;
}

.template-authoring__detail {
  width: 100%;
}

.template-authoring__detail-table {
  width: 100%;
}

.template-authoring__detail-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}

.template-authoring__item {
  padding: 14px;
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  border-radius: 8px;
}

.template-authoring__item + .template-authoring__item {
  margin-top: 12px;
}

.template-authoring__item-toolbar {
  margin-bottom: 12px;
}

.template-authoring__node-type {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--el-fill-color-light, #f5f7fa);
  color: var(--el-text-color-secondary, #606266);
}

.template-authoring__node-summary {
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--el-text-color-regular, #606266);
}

/* G-2 condition editor */
.template-authoring__condition {
  margin-top: 8px;
}

.template-authoring__condition-branch {
  border: 1px dashed var(--el-border-color, #dcdfe6);
  border-radius: 6px;
  padding: 10px 12px;
  margin-bottom: 10px;
}

.template-authoring__condition-branch-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 13px;
  color: var(--el-text-color-regular, #606266);
}

.template-authoring__condition-rule {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.template-authoring__condition-formula {
  display: grid;
  gap: 8px;
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
  color: var(--el-text-color-regular, #606266);
}

.template-authoring__condition-default {
  margin: 4px 0 0;
}

.template-authoring__error-list {
  margin: 6px 0 0;
  padding-left: 20px;
}

pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
}

@media (max-width: 760px) {
  .template-authoring__header {
    align-items: flex-start;
    flex-direction: column;
  }

  .template-authoring__grid {
    grid-template-columns: 1fr;
  }

  .template-authoring__preset-grid {
    grid-template-columns: 1fr;
  }
}

.template-authoring__view-toggle {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.template-authoring__canvas {
  position: relative;
  overflow: auto;
  border: 1px solid var(--el-border-color, #dcdfe6);
  border-radius: 6px;
  background: #fafafa;
  min-height: 200px;
}
.template-authoring__canvas-node {
  box-sizing: border-box;
  padding: 6px 10px;
  border: 1px solid var(--el-border-color, #dcdfe6);
  border-radius: 6px;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  display: flex;
  flex-direction: column;
  gap: 2px;
  cursor: grab;
  font-size: 12px;
}
.template-authoring__canvas-node.is-selected {
  border-color: var(--el-color-primary, #409eff);
  box-shadow: 0 0 0 2px var(--el-color-primary-light-5, #a0cfff);
}
.template-authoring__canvas-node-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
</style>
