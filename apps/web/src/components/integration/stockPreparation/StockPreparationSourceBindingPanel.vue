<template>
  <section class="stock-prep-source" data-testid="stock-prep-source-binding">
    <h3 class="stock-prep-source__h3">
      {{ bi('数据从哪里来', 'Where the data comes from') }}
    </h3>
    <p class="stock-prep-source__intro" data-testid="stock-prep-source-intro">
      {{ bi(
        '备料要读贵司的 BOM,得先知道去哪个库读。这里选一个已经登记好的只读数据库连接就行 —— 只是「读哪里」,不会改动那个库里的任何东西。',
        '备料 reads your BOM, so it needs to know which database to read. Pick one of the read-only database connections already registered here — this only chooses WHERE to read; nothing in that database is ever changed.',
      ) }}
    </p>

    <!-- The affordance this whole change exists to be able to show. Rendered from the SERVER's own
         `takesEffectWithoutRestart`, not asserted by the page on its own authority: if a future
         deployment could not honour it, the line would disappear rather than lie. -->
    <p
      v-if="view?.takesEffectWithoutRestart"
      class="stock-prep-source__no-restart"
      data-testid="stock-prep-source-no-restart"
    >
      {{ bi(noRestart.zh, noRestart.en) }}
    </p>

    <p v-if="errorStatus !== null" class="stock-prep-source__error" data-testid="stock-prep-source-error">
      <span v-if="refusalText">{{ bi(refusalText.zh, refusalText.en) }}</span>
      <span v-else>{{ bi('读取或保存失败。', 'The read or save failed.') }}</span>
      <code class="stock-prep-source__token">HTTP {{ errorStatus }}</code>
    </p>

    <!-- CURRENT STATE — shown to every reader who can open this tab. -->
    <p v-if="view" class="stock-prep-source__current" data-testid="stock-prep-source-current">
      <strong>{{ bi('当前来源:', 'Current source: ') }}</strong>
      <span data-testid="stock-prep-source-current-name">{{ currentName }}</span>
      <code v-if="view.effectiveExternalSystemId" class="stock-prep-source__token" data-testid="stock-prep-source-current-id">
        {{ view.effectiveExternalSystemId }}
      </code>
    </p>
    <p v-if="view" class="stock-prep-source__origin" data-testid="stock-prep-source-origin">
      {{ bi(originText.zh, originText.en) }}
    </p>

    <!-- The source the action reads TODAY cannot actually be read. Named here rather than left for
         the admin to discover on the next failed refresh — an env default pointing at a deleted or
         deactivated system, or a cross-kind row persisted before the server enforced the action's
         kind, both land here. -->
    <p
      v-if="view && problemText"
      class="stock-prep-source__problem"
      data-testid="stock-prep-source-problem"
    >
      {{ bi('当前来源现在读不了:', 'The current source cannot be read right now: ') }}
      {{ bi(problemText.zh, problemText.en) }}
    </p>

    <!-- R-11: the picker and Save render ONLY for a principal the server would accept. A
         `stock-prep:admin` holder who can open this tab still sees the current source and is told,
         in words, who changes it — rather than a control that 403s. -->
    <template v-if="canBind">
      <div class="stock-prep-source__picker">
        <label class="stock-prep-source__label" for="stock-prep-source-select">
          {{ bi('换成这个连接', 'Switch to this connection') }}
        </label>
        <select
          id="stock-prep-source-select"
          v-model="selected"
          class="stock-prep-source__select"
          data-testid="stock-prep-source-select"
          :disabled="busy"
        >
          <option value="" disabled>{{ bi('请选择…', 'Choose…') }}</option>
          <option
            v-for="candidate in candidates"
            :key="candidate.externalSystemId"
            :value="candidate.externalSystemId"
            data-testid="stock-prep-source-option"
          >
            {{ optionLabel(candidate) }}
          </option>
        </select>
        <button
          type="button"
          class="stock-prep-source__save"
          data-testid="stock-prep-source-save"
          :disabled="busy || !selected || selected === view?.effectiveExternalSystemId"
          @click="askToSave"
        >
          {{ bi('保存', 'Save') }}
        </button>
      </div>

      <p v-if="candidates.length === 0" class="stock-prep-source__empty" data-testid="stock-prep-source-empty">
        {{ bi(
          '这里没有可选的连接 —— 请先在「对接」里登记一个只读数据库连接并启用它。已登记但不属于您管理的连接不会出现在这里。',
          'There are no connections to choose from — register a read-only database connection under 对接 and activate it first. Connections you do not manage are not listed here.',
        ) }}
      </p>

      <!-- The confirmation. Repointing 备料 at a different database changes what every subsequent
           row is built from, so it is a confirm-then-act, never a one-click. -->
      <div v-if="pending" class="stock-prep-source__confirm" data-testid="stock-prep-source-confirm">
        <p class="stock-prep-source__confirm-text" data-testid="stock-prep-source-confirm-text">
          {{ bi(
            `确认把备料的数据来源改成「${pendingName}」吗?之后的每一次「同步这个项目」都会从这个库取数。`,
            `Change 备料's data source to “${pendingName}”? Every later 同步这个项目 will read from that database.`,
          ) }}
        </p>
        <p class="stock-prep-source__confirm-note">{{ bi(noRestart.zh, noRestart.en) }}</p>
        <button
          type="button"
          class="stock-prep-source__save"
          data-testid="stock-prep-source-confirm-save"
          :disabled="busy"
          @click="save"
        >
          {{ bi('确认更改', 'Confirm the change') }}
        </button>
        <button
          type="button"
          class="stock-prep-source__cancel"
          data-testid="stock-prep-source-cancel"
          :disabled="busy"
          @click="pending = null"
        >
          {{ bi('取消', 'Cancel') }}
        </button>
      </div>

      <p v-if="saved" class="stock-prep-source__saved" data-testid="stock-prep-source-saved">
        {{ bi(
          '已保存,并且已经生效 —— 下一次「同步这个项目」就会从新来源取数,不用重启。',
          'Saved, and already live — the next 同步这个项目 reads from the new source. No restart needed.',
        ) }}
      </p>
    </template>

    <p v-else class="stock-prep-source__readonly" data-testid="stock-prep-source-readonly">
      {{ bi(adminOnly.zh, adminOnly.en) }}
    </p>
  </section>
</template>

<script setup lang="ts">
// BOM备料 数据来源 —— the picker that ends "SSH in, edit the env file, restart the backend".
//
// WHAT IT IS FOR. The stock-preparation pull action reads a customer's BOM out of ONE external
// system, and until now which one was pinned in a server env var read at plugin activation. Every
// new customer therefore needed an implementer with a shell just to say "read our PLM, not the demo
// database". This panel is that sentence, as a dropdown; the server persists it and resolves it per
// request, so the next 同步 uses it with no restart.
//
// WHO SEES WHAT (R-11 — what is not permitted must not be visible):
//   * a platform admin gets the current source, the candidate list, and Save;
//   * a `stock-prep:admin` holder who can open the 安装/体检 tab gets the current source and is told
//     who changes it. They are NOT shown a Save that would 403, and the panel does not call the
//     admin-tier routes on their behalf.
// `canRunStockPrepInstall` is reused rather than a new predicate invented: it already means "this
// caller holds `integration:admin`", which is exactly the tier both source-binding routes require.
//
// THE PAGE DECIDES NOTHING ABOUT ELIGIBILITY. `eligibleSources` arrives already filtered by the
// server — the two BOM read kinds only, active only, non-write roles only, and only data sources
// this principal may actually use (#5401 is owner-only; being an admin does not make a colleague's
// connection yours). Re-deriving any of that here would be a second authority that drifts. The page
// renders the list it is given, and a refusal is rendered from the server's own closed reason token.
//
// PLAIN LANGUAGE FIRST (#5391 register), identifier second. The name an admin recognises leads;
// the connector kind is shown in words from 对接总览's own register ("只读数据库桥接"), not as a raw
// token; the id sits beside it in a <code> because an implementer greps for it.
//
// VALUES-FREE. Ids, kinds, status enums, operator-authored connection names, and committed
// plain-language constants. No server message text ever reaches the DOM — only an HTTP status and a
// closed reason token — so nothing here can quote a customer value or a credential.
import { computed, onMounted, ref } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import { useAuth } from '../../../composables/useAuth'
import type { IntegrationScope } from '../../../services/integration/workbench'
import { canRunStockPrepInstall } from '../../../services/integration/stockPreparation/workbenchAccess'
import {
  readStockPreparationSourceBinding,
  setStockPreparationSourceBinding,
  stockPrepSourceRefusalText,
  StockPreparationSourceBindingError,
  STOCK_PREP_SOURCE_ADMIN_ONLY,
  STOCK_PREP_SOURCE_NO_RESTART,
  STOCK_PREP_SOURCE_ORIGIN_TEXT,
  type StockPreparationSourceBindingView,
  type StockPreparationSourceCandidate,
} from '../../../services/integration/stockPreparation/sourceBinding'

const props = defineProps<{ scope: IntegrationScope }>()

const { locale } = useLocale()
const auth = useAuth()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const canBind = computed(() => canRunStockPrepInstall((permission) => auth.hasPermission(permission)))

const busy = ref(false)
const errorStatus = ref<number | null>(null)
const refusalReason = ref<string | null>(null)
const view = ref<StockPreparationSourceBindingView | null>(null)
const selected = ref('')
const pending = ref<StockPreparationSourceCandidate | null>(null)
const saved = ref(false)

const noRestart = STOCK_PREP_SOURCE_NO_RESTART
const adminOnly = STOCK_PREP_SOURCE_ADMIN_ONLY

const candidates = computed(() => view.value?.eligibleSources ?? [])

const refusalText = computed(() => stockPrepSourceRefusalText(refusalReason.value))

/** Why the CURRENTLY effective source cannot be read, in words. Same closed vocabulary as a refusal. */
const problemText = computed(() => stockPrepSourceRefusalText(view.value?.effectiveSourceProblem ?? null))

// Degrade rather than blank: a server that grows a fourth origin token, or an envelope that omits
// the field, renders the "nothing chosen" line instead of throwing on an undefined lookup.
const originText = computed(() => (
  (view.value && STOCK_PREP_SOURCE_ORIGIN_TEXT[view.value.origin]) || STOCK_PREP_SOURCE_ORIGIN_TEXT.unconfigured
))

/** The bound system's NAME when the candidate list knows it, else its id — never a blank line. */
const currentName = computed(() => {
  const id = view.value?.effectiveExternalSystemId
  if (!id) return bi('尚未设置', 'not set yet')
  const match = candidates.value.find((candidate) => candidate.externalSystemId === id)
  return match?.name || id
})

const pendingName = computed(() => pending.value?.name || pending.value?.externalSystemId || '')

/** Name first, kind in words, id last — the #5391 order. */
function optionLabel(candidate: StockPreparationSourceCandidate): string {
  const kind = locale.value === 'zh-CN' ? candidate.kindLabel?.zh : candidate.kindLabel?.en
  const parts = [candidate.name || candidate.externalSystemId]
  if (kind) parts.push(`(${kind})`)
  return parts.join(' ')
}

/** Only an HTTP status and the server's closed reason token reach state. */
function recordError(error: unknown): void {
  if (error instanceof StockPreparationSourceBindingError) {
    errorStatus.value = error.status
    refusalReason.value = error.reason
    return
  }
  errorStatus.value = 0
  refusalReason.value = null
}

async function load(): Promise<void> {
  // A non-admin never calls the admin-tier route: the server would refuse, and rendering that
  // refusal as an error would tell them a control exists that does not exist for them.
  if (!canBind.value) return
  busy.value = true
  errorStatus.value = null
  refusalReason.value = null
  try {
    view.value = await readStockPreparationSourceBinding(props.scope)
    selected.value = view.value.effectiveExternalSystemId || ''
  } catch (error) {
    recordError(error)
  } finally {
    busy.value = false
  }
}

function askToSave(): void {
  saved.value = false
  errorStatus.value = null
  refusalReason.value = null
  pending.value = candidates.value.find((candidate) => candidate.externalSystemId === selected.value) || null
}

async function save(): Promise<void> {
  const target = pending.value
  if (!target) return
  busy.value = true
  errorStatus.value = null
  refusalReason.value = null
  try {
    await setStockPreparationSourceBinding(props.scope, target.externalSystemId)
    pending.value = null
    saved.value = true
    // Re-read rather than patching local state: the server is the authority on what the action will
    // now resolve, and reporting a save the server did not make is the one thing this panel must
    // never do.
    view.value = await readStockPreparationSourceBinding(props.scope)
    selected.value = view.value.effectiveExternalSystemId || ''
  } catch (error) {
    recordError(error)
    pending.value = null
  } finally {
    busy.value = false
  }
}

onMounted(load)

defineExpose({ load })
</script>

<style scoped>
.stock-prep-source {
  margin-bottom: var(--ms-space-4);
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
}

.stock-prep-source__h3 {
  margin: 0 0 var(--ms-space-2);
  font-size: 14px;
  font-weight: 600;
}

.stock-prep-source__intro,
.stock-prep-source__origin,
.stock-prep-source__empty,
.stock-prep-source__readonly {
  margin: 0 0 var(--ms-space-2);
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.6;
}

.stock-prep-source__no-restart {
  margin: 0 0 var(--ms-space-2);
  color: var(--el-color-success, #4c9a5a);
  font-size: 13px;
}

.stock-prep-source__current {
  margin: 0 0 var(--ms-space-1);
  font-size: 13px;
}

.stock-prep-source__error {
  margin: 0 0 var(--ms-space-2);
  color: var(--el-color-danger, #c45656);
  font-size: 13px;
}

.stock-prep-source__problem {
  margin: 0 0 var(--ms-space-2);
  color: var(--el-color-warning, #b88230);
  font-size: 13px;
  line-height: 1.6;
}

.stock-prep-source__token {
  margin-left: var(--ms-space-1);
  padding: 0 4px;
  border-radius: 3px;
  background: var(--ms-bg-hover);
  color: var(--ms-text-3);
  font-size: 12px;
}

.stock-prep-source__picker {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-2);
  align-items: center;
  margin-bottom: var(--ms-space-2);
}

.stock-prep-source__label {
  font-size: 13px;
  color: var(--ms-text-2);
}

.stock-prep-source__select {
  min-width: 260px;
  padding: 4px 6px;
  border: 1px solid var(--ms-border-light);
  border-radius: 4px;
  font-size: 13px;
}

.stock-prep-source__save,
.stock-prep-source__cancel {
  padding: 4px 12px;
  border: 1px solid var(--ms-border-light);
  border-radius: 4px;
  background: var(--ms-bg-page);
  font-size: 13px;
  cursor: pointer;
}

.stock-prep-source__save:disabled,
.stock-prep-source__cancel:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.stock-prep-source__confirm {
  margin-bottom: var(--ms-space-2);
  padding: var(--ms-space-2);
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: var(--ms-bg-hover);
}

.stock-prep-source__confirm-text,
.stock-prep-source__confirm-note {
  margin: 0 0 var(--ms-space-2);
  font-size: 13px;
  line-height: 1.6;
}

.stock-prep-source__saved {
  margin: 0;
  color: var(--el-color-success, #4c9a5a);
  font-size: 13px;
}
</style>
