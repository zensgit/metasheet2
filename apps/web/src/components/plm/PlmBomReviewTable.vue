<template>
  <div v-if="context">
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
</template>

<script setup lang="ts">
// P3-D2: the read-only BOM review table, extracted from PlmBomReviewPanel so BOTH the standalone
// panel (P3-C) and the embedded view (P3-D2) render the identical table.
import { type PlmBomMultitableContext, type PlmBomMultitableLine } from '../../services/integration/workbench'

// nullable so both call sites (panel + embed) can bind their `context | null` computed without a
// non-null assertion; the root v-if guards the render and narrows context for the subtree.
defineProps<{ context: PlmBomMultitableContext | null }>()

function formatQuantity(line: PlmBomMultitableLine): string {
  if (line.quantity === null || line.quantity === undefined) return '—'
  return line.uom ? `${line.quantity} ${line.uom}` : String(line.quantity)
}
</script>

<style scoped>
.bom-review__part { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
.bom-review__badge { font-size: 12px; opacity: 0.7; }
.bom-review__table { width: 100%; border-collapse: collapse; }
.bom-review__table th, .bom-review__table td { text-align: left; padding: 4px 8px; border-bottom: 1px solid rgba(0,0,0,0.08); }
.bom-review__hint { opacity: 0.8; }
</style>
