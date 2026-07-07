<template>
  <PageShell width="default">
    <PageHeader
      title="我的委托"
      subtitle="设置或取消你自己的审批委托（委托人恒为你本人）。同一范围目标仅允许一条生效委托。"
    >
      <template #actions>
        <el-button type="primary" data-testid="my-delegation-new" @click="openCreate">新建委托</el-button>
      </template>
    </PageHeader>

    <el-table v-loading="loading" :data="delegations" data-testid="my-delegation-table" empty-text="暂无委托">
      <el-table-column label="被委托人" prop="delegateeUserId" />
      <el-table-column label="范围">
        <template #default="{ row }">{{ row.scope === 'template' ? `指定模板：${row.scopeTemplateId}` : '全部审批' }}</template>
      </el-table-column>
      <el-table-column label="时间窗">
        <template #default="{ row }">{{ fmt(row.startAt) }} ~ {{ fmt(row.endAt) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="150">
        <template #default="{ row }">
          <StatusTag domain="delegation" :status="delegationDisplayStatus(row).status" force-locale="zh" />
          <span v-if="delegationDisplayStatus(row).expiringSoon" class="expiring-soon-hint">即将到期</span>
        </template>
      </el-table-column>
      <el-table-column label="已路由审批" width="110">
        <template #default="{ row }">
          <span data-testid="my-delegation-routed" :title="'经你的委托路由的审批数（按委托人聚合，含历史窗口）'">{{ row.routedApprovalCount ?? 0 }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="100">
        <template #default="{ row }">
          <el-button v-if="row.active" type="danger" text size="small" data-testid="my-delegation-disable" @click="disable(row.id)">停用</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogOpen" title="新建我的委托" width="480px">
      <el-form label-width="92px">
        <el-form-item label="被委托人">
          <ApprovalUserPicker
            :model-value="form.delegateeUserId || null"
            @update:model-value="form.delegateeUserId = $event ?? ''"
          />
        </el-form-item>
        <el-form-item label="范围">
          <el-select v-model="form.scope" data-testid="my-delegation-scope">
            <el-option label="全部审批" value="all" />
            <el-option label="指定模板" value="template" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="form.scope === 'template'" label="模板">
          <el-input v-model="form.scopeTemplateId" placeholder="审批模板 ID" data-testid="my-delegation-template" />
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
        <el-button type="primary" :loading="saving" data-testid="my-delegation-submit" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </PageShell>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageShell from '../../components/layout/PageShell.vue'
import PageHeader from '../../components/layout/PageHeader.vue'
import {
  listOwnDelegations,
  createOwnDelegation,
  disableOwnDelegation,
  validateOwnDelegationForm,
  buildOwnCreatePayload,
  type DelegationRecord,
  type OwnDelegationForm,
} from '../../approvals/delegations'
import { delegationDisplayStatus } from '../../approvals/delegationStatus'
import ApprovalUserPicker from '../../approvals/components/ApprovalUserPicker.vue'
import StatusTag from '../../components/status/StatusTag.vue'

const delegations = ref<DelegationRecord[]>([])
const loading = ref(false)
const saving = ref(false)
const dialogOpen = ref(false)

const form = reactive<OwnDelegationForm>({
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
    delegations.value = await listOwnDelegations()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载委托失败')
  } finally {
    loading.value = false
  }
}

function openCreate() {
  Object.assign(form, { delegateeUserId: '', scope: 'all', scopeTemplateId: '', startAt: '', endAt: '' })
  dialogOpen.value = true
}

async function submit() {
  const error = validateOwnDelegationForm(form)
  if (error) {
    ElMessage.warning(error)
    return
  }
  saving.value = true
  try {
    await createOwnDelegation(buildOwnCreatePayload(form))
    ElMessage.success('委托已创建')
    dialogOpen.value = false
    await load()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '创建委托失败')
  } finally {
    saving.value = false
  }
}

// B2-05: 停用 is a routing-affecting action (it takes the delegatee out of the assignee
// resolution immediately) but was previously zero-friction — one click, no confirmation.
async function disable(id: string) {
  try {
    await ElMessageBox.confirm(
      '停用后该委托立即失效，进行中的转交不受影响。确定停用吗？',
      '停用委托',
      { confirmButtonText: '停用', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  try {
    await disableOwnDelegation(id)
    await load()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '停用委托失败')
  }
}

onMounted(load)
</script>

<style scoped>
.expiring-soon-hint {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  color: var(--el-color-warning);
}
</style>
