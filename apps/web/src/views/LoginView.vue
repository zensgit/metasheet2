<template>
  <section class="login-page">
    <div class="login-card">
      <h1>登录</h1>
      <p class="login-subtitle">请使用账号密码登录后继续。</p>

      <form class="login-form" @submit.prevent="submit">
        <label class="login-field">
          <span>邮箱</span>
          <input
            v-model.trim="email"
            type="email"
            autocomplete="username"
            placeholder="admin@your-company.local"
            required
          />
        </label>

        <label class="login-field">
          <span>密码</span>
          <input
            v-model="password"
            type="password"
            autocomplete="current-password"
            placeholder="请输入密码"
            required
          />
        </label>

        <button class="login-submit" type="submit" :disabled="loading">
          {{ loading ? '登录中...' : '登录' }}
        </button>
      </form>

      <p v-if="error" class="login-error">{{ error }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuth } from '../composables/useAuth'
import { useFeatureFlags } from '../stores/featureFlags'
import { getApiBase } from '../utils/api'

const route = useRoute()
const router = useRouter()
const flags = useFeatureFlags()
const { setToken } = useAuth()

const email = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')

function resolveSafeRedirect(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  if (!raw.startsWith('/')) return ''
  if (raw.startsWith('//')) return ''
  return raw
}

function persistUserSnapshot(user: unknown): void {
  if (typeof localStorage === 'undefined') return
  const record = user && typeof user === 'object' ? user as Record<string, unknown> : {}

  if (Array.isArray(record.permissions)) {
    localStorage.setItem('user_permissions', JSON.stringify(record.permissions))
  }

  if (typeof record.role === 'string' && record.role.trim().length > 0) {
    localStorage.setItem('user_roles', JSON.stringify([record.role]))
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

    let payload: Record<string, unknown> = {}
    try {
      payload = await response.json() as Record<string, unknown>
    } catch {
      payload = {}
    }

    const success = payload.success === true
    const data = payload.data && typeof payload.data === 'object'
      ? payload.data as Record<string, unknown>
      : {}
    const token = typeof data.token === 'string' ? data.token : ''

    if (!response.ok || !success || token.length === 0) {
      const message = typeof payload.error === 'string' && payload.error.trim().length > 0
        ? payload.error
        : '登录失败，请检查账号密码。'
      error.value = message
      return
    }

    setToken(token)
    persistUserSnapshot(data.user)

    await flags.loadProductFeatures(true)

    const redirectRaw = Array.isArray(route.query.redirect)
      ? route.query.redirect[0]
      : route.query.redirect
    const redirect = resolveSafeRedirect(redirectRaw)
    await router.replace(redirect || flags.resolveHomePath())
  } catch (e) {
    error.value = e instanceof Error ? e.message : '登录失败，请稍后重试。'
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
  padding: 24px;
}

.login-card {
  width: min(420px, 100%);
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 24px;
  display: grid;
  gap: 14px;
}

.login-card h1 {
  margin: 0;
  font-size: 24px;
}

.login-subtitle {
  margin: 0;
  color: #6b7280;
}

.login-form {
  display: grid;
  gap: 12px;
}

.login-field {
  display: grid;
  gap: 6px;
}

.login-field span {
  font-size: 13px;
  color: #374151;
}

.login-field input {
  height: 38px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 0 10px;
  font-size: 14px;
}

.login-submit {
  margin-top: 6px;
  height: 40px;
  border: 0;
  border-radius: 8px;
  background: #2563eb;
  color: #fff;
  font-size: 14px;
  cursor: pointer;
}

.login-submit:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.login-error {
  margin: 0;
  color: #dc2626;
  font-size: 13px;
}
</style>
