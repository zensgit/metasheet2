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

            <!-- user (placeholder picker) -->
            <el-select
              v-else-if="field.type === 'user'"
              v-model="formData[field.id]"
              placeholder="选择用户"
              filterable
              style="width: 100%"
            >
              <template #prefix>
                <el-icon><Search /></el-icon>
              </template>
              <el-option label="张三" value="user_1" />
              <el-option label="李四" value="user_2" />
              <el-option label="王五" value="user_3" />
            </el-select>

            <!-- attachment (drag upload) -->
            <el-upload
              v-else-if="field.type === 'attachment'"
              action="#"
              :auto-upload="false"
              drag
              :on-change="(file: any) => handleFileChange(field.id, file)"
            >
              <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
              <div class="el-upload__text">将文件拖到此处，或<em>点击上传</em></div>
              <template #tip>
                <div class="el-upload__tip">支持常见文件格式，单个文件不超过 10MB</div>
              </template>
            </el-upload>

            <!-- fallback -->
            <el-input
              v-else
              v-model="formData[field.id]"
              :placeholder="field.placeholder || `请输入${field.label}`"
            />
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
import { ArrowLeft, Search, UploadFilled } from '@element-plus/icons-vue'
import { useApprovalStore } from '../../approvals/store'
import { useApprovalTemplateStore } from '../../approvals/templateStore'
import { useApprovalPermissions } from '../../approvals/permissions'
import {
  getVisibleFormFields,
  pruneHiddenFormData,
} from '../../approvals/fieldVisibility'

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

const formRules = computed<FormRules>(() => {
  const rules: FormRules = {}
  for (const field of visibleFields.value) {
    if (field.required) {
      rules[field.id] = [
        { required: true, message: `请填写${field.label}`, trigger: 'blur' },
      ]
    }
  }
  return rules
})

function handleFileChange(fieldId: string, file: any) {
  formData[fieldId] = file?.raw ?? null
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
      formData: template.value ? pruneHiddenFormData(template.value.formSchema, formData) : { ...formData },
    })
    ElMessage.success('审批已提交')
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
      } else if (field.type === 'multi-select') {
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
      } else if (field.type === 'multi-select') {
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

.approval-new__submit {
  margin-top: 8px;
  margin-bottom: 0;
}
</style>
