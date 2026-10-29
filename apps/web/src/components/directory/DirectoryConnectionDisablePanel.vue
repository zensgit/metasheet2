<template>
  <section class="connection-disable" aria-label="停用钉钉连接">
    <h3>停用钉钉连接</h3>
    <p>保留本地账号、成员权限、历史关联和业务数据；不关闭钉钉登录授权，不接入企业微信。客户更名无需停用连接。独立群机器人 Webhook 需单独处理。</p>
    <label>停用范围
      <select v-model="scope" :disabled="busy" @change="resetPreview">
        <option value="integration">仅当前集成</option>
        <option value="enterprise">本企业现有全部集成（同一本地组织和 Corp ID）</option>
      </select>
    </label>
    <button type="button" :disabled="busy" @click="preview">预览停用影响</button>
    <template v-if="impact">
      <p>当前预览涉及 {{ impact.integrationCount }} 个集成，其中 {{ impact.disabledCount }} 个已停用。提交时按所选范围的现有集成执行。停止目录同步和相关发送，历史消息不会撤回。</p>
      <label><input v-model="confirmed" type="checkbox" :disabled="busy" />确认仅停用连接，保留成员和数据</label>
      <button type="button" :disabled="busy || !confirmed" @click="disable">确认停用连接</button>
    </template>
    <p v-if="message" role="status">{{ message }}</p>
  </section>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { apiFetch } from '../../utils/api'

const props = defineProps<{ integrationId: string }>()
const emit = defineEmits<{ disabled: [] }>()
const scope = ref<'integration' | 'enterprise'>('integration')
const busy = ref(false)
const confirmed = ref(false)
const impact = ref<{ integrationCount: number; disabledCount: number } | null>(null)
const message = ref('')
function resetPreview() { impact.value = null; confirmed.value = false; message.value = '' }
watch(() => props.integrationId, resetPreview)

async function preview() {
  resetPreview()
  busy.value = true
  const id = props.integrationId
  try {
    const response = await apiFetch(`/api/admin/directory/integrations/${encodeURIComponent(id)}/disable-preview?scope=${scope.value}`)
    const body = await response.json()
    if (id !== props.integrationId) return
    if (!response.ok || !Number.isInteger(body?.data?.integrationCount) || !Number.isInteger(body?.data?.disabledCount) || body.data.integrationCount < 1 || body.data.disabledCount < 0 || body.data.disabledCount > body.data.integrationCount) throw new Error()
    impact.value = body.data
  } catch { message.value = '无法预览停用影响，未修改任何配置。' }
  finally { busy.value = false }
}
async function disable() {
  if (!confirmed.value || !impact.value) return
  busy.value = true
  try {
    const response = await apiFetch(`/api/admin/directory/integrations/${encodeURIComponent(props.integrationId)}/disable`, {
      method: 'POST', body: JSON.stringify({ scope: scope.value }),
    })
    if (!response.ok) {
      const body = await response.json()
      message.value = body?.error?.code === 'DIRECTORY_CONNECTION_APP_SHARED'
        ? '应用凭据被范围外的集成共用，未停用。请先拆分连接。'
        : '停用未确认成功，请刷新后核对；不要重复提交。'
      return
    }
    const body = await response.json()
    if (body?.data?.disabled !== true) throw new Error()
    resetPreview()
    message.value = '钉钉连接已停用，本地账号、成员权限和业务数据已保留。登录授权未变更。'
    emit('disabled')
  } catch { message.value = '无法确认停用结果，请刷新后核对；不要重复提交。' }
  finally { busy.value = false }
}
</script>

<style scoped>
.connection-disable { margin-block: 1rem; padding: 1rem; border: 1px solid #dcdfe6; border-radius: 8px; }
.connection-disable button, .connection-disable select { margin: 0.4rem; padding: 0.4rem; }
</style>
