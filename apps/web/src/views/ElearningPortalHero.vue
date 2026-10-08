<template>
  <section v-if="settings?.revisionId" class="portal-hero" data-testid="elearning-portal-hero" aria-labelledby="elearning-portal-title">
    <img
      v-if="settings.bannerUrl"
      class="portal-hero__banner"
      data-testid="elearning-portal-banner"
      :src="settings.bannerUrl"
      alt=""
    >
    <div class="portal-hero__body">
      <h2 id="elearning-portal-title">{{ settings.siteName }}</h2>
      <p v-if="settings.tagline">{{ settings.tagline }}</p>
      <nav v-if="settings.navigation.length > 0" :aria-label="text('Learning portal', '学习门户')">
        <a v-for="item in settings.navigation" :key="item.href" :href="item.href">{{ item.label }}</a>
      </nav>
    </div>
  </section>
  <p v-else-if="error" class="portal-hero__error" data-testid="elearning-portal-error" role="status">{{ error }}</p>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useLocale } from '../composables/useLocale'
import { ElearningApiError } from '../services/elearning'
import {
  getElearningPortalSettings,
  type ElearningPortalSettings,
} from '../services/elearningPortal'

const { isZh } = useLocale()
const settings = ref<ElearningPortalSettings | null>(null)
const error = ref('')

function text(en: string, zh: string): string {
  return isZh.value ? zh : en
}

function errorText(value: unknown): string {
  if (value instanceof ElearningApiError && value.status === 403) {
    return text('You cannot read this portal.', '您无权查看该学习门户。')
  }
  return text('Unable to load portal settings.', '无法加载门户设置。')
}

onMounted(() => {
  void getElearningPortalSettings()
    .then((result) => {
      settings.value = result
    })
    .catch((value) => {
      error.value = errorText(value)
    })
})
</script>

<style scoped>
.portal-hero { overflow: hidden; border: 1px solid #c9d9ee; border-radius: 12px; background: #f5f9ff; }
.portal-hero__banner { display: block; width: 100%; max-height: 220px; object-fit: cover; }
.portal-hero__body { display: grid; gap: 8px; padding: 16px; }
.portal-hero h2,
.portal-hero p { margin: 0; }
.portal-hero nav { display: flex; flex-wrap: wrap; gap: 8px; }
.portal-hero a { padding: 6px 10px; border-radius: 999px; background: #e2edff; color: #174ea6; text-decoration: none; }
.portal-hero__error { color: #b42318; }
</style>
