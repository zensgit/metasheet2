<template>
  <section class="elearning-installation" aria-label="Cloud classroom installation" :aria-busy="pending">
    <h2>Cloud classroom installation</h2>
    <p>Installation starts disabled. Deployment flags remain the upper bound; storage is managed separately.</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="pending" role="status">Working...</p>
    <template v-if="installation">
      <p role="status">{{ installation.status }}</p>
      <p>Notifications: {{ installation.notificationsEnabled ? 'enabled' : 'disabled' }}</p>
      <template v-if="installation.canManage">
      <button v-if="installation.status === 'not-installed'" type="button" :disabled="pending" @click="run('install')">
        Install
      </button>
      <template v-else>
        <label>
          <input v-model="notificationsEnabled" type="checkbox" :disabled="pending">
          Opt in to learning notifications
        </label>
        <div class="elearning-installation__actions">
          <button type="button" :disabled="pending" @click="run('toggle')">
            {{ installation.status === 'active' ? 'Disable' : 'Enable' }}
          </button>
          <button type="button" :disabled="pending || notificationsEnabled === installation.notificationsEnabled" @click="run('save')">
            Save notifications
          </button>
        </div>
      </template>
      </template>
    </template>
    <button v-else-if="!pending" type="button" @click="run('load')">Retry</button>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { getAuthPrincipalKey, onAuthPrincipalChange, readStoredToken } from '../composables/authPrincipal'
import {
  getElearningAppInstallation, installElearningApp, updateElearningAppInstallation,
  type ElearningAppInstallation,
} from '../services/elearningApp'

const emit = defineEmits<{ changed: [] }>()
const installation = ref<ElearningAppInstallation | null>(null)
const notificationsEnabled = ref(false)
const pending = ref(false)
const error = ref('')
let generation = 0
let installationIdentity: string | null = null

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
  } catch {
    if (current !== generation) return
    try {
      if (identity !== null && identity !== currentIdentity()) { reload(); return }
    } catch { /* Invalid session context remains closed. */ }
    installation.value = null
    installationIdentity = null
    notificationsEnabled.value = false
    error.value = 'elearning_installation_request_failed'
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
