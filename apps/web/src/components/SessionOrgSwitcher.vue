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
    <label class="session-org-switcher__field" :for="selectId">
      <span>{{ tr(...resolvedCopy.label) }}</span>
      <select
        :id="selectId"
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
import { computed, useId } from 'vue'

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

// P1-A (impl-gate-A5-daily-ops-round1-20260920.md) — this used to be the CONSTANT DOM id
// `session-org-switcher-select` on both the `<select>` and its `<label for=...>`. That was already
// registered as a known-but-inert difference from the attendance original in
// `approval-template-groups-phase1-fe-verification-20260918.md` P3-6 ("today only one host exists;
// two instances on one page would be needed to collide"), and the daily-ops round made exactly that
// condition real: a real browser measured `duplicate#ids=2` on the first grouped hop, where
// `<label for>` binds to the FIRST match only, so the second control's label was silently detached.
// `useId()` (Vue 3.5) gives every instance its own id, so the pairing is per-instance by
// construction rather than by "there happens to be only one host".
const selectId = useId()

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
import type { InjectionKey } from 'vue'
import type { useSessionOrg } from '../composables/useSessionOrg'

/**
 * P1-A (impl-gate-A5-daily-ops-round1-20260920.md) — the page-level owner of the ONE
 * `useSessionOrg()` instance backing every session-org surface on a page.
 *
 * Why this exists at all: `useSessionOrg`'s `onAuthPrincipalChange` callback clears `orgs` on
 * EVERY live instance, and only the instance that performed the switch restores itself
 * (`switchSessionOrg` captures `memberships` before `setExplicitSessionOrg` and re-assigns it
 * after). So two instances on one page is not a cosmetic duplication — switching through one
 * permanently empties the other. `useSessionOrg.ts` itself is not editable here (design lock
 * v2.13 §2: "考勤原文件与 `useSessionOrg.ts` 不动"), which makes "one instance per page" the only
 * available fix rather than a preference.
 *
 * Contract: a host component creates the single instance, renders the single switcher, owns the
 * one `loadSessionOrgs()` call and owns replaying whatever its children were blocked on. A child
 * that hits 403 `SESSION_ORG_REQUIRED` reports it through `notifySessionOrgRequired()` and renders
 * NO switcher of its own. A child mounted with no host (its own spec, or any other page) injects
 * `null`, falls back to its own instance and keeps its pre-existing reactive behaviour verbatim —
 * which is what keeps acceptance J's "remove the front end's handling of that code ⇒ it stops at
 * 403" mutation load-bearing in those component-level specs.
 */
export interface SessionOrgHost {
  sessionOrg: ReturnType<typeof useSessionOrg>
  notifySessionOrgRequired: () => void
}

export const SessionOrgHostKey: InjectionKey<SessionOrgHost> = Symbol('sessionOrgHost')

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
