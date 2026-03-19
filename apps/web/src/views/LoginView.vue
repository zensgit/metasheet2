<template>
  <section class="login-page">
    <form class="login-card" @submit.prevent="submit">
      <h1>登录</h1>
      <p class="login-subtitle">请输入账号与密码继续。</p>

      <label class="field">
        <span>邮箱</span>
        <input
          v-model.trim="email"
          type="email"
          autocomplete="username"
          placeholder="name@example.com"
          required
        />
      </label>

      <label class="field">
        <span>密码</span>
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
        />
      </label>

      <p v-if="error" class="error">{{ error }}</p>

      <button type="submit" :disabled="loading">
        {{ loading ? '登录中...' : '登录' }}
      </button>
    </form>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getApiBase } from '../utils/api'
import { useAuth } from '../composables/useAuth'
import { useFeatureFlags } from '../stores/featureFlags'
import { readErrorMessage } from '../utils/error'
import { resolvePostLoginRedirect } from '../utils/navigation'

type LoginData = {
  token?: string
  user?: Record<string, unknown>
  features?: Record<string, unknown>
}

const route = useRoute()
const router = useRouter()
const auth = useAuth()
const featureFlags = useFeatureFlags()
const email = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>
  } catch {
    return {}
  }
}

async function submit(): Promise<void> {
  if (loading.value) return
  error.value = ''

  if (!email.value || !password.value) {
    error.value = '请输入邮箱和密码。'
    return
  }

  loading.value = true
  try {
    const response = await fetch(`${getApiBase()}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email.value,
        password: password.value,
      }),
    })

    const payload = await readJson(response)
    const body = payload.data && typeof payload.data === 'object' ? payload.data as LoginData : {}
    const token = typeof body.token === 'string' ? body.token : ''
    const ok = payload.success === true && token.length > 0 && response.ok

    if (!ok) {
      error.value = readErrorMessage(payload, '登录失败，请稍后再试。')
      return
    }

    auth.setToken(token)
    auth.primeSession({
      success: true,
      data: {
        user: body.user,
        features: body.features,
      },
    })
    let fallbackPath = '/attendance'
    try {
      await featureFlags.loadProductFeatures(true)
      fallbackPath = featureFlags.resolveHomePath()
    } catch {
      // Keep login successful even when feature probing is temporarily unavailable.
    }
    await router.replace(resolvePostLoginRedirect(route.query.redirect, fallbackPath))
  } catch (cause) {
    error.value = readErrorMessage(cause, '网络异常，请稍后再试。')
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100%;
  display: grid;
  place-items: center;
  background: linear-gradient(145deg, #f0f9ff, #eef2ff);
  padding: 24px;
}

.login-card {
  width: min(420px, 100%);
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 16px;
  padding: 24px;
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08);
  display: grid;
  gap: 12px;
}

h1 {
  margin: 0;
  font-size: 22px;
}

.login-subtitle {
  margin: 0;
  color: #64748b;
}

.field {
  display: grid;
  gap: 6px;
  color: #334155;
  font-size: 13px;
}

input {
  border: 1px solid #d1d5db;
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 14px;
}

.error {
  color: #b91c1c;
  background: #fef2f2;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 13px;
}

button {
  border: 1px solid #2563eb;
  border-radius: 10px;
  background: #2563eb;
  color: #fff;
  padding: 10px 14px;
  font-size: 14px;
}

button:disabled {
  opacity: 0.6;
}
</style>
