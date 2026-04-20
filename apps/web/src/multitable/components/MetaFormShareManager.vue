<template>
  <div v-if="visible" class="meta-form-share__overlay" @click.self="$emit('close')">
    <div class="meta-form-share">
      <div class="meta-form-share__header">
        <h4 class="meta-form-share__title">Public Form Sharing</h4>
        <button class="meta-form-share__close" type="button" @click="$emit('close')">&times;</button>
      </div>

      <div class="meta-form-share__body">
        <div v-if="error" class="meta-form-share__error" role="alert">{{ error }}</div>
        <div v-if="loading" class="meta-form-share__empty">Loading share settings&#x2026;</div>

        <template v-else>
          <!-- Enable toggle -->
          <div class="meta-form-share__toggle-row">
            <label class="meta-form-share__toggle">
              <input
                type="checkbox"
                :checked="config?.enabled"
                data-form-share-toggle="true"
                @change="onToggleEnabled"
              />
              <span>{{ config?.enabled ? 'Sharing enabled' : 'Sharing disabled' }}</span>
            </label>
            <span
              class="meta-form-share__status"
              :data-status="config?.status ?? 'disabled'"
            >
              {{ statusLabel }}
            </span>
          </div>

          <!-- Link + actions (only when enabled) -->
          <template v-if="config?.enabled && config.publicToken">
            <div class="meta-form-share__auth-section">
              <label class="meta-form-share__label" for="meta-form-share-access-mode">Access mode</label>
              <select
                id="meta-form-share-access-mode"
                class="meta-form-share__input"
                :value="config.accessMode"
                data-form-share-access-mode="true"
                :disabled="busy"
                @change="onAccessModeChange"
              >
                <option value="public">Anyone with the link</option>
                <option value="dingtalk">Bound DingTalk users only</option>
                <option value="dingtalk_granted">DingTalk-authorized users only</option>
              </select>
              <p class="meta-form-share__hint">{{ accessModeHint }}</p>
            </div>

            <div class="meta-form-share__link-section">
              <label class="meta-form-share__label">Public link</label>
              <div class="meta-form-share__link-row">
                <input
                  class="meta-form-share__input"
                  type="text"
                  :value="publicLink"
                  readonly
                  data-form-share-link="true"
                />
                <button
                  class="meta-form-share__btn meta-form-share__btn--primary"
                  type="button"
                  data-form-share-copy="true"
                  @click="onCopyLink"
                >
                  {{ copied ? 'Copied!' : 'Copy' }}
                </button>
              </div>
            </div>

            <div class="meta-form-share__actions-row">
              <button
                class="meta-form-share__btn"
                type="button"
                data-form-share-regenerate="true"
                :disabled="busy"
                @click="onRegenerate"
              >
                Regenerate token
              </button>
              <button
                class="meta-form-share__btn"
                type="button"
                data-form-share-preview="true"
                @click="onPreview"
              >
                Preview
              </button>
            </div>

            <!-- Expiry -->
            <div class="meta-form-share__expiry-section">
              <label class="meta-form-share__label">Expiry</label>
              <div class="meta-form-share__expiry-row">
                <input
                  class="meta-form-share__input"
                  type="date"
                  :value="expiryDateValue"
                  data-form-share-expiry="true"
                  @change="onExpiryChange"
                />
                <button
                  v-if="config.expiresAt"
                  class="meta-form-share__btn"
                  type="button"
                  data-form-share-clear-expiry="true"
                  :disabled="busy"
                  @click="onClearExpiry"
                >
                  No expiry
                </button>
              </div>
            </div>
          </template>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { FormShareConfig } from '../types'
import type { MultitableApiClient } from '../api/client'

const props = defineProps<{
  sheetId: string
  viewId: string
  visible: boolean
  client?: MultitableApiClient
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'updated'): void
}>()

const config = ref<FormShareConfig | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const busy = ref(false)
const copied = ref(false)

const statusLabel = computed(() => {
  if (!config.value) return 'Disabled'
  switch (config.value.status) {
    case 'active': return 'Active'
    case 'expired': return 'Expired'
    case 'disabled': return 'Disabled'
    default: return 'Disabled'
  }
})

const publicLink = computed(() => {
  if (!config.value?.publicToken) return ''
  return `${window.location.origin}/multitable/public-form/${props.sheetId}/${props.viewId}?publicToken=${config.value.publicToken}`
})

const expiryDateValue = computed(() => {
  if (!config.value?.expiresAt) return ''
  return config.value.expiresAt.substring(0, 10)
})
const accessModeHint = computed(() => {
  switch (config.value?.accessMode) {
    case 'dingtalk':
      return 'The form opens only after DingTalk sign-in, and the user must already be bound to a local account.'
    case 'dingtalk_granted':
      return 'The form opens only for DingTalk-bound users whose DingTalk grant is enabled by an administrator.'
    default:
      return 'Anyone who has the link can open and submit this form.'
  }
})

async function loadConfig() {
  if (!props.client) return
  loading.value = true
  error.value = null
  try {
    config.value = await props.client.getFormShareConfig(props.sheetId, props.viewId)
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load share config'
  } finally {
    loading.value = false
  }
}

async function onToggleEnabled() {
  if (!props.client || busy.value) return
  busy.value = true
  error.value = null
  try {
    config.value = await props.client.updateFormShareConfig(props.sheetId, props.viewId, {
      enabled: !config.value?.enabled,
    })
    emit('updated')
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to update'
  } finally {
    busy.value = false
  }
}

async function onAccessModeChange(event: Event) {
  if (!props.client || busy.value) return
  const select = event.target as HTMLSelectElement | null
  if (!select) return
  busy.value = true
  error.value = null
  try {
    config.value = await props.client.updateFormShareConfig(props.sheetId, props.viewId, {
      accessMode: select.value as FormShareConfig['accessMode'],
    })
    emit('updated')
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to update access mode'
  } finally {
    busy.value = false
  }
}

async function onRegenerate() {
  if (!props.client || busy.value) return
  busy.value = true
  error.value = null
  try {
    const result = await props.client.regenerateFormShareToken(props.sheetId, props.viewId)
    if (config.value) {
      config.value = { ...config.value, publicToken: result.publicToken }
    }
    emit('updated')
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to regenerate token'
  } finally {
    busy.value = false
  }
}

function onCopyLink() {
  if (!publicLink.value) return
  void navigator.clipboard.writeText(publicLink.value)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}

function onPreview() {
  if (!publicLink.value) return
  window.open(publicLink.value, '_blank')
}

async function onExpiryChange(event: Event) {
  if (!props.client || busy.value) return
  const input = event.target as HTMLInputElement
  const dateStr = input.value
  if (!dateStr) return
  busy.value = true
  error.value = null
  try {
    config.value = await props.client.updateFormShareConfig(props.sheetId, props.viewId, {
      expiresAt: new Date(dateStr).toISOString(),
    })
    emit('updated')
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to update expiry'
  } finally {
    busy.value = false
  }
}

async function onClearExpiry() {
  if (!props.client || busy.value) return
  busy.value = true
  error.value = null
  try {
    config.value = await props.client.updateFormShareConfig(props.sheetId, props.viewId, {
      expiresAt: null,
    })
    emit('updated')
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to clear expiry'
  } finally {
    busy.value = false
  }
}

watch(
  () => props.visible,
  (v) => {
    if (v && props.sheetId && props.viewId) {
      void loadConfig()
    }
  },
  { immediate: true },
)
</script>

<style scoped>
.meta-form-share__overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
}

.meta-form-share {
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
  width: 520px;
  max-width: 95vw;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
}

.meta-form-share__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 20px 12px;
  border-bottom: 1px solid #e2e8f0;
}

.meta-form-share__title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #0f172a;
}

.meta-form-share__close {
  border: none;
  background: none;
  font-size: 22px;
  cursor: pointer;
  color: #64748b;
  line-height: 1;
  padding: 0 4px;
}

.meta-form-share__body {
  padding: 16px 20px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.meta-form-share__error {
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
  background: #fef2f2;
  color: #b91c1c;
}

.meta-form-share__empty {
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
  background: #f8fafc;
  color: #64748b;
}

.meta-form-share__toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.meta-form-share__toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: #0f172a;
  cursor: pointer;
}

.meta-form-share__status {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 10px;
  border-radius: 999px;
}

.meta-form-share__status[data-status="active"] {
  background: #ecfdf5;
  color: #166534;
}

.meta-form-share__status[data-status="expired"] {
  background: #fef3c7;
  color: #92400e;
}

.meta-form-share__status[data-status="disabled"] {
  background: #f1f5f9;
  color: #64748b;
}

.meta-form-share__label {
  font-size: 12px;
  font-weight: 600;
  color: #475569;
}

.meta-form-share__auth-section,
.meta-form-share__link-section,
.meta-form-share__expiry-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.meta-form-share__link-row,
.meta-form-share__expiry-row {
  display: flex;
  gap: 8px;
}

.meta-form-share__input {
  flex: 1;
  min-width: 0;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 13px;
  background: #fff;
  box-sizing: border-box;
}

.meta-form-share__actions-row {
  display: flex;
  gap: 8px;
}

.meta-form-share__btn {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 6px 14px;
  background: #fff;
  color: #0f172a;
  font-size: 13px;
  cursor: pointer;
}

.meta-form-share__btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.meta-form-share__btn--primary {
  border-color: #2563eb;
  background: #2563eb;
  color: #fff;
}

.meta-form-share__hint {
  margin: 0;
  font-size: 12px;
  color: #64748b;
  line-height: 1.5;
}
</style>
