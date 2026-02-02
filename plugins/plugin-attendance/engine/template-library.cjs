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
  {
    name: 'Security Default Hours (CN)',
    description: 'Default 8 hours for security roles.',
    category: 'system',
    editable: false,
    rules: [
      {
        name: 'security-default-8h',
        when: {
          any: [
            { field: 'profile.role', op: 'contains', value: '保安' },
            { field: 'record.attendance_group', op: 'contains', value: '保安' },
          ],
        },
        then: {
          set: { actual_hours: 8, required_hours: 8 },
          warn: 'Security default 8 hours applied',
        },
      },
    ],
  },
  {
    name: 'Security Holiday Overtime (CN)',
    description: 'Security holiday punches counted as overtime.',
    category: 'system',
    editable: false,
    rules: [
      {
        name: 'security-holiday-overtime',
        when: {
          all: [
            { field: 'record.is_holiday', op: 'eq', value: true },
            {
              any: [
                { field: 'profile.role', op: 'contains', value: '保安' },
                { field: 'record.attendance_group', op: 'contains', value: '保安' },
              ],
            },
            { field: 'record.clockIn1', op: 'exists' },
          ],
        },
        then: {
          set: { overtime_hours: 8 },
          warn: 'Security holiday overtime applied',
        },
      },
    ],
  },
  {
    name: 'Driver Rest Overtime (CN)',
    description: 'Drivers punching on rest shifts count as overtime.',
    category: 'system',
    editable: false,
    rules: [
      {
        name: 'driver-rest-overtime-cn',
        when: {
          all: [
            { field: 'profile.role', op: 'contains', value: '司机' },
            { field: 'record.shift', op: 'contains', value: '休息' },
            { field: 'record.clockIn1', op: 'exists' },
          ],
        },
        then: {
          set: { overtime_hours: 8 },
          warn: '司机休息日打卡按加班',
        },
      },
    ],
  },
  {
    name: 'Driver Default Hours (CN)',
    description: 'Default 8 hours for driver roles on workdays.',
    category: 'system',
    editable: false,
    rules: [
      {
        name: 'driver-default-8h',
        when: {
          all: [
            { field: 'profile.role', op: 'contains', value: '司机' },
            { field: 'record.is_workday', op: 'eq', value: true },
          ],
        },
        then: {
          set: { actual_hours: 8, required_hours: 8 },
          warn: '司机默认8小时',
        },
      },
    ],
  },
  {
    name: 'Single Rest Trip Overtime (CN)',
    description: 'Single-rest group trips on rest days count as overtime.',
    category: 'system',
    editable: false,
    rules: [
      {
        name: 'single-rest-trip-overtime',
        when: {
          all: [
            { field: 'record.attendance_group', op: 'contains', value: '单休' },
            { field: 'record.shift', op: 'contains', value: '休息' },
            { field: 'approvals', op: 'contains', value: '出差' },
          ],
        },
        then: {
          set: { overtime_hours: 8 },
          warn: '单休休息日出差按加班',
        },
      },
    ],
  },
  {
    name: 'Special User Fixed Hours (Placeholder)',
    description: 'Example template for a specific userId (replace with real IDs).',
    category: 'system',
    editable: false,
    rules: [
      {
        name: 'special-user-fixed-hours',
        when: { userIds: ['__USER_ID__'] },
        then: {
          set: { actual_hours: 10, required_hours: 10 },
          warn: '特殊人员默认10小时（请替换 userId）',
        },
      },
    ],
  },
]

module.exports = {
  DEFAULT_TEMPLATES,
}
