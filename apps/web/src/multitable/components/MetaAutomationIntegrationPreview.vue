<template>
  <!-- C1/S2 first slice: rendered only after the server confirmed the switch is on (catalog 200). While OFF
       (or for a caller without automation capability) the catalog request is refused and nothing shows. -->
  <section
    v-if="catalog"
    class="meta-integration-preview"
    data-integration-preview="true"
    :aria-label="t('title')"
  >
    <header class="meta-integration-preview__header">
      <strong class="meta-integration-preview__title">{{ t('title') }}</strong>
      <span class="meta-integration-preview__badge" data-integration-preview-badge="synthetic">{{ t('badge') }}</span>
    </header>
    <p class="meta-integration-preview__note" data-integration-preview-note="true">{{ t('note') }}</p>

    <div class="meta-integration-preview__controls">
      <label class="meta-integration-preview__field">
        <span>{{ t('rule') }}</span>
        <select v-model="selectedRuleId" data-integration-preview-rule="true" :disabled="running">
          <option value="" disabled>{{ t('pickRule') }}</option>
          <option v-for="rule in rules" :key="rule.id" :value="rule.id">{{ rule.name || rule.id }}</option>
        </select>
      </label>
      <label class="meta-integration-preview__field">
        <span>{{ t('fixture') }}</span>
        <select v-model="selectedFixtureId" data-integration-preview-fixture="true" :disabled="running">
          <option v-for="id in catalog.fixtureIds" :key="id" :value="id">{{ id }}</option>
        </select>
      </label>
      <label class="meta-integration-preview__field">
        <span>{{ t('preset') }}</span>
        <select v-model="selectedPresetId" data-integration-preview-preset="true" :disabled="running">
          <option v-for="id in catalog.mappingPresetIds" :key="id" :value="id">{{ id }}</option>
        </select>
      </label>
      <MtButton
        data-integration-preview-run="true"
        :disabled="running || !selectedRuleId || !selectedFixtureId || !selectedPresetId"
        @click="runPreview"
      >{{ t('run') }}</MtButton>
      <MtButton v-if="running" data-integration-preview-cancel="true" @click="cancelPreview">{{ t('cancel') }}</MtButton>
      <MtButton v-if="result && !running" data-integration-preview-clear="true" @click="clearResult">{{ t('clear') }}</MtButton>
    </div>

    <div v-if="running" class="meta-integration-preview__status" data-integration-preview-status="running">{{ t('running') }}</div>
    <div v-else-if="errorCode" class="meta-integration-preview__status meta-integration-preview__status--error" role="alert" data-integration-preview-status="error" :data-code="errorCode">
      {{ errorText(errorCode) }}
    </div>

    <div v-if="result" class="meta-integration-preview__result" data-integration-preview-result="true">
      <div class="meta-integration-preview__summary" data-integration-preview-summary="true">
        <span>{{ t('pages') }}: {{ result.summary.counts.pages }}</span>
        <span>{{ t('rowsRead') }}: {{ result.summary.counts.rows }}</span>
        <span>{{ t('planned') }}: {{ result.preview.rowCount }}</span>
        <span :title="result.preview.planDigest">{{ t('digest') }}: {{ result.preview.planDigest.slice(0, 12) }}</span>
      </div>
      <table class="meta-integration-preview__table" data-integration-preview-rows="true">
        <thead>
          <tr>
            <th>#</th>
            <th v-for="column in columns" :key="column">{{ column }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in result.preview.rows" :key="row.index" :data-integration-preview-row="row.index">
            <td>{{ row.index + 1 }}</td>
            <td v-for="column in columns" :key="column">{{ display(row.fields[column]) }}</td>
          </tr>
        </tbody>
      </table>
      <p class="meta-integration-preview__footnote" data-integration-preview-no-send="true">{{ t('noSend') }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type {
  AutomationIntegrationPreviewCatalog,
  AutomationIntegrationPreviewResult,
  MultitableApiClient,
} from '../api/client'
import { MtButton } from '../ui'

const props = defineProps<{
  visible: boolean
  sheetId: string
  rules: Array<{ id: string; name?: string | null }>
  client?: MultitableApiClient
}>()

const { isZh } = useLocale()
const LABELS = {
  title: ['合成集成预览', 'Synthetic integration preview'],
  badge: ['仅合成数据', 'Synthetic only'],
  note: ['用仓库自带的合成夹具演示：具名只读操作 → 运行内传值 → 宜搭纯预览。不连接真实系统，不发送，不写业务数据。', 'Demonstrates a named read-only operation, in-run values and a YiDa pure preview with built-in synthetic fixtures. No real system, no send, no business write.'],
  rule: ['规则', 'Rule'],
  pickRule: ['选择规则', 'Pick a rule'],
  fixture: ['合成夹具', 'Synthetic fixture'],
  preset: ['映射预设', 'Mapping preset'],
  run: ['运行合成预览', 'Run synthetic preview'],
  cancel: ['取消', 'Cancel'],
  clear: ['清除结果', 'Clear result'],
  running: ['预览运行中…', 'Preview running…'],
  pages: ['读取页数', 'Pages read'],
  rowsRead: ['读取行数', 'Rows read'],
  planned: ['计划行数', 'Planned rows'],
  digest: ['计划摘要', 'Plan digest'],
  noSend: ['这只是预览：没有发送、批准或写入，也不会保存。', 'Preview only: nothing is sent, approved, written or saved.'],
} as const
type LabelKey = keyof typeof LABELS
const t = (key: LabelKey) => LABELS[key][isZh.value ? 0 : 1]

const ERRORS: Record<string, [string, string]> = {
  INTEGRATION_PREVIEW_DENIED: ['没有权限运行此预览（需为规则所有者并具备集成权限）。', 'Not authorized (rule owner with integration authority required).'],
  INTEGRATION_PREVIEW_NOT_FOUND: ['规则不存在或不属于此表。', 'Rule not found on this sheet.'],
  INTEGRATION_PREVIEW_LIMIT: ['合成预览超出固定预算，已停止。', 'The synthetic preview exceeded its fixed budget and stopped.'],
  INTEGRATION_PREVIEW_TIMEOUT: ['合成预览超时，已停止。', 'The synthetic preview timed out.'],
  INTEGRATION_PREVIEW_CANCELLED: ['已取消。', 'Cancelled.'],
  INTEGRATION_PREVIEW_DISABLED: ['合成预览未开启。', 'Synthetic preview is not enabled.'],
  INTEGRATION_PREVIEW_REJECTED: ['预设无法生成预览。', 'The preset could not produce a preview.'],
}
function errorText(code: string): string {
  const entry = ERRORS[code]
  if (entry) return entry[isZh.value ? 0 : 1]
  return isZh.value ? '合成预览暂不可用。' : 'Synthetic preview is not available right now.'
}

// Panel memory only: nothing below is written to localStorage, sessionStorage, IndexedDB or telemetry.
const catalog = shallowRef<AutomationIntegrationPreviewCatalog | null>(null)
const result = shallowRef<AutomationIntegrationPreviewResult | null>(null)
const errorCode = ref('')
const running = ref(false)
const selectedRuleId = ref('')
const selectedFixtureId = ref('')
const selectedPresetId = ref('')
let controller: AbortController | null = null
let catalogGeneration = 0

const columns = computed(() => {
  const set = new Set<string>()
  for (const row of result.value?.preview.rows ?? []) for (const key of Object.keys(row.fields)) set.add(key)
  return [...set]
})

function display(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

function clearResult() {
  result.value = null
  errorCode.value = ''
}

/** Cancel: abort the in-flight request; the run's own catch shows CANCELLED and clears the busy state. */
function cancelPreview() {
  controller?.abort()
}

/** Drawer closed / sheet changed / unmount: abort, forget the request (a late answer is ignored) and drop the result. */
function reset() {
  controller?.abort()
  controller = null
  running.value = false
  clearResult()
}

async function loadCatalog() {
  const generation = ++catalogGeneration
  catalog.value = null
  if (!props.visible || !props.client || !props.sheetId) return
  try {
    const loaded = await props.client.getAutomationIntegrationPreviewCatalog(props.sheetId)
    if (generation !== catalogGeneration) return
    catalog.value = loaded
    selectedFixtureId.value = loaded.fixtureIds[0] ?? ''
    selectedPresetId.value = loaded.mappingPresetIds[0] ?? ''
  } catch {
    // OFF, not authorized or unavailable: the panel stays hidden.
    if (generation === catalogGeneration) catalog.value = null
  }
}

async function runPreview() {
  const client = props.client
  const current = catalog.value
  if (!client || !current || running.value) return
  clearResult()
  const own = new AbortController()
  controller = own
  running.value = true
  try {
    const response = await client.previewAutomationIntegration(props.sheetId, selectedRuleId.value, {
      planId: current.planId,
      fixtureId: selectedFixtureId.value,
      mappingPresetId: selectedPresetId.value,
    }, { signal: own.signal })
    if (controller !== own) return
    // Never treat a result as an authority, whatever the payload says.
    if (response.canSend !== false || response.canApply !== false || response.tokenIssued !== false || response.externalWriteAttempted !== false) {
      errorCode.value = 'INTEGRATION_PREVIEW_UNAVAILABLE'
      return
    }
    result.value = response
  } catch (error) {
    if (controller !== own) return
    const code = (error as { code?: unknown })?.code
    errorCode.value = own.signal.aborted ? 'INTEGRATION_PREVIEW_CANCELLED' : typeof code === 'string' ? code : 'INTEGRATION_PREVIEW_UNAVAILABLE'
  } finally {
    if (controller === own) {
      controller = null
      running.value = false
    }
  }
}

watch(() => [props.visible, props.sheetId, props.client] as const, () => {
  reset()
  void loadCatalog()
}, { immediate: true })

watch(() => props.rules.map((rule) => rule.id).join('\u0000'), () => {
  if (!props.rules.some((rule) => rule.id === selectedRuleId.value)) selectedRuleId.value = props.rules[0]?.id ?? ''
}, { immediate: true })

onBeforeUnmount(() => {
  catalogGeneration += 1
  reset()
  catalog.value = null
})
</script>

<style scoped>
.meta-integration-preview { margin-top: 16px; padding: 12px; border: 1px dashed var(--el-border-color, #dcdfe6); border-radius: 6px; }
.meta-integration-preview__header { display: flex; gap: 8px; align-items: center; }
.meta-integration-preview__badge { font-size: 12px; padding: 0 6px; border-radius: 4px; background: var(--el-fill-color-light, #f5f7fa); }
.meta-integration-preview__note, .meta-integration-preview__footnote { font-size: 12px; color: var(--el-text-color-secondary, #909399); margin: 6px 0; }
.meta-integration-preview__controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; }
.meta-integration-preview__field { display: flex; flex-direction: column; font-size: 12px; gap: 2px; }
.meta-integration-preview__status { margin-top: 8px; font-size: 13px; }
.meta-integration-preview__status--error { color: var(--el-color-danger, #f56c6c); }
.meta-integration-preview__summary { display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; margin: 8px 0; }
.meta-integration-preview__table { width: 100%; border-collapse: collapse; font-size: 12px; }
.meta-integration-preview__table th, .meta-integration-preview__table td { border: 1px solid var(--el-border-color-lighter, #ebeef5); padding: 2px 6px; text-align: left; }
</style>
