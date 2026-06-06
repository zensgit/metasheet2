<template>
  <section class="bom-review" data-testid="plm-bom-review-panel">
    <header class="bom-review__head">
      <strong>BOM Review（只读）</strong>
      <small>来自 PLM 的受治理只读快照；不可在此编辑/写回。</small>
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

      <PlmBomReviewTable v-else-if="reviewState === 'table' && context" :context="context" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  getPlmBomMultitableContext,
  type PlmBomMultitableResult,
} from '../../services/integration/workbench'
import PlmBomReviewTable from './PlmBomReviewTable.vue'

const props = defineProps<{ dataSourceId: string }>()

const partId = ref('')
const loading = ref(false)
const result = ref<PlmBomMultitableResult | null>(null)

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
  try {
    result.value = await getPlmBomMultitableContext(props.dataSourceId, pid)
  } catch {
    result.value = { data_source_id: props.dataSourceId, available: false, reason: 'unavailable' }
  } finally {
    loading.value = false
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
