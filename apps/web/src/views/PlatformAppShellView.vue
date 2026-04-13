<template>
  <section class="platform-app-shell">
    <p v-if="error" class="platform-app-shell__error">{{ error }}</p>
    <p v-if="actionError" class="platform-app-shell__error">{{ actionError }}</p>
    <p v-if="actionMessage" class="platform-app-shell__notice">{{ actionMessage }}</p>
    <p v-if="loading" class="platform-app-shell__state">Loading app shell...</p>
    <p v-else-if="!app" class="platform-app-shell__state">Platform app not found.</p>

    <template v-else>
      <header class="platform-app-shell__hero">
        <div>
          <p class="platform-app-shell__eyebrow">{{ app.boundedContext.code }}</p>
          <h1>{{ app.displayName }}</h1>
          <p class="platform-app-shell__lead">
            {{ app.boundedContext.description || 'This app has no bounded-context description yet.' }}
          </p>
        </div>
        <div class="platform-app-shell__hero-actions">
          <button
            v-if="primaryAction?.route"
            class="platform-app-shell__primary"
            type="button"
            :disabled="actionPending"
            @click="runPrimaryAction"
          >
            {{ actionPending ? 'Working...' : primaryAction?.label }}
          </button>
          <RouterLink class="platform-app-shell__ghost" to="/apps">
            Back to launcher
          </RouterLink>
        </div>
      </header>

      <section class="platform-app-shell__grid">
        <article class="platform-app-shell__panel">
          <h2>Next action</h2>
          <p class="platform-app-shell__action-copy">
            {{ primaryAction?.description || 'No direct action is available for this app yet.' }}
          </p>
        </article>

        <article class="platform-app-shell__panel">
          <h2>Runtime</h2>
          <dl class="platform-app-shell__meta">
            <div>
              <dt>Plugin</dt>
              <dd>{{ app.pluginName }}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{{ app.pluginStatus }}</dd>
            </div>
            <div>
              <dt>Runtime model</dt>
              <dd>{{ app.runtimeModel }}</dd>
            </div>
            <div>
              <dt>Install state</dt>
              <dd>{{ resolvePlatformAppInstallState(app) }}</dd>
            </div>
            <div>
              <dt>Entry path</dt>
              <dd>{{ app.entryPath || 'Unavailable' }}</dd>
            </div>
            <div>
              <dt>Owner</dt>
              <dd>{{ app.boundedContext.owner || 'Unspecified' }}</dd>
            </div>
            <div>
              <dt>Project</dt>
              <dd>{{ resolvePlatformAppProjectLabel(app) }}</dd>
            </div>
            <div>
              <dt>Instance</dt>
              <dd>{{ resolvePlatformAppInstanceLabel(app) }}</dd>
            </div>
          </dl>
        </article>

        <article v-if="showRuntimeDiagnostics" class="platform-app-shell__panel">
          <h2>Runtime diagnostics</h2>
          <p v-if="runtimeCurrentError" class="platform-app-shell__diagnostic-error">
            {{ runtimeCurrentError }}
          </p>
          <template v-else-if="runtimeCurrent">
            <dl class="platform-app-shell__meta">
              <div>
                <dt>Current status</dt>
                <dd>{{ runtimeCurrent.status }}</dd>
              </div>
              <div>
                <dt>Report ref</dt>
                <dd>{{ runtimeCurrent.reportRef || runtimeCurrent.installResult?.reportRef || 'Unavailable' }}</dd>
              </div>
              <div>
                <dt>Created objects</dt>
                <dd>{{ runtimeCurrent.installResult?.createdObjects.length ?? 0 }}</dd>
              </div>
              <div>
                <dt>Created views</dt>
                <dd>{{ runtimeCurrent.installResult?.createdViews.length ?? 0 }}</dd>
              </div>
            </dl>
            <div class="platform-app-shell__diagnostic-copy">
              <p v-if="runtimeWarnings.length === 0">
                No runtime warnings were reported for the current snapshot.
              </p>
              <template v-else>
                <strong>Warnings</strong>
                <ul class="platform-app-shell__list">
                  <li v-for="item in runtimeWarnings" :key="item">
                    <span>{{ item }}</span>
                  </li>
                </ul>
              </template>
            </div>
          </template>
          <p v-else class="platform-app-shell__muted-state">
            Runtime diagnostics are declared for this app, but no current snapshot was returned yet.
          </p>
        </article>

        <article class="platform-app-shell__panel">
          <h2>Dependencies</h2>
          <ul class="platform-app-shell__chips">
            <li v-for="item in app.platformDependencies" :key="item">{{ item }}</li>
          </ul>
        </article>

        <article class="platform-app-shell__panel">
          <h2>Quick entry</h2>
          <ul class="platform-app-shell__list">
            <li v-for="item in visibleNavigationItems" :key="item.id">
              <div class="platform-app-shell__entry-copy">
                <strong>{{ item.title }}</strong>
                <span>{{ item.location }}</span>
              </div>
              <RouterLink class="platform-app-shell__inline-link" :to="item.path">
                Open
              </RouterLink>
            </li>
          </ul>
          <p v-if="visibleNavigationItems.length === 0" class="platform-app-shell__muted-state">
            No visible navigation items declared in the app manifest yet.
          </p>
        </article>

        <article class="platform-app-shell__panel">
          <h2>Objects</h2>
          <ul class="platform-app-shell__list">
            <li v-for="item in app.objects" :key="item.id">
              <strong>{{ item.name }}</strong>
              <span>{{ item.backing }}</span>
            </li>
          </ul>
        </article>

        <article class="platform-app-shell__panel">
          <h2>Workflows</h2>
          <ul class="platform-app-shell__list">
            <li v-for="item in app.workflows" :key="item.id">
              <strong>{{ item.name }}</strong>
              <span>{{ item.trigger || 'manual' }}</span>
            </li>
          </ul>
        </article>
      </section>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import {
  resolvePlatformAppInstallState,
  resolvePlatformAppInstanceLabel,
  resolvePlatformAppPrimaryAction,
  resolvePlatformAppProjectLabel,
  usePlatformApps,
} from '../composables/usePlatformApps'
import { apiGet, apiPost } from '../utils/api'

interface RuntimeInstallResultSnapshot {
  status: 'installed' | 'partial' | 'failed'
  createdObjects: string[]
  createdViews: string[]
  warnings: string[]
  reportRef?: string
}

interface RuntimeCurrentSnapshot {
  status: 'not-installed' | 'installed' | 'partial' | 'failed'
  projectId?: string
  displayName?: string
  config?: Record<string, unknown>
  installResult?: RuntimeInstallResultSnapshot
  reportRef?: string
}

const route = useRoute()
const router = useRouter()
const { apps, loading, error, fetchAppById } = usePlatformApps()

const appId = computed(() => String(route.params.appId || ''))
const app = computed(() => apps.value.find((item) => item.id === appId.value) || null)
const primaryAction = computed(() => (app.value ? resolvePlatformAppPrimaryAction(app.value) : null))
const visibleNavigationItems = computed(() =>
  (app.value?.navigation ?? []).filter((item) => item.location !== 'hidden'),
)
const actionPending = ref(false)
const actionMessage = ref<string | null>(null)
const actionError = ref<string | null>(null)
const runtimeCurrent = ref<RuntimeCurrentSnapshot | null>(null)
const runtimeCurrentError = ref<string | null>(null)
const runtimeWarnings = computed(() => runtimeCurrent.value?.installResult?.warnings ?? [])
const showRuntimeDiagnostics = computed(() =>
  Boolean(app.value?.runtimeBindings?.currentPath || runtimeCurrent.value || runtimeCurrentError.value),
)

function normalizeRuntimeCurrentSnapshot(payload: unknown): RuntimeCurrentSnapshot | null {
  const candidate = payload && typeof payload === 'object' && 'data' in (payload as Record<string, unknown>)
    ? (payload as { data?: unknown }).data
    : payload
  if (!candidate || typeof candidate !== 'object') return null
  const status = (candidate as { status?: unknown }).status
  if (typeof status !== 'string') return null
  const installResultRaw = (candidate as { installResult?: unknown }).installResult
  const installResult = installResultRaw && typeof installResultRaw === 'object'
    ? {
        status: typeof (installResultRaw as { status?: unknown }).status === 'string'
          ? (installResultRaw as { status: 'installed' | 'partial' | 'failed' }).status
          : 'installed',
        createdObjects: Array.isArray((installResultRaw as { createdObjects?: unknown }).createdObjects)
          ? (installResultRaw as { createdObjects: string[] }).createdObjects
          : [],
        createdViews: Array.isArray((installResultRaw as { createdViews?: unknown }).createdViews)
          ? (installResultRaw as { createdViews: string[] }).createdViews
          : [],
        warnings: Array.isArray((installResultRaw as { warnings?: unknown }).warnings)
          ? (installResultRaw as { warnings: string[] }).warnings
          : [],
        reportRef: typeof (installResultRaw as { reportRef?: unknown }).reportRef === 'string'
          ? (installResultRaw as { reportRef: string }).reportRef
          : undefined,
      }
    : undefined

  return {
    status: status as RuntimeCurrentSnapshot['status'],
    projectId: typeof (candidate as { projectId?: unknown }).projectId === 'string'
      ? (candidate as { projectId: string }).projectId
      : undefined,
    displayName: typeof (candidate as { displayName?: unknown }).displayName === 'string'
      ? (candidate as { displayName: string }).displayName
      : undefined,
    config: (candidate as { config?: Record<string, unknown> }).config,
    installResult,
    reportRef: typeof (candidate as { reportRef?: unknown }).reportRef === 'string'
      ? (candidate as { reportRef: string }).reportRef
      : undefined,
  }
}

async function loadRuntimeCurrent(targetApp: NonNullable<typeof app.value>): Promise<void> {
  if (!targetApp.runtimeBindings?.currentPath) {
    runtimeCurrent.value = null
    runtimeCurrentError.value = null
    return
  }

  try {
    const response = await apiGet<unknown>(targetApp.runtimeBindings.currentPath)
    runtimeCurrent.value = normalizeRuntimeCurrentSnapshot(response)
    runtimeCurrentError.value = null
  } catch (err: any) {
    runtimeCurrent.value = null
    runtimeCurrentError.value = err?.message || 'Failed to load runtime diagnostics'
  }
}

async function load(): Promise<void> {
  if (!appId.value) return
  actionError.value = null
  const nextApp = await fetchAppById(appId.value, { force: true })
  if (nextApp) {
    await loadRuntimeCurrent(nextApp)
  } else {
    runtimeCurrent.value = null
    runtimeCurrentError.value = null
  }
}

async function runPrimaryAction(): Promise<void> {
  if (!primaryAction.value) return

  if (primaryAction.value.mutation) {
    actionPending.value = true
    actionMessage.value = null
    actionError.value = null
    try {
      await apiPost(primaryAction.value.mutation.path, primaryAction.value.mutation.payload)
      const nextApp = await fetchAppById(appId.value, { force: true })
      if (nextApp) {
        await loadRuntimeCurrent(nextApp)
      }
      actionMessage.value = primaryAction.value.kind === 'reinstall'
        ? 'App reinstall completed and runtime state has been refreshed.'
        : 'App install completed and runtime state has been refreshed.'
    } catch (err: any) {
      actionError.value = err?.message || 'Failed to execute app runtime action'
    } finally {
      actionPending.value = false
    }
    return
  }

  if (!primaryAction.value.route) return
  await router.push(primaryAction.value.route)
}

onMounted(load)
watch(appId, () => {
  void load()
})
</script>

<style scoped>
.platform-app-shell {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 24px;
}

.platform-app-shell__hero {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  padding: 24px;
  border-radius: 20px;
  background: linear-gradient(135deg, #111827, #1d4ed8);
  color: #fff;
}

.platform-app-shell__eyebrow {
  margin-bottom: 8px;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  opacity: 0.72;
}

.platform-app-shell__lead {
  margin-top: 8px;
  max-width: 680px;
  color: rgba(255, 255, 255, 0.84);
}

.platform-app-shell__hero-actions {
  display: flex;
  gap: 12px;
}

.platform-app-shell__primary,
.platform-app-shell__ghost {
  border: none;
  border-radius: 12px;
  padding: 10px 14px;
  font: inherit;
  text-decoration: none;
  cursor: pointer;
}

.platform-app-shell__primary {
  background: #fff;
  color: #111827;
}

.platform-app-shell__ghost {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}

.platform-app-shell__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}

.platform-app-shell__panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  border: 1px solid #dbe2ea;
  border-radius: 18px;
  background: #fff;
}

.platform-app-shell__action-copy {
  color: #475569;
  line-height: 1.6;
}

.platform-app-shell__meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.platform-app-shell__meta dt {
  color: #64748b;
  font-size: 12px;
  text-transform: uppercase;
}

.platform-app-shell__meta dd {
  margin: 4px 0 0;
  font-weight: 600;
  word-break: break-word;
}

.platform-app-shell__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  list-style: none;
}

.platform-app-shell__chips li {
  border-radius: 999px;
  padding: 6px 10px;
  background: #e2e8f0;
  color: #334155;
}

.platform-app-shell__list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  list-style: none;
}

.platform-app-shell__list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid #e2e8f0;
}

.platform-app-shell__entry-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.platform-app-shell__inline-link {
  color: #1d4ed8;
  font-weight: 600;
  text-decoration: none;
}

.platform-app-shell__muted-state {
  color: #64748b;
}

.platform-app-shell__state,
.platform-app-shell__error,
.platform-app-shell__notice {
  padding: 16px 18px;
  border-radius: 14px;
  background: #fff;
  border: 1px solid #dbe2ea;
}

.platform-app-shell__error {
  color: #b91c1c;
  border-color: #fecaca;
}

.platform-app-shell__notice {
  color: #166534;
  border-color: #bbf7d0;
}

.platform-app-shell__diagnostic-error {
  color: #b91c1c;
}

.platform-app-shell__diagnostic-copy {
  display: flex;
  flex-direction: column;
  gap: 10px;
  color: #475569;
}
</style>
