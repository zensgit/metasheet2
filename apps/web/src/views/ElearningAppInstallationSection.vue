<template>
  <ElearningSessionOrgStaleBanner
    v-if="sessionOrgStale"
    :is-zh="isZh"
    @reload="reloadSessionOrgPage"
  />
  <section
    class="elearning-installation"
    data-testid="elearning-installation"
    :aria-label="elearningLabel('installation.title', isZh)"
    :aria-busy="pending"
    :inert="sessionOrgStale || undefined"
    :aria-hidden="sessionOrgStale || undefined"
  >
    <h2>{{ elearningLabel('installation.title', isZh) }}</h2>
    <p>{{ elearningLabel('installation.intro', isZh) }}</p>
    <SessionOrgSwitcher
      v-if="sessionOrgVisible"
      :tr="sessionOrgText"
      :orgs="sessionOrgIds"
      :model-value="sessionOrgSelectedId"
      :loading="sessionOrgLoading"
      :switching="sessionOrgSwitching"
      :disabled="pending"
      :error-message="sessionOrgError"
      :has-usable-claim="Boolean(sessionOrgCurrentId)"
      @change="changeSessionOrg"
    />
    <p v-if="error" role="alert">{{ errorText }}</p>
    <p v-if="pending" role="status">{{ elearningLabel('installation.working', isZh) }}</p>
    <template v-if="installation">
      <p role="status" data-testid="elearning-installation-status">
        {{ elearningInstallationStatusLabel(installation.status, isZh) }}
      </p>
      <p data-testid="elearning-installation-notifications">{{ notificationsText }}</p>
      <template v-if="installation.canManage">
      <button v-if="installation.status === 'not-installed'" type="button" :disabled="pending" @click="run('install')">
        {{ elearningLabel('installation.install', isZh) }}
      </button>
      <template v-else>
        <!-- F12: the opt-in only exists where the deployment can deliver notifications. -->
        <label v-if="notificationsAvailable">
          <input v-model="notificationsEnabled" type="checkbox" :disabled="pending">
          {{ elearningLabel('installation.notificationsOptIn', isZh) }}
        </label>
        <div class="elearning-installation__actions">
          <button type="button" :disabled="pending" @click="run('toggle')">
            {{ elearningLabel(installation.status === 'active' ? 'installation.disable' : 'installation.enable', isZh) }}
          </button>
          <button
            v-if="notificationsAvailable"
            type="button"
            :disabled="pending || notificationsEnabled === installation.notificationsEnabled"
            @click="run('save')"
          >
            {{ elearningLabel('installation.saveNotifications', isZh) }}
          </button>
        </div>
      </template>
      </template>
    </template>
    <button v-else-if="!pending" type="button" @click="run('load')">
      {{ elearningLabel('installation.retry', isZh) }}
    </button>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { getAuthPrincipalKey, onAuthPrincipalChange, readStoredToken } from '../composables/authPrincipal'
import { useLocale } from '../composables/useLocale'
import SessionOrgSwitcher from '../components/SessionOrgSwitcher.vue'
import { useElearningSessionOrg } from '../composables/useElearningSessionOrg'
import ElearningSessionOrgStaleBanner from './ElearningSessionOrgStaleBanner.vue'
import {
  getElearningAppInstallation, installElearningApp, updateElearningAppInstallation,
  type ElearningAppInstallation,
} from '../services/elearningApp'
import {
  elearningErrorMessage,
  elearningInstallationStatusLabel,
  elearningLabel,
  isElearningOrgContextRequired,
} from './elearningLabels'

const INSTALLATION_REQUEST_FAILED = 'elearning_installation_request_failed'

// F12: whether the deployment can deliver learning notifications. Neither
// GET /api/elearning-app/installation (exactly status/notificationsEnabled/canManage) nor
// GET /api/elearning/capabilities (no notifications key) exposes the server's
// ELEARNING_NOTIFICATIONS_ENABLED flag today, and no caller passes this prop, so the opt-in
// stays hidden. Hiding it never rewrites the stored opt-in: Enable/Disable still sends the
// stored notificationsEnabled value back unchanged.
const props = withDefaults(defineProps<{ notificationsAvailable?: boolean }>(), {
  notificationsAvailable: false,
})
const notificationsAvailable = computed(() => props.notificationsAvailable === true)
const emit = defineEmits<{ changed: [] }>()
const installation = ref<ElearningAppInstallation | null>(null)
const notificationsEnabled = ref(false)
const pending = ref(false)
const error = ref('')
let generation = 0
let installationIdentity: string | null = null
const { isZh } = useLocale()
const {
  visible: sessionOrgVisible,
  orgs: sessionOrgIds,
  selectedOrgId: sessionOrgSelectedId,
  currentOrgId: sessionOrgCurrentId,
  loading: sessionOrgLoading,
  switching: sessionOrgSwitching,
  errorMessage: sessionOrgError,
  stale: sessionOrgStale,
  changeSessionOrg,
  reloadPage: reloadSessionOrgPage,
  explainOrgContext,
} = useElearningSessionOrg()

function sessionOrgText(en: string, zh: string): string {
  return isZh.value ? zh : en
}

// The closed failure token is kept as the stored value (and stays the English text); it is
// shown as a localized sentence so a zh-CN operator never reads the raw token.
const errorText = computed(() => (
  error.value === INSTALLATION_REQUEST_FAILED
    ? elearningLabel('installation.requestFailed', isZh.value)
    : explainOrgContext(error.value)
))

const notificationsText = computed(() => {
  if (!notificationsAvailable.value) return elearningLabel('installation.notificationsUnavailable', isZh.value)
  return elearningLabel(
    installation.value?.notificationsEnabled ? 'installation.notificationsEnabled' : 'installation.notificationsDisabled',
    isZh.value,
  )
})

// Only the org-context gate's 403 is explained (the client keeps its status and code and
// nothing else); every other failure keeps the closed `elearning_installation_request_failed`.
function failureText(failure: unknown): string {
  const { code, status } = (failure && typeof failure === 'object' ? failure : {}) as {
    code?: unknown
    status?: unknown
  }
  if (isElearningOrgContextRequired(code, status)) {
    return elearningErrorMessage(code as string, status as number, isZh.value)
  }
  return INSTALLATION_REQUEST_FAILED
}

function currentIdentity(): string {
  return JSON.stringify([getAuthPrincipalKey(), readStoredToken()])
}

function clear(): void {
  generation++
  installation.value = null
  installationIdentity = null
  notificationsEnabled.value = false
  pending.value = false
  error.value = ''
}

function reload(): void {
  clear()
  void run('load')
}

async function run(action: 'load' | 'install' | 'toggle' | 'save'): Promise<void> {
  if (pending.value) return
  const current = ++generation
  pending.value = true
  error.value = ''
  let identity: string | null = null
  try {
    identity = currentIdentity()
    if (action !== 'load') {
      if (installationIdentity !== identity) { reload(); return }
      if (!installation.value?.canManage) return
    }
    const next = action === 'load'
      ? await getElearningAppInstallation()
      : action === 'install'
        ? await installElearningApp()
        : await updateElearningAppInstallation(
          action === 'toggle' ? installation.value?.status !== 'active' : installation.value?.status === 'active',
          notificationsEnabled.value,
        )
    if (current !== generation) return
    if (identity !== currentIdentity()) { reload(); return }
    installation.value = next
    installationIdentity = identity
    notificationsEnabled.value = next.notificationsEnabled
    if (action !== 'load') emit('changed')
  } catch (failure) {
    if (current !== generation) return
    try {
      if (identity !== null && identity !== currentIdentity()) { reload(); return }
    } catch { /* Invalid session context remains closed. */ }
    installation.value = null
    installationIdentity = null
    notificationsEnabled.value = false
    error.value = failureText(failure)
  } finally {
    if (current === generation) pending.value = false
  }
}

const unsubscribe = onAuthPrincipalChange(reload)
function onStorage(): void {
  try {
    if (installationIdentity === currentIdentity()) return
  } catch { /* Reload fails closed for invalid session context. */ }
  reload()
}
onMounted(() => {
  window.addEventListener('storage', onStorage)
  void run('load')
})
onBeforeUnmount(() => {
  generation++
  unsubscribe()
  window.removeEventListener('storage', onStorage)
})
</script>

<style scoped>
.elearning-installation {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  border: 1px solid #dbe2ea;
  border-radius: 18px;
  background: #fff;
}
.elearning-installation__actions { display: flex; gap: 12px; }
.elearning-installation button {
  align-self: flex-start;
  border: 1px solid #dbe2ea;
  border-radius: 12px;
  padding: 10px 14px;
  background: #fff;
  color: #1d4ed8;
  font: inherit;
  cursor: pointer;
}
.elearning-installation button:disabled { opacity: 0.5; cursor: not-allowed; }
.elearning-installation [role='alert'] { color: #b91c1c; }
</style>
