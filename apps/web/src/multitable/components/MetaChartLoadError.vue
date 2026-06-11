<template>
  <!-- r2 item 3: error fallback for the lazy MetaChartRenderer chunk. A lazy-chunk network failure
       (or timeout) would otherwise leave the panel silently empty; this surfaces it + offers retry. -->
  <div class="meta-chart-load-error" data-chart-load-error="true">
    <span class="meta-chart-load-error__msg">{{ viewRenderLabel('dashboard.chartLoadFailed', isZh) }}</span>
    <button
      type="button"
      class="meta-chart-load-error__retry"
      data-action="retry-chart-load"
      @click="onRetry"
    >{{ viewRenderLabel('dashboard.retry', isZh) }}</button>
  </div>
</template>

<script setup lang="ts">
import { useLocale } from '../../composables/useLocale'
import { viewRenderLabel } from '../utils/meta-view-render-labels'

const { isZh } = useLocale()

// Vue's defineAsyncComponent passes the error component a `retry` prop that re-attempts the loader
// (see the `error` slot contract). Reloading the page is the universal fallback when it is absent
// (e.g. a stand-alone mount), so retry always does something.
const props = defineProps<{
  retry?: () => void
}>()

function onRetry(): void {
  if (typeof props.retry === 'function') {
    props.retry()
    return
  }
  if (typeof window !== 'undefined') {
    window.location.reload()
  }
}
</script>

<style scoped>
.meta-chart-load-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 120px;
  padding: 16px;
  font-size: 12px;
  color: #b91c1c;
  text-align: center;
}

.meta-chart-load-error__retry {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 4px 12px;
  background: #fff;
  color: #0f172a;
  font-size: 12px;
  cursor: pointer;
}
</style>
