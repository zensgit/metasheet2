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
          <th>单位</th>
          <th>查找号</th>
          <th>位号</th>
          <th>来源版本</th>
          <th>来源更新时间</th>
          <th v-if="editable">写回</th>
        </tr>
      </thead>
      <tbody>
        <template
          v-for="line in context.lines"
          :key="line.bom_line_id"
        >
        <tr
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
          <td>
            <input
              v-if="editable"
              class="bom-review__cell-input"
              type="number"
              :value="draftFor(line).quantity"
              :disabled="submittingLineId === line.bom_line_id"
              data-testid="plm-bom-review-quantity-input"
              @input="updateDraft(line, 'quantity', ($event.target as HTMLInputElement).value)"
            />
            <template v-else>{{ formatQuantity(line) }}</template>
          </td>
          <td>
            <input
              v-if="editable"
              class="bom-review__cell-input"
              :value="draftFor(line).uom"
              :disabled="submittingLineId === line.bom_line_id"
              data-testid="plm-bom-review-uom-input"
              @input="updateDraft(line, 'uom', ($event.target as HTMLInputElement).value)"
            />
            <template v-else>{{ line.uom || '—' }}</template>
          </td>
          <td>
            <input
              v-if="editable"
              class="bom-review__cell-input"
              :value="draftFor(line).find_num"
              :disabled="submittingLineId === line.bom_line_id"
              data-testid="plm-bom-review-find-num-input"
              @input="updateDraft(line, 'find_num', ($event.target as HTMLInputElement).value)"
            />
            <template v-else>{{ line.find_num || '—' }}</template>
          </td>
          <td>
            <input
              v-if="editable"
              class="bom-review__cell-input"
              :value="draftFor(line).refdes"
              :disabled="submittingLineId === line.bom_line_id"
              data-testid="plm-bom-review-refdes-input"
              @input="updateDraft(line, 'refdes', ($event.target as HTMLInputElement).value)"
            />
            <template v-else>{{ line.refdes || '—' }}</template>
          </td>
          <td>{{ line.source_version ?? '—' }}</td>
          <td>{{ line.source_updated_at || '—' }}</td>
          <td v-if="editable">
            <button
              type="button"
              class="bom-review__save"
              data-testid="plm-bom-review-save"
              :data-bom-line-id="line.bom_line_id"
              :disabled="submittingLineId === line.bom_line_id || !isLineChanged(line)"
              @click="submitLine(line)"
            >
              {{ submittingLineId === line.bom_line_id ? '写回中…' : '保存' }}
            </button>
            <small
              v-if="lineMessages[line.bom_line_id]"
              class="bom-review__line-message"
              data-testid="plm-bom-review-line-message"
            >
              {{ lineMessages[line.bom_line_id] }}
            </small>
          </td>
        </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
// P3-D2: the read-only BOM review table, extracted from PlmBomReviewPanel so BOTH the standalone
// panel (P3-C) and the embedded view (P3-D2) render the identical table.
import { reactive, watch } from 'vue'
import {
  type PlmBomMultitableContext,
  type PlmBomMultitableLine,
  type PlmBomMultitableLinePatch,
} from '../../services/integration/workbench'

interface LineDraft {
  quantity: string
  uom: string
  find_num: string
  refdes: string
}

// nullable so both call sites (panel + embed) can bind their `context | null` computed without a
// non-null assertion; the root v-if guards the render and narrows context for the subtree.
const props = withDefaults(defineProps<{
  context: PlmBomMultitableContext | null
  editable?: boolean
  submittingLineId?: string | null
  lineMessages?: Record<string, string>
}>(), {
  editable: false,
  submittingLineId: null,
  lineMessages: () => ({}),
})

const emit = defineEmits<{
  (event: 'submit-line', payload: {
    line: PlmBomMultitableLine
    patch: PlmBomMultitableLinePatch
  }): void
}>()

const drafts = reactive<Record<string, LineDraft>>({})

function draftFromLine(line: PlmBomMultitableLine): LineDraft {
  return {
    quantity: line.quantity === null || line.quantity === undefined ? '' : String(line.quantity),
    uom: line.uom ?? '',
    find_num: line.find_num ?? '',
    refdes: line.refdes ?? '',
  }
}

watch(
  () => props.context,
  (context) => {
    for (const key of Object.keys(drafts)) delete drafts[key]
    for (const line of context?.lines ?? []) drafts[line.bom_line_id] = draftFromLine(line)
  },
  { immediate: true },
)

function draftFor(line: PlmBomMultitableLine): LineDraft {
  if (!drafts[line.bom_line_id]) drafts[line.bom_line_id] = draftFromLine(line)
  return drafts[line.bom_line_id]
}

function updateDraft(line: PlmBomMultitableLine, field: keyof LineDraft, value: string): void {
  draftFor(line)[field] = value
}

function formatQuantity(line: PlmBomMultitableLine): string {
  if (line.quantity === null || line.quantity === undefined) return '—'
  return line.uom ? `${line.quantity} ${line.uom}` : String(line.quantity)
}

function nullableText(value: string): string | null {
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function buildPatch(line: PlmBomMultitableLine): PlmBomMultitableLinePatch {
  const draft = draftFor(line)
  const patch: PlmBomMultitableLinePatch = {}
  const quantity = draft.quantity.trim() ? Number(draft.quantity) : null
  if (quantity !== line.quantity) patch.quantity = quantity
  const uom = nullableText(draft.uom)
  if (uom !== line.uom) patch.uom = uom
  const findNum = nullableText(draft.find_num)
  if (findNum !== line.find_num) patch.find_num = findNum
  const refdes = nullableText(draft.refdes)
  if (refdes !== line.refdes) patch.refdes = refdes
  return patch
}

function isLineChanged(line: PlmBomMultitableLine): boolean {
  return Object.keys(buildPatch(line)).length > 0
}

function submitLine(line: PlmBomMultitableLine): void {
  const patch = buildPatch(line)
  if (Object.keys(patch).length === 0) return
  emit('submit-line', { line, patch })
}
</script>

<style scoped>
.bom-review__part { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
.bom-review__badge { font-size: 12px; opacity: 0.7; }
.bom-review__table { width: 100%; border-collapse: collapse; }
.bom-review__table th, .bom-review__table td { text-align: left; padding: 4px 8px; border-bottom: 1px solid rgba(0,0,0,0.08); }
.bom-review__hint { opacity: 0.8; }
.bom-review__cell-input { width: 80px; max-width: 100%; box-sizing: border-box; }
.bom-review__save { white-space: nowrap; }
.bom-review__line-message { display: block; margin-top: 2px; max-width: 160px; }
</style>
