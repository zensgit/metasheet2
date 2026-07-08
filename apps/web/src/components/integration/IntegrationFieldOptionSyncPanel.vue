<template>
  <div v-if="hasIntegrationAdmin" class="integration-workbench__table-action" data-testid="stock-option-sync-panel">
    <div class="integration-workbench__panel-head">
      <div>
        <h3>字段选项同步</h3>
        <p>管理员按预设把 select/dropdown 字段选项元数据写入对应字段；只改字段定义，不写业务行。</p>
      </div>
      <span class="integration-workbench__badge">admin · metadata-only</span>
    </div>
    <label class="integration-workbench__inline-field">
      <span>同步预设</span>
      <select v-model="fieldOptionSyncPresetId" data-testid="field-options-preset">
        <option v-for="preset in fieldOptionSyncPresets" :key="preset.presetId" :value="preset.presetId">
          {{ preset.label }}
        </option>
      </select>
    </label>
    <div class="integration-workbench__inline-field integration-workbench__mode-toggle">
      <span>{{ bi('编辑模式', 'Edit mode') }}</span>
      <button
        type="button"
        class="integration-workbench__button"
        data-testid="field-options-mode-toggle"
        :disabled="mode === 'expert' && !isCurrentTextStructurable"
        @click="toggleMode"
      >
        {{ mode === 'structured'
          ? bi('切换到专家 JSON', 'Switch to expert JSON')
          : bi('切换到结构化编辑', 'Switch to structured editor') }}
      </button>
    </div>
    <p
      v-if="mode === 'expert' && !isCurrentTextStructurable"
      class="integration-workbench__hint"
      data-testid="field-options-structured-unavailable-hint"
    >
      {{ bi(
        '当前内容不是结构化编辑器支持的字段选项形状（例如包含 optionSources/configInfo，或选项缺少 value/label），已使用专家 JSON 模式；修正为受支持的形状后可切换回结构化编辑。',
        'The current content is not a shape the structured editor supports (e.g. it carries optionSources/configInfo, or an option is missing value/label) — using expert JSON mode; fix it to a supported shape to switch back to the structured editor.',
      ) }}
    </p>
    <IntegrationOptionSetsStructuredEditor
      v-if="mode === 'structured'"
      v-model="stockPreparationOptionSyncText"
    />
    <label v-show="mode === 'expert'">
      <span>optionSets JSON</span>
      <textarea
        v-model="stockPreparationOptionSyncText"
        data-testid="stock-option-sync-json"
        rows="8"
        :placeholder="stockPreparationOptionSyncPlaceholder"
      />
      <JsonAssist
        v-model="stockPreparationOptionSyncText"
        test-id="stock-option-sync-json"
        :placeholder-example="stockPreparationOptionSyncPlaceholder"
      />
    </label>
    <p class="integration-workbench__hint" data-testid="stock-option-sync-boundary">
      这里只写字段选项元数据；不执行动作，不接受 SQL/JS/URL/function body，不写 PLM/K3/业务行。带 actionBindings 的选项走备料兼容路径（动作绑定泛化待 FOS-4）。
    </p>
    <div class="integration-workbench__actions">
      <button
        type="button"
        class="integration-workbench__button"
        data-testid="field-options-sync-run"
        :disabled="!stockPreparationOptionSyncCanRun"
        @click="syncFieldOptions"
      >
        {{ syncingStockPreparationOptions ? '同步中' : '同步字段选项' }}
      </button>
    </div>
    <p
      v-if="fieldOptionSyncPathNote"
      class="integration-workbench__hint"
      data-testid="field-options-sync-path"
    >
      {{ fieldOptionSyncPathNote }}
    </p>
    <pre v-if="stockPreparationOptionSyncEvidenceText" data-testid="stock-option-sync-evidence">{{ stockPreparationOptionSyncEvidenceText }}</pre>
  </div>
</template>

<script setup lang="ts">
// IU-2d (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-2,
// stage D — `int-sec-run-push` decomposition): field-option-sync panel, one of five focused
// sub-panels the prior monolithic `int-sec-run-push` section bundled. Pure template/markup move —
// no state or service-call logic lives here. The `optionSets JSON` textarea
// (`data-testid="stock-option-sync-json"`) was originally kept exactly as a raw JSON textarea —
// structuring it was IU-5's job (§2 IU-5, gated on IU-2 landing); D2 (below) is that slice.
//
// D2 (site 5 of IU-5, gated on IU-2 landing + this panel's own landing #3822): the raw textarea
// is now the EXPERT fallback (`mode === 'expert'`) beside a default structured
// (repeatable-row) editor (`mode === 'structured'`). Zero backend/service change either way — both
// modes write the SAME `stockPreparationOptionSyncText` model the parent already owns and
// `syncFieldOptions` already reads; see `../../utils/optionSetsStructured.ts` for the
// structured<->JSON contract and closed-shape rules.
//
// The expert-mode `<label>` block uses `v-show` (not `v-if`) — the textarea and its
// `data-testid="stock-option-sync-json"` must stay reachable in the DOM at all times (an existing
// spec pins `querySelector(...)` finding it as a `TEXTAREA` unconditionally; `v-show` only toggles
// CSS display, so that assertion needed zero changes). The structured editor uses `v-if` instead
// (cheaper: it only needs to parse the current text once, at the moment the user switches into
// structured mode — see that component's own header comment on why a remount-on-toggle beats a
// reactive text->rows watcher for avoiding an edit feedback loop).
//
// Mode defaults to `structured` unless the initial text isn't structurable (`parseOptionSets`
// fails), in which case it starts in `expert` so nothing existing is ever hidden behind a broken
// toggle. Switching FROM expert TO structured re-checks structurability live (the user may have
// hand-edited the textarea) and is blocked (button disabled + a values-free hint) when the current
// text doesn't parse into the closed shape — switching FROM structured TO expert is always
// allowed (structured edits always produce valid, structurable JSON).
//
// Same permission-gate note as `IntegrationStockPrepPanel.vue`: the `integration:admin` gate
// stays on this block's own root `v-if` exactly where the pre-extraction markup had it, driven by
// the `hasIntegrationAdmin` prop (parent passes the byte-identical
// `auth.hasPermission('integration:admin')` expression) — unauthorized users get no DOM at all
// for this panel, same as before.
//
// FOS-3: only the stock-preparation preset is wired today (see the view's own comment above
// `fieldOptionSyncPresets`); this local type mirrors that `as const` array's element shape.
import { computed, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { parseOptionSets } from '../../utils/optionSetsStructured'
import JsonAssist from './JsonAssist.vue'
import IntegrationOptionSetsStructuredEditor from './IntegrationOptionSetsStructuredEditor.vue'

interface FieldOptionSyncPreset {
  presetId: string
  label: string
}

defineProps<{
  hasIntegrationAdmin: boolean
  fieldOptionSyncPresets: readonly FieldOptionSyncPreset[]
  stockPreparationOptionSyncPlaceholder: string
  stockPreparationOptionSyncCanRun: boolean
  syncingStockPreparationOptions: boolean
  fieldOptionSyncPathNote: string
  stockPreparationOptionSyncEvidenceText: string
  syncFieldOptions: () => Promise<void>
}>()

const fieldOptionSyncPresetId = defineModel<string>('fieldOptionSyncPresetId', { default: '' })
const stockPreparationOptionSyncText = defineModel<string>('stockPreparationOptionSyncText', { default: '' })

const { locale } = useLocale()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

// Initial mode is decided ONCE, from the model's value at mount — never re-derived reactively off
// `stockPreparationOptionSyncText` (that would fight in-progress structured-mode edits). Defaults
// to structured unless the starting text isn't structurable, so nothing existing lands behind a
// broken toggle.
const mode = ref<'structured' | 'expert'>(
  parseOptionSets(stockPreparationOptionSyncText.value).ok ? 'structured' : 'expert',
)

// Read live only while in expert mode, to gate the toggle button (whether switching BACK to
// structured is currently safe) and the unavailable hint — this is a read-only status check, not
// a rebuild of any editor state, so it carries none of the text->rows loop risk.
const isCurrentTextStructurable = computed(() => parseOptionSets(stockPreparationOptionSyncText.value).ok)

function toggleMode(): void {
  if (mode.value === 'structured') {
    mode.value = 'expert'
    return
  }
  if (!isCurrentTextStructurable.value) return
  mode.value = 'structured'
}
</script>

<style scoped>
/* Verbatim copies (selectively trimmed to the tags/classes this component actually renders) of
   the rules in IntegrationWorkbenchView.vue's <style scoped> block that target this markup. */

/* D2: mode-toggle row (new, not carried over from the pre-D2 markup). */
.integration-workbench__mode-toggle {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
  margin-top: var(--ms-space-2);
  font-size: 13px;
  font-weight: 700;
  color: var(--ms-text-1);
}

.integration-workbench__table-action {
  margin: 16px 0;
  padding: 14px;
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
}

.integration-workbench__table-action h3 {
  margin: 0 0 4px;
  font-size: 16px;
}

.integration-workbench__table-action p {
  margin: 0;
}

.integration-workbench__panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.integration-workbench__badge {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  padding: 5px 8px;
  border-radius: 999px;
  background: var(--el-fill-color-light);
  color: var(--ms-text-2);
  font-size: 12px;
  font-weight: 700;
}

.integration-workbench label {
  display: grid;
  gap: 6px;
  color: var(--ms-text-1);
  font-size: 13px;
  font-weight: 700;
}

.integration-workbench select,
.integration-workbench textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--ms-border);
  border-radius: 6px;
  padding: 8px 10px;
  color: var(--ms-text-1);
  font: inherit;
}

.integration-workbench textarea {
  min-height: 260px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
}

.integration-workbench__hint {
  margin-top: 10px;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.5;
}

.integration-workbench__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 14px;
}

.integration-workbench__button {
  border: 1px solid var(--ms-border);
  border-radius: 6px;
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  cursor: pointer;
  font-weight: 700;
  text-decoration: none;
  padding: 8px 12px;
}

.integration-workbench__button:hover {
  border-color: var(--ms-color-primary);
}

.integration-workbench__button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.integration-workbench pre {
  min-height: 260px;
  max-height: 420px;
  overflow: auto;
  margin: 12px 0 0;
  padding: 12px;
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: var(--ms-text-1);
  color: var(--el-color-primary-light-9);
  font-size: 12px;
  line-height: 1.5;
}

@media (max-width: 900px) {
  .integration-workbench__panel-head {
    grid-template-columns: 1fr;
  }

  .integration-workbench__panel-head {
    display: grid;
  }
}
</style>
