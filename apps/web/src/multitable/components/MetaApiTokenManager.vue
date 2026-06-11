<template>
  <div v-if="visible" class="meta-api-mgr__overlay" @click.self="$emit('close')">
    <div class="meta-api-mgr">
      <div class="meta-api-mgr__header">
        <h4 class="meta-api-mgr__title">{{ managerTitle }}</h4>
        <button class="meta-api-mgr__close" type="button" @click="$emit('close')">&times;</button>
      </div>

      <div class="meta-api-mgr__tabs" role="tablist">
        <button
          role="tab"
          :aria-selected="activeTab === 'tokens'"
          class="meta-api-mgr__tab"
          :class="{ 'meta-api-mgr__tab--active': activeTab === 'tokens' }"
          @click="activeTab = 'tokens'"
        >
          {{ a('tab.tokens') }}
        </button>
        <button
          role="tab"
          :aria-selected="activeTab === 'webhooks'"
          class="meta-api-mgr__tab"
          :class="{ 'meta-api-mgr__tab--active': activeTab === 'webhooks' }"
          @click="activeTab = 'webhooks'"
        >
          {{ a('tab.webhooks') }}
        </button>
        <button
          v-if="canManageDingTalkGroups"
          role="tab"
          :aria-selected="activeTab === 'dingtalk-groups'"
          class="meta-api-mgr__tab"
          :class="{ 'meta-api-mgr__tab--active': activeTab === 'dingtalk-groups' }"
          @click="activeTab = 'dingtalk-groups'"
        >
          {{ a('tab.dingtalkGroups') }}
        </button>
      </div>

      <div class="meta-api-mgr__body">
        <div v-if="error" class="meta-api-mgr__error" role="alert">{{ error }}</div>
        <div
          v-if="!canManageDingTalkGroups"
          class="meta-api-mgr__notice"
          role="note"
          data-dingtalk-groups-permission-note="true"
        >
          {{ a('notice.dingtalkPermission') }}
        </div>

        <!-- ===== TOKENS TAB ===== -->
        <template v-if="activeTab === 'tokens'">
          <!-- Newly created token (show once) -->
          <div v-if="newTokenPlaintext" class="meta-api-mgr__new-token" data-new-token="true">
            <strong>{{ a('token.newShownOnce') }}</strong>
            <div class="meta-api-mgr__token-display">
              <code data-new-token-value="true">{{ newTokenPlaintext }}</code>
              <button class="meta-api-mgr__btn meta-api-mgr__btn--primary" type="button" data-copy-new-token="true" @click="onCopyNewToken">
                {{ copiedNewToken ? a('token.action.copied') : a('token.action.copy') }}
              </button>
            </div>
            <p class="meta-api-mgr__warning">{{ a('token.saveWarning') }}</p>
            <button class="meta-api-mgr__btn" type="button" @click="newTokenPlaintext = null">{{ m('action.dismiss') }}</button>
          </div>

          <!-- Create form -->
          <section v-if="showTokenForm" class="meta-api-mgr__form" data-token-form="true">
            <div class="meta-api-mgr__form-title">{{ a('token.newTitle') }}</div>
            <label class="meta-api-mgr__label">{{ a('token.name') }}</label>
            <input v-model="tokenDraft.name" class="meta-api-mgr__input" type="text" :placeholder="a('token.namePlaceholder')" data-token-name="true" />
            <label class="meta-api-mgr__label">{{ a('token.scopes') }}</label>
            <div class="meta-api-mgr__checkboxes">
              <label v-for="scope in availableScopes" :key="scope" class="meta-api-mgr__checkbox-label">
                <input type="checkbox" :value="scope" :checked="tokenDraft.scopes.includes(scope)" @change="onToggleScope(scope)" :data-token-scope="scope" />
                {{ apiScopeLabel(scope, isZh) }}
              </label>
            </div>
            <label class="meta-api-mgr__label">{{ a('token.expiryOptional') }}</label>
            <input v-model="tokenDraft.expiresAt" class="meta-api-mgr__input" type="date" data-token-expiry="true" />
            <div class="meta-api-mgr__form-actions">
              <button class="meta-api-mgr__btn meta-api-mgr__btn--primary" type="button" :disabled="!tokenDraft.name.trim() || busy" data-token-create="true" @click="onCreateToken">{{ a('token.action.create') }}</button>
              <button class="meta-api-mgr__btn" type="button" @click="showTokenForm = false">{{ m('action.cancel') }}</button>
            </div>
          </section>

          <button v-if="!showTokenForm" class="meta-api-mgr__btn meta-api-mgr__btn--primary meta-api-mgr__btn-add" type="button" data-token-new="true" @click="openTokenForm">{{ a('token.newButton') }}</button>

          <!-- Token list -->
          <div v-if="tokensLoading" class="meta-api-mgr__empty">{{ a('token.loading') }}</div>
          <div v-else-if="!tokens.length && !showTokenForm" class="meta-api-mgr__empty" data-tokens-empty="true">{{ a('token.empty') }}</div>
          <div v-for="token in tokens" :key="token.id" class="meta-api-mgr__card" :data-token-id="token.id">
            <div class="meta-api-mgr__card-header">
              <strong class="meta-api-mgr__card-name">{{ token.name }}</strong>
              <code class="meta-api-mgr__card-prefix">{{ token.prefix }}...</code>
            </div>
            <div class="meta-api-mgr__card-meta">
              <span>{{ a('token.meta.scopes') }}: {{ apiScopesText(token.scopes, isZh) }}</span>
              <span>{{ a('token.meta.created') }}: {{ formatDate(token.createdAt) }}</span>
              <span v-if="token.lastUsedAt">{{ a('token.meta.lastUsed') }}: {{ formatDate(token.lastUsedAt) }}</span>
              <span v-if="token.expiresAt">{{ a('token.meta.expires') }}: {{ formatDate(token.expiresAt) }}</span>
            </div>
            <div class="meta-api-mgr__card-actions">
              <button class="meta-api-mgr__btn" type="button" :disabled="busy" data-token-rotate="true" @click="onRotateToken(token.id)">{{ a('token.action.rotate') }}</button>
              <button class="meta-api-mgr__btn meta-api-mgr__btn--danger" type="button" :disabled="busy" data-token-revoke="true" @click="onRevokeToken(token.id)">{{ a('token.action.revoke') }}</button>
            </div>
          </div>
        </template>

        <!-- ===== WEBHOOKS TAB ===== -->
        <template v-if="activeTab === 'webhooks'">
          <!-- Create/Edit form -->
          <section v-if="showWebhookForm" class="meta-api-mgr__form" data-webhook-form="true">
            <div class="meta-api-mgr__form-title">{{ editingWebhookId ? a('webhook.editTitle') : a('webhook.newTitle') }}</div>
            <label class="meta-api-mgr__label">{{ a('webhook.name') }}</label>
            <input v-model="webhookDraft.name" class="meta-api-mgr__input" type="text" :placeholder="a('webhook.namePlaceholder')" data-webhook-name="true" />
            <label class="meta-api-mgr__label">{{ a('webhook.url') }}</label>
            <input v-model="webhookDraft.url" class="meta-api-mgr__input" type="url" :placeholder="a('webhook.urlPlaceholder')" data-webhook-url="true" />
            <label class="meta-api-mgr__label">{{ a('webhook.events') }}</label>
            <div class="meta-api-mgr__checkboxes">
              <label v-for="evt in availableEvents" :key="evt" class="meta-api-mgr__checkbox-label">
                <input type="checkbox" :value="evt" :checked="webhookDraft.events.includes(evt)" @change="onToggleEvent(evt)" :data-webhook-event="evt" />
                {{ apiWebhookEventLabel(evt, isZh) }}
              </label>
            </div>
            <label class="meta-api-mgr__label">{{ a('webhook.secretOptional') }}</label>
            <input v-model="webhookDraft.secret" class="meta-api-mgr__input" type="text" :placeholder="a('webhook.secretPlaceholder')" data-webhook-secret="true" />

            <!-- Retry policy (optional; blank = backend default) -->
            <div class="meta-api-mgr__label" data-webhook-retry-section="true">{{ a('webhook.retry.section') }}</div>
            <label class="meta-api-mgr__label">{{ a('webhook.retry.maxRetries') }}</label>
            <input
              v-model="webhookDraft.maxRetries"
              class="meta-api-mgr__input"
              type="number"
              :min="WEBHOOK_RETRY_BOUNDS.maxRetries.min"
              :max="WEBHOOK_RETRY_BOUNDS.maxRetries.max"
              :placeholder="a('webhook.retry.maxRetriesHint')"
              data-webhook-max-retries="true"
            />
            <p
              v-if="!webhookRetryPolicy.maxRetries.ok"
              class="meta-api-mgr__error"
              data-webhook-max-retries-error="true"
            >{{ a('webhook.retry.rangeError') }}</p>

            <label class="meta-api-mgr__label">{{ a('webhook.retry.baseDelay') }}</label>
            <input
              v-model="webhookDraft.retryBaseDelayMs"
              class="meta-api-mgr__input"
              type="number"
              :min="WEBHOOK_RETRY_BOUNDS.baseDelayMs.min"
              :max="WEBHOOK_RETRY_BOUNDS.baseDelayMs.max"
              :placeholder="a('webhook.retry.baseDelayHint')"
              data-webhook-base-delay="true"
            />
            <p
              v-if="!webhookRetryPolicy.retryBaseDelayMs.ok"
              class="meta-api-mgr__error"
              data-webhook-base-delay-error="true"
            >{{ a('webhook.retry.rangeError') }}</p>

            <label class="meta-api-mgr__label">{{ a('webhook.retry.maxDelay') }}</label>
            <input
              v-model="webhookDraft.retryMaxDelayMs"
              class="meta-api-mgr__input"
              type="number"
              :min="WEBHOOK_RETRY_BOUNDS.maxDelayMs.min"
              :max="WEBHOOK_RETRY_BOUNDS.maxDelayMs.max"
              :placeholder="a('webhook.retry.maxDelayHint')"
              data-webhook-max-delay="true"
            />
            <p
              v-if="!webhookRetryPolicy.retryMaxDelayMs.ok"
              class="meta-api-mgr__error"
              data-webhook-max-delay-error="true"
            >{{ a('webhook.retry.rangeError') }}</p>

            <div class="meta-api-mgr__form-actions">
              <button class="meta-api-mgr__btn meta-api-mgr__btn--primary" type="button" :disabled="!canSaveWebhook || busy" data-webhook-save="true" @click="onSaveWebhook">
                {{ editingWebhookId ? a('webhook.action.update') : a('webhook.action.create') }}
              </button>
              <button class="meta-api-mgr__btn" type="button" @click="cancelWebhookForm">{{ m('action.cancel') }}</button>
            </div>
          </section>

          <button v-if="!showWebhookForm" class="meta-api-mgr__btn meta-api-mgr__btn--primary meta-api-mgr__btn-add" type="button" data-webhook-new="true" @click="openWebhookForm">{{ a('webhook.newButton') }}</button>

          <!-- Webhook list -->
          <div v-if="webhooksLoading" class="meta-api-mgr__empty">{{ a('webhook.loading') }}</div>
          <div v-else-if="!webhooks.length && !showWebhookForm" class="meta-api-mgr__empty" data-webhooks-empty="true">{{ a('webhook.empty') }}</div>
          <div v-for="wh in webhooks" :key="wh.id" class="meta-api-mgr__card" :data-webhook-id="wh.id">
            <div class="meta-api-mgr__card-header">
              <strong class="meta-api-mgr__card-name">{{ wh.name }}</strong>
              <span class="meta-api-mgr__card-status" :data-webhook-status="wh.active ? 'active' : 'disabled'">
                {{ apiWebhookStatusLabel(wh.active, isZh) }}
              </span>
            </div>
            <div class="meta-api-mgr__card-meta">
              <span>{{ a('webhook.meta.url') }}: {{ wh.url }}</span>
              <span>{{ a('webhook.meta.events') }}: {{ apiWebhookEventsText(wh.events, isZh) }}</span>
              <span v-if="wh.failureCount > 0" class="meta-api-mgr__card-failures">{{ a('webhook.meta.failures') }}: {{ wh.failureCount }}</span>
            </div>
            <div class="meta-api-mgr__card-actions">
              <button class="meta-api-mgr__btn" type="button" data-webhook-edit="true" @click="openEditWebhook(wh)">{{ a('webhook.action.edit') }}</button>
              <button class="meta-api-mgr__btn" type="button" data-webhook-toggle="true" :disabled="busy" @click="onToggleWebhook(wh)">
                {{ apiToggleLabel(wh.active, isZh) }}
              </button>
              <button class="meta-api-mgr__btn" type="button" data-webhook-deliveries="true" @click="onViewDeliveries(wh.id)">{{ a('webhook.action.deliveries') }}</button>
              <button class="meta-api-mgr__btn meta-api-mgr__btn--danger" type="button" :disabled="busy" data-webhook-delete="true" @click="onDeleteWebhook(wh.id)">{{ m('action.delete') }}</button>
            </div>

            <!-- Delivery history (inline) -->
            <div v-if="deliveriesWebhookId === wh.id && deliveries.length" class="meta-api-mgr__deliveries" data-deliveries="true">
              <strong class="meta-api-mgr__label">{{ a('webhook.delivery.recent') }}</strong>
              <div v-for="d in deliveries" :key="d.id" class="meta-api-mgr__delivery-row" :data-delivery-id="d.id">
                <span :class="d.success ? 'meta-api-mgr__delivery--ok' : 'meta-api-mgr__delivery--fail'">
                  {{ apiDeliveryResultLabel(d.success, isZh) }}
                </span>
                <span>{{ apiWebhookEventLabel(d.event, isZh) }}</span>
                <span>HTTP {{ d.httpStatus ?? '-' }}</span>
                <span v-if="d.retryCount > 0">{{ a('webhook.delivery.retries') }}: {{ d.retryCount }}</span>
                <span>{{ formatDate(d.timestamp) }}</span>
              </div>
            </div>
          </div>
        </template>

        <!-- ===== DINGTALK GROUPS TAB ===== -->
        <template v-if="canManageDingTalkGroups && activeTab === 'dingtalk-groups'">
          <section class="meta-api-mgr__notice" data-dingtalk-groups-scope-note="true">
            <strong>{{ a('dingtalk.scopeNote.title') }}</strong>
            <span>{{ a('dingtalk.scopeNote.bound') }}</span>
            <span>{{ a('dingtalk.scopeNote.delivery') }}</span>
          </section>

          <section v-if="showDingTalkGroupForm" class="meta-api-mgr__form" data-dingtalk-group-form="true">
            <div class="meta-api-mgr__form-title">
              {{ editingDingTalkGroupId ? a('dingtalk.editTitle') : a('dingtalk.newTitle') }}
            </div>
            <label class="meta-api-mgr__label">{{ a('dingtalk.name') }}</label>
            <input
              v-model="dingTalkGroupDraft.name"
              class="meta-api-mgr__input"
              type="text"
              :placeholder="a('dingtalk.namePlaceholder')"
              data-dingtalk-group-name="true"
            />
            <label class="meta-api-mgr__label">{{ a('dingtalk.webhookUrl') }}</label>
            <input
              v-model="dingTalkGroupDraft.webhookUrl"
              class="meta-api-mgr__input"
              type="url"
              :placeholder="a('dingtalk.webhookPlaceholder')"
              aria-describedby="dingtalk-group-webhook-help"
              data-dingtalk-group-webhook-url="true"
            />
            <p id="dingtalk-group-webhook-help" class="meta-api-mgr__help" data-dingtalk-group-webhook-help="true">
              {{ a('dingtalk.webhookHelp') }}
            </p>
            <p
              v-if="dingTalkGroupWebhookValidationMessage && dingTalkGroupDraft.webhookUrl.trim()"
              class="meta-api-mgr__help meta-api-mgr__help--error"
              data-dingtalk-group-webhook-error="true"
            >
              {{ dingTalkGroupWebhookValidationMessage }}
            </p>
            <label class="meta-api-mgr__label">{{ a('dingtalk.secretOptional') }}</label>
            <input
              v-model="dingTalkGroupDraft.secret"
              class="meta-api-mgr__input"
              type="text"
              :placeholder="a('dingtalk.secretPlaceholder')"
              :disabled="dingTalkGroupDraft.clearSecret"
              aria-describedby="dingtalk-group-secret-help"
              data-dingtalk-group-secret="true"
            />
            <p id="dingtalk-group-secret-help" class="meta-api-mgr__help" data-dingtalk-group-secret-help="true">
              {{ dingTalkGroupSecretHelpText }}
            </p>
            <p
              v-if="dingTalkGroupSecretValidationMessage"
              class="meta-api-mgr__help meta-api-mgr__help--error"
              data-dingtalk-group-secret-error="true"
            >
              {{ dingTalkGroupSecretValidationMessage }}
            </p>
            <label
              v-if="editingDingTalkGroupOriginal?.hasSecret"
              class="meta-api-mgr__checkbox-label"
              data-dingtalk-group-clear-secret-row="true"
            >
              <input
                v-model="dingTalkGroupDraft.clearSecret"
                type="checkbox"
                data-dingtalk-group-clear-secret="true"
              />
              {{ a('dingtalk.clearSecret') }}
            </label>
            <label class="meta-api-mgr__checkbox-label">
              <input
                v-model="dingTalkGroupDraft.enabled"
                type="checkbox"
                data-dingtalk-group-enabled="true"
              />
              {{ a('dingtalk.enabled') }}
            </label>
            <div class="meta-api-mgr__form-actions">
              <button
                class="meta-api-mgr__btn meta-api-mgr__btn--primary"
                type="button"
                :disabled="!canSaveDingTalkGroup || busy"
                data-dingtalk-group-save="true"
                @click="onSaveDingTalkGroup"
              >
                {{ editingDingTalkGroupId ? a('dingtalk.action.update') : a('dingtalk.action.create') }}
              </button>
              <button class="meta-api-mgr__btn" type="button" @click="cancelDingTalkGroupForm">{{ m('action.cancel') }}</button>
            </div>
          </section>

          <button
            v-if="!showDingTalkGroupForm"
            class="meta-api-mgr__btn meta-api-mgr__btn--primary meta-api-mgr__btn-add"
            type="button"
            data-dingtalk-group-new="true"
            @click="openDingTalkGroupForm"
          >
            {{ a('dingtalk.newButton') }}
          </button>

          <div v-if="dingTalkGroupsLoading" class="meta-api-mgr__empty">{{ a('dingtalk.loading') }}</div>
          <div
            v-else-if="!dingTalkGroups.length && !showDingTalkGroupForm"
            class="meta-api-mgr__empty"
            data-dingtalk-groups-empty="true"
          >
            {{ a('dingtalk.empty') }}
          </div>
          <div
            v-for="group in dingTalkGroups"
            :key="group.id"
            class="meta-api-mgr__card"
            :data-dingtalk-group-id="group.id"
          >
            <div class="meta-api-mgr__card-header">
              <strong class="meta-api-mgr__card-name">{{ group.name }}</strong>
              <span class="meta-api-mgr__card-status" :data-dingtalk-group-status="group.enabled ? 'enabled' : 'disabled'">
                {{ apiDingTalkEnabledLabel(group.enabled, isZh) }}
              </span>
            </div>
            <div class="meta-api-mgr__card-meta">
              <span>{{ a('dingtalk.meta.webhook') }}: {{ maskDingTalkWebhookUrl(group.webhookUrl) }}</span>
              <span>{{ a('dingtalk.meta.secret') }}: {{ apiDingTalkSecretStateLabel(group.hasSecret === true, isZh) }}</span>
              <span>{{ dingTalkGroupScopeLabel(group) }}</span>
              <span>{{ a('dingtalk.meta.created') }}: {{ formatDate(group.createdAt) }}</span>
              <span v-if="group.lastTestedAt">{{ a('dingtalk.meta.lastTest') }}: {{ formatDate(group.lastTestedAt) }}</span>
              <span v-if="group.lastTestStatus" :data-dingtalk-group-test-status="group.lastTestStatus">
                {{ a('dingtalk.meta.testStatus') }}: {{ group.lastTestStatus }}
              </span>
            </div>
            <div v-if="group.lastTestError" class="meta-api-mgr__card-meta meta-api-mgr__card-failures">
              <span>{{ a('dingtalk.meta.lastError') }}: {{ group.lastTestError }}</span>
            </div>
            <div class="meta-api-mgr__card-actions">
              <button v-if="canMutateDingTalkGroup(group)" class="meta-api-mgr__btn" type="button" data-dingtalk-group-edit="true" @click="openEditDingTalkGroup(group)">
                {{ a('dingtalk.action.edit') }}
              </button>
              <button v-if="canMutateDingTalkGroup(group)" class="meta-api-mgr__btn" type="button" :disabled="busy" data-dingtalk-group-toggle="true" @click="onToggleDingTalkGroup(group)">
                {{ apiDingTalkToggleLabel(group.enabled, isZh) }}
              </button>
              <button class="meta-api-mgr__btn" type="button" data-dingtalk-group-deliveries="true" @click="onViewDingTalkDeliveries(group)">
                {{ a('dingtalk.action.deliveries') }}
              </button>
              <button v-if="canMutateDingTalkGroup(group)" class="meta-api-mgr__btn" type="button" :disabled="busy" data-dingtalk-group-test-send="true" @click="onTestDingTalkGroup(group)">
                {{ a('dingtalk.action.testSend') }}
              </button>
              <button v-if="canMutateDingTalkGroup(group)" class="meta-api-mgr__btn meta-api-mgr__btn--danger" type="button" :disabled="busy" data-dingtalk-group-delete="true" @click="onDeleteDingTalkGroup(group)">
                {{ m('action.delete') }}
              </button>
              <span v-else class="meta-api-mgr__card-readonly" data-dingtalk-group-readonly="true">
                {{ a('dingtalk.readonly') }}
              </span>
            </div>

            <div
              v-if="dingTalkDeliveriesGroupId === group.id"
              class="meta-api-mgr__deliveries"
              data-dingtalk-deliveries="true"
            >
              <strong class="meta-api-mgr__label">{{ a('dingtalk.delivery.recent') }}</strong>
              <div v-if="dingTalkDeliveriesLoading" class="meta-api-mgr__empty" data-dingtalk-deliveries-loading="true">
                {{ a('dingtalk.delivery.loading') }}
              </div>
              <div
                v-else-if="!dingTalkDeliveries.length"
                class="meta-api-mgr__empty"
                data-dingtalk-deliveries-empty="true"
              >
                {{ a('dingtalk.delivery.empty') }}
              </div>
              <template v-else>
                <div
                  v-for="delivery in dingTalkDeliveries"
                  :key="delivery.id"
                  class="meta-api-mgr__delivery-row"
                  :data-dingtalk-delivery-id="delivery.id"
                >
                  <span :class="delivery.success ? 'meta-api-mgr__delivery--ok' : 'meta-api-mgr__delivery--fail'">
                    {{ apiDeliveryResultLabel(delivery.success, isZh) }}
                  </span>
                  <span>{{ apiDingTalkDeliverySourceLabel(delivery.sourceType, isZh) }}</span>
                  <span>{{ delivery.subject }}</span>
                  <span>HTTP {{ delivery.httpStatus ?? '-' }}</span>
                  <span>{{ formatDate(delivery.createdAt) }}</span>
                </div>
              </template>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type {
  ApiToken,
  DingTalkGroupDelivery,
  DingTalkGroupDestination,
  Webhook,
  WebhookDelivery,
} from '../types'
import type { MultitableApiClient } from '../api/client'
import { managerLabel, type MetaManagerLabelKey } from '../utils/meta-manager-labels'
import {
  apiDeliveryResultLabel,
  apiDingTalkDeliverySourceLabel,
  apiDingTalkEnabledLabel,
  apiDingTalkScopeLabel,
  apiDingTalkSecretStateLabel,
  apiDingTalkToggleLabel,
  apiManagerTitle,
  apiScopeLabel,
  apiScopesText,
  apiTokenLabel,
  apiToggleLabel,
  apiWebhookEventLabel,
  apiWebhookEventsText,
  apiWebhookStatusLabel,
  type MetaApiTokenLabelKey,
} from '../utils/meta-api-token-labels'

const props = withDefaults(defineProps<{
  visible: boolean
  sheetId?: string
  client?: MultitableApiClient
  canManageAutomation?: boolean
}>(), {
  canManageAutomation: true,
})

const emit = defineEmits<{
  (e: 'close'): void
}>()

const activeTab = ref<'tokens' | 'webhooks' | 'dingtalk-groups'>('tokens')
const error = ref<string | null>(null)
const busy = ref(false)
const { isZh } = useLocale()

function a(key: MetaApiTokenLabelKey): string {
  return apiTokenLabel(key, isZh.value)
}

function m(key: MetaManagerLabelKey): string {
  return managerLabel(key, isZh.value)
}

// ---- Tokens ----
const tokens = ref<ApiToken[]>([])
const tokensLoading = ref(false)
const showTokenForm = ref(false)
const newTokenPlaintext = ref<string | null>(null)
const copiedNewToken = ref(false)
const tokenDraft = ref({ name: '', scopes: [] as string[], expiresAt: '' })
const availableScopes = ['read', 'write', 'admin']

// ---- Webhooks ----
const webhooks = ref<Webhook[]>([])
const webhooksLoading = ref(false)
const showWebhookForm = ref(false)
// Retry-policy bounds — mirror the backend webhook schema (webhooks.ts).
const WEBHOOK_RETRY_BOUNDS = {
  maxRetries: { min: 0, max: 10 },
  baseDelayMs: { min: 100, max: 60_000 },
  maxDelayMs: { min: 1_000, max: 3_600_000 },
} as const

const editingWebhookId = ref<string | null>(null)
// Retry-policy fields are kept as raw strings ('' = unset → backend default).
const webhookDraft = ref({
  name: '',
  url: '',
  events: [] as string[],
  secret: '',
  maxRetries: '',
  retryBaseDelayMs: '',
  retryMaxDelayMs: '',
})
const availableEvents = ['record.created', 'record.updated', 'record.deleted', 'field.changed']
const deliveriesWebhookId = ref<string | null>(null)
const deliveries = ref<WebhookDelivery[]>([])

// ---- DingTalk groups ----
const dingTalkGroups = ref<DingTalkGroupDestination[]>([])
const dingTalkGroupsLoading = ref(false)
const showDingTalkGroupForm = ref(false)
const editingDingTalkGroupId = ref<string | null>(null)
const editingDingTalkGroupOriginal = ref<{ webhookUrl: string; hasSecret: boolean } | null>(null)
const dingTalkDeliveriesGroupId = ref<string | null>(null)
const dingTalkDeliveriesLoading = ref(false)
const dingTalkDeliveries = ref<DingTalkGroupDelivery[]>([])
let dingTalkDeliveriesRequestToken = 0
const dingTalkGroupDraft = ref({
  name: '',
  webhookUrl: '',
  secret: '',
  clearSecret: false,
  enabled: true,
})

const canManageDingTalkGroups = computed(() => props.canManageAutomation !== false)
const managerTitle = computed(() => apiManagerTitle(canManageDingTalkGroups.value, isZh.value))

/**
 * Parse an optional bounded integer from a raw input string.
 * Returns `{ ok: true, value: undefined }` for blank (use backend default),
 * `{ ok: true, value: n }` when in range, and `{ ok: false }` otherwise.
 */
function parseBoundedInt(
  raw: string | number,
  bounds: { min: number; max: number },
): { ok: boolean; value?: number } {
  // `v-model` on <input type="number"> can hand back a number; normalize to a
  // trimmed string first so the empty-input case stays detectable.
  const trimmed = String(raw ?? '').trim()
  if (trimmed === '') return { ok: true, value: undefined }
  if (!/^-?\d+$/.test(trimmed)) return { ok: false }
  const n = Number(trimmed)
  if (n < bounds.min || n > bounds.max) return { ok: false }
  return { ok: true, value: n }
}

const webhookRetryPolicy = computed(() => ({
  maxRetries: parseBoundedInt(webhookDraft.value.maxRetries, WEBHOOK_RETRY_BOUNDS.maxRetries),
  retryBaseDelayMs: parseBoundedInt(webhookDraft.value.retryBaseDelayMs, WEBHOOK_RETRY_BOUNDS.baseDelayMs),
  retryMaxDelayMs: parseBoundedInt(webhookDraft.value.retryMaxDelayMs, WEBHOOK_RETRY_BOUNDS.maxDelayMs),
}))

const webhookRetryPolicyValid = computed(() => {
  const p = webhookRetryPolicy.value
  return p.maxRetries.ok && p.retryBaseDelayMs.ok && p.retryMaxDelayMs.ok
})

const canSaveWebhook = computed(() => {
  return (
    !!webhookDraft.value.name.trim() &&
    webhookDraft.value.url.startsWith('https://') &&
    webhookDraft.value.events.length > 0 &&
    webhookRetryPolicyValid.value
  )
})

const dingTalkGroupWebhookChanged = computed(() => {
  if (!editingDingTalkGroupId.value) return true
  return dingTalkGroupDraft.value.webhookUrl.trim() !== (editingDingTalkGroupOriginal.value?.webhookUrl ?? '').trim()
})
const dingTalkGroupSecretChanged = computed(() => {
  if (!editingDingTalkGroupId.value) return true
  if (dingTalkGroupDraft.value.clearSecret) return true
  return Boolean(dingTalkGroupDraft.value.secret.trim())
})
const dingTalkGroupWebhookValidationMessage = computed(() =>
  dingTalkGroupWebhookChanged.value ? validateDingTalkGroupWebhookUrl(dingTalkGroupDraft.value.webhookUrl) : '',
)
const dingTalkGroupSecretValidationMessage = computed(() =>
  dingTalkGroupDraft.value.clearSecret ? '' : dingTalkGroupSecretChanged.value ? validateDingTalkGroupSecret(dingTalkGroupDraft.value.secret) : '',
)
const dingTalkGroupSecretHelpText = computed(() => {
  if (editingDingTalkGroupOriginal.value?.hasSecret) {
    return a('dingtalk.secretHelp.saved')
  }
  return a('dingtalk.secretHelp.new')
})
const canSaveDingTalkGroup = computed(() => {
  return canManageDingTalkGroups.value
    && dingTalkGroupDraft.value.name.trim()
    && !dingTalkGroupWebhookValidationMessage.value
    && !dingTalkGroupSecretValidationMessage.value
})

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString()
  } catch {
    return iso
  }
}

function maskDingTalkWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url)
    for (const key of ['access_token', 'timestamp', 'sign']) {
      if (parsed.searchParams.has(key)) {
        parsed.searchParams.set(key, '***')
      }
    }
    if (parsed.password) {
      parsed.password = '***'
    }
    return parsed.toString()
  } catch {
    return String(url || '').replace(/([?&](?:access_token|timestamp|sign)=)[^&]+/gi, '$1***')
  }
}

function validateDingTalkGroupWebhookUrl(value: string): string {
  const webhookUrl = value.trim()
  if (!webhookUrl) return a('validation.webhookRequired')
  let parsed: URL
  try {
    parsed = new URL(webhookUrl)
  } catch {
    return a('validation.webhookInvalid')
  }
  if (parsed.protocol !== 'https:') return a('validation.webhookHttps')
  if (parsed.hostname !== 'oapi.dingtalk.com' || parsed.pathname !== '/robot/send') {
    return a('validation.webhookDingTalkUrl')
  }
  if (!parsed.searchParams.get('access_token')?.trim()) {
    return a('validation.webhookAccessToken')
  }
  return ''
}

function validateDingTalkGroupSecret(value: string): string {
  const secret = value.trim()
  if (!secret) return ''
  if (!secret.startsWith('SEC')) return a('validation.secretPrefix')
  return ''
}

function dingTalkGroupScope(group: DingTalkGroupDestination): 'private' | 'sheet' | 'org' {
  if (group.scope === 'org' || group.orgId) return 'org'
  if (group.scope === 'sheet' || group.sheetId) return 'sheet'
  return 'private'
}

function dingTalkGroupScopeLabel(group: DingTalkGroupDestination): string {
  const scope = dingTalkGroupScope(group)
  return apiDingTalkScopeLabel(scope, { sheetId: group.sheetId, orgId: group.orgId }, isZh.value)
}

function canMutateDingTalkGroup(group: DingTalkGroupDestination): boolean {
  return dingTalkGroupScope(group) !== 'org'
}

// ---- Token actions ----
async function loadTokens() {
  if (!props.client) return
  tokensLoading.value = true
  error.value = null
  try {
    tokens.value = await props.client.listApiTokens()
  } catch (err) {
    error.value = err instanceof Error ? err.message : a('error.loadTokens')
  } finally {
    tokensLoading.value = false
  }
}

function openTokenForm() {
  tokenDraft.value = { name: '', scopes: [], expiresAt: '' }
  showTokenForm.value = true
}

function onToggleScope(scope: string) {
  const idx = tokenDraft.value.scopes.indexOf(scope)
  if (idx >= 0) {
    tokenDraft.value.scopes.splice(idx, 1)
  } else {
    tokenDraft.value.scopes.push(scope)
  }
}

async function onCreateToken() {
  if (!props.client || busy.value) return
  busy.value = true
  error.value = null
  try {
    const result = await props.client.createApiToken({
      name: tokenDraft.value.name.trim(),
      scopes: tokenDraft.value.scopes,
      expiresAt: tokenDraft.value.expiresAt || undefined,
    })
    newTokenPlaintext.value = result.plaintext
    showTokenForm.value = false
    await loadTokens()
  } catch (err) {
    error.value = err instanceof Error ? err.message : a('error.createToken')
  } finally {
    busy.value = false
  }
}

function onCopyNewToken() {
  if (!newTokenPlaintext.value) return
  void navigator.clipboard.writeText(newTokenPlaintext.value)
  copiedNewToken.value = true
  setTimeout(() => { copiedNewToken.value = false }, 2000)
}

async function onRevokeToken(tokenId: string) {
  if (!props.client || busy.value) return
  busy.value = true
  error.value = null
  try {
    await props.client.revokeApiToken(tokenId)
    await loadTokens()
  } catch (err) {
    error.value = err instanceof Error ? err.message : a('error.revokeToken')
  } finally {
    busy.value = false
  }
}

async function onRotateToken(tokenId: string) {
  if (!props.client || busy.value) return
  busy.value = true
  error.value = null
  try {
    const result = await props.client.rotateApiToken(tokenId)
    newTokenPlaintext.value = result.plaintext
    await loadTokens()
  } catch (err) {
    error.value = err instanceof Error ? err.message : a('error.rotateToken')
  } finally {
    busy.value = false
  }
}

// ---- Webhook actions ----
async function loadWebhooks() {
  if (!props.client) return
  webhooksLoading.value = true
  error.value = null
  try {
    webhooks.value = await props.client.listWebhooks()
  } catch (err) {
    error.value = err instanceof Error ? err.message : a('error.loadWebhooks')
  } finally {
    webhooksLoading.value = false
  }
}

function openWebhookForm() {
  editingWebhookId.value = null
  webhookDraft.value = {
    name: '',
    url: '',
    events: [],
    secret: '',
    maxRetries: '',
    retryBaseDelayMs: '',
    retryMaxDelayMs: '',
  }
  showWebhookForm.value = true
}

function openEditWebhook(wh: Webhook) {
  editingWebhookId.value = wh.id
  webhookDraft.value = {
    name: wh.name,
    url: wh.url,
    events: [...wh.events],
    secret: wh.secret ?? '',
    maxRetries: wh.maxRetries != null ? String(wh.maxRetries) : '',
    retryBaseDelayMs: wh.retryBaseDelayMs != null ? String(wh.retryBaseDelayMs) : '',
    retryMaxDelayMs: wh.retryMaxDelayMs != null ? String(wh.retryMaxDelayMs) : '',
  }
  showWebhookForm.value = true
}

function cancelWebhookForm() {
  showWebhookForm.value = false
  editingWebhookId.value = null
}

function onToggleEvent(evt: string) {
  const idx = webhookDraft.value.events.indexOf(evt)
  if (idx >= 0) {
    webhookDraft.value.events.splice(idx, 1)
  } else {
    webhookDraft.value.events.push(evt)
  }
}

async function onSaveWebhook() {
  if (!props.client || busy.value || !canSaveWebhook.value) return
  busy.value = true
  error.value = null
  try {
    const policy = webhookRetryPolicy.value
    const input = {
      name: webhookDraft.value.name.trim(),
      url: webhookDraft.value.url.trim(),
      events: webhookDraft.value.events,
      secret: webhookDraft.value.secret || undefined,
      maxRetries: policy.maxRetries.value,
      retryBaseDelayMs: policy.retryBaseDelayMs.value,
      retryMaxDelayMs: policy.retryMaxDelayMs.value,
    }
    if (editingWebhookId.value) {
      await props.client.updateWebhook(editingWebhookId.value, input)
    } else {
      await props.client.createWebhook(input)
    }
    cancelWebhookForm()
    await loadWebhooks()
  } catch (err) {
    error.value = err instanceof Error ? err.message : a('error.saveWebhook')
  } finally {
    busy.value = false
  }
}

async function onToggleWebhook(wh: Webhook) {
  if (!props.client || busy.value) return
  busy.value = true
  error.value = null
  try {
    await props.client.updateWebhook(wh.id, { active: !wh.active })
    await loadWebhooks()
  } catch (err) {
    error.value = err instanceof Error ? err.message : a('error.toggleWebhook')
  } finally {
    busy.value = false
  }
}

async function onDeleteWebhook(id: string) {
  if (!props.client || busy.value) return
  busy.value = true
  error.value = null
  try {
    await props.client.deleteWebhook(id)
    if (deliveriesWebhookId.value === id) {
      deliveriesWebhookId.value = null
      deliveries.value = []
    }
    await loadWebhooks()
  } catch (err) {
    error.value = err instanceof Error ? err.message : a('error.deleteWebhook')
  } finally {
    busy.value = false
  }
}

async function onViewDeliveries(webhookId: string) {
  if (!props.client) return
  if (deliveriesWebhookId.value === webhookId) {
    deliveriesWebhookId.value = null
    deliveries.value = []
    return
  }
  error.value = null
  try {
    deliveries.value = await props.client.getWebhookDeliveries(webhookId)
    deliveriesWebhookId.value = webhookId
  } catch (err) {
    error.value = err instanceof Error ? err.message : a('error.loadDeliveries')
  }
}

// ---- DingTalk group actions ----
async function loadDingTalkGroups() {
  if (!props.client) return
  if (!canManageDingTalkGroups.value) {
    clearDingTalkGroupState()
    dingTalkGroupsLoading.value = false
    return
  }
  dingTalkGroupsLoading.value = true
  error.value = null
  try {
    dingTalkGroups.value = await props.client.listDingTalkGroups(props.sheetId)
  } catch (err) {
    error.value = err instanceof Error ? err.message : a('error.loadDingTalkGroups')
  } finally {
    dingTalkGroupsLoading.value = false
  }
}

function clearDingTalkGroupState() {
  dingTalkGroups.value = []
  showDingTalkGroupForm.value = false
  editingDingTalkGroupId.value = null
  editingDingTalkGroupOriginal.value = null
  dingTalkDeliveriesRequestToken += 1
  dingTalkDeliveriesGroupId.value = null
  dingTalkDeliveriesLoading.value = false
  dingTalkDeliveries.value = []
  if (activeTab.value === 'dingtalk-groups') {
    activeTab.value = 'tokens'
  }
}

function openDingTalkGroupForm() {
  if (!canManageDingTalkGroups.value) return
  editingDingTalkGroupId.value = null
  editingDingTalkGroupOriginal.value = null
  dingTalkGroupDraft.value = {
    name: '',
    webhookUrl: '',
    secret: '',
    clearSecret: false,
    enabled: true,
  }
  showDingTalkGroupForm.value = true
}

function openEditDingTalkGroup(group: DingTalkGroupDestination) {
  if (!canManageDingTalkGroups.value || !canMutateDingTalkGroup(group)) return
  editingDingTalkGroupId.value = group.id
  editingDingTalkGroupOriginal.value = {
    webhookUrl: group.webhookUrl,
    hasSecret: group.hasSecret === true || Boolean(group.secret),
  }
  dingTalkGroupDraft.value = {
    name: group.name,
    webhookUrl: group.webhookUrl,
    secret: '',
    clearSecret: false,
    enabled: group.enabled,
  }
  showDingTalkGroupForm.value = true
}

function cancelDingTalkGroupForm() {
  showDingTalkGroupForm.value = false
  editingDingTalkGroupId.value = null
  editingDingTalkGroupOriginal.value = null
}

async function onSaveDingTalkGroup() {
  if (!props.client || busy.value || !canManageDingTalkGroups.value || !canSaveDingTalkGroup.value) return
  busy.value = true
  error.value = null
  try {
    const name = dingTalkGroupDraft.value.name.trim()
    const webhookUrl = dingTalkGroupDraft.value.webhookUrl.trim()
    const secret = dingTalkGroupDraft.value.secret.trim()
    if (editingDingTalkGroupId.value) {
      const updateInput: { name: string; webhookUrl?: string; secret?: string; enabled: boolean } = {
        name,
        enabled: dingTalkGroupDraft.value.enabled,
      }
      if (dingTalkGroupWebhookChanged.value) updateInput.webhookUrl = webhookUrl
      if (dingTalkGroupDraft.value.clearSecret) {
        updateInput.secret = ''
      } else if (secret) {
        updateInput.secret = secret
      }
      await props.client.updateDingTalkGroup(editingDingTalkGroupId.value, updateInput, props.sheetId)
    } else {
      await props.client.createDingTalkGroup({
        name,
        webhookUrl,
        secret: secret || undefined,
        enabled: dingTalkGroupDraft.value.enabled,
        sheetId: props.sheetId,
      })
    }
    cancelDingTalkGroupForm()
    await loadDingTalkGroups()
  } catch (err) {
    error.value = err instanceof Error ? err.message : a('error.saveDingTalkGroup')
  } finally {
    busy.value = false
  }
}

async function onToggleDingTalkGroup(group: DingTalkGroupDestination) {
  if (!props.client || busy.value || !canManageDingTalkGroups.value || !canMutateDingTalkGroup(group)) return
  busy.value = true
  error.value = null
  try {
    await props.client.updateDingTalkGroup(group.id, { enabled: !group.enabled }, props.sheetId)
    await loadDingTalkGroups()
  } catch (err) {
    error.value = err instanceof Error ? err.message : a('error.toggleDingTalkGroup')
  } finally {
    busy.value = false
  }
}

async function onTestDingTalkGroup(group: DingTalkGroupDestination) {
  if (!props.client || busy.value || !canManageDingTalkGroups.value || !canMutateDingTalkGroup(group)) return
  const groupId = group.id
  busy.value = true
  error.value = null
  try {
    await props.client.testDingTalkGroup(groupId, undefined, props.sheetId)
    await loadDingTalkGroups()
    if (dingTalkDeliveriesGroupId.value === groupId) {
      await loadDingTalkDeliveries(group)
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : a('error.testDingTalkGroup')
  } finally {
    busy.value = false
  }
}

async function loadDingTalkDeliveries(group: DingTalkGroupDestination) {
  if (!props.client || !canManageDingTalkGroups.value) return
  const groupId = group.id
  const sheetId = dingTalkGroupScope(group) === 'org' ? undefined : props.sheetId
  const requestToken = ++dingTalkDeliveriesRequestToken
  dingTalkDeliveriesGroupId.value = groupId
  dingTalkDeliveriesLoading.value = true
  dingTalkDeliveries.value = []
  error.value = null
  try {
    const deliveries = await props.client.getDingTalkGroupDeliveries(groupId, sheetId)
    if (requestToken !== dingTalkDeliveriesRequestToken || dingTalkDeliveriesGroupId.value !== groupId) {
      return
    }
    dingTalkDeliveries.value = deliveries
  } catch (err) {
    if (requestToken !== dingTalkDeliveriesRequestToken || dingTalkDeliveriesGroupId.value !== groupId) {
      return
    }
    error.value = err instanceof Error ? err.message : a('error.loadDingTalkDeliveries')
  } finally {
    if (requestToken === dingTalkDeliveriesRequestToken && dingTalkDeliveriesGroupId.value === groupId) {
      dingTalkDeliveriesLoading.value = false
    }
  }
}

async function onViewDingTalkDeliveries(group: DingTalkGroupDestination) {
  if (!props.client || !canManageDingTalkGroups.value) return
  const groupId = group.id
  if (dingTalkDeliveriesGroupId.value === groupId) {
    dingTalkDeliveriesRequestToken += 1
    dingTalkDeliveriesGroupId.value = null
    dingTalkDeliveriesLoading.value = false
    dingTalkDeliveries.value = []
    return
  }
  await loadDingTalkDeliveries(group)
}

async function onDeleteDingTalkGroup(group: DingTalkGroupDestination) {
  if (!props.client || busy.value || !canManageDingTalkGroups.value || !canMutateDingTalkGroup(group)) return
  const groupId = group.id
  busy.value = true
  error.value = null
  try {
    await props.client.deleteDingTalkGroup(groupId, props.sheetId)
    if (dingTalkDeliveriesGroupId.value === groupId) {
      dingTalkDeliveriesRequestToken += 1
      dingTalkDeliveriesGroupId.value = null
      dingTalkDeliveriesLoading.value = false
      dingTalkDeliveries.value = []
    }
    await loadDingTalkGroups()
  } catch (err) {
    error.value = err instanceof Error ? err.message : a('error.deleteDingTalkGroup')
  } finally {
    busy.value = false
  }
}

watch(
  () => props.visible,
  (v) => {
    if (v) {
      error.value = null
      newTokenPlaintext.value = null
      void loadTokens()
      void loadWebhooks()
      void loadDingTalkGroups()
    }
  },
  { immediate: true },
)

watch(canManageDingTalkGroups, (canManage) => {
  if (!props.visible) return
  if (canManage) {
    void loadDingTalkGroups()
  } else {
    clearDingTalkGroupState()
  }
})
</script>

<style scoped>
.meta-api-mgr__overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
}

.meta-api-mgr {
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
  width: 640px;
  max-width: 95vw;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
}

.meta-api-mgr__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 20px 12px;
  border-bottom: 1px solid #e2e8f0;
}

.meta-api-mgr__title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #0f172a;
}

.meta-api-mgr__close {
  border: none;
  background: none;
  font-size: 22px;
  cursor: pointer;
  color: #64748b;
  line-height: 1;
  padding: 0 4px;
}

.meta-api-mgr__tabs {
  display: flex;
  border-bottom: 1px solid #e2e8f0;
  padding: 0 20px;
}

.meta-api-mgr__tab {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 10px 16px;
  font-size: 13px;
  font-weight: 600;
  color: #64748b;
  cursor: pointer;
}

.meta-api-mgr__tab--active {
  color: #2563eb;
  border-bottom-color: #2563eb;
}

.meta-api-mgr__body {
  padding: 16px 20px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.meta-api-mgr__error {
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
  background: #fef2f2;
  color: #b91c1c;
}

.meta-api-mgr__notice {
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
  background: #eff6ff;
  color: #1e3a8a;
  border: 1px solid #bfdbfe;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.meta-api-mgr__empty {
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
  background: #f8fafc;
  color: #64748b;
}

.meta-api-mgr__new-token {
  border: 2px solid #f59e0b;
  border-radius: 10px;
  padding: 14px;
  background: #fffbeb;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.meta-api-mgr__token-display {
  display: flex;
  gap: 8px;
  align-items: center;
}

.meta-api-mgr__token-display code {
  flex: 1;
  word-break: break-all;
  background: #fff;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid #e5e7eb;
  font-size: 12px;
}

.meta-api-mgr__warning {
  margin: 0;
  font-size: 12px;
  color: #92400e;
  font-weight: 600;
}

/* Form */
.meta-api-mgr__form {
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.meta-api-mgr__form-title {
  font-size: 14px;
  font-weight: 600;
  color: #0f172a;
  margin-bottom: 4px;
}

.meta-api-mgr__label {
  font-size: 12px;
  font-weight: 600;
  color: #475569;
  margin-top: 4px;
}

.meta-api-mgr__input {
  width: 100%;
  min-width: 0;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 13px;
  background: #fff;
  box-sizing: border-box;
}

.meta-api-mgr__help {
  margin: -2px 0 2px;
  font-size: 12px;
  line-height: 1.45;
  color: #64748b;
}

.meta-api-mgr__help--error {
  color: #b91c1c;
}

.meta-api-mgr__checkboxes {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.meta-api-mgr__checkbox-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: #334155;
  cursor: pointer;
}

.meta-api-mgr__form-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

/* Cards */
.meta-api-mgr__card {
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.meta-api-mgr__card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.meta-api-mgr__card-name {
  font-size: 14px;
  color: #0f172a;
}

.meta-api-mgr__card-prefix {
  font-size: 12px;
  color: #64748b;
  background: #f1f5f9;
  padding: 2px 6px;
  border-radius: 4px;
}

.meta-api-mgr__card-status[data-webhook-status="active"] {
  font-size: 12px;
  font-weight: 600;
  color: #166534;
}

.meta-api-mgr__card-status[data-webhook-status="disabled"] {
  font-size: 12px;
  font-weight: 600;
  color: #64748b;
}

.meta-api-mgr__card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: 12px;
  color: #64748b;
}

.meta-api-mgr__card-failures {
  color: #dc2626;
  font-weight: 600;
}

.meta-api-mgr__card-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

.meta-api-mgr__card-readonly {
  color: #64748b;
  font-size: 12px;
  font-weight: 600;
}

/* Deliveries */
.meta-api-mgr__deliveries {
  border-top: 1px solid #e2e8f0;
  padding-top: 8px;
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.meta-api-mgr__delivery-row {
  display: flex;
  gap: 10px;
  font-size: 12px;
  color: #475569;
}

.meta-api-mgr__delivery--ok {
  color: #166534;
  font-weight: 600;
}

.meta-api-mgr__delivery--fail {
  color: #dc2626;
  font-weight: 600;
}

/* Buttons */
.meta-api-mgr__btn {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 6px 14px;
  background: #fff;
  color: #0f172a;
  font-size: 13px;
  cursor: pointer;
}

.meta-api-mgr__btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.meta-api-mgr__btn--primary {
  border-color: #2563eb;
  background: #2563eb;
  color: #fff;
}

.meta-api-mgr__btn--danger {
  border-color: #ef4444;
  color: #b91c1c;
}

.meta-api-mgr__btn-add {
  align-self: flex-start;
}
</style>
