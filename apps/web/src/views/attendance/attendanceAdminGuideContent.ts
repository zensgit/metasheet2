export interface GuideStep {
  path: [string, string]
  detail: [string, string]
}

export interface GuideFaq {
  q: [string, string]
  a: [string, string]
}

export interface GuideTopic {
  id: string
  labelEn: string
  labelZh: string
  sectionId?: string
  intro: Array<[string, string]>
  scenarios: Array<[string, string]>
  steps: GuideStep[]
  faqs: GuideFaq[]
  callout?: [string, string]
  figureTitle?: [string, string]
  figureRows?: Array<[string, string]>
}

export interface GuideGroup {
  id: string
  labelEn: string
  labelZh: string
  topicIds: string[]
}

export const ATTENDANCE_GUIDE_SECTIONS = [
  { id: 'intro', labelEn: 'What it does', labelZh: '功能简介' },
  { id: 'scenarios', labelEn: 'When to use it', labelZh: '适用场景' },
  { id: 'steps', labelEn: 'How to configure', labelZh: '操作流程' },
  { id: 'faq', labelEn: 'FAQ', labelZh: '常见问题' },
] as const

export const attendanceGuideGroups: GuideGroup[] = [
  { id: 'manual', labelEn: 'Manual', labelZh: '考勤手册', topicIds: ['overview'] },
  { id: 'configure', labelEn: 'Setup', labelZh: '配置', topicIds: ['settings', 'holidays', 'rules', 'groups'] },
  { id: 'pay', labelEn: 'Payroll and leave', labelZh: '计薪与年假', topicIds: ['payroll', 'annual'] },
  { id: 'data', labelEn: 'Data', labelZh: '数据', topicIds: ['availability', 'fields', 'import', 'reports'] },
]

export const attendanceGuideTopics: GuideTopic[] = [
  {
    id: 'overview',
    labelEn: 'Overview',
    labelZh: '总览',
    intro: [[
      'The management home lists task cards. A card that names a section opens that one section. The left rail does the same: one section is open at a time, and the bar above it is that section’s name.',
      '管理首页是任务卡片。点到某个区块名称，就只打开那一个区块。左侧目录同样一次只打开一个区块，上方标题就是该区块的名称。',
    ]],
    scenarios: [[
      'Use the home when you know the job (today’s exceptions, a group, a payroll window) and you do not yet know which form holds it.',
      '知道要办的事（今天的异常、一个考勤组、一个计薪窗口），但还不确定落在哪张表上时，从首页进入。',
    ]],
    steps: [
      {
        path: ['Home → the card that names the section', '管理首页 → 写着区块名称的卡片'],
        detail: ['That opens only that section. The rail highlights the same one.', '只打开那一个区块。左侧目录同时标出它。'],
      },
    ],
    faqs: [{
      q: ['Does “My requests” show every request waiting for me?', '「我的申请」是全组织待我审批的队列吗？'],
      a: ['No. “My requests” opens your own attendance requests, scoped to the signed-in person. “Anomalies” opens the overview anomalies list.', '不是。「我的申请」打开的是当前登录人自己的考勤申请。「异常」打开总览里的异常列表。'],
    }],
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
    intro: [[
      'This page saves organization attendance settings, including auto-absence (on/off, run time, lookback days) and the holiday-hours options on the same form.',
      '本页保存组织的考勤设置，包括自动缺勤（开关、执行时间、回溯天数）以及同一张表上的节假日工时选项。',
    ]],
    scenarios: [[
      'Change it when the organization should start or stop marking absence on a schedule, or when holiday-hours options change. Do not use it to grant a makeup-punch quota or to subscribe managers to a digest; those are their own sections.',
      '组织要按计划开始或停止判缺勤，或要改节假日工时选项时，改这一页。补卡额度和统计通知订阅不在这张表上，它们是各自的区块。',
    ]],
    steps: [
      {
        path: ['Settings → Auto absence', '设置 → 自动缺勤'],
        detail: ['Set the switch, the run time, and the lookback days, then save. Saving stores the values. It does not itself scan punches. The run time is one 24-hour field, such as 09:00. A small read-only 上午 or 下午 hint follows the value. The stored time is still HH:mm.', '填写开关、执行时间和回溯天数后保存。保存只写入这些值，不会当场去扫打卡。执行时间是一个 24 小时字段，例如 09:00，旁边只读显示上午或下午。保存的仍是 HH:mm。'],
      },
      {
        path: ['Makeup punch policy → Policy timezone', '补卡策略 → 规则时区'],
        detail: ['The cycle is a calendar month; v1 does not offer another cycle. In the timezone field, type a city, an IANA id, or an offset such as +8, then pick a suggestion. The chosen zone stays in that same field. The saved value is an IANA id. An unknown zone is refused before save.', '周期只有自然月，v1 没有第二种。在时区框里输入城市、IANA 标识，或 +8 这类偏移，再点选一条建议。选中的时区就显示在这一个框里。保存的是 IANA 标识。无法识别的时区会在保存前被拦住。'],
      },
    ],
    callout: [
      'Saving settings does not send the report digest. The digest section stores timezone, channel, and send times; a message goes out only when that scheduled job actually runs.',
      '保存设置不会发出统计通知。统计通知订阅单独保存时区、渠道和发送时间；只有定时任务真正跑起来才会发。',
    ],
    faqs: [{
      q: ['I saved auto-absence. Why are today’s punches unchanged?', '我保存了自动缺勤，为什么今天的打卡没有变化？'],
      a: ['The form only stores the schedule. The scan runs later, at the configured time, looking back the configured number of days.', '这张表只保存计划。扫描在配置的时间才跑，并按回溯天数回看。'],
    }],
  },
  {
    id: 'holidays',
    labelEn: 'Holidays',
    labelZh: '节假日',
    sectionId: 'attendance-admin-holidays',
    intro: [[
      'The holiday list is the calendar of dates: whether a date is a day off or a working day. Holiday sync is a separate section. It pulls a published index and can overwrite existing rows when that option is on.',
      '节假日列表是日期日历：某一天休息还是上班。节假日同步是另一个区块，按已发布的索引拉取；打开覆盖时会改写已有日期。',
    ]],
    scenarios: [[
      'Edit the list when one date must differ from the published calendar. Run sync when you want the published index for a year. Use a day index (春节-1 is day 1) only when a group should rest fewer days than the statutory holiday.',
      '某一天必须和公布的日历不同时，改列表。要按已发布索引铺一整年时，跑同步。只有某个考勤组比法定假期少休几天时，才用序号（「春节-1」是第 1 天）。',
    ]],
    steps: [
      {
        path: ['Holidays → the date row', '节假日 → 日期行'],
        detail: ['Set that date to a rest day or a working day and save the list.', '把这一天标成休息或上班，然后保存列表。'],
      },
      {
        path: ['Holiday sync → Sync now', '节假日同步 → 立即同步'],
        detail: ['Choose years and whether to overwrite. Sync writes holiday rows. It does not change a shift’s timezone or retime punches.', '选择年份，以及是否覆盖。同步写入的是节假日记录。它不改班次时区，也不重算打卡时间。'],
      },
    ],
    callout: [
      'A partial-rest rule uses an inclusive day index. Start 4 and end 5 change only days 4 and 5 of the matched holiday into workdays. Leave the index empty to cover the whole holiday.',
      '少休规则用的是含首尾的序号。起始填 4、结束填 5，只把匹配节日的第 4 天和第 5 天改成工作日。序号留空则覆盖整段节日。',
    ],
    faqs: [{
      q: ['Will sync move yesterday’s punch times?', '同步会改昨天的打卡时间吗？'],
      a: ['No. Sync writes holiday rows only.', '不会。同步只写节假日记录。'],
    }],
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
    intro: [[
      'A template stores a window: start day, end day, and end-month offset (this month or next). If the offset is this month and the end day is earlier than the start day, the window is treated as next month. The anchor day picks the month: on or after the start day uses that month; earlier uses the previous month.',
      '模板保存窗口：起始日、结束日、结束月偏移（当月或次月）。偏移为当月且结束日早于起始日时，按次月计算。锚点在起始日当天或之后，用锚点所在月；更早则用上一个月。',
    ]],
    scenarios: [[
      'Create a template when the pay window is not a calendar month, for example the 26th through the 25th. Generate cycles when you want those windows written as rows. Saving the template does not write cycles.',
      '计薪窗口不是自然月时（例如 26 日到次月 25 日）建模板。要把这些窗口写成周期行时，再点生成。保存模板本身不会写出周期。',
    ]],
    steps: [
      {
        path: ['Payroll templates → Timezone, start day, end day', '计薪模板 → 时区、起始日、结束日'],
        detail: ['Chinese timezone labels show a place name, such as UTC+08:00 · 台北. The saved value is the IANA id. Start and end dates follow the anchor’s calendar day.', '中文时区显示地名，例如 UTC+08:00 · 台北。保存的是 IANA 标识。起止日期按锚点的日历日计算。'],
      },
      {
        path: ['Payroll cycles → Generate cycles', '计薪周期 → 生成周期'],
        detail: ['“Default” is the template batch generation uses when none is chosen. “Auto-generate” is stored on the template and does not create cycles when you save. Create cycle or Generate cycles writes the rows. Batch count is 1–36, each step one month later. A cycle with the same start and end in this org is skipped. Empty summary-field selection keeps the backend default columns; a selection is stored as summaryFieldCodes.', '「默认」是批量生成未指定模板时用的那一份。「自动生成」只随模板保存，保存模板不会写出周期。写出周期用「创建周期」或「生成周期」。批量数量 1–36，每条锚点再晚一个月。本组织已有相同起止日的周期会被跳过。汇总字段全不选时用后端默认列；有选择时写入 summaryFieldCodes。'],
      },
    ],
    faqs: [{
      q: ['I turned on auto-generate and saved. Where are the cycles?', '我打开了自动生成并保存，周期在哪里？'],
      a: ['Still unwritten. Auto-generate is only a flag on the template. Use Generate cycles to write rows.', '还没写出来。自动生成只是模板上的一个开关。写出周期要使用「生成周期」。'],
    }],
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
    intro: [[
      'Punch calculation uses the rotation’s shift, otherwise the person’s shift assignment, otherwise the default rule. A group timezone is stored policy and is not what retimes an existing shift.',
      '打卡计算依次用轮班上的班次、否则用个人排班上的班次、否则用默认规则。考勤组时区只作为组策略保存，不会因此重算已有班次的上下班时间。',
    ]],
    scenarios: [[
      'Set the default rule when someone has no shift yet and should still have a work window. Attach a rule set on the group when that group should not use the organization default. Leave types, overtime rules, and approval flows stay in their own sections.',
      '有人还没有班次、但仍要有上下班窗口时，配默认规则。某个考勤组不该用组织默认时，把规则集挂到组上。请假类型、加班规则、审批流仍在各自的区块。',
    ]],
    steps: [
      {
        path: ['Default rule → Timezone, work start, work end', '默认规则 → 时区、上班时间、下班时间'],
        detail: ['The timezone picker accepts a city, an IANA id, or an offset such as +8. Work start and work end are each one 24-hour field, such as 09:00 or 18:00, with a small read-only 上午 or 下午 hint. There is no separate morning/afternoon selector. The stored time is 24-hour HH:mm.', '时区可以输入城市、IANA 标识，或 +8 这类偏移。上班时间和下班时间各是一个 24 小时字段，例如 09:00 或 18:00，旁边只读显示上午或下午，没有单独的上午/下午选择。保存的时间是 24 小时制 HH:mm。'],
      },
      {
        path: ['Rule sets → the group’s rule policy', '规则集 → 考勤组的规则策略'],
        detail: ['A rule set can be attached to a group. The rule template library stores versions of those templates.', '规则集可以挂到考勤组上。规则模板库保存这些模板的版本。'],
      },
    ],
    faqs: [{
      q: ['I changed the group timezone. Why are shift times the same?', '我改了考勤组时区，为什么班次时间没变？'],
      a: ['The group timezone is stored policy. Punch times follow the shift timezone, or the default rule when there is no shift.', '考勤组时区只作为组策略保存。打卡时间跟随班次时区；没有班次时才用默认规则。'],
    }],
  },
  {
    id: 'groups',
    labelEn: 'Groups',
    labelZh: '考勤组',
    sectionId: 'attendance-admin-groups',
    intro: [[
      'A group is the roster and the policy bundle for a set of people. Members are the attendance roster. Owners are a separate roster and are not counted as attendance people.',
      '考勤组是一群人的名单和策略包。成员是考勤名单。负责人是另一份名单，不计入考勤人员。',
    ]],
    scenarios: [[
      'Create a group before you assign shifts or rotations to those people. Add owners when someone who is not a platform admin should maintain that group’s members.',
      '要给这些人排班或轮班之前，先建组。需要非平台管理员维护这组的成员时，再加负责人。',
    ]],
    steps: [
      {
        path: ['Groups → Save the group', '考勤组 → 保存考勤组'],
        detail: ['Save the group before adding people. Group type locks after creation. The list title is the group name. A code, when set, is under Technical info on the detail header.', '先保存考勤组，再添加人员。考勤组类型创建后锁定。列表标题是组名。编码若有，在详情标题旁的「技术信息」里。'],
      },
      {
        path: ['People → type a name or email', '考勤人员 → 输入姓名或邮箱'],
        detail: ['Matches appear as you type. Paste user IDs stays closed until you already have ids. Members and owners are still stored as user ids. Maintaining owners stays admin-only; an owner or sub-owner of the group can add or remove members.', '输入时自动匹配。「粘贴用户 ID」默认收起，已有 ID 时再打开。成员和负责人保存的仍是用户 ID。维护负责人仅限管理员；本组 owner 或 sub_owner 可以增删成员。'],
      },
    ],
    faqs: [{
      q: ['Why can’t I add people on a group I have not saved?', '组还没保存，为什么不能加人？'],
      a: ['The member and owner lists are stored against the group id. That id exists only after the first save.', '成员和负责人名单挂在组 id 上。第一次保存之后才有这个 id。'],
    }],
  },
  {
    id: 'availability',
    labelEn: 'Availability',
    labelZh: '团队可用性',
    sectionId: 'attendance-admin-team-availability',
    intro: [[
      'Read-only. Pick a group by name; the request still sends that group’s id. From and to are calendar dates. Both are required, from must be on or before to, and the span is at most 366 days. Members × days above 6000 is refused.',
      '只读。按考勤组名称选择；请求仍提交该组的 id。起、止是日历日（中文为年-月-日）。两者都必填，起不能晚于止，跨度最多 366 天。成员数 × 天数超过 6000 会被拒绝。',
    ]],
    scenarios: [[
      'Use it to see who is scheduled, resting, on approved leave, or only tentatively pending — before you promise a headcount. It does not edit the schedule.',
      '在答应人头之前，用它看谁已排班、谁休息、谁已批假、谁只是待审批。它不改排班。',
    ]],
    steps: [
      {
        path: ['Team availability → group, from, to → Load', '团队可用性 → 考勤组、起、止 → 查询'],
        detail: ['Group, from, and to sit on one row. Pick the group by name; its id stays off the field and out of the menu. The matrix lists each person by name. Each member-day is one state. An approved personal-leave overlay wins. Otherwise a pending-leave overlay is “pending”, shown as tentative. Otherwise a day with no schedule is unscheduled. A scheduled working day is “scheduled”; a scheduled non-working day is “rest”.', '考勤组、起、止在同一行。按名称选择考勤组，组 id 不出现在输入框和候选列表里。矩阵按姓名列出每个人。每个成员的每一天只有一种状态。已批事假覆盖优先。否则待审批请假记为「待审批」，以暂定样式显示。再否则，这一天没有排班就是未排班。已排班且为工作日是「排班」；已排班但非工作日是「休息」。'],
      },
    ],
    callout: [
      'Available (formal) = scheduled + pending. Pending is not deducted. Approved leave, rest, and unscheduled are excluded.',
      '可用（正式）= 排班 + 待审批。待审批不扣减。已批请假、休息、未排班不计入。',
    ],
    faqs: [{
      q: ['The table went blank after a failed load. Is the old data still there?', '加载失败后表空了，上一份数据还在吗？'],
      a: ['No. A failed load, including 403 and 404, clears the previous table. 403 means you are not an admin and not an owner or sub-owner of that group. 404 means the group id does not exist; permission is checked first.', '不在。加载失败（含 403、404）会清掉上一张表。403 表示你不是管理员，也不是该组 owner 或 sub_owner。404 表示组不存在；权限先于是否存在被检查。'],
    }],
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
    intro: [[
      'Balance shows the person’s name next to the remaining minutes. Policy save turns the engine on or off. When it is on, a timezone is required. Chinese shows a place name; the stored value is the IANA id. That timezone sets lot expiry at 1 January 00:00 and the scheduler’s “today”. It does not change shift timezones.',
      '余额旁显示人员姓名和剩余分钟。策略页打开或关闭引擎。打开时必须有时区。中文显示地名，保存的是 IANA 标识。此时区决定额度在 1 月 1 日 00:00 到期，以及自动发放里的「今天」。它不改班次时区。',
    ]],
    scenarios: [[
      'Turn the engine on when this organization should accrue annual leave here. Use operations only after that, to adjust, backfill expiry, or commit an accrual run.',
      '这个组织要在这里发年假时，先打开引擎。然后再到操作页做调整、回填到期或提交一次发放。',
    ]],
    steps: [
      {
        path: ['Annual leave policy → Enabled, timezone, carry-over', '年假策略 → 启用、时区、跨年结转'],
        detail: ['Carry-over off: a year-Y lot expires 1 January Y+1 00:00. Carry-over on: 1 January Y+2 00:00. Lots already granted keep the expiry from the run that created them. Monthly auto-run also needs the answering process to have ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED and ATTENDANCE_SCHEDULER_ENABLED set to the literal true.', '不结转：Y 年额度在 Y+1 年 1 月 1 日 00:00 失效。结转：Y+2 年 1 月 1 日 00:00。已发出的额度仍用当时那次发放记下的到期时间。每月自动跑还要应答进程把 ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED 和 ATTENDANCE_SCHEDULER_ENABLED 设成字面量 true。'],
      },
      {
        path: ['Annual leave operations → Preview, then commit', '年假操作 → 先预览，再提交'],
        detail: ['While the engine is off, adjust, backfill, and accrual submits are blocked. A single-balance preview only reads balances. A positive adjustment creates a manual lot with no expiry; a negative one deducts active lots in FIFO order and rolls back if the balance is short. Expiry backfill only fills annual accrual lots that still have no expiry, using the original run’s snapshot. An accrual dry-run writes the run audit and per-person rows, and writes no balance lots. Commit is what creates the lots.', '年假操作页在引擎关闭时，调整、回填和发放的提交都会被拦住。单人余额预览只读取余额。正数调整新建一条无到期的手工额度；负数按先到期先扣，余额不够则整笔回滚。过期回填只补「发放产生、且还没有到期时间」的额度，用当时那次发放的快照，不用今天的策略。发放预演会记下运行和每人的结果，不写余额；提交才生成额度。'],
      },
    ],
    faqs: [{
      q: ['A 2026 lot with carry-over off expires when?', '2026 年的额度、不结转，什么时候到期？'],
      a: ['2027-01-01 00:00 in the policy timezone. Carry-over on expires at 2028-01-01 00:00. Lots already granted keep the expiry written when they were created.', '策略时区的 2027-01-01 00:00。结转则是 2028-01-01 00:00。已经发出的额度仍用创建时写下的到期时间。'],
    }],
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
    intro: [[
      'Reload reads the current catalog and does not create the multitable sheet. Sync catalog ensures the sheet exists and seeds missing field rows, then reads them back. It does not push attendance period rows.',
      '重载字段只读取当前目录，不创建多维表。同步字段目录会确保目录存在、补写缺失的字段行，再读回来。它不推送考勤周期数据。',
    ]],
    scenarios: [[
      'Reload when you only want to see the catalog. Sync when a field row is missing. Edit a custom formula when a column should be calculated and is not a system field.',
      '只想看目录时用重载。缺字段行时用同步。某一列要计算、且不是系统字段时，再改自定义公式。',
    ]],
    steps: [
      {
        path: ['Report fields → Reload, or Sync catalog', '统计字段 → 重载字段，或同步字段目录'],
        detail: ['Reload does not create the sheet. Sync catalog fills missing rows and does not push period data.', '重载不创建多维表。同步字段目录补齐缺失行，不推送周期数据。'],
      },
      {
        path: ['A custom formula → starts with =', '自定义公式 → 以 = 开头'],
        detail: ['Filters hide rows in the list. Search matches name, code, description, and the formula text. Record scope reads {code} on that row. Summary scope wraps fields in SUM, AVERAGE, COUNT, or COUNTA, or uses summary aliases such as {total_minutes}. Formula fields cannot reference other formula fields in v1. NOW, TODAY, lookups, cross-table cell refs, and scripts are blocked. System formulas have no edit button. Preview on an existing custom formula does not write the catalog.', '筛选只隐藏列表里的行。搜索匹配名称、编码、说明和公式文本。单记录用 {编码} 读这一行。周期汇总用 SUM、AVERAGE、COUNT、COUNTA 包住字段，或用 {total_minutes} 这类汇总别名。v1 不允许公式字段互相引用。NOW、TODAY、查找函数、跨表单元格引用和脚本被禁用。系统公式没有编辑按钮。已有自定义公式上的预览不写入目录。'],
      },
    ],
    faqs: [{
      q: ['Why is there no edit button on a system formula?', '系统公式为什么没有编辑按钮？'],
      a: ['System formulas are fixed. Preview of a custom formula also does not write the catalog until you save.', '系统公式是固定的。自定义公式的预览在你保存之前也不会写入目录。'],
    }],
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
    intro: [[
      'Import reads a mapped file (the default profile is the DingTalk daily CSV) and writes attendance rows only after you commit. When ATTENDANCE_IMPORT_REQUIRE_TOKEN is the literal 1, commit requires a token that expires 10 minutes after it is issued.',
      '导入按映射读取文件（默认配置是钉钉日汇总 CSV），提交之后才写入考勤行。当 ATTENDANCE_IMPORT_REQUIRE_TOKEN 为字面量 1 时，提交需要一张签发后 10 分钟失效的令牌。',
    ]],
    scenarios: [[
      'Use import to bring a mapped daily file into attendance rows. Open import batches afterwards to see what those runs did. Batches are not a second import form.',
      '要把一份已映射的日文件写进考勤行时用导入。之后到导入批次看这些运行做了什么。批次不是第二张导入表。',
    ]],
    steps: [
      {
        path: ['Import → map the file → Commit', '导入 → 映射文件 → 提交'],
        detail: ['Rows are written only at commit. If the token flag is the literal 1, issue the token and commit within 10 minutes.', '只有提交才写入。令牌开关为字面量 1 时，签发后要在 10 分钟内提交。'],
      },
      {
        path: ['Import batches', '导入批次'],
        detail: ['Import batches is the history of those runs, not a second import form.', '导入批次是这些运行的历史，不是第二张导入表。'],
      },
    ],
    faqs: [{
      q: ['I mapped the file but the records did not change. Why?', '我映射了文件，记录为什么没变？'],
      a: ['Mapping does not write. Commit writes rows.', '映射不写入。提交才写入。'],
    }],
    figureTitle: ['Write path', '写入路径'],
    figureRows: [
      ['Map the file', '映射文件'],
      ['Commit writes rows', '提交才写入'],
      ['Batches list past runs', '批次页只列历史'],
    ],
  },
  {
    id: 'reports',
    labelEn: 'Reports',
    labelZh: '报表',
    intro: [[
      'Reports is the period view. Filters, export, and column choices sit on top. Three numbers sit above the records table. Trend, management totals, and status mixes stay folded. It does not edit rules.',
      '报表是区间视图。筛选、导出和显示字段在上方。记录表上面只有三个数字。考勤趋势、管理统计和状态分布默认收起。它不改规则。',
    ]],
    scenarios: [[
      'Open it to read a period or to export that period. Organization id and user id sit under More filters. They are plain filters, not a person picker, because this page is open to people who are not platform admins.',
      '要阅读一个区间或导出这个区间时打开它。组织 ID 和用户 ID 在「更多筛选」里。它们是普通筛选，不是人员选择器，因为报表页对非平台管理员也开放。',
    ]],
    steps: [
      {
        path: ['Reports → date range → the numbers → the records table', '报表 → 日期区间 → 关键数字 → 记录表'],
        detail: ['The three numbers are records on this page, flagged rows, and early leave. Click one to show those rows. A folded section that is all zeros says 暂无 instead of a row of zeros. Caliber guide stays on the page and starts collapsed. Expand it for the seven plain-language definitions (expected days, attendance days, severe late, absence-level late, and the three overtime buckets). The guide shows the name and the sentence, not the field code. Those codes stay in Report fields and in the CSV header mode under Technical details.', '三个数字是本页记录、异常和早退。点一个数字就只看这些行。收起的统计如果全是 0，写成「暂无」，不再排一排 0。口径说明留在页面上，默认收起。展开后是七句说明：应出勤天数、出勤天数、严重迟到、旷工迟到，以及工作日/休息日/节假日三类加班。说明里是名称和那一句话，不出现字段编码。编码仍在统计字段里，以及「技术信息」中的 CSV 表头模式。'],
      },
      {
        path: ['Reports → Columns', '报表 → 显示字段'],
        detail: ['The choice is remembered in this browser. Date and name stay visible. Show all reveals the full catalog. Export CSV and Export Excel still download the server dataset for the active range and filters. Hiding a column does not drop it from the file. Trend, minute totals, and request mixes stay under Breakdown / more stats, which starts collapsed.', '选择记在这台浏览器里。日期和姓名始终显示。「全部显示」打开完整目录。导出 CSV 和导出 Excel 仍下载当前区间和筛选条件下的服务端数据集。藏起一列不会让它从文件里消失。趋势、分钟合计和申请分布在「分布 / 更多统计」里，默认收起。'],
      },
    ],
    callout: [
      'CSV header mode chooses field names or field codes for the file. It lives under Technical details, not on the main toolbar.',
      'CSV 表头模式决定文件用字段名称还是字段编码。它在「技术信息」里，不在主工具条上。',
    ],
    faqs: [{
      q: ['I hid a column. Why is it still in the CSV?', '我藏了一列，为什么 CSV 里还有？'],
      a: ['The table is a local view. The export is the server dataset for the range and filters.', '表格是本机视图。导出是该区间和筛选条件下的服务端数据集。'],
    }],
    figureTitle: ['How to read the page', '这一页怎么读'],
    figureRows: [
      ['Filters, export, columns', '筛选、导出、显示字段'],
      ['Three numbers, then the table', '三个数字，然后是记录表'],
      ['Caliber guide, collapsed', '口径说明，默认收起'],
      ['Breakdown stays folded', '分布 / 更多统计，默认收起'],
      ['Export stays the full file', '导出仍是完整文件'],
    ],
  },
]

export function attendanceGuideTopicText(topic: GuideTopic): string {
  const parts: string[] = [topic.labelEn, topic.labelZh]
  const push = (pair?: [string, string]) => {
    if (pair) parts.push(pair[0], pair[1])
  }
  topic.intro.forEach(push)
  topic.scenarios.forEach(push)
  topic.steps.forEach(step => {
    push(step.path)
    push(step.detail)
  })
  topic.faqs.forEach(item => {
    push(item.q)
    push(item.a)
  })
  push(topic.callout)
  push(topic.figureTitle)
  topic.figureRows?.forEach(push)
  return parts.join('\n').toLowerCase()
}

export function attendanceGuideTopicForSection(sectionId: string | undefined): string {
  if (!sectionId) return 'overview'
  const match = attendanceGuideTopics.find(topic => topic.sectionId === sectionId)
  if (match) return match.id
  if (sectionId === 'attendance-admin-holiday-sync') return 'holidays'
  if (sectionId === 'attendance-admin-payroll-cycles') return 'payroll'
  if (sectionId === 'attendance-admin-rule-sets' || sectionId === 'attendance-admin-rule-template-library') return 'rules'
  if (sectionId === 'attendance-admin-annual-leave-balance' || sectionId === 'attendance-admin-annual-leave-operations') return 'annual'
  if (sectionId === 'attendance-admin-import-batches') return 'import'
  return 'overview'
}
