<template>
  <div class="meta-comment-composer">
    <div v-if="selectedMentions.length" class="meta-comment-composer__mentions">
      <button
        v-for="mention in selectedMentions"
        :key="mention.id"
        class="meta-comment-composer__mention-chip"
        type="button"
        :disabled="disabled || submitting"
        @click="removeMention(mention.id)"
      >
        <span>@{{ mention.label }}</span>
        <span aria-hidden="true">&times;</span>
      </button>
    </div>
    <div class="meta-comment-composer__input-shell">
      <textarea
        ref="textareaRef"
        :value="modelValue"
        class="meta-comment-composer__textarea"
        :placeholder="placeholder"
        rows="2"
        :disabled="disabled || submitting"
        @input="onInput"
        @keydown.enter.ctrl.prevent="submit"
        @keydown.enter.meta.prevent="submit"
      />
      <div
        v-if="showSuggestions"
        class="meta-comment-composer__suggestions"
        role="listbox"
        aria-label="Comment mention suggestions"
      >
        <button
          v-for="suggestion in filteredSuggestions"
          :key="suggestion.id"
          class="meta-comment-composer__suggestion"
          type="button"
          @click="selectSuggestion(suggestion)"
        >
          <strong>@{{ suggestion.label }}</strong>
          <small v-if="suggestion.subtitle">{{ suggestion.subtitle }}</small>
        </button>
      </div>
    </div>
    <div class="meta-comment-composer__footer">
      <span class="meta-comment-composer__hint">Ctrl/Cmd + Enter to send</span>
      <button class="meta-comment-composer__submit" :disabled="submitting || disabled || !modelValue.trim()" type="button" @click="submit">
        {{ submitting ? 'Sending...' : 'Send' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { MetaCommentMentionSuggestion } from '../types'

const props = withDefaults(defineProps<{
  modelValue: string
  suggestions?: MetaCommentMentionSuggestion[]
  submitting?: boolean
  disabled?: boolean
  placeholder?: string
}>(), {
  suggestions: () => [],
  submitting: false,
  disabled: false,
  placeholder: 'Add a comment...',
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'submit', payload: { content: string; mentions: string[] }): void
}>()

const textareaRef = ref<HTMLTextAreaElement | null>(null)
const selectedMentions = ref<MetaCommentMentionSuggestion[]>([])
const mentionMatch = computed(() => props.modelValue.match(/(?:^|\s)@([^\s@]*)$/))
const mentionQuery = computed(() => mentionMatch.value?.[1] ?? '')

const filteredSuggestions = computed(() => {
  const query = mentionQuery.value.trim().toLowerCase()
  const available = props.suggestions.filter((suggestion) => !selectedMentions.value.some((item) => item.id === suggestion.id))
  if (!query) return available.slice(0, 6)
  return available.filter((suggestion) => {
    return suggestion.label.toLowerCase().includes(query) || suggestion.id.toLowerCase().includes(query)
  }).slice(0, 6)
})

const showSuggestions = computed(() => {
  if (!props.modelValue.trim()) return false
  if (props.disabled || props.submitting) return false
  return Boolean(mentionMatch.value) && filteredSuggestions.value.length > 0
})

function onInput(event: Event) {
  const value = (event.target as HTMLTextAreaElement).value
  emit('update:modelValue', value)
}

function removeMention(id: string) {
  selectedMentions.value = selectedMentions.value.filter((item) => item.id !== id)
}

function selectSuggestion(suggestion: MetaCommentMentionSuggestion) {
  const nextValue = props.modelValue.replace(/(?:^|\s)@([^\s@]*)$/, (match) => {
    const prefix = match.startsWith(' ') ? ' ' : ''
    return `${prefix}@${suggestion.label} `
  })
  selectedMentions.value = [...selectedMentions.value, suggestion]
  emit('update:modelValue', nextValue)
  void nextTick(() => {
    textareaRef.value?.focus()
    const caret = nextValue.length
    textareaRef.value?.setSelectionRange(caret, caret)
  })
}

function submit() {
  const content = props.modelValue.trim()
  if (!content || props.disabled || props.submitting) return
  emit('submit', {
    content,
    mentions: selectedMentions.value.map((item) => item.id),
  })
}
</script>

<style scoped>
.meta-comment-composer { display: flex; flex-direction: column; gap: 8px; }
.meta-comment-composer__mentions { display: flex; flex-wrap: wrap; gap: 6px; }
.meta-comment-composer__mention-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid #bfdbfe;
  background: #eff6ff;
  color: #1d4ed8;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}
.meta-comment-composer__input-shell { position: relative; }
.meta-comment-composer__textarea {
  width: 100%;
  min-height: 58px;
  padding: 8px 10px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  font-size: 13px;
  resize: vertical;
}
.meta-comment-composer__suggestions {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 6px);
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12);
  padding: 6px;
  z-index: 10;
}
.meta-comment-composer__suggestion {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  border: none;
  background: transparent;
  border-radius: 6px;
  padding: 8px 10px;
  cursor: pointer;
}
.meta-comment-composer__suggestion:hover { background: #f8fafc; }
.meta-comment-composer__suggestion small { color: #64748b; }
.meta-comment-composer__footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.meta-comment-composer__hint { color: #6b7280; font-size: 12px; }
.meta-comment-composer__submit {
  padding: 6px 14px;
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}
.meta-comment-composer__submit:disabled,
.meta-comment-composer__mention-chip:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
