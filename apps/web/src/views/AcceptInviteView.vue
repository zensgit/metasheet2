<template>
  <section class="invite-page">
    <div class="invite-card">
      <template v-if="loadingPreview">
        <h1>邀请处理中</h1>
        <p class="invite-subtitle">正在校验邀请链接，请稍候。</p>
      </template>

      <template v-else-if="preview">
        <h1>{{ preview.onboarding.welcomeTitle || '欢迎加入 MetaSheet' }}</h1>
        <p class="invite-subtitle">
          账号 {{ preview.user.email }} 已准备就绪。请设置首次登录密码并完成初始化。
        </p>

        <div class="invite-summary">
          <div>
            <strong>推荐入口</strong>
            <span>{{ preview.onboarding.homePath }}</span>
          </div>
          <div>
            <strong>登录入口</strong>
            <span>{{ preview.onboarding.loginUrl }}</span>
          </div>
        </div>

        <div v-if="preview.onboarding.checklist.length" class="invite-checklist">
          <strong>首次登录检查项</strong>
          <ul>
            <li v-for="item in preview.onboarding.checklist" :key="item">{{ item }}</li>
          </ul>
        </div>

        <form class="invite-form" @submit.prevent="void submit()">
          <label class="invite-field">
            <span>姓名</span>
            <input
              v-model.trim="name"
              type="text"
              autocomplete="name"
              placeholder="可选：首次登录时补充姓名"
            />
          </label>

          <label class="invite-field">
            <span>新密码</span>
            <input
              v-model="password"
              type="password"
              autocomplete="new-password"
              placeholder="至少 8 位，包含大小写字母和数字"
              required
            />
          </label>

          <label class="invite-field">
            <span>确认密码</span>
            <input
              v-model="confirmPassword"
              type="password"
              autocomplete="new-password"
              placeholder="再次输入密码"
              required
            />
          </label>

          <button class="invite-submit" type="submit" :disabled="submitting">
            {{ submitting ? '提交中...' : '完成初始化并登录' }}
          </button>
        </form>
      </template>

      <template v-else>
        <h1>邀请无效</h1>
        <p class="invite-subtitle">当前邀请链接不可用，请联系管理员重新发送。</p>
      </template>

      <p v-if="error" class="invite-error">{{ error }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuth } from '../composables/useAuth'
import { useFeatureFlags } from '../stores/featureFlags'
import { getApiBase } from '../utils/api'

type InvitePreview = {
  user: {
    id: string
    email: string
    name: string | null
    isActive: boolean
  }
  onboarding: {
    presetId: string | null
    productMode: 'platform' | 'attendance' | 'plm-workbench'
    homePath: string
    loginPath: string
    loginUrl: string
    acceptInvitePath: string
    acceptInviteUrl: string
    welcomeTitle: string
    checklist: string[]
    inviteMessage: string
  }
}

const route = useRoute()
const router = useRouter()
const flags = useFeatureFlags()
const { setToken, primeSession } = useAuth()

const loadingPreview = ref(true)
const submitting = ref(false)
const error = ref('')
const preview = ref<InvitePreview | null>(null)
const name = ref('')
const password = ref('')
const confirmPassword = ref('')

function currentInviteToken(): string {
  const token = Array.isArray(route.query.token) ? route.query.token[0] : route.query.token
  return typeof token === 'string' ? token.trim() : ''
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>
  } catch {
    return {}
  }
}

async function loadPreview(): Promise<void> {
  loadingPreview.value = true
  error.value = ''
  preview.value = null

  const token = currentInviteToken()
  if (!token) {
    error.value = '邀请链接缺少 token。'
    loadingPreview.value = false
    return
  }

  try {
    const response = await fetch(`${getApiBase()}/api/auth/invite/preview?token=${encodeURIComponent(token)}`)
    const payload = await readJson(response)
    if (!response.ok || payload.success !== true) {
      throw new Error(String(payload.error || '邀请链接无效或已过期'))
    }

    const data = payload.data && typeof payload.data === 'object'
      ? payload.data as InvitePreview
      : null
    if (!data) {
      throw new Error('邀请预览数据缺失')
    }

    preview.value = data
    name.value = data.user.name || ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '邀请链接无效或已过期'
  } finally {
    loadingPreview.value = false
  }
}

async function submit(): Promise<void> {
  if (submitting.value) return
  error.value = ''

  const token = currentInviteToken()
  if (!token) {
    error.value = '邀请链接缺少 token。'
    return
  }

  if (!password.value || !confirmPassword.value) {
    error.value = '请填写并确认密码。'
    return
  }

  if (password.value !== confirmPassword.value) {
    error.value = '两次输入的密码不一致。'
    return
  }

  submitting.value = true
  try {
    const response = await fetch(`${getApiBase()}/api/auth/invite/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        password: password.value,
        name: name.value || undefined,
      }),
    })

    const payload = await readJson(response)
    const data = payload.data && typeof payload.data === 'object'
      ? payload.data as Record<string, unknown>
      : {}
    const acceptedUser = data.user && typeof data.user === 'object'
      ? (data.user as Record<string, unknown>)
      : undefined
    const acceptedFeatures = data.features && typeof data.features === 'object'
      ? (data.features as Record<string, unknown>)
      : undefined
    const acceptedToken = typeof data.token === 'string' ? data.token : ''

    if (!response.ok || payload.success !== true || !acceptedToken) {
      const details = Array.isArray(payload.details) ? `：${payload.details.join('；')}` : ''
      const nestedDetails = payload.error && typeof payload.error === 'object' && Array.isArray((payload.error as Record<string, unknown>).details)
        ? `：${((payload.error as Record<string, unknown>).details as string[]).join('；')}`
        : ''
      const message = typeof payload.error === 'string'
        ? payload.error
        : typeof (payload.error as Record<string, unknown> | undefined)?.message === 'string'
          ? String((payload.error as Record<string, unknown>).message)
          : '初始化失败，请联系管理员重新发送邀请。'
      throw new Error(`${message}${nestedDetails || details}`)
    }

    setToken(acceptedToken)
    primeSession({
      success: true,
      data: {
        user: acceptedUser,
        features: acceptedFeatures,
      },
    })
    await flags.loadProductFeatures(true)

    const onboarding = data.onboarding && typeof data.onboarding === 'object'
      ? data.onboarding as { homePath?: string }
      : {}
    await router.replace(onboarding.homePath || flags.resolveHomePath())
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '初始化失败，请稍后重试。'
  } finally {
    submitting.value = false
  }
}

onMounted(() => {
  void loadPreview()
})
</script>

<style scoped>
.invite-page {
  min-height: 100%;
  display: grid;
  place-items: center;
  padding: 24px;
}

.invite-card {
  width: min(560px, 100%);
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 16px;
  padding: 24px;
  display: grid;
  gap: 16px;
}

.invite-card h1 {
  margin: 0;
  font-size: 24px;
}

.invite-subtitle {
  margin: 0;
  color: #6b7280;
}

.invite-summary {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.invite-summary > div,
.invite-checklist {
  border-radius: 12px;
  background: #f8fafc;
  padding: 12px 14px;
  display: grid;
  gap: 6px;
}

.invite-summary strong,
.invite-checklist strong {
  color: #111827;
}

.invite-summary span,
.invite-checklist li {
  color: #4b5563;
  font-size: 14px;
}

.invite-checklist ul {
  margin: 0;
  padding-left: 18px;
  display: grid;
  gap: 6px;
}

.invite-form {
  display: grid;
  gap: 12px;
}

.invite-field {
  display: grid;
  gap: 6px;
}

.invite-field span {
  font-size: 13px;
  color: #374151;
}

.invite-field input {
  height: 40px;
  border: 1px solid #d1d5db;
  border-radius: 10px;
  padding: 0 12px;
  font-size: 14px;
}

.invite-submit {
  height: 42px;
  border: 0;
  border-radius: 10px;
  background: #2563eb;
  color: #fff;
  cursor: pointer;
}

.invite-submit:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.invite-error {
  margin: 0;
  color: #dc2626;
  font-size: 13px;
}

@media (max-width: 720px) {
  .invite-summary {
    grid-template-columns: 1fr;
  }
}
</style>
