<template>
  <section class="identity-panel" data-testid="directory-identity-panel">
    <h3>企业与应用归属核验</h3>
    <p>核对钉钉后台的企业、应用 Client ID 和应用所属企业后，再记录管理员核验。名称保存不会修改凭据、账号关联或同步开关。</p>
    <p v-if="integration.config.identityVerification">
      来源：管理员后台核验 · 时间：{{ integration.config.identityVerification.checkedAt }}
    </p>
    <label>
      应用所属企业名称
      <input v-model.trim="appCorpName" maxlength="200" data-testid="identity-owner-name" />
    </label>
    <label>
      应用所属企业 Corp ID
      <input v-model.trim="appCorpId" maxlength="512" data-testid="identity-owner-id" autocomplete="off" />
    </label>
    <label>
      <input v-model="confirmed" type="checkbox" data-testid="identity-confirm" />
      我已在钉钉后台核对当前企业、应用及所属企业
    </label>
    <p v-if="configurationChanged">请先保存企业标识或凭据变更，再重新核验。</p>
    <button type="button" :disabled="busy || configurationChanged || (confirmed && !confirmationComplete)" @click="void save()">
      {{ busy ? '保存中…' : confirmed ? '保存并记录管理员核验' : '仅保存展示名称' }}
    </button>
    <p v-if="message" role="status">{{ message }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { apiFetch } from '../../utils/api'

const props = defineProps<{
  integration: {
    id: string
    corpId: string
    config: {
      appKey: string
      identityVerification?: { appCorpId: string; appCorpName: string; checkedAt: string } | null
    }
  }
  corpName: string
  appName: string
  configurationChanged: boolean
}>()
const emit = defineEmits<{ saved: [] }>()
const appCorpName = ref('')
const appCorpId = ref('')
const confirmed = ref(false)
const busy = ref(false)
const message = ref('')
const confirmationComplete = computed(() => props.corpName.trim() && props.appName.trim() && appCorpId.value && appCorpName.value)
watch(() => props.integration, (integration) => {
  appCorpName.value = integration.config.identityVerification?.appCorpName ?? ''
  appCorpId.value = integration.config.identityVerification?.appCorpId ?? ''
  confirmed.value = false
  message.value = ''
}, { immediate: true })
watch(() => [props.corpName, props.appName, props.configurationChanged, appCorpName.value, appCorpId.value], () => { confirmed.value = false })

async function save() {
  if (busy.value || props.configurationChanged || (confirmed.value && !confirmationComplete.value)) return
  const integration = props.integration
  busy.value = true
  message.value = ''
  try {
    const response = await apiFetch(`/api/admin/directory/integrations/${integration.id}/identity`, {
      method: 'PUT',
      body: JSON.stringify({
        corpId: integration.corpId,
        appKey: integration.config.appKey,
        corpName: props.corpName.trim(),
        appName: props.appName.trim(),
        confirm: confirmed.value,
        ...(confirmed.value ? { appCorpId: appCorpId.value, appCorpName: appCorpName.value } : {}),
      }),
    })
    if (!response.ok) throw new Error(response.status === 409 ? '身份配置已变化，请刷新后重新核验。' : '保存身份信息失败，请重试。')
    const body = await response.json()
    if (!body?.data?.integration) throw new Error('未收到保存结果，请刷新核对。')
    if (props.integration.id !== integration.id) return
    confirmed.value = false
    emit('saved')
    message.value = '身份信息已保存，请以列表中的核验状态为准。'
  } catch (error) {
    if (props.integration.id === integration.id) message.value = error instanceof Error ? error.message : '保存身份信息失败，请重试。'
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.identity-panel { display: grid; gap: 10px; margin-top: 16px; padding: 16px; border: 1px solid #d1d5db; border-radius: 8px; }
.identity-panel h3, .identity-panel p { margin: 0; }
.identity-panel p { color: #475569; font-size: 14px; line-height: 1.5; }
.identity-panel label { display: block; }
.identity-panel input:not([type='checkbox']) { display: block; width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 8px; }
.identity-panel button { justify-self: start; padding: 8px 12px; border: 0; border-radius: 8px; background: #1d4ed8; color: white; cursor: pointer; }
.identity-panel button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
