<template>
  <section data-testid="plm-snapshot-share-return"><h1>返回 BOM 协作</h1><p role="status">{{ message }}</p>
    <button v-if="retry" type="button" @click="complete">重试本次分享</button>
    <button v-if="retry" type="button" @click="resume">回到元图重新确认</button>
  </section>
</template>
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { completeSnapshotShare, resumeSnapshotShare } from '../services/plm/plmSnapshotShare'
const message = ref('正在确认本次快照分享…'), retry = ref(false)
const search = window.location.search
window.history.replaceState(null, '', '/plm/snapshot-share-return')
async function complete() {
  retry.value = false
  try { window.location.assign(await completeSnapshotShare(search)) }
  catch (error) { message.value = error instanceof Error ? error.message : '分享未完成。'; retry.value = true }
}
onMounted(complete)
async function resume() {
  try { await resumeSnapshotShare() } catch (error) { message.value = error instanceof Error ? error.message : '分享未完成。' }
}
</script>
