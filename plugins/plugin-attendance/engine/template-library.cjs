const SYSTEM_TEMPLATES = [
  {
    name: '单休车间规则',
    category: 'system',
    editable: false,
    params: [
      { key: 'groupName', label: 'Attendance group', type: 'string', default: '单休车间', paths: ['scope.attendance_group[0]'] },
      { key: 'restTripOvertimeHours', label: 'Rest day trip overtime (hours)', type: 'number', default: 8, paths: ['rules[0].then.overtime_hours'] },
      { key: 'lateWarningAfter', label: 'Late checkout warning after', type: 'string', default: '19:00', paths: ['rules[1].when.clockOut2_after'] },
    ],
    scope: { attendance_group: ['单休车间'] },
    rules: [
      {
        id: 'rest_trip_default_overtime',
        when: { shift: '休息', approval_contains: '出差' },
        then: { overtime_hours: 8, reason: '单休车间休息日出差默认8小时' },
      },
      {
        id: 'after7_no_overtime_warning',
        when: { clockOut2_after: '19:00', overtime_hours_eq: 0 },
        then: { warning: '下班晚但无加班单' },
      },
      {
        id: 'rest_punch_no_overtime_warning',
        when: { exceptionReason_contains: '休息并打卡', overtime_hours_eq: 0 },
        then: { warning: '休息日打卡但无加班单' },
      },
      {
        id: 'rest_punch_missing_checkout_warning',
        when: {
          exceptionReason_contains: '休息并打卡',
          clockIn1_exists: true,
          clockOut1_exists: false,
        },
        then: { warning: '休息日打卡但缺少下班卡' },
      },
    ],
  },
  {
    name: '通用提醒',
    category: 'system',
    editable: false,
    params: [
      { key: 'tripMinHours', label: 'Trip minimum hours', type: 'number', default: 8, paths: ['rules[2].when.actual_hours_lt'] },
      { key: 'leaveMinHours', label: 'Leave minimum hours', type: 'number', default: 8, paths: ['rules[3].when.actual_hours_lt'] },
      { key: 'deptExemptions', label: 'Dept exemptions', type: 'stringArray', default: ['国内销售', '服务测试部-调试'], paths: ['rules[2].when.department_not_contains', 'rules[3].when.department_not_contains'] },
    ],
    rules: [
      {
        id: 'overtime_approval_no_punch_warning',
        when: { approval_contains: '加班', has_punch: false },
        then: { warning: '有加班单但未打卡' },
      },
      {
        id: 'trip_and_overtime_warning',
        when: { exceptionReason_contains: '出差', overtime_hours_gt: 0 },
        then: { warning: '出差同时存在加班工时，请核对' },
      },
      {
        id: 'trip_low_hours_warning',
        when: {
          exceptionReason_contains: '出差',
          shift_not_contains: '休息',
          actual_hours_lt: 8,
          department_not_contains: ['国内销售', '服务测试部-调试'],
        },
        then: { warning: '出差当天实际工时不足8小时，请核对' },
      },
      {
        id: 'leave_low_hours_warning',
        when: {
          exceptionReason_contains: ['事假', '病假', '工伤假'],
          shift_not_contains: '休息',
          actual_hours_lt: 8,
          department_not_contains: ['国内销售', '服务测试部-调试'],
        },
        then: { warning: '请假当天实际工时不足8小时，请核对' },
      },
      {
        id: 'leave_makeup_missing_punch_warning',
        when: { exceptionReason_contains: ['缺卡', '补卡'], clockIn2_exists: false },
        then: { warning: '缺卡且补卡，但未找到上班2打卡，请核对' },
      },
      {
        id: 'trip_and_leave_conflict_warning',
        when: { exceptionReason_contains: ['出差', '事假'] },
        then: { warning: '出差+事假请核对' },
      },
      {
        id: 'trip_and_sick_conflict_warning',
        when: { exceptionReason_contains: ['出差', '病假'] },
        then: { warning: '出差+病假请核对' },
      },
      {
        id: 'trip_and_injury_conflict_warning',
        when: { exceptionReason_contains: ['出差', '工伤假'] },
        then: { warning: '出差+工伤假请核对' },
      },
    ],
  },
  {
    name: '标准上下班提醒',
    category: 'system',
    editable: false,
    params: [
      { key: 'lateAfter', label: 'Late after (HH:MM)', type: 'string', default: '09:10', paths: ['rules[0].when.clockIn1_after'] },
      { key: 'earlyBefore', label: 'Leave before (HH:MM)', type: 'string', default: '17:50', paths: ['rules[1].when.clockOut1_before'] },
      { key: 'lateWarning', label: 'Late warning text', type: 'string', default: '迟到，请核对', paths: ['rules[0].then.warning'] },
      { key: 'earlyWarning', label: 'Early leave warning text', type: 'string', default: '早退，请核对', paths: ['rules[1].then.warning'] },
    ],
    rules: [
      {
        id: 'late_after_warning',
        when: { clockIn1_after: '09:10' },
        then: { warning: '迟到，请核对' },
      },
      {
        id: 'early_leave_warning',
        when: { clockOut1_before: '17:50' },
        then: { warning: '早退，请核对' },
      },
    ],
  },
  {
    name: '缺卡补卡核对',
    category: 'system',
    editable: false,
    rules: [
      {
        id: 'missing_checkout_warning',
        when: { clockIn1_exists: true, clockOut1_exists: false },
        then: { warning: '缺少下班卡' },
      },
      {
        id: 'missing_checkin_warning',
        when: { clockIn1_exists: false, clockOut1_exists: true },
        then: { warning: '缺少上班卡' },
      },
      {
        id: 'makeup_missing_second_in',
        when: { exceptionReason_contains_any: ['补卡', '缺卡'], clockIn2_exists: false },
        then: { warning: '缺卡/补卡但未找到上班2打卡' },
      },
    ],
  },
  {
    name: '休息日加班',
    category: 'system',
    editable: false,
    params: [
      { key: 'restOvertimeHours', label: 'Rest day overtime (hours)', type: 'number', default: 8, paths: ['rules[0].then.overtime_hours'] },
      { key: 'restReason', label: 'Reason text', type: 'string', default: '休息日打卡算加班', paths: ['rules[0].then.reason'] },
    ],
    rules: [
      {
        id: 'rest_day_punch_overtime',
        when: { shift_contains: '休息', has_punch: true },
        then: { overtime_hours: 8, reason: '休息日打卡算加班' },
      },
    ],
  },
  {
    name: '节假日首日基准工时',
    category: 'system',
    editable: false,
    params: [
      {
        key: 'holidayFirstDayHours',
        label: 'Holiday first-day hours',
        type: 'number',
        default: 8,
        paths: ['rules[0].then.actual_hours', 'rules[0].then.required_hours'],
      },
      {
        key: 'holidayFirstDayWarning',
        label: 'Warning text',
        type: 'string',
        default: '节假日首日按8小时',
        paths: ['rules[0].then.warning'],
      },
    ],
    rules: [
      {
        id: 'holiday-default-8h',
        when: {
          is_holiday: true,
          holiday_first_day: true,
          holiday_policy_enabled: false,
        },
        then: {
          actual_hours: 8,
          required_hours: 8,
          warning: '节假日首日按8小时',
        },
      },
    ],
  },
  {
    name: '角色规则',
    category: 'system',
    editable: false,
    params: [
      { key: 'securityBaseHours', label: 'Security base hours', type: 'number', default: 8, paths: ['rules[0].then.required_hours'] },
      { key: 'securityHolidayOvertime', label: 'Security holiday overtime (hours)', type: 'number', default: 8, paths: ['rules[1].then.overtime_hours'] },
      { key: 'driverRestOvertime', label: 'Driver rest overtime (hours)', type: 'number', default: 8, paths: ['rules[2].then.overtime_hours'] },
    ],
    scope: { role_tags: ['security', 'driver'] },
    rules: [
      {
        id: 'security_base_hours',
        when: { role: 'security' },
        then: { required_hours: 8 },
      },
      {
        id: 'security_holiday_overtime',
        when: { role: 'security', is_holiday: true, has_punch: true },
        then: { overtime_hours: 8, reason: '保安节假日算加班' },
      },
      {
        id: 'driver_rest_punch_overtime',
        when: { role: 'driver', shift: '休息', clockIn1_exists: true },
        then: { overtime_hours: 8, reason: '司机休息日打卡算加班' },
      },
    ],
  },
  {
    name: '部门提醒',
    category: 'system',
    editable: false,
    scope: { department: ['国内销售', '服务测试部-调试'] },
    rules: [
      {
        id: 'trip_and_leave_warning',
        when: { exceptionReason_contains: ['出差', '事假'] },
        then: { warning: '出差+事假请核对' },
      },
      {
        id: 'trip_and_sick_warning',
        when: { exceptionReason_contains: ['出差', '病假'] },
        then: { warning: '出差+病假请核对' },
      },
      {
        id: 'trip_and_injury_warning',
        when: { exceptionReason_contains: ['出差', '工伤假'] },
        then: { warning: '出差+工伤假请核对' },
      },
    ],
  },
  {
    name: '加班单核对',
    category: 'system',
    editable: false,
    params: [
      { key: 'lateCheckoutAfter', label: 'Late checkout after', type: 'string', default: '19:00', paths: ['rules[0].when.clockOut2_after'] },
      { key: 'lateCheckoutWarning', label: 'Warning text', type: 'string', default: '下班晚但无加班单', paths: ['rules[0].then.warning'] },
      { key: 'restPunchWarning', label: 'Rest punch warning', type: 'string', default: '休息日打卡但无加班单', paths: ['rules[2].then.warning'] },
    ],
    rules: [
      {
        id: 'late_checkout_without_overtime',
        when: { clockOut2_after: '19:00', overtime_hours_eq: 0 },
        then: { warning: '下班晚但无加班单' },
      },
      {
        id: 'overtime_without_punch',
        when: { overtime_hours_gt: 0, has_punch: false },
        then: { warning: '有加班单但未打卡' },
      },
      {
        id: 'rest_punch_without_overtime',
        when: { exceptionReason_contains: '休息并打卡', overtime_hours_eq: 0 },
        then: { warning: '休息日打卡但无加班单' },
      },
    ],
  },
]

const CUSTOM_TEMPLATES = [
  {
    name: '用户自定义',
    category: 'custom',
    editable: true,
    description: '为考勤管理员预留的自定义规则模板',
    rules: [],
  },
]

const DEFAULT_TEMPLATES = [...SYSTEM_TEMPLATES, ...CUSTOM_TEMPLATES]

module.exports = {
  SYSTEM_TEMPLATES,
  CUSTOM_TEMPLATES,
  DEFAULT_TEMPLATES,
}
