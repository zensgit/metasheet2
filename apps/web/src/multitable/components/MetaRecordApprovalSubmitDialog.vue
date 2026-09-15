<!--
  送审对话框 / Record approval submit dialog — 多维表 × 审批 阶段二 (design
  docs/development/takeover-beiliao-20260821/multitable-approval-phase2-record-submit-design-20260915.md §5.2).

  What a business user gets: from the record drawer's kebab, pick ONE PUBLISHED approval template, fill
  its form, and the record is submitted for approval — without first authoring an automation rule.

  STRUCTURE: Teleport + overlay + `role="dialog"` + `aria-label`, deliberately the same shape as
  MetaExportDialog.vue (this file's structural template). It goes one step further than that file: the
  `aria-modal="true"` it declares is BACKED — focus moves into the panel on open, Tab is trapped inside,
  Esc closes it (and only it), and focus returns to the opener on close, the way
  AttendanceSetupTemplatePrefillDialog.vue does it. A teleported modal that claims aria-modal without
  that behaviour leaves focus on <body> and lets Tab walk the workbench behind the overlay.

  TEMPLATE LIST: `client.listApprovalTemplates({ status: 'published', pageSize })` — the filter is a
  SERVER parameter, not a client-side `.filter()`, so a draft/archived template can never reach the picker
  even if the roster is paginated; `pageSize` is the route's ceiling because its default (20) would
  silently truncate the picker, and a full answer shows a "the rest live in the approval centre" notice. An empty roster or a 401/403 (the route is `approvals:read` guarded) shows
  ONE notice and NOTHING else: there is deliberately no free-text template-id input, because typing an id
  you cannot read is not a permission the FE may hand out.

  FORM: `client.getApprovalTemplate(id)` gives the active version's fields, rendered GENERICALLY for
  text / longText / number / select / date / checkbox. Any other type (user, department, attachment,
  detail, record-link, date_range, …) makes the dialog REFUSE to submit and say so — a partial submit
  that silently drops a field the template requires would create an approval nobody can finish.

  409: the route answers RECORD_APPROVAL_IN_FLIGHT when this (record, template) pair already has a
  creating/pending submission. We surface the in-flight request number and — only when a router is
  actually present (this component is reachable from router-less test harnesses through the drawer, see
  MetaRecordInspector.vue's file header) — a link to the instance.

  VALUES-FREE: the only record-derived thing this dialog sends is `recordId` in the URL; the form values
  are what the ACTOR typed. It never reads `record.data`.
-->
<template>
  <Teleport to="body">
    <div v-if="visible" class="meta-approval-overlay" @click.self="onCancel">
      <div
        ref="modalRef"
        class="meta-approval-modal"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        :aria-label="l('approval.dialogTitle')"
        data-testid="record-approval-dialog"
        @keydown="onKeydown"
      >
        <div class="meta-approval__header">
          <strong>{{ l('approval.dialogTitle') }}</strong>
          <MtIconButton class="meta-approval__close" :aria-label="l('approval.close')" @click="onCancel">&times;</MtIconButton>
        </div>

        <div class="meta-approval__body">
          <p
            v-if="templatesLoading"
            class="meta-approval__hint"
            data-testid="record-approval-templates-loading"
          >{{ l('approval.templatesLoading') }}</p>
          <p
            v-else-if="templatesUnavailable"
            class="meta-approval__hint meta-approval__hint--warn"
            role="alert"
            data-testid="record-approval-templates-unavailable"
          >{{ l('approval.templatesUnavailable') }}</p>
          <div v-else class="meta-approval__row">
            <label class="meta-approval__label" :for="templateSelectId">{{ l('approval.template') }}</label>
            <p
              v-if="templatesTruncated"
              class="meta-approval__hint meta-approval__hint--warn"
              data-testid="record-approval-templates-truncated"
            >{{ truncatedNotice }}</p>
            <select
              :id="templateSelectId"
              class="meta-approval__select"
              data-testid="record-approval-template-select"
              :value="selectedTemplateId"
              @change="onSelectTemplate($event)"
            >
              <option value="">{{ l('approval.templatePlaceholder') }}</option>
              <option v-for="template in templates" :key="template.id" :value="template.id">
                {{ template.name || template.id }}
              </option>
            </select>
          </div>

          <p
            v-if="formLoading"
            class="meta-approval__hint"
            data-testid="record-approval-form-loading"
          >{{ l('approval.formLoading') }}</p>
          <p
            v-else-if="formLoadFailed"
            class="meta-approval__hint meta-approval__hint--warn"
            role="alert"
            data-testid="record-approval-form-error"
          >{{ l('approval.formLoadFailed') }}</p>

          <p
            v-if="formHasLoaded && templateDraftPending"
            class="meta-approval__hint meta-approval__hint--warn"
            role="alert"
            data-testid="record-approval-template-draft-notice"
          >{{ l('approval.templateDraftPending') }}</p>

          <div v-if="formHasLoaded && selectedTemplateId" class="meta-approval__fields">
            <div v-for="field in formFields" :key="field.id" class="meta-approval__row">
              <label class="meta-approval__label" :for="fieldControlId(field.id)">
                {{ field.label }}
                <span v-if="field.required" class="meta-approval__required" :title="l('approval.requiredMark')">*</span>
              </label>
              <textarea
                v-if="renderKind(field) === 'textarea'"
                :id="fieldControlId(field.id)"
                class="meta-approval__control"
                :data-testid="`record-approval-field-${field.id}`"
                :placeholder="field.placeholder"
                :value="stringDraft(field.id)"
                @input="setDraft(field.id, ($event.target as HTMLTextAreaElement).value)"
              ></textarea>
              <select
                v-else-if="renderKind(field) === 'select'"
                :id="fieldControlId(field.id)"
                class="meta-approval__control"
                :data-testid="`record-approval-field-${field.id}`"
                :value="stringDraft(field.id)"
                @change="setDraft(field.id, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">{{ l('approval.templatePlaceholder') }}</option>
                <option v-for="option in field.options ?? []" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
              <input
                v-else-if="renderKind(field) === 'checkbox'"
                :id="fieldControlId(field.id)"
                type="checkbox"
                class="meta-approval__control meta-approval__control--checkbox"
                :data-testid="`record-approval-field-${field.id}`"
                :checked="booleanDraft(field.id)"
                @change="setDraft(field.id, ($event.target as HTMLInputElement).checked)"
              />
              <input
                v-else-if="renderKind(field) !== 'unsupported'"
                :id="fieldControlId(field.id)"
                :type="renderKind(field) === 'number' ? 'number' : renderKind(field) === 'date' ? 'date' : 'text'"
                class="meta-approval__control"
                :data-testid="`record-approval-field-${field.id}`"
                :placeholder="field.placeholder"
                :value="stringDraft(field.id)"
                @input="setDraft(field.id, ($event.target as HTMLInputElement).value)"
              />
              <!-- `id` matters: the row's <label for> above points here, and an unsupported field has no
                   control of its own — without it the label referenced nothing at all. -->
              <span
                v-else
                :id="fieldControlId(field.id)"
                class="meta-approval__hint meta-approval__hint--warn"
                :data-testid="`record-approval-field-unsupported-${field.id}`"
              >{{ field.type }}</span>
            </div>
          </div>

          <p
            v-if="hasUnsupportedField"
            class="meta-approval__hint meta-approval__hint--warn"
            role="alert"
            data-testid="record-approval-unsupported-notice"
          >{{ l('approval.unsupportedField') }}</p>
          <p
            v-else-if="selectedTemplateId && !formLoading && !formLoadFailed && missingRequired"
            class="meta-approval__hint"
            data-testid="record-approval-required-notice"
          >{{ l('approval.requiredMissing') }}</p>

          <p
            v-if="inFlightNotice"
            class="meta-approval__hint meta-approval__hint--warn"
            role="alert"
            data-testid="record-approval-in-flight-notice"
          >
            {{ l('approval.inFlight') }}
            <span v-if="inFlightNotice.requestNo" data-testid="record-approval-in-flight-request-no">{{ inFlightNotice.requestNo }}</span>
            <RouterLink
              v-if="hasRouter && inFlightNotice.approvalInstanceId"
              class="meta-approval__link"
              data-testid="record-approval-in-flight-link"
              :to="{ name: 'approval-detail', params: { id: inFlightNotice.approvalInstanceId } }"
            >{{ l('approval.viewInstance') }}</RouterLink>
          </p>
          <p
            v-else-if="submitError"
            class="meta-approval__hint meta-approval__hint--warn"
            role="alert"
            data-testid="record-approval-submit-error"
          >{{ submitError }}</p>
        </div>

        <div class="meta-approval__actions">
          <MtButton class="meta-approval__btn" @click="onCancel">{{ l('approval.cancel') }}</MtButton>
          <MtButton
            class="meta-approval__btn meta-approval__btn--primary"
            variant="primary"
            :disabled="!canSubmit"
            data-testid="record-approval-submit"
            @click="onSubmit"
          >{{ submitting ? l('approval.submitting') : l('approval.submit') }}</MtButton>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, ref, useId, watch } from 'vue'
import { RouterLink, routerKey } from 'vue-router'
import { useLocale } from '../../composables/useLocale'
import {
  recordApprovalErrorLabel,
  recordApprovalTemplatesTruncatedNotice,
  recordLabel,
  type MetaRecordLabelKey,
} from '../utils/meta-record-labels'
import { MtButton, MtIconButton } from '../ui'
import {
  isRecordApprovalInFlightError,
  RECORD_APPROVAL_TEMPLATE_PAGE_SIZE,
  type MultitableApiClient,
} from '../api/client'
import type {
  MetaApprovalFormField,
  MetaApprovalTemplateSummary,
  MetaRecordApprovalSubmission,
} from '../types'

const props = defineProps<{
  visible: boolean
  sheetId: string
  recordId: string
  /** The workbench's live client, forwarded by MetaRecordInspector. Never the module singleton. */
  client: MultitableApiClient
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'submitted', submission: MetaRecordApprovalSubmission): void
}>()

const { isZh } = useLocale()
const l = (key: MetaRecordLabelKey) => recordLabel(key, isZh.value)
// Same (non-throwing `inject`) idiom MetaRecordInspector uses: several frozen drawer specs mount this
// tree with no router installed, so the instance link is rendered only when a router really exists.
const hasRouter = !!inject(routerKey, null)

const templateSelectId = `meta-approval-template-${useId()}`
const fieldControlId = (fieldId: string) => `${templateSelectId}-${fieldId}`

const templates = ref<MetaApprovalTemplateSummary[]>([])
const templatesLoading = ref(false)
const templatesUnavailable = ref(false)
const selectedTemplateId = ref('')
const formFields = ref<MetaApprovalFormField[]>([])
const formLoading = ref(false)
const formLoadFailed = ref(false)
// Ids only (never a schema): the read serves the LATEST version's form while the server validates the
// ACTIVE published one, so a difference means the form on screen is not the form that will be checked.
const formActiveVersionId = ref<string | undefined>(undefined)
const formLatestVersionId = ref<string | undefined>(undefined)
const modalRef = ref<HTMLElement | null>(null)
let previouslyFocused: HTMLElement | null = null
const drafts = ref<Record<string, string | boolean>>({})
const submitting = ref(false)
const submitError = ref<string | null>(null)
const inFlightNotice = ref<{ requestNo?: string; approvalInstanceId?: string } | null>(null)

// Stale-response guard, same closure-counter discipline as MetaRecordProvenancePanel: a load that
// settles after the dialog closed (or after the actor picked another template) must not write state.
let activeLoadVersion = 0

type RenderKind = 'text' | 'textarea' | 'number' | 'select' | 'date' | 'checkbox' | 'unsupported'

// The wire vocabulary is not one vocabulary: the approval template authoring UI emits `textarea`, older
// / hand-authored schemas say `longText`, `long_text`, `string`, `boolean`. Fold case and separators,
// then map — anything left over is UNSUPPORTED (refuse, never coerce into a text box).
const RENDER_KINDS: Record<string, RenderKind> = {
  text: 'text',
  string: 'text',
  longtext: 'textarea',
  textarea: 'textarea',
  number: 'number',
  select: 'select',
  date: 'date',
  checkbox: 'checkbox',
  boolean: 'checkbox',
}

function renderKind(field: MetaApprovalFormField): RenderKind {
  const key = String(field.type ?? '').trim().toLowerCase().replace(/[-_\s]/g, '')
  const kind = RENDER_KINDS[key]
  if (!kind) return 'unsupported'
  // A `select` with no options is not renderable as a picker — treat it as unsupported rather than
  // showing an empty dropdown the actor can never satisfy.
  if (kind === 'select' && !(field.options && field.options.length > 0)) return 'unsupported'
  return kind
}

const formHasLoaded = computed(() => Boolean(selectedTemplateId.value) && !formLoading.value && !formLoadFailed.value)

const templatesTruncated = computed(() => templates.value.length >= RECORD_APPROVAL_TEMPLATE_PAGE_SIZE)
const truncatedNotice = computed(() => recordApprovalTemplatesTruncatedNotice(templates.value.length, isZh.value))

const templateDraftPending = computed(() => Boolean(
  formActiveVersionId.value
  && formLatestVersionId.value
  && formActiveVersionId.value !== formLatestVersionId.value,
))

const hasUnsupportedField = computed(() => formFields.value.some((field) => renderKind(field) === 'unsupported'))

const missingRequired = computed(() => formFields.value.some((field) => {
  if (!field.required) return false
  const value = drafts.value[field.id]
  if (renderKind(field) === 'checkbox') return value !== true
  return typeof value !== 'string' || value.trim().length === 0
}))

const canSubmit = computed(() => Boolean(
  selectedTemplateId.value
  && !templatesLoading.value
  && !templatesUnavailable.value
  && !formLoading.value
  && !formLoadFailed.value
  && !hasUnsupportedField.value
  && !missingRequired.value
  && !submitting.value,
))

function stringDraft(fieldId: string): string {
  const value = drafts.value[fieldId]
  return typeof value === 'string' ? value : ''
}

function booleanDraft(fieldId: string): boolean {
  return drafts.value[fieldId] === true
}

function setDraft(fieldId: string, value: string | boolean): void {
  drafts.value = { ...drafts.value, [fieldId]: value }
}

function resetFormState(): void {
  formFields.value = []
  formLoading.value = false
  formLoadFailed.value = false
  formActiveVersionId.value = undefined
  formLatestVersionId.value = undefined
  drafts.value = {}
  submitError.value = null
  inFlightNotice.value = null
}

watch(() => props.visible, (open) => {
  activeLoadVersion += 1
  if (!open) {
    submitting.value = false
    // Focus goes back where it came from (the kebab item), never to document.body.
    previouslyFocused?.focus()
    previouslyFocused = null
    return
  }
  previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  void nextTick(() => modalRef.value?.focus())
  templates.value = []
  templatesUnavailable.value = false
  selectedTemplateId.value = ''
  submitting.value = false
  resetFormState()
  void loadTemplates()
}, { immediate: true })

async function loadTemplates(): Promise<void> {
  const loadVersion = ++activeLoadVersion
  templatesLoading.value = true
  try {
    // status is a SERVER filter (design §5.1) — never a client-side narrowing of an unfiltered roster.
    // pageSize is the route's ceiling: its DEFAULT is 20, which would silently truncate the picker (there
    // is no paging and, by design, no free-text id fallback here). `templatesTruncated` says so if even
    // the ceiling fills up.
    const result = await props.client.listApprovalTemplates({
      status: 'published',
      pageSize: RECORD_APPROVAL_TEMPLATE_PAGE_SIZE,
    })
    if (loadVersion !== activeLoadVersion) return
    templates.value = result.data
    // Empty roster and "you may not read templates" are the SAME user-facing state by design: one
    // notice, no free-text id input.
    templatesUnavailable.value = result.data.length === 0
  } catch {
    if (loadVersion !== activeLoadVersion) return
    templates.value = []
    templatesUnavailable.value = true
  } finally {
    if (loadVersion === activeLoadVersion) templatesLoading.value = false
  }
}

function onSelectTemplate(event: Event): void {
  const templateId = (event.target as HTMLSelectElement).value
  selectedTemplateId.value = templateId
  resetFormState()
  if (templateId) void loadTemplateForm(templateId)
}

async function loadTemplateForm(templateId: string): Promise<void> {
  const loadVersion = ++activeLoadVersion
  formLoading.value = true
  formLoadFailed.value = false
  try {
    const detail = await props.client.getApprovalTemplate(templateId)
    if (loadVersion !== activeLoadVersion) return
    formFields.value = detail.formFields
    formActiveVersionId.value = detail.activeVersionId
    formLatestVersionId.value = detail.latestVersionId
    drafts.value = {}
  } catch {
    if (loadVersion !== activeLoadVersion) return
    formFields.value = []
    formLoadFailed.value = true
  } finally {
    if (loadVersion === activeLoadVersion) formLoading.value = false
  }
}

function buildFormData(): Record<string, unknown> {
  const formData: Record<string, unknown> = {}
  for (const field of formFields.value) {
    const kind = renderKind(field)
    const value = drafts.value[field.id]
    if (kind === 'checkbox') {
      formData[field.id] = value === true
      continue
    }
    if (typeof value !== 'string' || value.trim().length === 0) continue
    if (kind === 'number') {
      const parsed = Number(value)
      // A non-numeric string in a number box goes over as-is: the server owns validation, and silently
      // sending NaN (or dropping the field) would turn a typo into an invisible data loss.
      formData[field.id] = Number.isFinite(parsed) ? parsed : value
      continue
    }
    formData[field.id] = value
  }
  return formData
}

async function onSubmit(): Promise<void> {
  if (!canSubmit.value) return
  submitting.value = true
  submitError.value = null
  inFlightNotice.value = null
  try {
    const submission = await props.client.submitRecordApproval(props.sheetId, props.recordId, {
      templateId: selectedTemplateId.value,
      formData: buildFormData(),
    })
    emit('submitted', submission)
  } catch (error) {
    if (isRecordApprovalInFlightError(error)) {
      inFlightNotice.value = {
        ...(error.requestNo ? { requestNo: error.requestNo } : {}),
        ...(error.approvalInstanceId ? { approvalInstanceId: error.approvalInstanceId } : {}),
      }
    } else {
      // The route's refusals are fixed ENGLISH sentences ('Insufficient permissions', 'Approval template
      // is not published', …) which the shared client surfaces verbatim — render them by CODE instead. An
      // UNKNOWN code still shows the server text (better than a generic sentence for an unexpected
      // failure), and a codeless failure falls back to the generic one.
      const code = (error as { code?: string })?.code
      submitError.value = recordApprovalErrorLabel(code, isZh.value)
        ?? (error as Error)?.message
        ?? l('approval.submitFailed')
    }
  } finally {
    submitting.value = false
  }
}

function onCancel(): void {
  emit('close')
}

// `aria-modal="true"` is a PROMISE to assistive tech: focus is inside, Tab stays inside, Esc gets out.
// Ported from AttendanceSetupTemplatePrefillDialog.vue (the repo's worked example) rather than left as a
// bare attribute — the dialog is teleported to <body>, so without this focus sits on body and Tab walks
// the workbench behind the overlay.
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    // Stop here: the inspector's own Escape handler closes the whole drawer, and Esc in a modal must
    // close the modal only.
    event.stopPropagation()
    emit('close')
    return
  }
  if (event.key !== 'Tab') return
  const modal = modalRef.value
  if (!modal) return
  const focusable = Array.from(modal.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
  if (focusable.length === 0) {
    event.preventDefault()
    modal.focus()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = document.activeElement
  const activeInModal = active instanceof HTMLElement && modal.contains(active) && active !== modal
  if (event.shiftKey) {
    if (!activeInModal || active === first) {
      event.preventDefault()
      last.focus()
    }
  } else if (!activeInModal || active === last) {
    event.preventDefault()
    first.focus()
  }
}
</script>

<style scoped>
.meta-approval-overlay { position: fixed; inset: 0; z-index: 110; background: rgba(0,0,0,.3); display: flex; align-items: center; justify-content: center; }
.meta-approval-modal { background: #fff; border-radius: 6px; min-width: 420px; max-width: 540px; box-shadow: 0 10px 40px rgba(0,0,0,.18); display: flex; flex-direction: column; max-height: 80vh; }
.meta-approval__header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #ebedf0; }
.meta-approval__body { padding: 16px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
.meta-approval__fields { display: flex; flex-direction: column; gap: 12px; }
.meta-approval__row { display: flex; flex-direction: column; gap: 6px; }
.meta-approval__label { font-size: 12px; color: #909399; }
.meta-approval__required { color: #f56c6c; margin-left: 2px; }
.meta-approval__select, .meta-approval__control { border: 1px solid #dcdfe6; border-radius: 4px; padding: 6px 8px; font-size: 14px; }
.meta-approval__control--checkbox { align-self: flex-start; padding: 0; }
.meta-approval__hint { font-size: 13px; margin: 0; color: #909399; }
.meta-approval__hint--warn { color: #e6a23c; }
.meta-approval__link { margin-left: 8px; color: var(--ms-color-primary, #409eff); }
.meta-approval__actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid #ebedf0; }
</style>
