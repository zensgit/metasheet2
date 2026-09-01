<template>
  <section
    class="elearning-watch-challenge"
    data-testid="elearning-watch-challenge"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="elearning-watch-challenge-title"
  >
    <h3 id="elearning-watch-challenge-title">
      {{ elearningLabel('learner.challengeTitle', isZh) }}
    </h3>
    <p data-testid="elearning-watch-challenge-message">
      {{ timedOut
        ? elearningLabel('learner.challengePaused', isZh)
        : elearningLabel('learner.challengePrompt', isZh) }}
    </p>
    <p
      v-if="!timedOut"
      class="elearning-watch-challenge__countdown"
      data-testid="elearning-watch-challenge-countdown"
      aria-live="polite"
    >
      {{ elearningChallengeCountdown(remainingMs, isZh) }}
    </p>
    <p class="elearning-watch-challenge__targets" data-testid="elearning-watch-challenge-targets">
      <strong>1. {{ challenge.targets[0] }}</strong>
      <span aria-hidden="true">→</span>
      <strong>2. {{ challenge.targets[1] }}</strong>
    </p>
    <div
      class="elearning-watch-challenge__grid"
      role="group"
      :aria-label="elearningLabel('learner.challengePrompt', isZh)"
    >
      <button
        v-for="option in challenge.options"
        :key="option.optionId"
        type="button"
        class="elearning-watch-challenge__option"
        :class="{ 'elearning-watch-challenge__option--selected': selectionOrder(option.optionId) > 0 }"
        :data-option-id="option.optionId"
        :data-selection-order="selectionOrder(option.optionId) || undefined"
        :aria-pressed="selectionOrder(option.optionId) > 0"
        :disabled="busy || selectionOrder(option.optionId) > 0 || selections.length === 2"
        @click="selectOption(option.optionId)"
      >
        <span>{{ option.label }}</span>
        <small v-if="selectionOrder(option.optionId) > 0">
          {{ selectionOrder(option.optionId) }}
        </small>
      </button>
    </div>
    <div class="elearning-watch-challenge__actions">
      <button
        type="button"
        class="elearning-btn elearning-btn--secondary"
        data-testid="elearning-watch-challenge-reset"
        :disabled="busy || selections.length === 0"
        @click="selections = []"
      >
        {{ elearningLabel('learner.challengeReset', isZh) }}
      </button>
      <button
        type="button"
        class="elearning-btn elearning-btn--primary"
        data-testid="elearning-watch-challenge-confirm"
        :disabled="busy || selections.length !== 2"
        @click="submit"
      >
        {{ busy
          ? elearningLabel('learner.challengeConfirming', isZh)
          : timedOut
            ? elearningLabel('learner.challengeResume', isZh)
            : elearningLabel('learner.challengeConfirm', isZh) }}
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useLocale } from '../composables/useLocale'
import type { ElearningWatchChallenge } from '../services/elearning'
import { elearningChallengeCountdown, elearningLabel } from './elearningLabels'

const props = defineProps<{
  challenge: ElearningWatchChallenge
  busy: boolean
}>()

const emit = defineEmits<{
  confirm: [selections: [string, string]]
}>()

const { isZh } = useLocale()
const nowMs = ref(Date.now())
const selections = ref<string[]>([])
let timer: number | null = null

const remainingMs = computed(() => Math.max(0, Date.parse(props.challenge.deadlineAt) - nowMs.value))
const timedOut = computed(() => props.challenge.status === 'paused' || remainingMs.value === 0)

function refreshClock(): void {
  nowMs.value = Date.now()
}

function selectionOrder(optionId: string): number {
  const index = selections.value.indexOf(optionId)
  return index < 0 ? 0 : index + 1
}

function selectOption(optionId: string): void {
  if (props.busy || selections.value.length === 2 || selections.value.includes(optionId)) return
  selections.value = [...selections.value, optionId]
}

function submit(): void {
  if (props.busy || selections.value.length !== 2) return
  emit('confirm', [selections.value[0]!, selections.value[1]!])
}

watch(
  () => [props.challenge.challengeId, props.challenge.deadlineAt, props.challenge.status],
  () => {
    selections.value = []
    refreshClock()
  },
)

onMounted(() => {
  refreshClock()
  timer = window.setInterval(refreshClock, 250)
})

onUnmounted(() => {
  if (timer !== null) window.clearInterval(timer)
})
</script>

<style scoped>
.elearning-watch-challenge {
  position: fixed;
  z-index: 40;
  inset: 50% auto auto 50%;
  width: min(30rem, calc(100vw - 2rem));
  transform: translate(-50%, -50%);
  padding: 1.25rem;
  border: 1px solid #f59e0b;
  border-radius: 0.75rem;
  background: #fff;
  box-shadow: 0 1.25rem 3rem rgb(15 23 42 / 24%);
}

.elearning-watch-challenge h3 {
  margin: 0 0 0.75rem;
}

.elearning-watch-challenge p {
  margin: 0 0 1rem;
}

.elearning-watch-challenge__countdown {
  font-weight: 700;
  color: #b45309;
}

.elearning-watch-challenge__targets {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  justify-content: center;
  font-size: 1.2rem;
}

.elearning-watch-challenge__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.elearning-watch-challenge__option {
  min-height: 3.5rem;
  border: 1px solid #cbd5e1;
  border-radius: 0.5rem;
  background: #fff;
  font-size: 1.25rem;
  cursor: pointer;
}

.elearning-watch-challenge__option--selected {
  border-color: #2563eb;
  background: #dbeafe;
}

.elearning-watch-challenge__option small {
  display: block;
  color: #1d4ed8;
}

.elearning-watch-challenge__actions {
  display: flex;
  gap: 0.75rem;
  justify-content: flex-end;
}
</style>
