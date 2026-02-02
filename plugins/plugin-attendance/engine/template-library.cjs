const DEFAULT_TEMPLATES = [
  {
    name: 'Default (No Overrides)',
    description: 'Baseline template with no rule overrides.',
    category: 'system',
    editable: false,
    rules: [],
  },
  {
    name: 'Example: Driver Rest Overtime',
    description: 'Marks rest-day punches for drivers as overtime.',
    category: 'system',
    editable: false,
    rules: [
      {
        name: 'driver-rest-overtime',
        when: {
          all: [
            { field: 'profile.role', op: 'contains', value: 'driver' },
            { field: 'record.shift', op: 'contains', value: 'Rest' },
            { field: 'record.clockIn1', op: 'exists' },
          ],
        },
        then: {
          set: { overtime_hours: 8 },
          warn: 'Driver rest-day punch counted as overtime',
        },
      },
    ],
  },
]

module.exports = {
  DEFAULT_TEMPLATES,
}
