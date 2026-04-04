<template>
  <span
    class="meta-comment-affordance"
    :class="rootClass"
    :data-comment-affordance-state="stateName"
  >
    <span
      v-if="state.unresolvedCount > 0"
      class="meta-comment-affordance__badge meta-comment-affordance__badge--unresolved"
      data-comment-affordance-badge="unresolved"
    >
      {{ state.unresolvedCount }}
    </span>
    <span
      v-if="state.mentionCount > 0"
      class="meta-comment-affordance__badge meta-comment-affordance__badge--mention"
      data-comment-affordance-badge="mention"
    >@{{ state.mentionCount }}</span>
    <span
      v-if="state.showIcon"
      class="meta-comment-affordance__icon"
      data-comment-affordance-icon="true"
    >
      &#x1F4AC;
    </span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  resolveCommentAffordanceStateClass,
  resolveCommentAffordanceStateName,
  type CommentAffordanceState,
} from '../utils/comment-affordance'

const props = defineProps<{
  state: CommentAffordanceState
}>()

const stateName = computed(() => resolveCommentAffordanceStateName(props.state))
const rootClass = computed(() => resolveCommentAffordanceStateClass('meta-comment-affordance', props.state))
</script>

<style scoped>
.meta-comment-affordance {
  display: inline-flex;
  align-items: center;
  gap: var(--meta-comment-affordance-gap, 2px);
  line-height: 1;
}

.meta-comment-affordance__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: var(--meta-comment-affordance-badge-min-width, 16px);
  height: var(--meta-comment-affordance-badge-height, 16px);
  padding: 0 var(--meta-comment-affordance-badge-padding-x, 4px);
  border-radius: 999px;
  font-size: var(--meta-comment-affordance-badge-font-size, 10px);
  font-weight: 600;
  line-height: 1;
}

.meta-comment-affordance__badge--unresolved {
  background: #dbeafe;
  color: #1d4ed8;
}

.meta-comment-affordance__badge--mention {
  background: #fef3c7;
  color: #b45309;
}

.meta-comment-affordance__icon {
  font-size: var(--meta-comment-affordance-icon-size, 11px);
  line-height: 1;
}

.meta-comment-affordance--active,
.meta-comment-affordance--idle {
  opacity: 1;
}
</style>
