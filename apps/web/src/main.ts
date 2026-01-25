/**
 * Vue Application Entry Point
 */
import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import App from './App.vue'
import { usePlugins } from './composables/usePlugins'
import { buildViewRoutes, resolveAppViews } from './router/viewRegistry'

// Legacy views remain available for compatibility
import GridView from './views/GridView.vue'
import KanbanView from './views/KanbanView.vue'
import LoginView from './views/LoginView.vue'

async function bootstrap() {
  const { views, disabledViewIds, fetchPlugins } = usePlugins()
  await fetchPlugins()

  const appViews = resolveAppViews(views.value, disabledViewIds.value)
  const viewRoutes = buildViewRoutes(appViews)

  const routes: RouteRecordRaw[] = [
    {
      path: '/',
      name: 'home',
      redirect: { path: '/grid', query: { source: 'meta' } }
    },
    {
      path: '/login',
      name: 'login',
      component: LoginView,
      meta: { title: 'Login' }
    },
    ...viewRoutes,
    {
      path: '/grid-legacy',
      name: 'grid-legacy',
      component: GridView,
      meta: { title: 'Grid (Legacy)' }
    },
    {
      path: '/kanban-legacy',
      name: 'kanban-legacy',
      component: KanbanView,
      meta: { title: 'Kanban (Legacy)' }
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      redirect: '/'
    }
  ]

  const router = createRouter({
    history: createWebHistory(),
    routes
  })

  router.beforeEach((to, from, next) => {
    const title = to.meta?.title
    if (title) {
      document.title = `${title} - MetaSheet`
    } else {
      document.title = 'MetaSheet'
    }
    next()
  })

  const app = createApp(App)
  app.use(router)
  app.mount('#app')
}

void bootstrap()
