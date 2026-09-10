<template>
  <section class="certificate-admin" aria-labelledby="certificate-admin-title">
    <header>
      <h3 id="certificate-admin-title">{{ text('Certificates', '证书') }}</h3>
      <p>{{ text('Publish an immutable template revision, then issue a snapshot to one employee.', '发布不可变模板版本，再为单个员工签发快照。') }}</p>
    </header>

    <form class="certificate-admin__form" data-testid="elearning-certificate-template-form" @submit.prevent="void submitTemplate()">
      <label>
        <span>{{ text('Certificate key', '证书标识') }}</span>
        <input v-model="certificateId" data-testid="elearning-certificate-template-id" type="text" maxlength="512" autocomplete="off" :disabled="templateBusy">
      </label>
      <label>
        <span>{{ text('Name', '名称') }}</span>
        <input v-model="templateName" data-testid="elearning-certificate-template-name" type="text" maxlength="512" autocomplete="off" :disabled="templateBusy">
      </label>
      <label>
        <span>{{ text('Template text (#parameter# placeholders)', '模板文字（使用 #参数# 占位符）') }}</span>
        <textarea v-model="templateText" data-testid="elearning-certificate-template-text" maxlength="16384" :disabled="templateBusy" />
      </label>
      <label>
        <span>{{ text('HTTPS background image URL (optional)', 'HTTPS 背景图地址（可选）') }}</span>
        <input v-model="backgroundImageUrl" data-testid="elearning-certificate-template-background" type="url" maxlength="2048" autocomplete="off" :disabled="templateBusy">
      </label>
      <button data-testid="elearning-certificate-template-submit" type="submit" :disabled="templateBusy">
        {{ templateBusy ? text('Publishing...', '正在发布…') : text('Publish template', '发布模板') }}
      </button>
    </form>

    <p v-if="templateStatus" class="certificate-admin__status" :class="{ 'certificate-admin__status--error': templateError }" data-testid="elearning-certificate-template-status" role="status">
      {{ templateStatus }}
    </p>
    <p v-if="loading" data-testid="elearning-certificate-template-loading">{{ text('Loading templates...', '正在加载模板…') }}</p>
    <p v-else-if="templates.length === 0" data-testid="elearning-certificate-template-empty">{{ text('No active certificate templates.', '暂无生效证书模板。') }}</p>
    <ul v-else class="certificate-admin__templates" data-testid="elearning-certificate-template-list">
      <li v-for="template in templates" :key="template.certificateId">
        <strong>{{ template.name }}</strong>
        <span>{{ template.certificateId }} · v{{ template.version }}</span>
        <span>{{ text('Parameters', '参数') }}: {{ template.placeholders.join(', ') || text('none', '无') }}</span>
      </li>
    </ul>

    <form class="certificate-admin__form" data-testid="elearning-certificate-issue-form" @submit.prevent="void submitIssue()">
      <label>
        <span>{{ text('Template', '模板') }}</span>
        <select v-model="issueCertificateId" data-testid="elearning-certificate-issue-template" :disabled="issueBusy || templates.length === 0">
          <option value="" disabled>{{ text('Select a template', '请选择模板') }}</option>
          <option v-for="template in templates" :key="template.certificateId" :value="template.certificateId">
            {{ template.name }} (v{{ template.version }})
          </option>
        </select>
      </label>
      <label>
        <span>{{ text('Employee user ID', '员工用户 ID') }}</span>
        <input v-model="issueUserId" data-testid="elearning-certificate-issue-user" type="text" maxlength="512" autocomplete="off" :disabled="issueBusy">
      </label>
      <label v-for="placeholder in selectedTemplate?.placeholders ?? []" :key="placeholder">
        <span>{{ placeholder }}</span>
        <input v-model="issueParameters[placeholder]" :data-testid="`elearning-certificate-issue-parameter-${placeholder}`" type="text" maxlength="2048" autocomplete="off" :disabled="issueBusy">
      </label>
      <button data-testid="elearning-certificate-issue-submit" type="submit" :disabled="issueBusy || !selectedTemplate">
        {{ issueBusy ? text('Issuing...', '正在签发…') : text('Issue certificate', '签发证书') }}
      </button>
    </form>
    <p v-if="issueStatus" class="certificate-admin__status" :class="{ 'certificate-admin__status--error': issueError }" data-testid="elearning-certificate-issue-status" role="status">
      {{ issueStatus }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useLocale } from '../composables/useLocale'
import { ElearningApiError } from '../services/elearning'
import {
  issueElearningCertificate,
  listElearningCertificateTemplates,
  publishElearningCertificateTemplate,
  type ElearningCertificateTemplate,
} from '../services/elearningCertificate'

const { isZh } = useLocale()
const templates = ref<ElearningCertificateTemplate[]>([])
const loading = ref(false)
const certificateId = ref('course-completion')
const templateName = ref('')
const templateText = ref('')
const backgroundImageUrl = ref('')
const templateBusy = ref(false)
const templateStatus = ref('')
const templateError = ref(false)
const issueCertificateId = ref('')
const issueUserId = ref('')
const issueParameters = reactive<Record<string, string>>({})
const issueBusy = ref(false)
const issueStatus = ref('')
const issueError = ref(false)
let templateRequestId = ''
let templatePayload = ''
let issueRequestId = ''
let issuePayload = ''

const selectedTemplate = computed(() => (
  templates.value.find((template) => template.certificateId === issueCertificateId.value)
  ?? null
))

function text(en: string, zh: string): string {
  return isZh.value ? zh : en
}

function newRequestId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : ''
}

function errorText(value: unknown): string {
  if (value instanceof ElearningApiError) {
    if (value.status === 400) return text('Check all certificate values.', '请检查证书填写内容。')
    if (value.status === 403) return text('You cannot manage certificates.', '您无权管理证书。')
    if (value.status === 404) return text('The employee or certificate template is unavailable.', '员工或证书模板不可用。')
    if (value.status === 409) return text('This request ID was used for different values.', '该请求标识已用于不同内容。')
  }
  return text('Unable to update certificates. Try again.', '无法更新证书，请重试。')
}

async function refresh(): Promise<void> {
  loading.value = true
  try {
    templates.value = await listElearningCertificateTemplates()
    if (
      !issueCertificateId.value
      || !templates.value.some((template) => template.certificateId === issueCertificateId.value)
    ) issueCertificateId.value = templates.value[0]?.certificateId ?? ''
  } catch (value) {
    templateError.value = true
    templateStatus.value = errorText(value)
  } finally {
    loading.value = false
  }
}

async function submitTemplate(): Promise<void> {
  if (templateBusy.value) return
  const background = backgroundImageUrl.value.trim() || null
  const payload = JSON.stringify({
    certificateId: certificateId.value.trim(),
    name: templateName.value.trim(),
    templateText: templateText.value,
    backgroundImageUrl: background,
  })
  if (payload !== templatePayload) {
    templateRequestId = newRequestId()
    templatePayload = payload
  }
  if (!templateRequestId) {
    templateError.value = true
    templateStatus.value = text('Secure request identifiers are unavailable.', '当前环境无法生成安全请求标识。')
    return
  }
  templateBusy.value = true
  templateError.value = false
  templateStatus.value = ''
  try {
    await publishElearningCertificateTemplate({
      requestId: templateRequestId,
      certificateId: certificateId.value,
      name: templateName.value,
      templateText: templateText.value,
      backgroundImageUrl: background,
    })
    templateRequestId = ''
    templatePayload = ''
    templateStatus.value = text('Certificate template published.', '证书模板已发布。')
    await refresh()
  } catch (value) {
    templateError.value = true
    templateStatus.value = errorText(value)
  } finally {
    templateBusy.value = false
  }
}

async function submitIssue(): Promise<void> {
  if (issueBusy.value || !selectedTemplate.value) return
  const parameters = Object.fromEntries(
    selectedTemplate.value.placeholders.map((name) => [name, issueParameters[name] ?? '']),
  )
  const payload = JSON.stringify({
    certificateId: selectedTemplate.value.certificateId,
    templateRevisionId: selectedTemplate.value.revisionId,
    userId: issueUserId.value.trim(),
    parameters,
  })
  if (payload !== issuePayload) {
    issueRequestId = newRequestId()
    issuePayload = payload
  }
  if (!issueRequestId) {
    issueError.value = true
    issueStatus.value = text('Secure request identifiers are unavailable.', '当前环境无法生成安全请求标识。')
    return
  }
  issueBusy.value = true
  issueError.value = false
  issueStatus.value = ''
  try {
    const result = await issueElearningCertificate({
      requestId: issueRequestId,
      certificateId: selectedTemplate.value.certificateId,
      userId: issueUserId.value,
      parameters,
    })
    issueRequestId = ''
    issuePayload = ''
    issueStatus.value = text(
      `Certificate issued. Serial ${result.serialNumber}`,
      `证书已签发，序列号 ${result.serialNumber}`,
    )
  } catch (value) {
    issueError.value = true
    issueStatus.value = errorText(value)
  } finally {
    issueBusy.value = false
  }
}

watch(selectedTemplate, (template) => {
  const allowed = new Set(template?.placeholders ?? [])
  for (const key of Object.keys(issueParameters)) {
    if (!allowed.has(key)) delete issueParameters[key]
  }
  for (const key of allowed) {
    if (!(key in issueParameters)) issueParameters[key] = ''
  }
})

onMounted(() => {
  void refresh()
})
</script>

<style scoped>
.certificate-admin { display: grid; gap: 12px; padding-top: 14px; border-top: 1px solid #d7e0ea; }
.certificate-admin header h3,
.certificate-admin header p,
.certificate-admin__status { margin: 0; }
.certificate-admin__form { display: grid; gap: 10px; }
.certificate-admin__form label { display: grid; gap: 4px; }
.certificate-admin__form input,
.certificate-admin__form select,
.certificate-admin__form textarea,
.certificate-admin__form button { min-height: 36px; }
.certificate-admin__form textarea { min-height: 90px; }
.certificate-admin__templates { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.certificate-admin__templates li { display: grid; gap: 2px; }
.certificate-admin__status--error { color: #b42318; }
</style>
