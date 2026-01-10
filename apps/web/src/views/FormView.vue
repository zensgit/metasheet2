<template>
  <div class="form-container" :class="{ 'public-form': isPublicAccess }">
    <!-- Form Header -->
    <div class="form-header">
      <div v-if="!isPublicAccess" class="header-controls">
        <button @click="togglePreview" class="preview-btn" :class="{ active: isPreview }">
          {{ isPreview ? '编辑模式' : '预览模式' }}
        </button>
        <button @click="showConfigModal = true" class="config-btn">
          ⚙️ 配置
        </button>
        <button @click="showResponsesModal = true" class="responses-btn">
          📊 查看回复 ({{ totalResponses }})
        </button>
      </div>
    </div>

    <!-- Loading State -->
    <div v-if="loading" class="loading-state">
      <div class="loading-spinner"></div>
      <p>加载表单中...</p>
    </div>

    <!-- Error State -->
    <div v-else-if="error" class="error-state">
      <p class="error-message">{{ error }}</p>
      <button @click="loadForm" class="retry-btn">重试</button>
    </div>

    <!-- Form Content -->
    <div v-else-if="config" class="form-content" :class="[`theme-${config.styling.theme}`, `layout-${config.styling.layout}`]">
      <!-- Form Title and Description -->
      <div class="form-intro">
        <h1 class="form-title">{{ config.settings.title }}</h1>
        <p v-if="config.settings.description" class="form-description">
          {{ config.settings.description }}
        </p>
        <div v-if="config.settings.requireAuth && !isAuthenticated" class="auth-notice">
          此表单需要登录后填写
        </div>
      </div>

      <!-- Success Message -->
      <div v-if="submitSuccess" class="success-message">
        <div class="success-icon">✅</div>
        <h3>提交成功！</h3>
        <p>{{ config.settings.successMessage || '您的回复已成功提交。' }}</p>
        <button v-if="config.settings.allowMultiple" @click="resetForm" class="submit-another-btn">
          再次提交
        </button>
      </div>

      <!-- Form Fields -->
      <form v-else @submit.prevent="submitForm" class="form-fields">
        <div
          v-for="field in sortedFields"
          :key="field.id"
          class="field-wrapper"
          :class="[
            `field-${field.type}`,
            `width-${field.width || 'full'}`,
            { hidden: !isFieldVisible(field) }
          ]"
        >
          <label
            v-if="field.label"
            class="field-label"
            :class="{ required: field.required }"
            :for="`form-field-${field.name}`"
          >
            {{ field.label }}
            <span v-if="field.description" class="field-description">{{ field.description }}</span>
          </label>

          <!-- Text Input -->
          <input
            v-if="field.type === 'text'"
            :id="`form-field-${field.name}`"
            :name="field.name"
            v-model="formData[field.name]"
            type="text"
            :placeholder="field.placeholder"
            :required="field.required"
            :disabled="submitting"
            class="field-input"
          />

          <!-- Textarea -->
          <textarea
            v-else-if="field.type === 'textarea'"
            :id="`form-field-${field.name}`"
            :name="field.name"
            v-model="formData[field.name]"
            :placeholder="field.placeholder"
            :required="field.required"
            :disabled="submitting"
            class="field-textarea"
            rows="4"
          ></textarea>

          <!-- Number Input -->
          <input
            v-else-if="field.type === 'number'"
            :id="`form-field-${field.name}`"
            :name="field.name"
            v-model.number="formData[field.name]"
            type="number"
            :placeholder="field.placeholder"
            :required="field.required"
            :disabled="submitting"
            :min="field.validation?.min"
            :max="field.validation?.max"
            class="field-input"
          />

          <!-- Email Input -->
          <input
            v-else-if="field.type === 'email'"
            :id="`form-field-${field.name}`"
            :name="field.name"
            v-model="formData[field.name]"
            type="email"
            :placeholder="field.placeholder"
            :required="field.required"
            :disabled="submitting"
            class="field-input"
          />

          <!-- URL Input -->
          <input
            v-else-if="field.type === 'url'"
            :id="`form-field-${field.name}`"
            :name="field.name"
            v-model="formData[field.name]"
            type="url"
            :placeholder="field.placeholder"
            :required="field.required"
            :disabled="submitting"
            class="field-input"
          />

          <!-- Phone Input -->
          <input
            v-else-if="field.type === 'phone'"
            :id="`form-field-${field.name}`"
            :name="field.name"
            v-model="formData[field.name]"
            type="tel"
            :placeholder="field.placeholder"
            :required="field.required"
            :disabled="submitting"
            class="field-input"
          />

          <!-- Date Input -->
          <input
            v-else-if="field.type === 'date'"
            :id="`form-field-${field.name}`"
            :name="field.name"
            v-model="formData[field.name]"
            type="date"
            :required="field.required"
            :disabled="submitting"
            class="field-input"
          />

          <!-- DateTime Input -->
          <input
            v-else-if="field.type === 'datetime'"
            :id="`form-field-${field.name}`"
            :name="field.name"
            v-model="formData[field.name]"
            type="datetime-local"
            :required="field.required"
            :disabled="submitting"
            class="field-input"
          />

          <!-- Time Input -->
          <input
            v-else-if="field.type === 'time'"
            :id="`form-field-${field.name}`"
            :name="field.name"
            v-model="formData[field.name]"
            type="time"
            :required="field.required"
            :disabled="submitting"
            class="field-input"
          />

          <!-- Select -->
          <select
            v-else-if="field.type === 'select'"
            :id="`form-field-${field.name}`"
            :name="field.name"
            v-model="formData[field.name]"
            :required="field.required"
            :disabled="submitting"
            class="field-select"
          >
            <option value="">{{ field.placeholder || '请选择...' }}</option>
            <option
              v-for="option in field.options"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>

          <!-- Multi-Select -->
          <div v-else-if="field.type === 'multiselect'" class="field-multiselect">
            <div
              v-for="option in field.options"
              :key="option.value"
              class="checkbox-option"
            >
              <label class="checkbox-label" :for="`form-field-${field.name}-${option.value}`">
                <input
                  type="checkbox"
                  :id="`form-field-${field.name}-${option.value}`"
                  :name="field.name"
                  :value="option.value"
                  v-model="formData[field.name]"
                  :disabled="submitting"
                />
                <span>{{ option.label }}</span>
              </label>
            </div>
          </div>

          <!-- Radio -->
          <div v-else-if="field.type === 'radio'" class="field-radio">
            <div
              v-for="option in field.options"
              :key="option.value"
              class="radio-option"
            >
              <label class="radio-label" :for="`form-field-${field.name}-${option.value}`">
                <input
                  type="radio"
                  :id="`form-field-${field.name}-${option.value}`"
                  :name="field.name"
                  :value="option.value"
                  v-model="formData[field.name]"
                  :required="field.required"
                  :disabled="submitting"
                />
                <span>{{ option.label }}</span>
              </label>
            </div>
          </div>

          <!-- Checkbox (single) -->
          <label v-else-if="field.type === 'checkbox'" class="checkbox-label" :for="`form-field-${field.name}`">
            <input
              :id="`form-field-${field.name}`"
              :name="field.name"
              type="checkbox"
              v-model="formData[field.name]"
              :required="field.required"
              :disabled="submitting"
            />
            <span>{{ field.placeholder || field.label }}</span>
          </label>

          <!-- File Upload -->
          <input
            v-else-if="field.type === 'file'"
            :id="`form-field-${field.name}`"
            :name="field.name"
            type="file"
            @change="handleFileUpload($event, field)"
            :required="field.required"
            :disabled="submitting"
            class="field-file"
          />

          <!-- Image Upload -->
          <div v-else-if="field.type === 'image'" class="field-image">
            <input
              :id="`form-field-${field.name}`"
              :name="field.name"
              type="file"
              accept="image/*"
              @change="handleImageUpload($event, field)"
              :required="field.required"
              :disabled="submitting"
              class="field-file"
            />
            <div v-if="formData[field.name]" class="image-preview">
              <img :src="formData[field.name]" :alt="field.label" />
            </div>
          </div>

          <!-- Rating -->
          <div v-else-if="field.type === 'rating'" class="field-rating">
            <div class="rating-stars">
              <span
                v-for="star in 5"
                :key="star"
                class="star"
                :class="{ active: star <= (formData[field.name] || 0) }"
                @click="formData[field.name] = star"
              >
                ★
              </span>
            </div>
            <span class="rating-text">{{ formData[field.name] || 0 }} / 5</span>
          </div>

          <!-- Slider -->
          <div v-else-if="field.type === 'slider'" class="field-slider">
            <input
              type="range"
              :id="`form-field-${field.name}`"
              :name="field.name"
              v-model.number="formData[field.name]"
              :min="field.validation?.min || 0"
              :max="field.validation?.max || 100"
              :disabled="submitting"
              class="slider-input"
            />
            <div class="slider-value">{{ formData[field.name] || 0 }}</div>
          </div>

          <!-- Color -->
          <input
            v-else-if="field.type === 'color'"
            :id="`form-field-${field.name}`"
            :name="field.name"
            v-model="formData[field.name]"
            type="color"
            :required="field.required"
            :disabled="submitting"
            class="field-color"
          />

          <!-- Validation Error -->
          <div v-if="fieldErrors[field.name]" class="field-error">
            {{ fieldErrors[field.name] }}
          </div>
        </div>

        <!-- Submit Button -->
        <div class="submit-section">
          <button
            type="submit"
            :disabled="submitting || (config.settings.requireAuth && !isAuthenticated)"
            class="submit-btn"
          >
            <span v-if="submitting">提交中...</span>
            <span v-else>{{ config.settings.submitButtonText }}</span>
          </button>
        </div>
      </form>
    </div>

    <!-- Configuration Modal -->
    <div v-if="showConfigModal" class="modal-overlay" @click="closeConfigModal">
      <div class="config-modal" @click.stop>
        <div class="modal-header">
          <h2>表单配置</h2>
          <button @click="closeConfigModal" class="close-btn">×</button>
        </div>

        <div class="modal-body">
          <div class="config-tabs">
            <button
              v-for="tab in configTabs"
              :key="tab.id"
              class="tab-btn"
              :class="{ active: activeConfigTab === tab.id }"
              @click="activeConfigTab = tab.id"
            >
              {{ tab.label }}
            </button>
          </div>

          <div class="tab-content">
            <!-- Basic Settings -->
            <div v-if="activeConfigTab === 'basic'" class="config-section">
            <div class="form-group">
              <label for="form-config-title">表单标题:</label>
                <input id="form-config-title" name="configTitle" v-model="localConfig.settings.title" type="text" />
              </div>
              <div class="form-group">
                <label for="form-config-description">表单描述:</label>
                <textarea id="form-config-description" name="configDescription" v-model="localConfig.settings.description" rows="3"></textarea>
              </div>
              <div class="form-group">
                <label for="form-config-submit-text">提交按钮文字:</label>
                <input
                  id="form-config-submit-text"
                  name="configSubmitButtonText"
                  v-model="localConfig.settings.submitButtonText"
                  type="text"
                />
              </div>
              <div class="form-group">
                <label for="form-config-success-message">成功提示信息:</label>
                <textarea
                  id="form-config-success-message"
                  name="configSuccessMessage"
                  v-model="localConfig.settings.successMessage"
                  rows="2"
                ></textarea>
              </div>
            </div>

            <!-- Fields Configuration -->
            <div v-if="activeConfigTab === 'fields'" class="config-section">
              <div class="fields-list">
                <div
                  v-for="(field, index) in localConfig.fields"
                  :key="field.id"
                  class="field-config"
                >
                  <div class="field-header">
                    <span>{{ field.label || field.name }}</span>
                    <div class="field-actions">
                      <button @click="moveFieldUp(index)">↑</button>
                      <button @click="moveFieldDown(index)">↓</button>
                      <button @click="editField(field)">编辑</button>
                      <button @click="removeField(index)" class="danger">删除</button>
                    </div>
                  </div>
                </div>
              </div>
              <button @click="addNewField" class="add-field-btn">+ 添加字段</button>
            </div>

            <!-- Access Settings -->
            <div v-if="activeConfigTab === 'access'" class="config-section">
              <div class="checkbox-group">
                <label for="form-config-allow-multiple">
                  <input
                    id="form-config-allow-multiple"
                    name="configAllowMultiple"
                    type="checkbox"
                    v-model="localConfig.settings.allowMultiple"
                  />
                  允许多次提交
                </label>
                <label for="form-config-require-auth">
                  <input
                    id="form-config-require-auth"
                    name="configRequireAuth"
                    type="checkbox"
                    v-model="localConfig.settings.requireAuth"
                  />
                  需要登录
                </label>
                <label for="form-config-public-access">
                  <input
                    id="form-config-public-access"
                    name="configEnablePublicAccess"
                    type="checkbox"
                    v-model="localConfig.settings.enablePublicAccess"
                  />
                  允许公开访问
                </label>
                <label for="form-config-notify">
                  <input
                    id="form-config-notify"
                    name="configNotifyOnSubmission"
                    type="checkbox"
                    v-model="localConfig.settings.notifyOnSubmission"
                  />
                  提交时通知
                </label>
              </div>
            </div>
          </div>
        </div>

        <div class="modal-footer">
          <button @click="saveConfig" class="save-btn">保存</button>
          <button @click="closeConfigModal" class="cancel-btn">取消</button>
        </div>
      </div>
    </div>

    <!-- Responses Modal -->
    <div v-if="showResponsesModal" class="modal-overlay" @click="closeResponsesModal">
      <div class="responses-modal" @click.stop>
        <div class="modal-header">
          <h2>表单回复 ({{ totalResponses }})</h2>
          <button @click="closeResponsesModal" class="close-btn">×</button>
        </div>

        <div class="modal-body">
          <div v-if="loadingResponses" class="loading-state">
            加载回复中...
          </div>

          <div v-else-if="responses.length === 0" class="empty-state">
            暂无回复
          </div>

          <div v-else class="responses-list">
            <div
              v-for="response in responses"
              :key="response.id"
              class="response-item"
            >
              <div class="response-header">
                <span class="response-date">{{ formatDate(response.submittedAt) }}</span>
                <span v-if="response.submittedBy" class="response-user">
                  {{ response.submittedBy }}
                </span>
              </div>
              <div class="response-data">
                <div
                  v-for="(value, key) in response.data"
                  :key="key"
                  class="response-field"
                >
                  <strong>{{ key }}:</strong> {{ value }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import type { FormConfig, FormField, FormResponse } from '../types/views'
import { ViewManager } from '../services/ViewManager'
import { useAuth } from '../composables/useAuth'

// Props and route
const route = useRoute()
const viewId = computed(() => route.params.viewId as string || 'form1')
const isPublicAccess = computed(() => route.query.public === 'true')

// Auth
const { getToken } = useAuth()
const isAuthenticated = computed(() => !!getToken())

// Reactive data
const loading = ref(true)
const error = ref('')
const config = ref<FormConfig | null>(null)
const localConfig = ref<FormConfig>(createDefaultConfig())
const formData = ref<Record<string, any>>({})
const fieldErrors = ref<Record<string, string>>({})
const submitting = ref(false)
const submitSuccess = ref(false)

// UI state
const isPreview = ref(true)
const showConfigModal = ref(false)
const showResponsesModal = ref(false)
const activeConfigTab = ref('basic')

// Responses
const responses = ref<FormResponse[]>([])
const totalResponses = ref(0)
const loadingResponses = ref(false)

// Config tabs
const configTabs = [
  { id: 'basic', label: '基本设置' },
  { id: 'fields', label: '字段配置' },
  { id: 'access', label: '访问控制' }
]

// Services
const viewManager = ViewManager.getInstance()

// Computed properties
const sortedFields = computed(() => {
  if (!config.value?.fields) return []
  return [...config.value.fields].sort((a, b) => a.order - b.order)
})

// Methods
async function loadForm() {
  loading.value = true
  error.value = ''

  try {
    config.value = await viewManager.loadViewConfig<FormConfig>(viewId.value)

    if (config.value) {
      localConfig.value = JSON.parse(JSON.stringify(config.value))
      initializeFormData()
    } else {
      // Create default config
      config.value = createDefaultConfig()
      localConfig.value = JSON.parse(JSON.stringify(config.value))
      initializeFormData()
    }

    // Load response count
    if (!isPublicAccess.value) {
      loadResponseCount()
    }
  } catch (err) {
    console.error('Failed to load form:', err)
    error.value = '加载表单失败'
  } finally {
    loading.value = false
  }
}

function createDefaultConfig(): FormConfig {
  return {
    id: viewId.value,
    name: '新表单',
    type: 'form',
    description: '表单描述',
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: 'system',
    fields: [
      {
        id: '1',
        name: 'name',
        label: '姓名',
        type: 'text',
        required: true,
        placeholder: '请输入您的姓名',
        order: 1,
        width: 'full'
      },
      {
        id: '2',
        name: 'email',
        label: '邮箱',
        type: 'email',
        required: true,
        placeholder: '请输入您的邮箱',
        order: 2,
        width: 'full'
      }
    ],
    settings: {
      title: '新表单',
      description: '请填写以下信息',
      submitButtonText: '提交',
      successMessage: '感谢您的提交！',
      allowMultiple: true,
      requireAuth: false,
      enablePublicAccess: true,
      notifyOnSubmission: false
    },
    validation: {
      enableValidation: true
    },
    styling: {
      theme: 'default',
      layout: 'single-column'
    }
  }
}

function initializeFormData() {
  if (!config.value) return

  formData.value = {}
  config.value.fields.forEach(field => {
    if (field.defaultValue !== undefined) {
      formData.value[field.name] = field.defaultValue
    } else if (field.type === 'multiselect') {
      formData.value[field.name] = []
    } else {
      formData.value[field.name] = ''
    }
  })
}

function isFieldVisible(field: FormField): boolean {
  if (!field.conditional) return true

  const conditionValue = formData.value[field.conditional.field]
  const targetValue = field.conditional.value

  switch (field.conditional.operator) {
    case 'equals':
      return conditionValue === targetValue
    case 'not_equals':
      return conditionValue !== targetValue
    case 'contains':
      return String(conditionValue).includes(String(targetValue))
    case 'greater_than':
      return Number(conditionValue) > Number(targetValue)
    case 'less_than':
      return Number(conditionValue) < Number(targetValue)
    default:
      return true
  }
}

function validateField(field: FormField, value: any): string | null {
  if (field.required && (!value || value === '')) {
    return `${field.label} 是必填项`
  }

  if (!field.validation) return null

  const validation = field.validation

  if (typeof value === 'string') {
    if (validation.minLength && value.length < validation.minLength) {
      return `${field.label} 至少需要 ${validation.minLength} 个字符`
    }
    if (validation.maxLength && value.length > validation.maxLength) {
      return `${field.label} 不能超过 ${validation.maxLength} 个字符`
    }
    if (validation.pattern) {
      const regex = new RegExp(validation.pattern)
      if (!regex.test(value)) {
        return `${field.label} 格式不正确`
      }
    }
  }

  if (typeof value === 'number') {
    if (validation.min !== undefined && value < validation.min) {
      return `${field.label} 不能小于 ${validation.min}`
    }
    if (validation.max !== undefined && value > validation.max) {
      return `${field.label} 不能大于 ${validation.max}`
    }
  }

  return null
}

function validateForm(): boolean {
  if (!config.value) return false

  fieldErrors.value = {}
  let isValid = true

  config.value.fields.forEach(field => {
    if (!isFieldVisible(field)) return

    const error = validateField(field, formData.value[field.name])
    if (error) {
      fieldErrors.value[field.name] = error
      isValid = false
    }
  })

  return isValid
}

async function submitForm() {
  if (!config.value) return

  if (!validateForm()) {
    return
  }

  submitting.value = true

  try {
    const response = await viewManager.submitForm(viewId.value, formData.value)

    if (response.success) {
      submitSuccess.value = true
      if (!config.value.settings.allowMultiple) {
        // Disable form
      }
    } else {
      alert(response.error || '提交失败')
    }
  } catch (err) {
    console.error('Failed to submit form:', err)
    alert('提交失败')
  } finally {
    submitting.value = false
  }
}

function resetForm() {
  submitSuccess.value = false
  initializeFormData()
  fieldErrors.value = {}
}

function handleFileUpload(event: Event, field: FormField) {
  const files = (event.target as HTMLInputElement).files
  if (files && files[0]) {
    // In a real implementation, you would upload the file to a server
    formData.value[field.name] = files[0].name
  }
}

function handleImageUpload(event: Event, field: FormField) {
  const files = (event.target as HTMLInputElement).files
  if (files && files[0]) {
    const reader = new FileReader()
    reader.onload = (e) => {
      formData.value[field.name] = e.target?.result as string
    }
    reader.readAsDataURL(files[0])
  }
}

function togglePreview() {
  isPreview.value = !isPreview.value
}

async function loadResponseCount() {
  try {
    const response = await viewManager.getFormResponses(viewId.value, 1, 1)
    totalResponses.value = response.meta.total
  } catch (err) {
    console.error('Failed to load response count:', err)
  }
}

async function loadResponses() {
  if (loadingResponses.value) return

  loadingResponses.value = true
  try {
    const response = await viewManager.getFormResponses(viewId.value, 1, 20)
    responses.value = response.data
    totalResponses.value = response.meta.total
  } catch (err) {
    console.error('Failed to load responses:', err)
  } finally {
    loadingResponses.value = false
  }
}

function closeConfigModal() {
  showConfigModal.value = false
  if (config.value) {
    localConfig.value = JSON.parse(JSON.stringify(config.value))
  }
}

function closeResponsesModal() {
  showResponsesModal.value = false
}

async function saveConfig() {
  if (localConfig.value) {
    const success = await viewManager.saveViewConfig(localConfig.value)
    if (success) {
      config.value = JSON.parse(JSON.stringify(localConfig.value))
      showConfigModal.value = false
      initializeFormData()
    } else {
      alert('保存配置失败')
    }
  }
}

function addNewField() {
  if (!localConfig.value) return

  const newField: FormField = {
    id: Date.now().toString(),
    name: `field_${Date.now()}`,
    label: '新字段',
    type: 'text',
    required: false,
    order: localConfig.value.fields.length + 1,
    width: 'full'
  }

  localConfig.value.fields.push(newField)
}

function removeField(index: number) {
  if (localConfig.value && confirm('确定删除此字段？')) {
    localConfig.value.fields.splice(index, 1)
  }
}

function moveFieldUp(index: number) {
  if (localConfig.value && index > 0) {
    const temp = localConfig.value.fields[index]!
    localConfig.value.fields[index] = localConfig.value.fields[index - 1]!
    localConfig.value.fields[index - 1] = temp
  }
}

function moveFieldDown(index: number) {
  if (localConfig.value && index < localConfig.value.fields.length - 1) {
    const temp = localConfig.value.fields[index]!
    localConfig.value.fields[index] = localConfig.value.fields[index + 1]!
    localConfig.value.fields[index + 1] = temp
  }
}

function editField(field: FormField) {
  // In a real implementation, this would open a field editor modal
  const newLabel = prompt('字段标签:', field.label)
  if (newLabel) {
    field.label = newLabel
  }
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(date))
}

// Watch for responses modal opening
watch(() => showResponsesModal.value, (show) => {
  if (show) {
    loadResponses()
  }
})

// Lifecycle
onMounted(() => {
  loadForm()
})

// Watch for view ID changes
watch(() => viewId.value, () => {
  config.value = null
  localConfig.value = createDefaultConfig()
  submitSuccess.value = false
  loadForm()
})
</script>

<style scoped>
.form-container {
  max-width: 800px;
  margin: 0 auto;
  padding: 2rem;
  background: #f8f9fa;
  min-height: 100vh;
}

.form-container.public-form {
  background: white;
}

.form-header {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 2rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid #e0e0e0;
}

.header-controls {
  display: flex;
  gap: 1rem;
}

.preview-btn,
.config-btn,
.responses-btn {
  padding: 0.5rem 1rem;
  border: 1px solid #ddd;
  border-radius: 6px;
  background: white;
  cursor: pointer;
  font-size: 0.9rem;
}

.preview-btn.active {
  background: #667eea;
  color: white;
}

.config-btn:hover,
.responses-btn:hover {
  background: #f5f5f5;
}

.loading-state,
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 200px;
  color: #666;
}

.loading-spinner {
  width: 40px;
  height: 40px;
  border: 4px solid #f0f0f0;
  border-top: 4px solid #667eea;
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 1rem;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.error-message {
  color: #ef4444;
  margin-bottom: 1rem;
}

.retry-btn {
  padding: 0.5rem 1rem;
  background: #667eea;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.form-content {
  background: white;
  border-radius: 8px;
  padding: 2rem;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.form-intro {
  text-align: center;
  margin-bottom: 2rem;
  padding-bottom: 1.5rem;
  border-bottom: 1px solid #e0e0e0;
}

.form-title {
  margin: 0 0 1rem 0;
  color: #333;
  font-size: 2rem;
  font-weight: 600;
}

.form-description {
  margin: 0;
  color: #666;
  font-size: 1.1rem;
  line-height: 1.6;
}

.auth-notice {
  margin-top: 1rem;
  padding: 1rem;
  background: #fef3c7;
  border: 1px solid #f59e0b;
  border-radius: 6px;
  color: #92400e;
}

.success-message {
  text-align: center;
  padding: 2rem;
}

.success-icon {
  font-size: 3rem;
  margin-bottom: 1rem;
}

.success-message h3 {
  margin: 0 0 1rem 0;
  color: #047857;
}

.success-message p {
  margin: 0 0 1.5rem 0;
  color: #666;
}

.submit-another-btn {
  padding: 0.75rem 1.5rem;
  background: #667eea;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 1rem;
}

.form-fields {
  display: grid;
  gap: 1.5rem;
}

.layout-two-column .form-fields {
  grid-template-columns: 1fr 1fr;
}

.field-wrapper {
  display: flex;
  flex-direction: column;
}

.field-wrapper.hidden {
  display: none;
}

.field-wrapper.width-half {
  grid-column: span 1;
}

.field-wrapper.width-full {
  grid-column: 1 / -1;
}

.field-label {
  margin-bottom: 0.5rem;
  font-weight: 500;
  color: #333;
  display: block;
}

.field-label.required::after {
  content: ' *';
  color: #ef4444;
}

.field-description {
  display: block;
  font-size: 0.85rem;
  color: #666;
  font-weight: normal;
  margin-top: 0.25rem;
}

.field-input,
.field-textarea,
.field-select,
.field-file {
  padding: 0.75rem;
  border: 1px solid #ddd;
  border-radius: 6px;
  font-size: 1rem;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.field-input:focus,
.field-textarea:focus,
.field-select:focus {
  outline: none;
  border-color: #667eea;
  box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
}

.field-textarea {
  resize: vertical;
  min-height: 80px;
}

.field-multiselect,
.field-radio {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.checkbox-option,
.radio-option {
  display: flex;
  align-items: center;
}

.checkbox-label,
.radio-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  font-weight: normal;
}

.field-image {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.image-preview {
  max-width: 200px;
}

.image-preview img {
  width: 100%;
  height: auto;
  border-radius: 6px;
  border: 1px solid #ddd;
}

.field-rating {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.rating-stars {
  display: flex;
  gap: 0.25rem;
}

.star {
  font-size: 1.5rem;
  color: #ddd;
  cursor: pointer;
  transition: color 0.2s;
}

.star.active {
  color: #fbbf24;
}

.star:hover {
  color: #f59e0b;
}

.rating-text {
  font-size: 0.9rem;
  color: #666;
}

.field-slider {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.slider-input {
  flex: 1;
}

.slider-value {
  min-width: 3rem;
  text-align: center;
  font-weight: 500;
}

.field-color {
  width: 60px;
  height: 40px;
  border-radius: 6px;
  border: 1px solid #ddd;
  cursor: pointer;
}

.field-error {
  margin-top: 0.25rem;
  color: #ef4444;
  font-size: 0.85rem;
}

.submit-section {
  margin-top: 2rem;
  padding-top: 1.5rem;
  border-top: 1px solid #e0e0e0;
  text-align: center;
}

.submit-btn {
  padding: 1rem 2rem;
  background: #667eea;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 1.1rem;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.2s;
  min-width: 150px;
}

.submit-btn:hover:not(:disabled) {
  background: #5a67d8;
}

.submit-btn:disabled {
  background: #cbd5e0;
  cursor: not-allowed;
}

/* Modal Styles */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.config-modal,
.responses-modal {
  background: white;
  border-radius: 8px;
  max-width: 900px;
  width: 90vw;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1.5rem;
  border-bottom: 1px solid #e0e0e0;
}

.modal-header h2 {
  margin: 0;
  color: #333;
}

.close-btn {
  background: none;
  border: none;
  font-size: 1.5rem;
  cursor: pointer;
  color: #666;
  padding: 0.25rem;
  border-radius: 4px;
}

.close-btn:hover {
  background: #f0f0f0;
}

.modal-body {
  flex: 1;
  padding: 1.5rem;
  overflow-y: auto;
}

.config-tabs {
  display: flex;
  border-bottom: 1px solid #e0e0e0;
  margin-bottom: 1.5rem;
}

.tab-btn {
  padding: 0.75rem 1.5rem;
  background: none;
  border: none;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
}

.tab-btn.active {
  border-bottom-color: #667eea;
  color: #667eea;
}

.tab-btn:hover {
  background: #f8f9fa;
}

.config-section {
  max-width: 600px;
}

.form-group {
  margin-bottom: 1.5rem;
}

.form-group label {
  display: block;
  margin-bottom: 0.5rem;
  font-weight: 500;
  color: #555;
}

.form-group input,
.form-group textarea,
.form-group select {
  width: 100%;
  padding: 0.5rem;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 0.9rem;
}

.checkbox-group {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.checkbox-group label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: normal;
}

.fields-list {
  margin-bottom: 1rem;
}

.field-config {
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  margin-bottom: 0.5rem;
}

.field-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem;
}

.field-actions {
  display: flex;
  gap: 0.5rem;
}

.field-actions button {
  padding: 0.25rem 0.5rem;
  background: #f8f9fa;
  border: 1px solid #ddd;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.8rem;
}

.field-actions button.danger {
  background: #fee2e2;
  border-color: #fecaca;
  color: #dc2626;
}

.add-field-btn {
  padding: 0.75rem 1.5rem;
  background: #667eea;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.responses-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.response-item {
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  padding: 1rem;
}

.response-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.75rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid #f0f0f0;
}

.response-date {
  color: #666;
  font-size: 0.9rem;
}

.response-user {
  font-weight: 500;
  color: #333;
}

.response-data {
  display: grid;
  gap: 0.5rem;
}

.response-field {
  font-size: 0.9rem;
}

.response-field strong {
  color: #555;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 1rem;
  padding: 1.5rem;
  border-top: 1px solid #e0e0e0;
}

.save-btn {
  padding: 0.75rem 1.5rem;
  background: #667eea;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 500;
}

.save-btn:hover {
  background: #5a67d8;
}

.cancel-btn {
  padding: 0.75rem 1.5rem;
  background: #f8f9fa;
  border: 1px solid #ddd;
  border-radius: 6px;
  cursor: pointer;
}

.cancel-btn:hover {
  background: #e9ecef;
}

/* Responsive */
@media (max-width: 768px) {
  .form-container {
    padding: 1rem;
  }

  .form-content {
    padding: 1.5rem;
  }

  .form-title {
    font-size: 1.5rem;
  }

  .layout-two-column .form-fields {
    grid-template-columns: 1fr;
  }

  .field-wrapper.width-half {
    grid-column: 1;
  }

  .header-controls {
    flex-wrap: wrap;
    gap: 0.5rem;
  }
}
</style>
