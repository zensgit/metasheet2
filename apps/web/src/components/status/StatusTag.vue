<template>
  <span
    class="ms-status-tag"
    :class="`ms-status-tag--${size}`"
    :data-domain="domain"
    :data-status="status"
    :data-tone="display.tone"
    :style="tagStyle"
  >{{ display.label }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { resolveStatusDisplay, type StatusDomain, type StatusTone } from '../../utils/statusDomains'

// UF-3 — the ONE status-color renderer (design-lock §3.4 "状态 = 语义"). Framework-free by
// design (no Element Plus import) so it drops into both EP table cells (ApprovalCenterView,
// MyDelegationView, DelegationSettingsView) and hand-rolled markup (ApprovalMobileList,
// AutomationExecutionsView, ApprovalInboxView) alike. Colors come ONLY from CSS custom
// properties (tokens.css / the EP variable mapping UF-1 wrote) — never a hardcoded hex — so a
// future palette change repaints every status tag site-wide from one place.
const props = withDefaults(
  defineProps<{
    domain: StatusDomain
    status: string
    size?: 'sm' | 'md'
    // UF-7b: escape hatch for the handful of admin views whose OTHER chrome is
    // hardcoded-Chinese (never localized) — a StatusTag that follows the global useLocale()
    // toggle would show an English badge inside an otherwise-monolingual-Chinese page under
    // locale=en. Setting this pins the resolved label/tone to the given locale regardless of
    // useLocale(); leaving it unset (the default) keeps following useLocale() exactly as
    // before — bilingual views (ApprovalCenterView/ApprovalInboxView/AutomationExecutionsView/
    // ApprovalMobileList/WorkflowHubView) must NOT set this.
    forceLocale?: 'zh' | 'en'
  }>(),
  {
    size: 'md',
  },
)

const { isZh } = useLocale()

const effectiveIsZh = computed(() => (props.forceLocale ? props.forceLocale === 'zh' : isZh.value))

const display = computed(() => resolveStatusDisplay(props.domain, props.status, effectiveIsZh.value))

function toneColors(tone: StatusTone): { background: string; color: string } {
  if (tone === 'neutral') {
    return { background: 'var(--ms-bg-page)', color: 'var(--ms-text-2)' }
  }
  return {
    background: `var(--el-color-${tone}-light-9)`,
    color: `var(--el-color-${tone})`,
  }
}

const tagStyle = computed(() => {
  const { background, color } = toneColors(display.value.tone)
  const paddingInline = props.size === 'sm' ? 'var(--ms-space-2)' : 'var(--ms-space-3)'
  return {
    background,
    color,
    borderRadius: 'var(--ms-radius-sm)',
    paddingTop: 'var(--ms-space-1)',
    paddingBottom: 'var(--ms-space-1)',
    paddingLeft: paddingInline,
    paddingRight: paddingInline,
  }
})
</script>

<style scoped>
.ms-status-tag {
  display: inline-flex;
  align-items: center;
  line-height: 1.4;
  font-weight: 500;
  white-space: nowrap;
}

.ms-status-tag--md {
  font-size: 12px;
}

.ms-status-tag--sm {
  font-size: 11px;
}
</style>
