<template>
  <section aria-label="BOM 通知配置">
    <h4>通知规则</h4>
    <p>每条规则独立选择负责人时点；升级接收人必须有此表访问权，选择不会授予权限。</p>
    <p>规则保存后，由已启用的后台任务处理站内通知；完成通知请单独配置完成 Webhook。</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <button type="button" :disabled="busy" @click="load">重新加载配置</button>
    <form @submit.prevent="save">
      <fieldset :disabled="busy || !loaded">
        <legend>问题通知</legend>
        <label><input v-model="draft.issue.enabled" type="checkbox" data-testid="issue-enabled" />启用问题通知</label>
        <label v-if="draft.issue.enabled">通知负责人
          <select v-model="draft.issue.recipientStrategy" data-testid="issue-strategy">
            <option :value="null" disabled>请选择负责人时点</option>
            <option value="event_owner">问题发生时的负责人</option><option value="current_owner">发送前的当前负责人</option>
          </select>
        </label>
      </fieldset>
      <fieldset :disabled="busy || !loaded">
        <legend>临期提醒</legend>
        <label><input v-model="draft.reminder.enabled" type="checkbox" data-testid="reminder-enabled" />启用临期提醒</label>
        <template v-if="draft.reminder.enabled">
          <label>提前分钟数（0 表示截止时刻）<input v-model.number="draft.reminder.leadMinutes" type="number" min="0" step="1" data-testid="reminder-minutes" /></label>
          <label>通知负责人<select v-model="draft.reminder.recipientStrategy" data-testid="reminder-strategy">
            <option :value="null" disabled>请选择负责人时点</option>
            <option value="event_owner">提醒事件发生时的负责人</option><option value="current_owner">发送前的当前负责人</option>
          </select></label>
        </template>
      </fieldset>
      <fieldset :disabled="busy || !loaded">
        <legend>问题 SLA 升级</legend>
        <label><input v-model="draft.escalation.enabled" type="checkbox" data-testid="escalation-enabled" />启用 SLA 升级</label>
        <template v-if="draft.escalation.enabled">
          <label>问题持续分钟数<input v-model.number="draft.escalation.slaMinutes" type="number" min="1" step="1" data-testid="sla-minutes" /></label>
          <label>搜索升级接收人<input v-model="search" maxlength="128" data-testid="recipient-search" /></label>
          <button type="button" :disabled="!search.trim()" @click="findRecipients">搜索</button>
          <p>结果最多显示 30 人；请输入更精确的姓名或账号以缩小范围。</p>
          <button v-for="user in candidates" :key="user.id" type="button" @click="selectRecipient(user)">{{ user.name }} · 选择</button>
          <p v-if="searched && !candidates.length">没有找到当前可接收升级通知的用户。</p>
          <ul><li v-for="id in draft.escalation.recipientUserIds" :key="id">{{ names[id] || id }}
            <button type="button" @click="draft.escalation.recipientUserIds = draft.escalation.recipientUserIds.filter(value => value !== id)">移除</button>
          </li></ul>
        </template>
      </fieldset>
      <button type="submit" :disabled="busy || !loaded || !valid" data-testid="save-notifications">保存规则</button>
      <button type="button" @click="emit('close')">关闭配置</button>
    </form>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { onAuthSessionSwitch } from '../../composables/authPrincipal'
import { getBomNotifications, saveBomNotifications, searchBomNotificationRecipients, PlmBomCollaborationError,
  type BomNotifications } from '../../services/plm/plmBomCollaboration'
const props = defineProps<{ bindingId: string }>()
const emit = defineEmits<{ close: [] }>()
function empty(): BomNotifications { return {
  issue: { enabled: false, recipientStrategy: null },
  reminder: { enabled: false, recipientStrategy: null, leadMinutes: null },
  escalation: { enabled: false, slaMinutes: null, recipientUserIds: [] },
} }
const draft = ref(empty()), version = ref(0), loaded = ref(false), busy = ref(false), error = ref(''), message = ref('')
const search = ref(''), candidates = ref<Array<{ id: string; name: string }>>([]), names = ref<Record<string,string>>({}), searched = ref(false)
let generation = 0, controller: AbortController | undefined
const duration = (value: unknown, min: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && Number.isSafeInteger(value * 60000) && Number.isFinite(new Date(Date.now()+value*60000).getTime())
const valid = computed(() => (!draft.value.issue.enabled || draft.value.issue.recipientStrategy !== null)
  && (!draft.value.reminder.enabled || (draft.value.reminder.recipientStrategy !== null && duration(draft.value.reminder.leadMinutes,0)))
  && (!draft.value.escalation.enabled || (duration(draft.value.escalation.slaMinutes,1) && draft.value.escalation.recipientUserIds.length > 0)))
function invalidate() { generation++; controller?.abort(); busy.value = false; loaded.value = false; draft.value = empty(); candidates.value = []; names.value = {}; search.value = ''; searched.value = false; error.value = ''; message.value = '' }
const unsubscribe = onAuthSessionSwitch(() => { invalidate(); emit('close') })
onBeforeUnmount(() => { invalidate(); unsubscribe() })
async function run(task: (signal: AbortSignal) => Promise<() => void>) {
  if (busy.value) return
  const current = generation
  controller = new AbortController(); busy.value = true; error.value = ''; message.value = ''
  try { const apply = await task(controller.signal); if (current === generation) apply() }
  catch (cause) { if (current === generation) {
    error.value = cause instanceof PlmBomCollaborationError ? cause.message : '配置未保存，请重试。'
    if (cause instanceof PlmBomCollaborationError && cause.code === 'VERSION_CONFLICT') error.value = '通知规则已被修改，请重新加载配置后重试。'
    if (cause instanceof PlmBomCollaborationError && cause.code === 'FORBIDDEN') {
      loaded.value = false; draft.value = empty(); candidates.value = []; names.value = {}
    }
  } }
  finally { if (current === generation) busy.value = false }
}
function load() { loaded.value = false; return run(async (signal) => {
  const config = await getBomNotifications(props.bindingId,signal)
  return () => { version.value = config.version; draft.value = config.notifications ?? empty(); loaded.value = true }
}) }
watch(() => props.bindingId, () => { invalidate(); void load() }, { immediate: true })
function save() {
  if (!valid.value || !loaded.value) return
  const notifications: BomNotifications = JSON.parse(JSON.stringify(draft.value))
  // Empty number inputs are strings in Vue; disabled timings have no operational meaning.
  if (!notifications.reminder.enabled) notifications.reminder.leadMinutes = null
  if (!notifications.escalation.enabled) notifications.escalation.slaMinutes = null
  return run(async (signal) => {
    const config = await saveBomNotifications(props.bindingId,{ expectedVersion: version.value, notifications },signal)
    return () => { version.value = config.version; draft.value = config.notifications!; message.value = '规则已保存；后台任务启用后按规则处理站内通知。' }
  })
}
function findRecipients() { const term = search.value.trim(); if (!term) return
  return run(async (signal) => { const users = await searchBomNotificationRecipients(props.bindingId,term,signal)
    return () => { if (search.value.trim() === term) { candidates.value = users; searched.value = true } }
  })
}
function selectRecipient(user: { id: string; name: string }) {
  if (!draft.value.escalation.recipientUserIds.includes(user.id)) draft.value.escalation.recipientUserIds.push(user.id)
  names.value[user.id] = user.name
}
</script>

<style scoped>
fieldset { display: flex; flex-direction: column; gap: 10px; margin: 12px 0; }
label { display: block; }
input:not([type=checkbox]), select { display: block; margin-top: 4px; }
[role=alert] { color: #b91c1c; }
</style>
