<template>
  <section class="force-password-page">
    <div class="force-password-card">
      <h1>{{ isZh ? '需要修改密码' : 'Password change required' }}</h1>
      <p class="force-password-subtitle">
        {{
          isZh
            ? `账号 ${accountEmail || '当前用户'} 需要先修改密码后才能继续使用平台。`
            : `Account ${accountEmail || 'current user'} must change its password before continuing.`
        }}
      </p>

      <form class="force-password-form" @submit.prevent="void submit()">
        <label class="force-password-field">
          <span>{{ isZh ? '新密码' : 'New password' }}</span>
          <input
            v-model="password"
            type="password"
            autocomplete="new-password"
            :placeholder="isZh ? '至少 8 位，包含大小写字母和数字' : 'At least 8 characters with upper/lowercase letters and numbers'"
            required
          />
        </label>

        <label class="force-password-field">
          <span>{{ isZh ? '确认密码' : 'Confirm password' }}</span>
          <input
            v-model="confirmPassword"
            type="password"
            autocomplete="new-password"
            :placeholder="isZh ? '再次输入密码' : 'Enter the password again'"
            required
          />
        </label>

        <button class="force-password-submit" type="submit" :disabled="submitting">
          {{ submitting ? (isZh ? '提交中...' : 'Submitting...') : (isZh ? '保存并继续' : 'Save and continue') }}
        </button>
      </form>

      <p v-if="error" class="force-password-error">{{ error }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '../composables/useAuth'
import { useLocale } from '../composables/useLocale'
import { useFeatureFlags } from '../stores/featureFlags'
import { ROUTE_PATHS } from '../router/types'
import { apiFetch, clearStoredAuthState } from '../utils/api'

type AuthUserRecord = {
  email?: unknown
  must_change_password?: unknown
  mustChangePassword?: unknown
}

const router = useRouter()
const { isZh } = useLocale()
const auth = useAuth()
const { loadProductFeatures, resolveHomePath } = useFeatureFlags()

const password = ref('')
const confirmPassword = ref('')
const submitting = ref(false)
const error = ref('')
const accountEmail = ref('')

function requiresPasswordChange(user: unknown): boolean {
  if (!user || typeof user !== 'object') return false
  const record = user as AuthUserRecord
  return record.must_change_password === true || record.mustChangePassword === true
}

async function ensureEligibleSession(): Promise<boolean> {
  const token = auth.getToken()
  if (!token) {
    await router.replace(ROUTE_PATHS.LOGIN)
    return false
  }

  const session = await auth.bootstrapSession()
  if (!session.ok) {
    clearStoredAuthState()
    await router.replace(ROUTE_PATHS.LOGIN)
    return false
  }

  const user = auth.getCurrentUser() as AuthUserRecord | null
  accountEmail.value = typeof user?.email === 'string' ? user.email : ''
  if (!requiresPasswordChange(user)) {
    await loadProductFeatures(true, { skipSessionProbe: true }).catch(() => null)
    await router.replace(resolveHomePath())
    return false
  }

  return true
}

async function submit(): Promise<void> {
  if (submitting.value) return
  error.value = ''

  if (!password.value || !confirmPassword.value) {
    error.value = isZh.value ? '请填写并确认密码。' : 'Please enter and confirm the new password.'
    return
  }

  if (password.value !== confirmPassword.value) {
    error.value = isZh.value ? '两次输入的密码不一致。' : 'The passwords do not match.'
    return
  }

  submitting.value = true
  try {
    const response = await apiFetch('/api/auth/password/change', {
      method: 'POST',
      body: JSON.stringify({ password: password.value }),
      suppressUnauthorizedRedirect: true,
    })
    const payload = await response.json().catch(() => null)
    const token = typeof payload?.data?.token === 'string' ? payload.data.token : ''

    if (!response.ok || payload?.success !== true || !token) {
      const message =
        typeof payload?.error === 'string'
          ? payload.error
          : typeof payload?.error?.message === 'string'
            ? payload.error.message
            : (isZh.value ? '修改密码失败，请稍后重试。' : 'Failed to change password. Please try again.')
      throw new Error(message)
    }

    auth.setToken(token)
    auth.primeSession({
      success: true,
      data: {
        user: payload?.data?.user ?? null,
        features: payload?.data?.features ?? null,
      },
    })
    await loadProductFeatures(true, { skipSessionProbe: true })
    await router.replace(resolveHomePath())
  } catch (cause) {
    error.value = cause instanceof Error
      ? cause.message
      : (isZh.value ? '修改密码失败，请稍后重试。' : 'Failed to change password. Please try again.')
  } finally {
    submitting.value = false
  }
}

onMounted(() => {
  void ensureEligibleSession()
})
</script>

<style scoped>
.force-password-page {
  min-height: 100%;
  display: grid;
  place-items: center;
  padding: 24px;
}

.force-password-card {
  width: min(520px, 100%);
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 16px;
  box-shadow: 0 12px 28px rgba(15, 35, 95, 0.08);
  padding: 28px;
  display: grid;
  gap: 18px;
}

.force-password-card h1 {
  font-size: 24px;
  color: #123154;
}

.force-password-subtitle {
  font-size: 14px;
  color: #5f7088;
}

.force-password-form {
  display: grid;
  gap: 14px;
}

.force-password-field {
  display: grid;
  gap: 6px;
}

.force-password-field span {
  font-size: 13px;
  color: #334155;
}

.force-password-field input {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 14px;
}

.force-password-field input:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.16);
}

.force-password-submit {
  border: none;
  border-radius: 10px;
  padding: 10px 14px;
  font-size: 14px;
  font-weight: 600;
  color: #fff;
  background: #2563eb;
  cursor: pointer;
}

.force-password-submit:disabled {
  opacity: 0.7;
  cursor: wait;
}

.force-password-error {
  color: #dc2626;
  font-size: 13px;
}
</style>
