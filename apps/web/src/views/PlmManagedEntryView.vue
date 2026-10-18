<template>
  <section data-testid="plm-managed-entry">
    <h1>进入 BOM 评审</h1>
    <p data-testid="plm-managed-entry-status">{{ message }}</p>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { PlmManagedCompanionError, startManagedBrowserBridge } from '../services/plm/plmManagedCompanion'

const message = ref('正在连接已映射的元图账号…')

function pinNoReferrer(): void {
  const meta = document.createElement('meta')
  meta.name = 'referrer'
  meta.content = 'no-referrer'
  document.head.appendChild(meta)
}

onMounted(async () => {
  pinNoReferrer()
  try {
    const started = await startManagedBrowserBridge(window.location.search)
    window.location.assign(started.navigationUrl)
  } catch (error) {
    message.value = error instanceof PlmManagedCompanionError ? '托管入口被拒绝' : '托管入口被拒绝'
  }
})
</script>
