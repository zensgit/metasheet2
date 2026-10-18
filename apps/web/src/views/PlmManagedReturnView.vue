<template>
  <section data-testid="plm-managed-return">
    <h1>返回 BOM 评审</h1>
    <p data-testid="plm-managed-return-status">{{ message }}</p>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { readAuthSessionSignature, readStoredToken, TOKEN_KEYS } from '../composables/authPrincipal'
import {
  bridgeCorrelationMatches,
  completeManagedBrowserBridge,
  PlmManagedCompanionError,
} from '../services/plm/plmManagedCompanion'

const message = ref('正在确认本次返回…')

onMounted(async () => {
  readStoredToken()
  for (const key of TOKEN_KEYS) localStorage.getItem(key)
  const params = new URLSearchParams(window.location.search)
  const code = params.get('code') ?? ''
  const state = params.get('state') ?? ''
  const extra = [...params.keys()].filter((key) => key !== 'code' && key !== 'state')
  window.history.replaceState(null, '', '/plm/managed-return')
  const presentedKeys = [...params.keys()]
  if (!code || !state || extra.length > 0 || new Set(presentedKeys).size !== presentedKeys.length) {
    message.value = '托管回跳被拒绝'
    return
  }
  const signature = readAuthSessionSignature()
  if (readAuthSessionSignature() !== signature || !(await bridgeCorrelationMatches(state))) {
    message.value = '登录身份已变化，未继续交换'
    return
  }
  try {
    const completed = await completeManagedBrowserBridge(code, state)
    if (completed.stale) {
      message.value = '登录身份已变化，未采用返回结果'
      return
    }
    window.location.assign(completed.destination)
  } catch (error) {
    message.value = error instanceof PlmManagedCompanionError ? '托管回跳被拒绝' : '托管回跳被拒绝'
  }
})
</script>
