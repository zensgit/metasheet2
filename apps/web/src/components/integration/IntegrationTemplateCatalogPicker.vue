<template>
  <div class="template-catalog" :data-testid="`${testidPrefix}-template-catalog`">
    <!-- Collapsed by default (design-lock: ADD-ONLY, the blank-form path stays the default surface —
         see IntegrationReadSourceWizard.spec.ts / IntegrationCompositionWizard.spec.ts, whose existing
         assertions must not change). Native <button>, same rationale as every other toggle in this
         component family: Element Plus is not globally registered in every host that mounts these
         panels in tests. -->
    <button
      type="button"
      class="template-catalog__toggle"
      :data-testid="`${testidPrefix}-template-catalog-toggle`"
      :aria-expanded="expanded ? 'true' : 'false'"
      @click="expanded = !expanded"
    >
      <el-icon><ArrowDown v-if="expanded" /><ArrowRight v-else /></el-icon>
      {{ bi('从模板开始', 'Start from a template') }}
    </button>

    <div v-show="expanded" class="template-catalog__body" :data-testid="`${testidPrefix}-template-catalog-body`">
      <p class="template-catalog__desc">{{ bi(
        '选一个已验证的接入场景，预填下面向导的初始状态；你仍然只需要补充少量必填的真实值。',
        'Pick a validated connection scenario to pre-fill the wizard below — you still only need to fill in a few required real values.',
      ) }}</p>
      <div class="template-catalog__grid" :data-testid="`${testidPrefix}-template-catalog-grid`">
        <button
          v-for="entry in entries"
          :key="entry.id"
          type="button"
          class="template-catalog__card"
          :data-testid="`${testidPrefix}-template-catalog-card-${entry.id}`"
          @click="selectEntry(entry)"
        >
          <span class="template-catalog__card-title">{{ bi(entry.title.zh, entry.title.en) }}</span>
          <span class="template-catalog__card-subtitle">{{ bi(entry.oneLiner.zh, entry.oneLiner.en) }}</span>
        </button>
      </div>
      <p v-if="entries.length === 0" class="template-catalog__empty" :data-testid="`${testidPrefix}-template-catalog-empty`">
        {{ bi('暂无可用模板。', 'No templates available yet.') }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
// TC-1 connector/experience template catalog picker (design-lock
// docs/development/integration-connector-template-catalog-design-lock-20260708.md, #3879, §1-§3).
//
// Presentation shell ONLY: it lists `INTEGRATION_TEMPLATE_CATALOG` entries filtered to the
// `seedsWizard` kind the host panel owns, and emits the chosen entry — it owns no service call, no
// draft, no validation, and does not itself apply the seed (the host panel calls
// `seedReadSourceDraft`/`seedCompositionDraft` in its own `@select` handler, on its own existing
// `draft`). This mirrors IU-3/IU-4's own wizard shells: a REORDERING/PRESENTATION layer over state the
// parent owns, never a second state or a second code path (design-lock §2 hard lock).
//
// Card visuals are copied verbatim from IntegrationReadSourceWizard.vue's `.iu3-wizard__card` (scoped
// styles cannot be shared across SFCs — see that file's own precedent, where IU-4's
// IntegrationCompositionWizard.vue does the same), renamed to `.template-catalog__card`; token-only
// (UF-1 hard lock), zero hex/rgb literals.
import { computed, ref } from 'vue'
import { ArrowDown, ArrowRight } from '@element-plus/icons-vue'
import { useLocale } from '../../composables/useLocale'
import {
  integrationTemplateCatalogEntriesFor,
  type IntegrationTemplateCatalogEntry,
  type IntegrationTemplateSeedsWizard,
} from '../../services/integration/readSourceTemplateCatalog'

const props = defineProps<{
  // Which wizard this picker instance seeds — the host panel only ever wants the subset of the catalog
  // relevant to the draft IT owns (a read-source panel cannot meaningfully seed a composition draft,
  // and vice versa), so filtering happens here rather than pushing "pick the right entries" logic onto
  // every caller.
  seedsWizard: IntegrationTemplateSeedsWizard
  // Distinguishes data-testids between the two host panels (`rsc-*` / `rscauth-*` — the codebase's
  // existing per-panel testid prefix convention) so mounting both in the same page never collides.
  testidPrefix: string
}>()

const emit = defineEmits<{
  (e: 'select', entry: IntegrationTemplateCatalogEntry): void
}>()

const { locale } = useLocale()
function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const expanded = ref(false)

const entries = computed(() => integrationTemplateCatalogEntriesFor(props.seedsWizard))

function selectEntry(entry: IntegrationTemplateCatalogEntry): void {
  emit('select', entry)
}
</script>

<style scoped>
/* Token-only (UF-1 / design-lock §3 hard lock) — every style in this file uses var(--ms-*), zero
   hex/rgb literals; card class values copied verbatim from IntegrationReadSourceWizard.vue's
   .iu3-wizard__card family (see script header). */
.template-catalog {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
  margin-bottom: var(--ms-space-3);
}
.template-catalog__toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--ms-space-1);
  align-self: flex-start;
  border: none;
  background: none;
  color: var(--ms-color-primary);
  font-size: 13px;
  cursor: pointer;
  padding: 0;
}
.template-catalog__body {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-md);
  padding: var(--ms-space-3);
}
.template-catalog__desc {
  margin: 0;
  color: var(--ms-text-2);
  font-size: 13px;
}
.template-catalog__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: var(--ms-space-3);
}
.template-catalog__card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--ms-space-1);
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-md);
  background: var(--ms-bg-card);
  cursor: pointer;
  text-align: left;
  font: inherit;
}
.template-catalog__card:hover {
  border-color: var(--ms-color-primary);
}
.template-catalog__card-title {
  font-size: 14px;
  font-weight: var(--ms-font-weight-title);
  color: var(--ms-text-1);
}
.template-catalog__card-subtitle {
  font-size: 12px;
  color: var(--ms-text-2);
}
.template-catalog__empty {
  color: var(--ms-text-3);
  font-size: 13px;
  margin: 0;
}
</style>
