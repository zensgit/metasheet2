<template>
  <PageShell width="default">
    <PageHeader
      title="委托管理"
      subtitle="为审批人配置时间窗内的委托（委托人 → 被委托人）。同一委托人 + 范围目标仅允许一条生效委托。"
    >
      <template #actions>
        <div class="actions">
          <el-switch
            v-model="includeInactive"
            data-testid="delegation-history-toggle"
            active-text="显示历史"
            @change="load"
          />
          <el-button type="primary" :disabled="!canManage" data-testid="delegation-new" @click="openCreate">新建委托</el-button>
        </div>
      </template>
    </PageHeader>

    <el-alert v-if="!canManage" type="info" :closable="false" title="需要审批模板管理权限才能配置委托" />

    <el-table v-loading="loading" :data="delegations" data-testid="delegation-table" :empty-text="includeInactive ? '暂无委托' : '暂无生效委托'">
      <!-- UF-8: no display-name field on DelegationRecord (raw user IDs only) — a name/picker
           lookup is the flagged B3-04-tail follow-up, out of scope for this presentation-only
           slice. Honest <code> fallback names these as machine values (design-lock §3.5). -->
      <el-table-column label="委托人">
        <template #default="{ row }"><code class="delegation-code">{{ row.delegatorUserId }}</code></template>
      </el-table-column>
      <el-table-column label="被委托人">
        <template #default="{ row }"><code class="delegation-code">{{ row.delegateeUserId }}</code></template>
      </el-table-column>
      <el-table-column label="范围">
        <template #default="{ row }">{{ row.scope === 'template' ? `指定模板：${row.scopeTemplateId}` : '全部审批' }}</template>
      </el-table-column>
      <el-table-column label="时间窗">
        <template #default="{ row }">{{ fmt(row.startAt) }} ~ {{ fmt(row.endAt) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="150">
        <template #default="{ row }">
          <StatusTag domain="delegation" :status="delegationDisplayStatus(row).status" />
          <span v-if="delegationDisplayStatus(row).expiringSoon" class="expiring-soon-hint">即将到期</span>
        </template>
      </el-table-column>
      <el-table-column v-if="includeInactive" label="已路由审批" width="110">
        <template #default="{ row }">
          <span data-testid="delegation-routed" :title="'经该委托人路由的审批数（按委托人聚合，含历史窗口）'">{{ row.routedApprovalCount ?? 0 }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="100">
        <template #default="{ row }">
          <el-button v-if="row.active" type="danger" text size="small" :disabled="!canManage" data-testid="delegation-disable" @click="disable(row.id)">停用</el-button>
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
  </PageShell>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageShell from '../../components/layout/PageShell.vue'
import PageHeader from '../../components/layout/PageHeader.vue'
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
import { delegationDisplayStatus } from '../../approvals/delegationStatus'
import StatusTag from '../../components/status/StatusTag.vue'

const { canManageTemplates: canManage } = useApprovalPermissions()
const delegations = ref<DelegationRecord[]>([])
const loading = ref(false)
const saving = ref(false)
const dialogOpen = ref(false)
// Audit toggle: off = active only (default); on = active + history (disabled/expired).
const includeInactive = ref(false)

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
    delegations.value = await listDelegations({ includeInactive: includeInactive.value })
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
    await disableDelegation(id)
    await load()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '停用委托失败')
  }
}

onMounted(load)
</script>

<style scoped>
.actions { display: flex; align-items: center; gap: 12px; }
.expiring-soon-hint {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  color: var(--el-color-warning);
}
.delegation-code {
  font-family: monospace;
  font-size: 12px;
  background: var(--ms-bg-page);
  padding: 1px 4px;
  border-radius: var(--ms-radius-sm);
}
</style>
