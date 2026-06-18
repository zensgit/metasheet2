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
            <strong>审批步骤</strong>
            <el-button
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

        <div
          v-for="(step, index) in draft.steps"
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
                <el-option label="表单用户字段" value="form_field_user" />
              </el-select>
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
  getTemplate,
  publishTemplate,
  updateTemplate,
} from '../../approvals/api'
import {
  buildApprovalGraph,
  buildCreateTemplatePayload,
  buildFormSchema,
  buildUpdateTemplatePayload,
  createEmptyFieldDraft,
  createEmptyStepDraft,
  createEmptyTemplateDraft,
  draftFromTemplate,
  parseIdsText,
  unsupportedTemplateAuthoringReason,
  validateTemplateDraft,
  type ApprovalStepDraft,
  type FieldAuthoringDraft,
  type TemplateAuthoringDraft,
} from '../../approvals/templateAuthoring'
import { useApprovalDirectory } from '../../approvals/useApprovalDirectory'

const route = useRoute()
const router = useRouter()
const { canManageTemplates } = useApprovalPermissions()

const loading = ref(false)
const saving = ref(false)
const publishing = ref(false)
const loadError = ref<string | null>(null)
const validationErrors = ref<string[]>([])
const unsupportedReason = ref<string | null>(null)
const draft = ref<TemplateAuthoringDraft>(createEmptyTemplateDraft())

const templateId = computed(() => typeof route.params.id === 'string' ? route.params.id : '')
const isEditMode = computed(() => templateId.value.length > 0)
const readOnly = computed(() => !canManageTemplates.value || Boolean(unsupportedReason.value))
const canSave = computed(() => canManageTemplates.value && !unsupportedReason.value && !loading.value)
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
    return
  }
  loading.value = true
  loadError.value = null
  try {
    const template = await getTemplate(templateId.value)
    unsupportedReason.value = unsupportedTemplateAuthoringReason(template)
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
      return updated
    }
    const created = await createTemplate(buildCreateTemplatePayload(draft.value))
    draft.value = draftFromTemplate(created)
    unsupportedReason.value = unsupportedTemplateAuthoringReason(created)
    await router.replace({ path: `/approval-templates/${created.id}/edit` })
    return created
  } catch (error: any) {
    loadError.value = error?.message ?? '保存模板失败'
    return null
  } finally {
    saving.value = false
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
}
</style>
