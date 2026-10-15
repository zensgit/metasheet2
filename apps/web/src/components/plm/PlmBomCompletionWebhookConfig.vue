<template>
  <section aria-label="BOM 完成 Webhook 配置">
    <h4>完成 Webhook</h4>
    <p>按场景独立配置两种事件；协作评审完成不会表示 PLM 已修改成功。规则仅用于后续事件。</p>
    <p>PLM 修改成功通知需由来源负责人显式开启事件监听；只处理开启后的事件，不补发历史。</p>
    <p v-if="error" role="alert">{{ error }}</p><p v-if="message" role="status">{{ message }}</p>
    <p v-if="loaded && !canSelect">当前无权选择发送目标，仍可停用已有规则。</p>
    <button type="button" :disabled="busy" @click="load">重新加载完成规则</button>
    <form @submit.prevent="save">
      <fieldset v-for="event in events" :key="event.key" :disabled="busy || !loaded">
        <legend>{{ event.label }}</legend><p>{{ event.name }}</p>
        <label><input
v-model="draft[event.key].enabled" type="checkbox" :data-testid="event.key + '-enabled'"
          :disabled="!canSelect && !draft[event.key].enabled" />启用</label>
        <label v-if="event.key === 'reviewCompleted' && draft.reviewCompleted.enabled">完成粒度
          <select v-model="draft.reviewCompleted.granularity" :disabled="!canSelect" data-testid="reviewCompleted-granularity">
            <option :value="null" disabled>请选择完成粒度</option>
            <option value="bom">整份 BOM 评审完成</option><option value="row">单行评审完成</option>
          </select>
        </label>
        <label v-if="event.key === 'plmChangeApplied' && draft.plmChangeApplied.enabled">成功来源
          <select v-model="draft.plmChangeApplied.source" :disabled="!canSelect" data-testid="plmChangeApplied-source">
            <option :value="null" disabled>请选择成功来源</option>
            <option value="bom_line_writeback">BOM 行修改成功</option><option value="eco_batch_apply">ECO 整批应用成功</option>
          </select>
        </label>
        <label v-if="draft[event.key].enabled">发送目标
          <select v-model="draft[event.key].webhookId" :disabled="!canSelect" :data-testid="event.key + '-target'">
            <option :value="null" disabled>请选择已有 Webhook</option>
            <option
v-if="draft[event.key].webhookId && !destinations.some(d => d.id === draft[event.key].webhookId)"
              :value="draft[event.key].webhookId" disabled>已有目标当前不可选择，请停用或重新选择</option>
            <option v-for="target in destinations" :key="target.id" :value="target.id">{{ target.name }}</option>
          </select>
        </label>
      </fieldset>
      <button type="submit" :disabled="busy || !loaded || !valid" data-testid="save-completion">保存完成规则</button>
      <button type="button" @click="emit('close')">关闭配置</button>
    </form>
  </section>
</template>
<script setup lang="ts">
import { computed,onBeforeUnmount,ref,watch } from 'vue'
import { onAuthSessionSwitch } from '../../composables/authPrincipal'
import { getBomCompletionWebhooks,saveBomCompletionWebhooks,listBomCompletionWebhookDestinations,
  PlmBomCollaborationError,type BomCompletionWebhooks } from '../../services/plm/plmBomCollaboration'
const props = defineProps<{ bindingId: string }>(), emit = defineEmits<{ close: [] }>()
const events = [
  { key: 'reviewCompleted',label: '协作评审完成',name: 'bom.review.completed' },
  { key: 'plmChangeApplied',label: 'PLM BOM 修改成功',name: 'bom.plm_change.applied' },
] as const
const empty = (): BomCompletionWebhooks => ({ reviewCompleted: { enabled: false,webhookId: null,granularity: null },plmChangeApplied: { enabled: false,webhookId: null,source: null } })
const draft = ref(empty()), version = ref(0),loaded = ref(false),busy = ref(false),error = ref(''),message = ref('')
const destinations = ref<Array<{ id: string; name: string }>>([]),canSelect = ref(false)
const valid = computed(() => events.every(({ key }) => !draft.value[key].enabled || (canSelect.value
  && (key === 'reviewCompleted' ? draft.value.reviewCompleted.granularity !== null : draft.value.plmChangeApplied.source !== null)
  && destinations.value.some(d => d.id === draft.value[key].webhookId))))
let generation = 0,controller: AbortController | undefined
function invalidate() { generation++; controller?.abort(); busy.value = false; loaded.value = false; draft.value = empty(); destinations.value = []; canSelect.value = false; error.value = ''; message.value = '' }
const unsubscribe = onAuthSessionSwitch(() => { invalidate(); emit('close') })
onBeforeUnmount(() => { invalidate(); unsubscribe() })
async function run(task: (signal: AbortSignal) => Promise<() => void>) {
  if (busy.value) return
  const current = generation; controller = new AbortController(); busy.value = true; error.value = ''; message.value = ''
  try { const apply = await task(controller.signal); if (current === generation) apply() }
  catch (cause) { if (current === generation) {
    error.value = cause instanceof PlmBomCollaborationError ? cause.message : '完成规则未保存，请重试。'
    if (cause instanceof PlmBomCollaborationError && cause.code === 'VERSION_CONFLICT') error.value = '完成规则已被修改，请重新加载后重试。'
    if (cause instanceof PlmBomCollaborationError && cause.code === 'FORBIDDEN') { invalidate(); error.value = cause.message }
  } }
  finally { if (current === generation) busy.value = false }
}
function load() { loaded.value = false; return run(async (signal) => {
  const config = await getBomCompletionWebhooks(props.bindingId,signal)
  let targets: Array<{ id: string; name: string }> = [],allowed = true
  try { targets = await listBomCompletionWebhookDestinations(props.bindingId,signal) }
  catch (cause) { if (!(cause instanceof PlmBomCollaborationError && cause.code === 'WEBHOOK_SEND_FORBIDDEN')) throw cause; allowed = false }
  return () => { version.value = config.version; draft.value = config.webhooks ?? empty(); destinations.value = targets; canSelect.value = allowed; loaded.value = true }
}) }
watch(() => props.bindingId, () => { invalidate(); void load() }, { immediate: true })
function save() {
  if (!valid.value || !loaded.value) return
  const webhooks: BomCompletionWebhooks = JSON.parse(JSON.stringify(draft.value))
  return run(async (signal) => {
    const config = await saveBomCompletionWebhooks(props.bindingId,{ expectedVersion: version.value,webhooks },signal)
    return () => { version.value = config.version; draft.value = config.webhooks!; message.value = '完成规则已保存；仅处理后续符合权限和来源授权的事件。' }
  })
}
</script>
<style scoped>
fieldset { margin: 12px 0; } label { display: block; margin: 8px 0; } [role=alert] { color: #b91c1c; }
</style>
