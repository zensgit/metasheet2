<template>
  <section class="notification-preferences" aria-labelledby="notification-preferences-title">
    <header class="notification-preferences__header">
      <div>
        <h1 id="notification-preferences-title">{{ t.title }}</h1>
        <router-link to="/settings" data-testid="notification-back">{{ t.backToSessions }}</router-link>
      </div>
      <button
        v-if="loadState === 'ready'"
        type="button"
        data-testid="notification-refresh"
        :disabled="pendingWrite || loading"
        @click="void refresh()"
      >
        {{ loading ? t.refreshing : t.refresh }}
      </button>
    </header>

    <p ref="actionResultElement" class="notification-preferences__live" data-testid="notification-action-result" aria-live="polite" tabindex="-1">
      {{ actionMessage }}
    </p>
    <button
      v-if="retryAttempt"
      type="button"
      data-testid="notification-test-retry"
      :disabled="pendingWrite || loading || !endpoints?.delivery.testSendAvailable"
      @click="void retryTest()"
    >
      {{ t.retryTest }}
    </button>

    <p v-if="loadState === 'loading' && !endpoints" data-testid="notification-loading" role="status">
      {{ t.loading }}
    </p>
    <p v-else-if="loadState === 'disabled'" data-testid="notification-disabled" role="status">
      {{ t.featureDisabled }}
    </p>
    <p v-if="loadState === 'disabled'" class="notification-note" data-testid="notification-disabled-org-hint">
      {{ t.featureDisabledOrgHint }}
    </p>
    <div v-else-if="loadState === 'error'" data-testid="notification-error" role="alert">
      <p>{{ t.loadFailed }}</p>
      <button type="button" data-testid="notification-retry" :disabled="loading" @click="void refresh()">
        {{ loading ? t.refreshing : t.refresh }}
      </button>
    </div>

    <template v-else-if="endpoints">
      <section class="notification-panel" data-testid="notification-channels" :aria-busy="pendingWrite || loading">
        <div class="notification-panel__heading">
          <h2>{{ t.channelsTitle }}</h2>
        </div>

        <p v-if="!hasUsableChannels" class="notification-empty" data-testid="notification-no-channels">
          {{ noChannelsText }}
        </p>

        <template v-if="endpoints.endpoints.length > 0">
          <h3>{{ t.endpointsHeading }}</h3>
          <div class="notification-list">
            <article
              v-for="(endpoint, index) in endpoints.endpoints"
              :key="endpoint.id"
              class="notification-card"
              :data-testid="`notification-endpoint-${index}`"
            >
              <div class="notification-card__title">
                <strong>{{ endpoint.connection.label }}</strong>
                <span class="notification-badge" :class="{ 'notification-badge--off': !endpoint.usable }">
                  {{ endpointStatus(endpoint) }}
                </span>
              </div>
              <p v-if="endpoint.unusableReason" class="notification-reason">
                {{ notificationReason(endpoint.unusableReason, t) }}
              </p>
              <div class="notification-actions">
                <button
                  v-if="endpoint.status === 'stale'"
                  type="button"
                  :data-testid="`notification-reenable-${index}`"
                  :disabled="pendingWrite || loading"
                  @click="void reenable(endpoint)"
                >
                  {{ t.reenable }}
                </button>
                <button
                  type="button"
                  :data-testid="`notification-revoke-${index}`"
                  :disabled="pendingWrite || loading"
                  @click="openRevoke(endpoint)"
                >
                  {{ t.revoke }}
                </button>
                <button
                  type="button"
                  :data-testid="`notification-test-${index}`"
                  :disabled="pendingWrite || loading || !endpoints.delivery.testSendAvailable"
                  :aria-describedby="!endpoints.delivery.testSendAvailable ? `notification-test-reason-${index}` : undefined"
                  @click="openTest(endpoint)"
                >
                  {{ t.testSend }}
                </button>
              </div>
              <p
                v-if="!endpoints.delivery.testSendAvailable"
                :id="`notification-test-reason-${index}`"
                class="notification-reason"
                :data-testid="`notification-test-reason-${index}`"
              >
                {{ deliveryReason }}
              </p>
            </article>
          </div>
        </template>

        <h3>{{ t.candidatesHeading }}</h3>
        <p v-if="visibleCandidates.length === 0 && !hasUsableChannels" class="notification-empty">
          {{ t.noCandidates }}
        </p>
        <div class="notification-list">
          <article
            v-for="(candidate, index) in visibleCandidates"
            :key="`${candidate.connection.id}:${candidate.proofKind}`"
            class="notification-card"
            :data-testid="`notification-candidate-${index}`"
          >
            <div class="notification-card__title">
              <strong>{{ candidate.connection.label }}</strong>
              <span class="notification-badge" :class="{ 'notification-badge--off': !candidate.addressable }">
                {{ candidate.addressable ? t.statusCandidateEnabled : t.statusUnavailable }}
              </span>
            </div>
            <p v-if="!candidate.addressable" class="notification-reason" :data-testid="`notification-candidate-reason-${index}`">
              {{ notificationReason(candidate.reasonCode, t) }}
            </p>
            <button
              v-if="candidate.addressable"
              type="button"
              :data-testid="`notification-enable-${index}`"
              :disabled="pendingWrite || loading"
              @click="void establish(candidate)"
            >
              {{ t.enable }}
            </button>
          </article>
        </div>
      </section>

      <section v-if="topics.length > 0" class="notification-panel" data-testid="notification-types">
        <h2>{{ t.typesTitle }}</h2>
        <form
          v-for="topic in topics"
          :key="topic.topic"
          class="notification-topic"
          :data-testid="`notification-topic-${topic.topic}`"
          :aria-busy="pendingWrite"
          @submit.prevent="void save(topic)"
        >
          <h3>{{ topicName(topic.topic) }}</h3>
          <fieldset :disabled="pendingWrite || loading">
            <label class="notification-choice">
              <input
                v-model="drafts[topic.topic].enabled"
                type="checkbox"
                :data-testid="`notification-enabled-${topic.topic}`"
              />
              {{ t.enabledLabel }}
            </label>

            <div class="notification-field">
              <label :for="`notification-primary-${topic.topic}`">{{ t.primaryLabel }}</label>
              <select
                :id="`notification-primary-${topic.topic}`"
                v-model="drafts[topic.topic].primaryEndpointId"
                :data-testid="`notification-primary-${topic.topic}`"
                :disabled="pendingWrite || loading || !hasUsableChannels"
                @change="onPrimaryChange(topic.topic)"
              >
                <option value="">{{ t.useOrgDefault }}</option>
                <option
                  v-for="endpoint in primaryEndpoints(topic.topic)"
                  :key="endpoint.id"
                  :value="endpoint.id"
                  :disabled="!isUsableEndpoint(endpoint)"
                >
                  {{ endpoint.connection.label }}
                </option>
              </select>
              <p v-if="endpointIssue(topic.topic, 'primary')" class="notification-reason" :data-testid="`notification-primary-issue-${topic.topic}`">
                {{ endpointIssue(topic.topic, 'primary') }}
              </p>
            </div>

            <div class="notification-field">
              <label :for="`notification-fallback-${topic.topic}`">{{ t.fallbackLabel }}</label>
              <select
                :id="`notification-fallback-${topic.topic}`"
                v-model="drafts[topic.topic].fallbackEndpointId"
                :data-testid="`notification-fallback-${topic.topic}`"
                :disabled="pendingWrite || loading || !hasUsableChannels || !drafts[topic.topic].primaryEndpointId"
              >
                <option value="">{{ t.noFallback }}</option>
                <option
                  v-for="endpoint in fallbackEndpoints(topic.topic)"
                  :key="endpoint.id"
                  :value="endpoint.id"
                  :disabled="fallbackOptionDisabled(topic.topic, endpoint)"
                >
                  {{ endpoint.connection.label }}
                </option>
              </select>
              <p v-if="endpointIssue(topic.topic, 'fallback')" class="notification-reason" :data-testid="`notification-fallback-issue-${topic.topic}`">
                {{ endpointIssue(topic.topic, 'fallback') }}
              </p>
            </div>
            <p v-if="!hasUsableChannels" class="notification-note" data-testid="notification-default-connection">
              {{ t.useOrgDefault }}
            </p>

            <label class="notification-choice">
              <input
                v-model="drafts[topic.topic].quietEnabled"
                type="checkbox"
                :data-testid="`notification-quiet-enabled-${topic.topic}`"
              />
              {{ t.quietLabel }}
            </label>

            <div class="notification-quiet-grid">
              <div class="notification-field">
                <label :for="`notification-quiet-start-${topic.topic}`">{{ t.quietStart }}</label>
                <input
                  :id="`notification-quiet-start-${topic.topic}`"
                  v-model="drafts[topic.topic].quietStart"
                  type="time"
                  :data-testid="`notification-quiet-start-${topic.topic}`"
                  :disabled="pendingWrite || loading || !drafts[topic.topic].quietEnabled"
                />
              </div>
              <div class="notification-field">
                <label :for="`notification-quiet-end-${topic.topic}`">{{ t.quietEnd }}</label>
                <input
                  :id="`notification-quiet-end-${topic.topic}`"
                  v-model="drafts[topic.topic].quietEnd"
                  type="time"
                  :data-testid="`notification-quiet-end-${topic.topic}`"
                  :disabled="pendingWrite || loading || !drafts[topic.topic].quietEnabled"
                />
              </div>
              <div class="notification-field">
                <label :for="`notification-time-zone-${topic.topic}`">{{ t.quietTimeZone }}</label>
                <input
                  :id="`notification-time-zone-${topic.topic}`"
                  v-model="drafts[topic.topic].timeZone"
                  type="text"
                  autocomplete="off"
                  :data-testid="`notification-time-zone-${topic.topic}`"
                  :disabled="pendingWrite || loading || !drafts[topic.topic].quietEnabled"
                />
              </div>
            </div>
            <p class="notification-note" :data-testid="`notification-browser-zone-${topic.topic}`">
              {{ t.browserTimeZoneDefault }}
            </p>
            <p class="notification-note" :data-testid="`notification-quiet-warning-${topic.topic}`">
              {{ t.quietWarning }}
            </p>
          </fieldset>

          <p class="notification-effect" :data-testid="`notification-effective-${topic.topic}`">
            {{ effectiveText(topic) }}
          </p>
          <p v-if="formErrors[topic.topic]" class="notification-error" role="alert" :data-testid="`notification-form-error-${topic.topic}`">
            {{ formErrors[topic.topic] }}
          </p>
          <button type="submit" :data-testid="`notification-save-${topic.topic}`" :disabled="pendingWrite || loading">
            {{ pendingWrite ? t.saving : t.save }}
          </button>
        </form>
      </section>
    </template>

    <div
      v-if="dialog"
      ref="dialogElement"
      class="notification-dialog-backdrop"
      @keydown="onDialogKeydown"
    >
      <div
        class="notification-dialog"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="`notification-dialog-${dialog.kind}-title`"
        :data-testid="`notification-${dialog.kind}-dialog`"
      >
        <h2 :id="`notification-dialog-${dialog.kind}-title`">
          {{ dialog.kind === 'revoke' ? t.revokeDialogTitle : t.testDialogTitle }}
        </h2>
        <p>{{ dialog.endpoint.connection.label }}</p>
        <p v-if="dialog.kind === 'revoke'" data-testid="notification-revoke-confirmation">
          {{ t.revokeConfirmation }}
        </p>
        <p v-else>{{ t.testDialogPrompt }}</p>
        <div class="notification-actions">
          <button type="button" data-testid="notification-dialog-cancel" :disabled="pendingWrite || loading" @click="closeDialog">
            {{ t.cancel }}
          </button>
          <button
            type="button"
            data-testid="notification-dialog-confirm"
            :disabled="pendingWrite || loading"
            @click="void confirmDialog()"
          >
            {{ dialog.kind === 'revoke' ? t.revokeConfirm : t.testConfirm }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useLocale } from '../composables/useLocale'
import {
  createNotificationTestIdempotencyKey,
  establishNotificationEndpoint,
  listNotificationEndpoints,
  listNotificationPreferences,
  patchNotificationPreference,
  resolveNotificationBrowserTimeZone,
  revokeNotificationEndpoint,
  testNotificationEndpoint,
  type NotificationCandidate,
  type NotificationEndpoint,
  type NotificationEndpointsListing,
  type NotificationPreferencePatch,
  type NotificationQuietHours,
  type NotificationTestSendResult,
  type NotificationTopic,
  type NotificationWriteFailure,
} from '../notifications/notificationApi'
import {
  NOTIFICATION_EN,
  NOTIFICATION_ZH,
  notificationReason,
  type NotificationText,
} from '../notifications/labels'

interface TopicDraft {
  enabled: boolean
  primaryEndpointId: string
  fallbackEndpointId: string
  quietEnabled: boolean
  quietStart: string
  quietEnd: string
  timeZone: string
}

type DialogState =
  | { kind: 'revoke'; endpoint: NotificationEndpoint }
  | { kind: 'test'; endpoint: NotificationEndpoint }

const { isZh } = useLocale()
const t = computed<NotificationText>(() => (isZh.value ? NOTIFICATION_ZH : NOTIFICATION_EN))
const loadState = ref<'loading' | 'disabled' | 'error' | 'ready'>('loading')
const loading = ref(false)
const endpoints = ref<NotificationEndpointsListing | null>(null)
const topics = ref<NotificationTopic[]>([])
const drafts = ref<Record<string, TopicDraft>>({})
const formErrors = ref<Record<string, string>>({})
const pendingWrite = ref(false)
const actionMessage = ref('')
const actionResultElement = ref<HTMLElement | null>(null)
const retryAttempt = ref<{ endpoint: NotificationEndpoint; idempotencyKey: string } | null>(null)
const dialog = ref<DialogState | null>(null)
const dialogElement = ref<HTMLElement | null>(null)
const browserTimeZone = resolveNotificationBrowserTimeZone()
let active = true
let readGeneration = 0
let writeGeneration = 0
let focusBeforeDialog: HTMLElement | null = null

const usableEndpoints = computed(() => endpoints.value?.endpoints.filter((endpoint) => endpoint.status === 'active' && endpoint.usable) ?? [])
const hasUsableChannels = computed(() => usableEndpoints.value.length > 0)
const visibleCandidates = computed(() => {
  const listing = endpoints.value
  if (!listing) return []
  const listed = new Set(listing.endpoints.map((endpoint) => endpoint.id))
  return listing.candidates.filter((candidate) => candidate.endpointId === null || !listed.has(candidate.endpointId))
})
const noChannelsText = computed(() => visibleCandidates.value.some((candidate) => candidate.addressable) ? t.value.noEnabledChannels : t.value.noUsableChannels)
const deliveryReason = computed(() => endpoints.value?.delivery.reason ? notificationReason(endpoints.value.delivery.reason, t.value) : t.value.testSendUnavailable)

function topicName(topic: NotificationTopic['topic']): string {
  return topic === 'task_reminder' ? t.value.topicTaskReminder : topic
}

function endpointStatus(endpoint: NotificationEndpoint): string {
  if (endpoint.status === 'stale') return t.value.statusStale
  return endpoint.usable ? t.value.statusUsable : t.value.statusUnavailable
}

function makeDraft(topic: NotificationTopic): TopicDraft {
  const preference = topic.preference
  return {
    enabled: preference?.enabled ?? true,
    primaryEndpointId: preference?.primaryEndpointId ?? '',
    fallbackEndpointId: preference?.fallbackEndpointId ?? '',
    quietEnabled: preference?.quietHours !== null && preference?.quietHours !== undefined,
    quietStart: preference?.quietHours?.start ?? '22:00',
    quietEnd: preference?.quietHours?.end ?? '08:00',
    timeZone: preference?.quietHours?.timeZone ?? browserTimeZone,
  }
}

function resetDrafts(listing: NotificationPreferencesListingShape): void {
  drafts.value = Object.fromEntries(listing.topics.map((topic) => [topic.topic, makeDraft(topic)]))
}

interface NotificationPreferencesListingShape {
  topics: NotificationTopic[]
}

async function loadData(): Promise<void> {
  const generation = ++readGeneration
  loading.value = true
  const [endpointResult, preferenceResult] = await Promise.all([listNotificationEndpoints(), listNotificationPreferences()])
  if (!active || generation !== readGeneration) return
  loading.value = false
  if (endpointResult.kind === 'disabled' || preferenceResult.kind === 'disabled') {
    endpoints.value = null
    topics.value = []
    loadState.value = 'disabled'
    return
  }
  if (endpointResult.kind !== 'ok' || preferenceResult.kind !== 'ok') {
    endpoints.value = null
    topics.value = []
    loadState.value = 'error'
    return
  }
  endpoints.value = endpointResult.value
  topics.value = preferenceResult.value.topics
  resetDrafts(preferenceResult.value)
  formErrors.value = {}
  loadState.value = 'ready'
}

async function refresh(): Promise<void> {
  if (pendingWrite.value) return
  await loadData()
}

function invalidateReads(): void {
  readGeneration += 1
  loading.value = false
}

function beginWrite(): number | null {
  if (pendingWrite.value || loading.value || !active) return null
  pendingWrite.value = true
  actionMessage.value = ''
  formErrors.value = {}
  retryAttempt.value = null
  return ++writeGeneration
}

function writeIsCurrent(token: number): boolean {
  return active && token === writeGeneration
}

function endWrite(token: number): void {
  if (writeIsCurrent(token)) pendingWrite.value = false
}

function validationFieldText(field: string): string {
  if (field === 'fallbackEndpointId') return t.value.invalidFallback
  if (field === 'quietHours.start') return t.value.invalidQuietStart
  if (field === 'quietHours.end') return t.value.invalidQuietEnd
  if (field === 'quietHours.timeZone') return t.value.invalidQuietTimeZone
  if (field === 'quietHours') return t.value.quietInvalid
  return t.value.actionFailed
}

function writeFailureText(result: NotificationWriteFailure): string {
  if (result.kind === 'validation') {
    if (result.fields && result.fields.length > 0) return validationFieldText(result.fields[0])
    return notificationReason(result.reason ?? result.code, t.value)
  }
  if (result.kind === 'conflict') return notificationReason(result.reason ?? result.code, t.value)
  return t.value.actionFailed
}

async function establish(candidate: Pick<NotificationCandidate, 'connection' | 'proofKind'>): Promise<void> {
  const token = beginWrite()
  if (token === null) return
  const result = await establishNotificationEndpoint({ connectionId: candidate.connection.id, proofKind: candidate.proofKind })
  if (!writeIsCurrent(token)) return
  if (result.kind === 'ok') {
    invalidateReads()
    actionMessage.value = t.value.established
    await loadData()
  } else {
    actionMessage.value = writeFailureText(result)
  }
  endWrite(token)
}

async function reenable(endpoint: NotificationEndpoint): Promise<void> {
  await establish({ connection: endpoint.connection, proofKind: endpoint.proofKind })
}

function isUsableEndpoint(endpoint: NotificationEndpoint): boolean {
  return endpoint.status === 'active' && endpoint.usable
}

function endpointById(id: string): NotificationEndpoint | undefined {
  return endpoints.value?.endpoints.find((endpoint) => endpoint.id === id)
}

function topicByName(topic: string): NotificationTopic | undefined {
  return topics.value.find((item) => item.topic === topic)
}

function primaryEndpoints(topic: string): NotificationEndpoint[] {
  const options = [...usableEndpoints.value]
  const storedId = topicByName(topic)?.preference?.primaryEndpointId
  const stored = storedId ? endpointById(storedId) : undefined
  if (stored && !options.some((endpoint) => endpoint.id === stored.id)) options.push(stored)
  return options
}

function fallbackEndpoints(topic: string): NotificationEndpoint[] {
  const primaryId = drafts.value[topic]?.primaryEndpointId ?? ''
  const primary = endpointById(primaryId)
  const options = primaryId ? usableEndpoints.value.filter((endpoint) => endpoint.connection.provider !== primary?.connection.provider) : []
  const storedId = topicByName(topic)?.preference?.fallbackEndpointId
  const stored = storedId ? endpointById(storedId) : undefined
  if (stored && !options.some((endpoint) => endpoint.id === stored.id)) options.push(stored)
  return options
}

function fallbackOptionDisabled(topic: string, endpoint: NotificationEndpoint): boolean {
  const primary = endpointById(drafts.value[topic]?.primaryEndpointId ?? '')
  return !isUsableEndpoint(endpoint) || endpoint.connection.provider === primary?.connection.provider
}

function endpointIssue(topic: string, channel: 'primary' | 'fallback'): string | null {
  const preference = topicByName(topic)?.preference
  const storedId = channel === 'primary' ? preference?.primaryEndpointId : preference?.fallbackEndpointId
  if (!storedId || drafts.value[topic]?.[`${channel}EndpointId`] !== storedId) return null
  const endpoint = endpointById(storedId)
  if (!endpoint) return notificationReason('endpoint_not_found', t.value)
  if (!isUsableEndpoint(endpoint)) return notificationReason(endpoint.unusableReason, t.value)
  if (channel === 'fallback' && endpoint.connection.provider === endpointById(drafts.value[topic].primaryEndpointId)?.connection.provider) {
    return notificationReason('FALLBACK_PROVIDER_NOT_ALLOWED', t.value)
  }
  return null
}

function onPrimaryChange(topic: string): void {
  const draft = drafts.value[topic]
  const fallback = endpointById(draft.fallbackEndpointId)
  const primary = endpointById(draft.primaryEndpointId)
  if (fallback && fallback.connection.provider === primary?.connection.provider) draft.fallbackEndpointId = ''
}

function validQuietDraft(draft: TopicDraft): boolean {
  if (!draft.quietEnabled) return true
  const clock = /^([01]\d|2[0-3]):([0-5]\d)$/
  if (!clock.test(draft.quietStart) || !clock.test(draft.quietEnd) || draft.quietStart === draft.quietEnd) return false
  if (!/^[A-Za-z0-9_+/-]{1,64}$/.test(draft.timeZone)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: draft.timeZone }).format(0)
    return true
  } catch {
    return false
  }
}

function quietHoursOfDraft(draft: TopicDraft): NotificationQuietHours | null {
  return draft.quietEnabled ? { start: draft.quietStart, end: draft.quietEnd, timeZone: draft.timeZone } : null
}

function quietHoursEqual(first: NotificationQuietHours | null, second: NotificationQuietHours | null): boolean {
  if (first === null || second === null) return first === second
  return first.start === second.start && first.end === second.end && first.timeZone === second.timeZone
}

function preferencePatchOf(topic: NotificationTopic, draft: TopicDraft): NotificationPreferencePatch {
  const preference = topic.preference
  const patch: NotificationPreferencePatch = { topic: topic.topic, expectedRevision: preference?.revision ?? 0 }
  if (draft.enabled !== (preference?.enabled ?? true)) patch.enabled = draft.enabled
  const primaryEndpointId = draft.primaryEndpointId || null
  const fallbackEndpointId = draft.fallbackEndpointId || null
  if (primaryEndpointId !== (preference?.primaryEndpointId ?? null)) patch.primaryEndpointId = primaryEndpointId
  if (fallbackEndpointId !== (preference?.fallbackEndpointId ?? null)) patch.fallbackEndpointId = fallbackEndpointId
  const quietHours = quietHoursOfDraft(draft)
  if (!quietHoursEqual(quietHours, preference?.quietHours ?? null)) patch.quietHours = quietHours
  return patch
}

async function save(topic: NotificationTopic): Promise<void> {
  const token = beginWrite()
  if (token === null) return
  const draft = drafts.value[topic.topic]
  if (!validQuietDraft(draft)) {
    formErrors.value = { ...formErrors.value, [topic.topic]: t.value.quietInvalid }
    endWrite(token)
    return
  }
  const result = await patchNotificationPreference(preferencePatchOf(topic, draft))
  if (!writeIsCurrent(token)) return
  if (result.kind === 'ok') {
    invalidateReads()
    topics.value = topics.value.map((item) => item.topic === topic.topic ? result.topic : item)
    drafts.value = { ...drafts.value, [topic.topic]: makeDraft(result.topic) }
    actionMessage.value = t.value.saved
  } else if (result.kind === 'conflict' && result.code === 'PREFERENCE_STALE') {
    actionMessage.value = t.value.preferenceConflict
    await loadData()
  } else {
    actionMessage.value = writeFailureText(result)
  }
  endWrite(token)
}

function effectiveText(topic: NotificationTopic): string {
  if ((topic.preference?.enabled ?? true) && topic.applies.now && topic.effective.usable) return t.value.effectiveNow
  if (topic.applies.reason === null) return t.value.effectiveNotNow
  return `${t.value.effectiveNotNow}${t.value.effectiveReasonSeparator}${notificationReason(topic.applies.reason, t.value)}`
}

function rememberFocus(): void {
  focusBeforeDialog = document.activeElement instanceof HTMLElement ? document.activeElement : null
}

function restoreFocus(): void {
  const target = focusBeforeDialog
  focusBeforeDialog = null
  if (target?.isConnected) target.focus()
}

function openRevoke(endpoint: NotificationEndpoint): void {
  if (pendingWrite.value) return
  rememberFocus()
  dialog.value = { kind: 'revoke', endpoint }
  void nextTick(() => dialogElement.value?.querySelector<HTMLButtonElement>('[data-testid="notification-dialog-cancel"]')?.focus())
}

function openTest(endpoint: NotificationEndpoint): void {
  if (pendingWrite.value || !endpoints.value?.delivery.testSendAvailable) return
  rememberFocus()
  dialog.value = { kind: 'test', endpoint }
  void nextTick(() => dialogElement.value?.querySelector<HTMLButtonElement>('[data-testid="notification-dialog-cancel"]')?.focus())
}

function closeDialog(): void {
  if (pendingWrite.value) return
  dialog.value = null
  void nextTick(restoreFocus)
}

function onDialogKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeDialog()
    return
  }
  if (event.key !== 'Tab') return
  const controls = Array.from(dialogElement.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
  if (controls.length === 0) return
  const first = controls[0]
  const last = controls[controls.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

async function confirmDialog(): Promise<void> {
  const current = dialog.value
  if (!current || pendingWrite.value) return
  dialog.value = null
  await nextTick(() => actionResultElement.value?.focus())
  if (current.kind === 'revoke') await revoke(current.endpoint)
  else await sendTest(current.endpoint)
}

async function revoke(endpoint: NotificationEndpoint): Promise<void> {
  const token = beginWrite()
  if (token === null) return
  const result = await revokeNotificationEndpoint(endpoint.id)
  if (!writeIsCurrent(token)) return
  if (result.kind === 'ok') {
    invalidateReads()
    actionMessage.value = t.value.revoked
    await loadData()
  } else {
    actionMessage.value = writeFailureText(result)
  }
  endWrite(token)
}

function testResultText(result: NotificationTestSendResult): string {
  switch (result.kind) {
    case 'accepted':
      return t.value.testAccepted
    case 'failed':
      return t.value.testFailed
    case 'error':
    case 'outcome_unknown':
    case 'network_error':
      return t.value.testUnknown
    case 'confirm_required':
      return t.value.testConfirmRequired
    case 'delivery_disabled':
      return notificationReason('delivery_disabled', t.value)
    case 'endpoint_not_usable':
      return t.value.testEndpointUnusable
    case 'connection_not_ready':
      return t.value.testConnectionNotReady
    case 'in_progress':
      return t.value.testInProgress
    case 'not_found':
      return notificationReason('endpoint_not_found', t.value)
    case 'rate_limited':
      return result.retryAfterSeconds === null
        ? t.value.testRateLimitedUnknown
        : t.value.testRateLimited.replace('{seconds}', String(result.retryAfterSeconds))
  }
}

async function executeTest(endpoint: NotificationEndpoint, idempotencyKey: string, token: number): Promise<void> {
  const result = await testNotificationEndpoint(endpoint.id, idempotencyKey)
  if (!writeIsCurrent(token)) return
  retryAttempt.value = result.kind === 'network_error' || result.kind === 'error' ? { endpoint, idempotencyKey } : null
  actionMessage.value = testResultText(result)
  endWrite(token)
}

async function sendTest(endpoint: NotificationEndpoint): Promise<void> {
  if (!endpoints.value?.delivery.testSendAvailable) return
  const token = beginWrite()
  if (token === null) return
  retryAttempt.value = null
  let idempotencyKey: string
  try {
    idempotencyKey = createNotificationTestIdempotencyKey()
  } catch {
    actionMessage.value = t.value.testFailed
    endWrite(token)
    return
  }
  await executeTest(endpoint, idempotencyKey, token)
}

async function retryTest(): Promise<void> {
  const attempt = retryAttempt.value
  if (!attempt || pendingWrite.value || !endpoints.value?.delivery.testSendAvailable) return
  const token = beginWrite()
  if (token === null) return
  await executeTest(attempt.endpoint, attempt.idempotencyKey, token)
}

onMounted(() => {
  void loadData()
})

onBeforeUnmount(() => {
  active = false
  invalidateReads()
  writeGeneration += 1
})

defineExpose({ loadState, loading, endpoints, topics, drafts, pendingWrite, actionMessage, formErrors, retryAttempt, get readGeneration() { return readGeneration } })
</script>

<style scoped>
.notification-preferences {
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-width: 1080px;
  padding: 24px;
}

.notification-preferences__header,
.notification-card__title,
.notification-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.notification-preferences__header {
  justify-content: space-between;
}

.notification-preferences__header h1 {
  margin: 0 0 6px;
}

.notification-preferences__live {
  min-height: 24px;
  margin: 0;
}

.notification-panel,
.notification-topic,
.notification-card {
  border: 1px solid #dbe3ef;
  border-radius: 14px;
  background: #fff;
}

.notification-panel {
  padding: 20px;
}

.notification-panel h2,
.notification-panel h3,
.notification-topic h3 {
  margin-top: 0;
}

.notification-list {
  display: grid;
  gap: 12px;
  margin-bottom: 20px;
}

.notification-card {
  padding: 16px;
}

.notification-card__title {
  flex-wrap: wrap;
}

.notification-card__title strong {
  margin-right: auto;
}

.notification-badge {
  padding: 3px 9px;
  border-radius: 999px;
  background: #dcfce7;
  color: #166534;
  font-size: 12px;
}

.notification-badge--off {
  background: #e2e8f0;
  color: #475569;
}

.notification-reason,
.notification-note,
.notification-effect {
  color: #526177;
}

.notification-empty {
  padding: 12px;
  border-radius: 10px;
  background: #f8fafc;
}

.notification-topic {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 18px;
}

.notification-topic fieldset {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.notification-choice {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: 8px;
}

.notification-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 560px;
}

.notification-field input,
.notification-field select {
  min-width: 0;
  padding: 8px 10px;
}

.notification-quiet-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 12px;
}

.notification-error {
  color: #b91c1c;
}

button {
  padding: 8px 13px;
  border: 1px solid #b8c5d8;
  border-radius: 8px;
  background: #f8fafc;
  color: #172033;
  cursor: pointer;
}

button:disabled,
input:disabled,
select:disabled,
fieldset:disabled input,
fieldset:disabled select {
  cursor: not-allowed;
  opacity: 0.62;
}

.notification-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgb(15 23 42 / 45%);
}

.notification-dialog {
  width: min(520px, 100%);
  padding: 22px;
  border-radius: 14px;
  background: #fff;
}

.notification-dialog .notification-actions {
  justify-content: flex-end;
}

@media (max-width: 640px) {
  .notification-preferences {
    padding: 16px;
  }

  .notification-preferences__header,
  .notification-card__title {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
