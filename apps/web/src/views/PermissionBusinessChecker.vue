<template>
  <div data-testid="permission-business-checker" class="permission-business">
    <p class="permission-business__hint">只检查当前选中的成员。换人或改条件后，上一份结果会丢掉。</p>
    <div class="permission-business__row">
      <select
        v-model="policyId"
        class="permission-business__select"
        data-testid="permission-business-policy"
        aria-label="选择业务或资源检查"
      >
        <option value="">请选择检查项</option>
        <optgroup label="业务">
          <option
            v-for="policy in guardPolicies"
            :key="policy.policyId"
            :value="policy.policyId"
          >
            {{ policy.label }}
          </option>
        </optgroup>
        <optgroup label="资源">
          <option
            v-for="policy in resourcePolicies"
            :key="policy.policyId"
            :value="policy.policyId"
          >
            {{ policy.label }}
          </option>
        </optgroup>
      </select>
      <button
        class="permission-business__button"
        type="button"
        data-testid="permission-business-run"
        :disabled="!canSubmit"
        @click="void runBusinessCheck()"
      >
        检查这项
      </button>
    </div>
    <p
      v-if="selectedPolicy && selectedPolicy.kind === 'resource' && selectedPolicy.note"
      class="permission-business__hint"
      data-testid="permission-business-note"
    >
      {{ selectedPolicy.note }}
    </p>
    <div v-if="resourceFields.length > 0" class="permission-business__fields">
      <p class="permission-business__hint">标识会去掉首尾空格。长度 1 到 128，只含字母、数字和 _ . : -。标识不会被当成链接。</p>
      <label v-for="field in resourceFields" :key="field" class="permission-business__field">
        <span>{{ fieldLabels[field] }}</span>
        <input
          v-model="resourceIds[field]"
          class="permission-business__input"
          type="text"
          autocomplete="off"
          spellcheck="false"
          :data-testid="`permission-business-${field}`"
        >
      </label>
      <p v-if="resourceIssue" class="permission-business__issue" data-testid="permission-business-id-issue">{{ resourceIssue }}</p>
    </div>
    <p
      v-if="view.phase !== 'idle'"
      data-testid="permission-business-result"
      :data-phase="view.phase"
      class="permission-business__result"
      role="status"
      aria-live="polite"
    >
      {{ view.detail }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import { apiFetch } from '../utils/api'
import {
  BUSINESS_CHECK_ENDPOINT,
  BUSINESS_CHECK_POLICIES,
  RESOURCE_FIELD_LABELS,
  buildBusinessCheckRequest,
  businessCheckConditionKey,
  businessCheckStillCurrent,
  businessCheckTransportView,
  findBusinessCheckPolicy,
  idleBusinessCheckView,
  normalizeResourceId,
  pendingBusinessCheckView,
  readBusinessCheckResponse,
  type BusinessCheckView,
  type ResourceIdField,
  type ResourceIdInput,
} from './permissionBusinessChecker'

const props = defineProps<{ userId: string }>()

const policyId = ref('')
const view = ref<BusinessCheckView>(idleBusinessCheckView())
const resourceIds = reactive<Record<ResourceIdField, string>>({
  baseId: '',
  sheetId: '',
  viewId: '',
  recordId: '',
  fieldId: '',
})
const fieldLabels = RESOURCE_FIELD_LABELS
const guardPolicies = BUSINESS_CHECK_POLICIES.filter((policy) => policy.kind === 'guard')
const resourcePolicies = BUSINESS_CHECK_POLICIES.filter((policy) => policy.kind === 'resource')

let generation = 0
let disposed = false
let abortController: AbortController | null = null

const selectedPolicy = computed(() => findBusinessCheckPolicy(policyId.value))
const resourceFields = computed(() => (
  selectedPolicy.value?.kind === 'resource' ? selectedPolicy.value.resourceFields : []
))
const idInput = computed<ResourceIdInput>(() => ({
  baseId: resourceIds.baseId,
  sheetId: resourceIds.sheetId,
  viewId: resourceIds.viewId,
  recordId: resourceIds.recordId,
  fieldId: resourceIds.fieldId,
}))
const canSubmit = computed(() => buildBusinessCheckRequest(props.userId, policyId.value, idInput.value) !== null)
const resourceIssue = computed(() => {
  const policy = selectedPolicy.value
  if (!policy || policy.kind !== 'resource') return ''
  let missing = false
  let invalid = false
  for (const field of policy.resourceFields) {
    const raw = resourceIds[field]
    if (raw.trim() === '') missing = true
    else if (!normalizeResourceId(raw)) invalid = true
  }
  if (invalid) return '有标识不符合格式，这次不能提交。'
  if (missing) return '请填写这项检查需要的全部标识。'
  return ''
})

function invalidate(): void {
  generation += 1
  abortController?.abort()
  abortController = null
  view.value = idleBusinessCheckView()
}

function clearResourceIds(): void {
  resourceIds.baseId = ''
  resourceIds.sheetId = ''
  resourceIds.viewId = ''
  resourceIds.recordId = ''
  resourceIds.fieldId = ''
}

watch(() => props.userId, () => {
  invalidate()
})

watch(policyId, () => {
  clearResourceIds()
  invalidate()
})

watch(idInput, () => {
  invalidate()
})

onUnmounted(() => {
  disposed = true
  invalidate()
})

async function runBusinessCheck(): Promise<void> {
  const requestedUserId = props.userId
  const requestedPolicyId = policyId.value
  const requestedIds: ResourceIdInput = { ...idInput.value }
  const body = buildBusinessCheckRequest(requestedUserId, requestedPolicyId, requestedIds)
  const policy = findBusinessCheckPolicy(requestedPolicyId)
  if (!body || !policy) return
  const startedKey = businessCheckConditionKey(requestedPolicyId, requestedIds)
  abortController?.abort()
  generation += 1
  const startedGeneration = generation
  const controller = new AbortController()
  abortController = controller
  view.value = pendingBusinessCheckView(policy.label)
  const stillCurrent = () => !disposed && businessCheckStillCurrent({
    startedGeneration,
    currentGeneration: generation,
    startedUserId: requestedUserId,
    currentUserId: props.userId,
    startedKey,
    currentKey: businessCheckConditionKey(policyId.value, idInput.value),
  })
  try {
    const response = await apiFetch(BUSINESS_CHECK_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    let payload: unknown = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    if (!stillCurrent()) return
    view.value = readBusinessCheckResponse({
      httpStatus: response.status,
      payload,
      requestedPolicyId,
    })
  } catch {
    if (!stillCurrent() || controller.signal.aborted) return
    view.value = businessCheckTransportView(policy.label)
  }
}
</script>

<style scoped>
.permission-business {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.permission-business__row,
.permission-business__fields {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.permission-business__fields {
  align-items: stretch;
  flex-direction: column;
}

.permission-business__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  color: #334155;
  font-size: 14px;
}

.permission-business__select,
.permission-business__input {
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  padding: 10px 12px;
  font: inherit;
  min-width: 0;
  max-width: 100%;
}

.permission-business__button {
  border: none;
  border-radius: 10px;
  background: #2563eb;
  color: #fff;
  padding: 10px 14px;
  cursor: pointer;
  font: inherit;
}

.permission-business__button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.permission-business__hint,
.permission-business__issue,
.permission-business__result {
  margin: 0;
  overflow-wrap: anywhere;
}

.permission-business__hint,
.permission-business__issue {
  color: #64748b;
}

.permission-business__issue {
  color: #b45309;
}

.permission-business__result {
  color: #0f172a;
}

.permission-business__result[data-phase='error'],
.permission-business__result[data-phase='forbidden'],
.permission-business__result[data-phase='unavailable'],
.permission-business__result[data-phase='missing'],
.permission-business__result[data-phase='unknown'],
.permission-business__result[data-phase='deny'] {
  color: #b45309;
}
</style>
