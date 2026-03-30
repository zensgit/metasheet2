<template>
  <section class="dingtalk-callback">
    <div v-if="loading" class="dingtalk-callback__loading">
      <div class="dingtalk-callback__spinner" />
      <p>正在验证钉钉登录，请稍候...</p>
    </div>

    <div v-else-if="errorMessage" class="dingtalk-callback__error">
      <p class="dingtalk-callback__error-text">{{ errorMessage }}</p>
      <button class="dingtalk-callback__button" type="button" @click="void returnToLogin()">
        返回登录
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuth } from '../composables/useAuth'
import { useFeatureFlags } from '../stores/featureFlags'
import { getApiBase } from '../utils/api'
import { readErrorMessage } from '../utils/error'
import { resolvePostLoginRedirect } from '../utils/navigation'

const route = useRoute()
const router = useRouter()
const auth = useAuth()
const featureFlags = useFeatureFlags()

const loading = ref(true)
const errorMessage = ref('')

async function handleCallback(): Promise<void> {
  const code = typeof route.query.code === 'string' ? route.query.code : ''
  const state = typeof route.query.state === 'string' ? route.query.state : ''

  if (!code) {
    loading.value = false
    errorMessage.value = '缺少授权码参数'
    return
  }

  try {
    const response = await fetch(`${getApiBase()}/api/auth/dingtalk/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, state }),
    })

    let payload: Record<string, unknown> = {}
    try {
      payload = await response.json() as Record<string, unknown>
    } catch {
      // ignore parse failure
    }

    if (!response.ok) {
      loading.value = false
      errorMessage.value = readErrorMessage(payload, '钉钉登录失败')
      return
    }

    type FeatureFlags = { attendance?: boolean; workflow?: boolean; attendanceAdmin?: boolean; attendanceImport?: boolean; mode?: 'platform' | 'attendance' | 'attendance-focused' | 'plm-workbench' }
    type CallbackData = { token?: string; user?: Record<string, unknown>; features?: FeatureFlags }
    const data: CallbackData = payload.data && typeof payload.data === 'object' ? payload.data as CallbackData : {}
    const token = typeof data.token === 'string' ? data.token : ''

    if (!token) {
      loading.value = false
      errorMessage.value = '登录成功但未获取到令牌'
      return
    }

    auth.setToken(token)
    auth.primeSession({
      success: true,
      data: {
        user: data.user,
        features: data.features,
      },
    })

    let fallbackPath = '/attendance'
    try {
      await featureFlags.loadProductFeatures(true)
      fallbackPath = featureFlags.resolveHomePath()
    } catch {
      // Keep login successful even when feature probing temporarily fails
    }

    await router.replace(resolvePostLoginRedirect(route.query.redirect, fallbackPath))
  } catch (error) {
    loading.value = false
    errorMessage.value = readErrorMessage(error, '钉钉登录失败，请稍后重试')
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
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 24px;
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
  border: 4px solid #e2e8f0;
  border-top-color: #2563eb;
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
  max-width: 400px;
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
  background: #2563eb;
  color: #fff;
  font-weight: 600;
  cursor: pointer;
}

.dingtalk-callback__button:hover {
  background: #1d4ed8;
}
</style>
