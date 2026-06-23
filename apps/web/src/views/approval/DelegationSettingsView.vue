<template>
  <div class="delegation-settings">
    <div class="header">
      <div>
        <h2>委托设置</h2>
        <p class="sub">为审批人配置时间窗内的委托（委托人 → 被委托人）。同一委托人 + 范围目标仅允许一条生效委托。</p>
      </div>
      <el-button type="primary" :disabled="!canManage" data-testid="delegation-new" @click="openCreate">新建委托</el-button>
    </div>

    <el-alert v-if="!canManage" type="info" :closable="false" title="需要审批模板管理权限才能配置委托" />

    <el-table v-loading="loading" :data="delegations" data-testid="delegation-table" empty-text="暂无生效委托">
      <el-table-column label="委托人" prop="delegatorUserId" />
      <el-table-column label="被委托人" prop="delegateeUserId" />
      <el-table-column label="范围">
        <template #default="{ row }">{{ row.scope === 'template' ? `指定模板：${row.scopeTemplateId}` : '全部审批' }}</template>
      </el-table-column>
      <el-table-column label="时间窗">
        <template #default="{ row }">{{ fmt(row.startAt) }} ~ {{ fmt(row.endAt) }}</template>
      </el-table-column>
      <el-table-column label="状态">
        <template #default="{ row }">{{ row.active ? '生效' : '已停用' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="100">
        <template #default="{ row }">
          <el-button type="danger" text size="small" :disabled="!canManage" data-testid="delegation-disable" @click="disable(row.id)">停用</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogOpen" title="新建委托" width="480px">
      <el-form label-width="92px">
        <el-form-item label="委托人">
          <el-input v-model="form.delegatorUserId" placeholder="委托人用户 ID" data-testid="delegation-delegator" />
        </el-form-item>
        <el-form-item label="被委托人">
          <el-input v-model="form.delegateeUserId" placeholder="被委托人用户 ID" data-testid="delegation-delegatee" />
        </el-form-item>
        <el-form-item label="范围">
          <el-select v-model="form.scope" data-testid="delegation-scope">
            <el-option label="全部审批" value="all" />
            <el-option label="指定模板" value="template" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="form.scope === 'template'" label="模板">
          <el-input v-model="form.scopeTemplateId" placeholder="审批模板 ID" data-testid="delegation-template" />
        </el-form-item>
        <el-form-item label="开始时间">
          <el-date-picker v-model="form.startAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" />
        </el-form-item>
        <el-form-item label="结束时间">
          <el-date-picker v-model="form.endAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" data-testid="delegation-submit" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useApprovalPermissions } from '../../approvals/permissions'
import {
  listDelegations,
  createDelegation,
  disableDelegation,
  validateDelegationForm,
  buildCreatePayload,
  type DelegationRecord,
  type DelegationForm,
} from '../../approvals/delegations'

const { canManageTemplates: canManage } = useApprovalPermissions()
const delegations = ref<DelegationRecord[]>([])
const loading = ref(false)
const saving = ref(false)
const dialogOpen = ref(false)

const form = reactive<DelegationForm>({
  delegatorUserId: '',
  delegateeUserId: '',
  scope: 'all',
  scopeTemplateId: '',
  startAt: '',
  endAt: '',
})

function fmt(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

async function load() {
  loading.value = true
  try {
    delegations.value = await listDelegations()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载委托失败')
  } finally {
    loading.value = false
  }
}

function openCreate() {
  Object.assign(form, { delegatorUserId: '', delegateeUserId: '', scope: 'all', scopeTemplateId: '', startAt: '', endAt: '' })
  dialogOpen.value = true
}

async function submit() {
  const error = validateDelegationForm(form)
  if (error) {
    ElMessage.warning(error)
    return
  }
  saving.value = true
  try {
    await createDelegation(buildCreatePayload(form))
    ElMessage.success('委托已创建')
    dialogOpen.value = false
    await load()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '创建委托失败')
  } finally {
    saving.value = false
  }
}

async function disable(id: string) {
  try {
    await disableDelegation(id)
    await load()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '停用委托失败')
  }
}

onMounted(load)
</script>

<style scoped>
.delegation-settings { padding: 16px; }
.header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
.header h2 { margin: 0; }
.sub { color: var(--el-text-color-secondary); font-size: 13px; margin: 4px 0 0; }
</style>
