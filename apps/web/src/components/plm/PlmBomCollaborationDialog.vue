<template>
  <div class="bom-collaboration__overlay">
    <section class="bom-collaboration" role="dialog" aria-modal="true" aria-labelledby="bom-collaboration-title">
      <header><h3 id="bom-collaboration-title">BOM 协作表</h3><button type="button" @click="close">关闭</button></header>
      <p>PLM 来源快照只读；责任人、状态、标签、备注、日期、问题类型和评审意见等协作字段保存在 MetaSheet，不会写回 PLM。评论使用现有评论权限。</p>
      <p>新表评审流程：待评审→评审中→有问题/已完成，完成后可重开。问题、临期及 SLA 规则可配置，后台任务启用后处理站内通知。</p>
      <p>分享按目标表当前及后续 MetaSheet 权限生效；指派责任人不会授予访问权限。PLM 写回仍需独立授权。</p>
      <p>创建者获得此表管理权限；既有 Base、角色和全局权限继续适用，新表并非仅创建者可读。</p>
      <p>来源授权失效或停用绑定只停止后续刷新，已分享快照和本地协作数据仍保留。</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-if="message" role="status">{{ message }}</p>
      <button type="button" :disabled="busy" @click="load">重新加载目标与绑定状态</button>
      <p v-if="busy" role="status">正在处理…</p>
      <form @submit.prevent="previewShare">
        <fieldset :disabled="busy || !loaded">
          <legend>在指定 Base 新建协作表</legend>
          <label>目标 Base
            <select v-model="baseId" data-testid="collaboration-base">
              <option value="" disabled>请明确选择目标 Base</option>
              <option v-for="base in bases" :key="base.id" :value="base.id">{{ base.name }}</option>
            </select>
          </label>
          <label>新协作表名称<input v-model="name" maxlength="255" data-testid="collaboration-name" /></label>
          <p v-if="loaded && !bases.length">没有可创建协作表的 Base，请先在多维表中创建 Base 或取得相应权限。</p>
          <button type="submit" :disabled="!validTarget">预览分享范围</button>
        </fieldset>
      </form>
      <section v-if="preview" data-testid="collaboration-preview" aria-label="分享预览">
        <p>目标：{{ selectedBaseName }} / {{ name.trim() }}</p>
        <p>来源：{{ preview.source.tenantId }} / {{ preview.source.orgId }} · Part {{ preview.part.partId }} · {{ preview.part.itemNumber }} {{ preview.part.name }}</p>
        <p>已验证 PLM 账号：{{ preview.source.authUserId }}</p>
        <p>{{ preview.lineCount }} 条逻辑 BOM 行，{{ preview.occurrenceCount }} 次树中出现；重复出现共用同一行本地协作数据。</p>
        <p>快照时间：{{ preview.snapshotAt }}；本次预览有效至 {{ preview.expiresAt }}。</p>
        <label><input v-model="confirmed" type="checkbox" :disabled="busy" data-testid="collaboration-consent" />我确认将以上 PLM 来源快照分享至所选目标，并按该表当前及后续权限提供访问。</label>
        <button type="button" :disabled="busy || !confirmed" @click="confirmShare">确认分享并打开协作表</button>
      </section>
      <section aria-label="已有协作表">
        <h4>已有协作表</h4>
        <p v-if="loaded && !bindings.length">此来源暂无当前可访问的协作表。</p>
        <ul>
          <li v-for="binding in bindings" :key="binding.id" :data-binding-id="binding.id">
            <strong>{{ binding.name }}</strong> · {{ bindingErrors[binding.id] ? '刷新失败，保留上次快照' : statusLabel(binding.status) }}
            <p v-if="bindingErrors[binding.id]">{{ bindingErrors[binding.id] }}</p>
            <p>上次同步 {{ binding.lastSyncedAt }} · {{ binding.lineCount }} 条逻辑行 / {{ binding.occurrenceCount }} 次出现</p>
            <button type="button" :disabled="busy" @click="openBinding(binding)">打开协作表</button>
            <button v-if="binding.canRefresh" type="button" :disabled="busy" @click="changeBinding(binding, 'refresh')">刷新来源快照</button>
            <button v-if="binding.canDisable" type="button" :disabled="busy" @click="changeBinding(binding, 'disable')">停用后续刷新</button>
            <button v-if="binding.canConfigureNotifications" type="button" :disabled="busy" @click="notificationBinding = binding.id">配置通知规则</button>
            <button v-if="binding.canConfigureNotifications" type="button" :disabled="busy" @click="completionBinding = binding.id">配置完成 Webhook</button>
            <button v-if="binding.canConfigureNotifications" type="button" :disabled="busy" @click="listenerBinding = binding.id">配置来源监听</button>
          </li>
        </ul>
      </section>
      <PlmBomChangeListenerConfig v-if="selectedListenerBinding" :key="selectedListenerBinding.id" :binding-id="selectedListenerBinding.id" :binding-version="selectedListenerBinding.version" @reload-binding="load" @close="listenerBinding = ''" />
      <PlmBomCompletionWebhookConfig v-if="completionBinding" :key="completionBinding" :binding-id="completionBinding" @close="completionBinding = ''" />
      <PlmBomNotificationConfig v-if="notificationBinding" :key="notificationBinding" :binding-id="notificationBinding" @close="notificationBinding = ''" />
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { onAuthSessionSwitch } from '../../composables/authPrincipal'
import { AppRouteNames } from '../../router/types'
import { randomUuid } from '../../utils/uuid'
import PlmBomChangeListenerConfig from './PlmBomChangeListenerConfig.vue'
import PlmBomCompletionWebhookConfig from './PlmBomCompletionWebhookConfig.vue'
import PlmBomNotificationConfig from './PlmBomNotificationConfig.vue'
import {
  changePlmBomCollaboration, createPlmBomCollaboration, listPlmBomCollaborationBases,
  listPlmBomCollaborations, PlmBomCollaborationError, previewPlmBomCollaboration,
  type PlmBomCollaborationBinding, type PlmBomCollaborationPreview,
} from '../../services/plm/plmBomCollaboration'

const props = defineProps<{ dataSourceId: string; partId: string }>()
const emit = defineEmits<{ close: [] }>()
const router = useRouter()
const bases = ref<Array<{ id: string; name: string }>>([])
const bindings = ref<PlmBomCollaborationBinding[]>([])
const bindingErrors = ref<Record<string, string>>({})
const baseId = ref('')
const name = ref('')
const preview = ref<PlmBomCollaborationPreview | null>(null)
const confirmed = ref(false)
const busy = ref(false)
const loaded = ref(false)
const error = ref('')
const message = ref('')
const notificationBinding = ref(''),completionBinding = ref(''),listenerBinding = ref('')
const selectedListenerBinding = computed(() => bindings.value.find(row => row.id === listenerBinding.value && row.canConfigureNotifications))
let requestId = ''
let generation = 0
let controller: AbortController | undefined
const validTarget = computed(() => bases.value.some((base) => base.id === baseId.value) && name.value.trim().length > 0)
const selectedBaseName = computed(() => bases.value.find((base) => base.id === baseId.value)?.name ?? '')

function clearPreview() { preview.value = null; confirmed.value = false; requestId = '' }
watch([baseId, name], clearPreview, { flush: 'sync' })
function invalidate() { generation++; controller?.abort(); busy.value = false; bindingErrors.value = {}; notificationBinding.value = ''; completionBinding.value = ''; listenerBinding.value = ''; clearPreview() }
function close() { invalidate(); emit('close') }
const unsubscribe = onAuthSessionSwitch(() => { bindings.value = []; bases.value = []; close() })
onBeforeUnmount(() => { invalidate(); unsubscribe() })
watch(() => [props.dataSourceId, props.partId], () => {
  invalidate(); bases.value = []; bindings.value = []; baseId.value = ''; name.value = ''; loaded.value = false
  void load()
})
onMounted(load)

async function perform(action: (signal: AbortSignal) => Promise<() => void | Promise<void>>, onFailure?: (message: string) => void) {
  if (busy.value) return
  const current = generation
  controller = new AbortController()
  busy.value = true; error.value = ''; message.value = ''
  try {
    const apply = await action(controller.signal)
    if (current === generation) await apply()
  } catch (cause) {
    if (current === generation) {
      error.value = cause instanceof PlmBomCollaborationError ? cause.message : '请求未完成，请重新加载状态后重试。'
      onFailure?.(error.value)
      if (cause instanceof PlmBomCollaborationError && ['SOURCE_CHANGED', 'PREVIEW_EXPIRED'].includes(cause.code)) clearPreview()
    }
  } finally { if (current === generation) busy.value = false }
}
function load() {
  clearPreview()
  return perform(async (signal) => {
    const [nextBases, nextBindings] = await Promise.all([
      listPlmBomCollaborationBases(signal), listPlmBomCollaborations(props.dataSourceId, props.partId, signal),
    ])
    return () => {
      bases.value = nextBases; bindings.value = nextBindings; bindingErrors.value = {}; loaded.value = true
      if (!nextBindings.some((row) => row.id === notificationBinding.value && row.canConfigureNotifications)) notificationBinding.value = ''
      if (!nextBindings.some((row) => row.id === completionBinding.value && row.canConfigureNotifications)) completionBinding.value = ''
      if (!nextBindings.some((row) => row.id === listenerBinding.value && row.canConfigureNotifications)) listenerBinding.value = ''
    }
  })
}
function previewShare() {
  if (!validTarget.value || busy.value) return
  clearPreview()
  const input = { dataSourceId: props.dataSourceId, partId: props.partId, baseId: baseId.value, name: name.value.trim() }
  return perform(async (signal) => {
    const result = await previewPlmBomCollaboration(input, signal)
    return () => { requestId = randomUuid(); preview.value = result }
  })
}
function confirmShare() {
  if (!preview.value || !confirmed.value || !requestId || busy.value) return
  if (Date.parse(preview.value.expiresAt) <= Date.now()) {
    clearPreview(); error.value = new PlmBomCollaborationError('PREVIEW_EXPIRED').message; return
  }
  const previewId = preview.value.previewId
  const target = { dataSourceId: props.dataSourceId, partId: props.partId, baseId: baseId.value }
  return perform(async (signal) => {
    const binding = await createPlmBomCollaboration(previewId, requestId, signal)
    if (binding.dataSourceId !== target.dataSourceId || binding.partId !== target.partId || binding.baseId !== target.baseId) {
      throw new PlmBomCollaborationError('INVALID_RESPONSE')
    }
    return async () => {
      bindings.value = [binding, ...bindings.value.filter((row) => row.id !== binding.id)]
      clearPreview(); message.value = '协作表已创建。后续编辑由多维表权限控制。'
      await openBinding(binding)
    }
  })
}
function changeBinding(binding: PlmBomCollaborationBinding, action: 'refresh' | 'disable') {
  return perform(async (signal) => {
    const result = await changePlmBomCollaboration(binding.id, action, binding.version, signal)
    if (result.dataSourceId !== props.dataSourceId || result.partId !== props.partId || result.sheetId !== binding.sheetId || result.baseId !== binding.baseId) {
      throw new PlmBomCollaborationError('INVALID_RESPONSE')
    }
    return () => {
      bindings.value = bindings.value.map((row) => row.id === result.id ? result : row)
      const { [result.id]: _oldError, ...remainingErrors } = bindingErrors.value
      bindingErrors.value = remainingErrors
      message.value = action === 'refresh' ? '来源快照已刷新，本地协作字段保留。' : '已停用后续刷新；已有快照和本地协作数据保留。'
    }
  }, (failure) => { if (action === 'refresh') bindingErrors.value = { ...bindingErrors.value, [binding.id]: failure } })
}
async function openBinding(binding: PlmBomCollaborationBinding) {
  try {
    // Use native route identifiers, never a backend-provided arbitrary URL.
    await router.push({ name: AppRouteNames.MULTITABLE, params: { sheetId: binding.sheetId, viewId: binding.viewId }, query: { baseId: binding.baseId } })
  } catch { error.value = '未能打开协作表，请重试打开。' }
}
function statusLabel(status: PlmBomCollaborationBinding['status']) {
  return { active: '上次快照已保存', stale: '来源待刷新或已失效', disabled: '已停用刷新' }[status]
}
</script>

<style scoped>
.bom-collaboration__overlay { position: fixed; inset: 0; z-index: 1000; background: #0006; display: grid; place-items: center; padding: 24px; }
.bom-collaboration { background: var(--bg-color, white); color: var(--text-color, #1f2937); border-radius: 8px; padding: 20px; width: min(760px, 100%); max-height: 90vh; overflow: auto; }
.bom-collaboration header { display: flex; justify-content: space-between; align-items: center; }
.bom-collaboration h3 { margin: 0; }
.bom-collaboration fieldset { display: flex; flex-direction: column; gap: 12px; margin: 16px 0; }
.bom-collaboration label { display: block; }
.bom-collaboration label input:not([type=checkbox]), .bom-collaboration select { display: block; margin-top: 4px; min-width: 240px; }
.bom-collaboration button { margin: 4px 8px 4px 0; }
.bom-collaboration li { margin: 12px 0; }
.bom-collaboration [role=alert] { color: #b91c1c; }
</style>
