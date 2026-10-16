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
  { id: 'manual', labelEn: 'Manual', labelZh: '考勤手册', topicIds: ['overview', 'quickstart'] },
  { id: 'employee', labelEn: 'Employees', labelZh: '员工使用', topicIds: ['punch', 'makeup', 'leave', 'overtime', 'swap', 'records'] },
  { id: 'configure', labelEn: 'Setup', labelZh: '配置', topicIds: ['settings', 'holidays', 'rules', 'groups'] },
  { id: 'schedule', labelEn: 'Shifts and schedules', labelZh: '班次与排班', topicIds: ['shifts', 'assignments', 'scopes'] },
  { id: 'requests', labelEn: 'Requests and approval', labelZh: '申请与审批', topicIds: ['leave-types', 'overtime-rules', 'approvals'] },
  { id: 'pay', labelEn: 'Payroll and leave', labelZh: '计薪与年假', topicIds: ['payroll', 'annual'] },
  { id: 'data', labelEn: 'Data', labelZh: '数据', topicIds: ['availability', 'fields', 'import', 'reports'] },
  { id: 'reference', labelEn: 'Reference', labelZh: '说明', topicIds: ['permissions', 'errors', 'faq'] },
]

export const attendanceGuideTopics: GuideTopic[] = [
  {
    id: 'overview',
    labelEn: 'Overview',
    labelZh: '总览',
    intro: [[
      'The management home lists task cards. A card that names a section opens that one section. The left rail does the same: one section is open at a time, and the bar above it is that section’s name.',
      '管理首页是任务卡片。点到某个区块名称，就只打开那一个区块。左侧目录同样一次只打开一个区块，上方标题就是该区块的名称。',
    ], [
      'Open this manual from Attendance help on the admin bar. The employee overview has no second help entry. Articles here cover admin setup and what employees do on the overview. Search matches Chinese and English.',
      '本手册从管理端顶栏的「考勤帮助」打开。员工总览没有第二本帮助。这里同时写管理员配置，以及员工在总览上的操作。搜索同时匹配中文和英文。',
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
      {
        path: ['Settings → Punch and geofence → Min punch interval', '设置 → 打卡与围栏 → 最小打卡间隔（分钟）'],
        detail: ['Enter minutes, then Save settings. The same punch type inside this gap is rejected. Check-in then check-out is not limited by it.', '填写分钟后点「保存设置」。同一类打卡落在这个间隔内会被拒绝。先上班再下班不受它限制。'],
      },
      {
        path: ['Settings → Punch and geofence → IP allowlist', '设置 → 打卡与围栏 → IP 白名单'],
        detail: ['Leave it empty to allow every address. Otherwise enter one address per line, or separate addresses with commas. Save settings.', '留空表示不限制地址。否则每行一个，或用逗号分隔。然后点「保存设置」。'],
      },
      {
        path: ['Settings → Punch and geofence → Geo fence', '设置 → 打卡与围栏 → 地理围栏'],
        detail: ['Fill Geo fence lat, Geo fence lng, and Geo fence radius (m) together. Leave them empty to turn the fence off. Save settings.', '地理围栏纬度、地理围栏经度、地理围栏半径（米）要一起填。三项都留空则关闭围栏。然后点「保存设置」。'],
      },
      {
        path: ['Settings → Employee common icons', '设置 → 员工常用图标'],
        detail: ['Four rows: 补卡, 请假, 加班, 换班. Pick one icon on each row. Choices are clock-plus, calendar, moon, swap, plus, user, briefcase, and pin. Defaults are clock-plus, calendar, moon, and swap. Save settings. The overview shows those icons. Employees cannot change them there.', '四行：补卡、请假、加班、换班。每行点一个图标。可选 clock-plus、calendar、moon、swap、plus、user、briefcase、pin。默认是 clock-plus、calendar、moon、swap。点「保存设置」。总览显示这些图标。员工不能在总览上改。'],
      },
      {
        path: ['Settings → Holiday hours', '设置 → 节假日工时'],
        detail: ['Holiday first-day base hours turns on the first-day hours field. Overtime adds on holiday uses Overtime source: Approval, Clock, or Both. Named rows under Holiday overrides use Contains, Equals, or Regex. Calendar overrides open from Holidays. Save settings.', '勾选「节假日首日基准工时」后填写「首日基准工时」。「节假日计入加班」配合「加班来源」：审批、打卡或两者。「节假日覆盖规则」按名称匹配，方式是包含、等于或正则。日历覆盖规则从「节假日」进入。点「保存设置」。'],
      },
      {
        path: ['Settings → Outdoor punch approval', '设置 → 外勤打卡审批'],
        detail: ['Default off. Turn on Require approval for outdoor punches when a punch outside the fence should wait. Require a note and Require a photo are separate checkboxes. Photo evidence applies when the punch client sends a location or an outdoor marker. Save outdoor approval.', '默认关闭。围栏外打卡要等审批时，勾选「外勤打卡需审批」。「外勤打卡需填写备注」和「外勤打卡需上传照片证据」是另外两个勾选。照片对提交了定位或外勤标记的打卡端生效。点「保存外勤审批」。'],
      },
      {
        path: ['After saving → what to check', '做完后怎么确认'],
        detail: ['Today’s punch rows stay as they were. Auto absence runs later, at Run at, across Lookback days. The report digest is not sent from this save.', '今天已有的打卡行保持原样。自动缺勤要到「执行时间」才跑，并按「回溯天数」回看。这次保存不会发出统计通知。'],
      },
    ],
    callout: [
      'Saving settings does not send the report digest. The digest section stores timezone, channel, and send times; a message goes out only when that scheduled job actually runs.',
      '保存设置不会发出统计通知。统计通知订阅单独保存时区、渠道和发送时间；只有定时任务真正跑起来才会发。',
    ],
    faqs: [{
      q: ['What does Shift compliance do?', '排班合规做什么？'],
      a: ['With enforcement set to Block on save and a daily, weekly, or monthly cap filled in, saving a schedule that would exceed that cap is rolled back. Empty caps are not enforced. Warn is stored and does not block the save.', '强制方式选「保存时阻断」，并且填写了每日、每周或每月上限时，超出计划工时的排班保存会被回滚。上限留空不启用。「预警」会保存，但不会拦住保存。'],
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
        detail: ['Choose years and whether to overwrite. Then Sync now.', '选择年份，以及是否覆盖。然后点「立即同步」。'],
      },
      {
        path: ['After sync → what to check', '做完后怎么确认'],
        detail: ['The holiday list gains or updates date rows. Yesterday’s punch times and shift clocks stay as they were.', '节假日列表里出现或更新日期行。昨天的打卡时间和班次钟点保持原样。'],
      },
    ],
    callout: [
      'A partial-rest rule uses an inclusive day index. Start 4 and end 5 change only days 4 and 5 of the matched holiday into workdays. Leave the index empty to cover the whole holiday.',
      '少休规则用的是含首尾的序号。起始填 4、结束填 5，只把匹配节日的第 4 天和第 5 天改成工作日。序号留空则覆盖整段节日。',
    ],
    faqs: [{
      q: ['Which page edits one date?', '改单独某一天去哪一页？'],
      a: ['Holidays, on that date row. Holiday sync fills a year from the published index.', '在「节假日」的日期行上改。「节假日同步」按已发布索引铺一年。'],
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
        detail: ['The timezone picker accepts a city, an IANA id, or an offset such as +8. Work start and work end are each one 24-hour field, such as 09:00 or 18:00, with a small read-only 上午 or 下午 hint. There is no separate morning/afternoon selector. The stored time is 24-hour HH:mm. Late grace, early grace, rounding, and working days are on the same form. The built-in starting values are 09:00–18:00, 10 minutes of late grace, 10 minutes of early grace, and 5 minutes of rounding.', '时区可以输入城市、IANA 标识，或 +8 这类偏移。上班时间和下班时间各是一个 24 小时字段，例如 09:00 或 18:00，旁边只读显示上午或下午，没有单独的上午/下午选择。保存的时间是 24 小时制 HH:mm。同一张表还有迟到宽限、早退宽限、取整和工作日。内置起点是 09:00–18:00、迟到宽限 10 分钟、早退宽限 10 分钟、取整 5 分钟。'],
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
        detail: ['Save the group before adding people. Group type locks after creation. The list title is the group name. A code, when set, is under Technical info on the detail header. Choose the type in Work time settings before the first save: Fixed shift, Scheduled shift, or Free time. Fixed shift uses the fixed-schedule preview and apply panel. Scheduled shift continues in Advanced scheduling. Free time keeps the people and policy grouping on this page.', '先保存考勤组，再添加人员。考勤组类型创建后锁定。列表标题是组名。编码若有，在详情标题旁的「技术信息」里。第一次保存前在「考勤时间设置」里选择类型：固定班制、排班制或自由工时。固定班制使用固定排班的预览和应用。排班制继续到高级排班。自由工时在本页维护人员和策略分组。'],
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
        detail: ['Rows are written only at Commit. If the token flag is the literal 1, issue the token and commit within 10 minutes.', '只有「提交」才写入。令牌开关为字面量 1 时，签发后要在 10 分钟内提交。'],
      },
      {
        path: ['Import → file type', '导入 → 文件类型'],
        detail: ['A .xlsx file under 10MB is converted in the browser. The first non-empty sheet becomes CSV, then uses the same preview and Commit. A locked, empty, or unreadable workbook stops. Save a legacy .xls file as CSV, then select that .csv. The server accepts CSV text.', '10MB 以内的 .xlsx 在浏览器里转换。第一个非空工作表变成 CSV，再走同一条预览和「提交」。有密码、空表或读不开的工作簿会停住。旧版 .xls 请另存为 CSV，再选择该 .csv。服务端接受 CSV 文本。'],
      },
      {
        path: ['Import batches', '导入批次'],
        detail: ['Import batches is the history of those runs, not a second import form.', '导入批次是这些运行的历史，不是第二张导入表。'],
      },
      {
        path: ['After commit → what to check', '做完后怎么确认'],
        detail: ['Mapped preview alone leaves attendance rows unchanged. After Commit, open Import batches and confirm this run. Then reload Reports for that date.', '只做映射预览时，考勤行不变。「提交」之后打开「导入批次」，确认这次运行。再到「报表」重载对应日期。'],
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
        detail: ['The choice is remembered in this browser. Date and name stay visible. Show all reveals the full catalog. Restore default resets only this browser. Trend, minute totals, and request mixes stay under Breakdown / more stats, which starts collapsed.', '选择记在这台浏览器里。日期和姓名始终显示。「全部显示」打开完整目录。「恢复默认」只重置这台浏览器。趋势、分钟合计和申请分布在「分布 / 更多统计」里，默认收起。'],
      },
      {
        path: ['After export → what to check', '做完后怎么确认'],
        detail: ['Change the date range, then Reload report, then Export CSV or Export Excel. A hidden column remains in the file. The file is the server dataset for that range and filters, up to 5000 rows.', '改完日期后先点「重载报表」，再点「导出 CSV」或「导出 Excel」。藏起的列仍在文件里。文件是该区间和筛选条件下的服务端数据，最多 5000 行。'],
      },
    ],
    callout: [
      'CSV header mode chooses field names or field codes for the file. It lives under Technical details, not on the main toolbar.',
      'CSV 表头模式决定文件用字段名称还是字段编码。它在「技术信息」里，不在主工具条上。',
    ],
    faqs: [{
      q: ['I hid a column. Why is it still in the CSV?', '我藏了一列，为什么 CSV 里还有？'],
      a: ['The table is a local view. The export is the server dataset for the range and filters. Restore default only resets the columns in this browser. The file can include up to 5000 rows for that range.', '表格是本机视图。导出是该区间和筛选条件下的服务端数据集。「恢复默认」只重置这台浏览器里的显示字段。该区间的文件最多包含 5000 行。'],
    }, {
      q: ['Do the three numbers equal the seven field definitions?', '上面三个数字等于那七个字段的合计吗？'],
      a: ['The three numbers count records, flagged rows, and early leave on the loaded page. The seven sentences describe report fields such as expected days, attendance days, severe late, absence-level late, and the three overtime durations. Severe late uses a built-in threshold of 30 minutes and absence-level late uses 60 minutes; a day that reaches the absence tier is also counted as severe. A threshold of 0 turns that tier off.', '三个数字统计的是当前已加载这一页上的记录、异常和早退。那七句说明的是报表字段，例如应出勤天数、出勤天数、严重迟到、旷工迟到，以及三类加班时长。严重迟到的内置阈值是 30 分钟，旷工迟到是 60 分钟；达到旷工档的当天同时计入严重迟到。阈值为 0 的那一档不计。'],
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
  {
    id: 'quickstart',
    labelEn: 'Quick start',
    labelZh: '快速入门',
    sectionId: 'attendance-admin-setup',
    intro: [[
      'A new organization is ready for daily attendance after four saves: a shift, a default rule, an attendance group with members, and a published schedule for those people. Employees then punch and file requests from the overview. This manual opens from Attendance help on the admin bar. Setup readiness is a checklist. Applying a starter template only fills forms in memory. Each form still needs its own save.',
      '一个新组织要开始日常考勤，先完成四次保存：班次、默认规则、带成员的考勤组，以及这些人已发布的排班。员工再从总览打卡和提交申请。本手册从管理端「考勤帮助」打开。启用准备是清单。应用起步模板只在内存里预填。每张表仍要各自保存。',
    ]],
    scenarios: [[
      'Use it when an administrator is turning attendance on, or when an employee asks where to punch and where to file a request.',
      '管理员第一次启用考勤，或员工询问打卡和申请入口时，从这里看顺序。',
    ]],
    steps: [
      {
        path: ['Admin → Setup readiness', '管理 → 启用准备'],
        detail: ['Read the checklist. A template prefill does not write a group, a shift, or a flag. Confirm and save on the form that owns that data.', '先看清单。模板预填不会写入考勤组、班次或开关。到对应表单上确认并保存。'],
      },
      {
        path: ['Shifts, then Default rule', '班次，然后默认规则'],
        detail: ['Create the shift with its timezone and work times. Save the default rule so a person without a shift still has a work window. Punch calculation uses the rotation shift, otherwise the personal assignment shift, otherwise this default rule.', '先建班次，写上时区和上下班时间。再保存默认规则，让还没有班次的人仍有上下班窗口。打卡计算依次用轮班上的班次、个人排班上的班次、最后才用这份默认规则。'],
      },
      {
        path: ['Attendance groups → save, then add people', '考勤组 → 保存，再添加人员'],
        detail: ['Pick Fixed shift, Scheduled shift, or Free time before the first save. The type locks after creation. Members are the attendance roster. Owners and sub-owners are a separate roster and are not attendance people. An owner can add or remove members of that group; only an administrator maintains the owner list.', '第一次保存前选择固定班制、排班制或自由工时。类型创建后锁定。成员是考勤名单。负责人和子负责人是另一份名单，不计入考勤人员。本组负责人可以增删本组考勤人员；负责人名单只由管理员维护。'],
      },
      {
        path: ['Publish a schedule, then open the employee overview', '发布排班，然后打开员工总览'],
        detail: ['Fixed shift uses the group fixed-schedule preview and apply. Scheduled shift uses shift assignments or rotations, saved as drafts and then published. On the overview, Check In and Check Out record the punch. The Common row opens Makeup punch, Leave, Overtime, and Shift swap. Those four icons are chosen on Settings.', '固定班制用考勤组里的固定排班预览和应用。排班制用排班分配或轮班，先存草稿再发布。总览上的上班打卡和下班打卡记录打卡。常用一行打开补卡、请假、加班和换班。这四个图标在设置里选择。'],
      },
    ],
    callout: [
      'Group timezone is stored policy. Punch times follow the shift timezone, or the default rule when there is no shift.',
      '考勤组时区只作为组策略保存。打卡时间跟随班次时区；没有班次时才用默认规则。',
    ],
    faqs: [{
      q: ['Where does an employee punch?', '员工在哪里打卡？'],
      a: ['On the attendance overview, buttons Check In and Check Out. The clock is the server time. See Punch for refusals.', '在考勤总览，按钮是「上班打卡」和「下班打卡」。时钟是服务器时间。被拒绝时的说明见「打卡」。'],
    }],
    figureTitle: ['First week', '第一次启用'],
    figureRows: [
      ['Shift and default rule', '班次和默认规则'],
      ['Group and members', '考勤组和考勤人员'],
      ['Published schedule', '已发布排班'],
      ['Overview punch and Common', '总览打卡和常用'],
    ],
  },
  {
    id: 'punch',
    labelEn: 'Punch',
    labelZh: '打卡',
    intro: [[
      'Read this in admin Attendance help. Employees punch on the overview. That screen has no help manual of its own.',
      '在管理端「考勤帮助」里阅读本篇。员工在总览打卡。总览没有自己的帮助手册。',
    ], [
      'The overview shows a live clock, today’s in and out, and two buttons: Check In and Check Out. A successful punch says 「上班打卡已记录。」 or 「下班打卡已记录。」. The request sends the event type and, when known, the rule timezone and organization. It does not send a client timestamp, a map location, or a photo.',
      '总览显示实时时钟、今日上班和下班，以及两个按钮：上班打卡、下班打卡。成功后提示「上班打卡已记录。」或「下班打卡已记录。」。请求提交打卡类型，并在已知时带上规则时区与组织。它不提交客户端时间、地图定位或照片。',
    ], [
      'The same event type is limited by the minimum punch interval, one minute unless Settings changes it. Check In followed by Check Out is not held by that interval. Check Out before Check In on the same work date is rejected. An empty IP allowlist allows every address. An empty geofence is off. The web punch does not collect a location, so a configured fence treats that punch as outside the fence.',
      '同一类打卡受最小打卡间隔限制，设置未改时是 1 分钟。先上班再下班不受这个间隔限制。同一工作日先下班后上班会被拒绝。IP 白名单留空则不限制地址。地理围栏留空则关闭。网页打卡不采集定位，因此一旦配置了围栏，这次打卡会按围栏外处理。',
    ]],
    scenarios: [[
      'An employee records arrival or departure, or an administrator explains a rejected punch.',
      '员工记录上班或下班，或管理员解释一次被拒绝的打卡。',
    ]],
    steps: [
      {
        path: ['Overview → Check In or Check Out', '总览 → 上班打卡或下班打卡'],
        detail: ['The button shows Working... while the request is in flight. Punch permission is attendance:write. The punch is for the signed-in person. If the request names an organization, that organization must be one of the caller’s active memberships.', '请求发出时按钮显示「处理中...」。打卡权限是 attendance:write。打的是当前登录人自己的卡。若请求写明了组织，该组织必须是调用人的有效成员组织。'],
      },
      {
        path: ['Settings → Punch and geofence', '设置 → 打卡与围栏'],
        detail: ['IP allowlist and geofence are organization settings. Outside the fence with outdoor approval off, the overview says the current location is outside the allowed range and outdoor approval is not enabled. With outdoor approval on, the punch can become a pending outdoor-punch request and counts after approval. The message is 「外勤打卡已提交审批，通过后计入考勤」.', 'IP 白名单和地理围栏是组织设置。围栏外且外勤审批关闭时，总览会提示当前位置在允许范围外，且本组织未启用外勤审批。外勤审批打开后，这次打卡可以变成待审批的外勤打卡，通过后才计入。提示是「外勤打卡已提交审批，通过后计入考勤」。'],
      },
      {
        path: ['Outdoor note, when the page asks', '页面要求时填写外勤备注'],
        detail: ['If the policy requires a note, the overview shows Outdoor punch note and Retry punch with note. The retry sends that note and still does not send a location. Require a photo applies to clients that submit a location or an outdoor marker.', '策略要求备注时，总览出现「外勤打卡备注」和「补充备注后重试打卡」。重试会带上这段备注，仍然不带定位。「外勤打卡需上传照片证据」对提交定位或外勤标记的客户端生效。'],
      },
    ],
    callout: [
      'Unscheduled punching is allowed unless the organization sets that policy to block. In block mode, a day with no schedule returns PUNCH_UNSCHEDULED_BLOCKED.',
      '未排班时默认可打卡。只有组织把该策略改成拦截后，当天没有排班才会返回 PUNCH_UNSCHEDULED_BLOCKED。',
    ],
    faqs: [{
      q: ['Why is the punch outside the fence when I am in the office?', '人在办公地点，为什么仍提示在围栏外？'],
      a: ['The overview punch does not collect a location. With a fence configured and outdoor approval off, that punch is outside the fence. Clear the fence to turn the check off, or enable outdoor approval if those punches should wait for approval.', '总览打卡不采集定位。配置了围栏且外勤审批关闭时，这次打卡按围栏外处理。要关闭这项检查就清空围栏；若这类打卡应等待审批，则打开外勤审批。'],
    }, {
      q: ['Can I choose the punch time?', '可以自己选打卡时间吗？'],
      a: ['The server records the time. A client-supplied occurred time is rejected as PUNCH_CLIENT_TIMESTAMP_FORBIDDEN.', '时间由服务器记录。客户端自带发生时间会被拒绝，代码是 PUNCH_CLIENT_TIMESTAMP_FORBIDDEN。'],
    }, {
      q: ['Why is a second punch too soon?', '为什么马上再打一次会被拒绝？'],
      a: ['Two punches of the same type inside the minimum interval return PUNCH_TOO_SOON. The default interval is one minute, from Settings.', '同一类打卡落在最小间隔内会返回 PUNCH_TOO_SOON。默认间隔是 1 分钟，在设置里修改。'],
    }],
    figureTitle: ['What the punch checks', '打卡会检查什么'],
    figureRows: [
      ['Server time', '服务器时间'],
      ['Same-type interval', '同类打卡间隔'],
      ['IP allowlist', 'IP 白名单'],
      ['Geofence and outdoor approval', '围栏和外勤审批'],
    ],
  },
  {
    id: 'makeup',
    labelEn: 'Makeup punch',
    labelZh: '补卡',
    sectionId: 'attendance-admin-makeup-punch-policy',
    intro: [[
      'Read this in admin Attendance help. Employees use Common → Makeup punch on the overview.',
      '在管理端「考勤帮助」里阅读本篇。员工在总览使用「常用 → 补卡」。',
    ], [
      'Request types are fixed: missed check-in, missed check-out, and time correction. Makeup punch policy is off until an administrator enables enforcement. While it is off, a request can still be submitted and approved. The server does not check quota, window, anomaly type, reason, or attachment.',
      '申请类型固定三项：漏打上班卡、漏打下班卡、时间更正。补卡策略在管理员打开强约束之前不生效。关闭时仍可提交并审批。服务器不检查次数、时限、异常类型、原因或附件。',
    ], [
      'When enforcement is on, the cycle is a calendar month, the quota principal is the self-service user, and the window unit is a calendar day. Those three are fixed on the form. Defaults are timezone Asia/Shanghai, 3 requests per cycle, counting pending and approved, and a 30-calendar-day submit window. Quota is 1–99. The window is 0–180 days. A future work date is rejected. A whole-day absence is not a makeup-eligible anomaly. The same person, work date, and request type cannot have another pending or approved row.',
      '打开强约束后，周期是自然月，额度主体是自助申请人，窗口单位是自然日。这三项在表单上是固定说明。默认时区 Asia/Shanghai，每周期 3 次，计入待审批和已通过，提交时限 30 个自然日。次数范围是 1–99。时限范围是 0–180 天。未来的工作日期会被拒绝。整日旷工不是可补异常。同一人、同一工作日、同一申请类型不能再有一条待审批或已通过的记录。',
    ]],
    scenarios: [[
      'An employee missed a punch or needs a time correction, and an administrator sets how many times and how far back that is allowed.',
      '员工漏打卡或要更正时间，管理员规定每个周期能补几次、能回溯多少天。',
    ]],
    steps: [
      {
        path: ['Admin → Makeup punch policy → Save makeup-punch policy', '管理 → 补卡策略 → 保存补卡规则'],
        detail: ['Turn on Enable makeup-punch enforcement to apply the checks. Set the policy timezone, cycle start day, requests per cycle, which statuses count, submit window, allowed anomaly types, Require reason, and Require attachment URL. Allowed anomalies include missing in, missing out, late, severe late, absence-level late, and early leave.', '要执行这些检查，打开「启用补卡强约束」。然后设置规则时区、周期起始日、每周期补卡次数、计入额度的状态、提交时限、可补异常类型、要求填写原因、要求附件链接。可补异常包括缺上班卡、缺下班卡、迟到、严重迟到、旷工迟到和早退。'],
      },
      {
        path: ['Overview → Common → Makeup punch', '总览 → 常用 → 补卡'],
        detail: ['Choose the type, work date, and reason. If the policy requires an attachment, fill the attachment URL. Submit creates a pending request. Pending rows can be cancelled by the requester. Approval writes the makeup result.', '选择类型、工作日期和原因。策略要求附件时填写附件链接。提交后是待处理申请。待处理的单可以由申请人取消。审批通过后才按补卡结果回写。'],
      },
    ],
    callout: [
      'Editing a makeup request for another person is rejected with MAKEUP_PUNCH_CROSS_USER_FORBIDDEN. The employee submits their own request.',
      '替他人编辑补卡申请会被拒绝，代码 MAKEUP_PUNCH_CROSS_USER_FORBIDDEN。由员工本人提交。',
    ],
    faqs: [{
      q: ['The quota says it is used up. Which rows count?', '提示次数已用完，哪些单会计入？'],
      a: ['The message is 「本周期的补卡次数已用完。」. The policy checkboxes decide whether pending and approved rows count. Rejected and cancelled rows stay out when those statuses are not checked.', '提示是「本周期的补卡次数已用完。」。计入哪些状态由策略上的勾选决定。未勾选的已驳回和已取消不计入。'],
    }, {
      q: ['Why can people still submit while enforcement is off?', '强约束关着，为什么还能提交？'],
      a: ['Off means the quota and window checks are not run. The request still enters approval as pending.', '关闭表示不跑次数和时限检查。申请仍以待处理进入审批。'],
    }, {
      q: ['The date is outside the window.', '提示不在补卡时间窗口内。'],
      a: ['The message is 「该工作日期不在允许的补卡时间窗口内。」. Pick a work date inside the calendar-day window, or ask an administrator to change the policy. A future date says 「未来的工作日期无法提交补卡。」.', '提示是「该工作日期不在允许的补卡时间窗口内。」。改选窗口内的工作日期，或请管理员调整策略。未来日期的提示是「未来的工作日期无法提交补卡。」。'],
    }],
  },
  {
    id: 'leave',
    labelEn: 'Leave',
    labelZh: '请假',
    intro: [[
      'Read this in admin Attendance help. Employees open Leave from Common on the overview.',
      '在管理端「考勤帮助」里阅读本篇。员工在总览的「常用」里打开请假。',
    ], [
      'Leave request asks for a leave type, a start, an end, a duration, and an optional reason. Presets are Full day, Morning, and Afternoon. Morning and Afternoon split the person’s work window at its midpoint and do not subtract a lunch break. A cross-midnight shift hides those presets. Choosing a preset fills the times once; later edits recalculate the duration in 0.5-hour steps.',
      '请假申请要选假期类型、开始、结束、时长，原因可选。时段预设是全天、上午、下午。上午和下午按本人上下班窗口的中点切开，不扣除午休。跨午夜班次不显示这组预设。点预设只填充一次；之后再改时间，时长按 0.5 小时重算。',
    ], [
      'The attachment URL field appears when that leave type requires an attachment. The page blocks submit until it is filled. The server stores the URL and does not run a separate attachment check. Requires approval on the leave type is stored only. Ticked or not, the request is submitted as pending. A duplicate is the same person, the same work date, and leave, already pending or approved.',
      '该假期类型要求附件时才出现附件链接。页面在填上之前会拦住提交。服务器保存这个链接，不再单独检查附件。假期类型上的「需要审批」只被保存。无论是否勾选，申请都按待处理提交。重复指的是同一人、同一工作日、请假，并且已经有待处理或已通过的一条。',
    ]],
    scenarios: [[
      'An employee asks for time away, including annual leave when that engine is on, or comp time when a comp-time balance exists.',
      '员工申请离岗，包括年假引擎打开后的年假，以及已有调休余额时的调休。',
    ]],
    steps: [
      {
        path: ['Overview → Common → Leave', '总览 → 常用 → 请假'],
        detail: ['Pick an active leave type. Empty list means an administrator has not created one. Submit. Pending requests can be cancelled from the request list. An approved leave stays in force until a cancellation round finishes; the panel then says the leave is cancelled.', '选择一个启用的假期类型。列表为空表示管理员还没建类型。提交。待处理的申请可以在申请列表里取消。已通过的请假在撤销流程完成前仍然有效；完成后面板显示请假已取消。'],
      },
      {
        path: ['Approval deducts a balance only for some types', '审批通过后，只有部分类型扣余额'],
        detail: ['Leave type code annual, with the annual-leave engine on, deducts annual balance using the standard day minutes. One request cannot exceed one standard day; a longer one fails with ANNUAL_LEAVE_MULTI_DAY_UNSUPPORTED. A short balance fails with ANNUAL_LEAVE_BALANCE_INSUFFICIENT. Code comp_time deducts the comp-time pool, oldest lots first. Other types deduct only when a leave-offset rule is enabled for that type, from comp time, annual leave, or an unpaid pool that does not reduce a balance.', '假期编码为 annual 且年假引擎已启用时，按标准工作日分钟扣年假。一次申请不能超过一个标准日，超出失败代码是 ANNUAL_LEAVE_MULTI_DAY_UNSUPPORTED。余额不够的代码是 ANNUAL_LEAVE_BALANCE_INSUFFICIENT。编码 comp_time 按先到期先扣调休池。其它类型只有启用了对应的请假抵扣规则才扣减，来源可以是调休池、年假，或不减少余额的不付。'],
      },
      {
        path: ['Business trip is a separate card', '出差是另一张卡片'],
        detail: ['Business trip request asks for a destination timezone, a start and end in that local time, and an optional reason. Submit says the trip takes effect after approval. Repeated local times ask for an offset. Outdoor punch stays on the punch buttons and the outdoor-approval settings.', '出差申请填写目的地时区、目的地当地的开始和结束，原因可选。提交后的说明是审批通过后生效。当地时间出现重复时刻时要选择偏移。外勤打卡仍使用打卡按钮和外勤审批设置。'],
      },
    ],
    faqs: [{
      q: ['I cleared Requires approval. Why is the request still pending?', '我取消了「需要审批」，为什么还是待处理？'],
      a: ['The checkbox is marked 「暂不生效」. The request is still submitted as pending and waits for an approver.', '该勾选旁标是「暂不生效」。申请仍以待处理提交，并等待审批人处理。'],
    }, {
      q: ['Two leaves on the same day were rejected.', '同一天两条请假被拒绝了。'],
      a: ['The check is one pending or approved leave for that person on that work date. It does not compare clock times for an overlap.', '检查的是该人在该工作日是否已有待处理或已通过的请假。它不按钟点比较时间段是否重叠。'],
    }],
  },
  {
    id: 'overtime',
    labelEn: 'Overtime',
    labelZh: '加班',
    intro: [[
      'Read this in admin Attendance help. Employees open Overtime from Common on the overview.',
      '在管理端「考勤帮助」里阅读本篇。员工在总览的「常用」里打开加班。',
    ], [
      'Overtime request asks for an overtime rule, a start, an end, a duration, and an optional reason. A rule is required. The server raises the minutes to the rule minimum, rounds up by the rounding minutes, and cuts the result at the daily maximum. Requires approval on the rule is stored only. The request is still pending.',
      '加班申请要选加班规则、开始、结束、时长，原因可选。必须选择规则。服务器会把分钟抬到规则的最小值，按取整分钟向上取整，并在每日上限处截断。规则上的「需要审批」只被保存。申请仍是待处理。',
    ], [
      'A window that crosses one local midnight is accepted when the local start date is the request work date. The minutes are split onto those two local dates. A window that crosses more than one midnight, or whose local start date is not the work date, is rejected with OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED. An invalid window is OVERTIME_INVALID_TIME_WINDOW.',
      '恰好跨过一个当地午夜、并且当地开始日就是这条申请的工作日时，可以提交。分钟会拆到这两个当地日期上。跨过不止一个午夜，或当地开始日不是该工作日，会被拒绝，代码 OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED。时间窗无效的代码是 OVERTIME_INVALID_TIME_WINDOW。',
    ]],
    scenarios: [[
      'An employee records approved extra time, and an administrator decides the minimum, the rounding, and the daily cap.',
      '员工登记需要审批的额外工时，管理员决定最小分钟、取整和每日上限。',
    ]],
    steps: [
      {
        path: ['Overview → Common → Overtime', '总览 → 常用 → 加班'],
        detail: ['Choose an active rule. An empty list means an administrator has not created one. Provide minutes or a start and end. Submit. The same person, work date, and overtime cannot already be pending or approved.', '选择一条启用的规则。列表为空表示管理员还没建规则。填写分钟，或填写开始和结束。提交。同一人、同一工作日的加班不能已经处于待处理或已通过。'],
      },
      {
        path: ['Reports show three overtime durations', '报表里有三类加班时长'],
        detail: ['Workday, rest-day, and holiday overtime minutes are report fields. They are filled when the calculation stores a segmentation snapshot on the overtime request. This page sets the minimum, the rounding, and the daily cap.', '工作日、休息日、节假日加班分钟是报表字段。计算把分段快照写进加班申请后，这些字段才有数。本页设置最小值、取整和每日上限。'],
      },
      {
        path: ['Settings → overtime bank, when comp time should grow', '要增加调休时，到设置里的加班银行'],
        detail: ['The overtime bank is off until enabled. When it is on, approved workday or rest-day overtime can enter the comp-time pool. Statutory-holiday overtime does not enter that pool. A cycle cap of 0 means no cap. Exceeding a positive cap fails with OVERTIME_BANK_CAP_EXCEEDED. Comp time is then spent by a comp_time leave.', '加班银行默认关闭。打开后，已通过的工作日或休息日加班可以进入调休池。法定节假日加班不进入该池。周期上限填 0 表示不限。超过正数上限会失败，代码 OVERTIME_BANK_CAP_EXCEEDED。之后用编码 comp_time 的请假消耗调休。'],
      },
    ],
    faqs: [{
      q: ['The overtime was rounded up. Is that a mistake?', '加班分钟被向上取整了，是算错了吗？'],
      a: ['The selected rule’s rounding minutes round up. A value below the minimum is raised to the minimum, and a value above the daily maximum is cut to that maximum.', '取整来自所选规则的取整分钟，方向是向上。低于最小值会抬到最小值，高于每日上限会截到该上限。'],
    }, {
      q: ['Can one request cover Friday night through Monday?', '一条申请可以从周五晚上覆盖到周一吗？'],
      a: ['A window may cross one local midnight. More than one midnight is rejected.', '时间窗可以跨一个当地午夜。超过一个午夜会被拒绝。'],
    }],
  },
  {
    id: 'swap',
    labelEn: 'Shift swap',
    labelZh: '换班',
    intro: [[
      'Read this in admin Attendance help. Employees open Shift swap from Common on the overview.',
      '在管理端「考勤帮助」里阅读本篇。员工在总览的「常用」里打开换班。',
    ], [
      'Shift swap request asks for My published shift, the other person’s published shift, and an optional reason. The first version accepts a published, active, regular, single-day assignment with no producer mark. The other row must belong to a different person. The page says 「首版换班仅支持已发布的单日常规排班。」',
      '换班申请选择「我的已发布班次」、对方的已发布班次，原因可选。首版接受已发布、生效中、常规、单日、且没有生产者标记的排班。对方必须是另一个人。页面写明「首版换班仅支持已发布的单日常规排班。」',
    ]],
    scenarios: [[
      'Two employees exchange a published one-day shift, and an approver confirms the exchange after the other person agrees.',
      '两名员工对调一天已发布的班次，对方先同意，审批人再确认。',
    ]],
    steps: [
      {
        path: ['Overview → Common → Shift swap', '总览 → 常用 → 换班'],
        detail: ['Submit creates a pending request and a pending counterparty decision. The other person, and only that person, can Agree or Decline. The requester can Cancel while it is pending. Shift swap is submitted on its own route, not as a generic request type.', '提交后申请为待处理，对方确认为待处理。只有对方可以同意换班或拒绝换班。发起人在待处理时可以取消。换班走专用提交，不走通用申请类型。'],
      },
      {
        path: ['After the other person agrees → approval', '对方同意之后 → 审批'],
        detail: ['Final approval deactivates both original assignments and writes a replacement assignment for each person with the shifts exchanged. A specified approval flow that is missing or inactive returns SHIFT_SWAP_APPROVAL_FLOW_REQUIRED. Finalizing before counterparty consent returns SHIFT_SWAP_COUNTERPARTY_CONSENT_REQUIRED.', '最终审批会停用双方原来的排班，并为每人写入一条对调后的替换排班。指定的审批流不存在或未启用时返回 SHIFT_SWAP_APPROVAL_FLOW_REQUIRED。对方尚未同意就终结会返回 SHIFT_SWAP_COUNTERPARTY_CONSENT_REQUIRED。'],
      },
    ],
    faqs: [{
      q: ['Why is my shift missing from the list?', '为什么列表里没有我的班次？'],
      a: ['The list keeps published, active, regular, single-day rows with no producer mark. Drafts, multi-day rows, temporary replacements, and rows produced by a fixed schedule or rotation stay out.', '列表保留已发布、生效中、常规、单日、且没有生产者标记的行。草稿、多日、临时替班，以及固定排班或轮班产生的行不在其中。'],
    }, {
      q: ['Can I swap with myself or with two shifts on the same day?', '可以和自己换，或一次换同一天的两个班吗？'],
      a: ['The two assignments must be different people. The page offers one published shift on each side.', '两条排班必须属于不同的人。页面两侧各选一条已发布班次。'],
    }],
  },
  {
    id: 'records',
    labelEn: 'Records and requests',
    labelZh: '查看记录',
    intro: [[
      'Read this in admin Attendance help. Employees read today, requests, and balances on the overview.',
      '在管理端「考勤帮助」里阅读本篇。员工在总览查看今日、申请和余额。',
    ], [
      'My requests on the overview is the signed-in person’s own attendance requests: counts for pending, approved, and rejected, plus a few recent rows. It is not the organization queue of requests waiting for the viewer. Anomalies are the days that need a follow-up, with a way to start a makeup request. Records are the calculated daily results.',
      '总览上的「我的申请」是当前登录人自己的考勤申请：待处理、已通过、已驳回的计数，以及最近几条。它不是全组织待该查看人审批的队列。异常是需要跟进的日期，可以从这里发起补卡。记录是已经算出的每日结果。',
    ]],
    scenarios: [[
      'An employee checks today’s status, a balance, or an old request. An administrator opens Reports to read or export a period, including another person when permission allows.',
      '员工查看今日状态、余额或历史申请。管理员打开报表阅读或导出一个区间；权限允许时也可以看其他人。',
    ]],
    steps: [
      {
        path: ['Overview → today, My requests, Common', '总览 → 今日、我的申请、常用'],
        detail: ['Today shows in, out, duration, and late or early. My annual leave and My comp time read the caller’s own balance. Open basis (decision trace) is a read-only explanation of a flagged day. Status words are pending, approved, rejected, and cancelled.', '今日显示上班、下班、时长，以及迟到或早退。「我的年假」和「我的调休」读取调用人自己的余额。「查看依据（决策轨迹）」是某一天被标记原因的只读说明。状态词是待处理、已通过、已驳回、已取消。'],
      },
      {
        path: ['Reports → date range → reload', '报表 → 日期区间 → 重载'],
        detail: ['Reports is open to people with attendance:read. An empty user filter is the signed-in person. Another person’s rows need attendance:approve, attendance:admin, or a scheduler scope that includes export for that person. Change the dates and reload before export; a stale filter blocks the file.', '报表对拥有 attendance:read 的人开放。用户筛选留空就是当前登录人。看其他人需要 attendance:approve、attendance:admin，或一条覆盖该人的排班导出范围。改了日期要先重载再导出；筛选过期时导出会被拦住。'],
      },
    ],
    faqs: [{
      q: ['I am an approver. Why is there no Approve button on My requests?', '我是审批人，为什么「我的申请」里没有批准？'],
      a: ['That list is the signed-in person’s own requests. Approve and reject appear for a pending row that belongs to someone else, from the queue the approver is allowed to open.', '该列表是登录人自己的申请。批准和驳回出现在他人的待处理行上，入口是审批人有权打开的队列。'],
    }, {
      q: ['Where is the annual-leave balance the employee sees?', '员工看到的年假余额在哪里？'],
      a: ['On the overview, My annual leave reads the caller’s own balance. Administrators use Annual leave balance to look up a person. The engine has to be enabled before operations can change lots.', '在总览，「我的年假」读取本人余额。管理员在年假余额里查询某人。要改额度，先在年假策略里启用引擎。'],
    }],
  },
  {
    id: 'shifts',
    labelEn: 'Shifts',
    labelZh: '班次',
    sectionId: 'attendance-admin-shifts',
    intro: [[
      'A shift is the clock definition: name, timezone, one or more time segments, late grace, early grace, and rounding. A single segment is the work window used by schedules. Extra segments show planned minutes and unpaid gap minutes; the gap between segments is not planned time. At most one segment may cross midnight. Creating and editing shifts requires attendance:admin.',
      '班次是上下班的定义：名称、时区、一段或多段时间、迟到宽限、早退宽限和取整。单段就是排班使用的上下班窗口。多段会显示计薪分钟和非计薪间隔；段与段之间不计入计划工时。最多一段可以跨午夜。新建和修改班次需要 attendance:admin。',
    ]],
    scenarios: [[
      'Define the hours before a fixed schedule, a shift assignment, or a rotation can point at them.',
      '在固定排班、排班分配或轮班引用之前，先把上下班时间定义好。',
    ]],
    steps: [
      {
        path: ['Admin → Shifts → save', '管理 → 班次 → 保存'],
        detail: ['Set the timezone with a place name, an IANA id, or an offset, then save. The stored value is the IANA id. Late grace and early grace are minutes on this shift. Severe-late and absence-level-late thresholds are not fields on the shift; report tiers use the built-in 30 and 60 minutes. If the segment editor says 「仅供预览」, the shift can be saved, and it cannot be assigned, rotated, swapped, dispatched, or published until authoritative segment calculation is enabled. Flex settings appear when the editor says the shift is flex-eligible.', '用地名、IANA 标识或偏移设置时区后保存。存下的是 IANA 标识。迟到宽限和早退宽限是这个班次上的分钟。严重迟到和旷工迟到阈值不是班次上的字段；报表分档使用内置的 30 分钟和 60 分钟。时段编辑器若显示「仅供预览」，班次可以保存，但在权威分段核算启用前不能用于分配、轮班、换班、调度或发布。编辑器显示可配置弹性时，才出现弹性设置。'],
      },
      {
        path: ['Attach the shift by scheduling, not by the shift row alone', '班次行本身不会自动套到人'],
        detail: ['Fixed shift applies the shift from the group fixed-schedule action. Scheduled shift uses a shift assignment or a rotation whose rule lists shift ids. A person with neither still punches against the default rule.', '固定班制从考勤组的固定排班动作把班次套到人。排班制使用排班分配，或使用列出班次序列的轮班规则。两者都没有的人，打卡仍按默认规则。'],
      },
    ],
    faqs: [{
      q: ['I changed the shift timezone. Which punches move?', '我改了班次时区，哪些打卡会变？'],
      a: ['Later calculations use the shift timezone. A group timezone change does not retime an existing shift. Historical rows keep the context they already froze.', '之后的计算使用班次时区。改考勤组时区不会重算已有班次。历史记录保留已经冻结的上下文。'],
    }],
  },
  {
    id: 'assignments',
    labelEn: 'Schedules',
    labelZh: '排班',
    sectionId: 'attendance-admin-assignments',
    intro: [[
      'A shift assignment is a person, a shift, a date range, and a slot. Status moves from draft to pending to published. Save draft and Update draft do not publish. Preflight checks the selected drafts. Publish selected drafts locks the published rows. The same draft and publish flow exists for rotation assignments.',
      '排班分配是一个人、一个班次、一段日期和一个槽位。状态从草稿到待发布，再到已发布。保存草稿和更新草稿不会发布。预检选中草稿只做检查。发布选中草稿会锁定已发布的行。轮班分配走同一套草稿和发布。',
    ], [
      'A temporary shift is a one-day replacement draft against an already published assignment. Publish that draft to make the replacement active. A direct immediate temporary assignment is rejected. Advanced scheduling is a read-only snapshot of published rows, coverage, and conflicts. Comprehensive hours is a read-only comparison of planned or actual minutes against a cap; it does not save and does not block a schedule save.',
      '临时替班是针对一条已发布分配的单日替换草稿。发布该草稿后替换才生效。直接写成立即生效的临时分配会被拒绝。高级排班是已发布排班、覆盖和冲突的只读快照。综合工时是计划工时或实际工时与上限的只读对比；它不保存，也不拦住排班保存。',
    ]],
    scenarios: [[
      'Publish who works which shift, replace one day, or preview a fixed weekly pattern before applying it.',
      '发布谁上哪个班，替换其中一天，或在应用前预览固定班的一周模式。',
    ]],
    steps: [
      {
        path: ['Fixed shift group → preview, then apply', '固定班制考勤组 → 先预览，再应用'],
        detail: ['Preview does not write assignments. A group owner or sub-owner may preview. Apply, rebuild, and clear need a scheduler scope of dispatch, and rebuild also needs clear, unless the caller is an attendance administrator. The status words are not configured, pending apply, in effect, and configuration changed.', '预览不写排班。考勤组负责人或子负责人可以预览。应用、重建和清除需要排班范围里的「调度」；重建还要「清空」。考勤管理员不受此限。状态词是未配置、待应用、生效中、配置已变更。'],
      },
      {
        path: ['Shift assignments and rotation assignments', '排班分配和轮班分配'],
        detail: ['Filter drafts or published rows. A rotation rule is a name, a timezone, an ordered list of shift ids, and an enabled flag. A rotation assignment binds a person, a rule, and a date range. Writing these rows needs dispatch scope over the person’s schedule group, and it also follows the shift edit window.', '按草稿或已发布筛选。轮班规则包含名称、时区、有序的班次和启用开关。轮班分配把一个人、一条规则和一段日期绑在一起。写入这些行需要对该人所在排班组具备「调度」，并且还要落在排班编辑窗口内。'],
      },
      {
        path: ['Settings → Shift compliance and Multi-shift day', '设置 → 排班合规，以及一天多班次'],
        detail: ['Block on save with a filled daily, weekly, or monthly cap rolls the save back when explicit scheduled minutes exceed it. The cap counts days covered by a shift or rotation assignment. Days that only fall back to the default rule are not counted. Warn does not block. Multi-shift day is off until saved. The maximum slots field accepts 1–3. Attendance results still summarize the day’s punches.', '「保存时阻断」并且填写了每日、每周或每月上限时，显式排班分钟超出上限会回滚这次保存。上限统计的是班次或轮班覆盖到的日期。只回落到默认规则的日期不计入。「预警」不拦截。一天多班次在保存打开之前是关闭的。每日最多槽位可填 1–3。出勤结果仍按当日打卡汇总。'],
      },
    ],
    callout: [
      'Schedule dispatch is a separate approval request: one employee, whole days, a target schedule group. Hourly support and cost allocation are not in this version.',
      '调度申请是另一种审批：一名员工、按整天、调到目标排班组。这一版不含小时支援和成本分摊。',
    ],
    faqs: [{
      q: ['Publish failed with SHIFT_COMPLIANCE_CAP_EXCEEDED.', '发布失败，代码是 SHIFT_COMPLIANCE_CAP_EXCEEDED。'],
      a: ['The explicit scheduled minutes exceed a cap whose enforcement is Block on save. Raise the cap, clear it, or shorten the schedule, then publish again.', '显式排班分钟超过了「保存时阻断」下的上限。提高上限、清空上限，或缩短这段排班，然后再发布。'],
    }, {
      q: ['The workbench looks empty of drafts.', '高级排班里看不到草稿。'],
      a: ['The workbench snapshot includes published assignments. Drafts stay on Shift assignments until they are published.', '工作台快照包含已发布的排班。草稿留在排班分配里，发布之后才会出现在快照中。'],
    }],
  },
  {
    id: 'scopes',
    labelEn: 'Scheduler scope',
    labelZh: '排班管理范围',
    sectionId: 'attendance-admin-scheduler-scopes',
    intro: [[
      'Scheduler scope grants a person, a role, or a role tag a set of actions inside a target. It is separate from attendance-group owner. Owners maintain their group’s member list. Schedulers receive view, edit, import, export, clear, approve, dispatch, or remind on selected targets. Creating or editing a scope itself requires attendance:admin.',
      '排班管理范围把一组动作授给一名员工、一个角色或一个角色标签，并限定目标。它和考勤组负责人是两件事。负责人维护本组考勤人员。排班范围授予查看、编辑、导入、导出、清空、审批、调度或提醒，并限定在选中的目标上。新建或修改范围本身需要 attendance:admin。',
    ]],
    scenarios: [[
      'A team leader should publish schedules for one schedule group without becoming an attendance administrator.',
      '组长只需为某一个排班组发布排班，而不成为考勤管理员。',
    ]],
    steps: [
      {
        path: ['Scheduler scope management → New scope', '排班管理范围 → 新建范围'],
        detail: ['Choose the subject type: Employee, Role, or Role tag. Add at least one target: department, attendance group, schedule group, employee, role, or role tag. Check the actions. A scope with no target is refused. Full attendance administrators are not limited by these rows.', '选择主体类型：员工、角色或角色标签。至少添加一个目标：部门、考勤组、排班组、员工、角色或角色标签。勾选动作。没有任何目标的范围会被拒绝。考勤管理员不受这些行限制。'],
      },
      {
        path: ['Which action covers which job', '哪个动作对应哪类操作'],
        detail: ['Dispatch covers shift assignments, rotation assignments, publish, schedule-group membership, and fixed-schedule apply. Edit covers schedule-group details. Rebuild of a fixed schedule also needs clear. View filters the assignment list. Export can widen whose report rows a person may download. A missing match returns SCHEDULER_SCOPE_FORBIDDEN.', '调度覆盖排班分配、轮班分配、发布、排班组成员，以及固定排班的应用。编辑覆盖排班组资料。重建固定排班还要清空。查看用来过滤排班列表。导出可以放宽一个人能下载哪些人的报表。没有匹配的有效范围时返回 SCHEDULER_SCOPE_FORBIDDEN。'],
      },
    ],
    callout: [
      'Async import jobs, batches, rollback, templates, and uploads stay on attendance:import or attendance:admin. Scheduler import scope covers the sync import path that checks the scope.',
      '异步导入任务、批次、回滚、模板和上传仍使用 attendance:import 或 attendance:admin。排班范围里的导入作用于会检查该范围的同步导入路径。',
    ],
    faqs: [{
      q: ['I am a group owner. Why can I not publish the schedule?', '我是考勤组负责人，为什么不能发布排班？'],
      a: ['Owner and sub-owner can add or remove members and can preview a fixed schedule. Publishing assignments needs dispatch scope or attendance:admin.', '负责人和子负责人可以增删考勤人员，也可以预览固定排班。发布排班需要「调度」范围或 attendance:admin。'],
    }],
    figureTitle: ['Scope pieces', '一条范围里有什么'],
    figureRows: [
      ['Subject', '主体'],
      ['Targets', '目标'],
      ['Actions', '动作'],
    ],
  },
  {
    id: 'leave-types',
    labelEn: 'Leave types',
    labelZh: '请假类型',
    sectionId: 'attendance-admin-leave-types',
    intro: [[
      'A leave type is the choice employees see on Leave request. Fields are code, name, minutes per day, requires attachment, and enabled. Code may be left blank; save generates a leave_ prefix. Name is required. Minutes per day default to 480, which is the length used when a request omits a duration and the length used to convert annual leave. Requires approval is shown as 「暂不生效」 and does not skip approval.',
      '请假类型是员工在请假申请里看到的选项。字段有编码、名称、每日分钟数、需要附件和启用。编码可以留空，保存时生成 leave_ 前缀。名称必填。每日分钟数默认 480，申请没填时长时用它，年假折算也用它。「需要审批」显示为「暂不生效」，不会因此免审。',
    ]],
    scenarios: [[
      'Add annual leave, personal leave, or comp time before employees can select them. Comp time uses the code comp_time. Annual deduction uses the code annual.',
      '员工要能选到年假、事假或调休之前，先建类型。调休扣减使用编码 comp_time。年假扣减使用编码 annual。',
    ]],
    steps: [
      {
        path: ['Admin → Leave types → Create or update', '管理 → 请假类型 → 创建或更新'],
        detail: ['Save an active type. The list columns are code, name, approval (not in effect), attachment, minutes, enabled, and edit or delete. The paid flag exists on the stored row and is not a field on this form.', '保存一个启用的类型。列表列是编码、名称、审批(暂不生效)、附件、分钟、启用，以及编辑或删除。是否带薪存在于保存的记录上，这张表单没有该字段。'],
      },
    ],
    faqs: [{
      q: ['Employees say the leave type list is empty.', '员工说假期类型是空的。'],
      a: ['Create at least one enabled leave type. Disabled types stay out of the employee selector.', '至少创建一个启用的请假类型。停用的类型不会出现在员工的选择器里。'],
    }],
  },
  {
    id: 'overtime-rules',
    labelEn: 'Overtime rules',
    labelZh: '加班规则',
    sectionId: 'attendance-admin-overtime-rules',
    intro: [[
      'An overtime rule supplies the minimum minutes, the rounding minutes, and the daily maximum used when an overtime request is saved. Defaults on a new mapped rule are minimum 0, rounding 15, and daily maximum 600. Requires approval is stored and marked 「暂不生效」. The request remains pending.',
      '加班规则提供加班申请保存时使用的最小分钟、取整分钟和每日上限。新建映射规则的默认值是最小 0、取整 15、每日上限 600。「需要审批」会被保存并标为「暂不生效」。申请仍然是待处理。',
    ]],
    scenarios: [[
      'Different teams need different minimums or daily caps. Each overtime request picks one active rule.',
      '不同团队需要不同的最小值或每日上限。每条加班申请选择一条启用的规则。',
    ]],
    steps: [
      {
        path: ['Admin → Overtime rules → save', '管理 → 加班规则 → 保存'],
        detail: ['Name the rule, set minimum, rounding, and daily maximum, and leave it enabled. Employees cannot submit overtime until at least one active rule exists.', '填写名称、最小分钟、取整和每日上限，并保持启用。至少有一条启用规则之后，员工才能提交加班。'],
      },
    ],
    faqs: [{
      q: ['Where do the three overtime durations come from?', '三类加班时长从哪里来？'],
      a: ['They are report fields filled from the segmentation snapshot on the overtime request. The rule on this page supplies the minimum, the rounding, and the daily cap used before that snapshot.', '它们是报表字段，来自加班申请上的分段快照。本页的规则提供写入快照前使用的最小值、取整和每日上限。'],
    }],
  },
  {
    id: 'approvals',
    labelEn: 'Approval flows',
    labelZh: '审批流',
    sectionId: 'attendance-admin-approval-flows',
    intro: [[
      'An approval flow is a name, a request type, an enabled flag, and ordered steps. Request types are missed check-in, missed check-out, time correction, leave, business trip, overtime, outdoor punch, shift swap, and schedule dispatch. A new attendance request is stored as pending. When no flow id is chosen, the newest enabled flow for that request type is used.',
      '审批流包含名称、申请类型、启用开关和有序步骤。申请类型有漏打上班卡、漏打下班卡、时间更正、请假、出差、加班、外勤打卡、换班和调度。新的考勤申请保存为待处理。未指定流程时，使用该申请类型下最新一条启用的流程。',
    ]],
    scenarios: [[
      'Route leave to a manager, makeup punches to an attendance approver, or shift swap through the other person and then an approver.',
      '把请假交给上级，把补卡交给考勤审批人，或让换班先经过对方再进入审批。',
    ]],
    steps: [
      {
        path: ['Admin → Approval flows → steps', '管理 → 审批流 → 审批步骤'],
        detail: ['Each step has a name and an approver source: a named person, the direct manager, the department head, or a manager at a chosen level. Add approver users or role ids for a static step. The page warns 「未配置任何步骤——该类型申请可能自动通过。」 when there are no steps. A static step with no approver is assigned to the admin role and to the queues for attendance:approve and attendance:admin. The requester does not approve their own request by that fallback.', '每一级有名称和审批人来源：指定审批人、直属上级、部门主管或指定层级上级。静态步骤添加审批人用户或审批角色。没有任何步骤时，页面警告「未配置任何步骤——该类型申请可能自动通过。」。静态步骤没有审批人时，会分给管理员角色，以及 attendance:approve 和 attendance:admin 的队列。该兜底不会让申请人批准自己的申请。'],
      },
      {
        path: ['Dynamic steps fail closed', '动态步骤解析失败会停住'],
        detail: ['Direct manager, department head, and manager-at-level read the snapshot taken when the request is created. If the person is missing, or the resolved person is the requester, the result is APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED and the request is blocked. That path does not fall back to the administrator queue.', '直属上级、部门主管和指定层级上级读取申请创建时冻结的快照。找不到人，或解析到的人就是申请人本人时，结果是 APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED，申请被阻断。这条路径不会改派到管理员队列。'],
      },
    ],
    faqs: [{
      q: ['The warning says the request may auto-pass. Does an empty flow approve itself?', '警告说可能自动通过。空流程会自己批准吗？'],
      a: ['The request is stored as pending. A static step with nobody named goes to the administrator approval queue. Dynamic steps that cannot be resolved are rejected instead.', '申请保存为待处理。静态步骤没有点名的人时，进入管理员审批队列。解析不了的动态步骤会被拒绝。'],
    }, {
      q: ['Who sees Approve on the employee overview?', '员工总览上谁能看到批准？'],
      a: ['A pending row can be approved when it belongs to someone other than the signed-in user and the viewer has the approval access for that row. My requests lists the viewer’s own rows.', '待处理的行在所属用户不是当前登录人、且查看人具备该行的审批权限时可以批准。「我的申请」列出的是查看人自己的行。'],
    }],
  },
  {
    id: 'permissions',
    labelEn: 'Permissions',
    labelZh: '权限说明',
    sectionId: 'attendance-admin-user-access',
    intro: [[
      'Attendance uses five permission keys. attendance:read views records, rules, one’s own balances, and reports. attendance:write punches and files or cancels one’s own requests. attendance:approve approves and can read other people’s records. attendance:import runs import and batches. attendance:admin manages settings, shifts, groups, rules, report fields, and annual-leave operations. A platform administrator bypasses these checks.',
      '考勤使用五类权限。attendance:read 查看记录、规则、本人余额和报表。attendance:write 打卡，以及提交或取消自己的申请。attendance:approve 审批，并可以查看他人记录。attendance:import 执行导入和批次。attendance:admin 管理设置、班次、考勤组、规则、统计字段和年假操作。平台管理员绕过这些检查。',
    ]],
    scenarios: [[
      'Grant an employee the ability to punch, an approver the ability to decide requests, or an administrator the settings pages.',
      '让员工可以打卡，让审批人可以处理申请，或让管理员进入设置页面。',
    ]],
    steps: [
      {
        path: ['Admin → User access', '管理 → 用户权限'],
        detail: ['Search by email, name, or id, select the person, and assign a role template. Employee is read plus write. Approver is read plus approve. Administrator is read, write, approve, and admin. Remove role takes the template back. Batch provisioning applies the same templates to many people.', '按邮箱、姓名或 ID 搜索，选中人员，再分配角色模板。员工是读加写。审批人是读加审批。管理员是读、写、审批和管理。移除角色收回该模板。批量授权用同一套模板处理多人。'],
      },
      {
        path: ['Group owners and scheduler scopes sit beside these keys', '考勤组负责人和排班范围在这些权限旁边'],
        detail: ['Owner and sub-owner can view the group, list members and managers, add or remove members, view team availability, and preview a fixed schedule. They do not edit organization settings or the owner list. Scheduler scopes add view, edit, import, export, clear, approve, dispatch, and remind inside their targets. Employee common icons are saved only from Settings.', '负责人和子负责人可以查看本组、列出成员和负责人、增删成员、查看团队可用性，以及预览固定排班。他们不修改组织设置，也不修改负责人名单。排班范围在其目标内增加查看、编辑、导入、导出、清空、审批、调度和提醒。员工常用图标只从设置页保存。'],
      },
    ],
    faqs: [{
      q: ['The page says admin permissions are required.', '页面提示需要管理员权限。'],
      a: ['That is the admin workspace gate. The overview and reports remain available with attendance:read, and punch requires attendance:write.', '这是管理工作区的门。总览和报表在具备 attendance:read 时仍可使用，打卡需要 attendance:write。'],
    }, {
      q: ['Import fails with FORBIDDEN even though I can edit a group.', '我能改考勤组，导入却是 FORBIDDEN。'],
      a: ['Group ownership does not include import. Import needs attendance:import or attendance:admin. A scheduler import scope applies only where that sync path checks scopes.', '考勤组负责人身份不包含导入。导入需要 attendance:import 或 attendance:admin。排班范围里的导入只在会检查该范围的同步路径上生效。'],
    }],
    figureTitle: ['Role templates', '角色模板'],
    figureRows: [
      ['Employee: read + write', '员工：读 + 写'],
      ['Approver: read + approve', '审批人：读 + 审批'],
      ['Administrator: read + write + approve + admin', '管理员：读 + 写 + 审批 + 管理'],
    ],
  },
  {
    id: 'errors',
    labelEn: 'Status codes',
    labelZh: '错误码与提示',
    intro: [[
      'Each row is code, then when it appears, then what to do. The status line shows 代码 when the server sent one. This article is in admin Attendance help.',
      '每一行是代码、出现时机、然后怎么处理。服务器返回代码时，状态条显示「代码」。本篇在管理端「考勤帮助」里。',
    ]],
    scenarios: [[
      'Open it when a save, punch, or request stops and names a code.',
      '保存、打卡或申请停住，并写出代码时，打开本篇。',
    ]],
    steps: [
      {
        path: ['USER_NOT_IN_ORG', 'USER_NOT_IN_ORG'],
        detail: ['Appears on a roster write or annual-leave adjustment when the target is not an active member. HTTP 404. The sentence is 「该用户不是本组织的有效成员。」. Do: pick an active member of this organization. A punch that names the wrong organization uses ATTENDANCE_PUNCH_ORG_NOT_PERMITTED.', '出现：名单写入或年假调整，目标不是本组织有效成员。HTTP 404。句子是「该用户不是本组织的有效成员。」。处理：改选本组织的有效成员。打卡写错组织用 ATTENDANCE_PUNCH_ORG_NOT_PERMITTED。'],
      },
      {
        path: ['ATTENDANCE_PUNCH_ORG_NOT_PERMITTED', 'ATTENDANCE_PUNCH_ORG_NOT_PERMITTED'],
        detail: ['Appears on punch when the named organization is not one of the caller’s active memberships. HTTP 403. Do: punch without a foreign organization id, or sign in to an organization you belong to.', '出现：打卡请求写明的组织不是调用人的有效成员组织。HTTP 403。处理：不要带上别人的组织；或登录到自己所属的组织再打卡。'],
      },
      {
        path: ['PUNCH_CLIENT_TIMESTAMP_FORBIDDEN', 'PUNCH_CLIENT_TIMESTAMP_FORBIDDEN'],
        detail: ['Appears when the punch body includes a client time. HTTP 400. Do: send only the event type. The server records the time. Use Makeup punch to correct a past day.', '出现：打卡请求自带了发生时间。HTTP 400。处理：只提交打卡类型。时间由服务器记录。要改过去某一天，走补卡。'],
      },
      {
        path: ['PUNCH_TOO_SOON', 'PUNCH_TOO_SOON'],
        detail: ['Appears when the same event type repeats inside Min punch interval. HTTP 429. Do: wait. Check-in then check-out is not limited by that interval. Change the minutes under Settings → Punch and geofence.', '出现：同一类打卡落在「最小打卡间隔（分钟）」内。HTTP 429。处理：等过间隔再打。先上班再下班不受这个间隔限制。间隔在「设置 → 打卡与围栏」里改。'],
      },
      {
        path: ['IP_RESTRICTED', 'IP_RESTRICTED'],
        detail: ['Appears when IP allowlist is non-empty and the client address is absent from it. HTTP 403. Do: punch from an allowed address, or an administrator edits IP allowlist and clicks Save settings.', '出现：IP 白名单非空，且当前地址不在名单里。HTTP 403。处理：从允许的地址打卡，或由管理员修改「IP 白名单」后点「保存设置」。'],
      },
      {
        path: ['LOCATION_RESTRICTED', 'LOCATION_RESTRICTED'],
        detail: ['Appears when a geofence is set, outdoor approval is off, and the punch has no in-fence location. The overview punch does not send a location, so it is treated as outside. HTTP 403. The sentence says the location is outside the allowed range. Do: clear the fence, or turn on Require approval for outdoor punches.', '出现：已设地理围栏、外勤审批关闭，且这次打卡没有围栏内定位。总览打卡不传定位，因此按围栏外处理。HTTP 403。句子会说当前位置在允许范围外。处理：清空围栏，或勾选「外勤打卡需审批」。'],
      },
      {
        path: ['OUTDOOR_NOTE_REQUIRED', 'OUTDOOR_NOTE_REQUIRED'],
        detail: ['Appears when outdoor approval requires a note and the punch has none. HTTP 422. Do: fill Outdoor punch note and click Retry punch with note.', '出现：外勤审批要求备注，而这次打卡没有备注。HTTP 422。处理：填写「外勤打卡备注」，再点「补充备注后重试打卡」。'],
      },
      {
        path: ['PUNCH_UNSCHEDULED_BLOCKED', 'PUNCH_UNSCHEDULED_BLOCKED'],
        detail: ['Appears when unscheduled punching is set to block and that work date has no schedule. HTTP 422. Do: publish a schedule for that day, or an administrator sets the policy back to allow.', '出现：未排班策略为拦截，且该工作日没有排班。HTTP 422。处理：为这一天发布排班，或由管理员把策略改回允许。'],
      },
      {
        path: ['ATTENDANCE_PUNCH_ORDER_CONFLICT', 'ATTENDANCE_PUNCH_ORDER_CONFLICT'],
        detail: ['Appears when check-out is recorded before check-in on the same work date. HTTP 409. Do: Check In first, then Check Out.', '出现：同一工作日先记下了下班、还没有上班。HTTP 409。处理：先点「上班打卡」，再点「下班打卡」。'],
      },
      {
        path: ['MAKEUP_PUNCH_QUOTA_EXCEEDED', 'MAKEUP_PUNCH_QUOTA_EXCEEDED'],
        detail: ['Appears when makeup enforcement is on and this cycle has no remaining count. HTTP 422. The sentence is 「本周期的补卡次数已用完。」. Do: wait for the next calendar month, cancel a pending request that counts, or raise Requests per cycle.', '出现：补卡强约束已开，且本周期次数用完。HTTP 422。句子是「本周期的补卡次数已用完。」。处理：等到下个自然月，或取消一条计入额度的待处理申请，或提高「每周期补卡次数」。'],
      },
      {
        path: ['MAKEUP_PUNCH_WINDOW_EXPIRED', 'MAKEUP_PUNCH_WINDOW_EXPIRED'],
        detail: ['Appears when the work date is outside the calendar-day submit window. HTTP 422. The sentence is 「该工作日期不在允许的补卡时间窗口内。」. Do: pick a date inside Submit window, or an administrator changes that field.', '出现：工作日期超出「提交时限（自然日）」。HTTP 422。句子是「该工作日期不在允许的补卡时间窗口内。」。处理：改选时限内的日期，或由管理员改这个字段。'],
      },
      {
        path: ['MAKEUP_PUNCH_FUTURE_DATE_UNSUPPORTED', 'MAKEUP_PUNCH_FUTURE_DATE_UNSUPPORTED'],
        detail: ['Appears when the makeup work date is in the future. HTTP 422. The sentence is 「未来的工作日期无法提交补卡。」. Do: choose today or an earlier work date.', '出现：补卡的工作日期在未来。HTTP 422。句子是「未来的工作日期无法提交补卡。」。处理：改选今天或更早的工作日期。'],
      },
      {
        path: ['MAKEUP_PUNCH_TYPE_NOT_ALLOWED', 'MAKEUP_PUNCH_TYPE_NOT_ALLOWED'],
        detail: ['Appears when the date and request type do not match Allowed anomaly types. HTTP 422. The sentence is 「所选日期/类型不符合当前补卡策略。」. A whole-day absence is not makeup-eligible. Do: change the type or date, or an administrator edits the anomaly checkboxes.', '出现：该日期和申请类型对不上「可补异常类型」。HTTP 422。句子是「所选日期/类型不符合当前补卡策略。」。整日旷工不能补。处理：改类型或日期，或由管理员改异常勾选。'],
      },
      {
        path: ['MAKEUP_PUNCH_REASON_REQUIRED', 'MAKEUP_PUNCH_REASON_REQUIRED'],
        detail: ['Appears when Require reason is on and the reason is empty. HTTP 422. The sentence is 「补卡策略要求填写原因。」. Do: fill the reason and submit again.', '出现：已勾选「要求填写原因」，原因为空。HTTP 422。句子是「补卡策略要求填写原因。」。处理：填写原因后再提交。'],
      },
      {
        path: ['MAKEUP_PUNCH_ATTACHMENT_REQUIRED', 'MAKEUP_PUNCH_ATTACHMENT_REQUIRED'],
        detail: ['Appears when Require attachment URL is on and the URL is empty. HTTP 422. The sentence is 「补卡策略要求上传附件。」. Do: fill the attachment URL and submit again.', '出现：已勾选「要求附件链接」，链接为空。HTTP 422。句子是「补卡策略要求上传附件。」。处理：填写附件链接后再提交。'],
      },
      {
        path: ['MAKEUP_PUNCH_CROSS_USER_FORBIDDEN', 'MAKEUP_PUNCH_CROSS_USER_FORBIDDEN'],
        detail: ['Appears when someone edits a makeup request for another person. HTTP 422. The sentence is 「v1 不支持为他人编辑补卡申请。」. Do: the employee submits their own request.', '出现：替他人编辑补卡申请。HTTP 422。句子是「v1 不支持为他人编辑补卡申请。」。处理：由该员工自己提交。'],
      },
      {
        path: ['DUPLICATE_REQUEST', 'DUPLICATE_REQUEST'],
        detail: ['Appears when the same person, work date, and request type already has a pending or approved row. HTTP 409. Do: cancel the pending row, or wait until it is rejected. This check does not compare clock times.', '出现：同一人、同一工作日、同一申请类型已有待处理或已通过。HTTP 409。处理：取消那条待处理，或等它被驳回。这项检查不比较钟点是否重叠。'],
      },
      {
        path: ['ANNUAL_LEAVE_NOT_ENABLED', 'ANNUAL_LEAVE_NOT_ENABLED'],
        detail: ['Appears on annual-leave adjust, backfill, or accrual while the engine is off. HTTP 422. The sentence says to enable it under Annual leave policy. Do: open Annual leave policy, turn on Enabled, set a timezone, and save.', '出现：年假引擎关闭时做调整、回填或发放。HTTP 422。句子会要求先在「年假策略」启用。处理：打开「年假策略」，勾选启用，填写时区，再保存。'],
      },
      {
        path: ['ANNUAL_LEAVE_TIMEZONE_REQUIRED', 'ANNUAL_LEAVE_TIMEZONE_REQUIRED'],
        detail: ['Appears when the enabled annual-leave policy has no timezone. HTTP 422. The sentence is 「策略缺少时区。」. Do: pick a timezone on Annual leave policy and save.', '出现：年假策略已启用但没有时区。HTTP 422。句子是「策略缺少时区。」。处理：在「年假策略」选择时区并保存。'],
      },
      {
        path: ['ANNUAL_LEAVE_TIMEZONE_INVALID', 'ANNUAL_LEAVE_TIMEZONE_INVALID'],
        detail: ['Appears when the policy timezone is not a valid IANA id. HTTP 422. The sentence is 「策略时区不是有效的 IANA 时区。」. Do: pick a suggestion from the timezone field and save again.', '出现：策略时区不是合法的 IANA 标识。HTTP 422。句子是「策略时区不是有效的 IANA 时区。」。处理：从时区框的建议里重选一条再保存。'],
      },
      {
        path: ['ANNUAL_LEAVE_BALANCE_INSUFFICIENT', 'ANNUAL_LEAVE_BALANCE_INSUFFICIENT'],
        detail: ['Appears when a negative adjustment or an approved annual-leave request exceeds active lots. HTTP 422. The sentence says the balance is short. Do: reduce the amount, or grant more balance before approving.', '出现：负数调整或批准年假时，超过可用额度。HTTP 422。句子会说余额不足。处理：减小数值，或先发放额度再批准。'],
      },
      {
        path: ['ANNUAL_LEAVE_MULTI_DAY_UNSUPPORTED', 'ANNUAL_LEAVE_MULTI_DAY_UNSUPPORTED'],
        detail: ['Appears when approving annual leave whose minutes exceed one standard day. HTTP 422. Do: split the request so each one stays within one standard day (default 480 minutes).', '出现：批准年假时，分钟数超过一个标准日。HTTP 422。处理：拆成多条申请，每条不超过一个标准日（默认 480 分钟）。'],
      },
      {
        path: ['ANNUAL_LEAVE_ADJUST_DELTA_INVALID', 'ANNUAL_LEAVE_ADJUST_DELTA_INVALID'],
        detail: ['Appears when the adjustment amount is zero. HTTP 400. The sentence is 「调整数值必须非零。」. Do: enter a positive or negative amount.', '出现：调整数值为 0。HTTP 400。句子是「调整数值必须非零。」。处理：填写正数或负数。'],
      },
      {
        path: ['OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED', 'OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED'],
        detail: ['Appears when an overtime window crosses more than one local midnight, or the local start date is not the request work date. Do: keep the window on one local date, or on exactly one midnight that starts on the work date.', '出现：加班时间跨过不止一个当地午夜，或当地开始日不是这条申请的工作日。处理：把时间窗放在同一个当地日，或只跨一个午夜且从该工作日开始。'],
      },
      {
        path: ['OVERTIME_INVALID_TIME_WINDOW', 'OVERTIME_INVALID_TIME_WINDOW'],
        detail: ['Appears when the overtime start and end do not form a valid window. Do: set the end after the start, then submit again.', '出现：加班的开始和结束构不成有效时间窗。处理：让结束晚于开始，再提交。'],
      },
      {
        path: ['OVERTIME_BANK_CAP_EXCEEDED', 'OVERTIME_BANK_CAP_EXCEEDED'],
        detail: ['Appears when an approved overtime would push the comp-time bank over its cycle cap. Do: raise the cap, set the cap to 0 for no limit, or shorten the overtime. Statutory-holiday overtime does not enter this pool.', '出现：批准加班后，调休池会超过本周期上限。处理：提高上限，或把上限设为 0 表示不限，或缩短加班。法定节假日加班不进入这个池。'],
      },
      {
        path: ['SHIFT_SWAP_COUNTERPARTY_CONSENT_REQUIRED', 'SHIFT_SWAP_COUNTERPARTY_CONSENT_REQUIRED'],
        detail: ['Appears when shift swap is finalized before the other person agrees. Do: the other person clicks Agree. Approval continues after that.', '出现：对方尚未同意就终结换班。处理：由对方点「同意换班」。同意之后才继续审批。'],
      },
      {
        path: ['SHIFT_SWAP_APPROVAL_FLOW_REQUIRED', 'SHIFT_SWAP_APPROVAL_FLOW_REQUIRED'],
        detail: ['Appears when the request names a shift-swap approval flow that is missing or inactive. HTTP 422. Do: leave the flow unset so the active shift-swap flow is used, or enable that flow under Approval flows.', '出现：换班指定的审批流不存在或未启用。HTTP 422。处理：不指定流程，改用当前启用的换班审批流；或在「审批流」里启用它。'],
      },
      {
        path: ['APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED', 'APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED'],
        detail: ['Appears when Direct manager, Department head, or a manager level cannot be resolved, or resolves to the requester. HTTP 422. The request is blocked. Do: fix the directory link, or change that step to a named approver. It does not fall back to the administrator queue.', '出现：直属上级、部门主管或指定层级上级解析不到，或解析到申请人本人。HTTP 422。申请被阻断。处理：补目录关系，或把该步改成指定审批人。不会改派到管理员队列。'],
      },
      {
        path: ['SCHEDULER_SCOPE_FORBIDDEN', 'SCHEDULER_SCOPE_FORBIDDEN'],
        detail: ['Appears when a non-administrator acts without a matching scheduler scope. HTTP 403. Do: an administrator adds a scope with the needed action and target, or uses an attendance:admin account.', '出现：非管理员操作，且没有匹配的排班管理范围。HTTP 403。处理：由管理员补一条包含所需动作和目标的范围，或改用 attendance:admin 账号。'],
      },
      {
        path: ['ATTENDANCE_GROUP_TYPE_LOCKED', 'ATTENDANCE_GROUP_TYPE_LOCKED'],
        detail: ['Appears when a save tries to change Fixed shift, Scheduled shift, or Free time after the group exists. HTTP 409. Do: keep the original type. Create another group if a different type is required.', '出现：考勤组已存在后，保存试图修改固定班制、排班制或自由工时。HTTP 409。处理：保持原类型。需要另一种类型时另建一组。'],
      },
      {
        path: ['SHIFT_COMPLIANCE_CAP_EXCEEDED', 'SHIFT_COMPLIANCE_CAP_EXCEEDED'],
        detail: ['Appears when Block on save is set and explicit scheduled minutes exceed a daily, weekly, or monthly cap. HTTP 422. The save rolls back. Do: shorten the schedule, or raise or clear the cap. Warn does not block.', '出现：「保存时阻断」已选，且显式排班分钟超过每日、每周或每月上限。HTTP 422。这次保存会回滚。处理：缩短排班，或提高、清空上限。「预警」不拦截。'],
      },
      {
        path: ['COMMIT_TOKEN_REQUIRED', 'COMMIT_TOKEN_REQUIRED'],
        detail: ['Appears on import commit when ATTENDANCE_IMPORT_REQUIRE_TOKEN is the literal 1 and no token was sent. HTTP 400. Do: issue a token and Commit within 10 minutes.', '出现：ATTENDANCE_IMPORT_REQUIRE_TOKEN 为字面量 1，提交时没有令牌。HTTP 400。处理：签发令牌，并在 10 分钟内点「提交」。'],
      },
      {
        path: ['COMMIT_TOKEN_INVALID', 'COMMIT_TOKEN_INVALID'],
        detail: ['Appears when the import token is expired, already used, or belongs to another user or organization. HTTP 403. Do: issue a new token and Commit again within 10 minutes.', '出现：导入令牌过期、已用过，或属于其他用户或组织。HTTP 403。处理：重新签发，并在 10 分钟内再点「提交」。'],
      },
      {
        path: ['VALIDATION_ERROR', 'VALIDATION_ERROR'],
        detail: ['Appears when a field fails the request check. HTTP 400. The sentence is 「请求校验失败。」 on annual-leave operations. Do: correct the named field and submit again.', '出现：某个字段没通过校验。HTTP 400。年假操作上的句子是「请求校验失败。」。处理：按提示改正该字段后再提交。'],
      },
      {
        path: ['UNAUTHORIZED', 'UNAUTHORIZED'],
        detail: ['Appears when the request has no signed-in user id. HTTP 401. Do: sign in again.', '出现：请求里没有登录用户。HTTP 401。处理：重新登录。'],
      },
      {
        path: ['FORBIDDEN', 'FORBIDDEN'],
        detail: ['Appears when the token’s permission or organization does not allow the action. HTTP 403. Do: see Permissions for the key that action needs. Group owner is not import access.', '出现：令牌上的权限或组织不允许该操作。HTTP 403。处理：到「权限说明」查看该操作需要的权限。考勤组负责人不能代替导入权限。'],
      },
      {
        path: ['DB_NOT_READY', 'DB_NOT_READY'],
        detail: ['Appears when attendance tables are missing in this environment. The sentence is 「本环境的考勤表尚未就绪。」. Do: an administrator finishes migration before retrying. Refreshing the page does not create the tables.', '出现：本环境缺少考勤表。句子是「本环境的考勤表尚未就绪。」。处理：由管理员完成迁移后再试。刷新页面不会建表。'],
      },
      {
        path: ['ATTENDANCE_TIMEZONE_DEFAULT_REQUIRED', 'ATTENDANCE_TIMEZONE_DEFAULT_REQUIRED'],
        detail: ['Appears when the organization has no default attendance rule. The sentence asks an administrator to check the default rule and upgrade prerequisites. Do: open Default rule and save a timezone, work start, and work end. Refresh alone does not create the rule.', '出现：本组织没有默认考勤规则。句子会请管理员检查默认规则和升级前置条件。处理：打开「默认规则」，保存时区、上班时间和下班时间。只刷新不会建出规则。'],
      },
      {
        path: ['ATTENDANCE_TIMEZONE_DEFAULT_MISSING', 'ATTENDANCE_TIMEZONE_DEFAULT_MISSING'],
        detail: ['Appears when a missing default rule cannot be created because existing attendance data still needs an upgrade check. Do: an administrator reviews the upgrade prerequisites. Do not expect Save rule to skip that check.', '出现：已有考勤数据还要升级检查，因此暂时不能补建默认规则。处理：由管理员核对升级前置条件。不要指望「保存规则」跳过这项检查。'],
      },
      {
        path: ['ATTENDANCE_TIMEZONE_FROZEN_CONTEXT_MIGRATION_REQUIRED', 'ATTENDANCE_TIMEZONE_FROZEN_CONTEXT_MIGRATION_REQUIRED'],
        detail: ['Appears when a historical attendance row lacks the required frozen context. Do: an administrator reviews the historical upgrade. Refresh does not fill that context.', '出现：某条历史考勤记录缺少所需的冻结上下文。处理：由管理员处理历史数据升级。刷新不会补上这段上下文。'],
      },
      {
        path: ['ATTENDANCE_TIMEZONE_INVALID_ZONE', 'ATTENDANCE_TIMEZONE_INVALID_ZONE'],
        detail: ['Appears when an attendance timezone is not valid. Do: an administrator re-picks a timezone suggestion on the rule, shift, or policy, then saves. Then refresh.', '出现：某个考勤时区无效。处理：由管理员在规则、班次或策略的时区框重选一条建议并保存，然后再刷新。'],
      },
      {
        path: ['ATTENDANCE_TIMEZONE_MULTIPLE_DEFAULTS', 'ATTENDANCE_TIMEZONE_MULTIPLE_DEFAULTS'],
        detail: ['Appears when more than one default attendance rule conflicts. Do: an administrator resolves the duplicate defaults, then refresh.', '出现：存在互相冲突的多条默认考勤规则。处理：由管理员处理重复的默认规则，然后再刷新。'],
      },
      {
        path: ['ATTENDANCE_TIMEZONE_MEMBER_REQUIRED', 'ATTENDANCE_TIMEZONE_MEMBER_REQUIRED'],
        detail: ['Appears when an active organization membership is required. Do: an administrator checks the membership. The person signs in again.', '出现：操作需要有效的组织成员关系。处理：由管理员检查组织归属。当事人重新登录。'],
      },
    ],
    figureTitle: ['How to read a row', '一行怎么读'],
    figureRows: [
      ['Code', '代码'],
      ['When it appears', '出现时机'],
      ['What to do', '处理'],
    ],
    faqs: [{
      q: ['The code is not in this list.', '这里没有这个代码。'],
      a: ['Use the sentence on the status line. These rows are the codes the attendance screens return for punch, requests, annual leave, schedule saves, import commit, and timezone checks.', '先看状态条上的那句话。这里列出的是打卡、申请、年假、排班保存、导入提交和时区检查会返回的代码。'],
    }],
  },
  {
    id: 'faq',
    labelEn: 'Common questions',
    labelZh: '常见问题',
    intro: [[
      'This page points at the article that already answers the question. Open Attendance help on the admin bar. The employee overview has no separate help.',
      '本页只指向已经写过答案的文章。从管理端顶栏打开「考勤帮助」。员工总览没有另一本帮助。',
    ]],
    scenarios: [[
      'Use it to find the article, then read the steps there.',
      '先在这里找到文章，再去那一篇看步骤。',
    ]],
    steps: [
      {
        path: ['Where this manual opens', '本手册从哪里打开'],
        detail: ['Admin bar → Attendance help. Employee punch, leave, overtime, makeup, and shift swap are articles in that same manual. They describe the overview. They are not a second app.', '管理端顶栏 →「考勤帮助」。打卡、请假、加班、补卡、换班都是这一本里的文章。它们描述总览上的操作，不是另一个应用。'],
      },
      {
        path: ['My requests', '我的申请'],
        detail: ['See Overview. That article states whose requests the card lists.', '见「总览」。那一篇写明这张卡片列出的是谁的申请。'],
      },
      {
        path: ['After Save settings', '保存设置之后'],
        detail: ['See Settings → After saving → what to check. Auto absence waits for Run at.', '见「设置」里的「做完后怎么确认」。自动缺勤要等到执行时间。'],
      },
      {
        path: ['Holiday sync', '节假日同步'],
        detail: ['See Holidays → After sync → what to check. Sync writes holiday rows.', '见「节假日」里的「做完后怎么确认」。同步写入的是节假日记录。'],
      },
      {
        path: ['Import and reports', '导入和报表'],
        detail: ['See Import → After commit → what to check, and Reports → After export → what to check.', '见「导入」里的「做完后怎么确认」，以及「报表」里的「做完后怎么确认」。'],
      },
      {
        path: ['A status code', '某个代码'],
        detail: ['See Status codes. Each row is the code, when it appears, and what to do.', '见「错误码与提示」。每一行是代码、出现时机和处理。'],
      },
    ],
    faqs: [{
      q: ['Saving the makeup policy did not fill in old missing punches.', '保存补卡策略后，以前的缺卡没有被补上。'],
      a: ['The policy limits later requests. It does not scan old days. The employee submits Makeup punch for a date the policy allows.', '策略约束之后的申请。它不回扫旧日期。员工对策略允许的日期提交补卡。'],
    }],
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
  if (sectionId === 'attendance-admin-batch-provisioning') return 'permissions'
  if (sectionId === 'attendance-admin-setup') return 'quickstart'
  if (
    sectionId === 'attendance-admin-rotation-rules'
    || sectionId === 'attendance-admin-rotation-assignments'
    || sectionId === 'attendance-admin-advanced-scheduling-workbench'
    || sectionId === 'attendance-admin-comprehensive-hours-preview'
  ) return 'assignments'
  return 'overview'
}
