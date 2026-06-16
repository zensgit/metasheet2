<template>
  <div class="meta-comment-reactions" data-test="comment-reactions">
    <button
      v-for="r in reactions"
      :key="r.emoji"
      type="button"
      class="meta-comment-reactions__chip"
      :class="{ 'meta-comment-reactions__chip--mine': r.reactedByMe }"
      :data-test="`reaction-chip-${r.emoji}`"
      :data-reacted="r.reactedByMe ? 'true' : 'false'"
      :disabled="disabled || !canReact || isPending(r.emoji)"
      :aria-pressed="r.reactedByMe ? 'true' : 'false'"
      @click="toggle(r.emoji, r.reactedByMe)"
    >
      <span class="meta-comment-reactions__emoji">{{ r.emoji }}</span>
      <span class="meta-comment-reactions__count">{{ r.count }}</span>
    </button>

    <div v-if="canReact" class="meta-comment-reactions__picker">
      <button
        type="button"
        class="meta-comment-reactions__add"
        data-test="reaction-add"
        :title="addLabel"
        :aria-label="addLabel"
        :aria-expanded="pickerOpen ? 'true' : 'false'"
        :disabled="disabled"
        @click="pickerOpen = !pickerOpen"
      >☺＋</button>
      <div v-if="pickerOpen" class="meta-comment-reactions__palette" role="menu" data-test="reaction-palette">
        <button
          v-for="emoji in palette"
          :key="emoji"
          type="button"
          class="meta-comment-reactions__palette-item"
          :data-test="`reaction-pick-${emoji}`"
          :disabled="isPending(emoji)"
          role="menuitem"
          @click="pick(emoji)"
        >{{ emoji }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { COMMENT_REACTION_PALETTE, type MultitableCommentReaction } from '../types'

const props = withDefaults(defineProps<{
  commentId: string
  reactions?: MultitableCommentReaction[]
  addLabel?: string
  disabled?: boolean
  /** Whether the viewer may add/toggle reactions. Counts are shown to everyone
   *  who can see the comment; only commenters get the picker + clickable chips. */
  canReact?: boolean
  /** in-flight toggle keys `${commentId}:${emoji}` (from the composable). */
  pendingKeys?: string[]
  palette?: string[]
}>(), {
  reactions: () => [],
  addLabel: 'Add reaction',
  disabled: false,
  canReact: true,
  pendingKeys: () => [],
  palette: () => COMMENT_REACTION_PALETTE,
})

const emit = defineEmits<{
  (e: 'react', commentId: string, emoji: string): void
  (e: 'unreact', commentId: string, emoji: string): void
}>()

const pickerOpen = ref(false)

function isPending(emoji: string): boolean {
  return props.pendingKeys.includes(`${props.commentId}:${emoji}`)
}

function toggle(emoji: string, reactedByMe: boolean) {
  if (reactedByMe) emit('unreact', props.commentId, emoji)
  else emit('react', props.commentId, emoji)
}

function pick(emoji: string) {
  pickerOpen.value = false
  // Picking an emoji the user already reacted with is a server/composable no-op.
  emit('react', props.commentId, emoji)
}
</script>

<style scoped>
.meta-comment-reactions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
}
.meta-comment-reactions__chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 7px;
  font-size: 12px;
  line-height: 18px;
  border: 1px solid var(--border-color, #e0e0e0);
  border-radius: 10px;
  background: var(--surface-2, #f5f5f5);
  cursor: pointer;
}
.meta-comment-reactions__chip--mine {
  border-color: var(--primary-color, #2196f3);
  background: var(--primary-bg, #e3f2fd);
}
.meta-comment-reactions__chip:disabled { opacity: 0.6; cursor: default; }
.meta-comment-reactions__count { color: var(--text-secondary, #666); }
.meta-comment-reactions__picker { position: relative; display: inline-flex; }
.meta-comment-reactions__add {
  font-size: 12px;
  line-height: 18px;
  padding: 1px 6px;
  border: 1px solid var(--border-color, #e0e0e0);
  border-radius: 10px;
  background: transparent;
  cursor: pointer;
  color: var(--text-secondary, #666);
}
.meta-comment-reactions__palette {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  display: flex;
  gap: 2px;
  padding: 4px;
  background: var(--surface-1, #fff);
  border: 1px solid var(--border-color, #e0e0e0);
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  z-index: 10;
}
.meta-comment-reactions__palette-item {
  font-size: 16px;
  padding: 2px 4px;
  border: none;
  background: transparent;
  cursor: pointer;
  border-radius: 4px;
}
.meta-comment-reactions__palette-item:hover { background: var(--surface-2, #f0f0f0); }
</style>
