<template>
  <span
    v-if="dot || shouldShowCount"
    class="mt-badge"
    :class="[`mt-badge--${tone}`, { 'mt-badge--dot': dot }]"
  >
    <template v-if="!dot">{{ displayCount }}</template>
  </span>
</template>

<script setup lang="ts">
// MtBadge — P2-1a shared UI primitive (multitable-ui-p2-structure-designlock-20260706.md §2 P2-1).
// Small count/status pill mirroring MetaCommentAffordance's badge sizing, re-expressed on UF-1
// `--ms-*` / `--el-*` tokens instead of that component's bespoke hex (design-lock §8 / §3.1).
import { computed } from 'vue'

export type MtBadgeTone = 'info' | 'primary' | 'success' | 'warning' | 'danger'

const props = withDefaults(defineProps<{
  count?: number
  showZero?: boolean
  dot?: boolean
  tone?: MtBadgeTone
}>(), {
  count: 0,
  showZero: false,
  dot: false,
  tone: 'info',
})

const shouldShowCount = computed(() => props.count > 0 || props.showZero)
// Cap the same way most list badges do (e.g. "99+") so a large count never blows out the pill.
const displayCount = computed(() => (props.count > 99 ? '99+' : props.count))
</script>

<style scoped>
.mt-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}

.mt-badge--dot {
  min-width: 6px;
  width: 6px;
  height: 6px;
  padding: 0;
  border-radius: 50%;
}

.mt-badge--info {
  background: var(--el-color-info-light-9);
  color: var(--ms-color-info);
}

.mt-badge--primary {
  background: var(--el-color-primary-light-9);
  color: var(--ms-color-primary);
}

.mt-badge--success {
  background: var(--el-color-success-light-9);
  color: var(--ms-color-success);
}

.mt-badge--warning {
  background: var(--el-color-warning-light-9);
  color: var(--ms-color-warning);
}

.mt-badge--danger {
  background: var(--el-color-danger-light-9);
  color: var(--ms-color-danger);
}

.mt-badge--dot.mt-badge--info { background: var(--ms-color-info); }
.mt-badge--dot.mt-badge--primary { background: var(--ms-color-primary); }
.mt-badge--dot.mt-badge--success { background: var(--ms-color-success); }
.mt-badge--dot.mt-badge--warning { background: var(--ms-color-warning); }
.mt-badge--dot.mt-badge--danger { background: var(--ms-color-danger); }
</style>
