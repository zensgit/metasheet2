import { defineComponent, h } from 'vue'
import AttendanceUserPickerField from '../../src/views/attendance/AttendanceUserPickerField.vue'

export function personnelPickerHost(state: { id: string }, typeahead: boolean, remember: (name: string) => void) {
  return defineComponent({ render: () => h(AttendanceUserPickerField, {
    modelValue: state.id, label: 'Person', tr: (en: string) => en, typeahead,
    endpoint: '/api/attendance-admin/users/search', orgId: 'default',
    'onUpdate:modelValue': (id: string) => { state.id = id },
    'onUpdate:displayName': remember,
  }) })
}
