<!--
  Shared session-org switcher — copied and generalized from
  `views/attendance/AttendanceSessionOrgSwitcher.vue` (design lock v2.13 §2 "多 org 成员", 第 8 轮
  P3-b): that file stays untouched (moving/editing it narrows `attendance-web-guard.yml:297-301,
  :397-400`'s closed-world session-spec census). This copy pairs with the SAME `useSessionOrg`
  composable (also untouched) but takes every piece of display copy through the `copy` prop instead
  of the attendance-specific inline literals (the original's default hint mentions "punch history",
  which makes no sense outside attendance) — callers that want the exact attendance wording still
  get it by passing the matching `copy` entries; callers that pass nothing get generic wording.
  It only remints the session claim (`useSessionOrg.switchSessionOrg`) — it never writes any
  domain-specific org-id filter/input itself.
-->
<template>
  <section
    v-if="loading || orgs.length > 0 || errorMessage"
    class="session-org-switcher"
    data-testid="session-org-switcher"
  >
    <label class="session-org-switcher__field" for="session-org-switcher-select">
      <span>{{ tr(...resolvedCopy.label) }}</span>
      <select
        id="session-org-switcher-select"
        name="sessionOrgId"
        :value="modelValue"
        :disabled="disabled || loading || switching || orgs.length === 0"
        @change="onChange"
      >
        <option v-if="!modelValue" value="">
          {{ tr(...resolvedCopy.placeholder) }}
        </option>
        <option v-for="org in orgs" :key="org" :value="org">
          {{ org }}
        </option>
      </select>
    </label>
    <small v-if="hintText" class="session-org-switcher__hint">{{ hintText }}</small>
    <small
      v-if="errorMessage"
      class="session-org-switcher__hint session-org-switcher__hint--error"
    >
      {{ errorMessage }}
    </small>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'

/** Every bilingual string this component can show, as `[en, zh]` tuples for `tr(en, zh)`. */
export interface SessionOrgSwitcherCopy {
  label: [string, string]
  placeholder: [string, string]
  loadingHint: [string, string]
  emptyHint: [string, string]
  chooseHint: [string, string]
  defaultHint: [string, string]
}

const DEFAULT_COPY: SessionOrgSwitcherCopy = {
  label: ['Organization', '组织'],
  placeholder: ['Select organization', '选择组织'],
  loadingHint: ['Loading organizations…', '正在加载组织…'],
  emptyHint: ['No organization memberships.', '没有组织成员资格。'],
  chooseHint: [
    'Choose an organization. The session will not invent one.',
    '请选择组织。会话不会自动指定。',
  ],
  defaultHint: ['Session organization.', '会话组织。'],
}

const props = defineProps<{
  tr: (en: string, zh: string) => string
  orgs: string[]
  modelValue: string
  loading?: boolean
  switching?: boolean
  disabled?: boolean
  errorMessage?: string
  hasUsableClaim?: boolean
  /** Overrides for any subset of `DEFAULT_COPY` — unspecified keys keep the generic default. */
  copy?: Partial<SessionOrgSwitcherCopy>
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  change: [value: string]
}>()

const resolvedCopy = computed<SessionOrgSwitcherCopy>(() => ({ ...DEFAULT_COPY, ...props.copy }))

const hintText = computed(() => {
  if (props.loading) return props.tr(...resolvedCopy.value.loadingHint)
  if (props.orgs.length === 0) return props.tr(...resolvedCopy.value.emptyHint)
  if (props.orgs.length > 1 && !props.hasUsableClaim && !props.modelValue) {
    return props.tr(...resolvedCopy.value.chooseHint)
  }
  return props.tr(...resolvedCopy.value.defaultHint)
})

function onChange(event: Event): void {
  const value = (event.target as HTMLSelectElement | null)?.value?.trim() ?? ''
  if (!value) return
  emit('update:modelValue', value)
  emit('change', value)
}
</script>

<script lang="ts">
export default {
  name: 'SessionOrgSwitcher',
}
</script>

<style scoped>
.session-org-switcher {
  display: grid;
  gap: 4px;
  min-width: 220px;
}

.session-org-switcher__field {
  display: grid;
  gap: 4px;
  font-size: 13px;
  color: #3d4f5f;
}

.session-org-switcher__field select {
  min-height: 32px;
  padding: 4px 8px;
  border: 1px solid #d7dde7;
  border-radius: 8px;
  background: #fff;
  color: #12263a;
}

.session-org-switcher__hint {
  color: #66788a;
  font-size: 12px;
}

.session-org-switcher__hint--error {
  color: #b42318;
}
</style>
