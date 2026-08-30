<template>
  <div class="bulk-grid">
    <p v-if="declaredColumns.length === 0" class="bulk-grid__hint" data-testid="plm-bulk-grid-no-columns">
      尚未加载对象类型的属性定义。
    </p>
    <div v-else class="bulk-grid__scroll">
      <table class="bulk-grid__table">
        <thead>
          <tr>
            <th class="bulk-grid__rownum">#</th>
            <th
              v-for="column in declaredColumns"
              :key="column"
              :data-column="column"
              :class="{ 'bulk-grid__th--required': isRequired(column) }"
            >
              {{ labelFor(column) }}
              <span v-if="isRequired(column)" class="bulk-grid__required" title="必填">*</span>
            </th>
            <th class="bulk-grid__gutter-head">校验</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, rowIndex) in rows"
            :key="rowIndex"
            data-testid="plm-bulk-grid-row"
            :data-row-index="rowIndex"
            :class="{ 'bulk-grid__row--error': errorsForRow(rowIndex).length > 0 }"
          >
            <td class="bulk-grid__rownum">{{ rowIndex + 1 }}</td>
            <td
              v-for="column in declaredColumns"
              :key="column"
              :data-column="column"
              :class="{ 'bulk-grid__cell--error': errorsForCell(rowIndex, column).length > 0 }"
            >
              <input
                class="bulk-grid__cell-input"
                :value="cellText(row, column)"
                :disabled="disabled"
                :data-testid="`plm-bulk-grid-cell-${column}`"
                @input="$emit('update-cell', { rowIndex, column, value: ($event.target as HTMLInputElement).value })"
              />
            </td>
            <td class="bulk-grid__gutter">
              <small
                v-for="(rowError, errorIndex) in errorsForRow(rowIndex)"
                :key="errorIndex"
                class="bulk-grid__row-message"
                data-testid="plm-bulk-grid-row-message"
              >
                <!-- The error_code set is OPEN: an unrecognized code is rendered verbatim,
                     never dropped, so a new provider code degrades to visible text. -->
                <code>{{ rowError.error_code }}</code>
                <span v-if="rowError.property_name">·{{ rowError.property_name }}</span>
                {{ rowError.message }}
              </small>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <!-- §10: there is deliberately NO per-row delete affordance and NO per-row new/updated
         badge. The channel has no delete semantics, and would_create/would_update are
         FILE-level integers with no per-row verdict anywhere in the report. -->
  </div>
</template>

<script setup lang="ts">
/**
 * Bulk item-property grid — presentation only.
 *
 * Renders one column per DECLARED property of the ItemType, in PLM's declared order, and
 * paints `row_errors` into a per-row gutter and onto the offending cell.
 *
 * This component never serializes anything. The server builds the submitted file from the
 * declared property list it fetches fresh (N1), so a column hidden or virtualized away here
 * cannot go missing from the write — the failure mode the taskbook says silently deletes data.
 */
import type { PlmBulkGridProperty, PlmBulkGridRowError } from '../../services/integration/workbench'

const props = withDefaults(defineProps<{
  declaredColumns: string[]
  properties: PlmBulkGridProperty[]
  rows: Array<Record<string, unknown>>
  errorsForRow: (rowIndex: number) => PlmBulkGridRowError[]
  errorsForCell: (rowIndex: number, column: string) => PlmBulkGridRowError[]
  disabled?: boolean
}>(), {
  disabled: false,
})

defineEmits<{
  (event: 'update-cell', payload: { rowIndex: number; column: string; value: string }): void
}>()

function propertyFor(column: string): PlmBulkGridProperty | undefined {
  return props.properties.find((property) => property.name === column)
}

function labelFor(column: string): string {
  return propertyFor(column)?.label || column
}

function isRequired(column: string): boolean {
  return propertyFor(column)?.required === true
}

function cellText(row: Record<string, unknown>, column: string): string {
  const value = row[column]
  if (value === null || value === undefined) return ''
  return String(value)
}
</script>

<style scoped>
.bulk-grid__scroll { overflow-x: auto; }
.bulk-grid__table { width: 100%; border-collapse: collapse; }
.bulk-grid__table th, .bulk-grid__table td { text-align: left; padding: 4px 8px; border-bottom: 1px solid rgba(0,0,0,0.08); }
.bulk-grid__rownum { width: 40px; opacity: 0.6; }
.bulk-grid__required { color: #c0392b; }
.bulk-grid__cell-input { width: 120px; max-width: 100%; box-sizing: border-box; }
.bulk-grid__row--error { background: rgba(192, 57, 43, 0.06); }
.bulk-grid__cell--error .bulk-grid__cell-input { border: 1px solid #c0392b; }
.bulk-grid__gutter { max-width: 260px; }
.bulk-grid__row-message { display: block; color: #c0392b; }
.bulk-grid__hint { opacity: 0.8; }
</style>
