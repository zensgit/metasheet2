<template>
  <section class="multitable-template-detail" data-testid="multitable-template-detail">
    <header class="multitable-template-detail__top">
      <router-link class="multitable-template-detail__back" :to="{ name: TemplatesRouteName }">
        {{ workbenchLabel('detail.back', isZh) }}
      </router-link>
    </header>

    <div v-if="loading" class="multitable-template-detail__state">
      {{ workbenchLabel('detail.loading', isZh) }}
    </div>
    <p v-else-if="errorMessage" class="multitable-template-detail__error" role="alert">
      {{ errorMessage }}
    </p>
    <div v-else-if="!template" class="multitable-template-detail__state">
      {{ workbenchLabel('detail.notFound', isZh) }}
    </div>
    <template v-else>
      <header class="multitable-template-detail__hero">
        <span
          class="multitable-template-detail__icon"
          :style="{ background: template.color || '#2563eb' }"
        >
          {{ template.icon || template.name.slice(0, 1).toUpperCase() }}
        </span>
        <div class="multitable-template-detail__heading">
          <h1>{{ template.name }}</h1>
          <p class="multitable-template-detail__description">{{ template.description }}</p>
          <small class="multitable-template-detail__meta">
            {{ categoryDisplay }} ·
            {{ cardSheets(template.sheets.length, isZh) }} ·
            {{ cardFields(fieldCount, isZh) }} ·
            {{ cardViews(viewCount, isZh) }}
          </small>
        </div>
      </header>

      <section
        v-for="sheet in template.sheets"
        :key="sheet.id"
        class="multitable-template-detail__sheet"
      >
        <h2>{{ sheet.name }}</h2>
        <p v-if="sheet.description" class="multitable-template-detail__sheet-desc">
          {{ sheet.description }}
        </p>

        <h3>{{ workbenchLabel('detail.fieldsTitle', isZh) }}</h3>
        <table class="multitable-template-detail__fields" data-testid="template-detail-fields">
          <thead>
            <tr>
              <th>{{ workbenchLabel('detail.colFieldName', isZh) }}</th>
              <th>{{ workbenchLabel('detail.colFieldType', isZh) }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="field in sheet.fields" :key="field.id">
              <td>{{ field.name }}</td>
              <td><code>{{ field.type }}</code></td>
            </tr>
          </tbody>
        </table>

        <h3>{{ workbenchLabel('detail.viewsTitle', isZh) }}</h3>
        <ul class="multitable-template-detail__views" data-testid="template-detail-views">
          <li v-for="view in sheet.views" :key="view.id">
            <strong>{{ view.name }}</strong>
            <code>{{ view.type }}</code>
            <span v-if="groupByFieldName(sheet, view)">
              {{ workbenchLabel('detail.groupBy', isZh) }}: {{ groupByFieldName(sheet, view) }}
            </span>
          </li>
        </ul>
      </section>

      <!-- EXTENSION POINT (PM-gated, G-4 — design 20260611 §4): the sample-data
           preview renders here once PM/SME provides per-template sample
           records. S2 deliberately renders NO sample data. -->

      <section class="multitable-template-detail__dryrun">
        <button
          type="button"
          class="multitable-template-detail__check"
          data-testid="template-detail-dryrun"
          :disabled="checking"
          @click="runDryRun"
        >
          {{ checking ? workbenchLabel('detail.checking', isZh) : workbenchLabel('detail.checkInstallable', isZh) }}
        </button>
        <p v-if="dryRunError" class="multitable-template-detail__error" role="alert">
          {{ dryRunError }}
        </p>
        <div
          v-if="dryRun"
          class="multitable-template-detail__dryrun-result"
          data-testid="template-detail-dryrun-result"
        >
          <p
            class="multitable-template-detail__verdict"
            :class="dryRun.installable
              ? 'multitable-template-detail__verdict--ok'
              : 'multitable-template-detail__verdict--blocked'"
            role="status"
          >
            {{ dryRun.installable
              ? workbenchLabel('detail.installableYes', isZh)
              : workbenchLabel('detail.installableNo', isZh) }}
          </p>
          <p class="multitable-template-detail__would-create">
            {{ workbenchLabel('detail.wouldCreateTitle', isZh) }}: {{ dryRun.wouldCreate.base.name }} —
            {{ cardSheets(dryRun.wouldCreate.sheets.length, isZh) }} ·
            {{ cardFields(dryRun.wouldCreate.fields.length, isZh) }} ·
            {{ cardViews(dryRun.wouldCreate.views.length, isZh) }}
          </p>
          <template v-if="dryRun.conflicts.length">
            <h3>{{ workbenchLabel('detail.conflictsTitle', isZh) }}</h3>
            <ul class="multitable-template-detail__conflicts" data-testid="template-detail-conflicts">
              <li v-for="conflict in dryRun.conflicts" :key="`${conflict.kind}:${conflict.id}`">
                <strong>{{ templateConflictKindLabel(conflict.kind, isZh) }}</strong>
                <span>{{ conflict.message }}</span>
              </li>
            </ul>
          </template>
          <p
            v-if="!dryRun.installable"
            class="multitable-template-detail__hint"
            data-testid="template-detail-conflict-hint"
          >
            {{ workbenchLabel('detail.conflictHint', isZh) }}
          </p>
        </div>
      </section>

      <footer class="multitable-template-detail__footer">
        <p v-if="installError" class="multitable-template-detail__warning" role="status">
          {{ installError }}
        </p>
        <button
          type="button"
          class="multitable-template-detail__install"
          data-testid="template-detail-install"
          :disabled="installDisabled"
          @click="onInstall"
        >
          {{ installing ? workbenchLabel('card.installing', isZh) : workbenchLabel('card.install', isZh) }}
        </button>
      </footer>
    </template>
  </section>
</template>

<script setup lang="ts">
// S2 template detail (design 20260611 §2.2): descriptor structure + dry-run
// installability check + the existing install flow (useTemplateInstall).
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { multitableClient } from '../multitable/api/client'
import { useTemplateInstall } from '../multitable/composables/useTemplateInstall'
import { useLocale } from '../composables/useLocale'
import { categoryLabel } from '../multitable/utils/category-labels'
import {
  cardFields,
  cardSheets,
  cardViews,
  templateConflictKindLabel,
  workbenchLabel,
} from '../multitable/utils/workbench-labels'
import type {
  MetaTemplate,
  MetaTemplateSheet,
  MetaTemplateView,
  TemplateDryRunResult,
} from '../multitable/types'
import { AppRouteNames } from '../router/types'

const TemplatesRouteName = AppRouteNames.MULTITABLE_TEMPLATES

const route = useRoute()
const { isZh } = useLocale()

const template = ref<MetaTemplate | null>(null)
const loading = ref(false)
const errorMessage = ref('')

const dryRun = ref<TemplateDryRunResult | null>(null)
const checking = ref(false)
const dryRunError = ref('')

const { installingTemplateId, errorMessage: installError, installAndOpen } = useTemplateInstall()

const templateId = computed(() => String(route.params.templateId ?? '').trim())
const installing = computed(() => installingTemplateId.value === template.value?.id)
// Conflicts block install (design §2.2); no dry-run yet keeps the existing
// optimistic install path (the server still 409s as the hard backstop).
const installDisabled = computed(
  () => installing.value || (dryRun.value !== null && !dryRun.value.installable),
)

const categoryDisplay = computed(() => {
  if (!template.value) return ''
  return categoryLabel(template.value.category, isZh.value ? 'zh-CN' : 'en')
})

const fieldCount = computed(
  () => template.value?.sheets.reduce((sum, sheet) => sum + sheet.fields.length, 0) ?? 0,
)

const viewCount = computed(
  () => template.value?.sheets.reduce((sum, sheet) => sum + sheet.views.length, 0) ?? 0,
)

// Mirrors the default baseName useTemplateInstall sends on install, so the
// dry-run answers the question for the install the button would actually run.
function defaultBaseName(tpl: MetaTemplate): string {
  return `${tpl.name} Base`
}

function groupByFieldName(sheet: MetaTemplateSheet, view: MetaTemplateView): string {
  if (!view.groupByFieldId) return ''
  return sheet.fields.find((field) => field.id === view.groupByFieldId)?.name ?? view.groupByFieldId
}

async function loadTemplate(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    const data = await multitableClient.listTemplates()
    template.value = (data.templates ?? []).find((tpl) => tpl.id === templateId.value) ?? null
  } catch (error) {
    errorMessage.value = error instanceof Error
      ? error.message
      : workbenchLabel('tpl.errorLoad', isZh.value)
  } finally {
    loading.value = false
  }
}

async function runDryRun(): Promise<void> {
  if (!template.value || checking.value) return
  checking.value = true
  dryRunError.value = ''
  try {
    dryRun.value = await multitableClient.dryRunTemplate(template.value.id, {
      baseName: defaultBaseName(template.value),
    })
  } catch (error) {
    dryRun.value = null
    dryRunError.value = error instanceof Error
      ? error.message
      : workbenchLabel('detail.dryRunFailed', isZh.value)
  } finally {
    checking.value = false
  }
}

async function onInstall(): Promise<void> {
  if (!template.value) return
  await installAndOpen(template.value)
}

onMounted(() => {
  void loadTemplate()
})
</script>

<style scoped>
.multitable-template-detail {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  padding: 1.5rem;
  max-width: 880px;
  margin: 0 auto;
}

.multitable-template-detail__back {
  font-size: 0.875rem;
  color: #2563eb;
  text-decoration: none;
}

.multitable-template-detail__back:hover {
  text-decoration: underline;
}

.multitable-template-detail__state {
  padding: 2rem;
  text-align: center;
  color: #64748b;
  font-size: 0.875rem;
  background: #f8fafc;
  border-radius: 8px;
}

.multitable-template-detail__error {
  margin: 0;
  padding: 0.75rem 1rem;
  border: 1px solid #fca5a5;
  background: #fef2f2;
  color: #b91c1c;
  border-radius: 8px;
}

.multitable-template-detail__hero {
  display: flex;
  gap: 1rem;
  align-items: flex-start;
}

.multitable-template-detail__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 3rem;
  height: 3rem;
  border-radius: 10px;
  color: #ffffff;
  font-weight: 600;
  font-size: 1.125rem;
  flex: 0 0 auto;
}

.multitable-template-detail__heading h1 {
  margin: 0;
  font-size: 1.375rem;
  color: #0f172a;
}

.multitable-template-detail__description {
  margin: 0.25rem 0;
  font-size: 0.875rem;
  color: #475569;
}

.multitable-template-detail__meta {
  font-size: 0.75rem;
  color: #94a3b8;
}

.multitable-template-detail__sheet {
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 1rem 1.25rem;
}

.multitable-template-detail__sheet h2 {
  margin: 0;
  font-size: 1rem;
  color: #0f172a;
}

.multitable-template-detail__sheet h3 {
  margin: 1rem 0 0.5rem;
  font-size: 0.8125rem;
  color: #475569;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.multitable-template-detail__sheet-desc {
  margin: 0.25rem 0 0;
  font-size: 0.8125rem;
  color: #64748b;
}

.multitable-template-detail__fields {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}

.multitable-template-detail__fields th,
.multitable-template-detail__fields td {
  text-align: left;
  padding: 0.375rem 0.5rem;
  border-bottom: 1px solid #f1f5f9;
  color: #0f172a;
}

.multitable-template-detail__fields th {
  font-size: 0.75rem;
  color: #64748b;
}

.multitable-template-detail__views {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.multitable-template-detail__views li {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  font-size: 0.875rem;
  color: #0f172a;
}

.multitable-template-detail__views span {
  color: #64748b;
  font-size: 0.8125rem;
}

.multitable-template-detail__dryrun {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.multitable-template-detail__check {
  align-self: flex-start;
  border: 1px solid #cbd5e1;
  background: #ffffff;
  color: #0f172a;
  padding: 0.5rem 1rem;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
}

.multitable-template-detail__check:disabled {
  opacity: 0.6;
  cursor: progress;
}

.multitable-template-detail__dryrun-result {
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 0.875rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.multitable-template-detail__dryrun-result h3 {
  margin: 0;
  font-size: 0.8125rem;
  color: #475569;
}

.multitable-template-detail__verdict {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
}

.multitable-template-detail__verdict--ok {
  color: #15803d;
}

.multitable-template-detail__verdict--blocked {
  color: #b91c1c;
}

.multitable-template-detail__would-create {
  margin: 0;
  font-size: 0.8125rem;
  color: #475569;
}

.multitable-template-detail__conflicts {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.multitable-template-detail__conflicts li {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  font-size: 0.8125rem;
  color: #b91c1c;
}

.multitable-template-detail__conflicts span {
  color: #7f1d1d;
}

.multitable-template-detail__hint {
  margin: 0;
  font-size: 0.8125rem;
  color: #92400e;
}

.multitable-template-detail__footer {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.multitable-template-detail__warning {
  margin: 0;
  padding: 0.5rem 0.875rem;
  background: #fef3c7;
  border: 1px solid #f59e0b;
  color: #92400e;
  border-radius: 6px;
  font-size: 0.875rem;
}

.multitable-template-detail__install {
  align-self: flex-start;
  border: 1px solid #2563eb;
  background: #2563eb;
  color: #ffffff;
  border-radius: 8px;
  padding: 0.5rem 1.25rem;
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
}

.multitable-template-detail__install:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.multitable-template-detail__install:hover:not(:disabled) {
  background: #1d4ed8;
  border-color: #1d4ed8;
}
</style>
