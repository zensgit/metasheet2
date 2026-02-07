<template>
  <section class="home-redirect">
    <div class="home-redirect__card">
      <div class="home-redirect__title">Loading…</div>
      <div class="home-redirect__desc">Preparing your workspace.</div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useFeatureFlags } from '../stores/featureFlags'

const router = useRouter()
const { loadProductFeatures, resolveHomePath } = useFeatureFlags()

onMounted(async () => {
  await loadProductFeatures()
  await router.replace(resolveHomePath())
})
</script>

<style scoped>
.home-redirect {
  padding: 24px;
  display: grid;
  place-items: center;
}

.home-redirect__card {
  width: min(520px, 100%);
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 14px;
  padding: 22px;
  display: grid;
  gap: 8px;
}

.home-redirect__title {
  font-weight: 600;
  font-size: 16px;
}

.home-redirect__desc {
  color: #6b7280;
  font-size: 14px;
}
</style>

