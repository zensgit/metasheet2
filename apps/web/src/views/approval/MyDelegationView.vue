<template>
  <PageShell width="default">
    <PageHeader
      :title="t.title"
      :subtitle="t.subtitle"
    >
      <template #actions>
        <el-button type="primary" data-testid="my-delegation-new" @click="openCreate">{{ t.create }}</el-button>
      </template>
    </PageHeader>

    <el-table v-loading="loading" :data="delegations" data-testid="my-delegation-table" :empty-text="t.empty">
      <el-table-column :label="t.colDelegatee">
        <template #default="{ row }">{{ delegateeDisplay(row.delegateeUserId) }}</template>
      </el-table-column>
      <el-table-column :label="t.colScope">
        <template #default="{ row }">{{ scopeText(row) }}</template>
      </el-table-column>
      <el-table-column :label="t.colWindow">
        <template #default="{ row }">{{ fmt(row.startAt) }} ~ {{ fmt(row.endAt) }}</template>
      </el-table-column>
      <el-table-column :label="t.colStatus" width="150">
        <template #default="{ row }">
          <StatusTag domain="delegation" :status="delegationDisplayStatus(row).status" />
          <span v-if="delegationDisplayStatus(row).expiringSoon" class="expiring-soon-hint">{{ t.expiringSoon }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t.colRouted" width="110">
        <template #default="{ row }">
          <span data-testid="my-delegation-routed" :title="t.routedTitle">{{ row.routedApprovalCount ?? 0 }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t.colActions" width="100">
        <template #default="{ row }">
          <el-button v-if="row.active" type="danger" text size="small" data-testid="my-delegation-disable" @click="disable(row.id)">{{ t.disable }}</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogOpen" :title="t.dialogTitle" width="480px">
      <el-form label-width="92px">
        <el-form-item :label="t.colDelegatee">
          <ApprovalUserPicker
            :model-value="form.delegateeUserId || null"
            @update:model-value="form.delegateeUserId = $event ?? ''"
          />
        </el-form-item>
        <el-form-item :label="t.colScope">
          <el-select v-model="form.scope" data-testid="my-delegation-scope">
            <el-option :label="t.scopeAll" value="all" />
            <el-option :label="t.scopeTemplate" value="template" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="form.scope === 'template'" :label="t.formLabel">
          <el-input v-model="form.scopeTemplateId" :placeholder="t.templateIdPlaceholder" data-testid="my-delegation-template" />
        </el-form-item>
        <el-form-item :label="t.startAt">
          <el-date-picker v-model="form.startAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" />
        </el-form-item>
        <el-form-item :label="t.endAt">
          <el-date-picker v-model="form.endAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogOpen = false">{{ t.cancel }}</el-button>
        <el-button type="primary" :loading="saving" data-testid="my-delegation-submit" @click="submit">{{ t.save }}</el-button>
      </template>
    </el-dialog>
  </PageShell>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
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
import { ensureUserNamesResolved, getResolvedUserName } from '../../approvals/directoryResolve'
import { useLocale } from '../../composables/useLocale'
import { MY_EN, MY_ZH } from './myDelegationLabels'

// O-8 / F8-1: this view follows the shell locale (module-scope `useLocale()` singleton); its copy
// lives in myDelegationLabels.ts, interpolated copy is an `isZh.value ? … : …` pair below.
const { isZh } = useLocale()
const t = computed(() => (isZh.value ? MY_ZH : MY_EN))

function scopeText(row: DelegationRecord): string {
  if (row.scope !== 'template') return t.value.scopeAll
  return isZh.value ? `指定表单：${row.scopeTemplateId}` : `Form: ${row.scopeTemplateId}`
}

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

// member-display-identity (2026-08-19): this self-service view is reachable by ANY authenticated
// user (`/my-delegation`, `requiresAuth` only — see appRoutes.ts) and used to bind the 被委托人
// column's cell straight to the raw delegatee id column value. Resolved name when available; a
// values-free "未知用户" placeholder otherwise — never the raw id.
function delegateeDisplay(delegateeUserId: string): string {
  return getResolvedUserName(delegateeUserId) ?? t.value.unknownUser
}

watch(
  () => delegations.value.map((d) => d.delegateeUserId),
  (ids) => ensureUserNamesResolved(ids),
  { immediate: true },
)

async function load() {
  loading.value = true
  try {
    delegations.value = await listOwnDelegations()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : t.value.loadFailed)
  } finally {
    loading.value = false
  }
}

function openCreate() {
  Object.assign(form, { delegateeUserId: '', scope: 'all', scopeTemplateId: '', startAt: '', endAt: '' })
  dialogOpen.value = true
}

async function submit() {
  const error = validateOwnDelegationForm(form, isZh.value)
  if (error) {
    ElMessage.warning(error)
    return
  }
  saving.value = true
  try {
    await createOwnDelegation(buildOwnCreatePayload(form))
    ElMessage.success(t.value.created)
    dialogOpen.value = false
    await load()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : t.value.createFailed)
  } finally {
    saving.value = false
  }
}

// B2-05: 停用 is a routing-affecting action (it takes the delegatee out of the assignee
// resolution immediately) but was previously zero-friction — one click, no confirmation.
async function disable(id: string) {
  try {
    await ElMessageBox.confirm(
      t.value.disableConfirm,
      t.value.disableConfirmTitle,
      { confirmButtonText: t.value.disable, cancelButtonText: t.value.cancel, type: 'warning' },
    )
  } catch {
    return
  }
  try {
    await disableOwnDelegation(id)
    await load()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : t.value.disableFailed)
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
