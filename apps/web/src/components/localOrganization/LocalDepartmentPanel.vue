<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { DepartmentInput, LocalDepartment } from '../../services/localOrganizationClient'
import { departmentRows, parentOptions } from './departmentTree'
const props = defineProps<{ departments: LocalDepartment[]; disabled: boolean }>()
const emit = defineEmits<{ save: [id: string | null, value: DepartmentInput]; archive: [id: string] }>()
const selectedId = ref('')
const archiveAcknowledged = ref(false)
const name = ref('')
const parentId = ref('')
const order = ref(0)
const selected = computed(() => props.departments.find(d => d.id === selectedId.value))
const rows = computed(() => departmentRows(props.departments))
const parents = computed(() => parentOptions(props.departments, selectedId.value))
watch([selectedId, () => props.departments], () => {
  name.value = selected.value?.name ?? ''
  parentId.value = selected.value?.parentDepartmentId ?? ''
  order.value = selected.value?.orderIndex ?? 0
}, { immediate: true })
watch([selectedId, () => props.departments, () => props.disabled], () => {
  archiveAcknowledged.value = false
}, { flush: 'sync' })
function archive() {
  const department = selected.value
  if (props.disabled || !department?.isActive || !archiveAcknowledged.value) return
  const departmentId = department.id
  archiveAcknowledged.value = false
  emit('archive', departmentId)
}
function save() {
  if (props.disabled || selected.value?.isActive === false || !name.value.trim() || !Number.isSafeInteger(order.value)) return
  emit('save', selectedId.value || null, { name: name.value.trim(), parentDepartmentId: parentId.value || null, orderIndex: order.value })
}
</script>

<template>
  <section aria-labelledby="departments-heading" class="department-panel">
    <h2 id="departments-heading">部门</h2>
    <p v-if="!departments.length">暂无部门。可创建组织的第一个部门。</p>
    <ul aria-label="组织部门">
      <li v-for="row in rows" :key="row.department.id" :style="{ paddingInlineStart: Math.min(row.depth, 5) * 12 + 'px' }">
        <button type="button" :disabled="disabled" :aria-pressed="selectedId === row.department.id" @click="selectedId = row.department.id">
          {{ row.department.name }}{{ row.department.isActive ? '' : '（已归档）' }}
        </button>
        <span v-if="row.department.parentMissing">上级部门不可用</span>
      </li>
    </ul>
    <button type="button" :disabled="disabled" @click="selectedId = ''; name = ''; parentId = ''; order = 0">新建部门</button>
    <p v-if="selected && !selected.isActive">此部门已归档，仅供查看。</p>
    <form @submit.prevent="save">
      <fieldset :disabled="disabled || selected?.isActive === false">
        <legend>{{ selected ? '编辑部门' : '创建部门' }}</legend>
        <label>部门名称<input v-model="name" required maxlength="200" /></label>
        <label>上级部门<select v-model="parentId">
          <option value="">无上级部门</option>
          <option v-if="parentId && !parents.some(d => d.id === parentId)" :value="parentId" disabled>当前上级不可用，请重新选择</option>
          <option v-for="d in parents" :key="d.id" :value="d.id">{{ d.name }}</option>
        </select></label>
        <label>部门排序<input v-model.number="order" type="number" step="1" required /></label>
        <button type="submit" :disabled="!name.trim() || !Number.isSafeInteger(order)">保存部门</button>
        <template v-if="selected">
          <p id="department-archive-consequence">归档后部门仅供查看。任何关联此部门的成员都不能切换任何主部门，即使被归档的只是非主部门。此页不会自动迁移或恢复关系。</p>
          <label class="archive-ack"><input v-model="archiveAcknowledged" type="checkbox" aria-describedby="department-archive-consequence" />我已了解并确认归档部门的影响</label>
          <button type="button" :disabled="!archiveAcknowledged" @click="archive">归档部门</button>
        </template>
      </fieldset>
    </form>
  </section>
</template>

<style scoped>
.department-panel { min-width: 0; }
ul { list-style: none; padding: 0; max-height: 22rem; overflow-y: auto; }
li { margin-block: .4rem; overflow-wrap: anywhere; }
button { max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
fieldset { min-width: 0; margin-top: 1rem; }
.archive-ack { display: flex; align-items: start; }
.archive-ack input { width: auto; flex: none; }
label { display: grid; gap: .3rem; margin-block: .7rem; }
input, select { box-sizing: border-box; min-width: 0; width: 100%; max-width: 100%; }
</style>
