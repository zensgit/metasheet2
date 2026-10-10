<!--
  Dedicated employee 换班申请 card.

  Display / form-UX only. Writes the same `requestForm` assignment ids and
  reason AttendanceView already submits through
  POST /api/attendance/shift-swap-requests. Fields match the shared swap
  path (my published shift, coworker published shift, optional reason).
  Sister dedicated cards are mutually exclusive. First viewport is untouched.
-->
<template>
  <section
    class="shift-swap-card"
    data-attendance-shift-swap-request-card
    aria-labelledby="attendance-shift-swap-card-title"
  >
    <header class="shift-swap-card__header">
      <h3 id="attendance-shift-swap-card-title">{{ tr('Shift-swap request', '换班申请') }}</h3>
      <button
        class="shift-swap-card__text-btn"
        type="button"
        data-shift-swap-card-cancel="header"
        @click="emit('cancel')"
      >
        {{ tr('Cancel', '取消') }}
      </button>
    </header>

    <label class="shift-swap-card__field" for="attendance-shift-swap-card-requester">
      <span>{{ tr('My published shift', '我的已发布班次') }}</span>
      <select
        id="attendance-shift-swap-card-requester"
        name="shiftSwapCardRequesterAssignment"
        v-model="requestForm.requesterAssignmentId"
        :disabled="requesterAssignments.length === 0"
        data-shift-swap-card-requester
      >
        <option value="" disabled>{{ tr('Select your shift', '选择我的班次') }}</option>
        <option v-for="item in requesterAssignments" :key="item.id" :value="item.id">
          {{ item.label }}
        </option>
      </select>
    </label>

    <label class="shift-swap-card__field" for="attendance-shift-swap-card-counterparty">
      <span>{{ tr('Coworker published shift', '对方已发布班次') }}</span>
      <select
        id="attendance-shift-swap-card-counterparty"
        name="shiftSwapCardCounterpartyAssignment"
        v-model="requestForm.counterpartyAssignmentId"
        :disabled="counterpartyAssignments.length === 0"
        data-shift-swap-card-counterparty
      >
        <option value="" disabled>{{ tr('Select coworker shift', '选择对方班次') }}</option>
        <option v-for="item in counterpartyAssignments" :key="item.id" :value="item.id">
          {{ item.label }}
        </option>
      </select>
    </label>

    <p class="shift-swap-card__hint" data-shift-swap-card-hint>
      {{
        hasPublishedAssignments
          ? tr(
            'Only published single-day regular assignments can be submitted for this first shift-swap slice.',
            '首版换班仅支持已发布的单日常规排班。',
          )
          : tr(
            'No published single-day regular assignments are available for shift swap yet.',
            '当前没有可用于换班的已发布单日常规排班。',
          )
      }}
    </p>

    <label class="shift-swap-card__field" for="attendance-shift-swap-card-reason">
      <span>{{ tr('Reason', '原因') }}</span>
      <input
        id="attendance-shift-swap-card-reason"
        name="shiftSwapCardReason"
        v-model="requestForm.reason"
        type="text"
        data-shift-swap-card-reason
        :placeholder="tr('Optional', '可选')"
      />
    </label>

    <footer class="shift-swap-card__footer">
      <button
        class="shift-swap-card__btn"
        type="button"
        data-shift-swap-card-cancel="footer"
        @click="emit('cancel')"
      >
        {{ tr('Cancel', '取消') }}
      </button>
      <button
        class="shift-swap-card__btn shift-swap-card__btn--primary"
        type="button"
        data-shift-swap-card-submit
        :disabled="submitting"
        @click="emit('submit')"
      >
        {{ submitting ? tr('Submitting...', '提交中...') : tr('Submit request', '提交申请') }}
      </button>
    </footer>
  </section>
</template>

<script setup lang="ts">
type TranslateFn = (en: string, zh: string) => string

interface ShiftSwapAssignmentOption {
  id: string
  label: string
}

interface ShiftSwapRequestFormFields {
  requesterAssignmentId: string
  counterpartyAssignmentId: string
  reason: string
}

defineProps<{
  tr: TranslateFn
  requestForm: ShiftSwapRequestFormFields
  requesterAssignments: ShiftSwapAssignmentOption[]
  counterpartyAssignments: ShiftSwapAssignmentOption[]
  hasPublishedAssignments: boolean
  submitting: boolean
}>()

const emit = defineEmits<{
  cancel: []
  submit: []
}>()
</script>

<style scoped>
.shift-swap-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  padding: 16px 18px;
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-lg);
  background: var(--ms-bg-card);
  box-shadow: var(--ms-shadow-card);
}

.shift-swap-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.shift-swap-card__header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: var(--ms-font-weight-title);
  color: var(--ms-text-1);
}

.shift-swap-card__text-btn {
  padding: 0;
  border: none;
  background: none;
  color: var(--ms-text-3);
  font-size: 13px;
  cursor: pointer;
}

.shift-swap-card__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
  color: var(--ms-text-2);
}

.shift-swap-card__field select,
.shift-swap-card__field input {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-md);
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  font-size: 14px;
}

.shift-swap-card__hint {
  margin: 0;
  color: var(--ms-text-3);
  font-size: 12px;
  line-height: 1.4;
}

.shift-swap-card__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.shift-swap-card__btn {
  padding: 8px 14px;
  border: none;
  border-radius: var(--ms-radius-md);
  background: var(--ms-bg-page);
  color: var(--ms-text-1);
  font-size: 13px;
  cursor: pointer;
}

.shift-swap-card__btn--primary {
  background: var(--ms-color-primary);
  color: #fff;
}

.shift-swap-card__btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
