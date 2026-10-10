<template>
  <section class="manual-archive" data-test="manual-archive" :aria-label="t('手动归档', 'Manual archive')">
    <strong>{{ t('手动归档', 'Manual archive') }}</strong>
    <p class="manual-archive__table">{{ sheetName || sheetId }}</p>
    <p v-if="status" role="status" data-test="manual-archive-status">{{ stateLabel }}</p>
    <p v-if="error" role="alert" data-test="manual-archive-error">{{ error }}</p>
    <label v-if="!status || status.state === 'pending'">
      <input v-model="confirmed" type="checkbox" :disabled="busy" data-test="manual-archive-confirm" />
      {{ t('确认归档当前数据表，不修改现有数据', 'Archive this table without changing its current data') }}
    </label>
    <div class="manual-archive__actions">
      <MtButton v-if="!status || status.state === 'pending'" variant="primary" :disabled="busy || !confirmed" data-test="manual-archive-submit" @click="submit">
        {{ busy ? t('处理中', 'Working') : requestId ? t('重试原归档', 'Retry archive') : t('创建归档', 'Create archive') }}
      </MtButton>
      <MtIconButton v-if="requestId" :icon="RefreshRight" :title="t('刷新归档状态', 'Refresh archive status')" :aria-label="t('刷新归档状态', 'Refresh archive status')" :disabled="busy" data-test="manual-archive-refresh" @click="refresh" />
      <MtButton v-if="status && status.state !== 'pending'" variant="plain" :disabled="busy" data-test="manual-archive-new" @click="startNew">{{ t('准备新归档', 'New archive') }}</MtButton>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { RefreshRight } from '@element-plus/icons-vue'
import type { RecoveryArchiveCaptureStatus } from '../api/client'
import { MtButton, MtIconButton } from '../ui'

const props = defineProps<{
  sheetId: string
  sheetName?: string
  isZh: boolean
  capture: (sheetId: string, requestId: string) => Promise<RecoveryArchiveCaptureStatus>
  read: (sheetId: string, requestId: string) => Promise<RecoveryArchiveCaptureStatus>
}>()
const emit = defineEmits<{ (e: 'completed'): void }>()
const requestId = ref<string | null>(null)
const status = ref<RecoveryArchiveCaptureStatus | null>(null)
const confirmed = ref(false)
const busy = ref(false)
const error = ref('')
let epoch = 0
const t = (zh: string, en: string) => props.isZh ? zh : en
const storageKey = (sheetId: string) => `metasheet.manual-archive.request:${sheetId}`
const stateLabel = computed(() => status.value?.state === 'recoverable'
  ? t('归档可用于恢复', 'Archive available for recovery')
  : status.value?.state === 'incomplete'
    ? t('归档未完成或已过期', 'Archive incomplete or expired')
    : t('归档尚未完成，可刷新状态或重试原请求', 'Archive pending; refresh status or retry the original request'))

function failure(cause: unknown): string {
  const code = (cause as { status?: number } | null)?.status
  if (code === 401 || code === 403) return t('当前身份无权归档此表', 'Your current identity cannot archive this table')
  if (code === 409) return t('归档请求冲突，请刷新状态', 'Archive request conflict; refresh its status')
  if (code === 503 && (cause as { code?: unknown } | null)?.code === 'RECOVERY_ARCHIVE_MANUAL_ATTACHMENT_UNAVAILABLE') {
    return t('附件内容或存储配置不可用；本次归档未完成。',
      'Attachment content or storage configuration is unavailable; this archive is incomplete.')
  }
  return t('归档当前不可用，请检查配置后重试', 'Archive unavailable; check configuration and retry')
}

async function run(create: boolean): Promise<void> {
  if (busy.value || !props.sheetId || (create && !confirmed.value)) return
  const sheet = props.sheetId
  const ownEpoch = epoch
  busy.value = true
  error.value = ''
  try {
    if (!requestId.value) {
      if (!create) return
      const id = crypto.randomUUID()
      // Persist before sending so an interrupted POST can be retried, never silently duplicated.
      sessionStorage.setItem(storageKey(sheet), id)
      requestId.value = id
    }
    const result = await (create ? props.capture : props.read)(sheet, requestId.value)
    if (epoch !== ownEpoch) return
    const wasPending = status.value?.state === 'pending'
    status.value = result
    if (result.state === 'recoverable') {
      confirmed.value = false
      if (create || wasPending) emit('completed')
    }
  } catch (cause) {
    if (epoch !== ownEpoch) return
    status.value = null
    // The server scopes request lookup to the current actor. Do not reuse another actor's request.
    if (!create && (cause as { status?: number } | null)?.status === 404) {
      try { sessionStorage.removeItem(storageKey(sheet)) } catch { /* No write is performed here. */ }
      requestId.value = null
      status.value = null
    } else error.value = failure(cause)
  } finally {
    if (epoch === ownEpoch) busy.value = false
  }
}
const submit = () => run(true)
const refresh = () => run(false)
function startNew(): void {
  if (busy.value || !status.value || status.value.state === 'pending') return
  try { sessionStorage.removeItem(storageKey(props.sheetId)) } catch {
    error.value = t('无法保存归档请求，请检查浏览器存储', 'Cannot persist archive request; check browser storage')
    return
  }
  requestId.value = null
  status.value = null
  confirmed.value = false
  error.value = ''
}
watch(() => props.sheetId, () => {
  epoch++
  requestId.value = null
  status.value = null
  confirmed.value = false
  busy.value = false
  error.value = ''
  try {
    const stored = sessionStorage.getItem(storageKey(props.sheetId))
    if (stored && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(stored)) requestId.value = stored
    if (requestId.value) void refresh()
  } catch {
    error.value = t('无法读取归档请求，请检查浏览器存储', 'Cannot read archive request; check browser storage')
  }
}, { immediate: true })
onBeforeUnmount(() => { epoch++ })
</script>

<style scoped>
.manual-archive { border-bottom: 1px solid var(--el-border-color-light, #ddd); padding-bottom: 16px; margin-bottom: 16px; }
.manual-archive__table { overflow-wrap: anywhere; }
.manual-archive label { display: flex; gap: 8px; align-items: flex-start; }
.manual-archive__actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
</style>
