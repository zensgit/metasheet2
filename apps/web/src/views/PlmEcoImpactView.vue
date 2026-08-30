<template>
  <div class="plm-eco-impact-view" data-testid="plm-eco-impact-view">
    <div class="plm-eco-impact-view__toolbar">
      <label>
        PLM 数据源
        <input v-model.trim="dataSourceId" type="text" placeholder="数据源 ID" data-testid="plm-eco-impact-view-datasource" />
      </label>
      <label>
        ECO ID
        <input v-model.trim="ecoId" type="text" placeholder="ECO ID" data-testid="plm-eco-impact-view-eco" />
      </label>
    </div>

    <p v-if="!dataSourceId || !ecoId" class="plm-eco-impact-view__hint">
      请输入 PLM 数据源与 ECO ID 以查看影响分析工作集。
    </p>
    <PlmEcoImpactWorkset
      v-else
      :data-source-id="dataSourceId"
      :eco-id="ecoId"
      :plm-user-token="plmUserToken"
    />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRoute } from 'vue-router'
import PlmEcoImpactWorkset from '../components/plm/PlmEcoImpactWorkset.vue'

const route = useRoute()
const dataSourceId = ref<string>(typeof route.query.dataSource === 'string' ? route.query.dataSource : '')
const ecoId = ref<string>(
  typeof route.params.ecoId === 'string' && route.params.ecoId
    ? route.params.ecoId
    : (typeof route.query.ecoId === 'string' ? route.query.ecoId : ''),
)

/**
 * Family-I linkage seam — identical rationale to PlmTaskInboxView. This lane requires the viewing
 * user's own PLM bearer (full login), which is NOT a product surface in this repo yet. Until it is,
 * this returns '' and the workset degrades to `no-plm-credential`; it NEVER substitutes the service
 * account (§7). When per-user PLM identity linking lands, resolve the viewer's linked bearer here.
 */
function resolvePlmUserToken(): string {
  return ''
}
const plmUserToken = ref<string>(resolvePlmUserToken())
</script>

<style scoped>
.plm-eco-impact-view { padding: 16px; display: flex; flex-direction: column; gap: 16px; }
.plm-eco-impact-view__toolbar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.plm-eco-impact-view__toolbar label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #374151; }
.plm-eco-impact-view__hint { font-size: 13px; color: #6b7280; }
</style>
