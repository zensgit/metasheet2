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
    <div
      class="elearning-watch-challenge__grid"
      role="group"
      :aria-label="elearningLabel('learner.challengePrompt', isZh)"
    >
      <img
        class="elearning-watch-challenge__image"
        :src="challengeImageSrc"
        alt=""
        aria-hidden="true"
        draggable="false"
      >
      <button
        v-for="(option, index) in challenge.options"
        :key="option.optionId"
        type="button"
        class="elearning-watch-challenge__option"
        :class="{ 'elearning-watch-challenge__option--selected': selectionOrder(option.optionId) > 0 }"
        :data-selection-order="selectionOrder(option.optionId) || undefined"
        :style="optionStyle(option)"
        :aria-label="isZh ? `第 ${index + 1} 个位置` : `Position ${index + 1}`"
        :aria-pressed="selectionOrder(option.optionId) > 0"
        :disabled="busy || selectionOrder(option.optionId) > 0 || selections.length === 2"
        @click="selectOption(option.optionId)"
      >
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
const challengeImageSrc = computed(() => `data:image/png;base64,${props.challenge.imagePngBase64}`)

function refreshClock(): void {
  nowMs.value = Date.now()
}

function selectionOrder(optionId: string): number {
  const index = selections.value.indexOf(optionId)
  return index < 0 ? 0 : index + 1
}

function optionStyle(option: ElearningWatchChallenge['options'][number]): Record<string, string> {
  return {
    left: `${option.x / props.challenge.imageWidth * 100}%`,
    top: `${option.y / props.challenge.imageHeight * 100}%`,
    width: `${option.width / props.challenge.imageWidth * 100}%`,
    height: `${option.height / props.challenge.imageHeight * 100}%`,
  }
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

.elearning-watch-challenge__grid {
  position: relative;
  width: min(100%, 360px);
  aspect-ratio: 360 / 260;
  margin: 0 auto 1rem;
}

.elearning-watch-challenge__image {
  width: 100%;
  height: 100%;
  user-select: none;
}

.elearning-watch-challenge__option {
  position: absolute;
  border: 1px solid #cbd5e1;
  border-radius: 0.5rem;
  background: transparent;
  cursor: pointer;
}

.elearning-watch-challenge__option--selected {
  border: 3px solid #2563eb;
  background: rgb(219 234 254 / 35%);
}

.elearning-watch-challenge__option small {
  position: absolute;
  top: 0.2rem;
  right: 0.35rem;
  color: #1d4ed8;
  font-size: 0.75rem;
  font-weight: 700;
}

.elearning-watch-challenge__actions {
  display: flex;
  gap: 0.75rem;
  justify-content: flex-end;
}
</style>
