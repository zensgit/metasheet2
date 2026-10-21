// 备料工作台 browser-acceptance harness (设计稿 §6.1 P0 十一条 / §6.2 P1 七条).
//
// WHAT THIS MOUNTS: the REAL `StockPreparationWorkspace.vue`, on a real Vue Router, with the real
// `--ms-*` token sheet — i.e. everything the app composes for `/stock-prep` EXCEPT the app shell's
// sidebar and its route guards, neither of which any acceptance item below is about.
//
// WHY A MINI ROUTER RATHER THAN THE APP'S. The shell reads `route.query` (`?tab=`, `?projectNo=`,
// `?projectId=`) and writes it back through `router.replace`, and §2.3 makes `?projectNo=` the
// 首页 ⇄ 工作区 state bit. So a router is mandatory; the app's own `appRoutes.ts` is not, and pulling
// it in would drag every other view's import closure (and its guards) into a lane that is about one
// page. `createMemoryHistory` keeps the harness page's own URL — which carries `?actor=` /
// `?scenario=` — from being rewritten by the shell's `replace`.
//
// WHY EVERY APP IMPORT IS DYNAMIC. `useLocale.ts` resolves the locale ONCE, at module evaluation,
// from `localStorage`; `useAuth`'s snapshot reads `user_roles` / `user_permissions` the same way.
// A static top-level import would evaluate those modules before this file could seed either, and the
// page would render in English against an anonymous principal. Same discipline as
// `approval-instance-consistency-race-harness.ts`.
//
// ELEMENT PLUS IS DELIBERATELY *NOT* REGISTERED GLOBALLY. 设计稿 G6 says the 备料 components must not
// depend on global registration (the jsdom specs host them on a bare `createApp`), and a harness that
// registered it would mask exactly that class of defect. The stylesheet is not imported either: the
// rail's 「默认收起」 assertion turns on the absence of a global `[hidden]` reset, and a lane that
// pulled in another stylesheet could only weaken that.
import { createApp, defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import '../src/styles/tokens.css'

/** The four principals §7 of the design distinguishes, spelled as the server spells them. */
const ACTORS = {
  // 值面看不见的队列观察者:只有 read。
  reader: { roles: [] as string[], permissions: ['stock-prep:read'] },
  // 一线:read ∧ operate(合取,不是蕴含 —— workbenchAccess.ts 的原话)。
  operator: { roles: [] as string[], permissions: ['stock-prep:read', 'stock-prep:operate'] },
  // 工作台管理员:stock-prep:admin,能开安装页,但 /admin/roles 会 403(F10)。
  stockadmin: { roles: [] as string[], permissions: ['stock-prep:admin'] },
  // 平台管理员:role:admin。
  platform: { roles: ['admin'], permissions: [] as string[] },
} as const

type ActorKey = keyof typeof ACTORS

declare global {
  interface Window {
    __STOCK_PREP_READY__?: boolean
    __STOCK_PREP_ACTOR__?: string
    __STOCK_PREP_SCENARIO__?: string
  }
}

function resolveActor(raw: string | null): ActorKey {
  return raw && Object.prototype.hasOwnProperty.call(ACTORS, raw) ? raw as ActorKey : 'operator'
}

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search)
  const actorKey = resolveActor(params.get('actor'))
  const actor = ACTORS[actorKey]
  const scenario = params.get('scenario') ?? 'ready'

  // ---- identity, minted locally, zero network ------------------------------------------------
  // `primeSession` fills `useAuth`'s session cache so `getCurrentUserId()` answers WITHOUT a
  // `/api/auth/session` round trip (the ops panel calls it on mount), and it persists the same
  // roles/permissions snapshot the shell's `getAccessSnapshot()` reads. The explicit
  // `localStorage` writes below are not redundant: they must be in place before the FIRST module
  // that reads them evaluates, and `user_roles`/`user_permissions` is exactly what
  // `workbenchAccess.ts` flattens.
  localStorage.setItem('metasheet_locale', 'zh-CN')
  localStorage.setItem('tenantId', 'syn-tenant')
  localStorage.setItem('user_roles', JSON.stringify(actor.roles))
  localStorage.setItem('user_permissions', JSON.stringify(actor.permissions))

  const { useAuth } = await import('../src/composables/useAuth')
  useAuth().primeSession({
    data: {
      user: {
        id: 'syn-user-self',
        tenantId: 'syn-tenant',
        roles: [...actor.roles],
        permissions: [...actor.permissions],
      },
    },
  })
  // `primeSession` → `persistUserSnapshot` rewrites the two keys from the payload; re-assert them so
  // an actor whose payload projection ever drifts cannot silently widen the principal under test.
  localStorage.setItem('user_roles', JSON.stringify(actor.roles))
  localStorage.setItem('user_permissions', JSON.stringify(actor.permissions))

  const { default: StockPreparationWorkspace } = await import(
    '../src/components/integration/stockPreparation/StockPreparationWorkspace.vue'
  )

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/stock-prep', name: 'stock-prep', component: StockPreparationWorkspace }],
  })

  // The query is carried over VERBATIM: `?tab=` and `?projectNo=` are the shell's own deep links and
  // several acceptance items are written in them. `actor`/`scenario` ride along harmlessly — the
  // shell reads three named keys and ignores everything else.
  await router.push({ path: '/stock-prep', query: Object.fromEntries(params.entries()) })
  await router.isReady()

  const app = createApp(defineComponent({ render: () => h(RouterView) }))
  app.use(router)
  app.mount('#app')

  document.documentElement.setAttribute('data-harness-actor', actorKey)
  document.documentElement.setAttribute('data-harness-scenario', scenario)
  window.__STOCK_PREP_ACTOR__ = actorKey
  window.__STOCK_PREP_SCENARIO__ = scenario
  window.__STOCK_PREP_READY__ = true
  window.dispatchEvent(new Event('stock-prep-harness-ready'))
}

void main()
