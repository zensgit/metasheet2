<template>
  <div class="event-node" :class="`event-${data.eventType}`">
    <Handle v-if="isStartEvent" type="source" :position="Position.Right" />
    <Handle v-else-if="isEndEvent" type="target" :position="Position.Left" />
    <template v-else>
      <Handle type="target" :position="Position.Left" />
      <Handle type="source" :position="Position.Right" />
    </template>
    
    <div class="event-circle" :style="{ backgroundColor: data.color }">
      <div class="event-icon">{{ getEventIcon() }}</div>
    </div>
    
    <div class="node-label">{{ data.label }}</div>
    <div v-if="data.eventType === 'timer' && data.timerExpression" class="event-meta">
      {{ data.timerExpression }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Handle, Position } from '@vue-flow/core'

const props = defineProps<{
  data: {
    label: string
    color?: string
    eventType: 'timer' | 'message' | 'signal' | 'error' | 'compensation' | 'start' | 'end'
    timerExpression?: string
  }
}>()

const isStartEvent = computed(() => props.data.eventType === 'start')
const isEndEvent = computed(() => props.data.eventType === 'end')

const getEventIcon = () => {
  const icons: Record<string, string> = {
    timer: '⏰',
    message: '✉️',
    signal: '📡',
    error: '⚠️',
    compensation: '↻',
    start: '▶',
    end: '■'
  }
  return icons[props.data.eventType] || '⚡'
}
</script>

<style scoped>
.event-node {
  position: relative;
  width: 60px;
  height: 60px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.event-circle {
  width: 50px;
  height: 50px;
  border-radius: 50%;
  background: #06b6d4;
  border: 2px solid #0891b2;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  transition: all 0.2s;
}

.event-node:hover .event-circle {
  transform: scale(1.1);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
}

.event-icon {
  font-size: 20px;
  color: white;
}

.node-label {
  position: absolute;
  bottom: -20px;
  font-size: 11px;
  font-weight: 600;
  color: #1f2937;
  white-space: nowrap;
}

.event-meta {
  position: absolute;
  top: -20px;
  font-size: 10px;
  color: #6b7280;
  background: white;
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid #e5e7eb;
  white-space: nowrap;
  font-family: monospace;
}

/* Event type specific styles */
.event-timer .event-circle {
  border-style: dashed;
}

.event-message .event-circle {
  background: #3b82f6;
  border-color: #2563eb;
}

.event-signal .event-circle {
  background: #f59e0b;
  border-color: #d97706;
}

.event-error .event-circle {
  background: #ef4444;
  border-color: #dc2626;
  border-width: 3px;
}

.event-compensation .event-circle {
  background: #8b5cf6;
  border-color: #7c3aed;
  border-style: double;
  border-width: 4px;
}
</style>