<template>
  <span
    class="tasks-todo-badge"
    :class="{ 'tasks-todo-badge--unavailable': state === 'unavailable' }"
    data-testid="tasks-todo-badge"
    :data-state="state"
    :data-count="displayCount"
    role="status"
    :aria-label="ariaLabel"
    :title="ariaLabel"
  >{{ glyph }}</span>
</template>

<script setup lang="ts">
// The persistent top-nav tasks badge (design lock §5.2). Unlike a badge that hides itself whenever
// its count is zero, this span is
// ALWAYS rendered while the nav entry is — the lock calls it out as "常驻" (persistent) — because a
// missing badge and a badge reading "0 pending" need to be tellable apart from "the count is
// unavailable", and a `v-if` that removes the element for both 0 and "unavailable" erases exactly
// that distinction.
//
// `data-count` is bound to an EMPTY STRING (not `"0"`, and not `null` — binding `null`/`undefined`
// removes the attribute from the DOM entirely, which is indistinguishable from "attribute was never
// wired up" rather than "known to be inapplicable") for both 'loading' and 'unavailable': the lock's
// explicit rule is that "failed to load" must never collapse into the same rendered value as
// "genuinely nothing pending". A caller
// (or a test) can tell "ready, 0 pending" (`data-count="0"`) apart from "we don't know"
// (`data-count=""`) by string equality alone.
import { computed } from 'vue'
import { useLocale } from '../composables/useLocale'
import { useTasksBadge } from './useTasksBadge'

const props = withDefaults(defineProps<{ label?: string }>(), { label: '' })

const { isZh } = useLocale()
const { state, count } = useTasksBadge()

const displayCount = computed(() => (state.value === 'ready' ? String(count.value ?? 0) : ''))

const glyph = computed(() => {
  if (state.value === 'unavailable') return '!'
  if (state.value === 'loading') return ''
  return displayCount.value
})

const ariaLabel = computed(() => {
  if (state.value === 'unavailable') {
    return isZh.value ? `${props.label}(数据不可用)` : `${props.label} (data unavailable)`
  }
  if (state.value === 'loading') {
    return isZh.value ? `${props.label}加载中` : `${props.label} loading`
  }
  return `${props.label}${count.value ?? 0}`
})

defineExpose({ state, count })
</script>

<style scoped>
.tasks-todo-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  margin-left: 4px;
  border-radius: 9px;
  background: var(--el-color-danger);
  color: var(--el-color-white);
  font-size: 12px;
  line-height: 1;
  font-weight: 600;
}

/* Visually distinct from the numeric badge so "不可用" (unavailable) is never mistaken for a real
   count, including "0". */
.tasks-todo-badge--unavailable {
  background: var(--el-color-warning);
}
</style>
