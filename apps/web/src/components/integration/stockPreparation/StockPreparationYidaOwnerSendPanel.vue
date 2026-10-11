<template>
  <section class="sp-yida-owner" data-testid="stock-prep-yida-owner-send-panel">
    <h3>宜搭 Owner 单次创建确认</h3>
    <p>先保存服务端草稿，再核对所选行、明确授权，最后单独提交一次。当前只支持手动 CREATE；有效期最长 15 分钟。</p>
    <p data-testid="sp-yida-owner-default-off">发送默认关闭；只有服务端明确启用且核验当前 Owner 与集成管理员权限后才接受操作。本页不配置凭据或登记目标。</p>
    <p v-if="!draftInput" data-testid="sp-yida-owner-input-required">请先完成有效的协议 v2 创建预演。</p>
    <button type="button" data-testid="sp-yida-owner-save" :disabled="!draftInput || busy || !!draft || locked || disabled" @click="saveDraft">保存服务端草稿（不发送）</button>
    <p v-if="errorCode" role="alert" data-testid="sp-yida-owner-error">{{ errorCode }}</p>
    <p v-if="disabled" data-testid="sp-yida-owner-disabled">服务端发送开关关闭；未取得新的发送授权。已有授权仅可手动查看或撤销。</p>

    <section v-if="draft" data-testid="sp-yida-owner-draft">
      <p>草稿：{{ draft.operationId }}；{{ draft.rowCount }} 个服务端行成员{{ draft.reused ? '（复用既有草稿）' : '' }}。目标仍未核验，未签发发送授权。</p>
      <label>选择服务端行
        <select v-model="selectedRowKey" data-testid="sp-yida-owner-row" :disabled="busy || locked || disabled">
          <option value="">请选择</option>
          <option v-for="row in draft.rows" :key="row.rowKey" :value="row.rowKey">服务端行 {{ row.index + 1 }} · {{ row.rowKey }}</option>
        </select>
      </label>
      <button type="button" data-testid="sp-yida-owner-preview" :disabled="!selectedRowKey || busy || locked || disabled" @click="fetchPreview">读取所选行服务端预览</button>
    </section>

    <section v-if="preview" data-testid="sp-yida-owner-confirmation">
      <h4>确认此服务端目标与此行内容</h4>
      <p>身份依据：Owner 人工确认的单一目标，证据版本 {{ preview.target.evidenceVersion }}；尚非远端业务核验。</p>
      <dl data-testid="sp-yida-owner-target">
        <dt>目标引用</dt><dd>{{ preview.target.targetRef }}</dd>
        <dt>确认依据</dt><dd>{{ preview.target.reviewRef }}</dd>
        <dt>组织</dt><dd>{{ preview.target.organizationId }}</dd>
        <dt>appType</dt><dd>{{ preview.target.appType }}</dd>
        <dt>formUuid</dt><dd>{{ preview.target.formUuid }}</dd>
      </dl>
      <p>所选服务端行：{{ preview.rowKey }}</p>
      <pre data-testid="sp-yida-owner-payload">{{ JSON.stringify(preview.payload, null, 2) }}</pre>
      <p data-testid="sp-yida-owner-policy">只允许一次手动创建尝试；授权有效期最长 15 分钟。超时、发送中或结果未知时不得再次创建，应先查看持久记录。</p>
      <label><input v-model="acknowledged" type="checkbox" data-testid="sp-yida-owner-ack" :disabled="busy || locked || disabled">我已核对目标与此行内容，知悉只尝试一次及结果未知不可重试的风险。</label>
      <button type="button" data-testid="sp-yida-owner-approve" :disabled="!acknowledged || busy || !!grant || disabled" @click="approve">
        {{ approvalCommand ? '恢复同一确认结果（不新增授权）' : '确认并申请单次授权（尚未发送）' }}
      </button>
      <p v-if="approvalCommand && !grant" data-testid="sp-yida-owner-approval-pending">已保留同一确认标识。响应不确定时仅可恢复这次确认，不会自动申请新授权。</p>
    </section>

    <section v-if="grant" data-testid="sp-yida-owner-grant">
      <h4>服务端授权记录</h4>
      <p>授权 {{ grant.grantId }}；状态 {{ grant.status }}；到期 {{ displayTime(grant.expiresAt) }}。</p>
      <p>授权记录的剩余尝试数为 {{ grant.remainingAttempts }}。最终资格、时效和单次准入由服务端检查。</p>
      <button type="button" data-testid="sp-yida-owner-submit" :disabled="!maySubmit || busy || disabled" @click="submitOnce">提交此授权一次</button>
      <button type="button" data-testid="sp-yida-owner-refresh" :disabled="busy" @click="refreshObservation">手动刷新持久记录（只读）</button>
      <button type="button" data-testid="sp-yida-owner-revoke" :disabled="busy || grant.revoked" @click="revoke">撤销此授权</button>
      <p v-if="grant.revoked" data-testid="sp-yida-owner-revoked">授权已撤销；撤销前已准入的发送仍可能在途，撤销不代表远端写入已取消。</p>
      <p v-if="submissionCommand" data-testid="sp-yida-owner-frozen">此页面已经提交过一次命令，已冻结再次创建。保留原提交标识，仅可手动查看记录或撤销授权。</p>
      <p v-if="deliveryStatus" data-testid="sp-yida-owner-delivery">持久记录状态：{{ deliveryStatus }}。</p>
      <p v-if="deliveryStatus === 'acknowledged'" data-testid="sp-yida-owner-acknowledged">仅收到协议应答，尚未核验业务创建成功。</p>
      <p v-else-if="deliveryStatus" data-testid="sp-yida-owner-unverified">尚未核验业务创建成功；发送中或结果未知时不可重试创建。</p>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import {
  createYidaOwnerClient,
  YidaOwnerClientError,
  type YidaOwnerApproval,
  type YidaOwnerApprovalInput,
  type YidaOwnerClient,
  type YidaOwnerDraft,
  type YidaOwnerDraftInput,
  type YidaOwnerObservation,
  type YidaOwnerPreview,
  type YidaOwnerSubmission,
  type YidaOwnerSubmissionInput,
} from '../../../services/integration/yidaOwner'

const props = defineProps<{ draftInput: YidaOwnerDraftInput | null }>()
const emit = defineEmits<{ 'locked-change': [locked: boolean] }>()
const draft = shallowRef<YidaOwnerDraft | null>(null)
const selectedRowKey = ref('')
const preview = shallowRef<YidaOwnerPreview | null>(null)
const acknowledged = ref(false)
const grant = shallowRef<YidaOwnerApproval | null>(null)
const observed = shallowRef<YidaOwnerObservation | YidaOwnerSubmission | null>(null)
const approvalCommand = shallowRef<YidaOwnerApprovalInput | null>(null)
const submissionCommand = shallowRef<YidaOwnerSubmissionInput | null>(null)
const busy = ref(false)
const disabled = ref(false)
const expiredLocally = ref(false)
const errorCode = ref('')
let client: YidaOwnerClient | null = null
let generation = 0

const locked = computed(() => !!approvalCommand.value || !!grant.value || !!submissionCommand.value)
const maySubmit = computed(() => !!grant.value && grant.value.status === 'approved' && !grant.value.revoked
  && grant.value.remainingAttempts === 1 && !submissionCommand.value && !expiredLocally.value && Date.now() < grant.value.expiresAt)
const deliveryStatus = computed(() => observed.value && 'status' in observed.value
  ? observed.value.status : observed.value?.delivery?.status ?? null)
watch(locked, value => emit('locked-change', value), { flush: 'sync', immediate: true })

function reset(): void {
  generation++
  client?.dispose()
  client = null
  draft.value = null
  selectedRowKey.value = ''
  preview.value = null
  acknowledged.value = false
  grant.value = null
  observed.value = null
  approvalCommand.value = null
  submissionCommand.value = null
  errorCode.value = ''
  disabled.value = false
  expiredLocally.value = false
  busy.value = false
}
// Synchronous invalidation closes input A -> B -> A before a late response can
// reappear; deep edits count, even when the object reference stays unchanged.
watch(() => props.draftInput, reset, { deep: true, flush: 'sync' })
watch(selectedRowKey, () => { preview.value = null; acknowledged.value = false; errorCode.value = '' }, { flush: 'sync' })
onBeforeUnmount(reset)

function sessionClient(): YidaOwnerClient {
  if (!client) client = createYidaOwnerClient({ onInvalidated: () => { reset(); errorCode.value = 'YIDA_OWNER_SESSION_CHANGED' } })
  return client
}
async function perform<T>(action: (current: YidaOwnerClient) => Promise<T>, apply: (result: T) => void): Promise<void> {
  if (busy.value) return
  const started = generation
  busy.value = true
  errorCode.value = ''
  try {
    const result = await action(sessionClient())
    if (started === generation) apply(result)
  } catch (error) {
    if (started !== generation) return
    errorCode.value = error instanceof YidaOwnerClientError ? error.code : 'YIDA_OWNER_UNAVAILABLE'
    if (errorCode.value === 'YIDA_OWNER_RUNTIME_DISABLED') disabled.value = true
  } finally { if (started === generation) busy.value = false }
}
function saveDraft(): void {
  if (!props.draftInput || draft.value || locked.value || disabled.value) return
  // A detached snapshot is captured at the explicit save. No local row payload
  // is joined to server membership by index after this point.
  let snapshot: YidaOwnerDraftInput
  try { snapshot = JSON.parse(JSON.stringify(props.draftInput)) as YidaOwnerDraftInput }
  catch { errorCode.value = 'YIDA_OWNER_INPUT_INVALID'; return }
  void perform(current => current.prepareDraft(snapshot), result => { draft.value = result })
}
function fetchPreview(): void {
  if (!draft.value || !selectedRowKey.value || locked.value || disabled.value
    || !draft.value.rows.some(row => row.rowKey === selectedRowKey.value)) return
  const selection = { operationId: draft.value.operationId, rowKey: selectedRowKey.value }
  preview.value = null
  acknowledged.value = false
  void perform(current => current.preview(selection), result => { preview.value = result })
}
function approve(): void {
  if (!preview.value || !acknowledged.value || grant.value || disabled.value || busy.value) return
  if (!approvalCommand.value) {
    try {
      approvalCommand.value = Object.freeze({ operationId: preview.value.operationId, rowKey: preview.value.rowKey,
        confirmationId: crypto.randomUUID(), acknowledgeOnce: true, ttlMs: 900000 })
    } catch { errorCode.value = 'YIDA_OWNER_UNAVAILABLE'; return }
  }
  const command = approvalCommand.value
  const targetRef = preview.value.target.targetRef
  void perform(current => current.approve(command), result => {
    if (result.targetRef !== targetRef) throw new YidaOwnerClientError('YIDA_OWNER_RESPONSE_INVALID')
    grant.value = result
  })
}
function submitOnce(): void {
  if (!maySubmit.value || !grant.value || busy.value || disabled.value) return
  // The computed display has no polling clock. Recheck at the actual click;
  // the server still owns the definitive time and admission decision.
  if (Date.now() >= grant.value.expiresAt) {
    expiredLocally.value = true
    errorCode.value = 'YIDA_SEND_APPROVAL_EXPIRED'
    return
  }
  // Retain this exact command before transport begins. Neither an unknown
  // response nor a history refresh creates a new key or another POST.
  try { submissionCommand.value = Object.freeze({ grantId: grant.value.grantId, submissionId: crypto.randomUUID() }) }
  catch { errorCode.value = 'YIDA_OWNER_UNAVAILABLE'; return }
  const command = submissionCommand.value
  void perform(current => current.submit(command), result => { applyObservation(result) })
}
function applyObservation(result: YidaOwnerObservation | YidaOwnerSubmission): void {
  if (!grant.value || result.approval.operationId !== grant.value.operationId || result.approval.rowKey !== grant.value.rowKey
    || result.approval.targetRef !== grant.value.targetRef) throw new YidaOwnerClientError('YIDA_OWNER_RESPONSE_INVALID')
  grant.value = result.approval
  observed.value = result
}
function refreshObservation(): void {
  if (!grant.value || busy.value) return
  const grantId = grant.value.grantId
  void perform(current => current.observe(grantId), applyObservation)
}
function revoke(): void {
  if (!grant.value || busy.value || grant.value.revoked) return
  const grantId = grant.value.grantId
  void perform(current => current.revoke(grantId), result => {
    if (!grant.value || result.operationId !== grant.value.operationId || result.rowKey !== grant.value.rowKey
      || result.targetRef !== grant.value.targetRef) throw new YidaOwnerClientError('YIDA_OWNER_RESPONSE_INVALID')
    grant.value = result
  })
}
function displayTime(value: number): string { return new Date(value).toLocaleString('zh-CN', { hour12: false }) }
</script>

<style scoped>
.sp-yida-owner { margin-top: 1rem; border: 1px solid #c7ced8; border-radius: 8px; padding: 1rem; }
.sp-yida-owner button, .sp-yida-owner select { margin: .35rem .5rem .35rem 0; }
.sp-yida-owner dl { display: grid; grid-template-columns: minmax(6rem, 9rem) 1fr; gap: .3rem .7rem; }
.sp-yida-owner dd { margin: 0; overflow-wrap: anywhere; }
.sp-yida-owner pre { max-height: 20rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: #f4f6f9; padding: .7rem; }
.sp-yida-owner [role="alert"] { color: #a12c26; }
</style>
