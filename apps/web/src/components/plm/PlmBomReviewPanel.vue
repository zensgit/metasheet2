<template>
  <section class="bom-review" data-testid="plm-bom-review-panel">
    <header class="bom-review__head">
      <strong>BOM Review</strong>
      <small>来自 PLM 的受治理快照；此工作台可写回已授权的 BOM 单元格。</small>
    </header>

    <div class="bom-review__query">
      <label>
        <span>Part ID</span>
        <input
          v-model="partId"
          data-testid="plm-bom-review-part-input"
          placeholder="输入要查看 BOM 的 Part ID"
          @keyup.enter="load"
        />
      </label>
      <button
        type="button"
        class="bom-review__button"
        data-testid="plm-bom-review-load"
        :disabled="loading || !partId.trim()"
        @click="load"
      >
        {{ loading ? '加载中…' : '加载 BOM Review' }}
      </button>
    </div>

    <div class="bom-review__body" data-testid="plm-bom-review-state" :data-state="reviewState">
      <p v-if="reviewState === 'idle'" class="bom-review__hint">
        输入一个 Part ID 后加载其 BOM review 表。
      </p>
      <p v-else-if="reviewState === 'loading'" class="bom-review__hint">正在读取 BOM review…</p>
      <p v-else-if="reviewState === 'unavailable'" class="bom-review__hint bom-review__hint--muted">
        当前 PLM 不支持 BOM review，或暂时不可用。
      </p>
      <p v-else-if="reviewState === 'upgrade'" class="bom-review__hint bom-review__hint--strong">
        当前租户尚未开通 BOM review；这里只显示升级入口，真实授权由 PLM license 判定。
      </p>
      <p v-else-if="reviewState === 'error'" class="bom-review__hint bom-review__hint--strong" data-testid="plm-bom-review-error">
        加载 BOM review 失败（PLM 暂时不可用），请稍后重试。
      </p>
      <p v-else-if="reviewState === 'empty'" class="bom-review__hint">
        未找到该 Part 的 BOM 数据。
      </p>

      <PlmBomReviewTable
        v-else-if="reviewState === 'table' && context"
        :context="context"
        editable
        :submitting-line-id="submittingLineId"
        :line-messages="lineMessages"
        @submit-line="submitLinePatch"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  getPlmBomMultitableContext,
  updatePlmBomMultitableLine,
  type PlmBomMultitableLine,
  type PlmBomMultitableLinePatch,
  type PlmBomMultitableResult,
} from '../../services/integration/workbench'
import PlmBomReviewTable from './PlmBomReviewTable.vue'

const props = defineProps<{ dataSourceId: string }>()

const partId = ref('')
const loading = ref(false)
const result = ref<PlmBomMultitableResult | null>(null)
const submittingLineId = ref<string | null>(null)
const lineMessages = ref<Record<string, string>>({})
const retryKeys = ref<Record<string, string>>({})

const context = computed(() =>
  result.value && result.value.available ? result.value.context : null,
)

// idle (nothing loaded) -> loading -> one of: unavailable (no support / degraded), upgrade
// (supported but not entitled), error (entitled but the provider fetch failed transiently),
// empty (entitled, no context, no reason = part not found), table (entitled + context).
const reviewState = computed<'idle' | 'loading' | 'unavailable' | 'upgrade' | 'error' | 'empty' | 'table'>(() => {
  if (loading.value) return 'loading'
  const current = result.value
  if (!current) return 'idle'
  if (!current.available) return 'unavailable'
  if (!current.entitled) return 'upgrade'
  if (current.context) return 'table'
  // entitled but no context: a relayed reason means a TRANSIENT provider failure (retry),
  // NOT "this part has no BOM" -- only a reason-less null context is the empty/not-found case.
  if (current.reason) return 'error'
  return 'empty'
})

// Fetch ONLY on explicit user action (never on mount) so mounting the panel never triggers a
// PLM call. The backend relay does the advisory gate; this is a single, read-only call.
async function load(): Promise<void> {
  const pid = partId.value.trim()
  if (!pid || loading.value) return
  loading.value = true
  lineMessages.value = {}
  retryKeys.value = {}
  try {
    result.value = await getPlmBomMultitableContext(props.dataSourceId, pid)
  } catch {
    result.value = { data_source_id: props.dataSourceId, available: false, reason: 'unavailable' }
  } finally {
    loading.value = false
  }
}

function makeIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  return `bom-write-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function writebackMessage(status: number): string {
  if (status === 403) return '无写回授权或权限不足。'
  if (status === 404) return '该 BOM 行不存在或不属于当前 Part。'
  if (status === 409) return '该 BOM 行当前不可写，或提交键已用于不同写入。'
  if (status === 422 || status === 400) return '写回内容无效，请检查单元格。'
  return '写回暂时失败，请稍后重试。'
}

function applyLinePatch(line: PlmBomMultitableLine, patch: PlmBomMultitableLinePatch): void {
  if ('quantity' in patch) {
    line.quantity = typeof patch.quantity === 'number' || patch.quantity === null ? patch.quantity : Number(patch.quantity)
  }
  if ('uom' in patch) line.uom = patch.uom ?? null
  if ('find_num' in patch) line.find_num = patch.find_num ?? null
  if ('refdes' in patch) line.refdes = patch.refdes ?? null
}

async function submitLinePatch(payload: { line: PlmBomMultitableLine; patch: PlmBomMultitableLinePatch }): Promise<void> {
  const lineId = payload.line.bom_line_id
  if (!context.value || submittingLineId.value) return
  const key = retryKeys.value[lineId] || makeIdempotencyKey()
  retryKeys.value = { ...retryKeys.value, [lineId]: key }
  submittingLineId.value = lineId
  lineMessages.value = { ...lineMessages.value, [lineId]: '正在写回…' }
  try {
    const outcome = await updatePlmBomMultitableLine(
      props.dataSourceId,
      context.value.part.part_id,
      lineId,
      payload.patch,
      key,
    )
    if (outcome.ok) {
      applyLinePatch(payload.line, payload.patch)
      const { [lineId]: _doneKey, ...rest } = retryKeys.value
      retryKeys.value = rest
      lineMessages.value = { ...lineMessages.value, [lineId]: '写回成功。' }
      return
    }
    lineMessages.value = { ...lineMessages.value, [lineId]: writebackMessage(outcome.status) }
  } catch {
    lineMessages.value = { ...lineMessages.value, [lineId]: '写回暂时失败，请稍后重试。' }
  } finally {
    submittingLineId.value = null
  }
}
</script>

<style scoped>
.bom-review { display: flex; flex-direction: column; gap: 8px; }
.bom-review__head { display: flex; flex-direction: column; }
.bom-review__query { display: flex; align-items: flex-end; gap: 8px; }
.bom-review__query label { display: flex; flex-direction: column; gap: 2px; }
.bom-review__button { white-space: nowrap; }
.bom-review__hint--muted { opacity: 0.6; }
.bom-review__hint--strong { font-weight: 600; }
</style>
