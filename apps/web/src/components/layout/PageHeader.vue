<template>
  <header class="ms-page-header">
    <div class="ms-page-header__top">
      <el-button
        v-if="showBack"
        text
        class="ms-page-header__back"
        @click="handleBack"
      >
        <el-icon><ArrowLeft /></el-icon>
        {{ backLabel }}
      </el-button>
      <div class="ms-page-header__titles">
        <h1 class="ms-page-header__title">{{ title }}</h1>
        <p v-if="subtitle" class="ms-page-header__subtitle">{{ subtitle }}</p>
      </div>
      <div v-if="$slots.actions" class="ms-page-header__actions">
        <slot name="actions" />
      </div>
    </div>
    <div v-if="$slots.meta" class="ms-page-header__meta">
      <slot name="meta" />
    </div>
  </header>
</template>

<script setup lang="ts">
// PageHeader — the single page-header convention for the UI foundation design-lock
// (docs/development/ui-foundation-design-lock-20260706.md §3.3 / §6 UF-2): title / optional
// subtitle / optional back button / right-aligned actions / optional meta chip row.
//
// Back-navigation contract (presentation-only — no navigation behavior change):
// - `backTo`: a plain route PATH. Clicking pushes that path directly via `router.push(path)`.
//   Only safe to use when the original view already navigated by path with no extra semantics.
// - `back`: emits a `back` event instead of navigating itself; the adopting view wires its
//   EXISTING back handler (which may use `router.back()`, `router.push({ name })`, etc.) via
//   `@back="existingHandler"`. Use this whenever the original call shape must stay byte-identical
//   (e.g. `router.back()`, or `router.push({ name: ... })`/`router.push({ path: ... })` object
//   forms — `backTo` would change the call shape to a bare-string `router.push(path)`).
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowLeft } from '@element-plus/icons-vue'

const props = withDefaults(
  defineProps<{
    title: string
    subtitle?: string
    /** Route path to push directly when clicked. Ignored if `back` is also set. */
    backTo?: string
    /** Emit a `back` event instead of navigating; the view handles it with its existing handler. */
    back?: boolean
    /** Back-button label — views keep their own existing copy (返回 / 返回列表 / 返回模板列表 / ...). */
    backLabel?: string
  }>(),
  { backLabel: '返回' },
)

const emit = defineEmits<{ back: [] }>()

const router = useRouter()

const showBack = computed(() => Boolean(props.back || props.backTo))

function handleBack() {
  if (props.back) {
    emit('back')
    return
  }
  if (props.backTo) {
    router.push(props.backTo)
  }
}
</script>

<style scoped>
.ms-page-header {
  margin-bottom: var(--ms-space-5);
}

.ms-page-header__top {
  display: flex;
  align-items: center;
  gap: var(--ms-space-3);
  flex-wrap: wrap;
}

.ms-page-header__titles {
  flex: 1;
  min-width: 0;
}

.ms-page-header__title {
  margin: 0;
  font-size: var(--ms-font-size-page-title);
  font-weight: var(--ms-font-weight-title);
  color: var(--ms-text-1);
}

.ms-page-header__subtitle {
  margin: var(--ms-space-1) 0 0;
  font-size: 13px;
  color: var(--ms-text-2);
}

.ms-page-header__actions {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
  flex-wrap: wrap;
}

.ms-page-header__meta {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
  flex-wrap: wrap;
  margin-top: var(--ms-space-3);
}
</style>
