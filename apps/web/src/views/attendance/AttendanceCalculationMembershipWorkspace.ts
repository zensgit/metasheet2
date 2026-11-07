import { defineComponent, Fragment, h, type PropType } from 'vue'
import { useAttendanceCalculationCapability } from './useAttendanceCalculationCapability'
import AttendanceCalculationMembershipHistory from './AttendanceCalculationMembershipHistory.vue'

export default defineComponent({
  name: 'AttendanceCalculationMembershipWorkspace',
  inheritAttrs: false,
  props: {
    enabled: { type: Boolean, required: true },
    active: { type: Boolean, required: true },
    canRead: { type: Function as PropType<() => boolean>, required: true },
    orgId: { type: String, required: true },
    groupId: { type: String, required: true },
    groups: { type: Array as PropType<readonly { id: string; orgId?: string; name: string }[]>, required: true },
  },
  setup(props, { slots }) {
    const capabilityEpoch = useAttendanceCalculationCapability(() => props.canRead())
    return () => {
      const epoch = capabilityEpoch.value
      const legacy = slots.legacy!()[0]
      // OFF is the original element VNode, with no new wrapper, Fragment, comment or scope ID.
      if (!props.enabled || !props.active || props.canRead() !== true || !props.orgId || !props.groupId) return legacy
      return h(Fragment, [
        legacy,
        h(AttendanceCalculationMembershipHistory, {
          key: JSON.stringify([props.orgId, props.groupId, epoch]),
          enabled: props.enabled, active: props.active, canRead: props.canRead,
          orgId: props.orgId, groupId: props.groupId, groups: props.groups,
        }),
      ])
    }
  },
})
