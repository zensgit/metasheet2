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
      {{ challenge.status === 'paused'
        ? elearningLabel('learner.challengePaused', isZh)
        : elearningLabel('learner.challengePrompt', isZh) }}
    </p>
    <p
      v-if="challenge.status === 'challenged'"
      class="elearning-watch-challenge__countdown"
      data-testid="elearning-watch-challenge-countdown"
      aria-live="polite"
    >
      {{ elearningChallengeCountdown(remainingMs, isZh) }}
    </p>
    <button
      type="button"
      class="elearning-btn elearning-btn--primary"
      data-testid="elearning-watch-challenge-confirm"
      :disabled="busy"
      @click="emit('confirm')"
    >
      {{ busy
        ? elearningLabel('learner.challengeConfirming', isZh)
        : challenge.status === 'paused'
          ? elearningLabel('learner.challengeResume', isZh)
          : elearningLabel('learner.challengeConfirm', isZh) }}
    </button>
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
  confirm: []
}>()

const { isZh } = useLocale()
const nowMs = ref(Date.now())
let timer: number | null = null

const remainingMs = computed(() => Math.max(0, Date.parse(props.challenge.deadlineAt) - nowMs.value))

function refreshClock(): void {
  nowMs.value = Date.now()
}

watch(
  () => [props.challenge.challengeId, props.challenge.deadlineAt, props.challenge.status],
  refreshClock,
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
</style>
