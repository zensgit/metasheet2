<template>
  <section class="after-sales-view">
    <div v-if="loading || installing" class="after-sales-view__overlay">
      <div class="after-sales-view__overlay-card">
        <div class="after-sales-view__spinner" />
        <h2>{{ installing ? 'Initializing After Sales' : 'Loading After Sales' }}</h2>
        <p>{{ installing ? '正在初始化售后模板...' : '正在读取当前安装状态...' }}</p>
      </div>
    </div>

    <header class="after-sales-view__hero">
      <div>
        <p class="after-sales-view__eyebrow">Platform App</p>
        <h1>{{ current.displayName || manifest?.displayName || 'After Sales' }}</h1>
        <p class="after-sales-view__lead">
          售后应用已经接入项目安装器。这里会根据当前安装状态切换为启用引导、运行概览或故障恢复页。
        </p>
      </div>
      <div class="after-sales-view__hero-actions">
        <div class="after-sales-view__status" :data-tone="statusTone">
          {{ statusLabel }}
        </div>
        <button class="after-sales-view__ghost-btn" :disabled="loading || installing || refreshing" @click="refreshCurrentState">
          {{ refreshing ? 'Refreshing...' : 'Refresh' }}
        </button>
      </div>
    </header>

    <section v-if="error" class="after-sales-view__error-banner">
      <div>
        <strong>After-sales request failed</strong>
        <p>{{ error }}</p>
      </div>
      <button class="after-sales-view__primary-btn" :disabled="loading || installing" @click="loadView">
        Retry
      </button>
    </section>

    <section v-if="current.status === 'not-installed'" class="after-sales-view__onboarding">
      <article class="after-sales-view__onboarding-card">
        <p class="after-sales-view__pill">v1 Project Enablement</p>
        <h2>Enable the after-sales project shell</h2>
        <p>
          这一步会创建售后项目的账本记录，并通过 multitable provisioning seam 落下最小售后数据投影。
        </p>
        <ul class="after-sales-view__list">
          <li>templateId 固定为 <code>after-sales-default</code></li>
          <li>v1 projectId 伪值为 <code>{{ defaultProjectId }}</code></li>
          <li>当前会真实创建 <code>serviceTicket</code>、<code>installedAsset</code>、<code>customer</code> 和 <code>serviceRecord</code> 对象</li>
          <li>同时会创建默认 <code>ticket-board</code>、<code>installedAsset-grid</code>、<code>customer-grid</code> 和 <code>serviceRecord-calendar</code> 视图</li>
        </ul>
        <div class="after-sales-view__action-row">
          <button class="after-sales-view__primary-btn" :disabled="installing" @click="triggerInstall('enable')">
            Enable After Sales
          </button>
        </div>
      </article>

      <article class="after-sales-view__card">
        <h2>Platform dependencies</h2>
        <ul v-if="manifest?.platformDependencies?.length" class="after-sales-view__list">
          <li v-for="item in manifest.platformDependencies" :key="item">{{ item }}</li>
        </ul>
        <p v-else>No manifest data loaded.</p>
      </article>
    </section>

    <section v-else class="after-sales-view__content">
      <section v-if="isDegraded" class="after-sales-view__warning-banner" :data-tone="current.status">
        <div>
          <strong>{{ current.status === 'failed' ? 'Initialization failed' : 'Initialization completed with warnings' }}</strong>
          <p>
            {{ current.status === 'failed'
              ? '账本里已有 failed 终态，重试会走 reinstall。'
              : 'partial 状态允许继续进入首页，但建议尽快执行 reinstall 补齐缺失对象。' }}
          </p>
        </div>
        <div class="after-sales-view__action-row">
          <button class="after-sales-view__primary-btn" :disabled="installing" @click="triggerInstall('reinstall')">
            Reinstall
          </button>
          <button class="after-sales-view__ghost-btn" :disabled="warnings.length === 0" @click="showWarnings = true">
            Warnings
          </button>
        </div>
      </section>

      <section class="after-sales-view__grid">
        <article class="after-sales-view__card">
          <h2>Install state</h2>
          <dl class="after-sales-view__meta">
            <div>
              <dt>Status</dt>
              <dd>{{ current.status }}</dd>
            </div>
            <div>
              <dt>Project ID</dt>
              <dd><code>{{ current.projectId || defaultProjectId }}</code></dd>
            </div>
            <div>
              <dt>Display name</dt>
              <dd>{{ current.displayName || manifest?.displayName || 'After Sales' }}</dd>
            </div>
            <div>
              <dt>Report ref</dt>
              <dd><code>{{ current.reportRef || current.installResult?.reportRef || 'n/a' }}</code></dd>
            </div>
          </dl>
        </article>

        <article class="after-sales-view__card">
          <h2>Manifest objects</h2>
          <ul v-if="manifest?.objects?.length" class="after-sales-view__list">
            <li v-for="item in manifest.objects" :key="item.id">
              <strong>{{ item.name }}</strong> <span>({{ item.backing }})</span>
            </li>
          </ul>
          <p v-else>No objects declared yet.</p>
        </article>

        <article class="after-sales-view__card">
          <h2>Workflows</h2>
          <ul v-if="manifest?.workflows?.length" class="after-sales-view__list">
            <li v-for="item in manifest.workflows" :key="item.id">{{ item.name }}</li>
          </ul>
          <p v-else>No workflows declared yet.</p>
        </article>

        <article class="after-sales-view__card">
          <h2>Created in this install</h2>
          <ul v-if="createdObjectLabels.length || createdViewLabels.length" class="after-sales-view__list">
            <li v-for="item in createdObjectLabels" :key="`obj-${item}`">Object: {{ item }}</li>
            <li v-for="item in createdViewLabels" :key="`view-${item}`">View: {{ item }}</li>
          </ul>
          <p v-else>No install payload available yet.</p>
        </article>
      </section>
    </section>

    <div v-if="showWarnings" class="after-sales-view__modal-backdrop" @click.self="showWarnings = false">
      <div class="after-sales-view__modal">
        <header class="after-sales-view__modal-header">
          <div>
            <p class="after-sales-view__pill">Install warnings</p>
            <h2>Installer diagnostics</h2>
          </div>
          <button class="after-sales-view__close-btn" @click="showWarnings = false">×</button>
        </header>
        <ul v-if="warnings.length" class="after-sales-view__list">
          <li v-for="item in warnings" :key="item">{{ item }}</li>
        </ul>
        <p v-else>No warnings captured for the current install.</p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { apiFetch } from '../utils/api'

interface AfterSalesManifest {
  id: string
  displayName: string
  platformDependencies: string[]
  objects: Array<{ id: string; name: string; backing: string }>
  workflows: Array<{ id: string; name: string }>
}

interface InstallResult {
  status: 'installed' | 'partial' | 'failed'
  createdObjects: string[]
  createdViews: string[]
  warnings: string[]
  reportRef?: string
}

interface CurrentResponse {
  status: 'not-installed' | 'installed' | 'partial' | 'failed'
  projectId?: string
  displayName?: string
  config?: Record<string, unknown>
  installResult?: InstallResult
  reportRef?: string
}

interface ApiEnvelope<T> {
  ok: boolean
  data: T
  error?: {
    code?: string
    message?: string
  }
}

const TEMPLATE_ID = 'after-sales-default'
const DEFAULT_CONFIG = {
  enableWarranty: true,
  enableRefundApproval: true,
  enableVisitScheduling: true,
  enableFollowUp: true,
  defaultSlaHours: 24,
  urgentSlaHours: 4,
  followUpAfterDays: 7,
}

const loading = ref(true)
const installing = ref(false)
const refreshing = ref(false)
const error = ref('')
const showWarnings = ref(false)
const manifest = ref<AfterSalesManifest | null>(null)
const current = ref<CurrentResponse>({ status: 'not-installed' })

const defaultProjectId = computed(() => 'tenant:after-sales')
const warnings = computed(() => current.value.installResult?.warnings ?? [])
const createdObjectLabels = computed(() => current.value.installResult?.createdObjects ?? [])
const createdViewLabels = computed(() => current.value.installResult?.createdViews ?? [])
const isDegraded = computed(() => current.value.status === 'partial' || current.value.status === 'failed')
const statusTone = computed(() => {
  switch (current.value.status) {
    case 'installed':
      return 'success'
    case 'partial':
      return 'warning'
    case 'failed':
      return 'danger'
    default:
      return 'neutral'
  }
})
const statusLabel = computed(() => {
  switch (current.value.status) {
    case 'installed':
      return 'Installed'
    case 'partial':
      return 'Partial'
    case 'failed':
      return 'Failed'
    default:
      return 'Not installed'
  }
})

function extractMessage(payload: unknown, fallback: string): string {
  const errorMessage =
    payload && typeof payload === 'object' && 'error' in payload
      ? (payload as { error?: { message?: string } }).error?.message
      : ''
  return typeof errorMessage === 'string' && errorMessage.trim().length > 0 ? errorMessage : fallback
}

async function readEnvelope<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await apiFetch(path, options)
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractMessage(payload, `${response.status} ${response.statusText}`))
  }
  return ((payload as ApiEnvelope<T> | null)?.data ?? null) as T
}

async function loadManifest() {
  manifest.value = await readEnvelope<AfterSalesManifest>('/api/after-sales/app-manifest')
}

async function refreshCurrentState() {
  refreshing.value = true
  try {
    current.value = await readEnvelope<CurrentResponse>('/api/after-sales/projects/current')
  } finally {
    refreshing.value = false
  }
}

async function loadView() {
  loading.value = true
  error.value = ''
  try {
    const [nextManifest, nextCurrent] = await Promise.all([
      readEnvelope<AfterSalesManifest>('/api/after-sales/app-manifest'),
      readEnvelope<CurrentResponse>('/api/after-sales/projects/current'),
    ])
    manifest.value = nextManifest
    current.value = nextCurrent
  } catch (err: any) {
    error.value = err?.message || 'Failed to load after-sales state'
  } finally {
    loading.value = false
  }
}

async function triggerInstall(mode: 'enable' | 'reinstall') {
  installing.value = true
  error.value = ''
  try {
    await readEnvelope('/api/after-sales/projects/install', {
      method: 'POST',
      body: JSON.stringify({
        templateId: TEMPLATE_ID,
        mode,
        displayName: current.value.displayName || manifest.value?.displayName || 'After Sales',
        config: current.value.config ?? DEFAULT_CONFIG,
      }),
    })
    await refreshCurrentState()
  } catch (err: any) {
    error.value = err?.message || 'Failed to install after-sales template'
  } finally {
    installing.value = false
  }
}

onMounted(() => {
  void loadView()
})
</script>

<style scoped>
.after-sales-view {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.after-sales-view__overlay {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: grid;
  place-items: center;
  background: rgba(15, 23, 42, 0.28);
  backdrop-filter: blur(6px);
}

.after-sales-view__overlay-card,
.after-sales-view__modal {
  width: min(520px, calc(100vw - 32px));
  padding: 24px;
  border-radius: 20px;
  background: #ffffff;
  box-shadow: 0 30px 80px rgba(15, 23, 42, 0.18);
}

.after-sales-view__overlay-card {
  text-align: center;
}

.after-sales-view__spinner {
  width: 36px;
  height: 36px;
  margin: 0 auto 16px;
  border-radius: 999px;
  border: 3px solid rgba(14, 116, 144, 0.15);
  border-top-color: #0f766e;
  animation: spin 0.9s linear infinite;
}

.after-sales-view__hero {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  padding: 28px;
  border-radius: 18px;
  background:
    linear-gradient(135deg, rgba(14, 116, 144, 0.1), rgba(245, 158, 11, 0.12)),
    #ffffff;
  border: 1px solid rgba(14, 116, 144, 0.14);
}

.after-sales-view__hero-actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 12px;
}

.after-sales-view__eyebrow {
  margin: 0 0 8px;
  font-size: 12px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #0f766e;
}

.after-sales-view__hero h1 {
  margin: 0;
  font-size: 32px;
  line-height: 1.05;
  color: #0f172a;
}

.after-sales-view__lead {
  margin: 12px 0 0;
  max-width: 680px;
  color: #334155;
}

.after-sales-view__status {
  min-width: 140px;
  padding: 10px 14px;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  background: rgba(255, 255, 255, 0.9);
  color: #0f172a;
  font-size: 13px;
  text-align: center;
}

.after-sales-view__status[data-tone='success'] {
  color: #166534;
  border-color: rgba(22, 101, 52, 0.18);
  background: rgba(220, 252, 231, 0.8);
}

.after-sales-view__status[data-tone='warning'] {
  color: #92400e;
  border-color: rgba(146, 64, 14, 0.18);
  background: rgba(254, 243, 199, 0.9);
}

.after-sales-view__status[data-tone='danger'] {
  color: #991b1b;
  border-color: rgba(153, 27, 27, 0.16);
  background: rgba(254, 226, 226, 0.88);
}

.after-sales-view__error-banner,
.after-sales-view__warning-banner,
.after-sales-view__onboarding {
  display: grid;
  gap: 16px;
}

.after-sales-view__error-banner,
.after-sales-view__warning-banner {
  grid-template-columns: 1fr auto;
  align-items: center;
  padding: 18px 20px;
  border-radius: 16px;
  border: 1px solid #fecaca;
  background: #fff1f2;
}

.after-sales-view__warning-banner[data-tone='partial'] {
  border-color: #fcd34d;
  background: #fffbeb;
}

.after-sales-view__warning-banner[data-tone='failed'] {
  border-color: #fca5a5;
  background: #fef2f2;
}

.after-sales-view__error-banner p,
.after-sales-view__warning-banner p,
.after-sales-view__onboarding-card p {
  margin: 6px 0 0;
  color: #475569;
  line-height: 1.6;
}

.after-sales-view__onboarding-card,
.after-sales-view__card {
  padding: 22px;
  border-radius: 18px;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.05);
}

.after-sales-view__onboarding-card {
  background:
    linear-gradient(160deg, rgba(255, 247, 237, 0.9), rgba(236, 253, 245, 0.9)),
    #ffffff;
}

.after-sales-view__content,
.after-sales-view__grid {
  display: grid;
  gap: 16px;
}

.after-sales-view__grid {
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}

.after-sales-view__card h2,
.after-sales-view__onboarding-card h2,
.after-sales-view__modal h2 {
  margin: 0 0 12px;
  font-size: 18px;
  color: #0f172a;
}

.after-sales-view__card p {
  margin: 0;
  color: #475569;
}

.after-sales-view__list {
  margin: 0;
  padding-left: 18px;
  color: #334155;
}

.after-sales-view__list li + li {
  margin-top: 8px;
}

.after-sales-view__meta {
  display: grid;
  gap: 12px;
  margin: 0;
}

.after-sales-view__meta div {
  display: grid;
  gap: 4px;
}

.after-sales-view__meta dt {
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #64748b;
}

.after-sales-view__meta dd {
  margin: 0;
  color: #0f172a;
}

.after-sales-view__pill {
  display: inline-flex;
  margin: 0 0 10px;
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(15, 118, 110, 0.12);
  color: #0f766e;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.after-sales-view__action-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 16px;
}

.after-sales-view__primary-btn,
.after-sales-view__ghost-btn,
.after-sales-view__close-btn {
  border: none;
  border-radius: 12px;
  cursor: pointer;
  transition: transform 0.15s ease, opacity 0.15s ease;
}

.after-sales-view__primary-btn {
  padding: 11px 16px;
  background: #0f766e;
  color: #ffffff;
}

.after-sales-view__ghost-btn {
  padding: 10px 14px;
  background: rgba(255, 255, 255, 0.95);
  border: 1px solid #cbd5e1;
  color: #0f172a;
}

.after-sales-view__close-btn {
  width: 36px;
  height: 36px;
  background: #f8fafc;
  color: #0f172a;
  font-size: 24px;
  line-height: 1;
}

.after-sales-view__primary-btn:disabled,
.after-sales-view__ghost-btn:disabled,
.after-sales-view__close-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.after-sales-view__modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 25;
  display: grid;
  place-items: center;
  background: rgba(15, 23, 42, 0.32);
}

.after-sales-view__modal-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 16px;
}

code {
  padding: 2px 6px;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.06);
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 840px) {
  .after-sales-view__hero,
  .after-sales-view__error-banner,
  .after-sales-view__warning-banner {
    grid-template-columns: 1fr;
    display: grid;
  }

  .after-sales-view__hero-actions {
    align-items: stretch;
  }
}
</style>
