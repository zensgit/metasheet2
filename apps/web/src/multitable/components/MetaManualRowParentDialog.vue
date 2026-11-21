<template>
  <Teleport to="body">
    <div v-if="visible" class="meta-manual-parent-overlay" @click.self="onCancel">
      <div class="meta-manual-parent-modal" role="dialog" aria-modal="true" :aria-label="l('parent.edit.title')" data-testid="manual-parent-dialog">
        <div class="meta-manual-parent__header">
          <strong>{{ l('parent.edit.title') }}</strong>
          <MtIconButton :aria-label="l('dialog.cancel')" data-action="manual-parent-dialog-close" @click="onCancel">&times;</MtIconButton>
        </div>

        <div class="meta-manual-parent__body">
          <div class="meta-manual-parent__current" data-testid="manual-parent-dialog-current">
            <span class="meta-manual-parent__label">{{ l('parent.edit.current') }}</span>
            <span v-if="current.code !== null">
              <span class="meta-manual-parent__code">{{ current.code }}</span> · {{ current.name ?? l('parent.noName') }}
            </span>
            <span v-else class="meta-manual-parent__muted">{{ l('parent.edit.currentNone') }}</span>
          </div>

          <div class="meta-manual-parent__modes" role="radiogroup" :aria-label="l('parent.edit.title')">
            <label v-for="entry in modes" :key="entry.value" class="meta-manual-parent__mode">
              <input
                v-model="mode"
                type="radio"
                :name="radioName"
                :value="entry.value"
                :data-manual-parent-mode="entry.value"
                :disabled="submitting || (entry.value === 'remove' && !hasCurrent)"
              />
              {{ l(entry.label) }}
            </label>
          </div>

          <MetaManualRowParentPicker
            v-if="mode === 'pick'"
            v-model="picked"
            :search="search"
            :own-code="ownCode"
            :disabled="submitting"
            :debounce-ms="debounceMs"
          />
          <template v-else-if="mode === 'new'">
            <label class="meta-manual-parent__row">
              <span class="meta-manual-parent__label">{{ l('parent.code') }}<span class="meta-manual-parent__required" aria-hidden="true"> *</span></span>
              <input v-model="newCode" class="meta-manual-parent__input" type="text" aria-required="true" data-testid="manual-parent-new-code" :disabled="submitting" />
            </label>
            <label class="meta-manual-parent__row">
              <span class="meta-manual-parent__label">{{ l('parent.name') }}<span class="meta-manual-parent__required" aria-hidden="true"> *</span></span>
              <input v-model="newName" class="meta-manual-parent__input" type="text" aria-required="true" data-testid="manual-parent-new-name" :disabled="submitting" />
            </label>
            <p class="meta-manual-parent__hint">{{ l('parent.newHint') }}</p>
          </template>
          <p v-else class="meta-manual-parent__hint">{{ l('parent.edit.removeHint') }}</p>

          <p class="meta-manual-parent__hint">{{ l('parent.edit.hint') }}</p>
          <div v-if="problem || error" class="meta-manual-parent__error" role="alert" data-testid="manual-parent-dialog-error">{{ problem || error }}</div>
        </div>

        <div class="meta-manual-parent__actions">
          <MtButton data-action="manual-parent-dialog-cancel" :disabled="submitting" @click="onCancel">{{ l('dialog.cancel') }}</MtButton>
          <MtButton variant="primary" data-action="manual-parent-dialog-submit" :disabled="submitting" @click="onSubmit">
            {{ submitting ? l('parent.edit.saving') : l('parent.edit.save') }}
          </MtButton>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
// 人工补充行的父组件 — the drawer's 「修改父组件」 (ADR adr-stock-prep-manual-rows-20261030 §12.2 「加错了能改」, slice
// P2): 改成已有的 (a candidate, exactly as returned) / 新建父组件 (both typed values required, trimmed) / 移出父组件 (both
// empty). It only collects the pair; the workbench sends BOTH columns to PATCH /records/:recordId/manual-fields with the
// row's version and refreshes the row. A name without a code and the row as its own parent are refused here; the
// server re-checks both (P4 / P5) and its message is shown as is (`error`). Not in the grid's undo history (§12.7 ④).
import { computed, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { MtButton, MtIconButton } from '../ui'
import { manualRowLabel, type ManualRowLabelKey } from '../utils/manual-row-labels'
import {
  manualRowParentProblem,
  manualRowParentValues,
  type ManualRowParentChoice,
  type ManualRowParentProblem,
} from '../utils/manual-rows'
import MetaManualRowParentPicker from './MetaManualRowParentPicker.vue'

type Mode = 'pick' | 'new' | 'remove'

const props = withDefaults(defineProps<{
  visible: boolean
  /** The row's parent as stored (display text; null = none). */
  current: { code: string | null; name: string | null }
  /** The row's own 图号: never offered, never accepted. */
  ownCode?: unknown
  search: (q: string) => Promise<unknown>
  submitting?: boolean
  error?: string | null
  debounceMs?: number
}>(), {
  submitting: false,
  error: null,
  debounceMs: 250,
})

const emit = defineEmits<{
  (e: 'submit', values: { code: string | null; name: string | null }): void
  (e: 'cancel'): void
}>()

const { isZh } = useLocale()
const l = (key: ManualRowLabelKey) => manualRowLabel(key, isZh.value)

const modes: ReadonlyArray<{ value: Mode; label: ManualRowLabelKey }> = [
  { value: 'pick', label: 'parent.edit.modePick' },
  { value: 'new', label: 'parent.edit.modeNew' },
  { value: 'remove', label: 'parent.edit.modeRemove' },
]
const radioName = `manual-parent-edit-${Math.random().toString(36).slice(2)}`
const mode = ref<Mode>('pick')
const picked = ref<{ code: string; name: string | null } | null>(null)
const newCode = ref('')
const newName = ref('')
const problem = ref<string | null>(null)
const hasCurrent = computed(() => props.current.code !== null || props.current.name !== null)

const PROBLEM_KEYS: Readonly<Record<ManualRowParentProblem, ManualRowLabelKey>> = {
  // 「改成已有的」 with nothing picked: 「请选一个」 — this dialog has no 「不挂父组件」 to point at.
  pick_required: 'parent.edit.pickRequired',
  code_required: 'parent.problem.codeRequired',
  name_required: 'parent.problem.nameRequired',
  name_without_code: 'parent.problem.nameWithoutCode',
  self_parent: 'parent.problem.selfParent',
}

watch(() => props.visible, (visible) => {
  if (!visible) return
  mode.value = 'pick'
  picked.value = null
  newCode.value = ''
  newName.value = ''
  problem.value = null
}, { immediate: true })
watch(mode, () => { problem.value = null })

function choice(): ManualRowParentChoice {
  if (mode.value === 'pick') return { mode: 'pick', option: picked.value }
  if (mode.value === 'new') return { mode: 'new', code: newCode.value, name: newName.value }
  return { mode: 'none' }
}

function onSubmit(): void {
  if (props.submitting) return
  const next = choice()
  const found = manualRowParentProblem(next, props.ownCode)
  problem.value = found ? l(PROBLEM_KEYS[found]) : null
  if (problem.value) return
  emit('submit', manualRowParentValues(next))
}

function onCancel(): void {
  if (props.submitting) return
  emit('cancel')
}
</script>

<style scoped>
.meta-manual-parent-overlay { position: fixed; inset: 0; z-index: 110; background: rgba(0, 0, 0, .3); display: flex; align-items: center; justify-content: center; }
.meta-manual-parent-modal { background: #fff; border-radius: 6px; width: min(420px, calc(100vw - 32px)); max-height: calc(100vh - 48px); box-shadow: 0 10px 40px rgba(0, 0, 0, .18); display: flex; flex-direction: column; }
.meta-manual-parent__header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #ebedf0; }
.meta-manual-parent__body { padding: 16px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
.meta-manual-parent__current { display: flex; gap: 10px; align-items: baseline; font-size: 13px; }
.meta-manual-parent__row { display: flex; flex-direction: column; gap: 4px; }
.meta-manual-parent__label { font-size: 12px; color: #606266; }
.meta-manual-parent__required { color: #f56c6c; }
.meta-manual-parent__muted { color: #909399; }
.meta-manual-parent__code { font-family: ui-monospace, Consolas, monospace; }
.meta-manual-parent__modes { display: flex; flex-wrap: wrap; gap: 14px; font-size: 13px; }
.meta-manual-parent__mode { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.meta-manual-parent__input { padding: 6px 8px; border: 1px solid #dcdfe6; border-radius: 4px; font-size: 14px; font-family: inherit; }
.meta-manual-parent__hint { color: #606266; font-size: 12px; margin: 0; }
.meta-manual-parent__error { color: #f56c6c; background: #fef0f0; padding: 8px 10px; border-radius: 4px; font-size: 13px; }
.meta-manual-parent__actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--ms-border-light, #ebedf0); }
</style>
