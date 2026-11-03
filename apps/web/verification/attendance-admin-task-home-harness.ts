// Browser harness for the admin task-home visual contract.
// Mounts the real AttendanceAdminTaskHome (layout only; no API).
import { createApp, h } from 'vue'
import '../src/styles/tokens.css'
import AttendanceAdminTaskHome from '../src/views/attendance/AttendanceAdminTaskHome.vue'

const tr = (en: string, zh: string) => zh || en

const groups = [
  {
    key: 'daily-operations',
    title: '日常工作',
    detail: '审批、异常、导入与审计跟进。',
    status: 'needs_attention',
    linkActions: [
      { key: 'pending-attendance-approvals', label: '待审批', href: '/attendance?section=attendance-overview-requests', primary: true },
      { key: 'attendance-anomalies', label: '异常', href: '/attendance?section=attendance-overview-anomalies' },
    ],
    buttonActions: [
      { key: 'daily-import', label: '导入', sectionId: 'attendance-admin-import' },
    ],
  },
  {
    key: 'people-groups',
    title: '人员与考勤组',
    detail: '考勤组、成员、负责人与可用性。',
    status: 'ok',
    linkActions: [],
    buttonActions: [
      { key: 'attendance-groups', label: '考勤组', sectionId: 'attendance-admin-groups', primary: true },
      { key: 'group-members', label: '成员', sectionId: 'attendance-admin-group-members' },
    ],
  },
  {
    key: 'work-time-policies',
    title: '工时与策略',
    detail: '班次、排班、节假日、规则与请假。',
    status: 'not_configured',
    linkActions: [],
    buttonActions: [
      { key: 'shifts', label: '班次', sectionId: 'attendance-admin-shifts', primary: true },
      { key: 'holidays', label: '节假日', sectionId: 'attendance-admin-holidays' },
    ],
  },
  {
    key: 'reporting-payroll',
    title: '报表与计薪',
    detail: '导入批次、统计字段、计薪模板与周期。',
    status: 'unknown',
    linkActions: [],
    buttonActions: [
      { key: 'import-batches', label: '导入批次', sectionId: 'attendance-admin-import-batches', primary: true },
      { key: 'payroll-cycles', label: '计薪周期', sectionId: 'attendance-admin-payroll-cycles' },
    ],
  },
]

createApp({
  setup() {
    return () => h('div', { class: 'harness-app' }, [
      h('main', { class: 'attendance' }, [
        h(AttendanceAdminTaskHome, {
          tr,
          groups,
          onSelectSection: () => undefined,
          onNavigate: () => undefined,
        }),
      ]),
    ])
  },
}).mount('#app')
