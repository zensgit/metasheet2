<template>
  <section class="approval-new">
    <header class="approval-new__header">
      <el-button text @click="goBack">
        <el-icon><ArrowLeft /></el-icon>
        返回
      </el-button>
      <h1>发起审批</h1>
    </header>

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

    <div v-loading="templateStore.loading || approvalStore.loading" class="approval-new__content-wrapper">
      <div v-if="template" class="approval-new__body">
        <!-- Template info card -->
        <el-card class="approval-new__info-card" shadow="never">
          <template #header>
            <div class="approval-new__info-header">
              <h2>{{ template.name }}</h2>
              <el-tag :type="template.status === 'published' ? 'success' : 'info'" size="small">
                {{ template.status === 'published' ? '已发布' : template.status }}
              </el-tag>
            </div>
          </template>
          <p v-if="template.description" class="approval-new__info-desc">{{ template.description }}</p>
          <p v-else class="approval-new__info-desc approval-new__info-desc--empty">暂无描述</p>
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
  </section>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { ArrowLeft } from '@element-plus/icons-vue'
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
} from '../../approvals/detailField'

const route = useRoute()
const router = useRouter()
const approvalStore = useApprovalStore()
const templateStore = useApprovalTemplateStore()
const { canWrite } = useApprovalPermissions()

const formRef = ref<FormInstance>()
const formData = reactive<Record<string, unknown>>({})
const template = computed(() => templateStore.activeTemplate)
const visibleFields = computed(() => {
  if (!template.value) return []
  return getVisibleFormFields(template.value.formSchema, formData)
})
const visibleFieldIds = computed(() => visibleFields.value.map((field) => field.id))

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
        { required: true, message: `请填写${field.label}`, trigger: 'blur' },
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

async function handleSubmit() {
  if (formRef.value) {
    try {
      await formRef.value.validate()
    } catch {
      ElMessage.warning('请检查表单中的必填项')
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
.approval-new {
  max-width: 800px;
  margin: 0 auto;
  padding: 24px;
}

.approval-new__header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
}

.approval-new__header h1 {
  font-size: 20px;
  font-weight: 600;
  margin: 0;
}

.approval-new__error {
  margin-bottom: 16px;
}

.approval-new__content-wrapper {
  min-height: 200px;
}

.approval-new__info-card {
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
  color: var(--el-text-color-regular, #606266);
  margin: 0;
  font-size: 14px;
}

.approval-new__info-desc--empty {
  color: var(--el-text-color-placeholder, #c0c4cc);
  font-style: italic;
}

.approval-new__field-hint {
  display: block;
  font-size: 12px;
  font-weight: 400;
  color: var(--el-text-color-secondary, #909399);
  margin-top: 2px;
}

.approval-new__form {
  background: #fff;
  border: 1px solid var(--el-border-color-lighter, #e4e7ed);
  border-radius: 8px;
  padding: 24px;
}

.approval-new__attachment-disabled {
  width: 100%;
  box-sizing: border-box;
  padding: 12px 16px;
  border: 1px dashed var(--el-border-color, #dcdfe6);
  border-radius: 6px;
  background: var(--el-fill-color-lighter, #f5f7fa);
  color: var(--el-text-color-secondary, #909399);
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
  color: var(--el-color-danger, #f56c6c);
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
  color: var(--el-text-color-secondary, #909399);
}
</style>
