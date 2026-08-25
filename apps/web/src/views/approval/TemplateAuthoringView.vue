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
        <!-- P1-D (master §4 UI-3/UI-9): compact navigation-only link to the existing version
             history section on TemplateDetailView.vue — no new version storage here. Lives in the
             #meta info line (not #actions) so it never contends with the Lock-0 L0-5 header
             route-preview toggle debt, which parent §9/§2 places in the ACTIONS/toolbar area. -->
        <el-button
          v-if="hasSavedVersionHistory"
          text
          size="small"
          class="template-authoring__version-history-link"
          data-testid="approval-template-version-history-link"
          @click="goToVersionHistory"
        >
          版本历史
        </el-button>
      </template>
      <template #actions>
        <div class="template-authoring__actions">
          <!-- B0: 飞书-style "N项不完善" affordance — save stays unblocked by these; publish
               still requires them all resolved (canConfirmPublish, unchanged). -->
          <el-button
            v-if="incompleteAuthoringIssueCount > 0"
            text
            size="small"
            class="template-authoring__incomplete-count"
            data-testid="approval-template-incomplete-count"
            :aria-label="`${incompleteAuthoringIssueCount} 项不完善，点击查看详情`"
            @click="revealIncompleteAuthoringIssues"
          >
            {{ incompleteAuthoringIssueCount }} 项不完善
          </el-button>
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
      description="画布编排结构；选中节点后可在右侧检查器编辑审批人、条件、并行汇聚、抄送和字段权限（与结构列表共用同一草稿）。"
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
          <el-button
            v-for="(section, index) in authoringSections"
            :key="section.id"
            class="template-authoring__step"
            :class="{ 'is-active': activeAuthoringSection === section.id }"
            text
            :aria-current="activeAuthoringSection === section.id ? 'step' : undefined"
            :aria-label="`${index + 1} ${section.label} ${section.description}${section.id === 'basic' && basicInfoIssueCount > 0 ? `，${basicInfoIssueCount} 项不完善` : ''}`"
            :data-testid="`approval-template-section-${section.id}`"
            @click="selectAuthoringSection(section.id)"
          >
            <span class="template-authoring__step-index">{{ index + 1 }}</span>
            <span class="template-authoring__step-copy">
              <strong>{{ section.label }}</strong>
            </span>
            <!-- P1-A0: typed-issue-derived count, basic-info step only (see `basicInfoIssueCount`
                 above — NOT the parent-lock header count, which stays undelivered debt).
                 Reuses the pre-existing `.template-authoring__step-count` pill style, which had
                 no template usage before this slice. -->
            <span
              v-if="section.id === 'basic' && basicInfoIssueCount > 0"
              class="template-authoring__step-count"
              data-testid="approval-template-section-basic-issue-count"
            >
              {{ basicInfoIssueCount }} 项不完善
            </span>
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
            <el-input
              v-model="draft.category"
              :disabled="readOnly"
              placeholder="如 请假 / 采购 / 报销"
              data-testid="approval-template-category"
            />
          </el-form-item>
          <el-form-item label="SLA 小时">
            <el-input
              v-model="draft.slaHoursText"
              :disabled="readOnly"
              placeholder="留空表示不启用"
              data-testid="approval-template-sla-hours"
            />
          </el-form-item>
          <el-form-item label="描述" class="template-authoring__wide">
            <el-input
              v-model="draft.description"
              :disabled="readOnly"
              type="textarea"
              :rows="3"
              data-testid="approval-template-description"
            />
          </el-form-item>
          <el-form-item label="可见范围">
            <div class="template-authoring__inline">
              <el-select
                v-model="draft.visibilityType"
                :disabled="readOnly"
                class="ms-w-140"
                data-testid="approval-template-visibility-type"
              >
                <el-option label="全员" value="all" />
                <el-option label="部门" value="dept" />
                <el-option label="角色" value="role" />
                <el-option label="用户" value="user" />
              </el-select>
              <el-input
                v-model="draft.visibilityIdsText"
                :disabled="readOnly || draft.visibilityType === 'all'"
                placeholder="逗号分隔，按所选范围填写"
                data-testid="approval-template-visibility-ids"
              />
            </div>
          </el-form-item>
          <el-form-item label="发布策略">
            <el-checkbox
              v-model="draft.allowRevoke"
              :disabled="readOnly"
              data-testid="approval-template-allow-revoke"
            >
              允许发起人撤回
            </el-checkbox>
          </el-form-item>
        </el-form>
      </el-card>

      <el-card v-show="activeAuthoringSection === 'fields'" class="template-authoring__panel" shadow="never">
        <template #header>
          <div class="template-authoring__panel-header">
            <strong>表单设计</strong>
            <div class="template-authoring__form-toolbar">
              <el-button
                size="small"
                :disabled="readOnly || !(showFormBuilderV2 ? builderCanUndo : canUndoFormFieldHistory)"
                data-testid="approval-form-undo"
                @click="onFormUndoRedoClick('undo')"
              >
                撤销
              </el-button>
              <el-button
                size="small"
                :disabled="readOnly || !(showFormBuilderV2 ? builderCanRedo : canRedoFormFieldHistory)"
                data-testid="approval-form-redo"
                @click="onFormUndoRedoClick('redo')"
              >
                重做
              </el-button>
              <!-- Designer 2.0's palette (click/keyboard slot insertion) supersedes this button —
                   hiding it under the flag avoids a second, divergent add-field path (M7). -->
              <el-button
                v-if="!showFormBuilderV2"
                size="small"
                :disabled="readOnly"
                data-testid="approval-template-add-field"
                @click="addField"
              >
                <el-icon><Plus /></el-icon>
                添加字段
              </el-button>
            </div>
          </div>
        </template>

        <ApprovalFormInlineEditor
          v-if="!showFormBuilderV2"
          data-testid="approval-form-designer"
          :fields="draft.fields"
          :read-only="readOnly"
          :template-name="draft.name"
          :form-field-focus-local-id="formFieldFocusLocalId"
          :field-palette-groups="fieldPaletteGroups"
          :field-palette-labels="FIELD_PALETTE_LABELS"
          :detail-leaf-type-options="detailLeafTypeOptions"
          :record-link-catalog-error="recordLinkCatalogError"
          :record-link-catalog-loading="recordLinkCatalogLoading"
          :record-link-catalog-loaded="recordLinkCatalogLoaded"
          :record-link-base-options-for="recordLinkBaseOptionsFor"
          :record-link-sheet-options-for="recordLinkSheetOptionsFor"
          :visibility-field-options="visibilityFieldOptions"
          @add-field-of-type="addFieldOfType"
          @palette-drag-start="onPaletteDragStart"
          @preview-drop="onPreviewDrop"
          @select-field-focus="selectFormFieldFocus"
          @field-drag-start="onFieldDragStart"
          @field-drop="onFieldDrop"
          @move-field="moveField"
          @remove-field="removeField"
          @invalidate-record-link-deps="invalidateStaleRecordLinkDependencies"
          @retry-record-link-catalog="retryRecordLinkCatalog"
          @record-link-base-change="onRecordLinkBaseChange"
          @record-link-sheet-change="onRecordLinkSheetChange"
          @add-detail-column="addDetailColumn"
          @remove-detail-column="removeDetailColumn"
        />
        <!-- F4 production mount (delta §5 F4, FB-D8): Designer 2.0 — the SAME composition shape
             as the owned browser harness (`verification/approval-form-builder-harness.ts`): one
             shared `dragSession`, palette + builder as siblings. `formBuilderSessionEpoch` is the
             ONLY thing that remounts this (see `reseedFormBuilderSessionIfActive`); no `:key` is
             derived from `draft` itself, so routine edits/tab-switches never reseed the session. -->
        <div
          v-else
          class="template-authoring__form-designer-v2"
          data-testid="approval-form-designer-v2"
        >
          <ApprovalFormPalette
            :read-only="readOnly"
            :drag-session="approvalFormDragSession"
            @append-field="onFormBuilderPaletteAppend"
          />
          <ApprovalFormBuilder
            :key="formBuilderSessionEpoch"
            ref="formBuilderRef"
            :draft="draft"
            :read-only="readOnly"
            :drag-session="approvalFormDragSession"
            @draft-change="onFormBuilderDraftChange"
          />
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
        <div v-if="graphReadOnly && canvasV2Enabled" class="template-authoring__view-toggle" data-testid="approval-graph-view-toggle">
          <el-button size="small" :type="canvasViewMode === 'canvas' ? 'primary' : 'default'" data-testid="approval-view-canvas" @click="canvasViewMode = 'canvas'">画布视图</el-button>
          <el-button size="small" :type="canvasViewMode === 'list' ? 'primary' : 'default'" data-testid="approval-view-list" @click="canvasViewMode = 'list'">辅助编辑模式</el-button>
        </div>

        <!-- D-1/D-5 visual canvas + inspector (PR4: extracted shell components; draft/history stay here). -->
        <div
          v-if="graphReadOnly && canvasV2Enabled && canvasViewMode === 'canvas'"
          class="template-authoring__canvas-workspace"
          data-testid="approval-canvas-workspace"
        >
          <ApprovalFlowCanvas
            ref="approvalFlowCanvasRef"
            :read-only="readOnly"
            :canvas-validity="canvasValidity"
            :can-undo="canUndoCanvasHistory"
            :can-redo="canRedoCanvasHistory"
            :canvas-zoom-label="canvasZoomLabel"
            :canvas-stage-css="canvasStageStyle"
            :canvas-surface-css="canvasSurfaceStyle"
            :canvas-layout="canvasLayout"
            :canvas-edge-lines="canvasEdgeLines"
            :canvas-move-target-lines="canvasMoveTargetLines"
            :selected-canvas-node="selectedCanvasNode"
            :moving-canvas-node="movingCanvasNode"
            :edge-insert-menu-edge-key="edgeInsertMenuEdgeKey"
            :canvas-minimap="canvasMinimap"
            :node-width="CANVAS_NODE_W"
            :node-height="CANVAS_NODE_H"
            :minimap-width="CANVAS_MINIMAP_W"
            :minimap-height="CANVAS_MINIMAP_H"
            :graph-node-label="graphNodeLabel"
            :canvas-node-summary="canvasNodeCardSummary"
            :node-type-label="nodeTypeLabel"
            :canvas-node-by-key="canvasNodeByKey"
            :can-move-canvas-node="canMoveCanvasNode"
            :can-insert-parallel-on-edge="canInsertParallelOnEdge"
            :can-insert-handler-on-edge="canInsertHandlerOnEdge"
            :canvas-move-target-label="canvasMoveTargetLabel"
            @undo="onCanvasUndo"
            @redo="onCanvasRedo"
            @zoom-out="changeCanvasZoom('out')"
            @zoom-in="changeCanvasZoom('in')"
            @zoom-reset="resetCanvasZoom"
            @fit="fitCanvasToViewport"
            @scroll="syncCanvasViewportState"
            @select-node="selectCanvasNode"
            @node-keydown="onCanvasNodeKeydown"
            @drag-start="onCanvasNodeDragStart"
            @drag-end="cancelCanvasNodeMove"
            @move-target-click="applyCanvasNodeMove"
            @drop="onCanvasNodeDrop"
            @toggle-edge-insert="toggleEdgeInsertMenu"
            @edge-insert-approval="onEdgeInsertApproval"
            @edge-insert-cc="onEdgeInsertCc"
            @edge-insert-condition="onEdgeInsertCondition"
            @edge-insert-parallel="onEdgeInsertParallel"
            @edge-insert-handler="onEdgeInsertHandler"
          />
          <ApprovalCanvasNodeInspector
            v-if="selectedCanvasInspectorNode"
            ref="approvalCanvasInspectorRef"
            :node="selectedCanvasInspectorNode"
            :read-only="readOnly"
            :moving-canvas-node="movingCanvasNode"
            :graph-node-label="graphNodeLabel"
            :node-type-label="nodeTypeLabel"
            :can-move-canvas-node="canMoveCanvasNode"
            :canvas-step-move-target="canvasStepMoveTarget"
            :can-insert-after="canInsertAfter"
            :can-insert-parallel-after="canInsertParallelAfter"
            :can-remove-node="canRemoveNode"
            @close="clearCanvasSelection"
            @move-up="(key) => moveCanvasNodeStep(key, 'up')"
            @move-down="(key) => moveCanvasNodeStep(key, 'down')"
            @begin-move="beginCanvasNodeMove"
            @add-condition-branch="onAddConditionBranch"
            @add-parallel-branch="onAddParallelBranch"
            @insert-approval="onInsertApprovalAfter"
            @insert-condition="onInsertConditionAfter"
            @insert-parallel="onInsertParallelAfter"
            @remove="onRemoveNode"
            @rename="onRenameCanvasNode"
          >
            <ApprovalGraphNodeConfigEditor :node="selectedCanvasInspectorNode" />
          </ApprovalCanvasNodeInspector>
        </div>

        <div v-if="graphReadOnly && (!canvasV2Enabled || canvasViewMode === 'list')" data-testid="approval-graph-readonly-list">
          <div
            v-for="node in graphPreviewNodes"
            :key="node.key"
            class="template-authoring__item"
            data-testid="approval-graph-node-row"
          >
            <div class="template-authoring__item-toolbar">
              <strong>{{ node.name?.trim() || '未命名节点' }}</strong>
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

            <ApprovalGraphNodeConfigEditor :node="node" />
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
                <el-option label="提交人自选" value="requester_choice" />
                <el-option label="连续多级部门负责人" value="continuous_dept_heads" />
                <el-option label="指定层级部门负责人" value="dept_head_at_level" />
                <el-option label="节点审批人" value="prior_node_approver" />
                <el-option label="用户组" value="user_group" />
                <!-- Lock-2 §2.4 C-7 form-schema precondition (D-6): the contact-extension kinds
                     are OFFERED only when the form declares a user field — the affordance is
                     schema-selected; a persisted selection stays rendered via the v-if's
                     already-selected escape so a stored value is never orphaned. The backend
                     publish validator remains the enforcement. -->
                <el-option
                  v-if="userFields.length > 0 || step.sourceKind === 'form_field_user_manager'"
                  label="表单内联系人上级"
                  value="form_field_user_manager"
                />
                <el-option
                  v-if="userFields.length > 0 || step.sourceKind === 'form_field_user_dept_head'"
                  label="表单内联系人部门负责人"
                  value="form_field_user_dept_head"
                />
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
            <!-- Lock-1 §K4 (连续多级部门负责人) linear authoring: reuses the shared `levels`
                 field, same cap posture as continuous_managers. -->
            <el-form-item v-if="step.sourceKind === 'continuous_dept_heads'" label="部门负责人层级数">
              <el-input-number
                v-model="step.levels"
                :min="1"
                :max="10"
                :step="1"
                :disabled="readOnly"
                data-testid="approval-step-dept-head-levels"
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
            <!-- Lock-1 §K5-b (指定层级部门负责人) linear authoring: reuses the shared `level`
                 field, same shape/cap posture as manager_at_level (a single level, not a count). -->
            <el-form-item v-if="step.sourceKind === 'dept_head_at_level'" label="指定部门负责人层级">
              <el-input-number
                v-model="step.level"
                :min="1"
                :max="10"
                :step="1"
                :disabled="readOnly"
                data-testid="approval-step-dept-head-level"
              />
            </el-form-item>
            <!-- Lock-1 §K3 (节点审批人) linear authoring: a TYPED picker over the STRICTLY-EARLIER
                 steps only (never a free-text node key). The reference is stored as the earlier
                 step's stable localId, so insert/reorder can never silently retarget it; the
                 builder emits that step's current positional key at save. -->
            <el-form-item v-if="step.sourceKind === 'prior_node_approver'" label="引用审批步骤">
              <el-select
                v-model="step.priorStepLocalId"
                :disabled="readOnly"
                class="ms-w-100pct"
                placeholder="选择之前的审批步骤"
                data-testid="approval-step-prior-node"
              >
                <el-option
                  v-for="option in priorStepOptions(index)"
                  :key="option.localId"
                  :label="option.label"
                  :value="option.localId"
                />
              </el-select>
            </el-form-item>
            <!-- Lock-1 §K1 (用户组) linear authoring: a TYPED multi-select restricted to groups
                 BOUND to the template's org (never a free-text/raw-id input). Same picker source
                 as the canvas sub-form (directory.memberGroups). -->
            <el-form-item v-if="step.sourceKind === 'user_group'" label="选择用户组">
              <el-select
                v-model="step.groupIds"
                multiple
                filterable
                :disabled="readOnly"
                :loading="directory.memberGroupsLoading.value"
                class="ms-w-100pct"
                placeholder="选择已绑定的用户组"
                data-testid="approval-step-group-picker"
              >
                <el-option
                  v-for="group in directory.memberGroups.value"
                  :key="group.id"
                  :label="directory.formatMemberGroupLabel(group)"
                  :value="group.id"
                />
              </el-select>
              <p
                v-if="!readOnly && directory.memberGroups.value.length === 0 && !directory.memberGroupsLoading.value"
                class="template-authoring__hint template-authoring__hint--warn"
                data-testid="approval-step-group-empty"
              >当前组织尚无已绑定的可用用户组（需管理员先绑定用户组才能选择）</p>
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
                placeholder="搜索用户名 / 邮箱"
                data-testid="approval-step-user-picker"
                @update:model-value="(ids: string[]) => setStepIds(step, ids)"
                @visible-change="(visible: boolean) => visible && onUserSearch('')"
              >
                <el-option
                  v-for="user in directory.users.value"
                  :key="user.id"
                  :label="directoryUserDisplayLabel(user)"
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
                  :label="directoryRoleDisplayLabel(role)"
                  :value="role.id"
                />
              </el-select>
            </el-form-item>
            <el-form-item v-if="step.sourceKind === 'form_field_user'" label="表单用户字段">
              <el-select v-model="step.fieldId" :disabled="readOnly" class="ms-w-100pct" data-testid="approval-step-source-field">
                <el-option
                  v-for="field in userFields"
                  :key="field.id"
                  :label="fieldDisplayLabel(field)"
                  :value="field.id"
                />
              </el-select>
            </el-form-item>
            <!-- Lock-2 §L2-C (表单内联系人上级/部门负责人) linear authoring: typed field picker
                 over the form's user fields (never a raw field-id input) + a single level input,
                 reusing the shared `fieldId` and `level` draft fields. The hint discloses the
                 publish pins (required + no visibility rule) at authoring time. -->
            <template v-if="step.sourceKind === 'form_field_user_manager' || step.sourceKind === 'form_field_user_dept_head'">
              <el-form-item label="表单内联系人字段">
                <el-select v-model="step.fieldId" :disabled="readOnly" class="ms-w-100pct" data-testid="approval-step-contact-field">
                  <el-option
                    v-for="field in userFields"
                    :key="field.id"
                    :label="fieldDisplayLabel(field)"
                    :value="field.id"
                  />
                </el-select>
                <p class="template-authoring__hint" data-testid="approval-step-contact-field-hint">所选联系人字段须为必填且不带显示条件，发布时校验</p>
              </el-form-item>
              <el-form-item :label="step.sourceKind === 'form_field_user_manager' ? '指定联系人上级层级' : '指定联系人部门负责人层级'">
                <el-input-number
                  v-model="step.level"
                  :min="1"
                  :max="10"
                  :step="1"
                  :disabled="readOnly"
                  data-testid="approval-step-contact-level"
                />
              </el-form-item>
            </template>
            <!-- Lock-1 §K2 (提交人自选) linear authoring: mode + scope with typed pickers only
                 (the scope id list rides the shared idsText chip carrier via stepIds/setStepIds). -->
            <el-form-item v-if="step.sourceKind === 'requester_choice'" label="选择方式">
              <el-select v-model="step.requesterChoiceMode" :disabled="readOnly" class="ms-w-100pct" data-testid="approval-step-requester-choice-mode">
                <el-option label="单选（提交时选一人）" value="single" />
                <el-option label="多选（提交时可选多人）" value="multi" />
              </el-select>
            </el-form-item>
            <el-form-item v-if="step.sourceKind === 'requester_choice'" label="可选范围">
              <el-select
                :model-value="step.requesterChoiceScopeType"
                :disabled="readOnly"
                class="ms-w-100pct"
                data-testid="approval-step-requester-choice-scope"
                @update:model-value="(type: 'company' | 'members' | 'role') => setStepRequesterChoiceScopeType(step, type)"
              >
                <el-option label="全公司（任意成员）" value="company" />
                <el-option label="指定成员" value="members" />
                <el-option label="指定角色的成员" value="role" />
              </el-select>
            </el-form-item>
            <el-form-item
              v-if="step.sourceKind === 'requester_choice' && step.requesterChoiceScopeType === 'members'"
              label="可选成员"
            >
              <el-select
                :model-value="stepIds(step)"
                multiple
                filterable
                remote
                :remote-method="onUserSearch"
                :loading="directory.usersLoading.value"
                :disabled="readOnly"
                class="ms-w-100pct"
                placeholder="搜索用户名 / 邮箱"
                data-testid="approval-step-requester-choice-user-picker"
                @update:model-value="(ids: string[]) => setStepIds(step, ids)"
                @visible-change="(visible: boolean) => visible && onUserSearch('')"
              >
                <el-option
                  v-for="user in directory.users.value"
                  :key="user.id"
                  :label="directoryUserDisplayLabel(user)"
                  :value="user.id"
                />
              </el-select>
            </el-form-item>
            <el-form-item
              v-if="step.sourceKind === 'requester_choice' && step.requesterChoiceScopeType === 'role'"
              label="可选角色"
            >
              <el-select
                :model-value="stepIds(step)"
                multiple
                filterable
                :disabled="readOnly"
                class="ms-w-100pct"
                placeholder="选择角色"
                data-testid="approval-step-requester-choice-role-picker"
                @update:model-value="(ids: string[]) => setStepIds(step, ids)"
              >
                <el-option
                  v-for="role in directory.roles.value"
                  :key="role.id"
                  :label="directoryRoleDisplayLabel(role)"
                  :value="role.id"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="审批模式">
              <el-select v-model="step.approvalMode" :disabled="readOnly" class="ms-w-100pct">
                <el-option label="单人通过" value="single" />
                <el-option label="全部通过" value="all" />
                <el-option label="任一通过" value="any" />
                <!-- P1-C (T2-4 N-of-M / 门槛会签). Linear graphs are BY CONSTRUCTION never inside a
                     parallel region (the linear editor admits no `parallel` node), so this option is
                     always offered here — the backend's linear-only constraint is satisfied by
                     construction, not by a runtime gate (contrast the complex-graph editor, which
                     disables this option per-node). -->
                <el-option label="门槛会签（N 人同意）" value="threshold" data-testid="approval-step-mode-threshold-option" />
              </el-select>
            </el-form-item>
            <!-- P1-C: typed N-of-M control. M is resolved from this step's approver source at
                 runtime — this editor always emits `assigneeSources` (never the legacy shape the
                 backend's static publish bound is scoped to), so an unreachable N fails closed at
                 dispatch (APPROVAL_THRESHOLD_UNREACHABLE), never at save/publish; the hint says so
                 honestly rather than pretending to validate M here (M8). -->
            <el-form-item v-if="step.approvalMode === 'threshold'" label="通过所需人数（N）">
              <el-input-number
                :model-value="step.approvalThreshold"
                @update:model-value="(value: number | null) => { step.approvalThreshold = value ?? 1 }"
                :min="1"
                :step="1"
                :disabled="readOnly"
                data-testid="approval-step-threshold"
              />
              <p class="template-authoring__hint">
                需要 N 位不同审批人同意才通过；实际可用人数（M）由上方审批人来源在实例运行时解析，若解析结果不足 N 人，该节点会在运行时失败（而非发布时被拒绝）。
              </p>
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
          <!-- P1-C (T1-1) node-level SLA timeout. A linear graph is never inside a parallel region
               (see the mode-picker comment above), so this section renders unconditionally per step,
               no gating needed. -->
          <div class="template-authoring__approval-node-timeout" data-testid="approval-step-timeout-section">
            <el-form-item label="节点超时">
              <el-checkbox
                v-model="step.timeoutEnabled"
                :disabled="readOnly"
                data-testid="approval-step-timeout-enabled"
              >启用超时处理</el-checkbox>
            </el-form-item>
            <template v-if="step.timeoutEnabled">
              <el-form-item label="超时时长（分钟）">
                <el-input
                  v-model="step.timeoutAfterMinutesText"
                  :disabled="readOnly"
                  placeholder="例如 60"
                  data-testid="approval-step-timeout-after-minutes"
                />
              </el-form-item>
              <el-form-item label="超时后动作">
                <el-select v-model="step.timeoutEffect" :disabled="readOnly" class="ms-w-100pct" data-testid="approval-step-timeout-effect">
                  <!-- P1-C: ONLY the effects the scheduler actually acts on / publish accepts — never
                       'auto_approve'/'auto_reject' (reserved, M6/M8). -->
                  <el-option
                    v-for="effect in NODE_TIMEOUT_SUPPORTED_EFFECTS"
                    :key="effect"
                    :label="stepTimeoutEffectOptionLabel(effect)"
                    :value="effect"
                  />
                </el-select>
              </el-form-item>
              <el-form-item v-if="step.timeoutEffect === 'transfer'" label="转交给">
                <el-select
                  v-model="step.timeoutTransferToUserId"
                  filterable
                  remote
                  :remote-method="onUserSearch"
                  :loading="directory.usersLoading.value"
                  :disabled="readOnly"
                  class="ms-w-360"
                  placeholder="搜索用户名 / 邮箱"
                  data-testid="approval-step-timeout-transfer-target"
                  @visible-change="(visible: boolean) => visible && onUserSearch('')"
                >
                  <el-option
                    v-for="user in directory.users.value"
                    :key="user.id"
                    :label="directoryUserDisplayLabel(user)"
                    :value="user.id"
                  />
                </el-select>
              </el-form-item>
              <el-form-item v-else-if="step.timeoutEffect === 'jump'" label="跳转到节点">
                <!-- Business labels only — never a raw step key/id in the option text (M8). -->
                <el-select
                  v-model="step.timeoutJumpToStepLocalId"
                  :disabled="readOnly"
                  class="ms-w-240"
                  placeholder="选择目标审批节点"
                  data-testid="approval-step-timeout-jump-target"
                >
                  <el-option
                    v-for="option in timeoutJumpStepOptions(step.localId)"
                    :key="option.localId"
                    :label="option.label"
                    :value="option.localId"
                  />
                </el-select>
              </el-form-item>
              <el-form-item label="计时方式">
                <div class="approval-node-source-roster" role="radiogroup" aria-label="计时方式" data-testid="approval-step-timeout-unit">
                  <label class="approval-node-source-roster-option">
                    <input
                      type="radio"
                      :name="`approval-step-timeout-unit-${step.localId}`"
                      :checked="step.timeoutUnit !== 'business'"
                      :disabled="readOnly"
                      data-testid="approval-step-timeout-unit-wall-clock"
                      @change="() => { step.timeoutUnit = '' }"
                    />
                    <span>自然时间</span>
                  </label>
                  <label class="approval-node-source-roster-option">
                    <input
                      type="radio"
                      :name="`approval-step-timeout-unit-${step.localId}`"
                      :checked="step.timeoutUnit === 'business'"
                      :disabled="readOnly"
                      data-testid="approval-step-timeout-unit-business"
                      @change="() => { step.timeoutUnit = 'business' }"
                    />
                    <span>工作时间</span>
                  </label>
                </div>
              </el-form-item>
            </template>
          </div>
          <!-- T1-4 node field permissions: per-form-field access at this approval node. `隐藏` and
               `只读` are BOTH enforced server-side (Lock-7 P4-B: 隐藏 redacts the read echo + blocks a
               write; 只读 blocks a write at this node). A field left `可编辑` carries no persisted
               entry (absent === editable). -->
          <div class="template-authoring__field-perms" data-testid="approval-step-field-permissions">
            <div class="template-authoring__field-perms-head">
              <strong>字段权限</strong>
              <span class="template-authoring__hint">
                「隐藏」在审批到该节点时对所有查看者隐藏该字段（仅回显隐藏，不影响审批人解析与条件路由）；「只读」表示该字段在本节点仅可查看、不可编辑。字段默认为「可编辑」。
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
              <span class="template-authoring__field-perm-label">{{ fieldDisplayLabel(field) }}</span>
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
                v-if="stepFieldAccess(step, field.id) === 'hidden' && routingDriverFieldIds.has(field.id)"
                class="template-authoring__hint template-authoring__hint--warn"
                data-testid="approval-step-field-routing-hint"
              >该字段被审批人来源引用；隐藏仅影响回显，不影响审批人解析</span>
            </div>
          </div>
        </div>
      </el-card>

      <!-- P3-B / Lock-6 L6-A (docs/development/approval-lock6-requester-global-policy-20260817.md §1,
           §2.7) — the fifth wizard step. M7 (master §4 P3-B exit): this step is authorized ONLY because
           it now carries one REAL, server-enforced control (the template-level dedup tier); it does not
           exist as an empty/disabled shell. The tier is an immediate-apply typed control — no separate
           Save/Cancel transaction, matching the D0 grammar the rest of this view already uses (e.g.
           `draft.allowRevoke` above). -->
      <el-card v-show="activeAuthoringSection === 'more-settings'" class="template-authoring__panel" shadow="never">
        <template #header>
          <strong>更多设置</strong>
        </template>
        <el-form label-position="top" class="template-authoring__grid">
          <el-form-item label="审批人去重" class="template-authoring__wide">
            <!-- L6-A shape (Lock-4 OD-L4-6(a)): a 3-way tier projected over the two ALREADY
                 server-enforced booleans `dedupeHistoricalApprover` / `mergeAdjacentApprover` on
                 `runtimeGraph.policy.autoApproval` — no new engine behavior, no new contract field.
                 M8 honesty: labels name the EXACT shipped predicate (§1 L6-A / Lock-4 F4-D), not the
                 corpus's broader "撤回撤销" framing this product does not implement. -->
            <el-radio-group
              v-model="draft.autoApprovalDedupTier"
              :disabled="readOnly || isAutoApprovalDedupTierLocked"
              data-testid="approval-template-dedup-tier"
            >
              <el-radio value="none" data-testid="approval-template-dedup-tier-none">
                不去重
              </el-radio>
              <el-radio value="dedupe_historical" data-testid="approval-template-dedup-tier-dedupe-historical">
                仅一次全自动同意
              </el-radio>
              <el-radio value="merge_adjacent" data-testid="approval-template-dedup-tier-merge-adjacent">
                仅连续节点自动同意
              </el-radio>
            </el-radio-group>
            <p class="template-authoring__hint">
              同一审批人在流程中再次出现时按所选规则自动通过该节点，无需重复处理；仅对未单独设置去重规则的审批节点生效，返回上一节点后该节点重新计入本轮去重历史。
            </p>
            <!-- M8 honesty (adversarial-gate P3-1, PR #4967): mergeAdjacentApprover has a second,
                 real server effect beyond the dedup cascade — it also exempts the graph from two
                 publish-time duplicate-assignee checks for a parallel gateway (the static branch
                 check `allowParallelDuplicateAssignees` and the dynamic-source preflight
                 `assertNoParallelDynamicAssigneeConflicts`, ApprovalProductService.ts:4595/:4623-4625),
                 because the merge machinery legitimately absorbs the same-approver overlap at
                 runtime instead of leaving it to 409. Undisclosed, an admin could not know why a
                 previously-rejected parallel graph now publishes. Scoped to the ACTUAL exemption
                 (parallel branches only) — no other semantic invented. -->
            <p
              v-if="draft.autoApprovalDedupTier === 'merge_adjacent'"
              class="template-authoring__hint"
              data-testid="approval-template-dedup-tier-merge-adjacent-hint"
            >
              选择该项还会放宽并行分支的发布校验：同一审批人出现在同一并行网关的多个分支中不再阻止发布，运行时会自动跳过重复分支的指派。
            </p>
            <p
              v-if="isAutoApprovalDedupTierLocked"
              class="template-authoring__hint template-authoring__hint--warn"
              data-testid="approval-template-dedup-tier-locked-hint"
            >
              当前已通过接口设置了本控件无法表达的去重组合，已保持只读并原样保留，不会被此处的选择覆盖。
            </p>
          </el-form-item>
        </el-form>
      </el-card>

      <!-- D1 ordinary-user hygiene: JSON formSchema/approvalGraph preview removed from the review
           step. Payload builders are unchanged; try-run remains the user-facing dry-run surface. -->

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
              placeholder="搜索用户名 / 邮箱（可留空）"
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
              :label="fieldDisplayLabel(field)"
              data-testid="approval-template-tryrun-field"
            >
              <!-- text -->
              <el-input
                v-if="field.type === 'text'"
                v-model="sampleFormData[field.id]"
                :placeholder="field.placeholder || `请输入${fieldDisplayLabel(field)}`"
              />
              <!-- textarea -->
              <el-input
                v-else-if="field.type === 'textarea'"
                v-model="sampleFormData[field.id]"
                type="textarea"
                :rows="2"
                :placeholder="field.placeholder || `请输入${fieldDisplayLabel(field)}`"
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
                :placeholder="field.placeholder || `请选择${fieldDisplayLabel(field)}`"
                class="ms-w-100pct"
              />
              <!-- datetime -->
              <el-date-picker
                v-else-if="field.type === 'datetime'"
                v-model="sampleFormData[field.id]"
                type="datetime"
                :placeholder="field.placeholder || `请选择${fieldDisplayLabel(field)}`"
                class="ms-w-100pct"
              />
              <!-- select -->
              <el-select
                v-else-if="field.type === 'select'"
                v-model="sampleFormData[field.id]"
                :placeholder="field.placeholder || `请选择${fieldDisplayLabel(field)}`"
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
                :placeholder="field.placeholder || `请选择${fieldDisplayLabel(field)}`"
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
              {{ fieldDisplayLabel(field) }}：{{ sampleFieldUnsupportedReason(field) }}
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
                <span class="template-authoring__tryrun-hidden-label">{{ fieldDisplayLabel(entry.field) }}</span>
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
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch, type CSSProperties } from 'vue'
import PageShell from '../../components/layout/PageShell.vue'
import PageHeader from '../../components/layout/PageHeader.vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { Plus } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useApprovalPermissions } from '../../approvals/permissions'
import { useFeatureFlags } from '../../stores/featureFlags'
import { summarizeConditionBranch } from '../../approvals/conditionSummary'
import {
  createTemplate,
  dryRunApprovalConditionFormula,
  getTemplate,
  previewTemplateRoute,
  publishTemplate,
  updateTemplate,
  type ApprovalRoutePreview,
} from '../../approvals/api'
import { describeTemplateAuthoringError } from '../../approvals/templateAuthoringErrors'
import { createRoutePreviewController } from '../../approvals/routePreviewController'
import { routePreviewAssigneeSummary } from '../../approvals/routePreviewSummary'
import { describeRoutePreviewError } from '../../approvals/routePreviewErrors'
import { computeRequesterPreviewFields } from '../../approvals/requesterPreviewFields'
import { buildLinearStepSpine, type LinearStepSpineChip } from '../../approvals/linearStepSpine'
import ApprovalUserPicker from '../../approvals/components/ApprovalUserPicker.vue'
import ApprovalFormInlineEditor from '../../approvals/components/ApprovalFormInlineEditor.vue'
import ApprovalFormBuilder from '../../approvals/components/ApprovalFormBuilder.vue'
import ApprovalFormPalette from '../../approvals/components/ApprovalFormPalette.vue'
import { createApprovalFormDragSession } from '../../approvals/approvalFormDragPayload'
import ApprovalGraphNodeConfigEditor from '../../approvals/components/ApprovalGraphNodeConfigEditor.vue'
import ApprovalFlowCanvas from '../../approvals/components/ApprovalFlowCanvas.vue'
import ApprovalCanvasNodeInspector from '../../approvals/components/ApprovalCanvasNodeInspector.vue'
import {
  APPROVAL_NODE_CONFIG_EDITOR_KEY,
  type ApprovalNodeConfigEditorApi,
} from '../../approvals/nodeConfigEditorContext'
import {
  buildApprovalGraph,
  buildCreateTemplatePayload,
  buildFormSchema,
  buildPublishPolicy,
  buildSlaHours,
  buildUpdateTemplatePayload,
  createEmptyDetailColumnDraft,
  createEmptyFieldDraft,
  type AuthorableFieldType,
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
  validateTemplateBasicInfo,
  collectTemplateSaveMinimum,
  seedDraftIdentityForSave,
  type AuthoringValidationIssue,
  placeholderRoleNodeKeys,
  isPlaceholderRoleSource,
  addAssigneeSourceCard,
  removeAssigneeSourceCard,
  legalPriorApproverNodeKeys,
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
  moveItemToIndex,
  isTemplateDedupTierLocked,
} from '../../approvals/templateAuthoring'
import {
  addConditionBranch,
  addParallelBranch,
  adjacentLinearNodeMoveTarget,
  appendApprovalNode,
  appendCcNode,
  appendHandlerNode,
  collectParallelRegionNodeKeys,
  insertConditionGateway,
  insertParallelGateway,
  linearNodeMoveTargets,
  removeLinearNode,
} from '../../approvals/graphTopologyEdit'
import {
  applyCanvasCommandToSession,
  applyTopologyOpToSession,
  canRedoAuthoring,
  canUndoAuthoring,
  createAuthoringSessionHistory,
  draftFromSessionGraph,
  promoteLinearDraftToGraphAuthoring,
  redoAuthoringSession,
  reseedAuthoringSessionHistory,
  undoAuthoringSession,
  type AuthoringSessionHistory,
} from '../../approvals/approvalAuthoringHistory'
import {
  canRedoFormHistory,
  canUndoFormHistory,
  createFormAuthoringHistory,
  pushFormSnapshot,
  redoFormHistory,
  undoFormHistory,
  type FormAuthoringHistory,
} from '../../approvals/approvalFormAuthoringHistory'
import type { ApprovalCanvasSelection } from '../../approvals/approvalCanvasCommands'
import {
  computeLayout,
  graphValidityIssues,
  GRAPH_LAYOUT_NODE_HEIGHT,
  GRAPH_LAYOUT_NODE_WIDTH,
  type GraphLayout,
} from '../../approvals/graphLayout'
import {
  computeMinimapFrame,
  fitCanvasZoom,
  stepCanvasZoom,
} from '../../approvals/canvasViewport'
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
  HandlerMode,
  FormField,
  NodeFieldAccess,
  NodeTimeoutConfig,
  ParallelJoinMode,
  ParallelNodeConfig,
  SupportedNodeTimeoutEffect,
} from '../../types/approval'
import { NODE_TIMEOUT_MAX_AFTER_MINUTES, NODE_TIMEOUT_SUPPORTED_EFFECTS } from '../../types/approval'
import { useApprovalDirectory } from '../../approvals/useApprovalDirectory'
import { assigneeSourceSummary } from '../../approvals/assigneeSource'
import {
  buildRecordLinkBaseSelectOptions,
  buildRecordLinkSheetSelectOptions,
  dateRangeVisibilityEndpointOptions,
  dateRangeVisibilityFieldId,
  visibilityReferenceBaseFieldId,
  type RecordLinkNamedOption,
} from '../../approvals/recordLinkField'
import { multitableClient } from '../../multitable/api/client'

const route = useRoute()
const router = useRouter()
const { canManageTemplates } = useApprovalPermissions()
const { features: productFeatures } = useFeatureFlags()
const canvasV2Enabled = computed(() => productFeatures.value.approvalCanvasV2 === true)

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

// ── F4 production mount (delta §5 F4, FB-D8) ──
// The hardened Designer 2.0 builder mounts behind the EXISTING `approvalCanvasV2` flag — no new
// flag (FB-D8). `formSessionHydrated` gates the mount on top of the flag: `ApprovalFormBuilder`
// seeds its session ONCE, synchronously, from `props.draft` at component creation (F1/F2 — the
// component never re-seeds from a later prop change), so mounting it before `loadTemplateForEdit`
// resolves the real draft would permanently strand the session on the empty placeholder. Both
// `showFormBuilderV2` inputs only ever transition false→true for the life of one view instance:
// `canvasV2Enabled` is a stable session-scoped flag value and `formSessionHydrated` is set once in
// `loadTemplateForEdit` and never reset — so `showFormBuilderV2` cannot flip back to false, and the
// `v-if` mount is NOT re-evaluated by ordinary editing/tab-switching (the outer step chrome uses
// v-show, not v-if — see `activeAuthoringSection` above). `formBuilderSessionEpoch` is the ONLY
// thing that remounts (reseeds) the builder, and it is bumped ONLY at the three existing
// server-round-trip points (`persistDraft` update/create, `createFromPreset`) that already call
// `reseedFormHistoryFromDraft()` for the legacy history stack — never on routine field edits.
const formSessionHydrated = ref(false)
const formBuilderSessionEpoch = ref(0)
const showFormBuilderV2 = computed(() => canvasV2Enabled.value && formSessionHydrated.value)
/** Shared transient drag session (palette <-> builder), created once per view instance. */
const approvalFormDragSession = createApprovalFormDragSession()
interface ApprovalFormBuilderExposed {
  getDragSession(): ReturnType<typeof createApprovalFormDragSession>
  appendField(type: AuthorableFieldType): boolean
  undo(): boolean
  redo(): boolean
  canUndo(): boolean
  canRedo(): boolean
}
const formBuilderRef = ref<ApprovalFormBuilderExposed | null>(null)
const builderCanUndo = ref(false)
const builderCanRedo = ref(false)

/** Refresh the toolbar's undo/redo enabled state after a builder-originated commit. */
function refreshFormBuilderHistoryFlags(): void {
  builderCanUndo.value = formBuilderRef.value?.canUndo() ?? false
  builderCanRedo.value = formBuilderRef.value?.canRedo() ?? false
}

/**
 * The v2 builder is the SINGLE writer of `draft.value` while mounted (FB-D4): every add / move /
 * remove / retype / property-update / undo / redo commit re-emits the CURRENT draft here so the
 * rest of the view (save/publish payload, header field count, dirty-check) stays in sync — a
 * commit that never reached `draft.value` would be silently unsaved (M8).
 */
function onFormBuilderDraftChange(nextDraft: TemplateAuthoringDraft, focusLocalId: string | null): void {
  draft.value = nextDraft
  formFieldFocusLocalId.value = focusLocalId
  refreshFormBuilderHistoryFlags()
}

/** Deliberate resync after a genuine server round-trip (save/create/preset) — NOT a routine reseed. */
function reseedFormBuilderSessionIfActive(): void {
  if (!showFormBuilderV2.value) return
  formBuilderSessionEpoch.value += 1
  builderCanUndo.value = false
  builderCanRedo.value = false
}

/** Palette click path (§3.1): append via the SAME ONE adapter the builder's own drag/slot paths use. */
function onFormBuilderPaletteAppend(type: AuthorableFieldType): void {
  formBuilderRef.value?.appendField(type)
}

function onFormUndoRedoClick(direction: 'undo' | 'redo'): void {
  if (readOnly.value) return
  if (showFormBuilderV2.value) {
    if (direction === 'undo') formBuilderRef.value?.undo()
    else formBuilderRef.value?.redo()
    return
  }
  if (direction === 'undo') onFormFieldUndo()
  else onFormFieldRedo()
}

// FWB-0 Layer 2: typed base/sheet catalog for record-link authoring (IDs persist on the draft,
// never shown as ordinary free-text labels). Loaded via MultitableApiClient listBases/listSheets.
const recordLinkBases = ref<RecordLinkNamedOption[]>([])
const recordLinkSheets = ref<Array<RecordLinkNamedOption & { baseId?: string | null }>>([])
const recordLinkCatalogLoading = ref(false)
/** True only after a successful catalog fetch — failure must not sticky-block retry. */
const recordLinkCatalogLoaded = ref(false)
/** Values-free catalog failure message (empty when ok / idle). */
const recordLinkCatalogError = ref('')

async function ensureRecordLinkCatalog(force = false): Promise<void> {
  if (!force && (recordLinkCatalogLoaded.value || recordLinkCatalogLoading.value)) return
  if (force && recordLinkCatalogLoading.value) return
  recordLinkCatalogLoading.value = true
  recordLinkCatalogError.value = ''
  try {
    const [basesRes, sheetsRes] = await Promise.all([
      multitableClient.listBases(),
      multitableClient.listSheets(),
    ])
    recordLinkBases.value = (basesRes.bases ?? []).map((b) => ({
      id: b.id,
      name: b.name ?? '',
    }))
    recordLinkSheets.value = (sheetsRes.sheets ?? []).map((s) => ({
      id: s.id,
      name: s.name ?? '',
      baseId: s.baseId ?? null,
    }))
    recordLinkCatalogLoaded.value = true
    recordLinkCatalogError.value = ''
  } catch {
    // Do NOT set loaded=true — failure must remain retriable for the page lifetime.
    recordLinkBases.value = []
    recordLinkSheets.value = []
    recordLinkCatalogLoaded.value = false
    recordLinkCatalogError.value = '关联表目录加载失败，请重试'
  } finally {
    recordLinkCatalogLoading.value = false
  }
}

function retryRecordLinkCatalog(): void {
  void ensureRecordLinkCatalog(true)
}

const recordLinkCatalogValidation = computed(() => ({
  loaded: recordLinkCatalogLoaded.value,
  sheets: recordLinkSheets.value,
}))

function recordLinkBaseOptionsFor(field: FieldAuthoringDraft) {
  return buildRecordLinkBaseSelectOptions(recordLinkBases.value, field.recordLinkBaseId)
}

function recordLinkSheetOptionsFor(field: FieldAuthoringDraft) {
  return buildRecordLinkSheetSelectOptions(
    recordLinkSheets.value,
    field.recordLinkBaseId,
    field.recordLinkSheetId,
  )
}

function onRecordLinkBaseChange(field: FieldAuthoringDraft, value: string | null | undefined): void {
  const next = typeof value === 'string' ? value.trim() : ''
  field.recordLinkBaseId = next
  // Changing base invalidates a sheet pin that no longer belongs to the new base.
  if (field.recordLinkSheetId.trim()) {
    const sheetStillValid = recordLinkSheets.value.some(
      (s) => s.id === field.recordLinkSheetId.trim()
        && (typeof s.baseId === 'string' ? s.baseId.trim() : '') === next,
    )
    if (!sheetStillValid) field.recordLinkSheetId = ''
  }
}

function onRecordLinkSheetChange(field: FieldAuthoringDraft, value: string | null | undefined): void {
  field.recordLinkSheetId = typeof value === 'string' ? value.trim() : ''
}

/** Load the multitable catalog whenever the draft contains a record-link field. */
watch(
  () => draft.value.fields.some((field) => field.type === 'record-link'),
  (hasRecordLink) => {
    if (hasRecordLink) void ensureRecordLinkCatalog()
  },
  { immediate: true },
)

// P3-B / Lock-6 §2.7 (docs/development/approval-lock6-requester-global-policy-20260817.md):
// "Activation is a typed change to the AuthoringSectionId union and the authoringSections array
// ... performed by the SAME PR that lands the functional L6-A control". This PR lands the L6-A
// dedup-tier control (below) in the SAME commit as this activation — the fifth step, `更多设置`,
// is never an empty/disabled shell (master M7); it exists BECAUSE the tier control it hosts is now
// real and server-enforced. `测试发布` stays last, unconditionally.
type AuthoringSectionId = 'basic' | 'fields' | 'flow' | 'more-settings' | 'review'
const authoringSections: Array<{
  id: AuthoringSectionId
  label: string
  description: string
}> = [
  { id: 'basic', label: '基础信息', description: '名称、范围与模板起点' },
  { id: 'fields', label: '表单设计', description: '字段、校验与显隐规则' },
  { id: 'flow', label: '流程设计', description: '审批人、分支与字段权限' },
  { id: 'more-settings', label: '更多设置', description: '审批人去重等模板级策略' },
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
const conditionFormulaDryRunResults = ref<Record<string, string>>({})
const conditionFormulaDryRunBusy = ref<Record<string, boolean>>({})

const templateId = computed(() => typeof route.params.id === 'string' ? route.params.id : '')
const isEditMode = computed(() => templateId.value.length > 0)
// P1-D (master §4 UI-3/UI-9 — editor version entry, parent-lock §9/:276 gap): a compact link to the
// existing TemplateDetailView.vue "版本历史" section (`data-testid="template-detail-version-history"`).
// PRESENTATION ONLY — no new version storage, no route-preview toggle (that stays Lock-0 L0-5 debt,
// not this slice). `latestVersionId` is read straight off the loaded/updated template DTO (never
// folded into `draft`, so it can never leak into a save payload) purely to gate "saved template WITH
// at least one recorded version" — a brand-new unsaved draft has neither an id nor a version yet.
const templateLatestVersionId = ref<string | null>(null)
const hasSavedVersionHistory = computed(() => isEditMode.value && Boolean(templateLatestVersionId.value))
function goToVersionHistory(): void {
  if (!templateId.value) return
  router.push({ path: `/approval-templates/${templateId.value}` })
}
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

// P1-A0 (master §4 UI-0 "live validation count"; Lock-0 L0-3 typed-issue-record delta, scoped to
// the 基础信息 step only — the parent-lock header count over the FULL publishChecklist stays
// undelivered L0-5-adjacent debt, tracked separately, and is NOT what this badge claims to be).
// Typed source of truth; the step-nav badge below reads `.length` off this array — it never
// hand-counts or hardcodes a number.
const basicInfoIssues = computed<AuthoringValidationIssue[]>(() => (
  validateTemplateBasicInfo(draft.value, unsupportedReason.value)
))
const basicInfoIssueCount = computed<number>(() => basicInfoIssues.value.length)

// P3-B / Lock-6 §2.6, gate X-1 — a persisted template with BOTH dedup booleans true is a
// combination the 3-way tier cannot express. Reads the HYDRATED `originalPolicy`, not the
// projected `draft.autoApprovalDedupTier`, so the lock state is derived from the actual persisted
// definition every time, not from whatever the radio group last rendered.
const isAutoApprovalDedupTierLocked = computed<boolean>(() => (
  isTemplateDedupTierLocked(draft.value.originalPolicy?.autoApproval)
))

function scrollAuthoringTarget(target: HTMLElement | null, focus = false) {
  if (!target) return
  if (focus) target.focus({ preventScroll: true })
  target.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
}

async function selectAuthoringSection(section: AuthoringSectionId) {
  activeAuthoringSection.value = section
  // Canvas V2: ordinary-user flow authoring uses one preservedGraph rail. Promote linear steps
  // when entering the flow step so linear + branch share the canvas surface; list remains the
  // retained accessible alternative (辅助编辑模式).
  if (section === 'flow' && canvasV2Enabled.value && !readOnly.value && !draft.value.preservedGraph) {
    draft.value = promoteLinearDraftToGraphAuthoring(draft.value)
    reseedCanvasHistoryFromDraft()
    canvasViewMode.value = 'canvas'
  }
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
  // Lock-3 §1.5 — handler (办理) node card label.
  handler: '办理',
  end: '结束',
}
function nodeTypeLabel(type: string): string {
  return NODE_TYPE_LABELS[type] ?? type
}

function canvasNodeCardSummary(nodeKey: string): string {
  const node = canvasNodeByKey(nodeKey)
  if (!node) return '点击配置'
  if (node.type === 'start') return '可设置提交人'
  if (node.type === 'end') return '可设置抄送'
  const lines = nodeConfigSummary(node)
  return lines[0] || '点击配置'
}

// `assigneeSourceSummary` (single-source label) now lives in `../../approvals/assigneeSource` —
// UX B2-08 reuses it from the approval detail view's "upcoming nodes" preview, so it moved to a
// shared module instead of staying private here. Imported above; behavior is unchanged.

// One read-only descriptor per node config, covering ALL three complex types (condition / parallel
// / cc) plus approval — so no type silently renders as "unsupported". Returns `[]` for nodes
// without summarisable config (start/end).
function fieldDisplayLabel(field: { label?: string | null }): string {
  const label = field.label?.trim()
  return label ? label : '未命名字段'
}

/** Ordinary-user directory labels never fall back to the raw directory id. */
function directoryUserDisplayLabel(user: { name?: string | null; email?: string | null }): string {
  const name = user.name?.trim()
  const email = user.email?.trim()
  if (name) return email ? `${name} · ${email}` : name
  return email || '未知用户'
}

function directoryRoleDisplayLabel(role: { name?: string | null }): string {
  const name = role.name?.trim()
  return name || '未知角色'
}

function graphNodeDisplayName(nodeKey: string | null | undefined): string {
  if (!nodeKey) return '（无）'
  const node = draft.value.preservedGraph?.nodes.find((entry) => entry.key === nodeKey)
  return node?.name?.trim() || '（未命名节点）'
}

/** D1 hygiene: resolve a parallel fork edge key to its target node name (never show the raw key). */
function parallelBranchLabels(node: ApprovalNode): string {
  const cfg = node.config as ParallelNodeConfig
  const branches = cfg.branches ?? []
  if (branches.length === 0) return '（无）'
  const edges = draft.value.preservedGraph?.edges ?? []
  return branches.map((edgeKey, index) => {
    const edge = edges.find((entry) => entry.key === edgeKey)
    if (edge?.target) return graphNodeDisplayName(edge.target)
    return `分支 ${index + 1}`
  }).join('、')
}

/**
 * D1 ordinary-user edge-key label for the default-branch picker.
 * Prefer the matching branch's readable predicate, else the edge's target node name.
 * Value binding stays the raw edgeKey (payload unchanged).
 */
function conditionDefaultEdgeLabel(conditionNodeKey: string, edgeKey: string): string {
  const edit = conditionEditFor(conditionNodeKey)
  const branch = edit?.branches.find((entry) => entry.edgeKey === edgeKey)
  if (branch) {
    const summary = liveBranchSummary(branch)
    if (summary && summary !== '（无规则）') return summary
  }
  const edge = draft.value.preservedGraph?.edges.find((entry) => entry.key === edgeKey)
  if (edge?.target) return graphNodeDisplayName(edge.target)
  return '默认分支'
}

function nodeConfigSummary(node: ApprovalNode): string[] {
  const config = node.config as Record<string, unknown>
  if (node.type === 'condition') {
    const cfg = config as unknown as ConditionNodeConfig
    const schema = buildFormSchema(draft.value)
    // D1 hygiene: readable predicates only — no edge-key secondary provenance in ordinary DOM.
    const lines = (cfg.branches ?? []).map(
      (branch) => `分支「${summarizeConditionBranch(branch, schema)}」`,
    )
    if (cfg.defaultEdgeKey) {
      const edge = draft.value.preservedGraph?.edges.find((entry) => entry.key === cfg.defaultEdgeKey)
      lines.push(`默认分支 → ${edge?.target ? graphNodeDisplayName(edge.target) : '（已配置）'}`)
    }
    return lines
  }
  if (node.type === 'parallel') {
    const cfg = config as unknown as ParallelNodeConfig
    return [
      `并行分支：${parallelBranchLabels(node)}`,
      `汇聚节点：${graphNodeDisplayName(cfg.joinNodeKey)}`,
      `汇聚模式：${cfg.joinMode ?? '（无）'}`,
    ]
  }
  if (node.type === 'cc') {
    const cfg = config as unknown as CcNodeConfig
    // H2: CC still has no directory picker — targetIds remain the only carrier. Show type only
    // so ordinary DOM does not dump raw assignee IDs; the editable picker still holds the values.
    return [
      `抄送类型：${cfg.targetType === 'role' ? '角色' : '用户'}`,
      `抄送对象：${(cfg.targetIds ?? []).length ? `已选 ${(cfg.targetIds ?? []).length} 个` : '（无）'}`,
    ]
  }
  if (node.type === 'approval') {
    const sources = Array.isArray(config.assigneeSources) ? config.assigneeSources as ApprovalAssigneeSource[] : []
    // Prefer human labels; for static_user/static_role avoid dumping raw id lists in read-only rows
    // (typed pickers own those values when the node is editable).
    const lines = sources.map((source) => {
      if (source.kind === 'static_user') {
        const count = source.userIds?.length ?? 0
        return `审批人：指定用户${count ? `（${count} 人）` : '（无）'}`
      }
      if (source.kind === 'static_role') {
        const count = source.roleIds?.length ?? 0
        return `审批人：指定角色${count ? `（${count} 个）` : '（无）'}`
      }
      if (source.kind === 'form_field_user') {
        const field = draft.value.fields.find((entry) => entry.id === source.fieldId)
        return `审批人：表单用户字段：${field ? fieldDisplayLabel(field) : '（未选）'}`
      }
      return `审批人：${assigneeSourceSummary(source)}`
    })
    // P1-C: business labels only — never a raw effect enum, user id, or node key (master §P1-C
    // G1-p exit bullet 4).
    const approvalConfig = config as { approvalMode?: ApprovalMode; approvalThreshold?: number; timeout?: NodeTimeoutConfig }
    if (approvalConfig.approvalMode === 'threshold' && Number.isInteger(approvalConfig.approvalThreshold)) {
      lines.push(`审批模式：门槛会签（需 ${approvalConfig.approvalThreshold} 人同意）`)
    }
    if (approvalConfig.timeout) {
      const effectLabel = nodeTimeoutEffectLabel(approvalConfig.timeout.effect)
      if (effectLabel) lines.push(`节点超时：${approvalConfig.timeout.afterMinutes} 分钟后${effectLabel}`)
    }
    return lines
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

// Field options for a rule's fieldId picker — exclude record-link/detail (server v1 reject).
// Lock-8 L8-B OD-L8-5(c) [accepted residual]: date_range is excluded from graph condition rules
// ENTIRELY (unlike visibility rules, which admit its .start/.end endpoints — see
// visibilityFieldOptions below) — its `{start,end}` value has no per-type predicate for MS-9 in
// this slice, and `validateConditionEdits` (conditionEdit.ts) rejects any rule that references one.
// Offering it here would be an M7 inert control: always selectable, never publishable.
// Lock-8 L8-A (§1.1): explanation carries no value at all — excluded the same way, an M7 inert
// control would otherwise always fail publish (`validateConditionEdits` rejects any rule
// referencing one).
const conditionFieldOptions = computed(() =>
  draft.value.fields
    .filter((field) => (
      field.id.trim()
      && field.type !== 'record-link'
      && field.type !== 'detail'
      && field.type !== 'date_range'
      && field.type !== 'explanation'
    ))
    .map((field) => ({ id: field.id.trim(), label: fieldDisplayLabel(field) })),
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
// D1 values-first: dry-run reads the same typed 试运行 sampleFormData (no per-branch JSON parse).
async function dryRunConditionFormula(nodeKey: string, branch: ConditionBranchEdit): Promise<void> {
  const expression = branch.formulaExpression.trim()
  if (!expression) {
    setConditionFormulaDryRunResult(nodeKey, branch.edgeKey, '请输入公式')
    return
  }
  const formData: Record<string, unknown> = { ...sampleFormData.value }
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

function graphNodeLabel(nodeKey: string): string {
  const node = canvasEffectiveGraph.value.nodes.find((candidate) => candidate.key === nodeKey)
  if (!node) return '流程节点'
  return node.name?.trim() || nodeTypeLabel(node.type)
}

// Lock-1 §K3 — the LEGAL candidates for a prior_node_approver picker on `nodeKey`'s card:
// approval nodes strictly upstream on every runtime-reachable path of the LIVE effective graph
// (`legalPriorApproverNodeKeys`, the FE mirror of the backend publish dominance gate — which
// stays the sole arbiter). Labels reuse `graphNodeLabel` (template-authored names, never ids).
function priorApproverNodeOptions(nodeKey: string): Array<{ key: string; label: string }> {
  return legalPriorApproverNodeKeys(canvasEffectiveGraph.value, nodeKey)
    .map((key) => ({ key, label: graphNodeLabel(key) }))
}

// Lock-1 §K3 — the linear editor's picker candidates for step `index`: the STRICTLY-EARLIER
// steps only (referenced by stable localId; the builder emits the referenced step's current
// positional key at save — see ApprovalStepDraft.priorStepLocalId).
function priorStepOptions(index: number): Array<{ localId: string; label: string }> {
  return draft.value.steps.slice(0, index).map((candidate, candidateIndex) => ({
    localId: candidate.localId,
    label: candidate.name.trim() || `审批人 ${candidateIndex + 1}`,
  }))
}

function graphEdgeTargetLabel(nodeKey: string, edgeKey: string): string {
  const edge = canvasEffectiveGraph.value.edges.find(
    (candidate) => candidate.source === nodeKey && candidate.key === edgeKey,
  )
  return edge ? graphNodeLabel(edge.target) : '流程分支'
}

function conditionEdgeLabel(nodeKey: string, edgeKey: string): string {
  const branch = conditionEditFor(nodeKey)?.branches.find((candidate) => candidate.edgeKey === edgeKey)
  return branch ? liveBranchSummary(branch) : graphEdgeTargetLabel(nodeKey, edgeKey)
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
// (index 1+) are preserved verbatim. Shared with the canvas inspector via provide/inject.
function approvalNodeEditFor(nodeKey: string): ApprovalNodeSourceEdit | undefined {
  return draft.value.approvalNodeEdits?.[nodeKey]
}
// P1-B: replaces the old assigneeSources[0]-only accessor — every card is addressed by its own
// sourceIndex now (see nodeConfigEditorContext.ts's doc comment on the required-index posture).
function approvalNodeSourceAt(nodeKey: string, sourceIndex: number): ApprovalAssigneeSource | undefined {
  return approvalNodeEditFor(nodeKey)?.assigneeSources[sourceIndex]
}
function approvalNodeMode(nodeKey: string): ApprovalMode {
  return approvalNodeEditFor(nodeKey)?.approvalMode ?? 'single'
}
function setApprovalNodeMode(nodeKey: string, mode: ApprovalMode): void {
  const edit = approvalNodeEditFor(nodeKey)
  if (!edit) return
  // P1-C linear-only fail-closed floor, defense-in-depth: the mode picker must not OFFER 'threshold'
  // inside a parallel region (see the `:disabled` option below); this guard covers a caller that
  // bypasses that render-layer gate (e.g. a forced DOM event past the disabled option, or a future
  // non-select entry point). CORRECTION (fix-round gate P2-2): this is NOT the invariant's actual
  // enforcement point for SAVE — that is `validateApprovalNodeEdits`'s `inParallelRegion` check
  // (approvalNodeEdit.ts), wired end-to-end from `draft.preservedGraph` in
  // `validateTemplateApprovalFlow`, which blocks `validate()`/`persistDraft` regardless of whether
  // this setter ever ran (mutation-proven: neutering ONLY this line does not turn the save path
  // green for a threshold edit inside a parallel region). Mutation-proven for what it DOES guard:
  // approval-template-authoring-canvas-inspector.spec.ts's "setApprovalNodeMode refuses threshold…"
  // test reds if this line is removed.
  if (mode === 'threshold' && approvalNodeInParallelRegion(nodeKey)) return
  edit.approvalMode = mode
}
// P1-C (T2-4 N-of-M / 门槛会签). Meaningful only when `approvalNodeMode(nodeKey) === 'threshold'`.
function approvalNodeThreshold(nodeKey: string): number {
  const value = approvalNodeEditFor(nodeKey)?.approvalThreshold
  return Number.isInteger(value) && (value as number) >= 1 ? (value as number) : 1
}
function setApprovalNodeThreshold(nodeKey: string, value: number): void {
  const edit = approvalNodeEditFor(nodeKey)
  if (!edit) return
  edit.approvalThreshold = Number.isInteger(value) && value >= 1 ? value : 1
}
// P1-C: FE mirror of the backend's parallel-region definition (reused from the canvas's own
// nested-parallel authoring guard, `graphTopologyEdit.ts`), read over the CURRENT effective graph —
// a config edit never moves topology, but this stays consistent with the file's existing convention
// of reading topology through `canvasEffectiveGraph` rather than the (load-time) `preservedGraph`.
const parallelRegionNodeKeysInDraft = computed(() => collectParallelRegionNodeKeys(canvasEffectiveGraph.value))
function approvalNodeInParallelRegion(nodeKey: string): boolean {
  return parallelRegionNodeKeysInDraft.value.has(nodeKey)
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
// ── P1-C (T1-1) node-level timeout — approval-node-only; `null` explicitly clears (mirrors the
// `autoApprovalPolicy` null-clears-it convention above). `undefined` fields are ONLY ever produced
// by these setters together, never a half-filled shape — `buildStepTimeoutConfig`'s linear-path
// counterpart applies the SAME per-effect target discipline. ──────────────────────────────────────
function approvalNodeTimeout(nodeKey: string): NodeTimeoutConfig | undefined {
  return approvalNodeEditFor(nodeKey)?.timeout ?? undefined
}
function setApprovalNodeTimeoutEnabled(nodeKey: string, enabled: boolean): void {
  const edit = approvalNodeEditFor(nodeKey)
  if (!edit) return
  if (!enabled) {
    edit.timeout = null
    return
  }
  // Fail-closed floor, defense-in-depth, mirroring `setApprovalNodeMode`'s threshold guard above —
  // see that guard's comment (CORRECTION, fix-round gate P2-2): the invariant's actual enforcement
  // point for SAVE is `validateApprovalNodeEdits`'s `inParallelRegion` timeout branch
  // (approvalNodeEdit.ts), not this setter. Mutation-proven for what it DOES guard:
  // approval-template-authoring-canvas-inspector.spec.ts's "setApprovalNodeTimeoutEnabled refuses…"
  // test reds if this line is removed.
  if (approvalNodeInParallelRegion(nodeKey)) return
  if (edit.timeout) return // already enabled — do not clobber an in-progress configuration
  edit.timeout = { afterMinutes: 60, effect: 'remind' }
}
function setApprovalNodeTimeoutAfterMinutes(nodeKey: string, minutes: number): void {
  const edit = approvalNodeEditFor(nodeKey)
  if (!edit?.timeout) return
  if (!Number.isInteger(minutes) || minutes < 1) return
  edit.timeout = { ...edit.timeout, afterMinutes: minutes }
}
function setApprovalNodeTimeoutEffect(nodeKey: string, effect: SupportedNodeTimeoutEffect): void {
  const edit = approvalNodeEditFor(nodeKey)
  if (!edit?.timeout) return
  const { afterMinutes, unit } = edit.timeout
  // Switching effect drops the PREVIOUS effect's target field — transfer/jump are mutually
  // exclusive and 'remind' carries neither (mirrors `validateNodeTimeoutConfigs`'s strict
  // per-effect target rule: a stray target on the wrong effect is rejected, never ignored).
  edit.timeout = { afterMinutes, effect, ...(unit ? { unit } : {}) }
}
function setApprovalNodeTimeoutTransferToUserId(nodeKey: string, userId: string): void {
  const edit = approvalNodeEditFor(nodeKey)
  if (!edit?.timeout || edit.timeout.effect !== 'transfer') return
  edit.timeout = { ...edit.timeout, transferToUserId: userId }
}
function setApprovalNodeTimeoutJumpToNodeKey(nodeKey: string, targetNodeKey: string): void {
  const edit = approvalNodeEditFor(nodeKey)
  if (!edit?.timeout || edit.timeout.effect !== 'jump') return
  edit.timeout = { ...edit.timeout, jumpToNodeKey: targetNodeKey }
}
function setApprovalNodeTimeoutUnit(nodeKey: string, unit: 'wall_clock' | 'business'): void {
  const edit = approvalNodeEditFor(nodeKey)
  if (!edit?.timeout) return
  const next = { ...edit.timeout }
  if (unit === 'business') next.unit = 'business'
  else delete next.unit
  edit.timeout = next
}
/** Candidate jump targets: every OTHER `approval` node not inside a parallel region, business-labeled
 *  via the SAME `graphNodeLabel` the condition/cc editors already use — never a raw node key in the
 *  rendered option text (M8). */
function timeoutJumpTargetOptions(nodeKey: string): Array<{ key: string; label: string }> {
  return canvasEffectiveGraph.value.nodes
    .filter((node) => node.type === 'approval' && node.key !== nodeKey && !approvalNodeInParallelRegion(node.key))
    .map((node) => ({ key: node.key, label: graphNodeLabel(node.key) }))
}
// Lock-3 §1.1 — handler-only mode + opinion accessors (same edit model, keyed by nodeKey).
function handlerNodeMode(nodeKey: string): HandlerMode {
  return approvalNodeEditFor(nodeKey)?.handlerMode ?? 'all'
}
function setHandlerNodeMode(nodeKey: string, mode: HandlerMode): void {
  const edit = approvalNodeEditFor(nodeKey)
  if (edit) edit.handlerMode = mode
}
function handlerNodeOpinionRequired(nodeKey: string): boolean {
  return Boolean(approvalNodeEditFor(nodeKey)?.opinionRequired)
}
function setHandlerNodeOpinionRequired(nodeKey: string, required: boolean): void {
  const edit = approvalNodeEditFor(nodeKey)
  if (!edit) return
  if (required) edit.opinionRequired = true
  else delete edit.opinionRequired
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
// P1-B: replace ONLY the card AT sourceIndex; every other card (and every other node field) is
// preserved verbatim (no flatten). Out-of-range indexes are refused as a no-op.
function setApprovalNodeSourceAt(nodeKey: string, sourceIndex: number, source: ApprovalAssigneeSource): void {
  const edit = approvalNodeEditFor(nodeKey)
  if (!edit) return
  if (sourceIndex < 0 || sourceIndex >= edit.assigneeSources.length) return
  const next = edit.assigneeSources.slice()
  next[sourceIndex] = source
  edit.assigneeSources = next
}
function approvalSourceKind(nodeKey: string, sourceIndex: number): ApprovalAssigneeSourceKind {
  return approvalNodeSourceAt(nodeKey, sourceIndex)?.kind ?? 'requester'
}
// Gate P1-1 fix: the roster is a native `role="radiogroup"` (APG requires arrows to move AND
// select, so commit-on-arrow stays — see the L0-2 radio grid), which means an accidental
// ArrowUp/ArrowDown traversal calls this on every focus step. Naively replacing a card with a
// fresh, empty-payload object per kind (the pre-fix behaviour) is therefore destructive: one arrow
// out and one arrow back silently discarded a configured `userIds`/`roleIds`/`fieldId`/`levels`/
// `level` with no undo (canvas history never records a per-keystroke config edit — A-8) and no
// save path (the stripped payload fails node validation).
// Fix: cache the outgoing payload per (nodeKey, sourceIndex, kind) for this editing session BEFORE
// switching, and restore it verbatim if the author switches back to a previously-configured kind on
// THAT card. P1-B: keyed by card, not just node — two cards on one node cache independently, and
// `resetApprovalSourceKindCache()` (draft reseed) still clears the whole session cache. Any
// structural change to a node's source list (add/remove a card) also drops that node's cache slice
// — see `addApprovalSourceCard`/`removeApprovalSourceCard` — because indexes shift and a stale
// per-index cache entry would otherwise attribute one card's cached payload to a different card.
const approvalSourceKindCache = ref<Record<string, Partial<Record<ApprovalAssigneeSourceKind, ApprovalAssigneeSource>>>>({})
function resetApprovalSourceKindCache(): void {
  approvalSourceKindCache.value = {}
}
function approvalSourceKindCacheKey(nodeKey: string, sourceIndex: number): string {
  return `${nodeKey}:${sourceIndex}`
}
function clearApprovalSourceKindCacheForNode(nodeKey: string): void {
  const prefix = `${nodeKey}:`
  const next: typeof approvalSourceKindCache.value = {}
  for (const [key, value] of Object.entries(approvalSourceKindCache.value)) {
    if (!key.startsWith(prefix)) next[key] = value
  }
  approvalSourceKindCache.value = next
}
function cloneAssigneeSource(source: ApprovalAssigneeSource): ApprovalAssigneeSource {
  return JSON.parse(JSON.stringify(source)) as ApprovalAssigneeSource
}
function defaultApprovalSourceForKind(kind: ApprovalAssigneeSourceKind): ApprovalAssigneeSource {
  return kind === 'static_user' ? { kind, userIds: [] }
    : kind === 'static_role' ? { kind, roleIds: [] }
      : kind === 'form_field_user' ? { kind, fieldId: '' }
        : kind === 'continuous_managers' ? { kind, levels: 1 }
          : kind === 'manager_at_level' ? { kind, level: 1 }
            // Lock-1 §K2: single choice over the whole company is the widest, always-valid start.
            : kind === 'requester_choice' ? { kind, mode: 'single', scope: { type: 'company' } }
              // Lock-1 §K4: same default shape as continuous_managers.
              : kind === 'continuous_dept_heads' ? { kind, levels: 1 }
                // Lock-2 §L2-C: field picker + single level — fieldId starts unchosen ('' is
                // invalid to save; the picker must be used) and level defaults to 1 (直属).
                : kind === 'form_field_user_manager' ? { kind, fieldId: '', level: 1 }
                  : kind === 'form_field_user_dept_head' ? { kind, fieldId: '', level: 1 }
                // Lock-1 §K5-b: same default shape as manager_at_level.
                : kind === 'dept_head_at_level' ? { kind, level: 1 }
                  // Lock-1 §K3: '' = not yet chosen — invalid to save until the typed picker
                  // selects a legal upstream node (never silently defaulted to one).
                  : kind === 'prior_node_approver' ? { kind, nodeKey: '' }
                    // Lock-1 §K1: '' = no group selected yet — invalid to save until the typed
                    // bound-group picker selects ≥1 (never silently defaulted to one).
                    : kind === 'user_group' ? { kind, groupIds: [] }
                      : { kind: kind as 'requester' | 'direct_manager' | 'dept_head' }
}
function setApprovalSourceKind(nodeKey: string, sourceIndex: number, kind: ApprovalAssigneeSourceKind): void {
  const cacheKey = approvalSourceKindCacheKey(nodeKey, sourceIndex)
  const current = approvalNodeSourceAt(nodeKey, sourceIndex)
  if (current && current.kind !== kind) {
    const cacheForCard = approvalSourceKindCache.value[cacheKey] ?? {}
    cacheForCard[current.kind] = cloneAssigneeSource(current)
    approvalSourceKindCache.value = { ...approvalSourceKindCache.value, [cacheKey]: cacheForCard }
  }
  const cached = approvalSourceKindCache.value[cacheKey]?.[kind]
  const next: ApprovalAssigneeSource = cached ? cloneAssigneeSource(cached) : defaultApprovalSourceForKind(kind)
  setApprovalNodeSourceAt(nodeKey, sourceIndex, next)
}
function approvalSourceIds(nodeKey: string, sourceIndex: number): string[] {
  const source = approvalNodeSourceAt(nodeKey, sourceIndex)
  if (source?.kind === 'static_user') return source.userIds
  if (source?.kind === 'static_role') return source.roleIds
  return []
}
// Lock-1 §K1 — the user_group source's DEDICATED id carrier (separate from approvalSourceIds
// above, which is hardcoded to static_user/static_role's userIds/roleIds shape).
function approvalSourceGroupIds(nodeKey: string, sourceIndex: number): string[] {
  const source = approvalNodeSourceAt(nodeKey, sourceIndex)
  return source?.kind === 'user_group' ? source.groupIds : []
}
function setApprovalSourceGroupIds(nodeKey: string, sourceIndex: number, ids: string[]): void {
  const source = approvalNodeSourceAt(nodeKey, sourceIndex)
  if (source?.kind !== 'user_group') return
  setApprovalNodeSourceAt(nodeKey, sourceIndex, { kind: 'user_group', groupIds: [...ids] })
}
// G-5 sentinel hint: true when THIS card is a static_role still carrying the starter-preset
// placeholder (APPROVAL_ROLE_CONFIGURE_SENTINEL). The backend blocks publish on it; this surfaces it
// in the editor so the admin replaces it first. Non-blocking — the draft still saves. Computed
// directly off the card at sourceIndex (not the aggregate `publishPlaceholderRoleKeys` list) so a
// node with N cards points the hint at the EXACT offending card rather than lighting up all of them.
// Delegates to the SAME `isPlaceholderRoleSource` predicate `placeholderRoleNodeKeys` uses, so the
// per-card hint and the aggregate publish checklist item can never disagree on what counts.
function approvalSourceIsPlaceholder(nodeKey: string, sourceIndex: number): boolean {
  const source = approvalNodeSourceAt(nodeKey, sourceIndex)
  return Boolean(source && isPlaceholderRoleSource(source))
}
// P1-B: card count for the v-for + the "keep ≥1" remove-guard's disabled state.
function approvalSourceCount(nodeKey: string): number {
  return approvalNodeEditFor(nodeKey)?.assigneeSources.length ?? 0
}
// P1-B "＋添加审批人": appends one new card with the given default kind (the caller — the config
// editor — reads it from the registry roster, never hand-picks one, so a `handler` node's add
// button never seeds a kind outside its seven-member roster). Delegates to the pure, independently
// unit-tested `addAssigneeSourceCard` (approvalNodeEdit.ts). Deliberately does NOT clear the P1-1
// kind-switch cache: an append never shifts any EXISTING card's index (it only grows the array at
// the end), so a card the author already configured-then-switched-away-from keeps its cached
// payload intact across an unrelated add — clearing here would silently re-open the exact P1-1
// config-loss bug in a new sequence (configure → switch away → add a card → switch back → cache
// gone → empty payload, no undo).
function addApprovalSourceCard(nodeKey: string, defaultKind: ApprovalAssigneeSourceKind): void {
  const edits = draft.value.approvalNodeEdits
  if (!edits) return
  addAssigneeSourceCard(edits, nodeKey, defaultApprovalSourceForKind(defaultKind))
}
// P1-B fail-closed remove: a node must always keep ≥1 assignee source. Delegates to the pure,
// independently unit-tested `removeAssigneeSourceCard` (approvalNodeEdit.ts), which refuses at
// length<=1 REGARDLESS of the remove button's `disabled` attribute — see that function's doc
// comment for why disabled-button DOM testing alone cannot prove this guard. Clears the P1-1
// kind-switch cache for this node HERE (unlike add): removing a card SHIFTS every subsequent card's
// index, so a stale per-index cache entry would otherwise attribute one card's cached payload to a
// now-different card at the same index — clearing avoids that misattribution. It is a session-only
// UX convenience (never persisted), so losing it on remove is a strictly safe/conservative choice.
function removeApprovalSourceCard(nodeKey: string, sourceIndex: number): void {
  const edits = draft.value.approvalNodeEdits
  if (!edits) return
  clearApprovalSourceKindCacheForNode(nodeKey)
  removeAssigneeSourceCard(edits, nodeKey, sourceIndex)
}

// ── Topology authoring (graphTopologyEdit + authoring session history) ──
// Each op runs on the EFFECTIVE graph (configs applied) and re-seeds the draft, so the structured
// editors stay in sync. Typed move/reorder use approvalCanvasCommands; other topology helpers
// record snapshot inverses. Invalid ops fail closed with no partial draft apply.
const canvasAuthoringHistory = ref<AuthoringSessionHistory>(
  createAuthoringSessionHistory({ nodes: [], edges: [] }),
)
const canUndoCanvasHistory = computed(() => canUndoAuthoring(canvasAuthoringHistory.value))
const canRedoCanvasHistory = computed(() => canRedoAuthoring(canvasAuthoringHistory.value))

// ── Form field list session history (separate from canvas) ──
// Structural mutations only (add/remove/reorder). Label/type in-place edits are not snapshotted.
// Tip is aligned from live draft before each structural push so those edits ride on the "before"
// of the next structural op without polluting canvas history.
const formAuthoringHistory = ref<FormAuthoringHistory>(
  createFormAuthoringHistory([]),
)
const formFieldFocusLocalId = ref<string | null>(null)
const canUndoFormFieldHistory = computed(() => canUndoFormHistory(formAuthoringHistory.value))
const canRedoFormFieldHistory = computed(() => canRedoFormHistory(formAuthoringHistory.value))

function reseedFormHistoryFromDraft(): void {
  formAuthoringHistory.value = createFormAuthoringHistory(
    draft.value.fields,
    formFieldFocusLocalId.value,
  )
}

function applyFormFieldsStructural(
  nextFields: FieldAuthoringDraft[],
  nextFocus: string | null = formFieldFocusLocalId.value,
): void {
  // Align tip with live draft so label/type edits since the last structural op survive as the
  // undo "before" of this mutation (still one stack entry for the structural change).
  const aligned: FormAuthoringHistory = {
    ...formAuthoringHistory.value,
    fields: draft.value.fields,
    focusLocalId: formFieldFocusLocalId.value,
  }
  const next = pushFormSnapshot(aligned, nextFields, nextFocus)
  formAuthoringHistory.value = next
  draft.value.fields = next.fields
  formFieldFocusLocalId.value = next.focusLocalId
}

/** UI selection only — does not push form history (focus-only; structural stack unchanged). */
function selectFormFieldFocus(localId: string): void {
  if (formFieldFocusLocalId.value === localId) return
  formFieldFocusLocalId.value = localId
}

/**
 * After palette/add, land keyboard authors on the new field row (selection already set via
 * form history focusLocalId). Prefer the label input; fall back to the row shell.
 */
async function focusFormFieldRow(localId: string): Promise<void> {
  formFieldFocusLocalId.value = localId
  await nextTick()
  const row = document.getElementById(`approval-field-row-${localId}`)
  if (!row) return
  row.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' })
  const labelInput = row.querySelector('input') as HTMLInputElement | null
  if (labelInput && !labelInput.disabled) {
    labelInput.focus()
    return
  }
  row.focus()
}

function onFormFieldUndo(): void {
  if (readOnly.value) return
  // Align tip with live draft so in-place edits since last structural op redo correctly.
  const aligned: FormAuthoringHistory = {
    ...formAuthoringHistory.value,
    fields: draft.value.fields,
    focusLocalId: formFieldFocusLocalId.value,
  }
  const result = undoFormHistory(aligned)
  if (!result.ok) return
  formAuthoringHistory.value = result.history
  draft.value.fields = result.fields
  formFieldFocusLocalId.value = result.focusLocalId
}

function onFormFieldRedo(): void {
  if (readOnly.value) return
  const aligned: FormAuthoringHistory = {
    ...formAuthoringHistory.value,
    fields: draft.value.fields,
    focusLocalId: formFieldFocusLocalId.value,
  }
  const result = redoFormHistory(aligned)
  if (!result.ok) return
  formAuthoringHistory.value = result.history
  draft.value.fields = result.fields
  formFieldFocusLocalId.value = result.focusLocalId
}

function currentCanvasSelection(): ApprovalCanvasSelection {
  return selectedCanvasNode.value
    ? { kind: 'node', nodeKey: selectedCanvasNode.value }
    : { kind: 'none' }
}

function reseedCanvasHistoryFromDraft(): void {
  canvasAuthoringHistory.value = reseedAuthoringSessionHistory(
    draft.value,
    currentCanvasSelection(),
  )
  // P1-1 fix: every call site is a fresh draft/graph seed (load / save / preset / linear→graph
  // promotion) — the per-kind assignee-source cache is session state for the PRIOR graph and must
  // not leak into a differently-keyed node in a new one.
  resetApprovalSourceKindCache()
}

function applySessionHistoryToDraft(next: AuthoringSessionHistory): void {
  canvasAuthoringHistory.value = next
  draft.value = draftFromSessionGraph(draft.value, next.graph)
  if (next.selection.kind === 'node') {
    selectedCanvasNode.value = next.selection.nodeKey
  } else {
    selectedCanvasNode.value = null
  }
}

function runTopologyOp(
  op: (graph: ApprovalGraph) => ApprovalGraph,
  selectionAfter?: ApprovalCanvasSelection,
): void {
  const result = applyTopologyOpToSession(
    canvasAuthoringHistory.value,
    draft.value,
    op,
    selectionAfter ?? currentCanvasSelection(),
  )
  if (!result.ok) {
    loadError.value = result.errorMessage ?? '该拓扑操作不适用于当前流程结构'
    return
  }
  draft.value = result.draft
  canvasAuthoringHistory.value = result.history
  if (result.history.selection.kind === 'node') {
    selectedCanvasNode.value = result.history.selection.nodeKey
  }
}

function onCanvasUndo(): void {
  if (readOnly.value) return
  // Live effective graph carries inspector map edits; never undo against a stale session tip.
  const result = undoAuthoringSession(
    canvasAuthoringHistory.value,
    buildApprovalGraph(draft.value),
  )
  if (!result.ok) return
  applySessionHistoryToDraft(result.history)
}

function onCanvasRedo(): void {
  if (readOnly.value) return
  const result = redoAuthoringSession(
    canvasAuthoringHistory.value,
    buildApprovalGraph(draft.value),
  )
  if (!result.ok) return
  applySessionHistoryToDraft(result.history)
}

function onAddConditionBranch(nodeKey: string): void {
  runTopologyOp((graph) => addConditionBranch(graph, nodeKey), { kind: 'node', nodeKey })
}
function onAddParallelBranch(nodeKey: string): void {
  runTopologyOp((graph) => addParallelBranch(graph, nodeKey), { kind: 'node', nodeKey })
}
function selectInsertedNode(beforeKeys: Set<string>): void {
  const inserted = canvasEffectiveGraph.value.nodes.find((node) => !beforeKeys.has(node.key))?.key
  if (inserted) selectedCanvasNode.value = inserted
}
function onInsertApprovalAfter(nodeKey: string): void {
  const beforeKeys = new Set(canvasEffectiveGraph.value.nodes.map((node) => node.key))
  runTopologyOp((graph) => appendApprovalNode(graph, nodeKey), { kind: 'none' })
  selectInsertedNode(beforeKeys)
}
function onInsertCcAfter(nodeKey: string): void {
  const beforeKeys = new Set(canvasEffectiveGraph.value.nodes.map((node) => node.key))
  runTopologyOp((graph) => appendCcNode(graph, nodeKey), { kind: 'none' })
  selectInsertedNode(beforeKeys)
}
function onInsertHandlerAfter(nodeKey: string): void {
  const beforeKeys = new Set(canvasEffectiveGraph.value.nodes.map((node) => node.key))
  runTopologyOp((graph) => appendHandlerNode(graph, nodeKey), { kind: 'none' })
  selectInsertedNode(beforeKeys)
}
function onInsertConditionAfter(nodeKey: string): void {
  runTopologyOp((graph) => insertConditionGateway(graph, nodeKey), { kind: 'node', nodeKey })
  canvasViewMode.value = 'canvas'
}
function onInsertParallelAfter(nodeKey: string): void {
  runTopologyOp((graph) => insertParallelGateway(graph, nodeKey), { kind: 'node', nodeKey })
  canvasViewMode.value = 'canvas'
}
function onRemoveNode(nodeKey: string): void {
  runTopologyOp((graph) => removeLinearNode(graph, nodeKey), { kind: 'none' })
  // Canvas V2 Slice A: deleting the selected node clears selection and closes the inspector.
  if (selectedCanvasNode.value === nodeKey) clearCanvasSelection()
}
// B2 — parent owns the mutation (component doc comment "parent owns selection and all
// mutations"), applying `name` the same way `step.name` is applied for a linear node: a direct
// write to the node object's `name` field on `draft.preservedGraph`, not a new parallel edit-map
// alongside G-2 (condition) / G-3 (parallel) / G-4 (cc) / G-5 (approvalNode) — those four passes
// only ever rebuild `config`, never `name`, so a direct write here survives `buildApprovalGraph`
// untouched (verified: `applyApprovalNodeEditsToGraph` et al. spread `{ ...cloneJson(node), config
// }`, carrying whatever `name` the source node already has). Also survives topology undo/redo:
// `mergeLiveNodeConfigsOntoTopology` (approvalAuthoringHistory.ts) already treats `name` as "live"
// node state alongside `config`, generically, with no change needed here. A blank/whitespace name
// clears the override — `graphNodeLabel` already falls back to the node-type label for `undefined`.
function onRenameCanvasNode(nodeKey: string, name: string): void {
  // THROUGH THE UNIFIED HISTORY, not a direct draft mutation (E-P2-4, external review
  // 2026-08-25): the first shape wrote draft.preservedGraph in place, so rename produced no
  // history entry — undo stayed disabled after a rename, and a later topology undo resurrected
  // stale names. A topology op records a snapshot pair with inverse in the SAME undo stack every
  // other structural edit uses; renaming to the current name is an identity op and records
  // nothing. (mergeLiveNodeConfigsOntoTopology no longer overlays live names for the same
  // reason — see its comment.)
  const trimmed = name.trim()
  runTopologyOp(
    (graph) => ({
      nodes: graph.nodes.map((node) => {
        if (node.key !== nodeKey) return node
        if (trimmed) return { ...node, name: trimmed }
        const { name: _dropped, ...rest } = node
        return rest
      }),
      edges: graph.edges,
    }),
    { kind: 'node', nodeKey },
  )
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
  const isLinearRemovable = (node.type === 'approval' || node.type === 'cc')
    && topologyEdgeCount(node.key, 'target') === 1
    && topologyEdgeCount(node.key, 'source') === 1
  if (!isLinearRemovable) return false
  try {
    removeLinearNode(buildApprovalGraph(draft.value), node.key)
    return true
  } catch {
    return false
  }
}

// ── D-1/D-5/D-6 visual canvas. Layout and semantic move targets are pure data; drag/drop and
// Alt+Arrow both invoke the same typed canvas command, so visual position never diverges from the
// saved graph. Canvas is the ordinary-user default when Canvas V2 is on; list is the retained
// accessible alternative until S12 equivalence is proven. ──
const canvasViewMode = ref<'list' | 'canvas'>('canvas')
const selectedCanvasNode = ref<string | null>(null)
const approvalFlowCanvasRef = ref<{ getViewportEl: () => HTMLElement | null } | null>(null)
const approvalCanvasInspectorRef = ref<{ scrollIntoView: (opts?: ScrollIntoViewOptions) => void } | null>(null)
function canvasViewportEl(): HTMLElement | null {
  return approvalFlowCanvasRef.value?.getViewportEl() ?? null
}
const movingCanvasNode = ref<string | null>(null)
const canvasZoom = ref(1)
const canvasViewportState = ref({ width: 0, height: 0, scrollLeft: 0, scrollTop: 0 })
const CANVAS_NODE_W = GRAPH_LAYOUT_NODE_WIDTH
const CANVAS_NODE_H = GRAPH_LAYOUT_NODE_HEIGHT
const CANVAS_MINIMAP_W = 220
const CANVAS_MINIMAP_H = 120
const canvasEffectiveGraph = computed<ApprovalGraph>(() => buildApprovalGraph(draft.value))
const canvasLayout = computed<GraphLayout>(() => computeLayout(canvasEffectiveGraph.value))
const canvasValidity = computed<string[]>(() => (draft.value.preservedGraph ? graphValidityIssues(canvasEffectiveGraph.value) : []))
const canvasZoomLabel = computed(() => `${Math.round(canvasZoom.value * 100)}%`)
const canvasStageStyle = computed<CSSProperties>(() => {
  const scaledW = Math.round(canvasLayout.value.width * canvasZoom.value)
  const scaledH = Math.round(canvasLayout.value.height * canvasZoom.value)
  const vpW = canvasViewportState.value.width
  const vpH = canvasViewportState.value.height
  return {
    minWidth: '100%',
    minHeight: vpH ? `${vpH}px` : '100%',
    width: `${Math.max(vpW, scaledW)}px`,
    height: `${Math.max(vpH, scaledH + 56)}px`,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'flex-start',
    boxSizing: 'border-box',
    padding: '28px 16px 64px',
  }
})
const canvasSurfaceStyle = computed(() => ({
  position: 'relative' as const,
  width: `${canvasLayout.value.width}px`,
  height: `${canvasLayout.value.height}px`,
  transform: `scale(${canvasZoom.value})`,
  transformOrigin: '0 0',
}))
const canvasMinimap = computed(() => computeMinimapFrame(
  canvasLayout.value,
  canvasViewportState.value,
  canvasZoom.value,
  { width: CANVAS_MINIMAP_W, height: CANVAS_MINIMAP_H },
))
function syncCanvasViewportState(): void {
  const viewport = canvasViewportEl()
  if (!viewport) return
  canvasViewportState.value = {
    width: viewport.clientWidth,
    height: viewport.clientHeight,
    scrollLeft: viewport.scrollLeft,
    scrollTop: viewport.scrollTop,
  }
}
async function setCanvasZoom(nextZoom: number): Promise<void> {
  canvasZoom.value = nextZoom
  await nextTick()
  syncCanvasViewportState()
}
function changeCanvasZoom(direction: 'in' | 'out'): void {
  void setCanvasZoom(stepCanvasZoom(canvasZoom.value, direction))
}
function resetCanvasZoom(): void {
  void setCanvasZoom(1)
}
async function fitCanvasToViewport(): Promise<void> {
  const viewport = canvasViewportEl()
  if (!viewport) return
  await setCanvasZoom(fitCanvasZoom(
    canvasLayout.value,
    { width: viewport.clientWidth, height: viewport.clientHeight },
  ))
  viewport.scrollTo({ left: 0, top: 0 })
  syncCanvasViewportState()
}
function canvasNodeByKey(key: string): ApprovalNode | undefined {
  return canvasEffectiveGraph.value.nodes.find((n) => n.key === key)
}
async function selectCanvasNode(nodeKey: string): Promise<void> {
  selectedCanvasNode.value = nodeKey
  await nextTick()
  if (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 960px)').matches) {
    approvalCanvasInspectorRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}
function clearCanvasSelection(): void {
  selectedCanvasNode.value = null
}
// Inspector node for the right-side panel. Selection is preserved across list/canvas toggles while
// the key still exists; once the graph no longer carries that key, selection clears.
const selectedCanvasInspectorNode = computed<ApprovalNode | null>(() => {
  const key = selectedCanvasNode.value
  if (!key) return null
  return canvasNodeByKey(key) ?? null
})
watch(canvasEffectiveGraph, (graph) => {
  const key = selectedCanvasNode.value
  if (key && !graph.nodes.some((node) => node.key === key)) clearCanvasSelection()
  const movingKey = movingCanvasNode.value
  if (movingKey && linearNodeMoveTargets(graph, movingKey).length === 0) cancelCanvasNodeMove()
})
watch([canvasViewMode, canvasLayout], async ([mode]) => {
  if (mode !== 'canvas') return
  await nextTick()
  syncCanvasViewportState()
})

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
const publishFormFieldIssues = computed<string[]>(() => validateTemplateFormFields(
  draft.value,
  unsupportedReason.value,
  recordLinkCatalogValidation.value,
))
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
    (key) => `审批节点「${canvasNodeByKey(key)?.name?.trim() || '未命名节点'}」仍为占位审批角色，请先替换为真实角色`,
  ),
)
const publishChecklist = computed<PublishChecklistItem[]>(() => [
  { key: 'fields', label: '表单字段', ok: publishFormFieldIssues.value.length === 0, detail: publishFormFieldIssues.value[0] },
  { key: 'flow', label: '审批流程', ok: publishApprovalFlowIssues.value.length === 0, detail: publishApprovalFlowIssues.value[0] },
  { key: 'placeholder', label: '审批人占位', ok: publishPlaceholderRoleIssues.value.length === 0, detail: publishPlaceholderRoleIssues.value[0] },
])
const canConfirmPublish = computed(() => publishChecklist.value.every((item) => item.ok))

// B0 (header "N项不完善" affordance) — the SAME three issue lists the publish checklist already
// derives, flattened. Zero new validation logic: this is a live view onto what `canConfirmPublish`
// already gates on, so "0 项不完善" and "ready to publish" can never disagree. Deliberately NOT
// `validationErrors.value` (that ref only updates on an explicit `validate()` call, i.e. after a
// save attempt) — this counter is live from the moment the draft has anything incomplete, matching
// the reference product's counter instead of only appearing after a blocked save.
const incompleteAuthoringIssues = computed<string[]>(() => [
  ...publishFormFieldIssues.value,
  ...publishApprovalFlowIssues.value,
  ...publishPlaceholderRoleIssues.value,
])
const incompleteAuthoringIssueCount = computed<number>(() => incompleteAuthoringIssues.value.length)

/** Clicking the header "N项不完善" affordance reuses the EXACT same reveal machinery a blocked
 *  save already uses (`validationErrors` + `firstInvalidAuthoringSection` + `scrollAuthoringTarget`)
 *  — it never renders a second, parallel issue list. */
async function revealIncompleteAuthoringIssues(): Promise<void> {
  validationErrors.value = incompleteAuthoringIssues.value
  activeAuthoringSection.value = firstInvalidAuthoringSection(publishFormFieldIssues.value)
  await nextTick()
  scrollAuthoringTarget(validationSummaryRef.value, true)
}
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
    return {
      key: edge.key,
      path: `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`,
      dropX: (x1 + x2) / 2,
      dropY: midY,
    }
  })
})
const canvasMoveTargets = computed(() => movingCanvasNode.value
  ? new Set(linearNodeMoveTargets(canvasEffectiveGraph.value, movingCanvasNode.value).map((target) => target.edgeKey))
  : new Set<string>())
const canvasMoveTargetLines = computed(() => canvasEdgeLines.value.filter((line) => canvasMoveTargets.value.has(line.key)))
function canvasStepMoveTarget(nodeKey: string, direction: 'up' | 'down'): string | undefined {
  return adjacentLinearNodeMoveTarget(canvasEffectiveGraph.value, nodeKey, direction)
}
function canMoveCanvasNode(nodeKey: string): boolean {
  return linearNodeMoveTargets(canvasEffectiveGraph.value, nodeKey).length > 0
}
function canvasMoveTargetLabel(edgeKey: string): string {
  const edge = canvasEffectiveGraph.value.edges.find((candidate) => candidate.key === edgeKey)
  const movingLabel = movingCanvasNode.value ? graphNodeLabel(movingCanvasNode.value) : '节点'
  return edge ? `将${movingLabel}移动到${graphNodeLabel(edge.source)}之后` : `移动${movingLabel}`
}
function beginCanvasNodeMove(nodeKey: string): void {
  if (readOnly.value || !canMoveCanvasNode(nodeKey)) return
  movingCanvasNode.value = movingCanvasNode.value === nodeKey ? null : nodeKey
}
function cancelCanvasNodeMove(): void {
  movingCanvasNode.value = null
}
function applyCanvasNodeMove(targetEdgeKey: string): void {
  const nodeKey = movingCanvasNode.value
  if (!nodeKey || !canvasMoveTargets.value.has(targetEdgeKey)) return
  const selectionBefore: ApprovalCanvasSelection = { kind: 'node', nodeKey }
  // Always command against the live effective graph so inspector-only map edits
  // (approvalMode / assigneeSources / condition rules / …) are not wiped on project.
  const applied = applyCanvasCommandToSession(
    canvasAuthoringHistory.value,
    { type: 'move-node-into-edge', nodeKey, intoEdgeKey: targetEdgeKey },
    selectionBefore,
    buildApprovalGraph(draft.value),
  )
  if (!applied.ok) {
    // Fail closed: no draft mutation. Business-facing copy only (no edge/node keys).
    loadError.value = '该位置不能放置此节点'
    cancelCanvasNodeMove()
    return
  }
  applySessionHistoryToDraft(applied.history)
  selectedCanvasNode.value = nodeKey
  cancelCanvasNodeMove()
}

const edgeInsertMenuEdgeKey = ref<string | null>(null)
function toggleEdgeInsertMenu(edgeKey: string): void {
  edgeInsertMenuEdgeKey.value = edgeInsertMenuEdgeKey.value === edgeKey ? null : edgeKey
}
function closeEdgeInsertMenu(): void {
  edgeInsertMenuEdgeKey.value = null
}
function edgeSourceNode(edgeKey: string): ApprovalNode | undefined {
  const edge = canvasEffectiveGraph.value.edges.find((candidate) => candidate.key === edgeKey)
  if (!edge) return undefined
  return canvasNodeByKey(edge.source)
}
function canInsertParallelOnEdge(edgeKey: string): boolean {
  const source = edgeSourceNode(edgeKey)
  return Boolean(source && canInsertParallelAfter(source))
}
// Lock-3 §1.3/§1.5: a handler is linear-only in v1 — allowed on a normal linear edge, hidden on any
// edge inside a parallel region (its source node is in the region key set).
function canInsertHandlerOnEdge(edgeKey: string): boolean {
  const source = edgeSourceNode(edgeKey)
  return Boolean(source && canInsertOnCanvasEdge(edgeKey) && !parallelRegionKeys.value.has(source.key))
}
function canInsertOnCanvasEdge(edgeKey: string): boolean {
  const source = edgeSourceNode(edgeKey)
  if (!source || source.type === 'end') return false
  return canvasEffectiveGraph.value.edges.filter((edge) => edge.source === source.key).length === 1
}
function rejectEdgeInsert(): void {
  ElMessage.warning('当前连线不能插入这种节点')
  closeEdgeInsertMenu()
}
function onEdgeInsertApproval(edgeKey: string): void {
  const source = edgeSourceNode(edgeKey)
  if (!source || !canInsertOnCanvasEdge(edgeKey)) {
    rejectEdgeInsert()
    return
  }
  onInsertApprovalAfter(source.key)
  closeEdgeInsertMenu()
}
function onEdgeInsertCc(edgeKey: string): void {
  const source = edgeSourceNode(edgeKey)
  if (!source || !canInsertOnCanvasEdge(edgeKey)) {
    rejectEdgeInsert()
    return
  }
  onInsertCcAfter(source.key)
  closeEdgeInsertMenu()
}
function onEdgeInsertCondition(edgeKey: string): void {
  const source = edgeSourceNode(edgeKey)
  if (!source || !canInsertOnCanvasEdge(edgeKey)) {
    rejectEdgeInsert()
    return
  }
  onInsertConditionAfter(source.key)
  closeEdgeInsertMenu()
}
function onEdgeInsertParallel(edgeKey: string): void {
  const source = edgeSourceNode(edgeKey)
  if (!source || !canInsertParallelAfter(source) || !canInsertOnCanvasEdge(edgeKey)) {
    rejectEdgeInsert()
    return
  }
  onInsertParallelAfter(source.key)
  closeEdgeInsertMenu()
}
function onEdgeInsertHandler(edgeKey: string): void {
  const source = edgeSourceNode(edgeKey)
  if (!source || !canInsertHandlerOnEdge(edgeKey)) {
    rejectEdgeInsert()
    return
  }
  onInsertHandlerAfter(source.key)
  closeEdgeInsertMenu()
}
function moveCanvasNodeStep(nodeKey: string, direction: 'up' | 'down'): void {
  const target = canvasStepMoveTarget(nodeKey, direction)
  if (!target) return
  movingCanvasNode.value = nodeKey
  applyCanvasNodeMove(target)
}
function onCanvasNodeKeydown(event: KeyboardEvent, nodeKey: string): void {
  if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
  event.preventDefault()
  event.stopPropagation()
  moveCanvasNodeStep(nodeKey, event.key === 'ArrowUp' ? 'up' : 'down')
}
function onCanvasNodeDragStart(event: DragEvent, nodeKey: string): void {
  if (readOnly.value || !canMoveCanvasNode(nodeKey)) {
    event.preventDefault()
    return
  }
  movingCanvasNode.value = nodeKey
  event.dataTransfer?.setData('text/plain', nodeKey)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}
function onCanvasNodeDrop(event: DragEvent, edgeKey: string): void {
  event.preventDefault()
  event.stopPropagation()
  applyCanvasNodeMove(edgeKey)
}
function setApprovalSourceIds(nodeKey: string, sourceIndex: number, ids: string[]): void {
  const kind = approvalSourceKind(nodeKey, sourceIndex)
  if (kind === 'static_user') setApprovalNodeSourceAt(nodeKey, sourceIndex, { kind, userIds: ids })
  else if (kind === 'static_role') setApprovalNodeSourceAt(nodeKey, sourceIndex, { kind, roleIds: ids })
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
function setApprovalSourceIdsFromPicker(nodeKey: string, sourceIndex: number, ids: string[]): void {
  setApprovalSourceIds(nodeKey, sourceIndex, ids)
}
function approvalSourceFieldId(nodeKey: string, sourceIndex: number): string {
  const source = approvalNodeSourceAt(nodeKey, sourceIndex)
  if (source?.kind === 'form_field_user') return source.fieldId
  // Lock-2 §L2-C: the contact-extension kinds carry a fieldId too (field picker + level).
  if (source?.kind === 'form_field_user_manager' || source?.kind === 'form_field_user_dept_head') return source.fieldId
  return ''
}
function setApprovalSourceFieldId(nodeKey: string, sourceIndex: number, fieldId: string): void {
  const current = approvalNodeSourceAt(nodeKey, sourceIndex)
  // Lock-2 §L2-C: preserve the kind + configured level — only the referenced field changes.
  if (current?.kind === 'form_field_user_manager' || current?.kind === 'form_field_user_dept_head') {
    setApprovalNodeSourceAt(nodeKey, sourceIndex, { kind: current.kind, fieldId, level: current.level })
    return
  }
  setApprovalNodeSourceAt(nodeKey, sourceIndex, { kind: 'form_field_user', fieldId })
}
function approvalSourceLevel(nodeKey: string, sourceIndex: number): number {
  const source = approvalNodeSourceAt(nodeKey, sourceIndex)
  if (source?.kind === 'manager_at_level') return source.level
  if (source?.kind === 'continuous_managers') return source.levels
  // Lock-1 §K4: same shared-field shape as continuous_managers.
  if (source?.kind === 'continuous_dept_heads') return source.levels
  // Lock-1 §K5-b: same shared-field shape as manager_at_level.
  if (source?.kind === 'dept_head_at_level') return source.level
  // Lock-2 §L2-C: the contact-extension kinds carry a single level beside their fieldId.
  if (source?.kind === 'form_field_user_manager' || source?.kind === 'form_field_user_dept_head') return source.level
  return 1
}
function setApprovalSourceLevel(nodeKey: string, sourceIndex: number, value: number): void {
  const kind = approvalSourceKind(nodeKey, sourceIndex)
  if (kind === 'manager_at_level') setApprovalNodeSourceAt(nodeKey, sourceIndex, { kind, level: value })
  else if (kind === 'continuous_managers') setApprovalNodeSourceAt(nodeKey, sourceIndex, { kind, levels: value })
  else if (kind === 'continuous_dept_heads') setApprovalNodeSourceAt(nodeKey, sourceIndex, { kind, levels: value })
  else if (kind === 'dept_head_at_level') setApprovalNodeSourceAt(nodeKey, sourceIndex, { kind, level: value })
  else if (kind === 'form_field_user_manager' || kind === 'form_field_user_dept_head') {
    // Lock-2 §L2-C: preserve the configured fieldId — only the level changes.
    const current = approvalNodeSourceAt(nodeKey, sourceIndex)
    const fieldId = current?.kind === kind ? current.fieldId : ''
    setApprovalNodeSourceAt(nodeKey, sourceIndex, { kind, fieldId, level: value })
  }
}

const userFields = computed(() => draft.value.fields.filter((field) => field.type === 'user' && field.id.trim()))

// T1-4 node field permissions: every top-level form field is a candidate for a per-node access
// override (the linear editor shows the same field list for every approval step).
const fieldPermissionFields = computed(() => draft.value.fields.filter((field) => field.id.trim()))
// Form fields that DRIVE routing (a form_field_user assignee source references them). Hiding one is
// allowed — redaction is echo-only, so resolution is unaffected — but the UI surfaces a hint.
//
// Gate P2-1/D5 fix: this MUST read both authoring models, not just `draft.steps` (the linear step
// list). Once a draft is promoted to graph authoring, `steps` is always `[]` — see
// `draftFromEditedGraph` / `draftFromTemplate`'s `complex` branch — and the per-node source instead
// lives on `draft.approvalNodeEdits[key].assigneeSources`. The canvas inspector mounts ONLY on
// complex graphs, so a linear-only read left this computed structurally empty on exactly the
// surface D5 targets (measured: `draft.steps.length === 0` there). One computed, unioning both
// models, shared verbatim by the linear step editor (below) and the canvas graph inspector via
// `nodeConfigEditorApi.routingDriverFieldIds` — the two surfaces render the hint under the identical
// condition because they read the identical Set, not two independently-derived ones.
const routingDriverFieldIds = computed(() => {
  const ids = new Set<string>()
  const driverKinds = new Set(['form_field_user', 'form_field_user_manager', 'form_field_user_dept_head'])
  for (const step of draft.value.steps) {
    if (driverKinds.has(step.sourceKind) && step.fieldId.trim()) ids.add(step.fieldId.trim())
  }
  for (const edit of Object.values(draft.value.approvalNodeEdits ?? {})) {
    for (const source of edit.assigneeSources) {
      // Lock-2 §L2-C: the contact-extension kinds reference a driver field too — same hint.
      if ((source.kind === 'form_field_user' || source.kind === 'form_field_user_manager' || source.kind === 'form_field_user_dept_head') && source.fieldId.trim()) ids.add(source.fieldId.trim())
    }
  }
  return ids
})
function onStepFieldAccessChange(step: ApprovalStepDraft, fieldId: string, access: NodeFieldAccess): void {
  step.fieldPermissions = setStepFieldPermission(step.fieldPermissions, fieldId, access)
}

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

// P1-C (T1-1): business labels for the timeout effect picker — never the raw enum string.
const STEP_TIMEOUT_EFFECT_OPTION_LABELS: Record<SupportedNodeTimeoutEffect, string> = {
  remind: '催办提醒',
  transfer: '转交他人',
  jump: '跳转节点',
}
function stepTimeoutEffectOptionLabel(effect: SupportedNodeTimeoutEffect): string {
  return STEP_TIMEOUT_EFFECT_OPTION_LABELS[effect]
}
/** Read-only-summary counterpart of `stepTimeoutEffectOptionLabel` — tolerates an effect outside the
 *  wired set (returns '', never the raw enum string) since a SUMMARY echoes persisted data rather
 *  than authoring it. */
function nodeTimeoutEffectLabel(effect: string | undefined): string {
  return (effect && (STEP_TIMEOUT_EFFECT_OPTION_LABELS as Partial<Record<string, string>>)[effect]) || ''
}

/** Candidate jump targets for the linear editor's timeout: every OTHER step, keyed + business-labeled
 *  by its stable draft `localId` (never the position-based node key, which is unstable across a
 *  reorder — see `buildStepTimeoutConfig`'s resolution comment). */
function timeoutJumpStepOptions(currentStepLocalId: string): Array<{ localId: string; label: string }> {
  return draft.value.steps
    .filter((candidate) => candidate.localId !== currentStepLocalId)
    .map((candidate, index) => ({ localId: candidate.localId, label: candidate.name.trim() || `审批人 ${index + 1}` }))
}

// Lock-1 §K2: a scope-type switch clears the shared idsText carrier deliberately — userIds and
// roleIds are different id domains, so carrying one list into the other would author wrong config.
function setStepRequesterChoiceScopeType(step: ApprovalStepDraft, type: 'company' | 'members' | 'role'): void {
  if (step.requesterChoiceScopeType === type) return
  step.requesterChoiceScopeType = type
  step.idsText = ''
}

async function onUserSearch(query: string): Promise<void> {
  await directory.searchUsers(query)
  // Keep already-selected ids visible as chips even if the new search page omits them —
  // across linear steps, complex approval nodes, and CC user targets.
  for (const step of draft.value.steps) {
    if (step.sourceKind !== 'static_user') continue
    for (const id of parseIdsText(step.idsText)) directory.ensureUserOptionVisible(id)
  }
  // P1-B: a node may carry N cards now — sync EVERY card's chips, not just card 0.
  for (const nodeKey of Object.keys(draft.value.approvalNodeEdits ?? {})) syncApprovalNodeOptions(nodeKey)
  for (const nodeKey of Object.keys(draft.value.ccEdits ?? {})) {
    const edit = ccEditFor(nodeKey)
    if (!edit || edit.targetType !== 'user') continue
    for (const id of edit.targetIds) directory.ensureUserOptionVisible(id)
  }
}

// On sourceKind change (and on hydrate) make every already-selected id render as a chip,
// even pre-existing / unknown ids absent from the fetched directory page — no silent drop.
function syncStepOptions(step: ApprovalStepDraft): void {
  if (step.sourceKind === 'static_user') {
    for (const id of parseIdsText(step.idsText)) directory.ensureUserOptionVisible(id)
  } else if (step.sourceKind === 'static_role') {
    for (const id of parseIdsText(step.idsText)) directory.ensureRoleOptionVisible(id)
  } else if (step.sourceKind === 'requester_choice') {
    // §K2: the scope id list rides idsText — keep its chips visible per scope type.
    if (step.requesterChoiceScopeType === 'members') {
      for (const id of parseIdsText(step.idsText)) directory.ensureUserOptionVisible(id)
    } else if (step.requesterChoiceScopeType === 'role') {
      for (const id of parseIdsText(step.idsText)) directory.ensureRoleOptionVisible(id)
    }
  } else if (step.sourceKind === 'user_group') {
    // Lock-1 §K1: keep an authored group id visible even if it fell off the CURRENT bound page.
    for (const id of step.groupIds) directory.ensureMemberGroupOptionVisible(id)
  }
}

function syncAllStepOptions(): void {
  for (const step of draft.value.steps) syncStepOptions(step)
}

// G-B2-18: same hydrate-time visibility sync as syncStepOptions, applied to complex-graph
// approval-node assignee sources (approvalNodeEdits is keyed by nodeKey). P1-B: loops EVERY card on
// the node — a node with N sources needs N cards' worth of chips kept visible, not just card 0.
function syncApprovalNodeOptions(nodeKey: string): void {
  const edit = approvalNodeEditFor(nodeKey)
  if (!edit) return
  edit.assigneeSources.forEach((source, sourceIndex) => {
    const kind = source.kind
    if (kind === 'static_user') {
      for (const id of approvalSourceIds(nodeKey, sourceIndex)) directory.ensureUserOptionVisible(id)
    } else if (kind === 'static_role') {
      for (const id of approvalSourceIds(nodeKey, sourceIndex)) directory.ensureRoleOptionVisible(id)
    } else if (kind === 'requester_choice') {
      // §K2: keep the configured scope list's chips visible in the sub-form pickers.
      if (source.scope.type === 'members') {
        for (const id of source.scope.userIds) directory.ensureUserOptionVisible(id)
      } else if (source.scope.type === 'role') {
        for (const id of source.scope.roleIds) directory.ensureRoleOptionVisible(id)
      }
    } else if (kind === 'user_group') {
      // Lock-1 §K1: keep an authored group id visible even if it fell off the CURRENT bound
      // page (e.g. a stale unbind mid-edit) — same placeholder-synthesis posture as above.
      for (const id of approvalSourceGroupIds(nodeKey, sourceIndex)) directory.ensureMemberGroupOptionVisible(id)
    }
  })
}

function syncAllApprovalNodeOptions(): void {
  for (const nodeKey of Object.keys(draft.value.approvalNodeEdits ?? {})) syncApprovalNodeOptions(nodeKey)
}

function setCcTargetIds(nodeKey: string, ids: string[]): void {
  const edit = ccEditFor(nodeKey)
  if (!edit) return
  edit.targetIds = ids
  syncCcOptions(nodeKey)
}

function syncCcOptions(nodeKey: string): void {
  const edit = ccEditFor(nodeKey)
  if (!edit) return
  if (edit.targetType === 'user') {
    for (const id of edit.targetIds) directory.ensureUserOptionVisible(id)
  } else {
    for (const id of edit.targetIds) directory.ensureRoleOptionVisible(id)
  }
}

function syncAllCcOptions(): void {
  for (const nodeKey of Object.keys(draft.value.ccEdits ?? {})) syncCcOptions(nodeKey)
}

// Canvas V2 Slice A: list + canvas inspector inject the SAME handlers (one draft source of truth).
const nodeConfigEditorApi: ApprovalNodeConfigEditorApi = {
  readOnly,
  conditionEditFor,
  parallelEditFor,
  ccEditFor,
  approvalNodeEditFor,
  conditionFieldOptions,
  userFields,
  conditionFormulaInsertOptions,
  fieldPermissionFields,
  conditionOperatorLabel,
  liveBranchSummary,
  conditionRuleValueText,
  setConditionRuleValue,
  addConditionRule,
  removeConditionRule,
  setConditionBranchPredicateMode,
  insertConditionFormulaToken,
  insertConditionFormulaFunction,
  insertConditionFormulaRoleMembership,
  conditionFormulaDryRunResult,
  conditionFormulaDryRunLoading,
  dryRunConditionFormula,
  conditionOutgoingEdgeKeys,
  conditionEdgeLabel,
  graphEdgeTargetLabel,
  graphNodeLabel,
  // Lock-1 §K3: legal upstream candidates for the prior_node_approver typed node picker.
  priorApproverNodeOptions,
  parallelJoinModeLabel,
  ccTargetTypeLabel,
  approvalSourceKind,
  setApprovalSourceKind,
  syncApprovalNodeOptions,
  approvalSourceIds,
  setApprovalSourceIdsFromPicker,
  // Lock-1 §K1: the user_group source's dedicated id carrier.
  approvalSourceGroupIds,
  setApprovalSourceGroupIds,
  setCcTargetIds,
  syncCcOptions,
  approvalSourceFieldId,
  setApprovalSourceFieldId,
  approvalSourceLevel,
  setApprovalSourceLevel,
  approvalSourceIsPlaceholder,
  approvalSourceCount,
  addApprovalSourceCard,
  removeApprovalSourceCard,
  approvalNodeMode,
  setApprovalNodeMode,
  approvalNodeThreshold,
  setApprovalNodeThreshold,
  approvalNodeInParallelRegion,
  approvalNodeEmptyPolicy,
  setApprovalNodeEmptyPolicy,
  approvalNodeMergeWithRequester,
  setApprovalNodeMergeWithRequester,
  approvalNodeTimeout,
  setApprovalNodeTimeoutEnabled,
  setApprovalNodeTimeoutAfterMinutes,
  setApprovalNodeTimeoutEffect,
  setApprovalNodeTimeoutTransferToUserId,
  setApprovalNodeTimeoutJumpToNodeKey,
  setApprovalNodeTimeoutUnit,
  timeoutJumpTargetOptions,
  handlerNodeMode,
  setHandlerNodeMode,
  handlerNodeOpinionRequired,
  setHandlerNodeOpinionRequired,
  approvalNodeFieldAccess,
  setApprovalNodeFieldAccess,
  nodeConfigSummary,
  // Gate P2-1/D5: the graph-wide computed above (unions `draft.steps` + `draft.approvalNodeEdits`),
  // not a node-local approximation — see that computed's comment for why a node-local read would be
  // a narrower predicate than the linear editor's.
  routingDriverFieldIds,
  onUserSearch,
  directoryUsers: directory.users,
  directoryUsersLoading: directory.usersLoading,
  directoryRoles: directory.roles,
  formulaRoles: directory.formulaRoles,
  // Lock-1 §K1: org-scoped bound-group picker options + loading flag + label formatter.
  memberGroupOptions: directory.memberGroups,
  memberGroupOptionsLoading: directory.memberGroupsLoading,
  formatMemberGroupLabel: directory.formatMemberGroupLabel,
  formatUserLabel: directoryUserDisplayLabel,
  formatRoleLabel: directoryRoleDisplayLabel,
}
provide(APPROVAL_NODE_CONFIG_EDITOR_KEY, nodeConfigEditorApi)

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

// NOTE (Lock-8 L8-B, approval-lock8-field-vocabulary-20260817.md §2.6): this view's own copy of
// the label/mark/group literals CANNOT be collapsed onto the F2 Designer 2.0 palette component's
// (apps/web/src/approvals/components/ApprovalForm + Palette.vue, split across this comment on
// purpose) shipped constants — the F2 no-mount-pin gate (approval-form-builder-slots.spec.ts)
// source-scans every file under src/views for that literal component name and fails the build if
// it appears, even as an import of its exported constants. This stays a SECOND, non-derived
// registration site the F2 forcing-function test (approval-form-palette-chips.spec.ts:107) does
// NOT cover — and neither did approval-date-range-field.test.ts's own "census" (correction, gate
// P2-1: an earlier version of this comment claimed that file checked THIS array; it only ever
// re-read the F2 component's own APPROVAL_FORM_PALETTE_GROUPS, never `fieldPaletteGroups` below —
// deleting `explanation` from this array alone left every then-reachable spec green). This array's
// completeness against AUTHORABLE_FIELD_TYPES is covered by a REAL mount of this view (not a
// duplicated literal): apps/web/tests/approval-form-inline-editor-extract.spec.ts's "(o) MS-13
// completeness" test queries the rendered `approval-field-palette-*` chip DOM directly.
const FIELD_PALETTE_LABELS: Record<AuthorableFieldType, string> = {
  text: '文本',
  textarea: '多行文本',
  number: '数字',
  date: '日期',
  datetime: '日期时间',
  select: '单选',
  'multi-select': '多选',
  user: '人员',
  detail: '明细',
  'record-link': '关联记录',
  date_range: '日期区间',
  explanation: '说明',
}
const FIELD_PALETTE_MARKS: Record<AuthorableFieldType, string> = {
  text: 'A',
  textarea: 'Aa',
  number: '123',
  date: '日',
  datetime: '时',
  select: '○',
  'multi-select': '☑',
  user: '人',
  detail: '表',
  'record-link': '链',
  date_range: '区',
  explanation: '明',
}
// Lock-8 L8-A (§2.6): the group needs an owner decision — placed in 其他 as a REVERSIBLE
// presentation choice (goal-set provenance; see this repo's execution ledger §3), not a ratified
// OD-L8-3 group. Same choice as the F2 Designer 2.0 palette component's independent copy
// (apps/web/src/approvals/components/ApprovalForm + Palette.vue, split across this comment on
// purpose — see that file's own doc comment for why the literal name can't appear here whole).
const fieldPaletteGroups = [
  { id: 'text', label: '文本', types: ['text', 'textarea'] },
  { id: 'number', label: '数值', types: ['number'] },
  { id: 'choice', label: '选项', types: ['select', 'multi-select'] },
  { id: 'date', label: '日期', types: ['date', 'datetime', 'date_range'] },
  { id: 'other', label: '其他', types: ['user', 'detail', 'record-link', 'explanation'] },
].map((group) => ({
  ...group,
  entries: group.types.map((type) => ({
    type: type as AuthorableFieldType,
    label: FIELD_PALETTE_LABELS[type as AuthorableFieldType],
    mark: FIELD_PALETTE_MARKS[type as AuthorableFieldType],
  })),
}))
const paletteDragType = ref<AuthorableFieldType | null>(null)
function onPaletteDragStart(type: AuthorableFieldType, event: DragEvent): void {
  if (readOnly.value) {
    event.preventDefault()
    return
  }
  paletteDragType.value = type
  event.dataTransfer?.setData('text/plain', type)
}
function onPreviewDrop(event: DragEvent): void {
  event.preventDefault()
  const type = paletteDragType.value
  paletteDragType.value = null
  if (type) addFieldOfType(type)
}

function addField() {
  if (readOnly.value) return
  const added = createEmptyFieldDraft(draft.value.fields.length + 1)
  // Structural push carries focusLocalId so undo restores prior focus (#4815).
  applyFormFieldsStructural([...draft.value.fields, added], added.localId)
  void focusFormFieldRow(added.localId)
}

/** D6-f2 palette: add a field of the chosen kind without ordinary-user ID entry. */
function addFieldOfType(type: AuthorableFieldType) {
  if (readOnly.value) return
  const next = createEmptyFieldDraft(draft.value.fields.length + 1)
  next.type = type
  next.label = FIELD_PALETTE_LABELS[type]
  if (type === 'detail') {
    next.detailColumns = [{
      localId: `col_${next.localId}`,
      id: `${next.id}_col1`,
      type: 'text',
      label: '子字段 1',
      required: false,
      optionsText: '',
    }]
  }
  // Structural push sets form history focusLocalId to the new field; UI selection follows.
  applyFormFieldsStructural([...draft.value.fields, next], next.localId)
  void focusFormFieldRow(next.localId)
}

function removeField(index: number) {
  if (readOnly.value || draft.value.fields.length === 1) return
  const removed = draft.value.fields[index]
  const nextFields = draft.value.fields.filter((_, i) => i !== index)
  const nextFocus = removed && formFieldFocusLocalId.value === removed.localId
    ? (nextFields[Math.min(index, nextFields.length - 1)]?.localId ?? null)
    : formFieldFocusLocalId.value
  applyFormFieldsStructural(nextFields, nextFocus)
}

function moveField(index: number, delta: -1 | 1) {
  if (readOnly.value) return
  const next = swap(draft.value.fields, index, delta)
  if (!next) return
  applyFormFieldsStructural(next, draft.value.fields[index]?.localId ?? formFieldFocusLocalId.value)
}
// D-4 drag-reorder: native HTML5 drag wires to the pure `moveItemToIndex` logic. (The drag GESTURE is
// manual/E2E QA — jsdom DragEvent is unreliable; the reorder LOGIC is unit-covered in templateAuthoring.)
const draggedFieldIndex = ref<number | null>(null)
function onFieldDragStart(index: number) {
  if (!readOnly.value) draggedFieldIndex.value = index
}
function onFieldDrop(index: number) {
  if (readOnly.value) return
  if (paletteDragType.value) {
    const type = paletteDragType.value
    paletteDragType.value = null
    addFieldOfType(type)
    return
  }
  if (draggedFieldIndex.value === null) return
  const from = draggedFieldIndex.value
  draggedFieldIndex.value = null
  if (from === index) return
  const next = moveItemToIndex(draft.value.fields, from, index)
  applyFormFieldsStructural(next, next[index]?.localId ?? formFieldFocusLocalId.value)
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
  const created = createEmptyDetailColumnDraft(field.detailColumns.length + 1)
  // Collision guard (owner-reported bug, 2026-08-24): `length + 1` assumes ids stay densely
  // packed 1..N, but a delete-then-add sequence breaks that invariant — e.g.
  // [col_1, col_2, col_3] -> delete col_2 (index 1) -> [col_1, col_3] (length 2) -> `length + 1`
  // recomputes "col_3", which the SURVIVING third column already holds -> save-blocking
  // "子字段 id 不能重复", plus a confusing "子字段 N" auto-label once N drifts arbitrarily far
  // ahead of the visible row count over repeated add/delete cycles. `createEmptyDetailColumnDraft`
  // itself stays frozen — its single-argument output is a pinned baseline
  // (approval-form-builder-parity-delta-design-20260811.md §F1 "Protected baseline", pinned
  // byte-for-byte by approval-form-authoring-adapter.test.ts) that the Designer 2.0 opaque
  // allocator depends on staying untouched. Only the CONSTRUCTED draft returned from this call is
  // patched here, scanning forward past any id this field's OWN detailColumns already uses before
  // it is pushed — the call above, and its frozen output, are unchanged.
  const existingIds = new Set(field.detailColumns.map((column) => column.id))
  let candidateIndex = field.detailColumns.length + 1
  while (existingIds.has(`col_${candidateIndex}`)) {
    candidateIndex += 1
  }
  created.id = `col_${candidateIndex}`
  created.label = `子字段 ${candidateIndex}`
  field.detailColumns = [...field.detailColumns, created]
}

function removeDetailColumn(field: FieldAuthoringDraft, index: number) {
  field.detailColumns = field.detailColumns.filter((_, i) => i !== index)
}

// Visibility-rule depends-on options: other fields that have an id (excludes self).
// FWB-0 Layer 2 P1-2: record-link / detail cannot be visibility dependencies (server fail-closed).
// Lock-8 L8-B OD-L8-5(a) [R]: date_range is never offered as a single bare dependency (its
// `{start,end}` value is non-scalar — server rejects it, matching record-link/detail) but its two
// ENDPOINTS are separately selectable, each producing the dotted `${fieldId}.start`/`.end` address
// `resolveVisibilityFieldReference` (ApprovalGraphExecutor.ts / fieldVisibility.ts) resolves at
// runtime and `validateFormFieldVisibilityRules` accepts at publish. M7: this is what makes the
// `dateRangeVisibilityEndpointOptions` affordance reachable — without it, selecting a date_range
// field here would either be impossible (silent narrowing to OD-L8-5(c)) or always fail publish
// (an inert control worse than absence).
function visibilityFieldOptions(current: FieldAuthoringDraft) {
  const options: Array<{ localId: string; id: string; label: string }> = []
  for (const field of draft.value.fields) {
    if (field.localId === current.localId) continue
    if (!field.id.trim()) continue
    if (field.type === 'record-link' || field.type === 'detail') continue
    // Lock-8 L8-A (§1.1): explanation carries no value at all — never offered, bare or dotted (it
    // has no endpoints, unlike date_range).
    if (field.type === 'explanation') continue
    if (field.type === 'date_range') {
      const fieldId = field.id.trim()
      const label = fieldDisplayLabel(field)
      for (const endpoint of dateRangeVisibilityEndpointOptions(field.type)) {
        options.push({
          localId: `${field.localId}#${endpoint.endpoint}`,
          id: dateRangeVisibilityFieldId(fieldId, endpoint.endpoint),
          label: `${label}(${endpoint.label})`,
        })
      }
      continue
    }
    options.push({ localId: field.localId, id: field.id.trim(), label: fieldDisplayLabel(field) })
  }
  return options
}

/**
 * When a field is retyped to/from record-link (or detail), drop stale visibility deps and
 * condition rules that referenced it — otherwise the UI would keep a now-illegal dependency
 * that only fails at server save.
 *
 * Lock-8 L8-B: date_range needs BOTH directions handled, unlike record-link/detail which only
 * need the "became banned" direction (nothing could validly have depended on them before, since
 * they were never offered by visibilityFieldOptions/conditionFieldOptions). date_range's
 * endpoints ARE validly selectable while the field IS date_range, so retyping AWAY from
 * date_range can orphan a dotted `${id}.start`/`.end` dependency — that direction is checked via
 * `visibilityReferenceBaseFieldId` (base-id match with a dotted suffix) rather than an exact
 * string match, and is only cleared when the field is no longer date_range.
 */
function invalidateStaleRecordLinkDependencies(changedField: FieldAuthoringDraft) {
  const changedId = changedField.id.trim()
  if (!changedId) return
  const bareBanned =
    changedField.type === 'record-link'
    || changedField.type === 'detail'
    || changedField.type === 'date_range'
    // Lock-8 L8-A (§1.1): explanation matches record-link/detail's ONE-direction shape — nothing
    // could ever validly have depended on it, so only "became explanation" needs clearing.
    || changedField.type === 'explanation'
  const stillDateRange = changedField.type === 'date_range'
  for (const field of draft.value.fields) {
    const dependsOn = field.visibility.dependsOnFieldId.trim()
    if (!dependsOn) continue
    const baseId = visibilityReferenceBaseFieldId(dependsOn)
    if (baseId !== changedId) continue
    const isDottedEndpoint = baseId !== dependsOn
    const shouldClear = isDottedEndpoint ? !stillDateRange : bareBanned
    if (shouldClear) {
      field.visibility = { dependsOnFieldId: '', operator: 'eq', valueText: '' }
    }
  }
  if (bareBanned && draft.value.conditionEdits) {
    for (const edit of Object.values(draft.value.conditionEdits)) {
      for (const branch of edit.branches) {
        for (const rule of branch.rules) {
          if (rule.fieldId.trim() === changedId) {
            rule.fieldId = ''
          }
        }
      }
    }
  }
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
  selectedCanvasNode.value = null
  movingCanvasNode.value = null
  canvasZoom.value = 1
  if (!isEditMode.value) {
    draft.value = createEmptyTemplateDraft()
    unsupportedReason.value = null
    graphReadOnlyMessage.value = null
    formFieldFocusLocalId.value = null
    templateLatestVersionId.value = null
    reseedCanvasHistoryFromDraft()
    reseedFormHistoryFromDraft()
    snapshotDraft()
    // F4 hydration gate: a NEW template's starter draft is available synchronously (no fetch) —
    // seed the v2 session in the SAME tick, before first paint, so there is no builder-mounts-empty
    // flash even for a brand-new template.
    formSessionHydrated.value = true
    return
  }
  loading.value = true
  loadError.value = null
  try {
    const template = await getTemplate(templateId.value)
    unsupportedReason.value = unsupportedTemplateAuthoringReason(template)
    graphReadOnlyMessage.value = graphReadOnlyReason(template)
    draft.value = draftFromTemplate(template)
    formFieldFocusLocalId.value = null
    templateLatestVersionId.value = template.latestVersionId
    syncAllStepOptions()
    syncAllApprovalNodeOptions()
    syncAllCcOptions()
    reseedCanvasHistoryFromDraft()
    reseedFormHistoryFromDraft()
    snapshotDraft()
  } catch (error: unknown) {
    loadError.value = describeTemplateAuthoringError(error, '加载审批模板失败')
  } finally {
    loading.value = false
    // F4 hydration gate: set exactly ONCE per view instance, success or failure — `draft.value`
    // holds whatever the load produced (the real template, or the pre-existing empty fallback on
    // failure) and `ApprovalFormBuilder` seeds from it here for the first and only time. A later
    // `draft.value` reassignment (e.g. after save) never re-triggers this — see
    // `reseedFormBuilderSessionIfActive` for the ONE deliberate, explicit resync path.
    formSessionHydrated.value = true
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

// B0 (owner-approved draft-save UX slice, 20260824): 保存草稿 no longer runs PUBLISH-grade
// validation — it runs only the SAVE-BLOCKING minimum, i.e. what the backend actually 400s on
// `createTemplate`/`updateTemplate` (see `validateTemplateFormFields`/`validateTemplateApprovalFlow`'s
// `{ minimal: true }` doc comments in templateAuthoring.ts for the exact, evidence-cited server
// reject-set). No record-link catalog fetch is needed here at all — the catalog/pin-mismatch check
// is a publish-time-only concern server-side, so a plain draft save never awaits that network call.
// `key`/`name` are auto-seeded (never blocked) since both are `NOT NULL` server-side but the
// reference product never makes an author type them before saving (see
// `seedDraftIdentityForSave`'s doc comment for the collision-safety reasoning).
//
// `openPublishChecklist`/`confirmPublish` are UNTOUCHED — they keep gating on the full
// `publishChecklist` (`publishFormFieldIssues`/`publishApprovalFlowIssues`/`publishPlaceholderRoleIssues`,
// still `validateTemplateFormFields`/`validateTemplateApprovalFlow` with NO `minimal` flag) before
// ever reaching `persistDraft`, so relaxing what `validate()` itself checks never weakens publish.
async function validate(): Promise<boolean> {
  // Seeding is a NO-OP for existing templates (see seedDraftIdentityForSave — gate P2-1); their
  // blank identity blocks below instead. The save-blocking set has ONE definition —
  // collectTemplateSaveMinimum — and this is its production call site (E-P3).
  draft.value = seedDraftIdentityForSave(draft.value)
  const minimum = collectTemplateSaveMinimum(draft.value, unsupportedReason.value)
  const formErrors = minimum.formErrors
  validationErrors.value = minimum.all
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
      formFieldFocusLocalId.value = null
      templateLatestVersionId.value = updated.latestVersionId
      reseedCanvasHistoryFromDraft()
      reseedFormHistoryFromDraft()
      reseedFormBuilderSessionIfActive()
      snapshotDraft()
      return updated
    }
    const created = await createTemplate(buildCreateTemplatePayload(draft.value))
    draft.value = draftFromTemplate(created)
    unsupportedReason.value = unsupportedTemplateAuthoringReason(created)
    graphReadOnlyMessage.value = graphReadOnlyReason(created)
    formFieldFocusLocalId.value = null
    templateLatestVersionId.value = created.latestVersionId
    reseedCanvasHistoryFromDraft()
    reseedFormHistoryFromDraft()
    reseedFormBuilderSessionIfActive()
    snapshotDraft() // before the route replace so the leave guard stays quiet
    await router.replace({ path: `/approval-templates/${created.id}/edit` })
    return created
  } catch (error: unknown) {
    loadError.value = describeTemplateAuthoringError(error, '保存模板失败')
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
    formFieldFocusLocalId.value = null
    templateLatestVersionId.value = created.latestVersionId
    syncAllStepOptions()
    syncAllApprovalNodeOptions()
    syncAllCcOptions()
    reseedCanvasHistoryFromDraft()
    reseedFormHistoryFromDraft()
    reseedFormBuilderSessionIfActive()
    snapshotDraft() // before the route replace so the leave guard stays quiet
    await router.replace({ path: `/approval-templates/${created.id}/edit` })
    ElMessage.success('模板草稿已创建')
  } catch (error: unknown) {
    loadError.value = describeTemplateAuthoringError(error, '创建常用模板失败')
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
    // Publish-sequencing fix (Lock-6 L6-P1 gate F3 finding, corroborated by an independent
    // component-level probe during P3-B): `policy` is a PUBLISH-ONLY argument — it never travels
    // through the create/update payload OR response (Lock-6 §0: "policy is a PUBLISH argument,
    // never a template/version column"). `persistDraft()` below REPLACES `draft.value` wholesale
    // via `draftFromTemplate(saved)`, re-deriving `allowRevoke` / the L6-A dedup tier from
    // `saved.policy` — which can only ever echo the LAST-PUBLISHED policy (or nothing, for a
    // template that has never published), never an in-progress, not-yet-published edit the admin
    // just made in this same sitting. Reading `draft.value` for the publish payload AFTER
    // `persistDraft()` therefore silently discarded any such edit — the allowRevoke checkbox (and,
    // once added, the L6-A dedup-tier control) worked in the DOM but never reached the server.
    // Fix: snapshot the in-progress policy BEFORE persistDraft() replaces the draft, and publish
    // THAT snapshot. This does not change persistDraft/draftFromTemplate/hydrate behavior at all —
    // an untouched draft's snapshot is byte-identical to what the old post-persistDraft read would
    // have produced, so P-1/P-2 round-trip behavior is unaffected; only an in-session edit now
    // survives to publish.
    const policyToPublish = buildPublishPolicy(draft.value)
    const saved = await persistDraft()
    if (!saved) return
    // B3-09 — whitespace-only normalizes to null server-side; send undefined to keep the wire
    // payload identical to pre-B3-09 publishes when the admin typed nothing.
    const note = publishNote.value.trim()
    await publishTemplate(saved.id, {
      policy: policyToPublish,
      ...(note ? { note } : {}),
    })
    ElMessage.success('模板已发布')
    await router.push({ path: `/approval-templates/${saved.id}` })
  } catch (error: unknown) {
    loadError.value = describeTemplateAuthoringError(error, '发布模板失败')
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
  if (!templateIdForPreview.value) return '请先保存草稿，才能试运行'
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
// (buildFormSchema(draft.value)), so an author never types a sample value the template can't see.
// `detail` (repeating sub-form rows) and `attachment` (no working upload pipeline yet — see
// ApprovalNewView's own honest stopgap) are skipped with an inline note rather than faked; every
// other field type gets a plain input.
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
      label: node.name?.trim() || '未命名节点',
      lines: nodeConfigSummary(node),
    })),
)

onMounted(() => {
  if (!canManageTemplates.value) return
  void directory.loadRoles()
  void directory.loadFormulaRoles()
  // Lock-1 §K1: org-scoped bound-group picker options.
  void directory.loadMemberGroups()
  void loadTemplateForEdit()
  window.addEventListener('resize', syncCanvasViewportState)
})

// B1-07: discard protection — the editor is the longest-lived form in the approval admin
// surface and previously lost all edits on a stray back-click. Route leaves confirm when
// dirty; hard reloads/closures get the browser-native prompt (same pattern as WorkflowDesigner).
onBeforeRouteLeave(async () => {
  // F4 route-level drag-state clearing (delta §5 F4 handoff condition 3): `v-show` keeps the
  // step chrome — and therefore the mounted `ApprovalFormBuilder` — mounted across
  // `activeAuthoringSection` switches, so `onUnmounted`'s existing drag-session clear (F2) only
  // fires on a GENUINE unmount. The dirty-draft confirm below can be CANCELLED (user picks 留下),
  // in which case no unmount ever happens even though a navigation attempt began and any in-flight
  // drag was already visually interrupted. Clearing here — unconditionally, before the dirty
  // check/confirm — covers exactly that gap regardless of whether the navigation proceeds.
  formBuilderRef.value?.getDragSession().clear()
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
  window.removeEventListener('resize', syncCanvasViewportState)
  window.onbeforeunload = null
  if (highlightStepTimer) clearTimeout(highlightStepTimer)
})
</script>

<style scoped>
.template-authoring__actions,
.template-authoring__inline,
.template-authoring__panel-header,
.template-authoring__item-toolbar,
.template-authoring__form-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.template-authoring__actions {
  justify-content: flex-end;
}

/* B0 — header "N项不完善" affordance, next to 保存草稿/发布. */
.template-authoring__incomplete-count {
  color: var(--ms-color-warning);
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

.template-authoring__version-history-link {
  margin-left: var(--ms-space-1);
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
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  gap: var(--ms-space-4);
}

.template-authoring__steps {
  position: sticky;
  top: 72px;
  z-index: 2;
  display: flex;
  justify-content: center;
  align-items: stretch;
  gap: 4px;
  padding: 0 8px;
  border: 0;
  border-bottom: 1px solid var(--ms-border-light);
  border-radius: 0;
  background: var(--ms-bg-page);
  box-shadow: none;
}

.template-authoring__step {
  width: auto;
  height: auto;
  min-height: 48px;
  margin: 0;
  padding: 10px 16px 12px;
  color: var(--ms-text-2);
  white-space: nowrap;
  border-bottom: 2px solid transparent;
  border-radius: 0;
}

.template-authoring__step :deep(> span) {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: auto;
  text-align: left;
}

.template-authoring__step.is-active {
  background: transparent;
  color: var(--ms-color-primary);
  border-bottom-color: var(--ms-color-primary);
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

/* Form palette focus-return: selected field row (formFieldFocusLocalId). */
.template-authoring__item--focused {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 1px var(--el-color-primary-light-5);
}

.template-authoring__item--focused:focus {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
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

/* node-summary is also used by the try-run panel (parent markup). Graph node config editors
   live in ApprovalGraphNodeConfigEditor.vue and carry their own copy of these rules. */
.template-authoring__node-summary {
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--el-text-color-regular);
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
    grid-template-columns: minmax(0, 1fr);
  }

  .template-authoring__steps {
    top: 0;
    justify-content: flex-start;
    overflow-x: auto;
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
    justify-content: flex-start;
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
.template-authoring__canvas-workspace {
  display: flex;
  align-items: stretch;
  gap: 0;
  min-width: 0;
  width: 100%;
  min-height: min(72vh, 760px);
}
/* .template-authoring__form-designer / -palette-pane / -field-palette* /
   -form-preview* / -form-phone* / -form-drop-hint* / -form-inspector-pane and
   their 1100px media query moved to ApprovalFormInlineEditor.vue (F0 extraction,
   delta §5 F0) — exclusive to the extracted three-region shell. */
@media (max-width: 960px) {
  .template-authoring__canvas-workspace {
    flex-direction: column;
  }
}

/* F4 production mount (delta §5 F4, FB-D1/FB-D2): the Designer 2.0 three-region wrapper. The
   palette and `ApprovalFormBuilder` (canvas + inspector) are separate components (§5 F2/F3), so the
   fixed-width palette column and the >=1100px three-region contract are assembled HERE, matching
   the SAME >=1100px / <1100px two-tier breakpoint the extracted legacy shell above already ships
   (there is no shipped third tier at 768px on this baseline to diverge from). `:deep()` reaches
   into the child components' own scoped roots — neither owns a fixed width itself. */
.template-authoring__form-designer-v2 {
  display: flex;
  align-items: stretch;
  gap: 0;
  min-height: min(68vh, 720px);
  margin: -8px -12px -16px;
  border-top: 1px solid var(--el-border-color-lighter);
  max-width: 100%;
}
.template-authoring__form-designer-v2 :deep(.approval-form-palette) {
  flex: 0 0 228px;
  min-width: 0;
  border-right: 1px solid var(--el-border-color-lighter);
}
.template-authoring__form-designer-v2 :deep(.approval-form-builder) {
  flex: 1 1 auto;
  min-width: 0;
  border-radius: 0;
  background: transparent;
}
@media (max-width: 1100px) {
  .template-authoring__form-designer-v2 {
    flex-direction: column;
  }
  .template-authoring__form-designer-v2 :deep(.approval-form-palette) {
    flex: 0 0 auto;
    width: 100%;
    border-right: 0;
    border-bottom: 1px solid var(--el-border-color-lighter);
  }
  .template-authoring__form-designer-v2 :deep(.approval-form-builder) {
    flex-direction: column;
  }
  .template-authoring__form-designer-v2 :deep(.approval-form-builder__inspector) {
    flex: 1 1 auto;
    min-width: 0;
    border-left: 0;
    border-top: 1px solid var(--el-border-color-lighter);
  }
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
