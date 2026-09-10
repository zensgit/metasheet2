<template>
  <section class="certificate-wallet" aria-labelledby="certificate-wallet-title">
    <header>
      <h2 id="certificate-wallet-title">{{ text('My certificates', '我的证书') }}</h2>
    </header>
    <p v-if="error" class="certificate-wallet__error" data-testid="elearning-certificate-wallet-error" role="status">{{ error }}</p>
    <p v-if="loading" data-testid="elearning-certificate-wallet-loading">{{ text('Loading certificates...', '正在加载证书…') }}</p>
    <p v-else-if="items.length === 0 && !error" data-testid="elearning-certificate-wallet-empty">{{ text('No certificates yet.', '暂无证书。') }}</p>
    <ul v-else data-testid="elearning-certificate-wallet-items">
      <li v-for="item in items" :key="item.issueId">
        <img
          v-if="item.backgroundImageUrl"
          :src="item.backgroundImageUrl"
          :alt="item.templateName"
          loading="lazy"
          referrerpolicy="no-referrer"
        >
        <div>
          <strong>{{ item.templateName }}</strong>
          <span>{{ text('Serial', '序列号') }}: {{ item.serialNumber }}</span>
          <time :datetime="item.issuedAt">{{ formatDate(item.issuedAt) }}</time>
          <dl v-if="Object.keys(item.parameters).length > 0">
            <div v-for="(value, key) in item.parameters" :key="key">
              <dt>{{ key }}</dt>
              <dd>{{ value }}</dd>
            </div>
          </dl>
        </div>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useLocale } from '../composables/useLocale'
import { ElearningApiError } from '../services/elearning'
import {
  listMyElearningCertificates,
  type ElearningCertificateIssue,
} from '../services/elearningCertificate'

const { isZh } = useLocale()
const items = ref<ElearningCertificateIssue[]>([])
const loading = ref(false)
const error = ref('')

function text(en: string, zh: string): string {
  return isZh.value ? zh : en
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(isZh.value ? 'zh-CN' : 'en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function errorText(value: unknown): string {
  if (value instanceof ElearningApiError) {
    if (value.status === 403) return text('You cannot read certificates.', '您无权查看证书。')
    if (value.status === 404) return text('Certificates are unavailable.', '当前无法查看证书。')
  }
  return text('Unable to load certificates. Try again.', '无法加载证书，请重试。')
}

async function load(): Promise<void> {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    items.value = await listMyElearningCertificates()
  } catch (value) {
    error.value = errorText(value)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
})
</script>

<style scoped>
.certificate-wallet { display: grid; gap: 10px; padding: 14px 16px; border: 1px solid #d7cfe8; border-radius: 10px; background: #fbf9ff; }
.certificate-wallet h2,
.certificate-wallet p { margin: 0; }
.certificate-wallet ul { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; }
.certificate-wallet li { display: grid; grid-template-columns: minmax(0, 120px) 1fr; gap: 12px; }
.certificate-wallet li > div { display: grid; gap: 4px; }
.certificate-wallet img { width: 100%; max-height: 84px; object-fit: cover; border-radius: 6px; }
.certificate-wallet dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 8px; margin: 4px 0 0; }
.certificate-wallet dl div { display: contents; }
.certificate-wallet dt { font-weight: 600; }
.certificate-wallet dd { margin: 0; }
.certificate-wallet__error { color: #b42318; }
@media (max-width: 560px) { .certificate-wallet li { grid-template-columns: 1fr; } }
</style>
