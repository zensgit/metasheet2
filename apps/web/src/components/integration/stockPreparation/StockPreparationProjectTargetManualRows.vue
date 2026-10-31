<template>
  <section
    v-if="state && state.status !== 'absent'"
    class="sp-mr"
    data-testid="stock-prep-project-manual-rows"
    :data-sheet-status="state.status"
  >
    <h4 class="sp-mr__title">{{ bi(text('title').zh, text('title').en) }}</h4>

    <!-- The projectTarget.manualRowsRead control (PULL, manifest — OQ4: the reminder is for the people who pull): the
         switch-state line. Rendered only once the server's read answered for a registered sheet, and only for a holder —
         the read is never asked otherwise. On an adopted older sandbox sheet (`manualRowsSupported` false) it says that
         the host never offers manual rows there instead of a switch state that would change nothing. -->
    <p
      class="sp-mr__status"
      data-testid="stock-prep-project-manual-rows-status"
      :data-policy="state.policy ?? 'none'"
      :data-policy-source="state.policySource ?? 'none'"
      :data-key-column="state.keyColumn ?? 'none'"
      :data-supported="state.manualRowsSupported ? 'yes' : 'no'"
    >
      <strong v-if="!state.manualRowsSupported">{{ bi(text('not_supported').zh, text('not_supported').en) }}</strong>
      <strong v-else-if="state.keyColumn === 'present'">{{ bi(statusEntry.zh, statusEntry.en) }}</strong>
      <span v-else>{{ bi(text('key_column_missing').zh, text('key_column_missing').en) }}</span>
    </p>
    <p v-if="!state.manualRowsSupported" class="sp-mr__hint" data-testid="stock-prep-project-manual-rows-not-supported">
      {{ bi(text('not_supported').zhNext ?? '', text('not_supported').enNext ?? '') }}
    </p>
    <template v-else>
      <p class="sp-mr__hint">{{ bi(text('meaning').zh, text('meaning').en) }}</p>
      <p v-if="state.keyLocked === false" class="sp-mr__hint" data-testid="stock-prep-project-manual-rows-lock-missing">
        {{ bi(text('lock_missing').zh, text('lock_missing').en) }}
        <span>{{ bi(text('lock_missing').zhNext ?? '', text('lock_missing').enNext ?? '') }}</span>
      </p>
      <p v-if="state.keyColumn === 'missing'" class="sp-mr__hint" data-testid="stock-prep-project-manual-rows-key-missing">
        {{ bi(text('key_column_missing').zhNext ?? '', text('key_column_missing').enNext ?? '') }}
      </p>
    </template>
    <p v-if="state.status === 'archived'" class="sp-mr__hint" data-testid="stock-prep-project-manual-rows-archived">
      {{ bi(text('archived').zh, text('archived').en) }}
      <span>{{ bi(text('archived').zhNext ?? '', text('archived').enNext ?? '') }}</span>
    </p>

    <!-- R-11 (OQ6): a reader who does not hold the SET — the 拉取人员 — sees no switch, and the reason in words. -->
    <p
      v-if="!canSet && state.manualRowsSupported"
      class="sp-mr__hint"
      data-testid="stock-prep-project-manual-rows-set-admin-only"
    >
      {{ bi(text('set_admin_only').zh, text('set_admin_only').en) }}
    </p>

    <!-- The projectTarget.manualRowsSet control (ADMIN, manifest): rendered only for its holder AND while the server
         says `may.set` (an ADMIN caller, an active sheet the host offers manual rows on, with a key column). The project
         number must be TYPED before anything is sent; the server compares it again. -->
    <button
      v-if="canOfferSet && !prompt"
      type="button"
      class="sp-mr__link"
      data-testid="stock-prep-project-manual-rows-set"
      :data-target-policy="nextPolicy"
      :disabled="busy"
      @click="openPrompt"
    >{{ bi(actionEntry.zh, actionEntry.en) }}</button>
    <div v-if="prompt" class="sp-mr__prompt" role="group" data-testid="stock-prep-project-manual-rows-prompt" :data-target-policy="prompt.policy">
      <p class="sp-mr__hint">{{ bi(confirmEntry.zh, confirmEntry.en) }}</p>
      <label class="sp-mr__field">
        <span>
          {{ bi(typePrompt.zh, typePrompt.en) }}
          <strong data-testid="stock-prep-project-manual-rows-project-no">{{ trimmedProjectNo }}</strong>
        </span>
        <input
          v-model="typed"
          type="text"
          class="sp-mr__input"
          data-testid="stock-prep-project-manual-rows-input"
          :disabled="busy"
          :aria-label="bi(typePrompt.zh, typePrompt.en)"
        />
      </label>
      <div class="sp-mr__actions">
        <button
          type="button"
          class="sp-mr__link"
          data-testid="stock-prep-project-manual-rows-confirm"
          :disabled="busy || !typedMatches"
          @click="confirmSet"
        >{{ bi(text('confirm_action').zh, text('confirm_action').en) }}</button>
        <button
          type="button"
          class="sp-mr__link"
          data-testid="stock-prep-project-manual-rows-cancel"
          :disabled="busy"
          @click="closePrompt"
        >{{ bi(text('confirm_cancel').zh, text('confirm_cancel').en) }}</button>
      </div>
    </div>
    <p
      v-if="notice"
      class="sp-mr__hint"
      role="status"
      data-testid="stock-prep-project-manual-rows-result"
      :data-result="notice.kind"
    >
      {{ bi(noticeText.zh, noticeText.en) }}
      <span v-if="noticeText.zhNext">{{ bi(noticeText.zhNext, noticeText.enNext ?? '') }}</span>
      <code v-if="notice.kind === 'refused' && notice.code" class="sp-mr__token">{{ notice.code }}</code>
    </p>

    <!-- The last small-lane pull's reminder (ADR §5.3, OQ4): B1's persisted record. NO record means all zeros; an
         unreadable record is said as that, never as zeros. Counts and record handles only. -->
    <div class="sp-mr__reminder" data-testid="stock-prep-project-manual-rows-reminder" :data-last-pull="lastPull ? lastPull.status : 'none'">
      <p v-if="!lastPull || lastPull.status === 'unavailable'" class="sp-mr__hint" data-testid="stock-prep-project-manual-rows-last-pull-unavailable">
        {{ bi(text('last_pull_unavailable').zh, text('last_pull_unavailable').en) }}
        <span>{{ bi(text('last_pull_unavailable').zhNext ?? '', text('last_pull_unavailable').enNext ?? '') }}</span>
      </p>
      <p v-else-if="lastPull.status === 'none'" class="sp-mr__hint" data-testid="stock-prep-project-manual-rows-last-pull-none">
        {{ bi(text('last_pull_none').zh, text('last_pull_none').en) }}
      </p>
      <template v-else>
        <p class="sp-mr__counts" data-testid="stock-prep-project-manual-rows-count" :data-count="lastPull.rowCount ?? 0">
          {{ bi(countText.zh, countText.en) }}
        </p>
        <div
          v-if="(lastPull.matchedManualCount ?? 0) > 0"
          class="sp-mr__notice"
          data-testid="stock-prep-project-manual-rows-matched"
          :data-count="lastPull.matchedManualCount"
        >
          <p class="sp-mr__counts"><strong>{{ bi(matchedText.zh, matchedText.en) }}</strong></p>
          <p class="sp-mr__hint">{{ bi(text('reminder_explain').zh, text('reminder_explain').en) }}</p>
          <details v-if="matchedLinks.length > 0" class="sp-mr__rows" data-testid="stock-prep-project-manual-rows-matched-rows">
            <summary>{{ bi(text('view_rows').zh, text('view_rows').en) }}({{ matchedLinks.length }})</summary>
            <ul>
              <li v-for="link in matchedLinks" :key="link.id">
                <a :href="link.href" target="_blank" rel="noopener noreferrer" data-testid="stock-prep-project-manual-rows-matched-link"><code>{{ link.id }}</code></a>
              </li>
            </ul>
          </details>
        </div>
        <div
          v-if="(lastPull.unboundKeyCount ?? 0) > 0"
          class="sp-mr__notice"
          data-testid="stock-prep-project-manual-rows-unbound"
          :data-count="lastPull.unboundKeyCount"
        >
          <p class="sp-mr__counts"><strong>{{ bi(unboundText.zh, unboundText.en) }}</strong></p>
          <p class="sp-mr__hint">{{ bi(text('unbound_explain').zh, text('unbound_explain').en) }}</p>
          <p class="sp-mr__hint" data-testid="stock-prep-project-manual-rows-unbound-guidance">{{ bi(text('unbound_guidance').zh, text('unbound_guidance').en) }}</p>
          <details v-if="unboundLinks.length > 0" class="sp-mr__rows" data-testid="stock-prep-project-manual-rows-unbound-rows">
            <summary>{{ bi(text('view_rows').zh, text('view_rows').en) }}({{ unboundLinks.length }})</summary>
            <ul>
              <li v-for="link in unboundLinks" :key="link.id">
                <a :href="link.href" target="_blank" rel="noopener noreferrer" data-testid="stock-prep-project-manual-rows-unbound-link"><code>{{ link.id }}</code></a>
              </li>
            </ul>
          </details>
        </div>
      </template>
    </div>
  </section>
  <p
    v-else-if="readRefused"
    class="sp-mr__hint"
    role="status"
    data-testid="stock-prep-project-manual-rows-read-failed"
  >
    {{ bi(text('read_failed').zh, text('read_failed').en) }}
    <code v-if="readRefused.code" class="sp-mr__token">{{ readRefused.code }}</code>
  </p>
  <!-- R-11: a control the caller cannot exercise is ABSENT, and the reason is said in words — once this panel has
       seen the project's own sheet (a project-sheet run), so a deployment without per-project sheets never shows it.
       This is the reader below the PULL tier: who sees the reminder here, and who changes the switch. -->
  <p
    v-else-if="!canRead && projectSheetKnown && trimmedProjectNo"
    class="sp-mr__hint"
    data-testid="stock-prep-project-manual-rows-admin-only"
  >
    {{ bi(text('admin_only').zh, text('admin_only').en) }}
  </p>
</template>

<script setup lang="ts">
// 人工补充行 B4 — the project sync panel's manual-rows section (ADR adr-stock-prep-manual-rows-20261030 §4 / §5.3 /
// §8 「B4」 3; OQ4 「提醒显示在项目同步面板」, OQ6 「开关由备料主管理员拨」; register R-68).
//
// WHAT IT SHOWS, to a holder of the PULL tier (`projectTarget.manualRowsRead`: the 拉取人员, stock-prep:admin and the
// platform admin — OQ4, the reminder is for the people who pull), for the project the panel is about:
//   * the switch 「允许人工补充行」 — allowed by default or set, off — and what turning it off means (新增 and 复制为新行
//     stop; existing manual rows stay editable and deletable); a sheet whose PLM lock is not complete is said so; an
//     adopted older sandbox sheet, where the host never offers manual rows, is said so instead of a switch state;
//   * the switch control (`projectTarget.manualRowsSet`, ADMIN — OQ6), only while the server says `may.set`, behind a
//     TYPED project-number confirmation; a reader without it reads that only 备料主管理员 can change it;
//   * the last small-lane pull's reminder (B1's persisted record): how many manual rows it read, how many of them are
//     the same material as a row PLM newly added (it NEVER merges — the reader decides), and how many unbound
//     `manual:` rows it set aside, with the ADR's handling guidance; 「查看这些行」 deep-links each record handle.
// Anyone below the PULL tier sees no control and — once the panel has seen the project's sheet — one sentence saying
// who can.
//
// NO NEW WRITE AUTHORITY, NO ROUTING: every call is the plugin's own switch route with its own gate
// (projectManualRows.ts); the links are plain hrefs to the multitable record route under the app's base.
//
// VALUES-FREE: the project number is the one the parent hands in (the operator's own text); everything else is a
// state, a count, a time or a record handle.
import { computed, ref, watch } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import { useAuth } from '../../../composables/useAuth'
import type { IntegrationScope } from '../../../services/integration/workbench'
import { grantedStockPrepCapabilities } from '../../../services/integration/stockPreparation/workbenchAccess'
import { stockPrepProjectNumbersMatch } from '../../../services/integration/stockPreparation/projectTarget'
import {
  createStockPreparationManualRowsApi,
  loadStockPreparationManualRows,
  setStockPreparationManualRows,
  stockPrepManualRowsNextPolicy,
  stockPrepManualRowsRecordHref,
  type StockPrepManualRowsLoad,
  type StockPrepManualRowsPolicy,
  type StockPrepManualRowsState,
  type StockPreparationManualRowsApi,
} from '../../../services/integration/stockPreparation/projectManualRows'
import {
  stockPrepErrorPlain,
  stockPrepManualRowsCountText,
  stockPrepManualRowsMatchedText,
  stockPrepManualRowsPlain,
  stockPrepManualRowsUnboundText,
  stockPrepProjectTargetPlain,
  type StockPrepPlainEntry,
} from '../../../services/integration/stockPreparation/plainLanguage'

const props = withDefaults(
  defineProps<{
    /** The project the parent panel is about — its seed or the number its last run submitted. */
    projectNo?: string
    scope?: IntegrationScope
    /** Any value; a CHANGE re-reads the switch and the reminder (the parent hands in its last run's report). */
    lastRun?: unknown
    /** Whether the parent has seen this project's registered sheet (only then is the non-holder sentence said). */
    projectSheetKnown?: boolean
    /**
     * Test seam (the parent's convention): true when an injected double owns the parent's pipeline, so this section
     * adds no request it did not ask for. Production mounts never set it.
     */
    inert?: boolean
    /** Test seam ONLY: an injected client. Production builds its own from `scope`. */
    api?: StockPreparationManualRowsApi | null
  }>(),
  {
    projectNo: '',
    scope: () => ({}),
    lastRun: undefined,
    projectSheetKnown: false,
    inert: false,
    api: null,
  },
)

const { locale } = useLocale()
const auth = useAuth()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

function text(id: string): StockPrepPlainEntry {
  return stockPrepManualRowsPlain(id)
}

function holds(capability: 'projectTarget.manualRowsRead' | 'projectTarget.manualRowsSet'): boolean {
  return grantedStockPrepCapabilities(auth.getAccessSnapshot()).includes(capability)
}

const canRead = computed<boolean>(() => holds('projectTarget.manualRowsRead'))
const canSet = computed<boolean>(() => holds('projectTarget.manualRowsSet'))
const trimmedProjectNo = computed<string>(() => (props.projectNo ?? '').trim())

function resolveApi(): StockPreparationManualRowsApi {
  return props.api ?? createStockPreparationManualRowsApi(props.scope)
}

// The switch control's own state — declared before the watch below, which clears it on a project change.
const busy = ref(false)
const prompt = ref<{ policy: StockPrepManualRowsPolicy } | null>(null)
const typed = ref('')
type Notice =
  | { kind: 'allowed' | 'disabled' | 'unchanged' | 'mismatch' | 'not_permitted' }
  | { kind: 'refused'; status: number; code: string | null }
const notice = ref<Notice | null>(null)

const load = ref<StockPrepManualRowsLoad | null>(null)
const state = computed<StockPrepManualRowsState | null>(() => (load.value && load.value.kind === 'ready' ? load.value.state : null))
const readRefused = computed<{ status: number; code: string | null } | null>(() => (
  load.value && load.value.kind === 'refused' && canRead.value ? { status: load.value.status, code: load.value.code } : null
))
const lastPull = computed(() => (state.value ? state.value.lastPull : null))

// A read answers for the project it was asked about, or not at all (a later project / run supersedes it).
let readTicket = 0

async function refresh(): Promise<void> {
  readTicket += 1
  const ticket = readTicket
  const projectNo = trimmedProjectNo.value
  if (!canRead.value || props.inert || !projectNo) {
    load.value = null
    return
  }
  const answer = await loadStockPreparationManualRows(resolveApi(), projectNo)
  if (ticket !== readTicket) return
  load.value = answer
}

watch(
  [trimmedProjectNo, () => props.scope.tenantId, () => props.scope.workspaceId, () => props.lastRun, canRead, () => props.inert],
  (next, previous) => {
    // Another project (or scope): whatever was being confirmed belongs to the old one.
    if (!previous || next[0] !== previous[0] || next[1] !== previous[1] || next[2] !== previous[2]) {
      prompt.value = null
      typed.value = ''
      notice.value = null
    }
    void refresh()
  },
  { immediate: true },
)

// ── the switch ──────────────────────────────────────────────────────────────────────────────────────────────────

const nextPolicy = computed<StockPrepManualRowsPolicy>(() => stockPrepManualRowsNextPolicy(state.value ? state.value.policy : null))
const canOfferSet = computed<boolean>(() => Boolean(state.value && state.value.may.set && canSet.value))
const typedMatches = computed<boolean>(() => stockPrepProjectNumbersMatch(trimmedProjectNo.value, typed.value))

const statusEntry = computed<StockPrepPlainEntry>(() => {
  const current = state.value
  if (current && current.policy === 'disabled') return text('status_disabled')
  return current && current.policySource === 'set' ? text('status_allowed') : text('status_allowed_default')
})
const actionEntry = computed<StockPrepPlainEntry>(() => text(nextPolicy.value === 'disabled' ? 'action_disable' : 'action_allow'))
const confirmEntry = computed<StockPrepPlainEntry>(() => text(prompt.value && prompt.value.policy === 'disabled' ? 'confirm_disable' : 'confirm_allow'))
const typePrompt = computed<StockPrepPlainEntry>(() => stockPrepProjectTargetPlain('confirm_type_project_no') ?? { zh: '请输入项目号确认:', en: 'Type the project number to confirm:' })

function openPrompt(): void {
  if (!canOfferSet.value) return
  prompt.value = { policy: nextPolicy.value }
  typed.value = ''
  notice.value = null
}

function closePrompt(): void {
  prompt.value = null
  typed.value = ''
}

async function confirmSet(): Promise<void> {
  const asked = prompt.value
  if (!asked || busy.value) return
  busy.value = true
  const projectNo = trimmedProjectNo.value
  try {
    const outcome = await setStockPreparationManualRows({ api: resolveApi(), canSet: canSet.value }, projectNo, typed.value, asked.policy)
    if (projectNo !== trimmedProjectNo.value) return
    if (outcome.kind === 'mismatch') {
      notice.value = { kind: 'mismatch' }
      return
    }
    closePrompt()
    if (outcome.kind === 'done') {
      // The POST answers the state READ BACK after the write: it replaces what this panel showed.
      const { written: _written, changed, ...readBack } = outcome.result
      readTicket += 1
      load.value = { kind: 'ready', state: readBack }
      let kind: 'allowed' | 'disabled' | 'unchanged' = 'unchanged'
      if (changed) kind = readBack.policy === 'disabled' ? 'disabled' : 'allowed'
      notice.value = { kind }
      return
    }
    notice.value = outcome.kind === 'not_permitted' ? { kind: 'not_permitted' } : { kind: 'refused', status: outcome.status, code: outcome.code }
    // The server refused: what it holds now may differ from what this page showed (archived meanwhile, a write it
    // could not confirm) — read it again rather than keep showing the old state.
    if (outcome.kind === 'refused') await refresh()
  } finally {
    busy.value = false
  }
}

const noticeText = computed<StockPrepPlainEntry>(() => {
  const current = notice.value
  if (!current) return { zh: '', en: '' }
  if (current.kind === 'refused') return current.code ? stockPrepErrorPlain(current.code) : stockPrepErrorPlain('UNKNOWN')
  return text(`result_${current.kind}`)
})

// ── the reminder ────────────────────────────────────────────────────────────────────────────────────────────────

const countText = computed(() => stockPrepManualRowsCountText(lastPull.value ?? { at: null, mode: null, rowCount: 0 }))
const matchedText = computed(() => stockPrepManualRowsMatchedText(lastPull.value?.matchedManualCount ?? 0))
const unboundText = computed(() => stockPrepManualRowsUnboundText(lastPull.value?.unboundKeyCount ?? 0))

function linksOf(ids: readonly string[]): Array<{ id: string; href: string }> {
  const current = state.value
  if (!current) return []
  const links: Array<{ id: string; href: string }> = []
  for (const id of ids) {
    const href = stockPrepManualRowsRecordHref(import.meta.env.BASE_URL, { sheetId: current.sheetId, viewId: current.viewId }, id)
    if (href) links.push({ id, href })
  }
  return links
}

const matchedLinks = computed(() => linksOf(lastPull.value ? lastPull.value.matchedManualRecordIds : []))
const unboundLinks = computed(() => linksOf(lastPull.value ? lastPull.value.unboundRecordIds : []))
</script>

<style scoped>
.sp-mr {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
  margin: 0;
  padding: var(--ms-space-2) var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: var(--ms-bg-page);
}

.sp-mr__title {
  margin: 0;
  color: var(--ms-text-1);
  font-size: 14px;
  font-weight: 600;
}

.sp-mr__status,
.sp-mr__counts {
  margin: 0;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.6;
}

.sp-mr__hint {
  margin: 0;
  color: var(--ms-text-3);
  font-size: 13px;
  line-height: 1.6;
}

.sp-mr__prompt,
.sp-mr__notice {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
  padding: var(--ms-space-2) var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
}

.sp-mr__reminder {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
}

.sp-mr__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-mr__input {
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: var(--ms-bg-page);
  padding: 6px 10px;
  color: var(--ms-text-1);
  font: inherit;
}

.sp-mr__input:focus-visible,
.sp-mr__link:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}

.sp-mr__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-2);
}

.sp-mr__link {
  align-self: flex-start;
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: transparent;
  padding: 4px 12px;
  color: var(--ms-color-primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.sp-mr__link:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.sp-mr__rows ul {
  margin: var(--ms-space-2) 0 0;
  padding-left: var(--ms-space-3);
}

.sp-mr__rows a {
  color: var(--ms-color-primary);
}

.sp-mr__token {
  color: var(--ms-text-3);
  font-size: 12px;
}
</style>
