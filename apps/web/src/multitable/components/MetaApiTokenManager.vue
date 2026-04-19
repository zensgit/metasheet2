<template>
  <div v-if="visible" class="meta-api-mgr__overlay" @click.self="$emit('close')">
    <div class="meta-api-mgr">
      <div class="meta-api-mgr__header">
        <h4 class="meta-api-mgr__title">API Tokens, Webhooks &amp; DingTalk Groups</h4>
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
          API Tokens
        </button>
        <button
          role="tab"
          :aria-selected="activeTab === 'webhooks'"
          class="meta-api-mgr__tab"
          :class="{ 'meta-api-mgr__tab--active': activeTab === 'webhooks' }"
          @click="activeTab = 'webhooks'"
        >
          Webhooks
        </button>
        <button
          role="tab"
          :aria-selected="activeTab === 'dingtalk-groups'"
          class="meta-api-mgr__tab"
          :class="{ 'meta-api-mgr__tab--active': activeTab === 'dingtalk-groups' }"
          @click="activeTab = 'dingtalk-groups'"
        >
          DingTalk Groups
        </button>
      </div>

      <div class="meta-api-mgr__body">
        <div v-if="error" class="meta-api-mgr__error" role="alert">{{ error }}</div>

        <!-- ===== TOKENS TAB ===== -->
        <template v-if="activeTab === 'tokens'">
          <!-- Newly created token (show once) -->
          <div v-if="newTokenPlaintext" class="meta-api-mgr__new-token" data-new-token="true">
            <strong>Your new API token (shown once):</strong>
            <div class="meta-api-mgr__token-display">
              <code data-new-token-value="true">{{ newTokenPlaintext }}</code>
              <button class="meta-api-mgr__btn meta-api-mgr__btn--primary" type="button" data-copy-new-token="true" @click="onCopyNewToken">
                {{ copiedNewToken ? 'Copied!' : 'Copy' }}
              </button>
            </div>
            <p class="meta-api-mgr__warning">Save this token now. You will not be able to see it again.</p>
            <button class="meta-api-mgr__btn" type="button" @click="newTokenPlaintext = null">Dismiss</button>
          </div>

          <!-- Create form -->
          <section v-if="showTokenForm" class="meta-api-mgr__form" data-token-form="true">
            <div class="meta-api-mgr__form-title">New API Token</div>
            <label class="meta-api-mgr__label">Name</label>
            <input v-model="tokenDraft.name" class="meta-api-mgr__input" type="text" placeholder="Token name" data-token-name="true" />
            <label class="meta-api-mgr__label">Scopes</label>
            <div class="meta-api-mgr__checkboxes">
              <label v-for="scope in availableScopes" :key="scope" class="meta-api-mgr__checkbox-label">
                <input type="checkbox" :value="scope" :checked="tokenDraft.scopes.includes(scope)" @change="onToggleScope(scope)" :data-token-scope="scope" />
                {{ scope }}
              </label>
            </div>
            <label class="meta-api-mgr__label">Expiry (optional)</label>
            <input v-model="tokenDraft.expiresAt" class="meta-api-mgr__input" type="date" data-token-expiry="true" />
            <div class="meta-api-mgr__form-actions">
              <button class="meta-api-mgr__btn meta-api-mgr__btn--primary" type="button" :disabled="!tokenDraft.name.trim() || busy" data-token-create="true" @click="onCreateToken">Create</button>
              <button class="meta-api-mgr__btn" type="button" @click="showTokenForm = false">Cancel</button>
            </div>
          </section>

          <button v-if="!showTokenForm" class="meta-api-mgr__btn meta-api-mgr__btn--primary meta-api-mgr__btn-add" type="button" data-token-new="true" @click="openTokenForm">+ New Token</button>

          <!-- Token list -->
          <div v-if="tokensLoading" class="meta-api-mgr__empty">Loading tokens&#x2026;</div>
          <div v-else-if="!tokens.length && !showTokenForm" class="meta-api-mgr__empty" data-tokens-empty="true">No API tokens yet.</div>
          <div v-for="token in tokens" :key="token.id" class="meta-api-mgr__card" :data-token-id="token.id">
            <div class="meta-api-mgr__card-header">
              <strong class="meta-api-mgr__card-name">{{ token.name }}</strong>
              <code class="meta-api-mgr__card-prefix">{{ token.prefix }}...</code>
            </div>
            <div class="meta-api-mgr__card-meta">
              <span>Scopes: {{ token.scopes.join(', ') || 'none' }}</span>
              <span>Created: {{ formatDate(token.createdAt) }}</span>
              <span v-if="token.lastUsedAt">Last used: {{ formatDate(token.lastUsedAt) }}</span>
              <span v-if="token.expiresAt">Expires: {{ formatDate(token.expiresAt) }}</span>
            </div>
            <div class="meta-api-mgr__card-actions">
              <button class="meta-api-mgr__btn" type="button" :disabled="busy" data-token-rotate="true" @click="onRotateToken(token.id)">Rotate</button>
              <button class="meta-api-mgr__btn meta-api-mgr__btn--danger" type="button" :disabled="busy" data-token-revoke="true" @click="onRevokeToken(token.id)">Revoke</button>
            </div>
          </div>
        </template>

        <!-- ===== WEBHOOKS TAB ===== -->
        <template v-if="activeTab === 'webhooks'">
          <!-- Create/Edit form -->
          <section v-if="showWebhookForm" class="meta-api-mgr__form" data-webhook-form="true">
            <div class="meta-api-mgr__form-title">{{ editingWebhookId ? 'Edit Webhook' : 'New Webhook' }}</div>
            <label class="meta-api-mgr__label">Name</label>
            <input v-model="webhookDraft.name" class="meta-api-mgr__input" type="text" placeholder="Webhook name" data-webhook-name="true" />
            <label class="meta-api-mgr__label">URL (HTTPS required)</label>
            <input v-model="webhookDraft.url" class="meta-api-mgr__input" type="url" placeholder="https://example.com/webhook" data-webhook-url="true" />
            <label class="meta-api-mgr__label">Events</label>
            <div class="meta-api-mgr__checkboxes">
              <label v-for="evt in availableEvents" :key="evt" class="meta-api-mgr__checkbox-label">
                <input type="checkbox" :value="evt" :checked="webhookDraft.events.includes(evt)" @change="onToggleEvent(evt)" :data-webhook-event="evt" />
                {{ evt }}
              </label>
            </div>
            <label class="meta-api-mgr__label">Secret (optional)</label>
            <input v-model="webhookDraft.secret" class="meta-api-mgr__input" type="text" placeholder="HMAC secret" data-webhook-secret="true" />
            <div class="meta-api-mgr__form-actions">
              <button class="meta-api-mgr__btn meta-api-mgr__btn--primary" type="button" :disabled="!canSaveWebhook || busy" data-webhook-save="true" @click="onSaveWebhook">
                {{ editingWebhookId ? 'Update' : 'Create' }}
              </button>
              <button class="meta-api-mgr__btn" type="button" @click="cancelWebhookForm">Cancel</button>
            </div>
          </section>

          <button v-if="!showWebhookForm" class="meta-api-mgr__btn meta-api-mgr__btn--primary meta-api-mgr__btn-add" type="button" data-webhook-new="true" @click="openWebhookForm">+ New Webhook</button>

          <!-- Webhook list -->
          <div v-if="webhooksLoading" class="meta-api-mgr__empty">Loading webhooks&#x2026;</div>
          <div v-else-if="!webhooks.length && !showWebhookForm" class="meta-api-mgr__empty" data-webhooks-empty="true">No webhooks yet.</div>
          <div v-for="wh in webhooks" :key="wh.id" class="meta-api-mgr__card" :data-webhook-id="wh.id">
            <div class="meta-api-mgr__card-header">
              <strong class="meta-api-mgr__card-name">{{ wh.name }}</strong>
              <span class="meta-api-mgr__card-status" :data-webhook-status="wh.active ? 'active' : 'disabled'">
                {{ wh.active ? 'Active' : 'Disabled' }}
              </span>
            </div>
            <div class="meta-api-mgr__card-meta">
              <span>URL: {{ wh.url }}</span>
              <span>Events: {{ wh.events.join(', ') }}</span>
              <span v-if="wh.failureCount > 0" class="meta-api-mgr__card-failures">Failures: {{ wh.failureCount }}</span>
            </div>
            <div class="meta-api-mgr__card-actions">
              <button class="meta-api-mgr__btn" type="button" data-webhook-edit="true" @click="openEditWebhook(wh)">Edit</button>
              <button class="meta-api-mgr__btn" type="button" data-webhook-toggle="true" :disabled="busy" @click="onToggleWebhook(wh)">
                {{ wh.active ? 'Disable' : 'Enable' }}
              </button>
              <button class="meta-api-mgr__btn" type="button" data-webhook-deliveries="true" @click="onViewDeliveries(wh.id)">Deliveries</button>
              <button class="meta-api-mgr__btn meta-api-mgr__btn--danger" type="button" :disabled="busy" data-webhook-delete="true" @click="onDeleteWebhook(wh.id)">Delete</button>
            </div>

            <!-- Delivery history (inline) -->
            <div v-if="deliveriesWebhookId === wh.id && deliveries.length" class="meta-api-mgr__deliveries" data-deliveries="true">
              <strong class="meta-api-mgr__label">Recent Deliveries</strong>
              <div v-for="d in deliveries" :key="d.id" class="meta-api-mgr__delivery-row" :data-delivery-id="d.id">
                <span :class="d.success ? 'meta-api-mgr__delivery--ok' : 'meta-api-mgr__delivery--fail'">
                  {{ d.success ? 'OK' : 'FAIL' }}
                </span>
                <span>{{ d.event }}</span>
                <span>HTTP {{ d.httpStatus ?? '-' }}</span>
                <span v-if="d.retryCount > 0">Retries: {{ d.retryCount }}</span>
                <span>{{ formatDate(d.timestamp) }}</span>
              </div>
            </div>
          </div>
        </template>

        <!-- ===== DINGTALK GROUPS TAB ===== -->
        <template v-if="activeTab === 'dingtalk-groups'">
          <section v-if="showDingTalkGroupForm" class="meta-api-mgr__form" data-dingtalk-group-form="true">
            <div class="meta-api-mgr__form-title">
              {{ editingDingTalkGroupId ? 'Edit DingTalk Group' : 'New DingTalk Group' }}
            </div>
            <label class="meta-api-mgr__label">Name</label>
            <input
              v-model="dingTalkGroupDraft.name"
              class="meta-api-mgr__input"
              type="text"
              placeholder="Support group"
              data-dingtalk-group-name="true"
            />
            <label class="meta-api-mgr__label">Webhook URL</label>
            <input
              v-model="dingTalkGroupDraft.webhookUrl"
              class="meta-api-mgr__input"
              type="url"
              placeholder="https://oapi.dingtalk.com/robot/send?access_token=..."
              data-dingtalk-group-webhook-url="true"
            />
            <label class="meta-api-mgr__label">Secret (optional)</label>
            <input
              v-model="dingTalkGroupDraft.secret"
              class="meta-api-mgr__input"
              type="text"
              placeholder="SEC..."
              data-dingtalk-group-secret="true"
            />
            <label class="meta-api-mgr__checkbox-label">
              <input
                v-model="dingTalkGroupDraft.enabled"
                type="checkbox"
                data-dingtalk-group-enabled="true"
              />
              Enabled
            </label>
            <div class="meta-api-mgr__form-actions">
              <button
                class="meta-api-mgr__btn meta-api-mgr__btn--primary"
                type="button"
                :disabled="!canSaveDingTalkGroup || busy"
                data-dingtalk-group-save="true"
                @click="onSaveDingTalkGroup"
              >
                {{ editingDingTalkGroupId ? 'Update' : 'Create' }}
              </button>
              <button class="meta-api-mgr__btn" type="button" @click="cancelDingTalkGroupForm">Cancel</button>
            </div>
          </section>

          <button
            v-if="!showDingTalkGroupForm"
            class="meta-api-mgr__btn meta-api-mgr__btn--primary meta-api-mgr__btn-add"
            type="button"
            data-dingtalk-group-new="true"
            @click="openDingTalkGroupForm"
          >
            + New DingTalk Group
          </button>

          <div v-if="dingTalkGroupsLoading" class="meta-api-mgr__empty">Loading DingTalk groups&#x2026;</div>
          <div
            v-else-if="!dingTalkGroups.length && !showDingTalkGroupForm"
            class="meta-api-mgr__empty"
            data-dingtalk-groups-empty="true"
          >
            No DingTalk groups yet.
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
                {{ group.enabled ? 'Enabled' : 'Disabled' }}
              </span>
            </div>
            <div class="meta-api-mgr__card-meta">
              <span>Webhook: {{ maskDingTalkWebhookUrl(group.webhookUrl) }}</span>
              <span>Created: {{ formatDate(group.createdAt) }}</span>
              <span v-if="group.lastTestedAt">Last test: {{ formatDate(group.lastTestedAt) }}</span>
              <span v-if="group.lastTestStatus" :data-dingtalk-group-test-status="group.lastTestStatus">
                Test status: {{ group.lastTestStatus }}
              </span>
            </div>
            <div v-if="group.lastTestError" class="meta-api-mgr__card-meta meta-api-mgr__card-failures">
              <span>Last error: {{ group.lastTestError }}</span>
            </div>
            <div class="meta-api-mgr__card-actions">
              <button class="meta-api-mgr__btn" type="button" data-dingtalk-group-edit="true" @click="openEditDingTalkGroup(group)">
                Edit
              </button>
              <button class="meta-api-mgr__btn" type="button" :disabled="busy" data-dingtalk-group-toggle="true" @click="onToggleDingTalkGroup(group)">
                {{ group.enabled ? 'Disable' : 'Enable' }}
              </button>
              <button class="meta-api-mgr__btn" type="button" data-dingtalk-group-deliveries="true" @click="onViewDingTalkDeliveries(group.id)">
                Deliveries
              </button>
              <button class="meta-api-mgr__btn" type="button" :disabled="busy" data-dingtalk-group-test-send="true" @click="onTestDingTalkGroup(group.id)">
                Test send
              </button>
              <button class="meta-api-mgr__btn meta-api-mgr__btn--danger" type="button" :disabled="busy" data-dingtalk-group-delete="true" @click="onDeleteDingTalkGroup(group.id)">
                Delete
              </button>
            </div>

            <div
              v-if="dingTalkDeliveriesGroupId === group.id"
              class="meta-api-mgr__deliveries"
              data-dingtalk-deliveries="true"
            >
              <strong class="meta-api-mgr__label">Recent Deliveries</strong>
              <div v-if="dingTalkDeliveriesLoading" class="meta-api-mgr__empty" data-dingtalk-deliveries-loading="true">
                Loading DingTalk deliveries…
              </div>
              <div
                v-else-if="!dingTalkDeliveries.length"
                class="meta-api-mgr__empty"
                data-dingtalk-deliveries-empty="true"
              >
                No DingTalk deliveries yet.
              </div>
              <template v-else>
                <div
                  v-for="delivery in dingTalkDeliveries"
                  :key="delivery.id"
                  class="meta-api-mgr__delivery-row"
                  :data-dingtalk-delivery-id="delivery.id"
                >
                  <span :class="delivery.success ? 'meta-api-mgr__delivery--ok' : 'meta-api-mgr__delivery--fail'">
                    {{ delivery.success ? 'OK' : 'FAIL' }}
                  </span>
                  <span>{{ delivery.sourceType === 'manual_test' ? 'Manual test' : 'Automation' }}</span>
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
import type {
  ApiToken,
  DingTalkGroupDelivery,
  DingTalkGroupDestination,
  Webhook,
  WebhookDelivery,
} from '../types'
import type { MultitableApiClient } from '../api/client'

const props = defineProps<{
  visible: boolean
  client?: MultitableApiClient
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const activeTab = ref<'tokens' | 'webhooks' | 'dingtalk-groups'>('tokens')
const error = ref<string | null>(null)
const busy = ref(false)

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
const editingWebhookId = ref<string | null>(null)
const webhookDraft = ref({ name: '', url: '', events: [] as string[], secret: '' })
const availableEvents = ['record.created', 'record.updated', 'record.deleted', 'field.changed']
const deliveriesWebhookId = ref<string | null>(null)
const deliveries = ref<WebhookDelivery[]>([])

// ---- DingTalk groups ----
const dingTalkGroups = ref<DingTalkGroupDestination[]>([])
const dingTalkGroupsLoading = ref(false)
const showDingTalkGroupForm = ref(false)
const editingDingTalkGroupId = ref<string | null>(null)
const dingTalkDeliveriesGroupId = ref<string | null>(null)
const dingTalkDeliveriesLoading = ref(false)
const dingTalkDeliveries = ref<DingTalkGroupDelivery[]>([])
let dingTalkDeliveriesRequestToken = 0
const dingTalkGroupDraft = ref({
  name: '',
  webhookUrl: '',
  secret: '',
  enabled: true,
})

const canSaveWebhook = computed(() => {
  return webhookDraft.value.name.trim() && webhookDraft.value.url.startsWith('https://') && webhookDraft.value.events.length > 0
})

const canSaveDingTalkGroup = computed(() => {
  return dingTalkGroupDraft.value.name.trim() && dingTalkGroupDraft.value.webhookUrl.trim().startsWith('https://')
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

// ---- Token actions ----
async function loadTokens() {
  if (!props.client) return
  tokensLoading.value = true
  error.value = null
  try {
    tokens.value = await props.client.listApiTokens()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load tokens'
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
    error.value = err instanceof Error ? err.message : 'Failed to create token'
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
    error.value = err instanceof Error ? err.message : 'Failed to revoke token'
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
    error.value = err instanceof Error ? err.message : 'Failed to rotate token'
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
    error.value = err instanceof Error ? err.message : 'Failed to load webhooks'
  } finally {
    webhooksLoading.value = false
  }
}

function openWebhookForm() {
  editingWebhookId.value = null
  webhookDraft.value = { name: '', url: '', events: [], secret: '' }
  showWebhookForm.value = true
}

function openEditWebhook(wh: Webhook) {
  editingWebhookId.value = wh.id
  webhookDraft.value = {
    name: wh.name,
    url: wh.url,
    events: [...wh.events],
    secret: wh.secret ?? '',
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
    const input = {
      name: webhookDraft.value.name.trim(),
      url: webhookDraft.value.url.trim(),
      events: webhookDraft.value.events,
      secret: webhookDraft.value.secret || undefined,
    }
    if (editingWebhookId.value) {
      await props.client.updateWebhook(editingWebhookId.value, input)
    } else {
      await props.client.createWebhook(input)
    }
    cancelWebhookForm()
    await loadWebhooks()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to save webhook'
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
    error.value = err instanceof Error ? err.message : 'Failed to toggle webhook'
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
    error.value = err instanceof Error ? err.message : 'Failed to delete webhook'
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
    error.value = err instanceof Error ? err.message : 'Failed to load deliveries'
  }
}

// ---- DingTalk group actions ----
async function loadDingTalkGroups() {
  if (!props.client) return
  dingTalkGroupsLoading.value = true
  error.value = null
  try {
    dingTalkGroups.value = await props.client.listDingTalkGroups()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load DingTalk groups'
  } finally {
    dingTalkGroupsLoading.value = false
  }
}

function openDingTalkGroupForm() {
  editingDingTalkGroupId.value = null
  dingTalkGroupDraft.value = {
    name: '',
    webhookUrl: '',
    secret: '',
    enabled: true,
  }
  showDingTalkGroupForm.value = true
}

function openEditDingTalkGroup(group: DingTalkGroupDestination) {
  editingDingTalkGroupId.value = group.id
  dingTalkGroupDraft.value = {
    name: group.name,
    webhookUrl: group.webhookUrl,
    secret: group.secret ?? '',
    enabled: group.enabled,
  }
  showDingTalkGroupForm.value = true
}

function cancelDingTalkGroupForm() {
  showDingTalkGroupForm.value = false
  editingDingTalkGroupId.value = null
}

async function onSaveDingTalkGroup() {
  if (!props.client || busy.value || !canSaveDingTalkGroup.value) return
  busy.value = true
  error.value = null
  try {
    const input = {
      name: dingTalkGroupDraft.value.name.trim(),
      webhookUrl: dingTalkGroupDraft.value.webhookUrl.trim(),
      secret: dingTalkGroupDraft.value.secret || undefined,
      enabled: dingTalkGroupDraft.value.enabled,
    }
    if (editingDingTalkGroupId.value) {
      await props.client.updateDingTalkGroup(editingDingTalkGroupId.value, input)
    } else {
      await props.client.createDingTalkGroup(input)
    }
    cancelDingTalkGroupForm()
    await loadDingTalkGroups()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to save DingTalk group'
  } finally {
    busy.value = false
  }
}

async function onToggleDingTalkGroup(group: DingTalkGroupDestination) {
  if (!props.client || busy.value) return
  busy.value = true
  error.value = null
  try {
    await props.client.updateDingTalkGroup(group.id, { enabled: !group.enabled })
    await loadDingTalkGroups()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to toggle DingTalk group'
  } finally {
    busy.value = false
  }
}

async function onTestDingTalkGroup(groupId: string) {
  if (!props.client || busy.value) return
  busy.value = true
  error.value = null
  try {
    await props.client.testDingTalkGroup(groupId)
    await loadDingTalkGroups()
    if (dingTalkDeliveriesGroupId.value === groupId) {
      await loadDingTalkDeliveries(groupId)
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to test DingTalk group'
  } finally {
    busy.value = false
  }
}

async function loadDingTalkDeliveries(groupId: string) {
  if (!props.client) return
  const requestToken = ++dingTalkDeliveriesRequestToken
  dingTalkDeliveriesGroupId.value = groupId
  dingTalkDeliveriesLoading.value = true
  dingTalkDeliveries.value = []
  error.value = null
  try {
    const deliveries = await props.client.getDingTalkGroupDeliveries(groupId)
    if (requestToken !== dingTalkDeliveriesRequestToken || dingTalkDeliveriesGroupId.value !== groupId) {
      return
    }
    dingTalkDeliveries.value = deliveries
  } catch (err) {
    if (requestToken !== dingTalkDeliveriesRequestToken || dingTalkDeliveriesGroupId.value !== groupId) {
      return
    }
    error.value = err instanceof Error ? err.message : 'Failed to load DingTalk deliveries'
  } finally {
    if (requestToken === dingTalkDeliveriesRequestToken && dingTalkDeliveriesGroupId.value === groupId) {
      dingTalkDeliveriesLoading.value = false
    }
  }
}

async function onViewDingTalkDeliveries(groupId: string) {
  if (!props.client) return
  if (dingTalkDeliveriesGroupId.value === groupId) {
    dingTalkDeliveriesRequestToken += 1
    dingTalkDeliveriesGroupId.value = null
    dingTalkDeliveriesLoading.value = false
    dingTalkDeliveries.value = []
    return
  }
  await loadDingTalkDeliveries(groupId)
}

async function onDeleteDingTalkGroup(groupId: string) {
  if (!props.client || busy.value) return
  busy.value = true
  error.value = null
  try {
    await props.client.deleteDingTalkGroup(groupId)
    if (dingTalkDeliveriesGroupId.value === groupId) {
      dingTalkDeliveriesRequestToken += 1
      dingTalkDeliveriesGroupId.value = null
      dingTalkDeliveriesLoading.value = false
      dingTalkDeliveries.value = []
    }
    await loadDingTalkGroups()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to delete DingTalk group'
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
  gap: 8px;
  margin-top: 4px;
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
