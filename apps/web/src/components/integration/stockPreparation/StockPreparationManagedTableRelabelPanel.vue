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
    <p class="stock-prep-relabel__hint" data-testid="stock-prep-relabel-switch-note">
      {{ bi(
        '预览随时可以看;真正改名需要运维先在服务器上打开改名开关。',
        'You can preview at any time; actually renaming needs the operator to turn on the rename switch on the server first.',
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
            `已改好 ${plan.totals.renamed} 处;跳过 ${skippedCount} 处(见下方原因)。每一处改动都记在该表的「配置历史」里:列名改动可以在那里撤回;表名改动会记录,但不能从那里撤回,需要时请手工把表名改回去。`,
            `Renamed ${plan.totals.renamed}; skipped ${skippedCount} (reasons below). Every change is recorded in that table's config history: column renames can be reverted there; a table rename is recorded but cannot be reverted there — rename the table back by hand if needed.`,
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
            :data-entity="row.entity"
          >
            <span class="stock-prep-relabel__from">{{ row.from }}</span>
            <span aria-hidden="true"> → </span>
            <span class="stock-prep-relabel__to">{{ row.to }}</span>
            <span class="stock-prep-relabel__status">({{ bi(statusText(row).zh, statusText(row).en) }})</span>
          </li>
          <li v-if="alreadyCount(table) > 0" class="stock-prep-relabel__hint" data-testid="stock-prep-relabel-already">
            {{ bi(`另有 ${alreadyCount(table)} 处已经是中文。`, `${alreadyCount(table)} more already in Chinese.`) }}
          </li>
        </ul>
      </div>

      <!-- What this tool does NOT cover, named rather than silently skipped. -->
      <div class="stock-prep-relabel__scope" data-testid="stock-prep-relabel-out-of-scope">
        <p class="stock-prep-relabel__hint">
          {{ bi(
            '以下内部表还没有约定的中文名,本工具不改它们,表头保持英文:',
            'These internal tables have no agreed Chinese names yet, so this tool leaves their English headers as they are:',
          ) }}
        </p>
        <ul class="stock-prep-relabel__list">
          <li v-for="entry in plan.outOfScope" :key="entry.objectId" data-testid="stock-prep-relabel-out-of-scope-row">{{ entry.label }}</li>
        </ul>
        <p class="stock-prep-relabel__hint" data-testid="stock-prep-relabel-sandbox-coverage">
          {{ bi(
            '沙箱表只处理客户包声明的、或沙箱写入白名单里登记的;另行手工建的沙箱表不会被列出。',
            'Sandbox tables are covered only when a customer pack declares them or the sandbox write allowlist lists them; a sandbox created by hand otherwise is not listed.',
          ) }}
        </p>
      </div>

      <!-- THE OPERATOR SWITCH. With it off, there is nothing to confirm: say why, name the switch, and
           offer no button the server would refuse. -->
      <p
        v-if="plan.mode === 'dry_run' && plan.hasPendingRenames && !plan.applyEnabled"
        class="stock-prep-relabel__disabled"
        data-testid="stock-prep-relabel-apply-disabled"
      >
        {{ bi(
          '服务器上的改名开关还没有打开,所以现在只能预览、不能执行。需要改名时,请运维在服务器上设置下面这个开关为 true 并重启服务,然后回到这里重新预览:',
          'The rename switch is off on this server, so this can only be previewed, not applied. To rename, ask your operator to set the switch below to true and restart the service, then come back and preview again:',
        ) }}
        <code class="stock-prep-relabel__token" data-testid="stock-prep-relabel-enable-with">{{ plan.enableWith }}=true</code>
      </p>

      <div
        v-if="plan.mode === 'dry_run' && plan.hasPendingRenames && plan.applyEnabled"
        class="stock-prep-relabel__confirm"
        data-testid="stock-prep-relabel-confirm-bar"
      >
        <p class="stock-prep-relabel__hint">
          {{ bi(
            '确认后会立即改名,且只执行上面这份预览:如果表头在预览之后有变化,系统会停下来请您重新预览。改动会逐条记入表的配置历史(列名可以撤回,表名不能从那里撤回)。',
            'Confirming renames immediately and executes exactly the preview above: if the headers changed since, the system stops and asks you to preview again. Every change is recorded in the table\'s config history (column renames can be reverted there; table renames cannot).',
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
// values-free plan (template labels + status codes), and the only things it can send are the one bit
// that decides between preview and apply and the digest of the preview on screen
// (services/integration/stockPreparation/managedTableRelabel.ts).
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
  if (table.kind === 'mvp') return { zh: table.label ?? table.kind, en: table.label ?? table.kind }
  return MANAGED_TABLE_RELABEL_TABLE_NAMES[table.kind] ?? { zh: table.kind, en: table.kind }
}

function tableStatus(table: ManagedTableRelabelTable): RelabelPlainText | null {
  return relabelTableStatusText(table.status)
}

type Row = { key: string; entity: 'sheet' | 'field'; from: string; to: string; status: string }

function statusText(row: Row): RelabelPlainText {
  return relabelEntityStatusText(row.status, row.entity)
}

// Everything that is NOT already in Chinese — i.e. every row the admin has a reason to read.
function visibleRows(table: ManagedTableRelabelTable): Row[] {
  const rows: Row[] = []
  if (table.sheetName && table.sheetName.status !== 'already_target') {
    rows.push({ key: '__sheet__', entity: 'sheet', from: table.sheetName.from, to: table.sheetName.to, status: table.sheetName.status })
  }
  for (const field of table.fields) {
    if (field.status === 'already_target') continue
    rows.push({ key: field.fieldId, entity: 'field', from: field.from, to: field.to, status: field.status })
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
// while the server switch is on, and is disabled while a call is in flight. The server executes only
// the plan whose digest this sends, re-evaluated against live state.
async function apply(): Promise<void> {
  const confirmed = plan.value
  if (!confirmed) return
  busy.value = true
  failure.value = null
  failureCode.value = null
  try {
    plan.value = await applyManagedTableRelabel(confirmed.planDigest)
  } catch (error) {
    // The previewed plan is now STALE whatever happened (some tables may have been renamed before
    // the failure). Drop it, so the only way forward is a fresh preview with a fresh digest.
    plan.value = null
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

.stock-prep-relabel__disabled {
  margin: 0;
  color: #92400e;
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
