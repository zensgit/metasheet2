<template>
  <PageShell width="narrow">
    <PageHeader
      class="approval-new__header"
      title="发起审批"
      back
      back-label="返回"
      @back="goBack"
    />

    <el-alert
      v-if="templateStore.error || approvalStore.error"
      :title="templateStore.error || approvalStore.error || ''"
      type="error"
      show-icon
      :closable="true"
      class="approval-new__error"
      @close="templateStore.error = null; approvalStore.error = null"
    >
      <template #default>
        <el-button type="primary" link @click="retryLoad">重新加载</el-button>
      </template>
    </el-alert>

    <div v-loading="templateStore.loading || approvalStore.loading || prefillLoading" class="approval-new__content-wrapper">
      <div v-if="template" class="approval-new__body">
        <!-- Template info card -->
        <el-card class="approval-new__info-card" shadow="never">
          <template #header>
            <div class="approval-new__info-header">
              <h2>{{ template.name }}</h2>
              <StatusTag domain="approvalTemplate" :status="template.status" size="sm" force-locale="zh" />
            </div>
          </template>
          <p v-if="template.description" class="approval-new__info-desc">{{ template.description }}</p>
          <p v-else class="approval-new__info-desc approval-new__info-desc--empty">暂无描述</p>
        </el-card>

        <!-- UX B2-13 (再次提交): shown only once a `?fromInstance=` prefill actually applied at
             least one field (see `applyResubmitPrefill`) — a requester fixing a rejected/revoked/
             cancelled submission should know the form was pre-populated, not silently discover it. -->
        <el-alert
          v-if="draftRestoreVisible"
          type="info"
          :closable="false"
          class="approval-new__draft-alert"
          data-testid="approval-draft-restore"
        >
          <template #title>
            检测到上次未提交的草稿，是否恢复？
            <el-button size="small" type="primary" data-testid="approval-draft-restore-apply" @click="applyDraftRestore">恢复草稿</el-button>
            <el-button size="small" data-testid="approval-draft-restore-discard" @click="discardDraftRestore">丢弃</el-button>
          </template>
        </el-alert>
        <el-alert
          v-if="prefillNoticeVisible"
          title="已从上一次申请预填，请检查后提交"
          type="info"
          show-icon
          :closable="true"
          class="approval-new__prefill-notice"
          data-testid="approval-prefill-notice"
          @close="prefillNoticeVisible = false"
        />

        <!-- UX B2-07: submit-time flow preview ("会到谁手上、几步") — read-only, derived from the
             loaded template's approvalGraph, so a requester can see the flow BEFORE filling the
             form in. STATIC per the loaded template only: no per-form-value resolution of which
             conditional branch will actually be taken (that live-resolve is the gated B3-05
             enhancement) — a condition/fan-out step honestly renders "按条件进入后续分支"
             (see `summarizeApprovalFlow`) instead of fabricating a guessed path. -->
        <el-card
          v-if="flowPreviewSteps.length > 0"
          class="approval-new__flow-preview"
          shadow="never"
          data-testid="approval-flow-preview"
        >
          <template #header>
            <span class="approval-new__flow-preview-header">审批流程</span>
          </template>
          <div class="approval-new__flow-preview-row">
            <span class="approval-new__flow-preview-chip approval-new__flow-preview-chip--requester">
              发起人
            </span>
            <template v-for="step in flowPreviewSteps" :key="step.key">
              <span class="approval-new__flow-preview-arrow">→</span>
              <span
                class="approval-new__flow-preview-chip"
                :class="{ 'approval-new__flow-preview-chip--conditional': step.isConditional }"
                data-testid="approval-flow-preview-step"
              >
                {{ step.name }}
                <span class="approval-new__flow-preview-chip-summary">{{ step.assigneeSummary }}</span>
              </span>
            </template>
          </div>

          <!-- RP-2 (B3-05): live route preview — resolves the ACTUAL path for the values typed so
               far by walking the real create pipeline server-side (read-only). Compute-at-click,
               and any later form edit clears the result so a stale path never misleads. -->
          <div class="approval-new__route-preview" data-testid="approval-route-preview">
            <el-button
              size="small"
              :loading="routePreviewLoading"
              data-testid="approval-route-preview-btn"
              @click="loadRoutePreview"
            >
              按当前表单预览路径
            </el-button>
            <div v-if="routePreviewError" class="approval-new__route-preview-error" data-testid="approval-route-preview-error">
              {{ routePreviewError }}
            </div>
            <div v-else-if="routePreview" class="approval-new__flow-preview-row" data-testid="approval-route-preview-row">
              <span class="approval-new__flow-preview-chip approval-new__flow-preview-chip--requester">
                发起人
              </span>
              <template v-for="node in routePreview.route" :key="node.nodeKey">
                <span class="approval-new__flow-preview-arrow">→</span>
                <span
                  class="approval-new__flow-preview-chip"
                  :class="{ 'approval-new__flow-preview-chip--unresolved': !!node.resolveError }"
                  data-testid="approval-route-preview-node"
                >
                  {{ node.nodeLabel }}
                  <span class="approval-new__flow-preview-chip-summary">{{ routePreviewAssigneeSummary(node) }}</span>
                </span>
              </template>
              <span
                v-if="routePreview.truncated"
                class="approval-new__route-preview-truncated"
                data-testid="approval-route-preview-truncated"
              >
                （路径未能完整解析，以实际流转为准）
              </span>
              <span v-else-if="routePreview.route.length === 0" class="approval-new__route-preview-truncated">
                （按当前表单将直接通过，无审批节点）
              </span>
            </div>
          </div>
        </el-card>

        <!-- Lock-1 §K2 (提交人自选): submit-time approver chooser. Rendered only when the
             loaded template's graph carries a requester_choice node; REQUIRED — handleSubmit
             blocks until every such node has a mode-satisfying choice. The picker is
             scope-filtered server-side (members/role scope → userIds/roleIds params on the
             participant directory search); createApproval re-validates the submitted choice
             fail-closed either way. -->
        <el-card
          v-if="requesterChoiceNodes.length > 0"
          class="approval-new__requester-choice"
          shadow="never"
          data-testid="approval-requester-choice"
        >
          <template #header>
            <span class="approval-new__flow-preview-header">选择审批人</span>
          </template>
          <el-form label-position="top">
            <el-form-item
              v-for="chooser in requesterChoiceNodes"
              :key="chooser.nodeKey"
              :label="`${chooser.nodeName}（${chooser.mode === 'multi' ? '可选多人' : '选一人'} · ${chooserScopeLabel(chooser)}）`"
              required
              data-testid="approval-requester-choice-item"
            >
              <el-select
                :model-value="chooser.mode === 'multi' ? (requesterChoices[chooser.nodeKey] ?? []) : (requesterChoices[chooser.nodeKey]?.[0] ?? undefined)"
                :multiple="chooser.mode === 'multi'"
                filterable
                remote
                clearable
                :remote-method="(q: string) => searchChoiceCandidates(chooser, q)"
                :loading="choiceSearchLoading[chooser.nodeKey] === true"
                class="ms-w-100pct"
                placeholder="搜索并选择审批人"
                :data-testid="`approval-requester-choice-picker-${chooser.nodeKey}`"
                @update:model-value="(value: string[] | string | null) => setRequesterChoice(chooser, value)"
                @visible-change="(visible: boolean) => visible && searchChoiceCandidates(chooser, '')"
              >
                <el-option
                  v-for="(option, optionIndex) in choiceOptions[chooser.nodeKey] ?? []"
                  :key="option.id"
                  :label="choiceOptionLabel(option, optionIndex)"
                  :value="option.id"
                  :disabled="isChoiceOptionUnidentifiable(chooser, option)"
                />
              </el-select>
            </el-form-item>
          </el-form>
        </el-card>

        <el-divider content-position="left">填写表单</el-divider>

        <el-form
          ref="formRef"
          :model="formData"
          :rules="formRules"
          label-position="top"
          class="approval-new__form"
        >
          <el-form-item
            v-for="field in visibleFields"
            :key="field.id"
            :label="field.label"
            :prop="field.id"
            :required="field.required"
          >
            <template v-if="field.placeholder" #label>
              {{ field.label }}
              <span class="approval-new__field-hint">{{ field.placeholder }}</span>
            </template>

            <!-- FWB-0 Layer 2 record-link: single-record picker locked to server-pinned sheetId.
                 No free-text record-id entry — value shape is exactly { recordId }. -->
            <div
              v-if="field.type === 'record-link'"
              class="approval-new__record-link"
              data-testid="approval-record-link-field"
            >
              <div class="approval-new__record-link-row">
                <el-input
                  :model-value="recordLinkDisplay(field.id)"
                  readonly
                  placeholder="请选择一条关联记录"
                  data-testid="approval-record-link-display"
                />
                <el-button
                  type="primary"
                  plain
                  data-testid="approval-record-link-pick"
                  @click="openRecordLinkPicker(field)"
                >
                  选择记录
                </el-button>
                <el-button
                  v-if="formData[field.id]"
                  plain
                  data-testid="approval-record-link-clear"
                  @click="clearRecordLink(field.id)"
                >
                  清除
                </el-button>
              </div>
            </div>

            <!-- text -->
            <el-input
              v-else-if="field.type === 'text'"
              v-model="formData[field.id]"
              :placeholder="field.placeholder || `请输入${field.label}`"
            />

            <!-- textarea -->
            <el-input
              v-else-if="field.type === 'textarea'"
              v-model="formData[field.id]"
              type="textarea"
              :rows="3"
              :placeholder="field.placeholder || `请输入${field.label}`"
            />

            <!-- number -->
            <el-input-number
              v-else-if="field.type === 'number'"
              v-model="formData[field.id]"
              :placeholder="field.placeholder"
              :disabled="isAutoSummedTotal(field.id)"
              :controls="!isAutoSummedTotal(field.id)"
              v-bind="numberFieldProps(field)"
              class="ms-w-100pct"
            />
            <!-- date -->
            <el-date-picker
              v-else-if="field.type === 'date'"
              v-model="formData[field.id]"
              type="date"
              :placeholder="field.placeholder || `请选择${field.label}`"
              class="ms-w-100pct"
            />

            <!-- datetime -->
            <el-date-picker
              v-else-if="field.type === 'datetime'"
              v-model="formData[field.id]"
              type="datetime"
              :placeholder="field.placeholder || `请选择${field.label}`"
              class="ms-w-100pct"
            />

            <!-- Lock-8 L8-B (approval-lock8-field-vocabulary-20260817.md §1.2, OD-L8-8) date_range:
                 two pickers of the field's declared granularity, bound to `{ start, end }`, plus an
                 ALWAYS-rendered read-only derived duration (never a control — a plain span, no
                 v-model, no input element: OD-L8-8 forbids any authoring control that offers
                 editing it). value-format is explicit on BOTH pickers so the submitted wire shape
                 is a deterministic string matching the server's `date_range` value contract exactly
                 (never the picker's own default Date-object binding). -->
            <div
              v-else-if="field.type === 'date_range'"
              class="approval-new__date-range"
              data-testid="approval-date-range-field"
            >
              <div class="approval-new__date-range-row">
                <el-date-picker
                  :model-value="dateRangeStart(field.id)"
                  :type="dateRangePickerElementType(field.props?.dateType)"
                  :value-format="dateRangePickerValueFormat(field.props?.dateType)"
                  :placeholder="(field.props?.startLabel as string) || '起始'"
                  data-testid="approval-date-range-start"
                  @update:model-value="(value: string | null) => setDateRangeStart(field.id, value)"
                />
                <span class="approval-new__date-range-sep">至</span>
                <el-date-picker
                  :model-value="dateRangeEnd(field.id)"
                  :type="dateRangePickerElementType(field.props?.dateType)"
                  :value-format="dateRangePickerValueFormat(field.props?.dateType)"
                  :placeholder="(field.props?.endLabel as string) || '结束'"
                  data-testid="approval-date-range-end"
                  @update:model-value="(value: string | null) => setDateRangeEnd(field.id, value)"
                />
              </div>
              <div class="approval-new__date-range-duration" data-testid="approval-date-range-duration">
                <span class="approval-new__date-range-duration-label">{{ dateRangeDurationLabel(field) }}</span>
                <span data-testid="approval-date-range-duration-value">{{ dateRangeDurationDisplay(field) }}</span>
              </div>
            </div>

            <!-- select -->
            <el-select
              v-else-if="field.type === 'select'"
              v-model="formData[field.id]"
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
              v-model="formData[field.id]"
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

            <!-- user (B3-04 D-2: real participant directory picker) -->
            <ApprovalUserPicker
              v-else-if="field.type === 'user'"
              :model-value="(formData[field.id] as string | null | undefined) ?? null"
              @update:model-value="formData[field.id] = $event"
            />

            <ApprovalDepartmentPicker
              v-else-if="field.type === 'department'"
              :model-value="departmentFieldValue(field.id)"
              :selection="departmentSelection(field)"
              :display="departmentDisplay(field)"
              :max-selections="departmentMaxSelections(field)"
              :default-mode="departmentDefaultMode(field)"
              :default-department-ids="departmentDefaultIds(field)"
              :aria-label="`选择${field.label}`"
              :placeholder="field.placeholder || `请选择${field.label}`"
              @update:model-value="formData[field.id] = $event"
            />

            <!-- detail / sub-form (明细): editable rows × leaf-column cells. `formData[field.id]`
                 is an array of row objects keyed by sub-field id; each cell reuses the matching
                 leaf editor. Respects minRows/maxRows (add disabled at maxRows; remove disabled
                 at minRows). The backend re-validates row count / required / per-cell types. -->
            <div v-else-if="field.type === 'detail'" class="approval-new__detail">
              <el-table
                :data="detailRows(field.id)"
                border
                size="small"
                class="approval-new__detail-table"
              >
                <el-table-column
                  v-for="column in (field.columns || [])"
                  :key="column.id"
                  :label="column.label"
                  :prop="column.id"
                >
                  <template #header>
                    {{ column.label }}<span v-if="column.required" class="approval-new__detail-required">*</span>
                  </template>
                  <template #default="{ row }">
                    <!-- per-row sub-field visibility (design-lock §4): a cell whose
                         column.visibilityRule is false for THIS row renders nothing and is pruned
                         from the submit payload by the same evaluation. -->
                    <template v-if="isDetailCellVisible(field, column, row)">
                    <el-input
                      v-if="column.type === 'text'"
                      v-model="row[column.id]"
                      :placeholder="column.placeholder || column.label"
                    />
                    <el-input
                      v-else-if="column.type === 'textarea'"
                      v-model="row[column.id]"
                      type="textarea"
                      :rows="2"
                      :placeholder="column.placeholder || column.label"
                    />
                    <el-input-number
                      v-else-if="column.type === 'number'"
                      v-model="row[column.id]"
                      :controls="false"
                      :disabled="isDetailDerivedColumnReadOnly(field, column, row)"
                      v-bind="numberFieldProps(column)"
                      class="ms-w-100pct"
                    />
                    <el-date-picker
                      v-else-if="column.type === 'date'"
                      v-model="row[column.id]"
                      type="date"
                      :placeholder="column.label"
                      class="ms-w-100pct"
                    />
                    <el-date-picker
                      v-else-if="column.type === 'datetime'"
                      v-model="row[column.id]"
                      type="datetime"
                      :placeholder="column.label"
                      class="ms-w-100pct"
                    />
                    <el-select
                      v-else-if="column.type === 'select'"
                      v-model="row[column.id]"
                      :placeholder="column.label"
                      class="ms-w-100pct"
                    >
                      <el-option
                        v-for="opt in (column.options || [])"
                        :key="opt.value"
                        :label="opt.label"
                        :value="opt.value"
                      />
                    </el-select>
                    <el-select
                      v-else-if="column.type === 'multi-select'"
                      v-model="row[column.id]"
                      multiple
                      :placeholder="column.label"
                      class="ms-w-100pct"
                    >
                      <el-option
                        v-for="opt in (column.options || [])"
                        :key="opt.value"
                        :label="opt.label"
                        :value="opt.value"
                      />
                    </el-select>
                    <ApprovalUserPicker
                      v-else-if="column.type === 'user'"
                      :model-value="(row[column.id] as string | null | undefined) ?? null"
                      @update:model-value="row[column.id] = $event"
                    />
                    <el-input v-else v-model="row[column.id]" :placeholder="column.label" />
                    </template>
                  </template>
                </el-table-column>
                <el-table-column label="操作" width="80" align="center">
                  <template #default="{ $index }">
                    <el-button
                      type="danger"
                      link
                      :disabled="!canRemoveDetailRow(field)"
                      @click="removeDetailRow(field.id, $index)"
                    >
                      删除
                    </el-button>
                  </template>
                </el-table-column>
                <template #empty>
                  <span class="approval-new__detail-empty">暂无明细行，请点击下方“添加一行”</span>
                </template>
              </el-table>
              <div class="approval-new__detail-actions">
                <el-button
                  type="primary"
                  plain
                  size="small"
                  :disabled="!canAddDetailRow(field)"
                  @click="addDetailRow(field)"
                >
                  添加一行
                </el-button>
                <span v-if="detailRowsHint(field)" class="approval-new__detail-hint">
                  {{ detailRowsHint(field) }}
                </span>
              </div>
            </div>

            <!-- attachment, flag ON (B3-07 #4195): the REAL uploader — each picked file is
                 client-pre-validated (mirror only; the server re-validates authoritatively) and
                 uploaded to POST /api/approval/attachments; formData[field.id] holds the returned
                 id ARRAY (never a raw File), which the create txn binds atomically (§4.4). -->
            <div
              v-else-if="field.type === 'attachment' && attachmentUploadEnabled"
              class="approval-new__attachment-upload"
              data-testid="approval-attachment-upload"
            >
              <input
                type="file"
                multiple
                accept=".pdf,.jpg,.jpeg,.png,.txt,.csv"
                :data-testid="`approval-attachment-input-${field.id}`"
                :disabled="attachmentUploading"
                @change="onAttachmentPick(field, $event)"
              />
              <ul v-if="attachmentList(field.id).length > 0" class="approval-new__attachment-list">
                <li v-for="item in attachmentList(field.id)" :key="item.id">
                  <span>{{ item.name }}</span>
                  <el-button link type="danger" @click="removeAttachment(field.id, item.id)">移除</el-button>
                </li>
              </ul>
              <span class="approval-new__field-hint">支持 PDF / JPG / PNG / TXT / CSV，单文件 ≤ 20MB，每字段 ≤ 10 个</span>
            </div>

            <!-- attachment, flag OFF: B2-28 honest-disable STOPGAP (byte-identical while
                 APPROVAL_ATTACHMENTS_ENABLED stays OFF — D5/G1). The previous el-upload
                 (action="#" + auto-upload=false) was fully interactive but never actually uploaded
                 anything: the raw File a user dropped landed in formData, and JSON.stringify-ing that
                 for the request body silently turned it into `{}` — a success toast over
                 quietly-dropped data. An honest disabled placeholder beats a fake uploader. The field
                 label + required marker (rendered by the surrounding el-form-item) stay visible;
                 `formRules` (below) excludes attachment fields so a `required` attachment can never
                 block submission. handleSubmit additionally strips attachment-typed keys defensively
                 flag-OFF (see stripAttachmentFields / buildSubmitFormData). -->
            <div
              v-else-if="field.type === 'attachment'"
              class="approval-new__attachment-disabled"
              data-testid="approval-attachment-disabled"
            >
              附件上传功能即将支持，请先在其他字段中注明附件信息。
            </div>

            <!-- Lock-8 L8-A (approval-lock8-field-vocabulary-20260817.md §1.1, OD-L8-2/OD-L8-3)
                 explanation: display-only. Renders the authored `props.text` body to the
                 requester. No v-model: an explanation collects nothing (A-1), so there is no
                 formData key to bind — WITHOUT this arm, an explanation field would fall through
                 to the plain-text-input fallback below and silently collect a value it must never
                 carry. white-space:pre-wrap preserves authored line breaks without interpreting
                 markup (plain text, never raw HTML). -->
            <div
              v-else-if="field.type === 'explanation'"
              class="approval-new__explanation"
              data-testid="approval-explanation-field"
            >
              {{ (field.props?.text as string) || '' }}
            </div>

            <!-- fallback -->
            <el-input
              v-else
              v-model="formData[field.id]"
              :placeholder="field.placeholder || `请输入${field.label}`"
            />

            <!-- G-B2-16: 大写回显 — under the template-declared amount total (no label guessing),
                 OR (L8-C, §0.4: "re-sites [amountInWords] to a per-field display flag") under a
                 formatted-number field's own `props.uppercaseCny` — additive, neither trigger
                 replaces the other (an old template with no `uppercaseCny` prop keeps behaving
                 exactly as it does today). Keep this outside the field-type v-if chain so earlier
                 branches never fall through twice. -->
            <div
              v-if="field.type === 'number' && (isAutoSummedTotal(field.id) || isAmountWordsField(field)) && amountWordsFor(field)"
              class="approval-new__amount-words"
              data-testid="approval-amount-words"
            >
              大写：{{ amountWordsFor(field) }}
            </div>

            <!-- L8-C: formatted-number display caption (currency prefix / thousands grouping) —
                 PRESENTATION ONLY, the same value the input holds (M10). -->
            <div
              v-if="field.type === 'number' && amountDisplayCaption(field)"
              class="approval-new__amount-display"
              data-testid="approval-amount-display"
            >
              {{ amountDisplayCaption(field) }}
            </div>

            <span v-if="isAutoSummedTotal(field.id)" class="approval-new__field-hint">
              由明细自动汇总，无需手填
            </span>
          </el-form-item>

          <el-divider />

          <el-form-item class="approval-new__submit">
            <el-button
              type="primary"
              :loading="approvalStore.loading"
              :disabled="!canWrite"
              @click="handleSubmit"
            >
              提交审批
            </el-button>
            <el-button @click="goBack">取消</el-button>
          </el-form-item>
        </el-form>
      </div>

      <el-empty v-else-if="!templateStore.loading" description="未找到审批模板" />
    </div>

    <!-- FWB-0 Layer 2: dedicated record-link picker (pinned baseId+sheetId; no MetaField fabric). -->
    <ApprovalRecordLinkPicker
      v-if="recordLinkPickerField"
      :visible="recordLinkPickerVisible"
      :base-id="recordLinkPickerBaseId"
      :sheet-id="recordLinkPickerSheetId"
      :current-record-id="recordLinkPickerCurrentId"
      @close="recordLinkPickerVisible = false"
      @confirm="onRecordLinkPicked"
    />
  </PageShell>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import PageShell from '../../components/layout/PageShell.vue'
import PageHeader from '../../components/layout/PageHeader.vue'
import StatusTag from '../../components/status/StatusTag.vue'
import type {
  ApprovalAssigneeSource,
  FormField,
  FormSchema,
  RequesterChoiceAssigneeSource,
} from '../../types/approval'
import { useApprovalStore } from '../../approvals/store'
import { useApprovalTemplateStore } from '../../approvals/templateStore'
import { useApprovalPermissions } from '../../approvals/permissions'
import { getVisibleFormFields } from '../../approvals/fieldVisibility'
import { recordRecentTemplate } from '../../approvals/recentTemplates'
import { useAuth } from '../../composables/useAuth'
import { useAutoSumTotal } from '../../approvals/useAutoSumTotal'
import { isRowDerivationActive } from '../../approvals/lineDerivation'
import {
  numberFieldProps,
  amountDisplayProps,
  isAmountWordsField,
  formatAmountDisplay,
  roundToFieldScale,
} from '../../approvals/numberFieldProps'
import { amountToChineseWords } from '../../approvals/amountInWords'
import { numberFieldScale } from '../../approvals/amountAutoSum'
import { clearFormDraft, formDraftKey, formSchemaSignature, loadFormDraft, saveFormDraft } from '../../approvals/formDraft'
import ApprovalUserPicker from '../../approvals/components/ApprovalUserPicker.vue'
import ApprovalDepartmentPicker, {
  type ApprovalDepartmentValue,
} from '../../approvals/components/ApprovalDepartmentPicker.vue'
import {
  createEmptyDetailRow,
  isDetailCellVisible,
  pruneHiddenFormDataWithDetail,
  validateDetailRows,
} from '../../approvals/detailField'
import { summarizeApprovalFlow, type ApprovalFlowStep } from '../../approvals/graphSummary'
import {
  previewApprovalRoute,
  searchApprovalDirectoryUsers,
  type ApprovalDirectoryUser,
  type ApprovalRoutePreview,
} from '../../approvals/api'
import { routePreviewAssigneeSummary } from '../../approvals/routePreviewSummary'
import { createRoutePreviewController } from '../../approvals/routePreviewController'
import { getApproval } from '../../approvals/api'
import { prefillFromSnapshot } from '../../approvals/prefillFromSnapshot'
import {
  formatRecordLinkDisplay,
  parseRecordLinkValue,
  recordLinkBaseId,
  recordLinkSheetId,
} from '../../approvals/recordLinkField'
import ApprovalRecordLinkPicker from '../../approvals/components/ApprovalRecordLinkPicker.vue'
import {
  computeDateRangeDurationText,
  dateRangePickerElementType,
  dateRangePickerValueFormat,
} from '../../approvals/dateRangeField'
import {
  deleteApprovalAttachment,
  fetchApprovalAttachmentRefs,
  preValidateAttachments,
  uploadApprovalAttachmentsAtomic,
} from '../../approvals/attachmentUpload'
import { collectAttachmentRefIds, dropStaleAttachmentRefs } from '../../approvals/attachmentRefs'
import { useFeatureFlags } from '../../stores/featureFlags'
import { ensureUserNamesResolved } from '../../approvals/directoryResolve'

const route = useRoute()
const router = useRouter()
const approvalStore = useApprovalStore()
const templateStore = useApprovalTemplateStore()
const { canWrite } = useApprovalPermissions()

const formRef = ref<FormInstance>()
const formData = reactive<Record<string, unknown>>({})
// FWB-0 Layer 2 record-link picker state (single-record; value shape { recordId }).
const recordLinkPickerVisible = ref(false)
const recordLinkPickerField = ref<FormField | null>(null)
// Human labels keyed by field id (NOT recordId): two record-link fields may pin different
// sheets and still share the same record id with different display names. Keying by recordId
// alone overwrites the first field's label when the second is selected.
const recordLinkLabels = reactive<Record<string, string>>({})

// B3-07 (#4195): attachment upload — flag-gated swap of the B2-28 placeholder. formData[field.id]
// holds the uploaded id ARRAY (the §4.4 bind contract); the display names live here only.
const { features: productFeatures } = useFeatureFlags()
const attachmentUploadEnabled = computed(() => productFeatures.value.approvalAttachments === true)
const uploadedAttachments = reactive<Record<string, Array<{ id: string; name: string }>>>({})
const attachmentUploading = ref(false)

function departmentFieldValue(fieldId: string): ApprovalDepartmentValue[] {
  const value = formData[fieldId]
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    if (typeof record.id !== 'string' || !record.id) return []
    return [{
      id: record.id,
      ...(typeof record.name === 'string' ? { name: record.name } : {}),
      ...(typeof record.fullPath === 'string' ? { fullPath: record.fullPath } : {}),
    }]
  })
}

function departmentSelection(field: FormField): 'single' | 'multi' {
  return field.props?.selection === 'multi' ? 'multi' : 'single'
}

function departmentDisplay(field: FormField): 'leaf_only' | 'full_path' {
  return field.props?.display === 'full_path' ? 'full_path' : 'leaf_only'
}

function departmentMaxSelections(field: FormField): number | undefined {
  return typeof field.props?.maxSelections === 'number' ? field.props.maxSelections : undefined
}

function departmentDefaultMode(field: FormField): 'requester_department' | 'designated' | undefined {
  return field.props?.defaultMode === 'requester_department' || field.props?.defaultMode === 'designated'
    ? field.props.defaultMode
    : undefined
}

function departmentDefaultIds(field: FormField): string[] {
  return Array.isArray(field.props?.defaultDepartmentIds)
    ? field.props.defaultDepartmentIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []
}

function attachmentList(fieldId: string): Array<{ id: string; name: string }> {
  return uploadedAttachments[fieldId] ?? []
}

function syncAttachmentFormValue(fieldId: string): void {
  formData[fieldId] = attachmentList(fieldId).map((item) => item.id)
}

async function onAttachmentPick(field: FormField, event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const picked = Array.from(input.files ?? [])
  input.value = '' // allow re-picking the same file after a reject/remove
  if (picked.length === 0) return
  const templateId = route.params.templateId as string
  const current = attachmentList(field.id)
  if (current.length + picked.length > 10) {
    ElMessage.error('附件数量超出上限（每字段最多 10 个）')
    return
  }
  // client mirror of the ratified caps/allowlist — the server re-validates authoritatively (422).
  const rejects = preValidateAttachments(picked.map((f) => ({ name: f.name, type: f.type, size: f.size })))
  if (rejects.length > 0) {
    ElMessage.error(`附件被拒绝（${rejects[0].code}）`)
    return
  }
  attachmentUploading.value = true
  try {
    // Atomic multi-file selection: if a later authoritative server upload fails, successful
    // uploads from THIS pick are compensated (DELETE) so the draft gains zero live/bindable refs
    // from a refused selection. DELETE soft-deletes + enqueues a durable purge intent; physical
    // blob deletion is eventual (GC worker). Files already staged from a prior pick stay untouched.
    const uploaded = await uploadApprovalAttachmentsAtomic(picked, templateId, field.id)
    const list = uploadedAttachments[field.id] ?? (uploadedAttachments[field.id] = [])
    for (let i = 0; i < uploaded.length; i += 1) {
      list.push({ id: uploaded[i].id, name: picked[i].name })
    }
    syncAttachmentFormValue(field.id)
  } catch (error) {
    // values-free code from the client mirror / server reject — never file contents or paths.
    ElMessage.error(error instanceof Error ? error.message : '附件上传失败')
  } finally {
    attachmentUploading.value = false
  }
}

/**
 * §4.3 removal. The server-side DELETE is the load-bearing half: it soft-deletes the staged row and
 * enqueues the durable blob-purge intent, so a removed file's blob is actually reclaimed instead of
 * lingering until the 7-day unbound TTL. Dropping the id from `formData` alone would leave the blob
 * (and its row) live and orphaned — a client-only removal is not a removal.
 *
 * Ordering: the server call comes FIRST and the local drop happens only after it resolves. On failure
 * the id STAYS in the list — a UI that showed the file as removed while it is still bound-able would
 * be lying, and the user could not retry. `deleteApprovalAttachment` treats the values-free 404 as
 * success (see its doc comment), so the only thing that keeps the entry is a genuine failure.
 */
async function removeAttachment(fieldId: string, attachmentId: string): Promise<void> {
  const list = uploadedAttachments[fieldId]
  if (!list) return
  try {
    await deleteApprovalAttachment(attachmentId)
  } catch {
    ElMessage.error('附件移除失败，请重试')
    return
  }
  const index = list.findIndex((item) => item.id === attachmentId)
  if (index >= 0) list.splice(index, 1)
  syncAttachmentFormValue(fieldId)
}
// UX B2-13 (再次提交): true once a `?fromInstance=` prefill actually applied at least one field —
// see `applyResubmitPrefill` below. Drives the "已从上一次申请预填" notice.
const prefillNoticeVisible = ref(false)

// G-B2-14: localStorage draft autosave/restore (per user+template; pure helpers in
// approvals/formDraft.ts). The machinery arms only once BOTH the template and the user id are
// known; a resubmit-prefill (B2-13) takes precedence — the restore offer is skipped entirely.
const draftUserId = ref<string | null>(null)
const draftRestoreVisible = ref(false)
const pendingDraft = ref<Record<string, unknown> | null>(null)
let draftSaveTimer: ReturnType<typeof setTimeout> | null = null
let draftArmed = false

function draftStorageKey(): string | null {
  const templateId = route.params.templateId as string
  if (!draftUserId.value || !templateId || !template.value) return null
  return formDraftKey(draftUserId.value, templateId)
}

function offerDraftRestore(): void {
  const key = draftStorageKey()
  if (!key || !template.value) return
  const draft = loadFormDraft(window.localStorage, key, formSchemaSignature(template.value.formSchema))
  if (!draft) return
  pendingDraft.value = draft
  draftRestoreVisible.value = true
}

/**
 * G13 / O2 — **stale attachment-reference detection on draft restore.**
 *
 * With the flag ON a draft persists its staged attachment ids (below), and those ids point at rows the
 * 7-day unbound-retention GC may have swept in the meantime. Restoring them unmodified would carry a
 * DANGLING id into the create, where the §4.4 bind fails the WHOLE submission closed — with nothing
 * the user can act on. So the restore asks the server which of the draft's ids are still live (an
 * uploader-scoped check that discloses nothing) and drops the rest, telling the user their staged
 * files expired. Never silently kept as a dangling id; never resolved to a deleted blob.
 *
 * Fail-closed on a failed check: if the server cannot be reached we drop EVERY attachment ref rather
 * than restore ids we could not confirm — an unverified ref is exactly the dangling-ref case this
 * gate exists to prevent, and re-picking a file is cheap next to a rejected submission.
 */
async function applyDraftRestore(): Promise<void> {
  const draft = pendingDraft.value
  pendingDraft.value = null
  draftRestoreVisible.value = false
  if (!draft) return
  const schema = template.value?.formSchema ?? null
  if (!attachmentUploadEnabled.value || !schema) {
    // Flag OFF: drafts never carried attachment ids in the first place (B2-28 strip) — restore as-is.
    Object.assign(formData, draft)
    return
  }
  const refIds = collectAttachmentRefIds(schema, draft)
  if (refIds.length === 0) {
    Object.assign(formData, draft)
    return
  }
  let staleIds: string[] = refIds
  let liveByIdName = new Map<string, string>()
  try {
    const refs = await fetchApprovalAttachmentRefs(refIds)
    staleIds = refs.filter((ref) => ref.stale !== false).map((ref) => ref.id)
    liveByIdName = new Map(
      refs.filter((ref) => ref.stale === false).map((ref) => [ref.id, ref.fileName ?? ref.id]),
    )
  } catch {
    // fail-closed: unverifiable ⇒ treat every ref as stale (staleIds already = every ref id).
    liveByIdName = new Map()
  }
  const scan = dropStaleAttachmentRefs(schema, draft, staleIds)
  Object.assign(formData, scan.data)
  // Rebuild the uploader's display list from what the SERVER confirmed live — never from the draft's
  // own remembered names, which could disagree with the row the id actually resolves to now.
  for (const field of schema.fields ?? []) {
    if (field.type !== 'attachment') continue
    const kept = Array.isArray(scan.data[field.id]) ? (scan.data[field.id] as string[]) : []
    uploadedAttachments[field.id] = kept.map((id) => ({ id, name: liveByIdName.get(id) ?? id }))
  }
  if (scan.staleIds.length > 0) {
    ElMessage.warning(`${scan.staleIds.length} 个暂存附件已过期，已从草稿中移除，请重新上传`)
  }
}

function discardDraftRestore(): void {
  const key = draftStorageKey()
  if (key) clearFormDraft(window.localStorage, key)
  pendingDraft.value = null
  draftRestoreVisible.value = false
}

function scheduleDraftSave(): void {
  if (!draftArmed) return
  if (draftSaveTimer) clearTimeout(draftSaveTimer)
  draftSaveTimer = setTimeout(() => {
    const key = draftStorageKey()
    if (!key || !template.value) return
    // Flag ON (#4195 G13): attachment ids ARE persisted in the draft, because the restore path now
    // detects stale refs (`applyDraftRestore` above) — a draft that outlives the 7-day unbound GC has
    // its swept ids dropped and surfaced at restore instead of being carried into a submission. Flag
    // OFF keeps the B2-28 strip byte-identical (there is no uploader, so an attachment key in a draft
    // could only be junk).
    const data = attachmentUploadEnabled.value
      ? { ...formData }
      : stripAttachmentFields(template.value.formSchema, { ...formData })
    saveFormDraft(window.localStorage, key, formSchemaSignature(template.value.formSchema), data)
  }, 800)
}

watch(formData, scheduleDraftSave, { deep: true })
// UX B2-13: folded into the SAME `v-loading` overlay as the template/submit loads (below) so the
// form can't be interacted with — and submitted un-prefilled — during the brief window between
// the template finishing its own load and the source-instance prefill fetch resolving.
const prefillLoading = ref(false)
const template = computed(() => templateStore.activeTemplate)
const visibleFields = computed(() => {
  if (!template.value) return []
  return getVisibleFormFields(template.value.formSchema, formData)
})
const visibleFieldIds = computed(() => visibleFields.value.map((field) => field.id))

// UX B2-07: submit-time flow preview ("审批流程") — STATIC per the loaded template (walks the
// whole graph from `start`; no per-form-value branch resolution, see the template comment above).
const flowPreviewSteps = computed<ApprovalFlowStep[]>(() => {
  const graph = template.value?.approvalGraph
  if (!graph) return []
  return summarizeApprovalFlow(graph, template.value?.formSchema ?? null)
})

// ---------------------------------------------------------------------------
// Lock-1 §K2 (提交人自选) — submit-time approver chooser state.
// ---------------------------------------------------------------------------
interface RequesterChoiceChooser {
  nodeKey: string
  nodeName: string
  mode: 'single' | 'multi'
  scope: RequesterChoiceAssigneeSource['scope']
}

// One chooser row per approval node whose sources include a requester_choice entry (the FIRST
// such source drives the UI; the server validates the submitted choice against EVERY
// requester_choice source on the node, so the UI can never under-constrain the create).
const requesterChoiceNodes = computed<RequesterChoiceChooser[]>(() => {
  const graph = template.value?.approvalGraph
  if (!graph) return []
  const choosers: RequesterChoiceChooser[] = []
  for (const node of graph.nodes) {
    if (node.type !== 'approval') continue
    const sources = (node.config as { assigneeSources?: ApprovalAssigneeSource[] }).assigneeSources
    if (!Array.isArray(sources)) continue
    const source = sources.find(
      (entry): entry is RequesterChoiceAssigneeSource => !!entry && entry.kind === 'requester_choice',
    )
    if (source) {
      choosers.push({
        nodeKey: node.key,
        nodeName: (node.name && node.name.trim()) || node.key,
        mode: source.mode,
        scope: source.scope,
      })
    }
  }
  return choosers
})

const requesterChoices = reactive<Record<string, string[]>>({})
const choiceOptions = reactive<Record<string, ApprovalDirectoryUser[]>>({})
const choiceSearchLoading = reactive<Record<string, boolean>>({})
// member-display-identity (2026-08-19; requester-choice raw-id-render fix; stale-cache fix
// 2026-08-21): nodeKey -> id -> real name, kept in sync with the FRESHEST search response for
// that id (`searchChoiceCandidates` below) — a name is written when the latest page confirms one,
// and DELETED the moment the latest page for that id comes back blank/absent (a directory record
// can be renamed to blank, anonymized, or deactivated between two searches; the freshest answer
// must win, never an earlier append). Accumulating confirmed names ACROSS pages (rather than
// replacing the whole map per page) is what lets a candidate picked from an EARLIER search page
// stay identifiable at submit time even after a LATER search's result page doesn't happen to
// re-include that id at all — the deletion above only fires when that id IS present in a later
// page with a blank name, never merely because a later page omits it. This is the single source of
// truth `isChoiceOptionUnidentifiable` and the submit-time gate below both read.
const choiceConfirmedNames = reactive<Record<string, Record<string, string>>>({})
// Per-node request epoch (2026-08-21, mirrors routePreviewController.ts's race-guard): a search
// fired by an EARLIER focus/keystroke can resolve AFTER a LATER one if the network reorders
// responses. Only the response whose captured generation still matches the node's CURRENT
// generation may write `choiceOptions`/`choiceConfirmedNames` — an out-of-order resolution is
// discarded outright rather than silently clobbering a newer, already-rendered result page. Not
// `reactive`: purely an internal ordering token, never read by a template or computed.
const choiceSearchGeneration: Record<string, number> = {}

function chooserScopeLabel(chooser: RequesterChoiceChooser): string {
  if (chooser.scope.type === 'members') return '限指定成员'
  if (chooser.scope.type === 'role') return '限指定角色的成员'
  return '全公司可选'
}

// raw-id-render fix (2026-08-19): SAME contract as ApprovalUserPicker.vue's `optionLabel` — a
// blank/unresolved directory name falls back to a values-free, per-list ordinal ("成员 N"), NEVER
// the raw directory id. Previously this fell back to `option.id`, which a requester (not just an
// admin) would see whenever a scope-matched candidate's directory record has no name — the
// primary site this fix closes (census class: requester-facing SELECT leak).
function choiceOptionLabel(option: ApprovalDirectoryUser, index: number): string {
  const primary = option.name?.trim() || `成员 ${index + 1}`
  const email = option.email?.trim()
  return email ? `${primary} · ${email}` : primary
}

// Same GOAL as ApprovalUserPicker.vue's `isUnidentifiable` (a candidate with no resolvable name
// must be UNSELECTABLE, never merely relabelled, so a requester can never hand approval authority
// to an account they cannot identify by name) but NO LONGER the same shape as of the 2026-08-21
// stale-cache fix -- this now reads `choiceConfirmedNames` (the freshest-wins record) rather than
// the CURRENT render page's `option.name` directly, and there is deliberately NO "currently-
// selected ids are exempt" special case any more. That exemption (which ApprovalUserPicker.vue
// still has, unchanged by this PR: `if (option.id === props.modelValue) return false`) was
// checking `option.name` against the page the option happens to be rendered from, which is
// exactly the site a stale/renamed-to-blank directory record slipped through here: the id was
// selected while an EARLIER page still confirmed a real name, a LATER page then re-confirmed it
// blank (deleting the entry above), and the exemption kept the now-unconfirmed option enabled
// anyway. Reading `choiceConfirmedNames` alone already preserves the one property the exemption
// existed for -- a selection confirmed on an earlier page stays selectable even when a later
// page's results don't happen to re-include that id at all -- without ever re-enabling an id the
// freshest page has actively retracted.
//
// SIBLING NOT FIXED HERE (2026-08-21 audit, out of this PR's scope): ApprovalUserPicker.vue keeps
// its `modelValue`-exemption AND has no `choiceConfirmedNames`-style freshest-wins record --
// `fetchedOptions` is replaced wholesale per search rather than accumulated, so a re-search that
// returns the CURRENTLY-selected id with a newly-blank name would hit the same exemption shape
// this fix removed. Whether that is exploitable end-to-end depends on whether its 4 consuming
// flows (transfer / add-sign / fill-form user field / delegation delegatee) each enforce
// identifiability independently server-side -- NOT verified by this PR, which only touches the
// requester_choice path (this file only, frontend-side; the backend identifiability arm was
// withdrawn -- it contradicted the RATIFIED Lock-1 §K2 create-time contract, see PR #5043 body).
// Flagged as a candidate follow-up, deliberately not expanded into this diff.
function isChoiceOptionUnidentifiable(chooser: RequesterChoiceChooser, option: ApprovalDirectoryUser): boolean {
  return !choiceConfirmedNames[chooser.nodeKey]?.[option.id]?.trim()
}

async function searchChoiceCandidates(chooser: RequesterChoiceChooser, q: string): Promise<void> {
  const generation = (choiceSearchGeneration[chooser.nodeKey] = (choiceSearchGeneration[chooser.nodeKey] ?? 0) + 1)
  choiceSearchLoading[chooser.nodeKey] = true
  try {
    // Scope-filtered SERVER-SIDE so a members/role-scoped candidate outside the current search
    // page still surfaces, and out-of-scope users never appear as pickable at all.
    const scope = chooser.scope.type === 'members'
      ? { userIds: chooser.scope.userIds }
      : chooser.scope.type === 'role'
        ? { roleIds: chooser.scope.roleIds }
        : {}
    const results = await searchApprovalDirectoryUsers(q, 20, scope)
    // Epoch guard: a later focus/keystroke on this SAME node already started a newer search
    // while this one was in flight -- discard this response entirely (never partially apply it).
    if (choiceSearchGeneration[chooser.nodeKey] !== generation) return
    choiceOptions[chooser.nodeKey] = results
    // Freshest-wins identifiability record for the submit-time gate (see choiceConfirmedNames'
    // own doc above): write a real name when confirmed, DELETE any earlier confirmation the
    // moment this same id comes back blank on the freshest page for this node.
    const confirmed = choiceConfirmedNames[chooser.nodeKey] ?? (choiceConfirmedNames[chooser.nodeKey] = {})
    for (const candidate of results) {
      const name = candidate.name?.trim()
      if (name) confirmed[candidate.id] = name
      else delete confirmed[candidate.id]
    }
    // Also prime the shared authorized-scope resolver cache (directoryResolve.ts) with these
    // candidate ids — harmless if this component never reads it back, but keeps this picker
    // consistent with every other viewer-facing member-identity site's contract of feeding the one
    // shared cache, and means a LATER unrelated resolve() elsewhere on this session for the same
    // id does not need its own network round trip.
    ensureUserNamesResolved(results.map((candidate) => candidate.id))
  } finally {
    // Only the still-current generation may clear the loading flag -- an out-of-order response's
    // `finally` must not mask a still-in-flight newer request as "done".
    if (choiceSearchGeneration[chooser.nodeKey] === generation) choiceSearchLoading[chooser.nodeKey] = false
  }
}

function setRequesterChoice(chooser: RequesterChoiceChooser, value: string[] | string | null): void {
  const ids = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : typeof value === 'string' && value.length > 0
      ? [value]
      : []
  if (ids.length === 0) delete requesterChoices[chooser.nodeKey]
  else requesterChoices[chooser.nodeKey] = ids
  // A changed choice invalidates a previously resolved route preview (stale names must not stick).
  routePreviewController.invalidate()
}

/** First chooser whose selection does not satisfy its mode cardinality; null when all chosen. */
function missingRequesterChoiceNode(): RequesterChoiceChooser | null {
  for (const chooser of requesterChoiceNodes.value) {
    const ids = requesterChoices[chooser.nodeKey] ?? []
    if (chooser.mode === 'single' ? ids.length !== 1 : ids.length === 0) return chooser
  }
  return null
}

/**
 * raw-id-render fix (2026-08-19), defense in depth: `isChoiceOptionUnidentifiable` already
 * disables an unidentifiable option so it cannot be SELECTED in the first place, but this gate
 * closes the same case `reducibleAssignees`' submit-guard closes for 减签 — a chosen id that is no
 * longer identifiable (e.g. the disabled-option check has any gap this fix did not foresee) must
 * still never reach `createApproval`. First chooser carrying a selected id with no confirmed name;
 * null when every selection across every chooser is identifiable.
 */
function firstUnidentifiableChoiceNode(): RequesterChoiceChooser | null {
  for (const chooser of requesterChoiceNodes.value) {
    const confirmed = choiceConfirmedNames[chooser.nodeKey] ?? {}
    const ids = requesterChoices[chooser.nodeKey] ?? []
    if (ids.some((id) => !confirmed[id]?.trim())) return chooser
  }
  return null
}

function buildRequesterChoicesPayload(): Record<string, string[]> {
  const payload: Record<string, string[]> = {}
  for (const chooser of requesterChoiceNodes.value) {
    const ids = requesterChoices[chooser.nodeKey]
    if (ids && ids.length > 0) payload[chooser.nodeKey] = [...ids]
  }
  return payload
}

// RP-2 (B3-05): live route preview state. Compute-at-click; any form edit invalidates the resolved
// path (stale resolution must never keep rendering as if it matched the current values). The
// generation race-guard lives in createRoutePreviewController so it is unit-testable.
const routePreview = ref<ApprovalRoutePreview | null>(null)
const routePreviewLoading = ref(false)
const routePreviewError = ref('')

const routePreviewController = createRoutePreviewController(previewApprovalRoute, (patch) => {
  if ('preview' in patch) routePreview.value = patch.preview ?? null
  if (patch.loading !== undefined) routePreviewLoading.value = patch.loading
  if (patch.error !== undefined) routePreviewError.value = patch.error
})

async function loadRoutePreview() {
  if (!template.value) return
  // §K2: choices made so far ride along so the preview resolves the chosen names; pre-choice
  // the server previews the requester_choice node honestly (placeholder / unresolved).
  const choices = buildRequesterChoicesPayload()
  await routePreviewController.run({
    templateId: template.value.id,
    formData: { ...formData },
    ...(Object.keys(choices).length > 0 ? { requesterChoices: choices } : {}),
  })
}

watch(formData, () => routePreviewController.invalidate(), { deep: true })

// Detail-row auto-sum (design-lock #3189, Gate B): when the template declares amountConsistencyCheck the
// total field is derived from the detail rows (read-only) — auto-fill (UX) + backend total-check
// (tamper-proof). FE-only. See useAutoSumTotal for the watch + the backend-identical mirror.
const { isAutoSummedTotal } = useAutoSumTotal(template, formData)

// G-B2-16: uppercase caption for the declared amount total. L8-C (§0.4) adds a SECOND, independent
// trigger (`props.uppercaseCny`) without touching this branch's byte-identical existing behavior —
// the auto-summed-total path below is UNCHANGED (same raw `formData` read, same call shape). The
// new per-field-flag branch is additionally gated on `numberFieldScale(field) <= 2`:
// amountInWords.ts's own header records that `amountToChineseWords` always rounds to 2 decimals
// internally and is therefore only an honest caption when the field's declared scale is <= 2 — the
// pre-existing auto-sum trigger stays within that bound by authoring convention (money-total
// presets are 2-decimal), but L8-C's `uppercaseCny` is a free-standing per-field opt-in an author
// could otherwise set on a `precision: 4` field, silently misrepresenting the stored value. Gating
// here (rather than loosening amountToChineseWords's own 2-decimal rounding) keeps that pure
// util's contract unchanged.
function amountWordsFor(field: FormField): string {
  if (isAutoSummedTotal(field.id)) return amountToChineseWords(formData[field.id])
  if (isAmountWordsField(field) && numberFieldScale(field) <= 2) {
    return amountToChineseWords(roundToFieldScale(formData[field.id], numberFieldScale(field)))
  }
  return ''
}

// L8-C: formatted-number display caption (currency prefix / thousands grouping), PRESENTATION ONLY
// — reads the SAME `formData` value the input holds, rounded to the field's declared scale (the
// same scale the total-check and the 大写 caption already respect).
function amountDisplayCaption(field: FormField): string {
  const spec = amountDisplayProps(field)
  return formatAmountDisplay(formData[field.id], spec, numberFieldScale(field))
}

const formRules = computed<FormRules>(() => {
  const rules: FormRules = {}
  for (const field of visibleFields.value) {
    // B2-28: attachment fields render a disabled stopgap block (no working uploader yet — see the
    // template comment above), so a `required` attachment must never make the form unsubmittable;
    // there is no way for the user to satisfy it. Excluded from validation entirely.
    if (field.required && field.type !== 'attachment') {
      if (field.type === 'date_range') {
        // Lock-8 L8-B: `formData[field.id]` is `{ start, end }` — a non-null OBJECT even when both
        // endpoints are blank, so el-form's built-in `required: true` empty-check (string/array/
        // null/undefined only) would silently pass a wholly-unfilled required date_range. A custom
        // validator closes that (the server's `isDateRangeEndpointValid` still catches it either
        // way at submit — this is client-side UX clarity, not the authority).
        rules[field.id] = [
          {
            required: true,
            trigger: ['blur', 'change'],
            validator: (_rule: unknown, _value: unknown, callback: (error?: Error) => void) => {
              if (!dateRangeStart(field.id) || !dateRangeEnd(field.id)) {
                callback(new Error(`请填写${field.label}`))
                return
              }
              callback()
            },
          },
        ]
      } else {
        // B2-15: `blur` alone never reliably fires for a select / date-picker (the user picks via
        // a click in a popper, not a native blur on a text input), so a required select/date left
        // unset could silently pass validation until submit-time. `change` catches those; `blur`
        // stays too so leaving a text/textarea/number field empty validates without a submit click.
        rules[field.id] = [
          { required: true, message: `请填写${field.label}`, trigger: ['blur', 'change'] },
        ]
      }
    }
  }
  return rules
})

/**
 * B2-28: defensive submit-time exclusion of attachment-typed fields. The disabled placeholder never
 * populates `formData` for these ids, but this strips them anyway — belt-and-suspenders so a future
 * edit to the fill view (e.g. reintroducing a real uploader before the B3-07 pipeline lands) can't
 * silently reach the create-approval payload without an explicit decision here. Kept local to this
 * view's submit composition rather than folded into the shared `detailField` prune utils, which are
 * also used by the read-only detail-view snapshot rendering (a different concern: displaying
 * already-submitted data, not gating what a NEW submission may contain).
 */
function stripAttachmentFields(
  formSchema: FormSchema,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const attachmentFieldIds = new Set(
    formSchema.fields.filter((field) => field.type === 'attachment').map((field) => field.id),
  )
  if (attachmentFieldIds.size === 0) return data
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (attachmentFieldIds.has(key)) continue
    result[key] = value
  }
  return result
}

// ---------------------------------------------------------------------------
// FWB-0 Layer 2 record-link fill helpers — value is exactly `{ recordId }`.
// ---------------------------------------------------------------------------
function recordLinkDisplay(fieldId: string): string {
  const parsed = parseRecordLinkValue(formData[fieldId])
  if (!parsed.ok) return ''
  // Human label for THIS field when the picker supplied one; otherwise a generic selected-record
  // label. NEVER fall back to the raw recordId (review: id oracle surface).
  return formatRecordLinkDisplay(recordLinkLabels[fieldId])
}

function clearRecordLink(fieldId: string): void {
  formData[fieldId] = undefined
  // Drop stale display so a later pick (or empty state) does not show a previous label.
  delete recordLinkLabels[fieldId]
}

function openRecordLinkPicker(field: FormField): void {
  // Require both pins before opening — no free-text id fallback when pins are missing.
  if (!recordLinkBaseId(field) || !recordLinkSheetId(field)) return
  recordLinkPickerField.value = field
  recordLinkPickerVisible.value = true
}

const recordLinkPickerBaseId = computed(() => {
  const field = recordLinkPickerField.value
  return field ? recordLinkBaseId(field) : ''
})

const recordLinkPickerSheetId = computed(() => {
  const field = recordLinkPickerField.value
  return field ? recordLinkSheetId(field) : ''
})

const recordLinkPickerCurrentId = computed<string | null>(() => {
  const field = recordLinkPickerField.value
  if (!field) return null
  const parsed = parseRecordLinkValue(formData[field.id])
  return parsed.ok ? parsed.recordId : null
})

function onRecordLinkPicked(payload: { recordId: string; display: string }): void {
  const field = recordLinkPickerField.value
  if (!field) return
  const recordId = payload.recordId?.trim()
  if (!recordId) {
    formData[field.id] = undefined
    delete recordLinkLabels[field.id]
  } else {
    // Strict product shape: only { recordId } — server rejects extra keys / free-text / arrays.
    formData[field.id] = { recordId }
    // Per-field human label only (never raw id; never key by recordId alone).
    const display = typeof payload.display === 'string' ? payload.display.trim() : ''
    if (display && display !== recordId) {
      recordLinkLabels[field.id] = display
    } else {
      // No distinct human label — clear any previous label for this field (generic fallback).
      delete recordLinkLabels[field.id]
    }
  }
  recordLinkPickerVisible.value = false
  recordLinkPickerField.value = null
}

// ---------------------------------------------------------------------------
// Lock-8 L8-B (approval-lock8-field-vocabulary-20260817.md §1.2, OD-L8-8) date_range fill helpers
// — `formData[field.id]` is `{ start, end }`. Duration is DERIVED and DISPLAY-ONLY: computed fresh
// on every read, never stored in `formData`, never submitted, no control offers editing it.
// ---------------------------------------------------------------------------
function dateRangeStart(fieldId: string): string {
  const value = formData[fieldId]
  return value && typeof value === 'object' && typeof (value as { start?: unknown }).start === 'string'
    ? ((value as { start: string }).start)
    : ''
}

function dateRangeEnd(fieldId: string): string {
  const value = formData[fieldId]
  return value && typeof value === 'object' && typeof (value as { end?: unknown }).end === 'string'
    ? ((value as { end: string }).end)
    : ''
}

function setDateRangeStart(fieldId: string, value: string | null): void {
  formData[fieldId] = { start: value ?? '', end: dateRangeEnd(fieldId) }
}

function setDateRangeEnd(fieldId: string, value: string | null): void {
  formData[fieldId] = { start: dateRangeStart(fieldId), end: value ?? '' }
}

function dateRangeDurationDisplay(field: FormField): string {
  const dateType = field.props?.dateType
  const text = computeDateRangeDurationText(dateType, dateRangeStart(field.id), dateRangeEnd(field.id))
  return text ?? '-'
}

function dateRangeDurationLabel(field: FormField): string {
  const label = field.props?.durationLabel
  return typeof label === 'string' && label.trim() ? label.trim() : '时长'
}

// ---------------------------------------------------------------------------
// detail / sub-form (明细) fill helpers — `formData[field.id]` is the row array.
// ---------------------------------------------------------------------------
function detailRows(fieldId: string): Array<Record<string, unknown>> {
  const value = formData[fieldId]
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : []
}

function addDetailRow(field: FormField): void {
  if (!canAddDetailRow(field)) return
  if (!Array.isArray(formData[field.id])) formData[field.id] = []
  ;(formData[field.id] as Array<Record<string, unknown>>).push(createEmptyDetailRow(field.columns))
}

function removeDetailRow(fieldId: string, index: number): void {
  const rows = formData[fieldId]
  if (Array.isArray(rows)) rows.splice(index, 1)
}

function canAddDetailRow(field: FormField): boolean {
  if (typeof field.maxRows !== 'number') return true
  return detailRows(field.id).length < field.maxRows
}

function canRemoveDetailRow(field: FormField): boolean {
  const minRows = typeof field.minRows === 'number' ? field.minRows : 0
  return detailRows(field.id).length > minRows
}

function detailRowsHint(field: FormField): string {
  const parts: string[] = []
  if (typeof field.minRows === 'number') parts.push(`至少 ${field.minRows} 行`)
  if (typeof field.maxRows === 'number') parts.push(`最多 ${field.maxRows} 行`)
  return parts.join(' · ')
}

function isDetailDerivedColumnReadOnly(
  detailField: FormField,
  column: FormField,
  row: Record<string, unknown>,
): boolean {
  return isRowDerivationActive(detailField.columns, column, row)
}

function goBack() {
  router.back()
}

function retryLoad() {
  const templateId = route.params.templateId as string
  templateStore.error = null
  approvalStore.error = null
  templateStore.loadTemplate(templateId)
}

// Submit-time formData composition: prune hidden fields/detail-cells (existing contract), THEN —
// flag OFF only — strip attachment-typed fields (B2-28) so the create-approval payload never
// carries an attachment key while the fill UI can't legitimately populate one. Flag ON (B3-07),
// the attachment value IS the uploaded id array and MUST reach the payload: the server freezes it
// into form_snapshot and binds the rows atomically in the create transaction (§4.4).
function buildSubmitFormData(): Record<string, unknown> {
  if (!template.value) return { ...formData }
  const pruned = pruneHiddenFormDataWithDetail(template.value.formSchema, formData)
  if (attachmentUploadEnabled.value) {
    // Flag ON: an attachment key is submitted ONLY as a non-empty uploaded-id array (§4.4). The
    // form-init default ('' / anything non-array) and a no-uploads field are DROPPED — the server
    // treats an absent key as "no attachments", while a non-array value would fail its validation.
    const result: Record<string, unknown> = { ...pruned }
    for (const field of template.value.formSchema.fields) {
      if (field.type !== 'attachment') continue
      const value = result[field.id]
      if (!Array.isArray(value) || value.length === 0) delete result[field.id]
    }
    return result
  }
  return stripAttachmentFields(template.value.formSchema, pruned)
}

// B2-15 (item 2): on a failed `el-form` validation, the first invalid field can already be
// scrolled past on a long form, leaving no visual cue that IT is why submit did nothing beyond the
// toast. Element Plus marks an invalid `<el-form-item>`'s root with `.is-error`. jsdom does not
// implement `scrollIntoView` at all — optional-chaining the METHOD itself (not just the element)
// is the no-op guard, mirroring `PlmProductPanel.vue`'s existing convention for the same gap.
function scrollFirstErrorIntoView(): void {
  const firstError = document.querySelector<HTMLElement>('.el-form-item.is-error')
  firstError?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
}

async function handleSubmit() {
  if (formRef.value) {
    try {
      await formRef.value.validate()
    } catch {
      ElMessage.warning('请检查表单中的必填项')
      scrollFirstErrorIntoView()
      return
    }
  }

  // B2-15 (item 3): `el-form`'s `rules` only ever cover TOP-LEVEL fields — a `detail` (子表)
  // column's `required` has no client-side check of its own, so a missing required cell would
  // otherwise only surface as an unreadable backend 400. Checked AFTER the top-level validate()
  // above succeeds, so both validation layers must pass before anything is submitted.
  if (template.value) {
    const detailViolations = validateDetailRows(template.value.formSchema, formData)
    if (detailViolations.length > 0) {
      ElMessage.warning(detailViolations[0])
      return
    }
  }

  // Lock-1 §K2: block submit until every requester_choice node carries a mode-satisfying
  // choice — the server would 422 values-free anyway; this surfaces the actionable message.
  const missingChoice = missingRequesterChoiceNode()
  if (missingChoice) {
    ElMessage.warning(`请为「${missingChoice.nodeName}」选择审批人`)
    return
  }

  // raw-id-render fix (2026-08-19): mirrors the 减签 disable+submit-guard posture — a selection
  // that cannot be shown by name must never be submittable, defense in depth alongside the
  // disabled-option UI gate above.
  const unidentifiableChoice = firstUnidentifiableChoiceNode()
  if (unidentifiableChoice) {
    ElMessage.warning(`「${unidentifiableChoice.nodeName}」选择的审批人暂无法确认身份，请重新选择`)
    return
  }

  const templateId = route.params.templateId as string
  try {
    const result = await approvalStore.submitApproval({
      templateId,
      formData: buildSubmitFormData(),
      ...(requesterChoiceNodes.value.length > 0 ? { requesterChoices: buildRequesterChoicesPayload() } : {}),
    })
    ElMessage.success('审批已提交')
    // G-B2-14: a successful submit consumes the draft.
    {
      const key = draftStorageKey()
      if (key) clearFormDraft(window.localStorage, key)
    }
    // B1-08: best-effort 最近使用 record — must never delay or fail the navigation.
    const submittedTemplate = template.value
    if (submittedTemplate) {
      void useAuth()
        .getCurrentUserId()
        .then((uid) =>
          recordRecentTemplate(uid, {
            templateId,
            name: submittedTemplate.name,
            category: submittedTemplate.category,
          }),
        )
        .catch(() => {})
    }
    router.push({ name: 'approval-detail', params: { id: result.id } })
  } catch {
    ElMessage.error('提交审批失败，请重试')
  }
}

// UX B2-13 (再次提交) — `?fromInstance=<id>` (set by `ApprovalDetailView`'s 「再次提交」button)
// carries a REJECTED/REVOKED/CANCELLED source instance to prefill this fresh draft from, so a
// requester fixing a rejected submission doesn't have to retype the whole form. Runs AFTER the
// defaultValue seeding in `onMounted` below so a prefilled value always wins over a field's own
// `defaultValue`. `prefillFromSnapshot`'s drift guard (dropped/retyped fields, no attachments) is
// the ONLY gate — no crash / bad value regardless of how much the template changed since the
// source was submitted. Best-effort: a failed source-instance fetch never blocks filling the form
// fresh — it just silently skips the prefill.
async function applyResubmitPrefill(): Promise<void> {
  if (!template.value) return
  const fromInstance = route.query.fromInstance
  const sourceId = typeof fromInstance === 'string' ? fromInstance : null
  if (!sourceId) return
  prefillLoading.value = true
  try {
    const source = await getApproval(sourceId)
    const prefilled = prefillFromSnapshot(template.value.formSchema, source.formSnapshot)
    if (Object.keys(prefilled).length === 0) return
    Object.assign(formData, prefilled)
    prefillNoticeVisible.value = true
  } catch {
    // best-effort — the fresh form still works fully unprefilled.
  } finally {
    prefillLoading.value = false
  }
}

onMounted(async () => {
  const templateId = route.params.templateId as string
  await templateStore.loadTemplate(templateId)
  // Initialize form with default values
  if (template.value) {
    for (const field of template.value.formSchema.fields) {
      if (field.defaultValue !== undefined) {
        formData[field.id] = field.defaultValue
      } else if (field.type === 'multi-select' || field.type === 'detail') {
        // detail value is an array of row objects; seed empty so the fill table binds an array.
        formData[field.id] = []
      } else if (field.type === 'date_range') {
        // Lock-8 L8-B: value is `{ start, end }` — seed BOTH keys present (empty strings) so the
        // two pickers and the derived-duration display always have a well-defined shape to bind
        // against, rather than reading off `undefined`.
        formData[field.id] = { start: '', end: '' }
      } else {
        formData[field.id] = undefined
      }
    }
  }
  await applyResubmitPrefill()
  // G-B2-14: arm the draft machinery once user id resolves; the restore offer only appears when
  // NO resubmit prefill claimed the form (prefill wins — it is an explicit user intent).
  try {
    draftUserId.value = await useAuth().getCurrentUserId()
  } catch {
    draftUserId.value = null // drafting silently unavailable without an identity
  }
  if (!prefillNoticeVisible.value) offerDraftRestore()
  draftArmed = true
})

function syncVisibleFormState() {
  if (!template.value) return
  const visibleFieldIdSet = new Set(visibleFieldIds.value)
  for (const key of Object.keys(formData)) {
    if (!visibleFieldIdSet.has(key)) {
      delete formData[key]
    }
  }
  for (const field of visibleFields.value) {
    if (formData[field.id] === undefined) {
      if (field.defaultValue !== undefined) {
        formData[field.id] = field.defaultValue
      } else if (field.type === 'multi-select' || field.type === 'detail') {
        formData[field.id] = []
      } else if (field.type === 'date_range') {
        formData[field.id] = { start: '', end: '' }
      }
    }
  }
}

watch([visibleFieldIds, template], () => {
  syncVisibleFormState()
}, { immediate: true })
</script>

<style scoped>
.approval-new__error {
  margin-bottom: 16px;
}

.approval-new__content-wrapper {
  min-height: 200px;
}

.approval-new__info-card {
  margin-bottom: 8px;
}

/* UX B2-13: 再次提交 prefill notice — same weight as the top-level error alert, but info-toned. */
.approval-new__prefill-notice {
  margin-bottom: 8px;
}

.approval-new__info-header {
  display: flex;
  align-items: center;
  gap: 12px;
}

.approval-new__info-header h2 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

.approval-new__info-desc {
  color: var(--el-text-color-regular);
  margin: 0;
  font-size: 14px;
}

.approval-new__info-desc--empty {
  color: var(--el-text-color-placeholder);
  font-style: italic;
}

/* UX B2-07: submit-time flow preview — a muted, horizontal step/chip row (发起人 → node → node …),
   deliberately NOT the authoring canvas's node-graph styling — this is a compact glance, not an
   editing surface. */
.approval-new__flow-preview {
  margin-bottom: 8px;
}

/* Lock-1 §K2: submit-time approver chooser card. */
.approval-new__requester-choice {
  margin-bottom: 8px;
}

.approval-new__flow-preview-header {
  font-size: 14px;
  font-weight: 600;
}

.approval-new__flow-preview-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.approval-new__flow-preview-chip {
  display: inline-flex;
  flex-direction: column;
  padding: 4px 10px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-regular);
  font-size: 12px;
  line-height: 1.4;
}

.approval-new__flow-preview-chip--requester {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-weight: 500;
}

.approval-new__flow-preview-chip--conditional {
  border: 1px dashed var(--el-color-warning);
}

.approval-new__flow-preview-chip-summary {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

.approval-new__flow-preview-arrow {
  color: var(--el-text-color-placeholder);
  font-size: 12px;
}

.approval-new__route-preview {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--el-border-color-lighter);
}

.approval-new__route-preview .approval-new__flow-preview-row {
  margin-top: 8px;
}

.approval-new__flow-preview-chip--unresolved {
  border: 1px dashed var(--el-color-danger);
}

.approval-new__route-preview-error {
  margin-top: 8px;
  font-size: 12px;
  color: var(--el-color-danger);
}

.approval-new__route-preview-truncated {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.approval-new__field-hint {
  display: block;
  font-size: 12px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
  margin-top: 2px;
}

.approval-new__amount-words {
  margin-top: var(--ms-space-1);
  font-size: 12px;
  color: var(--ms-text-3);
}

.approval-new__amount-display {
  margin-top: var(--ms-space-1);
  font-size: 12px;
  color: var(--ms-text-3);
}

.approval-new__date-range-row {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2, 8px);
  width: 100%;
}

.approval-new__date-range-row .el-date-editor {
  flex: 1;
}

.approval-new__date-range-sep {
  flex: none;
  color: var(--el-text-color-secondary);
}

.approval-new__date-range-duration {
  margin-top: var(--ms-space-1);
  font-size: 12px;
  color: var(--ms-text-3);
  display: flex;
  gap: var(--ms-space-1, 4px);
}

.approval-new__date-range-duration-label::after {
  content: '：';
}

.approval-new__explanation {
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--ms-bg-subtle, var(--el-fill-color-light));
  color: var(--ms-text-2, var(--el-text-color-regular));
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.approval-new__form {
  background: var(--ms-bg-card);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 24px;
}

.approval-new__attachment-disabled {
  width: 100%;
  box-sizing: border-box;
  padding: 12px 16px;
  border: 1px dashed var(--el-border-color);
  border-radius: 6px;
  background: var(--el-fill-color-lighter);
  color: var(--el-text-color-secondary);
  font-size: 13px;
  line-height: 1.6;
}

/* B3-07 flag-ON uploader (replaces the disabled block above when approvalAttachments is enabled) */
.approval-new__attachment-upload {
  width: 100%;
  box-sizing: border-box;
  padding: 12px 16px;
  border: 1px dashed var(--el-border-color);
  border-radius: 6px;
  background: var(--el-fill-color-lighter);
  font-size: 13px;
  line-height: 1.6;
}

.approval-new__attachment-list {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}

.approval-new__attachment-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 0;
}

.approval-new__submit {
  margin-top: 8px;
  margin-bottom: 0;
}

.approval-new__detail {
  width: 100%;
}

.approval-new__detail-table {
  width: 100%;
}

.approval-new__detail-required {
  color: var(--el-color-danger);
  margin-left: 2px;
}

.approval-new__detail-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}

.approval-new__detail-hint,
.approval-new__detail-empty {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
