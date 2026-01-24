<template>
  <div id="app">
    <nav class="app-nav" v-if="showNav">
      <div class="nav-brand">
        <span class="brand-text">MetaSheet</span>
      </div>
      <div class="nav-links">
        <router-link
          v-for="view in navViews"
          :key="view.id"
          :to="view.query ? { path: view.path, query: view.query } : view.path"
          class="nav-link"
        >
          {{ view.name }}
        </router-link>
      </div>
    </nav>
    <main class="app-main">
      <router-view />
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { usePlugins } from './composables/usePlugins'
import { buildNavViews, resolveAppViews } from './router/viewRegistry'

const route = useRoute()
const { views, disabledViewIds, loaded, fetchPlugins } = usePlugins()

const showNav = computed(() => {
  return route.meta?.hideNavbar !== true
})

const navViews = computed(() => buildNavViews(resolveAppViews(views.value, disabledViewIds.value)))

onMounted(async () => {
  if (!loaded.value) {
    await fetchPlugins()
  }
})
</script>

<style>
/* Reset and base styles */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html, body {
  height: 100%;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: #333;
  background-color: #f5f5f5;
}

#app {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.app-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  height: 50px;
  background: #fff;
  border-bottom: 1px solid #e0e0e0;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

.nav-brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.brand-text {
  font-size: 18px;
  font-weight: 600;
  color: #1976d2;
}

.nav-links {
  display: flex;
  gap: 8px;
}

.nav-link {
  padding: 8px 16px;
  text-decoration: none;
  color: #666;
  border-radius: 4px;
  transition: all 0.2s;
}

.nav-link:hover {
  background-color: #f0f0f0;
  color: #333;
}

.nav-link.router-link-active {
  background-color: #e3f2fd;
  color: #1976d2;
}

.app-main {
  flex: 1;
  overflow: auto;
}

/* Dark mode support */
@media (prefers-color-scheme: dark) {
  html, body {
    background-color: #1a1a1a;
    color: #e0e0e0;
  }

  .app-nav {
    background: #2d2d2d;
    border-bottom-color: #404040;
  }

  .brand-text {
    color: #64b5f6;
  }

  .nav-link {
    color: #aaa;
  }

  .nav-link:hover {
    background-color: #3d3d3d;
    color: #fff;
  }

  .nav-link.router-link-active {
    background-color: #1e3a5f;
    color: #64b5f6;
  }
}
</style>
