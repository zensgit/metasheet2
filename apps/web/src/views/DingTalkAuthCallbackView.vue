<template>
  <section class="dingtalk-callback">
    <div v-if="loading" class="dingtalk-callback__loading">
      <div class="dingtalk-callback__spinner" />
      <p>{{ text.loading }}</p>
    </div>

    <div v-else-if="errorMessage" class="dingtalk-callback__error">
      <p class="dingtalk-callback__error-text">{{ errorMessage }}</p>
      <button class="dingtalk-callback__button" type="button" @click="void returnToLogin()">
        {{ text.backToLogin }}
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuth } from '../composables/useAuth'
import { useLocale } from '../composables/useLocale'
import { useFeatureFlags } from '../stores/featureFlags'
import { normalizePostLoginRedirect } from '../utils/authRedirect'
import { apiFetch } from '../utils/api'
import { readErrorMessage } from '../utils/error'

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

const route = useRoute()
const router = useRouter()
const auth = useAuth()
const { isZh } = useLocale()
const { loadProductFeatures, resolveHomePath } = useFeatureFlags()

const loading = ref(true)
const errorMessage = ref('')

const text = computed(() => {
  if (isZh.value) {
    return {
      loading: '正在验证钉钉登录，请稍候...',
      backToLogin: '返回登录',
      missingCode: '缺少授权码参数',
      missingToken: '登录成功但未获取到令牌',
      failed: '钉钉登录失败，请稍后重试。',
    }
  }
  return {
    loading: 'Completing DingTalk sign-in...',
    backToLogin: 'Back to Sign In',
    missingCode: 'Missing authorization code',
    missingToken: 'Sign-in succeeded but no token was returned',
    failed: 'DingTalk sign-in failed. Please try again.',
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

async function handleCallback(): Promise<void> {
  const existingToken = auth.getToken()
  if (existingToken) {
    const currentSession = await auth.bootstrapSession()
    if (currentSession.ok) {
      let fallbackPath = resolveHomePath()
      try {
        await loadProductFeatures()
        fallbackPath = resolveHomePath()
      } catch {
        // Keep authenticated users on their current session even if feature probing fails.
      }

      const redirectPath = normalizePostLoginRedirect(route.query.redirect)
      await router.replace(redirectPath || fallbackPath)
      return
    }
  }

  const code = typeof route.query.code === 'string' ? route.query.code : ''
  const state = typeof route.query.state === 'string' ? route.query.state : ''

  if (!code) {
    loading.value = false
    errorMessage.value = text.value.missingCode
    return
  }

  try {
    const response = await apiFetch('/api/auth/dingtalk/callback', {
      method: 'POST',
      body: JSON.stringify({ code, state }),
      suppressUnauthorizedRedirect: true,
    })
    const payload = await response.json().catch(() => null)

    if (!response.ok || !payload?.success) {
      loading.value = false
      errorMessage.value = readErrorMessage(payload, text.value.failed)
      return
    }

    const token = typeof payload?.data?.token === 'string' ? payload.data.token : ''
    if (!token) {
      loading.value = false
      errorMessage.value = text.value.missingToken
      return
    }

    auth.setToken(token)
    persistAuthContext(
      (payload?.data?.user ?? null) as AuthUserPayload | null,
      (payload?.data?.features ?? null) as AuthFeaturePayload | null,
    )
    auth.primeSession({
      success: true,
      data: {
        user: payload?.data?.user ?? null,
        features: payload?.data?.features ?? null,
      },
    })

    let fallbackPath = resolveHomePath()
    try {
      await loadProductFeatures(true, { skipSessionProbe: true })
      fallbackPath = resolveHomePath()
    } catch {
      // Keep the login successful even when feature probing temporarily fails.
    }

    const redirectPath =
      normalizePostLoginRedirect(payload?.data?.redirectPath) ||
      normalizePostLoginRedirect(route.query.redirect)
    await router.replace(redirectPath || fallbackPath)
  } catch (error) {
    loading.value = false
    errorMessage.value = readErrorMessage(error, text.value.failed)
  }
}

async function returnToLogin(): Promise<void> {
  await router.replace({ name: 'login' }).catch(() => undefined)
}

onMounted(() => {
  void handleCallback()
})
</script>

<style scoped>
.dingtalk-callback {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: linear-gradient(160deg, #f3f6fb 0%, #eef5ff 40%, #f9fcff 100%);
}

.dingtalk-callback__loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.dingtalk-callback__loading p {
  margin: 0;
  color: #475569;
  font-size: 16px;
}

.dingtalk-callback__spinner {
  width: 48px;
  height: 48px;
  border: 4px solid #dbeafe;
  border-top-color: #0f7ae5;
  border-radius: 50%;
  animation: dingtalk-spin 0.8s linear infinite;
}

@keyframes dingtalk-spin {
  to {
    transform: rotate(360deg);
  }
}

.dingtalk-callback__error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  max-width: 420px;
  text-align: center;
}

.dingtalk-callback__error-text {
  margin: 0;
  padding: 14px 20px;
  border-radius: 10px;
  background: #fef2f2;
  color: #b91c1c;
  font-size: 15px;
}

.dingtalk-callback__button {
  appearance: none;
  border: none;
  border-radius: 10px;
  padding: 10px 20px;
  background: #2070d8;
  color: #fff;
  font-weight: 600;
  cursor: pointer;
}

.dingtalk-callback__button:hover {
  background: #1558ac;
}
</style>
