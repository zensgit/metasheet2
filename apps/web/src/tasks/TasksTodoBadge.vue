<template>
  <span
    class="tasks-todo-badge"
    :class="{
      'tasks-todo-badge--unavailable': state === 'unavailable',
      'tasks-todo-badge--off': scope === 'off',
    }"
    data-testid="tasks-todo-badge"
    :data-state="state"
    :data-scope="scope ?? ''"
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
//
// M4 FE-0: the localized `aria-label` forms come from the shared label tables
// (`tasks/labels.ts`, `TASKS_FMT_*`) through a `computed` on `isZh`, so a locale change after
// mount re-renders them; the 'ready' form is the label prop and the count, with no copy of its own.
//
// M4 FE-2 (design §8.1): `data-scope` carries the server's badge scope (`'on'` / `'off'`, empty
// while not 'ready' — same reason as the empty `data-count`: an attribute that is present but
// empty is "known to be inapplicable", a missing one is "never wired"). The three `data-state`
// values do NOT change and no fourth state is added: "switched off" is a `ready` answer with a
// scope, so the three renderings are told apart by attribute string alone —
//   switched off:   data-state="ready"       data-scope="off" data-count="0"
//   zero pending:   data-state="ready"       data-scope="on"  data-count="0"
//   unavailable:    data-state="unavailable" data-scope=""    data-count=""
// Switched off keeps the node (the lock's persistent badge) but renders NO numeral and no colour,
// with its own `aria-label`; `data-count` stays the server's true count (0).
// ASSUMPTION(task-m4-fe): [D5] — the state literal stays M2's 'ready' (the existing badge specs pin
// it); only `data-scope` and the no-numeral rendering are new.
import { computed } from 'vue'
import { useLocale } from '../composables/useLocale'
import { TASKS_FMT_EN, TASKS_FMT_ZH } from './labels'
import { useTasksBadge } from './useTasksBadge'

const props = withDefaults(defineProps<{ label?: string }>(), { label: '' })

const { isZh } = useLocale()
const { state, count, scope } = useTasksBadge()

const fmt = computed(() => (isZh.value ? TASKS_FMT_ZH : TASKS_FMT_EN))

const displayCount = computed(() => (state.value === 'ready' ? String(count.value ?? 0) : ''))

const glyph = computed(() => {
  if (state.value === 'unavailable') return '!'
  if (state.value === 'loading') return ''
  if (scope.value === 'off') return ''
  return displayCount.value
})

const ariaLabel = computed(() => {
  if (state.value === 'unavailable') return fmt.value.badgeUnavailable(props.label)
  if (state.value === 'loading') return fmt.value.badgeLoading(props.label)
  if (scope.value === 'off') return fmt.value.badgeOff(props.label)
  return `${props.label}${count.value ?? 0}`
})

defineExpose({ state, count, scope })
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

/* Switched off by the viewer's task settings: the node stays (state and scope stay readable from
   its attributes, and the nav entry keeps its layout) but it draws nothing. */
.tasks-todo-badge--off {
  background: transparent;
  color: transparent;
  min-width: 0;
  padding: 0;
}
</style>
