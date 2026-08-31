<template>
  <section class="my-apps-landing">
    <header class="my-apps-landing__hero">
      <p class="my-apps-landing__eyebrow">我的应用</p>
      <h1>欢迎回来</h1>
      <p class="my-apps-landing__subtitle">
        从这里进入你可以使用的应用，或者继续打开最近用过的多维表。
      </p>
    </header>

    <section class="my-apps-landing__section" aria-label="我的应用">
      <div class="my-apps-landing__section-head">
        <h2>我的应用</h2>
        <button
          v-if="appsError"
          class="my-apps-landing__retry"
          type="button"
          :disabled="appsLoading"
          @click="refreshApps"
        >
          重试
        </button>
      </div>

      <p v-if="appsError" class="my-apps-landing__error" role="alert">{{ appsError }}</p>
      <div v-else-if="appsLoading" class="my-apps-landing__state">正在加载应用...</div>
      <div v-else-if="!visibleApps.length" class="my-apps-landing__empty" data-testid="my-apps-landing-empty-apps">
        暂时没有可用的应用。
      </div>
      <div v-else class="my-apps-landing__app-grid">
        <article
          v-for="card in visibleApps"
          :key="card.app.id"
          class="my-apps-landing__app-card"
          data-testid="my-apps-landing-app-card"
        >
          <h3>{{ card.app.displayName }}</h3>
          <p class="my-apps-landing__app-value">{{ card.valueStatement }}</p>
          <router-link class="my-apps-landing__enter" :to="card.enterPath">
            进入
          </router-link>
        </article>
      </div>
    </section>

    <section class="my-apps-landing__section" aria-label="最近打开的 Base">
      <div class="my-apps-landing__section-head">
        <h2>最近打开的 Base</h2>
        <router-link class="my-apps-landing__section-link" :to="multitableHomePath">
          查看全部多维表 →
        </router-link>
      </div>

      <p v-if="baseError" class="my-apps-landing__error" role="alert">{{ baseError }}</p>
      <div v-else-if="baseLoading" class="my-apps-landing__state">正在加载最近打开的 Base...</div>
      <div v-else-if="!recentBases.length" class="my-apps-landing__empty" data-testid="my-apps-landing-empty-bases">
        还没有最近打开的 Base，去
        <router-link :to="multitableHomePath">多维表</router-link>
        看看吧。
      </div>
      <div v-else class="my-apps-landing__base-grid">
        <article
          v-for="base in recentBases"
          :key="base.id"
          class="my-apps-landing__base-card"
          data-testid="my-apps-landing-base-card"
        >
          <div class="my-apps-landing__base-icon" :style="{ background: base.color || '#2563eb' }">
            {{ (base.icon || base.name.slice(0, 1)).toUpperCase() }}
          </div>
          <div class="my-apps-landing__base-body">
            <h3>{{ base.name }}</h3>
            <span class="my-apps-landing__base-badge">最近打开</span>
          </div>
          <button
            class="my-apps-landing__base-open"
            type="button"
            :disabled="openingBaseId === base.id"
            @click="openBase(base)"
          >
            {{ openingBaseId === base.id ? '打开中...' : '打开' }}
          </button>
        </article>
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
// #5392 (「我的应用」landing page): the post-login / unknown-deep-link default (see
// featureFlags.ts#resolveHomePath). Deliberately small — reuses the EXISTING platform apps
// catalog composable and the EXISTING multitable base-picker store/local-state, adds no new
// permission logic, and does not touch the top nav (full nav IA restructure is a separate,
// deferred item).
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { usePlatformApps, type PlatformAppSummary } from '../composables/usePlatformApps'
import { useAuth } from '../composables/useAuth'
import { useFeatureFlags } from '../stores/featureFlags'
import { buildRouteGuardContext, buildRouteGuardInput, resolveRouteGuardDecision } from '../router/guardPolicy'
import { multitableClient } from '../multitable/api/client'
import type { MetaBase, MetaContext, MetaSheet, MetaView } from '../multitable/types'
import {
  decorateAndSortBases,
  readRecentBaseOpens,
  rememberRecentBaseOpen,
  type DecoratedBase,
} from '../multitable/utils/base-local-state'
import { AppRouteNames, ROUTE_PATHS } from '../router/types'

const RECENT_BASE_CARD_LIMIT = 6

const router = useRouter()
const auth = useAuth()
const flags = useFeatureFlags()

const multitableHomePath = ROUTE_PATHS.MULTITABLE_HOME

// --- 我的应用 -------------------------------------------------------------------------------
const { activeApps, loading: appsLoading, error: appsError, fetchApps } = usePlatformApps()

interface AppCard {
  app: PlatformAppSummary
  valueStatement: string
  enterPath: string
}

function resolveAppEntryPath(app: PlatformAppSummary): string {
  return (
    app.entryPath
    || app.navigation.find((item) => item.location !== 'hidden')?.path
    || `/apps/${encodeURIComponent(app.id)}`
  )
}

/**
 * Scope item 3: no NEW permission logic — this replays the exact pure decision
 * (guardPolicy.ts#resolveRouteGuardDecision) main.ts's own router guard already runs for every
 * navigation, against the route the entry path resolves to. A card is hidden only when that
 * SAME decision would redirect the user away; it can never grant reachability the route's own
 * guard would refuse, and resolution failure fails OPEN (shows the card) rather than hides one
 * on a guess — the target page's own guard remains authoritative either way.
 */
function isEntryReachable(entryPath: string): boolean {
  try {
    const resolved = router.resolve(entryPath)
    const decision = resolveRouteGuardDecision(
      buildRouteGuardInput({ path: entryPath, meta: resolved.meta }),
      buildRouteGuardContext({ auth, flags }),
    )
    return decision.action === 'allow'
  } catch {
    return true
  }
}

const visibleApps = computed<AppCard[]>(() => {
  return activeApps.value
    .map((app) => ({
      app,
      valueStatement: app.valueStatement || app.boundedContext.description || '',
      enterPath: resolveAppEntryPath(app),
    }))
    .filter((card) => isEntryReachable(card.enterPath))
})

async function refreshApps(): Promise<void> {
  await fetchApps({ force: true })
}

// --- 最近打开的 Base -------------------------------------------------------------------------
// Reuses MultitableHomeView.vue's own store/API verbatim: multitableClient.listBases() for the
// accessible-base list, base-local-state.ts's localStorage-backed 最近打开/收藏 decoration for
// recency (the SAME flag MultitableHomeView's base cards already surface), and its
// resolveOpenTarget/rememberRecentBaseOpen open-a-base flow.
const bases = ref<MetaBase[]>([])
const baseLoading = ref(false)
const baseError = ref('')
const openingBaseId = ref<string | null>(null)
const recentBaseOpens = ref(readRecentBaseOpens())

const recentBases = computed<DecoratedBase[]>(() => {
  return decorateAndSortBases(bases.value, [], recentBaseOpens.value)
    .filter((base) => Boolean(base.lastOpenedAt))
    .slice(0, RECENT_BASE_CARD_LIMIT)
})

async function loadBases(): Promise<void> {
  baseLoading.value = true
  baseError.value = ''
  try {
    const data = await multitableClient.listBases()
    bases.value = data.bases ?? []
  } catch (error) {
    baseError.value = error instanceof Error ? error.message : '加载最近打开的 Base 失败'
  } finally {
    baseLoading.value = false
  }
}

function resolveOpenTarget(context: MetaContext): { sheet: MetaSheet; view: MetaView } | null {
  const sheet = context.sheet ?? context.sheets[0] ?? null
  if (!sheet) return null
  const view = context.views.find((candidate) => candidate.sheetId === sheet.id) ?? context.views[0] ?? null
  return view ? { sheet, view } : null
}

async function openBase(base: MetaBase): Promise<void> {
  openingBaseId.value = base.id
  baseError.value = ''
  try {
    const context = await multitableClient.loadContext({ baseId: base.id })
    const target = resolveOpenTarget(context)
    if (!target) {
      baseError.value = '这个 Base 还没有可打开的 Sheet 或 View。'
      return
    }
    recentBaseOpens.value = rememberRecentBaseOpen(base.id)
    await router.push({
      name: AppRouteNames.MULTITABLE,
      params: { sheetId: target.sheet.id, viewId: target.view.id },
      query: { baseId: base.id },
    })
  } catch (error) {
    baseError.value = error instanceof Error ? error.message : '打开 Base 失败'
  } finally {
    openingBaseId.value = null
  }
}

onMounted(async () => {
  await Promise.all([fetchApps(), loadBases()])
})
</script>

<style scoped>
.my-apps-landing {
  min-height: calc(100vh - 64px);
  padding: 32px;
  background:
    radial-gradient(circle at 12% 8%, rgba(37, 99, 235, 0.12), transparent 28%),
    linear-gradient(135deg, #f8fafc 0%, #eef2ff 48%, #f8fafc 100%);
  color: #0f172a;
}

.my-apps-landing__hero,
.my-apps-landing__section {
  max-width: 1120px;
  margin: 0 auto;
}

.my-apps-landing__eyebrow {
  margin: 0 0 8px;
  color: #2563eb;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.my-apps-landing h1 {
  margin: 0;
  font-size: clamp(28px, 4.5vw, 44px);
  line-height: 1.1;
}

.my-apps-landing__subtitle {
  max-width: 720px;
  margin: 16px 0 0;
  color: #475569;
  font-size: 15px;
  line-height: 1.7;
}

.my-apps-landing__section {
  margin-top: 28px;
  border: 1px solid rgba(148, 163, 184, 0.36);
  border-radius: 28px;
  background: rgba(255, 255, 255, 0.82);
  box-shadow: 0 24px 70px rgba(15, 23, 42, 0.08);
  overflow: hidden;
}

.my-apps-landing__section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 22px 24px;
  border-bottom: 1px solid #e2e8f0;
}

.my-apps-landing__section-head h2 {
  margin: 0;
  font-size: 18px;
}

.my-apps-landing__section-link {
  font-size: 13px;
  color: #2563eb;
  text-decoration: none;
  white-space: nowrap;
}

.my-apps-landing__section-link:hover {
  text-decoration: underline;
}

.my-apps-landing__retry {
  border: 1px solid #cbd5e1;
  border-radius: 999px;
  padding: 6px 14px;
  background: #fff;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.my-apps-landing__state,
.my-apps-landing__empty {
  padding: 32px 24px;
  color: #64748b;
}

.my-apps-landing__error {
  margin: 18px 24px 0;
  border: 1px solid #fecaca;
  border-radius: 16px;
  padding: 12px 14px;
  background: #fef2f2;
  color: #b91c1c;
}

.my-apps-landing__app-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 16px;
  padding: 18px;
}

.my-apps-landing__app-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 1px solid #e2e8f0;
  border-radius: 18px;
  padding: 18px;
  background: #fff;
}

.my-apps-landing__app-card h3 {
  margin: 0;
  font-size: 16px;
}

.my-apps-landing__app-value {
  flex: 1;
  margin: 0;
  color: #475569;
  font-size: 13px;
  line-height: 1.6;
}

.my-apps-landing__enter {
  align-self: flex-start;
  border: none;
  border-radius: 999px;
  padding: 8px 18px;
  background: #2563eb;
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  text-decoration: none;
}

.my-apps-landing__base-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 14px;
  padding: 18px;
}

.my-apps-landing__base-card {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 12px;
  align-items: center;
  border: 1px solid #e2e8f0;
  border-radius: 18px;
  padding: 14px;
  background: #fff;
}

.my-apps-landing__base-icon {
  width: 42px;
  height: 42px;
  border-radius: 14px;
  display: grid;
  place-items: center;
  color: #fff;
  font-weight: 800;
}

.my-apps-landing__base-body h3 {
  margin: 0;
  font-size: 15px;
}

.my-apps-landing__base-badge {
  display: inline-block;
  margin-top: 6px;
  border-radius: 999px;
  padding: 3px 7px;
  background: #eff6ff;
  color: #1d4ed8;
  font-size: 11px;
  font-weight: 700;
}

.my-apps-landing__base-open {
  border: 1px solid #2563eb;
  border-radius: 999px;
  padding: 8px 16px;
  background: #2563eb;
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}

.my-apps-landing__base-open:disabled {
  cursor: not-allowed;
  opacity: 0.62;
}

@media (max-width: 760px) {
  .my-apps-landing {
    padding: 20px;
  }

  .my-apps-landing__section-head {
    display: grid;
    gap: 8px;
  }
}
</style>
