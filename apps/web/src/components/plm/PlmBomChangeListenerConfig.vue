<template>
  <section aria-label="PLM 来源事件监听">
    <h4>PLM 来源事件监听</h4>
    <p>仅来源 owner 可开启或重新绑定；还需先保存已启用的“PLM 修改成功”完成规则。</p>
    <p>每次确认都会保存来源当前游标，只处理之后的事件，不补发历史。重新绑定会跳过尚未处理的历史事件；转让、撤权或授权上下文变化后停止，需 owner 再次显式确认。</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="state" data-testid="listener-status">{{ statusLabel }}</p>
    <p v-if="state && state.status !== 'not_started'">当前游标：{{ state.cursor }}</p>
    <button type="button" :disabled="busy" @click="load">重新加载监听状态</button>
    <form @submit.prevent="start">
      <fieldset :disabled="busy || !state">
        <label><input v-model="confirmed" type="checkbox" data-testid="listener-consent" />我作为来源 owner 确认从当前游标开启或重新绑定，不补发历史。</label>
        <button type="submit" :disabled="!confirmed" data-testid="start-listener">{{ state?.status === 'not_started' ? '确认开启监听' : '确认重新绑定监听' }}</button>
      </fieldset>
    </form>
    <button type="button" @click="emit('close')">关闭监听配置</button>
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { onAuthSessionSwitch } from '../../composables/authPrincipal'
import { getBomChangeListener, startBomChangeListener, PlmBomCollaborationError,
  type BomChangeListener } from '../../services/plm/plmBomCollaboration'
const props = defineProps<{ bindingId: string; bindingVersion: number }>()
const emit = defineEmits<{ close: []; reloadBinding: [] }>()
const state = ref<BomChangeListener | null>(null), confirmed = ref(false), busy = ref(false)
const error = ref(''), message = ref('')
const statusLabel = computed(() => state.value ? ({ not_started: '尚未开启', active: '监听已开启', stopped: '监听已停止，需要重新授权绑定' })[state.value.status] : '')
let generation = 0, controller: AbortController | undefined
function invalidate() { generation++; controller?.abort(); state.value = null; confirmed.value = false; busy.value = false; error.value = ''; message.value = '' }
const unsubscribe = onAuthSessionSwitch(() => { invalidate(); emit('close') })
onBeforeUnmount(() => { invalidate(); unsubscribe() })
async function run(task: (signal: AbortSignal) => Promise<BomChangeListener>, saved = false) {
  if (busy.value) return
  const current = generation
  controller = new AbortController(); busy.value = true; confirmed.value = false; error.value = ''; message.value = ''
  try {
    const result = await task(controller.signal)
    if (current === generation) {
      state.value = result
      if (saved) message.value = '监听已开启；仅处理当前游标之后的事件。'
    }
  } catch (cause) {
    if (current === generation) {
      // A failed POST may already have committed. Require a fresh GET and new consent, never retry it automatically.
      state.value = null
      error.value = cause instanceof PlmBomCollaborationError ? cause.message : '监听操作未确认，请重新加载状态。'
      if (cause instanceof PlmBomCollaborationError && cause.code === 'VERSION_CONFLICT') emit('reloadBinding')
    }
  } finally { if (current === generation) busy.value = false }
}
function load() { state.value = null; return run(signal => getBomChangeListener(props.bindingId, signal)) }
function start() {
  if (!state.value || !confirmed.value || busy.value) return
  const { bindingId, bindingVersion } = props
  return run(signal => startBomChangeListener(bindingId, bindingVersion, signal), true)
}
watch(() => [props.bindingId, props.bindingVersion], () => { invalidate(); void load() }, { immediate: true })
</script>
<style scoped>
label { display: block; margin: 8px 0; } [role=alert] { color: #b91c1c; }
</style>
