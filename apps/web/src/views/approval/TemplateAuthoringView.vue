<template>
  <PageShell width="wide">
    <PageHeader
      class="template-authoring__header"
      :title="isEditMode ? '编辑审批模板' : '新建审批模板'"
      subtitle="分步完成基础信息、表单、流程与发布校验"
      back
      back-label="返回模板列表"
      @back="goBack"
    >
      <template #meta>
        <span
          class="template-authoring__save-state"
          :class="{ 'template-authoring__save-state--dirty': isDraftDirty }"
        >
          {{ draftStateLabel }}
        </span>
        <span class="template-authoring__meta-count">{{ draft.fields.length }} 个表单字段</span>
        <span class="template-authoring__meta-count">{{ authoringFlowNodeCount }} 个流程节点</span>
      </template>
      <template #actions>
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
            @click="openPublishChecklist"
          >
            发布
          </el-button>
        </div>
      </template>
    </PageHeader>

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

    <!-- Complex graphs remain editable. Unknown node config still fails closed above. -->
    <el-alert
      v-if="!unsupportedReason && graphReadOnlyMessage"
      :title="graphReadOnlyMessage"
      description="画布用于编排节点与分支；结构列表用于编辑审批人、条件、并行汇聚、抄送和字段权限。"
      type="info"
      show-icon
      :closable="false"
      class="template-authoring__alert"
      data-testid="approval-template-graph-readonly-alert"
    />

    <div
      v-if="loadError || validationErrors.length"
      ref="validationSummaryRef"
      class="template-authoring__validation-summary"
      data-testid="approval-template-validation-summary"
      tabindex="-1"
    >
      <el-alert
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
    </div>

    <div v-loading="loading" class="template-authoring__body">
      <div class="template-authoring__workspace">
        <nav class="template-authoring__steps" aria-label="模板配置步骤">
          <div class="template-authoring__steps-heading">
            <strong>模板配置</strong>
            <span>按步骤完成，随时可保存草稿</span>
          </div>
          <el-button
            v-for="(section, index) in authoringSections"
            :key="section.id"
            class="template-authoring__step"
            :class="{ 'is-active': activeAuthoringSection === section.id }"
            text
            :aria-current="activeAuthoringSection === section.id ? 'step' : undefined"
            :data-testid="`approval-template-section-${section.id}`"
            @click="selectAuthoringSection(section.id)"
          >
            <span class="template-authoring__step-index">{{ index + 1 }}</span>
            <span class="template-authoring__step-copy">
              <strong>{{ section.label }}</strong>
              <small>{{ section.description }}</small>
            </span>
            <span
              v-if="section.id === 'fields'"
              class="template-authoring__step-count"
            >{{ draft.fields.length }}</span>
            <span
              v-else-if="section.id === 'flow'"
              class="template-authoring__step-count"
            >{{ authoringFlowNodeCount }}</span>
          </el-button>
        </nav>

        <main
          ref="authoringContentRef"
          class="template-authoring__content"
          data-testid="approval-template-workspace-content"
        >
      <el-card
        v-if="showPresetLibrary"
        v-show="activeAuthoringSection === 'basic'"
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

      <el-card v-show="activeAuthoringSection === 'basic'" class="template-authoring__panel" shadow="never">
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
              <el-select v-model="draft.visibilityType" :disabled="readOnly" class="ms-w-140">
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

      <el-card v-show="activeAuthoringSection === 'fields'" class="template-authoring__panel" shadow="never">
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
              <el-select v-model="field.type" :disabled="readOnly" class="ms-w-100pct">
                <el-option label="文本" value="text" />
                <el-option label="多行文本" value="textarea" />
                <el-option label="数字" value="number" />
                <el-option label="日期" value="date" />
                <el-option label="日期时间" value="datetime" />
                <el-option label="单选" value="select" />
                <el-option label="多选" value="multi-select" />
                <el-option label="用户" value="user" />
                <el-option label="明细（子表单）" value="detail" />
                <el-option label="关联记录 (record-link)" value="record-link" />
              </el-select>
            </el-form-item>
            <el-form-item label="占位文本">
              <el-input v-model="field.placeholder" :disabled="readOnly" />
            </el-form-item>
            <el-form-item label="是否必填">
              <el-checkbox v-model="field.required" :disabled="readOnly">必填</el-checkbox>
            </el-form-item>
            <el-form-item
              v-if="field.type === 'record-link'"
              label="关联表（服务端钉死）"
              class="template-authoring__wide"
              data-testid="approval-record-link-config"
            >
              <div class="template-authoring__grid">
                <el-form-item label="baseId">
                  <el-input
                    v-model="field.recordLinkBaseId"
                    :disabled="readOnly"
                    placeholder="目标 base id"
                    data-testid="approval-record-link-base-id"
                  />
                </el-form-item>
                <el-form-item label="sheetId">
                  <el-input
                    v-model="field.recordLinkSheetId"
                    :disabled="readOnly"
                    placeholder="目标 sheet id"
                    data-testid="approval-record-link-sheet-id"
                  />
                </el-form-item>
              </div>
              <div class="template-authoring__hint">
                提交时只允许选择该 sheet 内单条记录；服务端会按 filler 读权限 fail-closed 校验，不暴露存在性。
              </div>
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
                      <el-select v-model="row.type" :disabled="readOnly" class="ms-w-100pct">
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
                    class="ms-w-120"
                  />
                  <el-input
                    v-model="field.maxRowsText"
                    :disabled="readOnly"
                    placeholder="最大行数"
                    class="ms-w-120"
                  />
                </div>
              </div>
            </el-form-item>
            <el-form-item label="显隐规则" class="template-authoring__wide">
              <div class="template-authoring__visibility">
                <el-select
                  v-model="field.visibility.dependsOnFieldId"
                  :disabled="readOnly"
                  class="ms-w-200"
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
                    class="ms-w-130"
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
                    class="ms-w-240"
                    data-testid="approval-field-visibility-values"
                  />
                  <el-input
                    v-else-if="field.visibility.operator === 'eq' || field.visibility.operator === 'neq'"
                    v-model="field.visibility.valueText"
                    :disabled="readOnly"
                    placeholder="比较值"
                    class="ms-w-240"
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

      <el-card v-show="activeAuthoringSection === 'flow'" class="template-authoring__panel" shadow="never">
        <template #header>
          <div class="template-authoring__panel-header">
            <strong>审批流程</strong>
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

        <!-- Complex graphs use a canvas for topology and a structured list for node configuration. -->
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
          <div class="template-authoring__canvas-viewport">
            <div
              class="template-authoring__canvas"
              data-testid="approval-graph-canvas"
              :style="{ position: 'relative', height: canvasLayout.height + 'px', width: canvasLayout.width + 'px' }"
            >
              <svg class="template-authoring__canvas-edges" :width="canvasLayout.width" :height="canvasLayout.height">
                <defs>
                  <marker id="approval-canvas-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                    <path d="M0,0 L7,3 L0,6 Z" fill="#bbb" />
                  </marker>
                </defs>
                <path
                  v-for="line in canvasEdgeLines"
                  :key="line.key"
                  :d="line.path"
                  stroke="#bbb"
                  stroke-width="1.5"
                  fill="none"
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
                  <template v-if="canInsertAfter(canvasNodeByKey(pos.key)!)">
                    <el-button size="small" :data-testid="`approval-canvas-insert-${pos.key}`" @click.stop="onInsertApprovalAfter(pos.key)">+审批</el-button>
                    <el-button size="small" :data-testid="`approval-canvas-insert-condition-${pos.key}`" @click.stop="onInsertConditionAfter(pos.key)">+条件</el-button>
                    <!-- F4: no +并行 inside a parallel branch — the backend rejects nested parallel. -->
                    <el-button v-if="canInsertParallelAfter(canvasNodeByKey(pos.key)!)" size="small" :data-testid="`approval-canvas-insert-parallel-${pos.key}`" @click.stop="onInsertParallelAfter(pos.key)">+并行</el-button>
                  </template>
                  <el-button v-if="canRemoveNode(canvasNodeByKey(pos.key)!)" size="small" type="danger" :data-testid="`approval-canvas-remove-${pos.key}`" @click.stop="onRemoveNode(pos.key)">删除</el-button>
                </div>
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
                  v-if="canInsertAfter(node)"
                  size="small"
                  :data-testid="`approval-topology-insert-condition-after-${node.key}`"
                  @click="onInsertConditionAfter(node.key)"
                >下方添加条件</el-button>
                <!-- F4: no 并行 insert inside a parallel branch — the backend rejects nested parallel. -->
                <el-button
                  v-if="canInsertParallelAfter(node)"
                  size="small"
                  :data-testid="`approval-topology-insert-parallel-after-${node.key}`"
                  @click="onInsertParallelAfter(node.key)"
                >下方添加并行</el-button>
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
                  <span>分支「{{ liveBranchSummary(branch) }}」→ {{ branch.edgeKey }}</span>
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
                  class="ms-w-220"
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
                  class="ms-w-240"
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
                  class="ms-w-360"
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
              <!-- G-B2-18: same directory typeahead as the linear-step picker (line ~973) — the
                   composable is shared (one users/roles fetch backs both surfaces), only the
                   template wiring is duplicated per editor. The manual-ID input stays as the
                   advanced fallback (directory search doesn't guarantee full id coverage). -->
              <template v-if="approvalSourceKind(node.key) === 'static_user' || approvalSourceKind(node.key) === 'static_role'">
                <el-form-item v-if="approvalSourceKind(node.key) === 'static_user'" label="选择用户">
                  <el-select
                    :model-value="approvalSourceIds(node.key)"
                    multiple
                    filterable
                    remote
                    :remote-method="onUserSearch"
                    :loading="directory.usersLoading.value"
                    size="small"
                    :disabled="readOnly"
                    class="ms-w-360"
                    placeholder="搜索用户名 / 邮箱 / ID"
                    data-testid="approval-node-source-user-picker"
                    @update:model-value="(ids: string[]) => setApprovalSourceIdsFromPicker(node.key, ids)"
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
                      v-for="role in directory.roles.value"
                      :key="role.id"
                      :label="directory.formatRoleLabel(role)"
                      :value="role.id"
                    />
                  </el-select>
                </el-form-item>
                <el-form-item label="手动输入 ID（高级）">
                  <el-input
                    :model-value="approvalSourceIdsText(node.key)"
                    :disabled="readOnly"
                    placeholder="逗号或换行分隔"
                    data-testid="approval-node-source-ids-text"
                    @update:model-value="(text: string) => setApprovalSourceIdsText(node.key, text)"
                  />
                </el-form-item>
              </template>
              <el-form-item
                v-else-if="approvalSourceKind(node.key) === 'form_field_user'"
                label="表单用户字段 ID"
              >
                <el-input
                  :model-value="approvalSourceFieldId(node.key)"
                  size="small"
                  :disabled="readOnly"
                  class="ms-w-240"
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
                  <span class="template-authoring__field-perm-label">{{ field.label || field.id }}（{{ field.id }}）</span>
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
        </div>

        <!-- G-B2-06 read-only flow spine (LINEAR templates only — a preserved complex graph keeps
             its own structured/canvas views above, untouched): 发起人 → 步骤1 → 步骤2 → …, derived
             straight from draft.steps (see linearStepSpine.ts). Not editable here; clicking a step
             chip scrolls to and briefly highlights the matching card below. -->
        <div
          v-if="!graphReadOnly"
          class="template-authoring__spine"
          data-testid="approval-template-step-spine"
        >
          <template v-for="(chip, chipIndex) in linearStepSpine" :key="chip.key">
            <button
              type="button"
              class="template-authoring__spine-chip"
              :class="{
                'template-authoring__spine-chip--requester': chip.role === 'requester',
                'template-authoring__spine-chip--unresolved': !chip.resolvable,
              }"
              :data-testid="chip.role === 'requester' ? 'approval-spine-chip-requester' : 'approval-spine-chip-step'"
              :data-step-index="chip.stepIndex ?? undefined"
              :title="chip.stepIndex ? `第 ${chip.stepIndex} 步 · 点击定位到对应步骤卡` : '发起人：提交表单'"
              @click="focusStepCard(chip)"
            >
              <strong>{{ chip.label }}</strong>
              <span v-if="chip.sourceSummary" class="template-authoring__spine-chip-source">{{ chip.sourceSummary }}</span>
            </button>
            <span
              v-if="chipIndex < linearStepSpine.length - 1"
              class="template-authoring__spine-arrow"
              aria-hidden="true"
            >→</span>
          </template>
        </div>

        <div
          v-for="(step, index) in draft.steps"
          v-show="!graphReadOnly"
          :id="`approval-step-card-${step.localId}`"
          :key="step.localId"
          class="template-authoring__item"
          :class="{ 'template-authoring__item--highlighted': highlightedStepLocalId === step.localId }"
          data-testid="approval-template-step-row"
        >
          <div class="template-authoring__item-toolbar">
            <strong>审批步骤 {{ index + 1 }}</strong>
            <div>
              <el-button size="small" :disabled="readOnly || index === 0" @click="moveStep(index, -1)">上移</el-button>
              <el-button size="small" :disabled="readOnly || index === draft.steps.length - 1" @click="moveStep(index, 1)">下移</el-button>
              <el-button
                size="small"
                :disabled="readOnly"
                :data-testid="`approval-step-insert-after-${step.localId}`"
                @click="insertStep(index)"
              >
                在下方插入步骤
              </el-button>
              <el-button
                size="small"
                :disabled="readOnly"
                :data-testid="`approval-step-insert-condition-after-${step.localId}`"
                @click="insertConditionAfterStep(index)"
              >下方添加条件分支</el-button>
              <el-button
                size="small"
                :disabled="readOnly"
                :data-testid="`approval-step-insert-parallel-after-${step.localId}`"
                @click="insertParallelAfterStep(index)"
              >下方添加并行分支</el-button>
              <el-button size="small" type="danger" :disabled="readOnly || draft.steps.length === 1" @click="removeStep(index)">删除</el-button>
            </div>
          </div>
          <div class="template-authoring__grid">
            <el-form-item label="步骤名称">
              <el-input v-model="step.name" :disabled="readOnly" />
            </el-form-item>
            <el-form-item label="审批人来源">
              <el-select v-model="step.sourceKind" :disabled="readOnly" class="ms-w-100pct" data-testid="approval-step-source-kind" @change="syncStepOptions(step)">
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
                class="ms-w-100pct"
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
                class="ms-w-100pct"
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
              <el-select v-model="step.fieldId" :disabled="readOnly" class="ms-w-100pct">
                <el-option
                  v-for="field in userFields"
                  :key="field.id"
                  :label="`${field.label} (${field.id})`"
                  :value="field.id"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="核定字段 (FWB-3)" data-testid="approval-step-decision-fields">
              <el-select
                v-model="step.decisionFieldIds"
                :disabled="readOnly"
                multiple
                filterable
                clearable
                class="ms-w-100pct"
                placeholder="选择审批人必须填写的核定字段"
                data-testid="approval-step-decision-field-ids"
              >
                <el-option
                  v-for="opt in decisionFieldOptions"
                  :key="opt.id"
                  :label="opt.label"
                  :value="opt.id"
                />
              </el-select>
              <div class="template-authoring__hint">
                选中字段将在该节点「同意」时由审批人提交 decisionData；服务端在 FOR UPDATE 事务内冻结，缺项/多项/空值均拒绝。
              </div>
            </el-form-item>
            <el-form-item label="审批模式">
              <el-select v-model="step.approvalMode" :disabled="readOnly" class="ms-w-100pct">
                <el-option label="单人通过" value="single" />
                <el-option label="全部通过" value="all" />
                <el-option label="任一通过" value="any" />
              </el-select>
            </el-form-item>
            <el-form-item label="空审批人策略">
              <el-select v-model="step.emptyAssigneePolicy" :disabled="readOnly" class="ms-w-100pct">
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
          <!-- T1-4 node field permissions: per-form-field access at this approval node. `隐藏` is
               enforced at runtime (server echo-redaction); `只读` round-trips but is not yet enforced
               (T1-4b). A field left `可编辑` carries no persisted entry (absent === editable). -->
          <div class="template-authoring__field-perms" data-testid="approval-step-field-permissions">
            <div class="template-authoring__field-perms-head">
              <strong>字段权限</strong>
              <span class="template-authoring__hint">
                「隐藏」在审批到该节点时对所有查看者隐藏该字段（仅回显隐藏，不影响审批人解析与条件路由）；「只读」将在后续版本生效。字段默认为「可编辑」。
              </span>
            </div>
            <div v-if="fieldPermissionFields.length === 0" class="template-authoring__hint">
              请先在上方添加表单字段，即可为本步骤设置字段权限。
            </div>
            <div
              v-for="field in fieldPermissionFields"
              :key="field.id"
              class="template-authoring__field-perm-row"
              data-testid="approval-step-field-permission-row"
            >
              <span class="template-authoring__field-perm-label">{{ field.label || field.id }}（{{ field.id }}）</span>
              <el-select
                :model-value="stepFieldAccess(step, field.id)"
                :disabled="readOnly"
                size="small"
                class="ms-w-130"
                :data-testid="`approval-step-field-access-${field.id}`"
                @update:model-value="(access: NodeFieldAccess) => onStepFieldAccessChange(step, field.id, access)"
              >
                <el-option label="可编辑" value="editable" />
                <el-option label="只读" value="readonly" />
                <el-option label="隐藏" value="hidden" />
              </el-select>
              <span
                v-if="stepFieldAccess(step, field.id) === 'readonly'"
                class="template-authoring__hint"
                data-testid="approval-step-field-readonly-hint"
              >只读将在后续版本（T1-4b）生效，当前保存但暂不强制</span>
              <span
                v-else-if="stepFieldAccess(step, field.id) === 'hidden' && routingDriverFieldIds.has(field.id)"
                class="template-authoring__hint template-authoring__hint--warn"
                data-testid="approval-step-field-routing-hint"
              >该字段被审批人来源引用；隐藏仅影响回显，不影响审批人解析</span>
            </div>
          </div>
        </div>
      </el-card>

      <el-card v-show="activeAuthoringSection === 'review'" class="template-authoring__panel" shadow="never">
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

      <!-- RP-3 (route-preview lock, B3-06) FE 试运行面板: read-only dry-run of the LAST-SAVED
           draft graph — never writes an instance/assignment/notification. Compute-at-click via
           the shared race-guard controller (RP-2's createRoutePreviewController, made generic). -->
      <el-card
        v-if="canManageTemplates"
        v-show="activeAuthoringSection === 'review'"
        class="template-authoring__panel"
        shadow="never"
        data-testid="approval-template-tryrun-panel"
      >
        <template #header>
          <div class="template-authoring__panel-header">
            <strong>试运行</strong>
            <span class="template-authoring__hint">按样例表单值只读走一遍审批路径，不创建任何审批实例。</span>
          </div>
        </template>

        <p class="template-authoring__hint" data-testid="approval-template-tryrun-draft-note">
          试运行按最后保存的草稿图解析；未策展角色的路由以发布校验为准。
        </p>

        <el-form label-position="top" class="template-authoring__grid">
          <el-form-item label="样例发起人（留空 = 以当前管理员身份预览）">
            <ApprovalUserPicker
              v-model="sampleRequesterId"
              placeholder="搜索用户名 / 邮箱 / ID（可留空）"
              data-testid="approval-template-tryrun-requester-picker"
            />
          </el-form-item>
        </el-form>

        <div v-if="templateFormFields.length === 0" class="template-authoring__hint">
          请先在上方添加表单字段，再试运行。
        </div>
        <!-- G-B2-21 发起人视角: only fields a requester would SEE for the current sample values are
             rendered here (visibility resolved by the same getVisibleFormFields the submit page and
             the backend prune use). Editing a sample value flips visibility live. -->
        <el-form v-else label-position="top" class="template-authoring__grid">
          <template v-for="field in requesterVisibleFields" :key="field.id">
            <el-form-item
              v-if="!sampleFieldUnsupportedReason(field)"
              :label="field.label || field.id"
              data-testid="approval-template-tryrun-field"
            >
              <!-- text -->
              <el-input
                v-if="field.type === 'text'"
                v-model="sampleFormData[field.id]"
                :placeholder="field.placeholder || `请输入${field.label}`"
              />
              <!-- textarea -->
              <el-input
                v-else-if="field.type === 'textarea'"
                v-model="sampleFormData[field.id]"
                type="textarea"
                :rows="2"
                :placeholder="field.placeholder || `请输入${field.label}`"
              />
              <!-- number -->
              <el-input-number
                v-else-if="field.type === 'number'"
                v-model="sampleFormData[field.id]"
                class="ms-w-100pct"
              />
              <!-- date -->
              <el-date-picker
                v-else-if="field.type === 'date'"
                v-model="sampleFormData[field.id]"
                type="date"
                :placeholder="field.placeholder || `请选择${field.label}`"
                class="ms-w-100pct"
              />
              <!-- datetime -->
              <el-date-picker
                v-else-if="field.type === 'datetime'"
                v-model="sampleFormData[field.id]"
                type="datetime"
                :placeholder="field.placeholder || `请选择${field.label}`"
                class="ms-w-100pct"
              />
              <!-- select -->
              <el-select
                v-else-if="field.type === 'select'"
                v-model="sampleFormData[field.id]"
                :placeholder="field.placeholder || `请选择${field.label}`"
                class="ms-w-100pct"
              >
                <el-option
                  v-for="opt in (field.options || [])"
                  :key="opt.value"
                  :label="opt.label"
                  :value="opt.value"
                />
              </el-select>
              <!-- multi-select -->
              <el-select
                v-else-if="field.type === 'multi-select'"
                v-model="sampleFormData[field.id]"
                multiple
                :placeholder="field.placeholder || `请选择${field.label}`"
                class="ms-w-100pct"
              >
                <el-option
                  v-for="opt in (field.options || [])"
                  :key="opt.value"
                  :label="opt.label"
                  :value="opt.value"
                />
              </el-select>
              <!-- user -->
              <ApprovalUserPicker
                v-else-if="field.type === 'user'"
                :model-value="(sampleFormData[field.id] as string | null | undefined) ?? null"
                @update:model-value="sampleFormData[field.id] = $event"
              />
            </el-form-item>
            <div
              v-else
              class="template-authoring__hint template-authoring__wide"
              data-testid="approval-template-tryrun-field-unsupported"
            >
              {{ field.label || field.id }}：{{ sampleFieldUnsupportedReason(field) }}
            </div>
          </template>
        </el-form>

        <!-- G-B2-21: fields the current sample values HIDE from a requester — shown (not silently
             dropped) with WHY, so the author can verify their visibilityRule. Their sample values
             stay in sampleFormData but the backend prunes hidden fields before routing, so they do
             not participate in condition evaluation. -->
        <el-collapse v-if="requesterHiddenFields.length > 0" class="template-authoring__tryrun-hidden">
          <el-collapse-item
            :title="`发起人视角下当前隐藏 ${requesterHiddenFields.length} 个字段（不参与走图）`"
            name="hidden"
            data-testid="approval-template-tryrun-hidden"
          >
            <ul class="template-authoring__tryrun-hidden-list">
              <li
                v-for="entry in requesterHiddenFields"
                :key="entry.field.id"
                data-testid="approval-template-tryrun-hidden-field"
              >
                <span class="template-authoring__tryrun-hidden-label">{{ entry.field.label || entry.field.id }}</span>
                <span class="template-authoring__tryrun-hidden-reason">{{ entry.reason }}</span>
              </li>
            </ul>
          </el-collapse-item>
        </el-collapse>

        <div class="template-authoring__tryrun-actions">
          <el-tooltip v-if="tryRunDisabledReason" :content="tryRunDisabledReason" placement="top">
            <span>
              <el-button :loading="routePreviewLoading" disabled data-testid="approval-template-tryrun-button">
                试运行
              </el-button>
            </span>
          </el-tooltip>
          <el-button
            v-else
            :loading="routePreviewLoading"
            data-testid="approval-template-tryrun-button"
            @click="runTemplateRoutePreview"
          >
            试运行
          </el-button>
        </div>

        <div v-if="routePreviewError" class="template-authoring__tryrun-error" data-testid="approval-template-tryrun-error">
          {{ routePreviewError }}
        </div>
        <div v-else-if="routePreview" class="template-authoring__tryrun-row" data-testid="approval-template-tryrun-result">
          <span class="template-authoring__tryrun-chip template-authoring__tryrun-chip--requester">发起人</span>
          <template v-for="node in routePreview.route" :key="node.nodeKey">
            <span class="template-authoring__tryrun-arrow">→</span>
            <span
              class="template-authoring__tryrun-chip"
              :class="{ 'template-authoring__tryrun-chip--unresolved': !!node.resolveError }"
              data-testid="approval-template-tryrun-node"
            >
              {{ node.nodeLabel }}
              <span class="template-authoring__tryrun-chip-summary">{{ routePreviewAssigneeSummary(node) }}</span>
            </span>
          </template>
          <span
            v-if="routePreview.truncated"
            class="template-authoring__tryrun-truncated"
            data-testid="approval-template-tryrun-truncated"
          >
            （路径未能完整解析，以实际流转为准）
          </span>
          <span v-else-if="routePreview.route.length === 0" class="template-authoring__tryrun-truncated">
            （按当前样例将直接通过，无审批节点）
          </span>
        </div>

        <div v-if="conditionNodeSummaries.length" class="template-authoring__tryrun-conditions" data-testid="approval-template-tryrun-conditions">
          <strong>条件分支规则</strong>
          <ul class="template-authoring__node-summary">
            <li v-for="cond in conditionNodeSummaries" :key="cond.key">
              {{ cond.label }}：{{ cond.lines.join('；') }}
            </li>
          </ul>
        </div>
      </el-card>
          <div class="template-authoring__section-actions">
            <el-button
              :disabled="authoringSectionIndex === 0"
              data-testid="approval-template-section-previous"
              @click="moveAuthoringSection(-1)"
            >
              上一步
            </el-button>
            <el-button
              v-if="authoringSectionIndex < authoringSections.length - 1"
              type="primary"
              data-testid="approval-template-section-next"
              @click="moveAuthoringSection(1)"
            >
              下一步
            </el-button>
            <el-button
              v-else
              type="primary"
              :disabled="!canSave"
              data-testid="approval-template-section-publish"
              @click="openPublishChecklist"
            >
              检查并发布
            </el-button>
          </div>
        </main>
      </div>
    </div>

    <!-- B2-03: publish pre-flight checklist — replaces the old "confirm first, validate after"
         ElMessageBox.confirm. Every item mirrors an already-exported validator (see the
         publishChecklist computed); the confirm button stays disabled until all are ✓. -->
    <el-dialog
      v-model="publishChecklistVisible"
      title="发布前检查"
      width="480px"
      data-testid="approval-publish-checklist"
    >
      <ul class="template-authoring__publish-checklist">
        <li
          v-for="item in publishChecklist"
          :key="item.key"
          class="template-authoring__publish-checklist-item"
          :class="item.ok ? 'is-ok' : 'is-fail'"
          :data-testid="`approval-publish-checklist-item-${item.key}`"
          :data-ok="item.ok"
        >
          <span class="template-authoring__publish-checklist-icon">{{ item.ok ? '✓' : '✗' }}</span>
          <span class="template-authoring__publish-checklist-label">{{ item.label }}</span>
          <span v-if="!item.ok && item.detail" class="template-authoring__publish-checklist-detail">{{ item.detail }}</span>
        </li>
      </ul>
      <!-- B3-09 (发布说明): optional; server trims + caps at 2000 chars (maxlength mirrors it so a
           long paste fails visibly here instead of a 400 at confirm). Cleared when the dialog
           reopens so a note never silently carries over to the NEXT publish. -->
      <el-input
        v-model="publishNote"
        type="textarea"
        :rows="2"
        :maxlength="2000"
        show-word-limit
        placeholder="发布说明（可选）：本次发布改了什么"
        data-testid="approval-publish-note-input"
      />
      <template #footer>
        <el-button @click="publishChecklistVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="publishing"
          :disabled="!canConfirmPublish"
          data-testid="approval-publish-checklist-confirm"
          @click="confirmPublish"
        >
          确认发布
        </el-button>
      </template>
    </el-dialog>
  </PageShell>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import PageShell from '../../components/layout/PageShell.vue'
import PageHeader from '../../components/layout/PageHeader.vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { Plus } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useApprovalPermissions } from '../../approvals/permissions'
import { summarizeConditionBranch, summarizeConditionNode } from '../../approvals/conditionSummary'
import {
  createTemplate,
  dryRunApprovalConditionFormula,
  getTemplate,
  previewTemplateRoute,
  publishTemplate,
  updateTemplate,
  type ApprovalRoutePreview,
} from '../../approvals/api'
import { createRoutePreviewController } from '../../approvals/routePreviewController'
import { routePreviewAssigneeSummary } from '../../approvals/routePreviewSummary'
import { describeRoutePreviewError } from '../../approvals/routePreviewErrors'
import { computeRequesterPreviewFields } from '../../approvals/requesterPreviewFields'
import { buildLinearStepSpine, type LinearStepSpineChip } from '../../approvals/linearStepSpine'
import ApprovalUserPicker from '../../approvals/components/ApprovalUserPicker.vue'
import {
  buildApprovalGraph,
  buildCreateTemplatePayload,
  buildFormSchema,
  buildSlaHours,
  buildUpdateTemplatePayload,
  createEmptyDetailColumnDraft,
  createEmptyFieldDraft,
  createEmptyStepDraft,
  createEmptyTemplateDraft,
  DETAIL_LEAF_FIELD_TYPES,
  draftFromTemplate,
  graphReadOnlyReason,
  insertStepAt,
  parseIdsText,
  stepFieldAccess,
  setStepFieldPermission,
  unsupportedTemplateAuthoringReason,
  validateTemplateFormFields,
  validateTemplateApprovalFlow,
  placeholderRoleNodeKeys,
  approvalFormulaInsertOptions,
  parallelDynamicAssigneeConflicts,
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
  applyTopologyToDraft,
  moveItemToIndex,
} from '../../approvals/templateAuthoring'
import {
  addConditionBranch,
  addParallelBranch,
  appendApprovalNode,
  collectParallelRegionNodeKeys,
  insertConditionGateway,
  insertParallelGateway,
  removeLinearNode,
} from '../../approvals/graphTopologyEdit'
import {
  computeLayout,
  graphValidityIssues,
  GRAPH_LAYOUT_NODE_HEIGHT,
  GRAPH_LAYOUT_NODE_WIDTH,
  type GraphLayout,
} from '../../approvals/graphLayout'
import {
  buildCommonApprovalTemplatePresetPayload,
  COMMON_APPROVAL_TEMPLATE_PRESETS,
  type CommonApprovalTemplatePresetId,
} from '../../approvals/commonTemplatePresets'
import type {
  ApprovalAssigneeSource,
  ApprovalAssigneeSourceKind,
  ApprovalAssigneeType,
  ApprovalGraph,
  ApprovalMode,
  ApprovalNode,
  CcNodeConfig,
  ConditionNodeConfig,
  EmptyAssigneePolicy,
  FormField,
  NodeFieldAccess,
  ParallelJoinMode,
  ParallelNodeConfig,
} from '../../types/approval'
import { useApprovalDirectory } from '../../approvals/useApprovalDirectory'
import { assigneeSourceSummary } from '../../approvals/assigneeSource'

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
type AuthoringSectionId = 'basic' | 'fields' | 'flow' | 'review'
const authoringSections: Array<{
  id: AuthoringSectionId
  label: string
  description: string
}> = [
  { id: 'basic', label: '基础设置', description: '名称、范围与模板起点' },
  { id: 'fields', label: '表单设计', description: '字段、校验与显隐规则' },
  { id: 'flow', label: '审批流程', description: '审批人、分支与字段权限' },
  { id: 'review', label: '测试发布', description: '预览、试运行与发布检查' },
]
const activeAuthoringSection = ref<AuthoringSectionId>('basic')
const authoringContentRef = ref<HTMLElement | null>(null)
const validationSummaryRef = ref<HTMLElement | null>(null)
// B1-07: dirty baseline for discard protection — refreshed on every load/save so only real
// unsaved edits trigger the leave confirm. Serialized compare; the draft is rebuilt from the
// same builders on load/save, so key order is deterministic.
const draftBaseline = ref(JSON.stringify(draft.value))
const isDraftDirty = computed(() => JSON.stringify(draft.value) !== draftBaseline.value)
function snapshotDraft() {
  draftBaseline.value = JSON.stringify(draft.value)
}
const conditionFormulaDryRunSamples = ref<Record<string, string>>({})
const conditionFormulaDryRunResults = ref<Record<string, string>>({})
const conditionFormulaDryRunBusy = ref<Record<string, boolean>>({})

const templateId = computed(() => typeof route.params.id === 'string' ? route.params.id : '')
const isEditMode = computed(() => templateId.value.length > 0)
const commonTemplatePresets = COMMON_APPROVAL_TEMPLATE_PRESETS
const showPresetLibrary = computed(() => !isEditMode.value && canManageTemplates.value)
// Truly-unsupported (attachment field / unknown node / extra config keys) locks the WHOLE form.
const readOnly = computed(() => !canManageTemplates.value || Boolean(unsupportedReason.value))
// A draft enters graph authoring when it carries preservedGraph. Linear drafts are promoted when
// the author inserts their first condition or parallel gateway.
const graphReadOnly = computed(() => Boolean(draft.value.preservedGraph))
const canSave = computed(() => canManageTemplates.value && !unsupportedReason.value && !loading.value)
const draftStateLabel = computed(() => {
  if (!isEditMode.value && !isDraftDirty.value) return '新模板'
  return isDraftDirty.value ? '有未保存更改' : '已保存'
})
const authoringFlowNodeCount = computed(() => (
  graphReadOnly.value
    ? draft.value.preservedGraph?.nodes.length ?? 0
    : draft.value.steps.length
))
const authoringSectionIndex = computed(() => (
  authoringSections.findIndex(section => section.id === activeAuthoringSection.value)
))

function scrollAuthoringTarget(target: HTMLElement | null, focus = false) {
  if (!target) return
  if (focus) target.focus({ preventScroll: true })
  target.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
}

async function selectAuthoringSection(section: AuthoringSectionId) {
  activeAuthoringSection.value = section
  await nextTick()
  scrollAuthoringTarget(authoringContentRef.value)
}

async function moveAuthoringSection(delta: -1 | 1) {
  const nextIndex = Math.min(
    authoringSections.length - 1,
    Math.max(0, authoringSectionIndex.value + delta),
  )
  await selectAuthoringSection(authoringSections[nextIndex].id)
}

// G-1 read-only structured render of a preserved complex graph: a per-node summary of the
// config the v1 editor doesn't yet author, so authors can SEE the flow they're preserving.
const graphPreviewNodes = computed<ApprovalNode[]>(() => draft.value.preservedGraph?.nodes ?? [])

// G-B2-06 read-only flow spine for a LINEAR template (see `linearStepSpine.ts`) — 发起人 → 步骤1 →
// 步骤2 → …, derived straight from `draft.value.steps`. Never used for a preserved complex graph
// (rendered instead, unchanged, via `graphPreviewNodes` above): the view gates it on `!graphReadOnly`.
const linearStepSpine = computed<LinearStepSpineChip[]>(() => buildLinearStepSpine(draft.value.steps))
// Read-only-spine → step-card affordance: clicking a step chip briefly highlights (and scrolls to)
// its matching card below. Purely cosmetic — no editing happens on the spine itself.
const highlightedStepLocalId = ref<string | null>(null)
let highlightStepTimer: ReturnType<typeof setTimeout> | undefined
function focusStepCard(chip: LinearStepSpineChip): void {
  if (chip.role !== 'step') return
  highlightedStepLocalId.value = chip.key
  if (highlightStepTimer) clearTimeout(highlightStepTimer)
  highlightStepTimer = setTimeout(() => { highlightedStepLocalId.value = null }, 1600)
  document.getElementById(`approval-step-card-${chip.key}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
}

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

// `assigneeSourceSummary` (single-source label) now lives in `../../approvals/assigneeSource` —
// UX B2-08 reuses it from the approval detail view's "upcoming nodes" preview, so it moved to a
// shared module instead of staying private here. Imported above; behavior is unchanged.

// One read-only descriptor per node config, covering ALL three complex types (condition / parallel
// / cc) plus approval — so no type silently renders as "unsupported". Returns `[]` for nodes
// without summarisable config (start/end).
function nodeConfigSummary(node: ApprovalNode): string[] {
  const config = node.config as Record<string, unknown>
  if (node.type === 'condition') {
    const cfg = config as unknown as ConditionNodeConfig
    // G-B2-19: readable predicates（「金额 > 5000」）lead; edge keys stay as secondary provenance.
    return summarizeConditionNode(cfg, buildFormSchema(draft.value))
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
// G-B2-19: live readable summary for a branch being edited (adapter from the edit model to the
// persisted ConditionBranch shape; display only).
function liveBranchSummary(branch: ConditionBranchEdit): string {
  return summarizeConditionBranch(
    {
      edgeKey: branch.edgeKey,
      rules: branch.rules.map((rule) => ({ fieldId: rule.fieldId, operator: rule.operator, ...(rule.value === undefined ? {} : { value: rule.value }) })),
      conjunction: branch.conjunction,
      ...(branch.predicateMode === 'formula' && branch.formulaExpression ? { formula: { expression: branch.formulaExpression } } : {}),
    },
    buildFormSchema(draft.value),
  )
}

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
function approvalNodeMode(nodeKey: string): ApprovalMode {
  return approvalNodeEditFor(nodeKey)?.approvalMode ?? 'single'
}
function setApprovalNodeMode(nodeKey: string, mode: ApprovalMode): void {
  const edit = approvalNodeEditFor(nodeKey)
  if (edit) edit.approvalMode = mode
}
function approvalNodeEmptyPolicy(nodeKey: string): EmptyAssigneePolicy {
  return approvalNodeEditFor(nodeKey)?.emptyAssigneePolicy ?? 'error'
}
function setApprovalNodeEmptyPolicy(nodeKey: string, policy: EmptyAssigneePolicy): void {
  const edit = approvalNodeEditFor(nodeKey)
  if (edit) edit.emptyAssigneePolicy = policy
}
function approvalNodeMergeWithRequester(nodeKey: string): boolean {
  return Boolean(approvalNodeEditFor(nodeKey)?.autoApprovalPolicy?.mergeWithRequester)
}
function setApprovalNodeMergeWithRequester(nodeKey: string, enabled: boolean): void {
  const edit = approvalNodeEditFor(nodeKey)
  if (!edit) return
  const policy = edit.autoApprovalPolicy && edit.autoApprovalPolicy !== null
    ? { ...edit.autoApprovalPolicy }
    : {}
  if (enabled) policy.mergeWithRequester = true
  else delete policy.mergeWithRequester
  edit.autoApprovalPolicy = Object.keys(policy).length > 0 ? policy : null
}
function approvalNodeFieldAccess(nodeKey: string, fieldId: string): NodeFieldAccess {
  return approvalNodeEditFor(nodeKey)?.fieldPermissions?.find((permission) => permission.fieldId === fieldId)?.access ?? 'editable'
}
function setApprovalNodeFieldAccess(nodeKey: string, fieldId: string, access: NodeFieldAccess): void {
  const edit = approvalNodeEditFor(nodeKey)
  if (!edit) return
  const next = (edit.fieldPermissions ?? []).filter((permission) => permission.fieldId !== fieldId)
  if (access !== 'editable') next.push({ fieldId, access })
  edit.fieldPermissions = next
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
// in the editor so the admin replaces it first. Non-blocking — the draft still saves. Delegates to
// the shared `placeholderRoleNodeKeys` (B2-03) so the per-node hint and the aggregate publish
// checklist item share one predicate.
function approvalSourceIsPlaceholder(nodeKey: string): boolean {
  return publishPlaceholderRoleKeys.value.includes(nodeKey)
}

// ── Topology authoring (structural graph edits via graphTopologyEdit + applyTopologyToDraft) ──
// Each op runs on the EFFECTIVE graph (configs applied) and re-seeds the draft, so the structured
// editors stay in sync. Guards mirror the engine preconditions so a shown button never throws; a
// (defensive) throw surfaces as loadError. The interactive free-drag canvas is the gated next slice.
function runTopologyOp(op: (graph: ApprovalGraph) => ApprovalGraph): void {
  try {
    draft.value = applyTopologyToDraft(draft.value, op)
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
function onInsertConditionAfter(nodeKey: string): void {
  runTopologyOp((graph) => insertConditionGateway(graph, nodeKey))
  canvasViewMode.value = 'canvas'
}
function onInsertParallelAfter(nodeKey: string): void {
  runTopologyOp((graph) => insertParallelGateway(graph, nodeKey))
  canvasViewMode.value = 'canvas'
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
// F4: never OFFER a nested parallel — the backend rejects it at save ("cannot contain nested
// parallel node"), and the canvas lock requires guiding toward valid shapes rather than building a
// 422. Condition-in-parallel stays legal, so only the +并行 affordance is gated by region membership.
const parallelRegionKeys = computed<Set<string>>(() =>
  collectParallelRegionNodeKeys(draft.value.preservedGraph ?? { nodes: [], edges: [] }),
)
function canInsertParallelAfter(node: ApprovalNode): boolean {
  return canInsertAfter(node) && !parallelRegionKeys.value.has(node.key)
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
const CANVAS_NODE_W = GRAPH_LAYOUT_NODE_WIDTH
const CANVAS_NODE_H = GRAPH_LAYOUT_NODE_HEIGHT
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

// B2-03 publish pre-flight checklist — aggregates the SAME already-exported validators used
// elsewhere in this view (validateTemplateFormFields / validateTemplateApprovalFlow + canvasValidity
// / the G-5 sentinel scan) into one array the publish dialog renders BEFORE the admin commits to
// publishing, instead of only discovering an invalid draft after the confirm (promise-then-renege).
// This only surfaces existing checks earlier; it never relaxes any of them.
interface PublishChecklistItem {
  key: string
  label: string
  ok: boolean
  detail?: string
}
const publishFormFieldIssues = computed<string[]>(() => validateTemplateFormFields(draft.value, unsupportedReason.value))
// "审批流程" bundles the step/graph-edit errors with the canvas topology preview (graphValidityIssues)
// — two independent validators that both gate a successful publish server-side.
const publishApprovalFlowIssues = computed<string[]>(() => [
  ...validateTemplateApprovalFlow(draft.value),
  ...canvasValidity.value,
  // F2 publish preflight: parallel branches with provably-identical DYNAMIC approver sources 409
  // every request at runtime; the backend publish gate rejects the same shape
  // (APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT). Checklist-scoped (like the placeholder-role
  // item): the draft still SAVES — publish is what the conflicting shape can never reach.
  ...parallelDynamicAssigneeConflicts(canvasEffectiveGraph.value),
])
const publishPlaceholderRoleKeys = computed<string[]>(() => placeholderRoleNodeKeys(draft.value.approvalNodeEdits ?? {}))
const publishPlaceholderRoleIssues = computed<string[]>(() =>
  publishPlaceholderRoleKeys.value.map(
    (key) => `审批节点「${canvasNodeByKey(key)?.name || key}」仍为占位审批角色，请先替换为真实角色`,
  ),
)
const publishChecklist = computed<PublishChecklistItem[]>(() => [
  { key: 'fields', label: '表单字段', ok: publishFormFieldIssues.value.length === 0, detail: publishFormFieldIssues.value[0] },
  { key: 'flow', label: '审批流程', ok: publishApprovalFlowIssues.value.length === 0, detail: publishApprovalFlowIssues.value[0] },
  { key: 'placeholder', label: '审批人占位', ok: publishPlaceholderRoleIssues.value.length === 0, detail: publishPlaceholderRoleIssues.value[0] },
])
const canConfirmPublish = computed(() => publishChecklist.value.every((item) => item.ok))
const publishChecklistVisible = ref(false)
// B3-09 (发布说明) — optional free text bound to the checklist dialog's textarea.
const publishNote = ref('')
const canvasEdgeLines = computed(() => {
  const pos = new Map(canvasLayout.value.nodes.map((n) => [n.key, n]))
  return canvasEffectiveGraph.value.edges.map((edge) => {
    const s = pos.get(edge.source)
    const t = pos.get(edge.target)
    const x1 = (s?.x ?? 0) + CANVAS_NODE_W / 2
    const y1 = (s?.y ?? 0) + CANVAS_NODE_H
    const x2 = (t?.x ?? 0) + CANVAS_NODE_W / 2
    const y2 = t?.y ?? 0
    const midY = y1 + (y2 - y1) / 2
    return { key: edge.key, path: `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}` }
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
// G-B2-18 manual-ID advanced fallback for the complex-node picker. Unlike the linear step (whose
// idsText is a real persisted draft field — the SOLE carrier, only parsed into ids at save time),
// the node model carries just the ids array (no raw-text sibling): a naive `ids.join(', ')` getter
// re-derived on every keystroke fights the controlled <el-input> — it resets the DOM to the
// re-derived text on next tick whenever that differs from what was just typed, so a trailing
// separator is silently swallowed and a second id can never be typed. This transient per-node text
// buffer is the raw carrier instead (never part of node.config / the saved graph): read back
// verbatim once the author has touched the field, falling back to the derived join before that
// (hydrate / a node nobody has edited yet).
function approvalSourceIdsText(nodeKey: string): string {
  const v = approvalSourceIds(nodeKey).join(', ')
  console.log('DEBUG approvalSourceIdsText call ->', JSON.stringify(v), 'ids=', JSON.stringify(approvalSourceIds(nodeKey)))
  return v
}
function setApprovalSourceIdsText(nodeKey: string, text: string): void {
  setApprovalSourceIds(nodeKey, parseIdsText(text))
}
function setApprovalSourceIdsFromPicker(nodeKey: string, ids: string[]): void {
  setApprovalSourceIds(nodeKey, ids)
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
// FWB-3 v1: only supported scalar decision types (text/textarea/number/date/datetime/select).
// Exclude attachment, user, multi-select, detail, record-link (backend rejects them at publish too).
const FWB_DECISION_FIELD_TYPES = new Set([
  'text',
  'textarea',
  'number',
  'date',
  'datetime',
  'select',
])
const decisionFieldOptions = computed(() =>
  draft.value.fields
    .filter((field) => {
      const id = field.id.trim()
      if (!id) return false
      return FWB_DECISION_FIELD_TYPES.has(field.type)
    })
    .map((field) => ({
      id: field.id.trim(),
      label: field.label.trim() ? `${field.label.trim()} (${field.id.trim()})` : field.id.trim(),
    })),
)

// T1-4 node field permissions: every top-level form field is a candidate for a per-node access
// override (the linear editor shows the same field list for every approval step).
const fieldPermissionFields = computed(() => draft.value.fields.filter((field) => field.id.trim()))
// Form fields that DRIVE routing (a form_field_user assignee source references them). Hiding one is
// allowed — redaction is echo-only, so resolution is unaffected — but the UI surfaces a hint.
const routingDriverFieldIds = computed(() => {
  const ids = new Set<string>()
  for (const step of draft.value.steps) {
    if (step.sourceKind === 'form_field_user' && step.fieldId.trim()) ids.add(step.fieldId.trim())
  }
  return ids
})
function onStepFieldAccessChange(step: ApprovalStepDraft, fieldId: string, access: NodeFieldAccess): void {
  step.fieldPermissions = setStepFieldPermission(step.fieldPermissions, fieldId, access)
}

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
  // Keep already-selected ids visible as chips even if the new search page omits them —
  // across BOTH pickers that share this one composable instance (linear steps + G-B2-18
  // complex-graph nodes).
  for (const step of draft.value.steps) {
    if (step.sourceKind !== 'static_user') continue
    for (const id of parseIdsText(step.idsText)) directory.ensureUserOptionVisible(id)
  }
  for (const nodeKey of Object.keys(draft.value.approvalNodeEdits ?? {})) {
    if (approvalSourceKind(nodeKey) !== 'static_user') continue
    for (const id of approvalSourceIds(nodeKey)) directory.ensureUserOptionVisible(id)
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

// G-B2-18: same hydrate-time visibility sync as syncStepOptions, applied to the complex-graph
// approval-node assignee sources (approvalNodeEdits is keyed by nodeKey, one entry per editable
// approval node — see approvalNodeEditFor). Also re-seeds (or clears) the manual-ID text buffer
// so a source-KIND switch never leaves the OTHER kind's stale typed text showing — the buffer is
// keyed only by nodeKey, not by (nodeKey, kind), so it must be reset whenever kind changes.
function syncApprovalNodeOptions(nodeKey: string): void {
  const kind = approvalSourceKind(nodeKey)
  if (kind === 'static_user') {
    for (const id of approvalSourceIds(nodeKey)) directory.ensureUserOptionVisible(id)
  } else if (kind === 'static_role') {
    for (const id of approvalSourceIds(nodeKey)) directory.ensureRoleOptionVisible(id)
  }
}

function syncAllApprovalNodeOptions(): void {
  for (const nodeKey of Object.keys(draft.value.approvalNodeEdits ?? {})) syncApprovalNodeOptions(nodeKey)
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

// G-B2-06 — insert (not just append): a fresh blank step lands right after `index`, and any
// STILL-DEFAULT-named trailing step is renumbered to stay self-consistent (see `insertStepAt`'s
// own doc in templateAuthoring.ts for exactly what counts as "still default").
function insertStep(index: number) {
  draft.value.steps = insertStepAt(draft.value.steps, index)
}

function insertConditionAfterStep(index: number) {
  onInsertConditionAfter(`approval_${index + 1}`)
}

function insertParallelAfterStep(index: number) {
  onInsertParallelAfter(`approval_${index + 1}`)
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
    snapshotDraft()
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
    syncAllApprovalNodeOptions()
    snapshotDraft()
  } catch (error: any) {
    loadError.value = error?.message ?? '加载审批模板失败'
  } finally {
    loading.value = false
  }
}

function firstInvalidAuthoringSection(formErrors: string[]): AuthoringSectionId {
  const hasBasicSettingsError = Boolean(unsupportedReason.value)
    || !draft.value.key.trim()
    || !draft.value.name.trim()
    || (draft.value.visibilityType !== 'all' && parseIdsText(draft.value.visibilityIdsText).length === 0)
    || Number.isNaN(buildSlaHours(draft.value))
  if (hasBasicSettingsError) return 'basic'
  if (formErrors.length > 0) return 'fields'
  return 'flow'
}

async function validate(): Promise<boolean> {
  const formErrors = validateTemplateFormFields(draft.value, unsupportedReason.value)
  const flowErrors = validateTemplateApprovalFlow(draft.value)
  validationErrors.value = [...formErrors, ...flowErrors]
  if (validationErrors.value.length > 0) {
    activeAuthoringSection.value = firstInvalidAuthoringSection(formErrors)
    ElMessage.warning('请先修正模板配置')
    await nextTick()
    scrollAuthoringTarget(validationSummaryRef.value, true)
    return false
  }
  return true
}

async function persistDraft() {
  if (!(await validate())) return null
  saving.value = true
  try {
    if (draft.value.templateId) {
      const updated = await updateTemplate(draft.value.templateId, buildUpdateTemplatePayload(draft.value))
      draft.value = draftFromTemplate(updated)
      unsupportedReason.value = unsupportedTemplateAuthoringReason(updated)
      graphReadOnlyMessage.value = graphReadOnlyReason(updated)
      snapshotDraft()
      return updated
    }
    const created = await createTemplate(buildCreateTemplatePayload(draft.value))
    draft.value = draftFromTemplate(created)
    unsupportedReason.value = unsupportedTemplateAuthoringReason(created)
    graphReadOnlyMessage.value = graphReadOnlyReason(created)
    snapshotDraft() // before the route replace so the leave guard stays quiet
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
    syncAllApprovalNodeOptions()
    snapshotDraft() // before the route replace so the leave guard stays quiet
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

// B2-03: publish pre-flight — opens the checklist dialog INSTEAD of confirming immediately, so an
// invalid draft is visible before the admin commits (the dialog's own confirm button stays disabled
// while `canConfirmPublish` is false). Once the checklist is all-green, `confirmPublish` runs the
// SAME persistDraft → publishTemplate → success-routing sequence as before this change.
function openPublishChecklist() {
  if (!canSave.value || publishing.value) return
  // B3-09 — a publish note describes ONE publish action; never carry it into the next one.
  publishNote.value = ''
  publishChecklistVisible.value = true
}

async function confirmPublish() {
  if (!canConfirmPublish.value) return
  publishChecklistVisible.value = false
  publishing.value = true
  try {
    const saved = await persistDraft()
    if (!saved) return
    // B3-09 — whitespace-only normalizes to null server-side; send undefined to keep the wire
    // payload identical to pre-B3-09 publishes when the admin typed nothing.
    const note = publishNote.value.trim()
    await publishTemplate(saved.id, {
      policy: { allowRevoke: draft.value.allowRevoke },
      ...(note ? { note } : {}),
    })
    ElMessage.success('模板已发布')
    await router.push({ path: `/approval-templates/${saved.id}` })
  } catch (error: any) {
    loadError.value = error?.message ?? '发布模板失败'
  } finally {
    publishing.value = false
  }
}

// RP-3 (route-preview lock, B3-06 FE 试运行面板) — template AUTHOR's read-only dry-run of the
// LAST-SAVED draft (previewSource: 'draft' server-side — an editor with unsaved changes must save
// first, enforced below via tryRunDisabledReason). Compute-at-click; any change to the sample
// requester or sample form values invalidates the stale result — the SAME race-guard controller
// RP-2's ApprovalNewView uses, now generic so this DIFFERENT request shape (`sampleFormData` +
// optional `sampleRequesterId`, vs RP-2's `templateId` + `formData`) can reuse it verbatim instead
// of a second hand-rolled loading/race implementation.
const sampleRequesterId = ref<string | null>(null)
const sampleFormData = ref<Record<string, unknown>>({})
const routePreview = ref<ApprovalRoutePreview | null>(null)
const routePreviewLoading = ref(false)
const routePreviewError = ref('')

// The template must exist server-side before it has an id to preview against.
// `draft.value.templateId` is set by persistDraft() immediately on create/update (before the
// router.replace even resolves), so it is the authoritative id source — not the route param,
// which only updates once that navigation lands.
const templateIdForPreview = computed(() => draft.value.templateId ?? '')

const tryRunDisabledReason = computed<string>(() => {
  if (!templateIdForPreview.value) return '请先保存草稿以获取模板 ID，才能试运行'
  if (isDraftDirty.value) return '有未保存的更改，请先保存再试运行'
  return ''
})

const routePreviewController = createRoutePreviewController(
  async (req: { sampleFormData: Record<string, unknown>; sampleRequesterId?: string }) => {
    try {
      return await previewTemplateRoute(templateIdForPreview.value, req)
    } catch (error) {
      // Wedge-guard machine codes (422 *_REQUIRED / 503 *_UNRESOLVED) get an actionable Chinese
      // message here instead of surfacing as a generic failure flash — the controller only ever
      // reads `.message` off a caught error, so the code → message translation must happen
      // before it does (describeRoutePreviewError is unit-tested independently).
      throw new Error(describeRoutePreviewError(error))
    }
  },
  (patch) => {
    if ('preview' in patch) routePreview.value = patch.preview ?? null
    if (patch.loading !== undefined) routePreviewLoading.value = patch.loading
    if (patch.error !== undefined) routePreviewError.value = patch.error
  },
)

async function runTemplateRoutePreview() {
  if (tryRunDisabledReason.value) return
  await routePreviewController.run({
    sampleFormData: { ...sampleFormData.value },
    ...(sampleRequesterId.value ? { sampleRequesterId: sampleRequesterId.value } : {}),
  })
}

watch(sampleFormData, () => routePreviewController.invalidate(), { deep: true })
watch(sampleRequesterId, () => routePreviewController.invalidate())
// A draft-graph edit invalidates a prior result too — the ratified "stale path never misleads"
// contract otherwise breaks the moment isDraftDirty flips true: the button greys out (see
// tryRunDisabledReason), but the OLD chip row would keep rendering as if it still matched the
// (now-unsaved) graph.
watch(isDraftDirty, (dirty) => {
  if (dirty) routePreviewController.invalidate()
})

// The sample form renders off the SAME formSchema the template actually routes on
// (buildFormSchema(draft.value) — identical source as the "JSON 预览" card above), so an author
// never types a sample value the template can't see. `detail` (repeating sub-form rows) and
// `attachment` (no working upload pipeline yet — see ApprovalNewView's own honest stopgap) are
// skipped with an inline note rather than faked; every other field type gets a plain input.
const templateFormFields = computed<FormField[]>(() => buildFormSchema(draft.value).fields)

// G-B2-21: the requester-view split for the 试运行 sample values. Delegates visibility to the
// shared getVisibleFormFields (see requesterPreviewFields) so the panel, the submit page, and the
// backend prune never disagree. templateFormFields stays the FULL field list for the other callers.
const requesterPreview = computed(() => computeRequesterPreviewFields(buildFormSchema(draft.value), sampleFormData.value))
const requesterVisibleFields = computed<FormField[]>(() => requesterPreview.value.visible)
const requesterHiddenFields = computed(() => requesterPreview.value.hidden)

function sampleFieldUnsupportedReason(field: FormField): string | null {
  if (field.type === 'detail') return '试运行暂不支持明细子表单的样例值，已跳过（不影响其余字段的走图）'
  if (field.type === 'attachment') return '试运行暂不支持附件类型的样例值，已跳过'
  return null
}

// G-B2-19 condition summaries for the panel's static "条件分支规则" note — read straight off the
// preserved graph (same source as the read-only structured node list above), NOT off the
// route-preview response: the endpoint only ever returns `{ route, truncated }` (§3) — it does not
// echo which branch a condition node took — so this can only show the RULE, never "which one fired".
const conditionNodeSummaries = computed(() =>
  graphPreviewNodes.value
    .filter((node) => node.type === 'condition')
    .map((node) => ({
      key: node.key,
      label: node.name || node.key,
      lines: nodeConfigSummary(node),
    })),
)

onMounted(() => {
  if (!canManageTemplates.value) return
  void directory.loadRoles()
  void directory.loadFormulaRoles()
  void loadTemplateForEdit()
})

// B1-07: discard protection — the editor is the longest-lived form in the approval admin
// surface and previously lost all edits on a stray back-click. Route leaves confirm when
// dirty; hard reloads/closures get the browser-native prompt (same pattern as WorkflowDesigner).
onBeforeRouteLeave(async () => {
  if (!isDraftDirty.value) return true
  try {
    await ElMessageBox.confirm('有未保存的更改，离开将丢失编辑内容。确定离开吗？', '未保存的更改', {
      confirmButtonText: '离开',
      cancelButtonText: '留下',
      type: 'warning',
    })
    return true
  } catch {
    return false
  }
})

watch(isDraftDirty, (dirty) => {
  window.onbeforeunload = dirty ? () => '有未保存的更改' : null
})

onUnmounted(() => {
  window.onbeforeunload = null
  if (highlightStepTimer) clearTimeout(highlightStepTimer)
})
</script>

<style scoped>
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

.template-authoring__header {
  position: sticky;
  top: 0;
  z-index: 3;
  padding: var(--ms-space-3) 0;
  border-bottom: 1px solid var(--ms-border-light);
  background: var(--ms-bg-page);
}

.template-authoring__save-state,
.template-authoring__meta-count {
  display: inline-flex;
  align-items: center;
  min-height: 26px;
  padding: var(--ms-space-1) var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 999px;
  background: var(--ms-bg-card);
  color: var(--ms-text-2);
  font-size: 12px;
}

.template-authoring__save-state::before {
  width: 7px;
  height: 7px;
  margin-right: var(--ms-space-2);
  border-radius: 50%;
  background: var(--ms-color-success);
  content: '';
}

.template-authoring__save-state--dirty::before {
  background: var(--ms-color-warning);
}

.template-authoring__alert {
  margin-bottom: 16px;
}

.template-authoring__validation-summary,
.template-authoring__content {
  scroll-margin-top: 124px;
}

.template-authoring__validation-summary:focus {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 2px;
}

.template-authoring__body {
  min-height: 560px;
}

.template-authoring__workspace {
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
  align-items: start;
  gap: var(--ms-space-5);
}

.template-authoring__steps {
  position: sticky;
  top: 116px;
  display: grid;
  gap: var(--ms-space-2);
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-lg);
  background: var(--ms-bg-card);
  box-shadow: var(--ms-shadow-card);
}

.template-authoring__steps-heading {
  display: grid;
  gap: var(--ms-space-1);
  padding: var(--ms-space-2) var(--ms-space-2) var(--ms-space-3);
  color: var(--ms-text-1);
}

.template-authoring__steps-heading span {
  color: var(--ms-text-3);
  font-size: 12px;
}

.template-authoring__step {
  width: 100%;
  height: auto;
  min-height: 58px;
  margin: 0;
  padding: var(--ms-space-2);
  color: var(--ms-text-2);
  white-space: normal;
}

.template-authoring__step :deep(> span) {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--ms-space-2);
  width: 100%;
  text-align: left;
}

.template-authoring__step.is-active {
  background: var(--el-color-primary-light-9);
  color: var(--ms-color-primary);
}

.template-authoring__step-index,
.template-authoring__step-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--el-fill-color-light);
  color: var(--ms-text-2);
  font-size: 12px;
  font-weight: 600;
}

.template-authoring__step.is-active .template-authoring__step-index {
  background: var(--ms-color-primary);
  color: var(--ms-bg-card);
}

.template-authoring__step-count {
  width: auto;
  min-width: 24px;
  height: 22px;
  padding: 0 var(--ms-space-1);
  border-radius: 999px;
}

.template-authoring__step-copy {
  display: grid;
  gap: 2px;
}

.template-authoring__step-copy small {
  color: var(--ms-text-3);
  font-size: 11px;
  font-weight: 400;
}

.template-authoring__content {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--ms-space-4);
}

.template-authoring__panel {
  border-color: var(--ms-border-light);
  border-radius: var(--ms-radius-lg);
  box-shadow: var(--ms-shadow-card);
}

.template-authoring__section-actions {
  position: sticky;
  bottom: 0;
  z-index: 2;
  display: flex;
  justify-content: space-between;
  gap: var(--ms-space-3);
  padding: var(--ms-space-3) var(--ms-space-4);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-lg);
  background: var(--ms-bg-card);
  box-shadow: var(--ms-shadow-pop);
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
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

.template-authoring__preset p {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
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
  color: var(--el-text-color-secondary);
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
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.template-authoring__item + .template-authoring__item {
  margin-top: 12px;
}

/* G-B2-06 — brief highlight when a step card is reached via a flow-spine chip click. */
.template-authoring__item--highlighted {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 2px var(--el-color-primary-light-5);
}

/* G-B2-06 read-only linear flow spine. */
.template-authoring__spine {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 14px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-fill-color-light);
}

.template-authoring__spine-chip {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 6px 10px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: var(--ms-bg-card);
  color: var(--el-text-color-primary);
  font: inherit;
  cursor: pointer;
}

.template-authoring__spine-chip:hover {
  border-color: var(--el-color-primary);
}

.template-authoring__spine-chip--requester {
  background: var(--el-fill-color);
  cursor: default;
}

.template-authoring__spine-chip--requester:hover {
  border-color: var(--el-border-color);
}

.template-authoring__spine-chip--unresolved {
  border-style: dashed;
  border-color: var(--el-color-warning);
}

.template-authoring__spine-chip-source {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.template-authoring__spine-arrow {
  color: var(--el-text-color-secondary);
}

.template-authoring__item-toolbar {
  margin-bottom: 12px;
}

.template-authoring__node-type {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--el-fill-color-light);
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
}

.template-authoring__condition-branch {
  border: 1px dashed var(--el-border-color);
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
  color: var(--el-text-color-regular);
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
  color: var(--el-text-color-regular);
}

.template-authoring__condition-default {
  margin: 4px 0 0;
}

.template-authoring__error-list {
  margin: 6px 0 0;
  padding-left: 20px;
}

.template-authoring__publish-checklist {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.template-authoring__publish-checklist-item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--el-fill-color-lighter);
}

.template-authoring__publish-checklist-item.is-ok .template-authoring__publish-checklist-icon {
  color: var(--el-color-success);
}

.template-authoring__publish-checklist-item.is-fail .template-authoring__publish-checklist-icon {
  color: var(--el-color-danger);
}

.template-authoring__publish-checklist-icon {
  font-weight: 700;
}

.template-authoring__publish-checklist-detail {
  flex-basis: 100%;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
}

@media (max-width: 1024px) {
  .template-authoring__workspace {
    grid-template-columns: 1fr;
  }

  .template-authoring__steps {
    position: sticky;
    top: 108px;
    z-index: 2;
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .template-authoring__steps-heading {
    display: none;
  }

  .template-authoring__step-copy small,
  .template-authoring__step-count {
    display: none;
  }

  .template-authoring__step :deep(> span) {
    grid-template-columns: 28px minmax(0, 1fr);
  }
}

@media (max-width: 760px) {
  .template-authoring__header {
    position: static;
  }

  .template-authoring__header :deep(.ms-page-header__top) {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
  }

  .template-authoring__header :deep(.ms-page-header__actions) {
    grid-column: 1 / -1;
    width: 100%;
  }

  .template-authoring__validation-summary,
  .template-authoring__content {
    scroll-margin-top: var(--ms-space-3);
  }

  .template-authoring__actions,
  .template-authoring__actions :deep(.el-button) {
    width: 100%;
  }

  .template-authoring__actions :deep(.el-button) {
    flex: 1;
  }

  .template-authoring__steps {
    top: 0;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .template-authoring__grid {
    grid-template-columns: 1fr;
  }

  .template-authoring__preset-grid {
    grid-template-columns: 1fr;
  }

  .template-authoring__section-actions :deep(.el-button) {
    flex: 1;
    min-height: 44px;
  }
}

.template-authoring__view-toggle {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.template-authoring__canvas-viewport {
  max-width: 100%;
  overflow: auto;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: var(--ms-bg-page);
}
.template-authoring__canvas {
  position: relative;
  background: var(--ms-bg-page);
  min-height: 200px;
}
.template-authoring__canvas-edges {
  position: absolute;
  left: 0;
  top: 0;
}
.template-authoring__canvas-node {
  box-sizing: border-box;
  padding: 6px 10px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: var(--ms-bg-card);
  box-shadow: var(--el-box-shadow-lighter);
  display: flex;
  flex-direction: column;
  gap: 2px;
  cursor: grab;
  font-size: 12px;
  min-height: 96px;
}
.template-authoring__canvas-node.is-selected {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 2px var(--el-color-primary-light-5);
}
.template-authoring__canvas-node-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

/* RP-3 (route-preview lock, B3-06) 试运行面板 — chip styling mirrors ApprovalNewView's RP-2 live
   route preview (same visual language for "resolved path", different scoped class prefix since
   Vue's `<style scoped>` is per-SFC). */
.template-authoring__tryrun-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}

.template-authoring__tryrun-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
}

.template-authoring__tryrun-chip {
  display: inline-flex;
  flex-direction: column;
  padding: 4px 10px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-regular);
  font-size: 13px;
}

.template-authoring__tryrun-chip--requester {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-weight: 500;
}

.template-authoring__tryrun-chip--unresolved {
  border: 1px dashed var(--el-color-danger);
}

.template-authoring__tryrun-chip-summary {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

.template-authoring__tryrun-arrow {
  color: var(--el-text-color-placeholder);
  font-size: 12px;
}

.template-authoring__tryrun-error {
  margin-top: 10px;
  font-size: 12px;
  color: var(--el-color-danger);
}

.template-authoring__tryrun-hidden {
  margin-top: 10px;
}

.template-authoring__tryrun-hidden-list {
  margin: 0;
  padding-left: 18px;
}

.template-authoring__tryrun-hidden-list li {
  margin-bottom: 4px;
  font-size: 12px;
}

.template-authoring__tryrun-hidden-label {
  color: var(--el-text-color-primary);
  margin-right: 8px;
}

.template-authoring__tryrun-hidden-reason {
  color: var(--el-text-color-secondary);
}

.template-authoring__tryrun-truncated {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.template-authoring__tryrun-conditions {
  margin-top: 12px;
  font-size: 13px;
}
</style>
