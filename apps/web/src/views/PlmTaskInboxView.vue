<template>
  <div class="plm-task-inbox-view" data-testid="plm-task-inbox-view">
    <div class="plm-task-inbox-view__toolbar">
      <label>
        PLM 数据源
        <input
          v-model.trim="dataSourceId"
          type="text"
          placeholder="数据源 ID"
          data-testid="plm-task-inbox-view-datasource"
        />
      </label>
    </div>

    <p v-if="!dataSourceId" class="plm-task-inbox-view__hint">
      请选择或输入一个 PLM 数据源以查看你的任务收件箱。
    </p>
    <PlmTaskInboxBoard
      v-else
      :data-source-id="dataSourceId"
      :plm-user-token="plmUserToken"
    />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRoute } from 'vue-router'
import PlmTaskInboxBoard from '../components/plm/PlmTaskInboxBoard.vue'

const route = useRoute()
const dataSourceId = ref<string>(typeof route.query.dataSource === 'string' ? route.query.dataSource : '')

/**
 * Family-I linkage seam. This lane requires the VIEWING USER's own PLM bearer (full login), which
 * both provider taskbooks make non-negotiable and which does NOT exist as a product surface in this
 * repo yet (there is no per-user Yuantus identity linking / SSO federation — only a single
 * admin-configured service account, which §6 forbids using here). Until that surface exists this
 * resolver returns '' and the board degrades to `no-plm-credential` — it NEVER substitutes the
 * service account. When real Family-I linking lands, resolve the viewer's linked PLM bearer here.
 */
function resolvePlmUserToken(): string {
  if (typeof route.query.plmUserToken === 'string' && route.query.plmUserToken) return route.query.plmUserToken
  return ''
}

const plmUserToken = ref<string>(resolvePlmUserToken())
</script>

<style scoped>
.plm-task-inbox-view { padding: 16px; display: flex; flex-direction: column; gap: 16px; }
.plm-task-inbox-view__toolbar { display: flex; gap: 12px; align-items: center; }
.plm-task-inbox-view__toolbar label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #374151; }
.plm-task-inbox-view__hint { font-size: 13px; color: #6b7280; }
</style>
