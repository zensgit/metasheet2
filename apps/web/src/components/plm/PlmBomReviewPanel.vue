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
      <p v-else-if="reviewState === 'empty'" class="bom-review__hint">
        未找到该 Part 的 BOM 数据。
      </p>

      <div v-else-if="reviewState === 'table' && context">
        <div class="bom-review__part" data-testid="plm-bom-review-part">
          <span class="bom-review__badge">Part</span>
          <strong>{{ context.part.item_number || context.part.part_id }}</strong>
          <span>{{ context.part.name }}</span>
          <small>状态 {{ context.part.state || '—' }} · 版本 {{ context.part.generation ?? '—' }}</small>
          <small v-if="context.source_updated_at">来源更新 {{ context.source_updated_at }}</small>
        </div>

        <p v-if="context.lines.length === 0" class="bom-review__hint" data-testid="plm-bom-review-no-lines">
          该 Part 没有 BOM 行。
        </p>
        <table v-else class="bom-review__table">
          <thead>
            <tr>
              <th>层级</th>
              <th>物料号</th>
              <th>名称</th>
              <th>状态</th>
              <th>数量</th>
              <th>位号</th>
              <th>来源版本</th>
              <th>来源更新时间</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="line in context.lines"
              :key="line.bom_line_id"
              data-testid="plm-bom-review-row"
              :data-bom-line-id="line.bom_line_id"
              :data-level="line.level"
            >
              <td>{{ line.level }}</td>
              <td>
                <span :style="{ paddingLeft: `${Math.max(0, line.level - 1) * 16}px` }">
                  {{ line.item_number || line.part_id }}
                </span>
              </td>
              <td>{{ line.name }}</td>
              <td>{{ line.state || '—' }}</td>
              <td>{{ formatQuantity(line) }}</td>
              <td>{{ line.refdes || '—' }}</td>
              <td>{{ line.source_version ?? '—' }}</td>
              <td>{{ line.source_updated_at || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  getPlmBomMultitableContext,
  type PlmBomMultitableLine,
  type PlmBomMultitableResult,
} from '../../services/integration/workbench'

const props = defineProps<{ dataSourceId: string }>()

const partId = ref('')
const loading = ref(false)
const result = ref<PlmBomMultitableResult | null>(null)

const context = computed(() =>
  result.value && result.value.available ? result.value.context : null,
)

// idle (nothing loaded) -> loading -> one of: unavailable (no support / degraded), upgrade
// (supported but not entitled), empty (entitled but no context), table (entitled + context).
const reviewState = computed<'idle' | 'loading' | 'unavailable' | 'upgrade' | 'empty' | 'table'>(() => {
  if (loading.value) return 'loading'
  const current = result.value
  if (!current) return 'idle'
  if (!current.available) return 'unavailable'
  if (!current.entitled) return 'upgrade'
  if (!current.context) return 'empty'
  return 'table'
})

function formatQuantity(line: PlmBomMultitableLine): string {
  if (line.quantity === null || line.quantity === undefined) return '—'
  return line.uom ? `${line.quantity} ${line.uom}` : String(line.quantity)
}

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
.bom-review__part { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
.bom-review__badge { font-size: 12px; opacity: 0.7; }
.bom-review__table { width: 100%; border-collapse: collapse; }
.bom-review__table th, .bom-review__table td { text-align: left; padding: 4px 8px; border-bottom: 1px solid rgba(0,0,0,0.08); }
.bom-review__hint--muted { opacity: 0.6; }
.bom-review__hint--strong { font-weight: 600; }
</style>
