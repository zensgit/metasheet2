<template>
  <section v-if="canRelabel" class="stock-prep-relabel" data-testid="stock-prep-relabel">
    <!-- R-11: rendered ONLY for a principal the server would accept (stock-prep:admin and above — the
         same decision the route's gate makes). Anyone else sees nothing here, not a button that 403s.
         This comment lives INSIDE the root on purpose: a sibling comment would make the component a
         fragment in dev builds, and the parent's `class` would then silently fail to fall through. -->
    <h3 class="stock-prep-relabel__h3">{{ bi('把系统表的英文表头改成中文', 'Rename the system tables\' English headers to Chinese') }}</h3>
    <p class="stock-prep-relabel__intro" data-testid="stock-prep-relabel-intro">
      {{ bi(
        '较早装好的备料主表、确认账本等系统表,表头可能还是英文(例如 Decision ID、Status)。这里先预览会改哪些列,确认后再改。只改仍是英文原名的列:已经被人改过名的列保持不动;列的内容、权限和自动化规则都不受影响。',
        'System tables installed earlier (the main table, the confirmation ledger…) may still have English headers such as Decision ID or Status. Preview which columns would change first, then confirm. Only columns still carrying their original English name are renamed: a column someone already renamed is left alone, and column data, permissions and automation rules are unaffected.',
      ) }}
    </p>

    <div class="stock-prep-relabel__actions">
      <button
        type="button"
        data-testid="stock-prep-relabel-preview"
        :disabled="busy"
        @click="preview"
      >
        {{ plan ? bi('重新预览', 'Preview again') : bi('预览要改的表头', 'Preview the headers to rename') }}
      </button>
    </div>

    <p v-if="failure" class="stock-prep-relabel__error" data-testid="stock-prep-relabel-error" role="alert">
      {{ bi(failure.zh, failure.en) }}
      <code v-if="failureCode" class="stock-prep-relabel__token">{{ failureCode }}</code>
    </p>

    <template v-if="plan">
      <p class="stock-prep-relabel__summary" data-testid="stock-prep-relabel-summary" :data-mode="plan.mode">
        <template v-if="plan.mode === 'apply'">
          {{ bi(
            `已改好 ${plan.totals.renamed} 处;跳过 ${skippedCount} 处(见下方原因)。每一处改动都记在该表的「配置历史」里,可以在那里撤回。`,
            `Renamed ${plan.totals.renamed}; skipped ${skippedCount} (reasons below). Every change is recorded in that table's config history, where it can be reverted.`,
          ) }}
        </template>
        <template v-else-if="plan.hasPendingRenames">
          {{ bi(
            `预览:将改 ${plan.totals.would_rename} 处,跳过 ${skippedCount} 处。还没有改动任何东西。`,
            `Preview: ${plan.totals.would_rename} to rename, ${skippedCount} skipped. Nothing has been changed yet.`,
          ) }}
        </template>
        <template v-else>
          {{ bi('没有需要改的表头:系统表已经是中文,或者已经被人改过名。', 'Nothing to rename: the system tables are already in Chinese, or were renamed by someone.') }}
        </template>
      </p>

      <div
        v-for="table in plan.tables"
        :key="table.objectId || table.objectIdHash || table.kind"
        class="stock-prep-relabel__table"
        data-testid="stock-prep-relabel-table"
        :data-kind="table.kind"
        :data-status="table.status"
      >
        <h4 class="stock-prep-relabel__h4">{{ bi(tableName(table).zh, tableName(table).en) }}</h4>
        <p v-if="tableStatus(table)" class="stock-prep-relabel__hint" data-testid="stock-prep-relabel-table-status">
          {{ bi(tableStatus(table)!.zh, tableStatus(table)!.en) }}
        </p>
        <ul v-else class="stock-prep-relabel__list">
          <li
            v-for="row in visibleRows(table)"
            :key="row.key"
            data-testid="stock-prep-relabel-row"
            :data-status="row.status"
          >
            <span class="stock-prep-relabel__from">{{ row.from }}</span>
            <span aria-hidden="true"> → </span>
            <span class="stock-prep-relabel__to">{{ row.to }}</span>
            <span class="stock-prep-relabel__status">({{ bi(statusText(row.status).zh, statusText(row.status).en) }})</span>
          </li>
          <li v-if="alreadyCount(table) > 0" class="stock-prep-relabel__hint" data-testid="stock-prep-relabel-already">
            {{ bi(`另有 ${alreadyCount(table)} 处已经是中文。`, `${alreadyCount(table)} more already in Chinese.`) }}
          </li>
        </ul>
      </div>

      <div v-if="plan.mode === 'dry_run' && plan.hasPendingRenames" class="stock-prep-relabel__confirm" data-testid="stock-prep-relabel-confirm-bar">
        <p class="stock-prep-relabel__hint">
          {{ bi(
            '确认后会立即改名。只改上面标着「将改成中文」的列;改动会逐条记入表的配置历史。',
            'Confirming renames immediately. Only the columns marked "Will be renamed" above change; every change is recorded in the table\'s config history.',
          ) }}
        </p>
        <button type="button" data-testid="stock-prep-relabel-apply" :disabled="busy" @click="apply">
          {{ bi('确认改成中文', 'Confirm — rename to Chinese') }}
        </button>
        <button type="button" data-testid="stock-prep-relabel-cancel" :disabled="busy" @click="cancel">
          {{ bi('取消', 'Cancel') }}
        </button>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
// 「把系统表的英文表头改成中文」(客户反馈 2026-09-24 #4a) — preview → confirm → apply.
//
// The panel never composes a name, a table or a tenant: everything it shows is the SERVER's
// values-free plan (template labels + status codes), and the only thing it can send is the one bit
// that decides between preview and apply (services/integration/stockPreparation/managedTableRelabel.ts).
import { computed, ref } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import { useAuth } from '../../../composables/useAuth'
import { canOpenStockPrepInstallView } from '../../../services/integration/stockPreparation/workbenchAccess'
import {
  ManagedTableRelabelError,
  MANAGED_TABLE_RELABEL_TABLE_NAMES,
  applyManagedTableRelabel,
  planManagedTableRelabel,
  relabelEntityStatusText,
  relabelFailureText,
  relabelTableStatusText,
  type ManagedTableRelabelPlan,
  type ManagedTableRelabelTable,
  type RelabelPlainText,
} from '../../../services/integration/stockPreparation/managedTableRelabel'

const { locale } = useLocale()
const auth = useAuth()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

// The route's own gate is `requireAccess(req, STOCK_PREP_ADMIN)`; this is the browser mirror of
// exactly that decision (platform admin passes inside it).
const canRelabel = computed(() => canOpenStockPrepInstallView(auth.getAccessSnapshot()))

const busy = ref(false)
const plan = ref<ManagedTableRelabelPlan | null>(null)
const failure = ref<RelabelPlainText | null>(null)
const failureCode = ref<string | null>(null)

const skippedCount = computed(() => {
  const totals = plan.value?.totals
  if (!totals) return 0
  return (totals.skipped_name_changed ?? 0) + (totals.skipped_name_taken ?? 0) + (totals.missing ?? 0)
})

function tableName(table: ManagedTableRelabelTable): RelabelPlainText {
  return MANAGED_TABLE_RELABEL_TABLE_NAMES[table.kind] ?? { zh: table.kind, en: table.kind }
}

function tableStatus(table: ManagedTableRelabelTable): RelabelPlainText | null {
  return relabelTableStatusText(table.status)
}

function statusText(status: string): RelabelPlainText {
  return relabelEntityStatusText(status)
}

type Row = { key: string; from: string; to: string; status: string }

// Everything that is NOT already in Chinese — i.e. every row the admin has a reason to read.
function visibleRows(table: ManagedTableRelabelTable): Row[] {
  const rows: Row[] = []
  if (table.sheetName && table.sheetName.status !== 'already_target') {
    rows.push({ key: '__sheet__', from: table.sheetName.from, to: table.sheetName.to, status: table.sheetName.status })
  }
  for (const field of table.fields) {
    if (field.status === 'already_target') continue
    rows.push({ key: field.fieldId, from: field.from, to: field.to, status: field.status })
  }
  return rows
}

function alreadyCount(table: ManagedTableRelabelTable): number {
  const sheet = table.sheetName && table.sheetName.status === 'already_target' ? 1 : 0
  return sheet + table.fields.filter((field) => field.status === 'already_target').length
}

function fail(error: unknown): void {
  failure.value = relabelFailureText(error)
  failureCode.value = error instanceof ManagedTableRelabelError ? error.code : null
}

async function preview(): Promise<void> {
  busy.value = true
  failure.value = null
  failureCode.value = null
  try {
    plan.value = await planManagedTableRelabel()
  } catch (error) {
    plan.value = null
    fail(error)
  } finally {
    busy.value = false
  }
}

// Reachable only from 「确认改成中文」, which renders solely under a dry-run plan with pending renames
// and is disabled while a call is in flight — so an apply is always one the admin just previewed.
// Even so, the server re-evaluates compare-and-set against live state, never the previewed plan.
async function apply(): Promise<void> {
  busy.value = true
  failure.value = null
  failureCode.value = null
  try {
    plan.value = await applyManagedTableRelabel()
  } catch (error) {
    fail(error)
  } finally {
    busy.value = false
  }
}

function cancel(): void {
  plan.value = null
}
</script>

<style scoped>
.stock-prep-relabel {
  display: grid;
  gap: 8px;
}

.stock-prep-relabel__h3,
.stock-prep-relabel__h4 {
  margin: 0;
}

.stock-prep-relabel__intro,
.stock-prep-relabel__hint {
  margin: 0;
  color: #475569;
  font-size: 13px;
}

.stock-prep-relabel__actions,
.stock-prep-relabel__confirm {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.stock-prep-relabel__error {
  margin: 0;
  color: #b91c1c;
}

.stock-prep-relabel__token {
  margin-left: 6px;
  font-size: 12px;
}

.stock-prep-relabel__list {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
}

.stock-prep-relabel__from {
  color: #64748b;
}

.stock-prep-relabel__to {
  font-weight: 600;
}

.stock-prep-relabel__status {
  margin-left: 4px;
  color: #475569;
}
</style>
