<template>
  <section aria-label="固定接头图预览">
    <button :disabled="disabled || busy" @click="read">读取并预览固定接头图</button>
    <p>预览已登记的固定版本，不代表专业适用性。</p>
    <img v-if="url" :src="url" alt="已验证固定接头图" style="max-width: 100%; max-height: 360px">
    <p v-if="message" role="alert">{{ message }}</p>
  </section>
</template>
<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { onAuthPrincipalChange, TOKEN_KEYS } from '../../composables/authPrincipal'
import { EXPLICIT_SESSION_ORG_KEY } from '../../utils/explicitSessionOrg'
import { resourceDiagram, type ResourceMaintenanceRecord } from '../../services/welding/resourceContracts'
import type { RequestScope } from '../../services/welding/planClient'
import { need } from '../../services/welding/planRecovery'
const props = defineProps<{ stamp: string; disabled?: boolean; load: (scope: RequestScope) => Promise<{ blob: Blob; record: ResourceMaintenanceRecord; scope: RequestScope }> }>()
const emit = defineEmits<{ ready: [value: { record: ResourceMaintenanceRecord; scope: RequestScope } | null] }>()
const url = ref(''), busy = ref(false), message = ref('')
let epoch = 0, controller = new AbortController(), pendingUrl = '', cancelImage = () => {}
function clear() {
  epoch++; controller.abort(); controller = new AbortController(); cancelImage(); cancelImage = () => {}
  if (url.value) URL.revokeObjectURL(url.value)
  if (pendingUrl) URL.revokeObjectURL(pendingUrl)
  url.value = ''; pendingUrl = ''; busy.value = false; message.value = ''; emit('ready', null)
}
async function read() {
  if (props.disabled || busy.value) return
  clear(); const serial = epoch, signal = controller.signal
  const local: RequestScope = { signal, accepts: () => serial === epoch && !signal.aborted && !props.disabled }
  busy.value = true
  try {
    const active = controller
    let rejectRead!: (error: Error) => void
    const stopped = new Promise<never>((_resolve, reject) => { rejectRead = reject })
    const stop = () => rejectRead(new Error('接头图读取已取消或超过 30 秒'))
    signal.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(() => active.abort(), 30000)
    let result: Awaited<ReturnType<typeof props.load>>
    try { result = await Promise.race([props.load(local), stopped]) }
    finally { clearTimeout(timer); signal.removeEventListener('abort', stop) }
    const check = () => need(local.accepts() && result.scope.accepts() && !result.scope.signal?.aborted, '接头图预览已变化')
    check(); const diagram = resourceDiagram(result.record)
    need(result.blob.size === diagram.byte_size && result.blob.type === diagram.mime_type)
    pendingUrl = URL.createObjectURL(result.blob)
    const image = new Image(), imageUrl = pendingUrl
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); image.onload = image.onerror = null; if (serial === epoch) cancelImage = () => {}; error ? reject(error) : resolve() }
      const timer = setTimeout(() => finish(new Error('接头图显示超过 15 秒')), 15000)
      cancelImage = () => { finish(new Error('接头图预览已取消')); image.src = '' }
      image.onload = () => { try { check(); need(image.naturalWidth === diagram.width && image.naturalHeight === diagram.height, '接头图显示尺寸不匹配'); finish() } catch (e) { finish(e instanceof Error ? e : new Error('接头图无法显示')) } }
      image.onerror = () => finish(new Error('接头图无法显示'))
      image.src = imageUrl
    })
    check(); url.value = pendingUrl; pendingUrl = ''
    emit('ready', { record: result.record, scope: { signal, accepts: () => local.accepts() && result.scope.accepts() && !result.scope.signal?.aborted } })
  } catch (error) {
    if (serial === epoch) { clear(); message.value = error instanceof Error ? error.message : '接头图无法确认' }
  } finally { if (serial === epoch) busy.value = false }
}
watch(() => [props.stamp, props.disabled], clear, { flush: 'sync' })
const stopAuth = onAuthPrincipalChange(clear)
function storage(event: StorageEvent) {
  if (event.storageArea && event.storageArea !== localStorage) return
  if (event.key === null || event.key === EXPLICIT_SESSION_ORG_KEY || (TOKEN_KEYS as readonly string[]).includes(event.key)) clear()
}
window.addEventListener('storage', storage)
onBeforeUnmount(() => { clear(); stopAuth(); window.removeEventListener('storage', storage) })
</script>
