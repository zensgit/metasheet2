<script setup lang="ts">
import { computed, ref, watch } from 'vue'

type Translate = (en: string, zh: string) => string

const props = defineProps<{
  tr: Translate
  activeSectionId?: string
}>()

const emit = defineEmits<{
  'select-section': [id: string]
}>()

interface GuideTopic {
  id: string
  labelEn: string
  labelZh: string
  sectionId?: string
  paragraphs: Array<[string, string]>
  figureTitle?: [string, string]
  figureRows?: Array<[string, string]>
}

const topics: GuideTopic[] = [
  {
    id: 'overview',
    labelEn: 'Overview',
    labelZh: '总览',
    paragraphs: [
      [
        'The management home lists task cards. A card that names a section opens that one section. The left rail does the same: one section is open at a time, and the bar above it is that section’s name.',
        '管理首页是任务卡片。点到某个区块名称，就只打开那一个区块。左侧目录同样一次只打开一个区块，上方标题就是该区块的名称。',
      ],
      [
        '“My requests” opens your own attendance requests. The list is scoped to the signed-in person, not an organization-wide queue waiting for your review. “Anomalies” opens the overview anomalies list.',
        '「我的申请」打开的是当前登录人自己的考勤申请，不是全组织待你审批的队列。「异常」打开总览里的异常列表。',
      ],
    ],
    figureTitle: ['Home → one section', '首页 → 一个区块'],
    figureRows: [
      ['Daily work', '日常运营'],
      ['People and groups', '人员与考勤组'],
      ['Policies', '规则策略'],
      ['Data and payroll', '数据与计薪'],
    ],
  },
  {
    id: 'settings',
    labelEn: 'Settings',
    labelZh: '设置',
    sectionId: 'attendance-admin-settings',
    paragraphs: [
      [
        'This page saves organization attendance settings, including auto-absence (on/off, run time, lookback days) and the holiday-hours options on the same form. Saving stores the values. It does not itself scan punches.',
        '本页保存组织的考勤设置，包括自动缺勤（开关、执行时间、回溯天数）以及同一张表上的节假日工时选项。保存只写入这些值，不会当场去扫打卡。',
      ],
      [
        'Makeup-punch policy and report-digest subscription are their own sections. A time control shows 上午/下午 in Chinese and still stores 24-hour HH:mm.',
        '补卡策略和统计通知订阅是各自的区块。中文界面的时间控件显示上午/下午，保存的仍是 24 小时制 HH:mm。',
      ],
    ],
  },
  {
    id: 'holidays',
    labelEn: 'Holidays',
    labelZh: '节假日',
    sectionId: 'attendance-admin-holidays',
    paragraphs: [
      [
        'The holiday list is the calendar of dates: whether a date is a day off or a working day. Holiday sync is a separate section. It pulls a published index and can overwrite existing rows when that option is on.',
        '节假日列表是日期日历：某一天休息还是上班。节假日同步是另一个区块，按已发布的索引拉取；打开覆盖时会改写已有日期。',
      ],
      [
        'Sync writes holiday rows. It does not change a shift’s timezone or retime punches.',
        '同步写入的是节假日记录。它不改班次时区，也不重算打卡时间。',
      ],
    ],
    figureTitle: ['Two pages', '两个页面'],
    figureRows: [
      ['Holiday dates', '节假日：改日期'],
      ['Holiday sync', '节假日同步：按索引拉取'],
    ],
  },
  {
    id: 'payroll',
    labelEn: 'Payroll',
    labelZh: '计薪',
    sectionId: 'attendance-admin-payroll-templates',
    paragraphs: [
      [
        'A template stores a window: start day, end day, and end-month offset (this month or next). If the offset is this month and the end day is earlier than the start day, the window is treated as next month. The anchor day picks the month: on or after the start day uses that month; earlier uses the previous month.',
        '模板保存窗口：起始日、结束日、结束月偏移（当月或次月）。偏移为当月且结束日早于起始日时，按次月计算。锚点在起始日当天或之后，用锚点所在月；更早则用上一个月。',
      ],
      [
        'Chinese timezone labels show a place name, such as UTC+08:00 · 台北. The saved value is the IANA id. It is shown on the cycle page as context. Start and end dates follow the anchor’s calendar day.',
        '中文时区显示地名，例如 UTC+08:00 · 台北。保存的是 IANA 标识。它出现在周期页的时区提示里。起止日期按锚点的日历日计算。',
      ],
      [
        '“Default” is the template batch generation uses when none is chosen. “Auto-generate” is stored on the template and does not create cycles when you save. Create cycle or Generate cycles writes the rows. Batch count is 1–36, each step one month later. A cycle with the same start and end in this org is skipped. Empty summary-field selection keeps the backend default columns; a selection is stored as summaryFieldCodes.',
        '「默认」是批量生成未指定模板时用的那一份。「自动生成」只随模板保存，保存模板不会写出周期。写出周期用「创建周期」或「生成周期」。批量数量 1–36，每条锚点再晚一个月。本组织已有相同起止日的周期会被跳过。汇总字段全不选时用后端默认列；有选择时写入 summaryFieldCodes。',
      ],
    ],
    figureTitle: ['Start 1, end 29, this month', '起始日 1、结束日 29、当月'],
    figureRows: [
      ['Anchor on/after day 1', '锚点在 1 日或之后 → 该月 1–29 日'],
      ['Anchor before start day', '锚点早于起始日 → 上月 1–29 日'],
    ],
  },
  {
    id: 'rules',
    labelEn: 'Rules',
    labelZh: '规则',
    sectionId: 'attendance-admin-default-rule',
    paragraphs: [
      [
        'Punch calculation uses the rotation’s shift, otherwise the person’s shift assignment, otherwise the default rule. A group timezone is stored policy and is not what retimes an existing shift.',
        '打卡计算依次用轮班上的班次、否则用个人排班上的班次、否则用默认规则。考勤组时区只作为组策略保存，不会因此重算已有班次的上下班时间。',
      ],
      [
        'A rule set can be attached to a group. The rule template library stores versions of those templates. Leave types, overtime rules, and approval flows are separate sections.',
        '规则集可以挂到考勤组上。规则模板库保存这些模板的版本。请假类型、加班规则、审批流是各自的区块。',
      ],
    ],
  },
  {
    id: 'groups',
    labelEn: 'Groups',
    labelZh: '考勤组',
    sectionId: 'attendance-admin-groups',
    paragraphs: [
      [
        'Save the group before adding people. Members are the attendance roster. Owners are a separate roster and are not counted as attendance people. Maintaining owners stays admin-only; an owner or sub-owner of the group can add or remove members.',
        '先保存考勤组，再添加人员。成员是考勤名单。负责人是另一份名单，不计入考勤人员。维护负责人仅限管理员；本组 owner 或 sub_owner 可以增删成员。',
      ],
      [
        'Group type locks after creation. The optional code is an identifier, not the name shown in the list.',
        '考勤组类型创建后锁定。编码是可选标识，列表上显示的是名称。',
      ],
    ],
  },
  {
    id: 'availability',
    labelEn: 'Availability',
    labelZh: '团队可用性',
    sectionId: 'attendance-admin-team-availability',
    paragraphs: [
      [
        'Read-only. Pick a group by name; the request still sends that group’s id. From and to are calendar dates (年-月-日 in Chinese). Both are required, from must be on or before to, and the span is at most 366 days. Members × days above 6000 is refused.',
        '只读。按考勤组名称选择；请求仍提交该组的 id。起、止是日历日（中文为年-月-日）。两者都必填，起不能晚于止，跨度最多 366 天。成员数 × 天数超过 6000 会被拒绝。',
      ],
      [
        'Each member-day is one state. An approved personal-leave overlay wins. Otherwise a pending-leave overlay is “pending”, shown as tentative. Otherwise a day with no schedule is unscheduled. A scheduled working day is “scheduled”; a scheduled non-working day is “rest”.',
        '每个成员的每一天只有一种状态。已批事假覆盖优先。否则待审批请假记为「待审批」，以暂定样式显示。再否则，这一天没有排班就是未排班。已排班且为工作日是「排班」；已排班但非工作日是「休息」。',
      ],
      [
        'Available (formal) = scheduled + pending. Pending is not deducted. Approved leave, rest, and unscheduled are excluded. A failed load, including 403 and 404, clears the previous table. 403 means you are not an admin and not an owner or sub-owner of that group. 404 means the group id does not exist; permission is checked first.',
        '可用（正式）= 排班 + 待审批。待审批不扣减。已批请假、休息、未排班不计入。加载失败（含 403、404）会清掉上一张表。403 表示你不是管理员，也不是该组 owner 或 sub_owner。404 表示组不存在；权限先于是否存在被检查。',
      ],
    ],
    figureTitle: ['Available (formal)', '可用（正式）'],
    figureRows: [
      ['Scheduled + pending', '排班 + 待审批'],
      ['Not deducted', '待审批不扣减'],
      ['Excluded', '已批请假 / 休息 / 未排班'],
    ],
  },
  {
    id: 'annual',
    labelEn: 'Annual leave',
    labelZh: '年假',
    sectionId: 'attendance-admin-annual-leave-policy',
    paragraphs: [
      [
        'Balance shows the person’s name next to the remaining minutes. Policy save turns the engine on or off. When it is on, a timezone is required. Chinese shows a place name; the stored value is the IANA id. That timezone sets lot expiry at 1 January 00:00 and the scheduler’s “today”. It does not change shift timezones.',
        '余额旁显示人员姓名和剩余分钟。策略页打开或关闭引擎。打开时必须有时区。中文显示地名，保存的是 IANA 标识。此时区决定额度在 1 月 1 日 00:00 到期，以及自动发放里的「今天」。它不改班次时区。',
      ],
      [
        'Carry-over off: a year-Y lot expires 1 January Y+1 00:00. Carry-over on: 1 January Y+2 00:00. Lots already granted keep the expiry from the run that created them. Monthly auto-run also needs the answering process to have ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED and ATTENDANCE_SCHEDULER_ENABLED set to the literal true.',
        '不结转：Y 年额度在 Y+1 年 1 月 1 日 00:00 失效。结转：Y+2 年 1 月 1 日 00:00。已发出的额度仍用当时那次发放记下的到期时间。每月自动跑还要应答进程把 ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED 和 ATTENDANCE_SCHEDULER_ENABLED 设成字面量 true。',
      ],
      [
        'On the operations page, while the engine is off, adjust, backfill, and accrual submits are blocked. A single-balance preview only reads balances. A positive adjustment creates a manual lot with no expiry; a negative one deducts active lots in FIFO order and rolls back if the balance is short. Expiry backfill only fills annual accrual lots that still have no expiry, using the original run’s snapshot. An accrual dry-run writes the run audit and per-person rows, and writes no balance lots. Commit is what creates the lots.',
        '年假操作页在引擎关闭时，调整、回填和发放的提交都会被拦住。单人余额预览只读取余额。正数调整新建一条无到期的手工额度；负数按先到期先扣，余额不够则整笔回滚。过期回填只补「发放产生、且还没有到期时间」的额度，用当时那次发放的快照，不用今天的策略。发放预演会记下运行和每人的结果，不写余额；提交才生成额度。',
      ],
    ],
    figureTitle: ['2026 lot expiry', '2026 年额度何时到期'],
    figureRows: [
      ['No carry-over', '不结转 → 2027-01-01 00:00'],
      ['Carry-over', '结转 → 2028-01-01 00:00'],
    ],
  },
  {
    id: 'fields',
    labelEn: 'Report fields',
    labelZh: '统计字段',
    sectionId: 'attendance-admin-report-fields',
    paragraphs: [
      [
        'Reload reads the current catalog and does not create the multitable sheet. Sync catalog ensures the sheet exists and seeds missing field rows, then reads them back. It does not push attendance period rows.',
        '重载字段只读取当前目录，不创建多维表。同步字段目录会确保目录存在、补写缺失的字段行，再读回来。它不推送考勤周期数据。',
      ],
      [
        'Filters hide rows in the list. Search matches name, code, description, and the formula text. A formula starts with =. Record scope reads {code} on that row. Summary scope wraps fields in SUM, AVERAGE, COUNT, or COUNTA, or uses summary aliases such as {total_minutes}. Formula fields cannot reference other formula fields in v1. NOW, TODAY, lookups, cross-table cell refs, and scripts are blocked. System formulas have no edit button. Preview on an existing custom formula does not write the catalog.',
        '筛选只隐藏列表里的行。搜索匹配名称、编码、说明和公式文本。公式以 = 开头。单记录用 {编码} 读这一行。周期汇总用 SUM、AVERAGE、COUNT、COUNTA 包住字段，或用 {total_minutes} 这类汇总别名。v1 不允许公式字段互相引用。NOW、TODAY、查找函数、跨表单元格引用和脚本被禁用。系统公式没有编辑按钮。已有自定义公式上的预览不写入目录。',
      ],
    ],
    figureTitle: ['Reload vs sync', '重载与同步'],
    figureRows: [
      ['Reload', '重载：只读目录'],
      ['Sync catalog', '同步：补齐缺失字段行'],
    ],
  },
  {
    id: 'import',
    labelEn: 'Import',
    labelZh: '导入',
    sectionId: 'attendance-admin-import',
    paragraphs: [
      [
        'Import reads a mapped file (the default profile is the DingTalk daily CSV) and writes attendance rows only after you commit. When ATTENDANCE_IMPORT_REQUIRE_TOKEN is the literal 1, commit requires a token that expires 10 minutes after it is issued. Import batches is the history of those runs, not a second import form.',
        '导入按映射读取文件（默认配置是钉钉日汇总 CSV），提交之后才写入考勤行。当 ATTENDANCE_IMPORT_REQUIRE_TOKEN 为字面量 1 时，提交需要一张签发后 10 分钟失效的令牌。导入批次是这些运行的历史，不是第二张导入表。',
      ],
    ],
    figureTitle: ['Write path', '写入路径'],
    figureRows: [
      ['Map the file', '映射文件'],
      ['Commit writes rows', '提交才写入'],
      ['Batches list past runs', '批次页只列历史'],
    ],
  },
]

const topicId = ref('overview')

function topicForSection(sectionId: string | undefined): string {
  if (!sectionId) return 'overview'
  const match = topics.find(topic => topic.sectionId === sectionId)
  if (match) return match.id
  if (sectionId === 'attendance-admin-holiday-sync') return 'holidays'
  if (sectionId === 'attendance-admin-payroll-cycles') return 'payroll'
  if (sectionId === 'attendance-admin-rule-sets' || sectionId === 'attendance-admin-rule-template-library') return 'rules'
  if (sectionId === 'attendance-admin-annual-leave-balance' || sectionId === 'attendance-admin-annual-leave-operations') return 'annual'
  if (sectionId === 'attendance-admin-import-batches') return 'import'
  return 'overview'
}

watch(() => props.activeSectionId, (sectionId) => {
  topicId.value = topicForSection(sectionId)
}, { immediate: true })

const active = computed(() => topics.find(topic => topic.id === topicId.value) ?? topics[0])

function openSection(): void {
  const sectionId = active.value.sectionId
  if (sectionId) emit('select-section', sectionId)
}
</script>

<template>
  <details class="admin-guide" data-attendance-admin-guide>
    <summary>{{ tr('Attendance help', '考勤帮助') }}</summary>
    <div class="admin-guide__panel">
      <div class="admin-guide__topics" role="tablist" :aria-label="tr('Help topics', '帮助主题')">
        <button
          v-for="topic in topics"
          :key="topic.id"
          type="button"
          role="tab"
          class="admin-guide__topic"
          :class="{ 'admin-guide__topic--active': topic.id === active.id }"
          :aria-selected="topic.id === active.id"
          :data-attendance-guide-topic="topic.id"
          @click="topicId = topic.id"
        >
          {{ tr(topic.labelEn, topic.labelZh) }}
        </button>
      </div>
      <article class="admin-guide__article" :data-attendance-guide-article="active.id">
        <h5>{{ tr(active.labelEn, active.labelZh) }}</h5>
        <p v-for="(paragraph, index) in active.paragraphs" :key="index">
          {{ tr(paragraph[0], paragraph[1]) }}
        </p>
        <figure v-if="active.figureRows" class="admin-guide__figure">
          <figcaption>{{ tr(active.figureTitle![0], active.figureTitle![1]) }}</figcaption>
          <ol>
            <li v-for="(row, index) in active.figureRows" :key="index">{{ tr(row[0], row[1]) }}</li>
          </ol>
        </figure>
        <button
          v-if="active.sectionId"
          class="admin-guide__open"
          type="button"
          data-attendance-guide-open
          @click="openSection"
        >
          {{ tr('Open this section', '打开该区块') }}
        </button>
      </article>
    </div>
  </details>
</template>

<style scoped>
.admin-guide {
  margin-left: auto;
  font-size: 13px;
  color: var(--ms-text-2, #667085);
}

.admin-guide summary {
  cursor: pointer;
  color: var(--ms-color-primary, #2563eb);
  font-weight: 600;
}

.admin-guide__panel {
  display: grid;
  grid-template-columns: 148px minmax(0, 1fr);
  gap: 12px;
  margin-top: 8px;
  padding: 12px;
  border: 1px solid var(--ms-border-light, #eaecf0);
  border-radius: 8px;
  background: var(--ms-bg-page, #f8fafc);
  color: var(--ms-text-1, #1f2329);
}

.admin-guide__topics {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.admin-guide__topic {
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #475569;
  text-align: left;
  cursor: pointer;
}

.admin-guide__topic--active {
  background: #dbeafe;
  color: #1e3a8a;
  font-weight: 600;
}

.admin-guide__article h5 {
  margin: 0 0 8px;
}

.admin-guide__article p {
  margin: 0 0 8px;
}

.admin-guide__figure {
  margin: 0 0 8px;
}

.admin-guide__figure ol {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}

.admin-guide__figure li {
  padding: 6px 8px;
  border-radius: 6px;
  background: #fff;
  border-left: 3px solid #1d4ed8;
}

.admin-guide__open {
  padding: 4px 10px;
  border: 1px solid #1d4ed8;
  border-radius: 6px;
  background: #fff;
  color: #1d4ed8;
  cursor: pointer;
}

@media (max-width: 720px) {
  .admin-guide__panel {
    grid-template-columns: 1fr;
  }

  .admin-guide__topics {
    flex-direction: row;
    flex-wrap: wrap;
  }
}
</style>
