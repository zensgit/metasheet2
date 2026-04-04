<template>
  <span
    class="meta-comment-action-chip"
    :class="rootClass"
    :data-comment-chip-state="stateName"
  >
    <span v-if="label" class="meta-comment-action-chip__label">{{ label }}</span>
    <MetaCommentAffordance :state="state" />
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import MetaCommentAffordance from './MetaCommentAffordance.vue'
import {
  resolveCommentAffordanceStateClass,
  resolveCommentAffordanceStateName,
  type CommentAffordanceState,
} from '../utils/comment-affordance'

const props = defineProps<{
  state: CommentAffordanceState
  label?: string | null
}>()

const stateName = computed(() => resolveCommentAffordanceStateName(props.state))
const rootClass = computed(() => resolveCommentAffordanceStateClass('meta-comment-action-chip', props.state))
</script>

<style scoped>
.meta-comment-action-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  line-height: 1;
}

.meta-comment-action-chip__label {
  font-size: inherit;
  line-height: inherit;
  white-space: nowrap;
}

.meta-comment-action-chip--active,
.meta-comment-action-chip--idle {
  opacity: 1;
}
</style>
