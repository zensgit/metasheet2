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
          <span>{{ text.identifier }}</span>
          <input
            v-model="identifier"
            type="text"
            autocomplete="username"
            required
            :placeholder="text.identifierPlaceholder"
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

        <div v-if="dingtalkAvailable" class="login-divider">
          <span>{{ text.alternative }}</span>
        </div>

        <button
          v-if="dingtalkAvailable"
          class="login-dingtalk"
          type="button"
          :disabled="dingtalkSubmitting"
          @click="onLaunchDingTalk"
        >
          {{ dingtalkSubmitting ? text.dingtalkSubmitting : text.dingtalkSubmit }}
        </button>

        <p v-if="dingtalkErrorMessage" class="login-error">{{ dingtalkErrorMessage }}</p>
        <p v-else-if="dingtalkStatusMessage" class="login-hint">{{ dingtalkStatusMessage }}</p>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuth } from '../composables/useAuth'
import { ROUTE_PATHS } from '../router/types'
import { useLocale } from '../composables/useLocale'
import { useFeatureFlags } from '../stores/featureFlags'
import { normalizePostLoginRedirect } from '../utils/authRedirect'
import { apiFetch, clearStoredAuthState } from '../utils/api'
import { readErrorMessage } from '../utils/error'

interface AuthUserPayload {
  role?: unknown
  roles?: unknown
  permissions?: unknown
  must_change_password?: unknown
  mustChangePassword?: unknown
}

interface AuthFeaturePayload {
  mode?: unknown
  attendance?: unknown
  workflow?: unknown
  attendanceAdmin?: unknown
  attendanceImport?: unknown
  plm?: unknown
}

interface DingTalkRuntimeStatus {
  configured?: unknown
  available?: unknown
  corpId?: unknown
  allowedCorpIds?: unknown
  requireGrant?: unknown
  autoLinkEmail?: unknown
  autoProvision?: unknown
  unavailableReason?: unknown
}

const router = useRouter()
const route = useRoute()
const { setToken, primeSession } = useAuth()
const { locale, isZh, setLocale } = useLocale()
const { loadProductFeatures, resolveHomePath } = useFeatureFlags()

const identifier = ref('')
const password = ref('')
const submitting = ref(false)
const errorMessage = ref('')
const dingtalkAvailable = ref(false)
const dingtalkSubmitting = ref(false)
const dingtalkErrorMessage = ref('')
const dingtalkStatusMessage = ref('')

const text = computed(() => {
  if (isZh.value) {
    return {
      title: '登录 MetaSheet',
      subtitle: '输入账号密码后进入系统。',
      identifier: '账号',
      password: '密码',
      language: '语言',
      identifierPlaceholder: '邮箱、手机号或用户名',
      passwordPlaceholder: '请输入密码',
      submit: '登录',
      submitting: '登录中...',
      alternative: '或者',
      dingtalkSubmit: '使用钉钉登录',
      dingtalkSubmitting: '跳转到钉钉中...',
      failed: '登录失败，请检查账号或密码。',
      networkError: '登录失败，请稍后再试。',
      dingtalkUnavailable: '钉钉登录暂不可用，请稍后重试。',
      dingtalkMissingUrl: '未获取到钉钉登录地址。',
      dingtalkCorpBlocked: '当前服务端钉钉企业白名单未放行，暂时无法使用钉钉登录。',
      dingtalkConfigMissing: '当前服务端钉钉登录配置不完整。',
    }
  }
  return {
    title: 'Sign in to MetaSheet',
    subtitle: 'Use your account credentials to continue.',
    identifier: 'Account',
    password: 'Password',
    language: 'Language',
    identifierPlaceholder: 'Email, mobile, or username',
    passwordPlaceholder: 'Enter password',
    submit: 'Sign in',
    submitting: 'Signing in...',
    alternative: 'or',
    dingtalkSubmit: 'Continue with DingTalk',
    dingtalkSubmitting: 'Redirecting to DingTalk...',
    failed: 'Sign-in failed. Check your account or password.',
    networkError: 'Sign-in failed. Please try again.',
    dingtalkUnavailable: 'DingTalk login is unavailable right now.',
    dingtalkMissingUrl: 'No DingTalk login URL was returned.',
    dingtalkCorpBlocked: 'DingTalk login is blocked by the current corporate allowlist.',
    dingtalkConfigMissing: 'The server DingTalk login configuration is incomplete.',
  }
})

function readDingTalkStatusMessage(status: DingTalkRuntimeStatus | null): string {
  const reason = typeof status?.unavailableReason === 'string' ? status.unavailableReason : null
  if (reason === 'corp_not_allowed') return text.value.dingtalkCorpBlocked
  if (
    reason === 'missing_client_id' ||
    reason === 'missing_client_secret' ||
    reason === 'missing_redirect_uri'
  ) {
    return text.value.dingtalkConfigMissing
  }
  if (status && status.available === false) {
    return text.value.dingtalkUnavailable
  }
  return ''
}

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

function requiresPasswordChange(user: AuthUserPayload | null): boolean {
  return user?.must_change_password === true || user?.mustChangePassword === true
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
        identifier: identifier.value.trim(),
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

    const userPayload = (payload?.data?.user ?? null) as AuthUserPayload | null
    const featurePayload = (payload?.data?.features ?? null) as AuthFeaturePayload | null
    const passwordChangeRequired = requiresPasswordChange(userPayload)

    setToken(token)
    primeSession({
      success: true,
      data: {
        user: payload?.data?.user ?? null,
        features: payload?.data?.features ?? null,
      },
    })

    persistAuthContext(
      userPayload,
      featurePayload,
    )

    if (passwordChangeRequired) {
      await router.replace(ROUTE_PATHS.FORCE_PASSWORD_CHANGE)
      return
    }

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

async function probeDingTalkLogin(): Promise<void> {
  dingtalkStatusMessage.value = ''
  try {
    const response = await apiFetch('/api/auth/dingtalk/launch?probe=1', {
      method: 'GET',
      suppressUnauthorizedRedirect: true,
    })
    const payload = await response.json().catch(() => null)
    const status = (payload?.data ?? null) as DingTalkRuntimeStatus | null
    dingtalkAvailable.value = response.ok && payload?.success === true && status?.available === true
    dingtalkStatusMessage.value = dingtalkAvailable.value ? '' : readDingTalkStatusMessage(status)
  } catch {
    dingtalkAvailable.value = false
    dingtalkStatusMessage.value = text.value.dingtalkUnavailable
  }
}

async function onLaunchDingTalk(): Promise<void> {
  dingtalkErrorMessage.value = ''
  dingtalkSubmitting.value = true

  try {
    const redirectPath = normalizePostLoginRedirect(route.query.redirect)
    const query = redirectPath ? `?redirect=${encodeURIComponent(redirectPath)}` : ''
    const response = await apiFetch(`/api/auth/dingtalk/launch${query}`, {
      method: 'GET',
      suppressUnauthorizedRedirect: true,
    })
    const payload = await response.json().catch(() => null)

    if (!response.ok || !payload?.success) {
      dingtalkErrorMessage.value = readErrorMessage(payload, text.value.dingtalkUnavailable)
      return
    }

    const launchUrl = typeof payload?.data?.url === 'string' ? payload.data.url : ''
    if (!launchUrl) {
      dingtalkErrorMessage.value = text.value.dingtalkMissingUrl
      return
    }

    window.location.href = launchUrl
  } catch (error) {
    dingtalkErrorMessage.value = readErrorMessage(error, text.value.dingtalkUnavailable)
  } finally {
    dingtalkSubmitting.value = false
  }
}

onMounted(() => {
  void probeDingTalkLogin()
})
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

.login-hint {
  margin: 0;
  color: #5f7088;
  font-size: 13px;
  line-height: 1.5;
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

.login-divider {
  display: flex;
  align-items: center;
  gap: 10px;
  color: #6b7c93;
  font-size: 12px;
}

.login-divider::before,
.login-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: #d9e4f2;
}

.login-dingtalk {
  border: 1px solid #0089ff;
  border-radius: 8px;
  padding: 10px 14px;
  background: #f3f9ff;
  color: #0067c7;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

.login-dingtalk:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
