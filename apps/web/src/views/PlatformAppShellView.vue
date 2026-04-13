<template>
  <section class="platform-app-shell">
    <p v-if="error" class="platform-app-shell__error">{{ error }}</p>
    <p v-else-if="actionError" class="platform-app-shell__error">{{ actionError }}</p>
    <p v-else-if="actionMessage" class="platform-app-shell__notice">{{ actionMessage }}</p>
    <p v-else-if="loading" class="platform-app-shell__state">Loading app shell...</p>
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
import { apiPost } from '../utils/api'

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

async function load(): Promise<void> {
  if (!appId.value) return
  actionError.value = null
  await fetchAppById(appId.value, { force: true })
}

async function runPrimaryAction(): Promise<void> {
  if (!primaryAction.value) return

  if (primaryAction.value.mutation) {
    actionPending.value = true
    actionMessage.value = null
    actionError.value = null
    try {
      await apiPost(primaryAction.value.mutation.path, primaryAction.value.mutation.payload)
      await fetchAppById(appId.value, { force: true })
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
</style>
