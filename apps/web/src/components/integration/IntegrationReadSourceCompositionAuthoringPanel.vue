<template>
  <div class="integration-read-source-composition-authoring" data-testid="read-source-composition-authoring-panel">
    <p class="integration-read-source-composition-authoring__hint" data-testid="rscauth-boundary">
      配置面(authoring)——运行在运行面板;只读链;不含任何写路径。
      顾问/管理员在这里选择两个已审批的 resolver_lookup 读取源,组装成一条两跳读取组合:
      第一跳的解析输出作为第二跳的业务 key。保存后需审批,运行时才可选用;停用后运行时立即不可选用。
    </p>

    <div class="integration-read-source-composition-authoring__columns">
      <div class="integration-read-source-composition-authoring__form" data-testid="rscauth-form">
        <h3>新建组合</h3>

        <label class="integration-read-source-composition-authoring__field">
          <el-tooltip :content="fieldHint('composition.step1ConfigId')" placement="top" data-testid="rscauth-hint-step1">
            <span>第一跳读取源(已审批 resolver_lookup)</span>
          </el-tooltip>
          <select v-model="draft.step1ConfigId" data-testid="rscauth-step1">
            <option value="">请选择第一跳读取源…</option>
            <option v-for="row in resolverConfigs" :key="row.id" :value="row.id">
              {{ row.id }} · {{ row.object }}
            </option>
          </select>
        </label>

        <label class="integration-read-source-composition-authoring__field">
          <el-tooltip :content="fieldHint('composition.step2ConfigId')" placement="top" data-testid="rscauth-hint-step2">
            <span>第二跳读取源(已审批 resolver_lookup)</span>
          </el-tooltip>
          <select v-model="draft.step2ConfigId" data-testid="rscauth-step2">
            <option value="">请选择第二跳读取源…</option>
            <option v-for="row in resolverConfigs" :key="row.id" :value="row.id">
              {{ row.id }} · {{ row.object }}
            </option>
          </select>
        </label>

        <label class="integration-read-source-composition-authoring__field">
          <el-tooltip :content="fieldHint('composition.name')" placement="top" data-testid="rscauth-hint-name">
            <span>name(组合标识符)</span>
          </el-tooltip>
          <input v-model="draft.name" data-testid="rscauth-name" placeholder="material_to_bom_v1" />
        </label>

        <label class="integration-read-source-composition-authoring__field">
          <el-tooltip :content="fieldHint('composition.sourceTarget')" placement="top" data-testid="rscauth-hint-source-target">
            <span>sourceTarget(第一跳输出字段名,交接给第二跳作为 key)</span>
          </el-tooltip>
          <input v-model="draft.sourceTarget" data-testid="rscauth-source-target" placeholder="internal_id" />
        </label>

        <ul v-if="draftProblems.length > 0" class="integration-read-source-composition-authoring__problems" data-testid="rscauth-draft-problems">
          <li v-for="problem in draftProblems" :key="problem">{{ problem }}</li>
        </ul>

        <p v-if="!canWrite" class="integration-read-source-composition-authoring__hint integration-read-source-composition-authoring__hint--strong" data-testid="rscauth-permission-hint">
          当前用户只有只读权限,不能保存 / 审批 / 停用组合(需要 integration:write)。
        </p>

        <div class="integration-read-source-composition-authoring__actions">
          <button
            type="button"
            class="integration-workbench__button"
            data-testid="rscauth-refresh"
            :disabled="pickerLoading"
            @click="refreshPickers"
          >{{ pickerLoading ? '加载中…' : '刷新读取源列表' }}</button>
          <button
            type="button"
            class="integration-workbench__button"
            data-testid="rscauth-save"
            :disabled="!canSave"
            @click="save"
          >{{ saving ? '保存中…' : '保存组合版本' }}</button>
        </div>

        <p v-if="pickerError" class="integration-read-source-composition-authoring__error" data-testid="rscauth-picker-error">{{ pickerError }}</p>
        <div
          v-if="!pickerLoading && resolverConfigs.length === 0"
          class="integration-read-source-composition-authoring__empty integration-read-source-composition-authoring__empty--guided"
          data-testid="rscauth-empty"
        >
          <strong data-testid="rscauth-empty-what">{{ bi(
            '这里把两个已审批的"解析定位"读取源组装成一条两跳链，用于从一个业务键派生到另一个关联记录。',
            'This assembles two APPROVED resolver-lookup read sources into a two-hop chain, deriving one linked record from a business key.',
          ) }}</strong>
          <p data-testid="rscauth-empty-first-step">{{ bi(
            '第一步：请先在上方"读取源配置"面板配置并审批两个 resolver_lookup 读取源，审批后即可在这里选用。',
            'First step: configure and approve two resolver_lookup read sources in the "read-source config" panel above — once approved, they become selectable here.',
          ) }}</p>
        </div>

        <p v-if="actionError" class="integration-read-source-composition-authoring__error" data-testid="rscauth-error">{{ actionError }}</p>

        <ul v-if="saveFieldErrors.length > 0" class="integration-read-source-composition-authoring__problems" data-testid="rscauth-field-errors">
          <li v-for="(entry, index) in saveFieldErrors" :key="index">{{ entry.code }} · {{ entry.field }} · {{ entry.reason }}</li>
        </ul>
      </div>

      <div v-if="savedRow" class="integration-read-source-composition-authoring__saved" data-testid="rscauth-saved">
        <h4>已保存组合</h4>
        <p>
          id: {{ savedRow.id }} · v{{ savedRow.version }} · status: {{ statusLabel(savedRow.status) }}
          · {{ savedRow.reused ? '复用已有版本' : '新版本' }}
        </p>
        <div class="integration-read-source-composition-authoring__row-actions">
          <button
            v-if="savedRow.status === 'draft'"
            type="button"
            class="integration-workbench__button"
            data-testid="rscauth-approve"
            :disabled="!canApprove"
            @click="approve"
          >{{ approving ? '审批中…' : '审批' }}</button>
          <button
            v-if="savedRow.status === 'approved'"
            type="button"
            class="integration-workbench__button"
            data-testid="rscauth-retire"
            :disabled="!canRetire"
            @click="retire"
          >{{ retiring ? '停用中…' : '停用' }}</button>
          <button
            type="button"
            class="integration-workbench__button"
            data-testid="rscauth-audit-toggle"
            :disabled="auditLoading"
            @click="toggleAudit"
          >{{ auditOpen ? '收起审计' : (auditLoading ? '加载中…' : '审计') }}</button>
        </div>

        <ul v-if="auditOpen" class="integration-read-source-composition-authoring__audit" data-testid="rscauth-audit">
          <li v-if="auditRows.length === 0">暂无审计记录。</li>
          <li v-for="(entry, index) in auditRows" :key="index">
            {{ auditActionLabel(entry.action) }} · {{ entry.actor || '(unknown)' }}<template v-if="entry.detail.from || entry.detail.to"> · {{ entry.detail.from }} → {{ entry.detail.to }}</template> · {{ entry.createdAt || '' }}
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// Read-source resolver composition — authoring-tier panel (C-R4-4, #1709). Consultant/admin config-time
// UI over the C-R4-3a authoring service layer, replacing the API-only Phase 1 flow in the entity runbook
// (docs/development/integration-composition-entity-e2e-runbook-20260705.md). Client-only: picks two
// APPROVED resolver_lookup read-source configs, wires step 1's resolved output to step 2's key, and
// exposes save/approve/retire/audit. It never builds the wire payload itself — every request goes
// through the shared service functions (buildReadSourceCompositionPayload is used ONLY inside
// saveReadSourceCompositionVersion), so a draft can never smuggle an extra field into the body. Every
// write action (save/approve/retire) is gated on the SAME integration:write permission idiom the
// workbench uses for its other write-tier actions (see IntegrationWorkbenchView.vue
// externalWriteCanApply / applyExternalWrite / applyTableAction: disabled computed + handler-level
// guard, auth.hasPermission('integration:write')) — list/audit stay read-tier and ungated, mirroring the
// server's requireAccess('read') vs requireAccess('write') split in read-source-compositions HTTP routes.
import { computed, reactive, ref, watch } from 'vue'
import { useAuth } from '../../composables/useAuth'
import { useLocale } from '../../composables/useLocale'
import { integrationFieldHint, type IntegrationFieldHintKey } from '../../services/integration/fieldHints'
import type { IntegrationScope } from '../../services/integration/workbench'
import { listReadSourceConfigs, ReadSourceApiError, type ReadSourceConfigRow } from '../../services/integration/readSourceConfigs'
import {
  approveReadSourceComposition,
  createReadSourceCompositionDraft,
  listReadSourceCompositionAudit,
  retireReadSourceComposition,
  saveReadSourceCompositionVersion,
  validateReadSourceCompositionDraft,
  ReadSourceCompositionApiError,
  type CompositionStatus,
  type ReadSourceCompositionAuditRow,
  type ReadSourceCompositionFieldError,
  type ReadSourceCompositionSaveResult,
} from '../../services/integration/readSourceCompositions'

const props = defineProps<{
  scope: IntegrationScope
}>()

const auth = useAuth()
const { locale } = useLocale()

// IU-6b: field-level hint copy (values-free, zh+en) for the composition step-wiring fields —
// exact-key lookup against the dedicated fieldHints module (shared with the read-source config panel).
function fieldHint(key: IntegrationFieldHintKey): string {
  return integrationFieldHint(key, locale.value)
}

// IU-6a: bilingual guidance copy helper — same locale pattern as `fieldHint` above.
function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}
// Same permission the server requires for save/approve/retire (requireAccess(req, 'write') in
// readSourceCompositionsSave/Approve/Retire) and the same string the workbench's other apply-tier
// actions gate on (dry-run=read · apply=write/admin badge).
const canWrite = computed(() => auth.hasPermission('integration:write'))

const draft = reactive(createReadSourceCompositionDraft())
// Panel-level default (not the bare service factory default): the runbook's proven two-hop shape names
// the handoff field internal_id.
draft.sourceTarget = 'internal_id'

const resolverConfigs = ref<ReadSourceConfigRow[]>([])
const pickerLoading = ref(false)
const pickerError = ref('')

const saving = ref(false)
const savedRow = ref<ReadSourceCompositionSaveResult | null>(null)
const actionError = ref('')
const saveFieldErrors = ref<ReadSourceCompositionFieldError[]>([])

const approving = ref(false)
const retiring = ref(false)

const auditOpen = ref(false)
const auditLoading = ref(false)
const auditRows = ref<ReadSourceCompositionAuditRow[]>([])

const draftProblems = computed(() => validateReadSourceCompositionDraft(draft))
const canSave = computed(() => !saving.value && canWrite.value && draftProblems.value.length === 0)
const canApprove = computed(() => !approving.value && canWrite.value)
const canRetire = computed(() => !retiring.value && canWrite.value)

// Any draft edit invalidates the previously saved row's relevance — a consultant editing the form is
// composing a DIFFERENT composition, so its stale approve/retire/audit surface must not linger.
watch(draft, () => {
  savedRow.value = null
  actionError.value = ''
  saveFieldErrors.value = []
})

watch(savedRow, () => {
  auditOpen.value = false
  auditRows.value = []
})

function statusLabel(status: CompositionStatus): string {
  if (status === 'approved') return '已审批'
  if (status === 'retired') return '已停用'
  return '草稿'
}

function auditActionLabel(action: ReadSourceCompositionAuditRow['action']): string {
  if (action === 'save_version') return '保存新版本'
  if (action === 'reuse_version') return '复用已有版本'
  return '状态变更'
}

function coarseErrorMessage(error: unknown): string {
  if (error instanceof ReadSourceCompositionApiError || error instanceof ReadSourceApiError) return error.message
  return '组合配置请求失败'
}

async function refreshPickers(): Promise<void> {
  pickerLoading.value = true
  pickerError.value = ''
  try {
    const rows = await listReadSourceConfigs(props.scope, { status: 'approved' })
    resolverConfigs.value = rows.filter((row) => row.mode === 'resolver_lookup')
  } catch (error) {
    pickerError.value = coarseErrorMessage(error)
  } finally {
    pickerLoading.value = false
  }
}

// Request-id + draft-signature stale guard (mirrors IntegrationWorkbenchView.vue's
// isCurrentStockPreparationTargetRequest idiom): a save's response is applied ONLY when no newer save
// started AND the draft that produced it still matches the current form — if the consultant changes a
// picker selection while the save is in flight, the eventual response describes a composition that no
// longer matches the visible form, so it must be dropped rather than rendered as the saved row.
let saveRequestId = 0
function currentDraftSignature(): string {
  return JSON.stringify({
    name: draft.name,
    step1ConfigId: draft.step1ConfigId,
    step2ConfigId: draft.step2ConfigId,
    sourceTarget: draft.sourceTarget,
  })
}
function isCurrentSaveRequest(requestId: number, signature: string): boolean {
  return requestId === saveRequestId && currentDraftSignature() === signature
}

async function save(): Promise<void> {
  if (!canWrite.value) {
    actionError.value = '当前用户没有 write 权限,不能保存组合草稿。'
    return
  }
  if (draftProblems.value.length > 0) return
  actionError.value = ''
  saveFieldErrors.value = []
  const signature = currentDraftSignature()
  const requestId = ++saveRequestId
  saving.value = true
  try {
    // The wire payload is built ENTIRELY inside saveReadSourceCompositionVersion
    // (buildReadSourceCompositionPayload) — this component never assembles the request body itself, so
    // no field beyond the four named draft properties can ever ride into { config }.
    const result = await saveReadSourceCompositionVersion(draft, props.scope)
    if (!isCurrentSaveRequest(requestId, signature)) return
    savedRow.value = result
  } catch (error) {
    if (!isCurrentSaveRequest(requestId, signature)) return
    if (error instanceof ReadSourceCompositionApiError) {
      actionError.value = coarseErrorMessage(error)
      saveFieldErrors.value = error.fieldErrors
    } else {
      actionError.value = coarseErrorMessage(error)
    }
  } finally {
    if (requestId === saveRequestId) saving.value = false
  }
}

async function approve(): Promise<void> {
  const row = savedRow.value
  if (!row) return
  if (!canWrite.value) {
    actionError.value = '当前用户没有 write 权限,不能审批组合。'
    return
  }
  if (!window.confirm(`审批后运行时即可选用该组合(${row.name || row.id} v${row.version})。确认审批?`)) return
  const id = row.id
  actionError.value = ''
  approving.value = true
  try {
    const updated = await approveReadSourceComposition(id, props.scope)
    if (savedRow.value?.id !== id) return
    if (updated) savedRow.value = { ...savedRow.value, ...updated }
  } catch (error) {
    if (savedRow.value?.id !== id) return
    actionError.value = coarseErrorMessage(error)
  } finally {
    if (savedRow.value?.id === id) approving.value = false
  }
}

async function retire(): Promise<void> {
  const row = savedRow.value
  if (!row) return
  if (!canWrite.value) {
    actionError.value = '当前用户没有 write 权限,不能停用组合。'
    return
  }
  const id = row.id
  actionError.value = ''
  retiring.value = true
  try {
    const updated = await retireReadSourceComposition(id, props.scope)
    if (savedRow.value?.id !== id) return
    if (updated) savedRow.value = { ...savedRow.value, ...updated }
  } catch (error) {
    if (savedRow.value?.id !== id) return
    actionError.value = coarseErrorMessage(error)
  } finally {
    if (savedRow.value?.id === id) retiring.value = false
  }
}

async function toggleAudit(): Promise<void> {
  if (auditOpen.value) {
    auditOpen.value = false
    return
  }
  const row = savedRow.value
  if (!row) return
  const id = row.id
  actionError.value = ''
  auditLoading.value = true
  try {
    const rows = await listReadSourceCompositionAudit(id, props.scope)
    if (savedRow.value?.id !== id) return
    auditRows.value = rows
    auditOpen.value = true
  } catch (error) {
    if (savedRow.value?.id !== id) return
    actionError.value = coarseErrorMessage(error)
  } finally {
    if (savedRow.value?.id === id) auditLoading.value = false
  }
}

void refreshPickers()
</script>

<style scoped>
.integration-read-source-composition-authoring__hint {
  color: #666;
  font-size: 13px;
  margin: 0 0 12px;
}
.integration-read-source-composition-authoring__hint--strong {
  color: #b45309;
}
.integration-read-source-composition-authoring__columns {
  display: grid;
  grid-template-columns: minmax(320px, 1fr) minmax(360px, 1.2fr);
  gap: 20px;
}
.integration-read-source-composition-authoring__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
  font-size: 13px;
}
.integration-read-source-composition-authoring__field input,
.integration-read-source-composition-authoring__field select {
  padding: 6px 8px;
  border: 1px solid #d0d0d0;
  border-radius: 4px;
}
.integration-read-source-composition-authoring__actions {
  display: flex;
  gap: 8px;
  margin: 10px 0;
}
.integration-read-source-composition-authoring__problems {
  color: #b45309;
  font-size: 12px;
  padding-left: 18px;
}
.integration-read-source-composition-authoring__error {
  color: #b91c1c;
  font-size: 13px;
}
.integration-read-source-composition-authoring__empty {
  color: #888;
  font-size: 13px;
}
/* IU-6a guided empty state: "what this is" + "first step" — new styling only, tokens per UF-1. */
.integration-read-source-composition-authoring__empty--guided {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
}
.integration-read-source-composition-authoring__empty--guided strong {
  color: var(--ms-text-1);
}
.integration-read-source-composition-authoring__empty--guided p {
  margin: 0;
}
.integration-read-source-composition-authoring__saved {
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 13px;
}
.integration-read-source-composition-authoring__row-actions {
  display: flex;
  gap: 8px;
  margin: 8px 0;
}
.integration-read-source-composition-authoring__audit {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 12px;
  color: #555;
}
@media (max-width: 960px) {
  .integration-read-source-composition-authoring__columns {
    grid-template-columns: 1fr;
  }
}
</style>
