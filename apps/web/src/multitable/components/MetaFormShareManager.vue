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
              <div
                class="meta-form-share__audience-card"
                data-form-share-audience-rule="true"
                :data-access-mode="config.accessMode"
                :data-has-local-allowlist="hasLocalAllowlist ? 'true' : 'false'"
              >
                <strong>{{ audienceRule.title }}</strong>
                <span>{{ audienceRule.description }}</span>
              </div>
            </div>

            <div v-if="showAllowlistSection" class="meta-form-share__allowlist-section">
              <div class="meta-form-share__allowlist-header">
                <div>
                  <label class="meta-form-share__label" for="meta-form-share-allowlist-search">Allowed system users and member groups</label>
                  <p class="meta-form-share__hint">
                    DingTalk is only the sign-in and delivery channel. The allowlist still targets your local users and member groups.
                  </p>
                  <p
                    class="meta-form-share__allowlist-summary"
                    data-form-share-allowlist-summary="true"
                    :data-user-count="allowedUserCount"
                    :data-member-group-count="allowedMemberGroupCount"
                  >
                    {{ allowlistAudienceSummary }}
                  </p>
                </div>
              </div>

              <input
                id="meta-form-share-allowlist-search"
                v-model.trim="candidateQuery"
                class="meta-form-share__input"
                type="search"
                placeholder="Search local users or member groups"
                data-form-share-allowlist-search="true"
                :disabled="busy"
              />

              <div class="meta-form-share__allowlist-subsection">
                <label class="meta-form-share__label">Allowed users</label>
                <div v-if="allowedUsers.length > 0" class="meta-form-share__chip-list">
                  <span
                    v-for="user in allowedUsers"
                    :key="`user:${user.subjectId}`"
                    class="meta-form-share__chip"
                    :data-inactive="user.isActive ? 'false' : 'true'"
                  >
                    <span class="meta-form-share__chip-text">
                      {{ user.label }}
                      <span v-if="user.subtitle" class="meta-form-share__chip-subtitle">{{ user.subtitle }}</span>
                      <span v-if="!user.isActive" class="meta-form-share__chip-subtitle">Inactive user</span>
                      <span
                        v-if="subjectDingTalkStatus(user)"
                        class="meta-form-share__chip-subtitle"
                        :data-form-share-dingtalk-status="subjectDingTalkStatus(user)"
                      >
                        {{ subjectDingTalkStatus(user) }}
                      </span>
                    </span>
                    <button
                      class="meta-form-share__chip-remove"
                      type="button"
                      :disabled="busy"
                      :data-form-share-remove-user="user.subjectId"
                      @click="void removeAllowedSubject('user', user.subjectId)"
                    >
                      Remove
                    </button>
                  </span>
                </div>
                <div v-else class="meta-form-share__empty">
                  No local user allowlist configured. Access is still gated by the selected DingTalk mode; add local users or member groups to narrow who can fill this form.
                </div>
              </div>

              <div class="meta-form-share__allowlist-subsection">
                <label class="meta-form-share__label">Allowed member groups</label>
                <div v-if="allowedMemberGroups.length > 0" class="meta-form-share__chip-list">
                  <span
                    v-for="group in allowedMemberGroups"
                    :key="`member-group:${group.subjectId}`"
                    class="meta-form-share__chip"
                    :data-inactive="group.isActive ? 'false' : 'true'"
                  >
                    <span class="meta-form-share__chip-text">
                      {{ group.label }}
                      <span v-if="group.subtitle" class="meta-form-share__chip-subtitle">{{ group.subtitle }}</span>
                    </span>
                    <button
                      class="meta-form-share__chip-remove"
                      type="button"
                      :disabled="busy"
                      :data-form-share-remove-group="group.subjectId"
                      @click="void removeAllowedSubject('member-group', group.subjectId)"
                    >
                      Remove
                    </button>
                  </span>
                </div>
                <div v-else class="meta-form-share__empty">
                  No local member-group allowlist configured. Add a local member group to let its members fill this form.
                </div>
              </div>

              <div class="meta-form-share__allowlist-subsection">
                <label class="meta-form-share__label">Add from eligible people and groups</label>
                <div v-if="candidatesLoading" class="meta-form-share__empty">Searching users and member groups&#x2026;</div>
                <div v-else-if="filteredCandidates.length === 0" class="meta-form-share__empty">No matching candidates.</div>
                <div v-else class="meta-form-share__candidate-list">
                  <button
                    v-for="candidate in filteredCandidates"
                    :key="`${candidate.subjectType}:${candidate.subjectId}`"
                    class="meta-form-share__candidate"
                    type="button"
                    :disabled="busy || (candidate.subjectType === 'user' && !candidate.isActive)"
                    :data-form-share-add-subject="`${candidate.subjectType}:${candidate.subjectId}`"
                    @click="void addAllowedSubject(candidate)"
                  >
                    <span class="meta-form-share__candidate-title">
                      {{ candidate.label }}
                      <span class="meta-form-share__candidate-badge">
                        {{ candidate.subjectType === 'user' ? 'User' : 'Member group' }}
                      </span>
                    </span>
                    <span v-if="candidate.subtitle" class="meta-form-share__candidate-subtitle">{{ candidate.subtitle }}</span>
                    <span
                      v-if="subjectDingTalkStatus(candidate)"
                      class="meta-form-share__candidate-subtitle"
                      :data-form-share-dingtalk-status="subjectDingTalkStatus(candidate)"
                    >
                      {{ subjectDingTalkStatus(candidate) }}
                    </span>
                    <span v-if="candidate.subjectType === 'user' && !candidate.isActive" class="meta-form-share__candidate-subtitle">
                      Inactive users cannot be added
                    </span>
                  </button>
                </div>
              </div>
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
import { computed, ref, watch } from 'vue'
import type { FormShareConfig, MetaSheetPermissionCandidate } from '../types'
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
const candidateQuery = ref('')
const candidates = ref<MetaSheetPermissionCandidate[]>([])
const candidatesLoading = ref(false)
let candidateTimer: number | null = null

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

const showAllowlistSection = computed(() =>
  config.value?.enabled === true
  && config.value.accessMode !== 'public',
)

const accessModeHint = computed(() => {
  if (config.value?.accessMode === 'dingtalk_granted') {
    return 'The form opens only for DingTalk-bound users whose DingTalk grant is enabled by an administrator.'
  }
  if (config.value?.accessMode === 'dingtalk') {
    return 'The form opens only after DingTalk sign-in, and the user must already be bound to a local account.'
  }
  return 'Anyone who has the link can open and submit this form.'
})

const allowedUsers = computed(() => config.value?.allowedUsers ?? [])
const allowedMemberGroups = computed(() => config.value?.allowedMemberGroups ?? [])
const allowedUserCount = computed(() => config.value?.allowedUserIds?.length ?? allowedUsers.value.length)
const allowedMemberGroupCount = computed(() => config.value?.allowedMemberGroupIds?.length ?? allowedMemberGroups.value.length)
const hasLocalAllowlist = computed(() => allowedUserCount.value > 0 || allowedMemberGroupCount.value > 0)
const audienceRule = computed(() => {
  const mode = config.value?.accessMode ?? 'public'
  if (mode === 'public') {
    return {
      title: 'Fully public anonymous form',
      description: 'Anyone with the link can open and submit without local login or DingTalk binding.',
    }
  }
  if (mode === 'dingtalk_granted') {
    return hasLocalAllowlist.value
      ? {
          title: 'Selected authorized DingTalk users',
          description: 'Only selected local users or group members can fill, and each user must be DingTalk-bound with form authorization enabled.',
        }
      : {
          title: 'All authorized DingTalk users',
          description: 'Any DingTalk-bound local user can fill after an administrator enables their DingTalk form authorization.',
        }
  }
  return hasLocalAllowlist.value
    ? {
        title: 'Selected DingTalk-bound users',
        description: 'Only selected local users or group members can fill, and each user must be bound to DingTalk.',
      }
    : {
        title: 'All DingTalk-bound users',
        description: 'Any local user can fill after DingTalk sign-in when their account is bound to DingTalk.',
      }
})
const allowlistAudienceSummary = computed(() => {
  const userCount = allowedUserCount.value
  const memberGroupCount = allowedMemberGroupCount.value
  if (userCount === 0 && memberGroupCount === 0) {
    return 'No local allowlist limits are set; all users allowed by the selected DingTalk mode can fill this form.'
  }

  const parts: string[] = []
  if (userCount > 0) {
    parts.push(`${userCount} ${userCount === 1 ? 'local user' : 'local users'}`)
  }
  if (memberGroupCount > 0) {
    parts.push(`${memberGroupCount} ${memberGroupCount === 1 ? 'local member group' : 'local member groups'}`)
  }
  return `Local allowlist limits: ${parts.join(' and ')} can fill after passing the selected DingTalk mode.`
})
const selectedSubjectKeys = computed(() => new Set([
  ...allowedUsers.value.map((user) => `user:${user.subjectId}`),
  ...allowedMemberGroups.value.map((group) => `member-group:${group.subjectId}`),
]))
const filteredCandidates = computed(() =>
  candidates.value.filter((candidate) => !selectedSubjectKeys.value.has(`${candidate.subjectType}:${candidate.subjectId}`)),
)

function subjectDingTalkStatus(
  subject: Pick<MetaSheetPermissionCandidate, 'subjectType' | 'dingtalkBound' | 'dingtalkGrantEnabled' | 'dingtalkPersonDeliveryAvailable'>,
): string {
  const mode = config.value?.accessMode ?? 'public'
  if (mode === 'public') return ''
  if (subject.subjectType === 'member-group') return 'Members are checked individually'
  if (subject.subjectType !== 'user') return ''
  if (subject.dingtalkBound === false) return 'DingTalk not bound'
  if (mode === 'dingtalk_granted') {
    if (subject.dingtalkGrantEnabled === true) return 'DingTalk bound and authorized'
    if (subject.dingtalkBound === true && subject.dingtalkGrantEnabled === false) return 'DingTalk authorization not enabled'
  }
  if (subject.dingtalkBound === true) return 'DingTalk bound'
  if (subject.dingtalkPersonDeliveryAvailable === true) return 'DingTalk delivery linked'
  return ''
}

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

async function loadCandidates() {
  if (!props.client || !props.visible || !showAllowlistSection.value) {
    candidates.value = []
    return
  }
  candidatesLoading.value = true
  try {
    const response = await props.client.listFormShareCandidates(props.sheetId, {
      q: candidateQuery.value,
      limit: 20,
    })
    candidates.value = response.items
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load allowlist candidates'
  } finally {
    candidatesLoading.value = false
  }
}

function scheduleCandidateLoad() {
  if (candidateTimer !== null) window.clearTimeout(candidateTimer)
  candidateTimer = window.setTimeout(() => {
    void loadCandidates()
  }, 180)
}

async function persistAllowlist(update: Pick<FormShareConfig, 'allowedUserIds' | 'allowedMemberGroupIds'>) {
  if (!props.client || busy.value || !config.value) return
  busy.value = true
  error.value = null
  try {
    config.value = await props.client.updateFormShareConfig(props.sheetId, props.viewId, update)
    emit('updated')
    await loadCandidates()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to update allowlist'
  } finally {
    busy.value = false
  }
}

async function addAllowedSubject(candidate: MetaSheetPermissionCandidate) {
  if (!config.value) return
  if (candidate.subjectType === 'member-group') {
    await persistAllowlist({
      allowedUserIds: config.value.allowedUserIds,
      allowedMemberGroupIds: Array.from(new Set([...config.value.allowedMemberGroupIds, candidate.subjectId])),
    })
    return
  }
  await persistAllowlist({
    allowedUserIds: Array.from(new Set([...config.value.allowedUserIds, candidate.subjectId])),
    allowedMemberGroupIds: config.value.allowedMemberGroupIds,
  })
}

async function removeAllowedSubject(subjectType: 'user' | 'member-group', subjectId: string) {
  if (!config.value) return
  if (subjectType === 'member-group') {
    await persistAllowlist({
      allowedUserIds: config.value.allowedUserIds,
      allowedMemberGroupIds: config.value.allowedMemberGroupIds.filter((id) => id !== subjectId),
    })
    return
  }
  await persistAllowlist({
    allowedUserIds: config.value.allowedUserIds.filter((id) => id !== subjectId),
    allowedMemberGroupIds: config.value.allowedMemberGroupIds,
  })
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
  if (!props.client || busy.value || !config.value) return
  const select = event.target as HTMLSelectElement | null
  if (!select) return
  if (
    select.value === 'public'
    && (config.value.allowedUserIds.length > 0 || config.value.allowedMemberGroupIds.length > 0)
  ) {
    error.value = 'Clear the allowed users and member groups before switching back to a fully public form.'
    select.value = config.value.accessMode
    return
  }
  busy.value = true
  error.value = null
  try {
    config.value = await props.client.updateFormShareConfig(props.sheetId, props.viewId, {
      accessMode: select.value as FormShareConfig['accessMode'],
    })
    emit('updated')
    await loadCandidates()
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

watch(
  () => [props.visible, props.sheetId, config.value?.enabled, config.value?.accessMode] as const,
  ([isVisible]) => {
    if (isVisible && showAllowlistSection.value) {
      void loadCandidates()
    } else {
      candidates.value = []
    }
  },
  { immediate: true },
)

watch(candidateQuery, () => {
  if (showAllowlistSection.value) scheduleCandidateLoad()
})
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
  width: 560px;
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
.meta-form-share__allowlist-section,
.meta-form-share__link-section,
.meta-form-share__expiry-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.meta-form-share__allowlist-section {
  padding: 12px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #f8fafc;
}

.meta-form-share__allowlist-header,
.meta-form-share__allowlist-subsection {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.meta-form-share__allowlist-summary {
  align-self: flex-start;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 999px;
  color: #1d4ed8;
  font-size: 12px;
  margin: 0;
  padding: 4px 10px;
}

.meta-form-share__chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.meta-form-share__chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 999px;
  background: #e2e8f0;
  color: #0f172a;
}

.meta-form-share__chip[data-inactive="true"] {
  background: #fee2e2;
}

.meta-form-share__chip-text {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12px;
  font-weight: 600;
}

.meta-form-share__chip-subtitle {
  font-weight: 500;
  color: #64748b;
}

.meta-form-share__chip-remove {
  border: none;
  background: transparent;
  color: #0f172a;
  font-size: 12px;
  cursor: pointer;
}

.meta-form-share__candidate-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.meta-form-share__candidate {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  width: 100%;
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  background: #fff;
  padding: 10px 12px;
  text-align: left;
  cursor: pointer;
}

.meta-form-share__candidate-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: #0f172a;
}

.meta-form-share__candidate-badge {
  border-radius: 999px;
  padding: 2px 8px;
  background: #dbeafe;
  color: #1d4ed8;
  font-size: 11px;
  font-weight: 600;
}

.meta-form-share__candidate-subtitle {
  font-size: 12px;
  color: #64748b;
}

.meta-form-share__audience-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  border: 1px solid #bae6fd;
  border-radius: 10px;
  background: #f0f9ff;
  color: #0c4a6e;
  font-size: 12px;
}

.meta-form-share__audience-card strong {
  font-size: 13px;
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

.meta-form-share__btn:disabled,
.meta-form-share__candidate:disabled,
.meta-form-share__chip-remove:disabled {
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
