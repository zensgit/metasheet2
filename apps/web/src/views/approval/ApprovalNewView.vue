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

            <!-- FWB-2 record-link: single-record picker scoped to server-pinned sheet (no raw record id). -->
            <div
              v-if="field.type === 'record-link'"
              class="approval-new__record-link"
              data-testid="approval-record-link-field"
              :data-field-id="field.id"
            >
              <div class="approval-new__record-link-row">
                <el-input
                  :model-value="recordLinkDisplay(field.id)"
                  readonly
                  :placeholder="field.placeholder || `请选择${field.label}`"
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
              <div class="approval-new__field-hint">
                仅可选择模板钉死 sheet 内的一条记录；提交时服务端按读权限校验。
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
            <!-- G-B2-16: 大写回显 — ONLY under the template-declared amount total (no label
                 guessing); derived from the same value the backend total-check sees. -->
            <div
              v-if="field.type === 'number' && isAutoSummedTotal(field.id) && amountWordsFor(field.id)"
              class="approval-new__amount-words"
              data-testid="approval-amount-words"
            >
              大写：{{ amountWordsFor(field.id) }}
            </div>

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

            <!-- attachment: B2-28 honest-disable STOPGAP until the real upload pipeline lands (audit
                 follow-up B3-07). The previous el-upload (action="#" + auto-upload=false) was fully
                 interactive but never actually uploaded anything: the raw File a user dropped landed in
                 formData, and JSON.stringify-ing that for the request body silently turned it into `{}`
                 — a success toast over quietly-dropped data. An honest disabled placeholder beats a fake
                 uploader. The field label + required marker (rendered by the surrounding el-form-item)
                 stay visible; `formRules` (below) excludes attachment fields so a `required` attachment
                 can never block submission — there being no working way to satisfy it yet. handleSubmit
                 additionally strips attachment-typed keys defensively (see stripAttachmentFields). -->
            <div
              v-else-if="field.type === 'attachment'"
              class="approval-new__attachment-disabled"
              data-testid="approval-attachment-disabled"
            >
              附件上传功能即将支持，请先在其他字段中注明附件信息。
            </div>

            <!-- fallback -->
            <el-input
              v-else
              v-model="formData[field.id]"
              :placeholder="field.placeholder || `请输入${field.label}`"
            />

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

    <!-- FWB-2: single-record picker scoped to the field's server-pinned sheet. -->
    <MetaLinkPicker
      v-if="recordLinkPickerField"
      :visible="recordLinkPickerVisible"
      :field="recordLinkPickerMetaField"
      :current-value="recordLinkPickerCurrentIds"
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
import type { FormField, FormSchema } from '../../types/approval'
import { useApprovalStore } from '../../approvals/store'
import { useApprovalTemplateStore } from '../../approvals/templateStore'
import { useApprovalPermissions } from '../../approvals/permissions'
import { getVisibleFormFields } from '../../approvals/fieldVisibility'
import { recordRecentTemplate } from '../../approvals/recentTemplates'
import { useAuth } from '../../composables/useAuth'
import { useAutoSumTotal } from '../../approvals/useAutoSumTotal'
import { isRowDerivationActive } from '../../approvals/lineDerivation'
import { numberFieldProps } from '../../approvals/numberFieldProps'
import { amountToChineseWords } from '../../approvals/amountInWords'
import { clearFormDraft, formDraftKey, formSchemaSignature, loadFormDraft, saveFormDraft } from '../../approvals/formDraft'
import ApprovalUserPicker from '../../approvals/components/ApprovalUserPicker.vue'
import {
  createEmptyDetailRow,
  isDetailCellVisible,
  pruneHiddenFormDataWithDetail,
  validateDetailRows,
} from '../../approvals/detailField'
import { summarizeApprovalFlow, type ApprovalFlowStep } from '../../approvals/graphSummary'
import { previewApprovalRoute, type ApprovalRoutePreview } from '../../approvals/api'
import { routePreviewAssigneeSummary } from '../../approvals/routePreviewSummary'
import { createRoutePreviewController } from '../../approvals/routePreviewController'
import { getApproval } from '../../approvals/api'
import { prefillFromSnapshot } from '../../approvals/prefillFromSnapshot'
import MetaLinkPicker from '../../multitable/components/MetaLinkPicker.vue'
import type { MetaField } from '../../multitable/types'

const route = useRoute()
const router = useRouter()
const approvalStore = useApprovalStore()
const templateStore = useApprovalTemplateStore()
const { canWrite } = useApprovalPermissions()

const formRef = ref<FormInstance>()
const formData = reactive<Record<string, unknown>>({})
// FWB-2 record-link picker state (single-record; value shape { recordId }).
const recordLinkPickerVisible = ref(false)
const recordLinkPickerField = ref<FormField | null>(null)
const recordLinkLabels = reactive<Record<string, string>>({})
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

function applyDraftRestore(): void {
  if (pendingDraft.value) Object.assign(formData, pendingDraft.value)
  pendingDraft.value = null
  draftRestoreVisible.value = false
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
    // Same attachment-stripping the submit path uses — refs never persist.
    const data = stripAttachmentFields(template.value.formSchema, { ...formData })
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
  await routePreviewController.run({ templateId: template.value.id, formData: { ...formData } })
}

watch(formData, () => routePreviewController.invalidate(), { deep: true })

// Detail-row auto-sum (design-lock #3189, Gate B): when the template declares amountConsistencyCheck the
// total field is derived from the detail rows (read-only) — auto-fill (UX) + backend total-check
// (tamper-proof). FE-only. See useAutoSumTotal for the watch + the backend-identical mirror.
const { isAutoSummedTotal } = useAutoSumTotal(template, formData)

// G-B2-16: uppercase caption for the declared amount total.
function amountWordsFor(fieldId: string): string {
  return amountToChineseWords(formData[fieldId])
}

const formRules = computed<FormRules>(() => {
  const rules: FormRules = {}
  for (const field of visibleFields.value) {
    // B2-28: attachment fields render a disabled stopgap block (no working uploader yet — see the
    // template comment above), so a `required` attachment must never make the form unsubmittable;
    // there is no way for the user to satisfy it. Excluded from validation entirely.
    if (field.required && field.type !== 'attachment') {
      rules[field.id] = [
        // B2-15: `blur` alone never reliably fires for a select / date-picker (the user picks via
        // a click in a popper, not a native blur on a text input), so a required select/date left
        // unset could silently pass validation until submit-time. `change` catches those; `blur`
        // stays too so leaving a text/textarea/number field empty validates without a submit click.
        { required: true, message: `请填写${field.label}`, trigger: ['blur', 'change'] },
      ]
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

// Submit-time formData composition: prune hidden fields/detail-cells (existing contract), THEN
// strip attachment-typed fields (B2-28 — see stripAttachmentFields) so the create-approval payload
// never carries an attachment key while the fill UI can't legitimately populate one.
function buildSubmitFormData(): Record<string, unknown> {
  if (!template.value) return { ...formData }
  const pruned = pruneHiddenFormDataWithDetail(template.value.formSchema, formData)
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

  const templateId = route.params.templateId as string
  try {
    const result = await approvalStore.submitApproval({
      templateId,
      formData: buildSubmitFormData(),
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

function recordLinkDisplay(fieldId: string): string {
  const raw = formData[fieldId]
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as { recordId?: unknown }).recordId === 'string') {
    const id = String((raw as { recordId: string }).recordId)
    return recordLinkLabels[id] || id
  }
  return ''
}

function clearRecordLink(fieldId: string): void {
  formData[fieldId] = undefined
}

function openRecordLinkPicker(field: FormField): void {
  recordLinkPickerField.value = field
  recordLinkPickerVisible.value = true
}

/** Shape MetaLinkPicker expects: a link-like meta field with foreignSheetId from server-pinned props. */
const recordLinkPickerMetaField = computed<MetaField | null>(() => {
  const field = recordLinkPickerField.value
  if (!field || field.type !== 'record-link') return null
  const props = field.props && typeof field.props === 'object' ? field.props : {}
  const sheetId = typeof props.sheetId === 'string' ? props.sheetId.trim() : ''
  if (!sheetId) return null
  return {
    id: field.id,
    name: field.label,
    type: 'link',
    property: {
      foreignSheetId: sheetId,
      limitSingleRecord: true,
    },
  } as MetaField
})

const recordLinkPickerCurrentIds = computed<string[]>(() => {
  const field = recordLinkPickerField.value
  if (!field) return []
  const raw = formData[field.id]
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as { recordId?: unknown }).recordId === 'string') {
    return [String((raw as { recordId: string }).recordId)]
  }
  return []
})

function onRecordLinkPicked(payload: { recordIds: string[]; summaries: Array<{ id: string; display?: string }> }): void {
  const field = recordLinkPickerField.value
  if (!field) return
  const recordId = payload.recordIds[0]
  if (!recordId) {
    formData[field.id] = undefined
  } else {
    // Strict product shape: only { recordId } — server rejects extra keys.
    formData[field.id] = { recordId }
    const summary = payload.summaries.find((s) => s.id === recordId)
    if (summary?.display) recordLinkLabels[recordId] = summary.display
  }
  recordLinkPickerVisible.value = false
  recordLinkPickerField.value = null
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
