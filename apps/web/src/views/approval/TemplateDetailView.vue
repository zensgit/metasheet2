<template>
  <PageShell width="default">
    <PageHeader
      class="template-detail__header"
      :title="headerTitle"
      back
      :back-label="t.backLabel"
      @back="goBack"
    >
      <template v-if="template" #meta>
        <StatusTag domain="approvalTemplate" :status="template.status" />
      </template>
      <template v-if="template" #actions>
        <el-button
          v-if="template.status === 'published' && canWrite"
          type="primary"
          :loading="store.loading"
          @click="startApproval"
        >
          {{ t.startApproval }}
        </el-button>
        <el-button
          v-if="canManageTemplates"
          data-testid="template-detail-edit-button"
          @click="editTemplate"
        >
          {{ t.editTemplate }}
        </el-button>
        <el-button
          v-if="canManageTemplates && template.status === 'published'"
          :loading="archiving"
          data-testid="template-detail-archive-button"
          @click="handleArchive"
        >
          {{ t.archiveButton }}
        </el-button>
        <el-button
          v-if="canManageTemplates && template.status === 'archived'"
          :loading="archiving"
          data-testid="template-detail-unarchive-button"
          @click="handleUnarchive"
        >
          {{ t.unarchiveButton }}
        </el-button>
      </template>
    </PageHeader>

    <el-alert
      v-if="store.error"
      :title="store.error"
      type="error"
      show-icon
      :closable="true"
      class="template-detail__error"
      @close="store.error = null"
    >
      <template #default>
        <el-button type="primary" link @click="retryLoad">{{ t.reload }}</el-button>
      </template>
    </el-alert>

    <div v-loading="store.loading" class="template-detail__content-wrapper">
      <div v-if="template" class="template-detail__body">
        <!-- Template info -->
        <div class="template-detail__info">
          <p v-if="template.description">{{ template.description }}</p>
          <!--
            Wave 2 WP4 slice 1 — 模板分类. Read-only for non-admins; inline
            editable for `approval-templates:manage`. We intentionally keep
            this as a single field instead of building a full edit mode —
            that broader editor is deferred to a later WP4 slice.
          -->
          <div class="template-detail__category">
            <span class="template-detail__category-label">{{ t.categoryLabel }}</span>
            <template v-if="!editingCategory">
              <el-tag
                v-if="template.category"
                size="small"
                type="info"
                effect="plain"
                data-testid="template-detail-category-tag"
              >
                {{ template.category }}
              </el-tag>
              <span v-else class="template-detail__category-empty" data-testid="template-detail-category-empty">
                {{ t.categoryEmpty }}
              </span>
              <el-button
                v-if="canManageTemplates"
                text
                size="small"
                data-testid="template-detail-category-edit-button"
                class="ms-ml-8"
                @click="beginEditCategory"
              >
                {{ t.edit }}
              </el-button>
            </template>
            <template v-else>
              <el-input
                v-model="categoryDraft"
                size="small"
                :placeholder="t.categoryPlaceholder"
                class="ms-w-240 ms-mr-8"
                maxlength="64"
                data-testid="template-detail-category-input"
                @keyup.enter="saveCategory"
                @keyup.escape="cancelEditCategory"
              />
              <el-button
                type="primary"
                size="small"
                :loading="categorySaving"
                data-testid="template-detail-category-save-button"
                @click="saveCategory"
              >
                {{ t.save }}
              </el-button>
              <el-button
                size="small"
                :disabled="categorySaving"
                data-testid="template-detail-category-cancel-button"
                @click="cancelEditCategory"
              >
                {{ t.cancel }}
              </el-button>
            </template>
          </div>
          <div class="template-detail__visibility">
            <span class="template-detail__category-label">{{ t.visibilityLabel }}</span>
            <template v-if="!editingVisibility">
              <el-tag size="small" effect="plain" data-testid="template-detail-visibility-tag">
                {{ visibilityScopeLabel(template.visibilityScope) }}
              </el-tag>
              <span
                v-if="template.visibilityScope.type !== 'all'"
                class="template-detail__visibility-ids"
                data-testid="template-detail-visibility-ids"
              >
                {{ visibilityScopeIdsDisplay(template.visibilityScope) }}
              </span>
              <el-button
                v-if="canManageTemplates"
                text
                size="small"
                data-testid="template-detail-visibility-edit-button"
                class="ms-ml-8"
                @click="beginEditVisibility"
              >
                {{ t.edit }}
              </el-button>
            </template>
            <template v-else>
              <el-select
                v-model="visibilityTypeDraft"
                size="small"
                class="ms-w-120 ms-mr-8"
                data-testid="template-detail-visibility-type"
              >
                <el-option :label="t.unitAll" value="all" />
                <el-option :label="t.unitDept" value="dept" />
                <el-option :label="t.unitRole" value="role" />
                <el-option :label="t.unitUser" value="user" />
              </el-select>
              <el-input
                v-model="visibilityIdsDraft"
                size="small"
                :placeholder="t.visibilityIdsPlaceholder"
                class="ms-w-320 ms-mr-8"
                :disabled="visibilityTypeDraft === 'all'"
                data-testid="template-detail-visibility-ids-input"
                @keyup.enter="saveVisibility"
                @keyup.escape="cancelEditVisibility"
              />
              <el-button
                type="primary"
                size="small"
                :loading="visibilitySaving"
                data-testid="template-detail-visibility-save-button"
                @click="saveVisibility"
              >
                {{ t.save }}
              </el-button>
              <el-button
                size="small"
                :disabled="visibilitySaving"
                data-testid="template-detail-visibility-cancel-button"
                @click="cancelEditVisibility"
              >
                {{ t.cancel }}
              </el-button>
            </template>
          </div>
          <!--
            Wave 2 WP5 slice 1 — 模板 SLA. Positive integer hours or null
            (留空). Visible to all; inline editable by admins.
          -->
          <div class="template-detail__sla">
            <span class="template-detail__category-label">{{ t.slaLabel }}</span>
            <template v-if="!editingSla">
              <el-tag
                v-if="template.slaHours !== null && template.slaHours !== undefined"
                size="small"
                type="warning"
                effect="plain"
                data-testid="template-detail-sla-tag"
              >
                {{ template.slaHours }}
              </el-tag>
              <span v-else class="template-detail__category-empty" data-testid="template-detail-sla-empty">
                {{ t.slaEmpty }}
              </span>
              <el-button
                v-if="canManageTemplates"
                text
                size="small"
                data-testid="template-detail-sla-edit-button"
                class="ms-ml-8"
                @click="beginEditSla"
              >
                {{ t.edit }}
              </el-button>
            </template>
            <template v-else>
              <el-input-number
                v-model="slaDraft"
                :min="1"
                :max="8760"
                size="small"
                class="ms-w-160 ms-mr-8"
                data-testid="template-detail-sla-input"
                :placeholder="t.slaPlaceholder"
                :controls="false"
              />
              <el-button
                type="primary"
                size="small"
                :loading="slaSaving"
                data-testid="template-detail-sla-save-button"
                @click="saveSla"
              >
                {{ t.save }}
              </el-button>
              <el-button
                size="small"
                :disabled="slaSaving"
                data-testid="template-detail-sla-cancel-button"
                @click="cancelEditSla"
              >
                {{ t.cancel }}
              </el-button>
            </template>
          </div>
          <div class="template-detail__meta">
            <span>{{ t.metaKeyLabel }} {{ template.key }}</span>
            <span>{{ t.metaVersionLabel }} {{ template.activeVersionId ?? t.metaVersionNone }}</span>
            <span>{{ t.metaCreatedLabel }} {{ formatDate(template.createdAt) }}</span>
            <span>{{ t.metaUpdatedLabel }} {{ formatDate(template.updatedAt) }}</span>
          </div>
        </div>

        <div class="template-detail__content">
          <!-- Form schema section -->
          <div class="template-detail__section">
            <h2>{{ t.formFieldsHeading }}</h2>
            <el-table :data="template.formSchema.fields" class="ms-w-100pct" max-height="400" stripe>
              <el-table-column prop="label" :label="t.colFieldName" min-width="160" />
              <el-table-column :label="t.colType" width="120">
                <template #default="{ row }">
                  <el-tag size="small">{{ fieldTypeLabel(row.type) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column :label="t.colRequired" width="80">
                <template #default="{ row }">
                  <el-tag v-if="row.required" type="danger" size="small">{{ t.colRequired }}</el-tag>
                  <span v-else>-</span>
                </template>
              </el-table-column>
              <el-table-column prop="placeholder" :label="t.colPlaceholder" min-width="160">
                <template #default="{ row }">
                  {{ row.placeholder ?? '-' }}
                </template>
              </el-table-column>
              <el-table-column :label="t.colOptions" min-width="200">
                <template #default="{ row }">
                  <span v-if="row.options && row.options.length">
                    {{ row.options.map((o: any) => o.label).join(', ') }}
                  </span>
                  <span v-else>-</span>
                </template>
              </el-table-column>
              <template #empty>
                <el-empty :description="t.emptyFormFields" :image-size="60" />
              </template>
            </el-table>
          </div>

          <div class="template-detail__section">
            <h2>{{ t.visibilityRulesHeading }}</h2>
            <el-empty
              v-if="visibilityRuleSummaries.length === 0"
              :description="t.emptyVisibilityRules"
              :image-size="60"
            />
            <el-table v-else :data="visibilityRuleSummaries" class="ms-w-100pct" stripe>
              <el-table-column :label="t.colField" min-width="160">
                <template #default="{ row }">
                  {{ row.field.label }}
                </template>
              </el-table-column>
              <el-table-column :label="t.colRuleSummary" min-width="260">
                <template #default="{ row }">
                  {{ row.summary }}
                </template>
              </el-table-column>
            </el-table>
          </div>

          <!-- Approval graph section -->
          <div class="template-detail__section">
            <h2>{{ t.approvalGraphHeading }}</h2>
            <el-timeline v-if="template.approvalGraph.nodes.length">
              <el-timeline-item
                v-for="node in template.approvalGraph.nodes"
                :key="node.key"
                :type="nodeTimelineType(node.type)"
                :icon="nodeTimelineIcon(node.type)"
                size="large"
              >
                <div class="template-detail__node-content">
                  <strong>{{ node.name ?? node.key }}</strong>
                  <el-tag size="small" :type="nodeTagType(node.type)">
                    {{ nodeTypeLabel(node.type) }}
                  </el-tag>
                  <span
                    v-if="'assigneeType' in node.config && node.config.assigneeType"
                    class="template-detail__node-assignee"
                  >
                    {{ (node.config as any).assigneeType === 'role' ? t.unitRole : t.unitUser }}:
                    {{ legacyAssigneeIdsDisplay((node.config as any).assigneeType, (node.config as any).assigneeIds) }}
                  </span>
                  <el-tag
                    v-if="node.type === 'approval' && (node.config as any).approvalMode"
                    size="small"
                    class="template-detail__node-mode"
                  >
                    {{ approvalModeLabel((node.config as any).approvalMode) }}<template v-if="(node.config as any).approvalMode === 'threshold' && Number.isInteger((node.config as any).approvalThreshold)">{{ approveThresholdText((node.config as any).approvalThreshold) }}</template>
                  </el-tag>
                  <el-tag
                    v-if="node.type === 'approval' && (node.config as any).emptyAssigneePolicy"
                    size="small"
                    :type="(node.config as any).emptyAssigneePolicy === 'auto-approve' ? 'success' : 'danger'"
                    class="template-detail__node-policy"
                  >
                    {{ emptyAssigneePolicyLabel((node.config as any).emptyAssigneePolicy) }}
                  </el-tag>
                  <!-- P1-C: business-label-only timeout indicator — never the raw effect enum string,
                       a user id, or a node key (master §P1-C G1-p exit bullet 4). -->
                  <el-tag
                    v-if="node.type === 'approval' && nodeTimeoutEffectLabel((node.config as any).timeout?.effect)"
                    size="small"
                    type="info"
                    class="template-detail__node-timeout"
                  >
                    {{ nodeTimeoutEffectLabel((node.config as any).timeout.effect) }}{{ timeoutMinutesText((node.config as any).timeout.afterMinutes) }}
                  </el-tag>
                </div>
              </el-timeline-item>
            </el-timeline>
            <el-empty v-else :description="t.emptyApprovalNodes" :image-size="60" />
          </div>

          <!-- B3-09 (模板治理 — 版本历史): admin-only (the endpoint sits behind the same
               template-admin guard as publish/archive; non-admins never fetch, so no 403 noise).
               Summary rows only — full schema/graph of one version stays an on-demand detail
               fetch, not part of this list. -->
          <div
            v-if="canManageTemplates"
            class="template-detail__section"
            data-testid="template-detail-version-history"
          >
            <h2>{{ t.versionHistoryHeading }}</h2>
            <el-alert
              v-if="versionHistoryError"
              type="warning"
              :title="versionHistoryError"
              :closable="false"
            />
            <el-table
              v-else
              :data="versionHistory"
              class="ms-w-100pct"
              max-height="320"
              stripe
            >
              <el-table-column :label="t.colVersion" :width="isNarrowViewport ? 72 : 90">
                <template #default="{ row }">v{{ row.version }}</template>
              </el-table-column>
              <el-table-column :label="t.colVersionStatus" :width="isNarrowViewport ? 120 : 140">
                <template #default="{ row }">
                  <el-tag size="small" :type="versionStatusTagType(row.status)">
                    {{ versionStatusLabel(row.status) }}
                  </el-tag>
                  <el-tag
                    v-if="row.publishedDefinitionId"
                    size="small"
                    type="success"
                    class="template-detail__version-active-tag"
                  >
                    {{ t.activeTag }}
                  </el-tag>
                  <el-tag
                    v-if="row.restoredFromVersionId"
                    size="small"
                    type="warning"
                    class="template-detail__version-source-tag"
                  >
                    {{ t.restoredFromPrefix }}{{ restoredSourceLabel(row.restoredFromVersionId) }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column v-if="!isNarrowViewport" :label="t.colPublishNote" min-width="240">
                <template #default="{ row }">
                  <span v-if="row.publishNote" class="template-detail__version-note">{{ row.publishNote }}</span>
                  <span v-else>-</span>
                </template>
              </el-table-column>
              <el-table-column v-if="!isNarrowViewport" :label="t.colVersionUpdated" width="180">
                <template #default="{ row }">{{ formatDate(row.updatedAt) }}</template>
              </el-table-column>
              <el-table-column
                :label="t.colVersionActions"
                :width="isNarrowViewport ? 142 : 190"
                :fixed="isNarrowViewport ? undefined : 'right'"
              >
                <template #default="{ row }">
                  <el-button
                    link
                    type="primary"
                    :icon="View"
                    :loading="versionDiffLoading && selectedVersionId === row.id"
                    :data-testid="`template-version-compare-${row.id}`"
                    @click="openVersionDiff(row)"
                  >
                    {{ t.viewChanges }}
                  </el-button>
                  <el-button
                    v-if="row.id !== template.latestVersionId"
                    link
                    type="warning"
                    :icon="RefreshLeft"
                    :loading="restoringVersionId === row.id"
                    :data-testid="`template-version-restore-${row.id}`"
                    @click="handleRestoreVersion(row)"
                  >
                    {{ t.restore }}
                  </el-button>
                </template>
              </el-table-column>
              <template #empty>
                <el-empty :description="t.emptyVersionHistory" :image-size="60" />
              </template>
            </el-table>

            <div
              v-if="selectedVersionId"
              v-loading="versionDiffLoading"
              class="template-detail__version-diff"
              data-testid="template-version-diff"
            >
              <div class="template-detail__version-diff-header">
                <div>
                  <h3>{{ versionDiffTitle }}</h3>
                  <span v-if="selectedVersion?.restoredFromVersionId" class="template-detail__version-source">
                    {{ t.restoredFromPrefix }}{{ restoredSourceLabel(selectedVersion.restoredFromVersionId) }}
                  </span>
                </div>
                <el-button
                  circle
                  text
                  :icon="Close"
                  :title="t.closeDiffTitle"
                  :aria-label="t.closeDiffTitle"
                  @click="closeVersionDiff"
                />
              </div>
              <template v-if="versionDiff">
                <div class="template-detail__version-diff-summary" data-testid="template-version-read-summary">
                  <span>{{ t.diffFieldsLabel }}{{ versionDiff.fieldChanges }}</span>
                  <span>{{ t.diffNodesLabel }}{{ versionDiff.nodeChanges }}</span>
                  <span>{{ t.diffEdgesLabel }}{{ versionDiff.edgeChanges }}</span>
                  <p
                    v-if="versionReadSummary"
                    class="template-detail__version-read-summary-line"
                    data-testid="template-version-read-summary-line"
                  >
                    {{ versionReadSummary.lines[0] }}
                  </p>
                  <p
                    v-if="versionReadSummary?.overlay"
                    class="template-detail__version-read-summary-overlay"
                    data-testid="template-version-read-summary-overlay"
                  >
                    {{ t.diffOverlayNodesPrefix }}+{{ versionReadSummary.overlay.addedNodes }}/−{{ versionReadSummary.overlay.removedNodes }}/~{{ versionReadSummary.overlay.changedNodes }}
                    {{ t.diffOverlayEdgesSep }}+{{ versionReadSummary.overlay.addedEdges }}/−{{ versionReadSummary.overlay.removedEdges }}/~{{ versionReadSummary.overlay.changedEdges }}
                  </p>
                </div>
                <el-segmented
                  v-if="versionDiff.totalChanges > 0"
                  v-model="versionDiffMode"
                  :options="versionDiffModeOptions"
                  size="small"
                  class="template-detail__version-diff-mode"
                  data-testid="template-version-diff-mode"
                />
                <el-empty
                  v-if="versionDiff.totalChanges === 0"
                  :description="t.diffNoStructuralChange"
                  :image-size="48"
                />
                <ul v-else-if="versionDiffMode === 'list'" class="template-detail__version-change-list">
                  <li
                    v-for="change in versionDiff.changes"
                    :key="`${change.entity}-${change.key}-${change.kind}`"
                  >
                    <el-tag
                      size="small"
                      :type="versionChangeTagType(change.kind)"
                      class="template-detail__version-change-kind"
                    >
                      {{ versionChangeKindLabel(change.kind) }}
                    </el-tag>
                    <span class="template-detail__version-change-entity">
                      {{ versionChangeEntityLabel(change.entity) }}
                    </span>
                    <strong>{{ change.label }}</strong>
                  </li>
                </ul>
                <div
                  v-else-if="versionDiffMode === 'dual' && versionDualCanvas"
                  class="template-detail__version-dual"
                  data-testid="template-version-dual-canvas"
                >
                  <ul
                    v-if="versionReadSummary && versionReadSummary.lines.length"
                    class="template-detail__version-dual-summary-lines"
                    data-testid="template-version-dual-summary-lines"
                  >
                    <li
                      v-for="(line, idx) in versionReadSummary.lines"
                      :key="`dual-sum-${idx}`"
                    >
                      {{ line }}
                    </li>
                  </ul>
                  <p v-if="versionDiff.fieldChanges" class="template-detail__version-overlay-note">
                    {{ fieldChangesNoteText(versionDiff.fieldChanges) }}
                  </p>
                  <div class="template-detail__version-dual-row">
                    <div
                      class="template-detail__version-dual-side"
                      data-testid="template-version-dual-left"
                    >
                      <h4 class="template-detail__version-dual-title">{{ versionDualCanvas.left.title }}</h4>
                      <div
                        class="template-detail__version-overlay-canvas"
                        :style="{
                          width: `${versionDualCanvas.left.layout.width}px`,
                          height: `${versionDualCanvas.left.layout.height}px`,
                        }"
                      >
                        <svg
                          class="template-detail__version-overlay-edges"
                          :width="versionDualCanvas.left.layout.width"
                          :height="versionDualCanvas.left.layout.height"
                        >
                          <defs>
                            <marker id="approval-version-dual-left-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                              <path d="M0,0 L7,3 L0,6 Z" fill="currentColor" />
                            </marker>
                          </defs>
                          <path
                            v-for="line in versionDualLeftEdgeLines"
                            :key="line.key"
                            :d="line.path"
                            class="template-detail__version-overlay-edge"
                            :class="line.change ? `is-${line.change}` : ''"
                            marker-end="url(#approval-version-dual-left-arrow)"
                          />
                        </svg>
                        <div
                          v-for="pos in versionDualCanvas.left.layout.nodes"
                          :key="pos.key"
                          class="template-detail__version-overlay-node"
                          :class="versionDualCanvas.nodeChange(pos.key) ? `is-${versionDualCanvas.nodeChange(pos.key)}` : ''"
                          :style="{
                            left: `${pos.x}px`,
                            top: `${pos.y}px`,
                            width: `${VERSION_OVERLAY_NODE_W}px`,
                            minHeight: `${VERSION_OVERLAY_NODE_H}px`,
                          }"
                        >
                          <strong>{{ versionDualNodeLabel('left', pos.key) }}</strong>
                          <el-tag
                            v-if="versionDualCanvas.nodeChange(pos.key)"
                            size="small"
                            :type="versionChangeTagType(versionDualCanvas.nodeChange(pos.key)!)"
                          >
                            {{ versionChangeKindLabel(versionDualCanvas.nodeChange(pos.key)!) }}
                          </el-tag>
                        </div>
                      </div>
                    </div>
                    <div
                      class="template-detail__version-dual-side"
                      data-testid="template-version-dual-right"
                    >
                      <h4 class="template-detail__version-dual-title">{{ versionDualCanvas.right.title }}</h4>
                      <div
                        class="template-detail__version-overlay-canvas"
                        :style="{
                          width: `${versionDualCanvas.right.layout.width}px`,
                          height: `${versionDualCanvas.right.layout.height}px`,
                        }"
                      >
                        <svg
                          class="template-detail__version-overlay-edges"
                          :width="versionDualCanvas.right.layout.width"
                          :height="versionDualCanvas.right.layout.height"
                        >
                          <defs>
                            <marker id="approval-version-dual-right-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                              <path d="M0,0 L7,3 L0,6 Z" fill="currentColor" />
                            </marker>
                          </defs>
                          <path
                            v-for="line in versionDualRightEdgeLines"
                            :key="line.key"
                            :d="line.path"
                            class="template-detail__version-overlay-edge"
                            :class="line.change ? `is-${line.change}` : ''"
                            marker-end="url(#approval-version-dual-right-arrow)"
                          />
                        </svg>
                        <div
                          v-for="pos in versionDualCanvas.right.layout.nodes"
                          :key="pos.key"
                          class="template-detail__version-overlay-node"
                          :class="versionDualCanvas.nodeChange(pos.key) ? `is-${versionDualCanvas.nodeChange(pos.key)}` : ''"
                          :style="{
                            left: `${pos.x}px`,
                            top: `${pos.y}px`,
                            width: `${VERSION_OVERLAY_NODE_W}px`,
                            minHeight: `${VERSION_OVERLAY_NODE_H}px`,
                          }"
                        >
                          <strong>{{ versionDualNodeLabel('right', pos.key) }}</strong>
                          <el-tag
                            v-if="versionDualCanvas.nodeChange(pos.key)"
                            size="small"
                            :type="versionChangeTagType(versionDualCanvas.nodeChange(pos.key)!)"
                          >
                            {{ versionChangeKindLabel(versionDualCanvas.nodeChange(pos.key)!) }}
                          </el-tag>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div
                  v-else-if="versionDiffMode === 'canvas' && versionOverlay && versionOverlayLayout"
                  class="template-detail__version-overlay"
                  data-testid="template-version-graph-overlay"
                >
                  <p v-if="versionDiff.fieldChanges" class="template-detail__version-overlay-note">
                    {{ fieldChangesNoteText(versionDiff.fieldChanges) }}
                  </p>
                  <div
                    class="template-detail__version-overlay-canvas"
                    :style="{ width: `${versionOverlayLayout.width}px`, height: `${versionOverlayLayout.height}px` }"
                  >
                    <svg
                      class="template-detail__version-overlay-edges"
                      :width="versionOverlayLayout.width"
                      :height="versionOverlayLayout.height"
                    >
                      <defs>
                        <marker id="approval-version-overlay-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                          <path d="M0,0 L7,3 L0,6 Z" fill="currentColor" />
                        </marker>
                      </defs>
                      <path
                        v-for="line in versionOverlayEdgeLines"
                        :key="line.key"
                        :d="line.path"
                        class="template-detail__version-overlay-edge"
                        :class="line.change ? `is-${line.change}` : ''"
                        marker-end="url(#approval-version-overlay-arrow)"
                        data-testid="template-version-overlay-edge"
                      />
                    </svg>
                    <div
                      v-for="pos in versionOverlayLayout.nodes"
                      :key="pos.key"
                      class="template-detail__version-overlay-node"
                      :class="versionOverlayNodeChange(pos.key) ? `is-${versionOverlayNodeChange(pos.key)}` : ''"
                      :style="{
                        left: `${pos.x}px`,
                        top: `${pos.y}px`,
                        width: `${VERSION_OVERLAY_NODE_W}px`,
                        minHeight: `${VERSION_OVERLAY_NODE_H}px`,
                      }"
                      data-testid="template-version-overlay-node"
                    >
                      <strong>{{ versionOverlayNodeLabel(pos.key) }}</strong>
                      <el-tag
                        v-if="versionOverlayNodeChange(pos.key)"
                        size="small"
                        :type="versionChangeTagType(versionOverlayNodeChange(pos.key)!)"
                      >
                        {{ versionChangeKindLabel(versionOverlayNodeChange(pos.key)!) }}
                      </el-tag>
                    </div>
                  </div>
                </div>
              </template>
              <el-alert
                v-else-if="versionDiffError"
                type="warning"
                :title="versionDiffError"
                :closable="false"
              />
            </div>
          </div>
        </div>
      </div>

      <el-empty v-else-if="!store.loading" :description="t.notFound" />
    </div>
  </PageShell>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import PageShell from '../../components/layout/PageShell.vue'
import PageHeader from '../../components/layout/PageHeader.vue'
import StatusTag from '../../components/status/StatusTag.vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Flag,
  UserFilled,
  Message,
  QuestionFilled,
  CircleCheckFilled,
  Tickets,
  View,
  RefreshLeft,
  Close,
} from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type {
  ApprovalNodeType,
  FormFieldType,
  ApprovalMode,
  EmptyAssigneePolicy,
  ApprovalTemplateVisibilityScope,
  ApprovalTemplateVisibilityType,
  ApprovalTemplateVersionSummaryDTO,
  ApprovalTemplateVersionDetailDTO,
  ApprovalTemplateStatus,
} from '../../types/approval'
import { useApprovalTemplateStore } from '../../approvals/templateStore'
import { useApprovalPermissions } from '../../approvals/permissions'
import {
  ensureUserNamesResolved,
  getResolvedUserName,
  joinIfAllResolved,
} from '../../approvals/directoryResolve'
import {
  updateTemplateCategory,
  updateTemplateSlaHours,
  updateTemplateVisibilityScope,
  getTemplateUsage,
  archiveTemplate,
  unarchiveTemplate,
  getTemplateVersion,
  listTemplateVersions,
  restoreTemplateVersion,
} from '../../approvals/api'
import {
  diffApprovalTemplateVersions,
  type TemplateVersionChangeEntity,
  type TemplateVersionChangeKind,
  type TemplateVersionDiff,
} from '../../approvals/templateVersionDiff'
import { buildVersionGraphOverlay } from '../../approvals/versionGraphOverlay'
import { buildApprovalVersionReadSummary } from '../../approvals/approvalVersionReadSummary'
import { buildApprovalVersionDualCanvas } from '../../approvals/approvalVersionDualCanvas'
import {
  computeLayout,
  GRAPH_LAYOUT_NODE_HEIGHT,
  GRAPH_LAYOUT_NODE_WIDTH,
} from '../../approvals/graphLayout'
import { describeFieldVisibilityRule } from '../../approvals/fieldVisibility'
import { templateArchiveConfirmMessage, templateUnarchiveConfirmMessage } from '../../approvals/templateArchiveConfirm'
import { useLocale } from '../../composables/useLocale'
import {
  ZH,
  EN,
  FIELD_TYPE_ZH,
  FIELD_TYPE_EN,
  NODE_TYPE_ZH,
  NODE_TYPE_EN,
  APPROVAL_MODE_ZH,
  APPROVAL_MODE_EN,
  EMPTY_ASSIGNEE_POLICY_ZH,
  EMPTY_ASSIGNEE_POLICY_EN,
  NODE_TIMEOUT_EFFECT_ZH,
  NODE_TIMEOUT_EFFECT_EN,
  VERSION_STATUS_ZH,
  VERSION_STATUS_EN,
  VERSION_CHANGE_KIND_ZH,
  VERSION_CHANGE_KIND_EN,
  VERSION_CHANGE_ENTITY_ZH,
  VERSION_CHANGE_ENTITY_EN,
} from './templateDetailLabels'

const route = useRoute()
const router = useRouter()
const store = useApprovalTemplateStore()
const { canWrite, canManageTemplates } = useApprovalPermissions()

// Report item O-8 continuation (PR #5545) — TemplateDetailView.vue previously never called
// useLocale() at all, exactly like TemplateCenterView.vue before its own O-8 retrofit; every
// string below was an unconditional Chinese literal regardless of the app shell's locale. Same
// `useLocale()` module-scope singleton App.vue and TemplateCenterView.vue already read, same
// `ZH`/`EN` + `t = computed(...)` convention.
const { isZh } = useLocale()
const t = computed(() => (isZh.value ? ZH : EN))

const template = computed(() => store.activeTemplate)
// PageHeader requires a non-optional title; before the template loads (or on error) fall back to
// generic copy — the original hand-rolled `<h1 v-if="template">` rendered nothing at all here.
const headerTitle = computed(() => template.value?.name ?? t.value.headerFallback)
const visibilityRuleSummaries = computed(() => {
  const currentTemplate = template.value
  if (!currentTemplate) return []
  return currentTemplate.formSchema.fields
    .map((field) => ({
      field,
      summary: describeFieldVisibilityRule(field, currentTemplate.formSchema),
    }))
    .filter((entry) => entry.summary !== null)
})

// Wave 2 WP4 slice 1 — inline category editor state.
const editingCategory = ref(false)
const categoryDraft = ref('')
const categorySaving = ref(false)
const editingVisibility = ref(false)
const visibilityTypeDraft = ref<ApprovalTemplateVisibilityType>('all')
const visibilityIdsDraft = ref('')
const visibilitySaving = ref(false)
// Wave 2 WP5 slice 1 — inline SLA editor state.
const editingSla = ref(false)
const slaDraft = ref<number | null>(null)
const slaSaving = ref(false)
// B3-08 — 停用/启用 state.
const archiving = ref(false)
const isNarrowViewport = ref(false)
let narrowViewportQuery: MediaQueryList | null = null

function syncNarrowViewport(event?: MediaQueryListEvent) {
  isNarrowViewport.value = event?.matches ?? narrowViewportQuery?.matches ?? false
}

function beginEditSla() {
  if (!template.value) return
  slaDraft.value = template.value.slaHours ?? null
  editingSla.value = true
}

function cancelEditSla() {
  editingSla.value = false
  slaDraft.value = null
}

function slaUpdatedToastText(hours: number): string {
  return isZh.value ? `已更新 SLA 为 ${hours} 小时` : `SLA updated to ${hours} hours`
}

async function saveSla() {
  if (!template.value || slaSaving.value) return
  const raw = slaDraft.value
  const nextSla = raw === null || raw === undefined || Number.isNaN(Number(raw)) ? null : Number(raw)
  if (nextSla !== null && (!Number.isInteger(nextSla) || nextSla <= 0)) {
    ElMessage.error(t.value.slaInvalid)
    return
  }
  const current = template.value.slaHours ?? null
  if (nextSla === current) {
    editingSla.value = false
    return
  }
  slaSaving.value = true
  try {
    const updated = await updateTemplateSlaHours(template.value.id, nextSla)
    store.activeTemplate = updated
    editingSla.value = false
    ElMessage.success(nextSla === null ? t.value.slaClearedToast : slaUpdatedToastText(nextSla))
  } catch (e: any) {
    ElMessage.error(e?.message ?? t.value.slaUpdateFailed)
  } finally {
    slaSaving.value = false
  }
}

function beginEditCategory() {
  if (!template.value) return
  categoryDraft.value = template.value.category ?? ''
  editingCategory.value = true
}

function cancelEditCategory() {
  editingCategory.value = false
  categoryDraft.value = ''
}

function categoryUpdatedToastText(category: string): string {
  return isZh.value ? `已更新分类为 ${category}` : `Category updated to ${category}`
}

async function saveCategory() {
  if (!template.value || categorySaving.value) return
  const trimmed = categoryDraft.value.trim()
  const nextCategory = trimmed.length > 0 ? trimmed : null
  const currentCategory = template.value.category ?? null
  if (nextCategory === currentCategory) {
    editingCategory.value = false
    return
  }
  categorySaving.value = true
  try {
    const updated = await updateTemplateCategory(template.value.id, nextCategory)
    // Patch the cached store so the header refreshes without a round-trip.
    store.activeTemplate = updated
    editingCategory.value = false
    ElMessage.success(nextCategory ? categoryUpdatedToastText(nextCategory) : t.value.categoryClearedToast)
  } catch (e: any) {
    ElMessage.error(e?.message ?? t.value.categoryUpdateFailed)
  } finally {
    categorySaving.value = false
  }
}

function visibilityScopeLabel(scope: ApprovalTemplateVisibilityScope): string {
  if (!scope || scope.type === 'all') return t.value.visibilityAllLabel
  const map: Record<ApprovalTemplateVisibilityType, string> = {
    all: t.value.visibilityAllLabel,
    dept: t.value.visibilityDeptLabel,
    role: t.value.visibilityRoleLabel,
    user: t.value.visibilityUserLabel,
  }
  return map[scope.type]
}

// member-display-identity (2026-08-19; tightened 2026-08-19 per owner decision — role resolution
// stays admin-only) — this view is reachable by ANY authenticated user (`requiresAuth` only, no
// `approval-templates:manage`/`approvals:*` gate — see appRoutes.ts), so both the visibility-scope
// ids AND the legacy per-node assignee ids used to render the raw member/role ids to every viewer
// regardless of `canManageTemplates`. USER ids: resolved names joined when EVERY id resolves,
// otherwise a values-free count (`用户 2`, matching TemplateCenterView.vue's own
// `visibilityScopeLabel` count wording) — never the raw id join. ROLE ids: there is no
// participant-reachable role resolver (removed per owner decision, see the P3-1 note in
// approval-directory.ts) — a role scope/assignee is ALWAYS the same values-free generic count the
// static_role assignee-source summary already uses on other viewer surfaces
// (`requesterFacingSourceSummary` in assigneeSource.ts: `指定角色（N 个）`), never resolved to a
// name and never the raw id. Department ids have NO resolver anywhere on the approval surface
// (net-new, a separate owner decision per the scout report), so a `dept` scope is ALWAYS the count
// form.
const NON_ALL_SCOPE_UNIT_LABEL: Record<'dept' | 'user', string> = { dept: '部门', user: '用户' }
// English companion for the zh-CN map immediately above (report item O-8 continuation, PR #5545).
// Kept as a SEPARATE constant, never merged into `NON_ALL_SCOPE_UNIT_LABEL` itself: that map's
// exact source text is pinned BY NAME in
// apps/web/tests/approval-member-identity-coverage-enumeration.spec.ts (file-keyed to this view,
// OUT-OF-SCOPE group "a COUNT (`.length`), never the raw ids") — renaming or restructuring it
// would make that census's staleness check fail for no behavioral reason.
const NON_ALL_SCOPE_UNIT_LABEL_EN: Record<'dept' | 'user', string> = { dept: 'Department', user: 'User' }

function resolvedIdsOrCount(kind: 'dept' | 'role' | 'user', ids: readonly string[] | undefined | null): string {
  const safeIds = ids ?? []
  const count = safeIds.length
  if (count === 0) return '-'
  if (kind === 'role') {
    // The zh-CN line below is pinned VERBATIM by the census referenced above — do not reshape it
    // (rename `safeIds`, change the bracket style, etc.) without updating that entry too.
    return isZh.value ? `指定角色（${safeIds.length} 个）` : `Designated role (${count})`
  }
  if (kind === 'user') {
    const names = joinIfAllResolved(safeIds, getResolvedUserName)
    if (names) return names.join(isZh.value ? '、' : ', ')
  }
  // Same pinning note as the role branch above — the zh-CN line must keep referencing
  // `NON_ALL_SCOPE_UNIT_LABEL` (not `_EN`) and `safeIds.length` (not `count`) verbatim.
  return isZh.value
    ? `${NON_ALL_SCOPE_UNIT_LABEL[kind]} ${safeIds.length}`
    : `${NON_ALL_SCOPE_UNIT_LABEL_EN[kind]} ${count}`
}

function visibilityScopeIdsDisplay(scope: ApprovalTemplateVisibilityScope): string {
  if (!scope || scope.type === 'all') return ''
  return resolvedIdsOrCount(scope.type, scope.ids)
}

function legacyAssigneeIdsDisplay(assigneeType: 'user' | 'role' | undefined, assigneeIds: string[] | undefined): string {
  if (!assigneeType) return '-'
  return resolvedIdsOrCount(assigneeType === 'role' ? 'role' : 'user', assigneeIds)
}

// Collects EVERY member id this view might need a display name for — the visibility scope's ids
// (when type is user) PLUS every node's legacy `assigneeType`/`assigneeIds` (when type is user) —
// and kicks off the batch resolve. A `watch` (side effect), never inside the `computed`-style
// display functions above, which read the resolved cache but must never write to it. ROLE ids are
// deliberately NOT collected here: there is no participant-reachable role resolver to feed (see
// `resolvedIdsOrCount` above), so a role scope/assignee is always the generic count, never queued.
watch(
  () => {
    const userIds: string[] = []
    const scope = template.value?.visibilityScope
    if (scope?.type === 'user') userIds.push(...(scope.ids ?? []))
    for (const node of template.value?.approvalGraph?.nodes ?? []) {
      const cfg = node.config as { assigneeType?: string; assigneeIds?: string[] }
      if (!cfg || !('assigneeType' in cfg) || !cfg.assigneeType) continue
      if (cfg.assigneeType !== 'role') userIds.push(...(cfg.assigneeIds ?? []))
    }
    return userIds
  },
  (userIds) => {
    ensureUserNamesResolved(userIds)
  },
  { immediate: true },
)

function beginEditVisibility() {
  if (!template.value) return
  visibilityTypeDraft.value = template.value.visibilityScope.type
  visibilityIdsDraft.value = template.value.visibilityScope.ids.join(', ')
  editingVisibility.value = true
}

function cancelEditVisibility() {
  editingVisibility.value = false
  visibilityTypeDraft.value = 'all'
  visibilityIdsDraft.value = ''
}

async function saveVisibility() {
  if (!template.value || visibilitySaving.value) return
  const ids = visibilityIdsDraft.value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (visibilityTypeDraft.value !== 'all' && ids.length === 0) {
    ElMessage.error(t.value.visibilityIdsRequired)
    return
  }
  const nextScope: ApprovalTemplateVisibilityScope = visibilityTypeDraft.value === 'all'
    ? { type: 'all', ids: [] }
    : { type: visibilityTypeDraft.value, ids: Array.from(new Set(ids)) }
  const current = template.value.visibilityScope
  if (current.type === nextScope.type && current.ids.join('\n') === nextScope.ids.join('\n')) {
    editingVisibility.value = false
    return
  }
  visibilitySaving.value = true
  try {
    const updated = await updateTemplateVisibilityScope(template.value.id, nextScope)
    store.activeTemplate = updated
    editingVisibility.value = false
    ElMessage.success(t.value.visibilityUpdatedToast)
  } catch (e: any) {
    ElMessage.error(e?.message ?? t.value.visibilityUpdateFailed)
  } finally {
    visibilitySaving.value = false
  }
}

function fieldTypeLabel(type: FormFieldType) {
  const map = isZh.value ? FIELD_TYPE_ZH : FIELD_TYPE_EN
  return map[type] ?? type
}

function nodeTypeLabel(type: ApprovalNodeType) {
  // Lock-3 §1.5 — 办理/handler node.
  const map = isZh.value ? NODE_TYPE_ZH : NODE_TYPE_EN
  return map[type] ?? type
}

function nodeTimelineType(type: ApprovalNodeType): string {
  const map: Record<ApprovalNodeType, string> = {
    start: 'primary',
    approval: 'warning',
    cc: 'success',
    condition: 'danger',
    parallel: 'warning',
    handler: 'primary',
    end: 'info',
  }
  return map[type] ?? 'info'
}

function nodeTimelineIcon(type: ApprovalNodeType) {
  const map: Record<ApprovalNodeType, any> = {
    start: Flag,
    approval: UserFilled,
    cc: Message,
    condition: QuestionFilled,
    parallel: QuestionFilled,
    handler: Tickets,
    end: CircleCheckFilled,
  }
  return map[type] ?? undefined
}

function nodeTagType(type: ApprovalNodeType): string {
  const map: Record<ApprovalNodeType, string> = {
    start: '',
    approval: 'warning',
    cc: 'success',
    condition: 'danger',
    parallel: 'warning',
    handler: 'primary',
    end: 'info',
  }
  return map[type] ?? ''
}

function approvalModeLabel(mode: ApprovalMode): string {
  // Threshold and sequential are the fourth and fifth shipped engine modes. See ApprovalMode's
  // type comment for the linear-only constraint this read-only detail label does not enforce.
  const map = isZh.value ? APPROVAL_MODE_ZH : APPROVAL_MODE_EN
  return map[mode] ?? mode
}

// Report item O-8 continuation (PR #5545) — the two dynamic parenthetical suffixes the approval
// graph section renders next to a threshold-mode tag / a timeout-effect tag. Kept as functions
// (not table keys) because each is a full sentence fragment wrapping a live count, matching the
// `resetPickerRecordCount(count, isZh)` convention in
// src/multitable/utils/meta-record-labels.ts — a table entry for bare punctuation/brackets would
// be ASCII-only in zh and identical across locales, tripping the completeness test's own guards.
function approveThresholdText(n: number): string {
  return isZh.value ? `（${n} 人同意）` : ` (${n} approvals required)`
}

function timeoutMinutesText(n: number): string {
  return isZh.value ? `（${n} 分钟）` : ` (${n} min)`
}

// P1-C: business labels for the WIRED timeout effects only (`NODE_TIMEOUT_SUPPORTED_EFFECTS` — never
// the raw enum string). No fallback-to-raw-value branch: an effect outside this map can only be
// 'auto_approve'/'auto_reject' (reserved, unreachable — publish rejects them,
// `APPROVAL_NODE_TIMEOUT_EFFECT_UNSUPPORTED`) or genuinely malformed data, and this is a read-only
// echo, not an authoring surface, so silently rendering nothing for that case is correct (never
// invent a label for a capability that isn't real).
function nodeTimeoutEffectLabel(effect: string | undefined): string {
  const map = isZh.value ? NODE_TIMEOUT_EFFECT_ZH : NODE_TIMEOUT_EFFECT_EN
  return (effect && map[effect]) ?? ''
}

function emptyAssigneePolicyLabel(policy: EmptyAssigneePolicy): string {
  // Fix-round P1-1 (gate P3A-F4B-20260819) — 'designated' added so this compiles against the
  // widened `EmptyAssigneePolicy` union (read-only detail echo; NOT an authoring surface, so no
  // FE follower-slice scope is implied by this label existing).
  const map = isZh.value ? EMPTY_ASSIGNEE_POLICY_ZH : EMPTY_ASSIGNEE_POLICY_EN
  return map[policy] ?? policy
}

function formatDate(dateStr: string) {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleString(isZh.value ? 'zh-CN' : 'en-US')
}

function goBack() {
  router.push({ path: '/approval-templates' })
}

function retryLoad() {
  const id = route.params.id as string
  store.error = null
  store.loadTemplate(id)
}

function startApproval() {
  if (template.value) {
    router.push({ path: `/approvals/new/${template.value.id}` })
  }
}

function editTemplate() {
  if (!template.value || !canManageTemplates.value) return
  router.push({ path: `/approval-templates/${template.value.id}/edit` })
}

// B3-08 (模板治理 — 停用): fetches the usage/blast-radius indicator FIRST (best-effort — a failed
// usage read still shows the confirm, just without the instance-count line) so the confirm dialog
// can state it, mirroring the ruleStats / DelegationSettingsView.disable() precedent.
async function handleArchive() {
  if (!template.value || archiving.value) return
  const current = template.value
  let usage
  try {
    usage = await getTemplateUsage(current.id)
  } catch {
    usage = undefined
  }
  try {
    await ElMessageBox.confirm(
      templateArchiveConfirmMessage(current.name, usage),
      t.value.archiveDialogTitle,
      { confirmButtonText: t.value.archiveButton, cancelButtonText: t.value.cancel, type: 'warning' },
    )
  } catch {
    return
  }
  archiving.value = true
  try {
    const updated = await archiveTemplate(current.id)
    store.activeTemplate = updated
    ElMessage.success(t.value.archiveSuccessToast)
  } catch (e: any) {
    ElMessage.error(e?.message ?? t.value.archiveFailed)
  } finally {
    archiving.value = false
  }
}

async function handleUnarchive() {
  if (!template.value || archiving.value) return
  const current = template.value
  try {
    await ElMessageBox.confirm(
      templateUnarchiveConfirmMessage(current.name),
      t.value.unarchiveDialogTitle,
      { confirmButtonText: t.value.unarchiveButton, cancelButtonText: t.value.cancel, type: 'info' },
    )
  } catch {
    return
  }
  archiving.value = true
  try {
    const updated = await unarchiveTemplate(current.id)
    store.activeTemplate = updated
    ElMessage.success(t.value.unarchiveSuccessToast)
  } catch (e: any) {
    ElMessage.error(e?.message ?? t.value.unarchiveFailed)
  } finally {
    archiving.value = false
  }
}

// B3-09 (模板治理 — 版本历史) — admin-only fetch. `canManageTemplates` resolves asynchronously
// (refreshApprovalAccess), so a mount-time check would race a slow permission load to a permanently
// empty section; instead watch it and fetch ONCE when it turns true. Non-admins never fire the
// request (the endpoint would 403 them anyway).
const versionHistory = ref<ApprovalTemplateVersionSummaryDTO[]>([])
const versionHistoryError = ref('')
const selectedVersionId = ref<string | null>(null)
const selectedVersion = ref<ApprovalTemplateVersionDetailDTO | null>(null)
const selectedBaseline = ref<ApprovalTemplateVersionSummaryDTO | null>(null)
const selectedBaselineSnapshot = ref<Pick<ApprovalTemplateVersionDetailDTO, 'formSchema' | 'approvalGraph'> | null>(null)
const versionDiff = ref<TemplateVersionDiff | null>(null)
const versionDiffMode = ref<'list' | 'canvas' | 'dual'>('list')
// A computed, not a plain array literal: it must re-render when the shell locale flips after
// mount, not just reflect whatever locale was active at setup time (report item O-8 continuation).
const versionDiffModeOptions = computed(() => [
  { label: t.value.diffModeList, value: 'list' },
  { label: t.value.diffModeCanvas, value: 'canvas' },
  { label: t.value.diffModeDual, value: 'dual' },
])
const versionDiffLoading = ref(false)
const versionDiffError = ref('')
const restoringVersionId = ref<string | null>(null)
const versionDetailCache = new Map<string, ApprovalTemplateVersionDetailDTO>()
let versionHistoryFetched = false

const versionDiffTitle = computed(() => {
  if (!selectedVersion.value) return t.value.versionDiffTitleFallback
  return selectedBaseline.value
    ? `v${selectedBaseline.value.version} -> v${selectedVersion.value.version}`
    : `v${selectedVersion.value.version}${t.value.versionInitialSuffix}`
})
const versionOverlay = computed(() => {
  if (!selectedVersion.value || !selectedBaselineSnapshot.value || !versionDiff.value) return null
  return buildVersionGraphOverlay(
    selectedBaselineSnapshot.value.approvalGraph,
    selectedVersion.value.approvalGraph,
    versionDiff.value,
  )
})
/** D8-b thin: business-facing summary over the same diff + overlay already on this page. */
const versionReadSummary = computed(() => {
  if (!versionDiff.value) return null
  return buildApprovalVersionReadSummary(versionDiff.value, versionOverlay.value)
})
const versionOverlayLayout = computed(() => versionOverlay.value ? computeLayout(versionOverlay.value.graph) : null)
/** D8-b residual: pure side-by-side before/after layouts (read-only). */
const versionDualCanvas = computed(() => {
  if (!selectedVersion.value) return null
  return buildApprovalVersionDualCanvas(
    selectedBaselineSnapshot.value?.approvalGraph ?? null,
    selectedVersion.value.approvalGraph,
    { overlay: versionOverlay.value },
  )
})
const VERSION_OVERLAY_NODE_W = GRAPH_LAYOUT_NODE_WIDTH
const VERSION_OVERLAY_NODE_H = GRAPH_LAYOUT_NODE_HEIGHT

function versionCanvasEdgeLines(
  graph: { edges: { key: string; source: string; target: string }[] },
  layout: { nodes: { key: string; x: number; y: number }[] },
  edgeChangeOf: (key: string) => TemplateVersionChangeKind | undefined,
) {
  const positions = new Map(layout.nodes.map((node) => [node.key, node]))
  return graph.edges.map((edge) => {
    const source = positions.get(edge.source)
    const target = positions.get(edge.target)
    const x1 = (source?.x ?? 0) + GRAPH_LAYOUT_NODE_WIDTH / 2
    const y1 = (source?.y ?? 0) + GRAPH_LAYOUT_NODE_HEIGHT
    const x2 = (target?.x ?? 0) + GRAPH_LAYOUT_NODE_WIDTH / 2
    const y2 = target?.y ?? 0
    const midY = y1 + (y2 - y1) / 2
    return {
      key: edge.key,
      path: `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`,
      change: edgeChangeOf(edge.key),
    }
  })
}

const versionOverlayEdgeLines = computed(() => {
  const overlay = versionOverlay.value
  const layout = versionOverlayLayout.value
  if (!overlay || !layout) return []
  return versionCanvasEdgeLines(overlay.graph, layout, (key) => overlay.edgeChanges.get(key))
})

const versionDualLeftEdgeLines = computed(() => {
  const dual = versionDualCanvas.value
  if (!dual) return []
  return versionCanvasEdgeLines(dual.left.graph, dual.left.layout, dual.edgeChange)
})

const versionDualRightEdgeLines = computed(() => {
  const dual = versionDualCanvas.value
  if (!dual) return []
  return versionCanvasEdgeLines(dual.right.graph, dual.right.layout, dual.edgeChange)
})

function versionOverlayNodeChange(nodeKey: string): TemplateVersionChangeKind | undefined {
  return versionOverlay.value?.nodeChanges.get(nodeKey)
}
function versionOverlayNodeLabel(nodeKey: string): string {
  const node = versionOverlay.value?.graph.nodes.find((candidate) => candidate.key === nodeKey)
  return node?.name?.trim() || (node ? nodeTypeLabel(node.type) : '流程节点')
}
function versionDualNodeLabel(
  side: 'left' | 'right',
  nodeKey: string,
): string {
  const dual = versionDualCanvas.value
  if (!dual) return '流程节点'
  const graph = side === 'left' ? dual.left.graph : dual.right.graph
  const node = graph.nodes.find((candidate) => candidate.key === nodeKey)
  return node?.name?.trim() || (node ? nodeTypeLabel(node.type) : '流程节点')
}

function versionStatusLabel(status: ApprovalTemplateStatus): string {
  const map = isZh.value ? VERSION_STATUS_ZH : VERSION_STATUS_EN
  return map[status] ?? status
}

function versionStatusTagType(status: ApprovalTemplateStatus): 'primary' | 'info' | 'warning' {
  if (status === 'published') return 'primary'
  if (status === 'archived') return 'warning'
  return 'info'
}

async function loadVersionHistory() {
  if (versionHistoryFetched) return
  versionHistoryFetched = true
  try {
    versionHistory.value = await listTemplateVersions(route.params.id as string)
    versionHistoryError.value = ''
  } catch (e: any) {
    // Load failure degrades to an inline warning — never blocks the rest of the detail page.
    versionHistoryError.value = e?.message ?? t.value.versionHistoryLoadFailed
  }
}

async function refreshVersionHistory() {
  versionHistory.value = await listTemplateVersions(route.params.id as string)
  versionHistoryError.value = ''
  versionHistoryFetched = true
}

function emptyVersionSnapshot(): Pick<ApprovalTemplateVersionDetailDTO, 'formSchema' | 'approvalGraph'> {
  return { formSchema: { fields: [] }, approvalGraph: { nodes: [], edges: [] } }
}

async function loadVersionDetail(versionId: string): Promise<ApprovalTemplateVersionDetailDTO> {
  const cached = versionDetailCache.get(versionId)
  if (cached) return cached
  const detail = await getTemplateVersion(route.params.id as string, versionId)
  versionDetailCache.set(versionId, detail)
  return detail
}

async function openVersionDiff(row: ApprovalTemplateVersionSummaryDTO) {
  selectedVersionId.value = row.id
  selectedVersion.value = null
  selectedBaselineSnapshot.value = null
  versionDiff.value = null
  versionDiffError.value = ''
  versionDiffLoading.value = true
  const rowIndex = versionHistory.value.findIndex((entry) => entry.id === row.id)
  const baseline = rowIndex >= 0 ? versionHistory.value[rowIndex + 1] ?? null : null
  selectedBaseline.value = baseline
  try {
    const [current, previous] = await Promise.all([
      loadVersionDetail(row.id),
      baseline ? loadVersionDetail(baseline.id) : Promise.resolve(emptyVersionSnapshot()),
    ])
    if (selectedVersionId.value !== row.id) return
    selectedVersion.value = current
    selectedBaselineSnapshot.value = previous
    versionDiff.value = diffApprovalTemplateVersions(previous, current)
  } catch (e: any) {
    if (selectedVersionId.value === row.id) {
      versionDiffError.value = e?.message ?? t.value.versionDiffLoadFailed
    }
  } finally {
    if (selectedVersionId.value === row.id) versionDiffLoading.value = false
  }
}

function closeVersionDiff() {
  selectedVersionId.value = null
  selectedVersion.value = null
  selectedBaseline.value = null
  selectedBaselineSnapshot.value = null
  versionDiff.value = null
  versionDiffMode.value = 'list'
  versionDiffError.value = ''
}

function restoredSourceLabel(versionId: string): string {
  const source = versionHistory.value.find((entry) => entry.id === versionId)
  return source ? `v${source.version}` : t.value.restoredSourceFallback
}

function restoreConfirmMessage(version: number): string {
  return isZh.value
    ? `将 v${version} 复制为新的草稿版本。当前已发布版本和运行中的审批不会改变。`
    : `This will copy v${version} into a new draft version. The currently published version and any in-progress approvals are unaffected.`
}

function restoreConfirmTitle(version: number): string {
  return isZh.value ? `恢复 v${version}` : `Restore v${version}`
}

function restoreSuccessToastText(version: number): string {
  return isZh.value ? `已恢复为草稿 v${version}` : `Restored as draft v${version}`
}

async function handleRestoreVersion(row: ApprovalTemplateVersionSummaryDTO) {
  const currentTemplate = template.value
  if (!currentTemplate?.latestVersionId || restoringVersionId.value) return
  try {
    await ElMessageBox.confirm(
      restoreConfirmMessage(row.version),
      restoreConfirmTitle(row.version),
      { confirmButtonText: t.value.restoreConfirmButton, cancelButtonText: t.value.cancel, type: 'warning' },
    )
  } catch {
    return
  }

  restoringVersionId.value = row.id
  try {
    const restored = await restoreTemplateVersion(currentTemplate.id, row.id, {
      expectedLatestVersionId: currentTemplate.latestVersionId,
    })
    versionDetailCache.set(restored.id, restored)
    await Promise.all([store.loadTemplate(currentTemplate.id), refreshVersionHistory()])
    ElMessage.success(restoreSuccessToastText(restored.version))
    const restoredRow = versionHistory.value.find((entry) => entry.id === restored.id)
    if (restoredRow) await openVersionDiff(restoredRow)
  } catch (e: any) {
    ElMessage.error(e?.message ?? t.value.restoreFailed)
  } finally {
    restoringVersionId.value = null
  }
}

function versionChangeKindLabel(kind: TemplateVersionChangeKind): string {
  const map = isZh.value ? VERSION_CHANGE_KIND_ZH : VERSION_CHANGE_KIND_EN
  return map[kind]
}

function versionChangeEntityLabel(entity: TemplateVersionChangeEntity): string {
  const map = isZh.value ? VERSION_CHANGE_ENTITY_ZH : VERSION_CHANGE_ENTITY_EN
  return map[entity]
}

function fieldChangesNoteText(n: number): string {
  return isZh.value
    ? `另有 ${n} 项表单字段变化，请切回列表查看。`
    : `There are also ${n} form field changes — switch back to the list view to see them.`
}

function versionChangeTagType(kind: TemplateVersionChangeKind): 'success' | 'danger' | 'warning' | 'info' {
  if (kind === 'added') return 'success'
  if (kind === 'removed') return 'danger'
  if (kind === 'moved') return 'info'
  return 'warning'
}

watch(
  canManageTemplates,
  (isAdmin) => {
    if (isAdmin) void loadVersionHistory()
  },
  { immediate: true },
)

onMounted(() => {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    narrowViewportQuery = window.matchMedia('(max-width: 768px)')
    syncNarrowViewport()
    narrowViewportQuery.addEventListener('change', syncNarrowViewport)
  }
  const id = route.params.id as string
  store.loadTemplate(id)
})

onBeforeUnmount(() => {
  narrowViewportQuery?.removeEventListener('change', syncNarrowViewport)
  narrowViewportQuery = null
})
</script>

<style scoped>
.template-detail__error {
  margin-bottom: 16px;
}

.template-detail__content-wrapper {
  min-height: 200px;
}

.template-detail__info {
  margin-bottom: 20px;
}

.template-detail__info p {
  color: var(--el-text-color-regular);
  margin: 0 0 12px;
}

.template-detail__meta {
  display: flex;
  gap: 24px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  flex-wrap: wrap;
}

.template-detail__category,
.template-detail__visibility {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 12px;
  font-size: 13px;
  flex-wrap: wrap;
}

.template-detail__category-label {
  color: var(--el-text-color-regular);
  margin-right: 4px;
}

.template-detail__category-empty {
  color: var(--el-text-color-secondary);
}

.template-detail__visibility-ids {
  color: var(--el-text-color-secondary);
}

.template-detail__content {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.template-detail__section {
  background: var(--ms-bg-card);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 20px;
}

.template-detail__section h2 {
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 16px;
}

.template-detail__node-content {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.template-detail__node-assignee {
  font-size: 12px;
  color: var(--el-text-color-regular);
}

.template-detail__node-mode,
.template-detail__node-policy {
  margin-left: 4px;
}

/* B3-09 — version-history rows */
.template-detail__version-active-tag {
  margin-left: 8px;
}

.template-detail__version-source-tag {
  margin-left: 8px;
}

.template-detail__version-note {
  white-space: pre-wrap;
  word-break: break-word;
}

.template-detail__version-diff {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--el-border-color-lighter);
}

.template-detail__version-diff-header,
.template-detail__version-diff-summary,
.template-detail__version-change-list li {
  display: flex;
  align-items: center;
}

.template-detail__version-diff-header {
  justify-content: space-between;
  gap: 12px;
}

.template-detail__version-diff-header h3 {
  margin: 0;
  font-size: 16px;
}

.template-detail__version-source {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.template-detail__version-diff-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 12px 20px;
  margin: 12px 0;
  color: var(--el-text-color-regular);
  font-size: 13px;
}
.template-detail__version-read-summary-line,
.template-detail__version-read-summary-overlay {
  flex: 1 0 100%;
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.template-detail__version-change-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.template-detail__version-change-list li {
  gap: 8px;
  min-width: 0;
}

.template-detail__version-change-list strong {
  overflow-wrap: anywhere;
}

.template-detail__version-change-kind,
.template-detail__version-change-entity {
  flex: 0 0 auto;
}

.template-detail__version-change-entity {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.template-detail__version-diff-mode {
  margin-bottom: 12px;
}

.template-detail__version-overlay {
  min-width: 0;
  max-height: min(66vh, 720px);
  overflow: auto;
}

.template-detail__version-dual {
  min-width: 0;
  max-height: min(66vh, 720px);
  overflow: auto;
}

.template-detail__version-dual-summary-lines {
  margin: 0 0 10px;
  padding: 0 0 0 1.1em;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.template-detail__version-dual-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: flex-start;
}

.template-detail__version-dual-side {
  flex: 1 1 280px;
  min-width: 0;
  overflow: auto;
}

.template-detail__version-dual-title {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}

.template-detail__version-overlay-note {
  margin: 0 0 8px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.template-detail__version-overlay-canvas {
  position: relative;
  min-width: 100%;
  min-height: 220px;
  overflow: hidden;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--ms-bg-page);
}

.template-detail__version-overlay-edges {
  position: absolute;
  inset: 0;
  color: var(--el-border-color-darker);
}

.template-detail__version-overlay-edge {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
}

.template-detail__version-overlay-edge.is-added {
  color: var(--el-color-success);
}

.template-detail__version-overlay-edge.is-changed,
.template-detail__version-overlay-edge.is-moved {
  color: var(--el-color-warning);
  stroke-dasharray: 2 3;
}

.template-detail__version-overlay-edge.is-removed {
  color: var(--el-color-danger);
  stroke-dasharray: 5 4;
}

.template-detail__version-overlay-node {
  position: absolute;
  box-sizing: border-box;
  min-height: 76px;
  padding: 10px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: var(--ms-bg-card);
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}

.template-detail__version-overlay-node.is-added {
  border-color: var(--el-color-success);
}

.template-detail__version-overlay-node.is-changed,
.template-detail__version-overlay-node.is-moved {
  border-color: var(--el-color-warning);
}

.template-detail__version-overlay-node.is-removed {
  border-color: var(--el-color-danger);
  border-style: dashed;
  opacity: 0.72;
}

@media (max-width: 768px) {
  .template-detail__meta {
    flex-direction: column;
    gap: 8px;
  }

  .template-detail__version-diff-summary {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
  }
}
</style>
