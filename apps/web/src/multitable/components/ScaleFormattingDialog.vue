<template>
  <div v-if="visible" class="scf-dlg__overlay" @click.self="close">
    <div class="scf-dlg" role="dialog" :aria-label="ml('formatting.scaleAriaTitle')">
      <div class="scf-dlg__header">
        <h4 class="scf-dlg__title">{{ ml('formatting.scaleTitle') }}</h4>
        <span class="scf-dlg__count">{{ draftRules.length }} / {{ ruleLimit }}</span>
        <button class="scf-dlg__close" :aria-label="ml('formatting.close')" @click="close">&times;</button>
      </div>
      <div class="scf-dlg__body">
        <p v-if="!draftRules.length" class="scf-dlg__empty">{{ ml('formatting.scaleEmpty') }}</p>
        <div v-else class="scf-dlg__rule-list">
          <div
            v-for="(rule, index) in draftRules"
            :key="rule.id"
            class="scf-dlg__rule"
            :class="{ 'scf-dlg__rule--disabled': !rule.enabled }"
          >
            <div class="scf-dlg__rule-row">
              <span class="scf-dlg__rule-index">{{ index + 1 }}.</span>
              <label class="scf-dlg__inline">
                <span class="scf-dlg__label">{{ ml('formatting.scaleField') }}</span>
                <select v-model="rule.fieldId" class="scf-dlg__select">
                  <option
                    v-for="field in fieldOptionsFor(rule)"
                    :key="field.id"
                    :value="field.id"
                    :disabled="field.disabled"
                  >{{ field.name }}</option>
                </select>
              </label>
              <label class="scf-dlg__inline">
                <span class="scf-dlg__label">{{ ml('formatting.scaleKind') }}</span>
                <select v-model="rule.kind" class="scf-dlg__select">
                  <option value="dataBar">{{ ml('formatting.scaleKindDataBar') }}</option>
                  <option value="colorScale">{{ ml('formatting.scaleKindColorScale') }}</option>
                  <option value="iconSet">{{ ml('formatting.scaleKindIconSet') }}</option>
                </select>
              </label>
              <label class="scf-dlg__check-inline">
                <input type="checkbox" :checked="rule.enabled" @change="rule.enabled = ($event.target as HTMLInputElement).checked" />
                <span>{{ ml('formatting.enabled') }}</span>
              </label>
            </div>

            <!-- dataBar -->
            <template v-if="rule.kind === 'dataBar'">
              <div class="scf-dlg__rule-row">
                <span class="scf-dlg__label">{{ ml('formatting.scaleBarColor') }}</span>
                <div class="scf-dlg__palette">
                  <button
                    v-for="preset in BAR_PALETTE"
                    :key="preset"
                    type="button"
                    class="scf-dlg__swatch"
                    :class="{ 'scf-dlg__swatch--active': rule.barColor === preset }"
                    :style="{ backgroundColor: preset }"
                    :aria-label="pickColorLabel(preset)"
                    @click="rule.barColor = preset"
                  />
                  <input
                    type="text"
                    class="scf-dlg__hex"
                    :value="rule.barColor"
                    @input="rule.barColor = ($event.target as HTMLInputElement).value"
                    placeholder="#RRGGBB"
                    maxlength="9"
                  />
                </div>
              </div>
              <div class="scf-dlg__rule-row">
                <span class="scf-dlg__label">{{ ml('formatting.scaleBarNegativeColor') }}</span>
                <div class="scf-dlg__palette">
                  <input
                    type="text"
                    class="scf-dlg__hex"
                    :value="rule.barNegativeColor"
                    @input="rule.barNegativeColor = ($event.target as HTMLInputElement).value"
                    placeholder="#RRGGBB"
                    maxlength="9"
                  />
                </div>
                <label class="scf-dlg__check-inline">
                  <input type="checkbox" :checked="rule.barShowValue" @change="rule.barShowValue = ($event.target as HTMLInputElement).checked" />
                  <span>{{ ml('formatting.scaleBarShowValue') }}</span>
                </label>
              </div>
            </template>

            <!-- colorScale -->
            <template v-else-if="rule.kind === 'colorScale'">
              <div class="scf-dlg__rule-row">
                <span class="scf-dlg__label">{{ ml('formatting.scaleStopMin') }}</span>
                <div class="scf-dlg__palette">
                  <button
                    v-for="preset in STOP_PALETTE"
                    :key="preset"
                    type="button"
                    class="scf-dlg__swatch"
                    :class="{ 'scf-dlg__swatch--active': rule.stopMin === preset }"
                    :style="{ backgroundColor: preset }"
                    :aria-label="pickColorLabel(preset)"
                    @click="rule.stopMin = preset"
                  />
                  <input
                    type="text"
                    class="scf-dlg__hex"
                    :value="rule.stopMin"
                    @input="rule.stopMin = ($event.target as HTMLInputElement).value"
                    placeholder="#RRGGBB"
                    maxlength="9"
                  />
                </div>
              </div>
              <div v-if="rule.hasMid" class="scf-dlg__rule-row">
                <span class="scf-dlg__label">{{ ml('formatting.scaleStopMid') }}</span>
                <div class="scf-dlg__palette">
                  <button
                    v-for="preset in STOP_PALETTE"
                    :key="preset"
                    type="button"
                    class="scf-dlg__swatch"
                    :class="{ 'scf-dlg__swatch--active': rule.stopMid === preset }"
                    :style="{ backgroundColor: preset }"
                    :aria-label="pickColorLabel(preset)"
                    @click="rule.stopMid = preset"
                  />
                  <input
                    type="text"
                    class="scf-dlg__hex"
                    :value="rule.stopMid"
                    @input="rule.stopMid = ($event.target as HTMLInputElement).value"
                    placeholder="#RRGGBB"
                    maxlength="9"
                  />
                </div>
                <button type="button" class="scf-dlg__btn scf-dlg__btn--ghost" @click="rule.hasMid = false">{{ ml('formatting.scaleDropMidStop') }}</button>
              </div>
              <div class="scf-dlg__rule-row">
                <span class="scf-dlg__label">{{ ml('formatting.scaleStopMax') }}</span>
                <div class="scf-dlg__palette">
                  <button
                    v-for="preset in STOP_PALETTE"
                    :key="preset"
                    type="button"
                    class="scf-dlg__swatch"
                    :class="{ 'scf-dlg__swatch--active': rule.stopMax === preset }"
                    :style="{ backgroundColor: preset }"
                    :aria-label="pickColorLabel(preset)"
                    @click="rule.stopMax = preset"
                  />
                  <input
                    type="text"
                    class="scf-dlg__hex"
                    :value="rule.stopMax"
                    @input="rule.stopMax = ($event.target as HTMLInputElement).value"
                    placeholder="#RRGGBB"
                    maxlength="9"
                  />
                </div>
              </div>
              <div v-if="!rule.hasMid" class="scf-dlg__rule-row">
                <button type="button" class="scf-dlg__btn scf-dlg__btn--ghost" @click="rule.hasMid = true">{{ ml('formatting.scaleAddMidStop') }}</button>
              </div>
              <div class="scf-dlg__rule-row">
                <span class="scf-dlg__label">{{ ml('formatting.scalePreview') }}</span>
                <span class="scf-dlg__preview-bar" :style="{ backgroundImage: colorScaleGradient(rule) }" />
              </div>
            </template>

            <!-- iconSet -->
            <template v-else>
              <div class="scf-dlg__rule-row">
                <label class="scf-dlg__inline">
                  <span class="scf-dlg__label">{{ ml('formatting.scaleIconSet') }}</span>
                  <select v-model="rule.iconSetName" class="scf-dlg__select">
                    <option value="arrows3">{{ ml('formatting.scaleIconSetArrows') }}</option>
                    <option value="traffic3">{{ ml('formatting.scaleIconSetTraffic') }}</option>
                    <option value="signs3">{{ ml('formatting.scaleIconSetSigns') }}</option>
                  </select>
                </label>
                <span class="scf-dlg__label">{{ ml('formatting.scalePreview') }}</span>
                <span class="scf-dlg__icon-preview">
                  <span
                    v-for="(g, gi) in iconGlyphsFor(rule.iconSetName)"
                    :key="gi"
                    class="scf-dlg__icon-glyph"
                    :style="{ color: g.color }"
                  >{{ g.glyph }}</span>
                </span>
              </div>
              <div class="scf-dlg__rule-row">
                <label class="scf-dlg__inline">
                  <span class="scf-dlg__label">{{ ml('formatting.scaleThresholdLower') }}</span>
                  <input
                    type="number"
                    class="scf-dlg__input scf-dlg__input--mini"
                    :value="rule.t0"
                    @input="rule.t0 = ($event.target as HTMLInputElement).value"
                  />
                </label>
                <label class="scf-dlg__inline">
                  <span class="scf-dlg__label">{{ ml('formatting.scaleThresholdUpper') }}</span>
                  <input
                    type="number"
                    class="scf-dlg__input scf-dlg__input--mini"
                    :value="rule.t1"
                    @input="rule.t1 = ($event.target as HTMLInputElement).value"
                  />
                </label>
              </div>
              <p v-if="thresholdError(rule)" class="scf-dlg__error">{{ ml('formatting.scaleThresholdError') }}</p>
            </template>

            <!-- range (shared) -->
            <div class="scf-dlg__rule-row scf-dlg__rule-row--secondary">
              <span class="scf-dlg__label">{{ ml('formatting.scaleRangeMode') }}</span>
              <label class="scf-dlg__radio">
                <input type="radio" :checked="rule.rangeMode === 'auto'" @change="rule.rangeMode = 'auto'" />
                <span>{{ ml('formatting.scaleRangeAuto') }}</span>
              </label>
              <label class="scf-dlg__radio">
                <input type="radio" :checked="rule.rangeMode === 'fixed'" @change="rule.rangeMode = 'fixed'" />
                <span>{{ ml('formatting.scaleRangeFixed') }}</span>
              </label>
              <template v-if="rule.rangeMode === 'fixed'">
                <label class="scf-dlg__inline">
                  <span class="scf-dlg__label">{{ ml('formatting.scaleRangeMin') }}</span>
                  <input
                    type="number"
                    class="scf-dlg__input scf-dlg__input--mini"
                    :value="rule.rangeMin"
                    @input="rule.rangeMin = ($event.target as HTMLInputElement).value"
                  />
                </label>
                <label class="scf-dlg__inline">
                  <span class="scf-dlg__label">{{ ml('formatting.scaleRangeMax') }}</span>
                  <input
                    type="number"
                    class="scf-dlg__input scf-dlg__input--mini"
                    :value="rule.rangeMax"
                    @input="rule.rangeMax = ($event.target as HTMLInputElement).value"
                  />
                </label>
              </template>
            </div>
            <p v-if="rule.rangeMode === 'fixed' && rangeSameError(rule)" class="scf-dlg__error">{{ ml('formatting.scaleRangeSameError') }}</p>
            <p v-else-if="rule.rangeMode === 'auto'" class="scf-dlg__hint">{{ ml('formatting.scaleAutoRangeHint') }}</p>

            <div class="scf-dlg__rule-row scf-dlg__rule-row--actions">
              <button type="button" class="scf-dlg__btn scf-dlg__btn--danger" @click="removeRule(index)">{{ ml('action.remove') }}</button>
            </div>
          </div>
        </div>
        <button
          type="button"
          class="scf-dlg__btn scf-dlg__btn--primary"
          :disabled="!canAddRule"
          @click="addRule"
        >{{ ml('formatting.scaleAddRule') }}</button>
        <p v-if="!numericFields.length" class="scf-dlg__hint">{{ ml('formatting.scaleNoFieldsHint') }}</p>
        <p v-else-if="!availableFields.length" class="scf-dlg__hint">{{ ml('formatting.scaleAllFieldsUsedHint') }}</p>
      </div>
      <div class="scf-dlg__footer">
        <button type="button" class="scf-dlg__btn" @click="close">{{ ml('action.cancel') }}</button>
        <button type="button" class="scf-dlg__btn scf-dlg__btn--primary" :disabled="!dirty || hasInvalidRule" @click="save">{{ ml('formatting.saveRules') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type {
  ConditionalFormattingColorScaleStop,
  ConditionalFormattingIconSetName,
  ConditionalFormattingScaleKind,
  ConditionalFormattingScaleRule,
  MetaField,
} from '../types'
import { CONDITIONAL_FORMATTING_SCALE_RULE_LIMIT } from '../types'
import { HEX_COLOR_RE, extractScaleRulesFromConfig, lerpHexColor } from '../utils/conditional-formatting'
import { SCALE_ICON_GLYPHS, type ScaleIconGlyph } from '../utils/scale-icons'
import { formattingPickColor, managerLabel } from '../utils/meta-manager-labels'

const props = defineProps<{
  visible: boolean
  fields: MetaField[]
  /** Current view config; scale rules are read from `config.conditionalFormattingScaleRules`. */
  viewConfig?: Record<string, unknown>
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'save', rules: ConditionalFormattingScaleRule[]): void
  (e: 'update:dirty', dirty: boolean): void
}>()

const ruleLimit = CONDITIONAL_FORMATTING_SCALE_RULE_LIMIT
const { isZh } = useLocale()
const ml = (key: Parameters<typeof managerLabel>[0]) => managerLabel(key, isZh.value)
const pickColorLabel = (color: string) => formattingPickColor(color, isZh.value)

const NUMERIC_FIELD_TYPES: ReadonlySet<string> = new Set(['number', 'currency', 'percent', 'rating'])

const BAR_PALETTE = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#0ea5e9', '#1f2937'] as const
const STOP_PALETTE = ['#f8696b', '#ffeb84', '#63be7b', '#ffffff', '#3b82f6', '#fce4e4', '#e0f3d8'] as const

// Draft uses a flat shape with all kind-specific fields present so switching
// kinds is non-destructive and color/threshold inputs keep their values. Numeric
// inputs are held as strings (so a half-typed "-" doesn't coerce to 0) and parsed
// only at save. Color-scale stops are keyed by at-name (min/mid?/max); the
// sanitizer resolves by name so emit order is irrelevant.
interface ScaleDraft {
  id: string
  fieldId: string
  kind: ConditionalFormattingScaleKind
  enabled: boolean
  rangeMode: 'auto' | 'fixed'
  rangeMin: string
  rangeMax: string
  barColor: string
  barNegativeColor: string
  barShowValue: boolean
  stopMin: string
  stopMid: string
  stopMax: string
  hasMid: boolean
  iconSetName: ConditionalFormattingIconSetName
  t0: string
  t1: string
}

const draftRules = ref<ScaleDraft[]>([])
const baseline = ref('[]')

const fieldsById = computed(() => {
  const map = new Map<string, MetaField>()
  for (const field of props.fields) map.set(field.id, field)
  return map
})

const numericFields = computed(() => props.fields.filter((field) => NUMERIC_FIELD_TYPES.has(field.type)))

/** Numeric fields not yet claimed by a draft rule (one-scale-rule-per-field). */
const availableFields = computed(() => {
  const used = new Set(draftRules.value.map((rule) => rule.fieldId))
  return numericFields.value.filter((field) => !used.has(field.id))
})

const canAddRule = computed(() => draftRules.value.length < ruleLimit && availableFields.value.length > 0)

/**
 * Field <select> options for a rule: numeric fields, with fields used by OTHER
 * rules disabled so the same field can't carry two scale rules (buildFieldScaleMap
 * is first-rule-per-field — a second rule would silently never render).
 */
function fieldOptionsFor(rule: ScaleDraft): Array<{ id: string; name: string; disabled: boolean }> {
  const usedByOthers = new Set(draftRules.value.filter((r) => r !== rule).map((r) => r.fieldId))
  return numericFields.value.map((field) => ({
    id: field.id,
    name: field.name,
    disabled: usedByOthers.has(field.id),
  }))
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? `scr_${crypto.randomUUID()}`
    : `scr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function fromRule(rule: ConditionalFormattingScaleRule): ScaleDraft {
  const stops = rule.colorScale?.stops ?? []
  const stopAt = (at: 'min' | 'mid' | 'max') => stops.find((s) => s.at === at)?.color
  return {
    id: rule.id,
    fieldId: rule.fieldId,
    kind: rule.kind,
    enabled: rule.enabled,
    rangeMode: rule.range.mode === 'fixed' ? 'fixed' : 'auto',
    rangeMin: typeof rule.range.min === 'number' ? String(rule.range.min) : '',
    rangeMax: typeof rule.range.max === 'number' ? String(rule.range.max) : '',
    barColor: rule.dataBar?.color ?? BAR_PALETTE[0],
    barNegativeColor: rule.dataBar?.negativeColor ?? '',
    barShowValue: rule.dataBar?.showValue === true,
    stopMin: stopAt('min') ?? STOP_PALETTE[0],
    stopMid: stopAt('mid') ?? STOP_PALETTE[1],
    stopMax: stopAt('max') ?? STOP_PALETTE[2],
    hasMid: stops.some((s) => s.at === 'mid'),
    iconSetName: rule.iconSet?.set ?? 'arrows3',
    t0: rule.iconSet ? String(rule.iconSet.thresholds[0]) : '0',
    t1: rule.iconSet ? String(rule.iconSet.thresholds[1]) : '1',
  }
}

function blankDraft(fieldId: string): ScaleDraft {
  return {
    id: newId(),
    fieldId,
    kind: 'dataBar',
    enabled: true,
    rangeMode: 'auto',
    rangeMin: '',
    rangeMax: '',
    barColor: BAR_PALETTE[0],
    barNegativeColor: '',
    barShowValue: false,
    stopMin: STOP_PALETTE[0],
    stopMid: STOP_PALETTE[1],
    stopMax: STOP_PALETTE[2],
    hasMid: true,
    iconSetName: 'arrows3',
    t0: '0',
    t1: '1',
  }
}

function snapshot(rules: ScaleDraft[]): string {
  return JSON.stringify(rules)
}

function hydrate() {
  const initial = extractScaleRulesFromConfig(props.viewConfig).map(fromRule)
  draftRules.value = reactive(initial) as ScaleDraft[]
  baseline.value = snapshot(draftRules.value)
}

watch(() => props.visible, (visible) => {
  if (visible) hydrate()
}, { immediate: true })

watch(() => props.viewConfig, () => {
  if (props.visible) hydrate()
})

const dirty = computed(() => props.visible && snapshot(draftRules.value) !== baseline.value)
watch(dirty, (value) => emit('update:dirty', value), { immediate: true })

function parseNumber(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

function thresholdError(rule: ScaleDraft): boolean {
  if (rule.kind !== 'iconSet') return false
  const t0 = parseNumber(rule.t0)
  const t1 = parseNumber(rule.t1)
  return t0 === null || t1 === null || t0 >= t1
}

function rangeSameError(rule: ScaleDraft): boolean {
  if (rule.rangeMode !== 'fixed') return false
  const min = parseNumber(rule.rangeMin)
  const max = parseNumber(rule.rangeMax)
  return min === null || max === null || min === max
}

function ruleInvalid(rule: ScaleDraft): boolean {
  if (rangeSameError(rule)) return true
  if (rule.kind === 'dataBar') {
    if (!HEX_COLOR_RE.test(rule.barColor)) return true
    if (rule.barNegativeColor.trim() && !HEX_COLOR_RE.test(rule.barNegativeColor)) return true
  } else if (rule.kind === 'colorScale') {
    if (!HEX_COLOR_RE.test(rule.stopMin) || !HEX_COLOR_RE.test(rule.stopMax)) return true
    if (rule.hasMid && !HEX_COLOR_RE.test(rule.stopMid)) return true
  } else if (rule.kind === 'iconSet') {
    if (thresholdError(rule)) return true
  }
  return false
}

const hasInvalidRule = computed(() => draftRules.value.some(ruleInvalid))

function iconGlyphsFor(set: ConditionalFormattingIconSetName): ReadonlyArray<ScaleIconGlyph> {
  return SCALE_ICON_GLYPHS[set] ?? []
}

/** CSS gradient preview built from the draft stops (min→mid?→max). */
function colorScaleGradient(rule: ScaleDraft): string {
  const min = HEX_COLOR_RE.test(rule.stopMin) ? rule.stopMin : '#000000'
  const max = HEX_COLOR_RE.test(rule.stopMax) ? rule.stopMax : '#ffffff'
  if (rule.hasMid) {
    const mid = HEX_COLOR_RE.test(rule.stopMid) ? rule.stopMid : lerpHexColor(min, max, 0.5)
    return `linear-gradient(to right, ${min}, ${mid}, ${max})`
  }
  return `linear-gradient(to right, ${min}, ${max})`
}

function addRule() {
  const field = availableFields.value[0]
  if (!field) return
  draftRules.value.push(reactive(blankDraft(field.id)) as ScaleDraft)
}

function removeRule(index: number) {
  draftRules.value.splice(index, 1)
}

function toRule(draft: ScaleDraft, order: number): ConditionalFormattingScaleRule {
  let range: ConditionalFormattingScaleRule['range']
  if (draft.rangeMode === 'fixed') {
    // Emit the canonical form (min<=max) so emitted === sanitizeScaleRule output;
    // the sanitizer normalizes with min/max too, so this avoids a non-canonical wire.
    const a = parseNumber(draft.rangeMin) ?? 0
    const b = parseNumber(draft.rangeMax) ?? 0
    range = { mode: 'fixed', min: Math.min(a, b), max: Math.max(a, b) }
  } else {
    range = { mode: 'auto' }
  }
  const base = { id: draft.id, order, fieldId: draft.fieldId, enabled: draft.enabled, range }
  if (draft.kind === 'dataBar') {
    const dataBar: ConditionalFormattingScaleRule['dataBar'] = { color: draft.barColor }
    if (draft.barNegativeColor.trim()) dataBar.negativeColor = draft.barNegativeColor.trim()
    if (draft.barShowValue) dataBar.showValue = true
    return { ...base, kind: 'dataBar', dataBar }
  }
  if (draft.kind === 'colorScale') {
    const stops: ConditionalFormattingColorScaleStop[] = [{ at: 'min', color: draft.stopMin }]
    if (draft.hasMid) stops.push({ at: 'mid', color: draft.stopMid })
    stops.push({ at: 'max', color: draft.stopMax })
    return { ...base, kind: 'colorScale', colorScale: { stops } }
  }
  return {
    ...base,
    kind: 'iconSet',
    iconSet: { set: draft.iconSetName, thresholds: [parseNumber(draft.t0) ?? 0, parseNumber(draft.t1) ?? 0] },
  }
}

function close() {
  if (dirty.value && !window.confirm(ml('view.discardFormattingConfirm'))) return
  emit('close')
}

function save() {
  if (hasInvalidRule.value) return
  const rules = draftRules.value.map((draft, index) => toRule(draft, index))
  emit('save', rules)
}
</script>

<style scoped>
.scf-dlg__overlay { position: fixed; inset: 0; background: rgba(0,0,0,.35); z-index: 110; display: flex; align-items: center; justify-content: center; }
.scf-dlg { width: 720px; max-height: 85vh; background: #fff; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.18); display: flex; flex-direction: column; }
.scf-dlg__header { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid #eee; }
.scf-dlg__title { flex: 1; font-size: 15px; font-weight: 600; margin: 0; }
.scf-dlg__count { font-size: 12px; color: #666; }
.scf-dlg__close { border: none; background: none; font-size: 20px; cursor: pointer; color: #999; padding: 0 4px; }
.scf-dlg__body { flex: 1; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 12px; }
.scf-dlg__empty { font-size: 13px; color: #777; margin: 0; }
.scf-dlg__rule-list { display: flex; flex-direction: column; gap: 10px; }
.scf-dlg__rule { border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px; background: #fafafa; display: flex; flex-direction: column; gap: 6px; }
.scf-dlg__rule--disabled { opacity: 0.55; }
.scf-dlg__rule-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.scf-dlg__rule-row--secondary { gap: 12px; }
.scf-dlg__rule-row--actions { justify-content: flex-end; }
.scf-dlg__rule-index { font-weight: 600; font-size: 12px; color: #666; min-width: 18px; }
.scf-dlg__inline { display: flex; align-items: center; gap: 6px; }
.scf-dlg__radio { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #444; cursor: pointer; }
.scf-dlg__select, .scf-dlg__input { padding: 4px 8px; border: 1px solid #d0d5dc; border-radius: 4px; font-size: 12px; background: #fff; }
.scf-dlg__input--mini { width: 90px; }
.scf-dlg__label { font-size: 12px; color: #555; }
.scf-dlg__palette { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.scf-dlg__swatch { width: 22px; height: 22px; border-radius: 4px; border: 1px solid #d0d5dc; cursor: pointer; padding: 0; }
.scf-dlg__swatch--active { box-shadow: 0 0 0 2px #1d4ed8; }
.scf-dlg__hex { width: 100px; padding: 3px 6px; border: 1px solid #d0d5dc; border-radius: 4px; font-size: 12px; }
.scf-dlg__check-inline { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #444; cursor: pointer; }
.scf-dlg__preview-bar { display: inline-block; width: 180px; height: 16px; border-radius: 3px; border: 1px solid #d0d5dc; }
.scf-dlg__icon-preview { display: inline-flex; align-items: center; gap: 8px; }
.scf-dlg__icon-glyph { font-size: 16px; font-weight: 700; }
.scf-dlg__error { font-size: 12px; color: #b91c1c; margin: 0; }
.scf-dlg__hint { font-size: 12px; color: #888; margin: 0; }
.scf-dlg__btn { padding: 5px 12px; border: 1px solid #d0d5dc; border-radius: 4px; background: #fff; cursor: pointer; font-size: 12px; color: #333; }
.scf-dlg__btn:hover:not(:disabled) { background: #f3f4f6; }
.scf-dlg__btn:disabled { opacity: 0.4; cursor: not-allowed; }
.scf-dlg__btn--primary { background: #2563eb; border-color: #2563eb; color: #fff; }
.scf-dlg__btn--primary:hover:not(:disabled) { background: #1d4ed8; }
.scf-dlg__btn--danger { color: #b91c1c; border-color: #fecaca; }
.scf-dlg__btn--danger:hover:not(:disabled) { background: #fef2f2; }
.scf-dlg__btn--ghost { border-color: transparent; }
.scf-dlg__footer { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 16px; border-top: 1px solid #eee; }
</style>
