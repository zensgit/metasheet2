<template>
  <div v-if="mayDelete || dialogOpen" class="sp-delete">
    <button v-if="mayDelete" type="button" class="sp-delete__trigger" :disabled="disabled" data-testid="stock-prep-project-delete-open" @click="open">
      {{ title }}
    </button>
    <dialog ref="dialog" class="sp-delete__dialog" aria-labelledby="stock-prep-project-delete-title"
      data-testid="stock-prep-project-delete-dialog" @cancel.prevent="close">
      <form class="sp-delete__form" @submit.prevent="confirm">
        <h2 id="stock-prep-project-delete-title">{{ title }}</h2>
        <p class="sp-delete__warning">
          {{ bi(
            '此操作不可撤销。同一项目号下的试拉、手工试填和正式备料数据都会永久删除。日常保留数据请使用归档。',
            'This cannot be undone. Trial pulls, manually entered trial rows, and all production stock-preparation data under this project number will be permanently deleted. Use archive for routine retention.',
          ) }}
        </p>
        <p v-if="phase === 'preview'" role="status">{{ bi('正在读取影响范围…', 'Loading deletion impact…') }}</p>
        <template v-if="preview">
          <dl class="sp-delete__identity">
            <div><dt>{{ bi('租户', 'Tenant') }}</dt><dd>{{ preview.tenantId }}</dd></div>
            <div><dt>{{ bi('项目号', 'Project number') }}</dt><dd>{{ preview.projectNo }}</dd></div>
          </dl>
          <div class="sp-delete__impact">
            <section>
              <h3>{{ bi('受影响的表', 'Affected tables') }}</h3>
              <table v-if="preview.tables.length">
                <thead><tr><th scope="col">{{ bi('表名', 'Table') }}</th><th scope="col">{{ bi('清理范围', 'Scope') }}</th><th scope="col">{{ bi('行数', 'Rows') }}</th></tr></thead>
                <tbody>
                  <tr v-for="table in preview.tables" :key="table.sheetId">
                    <td>{{ table.name || table.sheetId }}</td>
                    <td>{{ table.kind === 'dedicated' ? bi('删除整表', 'Delete table') : bi('仅删除本项目行', 'Delete project rows') }}</td>
                    <td>{{ table.rowCount }}</td>
                  </tr>
                </tbody>
              </table>
              <p v-else class="sp-delete__empty">{{ bi('没有受影响的表。', 'No affected tables.') }}</p>
            </section>
            <section>
              <h3>{{ bi('分类数量', 'Record counts') }}</h3>
              <dl class="sp-delete__counts">
                <div v-for="(count, key) in preview.counts" :key="key">
                  <dt>{{ countLabel(key) }}</dt><dd>{{ count }}</dd>
                </div>
              </dl>
            </section>
          </div>
          <label v-if="phase !== 'confirm'" class="sp-delete__verify">
            <span>{{ bi('输入一次性验证码', 'Enter the one-time verification code') }}
              <strong data-testid="stock-prep-project-delete-code">{{ preview.verificationCode }}</strong>
            </span>
            <input v-model="code" type="text" maxlength="8" autocomplete="off" spellcheck="false"
              autocapitalize="off" data-testid="stock-prep-project-delete-code-input">
          </label>
        </template>
        <p v-if="error" class="sp-delete__error" role="alert" data-testid="stock-prep-project-delete-error">
          {{ bi(...error) }}
        </p>
        <div class="sp-delete__actions">
          <button type="button" autofocus :disabled="phase === 'confirm'" @click="close">
            {{ bi('取消', 'Cancel') }}
          </button>
          <button v-if="error && retryAllowed" type="button" data-testid="stock-prep-project-delete-repreview" @click="loadPreview">
            {{ bi('重新预览', 'Preview again') }}
          </button>
          <button v-if="preview || phase === 'confirm'" class="sp-delete__submit" type="submit" :disabled="!canConfirm"
            data-testid="stock-prep-project-delete-confirm">
            {{ phase === 'confirm' ? bi('正在删除…', 'Deleting…') : bi('永久删除项目', 'Permanently delete project') }}
          </button>
        </div>
      </form>
    </dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { onAuthSessionSwitch, TOKEN_KEYS } from '../../../composables/authPrincipal'
import { useAuth } from '../../../composables/useAuth'
import { useLocale } from '../../../composables/useLocale'
import { EXPLICIT_SESSION_ORG_KEY } from '../../../utils/explicitSessionOrg'
import type { IntegrationScope } from '../../../services/integration/workbench'
import { StockPreparationConfirmApiError } from '../../../services/integration/stockPreparation/confirmApi'
import {
  confirmStockPrepProjectDelete,
  previewStockPrepProjectDelete,
  readStockPrepProjectDeleteAccess,
  stockPrepProjectDeleteSession,
  type StockPrepDeletePreview,
} from '../../../services/integration/stockPreparation/projectDelete'

const props = withDefaults(defineProps<{ projectNo: string; scope?: IntegrationScope; disabled?: boolean }>(), { scope: () => ({}) })
const auth = useAuth()
const { locale } = useLocale()
const bi = (zh: string, en: string) => locale.value === 'zh-CN' ? zh : en
const title = computed(() => bi('删除项目（含全部备料数据）', 'Delete project and all stock-preparation data'))

type Message = [string, string]
const countLabels: Record<string, Message> = {
  dedicatedSheets: ['专属表', 'Dedicated tables'],
  dedicatedRows: ['专属表行', 'Rows in dedicated tables'],
  projectTargets: ['项目表登记', 'Project table registrations'],
  managedRegistrations: ['托管登记', 'Managed table registrations'],
  sharedPullRows: ['共享拉取表行', 'Rows in shared pull tables'],
  overviewRows: ['项目总览行', 'Project overview rows'],
  projectRows: ['项目记录', 'Project records'],
  snapshotBatches: ['快照批次', 'Snapshot batches'],
  snapshotLines: ['快照明细', 'Snapshot lines'],
  preparationLines: ['备料明细', 'Stock-preparation lines'],
  exceptions: ['异常记录', 'Exceptions'],
  confirmationDecisions: ['确认记录', 'Confirmation records'],
  runRows: ['运行记录', 'Run records'],
  trashRows: ['回收站记录', 'Trash records'],
  sheetDependencies: ['表关联记录', 'Table dependencies'],
  runtimeRecords: ['后台作业及运行记录', 'Background jobs and runtime records'],
  handoffs: ['交接记录', 'Handoffs'],
  packInstalls: ['项目包安装记录', 'Project package installations'],
  reconcileLeases: ['对账租约', 'Reconciliation leases'],
  pullBatches: ['拉取批次', 'Pull batches'],
  pullBatchExecutions: ['批次执行记录', 'Pull batch executions'],
  pullBatchSheets: ['批次关联表记录', 'Pull batch table records'],
  refreshIntents: ['刷新请求', 'Refresh requests'],
  refreshStates: ['刷新状态记录', 'Refresh states'],
  refreshHolds: ['刷新待确认项', 'Refresh holds'],
  refreshExecutions: ['刷新执行记录', 'Refresh executions'],
  sheetRepairClaims: ['修复申请', 'Table repair claims'],
  sheetRepairRuns: ['修复运行记录', 'Table repair runs'],
  reviewedCells: ['已审核单元格记录', 'Reviewed cells'],
  changePlans: ['变更方案', 'Change plans'],
  continuations: ['延续关系', 'Continuations'],
  continuationMembers: ['延续关系明细', 'Continuation members'],
  componentRulings: ['部件判定', 'Component rulings'],
}

function countLabel(key: string): string {
  return Object.prototype.hasOwnProperty.call(countLabels, key) ? bi(...countLabels[key]) : key
}

const mayDelete = ref(false)
const session = ref(stockPrepProjectDeleteSession(props.scope))
const dialog = ref<HTMLDialogElement | null>(null)
const dialogOpen = ref(false)
const phase = ref<'idle' | 'preview' | 'confirm'>('idle')
const preview = ref<StockPrepDeletePreview | null>(null)
const code = ref('')
const error = ref<Message | null>(null)
const retryAllowed = ref(true)
let generation = 0
let accessGeneration = 0
let expiryTimer: ReturnType<typeof setTimeout> | undefined

const canConfirm = computed(() => phase.value === 'idle' && preview.value !== null
  && code.value === preview.value.verificationCode)

function clearPreview(): void {
  clearTimeout(expiryTimer)
  preview.value = null
  code.value = ''
}

function close(): void {
  if (phase.value === 'confirm') return
  generation += 1
  clearPreview()
  error.value = null
  phase.value = 'idle'
  dialog.value?.close()
  dialogOpen.value = false
}

function expire(): void {
  clearPreview()
  error.value = ['验证码已过期。请重新预览。', 'The code expired. Preview the deletion again.']
}

function failure(cause: unknown, submitted: boolean): void {
  if (cause instanceof StockPreparationConfirmApiError) {
    if ([401, 403].includes(cause.status) || cause.code === 'STOCK_PREPARATION_PROJECT_DELETE_DISABLED') {
      revokeAccess()
      return
    }
    switch (cause.code) {
      case 'STOCK_PREPARATION_PROJECT_DELETE_AMBIGUOUS':
        error.value = ['记录归属不明确，无法删除项目。', 'Deletion was blocked because ownership of some records could not be established.']
        return
      case 'STOCK_PREPARATION_PROJECT_DELETE_DEPENDENCY':
        error.value = ['项目有关联资料或订阅受到保护。处理后请重新预览。', 'The project has protected related records or subscriptions. Resolve them before previewing again.']
        return
      case 'STOCK_PREPARATION_PROJECT_DELETE_BUSY':
        error.value = ['项目正在处理。完成后请重新预览。', 'The project is busy. Preview again once processing finishes.']
        return
      case 'STOCK_PREPARATION_PROJECT_DELETE_STALE':
        error.value = ['预览后数据已变更。请重新预览。', 'The data changed after the preview. Preview the deletion again.']
        return
      case 'STOCK_PREPARATION_PROJECT_DELETE_CHALLENGE_INVALID':
        error.value = ['验证码已失效。请重新预览。', 'The code is no longer valid. Preview the deletion again.']
        return
      case 'STOCK_PREPARATION_PROJECT_ABSENT':
        error.value = ['当前租户找不到这个项目。', 'This project could not be found in the current tenant.']
        return
    }
  }
  error.value = submitted
    ? ['无法确认删除结果。请重新预览。', 'The deletion result could not be confirmed. Preview again.']
    : ['读取影响范围失败。请重新预览。', 'Could not load deletion impact. Preview again.']
}

function isCurrent(request: number): boolean {
  return request === generation && session.value !== null && session.value === stockPrepProjectDeleteSession(props.scope)
}

async function loadPreview(): Promise<void> {
  if (!mayDelete.value || !isCurrent(generation) || phase.value !== 'idle') return
  const request = ++generation
  clearPreview()
  error.value = null
  retryAllowed.value = true
  phase.value = 'preview'
  try {
    const result = await previewStockPrepProjectDelete(props.projectNo)
    if (!isCurrent(request)) return
    if (props.scope.tenantId && props.scope.tenantId !== result.tenantId) throw new Error('STOCK_PREPARATION_PROJECT_DELETE_TENANT_MISMATCH')
    const remaining = Date.parse(result.expiresAt) - Date.now()
    if (remaining <= 0) {
      expire()
      return
    }
    preview.value = result
    expiryTimer = setTimeout(expire, remaining)
  } catch (cause) {
    if (isCurrent(request)) failure(cause, false)
  } finally {
    if (isCurrent(request)) phase.value = 'idle'
  }
}

function open(): void {
  if (!mayDelete.value || !isCurrent(generation) || props.disabled || !dialog.value || dialog.value.open) return
  dialog.value.showModal()
  dialogOpen.value = true
  void loadPreview()
}

async function confirm(): Promise<void> {
  const current = preview.value
  if (!mayDelete.value || !isCurrent(generation) || !canConfirm.value || !current || current.projectNo !== props.projectNo) return
  if (Date.parse(current.expiresAt) <= Date.now()) {
    expire()
    return
  }
  const request = ++generation
  const typedCode = code.value
  phase.value = 'confirm'
  clearPreview()
  try {
    await confirmStockPrepProjectDelete(current, typedCode, { ...props.scope })
    if (!isCurrent(request)) return
    phase.value = 'idle'
    close()
  } catch (cause) {
    if (isCurrent(request)) {
      phase.value = 'idle'
      failure(cause, true)
    }
  }
}

function revokeAccess(): void {
  accessGeneration += 1
  mayDelete.value = false
  if (!dialogOpen.value || phase.value === 'confirm') return
  generation += 1
  clearPreview()
  phase.value = 'idle'
  retryAllowed.value = false
  error.value = ['当前无法使用项目删除。', 'Project deletion is unavailable for this session.']
}

async function refreshAccess(): Promise<void> {
  if (session.value === null || auth.hasAdminAccess?.() !== true) return
  const request = ++accessGeneration
  const requestSession = session.value
  const allowed = await readStockPrepProjectDeleteAccess().catch(() => false)
  if (request !== accessGeneration || requestSession !== stockPrepProjectDeleteSession(props.scope)) return
  if (allowed) mayDelete.value = true
  else revokeAccess()
}

function syncSession(): void {
  session.value = stockPrepProjectDeleteSession(props.scope)
}

function onStorage(event: StorageEvent): void {
  if (event.key === null || [EXPLICIT_SESSION_ORG_KEY, ...TOKEN_KEYS, 'tenantId', 'workspaceId'].includes(event.key)) syncSession()
}

function onFocus(): void {
  const previous = session.value
  syncSession()
  if (previous === session.value) void refreshAccess()
}

const stopSessionWatch = onAuthSessionSwitch(syncSession)
window.addEventListener('storage', onStorage)
window.addEventListener('focus', onFocus)
watch([session, () => props.projectNo, () => auth.hasAdminAccess?.() === true], () => {
  phase.value = 'idle'
  close()
  accessGeneration += 1
  mayDelete.value = false
  void refreshAccess()
}, { immediate: true })
watch([() => props.scope.tenantId, () => props.scope.workspaceId], syncSession)

onBeforeUnmount(() => {
  stopSessionWatch()
  window.removeEventListener('storage', onStorage)
  window.removeEventListener('focus', onFocus)
  accessGeneration += 1
  generation += 1
  clearPreview()
})
</script>

<style scoped>
.sp-delete__trigger {
  padding: var(--ms-space-1) var(--ms-space-2);
  color: var(--ms-color-danger);
  border: 1px solid currentColor;
  border-radius: var(--ms-radius-sm);
  background: transparent;
  font: inherit;
  cursor: pointer;
}

.sp-delete__dialog {
  width: min(42rem, calc(100% - 2rem));
  max-height: calc(100dvh - 2rem);
  box-sizing: border-box;
  padding: clamp(var(--ms-space-4), 4vw, var(--ms-space-5));
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-lg);
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  box-shadow: var(--ms-shadow-pop);
  overflow: auto;
}

.sp-delete__dialog::backdrop { background: color-mix(in srgb, var(--ms-text-1) 50%, transparent); }
.sp-delete__form { display: grid; gap: var(--ms-space-4); }
.sp-delete__form :is(h2, h3, p, dl, dd) { margin: 0; }
.sp-delete__form h2 { font-size: var(--ms-font-size-page-title); }
.sp-delete__form h3 { font-size: var(--ms-font-size-section-title); margin-bottom: var(--ms-space-2); }
.sp-delete__warning {
  background: color-mix(in srgb, var(--ms-color-danger) 9%, var(--ms-bg-card));
  color: color-mix(in srgb, var(--ms-color-danger) 65%, var(--ms-text-1));
  border-radius: var(--ms-radius-sm);
  padding: var(--ms-space-3);
}
.sp-delete__error { color: var(--ms-color-danger); }
.sp-delete__identity, .sp-delete__impact { display: grid; gap: var(--ms-space-3); }
.sp-delete__identity { grid-template-columns: 1fr 1fr; }
.sp-delete__identity dt { font-size: 0.8rem; }
.sp-delete__identity dd { font-weight: 650; overflow-wrap: anywhere; }
.sp-delete__impact table { width: 100%; border-collapse: collapse; text-align: left; }
.sp-delete__impact :is(th, td) { border-bottom: 1px solid var(--ms-border); padding: var(--ms-space-1) var(--ms-space-2); overflow-wrap: anywhere; }
.sp-delete__impact :is(th, td):last-child { text-align: right; }
.sp-delete__counts { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: var(--ms-space-1) var(--ms-space-4); }
.sp-delete__counts div { display: flex; justify-content: space-between; gap: var(--ms-space-2); }
.sp-delete__counts :is(dt, dd) { overflow-wrap: anywhere; }
.sp-delete__verify { display: grid; gap: var(--ms-space-2); justify-items: start; }
.sp-delete__verify strong { display: inline-block; padding: var(--ms-space-1) var(--ms-space-2); background: var(--ms-bg-page); border-radius: var(--ms-radius-sm); letter-spacing: 0.12em; }
.sp-delete__verify input { width: min(100%, 12rem); padding: var(--ms-space-2); box-sizing: border-box; font: inherit; }
.sp-delete__actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--ms-space-2); }
.sp-delete__actions button { border: 1px solid var(--ms-border); border-radius: var(--ms-radius-sm); padding: var(--ms-space-2) var(--ms-space-3); font: inherit; cursor: pointer; }
button.sp-delete__submit { background: var(--ms-color-danger); border-color: var(--ms-color-danger); color: var(--ms-bg-card); }
.sp-delete button:disabled { cursor: not-allowed; opacity: 0.55; }
</style>
