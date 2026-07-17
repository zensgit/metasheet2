<template>
  <section class="platform-app-launcher">
    <header class="platform-app-launcher__hero">
      <div>
        <p class="platform-app-launcher__eyebrow">{{ platformAppLabel('header.eyebrow', isZh) }}</p>
        <h1>{{ platformAppLabel('header.title', isZh) }}</h1>
        <p class="platform-app-launcher__lead">
          {{ platformAppLabel('header.subtitle', isZh) }}
        </p>
      </div>
      <button
        class="platform-app-launcher__refresh"
        type="button"
        :disabled="loading"
        :aria-label="platformAppLabel(loading ? 'action.refreshing' : 'action.refresh', isZh)"
        :title="platformAppLabel(loading ? 'action.refreshing' : 'action.refresh', isZh)"
        @click="refresh"
      >
        <RefreshIcon aria-hidden="true" />
      </button>
    </header>

    <p v-if="error" class="platform-app-launcher__error" role="alert">
      {{ platformAppLabel('state.error', isZh) }}
    </p>
    <p v-else-if="loading" class="platform-app-launcher__state" aria-live="polite">
      {{ platformAppLabel('state.loading', isZh) }}
    </p>
    <p v-else-if="apps.length === 0" class="platform-app-launcher__state">
      {{ platformAppLabel('state.empty', isZh) }}
    </p>

    <div v-else class="platform-app-launcher__grid">
      <article v-for="card in appCards" :key="card.app.id" class="platform-app-launcher__card">
        <div class="platform-app-launcher__card-head">
          <div>
            <p class="platform-app-launcher__app-id">{{ card.app.id }}</p>
            <h2>{{ card.displayName }}</h2>
          </div>
          <span class="platform-app-launcher__status" :data-status="card.app.pluginStatus">
            {{ card.pluginStatusLabel }}
          </span>
        </div>

        <p class="platform-app-launcher__description">
          {{ card.description }}
        </p>

        <dl class="platform-app-launcher__meta">
          <div>
            <dt>{{ platformAppLabel('meta.plugin', isZh) }}</dt>
            <dd>{{ card.app.pluginName }}</dd>
          </div>
          <div>
            <dt>{{ platformAppLabel('meta.install', isZh) }}</dt>
            <dd>{{ card.installStateLabel }}</dd>
          </div>
          <div>
            <dt>{{ platformAppLabel('meta.dependencies', isZh) }}</dt>
            <dd>{{ card.app.platformDependencies.length }}</dd>
          </div>
          <div>
            <dt>{{ platformAppLabel('meta.objects', isZh) }}</dt>
            <dd>{{ card.app.objects.length }}</dd>
          </div>
          <div>
            <dt>{{ platformAppLabel('meta.workflows', isZh) }}</dt>
            <dd>{{ card.app.workflows.length }}</dd>
          </div>
          <div>
            <dt>{{ platformAppLabel('meta.project', isZh) }}</dt>
            <dd>{{ card.projectLabel }}</dd>
          </div>
        </dl>

        <p
          v-if="card.instanceLabel"
          class="platform-app-launcher__instance"
          :data-state="card.installState"
        >
          {{ card.instanceLabel }}
        </p>

        <p class="platform-app-launcher__action-copy">
          {{ card.primaryAction.description }}
        </p>

        <div class="platform-app-launcher__actions">
          <RouterLink
            v-if="card.primaryAction.route && (card.primaryAction.kind !== 'inspect' || canInspectShell)"
            class="platform-app-launcher__primary"
            :to="card.primaryAction.route"
          >
            {{ card.primaryAction.label }}
          </RouterLink>
          <span
            v-else-if="card.primaryAction.kind === 'inspect'"
            class="platform-app-launcher__admin-only"
          >
            {{ platformAppLabel('action.adminOnly', isZh) }}
          </span>
          <RouterLink
            v-if="canInspectShell && card.primaryAction.route !== card.shellRoute"
            class="platform-app-launcher__ghost"
            :to="card.shellRoute"
          >
            {{ platformAppLabel('action.adminDiagnostics', isZh) }}
          </RouterLink>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Refresh as RefreshIcon } from '@element-plus/icons-vue'
import { computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { useAuth } from '../composables/useAuth'
import { useLocale } from '../composables/useLocale'
import {
  type PlatformAppSummary,
  resolvePlatformAppInstallState,
  resolvePlatformAppInstanceLabel,
  resolvePlatformAppPrimaryAction,
  resolvePlatformAppProjectLabel,
  usePlatformApps,
} from '../composables/usePlatformApps'
import {
  platformAppDescription,
  platformAppDisplayName,
  platformAppInstallStateLabel,
  platformAppLabel,
  platformAppStatusLabel,
} from '../utils/platformAppLabels'

const { apps, loading, error, fetchApps } = usePlatformApps()
const { isZh } = useLocale()
const canInspectShell = useAuth().hasAdminAccess()

function resolveShellRoute(app: PlatformAppSummary): string {
  return `/apps/${encodeURIComponent(app.id)}`
}

const appCards = computed(() => apps.value.map((app) => {
  const installState = resolvePlatformAppInstallState(app)
  const primaryAction = resolvePlatformAppPrimaryAction(app, undefined, isZh.value)
  return {
    app,
    displayName: platformAppDisplayName(app.id, app.displayName, isZh.value),
    description: platformAppDescription(app.id, app.boundedContext.description, isZh.value),
    pluginStatusLabel: platformAppStatusLabel(app.pluginStatus, isZh.value),
    installState,
    installStateLabel: platformAppInstallStateLabel(installState, isZh.value),
    instanceLabel: app.runtimeModel === 'direct'
      ? null
      : resolvePlatformAppInstanceLabel(app, isZh.value),
    projectLabel: resolvePlatformAppProjectLabel(app, isZh.value),
    primaryAction,
    shellRoute: resolveShellRoute(app),
  }
}))

async function refresh(): Promise<void> {
  await fetchApps({ force: true })
}

onMounted(async () => {
  await fetchApps()
})
</script>

<style scoped>
.platform-app-launcher {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 24px;
}

.platform-app-launcher__hero {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  padding: 24px;
  border-radius: 20px;
  background: linear-gradient(135deg, #0f172a, #1e3a8a);
  color: #fff;
}

.platform-app-launcher__eyebrow {
  margin-bottom: 8px;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.75;
}

.platform-app-launcher__lead {
  margin-top: 8px;
  max-width: 680px;
  color: rgba(255, 255, 255, 0.82);
}

.platform-app-launcher__refresh,
.platform-app-launcher__primary,
.platform-app-launcher__ghost {
  border: none;
  border-radius: 8px;
  padding: 10px 14px;
  font: inherit;
  cursor: pointer;
  text-decoration: none;
}

.platform-app-launcher__refresh {
  background: #fff;
  color: #0f172a;
}

.platform-app-launcher__primary {
  background: #2563eb;
  color: #fff;
  font-weight: 600;
}

.platform-app-launcher__refresh {
  display: inline-flex;
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.platform-app-launcher__refresh svg {
  width: 18px;
  height: 18px;
}

.platform-app-launcher__ghost {
  background: #e2e8f0;
  color: #0f172a;
}

.platform-app-launcher__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}

.platform-app-launcher__card {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px;
  border: 1px solid #dbe2ea;
  border-radius: 8px;
  background: #fff;
  color: #0f172a;
}

.platform-app-launcher__card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.platform-app-launcher__app-id {
  color: #64748b;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.platform-app-launcher__description {
  color: #475569;
}

.platform-app-launcher__meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.platform-app-launcher__meta dt {
  color: #64748b;
  font-size: 12px;
  text-transform: uppercase;
}

.platform-app-launcher__meta dd {
  margin: 4px 0 0;
  font-weight: 600;
  color: #0f172a;
}

.platform-app-launcher__actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.platform-app-launcher__instance {
  padding: 10px 12px;
  border-radius: 12px;
  background: #f8fafc;
  color: #334155;
}

.platform-app-launcher__instance[data-state='active'] {
  background: #dcfce7;
  color: #166534;
}

.platform-app-launcher__instance[data-state='failed'] {
  background: #fee2e2;
  color: #991b1b;
}

.platform-app-launcher__instance[data-state='partial'] {
  background: #ffedd5;
  color: #9a3412;
}

.platform-app-launcher__action-copy {
  color: #475569;
  font-size: 14px;
}

.platform-app-launcher__admin-only {
  color: #475569;
  font-size: 13px;
}

.platform-app-launcher__status {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  background: #e2e8f0;
  color: #334155;
}

.platform-app-launcher__status[data-status='active'] {
  background: #dcfce7;
  color: #166534;
}

.platform-app-launcher__status[data-status='failed'] {
  background: #fee2e2;
  color: #991b1b;
}

.platform-app-launcher__error,
.platform-app-launcher__state {
  padding: 16px 18px;
  border-radius: 8px;
  background: #fff;
  border: 1px solid #dbe2ea;
  color: #334155;
}

.platform-app-launcher__error {
  color: #b91c1c;
  border-color: #fecaca;
}
</style>
