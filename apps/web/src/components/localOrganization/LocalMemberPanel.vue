<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { LocalDepartment, LocalHead, LocalMember } from '../../services/localOrganizationClient'
const props = defineProps<{
  member: LocalMember; departments: LocalDepartment[]; disabled: boolean
  membershipId: string; head: LocalHead | null; headLoading: boolean; headError: string
}>()
const emit = defineEmits<{
  save: [id: string, value: { name: string }]
  archive: [id: string]; add: [accountId: string, departmentId: string]
  selectMembership: [id: string]; primary: [id: string]; manager: [id: string, value: boolean]
  head: [id: string, value: boolean]; retryHead: []
}>()
const name = ref('')
const archiveAcknowledged = ref(false)
const departmentId = ref('')
watch(() => props.member, member => {
  name.value = member.name; departmentId.value = ''
}, { immediate: true })
watch([() => props.member, () => props.departments, () => props.membershipId, () => props.disabled], () => {
  archiveAcknowledged.value = false
}, { flush: 'sync' })
const membership = computed(() => props.member.memberships.find(m => m.id === props.membershipId))
const available = computed(() => props.departments.filter(d => d.isActive && !props.member.memberships.some(m => m.departmentId === d.id)))
const hasArchivedDepartment = computed(() => props.member.memberships.some(m => !m.departmentActive))
const profileDisabled = computed(() => props.disabled || !props.member.isActive)
const membershipDisabled = computed(() => profileDisabled.value || !props.member.isEligible)
function save() {
  if (!profileDisabled.value && name.value.trim()) emit('save', props.member.id, { name: name.value.trim() })
}
function archive() {
  if (profileDisabled.value || !archiveAcknowledged.value) return
  const accountId = props.member.id
  archiveAcknowledged.value = false
  emit('archive', accountId)
}
</script>

<template>
  <section aria-labelledby="member-heading">
    <h2 id="member-heading">{{ member.name }}</h2>
    <p v-if="!member.isActive">成员已归档，仅供查看。</p>
    <p v-if="!member.isEligible">该成员没有可用的当前组织平台账号，部门关系操作不可用。</p>
    <p>组织目录职务（只读）：{{ member.title || '未提供' }}</p>
    <p>组织目录职务可能用于审批条件；不授予权限，也不会自动同步到平台岗位。平台岗位请通过“维护平台岗位”在用户管理中维护。</p>
    <form @submit.prevent="save">
      <fieldset :disabled="profileDisabled">
        <legend>成员资料</legend>
        <label>成员姓名<input v-model="name" required maxlength="200" /></label>
        <button type="submit" :disabled="!name.trim()">保存成员资料</button>
        <p id="member-archive-consequence">归档本地组织成员会停用本地目录账号；若同一组织内没有其他活跃且已链接的目录账号，现有组织成员资格可能被停用。不会删除平台用户或角色。</p>
        <label class="archive-ack"><input v-model="archiveAcknowledged" type="checkbox" aria-describedby="member-archive-consequence" />我已了解并确认归档本地组织成员的影响</label>
        <button type="button" :disabled="!archiveAcknowledged" @click="archive">归档本地组织成员</button>
      </fieldset>
    </form>
    <fieldset :disabled="membershipDisabled">
      <legend>部门关系</legend>
      <p>部门直属主管是部门级关系，不是为每位员工独立设置直属上级。部门负责人为独立标记，二者互不推导；成员角色不会从职务或部门名称等自由文本推导。</p>
      <p v-if="hasArchivedDepartment">存在已归档的关联部门：即使只是非主部门，也不能切换任何主部门。此页不会自动迁移或恢复归档关系。</p>
      <p v-if="!member.memberships.length">尚未加入部门；主部门需要明确设置。</p>
      <label>添加到部门<select v-model="departmentId">
        <option value="">请选择部门</option>
        <option v-for="d in available" :key="d.id" :value="d.id">{{ d.name }}</option>
      </select></label>
      <button type="button" :disabled="!departmentId" @click="emit('add', member.id, departmentId)">添加部门关系</button>
      <label>选择部门关系<select :value="membershipId" @change="emit('selectMembership', ($event.target as HTMLSelectElement).value)">
        <option value="">请选择部门关系</option>
        <option v-for="m in member.memberships" :key="m.id" :value="m.id">{{ m.departmentName }}{{ m.isPrimary ? '（主部门）' : '' }}{{ m.departmentActive ? '' : '（已归档）' }}</option>
      </select></label>
      <template v-if="membership">
        <p>{{ membership.isPrimary ? '当前主部门' : '非主部门' }} · {{ membership.isManager ? '部门直属主管' : '非部门直属主管' }}</p>
        <button type="button" :disabled="membership.isPrimary || hasArchivedDepartment" @click="emit('primary', membership.id)">设为主部门</button>
        <button type="button" :disabled="!membership.departmentActive" @click="emit('manager', membership.id, !membership.isManager)">{{ membership.isManager ? '取消部门直属主管' : '设为部门直属主管' }}</button>
        <p role="status">部门负责人：{{ headLoading ? '读取中' : head ? (head.isDepartmentHead ? '是' : '否') : '未知' }}</p>
        <p v-if="headError" role="alert">{{ headError }}</p>
        <button v-if="headError" type="button" :disabled="headLoading" @click="emit('retryHead')">重试读取负责人</button>
        <button type="button" :disabled="headLoading || !head || head.readOnly || !membership.departmentActive" @click="head && emit('head', membership.id, !head.isDepartmentHead)">{{ head?.isDepartmentHead ? '取消部门负责人' : '设为部门负责人' }}</button>
      </template>
    </fieldset>
  </section>
</template>

<style scoped>
section, fieldset { min-width: 0; }
fieldset { margin-block: 1rem; }
.archive-ack { display: flex; align-items: start; }
.archive-ack input { width: auto; flex: none; }
label { display: grid; gap: .3rem; margin-block: .7rem; }
input, select { min-width: 0; width: 100%; max-width: 100%; box-sizing: border-box; }
button { max-width: 100%; white-space: normal; margin: .25rem; }
h2, p { overflow-wrap: anywhere; }
</style>
