<template>
  <section class="plm-visual-preview" data-testid="plm-visual-preview">
    <header><strong>文件预览与标注</strong></header>
    <p v-if="state === 'loading'">正在读取可预览文件…</p>
    <div v-else-if="state === 'denied' || state === 'offline'" :data-testid="`plm-visual-preview-${state}`" role="status">
      <p>{{ state === 'denied' ? '当前无法访问此预览。请确认访问权限后重新加载。' : '当前处于离线状态，连接恢复后可重新加载预览。' }}</p>
      <button v-if="parentOrigin" type="button" @click="loadFiles">重新加载</button>
    </div>
    <div v-else-if="state === 'unavailable'" data-testid="plm-visual-preview-unavailable">
      <p>当前没有可用的真实预览。</p>
      <button v-if="parentOrigin" type="button" @click="loadFiles">重新加载</button>
    </div>
    <template v-else-if="files.length">
      <label>选择文件
        <select v-model="selectedIndex" :disabled="busy" data-testid="plm-visual-preview-select" @change="clearImage">
          <option v-for="(file, index) in files" :key="`${file.version_id}:${file.file_id}`" :value="index">
            {{ file.filename }}{{ file.version_is_current ? '' : '（历史版本，只读）' }}
          </option>
        </select>
      </label>
      <button type="button" :disabled="busy || state === 'previewing' || !parentOrigin" @click="preview">
        {{ state === 'previewing' ? '正在加载…' : '预览' }}
      </button>
      <small v-if="hasMore">仅显示前 50 个可预览文件。</small>
      <p v-if="state === 'missing'" data-testid="plm-visual-preview-missing">该文件当前没有可用的真实预览。</p>
      <template v-if="imageUrl && descriptor">
        <p v-if="stale || !descriptor.version_is_current" role="status" data-testid="plm-visual-stale">此预览已过期或属于历史版本，标注只读。请选择当前文件并重新加载。</p>
        <p v-else>在图上选择位置，再在讨论中填写内容并提交。加载讨论详情可查看已有标注。</p>
        <PlmVisualMarkupCanvas
          :key="imageUrl" :image-url="imageUrl" :filename="files[selectedIndex]?.filename || '文件预览'"
          :asset-width="descriptor.preview_width" :asset-height="descriptor.preview_height"
          :annotations="annotations" :writable="!busy && !stale && descriptor.version_is_current"
          :selected-id="selectedId || null" @create="createDraft" @select="emit('select', $event)" />
        <p v-if="draft" data-testid="plm-visual-draft">位置已附加到讨论输入区；提交后才会保存。</p>
        <ul v-if="unplaced.length" aria-label="未显示在当前预览的标注" data-testid="plm-visual-unplaced">
          <li v-for="comment in unplaced" :key="comment.id">
            <button type="button" @click="emit('select', comment.id)">{{ comment.body }}</button>
            <small>{{ comment.markup?.binding_state === 'legacy_unbound' ? '历史标注未绑定预览' : '不属于当前预览或已过期' }}</small>
          </li>
        </ul>
      </template>
    </template>
    <p v-else data-testid="plm-visual-preview-empty">该 Part 没有可预览文件。</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import PlmVisualMarkupCanvas from './PlmVisualMarkupCanvas.vue'
import { createPlmEmbedVisualPreviewTokenClient, createPlmEmbedReadTokenClient, PlmEmbedReadTokenError, type PlmEmbedVisualPreviewTokenClient } from '../../services/integration/plmEmbedWriteToken'
import { listVisualPreviewFiles, loadVisualPreview, VisualPreviewAccessError, type VisualPreviewFile } from '../../services/integration/plmEmbedVisualPreview'
import { sameVisualPreview, visualMarkupWrite, type VisualComment, type VisualGeometry,
  type VisualMarkupDraft, type VisualMarkupTool, type VisualPreviewDescriptor } from '../../services/integration/plmVisualMarkup'

const props = defineProps<{ parentOrigin: string | null; partId: string; managedSourceId?: string; comments?: VisualComment[];
  draft?: VisualMarkupDraft | null; selectedId?: string | null; busy?: boolean }>()
const emit = defineEmits<{ draft: [draft: VisualMarkupDraft | null]; select: [id: string] }>()
const files = ref<VisualPreviewFile[]>([])
const hasMore = ref(false)
const selectedIndex = ref(0)
const imageUrl = ref<string | null>(null)
const descriptor = ref<VisualPreviewDescriptor | null>(null)
const stale = ref(false)
const state = ref<'loading' | 'ready' | 'previewing' | 'missing' | 'unavailable' | 'denied' | 'offline'>('loading')
let client: PlmEmbedVisualPreviewTokenClient | null = null
let generation = 0
let controller: AbortController | null = null

const annotations = computed(() => (props.comments || []).flatMap((comment) => {
  const markup = comment.markup
  return descriptor.value && markup?.binding_state === 'bound' && sameVisualPreview(descriptor.value, markup.descriptor)
    ? [{ id: comment.id, body: comment.body, markup_type: markup.markup.markup_type, geometry: markup.markup.geometry }] : []
}))
const unplaced = computed(() => (props.comments || []).filter((comment) => comment.markup
  && !annotations.value.some((annotation) => annotation.id === comment.id)))

function clearImage(): void {
  generation += 1
  controller?.abort()
  controller = null
  if (imageUrl.value) URL.revokeObjectURL(imageUrl.value)
  imageUrl.value = null
  descriptor.value = null
  stale.value = false
  emit('draft', null)
  if (files.value.length) state.value = 'ready'
}

function invalidate(reason: 'stale' | 'denied' = 'stale'): void {
  if (reason === 'denied') {
    clearImage()
    files.value = []
    state.value = 'denied'
    return
  }
  stale.value = true
  emit('draft', null)
}
defineExpose({ invalidate })

function createDraft(value: { markup_type: VisualMarkupTool; geometry: VisualGeometry }): void {
  const asset = descriptor.value
  if (!asset || props.busy || stale.value || !visualMarkupWrite(asset, value.markup_type, value.geometry)) return
  emit('draft', { descriptor: { ...asset }, tool: value.markup_type, geometry: { ...value.geometry } })
}

async function freshToken(current: number): Promise<string | undefined> {
  const activeClient = client
  if (!activeClient) return undefined
  try { return await activeClient.requestToken() }
  catch (error) {
    if (!(error instanceof PlmEmbedReadTokenError) || error.message !== 'rate_limited') throw error
    await new Promise((resolve) => setTimeout(resolve, 6100))
    if (current !== generation || client !== activeClient) return undefined
    return activeClient.requestToken()
  }
}

async function loadFiles(): Promise<void> {
  clearImage()
  const current = generation
  files.value = []
  hasMore.value = false
  if (!props.parentOrigin || !client) { state.value = 'unavailable'; return }
  const activeController = controller = new AbortController()
  state.value = 'loading'
  try {
    const token = await freshToken(current)
    if (!token || current !== generation) return
    const result = await listVisualPreviewFiles(token, activeController.signal, props.managedSourceId)
    if (current !== generation) return
    if (!result) { state.value = 'unavailable'; return }
    files.value = result.files
    hasMore.value = result.hasMore
    selectedIndex.value = 0
    state.value = 'ready'
  } catch (error) {
    if (current === generation) state.value = error instanceof VisualPreviewAccessError ? error.reason : 'unavailable'
  }
}

async function preview(): Promise<void> {
  const file = files.value[selectedIndex.value]
  if (!file || !client || !props.parentOrigin || props.busy || state.value === 'previewing') return
  clearImage()
  const current = generation
  const activeController = controller = new AbortController()
  state.value = 'previewing'
  try {
    const token = await freshToken(current)
    if (!token || current !== generation) return
    const result = await loadVisualPreview(token, file, props.partId, activeController.signal, props.managedSourceId)
    if (current !== generation) return
    if (result.render !== 'available') { state.value = 'missing'; return }
    // The rendered coordinate system must agree with the authenticated descriptor.
    const bitmap = await createImageBitmap(result.blob)
    const dimensionsMatch = bitmap.width === result.descriptor.preview_width && bitmap.height === result.descriptor.preview_height
    bitmap.close()
    if (current !== generation) return
    if (!dimensionsMatch) { state.value = 'missing'; return }
    descriptor.value = result.descriptor
    imageUrl.value = URL.createObjectURL(result.blob)
    state.value = 'ready'
  } catch (error) {
    if (current === generation) state.value = error instanceof VisualPreviewAccessError ? error.reason : 'missing'
  }
}

watch(() => [props.parentOrigin, props.partId, props.managedSourceId], () => {
  clearImage()
  client?.dispose()
  if (props.parentOrigin && props.managedSourceId !== undefined) {
    const reader = createPlmEmbedReadTokenClient(() => props.parentOrigin)
    client = { requestToken: () => reader.requestReadToken(), dispose: () => reader.dispose() }
  } else client = props.parentOrigin ? createPlmEmbedVisualPreviewTokenClient(() => props.parentOrigin) : null
  void loadFiles()
}, { immediate: true })

onBeforeUnmount(() => {
  clearImage()
  client?.dispose()
  client = null
})
</script>

<style scoped>
.plm-visual-preview { display: flex; flex-direction: column; align-items: stretch; gap: 8px; min-width: 0; }
.plm-visual-preview select { max-width: 100%; }
.plm-visual-preview button { align-self: flex-start; max-width: 100%; overflow-wrap: anywhere; }
</style>
