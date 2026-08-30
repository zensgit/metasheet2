<template>
  <section class="portal-admin" aria-labelledby="elearning-portal-admin-title">
    <header>
      <h2 id="elearning-portal-admin-title">{{ text('Learning portal', '学习门户') }}</h2>
      <p>{{ text('Customize the learner header and internal navigation.', '设置员工端标题、横幅和站内导航。') }}</p>
    </header>

    <form class="portal-admin__form" data-testid="elearning-portal-admin-form" @submit.prevent="void submit()">
      <label>
        <span>{{ text('Site name', '站点名称') }}</span>
        <input v-model="siteName" data-testid="elearning-portal-site-name" type="text" maxlength="80" required :disabled="busy" autocomplete="off">
      </label>
      <label>
        <span>{{ text('Tagline (optional)', '标语（可选）') }}</span>
        <input v-model="tagline" data-testid="elearning-portal-tagline" type="text" maxlength="160" :disabled="busy" autocomplete="off">
      </label>
      <label>
        <span>{{ text('Banner URL (HTTPS or internal path)', '横幅地址（HTTPS 或站内路径）') }}</span>
        <input v-model="bannerUrl" data-testid="elearning-portal-banner-url" type="text" maxlength="512" :disabled="busy" autocomplete="off">
      </label>

      <fieldset>
        <legend>{{ text('Internal navigation', '站内导航') }}</legend>
        <div
          v-for="(item, index) in navigation"
          :key="item.localId"
          class="portal-admin__navigation"
          :data-testid="`elearning-portal-navigation-${index}`"
        >
          <input v-model="item.label" :aria-label="text('Navigation label', '导航名称')" type="text" maxlength="40" :disabled="busy">
          <input v-model="item.href" :aria-label="text('Internal path', '站内路径')" type="text" maxlength="512" placeholder="/elearning" :disabled="busy">
          <button type="button" :disabled="busy" @click="removeNavigation(index)">{{ text('Remove', '删除') }}</button>
        </div>
        <button
          type="button"
          data-testid="elearning-portal-add-navigation"
          :disabled="busy || navigation.length >= 8"
          @click="addNavigation"
        >
          {{ text('Add navigation', '添加导航') }}
        </button>
      </fieldset>

      <button data-testid="elearning-portal-save" type="submit" :disabled="busy || loading">
        {{ busy ? text('Saving...', '正在保存…') : text('Publish portal settings', '发布门户设置') }}
      </button>
    </form>

    <p v-if="loading" data-testid="elearning-portal-admin-loading">{{ text('Loading portal settings...', '正在加载门户设置…') }}</p>
    <p
      v-if="status"
      class="portal-admin__status"
      :class="{ 'portal-admin__status--error': error }"
      data-testid="elearning-portal-admin-status"
      role="status"
    >
      {{ status }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useLocale } from '../composables/useLocale'
import { ElearningApiError } from '../services/elearning'
import {
  createElearningPortalRequestIdTracker,
  getElearningPortalSettings,
  publishElearningPortalSettings,
} from '../services/elearningPortal'

interface NavigationDraft {
  localId: string
  label: string
  href: string
}

const { isZh } = useLocale()
const requestIds = createElearningPortalRequestIdTracker()
const siteName = ref('')
const tagline = ref('')
const bannerUrl = ref('')
const navigation = ref<NavigationDraft[]>([])
const loading = ref(false)
const busy = ref(false)
const status = ref('')
const error = ref(false)
let localSerial = 0

function text(en: string, zh: string): string {
  return isZh.value ? zh : en
}

function localId(): string {
  localSerial += 1
  return `portal-navigation-${localSerial}`
}

function addNavigation(): void {
  if (navigation.value.length >= 8) return
  navigation.value.push({ localId: localId(), label: '', href: '' })
}

function removeNavigation(index: number): void {
  navigation.value.splice(index, 1)
}

function errorText(value: unknown): string {
  if (value instanceof ElearningApiError) {
    if (value.status === 409) return text('These request values conflict with an earlier publish.', '本次请求内容与先前发布记录冲突。')
    if (value.status === 403) return text('You cannot manage portal settings.', '您无权管理门户设置。')
    if (value.status === 404) return text('Portal customization is disabled.', '门户自定义功能未启用。')
  }
  return text('Unable to save portal settings. Try again.', '无法保存门户设置，请重试。')
}

async function load(): Promise<void> {
  loading.value = true
  error.value = false
  status.value = ''
  try {
    const current = await getElearningPortalSettings()
    siteName.value = current.siteName ?? ''
    tagline.value = current.tagline ?? ''
    bannerUrl.value = current.bannerUrl ?? ''
    navigation.value = current.navigation.map((item) => ({
      localId: localId(),
      label: item.label,
      href: item.href,
    }))
  } catch (value) {
    error.value = true
    status.value = errorText(value)
  } finally {
    loading.value = false
  }
}

async function submit(): Promise<void> {
  if (busy.value || loading.value) return
  const draft = {
    siteName: siteName.value,
    tagline: tagline.value.trim() === '' ? null : tagline.value,
    bannerUrl: bannerUrl.value.trim() === '' ? null : bannerUrl.value,
    navigation: navigation.value.map((item) => ({
      label: item.label,
      href: item.href,
    })),
  }
  busy.value = true
  error.value = false
  status.value = ''
  try {
    const result = await publishElearningPortalSettings({
      requestId: requestIds.forPublish(draft),
      ...draft,
    })
    siteName.value = result.siteName ?? ''
    tagline.value = result.tagline ?? ''
    bannerUrl.value = result.bannerUrl ?? ''
    navigation.value = result.navigation.map((item) => ({
      localId: localId(),
      label: item.label,
      href: item.href,
    }))
    status.value = result.duplicate
      ? text('These settings were already published.', '该门户设置此前已发布。')
      : text(`Portal settings v${result.version} published.`, `门户设置 v${result.version} 已发布。`)
  } catch (value) {
    error.value = true
    status.value = errorText(value)
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  void load()
})
</script>

<style scoped>
.portal-admin { display: grid; gap: 12px; padding: 14px 16px; border: 1px solid #cbd5e1; border-radius: 10px; background: #f8fafc; }
.portal-admin h2,
.portal-admin p { margin: 0; }
.portal-admin__form,
.portal-admin__form label,
.portal-admin__form fieldset { display: grid; gap: 8px; }
.portal-admin__form fieldset { margin: 0; padding: 10px; border: 1px solid #dbe4ef; border-radius: 8px; }
.portal-admin__form input { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 7px; }
.portal-admin__navigation { display: grid; grid-template-columns: minmax(120px, 0.7fr) minmax(180px, 1.3fr) auto; gap: 8px; }
.portal-admin button { min-height: 36px; }
.portal-admin__status--error { color: #b42318; }
@media (max-width: 620px) { .portal-admin__navigation { grid-template-columns: 1fr; } }
</style>
