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
              <StatusTag domain="approvalTemplate" :status="template.status" size="sm" />
            </div>
          </template>
          <p v-if="template.description" class="approval-new__info-desc">{{ template.description }}</p>
          <p v-else class="approval-new__info-desc approval-new__info-desc--empty">暂无描述</p>
        </el-card>

        <!-- UX B2-13 (再次提交): shown only once a `?fromInstance=` prefill actually applied at
             least one field (see `applyResubmitPrefill`) — a requester fixing a rejected/revoked/
             cancelled submission should know the form was pre-populated, not silently discover it. -->
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

            <!-- text -->
            <el-input
              v-if="field.type === 'text'"
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
              style="width: 100%"
            />

            <!-- date -->
            <el-date-picker
              v-else-if="field.type === 'date'"
              v-model="formData[field.id]"
              type="date"
              :placeholder="field.placeholder || `请选择${field.label}`"
              style="width: 100%"
            />

            <!-- datetime -->
            <el-date-picker
              v-else-if="field.type === 'datetime'"
              v-model="formData[field.id]"
              type="datetime"
              :placeholder="field.placeholder || `请选择${field.label}`"
              style="width: 100%"
            />

            <!-- select -->
            <el-select
              v-else-if="field.type === 'select'"
              v-model="formData[field.id]"
              :placeholder="field.placeholder || `请选择${field.label}`"
              style="width: 100%"
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
              style="width: 100%"
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
                      style="width: 100%"
                    />
                    <el-date-picker
                      v-else-if="column.type === 'date'"
                      v-model="row[column.id]"
                      type="date"
                      :placeholder="column.label"
                      style="width: 100%"
                    />
                    <el-date-picker
                      v-else-if="column.type === 'datetime'"
                      v-model="row[column.id]"
                      type="datetime"
                      :placeholder="column.label"
                      style="width: 100%"
                    />
                    <el-select
                      v-else-if="column.type === 'select'"
                      v-model="row[column.id]"
                      :placeholder="column.label"
                      style="width: 100%"
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
                      style="width: 100%"
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
import ApprovalUserPicker from '../../approvals/components/ApprovalUserPicker.vue'
import {
  createEmptyDetailRow,
  isDetailCellVisible,
  pruneHiddenFormDataWithDetail,
  validateDetailRows,
} from '../../approvals/detailField'
import { summarizeApprovalFlow, type ApprovalFlowStep } from '../../approvals/graphSummary'
import { getApproval } from '../../approvals/api'
import { prefillFromSnapshot } from '../../approvals/prefillFromSnapshot'

const route = useRoute()
const router = useRouter()
const approvalStore = useApprovalStore()
const templateStore = useApprovalTemplateStore()
const { canWrite } = useApprovalPermissions()

const formRef = ref<FormInstance>()
const formData = reactive<Record<string, unknown>>({})
// UX B2-13 (再次提交): true once a `?fromInstance=` prefill actually applied at least one field —
// see `applyResubmitPrefill` below. Drives the "已从上一次申请预填" notice.
const prefillNoticeVisible = ref(false)
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
  return summarizeApprovalFlow(graph)
})

// Detail-row auto-sum (design-lock #3189, Gate B): when the template declares amountConsistencyCheck the
// total field is derived from the detail rows (read-only) — auto-fill (UX) + backend total-check
// (tamper-proof). FE-only. See useAutoSumTotal for the watch + the backend-identical mirror.
const { isAutoSummedTotal } = useAutoSumTotal(template, formData)

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
      } else {
        formData[field.id] = undefined
      }
    }
  }
  await applyResubmitPrefill()
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

.approval-new__field-hint {
  display: block;
  font-size: 12px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
  margin-top: 2px;
}

.approval-new__form {
  background: #fff;
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
