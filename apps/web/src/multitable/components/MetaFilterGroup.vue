<!--
  Recursive nested filter-group editor (PR-2b-2). Renders one group: its conjunction (and/or) over an
  ORDERED list of children, where each child is a leaf condition (MetaFilterConditionRow) or a nested
  MetaFilterGroup. Mirrors the backend recursive AND/OR tree. "Add group" is capped at the backend
  MAX_FILTER_DEPTH so the UI never authors a filter the server would 400. Edits rebuild the group node and
  emit `update:modelValue` (the whole subtree) so the parent stays the single source of truth — no in-place
  mutation of the prop.
-->
<template>
  <div class="meta-filter-group" :data-filter-group-depth="depth">
    <div class="meta-filter-group__bar">
      <span class="meta-filter-group__where">{{ l('toolbar.where') }}</span>
      <select
        class="meta-filter-group__conj"
        :value="modelValue.conjunction"
        :aria-label="l('toolbar.where')"
        data-filter-group-conjunction="true"
        @change="onConjunction(($event.target as HTMLSelectElement).value as FilterConjunction)"
      >
        <option value="and">{{ l('toolbar.all') }}</option>
        <option value="or">{{ l('toolbar.any') }}</option>
      </select>
      <span class="meta-filter-group__match">{{ l('toolbar.conditionsMatch') }}</span>
      <button
        v-if="removable"
        type="button"
        class="meta-filter-group__remove"
        :title="l('toolbar.removeGroup')"
        :aria-label="l('toolbar.removeGroup')"
        data-filter-group-remove="true"
        @click="emit('remove')"
      >&times;</button>
    </div>
    <div class="meta-filter-group__children">
      <template v-for="(child, i) in modelValue.conditions" :key="i">
        <MetaFilterGroup
          v-if="isFilterGroup(child)"
          :model-value="child"
          :depth="depth + 1"
          :fields="fields"
          removable
          @update:model-value="(g: FilterGroup) => onChildUpdate(i, g)"
          @remove="onChildRemove(i)"
        />
        <MetaFilterConditionRow
          v-else
          :rule="child"
          :fields="fields"
          @update="(r: FilterRule) => onChildUpdate(i, r)"
          @remove="onChildRemove(i)"
        />
      </template>
    </div>
    <div class="meta-filter-group__actions">
      <button type="button" class="meta-filter-group__add" data-filter-group-add-condition="true" @click="onAddCondition">{{ l('toolbar.addCondition') }}</button>
      <button
        v-if="canAddGroup"
        type="button"
        class="meta-filter-group__add"
        data-filter-group-add-group="true"
        @click="onAddGroup"
      >{{ l('toolbar.addGroup') }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { MetaField } from '../types'
import type { FilterRule, FilterGroup, FilterNode, FilterConjunction } from '../composables/useMultitableGrid'
import { isFilterGroup, MAX_FILTER_DEPTH } from '../composables/useMultitableGrid'
import { useLocale } from '../../composables/useLocale'
import { metaCoreLabel, type MetaCoreLabelKey } from '../utils/meta-core-labels'
import { seedFilterCondition } from '../utils/filter-condition-seed'
import MetaFilterConditionRow from './MetaFilterConditionRow.vue'

defineOptions({ name: 'MetaFilterGroup' })

const props = withDefaults(defineProps<{ modelValue: FilterGroup; fields: MetaField[]; depth?: number; removable?: boolean }>(), {
  depth: 0,
  removable: false,
})
const emit = defineEmits<{ (e: 'update:modelValue', value: FilterGroup): void; (e: 'remove'): void }>()

const { isZh } = useLocale()
const l = (key: MetaCoreLabelKey) => metaCoreLabel(key, isZh.value)

// A child group created here lands at depth+1; only offer it while that stays within the backend cap
// (a group nested at MAX_FILTER_DEPTH or deeper is dropped/rejected server-side).
const canAddGroup = computed(() => props.depth + 1 < MAX_FILTER_DEPTH)

function emitWith(conditions: FilterNode[], conjunction = props.modelValue.conjunction) {
  emit('update:modelValue', { conjunction, conditions })
}
function onConjunction(conjunction: FilterConjunction) {
  emitWith([...props.modelValue.conditions], conjunction)
}
function onChildUpdate(index: number, node: FilterNode) {
  const next = props.modelValue.conditions.slice()
  next[index] = node
  emitWith(next)
}
function onChildRemove(index: number) {
  const next = props.modelValue.conditions.slice()
  next.splice(index, 1)
  emitWith(next)
}
function onAddCondition() {
  emitWith([...props.modelValue.conditions, seedFilterCondition(props.fields[0])])
}
function onAddGroup() {
  const child: FilterGroup = { conjunction: 'and', conditions: [seedFilterCondition(props.fields[0])] }
  emitWith([...props.modelValue.conditions, child])
}
</script>

<style scoped>
.meta-filter-group { border: 1px solid #e5e7eb; border-radius: 4px; padding: 6px 8px; margin-bottom: 6px; background: #fafafa; }
.meta-filter-group__bar { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #666; margin-bottom: 6px; }
.meta-filter-group__conj { padding: 2px 6px; font-size: 12px; border: 1px solid #ddd; border-radius: 3px; }
.meta-filter-group__remove { margin-left: auto; border: none; background: none; color: #999; cursor: pointer; font-size: 16px; }
.meta-filter-group__remove:hover { color: #f56c6c; }
.meta-filter-group__children { padding-left: 8px; border-left: 2px solid #eee; }
.meta-filter-group__actions { display: flex; gap: 12px; margin-top: 4px; }
.meta-filter-group__add { border: none; background: none; color: #409eff; cursor: pointer; font-size: 12px; padding: 2px 0; }
.meta-filter-group__add:hover { text-decoration: underline; }
</style>
