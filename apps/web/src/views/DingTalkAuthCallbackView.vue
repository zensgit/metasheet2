<template>
  <section class="dingtalk-callback">
    <div class="dingtalk-callback__card">
      <template v-if="loading">
        <h1>{{ operationMode === 'bind' ? '钉钉绑定处理中' : '钉钉登录处理中' }}</h1>
        <p class="dingtalk-callback__subtitle">正在校验授权结果，请稍候。</p>
      </template>

      <template v-else-if="success">
        <h1>{{ operationMode === 'bind' ? '绑定成功' : '登录成功' }}</h1>
        <p class="dingtalk-callback__subtitle">
          {{ operationMode === 'bind' ? '正在返回账户设置。' : '正在进入系统。' }}
        </p>
      </template>

      <template v-else>
        <h1>{{ operationMode === 'bind' ? '钉钉绑定失败' : '钉钉登录失败' }}</h1>
        <p class="dingtalk-callback__subtitle">
          {{ hint }}
        </p>
      </template>

      <p v-if="error" class="dingtalk-callback__error">{{ error }}</p>

      <div v-if="!loading && !success" class="dingtalk-callback__actions">
        <button type="button" @click="void retry()">
          重试
        </button>
        <button type="button" class="secondary" @click="void backToEntry()">
          {{ operationMode === 'bind' ? '返回设置' : '返回登录' }}
        </button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { apiFetch } from '../utils/api'
import { useAuth } from '../composables/useAuth'
import { useFeatureFlags } from '../stores/featureFlags'
import { readErrorMessage } from '../utils/error'

type DingTalkExchangeData = {
  token?: string
  accessToken?: string
  user?: Record<string, unknown>
  features?: Record<string, unknown>
  redirect?: string
  redirectUrl?: string
  nextUrl?: string
  bindUrl?: string
  bindingUrl?: string
  bindingRequired?: boolean
  requiresBinding?: boolean
  needBind?: boolean
  mode?: 'login' | 'bind'
}

type ExchangeErrorPayload = {
  code: string
  message: string
  details?: Record<string, unknown>
}

const route = useRoute()
const router = useRouter()
const flags = useFeatureFlags()
const auth = useAuth()

const loading = ref(true)
const success = ref(false)
const error = ref('')
const hint = ref('正在验证授权信息。')
const operationMode = ref<'login' | 'bind'>('login')

function queryValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.find((item) => typeof item === 'string' && item.trim().length > 0)?.trim() || ''
  }
  return typeof value === 'string' ? value.trim() : ''
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function queryMode(): 'login' | 'bind' | '' {
  const value = queryValue(route.query.mode)
  return value === 'login' || value === 'bind' ? value : ''
}

function queryRedirect(): string {
  return queryValue(route.query.redirect)
}

function queryErrorMessage(): string {
  const code = queryValue(route.query.error)
  const description = queryValue(route.query.error_description)
  if (description) return description
  if (code) return `钉钉返回错误：${code}`
  return ''
}

function resolveMode(): 'login' | 'bind' {
  const fromQuery = queryMode()
  const fromStorage = auth.getExternalAuthContext()?.mode
  return fromQuery || fromStorage || 'login'
}

function readExchangeData(payload: Record<string, unknown>): DingTalkExchangeData {
  const data = payload.data && typeof payload.data === 'object'
    ? payload.data as Record<string, unknown>
    : payload

  return {
    token: queryValue(data.token ?? data.accessToken ?? data.access_token),
    accessToken: queryValue(data.accessToken ?? data.access_token),
    user: data.user && typeof data.user === 'object' ? data.user as Record<string, unknown> : undefined,
    features: data.features && typeof data.features === 'object' ? data.features as Record<string, unknown> : undefined,
    redirect: queryValue(data.redirect),
    redirectUrl: queryValue(data.redirectUrl ?? data.redirect_url),
    nextUrl: queryValue(data.nextUrl ?? data.next_url),
    bindUrl: queryValue(data.bindUrl ?? data.bind_url),
    bindingUrl: queryValue(data.bindingUrl ?? data.binding_url),
    bindingRequired: data.bindingRequired === true,
    requiresBinding: data.requiresBinding === true,
    needBind: data.needBind === true,
    mode: data.mode === 'login' || data.mode === 'bind' ? data.mode : undefined,
  }
}

function readExchangeError(payload: Record<string, unknown>): ExchangeErrorPayload | null {
  const error = toRecord(payload.error)
  const code = queryValue(error.code)
  const message = queryValue(error.message)
  if (!code || !message) return null
  return {
    code,
    message,
    details: toRecord(error.details),
  }
}

function attachExchangeError(error: ExchangeErrorPayload): Error & ExchangeErrorPayload {
  const wrapped = new Error(error.message) as Error & ExchangeErrorPayload
  wrapped.code = error.code
  wrapped.message = error.message
  wrapped.details = error.details
  return wrapped
}

function normalizeThrownExchangeError(error: unknown): ExchangeErrorPayload | null {
  const record = toRecord(error)
  const code = queryValue(record.code)
  const message = queryValue(record.message)
  if (!code || !message) return null
  return {
    code,
    message,
    details: toRecord(record.details),
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>
  } catch {
    return {}
  }
}

function resolveRedirect(data: DingTalkExchangeData): string {
  const stored = auth.getExternalAuthContext()
  const redirect = queryRedirect()
    || data.redirect
    || data.redirectUrl
    || data.nextUrl
    || stored?.redirect
    || ''
  return redirect
}

function assertCallbackContext(state: string, mode: 'login' | 'bind', stored: ReturnType<typeof auth.getExternalAuthContext>): void {
  if (!stored) return
  if (stored.provider !== 'dingtalk') {
    throw new Error('钉钉授权上下文无效，请重新发起登录。')
  }
  if (stored.state && stored.state !== state) {
    throw new Error('钉钉授权状态已失效，请重新发起登录。')
  }
  if (stored.mode !== mode) {
    throw new Error('钉钉授权模式不匹配，请重新发起登录。')
  }
}

async function finalizeLogin(data: DingTalkExchangeData): Promise<void> {
  const token = data.token || data.accessToken
  if (!token) {
    throw new Error('钉钉登录未返回有效 token。')
  }

  auth.setToken(token)
  auth.primeSession({
    success: true,
    data: {
      user: data.user,
      features: data.features,
    },
  })
  auth.clearExternalAuthContext()

  await flags.loadProductFeatures(true)
  const redirect = resolveRedirect(data) || flags.resolveHomePath()
  await router.replace(redirect)
}

async function finalizeBind(data: DingTalkExchangeData): Promise<void> {
  auth.clearExternalAuthContext()
  const redirect = resolveRedirect(data) || '/settings?dingtalk=bound'
  await router.replace(redirect)
}

async function exchangeCode(): Promise<void> {
  loading.value = true
  error.value = ''
  success.value = false

  const code = queryValue(route.query.code)
  const state = queryValue(route.query.state)
  const routeError = queryErrorMessage()
  const stored = auth.getExternalAuthContext()
  const mode = queryMode() || stored?.mode || 'login'
  operationMode.value = mode

  try {
    if (routeError) {
      throw new Error(routeError)
    }

    if (!code || !state) {
      throw new Error('钉钉回调缺少 code 或 state。')
    }

    assertCallbackContext(state, mode, stored)

    const response = await apiFetch('/api/auth/dingtalk/exchange', {
      method: 'POST',
      body: JSON.stringify({
        code,
        state,
        mode,
      }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.success !== true) {
      const exchangeError = readExchangeError(payload)
      if (exchangeError) {
        throw attachExchangeError(exchangeError)
      }
      throw new Error(readErrorMessage(payload, '钉钉授权校验失败。'))
    }

    const data = readExchangeData(payload)
    const resultMode = data.mode || mode
    operationMode.value = resultMode
    const needsBinding = data.bindingRequired || data.requiresBinding || data.needBind
    if (needsBinding && !data.token && !data.accessToken) {
      hint.value = '当前钉钉账号尚未绑定本地账户。'
      const bindUrl = data.bindUrl || data.bindingUrl || data.redirectUrl || data.nextUrl
      if (bindUrl) {
        auth.clearExternalAuthContext()
        auth.openExternalUrl(bindUrl)
        return
      }
      throw new Error('当前钉钉账号尚未绑定本地账户，请先在系统内完成绑定。')
    }

    if (resultMode === 'bind' && !data.token && !data.accessToken) {
      await finalizeBind(data)
    } else {
      await finalizeLogin(data)
    }
    success.value = true
  } catch (cause) {
    auth.clearExternalAuthContext()
    const exchangeError = normalizeThrownExchangeError(cause)
    if (operationMode.value === 'login' && exchangeError?.code === 'DINGTALK_ACCOUNT_REVIEW_REQUIRED') {
      error.value = '当前钉钉账号尚未开通 MetaSheet，请联系管理员在目录管理中开通并授权钉钉登录。'
      hint.value = exchangeError.details?.queuedForReview === true
        ? '该钉钉账号已加入管理员待审核队列。'
        : '请联系管理员开通账号后再试。'
    } else if (operationMode.value === 'login' && exchangeError?.code === 'DINGTALK_ACCOUNT_UNBOUND') {
      error.value = '当前钉钉账号尚未绑定 MetaSheet 用户。'
      hint.value = '请联系管理员绑定或开通账号后再试。'
    } else {
      error.value = readErrorMessage(cause, operationMode.value === 'bind' ? '钉钉绑定失败，请返回后重试。' : '钉钉登录失败，请返回后重试。')
      hint.value = operationMode.value === 'bind' ? '请检查钉钉授权与当前登录状态后重试。' : '请检查钉钉授权状态后重试。'
    }
  } finally {
    loading.value = false
  }
}

async function retry(): Promise<void> {
  if (loading.value) return
  await backToEntry()
}

async function backToEntry(): Promise<void> {
  auth.clearExternalAuthContext()
  if (operationMode.value === 'bind') {
    await router.replace({
      name: 'user-settings',
    })
    return
  }

  await router.replace({
    name: 'login',
    query: {
      redirect: queryRedirect() || undefined,
    },
  })
}

onMounted(() => {
  operationMode.value = resolveMode()
  void exchangeCode()
})
</script>

<style scoped>
.dingtalk-callback {
  min-height: 100%;
  display: grid;
  place-items: center;
  padding: 24px;
  background:
    radial-gradient(circle at top, rgba(15, 118, 110, 0.16), transparent 34%),
    linear-gradient(145deg, #f7fffe, #eefbf9 50%, #eef2ff);
}

.dingtalk-callback__card {
  width: min(560px, 100%);
  border-radius: 20px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 24px 60px rgba(15, 23, 42, 0.12);
  padding: 28px;
  display: grid;
  gap: 16px;
}

h1 {
  margin: 0;
  font-size: 26px;
}

.dingtalk-callback__subtitle {
  margin: 0;
  color: #475569;
}

.dingtalk-callback__error {
  margin: 0;
  color: #b91c1c;
  background: #fef2f2;
  border-radius: 12px;
  padding: 12px 14px;
}

.dingtalk-callback__actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

button {
  border: 1px solid #0f766e;
  background: linear-gradient(135deg, #0f766e, #115e59);
  color: #fff;
  border-radius: 12px;
  padding: 10px 16px;
}

button.secondary {
  background: #fff;
  color: #0f172a;
  border-color: #cbd5e1;
}
</style>
