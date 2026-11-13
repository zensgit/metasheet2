<template>
  <div data-correction-decision>
    <small v-if="context" data-correction-decision-token>
      {{ tr('Displayed approval', '当前显示审批') }} {{ context.expectedApprovalVersion }} / {{ context.expectedApprovalNode }} ·
      {{ tr('Request snapshot', '申请快照') }} {{ context.expectedSnapshotVersion }}
      <code>{{ context.expectedSnapshotFingerprint }}</code>
    </small>
    <p v-if="message" role="status">{{ message }}</p>
    <template v-if="entitled">
      <button type="button" data-correction-approve :disabled="!ready || busy" @click="decide('approve')">{{ tr('Approve', '批准') }}</button>
      <button type="button" data-correction-reject :disabled="!ready || busy" @click="decide('reject')">{{ tr('Reject', '驳回') }}</button>
      <small v-if="!context">{{ tr('Decision token unavailable. Reload the request.', '缺少决定令牌，请重新加载申请。') }}</small>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import { useAttendanceSessionGuard } from '../../composables/useAttendanceSessionGuard'
import type { apiFetch } from '../../utils/api'
import { randomUuid } from '../../utils/uuid'
import { correctionDecisionBody, correctionDecisionContext, type CorrectionRequestRow } from './attendanceCorrectionRequestContext'
const props = defineProps<{
  row: CorrectionRequestRow; entitled: boolean; editing: boolean
  tr: (en: string, zh: string) => string; send: typeof apiFetch
}>()
const emit = defineEmits<{ reload: []; resolved: [] }>()
const guard = useAttendanceSessionGuard()
const context = computed(() => correctionDecisionContext(props.row))
const busy = ref(false)
const message = ref('')
const blocked = ref(false)
let generation = 0
let command: { key: string; body: Record<string, unknown> } | null = null
const binding = computed(() => JSON.stringify([props.row.id, props.row.status, context.value, props.entitled, props.editing]))
watch([binding, guard.stale], () => {
  ++generation
  command = null
  busy.value = false
  blocked.value = false
  message.value = ''
}, { flush: 'sync' })
onScopeDispose(() => { ++generation; command = null })
const ready = computed(() => !!context.value && props.entitled && !props.editing && props.row.status === 'pending' && !blocked.value && guard.isCurrent())
async function decide(action: 'approve' | 'reject'): Promise<void> {
  if (!ready.value || busy.value || !context.value) return
  let comment: string | undefined
  if (action === 'reject') {
    const value = window.prompt(props.tr('Rejection reason is required', '请填写驳回原因'), '')
    if (value === null) return
    comment = value.trim()
    if (!comment) { message.value = props.tr('Rejection reason is required.', '驳回原因不能为空。'); return }
  }
  if (!guard.isCurrent()) return
  const token = context.value
  const key = JSON.stringify([binding.value, action, comment])
  try {
    if (!command || command.key !== key) command = { key, body: { ...correctionDecisionBody(token), operationId: randomUuid(), ...(comment ? { comment } : {}) } }
  } catch {
    message.value = props.tr('Unable to create command identity.', '无法生成命令标识。')
    return
  }
  const current = ++generation
  busy.value = true
  try {
    const response = await props.send('/api/attendance/requests/' + encodeURIComponent(token.requestId) + '/' + action, { method: 'POST', body: JSON.stringify(command.body) })
    const body = await response.json()
    if (current !== generation || !guard.isCurrent()) return
    if (response.status === 409) {
      command = null
      blocked.value = true
      message.value = props.tr('The request changed. Reloaded content requires a new decision.', '申请已变化。重载后请核对内容并重新明确决定。')
      emit('reload')
      return
    }
    if (!response.ok || body?.ok !== true) {
      message.value = props.tr('Decision failed. Retry the same command or reload.', '决定未成功，可重试本次命令或重新加载。')
      return
    }
    command = null
    blocked.value = true
    message.value = props.tr('Decision submitted.', '决定已提交。')
    emit('resolved')
  } catch {
    if (current === generation && guard.isCurrent()) message.value = props.tr('Decision could not be confirmed. Retry retains this command identity.', '未能确认决定结果，重试会保留本次命令标识。')
  } finally { if (current === generation) busy.value = false }
}
</script>
