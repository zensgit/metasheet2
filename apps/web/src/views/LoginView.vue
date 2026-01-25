<template>
  <div class="login">
    <header class="login__header">
      <div>
        <h2>Login</h2>
        <p class="login__subtitle">Sign in to access protected modules.</p>
      </div>
      <div class="login__meta" v-if="redirectPath">
        Redirect after login: <span class="login__path">{{ redirectPath }}</span>
      </div>
    </header>

    <div class="login__card">
      <div v-if="hasToken" class="login__notice">
        <h3>Already signed in</h3>
        <p class="login__subtitle">A token is already stored for this browser.</p>
        <div class="login__actions">
          <button class="login__btn login__btn--primary" @click="continueToRedirect">Continue</button>
          <button class="login__btn" @click="clearToken">Clear token</button>
        </div>
      </div>

      <form v-else class="login__form" @submit.prevent="submit">
        <label class="login__field">
          <span>Email</span>
          <input v-model="email" type="email" autocomplete="username" placeholder="admin@metasheet.app" />
        </label>
        <label class="login__field">
          <span>Password</span>
          <input v-model="password" type="password" autocomplete="current-password" placeholder="••••••••" />
        </label>
        <div class="login__actions">
          <button class="login__btn login__btn--primary" type="submit" :disabled="loading">
            {{ loading ? 'Signing in...' : 'Sign in' }}
          </button>
          <button class="login__btn" type="button" :disabled="loading" @click="goHome">Cancel</button>
        </div>
      </form>

      <p v-if="statusMessage" class="login__status" :class="{ 'login__status--error': statusKind === 'error' }">
        {{ statusMessage }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { clearStoredAuthToken, getApiBase, getStoredAuthToken, setStoredAuthToken } from '../utils/api'

const router = useRouter()
const route = useRoute()

const email = ref('')
const password = ref('')
const loading = ref(false)
const statusMessage = ref('')
const statusKind = ref<'info' | 'error'>('info')
const hasToken = ref(Boolean(getStoredAuthToken()))

const redirectPath = computed(() => {
  const redirect = route.query.redirect
  if (typeof redirect === 'string' && redirect.startsWith('/')) return redirect
  return '/attendance'
})

function setStatus(message: string, kind: 'info' | 'error' = 'info') {
  statusMessage.value = message
  statusKind.value = kind
}

function refreshTokenState() {
  hasToken.value = Boolean(getStoredAuthToken())
}

function continueToRedirect() {
  router.push(redirectPath.value)
}

function clearToken() {
  clearStoredAuthToken()
  refreshTokenState()
  setStatus('Token cleared.', 'info')
}

function goHome() {
  router.push('/')
}

async function submit() {
  if (!email.value.trim() || !password.value) {
    setStatus('Email and password are required.', 'error')
    return
  }

  loading.value = true
  setStatus('')
  try {
    const response = await fetch(`${getApiBase()}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email.value.trim(),
        password: password.value,
      })
    })
    const data = await response.json().catch(() => null)
    if (!response.ok || !data?.success) {
      throw new Error(data?.error || 'Login failed')
    }
    const token = data?.data?.token
    if (!token) {
      throw new Error('Token missing from response')
    }
    setStoredAuthToken(token)
    refreshTokenState()
    setStatus('Login successful.', 'info')
    router.push(redirectPath.value)
  } catch (error: any) {
    setStatus(error?.message || 'Login failed', 'error')
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 24px;
  max-width: 720px;
  margin: 0 auto;
  color: #2b2b2b;
}

.login__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}

.login__subtitle {
  margin: 0;
  color: #666;
}

.login__meta {
  font-size: 12px;
  color: #666;
}

.login__path {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
}

.login__card {
  border: 1px solid #e0e0e0;
  border-radius: 12px;
  padding: 20px;
  background: #fff;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.04);
}

.login__form,
.login__notice {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.login__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: #555;
}

.login__field input {
  padding: 8px 10px;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
}

.login__actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.login__btn {
  padding: 8px 14px;
  border-radius: 6px;
  border: 1px solid #d0d0d0;
  background: #fff;
  cursor: pointer;
}

.login__btn--primary {
  background: #1976d2;
  border-color: #1976d2;
  color: #fff;
}

.login__btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.login__status {
  margin-top: 16px;
  font-size: 12px;
  color: #2e7d32;
}

.login__status--error {
  color: #c62828;
}
</style>
