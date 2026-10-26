import {
  computed, defineComponent, h, onScopeDispose, shallowRef, watch, type PropType,
} from 'vue'
import { useFeatureFlags } from '../../stores/featureFlags'
import { useLocale } from '../../composables/useLocale'
import { useAttendanceSessionGuard } from '../../composables/useAttendanceSessionGuard'
import AttendanceGroupEffectivePolicyPanel from './AttendanceGroupEffectivePolicyPanel.vue'
import {
  navigateAttendanceGroupPolicyWorkspace,
  type AttendanceGroupPolicyWorkspaceNavigation,
  type AttendanceGroupPolicyWorkspaceSource,
} from './attendanceGroupPolicyWorkspaceBridge'
import type { AttendanceGroupRouteStep, AttendanceGroupRouteSurface } from '../../router/attendanceGroupContextRoute'
import type { AttendanceGroupEffectivePolicyStageActionV1 } from './attendanceGroupEffectivePolicyLabels'

// This source belongs to a selection/session, never to a replaceable catalog row or mutable draft.
export function useAttendanceGroupPolicyWorkspace(options: {
  groupId: () => string
  orgId: () => string
  canonical: () => boolean
  stale: () => boolean
  isCurrent: () => boolean
  openRoute: (step: AttendanceGroupRouteStep, surface: AttendanceGroupRouteSurface | null) => void
  openStage: (target: AttendanceGroupEffectivePolicyStageActionV1) => void
}) {
  const { hasFeature } = useFeatureFlags()
  const enabled = computed(() => hasFeature('attendanceGroupEffectivePolicyPanel'))
  const source = shallowRef<AttendanceGroupPolicyWorkspaceSource | null>(null)
  let revision = 0
  let active = true
  onScopeDispose(() => { active = false })
  watch(
    [options.groupId, options.orgId, options.canonical, options.stale, enabled] as const,
    ([groupId, orgId, canonical, stale, on]) => {
      revision += 1
      source.value = on && !canonical && !stale && groupId && orgId
        ? Object.freeze({ groupId, orgId, revision })
        : null
    },
    { immediate: true, flush: 'sync' },
  )
  function navigate(target: AttendanceGroupPolicyWorkspaceNavigation, origin: AttendanceGroupPolicyWorkspaceSource) {
    navigateAttendanceGroupPolicyWorkspace(
      target, origin, source.value,
      active && enabled.value && !options.canonical() && options.isCurrent(),
      options.openRoute, options.openStage,
    )
  }
  return { enabled, source, navigate }
}

interface ToolAction { key: string; label: string }

export default defineComponent({
  name: 'AttendanceGroupPolicyWorkspace',
  inheritAttrs: false,
  props: {
    enabled: { type: Boolean, required: true },
    visible: { type: Boolean, required: true },
    canonical: { type: Boolean, required: true },
    source: { type: Object as PropType<AttendanceGroupPolicyWorkspaceSource | null>, default: null },
    returnTo: { type: String, required: true },
  },
  emits: {
    navigate: (_target: AttendanceGroupPolicyWorkspaceNavigation, _source: AttendanceGroupPolicyWorkspaceSource) => true,
    tool: (_action: ToolAction) => true,
  },
  setup(props, { slots, emit }) {
    const { isZh } = useLocale()
    const sessionGuard = useAttendanceSessionGuard()
    let active = true
    onScopeDispose(() => { active = false })
    const tr = (en: string, zh: string) => isZh.value ? zh : en
    return () => {
      // One legacy element VNode: no wrapper, Fragment, comment, directive or new scope ID.
      if (!props.enabled) return slots.legacy!()[0]
      const source = props.source
      return h('section', {
        id: 'attendance-group-stage-policies',
        'data-attendance-group-policy-workspace': '',
        style: props.visible ? undefined : { display: 'none' },
      }, [
        !props.canonical
          ? source
            ? h(AttendanceGroupEffectivePolicyPanel, {
                key: JSON.stringify([source.groupId, source.orgId, source.revision]),
                groupId: source.groupId,
                returnTo: props.returnTo,
                delegateNavigation: true,
                onNavigateEditor: (target: AttendanceGroupPolicyWorkspaceNavigation) => emit('navigate', target, source),
              })
            : h('p', { 'data-attendance-group-policy-save-first': '' },
                tr('Save the attendance group before viewing effective policy.', '请先保存考勤组，再查看有效策略。'))
          : null,
        h('h3', tr('Tool entry points', '工具入口')),
        h('p', tr(
          'Configuration tools open their existing editors. Effective policy comes from the group effective-policy panel.',
          '配置工具进入原有编辑器。有效策略以组有效策略汇总为准。',
        )),
        // AV owns the slot's styled descendants; no copied scope ID or global CSS.
        slots.tools?.({
          openTool: (action: ToolAction) => {
            if (active && sessionGuard.isCurrent() && props.source === source) emit('tool', action)
          },
        }),
      ])
    }
  },
})
