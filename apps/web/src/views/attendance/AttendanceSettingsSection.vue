<template>
  <div class="attendance__admin-section">
    <h4>{{ tr('Settings', '设置') }}</h4>
    <div class="attendance__admin-grid">
      <label class="attendance__field attendance__field--checkbox" for="attendance-auto-absence-enabled">
        <span>{{ tr('Auto absence', '自动缺勤') }}</span>
        <input
          id="attendance-auto-absence-enabled"
          v-model="settingsForm.autoAbsenceEnabled"
          name="autoAbsenceEnabled"
          type="checkbox"
        />
      </label>
      <label class="attendance__field" for="attendance-auto-absence-run-at">
        <span>{{ tr('Run at', '执行时间') }}</span>
        <input
          id="attendance-auto-absence-run-at"
          v-model="settingsForm.autoAbsenceRunAt"
          name="autoAbsenceRunAt"
          type="time"
        />
      </label>
      <label class="attendance__field" for="attendance-auto-absence-lookback">
        <span>{{ tr('Lookback days', '回溯天数') }}</span>
        <input
          id="attendance-auto-absence-lookback"
          v-model.number="settingsForm.autoAbsenceLookbackDays"
          name="autoAbsenceLookbackDays"
          type="number"
          min="1"
        />
      </label>
      <label class="attendance__field" for="attendance-min-punch-interval">
        <span>{{ tr('Min punch interval (min)', '最小打卡间隔（分钟）') }}</span>
        <input
          id="attendance-min-punch-interval"
          v-model.number="settingsForm.minPunchIntervalMinutes"
          name="minPunchIntervalMinutes"
          type="number"
          min="0"
        />
      </label>
      <label class="attendance__field attendance__field--full" for="attendance-ip-allowlist">
        <span>{{ tr('IP allowlist', 'IP 白名单') }}</span>
        <textarea
          id="attendance-ip-allowlist"
          v-model="settingsForm.ipAllowlist"
          name="ipAllowlist"
          rows="3"
          :placeholder="tr('One per line or comma separated', '每行一个或逗号分隔')"
        />
      </label>
      <label class="attendance__field" for="attendance-geo-lat">
        <span>{{ tr('Geo fence lat', '地理围栏纬度') }}</span>
        <input id="attendance-geo-lat" v-model="settingsForm.geoFenceLat" name="geoFenceLat" type="number" step="0.000001" />
      </label>
      <label class="attendance__field" for="attendance-geo-lng">
        <span>{{ tr('Geo fence lng', '地理围栏经度') }}</span>
        <input id="attendance-geo-lng" v-model="settingsForm.geoFenceLng" name="geoFenceLng" type="number" step="0.000001" />
      </label>
      <label class="attendance__field" for="attendance-geo-radius">
        <span>{{ tr('Geo fence radius (m)', '地理围栏半径（米）') }}</span>
        <input id="attendance-geo-radius" v-model="settingsForm.geoFenceRadius" name="geoFenceRadius" type="number" min="1" />
      </label>
    </div>
    <button class="attendance__btn attendance__btn--primary" :disabled="settingsLoading" @click="saveSettings">
      {{ settingsLoading ? tr('Saving...', '保存中...') : tr('Save settings', '保存设置') }}
    </button>
  </div>
</template>

<script setup lang="ts">
import type { Ref } from 'vue'

type Translate = (en: string, zh: string) => string
type MaybePromise<T> = T | Promise<T>

interface SettingsFormState {
  autoAbsenceEnabled: boolean
  autoAbsenceRunAt: string
  autoAbsenceLookbackDays: number
  ipAllowlist: string
  geoFenceLat: string
  geoFenceLng: string
  geoFenceRadius: string
  minPunchIntervalMinutes: number
}

interface SettingsBindings {
  saveSettings: () => MaybePromise<void>
  settingsForm: SettingsFormState
  settingsLoading: Ref<boolean>
}

const props = defineProps<{
  settings: SettingsBindings
  tr: Translate
}>()

const tr = props.tr
const settingsForm = props.settings.settingsForm
const settingsLoading = props.settings.settingsLoading
const saveSettings = () => props.settings.saveSettings()
</script>

<style scoped>
.attendance__admin-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 16px;
}

.attendance__admin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.attendance__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.attendance__field--full {
  grid-column: 1 / -1;
}

.attendance__field--checkbox {
  justify-content: flex-end;
}

.attendance__btn {
  padding: 8px 14px;
  border-radius: 6px;
  border: 1px solid #d0d0d0;
  background: #fff;
  cursor: pointer;
}

.attendance__btn--primary {
  background: #1976d2;
  border-color: #1976d2;
  color: #fff;
}

.attendance__btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
