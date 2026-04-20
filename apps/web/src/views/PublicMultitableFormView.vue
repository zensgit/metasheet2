<template>
  <main class="public-multitable-form">
    <section class="public-multitable-form__card">
      <header class="public-multitable-form__header">
        <p class="public-multitable-form__eyebrow">Public multitable form</p>
        <h1>{{ title }}</h1>
        <p v-if="subtitle" class="public-multitable-form__subtitle">{{ subtitle }}</p>
      </header>

      <div v-if="loading || redirectingToDingTalk" class="public-multitable-form__state">
        {{ redirectingToDingTalk ? redirectingMessage : 'Loading form…' }}
      </div>
      <div v-else-if="loadError" class="public-multitable-form__state public-multitable-form__state--error">
        {{ loadError }}
      </div>
      <div v-else-if="submitted && submissionResult" class="public-multitable-form__state public-multitable-form__state--success">
        <h2>Submission received</h2>
        <p>{{ submissionMessage }}</p>
        <p v-if="submissionResult.record?.id" class="public-multitable-form__record-id">
          Record ID: <code>{{ submissionResult.record.id }}</code>
        </p>
        <button type="button" class="public-multitable-form__button" @click="resetForm">
          Submit another response
        </button>
      </div>
      <MetaFormView
        v-else-if="context"
        :key="formKey"
        :fields="context.fields"
        :record="context.record ?? null"
        :loading="false"
        :read-only="context.readOnly"
        :submitting="submitting"
        :error-message="submitError"
        :field-errors="fieldErrors"
        :field-permissions="context.fieldPermissions ?? null"
        :row-actions="context.rowActions ?? null"
        :attachment-summaries-by-field="context.attachmentSummaries ?? null"
        @submit="onSubmit"
      />
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { FormSubmitResult, MetaFormContext } from '../multitable/types'
import { multitableClient } from '../multitable/api/client'
import MetaFormView from '../multitable/components/MetaFormView.vue'
import { apiFetch } from '../utils/api'

const props = defineProps<{
  sheetId?: string
  viewId?: string
  publicToken?: string
}>()

const context = ref<MetaFormContext | null>(null)
const loading = ref(true)
const loadError = ref<string | null>(null)
const submitting = ref(false)
const submitError = ref<string | null>(null)
const fieldErrors = ref<Record<string, string> | null>(null)
const submitted = ref(false)
const submissionResult = ref<FormSubmitResult | null>(null)
const formKey = ref(0)
const redirectingToDingTalk = ref(false)

const title = computed(() => context.value?.view?.name || context.value?.sheet?.name || 'Public multitable form')
const subtitle = computed(() => {
  if (!context.value) return 'Submit this form anonymously.'
  const parts = [context.value.sheet?.name, context.value.view?.name].filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  return parts.length ? parts.join(' · ') : 'Submit this form anonymously.'
})
const submissionMessage = computed(() => {
  if (!submissionResult.value) return 'Your response has been saved.'
  return submissionResult.value.mode === 'update'
    ? 'Your response has been updated successfully.'
    : 'Your response has been submitted successfully.'
})
const redirectingMessage = computed(() => 'Redirecting to DingTalk sign-in…')

async function loadForm(): Promise<void> {
  loading.value = true
  loadError.value = null
  submitError.value = null
  fieldErrors.value = null
  submitted.value = false
  submissionResult.value = null
  redirectingToDingTalk.value = false
  try {
    const publicToken = props.publicToken?.trim()
    if (!publicToken) {
      throw new Error('Missing public token')
    }
    if (!props.sheetId || !props.viewId) {
      throw new Error('Missing multitable route params')
    }
    context.value = await multitableClient.loadFormContext({
      sheetId: props.sheetId,
      viewId: props.viewId,
      publicToken,
    })
  } catch (error) {
    if (isDingTalkAuthRequired(error)) {
      const launched = await launchDingTalkSignIn()
      if (launched) return
    }
    context.value = null
    loadError.value = readPublicFormErrorMessage(error, 'Failed to load public form')
  } finally {
    if (!redirectingToDingTalk.value) {
      loading.value = false
    }
  }
}

async function onSubmit(data: Record<string, unknown>): Promise<void> {
  if (!context.value || submitting.value) return
  const publicToken = props.publicToken?.trim()
  if (!publicToken) {
    submitError.value = 'Missing public token'
    return
  }

  submitting.value = true
  submitError.value = null
  fieldErrors.value = null
  try {
    const result = await multitableClient.submitForm(props.viewId ?? context.value.view?.id ?? '', {
      publicToken,
      recordId: context.value.record?.id,
      expectedVersion: context.value.record?.version,
      data,
    })
    submissionResult.value = result
    submitted.value = true
  } catch (error) {
    if (isDingTalkAuthRequired(error)) {
      const launched = await launchDingTalkSignIn()
      if (launched) return
    }
    submitError.value = readPublicFormErrorMessage(error, 'Failed to submit public form')
    fieldErrors.value = readFieldErrors(error)
  } finally {
    submitting.value = false
  }
}

function resetForm(): void {
  submitted.value = false
  submissionResult.value = null
  submitError.value = null
  fieldErrors.value = null
  formKey.value += 1
}

function readErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return fallback
}

function readErrorCode(error: unknown): string {
  return error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string'
    ? String((error as Error & { code?: unknown }).code)
    : ''
}

function isDingTalkAuthRequired(error: unknown): boolean {
  return readErrorCode(error) === 'DINGTALK_AUTH_REQUIRED'
}

function readPublicFormErrorMessage(error: unknown, fallback: string): string {
  const code = readErrorCode(error)
  if (code === 'DINGTALK_BIND_REQUIRED') {
    return 'This form only accepts users with a bound DingTalk account.'
  }
  if (code === 'DINGTALK_GRANT_REQUIRED') {
    return 'This form only accepts DingTalk-authorized users.'
  }
  return readErrorMessage(error, fallback)
}

function currentPublicFormRedirect(): string {
  if (typeof window === 'undefined') return '/login'
  const path = `${window.location.pathname || ''}${window.location.search || ''}${window.location.hash || ''}`.trim()
  return path || '/login'
}

async function launchDingTalkSignIn(): Promise<boolean> {
  redirectingToDingTalk.value = true
  loadError.value = null
  try {
    const response = await apiFetch(
      `/api/auth/dingtalk/launch?redirect=${encodeURIComponent(currentPublicFormRedirect())}`,
      { suppressUnauthorizedRedirect: true },
    )
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.success || typeof payload?.data?.url !== 'string' || payload.data.url.trim().length === 0) {
      throw new Error(readErrorMessage(payload, 'Failed to start DingTalk sign-in'))
    }
    if (typeof window !== 'undefined' && typeof window.location?.assign === 'function') {
      window.location.assign(payload.data.url)
      return true
    }
    if (typeof window !== 'undefined') {
      window.location.href = payload.data.url
      return true
    }
    return false
  } catch (error) {
    redirectingToDingTalk.value = false
    loadError.value = readErrorMessage(error, 'Failed to start DingTalk sign-in')
    return false
  }
}

function readFieldErrors(error: unknown): Record<string, string> | null {
  if (!error || typeof error !== 'object') return null
  const fieldErrors = (error as { fieldErrors?: Record<string, string> }).fieldErrors
  return fieldErrors && Object.keys(fieldErrors).length ? fieldErrors : null
}

watch(
  () => [props.sheetId, props.viewId, props.publicToken],
  () => {
    void loadForm()
  },
  { immediate: true },
)
</script>

<style scoped>
.public-multitable-form {
  min-height: 100vh;
  padding: 40px 20px;
  background:
    radial-gradient(circle at top, rgba(79, 124, 255, 0.16), transparent 36%),
    linear-gradient(180deg, #f8fbff 0%, #eef3ff 100%);
}

.public-multitable-form__card {
  max-width: 920px;
  margin: 0 auto;
  padding: 28px;
  border: 1px solid rgba(148, 163, 184, 0.25);
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.88);
  box-shadow: 0 24px 80px rgba(15, 23, 42, 0.08);
  backdrop-filter: blur(12px);
}

.public-multitable-form__header {
  margin-bottom: 20px;
}

.public-multitable-form__eyebrow {
  margin: 0 0 8px;
  font-size: 12px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #5b6b88;
}

.public-multitable-form__header h1 {
  margin: 0;
  font-size: 34px;
  line-height: 1.1;
  color: #10203a;
}

.public-multitable-form__subtitle {
  margin: 10px 0 0;
  color: #5b6b88;
}

.public-multitable-form__state {
  padding: 18px;
  border-radius: 16px;
  background: #f8fafc;
  color: #334155;
}

.public-multitable-form__state--error {
  background: #fff1f2;
  color: #be123c;
}

.public-multitable-form__state--success {
  display: grid;
  gap: 10px;
  background: #ecfdf5;
  color: #14532d;
}

.public-multitable-form__state--success h2 {
  margin: 0;
  font-size: 20px;
}

.public-multitable-form__record-id {
  margin: 0;
  color: #166534;
}

.public-multitable-form__button {
  justify-self: start;
  border: none;
  border-radius: 999px;
  padding: 10px 16px;
  background: #14532d;
  color: #fff;
  cursor: pointer;
}

.public-multitable-form__button:hover {
  background: #166534;
}
</style>
