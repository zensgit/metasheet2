<template>
  <section data-testid="plm-snapshot-share">
    <button type="button" :disabled="busy || !partId" @click="loadTargets">分享 BOM 快照到协作空间</button>
    <template v-if="targets.length">
      <label>目标空间 <select v-model="baseId" :disabled="busy"><option v-for="base in targets" :key="base.id" :value="base.id">{{ base.name }}</option></select></label>
      <label>协作表名称 <input v-model="name" :disabled="busy" maxlength="200" /></label>
      <p>快照按目标权限保留，包括后续被授权成员和系统管理员。原生撤权停止新读取和写回，不会删除已有快照。下一步需在元图独立确认分享。</p>
      <button type="button" :disabled="busy || !baseId || !name.trim()" @click="share">前往元图确认</button>
      <button type="button" :disabled="busy" @click="forget">另起一次分享</button>
    </template>
    <p role="status">{{ message }}</p>
  </section>
</template>
<script setup lang="ts">
import { ref } from 'vue'
import { snapshotShareTargets, startSnapshotShare, forgetSnapshotShare } from '../../services/plm/plmSnapshotShare'
const props = defineProps<{ dataSourceId: string; partId: string }>()
const targets = ref<{ id: string; name: string }[]>([]), baseId = ref(''), name = ref('BOM 协作'), busy = ref(false), message = ref('')
async function loadTargets() {
  busy.value = true
  try { targets.value = await snapshotShareTargets(props.dataSourceId, props.partId); baseId.value = targets.value[0]?.id ?? ''; message.value = targets.value.length ? '' : '当前没有可创建协作表的空间。' }
  catch { message.value = '请先以个人身份进入托管 BOM，并确认当前空间权限。' }
  finally { busy.value = false }
}
async function share() {
  busy.value = true
  try { await startSnapshotShare({ dataSourceId: props.dataSourceId, partId: props.partId, baseId: baseId.value, name: name.value.trim() }) }
  catch (error) { message.value = error instanceof Error ? error.message : '分享未完成。' }
  finally { busy.value = false }
}
function forget() { forgetSnapshotShare(); message.value = '下一次分享将重新确认身份、目标和原生权限。' }
</script>
