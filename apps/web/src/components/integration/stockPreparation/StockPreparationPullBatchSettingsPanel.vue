<template>
  <section
    v-if="ready"
    class="stock-prep-pull-batch-settings"
    data-testid="stock-prep-pull-batch-settings-status"
    :data-source="ready.tenant.source"
  >
    <!-- 批次标识 BI-7 (R-65; ruling C6): rendered ONLY after the server's settings read answered 200 — while the
         pull-batch or the project-sheets switch is off the read is 404 and nothing renders (no card, no line), and a
         caller below stock-prep:admin sends no request at all. This comment lives INSIDE the root on purpose: a sibling
         comment would make the component a fragment in dev builds and the parent's class would not fall through. -->
    <h3 class="stock-prep-pull-batch-settings__h3">{{ say('title') }}</h3>
    <p class="stock-prep-pull-batch-settings__intro" data-testid="stock-prep-pull-batch-settings-intro">{{ say('intro') }}</p>
    <p class="stock-prep-pull-batch-settings__badge" data-testid="stock-prep-pull-batch-settings-source">
      {{ ready.tenant.source === 'built_in' ? say('source_built_in') : pick(stockPrepPullBatchTenantSourceText(ready.tenant.version)) }}
    </p>

    <!-- The four settings: the tenant DEFAULT (what a sheet captures when it is created or installed). -->
    <fieldset
      v-for="key in SETTING_KEYS"
      :key="key"
      class="stock-prep-pull-batch-settings__setting"
      data-testid="stock-prep-pull-batch-settings-setting"
      :data-key="key"
    >
      <legend>{{ pick(STOCK_PREP_PULL_BATCH_SETTING_KEY_PLAIN[key]) }}</legend>
      <label
        v-for="value in SETTING_VALUES[key]"
        :key="value"
        class="stock-prep-pull-batch-settings__option"
        data-testid="stock-prep-pull-batch-settings-option"
        :data-key="key"
        :data-value="value"
      >
        <input
          type="radio"
          :name="`stock-prep-pull-batch-${key}`"
          :value="value"
          :checked="draft[key] === value"
          :disabled="busy || !canSetTenant"
          @change="draft = { ...draft, [key]: value }"
        >
        <span>{{ pick(stockPrepPullBatchSettingValuePlain(key, value)) }}</span>
        <span v-if="ready.builtIn[key] === value" class="stock-prep-pull-batch-settings__default" data-testid="stock-prep-pull-batch-settings-default-mark">{{ say('default_mark') }}</span>
        <span
          v-if="key === 'firstPullBatchRule'"
          class="stock-prep-pull-batch-settings__help"
          data-testid="stock-prep-pull-batch-settings-rule-help"
          :data-value="value"
        >{{ ruleHelp(value) }}</span>
      </label>
      <p class="stock-prep-pull-batch-settings__help" data-testid="stock-prep-pull-batch-settings-help" :data-key="key">{{ say(key === 'firstPullBatchRule' ? 'rule_disclaimer' : `help_${key}`) }}</p>
    </fieldset>

    <div v-if="canSetTenant" class="stock-prep-pull-batch-settings__actions">
      <button
        type="button"
        data-testid="stock-prep-pull-batch-settings-set"
        :disabled="busy || Object.keys(tenantPatch).length === 0"
        @click="saveTenant"
      >
        {{ say('save') }}
      </button>
      <span class="stock-prep-pull-batch-settings__hint">{{ say('save_scope') }}</span>
    </div>
    <p v-if="tenantNotice" class="stock-prep-pull-batch-settings__notice" data-testid="stock-prep-pull-batch-settings-result" :data-result="tenantNotice.kind" role="status">
      {{ pick(tenantNoticeText) }}
      <code v-if="tenantNotice.kind === 'refused'" class="stock-prep-pull-batch-settings__token">{{ stockPrepErrorCopyText(tenantNotice.code, zh) }}</code>
    </p>

    <!-- 不可配置 (ruling C2): the v1 facts, shown so nobody looks for a switch that does not exist. -->
    <div class="stock-prep-pull-batch-settings__fixed" data-testid="stock-prep-pull-batch-settings-fixed">
      <h4 class="stock-prep-pull-batch-settings__h4">{{ say('fixed_title') }}</h4>
      <ul>
        <li v-for="fact in FIXED_FACT_KEYS" :key="fact" data-testid="stock-prep-pull-batch-settings-fixed-fact" :data-fact="fact">
          <span class="stock-prep-pull-batch-settings__badge-fixed">{{ say('fixed_title') }}</span>
          {{ say(`fixed_${fact}`) }}
        </li>
      </ul>
    </div>

    <!-- The values each registered project sheet CAPTURED (a tenant change never moves them). -->
    <div class="stock-prep-pull-batch-settings__sheets" data-testid="stock-prep-pull-batch-settings-sheets">
      <h4 class="stock-prep-pull-batch-settings__h4">{{ say('sheets_title') }}</h4>
      <p v-if="sheetNotice" class="stock-prep-pull-batch-settings__notice" data-testid="stock-prep-pull-batch-settings-sheet-result" :data-result="sheetNotice.kind" role="status">
        {{ pick(sheetNoticeText) }}
        <code v-if="sheetNotice.kind === 'refused'" class="stock-prep-pull-batch-settings__token">{{ stockPrepErrorCopyText(sheetNotice.code, zh) }}</code>
      </p>
      <p v-if="ready.sheets.length === 0" class="stock-prep-pull-batch-settings__hint" data-testid="stock-prep-pull-batch-settings-sheets-empty">{{ say('sheets_empty') }}</p>
      <table v-else class="stock-prep-pull-batch-settings__table">
        <thead>
          <tr>
            <th>{{ say('col_projectNo') }}</th>
            <th>{{ say('col_rule') }}</th>
            <th>{{ say('col_format') }}</th>
            <th>{{ say('col_locale') }}</th>
            <th>{{ say('col_placement') }}</th>
            <th>{{ say('col_landing') }}</th>
            <th>{{ say('col_state') }}</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="row in ready.sheets" :key="`${row.projectNo}`">
            <tr
              data-testid="stock-prep-pull-batch-settings-sheet-row"
              :data-project="row.projectNo"
              :data-captured="row.captured ? 'yes' : 'no'"
              :data-registry="row.registryStatus"
            >
              <td data-testid="stock-prep-pull-batch-settings-sheet-project">{{ row.projectNo }}</td>
              <td>{{ row.captured ? pick(stockPrepPullBatchSettingValuePlain('firstPullBatchRule', row.captured.firstPullBatchRule)) : '—' }}</td>
              <td>{{ row.captured ? pick(stockPrepPullBatchSettingValuePlain('labelFormat', row.captured.labelFormat)) : '—' }}</td>
              <td>{{ row.labelLocale === 'en' ? say('locale_en') : row.labelLocale === 'zh-CN' ? say('locale_zh') : '—' }}</td>
              <td data-testid="stock-prep-pull-batch-settings-sheet-placement">{{ appliedText(row, 'placement') }}</td>
              <td data-testid="stock-prep-pull-batch-settings-sheet-landing">{{ appliedText(row, 'landing') }}</td>
              <td>
                <span class="stock-prep-pull-batch-settings__lock" data-testid="stock-prep-pull-batch-settings-sheet-lock" :data-lock="lockState(row)">{{ lockText(row) }}</span>
                <span v-if="row.captured === null" class="stock-prep-pull-batch-settings__hint" data-testid="stock-prep-pull-batch-settings-sheet-hint">{{ say('not_captured_hint') }}</span>
                <span v-if="lockedAtText(row)" class="stock-prep-pull-batch-settings__hint" data-testid="stock-prep-pull-batch-settings-sheet-locked-at">{{ lockedAtText(row) }}</span>
                <button
                  v-if="row.may.set && canSetSheet"
                  type="button"
                  data-testid="stock-prep-project-pull-batch-settings-set"
                  :disabled="busy"
                  @click="openSheetForm(row)"
                >
                  {{ say('sheet_edit') }}
                </button>
              </td>
            </tr>
            <tr v-if="sheetForm && sheetForm.projectNo === row.projectNo" data-testid="stock-prep-pull-batch-settings-sheet-form">
              <td colspan="7">
                <fieldset v-for="key in SHEET_KEYS" :key="key" class="stock-prep-pull-batch-settings__setting" :data-key="key">
                  <legend>{{ pick(STOCK_PREP_PULL_BATCH_SETTING_KEY_PLAIN[key]) }}</legend>
                  <label v-for="value in SETTING_VALUES[key]" :key="value" data-testid="stock-prep-pull-batch-settings-sheet-option" :data-key="key" :data-value="value">
                    <input
                      type="radio"
                      :name="`stock-prep-pull-batch-sheet-${key}`"
                      :value="value"
                      :checked="sheetForm.draft[key] === value"
                      :disabled="busy"
                      @change="sheetForm = { ...sheetForm, draft: { ...sheetForm.draft, [key]: value } }"
                    >
                    <span>{{ pick(stockPrepPullBatchSettingValuePlain(key, value)) }}</span>
                  </label>
                </fieldset>
                <label class="stock-prep-pull-batch-settings__confirm">
                  <span>{{ pick(stockPrepPullBatchConfirmPrompt(row.projectNo)) }}</span>
                  <input v-model="sheetTyped" type="text" autocomplete="off" data-testid="stock-prep-pull-batch-settings-sheet-input" :disabled="busy">
                </label>
                <button
                  type="button"
                  data-testid="stock-prep-pull-batch-settings-sheet-save"
                  :disabled="busy || Object.keys(sheetPatch).length === 0 || !sheetTypedMatches"
                  @click="saveSheet"
                >
                  {{ say('sheet_save') }}
                </button>
                <button type="button" data-testid="stock-prep-pull-batch-settings-sheet-cancel" :disabled="busy" @click="closeSheetForm">{{ say('cancel') }}</button>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
    <p class="stock-prep-pull-batch-settings__footer" data-testid="stock-prep-pull-batch-settings-footer">{{ say('footer') }}</p>
  </section>
  <section v-else-if="refusedRead" class="stock-prep-pull-batch-settings" data-testid="stock-prep-pull-batch-settings-refused">
    <!-- The read was refused for a reason other than "off" (any 404 renders nothing above): one plain line. -->
    <p class="stock-prep-pull-batch-settings__error" role="alert">
      {{ say('read_refused') }}
      <code class="stock-prep-pull-batch-settings__token">{{ stockPrepErrorCopyText(refusedRead.code, zh) }}</code>
    </p>
  </section>
</template>

<script setup lang="ts">
// 批次标识 BI-7 — 数据来源与体检's pull-batch settings (design §5.5 / §7.1 / §10.3 / §11; rulings C2 / C6 / C10;
// register R-65). The tenant DEFAULT of the four settings (built-in = the 10-27 design), the facts that are not
// configurable, and the values each registered project sheet CAPTURED, with an edit of one captured, still-unlocked
// sheet's rule / format behind a typed confirmation.
//
// INVISIBLE WHILE OFF (C6): nothing renders until the read answered 200, any 404 renders nothing, and a caller below
// stock-prep:admin sends no request. NO NEW WRITE AUTHORITY: every call is the plugin's own route with its own gate
// (pullBatchSettings.ts); the client mirrors (`canSet*`) only hide controls the server would refuse.
//
// A FORM BELONGS TO THE SCOPE AND SESSION IT WAS OPENED UNDER (the MR-STRADDLE precedent, R80 verifier F1): a scope
// move or a session switch closes an open per-sheet form and re-reads; a save click re-checks scope and session BY
// VALUE before it writes (another tab replacing the session notifies nobody); an answer that lands after a switch is
// not painted. VALUES-FREE: closed tokens, versions and times; the project numbers are the tenant's own (admin).
import { computed, onUnmounted, ref, watch } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import { useAuth } from '../../../composables/useAuth'
import { onAuthSessionSwitch } from '../../../composables/authPrincipal'
import { readStockPrepProjectSyncRunSession } from '../../../services/integration/stockPreparation/projectSyncRunGuard'
import type { IntegrationScope } from '../../../services/integration/workbench'
import {
  canOpenStockPrepInstallView,
  grantedStockPrepCapabilities,
} from '../../../services/integration/stockPreparation/workbenchAccess'
import { stockPrepProjectNumbersMatch } from '../../../services/integration/stockPreparation/projectTarget'
import {
  STOCK_PREP_PULL_BATCH_CONFIG_LOCKED_CODE,
  STOCK_PREP_PULL_BATCH_FIXED_FACT_KEYS,
  STOCK_PREP_PULL_BATCH_NOT_CAPTURED_CODE,
  STOCK_PREP_PULL_BATCH_SETTING_KEYS,
  STOCK_PREP_PULL_BATCH_SETTING_VALUES,
  STOCK_PREP_PULL_BATCH_SHEET_SETTING_KEYS,
  STOCK_PREP_PULL_BATCH_VERSION_CONFLICT_CODE,
  changedPullBatchSettingsPatch,
  createStockPreparationPullBatchSettingsApi,
  loadStockPreparationPullBatchSettings,
  setStockPreparationProjectPullBatchSettings,
  setStockPreparationPullBatchTenantSettings,
  type StockPrepPullBatchSettingsLoad,
  type StockPrepPullBatchSettingsState,
  type StockPrepPullBatchSheetRow,
  type StockPrepPullBatchSheetSettingKey,
  type StockPreparationPullBatchSettingsApi,
} from '../../../services/integration/stockPreparation/pullBatchSettings'
import {
  STOCK_PREP_PULL_BATCH_SETTING_KEY_PLAIN,
  stockPrepErrorCopyText,
  stockPrepErrorPlain,
  stockPrepPullBatchConfirmPrompt,
  stockPrepPullBatchLockedAtText,
  stockPrepPullBatchLockedKeysText,
  stockPrepPullBatchSavedText,
  stockPrepPullBatchSettingValuePlain,
  stockPrepPullBatchSettingsPlain,
  stockPrepPullBatchTenantSourceText,
  type StockPrepPlainText,
} from '../../../services/integration/stockPreparation/plainLanguage'

const props = withDefaults(
  defineProps<{
    scope?: IntegrationScope
    /** Test seam ONLY: an injected client. Production builds its own from `scope`. */
    api?: StockPreparationPullBatchSettingsApi | null
  }>(),
  { scope: () => ({}), api: null },
)

const SETTING_KEYS = STOCK_PREP_PULL_BATCH_SETTING_KEYS
const SHEET_KEYS = STOCK_PREP_PULL_BATCH_SHEET_SETTING_KEYS
const SETTING_VALUES = STOCK_PREP_PULL_BATCH_SETTING_VALUES
const FIXED_FACT_KEYS = STOCK_PREP_PULL_BATCH_FIXED_FACT_KEYS

const { locale } = useLocale()
const auth = useAuth()
const zh = computed(() => locale.value === 'zh-CN')

function pick(text: StockPrepPlainText | null | undefined): string {
  if (!text) return ''
  return zh.value ? text.zh : text.en
}
function say(id: string): string {
  return pick(stockPrepPullBatchSettingsPlain(id))
}

// The route's own gate is `requireAccess(req, STOCK_PREP_ADMIN)`; this is the browser mirror (the relabel panel's).
const canSettings = computed<boolean>(() => canOpenStockPrepInstallView(auth.getAccessSnapshot()))
function holds(capability: 'pullBatch.settingsSet' | 'projectTarget.pullBatchSettingsSet'): boolean {
  return grantedStockPrepCapabilities(auth.getAccessSnapshot()).includes(capability)
}
const canSetTenant = computed<boolean>(() => holds('pullBatch.settingsSet'))
const canSetSheet = computed<boolean>(() => holds('projectTarget.pullBatchSettingsSet'))

function resolveApi(): StockPreparationPullBatchSettingsApi {
  return props.api ?? createStockPreparationPullBatchSettingsApi(props.scope)
}

interface WriteContext {
  readonly tenantId: string | null
  readonly workspaceId: string | null
  readonly session: string
}
function currentContext(): WriteContext {
  return { tenantId: props.scope.tenantId ?? null, workspaceId: props.scope.workspaceId ?? null, session: readStockPrepProjectSyncRunSession() }
}
function contextIsCurrent(context: WriteContext): boolean {
  const now = currentContext()
  return context.session !== 'invalid'
    && context.tenantId === now.tenantId
    && context.workspaceId === now.workspaceId
    && context.session === now.session
}

const load = ref<StockPrepPullBatchSettingsLoad | null>(null)
const ready = computed<StockPrepPullBatchSettingsState | null>(() => (load.value && load.value.kind === 'ready' ? load.value.state : null))
const refusedRead = computed<{ status: number; code: string | null } | null>(() => (
  load.value && load.value.kind === 'refused' ? { status: load.value.status, code: load.value.code } : null
))

const busy = ref(false)
const draft = ref<Record<string, string>>({})
type TenantNotice = { kind: 'saved'; version: number } | { kind: 'unchanged' | 'conflict' | 'not_permitted' } | { kind: 'refused'; code: string | null }
const tenantNotice = ref<TenantNotice | null>(null)
interface SheetForm {
  readonly projectNo: string
  readonly version: number
  readonly captured: Record<string, string>
  readonly context: WriteContext
  draft: Record<string, string>
}
const sheetForm = ref<SheetForm | null>(null)
const sheetTyped = ref('')
type SheetNotice =
  | { kind: 'saved' | 'unchanged' | 'mismatch' | 'not_captured' | 'conflict' | 'not_permitted' | 'archived' }
  | { kind: 'locked'; keys: StockPrepPullBatchSheetSettingKey[] }
  | { kind: 'refused'; code: string | null }
const sheetNotice = ref<SheetNotice | null>(null)

// A read answers for the scope it was asked under, or not at all (a later read supersedes it).
let readTicket = 0
async function refresh(): Promise<void> {
  readTicket += 1
  const ticket = readTicket
  if (!canSettings.value) {
    load.value = null
    return
  }
  const answer = await loadStockPreparationPullBatchSettings(resolveApi())
  if (ticket !== readTicket) return
  load.value = answer
  if (answer.kind === 'ready') draft.value = { ...answer.state.tenant.settings }
}

function closeSheetForm(): void {
  sheetForm.value = null
  sheetTyped.value = ''
}

watch(
  [() => props.scope.tenantId, () => props.scope.workspaceId, canSettings],
  () => {
    closeSheetForm()
    tenantNotice.value = null
    sheetNotice.value = null
    void refresh()
  },
  { immediate: true },
)

// Another principal took the session: an open form is answered as cancel, and the panel is read again for the session
// now held (a read still in flight for the old one is dropped by the ticket).
const stopSessionSwitch = onAuthSessionSwitch(() => {
  closeSheetForm()
  tenantNotice.value = null
  sheetNotice.value = null
  void refresh()
})
onUnmounted(() => stopSessionSwitch())

// ── the tenant default ──────────────────────────────────────────────────────────────────────────────────────────

const tenantPatch = computed(() => (ready.value ? changedPullBatchSettingsPatch(ready.value.tenant.settings, draft.value) : {}))

function ruleHelp(value: string): string {
  const entry = ready.value?.help.firstPullBatchRule[value]
  if (!entry) return ''
  return zh.value ? entry['zh-CN'] : entry.en
}

async function saveTenant(): Promise<void> {
  const state = ready.value
  if (!state || busy.value) return
  const patch = tenantPatch.value
  if (Object.keys(patch).length === 0) return
  const context = currentContext()
  busy.value = true
  try {
    const outcome = await setStockPreparationPullBatchTenantSettings({ api: resolveApi(), canSet: canSetTenant.value }, state.tenant.version, patch)
    if (!contextIsCurrent(context)) return
    if (outcome.kind === 'done') {
      tenantNotice.value = outcome.result.written ? { kind: 'saved', version: outcome.result.tenant.version } : { kind: 'unchanged' }
    } else if (outcome.kind === 'refused') {
      tenantNotice.value = outcome.code === STOCK_PREP_PULL_BATCH_VERSION_CONFLICT_CODE ? { kind: 'conflict' } : { kind: 'refused', code: outcome.code }
    } else {
      tenantNotice.value = { kind: 'not_permitted' }
    }
    await refresh()
  } finally {
    busy.value = false
  }
}

const tenantNoticeText = computed<StockPrepPlainText>(() => {
  const notice = tenantNotice.value
  if (!notice) return { zh: '', en: '' }
  if (notice.kind === 'saved') return stockPrepPullBatchSavedText(notice.version)
  if (notice.kind === 'conflict') return stockPrepPullBatchSettingsPlain('version_conflict')
  if (notice.kind === 'unchanged') return stockPrepPullBatchSettingsPlain('unchanged')
  if (notice.kind === 'refused') return stockPrepErrorPlain(notice.code ?? 'UNKNOWN')
  return stockPrepPullBatchSettingsPlain('not_permitted')
})

// ── the per-sheet table and edit ──────────────────────────────────────────────────────────────────────────────

function appliedText(row: StockPrepPullBatchSheetRow, key: 'landing' | 'placement'): string {
  if (!row.captured) return '—'
  const value = row.captured[key]
  if (value === null) return say('not_applied')
  return `${pick(stockPrepPullBatchSettingValuePlain(key, value))} · ${say('applied')}`
}

function lockState(row: StockPrepPullBatchSheetRow): 'archived' | 'not_captured' | 'locked' | 'unlocked' {
  if (row.registryStatus === 'archived') return 'archived'
  if (!row.captured || !row.locks) return 'not_captured'
  return row.locks.firstPullBatchRule ? 'locked' : 'unlocked'
}

function lockText(row: StockPrepPullBatchSheetRow): string {
  const state = lockState(row)
  if (state === 'archived') return say('archived')
  if (state === 'not_captured') return say('not_captured')
  return say(state)
}

function lockedAtText(row: StockPrepPullBatchSheetRow): string {
  if (!row.locks || !row.locks.firstPullBatchRule) return ''
  return pick(stockPrepPullBatchLockedAtText(row.lockedAt))
}

function openSheetForm(row: StockPrepPullBatchSheetRow): void {
  if (!row.may.set || !row.captured || row.version === null || !canSetSheet.value) return
  const captured = { firstPullBatchRule: row.captured.firstPullBatchRule, labelFormat: row.captured.labelFormat }
  sheetForm.value = { projectNo: row.projectNo, version: row.version, captured, context: currentContext(), draft: { ...captured } }
  sheetTyped.value = ''
  sheetNotice.value = null
}

const sheetPatch = computed(() => (sheetForm.value ? changedPullBatchSettingsPatch(sheetForm.value.captured, sheetForm.value.draft, SHEET_KEYS) : {}))
const sheetTypedMatches = computed<boolean>(() => Boolean(sheetForm.value) && stockPrepProjectNumbersMatch(sheetForm.value!.projectNo, sheetTyped.value))

async function saveSheet(): Promise<void> {
  const form = sheetForm.value
  if (!form || busy.value) return
  // The click counts only for the scope and session the form was opened under; otherwise it is a cancel.
  if (!contextIsCurrent(form.context)) {
    closeSheetForm()
    return
  }
  busy.value = true
  try {
    const outcome = await setStockPreparationProjectPullBatchSettings(
      { api: resolveApi(), canSet: canSetSheet.value },
      form.projectNo,
      sheetTyped.value,
      form.version,
      sheetPatch.value,
    )
    // An answer for a scope or session the panel has left is not painted here.
    if (!contextIsCurrent(form.context)) return
    if (outcome.kind === 'mismatch') {
      sheetNotice.value = { kind: 'mismatch' }
      return
    }
    closeSheetForm()
    if (outcome.kind === 'done') {
      sheetNotice.value = { kind: outcome.result.written ? 'saved' : 'unchanged' }
    } else if (outcome.kind === 'not_permitted') {
      sheetNotice.value = { kind: 'not_permitted' }
    } else if (outcome.code === STOCK_PREP_PULL_BATCH_CONFIG_LOCKED_CODE) {
      sheetNotice.value = { kind: 'locked', keys: outcome.locked }
    } else if (outcome.code === STOCK_PREP_PULL_BATCH_NOT_CAPTURED_CODE) {
      sheetNotice.value = { kind: 'not_captured' }
    } else if (outcome.code === STOCK_PREP_PULL_BATCH_VERSION_CONFLICT_CODE) {
      sheetNotice.value = { kind: 'conflict' }
    } else if (outcome.code === 'STOCK_PREPARATION_PROJECT_ARCHIVED') {
      sheetNotice.value = { kind: 'archived' }
    } else {
      sheetNotice.value = { kind: 'refused', code: outcome.code }
    }
    // What the server holds now may differ from what this page showed: read it again.
    await refresh()
  } finally {
    busy.value = false
  }
}

const sheetNoticeText = computed<StockPrepPlainText>(() => {
  const notice = sheetNotice.value
  if (!notice) return { zh: '', en: '' }
  switch (notice.kind) {
    case 'saved': return stockPrepPullBatchSettingsPlain('sheet_saved')
    case 'unchanged': return stockPrepPullBatchSettingsPlain('unchanged')
    case 'mismatch': return stockPrepPullBatchSettingsPlain('sheet_mismatch')
    case 'not_captured': return stockPrepPullBatchSettingsPlain('sheet_not_captured')
    case 'conflict': return stockPrepPullBatchSettingsPlain('version_conflict')
    case 'not_permitted': return stockPrepPullBatchSettingsPlain('not_permitted')
    case 'locked': return stockPrepPullBatchLockedKeysText(notice.keys.length > 0 ? notice.keys : ['firstPullBatchRule', 'labelFormat'])
    case 'archived': return stockPrepErrorPlain('STOCK_PREPARATION_PROJECT_ARCHIVED')
    default: return stockPrepErrorPlain(notice.code ?? 'UNKNOWN')
  }
})
</script>

<style scoped>
.stock-prep-pull-batch-settings__h3 { margin: 0 0 8px; font-size: 16px; }
.stock-prep-pull-batch-settings__h4 { margin: 12px 0 6px; font-size: 14px; }
.stock-prep-pull-batch-settings__intro,
.stock-prep-pull-batch-settings__hint,
.stock-prep-pull-batch-settings__help { color: #4b5563; font-size: 13px; }
.stock-prep-pull-batch-settings__help { display: block; margin: 2px 0 0 22px; }
.stock-prep-pull-batch-settings__badge { display: inline-block; padding: 2px 8px; border-radius: 10px; background: #eef2ff; font-size: 12px; }
.stock-prep-pull-batch-settings__setting { border: 1px solid #e5e7eb; border-radius: 6px; margin: 8px 0; padding: 6px 10px; }
.stock-prep-pull-batch-settings__option { display: block; margin: 4px 0; }
.stock-prep-pull-batch-settings__default { color: #6b7280; }
.stock-prep-pull-batch-settings__actions { display: flex; gap: 12px; align-items: center; margin: 8px 0; }
.stock-prep-pull-batch-settings__badge-fixed { display: inline-block; margin-right: 6px; padding: 0 6px; border-radius: 8px; background: #f3f4f6; font-size: 12px; }
.stock-prep-pull-batch-settings__table { width: 100%; border-collapse: collapse; font-size: 13px; }
.stock-prep-pull-batch-settings__table th,
.stock-prep-pull-batch-settings__table td { border-bottom: 1px solid #e5e7eb; padding: 4px 6px; text-align: left; vertical-align: top; }
.stock-prep-pull-batch-settings__lock { display: block; }
.stock-prep-pull-batch-settings__confirm { display: block; margin: 6px 0; }
.stock-prep-pull-batch-settings__error { color: #b91c1c; }
.stock-prep-pull-batch-settings__token { margin-left: 6px; font-size: 12px; }
</style>
