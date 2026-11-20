import { defineComponent, h } from 'vue'
import { useAttendanceAnnualBalance } from '../../src/views/attendance/useAttendanceAnnualBalance'

// A mounted scope host keeps composable lifecycle assertions on a real component.
export function personnelAnnualScopeHost(
  options: Parameters<typeof useAttendanceAnnualBalance>[0],
  ready: (annual: ReturnType<typeof useAttendanceAnnualBalance>) => void,
) {
  return defineComponent({ setup() {
    const annual = useAttendanceAnnualBalance(options)
    ready(annual)
    return () => h('div', annual.subjectLabel.value)
  } })
}
