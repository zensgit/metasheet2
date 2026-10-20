<template>
  <section class="change-read" data-testid="plm-change-read-panel">
    <h3>个人 BOM 变更监听</h3>
    <p>为已有协作快照单独授权读取后续元图变更。审批和写回仍需各自授权；已导入的快照按目标权限保留。</p>
    <button type="button" :disabled="busy || !partId" data-testid="plm-change-read-targets" @click="load">选择协作表</button>
    <template v-if="targets.length">
      <label>协作表 <select v-model="selectedId" :disabled="busy" data-testid="plm-change-read-target" @change="selectTarget">
        <option v-for="item in targets" :key="item.id" :value="item.id">{{ item.name }}</option>
      </select></label>
      <button type="button" :disabled="busy || !selected" data-testid="plm-change-read-consent" @click="consent">准备个人授权</button>
      <p v-if="managementUrl"><a :href="managementUrl" target="_blank" rel="noopener noreferrer" data-testid="plm-change-read-native">前往元图确认此协作表的读取范围</a></p>
      <form autocomplete="off" @submit.prevent="bind">
        <label>元图个人变更读取授权
          <input v-model="grant" type="password" autocomplete="new-password" autocapitalize="off" :spellcheck="false" :disabled="busy" data-testid="plm-change-read-grant" />
        </label>
        <p>提交后立即清空输入，授权不会保存在浏览器中。</p>
        <button type="submit" :disabled="busy || !selected || !grant" data-testid="plm-change-read-bind">验证并绑定</button>
      </form>
      <p v-if="current" data-testid="plm-change-read-state">{{ current.bound ? '已绑定个人授权' : '未绑定个人授权' }} · {{ current.status === 'active' ? '监听中' : '未启动' }}</p>
      <p v-if="current?.expiresAt">授权到期：{{ current.expiresAt }}</p>
      <button type="button" :disabled="busy || !current?.bound" data-testid="plm-change-read-start" @click="start">从当前变更开始监听</button>
      <button type="button" :disabled="busy || !current?.bound" data-testid="plm-change-read-unbind" @click="unbind">解除个人读取授权</button>
      <p>启动时跳过已有变更。解除授权停止后续监听；远程吊销结果不确定时会保留重试。</p>
    </template>
    <p role="status" data-testid="plm-change-read-message">{{ message }}</p>
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { onAuthSessionSwitch, readAuthSessionSignature } from '../../composables/authPrincipal'
import { changeReadTargets, changeReadManagement, changeReadState, bindChangeRead, startChangeRead, unbindChangeRead,
  type ChangeReadTarget, type ChangeReadState } from '../../services/plm/plmBomChangeRead'
const props = defineProps<{ dataSourceId: string; partId: string }>()
const targets = ref<ChangeReadTarget[]>([]), selectedId = ref(''), managementUrl = ref(''), grant = ref('')
const current = ref<ChangeReadState | null>(null), busy = ref(false), message = ref('')
const selected = computed(() => targets.value.find(item => item.id === selectedId.value))
let generation = 0
function reset() { generation++; targets.value = []; selectedId.value = ''; managementUrl.value = ''; grant.value = ''; current.value = null; busy.value = false; message.value = '' }
const unsubscribe = onAuthSessionSwitch(reset)
watch(() => [props.dataSourceId, props.partId], reset)
onBeforeUnmount(() => { reset(); unsubscribe() })
async function run(action: (source: { dataSourceId: string; partId: string }, target?: ChangeReadTarget) => Promise<() => void>) {
  if (busy.value) return
  const own = ++generation, identity = readAuthSessionSignature(), source = { dataSourceId: props.dataSourceId, partId: props.partId }, target = selected.value
  busy.value = true; message.value = ''
  try { const apply = await action(source, target); if (own === generation && identity === readAuthSessionSignature()
      && source.dataSourceId === props.dataSourceId && source.partId === props.partId
      && (!target || target.id === selectedId.value)) apply() }
  catch { if (own === generation) message.value = '操作未完成。请确认个人登录、目标权限和此协作表的变更监听设置后重试。' }
  finally { if (own === generation) busy.value = false }
}
async function load() { await run(async source => { const items = await changeReadTargets(source); return () => { targets.value = items; selectedId.value = ''; current.value = null; managementUrl.value = ''; grant.value = ''; if (!items.length) message.value = '当前没有可管理的已导入协作表。' } }) }
async function selectTarget() {
  managementUrl.value = ''; grant.value = ''; current.value = null
  await run(async (_source, target) => { if (!target) return () => {}; const result = await changeReadState(target.id); return () => { current.value = result } })
}
async function consent() { await run(async (source, target) => { if (!target) return () => {}; const url = await changeReadManagement(source, target); return () => { managementUrl.value = url } }) }
async function bind() {
  const secret = grant.value; grant.value = ''
  await run(async (_source, target) => { if (!target) return () => {}; const result = await bindChangeRead(target, secret); return () => { current.value = result; managementUrl.value = ''; message.value = result.rejected ? '新授权已绑定；旧授权远程吊销被拒绝，请在元图检查状态。' : result.pending ? '个人授权已绑定，旧授权吊销待后台重试。请明确启动后续监听。' : '个人授权已绑定，请明确启动后续监听。' } })
}
async function start() { await run(async (_source, target) => { if (!target) return () => {}; await startChangeRead(target); const result = await changeReadState(target.id); return () => { current.value = result; message.value = '已从当前变更开始监听。' } }) }
async function unbind() { await run(async (_source, target) => { if (!target) return () => {}; const result = await unbindChangeRead(target.id); const state = await changeReadState(target.id); return () => { current.value = state; managementUrl.value = ''; grant.value = ''; message.value = result.rejected ? '本地读取已停止，远程吊销被拒绝；请在元图检查授权状态。' : result.pending ? '本地读取已停止，远程吊销正在重试。' : '个人读取已解除。已有快照按目标权限保留。' } }) }
</script>

<style scoped>
.change-read { display: grid; gap: 12px; margin-top: 16px; padding: 16px; border: 1px solid var(--border-color, #dbe2ea); border-radius: 8px; }
h3, p { margin: 0; }
label { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
input, select { min-width: 180px; max-width: 100%; padding: 6px 8px; }
button { justify-self: start; padding: 6px 12px; }
form { display: grid; gap: 8px; }
</style>
