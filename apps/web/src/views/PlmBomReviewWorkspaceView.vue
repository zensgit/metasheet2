<template>
  <section
    class="plm-bom-workspace"
    data-testid="plm-bom-review-workspace"
    :data-eco-advisory="ecoIntentEnabled ? 'on' : 'off'"
  >
    <p
      v-if="blockReason"
      class="plm-bom-workspace__hint"
      data-testid="plm-bom-review-workspace-hint"
      :data-reason="blockReason"
    >
      {{ blockMessage }}
    </p>
    <template v-if="readySource">
      <p class="plm-bom-workspace__source" data-testid="plm-bom-review-workspace-source">
        数据源 {{ readySource }}
      </p>
      <p
        v-if="managedHint"
        class="plm-bom-workspace__hint"
        data-testid="plm-managed-ready"
      >
        {{ managedHint }}
      </p>
      <div class="plm-bom-workspace__managed" data-testid="plm-managed-companion">
        <button type="button" data-testid="plm-managed-start" @click="startManaged">用元图账号读取</button>
        <button type="button" data-testid="plm-managed-status-button" @click="loadManagedStatus">托管状态</button>
        <button type="button" data-testid="plm-managed-unlink" @click="unlinkManaged">解除托管</button>
        <p v-if="managedMessage" data-testid="plm-managed-status">{{ managedMessage }}</p>
      </div>
      <PlmBomReviewPanel
        :key="panelKey"
        :data-source-id="readySource"
        :initial-part-id="readyPart"
        :eco-intent-enabled="ecoIntentEnabled"
      />
      <PlmSnapshotSharePanel :data-source-id="readySource" :part-id="readyPart ?? ''" />
      <PlmBomChangeReadPanel :data-source-id="readySource" :part-id="readyPart ?? ''" />
      <PlmCollaborationSnapshotsPanel :data-source-id="readySource" :item-id="readyPart ?? ''" />
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter, type LocationQueryValue } from 'vue-router'
import {
  PlmManagedCompanionError,
  readManagedStatus,
  followManagedNavigation,
  startManagedLogin,
  unlinkManagedSource,
} from '../services/plm/plmManagedCompanion'
import { onAuthSessionSwitch, readAuthSessionSignature } from '../composables/authPrincipal'
import {
  getPlmDataSourceCapabilities,
  type PlmIntegrationCapabilitiesResult,
} from '../services/integration/workbench'
import PlmBomReviewPanel from '../components/plm/PlmBomReviewPanel.vue'
import PlmSnapshotSharePanel from '../components/plm/PlmSnapshotSharePanel.vue'
import PlmBomChangeReadPanel from '../components/plm/PlmBomChangeReadPanel.vue'
import PlmCollaborationSnapshotsPanel from '../components/plm/PlmCollaborationSnapshotsPanel.vue'

type QueryHint =
  | { status: 'missing' | 'blank' | 'array' | 'ambiguous' }
  | { status: 'ok'; value: string }

const HINTS: Record<string, string> = {
  'source-missing': '未指定数据源。不会读取任何数据源。',
  'source-blank': '数据源为空。不会读取任何数据源。',
  'source-array': '数据源参数不唯一。不会从中挑选，也不会读取。',
  'source-ambiguous': '数据源参数无法确定。不会改写后读取。',
  'part-blank': 'Part 参数为空。不会自动加载 BOM。',
  'part-array': 'Part 参数不唯一。不会从中挑选，也不会自动加载。',
  'part-ambiguous': 'Part 参数无法确定。不会改写后加载。',
}

const route = useRoute()
const router = useRouter()
const ecoIntentEnabled = ref(false)
const managedMessage = ref('')
let ticket = 0
let sessionSignature = readAuthSessionSignature()

function classifyQueryValue(raw: LocationQueryValue | LocationQueryValue[] | undefined): QueryHint {
  if (typeof raw === 'undefined') return { status: 'missing' }
  if (Array.isArray(raw)) return { status: 'array' }
  if (typeof raw !== 'string') return { status: 'ambiguous' }
  if (raw.length === 0 || raw.trim().length === 0) return { status: 'blank' }
  if (raw !== raw.trim()) return { status: 'ambiguous' }
  return { status: 'ok', value: raw }
}

// Same predicate as IntegrationWorkbenchView selectedPlmBomEcoIntentEnabled.
// A query param cannot turn this on, and a true result is not an authority grant.
function bomEcoRevisionIntentEnabled(result: PlmIntegrationCapabilitiesResult): boolean {
  if (!result.available) return false
  const feature = result.manifest.features.bom_eco_revision
  if (!feature || typeof feature !== 'object') return false
  if (feature.supported !== true || feature.entitled !== true) return false
  const actions = Array.isArray(feature.actions) ? feature.actions : []
  return actions.includes('eco_revision_intent')
}

const sourceHint = computed(() => classifyQueryValue(route.query.dataSourceId))
const partHint = computed(() => classifyQueryValue(route.query.partId))
const readySource = computed(() => (sourceHint.value.status === 'ok' ? sourceHint.value.value : ''))
const readyPart = computed(() => (
  sourceHint.value.status === 'ok' && partHint.value.status === 'ok' ? partHint.value.value : undefined
))
const blockReason = computed(() => {
  if (sourceHint.value.status !== 'ok') return `source-${sourceHint.value.status}`
  if (partHint.value.status !== 'missing' && partHint.value.status !== 'ok') return `part-${partHint.value.status}`
  return ''
})
const blockMessage = computed(() => HINTS[blockReason.value] ?? '')
const panelKey = computed(() => JSON.stringify([readySource.value, readyPart.value ?? null]))
const managedHint = computed(() => {
  const value = route.query.managed
  if (value === 'ready') return '元图读取会话已建立。授权仍只属于当前数据源负责人。'
  if (value === 'refused') return '元图读取会话没有建立。'
  return ''
})

function stripCallbackQuery(): void {
  const query = route.query
  if (typeof query.code === 'undefined' && typeof query.state === 'undefined') return
  const next: Record<string, LocationQueryValue | LocationQueryValue[]> = {}
  for (const [key, value] of Object.entries(query)) {
    if (key === 'code' || key === 'state' || typeof value === 'undefined') continue
    next[key] = value
  }
  void router.replace({ path: route.path, query: next })
}

watch(() => [route.query.code, route.query.state] as const, stripCallbackQuery, { immediate: true })
onMounted(stripCallbackQuery)

async function startManaged(): Promise<void> {
  managedMessage.value = ''
  if (!readySource.value || !readyPart.value) {
    managedMessage.value = '需要先确定数据源和 Part。'
    return
  }
  try {
    const result = await startManagedLogin(readySource.value, readyPart.value)
    followManagedNavigation(result.navigationUrl)
  } catch (error) {
    managedMessage.value = error instanceof PlmManagedCompanionError ? error.message : '托管登录未能开始'
  }
}

async function loadManagedStatus(): Promise<void> {
  managedMessage.value = ''
  if (!readySource.value) return
  try {
    const status = await readManagedStatus(readySource.value)
    managedMessage.value = status.pendingRevoke
      ? '解除托管仍在等待元图确认。'
      : status.linked
        ? `托管关系第 ${status.generation ?? ''} 代有效。`
        : '当前没有有效托管关系。'
  } catch (error) {
    managedMessage.value = error instanceof PlmManagedCompanionError ? error.message : '托管状态无法读取'
  }
}

async function unlinkManaged(): Promise<void> {
  managedMessage.value = ''
  if (!readySource.value) return
  try {
    const result = await unlinkManagedSource(readySource.value)
    managedMessage.value = result.state === 'acked' ? '托管关系已解除。' : '解除托管已在本地生效，仍在等待元图确认。'
  } catch (error) {
    managedMessage.value = error instanceof PlmManagedCompanionError ? error.message : '解除托管尚未完成'
  }
}

function stillCurrent(source: string, ownTicket: number, ownSession: string): boolean {
  return ownTicket === ticket && readySource.value === source && ownSession === readAuthSessionSignature()
}

async function settleCapabilities(source: string, ownTicket: number, ownSession: string): Promise<void> {
  try {
    const result = await getPlmDataSourceCapabilities(source)
    if (!stillCurrent(source, ownTicket, ownSession)) return
    ecoIntentEnabled.value = bomEcoRevisionIntentEnabled(result)
  } catch {
    if (!stillCurrent(source, ownTicket, ownSession)) return
    ecoIntentEnabled.value = false
  }
}

function reloadCapabilities(): void {
  const source = readySource.value
  const ownTicket = ++ticket
  ecoIntentEnabled.value = false
  if (!source) return
  const ownSession = readAuthSessionSignature()
  void settleCapabilities(source, ownTicket, ownSession)
}

function onSessionSignal(): void {
  const next = readAuthSessionSignature()
  if (next === sessionSignature) return
  sessionSignature = next
  reloadCapabilities()
}

watch(readySource, () => {
  reloadCapabilities()
}, { immediate: true })

const unsubscribe = onAuthSessionSwitch(onSessionSignal)
onMounted(() => window.addEventListener('storage', onSessionSignal))
onBeforeUnmount(() => {
  ticket += 1
  unsubscribe()
  window.removeEventListener('storage', onSessionSignal)
})
</script>

<style scoped>
.plm-bom-workspace { display: flex; flex-direction: column; gap: 8px; }
.plm-bom-workspace__hint { font-weight: 600; }
.plm-bom-workspace__source { margin: 0; }
</style>
