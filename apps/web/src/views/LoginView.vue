<template>
  <section class="login-page">
    <div class="login-card">
      <header class="login-header">
        <div class="login-header__content">
          <h1>{{ text.title }}</h1>
          <p>{{ text.subtitle }}</p>
        </div>
        <label class="login-locale">
          <span class="login-locale__label">{{ text.language }}</span>
          <select
            class="login-locale__select"
            data-testid="locale-switcher"
            :value="locale"
            @change="onLocaleChange"
          >
            <option value="en">English</option>
            <option value="zh-CN">中文</option>
          </select>
        </label>
      </header>

      <form class="login-form" @submit.prevent="onSubmit">
        <label class="login-field">
          <span>{{ text.email }}</span>
          <input
            v-model="email"
            type="email"
            autocomplete="username"
            required
            :placeholder="text.emailPlaceholder"
          />
        </label>

        <label class="login-field">
          <span>{{ text.password }}</span>
          <input
            v-model="password"
            type="password"
            autocomplete="current-password"
            required
            :placeholder="text.passwordPlaceholder"
          />
        </label>

        <p v-if="errorMessage" class="login-error">{{ errorMessage }}</p>

        <button class="login-submit" type="submit" :disabled="submitting">
          {{ submitting ? text.submitting : text.submit }}
        </button>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useLocale } from '../composables/useLocale'
import { useFeatureFlags } from '../stores/featureFlags'
import { normalizePostLoginRedirect } from '../utils/authRedirect'
import { apiFetch, clearStoredAuthState } from '../utils/api'

interface AuthUserPayload {
  role?: unknown
  roles?: unknown
  permissions?: unknown
}

interface AuthFeaturePayload {
  mode?: unknown
  attendance?: unknown
  workflow?: unknown
  attendanceAdmin?: unknown
  attendanceImport?: unknown
  plm?: unknown
}

const router = useRouter()
const route = useRoute()
const { locale, isZh, setLocale } = useLocale()
const { loadProductFeatures, resolveHomePath } = useFeatureFlags()

const email = ref('')
const password = ref('')
const submitting = ref(false)
const errorMessage = ref('')

const text = computed(() => {
  if (isZh.value) {
    return {
      title: '登录 MetaSheet',
      subtitle: '输入账号密码后进入系统。',
      email: '邮箱',
      password: '密码',
      language: '语言',
      emailPlaceholder: 'admin@metasheet.app',
      passwordPlaceholder: '请输入密码',
      submit: '登录',
      submitting: '登录中...',
      failed: '登录失败，请检查账号或密码。',
      networkError: '登录失败，请稍后再试。',
    }
  }
  return {
    title: 'Sign in to MetaSheet',
    subtitle: 'Use your account credentials to continue.',
    email: 'Email',
    password: 'Password',
    language: 'Language',
    emailPlaceholder: 'admin@metasheet.app',
    passwordPlaceholder: 'Enter password',
    submit: 'Sign in',
    submitting: 'Signing in...',
    failed: 'Sign-in failed. Check your email or password.',
    networkError: 'Sign-in failed. Please try again.',
  }
})

function extractUserRoles(user: AuthUserPayload | null): string[] {
  if (!user) return []
  if (Array.isArray(user.roles)) {
    return user.roles.filter((item): item is string => typeof item === 'string')
  }
  if (typeof user.role === 'string' && user.role.trim().length > 0) {
    return [user.role.trim()]
  }
  return []
}

function extractUserPermissions(user: AuthUserPayload | null): string[] {
  if (!user) return []
  if (!Array.isArray(user.permissions)) return []
  return user.permissions.filter((item): item is string => typeof item === 'string')
}

function persistAuthContext(user: AuthUserPayload | null, features: AuthFeaturePayload | null): void {
  if (typeof localStorage === 'undefined') return

  const roles = extractUserRoles(user)
  const permissions = extractUserPermissions(user)

  if (roles.length > 0) {
    localStorage.setItem('user_roles', JSON.stringify(roles))
  } else {
    localStorage.removeItem('user_roles')
  }

  if (permissions.length > 0) {
    localStorage.setItem('user_permissions', JSON.stringify(permissions))
  } else {
    localStorage.removeItem('user_permissions')
  }

  if (features && typeof features === 'object') {
    localStorage.setItem('metasheet_features', JSON.stringify(features))
    if (typeof features.mode === 'string' && features.mode.trim().length > 0) {
      localStorage.setItem('metasheet_product_mode', features.mode)
    }
  }
}

function onLocaleChange(event: Event): void {
  const target = event.target as HTMLSelectElement | null
  if (!target) return
  setLocale(target.value)
}

async function onSubmit(): Promise<void> {
  errorMessage.value = ''
  submitting.value = true

  try {
    const response = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: email.value.trim(),
        password: password.value,
      }),
    })

    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.success) {
      errorMessage.value = payload?.error || text.value.failed
      return
    }

    const token = payload?.data?.token
    if (typeof token !== 'string' || token.trim().length === 0) {
      errorMessage.value = text.value.failed
      return
    }

    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('auth_token', token)
    }

    persistAuthContext(
      (payload?.data?.user ?? null) as AuthUserPayload | null,
      (payload?.data?.features ?? null) as AuthFeaturePayload | null,
    )
    await loadProductFeatures(true, { skipSessionProbe: true })

    const redirect = normalizePostLoginRedirect(route.query.redirect)
    await router.replace(redirect || resolveHomePath())
  } catch {
    errorMessage.value = text.value.networkError
    clearStoredAuthState()
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  background: linear-gradient(160deg, #f3f6fb 0%, #eef5ff 40%, #f9fcff 100%);
}

.login-card {
  width: min(420px, 100%);
  border-radius: 14px;
  border: 1px solid #dfe7f4;
  background: #fff;
  box-shadow: 0 12px 28px rgba(15, 35, 95, 0.08);
  padding: 24px;
  display: grid;
  gap: 18px;
}

.login-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.login-header__content {
  display: grid;
  gap: 6px;
  min-width: 0;
  flex: 1 1 auto;
}

.login-header h1 {
  font-size: 24px;
  line-height: 1.2;
  color: #123154;
}

.login-header p {
  font-size: 14px;
  color: #5f7088;
}

.login-locale {
  display: inline-grid;
  gap: 4px;
  justify-items: end;
  flex: 0 0 auto;
}

.login-locale__label {
  font-size: 12px;
  color: #64748b;
}

.login-locale__select {
  min-width: 120px;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 13px;
  color: #334155;
  background: #fff;
}

.login-locale__select:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.16);
}

.login-form {
  display: grid;
  gap: 14px;
}

.login-field {
  display: grid;
  gap: 6px;
}

.login-field span {
  font-size: 13px;
  color: #334155;
}

.login-field input {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 14px;
}

.login-field input:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.16);
}

.login-error {
  color: #c0392b;
  font-size: 13px;
}

.login-submit {
  border: none;
  border-radius: 8px;
  padding: 10px 14px;
  background: #2070d8;
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

.login-submit:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
