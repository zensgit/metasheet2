<template>
  <section data-testid="sp-yida-reconciliation">
    <h5>人工核验声明（不改变原发送事实）</h5>
    <p>原发送记录：{{ ledgerStatus }}。证据尚未由系统验证；观察一致不是 ACK，不退款、不释放串行位、不允许重发。</p>
    <button type="button" :disabled="busy" @click="load(null)">读取核验历史</button>
    <ol><li v-for="record in records" :key="record.id">#{{ record.sequence }} · {{ labels[record.conclusion] }} · {{ record.reason }} · {{ record.recordedAt }}
      <span v-if="record.supersedesObservationId">（追加更正，原记录仍保留）</span>
      <button type="button" :disabled="busy || !!pending" @click="supersedes = record.id">追加更正此条</button>
    </li></ol>
    <button v-if="nextAfterId" type="button" :disabled="busy" @click="load(nextAfterId)">下一页（每页最多 50 条）</button>
    <p>声明互相矛盾时需人工复核，系统不按最新声明判定发送成功。下列输入只保存声明，不上传、读取证据原件。</p>
    <fieldset :disabled="busy || !!pending || !readThroughHead || disabled">
      <legend>追加一条人工事实</legend>
      <label>结论<select v-model="conclusion"><option value="inconclusive">未能判定</option><option value="observed_match">观察一致</option><option value="observed_mismatch">观察不一致</option></select></label>
      <label>证据类型<select v-model="kind"><option value="">无证据（仅可未能判定）</option><option value="operator_receipt">人工回执</option><option value="operator_comparison">人工比较</option></select></label>
      <label>不透明证据引用<input v-model="evidenceRef" maxlength="128"></label>
      <label>人工提供的 SHA256<input v-model="digest" maxlength="64"></label>
      <p v-if="supersedes">正在追加更正；不会覆盖或删除旧记录。<button type="button" @click="supersedes = null">取消更正选择</button></p>
      <label><input v-model="confirmed" type="checkbox">我确认这是人工声明，证据未经系统验证，不要求重发或修改原发送状态。</label>
    </fieldset>
    <button type="button" :disabled="busy || disabled || (!pending && (!confirmed || !readThroughHead))" @click="append">{{ pending ? '按原命令及原内容核对（仅本地记录）' : '追加人工声明' }}</button>
    <p v-if="pending">回执未确认时保留原命令，不换键、不自动重试。同一标签页保存原命令以支持刷新恢复，不保存口令或证据原件。关闭标签页或清除浏览器存储前必须先核对历史。</p>
    <button v-if="conflict && conflictRead" type="button" :disabled="busy" @click="acknowledgeConflict">已重新核对历史，放弃此冲突命令并重新人工确认</button>
    <p v-if="errorCode" role="alert">{{ errorCode }}</p>
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { randomUuid } from '../../../utils/uuid'
import { createYidaAutomationClient, YidaAutomationClientError } from '../../../services/integration/yidaAutomation'
import { parseYidaReconciliationInput, type YidaReconciliationInput, type YidaReconciliationRecord } from '../../../services/integration/yidaReconciliation'
import { openYidaReconciliationPending } from '../../../services/integration/yidaReconciliationPending'
const props = defineProps<{ grantId: string; requestId: string; ledgerStatus: string | null; scopeKey: string; disabled?: boolean }>()
const records = shallowRef<readonly YidaReconciliationRecord[]>([]), head = ref<number | null>(null), nextAfterId = ref<string | null>(null)
const conclusion = ref<YidaReconciliationInput['conclusion']>('inconclusive'), kind = ref(''), evidenceRef = ref(''), digest = ref('')
const supersedes = ref<string | null>(null), confirmed = ref(false), busy = ref(false), errorCode = ref('')
const pending = shallowRef<YidaReconciliationInput | null>(null)
const conflict = ref(false), conflictRead = ref(false)
const readThroughHead = computed(() => head.value !== null && nextAfterId.value === null
  && (records.value.at(-1)?.sequence ?? 0) === head.value)
const labels = { observed_match: '人工记录：观察一致', observed_mismatch: '人工记录：观察不一致', inconclusive: '人工记录：未能判定' }
let client: ReturnType<typeof createYidaAutomationClient> | null = null, generation = 0
let journal: Awaited<ReturnType<typeof openYidaReconciliationPending>> | null = null
function reset() {
  generation++; client?.dispose(); client = null; records.value = []; head.value = null; nextAfterId.value = null
  journal = null; pending.value = null; conflict.value = false; conflictRead.value = false
  confirmed.value = false; supersedes.value = null; evidenceRef.value = ''; digest.value = ''; kind.value = ''
  conclusion.value = 'inconclusive'; busy.value = false; errorCode.value = ''
}
watch(() => [props.grantId, props.requestId, props.scopeKey], reset, { flush: 'sync' })
watch([conclusion, kind, evidenceRef, digest, supersedes], () => { confirmed.value = false }, { flush: 'sync' })
onBeforeUnmount(reset)
function session() { return client ??= createYidaAutomationClient({ onInvalidated: () => { reset(); errorCode.value = 'YIDA_AUTOMATION_SESSION_CHANGED' } }) }
async function load(after: string | null) {
  if (busy.value) return
  const started = generation; busy.value = true; errorCode.value = ''; confirmed.value = false
  try {
    const recovered = await openYidaReconciliationPending(props.grantId, props.requestId)
    if (started !== generation) return
    journal = recovered; pending.value = journal.read()
    const page = await session().listObservations(props.grantId, props.requestId, after)
    if (started !== generation) return
    records.value = after === null ? page.records : [...records.value, ...page.records]
    head.value = page.headSequence; nextAfterId.value = page.nextAfterId
    if (conflict.value) conflictRead.value = readThroughHead.value
  } catch (e) { if (started === generation) errorCode.value = e instanceof YidaAutomationClientError ? e.code : 'YIDA_RECONCILIATION_UNAVAILABLE' }
  finally { if (started === generation) busy.value = false }
}
async function append() {
  if (busy.value || props.disabled || !pending.value && (!confirmed.value || !readThroughHead.value)) return
  if (!journal) { errorCode.value = 'YIDA_RECONCILIATION_RECOVERY_REQUIRED'; return }
  if (!pending.value) {
    try { pending.value = parseYidaReconciliationInput({ commandKey: randomUuid(), expectedHeadSequence: head.value,
      conclusion: conclusion.value, reason: supersedes.value ? 'CORRECTION' : conclusion.value === 'observed_match'
        ? 'OPERATOR_RECORDED_MATCH' : conclusion.value === 'observed_mismatch' ? 'FIELD_MISMATCH' : 'NO_OBSERVATION',
      evidenceKind: kind.value || null, evidenceRef: kind.value ? evidenceRef.value : null, evidenceSha256: kind.value ? digest.value : null,
      claimedObservedAt: null, supersedesObservationId: supersedes.value }) }
    catch { errorCode.value = 'YIDA_RECONCILIATION_INPUT'; return }
  }
  try { journal.save(pending.value) } catch { errorCode.value = 'YIDA_RECONCILIATION_RECOVERY_REQUIRED'; return }
  const started = generation; busy.value = true; errorCode.value = ''
  try {
    await session().appendObservation(props.grantId, props.requestId, pending.value)
    if (started !== generation) return
    journal.remove(pending.value!.commandKey)
    pending.value = null; confirmed.value = false; supersedes.value = null; head.value = null; conflict.value = false
  } catch (e) { if (started === generation) {
    errorCode.value = e instanceof YidaAutomationClientError ? e.code : 'YIDA_RECONCILIATION_UNAVAILABLE'
    conflict.value = errorCode.value === 'YIDA_RECONCILIATION_CONFLICT'; conflictRead.value = false
  } }
  finally { if (started === generation) busy.value = false }
  if (started === generation && !pending.value) await load(null)
}
function acknowledgeConflict() {
  if (busy.value || !conflict.value || !conflictRead.value || !pending.value || !journal) return
  try { journal.remove(pending.value.commandKey) } catch { errorCode.value = 'YIDA_RECONCILIATION_RECOVERY_REQUIRED'; return }
  pending.value = null; conflict.value = false; conflictRead.value = false; confirmed.value = false; supersedes.value = null
}
</script>
