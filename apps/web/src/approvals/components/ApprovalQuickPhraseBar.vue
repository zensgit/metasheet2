<template>
  <div
    v-if="chips.length > 0 || canSave"
    class="approval-quick-phrase-bar"
    role="group"
    :aria-label="t.groupLabel"
    :data-testid="`${controlTestidPrefix}-bar`"
  >
    <template v-for="(chip, index) in chips" :key="`${chip.personal ? 'personal' : 'preset'}:${chip.text}`">
      <span v-if="chip.personal" class="approval-quick-phrase-bar__personal">
        <!-- A saved phrase can be up to MAX_PHRASE_LENGTH characters: the chip is capped to the
             bar's width and ends in an ellipsis; the title shows the whole phrase on hover.
             `effect="light"` sets saved phrases apart from the plain presets. -->
        <el-tag
          class="approval-quick-phrase-bar__chip"
          effect="light"
          :title="chip.text"
          :data-testid="`${chipTestidPrefix}-${index}`"
          @click="apply(chip.text)"
        >
          {{ chip.text }}
        </el-tag>
        <button
          type="button"
          class="approval-quick-phrase-bar__remove"
          :aria-label="t.remove"
          :data-testid="`${controlTestidPrefix}-remove-${index}`"
          @click="remove(chip.text)"
        >
          ×
        </button>
      </span>
      <el-tag
        v-else
        class="approval-quick-phrase-bar__chip"
        effect="plain"
        :data-testid="`${chipTestidPrefix}-${index}`"
        @click="apply(chip.text)"
      >
        {{ chip.text }}
      </el-tag>
    </template>
    <el-button
      v-if="canSave"
      class="approval-quick-phrase-bar__save"
      type="primary"
      link
      size="small"
      :title="t.saveHint"
      :disabled="!modelValue.trim()"
      :data-testid="`${controlTestidPrefix}-save`"
      @click="save"
    >
      {{ t.save }}
    </el-button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import {
  appendPhrase,
  isQuickPhraseAction,
  personalPhrasesRevision,
  quickPhraseChips,
  removePersonalPhrase,
  savePersonalPhrase,
  type QuickPhraseChip,
} from '../quickPhrases'
import { useLocale } from '../../composables/useLocale'
import { QUICK_PHRASE_BAR_EN, QUICK_PHRASE_BAR_ZH } from './quickPhraseLabels'

// The one quick-phrase bar every approval opinion box uses: the detail page's approve / reject and
// comment dialogs, and the approval center's side pane (approve) and row reject dialog. A chip only
// fills the bound opinion text (`v-model`), which stays editable; submitting is the host's own button.
// 「存为常用语」 saves the current text as the user's own phrase for this action; personal phrases
// come first and carry a remove control. Hosts keep their own submit path and required-opinion rules.
const props = withDefaults(defineProps<{
  modelValue: string
  action: string
  /** Signed-in user id; without one the bar still offers the presets but cannot save. */
  userId: string | null
  /**
   * Prefix of each chip's testid (`<prefix>-<index>`). Controls use a different prefix so a
   * `[data-testid^="<chip prefix>-"]` query only ever matches chips.
   */
  chipTestidPrefix?: string
  controlTestidPrefix?: string
}>(), {
  chipTestidPrefix: 'approval-quick-phrase',
  controlTestidPrefix: 'approval-phrase',
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

const { isZh } = useLocale()
const t = computed(() => (isZh.value ? QUICK_PHRASE_BAR_ZH : QUICK_PHRASE_BAR_EN))

const chips = computed<QuickPhraseChip[]>(() => {
  // Read so a save / remove in any other mounted bar re-renders this one.
  void personalPhrasesRevision.value
  return quickPhraseChips(props.userId, props.action)
})

const canSave = computed(() => !!props.userId && isQuickPhraseAction(props.action))

function apply(phrase: string): void {
  emit('update:modelValue', appendPhrase(props.modelValue, phrase))
}

function save(): void {
  const result = savePersonalPhrase(props.userId, props.action, props.modelValue)
  if (result === 'saved') ElMessage.success(t.value.saved)
  else if (result === 'duplicate') ElMessage.info(t.value.duplicate)
  else if (result === 'too_long') ElMessage.warning(t.value.tooLong)
  else if (result === 'full') ElMessage.warning(t.value.full)
  else if (result !== 'empty') ElMessage.error(t.value.failed)
}

function remove(phrase: string): void {
  removePersonalPhrase(props.userId, props.action, phrase)
}
</script>

<style scoped>
.approval-quick-phrase-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  margin-bottom: 8px;
}

/* el-tag is a single-line inline-flex box: cap each chip to the bar's width and cut long text
   with an ellipsis, so a long saved phrase cannot push the dialog or the side pane wider. */
.approval-quick-phrase-bar__chip {
  cursor: pointer;
  max-width: 100%;
  min-width: 0;
}

.approval-quick-phrase-bar__chip :deep(.el-tag__content) {
  min-width: 0;
  line-height: normal;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.approval-quick-phrase-bar__personal {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  min-width: 0;
}

.approval-quick-phrase-bar__remove {
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: var(--ms-text-2);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 2px 4px;
}

.approval-quick-phrase-bar__remove:hover {
  color: var(--ms-color-danger);
}
</style>
