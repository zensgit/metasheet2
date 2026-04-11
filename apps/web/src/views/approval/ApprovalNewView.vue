<template>
  <section class="approval-new" v-loading="templateStore.loading || approvalStore.loading">
    <header class="approval-new__header">
      <el-button text @click="goBack">← 返回</el-button>
      <h1>发起审批</h1>
    </header>

    <div v-if="templateStore.error || approvalStore.error" class="approval-new__error">
      <el-alert
        :title="templateStore.error || approvalStore.error || ''"
        type="error"
        show-icon
        :closable="false"
      />
    </div>

    <div v-if="template" class="approval-new__body">
      <div class="approval-new__info">
        <h2>{{ template.name }}</h2>
        <p v-if="template.description">{{ template.description }}</p>
      </div>

      <el-form
        ref="formRef"
        :model="formData"
        :rules="formRules"
        label-position="top"
        class="approval-new__form"
      >
        <el-form-item
          v-for="field in template.formSchema.fields"
          :key="field.id"
          :label="field.label"
          :prop="field.id"
          :required="field.required"
        >
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
            :placeholder="field.placeholder || `请选择${field.label}`"
            filterable
            style="width: 100%"
          >
            <el-option label="张三" value="user_1" />
            <el-option label="李四" value="user_2" />
            <el-option label="王五" value="user_3" />
          </el-select>

          <!-- attachment (placeholder upload) -->
          <el-upload
            v-else-if="field.type === 'attachment'"
            action="#"
            :auto-upload="false"
            :on-change="(file: any) => handleFileChange(field.id, file)"
          >
            <el-button type="primary" plain>点击上传</el-button>
            <template #tip>
              <div class="el-upload__tip">支持常见文件格式</div>
            </template>
          </el-upload>

          <!-- fallback -->
          <el-input
            v-else
            v-model="formData[field.id]"
            :placeholder="field.placeholder || `请输入${field.label}`"
          />
        </el-form-item>

        <el-form-item class="approval-new__submit">
          <el-button type="primary" :loading="approvalStore.loading" @click="handleSubmit">
            提交审批
          </el-button>
          <el-button @click="goBack">取消</el-button>
        </el-form-item>
      </el-form>
    </div>

    <el-empty v-else-if="!templateStore.loading" description="未找到审批模板" />
  </section>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { FormInstance, FormRules } from 'element-plus'
import { useApprovalStore } from '../../approvals/store'
import { useApprovalTemplateStore } from '../../approvals/templateStore'

const route = useRoute()
const router = useRouter()
const approvalStore = useApprovalStore()
const templateStore = useApprovalTemplateStore()

const formRef = ref<FormInstance>()
const formData = reactive<Record<string, unknown>>({})
const template = computed(() => templateStore.activeTemplate)

const formRules = computed<FormRules>(() => {
  const rules: FormRules = {}
  if (!template.value) return rules
  for (const field of template.value.formSchema.fields) {
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

async function handleSubmit() {
  if (formRef.value) {
    try {
      await formRef.value.validate()
    } catch {
      return
    }
  }

  const templateId = route.params.templateId as string
  const result = await approvalStore.submitApproval({
    templateId,
    formData: { ...formData },
  })
  router.push({ name: 'approval-detail', params: { id: result.id } })
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

.approval-new__info {
  margin-bottom: 20px;
}

.approval-new__info h2 {
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 8px;
}

.approval-new__info p {
  color: var(--el-text-color-secondary, #909399);
  margin: 0;
}

.approval-new__form {
  background: #fff;
  border: 1px solid var(--el-border-color-lighter, #e4e7ed);
  border-radius: 8px;
  padding: 24px;
}

.approval-new__submit {
  margin-top: 24px;
  margin-bottom: 0;
}
</style>
